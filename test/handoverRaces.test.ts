/**
 * Bot handovers and the changes that run beside them (concurrency review,
 * 2026-10-09). A Telegram swap holds the agent's lifecycle lock from the
 * lease to the row swap, parks a pasted bot only once the agent has stopped,
 * changes nothing when it would not stop, and makes sure a rebuild follows
 * even when one was already queued. A Start waits for that rebuild; removing
 * a member and a model change keep off a volume another operation holds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearBusy, markBusy } from '../src/orchestrator/busy.js';
import type { MockProvider } from '../src/providers/mockProvider.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const settle = async (until: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!until() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

/** A world with two spare pool bots and a recorded lease/release. */
async function swapWorld(): Promise<{ w: World; id: string; released: string[] }> {
  const w = await makeWorld(undefined, 2);
  const id = await seedRunningAgent(w, { accountId: 'pastedbot' }); // a pasted bot: not in the pool
  const released: string[] = [];
  await w.secrets.put('pool/sparebot', 'spare-bot-token');
  w.channel.provision = async () => ({ accountId: 'sparebot', secretRef: 'pool/sparebot', deepLink: 'https://t.me/sparebot' });
  w.channel.release = async (acct: string) => { released.push(acct); };
  return { w, id, released };
}

/** Hold the provider's next `method` call for one agent until the test lets it go. */
function hold(provider: MockProvider, method: 'provision' | 'exec', when: (arg: any, argv?: string[]) => boolean) {
  const real = (provider[method] as (...a: unknown[]) => Promise<unknown>).bind(provider);
  let entered!: () => void;
  let release!: () => void;
  const enteredP = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let once = true;
  (provider as any)[method] = async (...args: unknown[]) => {
    if (once && when(args[0], args[1] as string[] | undefined)) {
      once = false;
      entered();
      await gate;
    }
    return real(...args);
  };
  return { entered: enteredP, release };
}

afterEach(() => { for (const id of ['a1', 'b1']) clearBusy(id); });

