import type { ChannelRooms, OpenClawConfigPatch } from '../providers/provider.js';

/**
 * openclaw.json is volatile — its schema moves between releases, and a
 * user's own file already carries a dozen keys we have no business owning. So we do
 * NOT template the whole file. Instead we emit the smallest possible set of
 * `openclaw` CLI commands touching only the paths Hatchabot is responsible for:
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
  /**
   * Cosmetic: a failure must not fail the provision. The script runs under
   * `set -euo pipefail`, so without this a naming hiccup would abort a
   * rebuild and cost the owner their agent over a label.
   */
  optional?: boolean;
}

export const WORKSPACE_DIR_TEMPLATE = '/home/node/.openclaw/agents/{slug}/agent';

/**
 * Baked-image paths for local memory embeddings (docker/Dockerfile.runtime,
 * mirrored by the HATCHABOT_EMBED_* env). The plugin (with node-llama-cpp's
 * native addon) and the GGUF model live in the image, OUTSIDE /home/node, so
 * every agent shares one copy. Each agent's volume keeps only a tiny `--link`
 * registry pointer — no per-volume 71MB plugin, no per-volume 314MB model.
 * These MUST match the Dockerfile; a mismatch degrades semantic recall to FTS.
 */
export const EMBED_PLUGIN_DIR = '/opt/agentclaw/llama-cpp/llama-cpp-provider';

/**
 * Where OpenClaw keeps its memory-search settings: 2026.8 moved them from
 * `agents.defaults.memorySearch` to `memory.search`. One rule, here.
 */
export function memoryKeyPrefix(openclawVersion: string | undefined): string {
  const m = /^(\d{4})\.(\d+)/.exec(openclawVersion ?? '');
  const moved = !!m && (Number(m[1]) > 2026 || (Number(m[1]) === 2026 && Number(m[2]) >= 8));
  return moved ? 'memory.search' : 'agents.defaults.memorySearch';
}
export const EMBED_MODEL_PATH = '/opt/agentclaw/models/embeddinggemma-300m-qat-Q8_0.gguf';

/**
 * OpenClaw 2026.8+ (the 2026.9 port, docs/embedder-and-openclaw-port-design.md):
 * a volume written by 2026.7 needs healing before its CLI will run at all.
 * Found on the first 2026.9.6 candidate (2026-09-24): `meta.lastTouchedAt`
 * and `agents.defaults.memorySearch` are unrecognized keys that fail config
 * validation; a roster of more than one agent needs `agents.ownership =
 * "explicit"`; `agents.list` moved to keyed `agents.entries`; and the state
 * database wants a schema migration that only `openclaw doctor --fix` runs.
 */
export function needsPortHeal(version: string | undefined): boolean {
  return memoryKeyPrefix(version) === 'memory.search';
}
/** Where the image keeps a baked non-channel plugin (label org.hatchabot.plugins). */
export const bakedPluginDir = (id: string, pkg: string) => `/opt/hatchabot/plugins/${id}/node_modules/${pkg}`;
export const DUCKDUCKGO_PLUGIN_DIR = bakedPluginDir('duckduckgo', '@openclaw/duckduckgo-plugin');

