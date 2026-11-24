import { describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { createOpsServer } from '../src/ops/opsServer.js';

/** Night review, 2026-09-27: the ops proxy's cap is per manager, and idle tunnels close. */
describe('the ops proxy, shared by several managers', () => {
  it("one manager holding its whole cap does not starve another's, and an idle tunnel gives its slot back", async () => {
    process.env.HATCHABOT_OPS_MAX_TUNNELS = '2';
    process.env.HATCHABOT_OPS_TUNNEL_IDLE_MS = '600';
    const dialed: net.Socket[] = [];
    const server = createOpsServer({
      mcp: async () => undefined,
      allowedHosts: (t) => (t === 'k' || t === 'm' ? ['api.example.com'] : undefined),
      dial: () => { const s = new net.Socket(); dialed.push(s); return s; },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const open: net.Socket[] = [];
    const connect = (key: string): Promise<string> => new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(`CONNECT api.example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from(`ops:${key}`).toString('base64')}\r\n\r\n`);
      });
      open.push(sock);
      sock.once('data', (b: Buffer) => resolve(b.toString()));
      sock.once('error', () => resolve('error'));
      setTimeout(() => resolve(''), 250); // no answer = the tunnel is being held
    });
    try {
      expect(await connect('k')).toBe('');
      expect(await connect('k')).toBe('');
      expect(await connect('k')).toMatch(/429/);   // k is at its cap
      expect(await connect('m')).toBe('');         // m is not starved by k
      await new Promise((r) => setTimeout(r, 900)); // k's tunnels sit idle past the timeout
      expect(await connect('k')).not.toMatch(/429/);
    } finally {
      delete process.env.HATCHABOT_OPS_MAX_TUNNELS;
      delete process.env.HATCHABOT_OPS_TUNNEL_IDLE_MS;
      open.forEach((s) => s.destroy());
      dialed.forEach((s) => s.destroy());
      server.close();
    }
  }, 20_000);

  it('a manager that leaves while its door is checked dials nothing and keeps no slot (HB-0941)', async () => {
    process.env.HATCHABOT_OPS_MAX_TUNNELS = '1';
    const dialed: net.Socket[] = [];
    const checks: Array<(ok: boolean) => void> = [];
    // The server's own CONNECT handler, with sockets that reach nothing: nothing leaves this machine.
    const server = createOpsServer({
      mcp: async () => undefined,
      allowedHosts: () => ['api.example.com'],
      peerOk: () => new Promise<boolean>((r) => { checks.push(r); }),
      dial: () => { const s = new net.Socket(); dialed.push(s); return s; },
    });
    const req = { url: 'api.example.com:443', headers: { 'proxy-authorization': `Basic ${Buffer.from('ops:k').toString('base64')}` } };
    const turn = () => new Promise((r) => setImmediate(r));
    try {
      const leaving = new net.Socket();
      server.emit('connect', req, leaving, Buffer.alloc(0));
      expect(checks).toHaveLength(1);
      leaving.destroy();
      await turn();
      checks[0]!(true);
      await turn();
      expect(dialed).toEqual([]);
      // The cap's one slot is the next manager's.
      const next = new net.Socket();
      const refused: string[] = [];
      next.end = ((answer: string) => { refused.push(answer); return next; }) as never;
      server.emit('connect', req, next, Buffer.alloc(0));
      checks[1]!(true);
      await turn();
      expect(refused).toEqual([]);
      expect(dialed).toHaveLength(1);
      next.destroy();
    } finally {
      delete process.env.HATCHABOT_OPS_MAX_TUNNELS;
      dialed.forEach((s) => s.destroy());
      server.close();
    }
  });

  it('a manager that hangs up its half while its door is checked dials nothing either (HB-0941 review)', async () => {
    process.env.HATCHABOT_OPS_MAX_TUNNELS = '1';
    const dialed: net.Socket[] = [];
    const checks: Array<(ok: boolean) => void> = [];
    const server = createOpsServer({
      mcp: async () => undefined,
      allowedHosts: () => ['api.example.com'],
      peerOk: () => new Promise<boolean>((r) => { checks.push(r); }),
      dial: () => { const s = new net.Socket(); dialed.push(s); return s; },
    });
    // The server's end of each connection, to know when the client's FIN has reached it.
    const theirs: net.Socket[] = [];
    server.on('connection', (s: net.Socket) => theirs.push(s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const ask = `CONNECT api.example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from('ops:k').toString('base64')}\r\n\r\n`;
    const clients: net.Socket[] = [];
    const client = () => new Promise<net.Socket>((resolve) => {
      const c = net.connect(port, '127.0.0.1', () => { c.write(ask); resolve(c); });
      c.on('error', () => {});
      clients.push(c);
    });
    try {
      const leaving = await client();
      await vi.waitFor(() => expect(checks).toHaveLength(1));
      // It sends its FIN and waits: an http socket is half-open, so no close comes, and it is not destroyed.
      const fin = new Promise((r) => theirs[0]!.once('end', r));
      leaving.end();
      await fin;
      checks[0]!(true);
      await new Promise((r) => setImmediate(r));
      expect(dialed).toEqual([]);
      // Its slot is the next manager's.
      const next = await client();
      const answer = new Promise<string>((r) => next.once('data', (b: Buffer) => r(b.toString())));
      await vi.waitFor(() => expect(checks).toHaveLength(2));
      checks[1]!(true);
      await vi.waitFor(() => expect(dialed).toHaveLength(1));
      // Its far end never answers here: no 429, nothing written yet.
      expect(await Promise.race([answer, new Promise((r) => setTimeout(() => r('none'), 100))])).toBe('none');
    } finally {
      delete process.env.HATCHABOT_OPS_MAX_TUNNELS;
      clients.forEach((s) => s.destroy());
      dialed.forEach((s) => s.destroy());
      server.close();
    }
  });
});
