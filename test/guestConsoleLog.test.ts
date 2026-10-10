import { describe, expect, it } from 'vitest';
import { CONSOLE_STARTUP_CALLS, GuestConsoleLog } from '../src/api/guestConsoleLog.js';

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
});
