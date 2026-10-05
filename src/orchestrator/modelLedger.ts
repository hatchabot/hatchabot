import { randomBytes } from 'node:crypto';
import type { Agent, AIProfile } from '../domain/types.js';
import type { ModelChangeRow, Store } from '../store/store.js';
import type { PendingConfirm } from '../mgmt/pendingStore.js';
import { HOUR_FIELDS, type HourField, type WindowModelStats } from './usage.js';
import { modelKey, modelOption, priceMix, type TokenMix } from './modelOptions.js';
import { scoreAgent, type StoredProfile } from './modelScorecard.js';
import { effectiveModel } from './provision.js';

/**
 * The model-change ledger, the quality guard and the realised saving
 * (docs/features.md, "Right-size", step 2).
 *
 * Every change of an agent's model — a set_model card, the app's picker, the
 * API, a source's new default, a class, a source switch — is recorded with
 * who made it and why, and the OLD model's figures at that moment. A week on
 * (or sooner, once the new model has EARLY_TURNS turns) the NEW model's
 * figures are read from the same stored profile and the change gets a
 * verdict: kept-ok, worse, or not-enough-data. A worse downgrade gets one
 * switch-back card from Hatchabot (source "guard"), which the owner confirms
 * or drops like any other; nothing switches on its own.
 *
 * Everything here reads what the usage sampler already stored
 * (agent_model_profiles, whose per-model hour buckets say what each model did
 * from a switch on). No container is asked anything and no agent is woken.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A verdict is due this long after a change … */
export const VERDICT_AFTER_DAYS = 7;
/** … or once the new model has this many turns, whichever comes first. */
export const EARLY_TURNS = 20;
/** Fewer turns than this on the new model is no basis for a verdict. */
export const MIN_VERDICT_TURNS = 5;
/** A not-enough-data change is looked at again until it is this old. */
export const RECHECK_DAYS = 30;
/** How long the guard's switch-back card waits for the owner. */
export const GUARD_CARD_TTL_MS = 3 * DAY;

/**
 * When a change is "worse" (see judge()): rates per turn (per tool call for
 * tool failures), compared with the old model's, and a floor of real counts
 * so one bad afternoon is not a trend. With the old model's figures unknown
 * (a backfilled change) the after rate alone must clear the absolute bar.
 */
export const WORSE = {
  /** Turns that failed for a reason other than a rate limit, plus answers cut off. */
  badTurn: { delta: 0.05, absolute: 0.10, min: 2 },
  /** Tool calls OpenClaw rejected as malformed, per turn. */
  malformed: { delta: 0.02, absolute: 0.03, min: 2 },
  /** Tool results that came back as errors, per tool call: noisier (the tool can be at fault), so a higher bar. */
  toolFail: { delta: 0.10, absolute: 0.25, min: 3 },
} as const;

/** The proposal-time warnings (assessModelChange): what makes a downgrade risky. */
export const RISK = {
  /** Heavy tool use: more tools per turn than this … */
  toolsPerTurn: 3,
  /** … or tools in more than this share of turns (the same bar the steward's notes use). */
  toolTurnShare: 0.5,
} as const;

