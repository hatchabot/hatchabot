import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { runBudgets, type BudgetDeps } from '../src/orchestrator/budgets.js';
import { HOUR_FIELDS, type WindowModelStats } from '../src/orchestrator/usage.js';
import { exportAgent, importAgent } from '../src/orchestrator/transfer.js';
import { buildRuntimeSpec } from '../src/orchestrator/provision.js';
import { sampleAgentUsage } from '../src/orchestrator/sourceUsage.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

/**
 * The 2026-10-23 full audit (docs/audit-2026-10-23.md): one test per fix, so
 * none of them quietly comes back.
 */

const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };
class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error(`no secret ${r}`); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const HOUR = 3_600_000, DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse('2026-10-20T12:00:00Z');

async function routesWorld(opts: { channel?: unknown; hostKind?: string } = {}) {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: (opts.hostKind ?? 'local') as never, provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-sonnet-5', 'claude-haiku-4-5'], secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'sk-test');
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets, providers: new Map([['mock', provider]]),
    channel: (opts.channel ?? { kind: 'telegram', pool: { availableCount: () => 0, owns: () => false }, release: async () => {} }) as never,
  } as never);
  const agent = (id: string, extra: Record<string, unknown> = {}) => {
    store.insertAgent({ id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: `mock://${id}`, persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now', ...extra } as never);
    store.insertMembership({ id: `m-${id}`, agentId: id, userId: OWNER, role: 'owner', status: 'active' });
    return store.getAgent(id)!;
  };
  return { store, secrets, provider, f, agent };
}

describe('two Telegram attaches at once (routes-b #1)', () => {
  it('the second answers 409, not 500, and one channel row is made', async () => {
    const secrets = new MemSecrets();
    let leases = 0;
    const channel = {
      kind: 'telegram',
      pool: { owns: () => false, ownerOf: () => undefined, availableCount: () => 1, list: () => [] },
      async provision() {
        leases++;
        await new Promise((r) => setTimeout(r, 40));
        await secrets.put('telegram/bot/spare_bot', 'made-up-token-0000');
        return { accountId: 'spare_bot', secretRef: 'telegram/bot/spare_bot', deepLink: 'https://t.me/spare_bot' };
      },
      async release() {}, async syncDisplayName() {},
    };
    const w = await routesWorld({ channel });
    w.agent('tax', { state: 'STOPPED' });
    const [a, b] = await Promise.all([
      w.f.inject({ method: 'POST', url: '/v1/agents/tax/telegram', headers: H, payload: {} }),
      w.f.inject({ method: 'POST', url: '/v1/agents/tax/telegram', headers: H, payload: {} }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(202);
    expect(codes[1]).toBe(409);
    expect(w.store.listChannelsForAgent('tax')).toHaveLength(1);
    expect(leases).toBeGreaterThanOrEqual(1);
  });
});

describe('a spare pool bot\'s token pasted while the agent waits for one (runtime #1)', () => {
  it('is refused with the pool named, as the attach route does', async () => {
    const channel = { kind: 'telegram', pool: { availableCount: () => 1, owns: (u: string) => u.toLowerCase() === 'sparebot' }, release: async () => {}, submitToken: async () => ({ username: 'sparebot' }) };
    const w = await routesWorld({ channel });
    w.agent('park', { state: 'PROVISIONING' });
    w.store.setAgentPendingAction('park', { type: 'bot_token' } as never);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { username: 'sparebot' } }), { status: 200 }));
    try {
      const r = await w.f.inject({ method: 'POST', url: '/v1/agents/park/channel-token', headers: H, payload: { token: '123456:made-up-token-for-the-test' } });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/spare bot in the pool/);
    } finally { fetchSpy.mockRestore(); }
  });
});

