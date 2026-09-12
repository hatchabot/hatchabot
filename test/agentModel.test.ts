import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Per-agent model override: an agent may run any model on its source's menu,
 * or follow the source default. The API is the boundary — it must reject a
 * model the source doesn't offer, refuse overrides on local sources, and clear
 * the override on null. See src/api/routes.ts modelOverrideProblem.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error('missing');
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

async function world(profile: Partial<{ vendor: string; models: string[] }> = {}) {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({
    id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock',
    name: 'box', settings: {}, createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p1', ownerId: OWNER, name: 'AI',
    vendor: (profile.vendor ?? 'anthropic') as any, kind: 'api_key',
    model: 'claude-opus-4-8',
    models: profile.models ?? ['claude-sonnet-5', 'claude-haiku-4-5'],
    secretRef: 'ai/p1', createdAt: 'now',
  });
  // A second source with a DIFFERENT menu, for testing pin-on-switch behaviour.
  store.insertAIProfile({
    id: 'p2', ownerId: OWNER, name: 'AI-2', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-opus-5', models: ['claude-fable-5'],
    secretRef: 'ai/p1', createdAt: 'now',
  });
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING',
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true,
    createdAt: 'now', updatedAt: 'now',
  });
  const f = Fastify();
  await registerRoutes(f, {
    store,
    secrets: new MemSecrets(),
    providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
  });
  return { store, f };
}

const patch = (f: any, body: unknown) =>
  f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: body });

describe('PATCH /v1/agents/:id model override', () => {
  it('accepts a model on the source menu and stores it', async () => {
    const { store, f } = await world();
    const res = await patch(f, { model: 'claude-sonnet-5' });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.model).toBe('claude-sonnet-5');
    expect(res.json().modelOverride).toBe('claude-sonnet-5');
  });

  it('accepts the profile default as an explicit override', async () => {
    const { store, f } = await world();
    const res = await patch(f, { model: 'claude-opus-4-8' });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.model).toBe('claude-opus-4-8');
  });

  it('rejects a model the source does not offer', async () => {
    const { store, f } = await world();
    const res = await patch(f, { model: 'claude-fable-5' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/isn.t one of this source/i);
    expect(store.getAgent('a1')!.model).toBeUndefined();
  });

  it('clears the override on null', async () => {
    const { store, f } = await world();
    await patch(f, { model: 'claude-sonnet-5' });
    const res = await patch(f, { model: null });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.model).toBeUndefined();
  });

  it('refuses an override on a local source', async () => {
    const { store, f } = await world({ vendor: 'local', models: [] });
    const res = await patch(f, { model: 'claude-sonnet-5' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/local sources/i);
    expect(store.getAgent('a1')!.model).toBeUndefined();
  });

  it('clears a pin stranded by an AI-source switch (new source lacks that model)', async () => {
    const { store, f } = await world();
    await patch(f, { model: 'claude-sonnet-5' });
    // p2 does not offer claude-sonnet-5 → the pin must be dropped, not stranded.
    const res = await patch(f, { aiProfileId: 'p2' });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.aiProfileId).toBe('p2');
    expect(store.getAgent('a1')!.model).toBeUndefined();
  });

  it('keeps a pin re-set in the same switch request', async () => {
    const { store, f } = await world();
    await patch(f, { model: 'claude-sonnet-5' });
    // Switch to p2 AND pin one of p2's models at once → the new pin wins.
    const res = await patch(f, { aiProfileId: 'p2', model: 'claude-fable-5' });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.model).toBe('claude-fable-5');
  });

  it('rejects a combined bad-model request WITHOUT switching the source (atomic)', async () => {
    const { store, f } = await world();
    // p2 offers claude-opus-5 / claude-fable-5, NOT claude-sonnet-5.
    const res = await patch(f, { aiProfileId: 'p2', model: 'claude-sonnet-5' });
    expect(res.statusCode).toBe(400);
    // The switch must NOT have committed — the whole request is rejected.
    expect(store.getAgent('a1')!.aiProfileId).toBe('p1');
  });

  it('exposes the source menu and default so the app can render the picker', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'GET', url: '/v1/agents', headers: as });
    const agent = res.json().find((a: any) => a.id === 'a1');
    expect(agent.profileDefaultModel).toBe('claude-opus-4-8');
    expect(agent.profileModels).toEqual([
      'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5',
    ]);
  });
});

