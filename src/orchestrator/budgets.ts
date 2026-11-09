import type { Agent } from '../domain/types.js';
import type { BudgetRow, SpendAlertRow, Store } from '../store/store.js';
import { HOUR_FIELDS } from './usage.js';
import type { StoredProfile } from './modelScorecard.js';
import { LOCAL_MODEL, priceMix, type TokenMix } from './modelOptions.js';

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
/**
 * How long a pause waits for a quiet moment once 100% is reached. An agent in a
 * loop or under steady load is never quiet for three minutes, and the limit
 * exists for exactly that case: past this it is paused mid-turn (audit, 2026-10-20).
 */
export const PAUSE_WAIT_MS = 20 * 60_000;
/**
 * A cheaper-model switch the agent's runtime keeps refusing: tried every pass
 * until its 100% message has gone (PAUSE_WAIT_MS after the limit), then at most
 * this often. Its refusal goes on the agent's timeline once a day; the rest to
 * the service log (regression audit, 2026-10-22).
 */
export const DOWNGRADE_RETRY_MS = 3_600_000;
/** The budget mark kept when its 100% message said a switch did not take; told once a later one takes. */
const LATE_SWITCH = 101;
const refusals = new WeakMap<Store, Map<string, { at: number; day: string }>>();
const refusalsOf = (store: Store) => { let m = refusals.get(store); if (!m) refusals.set(store, m = new Map()); return m; };
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

/**
 * An agent's cost per local day from its stored profile's hour buckets; the
 * window's first (partial) day named. `unpriced`: the tokens per day that ran on
 * a model with no known price (OpenAI's and Google's, today). Their cost is not
 * $0, it is unknown: they are kept apart so the page and a budget can say so
 * (HB-0402). `local`: the agent's source is local, so nothing of it is billed.
 */
export function dailyCosts(p: StoredProfile | undefined, tz: string, opts: { local?: boolean } = {}): { days: Map<string, number>; unpriced: Map<string, number>; partialDay?: string } {
  const days = new Map<string, number>();
  const unpriced = new Map<string, number>();
  if (!p?.models) return { days, unpriced };
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
    let usd = 0, tokens = 0;
    for (const [model, mix] of byModel) {
      const priced = priceMix(model, mix);
      if (priced !== undefined) usd += priced;
      else if (!opts.local && !LOCAL_MODEL.test(model)) tokens += mix.input + mix.output + mix.cacheRead + mix.cacheWrite;
    }
    days.set(d, usd);
    if (tokens > 0) unpriced.set(d, tokens);
  }
  return { days, unpriced, ...(p.since ? { partialDay: dayKey(p.since, tz) } : {}) };
}

/** Write every agent's cost days from what the sampler stored. */
export function recordCostDays(store: Store, tz: string, now = Date.now()): void {
  const agents = store.listAllActiveAgents().filter((a) => a.state !== 'DELETED');
  const profiles = store.modelProfiles(agents.map((a) => a.id)) as Map<string, { profile: StoredProfile; at: string }>;
  for (const [id, { profile }] of profiles) {
    if (profile.hourly !== true && !Object.values(profile.models ?? {}).some((s) => s.h && Object.keys(s.h).length)) continue;
    const agent = agents.find((a) => a.id === id);
    const local = !!agent && store.getAIProfile(agent.aiProfileId)?.vendor === 'local';
    const { days, unpriced, partialDay } = dailyCosts(profile, tz, { local });
    if (days.size) store.setCostDays(id, days, partialDay, unpriced);
  }
  store.pruneCostDays(dayKey(now - KEEP_DAYS * DAY, tz));
}

/** Each agent's spend in a month ("YYYY-MM"). */
export function monthSpend(store: Store, month: string, agentIds?: string[]): Map<string, number> {
  return store.costBetween(`${month}-01`, `${month}-31`, agentIds);
}

/** Each agent's tokens in a month ("YYYY-MM") on models with no known price. */
export function monthUnpriced(store: Store, month: string, agentIds?: string[]): Map<string, number> {
  return store.unpricedBetween(`${month}-01`, `${month}-31`, agentIds);
}

/**
 * What a limit in dollars cannot see on an agent, in words ("" = nothing): the
 * model it runs on now has no known price, or part of this month's use did.
 */