describe('folders are this machine\'s: not for an agent on a runner (lifecycle #2)', () => {
  it('adding a folder to an agent on a runner is refused; moving an agent with folders to a runner is refused', async () => {
    const w = await routesWorld();
    w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'cloud', provider: 'mock', name: 'runner', settings: {}, createdAt: 'now' });
    w.agent('far', { hostId: 'h2' });
    const dir = mkdtempSync(join(tmpdir(), 'aud-'));
    try {
      const r = await w.f.inject({ method: 'POST', url: '/v1/agents/far/data-sources', headers: H, payload: { kind: 'folder', access: 'ro', path: dir } });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/runs on another machine/);
      expect(w.store.listDataSources('far')).toHaveLength(0);
      // Here: a folder is fine, but then the agent cannot move to the runner with it.
      w.agent('near', { state: 'STOPPED' });
      const ok = await w.f.inject({ method: 'POST', url: '/v1/agents/near/data-sources', headers: H, payload: { kind: 'folder', access: 'ro', path: dir } });
      expect(ok.statusCode).toBe(200);
      const mv = await w.f.inject({ method: 'POST', url: '/v1/agents/near/move-host', headers: H, payload: { hostId: 'h2' } });
      expect(mv.statusCode).toBe(409);
      expect(mv.json()).toMatchObject({ code: 'folders_stay_here' });
      expect(w.store.getAgent('near')!.hostId).toBe('h1');
      // The Test button on a folder of an agent that IS on a runner (an older install) says it is not mounted.
      const ds = w.store.listDataSources('near')[0]!;
      w.store.insertDataSource({ ...ds, id: 'far-folder', agentId: 'far' });
      const chk = await w.f.inject({ method: 'POST', url: '/v1/agents/far/data-sources/far-folder/check', headers: H });
      expect(chk.json()).toMatchObject({ ok: false, reason: 'remote' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('a body of the wrong shape answers 400, not 500 (routes-a #3)', () => {
  it('agent classes, image rebuild base and CLI token labels', async () => {
    const w = await routesWorld();
    expect((await w.f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 5 } })).statusCode).toBe(400);
    const made = await w.f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Light', model: 'claude-sonnet-5' } });
    expect(made.statusCode).toBe(200);
    expect((await w.f.inject({ method: 'PUT', url: `/v1/agent-classes/${made.json().class.id}`, headers: H, payload: { name: { x: 1 } } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'POST', url: '/v1/cli-tokens', headers: H, payload: { label: 7 } })).statusCode).toBe(400);
    expect((await w.f.inject({ method: 'POST', url: '/v1/cli-tokens', headers: H, payload: { label: 'x'.repeat(65) } })).statusCode).toBe(400);
  });
});

describe('the console proxy takes any body type; other routes keep their 415 (access #1)', () => {
  it('a multipart POST to the proxy is not refused by the body parser', async () => {
    const w = await routesWorld();
    w.agent('con');
    const r = await w.f.inject({ method: 'POST', url: '/v1/agents/con/ui/api/chat/media/outgoing', headers: { ...H, 'content-type': 'multipart/form-data; boundary=xyz' }, payload: '--xyz\r\nContent-Disposition: form-data; name="f"\r\n\r\nhi\r\n--xyz--\r\n' });
    expect(r.statusCode).not.toBe(415);
    const other = await w.f.inject({ method: 'POST', url: '/v1/agents', headers: { ...H, 'content-type': 'multipart/form-data; boundary=xyz' }, payload: '--xyz--\r\n' });
    expect(other.statusCode).toBe(415);
  });
});

describe('a copy was downloaded: deleting the stopped source does not park its bot (lifecycle #3)', () => {
  it('export records exportedAt; delete leaves the bot out of the pool unless asked; running again clears the mark', async () => {
    const parked: string[] = [];
    const channel = { kind: 'telegram', pool: { availableCount: () => 0, owns: () => false, addToPool: async (u: string) => { parked.push(u); } }, release: async () => {} };
    const w = await routesWorld({ channel });
    const a = w.agent('src', { webOnly: false });
    await w.secrets.put('chan/src', 'made-up-bot-token');
    w.store.insertChannel({ id: 'c1', agentId: 'src', kind: 'telegram', accountId: 'srcbot', secretRef: 'chan/src', deepLink: 'https://t.me/srcbot', createdAt: 'now' });
    const { runtimeRef } = await w.provider.provision({ agentId: 'src', slug: 'src', workspace: { files: {}, configPatch: { agentId: 'src', authMode: 'api-key' } as never }, env: {} });
    await w.provider.start(runtimeRef);
    w.provider.stateStore.set(runtimeRef, Buffer.from('memory'));
    await exportAgent({ store: w.store, secrets: w.secrets, provider: w.provider, channel: channel as never, sleep: async () => {} } as never, a.id);
    expect(w.store.getAgent('src')!.state).toBe('STOPPED');
    expect(w.store.getAgent('src')!.exportedAt).toBeTruthy();
    const shown = await w.f.inject({ method: 'GET', url: '/v1/agents', headers: H });
    expect(shown.json().find((x: { id: string }) => x.id === 'src').exportedAt).toBeTruthy();
    // Started again: an ordinary agent, the mark gone.
    w.store.setAgentState('src', 'RUNNING');
    expect(w.store.getAgent('src')!.exportedAt).toBeUndefined();
    w.store.setAgentState('src', 'STOPPED');
    w.store.setAgentExportedAt('src', iso(NOW));
    const del = await w.f.inject({ method: 'DELETE', url: '/v1/agents/src', headers: H });
    expect(del.statusCode).toBeLessThan(300);
    expect(parked).toEqual([]);
    // Asked for: parked as before.
    const b = w.agent('src2', { state: 'STOPPED', webOnly: false, exportedAt: iso(NOW) });
    await w.secrets.put('chan/src2', 'made-up-bot-token-2');
    w.store.insertChannel({ id: 'c2', agentId: b.id, kind: 'telegram', accountId: 'srcbot2', secretRef: 'chan/src2', deepLink: 'https://t.me/srcbot2', createdAt: 'now' });
    const del2 = await w.f.inject({ method: 'DELETE', url: '/v1/agents/src2?recycleBot=1', headers: H });
    expect(del2.statusCode).toBeLessThan(300);
    expect(parked).toEqual(['srcbot2']);
  });
});

describe('a pause budget on an agent the owner had already stopped (usage #1)', () => {
  function model(byHour: Record<number, Partial<Record<string, number>>>): WindowModelStats {
    const h: Record<string, number[]> = {};
    for (const [ms, c] of Object.entries(byHour)) h[iso(Number(ms)).slice(0, 13)] = HOUR_FIELDS.map((f) => (c as Record<string, number>)[f] ?? 0);
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0, failedTurns: 0, failed7d: 0, first: 0, last: 0, ctxP50: 0, ctxP90: 0, h } as unknown as WindowModelStats;
  }
  it('records the pause, so Start marks the owner\'s take-over and the next pass leaves it alone', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Recipe Box', slug: 'a1', state: 'STOPPED', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'mock://a1', persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now' } as never);
    store.setModelProfile('a1', { since: NOW - 30 * DAY, models: { 'claude-opus-4-8': model({ [NOW - 2 * HOUR]: { input: 12 * 200_000 } }) }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * DAY, hourly: true } as never, iso(NOW));
    store.setBudget('a1', OWNER, 10, 'pause', iso(NOW));
    const told: string[] = [];
    let pauses = 0;
    const deps: BudgetDeps = {
      store, tz: 'UTC',
      tell: async (_o, _a, text) => { told.push(text); return true; },
      pause: async (a) => { pauses++; store.setAgentState(a.id, 'STOPPED'); return true; },
      resume: async (a) => { store.setAgentState(a.id, 'RUNNING'); return true; },
      isBusy: () => false,
    };
    const r1 = await runBudgets(deps, NOW);
    expect(pauses).toBe(0); // nothing to stop
    expect(r1.paused).toEqual(['a1']);
    expect(store.getBudgetPause('a1', '2026-10')).toMatchObject({ kind: 'pause' });
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/it is paused/);
    // The owner starts it in the app: the route marks the take-over (the row exists now).
    store.resumeBudgetPause('a1', '2026-10', iso(NOW + 60_000), 'owner');
    store.setAgentState('a1', 'RUNNING');
    const r2 = await runBudgets(deps, NOW + 20 * 60_000);
    expect(r2.paused).toEqual([]);
    expect(pauses).toBe(0);
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    expect(told).toHaveLength(1);
  });

  it('an archived agent\'s budget is neither marked nor told (usage #8)', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Old', slug: 'a1', state: 'ARCHIVED', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'mock://a1', persona: '', sharedMemory: true, webOnly: true, createdAt: '2026-08-01T00:00:00Z', updatedAt: 'now' } as never);
    store.setModelProfile('a1', { since: NOW - 30 * DAY, models: { 'claude-opus-4-8': model({ [NOW - 2 * HOUR]: { input: 12 * 200_000 } }) }, promptErrors: 0, crons: 0, firstCall: NOW - 60 * DAY, hourly: true } as never, iso(NOW));
    store.setBudget('a1', OWNER, 10, 'pause', iso(NOW));
    const told: string[] = [];
    const deps: BudgetDeps = { store, tz: 'UTC', tell: async (_o, _a, t) => { told.push(t); return true; }, pause: async () => true, resume: async () => true, isBusy: () => false };
    const r = await runBudgets(deps, NOW);
    expect(r.paused).toEqual([]);
    expect(told).toEqual([]);
    expect(store.budgetMark('a1', '2026-10', 100, 10)).toBeUndefined();
  });
});

