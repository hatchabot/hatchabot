import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { exportAgent, importAgent, TransferError } from '../src/orchestrator/transfer.js';
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

async function installation(owner = 'o') {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({
    id: 'h1', ownerId: owner, kind: 'local', provider: 'mock', name: 'box',
    settings: {}, createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p1', ownerId: owner, name: 'Claude', vendor: 'anthropic', kind: 'api_key',
    model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now',
  });
  await secrets.put('ai/p1', 'sk-test');
  const deps = { store, secrets, provider, channel: channelStub, sleep: async () => {} };
  return { store, secrets, provider, deps };
}

async function seedSourceAgent(src: Awaited<ReturnType<typeof installation>>) {
  const { store, secrets, provider } = src;
  store.insertAgent({
    id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING',
    aiProfileId: 'p1', hostId: 'h1', persona: 'helps cook', sharedMemory: true,
    createdAt: 'now', updatedAt: 'now',
  });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'o', role: 'owner', status: 'active', channelUserId: '111' });
  store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'member-x', role: 'user', displayName: 'Gran', status: 'active', channelUserId: '222' });
  await secrets.put('chan/a1', 'bot-token-123');
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
  provider.stateStore.set(runtimeRef, Buffer.from('the-agents-memory'));
  return runtimeRef;
}

describe('agent export/import', () => {
  it('round-trips an agent to a second installation intact', async () => {
    const src = await installation();
    await seedSourceAgent(src);

    const { filename, data } = await exportAgent(src.deps, 'a1');
    expect(filename).toBe('kitchen.agentclaw');
    // export leaves the source stopped — one poller per bot token
    expect(src.store.getAgent('a1')!.state).toBe('STOPPED');

    const dst = await installation('owner-b');
    const agent = await importAgent(dst.deps, data, { ownerId: 'owner-b' });

    expect(agent.state).toBe('RUNNING');
    expect(agent.slug).toBe('kitchen');
    expect(agent.sharedMemory).toBe(true);
    // channel identity travelled, token stored under the new install's ref
    const chan = dst.store.getChannelForAgent(agent.id)!;
    expect(chan.accountId).toBe('kitchenbot');
    expect(await dst.secrets.get(chan.secretRef)).toBe('bot-token-123');
    // members travelled; owner seat re-assigned to the importer
    const members = dst.store.listMemberships(agent.id);
    expect(members.find((m) => m.role === 'owner')!.userId).toBe('owner-b');
    expect(members.find((m) => m.displayName === 'Gran')!.channelUserId).toBe('222');
    expect(dst.store.listAllowedChannelUserIds(agent.id).sort()).toEqual(['111', '222']);
    // the volume state was restored before start
    const state = dst.provider.stateStore.get(agent.runtimeRef!)!;
    expect(state.toString()).toBe('the-agents-memory');
  });

  it('refuses a second import of the same bot identity', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    const { data } = await exportAgent(src.deps, 'a1');

    const dst = await installation();
    await importAgent(dst.deps, data, { ownerId: 'o' });
    await expect(importAgent(dst.deps, data, { ownerId: 'o' })).rejects.toBeInstanceOf(TransferError);
  });

  it('imports again after the previous copy was deleted (tombstone slug freed)', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    const { data } = await exportAgent(src.deps, 'a1');

    const dst = await installation();
    const first = await importAgent(dst.deps, data, { ownerId: 'o' });
    dst.store.setAgentState(first.id, 'DELETING');
    dst.store.setAgentState(first.id, 'DELETED');

    const second = await importAgent(dst.deps, data, { ownerId: 'o' });
    expect(second.state).toBe('RUNNING');
    expect(second.slug).toBe('kitchen');
  });

  it('rejects garbage files', async () => {
    const dst = await installation();
    await expect(
      importAgent(dst.deps, Buffer.from('not an archive'), { ownerId: 'o' }),
    ).rejects.toBeInstanceOf(TransferError);
  });
});
