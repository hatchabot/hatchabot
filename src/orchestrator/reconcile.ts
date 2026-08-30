import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import { isBusy } from './busy.js';

/**
 * Boot-time truth sync: the registry's idea of each agent vs what the runtime
 * provider actually reports. Containers auto-restart with the box
 * (`--restart unless-stopped`) while the control plane's DB is frozen at
 * whatever it last wrote — after a reboot or crash the two can disagree, and
 * a lying status chip is worse than a red one.
 *
 * Rules are deliberately conservative: reconcile only mends states, it never
 * starts or destroys runtimes on its own.
 */
/**
 * Runs at boot AND on a timer. Docker's `--restart unless-stopped` covers a
 * process that exits; nothing covers a container that is up but wedged, which
 * is why the health bit is read rather than just the phase.
 */
export function startReconcileLoop(
  store: Store,
  providers: Map<string, RuntimeProvider>,
  log: (event: string, detail: Record<string, unknown>) => void,
  intervalMs = Number(process.env.AGENTCLAW_RECONCILE_MS ?? 120_000),
): NodeJS.Timeout {
  let running = false;
  const tick = async () => {
    if (running) return; // never overlap a slow sweep with the next one
    running = true;
    try {
      await reconcileAgents(store, providers, log);
    } catch (err) {
      log('reconcile.loop_error', { error: String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

export async function reconcileAgents(
  store: Store,
  providers: Map<string, RuntimeProvider>,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<void> {
  for (const listed of store.listAllActiveAgents()) {
    // RE-READ, never trust the listing. A sweep is one docker call per agent
    // and takes tens of seconds on a real fleet, so by the time we reach agent
    // #30 the row we listed can be a minute old. An agent that was mid-setup
    // when the sweep started — no runtime_ref yet, state PROVISIONING — has
    // since finished and gone RUNNING, and judging it on the stale copy marked
    // a working agent "Setup was interrupted" 21 seconds after it reported
    // healthy. The busy flag doesn't save us here: it was correctly cleared
    // when provisioning finished. It's the DATA that aged, not the lock.
    const agent = store.getAgent(listed.id);
    if (!agent || agent.state === 'DELETED') continue;
    // An agent mid-provision/rebuild/import looks broken to docker by
    // definition. Judging it here is how a healthy import got marked FAILED.
    if (isBusy(agent.id)) continue;
    // ARCHIVED is a deliberate resting state: stopped on purpose, no bot, and
    // possibly no container at all if the box was pruned. Every rule below
    // would read that as damage and "mend" it into FAILED or RUNNING.
    if (agent.state === 'ARCHIVED') continue;
    try {
      const host = store.getHost(agent.hostId);
      const provider = host && providers.get(host.provider);
      if (!provider) continue;

      if (!agent.runtimeRef) {
        // Parked on a human step (bot token) is a legitimate resting state.
        if (agent.state === 'PROVISIONING' && !agent.pendingAction) {
          store.setAgentState(agent.id, 'FAILED', 'Setup was interrupted — tap Retry.');
          log('reconcile.interrupted', { agentId: agent.id });
        }
        continue;
      }

      const status = await provider.status(agent.runtimeRef);
      // The docker call above is its own staleness window — a Start, Rebuild or
      // Delete can begin and finish inside it. Anything that moved underneath
      // us is judged on the NEXT sweep, with a status that matches the row.
      const now = store.getAgent(agent.id);
      if (
        !now ||
        isBusy(agent.id) ||
        now.state !== agent.state ||
        now.runtimeRef !== agent.runtimeRef ||
        !!now.pendingAction !== !!agent.pendingAction
      ) {
        continue;
      }
      const s = agent.state;

      // Docker unreachable: leave every agent exactly as it is. Guessing here
      // is how a healthy fleet gets marked FAILED after a reboot.
      if (status.phase === 'unknown') {
        log('reconcile.host_unreachable', { agentId: agent.id });
        continue;
      }

      if (
        status.phase === 'absent' &&
        (s === 'RUNNING' || s === 'STOPPED' || s === 'PROVISIONING' || s === 'REBUILDING')
      ) {
        store.setAgentState(agent.id, 'FAILED', 'The agent runtime is missing — tap Retry to rebuild it.');
        log('reconcile.runtime_missing', { agentId: agent.id, was: s });
      } else if (status.phase === 'running' && s === 'STOPPED') {
        store.setAgentState(agent.id, 'RUNNING');
        log('reconcile.marked_running', { agentId: agent.id });
      } else if (status.phase === 'running' && s === 'REBUILDING') {
        // Rebuild finished but the control plane died before recording it.
        store.setAgentState(agent.id, 'RUNNING');
        log('reconcile.marked_running', { agentId: agent.id, was: s });
      } else if (status.phase === 'running' && s === 'PROVISIONING' && !agent.pendingAction) {
        // Provisioning finished but the control plane died before recording it.
        store.setAgentState(agent.id, 'RUNNING');
        log('reconcile.marked_running', { agentId: agent.id, was: s });
      } else if (status.phase === 'stopped' && s === 'RUNNING') {
        store.setAgentState(agent.id, 'STOPPED');
        log('reconcile.marked_stopped', { agentId: agent.id });
      } else if (status.phase === 'stopped' && s === 'REBUILDING') {
        store.setAgentState(agent.id, 'FAILED', 'The rebuild was interrupted — tap Retry.');
        log('reconcile.interrupted', { agentId: agent.id, was: s });
      } else if (status.phase === 'stopped' && s === 'PROVISIONING' && !agent.pendingAction) {
        store.setAgentState(agent.id, 'FAILED', 'Setup was interrupted — tap Retry.');
        log('reconcile.interrupted', { agentId: agent.id });
      } else if (status.phase === 'running' && s === 'RUNNING' && !status.healthy) {
        // The container is up but its gateway isn't answering — the way an
        // agent actually dies. Previously invisible: the chip stayed green
        // and only "last active" quietly stopped moving.
        log('reconcile.unhealthy', { agentId: agent.id });
      } else if (status.phase === 'error' && s === 'RUNNING') {
        store.setAgentState(agent.id, 'FAILED', `The runtime reported an error: ${status.message}`);
        log('reconcile.runtime_error', { agentId: agent.id, message: status.message });
      }
    } catch (err) {
      log('reconcile.error', { agentId: agent.id, error: String(err) });
    }
  }
}
