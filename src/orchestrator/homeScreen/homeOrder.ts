import type { Agent } from '../../domain/types.js';
import type { SectionSort, Store } from '../../store/store.js';
import { refused, said, type Answer } from '../consult/answers.js';
import { sixAtATime } from '../../util/queues.js';

/** POST /v1/agents/:id/move: one place, to an edge, or just before another agent (or the end of a group). */
export interface MoveAsk { dir?: unknown; before?: unknown; group?: unknown }
/** POST /v1/groups/sort: a section (or every one) by name, time or last activity. */
export interface SortAsk { group?: unknown; all?: unknown; mode?: unknown; desc?: unknown }

/**
 * The home screen's order and its groups (HB-0808 step 15, part C), per
 * owner: an agent moved (one place, to an edge, or dropped before another
 * of the caller's agents), a section sorted once, a group renamed or moved.
 * Cosmetic and at once: nothing is rebuilt. No state of its own: the
 * order and the groups are the store's.
 */
export interface HomeOrder {
  /** Move one of the caller's agents; `owned` is an agent of that id the caller may see, for `before`. */
  move(agent: Agent, b: MoveAsk, owned: (id: string) => Agent | undefined): Answer<{ ok: true; group?: string | null }>;
  /** Sort a section of the owner's, or all of them, once. */
  sort(ownerId: string, b: SortAsk): Promise<Answer<{ ok: true; sorted: number; mode: SectionSort; desc: boolean }>>;
  /** Rename a group: its agents and its place in the order follow. */
  rename(ownerId: string, from: string, to: string): Answer<{ renamed: number; group?: string }>;
  /** Move a group's section one place; `moved` is false at the edge. */
  moveGroup(ownerId: string, group: string, dir: 'up' | 'down'): { ok: true; moved: boolean };
}

export interface HomeOrderDeps {
  store: Store;
  /** When the agent was last active, from its sessions (the conversations service's). */
  lastActiveFor: (a: Agent) => Promise<string | undefined>;
}

export function createHomeOrder(deps: HomeOrderDeps): HomeOrder {
  const { store, lastActiveFor } = deps;

  // Reorder an agent. Cosmetic, immediate, no rebuild. Three shapes:
  //   { dir: 'up' | 'down' }       one place within its section
  //   { dir: 'top' | 'bottom' }    to the edge of its section
  //   { before: id | null, group? } drag-and-drop: just before another agent
  //                                 (adopting that agent's section), or the end
  //                                 of `group` ('' = ungrouped) when before is null
  const move: HomeOrder['move'] = (agent, b, owned) => {
    if (b.dir === 'up' || b.dir === 'down') { store.moveAgent(agent.id, b.dir); return said({ ok: true as const }); }
    if (b.dir === 'top' || b.dir === 'bottom') { store.moveAgentToEdge(agent.id, b.dir); return said({ ok: true as const }); }
    if ('before' in b) {
      if (b.before !== null && typeof b.before !== 'string') return refused(400, 'before must be an agent id or null.');
      if (b.before) {
        if (!owned(b.before)) return refused(404, 'No such agent to place it before.');
        store.moveAgentBefore(agent.id, b.before);
      } else {
        let group: string | null | undefined;
        if (b.group !== undefined) {
          if (b.group !== null && typeof b.group !== 'string') return refused(400, 'group must be a name or null.');
          const g = (b.group ?? '').trim();
          if (g.length > 48) return refused(400, 'Group names are at most 48 characters.');
          group = g || null;
        }
        store.moveAgentBefore(agent.id, null, group);
      }
      return said({ ok: true as const, group: store.getAgent(agent.id)?.group ?? null });
    }
    return refused(400, 'Send dir ("up" | "down" | "top" | "bottom") or before.');
  };

  /**
   * Sort a section, once. `mode: 'name'` is A→Z, `'time'` is earliest→latest,
   * and `desc: true` reverses either — the second press of the same button.
   * Nothing is remembered: this writes the order and stops, so a hand-dragged
   * agent stays where you put it until you ask for a sort again.
   */
  const sort: HomeOrder['sort'] = async (ownerId, b) => {
    if (b.mode !== undefined && b.mode !== 'name' && b.mode !== 'time' && b.mode !== 'activity') {
      return refused(400, 'mode must be "name", "time" or "activity".');
    }
    const mode = (b.mode ?? 'name') as SectionSort;
    const desc = b.desc === true;
    // The sections first: a request naming none was refused only after every
    // agent's activity had been read (HB-0902).
    if (b.all !== true && (b.group === undefined || (b.group !== null && typeof b.group !== 'string'))) {
      return refused(400, 'group (a name, or "" for ungrouped) or all: true is required.');
    }
    const sections = b.all === true ? store.sectionsOf(ownerId) : [(typeof b.group === 'string' ? b.group : '').trim() || null];
    // Last activity is read from each agent's sessions file (cached by the
    // list), for the agents of those sections only, six at a time: read one
    // after another for every agent the owner has, a cold cache and a few
    // runners asleep held a small group's sort for half a minute (HB-0902).
    let activity: Map<string, string | undefined> | undefined;
    if (mode === 'activity') {
      const wanted = new Set(sections);
      const agents = store.listAgents(ownerId).filter((a) => wanted.has(a.group ?? null));
      const times = await sixAtATime(agents, (a) => lastActiveFor(a).catch(() => undefined));
      activity = new Map(agents.map((a, i) => [a.id, times[i]]));
    }
    let sorted = 0;
    for (const g of sections) sorted += store.sortSection(ownerId, g, mode, desc, activity);
    return said({ ok: true as const, sorted, mode, desc });
  };

  /** Rename a group: its agents and its place in the order follow. */
  const rename: HomeOrder['rename'] = (ownerId, from, to) => {
    if (from === to) return said({ renamed: 0 });
    const n = store.renameGroup(ownerId, from, to);
    if (!n) return refused(404, `No group called "${from}".`);
    return said({ renamed: n, group: to });
  };

  // Reorder a whole group section up/down in the caller's list.
  const moveGroup: HomeOrder['moveGroup'] = (ownerId, group, dir) => {
    // false at the boundary: the caller says so — a click that changed nothing used to look broken.
    const moved = store.moveGroup(ownerId, group, dir);
    return { ok: true as const, moved };
  };

  return { move, sort, rename, moveGroup };
}
