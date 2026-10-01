import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { adminAccounts, evaluateSafeguards, failingSafeguards, publicConfig, type SafeguardFacts } from '../src/api/safeguards.js';
import { autoUpgradeStatus, type AutoUpgradeProbes } from '../src/ops/autoUpgrade.js';
import { doctorReport, publicAccessLines, type DoctorFacts } from '../src/doctor.js';

const good = (): SafeguardFacts => ({
  authMode: 'accounts', managed: false,
  admins: [{ id: 'a1', name: 'chris', totp: 1, passkeyRpIds: [] }],
  invitedOnly: true, ownerHeader: false,
  ports: { main: 8080, public: 8092, ops: 8091, embed: 8093 },
  autoUpgrade: { ok: true }, funnelOnPrivatePort: false, loginFailLimit: 10, publicHost: 'box.example.com',
});
const failing = (f: SafeguardFacts) => failingSafeguards(evaluateSafeguards(f)).map((c) => c.id);

describe('safeguards: each one, off, is named', () => {
  it('all in place: nothing failing, and all ten are reported', () => {
    const checks = evaluateSafeguards(good());
    expect(failingSafeguards(checks)).toEqual([]);
    expect(checks.map((c) => c.letter).join('')).toBe('abcdefghij');
  });
  it('a. password mode; a hosted install', () => {
    expect(failing({ ...good(), authMode: 'password' })).toContain('auth-mode');
    expect(failing({ ...good(), managed: true })).toEqual(['auth-mode']);
    expect(failing({ ...good(), authMode: 'identity' })).toEqual([]);
  });
  it('b. an owner without a second factor; nobody owning the machine; a passkey made for another address', () => {
    expect(failing({ ...good(), admins: [{ id: 'a1', name: 'chris', totp: 0, passkeyRpIds: [] }] })).toEqual(['second-factor']);
    expect(failing({ ...good(), admins: [] })).toEqual(['second-factor']);
    expect(failing({ ...good(), admins: [{ id: 'a1', name: 'chris', totp: 0, passkeyRpIds: ['localhost'] }] })).toEqual(['second-factor']);
    expect(failing({ ...good(), admins: [{ id: 'a1', name: 'chris', totp: 0, passkeyRpIds: ['box.example.com'] }] })).toEqual([]);
    // Two owners: both must have one, and the report says who has not.
    const two = evaluateSafeguards({ ...good(), admins: [...good().admins, { id: 'a2', name: 'sam', totp: 0, passkeyRpIds: [] }] }).find((c) => c.id === 'second-factor')!;
    expect(two.ok).toBe(false);
    expect(two.detail).toContain('sam');
    expect(two.detail).not.toContain('chris');
  });
  it('c. invited-only off', () => { expect(failing({ ...good(), invitedOnly: false })).toEqual(['invited-only']); });
  it('d. the owner-header test switch; a port clash; Funnel pointed at the private port', () => {
    expect(failing({ ...good(), ownerHeader: true })).toEqual(['separate-listener']);
    for (const p of [8080, 8091, 8093]) expect(failing({ ...good(), ports: { ...good().ports, public: p } })).toEqual(['separate-listener']);
    expect(failing({ ...good(), funnelOnPrivatePort: true })).toEqual(['separate-listener']);
    expect(failing({ ...good(), funnelOnPrivatePort: undefined })).toEqual([]);
  });
  it('f. sign-in limits loosened too far', () => {
    expect(failing({ ...good(), loginFailLimit: 500 })).toEqual(['rate-limits']);
    expect(failing({ ...good(), loginFailLimit: 0 })).toEqual(['rate-limits']);
  });
  it('i. automatic upgrades off', () => {
    const c = evaluateSafeguards({ ...good(), autoUpgrade: { ok: false, why: 'pinned to v2.1.0' } }).find((x) => x.id === 'auto-upgrade')!;
    expect(c.ok).toBe(false);
    expect(c.detail).toBe('pinned to v2.1.0');
    expect(c.fix).toContain('follow-channel.sh --install stable');
  });
});

