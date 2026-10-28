import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doorScript } from '../src/embedder/door.js';
import { embedKeyHash } from '../src/embedder/embedder.js';

/**
 * The embedding service's front door, run as it runs in its container
 * (`node -e`), against a stand-in llama server. The keys file is what
 * Hatchabot writes; the door reads it when it changes.
 */

const upstreamSeen: Array<{ auth?: string; body: string }> = [];
let upstream: Server;
let upstreamPort = 0;
let door: ChildProcess;
let doorPort = 0;
let doorOut = '';
const keysFile = join(mkdtempSync(join(tmpdir(), 'hb-door-')), 'keys.json');
const KEY_A = 'agent-a-secret-key';
const KEY_R = 'agent-r-secret-key'; // its own bucket, for the rate-limit case
const KEY_M = 'agent-m-secret-key'; // its own byte budget (HB-0026)

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
      upstreamSeen.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }], model: 'embeddinggemma' }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = (upstream.address() as { port: number }).port;
  writeFileSync(keysFile, JSON.stringify({ [embedKeyHash(KEY_A)]: 'agent-a', [embedKeyHash(KEY_R)]: 'agent-r', [embedKeyHash(KEY_M)]: 'agent-m', [embedKeyHash('guest-key-t2')]: 'guest:t2' }));
  writeFileSync(join(keysFile, '..', 'server-key'), 'server-secret\n');
  door = spawn(process.execPath, ['-e', doorScript()], {
    env: {
      ...process.env,
      EMBED_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      EMBED_SERVER_KEY_FILE: join(keysFile, '..', 'server-key'),
      EMBED_KEYS_FILE: keysFile,
      EMBED_PER_MIN: '3',
      EMBED_MB_PER_MIN: '0.01', // 10,485 bytes a minute
      EMBED_GUEST_FACTOR: '4',
      EMBED_KEYS_TTL_MS: '0',
      EMBED_DOOR_PORT: '0',
    },
  });
  await new Promise<void>((resolve, reject) => {
    door.stdout!.on('data', (c) => {
      doorOut += c.toString();
      const m = /"listening":(\d+)/.exec(doorOut);
      if (m && !doorPort) { doorPort = Number(m[1]); resolve(); }
    });
    door.on('exit', (code) => reject(new Error(`door exited ${code}`)));
    setTimeout(() => reject(new Error('door did not start')), 5000);
  });
}, 10_000);

afterAll(() => { door?.kill(); upstream?.close(); });

const call = (token: string | undefined, body: unknown, method = 'POST', path = '/v1/embeddings') =>
  fetch(`http://127.0.0.1:${doorPort}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });

describe('the embed door', () => {
  it('forwards a keyed call with the server key, and passes the answer back', async () => {
    const r = await call(KEY_A, { input: ['what car do they drive'], model: 'embeddinggemma' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).data[0].embedding).toEqual([0.1, 0.2, 0.3]);
    expect(upstreamSeen.at(-1)).toEqual({ auth: 'Bearer server-secret', body: JSON.stringify({ input: ['what car do they drive'], model: 'embeddinggemma' }) });
  });

  it('refuses no key, a wrong key, other paths — and never logs a body', async () => {
    expect((await call(undefined, { input: 'x' })).status).toBe(401);
    expect((await call('not-a-key', { input: 'x' })).status).toBe(401);
    expect((await call(KEY_A, {}, 'GET', '/v1/models')).status).toBe(404);
    expect((await call(KEY_A, '{not json')).status).toBe(400);
    expect(doorOut).toContain('"agent":"agent-a"');
    expect(doorOut).not.toContain('what car');
  });

  it('caps the inputs per call and rate-limits per agent', async () => {
    expect((await call(KEY_A, { input: Array.from({ length: 257 }, () => 'x') })).status).toBe(413);
    // Three a minute in this test, counted before the body is read (a refused
    // call costs as much as a served one — cheaper for the door that way).
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await call(KEY_R, { input: 'x' })).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    // A guest tenant's key stands for its whole fleet: four times an agent's share here (30th audit).
    const guest: number[] = [];
    for (let i = 0; i < 13; i++) guest.push((await call('guest-key-t2', { input: 'x' })).status);
    expect(guest).toEqual([...Array(12).fill(200), 429]);
  });

  it('holds each agent to a byte budget, not only a call count (HB-0026)', async () => {
    // Two 6 KB calls: the first fits, the second is let in (the budget is not
    // yet spent) and leaves it in debt, so a third, tiny one is refused —
    // though one call of the three a minute is still left.
    const big = { input: ['m'.repeat(6000)] };
    const codes = [(await call(KEY_M, big)).status, (await call(KEY_M, big)).status, (await call(KEY_M, { input: 'x' })).status];
    expect(codes).toEqual([200, 200, 429]);
  });

  it('picks up a re-minted key from the file without a restart', async () => {
    writeFileSync(keysFile, JSON.stringify({ [embedKeyHash('agent-b-key')]: 'agent-b' }));
    await new Promise((r) => setTimeout(r, 20));
    expect((await call('agent-b-key', { input: 'y' })).status).toBe(200);
    expect((await call(KEY_A, { input: 'y' })).status).toBe(401); // the old key died with the rebuild
  });

  it('a keys file it could not read is read again, even when its time stamp has not moved (B066)', async () => {
    // Half written: refused for now. Then whole, with the same mtime (a write
    // in the same instant, or a coarse clock): the door must not keep the empty set.
    const at = new Date('2026-01-01T00:00:00Z');
    writeFileSync(keysFile, '{"half');
    utimesSync(keysFile, at, at);
    expect((await call('agent-c-key', { input: 'z' })).status).toBe(401);
    writeFileSync(keysFile, JSON.stringify({ [embedKeyHash('agent-c-key')]: 'agent-c' }));
    utimesSync(keysFile, at, at);
    expect((await call('agent-c-key', { input: 'z' })).status).toBe(200);
  });

  it('answers /health for the server behind it, only to a caller with a key (HB-0040)', async () => {
    const health = (key?: string) => fetch(`http://127.0.0.1:${doorPort}/health`, key ? { headers: { authorization: `Bearer ${key}` } } : {});
    expect((await health()).status).toBe(401);
    expect((await health('not-a-key')).status).toBe(401);
    expect((await health('server-secret')).status).toBe(200);
    expect((await health('agent-c-key')).status).toBe(200);
  });
});
