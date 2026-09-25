/**
 * Telling the owner on Telegram that something is waiting.
 *
 * The retired Telegram management bot's one real advantage was the push: it
 * messaged your phone when a change needed confirming. The management agent's
 * own bot can carry that instead — Hatchabot sends through its token directly
 * (sendMessage is stateless, so it never competes with the agent's gateway for
 * updates the way a second poller would).
 *
 * Deliberately one-way: the message says what is waiting and where to confirm
 * it. Nothing is ever approved from Telegram by this path — the card is still
 * pressed in the app, by someone signed in.
 */

export interface OpsPushDeps {
  /** The management agent's bot token, or undefined when it has no bot. */
  botToken(ownerId: string): Promise<string | undefined>;
  /** Where to send: the owner's own Telegram id on that agent. */
  chatId(ownerId: string): string | undefined;
  /** Where the owner opens Hatchabot (shown as a link). */
  appUrl?(): string | undefined;
  /** A DM through the manager's Discord bot to the owner, when it has one and the owner is linked there. */
  sendDiscord?(ownerId: string, text: string): Promise<boolean>;
  /** How many pushes an owner may get per hour (a flood of knocks must not become a flood of pushes). */
  perHour?: number;
  fetchImpl?: typeof fetch;
  log?(event: string, detail: Record<string, unknown>): void;
}

/** Telegram's own cap is 4096 characters; leave room for the tail. */
const MAX = 3500;

export interface OpsPush {
  /** Fire-and-forget; resolves false when there was nowhere to send. */
  waiting(ownerId: string, headline: string, detail?: string): Promise<boolean>;
}

/**
 * Which of these are new, forgetting the ones that are gone. Used by the
 * "someone is knocking" sweep: a request already announced must not be
 * announced again on the next pass, and a request that was denied and comes
 * back is news again. Mutates `seen` — it is the caller's memory.
 */
export function unannounced(seen: Set<string>, current: readonly string[]): string[] {
  const live = new Set(current);
  for (const key of seen) if (!live.has(key)) seen.delete(key);
  const fresh = current.filter((key) => !seen.has(key));
  for (const key of fresh) seen.add(key);
  return fresh;
}

/**
 * At most `perHour` pushes per owner per hour; the one that crosses the line
 * is replaced by a single "and more" note, the rest are dropped until the
 * hour turns. Anyone can knock at a bot that allows knocks, and each knock
 * used to be a message to the owner's phone (2026-09-25).
 */
export class PushBudget {
  #sent = new Map<string, number[]>();
  constructor(readonly perHour = 6, readonly now: () => number = Date.now) {}
  /** 'send' | 'last' (send, but say it is the last for a while) | 'drop'. */
  take(ownerId: string): 'send' | 'last' | 'drop' {
    const t = this.now();
    const recent = (this.#sent.get(ownerId) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= this.perHour) { this.#sent.set(ownerId, recent); return 'drop'; }
    recent.push(t); this.#sent.set(ownerId, recent);
    return recent.length === this.perHour ? 'last' : 'send';
  }
}

export function createOpsPush(deps: OpsPushDeps): OpsPush {
  const budget = new PushBudget(deps.perHour ?? 6);
  return {
    async waiting(ownerId, headline, detail) {
      const chatId = deps.chatId(ownerId);
      const token = chatId ? await deps.botToken(ownerId).catch(() => undefined) : undefined;
      if (!token && !deps.sendDiscord) return false; // nowhere to push to
      const slot = budget.take(ownerId);
      if (slot === 'drop') { deps.log?.('ops.push', { ok: false, error: 'hourly push limit; more is waiting in the app' }); return false; }
      const where = deps.appUrl?.();
      const text = [
        headline.trim().slice(0, MAX),
        detail?.trim() ? detail.trim().slice(0, MAX) : '',
        slot === 'last' ? 'That is the last of these for this hour — anything more waits in the app.' : '',
        where ? `Confirm it in Hatchabot: ${where}` : 'Confirm it in the Hatchabot app.',
      ].filter(Boolean).join('\n\n');
      if (!token) {
        // No Telegram to carry it: the manager's Discord bot, when the owner is linked there.
        const ok = await deps.sendDiscord!(ownerId, text).catch(() => false);
        deps.log?.('ops.push', { ok, via: 'discord', ...(ok ? {} : { error: 'no Discord to carry it' }) });
        return ok;
      }
      try {
        const send = deps.fetchImpl ?? fetch;
        const res = await send(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // No link preview and no parse mode: the text is not ours to trust as
          // markup (an agent's summary can contain anything).
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(8000),
        });
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
        deps.log?.('ops.push', { ok: body.ok === true, ...(body.ok === true ? {} : { error: String(body.description ?? res.status).slice(0, 160) }) });
        return body.ok === true;
      } catch (err) {
        deps.log?.('ops.push', { ok: false, error: String((err as Error)?.message ?? err).slice(0, 160) });
        return false;
      }
    },
  };
}
