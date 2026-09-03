import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { pickMgmtProfile } from '../src/api/mgmtLlm.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { AIProfile } from '../src/domain/types.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const H = { 'x-agentclaw-owner': OWNER };

function profile(p: Partial<AIProfile> & { id: string }): AIProfile {
  return {
    ownerId: OWNER, name: p.id, vendor: 'anthropic', kind: 'api_key',
    model: 'claude-sonnet-5', secretRef: `ai/${p.id}`, createdAt: 'now',
    ...p,
  } as AIProfile;
}

async function world(completions: Array<Record<string, unknown>> = []) {
  const store = new Store(new Database(':memory:'));
  const f = Fastify();
  const calls: Array<{ profileId: string; maxTokens: number }> = [];
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    mgmtLlmComplete: async (_s, p, req) => {
      calls.push({ profileId: p.id, maxTokens: req.maxTokens });
      return (completions.shift() as any) ?? { stopReason: 'end_turn', content: [{ type: 'text', text: 'hi' }] };
    },
  });
  return { store, f, calls };
}

describe('picking the management LLM source', () => {
  it('excludes machine-login and local sources; prefers api-key over setup-token', () => {
    const store = new Store(new Database(':memory:'));
    store.insertAIProfile(profile({ id: 'ml', kind: 'subscription', secretRef: undefined })); // machine login
    store.insertAIProfile(profile({ id: 'lq', vendor: 'local', kind: 'api_key', secretRef: undefined }));
    expect(pickMgmtProfile(store, OWNER)).toBeUndefined();
    store.insertAIProfile(profile({ id: 'st', kind: 'subscription' })); // setup-token
    expect(pickMgmtProfile(store, OWNER)?.id).toBe('st');
    store.insertAIProfile(profile({ id: 'ak' })); // api key
    expect(pickMgmtProfile(store, OWNER)?.id).toBe('ak');
  });

  it('an explicit flag beats the automatic pick, and is single-select', () => {
    const store = new Store(new Database(':memory:'));
    store.insertAIProfile(profile({ id: 'ak1' }));
    store.insertAIProfile(profile({ id: 'ak2' }));
    store.setAIProfileMgmtLlm(OWNER, 'ak2');
    expect(pickMgmtProfile(store, OWNER)?.id).toBe('ak2');
    store.setAIProfileMgmtLlm(OWNER, 'ak1');
    expect(store.getAIProfile('ak2')!.mgmtLlm).toBe(false); // moved, not duplicated
    expect(pickMgmtProfile(store, OWNER)?.id).toBe('ak1');
  });

  it('a stale or foreign id rolls back instead of silently clearing the pick', () => {
    const store = new Store(new Database(':memory:'));
    store.insertAIProfile(profile({ id: 'ak1' }));
    store.setAIProfileMgmtLlm(OWNER, 'ak1');
    expect(() => store.setAIProfileMgmtLlm(OWNER, 'ghost')).toThrow(/ghost/);
    expect(store.getAIProfile('ak1')!.mgmtLlm).toBe(true); // pick survived
  });

  it("another owner's flagged profile never backs my bot", () => {
    const store = new Store(new Database(':memory:'));
    store.insertAIProfile(profile({ id: 'theirs', ownerId: 'other', shared: true }));
    store.setAIProfileMgmtLlm('other', 'theirs');
    expect(pickMgmtProfile(store, OWNER)).toBeUndefined();
  });
});

describe('PATCH mgmtLlm + GET /v1/mgmt/llm', () => {
  it('flags a usable source and reports it; refuses machine-login with a pointer', async () => {
    const { store, f } = await world();
    store.insertAIProfile(profile({ id: 'ml', kind: 'subscription', secretRef: undefined }));
    store.insertAIProfile(profile({ id: 'ak', name: 'Spare Key' }));

    const bad = await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/ml', headers: H, payload: { mgmtLlm: true } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/setup-token/);

    const ok = await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/ak', headers: H, payload: { mgmtLlm: true } });
    expect(ok.statusCode).toBe(200);
    const s = (await f.inject({ method: 'GET', url: '/v1/mgmt/llm', headers: H })).json();
    expect(s).toMatchObject({ available: true, profileName: 'Spare Key', model: 'claude-sonnet-5', credential: 'api-key', flagged: true });
  });
});

describe('POST /v1/mgmt/llm/complete (server-side proxy)', () => {
  const BODY = { system: 'sys', tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 };

  it('completes with the picked source; the bot never sees a credential', async () => {
    const { store, f, calls } = await world();
    store.insertAIProfile(profile({ id: 'ak' }));
    const res = await f.inject({ method: 'POST', url: '/v1/mgmt/llm/complete', headers: H, payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json().content[0].text).toBe('hi');
    expect(calls).toEqual([{ profileId: 'ak', maxTokens: 100 }]);
  });

  it('409s with guidance when nothing can back it, and 400s malformed bodies', async () => {
    const { f } = await world();
    const none = await f.inject({ method: 'POST', url: '/v1/mgmt/llm/complete', headers: H, payload: BODY });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toMatch(/AI sources/);
    const bad = await f.inject({ method: 'POST', url: '/v1/mgmt/llm/complete', headers: H, payload: { ...BODY, maxTokens: 1e9 } });
    expect(bad.statusCode).toBe(400);
  });
});
