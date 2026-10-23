import { describe, expect, it } from 'vitest';
import { CONSOLE_STARTUP_CALLS, GuestConsoleLog, MAX_KEYS, NAMES_PER_DAY, OTHER_METHODS } from '../src/api/guestConsoleLog.js';

/**
 * A guest who reopened an agent's chat every few minutes filled its 200-line
 * timeline in a night with the console app's own refused startup calls
 * (2026-10-10). What reaches the timeline now: no startup call, other
 * refusals once a day per guest and method, a visit once an hour.
 */
describe('what a guest console visit leaves in the timeline', () => {
  const T = Date.parse('2026-10-10T12:00:00Z');
  const MIN = 60_000;

  it('the console app\'s startup calls never: they are refused on every open, by design', () => {
    const log = new GuestConsoleLog();
    for (const m of CONSOLE_STARTUP_CALLS) expect(log.refused('a1', 'u1', m, T)).toBe(false);
  });

  it('a night of reopening every few minutes: one visit an hour, nothing else', () => {
    const log = new GuestConsoleLog();
    let lines = 0;
    for (let t = T; t < T + 12 * 60 * MIN; t += 4 * MIN) {
      if (log.opened('a1', 'u1', t)) lines++;
      for (const m of ['models.authStatus', 'config.get', 'plugin.surface.refresh']) if (log.refused('a1', 'u1', m, t)) lines++;
    }
    expect(lines).toBe(12); // was 4 a visit × 180 visits = 720, past the 200 the timeline keeps
  });

  it('another refused call is recorded, once a day per guest and method', () => {
    const log = new GuestConsoleLog();
    expect(log.refused('a1', 'u1', 'agents.delete', T)).toBe(true);
    expect(log.refused('a1', 'u1', 'agents.delete', T + 60 * MIN)).toBe(false);
    expect(log.refused('a1', 'u2', 'agents.delete', T + 60 * MIN)).toBe(true);
    expect(log.refused('a1', 'u1', 'agents.delete', T + 25 * 60 * MIN)).toBe(true);
  });

  it('each guest and each agent counts on its own', () => {
    const log = new GuestConsoleLog();
    expect(log.opened('a1', 'u1', T)).toBe(true);
    expect(log.opened('a1', 'u2', T)).toBe(true);
    expect(log.opened('a2', 'u1', T)).toBe(true);
    expect(log.opened('a1', 'u1', T + 30 * MIN)).toBe(false);
    expect(log.opened('a1', 'u1', T + 61 * MIN)).toBe(true);
  });

  it('made-up method names cannot flood the history: ten a day, the rest one "other" line (review, 2026-10-22)', () => {
    const log = new GuestConsoleLog();
    const recorded: string[] = [];
    for (let i = 0; i < 500; i++) { const r = log.refusal('a1', 'u1', `made.up${i}`, T + i); if (r) recorded.push(r); }
    expect(recorded.length).toBe(NAMES_PER_DAY + 1); // was 500, past the 200 the timeline keeps
    expect(recorded.at(-1)).toBe(OTHER_METHODS);
    // Not shaped like a method name: folded too.
    expect(new GuestConsoleLog().refusal('a1', 'u1', '<script>', T)).toBe(OTHER_METHODS);
    // Another guest has its own ten; a new day starts again.
    expect(log.refusal('a1', 'u2', 'made.up1', T)).toBe('made.up1');
    expect(log.refusal('a1', 'u1', 'made.up600', T + 25 * 60 * MIN)).toBe('made.up600');
  });

  it('remembers at most MAX_KEYS entries', () => {
    const log = new GuestConsoleLog();
    for (let i = 0; i < MAX_KEYS + 500; i++) log.opened('a1', `u${i}`, T);
    // The oldest were forgotten, so u0 counts as a new visit; the newest is still remembered.
    expect(log.opened('a1', 'u0', T + MIN)).toBe(true);
    expect(log.opened('a1', `u${MAX_KEYS + 499}`, T + MIN)).toBe(false);
  });
});
