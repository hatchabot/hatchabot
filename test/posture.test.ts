import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { computePosture, riskKeys, diffRisks } from '../src/orchestrator/posture.js';

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
