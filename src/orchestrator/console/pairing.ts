/**
 * OpenClaw's pending console-pairing requests, read where each version keeps
 * them: 2026.7 and earlier in `~/.openclaw/devices/pending.json`; 2026.9 in
 * the state database (`~/.openclaw/state/openclaw.sqlite`, table
 * `device_pairing_pending`), with no file at all. The old fast path took the
 * missing file for "nothing pending" and never asked the CLI, so a 2026.9
 * console sat on "Approve this browser" for good (one agent, 2026-09-24).
 */

export interface PendingPairing {
  requestId: string;
  /** When the request was made — or last refreshed by a page still waiting. */
  ts: number;
}

/** Printed when neither store exists: the caller asks the CLI instead. */
export const PAIRING_UNKNOWN = '__hb_pairing_unknown__';

/**
 * A shell that prints the pending requests as JSON (an array of rows, each
 * with `requestId` and `ts`), or PAIRING_UNKNOWN when it could not tell.
 *
 * Both stores, not whichever exists: a 2026.9 volume can keep the 2026.7 file
 * its upgrade left in place, and taken alone because it was there, an old
 * `{}` hid every request in the database, and the console sat on "Approve
 * this browser" with nothing to approve (HB-0935; the channel requests' reader
 * does the same, claim.ts `pairingListShell`). The database's rows come
 * first, then the file's not already listed. A database that has the table
 * but cannot be read is "ask the CLI", whatever the file says; one without
 * the table holds no requests (2026.7 keeps them in the file).
 */
export function pendingPairingShell(): string {
  const json = '"$HOME/.openclaw/devices/pending.json"';
  const db = '"$HOME/.openclaw/state/openclaw.sqlite"';
  const node = [
    'const fs=require("fs");const out=[];const seen=new Set();let known=false,unsure=false;',
    'const add=(id,ts)=>{if(typeof id==="string"&&!seen.has(id)){seen.add(id);out.push({requestId:id,ts})}};',
    'if(fs.existsSync(process.argv[2])){try{const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[2],{readOnly:true});',
    'try{if(db.prepare("select 1 from sqlite_master where type=? and name=?").get("table","device_pairing_pending")){',
    'for(const r of db.prepare("select request_id,ts,refreshed_at_ms from device_pairing_pending").all())add(r.request_id,Math.max(Number(r.ts)||0,Number(r.refreshed_at_ms)||0));known=true}}',
    'finally{try{db.close()}catch(e){}}}catch(e){unsure=true}}',
    'if(fs.existsSync(process.argv[1])){try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const rows=Array.isArray(d)?d:Object.values(d||{});',
    'if(rows.every(r=>r&&typeof r==="object"&&typeof r.requestId==="string"&&typeof (r.ts??r.createdAtMs)==="number")){for(const r of rows)add(r.requestId,r.ts??r.createdAtMs);known=true}}catch(e){}}',
    `process.stdout.write(known&&!unsure?JSON.stringify(out):"${PAIRING_UNKNOWN}");`,
  ].join('');
  // Single quotes inside the node script would end the shell quoting; there are none.
  return `node -e '${node}' ${json} ${db} 2>/dev/null || echo ${PAIRING_UNKNOWN}`;
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
