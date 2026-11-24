import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { LocalDockerProvider, sshTarget, sshTunnelArgs } from '../src/providers/localDockerProvider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import type { RuntimeProvider } from '../src/providers/provider.js';
import { parseSshEndpoint } from '../src/orchestrator/machines/runnerSetup.js';
import { registerRoutes } from '../src/api/routes.js';
import { Store } from '../src/store/store.js';

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

  it('an ssh alias with an underscore, which Add takes, opens its tunnel by that name (HB-1115)', async () => {
    for (const a of ['ssh://runner@fixture_host', 'ssh://runner@fixture_host:2222/', 'ssh://build_user@fixture-box', 'ssh://box_1']) {
      expect(parseSshEndpoint(a), a).toBeDefined();
      expect(sshTarget(a), a).toBeDefined();
    }
    expect(sshTarget('ssh://runner@fixture_host:2222/')).toEqual({ dest: 'runner@fixture_host', port: '2222' });
    // A shim ssh logs what it was asked, and gives up: no real ssh, no network.
    const bin = mkdtempSync(join(tmpdir(), 'hb-ssh-shim-'));
    writeFileSync(join(bin, 'ssh'), '#!/usr/bin/env bash\necho "$*" >> "$(dirname "$0")/log"\nexit 1\n', { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    try {
      const provider = new LocalDockerProvider({ host: 'ssh://runner@fixture_host', reachProbe: async () => true });
      await expect(provider.gatewayEndpoint(18789)).resolves.toBeUndefined();
      expect(readFileSync(join(bin, 'log'), 'utf8')).toMatch(/-L 127\.0\.0\.1:\d+:127\.0\.0\.1:18789 runner@fixture_host$/m);
    } finally {
      process.env.PATH = prevPath;
      rmSync(bin, { recursive: true, force: true });
    }
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

describe('a runner console tunnel ends with its agent and with its runner (HB-1030)', () => {
  it('destroying an agent ends its tunnel only; removing the runner (dispose) ends the rest, and none opens after', async () => {
    // No real ssh and no network: an ssh shim listens on the forward's local
    // port, as a forward does, until it is stopped, and logs its pid and the
    // forward; a docker shim answers every call with nothing.
    const bin = mkdtempSync(join(tmpdir(), 'hb-ssh-tunnel-'));
    writeFileSync(join(bin, 'ssh'), [
      '#!/usr/bin/env bash',
      'spec=""',
      'for a in "$@"; do case "$a" in 127.0.0.1:*:127.0.0.1:*) spec="$a";; esac; done',
      'echo "$$ $spec" >> "$(dirname "$0")/log"',
      `exec "${process.execPath}" -e 'require("node:net").createServer((s) => s.end()).listen(Number(process.argv[1]), "127.0.0.1")' "$(echo "$spec" | cut -d: -f2)"`,
      '',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const opened = () => readFileSync(join(bin, 'log'), 'utf8').trim().split('\n').map((l) => {
      const [pid, spec] = l.split(' ');
      return { pid: Number(pid), remote: Number(spec!.split(':')[3]) };
    });
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const ended = async (pid: number) => { for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50)); return !alive(pid); };
    const KITCHEN = 'docker://hatchabot-kitchen-a1b2c3d4', GARDEN = 'docker://hatchabot-garden-e5f6a7b8';
    try {
      const provider = new LocalDockerProvider({ host: 'ssh://runner@fixture-host', docker: join(bin, 'docker'), reachProbe: async () => true });
      const kitchen = await provider.gatewayEndpoint(18789, KITCHEN);
      const garden = await provider.gatewayEndpoint(18790, GARDEN);
      expect(kitchen?.host).toBe('127.0.0.1');
      expect(garden?.host).toBe('127.0.0.1');
      const [k, g] = opened();
      expect([k!.remote, g!.remote]).toEqual([18789, 18790]);
      expect(alive(k!.pid) && alive(g!.pid)).toBe(true);
      // Asked again while it lives: the same tunnel.
      expect(await provider.gatewayEndpoint(18789, KITCHEN)).toEqual(kitchen);
      // The agent deleted (or moved away): its tunnel ends; the other agent's stays.
      await provider.destroy(KITCHEN);
      expect(await ended(k!.pid)).toBe(true);
      expect(alive(g!.pid)).toBe(true);
      // Stopped (Stop, archive, sleep: one call): its tunnel ends too, and opens again on use (HB-1030 review).
      const kitchenAgain = await provider.gatewayEndpoint(18789, KITCHEN);
      const k2 = opened()[2]!;
      expect(kitchenAgain?.host).toBe('127.0.0.1');
      await provider.stop(KITCHEN);
      expect(await ended(k2.pid)).toBe(true);
      expect(alive(g!.pid)).toBe(true);
      expect((await provider.gatewayEndpoint(18789, KITCHEN))?.host).toBe('127.0.0.1');
      const k3 = opened()[3]!;
      await provider.destroy(KITCHEN);
      expect(await ended(k3.pid)).toBe(true);
      // The runner removed: the rest end, and no console opens a new one through it.
      provider.dispose();
      expect(await ended(g!.pid)).toBe(true);
      expect(await provider.gatewayEndpoint(18790, GARDEN)).toBeUndefined();
      expect(opened()).toHaveLength(4);
    } finally {
      process.env.PATH = prevPath;
      try { for (const { pid } of opened()) if (alive(pid)) process.kill(pid); } catch { /* no log */ }
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('a tunnel still opening when its agent or runner goes (HB-1030 review)', () => {
  /** The ssh shim of the test above, and what it logged: each ssh's pid. */
  const shims = () => {
    const bin = mkdtempSync(join(tmpdir(), 'hb-ssh-opening-'));
    writeFileSync(join(bin, 'ssh'), [
      '#!/usr/bin/env bash',
      'spec=""',
      'for a in "$@"; do case "$a" in 127.0.0.1:*:127.0.0.1:*) spec="$a";; esac; done',
      'echo "$$ $spec" >> "$(dirname "$0")/log"',
      `exec "${process.execPath}" -e 'require("node:net").createServer((s) => s.end()).listen(Number(process.argv[1]), "127.0.0.1")' "$(echo "$spec" | cut -d: -f2)"`,
      '',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const opened = () => (existsSync(join(bin, 'log')) ? readFileSync(join(bin, 'log'), 'utf8').trim().split('\n').map((l) => Number(l.split(' ')[0])) : []);
    return { bin, opened };
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const KITCHEN = 'docker://hatchabot-kitchen-a1b2c3d4', GARDEN = 'docker://hatchabot-garden-e5f6a7b8';

  for (const how of ['its agent destroyed', 'its runner removed'] as const) {
    it(`${how} while the runner's reach is still being probed: no ssh is started and none is handed out`, async () => {
      const { bin, opened } = shims();
      const prevPath = process.env.PATH;
      process.env.PATH = `${bin}:/usr/bin:/bin`;
      let reach!: () => void;
      const held = new Promise<void>((r) => { reach = r; });
      const provider = new LocalDockerProvider({ host: 'ssh://runner@fixture-host', docker: join(bin, 'docker'), reachProbe: async () => { await held; return true; } });
      const opening = provider.gatewayEndpoint(18789, KITCHEN);
      // A console for the other agent, opening too: only its own agent's going stops it.
      const other = provider.gatewayEndpoint(18790, GARDEN);
      try {
        await new Promise((r) => setTimeout(r, 20));
        const going = how === 'its agent destroyed' ? provider.destroy(KITCHEN) : (provider.dispose(), Promise.resolve());
        reach();
        await going;
        expect(await opening).toBeUndefined();
        if (how === 'its agent destroyed') {
          expect((await other)?.host).toBe('127.0.0.1');
          expect(opened()).toHaveLength(1);
          // Asked for again once it is gone, a console opens afresh, not on the cancelled one.
          expect((await provider.gatewayEndpoint(18789, KITCHEN))?.host).toBe('127.0.0.1');
          expect(opened()).toHaveLength(2);
        } else {
          expect(await other).toBeUndefined();
          expect(opened()).toEqual([]);
        }
      } finally {
        reach();
        await Promise.allSettled([opening, other]); // every ssh it starts is logged, so ended here
        process.env.PATH = prevPath;
        for (const pid of opened()) if (alive(pid)) process.kill(pid);
        rmSync(bin, { recursive: true, force: true });
      }
    });
  }
});

describe('removing a runner lets go of its provider (HB-1030)', () => {
  it("the runner's provider is disposed (its console tunnels end) as the host row goes", async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'user-owner', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertHost({ id: 'h2', ownerId: 'user-owner', kind: 'cloud', provider: 'remote-docker', name: 'Runner', settings: { dockerHost: 'ssh://runner@fixture-host' }, createdAt: 'now' });
    // The runner's provider as the routes' cache holds it (resolveProvider's key): a mock, so nothing is reached.
    let disposed = 0;
    const runner = Object.assign(new MockProvider(), { dispose: () => { disposed++; } });
    const remoteProviders = new Map<string, RuntimeProvider>([['h2:ssh://runner@fixture-host', runner]]);
    const secrets = { get: async () => { throw new Error('none'); }, put: async () => {}, delete: async () => {} };
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), remoteProviders, channel: { pool: { availableCount: () => 0 }, release: async () => {} } } as never);
    try {
      const r = await f.inject({ method: 'DELETE', url: '/v1/hosts/h2', headers: { 'x-hatchabot-owner': 'user-owner' } });
      expect(r.statusCode, r.body).toBe(200);
      expect(store.getHost('h2')).toBeUndefined();
      expect(disposed).toBe(1);
      expect(remoteProviders.size).toBe(0);
    } finally { await f.close(); }
  });
});
