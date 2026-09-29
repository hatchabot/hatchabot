import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { _resetLoginThrottle, registerAuth, sessionTtlMs } from '../src/api/auth.js';
import { principalOf } from '../src/api/principal.js';
import { Store } from '../src/store/store.js';
import { computePosture } from '../src/orchestrator/posture.js';
import { redactUrlForLog } from '../src/api/requestLog.js';
import { opsDoorTools, opsToolsFingerprint } from '../src/ops/opsTools.js';
import { MANIFEST } from '../src/mgmt/tools.js';

// Review, 2026-09-29: sign-in, the accounts list, request logs, and the
// management agent's restart key.

const SECRET = Buffer.alloc(32, 7);
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }) => {
  const c = res.cookies.find((x) => x.name === 'hatchabot_session');
  return c ? `hatchabot_session=${c.value}` : '';
};

async function identityApp(token: Record<string, unknown>) {
  const store = new Store(new Database(':memory:'));
  const verifier = { verify: async () => ({ sub: 'g-someone', email: 'someone@example.com', expMs: Date.now() + 3_600_000, ...token }) };
  const f = Fastify();
  await registerAuth(f, { secret: SECRET, mode: 'identity', store, verifier: verifier as never, cliTokenOwner: () => undefined });
  f.get('/v1/whoami', async (req) => principalOf(req));
  return f;
}

beforeEach(() => _resetLoginThrottle());
afterEach(() => { delete process.env.HATCHABOT_ALLOWED_EMAILS; delete process.env.HATCHABOT_SESSION_DAYS; });

describe('Google sign-in', () => {
  it('an unverified email gets its 401 and no session cookie', async () => {
    process.env.HATCHABOT_ALLOWED_EMAILS = 'someone@example.com';
    const f = await identityApp({ emailVerified: false });
    const s = await f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'x' } });
    expect(s.statusCode).toBe(401);
    expect(s.headers['set-cookie']).toBeUndefined();
  });

  it('a session cookie carries the signed-in email to the principal', async () => {
    const f = await identityApp({ emailVerified: true });
    const s = await f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'x' } });
    expect(s.statusCode).toBe(200);
    const cookie = cookieOf(s);
    const me = await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } });
    expect(me.json()).toMatchObject({ ownerId: 'user-g-someone', email: 'someone@example.com' });
    expect((f as any).principalFromCookieHeader(cookie)?.email).toBe('someone@example.com');
  });

  it('an empty or mistyped HATCHABOT_SESSION_DAYS still gives a 14-day session', async () => {
    const day = 24 * 3600 * 1000;
    expect(sessionTtlMs(undefined)).toBe(14 * day);
    expect(sessionTtlMs('')).toBe(14 * day);
    expect(sessionTtlMs('two weeks')).toBe(14 * day);
    expect(sessionTtlMs('0')).toBe(14 * day);
    expect(sessionTtlMs('3')).toBe(3 * day);
    process.env.HATCHABOT_SESSION_DAYS = '';
    const f = await identityApp({ emailVerified: true });
    const s = await f.inject({ method: 'POST', url: '/v1/session', payload: { idToken: 'x' } });
    const maxAge = Number(/Max-Age=(\d+)/i.exec(String(s.headers['set-cookie']))?.[1]);
    expect(maxAge).toBeGreaterThan(13 * 24 * 3600);
    expect((await f.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: cookieOf(s) } })).statusCode).toBe(200);
  });
});

describe('security posture: identity mode with no allowlist', () => {
  const store = () => {
    const s = new Store(new Database(':memory:'));
    s.insertHost({ id: 'h1', ownerId: 'user-a', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    return s;
  };
  it('is critical when anyone can sign in, ok once a list is set, absent in other modes', () => {
    const check = (mode: 'identity' | 'accounts') =>
      computePosture(store(), { ownerId: 'user-a', isHostOwner: true, authMode: mode }).install.find((c) => c.key === 'allowed-emails');
    expect(check('identity')?.level).toBe('critical');
    process.env.HATCHABOT_ALLOWED_EMAILS = 'a@example.com, b@example.com';
    expect(check('identity')).toMatchObject({ level: 'ok', title: 'Google sign-in limited to 2 addresses' });
    expect(check('accounts')).toBeUndefined();
  });
});

describe('GET /v1/accounts', () => {
  it('lists everyone to the machine owner, and only related accounts to a member', async () => {
    const { registerRoutes } = await import('../src/api/routes.js');
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'user-owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.recordAccount('user-owner', 'owner@example.com');
    store.recordAccount('user-member', 'member@example.com');
    store.recordAccount('user-friend', 'friend@example.com');
    store.recordAccount('user-stranger', 'stranger@example.com');
    store.insertShare({ id: 's1', fromOwner: 'user-friend', fromEmail: 'friend@example.com', toEmail: 'member@example.com', toOwner: 'user-member', agentName: 'Cook', blob: Buffer.from('{}'), createdAt: 'now' });
    const f = Fastify();
    await registerRoutes(f, {
      store,
      secrets: { async put() {}, async get() { return ''; }, async delete() {} } as never,
      providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 } } as never,
    } as never);
    const list = async (owner: string) =>
      ((await f.inject({ method: 'GET', url: '/v1/accounts', headers: { 'x-hatchabot-owner': owner } })).json().accounts as Array<{ email: string }>)
        .map((a) => a.email).sort();
    expect(await list('user-owner')).toEqual(['friend@example.com', 'member@example.com', 'stranger@example.com']);
    expect(await list('user-member')).toEqual(['friend@example.com', 'owner@example.com']);
    expect(await list('user-stranger')).toEqual(['owner@example.com']);
  });
});

describe('request log', () => {
  it('never carries a query string or an invitation code', () => {
    const ticket = ['v1', 'eyJhbGciOiJIUzI1NiJ9', 'e30', 'c2lnbmF0dXJl'].join('.');
    expect(redactUrlForLog(`/v1/agents/a1/ui/__openclaw__/assistant-media?mediaTicket=${ticket}`))
      .toBe('/v1/agents/a1/ui/__openclaw__/assistant-media?…');
    expect(redactUrlForLog('/join/made-up-code')).toBe('/join/…');
    expect(redactUrlForLog('/v1/invites/made-up-code')).toBe('/v1/invites/…');
    expect(redactUrlForLog('/v1/agents')).toBe('/v1/agents');
    expect(redactUrlForLog(undefined)).toBe('');
  });
});

describe("management agent's restart key", () => {
  it('is a hash of the list the door serves: stable, and moves when the list does', () => {
    const a = opsToolsFingerprint();
    expect(a).toMatch(/^tools:[0-9a-f]{16}$/);
    expect(opsToolsFingerprint()).toBe(a);
    const tools = opsDoorTools();
    expect(tools.some((t) => t.name === 'web_search')).toBe(true);
    // The mutate tools carry the `why` argument the door adds.
    expect(tools.some((t) => (t.inputSchema as { properties?: Record<string, unknown> }).properties?.why)).toBe(true);
    const original = tools[0]!.description;
    // Changing any tool text changes the key (restored after).
    MANIFEST[0]!.description = `${original} (changed)`;
    try { expect(opsToolsFingerprint()).not.toBe(a); } finally { MANIFEST[0]!.description = original; }
    expect(opsToolsFingerprint()).toBe(a);
  });
});
