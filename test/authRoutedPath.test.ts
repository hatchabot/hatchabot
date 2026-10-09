import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { connect } from 'node:net';
import Database from 'better-sqlite3';
import { registerAuth } from '../src/api/auth.js';
import { principalOf } from '../src/api/principal.js';
import { routedPath } from '../src/api/routedPath.js';
import { Store } from '../src/store/store.js';

/**
 * The sign-in hooks exempt the agent-to-agent consult (POST
 * /v1/agents/:id/message, whose caller's token is checked in the handler).
 * The exemption used to test the raw URL with a regex, but the router stops
 * at "#": "/v1/agents/<id>#/message" matched the regex, skipped the sign-in
 * check, and was served as GET /v1/agents/<id> — with no principal, which
 * falls back to the local owner: everything, in password mode (2026-10-09).
 */
const SECRET = Buffer.alloc(32, 7);

async function app(mode: 'password' | 'accounts') {
  const f = Fastify();
  const store = new Store(new Database(':memory:'));
  await registerAuth(f, mode === 'password'
    ? { password: 'the-real-one', secret: SECRET, mode: 'password' }
    : { secret: SECRET, mode: 'accounts', store, cliTokenOwner: (t) => store.ownerForCliToken(t), cliTokenScope: (t) => store.cliTokenScope(t) });
  // Stand-ins for the real routes: what each would serve, and to whom.
  f.get('/v1/agents/:id', async (req) => ({ served: 'agent', owner: principalOf(req).ownerId }));
  f.get('/v1/agents/:id/env', async (req) => ({ served: 'env', owner: principalOf(req).ownerId }));
  f.post('/v1/agents/:id/message', async () => ({ served: 'message' }));
  return f;
}

/** Raw HTTP to a real socket: inject() parses the URL and drops the fragment, so it cannot send what an attacker's client sends. */
function raw(port: number, method: string, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.end(`${method} ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${method === 'POST' ? 'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}' : '\r\n'}`));
    let data = '';
    sock.on('data', (c) => (data += c));
    sock.on('end', () => resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1] ?? 0), body: data.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
    sock.on('error', reject);
  });
}

describe('a "#" cannot steer a request past the sign-in check', () => {
  for (const mode of ['password', 'accounts'] as const) {
    it(`${mode}: "/v1/agents/<id>#/message" is refused, not served as the agent`, async () => {
      const f = await app(mode);
      await f.listen({ port: 0, host: '127.0.0.1' });
      const port = (f.server.address() as { port: number }).port;
      try {
        for (const url of ['/v1/agents/a1#/message', '/v1/agents/a1/env#/message', '/v1/agents/a1?x=1#/message']) {
          const r = await raw(port, 'GET', url);
          expect(r.status, url).toBe(401);
          expect(r.body, url).not.toContain('served');
        }
      } finally { await f.close(); }
    });

    it(`${mode}: the consult itself still reaches its handler (its token is checked there)`, async () => {
      const f = await app(mode);
      const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/message', payload: {} });
      expect(r.json()).toEqual({ served: 'message' });
      // Only that route and method: a GET of the same path is not exempt.
      expect((await f.inject({ method: 'GET', url: '/v1/agents/a1/message' })).statusCode).not.toBe(200);
    });
  }

  it('routedPath cuts at "?" and "#", as the router does', () => {
    expect(routedPath('/v1/agents/a1#/message')).toBe('/v1/agents/a1');
    expect(routedPath('/v1/agents?x=1#y')).toBe('/v1/agents');
    expect(routedPath('/v1/login')).toBe('/v1/login');
  });
});
