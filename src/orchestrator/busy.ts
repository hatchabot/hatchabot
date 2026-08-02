/**
 * Agents with an operation in flight right now (provision, rebuild, import,
 * migrate). Reconcile must leave these alone: it judges an agent by what
 * docker reports, and mid-operation that is meaningless — a container being
 * created looks "absent", one being replaced looks "stopped".
 *
 * Getting this wrong is not cosmetic. Reconcile marking an importing agent
 * FAILED made the import's final `setAgentState('RUNNING')` an illegal
 * transition, which surfaced to the user as a rolled-back migration.
 */
const busy = new Set<string>();

export function markBusy(agentId: string): void {
  busy.add(agentId);
}

export function clearBusy(agentId: string): void {
  busy.delete(agentId);
}

export function isBusy(agentId: string): boolean {
  return busy.has(agentId);
}

/** Run `fn` with the agent marked busy, clearing it however that ends. */
export async function whileBusy<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  markBusy(agentId);
  try {
    return await fn();
  } finally {
    clearBusy(agentId);
  }
}
