import { createAppAddress, type AppAddress, type AppAddressDeps } from './appAddress.js';
import { createAppConfig, type AppConfig, type AppConfigDeps } from './appConfig.js';
import { createTailscaleSetup, type TailscaleSetup, type TailscaleSetupDeps } from './tailscaleSetup.js';

/**
 * How the app is reached (HB-0808 step 15 part B). Three parts:
 *
 *  - `address` (appAddress.ts): the address to show and the address for
 *    links sent to people, with the tailnet probe that stands in for an
 *    unset HATCHABOT_PUBLIC_URL and its two timers;
 *  - `tailscale` (tailscaleSetup.ts): the machine's tailnet state, `tailscale
 *    serve` turned on, its address written for links, and a QR's address;
 *  - `config` (appConfig.ts): what the sign-in screen and the page read,
 *    masked at the public address (`publicConfigView`).
 *
 * Public access itself (Funnel, the gate, the safeguards) is not here: it is
 * src/api/publicAccess.ts and src/api/machine/reachRoutes.ts. Built once per process
 * (`registerRoutes` in src/api/routes.ts) and on the shared context
 * (`ctx.reach`); every feature that makes a link reads `address`. Nothing
 * here knows about HTTP. `stop()` ends the probe's timers.
 */
export interface Reach {
  address: AppAddress;
  tailscale: TailscaleSetup;
  config: AppConfig;
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type ReachDeps = AppAddressDeps
  & Omit<TailscaleSetupDeps, 'address'>
  & Omit<AppConfigDeps, 'appUrl' | 'linkUrl'>;

export function createReach(deps: ReachDeps): Reach {
  const address = createAppAddress({ ...deps, ...(deps.tailnet?.info ? { tailnetInfo: deps.tailnet.info } : {}) });
  const tailscale = createTailscaleSetup({ ...deps, address });
  const config = createAppConfig({ ...deps, appUrl: address.appUrl, linkUrl: address.linkUrl });
  return { address, tailscale, config, stop: () => address.stop() };
}
