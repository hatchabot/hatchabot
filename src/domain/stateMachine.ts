import type { AgentState } from './types.js';

/**
 * §11.4: PROVISIONING → RUNNING → (STOPPED ⇄ RUNNING) → DELETING → DELETED,
 * plus FAILED from any provisioning step.
 *
 * Later states (HIBERNATING, MIGRATING) slot in by adding edges here and
 * nowhere else — that's the point of keeping transitions in one table.
 */
const TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  PROVISIONING: ['RUNNING', 'FAILED', 'DELETING'],
  RUNNING: ['STOPPED', 'DELETING', 'FAILED'],
  STOPPED: ['RUNNING', 'DELETING', 'FAILED'], // FAILED: a rebuild can fail from stopped
  DELETING: ['DELETED', 'FAILED'],
  DELETED: [],
  FAILED: ['PROVISIONING', 'DELETING'],
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: AgentState,
    readonly to: AgentState,
  ) {
    super(`Illegal agent state transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: AgentState, to: AgentState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/** States where no further work should be scheduled against the agent. */
export function isTerminal(state: AgentState): boolean {
  return state === 'DELETED';
}
