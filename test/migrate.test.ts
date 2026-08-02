import { describe, expect, it, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateAgent, MigrateError, preflight } from '../src/orchestrator/migrate.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

const channelStub = { kind: 'telegram' } as unknown as ChannelProvisioner;
const PEER = { id: 'peer1', name: 'Desktop', url: 'http://desktop:8080', secretRef: 'peer/tok' };

async function world() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({
    id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box',
    settings: {}, createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p1', ownerId: 'o', name: 'Claude', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now',
  });
  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING',
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true,
    createdAt: 'now', updatedAt: 'now',
  });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'o', role: 'owner', status: 'active' });
  await secrets.put('ai/p1', 'sk');
  await secrets.put('chan/a1', 'bot-token');
  await secrets.put('peer/tok', 'agentclaw_peertoken');
  store.insertChannel({
    id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'kitchenbot',
    secretRef: 'chan/a1', deepLink: 'https://t.me/kitchenbot', createdAt: 'now',
  });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen',
    workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } },
    env: {},
  });
  store.setAgentRuntimeRef('a1', runtimeRef);
  await provider.start(runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  provider.stateStore.set(runtimeRef, Buffer.from('memory'));
  return { store, secrets, provider, deps: { store, secrets, provider, channel: channelStub, sleep: async () => {} } };
}

/** Stub the peer's HTTP surface. */
function peerResponds(handlers: { preflight?: any; import?: any; importStatus?: number }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/v1/agents/preflight')) {
      return new Response(JSON.stringify(handlers.preflight ?? { ok: true, reasons: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (u.endsWith('/v1/agents/import')) {
      return new Response(JSON.stringify(handlers.import ?? { id: 'remote1', name: 'Kitchen', state: 'RUNNING' }), {
        status: handlers.importStatus ?? 201, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('preflight', () => {
  it('accepts when nothing collides', async () => {
    const w = await world();
    const a = preflight(w.store, 'o', { slug: 'newname', accountId: 'otherbot', vendor: 'anthropic' });
    expect(a.ok).toBe(true);
    expect(a.aiModel).toBe('claude-opus-4-8');
  });

  it('refuses a slug or bot that already lives here, and says which', async () => {
    const w = await world();
    const a = preflight(w.store, 'o', { slug: 'kitchen', accountId: 'kitchenbot' });
    expect(a.ok).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/already lives here/);
    expect(a.reasons.join(' ')).toMatch(/already wired/);
  });

  it('refuses a local-model agent when the destination has no local source', async () => {
    const w = await world(); // only an anthropic profile exists here
    const a = preflight(w.store, 'o', { slug: 'fresh', accountId: 'freshbot', vendor: 'local' });
    expect(a.ok).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/no local model server/i);
    expect(a.warnings).toContain('vendor-mismatch');
    // and it names what it WOULD have fallen back to, so the owner can judge
    expect(a.reasons.join(' ')).toMatch(/Claude/);
  });

  it('accepts when the vendor matches', async () => {
    const w = await world();
    const a = preflight(w.store, 'o', { slug: 'fresh', accountId: 'freshbot', vendor: 'anthropic' });
    expect(a.ok).toBe(true);
  });

  it('refuses when the destination has no AI source', () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({
      id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box',
      settings: {}, createdAt: 'now',
    });
    const a = preflight(store, 'o', { slug: 's', accountId: 'b' });
    expect(a.ok).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/No AI source/);
  });
});

describe('migrateAgent', () => {
  it('never exports when the destination refuses on a vendor mismatch', async () => {
    const w = await world();
    peerResponds({
      preflight: { ok: false, reasons: ['No matching AI source: it runs on a local model…'], warnings: ['vendor-mismatch'] },
    });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/No matching AI source/);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING'); // untouched
  });

  it('moves the agent and leaves the source STOPPED, never deleted', async () => {
    const w = await world();
    peerResponds({});
    const res = await migrateAgent(w.deps as any, 'a1', PEER);
    expect(res).toMatchObject({ movedTo: 'Desktop', remoteAgentId: 'remote1' });
    // one poller per bot: the source must not be running
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    // and it still exists — deleting it is the owner's decision
    expect(w.store.getAgent('a1')).toBeTruthy();
  });

  it('refuses before touching anything when preflight says no', async () => {
    const w = await world();
    peerResponds({ preflight: { ok: false, reasons: ['Bot @kitchenbot is already wired to an agent here.'] } });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toBeInstanceOf(MigrateError);
    // untouched: still running, never exported
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('restarts the source when the destination rejects the import', async () => {
    const w = await world();
    peerResponds({ importStatus: 400, import: { error: 'disk full' } });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/disk full/);
    // export stopped it; the rollback must have put it back
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('restarts the source when the destination accepts but does not come up', async () => {
    const w = await world();
    peerResponds({ import: { id: 'r1', name: 'Kitchen', state: 'FAILED' } });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/FAILED there/);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('restarts the source when the peer is unreachable mid-transfer', async () => {
    const w = await world();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).endsWith('/preflight')) {
        return new Response(JSON.stringify({ ok: true, reasons: [] }), { status: 200 });
      }
      throw new Error('ECONNRESET');
    });
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toBeInstanceOf(MigrateError);
    expect(w.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('refuses to move an agent that is mid-flight', async () => {
    const w = await world();
    w.store.setAgentState('a1', 'REBUILDING');
    await expect(migrateAgent(w.deps as any, 'a1', PEER)).rejects.toThrow(/while it is REBUILDING/);
  });
});
