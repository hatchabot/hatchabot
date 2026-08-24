import type { Agent } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import { whileBusy } from './busy.js';
import {
  buildRuntimeSpec,
  recordApplied,
  waitForHealthy,
  type ProvisionDeps,
} from './provision.js';
import { TransferError } from './transfer.js';

/**
 * Move an agent to another host on THIS control plane (local ⇄ runner, or
 * runner ⇄ runner). Unlike a peer Rehost — which ships the agent to another
 * AgentClaw server and tombstones the copy here — a move keeps the same agent
 * record, bot, members, and memory; only the Docker daemon running the
 * container changes. That makes it simpler and safer: one control plane, one
 * bot token, no second poller to fence off.
 *
 * Flow: quiesce → snapshot the volume through the source provider → flip
 * hostId → recreate on the target (provision, restore the snapshot, re-apply
 * config) → start there → retire the source runtime. Any failure before the
 * target is healthy rolls everything back onto the source host.
 *
 * Container/volume names are derived from the agent id, so the runtimeRef is
 * IDENTICAL on both daemons. Two consequences the code below leans on:
 *  - the store's runtimeRef never needs to change (set anyway, for legacy refs);
 *  - if source and target are the SAME daemon, "retiring the source" would
 *    destroy the runtime we just built — so it must be skipped (same provider
 *    instance) or the move refused up front (two host rows, one endpoint).
 */
export interface MoveDeps extends Omit<ProvisionDeps, 'provider'> {
  source: RuntimeProvider;
  target: RuntimeProvider;
}

export async function moveAgentToHost(
  deps: MoveDeps,
  agentId: string,
  targetHostId: string,
): Promise<Agent> {
  return whileBusy(agentId, () => moveInner(deps, agentId, targetHostId));
}

async function moveInner(deps: MoveDeps, agentId: string, targetHostId: string): Promise<Agent> {
  const { store, source, target } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const agent = store.getAgent(agentId);
  if (!agent?.runtimeRef) throw new TransferError('This agent has no runtime to move yet.');
  if (agent.state !== 'RUNNING' && agent.state !== 'STOPPED') {
    throw new TransferError(`Can't move while the agent is ${agent.state}.`);
  }
  const sourceHost = store.getHost(agent.hostId);
  const targetHost = store.getHost(targetHostId);
  if (!sourceHost || !targetHost) throw new TransferError('Unknown host.');
  if (sourceHost.id === targetHost.id) {
    throw new TransferError('The agent is already on that host.');
  }
  // Two host rows pointing at one Docker daemon: identical names mean the
  // final "retire the source" would purge the runtime we just moved. Refuse
  // the trap we can detect (endpoint string equality) before touching anything.
  const endpoint = (h: typeof sourceHost) =>
    typeof h.settings?.dockerHost === 'string' ? h.settings.dockerHost.trim() : '';
  if (endpoint(sourceHost) && endpoint(sourceHost) === endpoint(targetHost)) {
    throw new TransferError(
      'Both hosts point at the same Docker endpoint — the agent already runs there. ' +
        'Remove the duplicate host entry instead.',
    );
  }

  const oldRef = agent.runtimeRef;
  const wasRunning = agent.state === 'RUNNING';

  // 1. Quiesce. One bot, one poller: the source must stop before the copy on
  //    the target ever starts, and the volume must be still for the snapshot.
  if (wasRunning) {
    await source.stop(oldRef);
    store.setAgentState(agentId, 'STOPPED');
  }

  const restartSource = async () => {
    if (!wasRunning) return;
    // Only claim RUNNING if the container actually came back (export's rule).
    try {
      await source.start(oldRef);
      store.setAgentState(agentId, 'RUNNING');
    } catch (err) {
      log('move.source_restart_failed', { agentId, error: String(err) });
    }
  };

  // 2. Snapshot the volume. A failure here leaves the source fully intact.
  let state: Buffer;
  try {
    state = await source.exportState(oldRef);
  } catch (err) {
    await restartSource();
    throw new TransferError(
      `Couldn't read the agent's state — the move was cancelled. (${String(
        err instanceof Error ? err.message : err,
      ).slice(0, 300)})`,
    );
  }

  // 3. Recreate on the target. hostId flips first because buildRuntimeSpec
  //    reads it — the Max-credential/host pairing is re-checked there, and
  //    host-folder mounts resolve against the NEW host (a remote daemon skips
  //    them). Same double-provision as import: provision seeds, the snapshot
  //    then overwrites the volume, and the second provision re-applies this
  //    installation's current config over the imported openclaw.json.
  store.setAgentHost(agentId, targetHostId);
  let newRef: string | undefined;
  try {
    const tdeps: ProvisionDeps = { ...deps, provider: target };
    const spec = await buildRuntimeSpec(tdeps, agentId);
    ({ runtimeRef: newRef } = await target.provision(spec));
    await target.importState(newRef, state);
    const respec = await buildRuntimeSpec(tdeps, agentId);
    await target.provision(respec);
    store.setAgentRuntimeRef(agentId, newRef);
    recordApplied(store, agentId);
    if (wasRunning) {
      await target.start(newRef);
      // Cold image / imported sessions: give it the import path's 2 minutes.
      await waitForHealthy(target, newRef, sleep, 120);
      store.setAgentState(agentId, 'RUNNING');
    }
  } catch (err) {
    // Roll back onto the source host. Purge the half-made target runtime only
    // when the daemons differ — on a shared daemon that storage IS the source's.
    if (newRef && source !== target) {
      await target.destroy(newRef, { purge: true }).catch(() => {});
    }
    store.setAgentHost(agentId, sourceHost.id);
    store.setAgentRuntimeRef(agentId, oldRef);
    await restartSource();
    log('move.rolled_back', { agentId, to: targetHostId, error: String(err) });
    throw new TransferError(
      `Move failed and was rolled back — the agent stays on ${sourceHost.name}. (${String(
        err instanceof Error ? err.message : err,
      ).slice(0, 300)})`,
    );
  }

  // 4. Retire the source runtime, volume included. Best-effort: the agent is
  //    already live on the target, so a failure here is an orphan to clean up,
  //    never a reason to unwind the move. Skipped when both hosts share one
  //    provider instance — there is no separate source runtime to retire.
  if (source !== target) {
    try {
      await source.destroy(oldRef, { purge: true });
    } catch (err) {
      log('move.source_cleanup_failed', { agentId, host: sourceHost.id, error: String(err) });
    }
  }

  log('agent.moved', { agentId, from: sourceHost.id, to: targetHost.id, wasRunning });
  return store.getAgent(agentId)!;
}
