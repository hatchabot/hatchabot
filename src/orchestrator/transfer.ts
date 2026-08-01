import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Agent } from '../domain/types.js';
import { buildRuntimeSpec, waitForHealthy, type ProvisionDeps } from './provision.js';

/**
 * Export/import: an agent as a single portable file, so "move it to another
 * machine" is download-here, upload-there (§ the distributed-hosts direction).
 *
 * The archive is gzipped JSON: a manifest (identity, members, channel + bot
 * token, AI hints) plus the runtime volume snapshot base64-inlined. The bot
 * token IS the agent's Telegram identity — it must travel, which makes the
 * file itself a credential. Handle like one.
 *
 * The cardinal rule of a move: the source copy must never poll again once the
 * import runs — Telegram delivers each message to exactly one poller, and two
 * copies flip-flop. Export therefore leaves the source agent STOPPED.
 */

export const EXPORT_FORMAT = 'agentclaw-export';
export const EXPORT_VERSION = 1;

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  agent: { name: string; slug: string; persona: string; sharedMemory: boolean };
  ai: { vendor: string; model: string; models?: string[] };
  channel: { kind: string; accountId: string; deepLink: string; botToken: string };
  memberships: Array<{
    userId: string;
    role: string;
    displayName?: string;
    channelUserId?: string;
    status: string;
  }>;
  /** base64 gzipped tarball of the OpenClaw state dir. */
  state: string;
}

export class TransferError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'TransferError';
  }
}

export async function exportAgent(
  deps: ProvisionDeps,
  agentId: string,
): Promise<{ filename: string; data: Buffer }> {
  const { store, secrets, provider } = deps;
  const log = deps.log ?? (() => {});

  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new TransferError('This agent has no runtime to export yet.');
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new TransferError(`Can't export while the agent is ${agent.state}.`);
  }
  const channel = store.getChannelForAgent(agentId);
  if (!channel) throw new TransferError('This agent has no messaging channel to export.');
  const profile = store.getAIProfile(agent.aiProfileId);

  // Quiesce for a consistent snapshot, and LEAVE it stopped: the whole point
  // of an export is usually that the agent is about to live somewhere else.
  if (agent.state === 'RUNNING') {
    await provider.stop(agent.runtimeRef);
    store.setAgentState(agentId, 'STOPPED');
  }

  const state = await provider.exportState(agent.runtimeRef);
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    agent: {
      name: agent.name,
      slug: agent.slug,
      persona: agent.persona,
      sharedMemory: agent.sharedMemory,
    },
    ai: {
      vendor: profile?.vendor ?? 'anthropic',
      model: profile?.model ?? '',
      models: profile?.models,
    },
    channel: {
      kind: channel.kind,
      accountId: channel.accountId,
      deepLink: channel.deepLink,
      botToken: await secrets.get(channel.secretRef),
    },
    memberships: store.listMemberships(agentId),
    state: state.toString('base64'),
  };
  log('agent.exported', { agentId, bytes: state.length });
  return {
    filename: `${agent.slug}.agentclaw`,
    data: gzipSync(Buffer.from(JSON.stringify(manifest), 'utf8')),
  };
}

export interface ImportOptions {
  ownerId: string;
  /** Explicit AI profile; defaults to a vendor match, then the first one. */
  aiProfileId?: string;
  hostId?: string;
}

