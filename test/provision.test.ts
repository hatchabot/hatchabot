import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  buildRuntimeSpec,
  checkpointMemory,
  provisionAgent,
  rebuildAgent,
  runProvisionSteps,
} from '../src/orchestrator/provision.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { dataSourcesSection, memoryPolicySection, operatorSection, replaceSection, DATA_SOURCES_HEADING, OPERATOR_HEADING } from '../src/openclaw/workspace.js';
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

  it('takes the pre-rebuild snapshot BEFORE stopping/replacing the container', async () => {
    // The snapshot moved out of the route into the task; it must still run
    // while the agent is RUNNING and before the old container is torn down —
    // otherwise the "insurance" copy captures nothing.
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    // Make the container's core files readable so the capture actually stores.
    (w.provider as any).execResponses.set('sh', { code: 0, stdout: '# Memory\n- soup\n', stderr: '' });
    // Snapshot count observed at the instant the old container is stopped.
    let snapsAtStop = -1;
    const origStop = w.provider.stop.bind(w.provider);
    (w.provider as any).stop = async (ref: string) => {
      snapsAtStop = w.store.listSnapshots(agent.id).length;
      return origStop(ref);
    };

    await rebuildAgent(w.deps, agent.id);

    const snaps = w.store.listSnapshots(agent.id);
    expect(snaps.some((s) => s.reason === 'pre-rebuild')).toBe(true);
    expect(snapsAtStop).toBe(1); // captured before the stop, not after
  });

  it('rebuilds a STOPPED agent without trying to snapshot it', async () => {
    // A STOPPED agent can't be read, so no snapshot is attempted — and the
    // rebuild must still succeed rather than choke on a failed capture.
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    await w.provider.stop(w.store.getAgent(agent.id)!.runtimeRef!);
    w.store.setAgentState(agent.id, 'STOPPED');
    const rebuilt = await rebuildAgent(w.deps, agent.id);
    expect(rebuilt.state).toBe('RUNNING');
    expect(w.store.listSnapshots(agent.id)).toHaveLength(0);
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
    // Nothing credential-like to inject — only orientation (host name) and
    // the volume-resident gog home (a PATH, not a credential).
    expect(spec.env).toEqual({
      AGENTCLAW_HOST_NAME: expect.any(String),
      GOG_HOME: '/home/node/.openclaw/connections/gog',
      // $HOME is the persistent volume, so the user-install locations are on
      // PATH for every process — that's what makes a tool the agent installs
      // for itself survive a rebuild AND stay runnable by name.
      PATH: expect.stringContaining('/home/node/.local/bin'),
      NPM_CONFIG_PREFIX: '/home/node/.npm-global',
    });
    expect(spec.hostMounts).toEqual([]); // no ~/.claude
    expect(spec.workspace.configPatch.provider).toBe('ollama');
    expect(spec.workspace.configPatch.baseUrl).toBe('http://172.17.0.1:11434/v1');
  });

  it('refuses a machine-login subscription profile on a non-local host (provision fails + rolls back)', async () => {
    const w = await world({ hostKind: 'gce', profile: { kind: 'subscription', secretRef: undefined } });
    const { agent } = await provisionAgent(w.deps, INPUT);
    expect(agent.state).toBe('FAILED');
    expect(w.channel.released).toEqual(['stubbot']); // lease not kept
  });

  it('tells the agent where it runs: container hostname + AGENTCLAW_HOST_NAME', async () => {
    // On a non-local host the label is the host row's name; a Move re-renders
    // the spec, so the answer stays true as the agent hops machines.
    const w = await world({ hostKind: 'cloud' });
    const { agent } = await provisionAgent(w.deps, INPUT);
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.env.AGENTCLAW_HOST_NAME).toBe('box');
    expect(spec.hostname).toBe(`${agent.slug}.box`);
  });

  it('injects the fleet media key (voice transcription) unless the profile supplies its own', async () => {
    const w = await world();
    await w.secrets.put('media/gemini-api-key', 'gm-fleet');
    const { agent } = await provisionAgent(w.deps, INPUT);
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.env.GEMINI_API_KEY).toBe('gm-fleet');

    // A google-vendor profile's own key must win over the fleet media key.
    const w2 = await world({ profile: { vendor: 'google' } });
    await w2.secrets.put('media/gemini-api-key', 'gm-fleet');
    const r2 = await provisionAgent(w2.deps, INPUT);
    const spec2 = await buildRuntimeSpec(w2.deps, r2.agent.id);
    expect(spec2.env.GEMINI_API_KEY).toBe('sk-test'); // the profile's key
  });

  it('seeds the gog skill so every agent can teach its owner the connect flow', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.workspace.files['skills/gog/SKILL.md']).toContain('--remote --step 1');
    expect(spec.env.GOG_HOME).toBe('/home/node/.openclaw/connections/gog');
  });

  it('allows a setup-token subscription on a runner: token injected, no mount', async () => {
    // A `claude setup-token` (secretRef present) is pure data — it rides to any
    // host, so Claude Max works on a runner where the machine login can't reach.
    const w = await world({ hostKind: 'cloud', profile: { kind: 'subscription', secretRef: 'ai/p1' } });
    const { agent } = await provisionAgent(w.deps, INPUT);
    expect(agent.state).not.toBe('FAILED');
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-test');
    expect(spec.hostMounts).toEqual([]); // no ~/.claude mount to leave behind
    expect(spec.workspace.configPatch.setupToken).toBe('sk-test');
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

  it('a mount-at-host-path folder binds at its ORIGINAL path (adopted agents)', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    w.store.insertDataSource({ id: 'd1', agentId: agent.id, kind: 'folder', access: 'ro', mountName: 'srv-data', hostPath: '/srv/data', mountAtHostPath: true, createdAt: 'now' });
    const spec = await buildRuntimeSpec(w.deps, agent.id);
    // bound at the source path so the agent's existing references resolve…
    expect(spec.hostMounts).toContainEqual({ source: '/srv/data', target: '/srv/data', readonly: true });
    // …and NOT remapped under /data/<name>
    expect((spec.hostMounts ?? []).some((m) => m.target === '/data/srv-data')).toBe(false);
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

describe('per-agent env injection', () => {
  it('injects env vars, and managed AI creds always win over a same-named var', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    w.store.insertAgentEnv({ id: 'e1', agentId: agent.id, name: 'MARKETDATA_API_KEY', secretRef: 'agent-env/e1', createdAt: 'now' });
    await w.secrets.put('agent-env/e1', 'mk-123');
    // Directly insert a var that shadows the AI key (the API refuses this name,
    // but the merge order must protect the agent even if one slips in).
    w.store.insertAgentEnv({ id: 'e2', agentId: agent.id, name: 'ANTHROPIC_API_KEY', secretRef: 'agent-env/e2', createdAt: 'now' });
    await w.secrets.put('agent-env/e2', 'HIJACK');

    const spec = await buildRuntimeSpec(w.deps, agent.id);
    expect(spec.env.MARKETDATA_API_KEY).toBe('mk-123');
    expect(spec.env.ANTHROPIC_API_KEY).toBe('sk-test'); // profile creds, not HIJACK
  });
});

describe('AGENTS.md "## Data sources" stays in step with reality', () => {
  /** The base64 payload written to ONE file, decoded. The install-conventions
   *  sync writes TOOLS.md on the same path, so "the last write" is ambiguous —
   *  select by filename. */
  const written = (p: MockProvider, file = 'AGENTS.md') => {
    const w = p.execLog
      .filter((a) => a[0] === 'sh')
      .map((a) => a[1]!)
      .filter((x) => x.includes('base64 -d') && x.includes(file))
      .at(-1);
    const m = w && /echo "([A-Za-z0-9+/=]+)"/.exec(w);
    return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : undefined;
  };

  async function withRepo(doc: string) {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    w.store.insertDataSource({
      id: 'ds1', agentId: agent.id, kind: 'git', access: 'rw', mountName: 'notes',
      repoUrl: 'git@github.com:me/notes.git', createdAt: 'now',
    });
    // Every execShell (the read AND the write) returns this doc; the read is
    // what matters, and a code-0 write is what the sync expects.
    (w.provider as MockProvider).execResponses.set('sh', { code: 0, stdout: doc, stderr: '' });
    await rebuildAgent(w.deps, agent.id);
    return w;
  }

  it('writes the section back with each source at its real in-container path', async () => {
    const w = await withRepo('# Kitchen\n\n## Memory policy\n- shared\n');
    const out = written(w.provider as MockProvider)!;
    expect(out).toBeDefined();
    expect(out).toContain('/home/node/.openclaw/notes');   // the real path
    expect(out).toContain('you may read and write');        // its access
    expect(out).toContain('## Memory policy');              // user's file preserved
  });

  it("does not truncate content the user added below the section", async () => {
    // The bug this guards: the tail was dropped whenever no `## ` followed.
    const doc = '# K\n\n## Data sources\n- stale\n\nMy rules:\n- always CC me\n\n### Escalation\nCall me.\n';
    const w = await withRepo(doc);
    const out = written(w.provider as MockProvider)!;
    expect(out).toContain('### Escalation');
    expect(out).toContain('Call me.');
    expect(out).toContain('/home/node/.openclaw/notes');
    expect(out).not.toContain('- stale');
  });

  it('writes nothing when the section is already current (no churn on rebuild)', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    // Both managed sections already current → the single AGENTS.md sync writes
    // nothing. Build the doc as the sync's FIXED POINT: applying both section
    // replacements twice (the second pass settles the blank-line the first
    // append leaves before the following heading), so the sync then no-ops.
    const shared = w.store.getAgent(agent.id)!.sharedMemory;
    const applyBoth = (doc: string) => {
      let n = replaceSection(doc, DATA_SOURCES_HEADING, dataSourcesSection([]));
      n = replaceSection(n, '## Memory policy', memoryPolicySection(shared));
      return replaceSection(n, OPERATOR_HEADING, operatorSection(w.store.getOperatorProfile(agent.ownerId)));
    };
    const current = applyBoth(applyBoth('# K\n'));
    (w.provider as MockProvider).execResponses.set('sh', { code: 0, stdout: current, stderr: '' });
    (w.provider as MockProvider).execLog.length = 0;
    await rebuildAgent(w.deps, agent.id);
    expect(written(w.provider as MockProvider)).toBeUndefined(); // read, then stop
  });
});

describe('a git source that will not clone is visible, not just logged', () => {
  const addRepo = (w: any, agentId: string) => w.store.insertDataSource({
    id: 'ds1', agentId, kind: 'git', access: 'ro', mountName: 'agentclaw-ai',
    repoUrl: 'git@github.com:me/agentclaw-ai.git', secretRef: 'ds/ds1', createdAt: 'now',
  });

  it('records WHY on the source, in the owner\'s terms — and clears it on success', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    await w.secrets.put('ds/ds1', 'PRIVATE-KEY');
    addRepo(w, agent.id);

    // The real-world failure: the deploy key isn't on the repo yet.
    (w.provider as MockProvider).execResponses.set('sh', {
      code: 128, stdout: '',
      stderr: "Cloning into '/home/node/.openclaw/agentclaw-ai'...\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n",
    });
    await rebuildAgent(w.deps, agent.id);
    const failed = w.store.getDataSource(agent.id, 'ds1')!;
    expect(failed.syncError).toMatch(/deploy key/i);
    expect(failed.syncedAt).toBeTruthy();

    // Once the key is added, the next rebuild clears the warning.
    (w.provider as MockProvider).execResponses.delete('sh');
    await rebuildAgent(w.deps, agent.id);
    expect(w.store.getDataSource(agent.id, 'ds1')!.syncError).toBeUndefined();
  });

  it('surfaces the failure through the API so the card can show it', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    await w.secrets.put('ds/ds1', 'PRIVATE-KEY');
    addRepo(w, agent.id);
    (w.provider as MockProvider).execResponses.set('sh', { code: 128, stdout: '', stderr: 'ERROR: Repository not found.' });
    await rebuildAgent(w.deps, agent.id);
    expect(w.store.getDataSource(agent.id, 'ds1')!.syncError).toMatch(/wasn't found/i);
  });
});

