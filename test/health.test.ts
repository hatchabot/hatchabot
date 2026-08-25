import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { agentHealth, doctorLint } from '../src/orchestrator/health.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-agentclaw-owner': OWNER };

const HEALTHY = JSON.stringify({
  ok: true, ts: 1787318551214,
  eventLoop: { degraded: false, reasons: [] },
  plugins: { loaded: ['telegram'], errors: [] },
  channels: { telegram: { connected: true, running: true, lastError: null, reconnectAttempts: 0, lastInboundAt: 1787318544422, lastEventAt: 1787318544422 } },
});
const DEGRADED = JSON.stringify({
  ok: true, ts: 1787318551214,
  eventLoop: { degraded: false, reasons: [] },
  plugins: { loaded: ['telegram'], errors: [] },
  channels: { telegram: { connected: false, running: true, lastError: 'auth failed', reconnectAttempts: 3 } },
});

async function seedRuntime(p: MockProvider, slug = 'kitchen', agentId = 'a1') {
  const { runtimeRef } = await p.provision({
    agentId, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {},
  } as any);
  return runtimeRef;
}

describe('doctorLint', () => {
  const LINT = JSON.stringify({
    ok: false,
    checksRun: 24,
    findings: [
      { checkId: 'core/doctor/security', severity: 'warning', message: 'plaintext secrets' },
      { checkId: 'core/doctor/security', severity: 'warning', message: 'paths: x, y' },
      { checkId: 'core/doctor/websearch', severity: 'warning', message: 'no provider enabled' },
    ],
  });

  it('parses findings and mutes the known-by-design security warnings', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('doctor', { code: 0, stdout: LINT, stderr: '' });
    const d = (await doctorLint(p, ref))!;
    expect(d.ok).toBe(false);
    expect(d.checksRun).toBe(24);
    // The all-agents-forever warnings are counted, not listed — noise on every
    // agent is how the one finding that matters goes unnoticed.
    expect(d.mutedCount).toBe(2);
    expect(d.findings).toEqual([
      { checkId: 'core/doctor/websearch', severity: 'warning', message: 'no provider enabled' },
    ]);
  });

  it('returns undefined (never throws) when doctor is absent or broken', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('doctor', { code: 1, stdout: '', stderr: 'unknown command' });
    expect(await doctorLint(p, ref)).toBeUndefined();
    p.execResponses.set('doctor', { code: 0, stdout: 'not-json', stderr: '' });
    expect(await doctorLint(p, ref)).toBeUndefined();
  });
});

describe('agentHealth', () => {
  it('reports healthy when the gateway is ok and Telegram is connected', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('health', { code: 0, stdout: HEALTHY, stderr: '' });
    const h = await agentHealth(p, ref);
    expect(h).toMatchObject({ reachable: true, status: 'healthy', ok: true });
    expect(h.telegram).toMatchObject({ connected: true });
    // Bounds the wait explicitly.
    expect(p.execLog).toContainEqual(['health', '--json', '--timeout', '8000']);
  });

  it('reports degraded when Telegram is disconnected, surfacing the last error', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('health', { code: 0, stdout: DEGRADED, stderr: '' });
    const h = await agentHealth(p, ref);
    expect(h.status).toBe('degraded');
    expect(h.telegram).toMatchObject({ connected: false, lastError: 'auth failed', reconnectAttempts: 3 });
  });

  it('degrades on each trigger independently (ok:false / eventLoop / pluginErrors)', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    const base = { ts: 1, channels: { telegram: { connected: true, running: true, lastError: null, reconnectAttempts: 0 } } };
    const cases: Array<[string, unknown]> = [
      ['ok false', { ...base, ok: false }],
      ['eventLoop degraded', { ...base, ok: true, eventLoop: { degraded: true, reasons: ['lag'] } }],
      ['plugin errors', { ...base, ok: true, plugins: { errors: ['telegram: boom'] } }],
    ];
    for (const [label, json] of cases) {
      p.execResponses.set('health', { code: 0, stdout: JSON.stringify(json), stderr: '' });
      const h = await agentHealth(p, ref);
      expect(h.status, label).toBe('degraded');
    }
  });

  it('treats an agent with no Telegram channel as healthy (not degraded)', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('health', { code: 0, stdout: JSON.stringify({ ok: true, ts: 1, eventLoop: { degraded: false, reasons: [] } }), stderr: '' });
    const h = await agentHealth(p, ref);
    expect(h.status).toBe('healthy');
    expect(h.telegram).toBeUndefined();
  });

  it('does not report a contradictory {healthy, ok:false} when ok is absent', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('health', { code: 0, stdout: JSON.stringify({ ts: 1, eventLoop: { degraded: false, reasons: [] } }), stderr: '' });
    const h = await agentHealth(p, ref);
    expect(h.status).toBe('healthy');
    expect(h.ok).toBeUndefined();
  });

  it('reports unreachable on a nonzero exit or unparseable output', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('health', { code: 1, stdout: '', stderr: 'no gateway' });
    expect(await agentHealth(p, ref)).toEqual({ reachable: false, status: 'unreachable' });
    p.execResponses.set('health', { code: 0, stdout: 'not json', stderr: '' });
    expect(await agentHealth(p, ref)).toEqual({ reachable: false, status: 'unreachable' });
  });
});

async function world(state = 'RUNNING') {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const runtimeRef = await seedRuntime(provider);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: state as any, aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { provider, f };
}

describe('GET /v1/agents/:id/health', () => {
  it('returns the live health for a RUNNING agent', async () => {
    const { provider, f } = await world();
    provider.execResponses.set('health', { code: 0, stdout: HEALTHY, stderr: '' });
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/health', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'healthy', reachable: true });
  });

  it('409s when the agent is not RUNNING', async () => {
    const { f } = await world('STOPPED');
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/health', headers: as });
    expect(res.statusCode).toBe(409);
  });

  it('404s for an agent the caller does not own', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/health', headers: { 'x-agentclaw-owner': 'someone-else' } });
    expect(res.statusCode).toBe(404);
  });
});
