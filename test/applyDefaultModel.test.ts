import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { effectiveModel } from '../src/orchestrator/provision.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

/**
 * p1: cloud source, default opus-4-8, menu adds sonnet-5 + haiku-4-5.
 *   a1 follower1 (no override) · a2 follower2 (no override) · a3 override→sonnet-5.
 * p-local: a local source with one agent, to prove local is rejected.
 */
async function world(opts: { shared?: boolean } = {}) {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({
    id: 'p1', ownerId: OWNER, name: 'Cloud', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-opus-4-8', models: ['claude-sonnet-5', 'claude-haiku-4-5'],
    secretRef: 'ai/p1', shared: opts.shared ?? false, createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p-local', ownerId: OWNER, name: 'Ollama', vendor: 'local', kind: 'api_key',
    model: 'gpt-oss', secretRef: 'ai/loc', createdAt: 'now',
  });
  async function seed(id: string, slug: string, name: string, aiProfileId: string, model?: string) {
    const { runtimeRef } = await provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {} } as any);
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: OWNER, name, slug, state: 'RUNNING', aiProfileId, hostId: 'h1', runtimeRef, model, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  }
  await seed('a1', 'f1', 'Follower1', 'p1');
  await seed('a2', 'f2', 'Follower2', 'p1');
  await seed('a3', 'ov', 'Override', 'p1', 'claude-sonnet-5');
  await seed('al', 'lo', 'LocalAgent', 'p-local');
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f };
}

const apply = (f: any, id: string, body: unknown, owner = OWNER) =>
  f.inject({ method: 'POST', url: `/v1/ai-profiles/${id}/apply-default-model`, headers: { 'x-hatchabot-owner': owner }, payload: body });

