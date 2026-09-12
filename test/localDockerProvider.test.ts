import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';

/**
 * The only real provider, and previously untested — mutation testing showed
 * that deleting the seed script's overwrite guards (i.e. destroying every
 * agent's MEMORY.md on rebuild) passed the whole suite silently.
 *
 * No daemon needed: the provider already takes the docker binary path, so a
 * recording stub captures the argv and the generated seed script.
 */
const dir = mkdtempSync(join(tmpdir(), 'acl-docker-'));
const LOG = join(dir, 'argv.log');
const SEED_COPY = join(dir, 'seed.sh');

const stub = join(dir, 'docker');
writeFileSync(
  stub,
  `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(LOG)}
# stash the staged seed script before the provider deletes its tmpdir
for a in "$@"; do
  case "$a" in
    *:/seed:ro) cp "\${a%%:*}/seed.sh" ${JSON.stringify(SEED_COPY)} 2>/dev/null || true ;;
  esac
done
exit 0
`,
  { mode: 0o755 },
);
chmodSync(stub, 0o755);

const provider = new LocalDockerProvider({ docker: stub, image: 'test-image:latest' });
const argv = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');
const seed = () => (existsSync(SEED_COPY) ? readFileSync(SEED_COPY, 'utf8') : '');

const spec = (over: Record<string, unknown> = {}) => ({
  agentId: 'df918a55-88cd-4d00-a17c-b8415a26ceb6',
  slug: 'kitchen-helper',
  workspace: {
    files: { 'SOUL.md': '# soul', 'AGENTS.md': '# agents', 'MEMORY.md': '# memory' },
    configPatch: { agentId: 'kitchen-helper', authMode: 'api-key' as const },
  },
  env: {},
  ...over,
});

beforeEach(() => {
  writeFileSync(LOG, '');
});

describe('seed script — the guards that protect an agent’s memory', () => {
  it('never copies a workspace file unconditionally', async () => {
    await provider.provision(spec() as any);
    const script = seed();
    expect(script).toBeTruthy();
    for (const name of ['SOUL.md', 'AGENTS.md', 'MEMORY.md']) {
      const line = script.split('\n').find((l) => l.includes(`/${name}'`) && l.includes('cp '));
      expect(line, `${name} must be guarded`).toBeTruthy();
      // `[ -f dest ] || cp …` — without this a rebuild lobotomizes the agent
      expect(line).toMatch(/\[ -f .* \] \|\| cp /);
    }
  });

  it('only scaffolds the agent when the workspace does not exist', async () => {
    await provider.provision(spec() as any);
    expect(seed()).toMatch(/if \[ ! -d .* \]; then openclaw 'agents' 'add'/);
  });

  it('creates directories for nested seed files (skills/…), still overwrite-safe', async () => {
    await provider.provision(
      spec({
        workspace: {
          files: { 'SOUL.md': '# soul', 'skills/gog/SKILL.md': '# gog' },
          configPatch: { agentId: 'kitchen-helper', authMode: 'api-key' },
        },
      }) as any,
    );
    const script = seed();
    expect(script).toMatch(/mkdir -p '[^']*\/skills\/gog'/);
    const line = script.split('\n').find((l) => l.includes("skills/gog/SKILL.md'") && l.includes('cp '));
    expect(line).toMatch(/\[ -f .* \] \|\| cp /); // the guard still protects edits
  });

  it('produces a syntactically valid script even with hostile values', async () => {
    await provider.provision(
      spec({
        workspace: {
          files: { 'SOUL.md': "it's got quotes" },
          configPatch: {
            agentId: 'kitchen-helper',
            authMode: 'api-key',
            telegram: {
              accountId: 'bot',
              botToken: "123:AA'; touch /tmp/pwned; '",
              dmPolicy: 'pairing',
            },
          },
        },
      }) as any,
    );
    const path = join(dir, 'check.sh');
    writeFileSync(path, seed());
    // bash -n catches any quoting break wholesale
    execFileSync('bash', ['-n', path]);
    // The payload may appear — but only INERT, single-quote escaped, so it
    // can never break out of its argument and execute.
    expect(seed()).toContain(`'\\''`);
    expect(seed()).not.toMatch(/^\s*touch \/tmp\/pwned/m);
  });
});

