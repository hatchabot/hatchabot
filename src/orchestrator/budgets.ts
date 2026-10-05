import type { Agent } from '../domain/types.js';
import type { BudgetRow, Store } from '../store/store.js';
import { HOUR_FIELDS } from './usage.js';
import type { StoredProfile } from './modelScorecard.js';
import { priceMix, type TokenMix } from './modelOptions.js';

/**
 * Budgets (docs/features.md, "Budgets"): a monthly limit in US dollars at API
 * prices, on one agent or on the whole machine. At 80% the owner gets a
 * "Needs you" line and one message on the manager's chat; at 100% the same,
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

export interface BudgetView {
  scope: string;
  usd: number;
  atLimit: 'warn' | 'pause';
  month: string;
  /** Spent this month so far, USD. */
  spent: number;
  pct: number;
  /** The month's total at this pace (from the 3rd day on). */
  onPace?: number;
  /** 0, 80 (warned) or 100 (reached). */
  level: 0 | 80 | 100;
  /** "November 1": when a pause ends by itself. */
  resetsOn: string;
  /** Paused by this budget now. */
  paused?: { at: string };
  /** Started by hand after a pause this month: not paused again until the 1st. */
  resumedByHand?: boolean;
}

export function levelOf(spent: number, usd: number): 0 | 80 | 100 {
  return spent >= usd ? 100 : spent >= usd * WARN_AT ? 80 : 0;
}

export function budgetView(store: Store, b: BudgetRow, spent: number, now: number, tz: string, agentId?: string): BudgetView {
  const month = monthKey(now, tz);
  const elapsed = monthElapsed(now, tz);
  const pause = agentId ? store.getBudgetPause(agentId, month) : undefined;
  return {
    scope: b.scope, usd: b.usd, atLimit: b.atLimit, month,
    spent: r2(spent), pct: Math.round((spent / b.usd) * 100),
    ...(elapsed >= 2 / 31 ? { onPace: r2(spent / elapsed) } : {}),
    level: levelOf(spent, b.usd),
    resetsOn: `${monthName(nextMonth(month))} 1`,
    ...(pause && !pause.resumedAt && pause.scope === b.scope ? { paused: { at: pause.pausedAt } } : {}),
    ...(pause?.resumedBy === 'owner' ? { resumedByHand: true } : {}),
  };
}

const money = (x: number) => (x >= 100 ? `$${Math.round(x)}` : `$${x.toFixed(2)}`);
const whole = (x: number) => (Number.isInteger(x) ? `$${x}` : `$${x.toFixed(2)}`);

/** The Needs-you line for a budget at 80% or more ("" below that). */
export function budgetLine(v: BudgetView, whose: string): string {
  const of = `its ${whole(v.usd)} budget for ${monthName(v.month)}`;
  if (v.paused) return `Paused: ${whose} used ${of} (${money(v.spent)}). It starts again on ${v.resetsOn} — or raise the budget, or start it now`;
  if (v.level === 100) return `Over ${of}: ${money(v.spent)} so far${v.onPace && v.onPace > v.spent ? `, on pace for ${money(v.onPace)}` : ''}${v.atLimit === 'pause' && v.resumedByHand ? ' (started by hand after its pause: it runs on until the 1st)' : ''}`;
  if (v.level === 80) return `Used ${v.pct}% of ${of} (${money(v.spent)})${v.onPace ? ` — on pace for ${money(v.onPace)}` : ''}${v.atLimit === 'pause' ? '; it pauses at 100%' : ''}`;
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
  isBusy(agentId: string): boolean;
  log?(event: string, detail: Record<string, unknown>): void;
  tz?: string;
}

const pausable = (a: Agent) => !a.ops && !a.migratedTo && !!a.runtimeRef;

/**
 * One pass, after a usage pass (or at once after a budget changes): record
 * cost days, start what a new month or a raised budget frees, mark and tell
 * 80% and 100%, and pause what a "pause" budget says to.
 */