describe('data sources travel with an export (lifecycle #1) and a failed import leaves no volume (lifecycle #5)', () => {
  const channelStub = { kind: 'telegram' } as unknown as ChannelProvisioner;
  async function installation(owner = 'o', hostKind = 'local') {
    const store = new Store(new Database(':memory:'));
    const secrets = new MemSecrets();
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: owner, kind: hostKind as never, provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: owner, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    await secrets.put('ai/p1', 'sk-test');
    const deps = { store, secrets, provider, channel: channelStub, sleep: async () => {} };
    return { store, secrets, provider, deps };
  }
  async function source(src: Awaited<ReturnType<typeof installation>>, folder: string) {
    const { store, secrets, provider } = src;
    store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'helps cook', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' });
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'o', role: 'owner', status: 'active' });
    await secrets.put('data-source/g1', 'MADE-UP-PRIVATE-KEY-FOR-THE-TEST');
    store.insertDataSource({ id: 'g1', agentId: 'a1', kind: 'git', access: 'rw', mountName: 'recipes', repoUrl: 'git@github.com:example-owner/recipes.git', secretRef: 'data-source/g1', pubKey: 'ssh-ed25519 AAAA-made-up test', createdAt: 'now' });
    store.insertDataSource({ id: 'f1', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'notes', hostPath: folder, createdAt: 'now' });
    store.insertDataSource({ id: 'f2', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'gone', hostPath: '/no/such/folder/on/this/machine', createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } as never }, env: {} });
    store.setAgentRuntimeRef('a1', runtimeRef);
    await provider.start(runtimeRef);
    store.setAgentState('a1', 'RUNNING');
    provider.stateStore.set(runtimeRef, Buffer.from('the-agents-memory'));
  }

  it('a repo comes back with its key as a fresh secret; a folder only where the same path is here', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aud-ds-'));
    try {
      const src = await installation();
      await source(src, dir);
      const { data } = await exportAgent(src.deps, 'a1');
      const dst = await installation('importer');
      const logged: Array<[string, Record<string, unknown>]> = [];
      const agent = await importAgent({ ...dst.deps, log: (e, d) => logged.push([e, d]) }, data, { ownerId: 'importer' });
      const ds = dst.store.listDataSources(agent.id);
      const git = ds.find((d) => d.kind === 'git')!;
      expect(git).toMatchObject({ access: 'rw', mountName: 'recipes', repoUrl: 'git@github.com:example-owner/recipes.git', pubKey: 'ssh-ed25519 AAAA-made-up test' });
      expect(git.secretRef).toBe(`data-source/${git.id}`);
      expect(await dst.secrets.get(git.secretRef!)).toBe('MADE-UP-PRIVATE-KEY-FOR-THE-TEST');
      expect(ds.filter((d) => d.kind === 'folder').map((d) => d.hostPath)).toEqual([dir]);
      const skipped = logged.find(([e]) => e === 'import.folders_not_here');
      expect(skipped?.[1]).toMatchObject({ folders: ['/no/such/folder/on/this/machine'] });
      // The spec the destination built mounts the folder that is here (the repo is cloned by the sync after the seed).
      expect(dst.provider.lastSpec?.hostMounts?.map((m) => m.target)).toEqual(['/data/notes']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('on a runner nothing of this machine\'s folders is mounted, and the repo still comes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aud-ds2-'));
    try {
      const src = await installation();
      await source(src, dir);
      const { data } = await exportAgent(src.deps, 'a1');
      const dst = await installation('importer', 'cloud');
      const agent = await importAgent(dst.deps, data, { ownerId: 'importer' });
      const ds = dst.store.listDataSources(agent.id);
      expect(ds.map((d) => d.kind)).toEqual(['git']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a provision that fails after making the volume has that volume destroyed by the rollback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aud-ds3-'));
    try {
      const src = await installation();
      await source(src, dir);
      const { data } = await exportAgent(src.deps, 'a1');
      const dst = await installation('importer');
      const destroyed: Array<[string, boolean]> = [];
      const realDestroy = dst.provider.destroy.bind(dst.provider);
      dst.provider.destroy = async (ref, opts) => { destroyed.push([ref, !!opts?.purge]); return realDestroy(ref, opts); };
      dst.provider.provision = async () => { throw new Error('the seed failed'); };
      await expect(importAgent(dst.deps, data, { ownerId: 'importer' })).rejects.toThrow(/seed failed/);
      const tomb = dst.store.listAllActiveAgents();
      expect(tomb).toHaveLength(0);
      expect(destroyed.some(([ref, purge]) => ref.startsWith('mock://') && purge)).toBe(true);
      // Nothing of the import's rows or secrets stays behind.
      expect([...dst.secrets.map.keys()].filter((k) => k.startsWith('data-source/'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the container hostname fits Linux\'s 64 bytes (runtime #3)', () => {
  it('a long agent name on a long host name is cut, the agent\'s part first', async () => {
    const store = new Store(new Database(':memory:'));
    const secrets = new MemSecrets();
    const provider = new MockProvider();
    const longHost = 'a-very-long-runner-name-that-goes-on-and-on-for-a-while-indeed-yes';
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'cloud', provider: 'mock', name: longHost, settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    await secrets.put('ai/p1', 'sk-test');
    const channel = { kind: 'telegram' } as unknown as ChannelProvisioner;
    const deps = { store, secrets, provider, channel, sleep: async () => {} } as never;
    const slug = 'an-agent-with-a-very-long-name-indeed-for-the-household-of-many';
    store.insertAgent({ id: 'long', ownerId: 'o', name: 'An Agent With A Very Long Name', slug, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const agent = store.getAgent('long')!;
    const spec = await buildRuntimeSpec(deps, agent.id);
    expect(spec.hostname!.length).toBeLessThanOrEqual(63);
    expect(spec.hostname!.startsWith(agent.slug.slice(0, 40))).toBe(true);
    expect(spec.hostname).not.toMatch(/[.-]$/);
  });
});

describe('a partial transcript read is not a counter reading (usage #3)', () => {
  it('rows the reader could not decode: the profile is kept, no token total is written', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a', slug: 'a', workspace: { files: {}, configPatch: { agentId: 'a', authMode: 'api-key' } as never }, env: {} });
    await provider.start(runtimeRef);
    store.insertAgent({ id: 'a', ownerId: OWNER, name: 'A', slug: 'a', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    const read = (input: number, bad: number) => ({ models: { 'claude-opus-4-8': { calls: 2, input, output: 10, cacheRead: 0, cacheWrite: 0, sessions: 1 } }, sessions: 1, first: NOW - HOUR, last: NOW, bad, window: { since: NOW - 30 * DAY, models: {} } });
    const deps = { store, providerFor: () => provider };
    provider.usage.set(runtimeRef, read(2_000_000, 0));
    await sampleAgentUsage(deps, store.getAgent('a')!, NOW);
    expect(store.latestTokenTotal('a')).toBe(2_000_010);
    // A row that would not decode: the total read is smaller than the truth. Not stored.
    provider.usage.set(runtimeRef, read(1_000_000, 1));
    await sampleAgentUsage(deps, store.getAgent('a')!, NOW + 10 * 60_000);
    expect(store.latestTokenTotal('a')).toBe(2_000_010);
    expect(store.modelProfiles(['a']).get('a')).toBeTruthy();
    // The next whole read counts only what is new.
    provider.usage.set(runtimeRef, read(2_100_000, 0));
    await sampleAgentUsage(deps, store.getAgent('a')!, NOW + 20 * 60_000);
    expect(store.latestTokenTotal('a')).toBe(2_100_010);
  });
});
