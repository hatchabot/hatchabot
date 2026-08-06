import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';
import { exportAgent, TransferError } from './transfer.js';
import { existsSync } from 'node:fs';
import type { ProvisionDeps } from './provision.js';
import { whileBusy } from './busy.js';

/**
 * Move an agent to another AgentClaw installation in one action.
 *
 * The hard constraint is that a Telegram bot token may only be polled by ONE
 * runtime — two live copies flip-flop messages between them. So the order is
 * chosen so that at every instant the agent is running on at most one side:
 *
 *   1. preflight   — ask the destination if it *would* accept, changing nothing
 *   2. export      — snapshots and STOPS the source (now nobody is polling)
 *   3. import      — destination provisions and starts (now it is the only one)
 *   4. verify      — destination reports RUNNING, or we undo
 *
 * On any failure before step 4 succeeds, the source is restarted and the
 * destination has already rolled itself back — so a failed migration leaves
 * exactly the state you began with. The source is deliberately left STOPPED
 * rather than deleted: an automatic delete would make a wrong migration
 * unrecoverable, and the archive is not kept.
 */

export interface Peer {
  id: string;
  name: string;
  url: string;
  secretRef: string;
}

export interface MigrateDeps extends ProvisionDeps {
  secrets: SecretStore;
}

export class MigrateError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'MigrateError';
  }
}

export interface PreflightAnswer {
  ok: boolean;
  /** Why not, in words the owner can act on. */
  reasons: string[];
  /** Machine-readable tags for refusals the owner may want to override. */
  warnings?: string[];
  /** What the destination would use, so the owner can sanity-check it. */
  hostName?: string;
  aiProfileName?: string;
  aiModel?: string;
}

/**
 * Answer "would I accept this agent?" without changing anything. Every reason
 * here is a failure the import would otherwise hit halfway through.
 */
export function preflight(
  store: Store,
  ownerId: string,
  req: { slug: string; accountId: string; vendor?: string; sharedPaths?: string[] },
): PreflightAnswer {
  const reasons: string[] = [];

  if (store.listAllActiveAgents().some((a) => a.slug === req.slug)) {
    reasons.push(`An agent with id "${req.slug}" already lives here.`);
  }
  if (store.findAgentUsingAccount(req.accountId)) {
    reasons.push(`Bot @${req.accountId} is already wired to an agent here.`);
  }

  const hosts = store.listHosts(ownerId);
  const host = hosts.find((h) => h.kind === 'local') ?? hosts[0];
  if (!host) reasons.push('No host is configured here to run it.');

  const profiles = store.listAIProfiles(ownerId);
  const match = profiles.find((p) => p.vendor === req.vendor);
  const profile = match ?? profiles[0];
  if (!profile) reasons.push('No AI source is configured here.');

  // A vendor mismatch is not a collision, but it IS a surprise: an agent
  // running on a local model would silently start billing an API, and one on
  // a subscription would need a credential this machine may not have. Refuse,
  // and let the owner set up a matching source or accept the change knowingly.
  const warnings: string[] = [];
  if (profile && req.vendor && !match) {
    const detail =
      req.vendor === 'local'
        ? `it runs on a local model, and this machine has no local model server configured — ` +
          `it would fall back to ${profile.name} (${profile.model}).`
        : `it runs on "${req.vendor}", and this machine only offers ${profile.name} ` +
          `(${profile.vendor}/${profile.model}).`;
    reasons.push(`No matching AI source: ${detail}`);
    warnings.push('vendor-mismatch');
  }

  // Folder shares are host paths. Say so rather than let the agent arrive
  // quietly blind to the data it was built around.
  const missingPaths = (req.sharedPaths ?? []).filter((p) => !existsSync(p));
  if (missingPaths.length) {
    reasons.push(
      `It reads ${missingPaths.length} folder(s) that do not exist here (${missingPaths
        .slice(0, 2)
        .join(', ')}). Create them, or re-share different folders after the move.`,
    );
    warnings.push('missing-shared-paths');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    hostName: host?.name,
    aiProfileName: profile?.name,
    aiModel: profile?.model,
  };
}

