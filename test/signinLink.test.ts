import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { Writable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetLoginThrottle, registerAuth } from '../src/api/auth.js';
import { hashPassword } from '../src/api/accountsAuth.js';
import { principalOf } from '../src/api/principal.js';
import { requestLogSerializer } from '../src/api/requestLog.js';
import { readSigninKey, verifySigninToken } from '../src/api/signinLink.js';
import { Store } from '../src/store/store.js';

/**
 * One-time sign-in links (Hatchabot Cloud S5, docs/signin-links.md): the
 * provider's account page signs a short-lived link with its private key; the
 * Hatchabot holds only the public key and accepts each link once.
 */

const SCRIPT = new URL('../scripts/signin-link.mjs', import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let script: any;
const dir = mkdtempSync(join(tmpdir(), 'hb-signin-'));
const URL_HERE = 'https://maria.example.com';
const SECRET = Buffer.alloc(32, 3);
// Made-up passwords, assembled at runtime so nothing credential-shaped sits in this file.
const pw = (who: string) => [who, 'link', 'test', '9'].join('-');
let keyPrefix = '';
let privPem = '';
let pubPem = '';

beforeAll(async () => {
  script = await import(SCRIPT.href);
  keyPrefix = join(dir, `tenant-${randomUUID().slice(0, 8)}`);
  script.keygen(keyPrefix);
  privPem = readFileSync(`${keyPrefix}.key`, 'utf8');
  pubPem = readFileSync(`${keyPrefix}.pub`, 'utf8');
});

beforeEach(() => {
  _resetLoginThrottle();
  process.env.HATCHABOT_SIGNIN_KEY_FILE = `${keyPrefix}.pub`;
  process.env.HATCHABOT_PUBLIC_URL = URL_HERE;
});
afterEach(() => {
  for (const k of ['HATCHABOT_SIGNIN_KEY_FILE', 'HATCHABOT_PUBLIC_URL', 'HATCHABOT_LOGIN_FAILS_PER_WINDOW', 'HATCHABOT_MANAGED_BY',
    'HATCHABOT_SUPPORT_URL', 'HATCHABOT_ALLOWED_EMAILS', 'HATCHABOT_LOCAL_ACCOUNTS']) delete process.env[k];
});

const tok = (o: Record<string, unknown> = {}) => script.signinToken({ privateKey: privPem, url: URL_HERE, owner: !o.account, ...o });
const open = (f: FastifyInstance, t: string, headers: Record<string, string> = {}) =>
  f.inject({ method: 'GET', url: `/signin/link?t=${encodeURIComponent(t)}`, headers });
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const c = res.cookies.find((x) => x.name === 'hatchabot_session');
  return c?.value ? `hatchabot_session=${c.value}` : '';
};
const whoami = (f: FastifyInstance, cookie: string) => f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } });
const EXPIRED = /expired or was already used/;

async function accountsApp(opts: { ownerPassword?: boolean } = {}) {
  const store = new Store(new Database(':memory:'));
  const logs: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { logs.push(String(chunk)); cb(); } });
  const f = Fastify({ logger: { level: 'debug', stream, serializers: { req: requestLogSerializer as never } } });
  const mk = async (username: string, hostOwner: boolean, password?: string) => {
    const { hash, salt } = password ? await hashPassword(password) : { hash: '', salt: '' };
    const id = `acct-${randomUUID()}`;
    store.insertLocalAccount({ id, username, pwHash: hash, pwSalt: salt, hostOwner, disabled: false, createdAt: new Date().toISOString() });
    return id;
  };
  const ownerId = await mk('owner@example.com', true, opts.ownerPassword === false ? undefined : pw('owner'));
  const memberId = await mk('member@example.com', false, pw('member'));
  await registerAuth(f, { secret: SECRET, mode: 'accounts', store, cliTokenOwner: () => undefined });
  f.get('/v1/whoami', async (req) => principalOf(req));
  return { f, store, ownerId, memberId, logs };
}

