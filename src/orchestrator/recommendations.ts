import type { Agent, AIProfile } from '../domain/types.js';
import type { Store, TokenIncidentRow } from '../store/store.js';
import type { PendingConfirm } from '../mgmt/pendingStore.js';
import type { TokenHealthRaw } from './usage.js';
import { agentCost, costsFor } from './agentCosts.js';
import { budgetLine, budgetView, MACHINE, monthElapsed, monthKey, monthName, monthSpend, stepView, suggestBudget, type BudgetView } from './budgets.js';
import { assessModelChange, type ModelFigures } from './modelLedger.js';
import { modelOption } from './modelOptions.js';
import { buildScorecard, type StoredProfile } from './modelScorecard.js';
import { summarizeSourceUsage } from './sourceUsage.js';
import { buildTokenHealth, clockOf, THRESHOLDS } from './tokenHealth.js';

/**
 * Recommended (docs/recommendations-design.md): ONE ranked list of the cost,
 * model and token advice that seven features used to give in seven places.
 *
 * Built only from the existing checks — each keeps its own thresholds and
 * code, and nothing here re-implements one:
 *   - loops: the watcher's open incidents (tokenWatch.ts / tokenHealth.ts);
 *   - budgets at 100% and past 80% before mid-month (budgets.ts budgetView);
 *   - today's spike (usageAlerts.ts, the usage_alerts it recorded);
 *   - a rate-limited source (sourceUsage.ts summarizeSourceUsage);
 *   - a switch that went worse (modelLedger.ts: the guard's card);
 *   - a cheaper model (modelScorecard.ts scoreAgent: evidence "ok" only, the
 *     saving priced on the agent's own token mix; assessModelChange's risks);
 *   - a big conversation (tokenHealth.ts flags large-conversation / compact-now);
 *   - an agent over about $20 a month with no budget (budgets.ts suggestBudget);
 *   - the Hatchabot agent's pending cost and model cards (mgmt_proposals).
 *
 * One cause, one item: a loop absorbs its agent's spike, budget and step lines
 * and its conversation size when the loop is a compaction. Each item carries
 * one action through the SAME route its card uses (the owner's click is the
 * confirmation; the page sends x-hatchabot-recommendation so the ledger says
 * via "recommendation"), and "Not now" puts it away until its cause changes
 * (its fingerprint, like Alerts' Clear). Stored data only: nothing is read
 * from a container and nothing is woken.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A cheaper model is worth an item from this saving a month (the steward's "under about $5 a month: leave it"). */
export const CHEAPER_MIN_USD = 5;
/** An agent costing this much a month (at its pace this week) with no budget gets one suggested. */
export const NO_BUDGET_FROM_USD = 20;
/** A budget past 80% is news while less than this share of the month has gone. */
export const PACE_BEFORE = 0.5;
/** A dismissal whose item is gone is forgotten after this long. */
const KEEP_DISMISSED_MS = 60 * DAY;

/** The design's order: what is happening now, then what money a change would save. */
export const GROUP = { loop: 1, 'budget-limit': 2, spike: 3, 'rate-limit': 3.5, 'budget-pace': 4, 'switch-back': 5, 'cheaper-model': 6, 'big-conversation': 6, 'no-budget': 6, proposal: 6 } as const;
export type RecKind = keyof typeof GROUP;

export interface RecAction {
  /** set-model / compact / context-cap / set-budget / pause-task / confirm-card call a route; open-* only take the owner somewhere. */
  kind: 'set-model' | 'compact' | 'context-cap' | 'set-budget' | 'pause-task' | 'confirm-card' | 'cancel-card' | 'open-usage' | 'open-sources' | 'open-budgets' | 'open-agent';
  label: string;
  /** The route the page calls: the one the matching card uses. */
  method?: 'POST' | 'PUT' | 'PATCH';
  path?: string;
  body?: Record<string, unknown>;
  /** Said before it acts, when the click drops something (a compaction's older lines). */
  confirm?: string;
  /** For open-*: the agent. */
  agentId?: string;
}

export interface Recommendation {
  /** Stable per cause: the same loop, budget, agent's model … is the same id across passes. */
  id: string;
  kind: RecKind;
  agents: Array<{ id: string; name: string }>;
  /** The machine as a whole (its budget), not one agent. */
  machine?: true;
  /** "Recipe Box is stuck in a loop". */
  title: string;
  /** The concern in a sentence. */
  concern: string;
  /** Counts, dates, the scorecard's evidence level ("thin" is said). */
  evidence: string[];
  /** What the action is expected to do, in dollars a month (on a plan, tokens or an equivalent, said so). */
  effect?: { text: string; usdPerMonth?: number; usdPerDay?: number; tokensPerMonth?: number; billing: 'api' | 'plan' | 'mixed' };
  action?: RecAction;
  secondary: RecAction[];
  /** The Hatchabot agent filed this as a card (its reason in the evidence); the guard filed a switch-back. */
  proposedBy?: 'agent' | 'guard';
  proposalId?: string;
  /** Shown as one line under Alerts (a live loop, a budget at 100%, today's spike). */
  alert?: true;
  /** Ids of the items this one stands for (one cause, one item). */
  absorbs?: string[];
  rank: { group: number; money: number };
  /** What "Not now" remembers: the item comes back when this changes. */
  fingerprint: string;
}

