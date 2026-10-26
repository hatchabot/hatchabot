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
import { createHash } from 'node:crypto';
import type { Agent } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';
import { AgentBusyError, whileBusy } from './busy.js';
import { agentMemoryLimits } from './swap.js';

export interface HibernateDeps {
  store: Store;
  secrets: SecretStore;
  providerFor: (hostId: string) => RuntimeProvider;
  /** The newest session activity, as the app's "last active" shows it;
   *  undefined when there is none, a rejection when it could not be read. */
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

/**
 * The part of the rule its record and settings decide, with no waiting:
 * judged again just before the stop, under the lock (`locked`: the busy flag
 * is then its own).
 */
function settledBlocker(deps: HibernateDeps, a: Agent, locked = false): string | undefined {
  if (a.state !== 'RUNNING' || !a.runtimeRef) return 'not running';
  if (a.hostId !== deps.store.localHostId()) return 'on another host';
  if (a.migratedTo) return 'moved to another machine';
  if (a.ops) return 'the management agent';
  if (!locked && deps.isBusy(a.id)) return 'busy';
  if (a.hibernate === 'never') return 'set to stay awake';
  const kinds = deps.store.listChannelsForAgent(a.id).map((c) => c.kind);
  if (kinds.some((k) => k !== 'telegram')) return 'on Discord or Slack (nothing queues their messages)';
  return undefined;
}

/** Why this agent may not sleep right now, or undefined when it may. */
export async function hibernateBlocker(deps: HibernateDeps, a: Agent, now: number, afterMs: number): Promise<string | undefined> {
  return (await idleBlocker(deps, a, now, afterMs)).blocker;
}
/** hibernateBlocker, and the activity it read (`seen`), which the stop checks again under the lock. */
async function idleBlocker(deps: HibernateDeps, a: Agent, now: number, afterMs: number): Promise<{ blocker?: string; seen?: string }> {
  const settled = settledBlocker(deps, a);
  if (settled) return { blocker: settled };
  // The idle clock: the newest of its conversations and its last wake — a
  // woken agent gets the whole idle period again, restart or no restart.
  // A read that failed is not "no activity": falling back to the record's own
  // timestamp put an agent to sleep mid-conversation (#99). It stays up.
  let read: string | undefined;
  try { read = await deps.lastActiveFor(a); } catch { return { blocker: 'its activity could not be read' }; }
  const active = read ?? a.updatedAt ?? a.createdAt;
  const last = Math.max(Date.parse(active) || 0, Date.parse(a.wokenAt ?? '') || 0);
  if (now - last < afterMs) return { blocker: 'active recently' };
  const crons = await deps.ownCrons(a).catch(() => undefined);
  if (crons === undefined) return { blocker: 'its scheduled tasks could not be read' };
  if (crons.some((c) => c.enabled && !c.system)) return { blocker: 'has scheduled tasks' };
  return { seen: read };
}

/** The choice to sleep no longer holds once the lock is taken: it stays up. The sweep has nothing to report; by hand, the reason is the answer. */
export class NoLongerSleepy extends Error {}

/** Agents whose bedtime mark this process is still reading: the wake poll leaves their placeholder alone. */
const markPending = new Set<string>();

/**
 * Put an agent to sleep. `opts.idle`: the idle sweep's, so the settings it
 * judged before its activity and task reads are judged again under the lock,
 * and so is the activity it read (`opts.seen`).
 */
export async function hibernateAgent(deps: HibernateDeps, a: Agent, why: string, opts: { idle?: boolean; seen?: string } = {}): Promise<Agent> {
  const provider = deps.providerFor(a.hostId);
  // The record first, the container second: a crash between the two used to
  // leave a stopped container the wake poll never looked at (30th audit). And
  // the last word on "may it sleep" is now, not when the sweep looked — a
  // rebuild or a turn may have started during the blocker's own docker calls.
  const now = deps.store.getAgent(a.id);
  if (!now || now.state !== 'RUNNING' || !now.runtimeRef || deps.isBusy(a.id)) throw new Error('it is busy or no longer running');
  // Under the busy flag: reconcile skips busy agents, and during the
  // up-to-ten-second docker stop it read the still-running container and
  // flipped the record back to RUNNING (night review, 2026-09-27).
  // Bedtime, by the clock Telegram dates messages with (seconds): what was
  // sent from now on is mail even if it is already waiting when the mark is
  // read, after the stop (#98).
  // One time for bedtime and the record: a restart before the real mark
  // recovers it by this record's time (telegramHasMail, #218).
  let bedtime = 0;
  let sleptAt = '';
  await whileBusy(a.id, async () => {
    // The sweep read the settings before its awaits: "Never sleep" chosen
    // meanwhile used to lose to it and the agent was stopped anyway (#219).
    const blocker = opts.idle ? settledBlocker(deps, deps.store.getAgent(a.id) ?? now, true) : undefined;
    if (blocker) throw new NoLongerSleepy(blocker);
    // Its scheduled tasks, by hand too, read under the lock the stop holds: a
    // task added while the route or the sweep read them was put to sleep with
    // the agent and never ran (audit #055). Adding one takes this lock.
    const tasks = await deps.ownCrons(deps.store.getAgent(a.id) ?? now).catch(() => undefined);
    if (tasks === undefined) throw new NoLongerSleepy('its scheduled tasks could not be read');
    if (tasks.some((c) => c.enabled && !c.system)) throw new NoLongerSleepy('has scheduled tasks');
    // A turn that finished during the sweep's task read (its busy flag clear
    // again) is newer activity than the sweep saw: it stays up (review, 2026-10-22).
    if (opts.idle) {
      const fresh = await deps.lastActiveFor(deps.store.getAgent(a.id) ?? now).then((v) => v ?? '', () => undefined);
      if (fresh === undefined) throw new NoLongerSleepy('its activity could not be read');
      if ((Date.parse(fresh) || 0) > (Date.parse(opts.seen ?? '') || 0)) throw new NoLongerSleepy('active recently');
    }
    const t = Date.now();
    bedtime = Math.floor(t / 1000);
    sleptAt = new Date(t).toISOString();
    deps.store.setAgentState(a.id, 'STOPPED');
    deps.store.setHibernated(a.id, sleptAt, Number.MAX_SAFE_INTEGER);
    try {
      await provider.stop(now.runtimeRef!);
    } catch (err) {
      deps.store.setAgentState(a.id, 'RUNNING');
      deps.store.setHibernated(a.id, null);
      throw err;
    }
  });
  // The gateway confirms an update only on its NEXT poll: the last message it
  // handled is still "waiting" once the container is stopped, and it woke the
  // agent two seconds after it slept (the Spark, 2026-09-26). Remember the
  // newest thing waiting now; only something newer is mail.
  // Until the real mark is known, nothing counts as mail: a wake poll in
  // this gap saw the unconfirmed update as new, woke the agent, and the
  // write below then marked a RUNNING agent asleep (night review).
  deps.store.setHibernated(a.id, sleptAt, Number.MAX_SAFE_INTEGER);
  // A message that came in between the stop and this read used to become the
  // mark, "already handled", and could not wake the agent. Only what was sent
  // before bedtime counts as the gateway's unconfirmed batch; an update with
  // no date of its own (a button press) is taken to be part of it.
  markPending.add(a.id);
  let waiting: Array<{ id: number; date?: number }> | undefined;
  try { waiting = await telegramWaitingUpdates(deps, a); } finally { markPending.delete(a.id); }
  const mark = markBefore(waiting, bedtime);
  const still = deps.store.getAgent(a.id);
  if (still?.state !== 'STOPPED' || !still.hibernatedAt) return still ?? a;
  deps.store.setHibernated(a.id, sleptAt, mark);
  deps.log(a.id)('agent.hibernated', { why });
  return deps.store.getAgent(a.id)!;
}

/** The idle sweep: every eligible agent goes to sleep. Returns who did. */
/** One idle sweep at a time: a second pass from a stale listing reached agents the first had just put to sleep, and logged false failures (night review). */
let idleSweeping = false;
export async function hibernateSweep(deps: HibernateDeps, now = Date.now(), afterMs = hibernateAfterMs()): Promise<string[]> {
  if (!afterMs || idleSweeping) return [];
  idleSweeping = true;
  const out: string[] = [];
  try {
    for (const a of deps.store.listAllActiveAgents()) {
      const { blocker, seen } = await idleBlocker(deps, a, now, afterMs);
      if (blocker) continue;
      try {
        await hibernateAgent(deps, a, `quiet for ${Math.round(afterMs / 60_000)} min`, { idle: true, seen });
        out.push(a.id);
      } catch (err) {
        if (err instanceof NoLongerSleepy) continue;
        deps.log(a.id)('hibernate.failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    idleSweeping = false;
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
    // Under the agent's lifecycle lock, judged again once it is held, as a
    // Start is: an Archive or a move that took the lock during the docker
    // start used to finish underneath it, and the wake then brought up an
    // archived runtime whose bot had gone back (#10). Busy now = left alone.
    let woken: Agent | undefined;
    try {
      woken = await whileBusy(a.id, async () => {
        const now = deps.store.getAgent(a.id);
        if (!now?.hibernatedAt || now.state !== 'STOPPED' || now.migratedTo) return undefined;
        const provider = deps.providerFor(now.hostId);
        try {
          if (now.runtimeRef) {
            // Its cap and swap allowance as they are now (swap.ts): the host may
            // have gained or lost compressed swap, or a setting changed, while it slept.
            const lim = agentMemoryLimits(deps.store, now);
            await provider.updateMemory?.(now.runtimeRef, lim.memory, lim.swap).catch(() => {});
            await provider.start(now.runtimeRef);
          }
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
        return deps.store.getAgent(a.id)!;
      });
    } catch (err) {
      if (err instanceof AgentBusyError) return deps.store.getAgent(a.id) ?? a;
      throw err;
    }
    if (!woken) return deps.store.getAgent(a.id) ?? a;
    deps.afterWake?.(woken);
    return woken;
  })();
  waking.set(a.id, p);
  try { return await p; } finally { waking.delete(a.id); }
}

/**
 * Bot tokens Telegram refused (401), by secret and the token it held: said
 * once on the trail, then left alone. Keyed by the token too, so a new token
 * saved under the same secret is polled again; keyed by the secret alone, a
 * sleeper whose token was replaced was never woken by a message again (#100).
 */
const refusedTokens = new Map<string, string>();
const tokenPrint = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16);
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
 * audit). Every waiting update is what telegramWaitingUpdates returns.
 */
/** getUpdates' page size: a full page may have more behind it. */
const PAGE = 100;
/** When an update was sent (or edited), in Telegram's seconds; undefined for one with no date of its own. */
function updateDate(u: Record<string, unknown>): number | undefined {
  for (const [k, v] of Object.entries(u)) {
    if (k === 'update_id' || !v || typeof v !== 'object') continue;
    const o = v as { date?: unknown; edit_date?: unknown };
    const d = typeof o.edit_date === 'number' ? o.edit_date : o.date;
    if (typeof d === 'number' && Number.isFinite(d)) return d;
  }
  return undefined;
}
/** The updates waiting for the agent (up to a page), or undefined when none or unreadable. */
async function telegramWaitingUpdates(deps: HibernateDeps, a: Agent): Promise<Array<{ id: number; date?: number }> | undefined> {
  const ch = deps.store.listChannelsForAgent(a.id).find((c) => c.kind === 'telegram');
  if (!ch) return undefined;
  let token: string;
  try { token = await deps.secrets.get(ch.secretRef); } catch { return undefined; }
  const print = tokenPrint(token);
  if (refusedTokens.get(ch.secretRef) === print) return undefined;
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`https://api.telegram.org/bot${token}/getUpdates?limit=${PAGE}&timeout=0`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error_code?: number; result?: Array<Record<string, unknown>> };
    if (body.ok !== true) {
      if (body.error_code === 401 && refusedTokens.get(ch.secretRef) !== print) {
        refusedTokens.set(ch.secretRef, print);
        deps.log(a.id)('hibernate.token_refused', { kind: 'telegram' });
      }
      return undefined;
    }
    if (refusedTokens.get(ch.secretRef) !== undefined) refusedTokens.delete(ch.secretRef);
    if (!Array.isArray(body.result) || !body.result.length) return undefined;
    return body.result.map((u) => ({ id: Number(u?.update_id) || 0, date: u && typeof u === 'object' ? updateDate(u) : undefined }));
  } catch {
    return undefined;
  }
}
/** The bedtime mark: the newest update sent before bedtime (or with no date), 0 when none. */
function markBefore(waiting: Array<{ id: number; date?: number }> | undefined, bedtime: number): number {
  const before = (waiting ?? []).filter((u) => u.date === undefined || u.date < bedtime);
  return before.length ? Math.max(0, ...before.map((u) => u.id)) : 0;
}
/**
 * How far below the bedtime mark an update may sit and still be one that was
 * already waiting then: the gateway's last batch, unconfirmed, is at most a
 * page. Anything further down arrived after.
 */