describe('a sign-in link (accounts mode)', () => {
  it('signs the owner in once: a session, a 303 to / with nothing left in the URL, no-store and no-referrer', async () => {
    const { f, ownerId, store } = await accountsApp();
    const t = tok();
    const res = await open(f, t);
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const cookie = cookieOf(res);
    expect((await whoami(f, cookie)).json()).toMatchObject({ ownerId });
    // Recorded: who the link named, and when.
    expect(store.recentSigninLinks()).toEqual([expect.objectContaining({ sub: 'owner' })]);
  });

  it('a member by username (their email), case-insensitively', async () => {
    const { f, memberId } = await accountsApp();
    const res = await open(f, tok({ account: 'Member@Example.com' }));
    expect(res.statusCode).toBe(303);
    expect((await whoami(f, cookieOf(res))).json()).toMatchObject({ ownerId: memberId });
  });

  it('is refused when it has expired (a minute of clock difference allowed)', async () => {
    const { f } = await accountsApp();
    const late = await open(f, tok({ ttl: 300, now: Date.now() - 300_000 - 90_000 }));
    expect(late.statusCode).toBe(400);
    expect(late.body).toMatch(EXPIRED);
    expect(cookieOf(late)).toBe('');
    expect(late.headers['cache-control']).toBe('no-store');
    // 30 s past exp is inside the skew.
    expect((await open(f, tok({ ttl: 300, now: Date.now() - 330_000 }))).statusCode).toBe(303);
    // Issued more than a minute in the future: refused.
    expect((await open(f, tok({ now: Date.now() + 120_000 }))).statusCode).toBe(400);
  });

  it('is refused when minted for another Hatchabot', async () => {
    const { f } = await accountsApp();
    const res = await open(f, script.signinToken({ privateKey: privPem, url: 'https://sam.example.com', owner: true }));
    expect(res.statusCode).toBe(400);
    expect(cookieOf(res)).toBe('');
    // The same origin written differently is the same Hatchabot.
    expect((await open(f, script.signinToken({ privateKey: privPem, url: 'HTTPS://Maria.Example.com:443/some/page', owner: true }))).statusCode).toBe(303);
  });

  it('is refused when tampered with, or signed by another key', async () => {
    const { f } = await accountsApp();
    const t = tok();
    const [body, sig] = t.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'user:member@example.com' })).toString('base64url');
    expect((await open(f, `${forged}.${sig}`)).statusCode).toBe(400);
    const c = sig.length - 10;                                  // a character well inside the signature, changed
    const flipped = sig.slice(0, c) + (sig[c] === 'A' ? 'B' : 'A') + sig.slice(c + 1);
    expect(flipped).not.toBe(sig);
    expect((await open(f, `${body}.${flipped}`)).statusCode).toBe(400);
    const other = generateKeyPairSync('ed25519').privateKey;
    expect((await open(f, script.signinToken({ privateKey: other, url: URL_HERE, owner: true }))).statusCode).toBe(400);
    for (const junk of ['', 'x', 'a.b.c', `${body}.`, '.'.repeat(3000)]) expect((await open(f, junk)).statusCode).toBe(400);
    // The untampered one still works: none of the above spent it.
    expect((await open(f, t)).statusCode).toBe(303);
  });

  it('is refused the second time (replay), and a HEAD never spends it', async () => {
    const { f } = await accountsApp();
    const t = tok();
    expect((await f.inject({ method: 'HEAD', url: `/signin/link?t=${t}` })).statusCode).toBe(404);
    expect((await open(f, t)).statusCode).toBe(303);
    const again = await open(f, t);
    expect(again.statusCode).toBe(400);
    expect(again.body).toMatch(EXPIRED);
    expect(cookieOf(again)).toBe('');
  });

  it('a link may live at most 10 minutes', async () => {
    const { f } = await accountsApp();
    expect(() => tok({ ttl: 601 })).toThrow(/600/);
    // A hand-made token past the limit is refused by the server too.
    const k = (await import('node:crypto')).createPrivateKey(privPem);
    const now = Math.floor(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ v: 1, aud: URL_HERE, sub: 'owner', iat: now, exp: now + 3600, nonce: 'n'.repeat(22) })).toString('base64url');
    const sig = (await import('node:crypto')).sign(null, Buffer.from(`hatchabot-signin-link/v1\n${body}`), k).toString('base64url');
    expect((await open(f, `${body}.${sig}`)).statusCode).toBe(400);
    expect(verifySigninToken(`${body}.${sig}`, readSigninKeyOk(), URL_HERE)).toEqual({ ok: false, reason: 'lifetime' });
  });

  it('is refused for an account that is not here or is turned off', async () => {
    const { f, store, memberId } = await accountsApp();
    const missing = await open(f, tok({ account: 'nobody@example.com' }));
    expect(missing.statusCode).toBe(403);
    expect(missing.body).toMatch(/isn.t here|not on this Hatchabot/);
    expect(cookieOf(missing)).toBe('');
    store.setLocalAccountDisabled(memberId, true);
    expect((await open(f, tok({ account: 'member@example.com' }))).statusCode).toBe(403);
  });

  it('says where to get a new link: the provider\'s account page and support link', async () => {
    process.env.HATCHABOT_MANAGED_BY = 'Example Cloud';
    process.env.HATCHABOT_SUPPORT_URL = 'https://help.example.com/hatchabot';
    const { f } = await accountsApp();
    const res = await open(f, 'nope.nope');
    expect(res.body).toMatch(/your Example Cloud account page/);
    expect(res.body).toContain('href="https://help.example.com/hatchabot"');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('is rate-limited per client: after repeated failures even a good link waits', async () => {
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '3';
    const { f } = await accountsApp();
    const from = { 'x-forwarded-for': '203.0.113.7' };
    for (let i = 0; i < 3; i++) expect((await open(f, 'bad.token', from)).statusCode).toBe(400);
    const good = tok();
    const held = await open(f, good, from);
    expect(held.statusCode).toBe(429);
    expect(cookieOf(held)).toBe('');
    // Another client is not affected, and the held link was not spent.
    expect((await open(f, good, { 'x-forwarded-for': '203.0.113.8' })).statusCode).toBe(303);
  });

  it('writes no token and no key to the log, and records the sign-in there', async () => {
    const { f, logs } = await accountsApp();
    const t = tok();
    await open(f, t);
    await open(f, t);                                  // replay
    await open(f, `${t.split('.')[0]}.${'A'.repeat(86)}`); // bad signature
    await open(f, tok({ account: 'nobody@example.com' }));
    const all = logs.join('');
    expect(all).toContain('account.signed_in_by_link');
    expect(all).toContain('signin_link.refused');
    const pemBody = (pem: string) => pem.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
    for (const secret of [t, t.split('.')[0], t.split('.')[1], pemBody(privPem), pemBody(pubPem)]) expect(all).not.toContain(secret);
    expect(all).not.toContain('?t=');
  });

  it('turned off when no key file is set: no route at all', async () => {
    delete process.env.HATCHABOT_SIGNIN_KEY_FILE;
    const { f } = await accountsApp();
    const res = await open(f, tok());
    expect(res.statusCode).toBe(404);
    expect(cookieOf(res)).toBe('');
  });

  it('a key file that is unusable answers "not working here", and never signs anyone in', async () => {
    process.env.HATCHABOT_SIGNIN_KEY_FILE = join(dir, 'missing.pub');
    const { f, logs } = await accountsApp();
    const res = await open(f, tok());
    expect(res.statusCode).toBe(503);
    expect(cookieOf(res)).toBe('');
    expect(logs.join('')).toContain('signin_link.key_unusable');
  });
});