export interface RecommendationList {
  generatedAt: string;
  items: Recommendation[];
  /** Put away with Not now (cause unchanged). */
  dismissed: number;
  notes: string[];
}

const r2 = (x: number) => Math.round(x * 100) / 100;
export const money = (x: number): string => (x >= 100 ? `$${Math.round(x)}` : x >= 10 ? `$${x.toFixed(0)}` : `$${x.toFixed(2)}`);
const whole = (x: number) => (Number.isInteger(x) ? `$${x}` : `$${x.toFixed(2)}`);
export const tokensText = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));
const bare = (m: string) => m.replace(/^.*\//, '');

type Billing = 'api' | 'plan' | 'local';
const billingOf = (p: AIProfile | undefined): Billing => (p?.vendor === 'local' ? 'local' : p?.kind === 'subscription' ? 'plan' : 'api');

/** A saving in words: dollars on an API key; on a Claude plan, tokens (when known) and the API-price equivalent, said so. */
export function effectWords(usdPerMonth: number, billing: Billing, tokensPerMonth?: number): string {
  if (billing === 'plan') {
    return tokensPerMonth && tokensPerMonth >= 1e6
      ? `≈ ${tokensText(tokensPerMonth)} fewer tokens a month on your Claude plan (≈ ${money(usdPerMonth)} at API prices — room in the plan, not money)`
      : `≈ ${money(usdPerMonth)} a month at API prices — on your Claude plan that is room in the plan, not money`;
  }
  return `≈ ${money(usdPerMonth)} a month`;
}

/** The cost and model cards whose place is now this list (other cards stay in the home screen's list). */
export const COST_TOOLS = new Set(['set_model', 'compact_agent', 'set_context_cap', 'set_budget', 'set_spend_alert', 'set_cron_enabled']);
/** Whether a pending card shows as a Recommended item rather than in the cards list. */
export function isCostCard(p: Pick<PendingConfirm, 'tool' | 'resolved'>): boolean {
  if (!COST_TOOLS.has(p.tool)) return false;
  // A task turned off is cost advice (a failing task's loop); turning one on is not.
  if (p.tool === 'set_cron_enabled') return (p.resolved?.rest?.call.body as { enabled?: unknown } | undefined)?.enabled === false;
  return true;
}

/** The label a card's click carries: what that card will do, from its own call. */
function cardLabel(p: PendingConfirm): string {
  const body = (p.resolved?.rest?.call.body ?? {}) as Record<string, unknown>;
  switch (p.tool) {
    case 'set_model': return p.source === 'guard' ? `Switch back to ${bare(String(p.resolved.model ?? ''))}` : `Switch to ${bare(String(p.resolved.model ?? ''))}`;
    case 'compact_agent': return body.mode === 'lines' ? `Compact it (keep the last ${typeof body.lines === 'number' ? body.lines : THRESHOLDS.keepLines} lines)` : 'Compact it now';
    case 'set_context_cap': return typeof body.tokens === 'number' ? `Cap it at ${Math.round(body.tokens / 1000)}K` : 'Remove its cap';
    case 'set_budget': return typeof body.usd === 'number' ? `Set a ${whole(body.usd)} budget` : 'Remove its budget';
    case 'set_spend_alert': return typeof body.every === 'number' ? `Tell me every ${whole(body.every)}` : 'Stop the spending alerts';
    case 'set_cron_enabled': return 'Pause the task';
    default: return 'Confirm';
  }
}
const confirmCard = (p: PendingConfirm): RecAction => ({ kind: 'confirm-card', label: cardLabel(p), method: 'POST', path: `/v1/proposals/${encodeURIComponent(p.id)}/confirm`, body: {} });

interface Ctx {
  store: Store;
  ownerId: string;
  now: number;
  tz: string;
  agents: Agent[];
  byId: Map<string, Agent>;
  profileOf(a: Agent): AIProfile | undefined;
  billing(a: Agent): Billing;
  /** API-price cost of the last `hours`, from the stored hour buckets. */
  costOver(a: Agent, hours: number): number;
  /** Each agent's rate this week as a month (the badges' and get_budgets' figure). */
  rates(): ReturnType<typeof costsFor>;
}

const ref = (a: Agent) => ({ id: a.id, name: a.name });

/** The cause behind an incident: its agents, and what it burns a day at its pace since it began (at most the last day). */
function loopItem(c: Ctx, i: TokenIncidentRow): Recommendation | undefined {
  const pair = i.kind === 'consult-ping-pong' ? i.key.split('+') : undefined;
  const who = (pair ?? [i.agentId]).map((id) => c.byId.get(id)).filter((a): a is Agent => !!a);
  if (!who.length) return undefined;
  const first = Date.parse(i.firstAt ?? i.openedAt) || c.now;
  const hours = Math.min(24, Math.max(1, (c.now - first) / HOUR));
  const soFar = who.reduce((s, a) => s + c.costOver(a, hours), 0);
  const perDay = r2((soFar * 24) / hours);
  const billing = who.every((a) => c.billing(a) === 'plan') ? 'plan' : who.some((a) => c.billing(a) === 'plan') ? 'mixed' : 'api';
  const main = who[0]!;
  const title = pair && who.length === 2 ? `${who[0]!.name} and ${who[1]!.name} are stuck asking each other` : `${main.name} is stuck in a loop`;
  const evidence = [
    `${i.count} time${i.count === 1 ? '' : 's'} since ${clockOf(first, c.now)}${i.lastAt ? ` (last ${clockOf(i.lastAt, c.now)})` : ''}`,
    ...(soFar >= 0.01 ? [`≈ ${money(soFar)} in the last ${hours >= 23.5 ? '24 hours' : `${Math.round(hours)} hour${Math.round(hours) === 1 ? '' : 's'}`} at API prices${billing === 'plan' ? ' (on your Claude plan: an equivalent, not a bill)' : ''}`] : []),
    ...(i.fix ? [`What helps: ${i.fix}`] : []),
  ];
  let action: RecAction | undefined;
  const secondary: RecAction[] = [];
  if (i.kind === 'task-failing') {
    action = { kind: 'pause-task', label: 'Pause the task', method: 'PATCH', path: `/v1/agents/${main.id}/crons/${encodeURIComponent(i.key)}`, body: { enabled: false } };
  } else if (i.kind === 'compaction-failing' || (i.kind === 'channel-retry' && /compacting/.test(i.text))) {
    action = { kind: 'compact', label: `Compact it now (keep the last ${THRESHOLDS.keepLines} lines)`, method: 'POST', path: `/v1/agents/${main.id}/compact`, body: { mode: 'lines', lines: THRESHOLDS.keepLines },
      confirm: `Compact ${main.name}'s conversation, keeping only its last ${THRESHOLDS.keepLines} transcript lines? It takes seconds; what came before is dropped from the conversation (its MEMORY.md keeps what it saved).` };
  }
  return {
    id: `loop:${i.id}`, kind: 'loop', agents: who.map(ref), title, concern: i.text, evidence,
    ...(perDay >= 0.01 ? { effect: { text: `stops ≈ ${money(perDay)} a day${billing === 'plan' ? ' at API prices (room in your Claude plan)' : ''}`, usdPerDay: perDay, usdPerMonth: r2(perDay * 30), billing } } : {}),
    ...(action ? { action } : {}),
    secondary: [{ kind: 'open-agent', label: 'Details', agentId: main.id }, ...secondary],
    alert: true,
    rank: { group: GROUP.loop, money: perDay * 30 },
    fingerprint: i.id,
  };
}

function budgetItems(c: Ctx, machineOwner: boolean): Recommendation[] {
  const out: Recommendation[] = [];
  const month = monthKey(c.now, c.tz);
  const elapsed = monthElapsed(c.now, c.tz);
  const spend = monthSpend(c.store, month);
  const rates = c.rates();
  const scopes: Array<{ scope: string; agent?: Agent }> = c.agents.map((a) => ({ scope: a.id, agent: a }));
  if (machineOwner) scopes.push({ scope: MACHINE });
  for (const { scope, agent } of scopes) {
    const b = c.store.getBudget(scope);
    if (!b || (scope === MACHINE ? false : b.ownerId !== c.ownerId)) continue;
    const spent = scope === MACHINE ? [...spend.values()].reduce((x, y) => x + y, 0) : spend.get(scope) ?? 0;
    const v: BudgetView = budgetView(c.store, b, spent, c.now, c.tz, agent?.id);
    if (!v.level) continue;
    const whose = agent ? agent.name : 'This Hatchabot (every agent)';
    const pace = v.onPace ?? (agent ? rates[agent.id]?.monthly : undefined);
    const raiseTo = suggestBudget(Math.max(pace ?? 0, v.spent));
    const raise: RecAction = { kind: 'set-budget', label: `Raise it to ${whole(raiseTo)}`, method: 'PUT', path: agent ? `/v1/agents/${agent.id}/budget` : '/v1/budgets/machine', body: { usd: raiseTo, atLimit: b.atLimit } };
    const open: RecAction = agent ? { kind: 'open-usage', label: 'Details', agentId: agent.id } : { kind: 'open-budgets', label: 'Details' };
    const evidence = [
      `${money(v.spent)} of ${whole(v.usd)} in ${monthName(month)} (${v.pct}%)${v.onPace ? `, on pace for ${money(v.onPace)}` : ''}`,
      b.atLimit === 'pause' ? 'At the limit it pauses until the 1st' : b.atLimit === 'cheaper' ? 'At the limit it moves to the cheapest model its source offers until the 1st' : 'At the limit it only warns',
    ];
    const atLimit = v.paused || v.downgraded || v.level === 100;
    if (atLimit) {
      const daysLeft = Math.max(0, Math.round((1 - elapsed) * 30));
      const title = v.paused ? `${whose} is paused by its budget` : v.downgraded ? `${whose} was moved to ${bare(v.downgraded.to)} by its budget` : `${whose} passed its ${whole(v.usd)} budget`;
      const leave = v.paused ? `Left as it is, it stays paused until ${v.resetsOn} (about ${daysLeft} day${daysLeft === 1 ? '' : 's'})`
        : v.downgraded ? `Left as it is, it runs on ${bare(v.downgraded.to)} until ${v.resetsOn}`
        : `Left as it is, it keeps working${v.onPace && v.onPace > v.usd ? ` and ends the month near ${money(v.onPace)}, ${money(v.onPace - v.usd)} over` : ''}`;
      out.push({
        id: `budget:${scope}`, kind: 'budget-limit', agents: agent ? [ref(agent)] : [], ...(agent ? {} : { machine: true as const }),
        title, concern: budgetLine(v, agent ? 'it' : 'this Hatchabot'), evidence,
        effect: { text: `${leave}. Raising it to ${whole(raiseTo)} ${v.paused ? 'starts it again now' : v.downgraded ? 'switches it back now' : 'gives it room for the rest of the month'}`, billing: agent && c.billing(agent) === 'plan' ? 'plan' : 'api' },
        action: raise, secondary: [open], alert: true,
        rank: { group: GROUP['budget-limit'], money: Math.max(0, (pace ?? v.spent) - v.usd) },
        fingerprint: `${month}:100:${v.usd}:${v.paused ? 'p' : v.downgraded ? 'c' : 'w'}`,
      });
    } else if (v.level === 80 && elapsed < PACE_BEFORE) {
      out.push({
        id: `budget-pace:${scope}`, kind: 'budget-pace', agents: agent ? [ref(agent)] : [], ...(agent ? {} : { machine: true as const }),
        title: `${whose} has used ${v.pct}% of its budget with the month not half gone`,
        concern: budgetLine(v, agent ? 'it' : 'this Hatchabot'), evidence,
        effect: { text: v.onPace ? `At this pace it ends ${monthName(month)} near ${money(v.onPace)}: ${b.atLimit === 'pause' ? 'it would pause' : b.atLimit === 'cheaper' ? 'it would move to a cheaper model' : 'you would hear again'} at ${whole(v.usd)}` : `It reaches ${whole(v.usd)} before the month is out`, billing: agent && c.billing(agent) === 'plan' ? 'plan' : 'api' },
        action: raise, secondary: [open],
        rank: { group: GROUP['budget-pace'], money: Math.max(0, (v.onPace ?? v.spent) - v.usd) },
        fingerprint: `${month}:80:${v.usd}`,
      });
    }
  }
  return out;
}

function spikeItems(c: Ctx): Recommendation[] {
  const out: Recommendation[] = [];
  const seen = new Set<string>();
  for (const s of c.store.usageAlertsSince(new Date(c.now - DAY).toISOString(), { ownerId: c.ownerId })) {
    const a = c.byId.get(s.agentId);
    if (!a || seen.has(a.id)) continue; // the newest per agent
    seen.add(a.id);
    const than = s.usual >= 1e6 ? `about ${Math.round(s.tokens / s.usual)}× its usual day (${tokensText(s.usual)})` : s.usual > 0 ? `after a quiet week (its usual day: ${tokensText(s.usual)})` : 'a lot for an agent this new';
    const cost = c.costOver(a, 24);
    out.push({
      id: `spike:${a.id}`, kind: 'spike', agents: [ref(a)],
      title: `${a.name} used ${tokensText(s.tokens)} tokens in 24 hours`, concern: `${than} — a scheduled task or a long conversation is the usual cause`,
      evidence: [`Warned ${clockOf(s.at, c.now)}${s.covered ? ', with its loop' : s.told ? ' on your chat' : ' (not sent: no Telegram linked)'}`, ...(cost >= 0.01 ? [`≈ ${money(cost)} in the last 24 hours at API prices${c.billing(a) === 'plan' ? ' (an equivalent on your Claude plan)' : ''}`] : [])],
      action: { kind: 'open-usage', label: 'See it by the hour', agentId: a.id }, secondary: [],
      alert: true,
      rank: { group: GROUP.spike, money: cost },
      fingerprint: s.at,
    });
  }
  return out;
}

function rateLimitItems(c: Ctx): Recommendation[] {
  const out: Recommendation[] = [];
  for (const src of summarizeSourceUsage(c.store, c.ownerId, c.now)) {
    if (src.status !== 'limited') continue;
    const on = c.agents.filter((a) => a.aiProfileId === src.id);
    if (!on.length) continue;
    const since = src.limitedSince ?? src.lastLimitAt;
    out.push({
      id: `limit:${src.id}`, kind: 'rate-limit', agents: on.map(ref),
      title: `${src.name} is rate-limited`,
      concern: `since ${since ? clockOf(since, c.now) : 'a moment ago'}: ${on.length === 1 ? `${on[0]!.name} can't` : `your ${on.length} agents on it can't`} answer until it resets`,
      evidence: [
        `${src.window5h.limited} refused and ${src.window5h.requests} asked in the last 5 hours; ${src.limitHits7d} refusal${src.limitHits7d === 1 ? '' : 's'} this week`,
        ...(src.topAgents.length ? [`Busiest: ${src.topAgents.slice(0, 3).map((x) => `${x.name} (${x.requests})`).join(', ')}`] : []),
        'Spread the work over the day, move a busy agent to another source, or add one',
      ],
      action: { kind: 'open-sources', label: 'Open AI sources' }, secondary: [],
      rank: { group: GROUP['rate-limit'], money: 0 },
      fingerprint: since ?? '',
    });
  }
  return out;
}

function switchBackItem(c: Ctx, p: PendingConfirm): Recommendation | undefined {
  const a = c.byId.get(p.resolved.agentId);
  if (!a) return undefined;
  const change = p.resolved.guardOf ? c.store.getModelChange(p.resolved.guardOf) : undefined;
  const from = String(p.resolved.model ?? change?.from ?? '');
  const lines = p.summary.split('\n');
  const after = change?.after as ModelFigures | undefined;
  return {
    id: `switch-back:${change?.id ?? p.id}`, kind: 'switch-back', agents: [ref(a)],
    title: `${a.name} does worse on ${bare(change?.to ?? after?.model ?? 'its new model')}`,
    concern: change ? `since it moved from ${bare(change.from ?? from)} on ${new Date(change.at).toISOString().slice(0, 10)}: ${(change.reasons ?? []).join('; ') || 'more failures than before'}` : lines[1] ?? '',
    evidence: lines.filter((l) => /^(Before|After)\b/.test(l)),
    effect: { text: `back on ${bare(from)}, where it did better; the guard does not ask about this switch again`, billing: c.billing(a) === 'plan' ? 'plan' : 'api' },
    action: confirmCard(p), secondary: [{ kind: 'open-agent', label: 'Details', agentId: a.id }],
    proposedBy: 'guard', proposalId: p.id,
    rank: { group: GROUP['switch-back'], money: 0 },
    fingerprint: p.id,
  };
}

function cheaperItems(c: Ctx): Recommendation[] {
  const out: Recommendation[] = [];
  const card = buildScorecard(c.store, c.ownerId, { now: c.now, limit: 100 });
  for (const row of card.rows) {
    const a = c.byId.get(row.id);
    const best = row.cheaperOptions[0];
    // Only with evidence "ok" (≥10 turns on its model over ≥3 days); never for the Hatchabot agent (it runs the rest).
    if (!a || a.ops || row.evidence !== 'ok' || row.billing === 'local' || !best || best.savingUSD < CHEAPER_MIN_USD) continue;
    // A model change still being judged: wait for its verdict before the next one.
    if (c.store.listModelChanges({ agentId: a.id, outcomes: ['pending'], limit: 1 }).length) continue;
    // A budget moved it to a cheaper model this month: that is the budget's, not advice.
    if (c.store.getBudgetPause(a.id, monthKey(c.now, c.tz))?.kind === 'cheaper') continue;
    const check = assessModelChange(c.store, a, c.profileOf(a), best.model, c.now);
    const errs = Object.entries(row.errors).filter(([k, v]) => v && k !== 'rateLimited').length;
    out.push({
      id: `cheaper:${a.id}`, kind: 'cheaper-model', agents: [ref(a)],
      title: `${a.name} could use a cheaper model`,
      concern: `${row.turns} turns in ${row.days} days, ${row.toolsPerTurn} tools per turn, ${errs ? 'some errors' : 'no errors'}: ${bare(best.model)} would cost ≈ ${money(best.savingUSD)} a month less on its own mix`,
      evidence: [
        `Evidence: ok — ${row.turnsOnModel} turns on ${bare(row.model)} over ${row.days} days`,
        check.evidence,
        ...check.warnings.map((w) => `⚠ ${w}`),
        "After a switch Hatchabot's quality guard compares a week on the new model with the old one, and offers the switch back if it does worse",
      ],
      effect: { text: effectWords(best.savingUSD, row.billing), usdPerMonth: best.savingUSD, billing: row.billing },
      action: { kind: 'set-model', label: `Switch to ${bare(best.model)} and watch it`, method: 'POST', path: `/v1/agents/${a.id}/model`, body: { model: best.model, why: `Recommended: ${bare(row.model)} → ${bare(best.model)}, ≈ ${money(best.savingUSD)} a month less on its own mix (${row.turnsOnModel} turns over ${row.days} days).` } },
      secondary: [{ kind: 'open-agent', label: 'Details', agentId: a.id }],
      rank: { group: GROUP['cheaper-model'], money: best.savingUSD },
      fingerprint: `${row.model}>${best.model}`,
    });
  }
  return out;
}

/** The context per call after a cap or a compaction: the cap's compaction point. */
const compactsAt = (cap: number) => cap - Math.min(20_000, cap / 4);

function conversationItems(c: Ctx): Recommendation[] {
  const out: Recommendation[] = [];
  const report = buildTokenHealth(c.store, c.ownerId, { now: c.now, limit: 100 });
  const raws = c.store.tokenHealths(report.rows.map((r) => r.id)) as Map<string, { health: TokenHealthRaw; at: string }>;
  for (const row of report.rows) {
    const a = c.byId.get(row.id);
    const conv = row.conversation;
    if (!a || !conv || row.billing === 'local') continue;
    const now = row.flags.includes('compact-now');
    const capped = !!row.contextCap?.tokens;
    const large = row.flags.includes('large-conversation') && !capped;
    if (!now && !large) continue;
    const cap = row.contextCap?.tokens ?? THRESHOLDS.suggestedCap;
    const after = compactsAt(cap);
    const beforeTok = now ? (conv.mainNowK ?? conv.ctxK.p50) * 1000 : conv.ctxK.p50 * 1000;
    const perCall = Math.max(0, beforeTok - after);
    if (!perCall) continue;
    const raw = raws.get(a.id)?.health;
    const days = raw ? Math.max(1, Math.min(30, (c.now - raw.since) / DAY)) : 30;
    const callsPerMonth = (conv.calls * 30) / days;
    const o = modelOption(row.model);
    // Context is carried as cache reads: the saving is priced at the model's cache-read rate (a lower bound).
    const usd = o ? r2((perCall * callsPerMonth * o.input * o.cacheRead) / 1e6) : 0;
    const tokens = Math.round(perCall * callsPerMonth);
    const pct = Math.round((perCall / beforeTok) * 100);
    const capAction: RecAction = { kind: 'context-cap', label: `Cap it at ${Math.round(THRESHOLDS.suggestedCap / 1000)}K`, method: 'PUT', path: `/v1/agents/${a.id}/context-cap`, body: { tokens: THRESHOLDS.suggestedCap } };
    const compact: RecAction = { kind: 'compact', label: 'Compact it now', method: 'POST', path: `/v1/agents/${a.id}/compact`, body: { mode: 'summarise' },
      confirm: `Compact ${a.name}'s conversation now? The model summarises it and the summary replaces the older turns; on a large conversation it takes minutes, and the result reaches your chat.` };
    const sizeK = now ? conv.mainNowK ?? conv.ctxK.p50 : conv.ctxK.p50;
    out.push({
      id: `conversation:${a.id}`, kind: 'big-conversation', agents: [ref(a)],
      title: `${a.name}'s conversation is ${sizeK}K tokens`,
      concern: now ? 'every call carries all of it; compacting replaces the older turns with a summary' : `its median call carries ${conv.ctxK.p50}K; a cap makes OpenClaw compact at about ${Math.round(after / 1000)}K`,
      evidence: [
        `${conv.calls} calls in ${Math.round(days)} days; median ${conv.ctxK.p50}K, 90th percentile ${conv.ctxK.p90}K per call${conv.mainNowK ? `; its main conversation is ${conv.mainNowK}K now` : ''}`,
        conv.compactions30d ? `${conv.compactions30d} compaction${conv.compactions30d === 1 ? '' : 's'} in 30 days` : 'Never compacted in 30 days',
        capped ? `Its cap: ${Math.round(cap / 1000)}K (compacts at about ${Math.round(after / 1000)}K)` : 'No context cap',
      ],
      effect: { text: `≈ ${pct}% fewer tokens per call: ${effectWords(usd, row.billing, tokens)}`, usdPerMonth: usd, tokensPerMonth: tokens, billing: row.billing },
      action: now ? compact : capAction,
      secondary: now && !capped ? [capAction] : [],
      rank: { group: GROUP['big-conversation'], money: usd },
      fingerprint: `${now ? 'now' : 'median'}:${Math.floor(sizeK / 50)}:${capped ? cap : 0}`,
    });
  }
  return out;
}

function noBudgetItems(c: Ctx): Recommendation[] {
  const out: Recommendation[] = [];
  const rates = c.rates();
  for (const a of c.agents) {
    const monthly = rates[a.id]?.monthly ?? 0;
    if (monthly < NO_BUDGET_FROM_USD || c.store.getBudget(a.id) || rates[a.id]?.local) continue;
    const usd = suggestBudget(monthly);
    out.push({
      id: `no-budget:${a.id}`, kind: 'no-budget', agents: [ref(a)],
      title: `${a.name} costs about ${money(monthly)} a month and has no budget`,
      concern: `a ${whole(usd)} budget tells you at 80% and at 100%; nothing stops unless you choose that`,
      evidence: [`${money(monthly)} a month at its pace this week (API prices${c.billing(a) === 'plan' ? '; on your Claude plan an equivalent' : ''})`],
      effect: { text: `you hear at ${whole(Math.round(usd * 0.8))} and ${whole(usd)} this month`, billing: c.billing(a) === 'plan' ? 'plan' : 'api' },
      action: { kind: 'set-budget', label: `Set a ${whole(usd)} budget`, method: 'PUT', path: `/v1/agents/${a.id}/budget`, body: { usd, atLimit: 'warn' } },
      secondary: [{ kind: 'open-usage', label: 'Details', agentId: a.id }],
      rank: { group: GROUP['no-budget'], money: 0 },
      fingerprint: String(usd),
    });
  }
  return out;
}

/** A card the list has no item for: its own item, its words as Hatchabot wrote them. */
function cardItem(c: Ctx, p: PendingConfirm): Recommendation | undefined {
  const a = c.byId.get(p.resolved.agentId);
  if (!a) return undefined;
  const [head, ...rest] = p.summary.split('\n');
  return {
    id: `card:${p.id}`, kind: 'proposal', agents: [ref(a)],
    title: (head ?? '').replace(/^\W+\s*/u, '') || cardLabel(p), concern: '',
    evidence: [...(p.resolved.check ? [p.resolved.check.evidence, ...p.resolved.check.warnings.map((w) => `⚠ ${w}`)] : rest), ...(p.note ? [`Its reason: “${p.note}”`] : [])].filter(Boolean),
    action: confirmCard(p), secondary: [{ kind: 'open-agent', label: 'Details', agentId: a.id }],
    proposedBy: 'agent', proposalId: p.id,
    rank: { group: GROUP.proposal, money: 0 },
    fingerprint: p.id,
  };
}

/** The computed item a card proposes the same change as, if any. */
function matchCard(items: Recommendation[], p: PendingConfirm): Recommendation | undefined {
  const agentId = p.resolved.agentId;
  const body = (p.resolved.rest?.call.body ?? {}) as Record<string, unknown>;
  const on = (id: string) => items.find((x) => x.id === id && !x.proposalId);
  switch (p.tool) {
    case 'set_model': {
      const it = on(`cheaper:${agentId}`);
      return it && it.action?.body?.model === p.resolved.model ? it : undefined;
    }
    case 'compact_agent':
      return on(`conversation:${agentId}`) ?? items.find((x) => x.kind === 'loop' && x.agents[0]?.id === agentId && x.action?.kind === 'compact' && !x.proposalId);
    case 'set_context_cap': return on(`conversation:${agentId}`);
    case 'set_budget': return on(`no-budget:${agentId}`) ?? on(`budget:${agentId}`) ?? on(`budget-pace:${agentId}`);
    case 'set_cron_enabled': {
      const job = decodeURIComponent(String(p.resolved.rest?.call.path ?? '').split('/').pop() ?? '');
      return items.find((x) => x.kind === 'loop' && x.action?.kind === 'pause-task' && x.agents[0]?.id === agentId && x.action.path?.endsWith(`/${encodeURIComponent(job)}`) && !x.proposalId);
    }
    default: return undefined;
  }
}

/**
 * The owner's list, ranked (the design's order, then money within it), one
 * item per cause. machineOwner: the machine's own budget too.
 */
export function buildRecommendations(store: Store, ownerId: string, opts: { now?: number; tz?: string; machineOwner?: boolean; includeDismissed?: boolean } = {}): RecommendationList {
  const now = opts.now ?? Date.now();
  const tz = opts.tz ?? (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  const agents = store.listAgents(ownerId).filter((a) => a.state !== 'DELETED' && a.state !== 'DELETING' && a.state !== 'ARCHIVED');
  const byId = new Map(agents.map((a) => [a.id, a]));
  const profiles = new Map<string, AIProfile | undefined>();
  const profileOf = (a: Agent) => { if (!profiles.has(a.aiProfileId)) profiles.set(a.aiProfileId, store.getAIProfile(a.aiProfileId)); return profiles.get(a.aiProfileId); };
  const stored = store.modelProfiles(agents.map((a) => a.id)) as Map<string, { profile: StoredProfile; at: string }>;
  let rates: ReturnType<typeof costsFor> | undefined;
  const c: Ctx = {
    store, ownerId, now, tz, agents, byId, profileOf,
    billing: (a) => billingOf(profileOf(a)),
    costOver: (a, hours) => agentCost(a, stored.get(a.id), profileOf(a), hours / 24, now).cost,
    rates: () => (rates ??= costsFor(store, ownerId, 7, now)),
  };

  // 1. Every check's items.
  const loops = store.listTokenIncidents({ ownerId, open: true }).map((i) => loopItem(c, i)).filter((x): x is Recommendation => !!x);
  let items: Recommendation[] = [
    ...loops,
    ...budgetItems(c, !!opts.machineOwner),
    ...spikeItems(c),
    ...rateLimitItems(c),
    ...cheaperItems(c),
    ...conversationItems(c),
    ...noBudgetItems(c),
  ];

  // 2. One cause, one item: a loop stands for its agents' spike, budget and step lines, and for the conversation it is stuck compacting.
  const month = monthKey(now, tz);
  const spend = monthSpend(store, month, agents.map((a) => a.id));
  const absorbed = new Set<string>();
  for (const loop of [...loops].sort((x, y) => y.rank.money - x.rank.money)) {
    const ids = loop.agents.map((a) => a.id);
    const also: string[] = [];
    for (const it of items) {
      if (it === loop || absorbed.has(it.id) || it.kind === 'loop' || !it.agents.length || !it.agents.every((a) => ids.includes(a.id))) continue;
      const take = it.kind === 'spike' || it.kind === 'budget-limit' || it.kind === 'budget-pace'
        || (it.kind === 'big-conversation' && loop.action?.kind === 'compact');
      if (!take) continue;
      absorbed.add(it.id);
      (loop.absorbs ??= []).push(it.id);
      if (it.kind === 'spike') loop.evidence.push(`${it.title} (${it.concern.split(' — ')[0]})`);
      else if (it.kind === 'big-conversation') loop.evidence.push(it.title.replace(/^.*?'s conversation/, 'Its conversation'));
      else {
        loop.evidence.push(it.concern);
        const v = it.concern;
        also.push(/^Paused/.test(v) ? 'is paused by its budget' : /^Over/.test(v) ? 'passed its budget' : 'is past 80% of its budget');
      }
    }
    // "Tell me every $X" is context, never an item of its own.
    for (const id of ids) {
      const al = store.getSpendAlert(id);
      const sv = al ? stepView(al, spend.get(id) ?? 0, now, tz) : undefined;
      if (sv?.passed) also.push(`passed ${whole(sv.passed * sv.every)} this month`);
    }
    if (also.length) loop.concern = `${loop.concern} — which is also why it ${[...new Set(also)].join(' and ')}`;
  }
  items = items.filter((x) => !absorbed.has(x.id));

  // 3. The Hatchabot agent's pending cost and model cards: the same click, in the same list.
  const cards = store.listMgmtProposals<PendingConfirm>(ownerId, now).filter((p) => p.status === 'pending' && isCostCard(p));
  for (const p of cards) {
    if (p.source === 'guard') { const it = switchBackItem(c, p); if (it) items.push(it); continue; }
    const same = matchCard(items, p);
    if (same) {
      same.proposedBy = 'agent';
      same.proposalId = p.id;
      same.action = confirmCard(p);
      if (p.note) same.evidence.push(`Its reason: “${p.note}”`);
      // The fingerprint stays the cause's: Not now cancels the card and the item stays away.
      continue;
    }
    const it = cardItem(c, p);
    if (it) items.push(it);
  }

  // 4. Ranked: the design's order, then money at stake.
  items.sort((x, y) => x.rank.group - y.rank.group || y.rank.money - x.rank.money || x.id.localeCompare(y.id));
  for (const it of items) it.rank.money = r2(it.rank.money);

  // 5. Not now: put away until the cause changes.
  const gone = store.recommendationDismissals(ownerId);
  const shown = opts.includeDismissed ? items : items.filter((it) => gone.get(it.id) !== it.fingerprint);
  try { store.pruneRecommendationDismissals(ownerId, new Set(items.map((x) => x.id)), new Date(now - KEEP_DISMISSED_MS).toISOString()); } catch { /* tidying only */ }
  return {
    generatedAt: new Date(now).toISOString(),
    items: shown,
    dismissed: items.length - items.filter((it) => gone.get(it.id) !== it.fingerprint).length,
    notes: [
      'Ranked: a loop happening now, a budget at 100%, a spike today, a rate-limited source, a budget past 80% before mid-month, a switch that went worse, then savings (a cheaper model, a big conversation, a budget for an agent over about $20 a month) by money a month.',
      'Dollars are API list prices; on a Claude plan they are an equivalent (room in the plan), not a bill. Each item\'s action is the same change its card would make; nothing happens until the owner clicks.',
      'A cheaper model is only suggested with evidence "ok" (at least 10 turns on its model over 3 days) and a saving of $5 a month or more.',
    ],
  };
}

/** One agent's items (its Usage tab), from the owner's list. */
export function agentRecommendations(list: RecommendationList, agentId: string): Recommendation[] {
  return list.items.filter((it) => it.agents.some((a) => a.id === agentId));
}
