import type { Store } from '../../store/store.js';
import { agentRecommendations, buildRecommendations, type Recommendation, type RecommendationList } from './recommendations.js';

/**
 * Recommended (HB-0808; recommendations.ts, docs/recommendations-design.md):
 * one ranked list of the cost, model and token advice, one item per cause,
 * each with its evidence, expected effect and the button that does it. The
 * machine owner's list includes the machine's own budget. Stored data only.
 *
 * No state of its own: an item put away ("Not now") is in the store until
 * its cause changes.
 */
export interface Recommended {
  /** The person's list (`machineOwner`: with the machine's own budget). */
  list(ownerId: string, machineOwner: boolean): RecommendationList;
  /** The same list, with only the items about this agent. */
  forAgent(ownerId: string, machineOwner: boolean, agentId: string): RecommendationList;
  /**
   * "Not now": the item stays away until its cause changes (a new loop,
   * month, size …). A spike's warning is cleared with it. The item, or
   * undefined when it is gone (its cause has changed or ended).
   */
  dismiss(ownerId: string, machineOwner: boolean, id: string): Recommendation | undefined;
}

/** What Recommended needs from the process it runs in. */
export interface RecommendedDeps {
  store: Store;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
}

export function createRecommended(deps: RecommendedDeps): Recommended {
  const { store, trace } = deps;
  return {
    list: (ownerId, machineOwner) => buildRecommendations(store, ownerId, { machineOwner }),
    forAgent: (ownerId, machineOwner, agentId) => {
      const list = buildRecommendations(store, ownerId, { machineOwner });
      return { ...list, items: agentRecommendations(list, agentId) };
    },
    dismiss: (ownerId, machineOwner, id) => {
      const list = buildRecommendations(store, ownerId, { machineOwner, includeDismissed: true });
      const it = list.items.find((x) => x.id === id);
      if (!it) return undefined;
      const nowIso = new Date().toISOString();
      store.dismissRecommendation(ownerId, it.id, it.fingerprint, nowIso);
      if (it.kind === 'spike' && it.agents[0]) store.dismissUsageAlerts(ownerId, nowIso, { agentId: it.agents[0].id, at: it.fingerprint });
      trace(it.agents[0]?.id ?? 'admin')('recommendation.dismissed', { item: it.id, kind: it.kind, ...(it.agents[0] ? { agentId: it.agents[0].id } : {}) });
      return it;
    },
  };
}
