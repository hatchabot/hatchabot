import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { listCrons, setCronEnabled, runCronNow, deleteCron, CronSystemOwnedError } from '../src/orchestrator/crons.js';
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

/** A made-up Telegram id, built at run time so no id-shaped literal sits in the file. */
const TG_ID = ['55', '50', '0', '01'].join('');

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
    // …and the owner's Telegram id to post to (2026.9 refuses a delivery that names no one).
    store.insertMembership({ id: 'm-own', agentId: 'a1', userId: OWNER, role: 'owner', channelUserId: TG_ID, status: 'active' } as any);
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
    expect(call.join(' ')).toContain(`--channel telegram --to ${TG_ID}`);
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
    await addCron(p, ref, 'kitchen', { name: 'a', message: 'm', everyMs: 60_000, deliverTo: { channel: 'telegram', to: TG_ID } });
    expect(p.execLog.at(-1)).toEqual(expect.arrayContaining(['--announce', '--best-effort-deliver', '--channel', 'telegram', '--to', TG_ID]));
    expect(p.execLog.at(-1)).not.toContain('--no-deliver');
    // Announcing with no one to post to: OpenClaw 2026.9 refuses it every run, so it is quiet instead.
    await addCron(p, ref, 'kitchen', { name: 'b', message: 'm', everyMs: 60_000 });
    expect(p.execLog.at(-1)).toContain('--no-deliver');
    expect(p.execLog.at(-1)).not.toContain('--announce');
  });

  it('tasks that announce to no one are pointed at the owner\'s chat, or made quiet (2026-09-29)', async () => {
    const { retargetImplicitCrons } = await import('../src/orchestrator/crons.js');
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [
      { id: 'j1', name: 'brief', enabled: true, delivery: { mode: 'announce', channel: 'last', bestEffort: true } },
      { id: 'j2', name: 'mine', enabled: true, delivery: { mode: 'announce', channel: 'telegram', to: TG_ID } },
      { id: 'j3', name: 'quiet', enabled: true, delivery: { mode: 'none' } },
      { id: 'j4', name: 'upkeep', enabled: true, declarationKey: 'openclaw.dreaming', delivery: { mode: 'announce', channel: 'last' } },
    ] }) });
    const r = await retargetImplicitCrons(p, ref, 'kitchen', { channel: 'telegram', to: TG_ID });
    expect(r).toEqual({ changed: 1, failed: 0 });
    const edits = p.execLog.filter((a) => a[0] === 'cron' && a[1] === 'edit');
    expect(edits).toEqual([['cron', 'edit', 'j1', '--announce', '--best-effort-deliver', '--channel', 'telegram', '--to', TG_ID]]);
    // No chat app: the same task goes quiet instead of failing every run.
    await retargetImplicitCrons(p, ref, 'kitchen', undefined);
    expect(p.execLog.filter((a) => a[0] === 'cron' && a[1] === 'edit').at(-1)).toEqual(['cron', 'edit', 'j1', '--no-deliver']);
  });

  it('an agent with no chat app on an OpenClaw without conversation delivery stays quiet', async () => {
    const { provider, f } = await world(); // the mock reports OpenClaw "mock": not 2026.9+
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/crons', headers: as, payload: { name: 'brief', message: 'm', everyMinutes: 60 } });
    expect(res.statusCode).toBe(201);
    const add = provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')!;
    expect(add).toContain('--no-deliver');
    expect(add).not.toContain('--announce');
    expect(add).not.toContain('--session');
  });
});

