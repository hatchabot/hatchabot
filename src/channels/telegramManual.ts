import { createHash, timingSafeEqual } from 'node:crypto';
import type { SecretStore } from '../secrets/secretStore.js';
import { ChannelSetupRequired } from './channel.js';
import type {
  ChannelProvisioner,
  ChannelProvisionRequest,
  ProvisionedChannel,
  ReleaseOptions,
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

  /**
   * agentId -> pending token: what submitToken() and a failed setup hold,
   * and what loadHeld() read from the store at boot. The only place a look
   * asks; the store is written alongside, for the next boot.
   */
  readonly #pending = new Map<string, { username: string; token: string }>();
  /** The boot read (loadHeld); every look waits for it. */
  #loaded: Promise<void> = Promise.resolve();
  /**
   * When each agent's held token last changed here (held, let go or taken),
   * by a counter: what a boot read found on disk does not bring back one
   * that changed after that read began.
   */
  readonly #changedAt = new Map<string, number>();
  #changes = 0;

  #changed(agentId: string): void {
    this.#changedAt.set(agentId, ++this.#changes);
  }

  constructor(private readonly secrets: SecretStore) {}

  /**
   * At boot, the tokens held on disk for these agents (every one not
   * deleted) go into memory, read once. A token held
   * meanwhile in this process wins. A read that fails holds nothing.
   */
  loadHeld(agentIds: string[]): void {
    const before = this.#loaded;
    const began = this.#changes;
    const since = (id: string) => (this.#changedAt.get(id) ?? 0) > began;
    this.#loaded = (async () => {
      await before;
      // All at once: the store has no listing, and one at a time held every
      // look for a fleet's worth of reads in a row.
      const read = await Promise.all(agentIds.filter((id) => !this.#pending.has(id) && !since(id)).map(async (id) =>
        [id, await this.secrets.get(TelegramManualProvisioner.pendingRef(id)).catch(() => undefined)] as const));
      for (const [id, raw] of read) {
        try {
          const p = raw ? JSON.parse(raw) as { username?: unknown; token?: unknown } : undefined;
          // Held, let go or taken meanwhile (a discard does not wait for this
          // read): what the read found is out of date.
          if (p && typeof p.username === 'string' && typeof p.token === 'string' && !this.#pending.has(id) && !since(id)) {
            this.#pending.set(id, { username: p.username, token: p.token });
          }
        } catch { /* not a held token: nothing held */ }
      }
    })();
  }

  /**
   * Where a pasted token waits on disk too: held only in memory, a restart
   * between the paste and setup lost it, and the agent waited for a token
   * its owner had given.
   */
  static pendingRef(agentId: string): string { return `telegram/pending/${agentId}`; }

  async #hold(agentId: string, pending: { username: string; token: string }): Promise<void> {
    this.#pending.set(agentId, pending);
    this.#changed(agentId);
    await this.secrets.put(TelegramManualProvisioner.pendingRef(agentId), JSON.stringify(pending));
  }

  /** The token waiting for this agent: in memory (after a restart, as loadHeld read it). No store read. */
  async #waiting(agentId: string): Promise<{ username: string; token: string } | undefined> {
    await this.#loaded;
    return this.#pending.get(agentId);
  }

  /** Whether a pasted token waits for this agent (held in this process, or read at boot). */
  async waitingFor(agentId: string): Promise<boolean> {
    return !!(await this.#waiting(agentId));
  }

  /** The bot's name, when the token waiting for this agent is this very one (a post sent again). */
  async heldBot(agentId: string, token: string): Promise<string | undefined> {
    const p = await this.#waiting(agentId);
    return p && sameToken(p.token, token) ? p.username : undefined;
  }

  /**
   * Called by the app once the user pastes their token. Validates the token
   * against Telegram's getMe so we fail here — where the user can fix it —
   * rather than three steps later inside a container. `checked`: the bot's
   * name, when the caller asked Telegram already (one getMe per paste).
   */
  async submitToken(agentId: string, botToken: string, checked?: string): Promise<{ username: string }> {
    const username = checked ?? await verifyBotToken(botToken);
    await this.#hold(agentId, { username, token: botToken });
    return { username };
  }

  /**
   * Drop a token we accepted but then refused (e.g. it belongs to another
   * agent). Without this the token stays pending for this agent, and the next
   * thing to resume provisioning — a Retry click — would wire the agent to
   * somebody else's bot.
   */
  discardPending(agentId: string): Promise<void> {
    this.#pending.delete(agentId);
    this.#changed(agentId);
    return this.secrets.delete(TelegramManualProvisioner.pendingRef(agentId)).catch(() => {});
  }

  async provision(req: ChannelProvisionRequest): Promise<ProvisionedChannel> {
    const pending = await this.#waiting(req.agentId);
    if (!pending) {
      throw new ChannelSetupRequired(BOTFATHER_STEPS, req.agentId);
    }
    const secretRef = `telegram/bot/${pending.username}`;
    await this.secrets.put(secretRef, pending.token);
    this.#pending.delete(req.agentId);
    this.#changed(req.agentId);
    await this.secrets.delete(TelegramManualProvisioner.pendingRef(req.agentId)).catch(() => {});
    return {
      accountId: pending.username,
      secretRef,
      deepLink: `https://t.me/${pending.username}`,
    };
  }

  async release(accountId: string, opts?: ReleaseOptions): Promise<void> {
    // A setup that failed: the token goes back to waiting for its Retry, or the
    // owner would have to paste it again (HB-0414). As when first pasted, it
    // waits in memory and on disk, so a restart before the Retry keeps it.
    if (opts?.reason === 'setup-failed' && opts.agentId && !this.#pending.has(opts.agentId)) {
      const token = await this.secrets.get(`telegram/bot/${accountId}`).catch(() => undefined);
      if (token) await this.#hold(opts.agentId, { username: accountId, token }).catch(() => {});
    }
    // The user owns this bot. We drop our copy of the token and leave the bot
    // itself alone — deleting someone else's bot is not ours to do. No goodbye
    // is sent from here: without the token there is nothing to send it with,
    // and callers who want one park the bot in the pool first (which is also
    // what keeps the token reusable), so the pool's release does the talking.
    await this.secrets.delete(`telegram/bot/${accountId}`).catch(() => {});
  }
}

