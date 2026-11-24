import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { computePosture, riskKeys, diffRisks, measureAgentDisks, runPostureSweep, DISK_MEASURE_SCRIPT, onlyVanished, RISK_KEYS_FORMAT } from '../src/orchestrator/health/posture.js';
import type { RuntimeProvider } from '../src/providers/provider.js';

const OWNER = 'user-a';

function baseStore() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  return store;
}
function agent(store: Store, id: string, extra: Record<string, unknown> = {}) {
  store.insertAgent({
    id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING',
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false,
    createdAt: 'now', updatedAt: 'now', ...extra,
  } as any);
}

describe('computePosture — per-agent Telegram exposure', () => {
  it('flags a wide-audience + send-email agent HIGH, and a bare agent LOW', () => {
    const store = baseStore();
    agent(store, 'hi');
    // audience: three active linked members
    for (const uid of ['111', '222', '333']) {
      store.insertMembership({ id: `m-${uid}`, agentId: 'hi', userId: `u-${uid}`, role: 'user', channelUserId: uid, status: 'active' });
    }
    // capability: a send-enabled Google connection
    store.insertConnection({ id: 'c1', ownerId: OWNER, kind: 'google', email: 'ops@example.com', services: ['gmail'], secretRef: 's/c1' });
    store.attachConnection('hi', 'c1', false); // gmailNoSend = false → can send

    agent(store, 'lo'); // no audience, no capability

    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
    const hi = report.agents.find((a) => a.id === 'hi')!;
    const lo = report.agents.find((a) => a.id === 'lo')!;
    expect(hi.exposure).toBe('high');
    expect(hi.capabilities.some((c) => c.startsWith('send email'))).toBe(true);
    expect(lo.exposure).toBe('low');
    // high-exposure sorts first
    expect(report.agents[0]!.id).toBe('hi');
  });

  it('lists an agent\'s own browser among what it can do, without raising its exposure (HB-0675)', () => {
    const store = baseStore();
    agent(store, 'surfer');
    store.setAgentBrowser('surfer', true);
    agent(store, 'plain');
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
    const surfer = report.agents.find((a) => a.id === 'surfer')!;
    expect(surfer.capabilities).toContain('its own browser');
    expect(surfer.exposure).toBe('low');
    expect(report.agents.find((a) => a.id === 'plain')!.capabilities).not.toContain('its own browser');
  });

  it('a browser that keeps its logins is said, and is a powerful capability: it can act as its owner on those sites (HB-0680)', () => {
    const store = baseStore();
    agent(store, 'signed');
    store.setAgentBrowser('signed', true);
    store.setAgentBrowserLogins('signed', '0a1b2c3d4e5f');
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
    const signed = report.agents.find((a) => a.id === 'signed')!;
    expect(signed.capabilities).toContain('its own browser, keeps logins');
    expect(signed.exposure).toBe('medium');
    expect(signed.reasons).toContain('has a powerful capability');
    // Switched off, the browser keeps nothing: back to a plain browser.
    store.setAgentBrowser('signed', false);
    store.setAgentBrowser('signed', true);
    const again = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' }).agents.find((a) => a.id === 'signed')!;
    expect(again.capabilities).toContain('its own browser');
    expect(again.exposure).toBe('low');
  });

  it('a wide-audience agent with NO powerful capability is MEDIUM, not HIGH', () => {
    const store = baseStore();
    agent(store, 'chatty');
    for (const uid of ['1', '2', '3', '4']) {
      store.insertMembership({ id: `m${uid}`, agentId: 'chatty', userId: `u${uid}`, role: 'user', channelUserId: uid, status: 'active' });
    }
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
    expect(report.agents.find((a) => a.id === 'chatty')!.exposure).toBe('medium');
  });

  it('counts guests on Discord, Slack and web chat, not only Telegram, and lists none of them as pending (HB-0575)', () => {
    const store = baseStore();
    agent(store, 'shared');
    store.insertDataSource({ id: 'd1', agentId: 'shared', kind: 'folder', access: 'rw', mountName: 'project', hostPath: '/tmp/made-up-project', createdAt: 'now' } as any);
    store.insertMembership({ id: 'g1', agentId: 'shared', userId: 'u-disc', role: 'user', status: 'active' });
    store.bindMemberIdentity('shared', 'u-disc', 'discord', '100000000000000001');
    store.insertMembership({ id: 'g2', agentId: 'shared', userId: 'u-slack', role: 'user', status: 'active' });
    store.bindMemberIdentity('shared', 'u-slack', 'slack', 'U0000EXAMPLE');
    store.insertMembership({ id: 'g3', agentId: 'shared', userId: 'u-web', role: 'user', status: 'active', webChat: true });
    store.insertMembership({ id: 'g4', agentId: 'shared', userId: 'u-invited', role: 'user', status: 'active' });
    const row = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'accounts' }).agents.find((a) => a.id === 'shared')!;
    expect(row.audienceCount).toBe(3);
    expect(row.exposure).toBe('high');
    expect(row.reasons).toContain('3 people can message it');
    const by = Object.fromEntries((row.audience ?? []).map((m) => [m.name, m]));
    expect(by['u-disc']).toMatchObject({ channels: ['discord'] });
    expect(by['u-disc']!.pending).toBeUndefined();
    expect(by['u-slack']).toMatchObject({ channels: ['slack'] });
    expect(by['u-web']).toMatchObject({ channels: ['web chat'] });
    expect(by['u-web']!.pending).toBeUndefined();
    expect(by['u-invited']!.pending).toBe(true);
  });

  it('no group setting is the default the build writes: any group, its members, once its bot admits someone (HB-1093)', () => {
    const store = baseStore();
    agent(store, 'tg');
    store.insertChannel({ id: 'ch-tg', agentId: 'tg', kind: 'telegram', accountId: 'made_up_bot', secretRef: 's/ch-tg', deepLink: 'https://t.me/made_up_bot', createdAt: 'now' } as any);
    store.insertMembership({ id: 'm-tg', agentId: 'tg', userId: 'u-tg', role: 'owner', channelUserId: '41', status: 'active' });
    agent(store, 'nobody'); // a bot, nobody admitted: the build writes no group
    store.insertChannel({ id: 'ch-nb', agentId: 'nobody', kind: 'telegram', accountId: 'made_up_bot2', secretRef: 's/ch-nb', deepLink: 'https://t.me/made_up_bot2', createdAt: 'now' } as any);
    agent(store, 'web'); // no bot: no Telegram group at all
    store.insertMembership({ id: 'm-web', agentId: 'web', userId: 'u-web', role: 'owner', channelUserId: '42', status: 'active' });
    agent(store, 'shut');
    store.insertChannel({ id: 'ch-shut', agentId: 'shut', kind: 'telegram', accountId: 'made_up_bot3', secretRef: 's/ch-shut', deepLink: 'https://t.me/made_up_bot3', createdAt: 'now' } as any);
    store.insertMembership({ id: 'm-shut', agentId: 'shut', userId: 'u-shut', role: 'owner', channelUserId: '43', status: 'active' });
    store.setAgentGroupAccess('shut', { mode: 'off' });
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'accounts' });
    const row = (id: string) => report.agents.find((a) => a.id === id)!;
    expect(row('tg').group).toBe('members');
    expect(row('tg').reasons).toContain('group chat (members)');
    expect(row('nobody').group).toBe('off');
    expect(row('web').group).toBe('off');
    expect(row('shut').group).toBe('off');
  });

  it('a Google connection without Gmail is not reported as able to send mail (HB-0600)', () => {
    const store = baseStore();
    agent(store, 'cal');
    store.insertConnection({ id: 'c-cal', ownerId: OWNER, kind: 'google', email: 'calendar@example.com', services: ['calendar'], secretRef: 's/c-cal' });
    store.attachConnection('cal', 'c-cal', false);
    agent(store, 'mail');
    store.insertConnection({ id: 'c-mail', ownerId: OWNER, kind: 'google', email: 'mail@example.com', services: ['calendar', 'gmail'], secretRef: 's/c-mail' });
    store.attachConnection('mail', 'c-mail', false);
    agent(store, 'blocked');
    store.attachConnection('blocked', 'c-mail', true);
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
    const caps = (id: string) => report.agents.find((a) => a.id === id)!.capabilities;
    expect(caps('cal').some((c) => c.startsWith('send email'))).toBe(false);
    expect(report.agents.find((a) => a.id === 'cal')!.exposure).toBe('low');
    expect(caps('mail')).toContain('send email as mail@example.com');
    expect(caps('blocked').some((c) => c.startsWith('send email'))).toBe(false);
  });

  it('excludes archived agents', () => {
    const store = baseStore();
    agent(store, 'arch', { state: 'ARCHIVED' });
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
    expect(report.agents.find((a) => a.id === 'arch')).toBeUndefined();
  });
});

