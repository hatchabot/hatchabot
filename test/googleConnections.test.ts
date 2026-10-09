import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { ExecResult, RuntimeProvider } from '../src/providers/provider.js';
import { OAuthStateJar, googleAuthUrl, parseOAuthClient, syncConnections } from '../src/orchestrator/googleConnections.js';

/** The browser-binding cookie the start route set (night review, 2026-09-28). */
const nonceOf = (res: { cookies: Array<{ name: string; value: string }> }) => res.cookies.find((c) => c.name === 'hb_oauth')?.value ?? '';

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
const H = { 'x-hatchabot-owner': OWNER };

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
    const stranger = await f.inject({ method: 'PUT', url: '/v1/google-oauth/client', headers: { 'x-hatchabot-owner': 'someone-else' }, payload: { clientId: 'fake-cid.apps.example', clientSecret: 'FAKE-FIXTURE-VAL2' } });
    expect(stranger.statusCode).toBe(403);
    expect((await configureClient(f)).statusCode).toBe(200);
    const status = await f.inject({ method: 'GET', url: '/v1/google-oauth/client', headers: { 'x-hatchabot-owner': 'someone-else' } });
    expect(status.json()).toMatchObject({ configured: true, clientId: 'cid.apps.googleusercontent.com' });
    expect(status.body).not.toContain('FAKE-FIXTURE-VALUE');
    expect(status.json().redirectUri).toMatch(/\/v1\/connections\/google\/callback$/);
  });
});

