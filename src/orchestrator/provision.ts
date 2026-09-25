import { ensureOpsServer, opsPort } from '../ops/opsServer.js';
import { clearOpsDrift } from '../ops/opsDrift.js';
import { randomBytes } from 'node:crypto';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, hostname as osHostname } from 'node:os';
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Store } from '../store/store.js';
import { embedDefault } from '../embedder/embedder.js';
import { needsPortHeal } from '../openclaw/configWriter.js';
import type { SecretStore } from '../secrets/secretStore.js';
import type { ChannelRooms, OpenClawConfigPatch, RuntimeProvider, RuntimeSpec } from '../providers/provider.js';
import { ProviderError } from '../providers/provider.js';
import type { ChannelProvisioner } from '../channels/channel.js';
import { ChannelSetupRequired } from '../channels/channel.js';
import { DOORMAN_EMBED_PORT } from '../ops/doorman.js';
import { whileBusy } from './busy.js';
import { notifyAgentChat } from '../channels/notify.js';
import { autoSnapshot } from './snapshots.js';
import { addCron, listCrons } from './crons.js';
import { syncConnections } from './googleConnections.js';
import { buildWorkspaceSeed, dataSourcesSection, installConventionsSection, memoryPolicySection, operatorSection, peerToolsSection, removeSection, replaceSection, DATA_SOURCES_HEADING, INSTALL_HEADING, OPERATOR_HEADING } from '../openclaw/workspace.js';
import { effectiveMemoryCap, memoryBudgetSection } from './memoryCap.js';

/**
 * The `call-agent` tool installed on agents granted peers: consults a peer by
 * name (resolved via ~/.openclaw/peers.json) through the control plane, using
 * the agent's injected call token, and prints the reply. Node so JSON handling
 * and fetch are clean; base64-shipped onto the volume.
 */
