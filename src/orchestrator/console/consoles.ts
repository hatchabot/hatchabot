import { createAgentBrowsers, type AgentBrowsers, type AgentBrowsersDeps } from './agentBrowsers.js';
import { createConsoleGate, type ConsoleGate, type ConsoleGateDeps } from './consoleGate.js';
import { createSignInPanels, type SignInPanels, type SignInPanelsDeps } from './signInPanels.js';

/**
 * The console and the browser panel (HB-0808): the two ways
 * an owner reaches inside an agent from the app. Three
 * parts:
 *
 *  - `gateway` (consoleGate.ts): who may reach which agent's OpenClaw console
 *    (its owner, or a web-chat guest), where its gateway answers, and what
 *    ends a console request, handshake or open socket (a sign-out, a change
 *    of rights or of runtime, the public address's rules);
 *  - `browsers` (agentBrowsers.ts): each agent's own browser kept in step
 *    with the agents, now and every minute;
 *  - `panels` (signInPanels.ts): "Sign in to a site", the open panels and
 *    what each was let in with, closed once that no longer holds.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route files on the shared context (`ctx.consoles`):
 * src/api/console/consoleRoutes.ts (the proxy, its WebSocket upgrade and the
 * console's own routes) and src/api/console/browserRoutes.ts. The registry calls it
 * too: members and web chat bring the gateway in step (`consoleAccess`), and
 * a start, wake or rebuild sweeps the agent's browser (`browsersNow`).
 * Nothing here knows about HTTP. `stop()` ends the three sweeps.
 */
export interface Consoles {
  gateway: ConsoleGate;
  browsers: AgentBrowsers;
  panels: SignInPanels;
  /** End the timers (the console sockets', the browsers' and the panels' sweeps): at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export type ConsolesDeps = ConsoleGateDeps & AgentBrowsersDeps & SignInPanelsDeps;

export function createConsoles(deps: ConsolesDeps): Consoles {
  const gateway = createConsoleGate(deps);
  const browsers = createAgentBrowsers(deps);
  const panels = createSignInPanels(deps);
  return {
    gateway, browsers, panels,
    stop: () => { gateway.stop(); browsers.stop(); panels.stop(); },
  };
}