describe('the consent round-trip', () => {
  it('a callback from a different browser than the one that pressed Connect is refused (night review)', async () => {
    const { fetchImpl } = googleMock();
    const { f } = await world(fetchImpl);
    await configureClient(f);
    const start = await f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: H, payload: {} });
    const state = new URL(start.json().url).searchParams.get('state');
    const other = await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${state}` });
    expect(other.statusCode).toBe(400);
    expect(other.body).toMatch(/different browser/);
  });
  it('start → callback stores the connection; the refresh token lives only in the vault', async () => {
    const { calls, fetchImpl } = googleMock();
    const { f, store, secrets } = await world(fetchImpl);
    await configureClient(f);
    const start = await f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: H, payload: { services: ['gmail', 'calendar'] } });
    expect(start.statusCode).toBe(200);
    const state = new URL(start.json().url).searchParams.get('state')!;

    const cb = await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=authcode&state=${state}`, headers: H, cookies: { hb_oauth: nonceOf(start) } });
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
    const cb = await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${state}`, cookies: { hb_oauth: nonceOf(start) } });
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
    await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${state}`, cookies: { hb_oauth: nonceOf(start) } }); // consumes it
    calls.length = 0;
    const replay = await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${state}`, cookies: { hb_oauth: nonceOf(start) } });
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
  async function connectedWorld(email?: string) {
    const { fetchImpl, calls } = googleMock(email ? { email } : {});
    const w = await world(fetchImpl);
    await configureClient(w.f);
    const start = await w.f.inject({ method: 'POST', url: '/v1/connections/google/start', headers: H, payload: {} });
    const state = new URL(start.json().url).searchParams.get('state')!;
    await w.f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c&state=${state}`, headers: H, cookies: { hb_oauth: nonceOf(start) } });
    const connId = w.store.listConnections(OWNER)[0]!.id;
    return { ...w, connId, googleCalls: calls };
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
    // Overwrites an entry the volume already holds (a rebuild or wake re-imports it; review, 2026-09-29).
    expect(script).toMatch(/gog auth import [^\n]*--force/);
    expect(script).toContain('keyring_password'); // non-interactive plumbing bootstrapped
    // The token is in this script: it goes over stdin, never a command line (2026-09-30).
    expect(provider.secretShells.some((s) => s.includes('--refresh-token-stdin'))).toBe(true);
    const attached = store.listAgentConnections('a1');
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ connectionId: connId, gmailNoSend: true });
    expect(attached[0]!.attachedAt).toBeTruthy();
    expect(attached[0]!.materializedAt).toBeTruthy(); // materialize stamped the pull
  });

  it('syncConnections reconciles away a vault account no longer attached (detached while stopped)', async () => {
    const { provider, store, secrets } = await connectedWorld();
    // chris@example.com is in the owner's vault but is NOT attached to a1.
    // Simulate the container still having it materialized (a detach that
    // happened while the agent was stopped, so the live remove never ran).
    provider.execResponses.set('sh', {
      code: 0,
      stdout: JSON.stringify({ accounts: [{ email: 'chris@example.com' }] }),
      stderr: '',
    });
    const ref = store.getAgent('a1')!.runtimeRef!;
    await syncConnections({ store, secrets, provider, log: () => {} }, 'a1', ref);
    expect(
      provider.execLog.some((c) => c[0] === 'sh' && String(c[1] ?? '').includes('gog auth remove --force -- "chris@example.com"')),
    ).toBe(true);
  });

  it('a detach while the agent was stopped takes effect at Start, not at the next rebuild (night review)', async () => {
    const w = await connectedWorld();
    const ref = w.store.getAgent('a1')!.runtimeRef!;
    await w.provider.stop(ref);
    w.store.setAgentState('a1', 'STOPPED');
    w.provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ accounts: [{ email: 'chris@example.com' }] }), stderr: '' });
    const start = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/start', headers: H });
    expect(start.statusCode, start.body).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.provider.execLog.some((c) => c[0] === 'sh' && String(c[1] ?? '').includes('gog auth remove --force -- "chris@example.com"'))).toBe(true);
  });

  it('a connection deleted while its agent was stopped comes off at Start (night review)', async () => {
    const w = await connectedWorld();
    const conn = w.store.listConnections(OWNER)[0]!;
    w.store.attachConnection('a1', conn.id, false);
    const ref = w.store.getAgent('a1')!.runtimeRef!;
    await w.provider.stop(ref);
    w.store.setAgentState('a1', 'STOPPED');
    expect((await w.f.inject({ method: 'DELETE', url: `/v1/connections/${conn.id}`, headers: H })).statusCode).toBe(200);
    expect(w.store.connectionRemovals('a1')).toEqual([conn.email]);
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/start', headers: H })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(w.provider.execLog.some((c) => c[0] === 'sh' && String(c[1] ?? '').includes(`gog auth remove --force -- "${conn.email}"`))).toBe(true);
    expect(w.store.connectionRemovals('a1')).toEqual([]);
  });

  /** Hold the next shell script matching `what` until the test lets it go; record imports (when done) and removes. */
  function gated(provider: MockProvider, what: string) {
    const real = provider.execShell.bind(provider);
    const events: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    let once = true;
    provider.execShell = (async (ref: string, script: string, opts?: { timeoutMs?: number; secret?: boolean }) => {
      if (script.includes('gog auth remove')) events.push('remove');
      if (once && script.includes(what)) { once = false; entered(); await gate; }
      const r = await real(ref, script, opts);
      if (script.includes('gog auth import')) events.push('import');
      return r;
    }) as typeof provider.execShell;
    return { events, inside, release };
  }

  it('a detach during a sync\'s import is not undone by it (2026-10-09)', async () => {
    const w = await connectedWorld();
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: w.connId } })).statusCode).toBe(200);
    const g = gated(w.provider, 'gog auth import');
    const syncing = syncConnections({ store: w.store, secrets: w.secrets, provider: w.provider }, 'a1', w.store.getAgent('a1')!.runtimeRef!);
    await g.inside;
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/detach', headers: H, payload: { connectionId: w.connId } })).json().removed).toBe(true);
    g.release();
    await syncing;
    // The import landed after the detach's removal: it comes off again.
    expect(g.events.at(-1)).toBe('remove');
  });

  it('a detach before a sync reaches that account: the sync does not import it (2026-10-09)', async () => {
    const w = await connectedWorld();
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: w.connId } })).statusCode).toBe(200);
    const g = gated(w.provider, 'gog auth list');
    const syncing = syncConnections({ store: w.store, secrets: w.secrets, provider: w.provider }, 'a1', w.store.getAgent('a1')!.runtimeRef!);
    await g.inside;
    await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/detach', headers: H, payload: { connectionId: w.connId } });
    g.release();
    await syncing;
    expect(g.events).not.toContain('import');
  });

  it('syncConnections leaves a SELF-connected account (not in the vault) alone', async () => {
    const { provider, store, secrets } = await connectedWorld();
    // An account the agent connected itself in chat — not an owner vault entry.
    provider.execResponses.set('sh', {
      code: 0,
      stdout: JSON.stringify({ accounts: [{ email: 'self-connected@example.org' }] }),
      stderr: '',
    });
    const ref = store.getAgent('a1')!.runtimeRef!;
    await syncConnections({ store, secrets, provider, log: () => {} }, 'a1', ref);
    expect(
      provider.execLog.some((c) => c[0] === 'sh' && String(c[1] ?? '').includes('gog auth remove')),
    ).toBe(false);
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
    await f.inject({ method: 'GET', url: `/v1/connections/google/callback?code=c2&state=${state}`, headers: H, cookies: { hb_oauth: nonceOf(again) } });
    const conns = store.listConnections(OWNER);
    expect(conns).toHaveLength(1);
    await expect(secrets.get(`connection/${conns[0]!.id}`)).resolves.toBe('rt-secret-1');
  });

  // ---- issue #11: removals are durable until verified ----------------------

  const removeOf = (log: string[][], email: string) =>
    log.filter((c) => c[0] === 'sh' && String(c[1] ?? '').includes(`gog auth remove --force -- "${email}"`)).length;
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('detach on a STOPPED agent records the removal; deleting the connection after keeps it; Start removes the right email, then clears', async () => {
    const w = await connectedWorld('mailbox@example.org');
    await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: w.connId } });
    await w.provider.stop(w.store.getAgent('a1')!.runtimeRef!);
    w.store.setAgentState('a1', 'STOPPED');
    const det = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/detach', headers: H, payload: { connectionId: w.connId } });
    expect(det.json()).toMatchObject({ detached: true, removed: false });
    expect(w.store.listAgentConnections('a1')).toHaveLength(0);
    expect(w.store.connectionRemovals('a1')).toEqual(['mailbox@example.org']);
    // The vault row (the old email lookup) goes; the record must not.
    expect((await w.f.inject({ method: 'DELETE', url: `/v1/connections/${w.connId}`, headers: H })).statusCode).toBe(200);
    expect(w.store.listConnections(OWNER)).toHaveLength(0);
    expect(w.store.connectionRemovals('a1')).toEqual(['mailbox@example.org']);
    expect(removeOf(w.provider.execLog, 'mailbox@example.org')).toBe(0);
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/start', headers: H })).statusCode).toBe(200);
    await settle();
    expect(removeOf(w.provider.execLog, 'mailbox@example.org')).toBe(1);
    expect(w.store.connectionRemovals('a1')).toEqual([]);
  });

  it('re-attaching the same account before the agent starts drops the pending removal; the credential stays', async () => {
    const w = await connectedWorld('mailbox@example.org');
    await w.provider.stop(w.store.getAgent('a1')!.runtimeRef!);
    w.store.setAgentState('a1', 'STOPPED');
    await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: w.connId } });
    await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/detach', headers: H, payload: { connectionId: w.connId } });
    expect(w.store.connectionRemovals('a1')).toEqual(['mailbox@example.org']);
    await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: w.connId } });
    expect(w.store.connectionRemovals('a1')).toEqual([]);
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/start', headers: H })).statusCode).toBe(200);
    await settle();
    expect(removeOf(w.provider.execLog, 'mailbox@example.org')).toBe(0);
    expect(w.provider.secretShells.some((s) => s.includes('gog auth import --email "mailbox@example.org"'))).toBe(true);
  });

  it('a stale record for an account attached again is cleared by sync without removing it', async () => {
    const w = await connectedWorld('mailbox@example.org');
    w.store.attachConnection('a1', w.connId, false);
    w.store.addConnectionRemoval('a1', 'mailbox@example.org');
    await syncConnections({ store: w.store, secrets: w.secrets, provider: w.provider, log: () => {} }, 'a1', w.store.getAgent('a1')!.runtimeRef!);
    expect(removeOf(w.provider.execLog, 'mailbox@example.org')).toBe(0);
    expect(w.store.connectionRemovals('a1')).toEqual([]);
  });

  it('a failed live detach keeps the record for the next start', async () => {
    const w = await connectedWorld('mailbox@example.org');
    await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: w.connId } });
    w.provider.execResponses.set('sh', { code: 1, stdout: '', stderr: 'keyring locked' });
    const det = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/detach', headers: H, payload: { connectionId: w.connId } });
    expect(det.json()).toMatchObject({ detached: true, removed: false });
    expect(w.store.connectionRemovals('a1')).toEqual(['mailbox@example.org']);
    const del = await w.f.inject({ method: 'DELETE', url: `/v1/connections/${w.connId}`, headers: H });
    expect(del.json()).toMatchObject({ removed: true, pendingOn: 0 }); // already detached: no holders left
    expect(w.store.connectionRemovals('a1')).toEqual(['mailbox@example.org']);
  });

  it('deleting a connection held by another account still takes it off the agent but does not revoke the shared grant', async () => {
    const w = await connectedWorld('shared-box@example.org');
    w.store.insertConnection({ id: 'c-other', ownerId: 'user-other', kind: 'google', email: 'shared-box@example.org', services: [], secretRef: 'connection/c-other' });
    await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: w.connId } });
    const del = await w.f.inject({ method: 'DELETE', url: `/v1/connections/${w.connId}`, headers: H });
    expect(del.json()).toMatchObject({ removed: true, pendingOn: 0 });
    expect(removeOf(w.provider.execLog, 'shared-box@example.org')).toBe(1);
    expect(w.store.connectionRemovals('a1')).toEqual([]);
    expect(w.googleCalls.some((c) => c.url.includes('/revoke'))).toBe(false);
    expect(w.store.getConnection('c-other')).toBeTruthy();
  });

  it('deleting a connection nobody else holds revokes it at Google (unchanged)', async () => {
    const w = await connectedWorld('mailbox@example.org');
    await w.f.inject({ method: 'POST', url: '/v1/agents/a1/connections/attach', headers: H, payload: { connectionId: w.connId } });
    await w.f.inject({ method: 'DELETE', url: `/v1/connections/${w.connId}`, headers: H });
    expect(w.googleCalls.some((c) => c.url.includes('/revoke'))).toBe(true);
  });
});

