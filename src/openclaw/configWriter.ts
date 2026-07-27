import type { OpenClawConfigPatch } from '../providers/provider.js';

/**
 * openclaw.json is volatile — its schema moves between releases, and Chris's
 * own file already carries a dozen keys we have no business owning. So we do
 * NOT template the whole file. Instead we emit the smallest possible set of
 * `openclaw config set` commands touching only the four things AgentClaw is
 * actually responsible for:
 *
 *   agents.list[]                       — register the agent
 *   channels.telegram.accounts.<id>     — bot token + DM policy + allowlist
 *   bindings[]                          — route (channel, account) -> agent
 *   agents.defaults.model               — from the AI Profile
 *
 * Everything else in the file stays exactly as OpenClaw's own defaults and the
 * user's edits left it. If the schema shifts under us, the blast radius is
 * these four paths, not the entire config.
 *
 * Paths verified against openclaw@2026.6.11.
 */

export interface ConfigCommand {
  /** Argv for the `openclaw` CLI, minus the leading binary name. */
  argv: string[];
  /** True when the value is a secret and must be redacted in logs. */
  sensitive?: boolean;
}

export function buildConfigCommands(patch: OpenClawConfigPatch): ConfigCommand[] {
  const cmds: ConfigCommand[] = [];

  // Register the agent. `openclaw agents add` owns the workspace scaffolding,
  // so we let it create the directory rather than writing agents.list directly.
  cmds.push({ argv: ['agents', 'add', patch.agentId] });

  if (patch.model) {
    cmds.push({ argv: ['config', 'set', 'agents.defaults.model', patch.model] });
  }

  if (patch.telegram) {
    const { accountId, botToken, allowFrom } = patch.telegram;
    const base = `channels.telegram.accounts.${accountId}`;
    cmds.push({ argv: ['config', 'set', 'channels.telegram.enabled', 'true'] });
    cmds.push({ argv: ['config', 'set', `${base}.enabled`, 'true'] });
    cmds.push({ argv: ['config', 'set', `${base}.botToken`, botToken], sensitive: true });
    // Dedicated bot per agent (§9.6) + members-only access (§12.4): the bot is
    // reachable by anyone who finds it, so the allowlist is the access control.
    cmds.push({
      argv: ['config', 'set', `${base}.dmPolicy`, JSON.stringify({ allowFrom })],
    });
    cmds.push({
      argv: [
        'config',
        'set',
        'bindings',
        JSON.stringify([
          {
            type: 'route',
            agentId: patch.agentId,
            match: { channel: 'telegram', accountId },
          },
        ]),
        '--append',
      ],
    });
  }

  return cmds;
}

/** Renders the commands for logging, with secrets masked. */
export function describeConfigCommands(cmds: ConfigCommand[]): string[] {
  return cmds.map((c) => {
    const argv = c.sensitive ? [...c.argv.slice(0, -1), '<redacted>'] : c.argv;
    return `openclaw ${argv.join(' ')}`;
  });
}
