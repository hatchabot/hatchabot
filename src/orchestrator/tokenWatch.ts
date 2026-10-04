import type { Agent } from '../domain/types.js';
import type { Store, TokenIncidentRow } from '../store/store.js';
import type { TokenHealthRaw } from './usage.js';
import { consultPair, incidentWords, loopSignals, THRESHOLDS, type LoopSignal } from './tokenHealth.js';

/**
 * Hatchabot's own loop watcher (docs/features.md, "Token steward"). After each
 * usage pass — the existing 10-minute timer, so nothing new is scheduled and no
 * container is asked anything more — every agent's loop signals are read from
 * what that pass stored. A signal that is still going opens an INCIDENT: a
 * "Needs you" line on the agent ("Stuck: Telegram message retried 12 times
 * since 08:19 — …") with the suggested fix, told ONCE on the manager's chat.
 * When the loop stops, the incident clears itself. Deterministic: no model is
 * asked anything, and nothing is changed on any agent — the fixes are cards the
 * owner confirms (compact_agent, set_context_cap) or the app's own buttons.
 */

/** At most this many incidents are told per owner per hour; the rest still show under Needs you. */
export const TELL_PER_HOUR = 3;
/** Cleared incidents are kept this long (get_incidents shows the recent ones). */
export const KEEP_CLEARED_MS = 14 * 86_400_000;

export interface WatchDeps {
  store: Store;
  /** Tell the owner (the manager's Telegram, else the agent's own); resolves true if it reached them. */
  tell(ownerId: string, agent: Agent, text: string): Promise<boolean>;
  /** The Needs-you list changed (the app polls; a push may follow). */
  log?(event: string, detail: Record<string, unknown>): void;
}

/** The kinds that become incidents. Rate limits are the source's and already have their banner. */
const INCIDENT_KINDS = new Set(['channel-retry', 'compaction-failing', 'task-failing', 'consult-ping-pong', 'tool-loop', 'model-failing']);

export function incidentId(agentId: string, s: Pick<LoopSignal, 'kind' | 'key' | 'first'>): string {
  return `ti_${agentId}_${s.kind}_${s.key}_${Date.parse(s.first) || 0}`.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 200);
}

/** The signals that are incidents for one agent now. */
export function activeLoops(store: Store, a: Agent, now: number, health?: TokenHealthRaw): LoopSignal[] {
  const since = new Date(now - THRESHOLDS.lookbackMs).toISOString();
  const h = health ?? (store.tokenHealths([a.id]).get(a.id)?.health as TokenHealthRaw | undefined);
  const peers = store.listAgents(a.ownerId).map((x) => x.id);
  return loopSignals({ agentId: a.id, health: h, marks: store.loopMarks([a.id], since), consults: store.consultEvents(peers, since), now })
    .filter((s) => s.active && INCIDENT_KINDS.has(s.kind));
}

/**
 * One pass: open, update and clear incidents for every active agent; tell
 * each new one once (at most TELL_PER_HOUR per owner an hour). Returns the
 * incidents opened.
 */
