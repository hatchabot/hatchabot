/**
 * Slack and Discord: channels the owner sets up by creating an app on the
 * platform and pasting its credentials. No pool, no minting — so a much
 * leaner shape than ChannelProvisioner (docs/channels-slack-discord-design.md).
 *
 * A connector only TALKS TO THE PLATFORM to check what was pasted. Storing,
 * config and pairing are the orchestrator's.
 */

export type ConnectorKind = 'slack' | 'discord';

export interface ConnectorField {
  key: string;
  label: string;
  /** First-line shape check; `verify` is the real one. */
  pattern: RegExp;
  help: string;
}

export interface VerifiedChannel {
  /** Slack: the bot's user id. Discord: the application id. */
  accountId: string;
  /** "@Tax Advisor in Krueger Family" */
  displayName: string;
  /** Opens a direct message with the bot. */
  deepLink: string;
  /** Discord: adds the bot to a server. */
  addToServerUrl?: string;
  /** Stored on the channel row for display (team, servers, bot user id). */
  settings: Record<string, unknown>;
  /** Things that will stop it working, in plain words. */
  warnings: string[];
}

export interface ChannelConnector {
  readonly kind: ConnectorKind;
  readonly label: string;
  readonly fields: ConnectorField[];
  /** Hosts the management agent's proxy must let through for this channel. */
  readonly hosts: string[];
  verify(creds: Record<string, string>): Promise<VerifiedChannel>;
  /** The secret stored for the agent, from the verified fields. */
  secretValue(creds: Record<string, string>): string;
  /** The fields back out of a stored secret, so a re-check can run verify() without asking the owner to paste again. */
  credsFromSecret(secret: string): Record<string, string>;
}

/** A refusal the owner can act on. The message never contains a credential. */
export class ConnectorError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = 'ConnectorError';
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Fixed-host JSON call: no redirects, 10-second limit, errors in plain words. */
export async function callJson(
  f: FetchLike,
  platform: string,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: any; headers: Headers }> {
  let res: Response;
  try {
    res = await f(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ConnectorError(`Couldn't reach ${platform}. Check this machine's internet connection and try again.`);
  }
  let body: any = undefined;
  try { body = await res.json(); } catch { /* not JSON: judged by status */ }
  return { status: res.status, body, headers: res.headers };
}

/** Trim and reject anything but printable, space-free text; never echoes the value. */
export function cleanField(creds: Record<string, string>, field: ConnectorField): string {
  const v = typeof creds[field.key] === 'string' ? creds[field.key]!.trim() : '';
  if (!v) throw new ConnectorError(`${field.label} is missing.`);
  if (!field.pattern.test(v)) throw new ConnectorError(`That doesn't look like a ${field.label.toLowerCase()}. ${field.help}`);
  return v;
}
