import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * scripts/uninstall.sh in a sandbox: systemctl, docker, npm and launchctl are
 * shims on PATH that only record what they were asked, HOME is a temp dir with
 * the CLI's env and channel pin, the "install" is a temp dir with an .env and
 * a database. What the 30th audit asked for: --purge refuses when the database
 * is there but cannot be read (it would orphan every volume), and the user's
 * CLI token and channel pin survive a plain uninstall.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hb-uninstall-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(join(home, '.config', 'hatchabot'), { recursive: true });
  writeFileSync(join(home, '.config', 'hatchabot', 'env'), 'HATCHABOT_URL=http://127.0.0.1:8080\nHATCHABOT_TOKEN=fake-cli-token\n');
  writeFileSync(join(home, '.config', 'hatchabot', 'channel'), 'stable\n');
  const repo = join(root, 'install'); mkdirSync(join(repo, 'scripts'), { recursive: true }); mkdirSync(join(repo, 'data'));
  writeFileSync(join(repo, 'scripts', 'uninstall.sh'), readFileSync('scripts/uninstall.sh'), { mode: 0o755 });
  writeFileSync(join(repo, '.env'), 'HATCHABOT_SECRET_KEY=x\n');
  writeFileSync(join(repo, 'data', 'hatchabot.sqlite'), 'not really a database');
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'calls.log');
  for (const tool of ['systemctl', 'docker', 'npm', 'launchctl']) {
    writeFileSync(join(bin, tool), `#!/usr/bin/env bash\necho "${tool} $*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  }
  return { home, repo, bin, log };
}
const run = (w: ReturnType<typeof world>, args: string[]) =>
  spawnSync('bash', [join(w.repo, 'scripts', 'uninstall.sh'), ...args], {
    // A minimal PATH: the script removes the `hbt` shim it finds on PATH, and with the
    // user's PATH it removed the machine's real one (2026-09-27). Only the shims and the system dirs.
    encoding: 'utf8', env: { ...process.env, HOME: w.home, PATH: `${w.bin}:/usr/bin:/bin` },
  });

describe('scripts/uninstall.sh', () => {
  it('--purge refuses when the database is there but its reader is not installed', () => {
    const w = world();
    const r = run(w, ['--purge', '--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toMatch(/Cannot read the database/);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    expect(existsSync(w.log)).toBe(false); // nothing was stopped or removed
  });

  it('without --purge the user\'s CLI token and channel pin stay; the service is stopped, not the data', () => {
    const w = world();
    const r = run(w, ['--yes']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(w.home, '.config', 'hatchabot', 'env'))).toBe(true);
    expect(existsSync(join(w.home, '.config', 'hatchabot', 'channel'))).toBe(true);
    expect(existsSync(join(w.repo, 'data', 'hatchabot.sqlite'))).toBe(true);
    const calls = readFileSync(w.log, 'utf8');
    expect(calls).not.toMatch(/docker (rm|volume rm|rmi)/);
  });
});
