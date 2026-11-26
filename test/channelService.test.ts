import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { registerChannelRoutes } from '../src/api/chat/channelRoutes.js';
import { Store } from '../src/store/store.js';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { createChannels, type Channels } from '../src/orchestrator/channels/channels.js';
import { pairingKind } from '../src/orchestrator/channels/knocks.js';
import { claimFirstContact } from '../src/orchestrator/members/claim.js';
import type { ChannelConnector } from '../src/channels/connector.js';
import type { Agent, Channel } from '../src/domain/types.js';

/**
 * The channels service (HB-0808): an agent's chat bots and the people knocking
 * on them, driven as the routes drive it but with no HTTP server (one test, of
 * what a route does around the service, injects a request into it). A real store
 * and secret store on an in-memory database; a runtime provider that answers
 * the pairing list, records every script it is handed, and stops or not as
 * told; fake Slack and Discord connectors that never touch the network.
 * Every token here is made up and shaped like none.
 */
const OWNER = 'user-owner';
const NEIGHBOUR = 'user-neighbour';

/** `kind`: answered only on that app's read; without it, on every app's. */
type Req = { id: string; code: string; kind?: string; meta?: { username?: string; accountId?: string } };

interface World {
  store: Store;
  secrets: LocalSecretStore;
  channels: Channels;
  /** Pairing requests on each runtime, as its container's store holds them. */
  requests: Map<string, Req[]>;
  /** How many times a container's pairing requests were read. */
  pairingReads: number;
  /** A read waits for this before it answers, when set (a slow runner). */
  pairingHold?: Promise<void>;
  /** What a read answers instead, when set (a runtime hiccup: an exit code, no output). */
  pairingBroken?: { code: number; stdout: string };
  /** The same, on one app's read only. */
  pairingBrokenOn?: { kind: string; code: number; stdout: string };
  /** Scripts run on a volume (door policies, denials), in order. */
  volumeScripts: string[];
  /** A script on a volume waits for this before it changes anything, when set (a slow turn-away). */
  volumeHold?: Promise<void>;
  /** What the runtime says after a stop. */
  stopsTo: 'stopped' | 'running';
  /** The connectors' renames and DMs, in order. */
  calls: string[];
  /** What a rename answers. */
  renameAnswer: { ok: boolean; name?: string; note?: string };
  /** A rename waits for this before it answers, when set (a slow platform). */
  renameHold?: Promise<void>;
  pushes: Array<{ ownerId: string; headline: string }>;
  traced: Array<{ agentId?: string; event: string; detail: Record<string, unknown> }>;
  /** Agents a rebuild was owed for (the setup and rebuild queue's oweRebuild, as the service is handed it). */
  owed: string[];
  /** The runtime provider of host h1, as the service is handed it. */
  providerFor(hostId: string): never;
  agent(id: string, opts?: { owner?: string; state?: Agent['state']; ops?: boolean; allowKnocks?: boolean }): Agent;
  channel(agentId: string, kind: Channel['kind'], accountId: string, settings?: Record<string, unknown>): Channel;
  member(agentId: string, userId: string, opts?: { telegram?: string; discord?: string; role?: 'owner' | 'user'; status?: 'active' | 'revoked' }): void;
}

const fakeConnector = (w: () => World, kind: 'slack' | 'discord'): ChannelConnector => ({
  kind,
  label: kind === 'slack' ? 'Slack' : 'Discord',
  fields: [{ key: 'token', label: 'Bot token', pattern: /^fake-/, help: 'A made-up token.' }],
  verify: async () => { throw new Error('not used here'); },
  secretValue: (creds) => creds.token ?? '',
  credsFromSecret: (secret) => ({ token: secret }),
  rename: async (secret, name) => { w().calls.push(`rename ${kind} ${secret} ${name}`); await w().renameHold; return { ...w().renameAnswer }; },
  dm: async (secret, userId, text) => { w().calls.push(`dm ${kind} ${secret} ${userId} ${text}`); return userId !== 'unreachable'; },
});

