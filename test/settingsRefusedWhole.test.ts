/**
 * A settings save that is refused changes nothing: every check runs before
 * the first write (#56 for an AI source, #57 for the manager's settings).
 */
import { describe, expect, it } from 'vitest';
import { makeWorld, seedRunningAgent, as, OWNER } from './support/world.js';

describe('PATCH /v1/ai-profiles/:id refused whole (#56)', () => {
  it('a new model sent with a refused management-source choice is not saved', async () => {
    const w = await makeWorld();
    w.store.insertAIProfile({ id: 'p-local', ownerId: OWNER, name: 'Pantry model', vendor: 'local', kind: 'api_key', model: 'qwen-small', createdAt: 'now' } as any);
    const res = await w.f.inject({ method: 'PATCH', url: '/v1/ai-profiles/p-local', headers: as(), payload: { model: 'qwen-large', mgmtLlm: true } });
    expect(res.statusCode).toBe(400);
    expect(w.store.getAIProfile('p-local')!.model).toBe('qwen-small');
  });

  it('nor with a refused share, nor with a default only the machine owner sets', async () => {
    const w = await makeWorld();
    w.store.insertAIProfile({ id: 'p-login', ownerId: OWNER, name: 'Max (this machine)', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', createdAt: 'now' } as any);
    const shared = await w.f.inject({ method: 'PATCH', url: '/v1/ai-profiles/p-login', headers: as(), payload: { model: 'claude-sonnet-5', shared: true } });
    expect(shared.statusCode).toBe(400);
    expect(w.store.getAIProfile('p-login')!.model).toBe('claude-opus-4-8');

    w.store.insertAIProfile({ id: 'p-theirs', ownerId: 'user-grandma', name: 'Grandma key', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p-theirs', createdAt: 'now' } as any);
    const dflt = await w.f.inject({ method: 'PATCH', url: '/v1/ai-profiles/p-theirs', headers: as('user-grandma'), payload: { model: 'claude-sonnet-5', defaultSource: true } });
    expect(dflt.statusCode).toBe(403);
    expect(w.store.getAIProfile('p-theirs')!.model).toBe('claude-opus-4-8');
  });
});

describe('PATCH /v1/agents/:id on the manager refused whole (#57)', () => {
  it('a file limit sent with a browser it may not have is not saved', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'mgr', name: 'Hatchabot', slug: 'hatchabot', accountId: 'housebot' });
    w.store.setAgentOps('mgr', true);
    const res = await w.f.inject({ method: 'PATCH', url: '/v1/agents/mgr', headers: as(), payload: { browser: true, filesMaxMb: 40 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no browser/);
    expect(w.store.getAgent('mgr')!.filesMaxMb).toBeUndefined();
    expect(w.store.getAgent('mgr')!.browser).toBeFalsy();
    // Alone, the file limit is fine.
    expect((await w.f.inject({ method: 'PATCH', url: '/v1/agents/mgr', headers: as(), payload: { filesMaxMb: 40 } })).statusCode).toBe(200);
    expect(w.store.getAgent('mgr')!.filesMaxMb).toBe(40);
  });
});
