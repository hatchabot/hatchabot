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
