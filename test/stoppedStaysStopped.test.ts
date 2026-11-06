import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { wakeAgent, type HibernateDeps } from '../src/orchestrator/hibernate.js';
import { machineTz, monthKey } from '../src/orchestrator/budgets.js';

/**
 * HB-0411, HB-0420, HB-0441. A rebuild ends RUNNING, so a change that rebuilds
 * must not reach a stopped or sleeping agent: it would come up behind its
 * owner's back, answer on its chat apps and spend on its source. It keeps the
 * change for its next start, which is a rebuild.
 */

const OWNER = 'owner-a';
const OTHER = 'owner-b';
const H = { 'x-hatchabot-owner': OWNER };

let worldNo = 0;
async function makeWorld() {
  // Ids unique per world: the busy flag is process-wide.
  const tag = ++worldNo;
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  for (const [id, ownerId] of [['p1', OWNER], ['p2', OWNER]] as const) {
    store.insertAIProfile({ id, ownerId, name: id, vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: `ai/${id}`, shared: true, createdAt: 'now' } as never);
  }
  const provider = new MockProvider();
  const provision = vi.spyOn(provider, 'provision');
  const secrets = { put: async () => {}, get: async (_ref: string) => 'x', delete: async () => {} };
  const channel = {
    kind: 'telegram',
    pool: { owns: () => true, addToPool: async () => {} },
    provision: async () => ({ accountId: `bot${tag}`, secretRef: `pool/bot${tag}`, deepLink: `https://t.me/bot${tag}` }),
    release: async () => {},
  };
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel } as never);
  const agent = async (name: string, state: 'RUNNING' | 'STOPPED', ownerId = OWNER) => {
    const id = `${name}-${tag}`;
    store.insertAgent({
      id, ownerId, name, slug: id, state, aiProfileId: 'p1', hostId: 'h1', runtimeRef: `mock://${id}`,
      persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now',
    } as never);
    await provider.provision({ agentId: id, slug: id, workspace: { configPatch: {} } } as never);
    if (state === 'RUNNING') await provider.start(`mock://${id}`);
    provision.mockClear();
    return id;
  };
  const settled = async (id: string) => {
    await vi.waitFor(() => {
      const op = store.listOperations([id], 1).find((o) => o.kind === 'rebuild');
      expect(op && ['queued', 'running'].includes(op.status)).toBeFalsy();
      expect(store.getAgent(id)!.state).not.toBe('REBUILDING');
    }, { timeout: 4000, interval: 20 });
  };
  return { store, secrets, provider, provision, f, agent, settled };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

/** Nothing queued may bring it up later: long enough for a queued rebuild to take its turn. */
const stillDown = async (w: World, id: string) => {
  await new Promise((r) => setTimeout(r, 60));
  expect(w.store.getAgent(id)!.state).toBe('STOPPED');
  expect(w.provision).not.toHaveBeenCalled();
  expect((await w.provider.status(`mock://${id}`)).phase).toBe('stopped');
};

/** Start brings it up on a new container with the change in it, and nothing is owed after. */
const startApplies = async (w: World, id: string) => {
  const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: H, payload: {} });
  expect(r.statusCode).toBe(202);
  expect(r.json().rebuilding).toBe(true);
  await w.settled(id);
  expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  expect(w.provision).toHaveBeenCalled();
  expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
};

afterEach(() => { delete process.env.HATCHABOT_REBUILD_POLICY; });

