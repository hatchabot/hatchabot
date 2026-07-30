import { randomUUID } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { RuntimeProvider, RuntimeSpec } from '../providers/provider.js';
import { ProviderError } from '../providers/provider.js';
import type { ChannelProvisioner } from '../channels/channel.js';
import { ChannelSetupRequired } from '../channels/channel.js';
import { buildWorkspaceSeed } from '../openclaw/workspace.js';
import type { Agent } from '../domain/types.js';

export interface CreateAgentInput {
  ownerId: string;
  name: string;
  persona?: string;
  aiProfileId: string;
  hostId: string;
  sharedMemory?: boolean;
}

export interface ProvisionDeps {
  store: Store;
  secrets: SecretStore;
  provider: RuntimeProvider;
  channel: ChannelProvisioner;
  /** Injected so tests don't sleep. */
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface ProvisionResult {
  agent: Agent;
  deepLink?: string;
  /** Set when the channel needs a human step before we can continue. */
  setupRequired?: { instructions: string; resumeToken: string };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Step 2 of §11.1: create the agent record and return fast, so the app can
 * render a live progress card while runProvisionSteps() does the slow work.
 */
export function createAgentRecord(store: Store, input: CreateAgentInput): Agent {
  const profile = store.getAIProfile(input.aiProfileId);
  if (!profile) throw new Error(`No such AI profile: ${input.aiProfileId}`);
  const host = store.getHost(input.hostId);
  if (!host) throw new Error(`No such host: ${input.hostId}`);

  const now = new Date().toISOString();
  const agent: Agent = {
    id: randomUUID(),
    ownerId: input.ownerId,
    name: input.name,
    slug: slugify(input.name),
    state: 'PROVISIONING',
    aiProfileId: profile.id,
    hostId: host.id,
    persona: input.persona ?? '',
    // Shared by default: a multi-member agent with a single MEMORY.md is only
    // honest when everyone knows memory is common. Private is the opt-out for
    // a strictly personal agent.
    sharedMemory: input.sharedMemory ?? true,
    createdAt: now,
    updatedAt: now,
  };
  store.insertAgent(agent);

  // Owner is a member from the start — the allowlist has to contain somebody.
  store.insertMembership({
    id: randomUUID(),
    agentId: agent.id,
    userId: input.ownerId,
    role: 'owner',
    status: 'active',
    joinedAt: now,
  });

  return agent;
}

/**
 * Steps 3–8 of §11.1, resumable. Safe to call again after a crash, a FAILED
 * state (retry), or a parked human step (bot token arrived): every step is
 * idempotent, and on hard failure everything created in this run is rolled
 * back so nothing keeps billing or stays leased (§11.3).
 */
export async function runProvisionSteps(
  deps: ProvisionDeps,
  agentId: string,
): Promise<ProvisionResult> {
  const { store, secrets, provider, channel } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;

  let agent = store.getAgent(agentId);
  if (!agent) throw new Error(`No such agent: ${agentId}`);
  if (agent.state === 'FAILED') {
    agent = store.setAgentState(agentId, 'PROVISIONING'); // retry path
  }
  if (agent.state !== 'PROVISIONING') {
    return { agent }; // already live (or being deleted) — nothing to do
  }

  const profile = store.getAIProfile(agent.aiProfileId)!;
  const host = store.getHost(agent.hostId)!;
  const rollback: Array<() => Promise<void>> = [];

  try {
    // Step 3: messaging identity.
    let provisioned = store.getChannelForAgent(agentId);
    if (!provisioned) {
      const result = await channel.provision({
        agentId,
        agentName: agent.name,
        slug: agent.slug,
      });
      rollback.push(async () => {
        await channel.release(result.accountId);
        store.deleteChannelForAgent(agentId);
      });
      provisioned = {
        id: randomUUID(),
        agentId,
        kind: channel.kind,
        accountId: result.accountId,
        secretRef: result.secretRef,
        deepLink: result.deepLink,
        createdAt: new Date().toISOString(),
      };
      store.insertChannel(provisioned);
      store.setAgentPendingAction(agentId, null); // any parked human step is done
      log('channel.provisioned', { agentId, accountId: provisioned.accountId });
    }

    // Step 5: render config + workspace.
    const spec = await buildRuntimeSpec(deps, agentId);

    // Step 4: runtime + persistent volume.
    const { runtimeRef } = await provider.provision(spec);
    rollback.push(() => provider.destroy(runtimeRef, { purge: true }));
    store.setAgentRuntimeRef(agentId, runtimeRef);
    log('runtime.provisioned', { agentId, runtimeRef });

    // Step 6: boot.
    await provider.start(runtimeRef);
    log('runtime.started', { agentId, runtimeRef });

    // Step 7: health check.
    await waitForHealthy(provider, runtimeRef, sleep);
    log('runtime.healthy', { agentId, runtimeRef });

    // Step 8: live.
    const live = store.setAgentState(agentId, 'RUNNING');
    return { agent: live, deepLink: provisioned.deepLink };
  } catch (err) {
    // A channel that needs a human step is not a failure — the agent parks in
    // PROVISIONING with a pendingAction the app renders; once the user acts,
    // provisioning resumes right here.
    if (err instanceof ChannelSetupRequired) {
      store.setAgentPendingAction(agentId, {
        type: 'bot_token',
        instructions: err.instructions,
      });
      log('channel.setup_required', { agentId });
      return {
        agent: store.getAgent(agentId)!,
        setupRequired: { instructions: err.instructions, resumeToken: err.resumeToken },
      };
    }

    const reason = userMessageFor(err);
    log('provision.failed', { agentId, reason, error: String(err) });

    // Roll back newest-first so nothing keeps billing or stays leased.
    for (const undo of rollback.reverse()) {
      try {
        await undo();
      } catch (cleanupErr) {
        log('rollback.failed', { agentId, error: String(cleanupErr) });
      }
    }

    store.setAgentState(agentId, 'FAILED', reason);
    return { agent: store.getAgent(agentId)! };
  }
}

/**
 * Renders the full RuntimeSpec for an agent from its current registry state.
 * Used by fresh provisioning, retry, and rebuild — secrets are resolved as
 * late as possible and only ever live in the spec handed to the provider.
 */
export async function buildRuntimeSpec(deps: ProvisionDeps, agentId: string): Promise<RuntimeSpec> {
  const { store, secrets } = deps;
  const agent = store.getAgent(agentId);
  if (!agent) throw new Error(`No such agent: ${agentId}`);
  const profile = store.getAIProfile(agent.aiProfileId)!;
  const host = store.getHost(agent.hostId)!;
  const channelRow = store.getChannelForAgent(agentId);
  if (!channelRow) throw new Error(`Agent ${agentId} has no channel yet`);

  const botToken = await secrets.get(channelRow.secretRef);
  const subscription = profile.kind === 'subscription';
  if (subscription && host.kind !== 'local') {
    // Enforced at the API too; belt and suspenders here because this is the
    // last gate before a credential decision. See docs/ai-profiles.md.
    throw new Error('Subscription AI profiles can only run on local hosts');
  }
  const modelKey = subscription ? undefined : await secrets.get(requireRef(profile.secretRef));

  // Always pairing mode, never a hard allowlist: pairing already enforces
  // §12.4 (only approved senders chat; strangers get a pending request), AND
  // it keeps the door open for invitees who join after a rebuild — a hard
  // allowlist would silently reject their first contact. allowFrom seeds the
  // known members on fresh volumes.
  const allowFrom = store.listAllowedChannelUserIds(agentId);
  return {
    agentId,
    slug: agent.slug,
    previousRef: agent.runtimeRef,
    workspace: {
      files: buildWorkspaceSeed({
        agentName: agent.name,
        slug: agent.slug,
        persona: agent.persona,
        sharedMemory: agent.sharedMemory,
      }),
      configPatch: {
        agentId: agent.slug,
        model: profile.model,
        models: profile.models,
        authMode: subscription ? 'oauth-claude-cli' : 'api-key',
        telegram: {
          accountId: channelRow.accountId,
          botToken,
          dmPolicy: 'pairing',
          allowFrom,
        },
      },
    },
    env: modelKey ? envForProfile(profile.vendor, modelKey) : {},
    hostMounts: subscription
      ? [{ source: claudeAuthDir(), target: '/home/node/.claude' }]
      : [],
  };
}

/**
 * Recreate the runtime from the current image and config while KEEPING the
 * agent's volume — memory, pairing, and identity survive. This is the upgrade
 * mechanism (new OpenClaw image) and the unstick mechanism, distinct from
 * delete (which purges) by construction: previousRef makes the provider reuse
 * the existing storage, and the seed script never overwrites existing files.
 */
export async function rebuildAgent(deps: ProvisionDeps, agentId: string): Promise<Agent> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new Error(`Agent ${agentId} has no runtime to rebuild`);
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new Error(`Cannot rebuild from state ${agent.state}`);
  }

