import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * scripts/first-run-link.sh in a sandbox: a throwaway checkout with its own
 * .env, a temp HOME, and shims for curl (never answers; logs what it was
 * asked) and sleep (no waiting).
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(env: string, serving = '', os = 'Linux') {
  const root = mkdtempSync(join(tmpdir(), 'hb-firstrun-')); dirs.push(root);
  const home = join(root, 'home'), bin = join(root, 'bin'), work = join(root, 'work');
  for (const d of [home, bin, join(work, 'scripts')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(work, 'scripts', 'first-run-link.sh'), readFileSync('scripts/first-run-link.sh'), { mode: 0o755 });
  writeFileSync(join(work, '.env'), env);
  // Answers (a first run, setup code needed) only at `serving`.
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(join(root, 'curl.log'))}\n[ -n ${JSON.stringify(serving)} ] && [ "\${@: -1}" = ${JSON.stringify(serving)} ] && { echo '{"needsSetup":true}'; exit 0; }\nexit 7\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'journalctl'), `#!/usr/bin/env bash\necho 'hatchabot: {"msg":"first-run setup code","setupCode":"0a1b2c3d"}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'hostname'), '#!/usr/bin/env bash\necho 192.168.50.20\n', { mode: 0o755 });
  writeFileSync(join(bin, 'uname'), `#!/usr/bin/env bash\necho ${os}\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'ipconfig'), '#!/usr/bin/env bash\necho 192.168.50.20\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('bash', [join(work, 'scripts', 'first-run-link.sh')], { cwd: work, env: scriptEnv(home, `${bin}:/usr/bin:/bin`), encoding: 'utf8' });
  return { ...r, asked: readFileSync(join(root, 'curl.log'), 'utf8') };
}

describe('scripts/first-run-link.sh (audit, 2026-10-22)', () => {
  it('reads a quoted PORT as the port, not with its quotes', () => {
    for (const env of ['PORT="8123"\n', "PORT='8123'\n", 'PORT=8123 # my port\n', 'PORT=8123\n']) {
      const r = run(env);
      expect(r.status, env).toBe(0);
      expect(r.stdout, env).toContain('did not answer on port 8123 yet — open http://localhost:8123 in a minute');
      expect(r.asked, env).toContain('http://127.0.0.1:8123/v1/config');
    }
  });
});

describe('scripts/first-run-link.sh asks the listener as the service is configured (audit, 2026-10-29)', () => {
  it('native TLS on one address: asked there over https, and the link is that address with the setup code', () => {
    const r = run('PORT=9137\nHATCHABOT_TLS_CERT=/etc/hb/cert.pem\nHATCHABOT_BIND=192.0.2.10\n', 'https://192.0.2.10:9137/v1/config');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.asked).toContain('https://192.0.2.10:9137/v1/config');
    expect(r.stdout).toContain('Open Hatchabot:  https://192.0.2.10:9137/#setup=0a1b2c3d');
    expect(r.stdout).not.toContain('localhost');
  });

  it('native TLS on every address: the LAN link is https too; on this machine, https://localhost', () => {
    const r = run('PORT = 9137\nHATCHABOT_TLS_CERT=/etc/hb/cert.pem\n', 'https://127.0.0.1:9137/v1/config');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Open Hatchabot:  https://192.168.50.20:9137/#setup=0a1b2c3d');
    expect(r.stdout).toContain('(on this machine: https://localhost:9137/#setup=0a1b2c3d)');
  });

  it('a loopback listener gets no LAN link, which could not reach it', () => {
    const r = run('PORT=9137\nHATCHABOT_BIND=127.0.0.1\n', 'http://localhost:9137/v1/config');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Open Hatchabot:  http://localhost:9137/#setup=0a1b2c3d');
    expect(r.stdout).not.toContain('192.168.50.20');
  });

  it('on a Mac, .env is read as the launchd job reads it, with bash: PORT = 9137 leaves the service on 8080', () => {
    const r = run('PORT = 9137\n', 'http://127.0.0.1:8080/v1/config', 'Darwin');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.asked).toContain('http://127.0.0.1:8080/v1/config');
    expect(r.stdout).toContain('Open Hatchabot:  http://192.168.50.20:8080');
  });

  it('not answering, it names where to open it', () => {
    const r = run('PORT=9137\nHATCHABOT_TLS_CERT=/etc/hb/cert.pem\nHATCHABOT_BIND=192.0.2.10\n');
    expect(r.stdout).toContain('did not answer on port 9137 yet — open https://192.0.2.10:9137 in a minute');
  });
});
