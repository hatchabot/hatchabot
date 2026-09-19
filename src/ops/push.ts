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
  fetchImpl?: typeof fetch;
  log?(event: string, detail: Record<string, unknown>): void;
}

/** Telegram's own cap is 4096 characters; leave room for the tail. */
const MAX = 3500;

export interface OpsPush {
  /** Fire-and-forget; resolves false when there was nowhere to send. */
  waiting(ownerId: string, headline: string, detail?: string): Promise<boolean>;
}

export function createOpsPush(deps: OpsPushDeps): OpsPush {
  return {
    async waiting(ownerId, headline, detail) {
      const chatId = deps.chatId(ownerId);
      if (!chatId) return false; // no linked Telegram: nothing to push to
      const token = await deps.botToken(ownerId).catch(() => undefined);
      if (!token) return false; // the manager has no bot
      const where = deps.appUrl?.();
      const text = [
        headline.trim().slice(0, MAX),
        detail?.trim() ? detail.trim().slice(0, MAX) : '',
        where ? `Confirm it in Hatchabot: ${where}` : 'Confirm it in the Hatchabot app.',
      ].filter(Boolean).join('\n\n');
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
