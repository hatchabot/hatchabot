/**
 * The biggest file an agent may send on each messaging app, in MB: each app's
 * own limit, the machine's setting (HATCHABOT_FILES_MB_*), and an agent's
 * override. Set in the app under Defaults for this machine
 * (orchestrator/settings/machineDefaults.ts); written into each agent's OpenClaw config
 * (openclaw/configWriter.ts).
 */
export type ChannelKindForFiles = 'telegram' | 'discord' | 'slack';
/** What each app accepts at most (Telegram's Bot API; a Discord server at its highest boost; Slack held well below its 1 GB). */
export const FILES_MB_MAX: Record<ChannelKindForFiles, number> = { telegram: 50, discord: 500, slack: 1000 };
/** The default ceiling: each app's own limit for an ordinary account (a Discord server without boosts is 10). */
export const FILES_MB_DEFAULT: Record<ChannelKindForFiles, number> = { telegram: 50, discord: 10, slack: 100 };
export const filesEnv = (kind: ChannelKindForFiles) => `HATCHABOT_FILES_MB_${kind.toUpperCase()}`;

/** The biggest file an agent may send on this app, in MB: its own override, else the machine's, else the default — never past the app's limit. */
export function filesMb(kind: ChannelKindForFiles, agentOverride?: number, env: NodeJS.ProcessEnv = process.env): number {
  const set = Number(env[filesEnv(kind)]);
  const base = Number.isInteger(set) && set >= 1 ? set : FILES_MB_DEFAULT[kind];
  const want = agentOverride && Number.isInteger(agentOverride) && agentOverride >= 1 ? agentOverride : base;
  return Math.min(Math.max(1, want), FILES_MB_MAX[kind]);
}