describe('container and volume shape', () => {
  it('publishes the gateway port on loopback only', async () => {
    await provider.provision(spec({ ports: [{ host: 19100, container: 18789 }] }) as any);
    expect(argv()).toContain('127.0.0.1:19100:18789');
    expect(argv()).not.toMatch(/-p 19100:18789/);
  });

  it('runs with an init process, so orphaned grandchildren get reaped', async () => {
    await provider.provision(spec() as any);
    const create = argv().split('\n').find((l) => l.startsWith('create '));
    expect(create).toContain('--init');
  });

  it('sets the container hostname when the spec carries one (the where-am-I compass)', async () => {
    await provider.provision(spec({ hostname: 'kitchen-helper.studio-mini' }) as any);
    const create = argv().split('\n').find((l) => l.startsWith('create '));
    expect(create).toContain('--hostname kitchen-helper.studio-mini');
  });

  it('mounts the volume as the agent\'s HOME, not just ~/.openclaw', async () => {
    // /usr is the image (replaced by a rebuild); $HOME is the agent's and
    // persists. That single boundary is what makes a credential the agent
    // writes to ~/.config/<tool> survive, with no per-tool plumbing.
    await provider.provision(spec() as any);
    const create = argv().split('\n').find((l) => l.startsWith('create '))!;
    expect(create).toMatch(/-v \S+-vol:\/home\/node(?!\/)/);
    expect(create).not.toContain(':/home/node/.openclaw');
  });

  it('reshapes an older volume before anything writes to it, exactly once', async () => {
    await provider.provision(spec() as any);
    const lines = argv().split('\n');
    const mig = lines.findIndex((l) => l.includes('.agentclaw-home-v2'));
    const seed = lines.findIndex((l) => l.includes('seed.sh') || l.includes('/seed'));
    expect(mig).toBeGreaterThanOrEqual(0);
    // Must precede the seed: the seed writes .openclaw paths, which would
    // collide with pre-migration content still sitting at the volume root.
    if (seed >= 0) expect(mig).toBeLessThan(seed);
    // Marker-guarded, so a re-provision is a no-op rather than a second move.
    expect(lines[mig]).toContain('if [ -f /vol/.openclaw/.agentclaw-home-v2 ]; then exit 0; fi');
    // …and the marker is written LAST, so a half-finished run self-heals.
    expect(lines[mig]!.indexOf('touch')).toBeGreaterThan(lines[mig]!.indexOf('find /vol'));
  });

  it('keeps the volume unless purge is explicitly requested', async () => {
    const { runtimeRef } = await provider.provision(spec() as any);
    writeFileSync(LOG, '');
    await provider.destroy(runtimeRef);
    expect(argv()).not.toMatch(/volume rm/);

    writeFileSync(LOG, '');
    await provider.destroy(runtimeRef, { purge: true });
    expect(argv()).toMatch(/volume rm/);
  });

  it('reuses the same volume on re-provision (memory survives rebuilds)', async () => {
    const { runtimeRef } = await provider.provision(spec() as any);
    writeFileSync(LOG, '');
    await provider.provision(spec({ previousRef: runtimeRef }) as any);
    const created = argv().split('\n').filter((l) => l.startsWith('volume create'));
    expect(created).toHaveLength(1);
    expect(created[0]).toContain('kitchen-helper');
  });

  it('restores archives without trusting their ownership or setuid bits', async () => {
    const { runtimeRef } = await provider.provision(spec() as any);
    writeFileSync(LOG, '');
    await provider.importState(runtimeRef, Buffer.from('x'));
    const line = argv();
    expect(line).toContain('--no-same-owner');
    expect(line).toContain('chown -R 1000:1000');
    expect(line).toContain('chmod -R a-s');
  });
});

