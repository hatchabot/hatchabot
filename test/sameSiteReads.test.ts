import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetLoginThrottle, registerAuth } from '../src/api/auth.js';
import { hashPassword } from '../src/api/accountsAuth.js';
import { foreignRead } from '../src/api/requestOrigin.js';
import { registerRoutes } from '../src/api/routes.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { MemSecrets, seedRunningAgent, type World } from './support/world.js';

/**
 * GETs from a neighbouring tenant's page (2026-10-01).
 *
 * On a hosted Hatchabot every tenant is <name>.my.hatchabot.com, the SAME site
 * as every other until that suffix is on the Public Suffix List, so a
 * neighbour's <img>, <a>, top-level navigation or no-cors fetch carries this
 * tenant's SameSite=Strict session cookie. requestOrigin.ts already refused
 * foreign writes; these are the reads that were not reads:
 *
 *  - GET /v1/agents/:id/backup STOPS a running agent (an export quiesces it
 *    and leaves it stopped) and holds it busy while the volume is tarred;
 *  - GET (any path) under /v1/agents/:id/ui/ wakes a sleeping agent and
 *    reaches its OpenClaw gateway as the owner, whatever that gateway does
 *    on a GET; the proxy also relayed the gateway's CORS headers;
 *  - GET /signin/link with junk charged the visitor's address with a sign-in
 *    failure, the same bucket the password form counts: ten <img> tags locked
 *    the owner out of signing in for 15 minutes (no cookie needed at all);
 *  - the Google consent's browser-binding cookie had a plain name, so a
 *    neighbour could plant it (Domain=.my.hatchabot.com) and finish another
 *    person's consent into the planter's vault;
 *  - and every other GET: docker execs per agent (/v1/users, /v1/pending), a
 *    live Telegram call per bot (/v1/bot-inventory), a volume tar
 *    (/v1/agents/:id/export) — a neighbour's page could loop them.
 *
 * So a browser request that says it came from another site is refused on
 * every path except the pages people are sent to by links (as page visits),
 * and a few static, public files.
 */

const SECRET = Buffer.alloc(32, 9);
const pw = (who: string) => [who, 'reads', 'test', '7'].join('-'); // made up, assembled at runtime
const HOST = 'maria.my.example.net';
const NEIGHBOUR_IMG = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' };
const NEIGHBOUR_NAV = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
const NEIGHBOUR_FETCH = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: 'https://evil.my.example.net' };
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };
const ENV = ['HATCHABOT_SIGNIN_KEY_FILE', 'HATCHABOT_PUBLIC_URL', 'HATCHABOT_LOGIN_FAILS_PER_WINDOW'];

let toClose: Array<FastifyInstance | Server> = [];
beforeEach(() => _resetLoginThrottle());
afterEach(() => {
  for (const k of ENV) delete process.env[k];
  for (const s of toClose) {
    const raw: any = (s as any).server ?? s;
    try { raw.closeAllConnections?.(); raw.close?.(() => {}); raw.unref?.(); } catch { /* gone */ }
  }
  toClose = [];
});

