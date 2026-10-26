/**
 * A move's promises on the destination (deep audit of v2.166.2, 2026-10-24):
 * the preflight names the AI source the import will really use (#001), a
 * move receipt is bound to the account that made it (#002), and the
 * peer's rehost-scoped token may read the receipt it announced (#008).
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { gzipSync } from 'node:zlib';
import { destinationHasAgent, moveState, preflight, receiveMove } from '../src/orchestrator/migrate.js';
import { importAgent, importProfile } from '../src/orchestrator/transfer.js';
import { registerAuth } from '../src/api/auth.js';
import { beginOperation } from '../src/orchestrator/operations.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { MemSecrets } from './support/world.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

const OWNER = 'owner-household';

function destination() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'Family box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'claude', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/claude', createdAt: 'now' });
  return store;
}

/** A full copy of a made-up anthropic agent, as another Hatchabot sends it. */
const archive = () => gzipSync(JSON.stringify({
  format: 'hatchabot-export', version: 1, exportedAt: '2026-10-20T00:00:00Z',
  agent: { name: 'Meal Planner', slug: 'meal-planner', persona: 'Plans meals.', sharedMemory: true },
  ai: { vendor: 'anthropic', model: 'claude-opus-4-8' },
  memberships: [{ userId: 'someone', role: 'owner', status: 'active' }],
  state: Buffer.from('memory').toString('base64'),
}));

describe('preflight predicts the source the import picks (audit #001)', () => {
  it('a ⭐ Default of another vendor: refused, naming the Default, and the import would take that Default', async () => {
    const store = destination();
    store.insertAIProfile({ id: 'other', ownerId: OWNER, name: 'Other API', vendor: 'openai', kind: 'api_key', model: 'gpt-4o', secretRef: 'ai/other', createdAt: 'now' });
    store.setAIProfileDefault('other');
    const a = preflight(store, OWNER, { slug: 'meal-planner', accountId: 'mealbot', vendor: 'anthropic' });
    expect(a.ok).toBe(false);
    expect(a.warnings).toContain('vendor-mismatch');
    expect(a.aiProfileName).toBe('Other API');
    expect(a.reasons.join(' ')).toMatch(/⭐ Default source, Other API \(openai\/gpt-4o\), not Claude/);
    expect(a.reasons.join(' ')).toMatch(/Move it onto Claude instead/);
    expect(a.sourceChoice).toEqual({ id: 'claude', name: 'Claude', vendor: 'anthropic', model: 'claude-opus-4-8' });
    // The import itself, unchanged: it lands on the Default the preflight named.
    expect(importProfile(store, OWNER, 'anthropic')?.id).toBe('other');
    const secrets = new MemSecrets();
    await secrets.put('ai/other', 'fixture-value');
    const imported = await importAgent({ store, secrets, provider: new MockProvider(), channel: { kind: 'telegram' } as unknown as ChannelProvisioner, sleep: async () => {} }, archive(), { ownerId: OWNER });
    expect(imported.aiProfileId).toBe('other');
  });

  it('a Default of the same vendor: accepted, and named as the source it will run on', () => {
    const store = destination();
    store.insertAIProfile({ id: 'house', ownerId: OWNER, name: 'Household Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/house', createdAt: 'now' });
    store.setAIProfileDefault('house');
    const a = preflight(store, OWNER, { slug: 'meal-planner', accountId: 'mealbot', vendor: 'anthropic' });
    expect(a).toMatchObject({ ok: true, aiProfileName: 'Household Claude', aiModel: 'claude-sonnet-5' });
  });

  it('no Default: the importer\'s own source goes before a matching one merely shared with the box, and the preview says so', () => {
    const store = destination();
    store.insertAIProfile({ id: 'shared-local', ownerId: 'someone-else', name: 'Shared local model', vendor: 'local', kind: 'api_key', model: 'small-model', secretRef: 'ai/local', createdAt: 'now' });
    store.setAIProfileShared('shared-local', true);
    const a = preflight(store, OWNER, { slug: 'garden-notes', accountId: 'gardenbot', vendor: 'local' });
    expect(importProfile(store, OWNER, 'local')?.id).toBe('claude');
    expect(a.ok).toBe(false);
    expect(a.aiProfileName).toBe('Claude');
    expect(a.reasons.join(' ')).toMatch(/your own source, Claude \(anthropic\/claude-opus-4-8\), not Shared local model/);
  });
});

