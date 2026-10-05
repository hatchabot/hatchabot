/**
 * What the PUBLIC address may be asked for (docs/public-access.md has the
 * table this file is the source of).
 *
 * Every route has one class. The gate (publicAccess.ts) reads it for each
 * request that arrives on the public listener, by the route's registered
 * pattern, before the handler runs:
 *
 *   open         no sign-in: the page, the sign-in forms, an invitation.
 *                The route checks its own credential (a password, a code).
 *   second-step  signed in, second factor not yet given: only what the
 *                second-factor screen needs.
 *   signed-in    signed in, and the second factor given (everyone with a
 *                password must have one; Google is a Google account's): the
 *                app as invited people use it.
 *   step-up      as signed-in, and the second factor given again in the last
 *                few minutes: machine-level and dangerous actions.
 *   never        refused at the public address whoever asks.
 *
 * A route no rule names is `never`: a route added later is closed to the
 * internet until someone classifies it here, and test/publicRoutes.test.ts
 * fails until they do.
 */
export type PublicClass = 'open' | 'second-step' | 'signed-in' | 'step-up' | 'never';

export interface PublicRule {
  /** HTTP methods, or '*' for all. */
  methods: readonly string[] | '*';
  /** Matched against the route's registered pattern (e.g. /v1/agents/:id/env). */
  pattern: RegExp;
  cls: PublicClass;
  /** The row of the documentation table this rule belongs to. */
  group: string;
  /**
   * step-up only: a person with no second factor at all passes through to
   * the route, which then asks for its own proof (the current password). For
   * enrolling the first factor, which nothing could otherwise step up to.
   */
  firstFactorOk?: boolean;
  /**
   * With firstFactorOk: this route ADDS a factor. A password alone is not
   * enough for that at the public address (whoever has the password would
   * enrol their own phone); the sign-in must also have just come from a link
   * or a code sent out of band (publicAccess.ts, the pass's `en`).
   */
  enrols?: boolean;
}

const READ = ['GET', 'HEAD'] as const;
const r = (methods: PublicRule['methods'], pattern: RegExp, cls: PublicClass, group: string, extra: Partial<PublicRule> = {}): PublicRule =>
  ({ methods, pattern, cls, group, ...extra });