describe('daemon-access errors are unknown, not absent', () => {
  it('reports unknown on a docker permission-denied error', async () => {
    // A user briefly out of the docker group after a reboot: inspect exits
    // non-zero with "permission denied", which used to fall through to absent
    // and make boot reconcile FAIL the whole fleet.
    const d = mkdtempSync(join(tmpdir(), 'acl-perm-'));
    const permStub = join(d, 'docker');
    writeFileSync(permStub,
      '#!/usr/bin/env bash\n' +
      'echo "Got permission denied while trying to connect to the Docker daemon socket" >&2\n' +
      'exit 1\n', { mode: 0o755 });
    chmodSync(permStub, 0o755);
    const p = new LocalDockerProvider({ docker: permStub, image: 'test-image:latest' });
    const status = await p.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper');
    expect(status.phase).toBe('unknown');
  });

  it('still reports absent on a genuine "No such container"', async () => {
    const d = mkdtempSync(join(tmpdir(), 'acl-gone-'));
    const goneStub = join(d, 'docker');
    writeFileSync(goneStub,
      '#!/usr/bin/env bash\necho "Error: No such container: x" >&2\nexit 1\n', { mode: 0o755 });
    chmodSync(goneStub, 0o755);
    const p = new LocalDockerProvider({ docker: goneStub, image: 'test-image:latest' });
    const status = await p.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper');
    expect(status.phase).toBe('absent');
  });
});

describe('a stalled daemon is not a missing container', () => {
  it('reports unknown, never absent, when docker inspect times out', async () => {
    // A timed-out inspect has empty stderr, so the daemon-down regex can't
    // rescue it — reading it as "absent" made reconcile FAIL every healthy
    // agent whenever the daemon stalled (IO load, backups). The timeout must
    // surface as unknown so callers wait instead of judging.
    const slowDir = mkdtempSync(join(tmpdir(), 'acl-slow-'));
    const slowStub = join(slowDir, 'docker');
    writeFileSync(slowStub, '#!/usr/bin/env bash\nsleep 5\n', { mode: 0o755 });
    chmodSync(slowStub, 0o755);
    const slow = new LocalDockerProvider({ docker: slowStub, image: 'test-image:latest' });

    const prev = process.env.HATCHABOT_DOCKER_TIMEOUT_MS;
    process.env.HATCHABOT_DOCKER_TIMEOUT_MS = '200';
    try {
      const status = await slow.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper');
      expect(status.phase).toBe('unknown');
    } finally {
      if (prev === undefined) delete process.env.HATCHABOT_DOCKER_TIMEOUT_MS;
      else process.env.HATCHABOT_DOCKER_TIMEOUT_MS = prev;
    }
  });
});

describe('remote (fleet) provider — points docker at a remote daemon', () => {
  const rdir = mkdtempSync(join(tmpdir(), 'acl-rdocker-'));
  const RLOG = join(rdir, 'argv.log');
  const rstub = join(rdir, 'docker');
  writeFileSync(rstub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(RLOG)}\nexit 0\n`, { mode: 0o755 });
  chmodSync(rstub, 0o755);
  const HOST = 'ssh://runner@10.0.0.9';
  const remote = new LocalDockerProvider({ docker: rstub, image: 'test-image:latest', host: HOST });
  const rargv = () => (existsSync(RLOG) ? readFileSync(RLOG, 'utf8') : '');

  beforeEach(() => writeFileSync(RLOG, ''));

  it('advertises itself as remote-docker', () => {
    expect(remote.key).toBe('remote-docker');
    expect(remote.remote).toBe(true);
  });

  it('prepends -H <host> to every docker command', async () => {
    await remote.stop('docker://hatchabot-kitchen-helper-df918a55');
    for (const line of rargv().split('\n').filter(Boolean)) {
      expect(line.startsWith(`-H ${HOST} `), line).toBe(true);
    }
  });

  it('seeds over stdin (no bind-mount of this box\'s seed dir) and skips host mounts', async () => {
    await remote.provision(spec({
      hostMounts: [{ source: '/home/me/docs', target: '/home/me/docs', readonly: true }],
    }) as any);
    const log = rargv();
    // remote seed is streamed in, not bind-mounted
    expect(log).not.toContain(':/seed:ro');
    // …and extracted to a world-writable path: the runtime runs as a NON-ROOT
    // user and can't `mkdir /seed` at the root fs — that was a real "Setting up
    // the agent workspace failed" on a live runner.
    expect(log).toContain('mkdir -p /tmp/hatchabot-seed && tar xz -C /tmp/hatchabot-seed');
    expect(log).not.toContain('mkdir -p /seed');
    // the control-plane host path is NOT mounted into the remote container
    expect(log).not.toContain('/home/me/docs:/home/me/docs');
    // and everything still targeted the remote daemon
    expect(log.split('\n').filter(Boolean).every((l) => l.startsWith(`-H ${HOST} `))).toBe(true);
  });
});
