/**
 * The 2026-10-29 audit of v2.170.1, its agents group: Telegram attach and
 * detach, host removal, renames, deleted agents, live model changes, context
 * caps, idle sleep, rebuild recovery and folder sources (HB-0273, HB-0275,
 * HB-0284, HB-0294, HB-0296, HB-0301, HB-0305, HB-0312, HB-0318, HB-0322,
 * HB-0323, HB-0361). Each test asserts the corrected behaviour; the data is
 * made up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { hibernateAgent, NoLongerSleepy } from '../src/orchestrator/hibernate.js';
import { beginOperation, handleFor, newBootForTests } from '../src/orchestrator/operations.js';
import { recoverOperation, resumeOperations } from '../src/orchestrator/operationsResume.js';
import { moveAgentToHost } from '../src/orchestrator/moveHost.js';
import { exportAgent, importAgent } from '../src/orchestrator/transfer.js';

const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error(`no secret ${r}`); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const deferred = () => { let resolve!: (v?: unknown) => void; const promise = new Promise<unknown>((r) => { resolve = r; }); return { promise, resolve }; };

const dirs: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

type Released = Array<{ accountId: string; agentId?: string }>;
async function world() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'cloud' as never, provider: 'mock', name: 'garage runner', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', models: ['claude-haiku-4-5'], secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'made-up-key');
  const released: Released = [];
  const channel = {
    kind: 'telegram',
    pool: { availableCount: () => 0, owns: (_u: string) => false, list: () => [], available: () => [], ownerOf: () => undefined },
    provision: async (): Promise<{ accountId: string; secretRef: string; deepLink: string }> => { throw new Error('no bot'); },
    release: async (accountId: string, o?: { agentId?: string }) => { released.push({ accountId, agentId: o?.agentId }); },
    syncDisplayName: async () => {},
  };
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel } as never);
  closers.push(() => f.close());
  const agent = async (id: string, extra: Record<string, unknown> = {}) => {
    store.insertAgent({ id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: `mock://${id}`, persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now', ...extra } as never);
    store.insertMembership({ id: `m-${id}`, agentId: id, userId: OWNER, role: 'owner', status: 'active' });
    await provider.provision({ agentId: id, slug: id } as never);
    await provider.start(`mock://${id}`);
    return store.getAgent(id)!;
  };
  return { store, secrets, provider, f, agent, channel, released };
}

describe('Telegram detach stops the runtime whatever the record says (HB-0273)', () => {
  it('a STOPPED record whose container still runs: stopped before its bot is released', async () => {
    const w = await world();
    await w.agent('kitchen', { state: 'STOPPED', webOnly: false });
    w.store.insertChannel({ id: 'ch', agentId: 'kitchen', kind: 'telegram', accountId: 'kitchen_helper_bot', secretRef: 'pool/kitchen', deepLink: 'https://t.me/kitchen_helper_bot', createdAt: 'now' });
    w.channel.pool.owns = () => true;
    let phaseAtRelease = '';
    w.channel.release = async () => { phaseAtRelease = w.provider.runtimes.get('mock://kitchen')!.phase; };
    const r = await w.f.inject({ method: 'DELETE', url: '/v1/agents/kitchen/telegram', headers: H });
    expect(r.statusCode).toBe(202);
    expect(phaseAtRelease).toBe('stopped');
    expect(w.store.getChannelForAgent('kitchen')).toBeUndefined();
  });

  it('a runtime that will not stop keeps its bot, and the detach says so', async () => {
    const w = await world();
    await w.agent('garden', { webOnly: false });
    w.store.insertChannel({ id: 'ch', agentId: 'garden', kind: 'telegram', accountId: 'garden_helper_bot', secretRef: 'pool/garden', deepLink: 'https://t.me/garden_helper_bot', createdAt: 'now' });
    w.provider.stop = async () => { throw new Error('daemon not answering'); };
    const r = await w.f.inject({ method: 'DELETE', url: '/v1/agents/garden/telegram', headers: H });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/did not stop/);
    expect(w.released).toEqual([]);
    expect(w.store.getChannelForAgent('garden')?.accountId).toBe('garden_helper_bot');
  });
});

describe('a host being removed takes no new agent (HB-0275)', () => {
  it('a create aimed at it during its reachability check is refused, and the host goes empty', async () => {
    const w = await world();
    const entered = deferred(), gate = deferred();
    w.provider.reachable = async () => { entered.resolve(); await gate.promise; return false; };
    const del = w.f.inject({ method: 'DELETE', url: '/v1/hosts/h2', headers: H });
    await entered.promise;
    const created = await w.f.inject({ method: 'POST', url: '/v1/agents', headers: H, payload: { name: 'Garage agent', hostId: 'h2', aiProfileId: 'p1', telegram: false } });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toMatch(/being removed/);
    gate.resolve();
    expect((await del).statusCode).toBe(200);
    expect(w.store.getHost('h2')).toBeUndefined();
    expect(w.store.listAgents(OWNER).some((a) => a.hostId === 'h2')).toBe(false);
  });

  it('an agent that reached it another way meanwhile keeps the host', async () => {
    const w = await world();
    const entered = deferred(), gate = deferred();
    w.provider.reachable = async () => { entered.resolve(); await gate.promise; return false; };
    const del = w.f.inject({ method: 'DELETE', url: '/v1/hosts/h2', headers: H });
    await entered.promise;
    await w.agent('workshop', { hostId: 'h2' });
    gate.resolve();
    const r = await del;
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/still run on this host/);
    expect(w.store.getHost('h2')).toBeDefined();
    // The reservation ends with the request: a later delete is judged afresh.
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents', headers: H, payload: { name: 'Shed agent', hostId: 'h2', aiProfileId: 'p1', telegram: false } })).statusCode).toBe(202);
  });

  it('an agent that arrived while the machine was asked keeps its browser there: nothing is removed', async () => {
    const w = await world();
    let n = 0;
    w.provider.daemonId = async () => `made-up-daemon-${n++}`; // the runner and this machine differ
    (w.provider as unknown as { browsers: Map<string, boolean> }).browsers.set('hatchabot-workshop', true);
    const stopped: string[] = [];
    w.provider.stopBrowser = async (c: string) => { stopped.push(c); };
    const entered = deferred(), gate = deferred();
    w.provider.reachable = async () => { entered.resolve(); await gate.promise; return true; };
    const del = w.f.inject({ method: 'DELETE', url: '/v1/hosts/h2', headers: H });
    await entered.promise;
    await w.agent('workshop', { hostId: 'h2' });
    gate.resolve();
    expect((await del).statusCode).toBe(409);
    expect(stopped).toEqual([]);
    expect(w.store.getHost('h2')).toBeDefined();
  });

  it('a move whose target is removed while the daemons are asked is cancelled, and the agent stays put', async () => {
    const w = await world();
    await w.agent('porch');
    const target = new MockProvider();
    const entered = deferred(), gate = deferred();
    target.daemonId = async () => { entered.resolve(); await gate.promise; return 'made-up-runner-daemon'; };
    const move = moveAgentToHost({ store: w.store, secrets: w.secrets, channel: w.channel as never, source: w.provider, target, sleep: async () => {} } as never, 'porch', 'h2');
    await entered.promise;
    w.store.deleteHost('h2');
    gate.resolve();
    await expect(move).rejects.toThrow(/removed meanwhile/);
    expect(w.store.getAgent('porch')?.hostId).toBe('h1');
    expect(w.store.operationsWithStatus(['queued', 'running', 'interrupted', 'held']).filter((o) => o.kind === 'move-host')).toEqual([]);
  });

  it('a move whose runner is removed while the route checks versions is refused as that, not a server error', async () => {
    const w = await world();
    await w.agent('porch');
    const info = w.provider.info.bind(w.provider);
    w.provider.info = async (ref: string) => { w.store.deleteHost('h2'); return info(ref); };
    const r = await w.f.inject({ method: 'POST', url: '/v1/agents/porch/move-host', headers: H, payload: { hostId: 'h2' } });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toMatch(/being removed/);
    expect(w.store.getAgent('porch')?.hostId).toBe('h1');
  });

  it('an import whose machine is removed while its bot token is checked is refused, and nothing lands there', async () => {
    const src = await world();
    await src.agent('pantry', { webOnly: false });
    await src.secrets.put('chan/pantry', 'made-up-bot-secret');
    src.store.insertChannel({ id: 'ch', agentId: 'pantry', kind: 'telegram', accountId: 'pantry_helper_bot', secretRef: 'chan/pantry', deepLink: 'https://t.me/pantry_helper_bot', createdAt: 'now' });
    const { data } = await exportAgent({ store: src.store, secrets: src.secrets, provider: src.provider, channel: src.channel, sleep: async () => {} } as never, 'pantry');
    const dst = await world();
    const deps = { store: dst.store, secrets: dst.secrets, provider: dst.provider, channel: dst.channel, sleep: async () => {} } as never;
    const imported = importAgent(deps, data, {
      ownerId: OWNER, hostId: 'h2', aiProfileId: 'p1',
      // The runner's removal finishes while Telegram is asked.
      verifyToken: async () => { dst.store.deleteHost('h2'); return 'pantry_helper_bot'; },
    });
    await expect(imported).rejects.toThrow(/removed meanwhile/);
    expect(dst.store.listAllActiveAgents().filter((a) => a.slug === 'pantry')).toEqual([]);
  });
});

describe('a Telegram attach finishing on a deleted agent (HB-0296)', () => {
  it('connects nothing, and the bot it found goes back', async () => {
    const w = await world();
    await w.agent('laundry');
    const entered = deferred(), gate = deferred();
    w.channel.provision = async () => {
      entered.resolve(); await gate.promise;
      await w.secrets.put('channel/late', 'made-up-bot-secret');
      return { accountId: 'laundry_helper_bot', secretRef: 'channel/late', deepLink: 'https://t.me/laundry_helper_bot' };
    };
    const add = w.f.inject({ method: 'POST', url: '/v1/agents/laundry/telegram', headers: H, payload: {} });
    await entered.promise;
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/agents/laundry', headers: H })).statusCode).toBeLessThan(300);
    gate.resolve();
    const r = await add;
    expect(r.statusCode).toBe(409);
    expect(w.store.getChannelForAgent('laundry')).toBeUndefined();
    expect(w.secrets.map.has('channel/late')).toBe(false);
    expect(w.released).toContainEqual({ accountId: 'laundry_helper_bot', agentId: 'laundry' });
  });
});

describe('two renames to one name at once (HB-0305)', () => {
  it('one wins and the other is refused', async () => {
    const w = await world();
    await w.agent('one'); await w.agent('two');
    const gate = deferred();
    let calls = 0;
    w.provider.info = (async () => { calls++; await gate.promise; return {}; }) as never;
    (w.provider as unknown as { updateMemory(): Promise<void> }).updateMemory = async () => {};
    const first = w.f.inject({ method: 'PATCH', url: '/v1/agents/one', headers: H, payload: { name: 'Pantry', memoryCap: '2g' } });
    while (calls < 1) await new Promise((r) => setImmediate(r));
    const second = await w.f.inject({ method: 'PATCH', url: '/v1/agents/two', headers: H, payload: { name: 'pantry', memoryCap: '2g' } });
    expect(second.statusCode).toBe(409);
    gate.resolve();
    expect((await first).statusCode).toBe(200);
    expect(w.store.listAgents(OWNER).filter((a) => a.name.toLowerCase() === 'pantry').map((a) => a.id)).toEqual(['one']);
    // Answered, the hold is gone: another name goes through.
    expect((await w.f.inject({ method: 'PATCH', url: '/v1/agents/two', headers: H, payload: { name: 'Cellar' } })).statusCode).toBe(200);
  });

  it('a create with the name a rename is saving is refused until the rename answers', async () => {
    const w = await world();
    await w.agent('one');
    const gate = deferred();
    let calls = 0;
    w.provider.info = (async () => { calls++; await gate.promise; return {}; }) as never;
    (w.provider as unknown as { updateMemory(): Promise<void> }).updateMemory = async () => {};
    const rename = w.f.inject({ method: 'PATCH', url: '/v1/agents/one', headers: H, payload: { name: 'Kitchen', memoryCap: '2g' } });
    while (calls < 1) await new Promise((r) => setImmediate(r));
    const created = await w.f.inject({ method: 'POST', url: '/v1/agents', headers: H, payload: { name: 'kitchen', hostId: 'h1', aiProfileId: 'p1', telegram: false } });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toMatch(/being renamed/);
    gate.resolve();
    expect((await rename).statusCode).toBe(200);
    expect(w.store.listAgents(OWNER).filter((a) => a.name.toLowerCase() === 'kitchen').map((a) => a.id)).toEqual(['one']);
  });
});

describe('a deleted agent takes no new credentials (HB-0322)', () => {
  it('a variable or a repo for it is refused and nothing is stored', async () => {
    const w = await world();
    await w.agent('gone');
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/agents/gone', headers: H })).statusCode).toBeLessThan(300);
    const before = new Set(w.secrets.map.keys());
    const env = await w.f.inject({ method: 'POST', url: '/v1/agents/gone/env', headers: H, payload: { name: 'CUSTOM_SETTING', value: 'made-up-value' } });
    expect(env.statusCode).toBe(409);
    const repo = await w.f.inject({ method: 'POST', url: '/v1/agents/gone/data-sources', headers: H, payload: { kind: 'git', access: 'ro', repoUrl: 'git@example.org:household/recipes.git' } });
    expect(repo.statusCode).toBe(409);
    expect(w.store.listAgentEnv('gone')).toEqual([]);
    expect(w.store.listDataSources('gone')).toEqual([]);
    expect(new Set(w.secrets.map.keys())).toEqual(before);
  });

  it('a variable whose save was under way when the delete landed is taken back', async () => {
    const w = await world();
    await w.agent('late');
    const entered = deferred(), gate = deferred();
    const put = w.secrets.put.bind(w.secrets);
    w.secrets.put = async (r: string, v: string) => { await put(r, v); if (r.startsWith('agent-env/')) { entered.resolve(); await gate.promise; } };
    const add = w.f.inject({ method: 'POST', url: '/v1/agents/late/env', headers: H, payload: { name: 'CUSTOM_SETTING', value: 'made-up-value' } });
    await entered.promise;
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/agents/late', headers: H })).statusCode).toBeLessThan(300);
    gate.resolve();
    expect((await add).statusCode).toBe(409);
    expect(w.store.listAgentEnv('late')).toEqual([]);
    expect([...w.secrets.map.keys()].some((k) => k.startsWith('agent-env/'))).toBe(false);
  });
});

describe('live model changes apply in the order they were asked (HB-0323)', () => {
  it('an older `models set` still running does not end with its model on the runtime', async () => {
    const w = await world();
    await w.agent('model');
    const entered = deferred(), gate = deferred();
    let running = 'anthropic/claude-sonnet-5';
    w.provider.exec = async (_r, a) => {
      if (a[0] === 'models' && a[1] === 'set') { if (a[2]!.includes('haiku')) { entered.resolve(); await gate.promise; } running = a[2]!; }
      return ok();
    };
    const older = w.f.inject({ method: 'POST', url: '/v1/agents/model/model', headers: H, payload: { model: 'claude-haiku-4-5' } });
    await entered.promise;
    const newer = w.f.inject({ method: 'POST', url: '/v1/agents/model/model', headers: H, payload: { model: 'claude-sonnet-5' } });
    await new Promise((r) => setTimeout(r, 20));
    gate.resolve();
    const [a, b] = await Promise.all([older, newer]);
    expect(a.json().live).toBe(true);
    expect(b.json().live).toBe(true);
    expect(w.store.getAgent('model')?.model).toBe('claude-sonnet-5');
    expect(running).toContain('sonnet');
  });
});

describe('context caps (HB-0312, HB-0318)', () => {
  /** A config entry the cap code reads and writes, as openclaw.json holds it. */
  const statefulConfig = (w: Awaited<ReturnType<typeof world>>, hold?: { entered: ReturnType<typeof deferred>; gate: ReturnType<typeof deferred> }) => {
    const cfg: { entry?: unknown } = {};
    let first = true;
    w.provider.execShell = async () => {
      if (hold && first) { first = false; hold.entered.resolve(); await hold.gate.promise; }
      return ok(cfg.entry === undefined ? '' : JSON.stringify(cfg.entry));
    };
    w.provider.exec = async (_r, a) => {
      if (a[0] === 'config' && a[1] === 'set') cfg.entry = JSON.parse(a[3]!);
      if (a[0] === 'config' && a[1] === 'unset') cfg.entry = undefined;
      return ok();
    };
    return cfg;
  };

  it('a cap removed during its first apply is not left in the config (HB-0312)', async () => {
    const w = await world();
    await w.agent('cap');
    const hold = { entered: deferred(), gate: deferred() };
    const cfg = statefulConfig(w, hold);
    const apply = w.f.inject({ method: 'PUT', url: '/v1/agents/cap/context-cap', headers: H, payload: { tokens: 100000 } });
    await hold.entered.promise;
    const clear = w.f.inject({ method: 'PUT', url: '/v1/agents/cap/context-cap', headers: H, payload: { tokens: null } });
    await new Promise((r) => setTimeout(r, 20));
    hold.gate.resolve();
    const [a, c] = await Promise.all([apply, clear]);
    expect(a.statusCode).toBe(200);
    expect(c.json().outcome).toBe('applied');
    expect(JSON.stringify(cfg.entry ?? null)).not.toContain('contextTokens');
    expect(w.store.getContextCap('cap')).toBeUndefined();
  });

  it('a cap changed while stopped is written by the steward once it runs, on the same model (HB-0318)', async () => {
    const w = await world();
    await w.agent('stopped');
    const cfg = statefulConfig(w);
    cfg.entry = { models: [{ id: 'claude-sonnet-5', name: 'Sonnet', contextTokens: 100000 }] };
    await w.provider.stop('mock://stopped');
    w.store.setAgentState('stopped', 'STOPPED');
    w.store.setContextCap('stopped', 100000, '2026-10-01T00:00:00.000Z');
    w.store.markContextCapApplied('stopped', 'anthropic/claude-sonnet-5', '2026-10-01T00:00:00.000Z');
    expect((await w.f.inject({ method: 'PUT', url: '/v1/agents/stopped/context-cap', headers: H, payload: { tokens: 200000 } })).json().outcome).toBe('pending');
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/stopped/start?wait=1', headers: H, payload: {} })).statusCode).toBe(200);
    expect((await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/usage/sample', headers: H, payload: {} })).statusCode).toBe(200);
    expect(JSON.stringify(cfg.entry)).toContain('"contextTokens":200000');
    const cap = w.store.getContextCap('stopped')!;
    expect(cap.appliedAt! >= cap.setAt).toBe(true);
    // Written once: the next pass has nothing to do.
    const writes = () => w.provider.execLog.length;
    const n = writes();
    expect((await w.f.inject({ method: 'POST', url: '/v1/ai-profiles/usage/sample', headers: H, payload: {} })).statusCode).toBe(200);
    expect(writes()).toBe(n);
  });
});

