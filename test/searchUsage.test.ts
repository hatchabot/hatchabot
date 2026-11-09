/**
 * Brave search usage (HB-0532): the reader counts each agent's web searches
 * from its transcripts, the store keeps them per hour, Hatchabot counts its
 * own, and the report says what is left, per day, per agent and the cost.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { registerRoutes } from '../src/api/routes.js';
import { makeOpsWeb } from '../src/ops/opsWeb.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { USAGE_READER_SCRIPT } from '../src/orchestrator/usage.js';
import { createSearchWatch, type WebSearchState } from '../src/orchestrator/webSearch.js';
import {
  DEFAULT_SEARCH_PRICE, monthBefore, OPS_AGENT_SEARCHES, OWN_BRAVE, readSearchPrice, saveSearchPrice, SEARCH_CHECKS, searchPeriod, searchUsageReport,
} from '../src/orchestrator/searchUsage.js';
import { attributeBrave, ownSearchKey, storeSearchHours } from '../src/orchestrator/sourceUsage.js';
import { urlHost } from './helpers/urlHost.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function runReader(build: (root: string) => void): any {
  const base = mkdtempSync(join(tmpdir(), 'hb-search-'));
  const root = join(base, 'agents');
  mkdirSync(root, { recursive: true });
  build(root);
  const script = USAGE_READER_SCRIPT.replace('"/home/node/.openclaw/agents"', JSON.stringify(root));
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', script], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout);
}
/** A web_search tool result as OpenClaw 2026.9.8 records it: the payload in `details`, pretty JSON in the text. */
const searchResult = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  role: 'toolResult', toolCallId: 'c1', toolName: 'web_search', isError: false,
  content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload, ...extra,
});

describe('the usage reader counts web searches', () => {
  it('per hour, by the provider that answered; cached answers apart; failures and other tools not at all', () => {
    const now = Date.now();
    const t = now - 3 * HOUR;
    const hourOf = (x: number) => new Date(x).toISOString().slice(0, 13);
    const out = runReader((root) => {
      mkdirSync(join(root, 'kitchen', 'agent'), { recursive: true });
      const db = new Database(join(root, 'kitchen', 'agent', 'openclaw-agent.sqlite'));
      db.exec('CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, created_at INTEGER, event_json TEXT, event_zstd BLOB)');
      const ins = db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, NULL)');
      let seq = 0;
      const put = (at: number, message: object) => ins.run('s1', seq++, at, JSON.stringify({ type: 'message', id: `e${seq}`, message }));
      put(t, searchResult({ query: 'q', provider: 'brave', count: 5 }));
      put(t + 1, searchResult({ query: 'q', provider: 'brave', count: 5 }));
      put(t + 2, searchResult({ query: 'q', provider: 'brave', count: 5, cached: true }));
      put(t + 3, searchResult({ query: 'q', provider: 'duckduckgo', count: 5 }));
      put(t + HOUR, searchResult({ query: 'q', provider: 'brave', count: 5 }));
      // A refused search spends nothing: neither an error result nor an error payload counts.
      put(t + 4, searchResult({ query: 'q', provider: 'brave' }, { isError: true }));
      put(t + 5, searchResult({ error: 'missing_brave_api_key', message: 'no key' }));
      put(t + 6, { role: 'toolResult', toolCallId: 'c2', toolName: 'read', isError: false, content: [{ type: 'text', text: '"provider": "brave"' }] });
      // Older than the 32 days: not read.
      put(now - 33 * DAY, searchResult({ query: 'q', provider: 'brave' }));
      db.close();
      // A session file with no details kept: the provider is read from the text.
      mkdirSync(join(root, 'kitchen', 'sessions'), { recursive: true });
      const line = (id: string, message: object) => JSON.stringify({ type: 'message', id, timestamp: new Date(t).toISOString(), message });
      writeFileSync(join(root, 'kitchen', 'sessions', 's2.jsonl.reset.2026-11-01'), [
        line('f1', { role: 'toolResult', toolCallId: 'c3', toolName: 'web_search', isError: false, content: [{ type: 'text', text: JSON.stringify({ query: 'q', provider: 'brave', count: 3 }, null, 2) }] }),
      ].join('\n'));
    });
    expect(out.searches.v).toBe(1);
    expect(out.searches.hours[hourOf(t)]).toEqual({ brave: 3, cached: 1, duckduckgo: 1 });
    expect(out.searches.hours[hourOf(t + HOUR)]).toEqual({ brave: 1 });
    expect(Object.keys(out.searches.hours)).toHaveLength(2);
  });
});

