/**
 * A session cookie whose signature has the right number of characters but not
 * the right number of bytes (64 accented letters: 64 characters, 128 bytes)
 * was compared by character count, then handed to timingSafeEqual, which
 * throws on a length mismatch: the request got a 500 instead of a 401
 * (HB-0602, deep audit of v2.177.0). Every sign-in mode reads such a cookie as
 * no session at all.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { _resetLoginThrottle, registerAuth } from '../src/api/auth.js';
import { principalOf } from '../src/api/principal.js';
import { safeEqual } from '../src/util/safeEqual.js';
import { Store } from '../src/store/store.js';

const SECRET = Buffer.alloc(32, 3);
// Made up, assembled here so no credential-shaped literal sits in this file.
const PASSWORD = ['sample', 'owner', 'pw'].join('-');
/** 64 characters, more than 64 bytes: the length of a hex SHA-256, but not its size. */
const WIDE = 'é'.repeat(64);
const cookie = (value: string) => `hatchabot_session=${encodeURIComponent(value)}`;
const whoami = (f: any, c: string) => f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: c } });

beforeEach(() => _resetLoginThrottle());

describe('a malformed session signature is "not signed in", never a 500', () => {
  it('accounts mode', async () => {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    await registerAuth(f, { secret: SECRET, mode: 'accounts', store });
    f.get('/v1/whoami', async (req) => principalOf(req));
    const boot = await f.inject({ method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'sample-owner', password: PASSWORD } });
    expect(boot.statusCode).toBe(201);
    const res = await whoami(f, cookie(`${boot.json().id}:${Date.now() + 60_000}.${WIDE}`));
    expect(res.statusCode).toBe(401);
    await f.close();
  });

  it('password mode', async () => {
    const f = Fastify();
    await registerAuth(f, { password: PASSWORD, secret: SECRET, mode: 'password' });
    f.get('/v1/whoami', async (req) => principalOf(req));
    const res = await whoami(f, cookie(`${Date.now() + 60_000}.${WIDE}`));
    expect(res.statusCode).toBe(401);
    await f.close();
  });

  it('identity mode', async () => {
    const store = new Store(new Database(':memory:'));
    // Nobody signs in here: the cookie below is made by hand.
    const verifier = { verify: async () => { throw new Error('not used'); } };
    const f = Fastify();
    await registerAuth(f, { secret: SECRET, mode: 'identity', store, verifier: verifier as never, cliTokenOwner: () => undefined });
    f.get('/v1/whoami', async (req) => principalOf(req));
    const payload = Buffer.from(`g-sample-1:${Date.now() + 60_000}:e0`).toString('base64url');
    const res = await whoami(f, cookie(`${payload}.${WIDE}`));
    expect(res.statusCode).toBe(401);
    await f.close();
  });

  it('the comparison itself (safeEqual): bytes, not characters; strings or bytes', () => {
    const hex = 'a'.repeat(64);
    expect(safeEqual(hex, hex)).toBe(true);
    expect(safeEqual(WIDE, hex)).toBe(false);
    expect(safeEqual(hex, WIDE)).toBe(false);
    expect(safeEqual('a'.repeat(63), hex)).toBe(false);
    expect(safeEqual('', hex)).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual(`${'a'.repeat(63)}b`, hex)).toBe(false);
    expect(safeEqual(Buffer.from(hex), hex)).toBe(true);
    expect(safeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2, 3]))).toBe(true);
    expect(safeEqual(Buffer.from([1, 2, 3]), Buffer.from([1, 2]))).toBe(false);
    expect(safeEqual(new Uint16Array([1]), Buffer.from([1, 0]))).toBe(true); // bytes, whatever the view
  });

  it('safeEqual: anything that is not a string or bytes is never equal, and never throws', () => {
    const three = 'abc';
    for (const odd of [['a', 'b', 'c'], { length: 3 }, 3, null, undefined, true, {}]) {
      expect(safeEqual(odd, three)).toBe(false);
      expect(safeEqual(three, odd)).toBe(false);
      expect(safeEqual(odd, odd)).toBe(false);
    }
  });
});

describe('a sign-in password that is not a string is a wrong password, never a 500', () => {
  it('password mode /v1/login: an array or object of the right length, a number, null', async () => {
    const f = Fastify();
    await registerAuth(f, { password: PASSWORD, secret: SECRET, mode: 'password' });
    for (const password of [PASSWORD.split(''), { length: PASSWORD.length }, 42, null]) {
      _resetLoginThrottle();
      const res = await f.inject({ method: 'POST', url: '/v1/login', payload: { password } });
      expect(res.statusCode, JSON.stringify(password)).toBe(401);
    }
    _resetLoginThrottle();
    expect((await f.inject({ method: 'POST', url: '/v1/login', payload: { password: PASSWORD } })).statusCode).toBe(200);
    await f.close();
  });
});
