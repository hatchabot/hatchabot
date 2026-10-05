import type { Agent } from '../domain/types.js';
import type { BudgetRow, SpendAlertRow, Store } from '../store/store.js';
import { HOUR_FIELDS } from './usage.js';
import type { StoredProfile } from './modelScorecard.js';
import { priceMix, type TokenMix } from './modelOptions.js';

/**
 * Budgets (docs/features.md, "Budgets"): a monthly limit in US dollars at API
 * prices, on one agent or on the whole machine. At 80% the owner gets a
 * "Alerts" line and one message on the manager's chat; at 100% the same,
 * and — when the budget says so — the agent is paused (stopped, as the Stop
 * button does) until the 1st of next month, until its budget is raised, or
 * until someone starts it by hand (then not again that month). The manager
 * itself is never paused. On a Claude plan the dollars are an equivalent
 * (the badges' pricing), not a bill.
 *
 * The figures are the cost badges' (agentCosts.ts): the usage sampler's
 * per-model hour buckets priced with modelOptions.priceMix. Those keep 30 days,
 * so each pass writes what every agent cost per calendar day (the machine's
 * time zone) to agent_cost_days, and a month is the sum of its days. Runs after
 * each usage pass (every 10 minutes): no container is read and none is woken.
 */

export const MACHINE = 'machine';
/** Below this a budget makes no sense (and a typo of $0.5 would pause at once). */
export const MIN_BUDGET = 1;
export const MAX_BUDGET = 100_000;
export const WARN_AT = 0.8;
/** An agent that made a model call this recently is mid-turn: its pause waits for the next pass. */
export const QUIET_MS = 3 * 60_000;
/** Cost days are kept this long (last month and this one, with room). */
const KEEP_DAYS = 100;

const DAY = 86_400_000;
const r2 = (x: number) => Math.round(x * 100) / 100;

export const machineTz = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

/** "YYYY-MM-DD HH:MM" in the zone. */
function local(ms: number, tz: string): string {
  try { return new Date(ms).toLocaleString('sv-SE', { timeZone: tz, hour12: false }).replace('T', ' ').slice(0, 16); } catch { return new Date(ms).toISOString().replace('T', ' ').slice(0, 16); }
}
export const dayKey = (ms: number, tz: string) => local(ms, tz).slice(0, 10);
export const monthKey = (ms: number, tz: string) => local(ms, tz).slice(0, 7);
const daysIn = (month: string) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y!, m!, 0)).getUTCDate(); };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, '0')}`;
}
export function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y! - 1}-12` : `${y}-${String(m! - 1).padStart(2, '0')}`;
}
/** How much of the month has gone by, 0–1, in the zone. */
export function monthElapsed(now: number, tz: string): number {
  const l = local(now, tz);
  const day = Number(l.slice(8, 10)), h = Number(l.slice(11, 13)), min = Number(l.slice(14, 16));
  return Math.min(1, Math.max(0, (day - 1 + (h + min / 60) / 24) / daysIn(l.slice(0, 7))));
}

/** An agent's cost per local day from its stored profile's hour buckets; the window's first (partial) day named. */
export function dailyCosts(p: StoredProfile | undefined, tz: string): { days: Map<string, number>; partialDay?: string } {
  const days = new Map<string, number>();
  if (!p?.models) return { days };
  const perDay = new Map<string, Map<string, TokenMix>>();
  for (const [model, s] of Object.entries(p.models)) {
    for (const [h, v] of Object.entries(s.h ?? {})) {
      const at = Date.parse(`${h}:00:00Z`);
      if (!Number.isFinite(at)) continue;
      const d = dayKey(at, tz);
      const byModel = perDay.get(d) ?? new Map<string, TokenMix>();
      const mix = byModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      HOUR_FIELDS.forEach((f, i) => { if (f in mix) mix[f as keyof TokenMix] += Number(v[i]) || 0; });
      byModel.set(model, mix);
      perDay.set(d, byModel);
    }
  }
  for (const [d, byModel] of perDay) {
    let usd = 0;
    for (const [model, mix] of byModel) usd += priceMix(model, mix) ?? 0;
    days.set(d, usd);
  }
  return { days, ...(p.since ? { partialDay: dayKey(p.since, tz) } : {}) };
}

