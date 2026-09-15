import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { parseModelCalls, sampleSourceUsage, summarizeSourceUsage } from '../src/orchestrator/sourceUsage.js';
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
      { at: '2026-09-10T15:48:58.345Z', provider: 'anthropic', model: 'claude-opus-4-8', status: 429 },
      { at: '2026-09-15T17:54:56.414Z', provider: 'anthropic', model: 'claude-sonnet-5', status: 200 },
    ]);
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
    provider.modelCallLines = [
      line('2026-09-10T12:00:00.000Z', 200),               // 6 days ago: 7-day window only
      line('2026-09-15T14:30:00.000Z', 200),               // inside 5 h
      line('2026-09-15T15:48:58.345Z', 429),               // limited…
      line('2026-09-15T15:49:10.000Z', 429),
    ].join('\n');
    provider.execResponses.set('sessions list', { code: 0, stdout: JSON.stringify({ sessions: [{ totalTokens: 1000, updatedAt: NOW }] }), stderr: '' });
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
    expect(src!.others).toEqual({ agents: 1, requests5h: 3, requests7d: 4 }); // counts only, no names
    // a later success clears it
    provider.modelCallLines += '\n' + line('2026-09-15T18:01:30.000Z', 200); // logged after the last pass, as real lines are
    await sampleSourceUsage(deps, NOW + 120_000);
    [src] = summarizeSourceUsage(store, OWNER, NOW + 120_000);
    expect(src!.status).toBe('ok');
    expect(src!.limitHits7d).toBe(4);
  });

  it('tokens are the sum of counter increases; after a session reset the new total counts', async () => {
    const { store, provider } = await world();
    const deps = { store, providerFor: () => provider };
    const at = (n: number) => provider.execResponses.set('sessions list', { code: 0, stdout: JSON.stringify({ sessions: [{ totalTokens: n, updatedAt: NOW }] }), stderr: '' });
    at(1000); await sampleSourceUsage(deps, NOW - 3 * 3_600_000);
    at(5000); await sampleSourceUsage(deps, NOW - 2 * 3_600_000);
    at(200);  await sampleSourceUsage(deps, NOW - 1 * 3_600_000); // reset
    at(900);  await sampleSourceUsage(deps, NOW);
    const [src] = summarizeSourceUsage(store, OWNER, NOW);
    expect(src!.window5h.tokens).toBe(2 * (4000 + 200 + 700)); // two agents of mine: +4000, reset then 200 used, +700
    expect(src!.tokensSince).toBe(new Date(NOW - 3 * 3_600_000).toISOString());
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
