import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupFacts, browserFacts, checkoutFacts, doctorReport, envMap, metaVersion, probeControlPlane, registryVolumes, releaseBehind, serviceBackupMark, type DoctorFacts } from '../src/doctor.js';
import { ownerMark } from '../src/orchestrator/backups/backupFiles.js';
import { scriptEnv } from './helpers/scriptEnv.js';
import Database from 'better-sqlite3';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const healthy: DoctorFacts = {
  nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true, arch: 'arm64', version: '27.1' },
  runtimeImage: { openclawVersion: '2026.7.1-2', sizeGb: 1.97 },
  envFile: { present: true, secretKey: true, password: true, authMode: 'password', publicUrl: 'https://box.tail.ts.net' },
  db: { path: '/x/hatchabot.sqlite', present: true, sizeMb: 10 },
  service: { manager: 'systemd', active: true, enabled: true },
  controlPlane: { url: 'http://localhost:8080', ok: true, version: '1.3.0' },
  diskFreeGb: 120, backups: { dir: '/b', lastSet: '2026-09-13', ageDays: 0 },
  tailscale: { installed: true, up: true, dns: 'box.tail.ts.net' }, containers: { running: 43, total: 53 },
};

describe('hatchabot doctor report', () => {
  it('is all ✓ on a healthy install', () => {
    const lines = doctorReport(healthy);
    expect(lines.every((l) => l.level === 'ok')).toBe(true);
    expect(lines.map((l) => l.text).join('\n')).toMatch(/Node v22.*Docker 27.1.*OpenClaw 2026.7.1-2.*43 running of 53.*Public URL.*Database.*Service running.*v1.3.0.*120 GB free.*last set 2026-09-13.*Tailscale up/s);
  });
  it('warns about agents still on the shared network, with the fix', () => {
    const line = doctorReport({ ...healthy, containers: { running: 43, total: 53, sharedNetwork: 7 } })
      .find((l) => /shared network/.test(l.text));
    expect(line).toMatchObject({ level: 'warn', text: expect.stringMatching(/^7 running agents are still/) });
    expect(line!.fix).toMatch(/rebuild --outdated/);
    expect(doctorReport({ ...healthy, containers: { running: 1, total: 1, sharedNetwork: 0 } }).some((l) => /shared network/.test(l.text))).toBe(false);
  });
  it('names the fix for each broken thing', () => {
    const lines = doctorReport({ ...healthy, nodeVersion: 'v18.1.0', dockerDaemon: { ok: false, error: 'permission denied' }, runtimeImage: undefined,
      envFile: { present: true, secretKey: false, password: false, authMode: 'password' }, service: { manager: 'systemd', active: false },
      controlPlane: { url: 'http://localhost:8080', ok: false, error: 'ECONNREFUSED' }, diskFreeGb: 2, backups: { dir: '/b' }, tailscale: { installed: false } });
    const fails = lines.filter((l) => l.level === 'fail');
    expect(fails.map((l) => l.text)).toEqual(expect.arrayContaining([expect.stringMatching(/Node v18/), expect.stringMatching(/not reachable/), expect.stringMatching(/SECRET_KEY/), expect.stringMatching(/not running/), expect.stringMatching(/not answering/), expect.stringMatching(/2\.0 GB free/)]));
    expect(fails.every((l) => l.fix)).toBe(true);
    expect(lines.find((l) => /No app password/.test(l.text))?.level).toBe('warn');
    expect(lines.find((l) => /Tailscale not installed/.test(l.text))?.level).toBe('warn');
    // the image check is skipped when docker itself is down (no double-reporting)
    expect(lines.some((l) => /Runtime image .* missing/.test(l.text))).toBe(false);
  });
  it('warns when there is no timeout command (a Mac without coreutils): the backup and the drill have no time limit then (HB-1208)', () => {
    const line = doctorReport({ ...healthy, timeLimit: false }).find((l) => /timeout or gtimeout/.test(l.text));
    expect(line).toMatchObject({ level: 'warn', fix: expect.stringMatching(/brew install coreutils/) });
    for (const timeLimit of [true, undefined]) expect(doctorReport({ ...healthy, timeLimit }).some((l) => /timeout or gtimeout/.test(l.text))).toBe(false);
  });
  it('warns on stale backups and identity mode without a password is fine', () => {
    const lines = doctorReport({ ...healthy, envFile: { ...healthy.envFile, password: false, authMode: 'identity' }, backups: { dir: '/b', lastSet: '2026-09-01', ageDays: 12 } });
    expect(lines.some((l) => /No app password/.test(l.text))).toBe(false);
    expect(lines.find((l) => /12 days old/.test(l.text))?.level).toBe('warn');
  });
});

