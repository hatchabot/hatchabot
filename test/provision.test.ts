import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildRuntimeSpec,
  provisionAgent,
  rebuildAgent,
  runProvisionSteps,
} from '../src/orchestrator/provision.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { ChannelSetupRequired } from '../src/channels/channel.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

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

/** Channel stub: succeeds by default; can park once; records releases. */
function stubChannel(opts: { parkFirst?: boolean } = {}) {
  let parked = opts.parkFirst ?? false;
  const released: string[] = [];
  let provisions = 0;
  const chan: ChannelProvisioner & { released: string[]; provisions: () => number } = {
    kind: 'telegram',
    key: 'stub',
    released,
    provisions: () => provisions,
    async provision(req) {
      if (parked) {
        parked = false;
        throw new ChannelSetupRequired('paste a token', req.agentId);
      }
      provisions++;
      return { accountId: 'stubbot', secretRef: 'chan/stub', deepLink: 'https://t.me/stubbot' };
    },
    async release(accountId) { released.push(accountId); },
  };
  return chan;
}

async function world(opts: { failOn?: 'provision' | 'start'; parkFirst?: boolean; hostKind?: string; profile?: Partial<{ kind: string; secretRef?: string; vendor: string }> } = {}) {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider(opts.failOn ? { failOn: opts.failOn } : {});
  const channel = stubChannel({ parkFirst: opts.parkFirst });
  store.insertHost({
    id: 'h1', ownerId: 'o', kind: (opts.hostKind ?? 'local') as any, provider: 'mock',
    name: 'box', settings: {}, createdAt: 'now',
  });
  store.insertAIProfile({
    id: 'p1', ownerId: 'o', name: 'AI',
    vendor: (opts.profile?.vendor ?? 'anthropic') as any,
    kind: (opts.profile?.kind ?? 'api_key') as any,
    model: 'claude-opus-4-8',
    secretRef: 'secretRef' in (opts.profile ?? {}) ? opts.profile!.secretRef : 'ai/p1',
    createdAt: 'now',
  });
  await secrets.put('ai/p1', 'sk-test');
  await secrets.put('chan/stub', 'bot-token');
  const deps = { store, secrets, provider, channel, sleep: async () => {} };
  return { store, secrets, provider, channel, deps };
}

const INPUT = { ownerId: 'o', name: 'Kitchen', aiProfileId: 'p1', hostId: 'h1' };

describe('runProvisionSteps', () => {
  it('rolls back the channel lease and runtime on start failure and lands FAILED', async () => {
    const w = await world({ failOn: 'start' });
    const { agent } = await provisionAgent(w.deps, INPUT);
    expect(agent.state).toBe('FAILED');
    expect(agent.stateReason).toBeTruthy();
    expect(w.channel.released).toEqual(['stubbot']);
    expect(w.store.getChannelForAgent(agent.id)).toBeUndefined();
  });

  it('parks on ChannelSetupRequired, then resumes and clears the pendingAction', async () => {
    const w = await world({ parkFirst: true });
    const first = await provisionAgent(w.deps, INPUT);
    expect(first.agent.state).toBe('PROVISIONING');
    expect(first.agent.pendingAction?.type).toBe('bot_token');
    expect(first.setupRequired?.instructions).toContain('token');

    const second = await runProvisionSteps(w.deps, first.agent.id);
    expect(second.agent.state).toBe('RUNNING');
    expect(second.agent.pendingAction).toBeFalsy();
  });

  it('retries from FAILED reusing the already-created channel row', async () => {
    const w = await world({ failOn: 'start' });
    const { agent } = await provisionAgent(w.deps, INPUT);
    expect(agent.state).toBe('FAILED');

    // "fix" the provider, retry: channel must be re-provisioned (it was rolled
    // back) but the flow completes to RUNNING.
    const healthy = new MockProvider();
    const again = await runProvisionSteps({ ...w.deps, provider: healthy }, agent.id);
    expect(again.agent.state).toBe('RUNNING');
    expect(w.store.getChannelForAgent(agent.id)?.accountId).toBe('stubbot');
  });
});

describe('rollback must not destroy existing memory', () => {
  it('does NOT purge the volume when a retry fails on an existing runtime', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const ref = w.store.getAgent(agent.id)!.runtimeRef!;

    // Retry against a provider that fails to start: the volume predates this
    // run, so rollback must leave it alone. Purging here destroyed months of
    // memory in the field.
    const broken = new MockProvider({ failOn: 'start' });
    broken.runtimes.set(ref, (w.provider as any).runtimes.get(ref));
    broken.stateStore.set(ref, Buffer.from('the-agents-memory'));
    // The real path: a live agent goes FAILED (e.g. reconcile after a reboot),
    // the owner taps Retry, and the retry's health check times out.
    w.store.setAgentState(agent.id, 'FAILED', 'runtime missing');
    await runProvisionSteps({ ...w.deps, provider: broken }, agent.id);

    expect(w.store.getAgent(agent.id)!.state).toBe('FAILED');
    expect(broken.runtimes.get(ref)!.purged).toBe(false);
    expect(broken.stateStore.get(ref)!.toString()).toBe('the-agents-memory');
  });

  it('DOES purge storage it created itself', async () => {
    const w = await world({ failOn: 'start' });
    const { agent } = await provisionAgent(w.deps, INPUT);
    expect(agent.state).toBe('FAILED');
    const rt = [...(w.provider as any).runtimes.values()][0] as any;
    expect(rt?.purged).toBe(true);
  });
});

