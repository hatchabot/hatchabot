import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageRepository } from '../src/domain/imageRepository.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';

/**
 * An image name's repository, a default pinned by digest too (review of
 * HB-1182): `hatchabot-runtime@sha256:…` was read as `hatchabot-runtime@sha256`.
 * The docker client here is a shim that notes what it was asked: nothing
 * reaches Docker.
 */
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const digest = `sha256:${'0f'.repeat(32)}`;

describe('imageRepository', () => {
  it('takes off a digest, then a tag, and keeps a registry\'s port', () => {
    expect(imageRepository('hatchabot-runtime:latest')).toBe('hatchabot-runtime');
    expect(imageRepository(`hatchabot-runtime@${digest}`)).toBe('hatchabot-runtime');
    expect(imageRepository(`example-runtime:2026.9.8@${digest}`)).toBe('example-runtime');
    expect(imageRepository('registry.example:5000/team/runtime')).toBe('registry.example:5000/team/runtime');
    expect(imageRepository(`registry.example:5000/team/runtime:latest`)).toBe('registry.example:5000/team/runtime');
  });

  it('this machine\'s image list asks docker for the repository of a default pinned by digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-image-repo-')); dirs.push(dir);
    const bin = join(dir, 'bin'); mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    vi.stubEnv('HOME', dir); vi.stubEnv('PATH', bin);
    const log = join(dir, 'docker.log');
    const docker = join(bin, 'docker');
    writeFileSync(docker, `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
if (process.argv[2] === 'images') console.log('hatchabot-runtime:2026.9.8|0a0a0a0a0a0a|2026-11-01 10:00:00 +0000 UTC|2GB');
`, { mode: 0o755 });
    const tags = await new LocalDockerProvider({ docker, image: `hatchabot-runtime@${digest}` }).listImageTags();
    expect(readFileSync(log, 'utf8').split('\n')[0]).toMatch(/ hatchabot-runtime$/);
    expect(tags.map((t) => t.tag)).toEqual(['hatchabot-runtime:2026.9.8']);
  });
});
