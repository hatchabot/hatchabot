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
import { USAGE_READER_SCRIPT, agentUsage, type WindowModelStats } from '../src/orchestrator/usage.js';
import { sampleAgentUsage } from '../src/orchestrator/sourceUsage.js';
import { buildScorecard, coverageDays, type StoredProfile } from '../src/orchestrator/modelScorecard.js';
import { MODEL_CATALOG, modelKey, modelOption, modelOptionsFor, priceMix } from '../src/orchestrator/modelOptions.js';
import { MODEL_PRICES, CACHE_READ_SHARE } from '../src/orchestrator/pricing.js';
import { MODEL_REVIEW_NAME, modelReviewSetting, syncModelReviewCron } from '../src/orchestrator/modelReview.js';
import { rebuildAgent } from '../src/orchestrator/provision.js';
import { OPS_AGENTS_MD, OPS_MANAGED_HEADINGS, OPS_MODEL_REVIEW_MESSAGE, OPS_SOUL, opsSection } from '../src/ops/opsAgent.js';
import { replaceSection } from '../src/openclaw/workspace.js';
import { MANIFEST, toolDef } from '../src/mgmt/tools.js';
import { opsDoorTools } from '../src/ops/opsTools.js';
import { ENV_SETTINGS } from '../src/config/envCatalog.js';
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

// ---------------------------------------------------------------------------
// The reader: what the transcripts say about turns, tools and errors.
// ---------------------------------------------------------------------------

