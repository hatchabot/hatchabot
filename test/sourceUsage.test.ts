import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { logKey, parseModelCalls, sampleAgentUsage, sampleSourceUsage, summarizeSourceUsage } from '../src/orchestrator/sourceUsage.js';
import { aiSourceHealth } from '../src/orchestrator/health.js';
import { totalOf } from './helpers/usageFake.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

// Lines exactly as OpenClaw writes them (docker logs --timestamps prefix).
const line = (ts: string, status: number, model = 'claude-opus-4-8') =>
  `${ts} ${ts.replace(/\d{3}Z$/, '')}+00:00 [provider-transport-fetch] [model-fetch] response provider=anthropic api=anthropic-messages model=${model} status=${status} elapsedMs=458 contentType=application/json`;

describe('parseModelCalls', () => {
  it('reads timestamp, provider, model and status from real OpenClaw lines; ignores the rest', () => {
    const text = [
      '2026-09-10T15:48:58.345060357Z 2026-09-10T15:48:58.344+00:00 [provider-transport-fetch] [model-fetch] response provider=anthropic api=anthropic-messages model=claude-opus-4-8 status=429 elapsedMs=458 contentType=application/json',
      '2026-09-15T17:38:39.956125290Z 2026-09-15T17:38:39.955+00:00 [provider-transport-fetch] [model-fetch] start provider=anthropic api=anthropic-messages model=claude-opus-4-8 method=POST url=https://api.anthropic.com/v1/messages',
      '2026-09-15T17:54:56.414290103Z 2026-09-15T17:54:56.413+00:00 [provider-transport-fetch] [model-fetch] response provider=anthropic api=anthropic-messages model=claude-sonnet-5 status=200 elapsedMs=1083 contentType=text/event-stream; charset=utf-8',
      '2026-09-10T15:48:58.357980776Z [telegram] embedded run agent end: … error=⚠️ API rate limit reached.',
    ].join('\n');
    expect(parseModelCalls(text)).toEqual([
      { at: '2026-09-10T15:48:58.345Z', key: '2026-09-10T15:48:58.345060357Z', provider: 'anthropic', model: 'claude-opus-4-8', status: 429 },
      { at: '2026-09-15T17:54:56.414Z', key: '2026-09-15T17:54:56.414290103Z', provider: 'anthropic', model: 'claude-sonnet-5', status: 200 },
    ]);
  });
});

