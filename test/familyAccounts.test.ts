import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';

/** What the store held each time the .env was written (HB-0063). */
const envWrites = vi.hoisted(() => ({ store: undefined as undefined | { countLocalAccounts(): number }, accountsSeen: [] as number[] }));
vi.mock('../src/ops/tailnet.js', async (orig) => {
  const real = await orig<typeof import('../src/ops/tailnet.js')>();
  return {
    ...real,
    writeEnvVar: async (...a: Parameters<typeof real.writeEnvVar>) => {
      if (envWrites.store) envWrites.accountsSeen.push(envWrites.store.countLocalAccounts());
      return real.writeEnvVar(...a);
    },
  };
});

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
  envWrites.store = store; envWrites.accountsSeen = [];
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
      // A recovery code, shown once: nobody can send the host owner a reset link.
      expect(typeof r.json().recoveryCode).toBe('string');
      expect(acct.recoveryHash).toBeTruthy();
      expect(w.store.getAgent('a1')!.ownerId).toBe(acct.id);   // adopted
      expect(w.env()).toContain('HATCHABOT_AUTH=accounts');
      expect(w.env()).toContain('HATCHABOT_SECRET_KEY=x');       // the rest untouched
    } finally { w.restore(); }
  });

  it('the account exists before the mode is written; a .env that refuses leaves no account behind (HB-0063)', async () => {
    const w = await world();
    try {
      expect((await w.post({ username: 'robin', password: 'a-long-password' })).statusCode).toBe(200);
      // Written first, a crash before the account left accounts mode with nobody to sign in as.
      expect(envWrites.accountsSeen).toEqual([1]);
    } finally { w.restore(); }
    const refused = await world();
    try {
      writeFileSync('.env', 'HATCHABOT_SECRET_KEY=x\nHATCHABOT_AUTH=identity\n', { mode: 0o600 });
      const r = await refused.post({ username: 'robin', password: 'a-long-password' });
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toMatch(/already sets HATCHABOT_AUTH=identity/);
      expect(refused.store.countLocalAccounts()).toBe(0);
      expect(refused.store.getAgent('a1')!.ownerId).toBe('dev-owner'); // nothing adopted
      // And it can be tried again once the .env is fixed.
      writeFileSync('.env', 'HATCHABOT_SECRET_KEY=x\n', { mode: 0o600 });
      expect((await refused.post({ username: 'robin', password: 'a-long-password' })).statusCode).toBe(200);
    } finally { refused.restore(); }
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