export interface ModelFigures {
  model: string;
  /** Days the figures cover (at least an hour, shown in days). */
  days: number;
  calls: number;
  turns: number;
  callsPerDay: number;
  turnsPerDay: number;
  toolCalls: number;
  toolsPerTurn: number;
  toolTurnShare: number;
  /** Failed turns that were not rate limits, plus answers cut off for length. */
  badTurns: number;
  malformed: number;
  toolFailed: number;
  rateLimited: number;
  rates: { badTurn: number; malformed: number; toolFail: number };
  /** Context per call (thousands), when the stored figures can say it for this period. */
  ctxK?: { p50: number; p90: number };
  tokens: TokenMix;
  /** This use for a month at API prices (USD); absent for a model with no known price. */
  monthlyUSD?: number;
  /** hours = from the per-hour buckets; window = the 30-day totals (a profile read before buckets existed). */
  basis: 'hours' | 'window';
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r1 = (x: number) => Math.round(x * 10) / 10;
const hourOf = (iso: string) => new Date(iso).toISOString().slice(0, 13);
const hourMs = (h: string) => Date.parse(`${h}:00:00Z`);

type Counts = Record<HourField, number>;
const zero = (): Counts => Object.fromEntries(HOUR_FIELDS.map((f) => [f, 0])) as Counts;

/** The profile's entries for one model (dated and vendor-prefixed ids count as the model). */
function entriesFor(p: StoredProfile, model: string): WindowModelStats[] {
  const k = modelKey(model);
  return Object.entries(p.models ?? {}).filter(([m]) => modelKey(m) === k || m === model).map(([, s]) => s);
}

/** Sum a model's hour buckets with fromHour ≤ hour < toHour (either end open when undefined). */
export function sumHours(p: StoredProfile, model: string, fromHour?: string, toHour?: string): { counts: Counts; firstHour?: string } {
  const c = zero();
  let firstHour: string | undefined;
  for (const s of entriesFor(p, model)) {
    for (const [h, v] of Object.entries(s.h ?? {})) {
      if ((fromHour && h < fromHour) || (toHour && h >= toHour)) continue;
      HOUR_FIELDS.forEach((f, i) => { c[f] += Number(v[i]) || 0; });
      if (!firstHour || h < firstHour) firstHour = h;
    }
  }
  return { counts: c, firstHour };
}

function figuresFrom(model: string, c: Counts, days: number, basis: ModelFigures['basis'], ctx?: { p50: number; p90: number }): ModelFigures {
  const d = Math.max(days, 1 / 24);
  const perDayBase = Math.max(d, 1); // a model used for an hour is not "24 turns a day"
  const tokens: TokenMix = { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite };
  const cost = priceMix(model, tokens);
  const bad = Math.max(0, c.failed - c.limitedTurns) + c.truncated;
  return {
    model,
    days: r1(d),
    calls: c.calls,
    turns: c.turns,
    callsPerDay: r1(c.calls / perDayBase),
    turnsPerDay: r1(c.turns / perDayBase),
    toolCalls: c.toolCalls,
    toolsPerTurn: c.turns ? r1(c.toolCalls / c.turns) : 0,
    toolTurnShare: c.turns ? r2(c.toolTurns / c.turns) : 0,
    badTurns: bad,
    malformed: c.malformed,
    toolFailed: c.toolFailed,
    rateLimited: c.limitedTurns,
    rates: {
      badTurn: c.turns ? r3(bad / c.turns) : 0,
      malformed: c.turns ? r3(c.malformed / c.turns) : 0,
      toolFail: c.toolCalls ? r3(c.toolFailed / c.toolCalls) : 0,
    },
    ...(ctx ? { ctxK: ctx } : {}),
    tokens,
    ...(cost !== undefined ? { monthlyUSD: r2((cost * 30) / perDayBase) } : {}),
    basis,
  };
}

/** The 30-day totals of a model's entries, as hour-bucket counts. */
function windowCounts(entries: WindowModelStats[]): Counts {
  const c = zero();
  for (const s of entries) {
    c.calls += s.calls; c.input += s.input; c.output += s.output; c.cacheRead += s.cacheRead; c.cacheWrite += s.cacheWrite;
    c.turns += s.turns; c.toolTurns += s.toolTurns; c.toolCalls += s.toolCalls; c.failed += s.failedTurns;
    c.malformed += s.err?.malformedToolCall ?? 0; c.toolFailed += s.err?.toolFailed ?? 0; c.truncated += s.err?.truncated ?? 0;
    // The totals count rate limits as events (retried ones too): no more than the failed turns.
    c.limitedTurns += Math.min(s.err?.rateLimited ?? 0, s.failedTurns);
  }
  return c;
}

function ctxOf(entries: WindowModelStats[]): { p50: number; p90: number } | undefined {
  const busiest = [...entries].sort((x, y) => y.calls - x.calls)[0];
  return busiest && busiest.calls ? { p50: Math.round(busiest.ctxP50 / 1000), p90: Math.round(busiest.ctxP90 / 1000) } : undefined;
}

const hasHours = (p: StoredProfile) => p.hourly === true || Object.values(p.models ?? {}).some((s) => s.h && Object.keys(s.h).length);

/**
 * The old model's figures at a change: from its hour buckets before the
 * change when the profile has them, else its 30-day totals (all of which are
 * from before the change when the agent has used the new model since).
 * Undefined when Hatchabot has no reading of that model.
 */
export function beforeFigures(stored: { profile: StoredProfile; at: string } | undefined, model: string | undefined, atIso: string): ModelFigures | undefined {
  if (!stored || !model) return undefined;
  const p = stored.profile;
  const entries = entriesFor(p, model);
  if (!entries.length) return undefined;
  const at = Date.parse(atIso);
  const readAt = Date.parse(stored.at);
  if (hasHours(p) && entries.some((s) => s.h && Object.keys(s.h).length)) {
    const { counts, firstHour } = sumHours(p, model, undefined, hourOf(atIso));
    if (!counts.calls && !counts.turns) return undefined;
    const start = Math.max(p.since, firstHour ? hourMs(firstHour) : p.since);
    return figuresFrom(model, counts, (Math.min(at, readAt) - start) / DAY, 'hours', ctxOf(entries));
  }
  const first = Math.min(...entries.map((s) => s.first || at));
  const last = Math.max(...entries.map((s) => s.last || 0));
  const start = Math.max(p.since, first);
  const end = Math.min(at, readAt, last > start ? last : at);
  return figuresFrom(model, windowCounts(entries), (end - start) / DAY, 'window', ctxOf(entries));
}

/**
 * The new model's figures from the change up to `untilIso` (the agent's next
 * change) or the latest reading. Undefined while no reading with hour buckets
 * has been taken since the change.
 */
export function afterFigures(stored: { profile: StoredProfile; at: string } | undefined, model: string, atIso: string, untilIso?: string): ModelFigures | undefined {
  if (!stored || !hasHours(stored.profile)) return undefined;
  const readAt = Date.parse(stored.at);
  const at = Date.parse(atIso);
  if (!(readAt > at)) return undefined;
  const end = Math.min(readAt, untilIso ? Date.parse(untilIso) : readAt);
  const { counts } = sumHours(stored.profile, model, hourOf(atIso), untilIso ? hourOf(untilIso) : undefined);
  const entries = entriesFor(stored.profile, model);
  // The 30-day context figures are this period's only when the model was first used after the change.
  const allAfter = entries.length > 0 && entries.every((s) => (s.first || 0) >= at - HOUR) && !untilIso;
  return figuresFrom(model, counts, (end - at) / DAY, 'hours', allAfter ? ctxOf(entries) : undefined);
}

export interface Verdict { outcome: 'kept-ok' | 'worse' | 'not-enough-data'; reasons: string[] }

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** Worse, ok, or too little to say — see WORSE for the thresholds. */
export function judge(before: ModelFigures | undefined, after: ModelFigures): Verdict {
  if (after.turns < MIN_VERDICT_TURNS) {
    return { outcome: 'not-enough-data', reasons: [`${after.turns} turn${after.turns === 1 ? '' : 's'} on ${after.model} since the switch (${MIN_VERDICT_TURNS} needed to judge)`] };
  }
  const reasons: string[] = [];
  const check = (key: keyof typeof WORSE, count: number, label: string, unit: string) => {
    const t = WORSE[key];
    const a = after.rates[key];
    if (count < t.min) return;
    const b = before && before.turns >= MIN_VERDICT_TURNS ? before.rates[key] : undefined;
    if (b === undefined ? a >= t.absolute : a - b >= t.delta) {
      reasons.push(`${label} ${b === undefined ? '' : `${pct(b)} → `}${pct(a)} ${unit} (${count} on ${after.model}${b === undefined ? '; before unknown' : ''})`);
    }
  };
  check('badTurn', after.badTurns, 'failed turns', 'of turns');
  check('malformed', after.malformed, 'malformed tool calls', 'per turn');
  check('toolFail', after.toolFailed, 'tool failures', 'of tool calls');
  if (reasons.length) return { outcome: 'worse', reasons };
  return { outcome: 'kept-ok', reasons: [`${after.turns} turns on ${after.model}: failed ${pct(after.rates.badTurn)}, malformed tool calls ${after.malformed}, tool failures ${pct(after.rates.toolFail)}`] };
}

// ---- recording -------------------------------------------------------------

export interface ChangeMeta {
  by: ModelChangeRow['by'];
  via: ModelChangeRow['via'];
  source: string;
  why?: string;
  proposalId?: string;
}

/** The model an agent runs (or will run at its next start): its pin if the source offers it, else the source's default. */
export function currentModel(store: Store, agentId: string): { model: string; profileId: string } | undefined {
  const a = store.getAgent(agentId);
  const p = a && a.state !== 'DELETED' ? store.getAIProfile(a.aiProfileId) : undefined;
  return a && p ? { model: effectiveModel(a, p), profileId: p.id } : undefined;
}

/** What each agent runs now — taken before a change, handed to recordChanges after it. */
export function snapshotModels(store: Store, agentIds: Iterable<string>): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const id of agentIds) out.set(id, currentModel(store, id)?.model);
  return out;
}

