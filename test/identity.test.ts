import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';
import Fastify from 'fastify';
import { IdentityVerifier, IdentityError, principalFor } from '../src/api/identity.js';
import { registerAuth } from '../src/api/auth.js';
import { principalOf } from '../src/api/principal.js';

const PROJECT = 'agentclaw-504222';
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
    expect(() => new IdentityVerifier({ projectId: '' })).toThrow(/AGENTCLAW_GCP_PROJECT/);
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

    const cookie = `agentclaw_session=${login.cookies[0]!.value}`;
    const me = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ ownerId: 'user-uid-abc' });
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

  it('rejects a forged session cookie', async () => {
    const f = await app();
    const forged = `${Buffer.from('uid-abc:9999999999999').toString('base64url')}.deadbeef`;
    const res = await f.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { cookie: `agentclaw_session=${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
