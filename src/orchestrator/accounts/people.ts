import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { sessionsReadShell } from '../conversation/unread.js';

/**
 * The people an account deals with (HB-0808 step 15 part B): the roster of
 * everyone on its agents (GET /v1/users) and the accounts a share can be
 * addressed to (GET /v1/accounts).
 */
export interface People {
  /** Every person on the agents of `ownerId` (every agent with `all`, which the route allows the machine's owner only). */
  roster(ownerId: string, all: boolean): Promise<{ users: RosterRow[]; note: string }>;
  /**
   * People a share can be addressed to — suggestions only; the dialog takes
   * any typed address. The machine's owner sees every account that has
   * signed in; anyone else sees the owner and the people they have already
   * swapped agents with, not the whole household (review, 2026-09-29).
   */
  addressees(me: string, ownsMachine: () => boolean): { accounts: Array<{ ownerId: string; email?: string }> };
}

export type RosterRow = {
  channelUserId?: string;
  displayName?: string;
  memberships: Array<{ agentId: string; agentName: string; agentState: string; role: string; status: string; joinedAt?: string }>;
  lastSeen?: { at: string; agentName: string; thread: string };
};

export interface PeopleDeps {
  store: Pick<Store, 'listAllActiveAgents' | 'listMemberships' | 'listAccounts' | 'listHosts' | 'listRelatedAccounts'>;
  providerFor: (hostId: string) => RuntimeProvider;
}

export function createPeople(deps: PeopleDeps): People {
  const { store, providerFor } = deps;
  /**
   * The people roster: every Telegram user across the caller's agents, with
   * membership detail and last activity where it is honestly knowable.
   *
   * Attribution caveat, by construction: OpenClaw keeps ONE shared session per
   * agent DM thread (docs/pre-production.md §8), and its store records only
   * the LAST exchange per thread (`lastTo` + `lastInteractionAt`). So "last
   * seen" here means "the most recent exchange in some thread was with this
   * user" — an earlier speaker in the same thread shows the older reading from
   * whenever they were last the latest. That is still the truthful upper bound
   * of what the data contains; per-message per-user history simply is not
   * recorded anywhere.
   */
  const THREADS_FOR_MS = 60_000;
  const threadCache = new Map<string, { fetchedAt: number; value: Array<{ tg: string; at: number; thread: string }> }>();
  /**
   * Readings past their minute go, at each roster: one for an agent since
   * deleted or stopped was never read again, so it was never replaced, and
   * every agent the roster had ever read stayed in memory (HB-1132).
   */
  const forgetOldThreads = () => {
    const now = Date.now();
    for (const [id, hit] of threadCache) if (now - hit.fetchedAt >= THREADS_FOR_MS) threadCache.delete(id);
  };
  const lastExchangesFor = async (a: Agent): Promise<Array<{ tg: string; at: number; thread: string }>> => {
    if (!a.runtimeRef || a.state !== 'RUNNING') return [];
    const hit = threadCache.get(a.id);
    if (hit && Date.now() - hit.fetchedAt < THREADS_FOR_MS) return hit.value;
    let value: Array<{ tg: string; at: number; thread: string }> = [];
    try {
      const res = await providerFor(a.hostId).execShell(a.runtimeRef!, sessionsReadShell(a.slug));
      if (res.code === 0 && res.stdout.trim()) {
        const sessions = JSON.parse(res.stdout) as Record<string, {
          lastInteractionAt?: number;
          lastTo?: string;
          origin?: { from?: string };
          chatType?: string;
        }>;
        for (const [key, sess] of Object.entries(sessions)) {
          if (key.includes(':cron:')) continue; // machine talking to itself
          const to = sess.lastTo ?? sess.origin?.from ?? '';
          const m = /^telegram:(-?\d+)$/.exec(to);
          if (!m || !sess.lastInteractionAt) continue;
          const id = m[1]!;
          if (id.startsWith('-')) continue; // a group chat id, not a person
          value.push({
            tg: id,
            at: sess.lastInteractionAt,
            thread: sess.chatType === 'group' ? 'group' : 'dm',
          });
        }
      }
    } catch {
      /* container hiccup — roster still renders from memberships alone */
    }
    threadCache.set(a.id, { fetchedAt: Date.now(), value });
    return value;
  };

  const roster = async (ownerId: string, wantAll: boolean): Promise<{ users: RosterRow[]; note: string }> => {
    forgetOldThreads();
    const agents = wantAll
      ? store.listAllActiveAgents()
      : store.listAllActiveAgents().filter((a) => a.ownerId === ownerId);

    // Key by Telegram id when linked; an unlinked membership (invited, never
    // messaged) keys by its internal user id so it still shows on the roster.
    const rows = new Map<string, RosterRow>();
    for (const a of agents) {
      for (const m of store.listMemberships(a.id)) {
        if (m.status !== 'active') continue;
        const key = m.channelUserId ? `tg:${m.channelUserId}` : `u:${m.userId}`;
        const row = rows.get(key) ?? {
          ...(m.channelUserId ? { channelUserId: m.channelUserId } : {}),
          memberships: [],
        };
        if (!row.displayName && m.displayName) row.displayName = m.displayName;
        row.memberships.push({
          agentId: a.id, agentName: a.name, agentState: a.state,
          role: m.role, status: m.status, joinedAt: m.joinedAt,
        });
        rows.set(key, row);
      }
    }

    // Bounded concurrency: 30+ simultaneous docker execs measurably slow the
    // box (the pairing sweep learned this at 26), so read six at a time.
    const running = agents.filter((a) => a.state === 'RUNNING' && a.runtimeRef);
    const byAgent = new Map<string, Array<{ tg: string; at: number; thread: string }>>();
    for (let i = 0; i < running.length; i += 6) {
      await Promise.all(running.slice(i, i + 6).map(async (a) => {
        byAgent.set(a.id, await lastExchangesFor(a));
      }));
    }
    for (const a of running) {
      for (const ex of byAgent.get(a.id) ?? []) {
        const row = rows.get(`tg:${ex.tg}`);
        if (!row) continue; // a non-member in some thread (e.g. departed user)
        if (!row.lastSeen || Date.parse(row.lastSeen.at) < ex.at) {
          row.lastSeen = { at: new Date(ex.at).toISOString(), agentName: a.name, thread: ex.thread };
        }
      }
    }

    const users = [...rows.values()].sort((x, y) =>
      Date.parse(y.lastSeen?.at ?? '1970') - Date.parse(x.lastSeen?.at ?? '1970'));
    return { users, note: 'lastSeen is the most recent exchange per agent thread — earlier speakers in a shared thread show their older reading.' };
  };

  return {
    roster,
    addressees: (me, ownsMachine) => {
      if (ownsMachine()) return { accounts: store.listAccounts(me) };
      const hostOwner = store.listHosts(me).find((h) => h.kind === 'local')?.ownerId;
      return { accounts: store.listRelatedAccounts(me, hostOwner ? [hostOwner] : []) };
    },
  };
}
