import { randomBytes } from 'node:crypto';
import type { Store } from '../../store/store.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { SecretStore } from '../../secrets/secretStore.js';
import { keyedLock } from '../../util/queues.js';
import { rethrowIfCrash } from '../lifecycle/operations.js';

/**
 * Platform-managed Google connections (docs/connections-design.md, Phase 2 —
 * requested by Chris 2026-09-04 after the chat-driven gog flow proved to be
 * the #1 adoption wall).
 *
 * The control plane owns the OAuth dance: one per-installation OAuth client
 * (created once in the owner's Google console, stored in the SecretStore),
 * a standard browser consent redirect, refresh tokens in the vault. Agents
 * never run the flow — a connection is ATTACHED to an agent and materialized
 * onto its volume with `gog auth import --refresh-token-stdin`, so deriving
 * a child and wiring its Gmail is two clicks, not a console session.
 *
 * What deliberately is NOT here: any automation of the consent click itself.
 * Google requires a human approving access in a real browser; everything
 * around that click is what this module compresses.
 */

/** SecretStore ref for the installation's OAuth client (JSON {clientId, clientSecret}). */
export const GOOGLE_CLIENT_REF = 'google-oauth/client';

/** gog's service names → the scopes the consent screen asks for. */
export const GOOGLE_SERVICES: Record<string, string> = {
  gmail: 'https://mail.google.com/',
  calendar: 'https://www.googleapis.com/auth/calendar',
  drive: 'https://www.googleapis.com/auth/drive',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  docs: 'https://www.googleapis.com/auth/documents',
  contacts: 'https://www.googleapis.com/auth/contacts',
};
export const DEFAULT_SERVICES = ['gmail', 'calendar', 'drive'];

/**
 * One of the services above, by its own name. `s in GOOGLE_SERVICES` also
 * took inherited names: `constructor` passed and put the Object constructor's
 * source into the consent URL's scopes (#173).
 */
export const isGoogleService = (s: unknown): s is string => typeof s === 'string' && Object.hasOwn(GOOGLE_SERVICES, s);

/**
 * Of the services asked for, those whose scope Google granted. The consent
 * screen lets a person untick a scope; the connection used to record every
 * service asked for, and the agents then failed with permission errors on the
 * unticked ones (#174). A token answer without `scope` is taken as granted.
 */
export function grantedServices(requested: string[], scope: string | undefined): { granted: string[]; refused: string[] } {
  if (scope === undefined) return { granted: requested, refused: [] };
  const have = new Set(scope.split(/\s+/).filter(Boolean));
  const granted = requested.filter((s) => isGoogleService(s) && have.has(GOOGLE_SERVICES[s]!));
  return { granted, refused: requested.filter((s) => !granted.includes(s)) };
}

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export function parseOAuthClient(raw: string): OAuthClient | null {
  try {
    const j = JSON.parse(raw) as Partial<OAuthClient>;
    if (typeof j.clientId === 'string' && j.clientId && typeof j.clientSecret === 'string' && j.clientSecret) {
      return { clientId: j.clientId, clientSecret: j.clientSecret };
    }
  } catch { /* malformed */ }
  return null;
}

