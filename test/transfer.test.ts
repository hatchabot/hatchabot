import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { gzipSync, gunzipSync } from 'node:zlib';
import { exportAgent, importAgent, peekFormat, TransferError } from '../src/orchestrator/transfer.js';
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

describe('an imported bot token is checked (2026-09-25)', () => {
  it('the app\'s verifier must accept it and name the same bot; a file naming someone else\'s bot is refused and nothing is left behind', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    const { data } = await exportAgent(src.deps, 'a1');
    const dst = await installation('importer');
    await expect(importAgent(dst.deps, data, { ownerId: 'importer', verifyToken: async () => 'someone_elses_bot' })).rejects.toThrow(/belongs to @someone_elses_bot, not @kitchenbot/);
    expect(dst.store.listAllActiveAgents()).toHaveLength(0);
    await expect(importAgent(dst.deps, data, { ownerId: 'importer', verifyToken: async () => { throw new Error('401'); } })).rejects.toThrow(/Telegram rejected the bot token/);
    const seen: string[] = [];
    const agent = await importAgent(dst.deps, data, { ownerId: 'importer', verifyToken: async (t) => { seen.push(t); return 'KitchenBot'; } }); // case-insensitive, as Telegram is
    expect(seen).toEqual(['bot-token-123']);
    expect(dst.store.getChannelForAgent(agent.id)?.accountId).toBe('kitchenbot');
  });
});

describe('export failure handling', () => {
  it('restarts a running agent if the snapshot fails after quiescing', async () => {
    const src = await installation();
    const ref = await seedSourceAgent(src);
    src.provider.exportState = async () => { throw new Error('docker exploded'); };
    await expect(exportAgent(src.deps, 'a1')).rejects.toThrow(/docker exploded/);
    // Not stranded STOPPED: a plain export must leave a running agent running.
    expect(src.store.getAgent('a1')!.state).toBe('RUNNING');
    expect(src.provider.runtimes.get(ref)!.phase).toBe('running');
  });

  it('refuses an over-large agent with a clear message, and restarts it', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    // Fake a huge volume without allocating it: the size guard reads .length
    // and throws before touching the bytes.
    src.provider.exportState = async () => ({ length: 200 * 1024 * 1024 } as any);
    await expect(exportAgent(src.deps, 'a1')).rejects.toThrow(/too large to move/);
    expect(src.store.getAgent('a1')!.state).toBe('RUNNING');
  });
});

describe('env vars travel (audit backlog #1 → fixed)', () => {
  it('export carries name+value; import recreates rows and secrets before provisioning', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    await src.secrets.put('agent-env/e1', 'super-secret');
    src.store.insertAgentEnv({ id: 'e1', agentId: 'a1', name: 'BRAVE_API_KEY', secretRef: 'agent-env/e1', createdAt: 'now' });

    const { data } = await exportAgent(src.deps, 'a1');
    const dst = await installation('importer');
    const agent = await importAgent(dst.deps, data, { ownerId: 'importer' });

    const envs = dst.store.listAgentEnv(agent.id);
    expect(envs.map((e) => e.name)).toEqual(['BRAVE_API_KEY']);
    await expect(dst.secrets.get(envs[0]!.secretRef)).resolves.toBe('super-secret');
  });

  it('a missing env secret fails the export loudly (and restarts the agent) instead of shipping a broken archive', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    // Row exists, secret does not — the silently-broken shape.
    src.store.insertAgentEnv({ id: 'e1', agentId: 'a1', name: 'BRAVE_API_KEY', secretRef: 'agent-env/gone', createdAt: 'now' });
    await expect(exportAgent(src.deps, 'a1')).rejects.toThrow(/BRAVE_API_KEY/);
    expect(src.store.getAgent('a1')!.state).toBe('RUNNING');
  });

  it('a crafted archive cannot smuggle a reserved env var past the route policy', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    const { data } = await exportAgent(src.deps, 'a1');
    const manifest = JSON.parse(require('node:zlib').gunzipSync(data).toString('utf8'));
    manifest.envVars = [{ name: 'HTTPS_PROXY', value: 'http://evil.example' }];
    const tampered = require('node:zlib').gzipSync(Buffer.from(JSON.stringify(manifest)));
    const dst = await installation('importer');
    await expect(importAgent(dst.deps, tampered, { ownerId: 'importer' })).rejects.toThrow(/HTTPS_PROXY/);
    // rolled back — no half-made agent holds the slug
    expect(dst.store.listAllActiveAgents()).toHaveLength(0);
  });
});

