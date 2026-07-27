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
 * §11.1 — the create flow, minus the parts the user sees.
 *
 * Two properties matter more than anything else here:
 *
 *  1. Every step is idempotent. Re-running provisionAgent() after a crash
 *     partway through reuses the channel lease and the runtime rather than
 *     leasing a second bot or booting a second container.
 *  2. On hard failure we roll back what we created, so a half-provisioned
 *     agent never leaves a bot leased or a VM billing (§11.3).
 */
export async function provisionAgent(
  deps: ProvisionDeps,
  input: CreateAgentInput,
): Promise<ProvisionResult> {
  const { store, secrets, provider, channel } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;

  const profile = store.getAIProfile(input.aiProfileId);
  if (!profile) throw new Error(`No such AI profile: ${input.aiProfileId}`);
  const host = store.getHost(input.hostId);
  if (!host) throw new Error(`No such host: ${input.hostId}`);

  // Step 2: create the agent record and return fast so the app can render a
  // live progress card while the rest of this runs.
  const now = new Date().toISOString();
  const agentId = randomUUID();
  const slug = slugify(input.name);
  const agent: Agent = {
    id: agentId,
    ownerId: input.ownerId,
    name: input.name,
    slug,
    state: 'PROVISIONING',
    aiProfileId: profile.id,
    hostId: host.id,
    persona: input.persona ?? '',
    createdAt: now,
    updatedAt: now,
  };
  store.insertAgent(agent);
  log('agent.created', { agentId, slug });

  // Owner is a member from the start — the allowlist has to contain somebody.
  store.insertMembership({
    id: randomUUID(),
    agentId,
    userId: input.ownerId,
    role: 'owner',
    status: 'active',
    joinedAt: now,
  });

  const rollback: Array<() => Promise<void>> = [];

  try {
    // Step 3: messaging identity.
    let provisioned = store.getChannelForAgent(agentId);
    if (!provisioned) {
      const result = await channel.provision({
        agentId,
        agentName: input.name,
        slug,
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
      log('channel.provisioned', { agentId, accountId: provisioned.accountId });
    }

    // Step 5: render config + workspace. Secrets are resolved as late as
    // possible and only ever live in the spec we hand the provider.
    const botToken = await secrets.get(provisioned.secretRef);
    const modelKey = await secrets.get(profile.secretRef);
    const spec: RuntimeSpec = {
      agentId,
      slug,
      workspace: {
        files: buildWorkspaceSeed({
          agentName: input.name,
          slug,
          persona: input.persona ?? '',
          sharedMemory: input.sharedMemory ?? false,
        }),
        configPatch: {
          agentId: slug,
          model: profile.model,
          telegram: {
            accountId: provisioned.accountId,
            botToken,
            allowFrom: store.listAllowedChannelUserIds(agentId),
          },
        },
      },
      env: envForProfile(profile.vendor, modelKey),
    };

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
    // A channel that needs a human step is not a failure — the agent stays in
    // PROVISIONING and the app prompts, then calls provisionAgent() again.
    if (err instanceof ChannelSetupRequired) {
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
