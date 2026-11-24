import { claudePlanAllowed } from '../../config/claudePlan.js';

/**
 * The app's config (HB-0808 step 15 part B): what the sign-in screen and the
 * page read before anything else, and before anyone has signed in (GET
 * /v1/config). At the public address that is anyone on the internet, so
 * `publicConfigView` leaves out what only the household should see.
 *
 * The API key is publishable by design (Google: "API keys for Firebase
 * services do not need to be treated as secrets") — it identifies the
 * project, it doesn't authorise anything on its own.
 */
export interface AppConfig {
  /** The config as a request from the public address (`fromPublic`) or the private one may see it. */
  view(fromPublic: boolean): Record<string, unknown>;
}

export interface AppConfigDeps {
  /** HATCHABOT_AUTH as the server was started with (undefined: password). */
  authMode: () => 'password' | 'accounts' | 'identity' | undefined;
  /** How many password accounts exist. */
  countLocalAccounts: () => number;
  /** Password accounts sign in here: accounts mode, or Google sign-in with them added. */
  localAccountsOn: () => boolean;
  /** Nobody is "on this machine" (a rootless daemon, Docker Desktop): the first account needs the setup code. */
  loopbackIsRemote: () => boolean;
  /** How many rebuilds run at once. */
  rebuildsAtOnce: () => number;
  /** The address the app shows (appAddress.ts), and the one links are made for. */
  appUrl: () => string | undefined;
  linkUrl: () => string | undefined;
}

/**
 * What /v1/config tells someone who has not signed in. At the public address
 * that is anyone on the internet: the private address, the provider's notice
 * and the limits are left out; what the sign-in screen needs stays.
 */
export const publicConfigView = <T extends Record<string, unknown>>(fromPublic: boolean, full: T): Partial<T> => {
  if (!fromPublic) return full;
  const { appUrl: _a, notice: _n, maxAgentsPerAccount: _m, rebuildConcurrency: _r, setupCodeRequired: _s, ...rest } = full as Record<string, unknown>;
  return rest as Partial<T>;
};

export function createAppConfig(deps: AppConfigDeps): AppConfig {
  return {
    view: (fromPublic) => publicConfigView(fromPublic, {
      authMode: deps.authMode() ?? 'password',
      // The page is being read through the public address (decided by the
      // listener it arrived on): it hides what is not available there.
      publicAddress: fromPublic,
      // Managed mode (a hosted Hatchabot): who runs it, where to get help, and a
      // notice to show everyone. The app hides the machine chores that are not
      // the customer's (HTTPS, backups, OpenClaw upgrades) when `managed` is set.
      managed: process.env.HATCHABOT_MANAGED_BY?.trim()
        ? { by: process.env.HATCHABOT_MANAGED_BY.trim(), supportUrl: process.env.HATCHABOT_SUPPORT_URL?.trim() || undefined }
        : undefined,
      // May a Claude plan (setup token / machine login) be added as a source?
      // Not on a hosted Hatchabot unless the provider turned it back on.
      claudePlan: claudePlanAllowed(),
      notice: process.env.HATCHABOT_NOTICE?.trim() || undefined,
      // Accounts mode with an empty roster: the login screen offers to create
      // account #1 instead of asking for credentials nobody has yet.
      needsSetup: deps.authMode() === 'accounts' && deps.countLocalAccounts() === 0,
      // Google sign-in and local accounts can run together: the login screen
      // needs to know whether to offer both.
      localAccounts: deps.localAccountsOn(),
      // Under a rootless daemon or Docker Desktop nobody is "on this machine"
      // (agents share its loopback): the first account needs the setup code
      // even at localhost.
      setupCodeRequired: deps.loopbackIsRemote(),
      // Surfaced so the UI can show "N of M agents" instead of only revealing the
      // ceiling as a 429 at create time. 0 = no limit. Archived agents don't count.
      maxAgentsPerAccount: Number(process.env.HATCHABOT_MAX_AGENTS_PER_ACCOUNT ?? 0),
      /** How many rebuilds run at once, so the app can estimate a fleet-wide one. */
      rebuildConcurrency: deps.rebuildsAtOnce(),
      /** The address /app-qr.svg encodes, so the app can name it beside the code. */
      appUrl: deps.appUrl(),
      /** The address invitation and reset links are made for: the public one while public access is on. */
      linkUrl: deps.linkUrl(),
      /**
       * 2: a bot hand-over (channel-token) marks the step answered until setup
       * takes the token or turns it down, and the same token posted again is
       * answered 202. The CLI tells this server from an older one by it
       * (cli.ts HANDOVER_SAYS).
       */
      handover: 2,
      identity:
        deps.authMode() === 'identity'
          ? {
              projectId: process.env.HATCHABOT_GCP_PROJECT,
              apiKey: process.env.HATCHABOT_IDENTITY_API_KEY,
              googleClientId: process.env.HATCHABOT_GOOGLE_CLIENT_ID,
            }
          : undefined,
    }),
  };
}