describe('the public-access setting', () => {
  it('is off unless it says funnel; an unknown value is on and broken (fail closed)', () => {
    for (const v of [undefined, '', 'off', '0', 'no', 'false', 'OFF']) expect(publicConfig({ HATCHABOT_PUBLIC_ACCESS: v } as never).on, String(v)).toBe(false);
    expect(publicConfig({ HATCHABOT_PUBLIC_ACCESS: 'funnel' } as never)).toMatchObject({ on: true, unknownProvider: undefined, port: 8092, funnelPort: 8443, invitedOnly: false });
    expect(publicConfig({ HATCHABOT_PUBLIC_ACCESS: 'cloudflare' } as never)).toMatchObject({ on: true, unknownProvider: 'cloudflare' });
    expect(publicConfig({ HATCHABOT_PUBLIC_ACCESS: '1' } as never).unknownProvider).toBe('1');
  });
  it('bad numbers fall back to the defaults, not to zero or infinity', () => {
    const c = publicConfig({ HATCHABOT_PUBLIC_IDLE_MINUTES: '0', HATCHABOT_PUBLIC_STEPUP_MINUTES: 'never', HATCHABOT_PUBLIC_FUNNEL_PORT: '80', HATCHABOT_PUBLIC_PORT: 'x', HATCHABOT_PUBLIC_FAILS_CEILING: '' } as never);
    expect(c).toMatchObject({ idleMs: 720 * 60_000, stepUpMs: 10 * 60_000, funnelPort: 8443, port: 8092, failsCeiling: 100 });
  });
});

describe('automatic upgrades: what counts as on', () => {
  const probes = (o: Partial<{ enabled: string; active: string; unit: string | undefined; pin: string | undefined; platform: NodeJS.Platform }> = {}): AutoUpgradeProbes => ({
    platform: o.platform ?? 'linux', home: '/home/x',
    systemctl: async (args) => (args[0] === 'is-enabled' ? ('enabled' in o ? o.enabled : 'enabled') : ('active' in o ? o.active : 'active')),
    readFile: async (p) => p.endsWith('.service')
      ? ('unit' in o ? o.unit : '[Service]\nType=oneshot\nExecStart=/usr/bin/env bash "/home/x/hatchabot/scripts/follow-channel.sh" stable\n')
      : o.pin,
  });
  it('the stable timer, enabled and running, not pinned', async () => {
    expect(await autoUpgradeStatus(probes())).toEqual({ ok: true, channel: 'stable' });
    expect((await autoUpgradeStatus(probes({ pin: 'stable\n' }))).ok).toBe(true);
  });
  it('no timer, a stopped timer, another channel, a pin, an unreadable unit, a Mac', async () => {
    expect((await autoUpgradeStatus(probes({ enabled: 'disabled' }))).ok).toBe(false);
    expect((await autoUpgradeStatus(probes({ enabled: undefined }))).ok).toBe(false);
    expect((await autoUpgradeStatus(probes({ active: 'inactive' }))).ok).toBe(false);
    for (const ch of ['beta', 'latest']) {
      const r = await autoUpgradeStatus(probes({ unit: `ExecStart=/usr/bin/env bash "/x/scripts/follow-channel.sh" ${ch}\n` }));
      expect(r).toMatchObject({ ok: false, channel: ch });
    }
    expect((await autoUpgradeStatus(probes({ unit: undefined }))).ok).toBe(false);
    expect((await autoUpgradeStatus(probes({ pin: 'v2.100.0\n' }))).why).toContain('pinned to v2.100.0');
    expect((await autoUpgradeStatus(probes({ platform: 'darwin' }))).ok).toBe(false);
  });
});

describe('who has owner rights, and their factors, straight from the database', () => {
  it('accounts mode: host owners, with confirmed factors only', () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertLocalAccount({ id: 'a1', username: 'chris', pwHash: 'h', pwSalt: 's', hostOwner: true, disabled: false, createdAt: 'now' });
    store.insertLocalAccount({ id: 'a2', username: 'kid', pwHash: 'h', pwSalt: 's', hostOwner: false, disabled: false, createdAt: 'now' });
    store.insertLocalAccount({ id: 'a3', username: 'gone', pwHash: 'h', pwSalt: 's', hostOwner: true, disabled: true, createdAt: 'now' });
    expect(adminAccounts(db, 'accounts')).toEqual([{ id: 'a1', name: 'chris', totp: 0, passkeyRpIds: [] }]);
    store.insertSecondFactor({ id: 'f1', ownerId: 'a1', kind: 'totp', data: 'x', confirmed: false });
    expect(adminAccounts(db, 'accounts')[0]!.totp).toBe(0); // an enrolment nobody finished counts for nothing
    store.confirmSecondFactor('f1');
    store.insertSecondFactor({ id: 'f2', ownerId: 'a1', kind: 'passkey', credentialId: 'c', rpId: 'Box.Example.com', data: '{}' });
    store.insertSecondFactor({ id: 'f3', ownerId: 'a1', kind: 'backup', data: 'hash' });
    expect(adminAccounts(db, 'accounts')).toEqual([{ id: 'a1', name: 'chris', totp: 1, passkeyRpIds: ['box.example.com'] }]);
    expect(adminAccounts(db, 'password')).toEqual([]);
  });
  it('identity mode: the Google account that owns this machine', () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    store.insertHost({ id: 'h', ownerId: 'user-abc', kind: 'local', provider: 'mock', name: 'm', settings: {}, createdAt: 'now' });
    store.recordAccount('user-abc', 'owner@example.com');
    expect(adminAccounts(db, 'identity')).toEqual([{ id: 'user-abc', name: 'owner@example.com', totp: 0, passkeyRpIds: [] }]);
    // The unclaimed placeholder owner is nobody.
    const db2 = new Database(':memory:');
    new Store(db2).insertHost({ id: 'h', ownerId: 'dev-owner', kind: 'local', provider: 'mock', name: 'm', settings: {}, createdAt: 'now' });
    expect(adminAccounts(db2, 'identity')).toEqual([]);
  });
  it('a database from before these tables: nobody, not a crash', () => {
    expect(adminAccounts(new Database(':memory:'), 'accounts')).toEqual([]);
  });
});

