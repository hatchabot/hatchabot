import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { HOUR_FIELDS, USAGE_READER_SCRIPT, type HourField, type WindowModelStats } from '../src/orchestrator/usage.js';
import type { StoredProfile } from '../src/orchestrator/modelScorecard.js';
import { priceMix } from '../src/orchestrator/modelOptions.js';
import {
  assessModelChange, backfillModelLedger, evaluateModelChanges, fileGuardProposals, judge, recordChange, rightSizeSavings,
  type ChangeMeta, type ModelFigures,
} from '../src/orchestrator/modelLedger.js';
import { Broker, type ApiClient } from '../src/mgmt/broker.js';
import { PendingStore, type PendingConfirm } from '../src/mgmt/pendingStore.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const MEMBER = 'user-member';
const DAY = 86_400_000;
const HOUR = 3_600_000;
/** The switch everything below is timed from: 2026-10-03 01:51Z, as on the Spark. */
const T0 = Date.parse('2026-10-03T01:51:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const hourKey = (ms: number) => iso(ms).slice(0, 13);

function stats(o: Partial<Omit<WindowModelStats, 'err'>> & { err?: Partial<WindowModelStats['err']> } = {}): WindowModelStats {
  return {
    calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0,
    failedTurns: 0, failed7d: 0, first: 0, last: 0, ctxP50: 0, ctxP90: 0,
    ...o,
    err: { malformedToolCall: 0, providerError: 0, rateLimited: 0, aborted: 0, truncated: 0, toolFailed: 0, retried: 0, ...(o.err ?? {}) },
  };
}
const bucket = (o: Partial<Record<HourField, number>>) => HOUR_FIELDS.map((f) => o[f] ?? 0);

/**
 * A model's stats built from hour buckets: { [ms]: counts }. The totals are
 * the buckets' sums, as the reader writes them.
 */
function hourly(byHour: Record<number, Partial<Record<HourField, number>>>, extra: Partial<WindowModelStats> = {}): WindowModelStats {
  const h: Record<string, number[]> = {};
  const sum = Object.fromEntries(HOUR_FIELDS.map((f) => [f, 0])) as Record<HourField, number>;
  let first = 0, last = 0;
  for (const [ms, c] of Object.entries(byHour)) {
    const k = hourKey(Number(ms));
    const b = bucket(c);
    h[k] = h[k] ? h[k]!.map((v, i) => v + b[i]!) : b;
    for (const f of HOUR_FIELDS) sum[f] += c[f] ?? 0;
    if (!first || Number(ms) < first) first = Number(ms);
    if (Number(ms) > last) last = Number(ms);
  }
  return {
    ...stats({
      calls: sum.calls, input: sum.input, output: sum.output, cacheRead: sum.cacheRead, cacheWrite: sum.cacheWrite,
      turns: sum.turns, toolTurns: sum.toolTurns, toolCalls: sum.toolCalls, failedTurns: sum.failed, first, last,
      err: { malformedToolCall: sum.malformed, toolFailed: sum.toolFailed, rateLimited: sum.limitedTurns, truncated: sum.truncated },
    }),
    ...extra,
    h,
  };
}
const profile = (readAt: number, models: Record<string, WindowModelStats>, opts: { hourly?: boolean } = {}): StoredProfile =>
  ({ since: readAt - 30 * DAY, models, promptErrors: 0, crons: 0, firstCall: readAt - 40 * DAY, ...(opts.hourly === false ? {} : { hourly: true }) });

function baseStore() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-sonnet-5', 'claude-haiku-4-5'], secretRef: 'ai/key', createdAt: 'now' });
  store.insertAIProfile({ id: 'plan', ownerId: OWNER, name: 'Max plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', models: ['claude-haiku-4-5', 'claude-opus-4-8'], shared: true, createdAt: 'now' });
  const add = (id: string, profileId: string, opts: { owner?: string; state?: string; name?: string; ref?: string } = {}) =>
    store.insertAgent({ id, ownerId: opts.owner ?? OWNER, name: opts.name ?? `Agent ${id}`, slug: id, state: (opts.state ?? 'RUNNING') as any, aiProfileId: profileId, hostId: 'h1', runtimeRef: opts.ref ?? `ref-${id}`, persona: '', sharedMemory: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: 'now' });
  return { store, add };
}

// ---------------------------------------------------------------------------
// The reader: what each model did, hour by hour.
// ---------------------------------------------------------------------------

