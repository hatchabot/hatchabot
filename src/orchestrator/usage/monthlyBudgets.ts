import { randomBytes, randomUUID } from 'node:crypto';
import type { Agent, AIProfile } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { BudgetRow, Store } from '../../store/store.js';
import {
  MACHINE, budgetView, machinePriceGapNote, machineTz, monthKey, monthSpend, monthUnpriced, pausedReplySweep, priceGapNote,
  prevMonth, primeSpendAlert, recordCutOffPauses, runBudgets, stepView, type AtLimit, type BudgetView, type StepView,
} from './budgets.js';
import { AgentBusyError, isBusy, whileBusy } from '../lifecycle/busy.js';
import { settleStartsOwedOn } from '../lifecycle/operations.js';
import type { ModelApplied } from '../lifecycle/modelRuntime.js';
import { modelOverrideProblem } from '../lifecycle/modelRuntime.js';
import { recordChanges, snapshotModels, type ChangeMeta } from './modelLedger.js';
import { LOCAL_MODEL, modelOption } from '../sources/modelOptions.js';
import { effectiveModel, renderRefusedRecently } from '../lifecycle/provision.js';
import { stopAndConfirm } from '../lifecycle/quiesce.js';

/** Said where an alarm is set, when no chat reaches its owner: what still works, and how to hear (HB-0403). */
export const NO_CHAT_NOTE = 'No chat app can reach you for this, so no message will come. A limit still acts and shows under Alerts at 100%; a step shows only in the tile\'s tooltip. To be told, give your Hatchabot agent a chat app and link yourself on it.';

/** The start of the model ask a budget's switch to a cheaper model makes (Store.setAgentModel's `apply`, HB-1404). */
const CHEAPER_ASK = 'budget-cheaper:';
/**
 * The switch's ask: unique, and carrying what the pass's own undoing judges
 * by (the source it was made on, the default a follower followed), so the
 * next process, told it was refused (cheaperRefused), undoes it the same way.
 */
const cheaperAsk = (source: string, defaultThen: string | undefined): string =>
  `${CHEAPER_ASK}${JSON.stringify({ source, defaultThen: defaultThen ?? null, n: randomUUID() })}`;
const readCheaperAsk = (ask: string): { source: string; defaultThen: string | null } | undefined => {
  if (!ask.startsWith(CHEAPER_ASK)) return undefined;
  try {
    const v = JSON.parse(ask.slice(CHEAPER_ASK.length)) as { source?: unknown; defaultThen?: unknown };
    return typeof v?.source === 'string' ? { source: v.source, defaultThen: typeof v.defaultThen === 'string' ? v.defaultThen : null } : undefined;
  } catch { return undefined; }
};

/** The machine-wide budget's view (its spend is every agent's, any owner's). */
export interface MachineBudgetView { budget?: BudgetView; alertEvery?: StepView; spent: number; lastMonth: number }

/**
 * Monthly budgets and "tell me every $X" (HB-0808; the rules are budgets.ts,
 * docs/features.md "Budgets"): the budget pass, its pause, its switch to a
 * cheaper model and their undoing, a paused agent's bot answering whoever
 * writes, and the budgets and step alarms an owner sets.
 *
 * Its state, sorted (HB-0809): the pass under way (`budgetPassing`) and the
 * paused replies' sweep under way (`replySweeping`), plain variables: one at
 * a time. What a pass decided is in the store (`budget_pauses`); a model it
 * switched is asked for there (`apply`, HB-0809), and at the start
 * `AgentSettings.resume()` tells every running agent its memory budget.
 *
 * Its timer: the paused replies' sweep every `pausedReplyEveryMs` (0: none,
 * the tests), `unref()`'d, ended by `stop()`. The pass itself runs after
 * each usage pass (usageSampler.ts) and at once after a budget changes.
 *
 * Nothing here knows about HTTP: a route checks who is asking and what was
 * sent, asks this, and words the answer.
 */
