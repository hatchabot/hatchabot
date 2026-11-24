import type { Agent } from '../../domain/types.js';
import { accessOverview, verifyAgentAccess, type AgentAccess, type VerifyResult } from './accessOverview.js';
import type { GoogleDeps, GoogleHelpers } from './connectionsAndAccess.js';

/**
 * Verify now (HB-0808, from src/api/routes.ts; docs/access-overview-design.md):
 * look inside the running agent, with no side effects, and record what is
 * there. One verification per agent at a time (`accessVerifies`, a lock):
 * each runs commands in the agent's container. Which agents the caller may
 * look at is the route's.
 */
export interface AccessChecks {
  /** `busy`: a verification of this agent is under way already. Otherwise what was found, and the overview after it. */
  verify(agent: Agent): Promise<'busy' | { result: VerifyResult; access: AgentAccess }>;
}

export function createAccessChecks(deps: GoogleDeps, helpers: GoogleHelpers): AccessChecks {
  const { store, trace } = deps;
  const { connSyncDeps } = helpers;
  /** Verify now: look inside the running agent (no side effects) and record what is there. */
  const accessVerifies = new Set<string>();
  const verify: AccessChecks['verify'] = async (agent) => {
    // One verification per agent at a time: each runs commands in the agent's container,
    // and nothing else bounded how often (CodeQL js/missing-rate-limiting #78, 2026-10-24).
    if (accessVerifies.has(agent.id)) return 'busy';
    accessVerifies.add(agent.id);
    try {
      const result = await verifyAgentAccess(connSyncDeps(agent.hostId), agent.id);
      trace(agent.id)('access.verified', result.status === 'checked' ? { checked: result.checked } : { notCheckable: result.reason });
      return { result, access: accessOverview(store, store.getAgent(agent.id) ?? agent) };
    } finally { accessVerifies.delete(agent.id); }
  };
  return { verify };
}
