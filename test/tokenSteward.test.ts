import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { READER_FLOORS, USAGE_READER_SCRIPT, type TokenHealthRaw } from '../src/orchestrator/usage.js';
import { sampleAgentUsage } from '../src/orchestrator/sourceUsage.js';
import { buildTokenHealth, incidentWords, injectedSize, loopSignals, THRESHOLDS } from '../src/orchestrator/tokenHealth.js';
import { LOOP_LINE, parseLoopLines } from '../src/orchestrator/loopLines.js';
import { runTokenWatch, TELL_PER_HOUR } from '../src/orchestrator/tokenWatch.js';
import { channelHandlerTimeoutMs, channelTimeoutEnv, CHANNEL_HANDLER_TIMEOUT_DEFAULT_MS } from '../src/orchestrator/channelTimeout.js';
import { compactAgent, compactArgv, nextProviderEntry, parseCompactResult, syncContextCap } from '../src/orchestrator/compaction.js';
import { buildRuntimeSpec, provisionAgent, syncDataSourceDocs } from '../src/orchestrator/provision.js';
import { OPS_AGENTS_MD, OPS_RENAMED_HEADINGS, OPS_SOUL, opsSection } from '../src/ops/opsAgent.js';
import { LEGACY_REVIEW_NAME, MODEL_REVIEW_NAME, reviewMessageHash, syncModelReviewCron } from '../src/orchestrator/modelReview.js';
import { OPS_MODEL_REVIEW_MESSAGE } from '../src/ops/opsAgent.js';
import { MANIFEST, toolDef } from '../src/mgmt/tools.js';
import { REST_BY_NAME } from '../src/mgmt/restTools.js';
import { riskOf } from '../src/mgmt/broker.js';
import { COVERAGE } from '../src/mgmt/coverage.js';
import { publicClassFor } from '../src/api/publicRoutes.js';
import { ENV_SETTINGS } from '../src/config/envCatalog.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * The token steward (docs/features.md, "Token steward"). Every figure, name
 * and id here is made up; the log lines follow OpenClaw 2026.9.6's formats.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const OWNER = 'user-owner';
const OTHER = 'user-other';
const H = { 'x-hatchabot-owner': OWNER };
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const T = THRESHOLDS;

// ---------------------------------------------------------------------------
// The reader's health part
// ---------------------------------------------------------------------------

function runReader(build: (root: string) => void): any {
  const base = mkdtempSync(join(tmpdir(), 'hb-token-'));
  const root = join(base, 'agents');
  mkdirSync(root, { recursive: true });
  build(root);
  const script = USAGE_READER_SCRIPT.replace('"/home/node/.openclaw/agents"', JSON.stringify(root));
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', script], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
const u = (input: number, output = 10, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const call = (model: string, usage: object, stopReason = 'stop', extra: object = {}) => ({ role: 'assistant', model, stopReason, usage, content: [{ type: 'text', text: 'x' }], ...extra });
const person = () => ({ role: 'user', content: 'hi' });
const followup = () => ({ role: 'user', content: 'done', provenance: { kind: 'internal_system', sourceTool: 'exec' } });

describe('the usage reader reads token health on its existing pass', () => {
  it('conversation size, cache by position, cost classes, thinking, compactions, loops, scheduled runs, retried messages, files and settings', () => {
    const now = Date.now();
    const out = runReader((root) => {
      mkdirSync(join(root, 'kitchen', 'agent'), { recursive: true });
      const db = new Database(join(root, 'kitchen', 'agent', 'openclaw-agent.sqlite'));
      db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
      db.exec('CREATE TABLE session_windows (session_id TEXT, session_key TEXT)');
      db.prepare('INSERT INTO session_windows VALUES (?, ?)').run('s1', 'agent:kitchen:main');
      db.prepare('INSERT INTO session_windows VALUES (?, ?)').run('s2', 'agent:kitchen:cron:job-1:run:7');
      db.prepare('INSERT INTO session_windows VALUES (?, ?)').run('s3', 'agent:kitchen:telegram:group:-100777');
      const ins = db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)');
      let seq = 0;
      const put = (sid: string, at: number, message: object) => ins.run(sid, seq++, at, JSON.stringify({ type: 'message', id: `e${seq}`, message }));
      const t0 = now - 3 * HOUR;
      // Main: a person's turn — first call (no earlier call), then two calls inside the turn.
      put('s1', t0, person());
      put('s1', t0 + 1, call('claude-sonnet-5', u(100, 10, 0, 200_000), 'toolUse', { content: [{ type: 'toolCall', id: 't', name: 'x', arguments: {} }] }));
      put('s1', t0 + 1000, call('claude-sonnet-5', u(100, 10, 200_000, 100)));
      // A new turn 1 minute later: its first call read only 20K back (the new-turn break).
      put('s1', t0 + MIN, person());
      put('s1', t0 + MIN + 1, call('claude-sonnet-5', u(100, 20, 20_000, 180_300), 'stop', { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'x' }] }));
      // After a pause of 20 minutes: a follow-up (a command finished).
      put('s1', t0 + 21 * MIN, followup());
      put('s1', t0 + 21 * MIN + 1, call('claude-sonnet-5', u(100, 10, 0, 200_500)));
      ins.run('s1', seq++, t0 + 22 * MIN, JSON.stringify({ type: 'compaction', id: 'c1', tokensBefore: 200_600 }));
      // Scheduled run: its own session.
      put('s2', t0, { role: 'user', content: '[cron:job-1]', provenance: { kind: 'internal_system', sourceTool: 'cron' } });
      put('s2', t0 + 1, call('claude-sonnet-5', u(1000, 100, 0, 5000)));
      // A group chat: a 25-tool turn, a run the loop guard stopped, three failing calls in a row.
      put('s3', t0, person());
      put('s3', t0 + 1, call('claude-sonnet-5', u(100, 10, 0, 1000), 'toolUse', { content: Array.from({ length: 25 }, (_, i) => ({ type: 'toolCall', id: `t${i}`, name: 'x', arguments: {} })) }));
      put('s3', t0 + 2, call('claude-sonnet-5', u(100, 10, 1000, 0)));
      put('s3', t0 + 10, person());
      put('s3', t0 + 11, call('claude-sonnet-5', u(0, 0), 'error', { errorMessage: 'OpenClaw stopped this run because tool-loop recovery encountered another critical loop.' }));
      put('s3', t0 + 12, call('claude-sonnet-5', u(0, 0), 'error', { errorMessage: 'overloaded' }));
      put('s3', t0 + 13, call('claude-sonnet-5', u(0, 0), 'error', { errorMessage: '429 rate_limit_error' }));
      put('s3', t0 + 20, person());
      put('s3', t0 + 21, call('claude-sonnet-5', u(100, 10, 0, 500)));
      db.close();
      writeFileSync(join(root, 'kitchen', 'agent', 'AGENTS.md'), 'a'.repeat(25_000));
      writeFileSync(join(root, 'kitchen', 'agent', 'SOUL.md'), 's'.repeat(500));
      writeFileSync(join(root, 'kitchen', 'agent', 'MEMORY.md'), 'm'.repeat(30_000));
      writeFileSync(join(root, '..', 'openclaw.json'), JSON.stringify({
        agents: { defaults: { thinkingDefault: 'low', models: { 'anthropic/claude-sonnet-5': { params: { thinking: 'high' } } } }, list: [{ id: 'kitchen', thinkingDefault: 'medium' }] },
        models: { providers: { anthropic: { models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', contextTokens: 150_000 }] } } },
      }));
      mkdirSync(join(root, '..', 'state'), { recursive: true });
      const st = new Database(join(root, '..', 'state', 'openclaw.sqlite'));
      st.exec('CREATE TABLE cron_jobs (job_id TEXT, name TEXT, enabled INTEGER, declaration_key TEXT)');
      st.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?)').run('job-1', 'Morning prices', 1, null);
      st.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?, ?)').run('sys-1', 'skill review', 1, 'skill-collection-review:kitchen');
      st.exec('CREATE TABLE cron_run_receipts (job_id TEXT, status TEXT, started_at_ms INTEGER, finished_at_ms INTEGER)');
      const run = st.prepare('INSERT INTO cron_run_receipts VALUES (?, ?, ?, ?)');
      const r0 = now - 6 * HOUR;
      run.run('job-1', 'ok', r0, r0 + 1000);
      run.run('job-1', 'error', r0 + HOUR, r0 + HOUR + 1000);
      run.run('job-1', 'error', r0 + HOUR + 5 * MIN, r0 + HOUR + 5 * MIN + 1000);
      run.run('job-1', 'interrupted', r0 + HOUR + 10 * MIN, r0 + HOUR + 10 * MIN + 1000);
      run.run('sys-1', 'error', r0, r0 + 1); // OpenClaw's own upkeep: not the owner's task
      st.exec(`CREATE TABLE channel_ingress_events (queue_name TEXT, event_id TEXT, channel_id TEXT, account_id TEXT, status TEXT, lane_key TEXT, payload_json TEXT,
        received_at INTEGER, updated_at INTEGER, attempts INTEGER, last_attempt_at INTEGER, last_error TEXT, failed_reason TEXT)`);
      const ing = st.prepare('INSERT INTO channel_ingress_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      ing.run('q', '000123', 'telegram', 'kitchenbot', 'pending', 'telegram:9', '{"text":"secret words"}', now - 2 * HOUR, now - MIN, 8, now - MIN,
        'Channel ingress claim→adoption stalled for event 123 on lane telegram:9 after 300000ms; applying retry policy (handler-timeout).', null);
      ing.run('q', '000124', 'telegram', 'kitchenbot', 'completed', 'telegram:9', '{}', now - HOUR, now - HOUR, 1, null, null, null);
      st.close();
    });
    const h = out.health as TokenHealthRaw;
    expect(h.v).toBe(1);
    // Context per call, conversations only (the cron call is not one): main 4 calls + group 3 calls with tokens.
    expect(h.conv.calls).toBe(7);
    expect(h.conv.max).toBe(200_600);
    expect(h.conv.over100k).toBe(4);
    expect(h.main.kitchen).toMatchObject({ ctx: 200_600 });
    expect(h.top[0]).toMatchObject({ kind: 'main', ctx: 200_600 });
    expect(h.top.some((t) => t.kind === 'group')).toBe(true);
    // Cache: [calls, read, carried]: warm first calls (main: 20K of 200.4K; the group's last turn), one after a pause, inside calls.
    expect(h.cache.first5).toEqual([2, 20_000, 201_000]);
    expect(h.cache.firstCold[0]).toBe(1);
    expect(h.cache.inside[0]).toBe(2);
    // Cost classes by what started the turn.
    expect(Object.keys(h.split.chat)).toEqual(['claude-sonnet-5']);
    expect(h.split.followup['claude-sonnet-5']).toEqual([100, 10, 0, 200_500]);
    expect(h.split.scheduled['claude-sonnet-5']).toEqual([1000, 100, 0, 5000]);
    expect(h.jobTokens['job-1']!['claude-sonnet-5']).toEqual([1000, 100, 0, 5000]);
    expect(h.thinking).toEqual({ calls: 1, of: 7 });
    expect(h.compactions).toMatchObject({ n: 1, before: 200_600 });
    // Loops from the transcripts.
    expect(h.big.map(([, n]) => n)).toEqual([25]);
    expect(h.guard).toHaveLength(1);
    expect(h.streaks).toEqual([[expect.any(Number), expect.any(Number), 3, 1]]);
    // Scheduled runs: the owner's task only; three failures in a row, two started soon after an error.
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs![0]).toMatchObject({ id: 'job-1', name: 'Morning prices', runs: 4, ok: 1, error: 2, interrupted: 1, streak: 3, lastStatus: 'interrupted' });
    expect(h.jobs![0]!.rr.map(([, gap]) => gap)).toEqual([5 * MIN - 1000, 5 * MIN - 1000]);
    // Retried messages: only those tried more than once; no payload, no error text.
    expect(h.ingress).toEqual([{ ch: 'telegram', acct: 'kitchenbot', id: '123', st: 'pending', att: 8, first: expect.any(Number), last: expect.any(Number), why: 'handler-timeout', fr: '' }]);
    expect(JSON.stringify(out)).not.toContain('secret words');
    expect(JSON.stringify(out)).not.toContain('lane telegram');
    // Files and settings.
    expect(h.files.kitchen).toEqual({ 'AGENTS.md': 25_000, 'SOUL.md': 500, 'MEMORY.md': 30_000 });
    expect(h.cfg).toMatchObject({ thinkingDefault: 'low', agentThinking: { kitchen: 'medium' }, modelThinking: { 'anthropic/claude-sonnet-5': 'high' }, caps: { 'anthropic/claude-sonnet-5': 150_000 } });
  });

  it('an agent with none of the new tables still reads (health has empty parts)', () => {
    const out = runReader((root) => { mkdirSync(join(root, 'kitchen', 'agent'), { recursive: true }); });
    expect(out.health).toMatchObject({ v: 1, conv: { calls: 0 }, jobs: null, ingress: null, big: [], guard: [], streaks: [] });
  });

  it('its floors sit below every threshold that reads them', () => {
    expect(USAGE_READER_SCRIPT).toContain(`BIG_TURN_FLOOR = ${READER_FLOORS.bigTurn}`);
    expect(USAGE_READER_SCRIPT).toContain(`STREAK_FLOOR = ${READER_FLOORS.streak}`);
    expect(T.toolLoopTurn).toBeGreaterThanOrEqual(READER_FLOORS.bigTurn);
    expect(T.failStreak).toBeGreaterThanOrEqual(READER_FLOORS.streak);
    expect(T.limitStreak).toBeGreaterThanOrEqual(READER_FLOORS.streak);
  });
});

