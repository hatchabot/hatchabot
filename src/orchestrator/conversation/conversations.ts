import type { Agent } from '../../domain/types.js';
import { guestConsoleSessionKey } from '../../openclaw/consoleIdentity.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { cronStoreReadShell } from '../schedules/crons.js';
import { RecentTracker, RECENT_CAP, orderRecent, previewFor, previewLine, type RecentPeople, type RecentViewer } from './recent.js';
import { consoleActivity, cronRunsSignature, markQuietTasks, quietTaskIds, type SessionEntry, sessionsReadShell } from './unread.js';
import { webChatStoreKey } from './webChat.js';

/**
 * An agent's conversations as Hatchabot reads them (HB-0808 step 13,
 * HB-0826): its sessions file read and
 * cached (`readSessions`, `sessionsFor`), "last active" (`lastActiveFor`,
 * `activityEvidence`), the unread mark (`unreadFor`), and the home screen's
 * Recent list with its capture (`recent`). Built once in `registerRoutes`,
 * before the services that read it (the lifecycle's agent list and sweep,
 * the hibernation sweep, the ops agent's turns, the memory search service's
 * move), which are told of it as functions; on the route context as
 * `ctx.conversations`; its routes (/v1/recent, POST /v1/agents/:id/seen) are
 * in src/api/chat/conversationRoutes.ts. It knows nothing of HTTP.
 *
 * It owns the sessions cache (`sessionsCache`), the quiet tasks' cache
 * (`quietTasksCache`) and the Recent capture (`RecentTracker`). Both caches
 * are per agent: a delete or an archive empties them (`forgetAgent`), and
 * an entry read where the agent ran before a move goes at its next look
 * (HB-1362). Every timer is a read's own (the first read's short wait);
 * `stop()` has nothing to end.
 */
export interface Conversations {
  /** The agent's sessions file, read now (undefined when it could not be read). */
  readSessions(a: Agent): Promise<Record<string, SessionEntry> | undefined>;
  /** Its sessions as the list reads them: cached, refreshed behind the answer after a minute. */
  sessionsFor(a: Agent): Promise<Record<string, SessionEntry> | undefined>;
  /** The newest session update in a session list. */
  newestActivity(sessions: Record<string, SessionEntry> | undefined): string | undefined;
  /** "Last active" = the newest session update in that file. */
  lastActiveFor(a: Agent): Promise<string | undefined>;
  /** Its last activity for a decision that interrupts it: `read` only when its conversations were actually read. */
  activityEvidence(a: Agent): Promise<{ read: boolean; lastActiveAt?: string }>;
  /** Has this agent said something in its console since this person last had it open? */
  unreadFor(a: Agent, ownerId: string): Promise<boolean>;
  /** Its cached sessions are dropped: the next read is fresh (a turn just ran in it). */
  forget(agentId: string): void;
  /** Everything cached for a deleted or archived agent is dropped: its sessions and its quiet tasks (HB-0914, HB-1362). */
  forgetAgent(agentId: string): void;
  /** The home screen's Recent list for this person (`all`: the whole week). */
  recent(me: string, all: boolean): Promise<RecentList>;
}

/** The Recent list: its cap, how many the week holds, and the rows (id, name, icon, at, unread, asleep, line, by, said). */
export interface RecentList {
  cap: number;
  total: number;
  items: object[];
}

/** What the reads need from the process they run in. Functions only, so a test hands them fakes. */
export interface ConversationsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
}

/** Where an agent's sessions were read: its machine and its container. */
type Place = Pick<Agent, 'hostId' | 'runtimeRef'>;

