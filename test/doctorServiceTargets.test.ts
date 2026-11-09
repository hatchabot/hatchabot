import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addressesOf, doctorTarget, envMap, probeControlPlane, serviceDockerEnv, servicePort, serviceUrl } from '../src/doctor.js';

/**
 * The deep audit of v2.177.0 (2026-11-07): `hatchabot doctor` asked
 * http://localhost:8080 and the shell's Docker whatever the service's .env
 * said (HB-0549, HB-0550), and its HTTPS probe could wait for good on an
 * answer cut off in its body (HB-0551).
 */

describe('doctor asks the listener the service is set up with (HB-0549)', () => {
  it('scheme, port and bind address come from the .env, as restart.sh reads them', () => {
    expect(serviceUrl({})).toBe('http://localhost:8080');
    expect(serviceUrl({ PORT: '9137' })).toBe('http://localhost:9137');
    expect(serviceUrl({ PORT: '9137', HATCHABOT_BIND: '0.0.0.0', HATCHABOT_TLS_CERT: '/made-up/cert.pem' })).toBe('https://localhost:9137');
    expect(serviceUrl({ HATCHABOT_BIND: '192.0.2.7' })).toBe('http://192.0.2.7:8080');
    expect(serviceUrl({ HATCHABOT_BIND: 'fd00::7' })).toBe('http://[fd00::7]:8080');
    expect(serviceUrl({ HATCHABOT_BIND: '[fd00::7]', PORT: 'not-a-port' })).toBe('http://[fd00::7]:8080');
  });
});

describe('a saved local URL does not hide a PORT or bind change in the .env', () => {
  const own = new Set(['localhost', '::1', '0.0.0.0', 'made-up-box', '192.0.2.10']);
  const env = { PORT: '9137' };
  // A made-up resolver: names that resolve to this machine, one elsewhere, one that never answers.
  const names: Record<string, string[]> = {
    'made-up-box.example.org': ['192.0.2.10'], 'made-up-box.local': ['::ffff:192.0.2.10'],
    'made-up-box.tail-made-up.ts.net': ['100.64.0.10', '127.0.1.1'], 'hatchabot.example.org': ['192.0.2.99'],
  };
  const resolve = async (h: string) => {
    if (h === 'slow.example.org') return new Promise<string[]>(() => {});
    return names[h] ?? [];
  };
  const target = (flag: string | undefined, saved: string | undefined, e: Record<string, string> = env) => doctorTarget(flag, saved, e, own, resolve);
  it('setup-host.sh\'s saved http://127.0.0.1:<PORT> gives way to the .env\'s listener', async () => {
    expect(await target(undefined, 'http://127.0.0.1:8090')).toBeUndefined();
    expect(await target(undefined, 'http://localhost:8090')).toBeUndefined();
    expect(await target(undefined, 'http://[::1]:8090')).toBeUndefined();
    expect(await target(undefined, 'https://made-up-box:8090')).toBeUndefined();
    expect(await target(undefined, 'https://192.0.2.10:8090/')).toBeUndefined();
  });
  it('a full name, a .local name or a tailnet name for this machine is this machine', async () => {
    expect(await target(undefined, 'https://made-up-box.example.org:8090')).toBeUndefined();
    expect(await target(undefined, 'https://made-up-box.local:8090')).toBeUndefined();
    expect(await target(undefined, 'https://made-up-box.tail-made-up.ts.net')).toBeUndefined();
  });
  it('a saved remote URL is kept, and so is a local one when there is no .env to go by', async () => {
    expect(await target(undefined, 'https://hatchabot.example.org')).toBe('https://hatchabot.example.org');
    expect(await target(undefined, 'http://192.0.2.99:8090')).toBe('http://192.0.2.99:8090');
    expect(await target(undefined, 'https://unknown.example.org')).toBe('https://unknown.example.org');
    expect(await target(undefined, 'http://127.0.0.1:8090', {})).toBe('http://127.0.0.1:8090');
  });
  it('a name that does not resolve in time is judged as before, within the limit', async () => {
    const started = Date.now();
    const bounded = (h: string) => addressesOf(h, 50, resolve);
    expect(await doctorTarget(undefined, 'https://slow.example.org', env, own, bounded)).toBe('https://slow.example.org');
    expect(await doctorTarget(undefined, 'https://made-up-box.local', env, own, bounded)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await addressesOf('broken.example.org', 50, () => Promise.reject(new Error('made-up ENOTFOUND')))).toEqual([]);
  });
  it('--url still wins', async () => {
    expect(await target('http://127.0.0.1:8090', 'https://hatchabot.example.org')).toBe('http://127.0.0.1:8090');
    expect(await target(undefined, undefined)).toBeUndefined();
  });
  it('the port comes from one place', () => {
    expect(servicePort({})).toBe(8080);
    expect(servicePort({ PORT: '' })).toBe(8080);
    expect(servicePort({ PORT: '9137' })).toBe(9137);
  });
});

