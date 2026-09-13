// Hatchabot was released under the name AgentClaw; installs from before the
// rename still carry AGENTCLAW_* keys in their env files. Alias them to the
// HATCHABOT_* names the code reads, without overriding a value that is
// already set under the new name. Called first thing in every entry point.
export const LEGACY_ENV_PREFIX = 'AGENTCLAW_';
export const ENV_PREFIX = 'HATCHABOT_';

export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const aliased: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const modern = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    if (env[modern] === undefined) {
      env[modern] = value;
      aliased.push(modern);
    }
  }
  return aliased;
}

// Runs on import so every module evaluated after this one sees the aliases —
// entry points import this file FIRST (ESM hoists imports above any call).
applyLegacyEnv();

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Default DB path: the new name, unless only the pre-rename file exists — an
 * in-place upgrade must open the registry it already has, never a fresh one.
 */
export function defaultDbPath(dataDir = 'data'): string {
  const modern = join(dataDir, 'hatchabot.sqlite');
  const legacy = join(dataDir, 'agentclaw.sqlite');
  return !existsSync(modern) && existsSync(legacy) ? legacy : modern;
}

/** Default backups dir, same rule: prefer the old dir when only it exists. */
export function defaultBackupsDir(): string {
  const modern = join(homedir(), 'hatchabot-backups');
  const legacy = join(homedir(), 'agentclaw-backups');
  return !existsSync(modern) && existsSync(legacy) ? legacy : modern;
}