describe('the first visit to a fresh managed Hatchabot (the claim)', () => {
  it('a link for an owner with no password yet opens the password chooser, and the printed claim link stops working', async () => {
    const { f, store, ownerId } = await accountsApp({ ownerPassword: false });
    const printed = 'printed-claim-code-' + randomUUID().slice(0, 8);
    store.setLocalAccountClaim(ownerId, printed, new Date(Date.now() + 48 * 3600_000).toISOString());
    const res = await open(f, tok());
    expect(res.statusCode).toBe(303);
    const loc = new URL(res.headers.location as string, URL_HERE);
    expect(loc.pathname).toBe('/');
    const code = loc.searchParams.get('claim')!;
    expect(code).toMatch(/^[\w-]{20,}$/);
    expect(code).not.toBe(printed);
    expect(cookieOf(res)).toBe('');                          // no session until a password is chosen
    expect((await f.inject({ method: 'GET', url: `/v1/local-accounts/claim?code=${printed}` })).statusCode).toBe(404);
    expect((await f.inject({ method: 'GET', url: `/v1/local-accounts/claim?code=${code}` })).json()).toMatchObject({ owner: true, reset: false });
    // Good for minutes, not days.
    expect(Date.parse(store.localAccount(ownerId)!.claimExpires!) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    const claimed = await f.inject({ method: 'POST', url: '/v1/local-accounts/claim', payload: { code, password: pw('chosen') } });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().recoveryCode).toBeTruthy();
    expect((await whoami(f, cookieOf(claimed))).json()).toMatchObject({ ownerId });
    // From now on a link signs straight in.
    expect((await open(f, tok())).headers.location).toBe('/');
  });
});

describe('password mode', () => {
  async function passwordApp(password: string | undefined) {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    await registerAuth(f, { secret: SECRET, mode: 'password', password, store });
    f.get('/v1/whoami', async (req) => principalOf(req));
    return f;
  }
  it('"owner" is the one person: a password session; any named account is refused', async () => {
    const f = await passwordApp(pw('house'));
    const res = await open(f, tok());
    expect(res.statusCode).toBe(303);
    expect((await whoami(f, cookieOf(res))).statusCode).toBe(200);
    expect((await whoami(f, '')).statusCode).toBe(401);
    expect((await open(f, tok({ account: 'someone@example.com' }))).statusCode).toBe(403);
  });
});

