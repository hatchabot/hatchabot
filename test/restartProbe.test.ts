import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// scripts/restart.sh's health probe asks the listener as the service is
// configured (#225). Sandboxed: a temp HOME, and shims for systemctl,
// launchctl, uname, curl and sleep, so nothing reaches the real machine.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Restart a fake install whose service answers only at `serving`; returns the URLs curl was asked for. */
function restart(env: string, serving: string) {
  const root = mkdtempSync(join(tmpdir(), 'hb-restart-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const repo = join(root, 'install'); mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'restart.sh'), readFileSync('scripts/restart.sh'), { mode: 0o755 });
  writeFileSync(join(repo, 'scripts', 'ensure-deps.sh'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(repo, '.env'), env);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const asked = join(root, 'curl.log');
  for (const tool of ['systemctl', 'launchctl', 'sleep', 'journalctl']) writeFileSync(join(bin, tool), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'uname'), '#!/usr/bin/env bash\necho Linux\n', { mode: 0o755 });
  // The last argument is the URL; only the listener's real address answers.
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\nurl="\${@: -1}"\necho "$* " >> ${JSON.stringify(asked)}\n[ "$url" = ${JSON.stringify(serving)} ]\n`, { mode: 0o755 });
  const r = spawnSync('bash', [join(repo, 'scripts', 'restart.sh')], { encoding: 'utf8', env: scriptEnv(home, `${bin}:/usr/bin:/bin`) });
  let calls: string[] = [];
  try { calls = readFileSync(asked, 'utf8').trim().split('\n'); } catch { /* never called */ }
  return { status: r.status, out: r.stdout + r.stderr, calls };
}

describe('scripts/restart.sh health probe (#225)', () => {
  it('asks a native-TLS listener over https', () => {
    const r = restart('HATCHABOT_SECRET_KEY=x\nPORT=8443\nHATCHABOT_TLS_CERT=/etc/hb/cert.pem\nHATCHABOT_TLS_KEY=/etc/hb/key.pem\n', 'https://localhost:8443/healthz');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('up on https://localhost:8443');
    expect(r.calls).toHaveLength(1);
  });

  it('asks a listener bound to one address at that address', () => {
    expect(restart('PORT="9090"  # quoted, with a comment\nHATCHABOT_BIND=192.0.2.10\n', 'http://192.0.2.10:9090/healthz').status).toBe(0);
    expect(restart('HATCHABOT_BIND=fd00::10\n', 'http://[fd00::10]:8080/healthz').status).toBe(0);
  });

  it('a plain listener (TLS in front, or none) is still asked at http://localhost', () => {
    const r = restart('HATCHABOT_BIND=0.0.0.0\n', 'http://localhost:8080/healthz');
    expect(r.status, r.out).toBe(0);
  });

  it('a listener that does not answer still fails, naming where it was asked', () => {
    const r = restart('HATCHABOT_TLS_CERT=/etc/hb/cert.pem\n', 'nowhere');
    expect(r.status).toBe(1);
    expect(r.out).toContain("isn't answering at https://localhost:8080");
  });
});
