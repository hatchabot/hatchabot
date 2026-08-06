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

/** A second lifecycle operation arrived while one was still running. */
export class AgentBusyError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'AgentBusyError';
  }
}

/**
 * Run `fn` with the agent marked busy, clearing it however that ends.
 *
 * Exclusive: a caller arriving while the agent is already busy is refused,
 * not queued. Overlapping lifecycle operations (a Rebuild during a migrate's
 * stopped window, an adopt during a rebuild) don't merely race — they end in
 * two containers polling one bot token, or a container replaced underneath a
 * volume restore. Refusing loudly is the only safe answer.
 */
export async function whileBusy<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  if (busy.has(agentId)) {
    throw new AgentBusyError('Another operation is already running on this agent.');
  }
  markBusy(agentId);
  try {
    return await fn();
  } finally {
    clearBusy(agentId);
  }
}
