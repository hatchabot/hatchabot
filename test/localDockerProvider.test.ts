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

    const prev = process.env.AGENTCLAW_DOCKER_TIMEOUT_MS;
    process.env.AGENTCLAW_DOCKER_TIMEOUT_MS = '200';
    try {
      const status = await slow.status('df918a55-88cd-4d00-a17c-b8415a26ceb6/kitchen-helper');
      expect(status.phase).toBe('unknown');
    } finally {
      if (prev === undefined) delete process.env.AGENTCLAW_DOCKER_TIMEOUT_MS;
      else process.env.AGENTCLAW_DOCKER_TIMEOUT_MS = prev;
    }
  });
});