describe('the agents\' browsers (HB-0677)', () => {
  const img = { image: 'hatchabot-browser:aaaaaaaaaaaa', dockerfile: 'FROM x\nARG CHROMIUM_REFRESH=2026-11-12\n' };
  const fake = (ps: string) => {
    const calls: string[][] = [];
    const docker = (args: string[]) => {
      calls.push(args);
      if (args[0] === 'ps') return ps;
      if (args[0] === 'exec' && args[1] === 'hatchabot-a-browser') return 'Chromium 156.0.8078.79 built on Debian GNU/Linux 12 (bookworm)';
      if (args[0] === 'exec') return 'Chromium 154.0.8037.92 built on Debian GNU/Linux 12 (bookworm)';
      return undefined;
    };
    return { docker, calls };
  };
  const at = Date.parse('2026-11-20T12:00:00Z');
  it('this install\'s browsers only, Chromium read once per image, the image\'s age', () => {
    const f = fake([
      'hatchabot-a-browser|hatchabot-browser:aaaaaaaaaaaa|hatchabot',
      'hatchabot-b-browser|hatchabot-browser:aaaaaaaaaaaa|hatchabot',
      'hatchabot-c-browser|hatchabot-browser:bbbbbbbbbbbb|<no value>',
      'other-d-browser|hatchabot-browser:aaaaaaaaaaaa|other',
    ].join('\n'));
    const b = browserFacts(f.docker, 'hatchabot', at, img)!;
    expect(b).toEqual({ running: 3, versions: ['156.0.8078.79', '154.0.8037.92'], oldImage: 1, refreshed: '2026-11-12', refreshedDays: 8 });
    expect(f.calls.filter((c) => c[0] === 'exec')).toHaveLength(2);
  });
  it('says which Chromium runs; warns of a browser on an older image, and of an image over 30 days old', () => {
    const lines = doctorReport({ ...healthy, browsers: { running: 2, versions: ['156.0.8078.79'], oldImage: 0, refreshed: '2026-11-12', refreshedDays: 3 } });
    expect(lines.find((l) => /Agents' browsers/.test(l.text))).toEqual({ level: 'ok', text: "Agents' browsers: 2 running · Chromium 156.0.8078.79 (image of 2026-11-12)" });
    expect(lines.some((l) => l.level === 'warn')).toBe(false);
    const old = doctorReport({ ...healthy, browsers: { running: 2, versions: ['154.0.8037.92'], oldImage: 1, refreshed: '2026-09-01', refreshedDays: 80 } }).filter((l) => l.level === 'warn');
    expect(old.map((l) => l.text)).toEqual([
      '1 agent browser runs an older image than this release\'s',
      'The agents\' browser image is from 2026-09-01, 80 days ago: its Chromium misses the security fixes since',
    ]);
    expect(old[1]?.fix).toMatch(/hatchabot upgrade/);
  });
  it('no line where no agent has its browser on', () => {
    expect(doctorReport({ ...healthy, browsers: { running: 0, versions: [], oldImage: 0 } }).some((l) => /browser/i.test(l.text))).toBe(false);
    expect(browserFacts(fake('').docker, 'hatchabot', at, img)).toMatchObject({ running: 0, versions: [], oldImage: 0 });
  });
});

describe('checkout freshness', () => {
  // A checkout stuck behind the latest tag is the quiet cause of "I upgraded
  // and it still crashes" — the laptop install hit exactly this: the
  // installer refused a dirty tree, the restart script relaunched the same
  // broken build, and nothing said so.
  it('warns when the channel names a newer release, and the fix names no version (HB-0404)', () => {
    const lines = doctorReport({ ...healthy, checkout: { tag: 'v1.8.1', channel: 'stable', channelTarget: 'v1.8.2', dirty: [] } });
    const line = lines.find((l) => l.text.includes('v1.8.1'))!;
    expect(line.level).toBe('warn');
    expect(line.text).toContain('the stable channel names v1.8.2');
    // Through the upgrade command, never a bare checkout (audit, 2026-10-23), and
    // with no version: a version named there is a pin (upgrade.sh).
    expect(line.fix).toMatch(/^hatchabot upgrade  /);
    expect(line.fix).not.toMatch(/v1\.8/);
    expect(line.fix).not.toContain('keeps the channel');
  });

  it('a machine ahead of its channel, or on it, is not told to move (HB-0404)', () => {
    for (const checkout of [{ tag: 'v1.8.3', channel: 'stable', channelTarget: 'v1.8.2' }, { tag: 'v1.8.2', channel: 'stable', channelTarget: 'v1.8.2' }, { tag: 'v1.8.2', channel: 'stable' }]) {
      const lines = doctorReport({ ...healthy, checkout: { ...checkout, dirty: [] } });
      expect(lines.find((l) => l.text === `Release ${checkout.tag}`)?.level).toBe('ok');
    }
  });

  it('a pin is said to be one, with the way back (HB-0404)', () => {
    const line = doctorReport({ ...healthy, checkout: { tag: 'v1.8.1', pinned: 'v1.8.1', dirty: [] } }).find((l) => l.text.includes('Pinned'))!;
    expect(line.level).toBe('warn');
    expect(line.text).toMatch(/automatic upgrades are paused/);
    expect(line.fix).toContain('hatchabot upgrade stable');
  });

  it('reads prereleases as coming before their release', () => {
    expect(releaseBehind('v2.35.0-beta.1', 'v2.35.0')).toBe(true);
    expect(releaseBehind('v2.35.0', 'v2.35.0-beta.1')).toBe(false);
    expect(releaseBehind('v2.9.0', 'v2.10.0')).toBe(true);
    expect(releaseBehind('v2.10.0', 'v2.9.0')).toBe(false);
    expect(releaseBehind('abc1234', 'v2.9.0')).toBe(false);
  });

  // A real clone's tags: promoted, newer and unpromoted, and a prerelease that sorts first.
  describe('checkoutFacts, on a clone in a sandbox (HB-0404)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-doctor-'));
    const home = join(root, 'home'); mkdirSync(home);
    const dir = join(root, 'install'); mkdirSync(dir);
    const env = scriptEnv(home, '/usr/bin:/bin');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
    beforeAll(() => {
      git('init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'channels.json'), '{"stable":"v2.0.0","beta":"v2.1.0"}\n');
      git('add', '-A'); git('commit', '-q', '-m', 'x');
      for (const t of ['v1.9.0', 'v2.0.0', 'v2.1.0', 'v2.2.0', 'v3.0.0-beta.1']) git('tag', t);
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      git('checkout', '-q', '--detach', 'v1.9.0');
    });
    afterAll(() => { rmSync(root, { recursive: true, force: true }); });
    const line = () => doctorReport({ ...healthy, checkout: checkoutFacts(dir, home) }).find((l) => /Running|Release|Pinned/.test(l.text))!;

    it('compares with what the channel names, not the newest tag', () => {
      const f = checkoutFacts(dir, home)!;
      expect(f.channel).toBe('stable'); expect(f.channelTarget).toBe('v2.0.0');
      expect(line().fix).not.toMatch(/v\d/);
      expect(line().text).toContain('names v2.0.0');
    });
    it('follows the channel chosen for this install', () => {
      mkdirSync(join(dir, 'data'), { recursive: true });
      writeFileSync(join(dir, 'data', 'channel'), 'latest\n');
      expect(checkoutFacts(dir, home)!.channelTarget).toBe('v2.2.0'); // not the prerelease that sorts first
      writeFileSync(join(dir, 'data', 'channel'), 'beta\n');
      expect(checkoutFacts(dir, home)!.channelTarget).toBe('v2.1.0');
      writeFileSync(join(dir, 'data', 'channel'), 'v1.9.0\n');
      expect(checkoutFacts(dir, home)!.pinned).toBe('v1.9.0');
      expect(line().text).toContain('Pinned to v1.9.0');
      rmSync(join(dir, 'data'), { recursive: true });
    });
  });

  it('warns about local changes, because they block the installer', () => {
    const lines = doctorReport({ ...healthy, checkout: { tag: 'v1.8.2', channel: 'stable', channelTarget: 'v1.8.2', dirty: ['src/api/routes.ts', 'web/index.html'] } });
    const line = lines.find((l) => l.text.includes('local changes'))!;
    expect(line.level).toBe('warn');
    expect(line.text).toContain('src/api/routes.ts');
  });

  it('says which release is running when it is current and clean', () => {
    const lines = doctorReport({ ...healthy, checkout: { tag: 'v1.8.2', channel: 'stable', channelTarget: 'v1.8.2', dirty: [] } });
    expect(lines.find((l) => l.text === 'Release v1.8.2')?.level).toBe('ok');
    expect(lines.some((l) => l.text.includes('local changes'))).toBe(false);
  });
});

