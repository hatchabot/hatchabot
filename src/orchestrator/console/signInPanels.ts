import type { Agent } from '../../domain/types.js';
import type { Store } from '../../store/store.js';
import { siteOf } from './browserLogins.js';
import { BrowserPanels } from './browserPanel.js';

/**
 * "Sign in to a site" (HB-0680, HB-0808): the owner sees the agent's browser
 * and clicks and types in it (browserPanel.ts). The agent's owner only: never
 * a guest, another member or the manager. A panel lasts until it is closed,
 * ten minutes pass with no input, or the browser goes (the agent stops or
 * restarts).
 *
 * This holds the open panels and what each was let in with (`panelAccess`:
 * the browser session, at the public address the pass), and closes a panel
 * once that no longer holds (`revalidatePanels`): after each request that
 * changed something, when its browser signs out (`signedOut`), and every 30
 * seconds. The routes (src/api/browserRoutes.ts) read the request and word
 * the answer.
 */
export interface SignInPanels {
  /** Every open panel (one per agent). */
  panels: BrowserPanels;
  /** The browser session (and at the public address the pass) a panel was opened with still lets that owner in. */
  panelSessionValid(access: Omit<PanelAccess, 'id' | 'agent'>, ownerId: string): boolean;
  /** The agent, its browser and the session are still the ones the panel was opened on. */
  panelAccessValid(access: PanelAccess): boolean;
  /** Close each open panel whose access no longer holds. */
  revalidatePanels(): void;
  /** What the open panel of this agent was let in with (the same object: a stream or an input updates it). */
  panelAccessOf(agentId: string): PanelAccess | undefined;
  /** Remember what a new panel of this agent was let in with. */
  rememberPanel(agentId: string, access: PanelAccess): void;
  /** A panel being opened for a browser session: `revoked` once that session signs out; `done` when the open has answered. */
  pendingPanelOpen(session: string | undefined): { revoked(): boolean; done(): void };
  /** That browser session signed out: its panels being opened are refused, and its open panels close. */
  signedOut(ended: string | undefined): void;
  /** End the 30-second sweep: at shutdown. */
  stop(): void;
}

/** What a panel was let in with. */
export type PanelAccess = {
  id: string; agent: Agent; cookie: string | undefined; https: boolean; public: boolean; lastActive: number;
};

/** What the panels need from the process they run in. Functions only, so a test hands them fakes. */
export interface SignInPanelsDeps {
  store: Store;
  trace: (agentId: string) => (event: string, detail: Record<string, unknown>) => void;
  /** A sign-in that reads a browser's cookie is in place (route fixtures with no auth have none). Read at each call. */
  cookieSignIn: () => boolean;
  /** Who a browser's Cookie header signs in as, by the sign-in in use (auth.ts). Read at each call. */
  signedInAs: (cookie: string | undefined, https: boolean) => { ownerId: string } | undefined;
  /** The public gate (publicAccess.ts), when it is set up: its word on a connection open at the public address. Read at each call. */
  publicGate: () => { refuseOpenSocket(cookie: string | undefined, ownerId: string, lastActive: number): string | undefined } | undefined;
  /** The signed value of the session in a Cookie header (sessionCookie.ts readSessionCookie), or undefined. */
  sessionOf: (cookie: string | undefined, https: boolean) => string | undefined;
}

export function createSignInPanels(deps: SignInPanelsDeps): SignInPanels {
  const { store, trace } = deps;
  const panelAccess = new Map<string, PanelAccess>();
  const pendingPanelOpens = new Set<{ session: string | undefined; revoked: boolean }>();
  const panelSessionValid = (access: Omit<PanelAccess, 'id' | 'agent'>, ownerId: string): boolean => {
    try {
      // This is the app's password-entry panel, so a signed-in browser is
      // required. A bearer alone cannot keep a stream open after revocation.
      // Auth-free route fixtures have no resolver; password mode without a
      // password has one that resolves the local owner without a cookie.
      if (deps.cookieSignIn() && deps.signedInAs(access.cookie, access.https)?.ownerId !== ownerId) return false;
      const publicAccess = deps.publicGate();
      return !access.public || (!!publicAccess && !publicAccess.refuseOpenSocket(access.cookie, ownerId, access.lastActive));
    } catch { return false; }
  };
  const panelAccessValid = (access: PanelAccess): boolean => {
    try {
      const a = store.getAgent(access.agent.id);
      return !!a && a.ownerId === access.agent.ownerId && a.state === 'RUNNING' && !!a.browser && !a.ops
        && a.runtimeRef === access.agent.runtimeRef && a.hostId === access.agent.hostId && a.browserLogins === access.agent.browserLogins
        && panelSessionValid(access, a.ownerId);
    } catch { return false; }
  };
  const panels = new BrowserPanels({
    log: (agentId, e, d) => {
      if (e === 'browser.panel_closed') panelAccess.delete(agentId);
      trace(agentId)(e, d);
    },
    // An agent that keeps its logins lists the sites its panel opened (the host only).
    onUrl: (agentId, url) => {
      const access = panelAccess.get(agentId);
      if (!access || !panelAccessValid(access)) return;
      const a = store.getAgent(agentId);
      const site = siteOf(url);
      if (a?.browserLogins && site) store.noteAgentBrowserSite(agentId, a.browserLogins, site);
    },
  });
  const revalidatePanels = (): void => {
    for (const access of panelAccess.values()) {
      if (!panelAccessValid(access)) panels.get(access.id, access.agent.id, access.agent.ownerId)?.close('access');
    }
  };
  // Private logout forgets only the cookie in that browser, not its signed
  // value on the server. End active and pending panels for that browser.
  const signedOut = (ended: string | undefined): void => {
    for (const pending of pendingPanelOpens) if (ended && pending.session === ended) pending.revoked = true;
    for (const access of panelAccess.values()) if (ended && deps.sessionOf(access.cookie, access.https) === ended) {
      panels.get(access.id, access.agent.id, access.agent.ownerId)?.close('person');
    }
  };
  const panelSweep = setInterval(revalidatePanels, 30_000);
  panelSweep.unref();

  return {
    panels, panelSessionValid, panelAccessValid, revalidatePanels,
    panelAccessOf: (agentId) => panelAccess.get(agentId),
    rememberPanel: (agentId, access) => { panelAccess.set(agentId, access); },
    pendingPanelOpen: (session) => {
      const pending = { session, revoked: false };
      pendingPanelOpens.add(pending);
      return { revoked: () => pending.revoked, done: () => { pendingPanelOpens.delete(pending); } };
    },
    signedOut,
    stop: () => { clearInterval(panelSweep); },
  };
}