describe('identity mode', () => {
  async function identityApp() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'host-local', ownerId: 'user-g-owner-1', kind: 'local', provider: 'local-docker', name: 'this machine', settings: {}, createdAt: new Date().toISOString() } as never);
    store.recordAccount('user-g-owner-1', 'boss@example.com');
    store.recordAccount('user-g-kid-2', 'kid@example.com');
    const verifier = { verify: async () => { throw new Error('not used'); } };
    const f = Fastify();
    await registerAuth(f, { secret: SECRET, mode: 'identity', store, verifier: verifier as never, cliTokenOwner: () => undefined });
    f.get('/v1/whoami', async (req) => principalOf(req));
    return { f, store };
  }
  it('signs in the machine\'s Google owner, or a Google account by its recorded email', async () => {
    const { f } = await identityApp();
    const owner = await open(f, tok());
    expect(owner.statusCode).toBe(303);
    expect((await whoami(f, cookieOf(owner))).json()).toMatchObject({ ownerId: 'user-g-owner-1', email: 'boss@example.com' });
    const kid = await open(f, tok({ account: 'KID@example.com' }));
    expect((await whoami(f, cookieOf(kid))).json()).toMatchObject({ ownerId: 'user-g-kid-2' });
    // Someone who never signed in here has no account to sign in to.
    expect((await open(f, tok({ account: 'stranger@example.com' }))).statusCode).toBe(403);
  });
  it('answers to the allowed-emails list', async () => {
    process.env.HATCHABOT_ALLOWED_EMAILS = 'boss@example.com';
    const { f } = await identityApp();
    expect((await open(f, tok())).statusCode).toBe(303);
    expect((await open(f, tok({ account: 'kid@example.com' }))).statusCode).toBe(403);
  });
});

describe('the key file and the reference signer', () => {
  it('the server takes only an Ed25519 public key that only its owner may write', () => {
    expect('key' in readSigninKey(`${keyPrefix}.pub`)).toBe(true);
    const priv = readSigninKey(`${keyPrefix}.key`);
    expect('problem' in priv && priv.problem).toMatch(/PRIVATE key/);
    expect(JSON.stringify(priv)).not.toContain(privPem.split('\n')[1]!);
    const loose = join(dir, 'loose.pub');
    writeFileSync(loose, pubPem);
    chmodSync(loose, 0o666);
    expect('problem' in readSigninKey(loose) && (readSigninKey(loose) as { problem: string }).problem).toMatch(/written by others/);
    const rsa = join(dir, 'rsa.pub');
    writeFileSync(rsa, generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o600 });
    expect((readSigninKey(rsa) as { problem: string }).problem).toMatch(/Ed25519/);
  });

  it('keygen writes both halves mode 600 and never overwrites; sign prints a link the server accepts', () => {
    const prefix = join(dir, 'cli-tenant');
    const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT.pathname, ...args], { encoding: 'utf8' });
    const made = run('keygen', prefix);
    expect(made.status).toBe(0);
    expect(made.stdout).not.toContain('BEGIN');                      // no key material printed
    expect(statSync(`${prefix}.key`).mode & 0o777).toBe(0o600);
    expect(statSync(`${prefix}.pub`).mode & 0o777).toBe(0o600);
    expect(run('keygen', prefix).status).toBe(1);
    const signed = run('sign', '--key', `${prefix}.key`, '--url', `${URL_HERE}/`, '--account', 'member@example.com', '--ttl', '120');
    expect(signed.status).toBe(0);
    const link = new URL(signed.stdout.trim());
    expect(link.origin + link.pathname).toBe(`${URL_HERE}/signin/link`);
    const key = (readSigninKey(`${prefix}.pub`) as { key: never }).key;
    const v = verifySigninToken(link.searchParams.get('t')!, key, URL_HERE);
    expect(v.ok && v.claims).toMatchObject({ v: 1, aud: URL_HERE, sub: 'user:member@example.com' });
    expect(v.ok && v.claims.exp - v.claims.iat).toBe(120);
    expect(run('sign', '--key', `${prefix}.key`).status).toBe(2);
  });
});

function readSigninKeyOk() {
  const r = readSigninKey(`${keyPrefix}.pub`);
  if (!('key' in r)) throw new Error(r.problem);
  return r.key;
}
