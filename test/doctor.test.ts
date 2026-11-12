import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupFacts, browserFacts, checkoutFacts, doctorReport, envMap, probeControlPlane, releaseBehind, serviceBackupMark, type DoctorFacts } from '../src/doctor.js';
import { ownerMark } from '../src/orchestrator/backups.js';
import { scriptEnv } from './helpers/scriptEnv.js';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
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
  it('another certificate, or none, is not trusted: the probe fails closed', async () => {
    expect(await probeControlPlane(url, other.certPath)).toMatchObject({ url, ok: false, error: expect.stringMatching(/self.signed|certificate|unable to verify/i) });
    expect(await probeControlPlane(url, undefined)).toMatchObject({ url, ok: false });
    expect(await probeControlPlane(url, join(dir, 'missing.crt'))).toMatchObject({ url, ok: false });
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
