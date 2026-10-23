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
 *
 * The method name is the guest's to choose, so a guest sending made-up names
 * could still write one line per name and push the history out, and grow the
 * map without end (review, 2026-10-22). So: ten names a day per guest and
 * agent, the rest folded into one "other" line a day, and a hard cap on what
 * is remembered.
 */

/** Owner-only calls the console app makes as it starts, refused for a guest every time. */
export const CONSOLE_STARTUP_CALLS = new Set(['models.authStatus', 'config.get', 'plugin.surface.refresh']);

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
/** Distinct refused methods a guest's refusals record per agent a day; past that, OTHER_METHODS. */
export const NAMES_PER_DAY = 10;
export const OTHER_METHODS = '(other methods)';
/** What the log remembers at most; the oldest go first. */
export const MAX_KEYS = 2000;
const METHOD_NAME = /^[A-Za-z][\w-]*(\.[\w-]+)*$/;

export class GuestConsoleLog {
  readonly #last = new Map<string, number>();
  /** Per guest and agent: since when, and how many distinct names were recorded. */
  readonly #names = new Map<string, { since: number; n: number }>();

  #due(key: string, every: number, now: number): boolean {
    const at = this.#last.get(key);
    if (at !== undefined && now - at < every) return false;
    this.#last.delete(key); // re-inserted last: the map's order is oldest first
    this.#last.set(key, now);
    while (this.#last.size > MAX_KEYS) this.#last.delete(this.#last.keys().next().value!);
    return true;
  }

  /** Record this guest's visit in the timeline? At most once an hour. */
  opened(agentId: string, userId: string, now = Date.now()): boolean {
    return this.#due(`open:${agentId}:${userId}`, HOUR, now);
  }

  /** Record this refusal in the timeline? Never for the app's startup calls; others once a day. */
  refused(agentId: string, userId: string, method: string, now = Date.now()): boolean {
    return this.refusal(agentId, userId, method, now) !== undefined;
  }

  /** The method name to record this refusal under in the timeline, or undefined for none. */
  refusal(agentId: string, userId: string, method: string, now = Date.now()): string | undefined {
    if (CONSOLE_STARTUP_CALLS.has(method)) return undefined;
    const who = `${agentId}:${userId}`;
    let name = METHOD_NAME.test(method) ? method : OTHER_METHODS;
    if (name !== OTHER_METHODS) {
      const at = this.#last.get(`refused:${who}:${name}`);
      if (at === undefined || now - at >= DAY) {
        let b = this.#names.get(who);
        if (!b || now - b.since >= DAY) {
          this.#names.delete(who);
          this.#names.set(who, (b = { since: now, n: 0 }));
          while (this.#names.size > MAX_KEYS) this.#names.delete(this.#names.keys().next().value!);
        }
        if (b.n >= NAMES_PER_DAY) name = OTHER_METHODS;
        else b.n++;
      }
    }
    return this.#due(`refused:${who}:${name}`, DAY, now) ? name : undefined;
  }
}
