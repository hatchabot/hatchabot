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
  if (deps.isBusy(a.id)) return 'busy';
  if (a.hibernate === 'never') return 'set to stay awake';
  const kinds = deps.store.listChannelsForAgent(a.id).map((c) => c.kind);
  if (kinds.some((k) => k !== 'telegram')) return 'on Discord or Slack (nothing queues their messages)';
  const last = (await deps.lastActiveFor(a).catch(() => undefined)) ?? a.updatedAt ?? a.createdAt;
  if (now - Date.parse(last) < afterMs) return 'active recently';
  const crons = await deps.ownCrons(a).catch(() => undefined);
  if (crons === undefined) return 'its scheduled tasks could not be read';
  if (crons.some((c) => c.enabled && !c.system)) return 'has scheduled tasks';
  return undefined;
}

export async function hibernateAgent(deps: HibernateDeps, a: Agent, why: string): Promise<Agent> {
  const provider = deps.providerFor(a.hostId);
  await provider.stop(a.runtimeRef!);
  deps.store.setAgentState(a.id, 'STOPPED');
  const at = new Date().toISOString();
  deps.store.setHibernated(a.id, at);
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

/** Start a sleeping agent. Anything else (a stopped agent the owner stopped) is left alone. */
export async function wakeAgent(deps: HibernateDeps, a: Agent, why: string): Promise<Agent> {
  if (!a.hibernatedAt) return a;
  const provider = deps.providerFor(a.hostId);
  if (a.runtimeRef) await provider.start(a.runtimeRef);
  deps.store.setAgentState(a.id, 'RUNNING');
  deps.store.setHibernated(a.id, null);
  deps.log(a.id)('agent.woken', { why });
  return deps.store.getAgent(a.id)!;
}

/**
 * Telegram: an update waiting for a sleeping agent means someone wrote to it.
 * getUpdates with NO offset returns the earliest unconfirmed update and
 * confirms nothing — the gateway fetches from its own offset when it is back.
 * (A negative offset would confirm everything before it: never that here.)
 */
export async function telegramHasMail(deps: HibernateDeps, a: Agent): Promise<boolean> {
  const ch = deps.store.listChannelsForAgent(a.id).find((c) => c.kind === 'telegram');
  if (!ch) return false;
  let token: string;
  try { token = await deps.secrets.get(ch.secretRef); } catch { return false; }
  const f = deps.fetchImpl ?? fetch;
  try {
    const res = await f(`https://api.telegram.org/bot${token}/getUpdates?limit=1&timeout=0`, { signal: AbortSignal.timeout(8000) });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown[] };
    return body.ok === true && Array.isArray(body.result) && body.result.length > 0;
  } catch {
    return false;
  }
}

/** The wake sweep: sleeping agents with mail waiting get up. Returns who did. */
export async function wakeSweep(deps: HibernateDeps): Promise<string[]> {
  const out: string[] = [];
  for (const a of deps.store.listAllActiveAgents()) {
    if (!a.hibernatedAt || a.state !== 'STOPPED') continue;
    if (!(await telegramHasMail(deps, a))) continue;
    try {
      await wakeAgent(deps, a, 'a Telegram message is waiting');
      out.push(a.id);
    } catch (err) {
      deps.log(a.id)('hibernate.wake_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