describe('hatchabot doctor', () => {
  const base: DoctorFacts = {
    nodeVersion: 'v22.0.0', dockerCli: true, dockerDaemon: { ok: true, version: '27', arch: 'arm64' }, runtimeImage: { openclawVersion: '2026.9.6' },
    envFile: { present: true, secretKey: true, password: false, authMode: 'accounts', publicUrl: 'https://box.example.com' },
    db: { path: '/x.sqlite', present: true }, service: { manager: 'systemd', active: true, enabled: true },
    controlPlane: { url: 'http://localhost:8080', ok: true }, diskFreeGb: 100, backups: { dir: '/b', lastSet: new Date().toISOString().slice(0, 10), ageDays: 0 },
  };
  const pa = (f: SafeguardFacts, on: boolean, funnel?: { toPublicPort: boolean; toPrivatePort: boolean }) =>
    ({ on, url: on ? 'https://box.example.com:8443' : undefined, port: 8092, safeguards: evaluateSafeguards(f), funnel });

  it('off: one line, no failure, whatever the safeguards say', () => {
    const lines = publicAccessLines(pa({ ...good(), invitedOnly: false, autoUpgrade: { ok: false } }, false));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'ok' });
    expect(lines[0]!.text).toContain('off');
    expect(lines[0]!.text).toContain('Only invited people');
  });
  it('on with everything in place: every safeguard is reported, none fails', () => {
    const lines = doctorReport({ ...base, publicAccess: pa(good(), true, { toPublicPort: true, toPrivatePort: false }) });
    expect(lines.filter((l) => l.level === 'fail')).toEqual([]);
    for (const letter of 'abcdefghij') expect(lines.some((l) => l.text.trimStart().startsWith(`${letter}. `)), letter).toBe(true);
    expect(lines.some((l) => l.text.includes('Public access is ON at https://box.example.com:8443'))).toBe(true);
  });
  it('on with a safeguard off: FAILS, naming each one, with its fix', () => {
    for (const [mut, id] of [
      [{ authMode: 'password' }, 'a'], [{ admins: [] }, 'b'], [{ invitedOnly: false }, 'c'], [{ ownerHeader: true }, 'd'],
      [{ loginFailLimit: 99 }, 'f'], [{ autoUpgrade: { ok: false, why: 'no timer' } }, 'i'],
    ] as Array<[Partial<SafeguardFacts>, string]>) {
      const lines = doctorReport({ ...base, publicAccess: pa({ ...good(), ...mut }, true) });
      const fails = lines.filter((l) => l.level === 'fail');
      expect(fails.length, id).toBeGreaterThanOrEqual(2); // the headline and the safeguard
      expect(fails.some((l) => l.text.includes('answers 503')), id).toBe(true);
      const line = fails.find((l) => l.text.trimStart().startsWith(`${id}. `));
      expect(line, id).toBeTruthy();
      expect(line!.fix, id).toBeTruthy();
    }
  });
  it('Funnel publishing the private port fails even with public access off; an unknown provider fails', () => {
    expect(publicAccessLines(pa(good(), false, { toPublicPort: false, toPrivatePort: true }))[0]).toMatchObject({ level: 'fail' });
    const lines = publicAccessLines({ ...pa(good(), true), unknownProvider: 'ngrok' });
    expect(lines.some((l) => l.level === 'fail' && l.text.includes('ngrok'))).toBe(true);
  });
  it('left-overs are warned about: Funnel on with the switch off, the switch on with no Funnel', () => {
    expect(publicAccessLines(pa(good(), false, { toPublicPort: true, toPrivatePort: false })).some((l) => l.level === 'warn')).toBe(true);
    expect(publicAccessLines(pa(good(), true, { toPublicPort: false, toPrivatePort: false })).some((l) => l.level === 'warn' && l.fix === 'hatchabot reach on')).toBe(true);
  });
});