/** A real installation: accounts sign-in, the real routes, a mock runtime; the owner signed in. */
async function signedInWorld(opts: { oauthFetch?: typeof fetch } = {}) {
  const db = new Database(':memory:');
  const store = new Store(db);
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  const ownerId = `acct-${randomUUID()}`;
  const { hash, salt } = await hashPassword(pw('owner'));
  store.insertLocalAccount({ id: ownerId, username: 'owner', pwHash: hash, pwSalt: salt, hostOwner: true, disabled: false, createdAt: new Date().toISOString() });
  const memberId = `acct-${randomUUID()}`;
  const m = await hashPassword(pw('member'));
  store.insertLocalAccount({ id: memberId, username: 'member', pwHash: m.hash, pwSalt: m.salt, hostOwner: false, disabled: false, createdAt: new Date().toISOString() });
  store.insertHost({ id: 'h1', ownerId, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'sk-test');
  const f = Fastify();
  const gets: string[] = [];
  f.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (methods.includes('GET')) gets.push(r.url);
  });
  await registerAuth(f, { secret: SECRET, mode: 'accounts', store, cliTokenOwner: () => undefined });
  const channel = { kind: 'telegram', pool: { availableCount: () => 0, owns: () => false, list: () => [] }, release: async () => {}, discardPending: () => {} } as any;
  const oauthFetch = opts.oauthFetch ?? ((async () => new Response('{"ok":true,"result":[]}', { headers: { 'content-type': 'application/json' } })) as typeof fetch);
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel, oauthFetch });
  const world: World = { store, secrets, provider, providers: new Map([['mock', provider]]), f, owner: ownerId, channel };
  await seedRunningAgent(world);
  const signIn = async (who: string, headers: Record<string, string> = {}) => {
    const res = await f.inject({ method: 'POST', url: '/v1/login', headers, payload: { username: who, password: pw(who) } });
    expect(res.statusCode).toBe(200);
    return res.cookies.filter((c) => c.value).map((c) => `${c.name}=${c.value}`).join('; ');
  };
  const cookie = await signIn('owner');
  return { f, db, store, provider, ownerId, memberId, cookie, gets, signIn };
}

