import type {
  ChannelProvisioner,
  ChannelProvisionRequest,
  ProvisionedChannel,
} from './channel.js';
import { TelegramPoolProvisioner, PoolExhaustedError } from './telegramPool.js';
import type { TelegramManualProvisioner } from './telegramManual.js';

/**
 * The retail channel strategy in one object:
 *
 *   pool has a bot  → instant, user never sees BotFather (§9.6 kept)
 *   pool exhausted  → manual path: ChannelSetupRequired parks the agent, the
 *                     app walks the user through BotFather (~60s), provisioning
 *                     resumes when the token arrives.
 *
 * release() routes by who owns the identity: pool bots go back in the pool
 * (token kept — the bot still exists and can serve the next agent); user bots
 * have their token deleted from our store (the bot is theirs, not ours).
 */
export class CompositeTelegramProvisioner implements ChannelProvisioner {
  readonly kind = 'telegram' as const;

  constructor(
    readonly pool: TelegramPoolProvisioner,
    readonly manual: TelegramManualProvisioner,
  ) {}

  async provision(req: ChannelProvisionRequest): Promise<ProvisionedChannel> {
    // A token the user already pasted (skipPool flow, or a pool-exhausted
    // agent that has since been re-stocked) MUST win over an available pool
    // bot — otherwise resume silently binds the agent to a pool identity the
    // user declined and strands their bespoke token. skipPool is one-shot so
    // it's gone by resume; hasPending is the durable signal.
    if (req.skipPool || this.manual.hasPending(req.agentId)) {
      return this.manual.provision(req); // throws ChannelSetupRequired if no token yet
    }
    try {
      return await this.pool.provision(req);
    } catch (err) {
      if (!(err instanceof PoolExhaustedError)) throw err;
      return this.manual.provision(req); // throws ChannelSetupRequired if no token yet
    }
  }

  async submitToken(agentId: string, botToken: string): Promise<{ username: string }> {
    return this.manual.submitToken(agentId, botToken);
  }

  discardPending(agentId: string): void {
    this.manual.discardPending(agentId);
  }

  /** Only pool bots are ours to rename; a user's own bot is left alone. */
  async syncDisplayName(accountId: string, agentName: string): Promise<void> {
    if (this.pool.owns(accountId)) await this.pool.syncDisplayName(accountId, agentName);
  }

  async release(accountId: string): Promise<void> {
    if (this.pool.owns(accountId)) {
      await this.pool.release(accountId);
    } else {
      await this.manual.release(accountId);
    }
  }
}
