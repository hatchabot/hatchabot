import { REST_BY_NAME, type RestCtx, type RestTool } from './restTools.js';
import { z } from 'zod';
import { toolDef } from './tools.js';
import { TemplateParamSchema } from '../orchestrator/template.js';
import { derivedNameProblem } from '../orchestrator/derivedImage.js';
import { PendingStore, type AuthorSpec, type PendingConfirm, type Resolved } from './pendingStore.js';

/**
 * The deterministic layer between a management client (slash commands now, an
 * LLM later) and the /v1 API. It holds the owner's token via the ApiClient,
 * exposes only the manifest tools, resolves agent references against the owner's
 * own fleet, executes reads immediately, and turns every mutate into a
 * server-stored confirmation. Nothing here trusts a prompt.
 *
 * See docs/management-broker.md.
 */

export interface AgentSummary {
  id: string;
  name: string;
  slug: string;
  state: string;
  stateReason?: string;
  model?: string;
  aiProfileId: string;
}

export interface ProfileSummary {
  id: string;
  name: string;
  vendor: string;
  model?: string;
}

export interface HostSummary {
  id: string;
  name: string;
  kind: string;
}

export interface Member {
  userId: string;
  displayName?: string;
  role: string;
  channelUserId?: string;
  status: string;
}

export interface PairingRequest {
  code: string;
  meta?: { firstName?: string; lastName?: string; username?: string };
}

/** A pending "wants to join" request, already attributed to its agent — the
 *  flattened shape the notifier polls and the approval push is built from. */
