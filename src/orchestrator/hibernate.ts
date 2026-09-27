/**
 * Hibernation: an idle agent is stopped (volume kept) and started again when
 * something wants it — a Telegram message, its owner opening its console or
 * asking it, a start. An OpenClaw gateway holds ~1.2 GiB resident whether it
 * is talking or not (measured 2026-09-26), so on a shared host this is the
 * difference between twenty tenants and several times that.
 *
 * What may sleep: a RUNNING agent on this machine, not busy, that has been
 * quiet for HATCHABOT_HIBERNATE_AFTER (off when unset), with nothing that
 * would fire while it is down — no Discord or Slack (nothing queues their
 * messages: a sleeping agent would miss them) and no scheduled task of its
 * own. Telegram queues updates for 24 hours and hands them to the gateway
 * when it comes back, so a Telegram agent may sleep; a poll of getUpdates
 * with no offset (which confirms nothing) is how a new message is noticed.
 */
import type { Agent } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';

export interface HibernateDeps {
  store: Store;
  secrets: SecretStore;
  providerFor: (hostId: string) => RuntimeProvider;
  /** The newest session activity, as the app's "last active" shows it. */
  lastActiveFor: (a: Agent) => Promise<string | undefined>;
  /** The agent's own scheduled tasks (OpenClaw's built-in ones excluded). */
  ownCrons: (a: Agent) => Promise<Array<{ enabled: boolean; system?: boolean }>>;
  isBusy: (agentId: string) => boolean;
  /** After a wake, once the store says RUNNING: e.g. clearing stale runtime pins when the gateway is up. */
  afterWake?: (a: Agent) => void;
  log: (agentId: string) => (event: string, detail?: Record<string, unknown>) => void;
  fetchImpl?: typeof fetch;
}

/** HATCHABOT_HIBERNATE_AFTER as milliseconds: 90m, 6h, 2d; 0 or unset = off. */
export function hibernateAfterMs(raw = process.env.HATCHABOT_HIBERNATE_AFTER): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)?\s*$/i.exec(raw ?? '');
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'h').toLowerCase();
  const mult = unit.startsWith('m') ? 60_000 : unit.startsWith('d') ? 86_400_000 : 3_600_000;
  return Math.max(0, Math.round(n * mult));
}

/** Why this agent may not sleep right now, or undefined when it may. */
export async function hibernateBlocker(deps: HibernateDeps, a: Agent, now: number, afterMs: number): Promise<string | undefined> {
  if (a.state !== 'RUNNING' || !a.runtimeRef) return 'not running';
  if (a.hostId !== deps.store.localHostId()) return 'on another host';
  if (a.migratedTo) return 'moved to another machine';
  if (a.ops) return 'the management agent';
  if (deps.isBusy(a.id)) return 'busy';
  if (a.hibernate === 'never') return 'set to stay awake';
  const kinds = deps.store.listChannelsForAgent(a.id).map((c) => c.kind);
  if (kinds.some((k) => k !== 'telegram')) return 'on Discord or Slack (nothing queues their messages)';
  // The idle clock: the newest of its conversations and its last wake — a
  // woken agent gets the whole idle period again, restart or no restart.
  const active = (await deps.lastActiveFor(a).catch(() => undefined)) ?? a.updatedAt ?? a.createdAt;
  const last = Math.max(Date.parse(active) || 0, Date.parse(a.wokenAt ?? '') || 0);
  if (now - last < afterMs) return 'active recently';
  const crons = await deps.ownCrons(a).catch(() => undefined);
  if (crons === undefined) return 'its scheduled tasks could not be read';
  if (crons.some((c) => c.enabled && !c.system)) return 'has scheduled tasks';
  return undefined;
}

export async function hibernateAgent(deps: HibernateDeps, a: Agent, why: string): Promise<Agent> {
  const provider = deps.providerFor(a.hostId);
  // The record first, the container second: a crash between the two used to
  // leave a stopped container the wake poll never looked at (30th audit). And
  // the last word on "may it sleep" is now, not when the sweep looked — a
  // rebuild or a turn may have started during the blocker's own docker calls.
  const now = deps.store.getAgent(a.id);
  if (!now || now.state !== 'RUNNING' || !now.runtimeRef || deps.isBusy(a.id)) throw new Error('it is busy or no longer running');
  deps.store.setAgentState(a.id, 'STOPPED');
  deps.store.setHibernated(a.id, new Date().toISOString(), 0);
  try {
    await provider.stop(now.runtimeRef);
  } catch (err) {
    deps.store.setAgentState(a.id, 'RUNNING');
    deps.store.setHibernated(a.id, null);
    throw err;
  }
  // The gateway confirms an update only on its NEXT poll: the last message it
  // handled is still "waiting" once the container is stopped, and it woke the
  // agent two seconds after it slept (the Spark, 2026-09-26). Remember the
  // newest thing waiting now; only something newer is mail.
  const mark = (await telegramWaiting(deps, a)) ?? 0;
  deps.store.setHibernated(a.id, new Date().toISOString(), mark);
  deps.log(a.id)('agent.hibernated', { why });
  return deps.store.getAgent(a.id)!;
}

