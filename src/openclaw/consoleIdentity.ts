import { createHmac } from 'node:crypto';

/**
 * Who is at an agent's OpenClaw console (2026-09-30): the real Control UI for
 * the agent's owner AND for the people the owner gave web chat, each seeing
 * only what their role allows.
 *
 * OpenClaw's way to tell people apart at its gateway is trusted-proxy auth: a
 * reverse proxy it trusts (by source address) authenticates the person and
 * names them in a header. Hatchabot's console proxy is that proxy. The gateway
 * then gives each name a durable profile, and named operator roles decide:
 *
 *  - `hatchabot-owner` — every session, full operator rights (the console as
 *    it always was). Assigned to the owner's profile with `users.setRole`.
 *  - `hatchabot-guest` (the DEFAULT for any profile without a role) — only
 *    the sessions this person started (`sessions.others: "none"`), read and
 *    write scopes only (no operator.admin, so its turns are non-owner turns:
 *    no automations, gateway, sessions, nodes tools), and only this agent.
 *
 * Proven on a throwaway 2026.9.6 agent (docs/real-chat notes): a guest's
 * sessions.list shows only their own sessions, and chat.history, preview,
 * describe, fork, patch, transcripts and chat.send on the owner's main
 * conversation, a cron run or another guest's session all answer "not found".
 *
 * The names are unguessable: an HMAC of the agent's gateway secret. The
 * gateway's loopback port is reachable by anything on the host, and
 * `trustedProxy.allowUsers` lists exactly these names, so a local process
 * that does not hold the secret cannot claim anyone — not even a stranger's
 * guest seat. Token auth is gone from these agents (OpenClaw refuses
 * trusted-proxy next to a shared token); the same secret becomes the
 * gateway PASSWORD, which OpenClaw accepts only from the container's own
 * loopback — the `openclaw` CLI, Hatchabot's turns, health and doctor.
 */

/** The header Hatchabot's console proxy names the person in. Never taken from a browser. */
export const CONSOLE_USER_HEADER = 'x-hatchabot-user';
/** OpenClaw's cap on a trusted-proxy connection's scopes (a cap, never a grant). */
export const CONSOLE_SCOPES_HEADER = 'x-openclaw-scopes';
export const GUEST_SCOPES = ['operator.read', 'operator.write'] as const;
export const OWNER_ROLE = 'hatchabot-owner';
export const GUEST_ROLE = 'hatchabot-guest';
/** Every name ends here; `.invalid` is reserved, so no real mailbox is ever implied. */
const IDENTITY_DOMAIN = 'hatchabot.invalid';

export type ConsoleRole = 'owner' | 'guest';

const hmac = (secret: string, what: string): string => createHmac('sha256', secret).update(what, 'utf8').digest('hex');

/**
 * The name Hatchabot vouches for at this agent's gateway. Stable per person
 * and agent (sessions stay theirs across rebuilds), different per agent, and
 * meaningless without the agent's gateway secret.
 */
export function consoleIdentity(secret: string, role: ConsoleRole, userId: string): string {
  return `${role}-${hmac(secret, `console-identity\0${role}\0${userId}`).slice(0, 24)}@${IDENTITY_DOMAIN}`;
}

/** Is this one of ours, of that role (the shape only — the proxy is what vouches)? */
export function isConsoleIdentity(s: unknown, role?: ConsoleRole): s is string {
  return typeof s === 'string' && new RegExp(`^(${role ?? 'owner|guest'})-[0-9a-f]{24}@hatchabot\\.invalid$`).test(s);
}

/**
 * The conversation a guest's console opens on: theirs, unguessable by other
 * guests (a key someone else created first answers "not found" to them — and
 * a guest could otherwise squat another's key). OpenClaw scopes it to the agent.
 */
export function guestConsoleSessionKey(secret: string, slug: string, userId: string): string {
  return `agent:${slug}:guest:${hmac(secret, `console-session\0${userId}`).slice(0, 16)}`;
}

/** OpenClaw versions whose gateway has named roles, identity profiles and trusted-proxy device approval (verified on 2026.9.6). */
export function supportsConsoleIdentity(openclawVersion: string | undefined): boolean {
  const m = /^(\d{4})\.(\d+)/.exec(openclawVersion ?? '');
  return !!m && (Number(m[1]) > 2026 || (Number(m[1]) === 2026 && Number(m[2]) >= 9));
}

/** A placeholder proxy address (TEST-NET-1: never a real peer) for when none is known yet; the first console open replaces it. */
export const NO_PROXY_YET = '192.0.2.1';

export interface ConsoleGatewaySpec {
  /** The gateway secret (Hatchabot's gatewayToken), used as the loopback password. */
  password: string;
  /** The address the gateway sees Hatchabot's connections come from (the agent network's gateway). */
  trustedProxies: string[];
  /** The owner's name first, then every guest's. Never empty: an empty list would admit ANY name. */
  allowUsers: string[];
  ownerIdentity: string;
  /** The OpenClaw agent id (slug): the only agent guests may use. */
  slug: string;
}

/** `gateway.auth` for an identity console: replaces the whole object, token included. */
export function consoleGatewayAuth(spec: ConsoleGatewaySpec): Record<string, unknown> {
  const allowUsers = [...new Set([spec.ownerIdentity, ...spec.allowUsers])];
  return {
    mode: 'trusted-proxy',
    password: spec.password,
    trustedProxy: {
      userHeader: CONSOLE_USER_HEADER,
      allowUsers,
      // A new browser is enrolled on the proxy's word, with at most these
      // scopes (and never more than the x-openclaw-scopes cap Hatchabot sends
      // a guest). The owner's admin comes from identityScopes, per connection.
      deviceAutoApprove: { enabled: true, scopes: [...GUEST_SCOPES] },
    },
    identityScopes: { [spec.ownerIdentity]: ['operator.admin'] },
  };
}

/** `gateway.roles`: guests by default; the owner's profile is given the owner role at runtime. */
export function consoleGatewayRoles(slug: string): Record<string, unknown> {
  return {
    default: GUEST_ROLE,
    definitions: {
      [GUEST_ROLE]: { sessions: { others: 'none' }, agents: [slug], scopes: [...GUEST_SCOPES] },
      [OWNER_ROLE]: { sessions: { others: 'write' }, agents: '*', scopes: ['operator.admin'] },
    },
  };
}
