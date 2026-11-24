import { createAgentApps, type AgentApps, type AgentAppsDeps } from './agentApps.js';
import { createDataSources, type DataSources, type DataSourcesDeps } from './dataSources.js';

/**
 * The apps and data sources service (HB-0808): what an
 * agent is given to work with beyond its own files. Two
 * parts:
 *
 *  - `installed` (agentApps.ts): the apps installed in agents (a codebase
 *    with a hatchabot.json), their updates, rollbacks and removal, and the
 *    install that waits for a new agent's setup;
 *  - `dataSources` (dataSources.ts): git repos and folders attached to an
 *    agent, the Test button, and a source's removal.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.apps`). The registry calls
 * it too: setup that finishes and the boot resume run a waiting install
 * (`installed.runPendingApp`), the boot resume settles an app operation with
 * `installed.appDeps`, and the boot's one-time move of waiting secrets reads
 * a manifest with `installed.manifestHere`. Nothing here knows about HTTP.
 *
 * Its state is four locks (two per part) and no timer, so there is no
 * `stop()`.
 */
export interface AppsAndSources {
  installed: AgentApps;
  dataSources: DataSources;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type AppsAndSourcesDeps = AgentAppsDeps & DataSourcesDeps;

export function createAppsAndSources(deps: AppsAndSourcesDeps): AppsAndSources {
  return {
    installed: createAgentApps(deps),
    dataSources: createDataSources(deps),
  };
}
