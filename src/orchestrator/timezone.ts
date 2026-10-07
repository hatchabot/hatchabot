/**
 * The time zone agents live in: OpenClaw's `agents.defaults.userTimezone`
 * (message timestamps, schedules, dated files, and "now" in the agent's prompt)
 * and the container's `TZ` (its shell's clock). Unset, OpenClaw falls back to
 * the process zone, which in a container is UTC: an owner in Toronto saw every
 * agent four hours off (2026-10-07).
 *
 * HATCHABOT_TIMEZONE (an IANA name) sets it; otherwise it is this machine's own.
 */

/** True for a zone name this runtime knows (IANA, e.g. "America/Toronto"). */
export function validTimeZone(tz: string): boolean {
  if (!tz || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$|^UTC$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** This machine's own zone ("UTC" when it can't tell). */
export function machineTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && validTimeZone(tz) ? tz : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** The zone every agent is given: HATCHABOT_TIMEZONE when valid, else the machine's. */
export function agentTimeZone(env: NodeJS.ProcessEnv = process.env): string {
  const set = (env.HATCHABOT_TIMEZONE ?? '').trim();
  return set && validTimeZone(set) ? set : machineTimeZone();
}
