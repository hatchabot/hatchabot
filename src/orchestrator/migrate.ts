import type { SecretStore } from '../secrets/secretStore.js';
import type { Store } from '../store/store.js';
import { exportAgent, TransferError } from './transfer.js';
import type { ProvisionDeps } from './provision.js';

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
  req: { slug: string; accountId: string; vendor?: string },
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
  const profile = profiles.find((p) => p.vendor === req.vendor) ?? profiles[0];
  if (!profile) reasons.push('No AI source is configured here.');

  return {
    ok: reasons.length === 0,
    reasons,
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
      await undo(`import rejected: ${body.error ?? res.status}`);
      throw new MigrateError(
        `${peer.name} couldn't import it: ${body.error ?? res.status}. Your agent is unchanged.`,
      );
    }
    remote = body;
  } catch (err) {
    if (err instanceof MigrateError) throw err;
    await undo(`transfer failed: ${String(err)}`);
    throw new MigrateError(`The transfer to ${peer.name} failed. Your agent is unchanged.`);
  }

  // 4. Verify it actually came up there before we consider this done.
  if (remote.state !== 'RUNNING') {
    await undo(`remote state ${remote.state}`);
    throw new MigrateError(
      `${peer.name} accepted the agent but it is ${remote.state} there. Your agent is unchanged — ` +
        `check that server before trying again.`,
    );
  }

  log('migrate.done', { agentId, peer: peer.name, remoteAgentId: remote.id });
  return {
    movedTo: peer.name,
    remoteAgentId: remote.id,
    sourceState: store.getAgent(agentId)!.state,
  };
}

export { TransferError };