describe('doctor and Tailscale on a Mac (2026-09-22)', () => {
  it('a tailnet address that answers stands in for an unset public URL, and serving reads as ✓', () => {
    const lines = doctorReport({ ...healthy, envFile: { ...healthy.envFile, publicUrl: undefined },
      tailscale: { installed: true, up: true, dns: 'mac.tail.ts.net', serving: true, reachable: true, url: 'https://mac.tail.ts.net' } });
    expect(lines.every((l) => l.level === 'ok')).toBe(true);
    expect(lines.map((l) => l.text).join('\n')).toMatch(/links use the tailnet address https:\/\/mac\.tail\.ts\.net/);
    expect(lines.map((l) => l.text).join('\n')).toMatch(/serving https:\/\/mac\.tail\.ts\.net/);
  });
  it('the Mac app without a working command is named, not reported as "not installed"', () => {
    const lines = doctorReport({ ...healthy, tailscale: { installed: true, appOnly: true } });
    const t = lines.find((l) => /Tailscale app found/.test(l.text));
    expect(t?.level).toBe('warn');
    expect(t?.fix).toMatch(/sign in/);
  });
});

/** A self-signed certificate made here, for this run only (never a fixture: a private key in the tree would be a secret). */
function selfSigned(dir: string, name: string, san: string) {
  const key = join(dir, `${name}.key`); const cert = join(dir, `${name}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=hatchabot-test', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert), certPath: cert };
}
const haveOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!haveOpenssl)('hatchabot doctor probes a TLS install without turning certificate checks off', () => {
  let dir: string; let close: () => void; let url: string; let own: ReturnType<typeof selfSigned>; let other: ReturnType<typeof selfSigned>;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hb-doctor-tls-'));
    own = selfSigned(dir, 'own', 'IP:127.0.0.1,DNS:localhost');
    other = selfSigned(dir, 'other', 'IP:127.0.0.1');
    const server = createServer({ key: own.key, cert: own.cert }, (_req, res) => { res.end('<html><script>HATCHABOT_VERSION="9.9.9"</script></html>'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    close = () => server.close();
  });
  afterAll(() => { close?.(); rmSync(dir, { recursive: true, force: true }); });

  it("trusts the install's own certificate file and reads the version; the process keeps checking certificates", async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    expect(await probeControlPlane(url, own.certPath)).toEqual({ url, ok: true, version: '9.9.9' });
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
  });
  it('over HTTPS too, a page with none of Hatchabot\'s marks is another program\'s, and its header alone is Hatchabot\'s (review of HB-1111)', async () => {
    let headers: Record<string, string> = {};
    const plain = createServer({ key: own.key, cert: own.cert }, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html', ...headers }); res.end('<html><title>Another program</title></html>'); });
    await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
    const at = `https://127.0.0.1:${(plain.address() as { port: number }).port}`;
    try {
      expect(await probeControlPlane(at, own.certPath)).toEqual({ url: at, ok: false, other: true });
      headers = { 'x-hatchabot-version': '9.9.9' };
      expect(await probeControlPlane(at, own.certPath)).toEqual({ url: at, ok: true, version: '9.9.9' });
    } finally { plain.closeAllConnections(); plain.close(); }
  });
  it('another certificate, or none, is not trusted: the probe fails closed', async () => {
    expect(await probeControlPlane(url, other.certPath)).toMatchObject({ url, ok: false, error: expect.stringMatching(/self.signed|certificate|unable to verify/i) });
    expect(await probeControlPlane(url, undefined)).toMatchObject({ url, ok: false });
    expect(await probeControlPlane(url, join(dir, 'missing.crt'))).toMatchObject({ url, ok: false });
  });
});