describe('moving agents to another source (HB-0411)', () => {
  it('Move to source and Move agents here: a stopped agent changes source and stays stopped', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: H, payload: { apply: [id], rebuild: true } });
    expect(r.json()).toMatchObject({ switched: 1, rebuilding: 0, atNextStart: 1 });
    expect(w.store.getAgent(id)!.aiProfileId).toBe('p2');
    await stillDown(w, id);
    await startApplies(w, id);
    expect(w.store.getAgent(id)!.appliedProfileId).toBe('p2');
  });

  it('a recovery asked for does not reach a stopped agent, and the answer says so', async () => {
    const w = await makeWorld();
    const down = await w.agent('kitchen', 'STOPPED');
    const up = await w.agent('garden', 'RUNNING');
    const asleep = await w.agent('hallway', 'STOPPED');
    w.store.setHibernated(asleep, new Date().toISOString(), 7);
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: H, payload: { apply: [down, up, asleep], rebuild: true, recoverAfter: true } });
    expect(r.json()).toMatchObject({ switched: 3, rebuilding: 1, atNextStart: 2, notRecovered: 2 });
    await w.settled(up);
  });

  it('a recovery asked for is counted as not run for any agent no rebuild started for (review of HB-0411)', async () => {
    const w = await makeWorld();
    const archived = await w.agent('kitchen', 'STOPPED');
    w.store.setAgentState(archived, 'ARCHIVED');
    const movedAway = await w.agent('garden', 'RUNNING');
    w.store.setAgentMigratedTo(movedAway, 'another Hatchabot'); // RUNNING, and kickRebuild says no
    const up = await w.agent('hallway', 'RUNNING');
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: H, payload: { apply: [archived, movedAway, up], rebuild: true, recoverAfter: true } });
    expect(r.json()).toMatchObject({ switched: 3, rebuilding: 1, atNextStart: 0, notRecovered: 2 });
    await w.settled(up);
  });

  it('with no recovery asked for, nothing is counted as not recovered', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: H, payload: { apply: [id], rebuild: true } });
    expect(r.json()).toMatchObject({ atNextStart: 1, notRecovered: 0 });
  });

  it('a running agent is still rebuilt at once', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'RUNNING');
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: H, payload: { apply: [id], rebuild: true } });
    expect(r.json()).toMatchObject({ switched: 1, rebuilding: 1, atNextStart: 0 });
    await w.settled(id);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    expect(w.provision).toHaveBeenCalled();
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
  });

  it('"rebuild later" owes nothing at its next start: the owner chose a rebuild of their own', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: H, payload: { apply: [id] } });
    expect(r.json()).toMatchObject({ switched: 1, rebuilding: 0, atNextStart: 0 });
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
  });

  it('Migrate all leaves another account\'s stopped agent stopped too', async () => {
    const w = await makeWorld();
    const mine = await w.agent('kitchen', 'RUNNING');
    const theirs = await w.agent('garden', 'STOPPED', OTHER);
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p1/migrate-agents', headers: H, payload: { toProfileId: 'p2', rebuild: true, recoverAfter: true } });
    expect(r.json()).toMatchObject({ switched: 2, rebuilding: 1, atNextStart: 1, notRecovered: 1, otherAccounts: 1 });
    await w.settled(mine);
    expect(w.store.getAgent(mine)!.state).toBe('RUNNING');
    expect(w.store.getAgent(theirs)!.state).toBe('STOPPED');
    expect(w.store.getAgent(theirs)!.aiProfileId).toBe('p2');
    expect(w.store.getAgent(theirs)!.rebuildOnStart).toBeTruthy();
    expect((await w.provider.status(`mock://${theirs}`)).phase).toBe('stopped');
  });

  it('Migrate all counts apart the agents only another account can recover (review of HB-0411)', async () => {
    const w = await makeWorld();
    const mine = await w.agent('kitchen', 'STOPPED');
    const theirs = await w.agent('garden', 'STOPPED', OTHER);
    const theirUp = await w.agent('hallway', 'RUNNING', OTHER);
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p1/migrate-agents', headers: H, payload: { toProfileId: 'p2', rebuild: true, recoverAfter: true } });
    expect(r.json()).toMatchObject({ switched: 3, rebuilding: 1, atNextStart: 2, notRecovered: 2, notRecoveredOthers: 1 });
    await w.settled(theirUp);
    expect(w.store.getAgent(mine)!.state).toBe('STOPPED');
    expect(w.store.getAgent(theirs)!.state).toBe('STOPPED');
    // The button itself: the machine's owner gets 404 for another account's agent.
    const rec = await w.f.inject({ method: 'POST', url: `/v1/agents/${theirUp}/recover-context`, headers: H, payload: {} });
    expect(rec.statusCode).toBe(404);
  });

  it('a sleeping agent stays asleep, and its wake is the rebuild', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    w.store.setHibernated(id, new Date().toISOString(), 7);
    const r = await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: H, payload: { apply: [id], rebuild: true } });
    expect(r.json()).toMatchObject({ rebuilding: 0, atNextStart: 1 });
    await stillDown(w, id);
    expect(w.store.getAgent(id)!.hibernatedAt).toBeTruthy(); // still asleep: a message wakes it
    const woke = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/wake`, headers: H, payload: {} });
    expect(woke.statusCode).toBe(200);
    await w.settled(id);
    const after = w.store.getAgent(id)!;
    expect(after.state).toBe('RUNNING');
    expect(after.hibernatedAt).toBeUndefined();
    expect(after.appliedProfileId).toBe('p2');
    expect(after.rebuildOnStart).toBeUndefined();
    expect(w.provision).toHaveBeenCalled();
  });

  it('a wake with no way to rebuild never starts the old container while a change is owed under the lock', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    w.store.setHibernated(id, new Date().toISOString(), 7);
    w.store.setRebuildOnStart(id, new Date().toISOString());
    const rebuilds: string[] = [];
    const deps = {
      store: w.store, secrets: {}, providerFor: () => w.provider, isBusy: () => false,
      rebuildOnWake: (a: { id: string }) => { rebuilds.push(a.id); },
      log: () => () => {},
    } as unknown as HibernateDeps;
    await wakeAgent(deps, w.store.getAgent(id)!, 'a message');
    expect(rebuilds).toEqual([id]);
    expect((await w.provider.status(`mock://${id}`)).phase).toBe('stopped');
  });

  it('stopped while its rebuild waits its turn: the change is owed, not lost', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'RUNNING');
    process.env.HATCHABOT_REBUILD_CONCURRENCY = '1';
    try {
      // A rebuild that holds the only slot, so the switch's rebuild has to wait.
      const hold = await w.agent('garden', 'RUNNING');
      let free: () => void = () => {};
      w.provision.mockImplementationOnce(async (spec) => { await new Promise<void>((r) => { free = r; }); return { runtimeRef: `mock://${spec.agentId}` }; });
      const f2 = Fastify();
      await registerRoutes(f2, {
        store: w.store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} },
        providers: new Map([['mock', w.provider]]), channel: { kind: 'telegram', pool: { owns: () => true } },
      } as never);
      await f2.inject({ method: 'POST', url: `/v1/agents/${hold}/rebuild`, headers: H, payload: {} });
      await vi.waitFor(() => expect(w.provision).toHaveBeenCalled(), { timeout: 2000, interval: 10 });
      w.provision.mockClear();
      await f2.inject({ method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents', headers: H, payload: { apply: [id], rebuild: true } });
      // The owner stops it before its turn.
      w.store.setAgentState(id, 'STOPPED');
      await w.provider.stop(`mock://${id}`);
      free();
      await w.settled(id);
      await vi.waitFor(() => expect(w.store.listOperations([id], 1)[0]?.status).toBe('rolled_back'), { timeout: 3000, interval: 10 });
      expect(w.store.getAgent(id)!.state).toBe('STOPPED');
      expect(w.store.getAgent(id)!.rebuildOnStart).toBeTruthy();
    } finally {
      delete process.env.HATCHABOT_REBUILD_CONCURRENCY;
    }
  });
});

