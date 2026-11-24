import { randomUUID } from 'node:crypto';
import type { Agent } from '../../domain/types.js';
import { imageRepository } from '../../domain/imageRepository.js';
import { OPS_AGENT_ICON, OPS_AGENT_NAME, OPS_AGENT_PERSONA, OPS_AGENTS_MD, OPS_DIGEST_MESSAGE, OPS_SOUL, OPS_SUGGEST_MESSAGE } from '../../ops/opsAgent.js';
import { checkOpsDrift } from '../../ops/opsDrift.js';
import { createOpsNotifier, type OpsNotifier } from '../../ops/notify.js';
import { loopbackDoorman } from '../../ops/opsServer.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { isBusy } from '../lifecycle/busy.js';
import { createAgentRecord, slugify } from '../lifecycle/provision.js';

/** The manager's jail reaches only internet AI services, so it cannot run on a local model. */
export const OPS_NO_LOCAL = "The Hatchabot agent can't use a local model: its locked-down network reaches only the internet AI services. Pick a Claude, OpenAI or Gemini source.";

/** The manager as a turn needs it. */
export interface OpsTurnAgent { id: string; slug: string; hostId: string; runtimeRef?: string }

/**
 * Why the manager could not be made, in the words the owner reads: `invalid`
 * is answered 400, `conflict` 409.
 */
export interface OpsRefusal { refusal: 'invalid' | 'conflict'; error: string }

/** "Help me decide what agents to add", as it went. */
export type SuggestOutcome =
  | { kind: 'none' }
  | { kind: 'not-running'; state: string }
  | { kind: 'failed'; why: string }
  | { kind: 'asked'; agentId: string; slug: string };

/**
 * The Hatchabot agent service (HB-0808):
 * the account's management agent (docs/ops-agent-design.md) as Hatchabot
 * makes it, reaches it and keeps it in step.
 *
 *  - `create`: the manager made, once per account, on this machine, in its
 *    network jail, pinned to the image it was born on;
 *  - `opsAgentOf`, `runTurn` and `notifier`: one turn in its own
 *    conversation, and the notes Hatchabot posts there (src/ops/notify.ts);
 *  - `suggest`: "Help me decide what agents to add";
 *  - `peerOk`: who may use the management agents' door (their doormen'
 *    addresses, re-read on a miss);
 *  - `setOperatorProfile`: the operator's "about you", pushed into their
 *    running agents one owner at a time.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.hatchabotAgent`). The
 * registry calls it too: the door (registerMgmtChat) asks `peerOk`, and a
 * build, a confirmed card and an adopt post through `notifier`. Nothing here
 * knows about HTTP: who is asking and the reply's words are the route file's
 * (src/api/opsAgentRoutes.ts). `stop()` ends the lockdown check's timer.
 */
