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
const H = { 'x-hatchabot-owner': OWNER };

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

describe('sharing a machine-login source is refused (family-member hardening)', () => {
  it('PATCH shared=true on a machine-login profile → 400; setup-token profile → ok', async () => {
    const { store, f } = await world();
    store.insertAIProfile(profile({ id: 'ml', name: 'Household Claude', kind: 'subscription', secretRef: undefined })); // machine login
    store.insertAIProfile(profile({ id: 'st', name: 'Max Setup Token', kind: 'subscription' })); // setup-token (has secretRef)

    const refused = await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/ml', headers: H, payload: { shared: true } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/machine-login/i);
    expect(store.getAIProfile('ml')!.shared).toBe(false); // not flipped

    const ok = await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/st', headers: H, payload: { shared: true } });
    expect(ok.statusCode).toBe(200);
    expect(store.getAIProfile('st')!.shared).toBe(true);
  });
});

describe('flagging the source behind the management chat', () => {
  it('accepts an anthropic source and refuses a local one', async () => {
    const { store, f } = await world();
    store.insertAIProfile(profile({ id: 'ml', name: 'Household Claude', kind: 'subscription', secretRef: undefined }));
    store.insertAIProfile(profile({ id: 'lq', name: 'Local Qwen', vendor: 'local', secretRef: undefined }));

    expect((await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/lq', headers: H, payload: { mgmtLlm: true } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/ml', headers: H, payload: { mgmtLlm: true } })).statusCode).toBe(200);
    // The flag is what pickMgmtProfile reads for the web chat; the Telegram
    // bot that also used it is gone (v2.0.0).
    expect(store.listAIProfiles('user-owner').find((p) => p.id === 'ml')?.mgmtLlm).toBe(true);
  });
});