// restart.sh probes the same listener with rules of its own in shell: its
// lines that work out the address, run alone in a sandbox, against serviceUrl.
describe('serviceUrl and scripts/restart.sh work out the same listener', () => {
  const script = readFileSync('scripts/restart.sh', 'utf8');
  const from = script.indexOf('if [ "$(uname -s)" = "Darwin" ]; then\n  envlines()');
  const to = script.indexOf('\n', script.indexOf('LISTENER="'));
  const cases: string[] = [
    '',
    'PORT=9137\n',
    // Not an inline "# note": restart.sh drops it (as bash does on a Mac),
    // while systemd keeps it in the value, as envValue reads it.
    'PORT="9137"\nHATCHABOT_BIND=192.0.2.5\n',
    'HATCHABOT_BIND=0.0.0.0\nHATCHABOT_TLS_CERT=/made-up/cert.pem\n',
    'HATCHABOT_BIND=fd00::5\nPORT=9000\n',
    'HATCHABOT_BIND=[fd00::6]\n',
    "PORT=1\nPORT='2'\n",
  ];
  it.skipIf(process.platform === 'win32')('for each .env', () => {
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const part = script.slice(from, to);
    const sandbox = mkdtempSync(join(tmpdir(), 'hb-restart-url-'));
    try {
      // Only what those lines run: sed, tail and uname, by shims.
      const bin = join(sandbox, 'bin');
      mkdirSync(bin);
      const bash = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
      for (const tool of ['sed', 'tail', 'uname']) {
        const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
        writeFileSync(join(bin, tool), `#!/bin/sh\nexec ${real} "$@"\n`, { mode: 0o755 });
      }
      for (const text of cases) {
        writeFileSync(join(sandbox, '.env'), text);
        const shell = execFileSync(bash, ['-c', `set -euo pipefail\n${part}\nprintf '%s' "$LISTENER"`], {
          cwd: sandbox, encoding: 'utf8', env: { HOME: sandbox, PATH: bin },
        });
        expect(serviceUrl(envMap(join(sandbox, '.env'))), JSON.stringify(text)).toBe(shell);
      }
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });
});

describe('doctor asks the service\'s Docker (HB-0550)', () => {
  it('the .env\'s DOCKER_* settings go over the shell\'s, and nothing else of the .env', () => {
    const env = serviceDockerEnv({ DOCKER_HOST: 'unix:///made-up/service.sock', DOCKER_TLS_VERIFY: '1', HATCHABOT_PASSWORD: 'made-up' }, { PATH: '/made-up/bin', DOCKER_HOST: 'unix:///made-up/shell.sock' });
    expect(env).toEqual({ PATH: '/made-up/bin', DOCKER_HOST: 'unix:///made-up/service.sock', DOCKER_TLS_VERIFY: '1' });
  });

  it('the shell\'s own DOCKER_* settings are dropped: the service never sees them', () => {
    const env = serviceDockerEnv({ HATCHABOT_PASSWORD: 'made-up' }, {
      PATH: '/made-up/bin', DOCKER_CONTEXT: 'made-up-remote', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/made-up/certs', DOCKER_HOST: 'tcp://192.0.2.9:2376',
    });
    expect(env).toEqual({ PATH: '/made-up/bin' });
  });
});

describe('gatherFacts on a sandboxed machine: the .env\'s listener and Docker (HB-0549, HB-0550)', () => {
  let dir: string; let server: Server; let port = 0;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hb-doctor-targets-'));
    server = createHttpServer((_req, res) => { res.end('<html><script>HATCHABOT_VERSION="9.8.7"</script></html>'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); });

  it('probes the .env\'s listener, not the shell\'s, and runs every docker call against the .env\'s Docker only', async () => {
    const bin = mkdtempSync(join(dir, 'bin-'));
    const work = mkdtempSync(join(dir, 'work-'));
    const log = join(dir, 'docker.log');
    writeFileSync(log, '');
    // A docker that records who it was asked to talk to; /bin/sh and builtins only.
    writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s|%s|%s\\n' "$DOCKER_HOST" "\${DOCKER_CONTEXT:-none}" "$*" >> ${JSON.stringify(log)}
case "$1" in
  --version) printf 'Docker version 99.0\\n' ;;
  version) printf '99.0|arm64\\n' ;;
  ps) printf 'made-up-service-kitchen-a1b2c3d4|bridge|running\\nmade-up-shell-garden-e5f6a7b8|bridge|running\\n' ;;
esac
exit 0
`, { mode: 0o755 });
    writeFileSync(join(work, '.env'), [
      `PORT=${port}`, 'HATCHABOT_BIND=127.0.0.1', 'DOCKER_HOST=unix:///made-up/service.sock',
      'HATCHABOT_IMAGE=made-up-service-image:1', 'HATCHABOT_PREFIX=made-up-service', 'HATCHABOT_AGENT_NETWORK=made-up-service-net',
      `HATCHABOT_DB=${join(work, 'service.sqlite')}`, `HATCHABOT_BACKUP_DIR=${join(work, 'service-backups')}`, '',
    ].join('\n'));
    const code = `const { gatherFacts } = await import(${JSON.stringify(resolve('src/doctor.ts'))}); process.chdir(${JSON.stringify(work)}); console.log('FACTS ' + JSON.stringify(await gatherFacts()));`;
    // Not spawnSync: the made-up service answers from this process.
    const r = await new Promise<{ stdout: string; stderr: string }>((done) => execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 60_000,
      // The shell's own listener settings, which are not the service's.
      env: {
        HOME: dir, PATH: bin, DOCKER_HOST: 'unix:///made-up/shell.sock', DOCKER_CONTEXT: 'made-up-shell-context', HATCHABOT_TAILSCALE_BIN: join(bin, 'no-tailscale'),
        PORT: '1', HATCHABOT_BIND: '192.0.2.8', HATCHABOT_TLS_CERT: '/made-up/shell-cert.pem',
        // …and the rest of the shell's own, none of which the service reads.
        HATCHABOT_IMAGE: 'made-up-shell-image:1', HATCHABOT_PREFIX: 'made-up-shell', HATCHABOT_AGENT_NETWORK: 'bridge',
        HATCHABOT_DB: '/made-up/shell.sqlite', HATCHABOT_BACKUP_DIR: '/made-up/shell-backups',
        HATCHABOT_AGENT_SWAP: '1g', HATCHABOT_PUBLIC_ACCESS: 'funnel',
      },
    }, (_err, stdout, stderr) => done({ stdout: String(stdout), stderr: String(stderr) })));
    const line = r.stdout.split('\n').find((l) => l.startsWith('FACTS '));
    expect(line, r.stderr).toBeDefined();
    const facts = JSON.parse(line!.slice('FACTS '.length));
    expect(facts.controlPlane).toEqual({ url: `http://localhost:${port}`, ok: true, version: '9.8.7' });
    expect(facts.dockerDaemon).toMatchObject({ ok: true, version: '99.0', arch: 'arm64' });
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(calls.length).toBeGreaterThan(2);
    expect(calls.every((c) => c.startsWith('unix:///made-up/service.sock|none|')), calls.join('\n')).toBe(true);
    expect(calls.some((c) => c.includes('image inspect') && c.endsWith(' made-up-service-image:1')), calls.join('\n')).toBe(true);
    // The .env's prefix and network: its one container, on the old shared network.
    expect(facts.containers).toEqual({ running: 1, total: 1, sharedNetwork: 1 });
    expect(facts.db.path).toBe(join(work, 'service.sqlite'));
    expect(facts.backups.dir).toBe(join(work, 'service-backups'));
    expect(facts.publicAccess.on).toBe(false);
    expect(facts.swap?.fleet ?? 'off').toBe('off');
  }, 90_000);

  // The sixth review: the CLI read the .env, then gatherFacts read it again.
  it('the map the CLI read already is used, not the file read again', async () => {
    const bin = mkdtempSync(join(dir, 'bin-'));
    const work = mkdtempSync(join(dir, 'work-'));
    const log = join(dir, 'docker-map.log');
    writeFileSync(log, '');
    writeFileSync(join(bin, 'docker'), `#!/bin/sh
printf '%s\n' "$DOCKER_HOST" >> ${JSON.stringify(log)}
case "$1" in --version) printf 'Docker version 99.0\n' ;; version) printf '99.0|arm64\n' ;; esac
exit 0
`, { mode: 0o755 });
    // The file says one thing; the map handed in says another.
    writeFileSync(join(work, '.env'), 'PORT=1\nDOCKER_HOST=unix:///made-up/file.sock\n');
    const map = { PORT: String(port), DOCKER_HOST: 'unix:///made-up/map.sock' };
    const code = `const { gatherFacts } = await import(${JSON.stringify(resolve('src/doctor.ts'))}); process.chdir(${JSON.stringify(work)}); console.log('FACTS ' + JSON.stringify(await gatherFacts(undefined, ${JSON.stringify(map)})));`;
    const r = await new Promise<{ stdout: string; stderr: string }>((done) => execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 60_000, env: { HOME: dir, PATH: bin, HATCHABOT_TAILSCALE_BIN: join(bin, 'no-tailscale') },
    }, (_err, stdout, stderr) => done({ stdout: String(stdout), stderr: String(stderr) })));
    const line = r.stdout.split('\n').find((l) => l.startsWith('FACTS '));
    expect(line, r.stderr).toBeDefined();
    expect(JSON.parse(line!.slice('FACTS '.length)).controlPlane).toEqual({ url: `http://localhost:${port}`, ok: true, version: '9.8.7' });
    const hosts = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    expect(hosts.length).toBeGreaterThan(0);
    expect(new Set(hosts)).toEqual(new Set(['unix:///made-up/map.sock']));
  }, 90_000);
});

const haveOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!haveOpenssl)('the HTTPS probe settles when an answer is cut off (HB-0551)', () => {
  let dir: string; let close: () => void; let url: string; let certPath: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hb-doctor-cut-'));
    const key = join(dir, 'own.key'); certPath = join(dir, 'own.crt');
    // Made here for this run only: a private key in the tree would be a secret.
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', certPath, '-subj', '/CN=hatchabot-test', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    // Headers and part of the body, then the connection is cut.
    const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(certPath) }, (_req, res) => {
      res.writeHead(200, { 'content-length': '100000' });
      res.write('<html>partial');
      setTimeout(() => res.socket?.destroy(), 50);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    close = () => server.close();
  });
  afterAll(() => { close?.(); rmSync(dir, { recursive: true, force: true }); });

  it('answers "not ok" with a reason instead of waiting for good', async () => {
    const waited = new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 8000).unref());
    const got = await Promise.race([probeControlPlane(url, certPath), waited]);
    expect(got).toMatchObject({ url, ok: false, error: expect.stringMatching(/cut off|closed before|aborted|reset/i) });
  }, 20_000);
});

/** A self-signed certificate made here, for this run only (a private key in the tree would be a secret). */
function namedCert(dir: string, name: string, san: string) {
  const key = join(dir, `${name}.key`); const cert = join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=hatchabot-test', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}

// 127.0.0.2 stands in for a LAN or tailnet address: not the loopback rule's
// 127.0.0.1, and on Linux it answers without any setup.
describe.skipIf(!haveOpenssl || process.platform !== 'linux')('doctor\'s TLS probe on the address the .env binds to', () => {
  let dir: string; let close: () => void; let url: string;
  let own: ReturnType<typeof namedCert>; let other: ReturnType<typeof namedCert>;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hb-doctor-bind-'));
    own = namedCert(dir, 'own', 'DNS:made-up-box.example.org');
    other = namedCert(dir, 'other', 'DNS:made-up-box.example.org');
    const server = createHttpsServer({ key: own.key, cert: own.cert }, (_req, res) => { res.end('<html><script>HATCHABOT_VERSION="9.9.9"</script></html>'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.2', r));
    url = `https://127.0.0.2:${(server.address() as { port: number }).port}`;
    close = () => server.close();
  });
  afterAll(() => { close?.(); rmSync(dir, { recursive: true, force: true }); });

  it('a certificate that does not name the bind address is still this machine\'s listener: it answers', async () => {
    expect(await probeControlPlane(url, own.certPath, '127.0.0.2')).toEqual({ url, ok: true, version: '9.9.9' });
  });
  // After the probe above, which skipped the name check: a kept TLS session
  // would have skipped it here too.
  it('the name is still checked elsewhere, and another certificate is still not trusted', async () => {
    expect(await probeControlPlane(url, own.certPath)).toMatchObject({ url, ok: false });
    expect(await probeControlPlane(url, own.certPath, '192.0.2.10')).toMatchObject({ url, ok: false });
    expect(await probeControlPlane(url, other.certPath, '127.0.0.2')).toMatchObject({ url, ok: false });
  });

  // Fifteenth review: a bind that is a name may resolve anywhere, and a
  // certificate can name it: its name is checked like any other.
  it('a bind that is a name is checked by name: answered when the certificate names it, refused when not', async () => {
    const port = new URL(url).port;
    const real = dns.lookup;
    const spy = vi.spyOn(dns, 'lookup').mockImplementation(((host: string, opts: unknown, cb?: unknown) => {
      const done = (typeof opts === 'function' ? opts : cb) as (...a: unknown[]) => void;
      const o = (typeof opts === 'object' && opts) as { all?: boolean } | false;
      if (host !== 'made-up-bind.example.org' && host !== 'made-up-box.example.org') return (real as (...a: unknown[]) => unknown)(host, opts, cb);
      if (o && o.all) done(null, [{ address: '127.0.0.2', family: 4 }]); else done(null, '127.0.0.2', 4);
    }) as never);
    try {
      const unnamed = `https://made-up-bind.example.org:${port}`;
      expect(await probeControlPlane(unnamed, own.certPath, 'made-up-bind.example.org')).toMatchObject({ url: unnamed, ok: false });
      const named = `https://made-up-box.example.org:${port}`;
      expect(await probeControlPlane(named, own.certPath, 'made-up-box.example.org')).toEqual({ url: named, ok: true, version: '9.9.9' });
    } finally { spy.mockRestore(); }
  });
});