describe('an agent in no chat app: results go to its console conversation (2026-09-30)', () => {
  const on2026_9 = (p: MockProvider, ref: string) => p.infoOverride.set(ref, { openclawVersion: '2026.9.6' });

  it('cronTargetFor: the owner\'s chat first, the console conversation only with no chat app at all', async () => {
    const { cronTargetFor } = await import('../src/orchestrator/crons.js');
    const { store } = await world();
    const agent = store.getAgent('a1')!;
    expect(cronTargetFor(store, agent)).toEqual({ session: 'agent:kitchen:main' });
    // In a chat app but the owner's id there is unknown: nowhere safe, quiet (not the console —
    // "last" in that conversation is whoever wrote last).
    store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'kitchenbot', secretRef: 'channel/a1/bot-token', deepLink: 'https://t.me/kitchenbot', createdAt: 'now' });
    expect(cronTargetFor(store, agent)).toBeUndefined();
    store.insertMembership({ id: 'm-own', agentId: 'a1', userId: OWNER, role: 'owner', channelUserId: TG_ID, status: 'active' } as any);
    expect(cronTargetFor(store, agent)).toEqual({ channel: 'telegram', to: TG_ID });
  });

  it('conversationDeliverySupported: 2026.9 and later only', async () => {
    const { conversationDeliverySupported } = await import('../src/orchestrator/crons.js');
    expect(conversationDeliverySupported('2026.9.6')).toBe(true);
    expect(conversationDeliverySupported('2026.10.1')).toBe(true);
    expect(conversationDeliverySupported('2027.1.0')).toBe(true);
    expect(conversationDeliverySupported('2026.7.1-2')).toBe(false);
    expect(conversationDeliverySupported('2026.8.3')).toBe(false);
    expect(conversationDeliverySupported(undefined)).toBe(false);
    expect(conversationDeliverySupported('mock')).toBe(false);
  });

  it('addCron binds the task to the conversation (current + its key), announcing with no channel, after making sure it exists', async () => {
    const { addCron } = await import('../src/orchestrator/crons.js');
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    on2026_9(p, ref);
    await addCron(p, ref, 'kitchen', { name: 'lunch', message: 'Suggest lunch.', cron: '30 11 * * *', tz: 'America/Toronto', deliverTo: { session: 'agent:kitchen:main' } });
    const add = p.execLog.at(-1)!;
    expect(add.slice(0, 2)).toEqual(['cron', 'add']);
    expect(add.join(' ')).toContain('--session current --session-key agent:kitchen:main --announce --best-effort-deliver');
    expect(add).not.toContain('--channel');
    expect(add).not.toContain('--to');
    expect(add).not.toContain('--no-deliver');
    // Before the add: the conversation is created, or adopted as it is.
    const create = p.execLog.at(-2)!;
    expect(create.slice(0, 4)).toEqual(['gateway', 'call', 'sessions.create', '--params']);
    expect(JSON.parse(create[4]!)).toEqual({ key: 'agent:kitchen:main', agentId: 'kitchen' });
    // Asked to be quiet: quiet, and no conversation is touched.
    const before = p.execLog.length;
    await addCron(p, ref, 'kitchen', { name: 'q', message: 'm', everyMs: 60_000, announce: false, deliverTo: { session: 'agent:kitchen:main' } });
    expect(p.execLog.slice(before).map((a) => a.slice(0, 2).join(' '))).toEqual(['cron add']);
    expect(p.execLog.at(-1)).toContain('--no-deliver');
  });

  it('a conversation target on an older OpenClaw is quiet, as before', async () => {
    const { addCron } = await import('../src/orchestrator/crons.js');
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.infoOverride.set(ref, { openclawVersion: '2026.7.1-2' });
    await addCron(p, ref, 'kitchen', { name: 'b', message: 'm', everyMs: 60_000, deliverTo: { session: 'agent:kitchen:main' } });
    expect(p.execLog.at(-1)).toContain('--no-deliver');
    expect(p.execLog.some((a) => a.includes('sessions.create'))).toBe(false);
  });

  it('ensureConversation leaves an existing conversation untouched, and refuses odd keys', async () => {
    const { ensureConversation } = await import('../src/orchestrator/crons.js');
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('sh', { code: 0, stdout: 'yes', stderr: '' });
    expect(await ensureConversation(p, ref, 'kitchen', 'agent:kitchen:main')).toBe(true);
    const probe = p.execLog.at(-1)!;
    expect(probe[0]).toBe('sh');
    expect(probe[1]).toContain('session_nodes');
    expect(probe[1]).toContain('"agent:kitchen:main"');
    expect(p.execLog.some((a) => a.includes('sessions.create'))).toBe(false);
    const n = p.execLog.length;
    expect(await ensureConversation(p, ref, 'kitchen', "agent:kitchen:main'; rm -rf /")).toBe(false);
    expect(await ensureConversation(p, ref, 'Kitchen!', 'agent:kitchen:main')).toBe(false);
    expect(p.execLog.length).toBe(n);
  });

  it('a failed sessions.create does not stop the task being made', async () => {
    const { addCron } = await import('../src/orchestrator/crons.js');
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    on2026_9(p, ref);
    p.execResponses.set('gateway call sessions.create', { code: 1, stdout: '', stderr: 'gateway busy' });
    p.execResponses.set('cron add', { code: 0, stdout: '{"id":"job-7"}', stderr: '' });
    expect(await addCron(p, ref, 'kitchen', { name: 'b', message: 'm', everyMs: 60_000, deliverTo: { session: 'agent:kitchen:main' } })).toEqual({ ok: true, id: 'job-7' });
  });

  it('POST …/crons on a web-only 2026.9 agent posts into the console conversation', async () => {
    const { provider, f, store } = await world();
    on2026_9(provider, store.getAgent('a1')!.runtimeRef!);
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/crons', headers: as, payload: { name: 'brief', message: 'm', everyMinutes: 60 } });
    expect(res.statusCode).toBe(201);
    const add = provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')!;
    expect(add.join(' ')).toContain('--session current --session-key agent:kitchen:main --announce');
    // …and quiet when asked (an edit of a quiet task keeps it quiet).
    const quiet = await f.inject({ method: 'POST', url: '/v1/agents/a1/crons', headers: as, payload: { name: 'q', message: 'm', everyMinutes: 60, announce: false } });
    expect(quiet.statusCode).toBe(201);
    expect(provider.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add').at(-1)).toContain('--no-deliver');
  });

  it('the sweep binds implicit tasks to the console conversation and leaves ones already bound to a conversation', async () => {
    const { retargetImplicitCrons } = await import('../src/orchestrator/crons.js');
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    on2026_9(p, ref);
    p.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [
      { id: 'j1', name: 'made in the app before', enabled: true, sessionTarget: 'isolated', delivery: { mode: 'announce', channel: 'last' } },
      { id: 'j2', name: 'asked for in the console', enabled: true, sessionTarget: 'current', sessionKey: 'agent:kitchen:main', delivery: { mode: 'announce', channel: 'last' } },
      { id: 'j3', name: 'asked for in web chat', enabled: true, sessionTarget: 'current', sessionKey: 'agent:kitchen:web:0123456789abcdef', delivery: { mode: 'announce', channel: 'last' } },
      { id: 'j4', name: 'quiet', enabled: true, sessionTarget: 'isolated', delivery: { mode: 'none' } },
      { id: 'j5', name: 'upkeep', enabled: true, declarationKey: 'openclaw.dreaming', delivery: { mode: 'announce', channel: 'last' } },
    ] }) });
    const r = await retargetImplicitCrons(p, ref, 'kitchen', { session: 'agent:kitchen:main' });
    expect(r).toEqual({ changed: 1, failed: 0 });
    expect(p.execLog.filter((a) => a[0] === 'cron' && a[1] === 'edit')).toEqual([
      ['cron', 'edit', 'j1', '--session', 'current', '--session-key', 'agent:kitchen:main', '--announce', '--best-effort-deliver'],
    ]);
    expect(p.execLog.filter((a) => a.includes('sessions.create'))).toHaveLength(1);
    // The same agent once it is in a chat app: every implicit one gets the owner's chat, bound or not.
    const r2 = await retargetImplicitCrons(p, ref, 'kitchen', { channel: 'telegram', to: TG_ID });
    expect(r2).toEqual({ changed: 3, failed: 0 });
    // Nothing to change: not even the version is asked.
    const p2 = new MockProvider();
    const ref2 = await seedRuntime(p2);
    p2.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [{ id: 'q', enabled: true, delivery: { mode: 'none' } }] }) });
    expect(await retargetImplicitCrons(p2, ref2, 'kitchen', { session: 'agent:kitchen:main' })).toEqual({ changed: 0, failed: 0 });
    expect(p2.execLog.map((a) => a.slice(0, 2).join(' '))).toEqual(['cron list']);
  });

  it('listCrons reads where a task runs and the conversation it is bound to', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [
      { id: 'j', enabled: true, sessionTarget: 'current', sessionKey: 'agent:kitchen:main', delivery: { mode: 'announce', channel: 'last' } },
      { id: 'k', enabled: true, sessionTarget: 'isolated', sessionKey: '' },
    ] }) });
    const [j, k] = await listCrons(p, ref, 'kitchen');
    expect(j).toMatchObject({ sessionTarget: 'current', sessionKey: 'agent:kitchen:main', announce: true, implicitDelivery: true });
    expect(k!.sessionTarget).toBe('isolated');
    expect(k!.sessionKey).toBeUndefined();
  });
});