describe('agent export/import', () => {
  it('round-trips an agent to a second installation intact', async () => {
    const src = await installation();
    await seedSourceAgent(src);

    const { filename, data } = await exportAgent(src.deps, 'a1');
    expect(filename).toBe('kitchen.hatchabot');
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
    const owner = members.find((m) => m.role === 'owner')!;
    expect(owner.userId).toBe('owner-b');
    // ...but the PREVIOUS owner's telegram id does NOT travel onto the new
    // owner seat — the importer is a different person and must claim first
    // contact. Carrying it would admit that stranger and poison pair-once.
    expect(owner.channelUserId).toBeUndefined();
    expect(members.find((m) => m.displayName === 'Gran')!.channelUserId).toBe('222');
    // Only the non-owner member's id seeds the allowlist; the owner re-claims.
    expect(dst.store.listAllowedChannelUserIds(agent.id).sort()).toEqual(['222']);
    // the volume state was restored before start
    const state = dst.provider.stateStore.get(agent.runtimeRef!)!;
    expect(state.toString()).toBe('the-agents-memory');
  });

  it('carries a per-agent model override when the destination source offers it', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    src.store.setAgentModel('a1', 'claude-sonnet-5');
    const { data } = await exportAgent(src.deps, 'a1');

    const dst = await installation('owner-b');
    // Destination source lists that model on its menu → the pin survives.
    (dst.store as any).db
      .prepare(`UPDATE ai_profiles SET models = ? WHERE id = 'p1'`)
      .run(JSON.stringify(['claude-sonnet-5']));
    const agent = await importAgent(dst.deps, data, { ownerId: 'owner-b' });
    expect(agent.model).toBe('claude-sonnet-5');
  });

  it('drops the override when the destination source cannot serve it', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    src.store.setAgentModel('a1', 'claude-sonnet-5');
    const { data } = await exportAgent(src.deps, 'a1');

    // Destination source only offers its default (claude-opus-4-8), so the
    // pin is dropped back to the default rather than left dangling.
    const dst = await installation('owner-b');
    const agent = await importAgent(dst.deps, data, { ownerId: 'owner-b' });
    expect(agent.model).toBeUndefined();
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

  it('rolls back a failed import completely, and a re-import succeeds', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    const { data } = await exportAgent(src.deps, 'a1');

    const dst = await installation();
    const broken = new MockProvider({ failOn: 'start' });
    await expect(
      importAgent({ ...dst.deps, provider: broken }, data, { ownerId: 'o' }),
    ).rejects.toBeInstanceOf(TransferError);
    // nothing half-imported left behind
    expect(dst.store.listAllActiveAgents()).toHaveLength(0);
    expect(dst.store.findAgentUsingAccount('kitchenbot')).toBeUndefined();

    // fix the cause (healthy provider) → the one true retry path works
    const again = await importAgent(dst.deps, data, { ownerId: 'o' });
    expect(again.state).toBe('RUNNING');
  });

  describe('untrusted archive validation', () => {
    async function archiveWith(mutate: (m: any) => void): Promise<Buffer> {
      const src = await installation();
      await seedSourceAgent(src);
      const { data } = await exportAgent(src.deps, 'a1');
      const m = JSON.parse(gunzipSync(data).toString('utf8'));
      mutate(m);
      return gzipSync(Buffer.from(JSON.stringify(m), 'utf8'));
    }

    it('rejects a deepLink that is not a Telegram link (javascript: XSS)', async () => {
      // It reaches an href="" in the app; esc() stops attribute breakout but
      // not the SCHEME, so an imported archive could run script on click.
      const data = await archiveWith((m) => { m.channel.deepLink = "javascript:alert(document.domain)"; });
      const dst = await installation();
      await expect(importAgent(dst.deps, data, { ownerId: 'o' })).rejects.toBeInstanceOf(TransferError);
    });

    it('derives the deepLink from the verified accountId, ignoring the archive', async () => {
      // Even a well-formed t.me link is not trusted verbatim.
      const data = await archiveWith((m) => { m.channel.deepLink = 'https://t.me/someone-elses-bot'; });
      const dst = await installation();
      const agent = await importAgent(dst.deps, data, { ownerId: 'o' });
      expect(dst.store.getChannelForAgent(agent.id)!.deepLink).toBe('https://t.me/kitchenbot');
    });

    it('rejects a slug carrying shell metacharacters', async () => {
      const data = await archiveWith((m) => { m.agent.slug = 'kitchen$(touch /tmp/pwned)'; });
      const dst = await installation();
      await expect(importAgent(dst.deps, data, { ownerId: 'o' })).rejects.toBeInstanceOf(TransferError);
      expect(dst.store.listAllActiveAgents()).toHaveLength(0);
    });

    it('rejects a slug with path traversal', async () => {
      const data = await archiveWith((m) => { m.agent.slug = '../../etc/evil'; });
      const dst = await installation();
      await expect(importAgent(dst.deps, data, { ownerId: 'o' })).rejects.toBeInstanceOf(TransferError);
    });

    it('rejects a non-numeric channelUserId (it reaches a shell on revoke)', async () => {
      const data = await archiveWith((m) => { m.memberships[0].channelUserId = "1'; rm -rf /"; });
      const dst = await installation();
      await expect(importAgent(dst.deps, data, { ownerId: 'o' })).rejects.toBeInstanceOf(TransferError);
    });

    it('rejects a malformed manifest without stranding a half-made agent', async () => {
      const data = await archiveWith((m) => { m.memberships = 'not-an-array'; });
      const dst = await installation();
      await expect(importAgent(dst.deps, data, { ownerId: 'o' })).rejects.toBeInstanceOf(TransferError);
      expect(dst.store.listAllActiveAgents()).toHaveLength(0);
      expect(dst.store.findAgentUsingAccount('kitchenbot')).toBeUndefined();
    });

    it('keeps the importer as OWNER even if a same-id user row is listed first', async () => {
      // A `user` member whose id equals the importer, placed BEFORE the owner
      // row in the manifest. Owner-first ordering must ensure the importer
      // gets the owner seat, not a revocable user membership.
      const data = await archiveWith((m) => {
        m.memberships = [
          { userId: 'importer', role: 'user', channelUserId: '333', status: 'active' },
          { userId: 'o', role: 'owner', channelUserId: '111', status: 'active' },
        ];
      });
      const dst = await installation('importer'); // importer's own host + AI profile
      const agent = await importAgent(dst.deps, data, { ownerId: 'importer' });
      const members = dst.store.listMemberships(agent.id);
      expect(members.find((x) => x.userId === 'importer')!.role).toBe('owner');
      // and only one row for the importer (the dup was skipped)
      expect(members.filter((x) => x.userId === 'importer')).toHaveLength(1);
    });
  });

  it('restores state the runtime user can actually read', async () => {
    // Regression: hardening the extraction with --no-same-owner left every
    // file root-owned, so the agent (uid 1000) got EACCES on openclaw.json
    // and EVERY import failed. The provider must hand back readable state.
    const src = await installation();
    await seedSourceAgent(src);
    const { data } = await exportAgent(src.deps, 'a1');
    const dst = await installation();
    const agent = await importAgent(dst.deps, data, { ownerId: 'o' });
    expect(agent.state).toBe('RUNNING');
    expect(dst.provider.stateStore.get(agent.runtimeRef!)!.toString()).toBe('the-agents-memory');
  });

  it('rejects garbage files', async () => {
    const dst = await installation();
    await expect(
      importAgent(dst.deps, Buffer.from('not an archive'), { ownerId: 'o' }),
    ).rejects.toBeInstanceOf(TransferError);
  });
});

