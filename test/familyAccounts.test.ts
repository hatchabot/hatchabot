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
      expect(r.json().ownerId).toBe(acct.id); // whose the code is: the new account's (HB-0500)
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

  describe('a crash between the account and the .env (HB-0423)', () => {
    /** What the route leaves if the process dies after its transaction and before the .env is written. */
    const halfMade = (store: Store, id = 'acct-half-made', username = 'robin') => {
      store.insertLocalAccount({ id, username, pwHash: 'made-up-hash', pwSalt: 'made-up-salt', hostOwner: true, disabled: false, createdAt: new Date().toISOString() });
      store.recordAccount(id);
      store.setLocalAccountRecovery(id, 'made-up-recovery-hash', 'made-up-recovery-salt');
    };

    it('trying again finishes the switch, with a new recovery code, under the same name or another', async () => {
      for (const username of ['robin', 'sam']) {
        const w = await world();
        try {
          halfMade(w.store);
          const r = await w.post({ username, password: 'a-long-password' });
          expect(r.statusCode, r.body).toBe(200);
          expect(typeof r.json().recoveryCode).toBe('string');
          expect(w.store.countLocalAccounts()).toBe(1);
          expect(w.store.localAccount('acct-half-made')).toBeUndefined();
          const acct = w.store.localAccountByUsername(username)!;
          expect(acct.hostOwner).toBe(true);
          expect(acct.pwHash).not.toBe('made-up-hash');
          expect(acct.recoveryHash).not.toBe('made-up-recovery-hash');
          expect(w.store.getAgent('a1')!.ownerId).toBe(acct.id); // adopted
          expect(w.env()).toContain('HATCHABOT_AUTH=accounts');
        } finally { w.restore(); }
      }
    });

    it('a bad retry changes nothing, and a .env that refuses leaves it possible to try again', async () => {
      const w = await world();
      try {
        halfMade(w.store);
        expect((await w.post({ username: 'robin', password: 'short' })).statusCode).toBe(400);
        expect(w.store.localAccount('acct-half-made')).toBeTruthy();
        writeFileSync('.env', 'HATCHABOT_SECRET_KEY=x\nHATCHABOT_AUTH=identity\n', { mode: 0o600 });
        expect((await w.post({ username: 'robin', password: 'a-long-password' })).statusCode).toBe(409);
        expect(w.store.getAgent('a1')!.ownerId).toBe('dev-owner');
        writeFileSync('.env', 'HATCHABOT_SECRET_KEY=x\n', { mode: 0o600 });
        expect((await w.post({ username: 'robin', password: 'a-long-password' })).statusCode).toBe(200);
      } finally { w.restore(); }
    });

    it('two tries at once: one wins, and its account and recovery code are the ones that stand', async () => {
      const w = await world();
      try {
        halfMade(w.store);
        const [a, b] = await Promise.all([w.post({ username: 'robin', password: 'a-long-password' }), w.post({ username: 'sam', password: 'a-long-password' })]);
        expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
        const won = a.statusCode === 200 ? a : b;
        expect(w.store.countLocalAccounts()).toBe(1);
        const acct = w.store.localAccountByUsername(won.json().username)!;
        expect(w.store.getAgent('a1')!.ownerId).toBe(acct.id);
      } finally { w.restore(); }
    });

    it('a switch that did finish, waiting for its restart, is left alone and told to restart', async () => {
      const w = await world();
      try {
        // .env already written: the account is the real one, however new.
        halfMade(w.store);
        writeFileSync('.env', 'HATCHABOT_SECRET_KEY=x\nHATCHABOT_AUTH=accounts\n', { mode: 0o600 });
        const again = await w.post({ username: 'sam', password: 'a-long-password' });
        expect(again.statusCode).toBe(409);
        expect(again.json().error).toMatch(/restart to finish/);
        expect(w.store.localAccount('acct-half-made')).toBeTruthy();
      } finally { w.restore(); }
    });

    it('an account that is more than a half-made switch is never replaced, and no restart is promised', async () => {
      const cases: Array<[string, (s: Store) => void]> = [
        ['it owns an agent', (s) => { halfMade(s); s.insertAgent({ id: 'b1', ownerId: 'acct-half-made', name: 'B', slug: 'b', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as never); }],
        ['it has a CLI token', (s) => { halfMade(s); s.createCliToken('acct-half-made', 'command line', 1); }],
        ['it has a second factor', (s) => { halfMade(s); s.insertSecondFactor({ id: 'sf1', ownerId: 'acct-half-made', kind: 'totp', label: 'phone', data: 'x' }); }],
        ['it has signed in since it was made', (s) => { halfMade(s); s.rawDb().prepare(`UPDATE accounts SET last_seen = ? WHERE owner_id = 'acct-half-made'`).run(new Date(Date.now() + 3_600_000).toISOString()); }],
        ['it has a seat on an agent', (s) => { halfMade(s); s.insertMembership({ id: 'm1', agentId: 'a1', userId: 'acct-half-made', role: 'member', status: 'active' } as never); }],
        ['there is a second account', (s) => { halfMade(s); s.insertLocalAccount({ id: 'acct-2', username: 'alex', pwHash: 'h', pwSalt: 's', hostOwner: false, disabled: false, createdAt: 'now' }); }],
        ['it was made on the command line and has no password yet', (s) => { s.insertLocalAccount({ id: 'acct-half-made', username: 'robin', pwHash: '', pwSalt: '', hostOwner: true, disabled: false, createdAt: 'now' }); s.setLocalAccountClaim('acct-half-made', 'made-up-claim', new Date(Date.now() + 60_000).toISOString()); }],
      ];
      for (const [why, set] of cases) {
        const w = await world();
        try {
          set(w.store);
          const before = w.store.countLocalAccounts();
          const r = await w.post({ username: 'sam', password: 'a-long-password' });
          expect(r.statusCode, why).toBe(409);
          expect(r.json().error, why).not.toMatch(/restart to finish/);
          expect(r.json().error, why).toMatch(/HATCHABOT_AUTH=accounts/);
          expect(w.store.countLocalAccounts(), why).toBe(before);
          expect(w.store.localAccount('acct-half-made'), why).toBeTruthy();
          expect(w.env(), why).not.toContain('HATCHABOT_AUTH');
        } finally { w.restore(); }
      }
    });
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