function runReader(build: (root: string) => void): any {
  const base = mkdtempSync(join(tmpdir(), 'hb-steward-'));
  const root = join(base, 'agents');
  mkdirSync(root, { recursive: true });
  build(root);
  const script = USAGE_READER_SCRIPT.replace('"/home/node/.openclaw/agents"', JSON.stringify(root));
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', script], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}

const usage = (input: number, output = 10, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const assistant = (model: string, stopReason: string, u = usage(100), tools = 0, errorMessage?: string) => ({
  role: 'assistant', model, stopReason, usage: u,
  content: [{ type: 'text', text: 'x' }, ...Array.from({ length: tools }, (_, i) => ({ type: 'toolCall', id: `t${i}`, name: 'read', arguments: {} }))],
  ...(errorMessage !== undefined ? { errorMessage } : {}),
});
const user = () => ({ role: 'user', content: 'hello' });
const toolResult = (isError = false) => ({ role: 'toolResult', toolCallId: 't0', toolName: 'read', isError, content: [{ type: 'text', text: 'r' }] });

describe('the usage reader profiles the last 30 days', () => {
  it('counts turns, tool use, context size and how turns ended, per model', () => {
    const now = Date.now();
    const out = runReader((root) => {
      mkdirSync(join(root, 'kitchen', 'agent'), { recursive: true });
      const db = new Database(join(root, 'kitchen', 'agent', 'openclaw-agent.sqlite'));
      db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
      const ins = db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)');
      let seq = 0;
      const put = (sid: string, at: number, message: object, extra: object = {}) => ins.run(sid, seq++, at, JSON.stringify({ type: 'message', id: `e${seq}`, message, ...extra }));
      const t0 = now - 2 * 3_600_000;
      // Turn 1 (opus): two tool rounds, one failed tool, then an answer.
      put('s1', t0, user());
      put('s1', t0 + 1, assistant('claude-opus-4-8', 'toolUse', usage(100, 10, 1000, 0), 2));
      put('s1', t0 + 2, toolResult(true));
      put('s1', t0 + 3, assistant('claude-opus-4-8', 'toolUse', usage(100, 10, 2000, 0), 1));
      put('s1', t0 + 4, assistant('claude-opus-4-8', 'stop', usage(100, 50, 3000, 0)));
      // Turn 2 (haiku): a malformed tool call ends it.
      put('s1', t0 + 10, user());
      put('s1', t0 + 11, assistant('claude-haiku-4-5', 'error', usage(0, 0), 0, 'Provider completed tool call with malformed JSON arguments'));
      // Turn 3 (haiku): rate-limited, then retried and answered — not a failed turn.
      put('s1', t0 + 20, user());
      put('s1', t0 + 21, assistant('claude-haiku-4-5', 'error', usage(0, 0), 0, '{"type":"error","error":{"type":"rate_limit_error"}}'));
      put('s1', t0 + 22, assistant('claude-haiku-4-5', 'stop', usage(400)));
      // Turn 4 (haiku): ran out of output room.
      put('s1', t0 + 30, user());
      put('s1', t0 + 31, assistant('claude-haiku-4-5', 'length', usage(300)));
      // Older than 30 days: in the totals, not in the window.
      put('s0', now - 40 * DAY, user());
      put('s0', now - 40 * DAY + 1, assistant('claude-opus-4-8', 'stop', usage(5000)));
      // A delivery copy of a reply: not a call, not a turn.
      put('s1', t0 + 40, { role: 'assistant', model: 'delivery-mirror', stopReason: 'stop', usage: usage(0, 0), openclawDeliveryMirror: true, content: [] });
      // A prompt error event.
      ins.run('s1', seq++, t0 + 50, JSON.stringify({ type: 'custom', id: 'c1', customType: 'openclaw:prompt-error', data: {} }));
      db.close();
      writeFileSync(join(root, 'kitchen', 'agent', 'SOUL.md'), '# Soul\n\n## Purpose\nPlan the week\'s meals   and the\nshopping list.\n\n## Vibe\nWarm.\n');
      // The gateway's cron store: one task of the owner's, one disabled, one of OpenClaw's own.
      mkdirSync(join(root, '..', 'state'), { recursive: true });
      const st = new Database(join(root, '..', 'state', 'openclaw.sqlite'));
      st.exec('CREATE TABLE cron_jobs (job_id TEXT, enabled INTEGER, declaration_key TEXT)');
      st.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?)').run('j1', 1, null);
      st.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?)').run('j2', 0, null);
      st.prepare('INSERT INTO cron_jobs VALUES (?, ?, ?)').run('j3', 1, 'skill-collection-review:kitchen');
      st.close();
    });
    const opus = out.window.models['claude-opus-4-8'];
    const haiku = out.window.models['claude-haiku-4-5'];
    expect(opus).toMatchObject({ calls: 3, turns: 1, toolTurns: 1, toolCalls: 3, toolUseCalls: 2, failedTurns: 0 });
    expect(opus.err.toolFailed).toBe(1);
    // Context per call: input + cache = 1100, 2100, 3100 → median 2100, p90 3100.
    expect([opus.ctxP50, opus.ctxP90]).toEqual([2100, 3100]);
    expect(haiku).toMatchObject({ calls: 2, turns: 3, failedTurns: 1, failed7d: 2 });
    expect(haiku.err).toMatchObject({ malformedToolCall: 1, rateLimited: 1, retried: 1, truncated: 1, providerError: 0 });
    expect(out.window.models['delivery-mirror']).toBeUndefined();
    expect(out.window.promptErrors).toBe(1);
    // The lifetime totals still count the old call.
    expect(out.models['claude-opus-4-8'].calls).toBe(4);
    expect(out.purposes.kitchen).toBe('Plan the week\'s meals and the shopping list.');
    expect(out.crons).toBe(1);
  });

  it('agentUsage hands the profile on; the sampler stores it with only the agent\'s own purpose', async () => {
    const store = new Store(new Database(':memory:'));
    const p = new MockProvider();
    const { runtimeRef } = await p.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} } as any);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    const win = { since: 1, models: { 'claude-opus-4-8': stats({ calls: 4 }) }, promptErrors: 0 };
    p.usage.set(runtimeRef, { models: { 'claude-opus-4-8': { calls: 4, input: 400, output: 40, cacheRead: 0, cacheWrite: 0, sessions: 1 } }, sessions: 1, first: 5, last: 9, window: win, purposes: { kitchen: 'Meals.', main: 'Not this one.' }, crons: 2 });
    const u = await agentUsage(p, runtimeRef, 'kitchen');
    expect(u.profile).toMatchObject({ crons: 2, firstCall: 5, purposes: { kitchen: 'Meals.' } });
    await sampleAgentUsage({ store, providerFor: () => p }, store.getAgent('a1')!);
    const saved = store.modelProfiles(['a1']).get('a1')!.profile as StoredProfile;
    expect(saved.purpose).toBe('Meals.');
    expect(JSON.stringify(saved)).not.toContain('Not this one');
    expect(saved.crons).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The scorecard: math, scoping, and no container touched.
// ---------------------------------------------------------------------------