// ---------------------------------------------------------------------------
// The gateway log's loop lines
// ---------------------------------------------------------------------------

const stallLine = (at: string, id = '123', ms = 300012) =>
  `${at} 2026-10-04T08:24:30.598+00:00 [telegram] Channel ingress claim→adoption stalled for event ${id} on lane telegram:555:topic after ${ms}ms; applying retry policy (handler-timeout).`;
const keepLine = (at: string, id = '123') => `${at} x [telegram] spooled update ${id} failed; keeping for retry: Channel ingress claim→adoption stalled`;

describe('loop lines in the gateway log', () => {
  it('keeps kind, event and time — never the lane (a chat id) or other text', () => {
    const text = [
      stallLine('2026-10-04T12:24:30.598999887Z'),
      keepLine('2026-10-04T12:24:30.700000000Z'),
      '2026-10-04T12:25:00.000000000Z [telegram] spooled update 0099 on lane telegram:555 reached retry limit after 8 attempts; dead-lettered',
      '2026-10-04T12:26:00.000000000Z [agents] context-engine compaction failed {"errorMessage":"timeout"}',
      '2026-10-04T12:19:30.000000000Z [compaction-diag] start runId=r sessionKey=agent:stock:main diagId=d trigger=manual provider=anthropic/claude-opus-4-8 attempt=1',
      '2026-10-04T12:27:00.000000000Z [model-fetch] response provider=anthropic model=claude-opus-4-8 status=200 elapsedMs=3000',
      '2026-10-04T12:28:00.000000000Z an unrelated line',
    ].join('\n');
    const marks = parseLoopLines(text);
    expect(marks).toEqual([
      { kind: 'stall', key: '123', at: '2026-10-04T12:24:30.598Z', ms: 300012, channel: 'telegram' },
      { kind: 'retry', key: '123', at: '2026-10-04T12:24:30.700Z', channel: 'telegram' },
      { kind: 'deadletter', key: '99', at: '2026-10-04T12:25:00.000Z', channel: 'telegram' },
      { kind: 'compactFail', key: '', at: '2026-10-04T12:26:00.000Z' },
      { kind: 'compactStart', key: '', at: '2026-10-04T12:19:30.000Z' },
    ]);
    expect(JSON.stringify(marks)).not.toContain('555');
    // The provider's streamed filter keeps exactly these beside the model calls.
    expect(text.split('\n').filter((l) => LOOP_LINE.test(l))).toHaveLength(5);
  });

  it('the usage pass stores them from its existing log read, and a re-read adds nothing twice', async () => {
    const { store, provider } = await world();
    const a = store.getAgent('a1')!;
    provider.modelCallLines = [stallLine('2026-10-04T12:24:30.598Z'), stallLine('2026-10-04T12:29:31.000Z')].join('\n');
    await sampleAgentUsage({ store, providerFor: () => provider }, a, Date.parse('2026-10-04T12:30:00Z'));
    await sampleAgentUsage({ store, providerFor: () => provider }, a, Date.parse('2026-10-04T12:40:00Z'));
    expect(store.loopMarks(['a1'], '2026-10-01T00:00:00Z').map((m) => m.kind)).toEqual(['stall', 'stall']);
  });
});

// ---------------------------------------------------------------------------
// Loop signals and their thresholds
// ---------------------------------------------------------------------------

function health(p: Partial<TokenHealthRaw> = {}): TokenHealthRaw {
  return {
    v: 1, since: Date.now() - 30 * DAY, conv: { calls: 0, p50: 0, p90: 0, max: 0, over100k: 0 }, main: {}, top: [],
    cache: { first5: [0, 0, 0], firstCold: [0, 0, 0], inside: [0, 0, 0] }, split: { chat: {}, followup: {}, scheduled: {} }, jobTokens: {},
    thinking: { calls: 0, of: 0 }, cfg: null, files: {}, compactions: { n: 0, last: 0, before: 0 }, jobs: null, ingress: null, big: [], guard: [], streaks: [], ...p,
  };
}
const iso = (t: number) => new Date(t).toISOString();

