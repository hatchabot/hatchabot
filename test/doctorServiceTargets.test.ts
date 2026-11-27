import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addressesOf, doctorTarget, envMap, probeControlPlane, serviceDockerEnv, servicePort, serviceUrl, zonedTarget } from '../src/doctor.js';
import { inlineComments } from '../src/config/envFile.js';

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
    // A zone's % is %25 in a URL (RFC 6874; HB-1378).
    expect(serviceUrl({ HATCHABOT_BIND: 'fe80::7%eth0' })).toBe('http://[fe80::7%25eth0]:8080');
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
  it('a saved address with a zone, as setup saves one for a zoned bind address, is judged by its address: this machine\'s gives way to the .env\'s listener (HB-1539)', async () => {
    const withLinkLocal = new Set([...own, 'fe80::10']);
    const zoned = (saved: string, e: Record<string, string> = env) => doctorTarget(undefined, saved, e, withLinkLocal, resolve);
    for (const saved of ['http://[fe80::10%25eth0]:9137', 'http://[FE80::10%eth0]:9137', 'https://[fe80::10%25eth0]:9137/']) {
      expect(await zoned(saved, { PORT: '9200', HATCHABOT_BIND: 'fe80::10%eth0' }), saved).toBeUndefined();
    }
    // Another machine's link-local address, or no .env to go by: kept as chosen.
    expect(await zoned('http://[fe80::99%25eth0]:9137')).toBe('http://[fe80::99%25eth0]:9137');
    expect(await zoned('http://[fe80::10%25eth0]:9137', {})).toBe('http://[fe80::10%25eth0]:9137');
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
  // An empty or 0 PORT bound a port at random, and one systemd read with its
  // " # note" stopped the start, while doctor and the scripts asked 8080.
  it('the service, and the CLI\'s links, read PORT as doctor does: 8080 when it is empty, 0 or no number (review of HB-1529)', () => {
    const forms: string[] = [];
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
    for (const file of walk(join(import.meta.dirname, '..', 'src'))) {
      // Any object's PORT: process.env's, a .env read (the CLI's dotenv, doctor's env).
      for (const m of readFileSync(file, 'utf8').matchAll(/.{0,30}\.PORT\b.{0,30}/g)) forms.push(`${file.split('/src/')[1]}: ${m[0].trim()}`);
    }
    // index.ts, routes.ts, reachRoutes.ts, publicAccess.ts, provision.ts, proxyListener.ts, doctor.ts; cli.ts asks servicePort.
    expect(forms.length).toBeGreaterThanOrEqual(7);
    for (const line of forms) expect(line, line).toMatch(/Number\((?:process\.env|env|dotenv)\.PORT(?: \?\? 8080)?\) \|\| 8080\b/);
    // And what that reads, value by value, is doctor's port.
    for (const v of [undefined, '', '0', '9137', ' 9137 ', '9137 # note', '0x23C1', 'not-a-port']) {
      const env = { PORT: v } as NodeJS.ProcessEnv;
      expect(Number(env.PORT) || 8080, String(v)).toBe(servicePort({ PORT: v }));
      expect(Number(env.PORT ?? 8080) || 8080, String(v)).toBe(servicePort({ PORT: v }));
    }
  });
});