export interface MonthlyBudgets {
  /**
   * One budget pass: after each usage pass, and at once when a budget changes
   * (`record: false`: the cost days are as fresh as the last pass). One pass
   * at a time. Never rejects: a failure is logged (`budget.pass_failed`).
   */
  runPass(opts?: { record?: boolean }): Promise<unknown>;
  /** A paused agent's bot answers whoever writes to it, once a chat. One sweep at a time; never rejects. */
  runPausedReplies(): Promise<void>;
  /** A Stop by a person wins over a budget pause still open (HB-0419). */
  disownPauseOnStop(agentId: string): void;
  /**
   * At boot, before the starts operations still owe are run: each pause an
   * earlier process stopped its agent for and never recorded, recorded, and
   * the starts owed on it taken over (budgets.ts recordCutOffPauses, HB-0835).
   * One whose record still says RUNNING is left for a budget pass, which
   * asks its runtime (HB-0835 review).
   */
  recordCutOffPauses(): void;
  /**
   * After a restart: the runtime refused the model an earlier process's
   * switch to a cheaper model had stored with its ask (`ask`, the ask's
   * value; modelRuntime.ts serveOwed). The switch did not take, as when it
   * is refused in the pass that made it: its own model goes back on the
   * record and its switch is dropped, so the next pass tries again and its
   * 100% message waits for it (HB-1404). Any other ask is left. Never throws.
   */
  cheaperRefused(agentId: string, ask: string): void;
  /** How an agent's AI is paid for: a plan, an API key, or a local model. */
  billingOf(a: Agent): 'plan' | 'api' | 'local';
  /** The model an agent runs on now, when it has no known price (a local one needs none). */
  unpricedModelOf(a: Agent): string | undefined;
  /** What a dollar limit cannot see on this agent, in words ("" = nothing). */
  priceNoteOf(a: Agent, now?: number): string;
  /** The same for the machine's total: agents whose spend it cannot count. */
  machinePriceNote(now?: number): string;
  /** NO_CHAT_NOTE when no chat app reaches this owner (for this agent), else "". */
  chatNoteOf(ownerId: string, agentId?: string): string;
  /** The machine-wide budget's view. */
  machineBudgetView(now?: number): MachineBudgetView;
  /**
   * Set (or with `usd` null, remove) one agent's monthly budget: stored, in
   * the token actions as `meta` says, on its timeline, and a pass run at once
   * (a raised budget frees a paused agent; a lowered one pauses it, if
   * quiet). `before`: its budget as the caller read it. Its budget and view after.
   */
  setAgentBudget(agent: Agent, set: { usd: number | null; atLimit: AtLimit; why?: string }, before: BudgetRow | undefined, meta: ChangeMeta): Promise<{ budget: BudgetRow | undefined; view: BudgetView | undefined; now: number }>;
  /** Set (or remove) the whole machine's budget, then a pass at once. The machine's view after. */
  setMachineBudget(ownerId: string, usd: number | null, atLimit: AtLimit, by: string): Promise<MachineBudgetView>;
  /** Set (or with `every` null, remove) an agent's "tell me every $X", counted from now. Its view after. */
  setAgentSpendAlert(agent: Agent, every: number | null, meta: ChangeMeta): { view: StepView | undefined; now: number };
  /** The same for the whole machine's spend. */
  setMachineSpendAlert(ownerId: string, every: number | null, by: string): { view: StepView | undefined; now: number };
  /** End the timer: at shutdown. */
  stop(): void;
}

/** What the budgets need from the process they run in. Functions only, so a test hands them fakes. */
export interface MonthlyBudgetsDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** A budget's message to its owner; true if it reached them. */
  tell: (ownerId: string, agent: Agent, text: string) => Promise<boolean>;
  /** Does any chat app reach this owner (for this agent)? */
  chatReaches: (ownerId: string, agentId?: string) => boolean;
  /** A secret by its reference (a paused agent's bot token). */
  secretOf: (ref: string) => Promise<string>;
  /** Is a setup or rebuild of this agent in flight (the registry's queue)? */
  inFlight: (agentId: string) => boolean;
  /** Start a stopped agent as Start does (the registry's): a budget's resume. */
  startStopped: (agent: Agent) => Promise<{ ok: boolean; rebuilding?: boolean }>;
  /** Put an agent's stored model on its runtime (the agent settings service's). */
  applyModelToRuntime: (agentId: string) => Promise<ModelApplied>;
  /** Why this runtime cannot use that model, if it cannot (the agent settings service's). */
  subscriptionRuntimeProblem: (agent: Agent, profile: AIProfile, model: string | null | undefined) => Promise<string | undefined>;
  /** The service log. */
  warn: (detail: Record<string, unknown>, msg: string) => void;
  /** How often the paused replies' sweep runs; 0 starts no timer. */
  pausedReplyEveryMs: number;
}

