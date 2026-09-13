import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dockerfileProblem } from '../src/orchestrator/derivedImage.js';
import { sharePathProblem } from '../src/orchestrator/provision.js';
import { defaultDbPath, defaultBackupsDir } from '../src/envCompat.js';

describe('sharePathProblem (audit 2026-09-13)', () => {
  const home = '/home/alice';
  it('refuses ancestors of forbidden paths, not just descendants', () => {
    expect(sharePathProblem('/var', { home })).toMatch(/Refusing/); // ancestor of /var/lib/docker and docker.sock
    expect(sharePathProblem('/var/run', { home })).toMatch(/Refusing/); // symlink on some hosts, ancestor of docker.sock on others
    expect(sharePathProblem('/home', { home })).toBeDefined();
    expect(sharePathProblem(home, { home })).toMatch(/whole home/);
  });
  it('refuses the installation, data, backups and credential dirs', () => {
    for (const p of ['hatchabot-prod', 'agentclaw-prod', 'hatchabot-backups', '.docker', '.aws', '.gnupg', '.kube', '.config'])
      expect(sharePathProblem(join(home, p), { home }), p).toBeDefined();
    expect(sharePathProblem('/var/run/docker.sock', { home })).toMatch(/root/);
  });
  it('still allows an ordinary folder', () => {
    expect(sharePathProblem(join(home, 'Documents/tax'), { home })).toBeUndefined();
    expect(sharePathProblem(join(home, '.config/rclone'), { home })).toBeDefined(); // inside .config
    expect(sharePathProblem('/srv/media', { home })).toBeUndefined();
  });
  it('refuses a symlink and judges the real path', () => {
    const root = mkdtempSync(join(tmpdir(), 'share-'));
    mkdirSync(join(root, '.ssh'));
    symlinkSync(join(root, '.ssh'), join(root, 'keys'));
    expect(sharePathProblem(join(root, 'keys'), { home: root })).toMatch(/symlink/);
    mkdirSync(join(root, 'docs'));
    expect(sharePathProblem(join(root, 'docs'), { home: root })).toBeUndefined();
  });
});

describe('dockerfileProblem', () => {
  it('rejects escapes from the thin-layer contract', () => {
    expect(dockerfileProblem('RUN apt-get install -y poppler-utils')).toBeNull();
    expect(dockerfileProblem('RUN true\nFROM ubuntu')).toMatch(/FROM/);
    expect(dockerfileProblem('RUN --mount=type=bind,from=other cat /x')).toMatch(/mount/);
    expect(dockerfileProblem('RUN --network=host curl x')).toMatch(/network/);
    expect(dockerfileProblem('USER root')).toMatch(/USER/);
  });
});

describe('legacy default paths', () => {
  it('prefers the pre-rename file/dir only when the new one is absent', () => {
    const d = mkdtempSync(join(tmpdir(), 'db-'));
    expect(defaultDbPath(d)).toBe(join(d, 'hatchabot.sqlite'));
    writeFileSync(join(d, 'agentclaw.sqlite'), '');
    expect(defaultDbPath(d)).toBe(join(d, 'agentclaw.sqlite'));
    writeFileSync(join(d, 'hatchabot.sqlite'), '');
    expect(defaultDbPath(d)).toBe(join(d, 'hatchabot.sqlite'));
    expect(defaultBackupsDir()).toMatch(/(hatchabot|agentclaw)-backups$/);
  });
});
