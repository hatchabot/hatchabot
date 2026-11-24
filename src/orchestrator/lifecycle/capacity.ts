import type { Store } from '../../store/store.js';

/**
 * The agent caps (HB-0808 step 11, part 2), checked by EVERY path that
 * creates or revives a live agent (create, import, restore from file, clone,
 * derive, accept a shared template, un-archive). ARCHIVED agents don't count —
 * they hold no bot, container or port. Unset caps = no limit. Part of the
 * agent lifecycle service (agentLifecycle.ts).
 *
 * Agents being made right now (a clone's export, an import's checks run for
 * seconds before the row exists): each request that passed the cap holds a
 * place until its row is made, or parallel requests all passed it (night
 * review). The route registry lets a request's place go in the turn its row
 * is made (`capRowMade`: held on beside the row, one clone or import copying
 * its settings counted twice, HB-1121), or when it answers (its `onSend`
 * hook, which comes whether or not its caller is still there), however long
 * its work takes (HB-0630). A restart loses nothing: the requests end with
 * the process, and a row that was made counts itself.
 */
export interface Capacity {
  /**
   * Why this owner may not make one more agent now, or undefined; undefined
   * also takes a place for the request (`reqId`) until it is let go.
   * `machineOwner` is asked only when a member's ceiling applies.
   */
  claim(reqId: string, ownerId: string, machineOwner: () => boolean): string | undefined;
  /** Let a request's place go (its row was made, or it answered). */
  release(reqId: string): void;
}

export function createCapacity(deps: { store: Store }): Capacity {
  const { store } = deps;
  const capHeld = new Map<string, number>();
  const capHolds = new Map<string, string>(); // request id → owner
  const capProblemNow = (ownerId: string, machineOwner: () => boolean): string | undefined => {
    const liveCount = store.listAgents(ownerId).filter((a) => a.state !== 'ARCHIVED').length + (capHeld.get(ownerId) ?? 0);
    const maxPerAccount = Number(process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT ?? 0);
    if (maxPerAccount > 0 && liveCount >= maxPerAccount) return `You've reached the limit of ${maxPerAccount} agents on this server. Delete one first.`;
    const maxPerMember = Number(process.env.HATCHABOT_MAX_AGENTS_PER_MEMBER ?? 0);
    if (maxPerMember > 0 && !machineOwner() && liveCount >= maxPerMember) return `Members may run up to ${maxPerMember} agents on this server. Delete one first, or ask the host owner.`;
    const maxTotal = Number(process.env.HATCHABOT_MAX_AGENTS_TOTAL ?? 0);
    if (maxTotal > 0 && store.countLiveAgents() + [...capHeld.values()].reduce((s, n) => s + n, 0) >= maxTotal) return `This server is at its capacity of ${maxTotal} agents. Ask the host owner to free one up.`;
    return undefined;
  };
  return {
    claim: (reqId, owner, machineOwner) => {
      const problem = capProblemNow(owner, machineOwner);
      if (!problem && !capHolds.has(reqId)) {
        capHolds.set(reqId, owner);
        capHeld.set(owner, (capHeld.get(owner) ?? 0) + 1);
      }
      return problem;
    },
    release: (reqId) => {
      const owner = capHolds.get(reqId);
      if (owner === undefined) return;
      capHolds.delete(reqId);
      const n = (capHeld.get(owner) ?? 1) - 1;
      if (n > 0) capHeld.set(owner, n); else capHeld.delete(owner);
    },
  };
}