describe('a first reading covers the whole month (HB-0580)', () => {
  it('late on the 31st, the searches of the 1st are read', () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    const base = mkdtempSync(join(tmpdir(), 'hb-search-'));
    const root = join(base, 'agents');
    mkdirSync(join(root, 'kitchen', 'sessions'), { recursive: true });
    const line = (id: string, at: string) => JSON.stringify({ type: 'message', id, timestamp: at, message: searchResult({ query: 'q', provider: 'brave', count: 5 }) });
    writeFileSync(join(root, 'kitchen', 'sessions', 's1.jsonl'), [line('e1', '2026-10-01T08:00:00Z'), line('e2', '2026-09-28T08:00:00Z')].join('\n'));
    const script = `Date.now = () => ${now};\n` + USAGE_READER_SCRIPT.replace('"/home/node/.openclaw/agents"', JSON.stringify(root));
    const r = spawnSync(process.execPath, ['--no-warnings', '-e', script], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.searches.hours).toEqual({ '2026-10-01T08': { brave: 1 } });
    // The window starts before the month does: the sampler stores from the next whole hour.
    expect(out.searches.since).toBeLessThanOrEqual(Date.parse('2026-10-01T00:00:00Z') - 3_600_000);
    // And the reading says where its transcripts begin: its earliest event, older searches or not.
    expect(out.searches.from).toBe(Date.parse('2026-09-28T08:00:00Z'));
  });
});