function stats(o: Partial<Omit<WindowModelStats, 'err'>> & { err?: Partial<WindowModelStats['err']> } = {}): WindowModelStats {
  return {
    calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolUseCalls: 0, turns: 0, toolTurns: 0, toolCalls: 0,
    failedTurns: 0, failed7d: 0, first: 0, last: 0, ctxP50: 0, ctxP90: 0,
    ...o,
    err: { malformedToolCall: 0, providerError: 0, rateLimited: 0, aborted: 0, truncated: 0, toolFailed: 0, retried: 0, ...(o.err ?? {}) },
  };
}

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  const now = Date.parse('2026-10-03T12:00:00Z');
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-6', 'claude-mythos-5'], secretRef: 'ai/key', createdAt: 'now' });
  store.insertAIProfile({ id: 'plan', ownerId: OWNER, name: 'Max plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', models: ['claude-haiku-4-5'], shared: true, createdAt: 'now' });
  const add = (id: string, owner: string, profile: string, state = 'RUNNING') =>
    store.insertAgent({ id, ownerId: owner, name: `Agent ${id}`, slug: id, state: state as any, aiProfileId: profile, hostId: 'h1', runtimeRef: `ref-${id}`, persona: `Persona of ${id}`, sharedMemory: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: 'now' });
  add('busy', OWNER, 'key');
  add('quiet', OWNER, 'key');
  add('sleepy', OWNER, 'plan', 'STOPPED');
  store.setHibernated('sleepy', '2026-10-02T00:00:00Z');
  add('theirs', MEMBER, 'plan');
  add('old', OWNER, 'key', 'ARCHIVED');
  store.setAgentModel('quiet', 'claude-sonnet-5');
  const at = new Date(now - 3_600_000).toISOString();
  // The reader's window starts 30 days before the reading.
  const since = Date.parse(at) - 30 * DAY;
  const P = (models: Record<string, WindowModelStats>, extra: Partial<StoredProfile> = {}): StoredProfile => ({ since, models, promptErrors: 0, crons: 1, firstCall: since - DAY, ...extra });
  // 30 days on opus: 1M input, 0.1M output, 9M cache read, 0.5M cache write.
  store.setModelProfile('busy', P({ 'claude-opus-4-8': stats({ calls: 300, input: 1e6, output: 1e5, cacheRead: 9e6, cacheWrite: 5e5, turns: 100, toolTurns: 80, toolCalls: 400, ctxP50: 40_000, ctxP90: 90_000,
    failedTurns: 2, failed7d: 1, err: { malformedToolCall: 1, toolFailed: 7 } }) }, { purpose: 'Runs the house accounts.' }), at);
  // Switched last night: a week on sonnet before, three turns on haiku since.
  store.setModelProfile('quiet', P({
    'claude-sonnet-5': stats({ calls: 40, input: 2e5, output: 2e4, turns: 20, toolTurns: 2, toolCalls: 2, last: now - 2 * DAY }),
    'claude-haiku-4-5': stats({ calls: 3, input: 3e4, output: 3e3, turns: 3, failedTurns: 1, failed7d: 1, last: now - 3_600_000, err: { malformedToolCall: 1 } }),
  }), at);
  store.setModelProfile('sleepy', P({ 'claude-opus-4-8': stats({ calls: 10, input: 1e5, output: 1e4, turns: 10 }) }), '2026-10-01T00:00:00Z');
  store.setModelProfile('theirs', P({ 'claude-opus-4-8': stats({ calls: 30, input: 3e5, output: 3e4, turns: 30 }) }), at);
  return { store, provider, now };
}