export interface HatchabotAgent {
  /** The owner's management agent, if they have one. */
  opsAgentOf(ownerId: string): Agent | undefined;
  /** Hand the management agent one turn, in its own conversation. */
  runTurn(agent: OpsTurnAgent, message: string): Promise<{ ok: boolean; error: string }>;
  /** Notes to it, in its own conversation: the outcome of a change it filed, the end of a long build. */
  notifier: OpsNotifier;
  /** May a connection from this address use the management agents' door? */
  peerOk(ip: string): Promise<boolean>;
  /** Hand it the opener of "what agents should I add?" (after its owner is known). */
  suggest(ownerId: string): Promise<SuggestOutcome>;
  /**
   * Make the account's manager, after the route's own checks (one request at
   * a time, none yet, the agent cap). `wanted`: the AI source asked for.
   */
  create(ownerId: string, wanted: string | null | undefined): Promise<OpsRefusal | { agent: Agent }>;
  /** Save the operator's profile and push it into their running agents that are free; how many it pushes to. */
  setOperatorProfile(ownerId: string, content: string): { pushing: number };
  /** End the lockdown check's timer: at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface HatchabotAgentDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline (with no id: `detail.agentId`'s). */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The agent list's cached read of an agent's sessions, forgotten around a turn (routes.ts's `sessionsCache`). */
  forgetSessions: (agentId: string) => void;
  /** Open the management agents' door (src/ops/opsServer.ts `ensureOpsServer`). Throws with a `userMessage` when it cannot. */
  openDoor: () => Promise<unknown>;
  /** A runtime with no network jail may still host the manager (tests, and `allowUnjailedOps`). */
  unjailedOk: () => boolean;
  /** The fleet's default runtime image, which the manager is pinned to as it is born. */
  defaultBase: string;
  /** A docker image tag, with its repository, that a pin may name. */
  imageTagOk: (tag: string) => boolean;
  /** Start a new agent's setup in the background. */
  kickProvision: (agentId: string) => void;
  /** The AGENTS.md sync under the agent's busy flag (routes.ts's `syncDocsHeld`). Never rejects. */
  syncDocsHeld: (agent: Agent) => Promise<void>;
  log: {
    info: (detail: Record<string, unknown>, msg: string) => void;
    warn: (detail: Record<string, unknown>, msg: string) => void;
  };
  /** How often the manager's tool lockdown is checked (`checkOpsDrift`): 0, never (tests). */
  driftEveryMs: number;
}

export function createHatchabotAgent(deps: HatchabotAgentDeps): HatchabotAgent {
  const { store, providerFor, trace } = deps;
  const operatorFanout = new Map<string, Promise<void>>(); // per-owner chain for the operator-profile push

  /**
   * Who may use the management agents' door: their own doormen, nobody else.
   * Every legitimate connection arrives from one of those containers, so an
   * ordinary agent on this machine is turned away before its key is looked at
   * (docs/ops-agent-design.md). Addresses change when a doorman is replaced,
   * so they are re-read on a miss, at most once every few seconds.
   */
  let doormen = { at: 0, ips: new Set<string>(), supported: false };
  let doormenRefreshing: Promise<void> | undefined;
  let doormenLastLook = 0;
  const refreshDoormen = (): Promise<void> => (doormenRefreshing ??= (async () => {
    const ips = new Set<string>();
    let supported = false;
    for (const a of store.listOpsAgents()) {
      // Call it ON the provider: detaching the method loses `this`, and the
      // lookup then throws into the catch below — every doorman looked
      // unknown and the agent lost its AI (2026-09-19).
      const provider = providerFor(a.hostId);
      if (!provider.doormanAddresses) continue;
      supported = true;
      const found = await provider.doormanAddresses(a.id).catch((err: unknown) => {
        deps.log.warn({ agentId: a.id, err: String(err) }, 'ops.doorman_lookup_failed');
        return [] as string[];
      });
      for (const ip of found) ips.add(ip);
    }
    doormen = { at: Date.now(), ips, supported };
  })().finally(() => { doormenRefreshing = undefined; }));

  const DOORMEN_FRESH_MS = 15_000;  // a known address is re-checked this often
  const DOORMEN_LOOK_MS = 1_000;    // an unknown one triggers at most one look per second
  const opsPeerOk = async (ip: string): Promise<boolean> => {
    if (!ip) return false;
    if (doormen.ips.has(ip)) {
      // Allow it, but keep the list honest: a doorman that is gone must not
      // keep an address that docker could hand to some other container.
      if (Date.now() - doormen.at > DOORMEN_FRESH_MS) void refreshDoormen().catch((err) => deps.log.warn({ err: String(err) }, 'ops.doorman_refresh_failed')); // an agent on a removed host throws (HB-0374)
      return true;
    }
    // Unknown: a rebuild replaces the doorman and it comes back with a new
    // address, so look again before turning it away (this refused a management
    // agent its AI for half a minute, 2026-09-19).
    if (Date.now() - doormenLastLook > DOORMEN_LOOK_MS) {
      doormenLastLook = Date.now();
      await refreshDoormen();
      if (doormen.ips.has(ip)) return true;
    }
    // Docker Desktop: the door is on loopback and the doorman's connection
    // arrives from the VM's forwarder, so no container address can ever match.
    // The key still authorises; this only decides who may present one.
    if (loopbackDoorman(ip)) return true;
    // A runtime with no doormen at all (the mock in tests) keeps the old behaviour.
    return !doormen.supported;
  };

  /**
   * Notes to the owner's management agent, in its own conversation: the
   * outcome of a change it filed, and the end of a build that ran for minutes.
   * Best-effort — the home screen carries the outcome regardless.
   */
  const opsAgentOf = (ownerId: string) => store.listAllActiveAgents().find((a) => a.ownerId === ownerId && a.ops);
  /** Hand the management agent one turn, in its own conversation. */
  const runOpsTurn = async (agent: OpsTurnAgent, message: string) => {
    if (isBusy(agent.id)) return { ok: false, error: 'busy' };
    // It lands in the agent's main conversation, so the console shows it — and
    // it stays unread, which is the point: it is for the owner to read.
    deps.forgetSessions(agent.id);
    const res = await providerFor(agent.hostId).exec(
      agent.runtimeRef!, ['agent', '--agent', agent.slug, '-m', message], { timeoutMs: 180_000 },
    );
    deps.forgetSessions(agent.id);
    return { ok: res.code === 0 && !res.timedOut, error: (res.stderr || res.stdout || '').slice(0, 200) };
  };
  const opsNotifier = createOpsNotifier({
    opsAgent: opsAgentOf,
    runTurn: runOpsTurn,
    log: (event, detail) => deps.log.info(detail, event),
  });

  /**
   * "Help me decide what agents to add." Hands the management agent the opener
   * and returns; it asks its questions (or reads the fleet and names the gaps)
   * in its own console, and files what the owner wants as ordinary cards.
   * Naming what to delegate is the hardest part of starting, and it is the one
   * question an agent that can see the whole fleet is actually equipped for.
   */
  const suggest = async (ownerId: string): Promise<SuggestOutcome> => {
    const ops = opsAgentOf(ownerId);
    if (!ops) return { kind: 'none' };
    if (ops.state !== 'RUNNING' || !ops.runtimeRef) {
      return { kind: 'not-running', state: ops.state };
    }
    const r = await runOpsTurn(ops, OPS_SUGGEST_MESSAGE).catch((err) => ({ ok: false, error: String((err as Error)?.message ?? err) }));
    trace(ops.id)('ops.suggest_asked', { ok: r.ok, ...(r.ok ? {} : { error: String(r.error ?? '').slice(0, 300) }) });
    if (!r.ok) return { kind: 'failed', why: String(r.error ?? '') };
    return { kind: 'asked', agentId: ops.id, slug: ops.slug };
  };

  // The account's management agent (docs/ops-agent-design.md): an OpenClaw
  // agent in a network jail, with locked-down tools and a propose-only key.
  // One per account, on this machine, web-only until a bot is added.
  const create = async (ownerId: string, wanted: string | null | undefined): Promise<OpsRefusal | { agent: Agent }> => {
    const sources = store.listAIProfiles(ownerId);
    // Not a local model: the manager's jail reaches only the internet AI
    // services (through its door), so a local server is unreachable from it
    // and it would never answer (night review, 2026-09-27).
    const reachable = sources.filter((p) => p.vendor !== 'local');
    const profile = wanted ? sources.find((p) => p.id === wanted) : reachable.find((p) => p.defaultSource) ?? reachable[0];
    if (profile?.vendor === 'local') return { refusal: 'invalid', error: OPS_NO_LOCAL };
    if (!profile) return { refusal: 'invalid', error: sources.length ? OPS_NO_LOCAL : 'Add an AI source first (Settings → AI): Claude, OpenAI or Gemini.' };
    const host = store.listHosts(ownerId).find((h) => h.kind === 'local');
    if (!host) return { refusal: 'invalid', error: 'The Hatchabot agent runs on this machine, and no local host is set up.' };
    const provider = providerFor(host.id);
    if (!provider.ensureOpsJail && !deps.unjailedOk()) {
      return { refusal: 'invalid', error: 'This machine’s runtime cannot isolate the agent’s network, so it is not offered here.' };
    }
    // Open the door BEFORE minting an agent, so a machine that cannot run one
    // leaves nothing behind and says why (reported on a laptop, 2026-09-19).
    try {
      await deps.openDoor();
    } catch (err) {
      const why = (err as { userMessage?: string }).userMessage;
      trace()('ops.door_unavailable', { ownerId, error: String((err as Error)?.message ?? err).slice(0, 200) });
      return { refusal: 'conflict', error: why ?? 'Hatchabot could not open the management agent’s door on this machine.' };
    }
    const taken = new Set(store.listAllActiveAgents().filter((a) => a.ownerId === ownerId).map((a) => a.slug));
    const name = [OPS_AGENT_NAME, 'Hatchabot agent', 'Hatchabot manager'].find((n) => !taken.has(slugify(n)));
    if (!name) return { refusal: 'conflict', error: 'Rename your agent called "Hatchabot" first.' };
    const agent = createAgentRecord(store, { ownerId, name, persona: OPS_AGENT_PERSONA, aiProfileId: profile.id, hostId: host.id, ownerOnlyMemory: true });
    store.setAgentWebOnly(agent.id, true);
    store.setAgentOps(agent.id, true);
    // The machine's default budget for new agents may say pause or cheaper: the manager's can only warn.
    { const b = store.getBudget(agent.id); if (b && b.atLimit !== 'warn') store.setBudget(agent.id, b.ownerId, b.usd, 'warn', new Date().toISOString(), b.setBy); }
    store.setAgentIcon(agent.id, OPS_AGENT_ICON, '#e0a13a');
    store.setAgentSeed(agent.id, { 'SOUL.md': OPS_SOUL, 'AGENTS.md': OPS_AGENTS_MD });
    // A morning look at the fleet. Created by Hatchabot (the agent itself has
    // no scheduling tools); an ordinary task the owner can pause or delete.
    store.setPendingSchedules(agent.id, [{
      name: 'Morning fleet check',
      message: OPS_DIGEST_MESSAGE,
      cron: '0 8 * * *',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
    }]);
    // Pinned to the version it was born on: it never follows a promote or a
    // candidate, so a bad OpenClaw upgrade can't take the manager down with it.
    const DEFAULT_BASE = deps.defaultBase;
    try {
      const tags = await provider.listImageTags();
      const latest = tags.find((t) => t.tag === DEFAULT_BASE);
      const pin = latest && tags.find((t) => t.tag !== DEFAULT_BASE && t.imageId === latest.imageId && !t.tag.includes(':derived-'));
      if (pin) store.setAgentImage(agent.id, pin.tag);
      else if (latest) {
        // :latest has no other name on this machine: give today's image one,
        // so the pin keeps pointing at it after a promote moves :latest. In
        // the fleet's repository: cut at the first colon, a registry's port
        // made it "<host>:ops-…", which nothing lists (review of HB-1182).
        const tag = `${imageRepository(DEFAULT_BASE)}:ops-${latest.imageId.replace(/^sha256:/, '').replace(/[^a-f0-9]/gi, '').slice(0, 12)}`;
        if (deps.imageTagOk(tag)) { await provider.tagImage(DEFAULT_BASE, tag); store.setAgentImage(agent.id, tag); }
      }
    } catch { /* unpinned is acceptable; it still works */ }
    trace(agent.id)('ops.created', { aiProfileId: profile.id });
    deps.kickProvision(agent.id);
    return { agent };
  };

  // ---- operator identity profile --------------------------------------------
  const setOperatorProfile = (ownerId: string, content: string): { pushing: number } => {
    // Push the new identity into the operator's RUNNING agents now (rewrites the
    // managed AGENTS.md section live — no rebuild); stopped agents pick it up on
    // their next provision. Best-effort per agent.
    // 2–3 docker execs per running agent — fine on this box, but not something
    // to hold an HTTP request open for across a fleet (one hung container = 60s).
    // Fire the fan-out and return; busy agents are skipped (their rebuild writes
    // the section anyway) so we never interleave with a rebuild's own sync.
    const targets = store.listAgents(ownerId).filter((a) => a.state === 'RUNNING' && a.runtimeRef && !isBusy(a.id));
    // Owed to each of them in the store with the profile (HB-0834): the push
    // is in memory, one agent after another, and a restart part-way left the
    // rest on the old text. The next process syncs each one still owed
    // (routes.ts resumeOperations); each sync here lets its own go.
    const ask = `operator-profile ${randomUUID()}`;
    store.transact(() => {
      store.setOperatorProfile(ownerId, content);
      for (const a of targets) store.setAgentHold(a.id, 'docs-sync', ask);
    });
    // Chain per owner: two saves seconds apart must not race their writes
    // (the later fan-out could otherwise commit the OLDER text on some agents).
    const prev = operatorFanout.get(ownerId) ?? Promise.resolve();
    const run = prev.then(async () => {
      for (const a of targets) {
        // Held busy per agent (HB-0230): one that became busy since waits its turn (routes.ts `syncDocsFor`).
        await deps.syncDocsHeld(a);
      }
    });
    operatorFanout.set(ownerId, run.catch(() => undefined));
    return { pushing: targets.length };
  };

  // The manager's tool lockdown, checked every ten minutes (ops/opsDrift.ts): loosened, its key is suspended.
  const driftTimer = deps.driftEveryMs > 0
    ? setInterval(() => { void checkOpsDrift({ store, providerFor, log: (e, d) => deps.log.warn(d, e) }); }, deps.driftEveryMs).unref()
    : undefined;

  return {
    opsAgentOf,
    runTurn: runOpsTurn,
    notifier: opsNotifier,
    peerOk: opsPeerOk,
    suggest,
    create,
    setOperatorProfile,
    stop: () => { if (driftTimer) clearInterval(driftTimer); },
  };
}
