import type { Agent, AIProfile } from '../domain/types.js';
import type { Store } from '../store/store.js';
import type { ModelProfile, WindowModelStats, TurnErrors } from './usage.js';
import { modelOption, priceMix, sourceModels, type TokenMix } from './modelOptions.js';

/**
 * The model scorecard: one compact row per agent the caller owns, for the
 * management agent's model steward (docs/features.md, "Right-size").
 *
 * Built ONLY from what Hatchabot already holds: the 30-day profile the usage
 * sampler reads from each running agent's transcripts on its regular pass
 * (agent_model_profiles), the log-derived call counts, and the agent and
 * source records. A review runs no command in any container and wakes no
 * sleeping agent; an asleep agent shows the profile from before it slept,
 * with its age.
 *
 * Costs are API list prices (modelOptions.ts). On a Claude plan nothing is
 * billed per token, so there the figure is what the same use would cost by
 * API, and `planShare` is the agent's part of everything on that source.
 */

const DAY = 86_400_000;

/** What the sampler stores per agent: the reader's profile, with only this agent's own Purpose excerpt. */
export type StoredProfile = Omit<ModelProfile, 'purposes'> & { purpose?: string };

export interface ScorecardOption { model: string; monthlyUSD: number; savingUSD: number; tier?: number }

export interface ScorecardRow {
  agent: string;
  id: string;
  /** awake | asleep | stopped | provisioning | failed … */
  state: string;
  purpose?: string;
  source: string;
  billing: 'plan' | 'api' | 'local';
  model: string;
  /** The model is set on the agent itself (else it follows its source's default). */
  pinned: boolean;
  class?: string;
  /** Days of history behind the figures (up to 30), and how old the reading is. */
  days: number;
  readHoursAgo?: number;
  calls: number;
  /** Millions of tokens over the window. */
  tokensM: { in: number; out: number; cacheRead: number; cacheWrite: number };
  /** Cache reads as a share of everything carried in. */
  cacheShare: number;
  /** Tokens a call carried in (thousands), median and 90th percentile. */
  ctxK: { p50: number; p90: number };
  turns: number;
  /** Share of turns that used at least one tool, and tool calls per turn. */
  toolTurnShare: number;
  toolsPerTurn: number;
  /** Non-zero counts only (see TurnErrors); failed7d = failed or truncated turns in the last 7 days. */
  errors: Partial<TurnErrors> & { failedTurns?: number; failed7d?: number; promptErrors?: number; httpFailed8d?: number };
  scheduledTasks?: number;
  /** The same use for a month on the current model, at API prices (USD). */
  monthlyUSD?: number;
  /** Plan sources: this agent's part of the source's use over the window (by API-price weight). */
  planShare?: number;
  /** none | thin | ok: how much history the current model has. */
  evidence: 'none' | 'thin' | 'ok';
  /** The current model's turns in the window. */
  turnsOnModel: number;
  /** When the window shows more than one model: each, newest use first — the before and after of a switch. */
  byModel?: Array<{ model: string; calls: number; turns: number; toolsPerTurn: number; failedTurns: number; malformed: number; lastUsed: string }>;
  cheaperOptions: ScorecardOption[];
}