describe('loop signals', () => {
  const now = Date.parse('2026-10-04T16:00:00Z');
  const stalls = (n: number, lastAgo = 2 * MIN) => Array.from({ length: n }, (_, i) => ({ kind: 'stall', key: '123', channel: 'telegram', ms: 300_000, at: iso(now - lastAgo - (n - 1 - i) * 5 * MIN) }));

  it('(a) the same channel message retried: from channelRetryLoop on, active while recent, a compaction when one started it', () => {
    expect(loopSignals({ agentId: 'a1', marks: stalls(T.channelRetryLoop - 1), now })).toEqual([]);
    const marks = [...stalls(12), { kind: 'compactStart', key: '', at: iso(now - 2 * MIN - 11 * 5 * MIN - 5 * MIN) }];
    const [s] = loopSignals({ agentId: 'a1', marks, now });
    expect(s).toMatchObject({ kind: 'channel-retry', key: 'telegram:123', count: 12, active: true, detail: { channel: 'telegram', limitMs: 300_000, compaction: true } });
    // The attempt began a limit before its first stall.
    expect(Date.parse(s!.first)).toBe(now - 2 * MIN - 11 * 5 * MIN - 300_000);
    // Quiet for longer than channelActiveMs: still a signal, no longer going.
    expect(loopSignals({ agentId: 'a1', marks: stalls(5, T.channelActiveMs + MIN), now })[0]).toMatchObject({ active: false });
    // The queue's own row says it is still pending: going, whatever the log.
    const row = { ch: 'telegram', acct: 'b', id: '123', st: 'pending', att: 4, first: now - HOUR, last: now - HOUR, why: 'handler-timeout', fr: '' };
    expect(loopSignals({ agentId: 'a1', health: health({ ingress: [row] }), marks: [], now })[0]).toMatchObject({ count: 4, active: true, detail: { compaction: false } });
    // Completed after 8 tries = 7 failed, and over.
    expect(loopSignals({ agentId: 'a1', health: health({ ingress: [{ ...row, st: 'completed', att: 8 }] }), marks: [], now })[0]).toMatchObject({ count: 7, active: false });
    // A stall and its "keeping for retry" line are one retry.
    const pair = stalls(3).flatMap((m) => [m, { ...m, kind: 'retry', at: iso(Date.parse(m.at) + 100) }]);
    expect(loopSignals({ agentId: 'a1', marks: pair, now })[0]!.count).toBe(3);
  });

  it('(b) compactions failing: compactionFailLoop within the window', () => {
    const fails = (n: number, spacing: number) => Array.from({ length: n }, (_, i) => ({ kind: 'compactFail', key: '', at: iso(now - (n - i) * spacing) }));
    expect(loopSignals({ agentId: 'a1', marks: fails(T.compactionFailLoop - 1, 10 * MIN), now })).toEqual([]);
    expect(loopSignals({ agentId: 'a1', marks: fails(T.compactionFailLoop, 10 * MIN), now })[0]).toMatchObject({ kind: 'compaction-failing', count: 3, active: true });
    // Spread wider than the window: not a loop.
    expect(loopSignals({ agentId: 'a1', marks: fails(3, T.compactionFailWindowMs), now })).toEqual([]);
  });

  it('(c) a scheduled task failing in a row, or re-run soon after errors', () => {
    const job = (p: object) => ({ id: 'job-1', name: 'Morning prices', runs: 10, ok: 5, error: 3, interrupted: 0, skipped: 0, streak: 0, first: now - 5 * DAY, last: now - HOUR, lastStatus: 'ok', rr: [] as Array<[number, number]>, ...p });
    expect(loopSignals({ agentId: 'a1', health: health({ jobs: [job({ streak: T.taskFailStreak - 1, lastStatus: 'error' })] }), marks: [], now })).toEqual([]);
    expect(loopSignals({ agentId: 'a1', health: health({ jobs: [job({ streak: T.taskFailStreak, lastStatus: 'error' })] }), marks: [], now })[0])
      .toMatchObject({ kind: 'task-failing', key: 'job-1', count: 3, active: true, detail: { task: 'Morning prices' } });
    const rr: Array<[number, number]> = [[now - 3 * HOUR, 2 * MIN], [now - 2 * HOUR, 3 * MIN], [now - HOUR, T.taskRerunWindowMs]];
    expect(loopSignals({ agentId: 'a1', health: health({ jobs: [job({ rr, lastStatus: 'error' })] }), marks: [], now })[0]).toMatchObject({ detail: { reruns: 3 } });
    expect(loopSignals({ agentId: 'a1', health: health({ jobs: [job({ rr: rr.map(([a]) => [a, T.taskRerunWindowMs + 1] as [number, number]) })] }), marks: [], now })).toEqual([]);
    // Fixed since (the last run was fine): history, not an incident.
    expect(loopSignals({ agentId: 'a1', health: health({ jobs: [job({ streak: 3, lastStatus: 'ok' })] }), marks: [], now })[0]).toMatchObject({ active: false });
    // Switched off by the owner: history, not a live loop (2026-10-04, Meeting Scheduler's paused watchdog).
    expect(loopSignals({ agentId: 'a1', health: health({ jobs: [job({ streak: 11, lastStatus: 'error', off: true })] }), marks: [], now })[0]).toMatchObject({ active: false });
    // Last failed more than taskActiveMs ago: history too.
    expect(loopSignals({ agentId: 'a1', health: health({ jobs: [job({ streak: 11, lastStatus: 'error', last: now - T.taskActiveMs - HOUR })] }), marks: [], now })[0]).toMatchObject({ active: false });
  });

  it('(d) two agents consulting each other back and forth, from Hatchabot\'s own records', () => {
    const consults = (n: number, gap: number) => Array.from({ length: n }, (_, i) => (i % 2 ? { from: 'a1', to: 'a2' } : { from: 'a2', to: 'a1' }))
      .map((c, i) => ({ ...c, at: iso(now - (n - i) * gap) }));
    expect(loopSignals({ agentId: 'a1', marks: [], consults: consults(T.pingPongMin - 1, MIN), now })).toEqual([]);
    expect(loopSignals({ agentId: 'a1', marks: [], consults: consults(T.pingPongMin, MIN), now })[0]).toMatchObject({ kind: 'consult-ping-pong', key: 'a2', count: 6, active: true });
    // One way only is not ping-pong; nor are consults far apart.
    const oneWay = consults(8, MIN).map((c) => ({ ...c, from: 'a1', to: 'a2' }));
    expect(loopSignals({ agentId: 'a1', marks: [], consults: oneWay, now })).toEqual([]);
    expect(loopSignals({ agentId: 'a1', marks: [], consults: consults(8, T.pingPongGapMs + MIN), now })).toEqual([]);
  });

  it('(e) runaway tool loops and (f) model calls failing in a row, rate limits apart', () => {
    expect(loopSignals({ agentId: 'a1', health: health({ big: [[now - HOUR, T.toolLoopTurn - 1]] }), marks: [], now })).toEqual([]);
    expect(loopSignals({ agentId: 'a1', health: health({ big: [[now - HOUR, T.toolLoopTurn]] }), marks: [], now })[0]).toMatchObject({ kind: 'tool-loop', count: 1, detail: { maxTools: 80 } });
    expect(loopSignals({ agentId: 'a1', health: health({ guard: [now - HOUR] }), marks: [], now })[0]).toMatchObject({ kind: 'tool-loop', detail: { guardStops: 1 } });
    expect(loopSignals({ agentId: 'a1', health: health({ streaks: [[now - HOUR, now - 50 * MIN, T.failStreak - 1, 0]] }), marks: [], now })).toEqual([]);
    const [f] = loopSignals({ agentId: 'a1', health: health({ streaks: [[now - HOUR, now - 50 * MIN, 7, 1]] }), marks: [], now });
    expect(f).toMatchObject({ kind: 'model-failing', count: 6, active: true });
    const [l] = loopSignals({ agentId: 'a1', health: health({ streaks: [[now - HOUR, now - 50 * MIN, 6, 6]] }), marks: [], now });
    expect(l).toMatchObject({ kind: 'rate-limited', count: 6 });
    // Older than activeMs: listed, not going.
    expect(loopSignals({ agentId: 'a1', health: health({ guard: [now - T.activeMs - MIN] }), marks: [], now })[0]).toMatchObject({ active: false });
  });

  it('the thresholds are stated and in the order the evidence gave them', () => {
    expect(T.compactNow).toBeGreaterThan(T.largeConversation);
    expect(T.suggestedCap).toBeGreaterThanOrEqual(T.capMin);
    expect(T.suggestedCap).toBeLessThanOrEqual(T.capMax);
    expect(T.instructionChars).toBeLessThan(T.bootstrapTotalMaxChars);
    expect(T.channelActiveMs).toBeGreaterThan(300_000 + 180_000); // the 5-minute limit + OpenClaw's 3-minute backoff cap
    expect(Object.isFrozen(T) || typeof T === 'object').toBe(true);
  });

  it('words the incident as the owner reads it, with the fix', () => {
    const s = { kind: 'channel-retry' as const, key: 'telegram:123', count: 12, first: '2026-10-04T12:19:30Z', last: '2026-10-04T16:00:00Z', active: true,
      detail: { channel: 'telegram', limitMs: 300_000, compaction: true } };
    const w = incidentWords(s, { conversationK: 446, now: Date.parse('2026-10-04T16:00:00Z'), fleetLimitMs: 1_800_000 });
    expect(w.text).toMatch(/^Stuck: Telegram message retried 12 times since (\w{3} \d+ )?\d\d:\d\d — compacting a 446K conversation takes longer than the 5-minute limit$/);
    expect(w.fix).toMatch(/last 200 lines/);
    expect(w.fix).toMatch(/30-minute limit/);
    expect(incidentWords({ ...s, detail: { ...s.detail, compaction: false } }).text).toMatch(/did not get going within the 5-minute limit/);
  });
});

