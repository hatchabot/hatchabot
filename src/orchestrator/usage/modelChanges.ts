import type { Store } from '../../store/store.js';
import { backfillModelLedger, evaluateModelChanges, rightSizeSavings, EARLY_TURNS as EARLY_TURNS_N, VERDICT_AFTER_DAYS as VERDICT_DAYS, type ModelFigures } from './modelLedger.js';
import { modelOptionsFor } from '../sources/modelOptions.js';

/** A line to the server's log: its detail, then its words. */
type LogLine = (detail: object, msg: string) => void;

/**
 * The model steward's two reads (HB-0808 step 15, part C; docs/features.md,
 * "Right-size"; the scorecard is the usage service's): the models each of
 * the caller's sources offers, and the model-change ledger (modelLedger.ts)
 * with the verdicts that are due worked out and what the cheaper switches
 * saved this month. Both from what Hatchabot holds: no container is asked
 * anything and no sleeping agent is woken. And the ledger's start-up: seeded
 * once from the cards confirmed before it existed, old changes forgotten.
 * No state and no timer of its own.
 */
export interface ModelChanges {
  /** The models the owner's sources offer. */
  options(ownerId: string): ReturnType<typeof modelOptionsFor>;
  /** The owner's changes, newest first, `limit` of them, of one agent (its id or name) when `agentRef` is given. */
  changes(ownerId: string, limit: number, agentRef: string | undefined): { changes: unknown[]; tokenActions: unknown[]; savings: ReturnType<typeof rightSizeSavings>; notes: string[] };
  /** The ledger at start-up (registerRoutes, once). Never throws. */
  atStart(): void;
}

export interface ModelChangesDeps {
  store: Store;
  /** The server's log. */
  log: { info: LogLine; warn: LogLine };
}

export function createModelChanges(deps: ModelChangesDeps): ModelChanges {
  const { store, log } = deps;
  const options: ModelChanges['options'] = (ownerId) => modelOptionsFor(store.listAIProfiles(ownerId));

  /**
   * The model-change ledger (modelLedger.ts): the caller's changes, newest
   * first, with the old model's figures at the change, the new model's a week
   * on and the verdict, plus what the cheaper switches saved this month.
   * Stored data only: verdicts that are due are worked out here from the
   * stored profiles (nothing is asked of any container).
   */
  const changes: ModelChanges['changes'] = (ownerId, limit, agentRef) => {
    try { evaluateModelChanges(store, Date.now(), ownerId); } catch (err) { log.warn({ err: String(err) }, 'model.ledger_eval_failed'); }
    const names = new Map(store.listAgents(ownerId).map((a) => [a.id, a.name]));
    const agentId = agentRef ? [...names.entries()].find(([id, n]) => id === agentRef || n.toLowerCase() === agentRef.toLowerCase())?.[0] ?? '-' : undefined;
    const brief = (f: ModelFigures | undefined) => f && {
      model: f.model, days: f.days, turns: f.turns, turnsPerDay: f.turnsPerDay, callsPerDay: f.callsPerDay, toolsPerTurn: f.toolsPerTurn, toolTurnShare: f.toolTurnShare,
      badTurns: f.badTurns, malformed: f.malformed, toolFailed: f.toolFailed, rates: f.rates, ...(f.ctxK ? { ctxK: f.ctxK } : {}), ...(f.monthlyUSD !== undefined ? { monthlyUSD: f.monthlyUSD } : {}),
    };
    const changes = store.listModelChanges({ ownerId, agentId, limit }).map((c) => ({
      id: c.id, agent: names.get(c.agentId) ?? '(deleted agent)', agentId: c.agentId,
      from: c.from ?? null, to: c.to, at: c.at, ...(c.approx ? { approx: true } : {}),
      by: c.by, via: c.via, source: c.source, ...(c.why ? { why: c.why } : {}),
      before: brief(c.before as ModelFigures | undefined) ?? 'unknown',
      ...(c.after ? { after: brief(c.after as ModelFigures) } : {}),
      outcome: c.outcome, ...(c.reasons?.length ? { reasons: c.reasons } : {}),
      ...(c.guardProposalId && !c.guardProposalId.startsWith('none:') ? { guardCard: c.guardProposalId } : {}),
    }));
    const tokenActions = store.listTokenActions({ ownerId, ...(agentId ? { agentId } : {}), limit: Math.min(limit, 50) }).map((t) => ({
      id: t.id, agent: names.get(t.agentId) ?? '(deleted agent)', agentId: t.agentId, kind: t.kind, at: t.at, by: t.by, via: t.via,
      ...(t.why ? { why: t.why } : {}), detail: t.detail, outcome: t.outcome,
    }));
    return {
      changes,
      tokenActions,
      savings: rightSizeSavings(store, ownerId),
      notes: [
        `outcome: pending until ${VERDICT_DAYS} days after the change (or ${EARLY_TURNS_N} turns on the new model); then kept-ok, worse (error rates up: failed turns, malformed tool calls, tool failures) or not-enough-data.`,
        'by: owner (by hand), agent (your card, the owner confirmed), hatchabot (the quality guard\'s switch-back, the owner confirmed). via: app, api, proposal, guard, backfill, recommendation (a Recommended item\'s button).',
        'A worse change gets one switch-back card from Hatchabot (an item under Usage → Recommended); it never switches by itself.',
      ],
    };
  };

  // The model-change ledger at start-up: seed it once from the set_model cards
  // confirmed before it existed (idempotent: keyed by the card), and forget
  // changes older than about 13 months.
  const atStart = () => {
    try {
      const seeded = backfillModelLedger(store);
      if (seeded) log.info({ seeded }, 'model.ledger_backfilled');
      store.pruneModelChanges(new Date(Date.now() - 400 * 86_400_000).toISOString());
    } catch (err) { log.warn({ err: String(err) }, 'model.ledger_backfill_failed'); }
  };

  return { options, changes, atStart };
}