describe('computePosture — install checks', () => {
  it('flags a shared machine-login source CRITICAL', () => {
    const store = baseStore();
    store.insertAIProfile({ id: 'ml', ownerId: OWNER, name: 'Household Claude', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: undefined, createdAt: 'now' } as any);
    store.setAIProfileShared('ml', true);
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
    const check = report.install.find((c) => c.key === 'shared-machine-login')!;
    expect(check.level).toBe('critical');
  });

  it('warns when identity mode is off and no agent cap is set; omits install checks for a non-host-owner', () => {
    const store = baseStore();
    const asOperator = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'password' });
    expect(asOperator.install.find((c) => c.key === 'auth-mode')!.level).toBe('warn');
    const asMember = computePosture(store, { ownerId: OWNER, isHostOwner: false, authMode: 'password' });
    expect(asMember.install).toEqual([]); // members don't see install-level checks
  });
});

describe('risk diffing', () => {
  it('riskKeys captures active risks; diff reports what newly appeared', () => {
    const report = { install: [{ key: 'owner-header', level: 'critical' as const, title: '', detail: '' }], agents: [{ id: 'x', name: 'X', audienceCount: 5, group: 'off' as const, capabilities: [], exposure: 'high' as const, reasons: [] }], limits: { agentCap: 0, liveAgents: 1, diskWarnGB: 10 } };
    const keys = riskKeys(report);
    expect(keys).toContain('install:owner-header:critical');
    expect(keys).toContain('agent:x:high');
    const d = diffRisks(keys, ['agent:x:high']); // owner-header is new since last time
    expect(d.added).toEqual(['install:owner-header:critical']);
    expect(d.removed).toEqual([]);
  });

  it('the sweep checks the machine\'s owner when they have no agents yet (HB-1104)', () => {
    const store = baseStore(); // this machine, its owner, no agent
    const logged: Array<Record<string, unknown>> = [];
    const saved = process.env.HATCHABOT_ALLOWED_EMAILS;
    delete process.env.HATCHABOT_ALLOWED_EMAILS;
    try {
      runPostureSweep(store, { authMode: 'identity', log: (_e, d) => { logged.push(d); } });
    } finally {
      if (saved !== undefined) process.env.HATCHABOT_ALLOWED_EMAILS = saved;
    }
    expect(logged).toHaveLength(1);
    expect(logged[0]!.ownerId).toBe(OWNER);
    expect(logged[0]!.added).toContain('install:allowed-emails:critical');
    expect(store.latestPostureSnapshotBefore(OWNER, '9999-12-31')).toContain('install:allowed-emails:critical');
  });

  it('an agent already at high that gains another powerful capability is a change the sweep reports (HB-1103)', () => {
    const store = baseStore();
    agent(store, 'wide');
    for (const uid of ['51', '52', '53']) {
      store.insertMembership({ id: `m-w${uid}`, agentId: 'wide', userId: `u-w${uid}`, role: 'user', channelUserId: uid, status: 'active' });
    }
    store.setAgentBrowser('wide', true);
    store.setAgentBrowserLogins('wide', '0a1b2c3d4e5f');
    const changes: Array<{ added: string[]; removed: string[] }> = [];
    const log = (_e: string, d: Record<string, unknown>) => { changes.push(d as never); };
    runPostureSweep(store, { authMode: 'accounts', log });
    const before = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'accounts' }).agents.find((a) => a.id === 'wide')!;
    expect(before.exposure).toBe('high');
    changes.length = 0;
    store.insertConnection({ id: 'c-w', ownerId: OWNER, kind: 'google', email: 'helper@example.com', services: ['gmail'], secretRef: 's/c-w' });
    store.attachConnection('wide', 'c-w', false);
    runPostureSweep(store, { authMode: 'accounts', log });
    expect(changes).toEqual([{ ownerId: OWNER, added: ['agent:wide:can:send email as helper@example.com'], removed: [] }]);
    // A capability that raises nothing is not a risk of its own.
    store.setAgentSharedMemory('wide', true);
    changes.length = 0;
    runPostureSweep(store, { authMode: 'accounts', log });
    expect(changes).toEqual([]);
  });

  it('a snapshot of the older key format is no baseline: the upgrade day reports nothing, and the next change is reported (HB-1103)', () => {
    const store = baseStore();
    agent(store, 'wide');
    for (const uid of ['51', '52', '53']) {
      store.insertMembership({ id: `m-w${uid}`, agentId: 'wide', userId: `u-w${uid}`, role: 'user', channelUserId: uid, status: 'active' });
    }
    store.setAgentBrowser('wide', true);
    store.setAgentBrowserLogins('wide', '0a1b2c3d4e5f');
    // Yesterday's, as the release before wrote it: no capability keys.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const before = riskKeys(computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'accounts' })).filter((k) => !k.includes(':can:'));
    store.upsertPostureSnapshot(OWNER, yesterday, before);
    const changes: Array<{ added: string[]; removed: string[] }> = [];
    const log = (_e: string, d: Record<string, unknown>) => { changes.push(d as never); };
    runPostureSweep(store, { authMode: 'accounts', log });
    expect(changes).toEqual([]);
    expect(store.latestPostureSnapshotBefore(OWNER, '9999-12-31')![0]).toBe(RISK_KEYS_FORMAT);
    // Against that baseline, a real change is reported.
    store.insertConnection({ id: 'c-w', ownerId: OWNER, kind: 'google', email: 'helper@example.com', services: ['gmail'], secretRef: 's/c-w' });
    store.attachConnection('wide', 'c-w', false);
    runPostureSweep(store, { authMode: 'accounts', log });
    expect(changes).toEqual([{ ownerId: OWNER, added: ['agent:wide:can:send email as helper@example.com'], removed: [] }]);
  });
});