/** First match wins: the specific rules sit above the general ones. */
export const PUBLIC_RULES: readonly PublicRule[] = [
  // ---- never ---------------------------------------------------------------
  r('*', /^\/v1\/local-accounts\/bootstrap$/, 'never', 'First run: creating the first account'),
  r('*', /^\/v1\/auth\/family-accounts$/, 'never', 'First run: creating the first account'),
  r('*', /^\/v1\/agents\/:id\/message$/, 'never', 'Agent-to-agent calls (agents reach Hatchabot inside the machine)'),
  r('*', /^\/v1\/connections\/google\/(callback|start)$/, 'never', 'Connecting a Google account (the consent comes back to the private address)'),
  r('*', /^\/app-qr\.svg$/, 'never', 'The private address as a QR code'),
  r('*', /^\/v1\/tailscale(\/.*)?$/, 'never', 'Tailscale set-up (private address, HTTPS, links)'),
  r('*', /^\/v1\/public-access\/on$/, 'never', 'Turning public access on'),
  r('*', /^\/v1\/(agents\/preflight|agents\/restore)$/, 'never', 'Another Hatchabot moving an agent here (token calls; tokens are refused at the public address)'),
  r('*', /^\/v1\/peers(\/.*)?$/, 'never', 'Linking another Hatchabot'),
  r('*', /^\/v1\/second-factor\/reset\/:id$/, 'never', 'Resetting someone\'s second factor'),

  // ---- open ----------------------------------------------------------------
  r(READ, /^\/$/, 'open', 'The app page and its static files'),
  r(READ, /^\/(healthz|manifest\.webmanifest|sw\.js|privacy|terms)$/, 'open', 'The app page and its static files'),
  r(READ, /^\/icons\/:name$/, 'open', 'The app page and its static files'),
  r(READ, /^\/v1\/config$/, 'open', 'What the sign-in screen needs'),
  r(['POST'], /^\/v1\/(login|session|logout)$/, 'open', 'Sign-in and sign-out'),
  r(READ, /^\/signin\/link$/, 'open', 'One-time sign-in links (hosted installs)'),
  r(READ, /^\/join\/:code$/, 'open', 'Invitations to an agent (the code is the credential)'),
  r(READ, /^\/v1\/invites\/:code$/, 'open', 'Invitations to an agent (the code is the credential)'),
  r(['POST'], /^\/v1\/join$/, 'open', 'Invitations to an agent (the code is the credential)'),
  r([...READ, 'POST'], /^\/v1\/local-accounts\/claim$/, 'open', 'Account invitations and password reset links (the code is the credential; never the machine owner\'s first claim)'),
  r(['POST'], /^\/v1\/local-accounts\/(recover|recover-with-code)$/, 'open', 'Forgotten password (Telegram link, recovery code)'),

  // ---- second-step ---------------------------------------------------------
  r(READ, /^\/v1\/second-factor$/, 'second-step', 'The second-factor screen'),
  r(['POST'], /^\/v1\/second-factor\/(challenge|verify)$/, 'second-step', 'The second-factor screen'),

  // ---- step-up: second-factor and account management ------------------------
  r('*', /^\/v1\/second-factor\/(totp|totp\/confirm|passkey\/options|passkey|backup-codes)$/, 'step-up', 'Adding or replacing a second factor', { firstFactorOk: true, enrols: true }),
  r(['DELETE'], /^\/v1\/second-factor\/:id$/, 'step-up', 'Removing a second factor'),
  r(['POST'], /^\/v1\/local-accounts$/, 'step-up', 'Managing accounts (add, remove, reset links)'),
  // Your own password and recovery code: the routes ask for the current
  // password themselves, so someone with no second factor is let through to
  // that check (a member without one could otherwise never change a password
  // here). The owner resetting SOMEONE ELSE's password always has a factor.
  r(['POST'], /^\/v1\/local-accounts\/(:id\/password|me\/recovery-code)$/, 'step-up', 'Changing a password, making a recovery code (your own needs your current password as well)', { firstFactorOk: true }),
  r(['DELETE', 'POST'], /^\/v1\/local-accounts\/:id(\/reset-link)?$/, 'step-up', 'Managing accounts (add, remove, reset links)'),
  r(['POST'], /^\/v1\/security\/sign-out\/:ownerId$/, 'step-up', 'Signing someone else out everywhere'),
  r('*', /^\/v1\/public-access(\/(off|invited-only|guests|qr\.svg))?$/, 'step-up', 'Public access: status, its address, and turning it off'),
  r(READ, /^\/v1\/security\/log$/, 'step-up', 'The security record'),

  // ---- step-up: credentials ------------------------------------------------
  r(['POST'], /^\/v1\/cli-tokens$/, 'step-up', 'Minting a command-line token'),
  r(READ, /^\/v1\/ai-profiles\/:id\/credential$/, 'step-up', 'Revealing a stored credential (AI source, bot token, search and media keys)'),
  r(READ, /^\/v1\/agents\/:id\/bot-token$/, 'step-up', 'Revealing a stored credential (AI source, bot token, search and media keys)'),
  r(READ, /^\/v1\/bots\/:username\/token$/, 'step-up', 'Revealing a stored credential (AI source, bot token, search and media keys)'),
  r(READ, /^\/v1\/(media|search)-key\/reveal$/, 'step-up', 'Revealing a stored credential (AI source, bot token, search and media keys)'),
  r(READ, /^\/v1\/agents\/:id\/gateway$/, 'step-up', 'Revealing a stored credential (AI source, bot token, search and media keys)'),
  r(['POST', 'PATCH', 'DELETE'], /^\/v1\/ai-profiles(\/:id(\/(adopt-agents|migrate-agents|apply-default-model|move))?)?$/, 'step-up', 'Changing AI sources (they hold credentials)'),
  r(['PUT', 'DELETE'], /^\/v1\/(media|search)-key$/, 'step-up', 'Changing the search and media keys'),
  r(['PUT', 'DELETE'], /^\/v1\/google-oauth\/client$/, 'step-up', 'Changing the Google OAuth client'),

  // ---- step-up: the machine ------------------------------------------------
  r(['POST', 'DELETE', 'PUT', 'PATCH'], /^\/v1\/hosts(\/.*)?$/, 'step-up', 'Hosts and runners (add, remove, drain, install an image)'),
  r(READ, /^\/v1\/hosts\/:id\/ping$/, 'step-up', 'Hosts and runners (add, remove, drain, install an image)'),
  r('*', /^\/v1\/runner-setup$/, 'step-up', 'Runner set-up script'),
  r(['POST', 'DELETE', 'PUT', 'PATCH'], /^\/v1\/images(\/.*)?$/, 'step-up', 'Images (build, rebuild, delete, promote)'),
  r(['POST', 'DELETE', 'PUT', 'PATCH'], /^\/v1\/runtime(\/.*)?$/, 'step-up', 'Images (build, rebuild, delete, promote)'),
  r(['PUT'], /^\/v1\/(machine-defaults|rebuild-policy|rebuild-concurrency|embed-default)$/, 'step-up', 'Machine settings (defaults, rebuild policy, memory search)'),
  r(['PUT'], /^\/v1\/budgets\/machine$/, 'step-up', 'Machine settings (defaults, rebuild policy, memory search)'),
  r(['PUT'], /^\/v1\/spend-alert\/machine$/, 'step-up', 'Machine settings (defaults, rebuild policy, memory search)'),
  r(['POST', 'DELETE'], /^\/v1\/(embedder|embed)\/.*$/, 'step-up', 'Machine settings (defaults, rebuild policy, memory search)'),
  r(['POST', 'DELETE'], /^\/v1\/backups(\/.*)?$/, 'step-up', 'Backups (run, restore, delete) and downloads of an agent'),
  r(READ, /^\/v1\/agents\/:id\/(backup|export|fs\/archive)$/, 'step-up', 'Backups (run, restore, delete) and downloads of an agent'),
  r(['POST'], /^\/v1\/agents\/(import|:id\/restore|:id\/snapshots\/:snapId\/restore)$/, 'step-up', 'Backups (run, restore, delete) and downloads of an agent'),
  r(['POST', 'DELETE'], /^\/v1\/agents\/:id\/env(\/:envId)?$/, 'step-up', 'An agent\'s environment variables'),
  // The Files tab reads and writes the agent's whole home: its config and tokens are there.
  r('*', /^\/v1\/agents\/:id\/fs(\/file)?$/, 'step-up', 'An agent\'s Files tab (its home holds its config and tokens)'),
  r(['POST', 'PATCH', 'DELETE'], /^\/v1\/agents\/:id\/data-sources(\/:dsId)?$/, 'step-up', 'Folders of this machine given to an agent, and bringing in workspaces'),
  r('*', /^\/v1\/(workspaces\/(inspect|scan-paths)|openclaw\/(agents|quiesce)|agents\/:id\/adopt-workspace)$/, 'step-up', 'Folders of this machine given to an agent, and bringing in workspaces'),
  r(['POST'], /^\/v1\/agents\/:id\/(move-host|rehost)$/, 'step-up', 'Moving an agent to another machine'),
  r(['POST'], /^\/v1\/ops-agent$/, 'step-up', 'Creating the management agent'),
  r(['POST', 'DELETE'], /^\/v1\/pool(\/.*)?$/, 'step-up', 'Bot pools (they hold bot tokens)'),
  r(['POST', 'DELETE'], /^\/v1\/(discord-bots|slack-apps)(\/.*)?$/, 'step-up', 'Bot pools (they hold bot tokens)'),
  r(['POST'], /^\/v1\/agents\/:id\/(channel-token|channel\/swap|channels\/:kind\/swap|telegram)$/, 'step-up', 'Bot pools (they hold bot tokens)'),
  r(['POST', 'PATCH'], /^\/v1\/agents\/:id\/channels\/:kind$/, 'step-up', 'Bot pools (they hold bot tokens)'),

  // The management agent's change cards: confirming one executes it, and it may be machine-level.
  r(['POST'], /^\/v1\/proposals\/:id\/:verb$/, 'step-up', 'Confirming a change the management agent proposed'),

  // ---- signed-in -----------------------------------------------------------
  r(['POST'], /^\/v1\/logout\/everywhere$/, 'signed-in', 'Your own account (who am I, sign out everywhere, security notices)'),
  r('*', /^\/v1\/account(\/(telegram|discord))?$/, 'signed-in', 'Your own account (who am I, sign out everywhere, security notices)'),
  r(READ, /^\/v1\/(accounts|users|local-accounts|local-accounts\/me)$/, 'signed-in', 'Your own account (who am I, sign out everywhere, security notices)'),
  r('*', /^\/v1\/security\/(notices|notices\/:id\/seen|devices|posture)$/, 'signed-in', 'Your own account (who am I, sign out everywhere, security notices)'),
  r(READ, /^\/v1\/cli-tokens$/, 'signed-in', 'Command-line tokens: list and revoke'),
  r(['DELETE'], /^\/v1\/cli-tokens\/:id$/, 'signed-in', 'Command-line tokens: list and revoke'),
  r('*', /^\/v1\/agents\/:id\/ui(\/.*)?$/, 'signed-in', 'An agent\'s OpenClaw console (the owner, or a web-chat guest in their own conversation)'),
  r('*', /^\/v1\/agents\/:id\/chat$/, 'signed-in', 'Web chat'),
  r('*', /^\/v1\/agents(\/.*)?$/, 'signed-in', 'Your agents: list, create, settings, files, schedules, members, start and stop'),
  r(READ, /^\/v1\/(recent|costs)$/, 'signed-in', 'Your agents: list, create, settings, files, schedules, members, start and stop'),
  r('*', /^\/v1\/(agent-classes|agent-todos|agent-peers|groups|inbox|proposals|pending|events|resources|usage|operator-profile)(\/.*)?$/, 'signed-in', 'Your agents: list, create, settings, files, schedules, members, start and stop'),
  r(READ, /^\/v1\/(ai-profiles|ai-profiles\/usage|ai-profiles\/:id\/available-models)$/, 'signed-in', 'Reading lists and settings (no credential is shown)'),
  r(['POST'], /^\/v1\/ai-profiles\/usage\/sample$/, 'signed-in', 'Reading lists and settings (no credential is shown)'),
  r(READ, /^\/v1\/(model-scorecard|model-options|model-changes|model-prices|token-health|token-incidents|budgets)$/, 'signed-in', 'Reading lists and settings (no credential is shown)'),
  r(READ, /^\/v1\/(hosts|images|images\/:name\/log|runtime|runtime\/build|runtime\/capabilities|runtime\/images|runtime\/images\/:tag\/history|backups|bots|bot-inventory|pool|discord-bots|slack-apps|connections|channels\/connectors|channels\/slack\/manifest|machine-defaults|rebuild-policy|rebuild-concurrency|embed-default|embedder|embedder\/guests|media-key|search-key|google-oauth\/client|ops-agent)$/, 'signed-in', 'Reading lists and settings (no credential is shown)'),
  r(['POST'], /^\/v1\/ops-agent\/suggest$/, 'signed-in', 'Reading lists and settings (no credential is shown)'),
  r(['DELETE'], /^\/v1\/connections\/:id$/, 'signed-in', 'Removing a Google connection'),
];

