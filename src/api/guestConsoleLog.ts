/**
 * What a web-chat guest's console visits leave in the agent's timeline.
 *
 * OpenClaw's console app asks for a few owner-only things every time it
 * starts; a guest is refused them by design. Recorded on every connection,
 * one guest who reopened the chat every few minutes filled an agent's whole
 * 200-line history in a night with "guest refused", pushing its real setup
 * log out (2026-10-10). So: the app's own startup calls go to the service log
 * only; any other refusal is recorded once a day per guest and method; a
 * guest's visit once an hour.
 */

/** Owner-only calls the console app makes as it starts, refused for a guest every time. */
export const CONSOLE_STARTUP_CALLS = new Set(['models.authStatus', 'config.get', 'plugin.surface.refresh']);

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export class GuestConsoleLog {
  readonly #last = new Map<string, number>();

  #due(key: string, every: number, now: number): boolean {
    const at = this.#last.get(key);
    if (at !== undefined && now - at < every) return false;
    this.#last.set(key, now);
    if (this.#last.size > 5000) for (const [k, t] of this.#last) if (now - t >= DAY) this.#last.delete(k);
    return true;
  }

  /** Record this guest's visit in the timeline? At most once an hour. */
  opened(agentId: string, userId: string, now = Date.now()): boolean {
    return this.#due(`open:${agentId}:${userId}`, HOUR, now);
  }

  /** Record this refusal in the timeline? Never for the app's startup calls; others once a day. */
  refused(agentId: string, userId: string, method: string, now = Date.now()): boolean {
    if (CONSOLE_STARTUP_CALLS.has(method)) return false;
    return this.#due(`refused:${agentId}:${userId}:${method}`, DAY, now);
  }
}