const CALL_AGENT_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const [peer, msg] = process.argv.slice(2);
if (!peer || !msg) { console.error('usage: call-agent "<peer name>" "<message>"'); process.exit(2); }
const url = process.env.HATCHABOT_INTERNAL_URL ?? process.env.AGENTCLAW_INTERNAL_URL, tok = process.env.HATCHABOT_AGENT_TOKEN ?? process.env.AGENTCLAW_AGENT_TOKEN; // pre-rename containers carry the old names
if (!url || !tok) { console.error('This agent has no peers configured.'); process.exit(1); }
let peers = [];
try { peers = JSON.parse(fs.readFileSync(process.env.HOME + '/.openclaw/peers.json', 'utf8')); } catch {}
const q = peer.toLowerCase();
const hit = peers.find((p) => p.name.toLowerCase() === q) || peers.find((p) => p.name.toLowerCase().includes(q));
if (!hit) { console.error('Unknown peer "' + peer + '". Available: ' + peers.map((p) => p.name).join(', ')); process.exit(1); }
(async () => {
  try {
    const r = await fetch(url + '/v1/agents/' + hit.id + '/message', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' },
      body: JSON.stringify({ text: msg }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('consult failed: ' + (j.error || r.status)); process.exit(1); }
    console.log(j.reply || '(no reply)');
  } catch (e) { console.error('consult error: ' + e.message); process.exit(1); }
})();
`;

/**
 * Fleet-wide search key (Brave), following the media-key pattern: stored
 * once, injected into every agent at provision as BRAVE_API_KEY — upgrading
 * the whole fleet's search provider from the keyless DuckDuckGo baseline. A
 * per-agent BRAVE_API_KEY env var overrides it (spread order below).
 * Verified in the runtime dist that OpenClaw reads this name (2026-09-04).
 */
export const SEARCH_KEY_REF = 'media/brave-api-key';
import { buildGitSyncScript, buildPublicGitSyncScript, gitSyncReason, isPublicGitUrl } from './gitSource.js';
import type { Agent, Channel, Host } from '../domain/types.js';
import { briefCause } from '../domain/redact.js';
import { APP_VERSION } from '../domain/appVersion.js';
import { opsSection, OPS_MANAGED_HEADINGS } from '../ops/opsAgent.js';

export interface CreateAgentInput {
  ownerId: string;
  name: string;
  persona?: string;
  aiProfileId: string;
  hostId: string;
  sharedMemory?: boolean;
  /** Optional per-agent model override (cloud only); absent = profile default. */
  model?: string;
}

/** The cap this agent's container gets (memoryCap.ts): its own, its class's, or the fleet default. */
export function memoryCapFor(store: Store, agent: Agent): string {
  return effectiveMemoryCap(agent, agent.classId ? store.getAgentClass(agent.classId) : undefined);
}

export interface ProvisionDeps {
  store: Store;
  secrets: SecretStore;
  provider: RuntimeProvider;
  channel: ChannelProvisioner;
  /** Injected so tests don't sleep. */
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, detail: Record<string, unknown>) => void;
  /**
   * Ask the agent to distil the live conversation into MEMORY.md before this
   * rebuild replaces the container. Set when the rebuild will change the AI
   * backend (a source switch), which makes OpenClaw reset the thread — the
   * summary is what survives the reset. Best-effort; never blocks the rebuild.
   */
  checkpointMemory?: boolean;
  /**
   * The machine's embedding service (src/embedder), for agents switched to
   * it: bring it up, and mint this agent's key. Absent (a runner, a test):
   * the agent is built on the baked engine and told so.
   */
  embedder?: {
    /** Bring the service up if need be and mint this agent's key — or, with an
     *  external server configured, that server's address, key and model. */
    credentialsFor(agentId: string): Promise<{ baseUrl: string; token: string; model: string }>;
  };
  /** Post a line to the agent's chat (default: Telegram via notifyAgentChat).
   *  Injectable so tests stay off the network. */
  notify?: (agentId: string, text: string) => Promise<unknown>;
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
  const slug = slugify(input.name);
  // A deleted agent's tombstone row still holds UNIQUE(owner_id, slug) —
  // free it so names are reusable after deletion.
  store.releaseDeletedSlug(input.ownerId, slug);
  const agent: Agent = {
    id: randomUUID(),
    ownerId: input.ownerId,
    name: input.name,
    slug,
    state: 'PROVISIONING',
    aiProfileId: profile.id,
    hostId: host.id,
    persona: input.persona ?? '',
    // Shared by default: a multi-member agent with a single MEMORY.md is only
    // honest when everyone knows memory is common. Private is the opt-out for
    // a strictly personal agent.
    sharedMemory: input.sharedMemory ?? true,
    // Only meaningful for cloud profiles; effectiveModel() ignores it for local.
    model: profile.vendor === 'local' ? undefined : input.model || undefined,
    // sortOrder is left to the store, which lands a new agent FIRST in its
    // section with no ties (see Store.firstSortOrder) — you watch the thing you
    // just made, and it shouldn't be below the whole fleet.
    createdAt: now,
    updatedAt: now,
  };
  store.insertAgent(agent);
  // The fleet default for memory search: shared once the owner flipped it
  // (Status → Tools); only where the service is — this machine.
  if (embedDefault() === 'shared' && host.kind === 'local') store.setAgentEmbedMode(agent.id, 'shared');

  // Owner is a member from the start — the allowlist has to contain somebody.
  // And if any earlier agent already bound their Telegram identity, carry it
  // over: seeded into allowFrom, their first message just works — the pairing
  // dance ("access not configured", a code, a second message) happens once
  // per person, not once per agent.
  const known = store.knownChannelUserId(input.ownerId);
  store.insertMembership({
    id: randomUUID(),
    agentId: agent.id,
    userId: input.ownerId,
    role: 'owner',
    ...(known ? { channelUserId: known } : {}),
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
/**
 * Agents whose NEXT channel provision must skip the bot pool — the owner
 * unchecked "use a pool bot" at creation. In-memory and one-shot on purpose:
 * once the manual flow parks the agent (pendingAction), that persisted state
 * drives every retry, so the flag never needs to outlive the first attempt.
 */
export const skipPoolOnce = new Set<string>();

/** SecretStore ref for the fleet-wide media-understanding key (Gemini) —
 *  voice-note transcription for every agent. See buildRuntimeSpec. */
export const MEDIA_KEY_REF = 'media/gemini-api-key';

export async function runProvisionSteps(
  deps: ProvisionDeps,
  agentId: string,
): Promise<ProvisionResult> {
  return whileBusy(agentId, () => runProvisionStepsInner(deps, agentId));
}

async function runProvisionStepsInner(
  deps: ProvisionDeps,
  agentId: string,
): Promise<ProvisionResult> {
  const { store, provider, channel } = deps;
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

  const rollback: Array<() => Promise<void>> = [];

  try {
    // Step 3: messaging identity.
    let provisioned = store.getChannelForAgent(agentId);
    if (!provisioned && agent.webOnly) {
      // No Telegram: reached only through Hatchabot. Nothing to lease.
      log('channel.skipped', { agentId, reason: 'web-only' });
    } else if (!provisioned) {
      const result = await channel.provision({
        agentId,
        agentName: agent.name,
        slug: agent.slug,
        ownerId: agent.ownerId,
        // One-shot: consumed here so a later Retry (after the manual flow has
        // parked the agent) follows the persisted pendingAction, not the flag.
        skipPool: skipPoolOnce.delete(agentId) || undefined,
      });
      // A Telegram bot token may only ever be polled by ONE runtime: two
      // copies flip-flop every message between them. The API checks this when
      // a token is pasted, but a rejected token can still be sitting in the
      // provisioner's pending map, so a later Retry would arrive here holding
      // an identity that belongs to somebody else. This is the last gate
      // before it becomes a real channel row, so check it here too.
      const clash = store.findAgentUsingAccount(result.accountId);
      if (clash && clash.id !== agentId) {
        // Deliberately NOT released: release() deletes the stored token for
        // this account, and that token is the OTHER agent's credential.
        throw new ChannelConflictError(
          `@${result.accountId} already belongs to "${clash.name}". Each agent needs its ` +
            `own bot — create another with @BotFather and paste that token instead.`,
        );
      }
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
    } else {
      // Already has its identity — but the rename at lease time is best-effort
      // (Telegram limits how often a bot may be renamed), and one that lost
      // that race left a recycled bot advertising "Hatchabot (unassigned)"
      // with no way back. Retry and Rebuild both land here, so the bot heals
      // itself instead of staying mislabelled for the life of the agent.
      await channel.syncDisplayName?.(provisioned.accountId, agent.name).catch(() => {});
    }

    // Step 5: render config + workspace.
    const spec = await buildRuntimeSpec(deps, agentId);

    // Step 4: runtime + persistent volume.
    log('runtime.seeding', { agentId, migrating: needsPortHeal(spec.workspace.configPatch.openclawVersion) });
    const { runtimeRef } = await provider.provision(spec);
    recordApplied(store, agentId);
    store.recordAppliedPeers(agentId); // the sync below installs the tool for this grant
    // Purge ONLY storage this run created. On a retry, spec.previousRef makes
    // provision() reuse the existing volume — purging it there destroys the
    // agent's memory permanently, turning a transient failure (slow boot,
    // port clash, image missing) into irreversible loss.
    const createdStorage = !spec.previousRef;
    rollback.push(() => provider.destroy(runtimeRef, { purge: createdStorage }));
    store.setAgentRuntimeRef(agentId, runtimeRef);
    log('runtime.provisioned', { agentId, runtimeRef });

    // Step 6: boot.
    await provider.start(runtimeRef);
    log('runtime.started', { agentId, runtimeRef });

    // Step 7: health check. Generous, because a retry boots an agent that may
    // have months of sessions to load — and timing out here used to trigger a
    // rollback that purged its volume.
    await waitForHealthy(provider, runtimeRef, sleep, 120);
    log('runtime.healthy', { agentId, runtimeRef });

    // Step 7.5: clone/refresh git data sources onto the volume, then tell the
    // agent where they landed (AGENTS.md "## Data sources").
    await syncGitDataSources(deps, agentId, runtimeRef, log);
    // Step 7.6: attached platform connections (Google via gog) land on the
    // volume — best-effort per connection; a Google hiccup never fails a
    // build, and import is idempotent so the next provision heals it.
    await syncConnections({ store, secrets: deps.secrets, provider, log }, agentId, runtimeRef)
      .catch((err) => log('connection.sync_failed', { agentId, error: String(err).slice(0, 200) }));
    await syncDataSourceDocs(deps, agentId, runtimeRef, log);
    await syncInstallDocs(deps, agentId, runtimeRef, log);
    await runRebuildHook(deps, agentId, runtimeRef, log);
    // Step 7.9: let the agent stop moving before anyone can talk to it — a
    // message that lands mid-settle has started a fresh session.
    await waitForSkillsSettled(provider, runtimeRef, agent.slug, sleep, log);
    await reindexMemoryIfSwitched(deps, agentId, runtimeRef, log);

    // Step 7.95: template-carried schedules — declarations parked at import
    // become real gateway crons now that the gateway exists. Best-effort per
    // job; the batch clears only on a pass with zero failures, so a flaky
    // gateway retries on the next provision instead of dropping tasks.
    const pendingSchedules = store.getPendingSchedules(agentId);
    if (pendingSchedules.length) {
      // Idempotent by NAME: crons live on the durable volume, so a retry after
      // a partial failure must skip the ones that already landed — a bare
      // re-add duplicated every success on each subsequent provision, and the
      // duplicates fired forever (10th audit). Instead of the all-or-keep
      // batch, each applied (or already-present) entry is dropped from the
      // parked list individually; only genuine failures stay parked.
      const existing = new Set(
        (await listCrons(provider, runtimeRef, agent.slug).catch(() => []))
          .map((c) => c.name)
          .filter((n): n is string => !!n),
      );
      const stillPending: typeof pendingSchedules = [];
      for (const sch of pendingSchedules) {
        if (existing.has(sch.name)) { log('schedule.already_present', { agentId, name: sch.name }); continue; }
        const out = await addCron(provider, runtimeRef, agent.slug, {
          name: sch.name, message: sch.message, cron: sch.cron, everyMs: sch.everyMs, tz: sch.tz,
        }).catch(() => ({ ok: false as const, error: 'exec failed' }));
        if (!out.ok) {
          stillPending.push(sch);
          log('schedule.apply_failed', { agentId, name: sch.name, error: (out as any).error });
        } else {
          log('schedule.applied', { agentId, name: sch.name });
        }
      }
      store.setPendingSchedules(agentId, stillPending.length ? stillPending : null);
    }

    // Step 8: live.
    const live = store.setAgentState(agentId, 'RUNNING');
    return { agent: live, deepLink: provisioned?.deepLink };
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
export async function buildRuntimeSpec(
  deps: ProvisionDeps,
  agentId: string,
  // Move builds the target spec BEFORE flipping the store's hostId (so a crash
  // mid-move can't strand the record on a host that has no data yet) — this
  // overrides which host the spec resolves against, without a store mutation.
  hostOverride?: Host,
): Promise<RuntimeSpec> {
  const { store, secrets } = deps;
  const agent = store.getAgent(agentId);
  if (!agent) throw new Error(`No such agent: ${agentId}`);
  const profile = store.getAIProfile(agent.aiProfileId)!;
  const host = hostOverride ?? store.getHost(agent.hostId)!;
  const channelRow = store.getChannelForAgent(agentId);
  if (!channelRow && !agent.webOnly) throw new Error(`Agent ${agentId} has no channel yet`);

  const botToken = channelRow ? await secrets.get(channelRow.secretRef) : undefined;
  // A local model server needs no credential of any kind: no key to inject,
  // no ~/.claude to mount, nothing that can leak. It is the only vendor where
  // "your data never leaves the machine" is literally true.
  const local = profile.vendor === 'local';
  const subscription = !local && profile.kind === 'subscription';
  // A subscription (Claude Max) profile authenticates one of two ways, and only
  // one of them travels. A `claude setup-token` (profile.secretRef present) is
  // injected as CLAUDE_CODE_OAUTH_TOKEN — pure data, so it rides to any host, a
  // runner included. The machine-login flavour instead bind-mounts the CONTROL
  // PLANE'S ~/.claude, which a remote daemon can't see; that one stays local.
  if (subscription && host.kind !== 'local' && !profile.secretRef) {
    // Enforced at the API too; belt and suspenders here because this is the
    // last gate before a credential decision. See docs/ai-profiles.md.
    throw new Error(
      "This Claude Max profile uses this machine's login, which only reaches agents on this " +
        'machine. To run Max on a runner, add a setup-token profile (`claude setup-token`).',
    );
  }
  // Where-am-I orientation: agents get MOVED between machines, and "which
  // host are you on?" asked in Telegram deserves a true answer. The container
  // hostname becomes `<agent>.<host>` (so a plain `hostname` answers), and
  // HATCHABOT_HOST_NAME carries the human-readable host name for scripts.
  // Both refresh on every rebuild/move because provision re-renders the spec.
  const hostLabel = host.kind === 'local' ? osHostname() : host.name;
  const hostSlug = hostLabel.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'host';
  const containerHostname = `${agent.slug.slice(0, 63)}.${hostSlug}`;

  const modelKey =
    subscription || local ? undefined : await secrets.get(requireRef(profile.secretRef));

  // Voice & media understanding: OpenClaw transcribes inbound voice notes by
  // sending audio to an audio-capable model (Gemini). One server-level key —
  // set in Settings → AI sources, stored like any credential — lights this up
  // for every agent. Injected HERE (not the Environment tab: GEMINI_* is
  // reserved there on purpose) and only when the profile doesn't already
  // provide it (a google-vendor profile's own key wins via spread order).
  const mediaKey = await secrets.get(MEDIA_KEY_REF).catch(() => undefined);
  const searchKey = await secrets.get(SEARCH_KEY_REF).catch(() => undefined);
  // Subscription with a stored secret = a `claude setup-token` token (macOS
  // hosts, where the login lives in the Keychain and can't be file-mounted).
  // Claude Code reads it from CLAUDE_CODE_OAUTH_TOKEN; no ~/.claude mount.
  const oauthToken =
    subscription && profile.secretRef ? await secrets.get(profile.secretRef) : undefined;
  if (local && !profile.baseUrl) {
    throw new Error('Local AI profile has no model server URL');
  }

  // Always pairing mode, never a hard allowlist: pairing already enforces
  // §12.4 (only approved senders chat; strangers get a pending request), AND
  // it keeps the door open for invitees who join after a rebuild — a hard
  // allowlist would silently reject their first contact. allowFrom seeds the
  // known members on fresh volumes.
  const allowFrom = store.listAllowedChannelUserIds(agentId);
  // Slack and Discord: written only when the image carries the plugin. A row
  // whose plugin is missing (an agent pinned to an older image) is left out of
  // this build rather than failing it; the Messaging tab says why.
  const slackRow = store.getChannelForAgent(agentId, 'slack');
  const discordRow = store.getChannelForAgent(agentId, 'discord');
  let channelPlugins: string[] = [];
  let bakedPlugins: string[] = [];
  let pluginInstall: 'link' | 'npm' | undefined;
  let openclawVersion: string | undefined;
  let engineless = false;
  try {
    const info = await deps.provider.currentImageInfo(agent.image ?? undefined);
    channelPlugins = info.channels ?? [];
    bakedPlugins = info.plugins ?? [];
    pluginInstall = info.pluginInstall;
    openclawVersion = info.openclawVersion;
    engineless = info.embedEngine === 'none';
  } catch { /* no image info: no new channels this build */ }

  // Memory search engine. `shared` needs the service on THIS machine; when
  // it cannot be had (a runner, the service down), the agent is built on the
  // baked engine — never left without one — and the reason is on its record.
  // An image with no engine of its own (label embed-engine=none: OpenClaw
  // 2026.8+, or a -lite build) has only the shared service: the agent is
  // built on it whatever its switch says, and the build refuses rather than
  // leave it without memory search.
  const wantShared = agent.embedMode === 'shared' || engineless;
  let embed: OpenClawConfigPatch['embed'];
  let bakedWhy: string | undefined;
  if (wantShared && host.kind !== 'local') bakedWhy = 'it runs on a runner, and the service is on the main machine';
  else if (wantShared && !deps.embedder) bakedWhy = 'no memory search service is available on this path';
  else if (wantShared) {
    try {
      embed = await deps.embedder!.credentialsFor(agentId);
    } catch (err) {
      bakedWhy = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    }
  }
  if (engineless && !embed) {
    deps.log?.('embed.engineless_refused', { agentId, why: bakedWhy });
    throw new ProviderError(`image ${agent.image ?? 'default'} has no embedding engine and the shared service is unavailable: ${bakedWhy}`,
      `Its image has no memory search engine of its own, and the shared memory search service cannot be had (${bakedWhy}). Start the service (Settings → Hosts), or pin the agent to an image that carries an engine.`);
  }
  if (engineless && agent.embedMode !== 'shared') {
    // The record says what the agent runs on, not what the switch once said.
    deps.log?.('embed.forced_shared', { agentId, image: agent.image ?? 'default' });
    store.setAgentEmbedMode(agentId, 'shared');
  }
  if (bakedWhy) {
    deps.log?.('embed.baked_instead', { agentId, why: bakedWhy });
    // On the record, where the agent's engine row can show it — the log alone
    // left the row promising a switch that would not happen (27th audit).
    store.setAgentEmbedIndex(agentId, null, `built on its own engine — ${bakedWhy}`);
  }
  embedDecision.set(agentId, { used: embed ? 'shared' : 'baked', before: agent.appliedEmbedMode ?? 'baked', openclawVersion });
  const roomsOf = (c: Channel): ChannelRooms => {
    const r = (c.settings?.rooms ?? {}) as { mode?: string; roomId?: unknown };
    if (r.mode === 'members') return { mode: 'members' };
    return r.mode === 'room' && typeof r.roomId === 'string' && r.roomId ? { mode: 'room', roomId: r.roomId } : { mode: 'off' };
  };
  /** The servers a Discord bot was in at its last check — the rooms of `members` mode. */
  const serversOf = (c: Channel): string[] => {
    const list = (c.settings?.servers ?? []) as Array<{ id?: unknown }>;
    return Array.isArray(list) ? list.map((g) => String(g?.id ?? '')).filter(Boolean) : [];
  };
  // The same door rule as Telegram (below): allowlist once somebody is
  // admitted, pairing only while nobody is or the owner allows knocks. Discord
  // was hardwired to pairing, so anyone sharing a server could always knock
  // (2026-09-25).
  const doorFor = (allowFrom: string[]): 'pairing' | 'allowlist' => !allowFrom.length || agent.allowKnocks ? 'pairing' : 'allowlist';
  let slack: OpenClawConfigPatch['slack'];
  if (slackRow && channelPlugins.includes('slack')) {
    const t = JSON.parse(await secrets.get(slackRow.secretRef)) as { botToken: string; appToken: string };
    const allowFrom = store.listAllowedChannelUserIds(agentId, 'slack');
    slack = { botToken: t.botToken, appToken: t.appToken, dmPolicy: doorFor(allowFrom), allowFrom, rooms: roomsOf(slackRow), servers: serversOf(slackRow) };
  }
  let discord: OpenClawConfigPatch['discord'];
  if (discordRow && channelPlugins.includes('discord')) {
    const allowFrom = store.listAllowedChannelUserIds(agentId, 'discord');
    discord = {
      token: await secrets.get(discordRow.secretRef), applicationId: discordRow.accountId,
      dmPolicy: doorFor(allowFrom), allowFrom, rooms: roomsOf(discordRow), servers: serversOf(discordRow),
    };
  }
  // Debug door: each agent's Control UI published on a stable host port
  // behind a per-agent gateway token.
  const gateway = store.ensureGatewayAccess(agentId);
  // Owner-set env vars (e.g. an API key the agent's own tools need). Their
  // values are secrets; fetch them here. The managed AI credentials are spread
  // AFTER these below, so a same-named var can never shadow the agent's own AI
  // auth (the API also refuses those names up front).
  const perAgentEnv: Record<string, string> = {};
  for (const e of store.listAgentEnv(agentId)) {
    perAgentEnv[e.name] = await secrets.get(e.secretRef);
  }
  // Agent-to-agent: an agent granted peers gets its call token + the address it
  // reaches the control plane on, so its `call-agent` tool can consult them.
  const peerIds = store.listAgentPeers(agentId);
  const callToken = peerIds.length ? await secrets.get(`agent-call-token/${agentId}`).catch(() => undefined) : undefined;
  if (callToken) {
    perAgentEnv.HATCHABOT_AGENT_TOKEN = callToken;
    perAgentEnv.HATCHABOT_INTERNAL_URL = process.env.HATCHABOT_INTERNAL_URL ?? 'http://172.17.0.1:8080';
  }
  // The management agent: a fresh propose-only key on every build, and the
  // address of the ops server — its tools and its only way to its AI provider.
  let ops: { mcpUrl: string; token: string; proxyUrl: string; host: string } | undefined;
  if (agent.ops) {
    const token = randomBytes(32).toString('base64url');
    store.setOpsToken(agentId, agent.ownerId, token);
    clearOpsDrift(agentId); // this build re-asserts the lockdown
    // Its tools come from Hatchabot, and OpenClaw reads that list once at
    // start-up: remember which version it was built against so an upgrade can
    // restart it instead of leaving it describing tools it no longer has.
    store.setAppliedAppVersion(agentId, APP_VERSION);
    // Hatchabot's door listens on THIS machine's loopback, and the agent
    // reaches it through its doorman — the one arrangement that works the same
    // on Linux and on Docker Desktop, where the host cannot listen on a Docker
    // address at all (docs/ops-agent-design.md).
    const at = await ensureOpsServer([await deps.provider.hostGatewayAddress?.()]);
    // The memory search door, when the manager uses the shared service: its
    // port rides on the doorman, and the agent is pointed at the doorman.
    const embedUrl = embed ? (() => { try { return new URL(embed.baseUrl); } catch { return undefined; } })() : undefined;
    const embedPort = embedUrl ? Number(embedUrl.port) || (embedUrl.protocol === 'https:' ? 443 : 80) : undefined;
    const jail = deps.provider.ensureOpsJail
      ? await deps.provider.ensureOpsJail({
        agentId, slug: agent.slug, runtimeRef: agent.runtimeRef,
        opsPort: at.port, consolePort: gateway.port, embedPort,
      })
      : { doorHost: at.host, doorPort: at.port }; // providers without networks (mock)
    if (embed && embedUrl && deps.provider.ensureOpsJail) embed = { ...embed, baseUrl: `http://${jail.doorHost}:${DOORMAN_EMBED_PORT}${embedUrl.pathname === '/' ? '' : embedUrl.pathname}` };
    ops = {
      host: jail.doorHost,
      token,
      mcpUrl: `http://${jail.doorHost}:${jail.doorPort}/mcp`,
      proxyUrl: `http://ops:${token}@${jail.doorHost}:${jail.doorPort}`,
    };
    Object.assign(perAgentEnv, {
      HTTPS_PROXY: ops.proxyUrl, https_proxy: ops.proxyUrl,
      NO_PROXY: `${jail.doorHost},localhost,127.0.0.1`, no_proxy: `${jail.doorHost},localhost,127.0.0.1`,
      NODE_USE_ENV_PROXY: '1',
    });
    // It consults nobody directly (no route to the main port); drop A2A env.
    delete perAgentEnv.HATCHABOT_AGENT_TOKEN;
    delete perAgentEnv.HATCHABOT_INTERNAL_URL;
  }
  return {
    agentId,
    slug: agent.slug,
    isolated: agent.ops || undefined,
    // Pinned image, when the agent has one — a candidate under test, or a
    // derived image with extra system packages. Absent = provider default.
    image: agent.image,
    // Its own cap, else its class's, else the fleet default (memoryCap.ts).
    memory: memoryCapFor(store, agent),
    previousRef: agent.runtimeRef,
    ports: [{ host: gateway.port, container: 18789 }],
    workspace: {
      files: buildWorkspaceSeed({
        agentName: agent.name,
        slug: agent.slug,
        persona: agent.persona,
        sharedMemory: agent.sharedMemory,
        // A template import stashes its trained SOUL.md/AGENTS.md here; the seed
        // script only writes files that don't yet exist, so this seeds once.
        seedFiles: store.getAgentSeed(agentId),
      }),
      configPatch: {
        agentId: agent.slug,
        displayName: agent.name,
        model: effectiveModel(agent, profile),
        models: profile.models,
        authMode: subscription ? 'oauth-claude-cli' : 'api-key',
        cronTriggers: agent.cronTriggers === true,
        embed,
        openclawVersion,
        bakedPlugins,
        pluginInstall,
        // Model refs are provider-prefixed; a Google profile configured as
        // `anthropic/gemini-…` provisions healthy and fails on first use.
        provider: local
          ? 'ollama'
          : profile.vendor === 'google'
            ? 'google'
            : profile.vendor === 'openai'
              ? 'openai'
              : 'anthropic',
        // A local model server is reached on the jail's own gateway address.
        baseUrl: ops && local ? (profile.baseUrl ?? 'http://172.17.0.1:11434/v1').replace(/\/\/172\.17\.0\.1(?=[:/])/, `//${ops.host}`) : profile.baseUrl,
        ops: ops && { mcpUrl: ops.mcpUrl, token: ops.token },
        setupToken: oauthToken,
        gatewayToken: gateway.token,
        // Web-only agents have no bot: configWriter then writes no Telegram
        // channel at all.
        telegram: channelRow && botToken ? {
          accountId: channelRow.accountId,
          botToken,
          // `allowlist` is the resting state: a DM from anyone not on the
          // list is dropped without a word. `pairing` answers a stranger with
          // "access not configured" and a code, so it is used only when it
          // has to be — when nobody is on the list yet (a fresh agent that
          // would otherwise be unreachable), or when the owner deliberately
          // opened the agent to anyone who finds it. A claim window flips it
          // to pairing for its 30 minutes and back again (see claim.ts).
          dmPolicy: !allowFrom.length || agent.allowKnocks ? 'pairing' : 'allowlist',
          allowFrom,
          groupAccess: agent.groupAccess,
          richMessages: agent.richMessages !== false,
          proxy: ops?.proxyUrl,
        } : undefined,
        channelPlugins,
        slack,
        discord: discord && { ...discord, ...(ops ? { proxy: ops.proxyUrl } : {}) },
      },
    },
    hostname: containerHostname,
    env: {
      ...(mediaKey ? { GEMINI_API_KEY: mediaKey } : {}),
      // Fleet search key first, per-agent env after — an agent's own
      // BRAVE_API_KEY (its own quota/bill) wins over the household one.
      // Not for the management agent: a Brave key makes OpenClaw download the
      // Brave plugin from npm at startup, which its jail refuses — it then never
      // comes up healthy (seen live, 2026-09-18). It searches through Hatchabot.
      ...(searchKey && !agent.ops ? { BRAVE_API_KEY: searchKey } : {}),
      ...perAgentEnv,
      // Orientation, not configuration: the human name of the machine this
      // agent runs on, refreshed by every rebuild/move.
      HATCHABOT_HOST_NAME: hostLabel,
      // Its memory budget, so a script can size itself (AGENTS.md says the same).
      HATCHABOT_MEMORY_CAP: memoryCapFor(store, agent),
      // Google-connection credentials (gog) live ON THE VOLUME: they refresh
      // in place and ride Move/backup/export with the agent, while Share
      // templates never include them. See docs/connections-design.md.
      GOG_HOME: '/home/node/.openclaw/connections/gog',
      // $HOME is the agent's persistent volume, so put the conventional
      // user-install locations on PATH for EVERY process (a login shell isn't
      // guaranteed — Claude Code spawns plain `bash -c`). This is what makes a
      // tool the agent installs for itself actually runnable next time.
      PATH: '/home/node/.local/bin:/home/node/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      NPM_CONFIG_PREFIX: '/home/node/.npm-global',
      ...(modelKey
        ? envForProfile(profile.vendor, modelKey)
        : oauthToken
          ? { CLAUDE_CODE_OAUTH_TOKEN: oauthToken }
          : {}),
    },
    hostMounts: [
      // A machine-login Max profile is the PROFILE OWNER'S ~/.claude: OAuth
      // refresh token, every Claude Code transcript, and settings.json (whose
      // hooks execute as them). Only mount it for the profile owner's OWN
      // agents — the `profile.ownerId === agent.ownerId` guard (restored for
      // family-member hardening) means a cross-owner selection never mounts it,
      // backstopping the route checks in create/switch/share.
      ...(subscription && !oauthToken && profile.ownerId === agent.ownerId
        ? [{ source: claudeAuthDir(), target: '/home/node/.claude' }]
        : []),
      // Legacy owner-chosen folders, always read-only. An agent runs with
      // permission prompts disabled and is reachable by everyone in it, so write
      // access would make one bad instruction destructive.
      ...(agent.sharedPaths ?? []).map((p) => ({
        source: p,
        target: `/data/${basename(p)}`,
        readonly: true,
      })),
      // Data sources of kind 'folder' — the same bind mount, but access is
      // per-source: 'rw' drops the :ro flag (gated + warned at the API). (Git
      // sources are cloned onto the volume in Slice B, not mounted here.)
      ...store
        .listDataSources(agent.id)
        .filter((d) => d.kind === 'folder' && d.hostPath)
        .map((d) => ({
          source: d.hostPath!,
          // Adopted agents bind at the original host path so their existing
          // absolute references resolve; everything else uses /data/<name>.
          target: d.mountAtHostPath ? d.hostPath! : `/data/${d.mountName}`,
          readonly: d.access === 'ro',
        })),
    ],
  };
}