describe('which browser reads are refused (foreignRead)', () => {
  const r = (method: string, path: string, headers: Record<string, string>) => foreignRead(method, path, headers);
  it('the app\'s own page, a typed address, and a non-browser caller are never refused', () => {
    for (const h of [SAME_ORIGIN, { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }, {}]) {
      expect(r('GET', '/v1/agents/a1/backup', h)).toBeUndefined();
      expect(r('HEAD', '/v1/users', h)).toBeUndefined();
    }
  });
  it('from another site — a neighbouring tenant is the same SITE — every API read is refused, as an image, a fetch or a page visit', () => {
    for (const h of [NEIGHBOUR_IMG, NEIGHBOUR_NAV, NEIGHBOUR_FETCH, { 'sec-fetch-site': 'cross-site' }]) {
      expect(r('GET', '/v1/agents/a1/backup', h)).toMatch(/sec-fetch-site/);
      expect(r('HEAD', '/v1/agents/a1/backup', h)).toMatch(/sec-fetch-site/);
      expect(r('GET', '/v1/agents/a1/ui/', h)).toMatch(/sec-fetch-site/);
      expect(r('GET', '/v1/config', h)).toMatch(/sec-fetch-site/);
    }
  });
  it('the pages people are sent to by links still open from anywhere — as page visits only', () => {
    for (const p of ['/', '/join/ABC123', '/signin/link', '/v1/connections/google/callback', '/privacy', '/terms']) {
      expect(r('GET', p, NEIGHBOUR_NAV)).toBeUndefined();
      expect(r('GET', p, { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' })).toBeUndefined();
      // An <img> or <iframe> of the same address is not someone visiting it.
      expect(r('GET', p, NEIGHBOUR_IMG)).toMatch(/not a page visit/);
      expect(r('GET', p, { ...NEIGHBOUR_NAV, 'sec-fetch-dest': 'iframe' })).toMatch(/not a page visit/);
    }
    // Nothing that merely starts like one.
    expect(r('GET', '/join/ABC/../../v1/users', NEIGHBOUR_NAV)).toMatch(/sec-fetch-site/);
    expect(r('GET', '/signin/linkx', NEIGHBOUR_NAV)).toMatch(/sec-fetch-site/);
  });
  it('static public files (no data, no side effect) are fine from anywhere', () => {
    for (const p of ['/healthz', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/app-qr.svg']) {
      expect(r('GET', p, NEIGHBOUR_IMG)).toBeUndefined();
    }
  });
});

describe('a neighbour\'s page and the owner\'s cookie', () => {
  it('an <img> of /v1/agents/:id/backup no longer stops the agent (GET and HEAD); the app\'s own download still works', async () => {
    const { f, store, cookie } = await signedInWorld();
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    for (const method of ['GET', 'HEAD'] as const) {
      const res = await f.inject({ method, url: '/v1/agents/a1/backup', headers: { cookie, host: HOST, ...NEIGHBOUR_IMG } });
      expect(res.statusCode).toBe(403);
      expect(store.getAgent('a1')!.state).toBe('RUNNING');
    }
    // A top-level navigation to it (window.location / a link) is refused too.
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: { cookie, ...NEIGHBOUR_NAV } })).statusCode).toBe(403);
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    const mine = await f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: { cookie, ...SAME_ORIGIN } });
    expect(mine.statusCode).toBe(200);
    expect(store.getAgent('a1')!.state).toBe('STOPPED'); // what the owner's own Download does, by design
  });

  it('every GET route is refused from another site, except the link landings and public files', async () => {
    const { f, store, cookie, gets } = await signedInWorld();
    const exempt = new Set(['/healthz']); // the landings (/, /join, /signin/link, /privacy…) are not registered in this world, or are below
    const fill = (u: string) => u.replace(/:([A-Za-z]+)/g, (_m, p: string) => (p === 'id' ? 'a1' : 'x')).replace(/\*$/, 'x');
    let checked = 0;
    for (const route of gets) {
      const url = fill(route);
      if (exempt.has(url) || url === '/v1/connections/google/callback') continue;
      for (const headers of [NEIGHBOUR_IMG, NEIGHBOUR_FETCH]) {
        const res = await f.inject({ method: 'GET', url, headers: { cookie, ...headers } });
        expect(res.statusCode, `GET ${route}`).toBe(403);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(90); // the sweep saw the whole API, not a stub
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    // The same reads from the app's own page answer as always.
    expect((await f.inject({ method: 'GET', url: '/v1/agents', headers: { cookie, ...SAME_ORIGIN } })).statusCode).toBe(200);
    expect((await f.inject({ method: 'GET', url: '/v1/config', headers: { cookie, ...SAME_ORIGIN } })).statusCode).toBe(200);
  });

  it('the console proxy: a neighbour\'s GET never reaches the agent\'s gateway as the owner', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const gw = createServer((req, res) => {
      seen.push(req.headers);
      // A gateway that answers with permissive CORS must not hand a neighbour the response.
      res.setHeader('access-control-allow-origin', String(req.headers.origin ?? '*'));
      res.setHeader('access-control-allow-credentials', 'true');
      res.setHeader('timing-allow-origin', '*');
      res.end('{"sessions":[]}');
    });
    await new Promise<void>((r) => gw.listen(0, '127.0.0.1', r));
    toClose.push(gw);
    const { f, db, cookie } = await signedInWorld();
    db.prepare('UPDATE agents SET gateway_port = ?, gateway_token = ? WHERE id = ?').run((gw.address() as any).port, 'gw-token', 'a1');
    for (const headers of [NEIGHBOUR_IMG, NEIGHBOUR_FETCH, NEIGHBOUR_NAV]) {
      const res = await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/api/sessions', headers: { cookie, ...headers } });
      expect(res.statusCode).toBe(403);
    }
    expect(seen).toEqual([]);
    const mine = await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/api/sessions', headers: { cookie, ...SAME_ORIGIN } });
    expect(mine.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    // Hatchabot sends no CORS headers of its own, and relays none of the gateway's.
    expect(Object.keys(mine.headers).filter((h) => /^(access-control-|timing-allow-origin)/i.test(h))).toEqual([]);
  });

  it('other methods the console proxy accepts (OPTIONS and the like) are judged like writes', async () => {
    const { f, cookie } = await signedInWorld();
    for (const method of ['OPTIONS', 'PATCH'] as const) {
      expect((await f.inject({ method, url: '/v1/agents/a1/ui/x', headers: { cookie, ...NEIGHBOUR_FETCH } })).statusCode).toBe(403);
    }
  });
});