/**
 * Record a change for every agent whose model differs from the snapshot.
 * The old model's figures come from its stored profile. Returns the rows made.
 */
export function recordChanges(store: Store, before: Map<string, string | undefined>, meta: ChangeMeta, now = Date.now()): ModelChangeRow[] {
  const out: ModelChangeRow[] = [];
  for (const [agentId, from] of before) {
    const cur = currentModel(store, agentId);
    if (!cur || (from !== undefined && modelKey(from) === modelKey(cur.model))) continue;
    const row = recordChange(store, { agentId, from, to: cur.model, profileId: cur.profileId, ...meta }, now);
    if (row) out.push(row);
  }
  return out;
}

export function recordChange(store: Store, c: ChangeMeta & { agentId: string; from?: string; to: string; profileId?: string; at?: string; id?: string; approx?: boolean }, now = Date.now()): ModelChangeRow | undefined {
  const agent = store.getAgent(c.agentId);
  if (!agent) return undefined;
  const at = c.at ?? new Date(now).toISOString();
  const stored = store.modelProfiles([c.agentId]).get(c.agentId) as { profile: StoredProfile; at: string } | undefined;
  const row: ModelChangeRow = {
    id: c.id ?? `mc_${randomBytes(8).toString('hex')}`,
    agentId: c.agentId, ownerId: agent.ownerId,
    ...(c.from ? { from: c.from } : {}), to: c.to,
    ...(c.profileId ? { profileId: c.profileId } : {}),
    at, by: c.by, via: c.via, source: c.source,
    ...(c.why?.trim() ? { why: c.why.trim().slice(0, 400) } : {}),
    ...(c.proposalId ? { proposalId: c.proposalId } : {}),
    ...(c.approx ? { approx: true } : {}),
    before: beforeFigures(stored, c.from, at),
    outcome: 'pending',
  };
  return store.addModelChange(row) ? row : undefined;
}