/**
 * Recreate the runtime from the current image and config while KEEPING the
 * agent's volume — memory, pairing, and identity survive. This is the upgrade
 * mechanism (new OpenClaw image) and the unstick mechanism, distinct from
 * delete (which purges) by construction: previousRef makes the provider reuse
 * the existing storage, and the seed script never overwrites existing files.
 */
/**
 * Have the agent write the live conversation's durable facts into MEMORY.md,
 * on the STILL-RUNNING old container, before a rebuild that will reset the
 * thread. This is OpenClaw's own "promote key facts, don't hoard transcripts"
 * model, fired at the one moment Hatchabot knows context is about to drop.
 *
 * Best-effort by contract: any failure (model down, timeout, CLI hiccup) is
 * logged and swallowed — a missed summary is a smaller harm than a blocked or
 * failed switch.
 */
export const CHECKPOINT_TIMEOUT_MS = Number(process.env.HATCHABOT_CHECKPOINT_TIMEOUT_MS ?? 180_000);

export async function checkpointMemory(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<{ ok: boolean; detail?: string }> {
  const prompt =
    'System note: please save anything from our recent conversation worth keeping — decisions, ' +
    'facts about the people you serve, ongoing tasks or context — into your memory (MEMORY.md, ' +
    'or today\'s file under memory/), so it survives if this chat is later reset. Only durable ' +
    'things; skip small talk. Reply with just DONE when saved.';
  try {
    // Bounded by the provider's own exec timeout (HATCHABOT_DOCKER_TIMEOUT_MS,
    // 60s default) — a summary is short; a model too slow to finish inside it
    // is one we'd rather abandon than let delay the rebuild.
    // A summary turn that writes memory can legitimately take >60s under load;
    // cutting it mid-turn leaves the container stopped on a broken turn (the
    // "interrupted by a gateway restart" notice). 3 minutes, its own budget.
    const res = await provider.exec(runtimeRef, ['agent', '--agent', slug, '-m', prompt], { timeoutMs: CHECKPOINT_TIMEOUT_MS });
    // The checkpoint IS an agent turn, so it needs the AI source to actually
    // run — an out-of-credits / expired / rate-limited source makes the turn
    // fail (non-zero), and the summary is NOT written. Report that instead of
    // pretending it saved, so callers can tell the user the truth.
    const ok = res.code === 0 && !res.timedOut;
    log('memory.checkpointed', { slug, ok, timedOut: !!res.timedOut, tail: (res.stdout || res.stderr).slice(-200) });
    return {
      ok,
      detail: ok ? undefined
        : res.timedOut ? 'the AI source did not finish in time'
          : (res.stderr || res.stdout || 'the AI source could not complete the turn (out of credits, expired, or unreachable?)').trim().slice(-180),
    };
  } catch (err) {
    const detail = String((err as Error).message ?? err);
    log('memory.checkpoint_failed', { slug, error: detail });
    return { ok: false, detail };
  }
}

export async function rebuildAgent(deps: ProvisionDeps, agentId: string): Promise<Agent> {
  return whileBusy(agentId, () => rebuildAgentInner(deps, agentId));
}

async function rebuildAgentInner(deps: ProvisionDeps, agentId: string): Promise<Agent> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? defaultSleep;
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new Error(`Agent ${agentId} has no runtime to rebuild`);
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new Error(`Cannot rebuild from state ${agent.state}`);
  }
  let checkpointResult: { ok: boolean; detail?: string } | undefined;
  // Cheap insurance before we replace the container. This runs HERE (inside the
  // background task) rather than in the route so the POST returns immediately —
  // the ~1-2s docker-exec snapshot was what made "Rebuild all" sit silent. It
  // still happens before stop/replace, and before the REBUILDING flip because
  // captureSnapshot only reads a RUNNING agent (no-op unless RUNNING).
  if (agent.state === 'RUNNING') {
    await autoSnapshot({ store, provider, log }, agentId, 'pre-rebuild');
    // Save the conversation into memory BEFORE we touch the container, while
    // the old AI backend still answers — a source switch resets the thread on
    // first message under the new backend, and this is what survives it.
    if (deps.checkpointMemory) {
      checkpointResult = await checkpointMemory(provider, agent.runtimeRef, agent.slug, log);
    }
  }
  // Visible immediately: the chip must not read RUNNING while the container
  // is being replaced.
  store.setAgentState(agentId, 'REBUILDING');
  // A checkpoint that failed (rate-limited / dead source) ended its turn
  // abnormally right before the stop; OpenClaw then posts "interrupted by a
  // gateway restart — send that last request again" on boot, which reads as
  // if it were about the USER's message. Explain it once the agent is back.
  const explainFailedCheckpoint = async () => {
    if (!checkpointResult || checkpointResult.ok) return;
    const send = deps.notify ?? ((id: string, text: string) => notifyAgentChat(store, deps.secrets, id, text));
    await send(agentId,
      'ℹ️ Before this restart I tried to save our conversation to memory, but the previous AI source didn\'t finish ' +
      '(rate-limited or out of tokens). If there is an "interrupted by a gateway restart" note above, ignore it — ' +
      'that was the save attempt, not your message. Nothing you sent was lost.').catch(() => {});
  };

  try {
    await provider.stop(agent.runtimeRef).catch(() => {}); // may already be stopped
    const spec = await buildRuntimeSpec(deps, agentId);
    // Deletion may have started while we were stopping. Re-creating the
    // container now would resurrect a purged agent as an orphan.
    const current = store.getAgent(agentId);
    if (!current || current.state === 'DELETING' || current.state === 'DELETED') {
      log('rebuild.abandoned', { agentId, reason: 'agent is being deleted' });
      return current ?? agent;
    }
    // Each step says what it is, so a card that reads REBUILDING for minutes
    // can be asked what it is doing (the Setup log; Chris, 2026-09-24).
    log('runtime.seeding', { agentId, migrating: needsPortHeal(spec.workspace.configPatch.openclawVersion) });
    const { runtimeRef } = await provider.provision(spec);
    log('runtime.provisioned', { agentId, runtimeRef });
    recordApplied(store, agentId);
    store.recordAppliedPeers(agentId); // the sync below installs the tool for this grant
    await provider.start(runtimeRef);
    log('runtime.started', { agentId, runtimeRef });
    // As generous as a retry's health wait: a rebuild boots an agent with its
    // whole history to load, and 30s used to fail exactly the agents that had
    // been used the most.
    await waitForHealthy(provider, runtimeRef, sleep, 120);
    log('runtime.healthy', { agentId, runtimeRef });
    log('runtime.syncing', { agentId });
    await syncGitDataSources(deps, agentId, runtimeRef, log);
    // Step 7.6: attached platform connections (Google via gog) land on the
    // volume — best-effort per connection; a Google hiccup never fails a
    // build, and import is idempotent so the next provision heals it.
    await syncConnections({ store, secrets: deps.secrets, provider, log }, agentId, runtimeRef)
      .catch((err) => log('connection.sync_failed', { agentId, error: String(err).slice(0, 200) }));
    await syncDataSourceDocs(deps, agentId, runtimeRef, log);
    await syncInstallDocs(deps, agentId, runtimeRef, log);
    await runRebuildHook(deps, agentId, runtimeRef, log);
    log('runtime.settling', { agentId });
    await waitForSkillsSettled(provider, runtimeRef, agent.slug, sleep, log);
    await reindexMemoryIfSwitched(deps, agentId, runtimeRef, log);
    log('runtime.rebuilt', { agentId, runtimeRef });
    const live = store.setAgentState(agentId, 'RUNNING');
    void explainFailedCheckpoint();
    return live;
  } catch (err) {
    const reason = userMessageFor(err);
    log('rebuild.failed', { agentId, reason, error: String(err) });
    forgetEmbedDecision(agentId);
    // The container may be up and POLLING THE BOT (a health timeout means
    // "slow", not "dead") while the card says FAILED — and reconcile never
    // mends running+FAILED. Stop it so a failed rebuild is actually stopped,
    // which is also what the health-timeout message promises the user.
    const ref = store.getAgent(agentId)?.runtimeRef;
    if (ref) await provider.stop(ref).catch(() => {});
    store.setAgentState(agentId, 'FAILED', reason);
    return store.getAgent(agentId)!;
  }
}