describe('a setting that needs a new container (HB-0420)', () => {
  it('its browser: saved, says so, stays stopped, and Start applies it', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    const r = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: H, payload: { browser: true } });
    expect(r.statusCode).toBe(200);
    expect(r.json().browserPending).toMatch(/next starts/);
    expect(r.json().rebuildOnStart).toBeTruthy();
    expect(w.store.getAgent(id)!.browser).toBe(true);
    await stillDown(w, id);
    await startApplies(w, id);
  });

  it('a Telegram bot attached while it is stopped: stays stopped, and Start writes the bot in', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/telegram`, headers: H, payload: {} });
    expect(r.statusCode).toBe(202);
    expect(r.json().atNextStart).toBe(true);
    await stillDown(w, id);
    await startApplies(w, id);
  });

  it('a Telegram bot detached while it is stopped: stays stopped, and never boots the old container on the bot it gave back', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    w.store.insertChannel({ id: 'c1', agentId: id, kind: 'telegram', accountId: 'bot-old', secretRef: 'pool/bot-old', deepLink: 'https://t.me/bot-old', createdAt: 'now' } as never);
    const r = await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}/telegram`, headers: H });
    expect(r.statusCode).toBe(202);
    expect(r.json().atNextStart).toBe(true);
    await stillDown(w, id);
    await startApplies(w, id);
  });

  it('a running agent\'s Telegram detach still rebuilds, and comes back up', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'RUNNING');
    w.store.insertChannel({ id: 'c1', agentId: id, kind: 'telegram', accountId: 'bot-old', secretRef: 'pool/bot-old', deepLink: 'https://t.me/bot-old', createdAt: 'now' } as never);
    const r = await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}/telegram`, headers: H });
    expect(r.statusCode).toBe(202);
    expect(r.json().atNextStart).toBeFalsy();
    await w.settled(id);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });

  it('where a Discord bot answers: stays stopped', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    w.store.insertChannel({ id: 'c1', agentId: id, kind: 'discord', accountId: 'd1', secretRef: 'channel/d1', deepLink: 'https://discord.example/d1', createdAt: 'now', settings: {} } as never);
    const r = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}/channels/discord`, headers: H, payload: { rooms: { mode: 'off' } } });
    expect(r.statusCode).toBe(200);
    expect(r.json().atNextStart).toBe(true);
    await stillDown(w, id);
    await startApplies(w, id);
  });

  it('a change the caller follows with a rebuild: `stoppedWaits` keeps a stopped agent stopped', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: H, payload: { stoppedWaits: true } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ rebuilding: false, atNextStart: true });
    await stillDown(w, id);
    await startApplies(w, id);
  });

  it('a Rebuild asked for by name still rebuilds a stopped agent, which then runs', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: H, payload: {} });
    expect(r.statusCode).toBe(202);
    expect(r.json().rebuilding).toBe(true);
    await w.settled(id);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });

  it('the machine\'s "only when I press Rebuild" does not hold back a change the owner made', async () => {
    process.env.HATCHABOT_REBUILD_POLICY = 'manual';
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: H, payload: { browser: true } });
    await startApplies(w, id);
  });

  it('the list says a change is waiting', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: H, payload: { browser: true } });
    const list = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json() as Array<{ id: string; rebuildOnStart?: string }>;
    expect(list.find((a) => a.id === id)!.rebuildOnStart).toBeTruthy();
  });
});

