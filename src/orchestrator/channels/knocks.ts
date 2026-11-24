import type { Agent, Channel } from '../../domain/types.js';
import { CHANNEL_ACCOUNT } from '../../openclaw/configWriter.js';
import { unannounced, type OpsPush } from '../../ops/push.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import { normalizeHandle, type Store } from '../../store/store.js';
import { listPairingRequests } from '../members/claim.js';
import { AdmitError, denyPairing, REQUESTS_UNREAD, setDmPolicy } from '../members/members.js';

/**
 * Knocks (HB-0808): the people asking
 * to talk to an agent on a chat app it has (OpenClaw's pairing requests), and
 * its door. Which knocks are worth the owner's attention (`expectedKnock`);
 * each agent's knocks, read from its container and cached; the sweep that
 * turns strangers away and tells an owner on their phone; and the door put
 * back to `allowlist` once somebody is on the list (`restDoor`).
 *
 * Its state, sorted (HB-0809):
 *  - `knockCache`: a cache (an agent's knocks, half a minute).
 *  - `knockReads`: an in-process lock (the read of an agent's knocks under
 *    way, which callers that miss the cache meanwhile share).
 *  - `announcedPairings`: the knocks already told on an owner's phone, so a
 *    sweep tells each once. Gone after a restart: a knock still waiting is
 *    told once more. Nothing is left wrong; the owner gets a second push.
 *  - `pairingSweeping`: an in-process lock (one sweep at a time).
 *  - the sweep's two timers (the first a minute after start, then every
 *    `sweepEveryMs`). `stop()` ends them.
 *
 * Nothing here knows about HTTP: a route reads its request, asks this, and
 * words the answer.
 */
export interface Knocks {
  /** Is this knock worth the owner's attention? Strangers are never surfaced. */
  expectedKnock(agent: Agent, r: { id: string; kind: Channel['kind']; meta?: { username?: string } }): boolean;
  /**
   * Pending requests on every channel the agent has, each marked with its
   * channel; strangers left out unless asked for. `strict`: a read that did
   * not run throws, instead of answering none (the sweep's, HB-1050).
   */
  pairingRequestsFor(agent: Agent, includeStrangers?: boolean, strict?: boolean): Promise<Knock[]>;
  /**
   * The channel a pending code belongs to: `given` when the caller said, else
   * found by the code. Throws AdmitError (502) when the code is on no app
   * that could be read and an app could not be.
   */
  kindForCode(agent: Agent, given: unknown, code: string | undefined): Promise<Channel['kind'] | undefined>;
  /** The agent's knocks, one answer reused for `knockCacheMs`. */
  cachedKnocks(agent: Agent): Promise<Knock[]>;
  /** An approve, a deny or a new window: the next look reads the container again. */
  forgetKnocks(agentId: string): void;
  /** The door back to `allowlist` on every app with somebody on its list, unless someone is expected or anyone may knock. Best-effort. */
  restDoor(agent: Agent): Promise<void>;
  /** One pass over every live agent with a bot: strangers turned away, the rest told on the owner's phone once. One at a time. */
  sweepPendingPairings(): Promise<void>;
  /** End the sweep's timers: at shutdown. */
  stop(): void;
}

/** A pending pairing request, marked with the channel it came on. */
export type Knock = Awaited<ReturnType<typeof listPairingRequests>>[number] & { kind: Channel['kind'] };

/** What the knocks need from the process they run in. Functions only, so a test hands them fakes. */
export interface KnocksDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline: `trace(agent.id)` gives the function that takes the event and its detail. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** "Someone is knocking", on the owner's phone (ops/push.ts). */
  opsPush: Pick<OpsPush, 'waiting'>;
  /** How long one read of an agent's knocks is reused; 0 = never. */
  knockCacheMs: number;
  /** How often the sweep runs; 0 = never (tests). */
  sweepEveryMs: number;
}

/** The channel a request names: none or 'telegram' is Telegram; Slack and Discord by name; anything else is unknown. */
export const pairingKind = (v: unknown): Channel['kind'] | undefined =>
  v === undefined || v === 'telegram' ? 'telegram' : v === 'slack' || v === 'discord' ? v : undefined;

