import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDockerProvider, sshTarget, sshTunnelArgs } from '../src/providers/localDockerProvider.js';

describe("a runner agent's console, through the runner's SSH (2026-09-23)", () => {
  it('no ssh on the service PATH: the console is unavailable, and the service lives (review R21)', async () => {
    // An empty PATH folder: `spawn('ssh')` fails with ENOENT, as it did when the
    // service unit's PATH lacked ssh — and the unhandled 'error' took the
    // service down. No real ssh, no network: the reach probe is a stub.
    const empty = mkdtempSync(join(tmpdir(), 'hb-no-ssh-'));
    const prevPath = process.env.PATH;
    process.env.PATH = empty;
    try {
      const provider = new LocalDockerProvider({ host: 'ssh://runner.invalid', reachProbe: async () => true });
      await expect(provider.gatewayEndpoint(18789)).resolves.toBeUndefined();
      // Nothing stale kept from the failed attempt: asked again, it tries again and says the same.
      await expect(provider.gatewayEndpoint(18789)).resolves.toBeUndefined();
    } finally {
      process.env.PATH = prevPath;
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('this machine: the published port itself', async () => {
    expect(await new LocalDockerProvider().gatewayEndpoint(19111)).toEqual({ host: '127.0.0.1', port: 19111 });
  });

  it('a tcp:// runner has no tunnel to offer, so no endpoint', async () => {
    expect(await new LocalDockerProvider({ host: 'tcp://10.0.0.5:2376' }).gatewayEndpoint(19111)).toBeUndefined();
  });

  it('reads the ssh destination the docker connection already uses', () => {
    expect(sshTarget('ssh://someone@example.com')).toEqual({ dest: 'someone@example.com', port: undefined });
    expect(sshTarget('ssh://runner:2222')).toEqual({ dest: 'runner', port: '2222' });
    expect(sshTarget('tcp://1.2.3.4:2376')).toBeUndefined();
    expect(sshTarget('ssh://evil -oProxyCommand=x@host')).toBeUndefined(); // no spaces
    expect(sshTarget('ssh://-oProxyCommand=touch')).toBeUndefined();       // nothing ssh reads as an option
    expect(sshTarget('ssh://user@-oProxyCommand=x')).toBeUndefined();
  });

  it('forwards one local port to the runner loopback, never prompts, and gives up if the forward fails', () => {
    const argv = sshTunnelArgs({ dest: 'me@mac', port: '2222' }, 40111, 19111);
    expect(argv).toContain('-N');
    expect(argv.join(' ')).toContain('-L 127.0.0.1:40111:127.0.0.1:19111');
    expect(argv.join(' ')).toContain('BatchMode=yes');
    expect(argv.join(' ')).toContain('ExitOnForwardFailure=yes');
    expect(argv.slice(-1)).toEqual(['me@mac']);
    expect(argv).toEqual(expect.arrayContaining(['-p', '2222']));
  });
});
