import { describe, expect, it } from 'vitest';
import { DOORMAN_CONSOLE_PORT, DOORMAN_DOOR_PORT, doormanRoutes, doormanScript, HOST_ALIAS } from '../src/ops/doorman.js';

/**
 * The doorman is what makes the management agent's jail work the same on every
 * host. Verified against real Docker on 2026-09-19 (see docs/ops-agent-design.md);
 * these lock the parts that decide where it forwards.
 */

describe('what the doorman forwards', () => {
  it('sends the agent to Hatchabot and the console to the agent', () => {
    const routes = doormanRoutes({ opsPort: 8091, agentContainer: 'hatchabot-manager-abc12345' });
    expect(routes).toEqual([
      // Docker's host alias points at this machine on every platform; the door
      // binds whatever address that is (see ensureOpsServer).
      { listen: DOORMAN_DOOR_PORT, host: HOST_ALIAS, port: 8091 },
      { listen: DOORMAN_CONSOLE_PORT, host: 'hatchabot-manager-abc12345', port: 18789 },
    ]);
    // With the shared memory search service in use, its door rides along (2026-09-25).
    expect(doormanRoutes({ opsPort: 8091, agentContainer: 'x', embedPort: 8093 })).toContainEqual({ listen: 8093, host: HOST_ALIAS, port: 8093 });
  });
});

describe('the forwarder', () => {
  it('is valid JavaScript, bounded, and holds no state', () => {
    const src = doormanScript();
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('DOORMAN_ROUTES');
    expect(src).toContain('MAX');          // a runaway agent cannot open unlimited sockets
    expect(src).not.toMatch(/require\("(child_process|fs)"\)/); // it forwards, nothing else
  });

  it('forwards a connection, the way it does in the container', async () => {
    const net = await import('node:net');
    const { spawn } = await import('node:child_process');
    const far = net.createServer((c) => c.end('FAR-END'));
    await new Promise<void>((r) => far.listen(0, '127.0.0.1', () => r()));
    const farPort = (far.address() as { port: number }).port;
    // A free port for the forwarder to listen on.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
    const listen = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));

    // The real script, run the way the doorman container runs it.
    const child = spawn(process.execPath, ['-e', doormanScript()], {
      env: { ...process.env, DOORMAN_ROUTES: JSON.stringify([{ listen, host: '127.0.0.1', port: farPort }]), DOORMAN_MAX: '4' },
      stdio: 'ignore',
    });
    try {
      await new Promise((r) => setTimeout(r, 400));
      const got = await new Promise<string>((resolve) => {
        const c = net.connect(listen, '127.0.0.1');
        c.on('data', (d) => { resolve(d.toString()); c.destroy(); });
        c.on('error', (e) => resolve(`error ${(e as NodeJS.ErrnoException).code}`));
        setTimeout(() => resolve('timeout'), 3000);
      });
      expect(got).toBe('FAR-END');
    } finally {
      child.kill();
      far.close();
    }
  }, 15_000);
});

describe('who may use the door', () => {
  it('turns away a peer that is not a doorman, before the key is looked at', async () => {
    const { createOpsServer } = await import('../src/ops/opsServer.js');
    const net = await import('node:net');
    const asked: string[] = [];
    let tokenSeen = false;
    const server = createOpsServer({
      mcp: async () => { tokenSeen = true; return { jsonrpc: '2.0', id: 1, result: {} }; },
      allowedHosts: () => ['api.example.com'],
      peerOk: async (ip) => { asked.push(ip); return false; },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const http = await import('node:http');
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { authorization: 'Bearer key-123' } },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on('error', reject);
        req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
      });
      expect(status).toBe(403);
      expect(tokenSeen).toBe(false);       // refused before any key check
      expect(asked).toEqual(['127.0.0.1']);
      // The proxy leg refuses the same peer.
      const proxied = await new Promise<string>((resolve) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(`CONNECT api.example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic ${Buffer.from('ops:k').toString('base64')}\r\n\r\n`);
        });
        sock.once('data', (b: Buffer) => { resolve(b.toString()); sock.destroy(); });
        sock.once('error', () => resolve('error'));
        setTimeout(() => resolve('timeout'), 2000);
      });
      expect(proxied).toMatch(/403/);
    } finally {
      server.close();
    }
  }, 15_000);

  it('lets a doorman through', async () => {
    const { createOpsServer } = await import('../src/ops/opsServer.js');
    const http = await import('node:http');
    const server = createOpsServer({
      mcp: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
      allowedHosts: () => [],
      peerOk: async () => true,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST' }, (res) => {
          let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b));
        });
        req.on('error', reject);
        req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
      });
      expect(JSON.parse(body).result).toEqual({ ok: true });
    } finally {
      server.close();
    }
  }, 15_000);
});
