/**
 * The model-call lines of an agent's gateway log, as the usage pass reads
 * them: which lines are calls, and the cursor key each one sorts by. Here so
 * the provider's log read (localDockerProvider.modelCallLog) and the sampler
 * (orchestrator/usage/sourceUsage.ts, parseModelCalls) count the same calls:
 * a read cut short is kept only when it holds a call the sampler will count,
 * after the cursor (HB-1064).
 */

/**
 * A stamp as a cursor that sorts as text: the fraction padded to nine digits
 * (docker trims trailing zeros). A cursor stored with milliseconds only (before
 * v2.160.0) stands for the whole of its millisecond, as it was read then.
 */
export function logKey(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(iso);
  if (!m) return new Date(iso).toISOString().replace('Z', '000000Z');
  const frac = m[2] ?? '';
  return `${m[1]}.${frac.length === 3 ? `${frac}999999` : frac.padEnd(9, '0').slice(0, 9)}Z`;
}

/** The key of docker's own stamp on a line: its nanoseconds, padded to nine digits. */
export function stampKey(stamp: string): string {
  const frac = /\.(\d+)Z$/.exec(stamp)?.[1] ?? '';
  return `${stamp.replace(/(\.\d+)?Z$/, '')}.${frac.padEnd(9, '0').slice(0, 9)}Z`;
}

// docker logs --timestamps prefixes each line with its RFC3339 time; OpenClaw's
// line then reads "<its own time> [provider-transport-fetch] [model-fetch]
// response provider=… model=… status=429 elapsedMs=…". Start lines (no status)
// are ignored. The marker must open the line (after at most OpenClaw's time and
// its subsystem tags): one quoted inside another line — a message, a tool's
// output an agent logged — is not a call, and counted as one it skewed the
// owner's refusals (HB-0005).
export const CALL_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(?:\d{4}-\d{2}-\d{2}T\S+\s+)?(?:\[[\w.:-]+\]\s+){0,3}\[model-fetch\] response provider=(\S+)(?:.*?\smodel=(\S+))?.*?\sstatus=(\d{3})\b/;