describe('a move receipt belongs to the request that made it (audit #002)', () => {
  it('a second request under a taken id writes nothing: the first owner\'s pending move stays its own', () => {
    const store = destination();
    const first = receiveMove(store, 'move-fixture-0001', 'first-account');
    const second = receiveMove(store, 'move-fixture-0001', 'second-account');
    second.operation('op-of-the-second');
    second.finished('failed');
    expect(store.getMoveReceipt('move-fixture-0001')).toMatchObject({ ownerId: 'first-account', opId: null, outcome: null });
    expect(moveState(store, 'move-fixture-0001', 'first-account')).toBe('running');
    expect(moveState(store, 'move-fixture-0001', 'second-account')).toBe('unknown');
    first.finished('landed');
    expect(moveState(store, 'move-fixture-0001', 'first-account')).toBe('landed');
  });

  it('a repeat from the same account (a resent POST): its early failure is not the move\'s, and the one that lands is found', () => {
    const store = destination();
    receiveMove(store, 'move-fixture-0002', OWNER);
    receiveMove(store, 'move-fixture-0002', OWNER).finished('failed');
    expect(moveState(store, 'move-fixture-0002', OWNER)).toBe('running');

    // The first request failed before its row; the resent one made the agent.
    receiveMove(store, 'move-fixture-0003', OWNER).finished('failed');
    const resent = receiveMove(store, 'move-fixture-0003', OWNER);
    const op = beginOperation(store, 'import', null, {});
    resent.operation(op.get().id);
    op.done('imported');
    resent.finished('landed');
    expect(moveState(store, 'move-fixture-0003', OWNER)).toBe('landed');

    // An operation already attached is not replaced by a repeat's.
    const first = receiveMove(store, 'move-fixture-0004', OWNER);
    const mine = beginOperation(store, 'import', null, {});
    first.operation(mine.get().id);
    const again = receiveMove(store, 'move-fixture-0004', OWNER);
    again.operation(beginOperation(store, 'import', null, {}).get().id);
    again.finished('failed');
    expect(store.getMoveReceipt('move-fixture-0004')).toMatchObject({ opId: mine.get().id, outcome: null });
  });
});

describe('a rehost-scoped token reads its move receipt (audit #008)', () => {
  async function app() {
    const store = destination();
    store.insertLocalAccount({ id: OWNER, username: 'household', pwHash: 'unused', pwSalt: 'unused', hostOwner: true, disabled: false, createdAt: 'now' });
    const { token } = store.createCliToken(OWNER, 'peer box', 90, 'rehost');
    const f = Fastify();
    await registerAuth(f, { mode: 'accounts', secret: Buffer.alloc(32, 9), store,
      cliTokenOwner: (t) => store.ownerForCliToken(t), cliTokenScope: (t) => store.cliTokenScope(t) });
    f.get('/v1/agents', async () => []);
    f.get<{ Params: { id: string } }>('/v1/moves/:id', async (req) => ({ state: moveState(store, req.params.id, req.principal!.ownerId) }));
    f.post('/v1/moves/:id', async () => ({}));
    f.get('/v1/moves', async () => []);
    f.get('/v1/cli-tokens', async () => []);
    return { store, token, f };
  }

  it('GET of a receipt answers; nothing else under /v1/moves, and nothing else at all, opens', async () => {
    const { token, f } = await app();
    const headers = { authorization: `Bearer ${token}` };
    try {
      expect((await f.inject({ url: '/v1/moves/move-fixture-0003', headers })).statusCode).toBe(200);
      expect((await f.inject({ method: 'POST', url: '/v1/moves/move-fixture-0003', headers, payload: {} })).statusCode).toBe(401);
      expect((await f.inject({ url: '/v1/moves', headers })).statusCode).toBe(401);
      expect((await f.inject({ url: '/v1/moves/short', headers })).statusCode).toBe(401);
      expect((await f.inject({ url: '/v1/cli-tokens', headers })).statusCode).toBe(401);
    } finally { await f.close(); }
  });

  it('a move the destination knows failed reads as "no" over the peer token, so the source can be put back', async () => {
    const { store, token, f } = await app();
    receiveMove(store, 'move-fixture-0004', OWNER).finished('failed');
    try {
      const outcome = await destinationHasAgent({
        secrets: { get: async () => token, put: async () => {}, delete: async () => {} },
        sleep: async () => {},
        peerFetch: async (url, init) => {
          const r = await f.inject({ method: 'GET', url: new URL(url).pathname, headers: init?.headers as Record<string, string> });
          return new Response(r.body, { status: r.statusCode });
        },
      }, { id: 'peer', name: 'Family box', url: 'https://family-box.example', secretRef: 'unused' }, 'meal-planner', 2, 'move-fixture-0004');
      expect(outcome).toBe('no');
    } finally { await f.close(); }
  });
});