export async function runBudgets(deps: BudgetDeps, now = Date.now(), opts: { record?: boolean } = {}): Promise<{ paused: string[]; resumed: string[]; told: number }> {
  const { store } = deps;
  const tz = deps.tz ?? machineTz();
  const nowIso = new Date(now).toISOString();
  const month = monthKey(now, tz);
  if (opts.record !== false) recordCostDays(store, tz, now);
  const agents = store.listAllActiveAgents().filter((a) => a.state !== 'DELETED' && a.state !== 'DELETING');
  const byId = new Map(agents.map((a) => [a.id, a]));
  const spend = monthSpend(store, month);
  const budgets = store.listBudgets();
  const machine = budgets.find((b) => b.scope === MACHINE);
  const machineSpent = [...spend.values()].reduce((s, x) => s + x, 0);
  const over = (scope: string): boolean => {
    const b = budgets.find((x) => x.scope === scope);
    if (!b || b.atLimit !== 'pause') return false;
    return (scope === MACHINE ? machineSpent : spend.get(scope) ?? 0) >= b.usd;
  };
  const paused: string[] = [], resumed: string[] = [];

  // 1. Pauses that end: a new month, a budget raised, removed or set to warn, or the agent gone.
  for (const p of store.listBudgetPauses({ open: true })) {
    const a = byId.get(p.agentId) ?? store.getAgent(p.agentId);
    if (!a || a.state === 'ARCHIVED' || a.state === 'DELETED') { store.resumeBudgetPause(p.agentId, p.month, nowIso, 'gone'); continue; }
    // Started some other way than Start (a rebuild): still over → paused again below; not over → done.
    if (a.state !== 'STOPPED') {
      if (p.month !== month || !over(p.scope)) store.resumeBudgetPause(p.agentId, p.month, nowIso, 'started');
      continue;
    }
    const why = p.month !== month ? 'new-month' : !over(p.scope) ? 'budget-raised' : undefined;
    if (!why) continue;
    if (deps.isBusy(a.id)) continue;
    if (await deps.resume(a).catch(() => false)) {
      store.resumeBudgetPause(p.agentId, p.month, nowIso, why);
      resumed.push(a.id);
      deps.log?.('budget.resumed', { agentId: a.id, why });
    }
  }

  // 2. Marks, messages and pauses, per budget.
  let told = 0;
  const scoped = budgets.filter((b) => b.scope === MACHINE || byId.has(b.scope));
  for (const b of scoped) {
    const spent = b.scope === MACHINE ? machineSpent : spend.get(b.scope) ?? 0;
    const level = levelOf(spent, b.usd);
    if (!level) continue;
    const agent = b.scope === MACHINE ? agents.find((a) => a.ownerId === b.ownerId && a.ops) : byId.get(b.scope);
    // Pause first, so the message says what happened.
    const victims = level === 100 && b.atLimit === 'pause'
      ? (b.scope === MACHINE ? agents : agent ? [agent] : []).filter(pausable)
      : [];
    const pausedHere: Agent[] = [];
    let deferred = 0;
    for (const a of victims) {
      const prior = store.getBudgetPause(a.id, month);
      if (prior?.resumedBy === 'owner') continue; // started by hand after a pause: runs on until the 1st
      if (prior && !prior.resumedAt && a.state !== 'RUNNING') continue; // already paused (running again: a rebuild started it)
      const asleep = a.state === 'STOPPED' && !!a.hibernatedAt;
      if (a.state !== 'RUNNING' && !asleep) continue;
      const lastOk = Date.parse(store.usageCursor(a.id)?.lastOk ?? '') || 0;
      // Busy, or mid-turn: the next pass.
      if (deps.isBusy(a.id) || (!asleep && now - lastOk < QUIET_MS)) { deferred++; continue; }
      if (await deps.pause(a).catch(() => false)) {
        store.addBudgetPause(a.id, month, b.scope, nowIso);
        paused.push(a.id);
        pausedHere.push(a);
        deps.log?.('budget.paused', { agentId: a.id, scope: b.scope === MACHINE ? MACHINE : 'agent', spent: r2(spent), usd: b.usd });
      } else deferred++;
    }
    // The 100% message says what happened: while the pause still waits on a turn, it waits too.
    const hold100 = deferred > 0 && !pausedHere.length;
    for (const lv of level === 100 ? [80, 100] : [80]) {
      if (lv === 100 && hold100) continue;
      // 80% is told only if 100% isn't also new this pass.
      const fresh = store.addBudgetMark(b.scope, month, lv, b.usd, nowIso);
      if (!fresh || (lv === 80 && level === 100)) continue;
      if (!agent) continue;
      const text = budgetMessage(b, spent, lv as 80 | 100, month, agent, pausedHere.length, now, tz);
      const ok = await deps.tell(b.ownerId, agent, text).catch(() => false);
      store.markBudgetTold(b.scope, month, lv, b.usd, nowIso);
      told++;
      deps.log?.('budget.told', { agentId: agent.id, scope: b.scope === MACHINE ? MACHINE : 'agent', level: lv, told: ok });
    }
  }
  store.pruneBudgetMarks(prevMonth(prevMonth(month)));
  return { paused, resumed, told };
}

/** The chat message for a budget mark. */
export function budgetMessage(b: BudgetRow, spent: number, level: 80 | 100, month: string, agent: Agent, pausedCount: number, now: number, tz: string): string {
  const whose = b.scope === MACHINE ? 'This Hatchabot' : `"${agent.name}"`;
  const of = `${whole(b.usd)} budget for ${monthName(month)}`;
  const elapsed = monthElapsed(now, tz);
  const pace = elapsed >= 2 / 31 ? spent / elapsed : undefined;
  const next = `${monthName(nextMonth(month))} 1`;
  if (level === 80) {
    return `💵 Hatchabot: ${whose} has used ${Math.round((spent / b.usd) * 100)}% of its ${of} (${money(spent)})${pace ? `, on pace for ${money(pace)}` : ''}.`
      + `${b.atLimit === 'pause' ? ` At 100% ${b.scope === MACHINE ? 'its agents pause' : 'it pauses'} until ${next}.` : ''}\nAsk me to raise the budget or to make ${b.scope === MACHINE ? 'the agents' : 'it'} cheaper.`;
  }
  if (b.atLimit === 'pause') {
    const what = b.scope === MACHINE ? `${pausedCount || 'its'} agent${pausedCount === 1 ? ' is' : 's are'} paused (not me)` : 'it is paused';
    return `⏸ Hatchabot: ${whose} has used its ${of} (${money(spent)}): ${what} until ${next}.\nRaise the budget to start ${b.scope === MACHINE ? 'them' : 'it'} again now, or start ${b.scope === MACHINE ? 'one' : 'it'} in the app (it then runs on until the 1st).`;
  }
  return `💵 Hatchabot: ${whose} has used its ${of} (${money(spent)})${pace && pace > spent ? `, on pace for ${money(pace)}` : ''}. It keeps working: the budget is set to warn.\nAsk me to raise it, make ${b.scope === MACHINE ? 'the agents' : 'it'} cheaper, or have ${b.scope === MACHINE ? 'them' : 'it'} pause at the limit.`;
}
