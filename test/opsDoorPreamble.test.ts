import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { createOpsServer, withDoormanPreamble, loopbackDoorman } from '../src/ops/opsServer.js';

/**
 * The doorman announces itself ("HBDM <key>") before its first byte of HTTP:
 * where a peer's address proves nothing — the door on loopback, a rootless
 * daemon's containers all arriving as 127.0.0.1 — the preamble does (30th
 * audit). An unsigned connection is judged by its address, as before.
 */
async function door(peerOk: boolean) {
  const server = createOpsServer({
    mcp: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    allowedHosts: () => undefined,
    peerOk: async () => peerOk,
    doormanKeyOk: (k) => k === 'good-key',
  });
  const raw = withDoormanPreamble(server, (k) => k === 'good-key');
  await new Promise<void>((r) => raw.listen(0, '127.0.0.1', () => r()));
  const port = (raw.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((r) => raw.close(() => r())) };
}
const talk = (port: number, preamble: string) => new Promise<string>((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => {
    s.write(preamble + 'POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}');
  });
  let out = ''; s.on('data', (c) => { out += c; }); s.on('close', () => resolve(out)); s.on('error', () => resolve(out));
});

describe('the door and the doorman preamble', () => {
  afterEach(() => { delete process.env.HATCHABOT_CONTAINERS_ON_LOOPBACK; });

  it('a signed connection is served though its address is nobody; a wrong key is dropped; an unsigned one is judged by its address', async () => {
    const d = await door(false);
    try {
      expect(await talk(d.port, 'HBDM good-key\n')).toMatch(/^HTTP\/1\.1 200/);
      expect(await talk(d.port, 'HBDM wrong\n')).toBe('');
      expect(await talk(d.port, '')).toMatch(/^HTTP\/1\.1 403/);
    } finally { await d.close(); }
  });

  it('an unsigned connection from a trusted address still works (a doorman from before the rule)', async () => {
    const d = await door(true);
    try {
      expect(await talk(d.port, '')).toMatch(/^HTTP\/1\.1 200/);
      // Headers and body in separate packets (http.request), keep-alive.
      const res = await new Promise<number>((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: d.port, method: 'POST', path: '/mcp', headers: { 'content-type': 'application/json' }, agent: false }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
        req.write('{}');
        req.end();
      });
      expect(res).toBe(200);
    } finally { await d.close(); }
  });

  it('under a rootless daemon a bare loopback peer is not a doorman', () => {
    process.env.HATCHABOT_CONTAINERS_ON_LOOPBACK = '1';
    expect(loopbackDoorman('127.0.0.1')).toBe(false);
  });
});