async function peerFetch(
  deps: MigrateDeps,
  peer: Peer,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const token = await deps.secrets.get(peer.secretRef);
  return fetch(`${peer.url.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

/**
 * Did the agent actually arrive at the destination? Consulted only when the
 * import call itself gave no answer. Three-state on purpose, like
 * botPollState: "couldn't ask" must never read as "it isn't there".
 *
 * A slug still PROVISIONING means the import is mid-flight over there — its
 * own rollback will either finish it or remove it, so wait it out rather
 * than guess.
 */
async function destinationHasAgent(
  deps: MigrateDeps,
  peer: Peer,
  slug: string,
): Promise<'yes' | 'no' | 'unknown'> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 12; attempt++) {
    if (attempt > 0) await sleep(15_000);
    let agents: Array<{ slug?: string; state?: string }>;
    try {
      const res = await peerFetch(deps, peer, '/v1/agents', { method: 'GET' });
      if (!res.ok) continue;
      agents = (await res.json()) as Array<{ slug?: string; state?: string }>;
    } catch {
      continue;
    }
    const found = agents.find((a) => a.slug === slug);
    // A rolled-back import deletes its agent, so "not in the active list" is
    // a real answer: nothing landed.
    if (!found) return 'no';
    if (found.state === 'RUNNING') return 'yes';
    // Mid-import — keep waiting for its own success-or-rollback to resolve.
  }
  return 'unknown';
}

export interface MigrateResult {
  movedTo: string;
  remoteAgentId: string;
  /** The source is left stopped, not deleted — deleting it is the owner's call. */
  sourceState: string;
}

export async function migrateAgent(
  deps: MigrateDeps,
  agentId: string,
  peer: Peer,
): Promise<MigrateResult> {
  // Busy for the whole move: between export stopping the source and the
  // tombstone landing, the agent looks like an ordinary STOPPED agent — a
  // Start, Rebuild or Delete in that window boots or purges the copy whose
  // bot is about to belong elsewhere. (Routes check isBusy; this also stops
  // reconcile from judging the stopped source mid-move.)
  return whileBusy(agentId, () => migrateAgentInner(deps, agentId, peer));
}

async function migrateAgentInner(
  deps: MigrateDeps,
  agentId: string,
  peer: Peer,
): Promise<MigrateResult> {
  const { store, provider } = deps;
  const log = deps.log ?? (() => {});
  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new MigrateError('This agent has no runtime to move.');
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new MigrateError(`Can't move an agent while it is ${agent.state}.`);
  }
  const channel = store.getChannelForAgent(agentId);
  if (!channel) throw new MigrateError('This agent has no messaging identity to move.');
  const profile = store.getAIProfile(agent.aiProfileId);

  // 1. Preflight — nothing has changed yet, so a refusal is free.
  let answer: PreflightAnswer;
  try {
    const res = await peerFetch(deps, peer, '/v1/agents/preflight', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: agent.slug,
        accountId: channel.accountId,
        vendor: profile?.vendor,
        sharedPaths: agent.sharedPaths,
      }),
    });
    if (res.status === 401) throw new MigrateError(`${peer.name} rejected our access token.`);
    if (!res.ok) throw new MigrateError(`${peer.name} answered ${res.status} to the preflight check.`);
    answer = (await res.json()) as PreflightAnswer;
  } catch (err) {
    if (err instanceof MigrateError) throw err;
    throw new MigrateError(`Couldn't reach ${peer.name} at ${peer.url}.`);
  }
  if (!answer.ok) {
    throw new MigrateError(`${peer.name} can't accept this agent: ${answer.reasons.join(' ')}`);
  }
  log('migrate.preflight_ok', { agentId, peer: peer.name });

  // 2. Export — this STOPS the source, so from here nothing is polling the bot.
  const wasRunning = agent.state === 'RUNNING';
  const { data } = await exportAgent(deps, agentId);
  log('migrate.exported', { agentId, bytes: data.length });

  /** Put the source back exactly as we found it. */
  const undo = async (why: string) => {
    log('migrate.rolled_back', { agentId, why });
    if (wasRunning) {
      try {
        await provider.start(agent.runtimeRef!);
        store.setAgentState(agentId, 'RUNNING');
      } catch (err) {
        log('migrate.restart_failed', { agentId, error: String(err) });
      }
    }
  };

  // 3. Import on the destination. Its own rollback guarantees it leaves
  //    nothing behind if this fails, so we only have to undo our side.
  let remote: { id: string; state: string; name: string };
  try {
    const res = await peerFetch(deps, peer, '/v1/agents/import', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(data),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      // A real answer from the destination: it refused and rolled back.
      await undo(`import rejected: ${body.error ?? res.status}`);
      throw new MigrateError(
        `${peer.name} couldn't import it: ${body.error ?? res.status}. Your agent is unchanged.`,
      );
    }
    remote = body;
  } catch (err) {
    if (err instanceof MigrateError) throw err;
    // NO answer from the destination — which is not the same as "it failed".
    // The import takes minutes (volume restore + health wait); a dropped
    // connection or proxy timeout can lose the response AFTER the destination
    // committed and started polling. Restarting the source on that guess is
    // how a "failed" migration ends with two live pollers. Ask before undoing.
    const landed = await destinationHasAgent(deps, peer, agent.slug);
    if (landed === 'no') {
      await undo(`transfer failed: ${String(err)}`);
      throw new MigrateError(`The transfer to ${peer.name} failed. Your agent is unchanged.`);
    }
    if (landed === 'yes') {
      log('migrate.landed_despite_error', { agentId, peer: peer.name, error: String(err) });
      store.setAgentMigratedTo(
        agentId,
        `${peer.name} (${new Date().toISOString().slice(0, 10)})`,
      );
      throw new MigrateError(
        `The connection to ${peer.name} dropped, but the agent DID arrive and is running there. ` +
          `This copy stays stopped and marked as moved.`,
      );
    }
    // Can't tell. Leaving the source stopped is recoverable (the owner can
    // start it once they've looked); starting it next to a live copy is not.
    throw new MigrateError(
      `The transfer to ${peer.name} failed and we couldn't confirm whether the agent arrived ` +
        `there. This copy is left stopped to be safe — check ${peer.name}, then either delete ` +
        `this copy (it arrived) or start it again (it didn't).`,
    );
  }

  // 4. Verify it actually came up there before we consider this done.
  if (remote.state !== 'RUNNING') {
    await undo(`remote state ${remote.state}`);
    throw new MigrateError(
      `${peer.name} accepted the agent but it is ${remote.state} there. Your agent is unchanged — ` +
        `check that server before trying again.`,
    );
  }

  // Tombstone the source. Without this nothing stops a later Start, Rebuild
  // or Retry from resurrecting a copy whose bot now belongs elsewhere — which
  // is exactly how a "successful" move ends with two live pollers.
  store.setAgentMigratedTo(
    agentId,
    `${peer.name} (${new Date().toISOString().slice(0, 10)})`,
  );
  log('migrate.done', { agentId, peer: peer.name, remoteAgentId: remote.id });
  return {
    movedTo: peer.name,
    remoteAgentId: remote.id,
    sourceState: store.getAgent(agentId)!.state,
  };
}

export { TransferError };