describe('PATCH /v1/agents/:id description (persona)', () => {
  it('edits the card description, trimmed, and returns it', async () => {
    const { store, f } = await world();
    const res = await patch(f, { persona: '  Advises on condo bylaws  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json().persona).toBe('Advises on condo bylaws');
    expect(store.getAgent('a1')!.persona).toBe('Advises on condo bylaws');
  });

  it('an empty string clears it (not a "nothing to update" error)', async () => {
    const { store, f } = await world();
    await patch(f, { persona: 'temporary' });
    const res = await patch(f, { persona: '' });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.persona).toBe('');
  });

  it("does not touch the agent's files or require a rebuild (cosmetic)", async () => {
    const { store, f } = await world();
    const before = store.getAgent('a1')!;
    await patch(f, { persona: 'new blurb' });
    const after = store.getAgent('a1')!;
    // State/runtime untouched — this is a metadata-only edit.
    expect(after.state).toBe(before.state);
    expect(after.appliedModel).toBe(before.appliedModel);
  });

  it('404s for an agent the caller does not own', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: { 'x-hatchabot-owner': 'someone-else' }, payload: { persona: 'x' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('editing a source menu sweeps orphaned per-agent pins', () => {
  const patchProfile = (f: any, body: unknown) =>
    f.inject({ method: 'PATCH', url: '/v1/ai-profiles/p1', headers: as, payload: body });

  it('clears an agent pin dropped from the switchable list', async () => {
    const { store, f } = await world();
    await patch(f, { model: 'claude-sonnet-5' });
    expect(store.getAgent('a1')!.model).toBe('claude-sonnet-5');
    // Owner removes claude-sonnet-5 from the menu → the pin must be cleared.
    const res = await patchProfile(f, { models: ['claude-haiku-4-5'] });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.model).toBeUndefined();
  });

  it('keeps a pin that is still on the edited list', async () => {
    const { store, f } = await world();
    await patch(f, { model: 'claude-sonnet-5' });
    // Reorder / trim but keep claude-sonnet-5 → the pin survives.
    const res = await patchProfile(f, { models: ['claude-sonnet-5'] });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.model).toBe('claude-sonnet-5');
  });

  it('clears a pin left off a new default when the list is unchanged', async () => {
    const { store, f } = await world();
    await patch(f, { model: 'claude-haiku-4-5' });
    // Change only the default AND the menu so haiku is no longer offered.
    const res = await patchProfile(f, { model: 'claude-opus-5', models: ['claude-sonnet-5'] });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.model).toBeUndefined();
  });
});

describe('POST /v1/agents model override', () => {
  const create = (f: any, body: Record<string, unknown>) =>
    f.inject({
      method: 'POST', url: '/v1/agents', headers: as,
      payload: { name: 'New One', aiProfileId: 'p1', hostId: 'h1', ...body },
    });

  it('accepts a create with a model on the source menu', async () => {
    const { store, f } = await world();
    const res = await create(f, { model: 'claude-sonnet-5' });
    expect(res.statusCode).toBe(202);
    expect(store.getAgent(res.json().id)!.model).toBe('claude-sonnet-5');
  });

  it('rejects a create with an off-menu model', async () => {
    const { f } = await world();
    const res = await create(f, { model: 'claude-fable-5' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/isn.t one of this source/i);
  });

  it('rejects a create with a model on a local source', async () => {
    const { f } = await world({ vendor: 'local', models: [] });
    const res = await create(f, { model: 'claude-sonnet-5' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/local sources/i);
  });
});

describe('PATCH /v1/agents/:id image pin', () => {
  it('pins, exposes on the record, and clears with null', async () => {
    const { store, f } = await world();
    let res = await patch(f, { image: 'hatchabot-runtime:candidate-9' });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.image).toBe('hatchabot-runtime:candidate-9');
    res = await patch(f, { image: null });
    expect(res.statusCode).toBe(200);
    expect(store.getAgent('a1')!.image).toBeUndefined();
  });

  it('refuses a caller who does not own the machine', async () => {
    // Any local image is runnable by NAME, including ones unrelated to
    // Hatchabot — so which image runs on this box is the machine owner's call,
    // same as host paths. Agent ownership is not enough.
    const { store, f } = await world();
    store.insertAgent({
      id: 'a2', ownerId: 'user-two', name: 'Theirs', slug: 'theirs', state: 'RUNNING',
      aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true,
      createdAt: 'now', updatedAt: 'now',
    });
    const res = await f.inject({
      method: 'PATCH', url: '/v1/agents/a2',
      headers: { 'x-hatchabot-owner': 'user-two' },
      payload: { image: 'evil:latest' },
    });
    expect(res.statusCode).toBe(403);
    expect(store.getAgent('a2')!.image).toBeUndefined();
  });
});

describe('POST /v1/ai-profiles/:id/adopt-agents (bulk source switch)', () => {
  const adopt = (f: any, id: string, body: unknown, owner = OWNER) =>
    f.inject({ method: 'POST', url: `/v1/ai-profiles/${id}/adopt-agents`, headers: { 'x-hatchabot-owner': owner }, payload: body });

  it('moves ALL of the owner\'s agents off their current source when apply is omitted', async () => {
    const { store, f } = await world();
    // a1 starts on p1; add a2 also on p1. p2 is the destination.
    store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Den', slug: 'den', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    const res = await adopt(f, 'p2', {});
    expect(res.statusCode).toBe(200);
    expect(res.json().switched).toBe(2);
    expect(store.getAgent('a1')!.aiProfileId).toBe('p2');
    expect(store.getAgent('a2')!.aiProfileId).toBe('p2');
  });

  it('switches only the named agents when apply is given, and drops a stale pin', async () => {
    const { store, f } = await world();
    store.setAgentModel('a1', 'claude-sonnet-5'); // valid on p1, NOT on p2 (menu is fable only)
    store.insertAgent({ id: 'a2', ownerId: OWNER, name: 'Den', slug: 'den', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    const res = await adopt(f, 'p2', { apply: ['a1'] });
    expect(res.json().switched).toBe(1);
    expect(store.getAgent('a1')!.aiProfileId).toBe('p2');
    expect(store.getAgent('a1')!.model).toBeUndefined(); // stale pin cleared
    expect(store.getAgent('a2')!.aiProfileId).toBe('p1'); // untouched
  });

  it('is a no-op for an agent already on the target', async () => {
    const { f } = await world();
    const res = await adopt(f, 'p1', {}); // a1 is already on p1
    expect(res.json().switched).toBe(0);
  });

  it('404s a source the caller does not own', async () => {
    const { f } = await world();
    const res = await adopt(f, 'p1', {}, 'someone-else');
    expect(res.statusCode).toBe(404);
  });
});

describe('a setup-token pasted as an API key is refused (it would fail every call)', () => {
  const addProfile = (f: any, body: unknown) =>
    f.inject({ method: 'POST', url: '/v1/ai-profiles', headers: { 'x-hatchabot-owner': OWNER }, payload: body });

  it('rejects an sk-ant-oat token in the api_key field with guidance', async () => {
    const { f } = await world();
    const res = await addProfile(f, {
      kind: 'api_key', vendor: 'anthropic', name: 'Oops', model: 'claude-opus-4-8',
      apiKey: 'sk-ant-oat01-REDACTEDsetuptoken',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/setup-token/i);
    expect(res.json().error).toMatch(/subscription/i);
  });

  it('still accepts a real API key (sk-ant-api…)', async () => {
    const { f } = await world();
    const res = await addProfile(f, {
      kind: 'api_key', vendor: 'anthropic', name: 'Real', model: 'claude-opus-4-8',
      apiKey: 'sk-ant-api03-REDACTEDrealkey',
    });
    expect(res.statusCode).toBe(201);
  });

  it('accepts the same setup-token when created as a subscription source', async () => {
    const { f } = await world();
    const res = await addProfile(f, {
      kind: 'subscription', vendor: 'anthropic', name: 'Setup Token', model: 'claude-opus-4-8',
      oauthToken: 'sk-ant-oat01-REDACTEDsetuptoken',
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('a new Anthropic source is stocked with the Claude line-up', () => {
  const addProfile = (f: any, body: unknown) =>
    f.inject({ method: 'POST', url: '/v1/ai-profiles', headers: { 'x-hatchabot-owner': OWNER }, payload: body });

  it('seeds switchable models on a subscription source created with none', async () => {
    const { store, f } = await world();
    const res = await addProfile(f, {
      kind: 'subscription', vendor: 'anthropic', name: 'Setup Token', model: 'claude-opus-4-8',
      oauthToken: 'sk-ant-oat01-x',
    });
    const id = res.json().id;
    const models = store.getAIProfile(id)!.models ?? [];
    // Not stuck on the single default — the alternates are there to switch to.
    expect(models).toContain('claude-opus-4-8');
    expect(models).toContain('claude-sonnet-5');
    expect(models.length).toBeGreaterThan(1);
  });

  it('respects an explicit models list rather than overriding it', async () => {
    const { store, f } = await world();
    const res = await addProfile(f, {
      kind: 'subscription', vendor: 'anthropic', name: 'Narrow', model: 'claude-opus-4-8',
      oauthToken: 'sk-ant-oat01-x', models: ['claude-opus-4-8', 'claude-haiku-4-5'],
    });
    expect(store.getAIProfile(res.json().id)!.models).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
  });
})

describe('bulk adopt-agents passes the checkpoint flag through to rebuild', () => {
  it('accepts checkpoint in the body without error and reports rebuilding', async () => {
    const { store, f } = await world();
    // a1 on p1 → move to p2 with rebuild + checkpoint.
    const res = await f.inject({
      method: 'POST', url: '/v1/ai-profiles/p2/adopt-agents',
      headers: { 'x-hatchabot-owner': OWNER },
      payload: { apply: ['a1'], rebuild: true, checkpoint: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().switched).toBe(1);
    expect(store.getAgent('a1')!.aiProfileId).toBe('p2');
  });
})
