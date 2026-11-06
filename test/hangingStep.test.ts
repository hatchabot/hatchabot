import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hangingStep } from './helpers/scriptEnv.js';

/**
 * The install stand-in the cut-off tests signal (HB-0505): a SIGINT sent the
 * moment it says it is hanging must end it, every time. `touch started; exec
 * sleep 30` lost about one in five, and its test ran into its timeout on CI.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('the hanging install step of the script tests', () => {
  it('ends on a SIGINT sent as soon as it has started, under a script that traps INT as deploy-release.sh does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-hang-')); dirs.push(dir);
    const started = join(dir, 'started');
    const step = join(dir, 'step');
    writeFileSync(step, hangingStep(started), { mode: 0o755 });
    let hung = 0;
    for (let i = 0; i < 20; i++) {
      rmSync(started, { force: true });
      const p = spawn('bash', ['-c', `trap 'exit 130' INT; cd ${JSON.stringify(dir)}; ${JSON.stringify(step)} || exit 3`], { detached: true, stdio: 'ignore' });
      const ended = new Promise<void>((resolve) => p.on('exit', () => resolve()));
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => { if (existsSync(started)) { clearInterval(poll); process.kill(-p.pid!, 'SIGINT'); resolve(); } }, 1);
      });
      const late = setTimeout(() => { hung++; process.kill(-p.pid!, 'SIGKILL'); }, 3000);
      await ended;
      clearTimeout(late);
    }
    expect(hung).toBe(0);
  }, 60_000);
});