/**
 * Record what the runtime is actually running. Called only after a provider
 * accepted the rendered spec — recording at render time made a failed rebuild
 * claim the new model while the old container kept running the old one.
 */
export function recordApplied(store: Store, agentId: string): void {
  const agent = store.getAgent(agentId);
  const profile = agent && store.getAIProfile(agent.aiProfileId);
  if (agent && profile) store.setAgentApplied(agentId, profile.id, effectiveModel(agent, profile));
  const d = embedDecision.get(agentId);
  if (d) {
    store.setAgentEmbedApplied(agentId, d.used);
    store.commitEmbedToken(agentId); // the old key retires now that the new container is accepted
    embedDecision.delete(agentId);   // consumed: a later live model apply must not stamp a stale one
    embedToIndex.set(agentId, d);
  }
}

/** A build that never got accepted: its decision must not be applied later (27th audit). */
export function forgetEmbedDecision(agentId: string): void {
  embedDecision.delete(agentId);
  embedToIndex.delete(agentId);
}

/** What buildRuntimeSpec decided about memory search, until the provider accepts the build… */
const embedDecision = new Map<string, { used: 'baked' | 'shared'; before: 'baked' | 'shared'; openclawVersion?: string }>();
/** …and then, for the re-index step that follows. */
const embedToIndex = new Map<string, { used: 'baked' | 'shared'; before: 'baked' | 'shared'; openclawVersion?: string }>();