const stopped: Channels[] = [];
afterEach(() => {
  for (const c of stopped.splice(0)) c.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

let seq = 0;
function world(opts: { knockCacheMs?: number; sweepEveryMs?: number; nameRetryMs?: number; pool?: Record<string, unknown> } = {}): World {
  const db = new Database(':memory:');
  const store = new Store(db);
  const secrets = new LocalSecretStore(db, Buffer.alloc(32, 7));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = {
    store, secrets, requests: new Map(), pairingReads: 0, volumeScripts: [], stopsTo: 'stopped', calls: [],
    renameAnswer: { ok: true }, pushes: [], traced: [], owed: [],
  } as unknown as World;
  const provider = {
    execShell: async (ref: string, script: string) => {
      if (!script.includes('channel_pairing_requests')) return { code: 0, stdout: '', stderr: '' };
      w.pairingReads++;
      const held = w.pairingHold;
      if (w.pairingBroken) return { ...w.pairingBroken, stderr: '' };
      const kind = /credentials\/(\w+)-pairing\.json/.exec(script)?.[1];
      if (w.pairingBrokenOn && w.pairingBrokenOn.kind === kind) return { code: w.pairingBrokenOn.code, stdout: w.pairingBrokenOn.stdout, stderr: '' };
      // What the store holds when the read is made, answered once it may.
      const stdout = JSON.stringify({ version: 1, requests: (w.requests.get(ref) ?? []).filter((r) => !r.kind || r.kind === kind) });
      await held;
      return { code: 0, stdout, stderr: '' };
    },
    execShellOnVolume: async (ref: string, script: string) => {
      w.volumeScripts.push(script);
      await w.volumeHold;
      const denied = /and code = \?"\)\.run\("\w+", "(\w+)"\)/.exec(script)?.[1];
      if (denied) {
        const before = w.requests.get(ref) ?? [];
        w.requests.set(ref, before.filter((r) => r.code !== denied));
        return { code: 0, stdout: String(before.length - (w.requests.get(ref) ?? []).length), stderr: '' };
      }
      return { code: 0, stdout: 'set', stderr: '' };
    },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    stop: async () => {},
    status: async () => ({ phase: w.stopsTo }),
  };
  w.providerFor = (hostId) => { if (hostId !== 'h1') throw new Error(`no host ${hostId}`); return provider as never; };
  w.channels = createChannels({
    store, secrets,
    providerFor: w.providerFor,
    trace: (agentId) => (event, detail) => { w.traced.push({ agentId: agentId ?? (detail.agentId as string | undefined), event, detail }); },
    channel: { pool: (opts.pool ?? {}) as never },
    connectors: { slack: fakeConnector(() => w, 'slack'), discord: fakeConnector(() => w, 'discord') },
    oweRebuild: (agentId) => { w.owed.push(agentId); },
    nameRetryMs: opts.nameRetryMs ?? 0,
    opsPush: { waiting: async (ownerId, headline) => { w.pushes.push({ ownerId, headline }); return true; } },
    knockCacheMs: opts.knockCacheMs ?? 0,
    sweepEveryMs: opts.sweepEveryMs ?? 0,
  });
  stopped.push(w.channels);
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: o.owner ?? OWNER, name: `Agent ${id}`, slug: id, state: o.state ?? 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `rt-${id}`,
    } as unknown as Agent);
    if (o.ops) store.setAgentOps(id, true);
    if (o.allowKnocks) store.setAllowKnocks(id, true);
    return store.getAgent(id)!;
  };
  w.channel = (agentId, kind, accountId, settings) => {
    const c: Channel = { id: `ch-${++seq}`, agentId, kind, accountId, secretRef: `channel/${agentId}/${kind}`, deepLink: `https://example.invalid/${accountId}`, createdAt: 'now', ...(settings ? { settings } : {}) };
    store.insertChannel(c);
    return store.getChannelForAgent(agentId, kind)!;
  };
  w.member = (agentId, userId, o = {}) => {
    store.insertMembership({ id: `m-${++seq}`, agentId, userId, role: o.role ?? 'user', displayName: userId, status: 'active', joinedAt: 'now' } as never);
    if (o.telegram) store.bindMembershipChannelUser(agentId, userId, o.telegram);
    if (o.discord) store.bindMemberIdentity(agentId, userId, 'discord', o.discord);
    if (o.status === 'revoked') store.revokeMembership(agentId, userId);
  };
  return w;
}