describe('the model scorecard', () => {
  it('prices the window on the current model, scaled to a month, with cheaper models on the same source', async () => {
    const { store, now } = await world();
    const card = buildScorecard(store, OWNER, { now });
    const busy = card.rows.find((r) => r.id === 'busy')!;
    // 30 days of history (first call before the window): the month is the window.
    expect(busy.days).toBe(30);
    // Opus 4.8: (1M + 1.25×0.5M + 0.1×9M) × $5 + 0.1M × $25 = $12.625 + $2.5.
    expect(busy.monthlyUSD).toBeCloseTo(15.13, 2);
    expect(busy.cacheShare).toBeCloseTo(9e6 / 10.5e6, 2);
    expect(busy.tokensM).toEqual({ in: 1, out: 0.1, cacheRead: 9, cacheWrite: 0.5 });
    expect(busy.ctxK).toEqual({ p50: 40, p90: 90 });
    expect(busy.toolTurnShare).toBe(0.8);
    expect(busy.toolsPerTurn).toBe(4);
    expect(busy.errors).toEqual({ malformedToolCall: 1, toolFailed: 7, failedTurns: 2, failed7d: 1 });
    expect(busy.purpose).toBe('Runs the house accounts.');
    expect(busy.scheduledTasks).toBe(1);
    expect(busy.pinned).toBe(false);
    expect(busy.evidence).toBe('ok');
    // Sonnet 5 at $2/$10: (1M + 0.625M + 0.9M) × 2 + 0.1M × 10 = $6.05 → saves $9.07 (9.075, rounded in binary).
    // Haiku (listed under its dated id) at $1/$5: $3.025 → saves $12.10.
    // Opus 4.6 is legacy and Mythos invitation-only: neither offered.
    expect(busy.cheaperOptions).toEqual([
      { model: 'claude-haiku-4-5-20251001', monthlyUSD: 3.03, savingUSD: 12.1, tier: 1 },
      { model: 'claude-sonnet-5', monthlyUSD: 6.05, savingUSD: 9.07, tier: 2 },
    ]);
  });

  it('shows before and after a switch, and calls three turns on the new model thin evidence', async () => {
    const { store, now } = await world();
    const quiet = buildScorecard(store, OWNER, { now }).rows.find((r) => r.id === 'quiet')!;
    expect(quiet.model).toBe('claude-sonnet-5');
    expect(quiet.pinned).toBe(true);
    expect(quiet.evidence).toBe('ok');
    expect(quiet.byModel?.map((m) => [m.model, m.turns, m.malformed])).toEqual([['claude-haiku-4-5', 3, 1], ['claude-sonnet-5', 20, 0]]);
    store.setAgentModel('quiet', 'claude-haiku-4-5');
    const after = buildScorecard(store, OWNER, { now }).rows.find((r) => r.id === 'quiet')!;
    expect(after.evidence).toBe('thin');
    expect(after.turnsOnModel).toBe(3);
    expect(after.cheaperOptions).toEqual([]);
  });

  it('a plan source: an API-price equivalent and the agent\'s share of everything on the plan, any account\'s', async () => {
    const { store, now } = await world();
    const sleepy = buildScorecard(store, OWNER, { now }).rows.find((r) => r.id === 'sleepy')!;
    expect(sleepy.billing).toBe('plan');
    // sleepy: 0.1M in + 0.01M out on opus = $0.75; the member's agent on the same plan: $2.25.
    expect(sleepy.planShare).toBe(0.25);
    expect(sleepy.cheaperOptions.map((o) => o.model)).toEqual(['claude-haiku-4-5']);
  });

  it('is the caller\'s own: a member sees only theirs, archived agents are counted, not listed', async () => {
    const { store, now } = await world();
    const mine = buildScorecard(store, OWNER, { now });
    expect(mine.rows.map((r) => r.id).sort()).toEqual(['busy', 'quiet', 'sleepy']);
    expect(mine.archived).toBe(1);
    const theirs = buildScorecard(store, MEMBER, { now });
    expect(theirs.rows.map((r) => r.id)).toEqual(['theirs']);
    expect(JSON.stringify(theirs)).not.toContain('house accounts');
  });

  it('an asleep agent shows its last reading and is not woken: no container is touched', async () => {
    const { store, provider, now } = await world();
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    const res = await f.inject({ method: 'GET', url: '/v1/model-scorecard', headers: { 'x-hatchabot-owner': OWNER } });
    expect(res.statusCode).toBe(200);
    const sleepy = res.json().rows.find((r: { id: string }) => r.id === 'sleepy');
    expect(sleepy.state).toBe('asleep');
    expect(sleepy.readHoursAgo).toBeGreaterThan(24);
    expect(provider.execLog).toEqual([]);
    expect(store.getAgent('sleepy')!.state).toBe('STOPPED');
  });

  it('caps the rows, costliest first, and says how many were left out', async () => {
    const { store, now } = await world();
    const card = buildScorecard(store, OWNER, { now, limit: 1 });
    expect(card.rows.map((r) => r.id)).toEqual(['busy']);
    expect(card.omitted).toBe(2);
    expect(card.totals.bestSavingUSD).toBeGreaterThan(12);
  });

  it('an agent with no reading yet has no evidence and no estimate', async () => {
    const { store, now } = await world();
    store.insertAgent({ id: 'new', ownerId: OWNER, name: 'New', slug: 'new', state: 'RUNNING', aiProfileId: 'key', hostId: 'h1', runtimeRef: 'ref-new', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    const row = buildScorecard(store, OWNER, { now }).rows.find((r) => r.id === 'new')!;
    expect(row).toMatchObject({ evidence: 'none', calls: 0, cheaperOptions: [] });
    expect(row.monthlyUSD).toBeUndefined();
  });

  it('a young agent\'s days scale its month up, never from less than a day', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const p = { since: now - 30 * DAY, models: {}, promptErrors: 0, crons: null, firstCall: now - 6 * DAY } as StoredProfile;
    expect(coverageDays(p, now)).toBeCloseTo(6, 5);
    expect(coverageDays({ ...p, firstCall: now - 60_000 }, now)).toBe(1);
    expect(coverageDays({ ...p, firstCall: 0 }, now, '2026-09-30T12:00:00Z')).toBeCloseTo(3, 5);
  });
});

// ---------------------------------------------------------------------------
// The options table.
// ---------------------------------------------------------------------------

describe('model options', () => {
  it('agrees with pricing.ts wherever both price a model (prices read 2026-10-03)', () => {
    for (const m of MODEL_CATALOG) {
      const p = MODEL_PRICES[m.id];
      if (!p) continue;
      expect([m.input, m.output], m.id).toEqual(p);
      expect(m.cacheRead, m.id).toBe(CACHE_READ_SHARE[m.id] ?? 0.1);
    }
    expect(modelOption('claude-opus-5-5')).toMatchObject({ input: 4, output: 20 });
    expect(modelOption('claude-opus-5')).toMatchObject({ input: 5, output: 25 });
    expect(modelOption('claude-sonnet-5-5')).toMatchObject({ input: 2, output: 10 });
    expect(modelOption('claude-sonnet-5')).toMatchObject({ input: 2, output: 10 });
    expect(modelOption('claude-haiku-4-5')).toMatchObject({ input: 1, output: 5 });
    expect(modelOption('claude-fable-5-1')).toMatchObject({ input: 10, output: 50, cacheRead: 0.025 });
    expect(modelOption('claude-haiku-4-5')!.note).toMatch(/tool/);
  });

  it('reads dated and vendor-prefixed ids as their model', () => {
    expect(modelKey('anthropic/claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(priceMix('claude-haiku-4-5-20251001', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(1);
    expect(priceMix('mystery', { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeUndefined();
  });

  it('lists each source\'s models once, strongest first, with prices and a note; GET /v1/model-options is the caller\'s', async () => {
    const { store, provider } = await world();
    const o = modelOptionsFor(store.listAIProfiles(OWNER));
    const key = o.sources.find((s) => s.source === 'API key')!;
    expect(key.billing).toBe('api');
    expect(key.models[0]!.id).toBe('claude-mythos-5');
    expect(key.models.find((m) => m.id === 'claude-sonnet-5')).toMatchObject({ inUSDPerM: 2, outUSDPerM: 10, cacheReadUSDPerM: 0.2, tier: 2 });
    expect(key.models.find((m) => m.id === 'claude-opus-4-6')?.legacy).toBe(true);
    expect(o.sources.find((s) => s.source === 'Max plan')!.billing).toBe('plan');
    expect(o.notes.join(' ')).toMatch(/tool use/);
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    // A member sees the shared plan, never the owner's key.
    const res = await f.inject({ method: 'GET', url: '/v1/model-options', headers: { 'x-hatchabot-owner': MEMBER } });
    expect(res.json().sources.map((s: { source: string }) => s.source)).toEqual(['Max plan']);
    expect(provider.execLog).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The management agent: its purpose, its notes, its tools, its weekly task.
// ---------------------------------------------------------------------------

describe('the management agent as model steward', () => {
  it('names token steward (the model included) as a purpose, and keeps a managed "Token stewardship" section with the model procedure', () => {
    expect(OPS_SOUL).toMatch(/## Token steward\n[\s\S]*least\s+capable\s+model\s+that\s+does\s+its\s+job\s+WELL/);
    expect(OPS_MANAGED_HEADINGS).toContain('## Token stewardship');
    expect(OPS_MANAGED_HEADINGS).not.toContain('## Model stewardship');
    const section = opsSection('## Token stewardship')!;
    for (const must of ['get_model_scorecard', 'get_model_options', 'Prefer no change', 'thin', 'heavy tool use', 'recent errors', 'set_model', 'why', 'Never wake a sleeping agent', 'only for the owner', 'STRONGER']) {
      expect(section, must).toContain(must);
    }
    // One section, not two headings' worth.
    expect(section.match(/^## /gm)).toHaveLength(1);
    expect(OPS_AGENTS_MD.match(/^## Token stewardship$/gm)).toHaveLength(1);
    expect(OPS_AGENTS_MD.match(/^## Model stewardship$/gm)).toBeNull();
  });

  it('the section lands once on an older AGENTS.md and is replaced, not duplicated, on the next build', () => {
    const old = '# Operating notes\n\n## Who you act for\nOld text.\n\n## Memory\nOld memory note.\n';
    const section = opsSection('## Token stewardship')!;
    const once = replaceSection(old, '## Token stewardship', section);
    expect(once.match(/## Token stewardship/g)).toHaveLength(1);
    const stale = once.replace('Prefer no change:', 'Change everything:');
    const twice = replaceSection(stale, '## Token stewardship', section);
    expect(twice.match(/## Token stewardship/g)).toHaveLength(1);
    expect(twice).toContain('Prefer no change:');
    expect(twice).not.toContain('Change everything:');
    expect(twice).toContain('Old memory note.');
  });

  it('its reads are on its menu as read tools, served by the ops door without a why', () => {
    expect(toolDef('get_model_scorecard')?.tier).toBe('read');
    expect(toolDef('get_model_options')?.tier).toBe('read');
    expect(toolDef('get_model_changes')?.tier).toBe('read');
    const door = opsDoorTools().filter((t) => t.name.startsWith('get_model_'));
    expect(door).toHaveLength(3);
    for (const t of door) expect(JSON.stringify(t.inputSchema)).not.toContain('"why"');
    expect(MANIFEST.filter((t) => t.name === 'get_model_scorecard')).toHaveLength(1);
  });

  it('the weekly review message asks for a short digest and no waking', () => {
    expect(OPS_MODEL_REVIEW_MESSAGE).toMatch(/Token stewardship/);
    expect(OPS_MODEL_REVIEW_MESSAGE).toMatch(/one line each at most/);
    expect(OPS_MODEL_REVIEW_MESSAGE).toMatch(/Do not wake/);
  });

  it('HATCHABOT_MODEL_REVIEW is in the env catalog: weekly by default, off turns it off', () => {
    expect(ENV_SETTINGS.find((s) => s.name === 'HATCHABOT_MODEL_REVIEW')).toMatchObject({ group: 'manager', default: 'weekly' });
    expect(modelReviewSetting(undefined)).toBe('weekly');
    expect(modelReviewSetting('')).toBe('weekly');
    expect(modelReviewSetting('weekly')).toBe('weekly');
    expect(modelReviewSetting(' OFF ')).toBe('off');
  });
});

describe('the weekly model review task', () => {
  async function opsWorld() {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'ops1', slug: 'hatchabot', workspace: { files: {}, configPatch: { agentId: 'hatchabot', authMode: 'api-key' } }, env: {} } as any);
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    store.insertAgent({ id: 'ops1', ownerId: OWNER, name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    store.setAgentOps('ops1', true);
    store.setAgentWebOnly('ops1', true);
    // The mock's cron store: what `cron list` answers, and what `cron add` adds.
    const jobs: Array<{ id: string; name: string; enabled: boolean; payload: object; schedule: object; sessionTarget?: string; sessionKey?: string }> = [];
    const listed = () => ({ code: 0, stdout: JSON.stringify({ jobs }), stderr: '' });
    const origExec = provider.exec.bind(provider);
    provider.exec = async (ref, argv, opts) => {
      const r = await origExec(ref, argv, opts);
      if (argv[0] === 'cron' && argv[1] === 'list') return listed();
      if (argv[0] === 'cron' && argv[1] === 'add') {
        const id = `job-${jobs.length + 1}`;
        const name = argv[argv.indexOf('--name') + 1]!;
        jobs.push({ id, name, enabled: true, payload: { kind: 'agentTurn', message: argv[argv.indexOf('--message') + 1] }, schedule: { kind: 'cron', expr: argv[argv.indexOf('--cron') + 1] } });
        return { code: 0, stdout: JSON.stringify({ id }), stderr: '' };
      }
      if (argv[0] === 'cron' && argv[1] === 'rm') { const i = jobs.findIndex((j) => j.id === argv[2]); if (i >= 0) jobs.splice(i, 1); return { code: 0, stdout: '', stderr: '' }; }
      return r;
    };
    provider.info = async () => ({ openclawVersion: '2026.9.6' } as any);
    return { store, provider, runtimeRef, jobs, agent: store.getAgent('ops1')! };
  }

  it('a rebuild of an existing management agent sets it up too (it is never provisioned again, 2026-10-03)', async () => {
    const { store, provider, jobs } = await opsWorld();
    const secrets = { async get() { return 'not-a-real-key'; }, async put() {}, async delete() {} };
    const events: string[] = [];
    const after = await rebuildAgent({ store, secrets, provider, channel: { kind: 'telegram', pool: { owns: () => false } }, log: () => (e: string) => events.push(e), sleep: async () => {} } as never, 'ops1');
    expect(after.state).toBe('RUNNING');
    expect(jobs.map((j) => j.name)).toContain(MODEL_REVIEW_NAME);
    expect(store.managedCron('ops1', MODEL_REVIEW_NAME)).toBeTruthy();
  });

  it('is made once, delivered to its console conversation when it has no chat app, and listed like any task', async () => {
    const { store, provider, runtimeRef, jobs, agent } = await opsWorld();
    expect(await syncModelReviewCron({ store, provider }, agent, runtimeRef, 'weekly')).toBe('created');
    expect(jobs.map((j) => j.name)).toEqual([MODEL_REVIEW_NAME]);
    const add = provider.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')!;
    expect(add).toEqual(expect.arrayContaining(['--cron', '0 9 * * 1', '--session', 'current', '--session-key', 'agent:hatchabot:main', '--announce']));
    expect(add[add.indexOf('--message') + 1]).toBe(OPS_MODEL_REVIEW_MESSAGE);
    // The next build: remembered, no CLI call at all.
    const before = provider.execLog.length;
    expect(await syncModelReviewCron({ store, provider }, agent, runtimeRef, 'weekly')).toBe('kept');
    expect(provider.execLog.length).toBe(before);
    expect(jobs).toHaveLength(1);
  });

  it('adopts one already there by name instead of adding a second', async () => {
    const { store, provider, runtimeRef, jobs, agent } = await opsWorld();
    jobs.push({ id: 'job-x', name: MODEL_REVIEW_NAME, enabled: true, payload: {}, schedule: {} });
    expect(await syncModelReviewCron({ store, provider }, agent, runtimeRef, 'weekly')).toBe('present');
    expect(jobs).toHaveLength(1);
    expect(store.managedCron('ops1', MODEL_REVIEW_NAME)?.jobId).toBe('job-x');
  });

  it('off removes the task it made, and leaves alone what it did not make', async () => {
    const { store, provider, runtimeRef, jobs, agent } = await opsWorld();
    await syncModelReviewCron({ store, provider }, agent, runtimeRef, 'weekly');
    jobs.push({ id: 'mine', name: 'Weekly model-fit audit', enabled: true, payload: {}, schedule: {} });
    expect(await syncModelReviewCron({ store, provider }, agent, runtimeRef, 'off')).toBe('removed');
    expect(jobs.map((j) => j.name)).toEqual(['Weekly model-fit audit']);
    expect(store.managedCron('ops1', MODEL_REVIEW_NAME)).toBeUndefined();
    expect(await syncModelReviewCron({ store, provider }, agent, runtimeRef, 'off')).toBe('off');
    expect(jobs).toHaveLength(1);
    // Turned back on: made again.
    expect(await syncModelReviewCron({ store, provider }, agent, runtimeRef, 'weekly')).toBe('created');
  });

  it('is only for the management agent', async () => {
    const { store, provider, runtimeRef, jobs, agent } = await opsWorld();
    expect(await syncModelReviewCron({ store, provider }, { ...agent, ops: false }, runtimeRef, 'weekly')).toBe('skipped');
    expect(jobs).toHaveLength(0);
  });
});