describe('the usage reader keeps each model\'s counts per hour', () => {
  it('buckets calls, tokens, turns, tools and how turns ended; a retried failure is taken back', () => {
    const base = mkdtempSync(join(tmpdir(), 'hb-ledger-'));
    const root = join(base, 'agents');
    mkdirSync(join(root, 'kitchen', 'agent'), { recursive: true });
    const db = new Database(join(root, 'kitchen', 'agent', 'openclaw-agent.sqlite'));
    db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
    const ins = db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)');
    let seq = 0;
    const put = (at: number, message: object) => ins.run('s1', seq++, at, JSON.stringify({ type: 'message', id: `e${seq}`, message }));
    const u = (input: number, output = 10) => ({ input, output, cacheRead: 0, cacheWrite: 0 });
    const tool = { type: 'toolCall', id: 't', name: 'read', arguments: {} };
    const h1 = Math.floor((Date.now() - 5 * HOUR) / HOUR) * HOUR, h2 = h1 + 2 * HOUR;
    // Hour 1, sonnet: a tool round with a failed tool, then the answer.
    put(h1 + 1000, { role: 'user', content: 'x' });
    put(h1 + 2000, { role: 'assistant', model: 'claude-sonnet-5', stopReason: 'toolUse', usage: u(100), content: [tool, tool] });
    put(h1 + 3000, { role: 'toolResult', isError: true, content: [] });
    put(h1 + 4000, { role: 'assistant', model: 'claude-sonnet-5', stopReason: 'stop', usage: u(200, 50), content: [] });
    // Hour 2, haiku: rate-limited then retried (not a failed turn); a malformed tool call; a cut-off answer.
    put(h2 + 1000, { role: 'user', content: 'x' });
    put(h2 + 2000, { role: 'assistant', model: 'claude-haiku-4-5', stopReason: 'error', usage: u(0, 0), content: [], errorMessage: 'rate_limit_error' });
    put(h2 + 3000, { role: 'assistant', model: 'claude-haiku-4-5', stopReason: 'stop', usage: u(300), content: [] });
    put(h2 + 4000, { role: 'user', content: 'x' });
    put(h2 + 5000, { role: 'assistant', model: 'claude-haiku-4-5', stopReason: 'error', usage: u(0, 0), content: [], errorMessage: 'Provider completed tool call with malformed JSON arguments' });
    put(h2 + 6000, { role: 'user', content: 'x' });
    put(h2 + 7000, { role: 'assistant', model: 'claude-haiku-4-5', stopReason: 'length', usage: u(400), content: [] });
    db.close();
    const script = USAGE_READER_SCRIPT.replace('"/home/node/.openclaw/agents"', JSON.stringify(root));
    const r = spawnSync(process.execPath, ['--no-warnings', '-e', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.window.hourly).toBe(true);
    const at = (model: string, ms: number) => Object.fromEntries(HOUR_FIELDS.map((f, i) => [f, out.window.models[model].h[hourKey(ms)][i]]));
    expect(at('claude-sonnet-5', h1)).toMatchObject({ calls: 2, input: 300, output: 60, turns: 1, toolTurns: 1, toolCalls: 2, toolFailed: 1, failed: 0 });
    expect(at('claude-haiku-4-5', h2)).toMatchObject({ calls: 2, input: 700, turns: 3, failed: 1, limitedTurns: 0, malformed: 1, truncated: 1 });
    // Only hours with something in them.
    expect(Object.keys(out.window.models['claude-haiku-4-5'].h)).toEqual([hourKey(h2)]);
  });
});

// ---------------------------------------------------------------------------
// Verdicts: kept-ok, worse, not-enough-data — from stored figures only.
// ---------------------------------------------------------------------------

/** a1 ran opus for a week before T0 (20 turns, clean), then haiku. */
function switched(after: Record<number, Partial<Record<HourField, number>>>, readAt: number, meta: Partial<ChangeMeta> = {}) {
  const w = baseStore();
  w.add('a1', 'key');
  w.store.setAgentModel('a1', 'claude-haiku-4-5');
  const before: Record<number, Partial<Record<HourField, number>>> = {};
  for (let d = 7; d >= 1; d--) before[T0 - d * DAY] = { calls: 6, input: 3e5, output: 2e4, turns: 3, toolTurns: 1, toolCalls: 2 };
  w.store.setModelProfile('a1', profile(readAt, { 'claude-opus-4-8': hourly(before), 'claude-haiku-4-5': hourly(after) }), iso(readAt));
  const row = recordChange(w.store, { agentId: 'a1', from: 'claude-opus-4-8', to: 'claude-haiku-4-5', at: iso(T0), by: 'agent', via: 'proposal', source: 'model', why: 'Mostly chat', ...meta }, T0)!;
  return { ...w, row };
}
const turnsAfter = (n: number, extra: Partial<Record<HourField, number>> = {}, days = 2) => {
  const out: Record<number, Partial<Record<HourField, number>>> = {};
  for (let i = 0; i < n; i++) out[T0 + HOUR + Math.floor((i * days * DAY) / n)] = { calls: 2, input: 1e5, output: 1e4, turns: 1, toolTurns: 1, toolCalls: 1 };
  const k = Number(Object.keys(out)[0]);
  out[k] = { ...out[k], ...Object.fromEntries(Object.entries(extra).map(([f, v]) => [f, (out[k]![f as HourField] ?? 0) + v!])) };
  return out;
};

