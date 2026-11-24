import type { Agent } from '../../domain/types.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import { Store } from '../../store/store.js';
import { refused, said, type Answer } from './answers.js';

/** One agent's peers as the owner sees them: those it may consult, and every agent it could. */
export interface PeersView {
  peers: PeerCandidate[];
  candidates: PeerCandidate[];
}
export interface PeerCandidate { id: string; name: string; granted: boolean; allowActions: boolean }

/** What a mesh did: the counts, who needs a rebuild, who was asleep, and who was left out and why. */
export interface MeshResult {
  connected: boolean;
  agents: number;
  changed: number;
  grants: number;
  needRebuild: Array<{ id: string; name: string; state: Agent['state'] }>;
  note?: string;
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Which agents may consult which (HB-0808 step 13): the owner's grants, one
 * agent's at a time or a whole selection to each other, and the call token
 * an agent with a grant holds. Same owner only; never the Hatchabot agent,
 * nor a copy that moved away or is gone.
 *
 * It owns `callTokenMints` (one mint per agent at a time). No timer.
 */
export interface Peers {
  /** The owner's view: this agent's granted peers + the pickable candidates. */
  view(agent: Agent, ownerId: string): PeersView;
  /**
   * Replace this agent's grants with `peerIds` (those that are the owner's
   * own agents) and its "may ask it to act" with `allowActions` (of those);
   * a call token minted when any is granted. Answers the grants kept.
   */
  set(agent: Agent, ownerId: string, peerIds: string[], allowActions: string[] | undefined): Promise<{ peers: string[] }>;
  /**
   * Connect (or disconnect) a selection of the owner's agents to each other.
   * `agents` are the owner's own, as the route found them.
   */
  mesh(ownerId: string, agents: Agent[], connect: boolean): Promise<Answer<MeshResult>>;
  /** Make sure the agent holds a call token whose secret and hash agree. */
  ensureCallToken(agentId: string, ownerId: string): Promise<void>;
}

export interface PeersDeps {
  store: Store;
  secrets: SecretStore;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
  /** A warning to the log. */
  warn: (detail: Record<string, unknown>, msg: string) => void;
}

export function createPeers(deps: PeersDeps): Peers {
  const { store, secrets, agentGone } = deps;

  /**
   * Make sure the agent holds a call token whose secret and hash agree. The
   * secret is written FIRST and the hash goes live after it, one mint per
   * agent at a time: the hash went first, so a failed secret write, or two
   * grants at once each writing their own token, left a live hash with a
   * different secret, and "has a token" kept every later grant from
   * repairing it — the agent's consults all failed (concurrency review,
   * 2026-10-09). A token whose secret no longer matches is minted again.
   */
  const callTokenMints = new Map<string, Promise<void>>();
  /** Still the owner's, and not deleted or being deleted: asked again after every wait (HB-0965). */
  const stillTheirs = (agentId: string, ownerId: string): boolean => store.getAgent(agentId)?.ownerId === ownerId && !agentGone(agentId);
  const ensureAgentCallToken = (agentId: string, ownerId: string): Promise<void> => {
    const ref = `agent-call-token/${agentId}`;
    const run = async () => {
      if (!stillTheirs(agentId, ownerId)) return;
      if (store.hasAgentCallToken(agentId)) {
        const held = await secrets.get(ref).catch(() => undefined);
        if (held && store.agentCallTokenIs(agentId, held)) return;
      }
      const token = Store.mintAgentCallToken();
      await secrets.put(ref, token);
      // Deleted (or handed on) while the secret was written: its delete had
      // scrubbed the token already, and this one must not go live after it.
      if (!stillTheirs(agentId, ownerId)) { await secrets.delete(ref).catch(() => {}); return; }
      store.createAgentCallToken(agentId, ownerId, token);
    };
    const next = (callTokenMints.get(agentId) ?? Promise.resolve()).catch(() => {}).then(run);
    const settled = next.catch(() => {}).finally(() => { if (callTokenMints.get(agentId) === settled) callTokenMints.delete(agentId); });
    callTokenMints.set(agentId, settled);
    return next;
  };

  const view: Peers['view'] = (agent, ownerId) => {
    const granted = new Set(store.listAgentPeers(agent.id));
    const mayAct = new Set(store.listAgentActionPeers(agent.id));
    const candidates = store
      .listAgents(ownerId)
      // Not the manager (its conversation is the owner's), nor a copy that
      // moved away or is gone (night review, 2026-09-28).
      .filter((a) => a.id !== agent.id && a.state !== 'ARCHIVED' && a.state !== 'DELETED' && !a.ops && !a.migratedTo)
      .map((a) => ({ id: a.id, name: a.name, granted: granted.has(a.id), allowActions: mayAct.has(a.id) }));
    return { peers: candidates.filter((c) => c.granted), candidates };
  };

  const set: Peers['set'] = async (agent, ownerId, wanted, wantedActions) => {
    // Every peer must be the CALLER's own agent — never a cross-owner grant.
    const valid = wanted.filter((pid) => {
      const p = store.getAgent(pid);
      return p && p.ownerId === ownerId && p.id !== agent.id && p.state !== 'DELETED' && p.state !== 'ARCHIVED' && !p.ops && !p.migratedTo;
    });
    // "May request actions" only applies to peers actually granted, and only
    // between two agents the SAME person owns (already enforced above).
    const wantAct = wantedActions ?? [];
    const allowActions = wantAct.filter((pid) => valid.includes(pid));
    store.setAgentPeers(agent.id, valid, allowActions);
    if (allowActions.length) {
      deps.warn(
        { agentId: agent.id, peers: allowActions, ownerId },
        'a2a.actions_authorized — this agent may ask these peers to act, not just answer',
      );
    }
    // Ensure the agent holds a call token (minted once, injected on rebuild).
    if (valid.length) {
      // Mint when the DB has no live token row (never minted, expired, or
      // revoked) — checking only the secret left a revoked token unrepairable.
      await ensureAgentCallToken(agent.id, ownerId);
    }
    return { peers: valid };
  };

  const mesh: Peers['mesh'] = async (ownerId, agents, connect) => {
    const skipped: Array<{ name: string; reason: string }> = [];
    const members: Agent[] = [];
    for (const a of agents) {
      if (a.state === 'ARCHIVED') { skipped.push({ name: a.name, reason: 'archived' }); continue; }
      if (a.state === 'DELETED' || a.migratedTo) { skipped.push({ name: a.name, reason: 'moved away or deleted' }); continue; }
      if (a.ops) { skipped.push({ name: a.name, reason: 'the Hatchabot agent is not consulted by other agents' }); continue; }
      members.push(a);
    }
    if (members.length < 2) return refused(400, 'At least two of the selected agents must be active.');
    const inSet = new Set(members.map((a) => a.id));
    /**
     * A member as it is now, after the token waits before it: one deleted,
     * archived, moved or handed on meanwhile gets no grants and gives none
     * (a disconnect takes its grants all the same).
     * The members as they were when the mesh began put a deleted member's
     * grants and call token back after its delete had scrubbed them (HB-0965).
     */
    const stillMember = (id: string): boolean => {
      const now = store.getAgent(id);
      return !!now && now.ownerId === ownerId && now.state !== 'ARCHIVED' && !now.migratedTo && !now.ops && !agentGone(id);
    };
    let changed = 0;
    for (const a of members) {
      // A disconnect always removes: a member archived or moved during a
      // token wait kept its grants to the others (an archive leaves them),
      // and consulted them again once unarchived.
      const member = stillMember(a.id);
      if (connect && !member) continue;
      const current = store.listAgentPeers(a.id);
      const next = connect
        ? [...new Set([...current, ...members.filter((m) => m.id !== a.id && stillMember(m.id)).map((m) => m.id)])]
        : current.filter((p) => !inSet.has(p));
      if (!(next.length === current.length && next.every((p) => current.includes(p)))) {
        // Keep the "may ask it to act" grants to peers that stay (they were wiped).
        store.setAgentPeers(a.id, next, store.listAgentActionPeers(a.id).filter((p) => next.includes(p)));
        changed++;
      }
      // Also when the grants were already right: a retry after a failed mint
      // found them unchanged and skipped the token, leaving the connection
      // unusable (#167). Minting is a no-op while a live token is held.
      // A disconnect mints nothing: it waited on the token of a peer outside
      // the selection, and a vault that failed then stopped it with the
      // grants back to this one still in place (HB-1127).
      if (connect && next.length && member) await ensureAgentCallToken(a.id, ownerId);
    }
    // The agent list's one query for the owner, peersNotInstalled's rule
    // (peersCsv), and the members as they are now, after the token awaits.
    const pending = store.agentsWithPeersPending(ownerId);
    const now = new Map(store.listAgents(ownerId).map((a) => [a.id, a]));
    // One deleted, or being deleted, meanwhile needs nothing, and is not named.
    const needRebuild = members.flatMap((a) => (pending.has(a.id) && now.has(a.id) && !agentGone(a.id) ? [now.get(a.id)!] : []));
    // A sleeping agent wakes for a message as it was, at once: the change
    // waits for its next Start or Rebuild (HB-0465). Said, not left to guess.
    const asleep = needRebuild.filter((a) => a.state === 'STOPPED' && a.hibernatedAt);
    return said({
      connected: connect,
      agents: members.length,
      changed,
      grants: connect ? members.length * (members.length - 1) : 0,
      needRebuild: needRebuild.map((a) => ({ id: a.id, name: a.name, state: a.state })),
      ...(asleep.length ? {
        note: `${asleep.map((a) => a.name).join(', ')} ${asleep.length > 1 ? 'are' : 'is'} asleep. A sleeping agent wakes for a message as it was; it takes this change at its next Start or Rebuild, and its card says its peers changed.`,
      } : {}),
      skipped,
    });
  };

  return { view, set, mesh, ensureCallToken: ensureAgentCallToken };
}