export interface Scorecard {
  generatedAt: string;
  rows: ScorecardRow[];
  /** Rows left out by the cap (smallest cost first). */
  omitted: number;
  /** Archived agents are not reviewed. */
  archived: number;
  totals: { monthlyUSD: number; bestSavingUSD: number };
  notes: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r1 = (x: number) => Math.round(x * 10) / 10;
const mega = (x: number) => r2(x / 1e6);

function sumMix(models: WindowModelStats[]): TokenMix {
  return models.reduce((s, m) => ({ input: s.input + m.input, output: s.output + m.output, cacheRead: s.cacheRead + m.cacheRead, cacheWrite: s.cacheWrite + m.cacheWrite }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

/** What the window's calls cost at the models they actually ran on (unknown models add nothing). */
export function windowCost(p: StoredProfile | undefined): number {
  if (!p) return 0;
  return Object.entries(p.models).reduce((s, [model, m]) => s + (priceMix(model, m) ?? 0), 0);
}

/** Days of history the profile covers: from the later of the window's start and the agent's first call (or creation), at least one. */
export function coverageDays(p: StoredProfile, readAt: number, createdAt?: string): number {
  const start = Math.max(p.since, p.firstCall > 0 ? p.firstCall : Date.parse(createdAt ?? '') || p.since);
  return Math.min(30, Math.max(1, (readAt - start) / DAY));
}

function stateOf(a: Agent): string {
  if (a.state === 'STOPPED' && a.hibernatedAt) return 'asleep';
  if (a.state === 'RUNNING') return 'awake';
  return a.state.toLowerCase();
}

const ERR_KEYS: Array<keyof TurnErrors> = ['malformedToolCall', 'providerError', 'rateLimited', 'aborted', 'truncated', 'toolFailed', 'retried'];

export function scoreAgent(a: Agent, profile: AIProfile | undefined, stored: { profile: StoredProfile; at: string } | undefined, ctx: {
  now: number; className?: string; sourceTotal?: number; httpFailed8d?: number;
}): ScorecardRow {
  const p = stored?.profile;
  const readAt = stored ? Date.parse(stored.at) : ctx.now;
  const model = a.model ?? profile?.model ?? '(unknown)';
  const entries = Object.entries(p?.models ?? {});
  const all = entries.map(([, m]) => m);
  const mix = sumMix(all);
  const calls = all.reduce((s, m) => s + m.calls, 0);
  const turns = all.reduce((s, m) => s + m.turns, 0);
  const toolTurns = all.reduce((s, m) => s + m.toolTurns, 0);
  const toolCalls = all.reduce((s, m) => s + m.toolCalls, 0);
  const busiest = [...all].sort((x, y) => y.calls - x.calls)[0];
  const carried = mix.input + mix.cacheRead + mix.cacheWrite;
  const errors: ScorecardRow['errors'] = {};
  for (const k of ERR_KEYS) { const v = all.reduce((s, m) => s + (m.err?.[k] ?? 0), 0); if (v) errors[k] = v; }
  const failedTurns = all.reduce((s, m) => s + m.failedTurns, 0);
  const failed7d = all.reduce((s, m) => s + m.failed7d, 0);
  if (failedTurns) errors.failedTurns = failedTurns;
  if (failed7d) errors.failed7d = failed7d;
  if (p?.promptErrors) errors.promptErrors = p.promptErrors;
  if (ctx.httpFailed8d) errors.httpFailed8d = ctx.httpFailed8d;
  const days = p ? coverageDays(p, readAt, a.createdAt) : 0;
  const billing: ScorecardRow['billing'] = profile?.vendor === 'local' ? 'local' : profile?.kind === 'subscription' ? 'plan' : 'api';
  const atCurrent = billing === 'local' || !p ? undefined : priceMix(model, mix);
  const monthly = atCurrent === undefined ? undefined : (atCurrent * 30) / days;
  const cur = modelOption(model);
  const onModel = entries.filter(([m]) => modelOption(m)?.id === cur?.id || m === model).map(([, m]) => m);
  const turnsOnModel = onModel.reduce((s, m) => s + m.turns, 0);
  const evidence: ScorecardRow['evidence'] = !calls ? 'none' : turnsOnModel < 10 || days < 3 ? 'thin' : 'ok';
  const options: ScorecardOption[] = [];
  if (monthly !== undefined && cur && profile) {
    for (const id of sourceModels(profile)) {
      const o = modelOption(id);
      if (!o || o.legacy || o.limited || o.id === cur.id) continue;
      const m = priceMix(id, mix);
      if (m === undefined) continue;
      const mo = (m * 30) / days;
      if (mo < monthly - 0.005) options.push({ model: id, monthlyUSD: r2(mo), savingUSD: r2(monthly - mo), tier: o.tier });
    }
    options.sort((x, y) => y.savingUSD - x.savingUSD);
  }
  const row: ScorecardRow = {
    agent: a.name, id: a.id, state: stateOf(a),
    ...(p?.purpose || a.persona ? { purpose: (p?.purpose || a.persona).replace(/\s+/g, ' ').trim().slice(0, 200) } : {}),
    source: profile?.name ?? '(none)', billing, model, pinned: !!a.model,
    ...(ctx.className ? { class: ctx.className } : {}),
    days: r1(days),
    ...(stored ? { readHoursAgo: r1(Math.max(0, ctx.now - readAt) / 3_600_000) } : {}),
    calls,
    tokensM: { in: mega(mix.input), out: mega(mix.output), cacheRead: mega(mix.cacheRead), cacheWrite: mega(mix.cacheWrite) },
    cacheShare: carried ? r2(mix.cacheRead / carried) : 0,
    ctxK: { p50: Math.round((busiest?.ctxP50 ?? 0) / 1000), p90: Math.round((busiest?.ctxP90 ?? 0) / 1000) },
    turns,
    toolTurnShare: turns ? r2(toolTurns / turns) : 0,
    toolsPerTurn: turns ? r1(toolCalls / turns) : 0,
    errors,
    ...(typeof p?.crons === 'number' ? { scheduledTasks: p.crons } : {}),
    ...(monthly !== undefined ? { monthlyUSD: r2(monthly) } : {}),
    ...(billing === 'plan' && ctx.sourceTotal ? { planShare: r2(windowCost(p) / ctx.sourceTotal) } : {}),
    evidence, turnsOnModel,
    cheaperOptions: options.slice(0, 3),
  };
  if (entries.length > 1) {
    row.byModel = entries
      .map(([m, s]) => ({ model: m, calls: s.calls, turns: s.turns, toolsPerTurn: s.turns ? r1(s.toolCalls / s.turns) : 0, failedTurns: s.failedTurns,
        malformed: s.err?.malformedToolCall ?? 0, lastUsed: s.last ? new Date(s.last).toISOString().slice(0, 16) + 'Z' : '' }))
      .sort((x, y) => y.lastUsed.localeCompare(x.lastUsed))
      .slice(0, 3);
  }
  return row;
}

/**
 * The scorecard for one owner: their own agents only (a member sees theirs,
 * the machine owner theirs — usage is what each one's plan spends). Plan
 * shares weigh every agent on the source, any account's, as totals only.
 */
export function buildScorecard(store: Store, ownerId: string, opts: { now?: number; limit?: number } = {}): Scorecard {
  const now = opts.now ?? Date.now();
  const limit = Math.min(Math.max(1, opts.limit ?? 40), 100);
  const mine = store.listAgents(ownerId).filter((a) => a.state !== 'DELETED');
  const archived = mine.filter((a) => a.state === 'ARCHIVED').length;
  const live = mine.filter((a) => a.state !== 'ARCHIVED');
  const profiles = new Map<string, AIProfile | undefined>();
  const profileOf = (id: string) => { if (!profiles.has(id)) profiles.set(id, store.getAIProfile(id)); return profiles.get(id); };
  // Each plan source's whole window, every account's agents on it (a sum, nothing else of theirs).
  const planSources = new Set(live.map((a) => a.aiProfileId).filter((id) => profileOf(id)?.kind === 'subscription' && profileOf(id)?.vendor !== 'local'));
  const onPlans = store.listAllActiveAgents().filter((a) => planSources.has(a.aiProfileId));
  const stored = store.modelProfiles([...new Set([...live.map((a) => a.id), ...onPlans.map((a) => a.id)])]) as Map<string, { profile: StoredProfile; at: string }>;
  const sourceTotal = new Map<string, number>();
  for (const a of onPlans) sourceTotal.set(a.aiProfileId, (sourceTotal.get(a.aiProfileId) ?? 0) + windowCost(stored.get(a.id)?.profile));
  // Calls the logs saw fail (not rate limits), last 8 days: what Hatchabot already counts.
  const from = new Date(now - 8 * DAY).toISOString().slice(0, 13);
  const httpFailed = new Map<string, number>();
  for (const r of store.modelCallHoursForAgents(new Set(live.map((a) => a.id)), from)) httpFailed.set(r.agentId, (httpFailed.get(r.agentId) ?? 0) + r.failed);
  const classes = new Map(store.listAgentClasses(ownerId).map((c) => [c.id, c.name]));
  const rows = live.map((a) => scoreAgent(a, profileOf(a.aiProfileId), stored.get(a.id), {
    now, className: a.classId ? classes.get(a.classId) : undefined, sourceTotal: sourceTotal.get(a.aiProfileId), httpFailed8d: httpFailed.get(a.id),
  })).sort((x, y) => (y.monthlyUSD ?? -1) - (x.monthlyUSD ?? -1) || y.calls - x.calls);
  const shown = rows.slice(0, limit);
  return {
    generatedAt: new Date(now).toISOString(),
    rows: shown,
    omitted: rows.length - shown.length,
    archived,
    totals: {
      monthlyUSD: r2(rows.reduce((s, r) => s + (r.monthlyUSD ?? 0), 0)),
      bestSavingUSD: r2(rows.reduce((s, r) => s + (r.cheaperOptions[0]?.savingUSD ?? 0), 0)),
    },
    notes: [
      'Last 30 days (days = how much history there is). monthlyUSD = this use for a month on the current model at API list prices; on a Claude plan that is an equivalent, not a bill.',
      'errors are counts from the transcripts: malformedToolCall = OpenClaw rejected a tool call the model wrote; failedTurns = turns that ended in an error (rateLimited is the source, not the model); toolFailed = tool results that came back as errors.',
      'Asleep agents show their last reading (readHoursAgo); nothing here wakes them.',
    ],
  };
}