/** Two tokens compared by their hashes, in constant time: neither is logged or kept. */
export function sameToken(a: string, b: string): boolean {
  const h = (t: string) => createHash('sha256').update(t.trim()).digest();
  return timingSafeEqual(h(a), h(b));
}

/** The shape of a BotFather token: an id, a colon, URL-safe characters. Nothing else may reach the URL. */
const BOT_TOKEN_SHAPE = /^\d+:[A-Za-z0-9_-]+$/;

/** How long a token check may take, Telegram's answer and its body together. */
export const VERIFY_DEADLINE_MS = 10_000;

/**
 * Confirms the token works and returns the bot's username. Bounded: with no
 * deadline a stalled Telegram (or proxy) held adding a bot, pasting a token
 * and importing an agent for minutes, or for good while a body dribbled in
 * (HB-0552); the timeout signal cuts off the body too. Only Telegram's own
 * "no" (ok:false with 401 or 404) means the token is wrong. No answer, no
 * connection, a 5xx or 429, or a page that is not Telegram's JSON (a proxy's
 * 502) is TelegramUnavailableError: worth trying again.
 */
export async function verifyBotToken(
  botToken: string,
  fetchImpl: typeof fetch = fetch,
  deadlineMs = VERIFY_DEADLINE_MS,
): Promise<string> {
  // The token is pasted by a person and becomes part of the request's path: one with a
  // slash, a question mark or a dot could call another method of Telegram's API with that
  // same token (never another host; CodeQL js/request-forgery, 2026-10-24). Refused up front.
  if (!BOT_TOKEN_SHAPE.test(botToken)) throw new InvalidBotTokenError('not the shape of a bot token');
  type GetMe = { ok?: boolean; result?: { username?: string }; description?: string } | null;
  let status: number;
  let body: GetMe;
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(deadlineMs) });
    status = res.status;
    if (status >= 500 || status === 429) {
      // Unread, the body would hold its connection until the deadline.
      await res.body?.cancel().catch(() => {});
      throw new TelegramUnavailableError(`it answered ${status}`);
    }
    body = (await res.json()) as GetMe;
  } catch (err) {
    if (err instanceof TelegramUnavailableError) throw err;
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    throw new TelegramUnavailableError(timedOut ? 'no answer in time' : err instanceof Error ? err.message : String(err));
  }
  if (body?.ok && body.result?.username) return body.result.username;
  if (body?.ok === false && (status === 401 || status === 404)) {
    throw new InvalidBotTokenError(body.description ?? 'Telegram rejected that token');
  }
  throw new TelegramUnavailableError(`an answer that is not a bot (${status})`);
}

/** Telegram did not answer the token check: try again, the token may be fine. */
export class TelegramUnavailableError extends Error {
  readonly userMessage = 'Telegram did not answer, so the token could not be checked. Try again in a moment.';
  /** A route that lets it through answers 503 (errorHandler.ts), not 500. */
  readonly statusCode = 503;
  constructor(detail: string) {
    super(`Telegram could not be reached: ${detail}`);
    this.name = 'TelegramUnavailableError';
  }
}

export class InvalidBotTokenError extends Error {
  readonly userMessage = "That token didn't work. Copy the whole line BotFather sent you.";
  constructor(detail: string) {
    super(`Invalid Telegram bot token: ${detail}`);
    this.name = 'InvalidBotTokenError';
  }
}
