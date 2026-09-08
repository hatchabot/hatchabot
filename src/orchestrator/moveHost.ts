import type { Agent } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import { whileBusy } from './busy.js';
import {
  buildRuntimeSpec,
  recordApplied,
  waitForHealthy,
  waitForSkillsSettled,
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
  // Two host rows pointing at one Docker daemon are the move's cardinal
  // hazard: container/volume names derive from the agentId, so the target ref
  // EQUALS the source ref, and "retire the source" (step 4) would purge the
  // volume we just moved onto — total, unrecoverable memory loss. Endpoint-
  // string equality can't catch this (ssh://h vs ssh://h:22, IP vs hostname,
  // a runner aliasing localhost, tcp vs ssh). The daemon's own ID can. Probe
  // both BEFORE touching anything; a daemon we can't reach → refuse, because
  // "can't verify they differ" must never green-light a destructive purge.
  let sourceDaemon: string;
  let targetDaemon: string;
  try {
    [sourceDaemon, targetDaemon] = await Promise.all([source.daemonId(), target.daemonId()]);
  } catch (err) {
    throw new TransferError(
      `Couldn't verify the two hosts are different machines, so the move was cancelled ` +
        `(a Docker daemon didn't answer). (${String(err instanceof Error ? err.message : err).slice(0, 200)})`,
    );
  }
  if (sourceDaemon === targetDaemon) {
    throw new TransferError(
      `${sourceHost.name} and ${targetHost.name} are the same Docker daemon — the agent already ` +
        `runs there. Remove the duplicate host entry instead of moving.`,
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

  // 3. Recreate on the target. hostId is NOT flipped yet — a crash between
  //    the flip and importState would leave the record pointing at a host
  //    with no data, and Retry would seed a fresh empty volume there while
  //    the real memory sits orphaned on the source. So we build the target
  //    spec against a host OVERRIDE (Max/host pairing re-checked there,
  //    host-folder mounts resolve against the target), and flip the store's
  //    hostId only once the snapshot has actually landed. Same double-
  //    provision as import: provision seeds, the snapshot overwrites, the
  //    second provision re-applies this install's config over openclaw.json.
  let newRef: string | undefined;
  let hostFlipped = false;
  try {
    const tdeps: ProvisionDeps = { ...deps, provider: target };
    const spec = await buildRuntimeSpec(tdeps, agentId, targetHost);
    ({ runtimeRef: newRef } = await target.provision(spec));
    await target.importState(newRef, state);
    // Data is on the target now — safe to point the record there.
    store.setAgentHost(agentId, targetHostId);
    hostFlipped = true;
    const respec = await buildRuntimeSpec(tdeps, agentId);
    await target.provision(respec);
    store.setAgentRuntimeRef(agentId, newRef);
    recordApplied(store, agentId);
    if (wasRunning) {
      await target.start(newRef);
      // Cold image / imported sessions: give it the import path's 2 minutes.
      await waitForHealthy(target, newRef, sleep, 120);
      // Settle skills/gateway before RUNNING so an early message doesn't start a
      // fresh session and archive the moved conversation (audit 2026-09-08).
      await waitForSkillsSettled(target, newRef, agent.slug, sleep, log);
      store.setAgentState(agentId, 'RUNNING');
    }
  } catch (err) {
    // Roll back onto the source host. Daemons are confirmed distinct (the
    // daemonId guard above), so purging the target runtime never touches the
    // source's storage.
    let targetOrphaned = false;
    if (newRef) {
      try {
        await target.destroy(newRef, { purge: true });
      } catch {
        // The destroy failed — and the failure that landed us here (a hung
        // remote daemon) is exactly what makes destroy fail too. If the target
        // container is still up it has --restart unless-stopped and will poll
        // the bot; restarting the source too = two pollers on one token, the
        // one thing worse than downtime. Verify before deciding.
        const alive = await target.status(newRef).then((s) => s.phase === 'running').catch(() => true);
        if (alive) targetOrphaned = true;
      }
    }
    if (hostFlipped) {
      store.setAgentHost(agentId, sourceHost.id);
      store.setAgentRuntimeRef(agentId, oldRef);
    }
    if (targetOrphaned) {
      // Do NOT restart the source — leave it stopped and shout, so an operator
      // resolves the orphan instead of a silent flip-flop.
      log('move.rollback_orphan', { agentId, target: targetHostId, ref: newRef });
      throw new TransferError(
        `Move failed and the copy on ${targetHost.name} couldn't be cleaned up — "${agent.name}" ` +
          `is left STOPPED to avoid two bots polling at once. Check ${targetHost.name} and remove ` +
          `the leftover container, then Start the agent.`,
      );
    }
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
  //    never a reason to unwind the move. Daemons are distinct (guard above),
  //    so this can't touch the moved volume.
  {
    try {
      await source.destroy(oldRef, { purge: true });
    } catch (err) {
      log('move.source_cleanup_failed', { agentId, host: sourceHost.id, error: String(err) });
    }
  }

  log('agent.moved', { agentId, from: sourceHost.id, to: targetHost.id, wasRunning });
  return store.getAgent(agentId)!;
}