/** The consent URL a browser is sent to. `state` binds the callback to the initiator. */
export function googleAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  services: string[],
): string {
  const scopes = ['openid', 'email', ...services.filter(isGoogleService).map((s) => GOOGLE_SERVICES[s]!)];
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('access_type', 'offline');
  // Always re-prompt: Google only issues a refresh token on the FIRST consent
  // unless prompted again — a reconnect without this silently returns no
  // refresh token and the connection dies at the first expiry.
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

/**
 * Exchange the callback code for tokens and identify the account. Throws
 * with a human-usable message; the route turns it into the error page.
 */
export async function exchangeGoogleCode(
  client: OAuthClient,
  redirectUri: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string; email: string; scope?: string }> {
  const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as {
    refresh_token?: string; access_token?: string; scope?: string; error?: string; error_description?: string;
  };
  if (!tokenRes.ok || !tok.access_token) {
    throw new Error(`Google refused the code exchange: ${tok.error_description ?? tok.error ?? tokenRes.status}`);
  }
  if (!tok.refresh_token) {
    throw new Error('Google returned no refresh token — retry the connect (the consent prompt must run fresh).');
  }
  const infoRes = await fetchImpl('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${tok.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const info = (await infoRes.json().catch(() => ({}))) as { email?: string };
  if (!info.email) throw new Error("Couldn't read the account's email from Google.");
  return { refreshToken: tok.refresh_token, email: info.email, scope: typeof tok.scope === 'string' ? tok.scope : undefined };
}

/**
 * The Google Cloud project an OAuth client belongs to: the number its ID
 * starts with (`<project number>-<id>.apps.googleusercontent.com`).
 * Undefined when the ID is not recorded or not in that shape.
 */
export function googleProject(clientId: string | null | undefined): string | undefined {
  return /^(\d+)-[A-Za-z0-9]+\.apps\.googleusercontent\.com$/.exec(clientId ?? '')?.[1];
}

/**
 * Whether two connections of one Google account share a grant, so revoking
 * one's token ends the other's too. Google revokes per project, every client
 * of it together: the same client, or two of one project, share it; clients
 * of two different projects do not. A project that cannot be told (an ID
 * not recorded, or of another shape) is taken as shared, as every holder
 * was before (HB-0968): revoking would cut the other account off.
 */
export function sameGoogleGrant(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a && b && a === b) return true;
  const pa = googleProject(a), pb = googleProject(b);
  return !pa || !pb || pa === pb;
}

const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/**
 * How a token's cleanup records a secret store that kept Hatchabot's copy
 * once Google's part was done (revoked, gone already, or kept for another
 * connection's grant): the Connections page says that, not "not confirmed
 * at Google" (HB-1336 review).
 */
export const COPY_NOT_DELETED = 'the secret store did not delete it';

/**
 * Whether a 200 to a revoke is Google's own (HB-1345): from the revoke
 * address itself, no redirect followed, with Google's body, empty or a JSON
 * object. A captive portal's or a proxy's page is a 200 too, and ended the
 * cleanup with the token still live at Google.
 */
function revokeAnsweredByGoogle(r: Response, body: string): boolean {
  if (r.status !== 200 || r.redirected || (r.url && r.url !== GOOGLE_REVOKE_URL)) return false;
  if (!body.trim()) return true;
  try {
    const v = JSON.parse(body) as unknown;
    return !!v && typeof v === 'object' && !Array.isArray(v);
  } catch { return false; }
}

/**
 * Revoke a refresh token at Google when a connection is removed from the
 * vault. Ended: Google revoked it (its own 200: revokeAnsweredByGoogle), or
 * answered that it knows no such token (400 `invalid_token`: expired, or
 * revoked already), so nothing is left to end. Anything else (no answer in
 * ten seconds, another refusal, Google's own error, a redirect, or a 200
 * that is not Google's) did not end it, in words for the record (HB-1203).
 */
export async function revokeGoogleToken(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<{ ended: true; already: boolean } | { ended: false; error: string }> {
  let r: Response;
  try {
    r = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      // A redirect is no answer of Google's: followed, a portal's page answered 200.
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ended: false, error: `no answer from Google: ${String((err as Error)?.message ?? err).slice(0, 160)}` };
  }
  // A body cut off part way is no answer: read as empty, a 200 counted as Google's revoke (HB-1345 review).
  let body: string;
  try { body = await r.text(); } catch { return { ended: false, error: 'the answer was cut off' }; }
  if (r.status === 200) {
    if (revokeAnsweredByGoogle(r, body)) return { ended: true, already: false };
    const type = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().slice(0, 60);
    return { ended: false, error: `an answer that was not Google's (200${type ? `, ${type}` : ''}): a captive portal or a proxy in the way?` };
  }
  let code: unknown;
  try { code = (JSON.parse(body) as { error?: unknown } | null)?.error; } catch { code = undefined; }
  if (r.status === 400 && code === 'invalid_token') return { ended: true, already: true };
  return { ended: false, error: `Google answered ${r.status}${typeof code === 'string' ? ` (${code.slice(0, 60)})` : ''}` };
}

/**
 * Short-lived, single-use state tokens for the consent round-trip. In-memory
 * on purpose: a restart mid-consent just means clicking Connect again.
 */
export class OAuthStateJar {
  #jar = new Map<string, { ownerId: string; services: string[]; expires: number; nonce?: string }>();
  /**
   * `nonce` binds the flow to the browser that started it (a cookie the
   * start route sets): without it, whoever finished Google's consent for a
   * state someone else started put THEIR Google account in the starter's
   * vault — one member could capture another's Gmail (night review).
   */
  issue(ownerId: string, services: string[], nonce?: string): string {
    // Occasional sweep so abandoned flows don't accumulate.
    const now = Date.now();
    for (const [k, v] of this.#jar) if (v.expires < now) this.#jar.delete(k);
    // Hard cap on top of the TTL sweep: a looping caller can't grow this
    // unboundedly within the 10-min window — evict oldest first.
    while (this.#jar.size >= 256) this.#jar.delete(this.#jar.keys().next().value!);
    const state = randomBytes(24).toString('base64url');
    this.#jar.set(state, { ownerId, services, expires: now + 10 * 60_000, ...(nonce ? { nonce } : {}) });
    return state;
  }
  consume(state: string, nonce?: string): { ownerId: string; services: string[] } | null {
    const v = this.#jar.get(state);
    this.#jar.delete(state); // single-use either way
    if (!v || v.expires < Date.now()) return null;
    if (v.nonce !== undefined && v.nonce !== nonce) return null;
    return { ownerId: v.ownerId, services: v.services };
  }
}

export interface ConnectionSyncDeps {
  store: Store;
  secrets: SecretStore;
  provider: RuntimeProvider;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

/** Where gog keeps an agent's Google accounts, on its volume: the agent container's GOG_HOME (provision.ts sets it from this). */
export const GOG_HOME = '/home/node/.openclaw/connections/gog';

/**
 * The volume-side plumbing every materialization needs, idempotent: file
 * keyring with its password in a 0600 file, and a gog wrapper in
 * ~/.local/bin (first on login-shell PATH) exporting it — the exact pattern
 * proven live on the condo agent, so `gog …` works in agent shells and cron
 * with no TTY and no per-invocation incantation.
 */
function bootstrapScript(): string {
  return [
    `set -e`,
    `mkdir -p ${GOG_HOME} ~/.local/bin`,
    `if [ ! -f ${GOG_HOME}/keyring_password ]; then head -c 24 /dev/urandom | base64 > ${GOG_HOME}/keyring_password; chmod 600 ${GOG_HOME}/keyring_password; fi`,
    // The wrapper shadows the real binary by PATH order and never recurses
    // (calls the absolute path).
    `printf '%s\\n' '#!/bin/bash' 'export GOG_KEYRING_PASSWORD="$(cat ${GOG_HOME}/keyring_password)"' 'exec /usr/local/bin/gog "$@"' > ~/.local/bin/gog`,
    `chmod 755 ~/.local/bin/gog`,
    `~/.local/bin/gog auth keyring file >/dev/null 2>&1 || true`,
  ].join('\n');
}

/**
 * Materialize one connection into a RUNNING agent's container: the batch
 * below, with one.
 */
export async function materializeConnection(
  deps: ConnectionSyncDeps,
  agent: { id: string; slug: string; runtimeRef: string },
  connectionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const [r] = await materializeConnections(deps, agent, [connectionId]);
  return r!.error === undefined ? { ok: r!.ok } : { ok: r!.ok, error: r!.error };
}

/**
 * An agent's accounts in one exec (one attached, or a new client secret owed
 * to several, HB-0463): the client once, then each account's import, each
 * with a line of its own saying how it went (its number and exit code, never
 * its address or token), so each keeps its own result. An account that
 * cannot be imported (not attached, its token gone) is not in the script.
 *
 * Secrets ride base64 inside the script, which goes over stdin (execShell
 * `secret`), never a command line: `docker exec … bash -c` showed the refresh
 * token and the OAuth client secret to any local user's ps (2026-09-30).
 * Inside, only builtins (echo) and pipes carry them.
 */
export async function materializeConnections(
  deps: ConnectionSyncDeps,
  agent: { id: string; slug: string; runtimeRef: string },
  connectionIds: string[],
): Promise<Array<{ connectionId: string; ok: boolean; error?: string }>> {
  const { store, secrets, provider } = deps;
  const results = new Map<string, { ok: boolean; error?: string }>();
  const answer = () => connectionIds.map((connectionId) => ({ connectionId, ...results.get(connectionId)! }));
  // Only what is attached lands on a volume: a detach, or a delete (which
  // detaches before it lets the agent's turn go), is the record of intent,
  // and no caller may import past it (issue #18, 2026-10-09).
  const attached = new Map(store.listAgentConnections(agent.id).map((a) => [a.connectionId, a]));
  const wanted: Array<{ conn: Connection; noSend: boolean }> = [];
  for (const connectionId of connectionIds) {
    const conn = store.getConnection(connectionId);
    const attach = attached.get(connectionId);
    if (!conn) results.set(connectionId, { ok: false, error: 'no such connection' });
    else if (!attach) results.set(connectionId, { ok: false, error: 'not attached to this agent' });
    else wanted.push({ conn, noSend: !!attach.gmailNoSend });
  }
  if (!wanted.length) return answer();
  // When the client and tokens were read, not when the import ended: a
  // reconnect while a slow import ran left the agent on the old token,
  // stamped as newer than the new consent and so never shown as stale (audit
  // #074). Before the reads, so a secret saved meanwhile counts as not
  // received (HB-0427).
  const readAt = new Date().toISOString();
  const clientRaw = await secrets.get(GOOGLE_CLIENT_REF).catch(() => null);
  const client = clientRaw ? parseOAuthClient(clientRaw) : null;
  if (!client) {
    for (const { conn } of wanted) results.set(conn.id, { ok: false, error: 'Google OAuth client not configured' });
    return answer();
  }
  const ready: AccountImport[] = [];
  (await Promise.all(wanted.map((w) => accountImport(deps, agent.id, w.conn, w.noSend, client)))).forEach((one, k) => {
    if ('error' in one) results.set(wanted[k]!.conn.id, { ok: false, error: one.error });
    else ready.push(one);
  });
  if (!ready.length) return answer();
  // Under the inherited `set -e`, a failed import would stop the rest: each
  // is caught, its output marked with its number (stdout as it comes, stderr
  // once it failed), and its line written. On a line of its own: output
  // that ends without a newline would run into it.
  const script = [
    ...credentialsScript(client),
    'exec 3>&1',
    ...ready.flatMap((one, i) => [
      `rc=0; err=$( { { ${importCommand(one)}; } | sed 's/^/[${i}] /' >&3; exit "\${PIPESTATUS[0]}"; } 2>&1 ) || rc=$?`,
      `if [ "$rc" -ne 0 ]; then printf '%s\\n' "$err" | sed 's/^/[${i}] /' >&2; fi`,
      'echo',
      `echo "IMPORTED ${i} $rc"`,
    ]),
  ].join('\n');
  // A minute for each account, not one default minute for them all; ten at most.
  const timeoutMs = Math.min(60_000 * ready.length, 10 * 60_000);
  const res = await provider.execShell(agent.runtimeRef, script, { secret: true, timeoutMs });
  const rcOf = new Map([...res.stdout.matchAll(/^IMPORTED (\d+) (\d+)$/gm)].map((m) => [Number(m[1]), Number(m[2])]));
  // What no account's number marks: the client's step, or the shell's own.
  const untagged = (text: string) => text.split('\n').filter((l) => l && !/^\[\d+\] /.test(l) && !/^IMPORTED \d+ \d+$/.test(l)).join('\n');
  ready.forEach((one, i) => {
    const rc = rcOf.get(i);
    if (rc === 0) {
      imported(deps, agent.id, one, readAt);
      results.set(one.connectionId, { ok: true });
      return;
    }
    // Only its own lines, stderr before stdout; with none and no line of its
    // own (the script stopped before it, the client refused), what no
    // account's number marks. Never another account's.
    const tagged = (text: string) => text.split('\n').filter((l) => l.startsWith(`[${i}] `)).map((l) => l.slice(`[${i}] `.length)).filter(Boolean).join('\n');
    const own = tagged(res.stderr) || tagged(res.stdout);
    const error = (own || (rc === undefined ? untagged(res.stderr) || untagged(res.stdout) : '') || 'import failed').slice(0, 300);
    deps.log?.('connection.materialize_failed', { agentId: agent.id, email: one.email, error });
    results.set(one.connectionId, { ok: false, error });
  });
  return answer();
}

type Connection = NonNullable<ReturnType<Store['getConnection']>>;
type AccountImport = { connectionId: string; email: string; b64Token: string; noSend: boolean };

/**
 * One attached account, checked for an import: made with this client, its
 * token in the vault, its address safe for a shell line.
 */
async function accountImport(
  deps: ConnectionSyncDeps,
  agentId: string,
  conn: Connection,
  noSend: boolean,
  client: OAuthClient,
): Promise<AccountImport | { error: string }> {
  // A token another client issued fails at Google with this one: say what
  // mends it, rather than import a token that cannot work.
  if (conn.clientId && conn.clientId !== client.clientId) {
    deps.log?.('connection.materialize_failed', { agentId, email: conn.email, error: 'issued by a different OAuth client' });
    return { error: `${conn.email} was connected with a different Google OAuth client — connect it again (⚙ Settings → Connections)` };
  }
  const refreshToken = await deps.secrets.get(conn.secretRef).catch(() => null);
  if (!refreshToken) return { error: 'connection token missing from the vault' };
  // JSON.stringify does NOT neutralize $ / backtick / " for a shell — the
  // email reaches a double-quoted bash context, so validate its shape first
  // (Google-verified emails are safe, but that assumption must not be the
  // only defense; matches dematerializeConnection's gate — audit 2026-09-06).
  if (!isAccountEmail(conn.email)) return { error: 'connection email has an unexpected shape' };
  return { connectionId: conn.id, email: conn.email, b64Token: Buffer.from(refreshToken, 'utf8').toString('base64'), noSend };
}

/** The client's credentials into gog, its secret file gone however the script ends. */
function credentialsScript(client: OAuthClient): string[] {
  // gog expects Google's client_secret.json shape ("installed" works for the
  // web-app client here — gog reads client_id/client_secret from either key).
  const clientJson = JSON.stringify({
    installed: {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      redirect_uris: ['http://localhost'],
    },
  });
  const b64Client = Buffer.from(clientJson, 'utf8').toString('base64');
  return [
    bootstrapScript(),
    `umask 077`,
    // Guarantee the plaintext client_secret is removed on ANY exit — under the
    // inherited `set -e`, a failing `gog auth credentials` would otherwise abort
    // before an explicit rm and leave it on the durable volume (rides backups).
    `trap 'rm -f ${GOG_HOME}/.client_secret.json' EXIT`,
    `echo ${JSON.stringify(b64Client)} | base64 -d > ${GOG_HOME}/.client_secret.json`,
    `~/.local/bin/gog auth credentials ${GOG_HOME}/.client_secret.json >/dev/null`,
  ];
}

/**
 * One account's import. --force: the vault's token is the authority, and gog
 * refuses an email it already holds ("entry already exists … use --force") —
 * every rebuild and wake logged a false failure and a re-consented token never
 * landed (review, 2026-09-29).
 */
function importCommand(one: AccountImport): string {
  return `echo ${JSON.stringify(one.b64Token)} | base64 -d | ~/.local/bin/gog auth import --email "${one.email}" --refresh-token-stdin --no-input --force${one.noSend ? ' --gmail-no-send' : ''}`;
}

/** An import that exited 0: stamped as of when the client and token were read, and gog holds it now (the access overview's last check). */
function imported(deps: ConnectionSyncDeps, agentId: string, one: AccountImport, readAt: string): void {
  deps.store.markConnectionMaterialized(agentId, one.connectionId, readAt);
  deps.store.recordAccessCheck(agentId, 'google', one.email.toLowerCase(), true);
  deps.log?.('connection.materialized', { agentId, email: one.email });
}

/** Only unambiguous mailbox characters, first one alphanumeric: an email goes into a shell line. */
export const isAccountEmail = (email: string): boolean =>
  /^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+$/.test(email) && email.length <= 254;

/**
 * The accounts an agent holds through Hatchabot, for its AGENTS.md: attached
 * and imported at least once. Sorted, so an unchanged list never rewrites the
 * agent's file. Only plain addresses and service names reach a file the model
 * reads as instructions.
 */
export function attachedGoogleAccounts(store: Store, agentId: string): Array<{ email: string; services: string[]; gmailNoSend: boolean }> {
  return store.listAgentConnections(agentId).flatMap((at) => {
    const conn = at.materializedAt ? store.getConnection(at.connectionId) : undefined;
    if (!conn || !isAccountEmail(conn.email)) return [];
    return [{ email: conn.email, services: conn.services.filter((s) => /^[a-z]+$/.test(s)).sort(), gmailNoSend: at.gmailNoSend }];
  }).sort((a, b) => a.email.localeCompare(b.email));
}

export type GmailTestWhy =
  | 'signin' | 'client' | 'blocked' | 'not-held' | 'api-off' | 'permission' | 'no-mailbox'
  | 'busy' | 'google-down' | 'network' | 'keyring' | 'unknown';
export interface GmailTest { ok: boolean; detail: string; why?: GmailTestWhy; messages?: number; unread?: number }

const GOG = `G=~/.local/bin/gog; [ -x "$G" ] || G=gog; "$G"`;

/** What gog 0.22's failure means, from its text and its stable exit codes (`gog exit-codes`). */
export function gmailFailure(text: string, code?: number): GmailTestWhy {
  if (/invalid_grant|expired or revoked/i.test(text)) return 'signin';
  if (/invalid_client|unauthorized_client/.test(text)) return 'client';
  if (/admin_policy_enforced|access_denied|org_internal/.test(text)) return 'blocked';
  if (/not enabled for this OAuth project|accessNotConfigured|has not been used in project/.test(text)) return 'api-off';
  if (/insufficient|SCOPE_INSUFFICIENT/i.test(text) || code === 6) return 'permission';
  if (/Mail service not enabled/i.test(text)) return 'no-mailbox';
  if (/GOG_KEYRING_PASSWORD|no TTY available/.test(text)) return 'keyring';
  if (code === 4 || /^No auth for/m.test(text)) return /^No auth for/m.test(text) ? 'not-held' : 'signin';
  if (code === 7 || /\b429\b|rateLimitExceeded/.test(text)) return 'busy';
  if (code === 8 || /API error \(5\d\d/.test(text)) return 'google-down';
  if (/dial tcp|lookup |i\/o timeout|deadline exceeded|TLS handshake|connection refused|network is unreachable|no route to host/i.test(text)) return 'network';
  return 'unknown';
}

/**
 * Is this agent's Gmail working? Two real calls at Google from inside it, as the
 * agent makes them: the sign-in first, since gog keeps using an access token for
 * up to an hour after the sign-in behind it was revoked; then the inbox's counts,
 * which reads no mail and sends nothing.
 */
export async function testGmail(
  deps: { store: Pick<Store, 'listAgentConnections' | 'getConnection'>; provider: RuntimeProvider },
  agent: { id: string; runtimeRef: string },
  email: string,
): Promise<GmailTest> {
  const lower = email.toLowerCase();
  const attached = deps.store.listAgentConnections(agent.id).flatMap((at) => {
    const c = deps.store.getConnection(at.connectionId);
    return c && c.email.toLowerCase() === lower ? [{ ...at, createdAt: c.createdAt }] : [];
  })[0];
  const failed = (why: GmailTestWhy, raw = ''): GmailTest => {
    const signIn = !attached
      ? 'It was signed in from inside the agent: connect it under ⚙ Settings → Connections and attach it here, or have the agent sign in again.'
      : attached.materializedAt && attached.materializedAt < attached.createdAt
        ? 'The account was connected again since this agent got its sign-in: Disconnect it here and attach it again.'
        : 'Press Connect for the account under ⚙ Settings → Connections, then attach it to this agent again.';
    const detail: Record<GmailTestWhy, string> = {
      signin: `Google no longer accepts this sign-in: it expired or was revoked. ${signIn}`,
      client: 'Google does not accept the OAuth client this sign-in was made with. Check the client under ⚙ Settings → Connections, then connect the account again.',
      blocked: 'Google refused: the administrator of this account does not allow this app.',
      'not-held': 'This agent does not hold this account. Attach it again, or rebuild the agent if it is attached.',
      'api-off': 'The Gmail API is off in the Google Cloud project of your OAuth client. Turn it on there, then test again.',
      permission: 'The sign-in works, but it does not cover Gmail: it was left unticked on Google\'s consent screen. Press Connect for the account again, leave Gmail ticked, and attach it again.',
      'no-mailbox': 'This Google account has no Gmail mailbox.',
      busy: 'Google is limiting requests for this account just now. Try again in a few minutes.',
      'google-down': 'Gmail is having trouble just now. Try again in a few minutes.',
      network: 'This agent could not reach Google. Check this machine\'s internet connection.',
      keyring: 'The agent could not unlock its Google sign-ins. Rebuild it, which sets that up again.',
      unknown: raw ? `Gmail did not answer as expected: ${raw.split('\n')[0]!.slice(0, 200)}` : 'The agent did not answer in time. Try again in a moment.',
    };
    return { ok: false, why, detail: detail[why] };
  };
  const run = (args: string, timeoutMs: number) =>
    deps.provider.execShell(agent.runtimeRef, `${GOG} ${args}`, { timeoutMs }).catch(() => undefined);

  const check = await run('auth list --check --json --no-input', 90_000);
  if (!check) return failed('unknown');
  if (check.code === 127) return failed('not-held');
  let list: unknown;
  try { list = JSON.parse(check.stdout); } catch { list = undefined; }
  const accounts = (list as { accounts?: unknown } | undefined)?.accounts;
  if (Array.isArray(accounts)) {
    const held = (accounts as Array<{ email?: unknown; valid?: unknown; error?: unknown } | null>)
      .find((a) => typeof a?.email === 'string' && a.email.toLowerCase() === lower);
    if (!held) return failed('not-held');
    if (held.valid === false) { const e = String(held.error ?? ''); return failed(gmailFailure(e), e); }
  } else if (check.code !== 0 && gmailFailure(check.stderr, check.code) !== 'unknown') {
    return failed(gmailFailure(check.stderr, check.code));
  }
  // Anything else about the list says nothing of this account: the read below does.
  const read = await run(`gmail labels get INBOX --account "${email}" --json --no-input`, 60_000);
  if (!read) return failed('unknown');
  if (read.code === 127) return failed('not-held');
  if (read.code !== 0) {
    const text = read.stderr || read.stdout;
    return failed(gmailFailure(text, read.code), text);
  }
  let label: { messagesTotal?: unknown; messagesUnread?: unknown } | undefined;
  try { label = (JSON.parse(read.stdout) as { label?: typeof label }).label; } catch { label = undefined; }
  if (typeof label?.messagesTotal !== 'number') return failed('unknown', read.stdout);
  const unread = typeof label.messagesUnread === 'number' ? label.messagesUnread : undefined;
  const n = (x: number) => x.toLocaleString('en-US');
  return {
    ok: true,
    messages: label.messagesTotal,
    ...(unread !== undefined ? { unread } : {}),
    detail: `Gmail works: the sign-in is good, and the inbox answered (${n(label.messagesTotal)} messages${unread !== undefined ? `, ${n(unread)} unread` : ''}). ${attached?.gmailNoSend ? 'Sending is switched off here, and was not tried.' : 'Sending was not tried.'}`,
  };
}

/**
 * What one `gog auth list` showed, as access checks (docs/access-overview-design.md):
 * every account it names is present, and each of `also` it does not name is
 * absent. Emails are kept lower-cased (Google's are case-insensitive).
 */
export function recordGoogleSeen(store: Store, agentId: string, held: string[], also: Iterable<string> = [], at = new Date().toISOString()): void {
  const seen = new Set(held.map((e) => e.toLowerCase()));
  const prior = new Map(store.listAccessChecks(agentId).filter((c) => c.kind === 'google').map((c) => [c.subject, c]));
  const removing = new Set(store.connectionRemovals(agentId).map((e) => e.toLowerCase()));
  for (const e of seen) store.recordAccessCheck(agentId, 'google', e, true, undefined, at);
  for (const e of new Set([...also].map((x) => x.toLowerCase()))) {
    if (!seen.has(e)) store.recordAccessCheck(agentId, 'google', e, false, goneDetail(prior.get(e), removing.has(e), at), at);
  }
}

/**
 * An absent account's detail: "gone <when>" once the agent had it (found
 * there before, or a removal of it ran), kept from the first time it was
 * found gone; nothing for an account it never had. Every connection of the
 * owner's is recorded absent on each look, and without this each one showed
 * as "removed — verified gone" (2026-10-27).
 */
export function goneDetail(prior: { present: boolean | null; detail: string | null } | undefined, removed: boolean, at: string): string | undefined {
  if (prior?.present === false && prior.detail?.startsWith('gone ')) return prior.detail;
  return removed || prior?.present ? `gone ${at}` : undefined;
}

/** The accounts gog holds on the volume, or null when that can't be read. */
export async function gogAccounts(deps: ConnectionSyncDeps, runtimeRef: string): Promise<string[] | null> {
  try {
    const res = await deps.provider.execShell(
      runtimeRef,
      '~/.local/bin/gog auth list --json 2>/dev/null || gog auth list --json 2>/dev/null',
    );
    return res.code === 0 ? gogList(res.stdout) : null;
  } catch {
    return null;
  }
}

/** The emails `gog auth list --json` printed, or null when that is not an answer (gogAccounts says why). */
function gogList(stdout: string): string[] | null {
  try {
    const parsed = JSON.parse(stdout) as { accounts?: unknown } | null;
    if (!parsed || typeof parsed !== 'object') return null;
    // Only a list gog actually gave is an answer. `{}`, a missing key or any
    // other shape is unknown, not "holds nothing": read as empty, it let a
    // failed remove pass as verified and cleared the retry while the
    // credential could still be on the volume. gog 0.22 prints
    // `{"accounts": []}` with none (checked 2026-10-11), so `null` is no
    // answer either.
    if (!Array.isArray(parsed.accounts)) return null;
    // An entry without an email (another gog's shape) is no answer either:
    // dropped, the list read as not naming an account it may well hold, and a
    // failed remove passed as verified (review, 2026-10-22).
    const emails = (parsed.accounts as Array<{ email?: unknown } | null>)
      .map((a) => (a && typeof a === 'object' ? a.email : undefined));
    return emails.every((e): e is string => typeof e === 'string') ? emails : null;
  } catch {
    return null;
  }
}

/**
 * Remove one previously-materialized account from a RUNNING agent. `ok` only
 * when the account is verifiably gone: the remove exited 0, or it failed but
 * gog's own list no longer names the account (never there, or an earlier try
 * already took it). A thrown exec, or a non-zero exit with the account still
 * listed or the list unreadable, is a failure the caller keeps for retry —
 * the volume may still hold the credential (issue #11).
 */
export async function dematerializeConnection(
  deps: ConnectionSyncDeps,
  agent: { id: string; runtimeRef: string },
  email: string,
): Promise<{ ok: boolean; error?: string }> {
  // A shape materialize refuses to write: nothing of ours can be there.
  if (!plainMailbox(email)) return { ok: true };
  let error: string;
  try {
    const res = await deps.provider.execShell(
      agent.runtimeRef,
      `~/.local/bin/gog auth remove --force -- "${email}" 2>/dev/null || gog auth remove --force -- "${email}"`,
    );
    if (res.code === 0) {
      const subject = email.toLowerCase(), at = new Date().toISOString();
      const prior = deps.store.listAccessChecks(agent.id).find((c) => c.kind === 'google' && c.subject === subject);
      deps.store.recordAccessCheck(agent.id, 'google', subject, false, goneDetail(prior, true, at), at);
      deps.store.noteConnectionRemoved(agent.id, email, at);
      deps.log?.('connection.removed_from_agent', { agentId: agent.id, email });
      return { ok: true };
    }
    error = (res.stderr || res.stdout || `gog auth remove exited ${res.code}`).slice(0, 300);
  } catch (err) {
    error = String((err as Error)?.message ?? err).slice(0, 300);
  }
  const held = await gogAccounts(deps, agent.runtimeRef);
  if (held) recordGoogleSeen(deps.store, agent.id, held, [email]);
  if (held && !held.some((e) => e.toLowerCase() === email.toLowerCase())) {
    deps.store.noteConnectionRemoved(agent.id, email);
    deps.log?.('connection.removed_from_agent', { agentId: agent.id, email, alreadyGone: true });
    return { ok: true };
  }
  deps.log?.('connection.remove_failed', { agentId: agent.id, email, error });
  return { ok: false, error };
}

/** An email of the shape materialize writes (it reaches a shell line). */
const plainMailbox = (email: string) => /^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+$/.test(email) && email.length <= 254;
const GOG_LIST_MARK = '--- hatchabot: gog auth list ---';

/**
 * The removals queued for an agent that is not running, done early on its
 * volume, before it starts (HB-1207). A restore re-arms the removal of an
 * account taken off since its copy was made (queueRemovalsSince), and that
 * came off only at the start's sync: for the seconds before it, the
 * restored account could be used. The agent's own image runs its gog
 * wrapper (the keyring's password is on the volume), with no network, and
 * GOG_HOME set as the agent's container has it: without it gog used a store
 * of its own under ~/.config, "removed" the account there and listed none,
 * while the account stayed in GOG_HOME (round 2 review of HB-1207).
 *
 * Only early, never the record: the removal stays queued and the start's
 * sync runs it and confirms it from `gog auth list` as before, so whatever
 * this one-shot says can never leave an account on that the old way took
 * off. A volume with no GOG_HOME of Hatchabot's (no keyring password: no
 * account was ever put there) cannot tell, and nothing is run. In the
 * agent's connection turn. Returns the emails gog no longer lists after it.
 */
export async function removeQueuedOnVolume(
  deps: Pick<ConnectionSyncDeps, 'store' | 'provider' | 'log'>,
  agent: { id: string; runtimeRef: string; image?: string | null },
): Promise<string[]> {
  const { store } = deps;
  return withConnectionLock(agent.id, async () => {
    const attached = new Set(store.listAgentConnections(agent.id).map((a) => store.getConnection(a.connectionId)?.email.toLowerCase()));
    const emails = store.connectionRemovals(agent.id).filter((e) => plainMailbox(e) && !attached.has(e.toLowerCase()));
    if (!emails.length) return [];
    const script = [
      // First: every gog below reads the agent's own store, never ~/.config/gogcli.
      `export GOG_HOME='${GOG_HOME}'`,
      `if [ ! -f "$GOG_HOME/keyring_password" ]; then echo 'no Google accounts kept by Hatchabot on this volume (GOG_HOME has no keyring)' >&2; exit 3; fi`,
      ...emails.map((e) => `{ ~/.local/bin/gog auth remove --force -- "${e}" || gog auth remove --force -- "${e}"; } >/dev/null 2>&1`),
      `printf '%s\\n' '${GOG_LIST_MARK}'`,
      `~/.local/bin/gog auth list --json 2>/dev/null || gog auth list --json 2>/dev/null`,
    ].join('\n');
    let held: string[] | null = null, error = 'gog did not list its accounts';
    try {
      const res = await deps.provider.execShellOnVolume(agent.runtimeRef, script, { image: agent.image ?? undefined });
      const at = res.stdout.lastIndexOf(`${GOG_LIST_MARK}\n`);
      held = res.code === 0 && at >= 0 ? gogList(res.stdout.slice(at + GOG_LIST_MARK.length + 1)) : null;
      if (res.code !== 0) error = (res.stderr || `it ended with code ${res.code}`).slice(0, 300);
    } catch (err) {
      rethrowIfCrash(err);
      error = String((err as Error)?.message ?? err).slice(0, 300);
    }
    // Said, never recorded: the start's sync takes it off and confirms it.
    if (!held) {
      for (const email of emails) deps.log?.('connection.remove_failed', { agentId: agent.id, email, error, beforeStart: true, triedAgainAtStart: true });
      return [];
    }
    const off = emails.filter((email) => !held!.some((h) => h.toLowerCase() === email.toLowerCase()));
    for (const email of emails) {
      deps.log?.(off.includes(email) ? 'connection.removed_from_agent' : 'connection.remove_failed', {
        agentId: agent.id, email, beforeStart: true, triedAgainAtStart: true, ...(off.includes(email) ? {} : { error: 'gog still lists it' }),
      });
    }
    return off;
  });
}

/**
 * A volume put back as a copy made at `since` (a backup restored) holds
 * again what it held then (HB-1085). Each account Hatchabot took off this
 * agent since, and not attached to it now, is queued to come off again at
 * its next sync (a start, wake or rebuild). Without that, a deleted
 * connection is in no vault and no removal: the sync took the account for
 * one the agent connected itself and left it, usable where another
 * owner's grant of the same account keeps its token alive. Returns the
 * emails queued.
 */
export function queueRemovalsSince(store: Store, agentId: string, since: number): string[] {
  const attached = new Set(store.listAgentConnections(agentId).map((a) => store.getConnection(a.connectionId)?.email.toLowerCase()));
  const queued: string[] = [];
  for (const r of store.connectionsRemovedFrom(agentId)) {
    if (!(Date.parse(r.removedAt) >= since) || attached.has(r.email.toLowerCase())) continue;
    store.addConnectionRemoval(agentId, r.email);
    queued.push(r.email);
  }
  return queued;
}

/**
 * Removals are durable (issue #11): callers record the intent with
 * store.addConnectionRemoval(agent, email) BEFORE deleting the attachment or
 * the vault row, so a stopped agent, a failed exec or a later vault deletion
 * can't lose the email the removal needs. This is the live half: on a RUNNING
 * agent it removes the account now and clears the record only when verified;
 * otherwise the record waits for the next start, wake or rebuild
 * (syncConnections). Returns whether the account is verifiably off already.
 */
export async function removeQueuedNow(
  deps: ConnectionSyncDeps,
  agent: { id: string; state?: string; runtimeRef?: string | null },
  email: string,
): Promise<boolean> {
  if (agent.state !== 'RUNNING' || !agent.runtimeRef) return false;
  const r = await dematerializeConnection(deps, { id: agent.id, runtimeRef: agent.runtimeRef }, email);
  if (r.ok) deps.store.clearConnectionRemoval(agent.id, email);
  return r.ok;
}

/**
 * One connection change at a time per agent (issue #16, 2026-10-09). Attach,
 * detach, a deleted connection's removal and syncConnections each read the
 * attachments, then await a docker exec: interleaved, a detach could take the
 * account off and clear its record while an attach's import was still in
 * flight, and the import then put it back with nothing left to undo it. A
 * keyed lock (keyedLock), not the lifecycle lock: these wait their turn (seconds)
 * rather than refuse, and a start or rebuild must not be blocked by them.
 * Process-wide, keyed by agent id, so the routes and provisioning share it.
 */
const connectionChains = keyedLock();
export function withConnectionLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  return connectionChains.run(agentId, fn);
}

/**
 * One change at a time to an owner's Google connections in the vault
 * (HB-0879): an account linked (the code exchanged, its token and row
 * saved) and a delete's last part (checked again, revoked, its token and row
 * deleted). Interleaved, a delete that began first deleted the token and
 * row a reconnect had just saved, after the reconnect said it was
 * connected. A keyed lock (keyedLock) keyed by owner, as withConnectionLock
 * is by agent: these wait their turn (a Google call or two) rather than refuse.
 */
const vaultChains = keyedLock();
export function withVaultTurn<T>(ownerId: string, fn: () => Promise<T>): Promise<T> {
  return vaultChains.run(ownerId, fn);
}

/**
 * One change to a Google grant at a time, across every account: a link's
 * code exchanged and its token and row saved, and a revoke with the judging
 * that comes before it (is any connection here still on the grant?).
 * Google's revoke ends every token of the grant. Another account's consent
 * of the same address, exchanged while a revoke was on its way (up to ten
 * seconds), had its new token ended under it, after it was told
 * "connected"; one saved between the judging and the revoke was not seen.
 * The address is known only once the code is exchanged, and the exchange
 * is what may not overlap the revoke, so this is the installation's turn,
 * not the address's: one key, not one per address. These are a Google call
 * or two each, and people's consents.
 */
const grantChain = keyedLock();
export function withGoogleGrantTurn<T>(fn: () => Promise<T>): Promise<T> {
  return grantChain.run('installation', fn);
}

/**
 * After an import: if the connection was detached meanwhile (by a path
 * outside the lock), take the account off again — unless another attached
 * connection names the same email — and remember it when that fails.
 */
export async function offAgainIfDetached(
  deps: ConnectionSyncDeps,
  agent: { id: string; runtimeRef: string },
  connectionId: string,
  email: string | undefined,
): Promise<boolean> {
  const now = deps.store.listAgentConnections(agent.id);
  if (!email || now.some((x) => x.connectionId === connectionId)) return false;
  if (now.some((x) => deps.store.getConnection(x.connectionId)?.email === email)) return false;
  const r = await dematerializeConnection(deps, agent, email);
  if (!r.ok) deps.store.addConnectionRemoval(agent.id, email);
  return true;
}

/**
 * Provision-time sync (step 7.6): every ATTACHED connection lands on the
 * volume before the agent goes RUNNING. Best-effort per connection — a
 * Google outage must not fail a rebuild; failures are logged and retried on
 * the next provision. Re-running is safe: the import overwrites the entry
 * for that email with the vault's token (--force; without it gog refused
 * every account it already held — review, 2026-09-29).
 */
export function syncConnections(
  deps: ConnectionSyncDeps,
  agentId: string,
  runtimeRef: string,
): Promise<void> {
  return withConnectionLock(agentId, () => syncConnectionsNow(deps, agentId, runtimeRef));
}

async function syncConnectionsNow(
  deps: ConnectionSyncDeps,
  agentId: string,
  runtimeRef: string,
): Promise<void> {
  const agent = deps.store.getAgent(agentId);
  if (!agent) return;
  const attached = deps.store.listAgentConnections(agentId);
  // Judged afresh at each step, not from the list read here: every step
  // awaits a docker exec, and an Attach or a Detach landing meanwhile was
  // undone — a just-detached account imported again from the stale list, a
  // just-attached one removed as unattached (concurrency review, 2026-10-09).
  const emailOf = new Map(attached.map((a) => [a.connectionId, deps.store.getConnection(a.connectionId)?.email]));
  const attachedEmailsNow = () => new Set(
    deps.store.listAgentConnections(agentId).map((a) => deps.store.getConnection(a.connectionId)?.email).filter((e): e is string => !!e),
  );
  const stillAttached = (connectionId: string) => deps.store.listAgentConnections(agentId).some((x) => x.connectionId === connectionId);
  // Reconcile FIRST: pull off any platform account this agent still has
  // materialized but is no longer attached to — e.g. it was detached while the
  // agent was STOPPED, so the live detach never ran and the credential would
  // otherwise outlive the attachment across a rebuild. Scope strictly to the
  // owner's own vault emails, so an account the AGENT self-connected in chat
  // (not a platform connection) is never touched (audit 2026-09-08).
  // Connections deleted while this agent was down: gone from the vault, so
  // the vault check below no longer knows them (night review, 2026-09-28).
  // A record is cleared only once the account is verifiably off the volume,
  // or when the same account was deliberately attached again (then it stays
  // and is re-imported below). A failure keeps it for the next sync (#11).
  for (const email of deps.store.connectionRemovals(agentId)) {
    if (attachedEmailsNow().has(email)) {
      deps.store.clearConnectionRemoval(agentId, email);
      continue;
    }
    const r = await dematerializeConnection(deps, { id: agentId, runtimeRef }, email);
    if (r.ok) deps.store.clearConnectionRemoval(agentId, email);
  }
  try {
    const vaultEmails = new Set(deps.store.listConnections(agent.ownerId).map((c) => c.email));
    const res = await deps.provider.execShell(runtimeRef, 'gog auth list --json 2>/dev/null || true');
    const parsed = JSON.parse(res.stdout) as { accounts?: Array<{ email?: string }> };
    for (const acc of parsed.accounts ?? []) {
      const email = acc.email;
      if (email && vaultEmails.has(email) && !attachedEmailsNow().has(email)) {
        // A failure is remembered, so deleting the vault entry later can't lose the email.
        const r = await dematerializeConnection(deps, { id: agentId, runtimeRef }, email);
        if (!r.ok) deps.store.addConnectionRemoval(agentId, email);
      }
    }
  } catch {
    /* gog absent or output unparsable → nothing to reconcile */
  }
  for (const a of attached) {
    if (!stillAttached(a.connectionId)) continue;
    await materializeConnection(deps, { id: agentId, slug: agent.slug, runtimeRef }, a.connectionId);
    // Detached during the import: its live removal may have run before the
    // import landed. Off again, and remembered if that fails.
    await offAgainIfDetached(deps, { id: agentId, runtimeRef }, a.connectionId, emailOf.get(a.connectionId));
  }
  // What the volume holds now, after all of the above: the access overview's
  // last check for every account this agent's owner connected, attached or
  // is removing, and for any other account gog names (one the agent added).
  const held = await gogAccounts(deps, runtimeRef);
  if (held) {
    recordGoogleSeen(deps.store, agentId, held, [
      ...attachedEmailsNow(),
      ...deps.store.connectionRemovals(agentId),
      ...deps.store.listConnections(agent.ownerId).map((c) => c.email),
      ...deps.store.listAccessChecks(agentId).filter((c) => c.kind === 'google').map((c) => c.subject),
    ]);
  }
}
