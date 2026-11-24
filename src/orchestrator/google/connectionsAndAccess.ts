import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { GOOGLE_CLIENT_REF, parseOAuthClient, type ConnectionSyncDeps, type OAuthClient } from './googleConnections.js';
import { createAccessChecks, type AccessChecks } from './accessChecks.js';
import { createClientSecretDelivery, type ClientSecretDelivery } from './clientSecretDelivery.js';
import { createConnectionVault, type ConnectionVault } from './connectionVault.js';
import { createGoogleClient, type GoogleClient } from './googleClient.js';

/**
 * The Google connections and access service (HB-0808): the Google
 * accounts connected here, which agent holds which, and what each
 * agent can reach. Four parts:
 *
 *  - `client` (googleClient.ts): the installation's OAuth client (read,
 *    saved, removed), the consent round-trip's single-use states, and an
 *    account linked when Google sends the person back;
 *  - `delivery` (clientSecretDelivery.ts): a new client secret reaching the
 *    agents that hold the old one, and the pass every ten minutes for those
 *    that were busy or failed;
 *  - `vault` (connectionVault.ts): the caller's connections, a connection
 *    deleted, attached to an agent and detached, an agent's Disconnect, the
 *    accounts an agent's own gog lists, and the pass every ten minutes for
 *    a deleted connection's token still to end;
 *  - `access` (accessChecks.ts): Verify now, one at a time per agent.
 *
 * Built once per process (`registerRoutes` in src/api/routes.ts) and handed
 * to the route file on the shared context (`ctx.google`). The registry calls
 * it too: a start or wake syncs the agent's accounts and looks at what it
 * can reach (`connSyncDeps`). Nothing here knows about HTTP: who is asking,
 * the consent's cookie, the redirect address and the reply's words are the
 * route file's (src/api/googleRoutes.ts). `stop()` ends the two passes'
 * timers.
 *
 * The rules themselves are their own modules, used beyond this feature:
 * googleConnections.ts (the import into gog, its removal, the per-agent
 * turn, the OAuth calls) and accessOverview.ts (the overview and its probe).
 */
export interface ConnectionsAndAccess {
  client: GoogleClient;
  delivery: ClientSecretDelivery;
  vault: ConnectionVault;
  access: AccessChecks;
  /** What googleConnections.ts and accessOverview.ts need to reach an agent on a host. */
  connSyncDeps(hostId: string): ConnectionSyncDeps & { provider: RuntimeProvider };
  /** End the client-secret pass's timer and the vault's: at shutdown. */
  stop(): void;
}

/** What the service needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface GoogleDeps {
  store: Store;
  /** The installation's OAuth client and each connection's refresh token. */
  secrets: SecretStore;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline (with no id: `detail.agentId`'s). */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Google's token, revoke and userinfo calls (`deps.oauthFetch ?? fetch`). */
  oauthFetch: typeof fetch;
  /**
   * The AGENTS.md sync under the agent's busy flag (routes.ts's `syncDocsHeld`,
   * defined further down there, so read when a sync runs). Never rejects.
   */
  syncDocsHeld: (agent: Agent, provider: RuntimeProvider) => Promise<void>;
  /** A log line for a pass that failed. */
  warn: (detail: Record<string, unknown>, msg: string) => void;
  /** How often the client-secret pass and the vault's pass run: 0, never (tests). */
  sweepEveryMs: number;
  /**
   * Tell an owner something to act on, on their chat app (the routes'
   * tellOwner, channels/notify.ts). True only when a chat app took it.
   */
  tellOwner: (ownerId: string, text: string) => Promise<boolean>;
}

/** The parts' shared helpers, built once here. */
export interface GoogleHelpers {
  getOAuthClient: () => Promise<OAuthClient | null>;
  connSyncDeps: ConnectionsAndAccess['connSyncDeps'];
  syncGoogleDocs: (agentId: string) => Promise<void>;
}

export function createConnectionsAndAccess(deps: GoogleDeps): ConnectionsAndAccess {
  const { store, secrets, providerFor, trace, syncDocsHeld } = deps;
  const getOAuthClient = async (): Promise<OAuthClient | null> => {
    const raw = await secrets.get(GOOGLE_CLIENT_REF).catch(() => null);
    return raw ? parseOAuthClient(raw) : null;
  };
  const connSyncDeps = (hostId: string) => ({
    store, secrets, provider: providerFor(hostId),
    log: (e: string, d: Record<string, unknown>) => trace()(e, d), // trace reads agentId from detail
  });
  /** After an attach or detach: AGENTS.md names the accounts the agent holds (HB-0394). A stopped agent gets it at its next start. */
  const syncGoogleDocs = async (agentId: string): Promise<void> => {
    const now = store.getAgent(agentId);
    if (now?.state === 'RUNNING' && now.runtimeRef) await syncDocsHeld(now, providerFor(now.hostId));
  };
  const helpers: GoogleHelpers = { getOAuthClient, connSyncDeps, syncGoogleDocs };
  const delivery = createClientSecretDelivery(deps, helpers);
  const vault = createConnectionVault(deps, helpers);
  return {
    client: createGoogleClient(deps, helpers, delivery),
    delivery,
    vault,
    access: createAccessChecks(deps, helpers),
    connSyncDeps,
    stop: () => { delivery.stop(); vault.stop(); },
  };
}