describe('the log cursor, and samples that overlap (#107, #108, #109)', () => {
  const T = '2026-09-15T15:48:58';
  const lines = (...ns: string[]) => ns.map((n) => line(`${T}.${n}Z`, 503)).join('\n');
  const failedIn = (store: Store, agentId: string) => store.modelCallHoursForAgents(new Set([agentId]), '2026-09-15T15').reduce((s, h) => s + h.failed, 0);

  it('a later line in the millisecond the cursor stopped at is still counted (#108)', async () => {
    const { store, provider } = await world();
    const deps = { store, providerFor: () => provider };
    const a = store.getAgent('a')!;
    provider.modelCallLines = lines('345060357');
    await sampleAgentUsage(deps, a, Date.parse('2026-09-15T16:00:00Z'));
    expect(store.usageCursor('a')!.lastTs).toBe(`${T}.345060357Z`);
    // docker's next read (from the cursor) has that line and a later one in the same millisecond.
    provider.modelCallLines = lines('345060357', '345900001');
    await sampleAgentUsage(deps, a, Date.parse('2026-09-15T16:10:00Z'));
    expect(failedIn(store, 'a')).toBe(2);
    // A cursor stored before (milliseconds only) still covers its whole millisecond.
    expect(logKey(`${T}.345Z`)).toBe(`${T}.345999999Z`);
    expect(logKey(`${T}.3Z`)).toBe(`${T}.300000000Z`);
  });

  it('two samples of one agent at once count its calls once (#109)', async () => {
    const { store, provider } = await world();
    const deps = { store, providerFor: () => provider };
    const a = store.getAgent('a')!;
    provider.modelCallLines = lines('100000000', '200000000', '300000000');
    const now = Date.parse('2026-09-15T16:00:00Z');
    await Promise.all([sampleAgentUsage(deps, a, now), sampleAgentUsage(deps, a, now)]);
    expect(failedIn(store, 'a')).toBe(3);
  });

  it('calls made while a saved source switch waits for its rebuild are the running source\'s (#107)', async () => {
    const { store, provider } = await world();
    store.insertAIProfile({ id: 'key2', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key2', createdAt: 'now' } as any);
    store.setAgentApplied('a', 'max', 'claude-opus-4-8');
    store.setAgentAIProfile('a', 'key2'); // saved, not yet rebuilt
    provider.modelCallLines = lines('100000000');
    await sampleAgentUsage({ store, providerFor: () => provider }, store.getAgent('a')!, Date.parse('2026-09-15T16:00:00Z'));
    expect(store.modelCallHoursFor('max', '2026-09-15T15').map((h) => [h.agentId, h.failed])).toEqual([['a', 1]]);
    expect(store.modelCallHoursFor('key2', '2026-09-15T15')).toEqual([]);
  });

  it('after a rebuild that switches source, calls before the switch stay the old source\'s and are not counted under both', async () => {
    const { store, provider } = await world();
    store.insertAIProfile({ id: 'key2', ownerId: OWNER, name: 'API key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key2', createdAt: 'now' } as any);
    store.setAgentApplied('a', 'max', 'claude-opus-4-8');
    const deps = { store, providerFor: () => provider };
    provider.modelCallLines = '';
    // Calls in the 15:30 and 15:50 slots, on the plan.
    provider.usage.set('*', { ...totalOf(1000), callSlots: { '2026-09-15T15:35:00.000Z': 3, '2026-09-15T15:55:00.000Z': 2 } });
    await sampleAgentUsage(deps, store.getAgent('a')!, Date.parse('2026-09-15T16:00:00Z'));
    // The rebuild switches it to the key at 16:02; it calls once more after (the 16:05 slot), and is refused once.
    store.setAgentAIProfile('a', 'key2');
    store.setAgentApplied('a', 'key2', 'claude-opus-4-8', '2026-09-15T16:02:00.000Z');
    expect(store.getAgent('a')).toMatchObject({ appliedProfileId: 'key2', appliedProfilePrevId: 'max', appliedProfileAt: '2026-09-15T16:02:00.000Z' });
    provider.usage.set('*', { ...totalOf(1500), callSlots: { '2026-09-15T15:35:00.000Z': 3, '2026-09-15T15:55:00.000Z': 2, '2026-09-15T16:10:00.000Z': 1 } });
    provider.modelCallLines = [line('2026-09-15T16:01:00.000Z', 429), line('2026-09-15T16:06:00.000Z', 429)].join('\n');
    await sampleAgentUsage(deps, store.getAgent('a')!, Date.parse('2026-09-15T16:12:00Z'));
    await sampleAgentUsage(deps, store.getAgent('a')!, Date.parse('2026-09-15T16:20:00Z')); // a repeat changes nothing
    const slots = (p: string) => store.modelCallSlotsFor(p, '2026-09-15T15').filter((r) => r.agentId === 'a' && (r.ok || r.limited)).map((r) => [r.slot, r.ok, r.limited]).sort();
    expect(slots('max')).toEqual([['2026-09-15T15:30', 3, 0], ['2026-09-15T15:50', 2, 0], ['2026-09-15T16:00', 0, 1]]);
    expect(slots('key2')).toEqual([['2026-09-15T16:05', 1, 1]]);
    expect(store.limitHitsFor('max', '2026-09-15T15').map((h) => h.at)).toEqual(['2026-09-15T16:01:00.000Z']);
    expect(store.limitHitsFor('key2', '2026-09-15T15').map((h) => h.at)).toEqual(['2026-09-15T16:06:00.000Z']);
    // Hours too: the 16 hour is split between them, not counted twice.
    const hours = (p: string) => store.modelCallHoursFor(p, '2026-09-15T15').filter((r) => r.agentId === 'a').map((r) => [r.hour, r.ok]).sort();
    expect(hours('max')).toEqual([['2026-09-15T15', 5], ['2026-09-15T16', 0]]);
    expect(hours('key2')).toEqual([['2026-09-15T16', 1]]);
    // A rebuild that keeps the source keeps the switch's record.
    store.setAgentApplied('a', 'key2', 'claude-opus-4-8', '2026-09-15T17:00:00.000Z');
    expect(store.getAgent('a')!.appliedProfileAt).toBe('2026-09-15T16:02:00.000Z');
  });
});

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const OWNER = 'user-o';

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'max', ownerId: OWNER, name: 'Claude Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/max', shared: true, createdAt: 'now' } as any);
  for (const [id, slug, owner] of [['a', 'todo', OWNER], ['b', 'sched', OWNER], ['x', 'theirs', 'user-other']] as const) {
    const { runtimeRef } = await provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } as any }, env: {} });
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: owner, name: slug, slug, state: 'PROVISIONING', aiProfileId: 'max', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    store.setAgentRuntimeRef(id, runtimeRef);
    store.setAgentState(id, 'RUNNING');
  }
  return { store, provider };
}

