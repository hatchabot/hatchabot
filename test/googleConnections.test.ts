import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { OAuthStateJar, googleAuthUrl, parseOAuthClient } from '../src/orchestrator/googleConnections.js';

/**
 * Platform-managed Google connections: the control plane owns the OAuth
 * round-trip and materializes attached accounts into agent containers via
 * `gog auth import`. Google itself is mocked at the fetch seam.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const H = { 'x-agentclaw-owner': OWNER };

const googleMock = (opts: { email?: string; refresh?: string } = {}) => {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchImpl = (async (url: any, init?: any) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? String(init.body) : undefined });
    if (u.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: opts.refresh ?? 'rt-secret-1' }), { headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('userinfo')) {
      return new Response(JSON.stringify({ email: opts.email ?? 'chris@example.com' }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

async function world(oauthFetch?: typeof fetch) {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Mailer', slug: 'mailer', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'mailer',
    workspace: { files: {}, configPatch: { agentId: 'mailer', authMode: 'api-key' } }, env: {},
  } as any);
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets, providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    oauthFetch,
  } as any);
  return { store, f, provider, secrets };
}

const configureClient = (f: any) =>
  f.inject({ method: 'PUT', url: '/v1/google-oauth/client', headers: H, payload: { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'FAKE-FIXTURE-VALUE' } });

describe('unit pieces', () => {
  it('auth URL always re-prompts consent (refresh token depends on it) and carries the scopes', () => {
    const u = new URL(googleAuthUrl('cid', 'https://x/cb', 'st', ['gmail', 'calendar']));
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('scope')).toContain('https://mail.google.com/');
    expect(u.searchParams.get('scope')).toContain('auth/calendar');
    expect(u.searchParams.get('state')).toBe('st');
  });

  it('state tokens are single-use and owner-bound', () => {
    const jar = new OAuthStateJar();
    const s = jar.issue('me', ['gmail']);
    expect(jar.consume(s)).toEqual({ ownerId: 'me', services: ['gmail'] });
    expect(jar.consume(s)).toBeNull(); // spent
    expect(jar.consume('made-up')).toBeNull();
  });

  it('parseOAuthClient refuses junk', () => {
    expect(parseOAuthClient('{"clientId":"a","clientSecret":"b"}')).toEqual({ clientId: 'a', clientSecret: 'b' });
    expect(parseOAuthClient('not json')).toBeNull();
    expect(parseOAuthClient('{"clientId":""}')).toBeNull();
  });
});

describe('OAuth client setup', () => {
  it('host-owner gated writes; status readable by anyone, secret never echoed', async () => {
    const { f } = await world();
    const stranger = await f.inject({ method: 'PUT', url: '/v1/google-oauth/client', headers: { 'x-agentclaw-owner': 'someone-else' }, payload: { clientId: 'fake-cid.apps.example', clientSecret: 'FAKE-FIXTURE-VAL2' } });
    expect(stranger.statusCode).toBe(403);
    expect((await configureClient(f)).statusCode).toBe(200);
    const status = await f.inject({ method: 'GET', url: '/v1/google-oauth/client', headers: { 'x-agentclaw-owner': 'someone-else' } });
    expect(status.json()).toMatchObject({ configured: true, clientId: 'cid.apps.googleusercontent.com' });
    expect(status.body).not.toContain('FAKE-FIXTURE-VALUE');
    expect(status.json().redirectUri).toMatch(/\/v1\/connections\/google\/callback$/);
  });
});

describe('the consent round-trip', () => {
  it('start → callback stores the connection; the refresh token lives only in the vault', async () => {
    const { calls, fetchImpl } = googleMock();
    const { f, store, secrets } = await world(fetchImpl);
    await configureClient(f);
    const start = await f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: H, payload: { services: ['gmail', 'calendar'] } });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().url).searchParams.get('state')!;

    const cb = await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=authcode&state=${state}`, headers: H });
    expect(cb.statusCode).toBe(200);
    expect(cb.body).toContain('chris@example.com');
    expect(cb.body).not.toContain('rt-secret-1'); // never in the page

    const conns = store.listConnections(OWNER);
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ kind: 'google', email: 'chris@example.com', services: ['gmail', 'calendar'] });
    await expect(secrets.get(`connection/${conns[0]!.id}`)).resolves.toBe('rt-secret-1');
    // the exchange sent the code, not any stored secret
    expect(calls.some((c) => c.url.includes('/token') && c.body?.includes('code=authcode'))).toBe(true);

    // vault list shows it, token still not echoed
    const list = await f.inject({ method: 'GET', url: '/v1/connections', headers: H });
    expect(list.json().connections[0].email).toBe('chris@example.com');
    expect(list.body).not.toContain('rt-secret-1');
  });

  it('the callback needs NO session (cross-site redirect drops the strict cookie) — the state alone binds it to the starter', async () => {
    const { fetchImpl } = googleMock();
    const { f, store } = await world(fetchImpl);
    await configureClient(f);
    const start = await f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: H, payload: {} });
    const state = new URL(start.json().url).searchParams.get('state')!;
    // NO auth headers at all — exactly how the browser arrives from Google.
    const cb = await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${state}` });
    expect(cb.statusCode).toBe(200);
    // ...and the vault entry lands under the STARTER, not some default owner.
    expect(store.listConnections(OWNER)).toHaveLength(1);
  });

  it('a spent or made-up state never reaches Google', async () => {
    const { calls, fetchImpl } = googleMock();
    const { f } = await world(fetchImpl);
    await configureClient(f);
    const start = await f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: H, payload: {} });
    const state = new URL(start.json().url).searchParams.get('state')!;
    await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${state}` }); // consumes it
    calls.length = 0;
    const replay = await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${state}` });
    expect(replay.statusCode).toBe(400);
    const junk = await f.inject({ method: 'GET', url: '/v1/connections/google/callback?code=c&state=nope' });
    expect(junk.statusCode).toBe(400);
    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(0);
  });

  it('start without a configured client is a 409 pointing at setup', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: H, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/server owner/);
  });
});

describe('attach / detach / remove', () => {
  async function connectedWorld() {
    const { fetchImpl } = googleMock();
    const w = await world(fetchImpl);
    await configureClient(w.f);
    const start = await w.f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: H, payload: {} });
    const state = new URL(start.json().url).searchParams.get('state')!;
    await w.f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${state}`, headers: H });
    const connId = w.store.listConnections(OWNER)[0]!.id;
    return { ...w, connId };
  }

  it('attach on a RUNNING agent materializes immediately via gog auth import', async () => {
    const { f, provider, connId, store } = await connectedWorld();
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: connId, gmailNoSend: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ attached: true, live: true });
    const script = provider.execLog.filter((c) => c[0] === 'sh').map((c) => c[1]).join('\n');
    expect(script).toContain('gog auth credentials');
    expect(script).toContain('gog auth import --email "chris@example.com" --refresh-token-stdin');
    expect(script).toContain('--gmail-no-send');
    expect(script).toContain('keyring_password'); // non-interactive plumbing bootstrapped
    expect(store.listAgentConnections('a1')).toEqual([{ connectionId: connId, gmailNoSend: true }]);
  });

  it("someone else's connection cannot be attached (404, no exec)", async () => {
    const { f, provider, store } = await connectedWorld();
    store.insertConnection({ id: 'c-x', ownerId: 'user-other', kind: 'google', email: 'somebody@example.org', services: [], secretRef: 's/x' });
    const before = provider.execLog.length;
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: 'c-x' } });
    expect(res.statusCode).toBe(404);
    expect(provider.execLog.length).toBe(before);
  });

  it('detach removes the row and the container account; vault removal revokes at Google', async () => {
    const { f, provider, connId, store, secrets } = await connectedWorld();
    await f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: connId } });
    const det = await f.inject({ method: 'POST', url: '/v1/agents/a1/connections/detach', headers: H, payload: { connectionId: connId } });
    expect(det.statusCode).toBe(200);
    expect(store.listAgentConnections('a1')).toHaveLength(0);
    expect(provider.execLog.some((c) => c[0] === 'sh' && String(c[1] ?? '').includes('gog auth remove --force -- "chris@example.com"'))).toBe(true);

    const del = await f.inject({ method: 'DELETE', url: `/v1/connections/${connId}`, headers: H });
    expect(del.statusCode).toBe(200);
    expect(store.listConnections(OWNER)).toHaveLength(0);
    expect([...secrets.map.keys()].filter((k) => k.startsWith('connection/'))).toHaveLength(0);
  });

  it('reconnecting the same account upserts — one row, fresh token', async () => {
    const { f, store, secrets } = await connectedWorld();
    const again = await f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: H, payload: {} });
    const state = new URL(again.json().url).searchParams.get('state')!;
    await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c2&state=${state}`, headers: H });
    const conns = store.listConnections(OWNER);
    expect(conns).toHaveLength(1);
    await expect(secrets.get(`connection/${conns[0]!.id}`)).resolves.toBe('rt-secret-1');
  });
});