describe('syncConnections retries a removal until it is verified (issue #11)', () => {
  const EMAIL = 'old-box@example.org';
  /** A runtime whose remove/list answers the test scripts; every script is logged. */
  function scripted(answer: (kind: 'remove' | 'list' | 'other', n: number) => ExecResult | Error) {
    const scripts: string[] = [];
    let removes = 0;
    const provider = {
      async execShell(_ref: string, script: string): Promise<ExecResult> {
        scripts.push(script);
        const kind = script.includes('gog auth remove') ? 'remove' : script.includes('gog auth list') ? 'list' : 'other';
        const r = answer(kind, kind === 'remove' ? ++removes : 0);
        if (r instanceof Error) throw r;
        return r;
      },
    } as unknown as RuntimeProvider;
    return { provider, removes: () => scripts.filter((s) => s.includes(`gog auth remove --force -- "${EMAIL}"`)).length };
  }
  const stillHeld: ExecResult = { code: 0, stdout: JSON.stringify({ accounts: [{ email: EMAIL }] }), stderr: '' };
  const ok: ExecResult = { code: 0, stdout: '', stderr: '' };

  async function bare() {
    const w = await world();
    w.store.addConnectionRemoval('a1', EMAIL);
    const ref = w.store.getAgent('a1')!.runtimeRef!;
    return { ...w, ref };
  }

  it('a non-zero remove keeps the record; the next sync retries and clears it on success', async () => {
    const w = await bare();
    const rt = scripted((kind, n) => kind === 'remove' ? (n === 1 ? { code: 1, stdout: '', stderr: 'keyring locked' } : ok) : kind === 'list' ? stillHeld : ok);
    const events: string[] = [];
    const deps = { store: w.store, secrets: w.secrets, provider: rt.provider, log: (e: string) => { events.push(e); } };
    await syncConnections(deps, 'a1', w.ref);
    expect(rt.removes()).toBe(1);
    expect(w.store.connectionRemovals('a1')).toEqual([EMAIL]);
    expect(events).toContain('connection.remove_failed');
    expect(events).not.toContain('connection.removed_from_agent');
    await syncConnections(deps, 'a1', w.ref);
    expect(rt.removes()).toBe(2);
    expect(w.store.connectionRemovals('a1')).toEqual([]);
    expect(events).toContain('connection.removed_from_agent');
  });

  it('a thrown exec keeps the record', async () => {
    const w = await bare();
    const rt = scripted((kind) => kind === 'remove' ? new Error('container gone') : kind === 'list' ? stillHeld : ok);
    await syncConnections({ store: w.store, secrets: w.secrets, provider: rt.provider }, 'a1', w.ref);
    expect(rt.removes()).toBe(1);
    expect(w.store.connectionRemovals('a1')).toEqual([EMAIL]);
  });

  it('a failed remove whose list cannot be read keeps the record', async () => {
    const w = await bare();
    const rt = scripted(() => new Error('docker unreachable'));
    await syncConnections({ store: w.store, secrets: w.secrets, provider: rt.provider }, 'a1', w.ref);
    expect(w.store.connectionRemovals('a1')).toEqual([EMAIL]);
  });

  it('a failed remove for an account gog no longer lists counts as removed', async () => {
    const w = await bare();
    const rt = scripted((kind) => kind === 'remove' ? { code: 1, stdout: '', stderr: 'no such account' } : kind === 'list' ? { code: 0, stdout: JSON.stringify({ accounts: [] }), stderr: '' } : ok);
    await syncConnections({ store: w.store, secrets: w.secrets, provider: rt.provider }, 'a1', w.ref);
    expect(w.store.connectionRemovals('a1')).toEqual([]);
  });

  it('a vault account the reconcile fails to remove is remembered, so deleting it later cannot lose it', async () => {
    const w = await bare();
    w.store.clearConnectionRemoval('a1', EMAIL);
    w.store.insertConnection({ id: 'c-v', ownerId: OWNER, kind: 'google', email: EMAIL, services: [], secretRef: 'connection/c-v' });
    const rt = scripted((kind) => kind === 'remove' ? { code: 1, stdout: '', stderr: 'busy' } : kind === 'list' ? stillHeld : stillHeld);
    await syncConnections({ store: w.store, secrets: w.secrets, provider: rt.provider }, 'a1', w.ref);
    expect(rt.removes()).toBeGreaterThan(0);
    expect(w.store.connectionRemovals('a1')).toEqual([EMAIL]);
  });
});
