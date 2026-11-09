import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { processAlive } from '../src/domain/processAlive.js';

/**
 * Three copies of "is this pid running" (the one-shot sweep, the backup
 * lock, the embedder's half-made model files) could drift apart: one
 * helper now, and no copy of its own anywhere else.
 */
describe('one pid-liveness check', () => {
  it('a running process is alive, one that has ended is not', () => {
    expect(processAlive(process.pid)).toBe(true);
    const done = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    expect(done.pid).toBeGreaterThan(0);
    expect(processAlive(done.pid!)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('another user\'s process (EPERM) counts as alive', () => {
    expect(processAlive(1)).toBe(true);
  });

  it('the sweep, the backup lock and the embedder use it, with no copy of their own', () => {
    for (const f of ['src/providers/localDockerProvider.ts', 'src/orchestrator/backups.ts', 'src/embedder/embedder.ts']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/import \{ processAlive \} from '\.\.\/domain\/processAlive\.js';/);
      expect(src, f).not.toMatch(/process\.kill\([^)]*, 0\)/);
    }
  });
});
