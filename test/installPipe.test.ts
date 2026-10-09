import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * `curl -fsSL …/install.sh | bash` — bash reads the installer from the pipe as
 * it runs, and the installer points its input at the terminal so it can ask
 * questions. When that happened mid-script, bash read the rest of the SCRIPT
 * from the terminal and sat there (over ssh on a Mac, 2026-10-06). Run it that
 * way, in a pseudo-terminal, as a dry run naming a version (no network) — in a
 * sandbox: a temp HOME, a docker shim, an environment built from scratch (it
 * used to run with the real docker and the caller's whole environment).
 */
const have = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('install.sh piped into bash', () => {
  it.skipIf(!have('script'))('finishes instead of waiting on the terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-pipe-')); dirs.push(root);
    const home = join(root, 'home'); mkdirSync(home);
    const bin = join(root, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), '#!/usr/bin/env bash\ncase "$1" in version) echo 27.0 ;; esac\nexit 0\n', { mode: 0o755 });
    const r = spawnSync('script', ['-qec', `cat ${JSON.stringify(resolve('install.sh'))} | HATCHABOT_DRY_RUN=1 HATCHABOT_DIR=${JSON.stringify(join(root, 'hatchabot'))} bash -s -- v9.9.9`, '/dev/null'], {
      encoding: 'utf8', timeout: 30_000, env: scriptEnv(home, `${bin}:/usr/bin:/bin`),
    });
    expect(r.error, 'timed out: the piped installer waited on the terminal').toBeUndefined();
    expect(r.stdout).toContain('channel v9.9.9 → release v9.9.9');
    expect(r.stdout).toContain('dry run');
  });
});
