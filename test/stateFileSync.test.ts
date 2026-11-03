import { afterAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * exportStateToFile tells a caller the copy is on the disk before it empties
 * the volume. That covers the file's name, not only its data: a rename nothing
 * has synced can be lost to a power cut, on another filesystem than the volume
 * nothing orders it. What the disk was asked to do is recorded here; the stub
 * docker stands in for the daemon. Power loss itself is not simulated.
 */
const seen = vi.hoisted(() => ({ steps: [] as string[], folderSync: undefined as string | undefined }));
vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: async (a: string, b: string) => { seen.steps.push('rename'); return real.rename(a, b); },
    open: async (p: string, flags: string) => {
      const handle = await real.open(p, flags);
      const what = p.endsWith('.part') ? 'file' : p.endsWith('.tgz') ? 'other' : 'folder';
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        seen.steps.push(`sync ${what}`);
        if (what === 'folder' && seen.folderSync) throw Object.assign(new Error(`${seen.folderSync}: folder sync`), { code: seen.folderSync });
        return sync();
      };
      return handle;
    },
  };
});
const { LocalDockerProvider } = await import('../src/providers/localDockerProvider.js');

const dir = mkdtempSync(join(tmpdir(), 'hb-statesync-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const docker = join(dir, 'docker');
writeFileSync(docker, '#!/usr/bin/env bash\nif [ "$1" = run ]; then printf archive; fi\nexit 0\n', { mode: 0o755 });
chmodSync(docker, 0o755);
const provider = new LocalDockerProvider({ docker, image: 'test-image:latest' });
const REF = 'docker://hatchabot-kitchen-helper-df918a55';
let n = 0;
const nextCopy = () => join(dir, `copy-${n++}.tgz`);

describe('the copy is on the disk before the caller goes on', () => {
  it('its data, then its name, then the folder holding the name', async () => {
    seen.steps.length = 0; seen.folderSync = undefined;
    const file = nextCopy();
    await provider.exportStateToFile(REF, file);
    expect(seen.steps).toEqual(['sync file', 'rename', 'sync folder']);
    expect(existsSync(file)).toBe(true);
    expect(dirname(file)).toBe(dir);
  });

  it('a disk that fails it: no copy is claimed, and none is left', async () => {
    seen.folderSync = 'EIO';
    const file = nextCopy();
    await expect(provider.exportStateToFile(REF, file)).rejects.toThrow(/EIO/);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.part`)).toBe(false);
  });

  it('a filesystem that cannot sync a folder has nothing more to give', async () => {
    seen.folderSync = 'EINVAL';
    const file = nextCopy();
    await provider.exportStateToFile(REF, file);
    expect(existsSync(file)).toBe(true);
    seen.folderSync = undefined;
  });
});