describe('a reading replaces only the hours it still has transcripts for (HB-0580 review)', () => {
  it("counts stored for day 31 survive a reading whose transcripts start at day 29", () => {
    const store = new Store(new Database(':memory:'));
    const now = Date.parse('2026-11-30T12:00:00Z');
    const hourAgo = (days: number) => new Date(now - days * DAY).toISOString().slice(0, 13);
    store.setSearchHours('a1', '2026-01-01T00', {
      [hourAgo(31)]: { duckduckgo: 4 }, [hourAgo(30)]: { duckduckgo: 2 }, [hourAgo(10)]: { duckduckgo: 1 },
    });
    const stored = () => Object.fromEntries(store.searchHours('2026-01-01T00', '2027-01-01T00', 'a1').map((r) => [r.hour, r.n]));
    // The window is 32 days, but the agent's transcripts now begin 29 days back (older sessions reset).
    storeSearchHours(store, 'a1', { since: now - 32 * DAY, from: now - 29 * DAY, hours: { [hourAgo(20)]: { duckduckgo: 3 } } });
    // The hour 10 days back, gone from the transcripts since, stays too (eighth review).
    expect(stored()).toEqual({ [hourAgo(31)]: 4, [hourAgo(30)]: 2, [hourAgo(20)]: 3, [hourAgo(10)]: 1 });
    // Transcripts older than the window: each hour the larger of the two; none is lowered (eighth review).
    storeSearchHours(store, 'a1', { since: now - 32 * DAY, from: now - 40 * DAY, hours: { [hourAgo(31)]: { duckduckgo: 5 } } });
    expect(stored()).toEqual({ [hourAgo(31)]: 5, [hourAgo(30)]: 2, [hourAgo(20)]: 3, [hourAgo(10)]: 1 });
    // A reading that found nothing at all changes nothing.
    storeSearchHours(store, 'a1', { since: now - 32 * DAY, from: 0, hours: {} });
    expect(stored()).toEqual({ [hourAgo(31)]: 5, [hourAgo(30)]: 2, [hourAgo(20)]: 3, [hourAgo(10)]: 1 });
  });

  it('the hour the earliest transcript starts in keeps the larger count: searches at 10:05, 10:15 and 10:40, the first two\'s session gone (fifth review)', () => {
    const store = new Store(new Database(':memory:'));
    const now = Date.parse('2026-11-30T12:00:00Z');
    // Read before: all three in the 10 o'clock hour, one at 11.
    store.setSearchHours('a1', '2026-11-01T00', { '2026-11-29T10': { duckduckgo: 3 }, '2026-11-29T11': { duckduckgo: 1 } });
    const stored = () => Object.fromEntries(store.searchHours('2026-01-01T00', '2027-01-01T00', 'a1').map((r) => [r.hour, r.n]));
    // Now the transcripts start at 10:40: the 10 o'clock hour holds one of them, 11 o'clock two.
    storeSearchHours(store, 'a1', { since: now - 32 * DAY, from: Date.parse('2026-11-29T10:40:00Z'), hours: { '2026-11-29T10': { duckduckgo: 1 }, '2026-11-29T11': { duckduckgo: 2 } } });
    expect(stored()).toEqual({ '2026-11-29T10': 3, '2026-11-29T11': 2 });
    // A new search in the hour read in part counts when the reading has more.
    storeSearchHours(store, 'a1', { since: now - 32 * DAY, from: Date.parse('2026-11-29T10:40:00Z'), hours: { '2026-11-29T10': { duckduckgo: 4 }, '2026-11-29T11': { duckduckgo: 2 } } });
    expect(stored()).toEqual({ '2026-11-29T10': 4, '2026-11-29T11': 2 });
    // From the top of an hour, that hour is read whole: still never lowered (eighth review).
    storeSearchHours(store, 'a1', { since: now - 32 * DAY, from: Date.parse('2026-11-29T10:00:00Z'), hours: { '2026-11-29T10': { duckduckgo: 1 } } });
    expect(stored()).toEqual({ '2026-11-29T10': 4, '2026-11-29T11': 2 });
  });

  it('200 searches in an hour whose session was pruned since stay counted, and a later reading adds only what is new (eighth review)', () => {
    const store = new Store(new Database(':memory:'));
    const month = Date.parse('2026-11-01T00:00:00Z');
    const stored = () => Object.fromEntries(store.searchHours('2026-11-01T00', '2026-12-01T00', 'a1').map((r) => [`${r.hour} ${r.provider}`, r.n]));
    // 200 searches at 09:00 on the 1st, and 2 the next day.
    storeSearchHours(store, 'a1', { since: month, from: month, hours: { '2026-11-01T09': { brave: 200 }, '2026-11-02T10': { brave: 2 } } });
    expect(stored()).toEqual({ '2026-11-01T09 brave': 200, '2026-11-02T10 brave': 2 });
    // The session that made the 200 is pruned: the next reading still starts at the month's start, but finds only the later ones.
    storeSearchHours(store, 'a1', { since: month, from: month, hours: { '2026-11-02T10': { brave: 3 } } });
    expect(stored()).toEqual({ '2026-11-01T09 brave': 200, '2026-11-02T10 brave': 3 });
    // Fewer read for an hour than stored (part of its session gone): the stored count stays.
    storeSearchHours(store, 'a1', { since: month, from: month, hours: { '2026-11-02T10': { brave: 1 } } });
    expect(stored()).toEqual({ '2026-11-01T09 brave': 200, '2026-11-02T10 brave': 3 });
  });
});

describe('the store keeps searches per agent and hour', () => {
  it('replaces the hours a read covers, keeps the ones before it, and adds Hatchabot\'s own', () => {
    const store = new Store(new Database(':memory:'));
    store.setSearchHours('a1', '2026-11-01T00', { '2026-11-01T05': { brave: 4 }, '2026-11-02T01': { brave: 2, duckduckgo: 1 } });
    // A later read starting at the 2nd: the 1st stays, the 2nd is what this read says.
    store.setSearchHours('a1', '2026-11-02T00', { '2026-11-02T01': { brave: 3 }, '2026-10-31T00': { brave: 9 } });
    store.addSearch(SEARCH_CHECKS, 'brave', '2026-11-02T01:30:00Z');
    store.addSearch(SEARCH_CHECKS, 'brave', '2026-11-02T01:50:00Z');
    const rows = store.searchHours('2026-11-01T00', '2026-12-01T00').sort((x, y) => `${x.agentId}${x.hour}${x.provider}`.localeCompare(`${y.agentId}${y.hour}${y.provider}`));
    expect(rows).toEqual([
      { agentId: SEARCH_CHECKS, hour: '2026-11-02T01', provider: 'brave', n: 2 },
      { agentId: 'a1', hour: '2026-11-01T05', provider: 'brave', n: 4 },
      { agentId: 'a1', hour: '2026-11-02T01', provider: 'brave', n: 3 },
    ]);
    store.pruneSearchHours('2026-11-02T00:00:00Z');
    expect(store.searchHours('2026-01-01T00', '2027-01-01T00').map((r) => r.hour)).not.toContain('2026-11-01T05');
  });
});