/**
 * Changing the memory-search engine changes OpenClaw's index identity: vector
 * search pauses until the index is rebuilt, and it does not rebuild itself.
 * After a build that switched (either way), rebuild it — minutes, in the
 * container, with a warning on the agent if it fails, never a failed build.
 */
export async function reindexMemoryIfSwitched(
  deps: ProvisionDeps,
  agentId: string,
  runtimeRef: string,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  const { store, provider } = deps;
  const d = embedToIndex.get(agentId);
  embedToIndex.delete(agentId);
  const agent = store.getAgent(agentId);
  if (!d || !agent) return;
  // Only a SWITCH re-indexes — plus a shared agent whose index was never
  // confirmed. A baked agent with no record is simply how every agent has
  // always been; treating that as "never indexed" forced a fleet-wide
  // re-index on the next Rebuild all (27th audit).
  const switched = d.used !== d.before;
  const sharedUnconfirmed = d.used === 'shared' && !agent.embedIndexedAt;
  // On 2026.8+ the memory store itself moved (sessions are indexed too): an
  // agent carried over from 2026.7 comes up with a partial index ("7/10
  // files") until one forced pass (To Do Agent, 2026-09-24). Ask first, so
  // a routine rebuild on 2026.9 costs one status call, not a re-index.
  let incomplete = false;
  if (!switched && !sharedUnconfirmed && needsPortHeal(d.openclawVersion)) {
    const st = await provider.exec(runtimeRef, ['memory', 'status', '--agent', agent.slug], { timeoutMs: 120_000 })
      .catch((err) => ({ code: -1, stdout: '', stderr: String(err) }));
    const m = /Indexed:\s*(\d+)\s*\/\s*(\d+)/i.exec(`${st.stdout}\n${st.stderr}`);
    incomplete = !!m && Number(m[1]) < Number(m[2]);
  }
  if (!switched && !sharedUnconfirmed && !incomplete) return;
  log('memory.reindex', { agentId, engine: d.used, was: d.before, ...(incomplete ? { why: 'index incomplete' } : {}) });
  const index = () => provider.exec(runtimeRef, ['memory', 'index', '--force', '--agent', agent.slug], { timeoutMs: 10 * 60_000 })
    .catch((err) => ({ code: -1, stdout: '', stderr: String(err) }));
  let res = await index();
  if (res.code !== 0) {
    // A shared engine restarting under load answers 502 for a few seconds
    // (2026-09-23): one more try after a pause, before it counts as failed.
    log('memory.reindex_retry', { agentId });
    await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(15_000);
    res = await index();
  }
  if (res.code !== 0) {
    const error = `memory index failed: ${(res.stderr || res.stdout).trim().slice(-300)}`;
    store.setAgentEmbedIndex(agentId, null, error);
    log('memory.reindex_failed', { agentId, error });
    return;
  }
  // Ask OpenClaw itself whether the provider answers; a bad door address or key shows here.
  const status = await provider.exec(runtimeRef, ['memory', 'status', '--deep', '--agent', agent.slug], { timeoutMs: 120_000 })
    .catch((err) => ({ code: -1, stdout: '', stderr: String(err) }));
  const text = `${status.stdout}\n${status.stderr}`;
  // What OpenClaw prints when the provider answers: "Embeddings: ready".
  const ready = status.code === 0 && /embeddings:\s*ready/i.test(text);
  store.setAgentEmbedIndex(agentId, ready ? new Date().toISOString() : null, ready ? null : `memory search not ready: ${text.trim().slice(-300)}`);
  log(ready ? 'memory.reindexed' : 'memory.reindex_not_ready', { agentId, engine: d.used });
}

