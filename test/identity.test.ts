import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { IdentityVerifier, IdentityError, IdentityUnavailableError, principalFor } from '../src/api/identity.js';
import { installErrorHandler } from '../src/api/errorHandler.js';
import { _resetLoginThrottle, registerAuth } from '../src/api/auth.js';
import { publicApp } from './helpers/publicApp.js';
import { principalOf } from '../src/api/principal.js';

const PROJECT = 'hatchabot-504222';
const NOW = 1_800_000_000_000; // fixed clock

// A self-signed cert stands in for Google's published securetoken cert.
function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, publicKey };
}

const KEYS = keypair();
const OTHER = keypair();

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeToken(
  claims: Record<string, unknown> = {},
  opts: { kid?: string; key?: ReturnType<typeof keypair>['privateKey']; alg?: string } = {},
): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'kid-1', typ: 'JWT' };
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: 'uid-abc',
    iat: Math.floor(NOW / 1000) - 60,
    exp: Math.floor(NOW / 1000) + 3600,
    email: 'owner@example.com',
    email_verified: true,
    ...claims,
  };
  const signing = `${b64(header)}.${b64(payload)}`;
  const sig = createSign('RSA-SHA256')
    .update(signing)
    .sign(opts.key ?? KEYS.privateKey)
    .toString('base64url');
  return `${signing}.${sig}`;
}

/** The verifier consumes PEM certs; public keys are PEM too, so hand it those. */
function certs(): Record<string, string> {
  return { 'kid-1': KEYS.publicKey.export({ type: 'spki', format: 'pem' }) as string };
}

const verifier = () =>
  new IdentityVerifier({
    projectId: PROJECT,
    fetchCerts: async () => certs(),
    now: () => NOW,
  });