export function createKnocks(deps: KnocksDeps): Knocks {
  const { store, providerFor, trace, opsPush } = deps;
  /** Pending requests on every channel the agent has, each marked with its channel. */
  /**
   * Is this knock worth the owner's attention?
   *
   * A bot username is findable, so anyone on Telegram can message an agent and
   * land a pairing request. Every one of them used to reach the owner — as a
   * card, and since v2.x as a push to their phone — and the answer was almost
   * always "deny". So an agent now admits only people it is expecting:
   *
   *   - an **invite window** is open (a fresh agent waiting for its owner, or
   *     an invitee who just redeemed a link), or
   *   - the sender is **already known** to this owner — their own linked
   *     Telegram, or an active member of any agent they own, or
   *   - the agent is deliberately set to let **anyone knock**.
   *
   * Everyone else is a stranger: never surfaced, never pushed, and turned away
   * by the sweep below. OpenClaw never answered them either way — this only
   * decides whether the owner is bothered.
   */
  const expectedKnock = (
    agent: Agent,
    r: { id: string; kind: Channel['kind']; meta?: { username?: string } },
  ): boolean => {
    if (agent.allowKnocks === true) return true;
    if (store.isKnownChannelUser(agent.ownerId, r.kind, r.id)) return true;
    const windows = store.pairingWindows(agent.id).filter((win) => win.seat.startsWith(`${r.kind}:`));
    // Someone a join's window passed over (who had written to a sleeping
    // agent's bot before it) is never expected, whatever else is open: shown
    // as the one it waited for, its "Let them in" let a stranger in by the
    // invitee's first name, and nobody on the list yet, or another window on
    // the app (the owner's), still showed them (HB-1221 review). Only a join's
    // window names anyone: an owner's window's ids (a recycled bot's chatters,
    // an imported agent's previous owner, who may be the owner importing it)
    // are only never claimed (claim.ts, excludeKnocks).
    if (windows.some((win) => win.excludeIds?.includes(r.id))) return false;
    // An agent NOBODY can reach yet is in pairing mode by our own rule
    // (provision.ts) — precisely so its first person can get in. Hiding the
    // knock it just answered would leave a fresh agent greeting its owner with
    // a pairing code while the app said nothing and the sweep quietly turned
    // them away. Once one person is admitted the agent goes to `allowlist` and
    // a stranger cannot knock at all.
    if (!store.listAllowedChannelUserIds(agent.id, r.kind).length) return true;
    // Every open window on this knock's app counts (the owner's and an
    // invitee's may both be waiting). A window opened FOR somebody admits
    // only them: an open door is not an open invitation to whoever knocks
    // first. One on another app is not this one's: a Telegram invite let a
    // Discord stranger's knock through (HB-0952).
    return windows.some((win) => !win.expect || normalizeHandle(r.id) === win.expect || normalizeHandle(r.meta?.username) === win.expect);
  };

  /** One app's knocks on an agent. */
  const pairingRequestsOn = async (agent: Agent, ch: Channel, includeStrangers = false, strict = false): Promise<Knock[]> => {
    const acct = ch.kind === 'telegram' ? ch.accountId : CHANNEL_ACCOUNT;
    const out: Knock[] = [];
    for (const r of await listPairingRequests(providerFor(agent.hostId), agent.runtimeRef!, acct, ch.kind, { strict })) {
      const one = { ...r, kind: ch.kind };
      if (includeStrangers || expectedKnock(agent, one)) out.push(one);
    }
    return out;
  };
  const pairingRequestsFor = async (agent: Agent, includeStrangers = false, strict = false): Promise<Knock[]> => {
    const out: Knock[] = [];
    for (const ch of store.listChannelsForAgent(agent.id)) out.push(...await pairingRequestsOn(agent, ch, includeStrangers, strict));
    return out;
  };
  /**
   * The channel a pending code belongs to, when the caller did not say (the
   * Telegram management bot and the management tools only know the code).
   * Codes are random per request, so the match is unambiguous.
   */
  const kindForCode = async (agent: Agent, given: unknown, code: string | undefined): Promise<Channel['kind'] | undefined> => {
    if (given !== undefined) return pairingKind(given);
    // One app: that one (a Discord-only agent answered "Not found" to a plain approve).
    const kinds = store.listChannelsForAgent(agent.id).map((c) => c.kind);
    if (kinds.length === 1) return kinds[0];
    if (!code || !agent.runtimeRef || agent.state !== 'RUNNING' || kinds.length < 2) return 'telegram';
    // Each app read strictly, on its own: a read that failed made a Discord
    // code go to Telegram, where it was "no longer pending" (HB-1050). Found
    // on an app that was read, it is that app; found nowhere with an app
    // unread, the caller is told the read failed (AdmitError, 502).
    let unread = false;
    for (const ch of store.listChannelsForAgent(agent.id)) {
      try { if ((await pairingRequestsOn(agent, ch, false, true)).some((r) => r.code === code)) return ch.kind; }
      catch { unread = true; }
    }
    if (unread) throw new AdmitError(REQUESTS_UNREAD, 502);
    return 'telegram';
  };

  // Every open dashboard asks every running agent for its knocks on each
  // poll; the answer is a file read in the container (a docker exec each).
  // One answer serves every tab for half a minute; approve and deny clear it
  // so the card changes at once. Off in tests, which change the file between reads
  // (routes.ts sets knockCacheMs).
  const knockCache = new Map<string, { at: number; value: Awaited<ReturnType<typeof pairingRequestsFor>> }>();
  // The read under way for each agent, shared by every caller that misses
  // the cache meanwhile: each one ran its own docker reads, so a cold cache
  // and a few open dashboards were a burst of them (HB-0948). Forgotten with
  // the cache, so a read that began before an approve or a deny neither
  // answers a later caller nor becomes the cached answer.
  const knockReads = new Map<string, Promise<Awaited<ReturnType<typeof pairingRequestsFor>>>>();
  const KNOCK_CACHE_MS = deps.knockCacheMs;
  const forgetKnocks = (agentId: string) => { knockCache.delete(agentId); knockReads.delete(agentId); };
  const cachedKnocks = async (agent: Agent) => {
    const hit = knockCache.get(agent.id);
    if (hit && Date.now() - hit.at < KNOCK_CACHE_MS) return hit.value;
    if (KNOCK_CACHE_MS <= 0) return pairingRequestsFor(agent);
    const under = knockReads.get(agent.id);
    if (under) return under;
    const read: Promise<Awaited<ReturnType<typeof pairingRequestsFor>>> = pairingRequestsFor(agent).then(
      (value) => {
        if (knockReads.get(agent.id) === read) { knockCache.set(agent.id, { at: Date.now(), value }); knockReads.delete(agent.id); }
        return value;
      },
      (err: unknown) => {
        if (knockReads.get(agent.id) === read) knockReads.delete(agent.id);
        throw err;
      },
    );
    knockReads.set(agent.id, read);
    return read;
  };

  /**
   * "Someone is knocking" on the owner's phone.
   *
   * The retired Telegram management bot polled /v1/pending and pushed each
   * request; nothing did afterwards, so a join request waited until someone
   * opened the app (2026-09-19). This sweep does it instead — told only to an
   * owner whose management agent has a Telegram or Discord bot. Every live
   * agent with a bot is still read, one at a time: the same read turns
   * strangers away (30th audit), so reading only pushable owners' agents
   * would leave theirs knocking (HB-0058).
   */
  const announcedPairings = new Set<string>();
  // One sweep at a time: a slow pass finishing after a newer one forgot knocks
  // the newer had told, and the next pass pushed them again (night review).
  let pairingSweeping = false;
  const sweepPendingPairings = async (): Promise<void> => {
    if (pairingSweeping) return;
    pairingSweeping = true;
    try { await sweepPendingPairingsOnce(); } finally { pairingSweeping = false; }
  };
  const sweepPendingPairingsOnce = async (): Promise<void> => {
    const live = store
      .listAllActiveAgents()
      .filter((a) => a.state === 'RUNNING' && a.runtimeRef && store.listChannelsForAgent(a.id).length);
    if (!live.length) return;
    // An owner can only be pushed to if their manager has a Telegram or a Discord bot.
    const pushable = new Set(
      store
        .listAllActiveAgents()
        .filter((a) => a.ops && a.state === 'RUNNING' && (store.getChannelForAgent(a.id, 'telegram') || store.getChannelForAgent(a.id, 'discord')))
        .map((a) => a.ownerId),
    );
    const found = new Map<string, { ownerId: string; headline: string }>();
    // Knocks already told, on an app that could not be read this time: kept
    // as told, or one docker hiccup made the next sweep push them again. A
    // read that ran but printed nothing is one too: strictly read, it is not
    // "nobody knocking" (HB-1050). Each app on its own, and only its own
    // knocks kept: one app's store that could not be read dropped the whole
    // agent, so another app's new knock was never told.
    const carried: string[] = [];
    const told = (agentId: string, kind: string, code: string) => `${agentId}:${kind}:${code}`;
    for (const agent of live) {
      const reqs: Knock[] = [];
      for (const ch of store.listChannelsForAgent(agent.id)) {
        try { reqs.push(...await pairingRequestsOn(agent, ch, true, true)); } catch {
          const mine = told(agent.id, ch.kind, '');
          for (const key of announcedPairings) if (key.startsWith(mine)) carried.push(key);
          // an unreachable app is not news
        }
      }
      for (const r of reqs) {
        if (!expectedKnock(agent, r)) {
          // A stranger. Turn it away here rather than leaving it on the volume
          // to be re-read every sweep — and never mention it to anyone. One
          // at a time per agent: a public bot collects dozens of knocks, and
          // each deny is a docker exec (30th audit).
          await denyPairing(
            { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
            { agentId: agent.id, runtimeRef: agent.runtimeRef!, code: r.code, kind: r.kind },
          ).then(
            () => trace(agent.id)('pairing.stranger_turned_away', { kind: r.kind, username: r.meta?.username }),
            () => {},
          );
          continue;
        }
        if (!pushable.has(agent.ownerId)) continue;
        const who = r.meta?.firstName || r.meta?.username || 'Someone';
        found.set(told(agent.id, r.kind, r.code), {
          ownerId: agent.ownerId,
          headline: `🔑 ${who} wants to talk to "${agent.name}"${r.kind === 'telegram' ? '' : ` on ${r.kind}`}.`,
        });
      }
    }
    for (const key of unannounced(announcedPairings, [...found.keys(), ...carried])) {
      const f = found.get(key);
      if (!f) continue;
      void opsPush.waiting(f.ownerId, f.headline, 'Let them in — or turn them away — under "Alerts".');
    }
    // Agents built before the door rested shut are still in `pairing`, where a
    // stranger's DM is answered with a code. Their config is on the volume and
    // the gateway re-reads it, so they can be closed where they stand — no
    // rebuild, which is the thing nobody wants to do to 45 agents. Idempotent:
    // setDmPolicy reports "unchanged" and writes nothing.
    for (const agent of live) await restDoor(agent).catch(() => {});
  };
  const sweepFirst = deps.sweepEveryMs > 0
    ? setTimeout(() => { void sweepPendingPairings().catch(() => {}); }, 60_000).unref()
    : undefined;
  const sweepEvery = deps.sweepEveryMs > 0
    ? setInterval(() => { void sweepPendingPairings().catch(() => {}); }, deps.sweepEveryMs).unref()
    : undefined;

  /**
   * Put an agent's door back to `allowlist` — silence for anyone not on the
   * list — once there IS a list and nothing is waiting to be claimed. Called
   * after every path that adds somebody, so an agent never sits in `pairing`
   * (where a stranger gets "access not configured" and a code) for longer
   * than it has to. Best-effort: a failure leaves today's behaviour.
   */
  const restDoor = async (agent: Agent): Promise<void> => {
    if (agent.allowKnocks || !agent.runtimeRef || agent.state !== 'RUNNING') return;
    // Somebody is expected right now, on an app: that door stays open, and
    // only that one. Any window kept every app's door as it was (HB-0952).
    const expected = new Set(store.pairingWindows(agent.id).map((w) => w.seat.split(':')[0]));
    // Every app the agent is on, not just Telegram: a Discord door left in
    // pairing let anyone sharing a server knock for ever (2026-09-25).
    for (const ch of store.listChannelsForAgent(agent.id)) {
      if (expected.has(ch.kind)) continue;
      const admit = store.listAllowedChannelUserIds(agent.id, ch.kind);
      if (!admit.length) continue; // nobody yet: stay reachable
      await setDmPolicy(
        { store, provider: providerFor(agent.hostId), log: trace(agent.id) },
        { agentId: agent.id, runtimeRef: agent.runtimeRef, kind: ch.kind, accountId: ch.kind === 'telegram' ? ch.accountId : CHANNEL_ACCOUNT, policy: 'allowlist', allowFrom: admit },
      ).catch(() => false);
    }
  };

  return {
    expectedKnock, pairingRequestsFor, kindForCode, cachedKnocks,
    forgetKnocks: (agentId) => { forgetKnocks(agentId); },
    restDoor, sweepPendingPairings,
    stop: () => {
      if (sweepFirst) clearTimeout(sweepFirst);
      if (sweepEvery) clearInterval(sweepEvery);
    },
  };
}
