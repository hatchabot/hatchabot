import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { inQuietHours, pickAutoRebuilds, rebuildNeed, rebuildPolicy, type RebuildCandidate, type SetupChange } from '../src/orchestrator/rebuildPolicy.js';

/**
 * Releases can now say "every agent needs a rebuild", and the machine acts on
 * it: v1.16 moved agents onto an isolated network, and a week later most of the
 * development machine's agents were still on the shared one — nothing told
 * anyone, and the app badged every image difference alike (2026-09-23: 7
 * running agents still there).
 */

const CHANGES: SetupChange[] = [
  { gen: 1, version: '9.0.0', level: 'recommended', why: 'its tools folder moved' },
  { gen: 2, version: '9.1.0', level: 'optional', why: 'a label changed' },
  { gen: 3, version: '9.2.0', level: 'required', why: 'its mounts were tightened' },
];

describe('rebuildNeed', () => {
  it('a current container needs nothing', () => {
    expect(rebuildNeed({ containerGen: 3, onAgentNetwork: true }, false, CHANGES)).toBeUndefined();
    expect(rebuildNeed({}, false, [])).toBeUndefined(); // before any change existed: generation 0 is current
  });
  it('the shared network is required; an image is only recommended', () => {
    expect(rebuildNeed({ onAgentNetwork: false }, true, [])).toEqual({
      level: 'required',
      reasons: ['it is still on the shared network, where other agents can reach it', 'a newer runtime image is available'],
    });
    expect(rebuildNeed({ onAgentNetwork: true }, true, [])?.level).toBe('recommended');
  });
  it('each release the container predates adds its reason; optional ones never badge', () => {
    expect(rebuildNeed({ containerGen: 0 }, false, CHANGES)).toEqual({
      level: 'required', reasons: ['its mounts were tightened', 'its tools folder moved'],
    });
    expect(rebuildNeed({ containerGen: 1 }, false, CHANGES)?.reasons).toEqual(['its mounts were tightened']);
    expect(rebuildNeed({ containerGen: 2 }, false, CHANGES.slice(0, 2))).toBeUndefined();
  });
});

describe('policy', () => {
  it('defaults to required-only; nonsense falls back to it', () => {
    expect(rebuildPolicy({})).toBe('required-only');
    expect(rebuildPolicy({ HATCHABOT_REBUILD_POLICY: 'yolo' })).toBe('required-only');
    expect(rebuildPolicy({ HATCHABOT_REBUILD_POLICY: 'auto' })).toBe('auto');
  });
  it('quiet hours, including across midnight', () => {
    const at = (h: number) => new Date(2026, 8, 23, h, 30);
    expect(inQuietHours(at(3), '3-5')).toBe(true);
    expect(inQuietHours(at(5), '3-5')).toBe(false);
    expect(inQuietHours(at(23), '23-5')).toBe(true);
    expect(inQuietHours(at(2), '23-5')).toBe(true);
    expect(inQuietHours(at(12), '23-5')).toBe(false);
  });
});

describe('pickAutoRebuilds', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString();
  const req = { level: 'required' as const, reasons: ['x'] };
  const rec = { level: 'recommended' as const, reasons: ['y'] };
  const c = (id: string, over: Partial<RebuildCandidate> = {}): RebuildCandidate =>
    ({ id, need: req, state: 'RUNNING', busy: false, lastActiveAt: ago(60), ...over });

  it('never one mid-conversation, stopped, busy, or the Hatchabot agent', () => {
    expect(pickAutoRebuilds([
      c('chatting', { lastActiveAt: ago(3) }),
      c('stopped', { state: 'STOPPED' }),
      c('busy', { busy: true }),
      c('ops', { ops: true }),
      c('current', { need: undefined }),
      c('idle'),
    ], 'required-only', now)).toEqual(['idle']);
  });
  it('recommended ones only under auto, only in the quiet hours', () => {
    const list = [c('r', { need: rec })];
    expect(pickAutoRebuilds(list, 'required-only', now, { quiet: true })).toEqual([]);
    expect(pickAutoRebuilds(list, 'auto', now, { quiet: false })).toEqual([]);
    expect(pickAutoRebuilds(list, 'auto', now, { quiet: true })).toEqual(['r']);
  });
  it('manual does nothing; a few at a time, required first, longest idle first', () => {
    expect(pickAutoRebuilds([c('a')], 'manual', now)).toEqual([]);
    expect(pickAutoRebuilds([
      c('rec-old', { need: rec, lastActiveAt: ago(900) }),
      c('req-new', { lastActiveAt: ago(20) }),
      c('req-old', { lastActiveAt: ago(500) }),
      c('never-used', { lastActiveAt: undefined }),
    ], 'auto', now, { quiet: true, max: 3 })).toEqual(['never-used', 'req-old', 'req-new']);
  });
});

