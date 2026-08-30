import type { AgentState } from './types.js';

/**
 * §11.4: PROVISIONING → RUNNING → (STOPPED ⇄ RUNNING) → DELETING → DELETED,
 * plus FAILED from any provisioning step.
 *
 * ARCHIVED is a STOPPED that has given its Telegram bot back. Telegram caps
 * how many bots one account may own, so the token — not the container, not the
 * disk — is the scarce resource here; archiving parks an agent whole (memory,
 * volume, members) while freeing the one thing another agent can't do without.
 * Coming back is a re-PROVISION, because a bot must be leased again, and it
 * will be a DIFFERENT bot.
 *
 * Later states (HIBERNATING, MIGRATING) slot in by adding edges here and
 * nowhere else — that's the point of keeping transitions in one table.
 */
const TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  PROVISIONING: ['RUNNING', 'FAILED', 'DELETING'],
  RUNNING: ['STOPPED', 'ARCHIVED', 'REBUILDING', 'DELETING', 'FAILED'],
  STOPPED: ['RUNNING', 'ARCHIVED', 'REBUILDING', 'DELETING', 'FAILED'],
  // Restoring re-enters provisioning to lease a bot; deleting skips that.
  ARCHIVED: ['PROVISIONING', 'DELETING'],
  REBUILDING: ['RUNNING', 'FAILED', 'DELETING'],
  DELETING: ['DELETED', 'FAILED'],
  DELETED: [],
  FAILED: ['PROVISIONING', 'ARCHIVED', 'DELETING'],
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