describe('"Never sleep" saved during the idle stop\'s last reads (HB-0294)', () => {
  it('keeps the agent awake', async () => {
    const w = await world();
    const a = await w.agent('sleepy');
    const entered = deferred(), gate = deferred();
    const sleep = hibernateAgent({
      store: w.store, secrets: w.secrets, providerFor: () => w.provider, isBusy: () => false,
      lastActiveFor: async () => undefined,
      ownCrons: async () => { entered.resolve(); await gate.promise; return []; },
      log: () => () => {},
    } as never, a, 'idle', { idle: true });
    await entered.promise;
    expect((await w.f.inject({ method: 'PATCH', url: '/v1/agents/sleepy', headers: H, payload: { hibernate: 'never' } })).statusCode).toBe(200);
    gate.resolve();
    await expect(sleep).rejects.toBeInstanceOf(NoLongerSleepy);
    expect(w.store.getAgent('sleepy')).toMatchObject({ hibernate: 'never', state: 'RUNNING' });
    expect(w.provider.runtimes.get('mock://sleepy')!.phase).toBe('running');
  });
});

describe('a rebuild cut off after its container came up (HB-0301)', () => {
  it('runs its steps after health on recovery: its parked schedules go in', async () => {
    const w = await world();
    await w.agent('resume', { state: 'REBUILDING' });
    w.store.setPendingSchedules('resume', [{ name: 'Daily', message: 'report', everyMs: 3_600_000 }]);
    const op = beginOperation(w.store, 'rebuild', 'resume', {});
    newBootForTests();
    await resumeOperations({ store: w.store, secrets: w.secrets, channel: w.channel as never, providerForHost: () => w.provider, sleep: async () => {} });
    expect(w.store.getAgent('resume')?.state).toBe('RUNNING');
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'succeeded', outcome: expect.stringMatching(/rest of its rebuild ran again/) });
    expect(w.store.getPendingSchedules('resume')).toHaveLength(0);
    expect(w.provider.execLog.some((a) => a[0] === 'cron' && a[1] === 'add')).toBe(true);
  });

  it('"Try again" on one held after a failed recovery settles it: the owner\'s choice holds the busy flag already', async () => {
    const w = await world();
    await w.agent('held', { state: 'REBUILDING' });
    w.store.setPendingSchedules('held', [{ name: 'Daily', message: 'report', everyMs: 3_600_000 }]);
    const op = beginOperation(w.store, 'rebuild', 'held', {});
    // What resumeOne leaves when putting it right threw (a runner that did not answer).
    handleFor(w.store, op.id).hold('Putting it right after a restart failed: no answer', { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' });
    const ctx = { store: w.store, secrets: w.secrets, channel: w.channel as never, providerForHost: () => w.provider, sleep: async () => {} };
    await recoverOperation(ctx, op.id, 'retry');
    expect(w.store.getAgent('held')?.state).toBe('RUNNING');
    expect(w.store.getOperation(op.id)?.status).toBe('succeeded');
    expect(w.store.getPendingSchedules('held')).toHaveLength(0);
  });

  it('a held setup whose container is up settles on "Try again" too', async () => {
    const w = await world();
    await w.agent('setup', { state: 'PROVISIONING' });
    const op = beginOperation(w.store, 'provision', 'setup', {});
    handleFor(w.store, op.id).hold('Putting it right after a restart failed: no answer', { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' });
    const ctx = { store: w.store, secrets: w.secrets, channel: w.channel as never, providerForHost: () => w.provider, sleep: async () => {} };
    await recoverOperation(ctx, op.id, 'retry');
    expect(w.store.getAgent('setup')?.state).toBe('RUNNING');
    expect(w.store.getOperation(op.id)?.status).toBe('succeeded');
  });
});

describe('folders (HB-0284, HB-0361)', () => {
  it('a legacy folder is refused for an agent on a runner, which could not mount it', async () => {
    const w = await world();
    await w.agent('far', { hostId: 'h2' });
    const p = tempDir('hb-folder-');
    const r = await w.f.inject({ method: 'PATCH', url: '/v1/agents/far', headers: H, payload: { sharedPaths: [p] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/runs on another machine/);
    expect(w.store.getAgent('far')?.sharedPaths ?? []).toEqual([]);
    // Taking folders away still works there.
    expect((await w.f.inject({ method: 'PATCH', url: '/v1/agents/far', headers: H, payload: { sharedPaths: [] } })).statusCode).toBe(200);
  });

  it('a folder source must be a folder, not a file', async () => {
    const w = await world();
    await w.agent('folder');
    const d = tempDir('hb-file-source-');
    const file = join(d, 'report.txt');
    writeFileSync(file, 'made-up notes');
    const r = await w.f.inject({ method: 'POST', url: '/v1/agents/folder/data-sources', headers: H, payload: { kind: 'folder', access: 'ro', path: file } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/is a file, not a folder/);
    expect(w.store.listDataSources('folder')).toEqual([]);
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/folder/data-sources', headers: H, payload: { kind: 'folder', access: 'ro', path: d } })).statusCode).toBe(200);
  });
});