// ---- verdicts ----------------------------------------------------------------

/**
 * Give every change that is due its verdict (persisted). Due: a week after
 * the change, or once the new model has EARLY_TURNS turns, or when a later
 * change ended its period. A not-enough-data verdict is looked at again until
 * the change is RECHECK_DAYS old. Returns the changes that became "worse".
 */
export function evaluateModelChanges(store: Store, now = Date.now(), ownerId?: string): ModelChangeRow[] {
  const open = store.listModelChanges({ ownerId, outcomes: ['pending', 'not-enough-data'], limit: 5000 });
  if (!open.length) return [];
  const agentIds = [...new Set(open.map((c) => c.agentId))];
  const profiles = store.modelProfiles(agentIds) as Map<string, { profile: StoredProfile; at: string }>;
  const worse: ModelChangeRow[] = [];
  const nowIso = new Date(now).toISOString();
  for (const agentId of agentIds) {
    const history = store.listModelChanges({ agentId, limit: 500 }).reverse(); // oldest first
    for (const c of open.filter((x) => x.agentId === agentId)) {
      const age = now - Date.parse(c.at);
      const next = history[history.findIndex((h) => h.id === c.id) + 1];
      if (c.outcome === 'not-enough-data' && (age > RECHECK_DAYS * DAY || next)) continue;
      const stored = profiles.get(agentId);
      // A backfilled change had only the 30-day totals (or nothing) for the old
      // model; once hour buckets are stored, its before is the hours before it.
      if (c.via === 'backfill' && stored && hasHours(stored.profile) && (c.before as ModelFigures | undefined)?.basis !== 'hours') {
        const better = beforeFigures(stored, c.from, c.at);
        if (better) { store.setModelChangeBefore(c.id, better); c.before = better; }
      }
      const after = afterFigures(stored, c.to, c.at, next?.at);
      const ended = !!next && !!stored && Date.parse(stored.at) >= Date.parse(next.at);
      const due = age >= VERDICT_AFTER_DAYS * DAY || (after?.turns ?? 0) >= EARLY_TURNS || ended;
      if (!due) continue;
      if (!after) {
        // No reading since the change (asleep, stopped, or not sampled yet): only a week on is that itself the answer.
        if (age < VERDICT_AFTER_DAYS * DAY && !ended) continue;
        if (stored && !hasHours(stored.profile) && age < RECHECK_DAYS * DAY) continue; // the new reader has not run yet
        if (c.outcome !== 'not-enough-data') store.setModelChangeOutcome(c.id, 'not-enough-data', undefined, ['no reading of the agent since the switch (asleep or stopped)'], nowIso);
        continue;
      }
      const v = judge(c.before as ModelFigures | undefined, after);
      store.setModelChangeOutcome(c.id, v.outcome, after, v.reasons, nowIso);
      if (v.outcome === 'worse') worse.push({ ...c, outcome: 'worse', after, reasons: v.reasons, outcomeAt: nowIso });
    }
  }
  return worse;
}

// ---- the guard's switch-back card ------------------------------------------------

export interface GuardDeps {
  store: Store;
  /** "Something is waiting" on the owner's Telegram (or Discord) through their manager's bot. */
  push?: (ownerId: string, headline: string, detail?: string) => void;
  log?: (event: string, detail: Record<string, unknown>) => void;
  now?: number;
}

const fmtFig = (label: string, f: ModelFigures) =>
  `${label} (${f.model}, ${f.days} day${f.days === 1 ? '' : 's'}): ${f.turns} turns, failed ${pct(f.rates.badTurn)}, `
  + `${f.malformed} malformed tool call${f.malformed === 1 ? '' : 's'}, tool failures ${pct(f.rates.toolFail)}, ${f.toolsPerTurn} tools per turn`;

const BY_WORDS: Record<ModelChangeRow['by'], string> = { owner: 'you', agent: 'your Hatchabot agent (you confirmed it)', hatchabot: "Hatchabot's guard (you confirmed it)" };