describe('over the API', () => {
  const OWNER = 'o';
  const H = { 'x-hatchabot-owner': OWNER };
  afterEach(() => { delete process.env.HATCHABOT_REBUILD_POLICY; delete process.env.HATCHABOT_ENV_FILE; });

  async function box() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    const provider = new MockProvider();
    const provision = vi.spyOn(provider, 'provision');
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} },
      providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } },
    } as never);
    const agent = (id: string, state = 'RUNNING', extra: Record<string, unknown> = {}) => store.insertAgent({
      id, ownerId: OWNER, name: id, slug: id, state, aiProfileId: 'p1', hostId: 'h1', runtimeRef: `docker://${id}`,
      persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now', ...extra,
    } as never);
    return { store, provider, provision, f, agent };
  }

  it('the list says which agents need a rebuild, and why', async () => {
    const b = await box();
    b.agent('old'); b.agent('fine');
    b.provider.infoOverride.set('docker://old', { onAgentNetwork: false });
    b.provider.infoOverride.set('docker://fine', { onAgentNetwork: true });
    const list = (await b.f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json() as any[];
    expect(list.find((a) => a.id === 'old').rebuild).toEqual({ level: 'required', reasons: [expect.stringMatching(/shared network/)] });
    expect(list.find((a) => a.id === 'fine').rebuild).toBeUndefined();
  });

  it('the sweep rebuilds the required, idle, running ones — and nothing under manual', async () => {
    const b = await box();
    b.agent('old'); b.agent('fine'); b.agent('parked', 'STOPPED');
    b.agent('hatchabot', 'RUNNING', { ops: true });
    for (const id of ['old', 'parked', 'hatchabot']) b.provider.infoOverride.set(`docker://${id}`, { onAgentNetwork: false });
    const sweep = (b.f as any).rebuildSweep as (now?: Date) => Promise<string[]>;

    process.env.HATCHABOT_REBUILD_POLICY = 'manual';
    expect(await sweep()).toEqual([]);
    process.env.HATCHABOT_REBUILD_POLICY = 'required-only';
    expect(await sweep()).toEqual(['old']);
    await new Promise((r) => setTimeout(r, 50));
    expect(b.provision.mock.calls.map((c) => c[0].agentId)).toEqual(['old']);
  });

  it('starting a stopped agent that needs a required rebuild brings it up rebuilt', async () => {
    const b = await box();
    b.agent('parked', 'STOPPED');
    b.provider.infoOverride.set('docker://parked', { onAgentNetwork: false });
    const res = await b.f.inject({ method: 'POST', url: '/v1/agents/parked/start', headers: H, payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json().rebuilding).toBe(true);
    await vi.waitFor(() => expect(b.store.getAgent('parked')!.state).toBe('RUNNING'), { timeout: 5000 });
    expect(b.provision).toHaveBeenCalled();
  });

  it('under manual, start is just a start', async () => {
    const b = await box();
    process.env.HATCHABOT_REBUILD_POLICY = 'manual';
    vi.spyOn(b.provider, 'start').mockResolvedValue(undefined as never);
    b.agent('parked', 'STOPPED');
    b.provider.infoOverride.set('docker://parked', { onAgentNetwork: false });
    const res = await b.f.inject({ method: 'POST', url: '/v1/agents/parked/start', headers: H, payload: {} });
    expect(res.json()).toMatchObject({ state: 'RUNNING' });
    expect(b.provision).not.toHaveBeenCalled();
  });

  it('only the machine owner sets the policy; it is written to .env and applies at once', async () => {
    const b = await box();
    const dir = mkdtempSync(join(tmpdir(), 'hb-rp-'));
    process.env.HATCHABOT_ENV_FILE = join(dir, '.env');
    writeFileSync(process.env.HATCHABOT_ENV_FILE, 'PORT=8080\n');
    expect((await b.f.inject({ method: 'PUT', url: '/v1/rebuild-policy', headers: { 'x-hatchabot-owner': 'someone-else' }, payload: { policy: 'manual' } })).statusCode).toBe(403);
    expect((await b.f.inject({ method: 'PUT', url: '/v1/rebuild-policy', headers: H, payload: { policy: 'whenever' } })).statusCode).toBe(400);
    const ok = await b.f.inject({ method: 'PUT', url: '/v1/rebuild-policy', headers: H, payload: { policy: 'auto' } });
    expect(ok.json()).toEqual({ policy: 'auto' });
    expect(readFileSync(process.env.HATCHABOT_ENV_FILE, 'utf8')).toMatch(/^HATCHABOT_REBUILD_POLICY=auto$/m);
    expect((await b.f.inject({ method: 'GET', url: '/v1/rebuild-policy', headers: H })).json().policy).toBe('auto');
  });
});
