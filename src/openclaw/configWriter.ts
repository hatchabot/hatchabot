import type { OpenClawConfigPatch } from '../providers/provider.js';

/**
 * openclaw.json is volatile — its schema moves between releases, and a
 * user's own file already carries a dozen keys we have no business owning. So we do
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
  /** Piped to the command's stdin (e.g. `models auth paste-token`). */
  stdin?: string;
  /**
   * Verbatim shell line to run INSTEAD of the openclaw invocation — the
   * escape hatch for state the CLI has no verb for. Must be a static string
   * (no interpolated values).
   */
  rawShell?: string;
  /** True when the value is a secret and must be redacted in logs. */
  sensitive?: boolean;
}

export const WORKSPACE_DIR_TEMPLATE = '/home/node/.openclaw/agents/{slug}/agent';

/**
 * Collapse consecutive plain `config set` commands into one `--batch-json`
 * invocation. Each `openclaw` start costs ~600ms inside the runtime, and a
 * seed issues a dozen of them — batching turns ~7.5s of process startup into
 * one call. Order is preserved, and anything that is not a plain set (agents
 * add, paste-token, the heal script) breaks the run, so semantics are
 * unchanged.
 */
export function batchConfigCommands(cmds: ConfigCommand[]): ConfigCommand[] {
  const out: ConfigCommand[] = [];
  let run: Array<{ path: string; value: unknown; raw: string }> = [];
  let sensitive = false;

  /**
   * The single-set form hands OpenClaw a string it parses as JSON5; batch
   * mode takes `value` literally, so an object must be passed as an object or
   * it lands in the config as a string ("expected record, received string").
   */
  const asValue = (raw: string): unknown => {
    // JSON.parse IS the discriminator, matching the single-set form's JSON5
    // parse-with-string-fallback: '{"a":1}' → object, 'true' → boolean,
    // '["*"]' → array, but 'local'/'loopback'/'none' stay strings.
    try {
      return JSON.parse(raw.trim());
    } catch {
      return raw;
    }
  };

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      // A single set uses the plain form, which wants the original string —
      // OpenClaw parses it as JSON5 itself.
      const only = run[0]!;
      out.push({ argv: ['config', 'set', only.path, only.raw, '--replace'], sensitive });
    } else {
      out.push({
        argv: [
          'config',
          'set',
          '--batch-json',
          JSON.stringify(run.map(({ path, value }) => ({ path, value }))),
          '--replace',
        ],
        sensitive,
      });
    }
    run = [];
    sensitive = false;
  };

  for (const c of cmds) {
    const plainSet =
      !c.rawShell &&
      !c.stdin &&
      c.argv[0] === 'config' &&
      c.argv[1] === 'set' &&
      typeof c.argv[2] === 'string' &&
      typeof c.argv[3] === 'string' &&
      c.argv[2] !== '--batch-json';
    if (plainSet) {
      run.push({ path: c.argv[2]!, value: asValue(c.argv[3]!), raw: c.argv[3]! });
      sensitive ||= !!c.sensitive;
      continue;
    }
    flush();
    out.push(c);
  }
  flush();
  return out;
}