describe('TOOLS.md carries the install conventions', () => {
  const written = (p: MockProvider, file: string) => {
    const w = p.execLog
      .filter((a) => a[0] === 'sh')
      .map((a) => a[1]!)
      .filter((x) => x.includes('base64 -d') && x.includes(file))
      .at(-1);
    const m = w && /echo "([A-Za-z0-9+/=]+)"/.exec(w);
    return m ? Buffer.from(m[1]!, 'base64').toString('utf8') : undefined;
  };

  it('creates TOOLS.md with the managed section when OpenClaw has not seeded it yet', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    void agent;
    const out = written(w.provider as MockProvider, 'TOOLS.md')!;
    expect(out).toBeDefined();
    expect(out).toContain('## Installing tools (managed by AgentClaw)');
    expect(out).toContain('pip install --target ~/.openclaw/pylibs');
    expect(out).toContain('on-rebuild.sh');
  });

  it('adds the section to an existing TOOLS.md without touching the agent\'s notes', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const doc = '# TOOLS.md - Local Notes\n\n### SSH\n\n- home-server -> 192.168.1.100\n';
    (w.provider as MockProvider).execResponses.set('sh', { code: 0, stdout: doc, stderr: '' });
    await rebuildAgent(w.deps, agent.id);
    const out = written(w.provider as MockProvider, 'TOOLS.md')!;
    expect(out).toContain('home-server -> 192.168.1.100'); // the agent's own notes
    expect(out).toContain('~/.local/bin');
  });
});