// ---------------------------------------------------------------------------
// The report, the watcher, the routes
// ---------------------------------------------------------------------------

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', models: ['claude-haiku-4-5'], secretRef: 'ai/p1', createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p2', ownerId: OTHER, name: 'Theirs', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p2', createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p3', ownerId: OWNER, name: 'Local', vendor: 'local', kind: 'api_key', model: 'qwen3:8b', secretRef: 'ai/p3', createdAt: 'now' } as never);
  const add = async (id: string, owner: string, name: string, profile = owner === OWNER ? 'p1' : 'p2') => {
    const { runtimeRef } = await provider.provision({ agentId: id, slug: name.toLowerCase(), workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} } as never);
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: owner, name, slug: name.toLowerCase(), state: 'RUNNING', runtimeRef, aiProfileId: profile, hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
  };
  await add('a1', OWNER, 'Stock');
  await add('a2', OWNER, 'Kitchen');
  await add('b1', OTHER, 'Theirs');
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never });
  return { store, provider, f };
}

const stuckHealth = (now: number) => health({
  conv: { calls: 120, p50: 380_000, p90: 410_000, max: 460_000, over100k: 120 },
  main: { stock: { ctx: 446_000, at: now - 3 * HOUR } },
  cache: { first5: [40, 400_000, 4_000_000], firstCold: [30, 0, 3_000_000], inside: [200, 19_000_000, 20_000_000] },
  split: { chat: { 'claude-sonnet-5': [1000, 50_000, 10_000_000, 2_000_000] }, followup: {}, scheduled: { 'claude-sonnet-5': [10, 1000, 0, 100_000] } },
  jobTokens: { 'job-1': { 'claude-sonnet-5': [10, 1000, 0, 100_000] } },
  jobs: [{ id: 'job-1', name: 'Prices', runs: 10, ok: 10, error: 0, interrupted: 0, skipped: 0, streak: 0, first: now - 10 * DAY, last: now - HOUR, lastStatus: 'ok', rr: [] }],
  files: { stock: { 'AGENTS.md': 13_000, 'SOUL.md': 700, 'MEMORY.md': 30_500 } },
  thinking: { calls: 90, of: 120 },
  ingress: [{ ch: 'telegram', acct: 'stockbot', id: '123', st: 'pending', att: 12, first: now - 4 * HOUR, last: now - 2 * MIN, why: 'handler-timeout', fr: '' }],
});

describe('get_token_health', () => {
  it('is the owner\'s agents only, from stored data (nothing is run in a container), with flags and the cost split', async () => {
    const { store, provider, f } = await world();
    const now = Date.now();
    store.setTokenHealth('a1', stuckHealth(now), iso(now - 30 * MIN));
    store.setTokenHealth('b1', stuckHealth(now), iso(now));
    store.addLoopMarks('a1', [{ kind: 'compactStart', key: '', at: iso(now - 4 * HOUR + MIN) }]);
    const before = provider.execLog.length;
    const r = await f.inject({ method: 'GET', url: '/v1/token-health', headers: H });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(provider.execLog.length).toBe(before);
    expect(body.rows.map((x: any) => x.agent).sort()).toEqual(['Kitchen', 'Stock']);
    const row = body.rows.find((x: any) => x.agent === 'Stock');
    expect(row.conversation).toMatchObject({ ctxK: { p50: 380, p90: 410, max: 460 }, mainNowK: 446, over100kShare: 1 });
    expect(row.cache).toMatchObject({ firstOfTurnHit: 0.1, insideHit: 0.95 });
    expect(row.cost30d.chat).toBeGreaterThan(row.cost30d.scheduled);
    expect(row.scheduled.perTask[0]).toMatchObject({ id: 'job-1', runs: 10, failed: 0 });
    expect(row.scheduled.perTask[0].costPerRunUSD).toBeGreaterThan(0);
    expect(row.instructions).toMatchObject({ injectedChars: 13_000 + 700 + 20_000, truncated: ['MEMORY.md'] });
    expect(row.thinking).toMatchObject({ level: 'model default', shareOfCalls: 0.75 });
    expect(row.flags).toEqual(expect.arrayContaining(['large-conversation', 'compact-now', 'cache-break', 'big-instructions', 'thinking-heavy', 'loop']));
    expect(row.loops[0]).toMatchObject({ kind: 'channel-retry', count: 12, active: true, detail: { compaction: true } });
    expect(row.readHoursAgo).toBe(0.5);
    // One agent by name; another account's is not found.
    expect((await f.inject({ method: 'GET', url: '/v1/token-health?agent=stock', headers: H })).json().rows).toHaveLength(1);
    expect((await f.inject({ method: 'GET', url: '/v1/token-health?agent=Theirs', headers: H })).statusCode).toBe(404);
  });

  it('counts what OpenClaw injects into every turn: 20K a file, 60K in all, BOOTSTRAP.md only once', () => {
    expect(injectedSize({ 'AGENTS.md': 25_000, 'SOUL.md': 500, 'MEMORY.md': 30_000, 'BOOTSTRAP.md': 9_000 })).toEqual({ chars: 40_500, truncated: ['AGENTS.md', 'MEMORY.md'] });
    expect(injectedSize({ 'AGENTS.md': 30_000, 'SOUL.md': 30_000, 'MEMORY.md': 30_000, 'USER.md': 30_000 }).chars).toBe(60_000);
  });

  it('the scorecard\'s scheduled task count rides along; a local model has no cost', async () => {
    const { store } = await world();
    store.setModelProfile('a1', { since: 0, models: {}, promptErrors: 0, crons: 2, firstCall: 0 }, iso(Date.now()));
    store.setTokenHealth('a1', stuckHealth(Date.now()), iso(Date.now()));
    expect(buildTokenHealth(store, OWNER, { agentId: 'a1' }).rows[0]!.scheduled!.tasks).toBe(2);
    (store as any).db.prepare('UPDATE agents SET ai_profile_id = ? WHERE id = ?').run('p3', 'a1');
    expect(buildTokenHealth(store, OWNER, { agentId: 'a1' }).rows[0]!.cost30d).toBeUndefined();
  });
});

