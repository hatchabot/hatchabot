import { createDefaults, type Defaults, type DefaultsDeps } from './defaults.js';
import { createFleetKeys, type FleetKeys, type FleetKeysDeps } from './fleetKeys.js';
import { createFleetSearch, type FleetSearch, type FleetSearchDeps } from './fleetSearch.js';

/**
 * Keys, web search and the machine's defaults (HB-0808 step
 * 15 part A): the settings that are the machine's, not one
 * agent's. Three parts:
 *
 *  - `keys` (fleetKeys.ts): the fleet's Gemini and Brave keys, kept in the
 *    secret store, said to be set or not, shown again to the machine's
 *    owner only, and removed;
 *  - `search` (fleetSearch.ts): the one search watch (webSearch.ts), which
 *    search the fleet uses, its check, the month's searches and their price,
 *    and a real search inside one agent; it owns the watch's ten-minute tick;
 *  - `defaults` (defaults.ts): Defaults for this machine, written to .env
 *    and applied to the agents at once.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.machineSettings`). The
 * manager's own search (mgmtChat's opsWeb) reads the watch. Nothing here
 * knows about HTTP. `stop()` ends the tick's timer.
 */
export interface MachineSettings {
  keys: FleetKeys;
  search: FleetSearch;
  defaults: Defaults;
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type MachineSettingsDeps = FleetSearchDeps & DefaultsDeps & Pick<FleetKeysDeps, 'secrets'>;

export function createMachineSettings(deps: MachineSettingsDeps): MachineSettings {
  const search = createFleetSearch(deps);
  const keys = createFleetKeys({ secrets: deps.secrets, warn: deps.warn, searchKeyChanged: () => search.keyChanged() });
  const defaults = createDefaults(deps);
  return { keys, search, defaults, stop: () => search.stop() };
}