export async function importAgent(
  deps: ProvisionDeps,
  data: Buffer,
  opts: ImportOptions,
): Promise<Agent> {
  const { store, secrets, provider } = deps;
  const log = deps.log ?? (() => {});

  let manifest: ExportManifest;
  try {
    manifest = JSON.parse(gunzipSync(data).toString('utf8'));
  } catch {
    throw new TransferError("That file isn't an AgentClaw export.");
  }
  if (manifest.format !== EXPORT_FORMAT || manifest.version !== EXPORT_VERSION) {
    throw new TransferError('This export was made by an incompatible AgentClaw version.');
  }

  if (store.listAllActiveAgents().some((a) => a.slug === manifest.agent.slug)) {
    throw new TransferError(`An agent with slug "${manifest.agent.slug}" already lives here.`);
  }
  // A previously deleted agent's tombstone may still hold the slug.
  store.releaseDeletedSlug(opts.ownerId, manifest.agent.slug);
  if (store.findAgentUsingAccount(manifest.channel.accountId)) {
    throw new TransferError(
      `Bot @${manifest.channel.accountId} is already wired to an agent here.`,
    );
  }

  const profiles = store.listAIProfiles(opts.ownerId);
  const profile = opts.aiProfileId
    ? store.getAIProfile(opts.aiProfileId)
    : (profiles.find((p) => p.vendor === manifest.ai.vendor) ?? profiles[0]);
  if (!profile) throw new TransferError('Set up an AI source before importing.');
  const host = opts.hostId
    ? store.getHost(opts.hostId)
    : (store.listHosts(opts.ownerId).find((h) => h.kind === 'local') ??
      store.listHosts(opts.ownerId)[0]);
  if (!host) throw new TransferError('No host available to import onto.');

  const now = new Date().toISOString();
  const agent: Agent = {
    id: randomUUID(),
    ownerId: opts.ownerId,
    name: manifest.agent.name,
    slug: manifest.agent.slug,
    state: 'PROVISIONING',
    aiProfileId: profile.id,
    hostId: host.id,
    persona: manifest.agent.persona,
    sharedMemory: manifest.agent.sharedMemory,
    createdAt: now,
    updatedAt: now,
  };
  store.insertAgent(agent);

  // Memberships travel verbatim, except the owner seat belongs to whoever
  // imports — it's their installation now.
  for (const m of manifest.memberships) {
    store.insertMembership({
      id: randomUUID(),
      agentId: agent.id,
      userId: m.role === 'owner' ? opts.ownerId : m.userId,
      role: m.role as 'owner' | 'admin' | 'user',
      displayName: m.displayName,
      channelUserId: m.channelUserId,
      status: m.status as 'active' | 'revoked',
      joinedAt: now,
    });
  }

  const secretRef = `channel/${agent.id}/bot-token`;
  await secrets.put(secretRef, manifest.channel.botToken);
  store.insertChannel({
    id: randomUUID(),
    agentId: agent.id,
    kind: manifest.channel.kind as 'telegram',
    accountId: manifest.channel.accountId,
    secretRef,
    deepLink: manifest.channel.deepLink,
    createdAt: now,
  });

  let runtimeRef: string | undefined;
  try {
    // Provision creates + seeds the volume; the snapshot then overwrites it
    // with the real state; a second provision re-applies THIS installation's
    // config (model, auth mode) over the imported openclaw.json — the seed
    // never touches existing workspace files, so memory survives.
    const spec = await buildRuntimeSpec(deps, agent.id);
    ({ runtimeRef } = await provider.provision(spec));
    store.setAgentRuntimeRef(agent.id, runtimeRef);
    await provider.importState(runtimeRef, Buffer.from(manifest.state, 'base64'));
    const respec = await buildRuntimeSpec(deps, agent.id);
    await provider.provision(respec);
    await provider.start(runtimeRef);
    // First boot on an import can be slow (cold image on Docker Desktop's VM,
    // imported sessions to load) — give it 2 minutes, not the default 30s.
    await waitForHealthy(
      provider,
      runtimeRef,
      deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      120,
    );
    log('agent.imported', { agentId: agent.id, slug: agent.slug, from: manifest.exportedAt });
    return store.setAgentState(agent.id, 'RUNNING');
  } catch (err) {
    // Roll back completely: a "Retry" on a half-imported agent would boot it
    // with a fresh seeded volume — an empty-headed impostor of the archive.
    // Leaving nothing behind keeps "import again" the one true retry path.
    if (runtimeRef) await provider.destroy(runtimeRef, { purge: true }).catch(() => {});
    await secrets.delete(secretRef).catch(() => {});
    store.deleteChannelForAgent(agent.id);
    store.setAgentState(agent.id, 'DELETING');
    store.setAgentState(agent.id, 'DELETED');
    log('import.rolled_back', { agentId: agent.id, error: String(err) });
    throw new TransferError(
      `Import failed and was rolled back — fix the cause and import again. (${String(
        err instanceof Error ? err.message : err,
      ).slice(0, 300)})`,
    );
  }
}
