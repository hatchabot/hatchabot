import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildRuntimeSpec, createAgentRecord } from '../src/orchestrator/provision.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

/** A Slack or Discord row becomes config on the next build, when the image can carry it. */

class MemSecrets {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error(`no secret ${r}`); return v; }
  async delete(r: string) { this.map.delete(r); }
}

async function setup(imageChannels: string[] = ['slack', 'discord']) {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'sk-test');
  const provider = new MockProvider();
  provider.imageChannels = imageChannels;
  const deps = { store, secrets, provider, channel: {} as ChannelProvisioner, sleep: async () => {} };
  const agent = createAgentRecord(store, { ownerId: 'o', name: 'Tax', aiProfileId: 'p1', hostId: 'h1' });
  store.setAgentWebOnly(agent.id, true);
  await secrets.put(`channel/${agent.id}/slack`, JSON.stringify({ botToken: 'xoxb-1', appToken: 'xapp-1' }));
  store.insertChannel({ id: 'cs', agentId: agent.id, kind: 'slack', accountId: 'U0BOT', secretRef: `channel/${agent.id}/slack`, deepLink: 'x', createdAt: 'now',
    settings: { rooms: { mode: 'room', roomId: 'C012AB3CD' } } });
  store.bindMemberIdentity(agent.id, 'o', 'slack', 'U111');
  return { deps, agent, store, secrets };
}

describe('Slack and Discord at build time', () => {
  it('a Slack row becomes the slack slice, with members and the room', async () => {
    const { deps, agent } = await setup();
    const patch = (await buildRuntimeSpec(deps as never, agent.id)).workspace.configPatch;
    expect(patch.channelPlugins).toEqual(['slack', 'discord']);
    expect(patch.slack).toEqual({ botToken: 'xoxb-1', appToken: 'xapp-1', allowFrom: ['U111'], rooms: { mode: 'room', roomId: 'C012AB3CD' } });
    expect(patch.discord).toBeUndefined();
    expect(patch.telegram).toBeUndefined();
  });

  it('Discord takes its application id from the row and its token from the store', async () => {
    const { deps, agent, store, secrets } = await setup();
    await secrets.put(`channel/${agent.id}/discord`, 'tok');
    store.insertChannel({ id: 'cd', agentId: agent.id, kind: 'discord', accountId: '123', secretRef: `channel/${agent.id}/discord`, deepLink: 'x', createdAt: 'now' });
    const patch = (await buildRuntimeSpec(deps as never, agent.id)).workspace.configPatch;
    expect(patch.discord).toEqual({ token: 'tok', applicationId: '123', allowFrom: [], rooms: { mode: 'off' } });
  });

  it('an image without the plugin leaves the channel out instead of failing the build', async () => {
    const { deps, agent } = await setup([]);
    const patch = (await buildRuntimeSpec(deps as never, agent.id)).workspace.configPatch;
    expect(patch.slack).toBeUndefined();
    expect(patch.channelPlugins).toEqual([]);
  });
});