/** Write every agent's cost days from what the sampler stored. */
export function recordCostDays(store: Store, tz: string, now = Date.now()): void {
  const agents = store.listAllActiveAgents().filter((a) => a.state !== 'DELETED');
  const profiles = store.modelProfiles(agents.map((a) => a.id)) as Map<string, { profile: StoredProfile; at: string }>;
  for (const [id, { profile }] of profiles) {
    if (profile.hourly !== true && !Object.values(profile.models ?? {}).some((s) => s.h && Object.keys(s.h).length)) continue;
    const { days, partialDay } = dailyCosts(profile, tz);
    if (days.size) store.setCostDays(id, days, partialDay);
  }
  store.pruneCostDays(dayKey(now - KEEP_DAYS * DAY, tz));
}

/** Each agent's spend in a month ("YYYY-MM"). */
export function monthSpend(store: Store, month: string, agentIds?: string[]): Map<string, number> {
  return store.costBetween(`${month}-01`, `${month}-31`, agentIds);
}

/** A round budget a little above what an agent costs a month now ($5 at least). */
export function suggestBudget(monthlyUSD: number): number {
  const want = Math.max(5, monthlyUSD * 1.25);
  const steps = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000];
  return steps.find((s) => s >= want) ?? Math.ceil(want / 1000) * 1000;
}

export type AtLimit = 'warn' | 'pause' | 'cheaper';

export interface BudgetView {
  scope: string;
  usd: number;
  atLimit: AtLimit;
  month: string;
  /** Spent this month so far, USD. */
  spent: number;
  pct: number;
  /** The month's total at this pace (from the 3rd day on). */
  onPace?: number;
  /** 0, 80 (warned) or 100 (reached). */
  level: 0 | 80 | 100;
  /** "November 1": when a pause or a cheaper model ends by itself. */
  resetsOn: string;
  /** Paused by this budget now. */
  paused?: { at: string };
  /** Moved to a cheaper model by this budget now. */
  downgraded?: { at: string; to: string };
  /** Started (or its model changed) by hand after this month's action: left alone until the 1st. */
  resumedByHand?: boolean;
}

export function levelOf(spent: number, usd: number): 0 | 80 | 100 {
  return spent >= usd ? 100 : spent >= usd * WARN_AT ? 80 : 0;
}

export function budgetView(store: Store, b: BudgetRow, spent: number, now: number, tz: string, agentId?: string): BudgetView {
  const month = monthKey(now, tz);
  const elapsed = monthElapsed(now, tz);
  const act = agentId ? store.getBudgetPause(agentId, month) : undefined;
  const open = act && !act.resumedAt && act.scope === b.scope;
  return {
    scope: b.scope, usd: b.usd, atLimit: b.atLimit, month,
    spent: r2(spent), pct: Math.round((spent / b.usd) * 100),
    ...(elapsed >= 2 / 31 ? { onPace: r2(spent / elapsed) } : {}),
    level: levelOf(spent, b.usd),
    resetsOn: `${monthName(nextMonth(month))} 1`,
    ...(open && act.kind === 'pause' ? { paused: { at: act.pausedAt } } : {}),
    ...(open && act.kind === 'cheaper' && act.toModel ? { downgraded: { at: act.pausedAt, to: act.toModel } } : {}),
    ...(act?.resumedBy === 'owner' ? { resumedByHand: true } : {}),
  };
}