describe('the ledger\'s verdict on a change', () => {
  it('records the old model\'s figures at the change', () => {
    const { row } = switched({}, T0 + HOUR);
    const b = row.before as ModelFigures;
    expect(b).toMatchObject({ model: 'claude-opus-4-8', basis: 'hours', turns: 21, calls: 42, toolsPerTurn: 0.7, badTurns: 0, rates: { badTurn: 0, malformed: 0, toolFail: 0 } });
    expect(b.days).toBeCloseTo(7, 0);
    expect(b.turnsPerDay).toBe(3);
    // 42 calls: 2.1M in, 0.14M out on opus in 7 days → a month at API prices.
    expect(b.monthlyUSD).toBeCloseTo(((2.1e6 * 5 + 1.4e5 * 25) / 1e6) * 30 / 7, 0);
  });

  it('kept-ok once the new model has 20 clean turns, before the week is out', () => {
    const now = T0 + 3 * DAY;
    const { store, row } = switched(turnsAfter(25), now);
    expect(evaluateModelChanges(store, now)).toEqual([]);
    const c = store.getModelChange(row.id)!;
    expect(c.outcome).toBe('kept-ok');
    expect((c.after as ModelFigures)).toMatchObject({ model: 'claude-haiku-4-5', turns: 25, badTurns: 0 });
  });

  it('stays pending with a few turns and less than a week', () => {
    const now = T0 + 2 * DAY;
    const { store, row } = switched(turnsAfter(6), now);
    evaluateModelChanges(store, now);
    expect(store.getModelChange(row.id)!.outcome).toBe('pending');
  });

  it('worse when failed turns and malformed tool calls rise beyond the thresholds', () => {
    const now = T0 + 8 * DAY;
    const { store, row } = switched(turnsAfter(10, { failed: 3, malformed: 3 }), now);
    const worse = evaluateModelChanges(store, now);
    expect(worse.map((c) => c.id)).toEqual([row.id]);
    const c = store.getModelChange(row.id)!;
    expect(c.outcome).toBe('worse');
    expect(c.reasons!.join(' ')).toMatch(/failed turns 0% → 30% of turns/);
    expect(c.reasons!.join(' ')).toMatch(/malformed tool calls 0% → 30% per turn/);
  });

  it('rate limits are the source\'s, not the model\'s: they do not make a change worse', () => {
    const now = T0 + 8 * DAY;
    const { store, row } = switched(turnsAfter(10, { failed: 4, limitedTurns: 4 }), now);
    evaluateModelChanges(store, now);
    expect(store.getModelChange(row.id)!.outcome).toBe('kept-ok');
  });

  it('not-enough-data after a week with two turns, and looked at again when more arrive', () => {
    let now = T0 + 8 * DAY;
    const { store, row } = switched(turnsAfter(2), now);
    evaluateModelChanges(store, now);
    expect(store.getModelChange(row.id)!.outcome).toBe('not-enough-data');
    now = T0 + 10 * DAY;
    const p = store.modelProfiles(['a1']).get('a1')!.profile as StoredProfile;
    store.setModelProfile('a1', { ...p, models: { ...p.models, 'claude-haiku-4-5': hourly(turnsAfter(12, {}, 9)) } }, iso(now));
    evaluateModelChanges(store, now);
    expect(store.getModelChange(row.id)!.outcome).toBe('kept-ok');
  });

  it('waits for the first reading with hour buckets (a profile from the older reader)', () => {
    const now = T0 + 8 * DAY;
    const { store, row } = switched({}, now);
    store.setModelProfile('a1', profile(now, { 'claude-haiku-4-5': stats({ turns: 30, calls: 30 }) }, { hourly: false }), iso(now));
    evaluateModelChanges(store, now);
    expect(store.getModelChange(row.id)!.outcome).toBe('pending');
  });

  it('a later change ends the period: the verdict is on the hours in between', () => {
    const now = T0 + 9 * DAY;
    const { store, row } = switched({ ...turnsAfter(6, { failed: 3 }, 0.1), [T0 + 4 * DAY]: { turns: 30, calls: 30 } }, now);
    store.setAgentModel('a1', 'claude-opus-4-8');
    recordChange(store, { agentId: 'a1', from: 'claude-haiku-4-5', to: 'claude-opus-4-8', at: iso(T0 + 3 * DAY), by: 'owner', via: 'app', source: 'model' }, T0 + 3 * DAY);
    evaluateModelChanges(store, now);
    const c = store.getModelChange(row.id)!;
    expect((c.after as ModelFigures).turns).toBe(6);
    expect(c.outcome).toBe('worse');
  });

  it('judge: unknown before uses the absolute bar; a floor of real counts', () => {
    const after = (o: Partial<ModelFigures>) => ({ model: 'm', days: 7, calls: 10, turns: 10, callsPerDay: 1, turnsPerDay: 1, toolCalls: 10, toolsPerTurn: 1, toolTurnShare: 1,
      badTurns: 0, malformed: 0, toolFailed: 0, rateLimited: 0, rates: { badTurn: 0, malformed: 0, toolFail: 0 }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, basis: 'hours', ...o }) as ModelFigures;
    expect(judge(undefined, after({ badTurns: 1, rates: { badTurn: 0.1, malformed: 0, toolFail: 0 } })).outcome).toBe('kept-ok'); // one is not a trend
    expect(judge(undefined, after({ badTurns: 2, rates: { badTurn: 0.2, malformed: 0, toolFail: 0 } })).outcome).toBe('worse');
    expect(judge(after({ badTurns: 2, rates: { badTurn: 0.18, malformed: 0, toolFail: 0 } }), after({ badTurns: 2, rates: { badTurn: 0.2, malformed: 0, toolFail: 0 } })).outcome).toBe('kept-ok'); // no worse than before
    expect(judge(undefined, after({ toolFailed: 3, rates: { badTurn: 0, malformed: 0, toolFail: 0.3 } })).reasons[0]).toMatch(/tool failures 30% of tool calls/);
    expect(judge(undefined, after({ turns: 4 })).outcome).toBe('not-enough-data');
  });
});

// ---------------------------------------------------------------------------
// The guard's switch-back card: once, and only on worse.
// ---------------------------------------------------------------------------

