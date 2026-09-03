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
  it('any anthropic source works (no extra credential needed); local excluded; api-key > setup-token > machine-login', () => {
    const store = new Store(new Database(':memory:'));
    store.insertAIProfile(profile({ id: 'lq', vendor: 'local', kind: 'api_key', secretRef: undefined }));
    expect(pickMgmtProfile(store, OWNER)).toBeUndefined(); // local can't
    store.insertAIProfile(profile({ id: 'ml', kind: 'subscription', secretRef: undefined })); // machine login
    expect(pickMgmtProfile(store, OWNER)?.id).toBe('ml'); // zero-credential CLI path
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

describe('CLI tool-emission protocol', () => {
  it('parses a bare or fenced JSON tool call; leaves prose alone', async () => {
    const { parseToolEmission } = await import('../src/api/cliChatModel.js');
    expect(parseToolEmission('{"tool":"list_agents","input":{}}')).toEqual({ tool: 'list_agents', input: {} });
    expect(parseToolEmission('```json\n{"tool":"get_agent","input":{"agent":"a1"}}\n```'))
      .toEqual({ tool: 'get_agent', input: { agent: 'a1' } });
    expect(parseToolEmission('Your fleet looks healthy.')).toBeUndefined();
    expect(parseToolEmission('{not json at all')).toBeUndefined();
    expect(parseToolEmission('{"noTool":"here"}')).toBeUndefined();
  });
});

describe('PATCH mgmtLlm + GET /v1/mgmt/llm', () => {
  it('flags any anthropic source (machine-login included — CLI backend); local refused', async () => {
    const { store, f } = await world();
    store.insertAIProfile(profile({ id: 'ml', name: 'Household Claude', kind: 'subscription', secretRef: undefined }));
    store.insertAIProfile(profile({ id: 'lq', name: 'Local Qwen', vendor: 'local', secretRef: undefined }));

    const local = await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/lq', headers: H, payload: { mgmtLlm: true } });
    expect(local.statusCode).toBe(400);

    const ml = await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/ml', headers: H, payload: { mgmtLlm: true } });
    expect(ml.statusCode).toBe(200);
    const s = (await f.inject({ method: 'GET', url: '/v1/mgmt/llm', headers: H })).json();
    expect(s).toMatchObject({
      available: true, profileName: 'Household Claude',
      credential: 'machine-login · claude-cli', flagged: true,
    });
  });

  it('a subscription source completes through the CLI seam — no API key anywhere', async () => {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    const cliCalls: Array<{ model: string; oauthToken?: string }> = [];
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
      mgmtLlmComplete: async () => { throw new Error('api path must not be used for a subscription source'); },
      mgmtCliComplete: async (opts) => {
        cliCalls.push(opts);
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'via cli' }] };
      },
    });
    store.insertAIProfile(profile({ id: 'ml', kind: 'subscription', secretRef: undefined, model: 'claude-opus-4-8' }));
    const res = await f.inject({
      method: 'POST', url: '/v1/mgmt/llm/complete', headers: H,
      payload: { system: 's', tools: [], messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().content[0].text).toBe('via cli');
    expect(cliCalls).toEqual([{ model: 'claude-opus-4-8', oauthToken: undefined }]); // machine login: no token at all
    await f.close();
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

  it('an upstream failure maps to 502 naming the source — never a raw crash', async () => {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
      mgmtLlmComplete: async () => { throw new Error('401 invalid bearer'); },
    });
    store.insertAIProfile(profile({ id: 'ak', name: 'Spare Key' }));
    const res = await f.inject({ method: 'POST', url: '/v1/mgmt/llm/complete', headers: H, payload: BODY });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/Spare Key/);
    // Raw SDK errors are translated for humans (friendlyLlmError).
    expect(res.json().error).toMatch(/rejected its credential/);
    await f.close();
  });
});

describe('GET /v1/mgmt/status offline derivation', () => {
  it('a stale heartbeat reports offline, not vanished', async () => {
    const { store, f } = await world();
    store.upsertMgmtHeartbeat(OWNER, { botUsername: 'b', mode: 'read-only', allowlisted: 1 });
    // Age the beat past the 90s window (in-memory test DB; direct UPDATE is
    // the clock injection upsert doesn't offer).
    (store as any).db
      .prepare(`UPDATE mgmt_heartbeat SET seen_at = ?`)
      .run(new Date(Date.now() - 5 * 60_000).toISOString());
    const s = (await f.inject({ method: 'GET', url: '/v1/mgmt/status', headers: H })).json();
    expect(s).toMatchObject({ configured: true, online: false, botUsername: 'b' });
  });
});