/** The rule that names this route, if any. `pattern` is the route's registered URL. */
export function publicRuleFor(method: string, pattern: string | undefined): PublicRule | undefined {
  if (!pattern) return undefined;
  const m = method.toUpperCase();
  return PUBLIC_RULES.find((rule) => (rule.methods === '*' || rule.methods.includes(m)) && rule.pattern.test(pattern));
}

/**
 * What a CHAT-ONLY GUEST let in without a second factor may ask for (the
 * owner's switch HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR; the
 * definition is store.isChatOnlyGuest). Reads of the signed-in class (each
 * route still shows only what is theirs, which is nothing but the agents they
 * chat with), and these writes: the chat itself, signing out, and dismissing
 * a notice. Nothing that makes or changes anything: with a password alone
 * they cannot create an agent (whose console is a shell on this machine),
 * link a Telegram account (where a password reset would then be sent), or
 * touch a step-up route.
 */
const GUEST_WRITES: readonly RegExp[] = [
  /^\/v1\/agents\/:id\/ui(\/.*)?$/,
  /^\/v1\/agents\/:id\/chat$/,
  /^\/v1\/logout\/everywhere$/,
  /^\/v1\/security\/notices\/:id\/seen$/,
];
export function guestMay(method: string, pattern: string | undefined): boolean {
  const rule = publicRuleFor(method, pattern);
  if (!rule || rule.cls !== 'signed-in' || !pattern) return false;
  if ((READ as readonly string[]).includes(method.toUpperCase())) return true;
  return GUEST_WRITES.some((re) => re.test(pattern));
}

/** The class the gate enforces: the rule's, or `never` when no rule names the route. */
export function publicClassFor(method: string, pattern: string | undefined): PublicClass {
  return publicRuleFor(method, pattern)?.cls ?? 'never';
}

/** The documentation table's rows: class, what it covers. Generated, so the doc cannot drift from the code. */
export function publicClassTable(): Array<{ cls: PublicClass; group: string }> {
  const seen = new Set<string>();
  const rows: Array<{ cls: PublicClass; group: string }> = [];
  for (const rule of PUBLIC_RULES) {
    const k = `${rule.cls}|${rule.group}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ cls: rule.cls, group: rule.group });
  }
  const order: PublicClass[] = ['open', 'second-step', 'signed-in', 'step-up', 'never'];
  return rows.sort((a, b) => order.indexOf(a.cls) - order.indexOf(b.cls));
}