describe('the chat bots', () => {
  it('has a connector for Slack and Discord only, the injected ones, Slack first', () => {
    const w = world();
    const { connectorFor, connectorList } = w.channels.bots;
    expect(connectorFor('slack')?.label).toBe('Slack');
    expect(connectorFor('discord')?.label).toBe('Discord');
    expect(connectorFor('telegram')).toBeUndefined();
    expect(connectorFor('irc')).toBeUndefined();
    expect(connectorList().map((c) => c.kind)).toEqual(['slack', 'discord']);
  });

  it('takes a parked bot of the caller\'s or the house\'s, never another person\'s, another app\'s or one kept for an archived agent', () => {
    const w = world();
    const row = (applicationId: string, ownerId: string | null, extra: Record<string, unknown> = {}) => w.store.upsertDiscordBot({
      applicationId, secretRef: `pool/${applicationId}`, ownerId, servers: [], warnings: [], addedAt: `2026-11-0${++seq % 9 + 1}`, kind: 'discord', ...extra,
    });
    row('kept', OWNER, { archivedFor: 'gone-agent', addedAt: '2026-11-01' });
    row('theirs', NEIGHBOUR, { addedAt: '2026-11-02' });
    row('house', null, { addedAt: '2026-11-03' });
    row('mine', OWNER, { addedAt: '2026-11-04' });
    row('slacky', OWNER, { kind: 'slack', addedAt: '2026-11-05' });
    const { parkedBotToTake } = w.channels.bots;
    expect(parkedBotToTake(OWNER, 'first')?.applicationId).toBe('house'); // the oldest of the caller's and the house's, not the kept one
    expect(parkedBotToTake(OWNER, 'mine')?.applicationId).toBe('mine');
    expect(parkedBotToTake(OWNER, 'house')?.applicationId).toBe('house');
    expect(parkedBotToTake(OWNER, 'theirs')).toBeUndefined();
    expect(parkedBotToTake(OWNER, 'slacky')).toBeUndefined(); // a Slack app is not a Discord bot
    expect(parkedBotToTake(OWNER, 'slacky', 'slack')?.applicationId).toBe('slacky');
    expect(parkedBotToTake(OWNER, 'nobody')).toBeUndefined();
  });

  it('caches a Telegram bot\'s display name, forgets it on a rename, and keeps the last one when Telegram cannot be asked', async () => {
    const w = world();
    await w.secrets.put('channel/a1/telegram', 'made-up-telegram-token');
    let answer: unknown = { ok: true, result: { first_name: 'First name' } };
    const fetches: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetches.push(url);
      if (answer instanceof Error) throw answer;
      return { json: async () => answer };
    });
    const { botDisplayNameFor, forgetBotName, rememberBotName } = w.channels.bots;
    expect(await botDisplayNameFor('a1', 'channel/a1/telegram')).toBe('First name');
    answer = { ok: true, result: { first_name: 'Second name' } };
    expect(await botDisplayNameFor('a1', 'channel/a1/telegram')).toBe('First name'); // ten minutes
    expect(fetches).toHaveLength(1);
    forgetBotName('a1');
    expect(await botDisplayNameFor('a1', 'channel/a1/telegram')).toBe('Second name');
    rememberBotName('a1', 'Told name', 'channel/a1/telegram');
    expect(await botDisplayNameFor('a1', 'channel/a1/telegram')).toBe('Told name');
    expect(fetches).toHaveLength(2);
    forgetBotName('a1');
    answer = new Error('offline');
    expect(await botDisplayNameFor('a1', 'channel/a1/telegram')).toBeUndefined(); // nothing kept to fall back on
  });

  it('re-checks one agent\'s channels at a time', () => {
    const { startRecheck, endRecheck } = world().channels.bots;
    expect(startRecheck('a1')).toBe(true);
    expect(startRecheck('a1')).toBe(false);
    expect(startRecheck('a2')).toBe(true);
    endRecheck('a1');
    expect(startRecheck('a1')).toBe(true);
  });

  it('DMs each active person linked on the app, or the ids given, and counts those that went', async () => {
    const w = world();
    const a = w.agent('a1');
    await w.secrets.put('channel/a1/discord', 'fake-discord-secret');
    w.member('a1', OWNER, { role: 'owner', discord: '100000000000000001' });
    w.member('a1', 'user-guest', { discord: 'unreachable' });
    w.member('a1', 'user-gone', { discord: '100000000000000003', status: 'revoked' });
    w.member('a1', 'user-telegram-only', { telegram: '9001' });
    const { dmChannelPeople } = w.channels.bots;
    expect(await dmChannelPeople(a, 'discord', 'channel/a1/discord', 'bye')).toBe(1);
    expect([...w.calls].sort()).toEqual(['dm discord fake-discord-secret 100000000000000001 bye', 'dm discord fake-discord-secret unreachable bye']);
    w.calls.length = 0;
    expect(await dmChannelPeople(a, 'discord', 'channel/a1/discord', 'moved', ['100000000000000009'])).toBe(1);
    expect(w.calls).toEqual(['dm discord fake-discord-secret 100000000000000009 moved']);
    expect(await dmChannelPeople(a, 'telegram', 'channel/a1/discord', 'no dm on telegram here')).toBe(0);
    expect(await dmChannelPeople(a, 'discord', 'channel/none/discord', 'no token')).toBe(0);
  });

  it('stops an agent before its bot is handed on, and says so when it would not stop', async () => {
    const w = world();
    const a = w.agent('a1');
    expect(await w.channels.bots.stopForBotHandover(a)).toBe(true);
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    // Stopped for a handover, its rebuild is owed from that moment, before its bot goes anywhere (HB-0830).
    expect(w.owed).toEqual(['a1']);
    const b = w.agent('a2');
    w.stopsTo = 'running';
    expect(await w.channels.bots.stopForBotHandover(b)).toBe(false);
    expect(w.store.getAgent('a2')!.state).toBe('RUNNING');
    expect(w.owed).toEqual(['a1']); // not stopped: its bot stays its own, and nothing is owed
    expect(w.traced.some((t) => t.agentId === 'a2' && t.event === 'channel.stop_failed')).toBe(true);
  });

  it('a Discord rename refused for the hour is kept, retried when its time comes, and no longer pending once done', async () => {
    const w = world();
    const a = w.agent('a1');
    await w.secrets.put('channel/a1/discord', 'fake-discord-secret');
    const chan = w.channel('a1', 'discord', '200000000000000001', { servers: [{ id: '300000000000000001', name: 'Home' }] });
    w.renameAnswer = { ok: false, note: 'Discord allows two name changes an hour' };
    const { renameChannelBot, retryPendingChannelNames } = w.channels.bots;
    const refused = await renameChannelBot(a, chan, 'New name');
    expect(refused.ok).toBe(false);
    const pending = w.store.getChannelForAgent('a1', 'discord')!.settings!.pendingName as { name: string; retryAt: string };
    expect(pending.name).toBe('New name');
    expect(Date.parse(pending.retryAt)).toBeGreaterThan(Date.now());

    await retryPendingChannelNames(); // not yet
    expect(w.calls).toHaveLength(1);

    w.store.setChannelSettings('a1', 'discord', { ...w.store.getChannelForAgent('a1', 'discord')!.settings, pendingName: { name: 'New name', retryAt: new Date(Date.now() - 1000).toISOString() } });
    w.renameAnswer = { ok: true, name: 'Agent a1' };
    await retryPendingChannelNames(); // the agent's own name now
    expect(w.calls.at(-1)).toBe('rename discord fake-discord-secret Agent a1');
    const st = w.store.getChannelForAgent('a1', 'discord')!.settings!;
    expect(st.pendingName).toBeUndefined();
    expect(st.botName).toBe('Agent a1');
    expect(st.displayName).toBe('@Agent a1 in Home');
  });

  it('a rename that answers late writes its name onto the row as it is now, not over a rooms change made meanwhile (HB-0890)', async () => {
    const w = world();
    const a = w.agent('a1');
    await w.secrets.put('channel/a1/discord', 'fake-discord-secret');
    const chan = w.channel('a1', 'discord', '200000000000000001', { rooms: { mode: 'members' }, servers: [{ id: '300000000000000001', name: 'Home' }] });
    const { renameChannelBot } = w.channels.bots;
    for (const answer of [{ ok: true, name: 'New name' }, { ok: false, note: 'Discord allows two name changes an hour' }]) {
      w.store.setChannelSettings('a1', 'discord', { ...chan.settings, rooms: { mode: 'members' } });
      w.renameAnswer = answer;
      let answerNow!: () => void;
      w.renameHold = new Promise<void>((r) => { answerNow = r; });
      const renaming = renameChannelBot(a, chan, 'New name');
      await vi.waitFor(() => expect(w.calls.at(-1)).toBe('rename discord fake-discord-secret New name'));
      // The owner closes the rooms while the platform is still answering.
      w.store.setChannelSettings('a1', 'discord', { ...w.store.getChannelForAgent('a1', 'discord')!.settings, rooms: { mode: 'off' } });
      answerNow();
      await renaming;
      const st = w.store.getChannelForAgent('a1', 'discord')!.settings!;
      expect(st.rooms).toEqual({ mode: 'off' });
      if (answer.ok) expect(st).toMatchObject({ botName: 'New name', displayName: '@New name in Home' });
      else expect((st.pendingName as { name: string }).name).toBe('New name');
    }
  });

  it('a rename that answers after the agent moved to another bot writes nothing onto the new bot (HB-0890)', async () => {
    const w = world();
    const a = w.agent('a1');
    await w.secrets.put('channel/a1/discord', 'fake-discord-secret');
    const chan = w.channel('a1', 'discord', '200000000000000001', { botName: 'Old bot' });
    let answerNow!: () => void;
    w.renameHold = new Promise<void>((r) => { answerNow = r; });
    w.renameAnswer = { ok: true, name: 'New name' };
    const renaming = w.channels.bots.renameChannelBot(a, chan, 'New name');
    await vi.waitFor(() => expect(w.calls).toHaveLength(1));
    w.store.replaceChannelRow('a1', 'discord', { id: 'ch-swapped', agentId: 'a1', kind: 'discord', accountId: '200000000000000002', secretRef: 'channel/a1/discord/200000000000000002', deepLink: 'https://example.invalid/x', createdAt: 'now', settings: { botName: 'Spare bot' } });
    answerNow();
    const res = await renaming;
    expect(res.ok).toBe(false);
    expect(w.store.getChannelForAgent('a1', 'discord')!.settings).toEqual({ botName: 'Spare bot' });
  });

  it('the names owed are retried on a timer, which stop() ends', async () => {
    vi.useFakeTimers();
    const w = world({ nameRetryMs: 1000 });
    w.agent('a1');
    await w.secrets.put('channel/a1/slack', 'fake-slack-secret');
    w.channel('a1', 'slack', 'T0000001', { pendingName: { name: 'x', retryAt: new Date(Date.now() - 1000).toISOString() } });
    w.renameAnswer = { ok: false, note: 'Slack is busy (503)' }; // stays pending
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.calls).toHaveLength(1);
    w.channels.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.calls).toHaveLength(1);
  });

  it('lists every bot it holds a token for: an agent\'s first, then the pool\'s, then orphaned tokens', async () => {
    const w = world({ pool: {
      list: () => [
        { username: 'AgentBot', secretRef: 'telegram/bot/agentbot', leasedTo: 'a1', ownerId: OWNER },
        { username: 'SpareBot', secretRef: 'telegram/bot/sparebot', ownerId: null },
        { username: 'LentBot', secretRef: 'telegram/bot/lentbot', leasedTo: 'a9', ownerId: NEIGHBOUR },
      ],
    } });
    w.agent('a1');
    w.channel('a1', 'telegram', 'AgentBot');
    await w.secrets.put('telegram/bot/sparebot', 'made-up');
    // A name, not a literal beside "secretRef": gitleaks' generic rule reads that pair as a key (.gitleaks.toml).
    const orphanRef = ['telegram', 'bot', 'orphanbot'].join('/');
    await w.secrets.put(orphanRef, 'made-up');
    const rows = w.channels.bots.botSecretRefs();
    expect([...rows.keys()]).toEqual(['agentbot', 'sparebot', 'lentbot', 'orphanbot']);
    expect(rows.get('agentbot')).toMatchObject({ where: 'agent', secretRef: 'channel/a1/telegram', agentName: 'Agent a1', ownerId: OWNER });
    expect(rows.get('sparebot')).toMatchObject({ where: 'pool-free', ownerId: null });
    expect(rows.get('lentbot')).toMatchObject({ where: 'pool-leased', ownerId: NEIGHBOUR });
    expect(rows.get('orphanbot')).toEqual({ secretRef: orphanRef, where: 'orphan-token' });
  });

  it('asks the pool whom a recycled bot wrote to', () => {
    const w = world({ pool: { priorChatIds: (u: string) => (u === 'UsedBot' ? ['9002'] : []) } });
    expect(w.channels.bots.priorChatIdsOf('UsedBot')).toEqual(['9002']);
    expect(w.channels.bots.priorChatIdsOf('NewBot')).toEqual([]);
    expect(world().channels.bots.priorChatIdsOf('AnyBot')).toEqual([]); // a pool that cannot say
  });
});