describe('the quality guard\'s switch-back card', () => {
  it('a worse change gets one card (source guard, with before and after), announced once', () => {
    const now = T0 + 8 * DAY;
    const { store, row } = switched(turnsAfter(10, { failed: 3, malformed: 3 }), now);
    evaluateModelChanges(store, now);
    const pushes: Array<[string, string, string?]> = [];
    const filed = fileGuardProposals({ store, now, push: (o, h, d) => pushes.push([o, h, d]) });
    expect(filed).toHaveLength(1);
    const card = store.getMgmtProposal<PendingConfirm>(filed[0]!)!;
    expect(card).toMatchObject({ ownerId: OWNER, tool: 'set_model', source: 'guard', status: 'pending', risk: 'disruptive', resolved: { agentId: 'a1', model: 'claude-opus-4-8', guardOf: row.id } });
    expect(card.summary.split('\n')[0]).toBe('↩ Switch "Agent a1" back to claude-opus-4-8');
    expect(card.summary).toMatch(/by your Hatchabot agent/);
    expect(card.summary).toMatch(/Before \(claude-opus-4-8, 7 days\): 21 turns, failed 0%/);
    expect(card.summary).toMatch(/After \(claude-haiku-4-5, 8 days\): 10 turns, failed 30%/);
    expect(card.summary).toMatch(/Nothing changes unless you Confirm/);
    expect(pushes).toEqual([[OWNER, '↩ Hatchabot suggests switching "Agent a1" back to claude-opus-4-8: it does worse on claude-haiku-4-5.', expect.stringMatching(/failed turns/)]]);
    // Once per switch: the next pass files nothing, even after the card is cancelled.
    store.resolveMgmtProposal(filed[0]!, 'cancelled', now);
    expect(fileGuardProposals({ store, now: now + DAY })).toEqual([]);
    expect(store.getModelChange(row.id)!.guardProposalId).toBe(filed[0]);
    // Nothing switched by itself.
    expect(store.getAgent('a1')!.model).toBe('claude-haiku-4-5');
  });

  it('an asleep agent: its verdict and card come from its last reading, and it stays asleep', () => {
    const now = T0 + 8 * DAY;
    const { store } = switched(turnsAfter(10, { failed: 3 }), T0 + 2 * DAY);
    store.setAgentState('a1', 'STOPPED');
    store.setHibernated('a1', iso(T0 + 2 * DAY));
    expect(evaluateModelChanges(store, now)).toHaveLength(1);
    expect(fileGuardProposals({ store, now })).toHaveLength(1);
    expect(store.getAgent('a1')!.state).toBe('STOPPED');
  });

  it('no card for kept-ok, pending or not-enough-data', () => {
    for (const [after, days] of [[turnsAfter(25), 3], [turnsAfter(6), 2], [turnsAfter(2), 8]] as const) {
      const now = T0 + days * DAY;
      const { store } = switched(after, now);
      evaluateModelChanges(store, now);
      expect(fileGuardProposals({ store, now })).toEqual([]);
      expect(store.listMgmtProposals(OWNER, now)).toEqual([]);
    }
  });

  it('no card when the agent has moved on, when the change was itself a switch-back, or when the old model is gone from the source', () => {
    const now = T0 + 8 * DAY;
    const moved = switched(turnsAfter(10, { failed: 3 }), now);
    evaluateModelChanges(moved.store, now);
    moved.store.setAgentModel('a1', 'claude-sonnet-5');
    expect(fileGuardProposals({ store: moved.store, now })).toEqual([]);
    expect(moved.store.getModelChange(moved.row.id)!.guardProposalId).toBe('none:moved-on');

    const back = switched(turnsAfter(10, { failed: 3 }), now, { via: 'guard', by: 'hatchabot' });
    evaluateModelChanges(back.store, now);
    expect(fileGuardProposals({ store: back.store, now })).toEqual([]);

    const gone = switched(turnsAfter(10, { failed: 3 }), now);
    evaluateModelChanges(gone.store, now);
    gone.store.setAIProfileModel('key', 'claude-sonnet-5');
    gone.store.setAIProfileModels('key', ['claude-haiku-4-5']);
    expect(fileGuardProposals({ store: gone.store, now })).toEqual([]);
    expect(gone.store.getModelChange(gone.row.id)!.guardProposalId).toBe('none:not-offered');
  });

  it('confirming the card switches back, and the ledger says Hatchabot\'s guard did it; no container is read for any of it', async () => {
    const now = Date.now();
    const w = baseStore();
    const provider = new MockProvider();
    w.add('a1', 'key', { ref: (await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as any)).runtimeRef });
    w.store.setAgentModel('a1', 'claude-haiku-4-5');
    const t0 = now - 8 * DAY;
    const after: Record<number, Partial<Record<HourField, number>>> = {};
    for (let i = 0; i < 10; i++) after[t0 + HOUR + i * HOUR] = { calls: 1, turns: 1, failed: i < 3 ? 1 : 0 };
    w.store.setModelProfile('a1', profile(now, { 'claude-haiku-4-5': hourly(after) }), iso(now));
    recordChange(w.store, { agentId: 'a1', from: 'claude-opus-4-8', to: 'claude-haiku-4-5', at: iso(t0), by: 'owner', via: 'app', source: 'model' }, t0);
    const f = Fastify();
    await registerRoutes(f, { store: w.store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    // Reading the ledger works the verdict out; it reads no container.
    const execs = provider.execLog.length;
    const ledger = (await f.inject({ method: 'GET', url: '/v1/model-changes', headers: { 'x-hatchabot-owner': OWNER } })).json();
    expect(ledger.changes[0]).toMatchObject({ agent: 'Agent a1', from: 'claude-opus-4-8', to: 'claude-haiku-4-5', by: 'owner', via: 'app', outcome: 'worse', before: 'unknown' });
    const [id] = fileGuardProposals({ store: w.store, now });
    expect(provider.execLog.length).toBe(execs);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
    const pending = (await f.inject({ method: 'GET', url: '/v1/proposals', headers: { 'x-hatchabot-owner': OWNER } })).json().pending;
    expect(pending[0]).toMatchObject({ confirmId: id, source: 'guard', tool: 'set_model', risk: 'disruptive' });
    const res = await f.inject({ method: 'POST', url: `/v1/proposals/${id}/confirm`, headers: { 'x-hatchabot-owner': OWNER }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toMatch(/^✅ ↩ Switch "Agent a1" back to claude-opus-4-8/);
    expect(w.store.getAgent('a1')!.model).toBe('claude-opus-4-8');
    const back = w.store.listModelChanges({ agentId: 'a1' })[0]!;
    expect(back).toMatchObject({ from: 'claude-haiku-4-5', to: 'claude-opus-4-8', by: 'hatchabot', via: 'guard', source: 'model', proposalId: id });
    expect(back.why).toMatch(/^Quality guard: switch back \(failed turns/);
    await f.close();
  });
});

// ---------------------------------------------------------------------------
// Every path that changes a model writes the ledger.
// ---------------------------------------------------------------------------

async function routesWorld() {
  const w = baseStore();
  const provider = new MockProvider();
  const ref = async (id: string) => (await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} } as any)).runtimeRef;
  w.add('a1', 'key', { ref: await ref('a1') });
  w.add('a2', 'key', { ref: await ref('a2') });
  w.add('a3', 'key', { ref: await ref('a3') });
  w.add('m1', 'key', { owner: MEMBER, ref: await ref('m1') });
  w.store.setAgentModel('a3', 'claude-haiku-4-5');
  const now = Date.now();
  w.store.setModelProfile('a1', profile(now, { 'claude-opus-4-8': hourly({ [now - 2 * DAY]: { calls: 30, input: 1e6, output: 1e5, turns: 12, toolTurns: 4, toolCalls: 6 } }) }), iso(now));
  const f = Fastify();
  await registerRoutes(f, { store: w.store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object, headers: Record<string, string> = {}) =>
    f.inject({ method, url, headers: { 'x-hatchabot-owner': OWNER, ...headers }, ...(payload ? { payload } : {}) });
  const rows = (agentId: string) => w.store.listModelChanges({ agentId });
  return { ...w, f, provider, call, rows };
}

describe('every model change is recorded, by whichever path', () => {
  it('the agent sheet\'s picker (app), the API (a bearer token), and nothing for no change', async () => {
    const { call, rows, f } = await routesWorld();
    { const r0 = await call("POST", "/v1/agents/a1/model", { model: "claude-haiku-4-5", why: "Short answers only" }); expect(r0.statusCode, r0.body).toBe(200); }
    expect(rows('a1')[0]).toMatchObject({ from: 'claude-opus-4-8', to: 'claude-haiku-4-5', by: 'owner', via: 'app', source: 'model', why: 'Short answers only', outcome: 'pending' });
    expect(rows('a1')[0]!.before).toMatchObject({ model: 'claude-opus-4-8', turns: 12, basis: 'hours' });
    await call('POST', '/v1/agents/a1/model', { model: 'claude-haiku-4-5' });
    expect(rows('a1')).toHaveLength(1);
    await call('POST', '/v1/agents/a1/model', { model: 'claude-sonnet-5' }, { authorization: 'Bearer hatchabot_example' });
    expect(rows('a1')[0]).toMatchObject({ from: 'claude-haiku-4-5', to: 'claude-sonnet-5', via: 'api' });
    // Back to the source's default (null clears the pin) is a change too.
    await call('POST', '/v1/agents/a1/model', { model: null });
    expect(rows('a1')[0]).toMatchObject({ from: 'claude-sonnet-5', to: 'claude-opus-4-8' });
    expect(rows('a1')[0]!.before).toBeUndefined(); // no reading on sonnet: unknown
    await f.close();
  });

  it('PATCH of the agent: a model, and a source switch that moves its model', async () => {
    const { call, rows, f } = await routesWorld();
    await call('PATCH', '/v1/agents/a2', { model: 'claude-sonnet-5' });
    expect(rows('a2')[0]).toMatchObject({ from: 'claude-opus-4-8', to: 'claude-sonnet-5', source: 'model' });
    await call('PATCH', '/v1/agents/a3', { aiProfileId: 'plan' });
    // Haiku is on the plan too: the pin holds, nothing moved.
    expect(rows('a3')).toEqual([]);
    await call('PATCH', '/v1/agents/a1', { aiProfileId: 'plan' });
    expect(rows('a1')[0]).toMatchObject({ from: 'claude-opus-4-8', to: 'claude-sonnet-5', source: 'source-switch', profileId: 'plan' });
    await f.close();
  });

  it('a source\'s new default: the switched agents (apply-default-model), and every follower (PATCH of the source)', async () => {
    const { call, rows, f } = await routesWorld();
    await call('POST', '/v1/ai-profiles/key/apply-default-model', { model: 'claude-sonnet-5', apply: ['a1'] });
    expect(rows('a1')[0]).toMatchObject({ from: 'claude-opus-4-8', to: 'claude-sonnet-5', source: 'default-model', by: 'owner' });
    expect(rows('a2')).toEqual([]); // held on opus (pinned)
    expect(rows('a3')).toEqual([]);
    await call('PATCH', '/v1/ai-profiles/key', { model: 'claude-haiku-4-5' });
    expect(rows('a1')[0]).toMatchObject({ from: 'claude-sonnet-5', to: 'claude-haiku-4-5', source: 'source-default' });
    expect(rows('a2')).toEqual([]);
    // A member's follower on the same (shared) source moved with both defaults, and those rows are theirs.
    expect(rows('m1').map((c) => [c.ownerId, c.from, c.to, c.source])).toEqual([
      [MEMBER, 'claude-sonnet-5', 'claude-haiku-4-5', 'source-default'],
      [MEMBER, 'claude-opus-4-8', 'claude-sonnet-5', 'source-default'],
    ]);
    await f.close();
  });

  it('a class: assigning one, and editing it', async () => {
    const { call, rows, store, f } = await routesWorld();
    store.upsertAgentClass({ id: 'cls', ownerId: OWNER, name: 'Small', model: 'claude-sonnet-5' });
    expect((await call('POST', '/v1/agents/a3/class', { classId: 'cls' })).statusCode).toBe(200);
    expect(rows('a3')[0]).toMatchObject({ from: 'claude-haiku-4-5', to: 'claude-sonnet-5', source: 'class' });
    expect((await call('PUT', '/v1/agent-classes/cls', { model: 'claude-opus-4-8' })).statusCode).toBe(200);
    expect(rows('a3')[0]).toMatchObject({ from: 'claude-sonnet-5', to: 'claude-opus-4-8', source: 'class' });
    await f.close();
  });

  it('a source switch of several agents (adopt-agents)', async () => {
    const { call, rows, f } = await routesWorld();
    expect((await call('POST', '/v1/ai-profiles/plan/adopt-agents', { apply: ['a1', 'a3'] })).statusCode).toBe(200);
    expect(rows('a1')[0]).toMatchObject({ from: 'claude-opus-4-8', to: 'claude-sonnet-5', source: 'source-switch', profileId: 'plan' });
    expect(rows('a3')).toEqual([]); // its haiku pin is on the plan too
    await f.close();
  });

  it('a card the management agent filed and the owner confirmed: by the agent, with its why', async () => {
    const { call, rows, store, f } = await routesWorld();
    const now = Date.now();
    store.putMgmtProposal({ id: 'c_agentcard', ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'set_model',
      resolved: { agentId: 'a2', agentName: 'Agent a2', model: 'claude-haiku-4-5' }, summary: 'Set "Agent a2" model → claude-haiku-4-5',
      createdAtMs: now, expiresAtMs: now + HOUR, status: 'pending', source: 'agent', note: 'Recipe lookups; no tools' } as PendingConfirm);
    const res = await call('POST', '/v1/proposals/c_agentcard/confirm', {});
    expect(res.statusCode).toBe(200);
    expect(rows('a2')[0]).toMatchObject({ to: 'claude-haiku-4-5', by: 'agent', via: 'proposal', proposalId: 'c_agentcard', why: 'Recipe lookups; no tools' });
    // A proposal id of another account's is not taken at its word.
    store.putMgmtProposal({ id: 'c_theirs', ownerId: MEMBER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'set_model', resolved: { agentId: 'm1', agentName: 'x', model: 'claude-haiku-4-5' },
      summary: 'x', createdAtMs: now, expiresAtMs: now + HOUR, status: 'pending', source: 'agent', note: 'not yours' } as PendingConfirm);
    await call('POST', '/v1/agents/a2/model', { model: 'claude-sonnet-5' }, { 'x-hatchabot-proposal': 'c_theirs' });
    expect(rows('a2')[0]).toMatchObject({ by: 'owner', via: 'app' });
    expect(rows('a2')[0]!.proposalId).toBeUndefined();
    await f.close();
  });
});

// ---------------------------------------------------------------------------
// The proposal-time check: evidence on the card, risks of a downgrade.
// ---------------------------------------------------------------------------

describe('a set_model card states the evidence, and a downgrade\'s risks', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const one = (models: Record<string, WindowModelStats>, pin = 'claude-sonnet-5') => {
    const w = baseStore();
    w.add('a1', 'key');
    w.store.setAgentModel('a1', pin);
    w.store.setModelProfile('a1', profile(now, models), iso(now - HOUR));
    return { store: w.store, agent: w.store.getAgent('a1')!, source: w.store.getAIProfile('key')! };
  };

  it('thin evidence', () => {
    const { store, agent, source } = one({ 'claude-sonnet-5': hourly({ [now - 2 * DAY]: { calls: 8, input: 4e4, output: 4e3, turns: 4 } }) });
    const c = assessModelChange(store, agent, source, 'claude-haiku-4-5', now);
    expect(c).toMatchObject({ from: 'claude-sonnet-5', to: 'claude-haiku-4-5', downgrade: true });
    expect(c.warnings).toEqual([expect.stringMatching(/^Thin evidence: 4 turns on claude-sonnet-5 in \d+(\.\d)? days?\.$/)]);
    expect(c.evidence).toMatch(/^Evidence \(.* days, now claude-sonnet-5\): 4 turns/);
    expect(c.evidence).toMatch(/≈ \$[\d.]+ a month → ≈ \$[\d.]+ on claude-haiku-4-5 at API prices\.$/);
  });

  it('heavy tool use', () => {
    const { store, agent, source } = one({ 'claude-sonnet-5': hourly({ [now - 9 * DAY]: { calls: 500, input: 5e6, output: 5e5, turns: 100, toolTurns: 80, toolCalls: 420 } }, { first: now - 20 * DAY }) });
    const c = assessModelChange(store, agent, source, 'claude-haiku-4-5', now);
    expect(c.warnings).toEqual([expect.stringMatching(/^Heavy tool use: 4.2 tools per turn, tools in 80% of turns\./)]);
  });

  it('recent errors: failed turns this week that were not rate limits, and malformed tool calls', () => {
    const { store, agent, source } = one({ 'claude-sonnet-5': hourly({
      [now - 20 * DAY]: { calls: 50, turns: 40, input: 1e5 },
      [now - 2 * DAY]: { calls: 5, turns: 5, failed: 3, malformed: 2 },
      [now - 3 * DAY]: { calls: 2, turns: 2, failed: 2, limitedTurns: 2 },
    }) });
    const c = assessModelChange(store, agent, source, 'claude-haiku-4-5', now);
    expect(c.warnings).toEqual(['Recent errors: 3 failed turns in the last 7 days (not rate limits), 2 malformed tool calls in 30 days.']);
  });

  it('only rate limits: no error warning; and an upgrade carries no warnings at all', () => {
    const lim = one({ 'claude-sonnet-5': hourly({ [now - 20 * DAY]: { calls: 50, turns: 40, input: 1e5 }, [now - 2 * DAY]: { calls: 2, turns: 2, failed: 2, limitedTurns: 2 } }) });
    expect(assessModelChange(lim.store, lim.agent, lim.source, 'claude-haiku-4-5', now).warnings).toEqual([]);
    const up = one({ 'claude-haiku-4-5': hourly({ [now - 2 * DAY]: { calls: 2, turns: 1, failed: 1, malformed: 1 } }) }, 'claude-haiku-4-5');
    const c = assessModelChange(up.store, up.agent, up.source, 'claude-opus-4-8', now);
    expect(c).toMatchObject({ downgrade: false, warnings: [] });
  });

  it('the broker puts it on the card and in the tool\'s answer; GET /v1/agents/:id/model-check is the caller\'s', async () => {
    const api = {
      listAgents: async () => [{ id: 'a1', name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'key' }],
      availableModels: async () => ['claude-sonnet-5', 'claude-haiku-4-5'],
      modelCheck: async () => ({ from: 'claude-sonnet-5', downgrade: true, evidence: 'Evidence (6 days, now claude-sonnet-5): 4 turns.', warnings: ['Thin evidence: 4 turns on claude-sonnet-5 in 6 days.'] }),
    } as unknown as ApiClient;
    const broker = new Broker(api, new PendingStore());
    broker.setMode(true);
    const r = await broker.handleTool('set_model', { agent: 'Kitchen', model: 'claude-haiku-4-5' }, { ownerId: OWNER, chatId: 0, fromUserId: 0, source: 'agent' });
    expect(r.ok && 'pending' in r && r.pending).toMatchObject({ warnings: ['Thin evidence: 4 turns on claude-sonnet-5 in 6 days.'] });
    const summary = (r as { pending: { summary: string } }).pending.summary;
    expect(summary.split('\n')).toEqual([
      'Set "Kitchen" model: claude-sonnet-5 → claude-haiku-4-5 (a smaller or cheaper model)',
      'Evidence (6 days, now claude-sonnet-5): 4 turns.',
      '⚠ Thin evidence: 4 turns on claude-sonnet-5 in 6 days.',
    ]);

    const { call, f } = await routesWorld();
    const res = await call('GET', '/v1/agents/a1/model-check?model=claude-haiku-4-5');
    expect(res.json()).toMatchObject({ from: 'claude-opus-4-8', downgrade: true });
    expect((await call('GET', '/v1/agents/m1/model-check?model=claude-haiku-4-5')).statusCode).toBe(404);
    await f.close();
  });
});

// ---------------------------------------------------------------------------
// The realised saving.
// ---------------------------------------------------------------------------

describe('Right-size: what the cheaper switches saved', () => {
  it('tokens on the new model since the switch × the price difference; API money and plan room apart; upgrades not counted', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    const w = baseStore();
    w.add('api1', 'key');
    w.add('plan1', 'plan');
    w.add('plan2', 'plan', { owner: MEMBER });
    w.add('up', 'key');
    // api1: opus → haiku at T0; 1M in + 0.1M out on haiku since (and 5M before the switch, not counted).
    w.store.setModelProfile('api1', profile(now, { 'claude-haiku-4-5': hourly({ [T0 - 2 * DAY]: { input: 5e6 }, [T0 + DAY]: { calls: 10, input: 1e6, output: 1e5 } }) }), iso(now));
    recordChange(w.store, { agentId: 'api1', from: 'claude-opus-4-8', to: 'claude-haiku-4-5', at: iso(T0), by: 'agent', via: 'proposal', source: 'model' }, T0);
    // plan1: sonnet → haiku at T0; 2M in on haiku. The member's plan2 used 6M in on sonnet this month.
    w.store.setModelProfile('plan1', profile(now, { 'claude-haiku-4-5': hourly({ [T0 + DAY]: { calls: 10, input: 2e6 } }) }), iso(now));
    w.store.setModelProfile('plan2', profile(now, { 'claude-sonnet-5': hourly({ [T0]: { calls: 10, input: 6e6 } }) }), iso(now));
    recordChange(w.store, { agentId: 'plan1', from: 'claude-sonnet-5', to: 'claude-haiku-4-5', at: iso(T0), by: 'owner', via: 'app', source: 'model', profileId: 'plan' }, T0);
    // up: haiku → opus: an upgrade, not a saving.
    w.store.setModelProfile('up', profile(now, { 'claude-opus-4-8': hourly({ [T0 + DAY]: { calls: 10, input: 1e6 } }) }), iso(now));
    recordChange(w.store, { agentId: 'up', from: 'claude-haiku-4-5', to: 'claude-opus-4-8', at: iso(T0), by: 'owner', via: 'app', source: 'model' }, T0);

    const rs = rightSizeSavings(w.store, OWNER, now);
    expect(rs.month).toBe('2026-10');
    const api = rs.rows.find((r) => r.agentId === 'api1')!;
    // Opus $5/$25 vs Haiku $1/$5 on 1M in + 0.1M out: $7.50 − $1.50.
    expect(api).toMatchObject({ billing: 'api', from: 'claude-opus-4-8', to: 'claude-haiku-4-5', tokensM: 1.1, savingUSD: 6 });
    const plan = rs.rows.find((r) => r.agentId === 'plan1')!;
    // Sonnet $2 vs Haiku $1 on 2M in: $2 at API prices. The plan carried $2 (haiku) + $12 (the member's sonnet) this month.
    expect(plan).toMatchObject({ billing: 'plan', savingUSD: 2, source: 'Max plan' });
    expect(plan.sourceShare).toBeCloseTo(2 / (2 + 12 + 2), 3);
    expect(rs.rows.find((r) => r.agentId === 'up')).toBeUndefined();
    expect(rs).toMatchObject({ savingUSD: 8, apiUSD: 6, planUSD: 2 });
    expect(rs.line).toBe('Right-size: ≈ $8.00 this month ($6.00 on API keys, ≈ $2.00 at API prices on Claude plans)');
    // The member's own view has none of the owner's.
    expect(rightSizeSavings(w.store, MEMBER, now).rows).toEqual([]);
  });

  it('a plan-only saving is said as room in the plan; a later change ends the period', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    const w = baseStore();
    w.add('plan1', 'plan');
    w.store.setModelProfile('plan1', profile(now, { 'claude-haiku-4-5': hourly({ [T0 + HOUR]: { input: 1e6 }, [T0 + 2 * DAY]: { input: 9e6 } }) }), iso(now));
    recordChange(w.store, { agentId: 'plan1', from: 'claude-sonnet-5', to: 'claude-haiku-4-5', at: iso(T0), by: 'owner', via: 'app', source: 'model', profileId: 'plan' }, T0);
    recordChange(w.store, { agentId: 'plan1', from: 'claude-haiku-4-5', to: 'claude-sonnet-5', at: iso(T0 + DAY), by: 'owner', via: 'api', source: 'model', profileId: 'plan' }, T0 + DAY);
    const rs = rightSizeSavings(w.store, OWNER, now);
    // Only the 1M before the switch back counts: $1.
    expect(rs.savingUSD).toBe(1);
    // The plan carried 10M on haiku this month ($10): the $1 is 1/11 of what it would have been.
    expect(rs.line).toBe("Right-size: ≈ $1.00 this month at API prices (9.1% of Max plan's use): on a Claude plan that is room in the plan, not money");
    expect(priceMix('claude-sonnet-5', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(2);
  });

  it('nothing saved: no line, on the Usage page either', async () => {
    const { call, f } = await routesWorld();
    const res = (await call('GET', '/v1/usage/periods?period=day')).json();
    expect(res.rightSize).toBeUndefined();
    await f.close();
  });
});

// ---------------------------------------------------------------------------
// The start-up backfill of 2026-10-03.
// ---------------------------------------------------------------------------

describe('the start-up backfill', () => {
  function seeded() {
    const w = baseStore();
    w.add('a1', 'key', { name: 'Kitchen' });
    w.add('pik', 'key', { name: 'Friends Book' });
    w.add('a9', 'key', { name: 'Quiet' });
    w.store.setAgentModel('a1', 'claude-haiku-4-5');
    w.store.setAgentModel('pik', 'claude-sonnet-5'); // switched back through the API at ~04:2x
    const readAt = T0 + 3 * HOUR;
    w.store.setModelProfile('a1', profile(readAt, { 'claude-opus-4-8': stats({ calls: 60, input: 1e6, turns: 30, first: T0 - 10 * DAY, last: T0 - HOUR }) }, { hourly: false }), iso(readAt));
    w.store.setModelProfile('pik', profile(readAt, {
      'claude-sonnet-5': stats({ calls: 90, input: 2e6, turns: 40, first: T0 - 20 * DAY, last: T0 + 2.8 * HOUR }),
      'claude-haiku-4-5': stats({ calls: 12, input: 1e5, turns: 6, first: T0 + 60_000, last: T0 + 2.5 * HOUR }),
    }, { hourly: false }), iso(readAt));
    const card = (id: string, agentId: string, name: string, model: string, atMs: number, outcome = `✅ Set "${name}" model → ${model}`) => {
      w.store.putMgmtProposal({ id, ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'set_model', resolved: { agentId, agentName: name, model },
        summary: `Set "${name}" model → ${model}`, createdAtMs: atMs - 60_000, expiresAtMs: atMs + DAY, status: 'pending', source: 'agent', note: `Why ${name}` } as PendingConfirm);
      w.store.resolveMgmtProposal(id, 'confirmed', atMs);
      w.store.setMgmtProposalOutcome(id, outcome);
    };
    card('c_kitchen', 'a1', 'Kitchen', 'claude-haiku-4-5', T0);
    card('c_pik', 'pik', 'Friends Book', 'claude-haiku-4-5', T0 + 30_000);
    card('c_failed', 'a9', 'Quiet', 'claude-haiku-4-5', T0 + 60_000, '⚠ Failed — Set "Quiet" model → claude-haiku-4-5: no');
    w.store.putMgmtProposal({ id: 'c_other', ownerId: OWNER, chatId: 0, fromUserId: 0, messageId: 0, tool: 'stop_agent', resolved: { agentId: 'a9', agentName: 'Quiet' },
      summary: 'Stop', createdAtMs: T0, expiresAtMs: T0 + DAY, status: 'pending' } as PendingConfirm);
    w.store.resolveMgmtProposal('c_other', 'confirmed', T0);
    return w;
  }

  it('seeds the confirmed cards and the switch back made through the API, once', () => {
    const { store } = seeded();
    const now = T0 + 6 * HOUR;
    expect(backfillModelLedger(store, now)).toBe(3);
    expect(backfillModelLedger(store, now)).toBe(0);
    const kitchen = store.listModelChanges({ agentId: 'a1' });
    expect(kitchen).toHaveLength(1);
    expect(kitchen[0]).toMatchObject({ id: 'mcb_c_kitchen', from: 'claude-opus-4-8', to: 'claude-haiku-4-5', at: iso(T0), by: 'agent', via: 'backfill', why: 'Why Kitchen', proposalId: 'c_kitchen' });
    expect(kitchen[0]!.before).toMatchObject({ model: 'claude-opus-4-8', turns: 30, basis: 'window' });
    const pik = store.listModelChanges({ agentId: 'pik' }).reverse();
    expect(pik.map((c) => [c.from, c.to, c.approx ?? false])).toEqual([
      ['claude-sonnet-5', 'claude-haiku-4-5', false],
      ['claude-haiku-4-5', 'claude-sonnet-5', true],
    ]);
    // The switch back is timed just after the last use of haiku.
    expect(pik[1]!.at).toBe(iso(T0 + 2.5 * HOUR + 1000));
    expect(pik[1]!.before).toMatchObject({ model: 'claude-haiku-4-5', turns: 6 });
    expect(store.listModelChanges({ agentId: 'a9' })).toEqual([]);
  });

  it('runs at start-up, and once hour buckets arrive a backfilled change gets its before from them', async () => {
    const w = seeded();
    const f = Fastify();
    await registerRoutes(f, { store: w.store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    expect(w.store.listModelChanges({ ownerId: OWNER })).toHaveLength(3);
    await f.close();
    const f2 = Fastify();
    await registerRoutes(f2, { store: w.store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    expect(w.store.listModelChanges({ ownerId: OWNER })).toHaveLength(3); // idempotent
    await f2.close();
    const now = T0 + 2 * DAY;
    w.store.setModelProfile('a1', profile(now, {
      'claude-opus-4-8': hourly({ [T0 - 3 * DAY]: { calls: 20, turns: 10, input: 1e5 }, [T0 - DAY]: { calls: 20, turns: 10, input: 1e5 } }),
      'claude-haiku-4-5': hourly({ [T0 + DAY]: { calls: 4, turns: 4 } }),
    }), iso(now));
    evaluateModelChanges(w.store, now);
    expect(w.store.getModelChange('mcb_c_kitchen')!.before).toMatchObject({ basis: 'hours', turns: 20 });
  });
});
