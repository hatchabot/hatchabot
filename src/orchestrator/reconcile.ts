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

      if (status.phase === 'absent' && (s === 'RUNNING' || s === 'STOPPED' || s === 'PROVISIONING')) {
        store.setAgentState(agent.id, 'FAILED', 'The agent runtime is missing — tap Retry to rebuild it.');
        log('reconcile.runtime_missing', { agentId: agent.id, was: s });
      } else if (status.phase === 'running' && s === 'STOPPED') {
        store.setAgentState(agent.id, 'RUNNING');
        log('reconcile.marked_running', { agentId: agent.id });
      } else if (status.phase === 'running' && s === 'PROVISIONING' && !agent.pendingAction) {
        // Provisioning finished but the control plane died before recording it.
        store.setAgentState(agent.id, 'RUNNING');
        log('reconcile.marked_running', { agentId: agent.id, was: s });
      } else if (status.phase === 'stopped' && s === 'RUNNING') {
        store.setAgentState(agent.id, 'STOPPED');
        log('reconcile.marked_stopped', { agentId: agent.id });
      } else if (status.phase === 'stopped' && s === 'PROVISIONING' && !agent.pendingAction) {
        store.setAgentState(agent.id, 'FAILED', 'Setup was interrupted — tap Retry.');
        log('reconcile.interrupted', { agentId: agent.id });
      }
    } catch (err) {
      log('reconcile.error', { agentId: agent.id, error: String(err) });
    }
  }
}