describe('knocks', () => {
  it('reads the channel a request names', () => {
    expect(pairingKind(undefined)).toBe('telegram');
    expect(pairingKind('telegram')).toBe('telegram');
    expect(pairingKind('discord')).toBe('discord');
    expect(pairingKind('slack')).toBe('slack');
    expect(pairingKind('irc')).toBeUndefined();
    expect(pairingKind(5)).toBeUndefined();
  });

  it('a knock is expected from someone known, at an agent nobody reaches yet, through an open window for them, or when anyone may knock', () => {
    const w = world();
    const { expectedKnock } = w.channels.knocks;
    const a = w.agent('a1');
    w.agent('a2');
    w.member('a1', OWNER, { role: 'owner', telegram: '9001' });
    const stranger = { id: '9099', kind: 'telegram' as const, meta: { username: 'randomer' } };
    expect(expectedKnock(a, stranger)).toBe(false);
    expect(expectedKnock(w.store.getAgent('a2')!, stranger)).toBe(true); // nobody on a2's list yet
    w.member('a2', 'user-guest', { telegram: '9042' });
    expect(expectedKnock(a, { id: '9042', kind: 'telegram' })).toBe(true); // known from a2
    w.store.openPairingWindow('a1', new Date(Date.now() + 60_000).toISOString(), 'user-invitee', { expect: '@Maria_K' });
    expect(expectedKnock(a, stranger)).toBe(false); // the window is for someone else
    expect(expectedKnock(a, { id: '9077', kind: 'telegram', meta: { username: 'maria_k' } })).toBe(true);
    w.store.setAllowKnocks('a1', true);
    expect(expectedKnock(w.store.getAgent('a1')!, stranger)).toBe(true);
  });

  it('lists each channel\'s requests with its kind, leaves strangers out unless asked, and finds a code\'s channel', async () => {
    const w = world();
    const a = w.agent('a1');
    w.channel('a1', 'telegram', 'HomeBot');
    w.channel('a1', 'discord', '200000000000000001');
    w.member('a1', OWNER, { role: 'owner', telegram: '9001', discord: '100000000000000001' });
    w.requests.set('rt-a1', [{ id: '9099', code: 'STRANGER1' }, { id: '100000000000000001', code: 'OWNERCODE' }]);
    const { pairingRequestsFor, kindForCode } = w.channels.knocks;
    // The fake container answers the same file for both channels; each answer is marked with the channel asked.
    expect((await pairingRequestsFor(a)).map((r) => `${r.kind} ${r.code}`)).toEqual(['discord OWNERCODE']);
    expect((await pairingRequestsFor(a, true)).map((r) => `${r.kind} ${r.code}`)).toEqual(['telegram STRANGER1', 'telegram OWNERCODE', 'discord STRANGER1', 'discord OWNERCODE']);
    expect(await kindForCode(a, 'slack', 'OWNERCODE')).toBe('slack'); // the caller said
    expect(await kindForCode(a, 'irc', 'OWNERCODE')).toBeUndefined();
    expect(await kindForCode(a, undefined, 'OWNERCODE')).toBe('discord'); // two apps: found by its code
    expect(await kindForCode(a, undefined, 'NOSUCH')).toBe('telegram');
    const b = w.agent('a2');
    w.channel('a2', 'slack', 'T0000001');
    expect(await kindForCode(b, undefined, 'ANY')).toBe('slack'); // one app: that one
  });

  it("a code's app is not guessed from a read that failed: found elsewhere it is that app, and otherwise it is said (HB-1050)", async () => {
    const w = world();
    const a = w.agent('a1');
    w.channel('a1', 'telegram', 'HomeBot');
    w.channel('a1', 'discord', '200000000000000001');
    w.member('a1', OWNER, { role: 'owner', telegram: '9001', discord: '100000000000000001' });
    w.requests.set('rt-a1', [{ id: '9001', code: 'TGCODE', kind: 'telegram' }]);
    const { kindForCode } = w.channels.knocks;
    for (const broken of [{ code: 1, stdout: '' }, { code: 0, stdout: JSON.stringify({ version: 1, requests: [], unread: ['db'] }) }]) {
      w.pairingBrokenOn = { kind: 'discord', ...broken };
      expect(await kindForCode(a, undefined, 'TGCODE')).toBe('telegram');
      await expect(kindForCode(a, undefined, 'DSC1')).rejects.toMatchObject({ status: 502, userMessage: "Couldn't read the requests waiting at the agent's door just now — try again in a moment." });
    }
    w.pairingBrokenOn = undefined;
    expect(await kindForCode(a, undefined, 'DSC1')).toBe('telegram'); // read, and nowhere: as before
  });

  it('reuses one read of an agent\'s knocks for knockCacheMs, and reads again once forgotten', async () => {
    const w = world({ knockCacheMs: 60_000 });
    const a = w.agent('a1');
    w.channel('a1', 'telegram', 'HomeBot');
    w.requests.set('rt-a1', [{ id: '9099', code: 'FIRST1' }]);
    const { cachedKnocks, forgetKnocks } = w.channels.knocks;
    expect((await cachedKnocks(a)).map((r) => r.code)).toEqual(['FIRST1']);
    w.requests.set('rt-a1', [{ id: '9098', code: 'SECOND2' }]);
    expect((await cachedKnocks(a)).map((r) => r.code)).toEqual(['FIRST1']);
    forgetKnocks('a1');
    expect((await cachedKnocks(a)).map((r) => r.code)).toEqual(['SECOND2']);

    const fresh = world({ knockCacheMs: 0 });
    const b = fresh.agent('b1');
    fresh.channel('b1', 'telegram', 'OtherBot');
    fresh.requests.set('rt-b1', [{ id: '9099', code: 'FIRST1' }]);
    await fresh.channels.knocks.cachedKnocks(b);
    fresh.requests.set('rt-b1', []);
    expect(await fresh.channels.knocks.cachedKnocks(b)).toEqual([]); // no cache: read every time
  });

  it('callers that miss the cache at once share one read of the container (HB-0948)', async () => {
    const w = world({ knockCacheMs: 60_000 });
    const a = w.agent('a1');
    w.channel('a1', 'telegram', 'HomeBot');
    w.requests.set('rt-a1', [{ id: '9099', code: 'FIRST1' }]);
    const { cachedKnocks } = w.channels.knocks;
    const answers = await Promise.all(Array.from({ length: 8 }, () => cachedKnocks(a)));
    expect(w.pairingReads).toBe(1);
    expect(answers.map((r) => r.map((k) => k.code))).toEqual(Array.from({ length: 8 }, () => ['FIRST1']));
    await cachedKnocks(a);
    expect(w.pairingReads).toBe(1); // and the answer is cached
  });

  it('a read still under way when the knocks are forgotten does not become the cached answer (HB-0948)', async () => {
    const w = world({ knockCacheMs: 60_000 });
    const a = w.agent('a1');
    w.channel('a1', 'telegram', 'HomeBot');
    w.requests.set('rt-a1', [{ id: '9099', code: 'OLD1' }]);
    const { cachedKnocks, forgetKnocks } = w.channels.knocks;
    let letGo!: () => void;
    w.pairingHold = new Promise<void>((r) => { letGo = r; });
    const old = cachedKnocks(a);
    await vi.waitFor(() => expect(w.pairingReads).toBe(1));
    // An approve: the request is gone, and the cache is forgotten.
    w.requests.set('rt-a1', []);
    forgetKnocks('a1');
    w.pairingHold = undefined;
    expect(await cachedKnocks(a)).toEqual([]); // a read of its own, not the one under way
    expect(w.pairingReads).toBe(2);
    letGo();
    expect((await old).map((k) => k.code)).toEqual(['OLD1']);
    expect(await cachedKnocks(a)).toEqual([]); // the late answer was not kept
    expect(w.pairingReads).toBe(2);
  });

  it('a read made while a request is being turned away is not kept as the answer after it (HB-1302)', async () => {
    const w = world({ knockCacheMs: 60_000 });
    const a = w.agent('a1');
    w.channel('a1', 'telegram', 'HomeBot');
    w.requests.set('rt-a1', [{ id: '9099', code: 'TURNAWAY1' }]);
    // The route, over this service: its owner turns the request away.
    const app = Fastify();
    registerChannelRoutes(app, {
      store: w.store, secrets: w.secrets, deps: {}, trace: () => () => {},
      providerFor: w.providerFor,
      ownedAgent: (_req: unknown, id: string) => w.store.getAgent(id), ownsLocalHost: () => true, channels: w.channels,
    } as never);
    let letGo!: () => void;
    w.volumeHold = new Promise<void>((r) => { letGo = r; });
    const deny = app.inject({ method: 'POST', url: '/v1/agents/a1/pairing/deny', payload: { code: 'TURNAWAY1', kind: 'telegram' } });
    await vi.waitFor(() => expect(w.volumeScripts.length).toBe(1));
    // A dashboard polls while the request is still in the store.
    const { cachedKnocks } = w.channels.knocks;
    expect((await cachedKnocks(a)).map((k) => k.code)).toEqual(['TURNAWAY1']);
    letGo();
    expect((await deny).json()).toEqual({ denied: true });
    expect(await cachedKnocks(a)).toEqual([]); // read again, not the half-minute answer from during the turn-away
    await app.close();
  });

  it('rests the door at allowlist on each app with somebody on its list, unless someone is expected or anyone may knock', async () => {
    const w = world();
    const id = `door-${++seq}`;
    const a = w.agent(id);
    w.channel(id, 'telegram', 'DoorBot');
    w.channel(id, 'slack', 'T0000002');
    w.member(id, OWNER, { role: 'owner', telegram: '9001' });
    const { restDoor } = w.channels.knocks;

    w.store.openPairingWindow(id, new Date(Date.now() + 60_000).toISOString(), 'user-invitee');
    await restDoor(a);
    expect(w.volumeScripts).toEqual([]); // somebody is expected
    w.store.closePairingWindow(id);

    await restDoor({ ...a, allowKnocks: true });
    expect(w.volumeScripts).toEqual([]);
    await restDoor({ ...a, state: 'STOPPED' });
    expect(w.volumeScripts).toEqual([]);

    await restDoor(a);
    expect(w.volumeScripts).toHaveLength(1); // Telegram only: nobody is on the Slack list yet
    expect(w.volumeScripts[0]).toContain('"policy":"allowlist"');
    expect(w.volumeScripts[0]).toContain('"channel":"telegram"');
    expect(w.volumeScripts[0]).toContain('9001');
  });

  it('a window opened on one app does not change knocks or the door on another (HB-0952)', async () => {
    const w = world();
    const id = `door-${++seq}`;
    const a = w.agent(id);
    w.channel(id, 'telegram', 'DoorBot');
    w.channel(id, 'discord', '200000000000000002');
    w.member(id, OWNER, { role: 'owner', telegram: '9001', discord: '100000000000000002' });
    // A Telegram invite's knock window, naming nobody.
    w.store.openPairingWindow(id, new Date(Date.now() + 60_000).toISOString(), 'knock:inv1', { kind: 'telegram' });
    const { expectedKnock, restDoor } = w.channels.knocks;
    expect(expectedKnock(a, { id: '9099', kind: 'telegram' })).toBe(true); // the window's own app
    expect(expectedKnock(a, { id: '100000000000000099', kind: 'discord' })).toBe(false); // a stranger on Discord stays one
    await restDoor(a);
    // Discord's door rests; Telegram's stays open for its invitee.
    expect(w.volumeScripts).toHaveLength(1);
    expect(w.volumeScripts[0]).toContain('"channel":"discord"');
    expect(w.volumeScripts[0]).toContain('"policy":"allowlist"');
  });

  it('a knock from someone a window never lets in is not the one it waits for: turned away, not shown; a Reopen written without them lets them knock (HB-1221 review)', async () => {
    const w = world();
    const id = `door-${++seq}`;
    // The owner's management agent has a bot: they can be told of a knock.
    w.agent(`ops-${id}`, { ops: true });
    w.channel(`ops-${id}`, 'telegram', 'OpsBot');
    w.requests.set(`rt-ops-${id}`, []);
    const a = w.agent(id);
    w.channel(id, 'telegram', 'DoorBot');
    w.member(id, OWNER, { role: 'owner', telegram: '9001' });
    // A join's window, open to anyone, passing over who had written to the sleeping bot before it.
    const until = new Date(Date.now() + 60_000).toISOString();
    w.store.openPairingWindow(id, until, 'user-invitee', { kind: 'telegram', excludeIds: ['9077'] });
    expect(w.store.pairingWindows(id)).toMatchObject([{ seat: 'telegram:user-invitee', excludeIds: ['9077'] }]);
    const { expectedKnock, sweepPendingPairings } = w.channels.knocks;
    // Was: shown to the owner as the invitee ("🔑 <the name they chose> wants to talk"), with Let them in.
    expect(expectedKnock(a, { id: '9077', kind: 'telegram', meta: { username: 'made_up_guest' } })).toBe(false);
    expect(expectedKnock(a, { id: '9078', kind: 'telegram' })).toBe(true);
    w.requests.set(`rt-${id}`, [{ id: '9077', code: 'EARLIER1', meta: { username: 'made_up_guest' } }, { id: '9078', code: 'LATER1', meta: { username: 'made_up_guest' } }]);
    await sweepPendingPairings();
    // The one passed over is turned away and never shown; the knock the window may take is told.
    expect(w.requests.get(`rt-${id}`)!.map((r) => r.code)).toEqual(['LATER1']);
    expect(w.pushes).toEqual([{ ownerId: OWNER, headline: `🔑 made_up_guest wants to talk to "Agent ${id}".` }]);
    // The owner's Reopen writes the window again without them: their knock is the one it waits for.
    w.store.openPairingWindow(id, until, 'user-invitee', { kind: 'telegram' });
    expect(w.store.pairingWindows(id)[0]).not.toHaveProperty('excludeIds');
    expect(expectedKnock(a, { id: '9077', kind: 'telegram' })).toBe(true);
  });

  it('a knock a join passed over is never the one waited for, with nobody on the list yet, or another window open to anyone (HB-1221 review)', async () => {
    const w = world();
    const id = `door-${++seq}`;
    w.agent(`ops-${id}`, { ops: true });
    w.channel(`ops-${id}`, 'telegram', 'OpsBot');
    w.requests.set(`rt-ops-${id}`, []);
    const a = w.agent(id);
    w.channel(id, 'telegram', 'DoorBot');
    w.member(id, OWNER, { role: 'owner' }); // the owner uses the web console only: nobody on its Telegram list yet
    const until = new Date(Date.now() + 60_000).toISOString();
    w.store.openPairingWindow(id, until, 'user-invitee', { kind: 'telegram', excludeIds: ['9077'] });
    const { expectedKnock, sweepPendingPairings } = w.channels.knocks;
    // Was: expected, as anyone's knock at an agent nobody reaches yet.
    expect(expectedKnock(a, { id: '9077', kind: 'telegram' })).toBe(false);
    expect(expectedKnock(a, { id: '9078', kind: 'telegram' })).toBe(true);
    w.requests.set(`rt-${id}`, [{ id: '9077', code: 'EARLIER1', meta: { username: 'made_up_guest' } }]);
    await sweepPendingPairings();
    expect(w.requests.get(`rt-${id}`)).toEqual([]);
    expect(w.pushes).toEqual([]);
    // Someone on the list now, and the owner's own window open to anyone on the app beside the join's.
    w.member(id, 'user-kid', { telegram: '9200' });
    w.store.openPairingWindow(id, until, OWNER, { kind: 'telegram' });
    // Was: expected, through the owner's window.
    expect(expectedKnock(a, { id: '9077', kind: 'telegram' })).toBe(false);
    expect(expectedKnock(a, { id: '9078', kind: 'telegram' })).toBe(true);
  });

  it("an owner's window never claims who it passes over, but shows their knock: an imported agent's previous owner may be the owner importing it (HB-1221 review)", async () => {
    const w = world();
    const id = `door-${++seq}`;
    w.agent(`ops-${id}`, { ops: true });
    w.channel(`ops-${id}`, 'telegram', 'OpsBot');
    w.requests.set(`rt-ops-${id}`, []);
    const a = w.agent(id);
    w.channel(id, 'telegram', 'DoorBot');
    w.member(id, OWNER, { role: 'owner' }); // the owner importing it, not on Telegram here yet
    w.member(id, 'user-kid', { telegram: '9200' }); // a member the import brought along
    w.requests.set(`rt-${id}`, [{ id: '9111', code: 'SELF9111', meta: { username: 'made_up_owner' } }]);
    // As an import opens it (watchImportedOwner): the owner's seat, never claiming the file's owner's id.
    let looked!: () => void;
    const firstLook = new Promise<void>((r) => { looked = r; });
    void claimFirstContact(
      { store: w.store, provider: w.providerFor('h1'), sleep: () => { looked(); return new Promise<void>(() => {}); } },
      { agentId: id, runtimeRef: `rt-${id}`, accountId: 'DoorBot', forUserId: OWNER, timeoutMs: 30 * 60_000, excludeIds: ['9111'] },
    );
    await firstLook;
    expect(w.store.getMembership(id, OWNER)?.channelUserId).toBeFalsy(); // passed over by the claim, as before
    expect(w.store.pairingWindows(id)).toHaveLength(1);
    expect(w.store.pairingWindows(id)[0]).not.toHaveProperty('excludeIds');
    const { expectedKnock, sweepPendingPairings } = w.channels.knocks;
    // Was: never the one it waits for, so turned away in silence, from their own agent.
    expect(expectedKnock(a, { id: '9111', kind: 'telegram', meta: { username: 'made_up_owner' } })).toBe(true);
    await sweepPendingPairings();
    expect(w.requests.get(`rt-${id}`)!.map((r) => r.code)).toEqual(['SELF9111']);
    expect(w.pushes).toEqual([{ ownerId: OWNER, headline: `🔑 made_up_owner wants to talk to "Agent ${id}".` }]);
  });

  it('the sweep turns strangers away, tells a reachable owner once, and keeps quiet for an owner it cannot reach', async () => {
    const w = world();
    // The owner's management agent has a Telegram bot: they can be pushed to. The neighbour has none.
    w.agent('ops1', { ops: true });
    w.channel('ops1', 'telegram', 'OpsBot');
    w.agent('a1');
    w.channel('a1', 'telegram', 'HomeBot');
    w.member('a1', OWNER, { role: 'owner', telegram: '9001' });
    w.agent('b1');
    w.channel('b1', 'telegram', 'OtherBot');
    w.member('b1', 'user-guest', { telegram: '9042' });
    w.agent('n1', { owner: NEIGHBOUR });
    w.channel('n1', 'telegram', 'NeighbourBot');
    w.member('n1', NEIGHBOUR, { role: 'owner', telegram: '9003' });
    w.requests.set('rt-a1', [{ id: '9099', code: 'STRANGER1', meta: { username: 'randomer' } }, { id: '9042', code: 'GUEST1' }]);
    w.requests.set('rt-n1', [{ id: '9003', code: 'KNOWN1' }]);
    w.requests.set('rt-ops1', []);

    const { sweepPendingPairings } = w.channels.knocks;
    await sweepPendingPairings();
    expect(w.requests.get('rt-a1')!.map((r) => r.code)).toEqual(['GUEST1']); // the stranger is turned away
    expect(w.traced.some((t) => t.agentId === 'a1' && t.event === 'pairing.stranger_turned_away')).toBe(true);
    expect(w.pushes).toEqual([{ ownerId: OWNER, headline: '🔑 Someone wants to talk to "Agent a1".' }]);
    expect(w.requests.get('rt-n1')!.map((r) => r.code)).toEqual(['KNOWN1']); // known to the neighbour: kept, not pushed

    await sweepPendingPairings();
    expect(w.pushes).toHaveLength(1); // told once
  });

  it('a read that fails or prints nothing keeps what the owner was told: the same knock is not pushed again (HB-1050)', async () => {
    const w = world();
    w.agent('ops1', { ops: true });
    w.channel('ops1', 'telegram', 'OpsBot');
    w.agent('a1');
    w.channel('a1', 'telegram', 'HomeBot');
    w.member('a1', OWNER, { role: 'owner', telegram: '9001' });
    w.member('a1', 'user-guest', { telegram: '9042' });
    w.requests.set('rt-a1', [{ id: '9042', code: 'GUEST1' }]);
    const { sweepPendingPairings, cachedKnocks } = w.channels.knocks;
    await sweepPendingPairings();
    expect(w.pushes).toHaveLength(1);
    for (const broken of [{ code: 1, stdout: '' }, { code: 0, stdout: '' }, { code: 0, stdout: 'Error: container is restarting' }]) {
      w.pairingBroken = broken;
      await sweepPendingPairings();
      w.pairingBroken = undefined;
      await sweepPendingPairings();
    }
    expect(w.pushes).toHaveLength(1); // told once, through every hiccup
    // A knock that really went is forgotten as before, and told again if it comes back.
    w.requests.set('rt-a1', []);
    await sweepPendingPairings();
    w.requests.set('rt-a1', [{ id: '9042', code: 'GUEST1' }]);
    await sweepPendingPairings();
    expect(w.pushes).toHaveLength(2);
    // The app's own reads still answer none for a read that failed, as before.
    w.pairingBroken = { code: 1, stdout: '' };
    expect(await cachedKnocks(w.store.getAgent('a1')!)).toEqual([]);
  });

  it("one app's read that fails is that app's alone: the other app's knocks are told, and only its own are kept as told (HB-1050)", async () => {
    const w = world();
    w.agent('ops1', { ops: true });
    w.channel('ops1', 'telegram', 'OpsBot');
    w.agent('a1', { allowKnocks: true });
    w.channel('a1', 'telegram', 'HomeBot');
    w.channel('a1', 'discord', 'hatchabot');
    w.member('a1', OWNER, { role: 'owner', telegram: '9001' });
    const { sweepPendingPairings } = w.channels.knocks;
    // Discord's knock is told; then its store cannot be read (a 2026.9 agent's
    // leftover discord-pairing.json, say), and a Telegram knock comes.
    w.requests.set('rt-a1', [{ id: '100000000000000042', code: 'DISC1', kind: 'discord' }]);
    await sweepPendingPairings();
    expect(w.pushes).toHaveLength(1);
    w.pairingBrokenOn = { kind: 'discord', code: 0, stdout: JSON.stringify({ version: 1, requests: [], unread: ['file'] }) };
    w.requests.set('rt-a1', [{ id: '9042', code: 'TG1', kind: 'telegram' }]);
    await sweepPendingPairings();
    expect(w.pushes.map((p) => p.headline)).toEqual(['🔑 Someone wants to talk to "Agent a1" on discord.', '🔑 Someone wants to talk to "Agent a1".']);
    // Discord's knock is kept as told while it cannot be read: back, it is not told again.
    w.pairingBrokenOn = undefined;
    w.requests.set('rt-a1', [{ id: '100000000000000042', code: 'DISC1', kind: 'discord' }, { id: '9042', code: 'TG1', kind: 'telegram' }]);
    await sweepPendingPairings();
    expect(w.pushes).toHaveLength(2);
    // Telegram's knock goes while Discord cannot be read: it is not kept as told on Discord's account.
    w.pairingBrokenOn = { kind: 'discord', code: 1, stdout: '' };
    w.requests.set('rt-a1', []);
    await sweepPendingPairings();
    w.requests.set('rt-a1', [{ id: '9042', code: 'TG1', kind: 'telegram' }]);
    await sweepPendingPairings();
    expect(w.pushes).toHaveLength(3);
  });

  it('runs the sweep a minute after it starts and then every sweepEveryMs, until stop()', async () => {
    vi.useFakeTimers();
    const w = world({ sweepEveryMs: 5 * 60_000 });
    w.agent('a1');
    w.channel('a1', 'telegram', 'HomeBot');
    w.member('a1', OWNER, { role: 'owner', telegram: '9001' });
    const stranger = () => w.requests.set('rt-a1', [{ id: '9099', code: 'STRANGER1' }]);
    stranger();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(w.requests.get('rt-a1')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.requests.get('rt-a1')).toEqual([]);
    stranger();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(w.requests.get('rt-a1')).toEqual([]);
    stranger();
    w.channels.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(w.requests.get('rt-a1')).toHaveLength(1);
  });
});