export async function runTokenWatch(deps: WatchDeps, now = Date.now()): Promise<TokenIncidentRow[]> {
  const { store } = deps;
  const nowIso = new Date(now).toISOString();
  const opened: TokenIncidentRow[] = [];
  const agents = store.listAllActiveAgents().filter((a) => a.state !== 'DELETED' && a.state !== 'ARCHIVED');
  const nameOf = new Map(store.listAllActiveAgents().map((a) => [a.id, a.name]));
  const open = store.listTokenIncidents({ open: true, limit: 2000 });
  const seen = new Set<string>();
  for (const a of agents) {
    const health = store.tokenHealths([a.id]).get(a.id)?.health as TokenHealthRaw | undefined;
    const main = health?.main?.[a.slug];
    for (const sig of activeLoops(store, a, now, health)) {
      // A consult loop belongs to the PAIR: one incident (on the first of the
      // two, shown on both tiles), one message, cleared once — whichever of
      // the two agents' readings sees it.
      const pair = sig.kind === 'consult-ping-pong' ? consultPair(a.id, sig.key) : undefined;
      const s: LoopSignal = pair ? { ...sig, key: pair.join('+') } : sig;
      const owner = pair ? pair[0] : a.id;
      const words = incidentWords(s, { conversationK: main && !pair ? Math.round(main.ctx / 1000) : undefined, agentName: (id) => nameOf.get(id) ?? 'another agent', now });
      // The same loop: same agent, kind and key, still open (its first time may move as more history is read).
      const cur = open.find((i) => i.agentId === owner && i.kind === s.kind && i.key === s.key);
      if (cur) {
        seen.add(cur.id);
        store.updateTokenIncident(cur.id, { updatedAt: nowIso, count: s.count, firstAt: s.first, lastAt: s.last, text: words.text, fix: words.fix });
        continue;
      }
      if (seen.has(incidentId(owner, s))) continue; // the pair's other half, this same pass
      const row: TokenIncidentRow = { id: incidentId(owner, s), agentId: owner, ownerId: a.ownerId, kind: s.kind, key: s.key, openedAt: nowIso, updatedAt: nowIso,
        count: s.count, firstAt: s.first, lastAt: s.last, text: words.text, fix: words.fix };
      // The same loop (same start) cleared on a quiet pass and going again:
      // opened again, not told again. A loop that starts afresh is a new one.
      if (store.listTokenIncidents({ agentIds: [owner], limit: 50 }).some((i) => i.id === row.id)) {
        store.reopenTokenIncident(row.id);
        store.updateTokenIncident(row.id, { updatedAt: nowIso, count: s.count, firstAt: s.first, lastAt: s.last, text: words.text, fix: words.fix });
        seen.add(row.id);
        continue;
      }
      store.openTokenIncident(row);
      seen.add(row.id);
      opened.push(row);
      deps.log?.('token.incident_opened', { agentId: a.id, kind: s.kind, count: s.count });
    }
  }
  // Loops that stopped: cleared (they come back as new incidents if they start again).
  for (const i of open) {
    if (seen.has(i.id)) continue;
    store.clearTokenIncident(i.id, nowIso);
    deps.log?.('token.incident_cleared', { agentId: i.agentId, kind: i.kind });
  }
  // Told once each, oldest first; a burst of loops is capped per owner per
  // hour, and what the cap held back is told on a later pass while still open.
  for (const row of store.listTokenIncidents({ open: true, limit: 2000 }).filter((i) => !i.toldAt).reverse()) {
    const agent = agents.find((a) => a.id === row.agentId);
    if (!agent) continue;
    if (store.tokenIncidentsToldSince(row.ownerId, new Date(now - 3_600_000).toISOString()) >= TELL_PER_HOUR) continue;
    // A consult loop's text already names both agents.
    const told = await deps.tell(row.ownerId, agent, incidentMessage(row.kind === 'consult-ping-pong' ? undefined : agent.name, row)).catch(() => false);
    // Marked even when it reached nobody: the Needs-you line is there either
    // way, and a message that could not be delivered is not retried every pass.
    store.markTokenIncidentTold(row.id, nowIso);
    deps.log?.('token.incident_told', { agentId: row.agentId, kind: row.kind, told });
  }
  store.pruneTokenIncidents(new Date(now - KEEP_CLEARED_MS).toISOString());
  return opened;
}

/** The chat message: what, where to look, and the fix. */
export function incidentMessage(agentName: string | undefined, i: Pick<TokenIncidentRow, 'text' | 'fix'>): string {
  return `⚠️ Hatchabot: ${agentName ? `"${agentName}" — ` : ''}${i.text}.${i.fix ? `\nFix: ${i.fix}` : ''}\nIt is under Needs you; ask me to fix it.`;
}