const money = (x: number) => (x >= 100 ? `$${Math.round(x)}` : `$${x.toFixed(2)}`);
const whole = (x: number) => (Number.isInteger(x) ? `$${x}` : `$${x.toFixed(2)}`);
const bare = (model: string) => model.replace(/^.*\//, '');

/** The Alerts line for a budget at 80% or more ("" below that). */
export function budgetLine(v: BudgetView, whose: string): string {
  const of = `its ${whole(v.usd)} budget for ${monthName(v.month)}`;
  if (v.paused) return `Paused: ${whose} used ${of} (${money(v.spent)}). It starts again on ${v.resetsOn} — or raise the budget, or start it now`;
  if (v.downgraded) return `Over ${of} (${money(v.spent)}): on ${bare(v.downgraded.to)} until ${v.resetsOn} — raise the budget to switch back now`;
  if (v.level === 100) return `Over ${of}: ${money(v.spent)} so far${v.onPace && v.onPace > v.spent ? `, on pace for ${money(v.onPace)}` : ''}${v.atLimit !== 'warn' && v.resumedByHand ? ' (you took over after its budget acted: left alone until the 1st)' : ''}`;
  if (v.level === 80) return `Used ${v.pct}% of ${of} (${money(v.spent)})${v.onPace ? ` — on pace for ${money(v.onPace)}` : ''}${v.atLimit === 'pause' ? '; it pauses at 100%' : v.atLimit === 'cheaper' ? '; it moves to a cheaper model at 100%' : ''}`;
  return '';
}

export interface BudgetDeps {
  store: Store;
  /** Tell the owner (the manager's chat, else the agent's own); true if it reached them. */
  tell(ownerId: string, agent: Agent, text: string): Promise<boolean>;
  /** Stop a running agent for its budget; false when it could not be stopped now (busy). */
  pause(agent: Agent): Promise<boolean>;
  /** Start an agent a budget paused; false when it could not be started now. */
  resume(agent: Agent): Promise<boolean>;
  /**
   * Move an agent to the cheapest model its source offers (live), recorded in
   * the model ledger as the budget's; undefined when there is nothing cheaper.
   * `from` is its own model pin before (null: its source's default).
   */
  downgrade?(agent: Agent): Promise<{ from: string | null; to: string } | undefined>;
  /** Put an agent's model pin back (null = its source's default), recorded as the budget's. */
  restoreModel?(agent: Agent, pin: string | null): Promise<boolean>;
  isBusy(agentId: string): boolean;
  log?(event: string, detail: Record<string, unknown>): void;
  tz?: string;
}

const pausable = (a: Agent) => !a.ops && !a.migratedTo && !!a.runtimeRef;
const switchable = (a: Agent) => !a.ops && !a.migratedTo && a.state !== 'ARCHIVED';

/**
 * One pass, after a usage pass (or at once after a budget changes): record
 * cost days, undo what a new month or a raised budget frees, mark and tell
 * 80% and 100%, and pause, or move to a cheaper model, what the budget says to.
 */
export async function runBudgets(deps: BudgetDeps, now = Date.now(), opts: { record?: boolean } = {}): Promise<{ paused: string[]; resumed: string[]; downgraded: string[]; told: number }> {
  const { store } = deps;
  const tz = deps.tz ?? machineTz();
  const nowIso = new Date(now).toISOString();
  const month = monthKey(now, tz);
  if (opts.record !== false) recordCostDays(store, tz, now);
  const agents = store.listAllActiveAgents().filter((a) => a.state !== 'DELETED' && a.state !== 'DELETING');
  const byId = new Map(agents.map((a) => [a.id, a]));
  const spend = monthSpend(store, month);
  const budgets = store.listBudgets();
  const machineSpent = [...spend.values()].reduce((s, x) => s + x, 0);
  /** This budget still says `kind` and is still reached. */
  const over = (scope: string, kind: AtLimit): boolean => {
    const b = budgets.find((x) => x.scope === scope);
    if (!b || b.atLimit !== kind) return false;
    return (scope === MACHINE ? machineSpent : spend.get(scope) ?? 0) >= b.usd;
  };
  const paused: string[] = [], resumed: string[] = [], downgraded: string[] = [];

  // 1. What ends: a new month, a budget raised, removed or changed, the agent gone, or the owner taking over.
  for (const p of store.listBudgetPauses({ open: true })) {
    const a = byId.get(p.agentId) ?? store.getAgent(p.agentId);
    if (!a || a.state === 'ARCHIVED' || a.state === 'DELETED') { store.resumeBudgetPause(p.agentId, p.month, nowIso, 'gone'); continue; }
    if (p.kind === 'cheaper') {
      // Its model changed by hand since: the owner's choice stands, and the budget leaves it alone until the 1st.
      if (p.toModel && (a.model ?? null) !== p.toModel) { store.resumeBudgetPause(p.agentId, p.month, nowIso, 'owner'); continue; }
      const why = p.month !== month ? 'new-month' : !over(p.scope, 'cheaper') ? 'budget-raised' : undefined;
      if (!why || !deps.restoreModel) continue;
      if (await deps.restoreModel(a, p.fromModel ?? null).catch(() => false)) {
        store.resumeBudgetPause(p.agentId, p.month, nowIso, why);
        resumed.push(a.id);
        deps.log?.('budget.model_restored', { agentId: a.id, why, model: p.fromModel ?? null });
      }
      continue;
    }
    // Started some other way than Start (a rebuild): still over → paused again below; not over → done.
    if (a.state !== 'STOPPED') {
      if (p.month !== month || !over(p.scope, 'pause')) store.resumeBudgetPause(p.agentId, p.month, nowIso, 'started');
      continue;
    }
    const why = p.month !== month ? 'new-month' : !over(p.scope, 'pause') ? 'budget-raised' : undefined;
    if (!why) continue;
    if (deps.isBusy(a.id)) continue;
    if (await deps.resume(a).catch(() => false)) {
      store.resumeBudgetPause(p.agentId, p.month, nowIso, why);
      resumed.push(a.id);
      deps.log?.('budget.resumed', { agentId: a.id, why });
    }
  }

  // 2. Marks, messages, pauses and cheaper models, per budget.
  let told = 0;
  const scoped = budgets.filter((b) => b.scope === MACHINE || byId.has(b.scope));
  for (const b of scoped) {
    const spent = b.scope === MACHINE ? machineSpent : spend.get(b.scope) ?? 0;
    const level = levelOf(spent, b.usd);
    if (!level) continue;
    const agent = b.scope === MACHINE ? agents.find((a) => a.ownerId === b.ownerId && a.ops) : byId.get(b.scope);
    const pool = b.scope === MACHINE ? agents : agent ? [agent] : [];
    // Act first, so the message says what happened.
    const acted: Array<{ a: Agent; to?: string }> = [];
    let deferred = 0;
    if (level === 100 && b.atLimit === 'pause') {
      for (const a of pool.filter(pausable)) {
        const prior = store.getBudgetPause(a.id, month);
        if (prior?.resumedBy === 'owner') continue; // started by hand after a pause: runs on until the 1st
        if (prior && !prior.resumedAt && (prior.kind === 'cheaper' || a.state !== 'RUNNING')) continue; // already acted on (running again: a rebuild started it)
        const asleep = a.state === 'STOPPED' && !!a.hibernatedAt;
        if (a.state !== 'RUNNING' && !asleep) continue;
        const lastOk = Date.parse(store.usageCursor(a.id)?.lastOk ?? '') || 0;
        // Busy, or mid-turn: the next pass.
        if (deps.isBusy(a.id) || (!asleep && now - lastOk < QUIET_MS)) { deferred++; continue; }
        if (await deps.pause(a).catch(() => false)) {
          store.addBudgetPause(a.id, month, b.scope, nowIso);
          paused.push(a.id);
          acted.push({ a });
          deps.log?.('budget.paused', { agentId: a.id, scope: b.scope === MACHINE ? MACHINE : 'agent', spent: r2(spent), usd: b.usd });
        } else deferred++;
      }
    }
    if (level === 100 && b.atLimit === 'cheaper' && deps.downgrade) {
      for (const a of pool.filter(switchable)) {
        const prior = store.getBudgetPause(a.id, month);
        if (prior?.resumedBy === 'owner' || (prior && !prior.resumedAt)) continue;
        if (deps.isBusy(a.id)) { deferred++; continue; }
        const r = await deps.downgrade(a).catch(() => undefined);
        if (!r) continue; // nothing cheaper on its source
        store.addBudgetPause(a.id, month, b.scope, nowIso, { fromModel: r.from, toModel: r.to });
        downgraded.push(a.id);
        acted.push({ a, to: r.to });
        deps.log?.('budget.downgraded', { agentId: a.id, scope: b.scope === MACHINE ? MACHINE : 'agent', to: r.to, spent: r2(spent), usd: b.usd });
      }
    }
    // The 100% message says what happened: while the action still waits on a turn, it waits too.
    const hold100 = deferred > 0 && !acted.length;
    for (const lv of level === 100 ? [80, 100] : [80]) {
      if (lv === 100 && hold100) continue;
      // 80% is told only if 100% isn't also new this pass.
      const fresh = store.addBudgetMark(b.scope, month, lv, b.usd, nowIso);
      if (!fresh || (lv === 80 && level === 100)) continue;
      if (!agent) continue;
      const text = budgetMessage(b, spent, lv as 80 | 100, month, agent, acted, now, tz);
      const ok = await deps.tell(b.ownerId, agent, text).catch(() => false);
      store.markBudgetTold(b.scope, month, lv, b.usd, nowIso);
      told++;
      deps.log?.('budget.told', { agentId: agent.id, scope: b.scope === MACHINE ? MACHINE : 'agent', level: lv, told: ok });
    }
  }
  store.pruneBudgetMarks(prevMonth(prevMonth(month)));

  // 3. "Tell me every $X": each time the month's spend passes the next multiple.
  for (const al of store.listSpendAlerts()) {
    if (al.scope !== MACHINE && !byId.has(al.scope)) continue;
    const spent = al.scope === MACHINE ? machineSpent : spend.get(al.scope) ?? 0;
    const k = stepsPassed(spent, al.stepUsd);
    let st = store.spendAlertState(al.scope, month);
    // A step changed without being primed (not through the app): count from where the spend is now.
    if (st && st.stepUsd !== al.stepUsd) { store.setSpendAlertState(al.scope, month, al.stepUsd, k, null); continue; }
    // A new month starts from nothing: its first multiple is told.
    st ??= { stepUsd: al.stepUsd, kTold: 0 };
    if (k <= st.kTold) continue;
    // At most one a scope an hour: several steps passed meanwhile are one message with the latest total.
    if (st.toldAt && now - Date.parse(st.toldAt) < STEP_TELL_EVERY_MS) continue;
    const agent = al.scope === MACHINE ? agents.find((a) => a.ownerId === al.ownerId && a.ops) : byId.get(al.scope);
    if (!agent) continue;
    const ok = await deps.tell(al.ownerId, agent, stepMessage(al, spent, month, agent, now, tz)).catch(() => false);
    store.setSpendAlertState(al.scope, month, al.stepUsd, k, nowIso);
    told++;
    deps.log?.('budget.step_told', { agentId: agent.id, scope: al.scope === MACHINE ? MACHINE : 'agent', spent: r2(spent), every: al.stepUsd, told: ok });
  }
  store.pruneSpendAlertState(prevMonth(prevMonth(month)));
  return { paused, resumed, downgraded, told };
}

// ---- "Tell me every $X" -----------------------------------------------------------

/** At most one step message per agent (or for the machine) an hour. */
export const STEP_TELL_EVERY_MS = 3_600_000;
/** Whole multiples of `step` that `spent` has passed (a cent's rounding forgiven). */
export const stepsPassed = (spent: number, step: number) => (step > 0 ? Math.floor(spent / step + 1e-9) : 0);

export interface StepView {
  every: number;
  month: string;
  spent: number;
  /** Multiples passed this month. */
  passed: number;
  /** The next multiple. */
  next: number;
}
export function stepView(a: SpendAlertRow, spent: number, now: number, tz: string): StepView {
  const passed = stepsPassed(spent, a.stepUsd);
  return { every: a.stepUsd, month: monthKey(now, tz), spent: r2(spent), passed, next: r2((passed + 1) * a.stepUsd) };
}
/** The Alerts line once a multiple has been passed this month ("" before). */
export function stepLine(v: StepView): string {
  return v.passed ? `Spent ${money(v.spent)} in ${monthName(v.month)} — you hear every ${whole(v.every)} (next at ${whole(v.next)})` : '';
}
/** A step set (or changed) now counts from where the month's spend is: what was passed before is not told. */
export function primeSpendAlert(store: Store, scope: string, step: number, spent: number, now: number, tz: string): void {
  store.setSpendAlertState(scope, monthKey(now, tz), step, stepsPassed(spent, step), null);
}
export function stepMessage(a: SpendAlertRow, spent: number, month: string, agent: Agent, now: number, tz: string): string {
  const elapsed = monthElapsed(now, tz);
  const pace = elapsed >= 2 / 31 ? spent / elapsed : undefined;
  const whose = a.scope === MACHINE ? 'This Hatchabot (every agent)' : `"${agent.name}"`;
  return `💵 Hatchabot: ${whose} has spent ${money(spent)} in ${monthName(month)} — you hear every ${whole(a.stepUsd)}.${pace && pace > spent * 1.05 ? ` On pace for ${money(pace)}.` : ''}`
    + `\nAsk me what it went on, or to make ${a.scope === MACHINE ? 'the agents' : 'it'} cheaper.`;
}
/** HATCHABOT_NEW_AGENT_ALERT_EVERY: "25" (dollars); off/empty = none. */
export function parseStep(raw: string | undefined): number | undefined {
  const m = /^\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*$/.exec(raw ?? '');
  const n = m ? Number(m[1]) : NaN;
  return n >= MIN_BUDGET && n <= MAX_BUDGET ? n : undefined;
}
export const newAgentStep = (env: NodeJS.ProcessEnv = process.env) => parseStep(env.HATCHABOT_NEW_AGENT_ALERT_EVERY);

/** The chat message for a budget mark; `acted`: what the budget paused or moved this pass. */
export function budgetMessage(b: BudgetRow, spent: number, level: 80 | 100, month: string, agent: Agent, acted: Array<{ a: Agent; to?: string }>, now: number, tz: string): string {
  const whole_ = b.scope === MACHINE;
  const whose = whole_ ? 'This Hatchabot' : `"${agent.name}"`;
  const of = `${whole(b.usd)} budget for ${monthName(month)}`;
  const elapsed = monthElapsed(now, tz);
  const pace = elapsed >= 2 / 31 ? spent / elapsed : undefined;
  const next = `${monthName(nextMonth(month))} 1`;
  if (level === 80) {
    const then = b.atLimit === 'pause' ? ` At 100% ${whole_ ? 'its agents pause' : 'it pauses'} until ${next}.`
      : b.atLimit === 'cheaper' ? ` At 100% ${whole_ ? 'its agents move' : 'it moves'} to the cheapest model ${whole_ ? 'their sources offer' : 'its source offers'} until ${next}.` : '';
    return `💵 Hatchabot: ${whose} has used ${Math.round((spent / b.usd) * 100)}% of its ${of} (${money(spent)})${pace ? `, on pace for ${money(pace)}` : ''}.${then}\nAsk me to raise the budget or to make ${whole_ ? 'the agents' : 'it'} cheaper.`;
  }
  const n = acted.length;
  if (b.atLimit === 'pause') {
    const what = whole_ ? `${n || 'its'} agent${n === 1 ? ' is' : 's are'} paused (not me)` : 'it is paused';
    return `⏸ Hatchabot: ${whose} has used its ${of} (${money(spent)}): ${what} until ${next}.\nRaise the budget to start ${whole_ ? 'them' : 'it'} again now, or start ${whole_ ? 'one' : 'it'} in the app (it then runs on until the 1st).`;
  }
  if (b.atLimit === 'cheaper') {
    const what = whole_
      ? (n ? `${n} agent${n === 1 ? ' now runs' : 's now run'} on the cheapest model ${n === 1 ? 'its source offers' : 'their sources offer'} (not me)` : 'every agent was already on its cheapest model')
      : acted[0]?.to ? `it now runs on ${bare(acted[0].to)}` : `it was already on the cheapest model its source offers, so it keeps working as it is`;
    return `💵 Hatchabot: ${whose} has used its ${of} (${money(spent)}): ${what}${n ? ` until ${next}` : ''}.\n${n ? `Raise the budget to switch ${whole_ ? 'them' : 'it'} back now; change a model yourself and the budget leaves it alone until the 1st.` : 'Ask me to raise the budget, or have it pause at the limit.'}`;
  }
  return `💵 Hatchabot: ${whose} has used its ${of} (${money(spent)})${pace && pace > spent ? `, on pace for ${money(pace)}` : ''}. It keeps working: the budget is set to warn.\nAsk me to raise it, make ${whole_ ? 'the agents' : 'it'} cheaper, or have ${whole_ ? 'them' : 'it'} pause at the limit.`;
}

// ---- a paused agent's one reply ----------------------------------------------

/** One reply per chat at most this often while an agent stays paused. */
export const REPLY_EVERY_MS = 12 * 3_600_000;

export interface ReplyDeps {
  store: Store;
  secretOf(ref: string): Promise<string>;
  fetchImpl?: typeof fetch;
  log?(event: string, detail: Record<string, unknown>): void;
  tz?: string;
}

/** What a paused agent's bot answers someone who writes to it. */
export function pausedReplyText(agentName: string, scope: string, month: string): string {
  const back = `${monthName(nextMonth(month))} 1`;
  return `⏸ ${agentName} is paused: ${scope === MACHINE ? 'this Hatchabot has' : 'it has'} used its budget for ${monthName(month)}. `
    + `It is back on ${back}, or sooner if its owner raises the budget. Messages sent while it is paused may not reach it.`;
}

/**
 * Someone writes to a paused agent on Telegram: its bot answers once (per
 * chat, at most every REPLY_EVERY_MS) so they are not left with silence.
 * Reads the bot's waiting updates WITHOUT an offset — nothing is confirmed,
 * so the agent still gets them when it is back (Telegram keeps them a day) —
 * the same way a sleeping agent notices mail (hibernate.ts). Direct chats
 * only; a group is not interrupted. Returns how many replies went out.
 */
export async function pausedReplySweep(deps: ReplyDeps, now = Date.now()): Promise<number> {
  const { store } = deps;
  const f = deps.fetchImpl ?? fetch;
  let sent = 0;
  for (const p of store.listBudgetPauses({ open: true })) {
    if (p.kind !== 'pause') continue;
    const a = store.getAgent(p.agentId);
    if (!a || a.state !== 'STOPPED') continue;
    const ch = store.listChannelsForAgent(a.id).find((c) => c.kind === 'telegram');
    if (!ch) continue;
    let token: string;
    try { token = await deps.secretOf(ch.secretRef); } catch { continue; }
    let updates: Array<{ update_id?: number; message?: { date?: number; chat?: { id?: number; type?: string }; from?: { is_bot?: boolean } } }>;
    try {
      const res = await f(`https://api.telegram.org/bot${token}/getUpdates?limit=100&timeout=0`, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: typeof updates };
      if (body.ok !== true || !Array.isArray(body.result)) continue;
      updates = body.result;
    } catch { continue; }
    const since = Date.parse(p.pausedAt) - 60_000;
    const replies = { ...(p.replies ?? {}) };
    const newest = new Map<string, number>();
    for (const u of updates) {
      const m = u.message, id = Number(u.update_id) || 0;
      if (!m || m.chat?.type !== 'private' || m.from?.is_bot || typeof m.chat.id !== 'number') continue;
      if ((m.date ?? 0) * 1000 < since) continue;
      const chat = String(m.chat.id);
      if (id > (replies[chat]?.u ?? 0) && id > (newest.get(chat) ?? 0)) newest.set(chat, id);
    }
    if (!newest.size) continue;
    for (const [chat, u] of newest) {
      const last = replies[chat];
      replies[chat] = { u, at: last?.at ?? 0 };
      if (last && now - last.at < REPLY_EVERY_MS) continue;
      try {
        const res = await f(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: Number(chat), text: pausedReplyText(a.name, p.scope, p.month) }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) { replies[chat] = { u, at: now }; sent++; deps.log?.('budget.paused_reply', { agentId: a.id }); }
      } catch { /* the next sweep tries again */ }
    }
    store.setBudgetPauseReplies(p.agentId, p.month, replies);
  }
  return sent;
}

// ---- the default for new agents --------------------------------------------------

/** HATCHABOT_NEW_AGENT_BUDGET: "50", "50 pause", "50 cheaper"; off/empty = none. */
export function parseNewAgentBudget(raw: string | undefined): { usd: number; atLimit: AtLimit } | undefined {
  const m = /^\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(warn|pause|cheaper)?\s*$/i.exec(raw ?? '');
  if (!m) return undefined;
  const usd = Number(m[1]);
  if (!(usd >= MIN_BUDGET && usd <= MAX_BUDGET)) return undefined;
  return { usd, atLimit: (m[2]?.toLowerCase() as AtLimit | undefined) ?? 'warn' };
}
export const newAgentBudget = (env: NodeJS.ProcessEnv = process.env) => parseNewAgentBudget(env.HATCHABOT_NEW_AGENT_BUDGET);