export interface PendingJoin {
  agentId: string;
  agentName: string;
  code: string;
  telegramId?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

export interface EventRow {
  agentId: string;
  agentName?: string;
  at: string;
  event: string;
  detail?: Record<string, unknown>;
}

export interface HealthResult {
  status: 'healthy' | 'degraded' | 'unreachable';
  reachable: boolean;
  telegram?: { connected: boolean; lastError?: string | null };
  eventLoop?: { degraded: boolean; reasons?: string[] };
  pluginErrors?: string[];
}

export interface UsageResult {
  totalTokens: number;
  sessions: number;
  byModel: Array<{ model: string; tokens: number }>;
}

/** The owner-scoped /v1 client the broker drives. Every call already carries the
 *  owner's bearer token, so results are inherently scoped to that account. */
export interface ApiClient {
  listAgents(): Promise<AgentSummary[]>;
  getAgent(id: string): Promise<AgentSummary>;
  getLogs(id: string, lines: number): Promise<string>;
  listMembers(id: string): Promise<Member[]>;
  listPairing(id: string): Promise<PairingRequest[]>;
  listAllPending(): Promise<PendingJoin[]>;
  getPool(): Promise<{ availableBots: number }>;
  listEvents(agentId: string | undefined, limit: number): Promise<EventRow[]>;
  getHealth(id: string): Promise<HealthResult>;
  getUsage(id: string): Promise<UsageResult>;
  availableModels(profileId: string): Promise<string[]>;
  startAgent(id: string): Promise<void>;
  stopAgent(id: string): Promise<void>;
  rebuildAgent(id: string): Promise<void>;
  setModel(id: string, model: string): Promise<void>;
  approvePairing(id: string, code: string): Promise<void>;
  denyPairing(id: string, code: string): Promise<void>;
  removeMember(id: string, userId: string): Promise<void>;
  // authoring
  listProfiles(): Promise<ProfileSummary[]>;
  listHosts(): Promise<HostSummary[]>;
  createAgent(body: { name: string; persona?: string; aiProfileId: string; hostId: string }): Promise<AgentSummary>;
  getFile(id: string, name: string): Promise<string>;
  putFile(id: string, name: string, content: string): Promise<void>;
  patchAgent(id: string, body: { persona?: string; parameters?: Array<Record<string, unknown>> }): Promise<void>;
  // images
  getRuntime(): Promise<{ imageVersion?: string; npmLatest?: string; upgradeAvailable: boolean }>;
  listImages(): Promise<{ base: string; images: ImageSummary[] }>;
  imageLog(name: string): Promise<{ status: string; error?: string; log: string }>;
  buildImage(body: { name: string; dockerfile: string; base?: string }): Promise<void>;
  rebuildImage(name: string, base?: string): Promise<void>;
  removeImage(name: string): Promise<void>;
  // Base-image candidates (optional so older fakes/clients still type-check).
  listBaseImages?(): Promise<import('./apiClient.js').BaseImages>;
  baseBuild?(): Promise<{ running?: boolean; version?: string; candidate?: boolean; ok?: boolean; error?: string; log?: string }>;
  buildBaseCandidate?(version?: string, packages?: string[]): Promise<void>;
  setAgentImage?(id: string, image: string | null): Promise<void>;
  /** Any /v1 call as the owner — used by the one-call tools (restTools.ts). */
  raw?(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface ImageSummary {
  name: string;
  tag: string;
  status: string;
  base: string;
  pinnedBy: number;
  error?: string;
}

export type ErrCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'INVALID_INPUT'
  | 'READ_ONLY_MODE'
  | 'FORBIDDEN_ROLE'
  | 'RATE_LIMITED'
  | 'FORBIDDEN_TOOL'
  | 'UPSTREAM_ERROR';

export type ToolResult =
  | { ok: true; tool: string; data: unknown }
  | { ok: true; tool: string; pending: { confirmId: string; summary: string } }
  | { ok: false; tool: string; error: { code: ErrCode; message: string } };

export interface Proposer {
  ownerId: string;
  chatId: number;
  fromUserId: number;
  /** Caller's authority tier. Viewers may run read tools but never mutates.
   *  Optional for back-compat (undefined = operator — the historical behavior
   *  where every allowlisted user had full authority). */
  role?: 'operator' | 'viewer';
  /** Who prepared this: the built-in chat, or the account's management agent. */
  source?: 'chat' | 'agent';
  /** The agent's own reason, shown on the card clearly labelled as its words. */
  note?: string;
}

export interface BrokerOptions {
  now?: () => number;
  /** Max mutate proposals per proposer per window. */
  mutateLimit?: number;
  mutateWindowMs?: number;
  audit?: (event: string, detail: Record<string, unknown>) => void;
  /** create_agent waits for the fresh agent to reach RUNNING before writing
   *  its files; injectable for tests. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

/** Tools whose confirmation carries a full spec: longer TTL (the owner is
 *  reading a document, not a verb) and a working notice while they execute. */
export const AUTHORING_TOOLS = new Set(['create_agent', 'update_definition', 'build_image']);
const AUTHORING_TTL_MS = 600_000;

class BrokerError extends Error {
  constructor(readonly code: ErrCode, message: string) {
    super(message);
  }
}

export class Broker {
  #readWrite = false;
  #paused = false;
  #now: () => number;
  #audit: (event: string, detail: Record<string, unknown>) => void;
  #mutateLimit: number;
  #mutateWindowMs: number;
  #mutateHits: number[] = [];
  #pollIntervalMs: number;
  #pollTimeoutMs: number;

  constructor(
    private readonly api: ApiClient,
    readonly pending: PendingStore,
    opts: BrokerOptions = {},
  ) {
    this.#now = opts.now ?? (() => Date.now());
    this.#audit = opts.audit ?? (() => {});
    this.#mutateLimit = opts.mutateLimit ?? 20;
    this.#mutateWindowMs = opts.mutateWindowMs ?? 60_000;
    this.#pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.#pollTimeoutMs = opts.pollTimeoutMs ?? 150_000;
  }

  get readWrite(): boolean {
    return this.#readWrite;
  }
  setMode(readWrite: boolean): void {
    this.#readWrite = readWrite;
  }
  pause(): void {
    this.#paused = true;
  }
  resume(): void {
    this.#paused = false;
  }

  /** Propose a tool. Reads execute now; mutates return a pending confirmation. */
  async handleTool(name: string, input: unknown, who: Proposer): Promise<ToolResult> {
    try {
      if (this.#paused) throw new BrokerError('FORBIDDEN_TOOL', 'Management is paused.');
      const def = toolDef(name);
      if (!def) throw new BrokerError('FORBIDDEN_TOOL', `No such tool: ${name}`);
      const args = (input ?? {}) as Record<string, unknown>;

      if (def.tier === 'read') {
        const data = await this.#execRead(name, args);
        this.#audit('mgmt.read', { tool: name, ...who });
        return { ok: true, tool: name, data };
      }

      // mutate: a viewer may never mutate, regardless of the global mode — the
      // per-caller check (not just the shared #readWrite flag) is what stops a
      // viewer's natural-language request from riding an operator's armed mode.
      if (who.role === 'viewer') {
        throw new BrokerError('FORBIDDEN_ROLE', 'Read-only viewer — ask an operator to make changes.');
      }
      // mutate: gate, resolve, validate, then park a confirmation — never act.
      if (!this.#readWrite) {
        throw new BrokerError('READ_ONLY_MODE', 'Read-only. Send /mode readwrite to arm mutations.');
      }
      this.#rateGate();
      const resolved = await this.#resolveMutate(name, args);
      const summary = summarize(name, resolved);
      const rec = this.pending.create(
        { ownerId: who.ownerId, chatId: who.chatId, fromUserId: who.fromUserId, tool: name, resolved, summary,
          source: who.source, note: who.note?.trim().slice(0, 400) || undefined, risk: riskOf(name) },
        AUTHORING_TOOLS.has(name) ? AUTHORING_TTL_MS : undefined,
      );
      this.#audit('mgmt.propose', { tool: name, confirmId: rec.id, resolved, ...who });
      return { ok: true, tool: name, pending: { confirmId: rec.id, summary } };
    } catch (e) {
      if (e instanceof BrokerError) return { ok: false, tool: name, error: { code: e.code, message: e.message } };
      return { ok: false, tool: name, error: { code: 'UPSTREAM_ERROR', message: String((e as Error).message ?? e) } };
    }
  }

  /** Resolve a confirmation button tap: execute the mutate, or cancel. */
  async confirm(
    id: string,
    verb: 'confirm' | 'cancel',
    by: { fromUserId: number; chatId: number; ownerId?: string },
  ): Promise<
    | { ok: true; done: boolean; text: string; rec: PendingConfirm }
    | { ok: false; reason: string }
  > {
    const claim = this.pending.claim(id, verb, by);
    if (!claim.ok) return { ok: false, reason: claim.reason };
    const rec = claim.rec;
    if (verb === 'cancel') {
      this.#audit('mgmt.cancel', { tool: rec.tool, confirmId: id });
      return { ok: true, done: false, text: `✖ Cancelled — ${rec.summary}`, rec };
    }
    try {
      const extra = await this.#execMutate(rec.tool, rec.resolved);
      this.#audit('mgmt.confirmed', { tool: rec.tool, confirmId: id, resolved: rec.resolved });
      return { ok: true, done: true, text: `✅ ${rec.summary}${extra ? `\n${extra}` : ''}`, rec };
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      this.#audit('mgmt.failed', { tool: rec.tool, confirmId: id, error: msg });
      return { ok: true, done: true, text: `⚠ Failed — ${rec.summary}: ${msg}`, rec };
    }
  }

  /**
   * Approve a pending join straight from the notification's one-tap button. The
   * owner tapped "Approve" next to a named person the system surfaced, so this
   * is already a deliberate, per-person, additive action — it doesn't go through
   * the propose→confirm dance or require read-write mode. It still respects
   * /pause and the mutate rate limit. `agentId` is trusted (it came from our own
   * notification payload, not from a prompt).
   */
  async approveJoin(
    agentId: string,
    code: string,
    who: Proposer,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.#join('approve', agentId, code, who);
  }

  /** The other half of the one-tap prompt: turn the request away. Same
   *  reasoning as approveJoin — deliberate, per-person, and reversible (they
   *  can ask again), so it needs no read-write arming. */
  async denyJoin(
    agentId: string,
    code: string,
    who: Proposer,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.#join('deny', agentId, code, who);
  }

  async #join(
    verb: 'approve' | 'deny',
    agentId: string,
    code: string,
    who: Proposer,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (this.#paused) return { ok: false, message: 'Management is paused.' };
    if (who.role === 'viewer') return { ok: false, message: 'Read-only viewer — only an operator can admit or turn away joiners.' };
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) return { ok: false, message: 'Invalid pairing code.' };
    try {
      this.#rateGate();
      if (verb === 'approve') await this.api.approvePairing(agentId, code);
      else await this.api.denyPairing(agentId, code);
      this.#audit(verb === 'approve' ? 'mgmt.join_approved' : 'mgmt.join_denied', { agentId, code, ...who });
      return { ok: true };
    } catch (e) {
      if (e instanceof BrokerError) return { ok: false, message: e.message };
      return { ok: false, message: String((e as Error).message ?? e) };
    }
  }

  // ---- internals ----

  #rateGate(): void {
    const now = this.#now();
    this.#mutateHits = this.#mutateHits.filter((t) => now - t < this.#mutateWindowMs);
    if (this.#mutateHits.length >= this.#mutateLimit) {
      throw new BrokerError('RATE_LIMITED', 'Too many changes in a short window — slow down.');
    }
    this.#mutateHits.push(now);
  }

  /** id → slug → unique name, against the OWNER'S fleet only. */
  async #resolve(ref: unknown): Promise<AgentSummary> {
    if (typeof ref !== 'string' || !ref.trim()) {
      throw new BrokerError('INVALID_INPUT', 'Missing agent reference.');
    }
    const agents = await this.api.listAgents();
    const byId = agents.find((a) => a.id === ref);
    if (byId) return byId;
    const bySlug = agents.find((a) => a.slug === ref);
    if (bySlug) return bySlug;
    const byName = agents.filter((a) => a.name.toLowerCase() === ref.toLowerCase());
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      throw new BrokerError(
        'AMBIGUOUS',
        `${byName.length} agents named "${ref}": ${byName.map((a) => a.id).join(', ')}. Use an id.`,
      );
    }
    // last resort: substring, but never auto-pick more than one
    const fuzzy = agents.filter((a) => a.name.toLowerCase().includes(ref.toLowerCase()));
    if (fuzzy.length === 1) return fuzzy[0]!;
    if (fuzzy.length > 1) {
      throw new BrokerError(
        'AMBIGUOUS',
        `${fuzzy.length} agents match "${ref}": ${fuzzy.map((a) => `${a.name} (${a.id})`).join(', ')}. Say which id.`,
      );
    }
    throw new BrokerError('NOT_FOUND', `No agent matches "${ref}".`);
  }

