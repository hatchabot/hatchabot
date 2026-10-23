import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/first-run-link.sh in a sandbox: a throwaway checkout with its own
 * .env, a temp HOME, and shims for curl (never answers; logs what it was
 * asked) and sleep (no waiting).
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(env: string) {
  const root = mkdtempSync(join(tmpdir(), 'hb-firstrun-')); dirs.push(root);
  const home = join(root, 'home'), bin = join(root, 'bin'), work = join(root, 'work');
  for (const d of [home, bin, join(work, 'scripts')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(work, 'scripts', 'first-run-link.sh'), readFileSync('scripts/first-run-link.sh'), { mode: 0o755 });
  writeFileSync(join(work, '.env'), env);
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(join(root, 'curl.log'))}\nexit 7\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('bash', [join(work, 'scripts', 'first-run-link.sh')], { cwd: work, env: scriptEnv(home, `${bin}:/usr/bin:/bin`), encoding: 'utf8' });
  return { ...r, asked: readFileSync(join(root, 'curl.log'), 'utf8') };
}

describe('scripts/first-run-link.sh (audit, 2026-10-22)', () => {
  it('reads a quoted PORT as the port, not with its quotes', { timeout: 30_000 }, () => { // several bash runs; CI's loaded runner passed 5 s (2026-10-23)
    for (const env of ['PORT="8123"\n', "PORT='8123'\n", 'PORT=8123 # my port\n', 'PORT=8123\n']) {
      const r = run(env);
      expect(r.status, env).toBe(0);
      expect(r.stdout, env).toContain('did not answer on port 8123 yet — open http://localhost:8123 in a minute');
      expect(r.asked, env).toContain('http://127.0.0.1:8123/v1/config');
    }
  });
});
