import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The note "public access is being turned on" (docs/public-access.md,
 * "A crash while switching"). Turning it on is several steps in two places
 * that cannot change together: Tailscale's Funnel entry, and the setting in
 * .env. This file is written BEFORE the first of them and removed after the
 * last, so a process that dies anywhere in between leaves a note of what it
 * was doing, and the next start (or `hatchabot doctor`) can take all of it
 * back: Funnel's entry, the setting, the address.
 *
 * It sits beside the .env the service reads, because that is the one place
 * the running app and the doctor (which runs without the app) both know.
 */
export interface PublicIntent {
  /** When the switch began (ISO). */
  at: string;
  /** The public listener's port and Funnel's port this switch was for. */
  port: number;
  funnelPort: number;
  pid: number;
}

export const envFilePath = (env: NodeJS.ProcessEnv = process.env): string => env.HATCHABOT_ENV_FILE ?? join(process.cwd(), '.env');
export const publicIntentPath = (envPath: string = envFilePath()): string => `${envPath}.public-access-pending`;

export function writePublicIntent(intent: Omit<PublicIntent, 'at' | 'pid'>, envPath: string = envFilePath()): void {
  // Only beside a .env that exists: no .env means the setting could not be saved either.
  statSync(envPath);
  writeFileSync(publicIntentPath(envPath), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...intent }), { mode: 0o600 });
}

/** The note, if there is one. A file that cannot be parsed still counts: something began and did not finish. */
export function readPublicIntent(envPath: string = envFilePath()): Partial<PublicIntent> | undefined {
  let raw: string;
  try { raw = readFileSync(publicIntentPath(envPath), 'utf8'); } catch { return undefined; }
  try {
    const v = JSON.parse(raw) as Partial<PublicIntent> | null;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

export function clearPublicIntent(envPath: string = envFilePath()): void {
  rmSync(publicIntentPath(envPath), { force: true });
}

/** A switch takes seconds. A note older than this is a switch that died, not one in progress. */
export const PUBLIC_INTENT_STALE_MS = 5 * 60_000;
export function publicIntentIsStale(intent: Partial<PublicIntent>, now = Date.now()): boolean {
  const at = Date.parse(String(intent.at ?? ''));
  return !Number.isFinite(at) || now - at > PUBLIC_INTENT_STALE_MS || at > now + 60_000;
}
