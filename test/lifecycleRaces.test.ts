/**
 * Overlapping lifecycle operations on one agent (#10). Start and Stop hold
 * the same exclusive per-agent lock as Archive, Rebuild and Move, and judge
 * the agent again once they hold it. Without that, an Archive that arrived
 * while a Start's docker call was in flight finished underneath it: the bot
 * went back to the pool, the record said ARCHIVED, and then the Start
 * brought the container up — still holding the released bot's token.
 *
 * The invariant every test here checks at the end: never ARCHIVED with a
 * running runtime, never a released bot with a running container.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearBusy } from '../src/orchestrator/busy.js';
import { resetHibernateState, wakeAgent } from '../src/orchestrator/hibernate.js';
import type { MockProvider } from '../src/providers/mockProvider.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

/** Hold the provider's next call to `method` until the test lets it go. */
function hold(provider: MockProvider, method: 'start' | 'stop') {
  const real = provider[method].bind(provider);
  let entered!: () => void;
  let release!: () => void;
  const enteredP = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let once = true;
  provider[method] = async (ref: string) => {
    if (once) {
      once = false;
      entered();
      await gate;
    }
    return real(ref);
  };
  return { entered: enteredP, release };
}

async function stoppedWorld(): Promise<{ w: World; id: string; ref: string; released: string[] }> {
  const w = await makeWorld();
  const id = await seedRunningAgent(w, { accountId: 'pantrybot' });
  const ref = w.store.getAgent(id)!.runtimeRef!;
  await w.provider.stop(ref);
  w.store.setAgentState(id, 'STOPPED');
  const released: string[] = [];
  w.channel.release = async (acct: string) => { released.push(acct); };
  return { w, id, ref, released };
}

/** The invariant: a released bot or an archived record means a stopped runtime. */
async function expectConsistent(w: World, id: string, ref: string, released: string[]) {
  const a = w.store.getAgent(id)!;
  const phase = (await w.provider.status(ref)).phase;
  if (a.state === 'ARCHIVED') expect(phase).not.toBe('running');
  if (released.length || !w.store.getChannelForAgent(id)) expect(phase).not.toBe('running');
  if (phase === 'running') expect(a.state).toBe('RUNNING');
}

afterEach(() => { clearBusy('a1'); resetHibernateState(); });

describe('Start holds the lifecycle lock (#10)', () => {
  it('an Archive during a Start is refused as busy; the agent ends RUNNING with its bot', async () => {
    const { w, id, ref, released } = await stoppedWorld();
    const start = hold(w.provider, 'start');
    const pending = w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });
    await start.entered;

    const archive = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/archive`, headers: as(), payload: {} });
    expect(archive.statusCode).toBe(409);
    expect(archive.json().error).toMatch(/already running/i);

    start.release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('RUNNING');
    expect((await w.provider.status(ref)).phase).toBe('running');
    expect(released).toEqual([]);
    expect(w.store.getChannelForAgent(id)?.accountId).toBe('pantrybot');
    await expectConsistent(w, id, ref, released);

    // Once the start is done, the archive goes through and stops it first.
    const again = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/archive`, headers: as(), payload: {} });
    expect(again.statusCode).toBe(200);
    expect(w.store.getAgent(id)!.state).toBe('ARCHIVED');
    expect((await w.provider.status(ref)).phase).toBe('stopped');
    expect(released).toEqual(['pantrybot']);
    await expectConsistent(w, id, ref, released);
  });

  it('a Stop during a Start is refused; the start finishes cleanly', async () => {
    const { w, id, ref, released } = await stoppedWorld();
    const start = hold(w.provider, 'start');
    const pending = w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });
    await start.entered;

    const stop = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: as() });
    expect(stop.statusCode).toBe(409);
    // A second Start is refused too, not run twice.
    const second = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already running/i);

    start.release();
    expect((await pending).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    expect((await w.provider.status(ref)).phase).toBe('running');
    await expectConsistent(w, id, ref, released);
  });

  it('a Start during an Archive is refused; nothing is started under it', async () => {
    const { w, id, ref, released } = await stoppedWorld();
    // Archive holds the lock and is mid-stop when the Start arrives.
    const stop = hold(w.provider, 'stop');
    const archiving = w.f.inject({ method: 'POST', url: `/v1/agents/${id}/archive`, headers: as(), payload: {} });
    await stop.entered;
    const start = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });
    expect(start.statusCode).toBe(409);
    stop.release();
    expect((await archiving).statusCode).toBe(200);
    expect(w.store.getAgent(id)!.state).toBe('ARCHIVED');
    expect((await w.provider.status(ref)).phase).toBe('stopped');
    await expectConsistent(w, id, ref, released);
  });
});

describe('Stop holds the lifecycle lock (#10)', () => {
  it('an Archive or a Start during a Stop is refused; the agent ends STOPPED', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { accountId: 'pantrybot' });
    const ref = w.store.getAgent(id)!.runtimeRef!;
    const released: string[] = [];
    w.channel.release = async (acct: string) => { released.push(acct); };
    const stop = hold(w.provider, 'stop');
    const pending = w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: as() });
    await stop.entered;

    const archive = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/archive`, headers: as(), payload: {} });
    expect(archive.statusCode).toBe(409);
    expect(archive.json().error).toMatch(/already running/i);
    const start = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });
    expect(start.statusCode).toBe(409);

    stop.release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('STOPPED');
    expect((await w.provider.status(ref)).phase).toBe('stopped');
    expect(released).toEqual([]);
    await expectConsistent(w, id, ref, released);
  });
});

describe('Wake holds the lifecycle lock (#10)', () => {
  it('an Archive during a wake is refused; the agent ends RUNNING with its bot', async () => {
    const { w, id, ref, released } = await stoppedWorld();
    w.store.setHibernated(id, new Date().toISOString(), 0);
    const start = hold(w.provider, 'start');
    const pending = w.f.inject({ method: 'POST', url: `/v1/agents/${id}/wake`, headers: as() });
    await start.entered;

    const archive = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/archive`, headers: as(), payload: {} });
    expect(archive.statusCode).toBe(409);

    start.release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('RUNNING');
    expect((await w.provider.status(ref)).phase).toBe('running');
    expect(released).toEqual([]);
    await expectConsistent(w, id, ref, released);
  });

  it('a wake that finds the agent archived once it holds the lock starts nothing', async () => {
    const { w, id, ref, released } = await stoppedWorld();
    w.store.setHibernated(id, new Date().toISOString(), 0);
    // What a wake poll or a console open read a moment before the archive.
    const stale = w.store.getAgent(id)!;
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/archive`, headers: as(), payload: {} })).statusCode).toBe(200);
    const deps = {
      store: w.store, secrets: w.secrets, providerFor: () => w.provider,
      lastActiveFor: async () => undefined, ownCrons: async () => [],
      isBusy: () => false, log: () => () => {},
    };
    const out = await wakeAgent(deps, stale, 'a message');
    expect(out.state).toBe('ARCHIVED');
    expect((await w.provider.status(ref)).phase).toBe('stopped');
    await expectConsistent(w, id, ref, released);
  });
});
