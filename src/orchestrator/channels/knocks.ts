import { randomUUID } from 'node:crypto';
import type { Agent, Channel } from '../../domain/types.js';
import { CHANNEL_ACCOUNT } from '../../openclaw/configWriter.js';
import { unannounced, type OpsPush } from '../../ops/push.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import { normalizeHandle, type Store } from '../../store/store.js';
import { doorAsItIs, listPairingRequests } from '../members/claim.js';
import { AdmitError, ChannelConfigBusyError, denyPairing, REQUESTS_UNREAD, setDmPolicy, writeDmPolicy } from '../members/members.js';
import { busyDone } from '../lifecycle/busy.js';
import { containerUp, type UpWait } from '../lifecycle/afterRestart.js';

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
 *    sweep tells each once, kept while their agent is not read (down, or an
 *    app that could not be read) or their owner's manager cannot be pushed
 *    to, and dropped with a deleted agent. Gone after a restart: a knock
 *    still waiting is told once more. Nothing is left wrong; the owner gets
 *    a second push.
 *  - `pairingSweeping`: an in-process lock (one sweep at a time).
 *  - the sweep's two timers (the first a minute after start, then every
 *    `sweepEveryMs`). `stop()` ends them.
 *  - the waits of doors to open once their agent is free (`openDoorWhenFree`),
 *    each kept in the store meanwhile (the agent's `knock-door` hold, so the
 *    next start opens it: `resumeKnockDoors`, HB-1264), and after a write
 *    that failed. `stop()` ends them, and leaves their holds for the next
 *    start.
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
  /**
   * The door back to `allowlist` on every app with somebody on its list,
   * unless someone is expected or anyone may knock. Best-effort. `waitMs`:
   * an owner's press, each write's longest wait for the agent's turn at its
   * chat apps; 'busy' when one waited that long, refused, and the apps after
   * it were left as they are.
   */
  restDoor(agent: Agent, opts?: { waitMs?: number }): Promise<'busy' | undefined>;
  /** One pass over every live agent with a bot: strangers turned away, the rest told on the owner's phone once. One at a time. */
  sweepPendingPairings(): Promise<void>;
  /**
   * Every app's door open (Allow knocks): the first app whose write failed,
   * and why, or undefined when all took it. An app its running config does
   * not have (`no-account`, `no-config`) has no door to open now, and is not
   * a refusal: its next build writes the door from the setting (HB-0995).
   * Each write looks again once it lands (`doorAsItIs`): turned off during
   * it, the door is put back to rest. `waitMs`, as restDoor's: refused after
   * it, `busy`, and `why` says so in words for the owner.
   */
  openDoor(agent: Agent, opts?: { waitMs?: number }): Promise<{ kind: string; why: string; busy?: true } | undefined>;
  /**
   * "Anyone can knock" turned on while a change holds the agent: its door
   * opened on what runs once it is free (HB-1156), or, turned off or not
   * running then, left to its next build; a refusal said on its timeline.
   * Kept in the store until then (the `knock-door` hold): a restart during
   * the wait left the door shut until the next build (HB-1264). A write that
   * failed keeps it too: the next start tries again.
   */
  openDoorWhenFree(agentId: string): void;
  /**
   * At the start: each door a wait of the last process was to open, opened
   * as it would have been, once the agent's own operations are settled
   * (`settledFor`), it is free, and its container is up (`upWait`: after a
   * restart of the whole machine Docker may not have started it again yet).
   */
  resumeKnockDoors(settledFor?: (agentId: string) => Promise<unknown>, upWait?: UpWait): void;
  /** End the sweep's timers and the doors' waits (their holds stay, for the next start): at shutdown. */
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
  const pairingRequestsOn = async (agent: Agent, ch: Channel, includeStrangers = false, strict = false, needsStore = false): Promise<Knock[]> => {
    const acct = ch.kind === 'telegram' ? ch.accountId : CHANNEL_ACCOUNT;
    const out: Knock[] = [];
    for (const r of await listPairingRequests(providerFor(agent.hostId), agent.runtimeRef!, acct, ch.kind, { strict, needsStore })) {
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
    // unread, the caller is told the read failed (AdmitError, 502). Every
    // request on it, the ones nobody expects too: this only finds the app,
    // and the approve or the deny is the owner's, as it is for an agent on
    // one app. Among the expected only, a stranger's code given by hand was
    // not found: 502 with another app unread, or else sent to Telegram, where
    // it was no longer pending (HB-1371).
    let unread = false;
    for (const ch of store.listChannelsForAgent(agent.id)) {
      try { if ((await pairingRequestsOn(agent, ch, true, true)).some((r) => r.code === code)) return ch.kind; }
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
    // agent, so another app's new knock was never told. One that found no
    // store at all is one too: a migration between its steps, its table
    // gone for a moment at the gateway's start, read as nobody knocking, and
    // the knocks told were told again at the next sweep (HB-1369). Where
    // there is no store yet there is no knock, and nothing to keep.
    const carried: string[] = [];
    const told = (agentId: string, kind: string, code: string) => `${agentId}:${kind}:${code}`;
    // An agent not read at all this time (stopped, rebuilding, asleep, its
    // bot taken off for now) keeps its told knocks too, until it is deleted:
    // only this sweep's live agents' were kept, so one sweep it missed made
    // the next push a knock still waiting again once it was back (HB-1370).
    const swept = new Set(live.map((a) => a.id));
    for (const other of store.listAllActiveAgents()) {
      if (swept.has(other.id)) continue;
      const theirs = `${other.id}:`;
      for (const key of announcedPairings) if (key.startsWith(theirs)) carried.push(key);
    }
    for (const agent of live) {
      const reqs: Knock[] = [];
      for (const ch of store.listChannelsForAgent(agent.id)) {
        try { reqs.push(...await pairingRequestsOn(agent, ch, true, true, true)); } catch {
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
        // Their manager not up to push to for a sweep: a knock told before is
        // kept as told, or it was pushed again once the manager was back, as
        // an agent the sweep missed was (HB-1370 review).
        if (!pushable.has(agent.ownerId)) {
          const key = told(agent.id, r.kind, r.code);
          if (announcedPairings.has(key)) carried.push(key);
          continue;
        }
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
   * than it has to. Best-effort: a failure leaves today's behaviour. Who
   * it admits is read here and again in the write's turn (writeDmPolicy):
   * asked for while a removal scrubbed, it waits for that, and does not put
   * the removed person back (HB-1554).
   */
  const restDoor: Knocks['restDoor'] = async (agent, opts = {}) => {
    if (agent.allowKnocks || !agent.runtimeRef || agent.state !== 'RUNNING') return undefined;
    // Somebody is expected right now, on an app: that door stays open, and
    // only that one. Any window kept every app's door as it was (HB-0952).
    const expected = new Set(store.pairingWindows(agent.id).map((w) => w.seat.split(':')[0]));
    // Every app the agent is on, not just Telegram: a Discord door left in
    // pairing let anyone sharing a server knock for ever (2026-09-25).
    for (const ch of store.listChannelsForAgent(agent.id)) {
      if (expected.has(ch.kind)) continue;
      const admit = store.listAllowedChannelUserIds(agent.id, ch.kind);
      if (!admit.length) continue; // nobody yet: stay reachable
      const doorDeps = { store, provider: providerFor(agent.hostId), log: trace(agent.id) };
      const door = { agentId: agent.id, runtimeRef: agent.runtimeRef, kind: ch.kind, accountId: ch.kind === 'telegram' ? ch.accountId : CHANNEL_ACCOUNT };
      let busy = false;
      // Still to rest, asked in its turn: a rest asked for from what was so
      // then (a sweep's pass, a press's rest left waiting behind a slow
      // change), landing after Allow knocks was turned on again or a window
      // opened on this app, shut that door, and only the look again below
      // opened it again (HB-1554 review).
      let stillToRest = true;
      const toRest = () => (stillToRest = !store.getAgent(agent.id)?.allowKnocks
        && !store.pairingWindows(agent.id).some((w) => w.seat.split(':')[0] === ch.kind));
      await setDmPolicy(doorDeps, { ...door, policy: 'allowlist', allowFrom: admit, waitMs: opts.waitMs, onlyIf: toRest })
        .catch((err: unknown) => { busy = err instanceof ChannelConfigBusyError; return false; });
      if (busy) return 'busy';
      // Open now: whoever opened it wrote it open.
      if (!stillToRest) continue;
      // A window opened, or the agent opened to anyone, during that write,
      // and its write of the door open landed first: shut again by this one,
      // the window stood open with its door shut for its half hour (HB-1521).
      // The door as the store says it is now, as closeKnockWindow does.
      await doorAsItIs(doorDeps, { ...door, hostId: agent.hostId }, 'allowlist', { waitMs: opts.waitMs });
    }
    return undefined;
  };

  const openDoor: Knocks['openDoor'] = async (a, opts = {}) => {
    for (const ch of store.listChannelsForAgent(a.id)) {
      let why = 'the write to its volume failed';
      let busy = false;
      const doorDeps = { store, provider: providerFor(a.hostId), log: trace(a.id) };
      const door = { agentId: a.id, runtimeRef: a.runtimeRef!, kind: ch.kind, accountId: ch.kind === 'telegram' ? ch.accountId : CHANNEL_ACCOUNT };
      const out = await writeDmPolicy(doorDeps, { ...door, policy: 'pairing', waitMs: opts.waitMs })
        .catch((err: unknown) => {
          busy = err instanceof ChannelConfigBusyError;
          why = String(err instanceof Error ? err.message : err).slice(0, 160);
          return 'failed' as const;
        });
      if (busy) return { kind: ch.kind, why, busy: true };
      if (out === 'failed') return { kind: ch.kind, why };
      // Turned off during that write, its rest written and landed first: the
      // door stood in pairing with no window and Allow knocks off until the
      // next sweep. Every write of the door looks again once it lands, as the
      // rests do (HB-1521 review).
      await doorAsItIs(doorDeps, { ...door, hostId: a.hostId }, 'pairing', { waitMs: opts.waitMs });
    }
    return undefined;
  };

  /** Ended by stop(): a wait for an agent to be free stops, its hold kept for the next start. */
  const doorWaits = new AbortController();
  /**
   * The door opened once the agent is free, as the ask `ask` (the hold's
   * value) wanted, and that ask let go of: only it, as a later one is
   * another wait's. At the start (`at`): its own operations waited for
   * first (`before`), then its container (`upWait`). A write that failed,
   * or a container not up, keeps the hold, for the next start: after a
   * restart of the whole machine Docker may not answer yet, and the door
   * stayed shut until the next build (HB-1264 review). An agent whose
   * machine is not known here any more is refused for good: said, and let go.
   */
  const openOnceFree = async (agentId: string, ask: string, at: { before?: Promise<unknown>; upWait?: UpWait } = {}): Promise<void> => {
    await at.before?.catch(() => undefined);
    await busyDone(agentId, doorWaits.signal);
    if (doorWaits.signal.aborted) return; // the process is ending: the next start opens it
    /** Still to open: on, and running. Turned off since, or not up: its next build writes the door from the setting. */
    const wants = (a: Agent | undefined): a is Agent & { runtimeRef: string } => !!a?.allowKnocks && !!a.runtimeRef && a.state === 'RUNNING';
    const now = store.getAgent(agentId);
    if (wants(now)) {
      let provider: RuntimeProvider;
      try { provider = providerFor(now.hostId); } catch (err) {
        failedOpening(agentId)(err);
        store.clearAgentHold(agentId, 'knock-door', ask);
        return;
      }
      if (at.upWait && !(await containerUp(provider, now.runtimeRef, at.upWait))) return;
      // Read again after the looks (half a minute at most): turned off,
      // stopped, or rebuilt or moved meanwhile (its new container's build
      // wrote the door from the setting), there is nothing to open here.
      const after = store.getAgent(agentId);
      if (wants(after) && after.runtimeRef === now.runtimeRef && after.hostId === now.hostId) {
        const refused = await openDoor(after);
        if (refused) { trace(after.id)('agent.knock_door_failed', refused); return; }
      }
    }
    store.clearAgentHold(agentId, 'knock-door', ask);
  };
  const failedOpening = (agentId: string) => (err: unknown) => {
    trace(agentId)('agent.knock_door_failed', { why: String(err instanceof Error ? err.message : err).slice(0, 160) });
  };
  const openDoorWhenFree: Knocks['openDoorWhenFree'] = (agentId) => {
    const ask = randomUUID();
    store.setAgentHold(agentId, 'knock-door', ask);
    void openOnceFree(agentId, ask).catch(failedOpening(agentId));
  };
  const resumeKnockDoors: Knocks['resumeKnockDoors'] = (settledFor, upWait) => {
    for (const { agentId, value } of store.agentHolds('knock-door')) {
      void openOnceFree(agentId, value, { before: settledFor?.(agentId), upWait }).catch(failedOpening(agentId));
    }
  };

  return {
    expectedKnock, pairingRequestsFor, kindForCode, cachedKnocks,
    forgetKnocks: (agentId) => { forgetKnocks(agentId); },
    restDoor, sweepPendingPairings, openDoor, openDoorWhenFree, resumeKnockDoors,
    stop: () => {
      if (sweepFirst) clearTimeout(sweepFirst);
      if (sweepEvery) clearInterval(sweepEvery);
      doorWaits.abort();
    },
  };
}
