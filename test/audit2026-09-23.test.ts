import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { ProviderError } from '../src/providers/provider.js';
import { Store } from '../src/store/store.js';
import { isPrivateModelUrl, registerRoutes } from '../src/api/routes.js';
import { _resetLoginThrottle, registerAuth } from '../src/api/auth.js';
import { installErrorHandler } from '../src/api/errorHandler.js';
import { computePosture } from '../src/orchestrator/posture.js';
import { markBusy, clearBusy } from '../src/orchestrator/busy.js';

/**
 * 26th audit (2026-09-23): what the seven antagonistic reviews found and
 * this release fixed. Each test is the attack, or the failure, as reported.
 */

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };
class MemSecrets {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

async function box() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const provider = new MockProvider();
  const secrets = new MemSecrets();
  const f = Fastify();
  installErrorHandler(f);
  await registerRoutes(f, {
    store, secrets, providers: new Map([['mock', provider], ['mock2', new MockProvider()]]),
    channel: { kind: 'telegram', pool: { owns: () => false } },
  } as never);
  const agent = (id: string, extra: Record<string, unknown> = {}) => store.insertAgent({
    id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: `docker://${id}`,
    persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now', ...extra,
  } as never);
  return { store, provider, secrets, f, agent };
}

describe('internal error text never reaches the client', () => {
  it('a ProviderError answers with its user message; anything else with a fixed line', async () => {
    const f = Fastify();
    installErrorHandler(f);
    f.get('/docker', async () => { throw new ProviderError('docker stop failed: ssh: connect to host macbook.tail1329ea.ts.net port 22', "Couldn't reach that host's Docker daemon."); });
    f.get('/boom', async () => { throw new Error('/var/lib/docker/volumes/hatchabot-secret-vol is full'); });
    const a = await f.inject({ method: 'GET', url: '/docker' });
    expect(a.statusCode).toBe(500);
    expect(a.json()).toEqual({ error: "Couldn't reach that host's Docker daemon." });
    expect(a.body).not.toContain('ssh');
    const b = await f.inject({ method: 'GET', url: '/boom' });
    expect(b.json().error).toMatch(/Something went wrong/);
    expect(b.body).not.toContain('/var/lib');
  });
});

describe('login throttle', () => {
  beforeEach(() => _resetLoginThrottle());
  afterEach(() => { delete process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW; });

  async function accounts() {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    await registerAuth(f, { secret: Buffer.alloc(32, 9), mode: 'accounts', store });
    await f.inject({ method: 'POST', url: '/v1/local-accounts/bootstrap', payload: { username: 'chris', password: 'correct-horse' } });
    return f;
  }
  const attempt = (f: any, username: string, from: string) =>
    f.inject({ method: 'POST', url: '/v1/login', payload: { username, password: 'wrong-guess' }, headers: { 'x-forwarded-for': from } });

  it('behind a proxy, one client cannot lock everyone out', async () => {
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '3';
    const f = await accounts();
    for (let i = 0; i < 3; i++) await attempt(f, `guess${i}`, '100.64.0.7');
    expect((await attempt(f, 'guess9', '100.64.0.7')).statusCode).toBe(429); // that client is done
    expect((await attempt(f, 'guess9', '100.64.0.8')).statusCode).toBe(401); // the next person is not
  });

  it('the account under attack is throttled even from a new address each time', async () => {
    process.env.HATCHABOT_LOGIN_FAILS_PER_WINDOW = '3';
    const f = await accounts();
    for (let i = 0; i < 3; i++) await attempt(f, 'chris', `100.64.1.${i}`);
    expect((await attempt(f, 'chris', '100.64.1.99')).statusCode).toBe(429);
    expect((await attempt(f, 'someone-else', '100.64.1.99')).statusCode).toBe(401);
  });
});

describe('a rehost-scoped token', () => {
  it('opens the move routes and nothing else', async () => {
    const store = new Store(new Database(':memory:'));
    const f = Fastify();
    await registerAuth(f, { secret: Buffer.alloc(32, 9), mode: 'accounts', store, cliTokenOwner: (t) => store.ownerForCliToken(t), cliTokenScope: (t) => store.cliTokenScope(t) });
    f.get('/v1/agents', async () => []);
    f.post('/v1/agents/preflight', async () => ({ ok: true }));
    f.get('/v1/cli-tokens', async () => []);
    f.post('/v1/agents', async () => ({}));
    store.insertLocalAccount({ id: 'acct-1', username: 'chris', pwHash: 'x', pwSalt: 'y', hostOwner: true, disabled: false, createdAt: 'now' } as never);
    const scoped = store.createCliToken('acct-1', 'peer', 90, 'rehost').token;
    const full = store.createCliToken('acct-1', 'cli').token;
    const as = (token: string, method: 'GET' | 'POST', url: string) => f.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: method === 'POST' ? {} : undefined });
    expect((await as(scoped, 'GET', '/v1/agents')).statusCode).toBe(200);
    expect((await as(scoped, 'POST', '/v1/agents/preflight')).statusCode).toBe(200);
    expect((await as(scoped, 'GET', '/v1/cli-tokens')).statusCode).toBe(401);  // no reading the owner's tokens
    expect((await as(scoped, 'POST', '/v1/agents')).statusCode).toBe(401);     // no creating agents
    expect((await as(full, 'GET', '/v1/cli-tokens')).statusCode).toBe(200);    // a full token is unchanged
    expect(store.listCliTokens('acct-1').map((t) => t.scope).sort()).toEqual(['rehost', undefined]);
  });
});

