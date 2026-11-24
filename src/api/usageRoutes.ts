import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COST_BANDS, COST_PERIODS, costBadgesOn, costsFor, DEFAULT_COST_PERIOD, isCostPeriod, isSpendRange, spendSeries, SPEND_RANGES, windowPricing } from '../orchestrator/usage/agentCosts.js';
import { MACHINE, MAX_BUDGET, MIN_BUDGET, budgetView, machineTz, monthKey, monthSpend, monthUnpriced, priceGapNote, prevMonth, stepView, suggestBudget, type BudgetView, type StepView } from '../orchestrator/usage/budgets.js';
import { computeUsagePeriod, USAGE_PERIODS, type UsagePeriod } from '../orchestrator/usage/fleetUsage.js';
import { rightSizeSavings } from '../orchestrator/usage/modelLedger.js';
import { modelOption } from '../orchestrator/sources/modelOptions.js';
import { buildScorecard } from '../orchestrator/usage/modelScorecard.js';
import { foldPractice, practiceSummary } from '../orchestrator/usage/practiceUsage.js';
import { CACHE_READ_DEFAULT, CACHE_WRITE_MULTIPLIER, priceList, PRICES_CHECKED, PRICES_SOURCE } from '../orchestrator/usage/pricing.js';
import { summarizeSourceUsage } from '../orchestrator/usage/sourceUsage.js';
import { buildTokenHealth } from '../orchestrator/usage/tokenHealth.js';
import { agentUsage } from '../orchestrator/usage/usage.js';
import { NO_CHAT_NOTE } from '../orchestrator/usage/monthlyBudgets.js';
import { ownerIdOf } from './principal.js';
import { MACHINE_OWNER_ONLY, queryLimit, type RouteContext } from './routeContext.js';

// ---- budgets (budgets.ts, docs/features.md "Budgets") -------------------
const budgetBody = z.object({
  usd: z.number().min(MIN_BUDGET).max(MAX_BUDGET).nullable(),
  atLimit: z.enum(['warn', 'pause', 'cheaper']).optional(),
  why: z.string().max(400).optional(),
});
/**
 * "Tell me every $X" (budgets.ts): a message and an Alerts line each time
 * the month's spend passes the next multiple of `every` (at most one an
 * hour). Counts from now: multiples already passed this month are not told.
 * every null removes it.
 */
const stepBody = z.object({ every: z.number().min(MIN_BUDGET).max(MAX_BUDGET).nullable() });
/**
 * POST /v1/usage/alerts/dismiss (HB-0814): one warning (its agent and time,
 * both non-empty text) or, with neither, all of them.
 */
const DismissAlerts = z.object({ agentId: z.string().min(1).optional(), at: z.string().min(1).optional() });

const withNote = (message: string, note: string) => (note ? `${message} ${note}` : message);
const notesFor = (...notes: string[]) => notes.filter(Boolean).join(' ');
const budgetMessage = (name: string, b: { usd: number; atLimit: string } | null, view?: BudgetView): string => {
  if (!b) return `${name} has no budget now.`;
  const line = `${name}'s budget: $${b.usd} a month, ${b.atLimit === 'pause' ? 'pausing at the limit' : b.atLimit === 'cheaper' ? 'moving to a cheaper model at the limit' : 'warning at 80% and 100%'}.`;
  return view ? `${line} Spent so far this month: $${view.spent.toFixed(2)} (${view.pct}%).` : line;
};
const stepMessageFor = (name: string, every: number | null, v?: StepView) => every === null ? `${name}: no spending alerts now.`
  : `${name}: you hear each time this month's spend passes another $${every}${v ? ` — $${v.spent.toFixed(2)} so far, next at $${v.next}` : ''}.`;

/**
 * Usage, costs and budgets: the routes (HB-0808).
 *
 * Usage (per source, per agent, the fleet's, by period, the spend chart and
 * its history), the cost badges, the price list, the model steward's
 * scorecard, the token steward's evidence and incidents, budgets and
 * "tell me every $X", spike warnings cleared, and Recommended.
 *
 * Each route checks who is asking, reads its request and words the answer;
 * the background pass, the budget rules and their state are the usage and
 * budgets service's (`ctx.usage`, src/orchestrator/usage/): `sampler`,
 * `budgets`, `readings` and `recommended`. No hook.
 */