  /** Context for a one-call tool: its agent resolved, lookups, other refs. */
  async #restCtx(rt: RestTool, args: Record<string, unknown>): Promise<RestCtx> {
    const raw = this.#need(this.api.raw);
    const agent = rt.agentArg ? await this.#resolve(args.agent) : undefined;
    return {
      agent: agent && { id: agent.id, name: agent.name },
      input: { ...args },
      resolve: async (ref) => { const a = await this.#resolve(ref); return { id: a.id, name: a.name }; },
      get: (path) => raw.call(this.api, 'GET', path),
    };
  }

  /** Build a one-call tool's call; its own validation errors go back to the model. */
  async #restCall(rt: RestTool, ctx: RestCtx) {
    try {
      return await rt.call(ctx);
    } catch (e) {
      if (e instanceof BrokerError) throw e;
      throw new BrokerError('INVALID_INPUT', String((e as Error).message ?? e));
    }
  }

  async #execRead(name: string, args: Record<string, unknown>): Promise<unknown> {
    const rt = REST_BY_NAME.get(name);
    if (rt) {
      // A derived image is deleted from its own row, not as a base tag — the
      // route refuses it, which used to happen only after the owner pressed
      // Confirm (2026-09-19). Say so while the card is being written, and name
      // the tool that works. A derived-looking tag with NO row is a leftover
      // image and stays deletable here.
      if (name === 'delete_base_image' && typeof args.tag === 'string' && args.tag.includes(':derived-')) {
        const imgName = args.tag.split(':derived-')[1] ?? '';
        const { images } = await this.api.listImages();
        if (images.some((i) => i.name === imgName)) {
          throw new BrokerError('INVALID_INPUT',
            `"${args.tag}" is a derived image. Use remove_image with name "${imgName}" — that deletes the image AND forgets its Dockerfile.`);
        }
      }
      const ctx = await this.#restCtx(rt, args);
      const c = await this.#restCall(rt, ctx);
      return this.#need(this.api.raw).call(this.api, c.method, c.path, c.body);
    }
    switch (name) {
      case 'list_agents': {
        let list = await this.api.listAgents();
        if (typeof args.state === 'string') list = list.filter((a) => a.state === args.state);
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        return list.slice(0, limit);
      }
      case 'get_agent':
        return this.api.getAgent((await this.#resolve(args.agent)).id);
      case 'get_logs':
        return this.api.getLogs(
          (await this.#resolve(args.agent)).id,
          typeof args.lines === 'number' ? args.lines : 50,
        );
      case 'list_members':
        return this.api.listMembers((await this.#resolve(args.agent)).id);
      case 'list_pending':
        return this.api.listPairing((await this.#resolve(args.agent)).id);
      case 'get_pool':
        return this.api.getPool();
      case 'list_events': {
        const id = args.agent !== undefined ? (await this.#resolve(args.agent)).id : undefined;
        const limit = typeof args.limit === 'number' ? args.limit : 20;
        return this.api.listEvents(id, limit);
      }
      case 'get_health':
        return this.api.getHealth((await this.#resolve(args.agent)).id);
      case 'get_usage':
        return this.api.getUsage((await this.#resolve(args.agent)).id);
      case 'get_runtime':
        return this.api.getRuntime();
      case 'list_images':
        return this.api.listImages();
      case 'list_base_images':
        return this.#need(this.api.listBaseImages).call(this.api);
      case 'get_base_build': {
        const b = await this.#need(this.api.baseBuild).call(this.api);
        return { ...b, log: (b.log ?? '').slice(-3000) };
      }
      case 'get_image_log': {
        if (typeof args.name !== 'string' || !args.name) throw new BrokerError('INVALID_INPUT', 'Missing image name.');
        return this.api.imageLog(args.name);
      }
      default:
        throw new BrokerError('FORBIDDEN_TOOL', `Not a read tool: ${name}`);
    }
  }

  /** Validate + normalize setup-field declarations with the control plane's
   *  REAL schema, so a proposal that would 400 at PATCH time fails before the
   *  owner is ever shown a card. Friendly defaults for the two fields the
   *  schema requires but a model plausibly omits. */
  #normalizeFields(raw: unknown): Array<Record<string, unknown>> | undefined {
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw)) throw new BrokerError('INVALID_INPUT', 'fields must be an array.');
    const filled = raw.map((f) => ({ required: false, target: 'soul', ...(f as object) }));
    const parsed = z.array(TemplateParamSchema).max(24).safeParse(filled);
    if (!parsed.success) {
      throw new BrokerError('INVALID_INPUT', `Bad setup fields: ${parsed.error.issues[0]?.message ?? 'invalid'}.`);
    }
    if (new Set(parsed.data.map((p) => p.key)).size !== parsed.data.length) {
      throw new BrokerError('INVALID_INPUT', 'Setup field keys must be unique.');
    }
    return parsed.data as unknown as Array<Record<string, unknown>>;
  }

  #need<F>(fn: F | undefined): F {
    if (!fn) throw new BrokerError('UPSTREAM_ERROR', 'This server does not support base-image candidates from chat.');
    return fn;
  }

  /** create_agent placement: the LOCAL host and the AI profile most of the
   *  fleet already uses (first profile when the fleet is empty). The model
   *  never chooses placement — the card shows the owner what was picked. */
  async #placement(): Promise<{ hostId: string; aiProfileId: string; aiProfileName: string }> {
    const hosts = await this.api.listHosts();
    const local = hosts.find((h) => h.kind === 'local');
    if (!local) throw new BrokerError('UPSTREAM_ERROR', 'No local host to create the agent on.');
    const profiles = await this.api.listProfiles();
    if (!profiles.length) throw new BrokerError('UPSTREAM_ERROR', 'No AI source configured — add one in the web app first.');
    const agents = await this.api.listAgents();
    const counts = new Map<string, number>();
    for (const a of agents) counts.set(a.aiProfileId, (counts.get(a.aiProfileId) ?? 0) + 1);
    const best = [...profiles].sort(
      (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0),
    )[0]!;
    return { hostId: local.id, aiProfileId: best.id, aiProfileName: best.name };
  }

  /** Build the concrete Resolved for a mutate, validating inputs up front so a
   *  bad model or code fails BEFORE a confirmation is ever shown. */
  async #resolveMutate(name: string, args: Record<string, unknown>): Promise<Resolved> {
    const rt = REST_BY_NAME.get(name);
    if (rt) {
      const ctx = await this.#restCtx(rt, args);
      const call = await this.#restCall(rt, ctx);
      return {
        agentId: ctx.agent?.id ?? '',
        agentName: ctx.agent?.name ?? '',
        rest: { call, card: rt.card ? rt.card(ctx) : `${name.replace(/_/g, ' ')}`, rebuild: rt.rebuildAfter },
      };
    }
    if (name === 'create_agent') {
      const agentName = args.name;
      if (typeof agentName !== 'string' || !agentName.trim() || agentName.length > 64) {
        throw new BrokerError('INVALID_INPUT', 'Missing or bad agent name.');
      }
      const soul = args.soul;
      if (typeof soul !== 'string' || !soul.trim()) throw new BrokerError('INVALID_INPUT', 'SOUL.md content is required.');
      const clash = (await this.api.listAgents()).find(
        (a) => a.name.toLowerCase() === agentName.trim().toLowerCase(),
      );
      if (clash) {
        throw new BrokerError('INVALID_INPUT', `There is already an agent named "${clash.name}" (${clash.state}). Pick another name.`);
      }
      const spec: AuthorSpec = {
        name: agentName.trim(),
        persona: typeof args.persona === 'string' ? args.persona : undefined,
        soul,
        agentsMd: typeof args.agents_md === 'string' ? args.agents_md : undefined,
        fields: this.#normalizeFields(args.fields),
        ...(await this.#placement()),
      };
      return { agentId: '', agentName: spec.name!, spec };
    }
    if (name === 'build_image' || name === 'rebuild_image' || name === 'remove_image') {
      const imgName = args.name;
      if (typeof imgName !== 'string' || !imgName.trim()) throw new BrokerError('INVALID_INPUT', 'Missing image name.');
      const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
      const { images } = await this.api.listImages();
      const existing = images.find((i) => i.name === imgName);
      if (name === 'build_image') {
        if (existing) {
          throw new BrokerError('INVALID_INPUT', `"${imgName}" already exists — use rebuild_image to rebuild it.`);
        }
        // Check the name HERE, not when the owner confirms: a card that cannot
        // execute wastes their Confirm and tells the agent nothing (an image
        // named "2026.7.1-2-ch3" was filed and failed on confirm, 2026-09-19).
        const nameProblem = derivedNameProblem(imgName);
        if (nameProblem) throw new BrokerError('INVALID_INPUT', `"${imgName}": ${nameProblem}`);
        const dockerfile = args.dockerfile;
        if (typeof dockerfile !== 'string' || !dockerfile.trim()) {
          throw new BrokerError('INVALID_INPUT', 'Missing Dockerfile lines.');
        }
        return { agentId: '', agentName: imgName, spec: { name: imgName, dockerfile, base } };
      }
      if (!existing) {
        throw new BrokerError('NOT_FOUND', `No derived image named "${imgName}" — list_images shows what exists.`);
      }
      if (name === 'remove_image' && existing.pinnedBy > 0) {
        throw new BrokerError(
          'INVALID_INPUT',
          `"${imgName}" is pinned by ${existing.pinnedBy} agent(s) — unpin them (Settings → Environment) first.`,
        );
      }
      return { agentId: '', agentName: imgName, spec: { name: imgName, base } };
    }
    if (name === 'build_base_candidate') {
      const rt = await this.api.getRuntime();
      const version = typeof args.version === 'string' && args.version.trim() ? args.version.trim() : rt.npmLatest;
      if (!version || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version) || version === 'latest' || version.startsWith('derived-')) {
        throw new BrokerError('INVALID_INPUT', 'Give a specific OpenClaw version, e.g. 2026.9.1.');
      }
      const running = await this.#need(this.api.baseBuild).call(this.api);
      if (running.running) throw new BrokerError('INVALID_INPUT', 'A base-image build is already running — check get_base_build.');
      const raw = Array.isArray(args.packages) ? args.packages : [];
      const packages = raw.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
      const badPkg = packages.find((x) => !/^[a-z0-9][a-z0-9+.-]{0,63}$/.test(x));
      if (badPkg) throw new BrokerError('INVALID_INPUT', `"${badPkg.slice(0, 40)}" is not a package name.`);
      if (packages.length > 8) throw new BrokerError('INVALID_INPUT', 'Eight extra packages at most — a base image is shared by every agent.');
      return { agentId: '', agentName: version, spec: { version, current: rt.imageVersion, packages } };
    }
    if (name === 'try_base_candidate' || name === 'end_base_trial') {
      const agent = await this.#resolve(args.agent);
      const imgs = await this.#need(this.api.listBaseImages).call(this.api);
      if (name === 'end_base_trial') {
        const onCandidate = imgs.tags.find((t) => t.pinned.some((p) => p.id === agent.id) && !t.derived && !t.isDefault);
        if (!onCandidate) throw new BrokerError('INVALID_INPUT', `"${agent.name}" isn't trying a candidate image.`);
        return { agentId: agent.id, agentName: agent.name, spec: { tag: onCandidate.tag } };
      }
      const tag = typeof args.tag === 'string' ? args.tag.trim() : '';
      const t = imgs.tags.find((x) => x.tag === tag);
      // Only a real, built, non-default base candidate: never :latest, never a
      // derived image (those carry packages), never something not on disk.
      if (!t || !t.exists) throw new BrokerError('NOT_FOUND', `No built image "${tag}" — list_base_images shows what exists.`);
      if (t.isDefault || t.isLatest) throw new BrokerError('INVALID_INPUT', `${tag} is already the fleet default — nothing to try.`);
      if (t.derived) throw new BrokerError('INVALID_INPUT', `${tag} is a derived image, not a base candidate.`);
      return { agentId: agent.id, agentName: agent.name, spec: { tag, version: t.openclawVersion, current: imgs.defaultInfo?.openclawVersion } };
    }
    const agent = await this.#resolve(args.agent);
    const base: Resolved = { agentId: agent.id, agentName: agent.name };
    switch (name) {
      case 'start_agent':
      case 'stop_agent':
      case 'rebuild_agent':
        return base;
      case 'set_model': {
        const model = args.model;
        if (typeof model !== 'string' || !model) throw new BrokerError('INVALID_INPUT', 'Missing model.');
        const allowed = await this.api.availableModels(agent.aiProfileId);
        if (!allowed.includes(model)) {
          throw new BrokerError(
            'INVALID_INPUT',
            `"${model}" isn't offered by this agent's source. Options: ${allowed.join(', ') || '(none)'}.`,
          );
        }
        return { ...base, model };
      }
      case 'approve_member': {
        const code = args.code;
        if (typeof code !== 'string' || !/^[A-Za-z0-9]{4,16}$/.test(code)) {
          throw new BrokerError('INVALID_INPUT', 'Invalid pairing code.');
        }
        return { ...base, code };
      }
      case 'remove_member': {
        const userId = args.userId;
        if (typeof userId !== 'string' || !userId) throw new BrokerError('INVALID_INPUT', 'Missing userId.');
        return { ...base, userId };
      }
      case 'update_definition': {
        const soul = typeof args.soul === 'string' ? args.soul : undefined;
        const agentsMd = typeof args.agents_md === 'string' ? args.agents_md : undefined;
        // An empty replacement zero-bytes a live file — mirror create_agent's
        // refusal instead of trusting the schema's advisory minLength.
        if (soul !== undefined && !soul.trim()) throw new BrokerError('INVALID_INPUT', 'soul must not be empty.');
        if (agentsMd !== undefined && !agentsMd.trim()) throw new BrokerError('INVALID_INPUT', 'agents_md must not be empty.');
        const persona = typeof args.persona === 'string' ? args.persona : undefined;
        const fields = this.#normalizeFields(args.fields);
        if (soul === undefined && agentsMd === undefined && persona === undefined && fields === undefined) {
          throw new BrokerError('INVALID_INPUT', 'Nothing to change — give soul, agents_md, persona, or fields.');
        }
        // Diff stats against what's live NOW, so the card says how big the
        // change is, not just that there is one. Best-effort: a stopped agent
        // can't serve its files, and the write itself will fail loudly later.
        const diffs: string[] = [];
        for (const [label, next] of [['SOUL.md', soul], ['AGENTS.md', agentsMd]] as const) {
          if (next === undefined) continue;
          try {
            const cur = await this.api.getFile(agent.id, label);
            diffs.push(`${label}: ${diffStat(cur, next)}`);
          } catch {
            diffs.push(`${label}: ${next.split('\n').length} lines (current unavailable)`);
          }
        }
        return { ...base, spec: { soul, agentsMd, persona, fields, diff: diffs.join(' · ') || undefined } };
      }
      default:
        throw new BrokerError('FORBIDDEN_TOOL', `Not a mutate tool: ${name}`);
    }
  }

  async #execMutate(name: string, r: Resolved): Promise<string | void> {
    if (r.rest) {
      const out = await this.#need(this.api.raw).call(this.api, r.rest.call.method, r.rest.call.path, r.rest.call.body);
      if (r.rest.rebuild && r.agentId) await this.api.rebuildAgent(r.agentId);
      return REST_BY_NAME.get(name)?.done?.(out);
    }
    switch (name) {
      case 'build_image':
        return this.api.buildImage({ name: r.spec!.name!, dockerfile: r.spec!.dockerfile!, base: r.spec!.base });
      case 'rebuild_image':
        return this.api.rebuildImage(r.spec!.name!, r.spec!.base);
      case 'remove_image':
        return this.api.removeImage(r.spec!.name!);
      case 'build_base_candidate':
        return this.#need(this.api.buildBaseCandidate).call(this.api, r.spec!.version, r.spec!.packages);
      case 'try_base_candidate':
        await this.#need(this.api.setAgentImage).call(this.api, r.agentId, r.spec!.tag!);
        return this.api.rebuildAgent(r.agentId);
      case 'end_base_trial':
        await this.#need(this.api.setAgentImage).call(this.api, r.agentId, null);
        return this.api.rebuildAgent(r.agentId);
      case 'create_agent': {
        const s = r.spec!;
        const created = await this.api.createAgent({
          name: s.name!,
          persona: s.persona,
          aiProfileId: s.aiProfileId!,
          hostId: s.hostId!,
        });
        // Files land on the agent's volume, which exists only once the agent
        // is RUNNING — wait for provisioning (bot from the pool, container up).
        const deadline = this.#now() + this.#pollTimeoutMs;
        let cur = created;
        while (cur.state !== 'RUNNING') {
          if (cur.state === 'FAILED') {
            throw new Error(`created, but provisioning failed${cur.stateReason ? `: ${cur.stateReason}` : ''} — fix it in the web app, then propose update_definition`);
          }
          if (this.#now() > deadline) {
            throw new Error('created, but still provisioning — once it is RUNNING, propose update_definition to apply the definition');
          }
          await new Promise((res) => setTimeout(res, this.#pollIntervalMs));
          cur = await this.api.getAgent(created.id);
        }
        await this.api.putFile(created.id, 'SOUL.md', s.soul!);
        if (s.agentsMd !== undefined) await this.api.putFile(created.id, 'AGENTS.md', s.agentsMd);
        if (s.fields?.length) await this.api.patchAgent(created.id, { parameters: s.fields });
        return;
      }
      case 'update_definition': {
        const s = r.spec!;
        // File writes first (each takes its own pre-edit snapshot server-side).
        if (s.soul !== undefined) await this.api.putFile(r.agentId, 'SOUL.md', s.soul);
        if (s.agentsMd !== undefined) await this.api.putFile(r.agentId, 'AGENTS.md', s.agentsMd);
        const patch: { persona?: string; parameters?: Array<Record<string, unknown>> } = {};
        if (s.persona !== undefined) patch.persona = s.persona;
        if (s.fields !== undefined) patch.parameters = s.fields;
        if (Object.keys(patch).length) await this.api.patchAgent(r.agentId, patch);
        return;
      }
      case 'start_agent':
        return this.api.startAgent(r.agentId);
      case 'stop_agent':
        return this.api.stopAgent(r.agentId);
      case 'rebuild_agent':
        return this.api.rebuildAgent(r.agentId);
      case 'set_model':
        return this.api.setModel(r.agentId, r.model!);
      case 'approve_member':
        return this.api.approvePairing(r.agentId, r.code!);
      case 'remove_member':
        return this.api.removeMember(r.agentId, r.userId!);
      default:
        throw new BrokerError('FORBIDDEN_TOOL', `Not a mutate tool: ${name}`);
    }
  }
}

/** Approximate line-diff size: "120 → 180 lines (~64 changed)". Set-based, so
 *  it understates moves — good enough for a card whose full content the owner
 *  can read below it. */
export function diffStat(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const aSet = new Set(a);
  const bSet = new Set(b);
  const changed = Math.max(
    a.filter((l) => !bSet.has(l)).length,
    b.filter((l) => !aSet.has(l)).length,
  );
  return `${a.length} → ${b.length} lines (~${changed} changed)`;
}

const previewOf = (label: string, text: string, maxChars: number): string => {
  const all = text.split('\n');
  const lines = all.slice(0, 14).join('\n');
  const clipped = lines.length > maxChars ? lines.slice(0, maxChars) + '…' : lines;
  // Never let a clipped preview read as complete — the model can be steered
  // by injected text, and hostile content below the fold is exactly what a
  // reviewer must know exists. The bot also sends the FULL content as
  // separate messages before the card (see ManagementBot.#postCard).
  const hidden = clipped.length < text.length ? `\n⋯ +${Math.max(all.length - 14, 1)} more line(s) NOT shown here` : '';
  return `――― ${label} ―――\n${clipped}${hidden}`;
};

/** Human-facing confirmation text — the RESOLVED target, never the raw input.
 *  Authoring proposals are multi-line: the card IS the review surface. */
export function summarize(tool: string, r: Resolved): string {
  if (r.rest) return r.rest.card;
  if (tool === 'build_image') {
    const s = r.spec!;
    return [
      `🧱 Build derived image "${r.agentName}"${s.base ? ` FROM ${s.base}` : ' (fleet base)'}`,
      previewOf('Dockerfile lines', s.dockerfile ?? '', 700),
    ].join('\n');
  }
  if (tool === 'rebuild_image') {
    return `🧱 Rebuild image "${r.agentName}"${r.spec?.base ? ` onto ${r.spec.base}` : ' (same base)'}`;
  }
  if (tool === 'remove_image') {
    return `🗑 Delete derived image "${r.agentName}"`;
  }
  if (tool === 'build_base_candidate') {
    return `🧪 Build a base-image CANDIDATE for OpenClaw ${r.spec?.version}` +
      (r.spec?.packages?.length ? `, with ${r.spec.packages.join(', ')} added` : '') +
      `\nThe fleet keeps running ${r.spec?.current ? `OpenClaw ${r.spec.current}` : 'its current image'}. Nothing changes for any agent until you try the candidate on one agent, and then press Promote in the web app (Settings → Machines → Runtime image).`;
  }
  if (tool === 'try_base_candidate') {
    return `🧪 Try ${r.spec?.tag}${r.spec?.version ? ` (OpenClaw ${r.spec.version})` : ''} on "${r.agentName}"` +
      `\nPins this one agent to the candidate and rebuilds it (memory kept; briefly offline). Every other agent stays on ${r.spec?.current ? `OpenClaw ${r.spec.current}` : 'the fleet default'}. Undo with end_base_trial.`;
  }
  if (tool === 'end_base_trial') {
    return `↩ End the trial on "${r.agentName}": unpin it from ${r.spec?.tag} and rebuild it onto the fleet default (memory kept).`;
  }
  if (tool === 'create_agent' || tool === 'update_definition') {
    const s = r.spec!;
    const head =
      tool === 'create_agent'
        ? `🧬 Create agent "${r.agentName}"\nAI: ${s.aiProfileName} · host: this machine`
        : `✏️ Update definition of "${r.agentName}"`;
    const parts: string[] = [head];
    if (s.persona !== undefined) parts.push(`persona: ${s.persona.slice(0, 200)}`);
    if (tool === 'create_agent') {
      const files = [`SOUL.md ${s.soul!.split('\n').length} lines`];
      if (s.agentsMd !== undefined) files.push(`AGENTS.md ${s.agentsMd.split('\n').length} lines`);
      parts.push(files.join(' · '));
    } else if (s.diff) {
      parts.push(s.diff);
    }
    if (s.fields?.length) {
      parts.push(`Setup fields (${s.fields.length}): ${s.fields.map((f) => String(f.key)).join(', ')}`);
    }
    if (s.soul !== undefined) parts.push(previewOf('SOUL.md', s.soul, 900));
    else if (s.agentsMd !== undefined) parts.push(previewOf('AGENTS.md', s.agentsMd, 900));
    const text = parts.join('\n');
    return text.length > 2000 ? text.slice(0, 2000) + '…' : text;
  }
  switch (tool) {
    case 'start_agent':
      return `▶ Start "${r.agentName}"`;
    case 'stop_agent':
      return `⏹ Stop "${r.agentName}"`;
    case 'rebuild_agent':
      return `🔄 Rebuild "${r.agentName}" (memory kept)`;
    case 'set_model':
      return `Set "${r.agentName}" model → ${r.model}`;
    case 'approve_member':
      return `✅ Admit pairing code ${r.code} to "${r.agentName}"`;
    case 'remove_member':
      return `Remove member ${r.userId} from "${r.agentName}"`;
    default:
      return `${tool} on "${r.agentName}"`;
  }
}

/**
 * How much care a change deserves, shown on its card.
 *  - routine: easily undone, nothing restarts.
 *  - disruptive: restarts or takes an agent offline, or changes who it talks to.
 *  - careful: builds images, changes what an agent can do or whom it can
 *    direct, or rewrites its definition.
 */
export type Risk = 'routine' | 'disruptive' | 'careful';
const CAREFUL = new Set(['build_image', 'rebuild_image', 'remove_image', 'build_base_candidate', 'try_base_candidate', 'delete_base_image',
  'pin_image', 'set_peers', 'update_definition', 'create_agent', 'restore_snapshot', 'remove_member', 'approve_member']);
const DISRUPTIVE = new Set(['stop_agent', 'rebuild_agent', 'set_source', 'set_model', 'set_class', 'archive_agent', 'restore_agent',
  'remove_telegram', 'add_telegram', 'remove_channel', 'end_base_trial', 'clone_agent', 'remove_cron', 'add_cron']);
export function riskOf(tool: string): Risk {
  return CAREFUL.has(tool) ? 'careful' : DISRUPTIVE.has(tool) ? 'disruptive' : 'routine';
}