describe('IdentityVerifier', () => {
  it('accepts a well-formed token and maps it to a principal', async () => {
    const token = await verifier().verify(makeToken());
    expect(token.sub).toBe('uid-abc');
    expect(token.email).toBe('owner@example.com');
    expect(token.emailVerified).toBe(true);

    const p = principalFor(token);
    expect(p).toMatchObject({ ownerId: 'user-uid-abc', via: 'identity', subject: 'uid-abc' });
  });

  it("rejects a token minted for another project (aud and iss are checked)", async () => {
    await expect(verifier().verify(makeToken({ aud: 'someone-elses-project' })))
      .rejects.toBeInstanceOf(IdentityError);
    await expect(
      verifier().verify(makeToken({ iss: 'https://securetoken.google.com/other' })),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it('rejects an expired token', async () => {
    await expect(verifier().verify(makeToken({ exp: Math.floor(NOW / 1000) - 1 })))
      .rejects.toBeInstanceOf(IdentityError);
  });

  it('rejects a token signed by the wrong key', async () => {
    await expect(verifier().verify(makeToken({}, { key: OTHER.privateKey })))
      .rejects.toBeInstanceOf(IdentityError);
  });

  it('rejects an unknown kid, a non-RS256 alg, and garbage', async () => {
    await expect(verifier().verify(makeToken({}, { kid: 'nope' }))).rejects.toBeInstanceOf(IdentityError);
    await expect(verifier().verify(makeToken({}, { alg: 'none' }))).rejects.toBeInstanceOf(IdentityError);
    await expect(verifier().verify('not.a.token')).rejects.toBeInstanceOf(IdentityError);
    await expect(verifier().verify('garbage')).rejects.toBeInstanceOf(IdentityError);
  });

  it('rejects a token with no subject', async () => {
    await expect(verifier().verify(makeToken({ sub: '' }))).rejects.toBeInstanceOf(IdentityError);
  });

  it('requires a project id', () => {
    expect(() => new IdentityVerifier({ projectId: '' })).toThrow(/HATCHABOT_GCP_PROJECT/);
  });

  it('two first sign-ins at once both wait for the one cert fetch (#223)', async () => {
    let calls = 0;
    let release!: (c: Record<string, string>) => void;
    const v = new IdentityVerifier({
      projectId: PROJECT,
      fetchCerts: () => { calls++; return new Promise((r) => { release = r; }); },
      now: () => NOW,
    });
    const first = v.verify(makeToken());
    const second = v.verify(makeToken({ sub: 'uid-def' }));
    await new Promise((r) => setImmediate(r));
    release(certs());
    const [a, b] = await Promise.allSettled([first, second]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    expect(calls).toBe(1);
    // The throttle still holds: a made-up kid right after makes no new request.
    await expect(v.verify(makeToken({}, { kid: 'kid-made-up' }))).rejects.toBeInstanceOf(IdentityError);
    expect(calls).toBe(1);
  });

  it('a fetch that fails is reported to everyone waiting on it (#223)', async () => {
    let fail!: (e: Error) => void;
    const v = new IdentityVerifier({ projectId: PROJECT, fetchCerts: () => new Promise((_, j) => { fail = j; }), now: () => NOW });
    const first = v.verify(makeToken());
    const second = v.verify(makeToken());
    await new Promise((r) => setImmediate(r));
    fail(new Error('offline'));
    for (const r of await Promise.allSettled([first, second])) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason.userMessage).toMatch(/Could not reach Google/);
    }
  });
});

describe('identity auth mode', () => {
  async function app() {
    const f = Fastify();
    await registerAuth(f, {
      secret: Buffer.alloc(32, 3),
      mode: 'identity',
      verifier: verifier(),
    });
    f.get('/v1/whoami', async (req) => principalOf(req));
    return f;
  }

  it('rejects unauthenticated calls but serves /v1/config', async () => {
    const f = await app();
    f.get('/v1/config', async () => ({ authMode: 'identity' }));
    expect((await f.inject({ method: 'GET', url: '/v1/whoami' })).statusCode).toBe(401);
    expect((await f.inject({ method: 'GET', url: '/v1/config' })).statusCode).toBe(200);
  });

  it('accepts a Bearer ID token and identifies the user', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${makeToken()}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ownerId: 'user-uid-abc', via: 'identity' });
  });

  it('exchanges a token for a session cookie that then authenticates', async () => {
    const f = await app();
    const login = await f.inject({
      method: 'POST',
      url: '/v1/session',
      payload: { idToken: makeToken() },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ ok: true, ownerId: 'user-uid-abc' });

    const cookie = `hatchabot_session=${login.cookies[0]!.value}`;
    const me = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ ownerId: 'user-uid-abc' });
  });

  it('on the console proxy, a bearer that is not ours does not get in the way of the cookie', async () => {
    // OpenClaw 2026.9's Control UI fetches its workspace icon, avatar and
    // config with the AGENT's gateway token as `Authorization: Bearer …`.
    // Verifying that as an ID token failed every such request before the
    // owner's cookie was looked at — 6,000 refused icon fetches in an hour
    // (2026-09-24). The cookie decides console requests; other paths still
    // judge a bearer as before.
    const f = await app();
    f.get('/v1/agents/:id/ui/*', async (req) => principalOf(req));
    const login = await f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: makeToken() } });
    const cookie = `hatchabot_session=${login.cookies[0]!.value}`;
    const icon = await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/__openclaw__/workspace-icon/x', headers: { cookie, authorization: 'Bearer gateway-token-of-the-agent' } });
    expect(icon.statusCode).toBe(200);
    expect(icon.json()).toMatchObject({ ownerId: 'user-uid-abc' });
    // No cookie: still refused (the bearer is the gateway's business, not a session).
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/__openclaw__/workspace-icon/x', headers: { authorization: 'Bearer gateway-token-of-the-agent' } })).statusCode).toBe(401);
    // Off the console, a bad bearer is refused even with a cookie, as before.
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie, authorization: 'Bearer not-an-id-token' } })).statusCode).toBe(401);
  });

  it('does not mark the session cookie secure over plain HTTP', async () => {
    // A secure cookie on an http:// origin is silently DISCARDED by the
    // browser, which turns sign-in into an infinite login loop with no error
    // anywhere. Shipped once; never again.
    const f = await app();
    const res = await f.inject({
      method: 'POST', url: '/v1/session', payload: { idToken: makeToken() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.cookies[0]!.secure).toBeFalsy();
  });

  it('marks it secure when the request arrived over HTTPS', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST', url: '/v1/session',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { idToken: makeToken() },
    });
    expect(res.cookies[0]!.secure).toBe(true);
  });

  it('refuses to mint a session from a bad token', async () => {
    const f = await app();
    const res = await f.inject({
      method: 'POST',
      url: '/v1/session',
      payload: { idToken: makeToken({ aud: 'other' }) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('adopts the local owner’s data on first identity sign-in, once', async () => {
    const store = new (await import('../src/store/store.js')).Store(
      new (await import('better-sqlite3')).default(':memory:'),
    );
    store.insertHost({
      id: 'h1', ownerId: 'dev-owner', kind: 'local', provider: 'mock', name: 'box',
      settings: {}, createdAt: 'now',
    });
    store.insertAgent({
      id: 'a1', ownerId: 'dev-owner', name: 'Mine', slug: 'mine', state: 'RUNNING',
      aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true,
      createdAt: 'now', updatedAt: 'now',
    });
    store.insertMembership({
      id: 'm1', agentId: 'a1', userId: 'dev-owner', role: 'owner', status: 'active',
    });

    const f = Fastify();
    await registerAuth(f, {
      secret: Buffer.alloc(32, 3),
      mode: 'identity',
      verifier: verifier(),
      onAuthenticated: (p) => { store.adoptLocalOwnerData(p.ownerId); },
    });
    await f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: makeToken() } });

    expect(store.listAgents('user-uid-abc')).toHaveLength(1);
    expect(store.listAgents('dev-owner')).toHaveLength(0);
    expect(store.getAgent('a1')!.ownerId).toBe('user-uid-abc');
    expect(store.listMemberships('a1')[0]!.userId).toBe('user-uid-abc');

    // a second, different account must NOT inherit anything
    expect(store.adoptLocalOwnerData('user-someone-else')).toBe(0);
    expect(store.getAgent('a1')!.ownerId).toBe('user-uid-abc');
  });

  it('re-keys peers too, so migration targets survive the first sign-in', async () => {
    const store = new (await import('../src/store/store.js')).Store(
      new (await import('better-sqlite3')).default(':memory:'),
    );
    store.insertHost({
      id: 'h1', ownerId: 'dev-owner', kind: 'local', provider: 'mock', name: 'box',
      settings: {}, createdAt: 'now',
    });
    store.insertPeer({
      id: 'peer1', ownerId: 'dev-owner', name: 'Laptop', url: 'http://laptop:8080',
      secretRef: 'peer/x', createdAt: 'now',
    });
    expect(store.adoptLocalOwnerData('user-real')).toBeGreaterThan(0);
    // Without the peers re-key, listPeers(newOwner) came back empty and every
    // configured migration target silently vanished.
    expect(store.listPeers('user-real').map((p) => p.id)).toContain('peer1');
    expect(store.listPeers('dev-owner')).toHaveLength(0);
  });

  it('rejects a forged session cookie', async () => {
    const f = await app();
    const forged = `${Buffer.from('uid-abc:9999999999999').toString('base64url')}.deadbeef`;
    const res = await f.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { cookie: `hatchabot_session=${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('identity verification with malformed input and slow certificates (HB-0687, HB-0688)', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); _resetLoginThrottle(); });

  const signed = (header: unknown, payload: unknown): string => {
    const material = `${b64(header)}.${b64(payload)}`;
    return `${material}.${createSign('RSA-SHA256').update(material).sign(KEYS.privateKey).toString('base64url')}`;
  };

  it('refuses non-string tokens, non-object JSON and inherited certificate names through the real session route', async () => {
    const f = Fastify();
    installErrorHandler(f);
    await registerAuth(f, { secret: Buffer.alloc(32, 3), mode: 'identity', verifier: verifier() });
    const header = { alg: 'RS256', kid: 'kid-1' };
    const payload = JSON.parse(Buffer.from(makeToken().split('.')[1]!, 'base64url').toString());
    try {
      for (const bad of [42, true, {}, [], signed(null, payload), signed([], payload), signed(header, null), signed(header, []), makeToken({}, { kid: '__proto__' }), makeToken({}, { kid: 'constructor' }), signed({ alg: 'RS256', kid: {} }, payload)]) {
        _resetLoginThrottle();
        const r = await f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: bad } });
        expect(r.statusCode, r.body).toBe(401);
        expect(r.cookies).toHaveLength(0);
      }
    } finally { await f.close(); }
  });

  it('requires the numeric dates and string identity fields before admitting a signed token', async () => {
    for (const bad of [{ exp: '1800003600' }, { iat: null }, { iat: '1800000000' }, { email: {} }, { email_verified: 'true' }, { name: [] }]) {
      await expect(verifier().verify(makeToken(bad))).rejects.toBeInstanceOf(IdentityError);
    }
  });

  it('a fresh cached key does not wait behind an unknown key refresh', async () => {
    let clock = NOW;
    let calls = 0;
    let release!: (v: Record<string, string>) => void;
    const v = new IdentityVerifier({ projectId: PROJECT, now: () => clock, fetchCerts: async () => ++calls === 1 ? certs() : new Promise((r) => { release = r; }) });
    await v.verify(makeToken());
    clock += 61_000;
    const unknown = v.verify(makeToken({}, { kid: 'unknown' })).catch((e: unknown) => e);
    await new Promise((r) => setImmediate(r));
    let knownFinished = false;
    const known = v.verify(makeToken()).then((value) => { knownFinished = true; return value; });
    try {
      await new Promise((r) => setImmediate(r));
      expect(knownFinished).toBe(true);
      expect(calls).toBe(2);
    } finally { release(certs()); }
    expect((await known).sub).toBe('uid-abc');
    expect(await unknown).toBeInstanceOf(IdentityError);
  });

  it.each(['headers', 'body'])('bounds a stalled certificate %s read and aborts it', async (where) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      if (where === 'headers') return new Promise(() => {});
      return { ok: true, json: () => new Promise(() => {}) };
    }));
    const v = new IdentityVerifier({ projectId: PROJECT, now: () => NOW });
    const outcome = v.verify(makeToken()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBeInstanceOf(IdentityUnavailableError);
    expect(signal?.aborted).toBe(true);
  });

  it('a timed-out injected fetch can retry, and its late answer cannot replace newer keys', async () => {
    vi.useFakeTimers();
    let clock = 0;
    let calls = 0;
    let release!: (v: Record<string, string>) => void;
    const v = new IdentityVerifier({ projectId: PROJECT, now: () => clock, fetchCerts: async () => ++calls === 1 ? new Promise((r) => { release = r; }) : certs() });
    const first = v.verify(makeToken()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toBeInstanceOf(IdentityUnavailableError);
    clock = NOW;
    expect((await v.verify(makeToken())).sub).toBe('uid-abc');
    release({ 'old-key': certs()['kid-1']! });
    await vi.advanceTimersByTimeAsync(1);
    expect((await v.verify(makeToken())).sub).toBe('uid-abc');
    expect(calls).toBe(2);
  });

  it('an invalid certificate response is unavailable and preserves a cached signing key', async () => {
    let clock = NOW;
    let current: unknown = certs();
    const v = new IdentityVerifier({ projectId: PROJECT, now: () => clock, fetchCerts: async () => current as Record<string, string> });
    const lasting = makeToken({ exp: Math.floor(NOW / 1000) + 4 * 3600 });
    await v.verify(lasting);
    clock += 3_600_001;
    current = null;
    expect((await v.verify(lasting)).sub).toBe('uid-abc');
    await expect(v.verify(makeToken({}, { kid: 'unknown' }))).rejects.toBeInstanceOf(IdentityUnavailableError);
  });
});

describe('a Google outage is not a failed sign-in (HB-0424)', () => {
  const LIMIT = 10;
  beforeEach(() => _resetLoginThrottle());
  afterEach(() => _resetLoginThrottle());

  /** A verifier whose fetch of Google's keys fails while `outage.on`, and a clock to move past its once-a-minute limit. */
  const flaky = () => {
    const outage = { on: true, clock: NOW };
    const v = new IdentityVerifier({ projectId: PROJECT, now: () => outage.clock, fetchCerts: async () => { if (outage.on) throw new Error('offline'); return certs(); } });
    return { v, outage };
  };
  const session = (f: FastifyInstance, idToken: string) => f.inject({ method: 'POST', url: '/v1/session', payload: { idToken } });
  const appWith = async (verifierNow: IdentityVerifier) => {
    const f = Fastify();
    await registerAuth(f, { secret: Buffer.alloc(32, 3), mode: 'identity', verifier: verifierNow });
    return f;
  };

  it('retries during an outage are told so, are not counted, and a good token works when Google is back', async () => {
    const { v, outage } = flaky();
    const f = await appWith(v);
    // More than the limit, both on fresh fetches and inside the once-a-minute limit on them.
    for (let i = 0; i < LIMIT * 3; i++) {
      if (i % 3 === 0) outage.clock += 61_000;
      const r = await session(f, makeToken());
      expect(r.statusCode, `try ${i}`).toBe(503);
      expect(r.json().error).toMatch(/Could not reach Google/);
      expect(r.headers['retry-after']).toBe('60');
    }
    outage.on = false;
    outage.clock += 61_000;
    const back = await session(f, makeToken());
    expect(back.statusCode, back.body).toBe(200);
  });

  it('what was checked and refused still counts: a bad token, and a key Google does not have', async () => {
    const { v, outage } = flaky();
    outage.on = false;
    const f = await appWith(v);
    expect((await session(f, makeToken())).statusCode).toBe(200); // the keys are in
    for (let i = 0; i < LIMIT; i++) {
      const r = await session(f, i % 2 ? makeToken({}, { kid: 'kid-made-up' }) : 'not.a.token');
      expect(r.statusCode, `try ${i}`).toBe(401);
    }
    expect((await session(f, makeToken())).statusCode).toBe(429);
  });

  it('during an outage a malformed token still counts, and known keys keep working', async () => {
    const { v, outage } = flaky();
    const lasting = makeToken({ exp: Math.floor(NOW / 1000) + 4 * 3600 });
    outage.on = false;
    const f = await appWith(v);
    expect((await session(f, lasting)).statusCode).toBe(200);
    outage.on = true;
    outage.clock += 3_600_000 + 61_000; // the cache has aged out, and the fetch fails
    expect((await session(f, lasting)).statusCode).toBe(200);
    // A key never seen cannot be checked now: reported, not counted.
    expect((await session(f, makeToken({ exp: Math.floor(NOW / 1000) + 4 * 3600 }, { kid: 'kid-made-up' }))).statusCode).toBe(503);
    expect((await session(f, 'not.a.token')).statusCode).toBe(401);
    for (let i = 1; i < LIMIT; i++) await session(f, 'not.a.token');
    expect((await session(f, lasting)).statusCode).toBe(429);
  });

  it('at the public address an outage neither locks the address nor goes on the record as a burst', async () => {
    const { v, outage } = flaky();
    const h = await publicApp({ mode: 'identity', verifier: v });
    try {
      // The machine's owner with an authenticator app, so that the address is serving; uid-abc is someone it knows.
      h.store.insertHost({ id: 'h', ownerId: 'user-owner', kind: 'local', provider: 'mock', name: 'm', settings: {}, createdAt: 'now' });
      h.store.recordAccount('user-owner', 'made-up-owner@example.com');
      h.store.insertSecondFactor({ id: 'f', ownerId: 'user-owner', kind: 'totp', data: 'sealed' });
      h.store.recordAccount('user-uid-abc');
      await h.app.publicAccess!.evaluate();
      expect(h.app.publicAccess!.status().failing).toEqual([]);
      for (let i = 0; i < LIMIT * 2; i++) {
        if (i % 3 === 0) outage.clock += 61_000;
        const r = await h.pub('/v1/session', { body: { idToken: makeToken() } });
        expect([r.status, r.json.error], `try ${i}`).toEqual([503, 'Could not reach Google to verify your login.']);
      }
      expect(h.store.listSecurityLog().filter((e) => /burst|lock/i.test(e.kind))).toEqual([]);
      outage.on = false;
      outage.clock += 61_000;
      const back = await h.pub('/v1/session', { body: { idToken: makeToken() } });
      expect(back.status, JSON.stringify(back.json)).toBe(200);
    } finally { h.app.server.closeAllConnections(); await h.close(); }
  }, 60_000);
});