/** The switch-back card's text: what, why, and the numbers. */
export function guardCardText(agentName: string, c: ModelChangeRow): string {
  const after = c.after as ModelFigures | undefined;
  const before = c.before as ModelFigures | undefined;
  const when = new Date(c.at).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  return [
    `↩ Switch "${agentName}" back to ${c.from}`,
    `Hatchabot's quality guard: since "${agentName}" moved from ${c.from} to ${c.to} on ${when} (by ${BY_WORDS[c.by]}), it does worse.`,
    before ? fmtFig('Before', before) : `Before (${c.from}): no figures recorded.`,
    after ? fmtFig('After', after) : '',
    `Worse: ${(c.reasons ?? []).join('; ')}.`,
    'Nothing changes unless you Confirm. Cancel keeps it on ' + c.to + '; the guard will not ask again about this switch.',
  ].filter(Boolean).join('\n');
}

/**
 * One switch-back card per worse change — never for a change that was itself
 * a switch-back (no ping-pong), never when the agent has moved on since, and
 * only to a model its source still offers. The card is an ordinary
 * set_model proposal in "Alerts", marked as the guard's; nothing switches
 * until the owner confirms it.
 */
export function fileGuardProposals(deps: GuardDeps): string[] {
  const { store } = deps;
  const now = deps.now ?? Date.now();
  const filed: string[] = [];
  for (const c of store.listModelChanges({ outcomes: ['worse'], limit: 500 })) {
    if (c.guardProposalId || !c.from) continue;
    if (c.via === 'guard') { store.claimModelChangeGuard(c.id, 'none:was-a-switch-back'); continue; }
    if (now - Date.parse(c.outcomeAt ?? c.at) > RECHECK_DAYS * DAY) { store.claimModelChangeGuard(c.id, 'none:too-old'); continue; }
    const agent = store.getAgent(c.agentId);
    const profile = agent && store.getAIProfile(agent.aiProfileId);
    if (!agent || !profile || agent.state === 'DELETED' || agent.state === 'ARCHIVED' || agent.migratedTo) { store.claimModelChangeGuard(c.id, 'none:agent-gone'); continue; }
    if (modelKey(effectiveModel(agent, profile)) !== modelKey(c.to)) { store.claimModelChangeGuard(c.id, 'none:moved-on'); continue; }
    if (profile.vendor === 'local' || ![profile.model, ...(profile.models ?? [])].includes(c.from)) { store.claimModelChangeGuard(c.id, 'none:not-offered'); continue; }
    // A set_model card already waiting for this agent: let the owner deal with that one first.
    const waiting = store.listMgmtProposals<PendingConfirm>(agent.ownerId, now)
      .some((p) => p.status === 'pending' && p.tool === 'set_model' && p.resolved?.agentId === agent.id);
    if (waiting) continue;
    const id = 'c_' + randomBytes(6).toString('base64url');
    if (!store.claimModelChangeGuard(c.id, id)) continue;
    const summary = guardCardText(agent.name, c);
    const rec: PendingConfirm = {
      id, ownerId: agent.ownerId, chatId: 0, fromUserId: 0, messageId: 0,
      tool: 'set_model',
      resolved: { agentId: agent.id, agentName: agent.name, model: c.from, guardOf: c.id },
      summary, createdAtMs: now, expiresAtMs: now + GUARD_CARD_TTL_MS, status: 'pending',
      source: 'guard', risk: 'disruptive',
    };
    store.putMgmtProposal(rec);
    filed.push(id);
    deps.log?.('model.guard_proposed', { agentId: agent.id, changeId: c.id, confirmId: id, from: c.to, to: c.from });
    deps.push?.(agent.ownerId, `↩ Hatchabot suggests switching "${agent.name}" back to ${c.from}: it does worse on ${c.to}.`, (c.reasons ?? []).join('; '));
  }
  return filed;
}

// ---- the realised saving ------------------------------------------------------

export interface SavingRow {
  changeId: string;
  agentId: string;
  agent: string;
  from: string;
  to: string;
  since: string;
  until?: string;
  billing: 'api' | 'plan';
  source?: string;
  /** Tokens used on the new model in the month (millions). */
  tokensM: number;
  savingUSD: number;
  /** Plan sources: the saving as a share of the source's use this month at API prices. */
  sourceShare?: number;
}

export interface RightSize {
  /** The UTC calendar month the figures are for, "2026-10". */
  month: string;
  savingUSD: number;
  /** Of which on API-key sources (money) and on Claude plans (room in the plan, priced at API rates). */
  apiUSD: number;
  planUSD: number;
  rows: SavingRow[];
  /** Earlier months the stored 30 days still reach (partial: the hours before the window are gone). */
  earlier: Array<{ month: string; savingUSD: number; partial: true }>;
  /** "Right-size: ≈ $12.40 this month", or undefined when there is nothing to say. */
  line?: string;
  notes: string[];
}

