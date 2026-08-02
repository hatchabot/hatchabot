import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';

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
  for (const agent of store.listAllActiveAgents()) {
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