// 2026-09-30: "Disk warning at 10 GB per agent" had nothing measuring it.
describe('agent storage warning', () => {
  it('an agent measured over the warning gets a reason, a Limits entry and a risk key', () => {
    const store = baseStore();
    agent(store, 'big');
    agent(store, 'small');
    store.setAgentDiskBytes('big', 12.4e9, '2026-09-30T03:00:00.000Z');
    store.setAgentDiskBytes('small', 2e9);
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
    const big = report.agents.find((a) => a.id === 'big')!;
    expect(big.reasons).toContain('uses 12.4 GB of storage (warning at 10.0 GB)');
    expect(big.diskOverBytes).toBe(12.4e9);
    expect(report.agents.find((a) => a.id === 'small')!.diskOverBytes).toBeUndefined();
    expect(report.limits.overDisk).toEqual([{ id: 'big', name: 'big', bytes: 12.4e9, measuredAt: '2026-09-30T03:00:00.000Z' }]);
    expect(riskKeys(report)).toContain('disk:big');
    expect(riskKeys(report)).not.toContain('disk:small');
  });

  it('honours HATCHABOT_AGENT_DISK_WARN_GB', () => {
    const store = baseStore();
    agent(store, 'mid');
    store.setAgentDiskBytes('mid', 3e9);
    process.env.HATCHABOT_AGENT_DISK_WARN_GB = '2';
    try {
      const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
      expect(report.limits.overDisk?.map((d) => d.id)).toEqual(['mid']);
    } finally {
      delete process.env.HATCHABOT_AGENT_DISK_WARN_GB;
    }
  });

  it('measureAgentDisks: read-only du per agent, sequential, skips fresh/busy/archived, keeps the old value on a failure', async () => {
    const store = baseStore();
    agent(store, 'run', { runtimeRef: 'rt-run' });
    agent(store, 'sleep', { state: 'STOPPED', runtimeRef: 'rt-sleep' });
    agent(store, 'fresh', { runtimeRef: 'rt-fresh' });
    agent(store, 'busy', { runtimeRef: 'rt-busy' });
    agent(store, 'arch', { state: 'ARCHIVED', runtimeRef: 'rt-arch' });
    agent(store, 'broken', { runtimeRef: 'rt-broken' });
    const now = Date.parse('2026-09-30T04:00:00.000Z');
    store.setAgentDiskBytes('fresh', 5, new Date(now - 3_600_000).toISOString());
    store.setAgentDiskBytes('broken', 7, new Date(now - 2 * 86_400_000).toISOString());
    const seen: Array<{ ref: string; script: string; readOnly?: boolean }> = [];
    let live = 0;
    const provider = {
      async execShellOnVolume(ref: string, script: string, opts?: { readOnly?: boolean }) {
        live++;
        expect(live).toBe(1); // one at a time
        seen.push({ ref, script, readOnly: opts?.readOnly });
        await new Promise((r) => setTimeout(r, 2));
        live--;
        if (ref === 'rt-broken') return { code: 1, stdout: '', stderr: 'no such volume' };
        return { code: 0, stdout: ref === 'rt-run' ? '11000000000\n' : '42\n', stderr: '' };
      },
    } as unknown as RuntimeProvider;
    const r = await measureAgentDisks({ store, providerFor: () => provider, isBusy: (id) => id === 'busy', now: () => now });
    expect(r).toEqual({ measured: 2, failed: 1 });
    expect(seen.map((x) => x.ref).sort()).toEqual(['rt-broken', 'rt-run', 'rt-sleep']);
    expect(seen.every((x) => x.readOnly === true && x.script.includes('du -sb /home/node'))).toBe(true);
    const d = store.agentDiskBytes();
    expect(d.get('run')!.bytes).toBe(11e9);
    expect(d.get('sleep')!.bytes).toBe(42);
    expect(d.get('fresh')!.bytes).toBe(5);
    expect(d.get('broken')!.bytes).toBe(7);
    expect(d.has('arch')).toBe(false);
  });

  it('an incomplete count (du could not read a folder, or ran out of time) keeps the last measurement and is tried again (HB-0943)', async () => {
    const store = baseStore();
    agent(store, 'partial', { runtimeRef: 'rt-partial' });
    agent(store, 'slow', { runtimeRef: 'rt-slow' });
    const now = Date.parse('2026-09-30T04:00:00.000Z');
    const old = new Date(now - 2 * 86_400_000).toISOString();
    store.setAgentDiskBytes('partial', 12e9, old);
    store.setAgentDiskBytes('slow', 12e9, old);
    const logged: string[] = [];
    let calls = 0;
    const provider = {
      async execShellOnVolume(ref: string) {
        calls++;
        return ref === 'rt-partial'
          ? { code: 1, stdout: '4096\n', stderr: "du: cannot read directory '/home/node/locked': Permission denied" }
          : { code: 1, stdout: '4096\n', stderr: '', timedOut: true };
      },
    } as unknown as RuntimeProvider;
    const sweep = () => measureAgentDisks({ store, providerFor: () => provider, now: () => now, log: (e) => logged.push(e) });
    expect(await sweep()).toEqual({ measured: 0, failed: 2 });
    const d = store.agentDiskBytes();
    expect(d.get('partial')).toEqual({ bytes: 12e9, measuredAt: old });
    expect(d.get('slow')).toEqual({ bytes: 12e9, measuredAt: old });
    expect(logged).toEqual(['security.disk_measure_failed', 'security.disk_measure_failed']);
    // Not taken as fresh: the next sweep measures them again.
    await sweep();
    expect(calls).toBe(4);
  });

  it('files that went away while du counted leave the count whole; one it could not read still fails it (HB-0943)', async () => {
    const store = baseStore();
    agent(store, 'busy', { runtimeRef: 'rt-busy' });
    agent(store, 'mixed', { runtimeRef: 'rt-mixed' });
    const now = Date.parse('2026-09-30T04:00:00.000Z');
    const gone = "du: cannot access '/home/node/.cache/tmp-41': No such file or directory\ndu: cannot read directory '/home/node/browser/Cache_Data': No such file or directory";
    const provider = {
      async execShellOnVolume(ref: string) {
        return ref === 'rt-busy'
          ? { code: 1, stdout: '9000000\n', stderr: gone }
          : { code: 1, stdout: '4096\n', stderr: `${gone}\ndu: cannot read directory '/home/node/locked': Permission denied` };
      },
    } as unknown as RuntimeProvider;
    expect(await measureAgentDisks({ store, providerFor: () => provider, now: () => now })).toEqual({ measured: 1, failed: 1 });
    expect(store.agentDiskBytes().get('busy')!.bytes).toBe(9_000_000);
    expect(store.agentDiskBytes().has('mixed')).toBe(false);
    // The words this machine's du uses for a file that is not there.
    const { spawnSync } = await import('node:child_process');
    const du = spawnSync('du', ['-sb', '/nonexistent-hb-0943-41'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    expect(du.status).not.toBe(0);
    expect(onlyVanished(du.stderr)).toBe(true);
    expect(onlyVanished("du: cannot read directory '/x': Permission denied")).toBe(false);
    expect(onlyVanished('')).toBe(false);
  });

  it('the measurement runs du in the C locale, so its words are the ones onlyVanished knows in any language (HB-0943)', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const german = { LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8', LANGUAGE: 'de' };
    const dir = mkdtempSync(join(tmpdir(), 'hb-du-'));
    try {
      // A du of its own on PATH that says which locale it was given.
      writeFileSync(join(dir, 'du'), `#!/bin/sh\nprintf '%s' "$LC_ALL" > ${JSON.stringify(join(dir, 'seen'))}\necho '4096\t/home/node'\n`, { mode: 0o755 });
      const run = spawnSync('bash', ['-c', DISK_MEASURE_SCRIPT], { encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`, ...german } });
      expect(run.status).toBe(0);
      expect(run.stdout.trim()).toBe('4096');
      expect(readFileSync(join(dir, 'seen'), 'utf8')).toBe('C');
      // And this machine's du, asked in German, for a folder that is not there.
      const real = spawnSync('bash', ['-c', DISK_MEASURE_SCRIPT.replace('/home/node', join(dir, 'gone-41'))], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...german } });
      expect(real.status).not.toBe(0);
      expect(onlyVanished(real.stderr)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.getuid?.() === 0)('the measurement fails when du cannot read part of the volume, instead of printing a short total (HB-0943)', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const dir = mkdtempSync(join(tmpdir(), 'hb-du-'));
    try {
      mkdirSync(join(dir, 'locked'));
      writeFileSync(join(dir, 'locked', 'big'), Buffer.alloc(1_000_000));
      chmodSync(join(dir, 'locked'), 0o000);
      const run = spawnSync('bash', ['-c', DISK_MEASURE_SCRIPT.replace('/home/node', dir)], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      expect(run.status).not.toBe(0);
      chmodSync(join(dir, 'locked'), 0o755);
      const whole = spawnSync('bash', ['-c', DISK_MEASURE_SCRIPT.replace('/home/node', dir)], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
      expect(whole.status).toBe(0);
      expect(Number(whole.stdout.trim())).toBeGreaterThanOrEqual(1_000_000);
    } finally {
      try { chmodSync(join(dir, 'locked'), 0o755); } catch { /* already */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