/** Where the image keeps a baked messaging plugin (docker/Dockerfile.runtime). */
export const channelPluginDir = (kind: 'slack' | 'discord') => `/opt/hatchabot/plugins/${kind}/node_modules/@openclaw/${kind}`;
/** The one account key Hatchabot uses for Slack and Discord in OpenClaw's config. */
export const CHANNEL_ACCOUNT = 'hatchabot';

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
  // On the shared engine the image-baked plugin must not be LINKED any more:
  // the link (plugins.load.paths + the llama-cpp entry) survives on the
  // volume from when the agent was baked, and OpenClaw refuses the whole
  // config when a linked path is missing — which it is on an engine-free
  // image (found live, To Do Agent on the first -lite image, 2026-09-24). So
  // it is edited out of the JSON before any `openclaw` command runs, because
  // the CLI itself will not start on such a config. Harmless when the path
  // exists: a shared agent never loads that plugin.
  const baked = new Set(patch.bakedPlugins ?? []);
  const port = needsPortHeal(patch.openclawVersion);
  // Order matters, and every JSON edit comes before the first `openclaw`
  // command, because the CLI refuses to start on a config it cannot validate:
  //  1. the 2026.8+ heal (below) — keys 2026.9 no longer accepts;
  //  2. the shared-engine unlink — a linked path that is not on this image;
  //  3. doctor's own safe migrations (2026.8+): state database, agents.entries,
  //     device identity — the CLI refuses every command until they have run;
  //  4. a registry refresh after the unlink, so `doctor --post-upgrade` stops
  //     looking for the plugin that is gone.
  if (port) {
    // The baked web-search plugin is put on the load path here too, so doctor
    // finds it and does not go to npm for it (the seed one-shot may have no
    // network).
    cmds.push({
      argv: [],
      rawShell: `[ -f /home/node/.openclaw/openclaw.json ] && node -e 'const fs=require("fs");const f="/home/node/.openclaw/openclaw.json";const c=JSON.parse(fs.readFileSync(f,"utf8"));let n=0;if(c.meta&&"lastTouchedAt" in c.meta){delete c.meta.lastTouchedAt;n++}if(c.agents&&c.agents.defaults&&"memorySearch" in c.agents.defaults){delete c.agents.defaults.memorySearch;n++}c.agents=c.agents||{};if(c.agents.ownership!=="explicit"){c.agents.ownership="explicit";n++}${patch.pluginInstall === 'npm' ? `c.plugins=c.plugins||{};c.plugins.load=c.plugins.load||{};if(Array.isArray(c.plugins.load.paths)){const k=c.plugins.load.paths.filter(x=>x.indexOf("/opt/hatchabot/plugins/slack/")!==0&&x.indexOf("/opt/hatchabot/plugins/discord/")!==0);if(k.length!==c.plugins.load.paths.length){c.plugins.load.paths=k;n++}}` : ''}${baked.has('duckduckgo') ? `c.plugins=c.plugins||{};c.plugins.load=c.plugins.load||{};c.plugins.load.paths=Array.isArray(c.plugins.load.paths)?c.plugins.load.paths:[];if(!c.plugins.load.paths.includes("${DUCKDUCKGO_PLUGIN_DIR}")){c.plugins.load.paths.push("${DUCKDUCKGO_PLUGIN_DIR}");n++}` : ''}if(n)fs.writeFileSync(f,JSON.stringify(c,null,2));' || true`,
    });
  }
  if (patch.embed) {
    cmds.push({
      argv: [],
      rawShell: `[ -f /home/node/.openclaw/openclaw.json ] && node -e 'const fs=require("fs");const f="/home/node/.openclaw/openclaw.json";const c=JSON.parse(fs.readFileSync(f,"utf8"));const p=c.plugins||{};let n=0;if(p.load&&Array.isArray(p.load.paths)){const k=p.load.paths.filter(x=>x!=="${EMBED_PLUGIN_DIR}");if(k.length!==p.load.paths.length){p.load.paths=k;n++}}if(p.entries&&p.entries["llama-cpp"]){delete p.entries["llama-cpp"];n++}if(n)fs.writeFileSync(f,JSON.stringify(c,null,2));' || true`,
    });
  }
  // Twice: on the first 2026.9.6 candidate the first pass refused its
  // shared-auth-store step ("resolve the reported migration failure before
  // retrying") and the second pass then migrated everything (agent database
  // v1 → v23, shared auth, audit log, workspace state). Idempotent.
  if (port) for (let i = 0; i < 2; i++) cmds.push({ argv: ['doctor', '--fix', '--non-interactive'], optional: true });
  if (patch.embed) {
    cmds.push({ argv: ['plugins', 'registry', '--refresh'], optional: true });
    // The install record outlives the link and the registry refresh: on
    // 2026.9 `plugins list` then errors "install incomplete" for a plugin
    // that is not there (To Do Agent, 2026-09-24). Uninstall removes just
    // that record; nothing of the plugin is on the volume.
    cmds.push({ argv: ['plugins', 'uninstall', 'llama-cpp', '--force'], optional: true });
  }
  // `plugins install --link` on 2026.8+ refuses a local path until its three
  // "I mean it" options are given (2026.7 asked nothing for a link); the
  // Dockerfile reads them from `--help`, the writer knows them by version.
  const link = (dir: string): ConfigCommand => ({ argv: ['plugins', 'install', '--link', dir, ...(port ? ['--force', '--accept-capabilities', '--acknowledge-install-policy-warning'] : [])] });
  // 2026.8+ (image label plugin-install=npm): a channel plugin is installed
  // into the volume as the official npm package, offline from the cache the
  // image carries, so OpenClaw's trust model accepts it ("trusted-official";
  // a linked path is refused anything keyed — Taco Agent's Discord,
  // 2026-09-24). The version is the one baked beside the cache. Static text:
  // nothing of the agent's goes into the line. "Already installed" is a
  // refusal, not a failure; a real failure surfaces at `plugins enable`.
  const npmMode = patch.pluginInstall === 'npm';
  if (npmMode) {
    cmds.push({
      argv: [],
      // A missing cache must not end the seed here (`set -e` acts on the
      // last command of an && list): the install that needs it fails at its
      // own, named step instead.
      rawShell: `rm -rf /tmp/hb-npm-cache; cp -r /opt/hatchabot/npm-cache /tmp/hb-npm-cache 2>/dev/null || true; export npm_config_cache=/tmp/hb-npm-cache npm_config_offline=true npm_config_fetch_retries=0 npm_config_logs_dir=/tmp/hb-npm-logs`,
    });
  }
  // OpenClaw installs the Brave search plugin into the volume by itself when a
  // Brave key is set; a copy from 2026.7 drifts on 2026.9 ("plugin
  // version_drift", the gate on 2026-09-24). When the image carries brave in
  // its cache, an agent that has it is moved to the baked version. Static.
  if (npmMode && baked.has('brave')) {
    cmds.push({
      argv: [],
      rawShell: `if ls /home/node/.openclaw/npm/projects/openclaw-brave-plugin-* >/dev/null 2>&1; then V=$(node -p 'require("/opt/hatchabot/plugins/brave/node_modules/@openclaw/brave-plugin/package.json").version') && openclaw plugins install "@openclaw/brave-plugin@$V" --force --accept-capabilities --acknowledge-install-policy-warning --pin 2>&1 | tail -1; fi || true`,
    });
  }
  const channelPlugin = (kind: 'slack' | 'discord'): ConfigCommand => npmMode
    ? {
      argv: [],
      // Installed once; reinstalled (--force) only when the image's baked
      // version moved, so a rebuild onto a newer image does not keep an old
      // copy (28th audit). The probe for the installed version is one node
      // process that always exits 0: its first form piped `cat` of a glob
      // into node, and on a volume that had never had the plugin the glob
      // matched nothing, `cat` failed, `pipefail` made the assignment fail
      // and `set -e` ended the seed there — every FIRST Discord attach on a
      // 2026.9 agent failed, with a stale stderr line as the only clue (To
      // Do Agent, 2026-09-25). A rebuild after a hand install passed, since
      // the probe then found a file.
      rawShell: `V=$(node -p 'require("/opt/hatchabot/plugins/${kind}/node_modules/@openclaw/${kind}/package.json").version'); H=$(node -e 'const fs=require("fs");const d="/home/node/.openclaw/npm/projects";let v="";try{for(const n of fs.readdirSync(d).sort()){if(!n.startsWith("openclaw-${kind}-"))continue;try{v=JSON.parse(fs.readFileSync(d+"/"+n+"/node_modules/@openclaw/${kind}/package.json","utf8")).version||""}catch{}}}catch{}process.stdout.write(v)'); if [ "$H" != "$V" ]; then openclaw plugins install "@openclaw/${kind}@$V" --force --accept-capabilities --acknowledge-install-policy-warning --pin 2>&1 | tail -1; fi || true`,
    }
    : link(channelPluginDir(kind));
  // 2026.8+ images bake the DuckDuckGo plugin (no longer bundled with
  // OpenClaw); link it like a channel plugin, then enable as always.
  if (baked.has('duckduckgo')) cmds.push(link(DUCKDUCKGO_PLUGIN_DIR));
  cmds.push({ argv: ['plugins', 'enable', 'duckduckgo'] });

  // Local memory embeddings from the image-baked GGUF provider. `--link` points
  // the agent's registry at the plugin in the IMAGE (no 71MB volume copy); the
  // model is a single image file every agent's modelPath references (set below).
  // Both are idempotent — safe to re-run on every rebuild. Absent the plugin,
  // memorySearch.provider=local has no `local` provider and semantic recall is
  // silently dead (the fleet-wide gap this closes). `--link` + `enable` are not
  // `config set`, so they break the batch run — harmless, they just run alone.
  if (!patch.embed) {
    cmds.push(link(EMBED_PLUGIN_DIR));
    cmds.push({ argv: ['plugins', 'enable', 'llama-cpp'] });
  }

  cmds.push({ argv: ['config', 'set', 'gateway.mode', 'local'] });

  // Web search is MANDATORY for every agent (Chris, 2026-09-04): always on.
  // The keyless DuckDuckGo plugin (enabled below) is the baseline; a
  // BRAVE_API_KEY env var (fleet search key or per-agent) upgrades the
  // provider — OpenClaw auto-detects from the keys it finds. NOTE the live
  // fleet ran with this UNSET (= enabled by default); an earlier draft wrote
  // `false` for keyless agents, which would have disabled search fleet-wide
  // on the next rebuild — caught before any rebuild ran.
  cmds.push({ argv: ['config', 'set', 'tools.web.search.enabled', patch.ops ? 'false' : 'true'] });
  // Memory search: OpenClaw's default points at OpenAI embeddings, which no
  // Hatchabot agent has a key for — so semantic recall over MEMORY.md was
  // silently dead fleet-wide (doctor flagged it once the lint sweep landed).
  // Two engines: the bundled local model (no key, no network at query time),
  // or — when the agent is switched to it — the machine's shared service,
  // keyed per agent and reached over the docker network.
  if (patch.embed) {
    // The machine's shared embedding service (src/embedder): OpenClaw's
    // openai-compatible provider, pointed at the door with this agent's own
    // key. The baked plugin's link was removed above; the image can drop
    // the engine (label embed-engine=none).
    const k = memoryKeyPrefix(patch.openclawVersion);
    cmds.push({ argv: ['config', 'set', `${k}.provider`, 'openai-compatible'] });
    cmds.push({ argv: ['config', 'set', `${k}.model`, patch.embed.model] });
    cmds.push({ argv: ['config', 'set', `${k}.remote.baseUrl`, patch.embed.baseUrl] });
    cmds.push({ argv: ['config', 'set', `${k}.remote.apiKey`, patch.embed.token], sensitive: true });
  } else {
    cmds.push({ argv: ['config', 'set', 'agents.defaults.memorySearch.provider', 'local'] });
    // Point at the image-baked model, not the plugin's default `hf:` URI — the URI
    // would download 314MB to the volume on first index. Absolute path = shared,
    // offline, deterministic. Batches with the provider set above.
    cmds.push({
      argv: ['config', 'set', 'agents.defaults.memorySearch.local.modelPath', EMBED_MODEL_PATH],
    });
  }

  // Session continuity (Chris, 2026-09-06 — a Cross Country conversation was
  // abruptly forgotten). OpenClaw's default idle reset rolled a conversation
  // to a blank session after an overnight gap, mid-task. Two convergent
  // changes, written unconditionally:
  //
  // 1. A 30-day idle window (was ~a day) so a normal multi-hour/overnight gap
  //    RESUMES the thread instead of resetting it — the continuous-session
  //    behavior we confirmed live (an actively-used agent ran one session for
  //    weeks). A genuinely abandoned thread still eventually rolls (cost).
  cmds.push({ argv: ['config', 'set', 'session.reset', JSON.stringify({ mode: 'idle', idleMinutes: 43200 })] });
  // 2. active-memory: a bundled plugin that runs a bounded memory-recall
  //    sub-agent BEFORE each reply, so a fresh session immediately surfaces
  //    the relevant standing facts from MEMORY.md — a reset (or a brand-new
  //    thread) stops being a blank slate. Scoped to THIS agent and to direct
  //    chats; recall model inherits the session's own model. Owner opted into
  //    the per-turn token cost for the quality. Combined with the AGENTS.md
  //    memory-hygiene habit (workspace.ts), the abrupt-forget class is closed.
  cmds.push({
    argv: ['config', 'set', 'plugins.entries.active-memory', JSON.stringify({
      enabled: true,
      config: {
        enabled: true,
        agents: [patch.agentId],
        allowedChatTypes: ['direct'],
        queryMode: 'recent',
        promptStyle: 'balanced',
        timeoutMs: 15000,
        maxSummaryChars: 300,
        persistTranscripts: false,
        logging: false,
      },
    })],
  });

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
    // --replace: this path is Hatchabot-owned (the profile is the source of
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

  // Event-triggered tasks: convergent like richMessages — an explicit opt-in
  // writes true, everything else re-asserts false on every provision/rebuild.
  cmds.push({ argv: ['config', 'set', 'cron.triggers.enabled', patch.cronTriggers === true ? 'true' : 'false'] });

  // The management agent: only Hatchabot's tools (an HTTP MCP server, reached
  // with its propose-only key), its memory, and its own workspace files. No
  // shell, web, browser, nodes, schedules, sub-sessions or gateway config.
  // Re-asserted on every provision; the network jail and the key's scope hold
  // even if this is changed from the console (docs/ops-agent-design.md).
  if (patch.ops) {
    cmds.push({ argv: ['config', 'set', 'tools.allow', JSON.stringify(OPS_TOOLS_ALLOW)] });
    cmds.push({ argv: ['config', 'set', 'tools.deny', JSON.stringify(OPS_TOOLS_DENY)] });
    cmds.push({
      argv: ['mcp', 'set', 'hatchabot', JSON.stringify({
        url: patch.ops.mcpUrl, transport: 'streamable-http', headers: { Authorization: `Bearer ${patch.ops.token}` },
      })],
      sensitive: true, // carries the key
    });
  }

  if (patch.telegram) {
    const { accountId, botToken, dmPolicy, allowFrom, groupAccess, richMessages } = patch.telegram;
    cmds.push({ argv: ['config', 'set', 'channels.telegram.enabled', 'true'] });
    // Rich formatting — written UNCONDITIONALLY (convergent, same rule as
    // groupPolicy below): OpenClaw's own unset default is plain text, and
    // Hatchabot's managed default is ON; only an explicit per-agent opt-out
    // writes false. Missing from the patch (older caller) also lands true.
    cmds.push({ argv: ['config', 'set', 'channels.telegram.richMessages', richMessages === false ? 'false' : 'true'] });
    if (patch.telegram.proxy) cmds.push({ argv: ['config', 'set', 'channels.telegram.proxy', patch.telegram.proxy], sensitive: true });
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
    // The WHOLE accounts object, replaced — never one key merged in. The
    // config lives on the volume, so the bot this agent had before a swap
    // (or before it was archived) stayed in it under its own username, and
    // after the rebuild both this agent and the bot's next agent polled it
    // (the same fault the no-bot branch below closed for detach, 2026-09-25).
    cmds.push({
      argv: ['config', 'set', 'channels.telegram.accounts', JSON.stringify({ [accountId]: account }), '--replace'],
      sensitive: true,
    });

    // Group-chat access — written UNCONDITIONALLY (audit 2026-09-04): with an
    // if-guard, clearing the setting back to default skipped the write and a
    // stale open-room entry survived on the durable volume forever — a silent
    // hole the UI claimed was closed. Absent/`members` converge on OpenClaw's
    // own default (allowlist: admitted members only; an accidental addee is
    // ignored). 'room' is deliberately never channel-wide open: exactly one
    // bound chat id, mention-gated, so the accident blast radius is the one
    // room the owner picked.
    const policy = groupAccess?.mode === 'off' ? 'disabled' : 'allowlist';
    cmds.push({ argv: ['config', 'set', 'channels.telegram.groupPolicy', policy] });
    const groups =
      groupAccess?.mode === 'room' && groupAccess.roomId
        ? { [groupAccess.roomId]: { groupPolicy: 'open', requireMention: true } }
        : {};
    cmds.push({ argv: ['config', 'set', 'channels.telegram.groups', JSON.stringify(groups), '--replace'] });
  } else {
    // No bot: turn Telegram OFF and empty its accounts, every build. The
    // config lives on the volume, so a bot this agent USED to have stayed in
    // it after the bot was moved to another agent — both containers then
    // polled the same bot and fought over its messages (Ethernet cable fix →
    // Genetic Algorithm Trading, 2026-09-24). Same convergent removal as
    // Slack and Discord below.
    cmds.push({ argv: ['config', 'set', 'channels.telegram.enabled', 'false'] });
    cmds.push({ argv: ['config', 'set', 'channels.telegram.accounts', '{}'] });
  }

  // Slack and Discord (docs/channels-slack-discord-design.md). Only for
  // plugins the image carries: on any other image this writes nothing.
  //  - Present: link the baked plugin, then write the channel whole.
  //    `accounts` is replaced as one object, so no stale account survives.
  //  - Absent: turn it off and empty its accounts, so a removed channel's
  //    token does not live on in the volume's config. Two small writes, not
  //    one big one: OpenClaw refuses a write that halves the config's size.
  const plugins = new Set(patch.channelPlugins ?? []);
  if (plugins.has('slack')) {
    if (patch.slack) {
      const sl = patch.slack;
      cmds.push(channelPlugin('slack'));
      cmds.push({ argv: ['plugins', 'enable', 'slack'] });
      cmds.push({ argv: ['config', 'set', 'channels.slack.enabled', 'true'] });
      cmds.push({ argv: ['config', 'set', 'channels.slack.mode', 'socket'] });
      // A room with nobody admitted yet is written CLOSED: OpenClaw reads a
      // room entry without `users` as "everyone in it", so the whole
      // workspace could have driven the agent until its owner linked
      // (2026-09-25). The app refuses room mode until someone is linked;
      // this is the belt to that brace.
      const slackRoom = sl.rooms.mode === 'room' && sl.allowFrom.length > 0 ? sl.rooms.roomId : undefined;
      cmds.push({ argv: ['config', 'set', 'channels.slack.groupPolicy', slackRoom ? 'allowlist' : 'disabled'] });
      // Rooms by ID only (names never match under allowlist), members only, @mention.
      const rooms = slackRoom
        ? { [slackRoom]: { enabled: true, requireMention: true, users: sl.allowFrom } }
        : {};
      cmds.push({ argv: ['config', 'set', 'channels.slack.channels', JSON.stringify(rooms)] });
      cmds.push({
        argv: ['config', 'set', 'channels.slack.accounts', JSON.stringify({
          [CHANNEL_ACCOUNT]: { enabled: true, botToken: sl.botToken, appToken: sl.appToken, dmPolicy: sl.dmPolicy ?? 'pairing', allowFrom: sl.allowFrom },
        })],
        sensitive: true,
      });
    } else {
      cmds.push({ argv: ['config', 'set', 'channels.slack.enabled', 'false'] });
      cmds.push({ argv: ['config', 'set', 'channels.slack.accounts', '{}'] });
    }
  }
  if (plugins.has('discord')) {
    if (patch.discord) {
      const dc = patch.discord;
      cmds.push(channelPlugin('discord'));
      cmds.push({ argv: ['plugins', 'enable', 'discord'] });
      cmds.push({ argv: ['config', 'set', 'channels.discord.enabled', 'true'] });
      // The rooms it answers in, each for admitted people only (see the Slack
      // note above): one by id, or every server it is in ('members' — the
      // same answer Telegram's default gives, which on Discord has to be
      // spelled out per server since a guild entry is what admits a room).
      const roomIds = dc.allowFrom.length === 0 ? []
        : dc.rooms.mode === 'room' ? [dc.rooms.roomId]
        : dc.rooms.mode === 'members' ? (dc.servers ?? []).filter((g) => /^\d{17,20}$/.test(g))
        : [];
      cmds.push({ argv: ['config', 'set', 'channels.discord.groupPolicy', roomIds.length ? 'allowlist' : 'disabled'] });
      const guilds = Object.fromEntries(roomIds.map((g) => [g, { requireMention: true, ignoreOtherMentions: true, users: dc.allowFrom }]));
      cmds.push({ argv: ['config', 'set', 'channels.discord.guilds', JSON.stringify(guilds)] });
      // Discord's websocket ignores HTTPS_PROXY; it has its own setting.
      if (dc.proxy) cmds.push({ argv: ['config', 'set', 'channels.discord.proxy', dc.proxy], sensitive: true });
      cmds.push({
        argv: ['config', 'set', 'channels.discord.accounts', JSON.stringify({
          [CHANNEL_ACCOUNT]: { enabled: true, token: dc.token, applicationId: dc.applicationId, dmPolicy: dc.dmPolicy ?? 'pairing', allowFrom: dc.allowFrom },
        })],
        sensitive: true,
      });
    } else {
      cmds.push({ argv: ['config', 'set', 'channels.discord.enabled', 'false'] });
      cmds.push({ argv: ['config', 'set', 'channels.discord.accounts', '{}'] });
    }
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
  // Route Slack and Discord to this agent on EVERY build: `agents add` runs
  // only on a fresh volume, so a channel added later would otherwise have no
  // binding. Both verbs are idempotent (checked on 2026.7.1-2).
  for (const kind of ['slack', 'discord'] as const) {
    if (!plugins.has(kind)) continue;
    const present = kind === 'slack' ? !!patch.slack : !!patch.discord;
    cmds.push({
      argv: ['agents', present ? 'bind' : 'unbind', '--agent', patch.agentId, '--bind', `${kind}:${CHANNEL_ACCOUNT}`],
      optional: !present,
    });
  }
  // Name it what the owner calls it. `agents add` takes only the id (the
  // slug), so the Control UI labelled every agent "stock-advisor" rather than
  // "Stock Advisor". Cosmetic, so a failure here must not fail a provision.
  if (patch.displayName) {
    cmds.push({ argv: ['agents', 'set-identity', '--agent', patch.agentId, '--name', patch.displayName], optional: true });
  }

  // Heal volumes seeded before this rule (and imported ones): strip any
  // frozen per-agent model so the default actually governs.
  cmds.push({
    argv: [],
    rawShell: `node -e 'const fs=require("fs");const f="/home/node/.openclaw/openclaw.json";const c=JSON.parse(fs.readFileSync(f,"utf8"));let n=0;const r=c.agents||{};const list=Array.isArray(r.list)?r.list:(r.entries&&typeof r.entries==="object"?Object.values(r.entries):[]);for(const a of list){if(a&&a.model){delete a.model;n++}}if(n)fs.writeFileSync(f,JSON.stringify(c,null,2));'`,
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
    // there, and auth stores are per-agent. 2026.9 refuses to guess the
    // owner once more than one agent is configured ("Pass --agent <id>").
    cmds.push({
      argv: ['models', 'auth', ...(port ? ['--agent', 'main'] : []), 'paste-token', '--provider', 'anthropic', '--expires-in', '365d'],
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
    // Redact the VALUE slot, not the last argument: `config set <path> <value>`
    // may be followed by flags (e.g. --replace), and masking argv.at(-1) then
    // hid the flag while leaving the secret in plain sight.
    const setAt = c.argv.indexOf('set');
    const valueAt = setAt !== -1 && c.argv.length > setAt + 2 ? setAt + 2 : c.argv.length - 1;
    const argv = [...c.argv];
    argv[valueAt] = '<redacted>';
    return `openclaw ${argv.join(' ')}`;
  });
}

export const OPS_TOOLS_ALLOW = ['bundle-mcp', 'group:memory', 'read', 'write', 'edit'];
export const OPS_TOOLS_DENY = ['group:runtime', 'group:web', 'group:ui', 'group:nodes', 'group:automation', 'group:sessions', 'gateway'];
