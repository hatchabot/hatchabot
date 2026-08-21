import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { listCrons, setCronEnabled, runCronNow, deleteCron } from '../src/orchestrator/crons.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Scheduled tasks are driven entirely through the in-container `openclaw cron`
 * CLI (via provider.exec), so the MockProvider's execResponses stand in for the
 * gateway. CRON_JSON is the real `cron list --json` shape (2026.6.11).
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-agentclaw-owner': OWNER };

const CRON_JSON = JSON.stringify({
  jobs: [
    {
      id: 'job-1', name: 'Morning scan', description: 'Weekday 9am scan',
      enabled: true, agentId: 'kitchen',
      schedule: { kind: 'cron', expr: '0 9 * * 1-5', tz: 'America/Toronto' },
      payload: { kind: 'agentTurn', message: 'Do the scan' },
    },
    {
      id: 'job-2', name: 'Hourly shell', enabled: false,
      schedule: { kind: 'every', every_ms: 3600000 },
      payload: { kind: 'command', command: 'echo hi' },
    },
  ],
});

async function seedRuntime(p: MockProvider, slug = 'kitchen', agentId = 'a1') {
  const { runtimeRef } = await p.provision({
    agentId, slug,
    workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } },
    env: {},
  } as any);
  return runtimeRef;
}

describe('crons helpers', () => {
  it('listCrons parses the openclaw cron list --json shape', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('cron list', { code: 0, stdout: CRON_JSON, stderr: '' });
    const crons = await listCrons(p, ref, 'kitchen');
    expect(crons).toHaveLength(2);
    expect(crons[0]).toMatchObject({
      id: 'job-1', name: 'Morning scan', enabled: true, scheduleKind: 'cron',
      scheduleExpr: '0 9 * * 1-5', scheduleTz: 'America/Toronto',
      payloadKind: 'agentTurn', message: 'Do the scan',
    });
    expect(crons[1]).toMatchObject({ id: 'job-2', enabled: false, scheduleKind: 'every', everyMs: 3600000, message: 'echo hi' });
    // Filters to this agent, includes disabled jobs.
    expect(p.execLog).toContainEqual(['cron', 'list', '--agent', 'kitchen', '--all', '--json']);
  });

  it('listCrons returns [] on a nonzero exit or bad json', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('cron list', { code: 1, stdout: '', stderr: 'gateway down' });
    expect(await listCrons(p, ref, 'kitchen')).toEqual([]);
    p.execResponses.set('cron list', { code: 0, stdout: 'not json', stderr: '' });
    expect(await listCrons(p, ref, 'kitchen')).toEqual([]);
  });

  it('mutators pass the right argv and report success by exit code', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    expect(await setCronEnabled(p, ref, 'job-1', false)).toBe(true);
    expect(await runCronNow(p, ref, 'job-1')).toBe(true);
    expect(await deleteCron(p, ref, 'job-1')).toBe(true);
    expect(p.execLog).toContainEqual(['cron', 'disable', 'job-1']);
    expect(p.execLog).toContainEqual(['cron', 'run', 'job-1']);
    expect(p.execLog).toContainEqual(['cron', 'rm', 'job-1']);
    p.execResponses.set('cron rm', { code: 3, stdout: '', stderr: 'no such job' });
    expect(await deleteCron(p, ref, 'missing')).toBe(false);
  });
});

async function world(state = 'RUNNING') {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const runtimeRef = await seedRuntime(provider);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: state as any, aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f };
}

describe('cron routes', () => {
  it('GET lists crons for a RUNNING agent', async () => {
    const { provider, f } = await world();
    provider.execResponses.set('cron list', { code: 0, stdout: CRON_JSON, stderr: '' });
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/crons', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json().crons).toHaveLength(2);
  });

  it('409s when the agent is not RUNNING', async () => {
    const { f } = await world('STOPPED');
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/crons', headers: as });
    expect(res.statusCode).toBe(409);
  });

  it('PATCH enable/disable toggles the task', async () => {
    const { provider, f } = await world();
    const res = await f.inject({ method: 'PATCH', url: '/v1/agents/a1/crons/job-1', headers: as, payload: { enabled: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, enabled: false });
    expect(provider.execLog).toContainEqual(['cron', 'disable', 'job-1']);
  });

  it('PATCH rejects a missing enabled flag', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'PATCH', url: '/v1/agents/a1/crons/job-1', headers: as, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('POST run triggers a test fire', async () => {
    const { provider, f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/crons/job-1/run', headers: as, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(provider.execLog).toContainEqual(['cron', 'run', 'job-1']);
  });

  it('DELETE removes a task', async () => {
    const { provider, f } = await world();
    const res = await f.inject({ method: 'DELETE', url: '/v1/agents/a1/crons/job-1', headers: as });
    expect(res.statusCode).toBe(200);
    expect(provider.execLog).toContainEqual(['cron', 'rm', 'job-1']);
  });

  it('502s when the cron CLI reports failure (delete / run / enable each)', async () => {
    const { provider, f } = await world();
    provider.execResponses.set('cron rm', { code: 2, stdout: '', stderr: 'no such job' });
    provider.execResponses.set('cron run', { code: 2, stdout: '', stderr: 'no such job' });
    provider.execResponses.set('cron disable', { code: 2, stdout: '', stderr: 'no such job' });
    const rm = await f.inject({ method: 'DELETE', url: '/v1/agents/a1/crons/nope', headers: as });
    expect(rm.statusCode).toBe(502);
    const run = await f.inject({ method: 'POST', url: '/v1/agents/a1/crons/nope/run', headers: as, payload: {} });
    expect(run.statusCode).toBe(502);
    const patch = await f.inject({ method: 'PATCH', url: '/v1/agents/a1/crons/nope', headers: as, payload: { enabled: false } });
    expect(patch.statusCode).toBe(502);
  });

  it('404s for an agent the caller does not own', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/crons', headers: { 'x-agentclaw-owner': 'someone-else' } });
    expect(res.statusCode).toBe(404);
  });
});
