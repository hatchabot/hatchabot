import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAuth } from '../src/api/auth.js';
import { Store } from '../src/store/store.js';

/**
 * `hatchabot accounts create`: the owner made from a terminal (S1 — a
 * machine set up by a program has no browser). Opening the database is the
 * credential, as for reset-password; the person chooses their password on a
 * one-time link, and as the owner gets a recovery code right then.
 */

function cli(db: string, ...args: string[]) {
  const r = spawnSync('npx', ['tsx', 'src/cli.ts', 'accounts', ...args], {
    encoding: 'utf8',
    env: { ...process.env, HATCHABOT_DB: db, HATCHABOT_PUBLIC_URL: 'https://box.example.com', HATCHABOT_AUTH: 'accounts' },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('accounts create', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-acct-'));
  const db = join(dir, 'hatchabot.sqlite');
  { const d = new Database(db); new Store(d); d.close(); }

  it('makes the owner first, with a link and a CLI token that work', async () => {
    expect(cli(db, 'create', 'member').err).toMatch(/Create the owner first/);
    const made = cli(db, 'create', 'owner@example.com', '--host-owner', '--cli-token', '--json');
    expect(made.code).toBe(0);
    const j = JSON.parse(made.out);
    expect(j).toMatchObject({ username: 'owner@example.com', hostOwner: true, authMode: 'accounts' });
    expect(j.claimUrl).toMatch(/^https:\/\/box\.example\.com\/\?claim=[\w-]{16,}$/);
    expect(j.cliToken).toMatch(/^hatchabot_/);
    // One day unless asked: it is for finishing the setup.
    expect(Date.parse(j.cliTokenExpiresAt) - Date.now()).toBeLessThan(25 * 3600_000);

    expect(cli(db, 'create', 'second', '--host-owner').err).toMatch(/already has its owner/);

    // The server side: the link is the owner's first visit, and yields a recovery code.
    const store = new Store(new Database(db));
    const f = Fastify();
    await registerAuth(f, { secret: Buffer.alloc(32, 9), mode: 'accounts', store, cliTokenOwner: (t) => store.ownerForCliToken(t) });
    f.get('/v1/whoami', async () => ({ ok: true }));
    const code = new URL(j.claimUrl).searchParams.get('claim')!;
    expect((await f.inject({ method: 'POST', url: '/v1/login', payload: { username: 'owner@example.com', password: '' } })).statusCode).toBe(401);
    expect((await f.inject({ method: 'GET', url: `/v1/local-accounts/claim?code=${code}` })).json()).toMatchObject({ owner: true, reset: false });
    const claimed = await f.inject({ method: 'POST', url: '/v1/local-accounts/claim', payload: { code, password: 'chosen-by-the-owner' } });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().recoveryCode).toMatch(/^[A-Z0-9-]{20,}$/);
    // The token authenticates as the owner.
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { authorization: `Bearer ${j.cliToken}` } })).statusCode).toBe(200);
  }, 60_000);

  it('a member made afterwards claims without a recovery code (the owner can reset them)', async () => {
    const made = cli(db, 'create', 'member');
    expect(made.code).toBe(0);
    const code = made.out.match(/claim=([\w-]+)/)![1]!;
    const store = new Store(new Database(db));
    const f = Fastify();
    await registerAuth(f, { secret: Buffer.alloc(32, 9), mode: 'accounts', store });
    expect((await f.inject({ method: 'GET', url: `/v1/local-accounts/claim?code=${code}` })).json().owner).toBe(false);
    const claimed = await f.inject({ method: 'POST', url: '/v1/local-accounts/claim', payload: { code, password: 'chosen-by-member' } });
    expect(claimed.json().recoveryCode).toBeUndefined();
  }, 60_000);
});
