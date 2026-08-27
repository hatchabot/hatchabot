import { toolDef } from './tools.js';
import { PendingStore, type PendingConfirm, type Resolved } from './pendingStore.js';

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
  model?: string;
  aiProfileId: string;
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
}

export type ErrCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS'
  | 'INVALID_INPUT'
  | 'READ_ONLY_MODE'
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
}

export interface BrokerOptions {
  now?: () => number;
  /** Max mutate proposals per proposer per window. */
  mutateLimit?: number;
  mutateWindowMs?: number;
  audit?: (event: string, detail: Record<string, unknown>) => void;
}

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

  constructor(
    private readonly api: ApiClient,
    readonly pending: PendingStore,
    opts: BrokerOptions = {},
  ) {
    this.#now = opts.now ?? (() => Date.now());
    this.#audit = opts.audit ?? (() => {});
    this.#mutateLimit = opts.mutateLimit ?? 20;
    this.#mutateWindowMs = opts.mutateWindowMs ?? 60_000;
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

      // mutate: gate, resolve, validate, then park a confirmation — never act.
      if (!this.#readWrite) {
        throw new BrokerError('READ_ONLY_MODE', 'Read-only. Send /mode readwrite to arm mutations.');
      }
      this.#rateGate();
      const resolved = await this.#resolveMutate(name, args);
      const summary = summarize(name, resolved);
      const rec = this.pending.create({ ownerId: who.ownerId, chatId: who.chatId, fromUserId: who.fromUserId, tool: name, resolved, summary });
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
    by: { fromUserId: number; chatId: number },
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
      await this.#execMutate(rec.tool, rec.resolved);
      this.#audit('mgmt.confirmed', { tool: rec.tool, confirmId: id, resolved: rec.resolved });
      return { ok: true, done: true, text: `✅ ${rec.summary}`, rec };
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

  async #execRead(name: string, args: Record<string, unknown>): Promise<unknown> {
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
      default:
        throw new BrokerError('FORBIDDEN_TOOL', `Not a read tool: ${name}`);
    }
  }

  /** Build the concrete Resolved for a mutate, validating inputs up front so a
   *  bad model or code fails BEFORE a confirmation is ever shown. */
  async #resolveMutate(name: string, args: Record<string, unknown>): Promise<Resolved> {
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
        if (typeof code !== 'string' || !/^[A-Za-z0-9]{4,12}$/.test(code)) {
          throw new BrokerError('INVALID_INPUT', 'Invalid pairing code.');
        }
        return { ...base, code };
      }
      case 'remove_member': {
        const userId = args.userId;
        if (typeof userId !== 'string' || !userId) throw new BrokerError('INVALID_INPUT', 'Missing userId.');
        return { ...base, userId };
      }
      default:
        throw new BrokerError('FORBIDDEN_TOOL', `Not a mutate tool: ${name}`);
    }
  }

  async #execMutate(name: string, r: Resolved): Promise<void> {
    switch (name) {
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

/** Human-facing confirmation text — the RESOLVED target, never the raw input. */
export function summarize(tool: string, r: Resolved): string {
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