/**
 * The model an agent actually runs: its own override if set, else the
 * profile's default. Local profiles ignore the override — only one model fits
 * in the GPU's memory, so every local agent follows the profile's one model.
 *
 * The override is honoured ONLY while it is still on the profile's menu. A pin
 * validated when set can go stale later — the owner edits the source and drops
 * that model, or changes the default. This is the last line that decides what
 * reaches the runtime, so it falls back to the default rather than write a
 * model the source can no longer serve (which would green-build then die on
 * first use). Keeping the guarantee here means it holds no matter how the pin
 * went stale, not just on the paths we remembered to sweep.
 */
export function effectiveModel(
  agent: { model?: string },
  profile: { vendor: string; model: string; models?: string[] },
): string {
  if (profile.vendor === 'local') return profile.model;
  if (!agent.model) return profile.model;
  const menu = [profile.model, ...(profile.models ?? [])];
  return menu.includes(agent.model) ? agent.model : profile.model;
}

/** The `<provider>/<model>` ref OpenClaw wants — for a live `openclaw models
 *  set`, matching how configWriter prefixes the model at provision. */
export function prefixedModelRef(
  agent: { model?: string },
  profile: { vendor: string; model: string; models?: string[] },
): string {
  const provider = profile.vendor === 'local' ? 'ollama' : profile.vendor === 'google' ? 'google' : 'anthropic';
  return `${provider}/${effectiveModel(agent, profile)}`;
}

/**
 * Clone (or refresh) each git data source inside the running container. Runs on
 * every provision and rebuild, and is idempotent (buildGitSyncScript only clones
 * when the tree is absent). Best-effort: a repo whose deploy key the owner
 * hasn't added yet fails to clone — that's theirs to fix (add the key, rebuild),
 * and it must never fail the whole boot. Errors land in the event log.
 */
