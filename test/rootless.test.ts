import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { doctorReport, type DoctorFacts } from '../src/doctor.js';
import { as, makeWorld, seedRunningAgent } from './support/world.js';

/**
 * Hatchabot under rootless Docker — one tenant of a shared host (the cloud's
 * S0 seam). Measured in an LXD VM on 2026-09-25: the host cannot reach a
 * container's address, `host-gateway` points into the tenant's own namespace,
 * and containers reach the host's loopback at 10.0.2.2 once host loopback is
 * on. The provider adapts to each; root Docker is untouched.
 */

/** A docker stub that answers like a daemon of the given kind. */
function stubDocker(kind: 'root' | 'rootless' | 'desktop') {
  const dir = mkdtempSync(join(tmpdir(), 'hb-rootless-'));
  const log = join(dir, 'argv.log');
  const stub = join(dir, 'docker');
  writeFileSync(stub, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1 $2" in
  "info --format") echo '${kind === 'desktop' ? 'Docker Desktop' : 'Ubuntu 24.04.3 LTS'}|[name=seccomp,profile=builtin${kind === 'rootless' ? ' name=rootless name=cgroupns' : ''}]' ;;
  "network inspect") echo '172.17.0.1' ;;
  "inspect -f") echo 'running 172.17.0.2 |19107' ;;