/** The idle sweep: every eligible agent goes to sleep. Returns who did. */
export async function hibernateSweep(deps: HibernateDeps, now = Date.now(), afterMs = hibernateAfterMs()): Promise<string[]> {
  if (!afterMs) return [];
  const out: string[] = [];
  for (const a of deps.store.listAllActiveAgents()) {
    const blocker = await hibernateBlocker(deps, a, now, afterMs);
    if (blocker) continue;
    try {
      await hibernateAgent(deps, a, `quiet for ${Math.round(afterMs / 60_000)} min`);
      out.push(a.id);
    } catch (err) {
      deps.log(a.id)('hibernate.failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** One wake at a time per agent: a second ask, the console's first requests and the sweep all await the same start. */
const waking = new Map<string, Promise<Agent>>();
/** Starts that failed in a row; after WAKE_GIVE_UP the agent is left an ordinary stopped one and the poll leaves it alone. */
const wakeFailures = new Map<string, number>();
export const WAKE_GIVE_UP = 3;

/**
 * Start a sleeping agent. Anything else — a stopped agent the owner stopped,
 * one that moved to another machine (its copy there polls the bot), one that
 * is busy (mid-move or mid-rebuild: a start would land on the container being
 * exported) — is left alone.
 */
export async function wakeAgent(deps: HibernateDeps, a: Agent, why: string): Promise<Agent> {
  if (!a.hibernatedAt || a.state !== 'STOPPED') return a;
  if (a.migratedTo || deps.isBusy(a.id)) return a;
  const inFlight = waking.get(a.id);
  if (inFlight) return inFlight;
  const p = (async () => {
    const provider = deps.providerFor(a.hostId);
    try {
      if (a.runtimeRef) await provider.start(a.runtimeRef);
    } catch (err) {
      const n = (wakeFailures.get(a.id) ?? 0) + 1;
      wakeFailures.set(a.id, n);
      if (n >= WAKE_GIVE_UP) {
        // Not every twenty seconds for ever (the image pruned, its port taken):
        // it is a stopped agent now, the reason on its trail, Start to retry.
        wakeFailures.delete(a.id);
        deps.store.setHibernated(a.id, null);
        deps.log(a.id)('hibernate.wake_abandoned', { error: err instanceof Error ? err.message : String(err), attempts: n });
      }
      throw err;
    }
    wakeFailures.delete(a.id);
    deps.store.setAgentState(a.id, 'RUNNING');
    deps.store.setHibernated(a.id, null);
    deps.log(a.id)('agent.woken', { why });
    const woken = deps.store.getAgent(a.id)!;
    deps.afterWake?.(woken);
    return woken;
  })();
  waking.set(a.id, p);
  try { return await p; } finally { waking.delete(a.id); }
}

/** Bot tokens Telegram refused (401): said once on the trail, then left alone until the process restarts. */
const refusedTokens = new Set<string>();
/** Tests: forget in-flight wakes, failure counts and refused tokens between worlds. */
export function resetHibernateState(): void { refusedTokens.clear(); waking.clear(); wakeFailures.clear(); }

/**
 * Telegram: an update waiting for a sleeping agent means someone wrote to it.
 * getUpdates with NO offset returns the unconfirmed updates, EARLIEST FIRST,
 * and confirms nothing — the gateway fetches from its own offset when it is
 * back. (A negative offset would confirm everything before it: never that
 * here.) Ask for a page, not one: with limit=1 the answer was always the
 * oldest waiting update — the bedtime mark itself — and ten newer messages
 * behind it were invisible until Telegram expired it a day later (30th
 * audit). The NEWEST waiting id is what this returns.
 */
export async function telegramWaiting(deps: HibernateDeps, a: Agent): Promise<number | undefined> {
  const ch = deps.store.listChannelsForAgent(a.id).find((c) => c.kind === 'telegram');
  if (!ch || refusedTokens.has(ch.secretRef)) return undefined;
  let token: string;
  try { token = await deps.secrets.get(ch.secretRef); } catch { return undefined; }
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`https://api.telegram.org/bot${token}/getUpdates?limit=100&timeout=0`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error_code?: number; result?: Array<{ update_id?: number }> };
    if (body.ok !== true) {
      if (body.error_code === 401 && !refusedTokens.has(ch.secretRef)) {
        refusedTokens.add(ch.secretRef);
        deps.log(a.id)('hibernate.token_refused', { kind: 'telegram' });
      }
      return undefined;
    }
    if (!Array.isArray(body.result) || !body.result.length) return undefined;
    return Math.max(0, ...body.result.map((u) => Number(u?.update_id) || 0));
  } catch {
    return undefined;
  }
}
/** Mail = an update newer than the one that was already waiting when the agent went to sleep. */
export async function telegramHasMail(deps: HibernateDeps, a: Agent): Promise<boolean> {
  const waiting = await telegramWaiting(deps, a);
  if (waiting === undefined) return false;
  return waiting > (a.hibernateMark ?? 0);
}

/** The wake sweep: sleeping agents with mail waiting get up. Returns who did. One sweep at a time: a slow Telegram must not stack them. */
let sweeping = false;
export async function wakeSweep(deps: HibernateDeps): Promise<string[]> {
  if (sweeping) return [];
  sweeping = true;
  const out: string[] = [];
  try {
    for (const a of deps.store.listAllActiveAgents()) {
      if (!a.hibernatedAt || a.state !== 'STOPPED' || a.migratedTo || deps.isBusy(a.id)) continue;
      if (!(await telegramHasMail(deps, a))) continue;
      try {
        const woken = await wakeAgent(deps, a, 'a Telegram message is waiting');
        if (woken.state === 'RUNNING') out.push(a.id);
      } catch (err) {
        deps.log(a.id)('hibernate.wake_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    sweeping = false;
  }
  return out;
}