export async function syncGitDataSources(
  deps: ProvisionDeps,
  agentId: string,
  runtimeRef: string,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  const { store, secrets, provider } = deps;
  const agent = store.getAgent(agentId);
  if (!agent) return;
  for (const d of store.listDataSources(agentId)) {
    if (d.kind !== 'git' || !d.repoUrl) continue;
    const publicRepo = isPublicGitUrl(d.repoUrl);
    const host = /^git@([^:]+):/.exec(d.repoUrl)?.[1];
    if (!publicRepo && (!d.secretRef || !host)) continue;
    try {
      const commit = { name: agent.name, email: `${agent.slug}@hatchabot.local` };
      const script = publicRepo
        ? buildPublicGitSyncScript({ mountName: d.mountName, httpsUrl: d.repoUrl }, commit)
        : buildGitSyncScript(
            { mountName: d.mountName, sshUrl: d.repoUrl, host: host! },
            Buffer.from(await secrets.get(d.secretRef!), 'utf8').toString('base64'),
            commit,
          );
      const res = await provider.execShell(runtimeRef, script);
      if (res.code !== 0) {
        // Persist the reason on the source, not just in the audit log — a repo
        // that never cloned (nearly always: its deploy key isn't on the host
        // yet) has to be visible on the card, or it hides among the successes.
        store.setDataSourceSync(agentId, d.id, gitSyncReason(res.stderr, publicRepo ? 'public' : 'deploy-key'));
        log('datasource.git_sync_failed', { agentId, mountName: d.mountName, stderr: res.stderr.slice(0, 300) });
      } else {
        store.setDataSourceSync(agentId, d.id); // success clears any old failure
        log('datasource.git_synced', { agentId, mountName: d.mountName });
      }
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      store.setDataSourceSync(agentId, d.id, msg.slice(0, 300));
      log('datasource.git_sync_error', { agentId, mountName: d.mountName, error: msg });
    }
  }
}

/**
 * Keep AGENTS.md's "## Data sources" section in step with what the agent
 * actually has mounted/checked out. Without this, adding a repo dropped the
 * files on the volume and left the agent with no idea they existed — the owner
 * had to describe the paths by hand. Only that one section is rewritten; the
 * rest of the file is the user's. Best-effort: a failure here must never fail a
 * provision or rebuild.
 */
export async function syncDataSourceDocs(
  deps: ProvisionDeps,
  agentId: string,
  runtimeRef: string,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  const { store, provider } = deps;
  const agent = store.getAgent(agentId);
  if (!agent) return;
  // Legacy shared folders are read-only mounts and belong in the list too.
  const sources = [
    ...(agent.sharedPaths ?? []).map((p) => ({
      kind: 'folder',
      access: 'ro',
      mountName: basename(p.replace(/\/+$/, '')),
      hostPath: p,
    })),
    ...store.listDataSources(agentId),
  ];
  const path = `/home/node/.openclaw/agents/${agent.slug}/agent/AGENTS.md`;
  const q = JSON.stringify(path);
  try {
    // Read → compute HERE → write, applying BOTH platform-managed AGENTS.md
    // sections in ONE read-modify-write: the data-sources list AND the
    // memory-policy habit. Folding memory-policy in here (rather than a second
    // sync) means a single write, and it reaches EXISTING agents on rebuild —
    // not just freshly-seeded ones (2026-09-06: the memory-save/recover
    // instruction otherwise never landed on agents already created).
    const read = await provider.execShell(runtimeRef, `cat ${q} 2>/dev/null || true`);
    if (read.code !== 0 || !read.stdout.trim()) return; // no file yet — seed owns it
    let next = replaceSection(read.stdout, DATA_SOURCES_HEADING, dataSourcesSection(sources));
    next = replaceSection(next, '## Memory policy', memoryPolicySection(agent.sharedMemory));
    // Its memory budget: what its container has, so it sizes jobs to fit.
    next = replaceSection(next, '## Memory budget', memoryBudgetSection(memoryCapFor(store, agent)));
    // The operator identity: injected so every agent already knows who it serves.
    next = replaceSection(next, OPERATOR_HEADING, operatorSection(store.getOperatorProfile(agent.ownerId)));
    // The management agent's own notes are Hatchabot's: keep the sections that
    // go stale between releases current on every build, instead of only when
    // the agent was first created (it refused work it could do, 2026-09-19).
    if (agent.ops) {
      for (const heading of OPS_MANAGED_HEADINGS) {
        const section = opsSection(heading);
        if (section) next = replaceSection(next, heading, section);
      }
    }
    // Agent-to-agent: install the call-agent tool + peer manifest, and list the
    // granted peers in AGENTS.md so the agent knows it can consult them.
    const peers = store.listAgentPeers(agentId).map((id) => store.getAgent(id)).filter((a): a is Agent => !!a && a.state !== 'DELETED');
    if (peers.length) {
      next = replaceSection(next, '## Peers', peerToolsSection(peers.map((p) => ({ name: p.name }))));
      const b64s = Buffer.from(CALL_AGENT_SCRIPT, 'utf8').toString('base64');
      const b64m = Buffer.from(JSON.stringify(peers.map((p) => ({ name: p.name, id: p.id }))), 'utf8').toString('base64');
      await provider
        .execShell(
          runtimeRef,
          `set -e; mkdir -p ~/.local/bin ~/.openclaw; ` +
            `echo ${JSON.stringify(b64s)} | base64 -d > ~/.local/bin/call-agent && chmod 755 ~/.local/bin/call-agent; ` +
            `echo ${JSON.stringify(b64m)} | base64 -d > ~/.openclaw/peers.json`,
        )
        .catch((e) => log('peer_tools.failed', { agentId, error: String((e as Error).message ?? e) }));
    } else {
      // No grant: make sure a previous one isn't still advertised/installed.
      next = removeSection(next, '## Peers');
      await provider
        .execShell(runtimeRef, 'rm -f ~/.local/bin/call-agent ~/.openclaw/peers.json')
        .catch(() => {});
    }
    if (next === read.stdout) return; // already current: never churn the user's file
    const b64 = Buffer.from(next, 'utf8').toString('base64');
    // tmp+mv so a failure can't leave AGENTS.md truncated.
    const res = await provider.execShell(
      runtimeRef,
      `set -e; echo ${JSON.stringify(b64)} | base64 -d > ${q}.tmp && mv ${q}.tmp ${q}`,
    );
    if (res.code !== 0) log('agentsmd.sync_failed', { agentId, stderr: res.stderr.slice(0, 300) });
    else log('agentsmd.synced', { agentId, sources: sources.length });
  } catch (e) {
    log('agentsmd.sync_error', { agentId, error: String((e as Error).message ?? e) });
  }
}

/**
 * Write the install conventions into the agent's TOOLS.md (managed section).
 *
 * Unlike syncDataSourceDocs this CREATES the file when it is missing: OpenClaw
 * seeds TOOLS.md lazily on first boot, and a brand-new agent reaches this step
 * before that has happened. replaceSection appends when the heading is absent
 * and rewrites in place when present, so an agent's own notes around the
 * section survive every rebuild.
 */
async function syncInstallDocs(
  deps: ProvisionDeps,
  agentId: string,
  runtimeRef: string,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  const { store, provider } = deps;
  const agent = store.getAgent(agentId);
  if (!agent) return;
  const path = `/home/node/.openclaw/agents/${agent.slug}/agent/TOOLS.md`;
  const q = JSON.stringify(path);
  try {
    const read = await provider.execShell(runtimeRef, `cat ${q} 2>/dev/null || true`);
    const current = read.code === 0 ? read.stdout : '';
    const base = current.trim() ? current : '# TOOLS.md - Local Notes\n';
    const next = replaceSection(base, INSTALL_HEADING, installConventionsSection());
    if (next === current) return; // already current: never churn the agent's file
    const b64 = Buffer.from(next, 'utf8').toString('base64');
    const res = await provider.execShell(
      runtimeRef,
      `set -e; echo ${JSON.stringify(b64)} | base64 -d > ${q}.tmp && mv ${q}.tmp ${q}`,
    );
    if (res.code !== 0) log('installdocs.failed', { agentId, stderr: res.stderr.slice(0, 300) });
    else log('installdocs.synced', { agentId });
  } catch (e) {
    log('installdocs.error', { agentId, error: String((e as Error).message ?? e) });
  }
}

