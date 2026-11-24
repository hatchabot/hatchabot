import type { Store } from '../../store/store.js';
import { refused, said, type Answer } from '../consult/answers.js';

/** A planned agent, as the store lists it. */
export type PlannedAgent = ReturnType<Store['listAgentTodos']>[number];

/**
 * Planned agents (HB-0808 step 15, part C): a launchpad of agents its owner
 * means to create later, each a name and a note, per owner, at most 100.
 * No state of its own: the store's.
 */
export interface PlannedAgents {
  list(ownerId: string): PlannedAgent[];
  /** Plan one (a name not already an agent of the owner's, archived ones too). */
  add(ownerId: string, b: { name?: string | null; note?: string | null }): Answer<{ todo: PlannedAgent }>;
  /** Take one away: false when the owner has none of that id. */
  remove(ownerId: string, id: string): boolean;
}

export function createPlannedAgents(deps: { store: Store }): PlannedAgents {
  const { store } = deps;
  return {
    list: (ownerId) => store.listAgentTodos(ownerId),
    add: (ownerId, b) => {
      const name = (b.name ?? '').trim().slice(0, 64);
      if (!name) return refused(400, 'Give the planned agent a name.');
      if (store.listAgentTodos(ownerId).length >= 100) return refused(400, 'That is a lot of plans — create or remove some first.');
      // Yours already, archived ones too: said now, not a plan that can never be carried out (HB-0447).
      const taken = store.listAgents(ownerId).find((a) => a.name.trim().toLowerCase() === name.toLowerCase());
      if (taken) return refused(409, `You already have an agent called "${taken.name}"${taken.state === 'ARCHIVED' ? ' (archived)' : ''}. Plan another name.`);
      return said({ todo: store.addAgentTodo(ownerId, name, (b.note ?? '').trim().slice(0, 500) || undefined) });
    },
    remove: (ownerId, id) => store.deleteAgentTodo(ownerId, id),
  };
}