export function createMonthlyBudgets(deps: MonthlyBudgetsDeps): MonthlyBudgets {
  const { store, providerFor, trace, inFlight, startStopped, applyModelToRuntime, subscriptionRuntimeProblem } = deps;
  const tellUsageSpike = deps.tell;

  /**
   * A Stop by a person wins over a budget pause still open: one a rebuild ended
   * with the agent up, before a pass closed it. Left as it was, the next pass
   * started what they had just stopped (HB-0419). So does one a restart
   * cut off before its stop was recorded (`budget-pause`, HB-0835): its
   * stop is theirs now, and the next pass does not take it for the budget's.
   */
  const disownPauseOnStop = (agentId: string): void => {
    const kept = store.clearAgentHold(agentId, 'budget-pause');
    if (store.disownBudgetPause(agentId) || kept) trace(agentId)('budget.pause_disowned', {});
  };
  /**
   * Budgets (budgets.ts): after each usage pass, and at once when a budget
   * changes (record: false — the cost days are as fresh as the last pass).
   * One pass at a time.
   */
  let budgetPassing: Promise<unknown> | null = null;
  const runBudgetPass = (opts: { record?: boolean } = {}): Promise<unknown> => {
    const go = async () => {
      if (budgetPassing) await budgetPassing.catch(() => {});
      // A cheaper-model retry follows a restoration and a possibly slow
      // stop. Remember which restoration is ours across both waits, so an
      // owner edit during the stop is not overwritten before retry begins.
      const restored = new Map<string, { generation: number; source: string }>();
      return runBudgets({
        store, tell: tellUsageSpike, isBusy,
        // A machine that does not answer (a runner asleep) is not "up".
        runtimeUp: async (a) => !!a.runtimeRef && (await providerFor(a.hostId).status(a.runtimeRef)).phase === 'running',
        pause: async (a) => {
          const now = store.getAgent(a.id);
          if (!now?.runtimeRef || isBusy(a.id)) return false;
          if (now.state !== 'RUNNING' && !(now.state === 'STOPPED' && now.hibernatedAt)) return false;
          // The record changes under the lock too, judged again once it is
          // held: a Start or an Archive must not land between the two (#10).
          return whileBusy(a.id, 'budget-pause', async () => {
            const held = store.getAgent(a.id);
            if (!held?.runtimeRef || (held.state !== 'RUNNING' && !(held.state === 'STOPPED' && held.hibernatedAt))) return false;
            // A successful stop reply or an asleep label is not proof the
            // runtime stopped. Record a pause only after confirmation; a
            // lost reply after a successful stop is reconciled too (HB-0711).
            await stopAndConfirm(providerFor(held.hostId), held.runtimeRef);
            store.setHibernated(a.id, null);
            store.setAgentState(a.id, 'STOPPED');
            // Paused: a start a restart left owed is not to undo it (HB-0980).
            settleStartsOwedOn(store, a.id, 'budget-pause');
            return true;
          }).catch((err) => { if (err instanceof AgentBusyError) return false; throw err; });
        },
        // Owing a rebuild, its start only queues one, and that may be refused at
        // render time and leave it STOPPED (HB-0419): the pause stays open until a
        // pass finds it up (budgets.ts). One refused is tried again when that
        // refusal has aged, as the sweep does, not every pass.
        resume: async (a) => {
          if (inFlight(a.id) || (store.getAgent(a.id)?.rebuildOnStart && renderRefusedRecently(a.id))) return false;
          const r = await startStopped(a);
          return r.ok && !r.rebuilding;
        },
        // "Switch to a cheaper model" at the limit: the cheapest model its source
        // offers, live, in the ledger as the budget's (the quality guard and the
        // Right-size savings leave such changes out); its own pin comes back after.
        downgrade: async (a, hold) => {
          const profile = store.getAIProfile(a.aiProfileId);
          if (!profile || profile.vendor === 'local') return undefined;
          const price = (m: string) => { const o = modelOption(m); return o ? o.input + o.output / 5 : undefined; };
          const cur = effectiveModel(a, profile);
          const offered = [...new Set([profile.model, ...(profile.models ?? [])].filter((m): m is string => !!m))];
          const now = price(cur);
          if (now === undefined) return undefined;
          // The cheapest this agent's runtime can use: moved onto one Anthropic
          // refuses, every message fails while the owner hears it moved (HB-0425).
          let cheapest: string | undefined;
          for (const m of offered.filter((x) => price(x) !== undefined && price(x)! < now && !modelOverrideProblem(profile, x)).sort((x, y) => price(x)! - price(y)!)) {
            if (!(await subscriptionRuntimeProblem(a, profile, m))) { cheapest = m; break; }
          }
          if (!cheapest) return undefined;
          const from = a.model ?? null, defaultThen = profile.model;
          const before = snapshotModels(store, [a.id]);
          // Hatchabot's own write, not the agent's (setAgentModel's `hatchabot`):
          // a class change checked before it still applies (changedSince).
          // Its pause row opens with it (`hold`), before it is applied: a
          // class's model written meanwhile becomes the one that comes back.
          // `apply`: asked for with the write, so a restart before the
          // runtime is told leaves it to the next start (HB-0809).
          // The ask is the switch's own (CHEAPER_ASK), so a refusal at the next start is known as its (cheaperRefused).
          store.transact(() => { store.setAgentModel(a.id, cheapest, { hatchabot: true, apply: cheaperAsk(a.aiProfileId, defaultThen) }); hold(from, cheapest); });
          const ours = store.modelGeneration(a.id), source = store.getAgent(a.id)?.aiProfileId;
          // A switch the runtime refused is not a switch: the record goes back and
          // the budget tries again next pass, its 100% message waiting (budgets.ts).
          // Counted as made, it kept spending on the dearer model while the owner
          // was told it had moved (review, 2026-10-22).
          // 'rebuild' (a source switch waits for a rebuild) and 'none' (busy, mid-move,
          // FAILED) are not switches either: the agent kept spending on the dearer
          // model while the owner was told it had moved (audit, 2026-10-23).
          const applied = await applyModelToRuntime(a.id).catch(() => 'failed' as const);
          if (applied !== 'live' && applied !== 'staged') {
            // Only the budget's own write goes back: a model the owner chose
            // while it waited stands, the same model included, and its own
            // apply (queued behind this one) puts it on. Put back
            // unconditionally, that choice was lost (HB-0581). A write asked
            // for it since moves the agent's model generation on; one
            // Hatchabot made on its own does not (the default-model sweep's
            // hold of this same model), so it goes back then too. A source
            // switched meanwhile changes what the model means, so it stands.
            // A follower whose source's default that sweep moved is held on
            // the default it followed, as the sweep holds followers, while
            // the menu offers it.
            // A class's model written meanwhile, as the one to come back, is the one put back.
            const now = store.getAgent(a.id);
            if (now && store.modelGeneration(a.id) === ours && now.aiProfileId === source) {
              const p = store.getAIProfile(source), meant = store.openCheaperPause(a.id)?.fromModel;
              const held = meant !== undefined && meant !== from ? meant
                : from === null && p && defaultThen && p.model !== defaultThen && !modelOverrideProblem(p, defaultThen) ? defaultThen : from;
              store.setAgentModel(a.id, held, { hatchabot: true });
            }
            throw new Error(`the runtime did not take ${cheapest} (${applied})`);
          }
          recordChanges(store, before, { by: 'hatchabot', via: 'budget', source: 'budget', why: 'Its monthly budget was reached: the cheapest model its source offers, until the 1st.' });
          return { from, to: cheapest };
        },
        restoreModel: async (a, pin) => {
          const profile = store.getAIProfile(a.aiProfileId);
          if (!profile) return false;
          const back = pin && !modelOverrideProblem(profile, pin) ? pin : null;
          const before = snapshotModels(store, [a.id]);
          store.setAgentModel(a.id, back, { hatchabot: true, apply: true });
          restored.set(a.id, { generation: store.modelGeneration(a.id), source: a.aiProfileId });
          // Unlike the switch down, a runtime that refuses this keeps the record:
          // its own model is what it should run, the page shows it as waiting
          // (pendingModel), and the next rebuild puts it on. Kept cheap, a pause
          // over it would replace the record that remembers its own model.
          await applyModelToRuntime(a.id).catch(() => 'failed' as const);
          recordChanges(store, before, { by: 'hatchabot', via: 'budget', source: 'budget', why: 'Back to its own model: a new month, or its budget raised.' });
          return true;
        },
        // The cheaper model a budget chose, back for a pause that did not take
        // (budgets.ts putCheaperBackOrClose): the budget's switch, kept only if
        // the runtime took it, as with the switch down.
        reapplyCheaper: async (a, model) => {
          const current = store.getAgent(a.id);
          const was = restored.get(a.id);
          if (!current || !was || current.aiProfileId !== was.source || store.modelGeneration(a.id) !== was.generation) return false;
          const own = current.model ?? null, source = current.aiProfileId;
          const before = snapshotModels(store, [a.id]);
          store.setAgentModel(a.id, model, { hatchabot: true, apply: true });
          const ours = store.modelGeneration(a.id);
          const applied = await applyModelToRuntime(a.id).catch(() => 'failed' as const);
          if (applied !== 'live' && applied !== 'staged') {
            // Like the first budget downgrade: only undo our own write.
            // A newer choice (even of this same model), or another source,
            // belongs to the owner and its queued apply must keep it.
            if (store.modelGeneration(a.id) === ours && store.getAgent(a.id)?.aiProfileId === source) {
              store.setAgentModel(a.id, own, { hatchabot: true });
            }
            return false;
          }
          recordChanges(store, before, { by: 'hatchabot', via: 'budget', source: 'budget', why: 'Its monthly budget was reached: the cheapest model its source offers, until the 1st.' });
          return true;
        },
        log: (event, detail) => { trace(String(detail.agentId ?? 'admin'))(event, detail); },
        warn: (event, detail) => { deps.warn(detail, event); },
      }, Date.now(), opts).catch((err) => { deps.warn({ err: String(err) }, 'budget.pass_failed'); });
    };
    const p = go().finally(() => { if (budgetPassing === p) budgetPassing = null; });
    budgetPassing = p;
    return p;
  };
  // A paused agent's bot answers whoever writes to it, once a chat (budgets.ts).
  let replySweeping = false;
  const runPausedReplies = async () => {
    if (replySweeping) return;
    replySweeping = true;
    try {
      if (!store.listBudgetPauses({ open: true }).some((p) => p.kind === 'pause')) return;
      await pausedReplySweep({ store, secretOf: (ref) => deps.secretOf(ref), log: (event, detail) => { trace(String(detail.agentId ?? 'admin'))(event, detail); } }); }
    catch (err) { deps.warn({ err: String(err) }, 'budget.reply_failed'); }
    finally { replySweeping = false; }
  };
  const replies = deps.pausedReplyEveryMs > 0 ? setInterval(() => { void runPausedReplies(); }, deps.pausedReplyEveryMs).unref() : undefined;

  const billingOf = (a: Agent): 'plan' | 'api' | 'local' => {
    const p = store.getAIProfile(a.aiProfileId);
    return p?.vendor === 'local' ? 'local' : p?.kind === 'subscription' ? 'plan' : 'api';
  };
  const chatNoteOf = (ownerId: string, agentId?: string): string => (deps.chatReaches(ownerId, agentId) ? '' : NO_CHAT_NOTE);
  /** The model an agent runs on now, when it has no known price (a local one needs none). */
  const unpricedModelOf = (a: Agent): string | undefined => {
    const p = store.getAIProfile(a.aiProfileId);
    if (!p || p.vendor === 'local') return undefined;
    const model = effectiveModel(a, p);
    return model && !LOCAL_MODEL.test(model) && !modelOption(model) ? model : undefined;
  };
  /** What a dollar limit cannot see on this agent, in words ("" = nothing). Said where a limit is set (HB-0402). */
  const priceNoteOf = (a: Agent, now = Date.now()): string =>
    priceGapNote({ model: unpricedModelOf(a), tokens: monthUnpriced(store, monthKey(now, machineTz()), [a.id]).get(a.id) ?? 0 });
  /** The same for the machine's total: agents whose spend it cannot count. */
  const machinePriceNote = (now = Date.now()): string => {
    const tokens = monthUnpriced(store, monthKey(now, machineTz()));
    const agents = store.listAllActiveAgents().filter((a) => a.state !== 'DELETED' && a.state !== 'DELETING' && a.state !== 'ARCHIVED');
    return machinePriceGapNote(agents.filter((a) => tokens.has(a.id) || !!unpricedModelOf(a)).length);
  };
  /** The machine-wide budget's view (its spend is every agent's, any owner's). */
  const machineBudgetView = (now = Date.now()): MachineBudgetView => {
    const tz = machineTz(), month = monthKey(now, tz);
    const sum = (m: Map<string, number>) => Math.round([...m.values()].reduce((x, y) => x + y, 0) * 100) / 100;
    const spent = sum(monthSpend(store, month));
    const b = store.getBudget(MACHINE);
    const al = store.getSpendAlert(MACHINE);
    return { ...(b ? { budget: budgetView(store, b, spent, now, tz) } : {}), ...(al ? { alertEvery: stepView(al, spent, now, tz) } : {}), spent, lastMonth: sum(monthSpend(store, prevMonth(month))) };
  };

  const setAgentBudget: MonthlyBudgets['setAgentBudget'] = async (agent, set, before, meta) => {
    const { usd, atLimit } = set;
    const nowIso = new Date().toISOString();
    store.setBudget(agent.id, agent.ownerId, usd, atLimit, nowIso, meta.by);
    store.addTokenAction({
      id: `ta_${randomBytes(8).toString('hex')}`, agentId: agent.id, ownerId: agent.ownerId, kind: 'budget', at: nowIso,
      by: meta.by, via: meta.via, ...(meta.why || set.why ? { why: (meta.why ?? set.why)!.slice(0, 400) } : {}), ...(meta.proposalId ? { proposalId: meta.proposalId } : {}),
      detail: { from: before ? { usd: before.usd, atLimit: before.atLimit } : null, to: usd === null ? null : { usd, atLimit } }, outcome: 'applied',
    });
    trace(agent.id)('budget.set', { usd, atLimit, by: meta.by, via: meta.via });
    // A raised budget frees a paused agent at once; a lowered one pauses at once (if quiet).
    await runBudgetPass({ record: false });
    const b = store.getBudget(agent.id);
    const tz = machineTz(), now = Date.now();
    const view = b ? budgetView(store, b, monthSpend(store, monthKey(now, tz), [agent.id]).get(agent.id) ?? 0, now, tz, agent.id) : undefined;
    return { budget: b, view, now };
  };
  const setMachineBudget: MonthlyBudgets['setMachineBudget'] = async (ownerId, usd, atLimit, by) => {
    store.setBudget(MACHINE, ownerId, usd, atLimit, new Date().toISOString(), by);
    trace('admin')('budget.machine_set', { usd, atLimit });
    await runBudgetPass({ record: false });
    return machineBudgetView();
  };
  const setAgentSpendAlert: MonthlyBudgets['setAgentSpendAlert'] = (agent, every, meta) => {
    const now = Date.now(), tz = machineTz(), nowIso = new Date(now).toISOString();
    const before = store.getSpendAlert(agent.id);
    store.setSpendAlert(agent.id, agent.ownerId, every, nowIso, meta.by);
    const spent = monthSpend(store, monthKey(now, tz), [agent.id]).get(agent.id) ?? 0;
    if (every !== null) primeSpendAlert(store, agent.id, every, spent, now, tz);
    store.addTokenAction({
      id: `ta_${randomBytes(8).toString('hex')}`, agentId: agent.id, ownerId: agent.ownerId, kind: 'budget', at: nowIso,
      by: meta.by, via: meta.via, ...(meta.why ? { why: meta.why.slice(0, 400) } : {}), ...(meta.proposalId ? { proposalId: meta.proposalId } : {}),
      detail: { alertEvery: { from: before?.stepUsd ?? null, to: every } }, outcome: 'applied',
    });
    trace(agent.id)('budget.step_set', { every, by: meta.by, via: meta.via });
    const al = store.getSpendAlert(agent.id);
    return { view: al ? stepView(al, spent, now, tz) : undefined, now };
  };
  const setMachineSpendAlert: MonthlyBudgets['setMachineSpendAlert'] = (ownerId, every, by) => {
    const now = Date.now(), tz = machineTz();
    store.setSpendAlert(MACHINE, ownerId, every, new Date(now).toISOString(), by);
    const spent = [...monthSpend(store, monthKey(now, tz)).values()].reduce((x, y) => x + y, 0);
    if (every !== null) primeSpendAlert(store, MACHINE, every, spent, now, tz);
    trace('admin')('budget.machine_step_set', { every });
    const al = store.getSpendAlert(MACHINE);
    return { view: al ? stepView(al, spent, now, tz) : undefined, now };
  };

  // The switch's own ask, refused at the next start (modelRuntime.ts serveOwed,
  // which tells only of one nothing was asked or written over since): undone
  // as the pass undoes a switch its runtime refused (downgrade, above).
  const cheaperRefused = (agentId: string, ask: string): void => {
    try {
      const made = readCheaperAsk(ask);
      if (!made) return;
      const open = store.openCheaperPause(agentId);
      const a = store.getAgent(agentId);
      // Still on the model the switch chose: nobody has chosen another since (that ask would be theirs, not this one).
      if (!open?.toModel || !a || (a.model ?? null) !== open.toModel) return;
      const p = store.getAIProfile(a.aiProfileId);
      if (!p) return;
      // A source switched since changes what the model means, so it stands:
      // only the switch's record goes, as in the pass.
      const back = a.aiProfileId !== made.source ? undefined
        // The model to come back (a class's written meanwhile included), while its source offers it.
        : open.fromModel ? (modelOverrideProblem(p, open.fromModel) ? null : open.fromModel)
        // A follower whose source's default moved since is held on the default it followed, while the menu offers it.
        : made.defaultThen && p.model !== made.defaultThen && !modelOverrideProblem(p, made.defaultThen) ? made.defaultThen : null;
      store.transact(() => { if (back !== undefined) store.setAgentModel(agentId, back, { hatchabot: true }); store.dropCheaperPause(agentId, open.month); });
      trace(agentId)('budget.downgrade_failed', { agentId, error: `the runtime did not take ${open.toModel} when Hatchabot restarted` });
    } catch (err) { deps.warn({ agentId, err: String((err as Error)?.message ?? err).slice(0, 200) }, 'budget.cheaper_refused_unsettled'); }
  };

  return {
    runPass: runBudgetPass,
    runPausedReplies,
    disownPauseOnStop,
    cheaperRefused,
    // No runtime asked at the boot: a record that says RUNNING may be one
    // the restart cut off, which the first reconcile has not put right yet
    // (it is waited for 30 s at most), so its hold waits for a pass.
    recordCutOffPauses: () => recordCutOffPauses(store, (event, detail) => { trace(String(detail.agentId ?? 'admin'))(event, detail); }, () => false),
    billingOf, unpricedModelOf, priceNoteOf, machinePriceNote, chatNoteOf, machineBudgetView,
    setAgentBudget, setMachineBudget, setAgentSpendAlert, setMachineSpendAlert,
    stop: () => { if (replies) clearInterval(replies); },
  };
}
