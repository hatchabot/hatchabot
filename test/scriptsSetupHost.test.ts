import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';
import { renderEnv } from '../src/config/envFile.js';

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
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { app, bin, home, log, run, calls };
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

  describe('this shell has no daemon of its own, only the one .env names (HB-1059)', () => {
    // docker as before, but `info` answers only on the tenant's daemon.
    const onlyTenant = (h: ReturnType<typeof host>, bin: string) => shim(bin, 'docker', `echo "docker on \${DOCKER_HOST:-default}: $*" >> '${h.log}'
[ "\${DOCKER_HOST:-}" = '${TENANT}' ] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
case "$1 $2" in "image inspect") exit 1 ;; esac
exit 0`);

    it('a re-run on an install whose .env names it: checked there, not refused', () => {
      const h = host();
      onlyTenant(h, h.bin);
      writeFileSync(join(h.app, '.env'), `HATCHABOT_SECRET_KEY=made-up\nDOCKER_HOST=${TENANT}\n`, { mode: 0o600 });
      const r = h.run();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).not.toContain('not usable by this user');
      expect(h.calls().filter((c) => c.startsWith('docker on default'))).toEqual([]);
      expect(h.calls()).toContain(`build on ${TENANT}`);
    });

    it('a full-size .env (every setting written out, as Hatchabot keeps it) with DOCKER_HOST near the top: every run (review of HB-1059)', () => {
      // grep -q piped from printf under pipefail lost the race to SIGPIPE on a file this size.
      const full = `HATCHABOT_SECRET_KEY=made-up\nDOCKER_HOST=${TENANT}\n${renderEnv('HATCHABOT_AUTH=accounts\nPORT=8080\n')}`;
      expect(full.length).toBeGreaterThan(16_000);
      expect(full.indexOf(`DOCKER_HOST=${TENANT}`)).toBeLessThan(2_000);
      const h = host();
      onlyTenant(h, h.bin);
      writeFileSync(join(h.app, '.env'), full, { mode: 0o600 });
      for (let i = 0; i < 10; i++) {
        writeFileSync(h.log, '');
        const r = h.run();
        expect(r.status, `run ${i + 1}: ${r.stdout}${r.stderr}`).toBe(0);
        expect(h.calls().filter((c) => c.startsWith('docker on default')), `run ${i + 1}`).toEqual([]);
        expect(h.calls(), `run ${i + 1}`).toContain(`build on ${TENANT}`);
      }
    });

    it('a first install given it in HATCHABOT_SETUP_ENV: the same', () => {
      const h = host();
      onlyTenant(h, h.bin);
      const r = h.run({ HATCHABOT_SETUP_ENV: `DOCKER_HOST=${TENANT}` });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(h.calls().filter((c) => c.startsWith('docker on default'))).toEqual([]);
    });

    it('the daemon it names is down: stopped before anything is installed, naming it', () => {
      const h = host();
      onlyTenant(h, h.bin);
      writeFileSync(join(h.app, '.env'), 'HATCHABOT_SECRET_KEY=made-up\nDOCKER_HOST=unix:///run/made-up-down.sock\n', { mode: 0o600 });
      const r = h.run();
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('The Docker daemon .env names (DOCKER_HOST=unix:///run/made-up-down.sock) is not reachable');
      expect(h.calls().some((c) => c === 'service' || c.startsWith('build on'))).toBe(false);
    });
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

describe('scripts/setup-host.sh checks the image and mirror .env names, as the service and upgrade.sh use them (HB-1210)', () => {
  /** docker answers each image with its OpenClaw (VERSIONS: "image=version ..."), or as not there; the fetch writes down where it went. */
  function imageHost(versions: string) {
    const h = host();
    shim(h.bin, 'docker', `case "$1 $2" in
  "image inspect")
    img=""; for a in "$@"; do case "$a" in image|inspect|--format|*'{{'*) ;; *) img="$a" ;; esac; done
    echo "inspect $img" >> '${h.log}'
    for pair in ${versions}; do [ "\${pair%%=*}" = "$img" ] && { case "$*" in *--format*) echo "\${pair#*=}" ;; esac; exit 0; }; done
    exit 1 ;;
esac
exit 0`);
    shim(join(h.app, 'scripts'), 'build-runtime-image.sh', `echo "fetch into \${HATCHABOT_IMAGE:-default} from \${HATCHABOT_IMAGE_REGISTRY:-default}" >> '${h.log}'`);
    return h;
  }
  const env = (h: ReturnType<typeof host>, lines: string) => writeFileSync(join(h.app, '.env'), `HATCHABOT_SECRET_KEY=made-up\n${lines}`, { mode: 0o600 });
  const imageCalls = (h: ReturnType<typeof host>) => h.calls().filter((c) => /^(inspect|fetch) /.test(c));

  it('an older image in the repository .env names is fetched there, from the mirror .env names, though the default one is up to date', () => {
    const h = imageHost('hatchabot-runtime:latest=2026.9.8 made-up-runtime:latest=2026.7.1');
    env(h, 'HATCHABOT_IMAGE="made-up-runtime:latest"\nHATCHABOT_IMAGE_REGISTRY=registry.example.test/runtime\n');
    const r = h.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('carries OpenClaw 2026.7.1; this release\'s default is 2026.9.8');
    expect(imageCalls(h)).toEqual(['inspect made-up-runtime:latest', 'inspect made-up-runtime:latest', 'fetch into made-up-runtime:latest from registry.example.test/runtime']);
  });

  it('a newer one promoted in the repository .env names is kept, though the default one is older', () => {
    const h = imageHost('hatchabot-runtime:latest=2026.1.1 made-up-runtime:latest=2026.12.1');
    env(h, 'HATCHABOT_IMAGE=made-up-runtime\n');
    const r = h.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Runtime image already present');
    expect(imageCalls(h).filter((c) => c.startsWith('fetch'))).toEqual([]);
  });

  it('an image pinned to another tag is kept when it is here, and said when it is not; neither is fetched over', () => {
    const here = imageHost('made-up-runtime:2026.7.1=2026.7.1');
    env(here, 'HATCHABOT_IMAGE=made-up-runtime:2026.7.1\n');
    const r = here.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('The runtime image is pinned to made-up-runtime:2026.7.1 (HATCHABOT_IMAGE) — keeping it.');
    expect(imageCalls(here)).toEqual(['inspect made-up-runtime:2026.7.1']);
    const gone = imageHost('hatchabot-runtime:latest=2026.9.8');
    env(gone, 'HATCHABOT_IMAGE=made-up-runtime:2026.7.1\n');
    const g = gone.run();
    expect(g.status, g.stdout + g.stderr).toBe(0);
    expect(g.stdout).toContain('The runtime image .env pins, made-up-runtime:2026.7.1 (HATCHABOT_IMAGE), is not on this machine');
    expect(imageCalls(gone).filter((c) => c.startsWith('fetch'))).toEqual([]);
  });

  it('read as the service reads .env: spaces around the = and before the name on Linux, a $VAR on a Mac (review of HB-1210)', () => {
    const linux = imageHost('hatchabot-runtime:latest=2026.9.8 made-up-runtime:latest=2026.7.1');
    env(linux, 'HATCHABOT_IMAGE = made-up-runtime:latest\n  HATCHABOT_IMAGE_REGISTRY = registry.example.test/runtime\n');
    const r = linux.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(imageCalls(linux)).toContain('fetch into made-up-runtime:latest from registry.example.test/runtime');
    const mac = imageHost('hatchabot-runtime:latest=2026.9.8 made-up-runtime:latest=2026.7.1');
    shim(mac.bin, 'uname', 'echo Darwin');
    env(mac, 'MIRROR_HOST=registry.example.test\nHATCHABOT_IMAGE=made-up-runtime\nHATCHABOT_IMAGE_REGISTRY="$MIRROR_HOST/runtime"\n');
    const m = mac.run();
    expect(m.status, m.stdout + m.stderr).toBe(0);
    expect(imageCalls(mac)).toContain('fetch into made-up-runtime from registry.example.test/runtime');
  });

  it('none named: hatchabot-runtime:latest from the default registry, as before', () => {
    const h = imageHost('hatchabot-runtime:latest=2026.1.1');
    env(h, '');
    expect(h.run().status).toBe(0);
    expect(imageCalls(h)).toEqual(['inspect hatchabot-runtime:latest', 'inspect hatchabot-runtime:latest', 'fetch into default from default']);
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

describe('scripts/setup-host.sh saves the CLI the listener the service has, as restart.sh reaches it (HB-1109)', () => {
  const saved = (h: ReturnType<typeof host>) => {
    const f = join(h.home, '.config', 'hatchabot', 'env');
    return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('HATCHABOT_URL=')) : [];
  };
  const setUp = (lines: string, os = 'Linux') => {
    const h = host('2026.9.8', os);
    writeFileSync(join(h.app, '.env'), `HATCHABOT_SECRET_KEY=made-up\n${lines}`, { mode: 0o600 });
    const r = h.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return h;
  };

  it('TLS served by Hatchabot itself on another port: https, at a name a certificate is likelier to carry', () => {
    expect(saved(setUp('PORT=8443\nHATCHABOT_TLS_CERT="/made/up/cert.pem"\nHATCHABOT_TLS_KEY=/made/up/key.pem\n'))).toEqual(['HATCHABOT_URL=https://localhost:8443']);
    // On the default port too: http://localhost:8080 is not it.
    expect(saved(setUp('HATCHABOT_TLS_CERT=/made/up/cert.pem\nHATCHABOT_TLS_KEY=/made/up/key.pem\n'))).toEqual(['HATCHABOT_URL=https://localhost:8080']);
  });

  it('listening on one address only: that address (an IPv6 one in brackets), not loopback', () => {
    expect(saved(setUp('PORT = 9137\nHATCHABOT_BIND = 192.0.2.10\nHATCHABOT_TLS_CERT=/made/up/cert.pem\n'))).toEqual(['HATCHABOT_URL=https://192.0.2.10:9137']);
    expect(saved(setUp('HATCHABOT_BIND=2001:db8::5\n'))).toEqual(['HATCHABOT_URL=http://[2001:db8::5]:8080']);
  });

  it('as before: plain http on loopback or every address is 127.0.0.1 on another port, nothing on 8080; one saved stays', () => {
    expect(saved(setUp('PORT=9137\nHATCHABOT_BIND=0.0.0.0\n'))).toEqual(['HATCHABOT_URL=http://127.0.0.1:9137']);
    expect(saved(setUp('HATCHABOT_BIND=127.0.0.1\n'))).toEqual([]);
    const h = host();
    mkdirSync(join(h.home, '.config', 'hatchabot'), { recursive: true });
    writeFileSync(join(h.home, '.config', 'hatchabot', 'env'), 'HATCHABOT_URL=https://hatchabot.example.test\n', { mode: 0o600 });
    writeFileSync(join(h.app, '.env'), 'HATCHABOT_SECRET_KEY=made-up\nPORT=8443\nHATCHABOT_TLS_CERT=/made/up/cert.pem\n', { mode: 0o600 });
    expect(h.run().status).toBe(0);
    expect(saved(h)).toEqual(['HATCHABOT_URL=https://hatchabot.example.test']);
  });

  it('a Mac reads them as its launchd job does: HATCHABOT_BIND = 192.0.2.10 sets nothing there', () => {
    expect(saved(setUp('PORT=8443\nHATCHABOT_BIND = 192.0.2.10\nHATCHABOT_TLS_CERT=/made/up/cert.pem\n', 'Darwin'))).toEqual(['HATCHABOT_URL=https://localhost:8443']);
  });
});
