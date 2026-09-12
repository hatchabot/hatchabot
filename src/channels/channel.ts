/**
 * §5.3 / §7.5: channel abstraction from day one, even though only Telegram
 * ships. The orchestrator only ever sees this interface, so adding WhatsApp or
 * Signal later means writing one new ChannelProvisioner — not touching the
 * provisioning flow, the state machine, or the app.
 *
 * Note what is deliberately NOT in the interface: bot tokens, BotFather, or
 * anything Telegram-shaped. `provision` returns an opaque account id, a secret
 * ref, and a deep link, because that is the most any messenger needs to expose.
 */

export interface ChannelProvisionRequest {
  agentId: string;
  /** Human-facing agent name, used to derive a handle where the platform allows. */
  agentName: string;
  slug: string;
  /** The Hatchabot user creating the agent — pool leasing is scoped to their
   *  own bots plus shared house bots (a token belongs to whoever minted it). */
  ownerId?: string;
  /** Owner opted out of a pool bot for this agent — go straight to the manual
   *  (BotFather walkthrough) path even when the pool has bots. */
  skipPool?: boolean;
}

export interface ProvisionedChannel {
  /** Platform account identifier. Telegram: the bot username. */
  accountId: string;
  /** SecretStore ref holding whatever credential the runtime needs. */
  secretRef: string;
  /** Link the app shows the user: "tap here and say hi". */
  deepLink: string;
}

/**
 * Some channels cannot be provisioned without a human step (see
 * telegramManual.ts). Those throw ChannelSetupRequired, which the orchestrator
 * surfaces to the app as a resumable prompt rather than a hard failure.
 */
export class ChannelSetupRequired extends Error {
  constructor(
    readonly instructions: string,
    readonly resumeToken: string,
  ) {
    super('Channel requires a user-supplied credential before provisioning');
    this.name = 'ChannelSetupRequired';
  }
}

/** Why an identity is being given up, and on whose behalf. */
export interface ReleaseOptions {
  reason?: 'deleted' | 'archived';
  agentId?: string;
}

export interface ChannelProvisioner {
  readonly kind: 'telegram';

  /** Mint or lease a messaging identity for this agent. Idempotent per agent. */
  provision(req: ChannelProvisionRequest): Promise<ProvisionedChannel>;

  /**
   * Release the identity. Called on rollback, on agent deletion, and on
   * archive. `opts` shapes the goodbye the departing members get: what they're
   * told differs sharply between "this agent is gone" and "this agent is
   * parked and may return under a different bot", and `agentId` names whose
   * members to tell when the row isn't leased (a pasted token parked in the
   * pool moments earlier has no lease to look up).
   */
  release(accountId: string, opts?: ReleaseOptions): Promise<void>;

  /** Forget a submitted-but-refused identity for this agent, if the
   *  implementation holds one pending. */
  discardPending?(agentId: string): void;

  /**
   * Re-apply the agent's name to a bot we manage, if this provisioner manages
   * it. Renaming is best-effort at lease time (Telegram limits it), so the
   * rebuild path calls this to heal a bot left wearing the wrong name.
   * Implementations must ignore identities they don't own — a hand-minted bot
   * belongs to the person who created it.
   */
  syncDisplayName?(accountId: string, agentName: string): Promise<void>;

  /**
   * Push the member allowlist to the platform where the platform itself can
   * enforce it. For Telegram this is a no-op — enforcement lives in the agent's
   * config (§12.4) — but WhatsApp/Signal may differ.
   */
  syncAllowlist?(accountId: string, channelUserIds: string[]): Promise<void>;
}