describe('changing the Telegram bot (2026-10-09)', () => {
  it('an agent that will not stop keeps its bot: nothing parked, nothing released, the row unchanged', async () => {
    const { w, id, released } = await swapWorld();
    w.provider.stop = async () => { throw new Error('docker stop timed out'); };
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/channel/swap`, headers: as(), payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/would not stop/);
    // The pasted bot was not put where another agent could lease it.
    expect(w.channel.pool.entries.map((e: { username: string }) => e.username)).not.toContain('pastedbot');
    expect(released).not.toContain('pastedbot');
    expect(released).toContain('sparebot'); // the new lease went back
    expect(w.store.getChannelForAgent(id, 'telegram')!.accountId).toBe('pastedbot');
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });

  it('a pasted bot is parked only after the agent stopped', async () => {
    const { w, id } = await swapWorld();
    const order: string[] = [];
    const stop = w.provider.stop.bind(w.provider);
    w.provider.stop = async (ref: string) => { order.push('stop'); return stop(ref); };
    const add = w.channel.pool.addToPool;
    w.channel.pool.addToPool = async (...a: [string, string, string | null]) => { order.push(`park ${a[0]}`); return add(...a); };
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/channel/swap`, headers: as(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(order.slice(0, 2)).toEqual(['stop', 'park pastedbot']);
    expect(w.store.getChannelForAgent(id, 'telegram')!.accountId).toBe('sparebot');
  });

  it('holds the lifecycle lock through the farewell: an Archive meanwhile is refused', async () => {
    const { w, id, released } = await swapWorld();
    const farewell = hold(w.provider, 'exec', (_ref, argv) => argv?.[0] === 'message');
    const pending = w.f.inject({ method: 'POST', url: `/v1/agents/${id}/channel/swap`, headers: as(), payload: {} });
    await farewell.entered;
    const archive = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/archive`, headers: as(), payload: {} });
    expect(archive.statusCode).toBe(409);
    farewell.release();
    expect((await pending).statusCode).toBe(200);
    expect(released).toEqual(['pastedbot']);
    expect(w.store.getChannelForAgent(id, 'telegram')!.accountId).toBe('sparebot');
  });
});

describe('a rebuild already queued when the bot changes (2026-10-09)', () => {
  const prev = process.env.HATCHABOT_REBUILD_CONCURRENCY;
  afterEach(() => { if (prev === undefined) delete process.env.HATCHABOT_REBUILD_CONCURRENCY; else process.env.HATCHABOT_REBUILD_CONCURRENCY = prev; });

  /** a1 with a rebuild waiting its turn behind b1's, which is held mid-build. */
  async function queued() {
    process.env.HATCHABOT_REBUILD_CONCURRENCY = '1';
    const { w, id, released } = await swapWorld();
    await seedRunningAgent(w, { id: 'b1', slug: 'other', accountId: 'otherbot' });
    const busyB = hold(w.provider, 'provision', (spec) => spec?.agentId === 'b1');
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/b1/rebuild', headers: as(), payload: {} })).statusCode).toBe(202);
    await busyB.entered;
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: as(), payload: {} })).statusCode).toBe(202);
    return { w, id, released, letB: busyB.release };
  }

  it('a rebuild still follows the swap; the agent comes back up on the new bot', async () => {
    const { w, id, letB } = await queued();
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/channel/swap`, headers: as(), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().rebuilding).toBe(true);
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    letB();
    // The queued one skips itself (it was kicked while the agent ran); the next one rebuilds it.
    await settle(() => w.store.getAgent(id)!.state === 'RUNNING');
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    expect(w.store.getChannelForAgent(id, 'telegram')!.accountId).toBe('sparebot');
  });

  it('a Start while that rebuild waits is refused: the container still holds the old bot', async () => {
    const { w, id, letB } = await queued();
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/channel/swap`, headers: as(), payload: {} })).statusCode).toBe(200);
    const start = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });
    expect(start.statusCode).toBe(409);
    expect(start.json().error).toMatch(/being rebuilt/);
    expect((await w.provider.status(w.store.getAgent(id)!.runtimeRef!)).phase).toBe('stopped');
    letB();
    await settle(() => w.store.getAgent(id)!.state === 'RUNNING');
  });
});

describe('removing a member keeps off a volume another operation holds (2026-10-09)', () => {
  it('is refused while the agent is busy, and they stay a member until it is done', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { members: [{ userId: 'user-guest', displayName: 'Guest', channelUserId: '555' }] });
    markBusy(id);
    const res = await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}/members/user-guest`, headers: as() });
    expect(res.statusCode).toBe(409);
    expect(w.store.getMembership(id, 'user-guest')!.status).toBe('active');
    clearBusy(id);
    expect((await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}/members/user-guest`, headers: as() })).statusCode).toBe(200);
    expect(w.store.getMembership(id, 'user-guest')!.status).toBe('revoked');
  });
});

describe('a model change while the agent is busy is stored only (2026-10-09)', () => {
  it('touches neither the runtime nor what is recorded as applied', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    const sets: string[][] = [];
    const exec = w.provider.exec.bind(w.provider);
    w.provider.exec = (async (ref: string, argv: string[], opts?: { timeoutMs?: number }) => {
      if (argv[0] === 'models') sets.push(argv);
      return exec(ref, argv, opts);
    }) as typeof w.provider.exec;
    const appliedBefore = w.store.getAgent(id)!.appliedModel;
    markBusy(id);
    w.store.setAgentModel(id, 'claude-opus-4-8');
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/model`, headers: as(), payload: { model: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ live: false, staged: false });
    expect(sets).toEqual([]);
    expect(w.store.getAgent(id)!.model ?? null).toBeNull();
    expect(w.store.getAgent(id)!.appliedModel).toBe(appliedBefore);
    clearBusy(id);
    // Not busy: live, as before.
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/model`, headers: as(), payload: { model: null } })).json().live).toBe(true);
    expect(sets.length).toBe(1);
  });
});