/**
 * Run the agent's own `~/.openclaw/on-rebuild.sh`, if it wrote one.
 *
 * $HOME persists, so state and user-installed tools survive a rebuild by
 * themselves. What cannot survive is anything installed OUTSIDE $HOME — an apt
 * package, a system-wide binary — because /usr comes from the image. Rather
 * than grow a framework for that, the agent records how to reconstitute it in
 * one script it maintains itself, and we run it after every rebuild.
 *
 * Best-effort and bounded: a broken or slow hook must never fail a rebuild or
 * hold the agent hostage, so failures are logged and the run is capped.
 */
export async function runRebuildHook(
  deps: ProvisionDeps,
  agentId: string,
  runtimeRef: string,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  const { provider } = deps;
  const hook = '/home/node/.openclaw/on-rebuild.sh';
  try {
    const res = await provider.execShell(
      runtimeRef,
      `[ -x ${JSON.stringify(hook)} ] || exit 0; timeout 300 bash ${JSON.stringify(hook)} 2>&1 | tail -c 2000`,
    );
    if (res.code === 0 && !res.stdout.trim()) return; // absent, or silent success
    if (res.code === 0) log('rebuild_hook.ran', { agentId, output: res.stdout.slice(-500) });
    else log('rebuild_hook.failed', { agentId, code: res.code, output: (res.stdout || res.stderr).slice(-500) });
  } catch (e) {
    log('rebuild_hook.error', { agentId, error: String((e as Error).message ?? e) });
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

/**
 * Wait until the agent will not throw away its conversation on the first
 * message.
 *
 * Healthy is not the same as ready. An agent restored at 16:24 answered its
 * health check at 16:24:24 and was messaged 35 seconds later; that message
 * began a NEW session and the previous thread was archived. The same agent,
 * messaged five minutes after a restore, carried on exactly where it left off.
 * The difference is on our side: we call an agent live the moment its gateway
 * responds, while the things a reply is judged against are still moving — not
 * least because `runRebuildHook` may have just installed skills, seconds
 * earlier, on this very code path.
 *
 * So this waits for the agent's skill inventory to stop changing: two identical
 * readings in a row and it is settled. Deliberately a PROXY, not a claim about
 * the mechanism — the exact trigger inside OpenClaw is still unidentified
 * (docs/pre-production.md §9), and a probe that waits for the agent to stop
 * moving is useful whether or not skills are the cause. It is bounded and
 * never fails a provision: an agent that will not settle goes live anyway,
 * because a late agent beats a failed one.
 *
 * The measurement is logged, so the next question — is this the right proxy,
 * and how long does settling actually take — is answered by production rather
 * than by argument.
 */
export async function waitForSkillsSettled(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  sleep: (ms: number) => Promise<void>,
  log: (event: string, detail: Record<string, unknown>) => void,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? Number(process.env.HATCHABOT_READY_POLL_MS ?? 3000);
  const timeoutMs = opts.timeoutMs ?? Number(process.env.HATCHABOT_READY_TIMEOUT_MS ?? 90_000);
  const started = Date.now();
  let previous: string | undefined;
  let polls = 0;
  while (Date.now() - started < timeoutMs) {
    polls++;
    let fingerprint: string;
    try {
      const res = await provider.exec(runtimeRef, ['skills', 'check', '--agent', slug]);
      // A failing probe is itself "not settled" — an agent whose CLI can't yet
      // answer is exactly the state we're waiting out.
      fingerprint = res.code === 0 ? createHash('sha256').update(res.stdout).digest('hex') : `err:${res.code}`;
    } catch (err) {
      fingerprint = `throw:${String(err).slice(0, 40)}`;
    }
    if (previous !== undefined && fingerprint === previous && !fingerprint.startsWith('err')
        && !fingerprint.startsWith('throw')) {
      log('runtime.ready', { settled: true, afterHealthyMs: Date.now() - started, polls });
      return;
    }
    previous = fingerprint;
    await sleep(intervalMs);
  }
  // Bounded: going live late is a nuisance, refusing to go live is an outage.
  log('runtime.ready', { settled: false, afterHealthyMs: Date.now() - started, polls });
}

export async function waitForHealthy(
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
/**
 * Paths that must never be handed to an agent: they would give it the keys to
 * the whole installation rather than access to your data.
 */
export function sharePathProblem(p: string, opts: { home?: string } = {}): string | undefined {
  const home = opts.home ?? homedir();
  if (!p.startsWith('/')) return 'Use an absolute path.';
  let norm = resolve(p).replace(/\/+$/, '') || '/';
  if (norm === '/') return 'Sharing the whole filesystem is not allowed.';
  // Judge the real location: a symlink inside an already-shared folder must
  // not become a door to ~/.ssh. Non-existent paths are judged lexically.
  try {
    if (lstatSync(norm).isSymbolicLink()) return `Refusing ${norm}: it is a symlink — share the real folder instead.`;
    norm = realpathSync(norm);
  } catch { /* not there yet — lexical check below */ }
  if (norm === home) return 'Sharing your whole home folder is not allowed — pick a folder inside it.';
  const dataDir = dirname(resolve(process.env.HATCHABOT_DB ?? 'data/hatchabot.sqlite'));
  const forbidden = [
    [resolve(home, '.claude'), 'that holds your Claude credentials'],
    [resolve(home, '.ssh'), 'that holds your SSH keys'],
    [resolve(home, '.config/hatchabot'), 'that holds Hatchabot access tokens'],
    [resolve(home, '.config/agentclaw'), 'that holds Hatchabot access tokens'],
    ['/etc', 'system configuration'],
    ['/root', "the root user's home"],
    ['/var/lib/docker', 'every agent volume, including other agents'],
    ['/proc', 'kernel state'],
    ['/sys', 'kernel state'],
    ['/var/run/docker.sock', 'the Docker socket — root on this machine'],
    ['/run/docker.sock', 'the Docker socket — root on this machine'],
    [dataDir, 'the Hatchabot database and secret store'],
    [resolve(home, 'hatchabot-prod'), 'the Hatchabot installation (.env holds the secret key)'],
    [resolve(home, 'agentclaw-prod'), 'the Hatchabot installation (.env holds the secret key)'],
    [resolve(home, 'hatchabot-backups'), 'every backup, including other agents'],
    [resolve(home, 'agentclaw-backups'), 'every backup, including other agents'],
    [resolve(home, '.docker'), 'Docker credentials'],
    [resolve(home, '.aws'), 'cloud credentials'],
    [resolve(home, '.gnupg'), 'your GPG keys'],
    [resolve(home, '.kube'), 'cluster credentials'],
    [resolve(home, '.config'), 'application credentials (share a folder inside it, not the whole thing)'],
  ] as const;
  for (const [bad, why] of forbidden) {
    // Inside a forbidden path, or an ANCESTOR of one (sharing /var hands over docker.sock).
    if (norm === bad || norm.startsWith(`${bad}/`) || bad.startsWith(`${norm}/`)) return `Refusing ${norm}: ${why}.`;
  }
  return undefined;
}

export function claudeAuthDir(): string {
  return `${process.env.HOME ?? '/root'}/.claude`;
}

function envForProfile(vendor: string, key: string): Record<string, string> {
  switch (vendor) {
    case 'anthropic':
      return { ANTHROPIC_API_KEY: key };
    case 'google':
      return { GEMINI_API_KEY: key };
    case 'openai':
      return { OPENAI_API_KEY: key };
    default:
      throw new Error(`Unsupported AI vendor: ${vendor}`);
  }
}

function userMessageFor(err: unknown): string {
  if (err instanceof ProviderError) return err.userMessage;
  if (err && typeof err === 'object' && 'userMessage' in err) {
    return String((err as { userMessage: unknown }).userMessage);
  }
  // An error nobody wrote a sentence for still has to say something the owner
  // can act on or send on. The cause is redacted, never raw (docs/audit-2026-09-19.md).
  const cause = briefCause(err);
  return cause
    ? `Something went wrong setting up your agent. Try again? (${cause})`
    : 'Something went wrong setting up your agent. Try again?';
}

/** A messaging identity that already belongs to another agent. */
export class ChannelConflictError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'ChannelConflictError';
  }
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'agent';
}
