import { createHomeIcons, type HomeIcons, type HomeIconsDeps } from './homeIcons.js';
import { createHomeOrder, type HomeOrder, type HomeOrderDeps } from './homeOrder.js';
import { createPlannedAgents, type PlannedAgents } from './plannedAgents.js';

/**
 * The home screen (HB-0808 step 15, part C): the order of an owner's
 * agents and their groups (`order`, homeOrder.ts), their icons (`icons`,
 * homeIcons.ts: picked by the management AI or a keyword table, and ideas
 * for one), and the agents planned for later (`plans`, plannedAgents.ts).
 * Everything is per owner.
 *
 * Built once in `registerRoutes` and on the route context as
 * `ctx.homeScreen`; its routes are in src/api/agents/homeScreenRoutes.ts. Its only
 * state is the icons' two locks (`iconRuns`, `iconIdeaRuns`); no timer.
 * Nothing here knows HTTP.
 */
export interface HomeScreen {
  order: HomeOrder;
  icons: HomeIcons;
  plans: PlannedAgents;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type HomeScreenDeps = HomeOrderDeps & HomeIconsDeps;

export function createHomeScreen(deps: HomeScreenDeps): HomeScreen {
  return { order: createHomeOrder(deps), icons: createHomeIcons(deps), plans: createPlannedAgents(deps) };
}
