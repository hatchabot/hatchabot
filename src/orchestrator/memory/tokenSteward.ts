import { randomBytes } from 'node:crypto';
import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { isBusy } from '../lifecycle/busy.js';
import { cappedModelOf, compactAgent, CompactError, finishInterruptedCompactions, syncContextCap, type CompactDeps, type CompactMode } from './compaction.js';
import { refused, said, type Answer } from '../consult/answers.js';
import type { ChangeMeta } from '../usage/modelLedger.js';
import { THRESHOLDS as TOKEN_THRESHOLDS } from '../usage/tokenHealth.js';
import type { TokenHealthRaw } from '../usage/usage.js';

/** A compaction as the route answers it: what compactAgent said, and the action's short form. */
export type CompactAnswer = Omit<Awaited<ReturnType<typeof compactAgent>>, 'action'> & {
  action: { id: string; outcome: string; detail: unknown };
};

/** A context cap set: the cap, whether it reached the agent, where it compacts, and the words. */
export interface ContextCapAnswer {
  tokens: number | null;
  outcome: string;
  compactsAt?: number;
  message: string;
}

/**
 * The token steward's two changes (docs/features.md, "Token steward";
 * HB-0808 step 13): compact one of an agent's conversations now, and set or
 * take away its context cap. Each is recorded as a token action with who
 * made it (`meta`, the ledger's). No state of its own (the compactions under
 * way and the cap writes are compaction.ts's); a summarise runs on in the
 * background, as before.
 */
export interface TokenSteward {
  /** Compact its main conversation (`lines`: keep the last N; else summarise). */
  compact(agent: Agent, mode: CompactMode, lines: number | undefined, meta: ChangeMeta): Promise<Answer<CompactAnswer>>;
  /** Set its context cap (`raw` as the body carried it; null takes the cap away). */
  setContextCap(agent: Agent, raw: unknown, meta: ChangeMeta): Promise<Answer<ContextCapAnswer>>;
}

export interface TokenStewardDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Tell the owner in their chat (a summarise's result). */
  tell: NonNullable<CompactDeps['tell']>;
}

