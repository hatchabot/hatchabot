import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';

/**
 * One shared password → an account per person, from the app. The account is
 * made (and adopts everything) BEFORE the mode flips, so there is never a
 * first-run window for somebody else to claim.
 */
async function world(authMode: 'password' | 'accounts' = 'password') {
  const dir = mkdtempSync(join(tmpdir(), 'hb-fam-'));
  writeFileSync(join(dir, '.env'), 'HATCHABOT_SECRET_KEY=x\nHATCHABOT_PASSWORD=shared\nPORT=8080\n', { mode: 0o600 });
  const cwd = process.cwd();
  process.chdir(dir);
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: 'dev-owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: 'dev-owner', name: 'My Claude', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  store.insertAgent({
    id: 'a1', ownerId: 'dev-owner', name: 'October', slug: 'october', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
  } as never);
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
    providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
    authMode,
  } as never);
  const post = (body: object) => f.inject({ method: 'POST', url: '/v1/auth/family-accounts', headers: { 'x-hatchabot-owner': 'dev-owner' }, payload: body as never });
  return { store, post, env: () => readFileSync(join(dir, '.env'), 'utf8'), restore: () => process.chdir(cwd) };
}

describe('turning on family accounts', () => {
  it('makes account #1 the host owner, gives it everything, and writes the mode', async () => {
    const w = await world();
    try {
      const r = await w.post({ username: 'chris', password: 'a-long-password' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, username: 'chris' });
      const acct = w.store.localAccountByUsername('chris')!;
      expect(acct.hostOwner).toBe(true);
      expect(w.store.getAgent('a1')!.ownerId).toBe(acct.id);   // adopted
      expect(w.env()).toContain('HATCHABOT_AUTH=accounts');
      expect(w.env()).toContain('HATCHABOT_SECRET_KEY=x');       // the rest untouched
    } finally { w.restore(); }
  });

  it('refuses a weak password and changes nothing', async () => {
    const w = await world();
    try {
      expect((await w.post({ username: 'chris', password: 'short' })).statusCode).toBe(400);
      expect(w.store.countLocalAccounts()).toBe(0);
      expect(w.env()).not.toContain('HATCHABOT_AUTH');
      expect(w.store.getAgent('a1')!.ownerId).toBe('dev-owner');
    } finally { w.restore(); }
  });

  it('is refused once accounts are already on', async () => {
    const w = await world('accounts');
    try {
      expect((await w.post({ username: 'chris', password: 'a-long-password' })).statusCode).toBe(409);
    } finally { w.restore(); }
  });
});
