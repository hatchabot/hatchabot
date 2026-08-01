import type { OpenClawConfigPatch } from '../providers/provider.js';

/**
 * openclaw.json is volatile — its schema moves between releases, and Chris's
 * own file already carries a dozen keys we have no business owning. So we do
 * NOT template the whole file. Instead we emit the smallest possible set of
 * `openclaw` CLI commands touching only the paths AgentClaw is responsible for:
 *
 *   openclaw agents add …                 — agent + workspace + model + binding
 *   channels.telegram.accounts.<id>       — bot token + DM policy
 *   agents.defaults.models.<model>        — switchable models (/model picker);
 *                                           claude-cli runtime for subscription auth
 *   auth.profiles                         — oauth profile for subscription auth
 *   gateway.mode / gateway.auth           — headless gateway inside the runtime
 *
 * Everything else in the file stays exactly as OpenClaw's own defaults leave
 * it. If the schema shifts under us, the blast radius is these paths, not the
 * entire config.
 *
 * Syntax verified against openclaw@2026.6.11:
 *   - `agents add [name] --non-interactive --workspace <dir> --model <id>
 *      --bind channel:accountId`
 *   - `config set <dot.path> <json5-or-raw-value>`
 *   - dmPolicy is a string ("pairing" | "allowlist" | "open") with a sibling
 *     allowFrom array — NOT a nested object.
 *   - Anthropic-via-subscription = model "anthropic/<id>" with
 *     agents.defaults.models["anthropic/<id>"].agentRuntime.id = "claude-cli"
 *     plus auth profile {provider: "claude-cli", mode: "oauth"}.
 */

export interface ConfigCommand {
  /** Argv for the `openclaw` CLI, minus the leading binary name. */
  argv: string[];
  /** True when the value is a secret and must be redacted in logs. */
  sensitive?: boolean;
}

export const WORKSPACE_DIR_TEMPLATE = '/home/node/.openclaw/agents/{slug}/agent';

export function buildConfigCommands(patch: OpenClawConfigPatch): ConfigCommand[] {
  const cmds: ConfigCommand[] = [];
  const workspaceDir = WORKSPACE_DIR_TEMPLATE.replace('{slug}', patch.agentId);

  // Gateway must run headless inside the runtime. Loopback-only + no auth is
  // fine because nothing else lives in the container's network namespace.
  // bind must be pinned: in a container OpenClaw defaults to bind=auto
  // (0.0.0.0) and then refuses to start unauthenticated.
  cmds.push({ argv: ['config', 'set', 'gateway.mode', 'local'] });
  cmds.push({ argv: ['config', 'set', 'gateway.auth.mode', 'none'] });
  cmds.push({ argv: ['config', 'set', 'gateway.bind', 'loopback'] });

  const prefixedModel = patch.model ? `anthropic/${patch.model}` : undefined;
  // Primary first, deduped: patch.models may or may not repeat patch.model.
  const allModels = [
    ...new Set([patch.model, ...(patch.models ?? [])].filter((m): m is string => !!m)),
  ].map((m) => `anthropic/${m}`);

  if (patch.authMode === 'oauth-claude-cli') {
    // Subscription path: OpenClaw drives the Claude Code CLI, which reads the
    // OAuth credential from the mounted ~/.claude.
    cmds.push({
      argv: [
        'config',
        'set',
        'auth.profiles',
        JSON.stringify({ 'anthropic:claude-cli': { provider: 'claude-cli', mode: 'oauth' } }),
      ],
    });
  }

  if (allModels.length) {
    // The /model picker in chat lists configured models, so every switchable
    // model needs its entry here. Under subscription auth each one also rides
    // the claude-cli runtime — without that a model is listed but unusable.
    // (agents.defaults.modelPolicy would be the precise allowlist, but
    // 2026.6.11 rejects the key: "Unrecognized key: modelPolicy".)
    const entry = patch.authMode === 'oauth-claude-cli' ? { agentRuntime: { id: 'claude-cli' } } : {};
    // --replace: this path is AgentClaw-owned (the profile is the source of
    // truth), and without it OpenClaw refuses a set that would drop entries —
    // e.g. re-seeding an imported volume whose old install had more models.
    cmds.push({
      argv: [
        'config',
        'set',
        'agents.defaults.models',
        JSON.stringify(Object.fromEntries(allModels.map((m) => [m, entry]))),
        '--replace',
      ],
    });
  }

  if (patch.telegram) {
    const { accountId, botToken, dmPolicy, allowFrom } = patch.telegram;
    cmds.push({ argv: ['config', 'set', 'channels.telegram.enabled', 'true'] });
    // One JSON set for the whole account object keeps the command count down
    // and matches the shape observed in a live 2026.6.11 config.
    const account: Record<string, unknown> = {
      enabled: true,
      botToken,
      dmPolicy,
    };
    if (dmPolicy === 'allowlist') account.allowFrom = allowFrom ?? [];
    cmds.push({
      argv: [
        'config',
        'set',
        `channels.telegram.accounts.${accountId}`,
        JSON.stringify(account),
      ],
      sensitive: true,
    });
  }

  // Last: `agents add` scaffolds the workspace, sets the agent's model, and
  // writes the route binding in one go.
  const add = [
    'agents',
    'add',
    patch.agentId,
    '--non-interactive',
    '--workspace',
    workspaceDir,
  ];
  if (prefixedModel) add.push('--model', prefixedModel);
  if (patch.telegram) add.push('--bind', `telegram:${patch.telegram.accountId}`);
  cmds.push({ argv: add });

  return cmds;
}

/** Renders the commands for logging, with secrets masked. */
export function describeConfigCommands(cmds: ConfigCommand[]): string[] {
  return cmds.map((c) => {
    const argv = c.sensitive ? [...c.argv.slice(0, -1), '<redacted>'] : c.argv;
    return `openclaw ${argv.join(' ')}`;
  });
}