// restart.sh probes the same listener in shell: its lines that work out the
// address, with the functions they call, run alone in a sandbox, against
// serviceUrl.
describe('serviceUrl and scripts/restart.sh work out the same listener', () => {
  const script = readFileSync('scripts/restart.sh', 'utf8');
  const fn = (name: string) => { const at = script.indexOf(`\n${name}() {\n`); expect(at, name).toBeGreaterThan(0); return script.slice(at + 1, script.indexOf('\n}\n', at) + 3); };
  const from = script.indexOf('\nenv_named PORT HATCHABOT_TLS_CERT HATCHABOT_BIND\n') + 1;
  const to = script.indexOf('\n', script.indexOf('LISTENER="'));
  const cases: string[] = [
    '',
    'PORT=9137\n',
    'PORT="9137"\nHATCHABOT_BIND=192.0.2.5\n',
    'HATCHABOT_BIND=0.0.0.0\nHATCHABOT_TLS_CERT=/made-up/cert.pem\n',
    'HATCHABOT_BIND=fd00::5\nPORT=9000\n',
    'HATCHABOT_BIND=[fd00::6]\n',
    "PORT=1\nPORT='2'\n",
    'PORT = 9137\n  HATCHABOT_TLS_CERT =/made-up/cert.pem\nHATCHABOT_BIND= 192.0.2.10\n',
    'PORT=0x23C1\n',
    'PORT=\nHATCHABOT_TLS_CERT=\n',
    // The names from before the rename, which the service takes when the new ones are not set (HB-1529).
    'AGENTCLAW_BIND=192.0.2.10\nAGENTCLAW_TLS_CERT=/made-up/cert.pem\nPORT=9137\n',
    'AGENTCLAW_BIND=192.0.2.10\nHATCHABOT_BIND=\nAGENTCLAW_TLS_CERT=/made-up/cert.pem\n',
    // Saved with Windows line endings: a carriage return ends the value, as systemd reads it (HB-1529, HB-1530).
    'PORT=9137\r\nHATCHABOT_BIND=192.0.2.5\r\nHATCHABOT_TLS_CERT=/made-up/cert.pem\r\n',
    // A link-local address with its zone: the % written %25, as RFC 6874 has it (HB-1378).
    'HATCHABOT_BIND=fe80::5%eth0\nPORT=9137\n',
  ];
  // A "# note" after a value is part of it, as systemd keeps it: a PORT with
  // one is no port, read by both as 8080 (where the service listens then,
  // review of HB-1529), and doctor names each such setting (HB-0634). Read by sed, with the note
  // taken off, restart.sh and doctor parted here (HB-1529).
  const noted: Array<[string, string[]]> = [
    ['PORT=9137 # moved off 8080\n', ['PORT']],
    ['HATCHABOT_BIND=192.0.2.5\t# the LAN\nPORT=9000\n', ['HATCHABOT_BIND']],
  ];
  it.skipIf(process.platform === 'win32')('for each .env: old names, CRLF and a "# note" after a value too', () => {
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const part = `unset SYSTEMD_MAJOR\n${fn('systemd_major')}${fn('env_named')}${fn('service_port')}${script.slice(from, to)}`;
    const sandbox = mkdtempSync(join(tmpdir(), 'hb-restart-url-'));
    try {
      // Only what those lines run: grep, sed and uname by shims, and node (env_named reads .env with it on Linux).
      const bin = join(sandbox, 'bin');
      mkdirSync(bin);
      const bash = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
      for (const tool of ['grep', 'sed', 'uname']) {
        const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim();
        writeFileSync(join(bin, tool), `#!/bin/sh\nexec ${real} "$@"\n`, { mode: 0o755 });
      }
      symlinkSync(process.execPath, join(bin, 'node'));
      const listener = (text: string) => {
        writeFileSync(join(sandbox, '.env'), text);
        return execFileSync(bash, ['-c', `set -euo pipefail\n${part}\nprintf '%s' "$LISTENER"`], {
          cwd: sandbox, encoding: 'utf8', env: { HOME: sandbox, PATH: bin },
        });
      };
      for (const text of cases) {
        const shell = listener(text);
        expect(serviceUrl(envMap(join(sandbox, '.env'))), JSON.stringify(text)).toBe(shell);
        expect(inlineComments(text), JSON.stringify(text)).toEqual([]);
      }
      expect(listener(cases.at(-4)!)).toBe('https://192.0.2.10:9137');
      expect(listener(cases.at(-2)!)).toBe('https://192.0.2.5:9137');
      expect(listener(cases.at(-1)!)).toBe('http://[fe80::5%25eth0]:9137');
      for (const [text, names] of noted) {
        const shell = listener(text);
        expect(serviceUrl(envMap(join(sandbox, '.env'))), JSON.stringify(text)).toBe(shell);
        expect(inlineComments(text), JSON.stringify(text)).toEqual(names);
      }
      expect(listener(noted[0]![0])).toBe('http://localhost:8080');
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  });
});

describe('service_port reads PORT as the service and doctor do, the same in each script that asks the listener (HB-1529)', () => {
  const SCRIPTS = ['restart.sh', 'upgrade-helpers.sh', 'setup-host.sh', 'first-run-link.sh'];
  const fnOf = (script: string) => {
    const src = readFileSync(join('scripts', script), 'utf8');
    const at = src.indexOf('\nservice_port() {\n');
    expect(at, script).toBeGreaterThan(0);
    // With what it says of itself above it: the comment is the copy's too.
    return src.slice(src.lastIndexOf('\n# service_port VALUE:', at) + 1, src.indexOf('\n}\n', at) + 3);
  };
  it('one copy, word for word', () => {
    for (const script of SCRIPTS) expect(fnOf(script), script).toBe(fnOf('restart.sh'));
  });
  it.skipIf(process.platform === 'win32')('each value as servicePort reads it; with no node, digits alone, the white space Number drops taken off', () => {
    const values = ['', '9137', ' 9137 ', '09137', '9137 # moved', '9137\t# x', '0', 'not-a-port', '0x23C1', '-p', '--help', '9137\f', '\v9137\r\n'];
    const sandbox = mkdtempSync(join(tmpdir(), 'hb-service-port-'));
    try {
      const withNode = join(sandbox, 'with'), without = join(sandbox, 'without');
      mkdirSync(withNode); mkdirSync(without);
      symlinkSync(process.execPath, join(withNode, 'node'));
      const bash = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
      const port = (bin: string, v: string) => execFileSync(bash, ['-c', `set -euo pipefail\n${fnOf('restart.sh')}\nservice_port "$1"`, '_', v], { encoding: 'utf8', env: { HOME: sandbox, PATH: bin } });
      for (const v of values) expect(port(withNode, v), JSON.stringify(v)).toBe(String(servicePort({ PORT: v })));
      expect(values.map((v) => port(without, v).trim())).toEqual(['8080', '9137', '9137', '9137', '8080', '8080', '8080', '8080', '8080', '8080', '8080', '9137', '9137']);
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
describe('a bind address with a zone is asked by host and port, which Node takes, not by URL, which it does not (HB-1378 review)', () => {
  it('zonedTarget reads the parts of such a URL, its % as RFC 6874 writes it or bare, and no other', () => {
    expect(zonedTarget('http://[fe80::10%25eth0]:9137/')).toEqual({ protocol: 'http:', host: 'fe80::10%eth0', port: 9137, path: '/' });
    expect(zonedTarget('https://[fe80::10%eth0]:8443/x?y')).toEqual({ protocol: 'https:', host: 'fe80::10%eth0', port: 8443, path: '/x?y' });
    expect(zonedTarget('http://[fe80::10%25eth0]')).toEqual({ protocol: 'http:', host: 'fe80::10%eth0', port: 80, path: '/' });
    for (const url of ['http://[fd00::10]:8080/', 'http://192.0.2.10:8080/', 'http://localhost:8080/', 'ftp://[fe80::10%25eth0]:21/']) expect(zonedTarget(url), url).toBeUndefined();
  });

  // A loopback address with its zone (::1%lo) is the closest to a link-local one a sandbox can listen on.
  let server: Server | undefined; let port = 0;
  beforeAll(async () => {
    const s = createHttpServer((_req, res) => { res.end('<html><script>HATCHABOT_VERSION="9.9.9"</script></html>'); });
    port = await new Promise<number>((r) => { s.once('error', () => r(0)); s.listen(0, '::1', () => r((s.address() as { port: number }).port)); });
    if (port) server = s;
  });
  afterAll(() => { server?.close(); });
  it.skipIf(process.platform !== 'linux')('doctor checks such a listener, at the URL serviceUrl writes for it', async (ctx) => {
    if (!server) ctx.skip(); // no IPv6 loopback here
    const url = serviceUrl({ PORT: String(port), HATCHABOT_BIND: '::1%lo' });
    expect(url).toBe(`http://[::1%25lo]:${port}`);
    expect(() => new URL(url)).toThrow(); // why it is not asked by URL
    expect(await probeControlPlane(url, undefined, '::1%lo')).toEqual({ url, ok: true, version: '9.9.9' });
    // Nothing listening there: not ok, with a reason, as for any other address.
    expect(await probeControlPlane(`http://[::1%25lo]:1`, undefined, '::1%lo')).toMatchObject({ ok: false });
  });
});

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
