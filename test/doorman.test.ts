import { describe, expect, it } from 'vitest';
import { DOORMAN_CONSOLE_PORT, DOORMAN_DOOR_PORT, doormanRoutes, doormanScript, HOST_ALIAS } from '../src/ops/doorman.js';

/**
 * The doorman is what makes the management agent's jail work the same on every
 * host. Verified against real Docker on 2026-09-19 (see docs/ops-agent-design.md);
 * these lock the parts that decide where it forwards.
 */

describe('what the doorman forwards', () => {
  it('sends the agent to Hatchabot and the console to the agent', () => {
    const routes = doormanRoutes({ opsHost: '172.17.0.1', opsPort: 8091, agentContainer: 'hatchabot-manager-abc12345' });
    expect(routes).toEqual([
      { listen: DOORMAN_DOOR_PORT, host: '172.17.0.1', port: 8091 },
      { listen: DOORMAN_CONSOLE_PORT, host: 'hatchabot-manager-abc12345', port: 18789 },
    ]);
  });

  it('reaches a loopback door through Docker\'s host alias — the Docker Desktop case', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1']) {
      expect(doormanRoutes({ opsHost: host, opsPort: 8091, agentContainer: 'a' })[0]!.host).toBe(HOST_ALIAS);
    }
    // A door bound on a real address is reached there directly (Linux).
    expect(doormanRoutes({ opsHost: '172.20.0.1', opsPort: 8091, agentContainer: 'a' })[0]!.host).toBe('172.20.0.1');
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
