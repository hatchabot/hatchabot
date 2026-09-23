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
const as = { 'x-hatchabot-owner': OWNER };

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

  it('listCrons says it could not read the list — never "no tasks" (2026-09-23)', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('cron list', { code: 1, stdout: '', stderr: 'gateway down' });
    await expect(listCrons(p, ref, 'kitchen')).rejects.toThrow(/cron list failed/);
    p.execResponses.set('cron list', { code: 0, stdout: 'not json', stderr: '' });
    await expect(listCrons(p, ref, 'kitchen')).rejects.toThrow(/JSON/);
    p.execResponses.set('cron list', { code: 0, stdout: '{"jobs":[]}', stderr: '' });
    expect(await listCrons(p, ref, 'kitchen')).toEqual([]); // a real "none"
  });

  it('GET …/crons answers 503 with a try-again, not an empty list, when the gateway hiccups', async () => {
    const { provider, f } = await world();
    provider.execResponses.set('cron list', { code: 1, stdout: '', stderr: 'gateway down' });
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/crons', headers: as });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/try again/);
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
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/crons', headers: { 'x-hatchabot-owner': 'someone-else' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /v1/agents/:id/crons (create — the verb no interface had)', () => {
  const as = { 'x-hatchabot-owner': 'user-owner' };
  it('creates a cron job with expression, tz, and announce delivery', async () => {
    const { provider, f, store } = await world();
    // Announcing needs somewhere to post: this agent has a Telegram bot.
    store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'kitchenbot', secretRef: 'channel/a1/bot-token', deepLink: 'https://t.me/kitchenbot', createdAt: 'now' });
    provider.execResponses.set('cron add', { code: 0, stdout: '{"id":"job-9"}', stderr: '' });
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/a1/crons', headers: as,
      payload: { name: 'Pre-market briefing', cron: '0 8 * * 1-5', tz: 'America/New_York', message: 'Post the pre-market briefing.' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ created: true, id: 'job-9' });
    const call = provider.execLog.find((c) => c[0] === 'cron' && c[1] === 'add')!;
    expect(call).toContain('--cron'); expect(call).toContain('0 8 * * 1-5');
    expect(call).toContain('--tz'); expect(call).toContain('America/New_York');
    expect(call).toContain('--announce'); // a briefing that never posts is a no-op
    expect(call).toContain('--agent');
  });

  it('refuses zero or two schedules, and surfaces CLI failure as 502', async () => {
    const { provider, f } = await world();
    const none = await f.inject({ method: 'POST', url: '/v1/agents/a1/crons', headers: as, payload: { name: 'x', message: 'y' } });
    expect(none.statusCode).toBe(400);
    const both = await f.inject({
      method: 'POST', url: '/v1/agents/a1/crons', headers: as,
      payload: { name: 'x', message: 'y', cron: '0 8 * * *', everyMinutes: 5 },
    });
    expect(both.statusCode).toBe(400);
    provider.execResponses.set('cron add', { code: 1, stdout: '', stderr: 'bad expression' });
    const bad = await f.inject({
      method: 'POST', url: '/v1/agents/a1/crons', headers: as,
      payload: { name: 'x', message: 'y', cron: '0 8 * * 1-5' },
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toContain('bad expression');
  });
});

describe('task run state and history (CLI regression groundwork)', () => {
  it('list keeps what the scheduler knows about each task\'s runs', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [{
      id: 'j', name: 'brief', enabled: true, schedule: { kind: 'every', everyMs: 60000 }, payload: { kind: 'agentTurn', message: 'm' },
      state: { nextRunAtMs: 2000, lastRunAtMs: 1000, lastRunStatus: 'ok', lastDurationMs: 1450, consecutiveErrors: 0, lastDelivered: true },
    }] }) });
    expect((await listCrons(p, ref, 'kitchen'))[0]).toMatchObject({
      nextRunAtMs: 2000, lastRunAtMs: 1000, lastStatus: 'ok', lastDurationMs: 1450, consecutiveErrors: 0, lastDelivered: true,
    });
  });

  it('GET …/runs returns the finished runs newest first, with what each produced', async () => {
    const { provider, f } = await world();
    provider.execResponses.set('cron runs', { code: 0, stderr: '', stdout: 'banner line\n' + JSON.stringify({ entries: [
      { action: 'finished', status: 'ok', summary: 'older', runAtMs: 100, durationMs: 5 },
      { action: 'started', runAtMs: 300 },
      { action: 'finished', status: 'error', error: 'boom', runAtMs: 200 },
    ] }) });
    const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/crons/job-1/runs?limit=5', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs.map((r: any) => [r.runAtMs, r.status])).toEqual([[200, 'error'], [100, 'ok']]);
    expect(provider.execLog).toContainEqual(['cron', 'runs', '--id', 'job-1', '--limit', '5']);
  });
});

describe('POST /v1/agents/:id/ask', () => {
  it('runs one agent turn and returns the answer', async () => {
    const { provider, f } = await world();
    provider.execResponses.set('agent --agent kitchen', { code: 0, stdout: 'Pasta tonight.\n', stderr: '' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/ask', headers: as, payload: { text: 'What is for dinner?' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reply: 'Pasta tonight.' });
    expect(provider.execLog).toContainEqual(['agent', '--agent', 'kitchen', '-m', 'What is for dinner?']);
  });

  it('is the owner\'s alone, needs a running agent and a message, and reports a failed turn', async () => {
    const { provider, f } = await world();
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/ask', headers: { 'x-hatchabot-owner': 'someone-else' }, payload: { text: 'hi' } })).statusCode).toBe(404);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/ask', headers: as, payload: { text: '   ' } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/ask', headers: as, payload: { text: 'x'.repeat(8001) } })).statusCode).toBe(413);
    provider.execResponses.set('agent --agent kitchen', { code: 1, stdout: '', stderr: 'gateway said no, with config detail' });
    const bad = await f.inject({ method: 'POST', url: '/v1/agents/a1/ask', headers: as, payload: { text: 'hi' } });
    expect(bad.statusCode).toBe(502);
    expect(bad.body).not.toContain('config detail'); // stderr stays on the server
    const stopped = await world('STOPPED');
    expect((await stopped.f.inject({ method: 'POST', url: '/v1/agents/a1/ask', headers: as, payload: { text: 'hi' } })).statusCode).toBe(409);
  });
});

describe('delivery (regression: tasks on a web-only agent failed every run)', () => {
  it('a task that does not announce says --no-deliver', async () => {
    const { addCron } = await import('../src/orchestrator/crons.js');
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    await addCron(p, ref, 'kitchen', { name: 'q', message: 'm', everyMs: 60_000, announce: false });
    expect(p.execLog.at(-1)).toContain('--no-deliver');
    await addCron(p, ref, 'kitchen', { name: 'a', message: 'm', everyMs: 60_000 });
    expect(p.execLog.at(-1)).toEqual(expect.arrayContaining(['--announce', '--best-effort-deliver']));
    expect(p.execLog.at(-1)).not.toContain('--no-deliver');
  });

  it('an agent with no chat app never announces, whatever was asked', async () => {
    const { provider, f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/crons', headers: as, payload: { name: 'brief', message: 'm', everyMinutes: 60 } });
    expect(res.statusCode).toBe(201);
    const add = provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')!;
    expect(add).toContain('--no-deliver');
    expect(add).not.toContain('--announce');
  });
});