describe('rebuildAgent', () => {
  it('walks RUNNING → REBUILDING → RUNNING reusing the same runtime ref', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const refBefore = w.store.getAgent(agent.id)!.runtimeRef;
    const rebuilt = await rebuildAgent(w.deps, agent.id);
    expect(rebuilt.state).toBe('RUNNING');
    expect(w.store.getAgent(agent.id)!.runtimeRef).toBe(refBefore);
  });

  it('lands FAILED (not stuck REBUILDING) when the container will not start', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const broken = new MockProvider({ failOn: 'start' });
    // carry over the runtime so previousRef resolves
    broken.runtimes.set(
      w.store.getAgent(agent.id)!.runtimeRef!,
      (w.provider as any).runtimes.get(w.store.getAgent(agent.id)!.runtimeRef!),
    );
    const rebuilt = await rebuildAgent({ ...w.deps, provider: broken }, agent.id);
    expect(rebuilt.state).toBe('FAILED');
    expect(rebuilt.stateReason).toBeTruthy();
  });

  it('rejects rebuild from non-rebuildable states', async () => {
    const w = await world({ parkFirst: true });
    const { agent } = await provisionAgent(w.deps, INPUT); // parked PROVISIONING
    w.store.setAgentRuntimeRef(agent.id, 'mock://x');
    await expect(rebuildAgent(w.deps, agent.id)).rejects.toThrow(/Cannot rebuild/);
  });
});

describe('buildRuntimeSpec', () => {
  it('api-key profile: key in env, no mounts, members seeded into allowFrom', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    w.store.insertMembership({
      id: 'm2', agentId: agent.id, userId: 'u2', role: 'user',
      channelUserId: '555', status: 'active',
    });
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(spec.hostMounts).toEqual([]);
    expect(spec.workspace.configPatch.telegram?.dmPolicy).toBe('pairing');
    expect(spec.workspace.configPatch.telegram?.allowFrom).toEqual(['555']);
  });

  it('subscription + stored token: CLAUDE_CODE_OAUTH_TOKEN env, no ~/.claude mount', async () => {
    const w = await world({ profile: { kind: 'subscription', secretRef: 'ai/p1' } });
    const { agent } = await provisionAgent(w.deps, INPUT);
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-test');
    expect(spec.hostMounts).toEqual([]);
    expect(spec.workspace.configPatch.setupToken).toBe('sk-test');
  });

  it('local vendor: no credential injected, no mount, ollama provider in the patch', async () => {
    const w = await world({ profile: { kind: 'api_key', vendor: 'local', secretRef: undefined } });
    (w.store as any).db
      .prepare('UPDATE ai_profiles SET base_url = ?, model = ? WHERE id = ?')
      .run('http://172.17.0.1:11434/v1', 'qwen3.6:27b-q8_0', 'p1');
    const { agent } = await provisionAgent(w.deps, INPUT);
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.env).toEqual({}); // nothing to inject
    expect(spec.hostMounts).toEqual([]); // no ~/.claude
    expect(spec.workspace.configPatch.provider).toBe('ollama');
    expect(spec.workspace.configPatch.baseUrl).toBe('http://172.17.0.1:11434/v1');
  });

  it('refuses a subscription profile on a non-local host (provision fails + rolls back)', async () => {
    const w = await world({ hostKind: 'gce', profile: { kind: 'subscription', secretRef: undefined } });
    const { agent } = await provisionAgent(w.deps, INPUT);
    expect(agent.state).toBe('FAILED');
    expect(w.channel.released).toEqual(['stubbot']); // lease not kept
  });

  it('allocates a stable gateway port/token across calls', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const s1 = await buildRuntimeSpec(w.deps, agent.id);
    const s2 = await buildRuntimeSpec(w.deps, agent.id);
    expect(s1.ports).toEqual([{ host: 19100, container: 18789 }]);
    expect(s2.ports).toEqual(s1.ports);
    expect(s1.workspace.configPatch.gatewayToken).toBe(s2.workspace.configPatch.gatewayToken);
  });
});

describe('store gateway/slug helpers', () => {
  it('ensureGatewayAccess increments ports and never reuses a deleted agent’s', async () => {
    const w = await world();
    const a = await provisionAgent(w.deps, INPUT);
    const b = await provisionAgent(w.deps, { ...INPUT, name: 'Second' });
    expect(w.store.ensureGatewayAccess(a.agent.id).port).toBe(19100);
    expect(w.store.ensureGatewayAccess(b.agent.id).port).toBe(19101);
    w.store.setAgentState(b.agent.id, 'DELETING');
    w.store.setAgentState(b.agent.id, 'DELETED');
    const c = await provisionAgent(w.deps, { ...INPUT, name: 'Third' });
    expect(w.store.ensureGatewayAccess(c.agent.id).port).toBe(19102);
  });

  it('releaseDeletedSlug renames only tombstones, never the live holder', async () => {
    const w = await world();
    const a = await provisionAgent(w.deps, INPUT);
    w.store.releaseDeletedSlug('o', 'kitchen');
    expect(w.store.getAgent(a.agent.id)!.slug).toBe('kitchen'); // live: untouched
    w.store.setAgentState(a.agent.id, 'DELETING');
    w.store.setAgentState(a.agent.id, 'DELETED');
    w.store.releaseDeletedSlug('o', 'kitchen');
    expect(w.store.getAgent(a.agent.id)!.slug).not.toBe('kitchen');
  });
});