export function createConversations(deps: ConversationsDeps): Conversations {
  const { store, providerFor } = deps;
  /**
   * The agent's sessions file, read with one `cat` in its container: "last
   * active" and the unread mark both come from it. The app polls the list
   * every few seconds, so: cached per agent; after a minute the CACHED value
   * is answered at once and a refresh runs behind it (stale-while-revalidate).
   * The list used to run `openclaw sessions list` per agent as well — the CLI
   * takes a second to start, so 30 running agents cost 8 s per cold list.
   */
  const sessionsCache = new Map<string, { fetchedAt: number; value?: Record<string, SessionEntry>; refreshing?: boolean } & Place>();
  /** Per agent: its quiet tasks, as of the scheduled runs its records showed then (HB-0302). */
  const quietTasksCache = new Map<string, { runs: string; ids: Set<string>; at: number }>();
  /**
   * Deleted, being deleted, archived, or no longer where `a` ran (a move, or
   * one put back): a read that ends now caches nothing for it (HB-0914,
   * HB-1362).
   */
  const gone = (a: Place & { id: string }) => {
    const now = store.getAgent(a.id);
    return !now || now.state === 'DELETING' || now.state === 'DELETED' || now.state === 'ARCHIVED' || now.hostId !== a.hostId || now.runtimeRef !== a.runtimeRef;
  };
  const readSessions = async (a: Agent): Promise<Record<string, SessionEntry> | undefined> => {
    try {
      const res = await providerFor(a.hostId).execShell(a.runtimeRef!, sessionsReadShell(a.slug));
      if (res.code === 0 && res.stdout.trim()) {
        const sessions = JSON.parse(res.stdout) as Record<string, SessionEntry>;
        // An agent with a bot: its scheduled runs are delivered there, but a
        // quiet task's are read only in the console (HB-0302). Its tasks are
        // read (one Node start) only when it has scheduled runs at all.
        // Read again only after a task has run since the last read, or ten
        // minutes on (a task changed in between, made quiet or not).
        const runs = cronRunsSignature(sessions);
        if (!a.webOnly && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(a.slug) && runs) {
          let quiet = quietTasksCache.get(a.id);
          if (quiet?.runs !== runs || Date.now() - quiet.at > 10 * 60_000) {
            const jobs = await providerFor(a.hostId).execShell(a.runtimeRef!, cronStoreReadShell(a.slug)).catch(() => undefined);
            const ids = jobs?.code === 0 ? quietTaskIds(jobs.stdout) : undefined;
            quiet = ids ? { runs, ids, at: Date.now() } : undefined;
            if (quiet && !gone(a)) quietTasksCache.set(a.id, quiet);
            else quietTasksCache.delete(a.id);
          }
          if (quiet?.ids.size) markQuietTasks(sessions, quiet.ids);
        }
        return sessions;
      }
    } catch {
      /* a container hiccup: no mark this minute */
    }
    return undefined;
  };
  /**
   * The Recent list's capture (orchestrator/conversation/recent.ts), fed by the reads
   * below: a conversation that moved gets its last line read in the
   * background; a quiet agent costs nothing more. Only running agents are
   * ever read; an asleep one keeps its stored line.
   */
  const recentTracker = new RecentTracker({
    get: (id) => store.getAgentRecent(id),
    set: (id, record) => store.setAgentRecent(id, record),
    exec: async (id, script) => {
      const a = store.getAgent(id);
      if (!a?.runtimeRef || a.state !== 'RUNNING') return { code: 1, stdout: '' };
      return providerFor(a.hostId).execShell(a.runtimeRef, script);
    },
  });
  const SESSIONS_FIRST_WAIT_MS = 3_000;
  /**
   * A read fills the cache only if the entry it began from is still the
   * agent's: `forget` (a turn just ran) or a newer read since means it is
   * older news. An old read that finished last put its value back with a
   * fresh time, and hid the new activity for another minute (HB-0895).
   */
  const fill = (a: Agent, from: object, value: Record<string, SessionEntry> | undefined): void => {
    if (sessionsCache.get(a.id) !== from) return;
    sessionsCache.set(a.id, { fetchedAt: Date.now(), value, hostId: a.hostId, runtimeRef: a.runtimeRef });
    void recentTracker.note(a, value);
  };
  const sessionsFor = async (a: Agent): Promise<Record<string, SessionEntry> | undefined> => {
    if (!a.runtimeRef || a.state !== 'RUNNING') return undefined;
    let hit = sessionsCache.get(a.id);
    // Read where it ran before a move: its sessions are read again where it
    // runs now, and its quiet tasks with them (HB-1362).
    if (hit && (hit.hostId !== a.hostId || hit.runtimeRef !== a.runtimeRef)) {
      sessionsCache.delete(a.id); quietTasksCache.delete(a.id); hit = undefined;
    }
    if (hit) {
      if (Date.now() - hit.fetchedAt >= 60_000 && !hit.refreshing) {
        hit.refreshing = true;
        void readSessions(a).then((value) => fill(a, hit, value)).catch(() => { hit.refreshing = false; });
      }
      return hit.value;
    }
    // First look: wait for it, but not for long. A runner that's asleep or
    // offline (a laptop) used to hold every list request for 60 s, so the
    // whole home screen stayed on "Loading…" (2026-10-04). After a short wait
    // the list goes on without this agent's activity; the read finishes in the
    // background and fills the cache for the next poll. Not for an agent
    // deleted since the caller looked it up: it would stay cached for good.
    if (gone(a)) return undefined;
    const placeholder = { fetchedAt: Date.now(), value: undefined, refreshing: true, hostId: a.hostId, runtimeRef: a.runtimeRef };
    sessionsCache.set(a.id, placeholder);
    const pending = readSessions(a).then((value) => { fill(a, placeholder, value); return value; });
    // A read that fails is forgotten, so the next poll tries again.
    pending.catch(() => { if (sessionsCache.get(a.id) === placeholder) sessionsCache.delete(a.id); });
    const quick = await Promise.race([pending.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), SESSIONS_FIRST_WAIT_MS).unref?.())]);
    return quick;
  };
  /** The newest session update in a session list. */
  const newestActivity = (sessions: Record<string, SessionEntry> | undefined): string | undefined => {
    let newest = 0;
    for (const s of Object.values(sessions ?? {})) {
      if (!s || typeof s !== 'object') continue;
      newest = Math.max(newest, Number(s.updatedAt) || 0, Number(s.lastInteractionAt) || 0);
    }
    return newest > 0 ? new Date(newest).toISOString() : undefined;
  };
  /** "Last active" = the newest session update in that file. */
  const lastActiveFor = async (a: Agent): Promise<string | undefined> => newestActivity(await sessionsFor(a));
  /**
   * Its last activity, for a decision that interrupts it (an unattended
   * rebuild): `read` only when its conversations were actually read, now.
   * Never the list's cache: it can be a minute or more old (older while its
   * refresh is under way), and a rebuild was picked for an agent in the
   * middle of a conversation on an idle reading from before it (HB-0896).
   * The cached list cannot tell a failed read from an agent with none
   * either, so it is read here, strictly (#157).
   */
  const activityEvidence = async (a: Agent): Promise<{ read: boolean; lastActiveAt?: string }> => {
    if (!a.runtimeRef) return { read: false };
    const res = await providerFor(a.hostId).execShell(a.runtimeRef, sessionsReadShell(a.slug)).catch(() => undefined);
    if (!res || res.code !== 0 || res.timedOut) return { read: false };
    try { return { read: true, lastActiveAt: newestActivity(res.stdout.trim() ? JSON.parse(res.stdout) as Record<string, SessionEntry> : {}) }; }
    catch { return { read: false }; }
  };
  /** Has this agent said something in its console since this person last had it open? */
  const unreadFor = async (a: Agent, ownerId: string): Promise<boolean> => {
    // As the console would show them (recentViewerOf): the owner every
    // conversation, a web-chat guest only their own, anyone else none.
    const viewer = recentViewerOf(a, ownerId, store.accessRole(a.id, ownerId) ?? '');
    if (viewer.kind === 'none') return false;
    const at = consoleActivity(await sessionsFor(a), { webOnly: !!a.webOnly, ...(viewer.kind === 'guest' ? { keys: viewer.keys } : {}) });
    const seen = store.getAgentSeen(ownerId, a.id);
    if (seen === undefined) {
      // First look at this agent: start from now rather than flagging its whole past.
      store.setAgentSeen(ownerId, a.id, Date.now());
      return false;
    }
    return at > seen;
  };

  // ---- Recent: each agent's last line, as this person could read it ---------
  // (orchestrator/conversation/recent.ts). Previews mirror the console: its owner reads
  // every conversation; a web-chat guest only their own; anyone else none.

  /** Who is looking at this agent, as its console would treat them. */
  const recentViewerOf = (a: Agent, me: string, role: string): RecentViewer => {
    if (role === 'owner') return { kind: 'owner', userId: me };
    if (!a.ops && a.gatewayToken && store.webChatAllowed(a.id, me)) {
      return { kind: 'guest', userId: me, keys: [guestConsoleSessionKey(a.gatewayToken, a.slug, me), webChatStoreKey(a.slug, me)] };
    }
    return { kind: 'none', userId: me };
  };
  /** The people a line can be from: the agent's active members by their channel ids, and the guests by their own conversations. */
  const recentPeopleOf = (a: Agent): RecentPeople => {
    const byChannelId: RecentPeople['byChannelId'] = new Map();
    const byKey: RecentPeople['byKey'] = new Map();
    const ownerTg = store.accountTelegram(a.ownerId);
    if (ownerTg) byChannelId.set(ownerTg, { userId: a.ownerId });
    for (const m of store.listMemberships(a.id)) {
      if (m.status !== 'active') continue;
      const who = { userId: m.userId, name: m.displayName };
      for (const id of Object.values(store.memberIdentities(a.id, m.userId))) if (id && !byChannelId.has(id)) byChannelId.set(id, who);
      if (m.userId !== a.ownerId) {
        if (a.gatewayToken) byKey.set(guestConsoleSessionKey(a.gatewayToken, a.slug, m.userId), who);
        byKey.set(webChatStoreKey(a.slug, m.userId), who);
      }
    }
    return { byChannelId, byKey };
  };
  /** The Alerts states the line carries (the app's wording), unless the owner cleared them. */
  const recentNeedsYou = (a: Agent): string | undefined => {
    const cleared = new Set((a.attentionAck ?? '').split('\n'));
    if (a.state === 'FAILED' && !cleared.has('failed')) return 'it failed';
    if (a.pendingAction && !a.pendingAction.received && !cleared.has('pending')) return a.pendingAction.type === 'bot_token' ? 'waiting for a Telegram bot token' : 'a step is waiting on you';
    if (a.state === 'STOPPED' && a.stateReason && !cleared.has('not-started')) return 'it did not start again';
    return undefined;
  };

  return {
    readSessions, sessionsFor, newestActivity, lastActiveFor, activityEvidence, unreadFor,
    forget: (agentId) => { sessionsCache.delete(agentId); },
    forgetAgent: (agentId) => { sessionsCache.delete(agentId); quietTasksCache.delete(agentId); },
    /**
     * The home screen's Recent list: the agents this person can open that were
     * active in the last week, each with its last line as they could read it.
     * Unread first, then newest, at most eight; ?all=1 is the whole week,
     * newest first. Rides on the list's cached session reads: an agent that
     * is asleep or stopped is never read or woken — its stored line is used.
     */
    async recent(me, all) {
      const rows = (await Promise.all(store.listVisibleAgents(me)
        .filter((a) => a.state !== 'ARCHIVED' && a.state !== 'DELETING' && a.state !== 'DELETED')
        .map(async (a) => {
          const role = store.accessRole(a.id, me);
          if (!role) return undefined;
          const live = Date.parse((await lastActiveFor(a).catch(() => undefined)) ?? '') || 0;
          const record = recentTracker.record(a.id);
          const preview = previewFor(record, recentViewerOf(a, me, role), recentPeopleOf(a));
          const needsYou = role === 'owner' ? recentNeedsYou(a) : undefined;
          return {
            id: a.id,
            name: a.name,
            icon: a.icon,
            at: Math.max(live, record?.lastActiveAt ?? 0),
            unread: await unreadFor(a, me).catch(() => false),
            asleep: !!a.hibernatedAt || a.state !== 'RUNNING' || undefined,
            line: previewLine(preview, needsYou),
            by: needsYou ? 'needs-you' : preview?.by,
            /** The last line alone, without a Alerts state (the app words those itself). */
            said: previewLine(preview),
          };
        }))).filter((r): r is NonNullable<typeof r> => !!r);
      const ordered = orderRecent(rows, { all });
      return {
        cap: RECENT_CAP,
        total: all ? ordered.length : orderRecent(rows, { all: true }).length,
        items: ordered.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
      };
    },
  };
}