describe('the sign-in link and the password form do not share a lock-out', () => {
  let keyFile = '';
  beforeAll(async () => {
    const script: any = await import(new URL('../scripts/signin-link.mjs', import.meta.url).href);
    const prefix = join(mkdtempSync(join(tmpdir(), 'hb-reads-')), `t-${randomUUID().slice(0, 8)}`);
    script.keygen(prefix);
    keyFile = `${prefix}.pub`;
  });

  it('a neighbour\'s <img> tags with junk links are refused uncounted, and junk link visits never lock out the password form', async () => {
    process.env.HATCHABOT_SIGNIN_KEY_FILE = keyFile;
    process.env.HATCHABOT_PUBLIC_URL = `https://${HOST}`;
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '3';
    const { f, signIn } = await signedInWorld();
    for (let i = 0; i < 6; i++) {
      const img = await f.inject({ method: 'GET', url: `/signin/link?t=junk${i}`, headers: NEIGHBOUR_IMG });
      expect(img.statusCode).toBe(403);
    }
    // Page visits with junk (a popup the neighbour keeps navigating) count — against links only.
    for (let i = 0; i < 6; i++) await f.inject({ method: 'GET', url: `/signin/link?t=junk${i}`, headers: NEIGHBOUR_NAV });
    expect((await f.inject({ method: 'GET', url: '/signin/link?t=junk', headers: NEIGHBOUR_NAV })).statusCode).toBe(429);
    // The owner, from the same address, still signs in with their password.
    await signIn('owner', { 'sec-fetch-site': 'same-origin' });
  });
});

describe('the Google consent\'s browser binding cannot be planted by a neighbour', () => {
  const google = (async (url: any) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-fixture-1' }), { headers: { 'content-type': 'application/json' } });
    if (u.includes('userinfo')) return new Response(JSON.stringify({ email: 'victim@example.com' }), { headers: { 'content-type': 'application/json' } });
    return new Response('{"ok":true,"result":[]}', { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const HTTPS = { 'x-forwarded-proto': 'https', host: HOST };

  it('over HTTPS the binding is a __Host- cookie, and a plain one (what a neighbour can set on the parent domain) is not believed', async () => {
    const { f, store, ownerId, memberId, signIn } = await signedInWorld({ oauthFetch: google });
    const ownerCookie = await signIn('owner', HTTPS);
    expect((await f.inject({ method: 'PUT', url: '/v1/google-oauth/client', headers: { ...HTTPS, ...SAME_ORIGIN, cookie: ownerCookie }, payload: { clientId: 'cid.apps.example.test', clientSecret: 'FAKE-FIXTURE-VALUE' } })).statusCode).toBe(200);
    // A member presses Connect in their own browser: their state, their nonce.
    const memberCookie = await signIn('member', HTTPS);
    const start = await f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: { ...HTTPS, ...SAME_ORIGIN, cookie: memberCookie }, payload: {} });
    expect(start.statusCode).toBe(200);
    const bind = start.cookies.find((c) => c.value && /hb_oauth$/.test(c.name))!;
    expect(bind).toMatchObject({ name: '__Host-hb_oauth', secure: true, path: '/', httpOnly: true, sameSite: 'Lax' });
    expect(bind.domain).toBeUndefined();
    const state = new URL(start.json().url).searchParams.get('state')!;
    // …then plants that nonce in the owner's browser from their own page on the
    // parent domain (a plain name: a __Host- cookie cannot be planted), and
    // walks the owner through Google's consent with the member's state.
    const planted = await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=owners-code&state=${state}`, headers: { ...HTTPS, cookie: `hb_oauth=${bind.value}; ${ownerCookie}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
    expect(planted.statusCode).toBe(400);
    expect(store.listConnections(memberId)).toEqual([]);
    expect(store.listConnections(ownerId)).toEqual([]);

    // The person who pressed Connect, in their own browser, still finishes it.
    const again = await f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: { ...HTTPS, ...SAME_ORIGIN, cookie: memberCookie }, payload: {} });
    const nonce = again.cookies.find((c) => c.name === '__Host-hb_oauth')!.value;
    const s2 = new URL(again.json().url).searchParams.get('state')!;
    const ok = await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${s2}`, headers: { ...HTTPS, cookie: `__Host-hb_oauth=${nonce}`, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } });
    expect(ok.statusCode).toBe(200);
    expect(store.listConnections(memberId).map((c) => c.email)).toEqual(['victim@example.com']);
    // The binding is spent with the attributes a __Host- cookie needs to be cleared.
    expect(ok.cookies.find((c) => c.name === '__Host-hb_oauth')).toMatchObject({ value: '', path: '/', secure: true });
  });
});
