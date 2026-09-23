import { describe, expect, it } from 'vitest';
import { doctorReport, type DoctorFacts } from '../src/doctor.js';

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

describe('checkout freshness', () => {
  // A checkout stuck behind the latest tag is the quiet cause of "I upgraded
  // and it still crashes" — the laptop install hit exactly this: the
  // installer refused a dirty tree, the restart script relaunched the same
  // broken build, and nothing said so.
  it('warns when a newer tag is sitting there unused', () => {
    const lines = doctorReport({ ...healthy, checkout: { tag: 'v1.8.1', latestTag: 'v1.8.2', dirty: [] } });
    const line = lines.find((l) => l.text.includes('v1.8.1'))!;
    expect(line.level).toBe('warn');
    expect(line.fix).toContain('git checkout v1.8.2');
  });

  it('warns about local changes, because they block the installer', () => {
    const lines = doctorReport({ ...healthy, checkout: { tag: 'v1.8.2', latestTag: 'v1.8.2', dirty: ['src/api/routes.ts', 'web/index.html'] } });
    const line = lines.find((l) => l.text.includes('local changes'))!;
    expect(line.level).toBe('warn');
    expect(line.text).toContain('src/api/routes.ts');
  });

  it('says which release is running when it is current and clean', () => {
    const lines = doctorReport({ ...healthy, checkout: { tag: 'v1.8.2', latestTag: 'v1.8.2', dirty: [] } });
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