export function priceGapNote(gap: { model?: string; tokens: number }): string {
  if (gap.model) return `No price known for ${bare(gap.model)}, so what it costs cannot be measured in dollars: a limit or "Tell me every $…" cannot be enforced on it.`;
  if (gap.tokens > 0) return `${Math.round(gap.tokens).toLocaleString('en-US')} tokens this month ran on a model with no price known and are not counted: a limit or "Tell me every $…" sees only the rest.`;
  return '';
}
/** The same for the machine's total: how many agents it leaves out, not who (they may be anyone's). */
export function machinePriceGapNote(agents: number): string {
  if (!agents) return '';
  return `${agents} agent${agents === 1 ? '' : 's'} on this machine ${agents === 1 ? 'uses a model' : 'use models'} with no price known: this total leaves that spend out, so a limit or "Tell me every $…" here cannot count it.`;
}

/**
 * A round budget a little above what an agent costs a month now ($5 at least),
 * never above MAX_BUDGET: a Set or Raise button the budget route then refused
 * (HTTP 400) was a dead button (#182).
 */
export function suggestBudget(monthlyUSD: number): number {
  const want = Math.max(5, monthlyUSD * 1.25);
  const steps = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000];
  return Math.min(MAX_BUDGET, steps.find((s) => s >= want) ?? Math.ceil(want / 1000) * 1000);
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
  /** staysStopped: stopped by hand as well, so the end of the pause does not start it. */
  paused?: { at: string; staysStopped?: boolean };
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
    ...(open && act.kind === 'pause' ? { paused: { at: act.pausedAt, ...(act.alreadyStopped ? { staysStopped: true } : {}) } } : {}),
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
  if (v.paused?.staysStopped) return `Over ${of} (${money(v.spent)}), and stopped by hand: it stays stopped until you start it`;
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
  /** Start an agent a budget paused. False keeps the pause open for the next pass: it could not be started now, or only a rebuild was queued, which may never bring it up. */
  resume(agent: Agent): Promise<boolean>;
  /**
   * Move an agent to the cheapest model its source offers that its runtime can use (live), recorded in
   * the model ledger as the budget's; undefined when there is nothing cheaper.
   * `from` is its own model pin before (null: its source's default).
   * `hold`: called with the record's write of the cheaper model, in one
   * transaction, before it is applied: it opens the switch's pause row
   * then, so a change made while it applies (a class's model) sees it and
   * sets the model that comes back. A switch that throws has it dropped.
   */
  downgrade?(agent: Agent, hold: (from: string | null, to: string) => void): Promise<{ from: string | null; to: string } | undefined>;
  /** Put an agent's model pin back (null = its source's default), recorded as the budget's. */
  restoreModel?(agent: Agent, pin: string | null): Promise<boolean>;
  /**
   * Put back the cheaper model a budget had chosen (its own was put back for a
   * pause that then did not happen), recorded as that budget's switch. True
   * only if the runtime took it; refused, its own pin stays (eighth review).
   */
  reapplyCheaper?(agent: Agent, model: string | null): Promise<boolean>;
  isBusy(agentId: string): boolean;
  log?(event: string, detail: Record<string, unknown>): void;
  /** The service log, for what would flood the agent's timeline. */
  warn?(event: string, detail: Record<string, unknown>): void;
  tz?: string;
}

