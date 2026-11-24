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
  // A name only (no offsets, no paths), then the runtime's own list decides:
  // digits in the first part are fine (EST5EDT, CST6CDT; audit 2026-10-22).
  if (!tz || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * True for any zone Intl takes, offsets too ("+05:00", "-0800"): what a
 * scheduled task's zone is read with by the gateway's parser (croner), so a
 * template's task is held to this, not to validTimeZone (HB-1018).
 * validTimeZone stays a name only: the zone it passes becomes a container's
 * TZ, where an offset means something else. Trimmed first, as the gateway
 * trims it (" UTC" is UTC).
 */
export function zoneIntlTakes(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
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