export function buildConfigCommands(patch: OpenClawConfigPatch): ConfigCommand[] {
  const cmds: ConfigCommand[] = [];
  const workspaceDir = WORKSPACE_DIR_TEMPLATE.replace('{slug}', patch.agentId);

  // Gateway must run headless inside the runtime. With a gatewayToken the
  // gateway binds 0.0.0.0 behind token auth so the host can publish its port
  // (the per-agent Control UI debug button). Without one: loopback-only + no
  // auth, which is fine because nothing else lives in the container's netns.
  // Web search: the stock DuckDuckGo provider is disabled by default, so the
  // web_search tool tells every agent "search is not available" and answers
  // quietly degrade to model knowledge. DDG is free and keyless — enable it
  // for every agent. (Owners wanting better results can enable Brave with a
  // BRAVE_API_KEY via the agent's Environment tab; a keyed provider outranks
  // the DDG fallback in OpenClaw's auto-detection.) Naturally re-runnable.
  // FIRST in the list: the `config set` runs below batch into one invocation
  // only while they stay consecutive.
  cmds.push({ argv: ['plugins', 'enable', 'duckduckgo'] });

  cmds.push({ argv: ['config', 'set', 'gateway.mode', 'local'] });
  // Memory search: OpenClaw's default points at OpenAI embeddings, which no
  // AgentClaw agent has a key for — so semantic recall over MEMORY.md was
  // silently dead fleet-wide (doctor flagged it once the lint sweep landed).
  // The bundled local embedding model needs no key and no network at query
  // time; keyed remote embeddings stay a per-agent choice via config.
  cmds.push({ argv: ['config', 'set', 'agents.defaults.memorySearch.provider', 'local'] });
  if (patch.gatewayToken) {
    cmds.push({ argv: ['config', 'set', 'gateway.auth.mode', 'token'] });
    cmds.push({
      argv: ['config', 'set', 'gateway.auth.token', patch.gatewayToken],
      sensitive: true,
    });
    cmds.push({ argv: ['config', 'set', 'gateway.bind', 'auto'] });
    // The Control UI additionally allowlists browser origins, but the page's
    // origin depends on how the owner reaches the box (localhost, tailnet
    // name, LAN IP) — unknowable at seed time. "*" disables that check; the
    // per-agent token remains the actual gate, and a drive-by page without
    // it still can't connect. (OpenClaw's security audit flags this — known.)
    cmds.push({
      argv: ['config', 'set', 'gateway.controlUi.allowedOrigins', '["*"]'],
    });
  } else {
    cmds.push({ argv: ['config', 'set', 'gateway.auth.mode', 'none'] });
    cmds.push({ argv: ['config', 'set', 'gateway.bind', 'loopback'] });
  }

  // Model refs are `<provider>/<model>`. A local server is its own provider,
  // so the prefix — and everything downstream — follows it.
  const provider = patch.provider ?? 'anthropic';
  const prefixedModel = patch.model ? `${provider}/${patch.model}` : undefined;

  if (provider === 'ollama') {
    // Drop any Anthropic auth profile a previous config left behind. Same
    // lesson as the import fix: a stale profile the gateway might prefer is
    // exactly how "configured correctly but fails at runtime" happens.
    cmds.push({ argv: ['config', 'set', 'auth.profiles', '{}', '--replace'] });
    // OpenClaw talks to Ollama over its OpenAI-compatible endpoint. baseUrl
    // must be reachable FROM THE CONTAINER: the host's loopback is not.
    cmds.push({
      argv: [
        'config',
        'set',
        'models.providers.ollama',
        JSON.stringify({
          baseUrl: patch.baseUrl ?? 'http://172.17.0.1:11434/v1',
          apiKey: 'ollama-local', // required by the OpenAI shape; unused locally
          api: 'openai-completions',
        }),
        '--replace',
      ],
    });
  } else {
    // Moving OFF a local profile must not leave the old server configured —
    // the same "stale config the gateway might prefer" class we keep hitting.
    cmds.push({ argv: ['config', 'set', 'models.providers.ollama', '{}', '--replace'] });
  }

  // Runtime-wide default model. Without it, OpenClaw's OWN default agent
  // "main" (which the Control UI lands on) falls back to the factory default
  // (openai/gpt-*) and fails with missing-provider-auth.
  if (prefixedModel) {
    cmds.push({ argv: ['config', 'set', 'agents.defaults.model.primary', prefixedModel] });
  }
  // Primary first, deduped: patch.models may or may not repeat patch.model.
  const allModels = [
    ...new Set([patch.model, ...(patch.models ?? [])].filter((m): m is string => !!m)),
  ].map((m) => `${provider}/${m}`);

  if (provider === 'anthropic' && patch.authMode === 'oauth-claude-cli' && patch.setupToken) {
    // Subscription via a `claude setup-token` token (macOS hosts — the login
    // lives in the Keychain, so there is no ~/.claude to mount). The gateway
    // ignores ambient env for auth; the token must live in ITS auth store.
    // The explicit auth.profiles set drops any imported claude-cli profile,
    // which the gateway would otherwise prefer and fail on. The paste-token
    // command itself is appended AFTER `agents add` below: auth stores are
    // per-agent, and without --agent the token lands in agent "main" while
    // turns run as the bound agent (verified on 2026.7.1-2).
    cmds.push({
      argv: [
        'config',
        'set',
        'auth.profiles',
        JSON.stringify({ 'anthropic:manual': { provider: 'anthropic', mode: 'token' } }),
        '--replace',
      ],
    });
  } else if (provider === 'anthropic' && patch.authMode === 'oauth-claude-cli') {
    // Subscription path: OpenClaw drives the Claude Code CLI, which reads the
    // OAuth credential from the mounted ~/.claude. --replace for the same
    // reason as the token branch: an imported volume may carry the OTHER auth
    // mode's profile, and this installation's mode wins.
    cmds.push({
      argv: [
        'config',
        'set',
        'auth.profiles',
        JSON.stringify({ 'anthropic:claude-cli': { provider: 'claude-cli', mode: 'oauth' } }),
        '--replace',
      ],
    });
  }

  if (allModels.length) {
    // The /model picker in chat lists configured models, so every switchable
    // model needs its entry here. Under subscription auth each one also rides
    // the claude-cli runtime — without that a model is listed but unusable.
    // (agents.defaults.modelPolicy would be the precise allowlist, but
    // 2026.6.11 rejects the key: "Unrecognized key: modelPolicy".)
    // Only the Anthropic subscription path rides the claude-cli runtime; a
    // local model is served directly by its provider.
    const entry =
      provider === 'anthropic' && patch.authMode === 'oauth-claude-cli' && !patch.setupToken
        ? { agentRuntime: { id: 'claude-cli' } }
        : {};
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
    // Seed allowFrom in pairing mode too: on a rebuilt/imported volume the
    // known members must not land back in pairing-pending. (Was previously
    // allowlist-only — members silently dropped on rebuild.)
    if (allowFrom?.length || dmPolicy === 'allowlist') account.allowFrom = allowFrom ?? [];
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
  // Deliberately NO --model: a per-agent model would be a frozen copy that
  // survives migration and defeats profile edits. Agents follow the
  // re-applied agents.defaults.model.primary — one source of truth.
  if (patch.telegram) add.push('--bind', `telegram:${patch.telegram.accountId}`);
  cmds.push({ argv: add });

  // Heal volumes seeded before this rule (and imported ones): strip any
  // frozen per-agent model so the default actually governs.
  cmds.push({
    argv: [],
    rawShell: `node -e 'const fs=require("fs");const f="/home/node/.openclaw/openclaw.json";const c=JSON.parse(fs.readFileSync(f,"utf8"));let n=0;for(const a of (c.agents&&c.agents.list)||[]){if(a.model){delete a.model;n++}}if(n)fs.writeFileSync(f,JSON.stringify(c,null,2));'`,
  });

  if (provider === 'anthropic' && patch.authMode === 'oauth-claude-cli' && patch.setupToken) {
    cmds.push({
      argv: [
        'models', 'auth', '--agent', patch.agentId,
        'paste-token', '--provider', 'anthropic', '--expires-in', '365d',
      ],
      stdin: patch.setupToken,
      sensitive: true,
    });
    // Also into the default agent "main"'s store — the Control UI lands
    // there, and auth stores are per-agent.
    cmds.push({
      argv: ['models', 'auth', 'paste-token', '--provider', 'anthropic', '--expires-in', '365d'],
      stdin: patch.setupToken,
      sensitive: true,
    });
  }

  return cmds;
}

/** Renders the commands for logging, with secrets masked. */
export function describeConfigCommands(cmds: ConfigCommand[]): string[] {
  return cmds.map((c) => {
    if (c.rawShell) return `sh: ${c.rawShell}`;
    // stdin-fed secrets never appear in argv — mask the pipe, not the args.
    if (c.stdin) return `<redacted> | openclaw ${c.argv.join(' ')}`;
    if (!c.sensitive) return `openclaw ${c.argv.join(' ')}`;
    // A batch carries its values INSIDE the JSON payload, so masking the last
    // argument (as the single-set form does) would leave secrets in the log.
    const batchAt = c.argv.indexOf('--batch-json');
    if (batchAt !== -1) {
      const argv = [...c.argv];
      argv[batchAt + 1] = '<redacted>';
      return `openclaw ${argv.join(' ')}`;
    }
    return `openclaw ${[...c.argv.slice(0, -1), '<redacted>'].join(' ')}`;
  });
}