describe('pinning a stopped agent to an image (HB-0441)', () => {
  const images = (w: World) => {
    // What each image is, and what the container was made from: the mock's own spec.
    vi.spyOn(w.provider, 'currentImageInfo').mockImplementation(async (tag?: string) => ({ imageId: tag ? `sha:${tag}` : 'sha:fleet' }) as never);
    vi.spyOn(w.provider, 'info').mockImplementation(async () => ({ imageId: 'sha:fleet', onAgentNetwork: true, containerGen: 99 }) as never);
  };
  // The machine owner's alone: the fixture's local host is OWNER's.
  it('it stays stopped, and Start moves it onto the image', async () => {
    const w = await makeWorld();
    images(w);
    const id = await w.agent('kitchen', 'STOPPED');
    const r = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: H, payload: { image: 'hatchabot/runtime:trial' } });
    expect(r.statusCode).toBe(200);
    expect(r.json().sameImage).toBe(false);
    await stillDown(w, id);
    await startApplies(w, id);
  });

  it('pinned while running with the rebuild put off, then stopped: Start moves it too', async () => {
    const w = await makeWorld();
    images(w);
    const id = await w.agent('kitchen', 'RUNNING');
    await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: H, payload: { image: 'hatchabot/runtime:trial' } });
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
    w.store.setAgentState(id, 'STOPPED');
    await w.provider.stop(`mock://${id}`);
    await startApplies(w, id);
  });

  // HB-0469: the page's Discard trial and Pin & rebuild send no rebuild for a
  // stopped agent; the PATCH alone keeps the change for its next start.
  it('a trial discarded while it is stopped: it stays stopped, and Start moves it back onto the fleet default', async () => {
    const w = await makeWorld();
    images(w);
    vi.spyOn(w.provider, 'info').mockImplementation(async () => ({ imageId: 'sha:hatchabot/runtime:trial', onAgentNetwork: true, containerGen: 99 }) as never);
    const id = await w.agent('kitchen', 'STOPPED');
    w.store.setAgentImage(id, 'hatchabot/runtime:trial');
    const r = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: H, payload: { image: null } });
    expect(r.statusCode).toBe(200);
    expect(r.json().sameImage).toBe(false);
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeTruthy();
    await stillDown(w, id);
    await startApplies(w, id);
  });

  it('Pin & rebuild\'s rebuild, sent for an agent that stopped since the page looked: stays stopped, checkpoint and all', async () => {
    const w = await makeWorld();
    images(w);
    const id = await w.agent('kitchen', 'STOPPED');
    await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: H, payload: { image: 'hatchabot/runtime:trial' } });
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: H, payload: { checkpoint: true, stoppedWaits: true } });
    expect(r.json()).toMatchObject({ rebuilding: false, atNextStart: true });
    await stillDown(w, id);
    await startApplies(w, id);
  });

  it('the image it already runs: a plain start', async () => {
    const w = await makeWorld();
    images(w);
    vi.spyOn(w.provider, 'currentImageInfo').mockImplementation(async () => ({ imageId: 'sha:fleet' }) as never);
    const id = await w.agent('kitchen', 'STOPPED');
    const pin = await w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: H, payload: { image: 'hatchabot/runtime:same' } });
    expect(pin.json().sameImage).toBe(true);
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeUndefined();
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: H, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(w.provision).not.toHaveBeenCalled();
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });
});

