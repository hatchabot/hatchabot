import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { etagMatches, registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * The page was 778 KB per load and the /v1/agents poll 91 KB every 8 s, sent
 * uncompressed and never cached (review, 2026-09-29). These pin what is now
 * compressed, what must never be (the console proxy and the file streams),
 * and the page's ETag: a current copy costs a 304, a deploy never matches.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const webIndexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'index.html');
const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

let toClose: Array<FastifyInstance | Server> = [];
afterEach(() => {
  for (const s of toClose) {
    const raw: any = (s as any).server ?? s;
    try { raw.closeAllConnections?.(); raw.close?.(() => {}); raw.unref?.(); } catch { /* already gone */ }
  }
  toClose = [];
});

async function world(opts: { appVersion?: string; agents?: number; gatewayPort?: number } = {}) {
  const db = new Database(':memory:');
  const store = new Store(db);
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.setAgentRuntimeRef('a1', runtimeRef); store.setAgentState('a1', 'RUNNING');
  for (let i = 0; i < (opts.agents ?? 0); i++) {
    store.insertAgent({ id: `x${i}`, ownerId: OWNER, name: `Helper number ${i}`, slug: `helper-${i}`, state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', persona: 'A patient helper who keeps the household calendar and shopping list in order.', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  }
  if (opts.gatewayPort) db.prepare('UPDATE agents SET gateway_port = ?, gateway_token = ? WHERE id = ?').run(opts.gatewayPort, 'gw-token', 'a1');
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    webIndexPath, appVersion: opts.appVersion,
  });
  toClose.push(f);
  return { f, provider, store };
}

const BIG_HTML = `<!doctype html><html><head><title>console</title></head><body>${'<p>OpenClaw console body text that repeats.</p>'.repeat(200)}</body></html>`;
const BIG_JS = `const x = ${JSON.stringify('asset '.repeat(1000))};`;

async function fakeGateway(): Promise<number> {
  const server = createServer((req, res) => {
    if (/\.js$/.test(req.url ?? '')) { res.setHeader('Content-Type', 'text/javascript'); res.end(BIG_JS); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(BIG_HTML);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  toClose.push(server);
  return (server.address() as any).port;
}

describe('the page', () => {
  it('is gzip or brotli when the browser asks, and plain when it does not', async () => {
    const { f } = await world({ appVersion: '9.9.9' });
    const plain = await f.inject({ method: 'GET', url: '/' });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body).toContain('window.HATCHABOT_VERSION="9.9.9"');
    expect(plain.headers['x-hatchabot-version']).toBe('9.9.9');

    const gz = await f.inject({ method: 'GET', url: '/', headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers['content-encoding']).toBe('gzip');
    expect(gz.headers.vary).toMatch(/accept-encoding/i);
    expect(gunzipSync(gz.rawPayload).toString('utf8')).toBe(plain.body);

    const br = await f.inject({ method: 'GET', url: '/', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(br.headers['content-encoding']).toBe('br');
    expect(brotliDecompressSync(br.rawPayload).toString('utf8')).toBe(plain.body);

    // Measured (review, 2026-09-29): what a load costs before and after.
    console.info(`[compression] / identity=${plain.rawPayload.length} gzip=${gz.rawPayload.length} br=${br.rawPayload.length}`);
    expect(gz.rawPayload.length).toBeLessThan(plain.rawPayload.length / 2);
  });

  it('revalidates instead of never storing: an ETag, no-cache, and a 304 for a current copy', async () => {
    const { f } = await world({ appVersion: '9.9.9' });
    const first = await f.inject({ method: 'GET', url: '/', headers: { 'accept-encoding': 'gzip' } });
    expect(first.headers['cache-control']).toBe('no-cache');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^W\/"9\.9\.9-[\w-]+"$/);

    const again = await f.inject({ method: 'GET', url: '/', headers: { 'accept-encoding': 'gzip', 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
    expect(again.headers.etag).toBe(etag);
    expect(again.headers['cache-control']).toBe('no-cache');

    const stale = await f.inject({ method: 'GET', url: '/', headers: { 'if-none-match': 'W/"9.9.8-old"' } });
    expect(stale.statusCode).toBe(200);
    expect(stale.body).toContain('HATCHABOT_VERSION');
  });

  it('a deploy (a new version) changes the ETag, so no old copy is ever reused', async () => {
    const a = (await (await world({ appVersion: '2.103.0' })).f.inject({ method: 'GET', url: '/' })).headers.etag;
    const a2 = (await (await world({ appVersion: '2.103.0' })).f.inject({ method: 'GET', url: '/' })).headers.etag;
    const b = await (await world({ appVersion: '2.104.0' })).f.inject({ method: 'GET', url: '/', headers: { 'if-none-match': String(a) } });
    expect(a2).toBe(a); // stable across restarts of one version
    expect(b.headers.etag).not.toBe(a);
    expect(b.statusCode).toBe(200);
    expect(b.body).toContain('window.HATCHABOT_VERSION="2.104.0"');
  });

  it('matches If-None-Match by weak comparison', () => {
    expect(etagMatches(undefined, 'W/"1-a"')).toBe(false);
    expect(etagMatches('W/"1-a"', 'W/"1-a"')).toBe(true);
    expect(etagMatches('"1-a"', 'W/"1-a"')).toBe(true);
    expect(etagMatches('"x", W/"1-a"', 'W/"1-a"')).toBe(true);
    expect(etagMatches('*', 'W/"1-a"')).toBe(true);
    expect(etagMatches('W/"1-b"', 'W/"1-a"')).toBe(false);
  });

  it('the service worker is still revalidated every load, so it updates after a deploy', async () => {
    const { f } = await world();
    const sw = await f.inject({ method: 'GET', url: '/sw.js' });
    expect(sw.statusCode).toBe(200);
    expect(sw.headers['cache-control']).toBe('no-cache');
  });
});

describe('JSON', () => {
  it('/v1/agents is compressed when asked, and small answers are not', async () => {
    const { f } = await world({ agents: 60 });
    const plain = await f.inject({ method: 'GET', url: '/v1/agents', headers: as });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();
    const gz = await f.inject({ method: 'GET', url: '/v1/agents', headers: { ...as, 'accept-encoding': 'gzip, br' } });
    expect(gz.headers['content-encoding']).toBe('br');
    expect(JSON.parse(brotliDecompressSync(gz.rawPayload).toString('utf8'))).toEqual(plain.json());
    console.info(`[compression] /v1/agents (61 agents) identity=${plain.rawPayload.length} br=${gz.rawPayload.length}`);
    // Under the ~1 KB threshold compression costs more than it saves.
    const small = await f.inject({ method: 'GET', url: '/healthz', headers: { 'accept-encoding': 'gzip' } });
    expect(small.headers['content-encoding']).toBeUndefined();
  });
});

describe('never compressed', () => {
  it('the console proxy: its page is rewritten and its assets pass through as the gateway sent them', async () => {
    const { f } = await world({ gatewayPort: await fakeGateway() });
    const doc = await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/chat', headers: { ...as, 'accept-encoding': 'gzip, br' } });
    expect(doc.statusCode).toBe(200);
    expect(doc.headers['content-encoding']).toBeUndefined();
    expect(doc.body).toContain('OpenClaw console body text');
    const js = await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/assets/app.js', headers: { ...as, 'accept-encoding': 'gzip, br' } });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-encoding']).toBeUndefined();
    expect(js.body).toBe(BIG_JS);
  });

  it('file downloads and archives stream as they are, with their length', async () => {
    const { f, provider } = await world();
    const text = 'a line of a text file the agent wrote\n'.repeat(200);
    provider.execResponses.set('sh-volume', { code: 0, stdout: `regular file\t${text.length}\n`, stderr: '' });
    provider.streamBytes = Buffer.from(text);
    for (const url of ['/v1/agents/a1/fs/file?path=out/notes.txt', '/v1/agents/a1/fs/file?path=out/notes.txt&inline=1']) {
      const r = await f.inject({ method: 'GET', url, headers: { ...as, 'accept-encoding': 'gzip, br' } });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers['content-encoding'], url).toBeUndefined();
      expect(r.headers['content-length'], url).toBe(String(text.length));
      expect(r.body, url).toBe(text);
    }
    provider.execResponses.set('sh-volume', { code: 0, stdout: '12345\n', stderr: '' });
    const arc = await f.inject({ method: 'GET', url: '/v1/agents/a1/fs/archive?path=out', headers: { ...as, 'accept-encoding': 'gzip, br' } });
    expect(arc.statusCode).toBe(200);
    expect(arc.headers['content-encoding']).toBeUndefined();
    expect(arc.body).toBe(text);
  });
});