describe('the loop watcher', () => {
  it('opens a Needs-you incident, tells it once on the manager\'s chat, keeps it updated, and clears it when the loop stops', async () => {
    const { store, f } = await world();
    const now = Date.now();
    store.setTokenHealth('a1', stuckHealth(now), iso(now));
    store.addLoopMarks('a1', [{ kind: 'compactStart', key: '', at: iso(now - 4 * HOUR + MIN) }]);
    const told: string[] = [];
    const tell = async (_o: string, _a: unknown, text: string) => { told.push(text); return true; };
    const opened = await runTokenWatch({ store, tell }, now);
    expect(opened).toHaveLength(1);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/"Stock" — Stuck: Telegram message retried 12 times since .* — compacting a 446K conversation takes longer than the 5-minute limit\.\nFix: .*last 200 lines/);
    // On the owner's list, as Needs you; not on another account's.
    const listed = (await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json();
    expect(listed.find((a: any) => a.id === 'a1').stuck[0]).toMatchObject({ kind: 'channel-retry', text: expect.stringMatching(/^Stuck: Telegram message retried 12 times/) });
    expect(listed.find((a: any) => a.id === 'a2').stuck).toBeUndefined();
    const inc = (await f.inject({ method: 'GET', url: '/v1/token-incidents', headers: H })).json();
    expect(inc.open).toHaveLength(1);
    expect(inc.open[0]).toMatchObject({ agent: 'Stock', count: 12, told: true });
    expect((await f.inject({ method: 'GET', url: '/v1/token-incidents', headers: { 'x-hatchabot-owner': OTHER } })).json().open).toEqual([]);
    // Still going ten minutes later: updated, not told again.
    const h2 = stuckHealth(now); h2.ingress![0]!.att = 14;
    store.setTokenHealth('a1', h2, iso(now + 10 * MIN));
    expect(await runTokenWatch({ store, tell }, now + 10 * MIN)).toHaveLength(0);
    expect(told).toHaveLength(1);
    expect(store.listTokenIncidents({ open: true })[0]!.count).toBe(14);
    // It went through: cleared, off Needs you.
    const h3 = stuckHealth(now); h3.ingress![0]!.st = 'completed';
    store.setTokenHealth('a1', h3, iso(now + 20 * MIN));
    await runTokenWatch({ store, tell }, now + 20 * MIN);
    expect(store.listTokenIncidents({ open: true })).toHaveLength(0);
    expect((await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json().find((a: any) => a.id === 'a1').stuck).toBeUndefined();
    expect((await f.inject({ method: 'GET', url: '/v1/token-incidents', headers: H })).json().recent).toHaveLength(1);
  });

  it('tells at most TELL_PER_HOUR an hour per owner; the rest wait their turn, and are all under Needs you meanwhile', async () => {
    const { store } = await world();
    const now = Date.now();
    // Five failing tasks on one agent: five incidents.
    const jobs = Array.from({ length: 5 }, (_, i) => ({ id: `job-${i}`, name: `Task ${i}`, runs: 5, ok: 0, error: 5, interrupted: 0, skipped: 0, streak: 5, first: now - DAY, last: now - HOUR, lastStatus: 'error', rr: [] as Array<[number, number]> }));
    store.setTokenHealth('a2', health({ jobs }), iso(now));
    const told: string[] = [];
    const tell = async (_o: string, _a: unknown, text: string) => { told.push(text); return true; };
    await runTokenWatch({ store, tell }, now);
    expect(store.listTokenIncidents({ open: true })).toHaveLength(5);
    expect(told).toHaveLength(TELL_PER_HOUR);
    await runTokenWatch({ store, tell }, now + 10 * MIN);
    expect(told).toHaveLength(TELL_PER_HOUR);
    await runTokenWatch({ store, tell }, now + 61 * MIN);
    expect(told).toHaveLength(5);
    expect(new Set(told).size).toBe(5);
  });

  it('a loop seen again after a quiet pass reopens the same incident without telling again', async () => {
    const { store } = await world();
    const now = Date.now();
    const told: string[] = [];
    const tell = async (_o: string, _a: unknown, text: string) => { told.push(text); return true; };
    store.setTokenHealth('a1', stuckHealth(now), iso(now));
    await runTokenWatch({ store, tell }, now);
    const quiet = stuckHealth(now); quiet.ingress![0]!.st = 'completed';
    store.setTokenHealth('a1', quiet, iso(now));
    await runTokenWatch({ store, tell }, now + MIN);
    store.setTokenHealth('a1', stuckHealth(now), iso(now));
    await runTokenWatch({ store, tell }, now + 2 * MIN);
    expect(store.listTokenIncidents({ open: true })).toHaveLength(1);
    expect(told).toHaveLength(1);
  });

  it('runs on the usage pass\'s timer: no new interval, and a rate limit is not an incident', async () => {
    const { store } = await world();
    const now = Date.now();
    store.setTokenHealth('a1', health({ streaks: [[now - HOUR, now - 50 * MIN, 9, 9]] }), iso(now));
    await runTokenWatch({ store, tell: async () => true }, now);
    expect(store.listTokenIncidents({ open: true })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

describe('compaction', () => {
  it('runs OpenClaw\'s own sessions compact in the container, 30 minutes, JSON; lines mode passes --max-lines', () => {
    expect(compactArgv('stock', 'agent:stock:main', 'summarise')).toEqual(['sessions', 'compact', 'agent:stock:main', '--agent', 'stock', '--timeout', '1800000', '--json']);
    expect(compactArgv('stock', 'agent:stock:main', 'lines', 200)).toEqual(['sessions', 'compact', 'agent:stock:main', '--agent', 'stock', '--timeout', '1800000', '--json', '--max-lines', '200']);
  });

  it('reads OpenClaw\'s answer: compacted, nothing to do, busy, aborted, failed', () => {
    const ok = (o: object, code = 0, stderr = '') => parseCompactResult({ code, stdout: JSON.stringify(o), stderr });
    expect(ok({ ok: true, compacted: true, result: { tokensBefore: 446_000, tokensAfter: 61_000 } })).toEqual({ outcome: 'ok', tokensBefore: 446_000, tokensAfter: 61_000 });
    expect(ok({ ok: true, compacted: true, kept: 200 })).toEqual({ outcome: 'ok', kept: 200 });
    expect(ok({ ok: true, compacted: false, reason: 'no transcript' })).toMatchObject({ outcome: 'nothing', reason: 'no transcript' });
    expect(ok({ ok: false, error: 'Session agent:stock:main has an active run; retry after it finishes.' }, 1)).toMatchObject({ outcome: 'busy' });
    expect(ok({ ok: false, reason: 'aborted | user_abort' }, 1)).toMatchObject({ outcome: 'aborted' });
    expect(parseCompactResult({ code: 1, stdout: '', stderr: 'gateway closed', timedOut: true })).toMatchObject({ outcome: 'failed', reason: 'it took longer than 30 minutes' });
  });

  it('a card the owner confirms: POST /v1/agents/:id/compact keeps the last lines now, and the ledger has it with before and after', async () => {
    const { store, provider, f } = await world();
    store.setTokenHealth('a1', stuckHealth(Date.now()), iso(Date.now()));
    provider.execResponses.set('sessions compact', { code: 0, stdout: JSON.stringify({ ok: true, compacted: true, kept: 200 }), stderr: '' });
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/compact', headers: H, payload: { mode: 'lines', lines: 200 } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ background: false, action: { outcome: 'ok', detail: { mode: 'lines', lines: 200, keptLines: 200, beforeK: 446 } } });
    expect(r.json().message).toMatch(/kept the last 200 lines of a 446K conversation/);
    const argv = provider.execLog.find((a) => a[0] === 'sessions')!;
    expect(argv).toEqual(compactArgv('stock', 'agent:stock:main', 'lines', 200));
    expect(provider.execOpts.at(-1)?.timeoutMs).toBeGreaterThan(1_800_000);
    const ledger = (await f.inject({ method: 'GET', url: '/v1/model-changes', headers: H })).json().tokenActions;
    expect(ledger[0]).toMatchObject({ agent: 'Stock', kind: 'compaction', by: 'owner', via: 'app', outcome: 'ok' });
    // Not another account's agent; not a stopped one; not a bad mode.
    expect((await f.inject({ method: 'POST', url: '/v1/agents/b1/compact', headers: H, payload: { mode: 'lines' } })).statusCode).toBe(404);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/compact', headers: H, payload: { mode: 'shred' } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/compact', headers: H, payload: { mode: 'lines', lines: 5 } })).statusCode).toBe(400);
    store.setAgentState('a2', 'STOPPED');
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a2/compact', headers: H, payload: { mode: 'lines' } })).statusCode).toBe(409);
  });

  it('with a channel retry looping, a summary starts only after its next stall, and the owner hears how it ended', async () => {
    const { store, provider } = await world();
    const agent = store.getAgent('a1')!;
    let clock = Date.parse('2026-10-04T13:00:00Z');
    const stallAt = (t: number) => stallLine(new Date(t).toISOString());
    // The last stall 2 minutes ago; the next one comes 3 polls later.
    let lines = [stallAt(clock - 7 * MIN), stallAt(clock - 2 * MIN)];
    let polls = 0;
    provider.modelCallLog = async () => { polls++; if (polls === 4) lines = [...lines, stallAt(clock)]; return lines.join('\n'); };
    const order: string[] = [];
    const origExec = provider.exec.bind(provider);
    provider.exec = async (ref, argv, opts) => {
      if (argv[0] === 'sessions') { order.push(`compact after ${polls} polls`); return { code: 0, stdout: JSON.stringify({ ok: true, compacted: true, result: { tokensBefore: 446_000, tokensAfter: 58_000 } }), stderr: '' }; }
      return origExec(ref, argv, opts);
    };
    const told: string[] = [];
    store.openTokenIncident({ id: 'ti_x', agentId: 'a1', ownerId: OWNER, kind: 'channel-retry', key: 'telegram:123', openedAt: iso(clock - HOUR), updatedAt: iso(clock), count: 12, text: 'Stuck', lastAt: iso(clock - 2 * MIN) });
    const out = await compactAgent({
      store, provider, now: () => clock, sleep: async (ms) => { clock += ms; },
      tell: async (_o, _a, text) => { told.push(text); return true; },
    }, agent, { mode: 'summarise', meta: { by: 'agent', via: 'proposal', why: 'Conversation at 446K' } });
    expect(out.background).toBe(true);
    expect(out.message).toMatch(/right after its stuck message's next retry is cut off/);
    for (let i = 0; i < 50 && !told.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['compact after 4 polls']);
    expect(told[0]).toMatch(/Compacted "Stock": 446K → 58K tokens/);
    expect(store.listTokenActions({ ownerId: OWNER })[0]).toMatchObject({ kind: 'compaction', by: 'agent', via: 'proposal', outcome: 'ok', detail: { afterK: 58, startedAfterStall: true, retryLoop: { count: 12 } } });
  });

  it('an aborted summary says so and points to the fast path; one compaction per agent at a time', async () => {
    const { store, provider } = await world();
    const agent = store.getAgent('a2')!;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    provider.exec = async (_ref, argv) => {
      if (argv[0] === 'sessions') { await gate; return { code: 1, stdout: JSON.stringify({ ok: false, reason: 'aborted | user_abort' }), stderr: '' }; }
      return { code: 0, stdout: '', stderr: '' };
    };
    const told: string[] = [];
    await compactAgent({ store, provider, tell: async (_o, _a, t) => { told.push(t); return true; } }, agent, { mode: 'summarise', meta: { by: 'owner', via: 'app' } });
    await expect(compactAgent({ store, provider }, agent, { mode: 'lines', meta: { by: 'owner', via: 'app' } })).rejects.toThrow(/already running/);
    release();
    for (let i = 0; i < 50 && !told.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(told[0]).toMatch(/aborted .* last 200 lines/);
  });
});

// ---------------------------------------------------------------------------
// The context cap
// ---------------------------------------------------------------------------

describe('the context cap', () => {
  it('writes one model row with contextTokens, merged with what is there, and takes only its own row away', () => {
    expect(nextProviderEntry(undefined, 'claude-sonnet-5', 150_000)).toEqual({ models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', contextTokens: 150_000 }] });
    const hand = { baseUrl: 'https://proxy.example', models: [{ id: 'claude-opus-4-8', name: 'Opus', reasoning: true }] };
    const capped = nextProviderEntry(hand, 'claude-opus-4-8', 120_000)!;
    expect(capped).toEqual({ baseUrl: 'https://proxy.example', models: [{ id: 'claude-opus-4-8', name: 'Opus', reasoning: true, contextTokens: 120_000 }] });
    // Removed: the hand-made row keeps all but the cap; the provider keeps its baseUrl.
    expect(nextProviderEntry(capped, 'claude-opus-4-8', null)).toEqual(hand);
    // Hatchabot's own row goes entirely, and an empty entry is no entry.
    expect(nextProviderEntry(nextProviderEntry(undefined, 'claude-sonnet-5', 150_000), 'claude-sonnet-5', null)).toBeUndefined();
    // A model switch moves the cap from the old model's row to the new one's.
    expect(nextProviderEntry({ models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', contextTokens: 150_000 }] }, 'claude-haiku-4-5', 150_000, 'claude-sonnet-5'))
      .toEqual({ models: [{ id: 'claude-haiku-4-5', name: 'Haiku 4.5', contextTokens: 150_000 }] });
  });

  it('PUT /v1/agents/:id/context-cap stores it, writes it live with a compare-and-set, and records it like a model change', async () => {
    const { store, provider, f } = await world();
    store.setTokenHealth('a1', stuckHealth(Date.now()), iso(Date.now()));
    provider.execResponses.set('sh', { code: 0, stdout: '', stderr: '' }); // the authored path is absent
    const r = await f.inject({ method: 'PUT', url: '/v1/agents/a1/context-cap', headers: H, payload: { tokens: 150_000, why: 'Conversation at 446K' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ tokens: 150_000, outcome: 'applied', compactsAt: 130_000 });
    expect(r.json().message).toMatch(/compacts its conversations at about 130K/);
    const set = provider.execLog.find((a) => a[0] === 'config' && a[1] === 'set')!;
    expect(set.slice(0, 3)).toEqual(['config', 'set', 'models.providers.anthropic']);
    expect(JSON.parse(set[3]!)).toEqual({ models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', contextTokens: 150_000 }] });
    expect(set).toEqual(expect.arrayContaining(['--strict-json', '--replace', '--expect-current-absent']));
    expect(store.getContextCap('a1')).toMatchObject({ tokens: 150_000, appliedModel: 'anthropic/claude-sonnet-5' });
    const action = store.listTokenActions({ ownerId: OWNER })[0]!;
    expect(action).toMatchObject({ kind: 'context-cap', by: 'owner', via: 'app', why: 'Conversation at 446K', outcome: 'applied', detail: { from: null, to: 150_000, model: 'anthropic/claude-sonnet-5', before: { ctxP50K: 380, mainNowK: 446 } } });
    // Bad values, a local model, someone else's agent.
    for (const tokens of [10_000, 2_000_000, 150_000.5, 'big']) expect((await f.inject({ method: 'PUT', url: '/v1/agents/a1/context-cap', headers: H, payload: { tokens } })).statusCode).toBe(400);
    (store as any).db.prepare('UPDATE agents SET ai_profile_id = ? WHERE id = ?').run('p3', 'a2');
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/a2/context-cap', headers: H, payload: { tokens: 150_000 } })).json().error).toMatch(/local model/);
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/b1/context-cap', headers: H, payload: { tokens: 150_000 } })).statusCode).toBe(404);
    // Removed: the row it wrote comes out (here: the whole path, which only held it).
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', contextTokens: 150_000 }] }), stderr: '' });
    const off = await f.inject({ method: 'PUT', url: '/v1/agents/a1/context-cap', headers: H, payload: { tokens: null } });
    expect(off.json().outcome).toBe('applied');
    expect(provider.execLog.at(-1)).toEqual(['config', 'unset', 'models.providers.anthropic']);
    expect(store.getContextCap('a1')).toBeUndefined();
  });

  it('never overwrites a hand edit made meanwhile, and a stopped agent gets it when it is next running', async () => {
    const { store, provider, f } = await world();
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ models: [{ id: 'claude-sonnet-5', contextTokens: 400_000, name: 'mine' }] }), stderr: '' });
    provider.execResponses.set('config set', { code: 1, stdout: '', stderr: 'config set refused: current value does not match --expect-current-json' });
    const r = await f.inject({ method: 'PUT', url: '/v1/agents/a1/context-cap', headers: H, payload: { tokens: 150_000 } });
    expect(r.json()).toMatchObject({ outcome: 'changed-by-hand' });
    const set = provider.execLog.find((a) => a[0] === 'config' && a[1] === 'set')!;
    expect(set[set.indexOf('--expect-current-json') + 1]).toBe(JSON.stringify({ models: [{ id: 'claude-sonnet-5', contextTokens: 400_000, name: 'mine' }] }));
    // Asleep: stored, nothing run.
    store.setAgentState('a2', 'STOPPED');
    const n = provider.execLog.length;
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/a2/context-cap', headers: H, payload: { tokens: 200_000 } })).json().outcome).toBe('pending');
    expect(provider.execLog.length).toBe(n);
    expect(store.getContextCap('a2')).toMatchObject({ tokens: 200_000 });
    expect(store.getContextCap('a2')!.appliedModel).toBeUndefined();
  });

  it('is re-applied for the model the agent runs at a rebuild', async () => {
    const { store, provider } = await world();
    store.setContextCap('a1', 150_000, iso(Date.now()));
    provider.execResponses.set('sh', { code: 0, stdout: '', stderr: '' });
    const out = await syncContextCap({ store, provider }, store.getAgent('a1')!, store.getAgent('a1')!.runtimeRef!);
    expect(out).toBe('applied');
    // The model changes to Haiku: the next sync moves the row.
    store.setAgentModel('a1', 'claude-haiku-4-5');
    provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', contextTokens: 150_000 }] }), stderr: '' });
    expect(await syncContextCap({ store, provider }, store.getAgent('a1')!, store.getAgent('a1')!.runtimeRef!)).toBe('applied');
    const last = provider.execLog.filter((a) => a[0] === 'config' && a[1] === 'set').at(-1)!;
    expect(JSON.parse(last[3]!)).toEqual({ models: [{ id: 'claude-haiku-4-5', name: 'Haiku 4.5', contextTokens: 150_000 }] });
    expect(store.getContextCap('a1')!.appliedModel).toBe('anthropic/claude-haiku-4-5');
    // An agent with no cap: nothing is run.
    const n = provider.execLog.length;
    expect(await syncContextCap({ store, provider }, store.getAgent('a2')!, store.getAgent('a2')!.runtimeRef!)).toBe('skipped');
    expect(provider.execLog.length).toBe(n);
  });
});

// ---------------------------------------------------------------------------
// The management agent: tools, cards, notes, review
// ---------------------------------------------------------------------------

describe('the management agent as token steward', () => {
  it('has two reads and two cards, on its menu and in the coverage ledger; the routes are classed for the public address', () => {
    expect(toolDef('get_token_health')?.tier).toBe('read');
    expect(toolDef('get_incidents')?.tier).toBe('read');
    expect(toolDef('compact_agent')?.tier).toBe('mutate');
    expect(toolDef('set_context_cap')?.tier).toBe('mutate');
    expect(MANIFEST.filter((t) => t.name === 'compact_agent')).toHaveLength(1);
    expect(riskOf('compact_agent')).toBe('disruptive');
    expect(riskOf('set_context_cap')).toBe('disruptive');
    expect(COVERAGE['POST /v1/agents/:id/compact']).toBe('compact_agent');
    expect(COVERAGE['PUT /v1/agents/:id/context-cap']).toBe('set_context_cap');
    expect(publicClassFor('GET', '/v1/token-health')).toBe('signed-in');
    expect(publicClassFor('GET', '/v1/token-incidents')).toBe('signed-in');
    // There is no tool that cancels a queued retry: OpenClaw offers no supported way.
    expect(toolDef('stop_stuck_retry')).toBeUndefined();
  });

  it('the cards say what happens, with the size and a stuck retry when there is one', async () => {
    const t = REST_BY_NAME.get('compact_agent')!;
    const ctx = (input: Record<string, unknown>) => ({ agent: { id: 'a1', name: 'Stock' }, input, resolve: async () => ({ id: 'x', name: 'x' }),
      get: async () => ({ rows: [{ conversation: { mainNowK: 446 }, incidents: [{ kind: 'channel-retry', text: 'Stuck: Telegram message retried 12 times since 08:19' }] }] }) });
    const c1 = ctx({ mode: 'lines', lines: 200 });
    expect(await t.call(c1)).toEqual({ method: 'POST', path: '/v1/agents/a1/compact', body: { mode: 'lines', lines: 200 } });
    expect(t.card!(c1)).toMatch(/\(446K tokens now\): keep only its last 200 transcript lines[\s\S]*⚠ Stuck: Telegram message retried 12 times since 08:19\. Keeping the last lines finishes between its retries/);
    const c2 = ctx({});
    expect(await t.call(c2)).toMatchObject({ body: { mode: 'summarise' } });
    expect(t.card!(c2)).toMatch(/the model summarises it[\s\S]*right after the next retry is cut off/);
    await expect(Promise.resolve().then(() => t.call(ctx({ mode: 'shred' })))).rejects.toThrow(/summarise.*lines/);
    const cap = REST_BY_NAME.get('set_context_cap')!;
    const c3 = { ...ctx({ tokens: 150_000 }) };
    expect(cap.call(c3)).toEqual({ method: 'PUT', path: '/v1/agents/a1/context-cap', body: { tokens: 150_000 } });
    expect(cap.card!(c3)).toMatch(/Cap "Stock"'s conversations at 150K tokens: OpenClaw compacts them at about 130K/);
    expect(cap.call(ctx({ tokens: 0 }))).toMatchObject({ body: { tokens: null } });
    expect(cap.card!(ctx({ tokens: 0 }))).toMatch(/Remove "Stock"'s context cap/);
    expect(() => cap.call(ctx({ tokens: 1000 }))).toThrow(/50000/);
  });

  it('OPS_SOUL names the purpose; "Token stewardship" holds the procedure, loops first', () => {
    expect(OPS_SOUL).toMatch(/## Token steward\n[\s\S]*supervise how your owner's agents use AI[\s\S]*LOOPS/);
    const s = opsSection('## Token stewardship')!;
    for (const must of ['get_token_health', 'get_incidents', 'compact_agent', 'set_context_cap', 'channel-retry', 'compaction-failing', 'task-failing', 'consult-ping-pong',
      'tool-loop', 'model-failing', 'no supported way to cancel a retry', 'BUDGETS (advice only)', 'Right-size: ≈ $X this month', 'Never wake a sleeping agent', 'tokenActions']) {
      expect(s, must).toContain(must);
    }
    expect(s.indexOf('LOOPS FIRST')).toBeLessThan(s.indexOf('CONVERSATION SIZE'));
    expect(OPS_AGENTS_MD).not.toMatch(/^## Model stewardship$/m);
    expect(OPS_RENAMED_HEADINGS['## Model stewardship']).toBe('## Token stewardship');
  });

  it('an existing agent\'s "Model stewardship" section is replaced in place by "Token stewardship" at its build, never both', async () => {
    const { store, provider } = await world();
    store.setAgentOps('a1', true);
    const old = '# Operating notes\n\n## Who you act for\nOld.\n\n## Model stewardship\nOld model notes.\n\n## My own notes\nKeep me.\n';
    for (const current of [old, old.replace('## My own notes', `${opsSection('## Token stewardship')}\n## My own notes`)]) {
      provider.execResponses.set('sh', { code: 0, stdout: current, stderr: '' });
      await syncDataSourceDocs({ store, provider, secrets: new MemSecrets() } as never, 'a1', store.getAgent('a1')!.runtimeRef!, () => {});
      const write = provider.execLog.filter((a) => a[0] === 'sh' && a[1]!.includes('base64 -d >') && a[1]!.includes('AGENTS.md')).at(-1)!;
      const written = Buffer.from(/echo "([^"]+)"/.exec(write[1]!)![1]!, 'base64').toString('utf8');
      expect(written.match(/^## Token stewardship$/gm)).toHaveLength(1);
      expect(written).not.toContain('## Model stewardship');
      expect(written).not.toContain('Old model notes.');
      expect(written).toContain('Keep me.');
      // Where the old one was: before the owner's own section.
      expect(written.indexOf('## Token stewardship')).toBeLessThan(written.indexOf('## My own notes'));
    }
  });

  it('the weekly review covers it and opens with the savings line', async () => {
    const { OPS_MODEL_REVIEW_MESSAGE } = await import('../src/ops/opsAgent.js');
    expect(MODEL_REVIEW_NAME).toBe('Weekly token review');
    expect(OPS_MODEL_REVIEW_MESSAGE).toMatch(/get_incidents, get_token_health/);
    expect(OPS_MODEL_REVIEW_MESSAGE).toMatch(/first the savings line from get_model_changes/);
    expect(OPS_MODEL_REVIEW_MESSAGE).toMatch(/compact_agent, set_context_cap, set_model/);
  });
});

// ---------------------------------------------------------------------------
// The fleet default: a longer chat-app handler limit
// ---------------------------------------------------------------------------

describe('the chat-app handler limit', () => {
  it('is 30 minutes by default, settable in milliseconds, off gives OpenClaw its own 5', () => {
    expect(CHANNEL_HANDLER_TIMEOUT_DEFAULT_MS).toBe(1_800_000);
    expect(channelHandlerTimeoutMs(undefined)).toBe(1_800_000);
    expect(channelHandlerTimeoutMs('')).toBe(1_800_000);
    expect(channelHandlerTimeoutMs('900000')).toBe(900_000);
    expect(channelHandlerTimeoutMs('off')).toBeUndefined();
    expect(channelHandlerTimeoutMs('0')).toBeUndefined();
    expect(channelHandlerTimeoutMs('5')).toBe(1_800_000); // below a minute: a mistake, the default
    expect(channelHandlerTimeoutMs('99999999')).toBe(6 * HOUR); // capped
    expect(channelTimeoutEnv(1_800_000)).toEqual({ OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS: '1800000' });
    expect(channelTimeoutEnv(null)).toEqual({});
    expect(ENV_SETTINGS.find((s) => s.name === 'HATCHABOT_CHANNEL_HANDLER_TIMEOUT_MS')).toMatchObject({ group: 'agents', default: '1800000' });
  });

  it('every agent\'s container gets it at its build; an agent\'s own Environment value wins', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const secrets = new MemSecrets();
    await secrets.put('ai/p1', 'not-a-real-key');
    await secrets.put('chan/stub', 'not-a-real-token');
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p1', createdAt: 'now' } as never);
    const channel = { kind: 'telegram', async provision() { return { accountId: 'stubbot', secretRef: 'chan/stub', deepLink: 'https://t.me/stubbot' }; }, async release() {} };
    const deps = { store, secrets, provider, channel, sleep: async () => {} } as never;
    const { agent } = await provisionAgent(deps, { ownerId: OWNER, name: 'Kitchen', aiProfileId: 'p1', hostId: 'h1' } as never);
    expect((await buildRuntimeSpec(deps, agent.id)).env.OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS).toBe('1800000');
    await secrets.put('env/x', '600000');
    store.insertAgentEnv({ id: 'e1', agentId: agent.id, name: 'OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS', secretRef: 'env/x', createdAt: 'now' });
    expect((await buildRuntimeSpec(deps, agent.id)).env.OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS).toBe('600000');
    process.env.HATCHABOT_CHANNEL_HANDLER_TIMEOUT_MS = 'off';
    try {
      (store as any).db.prepare('DELETE FROM agent_env').run();
      expect((await buildRuntimeSpec(deps, agent.id)).env.OPENCLAW_TELEGRAM_SPOOLED_HANDLER_TIMEOUT_MS).toBeUndefined();
    } finally { delete process.env.HATCHABOT_CHANNEL_HANDLER_TIMEOUT_MS; }
  });
});

// ---------------------------------------------------------------------------
// "Weekly model review" becomes "Weekly token review", in place
// ---------------------------------------------------------------------------

describe('the weekly review task is renamed in place', () => {
  async function opsWorld() {
    const { store, provider } = await world();
    store.setAgentOps('a1', true);
    const agent = store.getAgent('a1')!;
    // The mock's cron store, with a task made by an earlier release (schedule, delivery, off).
    const jobs: Array<Record<string, unknown>> = [];
    const orig = provider.exec.bind(provider);
    provider.exec = async (ref, argv, opts) => {
      const r = await orig(ref, argv, opts);
      if (argv[0] === 'cron' && argv[1] === 'list') return { code: 0, stdout: JSON.stringify({ jobs }), stderr: '' };
      if (argv[0] === 'cron' && argv[1] === 'add') { jobs.push({ id: `job-${jobs.length + 1}`, name: argv[argv.indexOf('--name') + 1], enabled: true, payload: {}, schedule: {} }); return { code: 0, stdout: JSON.stringify({ id: `job-${jobs.length}` }), stderr: '' }; }
      if (argv[0] === 'cron' && argv[1] === 'edit') {
        const j = jobs.find((x) => x.id === argv[2]);
        if (!j) return { code: 1, stdout: '', stderr: `Job not found: ${argv[2]}` };
        if (argv.includes('--name')) j.name = argv[argv.indexOf('--name') + 1];
        if (argv.includes('--message')) j.payload = { kind: 'agentTurn', message: argv[argv.indexOf('--message') + 1] };
        return { code: 0, stdout: '', stderr: '' };
      }
      if (argv[0] === 'cron' && argv[1] === 'rm') { const i = jobs.findIndex((x) => x.id === argv[2]); if (i >= 0) jobs.splice(i, 1); return { code: 0, stdout: '', stderr: '' }; }
      return r;
    };
    const old = { id: 'job-old', name: LEGACY_REVIEW_NAME, enabled: false, payload: { kind: 'agentTurn', message: 'old words' }, schedule: { kind: 'cron', expr: '0 9 * * 1', tz: 'America/Toronto' }, delivery: { mode: 'announce', channel: 'telegram', to: '555' } };
    return { store, provider, agent, jobs, old };
  }
  const edits = (provider: MockProvider) => provider.execLog.filter((a) => a[0] === 'cron' && a[1] === 'edit');
  const adds = (provider: MockProvider) => provider.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add');

  it('found by its managed record under the old name: renamed and reworded with one patch, schedule, delivery and on/off kept, never a second task', async () => {
    const { store, provider, agent, jobs, old } = await opsWorld();
    jobs.push({ ...old });
    store.setManagedCron('a1', LEGACY_REVIEW_NAME, 'job-old', '2026-10-03T00:00:00Z');
    expect(await syncModelReviewCron({ store, provider }, agent, agent.runtimeRef!, 'weekly')).toBe('updated');
    expect(edits(provider)).toEqual([['cron', 'edit', 'job-old', '--name', MODEL_REVIEW_NAME, '--message', OPS_MODEL_REVIEW_MESSAGE]]);
    expect(adds(provider)).toEqual([]);
    expect(jobs).toEqual([{ ...old, name: MODEL_REVIEW_NAME, payload: { kind: 'agentTurn', message: OPS_MODEL_REVIEW_MESSAGE } }]);
    expect(store.managedCron('a1', LEGACY_REVIEW_NAME)).toBeUndefined();
    expect(store.managedCron('a1', MODEL_REVIEW_NAME)).toMatchObject({ jobId: 'job-old', messageHash: reviewMessageHash() });
    // The next build: nothing to do, nothing run.
    const n = provider.execLog.length;
    expect(await syncModelReviewCron({ store, provider }, agent, agent.runtimeRef!, 'weekly')).toBe('kept');
    expect(provider.execLog.length).toBe(n);
  });

  it('found by its old name when Hatchabot has no record of it: adopted and renamed in place', async () => {
    const { store, provider, agent, jobs, old } = await opsWorld();
    jobs.push({ ...old });
    expect(await syncModelReviewCron({ store, provider }, agent, agent.runtimeRef!, 'weekly')).toBe('present');
    expect(adds(provider)).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: 'job-old', name: MODEL_REVIEW_NAME, enabled: false, schedule: old.schedule, delivery: old.delivery });
    expect(store.managedCron('a1', MODEL_REVIEW_NAME)).toMatchObject({ jobId: 'job-old', messageHash: reviewMessageHash() });
  });

  it('deleted by hand stays deleted: the record moves to the new name, nothing is made again', async () => {
    const { store, provider, agent, jobs } = await opsWorld();
    store.setManagedCron('a1', LEGACY_REVIEW_NAME, 'job-old', '2026-10-03T00:00:00Z');
    expect(await syncModelReviewCron({ store, provider }, agent, agent.runtimeRef!, 'weekly')).toBe('kept');
    expect(adds(provider)).toEqual([]);
    expect(jobs).toEqual([]);
    expect(store.managedCron('a1', MODEL_REVIEW_NAME)).toMatchObject({ jobId: 'job-old', messageHash: reviewMessageHash() });
    expect(await syncModelReviewCron({ store, provider }, agent, agent.runtimeRef!, 'weekly')).toBe('kept');
    expect(adds(provider)).toEqual([]);
  });

  it('a new agent gets "Weekly token review"; off removes a task under either name', async () => {
    const { store, provider, agent, jobs, old } = await opsWorld();
    expect(await syncModelReviewCron({ store, provider }, agent, agent.runtimeRef!, 'weekly')).toBe('created');
    expect(jobs.map((j) => j.name)).toEqual([MODEL_REVIEW_NAME]);
    expect(await syncModelReviewCron({ store, provider }, agent, agent.runtimeRef!, 'off')).toBe('removed');
    expect(jobs).toEqual([]);
    jobs.push({ ...old });
    store.setManagedCron('a1', LEGACY_REVIEW_NAME, 'job-old', '2026-10-03T00:00:00Z');
    expect(await syncModelReviewCron({ store, provider }, agent, agent.runtimeRef!, 'off')).toBe('removed');
    expect(jobs).toEqual([]);
    expect(store.managedCron('a1', LEGACY_REVIEW_NAME)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A consult loop is one incident for the pair
// ---------------------------------------------------------------------------

describe('a consult loop between two agents', () => {
  it('is ONE incident naming both, shown on both tiles, told once, cleared once', async () => {
    const { store, f } = await world();
    const now = Date.now();
    // Kitchen and Stock asked each other 8 times, a minute apart, ending 2 minutes ago.
    for (let i = 0; i < 8; i++) {
      const [to, from] = i % 2 ? ['a1', 'a2'] : ['a2', 'a1'];
      store.recordEvent(to, 'a2a.consult', { from, fromName: 'x', text: 'made-up' });
    }
    const rows = (store as any).db.prepare(`SELECT id FROM agent_events WHERE event = 'a2a.consult' ORDER BY id`).all() as Array<{ id: number }>;
    rows.forEach((r, i) => (store as any).db.prepare('UPDATE agent_events SET at = ? WHERE id = ?').run(iso(now - (10 - i) * MIN), r.id));
    const told: string[] = [];
    const tell = async (_o: string, _a: unknown, text: string) => { told.push(text); return true; };
    await runTokenWatch({ store, tell }, now);
    const open = store.listTokenIncidents({ open: true });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ kind: 'consult-ping-pong', key: 'a1+a2', agentId: 'a1', count: 8 });
    expect(open[0]!.text).toMatch(/^Consult loop: "(Stock|Kitchen)" and "(Stock|Kitchen)" asked each other 8 times in 7 minutes$/);
    expect(open[0]!.text).toContain('"Stock"');
    expect(open[0]!.text).toContain('"Kitchen"');
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(/^⚠️ Hatchabot: Consult loop: /);
    // On both tiles, as the same incident.
    const listed = (await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json();
    expect(listed.find((a: any) => a.id === 'a1').stuck.map((x: any) => x.id)).toEqual([open[0]!.id]);
    expect(listed.find((a: any) => a.id === 'a2').stuck.map((x: any) => x.id)).toEqual([open[0]!.id]);
    expect(buildTokenHealth(store, OWNER).rows.every((r) => r.incidents.map((i) => i.id).join() === open[0]!.id)).toBe(true);
    // Another pass: still one, still told once.
    await runTokenWatch({ store, tell }, now + 5 * MIN);
    expect(store.listTokenIncidents({ open: true })).toHaveLength(1);
    expect(told).toHaveLength(1);
    // Quiet for longer than activeMs: cleared, once, off both tiles.
    await runTokenWatch({ store, tell }, now + T.activeMs + 10 * MIN);
    expect(store.listTokenIncidents({ open: true })).toHaveLength(0);
    expect(store.listTokenIncidents({ ownerId: OWNER })).toHaveLength(1);
    const after = (await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json();
    expect(after.filter((a: any) => a.stuck)).toEqual([]);
  });
});
