import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { computePosture, riskKeys, diffRisks, measureAgentDisks } from '../src/orchestrator/posture.js';
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

  it('a wide-audience agent with NO powerful capability is MEDIUM, not HIGH', () => {
    const store = baseStore();
    agent(store, 'chatty');
    for (const uid of ['1', '2', '3', '4']) {
      store.insertMembership({ id: `m${uid}`, agentId: 'chatty', userId: `u${uid}`, role: 'user', channelUserId: uid, status: 'active' });
    }
    const report = computePosture(store, { ownerId: OWNER, isHostOwner: true, authMode: 'identity' });
    expect(report.agents.find((a) => a.id === 'chatty')!.exposure).toBe('medium');
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
});
