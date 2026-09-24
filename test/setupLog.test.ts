import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { eventLabel, IN_PROGRESS } from '../src/orchestrator/eventLabels.js';

/**
 * The Setup log: an agent's own event trail in plain words, and — while it
 * is being set up or rebuilt — the step it is on, so a card that says
 * REBUILDING for minutes can be asked what it is doing.
 */
describe('event labels', () => {
  it('says what a step means, in words, and never hides an unknown one', () => {
    expect(eventLabel('memory.reindex', { why: 'index incomplete' })).toMatch(/memory index.*partial/);
    expect(eventLabel('memory.reindex', { engine: 'shared' })).toMatch(/shared engine/);
    expect(eventLabel('runtime.seeding', { migrating: true })).toMatch(/migrations/);
    expect(eventLabel('runtime.seeding', {})).toMatch(/settings/);
    expect(eventLabel('rebuild.failed', { reason: 'seed failed' })).toBe('rebuild failed: seed failed');
    expect(eventLabel('something.new')).toBe('something.new');
    expect(IN_PROGRESS.has('memory.reindex')).toBe(true);
    expect(IN_PROGRESS.has('runtime.rebuilt')).toBe(false);
  });
});

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };
async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.setAgentRuntimeRef('a1', runtimeRef); store.setAgentState('a1', 'RUNNING'); store.setAgentState('a1', 'REBUILDING');
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never } as never);
  return { store, f };
}

describe('GET /v1/agents/:id/events and the list\'s progress', () => {
  it('returns the trail newest first with labels, and the list shows the current step of a busy agent', async () => {
    const { store, f } = await world();
    store.recordEvent('a1', 'runtime.seeding', { migrating: true });
    store.recordEvent('a1', 'runtime.provisioned', { runtimeRef: 'x' });
    store.recordEvent('a1', 'memory.reindex', { engine: 'shared', why: 'index incomplete' });
    const r = await f.inject({ method: 'GET', url: '/v1/agents/a1/events', headers: as });
    expect(r.statusCode).toBe(200);
    const ev = r.json().events;
    expect(ev.map((e: any) => e.event)).toEqual(['memory.reindex', 'runtime.provisioned', 'runtime.seeding']);
    expect(ev[0].label).toMatch(/memory index/);
    expect(ev[0].note).toBe('index incomplete');
    const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
    expect(list[0].progress.step).toMatch(/memory index/);
    expect(typeof list[0].progress.at).toBe('string');
    // Done: no progress line.
    store.recordEvent('a1', 'runtime.rebuilt', {});
    store.setAgentState('a1', 'RUNNING');
    expect((await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json()[0].progress).toBeUndefined();
    // Someone else's agent: nothing.
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/events', headers: { 'x-hatchabot-owner': 'other' } })).statusCode).toBe(404);
  });
});