export function registerUsageRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, providerFor, ownedAgent, ownsLocalHost, runningAgent, ledgerMeta } = ctx;
  const { sampler, recommended } = ctx.usage;
  const { billingOf, unpricedModelOf, priceNoteOf, machinePriceNote, chatNoteOf, machineBudgetView } = ctx.usage.budgets;
  (app as unknown as { runPausedReplies?: () => Promise<void> }).runPausedReplies = ctx.usage.budgets.runPausedReplies;

  // ---- AI-source usage: requests, tokens and rate-limit hits per source -------
  // Sampled in the background from each agent's own logs (see sourceUsage.ts).
  app.get('/v1/ai-profiles/usage', async (req) => ({
    sampledAt: sampler.sampledAt(), sampling: sampler.sampling(),
    sources: summarizeSourceUsage(store, ownerIdOf(req)),
  }));
  app.post('/v1/ai-profiles/usage/sample', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const r = await sampler.sample();
    return { ok: true, result: r, sampledAt: sampler.sampledAt() };
  });

  /**
   * The home screen's cost badges and View by → Cost (agentCosts.ts): what
   * each agent this person sees cost at API prices over the last `days`
   * (7 by default), and as a monthly rate. From the sampler's stored
   * profiles only: no container is read and no agent is woken. One answer
   * per person and window for five minutes. A web-chat guest gets none.
   */
  app.get<{ Querystring: { days?: string; period?: string } }>('/v1/costs', async (req, reply) => {
    // period: the window View by → Cost's pills choose (COST_PERIODS: 1h … 1m),
    // with its bands; days: the older whole-day form (bands of a week's rate).
    const period = req.query.period;
    if (period !== undefined && !isCostPeriod(period)) return reply.code(400).send({ error: `period is one of ${Object.keys(COST_PERIODS).join(', ')}.` });
    if (period !== undefined && req.query.days !== undefined) return reply.code(400).send({ error: 'Give period or days, not both.' });
    const p = period !== undefined ? COST_PERIODS[period]! : req.query.days === undefined ? COST_PERIODS[DEFAULT_COST_PERIOD]! : undefined;
    const days = p ? p.hours / 24 : Number(req.query.days);
    if (!p && (!Number.isInteger(days) || days < 1 || days > 30)) return reply.code(400).send({ error: 'days must be a whole number from 1 to 30.' });
    if (!costBadgesOn()) return { off: true, days, agents: {} };
    const me = ownerIdOf(req);
    const key = period ?? (req.query.days === undefined ? DEFAULT_COST_PERIOD : `d${days}`);
    const { value, at } = ctx.usage.readings.costBadges(me, key, days, period !== undefined ? p!.bands : undefined);
    return {
      days, at: new Date(at).toISOString(), bands: period !== undefined ? p!.bands : COST_BANDS, agents: value,
      ...(period !== undefined ? { period, hours: p!.hours, chipMin: p!.chipMin, suffix: p!.suffix } : {}),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id/usage', async (req, reply) => {
    const agent = runningAgent(req, req.params.id, reply, 'see its usage');
    if (!agent) return reply;
    // Strict: a failed read answered zeros, and the page said "nothing used"
    // for an agent it simply could not read (review, 2026-09-29).
    let u;
    try { u = await agentUsage(providerFor(agent.hostId), agent.runtimeRef!, agent.slug, { strict: true }); }
    catch (err) { return reply.code(502).send({ error: `Couldn't read ${agent.name}'s usage: ${String((err as Error).message ?? err).slice(0, 200)}` }); }
    // Its spike warnings of the last week (usageAlerts.ts); the 8-day slots are the sampler's, not the page's.
    const { recent: _recent, ...rest } = u;
    // "Conversation size now" is the main conversation's (Telegram DM and console) last call;
    // the newest call of ANY session (a scheduled run, a sub-agent) is not it (audit, 2026-10-23).
    const mainNow = u.health?.main?.[agent.slug]?.ctx;
    // Its practice runs count once, and say so (HB-0933): what its own transcripts do not hold of them is added.
    return { ...foldPractice(rest, practiceSummary(store, agent.id)), ...(typeof mainNow === 'number' && mainNow > 0 ? { lastContext: mainNow } : {}), alerts: store.usageAlertsSince(new Date(Date.now() - 7 * 86_400_000).toISOString(), { agentId: agent.id }) };
  });

  // The fleet usage rollup (usageReadings.ts): every RUNNING agent of the caller's, ranked by tokens.
  app.get('/v1/usage', async (req) => ctx.usage.readings.fleetUsage(ownerIdOf(req)));

  // The model steward's two reads (docs/features.md, "Right-size"). Both come
  // from what Hatchabot already holds — no container is asked anything and no
  // sleeping agent is woken — and both are the caller's own: their agents,
  // the sources they may use.
  app.get<{ Querystring: { limit?: string } }>('/v1/model-scorecard', async (req) => {
    return buildScorecard(store, ownerIdOf(req), { limit: queryLimit(req.query?.limit, 40, 100) });
  });
  /**
   * The price list every cost in the app is figured from (pricing.ts): per
   * model, per million tokens, with the date it was checked. Plus the models
   * this person's sources and agents use that have no price (another
   * vendor's) and the local ones (free), so the panel can name them.
   */
  app.get('/v1/model-prices', async (req) => {
    const me = ownerIdOf(req);
    const sources = store.listAIProfiles(me);
    const byId = new Map(sources.map((p) => [p.id, p]));
    const local = new Set<string>(), unpriced = new Set<string>();
    const note = (model: string | undefined, vendor: string | undefined) => {
      if (!model) return;
      if (vendor === 'local') local.add(model);
      else if (!modelOption(model)) unpriced.add(model);
    };
    for (const p of sources) for (const m of [p.model, ...(p.models ?? [])]) note(m, p.vendor);
    for (const a of store.listVisibleAgents(me)) {
      const p = byId.get(a.aiProfileId) ?? store.getAIProfile(a.aiProfileId);
      note(a.model ?? p?.model, p?.vendor);
    }
    return {
      checked: PRICES_CHECKED, source: PRICES_SOURCE,
      cacheWrite: CACHE_WRITE_MULTIPLIER, cacheReadDefault: CACHE_READ_DEFAULT,
      models: priceList(),
      local: [...local].sort(), unpriced: [...unpriced].sort(),
    };
  });

  // ---- the token steward (docs/features.md, "Token steward") ---------------
  /**
   * Token health: per agent of the caller's, conversation size, cache, cost
   * split, scheduled tasks, instruction files, thinking, loop signals, its
   * context cap and open incidents (tokenHealth.ts). Stored data only: no
   * container is asked anything and no agent is woken.
   */
  app.get<{ Querystring: { limit?: string; agent?: string } }>('/v1/token-health', async (req, reply) => {
    const ownerId = ownerIdOf(req);
    const limit = Math.floor(Number(req.query?.limit));
    let agentId: string | undefined;
    if (req.query?.agent) {
      const ref = String(req.query.agent).toLowerCase();
      const hit = store.listAgents(ownerId).find((a) => a.state !== 'DELETED' && (a.id === req.query.agent || a.slug === ref || a.name.toLowerCase() === ref));
      if (!hit) return reply.code(404).send({ error: `No agent of yours called "${req.query.agent}".` });
      agentId = hit.id;
    }
    return buildTokenHealth(store, ownerId, { limit: Number.isFinite(limit) && limit > 0 ? limit : undefined, agentId });
  });
  /** The loops Hatchabot's watcher found: open ones first, then those cleared in the last week (tokenWatch.ts). */
  app.get('/v1/token-incidents', async (req) => {
    const ownerId = ownerIdOf(req);
    const names = new Map(store.listAgents(ownerId).map((a) => [a.id, a.name]));
    // Open ones read on their own: under one limit, 100 newer cleared ones hid an older
    // loop still going (report B09, 2026-10-22).
    const open = store.listTokenIncidents({ ownerId, open: true, limit: 100 });
    const recent = store.listTokenIncidents({ ownerId, sinceIso: new Date(Date.now() - 7 * 86_400_000).toISOString(), limit: 100 }).filter((i) => i.clearedAt);
    const view = (i: (typeof open)[number]) => ({ id: i.id, agent: names.get(i.agentId) ?? '(deleted agent)', agentId: i.agentId, kind: i.kind, text: i.text, ...(i.fix ? { fix: i.fix } : {}),
      count: i.count, ...(i.firstAt ? { since: i.firstAt } : {}), ...(i.lastAt ? { last: i.lastAt } : {}), openedAt: i.openedAt, ...(i.clearedAt ? { clearedAt: i.clearedAt } : {}), told: !!i.toldAt });
    return {
      open: open.map(view),
      recent: recent.map(view),
      notes: ['An incident opens when a loop is still going (its last occurrence within a few hours) and clears itself when it stops. Each is told once on the manager\'s chat. The fixes are cards: compact_agent, set_context_cap, set_cron_enabled, set_peers, rebuild_agent.'],
    };
  });

  /**
   * Budgets: each of the caller's agents with what it spent this month and
   * last, its monthly rate now, a suggested budget, and its budget if it has
   * one; the machine's budget for the machine owner. At API prices (on a
   * Claude plan an equivalent); stored figures only — nothing is woken.
   */
  app.get('/v1/budgets', async (req) => {
    const me = ownerIdOf(req);
    const now = Date.now(), tz = machineTz(), month = monthKey(now, tz);
    const mine = store.listAgents(me).filter((a) => a.state !== 'DELETED' && a.state !== 'DELETING' && a.state !== 'ARCHIVED');
    const ids = mine.map((a) => a.id);
    const spent = monthSpend(store, month, ids), last = monthSpend(store, prevMonth(month), ids);
    const noPrice = monthUnpriced(store, month, ids), noPriceLast = monthUnpriced(store, prevMonth(month), ids);
    // Its pace this week (× 30/7): a change a few days ago (a cap, a compaction, a cheaper model) shows at once.
    const rates = costsFor(store, me, 7, now);
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const agents = mine.map((a) => {
      const b = store.getBudget(a.id);
      const monthly = rates[a.id]?.monthly ?? 0;
      const unpricedModel = unpricedModelOf(a);
      const tokens = Math.round(noPrice.get(a.id) ?? 0), lastTokens = Math.round(noPriceLast.get(a.id) ?? 0);
      const rateUnknown = rates[a.id]?.priced === false || !!unpricedModel;
      const priceNote = priceGapNote({ model: unpricedModel, tokens });
      return {
        id: a.id, name: a.name, ...(a.ops ? { manager: true } : {}), state: a.state, billing: billingOf(a),
        spent: r2(spent.get(a.id) ?? 0), lastMonth: r2(last.get(a.id) ?? 0), monthlyNow: monthly,
        suggested: suggestBudget(monthly),
        ...(unpricedModel || tokens || lastTokens || rateUnknown
          ? { unpriced: { ...(unpricedModel ? { model: unpricedModel } : {}), month: tokens, last: lastTokens, rate: rateUnknown } } : {}),
        ...(priceNote ? { priceNote } : {}),
        ...(chatNoteOf(me, a.id) ? { chatNote: NO_CHAT_NOTE } : {}),
        ...(b ? { budget: budgetView(store, b, spent.get(a.id) ?? 0, now, tz, a.id) } : {}),
        ...(store.getSpendAlert(a.id) ? { alertEvery: stepView(store.getSpendAlert(a.id)!, spent.get(a.id) ?? 0, now, tz) } : {}),
      };
    }).sort((x, y) => y.monthlyNow - x.monthlyNow);
    const machineNote = ownsLocalHost(req) ? machinePriceNote(now) : '';
    const machineChatNote = ownsLocalHost(req) ? chatNoteOf(me) : '';
    return {
      month, tz, agents,
      ...(ownsLocalHost(req) ? { machine: { ...machineBudgetView(now), ...(machineNote ? { priceNote: machineNote } : {}), ...(machineChatNote ? { chatNote: machineChatNote } : {}) } } : {}),
      notes: [
        'A model with no known price (OpenAI\'s and Google\'s have none here) is not $0: such an agent carries unpriced (tokens) and priceNote, its use is left out of the dollars, and a limit or alert cannot be enforced on it.',
        'Dollars at API list prices, the same as the cost badges; on a Claude plan they are an equivalent, not a bill. A month is the calendar month in the machine\'s time zone; spend is read every 10 minutes.',
        'At 80% and at 100% the owner gets a line under Alerts and one message. atLimit "pause" stops the agent at 100% until the 1st (or until the budget is raised, or it is started by hand — then it runs on until the 1st); "cheaper" moves it to the cheapest model its source offers until then (a model changed by hand wins); "warn" only tells. The manager is never paused or moved.',
      ],
    };
  });
  /** One agent's monthly budget (owner only): usd null removes it. */
  app.put<{ Params: { id: string } }>('/v1/agents/:id/budget', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agent.state === 'DELETED') return reply.code(404).send({ error: 'Not found' });
    const parsed = budgetBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: `usd: a number from ${MIN_BUDGET} to ${MAX_BUDGET} (US dollars a month), or null to remove it; atLimit: "warn", "pause" or "cheaper".` });
    const before = store.getBudget(agent.id);
    const atLimit = parsed.data.atLimit ?? before?.atLimit ?? 'warn';
    if (agent.ops && atLimit !== 'warn' && parsed.data.usd !== null) return reply.code(400).send({ error: 'Your Hatchabot agent is never paused or moved to another model by a budget (it is how you manage the others): its budget can only warn.' });
    const meta = ledgerMeta(req, 'budget');
    const { budget: b, view, now } = await ctx.usage.budgets.setAgentBudget(agent, { usd: parsed.data.usd, atLimit, ...(parsed.data.why !== undefined ? { why: parsed.data.why } : {}) }, before, meta);
    return { budget: view ?? null, message: withNote(budgetMessage(`"${agent.name}"`, b ? { usd: b.usd, atLimit: b.atLimit } : null, view), b ? notesFor(priceNoteOf(agent, now), chatNoteOf(agent.ownerId, agent.id)) : '') };
  });
  /** The whole machine's monthly budget (the machine owner only): every agent's spend, any owner's. */
  app.put('/v1/budgets/machine', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const parsed = budgetBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: `usd: a number from ${MIN_BUDGET} to ${MAX_BUDGET} (US dollars a month), or null to remove it; atLimit: "warn", "pause" or "cheaper".` });
    const before = store.getBudget(MACHINE);
    const atLimit = parsed.data.atLimit ?? before?.atLimit ?? 'warn';
    const v = await ctx.usage.budgets.setMachineBudget(ownerIdOf(req), parsed.data.usd, atLimit, ledgerMeta(req, 'budget').by);
    return { ...v, message: withNote(budgetMessage('This Hatchabot', parsed.data.usd === null ? null : { usd: parsed.data.usd, atLimit }, v.budget), parsed.data.usd === null ? '' : notesFor(machinePriceNote(), chatNoteOf(ownerIdOf(req)))) };
  });

  app.put<{ Params: { id: string } }>('/v1/agents/:id/spend-alert', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agent.state === 'DELETED') return reply.code(404).send({ error: 'Not found' });
    const parsed = stepBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: `every: US dollars from ${MIN_BUDGET} to ${MAX_BUDGET}, or null to stop the alerts.` });
    const meta = ledgerMeta(req, 'budget');
    const { view: v, now } = ctx.usage.budgets.setAgentSpendAlert(agent, parsed.data.every, meta);
    return { alertEvery: v ?? null, message: withNote(stepMessageFor(`"${agent.name}"`, parsed.data.every, v), parsed.data.every === null ? '' : notesFor(priceNoteOf(agent, now), chatNoteOf(agent.ownerId, agent.id))) };
  });
  app.put('/v1/spend-alert/machine', async (req, reply) => {
    if (!ownsLocalHost(req)) return reply.code(403).send({ error: MACHINE_OWNER_ONLY });
    const parsed = stepBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: `every: US dollars from ${MIN_BUDGET} to ${MAX_BUDGET}, or null to stop the alerts.` });
    const { view: v, now } = ctx.usage.budgets.setMachineSpendAlert(ownerIdOf(req), parsed.data.every, ledgerMeta(req, 'budget').by);
    return { alertEvery: v ?? null, message: withNote(stepMessageFor('This Hatchabot', parsed.data.every, v), parsed.data.every === null ? '' : notesFor(machinePriceNote(now), chatNoteOf(ownerIdOf(req)))) };
  });

  /**
   * Clear spike warnings from Usage (and the agent's Usage tab): one — its
   * agent and time — or all of this person's. They were told when they
   * happened; this only takes them off the page (2026-10-05).
   */
  app.post('/v1/usage/alerts/dismiss', async (req, reply) => {
    const ownerId = ownerIdOf(req);
    const parsed = DismissAlerts.safeParse(req.body ?? {});
    // Anything given must be a real id and time: a malformed one is refused,
    // never read as "neither", which clears every warning (#180).
    const b = parsed.success ? parsed.data : undefined;
    const all = !!b && b.agentId === undefined && b.at === undefined;
    if (!all && !(b?.agentId && b.at)) return reply.code(400).send({ error: 'Give both agentId and at for one warning, or neither for all of them.' });
    const one = all ? undefined : { agentId: b!.agentId!, at: b!.at! };
    const cleared = store.dismissUsageAlerts(ownerId, new Date().toISOString(), one);
    return { cleared };
  });

  /**
   * Recommended (recommendations.ts, docs/recommendations-design.md): one
   * ranked list of the cost, model and token advice, one item per cause, each
   * with its evidence, expected effect and the button that does it. The
   * machine owner's list includes the machine's own budget. Stored data only.
   */
  app.get('/v1/recommendations', async (req) => recommended.list(ownerIdOf(req), ownsLocalHost(req)));
  app.get<{ Params: { id: string } }>('/v1/agents/:id/recommendations', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent) return reply.code(404).send({ error: 'Not found' });
    return recommended.forAgent(ownerIdOf(req), ownsLocalHost(req), agent.id);
  });
  /** "Not now": the item stays away until its cause changes (a new loop, month, size …). A spike's warning is cleared with it. */
  app.post<{ Params: { id: string } }>('/v1/recommendations/:id/dismiss', async (req, reply) => {
    const it = recommended.dismiss(ownerIdOf(req), ownsLocalHost(req), req.params.id);
    if (!it) return reply.code(404).send({ error: 'That recommendation is gone — its cause has changed or ended.' });
    return { ok: true, id: it.id };
  });

  /**
   * Spend over time at API prices, part by part (new input, cache writes,
   * cache reads, output), with the tokens behind it: the Usage chart for all
   * of the caller's agents, or one of them (?agent=id). From the sampler's hour
   * buckets: nothing is read from a container.
   */
  app.get<{ Querystring: { range?: string; agent?: string; agents?: string; source?: string; tz?: string } }>('/v1/usage/spend', async (req, reply) => {
    const range: unknown = req.query?.range ?? 'week';
    // Its own names only: ?range=constructor passed `in` and hung the service (audit #061).
    if (!isSpendRange(range)) return reply.code(400).send({ error: `range is one of ${Object.keys(SPEND_RANGES).join(', ')}.` });
    let agentId: string | undefined;
    if (req.query?.agent) {
      const a = ownedAgent(req, String(req.query.agent));
      if (!a) return reply.code(404).send({ error: 'Not found' });
      agentId = a.id;
    }
    // ?agents=id,id: a combination of the caller's own agents (the chart's picker); none of theirs = all.
    const agentIds = req.query?.agents ? String(req.query.agents).split(',').map((x) => x.trim()).filter((id) => ownedAgent(req, id)) : undefined;
    // ?source=<AI source id>: only the caller's agents on that source (Settings → AI); another account's agents never count.
    const sourceId = req.query?.source ? String(req.query.source) : undefined;
    // ?tz=<the page's zone>: day slices start at the viewer's midnight; one this machine does not know, its own.
    const asked = String(req.query?.tz ?? '').slice(0, 64);
    let tz = machineTz();
    try { if (asked) { new Intl.DateTimeFormat('en-US', { timeZone: asked }); tz = asked; } } catch { /* not a zone: the machine's */ }
    return spendSeries(store, ownerIdOf(req), range, { agentId, agentIds, sourceId, tz });
  });

  /** The fleet's use in the last hour, 3/6/9/12 hours, day or week, from what the sampler recorded — answers at once. */
  app.get<{ Querystring: { period?: string } }>('/v1/usage/periods', async (req, reply) => {
    const period = String(req.query?.period ?? 'day');
    if (!(USAGE_PERIODS as string[]).includes(period)) return reply.code(400).send({ error: `period must be one of ${USAGE_PERIODS.join(', ')}` });
    const ownerId = ownerIdOf(req);
    // Spike warnings of the last week, newest first, with the agent's name (usageAlerts.ts).
    const alerts = store.usageAlertsSince(new Date(Date.now() - 7 * 86_400_000).toISOString(), { ownerId })
      .map((x) => ({ ...x, name: store.getAgent(x.agentId)?.name ?? 'an agent' }));
    // Right-size: what the cheaper switches saved this month (modelLedger.ts); one line on the page.
    let rightSize: { line: string; savingUSD: number; apiUSD: number; planUSD: number; month: string; rows: Array<Record<string, unknown>> } | undefined;
    try {
      const rs = rightSizeSavings(store, ownerId);
      // Each switch: Usage shows them as "Saved by cheaper models" (2026-10-05).
      if (rs.line) rightSize = { line: rs.line, savingUSD: rs.savingUSD, apiUSD: rs.apiUSD, planUSD: rs.planUSD, month: rs.month,
        rows: rs.rows.map((r) => ({ agentId: r.agentId, agent: r.agent, from: r.from, to: r.to, since: r.since, ...(r.until ? { until: r.until } : {}), billing: r.billing, isUSD: r.isUSD, wasUSD: r.wasUSD, savingUSD: r.savingUSD })) };
    } catch (err) { app.log.warn({ err: String(err) }, 'model.savings_failed'); }
    // At API prices, part by part, for every agent of theirs (plan agents as an equivalent): agentCosts.ts windowPricing.
    const PERIOD_HOURS: Record<string, number> = { hour: 1, '3h': 3, '6h': 6, '9h': 9, '12h': 12, day: 24, week: 168 };
    let pricing: ReturnType<typeof windowPricing> | undefined;
    try { pricing = windowPricing(store, ownerId, PERIOD_HOURS[period] ?? 24); } catch (err) { app.log.warn({ err: String(err) }, 'usage.pricing_failed'); }
    return { ...computeUsagePeriod(store, ownerId, period as UsagePeriod, Date.now(), (id) => pricing?.agents[id]?.cost), sampledAt: sampler.sampledAt(), alerts, ...(rightSize ? { rightSize } : {}), ...(pricing ? { pricing } : {}) };
  });

  /** Daily fleet-usage snapshots for the trend chart, oldest → newest, with a
   *  day-over-day delta (cumulative counter, so the delta approximates that
   *  day's consumption; a session reset can make it dip, hence never negative). */
  app.get('/v1/usage/history', async (req) => {
    const snaps = store.listUsageSnapshots(ownerIdOf(req), 30);
    let prev: number | undefined;
    const points = snaps.map((s) => {
      const delta = s.usedTokens ?? (prev === undefined ? undefined : Math.max(0, s.totalTokens - prev));
      prev = s.totalTokens;
      return { day: s.day, totalTokens: s.totalTokens, delta, byBilling: s.byBilling, costHigh: s.costHigh };
    });
    return { points };
  });
}