const state = (over: Partial<WebSearchState> = {}): WebSearchState => ({ mode: 'auto', active: 'brave', ...over });
const NOW = Date.parse('2026-11-11T12:00:00Z');

describe('the report', () => {
  const rows = [
    { agentId: 'a1', hour: '2026-11-01T09', provider: 'brave', n: 200 },
    { agentId: 'a1', hour: '2026-11-10T09', provider: 'brave', n: 100 },
    { agentId: 'a2', hour: '2026-11-03T09', provider: 'brave', n: 50 },
    { agentId: 'a2', hour: '2026-11-03T10', provider: 'duckduckgo', n: 7 },
    { agentId: 'a2', hour: '2026-11-03T11', provider: 'cached', n: 4 },
    { agentId: 'gone', hour: '2026-11-05T00', provider: 'brave', n: 10 },
    { agentId: OPS_AGENT_SEARCHES, hour: '2026-11-05T00', provider: 'brave', n: 5 },
    { agentId: SEARCH_CHECKS, hour: '2026-11-06T00', provider: 'brave', n: 35 },
  ];
  const names: Record<string, string> = { a1: 'Market Watch', a2: 'Trip Planner' };
  const report = (over: Partial<Parameters<typeof searchUsageReport>[0]> = {}) => searchUsageReport({
    hours: (from, to) => rows.filter((r) => r.hour >= from && r.hour < to), state: state(), keySet: true,
    price: DEFAULT_SEARCH_PRICE, nameOf: (id) => names[id], now: NOW, ...over,
  });

  it('on a metered plan: the month\'s free credit, the agents ranked, the cost and the pace', () => {
    const r = report();
    expect(r.period).toMatchObject({ start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', basis: 'calendar', days: 30 });
    expect(r.brave).toBe(400);
    expect(r.other).toBe(7);
    expect(r.cached).toBe(4);
    expect(r.allowance).toEqual({ kind: 'credit', free: 1000, used: 400, left: 600 });
    expect(r.byAgent.map((w) => [w.name, w.kind, w.brave, w.cost])).toEqual([
      ['Market Watch', 'agent', 300, 1.5],
      ['Trip Planner', 'agent', 50, 0.25],
      ["Hatchabot's checks", 'checks', 35, 0.18],
      ['A removed agent', 'removed', 10, 0.05],
      ['Hatchabot agent', 'hatchabot-agent', 5, 0.03],
    ]);
    expect(r.byAgent.find((w) => w.id === 'a2')).toMatchObject({ other: 7, cached: 4 });
    // $2.00 of searches, under the $5 credit.
    expect(r.cost).toMatchObject({ gross: 2, net: 0 });
    // 400 in 10.5 days → about 1,143 by the 30th: over the free 1,000, about $0.71 billed.
    expect(r.projected).toBe(1143);
    expect(r.cost.projectedNet).toBeCloseTo(0.71, 2);
    expect(r.runsOut).toBe('2026-11-27');
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay[0]).toEqual({ day: '2026-11-01', brave: 200, other: 0 });
    expect(r.byDay[2]).toEqual({ day: '2026-11-03', brave: 50, other: 7 });
  });

  it('on a capped plan: Brave\'s own numbers, over the month that ends at its reset', () => {
    const resetsAt = '2026-11-20T00:00:00.000Z';
    const r = report({ state: state({ checkedAt: '2026-11-11T06:00:00.000Z', brave: { status: 'ok', detail: '', remaining: 150, limit: 2000, resetsAt } }) });
    expect(r.period).toMatchObject({ start: '2026-10-20T00:00:00.000Z', end: resetsAt, basis: 'quota' });
    expect(r.allowance).toEqual({ kind: 'quota', limit: 2000, remaining: 150, used: 1850, checkedAt: '2026-11-11T06:00:00.000Z', resetsAt });
    // 400 counted in 22.5 days: 150 more last about 8 days, so it runs out before the 20th.
    expect(r.runsOut).toBe('2026-11-19');
  });

  it('with no key and a price of nothing: no allowance, no cost', () => {
    const r = report({ keySet: false, price: { per1000: 0, monthlyCredit: 0 } });
    expect(r.allowance).toBeUndefined();
    expect(r.cost).toEqual({ gross: 0, net: 0, projectedNet: 0 });
  });

  it('a morning\'s searches are not a month\'s pace', () => {
    const r = searchUsageReport({ hours: () => [{ agentId: 'a1', hour: '2026-11-01T02', provider: 'brave', n: 6 }], state: state(), keySet: true, price: DEFAULT_SEARCH_PRICE, nameOf: () => 'A', now: Date.parse('2026-11-01T03:00:00Z') });
    expect(r.projected).toBe(180);
  });

  it('a reset on the 29th to the 31st counts from the same day of the month before, or its last day (HB-0579)', () => {
    const iso = (t: number) => new Date(t).toISOString();
    expect(iso(monthBefore(Date.parse('2027-03-31T00:00:00Z')))).toBe('2027-02-28T00:00:00.000Z');
    expect(iso(monthBefore(Date.parse('2028-03-30T06:15:00Z')))).toBe('2028-02-29T06:15:00.000Z');
    expect(iso(monthBefore(Date.parse('2027-01-31T12:00:00Z')))).toBe('2026-12-31T12:00:00.000Z');
    expect(iso(monthBefore(Date.parse('2027-05-31T00:00:00Z')))).toBe('2027-04-30T00:00:00.000Z');
    expect(iso(monthBefore(Date.parse('2027-04-15T00:00:00Z')))).toBe('2027-03-15T00:00:00.000Z');
    const p = searchPeriod(state({ brave: { status: 'ok', detail: '', limit: 1000, resetsAt: '2027-03-31T00:00:00Z' } }), Date.parse('2027-03-05T00:00:00Z'));
    expect(iso(p.start)).toBe('2027-02-28T00:00:00.000Z');
    expect(p.basis).toBe('quota');
  });

  it('a stale reset is not trusted for the month', () => {
    expect(searchPeriod(state({ brave: { status: 'ok', detail: '', remaining: 1, limit: 10, resetsAt: '2026-11-01T00:00:00Z' } }), NOW).basis).toBe('calendar');
    expect(searchPeriod(state({ brave: { status: 'ok', detail: '', limit: 0, resetsAt: '2026-11-20T00:00:00Z' } }), NOW).basis).toBe('calendar');
  });

  it('the price is the owner\'s, with Brave\'s as the default', () => {
    const prefs = new Map<string, string>();
    const store = { getOwnerPref: (_o: string, k: string) => prefs.get(k), setOwnerPref: (_o: string, k: string, v: string) => { prefs.set(k, v); } };
    expect(readSearchPrice(store)).toEqual({ per1000: 5, monthlyCredit: 5 });
    saveSearchPrice(store, { per1000: 9, monthlyCredit: 0 });
    expect(readSearchPrice(store)).toEqual({ per1000: 9, monthlyCredit: 0 });
    prefs.set('webSearchPrice', '{"per1000":-1}');
    expect(readSearchPrice(store)).toEqual(DEFAULT_SEARCH_PRICE);
  });
});

describe("an agent's own Brave key is its own bill (HB-0578)", () => {
  const brave = (hours: Record<string, number>) => Object.fromEntries(Object.entries(hours).map(([h, n]) => [h, { brave: n }]));

  it("a saved key equal to the fleet's counts as the fleet's before any build has said, as the build itself does (HB-0578, fifth review)", async () => {
    const store = new Store(new Database(':memory:'));
    const values: Record<string, string> = { 'media/brave-api-key': 'fleet-search-key-example', 'env/same/brave': 'fleet-search-key-example', 'env/mine/brave': 'own-search-key-example' };
    const secrets = { get: async (ref: string) => { if (!(ref in values)) throw new Error(`no secret ${ref}`); return values[ref]!; } };
    store.insertAgentEnv({ id: 'env-1', agentId: 'same', name: 'BRAVE_API_KEY', secretRef: 'env/same/brave', createdAt: 'now' });
    store.insertAgentEnv({ id: 'env-2', agentId: 'mine', name: 'BRAVE_API_KEY', secretRef: 'env/mine/brave', createdAt: 'now' });
    expect(await ownSearchKey(store, secrets, 'same')).toBe(false);
    expect(await ownSearchKey(store, secrets, 'mine')).toBe(true);
    expect(await ownSearchKey(store, secrets, 'none')).toBe(false);
    // Unreadable: the saved key counts as its own, as before.
    expect(await ownSearchKey(store, undefined, 'same')).toBeUndefined();
    const read = { since: Date.parse('2026-10-30T00:00:00Z'), from: Date.parse('2026-10-29T00:00:00Z'), hours: { '2026-11-02T10': { brave: 5 } } };
    for (const id of ['same', 'mine']) storeSearchHours(store, id, read, await ownSearchKey(store, secrets, id));
    const by = (id: string) => store.searchHours('2026-11-01T00', '2026-12-01T00', id).map((r) => [r.provider, r.n]);
    expect(by('same')).toEqual([['brave', 5]]);
    expect(by('mine')).toEqual([[OWN_BRAVE, 5]]);
  });

  it('its searches are stored apart, use none of the fleet credit, and still rank it', () => {
    const store = new Store(new Database(':memory:'));
    store.insertAgentEnv({ id: 'env-1', agentId: 'own', name: 'BRAVE_API_KEY', secretRef: 'env/own/brave', createdAt: 'now' });
    store.setSearchHours('own', '2026-11-01T00', attributeBrave(store, 'own', '2026-11-01T00', { '2026-11-02T10': { brave: 2000, duckduckgo: 3 } }));
    store.setSearchHours('fleet', '2026-11-01T00', attributeBrave(store, 'fleet', '2026-11-01T00', brave({ '2026-11-02T10': 40 })));
    const rows = store.searchHours('2026-11-01T00', '2026-12-01T00');
    expect(rows.filter((r) => r.agentId === 'own').map((r) => [r.provider, r.n]).sort()).toEqual([['brave-own', 2000], ['duckduckgo', 3]]);
    expect(OWN_BRAVE).toBe('brave-own');
    const r = searchUsageReport({ hours: (a, b) => store.searchHours(a, b), state: state(), keySet: true, price: DEFAULT_SEARCH_PRICE, nameOf: (id) => id, now: NOW });
    expect(r.brave).toBe(40);
    expect(r.allowance).toEqual({ kind: 'credit', free: 1000, used: 40, left: 960 });
    expect(r.cost.net).toBe(0);
    expect(r.byAgent.map((w) => w.id)).toEqual(['fleet', 'own']);
    expect(r.byAgent.find((w) => w.id === 'own')).toMatchObject({ brave: 0, other: 2003, cost: 0 });
  });

  it('counts already stored keep the key they were counted under; what a reading adds takes the key as it is now', () => {
    const store = new Store(new Database(':memory:'));
    store.setSearchHours('a1', '2026-11-01T00', attributeBrave(store, 'a1', '2026-11-01T00', brave({ '2026-11-02T10': 5 })));
    // Its own key is set: the next read's earlier searches stay the fleet's, the one added is its own, and so is the new hour.
    store.insertAgentEnv({ id: 'env-2', agentId: 'a1', name: 'BRAVE_API_KEY', secretRef: 'env/a1/brave', createdAt: 'now' });
    store.setSearchHours('a1', '2026-11-01T00', attributeBrave(store, 'a1', '2026-11-01T00', brave({ '2026-11-02T10': 6, '2026-11-03T10': 7 })));
    const by = (h: string) => store.searchHours('2026-11-01T00', '2026-12-01T00').filter((r) => r.hour === h).map((r) => [r.provider, r.n]).sort();
    expect(by('2026-11-02T10')).toEqual([['brave', 5], ['brave-own', 1]]);
    expect(by('2026-11-03T10')).toEqual([['brave-own', 7]]);
    // And read again after the key is taken off: what was its own stays its own.
    store.deleteAgentEnv('a1', 'env-2');
    const again = attributeBrave(store, 'a1', '2026-11-01T00', brave({ '2026-11-02T10': 6, '2026-11-03T10': 7, '2026-11-04T10': 1 }));
    expect(again).toEqual({ '2026-11-02T10': { brave: 5, 'brave-own': 1 }, '2026-11-03T10': { 'brave-own': 7 }, '2026-11-04T10': { brave: 1 } });
    // Fewer read than stored (a session gone): the stored counts as they are, never lowered (ninth review).
    expect(attributeBrave(store, 'a1', '2026-11-01T00', brave({ '2026-11-02T10': 2 }))).toEqual({ '2026-11-02T10': { brave: 5, 'brave-own': 1 } });
  });

  it("an hour a rebuild put its own key in the middle of: the fleet's searches before it stay the fleet's at every later reading (sixth review)", () => {
    const store = new Store(new Database(':memory:'));
    store.insertAgent({ id: 'a1', ownerId: 'u1', name: 'Kitchen Helper', slug: 'kitchen-helper', state: 'RUNNING', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    store.recordAppliedSearchKey('a1', 'fleet');
    const month = Date.parse('2026-11-01T00:00:00Z');
    const reading = (n: number) => storeSearchHours(store, 'a1', { since: month, from: month, hours: { '2026-11-02T14': { brave: n } } });
    const hour = () => Object.fromEntries(store.searchHours('2026-11-02T14', '2026-11-02T15', 'a1').map((r) => [r.provider, r.n]));
    // Three searches by 14:20, on the fleet's key.
    reading(3);
    expect(hour()).toEqual({ brave: 3 });
    // Rebuilt at 14:20 with its own key: two more, then one.
    store.recordAppliedSearchKey('a1', 'own');
    reading(5);
    expect(hour()).toEqual({ brave: 3, [OWN_BRAVE]: 2 });
    reading(6);
    expect(hour()).toEqual({ brave: 3, [OWN_BRAVE]: 3 });
    // Read again with nothing new: nothing moves.
    reading(6);
    expect(hour()).toEqual({ brave: 3, [OWN_BRAVE]: 3 });
    // A session gone lowers nothing: its searches stay counted where they were (eighth review).
    reading(4);
    expect(hour()).toEqual({ brave: 3, [OWN_BRAVE]: 3 });
    // And a new one after it counts once the reading passes the stored total.
    reading(7);
    expect(hour()).toEqual({ brave: 3, [OWN_BRAVE]: 4 });
  });

  it("reads only that agent's hours, not every agent's (HB-0578 review)", () => {
    const store = new Store(new Database(':memory:'));
    for (let i = 0; i < 50; i++) store.setSearchHours(`other-${i}`, '2026-11-01T00', { '2026-11-02T10': { [OWN_BRAVE]: 9 } });
    store.setSearchHours('a1', '2026-11-01T00', { '2026-11-02T10': { brave: 2 } });
    const read = vi.spyOn(store, 'searchHours');
    expect(attributeBrave(store, 'a1', '2026-11-01T00', brave({ '2026-11-02T10': 3, '2026-11-03T10': 1 }))).toEqual({ '2026-11-02T10': { brave: 3 }, '2026-11-03T10': { brave: 1 } });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.results[0]!.value).toEqual([{ agentId: 'a1', hour: '2026-11-02T10', provider: 'brave', n: 2 }]);
  });
});

describe('Hatchabot counts its own searches', () => {
  it('a check that Brave answered is one query; a refused one is none', async () => {
    let spent = 0;
    const prefs = new Map<string, string>();
    const answers = [200, 429];
    const fetchImpl = (async (url: string) => (urlHost(url) === 'api.search.brave.com'
      ? new Response('{}', { status: answers.shift() ?? 429 })
      : new Response('<a class="result__a" href="https://x.example">x</a>', { status: 200 }))) as unknown as typeof fetch;
    const w = createSearchWatch({
      store: { getOwnerPref: (_o: string, k: string) => prefs.get(k), setOwnerPref: (_o: string, k: string, v: string) => { prefs.set(k, v); }, listAllActiveAgents: () => [], listAgentEnv: () => [] } as never,
      braveKey: async () => 'made-up', providerFor: () => ({}) as never, fetchImpl, sleep: async () => {}, spentQuery: () => { spent++; },
    });
    await w.check();
    expect(spent).toBe(1);
    await w.check();
    expect(spent).toBe(1);
  });

  it("the Hatchabot agent's searches, by the provider that answered", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => (urlHost(url) === 'api.search.brave.com'
      ? new Response(JSON.stringify({ web: { results: [{ title: 'T', url: 'https://docs.example.com/a', description: 'd' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('<a class="result__a" href="https://docs.example.com/d">D</a>', { status: 200 }))) as unknown as typeof fetch;
    await makeOpsWeb({ braveKey: async () => 'made-up', onSearched: (p) => seen.push(p), fetchImpl, lookup: async () => ['93.184.216.34'] })('o', 'web_search', { query: 'release notes' });
    await makeOpsWeb({ braveKey: async () => undefined, onSearched: (p) => seen.push(p), fetchImpl, lookup: async () => ['93.184.216.34'] })('o', 'web_search', { query: 'release notes' });
    expect(seen).toEqual(['brave', 'duckduckgo']);
  });
});

describe('the routes', () => {
  async function app() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const map = new Map<string, string>([['media/brave-api-key', 'made-up']]);
    const secrets = { async put(r: string, v: string) { map.set(r, v); }, async get(r: string) { const v = map.get(r); if (v === undefined) throw new Error('none'); return v; }, async delete(r: string) { map.delete(r); } };
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 } }, searchFetch: fetchImpl } as never);
    return { f, store };
  }
  const as = (who: string) => ({ 'x-hatchabot-owner': who });

  it('the month\'s usage is the machine owner\'s, and so is the price', async () => {
    const { f, store } = await app();
    store.addSearch(OPS_AGENT_SEARCHES, 'brave', new Date().toISOString(), 3);
    expect((await f.inject({ method: 'GET', url: '/v1/web-search/usage', headers: as('member') })).statusCode).toBe(403);
    const u = (await f.inject({ method: 'GET', url: '/v1/web-search/usage', headers: as('owner') })).json();
    expect(u).toMatchObject({ brave: 3, keySet: true, price: { per1000: 5, monthlyCredit: 5 }, allowance: { kind: 'credit', free: 1000, used: 3 } });
    expect(JSON.stringify(u)).not.toContain('made-up');
    expect((await f.inject({ method: 'PUT', url: '/v1/web-search', headers: as('member'), payload: { price: { per1000: 4, monthlyCredit: 0 } } })).statusCode).toBe(403);
    for (const bad of [{ price: { per1000: -1, monthlyCredit: 5 } }, { price: { per1000: 5 } }, {}, { price: { per1000: 5, monthlyCredit: 5, extra: 1 } }]) {
      expect((await f.inject({ method: 'PUT', url: '/v1/web-search', headers: as('owner'), payload: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    const saved = (await f.inject({ method: 'PUT', url: '/v1/web-search', headers: as('owner'), payload: { price: { per1000: 4, monthlyCredit: 0 } } })).json();
    expect(saved).toMatchObject({ price: { per1000: 4, monthlyCredit: 0 }, cost: { gross: 0.01, net: 0.01 } });
    // The mode still works on its own, and answers with the search state.
    expect((await f.inject({ method: 'PUT', url: '/v1/web-search', headers: as('owner'), payload: { mode: 'duckduckgo' } })).json()).toMatchObject({ mode: 'duckduckgo' });
  });

  it('a check that spent a query is counted', async () => {
    const { f, store } = await app();
    await f.inject({ method: 'POST', url: '/v1/web-search/check', headers: as('owner') });
    expect(store.searchHours('2000-01-01T00', '2100-01-01T00')).toEqual([expect.objectContaining({ agentId: SEARCH_CHECKS, provider: 'brave', n: 1 })]);
  });
});