describe('sampleSourceUsage + summarizeSourceUsage', () => {
  const NOW = Date.parse('2026-09-15T18:00:00Z');
  it('counts requests and 429s per window, flags a source limited until a call succeeds again, never double-counts', async () => {
    const { store, provider } = await world();
    // Refusals come from the log; successes from the transcripts, which have
    // every call (the log only has those over a second; review, 2026-09-29).
    provider.modelCallLines = [
      line('2026-09-15T15:48:58.345Z', 429),               // limited…
      line('2026-09-15T15:49:10.000Z', 429),
    ].join('\n');
    provider.usage.set('*', { ...totalOf(1000), callSlots: {
      '2026-09-10T12:05:00.000Z': 1,                        // 6 days ago: 7-day window only
      '2026-09-15T14:35:00.000Z': 1,                        // inside 5 h
    } });
    const deps = { store, providerFor: () => provider };
    await sampleSourceUsage(deps, NOW);
    await sampleSourceUsage(deps, NOW + 60_000); // same log text again: nothing new
    let [src] = summarizeSourceUsage(store, OWNER, NOW);
    // two of my agents each saw the same lines (mock shares one log) → counts double per agent, not per pass
    expect(src!.window7d.requests).toBe(8);
    expect(src!.window5h.requests).toBe(6);
    expect(src!.window5h.limited).toBe(4);
    expect(src!.status).toBe('limited');
    expect(src!.limitedSince).toBe('2026-09-15T15:48:58.345Z');
    expect(src!.hourly).toHaveLength(168);
    // Five-minute slots for the hour/day views: the two 429s at 15:48 and 15:49 share one slot (×2 agents).
    expect(src!.slots).toHaveLength(288);
    expect(src!.slots.find((x) => x.slot === '2026-09-15T15:45')).toEqual({ slot: '2026-09-15T15:45', ok: 0, limited: 4 });
    expect(src!.slots.find((x) => x.slot === '2026-09-15T14:30')).toEqual({ slot: '2026-09-15T14:30', ok: 2, limited: 0 });
    expect(src!.others).toEqual({ agents: 1, liveAgents: 1, requests5h: 3, requests7d: 4 }); // counts only, no names
    // …and so does the plan's 5-hour window passing with no call at all: the
    // limit has reset by then, whether or not anyone tried.
    expect(summarizeSourceUsage(store, OWNER, NOW + 5 * 3_600_000)[0]!.status).toBe('ok');
    expect(summarizeSourceUsage(store, OWNER, NOW + 2 * 3_600_000)[0]!.status).toBe('limited');
    // a later success clears it
    provider.usage.set('*', { ...totalOf(1000), last: Date.parse('2026-09-15T18:01:30.000Z'), callSlots: {
      '2026-09-10T12:05:00.000Z': 1, '2026-09-15T14:35:00.000Z': 1, '2026-09-15T18:05:00.000Z': 1,
    } });
    await sampleSourceUsage(deps, NOW + 120_000);
    [src] = summarizeSourceUsage(store, OWNER, NOW + 120_000);
    expect(src!.status).toBe('ok');
    expect(src!.limitHits7d).toBe(4);
  });

  // 2026-09-30: a member on a shared source got no banner for 5 h while the
  // source refused the owner's agents — status was judged from theirs alone.
  it('the status is the source\'s: every account\'s refusals and successes count, the history stays the viewer\'s', async () => {
    const { store } = await world();
    const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
    // The owner's agent is refused; the member's agent 'x' made no call since.
    store.addLimitHit('a', 'max', at(30), 'claude-opus-4-8');
    store.setUsageCursor('x', at(120), at(120));
    const [member] = summarizeSourceUsage(store, 'user-other', NOW);
    expect(member).toMatchObject({ id: 'max', mine: false, status: 'limited', limitedSince: at(30), limitHits7d: 0, liveAgents: 1 });
    expect(member!.lastLimitAt).toBeUndefined(); // whose refusal: not theirs to see
    const [owner] = summarizeSourceUsage(store, OWNER, NOW);
    expect(owner).toMatchObject({ mine: true, status: 'limited', liveAgents: 2, others: { liveAgents: 1 } });
    // Only the member's agent refused: the owner hears about it too.
    const { store: s2 } = await world();
    s2.addLimitHit('x', 'max', at(10), 'claude-opus-4-8');
    s2.setUsageCursor('a', at(60), at(60));
    expect(summarizeSourceUsage(s2, OWNER, NOW)[0]).toMatchObject({ status: 'limited', limitedSince: at(10), limitHits7d: 0 });
    // A success by anyone after the refusal clears it for everyone.
    s2.setUsageCursor('a', at(5), at(5));
    expect(summarizeSourceUsage(s2, 'user-other', NOW)[0]!.status).toBe('ok');
  });

  it('a success on an agent\'s old source does not mask a refusal on its new one (#114)', async () => {
    const { store } = await world();
    const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
    store.insertAIProfile({ id: 'key', ownerId: OWNER, name: 'Spare Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/key', createdAt: 'now' } as any);
    // 'a' answered on the spare key ten minutes ago, then moved to the plan, which refused it.
    store.setUsageCursor('a', at(10), at(10), undefined, 'key');
    store.setAgentAIProfile('a', 'max');
    store.addLimitHit('a', 'max', at(30), 'claude-opus-4-8');
    expect(summarizeSourceUsage(store, OWNER, NOW).find((s) => s.id === 'max')).toMatchObject({ status: 'limited', limitedSince: at(30) });
    expect(aiSourceHealth(store, store.getAgent('a')!)).toMatchObject({ lastAnsweredAt: undefined, refusal: 'refused' });
    // A success on the plan itself clears it.
    store.setUsageCursor('a', at(2), at(2), undefined, 'max');
    expect(summarizeSourceUsage(store, OWNER, NOW).find((s) => s.id === 'max')!.status).toBe('ok');
    expect(aiSourceHealth(store, store.getAgent('a')!).lastAnsweredAt).toBe(at(2));
  });

  it('successes come from the transcripts: the first pass replaces the log\'s partial counts, a repeat never doubles (review, 2026-09-29)', async () => {
    const { store, provider } = await world();
    const deps = { store, providerFor: () => provider };
    const agentIds = store.listAgents(OWNER).map((a) => a.id);
    // Before: the log saw only the slow calls — 1 in this slot.
    for (const id of agentIds) store.addModelCallSlots(id, store.getAgent(id)!.aiProfileId, new Map([['2026-09-15T14:30', { ok: 1, limited: 0, failed: 0 }]]));
    provider.modelCallLines = '';
    provider.usage.set('*', { ...totalOf(1000), callSlots: { '2026-09-15T14:35:00.000Z': 4 } });
    await sampleSourceUsage(deps, NOW);
    await sampleSourceUsage(deps, NOW + 600_000);
    const [src] = summarizeSourceUsage(store, OWNER, NOW + 600_000);
    expect(src!.slots.find((x) => x.slot === '2026-09-15T14:30')).toEqual({ slot: '2026-09-15T14:30', ok: 4 * agentIds.length, limited: 0 });
  });

  it('tokens are the sum of counter increases; a drop (a session reset) counts nothing', async () => {
    const { store, provider } = await world();
    const deps = { store, providerFor: () => provider };
    const at = (n: number) => provider.usage.set('*', totalOf(n));
    at(1000); await sampleSourceUsage(deps, NOW - 3 * 3_600_000);
    at(5000); await sampleSourceUsage(deps, NOW - 2 * 3_600_000);
    at(200);  await sampleSourceUsage(deps, NOW - 1 * 3_600_000); // reset
    at(900);  await sampleSourceUsage(deps, NOW);
    const [src] = summarizeSourceUsage(store, OWNER, NOW);
    expect(src!.window5h.tokens).toBe(2 * (4000 + 0 + 700)); // two agents of mine: +4000, the reset counts nothing, +700
    expect(src!.tokensSince).toBe(new Date(NOW - 3 * 3_600_000).toISOString());
  });

  it('counts a day of tokens separately from five hours and a week', async () => {
    const { store, provider } = await world();
    const deps = { store, providerFor: () => provider };
    const at = (n: number) => provider.usage.set('*', totalOf(n));
    at(1000); await sampleSourceUsage(deps, NOW - 40 * 3_600_000); // older than a day
    at(3000); await sampleSourceUsage(deps, NOW - 30 * 3_600_000); // +2000, still older
    at(9000); await sampleSourceUsage(deps, NOW - 10 * 3_600_000); // +6000, inside the day
    at(9500); await sampleSourceUsage(deps, NOW - 4_000_000);      // +500, 66 min ago: inside five hours, outside the hour
    at(9800); await sampleSourceUsage(deps, NOW);                  // +300, inside the hour
    const [src] = summarizeSourceUsage(store, OWNER, NOW);
    expect(src!.window1h.tokens).toBe(2 * 300); // the tokens / hr tile
    expect(src!.window5h.tokens).toBe(2 * (500 + 300));
    expect(src!.window24h.tokens).toBe(2 * (6000 + 500 + 300)); // the day, not the week
    expect(src!.window7d.tokens).toBe(2 * (2000 + 6000 + 500 + 300));
  });
});

