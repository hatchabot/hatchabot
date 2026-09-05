import { randomBytes } from 'node:crypto';
import type { Store } from '../store/store.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { SecretStore } from '../secrets/secretStore.js';

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
  const scopes = ['openid', 'email', ...services.map((s) => GOOGLE_SERVICES[s]).filter(Boolean)];
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
): Promise<{ refreshToken: string; email: string }> {
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
    refresh_token?: string; access_token?: string; error?: string; error_description?: string;
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
  return { refreshToken: tok.refresh_token, email: info.email };
}

/** Best-effort revoke at Google when a connection is removed from the vault. */
export async function revokeGoogleToken(refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }).toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

/**
 * Short-lived, single-use state tokens for the consent round-trip. In-memory
 * on purpose: a restart mid-consent just means clicking Connect again.
 */
export class OAuthStateJar {
  #jar = new Map<string, { ownerId: string; services: string[]; expires: number }>();
  issue(ownerId: string, services: string[]): string {
    // Occasional sweep so abandoned flows don't accumulate.
    const now = Date.now();
    for (const [k, v] of this.#jar) if (v.expires < now) this.#jar.delete(k);
    const state = randomBytes(24).toString('base64url');
    this.#jar.set(state, { ownerId, services, expires: now + 10 * 60_000 });
    return state;
  }
  consume(state: string): { ownerId: string; services: string[] } | null {
    const v = this.#jar.get(state);
    this.#jar.delete(state); // single-use either way
    if (!v || v.expires < Date.now()) return null;
    return { ownerId: v.ownerId, services: v.services };
  }
}

export interface ConnectionSyncDeps {
  store: Store;
  secrets: SecretStore;
  provider: RuntimeProvider;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

const GOG_HOME = '/home/node/.openclaw/connections/gog';

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
 * Materialize one connection into a RUNNING agent's container. Secrets ride
 * base64 inside the script (same exposure class as deploy-key writes — an
 * accepted household risk, see docs/pre-production.md).
 */
export async function materializeConnection(
  deps: ConnectionSyncDeps,
  agent: { id: string; slug: string; runtimeRef: string },
  connectionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { store, secrets, provider } = deps;
  const conn = store.getConnection(connectionId);
  if (!conn) return { ok: false, error: 'no such connection' };
  const attach = store
    .listAgentConnections(agent.id)
    .find((a) => a.connectionId === connectionId);
  const clientRaw = await secrets.get(GOOGLE_CLIENT_REF).catch(() => null);
  const client = clientRaw ? parseOAuthClient(clientRaw) : null;
  if (!client) return { ok: false, error: 'Google OAuth client not configured' };
  const refreshToken = await secrets.get(conn.secretRef).catch(() => null);
  if (!refreshToken) return { ok: false, error: 'connection token missing from the vault' };

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
  const b64Token = Buffer.from(refreshToken, 'utf8').toString('base64');
  const noSend = attach?.gmailNoSend ? ' --gmail-no-send' : '';
  const script = [
    bootstrapScript(),
    `umask 077`,
    `echo ${JSON.stringify(b64Client)} | base64 -d > ${GOG_HOME}/.client_secret.json`,
    `~/.local/bin/gog auth credentials ${GOG_HOME}/.client_secret.json >/dev/null`,
    `rm -f ${GOG_HOME}/.client_secret.json`,
    `echo ${JSON.stringify(b64Token)} | base64 -d | ~/.local/bin/gog auth import --email ${JSON.stringify(conn.email)} --refresh-token-stdin --no-input${noSend}`,
  ].join('\n');
  const res = await provider.execShell(agent.runtimeRef, script);
  if (res.code !== 0) {
    const error = (res.stderr || res.stdout || 'import failed').slice(0, 300);
    deps.log?.('connection.materialize_failed', { agentId: agent.id, email: conn.email, error });
    return { ok: false, error };
  }
  deps.log?.('connection.materialized', { agentId: agent.id, email: conn.email });
  return { ok: true };
}

/** Remove one previously-materialized account from a RUNNING agent. */
export async function dematerializeConnection(
  deps: ConnectionSyncDeps,
  agent: { id: string; runtimeRef: string },
  email: string,
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+$/.test(email)) return;
  await deps.provider
    .execShell(agent.runtimeRef, `~/.local/bin/gog auth remove --force -- "${email}" 2>/dev/null || gog auth remove --force -- "${email}"`)
    .catch(() => {});
  deps.log?.('connection.removed_from_agent', { agentId: agent.id, email });
}

/**
 * Provision-time sync (step 7.6): every ATTACHED connection lands on the
 * volume before the agent goes RUNNING. Best-effort per connection — a
 * Google outage must not fail a rebuild; failures are logged and retried on
 * the next provision (import is idempotent: same email+client overwrites).
 */
export async function syncConnections(
  deps: ConnectionSyncDeps,
  agentId: string,
  runtimeRef: string,
): Promise<void> {
  const agent = deps.store.getAgent(agentId);
  if (!agent) return;
  const attached = deps.store.listAgentConnections(agentId);
  for (const a of attached) {
    await materializeConnection(deps, { id: agentId, slug: agent.slug, runtimeRef }, a.connectionId);
  }
}
