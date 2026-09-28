import { describe, expect, it } from 'vitest';
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
});
