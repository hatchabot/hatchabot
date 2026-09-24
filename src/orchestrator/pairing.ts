/**
 * OpenClaw's pending console-pairing requests, read where each version keeps
 * them: 2026.7 and earlier in `~/.openclaw/devices/pending.json`; 2026.9 in
 * the state database (`~/.openclaw/state/openclaw.sqlite`, table
 * `device_pairing_pending`), with no file at all. The old fast path took the
 * missing file for "nothing pending" and never asked the CLI, so a 2026.9
 * console sat on "Approve this browser" for good (Cooking Teacher, 2026-09-24).
 */

export interface PendingPairing {
  requestId: string;
  /** When the request was made — or last refreshed by a page still waiting. */
  ts: number;
}

/** Printed when neither store exists: the caller asks the CLI instead. */
export const PAIRING_UNKNOWN = '__hb_pairing_unknown__';

/**
 * A shell that prints the pending requests as JSON (an array or an object of
 * rows, either way each row with `requestId` and `ts`), or PAIRING_UNKNOWN
 * when it could not tell.
 */
export function pendingPairingShell(): string {
  const json = '"$HOME/.openclaw/devices/pending.json"';
  const db = '"$HOME/.openclaw/state/openclaw.sqlite"';
  const node = [
    'const {DatabaseSync}=require("node:sqlite");',
    'const db=new DatabaseSync(process.argv[1],{readOnly:true});',
    'const rows=db.prepare("select request_id,ts,refreshed_at_ms from device_pairing_pending").all();',
    'process.stdout.write(JSON.stringify(rows.map(r=>({requestId:r.request_id,ts:Math.max(Number(r.ts)||0,Number(r.refreshed_at_ms)||0)}))));',
  ].join('');
  // Single quotes inside the node script would end the shell quoting; there are none.
  return `if [ -f ${json} ]; then cat ${json}; elif [ -f ${db} ]; then node -e '${node}' ${db} 2>/dev/null || echo ${PAIRING_UNKNOWN}; else echo ${PAIRING_UNKNOWN}; fi`;
}

/**
 * The rows out of either store, or undefined when the shell learned nothing
 * (no store, unreadable, a shape we do not know) — then ask the CLI.
 */
export function parsePendingPairing(stdout: string): PendingPairing[] | undefined {
  const s = stdout.trim();
  if (!s || s === PAIRING_UNKNOWN) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(s); } catch { return undefined; }
  const rows = (Array.isArray(parsed) ? parsed : Object.values((parsed ?? {}) as Record<string, unknown>)) as Array<Record<string, unknown>>;
  if (!rows.every((r) => r && typeof r === 'object' && typeof r.requestId === 'string' && typeof (r.ts ?? r.createdAtMs) === 'number')) return undefined;
  return rows.map((r) => ({ requestId: r.requestId as string, ts: (r.ts ?? r.createdAtMs) as number }));
}