esac
exit 0
`, { mode: 0o755 });
  chmodSync(stub, 0o755);
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response('ok', { status: 200 }); }) as typeof fetch;
  const provider = new LocalDockerProvider({ docker: stub, image: 'test-image:latest', fetchImpl });
  return { provider, calls, argv: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

describe('the Docker provider under rootless Docker', () => {
  afterEach(() => { delete process.env.HATCHABOT_HOST_ALIAS_IP; delete process.env.HATCHABOT_DOCKER_ROOTLESS; });

  it('root Docker: the bridge gateway is bindable, the doorman maps the host alias to host-gateway, health is probed at the container address', async () => {
    const { provider, calls, argv } = stubDocker('root');
    expect(await provider.rootless()).toBe(false);
    expect(await provider.hostGatewayAddress()).toBe('172.17.0.1');
    expect(await provider.hostAddressForAgents()).toBe('172.17.0.1');
    expect(await provider.hostAliasTarget()).toBe('host-gateway');
    const st = await provider.status('mock://kitchen');
    expect(st).toEqual({ phase: 'running', healthy: true });
    expect(calls).toEqual(['http://172.17.0.2:18789/health']);
    await provider.ensureOpsJail({ agentId: 'a1', slug: 'kitchen', opsPort: 8091, consolePort: 19200 });
    expect(argv()).toContain('--add-host host.docker.internal:host-gateway');
    expect(await provider.containerUserFor(process.getuid!(), process.getgid!())).toBe(`${process.getuid!()}:${process.getgid!()}`);
  });

  it('rootless: nothing to bind, the alias points at 10.0.2.2, health is probed on the published loopback port', async () => {
    const { provider, calls, argv } = stubDocker('rootless');
    expect(await provider.rootless()).toBe(true);
    expect(await provider.hostGatewayAddress()).toBeUndefined();
    expect(await provider.hostAddressForAgents()).toBe('10.0.2.2');
    expect(await provider.hostAliasTarget()).toBe('10.0.2.2');
    const st = await provider.status('mock://kitchen');
    expect(st).toEqual({ phase: 'running', healthy: true });
    expect(calls).toEqual(['http://127.0.0.1:19107/health']);
    await provider.ensureOpsJail({ agentId: 'a1', slug: 'kitchen', opsPort: 8091, consolePort: 19200 });
    expect(argv()).toContain('--add-host host.docker.internal:10.0.2.2');
    // The workspace seed is streamed in over stdin, as for a remote daemon: the one-shot cannot read this user's private tmp dir.
    await provider.provision({ agentId: 'df918a55-88cd-4d00-a17c-b8415a26ceb6', slug: 'kitchen', workspace: { files: { 'SOUL.md': '# soul' }, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} } as never).catch(() => {});
    const seedRun = argv().split('\n').find((l) => l.startsWith('run --rm') && l.includes('seed'));
    expect(seedRun).toContain('tar xz -C /tmp/hatchabot-seed');
    expect(seedRun).not.toContain('/seed:ro');
    // …and the agent container itself knows this machine by name (memory index failed: ENOTFOUND host.docker.internal).
    const agentRun = argv().split('\n').find((l) => l.startsWith('create') || (l.startsWith('run') && l.includes('--memory')));
    expect(agentRun).toContain('--add-host host.docker.internal:10.0.2.2');
    // The service containers read this user's 0600 key files: as container root, which is this user here.
    expect(await provider.containerUserFor(process.getuid!(), process.getgid!())).toBe('0:0');
    expect(await provider.containerUserFor(process.getuid!() + 1, 5)).toBe(`${process.getuid!() + 1}:5`);
    // Asked once: the second answer comes from memory.
    await provider.rootless();
    expect(argv().split('\n').filter((l) => l.startsWith('info --format')).length).toBe(1);
  });

  it('Docker Desktop: no bridge address to bind (the doors take loopback), agents reach the machine as host.docker.internal', async () => {
    const { provider, calls } = stubDocker('desktop');
    expect(await provider.desktop()).toBe(true);
    expect(await provider.rootless()).toBe(false);
    expect(await provider.hostGatewayAddress()).toBeUndefined();
    expect(await provider.hostAddressForAgents()).toBe('host.docker.internal');
    expect(await provider.hostAliasTarget()).toBe('host-gateway');
    // The Mac cannot reach a container's address inside Docker's VM: health is probed on the published port.
    expect(await provider.status('mock://kitchen')).toEqual({ phase: 'running', healthy: true });
    expect(calls).toEqual(['http://127.0.0.1:19107/health']);
  });

  it('HATCHABOT_HOST_ALIAS_IP and HATCHABOT_DOCKER_ROOTLESS override the probe (pasta, an unusual bridge)', async () => {
    process.env.HATCHABOT_DOCKER_ROOTLESS = '1';
    process.env.HATCHABOT_HOST_ALIAS_IP = '169.254.1.2';
    const { provider } = stubDocker('root');
    expect(await provider.rootless()).toBe(true);
    expect(await provider.hostAliasTarget()).toBe('169.254.1.2');
    expect(await provider.hostAddressForAgents()).toBe('169.254.1.2');
    expect(await provider.hostGatewayAddress()).toBeUndefined();
  });
});

describe('what depends on the host address', () => {
  afterEach(() => { delete process.env.PORT; });
  it('doctor says the daemon is rootless and where agents reach the machine', () => {
    const facts: DoctorFacts = {
      nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true, arch: 'arm64', version: '29.8', rootless: true },
      runtimeImage: { openclawVersion: '2026.9.6', sizeGb: 1.9 },
      envFile: { present: true, secretKey: true, password: false, authMode: 'accounts' },
      db: { path: '/x/hatchabot.sqlite', present: true, sizeMb: 1 },
      service: { manager: 'systemd', active: true, enabled: true },
      controlPlane: { url: 'http://localhost:8101', ok: true, version: '2.79.0' },
      diskFreeGb: 100, backups: { dir: '/b' }, tailscale: { installed: false }, containers: { running: 1, total: 1 },
    };
    const docker = doctorReport(facts).find((l) => l.text.startsWith('Docker 29.8'));
    expect(docker?.level).toBe('ok');
    expect(docker?.text).toContain('rootless: agents reach this machine at 10.0.2.2');
    expect(doctorReport({ ...facts, dockerDaemon: { ok: true, arch: 'arm64', version: '29.8' } }).find((l) => l.text.startsWith('Docker 29.8'))?.text).not.toContain('rootless');
  });

  it('an agent with peers is told this instance\'s address and port, not the root bridge on 8080', async () => {
    process.env.PORT = '8102';
    const w = await makeWorld();
    (w.provider as unknown as { hostAddressForAgents: () => Promise<string> }).hostAddressForAgents = async () => '10.0.2.2';
    const a = await seedRunningAgent(w, { id: 'a1', slug: 'one', accountId: 'onebot' });
    const b = await seedRunningAgent(w, { id: 'a2', slug: 'two', accountId: 'twobot' });
    expect((await w.f.inject({ method: 'POST', url: '/v1/agent-peers/mesh', headers: as(), payload: { agentIds: [a, b], connect: true } })).statusCode).toBe(200);
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${a}/rebuild`, headers: as() });
    expect(r.statusCode, r.body).toBe(202);
    for (let i = 0; i < 100 && w.provider.lastSpec?.agentId !== a; i++) await new Promise((res) => setTimeout(res, 20));
    expect(w.provider.lastSpec?.agentId).toBe(a);
    expect(w.provider.lastSpec?.env.HATCHABOT_INTERNAL_URL).toBe('http://10.0.2.2:8102');
  });
});