describe('another program answering where the control plane should is not taken for it (HB-1111)', () => {
  it('a 200 whose page names no Hatchabot version is reported as something else, apart from an address that does not answer', async () => {
    let page = '<html><title>Welcome to a fixture web server</title></html>';
    const server = createHttpServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const other = await probeControlPlane(url);
      expect(other).toMatchObject({ url, ok: false, other: true });
      const line = doctorReport({ ...healthy, controlPlane: other }).find((l) => /answers at|answering at/.test(l.text));
      expect(line).toMatchObject({ level: 'fail', text: `Something other than Hatchabot answers at ${url}: its page does not name a Hatchabot version` });
      expect(line!.fix).toMatch(/Another program has the port, or a proxy sends this address elsewhere/);
      // Hatchabot's own page, as versionMarkup writes it.
      page = '<html><head><meta name="hatchabot-version" content="9.9.9"><!-- HATCHABOT_VERSION="9.9.9" --></head></html>';
      expect(await probeControlPlane(url)).toEqual({ url, ok: true, version: '9.9.9' });
    } finally { server.closeAllConnections(); server.close(); }
    // Nothing there at all is still "not answering". Port 1, where nothing listens and which the
    // kernel never hands out: the closed server's port was anyone's again, and another test's
    // listen(0) could be given it and answer (HB-1495). Not port 0: the probe's http.request asks
    // port 80 for it.
    const nowhere = 'http://127.0.0.1:1';
    const gone = await probeControlPlane(nowhere);
    expect(gone).toMatchObject({ url: nowhere, ok: false });
    expect(gone.other).toBeUndefined();
    expect(doctorReport({ ...healthy, controlPlane: gone }).some((l) => l.text.startsWith(`Control plane not answering at ${nowhere}`))).toBe(true);
  });

  it('a hostile page is read in time: the meta tag looked for tag by tag, in its head (review of HB-1111)', async () => {
    const timed = <T,>(f: () => T) => { const t0 = performance.now(); const v = f(); return { v, ms: performance.now() - t0 }; };
    // A page of tags that never end until its last character: each looked to the end for its ">".
    const hostile = '<meta '.repeat(40_000) + '>';
    expect(timed(() => metaVersion(hostile))).toEqual({ v: undefined, ms: expect.any(Number) });
    expect(timed(() => metaVersion(hostile)).ms).toBeLessThan(250);
    expect(timed(() => metaVersion(`<head>${'<meta name="x" '.repeat(20_000)}>`)).ms).toBeLessThan(250);
    // A tag longer than any of Hatchabot's is passed over; one after the head is not the page's.
    expect(metaVersion(`<meta name="hatchabot-version" ${' '.repeat(3000)} content="9.9.9">`)).toBeUndefined();
    expect(metaVersion('<head></head><body><meta name="hatchabot-version" content="9.9.9">')).toBeUndefined();
    expect(metaVersion('<head><meta charset="utf-8"><meta name="hatchabot-version" content="9.9.9"></head>')).toBe('9.9.9');
  });

  it('the plain probe reads a megabyte of a body at most, as the HTTPS one keeps (review of HB-1111)', async () => {
    // A body far past a megabyte, of tags that never end.
    const big = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const chunk = '<meta '.repeat(10_000);
      for (let i = 0; i < 80; i++) res.write(chunk); // 4.8 MB
      res.end('>');
    });
    await new Promise<void>((r) => big.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(big.address() as { port: number }).port}`;
    try {
      const t0 = performance.now();
      expect(await probeControlPlane(url)).toEqual({ url, ok: false, other: true });
      expect(performance.now() - t0).toBeLessThan(3000);
    } finally { big.closeAllConnections(); big.close(); }
  });

  it('a mark that is no version is none: its text is never printed (review of HB-1111)', async () => {
    let page = '';
    let headers: Record<string, string> = {};
    const server = createHttpServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html', ...headers }); res.end(page); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      for (const bad of ['\u001b[2J\u001b[31mowned', '9.9.9 (yes, really)', '1'.repeat(41)]) {
        page = `<head><meta name="hatchabot-version" content="${bad}"><!-- HATCHABOT_VERSION="${bad}" --></head>`;
        const cp = await probeControlPlane(url);
        expect(cp, JSON.stringify(bad)).toEqual({ url, ok: false, other: true });
        expect(doctorReport({ ...healthy, controlPlane: cp }).map((l) => l.text).join('\n')).not.toContain('\u001b');
      }
      // A good mark after a bad one still counts; and a version up to forty characters, as versionWord writes them.
      page = `<!-- HATCHABOT_VERSION="\u001b[0m" --><head><meta name="hatchabot-version" content="2.191.0-rc.1+build_7"></head>`;
      expect(await probeControlPlane(url)).toEqual({ url, ok: true, version: '2.191.0-rc.1+build_7' });
      page = '<html></html>';
      headers = { 'x-hatchabot-version': '9.9.9; rm -rf' };
      expect(await probeControlPlane(url)).toEqual({ url, ok: false, other: true });
      headers = { 'x-hatchabot-version': '1'.repeat(40) };
      expect(await probeControlPlane(url)).toEqual({ url, ok: true, version: '1'.repeat(40) });
    } finally { server.closeAllConnections(); server.close(); }
  });

  it('Hatchabot is known by any of its marks: a page a proxy stripped of comments, or its header alone; another answer says its status (review of HB-1111)', async () => {
    let answer: { status: number; page: string; headers?: Record<string, string> } = { status: 200, page: '' };
    const server = createHttpServer((_req, res) => { res.writeHead(answer.status, { 'content-type': 'text/html', ...answer.headers }); res.end(answer.page); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const line = async () => doctorReport({ ...healthy, controlPlane: await probeControlPlane(url) }).find((l) => / at http/.test(l.text))!;
    try {
      answer = { status: 200, page: '<html><head><meta name="hatchabot-version" content="9.9.9"></head></html>' };
      expect(await probeControlPlane(url)).toEqual({ url, ok: true, version: '9.9.9' });
      answer = { status: 200, page: '<html><head><meta content=9.9.8 name=hatchabot-version></head></html>' };
      expect(await probeControlPlane(url)).toEqual({ url, ok: true, version: '9.9.8' });
      answer = { status: 200, page: '<html></html>', headers: { 'x-hatchabot-version': '9.9.7' } };
      expect(await probeControlPlane(url)).toEqual({ url, ok: true, version: '9.9.7' });
      // Another meta tag is not Hatchabot's.
      answer = { status: 200, page: '<meta name="generator" content="9.9.9">' };
      expect(await probeControlPlane(url)).toMatchObject({ ok: false, other: true });
      answer = { status: 404, page: '<html>Not found</html>' };
      expect(await probeControlPlane(url)).toEqual({ url, ok: false, status: 404 });
      expect(await line()).toMatchObject({ level: 'fail', text: `Something answers 404 at ${url}, and its page does not name a Hatchabot version`, fix: expect.stringMatching(/Another program has the port/) });
      answer = { status: 500, page: '<!-- HATCHABOT_VERSION="9.9.9" -->' };
      expect(await line()).toMatchObject({ level: 'fail', text: `Control plane answers 500 at ${url} (v9.9.9)`, fix: expect.stringMatching(/journalctl/) });
    } finally { server.closeAllConnections(); server.close(); }
  });
});

describe('doctor reads a backup set\'s age as the app does (HB-0386)', () => {
  it('an evening west of UTC is not a day older', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-age-'));
    try {
      mkdirSync(join(dir, '2026-09-13'));
      writeFileSync(join(dir, '2026-09-13', 'hatchabot.sqlite'), '');
      // 20:00 on the 15th, local: two days by the calendar, three since UTC midnight on the 13th.
      const now = new Date(2026, 8, 15, 20, 0).getTime();
      const facts = backupFacts(dir, now, undefined);
      expect(facts).toMatchObject({ lastSet: '2026-09-13', ageDays: 2 });
      expect(doctorReport({ ...healthy, backups: facts }).some((l) => /days old/.test(l.text))).toBe(false);
      expect(backupFacts(dir, new Date(2026, 8, 16, 0, 30).getTime(), undefined).ageDays).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the newest set is this install\'s own: another\'s newer one in a shared folder is passed over (fourth review of HB-0540)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-own-'));
    try {
      const mine = ownerMark('not-a-real-key-for-tests')!, theirs = ownerMark('another-made-up-key')!;
      for (const [d, owner] of [['2026-09-10', mine], ['2026-09-14', theirs]] as const) {
        mkdirSync(join(dir, d));
        writeFileSync(join(dir, d, 'hatchabot.sqlite'), '');
        writeFileSync(join(dir, d, '.backup-owner'), `${owner}\n`);
      }
      const now = new Date(2026, 8, 15, 12, 0).getTime();
      expect(backupFacts(dir, now, mine)).toMatchObject({ lastSet: '2026-09-10', ageDays: 5 });
      expect(doctorReport({ ...healthy, backups: backupFacts(dir, now, mine) }).some((l) => /days old/.test(l.text))).toBe(true);
      expect(backupFacts(dir, now, theirs)).toMatchObject({ lastSet: '2026-09-14' });
      // None of its own: no newest set, not the other's.
      expect(backupFacts(dir, now, ownerMark('a-third-made-up-key')).lastSet).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('lists the sets the last run kept only for volumes no agent here has had, with their size and how to remove one (review of HB-1380)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-kept-'));
    try {
      for (const d of ['2026-11-20', '2026-10-01', '2026-10-02']) { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, 'hatchabot.sqlite'), ''); }
      writeFileSync(join(dir, '2026-10-01', 'hatchabot-kitchen-1-vol.tgz'), Buffer.alloc(2_500_000));
      writeFileSync(join(dir, '2026-10-02', 'hatchabot-garden-2-vol.tgz'), Buffer.alloc(1));
      // The newest set's record: two still there, one deleted since, and a name that is no set.
      writeFileSync(join(dir, '2026-11-20', 'backup-status.json'), JSON.stringify({
        state: 'complete', captured: [],
        keptUnlisted: { '2026-10-01': ['hatchabot-kitchen-1-vol'], '2026-10-02': ['hatchabot-garden-2-vol', 'hatchabot-notes-3-vol'], '2026-09-01': ['hatchabot-old-4-vol'], '../elsewhere': ['x'] },
      }));
      const now = new Date(2026, 10, 20, 12, 0).getTime();
      const facts = backupFacts(dir, now, undefined);
      expect(facts.keptUnlisted).toEqual([
        { set: '2026-10-02', volumes: ['hatchabot-garden-2-vol', 'hatchabot-notes-3-vol'], bytes: 1 },
        { set: '2026-10-01', volumes: ['hatchabot-kitchen-1-vol'], bytes: 2_500_000 },
      ]);
      const line = doctorReport({ ...healthy, backups: facts }).find((l) => /no agent here has had/.test(l.text));
      expect(line).toEqual({
        level: 'warn',
        text: '2 backup sets are kept past HATCHABOT_BACKUP_KEEP_DAYS only for volumes no agent here has had, 3 MB in all: 2026-10-02 (under 1 MB: hatchabot-garden-2-vol, hatchabot-notes-3-vol); 2026-10-01 (3 MB: hatchabot-kitchen-1-vol). Another machine\'s agents, or a database not restored yet: they stay until a restored database names them, or you remove them',
        fix: `Restore the database they belong to (README.md, "Restoring from backup"), and they go by age as usual; or remove one you do not need: rm -r ${dir}/2026-10-02`,
      });
      // A newer run that failed, and so pruned nothing, names none: the last
      // that pruned still says what is kept.
      mkdirSync(join(dir, '2026-11-21')); writeFileSync(join(dir, '2026-11-21', 'hatchabot.sqlite'), '');
      writeFileSync(join(dir, '2026-11-21', 'backup-status.json'), JSON.stringify({ state: 'incomplete', failedVolumes: ['hatchabot-kitchen-1-vol'] }));
      expect(backupFacts(dir, now, undefined)).toMatchObject({ lastSet: '2026-11-21', complete: false, keptUnlisted: facts.keptUnlisted });
      // None kept for that: no line.
      writeFileSync(join(dir, '2026-11-21', 'backup-status.json'), JSON.stringify({ state: 'complete', keptUnlisted: {} }));
      expect(backupFacts(dir, now, undefined).keptUnlisted).toBeUndefined();
      expect(doctorReport({ ...healthy, backups: backupFacts(dir, now, undefined) }).some((l) => /no agent here has had/.test(l.text))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a set kept for volumes a database restored since names is not listed, before the next nightly run writes a new record (HB-1433)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-named-'));
    try {
      const bdir = join(dir, 'backups'); mkdirSync(bdir);
      for (const d of ['2026-11-20', '2026-10-01', '2026-10-02']) { mkdirSync(join(bdir, d)); writeFileSync(join(bdir, d, 'hatchabot.sqlite'), ''); }
      writeFileSync(join(bdir, '2026-10-01', 'hatchabot-kitchen-1-vol.tgz'), Buffer.alloc(1));
      writeFileSync(join(bdir, '2026-10-02', 'hatchabot-garden-2-vol.tgz'), Buffer.alloc(1));
      writeFileSync(join(bdir, '2026-11-20', 'backup-status.json'), JSON.stringify({
        state: 'complete', keptUnlisted: { '2026-10-01': ['hatchabot-kitchen-1-vol'], '2026-10-02': ['hatchabot-garden-2-vol', 'hatchabot-notes-3-vol', 'agentclaw-vol-0a1b2c3d4e5f'] },
      }));
      // The database restored by hand since: it names the kitchen agent's volume, the notes one's (deleted there) and a legacy ref's.
      const dbPath = join(dir, 'hatchabot.sqlite');
      const db = new Database(dbPath);
      db.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, runtime_ref TEXT, state TEXT)");
      const add = db.prepare('INSERT INTO agents VALUES (?, ?, ?)');
      add.run('a1', 'docker://hatchabot-kitchen-1', 'RUNNING'); add.run('a2', 'docker://hatchabot-notes-3', 'DELETED');
      add.run('a3', 'docker://0a1b2c3d4e5f0000', 'STOPPED'); add.run('a4', null, 'PROVISIONING');
      db.close();
      const named = await registryVolumes(dbPath, 'hatchabot');
      expect([...named!].sort()).toEqual(['agentclaw-vol-0a1b2c3d4e5f', 'hatchabot-kitchen-1-vol', 'hatchabot-notes-3-vol']);
      const now = new Date(2026, 10, 20, 12, 0).getTime();
      // The kitchen set is not listed; the garden one is, for its one volume still unnamed.
      expect(backupFacts(bdir, now, undefined, named).keptUnlisted).toEqual([{ set: '2026-10-02', volumes: ['hatchabot-garden-2-vol'], bytes: 1 }]);
      // No database to read: the record as it is, as before.
      expect(await registryVolumes(join(dir, 'none.sqlite'), 'hatchabot')).toBeUndefined();
      expect(backupFacts(bdir, now, undefined, undefined).keptUnlisted?.map((k) => k.set)).toEqual(['2026-10-02', '2026-10-01']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('quotes each path it prints in a command, so one pasted acts on that path alone (review of HB-1380)', () => {
    const facts = (dir: string): DoctorFacts['backups'] => ({ dir, lastSet: '2026-11-03', ageDays: 0, unreadable: ['2026-11-05'], keptUnlisted: [{ set: '2026-10-01', volumes: [], bytes: 1 }] });
    // What a shell makes of the printed words: printf alone, in a bare environment.
    const words = (args: string) => spawnSync('bash', ['--noprofile', '--norc', '-c', `printf '%s\\n' ${args}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).stdout;
    for (const dir of ['/home/u/backups 2', "/home/u/it's $HOME", '/home/u/backups']) {
      const lines = doctorReport({ ...healthy, backups: facts(dir) });
      const unread = lines.find((l) => /could not be read/.test(l.text))!.fix!;
      const kept = lines.find((l) => /no agent here has had/.test(l.text))!.fix!;
      expect(words(/^ls -ld (.+) — one made/.exec(unread)![1]!), dir).toBe(`${dir}/2026-11-05\n`);
      expect(words(/chown -R \$\(id -un\) (.+)$/.exec(unread)![1]!), dir).toBe(`${dir}/2026-11-05\n`);
      expect(words(/rm -r (.+)$/.exec(kept)![1]!), dir).toBe(`${dir}/2026-10-01\n`);
    }
    // A plain path is printed as it is.
    expect(doctorReport({ ...healthy, backups: facts('/home/u/backups') }).find((l) => /no agent here has had/.test(l.text))!.fix).toMatch(/rm -r \/home\/u\/backups\/2026-10-01$/);
  });

  it('a file named like a date is passed over: the good sets still count (HB-1118)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-badset-'));
    try {
      for (const d of ['2026-11-01', '2026-11-03']) { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, 'hatchabot.sqlite'), ''); }
      const now = new Date(2026, 10, 4, 12).getTime();
      expect(backupFacts(dir, now, undefined)).toEqual({ dir, lastSet: '2026-11-03', ageDays: 1 });
      // Newer than either, and no set: nothing to say of it.
      writeFileSync(join(dir, '2026-11-04'), 'not a set');
      expect(backupFacts(dir, now, undefined)).toEqual({ dir, lastSet: '2026-11-03', ageDays: 1 });
      const lines = doctorReport({ ...healthy, backups: backupFacts(dir, now, undefined) }).filter((l) => /[Bb]ackup/.test(l.text));
      expect(lines).toEqual([{ level: 'ok', text: 'Backups: last set 2026-11-03' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // Root reads any folder, so there is none it cannot read.
  it.skipIf(process.getuid?.() === 0)('a newer set this user cannot read is passed over and named; an older one it cannot read is not news (review of HB-1118)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-unreadable-'));
    const locked = ['2026-11-02', '2026-11-05'];
    try {
      for (const d of ['2026-11-01', '2026-11-03', ...locked]) { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, 'hatchabot.sqlite'), ''); }
      for (const d of locked) chmodSync(join(dir, d), 0o000); // a root-made set, as a backup run with sudo leaves one
      const now = new Date(2026, 10, 6, 12).getTime();
      const facts = backupFacts(dir, now, undefined);
      expect(facts).toEqual({ dir, lastSet: '2026-11-03', ageDays: 3, unreadable: ['2026-11-05'] });
      const lines = doctorReport({ ...healthy, backups: facts }).filter((l) => /[Bb]ackup/.test(l.text));
      expect(lines.map((l) => l.level)).toEqual(['warn', 'warn']); // three days old, and the newer one unread
      expect(lines[1]).toMatchObject({ text: `Backup set 2026-11-05 in ${dir} could not be read: newer than the last set read (2026-11-03)`, fix: expect.stringContaining(`sudo chown -R $(id -un) ${dir}/2026-11-05`) });
      // None read at all: still named.
      chmodSync(join(dir, '2026-11-01'), 0o000); chmodSync(join(dir, '2026-11-03'), 0o000);
      expect(backupFacts(dir, now, undefined)).toEqual({ dir, unreadable: ['2026-11-05', '2026-11-03', '2026-11-02', '2026-11-01'] });
    } finally {
      for (const d of ['2026-11-01', '2026-11-03', ...locked]) { try { chmodSync(join(dir, d), 0o755); } catch { /* not made */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an install from before the rename: its AGENTCLAW_SECRET_KEY in the env file marks its own sets (tenth review)', () => {
    // envMap aliases the env file's old name, as key_owner (scripts/backup-owner.sh) reads either name.
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-legacy-'));
    try {
      const file = join(dir, 'legacy-envfile');
      writeFileSync(file, 'AGENTCLAW_SECRET_KEY=not-a-real-key-for-tests\n');
      expect(serviceBackupMark(envMap(file))).toBe(ownerMark('not-a-real-key-for-tests'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the mark is the service\'s .env key, never the shell\'s: with none in the .env, every set counts as its own', () => {
    const was = process.env.HATCHABOT_SECRET_KEY;
    process.env.HATCHABOT_SECRET_KEY = 'a-shell-key-made-up-for-tests';
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-shellkey-'));
    try {
      expect(serviceBackupMark({})).toBeUndefined();
      expect(serviceBackupMark({ HATCHABOT_SECRET_KEY: 'an-env-file-key-made-up' })).toBe(ownerMark('an-env-file-key-made-up'));
      // The newest set is marked by some install; with the shell's key it read as another's.
      for (const d of ['2026-11-01', '2026-11-05']) { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, 'hatchabot.sqlite'), ''); }
      writeFileSync(join(dir, '2026-11-05', '.backup-owner'), '0123456789abcdef\n');
      expect(backupFacts(dir, new Date(2026, 10, 8, 12).getTime(), serviceBackupMark({})).lastSet).toBe('2026-11-05');
    } finally {
      if (was === undefined) delete process.env.HATCHABOT_SECRET_KEY; else process.env.HATCHABOT_SECRET_KEY = was;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('importing doctor takes an old install\'s AGENTCLAW_SECRET_KEY from the environment as its key (envCompat), as the server reads it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-doctor-envcompat-'));
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', 'import("./src/doctor.ts").then(() => process.stdout.write(process.env.HATCHABOT_SECRET_KEY ?? ""))'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, HOME: dir, AGENTCLAW_SECRET_KEY: 'not-a-real-key-for-tests' },
      });
      expect(r.stdout, r.stderr).toBe('not-a-real-key-for-tests');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