const pausable = (a: Agent) => !a.ops && !a.migratedTo && !!a.runtimeRef && a.state !== 'ARCHIVED';
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
  /**
   * This budget still says `kind` and is still reached. The budget as it is NOW:
   * a start or a stop earlier in this pass can take minutes, and a budget raised,
   * removed or set to warn meanwhile must not be enforced as it was (HB-0574).
   */
  const over = (scope: string, kind: AtLimit): boolean => {
    const b = store.getBudget(scope);
    if (!b || b.atLimit !== kind) return false;
    return (scope === MACHINE ? machineSpent : spend.get(scope) ?? 0) >= b.usd;
  };
  const paused: string[] = [], resumed: string[] = [], downgraded: string[] = [];
  /**
   * Its own model was put back for a pause that is not happening: the cheaper
   * model a budget chose goes back, as that budget's switch, the record as it
   * was. One the runtime does not take closes the switch as the budget's doing,
   * so the next pass does not read its own model as the owner's choice (seventh
   * and eighth reviews).
   */
  const putCheaperBackOrClose = async (a: Agent, cheap: { fromModel?: string | null; toModel?: string | null }): Promise<void> => {
    if (deps.reapplyCheaper && (await deps.reapplyCheaper(a, cheap.toModel ?? null).catch(() => false))) return;
    store.resumeBudgetPause(a.id, month, nowIso, 'budget-changed');
    deps.log?.('budget.model_restored', { agentId: a.id, why: 'budget-changed', model: cheap.fromModel ?? null });
  };

  // 1. What ends: a new month, a budget raised, removed or changed, the agent gone, or the owner taking over.
  for (const listed of store.listBudgetPauses({ open: true })) {
    // Each as it is NOW: an earlier agent's start in this pass can take minutes, and a
    // Stop or a Start pressed meanwhile changes what this one is owed.
    const p = store.getBudgetPause(listed.agentId, listed.month);
    if (!p || p.resumedAt) continue;
    const a = store.getAgent(p.agentId);
    if (!a || a.state === 'ARCHIVED' || a.state === 'DELETED') {
      // Archived on a cheaper model a budget chose: its own goes back on the record now, or a
      // restore from the archive would bring the cheaper one back for good.
      if (a && a.state === 'ARCHIVED' && p.kind === 'cheaper' && deps.restoreModel && (!p.toModel || (a.model ?? null) === p.toModel)) {
        if (!(await deps.restoreModel(a, p.fromModel ?? null).catch(() => false))) continue;
        deps.log?.('budget.model_restored', { agentId: a.id, why: 'archived', model: p.fromModel ?? null });
      }
      store.resumeBudgetPause(p.agentId, p.month, nowIso, 'gone');
      continue;
    }
    if (p.kind === 'cheaper') {
      // Its model changed by hand since: the owner's choice stands, and the budget leaves it alone until the 1st.
      if (p.toModel && (a.model ?? null) !== p.toModel) { store.resumeBudgetPause(p.agentId, p.month, nowIso, 'owner'); continue; }
      const why = p.month !== month ? 'new-month' : !over(p.scope, 'cheaper') ? 'budget-raised' : undefined;
      if (!why || !deps.restoreModel) continue;
      // Another cheaper budget that covers it still reached (its own, or the machine's): it
      // stays on the cheaper model, as a pause stays (A09), or it ran on its own until the
      // next pass moved it again (final audit, 2026-10-22).
      if (over(a.id, 'cheaper') || (switchable(a) && over(MACHINE, 'cheaper'))) continue;
      if (await deps.restoreModel(a, p.fromModel ?? null).catch(() => false)) {
        store.resumeBudgetPause(p.agentId, p.month, nowIso, why);
        resumed.push(a.id);
        deps.log?.('budget.model_restored', { agentId: a.id, why, model: p.fromModel ?? null });
      }
      continue;
    }
    // Started some other way than Start (a rebuild, its own resume below when it
    // owed one): still over → paused again below; not over → done, once it is up.
    // A rebuild still going, or one that failed, has not started it (HB-0419).
    if (a.state !== 'STOPPED') {
      if (a.state === 'RUNNING' && (p.month !== month || !over(p.scope, 'pause'))) {
        store.resumeBudgetPause(p.agentId, p.month, nowIso, 'started');
        deps.log?.('budget.resumed', { agentId: a.id, why: p.month !== month ? 'new-month' : 'budget-raised' });
      }
      continue;
    }
    const why = p.month !== month ? 'new-month' : !over(p.scope, 'pause') ? 'budget-raised' : undefined;
    if (!why) continue;
    // Another pause budget that covers it still reached (its own, or the machine's): it stays
    // paused, or it would run until the next pass paused it again (report A09, 2026-10-22).
    if (over(a.id, 'pause') || (pausable(a) && over(MACHINE, 'pause'))) continue;
    // Stopped by hand when the limit came, or since (a rebuild had it up, and the owner
    // pressed Stop before a pass closed this: Store.disownBudgetPause, HB-0419): the
    // budget's stop is not what holds it, so it starts nothing. The record closes and the
    // agent stays as its owner left it — before, a machine budget started every
    // hand-stopped agent on the 1st (review R11, 2026-10-23). Asleep is the same: a pause
    // takes the sleeper's mark off, so one with the mark was put to sleep since, and a
    // message wakes it.
    if (p.alreadyStopped || a.hibernatedAt) {
      store.resumeBudgetPause(p.agentId, p.month, nowIso, why);
      deps.log?.('budget.pause_closed', { agentId: a.id, why, alreadyStopped: !!p.alreadyStopped });
      continue;
    }
    if (deps.isBusy(a.id)) continue;
    if (await deps.resume(a).catch(() => false)) {
      store.resumeBudgetPause(p.agentId, p.month, nowIso, why);
      resumed.push(a.id);
      deps.log?.('budget.resumed', { agentId: a.id, why });
    }
  }

  // 2. Marks, messages, pauses and cheaper models, per budget.
  let told = 0;
  // An archived agent's budget is neither marked nor told: the view hides it, and it spends nothing (audit, 2026-10-23).
  const scoped = budgets.filter((b) => b.scope === MACHINE || (byId.has(b.scope) && byId.get(b.scope)!.state !== 'ARCHIVED'));
  for (const b of scoped) {
    const spent = b.scope === MACHINE ? machineSpent : spend.get(b.scope) ?? 0;
    const level = levelOf(spent, b.usd);
    if (!level) continue;
    const agent = b.scope === MACHINE ? agents.find((a) => a.ownerId === b.ownerId && a.ops) : byId.get(b.scope);
    const pool = b.scope === MACHINE ? agents : agent ? [agent] : [];
    // Act first, so the message says what happened.
    const acted: Array<{ a: Agent; to?: string; stopped?: boolean }> = [];
    let deferred = 0;
    // The 100% mark is set when it is first reached, told or not: a pause waits from then.
    const fresh100 = level === 100 && store.addBudgetMark(b.scope, month, 100, b.usd, nowIso);
    const reachedAt = level === 100 ? Date.parse(store.budgetMark(b.scope, month, 100, b.usd)?.at ?? '') || now : now;
    const waitedOut = now - reachedAt >= PAUSE_WAIT_MS;
    // Each agent as it is NOW: an earlier budget in this pass may have moved it
    // to a cheaper model. Judged on the list read before, a pause did not see
    // that model, did not put its own back, and its record replaced the one
    // that remembered it — the agent came back on the cheaper model for good
    // (audit #010).
    const current = (a: Agent): Agent => store.getAgent(a.id) ?? a;
    // The budget this pass read, unchanged since: each pause and each switch is
    // checked against it just before it is made. Raised, removed or set to warn
    // while an earlier agent stopped, the rest were still stopped (HB-0574). A
    // revised budget is left to the pass its change queued: nothing more is done
    // or told for it here.
    const unchanged = (): boolean => {
      const cur = store.getBudget(b.scope);
      return !!cur && cur.usd === b.usd && cur.atLimit === b.atLimit && cur.setAt === b.setAt && cur.ownerId === b.ownerId;
    };
    let revised = false;
    if (level === 100 && b.atLimit === 'pause') {
      for (const a of pool.filter(pausable).map(current)) {
        if (!unchanged()) { revised = true; break; }
        const prior = store.getBudgetPause(a.id, month);
        if (prior?.resumedBy === 'owner' && prior.kind === 'pause') continue; // started by hand after a pause: runs on until the 1st
        // Already paused (running again: a rebuild started it). A cheaper model another
        // budget chose does not hold a pause back: pausing is the stronger (#101).
        if (prior && !prior.resumedAt && prior.kind === 'pause' && a.state !== 'RUNNING') continue;
        const asleep = a.state === 'STOPPED' && !!a.hibernatedAt;
        if (a.state !== 'RUNNING' && !asleep) {
          // Stopped by hand (or failed) when the limit came: nothing to pause, but the
          // pause is RECORDED, so Start marks the owner's take-over and the next pass
          // does not pause it again in silence — the message promises exactly that
          // (audit, 2026-10-23). FAILED and PROVISIONING agents are judged when they run.
          if (a.state === 'STOPPED' && (!prior || prior.resumedAt)) {
            store.addBudgetPause(a.id, month, b.scope, nowIso, undefined, { alreadyStopped: true });
            paused.push(a.id);
            acted.push({ a, stopped: true });
            deps.log?.('budget.paused', { agentId: a.id, scope: b.scope === MACHINE ? MACHINE : 'agent', spent: r2(spent), usd: b.usd, alreadyStopped: true });
          }
          continue;
        }
        const lastOk = Date.parse(store.usageCursor(a.id)?.lastOk ?? '') || 0;
        // Busy, or mid-turn: the next pass. Mid-turn only for so long (PAUSE_WAIT_MS).
        if (deps.isBusy(a.id) || (!asleep && !waitedOut && now - lastOk < QUIET_MS)) { deferred++; continue; }
        // Paused on a cheaper model a budget chose: its own model comes back first,
        // so it starts again on it; a budget still reached then moves it again. A
        // restore that did not take defers the pause to the next pass: the pause
        // row would replace the one that remembers its own model (review R12, 2026-10-23).
        const cheap = prior && !prior.resumedAt && prior.kind === 'cheaper' ? prior : undefined;
        let ownBack = false;
        if (cheap && deps.restoreModel && (a.model ?? null) === (cheap.toModel ?? null)) {
          if (!(await deps.restoreModel(a, cheap.fromModel ?? null).catch(() => false))) { deferred++; continue; }
          ownBack = true;
          if (!unchanged()) {
            revised = true;
            // Its own model is back, but the pause it was for is off. Left so,
            // with the switch still open, the next pass read its own model as
            // the owner's choice and the budget left it there until the 1st.
            // The switch this budget made closes as its doing, and the next
            // pass judges it afresh. Another budget's (the machine's) is not
            // this one's to close: the cheaper model goes back, the record as
            // it was, for the next pass to sort out (HB-0574 review). Only if
            // that does not take does it close all the same, so it is not
            // read as the owner's choice.
            // Changed, not raised: it may have been lowered, set to warn, or removed.
            if (cheap.scope === b.scope) {
              store.resumeBudgetPause(a.id, month, nowIso, 'budget-changed');
              deps.log?.('budget.model_restored', { agentId: a.id, why: 'budget-changed', model: cheap.fromModel ?? null });
            } else await putCheaperBackOrClose(a, cheap);
            break;
          }
        }
        if (await deps.pause(a).catch(() => false)) {
          store.addBudgetPause(a.id, month, b.scope, nowIso);
          paused.push(a.id);
          acted.push({ a });
          deps.log?.('budget.paused', { agentId: a.id, scope: b.scope === MACHINE ? MACHINE : 'agent', spent: r2(spent), usd: b.usd });
        } else {
          deferred++;
          // Its own model was put back for a pause that did not take: left so,
          // the next pass read it as the owner's choice and the switch's budget
          // left it alone until the 1st. The cheaper model goes back and the
          // pause is tried again, or the switch closes (seventh review).
          if (ownBack && cheap) await putCheaperBackOrClose(a, cheap);
        }
      }
    }
    const refused: Agent[] = [];
    if (level === 100 && b.atLimit === 'cheaper' && deps.downgrade) {
      const tries = refusalsOf(store);
      const told100 = !!store.budgetMark(b.scope, month, 100, b.usd)?.toldAt;
      for (const a of pool.filter(switchable).map(current)) {
        if (!unchanged()) { revised = true; break; }
        const prior = store.getBudgetPause(a.id, month);
        if (prior?.resumedBy === 'owner' || (prior && !prior.resumedAt)) continue;
        if (deps.isBusy(a.id)) { deferred++; continue; }
        // A switch that failed is not "nothing cheaper": it is tried again on the
        // next pass, and the 100% message waits for it (#185) — for so long
        // (PAUSE_WAIT_MS), then says it did not take; after that, hourly.
        const last = tries.get(a.id);
        if (last && told100 && now - last.at < DOWNGRADE_RETRY_MS) { deferred++; refused.push(a); continue; }
        let r: Awaited<ReturnType<NonNullable<BudgetDeps['downgrade']>>>;
        let held = false;
        const hold = (from: string | null, to: string) => { store.addBudgetPause(a.id, month, b.scope, nowIso, { fromModel: from, toModel: to }); held = true; };
        try { r = await deps.downgrade(a, hold); } catch (err) {
          // Not a switch: the row its hold opened goes, and the next pass tries again.
          if (held) store.dropCheaperPause(a.id, month);
          deferred++;
          refused.push(a);
          const day = nowIso.slice(0, 10);
          const detail = { agentId: a.id, error: String((err as Error)?.message ?? err).slice(0, 200) };
          if (last?.day !== day) deps.log?.('budget.downgrade_failed', detail); else deps.warn?.('budget.downgrade_failed', detail);
          tries.set(a.id, { at: now, day: last?.day === day ? last.day : day });
          continue;
        }
        tries.delete(a.id);
        if (!r) continue; // nothing cheaper on its source
        // Opened by its hold already (a model to restore a change set since kept), or now.
        if (!held) store.addBudgetPause(a.id, month, b.scope, nowIso, { fromModel: r.from, toModel: r.to });
        downgraded.push(a.id);
        acted.push({ a, to: r.to });
        deps.log?.('budget.downgraded', { agentId: a.id, scope: b.scope === MACHINE ? MACHINE : 'agent', to: r.to, spent: r2(spent), usd: b.usd });
      }
    }
    if (revised || !unchanged()) {
      deps.warn?.('budget.revised_during_pass', { scope: b.scope === MACHINE ? MACHINE : 'agent', agentId: b.scope === MACHINE ? undefined : b.scope, acted: acted.length });
      continue;
    }
    // The 100% message says what happened: while the action still waits on a turn, it waits too.
    // A switch refused past PAUSE_WAIT_MS does not hold it: it says the switch did not take.
    const hold100 = deferred > 0 && !acted.length && !(refused.length && waitedOut);
    for (const lv of level === 100 ? [80, 100] : [80]) {
      if (lv === 100 && hold100) continue;
      const fresh = lv === 100 ? fresh100 : store.addBudgetMark(b.scope, month, lv, b.usd, nowIso);
      if (store.budgetMark(b.scope, month, lv, b.usd)?.toldAt) continue;
      // 80% is not told once 100% is reached as well: the 100% message says it all.
      // While the 100% message waits on a pause or a switch, the 80% one goes, so the owner hears now.
      if (lv === 80 && level === 100 && !hold100) { store.markBudgetTold(b.scope, month, lv, b.usd, nowIso); continue; }
      // A mark is told once it reached the owner: with no manager yet, or a
      // message that failed, it stays due and the next pass tries again (#62).
      if (!agent) continue;
      // A retry says what the budget did on an earlier pass.
      const did = acted.length || lv !== 100 ? acted : store.listBudgetPauses({ open: true, month })
        .filter((p) => p.scope === b.scope && p.kind === b.atLimit)
        .map((p) => ({ a: byId.get(p.agentId) ?? agent, ...(p.toModel ? { to: p.toModel } : {}), ...(p.alreadyStopped ? { stopped: true } : {}) }));
      const text = budgetMessage(b, spent, lv as 80 | 100, month, agent, did, now, tz, refused);
      const ok = await deps.tell(b.ownerId, agent, text).catch(() => false);
      if (ok || fresh) deps.log?.('budget.told', { agentId: agent.id, scope: b.scope === MACHINE ? MACHINE : 'agent', level: lv, told: ok });
      if (!ok) continue;
      store.markBudgetTold(b.scope, month, lv, b.usd, nowIso);
      told++;
      // It said a switch did not take: remembered, so the one that takes later is told.
      if (lv === 100 && refused.length) store.addBudgetMark(b.scope, month, LATE_SWITCH, b.usd, nowIso);
    }
    // A switch the 100% message said did not take has taken since: one message that it
    // has, or the owner's last word was that it still runs on its own model (final audit,
    // 2026-10-22). Kept with the budget's marks, so a restart neither repeats nor loses it.
    const late = b.atLimit === 'cheaper' && agent ? store.budgetMark(b.scope, month, LATE_SWITCH, b.usd) : undefined;
    if (late && !late.toldAt) {
      const since = store.listBudgetPauses({ open: true, month })
        .filter((p) => p.scope === b.scope && p.kind === 'cheaper' && p.toModel && p.pausedAt > late.at)
        .map((p) => ({ a: byId.get(p.agentId) ?? agent!, to: p.toModel! }));
      if (since.length) {
        const ok = await deps.tell(b.ownerId, agent!, lateSwitchMessage(b, month, agent!, since)).catch(() => false);
        deps.log?.('budget.told', { agentId: agent!.id, scope: b.scope === MACHINE ? MACHINE : 'agent', level: 100, late: true, told: ok });
        if (ok) { store.markBudgetTold(b.scope, month, LATE_SWITCH, b.usd, nowIso); told++; }
      }
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
    deps.log?.('budget.step_told', { agentId: agent.id, scope: al.scope === MACHINE ? MACHINE : 'agent', spent: r2(spent), every: al.stepUsd, told: ok });
    // Not delivered: still due, so the next pass tries again (#62).
    if (!ok) continue;
    store.setSpendAlertState(al.scope, month, al.stepUsd, k, nowIso);
    told++;
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

/**
 * The chat message for a budget mark; `acted`: what the budget paused or moved this pass
 * (`stopped`: recorded on an agent that was already stopped by hand, which the budget
 * neither stopped nor will start).
 */
export function budgetMessage(b: BudgetRow, spent: number, level: 80 | 100, month: string, agent: Agent, acted: Array<{ a: Agent; to?: string; stopped?: boolean }>, now: number, tz: string, refused: Agent[] = []): string {
  const whole_ = b.scope === MACHINE;
  const whose = whole_ ? 'This Hatchabot' : `"${agent.name}"`;
  const of = `${whole(b.usd)} budget for ${monthName(month)}`;
  const elapsed = monthElapsed(now, tz);
  const pace = elapsed >= 2 / 31 ? spent / elapsed : undefined;
  const next = `${monthName(nextMonth(month))} 1`;
  if (level === 80) {
    // Past 100% already, its pause waiting for a quiet moment, or its switch for the runtime (at most PAUSE_WAIT_MS).
    const when = spent >= b.usd ? 'Shortly' : 'At 100%';
    const then = b.atLimit === 'pause' ? ` ${when} ${whole_ ? 'its agents pause' : 'it pauses'} until ${next}.`
      : b.atLimit === 'cheaper' ? ` ${when} ${whole_ ? 'its agents move' : 'it moves'} to the cheapest model ${whole_ ? 'their sources offer' : 'its source offers'} until ${next}.` : '';
    return `💵 Hatchabot: ${whose} has used ${Math.round((spent / b.usd) * 100)}% of its ${of} (${money(spent)})${pace ? `, on pace for ${money(pace)}` : ''}.${then}\nAsk me to raise the budget or to make ${whole_ ? 'the agents' : 'it'} cheaper.`;
  }
  const n = acted.length;
  if (b.atLimit === 'pause') {
    // Stopped by hand when the limit came: the budget stopped nothing and starts nothing,
    // so neither "paused until the 1st" nor "raise the budget to start it" would be true.
    const k = acted.filter((x) => x.stopped).length, paused = n - k;
    if (!whole_ && k) {
      return `⏸ Hatchabot: ${whose} has used its ${of} (${money(spent)}): it was already stopped, so it stays stopped.\nStart it in the app when you want it (it then runs on until the 1st); raising the budget does not start it, and nor does the 1st.`;
    }
    const stay = k ? `${k} agent${k === 1 ? ' that was' : 's that were'} already stopped stay${k === 1 ? 's' : ''} so` : '';
    const what = whole_
      ? (paused ? `${paused} agent${paused === 1 ? ' is' : 's are'} paused (not me) until ${next}${k ? `; ${stay}` : ''}` : k ? `nothing was running to pause (not me); ${stay}` : `its agents are paused (not me) until ${next}`)
      : `it is paused until ${next}`;
    const then = whole_ && !paused && k
      ? 'Start one in the app when you want it (it then runs on until the 1st).'
      : `Raise the budget to start ${whole_ ? 'them' : 'it'} again now, or start ${whole_ ? 'one' : 'it'} in the app (it then runs on until the 1st).`;
    return `⏸ Hatchabot: ${whose} has used its ${of} (${money(spent)}): ${what}.\n${then}`;
  }
  if (b.atLimit === 'cheaper') {
    const k = refused.length;
    // A switch the runtime refused: said as such, never as "already on the cheapest".
    const notYet = k ? (whole_ ? `${k} agent${k === 1 ? '' : 's'} could not be switched yet (${k === 1 ? 'its runtime refused' : 'their runtimes refused'} it; Hatchabot keeps trying)` : 'the switch to a cheaper model did not take (its runtime refused it), so it still runs on its own model; Hatchabot keeps trying') : '';
    const what = whole_
      ? (n ? `${n} agent${n === 1 ? ' now runs' : 's now run'} on the cheapest model ${n === 1 ? 'its source offers' : 'their sources offer'} (not me)${k ? `; ${notYet}` : ''}` : k ? notYet : 'no agent has a cheaper model it can run')
      : acted[0]?.to ? `it now runs on ${bare(acted[0].to)}` : k ? notYet : `its source offers nothing cheaper it can run, so it keeps working as it is`;
    return `💵 Hatchabot: ${whose} has used its ${of} (${money(spent)}): ${what}${n ? ` until ${next}` : ''}.\n${n ? `Raise the budget to switch ${whole_ ? 'them' : 'it'} back now; change a model yourself and the budget leaves it alone until the 1st.` : 'Ask me to raise the budget, or have it pause at the limit.'}`;
  }
  return `💵 Hatchabot: ${whose} has used its ${of} (${money(spent)})${pace && pace > spent ? `, on pace for ${money(pace)}` : ''}. It keeps working: the budget is set to warn.\nAsk me to raise it, make ${whole_ ? 'the agents' : 'it'} cheaper, or have ${whole_ ? 'them' : 'it'} pause at the limit.`;
}

/** A switch the 100% message said did not take, taken since. */
export function lateSwitchMessage(b: BudgetRow, month: string, agent: Agent, since: Array<{ a: Agent; to: string }>): string {
  const next = `${monthName(nextMonth(month))} 1`;
  const n = since.length;
  const what = b.scope === MACHINE
    ? `${n} agent${n === 1 ? ' that could not be switched now runs' : 's that could not be switched now run'} on the cheapest model ${n === 1 ? 'its source offers' : 'their sources offer'}`
    : `"${agent.name}" now runs on ${bare(since[0]!.to)} after all: the switch its budget asked for has taken`;
  return `💵 Hatchabot: ${what}, until ${next}.\nRaise the budget to switch ${b.scope === MACHINE ? 'them' : 'it'} back now.`;
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

/** The most updates one getUpdates call returns. */
const TELEGRAM_PAGE = 100;
/**
 * Kept in the pause row's replies, beside the chats answered: that this
 * pause's full queue was said (`at`: when the pause began, so a second pause
 * in the month says it again), once a pause, across restarts too. Never a
 * chat id (those are numbers).
 */
export const QUEUE_FULL_TOLD = 'queue-full';

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
    if (p.kind !== 'pause' || p.alreadyStopped) continue; // stopped by hand: "back on the 1st" would not be true
    const a = store.getAgent(p.agentId);
    if (!a || a.state !== 'STOPPED') continue;
    const ch = store.listChannelsForAgent(a.id).find((c) => c.kind === 'telegram');
    if (!ch) continue;
    let token: string;
    try { token = await deps.secretOf(ch.secretRef); } catch { continue; }
    let updates: Array<{ update_id?: number; message?: { date?: number; chat?: { id?: number; type?: string }; from?: { is_bot?: boolean } } }>;
    try {
      const res = await f(`https://api.telegram.org/bot${token}/getUpdates?limit=${TELEGRAM_PAGE}&timeout=0`, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: typeof updates };
      if (body.ok !== true || !Array.isArray(body.result)) continue;
      updates = body.result;
    } catch { continue; }
    // Telegram shows the first 100 waiting updates, and the only way past them
    // is to confirm them, which would take them from the agent. So with 100
    // waiting, whoever wrote after them gets no reply until the agent is back
    // (HB-0576). Said once a pause, on the agent's activity, not hidden.
    const replies = { ...(p.replies ?? {}) };
    let toldFull = false;
    const pausedAt = Date.parse(p.pausedAt);
    if (updates.length >= TELEGRAM_PAGE && replies[QUEUE_FULL_TOLD]?.at !== pausedAt) {
      replies[QUEUE_FULL_TOLD] = { u: updates.length, at: pausedAt };
      toldFull = true;
      deps.log?.('budget.paused_reply_queue_full', { agentId: a.id, waiting: updates.length });
    }
    const since = pausedAt - 60_000;
    const newest = new Map<string, number>();
    for (const u of updates) {
      const m = u.message, id = Number(u.update_id) || 0;
      if (!m || m.chat?.type !== 'private' || m.from?.is_bot || typeof m.chat.id !== 'number') continue;
      if ((m.date ?? 0) * 1000 < since) continue;
      const chat = String(m.chat.id);
      if (id > (replies[chat]?.u ?? 0) && id > (newest.get(chat) ?? 0)) newest.set(chat, id);
    }
    if (!newest.size) { if (toldFull) store.setBudgetPauseReplies(p.agentId, p.month, replies); continue; }
    for (const [chat, u] of newest) {
      const last = replies[chat];
      // Answered lately: these messages are seen, and get no second reply.
      if (last && now - last.at < REPLY_EVERY_MS) { replies[chat] = { u, at: last.at }; continue; }
      // Otherwise they count as answered only once the reply went out: a failed
      // send leaves them new, so the next sweep tries again (#184).
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
