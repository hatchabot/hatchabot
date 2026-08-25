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
    // The owner can decline a pool bot for this agent ("I want a bespoke
    // @handle") — respect it before the pool ever sees the request.
    if (req.skipPool) {
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

  async release(accountId: string): Promise<void> {
    if (this.pool.owns(accountId)) {
      await this.pool.release(accountId);
    } else {
      await this.manual.release(accountId);
    }
  }
}