describe('peekFormat — the one-Import router', () => {
  it('reads the format tag off a full export so it routes to a restore', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    const { data } = await exportAgent(src.deps, 'a1');
    expect(peekFormat(data)).toBe('hatchabot-export');
  });

  it('returns undefined for anything it cannot read, so a template/garbage never restores', () => {
    expect(peekFormat(Buffer.from('not an archive'))).toBeUndefined();
    expect(peekFormat(gzipSync(Buffer.from('{}')))).toBeUndefined();
    expect(peekFormat(gzipSync(Buffer.from(JSON.stringify({ format: 'hatchabot-template' }))))).toBe(
      'hatchabot-template',
    );
  });
});

describe('web-only agents (no Telegram bot)', () => {
  it('export and import round-trip without a bot, and come back web-only', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    src.store.deleteChannelForAgent('a1');
    src.store.setAgentWebOnly('a1', true);
    const { data } = await exportAgent(src.deps, 'a1');
    const dst = await installation('importer');
    const agent = await importAgent(dst.deps, data, { ownerId: 'importer' });
    expect(dst.store.getAgent(agent.id)?.webOnly).toBe(true);
    expect(dst.store.getChannelForAgent(agent.id)).toBeUndefined();
  });

  it('an agent that should have a bot but lost it still refuses to export', async () => {
    const src = await installation();
    await seedSourceAgent(src);
    src.store.deleteChannelForAgent('a1');
    await expect(exportAgent(src.deps, 'a1')).rejects.toThrow(/no messaging channel/);
  });
});
