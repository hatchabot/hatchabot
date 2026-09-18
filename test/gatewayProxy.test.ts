import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * The Control UI is reverse-proxied so the agent's gateway port can stay bound
 * to the host's loopback. These cover the two things that matter: an upgrade is
 * only forwarded for an authenticated OWNER, and when it is, bytes actually
 * flow both ways (a handshake that 101s but never pipes is still a dead UI).
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
let toClose: Array<FastifyInstance | Server> = [];
afterEach(() => {
  // Fire-and-forget: a proxied upgrade leaves sockets open on BOTH servers, so
  // awaiting close() hangs (the hook timed out at 10s). Destroy connections and
  // close without waiting — nothing after this depends on the port being free.
  for (const s of toClose) {
    const raw: any = (s as any).server ?? s;
    try { raw.closeAllConnections?.(); raw.close?.(() => {}); raw.unref?.(); } catch { /* already gone */ }
  }
  toClose = [];
});

/** A stand-in for the agent's OpenClaw gateway: upgrades, then echoes. */
async function fakeGateway(): Promise<{ port: number; server: Server }> {
  const server = createServer((_req, res) => {
    // What OpenClaw actually sends: framing forbidden outright.
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; script-src 'self'");
    res.end('page');
  });
  server.on('upgrade', (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  toClose.push(server);
  return { port: (server.address() as any).port, server };
}

async function world(principal: unknown) {
  const { port } = await fakeGateway();
  const db = new Database(':memory:');
  const store = new Store(db);
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'A', slug: 'a', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://a1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  // ensureGatewayAccess allocates its own port; this test needs the fake
  // gateway's, so set the columns directly.
  db.prepare('UPDATE agents SET gateway_port = ?, gateway_token = ? WHERE id = ?').run(port, 'gw-token', 'a1');
  const app = Fastify();
  // Stand in for auth.ts's resolver — the ONLY thing the upgrade path trusts.
  app.decorate('principalFromCookieHeader', () => principal as any);
  await registerRoutes(app, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  await app.listen({ port: 0, host: '127.0.0.1' });
  toClose.push(app);
  return { app, port: (app.server.address() as any).port };
}

/** Raw WebSocket-ish handshake; resolves with the status line and first echo. */
function upgrade(port: number, path: string): Promise<{ status: string; echoed?: string }> {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
      );
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('101') && !buf.includes('echo:')) sock.write('ping');
      if (buf.includes('echo:')) { sock.destroy(); resolve({ status: buf.split('\r\n')[0]!, echoed: 'yes' }); }
    });
    sock.on('error', () => resolve({ status: 'DESTROYED' }));
    sock.on('close', () => resolve({ status: buf.split('\r\n')[0] || 'DESTROYED' }));
    setTimeout(() => { sock.destroy(); resolve({ status: buf.split('\r\n')[0] || 'TIMEOUT' }); }, 3000);
  });
}

describe('Control UI websocket proxy', () => {
  it('forwards an owner\'s upgrade and pipes bytes both ways', async () => {
    const { port } = await world({ ownerId: OWNER, via: 'identity' });
    const res = await upgrade(port, '/v1/agents/a1/ui/');
    expect(res.status).toContain('101');
    expect(res.echoed).toBe('yes'); // a handshake that never pipes is a dead UI
  });

  it('destroys an upgrade with no session rather than forwarding it', async () => {
    // This is the hole that kept the websocket out of 0.63.0: a hand-rolled
    // principal would fall back to LOCAL_OWNER and forward anonymously.
    const { port } = await world(undefined);
    expect((await upgrade(port, '/v1/agents/a1/ui/')).status).toMatch(/DESTROYED|TIMEOUT/);
  });

  it('destroys an upgrade for an agent the caller does not own', async () => {
    const { port } = await world({ ownerId: 'someone-else', via: 'identity' });
    expect((await upgrade(port, '/v1/agents/a1/ui/')).status).toMatch(/DESTROYED|TIMEOUT/);
  });
});


describe('the console can be embedded by Hatchabot, and only by Hatchabot', () => {
  // OpenClaw forbids framing (X-Frame-Options: DENY, frame-ancestors 'none'),
  // which forced the console into a separate tab. Served through the proxy it
  // is same-origin, so it may be framed by this app — and by no other site.
  it('relaxes framing to same-origin, and keeps the rest of the policy', async () => {
    const { port } = await world({ ownerId: OWNER, via: 'identity' });
    const prev = process.env.HATCHABOT_ALLOW_OWNER_HEADER;
    process.env.HATCHABOT_ALLOW_OWNER_HEADER = '1';
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents/a1/ui/index.html`, { headers: { 'x-hatchabot-owner': OWNER } })
      .finally(() => { if (prev === undefined) delete process.env.HATCHABOT_ALLOW_OWNER_HEADER; else process.env.HATCHABOT_ALLOW_OWNER_HEADER = prev; });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'"); // everything else untouched
  });
});

describe('approving the console for a new browser', () => {
  // OpenClaw's instruction — "run openclaw devices approve <id> on the Gateway
  // host" — means a shell inside the agent's container. Hatchabot approves on
  // the owner's behalf instead, and only a request made in the last minutes.
  const setup = async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a', workspace: { files: {}, configPatch: { agentId: 'a', authMode: 'api-key' } as never }, env: {} } as never);
    await provider.start(runtimeRef);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'A', slug: 'a', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    const now = Date.now();
    provider.execResponses.set('devices list --json', {
      code: 0, stderr: '',
      stdout: JSON.stringify({
        pending: [
          { requestId: 'fresh-0000-1111', ts: now - 30_000 },     // the one this person just caused
          { requestId: 'stale-2222-3333', ts: now - 3_600_000 },  // sitting there an hour: not ours
        ],
        paired: [],
      }),
    });
    provider.execResponses.set('devices approve', { code: 0, stdout: '', stderr: '' });
    const app = Fastify();
    await registerRoutes(app, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    return { app, provider };
  };

  it('approves only a recent request, for the owner', async () => {
    const prev = process.env.HATCHABOT_ALLOW_OWNER_HEADER;
    process.env.HATCHABOT_ALLOW_OWNER_HEADER = '1';
    try {
      const { app, provider } = await setup();
      const pending = await app.inject({ method: 'GET', url: '/v1/agents/a1/console/pending', headers: { 'x-hatchabot-owner': OWNER } });
      expect(pending.json().pending).toBe(1); // the stale one is not offered

      const res = await app.inject({ method: 'POST', url: '/v1/agents/a1/console/approve', headers: { 'x-hatchabot-owner': OWNER } });
      expect(res.statusCode).toBe(200);
      expect(res.json().approved).toBe(1);
      const approvals = provider.execLog.filter((a) => a[0] === 'devices' && a[1] === 'approve');
      expect(approvals).toEqual([['devices', 'approve', 'fresh-0000-1111']]);

      // Someone who doesn't own the agent can't approve a browser into it.
      const stranger = await app.inject({ method: 'POST', url: '/v1/agents/a1/console/approve', headers: { 'x-hatchabot-owner': 'user-stranger' } });
      expect(stranger.statusCode).toBe(404);
    } finally {
      if (prev === undefined) delete process.env.HATCHABOT_ALLOW_OWNER_HEADER; else process.env.HATCHABOT_ALLOW_OWNER_HEADER = prev;
    }
  });
});
