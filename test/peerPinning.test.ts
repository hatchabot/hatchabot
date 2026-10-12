import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { allowedPeerIp, pinnedPeerFetch } from '../src/api/peerAddress.js';
import { registerRoutes } from '../src/api/routes.js';
import { migrateAgent } from '../src/orchestrator/migrate.js';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { MemSecrets, OWNER, as, makeWorld, seedRunningAgent } from './support/world.js';

/**
 * Calls to another Hatchabot server (issues #200, #201): the address a NAME
 * resolves to is judged as the socket dials it, and a redirect is refused
 * rather than followed — for the registration probe, every migration call and
 * the consolidated bot census alike.
 */

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise((r) => s.close(r)); });

/** A loopback server; `hits` records each request it got (method, path, body bytes). */
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const hits: Array<{ method: string; path: string; bytes: number }> = [];
  const s = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => { bytes += c.length; });
    req.on('end', () => { hits.push({ method: req.method!, path: req.url!, bytes }); handler(req, res); });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  servers.push(s);
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, port: (s.address() as { port: number }).port, hits };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

describe('the resolved-address policy', () => {
  it.each(['127.0.0.1', '127.8.9.10', '0.0.0.0', '169.254.169.254', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.1.1', 'fe80::1', '::127.0.0.1', 'not-an-ip'])('refuses %s', (ip) => {
    expect(allowedPeerIp(ip)).toBe(false);
  });
  it.each(['192.168.1.2', '10.0.0.7', '100.101.102.103', 'fd00::2', '2001:db8::2', '::ffff:192.168.1.2', '203.0.113.9'])('allows %s', (ip) => {
    expect(allowedPeerIp(ip)).toBe(true);
  });
});

describe('pinnedPeerFetch', () => {
  it('refuses a name that resolves to loopback, before anything is sent there (#200)', async () => {
    const target = await serve((_q, r) => json(r, 200, []));
    for (const address of ['127.0.0.1', '::ffff:127.0.0.1']) {
      const resolve = async () => [{ address, family: address.includes(':') ? 6 : 4 }];
      await expect(pinnedPeerFetch(`http://peer.example.org:${target.port}/v1/agents`, {}, resolve)).rejects.toThrow(/local address/);
    }
    expect(target.hits).toEqual([]);
  });

  it('refuses a name when any of its addresses is local (one answer is not trusted over another)', async () => {
    const resolve = async () => [{ address: '192.168.1.2', family: 4 }, { address: '169.254.169.254', family: 4 }];
    await expect(pinnedPeerFetch('http://peer.example.org:9/v1/agents', {}, resolve)).rejects.toThrow(/local address/);
  });

  it('dials the address it judged: a name answering differently on a second lookup gains nothing', async () => {
    let lookups = 0;
    const resolve = async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; };
    await expect(pinnedPeerFetch('http://peer.example.org:9/', {}, resolve)).rejects.toThrow(/local address/);
    expect(lookups).toBe(1);
  });

  it('refuses a redirect and does not follow it, nor carry the body there (#201)', async () => {
    const elsewhere = await serve((_q, r) => json(r, 200, { ok: true }));
    const peer = await serve((_q, r) => { r.writeHead(307, { location: `${elsewhere.url}/v1/agents/restore` }).end(); });
    await expect(pinnedPeerFetch(`${peer.url}/v1/agents/restore`, { method: 'POST', body: new Uint8Array([1, 2, 3]) })).rejects.toThrow(/redirect \(307\)/);
    expect(peer.hits).toHaveLength(1);
    expect(elsewhere.hits).toEqual([]);
  });

  it('answers like fetch for an ordinary call: status, headers, JSON and the body sent', async () => {
    const peer = await serve((q, r) => json(r, q.method === 'POST' ? 201 : 200, { method: q.method, auth: q.headers.authorization }));
    const got = await pinnedPeerFetch(`${peer.url}/v1/agents/preflight`, { method: 'POST', headers: { authorization: 'Bearer fixture-credential', 'content-type': 'application/json' }, body: '{"slug":"kitchen"}' });
    expect(got.status).toBe(201);
    expect(got.ok).toBe(true);
    expect(await got.json()).toEqual({ method: 'POST', auth: 'Bearer fixture-credential' });
    expect(peer.hits[0]).toMatchObject({ method: 'POST', bytes: 18 });
  });
});

describe('every call to a peer uses it by default', () => {
  it('a migration whose peer redirects is not followed to the other address (#201)', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Kitchen', slug: 'kitchen', accountId: 'kitchenbot', botToken: 'fixture-value' });
    await w.secrets.put('peer/tok', 'fixture-credential');
    const elsewhere = await serve((_q, r) => json(r, 200, { ok: true, reasons: [] }));
    const peer = await serve((q, r) => { r.writeHead(308, { location: `${elsewhere.url}${q.url}` }).end(); });
    await expect(migrateAgent({ store: w.store, secrets: w.secrets, provider: w.provider, channel: w.channel, sleep: async () => {} }, id,
      { id: 'p1', name: 'Desktop', url: peer.url, secretRef: 'peer/tok' })).rejects.toThrow(/Couldn't reach Desktop/);
    expect(elsewhere.hits).toEqual([]);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING'); // refused at preflight: nothing stopped
  });

  it('the consolidated bot census does not follow a peer\'s redirect (#201)', async () => {
    const store = new Store(new Database(':memory:'));
    const secrets = new MemSecrets();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    const f = Fastify();
    const channel = { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0, list: () => [] } };
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel } as never);
    const elsewhere = await serve((_q, r) => json(r, 200, { hosts: [{ host: 'x', bots: [] }] }));
    const peer = await serve((q, r) => { r.writeHead(302, { location: `${elsewhere.url}${q.url}` }).end(); });
    await secrets.put('peer/tok', 'fixture-credential');
    store.insertPeer({ id: 'p1', ownerId: OWNER, name: 'Desktop', url: peer.url, secretRef: 'peer/tok', createdAt: 'now' });
    const r = await f.inject({ method: 'GET', url: '/v1/bots?consolidated=1', headers: as() });
    expect(r.statusCode).toBe(200);
    const desk = r.json().hosts.find((h: { host: string }) => h.host === 'Desktop');
    expect(desk.error).toMatch(/redirect/);
    expect(elsewhere.hits).toEqual([]);
    await f.close();
  });
});
