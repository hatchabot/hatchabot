import { createHosts, type Hosts, type HostsDeps } from './hosts.js';
import { createImageInstalls, type ImageInstalls, type ImageInstallsDeps } from './imageInstalls.js';
import { createResources, type Resources, type ResourcesDeps } from './resources.js';
import { createRuntimeImages, type RuntimeImages, type RuntimeImagesDeps } from './runtimeImages.js';

/**
 * The machines, runners and images service (HB-0808): the
 * machines this install runs agents on, and the runtime
 * images they run. Four parts:
 *
 *  - `hosts` (hosts.ts): this machine and the runners added to it, listed,
 *    added, drained and removed;
 *  - `installs` (imageInstalls.ts): this machine's runtime image copied onto
 *    a runner (Install image), one copy per runner;
 *  - `resources` (resources.ts): live CPU and memory per agent and per
 *    machine, and the peaks and cap hits an owner clears;
 *  - `images` (runtimeImages.ts): the base image built for an OpenClaw
 *    version, the derived images, and what stops a tag being deleted.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route files on the shared context (`ctx.machines`). The registry
 * calls it too: an agent's page reads its peak and cap hits
 * (`resources.peakSinceClear`, `resources.capHitsSince`). Nothing here knows
 * about HTTP. `stop()` ends the base build under way: its ceiling timer, the
 * only one, and its process group.
 *
 * Adding a runner's key and ssh block, and copying an image onto it, are
 * runnerSetup.ts; probing what an image can do is runtimeCaps.ts; the reason
 * a build failed is buildFailure.ts. Moving an agent between machines
 * (moveHost.ts), a derived image's build (derivedImage.ts) and an image made
 * again on another machine (imageRecipe.ts) are their own modules, used
 * beyond this feature.
 */
export interface Machines {
  hosts: Hosts;
  installs: ImageInstalls;
  resources: Resources;
  images: RuntimeImages;
  /** End the timer (the base build's ceiling): at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type MachinesDeps = HostsDeps & ImageInstallsDeps & ResourcesDeps & RuntimeImagesDeps;

export function createMachines(deps: MachinesDeps): Machines {
  const images = createRuntimeImages(deps);
  const installs = createImageInstalls(deps);
  return {
    hosts: createHosts(deps, installs),
    installs,
    resources: createResources(deps),
    images,
    stop: () => { images.stop(); },
  };
}