describe('a rebuild refused at render time (HB-0419)', () => {
  /** A source whose key is not stored: every render refuses it. */
  const noKey = (w: World, id: string) => {
    w.store.insertAIProfile({ id: 'p9', ownerId: OWNER, name: 'No key yet', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-4-6', secretRef: 'ai/not-stored', createdAt: 'now' } as never);
    w.store.setAgentAIProfile(id, 'p9');
    w.secrets.get = async (ref: string) => { if (ref === 'ai/not-stored') throw new Error('missing secret'); return 'x'; };
  };
  const ended = async (w: World, id: string) => {
    await vi.waitFor(() => expect(['failed', 'succeeded']).toContain(w.store.listOperations([id], 1)[0]?.status), { timeout: 4000, interval: 10 });
    await w.settled(id);
  };

  it('a stopped agent stays STOPPED, its container untouched, with its operation failed', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    noKey(w, id);
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rebuild`, headers: H, payload: {} });
    expect(r.statusCode).toBe(202);
    await ended(w, id);
    const a = w.store.getAgent(id)!;
    expect(a.state).toBe('STOPPED');
    expect(a.stateReason).toBeFalsy();
    expect(w.provision).not.toHaveBeenCalled();
    expect(w.store.listOperations([id], 1)[0]).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/^Not rebuilt: .*It stays stopped as it was\.$/) });
  });

  it('Start with a change waiting: stays STOPPED and still owes it; once the source is fixed, Start applies it', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    noKey(w, id);
    w.store.setRebuildOnStart(id, new Date().toISOString());
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: H, payload: {} });
    expect(r.statusCode).toBe(202);
    await ended(w, id);
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeTruthy();
    expect((await w.provider.status(`mock://${id}`)).phase).toBe('stopped');
    w.secrets.get = async () => 'x';
    await startApplies(w, id);
  });

  it('Start with a required rebuild: refused once, then a plain start works', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    noKey(w, id);
    vi.spyOn(w.provider, 'info').mockImplementation(async () => ({ imageId: 'mock-image', onAgentNetwork: false }) as never);
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: H, payload: {} });
    expect(r.statusCode).toBe(202);
    await ended(w, id);
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    const again = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: H, payload: {} });
    expect(again.statusCode).toBe(200);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    expect(w.provision).not.toHaveBeenCalled();
  });

  it('a wake with a change waiting: refused, it is a stopped agent then, not one every message asks again', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    noKey(w, id);
    w.store.setHibernated(id, new Date().toISOString(), 7);
    w.store.setRebuildOnStart(id, new Date().toISOString());
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/wake`, headers: H, payload: {} });
    expect(r.statusCode).toBe(200);
    await ended(w, id);
    await vi.waitFor(() => expect(w.store.getAgent(id)!.hibernatedAt).toBeUndefined(), { timeout: 2000, interval: 10 });
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeTruthy();
  });
});

describe('a budget pause lifted on an agent that owes a rebuild (HB-0419)', () => {
  const month = () => monthKey(Date.now(), machineTz());
  const paused = (w: World, id: string) => {
    w.store.addBudgetPause(id, month(), id, new Date().toISOString());
    w.store.setRebuildOnStart(id, new Date().toISOString());
  };
  const lift = async (w: World, id: string) => {
    const r = await w.f.inject({ method: 'PUT', url: `/v1/agents/${id}/budget`, headers: H, payload: { usd: null } });
    expect(r.statusCode, r.body).toBe(200);
  };
  const ops = (w: World, id: string) => w.store.listOperations([id], 50).filter((o) => o.kind === 'rebuild');

  it('a rebuild refused at render time: the pause stays open and the agent down, and the next pass does not press it again', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    w.store.insertAIProfile({ id: 'p9', ownerId: OWNER, name: 'No key yet', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-4-6', secretRef: 'ai/not-stored', createdAt: 'now' } as never);
    w.store.setAgentAIProfile(id, 'p9');
    w.secrets.get = async (ref: string) => { if (ref === 'ai/not-stored') throw new Error('missing secret'); return 'x'; };
    paused(w, id);
    await lift(w, id);
    await vi.waitFor(() => expect(ops(w, id)[0]?.status).toBe('failed'), { timeout: 4000, interval: 10 });
    await w.settled(id);
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    expect(w.store.getBudgetPause(id, month())!.resumedAt).toBeUndefined();
    await lift(w, id);
    expect(ops(w, id)).toHaveLength(1);
    expect(w.store.getBudgetPause(id, month())!.resumedAt).toBeUndefined();
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeTruthy();
  });

  it('a rebuild that comes up: closed by the next pass, not when it was queued', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    paused(w, id);
    await lift(w, id);
    expect(w.store.getBudgetPause(id, month())!.resumedAt).toBeUndefined();
    await w.settled(id);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    await lift(w, id);
    expect(w.store.getBudgetPause(id, month())).toMatchObject({ resumedBy: 'started' });
    expect(ops(w, id)).toHaveLength(1);
  });

  it('one that failed building: still not "started"', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    paused(w, id);
    await lift(w, id);
    await w.settled(id);
    w.store.setAgentState(id, 'FAILED');
    await lift(w, id);
    expect(w.store.getBudgetPause(id, month())!.resumedAt).toBeUndefined();
  });

  it('nothing owed: a plain start, closed there and then', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    w.store.addBudgetPause(id, month(), id, new Date().toISOString());
    await lift(w, id);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    expect(w.store.getBudgetPause(id, month())).toMatchObject({ resumedBy: 'budget-raised' });
  });
});

describe('a Stop pressed with a budget pause still open wins (HB-0419)', () => {
  const month = () => monthKey(Date.now(), machineTz());
  const passByBudgetChange = async (w: World, id: string) => {
    const r = await w.f.inject({ method: 'PUT', url: `/v1/agents/${id}/budget`, headers: H, payload: { usd: null } });
    expect(r.statusCode, r.body).toBe(200);
  };
  const pauseOwingARebuild = async (w: World) => {
    const id = await w.agent('kitchen', 'STOPPED');
    w.store.addBudgetPause(id, month(), id, new Date().toISOString());
    w.store.setRebuildOnStart(id, new Date().toISOString());
    await passByBudgetChange(w, id);
    await w.settled(id);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    expect(w.store.getBudgetPause(id, month())!.resumedAt).toBeUndefined();
    return id;
  };

  it('the next pass leaves it stopped and closes the pause', async () => {
    const w = await makeWorld();
    const id = await pauseOwingARebuild(w);
    const stop = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: H, payload: {} });
    expect(stop.statusCode, stop.body).toBe(200);
    expect(w.store.getBudgetPause(id, month())).toMatchObject({ alreadyStopped: true });
    w.provision.mockClear();
    await passByBudgetChange(w, id);
    await stillDown(w, id);
    expect(w.store.getBudgetPause(id, month())).toMatchObject({ resumedBy: 'budget-raised', alreadyStopped: true });
    expect(w.store.listEvents([id], 50).some((e) => e.event === 'budget.resumed')).toBe(false);
  });
  it('and with the month gone by: the pause of last month starts nothing either', async () => {
    const w = await makeWorld();
    const id = await w.agent('garage', 'RUNNING');
    w.store.addBudgetPause(id, '2026-01', id, '2026-01-20T00:00:00.000Z');
    const stop = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: H, payload: {} });
    expect(stop.statusCode, stop.body).toBe(200);
    await passByBudgetChange(w, id);
    await stillDown(w, id);
    expect(w.store.listBudgetPauses({ open: true }).filter((p) => p.agentId === id)).toEqual([]);
  });
  it('a Stop of an agent with no pause open disowns nothing', async () => {
    const w = await makeWorld();
    const id = await w.agent('attic', 'RUNNING');
    const was = new Date().toISOString();
    w.store.addBudgetPause(id, month(), id, was);
    w.store.resumeBudgetPause(id, month(), was, 'started');
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: H, payload: {} })).statusCode).toBe(200);
    expect(w.store.getBudgetPause(id, month())!.alreadyStopped).toBeUndefined();
    expect(w.store.listEvents([id], 50).some((e) => e.event === 'budget.pause_disowned')).toBe(false);
  });
  it('draining its machine is a Stop too', async () => {
    const w = await makeWorld();
    const id = await pauseOwingARebuild(w);
    const drain = await w.f.inject({ method: 'POST', url: '/v1/hosts/h1/drain', headers: H, payload: {} });
    expect(drain.statusCode, drain.body).toBe(200);
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    w.provision.mockClear();
    await passByBudgetChange(w, id);
    await stillDown(w, id);
    expect(w.store.getBudgetPause(id, month())!.resumedAt).toBeDefined();
  });
  it('put to sleep before a pass closed it: it stays asleep', async () => {
    const w = await makeWorld();
    const id = await pauseOwingARebuild(w);
    const sleep = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/hibernate`, headers: H, payload: {} });
    expect(sleep.statusCode, sleep.body).toBe(200);
    expect(w.store.getAgent(id)!.hibernatedAt).toBeDefined();
    w.provision.mockClear();
    await passByBudgetChange(w, id);
    await stillDown(w, id);
    expect(w.store.getBudgetPause(id, month())).toMatchObject({ resumedBy: 'budget-raised' });
  });
  it('a pause the budget made still starts it when lifted', async () => {
    const w = await makeWorld();
    const id = await w.agent('cellar', 'STOPPED');
    w.store.addBudgetPause(id, month(), id, new Date().toISOString());
    await passByBudgetChange(w, id);
    await vi.waitFor(() => expect(w.store.getAgent(id)!.state).toBe('RUNNING'));
    expect(w.store.getBudgetPause(id, month())).toMatchObject({ resumedBy: 'budget-raised' });
  });
});

describe('a change waiting for its next start outlives what is not a new container', () => {
  it('a model staged on a stopped agent\'s volume leaves the rebuild owed: Start does not boot the old container (HB-0411)', async () => {
    const w = await makeWorld();
    const id = await w.agent('kitchen', 'STOPPED');
    w.store.setRebuildOnStart(id, new Date().toISOString());
    const m = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/model`, headers: H, payload: { model: 'm' } });
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json().staged).toBe(true);
    expect(w.store.getAgent(id)!.rebuildOnStart).toBeTruthy();
    await startApplies(w, id);
  });
});