describe('a member of someone else\'s agent', () => {
  it('sees what it can do, not where the owner\'s files are, its env names or its port', async () => {
    const b = await box();
    b.agent('shared', { gatewayPort: 19176, gatewayToken: 'tok' });
    b.store.setAgentSharedPaths('shared', ['/home/chris/condo-documents']);
    b.store.insertMembership({ id: 'm1', agentId: 'shared', userId: 'member', role: 'user', status: 'active' } as never);
    b.store.insertAgentEnv({ id: 'e1', agentId: 'shared', name: 'STRIPE_KEY', secretRef: 'agent-env/e1', createdAt: 'now' } as never);
    const mine = (await b.f.inject({ method: 'GET', url: '/v1/agents/shared', headers: H })).json();
    expect(mine.dataSources[0].hostPath).toBe('/home/chris/condo-documents');
    expect(mine.envVars.map((e: any) => e.name)).toEqual(['STRIPE_KEY']);
    const theirs = (await b.f.inject({ method: 'GET', url: '/v1/agents/shared', headers: { 'x-hatchabot-owner': 'member' } })).json();
    expect(theirs.role).toBe('user');
    expect(theirs.dataSources[0].mountName).toBe('condo-documents'); // what it can read
    expect(theirs.dataSources[0].hostPath).toBeUndefined();          // not where
    expect(theirs.sharedPaths).toBeUndefined();
    expect(theirs.envVars).toEqual([]);
    expect(theirs.gatewayPort).toBeUndefined();
    const list = (await b.f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': 'member' } })).json();
    expect(list[0].dataSources[0].hostPath).toBeUndefined();
  });
});

describe('registering another server', () => {
  it('refuses this machine\'s own loopback and link-local addresses', async () => {
    const b = await box();
    for (const url of ['http://127.0.0.1:8091', 'http://localhost:8080', 'http://169.254.169.254', 'http://box.internal:8080']) {
      const r = await b.f.inject({ method: 'POST', url: '/v1/peers', headers: H, payload: { name: 'x', url, token: 'hatchabot_x' } });
      expect(r.statusCode, url).toBe(400);
      expect(r.json().error).toMatch(/own address/);
    }
  });
});

describe('a local model server', () => {
  it('lives on a private network, never at the cloud metadata address', () => {
    expect(isPrivateModelUrl('http://10.0.0.5:11434')).toBe(true);
    expect(isPrivateModelUrl('http://ollama.local:11434')).toBe(true);
    expect(isPrivateModelUrl('http://169.254.169.254/latest')).toBe(false);
    expect(isPrivateModelUrl('http://metadata.internal/v1')).toBe(false);
  });
});

describe('machine-login Claude sources', () => {
  afterEach(() => { delete process.env.HATCHABOT_ALLOW_MACHINE_LOGIN; });
  it('are no longer offered; a setup token is the way', async () => {
    const b = await box();
    const r = await b.f.inject({ method: 'POST', url: '/v1/ai-profiles', headers: H, payload: { kind: 'subscription', name: 'Max', vendor: 'anthropic', model: 'claude-opus-4-8' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/setup-token/);
    // An operator who insists can still turn it on.
    process.env.HATCHABOT_ALLOW_MACHINE_LOGIN = '1';
    const r2 = await b.f.inject({ method: 'POST', url: '/v1/ai-profiles', headers: H, payload: { kind: 'subscription', name: 'Max', vendor: 'anthropic', model: 'claude-opus-4-8' } });
    expect(r2.body).not.toMatch(/no longer offered/);
  });
  it('an existing one is a posture finding', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Old Max', vendor: 'anthropic', kind: 'subscription', model: 'm', createdAt: 'now' } as never);
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'accounts' });
    const hit = report.install.find((c) => c.key === 'machine-login-source');
    expect(hit?.level).toBe('warn');
    expect(hit?.title).toContain('Old Max');
  });
});

describe('move-host with dropPin', () => {
  it('keeps the pin when the move is refused', async () => {
    const b = await box();
    b.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'cloud', provider: 'mock2', name: 'Laptop', settings: {}, createdAt: 'now' } as never);
    b.agent('pinned');
    b.store.setAgentImage('pinned', 'hatchabot-runtime:derived-media');
    markBusy('pinned');
    try {
      const r = await b.f.inject({ method: 'POST', url: '/v1/agents/pinned/move-host', headers: H, payload: { hostId: 'h2', dropPin: true } });
      expect(r.statusCode).toBe(409);
    } finally { clearBusy('pinned'); }
    expect(b.store.getAgent('pinned')!.image).toBe('hatchabot-runtime:derived-media');
  });
});
