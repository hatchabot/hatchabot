import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes } from '../src/api/routes.js';
import { AdoptError, applyWorkspace } from '../src/orchestrator/adopt.js';
import { AdmitError, denyPairing, grantChannelAccess, RevokeError, revokeMember } from '../src/orchestrator/members.js';
import { readCoreFile, removeCoreFile, SnapshotError, writeCoreFile } from '../src/orchestrator/snapshots.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';

/**
 * Every use of a volume that is gone says so, instead of the try-again wording
 * of a failure that could pass (HB-0373). The provider's own check, and that it
 * never makes the volume, is in localDockerProvider.test.ts.
 */
async function goneAgent() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} });
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  store.setAgentState('a1', 'STOPPED');
  provider.goneVolumes.add(runtimeRef);
  return { store, provider, runtimeRef };
}

describe('a volume that is gone (HB-0373)', () => {
  it('turning a pairing request away, or admitting someone, says so', async () => {
    const { store, provider, runtimeRef } = await goneAgent();
    const deny = await denyPairing({ store, provider }, { agentId: 'a1', runtimeRef, code: 'ABCD1234' }).catch((e) => e);
    expect(deny).toBeInstanceOf(AdmitError);
    expect(deny.message).toMatch(/volume is gone/);
    const grant = await grantChannelAccess({ store, provider }, { agentId: 'a1', runtimeRef, accountId: 'kitchenbot', kind: 'telegram', channelUserId: '555' }).catch((e) => e);
    expect(grant).toBeInstanceOf(AdmitError);
    expect(grant.message).toMatch(/volume is gone/);
  });

  it('removing a member says so and keeps them: another machine may still hold the allowlist', async () => {
    const { store, provider } = await goneAgent();
    store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'kitchenbot', secretRef: 'chan/a1', deepLink: 'https://t.me/kitchenbot', createdAt: 'now' });
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'u2', role: 'user', displayName: 'Sam', channelUserId: '555', status: 'active' });
    const err = await revokeMember({ store, provider }, 'a1', 'u2').catch((e) => e);
    expect(err).toBeInstanceOf(RevokeError);
    expect(err.message).toMatch(/volume is gone/);
    expect(store.getMembership('a1', 'u2')).toBeTruthy();
  });

  it('reading, writing or removing a core file says so', async () => {
    const { provider, runtimeRef } = await goneAgent();
    const via = { onVolume: true };
    for (const p of [
      readCoreFile(provider, runtimeRef, 'kitchen', 'SOUL.md', via),
      writeCoreFile(provider, runtimeRef, 'kitchen', 'SOUL.md', 'x', via),
      writeCoreFile(provider, runtimeRef, 'kitchen', 'MEMORY.md', 'x'.repeat(200 * 1024), via),
      removeCoreFile(provider, runtimeRef, 'kitchen', 'SOUL.md', via),
    ]) {
      const err = await p.catch((e) => e);
      expect(err).toBeInstanceOf(SnapshotError);
      expect(err.message).toMatch(/volume is gone/);
    }
    expect(provider.written).toEqual([]);
  });

  /** The real routes over the same agent, with an AI source and a Discord app. */
  async function goneRoutes() {
    const w = await goneAgent();
    w.store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-sonnet-5'], secretRef: 'ai/p1', createdAt: 'now' });
    w.store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'discord', accountId: 'kitchenbot', secretRef: 'chan/a1', deepLink: 'https://discord.example/x', createdAt: 'now' });
    const f = Fastify();
    const secrets = { put: async () => {}, get: async () => 'made-up', delete: async () => {} };
    await registerRoutes(f, { store: w.store, secrets: secrets as never, providers: new Map([['mock', w.provider]]), channel: { pool: { availableCount: () => 0, owns: () => false }, release: async () => {} } as never });
    return { ...w, f, H: { 'x-hatchabot-owner': 'o' } };
  }

  it("changing a stopped agent's model says so, and never advises the rebuild that makes an empty volume", async () => {
    const { store, f, H } = await goneRoutes();
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: H, payload: { model: 'claude-sonnet-5' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/volume is gone/);
    expect(r.json().error).toMatch(/fresh, empty volume/);
    expect(r.json().error).not.toMatch(/try again/i);
    expect(store.getAgent('a1')!.model).toBe('claude-sonnet-5'); // recorded, as a refused model is
  });

  it('a class whose model cannot be written says so too', async () => {
    const { f, H } = await goneRoutes();
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Light', model: 'claude-sonnet-5' } })).json().class.id;
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    expect(r.json().modelPending).toMatch(/volume is gone/);
    expect(r.json().modelPending).not.toMatch(/try again/i);
  });

  it('adopting into it says so, not "Adopt again"', async () => {
    const { store, provider } = await goneAgent();
    const dir = mkdtempSync(join(tmpdir(), 'hb-gone-'));
    try {
      mkdirSync(join(dir, 'workspace'));
      writeFileSync(join(dir, 'workspace', 'SOUL.md'), '# made up');
      const err = await applyWorkspace({ store, provider } as never, 'a1', join(dir, 'workspace')).catch((e) => e);
      expect(err).toBeInstanceOf(AdoptError);
      expect(err.userMessage).toMatch(/volume is gone/);
      expect(err.userMessage).not.toMatch(/Adopt again/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('unlinking Discord says so, not "is the machine awake", and keeps the binding', async () => {
    const { store, f, H } = await goneRoutes();
    store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'o', role: 'owner', displayName: 'Sam', status: 'active' } as never);
    expect(store.bindMemberIdentity('a1', 'o', 'discord', '111111111111111111')).toBe(true);
    const r = await f.inject({ method: 'DELETE', url: '/v1/account/discord', headers: H });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ unlinked: false, agents: 0, volumeGone: ['Kitchen'] });
    expect(r.json().error).toMatch(/volume is gone/);
    expect(r.json().error).not.toMatch(/awake/);
    expect(store.memberIdentities('a1', 'o').discord).toBe('111111111111111111');
  });

  it('a file limit that cannot be written says so', async () => {
    const { f, H } = await goneRoutes();
    const r = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { filesMaxMb: 5 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().filesCapPending).toMatch(/volume is gone/);
  });
});