const monthOf = (h: string) => h.slice(0, 7);
const mixOf = (c: Counts): TokenMix => ({ input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite });

/** A source's use per month at API prices: every agent on it, any account's, as totals only. */
function sourceMonthUSD(store: Store, profileId: string, month: string): number {
  const agents = store.listAllActiveAgents().filter((a) => a.aiProfileId === profileId);
  const profiles = store.modelProfiles(agents.map((a) => a.id)) as Map<string, { profile: StoredProfile; at: string }>;
  let total = 0;
  for (const { profile } of profiles.values()) {
    for (const [model, s] of Object.entries(profile.models ?? {})) {
      const c = zero();
      for (const [h, v] of Object.entries(s.h ?? {})) if (monthOf(h) === month) HOUR_FIELDS.forEach((f, i) => { c[f] += Number(v[i]) || 0; });
      total += priceMix(model, mixOf(c)) ?? 0;
    }
  }
  return total;
}

/**
 * What the owner's cheaper switches saved: for each change to a cheaper
 * model, the tokens the agent actually used on the new model from the switch
 * (to its next change) × the price difference at API rates. On a Claude plan
 * nothing is billed per token, so there it is "≈ $X at API prices" and its
 * share of what the source carried. Upgrades are not netted off here.
 */
export function rightSizeSavings(store: Store, ownerId: string, now = Date.now()): RightSize {
  const month = new Date(now).toISOString().slice(0, 7);
  // Every change still in the ledger: a switch made months ago saves again this month.
  const changes = store.listModelChanges({ ownerId, limit: 5000 }).reverse();
  const agentIds = [...new Set(changes.map((c) => c.agentId))];
  const profiles = store.modelProfiles(agentIds) as Map<string, { profile: StoredProfile; at: string }>;
  const rows: SavingRow[] = [];
  const earlier = new Map<string, number>();
  const shareCache = new Map<string, number>();
  for (const c of changes) {
    if (!c.from) continue;
    const stored = profiles.get(c.agentId);
    if (!stored || !hasHours(stored.profile)) continue;
    const next = changes.find((x) => x.agentId === c.agentId && x.at > c.at);
    const byMonth = new Map<string, Counts>();
    const k = modelKey(c.to);
    for (const [m, s] of Object.entries(stored.profile.models ?? {})) {
      if (modelKey(m) !== k && m !== c.to) continue;
      for (const [h, v] of Object.entries(s.h ?? {})) {
        if (h < hourOf(c.at) || (next && h >= hourOf(next.at))) continue;
        const counts = byMonth.get(monthOf(h)) ?? zero();
        HOUR_FIELDS.forEach((f, i) => { counts[f] += Number(v[i]) || 0; });
        byMonth.set(monthOf(h), counts);
      }
    }
    const profile = store.getAIProfile(c.profileId ?? store.getAgent(c.agentId)?.aiProfileId ?? '');
    if (profile?.vendor === 'local') continue;
    const billing: SavingRow['billing'] = profile?.kind === 'subscription' ? 'plan' : 'api';
    for (const [m, counts] of byMonth) {
      const mix = mixOf(counts);
      const was = priceMix(c.from, mix), is = priceMix(c.to, mix);
      if (was === undefined || is === undefined || !(was > is)) continue;
      const saving = was - is;
      if (m !== month) { earlier.set(m, (earlier.get(m) ?? 0) + saving); continue; }
      let sourceShare: number | undefined;
      if (billing === 'plan' && profile) {
        if (!shareCache.has(profile.id)) shareCache.set(profile.id, sourceMonthUSD(store, profile.id, month));
        const used = shareCache.get(profile.id)!;
        sourceShare = r3(saving / (used + saving));
      }
      rows.push({
        changeId: c.id, agentId: c.agentId, agent: store.getAgent(c.agentId)?.name ?? '(deleted agent)',
        from: c.from, to: c.to, since: c.at, ...(next ? { until: next.at } : {}),
        billing, ...(profile ? { source: profile.name } : {}),
        tokensM: r2((mix.input + mix.output + mix.cacheRead + mix.cacheWrite) / 1e6),
        savingUSD: r2(saving), ...(sourceShare !== undefined ? { sourceShare } : {}),
      });
    }
  }
  rows.sort((a, b) => b.savingUSD - a.savingUSD);
  const apiUSD = r2(rows.filter((r) => r.billing === 'api').reduce((s, r) => s + r.savingUSD, 0));
  const planUSD = r2(rows.filter((r) => r.billing === 'plan').reduce((s, r) => s + r.savingUSD, 0));
  const savingUSD = r2(apiUSD + planUSD);
  const shares = rows.filter((r) => r.sourceShare !== undefined);
  const line = savingUSD >= 0.01
    ? `Right-size: ≈ $${savingUSD.toFixed(2)} this month`
      + (planUSD && !apiUSD ? ` at API prices${shares.length === 1 ? ` (${pct(shares[0]!.sourceShare!)} of ${shares[0]!.source}'s use)` : ''}: on a Claude plan that is room in the plan, not money`
        : planUSD ? ` ($${apiUSD.toFixed(2)} on API keys, ≈ $${planUSD.toFixed(2)} at API prices on Claude plans)` : '')
    : undefined;
  return {
    month, savingUSD, apiUSD, planUSD, rows,
    earlier: [...earlier.entries()].sort(([a], [b]) => b.localeCompare(a)).map(([m, v]) => ({ month: m, savingUSD: r2(v), partial: true as const })),
    ...(line ? { line } : {}),
    notes: [
      'Saving = tokens actually used on the new model since the switch (to its next change) × the price difference, at API list prices. Only switches to a cheaper model count; upgrades are not netted off.',
      'On a Claude plan nothing is billed per token: the figure is what the same use would have cost by API, and sourceShare is its part of what the source carried this month.',
    ],
  };
}

// ---- the proposal-time check (the set_model card) ---------------------------------

export interface ModelCheck {
  from: string;
  to: string;
  downgrade: boolean;
  /** One line of what the scorecard says, for the card. */
  evidence: string;
  /** Plain risks of this downgrade; empty when none (or not a downgrade). */
  warnings: string[];
}

/**
 * What the card for "this agent → that model" should say: the scorecard's
 * evidence, and — for a downgrade — the risks: thin evidence, heavy tool use,
 * recent errors. The owner still decides; the card states the risk plainly.
 */
export function assessModelChange(store: Store, agent: Agent, profile: AIProfile | undefined, to: string, now = Date.now()): ModelCheck {
  const stored = store.modelProfiles([agent.id]).get(agent.id) as { profile: StoredProfile; at: string } | undefined;
  const row = scoreAgent(agent, profile, stored, { now });
  const from = profile ? effectiveModel(agent, profile) : row.model;
  const mix = Object.values(stored?.profile.models ?? {}).reduce<TokenMix>((s, m) => ({ input: s.input + m.input, output: s.output + m.output, cacheRead: s.cacheRead + m.cacheRead, cacheWrite: s.cacheWrite + m.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const unit: TokenMix = { input: 1e6, output: 1e5, cacheRead: 0, cacheWrite: 0 };
  const basis = mix.input + mix.output + mix.cacheRead + mix.cacheWrite > 0 ? mix : unit;
  const pf = priceMix(from, basis), pt = priceMix(to, basis);
  const tf = modelOption(from)?.tier, tt = modelOption(to)?.tier;
  const same = modelKey(from) === modelKey(to);
  const downgrade = !same && ((pf !== undefined && pt !== undefined && pt < pf) || (tf !== undefined && tt !== undefined && tt < tf));
  // Model-caused failures this week: failed turns that were not rate limits, and cut-off answers.
  let bad7 = 0;
  if (stored && hasHours(stored.profile)) {
    const from7 = new Date(now - 7 * DAY).toISOString().slice(0, 13);
    for (const m of Object.keys(stored.profile.models ?? {})) {
      const { counts } = sumHours(stored.profile, m, from7);
      bad7 += Math.max(0, counts.failed - counts.limitedTurns) + counts.truncated;
    }
  } else {
    bad7 = Math.max(0, (row.errors.failed7d ?? 0) - (row.errors.rateLimited ?? 0));
  }
  const malformed = row.errors.malformedToolCall ?? 0;
  const errs = [
    bad7 ? `${bad7} failed turn${bad7 === 1 ? '' : 's'} in the last 7 days (not rate limits)` : '',
    malformed ? `${malformed} malformed tool call${malformed === 1 ? '' : 's'} in 30 days` : '',
  ].filter(Boolean);
  const monthNow = row.monthlyUSD;
  const monthTo = row.cheaperOptions.find((o) => modelKey(o.model) === modelKey(to))?.monthlyUSD
    ?? (row.days && pt !== undefined && mix.input + mix.output > 0 ? r2((pt * 30) / row.days) : undefined);
  const evidence = !stored
    ? `Evidence: Hatchabot has no reading of this agent's use yet.`
    : `Evidence (${row.days} days, now ${from}${row.state === 'asleep' ? ', asleep' : ''}): ${row.turns} turns`
      + `${row.days ? ` (${r1(row.turns / Math.max(1, row.days))}/day)` : ''}, ${row.toolsPerTurn} tools per turn, tools in ${Math.round(row.toolTurnShare * 100)}% of turns, `
      + `context ~${row.ctxK.p50}K per call, ${errs.length ? errs.join(', ') : 'no errors'}`
      + (monthNow !== undefined ? `; ≈ $${monthNow.toFixed(2)} a month${monthTo !== undefined && !same ? ` → ≈ $${monthTo.toFixed(2)} on ${to}` : ''} at API prices` : '')
      + (row.billing === 'plan' ? ' (a Claude plan: room in the plan, not money)' : '') + '.';
  const warnings: string[] = [];
  if (downgrade) {
    if (row.evidence === 'none') warnings.push(`Thin evidence: no turns recorded on ${from} in the last 30 days.`);
    else if (row.evidence === 'thin') warnings.push(`Thin evidence: ${row.turnsOnModel} turn${row.turnsOnModel === 1 ? '' : 's'} on ${from} in ${row.days} day${row.days === 1 ? '' : 's'}.`);
    if (row.toolsPerTurn > RISK.toolsPerTurn || row.toolTurnShare > RISK.toolTurnShare) {
      warnings.push(`Heavy tool use: ${row.toolsPerTurn} tools per turn, tools in ${Math.round(row.toolTurnShare * 100)}% of turns. Smaller models make more malformed or wrong tool calls.`);
    }
    if (errs.length) warnings.push(`Recent errors: ${errs.join(', ')}.`);
  }
  return { from, to, downgrade, evidence, warnings };
}

// ---- the start-up backfill --------------------------------------------------------

/**
 * Seed the ledger from what was changed before it existed: each confirmed
 * set_model card still in mgmt_proposals (a week is kept), and — where the
 * agent's model differs from that card's today — the later change made by
 * hand or through the API, timed from the last use of the card's model
 * (marked approx). Idempotent: rows are keyed by the card's id.
 */
export function backfillModelLedger(store: Store, now = Date.now()): number {
  let added = 0;
  const cards = store.confirmedModelProposals();
  const lastCardFor = new Map<string, { id: string; model: string; atMs: number; ownerId: string }>();
  const profiles = store.modelProfiles([...new Set(cards.map((c) => (c.record as PendingConfirm).resolved?.agentId).filter(Boolean))]) as Map<string, { profile: StoredProfile; at: string }>;
  for (const card of cards) {
    const rec = card.record as PendingConfirm;
    const agentId = rec.resolved?.agentId, model = rec.resolved?.model;
    if (!agentId || !model || !String(card.outcome ?? '').startsWith('✅') || !card.resolvedAtMs) continue;
    const prev = lastCardFor.get(agentId);
    const atMs = card.resolvedAtMs;
    let from: string | undefined = prev?.model;
    if (!from) {
      // The model the agent ran before the card: one it had used by then —
      // the one used last before it, else (used again since: a switch back)
      // the one used most recently.
      const p = profiles.get(agentId)?.profile;
      const earlier = Object.entries(p?.models ?? {}).filter(([m, s]) => modelKey(m) !== modelKey(model) && s.first > 0 && s.first <= atMs);
      const used = earlier.filter(([, s]) => s.last <= atMs + 60_000).sort(([, a], [, b]) => b.last - a.last)[0]
        ?? earlier.sort(([, a], [, b]) => b.last - a.last)[0];
      from = used?.[0];
    }
    lastCardFor.set(agentId, { id: card.id, model, atMs, ownerId: card.ownerId });
    if (store.modelChangeForProposal(card.id) || store.getModelChange(`mcb_${card.id}`)) continue;
    const row = recordChange(store, {
      id: `mcb_${card.id}`, agentId, from, to: model, at: new Date(atMs).toISOString(),
      by: rec.source === 'agent' ? 'agent' : rec.source === 'guard' ? 'hatchabot' : 'owner',
      via: 'backfill', source: 'model', why: rec.note, proposalId: card.id,
      profileId: store.getAgent(agentId)?.aiProfileId,
    }, now);
    if (row) added++;
  }
  // A later change by hand or the API: the agent no longer runs the card's model.
  for (const [agentId, card] of lastCardFor) {
    const cur = currentModel(store, agentId);
    if (!cur || modelKey(cur.model) === modelKey(card.model)) continue;
    if (store.listModelChanges({ agentId, sinceIso: new Date(card.atMs + 1).toISOString(), limit: 1 }).length) continue; // recorded already
    const p = profiles.get(agentId)?.profile;
    const lastOnCard = Math.max(0, ...entriesForSafe(p, card.model).map((s) => s.last || 0));
    const atMs = Math.max(card.atMs + 60_000, lastOnCard + 1000);
    if (atMs > now) continue;
    const row = recordChange(store, {
      id: `mcb_${card.id}_next`, agentId, from: card.model, to: cur.model, at: new Date(atMs).toISOString(), approx: true,
      by: 'owner', via: 'backfill', source: 'model', profileId: cur.profileId,
      why: 'Changed in the app or through the API after the card (time estimated from the last use of the card\'s model).',
    }, now);
    if (row) added++;
  }
  return added;
}

function entriesForSafe(p: StoredProfile | undefined, model: string): WindowModelStats[] {
  return p ? entriesFor(p, model) : [];
}
