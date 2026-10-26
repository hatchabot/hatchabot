import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { buildRuntimeSpec, hostPathTargetProblem } from '../src/orchestrator/provision.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

/** Open runtime backlog items fixed 2026-10-26 (the runtime group). */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error(`no secret ${ref}`); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'hb-backlog-rt-')); tmps.push(d); return d; };
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

async function agentWorld() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'sk-test');
  store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
  const deps = { store, secrets, provider, channel: { kind: 'telegram' } as unknown as ChannelProvisioner, sleep: async () => {} } as never;
  return { store, deps };
}

describe('HB-0053: a folder brought in from OpenClaw is judged at every build, and where it lands', () => {
  it('the place inside the container: never on the agent\'s home or the image\'s system paths', () => {
    for (const bad of ['/home/node', '/home/node/.openclaw', '/home', '/opt/tools', '/usr/local/lib', '/etc/cron.d', '/dev/shm', '/proc/1', '/sys/fs', '/tmp', '/var', '/run']) {
      expect(hostPathTargetProblem(bad), bad).toMatch(/would cover/);
    }
    for (const ok of ['/srv/recipes', '/mnt/nas/photos', '/home/sam/notes', '/tmp/hb-x/docs', '/var/www/site', '/Users/sam/Documents']) {
      expect(hostPathTargetProblem(ok), ok).toBeUndefined();
    }
  });

  it('a host-path folder that became a symlink, or lands on a system path, stops the build before anything is stopped', async () => {
    const { store, deps } = await agentWorld();
    const real = tmp(); const parent = tmp();
    const link = join(parent, 'notes');
    symlinkSync(real, link);
    store.insertDataSource({ id: 'd1', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'notes', hostPath: link, mountAtHostPath: true, createdAt: 'now' });
    await expect(buildRuntimeSpec(deps, 'a1')).rejects.toThrow(/symlink/);
    store.deleteDataSource('a1', 'd1');
    store.insertDataSource({ id: 'd2', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'opt-tools', hostPath: '/opt/tools', mountAtHostPath: true, createdAt: 'now' });
    await expect(buildRuntimeSpec(deps, 'a1')).rejects.toThrow(/would cover \/opt/);
    store.deleteDataSource('a1', 'd2');
    const fine = join(tmp(), 'docs'); mkdirSync(fine);
    store.insertDataSource({ id: 'd3', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'docs', hostPath: fine, mountAtHostPath: true, createdAt: 'now' });
    const spec = await buildRuntimeSpec(deps, 'a1');
    expect(spec.hostMounts?.some((m) => m.source === fine && m.target === fine)).toBe(true);
  });
});

describe('HB-0073: an imported archive is bounded by what it expands to, before the volume is touched', () => {
  it('a small archive that inflates past HATCHABOT_IMPORT_MAX_GB is refused and the volume keeps its files', async () => {
    const { execFileSync } = await import('node:child_process');
    const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
    const { vi } = await import('vitest');
    const d = tmp();
    const vol = join(d, 'vol');
    mkdirSync(vol);
    writeFileSync(join(vol, 'MEMORY.md'), '# kept\n');
    // The archive: one file of zeros, far smaller packed than the limit it breaks.
    const src = join(d, 'src');
    mkdirSync(join(src, '.openclaw'), { recursive: true });
    writeFileSync(join(src, '.openclaw', 'zeros'), Buffer.alloc(64 * 1024));
    const tgz = execFileSync('tar', ['cz', '-C', src, '.']);
    // A docker that runs the one-shot's script here, with /vol and /tmp pointed into the sandbox.
    const stub = join(d, 'docker');
    writeFileSync(stub, `#!/usr/bin/env bash
script="\${@: -1}"
script="\${script//\\/vol/${vol}}"
script="\${script//\\/tmp\\/s./${d}/s.}"
case "$script" in *" /vol"*|*"/tmp/s."*) echo "unsandboxed path" >&2; exit 9;; esac
exec sh -c "$script"
`, { mode: 0o755 });
    process.env.HATCHABOT_IMPORT_MAX_GB = String(16 * 1024 / 2 ** 30); // 16 KiB
    vi.resetModules();
    try {
      const { LocalDockerProvider } = await import('../src/providers/localDockerProvider.js');
      const p = new LocalDockerProvider({ docker: stub });
      await expect(p.importState('kitchen-helper-df918a55', tgz)).rejects.toThrow(/\(3\): archive expands past the size limit/);
      expect(readFileSync(join(vol, 'MEMORY.md'), 'utf8')).toBe('# kept\n');
      expect(existsSync(join(vol, '.openclaw'))).toBe(false);
    } finally {
      delete process.env.HATCHABOT_IMPORT_MAX_GB;
      vi.resetModules();
    }
  });
});

describe('HB-0066: a copy of a volume leaves out what the agent rebuilds by itself, as the nightly backup does', () => {
  it('the same list as the backup script, and it leaves only the root caches out', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    const { STATE_CACHE_EXCLUDES } = await import('../src/providers/volumeCopy.js');
    const script = readFileSync(join(__dirname, '..', 'scripts', 'backup-volumes.sh'), 'utf8');
    const line = /^TAR_EXCLUDES="([^"]*)"/m.exec(script)![1]!;
    expect(line.split(' ').filter((w) => w !== '--anchored')).toEqual(STATE_CACHE_EXCLUDES);
    const d = tmp();
    for (const f of ['.openclaw/cache/control-ui-assets/a', '.openclaw/tmp/b', '.npm/c', '.cache/pip/d', '.cache/keep/e', 'workspace/.npm/f', '.npm-global/g', '.openclaw/openclaw.json']) {
      mkdirSync(join(d, f, '..'), { recursive: true });
      writeFileSync(join(d, f), 'x');
    }
    const members = execFileSync('sh', ['-c', `tar cz ${STATE_CACHE_EXCLUDES.join(' ')} -C "$1" . | tar tz`, 'sh', d], { encoding: 'utf8' })
      .split('\n').filter((m) => m && !m.endsWith('/')).sort();
    expect(members).toEqual(['./.cache/keep/e', './.npm-global/g', './.openclaw/openclaw.json', './workspace/.npm/f']);
  });

  it('exportState and the export estimate use it', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { LocalDockerProvider } = await import('../src/providers/localDockerProvider.js');
    const { estimateStateBytes } = await import('../src/orchestrator/transfer.js');
    const d = tmp();
    const log = join(d, 'argv.log');
    const stub = join(d, 'docker');
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
    await new LocalDockerProvider({ docker: stub }).exportState('kitchen-helper-df918a55');
    const tarLine = readFileSync(log, 'utf8').split('\n').find((l) => l.includes(' tar cz '))!;
    expect(tarLine).toContain('tar cz --exclude=./.openclaw/cache/control-ui-assets --exclude=./.openclaw/tmp --exclude=./.npm --exclude=./.cache/pip -C /vol .');
    let estimate = '';
    await estimateStateBytes({ execShellOnVolume: async (_r: string, s: string) => { estimate = s; return { code: 0, stdout: '1\n', stderr: '' }; } } as never, 'kitchen-helper-df918a55');
    expect(estimate).toContain('tar cz --exclude=./.openclaw/cache/control-ui-assets');
  });
});