export function createTokenSteward(deps: TokenStewardDeps): TokenSteward {
  const { store, providerFor, trace } = deps;
  // Built once per process, at its start: a compaction the last one had
  // under way is finished in the ledger as interrupted, never left running (HB-1087).
  finishInterruptedCompactions(store, (id, e, d) => trace(id)(e, d));

  /**
   * Compact one of the agent's conversations (its main one): Hatchabot runs
   * `openclaw sessions compact` in the container itself, guarding against a
   * chat-app retry that is looping (compaction.ts). mode "lines" keeps the
   * last N lines (seconds); "summarise" runs in the background.
   */
  const compact: TokenSteward['compact'] = async (agent, mode, lines, meta) => {
    if (isBusy(agent.id)) return refused(409, 'It is busy (rebuilding or moving) — try again shortly.');
    try {
      const out = await compactAgent({ store, provider: providerFor(agent.hostId), tell: deps.tell, log: (e, d) => trace(agent.id)(e, d) }, agent,
        { mode, ...(lines !== undefined ? { lines } : {}), meta: { by: meta.by, via: meta.via, ...(meta.why ? { why: meta.why } : {}), ...(meta.proposalId ? { proposalId: meta.proposalId } : {}) } });
      return said({ ...out, action: { id: out.action.id, outcome: out.action.outcome, detail: out.action.detail } });
    } catch (err) {
      if (err instanceof CompactError) return refused(err.status, err.message);
      throw err;
    }
  };

  /**
   * The agent's context cap: OpenClaw compacts its conversations at about
   * this − 20K (compaction.ts). tokens null takes it away. Stored here, written
   * into the agent's config at once when it is running (else when it next
   * is), at every rebuild, and again when its model changes.
   */
  const setContextCap: TokenSteward['setContextCap'] = async (agent, raw, meta) => {
    const T = TOKEN_THRESHOLDS;
    if (raw !== null && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < T.capMin || raw > T.capMax)) {
      return refused(400, `tokens: a whole number from ${T.capMin} to ${T.capMax}, or null to remove the cap.`);
    }
    // The source and model its container runs, which the cap is written for
    // (cappedModelOf): while a switch of source waited for its rebuild, the
    // refusal and the ledger read the source chosen instead (HB-1170).
    const fresh = store.getAgent(agent.id) ?? agent;
    const running = cappedModelOf(store, fresh);
    // Nothing says what its container runs (the source it was built with is
    // gone, with no record of it kept): a cap then named no model (HB-1344).
    if (raw !== null && !running) return refused(409, "Hatchabot can't tell which model its container runs (the AI source it was built with is gone): set a cap after its next rebuild.");
    if (raw !== null && running?.profile.vendor === 'local') {
      // On its way to a source that bills, it can have one once it runs there;
      // on its way to another local model, it never needs one.
      const chosen = running.profile.id !== fresh.aiProfileId ? store.getAIProfile(fresh.aiProfileId) : undefined;
      return refused(400, chosen && chosen.vendor !== 'local'
        ? 'It runs a local model until its rebuild onto its new source, and a local model costs nothing per token: set a cap after the rebuild.'
        : 'A local model costs nothing per token: no cap is needed.');
    }
    const before = store.getContextCap(agent.id);
    const health = store.tokenHealths([agent.id]).get(agent.id)?.health as TokenHealthRaw | undefined;
    const now = new Date().toISOString();
    store.setContextCap(agent.id, raw, now);
    let outcome = 'pending';
    if (agent.state === 'RUNNING' && agent.runtimeRef && !isBusy(agent.id)) {
      const r = await syncContextCap({ store, provider: providerFor(agent.hostId), log: (e, d) => trace(agent.id)(e, d) }, agent, agent.runtimeRef).catch(() => 'failed' as const);
      outcome = r === 'applied' || r === 'removed' || r === 'unchanged' || r === 'skipped' ? 'applied' : r;
    }
    const ref = running ? { provider: running.provider, id: running.id } : undefined;
    const action = {
      id: `ta_${randomBytes(8).toString('hex')}`, agentId: agent.id, ownerId: agent.ownerId, kind: 'context-cap' as const, at: now,
      by: meta.by, via: meta.via, ...(meta.why ? { why: meta.why.slice(0, 400) } : {}), ...(meta.proposalId ? { proposalId: meta.proposalId } : {}),
      detail: { from: before?.tokens ?? null, to: raw, ...(ref ? { model: `${ref.provider}/${ref.id}` } : {}),
        ...(health ? { before: { ctxP50K: Math.round(health.conv.p50 / 1000), ctxP90K: Math.round(health.conv.p90 / 1000), ...(health.main?.[agent.slug] ? { mainNowK: Math.round(health.main[agent.slug]!.ctx / 1000) } : {}) } } : {}) },
      outcome,
    };
    store.addTokenAction(action);
    trace(agent.id)('token.context_cap_set', { tokens: raw, outcome, by: meta.by, via: meta.via });
    return said({
      tokens: raw, outcome,
      ...(raw ? { compactsAt: raw - Math.min(20_000, raw / 4) } : {}),
      message: raw === null
        ? (outcome === 'applied' ? `"${agent.name}" has no context cap now: it compacts near its model's full window again.` : `"${agent.name}"'s cap comes off when it is next running.`)
        : outcome === 'applied' ? `"${agent.name}" now compacts its conversations at about ${Math.round((raw - Math.min(20_000, raw / 4)) / 1000)}K tokens.`
          : outcome === 'changed-by-hand' ? `Its model settings were changed by hand meanwhile; nothing was overwritten. The cap is stored and will be written at its next rebuild.`
            : `Stored; it is written into "${agent.name}"'s settings when it is next running (or at its next rebuild).`,
    });
  };

  return { compact, setContextCap };
}
