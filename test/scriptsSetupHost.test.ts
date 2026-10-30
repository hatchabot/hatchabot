import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts in a sandbox; vitest's 5 s was not
// enough under load on the self-hosted runner (2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * scripts/setup-host.sh, unattended, in a sandbox: a temp HOME, a docker that
 * only records which daemon it was asked (DOCKER_HOST) and what, and the
 * steps around the image (dependencies, the service, the CLI link) as shims
 * that record the same. Nothing reaches a real daemon or service.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const shim = (dir: string, name: string, body: string) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const TENANT = 'unix:///run/made-up-tenant/docker.sock';

function host(label = '2026.9.8', os = 'Linux') {
  const root = mkdtempSync(join(tmpdir(), 'hb-setup-host-')); dirs.push(root);
  const app = join(root, 'app'), bin = join(root, 'bin'), home = join(root, 'home'), log = join(root, 'calls.log');
  for (const d of [join(app, 'scripts'), join(app, 'docker'), join(app, 'node_modules', '.bin'), bin, home]) mkdirSync(d, { recursive: true });
  writeFileSync(join(app, 'scripts', 'setup-host.sh'), readFileSync('scripts/setup-host.sh'), { mode: 0o755 });
  writeFileSync(join(app, 'docker', 'Dockerfile.runtime'), 'ARG OPENCLAW_VERSION=2026.9.8\n');
  for (const s of ['ensure-deps.sh', 'link-cli.sh', 'launchd-plist.sh']) shim(join(app, 'scripts'), s, 'exit 0');
  shim(join(app, 'scripts'), 'first-run-link.sh', `echo "first-run link on $1" >> '${log}'`);
  shim(join(app, 'node_modules', '.bin'), 'tsx', 'exit 0');
  shim(join(app, 'scripts'), 'build-runtime-image.sh', `echo "build on \${DOCKER_HOST:-default}" >> '${log}'`);
  shim(join(app, 'scripts'), 'install-service.sh', `echo "service" >> '${log}'`);
  // The machine's default daemon has the image; the tenant's daemon has none.
  shim(bin, 'docker', `echo "docker on \${DOCKER_HOST:-default}: $*" >> '${log}'
case "$1 $2" in
  "image inspect") [ "\${DOCKER_HOST:-}" != '${TENANT}' ] || exit 1; case "$*" in *--format*) echo '${label}' ;; esac ;;
esac
exit 0`);
  shim(bin, 'uname', `echo ${os}`);
  shim(bin, 'launchctl', 'exit 0');
  symlinkSync(process.execPath, join(bin, 'node'));
  const run = (extra: Record<string, string> = {}) => spawnSync('bash', [join(app, 'scripts', 'setup-host.sh')], {
    encoding: 'utf8', input: '', env: scriptEnv(home, `${bin}:/usr/bin:/bin`, { HATCHABOT_SETUP_SIGNIN: 'accounts', ...extra }),
  });
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { app, run, calls };
}

describe('scripts/setup-host.sh prepares the runtime image on the daemon the service will use (audit #040)', () => {
  it('a DOCKER_HOST given for the new .env (HATCHABOT_SETUP_ENV): the image is looked for and fetched there', () => {
    const h = host();
    const r = h.run({ HATCHABOT_SETUP_ENV: `DOCKER_HOST=${TENANT}\nHATCHABOT_PREFIX=t1` });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(h.app, '.env'), 'utf8')).toContain(`DOCKER_HOST=${TENANT}`);
    expect(r.stdout).toContain('Getting the agent runtime image (downloads it, or builds it if none is published)');
    expect(r.stdout).not.toContain('Runtime image already present');
    const calls = h.calls();
    expect(calls).toContain(`build on ${TENANT}`);
    expect(calls).toContain(`docker on ${TENANT}: image inspect hatchabot-runtime:latest`);
    // Once .env is written, nothing asks the default daemon about the image.
    const after = calls.slice(calls.findIndex((c) => c.startsWith(`docker on ${TENANT}`)));
    expect(after.filter((c) => c.startsWith('docker on default') || c === 'build on default')).toEqual([]);
  });

  it('an .env kept from before names it too (the last line, quoted or not)', () => {
    const h = host();
    writeFileSync(join(h.app, '.env'), `HATCHABOT_SECRET_KEY=made-up\nDOCKER_HOST=unix:///run/old.sock\nDOCKER_HOST="${TENANT}"\n`, { mode: 0o600 });
    const r = h.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(h.calls()).toContain(`build on ${TENANT}`);
  });

  it('no DOCKER_HOST in .env: the default daemon, as before', () => {
    const h = host();
    const r = h.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Runtime image already present');
    expect(h.calls().some((c) => c.includes(TENANT))).toBe(false);
  });
});

describe('scripts/setup-host.sh brings an older :latest up to this release\'s default', () => {
  it('an image with no OpenClaw version label (old or hand-built) is fetched, not kept (HB-0041)', () => {
    for (const label of ['', '<no value>']) {
      const h = host(label);
      const r = h.run();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('carries no OpenClaw version label');
      expect(r.stdout).not.toContain('Runtime image already present');
      expect(h.calls()).toContain('build on default');
    }
  });

  it('an older label is fetched; the same or a newer one is kept', () => {
    const older = host('2026.7.1'); const ro = older.run();
    expect(ro.stdout).toContain('carries OpenClaw 2026.7.1');
    expect(older.calls()).toContain('build on default');
    for (const label of ['2026.9.8', '2026.10.1']) {
      const h = host(label); const r = h.run();
      expect(r.stdout, label).toContain('Runtime image already present');
      expect(h.calls(), label).not.toContain('build on default');
    }
  });
});

describe('scripts/setup-host.sh reads PORT as the service will (audit, 2026-10-29)', () => {
  it('Linux: spaces around the = count, as systemd reads them; the CLI and the link get that port', () => {
    const h = host();
    writeFileSync(join(h.app, '.env'), 'HATCHABOT_SECRET_KEY=made-up\nPORT = 9137\n', { mode: 0o600 });
    const r = h.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(h.calls()).toContain('first-run link on 9137');
  });

  it('a Mac: the launchd job sources .env with bash, where PORT = 9137 sets nothing, so the service is on 8080', () => {
    const h = host('2026.9.8', 'Darwin');
    writeFileSync(join(h.app, '.env'), 'HATCHABOT_SECRET_KEY=made-up\nPORT=7000\nPORT = 9137\n', { mode: 0o600 });
    const r = h.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(h.calls()).toContain('first-run link on 7000');
    writeFileSync(join(h.app, '.env'), 'HATCHABOT_SECRET_KEY=made-up\nPORT= 9137\n', { mode: 0o600 });
    expect(h.run().status).toBe(0);
    expect(h.calls()).toContain('first-run link on 8080');
  });
});
