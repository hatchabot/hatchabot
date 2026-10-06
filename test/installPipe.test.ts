import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * `curl -fsSL …/install.sh | bash` — bash reads the installer from the pipe as
 * it runs, and the installer points its input at the terminal so it can ask
 * questions. When that happened mid-script, bash read the rest of the SCRIPT
 * from the terminal and sat there (over ssh on a Mac, 2026-10-06). Run it that
 * way, in a pseudo-terminal, as a dry run naming a version (no network).
 */
const have = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const dockerUp = have('docker') && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

describe('install.sh piped into bash', () => {
  it.skipIf(!have('script') || !dockerUp)('finishes instead of waiting on the terminal', () => {
    const r = spawnSync('script', ['-qec', 'cat install.sh | HATCHABOT_DRY_RUN=1 HATCHABOT_DIR=/tmp/hb-pipe-test bash -s -- v9.9.9', '/dev/null'], { encoding: 'utf8', timeout: 30_000 });
    expect(r.error, 'timed out: the piped installer waited on the terminal').toBeUndefined();
    expect(r.stdout).toContain('channel v9.9.9 → release v9.9.9');
    expect(r.stdout).toContain('dry run');
  });
});