const MARK_BATCH = 100;
/**
 * Mail = an update that was not already waiting when the agent went to sleep.
 * Not only a newer id: after a week with no updates Telegram starts the next
 * update_id at random (Bot API, getUpdates), so a quiet week's first message
 * can sit BELOW the mark — and a sleeper waited for it forever (2026-09-30).
 */
export async function telegramHasMail(deps: HibernateDeps, a: Agent): Promise<boolean> {
  // While hibernateAgent reads the mark nothing is mail (it writes the mark).
  if (a.hibernateMark === Number.MAX_SAFE_INTEGER && markPending.has(a.id)) return false;
  const updates = await telegramWaitingUpdates(deps, a);
  const ids = updates?.map((u) => u.id);
  // The placeholder mark outlived its sleep (a restart between it and the
  // real mark): the mark is found as bedtime finds it, by the sleep's
  // recorded time, or the agent never woke on a message again (regression
  // review, 2026-09-28). Everything waiting used to become the mark, so the
  // first message sent after bedtime was taken as handled and woke nothing
  // (#218): one sent after the recorded time is mail now.
  if (a.hibernateMark === Number.MAX_SAFE_INTEGER) {
    const now = deps.store.getAgent(a.id);
    if (!now?.hibernatedAt || now.hibernateMark !== Number.MAX_SAFE_INTEGER) return false;
    // An unreadable time: every dated update is mail (wake rather than miss one).
    const bedtime = Math.floor((Date.parse(now.hibernatedAt) || 0) / 1000);
    deps.store.setHibernated(a.id, now.hibernatedAt, markBefore(updates, bedtime));
    return (updates ?? []).some((u) => u.date !== undefined && u.date >= bedtime);
  }
  if (!ids?.length) return false;
  // A full page may hide newer mail behind it: the page always starts at the
  // oldest unconfirmed update, and a hundred left from bedtime filled it for
  // good (#63). Waking is the safe answer; the gateway works through the queue.
  if (ids.length >= PAGE) return true;
  const mark = a.hibernateMark ?? 0;
  return ids.some((id) => id > mark || id < mark - MARK_BATCH);
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
