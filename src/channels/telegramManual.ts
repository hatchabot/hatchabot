import type { SecretStore } from '../secrets/secretStore.js';
import { ChannelSetupRequired } from './channel.js';
import type {
  ChannelProvisioner,
  ChannelProvisionRequest,
  ProvisionedChannel,
} from './channel.js';

const BOTFATHER_STEPS = `Open Telegram and message @BotFather:
1. Send /newbot
2. Pick a name, then a username ending in "bot"
3. Copy the token it gives you and paste it here`;

/**
 * The sanctioned, unbounded fallback: the user creates the bot themselves and
 * pastes the token. Costs about 60 seconds of their time and breaks the
 * "never see BotFather" promise, but it scales without us hand-minting bots
 * and cannot be broken by a Telegram policy change.
 *
 * Flow: provision() throws ChannelSetupRequired with a resume token, the app
 * shows the BotFather walkthrough, the user pastes the token, the app calls
 * submitToken(), and provisioning resumes from where it stopped.
 */
export class TelegramManualProvisioner implements ChannelProvisioner {
  readonly kind = 'telegram' as const;

  /** agentId -> pending token, populated by submitToken(). */
  readonly #pending = new Map<string, { username: string; token: string }>();

  constructor(private readonly secrets: SecretStore) {}

  /**
   * Called by the app once the user pastes their token. Validates the token
   * against Telegram's getMe so we fail here — where the user can fix it —
   * rather than three steps later inside a container.
   */
  /** True once the user has pasted a token for this agent (awaiting the next
   *  provision to consume it). Lets the composite give a chosen bot precedence
   *  over an available pool bot. */
  hasPending(agentId: string): boolean {
    return this.#pending.has(agentId);
  }

  async submitToken(agentId: string, botToken: string): Promise<{ username: string }> {
    const username = await verifyBotToken(botToken);
    this.#pending.set(agentId, { username, token: botToken });
    return { username };
  }

  /**
   * Drop a token we accepted but then refused (e.g. it belongs to another
   * agent). Without this the token stays pending for this agent, and the next
   * thing to resume provisioning — a Retry click — would wire the agent to
   * somebody else's bot.
   */
  discardPending(agentId: string): void {
    this.#pending.delete(agentId);
  }

  async provision(req: ChannelProvisionRequest): Promise<ProvisionedChannel> {
    const pending = this.#pending.get(req.agentId);
    if (!pending) {
      throw new ChannelSetupRequired(BOTFATHER_STEPS, req.agentId);
    }
    const secretRef = `telegram/bot/${pending.username}`;
    await this.secrets.put(secretRef, pending.token);
    this.#pending.delete(req.agentId);
    return {
      accountId: pending.username,
      secretRef,
      deepLink: `https://t.me/${pending.username}`,
    };
  }

  async release(accountId: string): Promise<void> {
    // The user owns this bot. We drop our copy of the token and leave the bot
    // itself alone — deleting someone else's bot is not ours to do.
    await this.secrets.delete(`telegram/bot/${accountId}`).catch(() => {});
  }
}

/** Confirms the token works and returns the bot's username. */
export async function verifyBotToken(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/getMe`);
  // A Telegram outage / proxy can answer with an HTML error page, not JSON —
  // res.json() then throws a raw TypeError that surfaced as an opaque 500.
  // Treat anything non-JSON as "couldn't verify", which is what it is.
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    result?: { username?: string };
    description?: string;
  } | null;
  if (!body?.ok || !body.result?.username) {
    throw new InvalidBotTokenError(body?.description ?? 'Telegram rejected that token');
  }
  return body.result.username;
}

export class InvalidBotTokenError extends Error {
  readonly userMessage = "That token didn't work. Copy the whole line BotFather sent you.";
  constructor(detail: string) {
    super(`Invalid Telegram bot token: ${detail}`);
    this.name = 'InvalidBotTokenError';
  }
}