  try {
    await provider.stop(agent.runtimeRef).catch(() => {}); // may already be stopped
    const spec = await buildRuntimeSpec(deps, agentId);
    const { runtimeRef } = await provider.provision(spec);
    await provider.start(runtimeRef);
    await waitForHealthy(provider, runtimeRef, sleep);
    log('runtime.rebuilt', { agentId, runtimeRef });
    return store.setAgentState(agentId, 'RUNNING');
  } catch (err) {
    const reason = userMessageFor(err);
    log('rebuild.failed', { agentId, reason, error: String(err) });
    store.setAgentState(agentId, 'FAILED', reason);
    return store.getAgent(agentId)!;
  }
}

/** Create + provision in one call — the shape scripts and tests want. */
export async function provisionAgent(
  deps: ProvisionDeps,
  input: CreateAgentInput,
): Promise<ProvisionResult> {
  const agent = createAgentRecord(deps.store, input);
  return runProvisionSteps(deps, agent.id);
}

async function waitForHealthy(
  provider: RuntimeProvider,
  runtimeRef: string,
  sleep: (ms: number) => Promise<void>,
  attempts = 30,
  intervalMs = 1000,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const status = await provider.status(runtimeRef);
    if (status.phase === 'running' && status.healthy) return;
    if (status.phase === 'error') {
      throw new ProviderError(status.message, 'The agent started but reported an error.');
    }
    await sleep(intervalMs);
  }
  throw new ProviderError(
    `runtime ${runtimeRef} never became healthy`,
    'Your agent started but never came online. We stopped it so it will not keep billing.',
  );
}

function requireRef(ref: string | undefined): string {
  if (!ref) throw new Error('AI profile has no stored credential');
  return ref;
}

/**
 * Where the Claude Code OAuth credential lives on the host. The whole
 * directory is mounted (not the single file) because the CLI refreshes tokens
 * by rewriting the file, and a single-file bind mount would detach on rename.
 */
export function claudeAuthDir(): string {
  return `${process.env.HOME ?? '/root'}/.claude`;
}

function envForProfile(vendor: string, key: string): Record<string, string> {
  switch (vendor) {
    case 'anthropic':
      return { ANTHROPIC_API_KEY: key };
    case 'google':
      return { GEMINI_API_KEY: key };
    default:
      throw new Error(`Unsupported AI vendor: ${vendor}`);
  }
}

function userMessageFor(err: unknown): string {
  if (err instanceof ProviderError) return err.userMessage;
  if (err && typeof err === 'object' && 'userMessage' in err) {
    return String((err as { userMessage: unknown }).userMessage);
  }
  return 'Something went wrong setting up your agent. Try again?';
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'agent';
}
