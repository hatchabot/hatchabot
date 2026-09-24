import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { createAgentRecord } from '../src/orchestrator/provision.js';
import { pickAutoRebuilds } from '../src/orchestrator/rebuildPolicy.js';
import { EmbedderService } from '../src/embedder/embedder.js';

/** Step 3 of the embedder: the fleet default for new agents, and moving the rest. */
const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };

async function box() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const provider = new MockProvider();
  const provision = vi.spyOn(provider, 'provision');
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} }, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } } as never);
  const svc = (f as unknown as { embedder: EmbedderService }).embedder;
  Object.defineProperty(svc, 'enabled', { value: true }); // the owner turned the service on
  // …and it is running: provisioning must never reach for the model or the key file here.
  svc.status = async () => ({ embedder: 'running', door: 'running', doorAddress: '172.17.0.1:8093', enabled: true, modelPresent: true });
  svc.syncKeys = () => {};
  const agent = (id: string, state = 'RUNNING') => store.insertAgent({
    id, ownerId: OWNER, name: id, slug: id, state, aiProfileId: 'p1', hostId: 'h1', runtimeRef: `docker://${id}`,
    persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  return { store, provider, provision, f, agent };
}

describe('the fleet default', () => {
  afterEach(() => { delete process.env.HATCHABOT_EMBED_DEFAULT; delete process.env.HATCHABOT_ENV_FILE; });
  it('new agents get it; only the machine owner sets it, and only with the service on', async () => {
    const b = await box();
    const dir = mkdtempSync(join(tmpdir(), 'hb-ed-'));
    process.env.HATCHABOT_ENV_FILE = join(dir, '.env'); writeFileSync(process.env.HATCHABOT_ENV_FILE, 'PORT=8080\n');
    expect((await b.f.inject({ method: 'PUT', url: '/v1/embed-default', headers: { 'x-hatchabot-owner': 'member' }, payload: { default: 'shared' } })).statusCode).toBe(403);
    const r = await b.f.inject({ method: 'PUT', url: '/v1/embed-default', headers: H, payload: { default: 'shared' } });
    expect(r.json().default).toBe('shared');
    const made = createAgentRecord(b.store, { ownerId: OWNER, name: 'Fresh', aiProfileId: 'p1', hostId: 'h1' } as never);
    expect(b.store.getAgent(made.id)!.embedMode).toBe('shared');
    await b.f.inject({ method: 'PUT', url: '/v1/embed-default', headers: H, payload: { default: 'baked' } });
    const made2 = createAgentRecord(b.store, { ownerId: OWNER, name: 'Fresh 2', aiProfileId: 'p1', hostId: 'h1' } as never);
    expect(b.store.getAgent(made2.id)!.embedMode).toBeUndefined();
  });
});

describe('moving the rest', () => {
  it('marks every agent; "now" rebuilds the idle running ones and counts the rest as deferred', async () => {
    const b = await box();
    b.agent('a'); b.agent('b'); b.agent('parked', 'STOPPED'); b.agent('done'); b.store.setAgentEmbedMode('done', 'shared');
    const r = (await b.f.inject({ method: 'POST', url: '/v1/embed/move-all', headers: H, payload: { mode: 'shared', when: 'now' } })).json();
    expect(r).toMatchObject({ switched: 3, queued: 2, deferred: 1, shared: 4, total: 4 });
    for (const id of ['a', 'b', 'parked']) expect(b.store.getAgent(id)!.embedMode).toBe('shared');
    await vi.waitFor(() => expect(b.provision.mock.calls.map((c) => c[0].agentId).sort()).toEqual(['a', 'b']), { timeout: 8000 });
    const v = (await b.f.inject({ method: 'GET', url: '/v1/embed-default', headers: H })).json();
    expect(v.total).toBe(4);
  });
  it('"quiet" only marks them; the sweep picks a pending switch up in the quiet hours under the default policy', async () => {
    const b = await box();
    b.agent('a');
    const r = (await b.f.inject({ method: 'POST', url: '/v1/embed/move-all', headers: H, payload: { mode: 'shared', when: 'quiet' } })).json();
    expect(r).toMatchObject({ switched: 1, queued: 0, deferred: 1, pending: 1 });
    expect(b.provision).not.toHaveBeenCalled();
    const now = new Date('2026-09-24T03:30:00');
    const c = { id: 'a', state: 'RUNNING', busy: false, switchPending: true, lastActiveAt: '2026-09-11T00:00:00Z' };
    expect(pickAutoRebuilds([c], 'required-only', now, { quiet: true })).toEqual(['a']);
    expect(pickAutoRebuilds([c], 'required-only', now, { quiet: false })).toEqual([]);
    expect(pickAutoRebuilds([c], 'manual', now, { quiet: true })).toEqual([]);
  });
  it('a member cannot move the fleet', async () => {
    const b = await box();
    expect((await b.f.inject({ method: 'POST', url: '/v1/embed/move-all', headers: { 'x-hatchabot-owner': 'member' }, payload: { mode: 'shared' } })).statusCode).toBe(403);
  });
});