describe("OpenClaw's own tasks (2026-09-25)", () => {
  it('a declared job is marked system, shown by its display name; removing or changing it is a clear refusal, not "may no longer exist"', async () => {
    const p = new MockProvider();
    const ref = await seedRuntime(p);
    p.execResponses.set('cron list', { code: 0, stdout: JSON.stringify({ jobs: [
      { id: 'sys-1', declarationKey: 'skill-collection-review:kitchen', displayName: 'Skill collection review (kitchen)', name: 'skill-collection-review-kitchen', enabled: true, schedule: { kind: 'every', everyMs: 604800000 }, payload: { kind: 'agentTurn', message: 'Review…' } },
      { id: 'job-9', name: 'Mine', enabled: true, schedule: { kind: 'cron', expr: '0 9 * * *' }, payload: { kind: 'agentTurn', message: 'x' } },
    ] }), stderr: '' });
    const crons = await listCrons(p, ref, 'kitchen');
    expect(crons.map((c) => [c.id, c.system, c.name])).toEqual([['sys-1', true, 'Skill collection review (kitchen)'], ['job-9', false, 'Mine']]);
    p.execResponses.set('cron rm', { code: 1, stdout: '', stderr: 'Error: system-owned monitor jobs cannot be removed by cron clients' });
    await expect(deleteCron(p, ref, 'sys-1')).rejects.toBeInstanceOf(CronSystemOwnedError);
    p.execResponses.set('cron disable', { code: 1, stdout: '', stderr: 'Error: system-owned monitor jobs cannot be edited by cron clients' });
    await expect(setCronEnabled(p, ref, 'sys-1', false)).rejects.toBeInstanceOf(CronSystemOwnedError);
    p.execResponses.set('cron rm', { code: 1, stdout: '', stderr: 'no such job' });
    expect(await deleteCron(p, ref, 'gone')).toBe(false); // still the plain "no longer exists" answer
  });
});