describe('GET /v1/ai-profiles/usage', () => {
  it('returns one entry per visible source with the summary shape', async () => {
    const { store, provider } = await world();
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    const res = await f.inject({ method: 'GET', url: '/v1/ai-profiles/usage', headers: { 'x-hatchabot-owner': OWNER } });
    expect(res.statusCode).toBe(200);
    const [src] = res.json().sources;
    expect(src).toMatchObject({ id: 'max', name: 'Claude Max', agents: 2, status: 'idle' });
    expect((await f.inject({ method: 'POST', url: '/v1/ai-profiles/usage/sample', headers: { 'x-hatchabot-owner': 'user-other' } })).statusCode).toBe(403);
  });
});

describe('history follows the source that served it, not the agent', () => {
  const NOW = Date.parse('2026-09-15T18:00:00Z');
  it('a rate-limit hit stays visible after the agent moves to another source', async () => {
    const { store, provider } = await world();
    store.insertAIProfile({ id: 'other', ownerId: OWNER, name: 'Spare', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/other', createdAt: 'now' } as any);
    provider.modelCallLines = [line('2026-09-15T15:00:00.000Z', 200), line('2026-09-15T15:01:00.000Z', 429)].join('\n');
    await sampleSourceUsage({ store, providerFor: () => provider }, NOW);

    const before = summarizeSourceUsage(store, OWNER, NOW).find((s) => s.id === 'max')!;
    expect(before.limitHits7d).toBeGreaterThan(0);
    expect(before.agents).toBe(2);

    // The owner does exactly what the banner suggests: move off the limited source.
    for (const a of store.listAgents(OWNER)) store.setAgentAIProfile(a.id, 'other');

    const after = summarizeSourceUsage(store, OWNER, NOW).find((s) => s.id === 'max')!;
    expect(after.limitHits7d).toBe(before.limitHits7d); // the record survives the move
    expect(after.window7d.requests).toBe(before.window7d.requests);
    expect(after.agents).toBe(0); // …while "agents on it now" correctly drops
  });
});

describe('liveAgents', () => {
  it('leaves archived agents out of the count the rate-limit banner shows', async () => {
    const { store } = await world();
    store.setAgentState('b', 'ARCHIVED');
    const src = summarizeSourceUsage(store, OWNER).find((s) => s.id === 'max')!;
    expect(src.agents).toBe(2); // still attached to the source
    expect(src.liveAgents).toBe(1); // …but only one can answer
  });
});
