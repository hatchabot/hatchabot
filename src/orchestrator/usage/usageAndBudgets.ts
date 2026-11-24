import { createMonthlyBudgets, type MonthlyBudgets, type MonthlyBudgetsDeps } from './monthlyBudgets.js';
import { createRecommended, type Recommended, type RecommendedDeps } from './recommended.js';
import { createUsageReadings, type UsageReadings, type UsageReadingsDeps } from './usageReadings.js';
import { createUsageSampler, type UsageSampler, type UsageSamplerDeps } from './usageSampler.js';

/**
 * The usage and budgets service (HB-0808): what each
 * agent's model calls cost, read in the background, and
 * what Hatchabot does about it. Four parts:
 *
 *  - `sampler` (usageSampler.ts): the usage pass every ten minutes, and the
 *    steps that follow it: the model-change guard, the token steward, the
 *    spike warnings and the budget pass;
 *  - `budgets` (monthlyBudgets.ts): the budget pass (pause, cheaper model,
 *    and their undoing), a paused agent's replies, the budgets and step
 *    alarms an owner sets, and the views and notes beside them;
 *  - `readings` (usageReadings.ts): the cost badges (cached five minutes)
 *    and the fleet's live use;
 *  - `recommended` (recommended.ts): the Recommended list and "Not now".
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.usage`). The registry calls
 * it too: a Stop by a person disowns a budget's pause
 * (`budgets.disownPauseOnStop`; the machines service's runner removal as
 * well). Nothing here knows about HTTP. `stop()` ends the three timers: the
 * usage pass's first run and interval, and the paused replies' sweep.
 *
 * The rules themselves are their own modules, used beyond this feature:
 * sourceUsage.ts (the reading), budgets.ts, tokenWatch.ts and
 * usageAlerts.ts, modelLedger.ts (the guard), compaction.ts (the cap),
 * agentCosts.ts, fleetUsage.ts and recommendations.ts.
 */
export interface UsageAndBudgets {
  sampler: UsageSampler;
  budgets: MonthlyBudgets;
  readings: UsageReadings;
  recommended: Recommended;
  /** End the timers (the usage pass's and the paused replies' sweep): at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type UsageAndBudgetsDeps = Omit<UsageSamplerDeps, 'budgetPass'> & MonthlyBudgetsDeps & UsageReadingsDeps & RecommendedDeps;

export function createUsageAndBudgets(deps: UsageAndBudgetsDeps): UsageAndBudgets {
  const budgets = createMonthlyBudgets(deps);
  const sampler = createUsageSampler({ ...deps, budgetPass: () => budgets.runPass() });
  return {
    sampler,
    budgets,
    readings: createUsageReadings(deps),
    recommended: createRecommended(deps),
    stop: () => { sampler.stop(); budgets.stop(); },
  };
}