describe('POST /v1/ai-profiles/:id/apply-default-model', () => {
  it('switches only the selected agent and PINS every other one to its current model', async () => {
    const { store, f } = await world();
    const res = await apply(f, 'p1', { model: 'claude-opus-5', apply: ['a1'], rebuild: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 1, held: 2, live: 1 });

    // Default moved.
    expect(store.getAIProfile('p1')!.model).toBe('claude-opus-5');
    // a1 selected → override cleared, follows the new default.
    expect(store.getAgent('a1')!.model).toBeUndefined();
    // a2 was a follower, NOT selected → pinned to the OLD default so it holds.
    expect(store.getAgent('a2')!.model).toBe('claude-opus-4-8');
    // a3 had its own model, not selected → untouched.
    expect(store.getAgent('a3')!.model).toBe('claude-sonnet-5');
  });

  it('keeps every held pin on the menu so it stays valid (no silent drift)', async () => {
    const { store, f } = await world();
    await apply(f, 'p1', { model: 'claude-opus-5', apply: ['a1'], rebuild: false });
    const menu = store.getAIProfile('p1')!.models ?? [];
    // The old default (a2's pin) and the override (a3's) must both survive on
    // the menu — otherwise effectiveModel would treat the pin as stale.
    expect(menu).toContain('claude-opus-4-8');
    expect(menu).toContain('claude-sonnet-5');
  });

  it('reflects the hold through the API: a held follower shows its old model, not pending', async () => {
    const { f } = await world();
    await apply(f, 'p1', { model: 'claude-opus-5', apply: ['a1'], rebuild: false });
    const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
    const a2 = list.find((a: any) => a.id === 'a2');
    expect(a2.modelOverride).toBe('claude-opus-4-8'); // pinned
    expect(a2.pendingModel).toBeUndefined();          // it will NOT switch
  });

  it('a follower left unticked is held on the model it was built with, not a default saved but not yet applied to it (audit #098)', async () => {
    const { store, f } = await world();
    store.setAgentApplied('a2', 'p1', 'claude-sonnet-5'); // what its container runs
    // The default changed without applying it to a2: a2 still runs sonnet-5.
    expect((await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/p1', headers: as, payload: { model: 'claude-haiku-4-5' } })).statusCode).toBe(200);
    expect(store.getAgent('a2')!.appliedModel).toBe('claude-sonnet-5');
    const res = await apply(f, 'p1', { model: 'claude-opus-5', apply: [] });
    expect(res.json()).toMatchObject({ applied: 0, live: 0 });
    expect(store.getAgent('a2')).toMatchObject({ model: 'claude-sonnet-5', appliedModel: 'claude-sonnet-5' });
    // Its next build keeps it there: the pin is on the menu.
    expect(effectiveModel(store.getAgent('a2')!, store.getAIProfile('p1')!)).toBe('claude-sonnet-5');
  });

  it('ticking an override agent adopts the new default for it', async () => {
    const { store, f } = await world();
    await apply(f, 'p1', { model: 'claude-opus-5', apply: ['a3'], rebuild: false });
    expect(store.getAgent('a3')!.model).toBeUndefined(); // override cleared → follows opus-5
  });

  it('applies the new default LIVE (models set, no rebuild) to each selected running agent', async () => {
    const { f, provider } = await world();
    const res = await apply(f, 'p1', { model: 'claude-opus-5', apply: ['a1', 'a2'] });
    expect(res.json().live).toBe(2);
    // it ran `openclaw models set` per switched agent — not a rebuild/provision
    const sets = provider.execLog.filter((c) => Array.isArray(c) && c[0] === 'models' && c[1] === 'set');
    expect(sets.length).toBe(2);
  });

  it('live-applies the NEW default, not the stale in-memory old one (audit 2026-09-11 CRITICAL)', async () => {
    const { provider, f } = await world();
    await apply(f, 'p1', { model: 'claude-sonnet-5', apply: ['a1'] });
    const sets = provider.execLog.filter((c) => Array.isArray(c) && c[0] === 'models' && c[1] === 'set').map((c) => c[2]);
    expect(sets).toEqual(['anthropic/claude-sonnet-5']); // was anthropic/claude-opus-4-8 (the OLD default)
  });

  it('stages the new default onto a STOPPED agent\'s volume so it applies on next start', async () => {
    const { store, provider, f } = await world();
    store.setAgentState('a2', 'STOPPED');
    const res = await apply(f, 'p1', { model: 'claude-sonnet-5', apply: ['a1', 'a2'] });
    expect(res.json()).toMatchObject({ live: 1, staged: 1 });
    const vol = provider.execLog.find((c) => c[0] === 'sh-volume');
    expect(String(vol?.[1])).toContain("models set 'anthropic/claude-sonnet-5'");
    expect(store.getAgent('a2')!.appliedModel).toBe('claude-sonnet-5');
  });

  it('with apply:[] holds everyone and only changes the default (for new agents)', async () => {
    const { store, f } = await world();
    const res = await apply(f, 'p1', { model: 'claude-opus-5', apply: [] });
    expect(res.json()).toMatchObject({ applied: 0, held: 3, live: 0 });
    expect(store.getAgent('a1')!.model).toBe('claude-opus-4-8'); // former follower pinned
    expect(store.getAgent('a2')!.model).toBe('claude-opus-4-8');
    expect(store.getAgent('a3')!.model).toBe('claude-sonnet-5');
  });

  it('rejects a local source (one model per GPU — cannot hold individuals)', async () => {
    const { f } = await world();
    const res = await apply(f, 'p-local', { model: 'llama3', apply: [], rebuild: false });
    expect(res.statusCode).toBe(400);
  });

  it('404s for a profile the caller does not own, touching nothing', async () => {
    const { store, f } = await world();
    const res = await apply(f, 'p1', { model: 'claude-opus-5', apply: ['a1'] }, 'someone-else');
    expect(res.statusCode).toBe(404);
    expect(store.getAIProfile('p1')!.model).toBe('claude-opus-4-8'); // unchanged
  });

  it('never reaches into another owner\'s agent on a shared source', async () => {
    const { store, f } = await world({ shared: true });
    // A second owner has an agent following the shared source's default.
    store.insertAgent({ id: 'x1', ownerId: 'other', name: 'Theirs', slug: 'theirs', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://x1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    await apply(f, 'p1', { model: 'claude-opus-5', apply: [], rebuild: false });
    // Our own were held; the other owner's agent is left entirely alone.
    expect(store.getAgent('x1')!.model).toBeUndefined();
  });

  it('does NOT clear another owner\'s explicit pin when our menu drops it', async () => {
    // The earlier test only covered an agent with no pin — the one shape the
    // stale-sweep could never touch. A real pin was being nulled across owners,
    // moving their agent onto OUR new default at its next rebuild.
    const { store, f } = await world({ shared: true });
    store.insertAgent({ id: 'x1', ownerId: 'other', name: 'Theirs', slug: 'theirs', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://x1', model: 'claude-opus-4-8', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    // Our call rewrites the menu to exclude claude-opus-4-8 entirely.
    await apply(f, 'p1', { model: 'claude-sonnet-5', models: [], apply: ['a1'], rebuild: false });
    expect(store.getAgent('x1')!.model).toBe('claude-opus-4-8'); // their pin survives
  });

  it('keeps another owner\'s pin on the menu, so it still runs that model (A098)', async () => {
    const { store, f } = await world({ shared: true });
    store.insertAgent({ id: 'x1', ownerId: 'other', name: 'Theirs', slug: 'theirs', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://x1', model: 'claude-opus-4-8', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    // A pin already off the menu was not running that model; it is not revived.
    store.insertAgent({ id: 'x2', ownerId: 'other', name: 'Stale', slug: 'stale', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://x2', model: 'claude-retired-1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    await apply(f, 'p1', { model: 'claude-sonnet-5', models: [], apply: ['a1', 'a2', 'a3'], rebuild: false });
    const p = store.getAIProfile('p1')!;
    expect(p.models).toContain('claude-opus-4-8');
    expect(p.models).not.toContain('claude-retired-1');
    expect(effectiveModel(store.getAgent('x1')!, p)).toBe('claude-opus-4-8');
  });

  it('a PATCH that trims the menu also leaves another owner\'s pin alone', async () => {
    const { store, f } = await world({ shared: true });
    store.insertAgent({ id: 'x1', ownerId: 'other', name: 'Theirs', slug: 'theirs', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://x1', model: 'claude-haiku-4-5', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    await f.inject({ method: 'PATCH', url: '/v1/ai-profiles/p1', headers: as, payload: { model: 'claude-sonnet-5', models: [] } });
    expect(store.getAgent('x1')!.model).toBe('claude-haiku-4-5');
  });
});

describe('the model picker offers only what the runtime can actually serve', () => {
  // Same live shape that produced the fleet-wide compaction outage.
  const CATALOG = JSON.stringify({ models: [
    { key: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8', input: 'text+image', contextWindow: 1048576 },
    { key: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', input: 'text+image', contextWindow: 1000000 },
    { key: 'anthropic/claude-opus-5',   name: 'claude-opus-5',   input: 'text',       contextWindow: 200000 },
  ]});

  it('excludes the stub model a live agent proves is unserved', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('models list', { code: 0, stdout: CATALOG, stderr: '' });
    const res = await f.inject({ method: 'GET', url: '/v1/ai-profiles/p1/available-models', headers: as });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('runtime');
    expect(body.models).toContain('claude-opus-4-8');
    expect(body.models).not.toContain('claude-opus-5'); // the whole point
  });

  it('reports listed-but-unserved models as stale instead of offering them', async () => {
    const { f, provider } = await world();
    // Runtime serves only opus-4-8; the profile still lists sonnet-5 + haiku-4-5.
    provider.execResponses.set('models list', {
      code: 0, stdout: JSON.stringify({ models: [{ key: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8' }] }), stderr: '',
    });
    const body = (await f.inject({ method: 'GET', url: '/v1/ai-profiles/p1/available-models', headers: as })).json();
    expect(body.models).toEqual(['claude-opus-4-8']);          // only what's served
    // Junk is surfaced separately so the app can strip it from the menu —
    // blending it in is what kept claude-opus-5 pickable.
    expect(body.stale.sort()).toEqual(['claude-haiku-4-5', 'claude-sonnet-5']);
  });

  it('flags an unserved DEFAULT as stale too (so the app can warn, not silently switch)', async () => {
    const { store, f, provider } = await world();
    store.setAIProfileModel('p1', 'claude-opus-5'); // the outage shape
    provider.execResponses.set('models list', { code: 0, stdout: CATALOG, stderr: '' });
    const body = (await f.inject({ method: 'GET', url: '/v1/ai-profiles/p1/available-models', headers: as })).json();
    expect(body.models).not.toContain('claude-opus-5');
    expect(body.stale).toContain('claude-opus-5');
  });

  it('asks the agent on the newest OpenClaw, not the first one found (HB-0082)', async () => {
    const { store, f, provider } = await world();
    // a1 (found first) runs an old image whose catalog lacks sonnet-5; a3 runs the newest.
    const old = store.getAgent('a1')!.runtimeRef!, newest = store.getAgent('a3')!.runtimeRef!;
    provider.infoOverride.set(old, { openclawVersion: '2026.7.1' });
    provider.infoOverride.set(store.getAgent('a2')!.runtimeRef!, { openclawVersion: '2026.9.6' });
    provider.infoOverride.set(newest, { openclawVersion: '2026.9.8' });
    const asked: string[] = [];
    const small = JSON.stringify({ models: [{ key: 'anthropic/claude-opus-4-8', name: 'Claude Opus 4.8' }] });
    provider.exec = async (ref: string, argv: string[]) => {
      if (argv[0] !== 'models') return { code: 0, stdout: '', stderr: '' };
      asked.push(ref);
      return { code: 0, stdout: ref === newest ? CATALOG : small, stderr: '' };
    };
    const body = (await f.inject({ method: 'GET', url: '/v1/ai-profiles/p1/available-models', headers: as })).json();
    expect(asked).toEqual([newest]);
    expect(body).toMatchObject({ source: 'runtime', openclawVersion: '2026.9.8' });
    expect(body.models).toContain('claude-sonnet-5');
    expect(body.stale).not.toContain('claude-sonnet-5');
  });

  it('falls back to the curated list when no live agent can be asked — and that list has no opus-5', async () => {
    const { f, provider } = await world();
    provider.execResponses.set('models list', { code: 1, stdout: '', stderr: 'unknown option --all' });
    const body = (await f.inject({ method: 'GET', url: '/v1/ai-profiles/p1/available-models', headers: as })).json();
    expect(body.source).toBe('curated');
    expect(body.models).not.toContain('claude-opus-5');
    expect(body.models).toContain('claude-opus-4-8');
  });
});

describe('apply-default-model reports what it actually changed', () => {
  it('counts only the caller\'s own agents, not every id passed in', async () => {
    const { store, f } = await world({ shared: true });
    // Another account's agent on the same SHARED profile — passing its id must
    // not be counted as applied (it is filtered out of `mine` and untouched).
    store.insertAgent({ id: 'x1', ownerId: 'other', name: 'Theirs', slug: 'theirs', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://x1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    const res = await apply(f, 'p1', { model: 'claude-opus-5', apply: ['a1', 'x1'], rebuild: false });
    // a1 is mine, x1 is not → applied must be 1, not the 2 ids sent.
    expect(res.json().applied).toBe(1);
    expect(store.getAgent('x1')!.model).toBeUndefined(); // genuinely untouched
  });
});

describe('apply-default-model on a Claude plan holds an agent whose runtime is too old for the model (HB-0232)', () => {
  it('the too-old agent keeps its model and is named; the rest switch', async () => {
    const { store, f, provider } = await world();
    store.insertAIProfile({ id: 'p-sub', ownerId: OWNER, name: 'Claude plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', models: [], secretRef: 'ai/sub', createdAt: 'now' } as any);
    store.setAgentAIProfile('a1', 'p-sub');
    store.setAgentAIProfile('a2', 'p-sub');
    provider.infoOverride.set(store.getAgent('a1')!.runtimeRef!, { openclawVersion: '2026.9.6' });
    provider.infoOverride.set(store.getAgent('a2')!.runtimeRef!, { openclawVersion: '2026.9.8' });
    const res = await apply(f, 'p-sub', { model: 'claude-opus-5-5', apply: ['a1', 'a2'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 1, held: 1, notSwitched: [{ id: 'a1', name: 'Follower1' }] });
    expect(res.json().notSwitched[0].reason).toMatch(/needs OpenClaw 2026\.9\.7/);
    // Held = pinned to what it runs, which stays on the menu.
    expect(store.getAgent('a1')!.model).toBe('claude-opus-4-8');
    expect(effectiveModel(store.getAgent('a1')!, store.getAIProfile('p-sub')!)).toBe('claude-opus-4-8');
    expect(store.getAgent('a2')!.model).toBeUndefined();
    expect(effectiveModel(store.getAgent('a2')!, store.getAIProfile('p-sub')!)).toBe('claude-opus-5-5');
  });

  it('an API-key source is not judged on the plan rule', async () => {
    const { store, f, provider } = await world();
    provider.infoOverride.set(store.getAgent('a1')!.runtimeRef!, { openclawVersion: '2026.9.6' });
    const res = await apply(f, 'p1', { model: 'claude-opus-5-5', apply: ['a1'] });
    expect(res.json()).toMatchObject({ applied: 1 });
    expect(res.json().notSwitched).toBeUndefined();
  });
});

describe('apply-default-model on a shared Claude plan holds another account\'s follower whose runtime is too old (HB-0245)', () => {
  it('pins it to what it runs, counts it without naming it, and lets a current one follow', async () => {
    const { store, f, provider } = await world();
    store.insertAIProfile({ id: 'p-sub', ownerId: OWNER, name: 'Claude plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', models: [], secretRef: 'ai/sub', shared: true, createdAt: 'now' } as any);
    const OTHER = 'user-other';
    async function seedOther(id: string, slug: string, name: string, version: string) {
      const { runtimeRef } = await provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {} } as any);
      store.insertAgent({ id, ownerId: OTHER, name, slug, state: 'RUNNING', aiProfileId: 'p-sub', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
      provider.infoOverride.set(runtimeRef, { openclawVersion: version });
    }
    await seedOther('b1', 'old-runtime', 'Meal Planner', '2026.9.6');
    await seedOther('b2', 'new-runtime', 'Budget Tracker', '2026.9.8');
    const res = await apply(f, 'p-sub', { model: 'claude-opus-5-5', apply: [] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ othersHeld: 1 });
    expect(res.body).not.toContain('Meal Planner');
    expect(res.body).not.toContain('b1');
    expect(store.getAgent('b1')!.model).toBe('claude-opus-4-8');
    expect(effectiveModel(store.getAgent('b1')!, store.getAIProfile('p-sub')!)).toBe('claude-opus-4-8');
    expect(store.getAgent('b2')!.model).toBeUndefined();
    expect(effectiveModel(store.getAgent('b2')!, store.getAIProfile('p-sub')!)).toBe('claude-opus-5-5');
    // A model every runtime takes: nobody is held.
    const again = await apply(f, 'p-sub', { model: 'claude-sonnet-5', apply: [] });
    expect(again.json().othersHeld).toBeUndefined();
  });
});