describe('a pinned runtime image reaches docker', () => {
  it('provisions and rebuilds on the agent\'s own image, not the fleet default', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    w.store.setAgentImage(agent.id, 'agentclaw-runtime:candidate-x');
    await rebuildAgent(w.deps, agent.id);
    const spec = (w.provider as MockProvider).lastSpec!;
    expect(spec.image).toBe('agentclaw-runtime:candidate-x');
  });

  it('an unpinned agent leaves the image to the provider default', async () => {
    const w = await world();
    await provisionAgent(w.deps, INPUT);
    expect((w.provider as MockProvider).lastSpec!.image).toBeUndefined();
  });
});

describe('memory checkpoint before a source-switch rebuild', () => {
  it('runs the summary turn on the old container before it is replaced', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const provider = w.provider as MockProvider;
    provider.execLog.length = 0;
    await rebuildAgent({ ...w.deps, checkpointMemory: true }, agent.id);
    // The checkpoint is an `openclaw agent -m <prompt>` exec naming the agent.
    const turn = provider.execLog.find((a) => a[0] === 'agent' && a.includes('-m'));
    expect(turn).toBeDefined();
    expect(turn!.join(' ')).toContain(agent.slug);
    expect(turn!.join(' ')).toMatch(/memory|MEMORY\.md/i);
  });

  it('does NOT run a checkpoint on an ordinary rebuild', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const provider = w.provider as MockProvider;
    provider.execLog.length = 0;
    await rebuildAgent(w.deps, agent.id); // no checkpointMemory
    expect(provider.execLog.some((a) => a[0] === 'agent' && a.includes('-m'))).toBe(false);
  });

  it('a failed checkpoint never blocks the rebuild', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const provider = w.provider as MockProvider;
    // Make the agent turn throw; the rebuild must still complete.
    const realExec = provider.exec.bind(provider);
    provider.exec = (async (ref: string, argv: string[]) => {
      if (argv[0] === 'agent' && argv.includes('-m')) throw new Error('model unreachable');
      return realExec(ref, argv);
    }) as any;
    const out = await rebuildAgent({ ...w.deps, checkpointMemory: true }, agent.id);
    expect(out.state).toBe('RUNNING');
  });
});

describe('checkpointMemory prompt is neutral (no false "about to reset")', () => {
  it('asks to save durable facts without claiming an imminent reset', async () => {
    const w = await world();
    const { agent } = await provisionAgent(w.deps, INPUT);
    const provider = w.provider as MockProvider;
    provider.execLog.length = 0;
    await checkpointMemory(provider, agent.runtimeRef!, agent.slug, () => {});
    const turn = provider.execLog.find((a) => a[0] === 'agent' && a.includes('-m'));
    const prompt = turn![turn!.indexOf('-m') + 1]!;
    expect(prompt).toMatch(/memory/i);
    expect(prompt).not.toMatch(/about to be reset/i); // honest for standalone use
  });
});
