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
    // A realistic cloud menu so per-agent pins to a listed model are honoured.
    models: ['claude-sonnet-5', 'claude-haiku-4-5'],
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

describe('one bot token, one runtime', () => {
  it('refuses to wire an agent to an identity another agent already holds', async () => {
    const w = await world();
    const first = await provisionAgent(w.deps, INPUT);
    expect(first.agent.state).toBe('RUNNING');
    expect(w.store.getChannelForAgent(first.agent.id)?.accountId).toBe('stubbot');

    // The stub hands out @stubbot again — which is what a rejected-but-still-
    // pending token does on a Retry. Two containers polling one token flip-flop
    // every message, so this has to fail rather than "work".
    const second = await provisionAgent(w.deps, { ...INPUT, name: 'Second' });
    expect(second.agent.state).toBe('FAILED');
    expect(second.agent.stateReason).toContain('Kitchen');
    expect(w.store.getChannelForAgent(second.agent.id)).toBeUndefined();

    // And the first agent is untouched: releasing @stubbot here would delete
    // the token that IS the first agent's identity.
    expect(w.channel.released).toEqual([]);
    expect(w.store.getAgent(first.agent.id)?.state).toBe('RUNNING');
    expect(w.store.getChannelForAgent(first.agent.id)?.accountId).toBe('stubbot');
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

  it('stops the replacement container when the health check gives up', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const ref = w.store.getAgent(agent.id)!.runtimeRef!;
    // A container that starts but never comes healthy — the way a slow or
    // wedged gateway actually fails. Without an explicit stop it would sit
    // there POLLING THE BOT while the card says FAILED, and reconcile has no
    // running+FAILED rule to ever mend that.
    const slow = new MockProvider({ healthyAfter: 100_000 });
    slow.runtimes.set(ref, (w.provider as any).runtimes.get(ref));
    const rebuilt = await rebuildAgent({ ...w.deps, provider: slow }, agent.id);
    expect(rebuilt.state).toBe('FAILED');
    expect(slow.runtimes.get(ref)!.phase).toBe('stopped');
  });

  it('keeps reporting the OLD model when a rebuild onto a new profile fails', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    expect(w.store.getAgent(agent.id)!.appliedModel).toBe('claude-opus-4-8');

    // Owner switches the profile, then the rebuild dies before the provider
    // accepts the new spec. Recording "applied" at spec-render time made the
    // card claim the new model while the old container kept running.
    w.store.insertAIProfile({
      id: 'p2', ownerId: 'o', name: 'AI2', vendor: 'anthropic', kind: 'api_key',
      model: 'claude-fable-5', secretRef: 'ai/p1', createdAt: 'now',
    });
    w.store.setAgentAIProfile(agent.id, 'p2');
    const broken = new MockProvider({ failOn: 'provision' });
    const rebuilt = await rebuildAgent({ ...w.deps, provider: broken }, agent.id);
    expect(rebuilt.state).toBe('FAILED');
    expect(w.store.getAgent(agent.id)!.appliedProfileId).toBe('p1');
    expect(w.store.getAgent(agent.id)!.appliedModel).toBe('claude-opus-4-8');
  });
});

describe('pairing happens once per person, not once per agent', () => {
  it("seeds a later agent's allowlist with the owner's already-bound Telegram id", async () => {
    const w = await world();
    // Agent #1: the first-contact claim bound the owner's Telegram identity.
    const first = await provisionAgent(w.deps, INPUT);
    w.store.bindMembershipChannelUser(first.agent.id, 'o', '1000000001');

    // Agent #2 must trust the same person from birth: id carried onto the
    // owner membership and into allowFrom — no "access not configured", no
    // pairing code, no second message.
    const second = await provisionAgent(w.deps, { ...INPUT, name: 'Second' });
    // (channel stub reuses @stubbot, so the clash guard fails this one — the
    // membership row is what we're testing, and it's created up front.)
    const owner = w.store.listMemberships(second.agent.id).find((m) => m.userId === 'o');
    expect(owner?.channelUserId).toBe('1000000001');
  });

  it('leaves the very first agent to the pairing claim (nothing known yet)', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const owner = w.store.listMemberships(agent.id).find((m) => m.userId === 'o');
    expect(owner?.channelUserId).toBeUndefined();
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

  it('data-source folders mount with per-source ro/rw access', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    w.store.insertDataSource({ id: 'd1', agentId: agent.id, kind: 'folder', access: 'ro', mountName: 'notes', hostPath: '/srv/notes', createdAt: 'now' });
    w.store.insertDataSource({ id: 'd2', agentId: agent.id, kind: 'folder', access: 'rw', mountName: 'work', hostPath: '/srv/work', createdAt: 'now' });
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    const mounts = (spec.hostMounts ?? []).filter((m) => m.target.startsWith('/data/'));
    expect(mounts).toContainEqual({ source: '/srv/notes', target: '/data/notes', readonly: true });
    expect(mounts).toContainEqual({ source: '/srv/work', target: '/data/work', readonly: false });
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

describe('per-agent model override', () => {
  it('cloud: buildRuntimeSpec runs the override, applied model records it', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, { ...INPUT, model: 'claude-sonnet-5' });
    expect(agent.model).toBe('claude-sonnet-5');
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.workspace.configPatch.model).toBe('claude-sonnet-5');
    // recordApplied stamps the model the runtime actually used.
    await runProvisionSteps(w.deps, agent.id);
    expect(w.store.getAgent(agent.id)!.appliedModel).toBe('claude-sonnet-5');
  });

  it('cloud: no override follows the profile default', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    expect(agent.model).toBeUndefined();
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.workspace.configPatch.model).toBe('claude-opus-4-8');
  });

  it('local: the override is dropped — local agents follow the source’s one model', async () => {
    const w = await world({ profile: { kind: 'api_key', vendor: 'local', secretRef: undefined } });
    (w.store as any).db
      .prepare('UPDATE ai_profiles SET base_url = ?, model = ? WHERE id = ?')
      .run('http://172.17.0.1:11434/v1', 'qwen3.6:27b-q8_0', 'p1');
    // Ask for an override anyway: createAgentRecord must refuse to store it.
    const { agent } = await provisionAgent(w.deps, { ...INPUT, model: 'claude-sonnet-5' });
    expect(agent.model).toBeUndefined();
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.workspace.configPatch.model).toBe('qwen3.6:27b-q8_0');
  });

  it('setAgentModel round-trips and clears back to null', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    w.store.setAgentModel(agent.id, 'claude-sonnet-5');
    expect(w.store.getAgent(agent.id)!.model).toBe('claude-sonnet-5');
    w.store.setAgentModel(agent.id, null);
    expect(w.store.getAgent(agent.id)!.model).toBeUndefined();
  });

  it('a pin dropped from the source menu later never reaches the runtime', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, { ...INPUT, model: 'claude-sonnet-5' });
    expect((await buildRuntimeSpec(w.deps, agent.id)).workspace.configPatch.model)
      .toBe('claude-sonnet-5');
    // Owner edits the source and drops claude-sonnet-5 from the menu. The pin
    // is now stale — effectiveModel must fall back to the default rather than
    // write a model the source can no longer serve.
    w.store.setAIProfileModels('p1', ['claude-haiku-4-5']);
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.workspace.configPatch.model).toBe('claude-opus-4-8');
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
