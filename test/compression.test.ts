import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { etagMatches, versionMarkup } from '../src/api/pageRoutes.js';
import { metaVersion, versionMarker } from '../src/doctor.js';
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

async function world(opts: { appVersion?: string; agents?: number; gatewayPort?: number; web?: string } = {}) {
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
    webIndexPath: opts.web ? join(opts.web, 'index.html') : webIndexPath, webJoinPath: join(opts.web ?? dirname(webIndexPath), 'join.html'), appVersion: opts.appVersion,
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
    expect(plain.body).toContain('<meta name="hatchabot-version" content="9.9.9">');
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
    expect(versionMarker(b.body)).toBe('2.104.0');
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

describe("the page's scripts (web/app/, HB-0811)", () => {
  const srcs = (html: string) => [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]!);

  it('the page names each script by its digest, and each comes back as that file, cached for good', async () => {
    const { f } = await world({ appVersion: '9.9.9' });
    const page = await f.inject({ method: 'GET', url: '/' });
    const names = srcs(page.body);
    expect(names.length).toBeGreaterThan(10);
    expect(page.body).not.toContain('src="app/');
    for (const src of names) {
      const m = /^\/app\/([a-z0-9-]+\.js)\?v=([\w-]{22})$/.exec(src);
      expect(m, src).not.toBeNull();
      const res = await f.inject({ method: 'GET', url: src });
      expect(res.statusCode, src).toBe(200);
      expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.body).toBe(readFileSync(join(dirname(webIndexPath), 'app', m![1]!), 'utf8'));
      expect((await f.inject({ method: 'GET', url: src, headers: { 'if-none-match': String(res.headers.etag) } })).statusCode).toBe(304);
    }
  });

  it('by any other address a script is the current file, revalidated each time; nothing else is read', async () => {
    const { f } = await world();
    for (const url of ['/app/core.js', '/app/core.js?v=an-old-digest']) {
      const res = await f.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('no-cache');
    }
    for (const url of ['/app/missing.js', '/app/Core.js', '/app/core.txt', '/app/..%2fsw.js', '/app/%2e%2e%2findex.html', '/app/', '/app/a/b.js']) {
      expect((await f.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it('is compressed when the browser asks', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'GET', url: '/app/home.js', headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(res.rawPayload).toString('utf8')).toBe(readFileSync(join(dirname(webIndexPath), 'app', 'home.js'), 'utf8'));
  });

  it('an edited script shows at once: a new digest in the page, so a new ETag for it', async () => {
    const web = mkdtempSync(join(tmpdir(), 'hb-page-'));
    try {
      cpSync(dirname(webIndexPath), web, { recursive: true });
      const { f } = await world({ web });
      const before = await f.inject({ method: 'GET', url: '/' });
      const file = join(web, 'app', 'start.js');
      writeFileSync(file, readFileSync(file, 'utf8') + '\n// edited\n');
      utimesSync(file, new Date(), new Date(Date.now() + 5000));
      const after = await f.inject({ method: 'GET', url: '/', headers: { 'if-none-match': String(before.headers.etag) } });
      expect(after.statusCode).toBe(200);
      expect(after.headers.etag).not.toBe(before.headers.etag);
      const changed = srcs(after.body).filter((s) => !srcs(before.body).includes(s));
      expect(changed).toHaveLength(1);
      expect(changed[0]).toMatch(/^\/app\/start\.js\?v=/);
      expect((await f.inject({ method: 'GET', url: changed[0]! })).body).toContain('// edited');
    } finally {
      rmSync(web, { recursive: true, force: true });
    }
  });

  it('the pages run no inline script, so the public address\'s policy can refuse every one (HB-0812)', async () => {
    const { f } = await world({ appVersion: '9.9.9' });
    for (const url of ['/', '/join/ABC123']) {
      const body = (await f.inject({ method: 'GET', url })).body;
      const tags = body.match(/<script\b[^>]*>/gi) ?? [];
      expect(tags.length, url).toBeGreaterThan(1);
      for (const tag of tags) expect(tag, url).toMatch(/^<script src="\/app\/[a-z0-9-]+\.js\?v=[\w-]{22}">$/);
      expect(body.match(/<\/script>/gi)?.length, url).toBe(tags.length);
    }
  });

  it('the version is still the text doctor and the deploy scripts of every release look for', async () => {
    const { f } = await world({ appVersion: '2.191.0' });
    const body = (await f.inject({ method: 'GET', url: '/' })).body;
    expect(versionMarker(body)).toBe('2.191.0');
    // And the meta tag, in the head doctor reads of the page (metaVersion's first 256 KB): a page whose head outgrew it would lose it.
    expect(metaVersion(body)).toBe('2.191.0');
    // scripts/deploy-release.sh and scripts/migrate-rename-host.sh: grep -oE 'HATCHABOT_VERSION="[^"]+"', the first hit.
    for (const script of ['scripts/deploy-release.sh', 'scripts/migrate-rename-host.sh']) expect(readFileSync(script, 'utf8')).toContain(`grep -oE 'HATCHABOT_VERSION="[^"]+"' | sed -n 1p`);
    expect(/HATCHABOT_VERSION="[^"]+"/.exec(body)?.[0]).toBe('HATCHABOT_VERSION="2.191.0"');
    // Something that is not a version cannot end the comment or the attribute it is written in.
    const word = '1.0.0___script_x__script___--';
    expect(versionMarkup('1.0.0"><script>x</script><!--')).toBe(`<meta name="hatchabot-version" content="${word}"><!-- HATCHABOT_VERSION="${word}" -->`);
  });

  it('the join page names its scripts the same way', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'GET', url: '/join/ABC123' });
    expect(res.statusCode).toBe(200);
    expect(srcs(res.body).map((s) => s.replace(/\?v=.*/, ''))).toEqual(['/app/theme.js', '/app/join.js']);
    for (const src of srcs(res.body)) expect((await f.inject({ method: 'GET', url: src })).headers['cache-control']).toBe('public, max-age=31536000, immutable');
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

describe('the console proxy and what the gateway itself compresses (HB-0043)', () => {
  /** A gateway that gzips whatever it can (as a proxy in front of OpenClaw might), and answers JSON on a document path. */
  async function gzippingGateway(): Promise<{ port: number; asked: () => Record<string, unknown> }> {
    let last: Record<string, unknown> = {};
    const server = createServer((req, res) => {
      last = req.headers;
      if (req.url === '/chat/missing') { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"no such page","href":"/assets/x"}'); return; }
      if (req.url === '/chat/plain') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('base path "" and src="/assets/x.js"'); return; }
      const [type, body] = /\.js$/.test(req.url ?? '') ? ['text/javascript', BIG_JS] : ['text/html; charset=utf-8', BIG_HTML];
      res.writeHead(200, { 'Content-Type': type, 'Content-Encoding': 'gzip' });
      res.end(gzipSync(body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    toClose.push(server);
    return { port: (server.address() as any).port, asked: () => last };
  }

  it('a gzipped asset passes through byte for byte, labelled gzip, never compressed twice', async () => {
    const gw = await gzippingGateway();
    const { f } = await world({ gatewayPort: gw.port });
    const js = await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/assets/app.js', headers: { ...as, 'accept-encoding': 'gzip, br' } });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-encoding']).toBe('gzip');
    expect(gw.asked()['accept-encoding']).toBe('gzip, br');
    expect(gunzipSync(js.rawPayload).toString('utf8')).toBe(BIG_JS);
  });

  it('a document the gateway compressed although it was asked not to is passed on as it came, not rewritten into garbage', async () => {
    const gw = await gzippingGateway();
    const { f } = await world({ gatewayPort: gw.port });
    const doc = await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/chat', headers: { ...as, 'accept-encoding': 'gzip, br' } });
    expect(gw.asked()['accept-encoding']).toBeUndefined();
    expect(doc.statusCode).toBe(200);
    expect(doc.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(doc.rawPayload).toString('utf8')).toBe(BIG_HTML);
  });

  it('an answer on a document path that is not HTML (an error in JSON, plain text) passes untouched, with its status', async () => {
    const gw = await gzippingGateway();
    const { f } = await world({ gatewayPort: gw.port });
    const missing = await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/chat/missing', headers: as });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toMatch(/^application\/json/);
    expect(missing.body).toBe('{"error":"no such page","href":"/assets/x"}');
    const plain = await f.inject({ method: 'GET', url: '/v1/agents/a1/ui/chat/plain', headers: as });
    expect(plain.statusCode).toBe(200);
    expect(plain.body).toBe('base path "" and src="/assets/x.js"');
  });
});
