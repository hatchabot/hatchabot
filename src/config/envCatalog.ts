/**
 * Every setting Hatchabot reads from .env, in one place (Chris, 2026-09-29:
 * "all the settings written to the .env, commented out or set to default, so
 * it's explicit and documented"). The .env file is rebuilt from this list at
 * every start (src/config/envFile.ts): what the owner set stays in force,
 * everything else is listed commented out with its default. .env.example is
 * the same rendering of an empty file. A guard test fails when the code reads
 * a HATCHABOT_* name that is neither here nor in ENV_INTERNAL.
 */

export interface EnvSetting {
  name: string;
  group: EnvGroup;
  /** What applies when the line is commented out; null = unset (the help says what that means). */
  default: string | null;
  /** One or two short lines: what it does, and what unset means when that isn't obvious. */
  help: string;
}

export type EnvGroup =
  | 'basics' | 'signin' | 'public' | 'data' | 'limits' | 'agents' | 'usage' | 'memory'
  | 'runtime' | 'manager' | 'managed' | 'timings' | 'never';

export const ENV_GROUPS: Array<{ id: EnvGroup; title: string; intro?: string }> = [
  { id: 'basics', title: 'Basics' },
  { id: 'signin', title: 'Sign-in', intro: 'Modes: accounts (a login per person, kept here), password (one shared password), identity (Google sign-in; docs/identity.md).' },
  { id: 'public', title: 'Public access ("Reach it from anywhere")', intro: 'Off unless HATCHABOT_PUBLIC_ACCESS is set. Turn it on from Settings or `hatchabot reach on`, which checks every safeguard first (docs/public-access.md).' },
  { id: 'data', title: 'Data and backups' },
  { id: 'limits', title: 'Limits', intro: '0 or unset = no limit. Archived agents never count.' },
  { id: 'agents', title: 'Agents' },
  { id: 'usage', title: 'Usage and spike warnings' },
  { id: 'memory', title: 'Memory search service', intro: 'One engine for every agent\'s memory search (Settings → Hosts → Memory search service).' },
  { id: 'runtime', title: 'Docker and runtime' },
  { id: 'manager', title: 'Hatchabot agent (management)' },
  { id: 'managed', title: 'Managed installs (a provider running Hatchabot for someone)' },
  { id: 'timings', title: 'Timeouts and sweeps (milliseconds)', intro: 'The defaults suit a local Docker daemon.' },
  { id: 'never', title: 'Never in production' },
];

const s = (group: EnvGroup, name: string, dflt: string | null, help: string): EnvSetting => ({ name, group, default: dflt, help });

export const ENV_SETTINGS: EnvSetting[] = [
  // Basics
  s('basics', 'HATCHABOT_SECRET_KEY', null, 'Encrypts every stored credential. Made by the installer; losing it means re-entering every token and key. Backups include it as secret-key.env.'),
  s('basics', 'HATCHABOT_AUTH', 'password', 'How people sign in: accounts, password or identity. The installer writes accounts.'),
  s('basics', 'HATCHABOT_PASSWORD', null, 'The shared password in password mode. Single-quote it if it has spaces or symbols (no apostrophes).'),
  s('basics', 'PORT', '8080', 'The web app\'s port.'),
  s('basics', 'HATCHABOT_PUBLIC_URL', null, 'The address other people reach this machine at, for invite links and Google sign-in, e.g. https://<machine>.<tailnet>.ts.net. Unset: localhost.'),
  s('basics', 'HATCHABOT_BIND', null, 'Listen address. Unset: 0.0.0.0 when sign-in is on, 127.0.0.1 when it is off.'),
  s('basics', 'HATCHABOT_TLS_CERT', null, 'Serve HTTPS directly: the certificate (PEM, absolute path). Set both this and HATCHABOT_TLS_KEY, or neither.'),
  s('basics', 'HATCHABOT_TLS_KEY', null, 'The certificate\'s key (PEM, absolute path).'),

  // Sign-in
  s('signin', 'HATCHABOT_SESSION_DAYS', '14', 'How long a Google sign-in lasts before it asks again. "Sign out on every device" ends them sooner.'),
  s('signin', 'HATCHABOT_ALLOWED_EMAILS', null, 'Identity mode: only these Google addresses may sign in, comma-separated. Unset: any Google account that reaches this machine.'),
  s('signin', 'HATCHABOT_LOCAL_ACCOUNTS', null, 'Identity mode: 1 also allows local username/password accounts (the owner uses Google, others get an invitation link).'),
  s('signin', 'HATCHABOT_GCP_PROJECT', null, 'Identity mode: the Google Cloud project.'),
  s('signin', 'HATCHABOT_IDENTITY_API_KEY', null, 'Identity mode: the Identity Platform API key.'),
  s('signin', 'HATCHABOT_GOOGLE_CLIENT_ID', null, 'Identity mode: the OAuth client id.'),
  s('signin', 'HATCHABOT_LOGIN_FAILS_PER_WINDOW', '10', 'Failed sign-ins allowed per client per window before it is refused for a while.'),
  s('signin', 'HATCHABOT_LOGIN_WINDOW_MS', '900000', 'That window.'),

  // Public access
  s('public', 'HATCHABOT_PUBLIC_ACCESS', null, 'funnel makes the sign-in page reachable from the internet through Tailscale Funnel. Unset or off: private only. On with any safeguard off, the public address answers 503 and `hatchabot doctor` fails.'),
  s('public', 'HATCHABOT_PUBLIC_ACCESS_URL', null, 'The public address, written when public access is turned on (https://<machine>.<tailnet>.ts.net:8443).'),
  s('public', 'HATCHABOT_PUBLIC_INVITED_ONLY', null, '1: at the public address only existing accounts and pending invitations may sign in. Public access needs it on.'),
  s('public', 'HATCHABOT_PUBLIC_GUESTS_WITHOUT_SECOND_FACTOR', null, '1: chat-only web-chat guests (no agents, AI sources or hosts of their own, no owner rights) may use the public address with their password alone, for the chat and nothing else. Unset: everyone who signs in with a password needs a second factor there. Weakens the public address: turn it on from Settings, which asks first.'),
  s('public', 'HATCHABOT_PUBLIC_SECOND_FACTOR_FOR_ALL', null, 'No longer needed: a second factor is required of every password account at the public address. 1 changes nothing; any other value is ignored (it does not switch the rule off) and `hatchabot doctor` says so.'),
  s('public', 'HATCHABOT_PUBLIC_PORT', '8092', 'The public listener\'s port on this machine (127.0.0.1 only). Funnel is pointed at this port and no other; everything arriving on it is treated as a stranger.'),
  s('public', 'HATCHABOT_PUBLIC_FUNNEL_PORT', '8443', 'The port of the public address: 443, 8443 or 10000 (Funnel\'s choices). 8443 leaves 443 to the private tailnet address.'),
  s('public', 'HATCHABOT_PUBLIC_IDLE_MINUTES', '720', 'A sign-in at the public address ends after this long without use.'),
  s('public', 'HATCHABOT_PUBLIC_STEPUP_MINUTES', '10', 'Machine-level and dangerous actions at the public address need the second factor given within this many minutes.'),
  s('public', 'HATCHABOT_PUBLIC_REQS_PER_MIN', '3000', 'Requests a minute the public address answers, all visitors together.'),
  s('public', 'HATCHABOT_PUBLIC_REQS_PER_MIN_PER_ADDRESS', '600', 'Requests a minute from one address.'),
  s('public', 'HATCHABOT_PUBLIC_FAILS_CEILING', '100', 'Failed sign-ins per window at the public address, all visitors together, before every public sign-in is refused for the rest of the window.'),

  // Data and backups
  s('data', 'HATCHABOT_DB', null, 'The registry and secret store (SQLite). Unset: data/hatchabot.sqlite in this folder. Production keeps it outside the checkout.'),
  s('data', 'HATCHABOT_BACKUP_DIR', null, 'Where nightly backups go (absolute path; may be a NAS mount). Unset: ~/hatchabot-backups.'),
  s('data', 'HATCHABOT_BACKUP_KEEP_DAYS', '14', 'How many days of nightly backups to keep.'),

  // Limits
  s('limits', 'HATCHABOT_MAX_AGENTS_PER_ACCOUNT', '0', 'Most agents one account may have (the host owner included).'),
  s('limits', 'HATCHABOT_MAX_AGENTS_PER_MEMBER', '0', 'A lower cap for accounts that are not the host owner.'),
  s('limits', 'HATCHABOT_MAX_AGENTS_TOTAL', '0', 'Most live agents on this machine, all accounts together.'),
  s('agents', 'HATCHABOT_TIMEZONE', null, 'The time zone agents live in (an IANA name like America/Toronto): their message timestamps, schedules, dated files and what they are told the time is, and their shell clock. Unset: this machine\'s own zone. Running agents take it within a day (at once after a restart of Hatchabot); the shell clock at the next rebuild.'),
  s('limits', 'HATCHABOT_AGENT_MEMORY', '3g', 'Each agent\'s memory limit (also Settings → Hosts → Defaults).'),
  s('limits', 'HATCHABOT_AGENT_MEMORY_MAX', '8g', 'The most a member may give one agent; the machine owner is not bound by it.'),
  s('limits', 'HATCHABOT_AGENT_SWAP', 'off', 'Compressed swap each agent may use on top of its memory limit, like 2g (docker gets memory + swap as --memory-swap). Given only where this machine compresses swap (zswap or zram: scripts/enable-compressed-swap.sh); never plain disk swap. Also Settings → Hosts → Defaults.'),
  s('limits', 'HATCHABOT_AGENT_PIDS', '512', 'Each agent\'s process limit.'),
  s('limits', 'HATCHABOT_AGENT_DISK_WARN_GB', '10', 'Warn when an agent\'s storage passes this size.'),
  s('limits', 'HATCHABOT_IMPORT_MAX_GB', '8', 'How big an imported .hatchabot file may expand to.'),
  s('limits', 'HATCHABOT_FILE_MAX_MB', '512', 'Largest single download from an agent\'s Files tab.'),
  s('limits', 'HATCHABOT_FILES_MB_TELEGRAM', '50', 'Largest file an agent sends or receives on Telegram (Telegram\'s own limit is 50).'),
  s('limits', 'HATCHABOT_FILES_MB_DISCORD', '10', 'Largest file an agent sends on Discord (up to 500 on a boosted server).'),
  s('limits', 'HATCHABOT_FILES_MB_SLACK', '100', 'Largest file an agent sends or receives on Slack (up to 1000).'),

  // Agents
  s('agents', 'HATCHABOT_NEW_AGENT_BUDGET', null, 'A monthly budget every new agent starts with, in US dollars at API prices: "50", "50 pause" or "50 cheaper" (Settings → Hosts → Defaults for this machine). Unset: none.'),
  s('agents', 'HATCHABOT_NEW_AGENT_ALERT_EVERY', null, 'Tell the owner each time a new agent spends another this many US dollars in a month, e.g. 25 (Settings → Hosts → Defaults for this machine). Unset: no alerts.'),
  s('agents', 'HATCHABOT_HIBERNATE_AFTER', null, 'Put agents to sleep after this long without use, e.g. 36h (90m, 6h, 2d). Unset: they never sleep.'),
  s('agents', 'HATCHABOT_REBUILD_POLICY', 'required-only', 'What the machine rebuilds on its own: required-only, auto (also recommended ones, in the quiet hours) or manual.'),
  s('agents', 'HATCHABOT_REBUILD_QUIET_HOURS', '3-5', 'Local hours for automatic rebuilds, "from-to" (wraps midnight).'),
  s('agents', 'HATCHABOT_REBUILD_CONCURRENCY', '6', 'Rebuilds at once, 1 to 12 (also Settings → Images).'),
  s('agents', 'HATCHABOT_CHECKPOINT_CONCURRENCY', '2', 'Conversations saved to memory at once before rebuilds.'),
  s('agents', 'HATCHABOT_A2A_MAX_CONCURRENT', '8', 'Agent-to-agent consults running at once.'),
  s('agents', 'HATCHABOT_A2A_PER_HOUR', '60', 'Consults one agent may start per hour.'),
  s('agents', 'HATCHABOT_A2A_TIMEOUT_MS', '120000', 'How long a consult may take.'),
  s('agents', 'HATCHABOT_ASK_TIMEOUT_MS', '280000', 'How long an "ask" from the app may take.'),
  s('agents', 'HATCHABOT_WEB_CHAT_PER_HOUR', '60', 'Messages one person may send one agent per hour from the web chat.'),
  s('agents', 'HATCHABOT_CHANNEL_HANDLER_TIMEOUT_MS', '1800000', 'How long a Telegram message may take to get going (a long /compact, say) before OpenClaw gives up on that try and retries it; OpenClaw\'s own is 5 minutes, and it retries until 8 tries and 24 hours. Applies at each agent\'s next rebuild; an agent\'s own Environment value wins. off = OpenClaw\'s 5 minutes. (Slack and Discord have no such setting.)'),
  s('agents', 'HATCHABOT_CONSOLE_IDENTITY', null, 'off gives agents rebuilt from now on the token console again (no OpenClaw chat for web-chat guests). Set it, and rebuild, before going back to an older release.'),
  s('agents', 'HATCHABOT_ALLOW_MACHINE_LOGIN', null, '1 allows NEW Claude sources that mount this machine\'s own ~/.claude into agents (read-write). Off since v2.39.0; use a setup token instead.'),

  // Usage
  s('usage', 'HATCHABOT_USAGE_ALERT_RATIO', '3', 'Warn on Telegram when an agent\'s last 24 hours are this many times its usual day...'),
  s('usage', 'HATCHABOT_USAGE_ALERT_MIN_TOKENS', '20000000', '...and at least this many tokens.'),
  s('usage', 'HATCHABOT_USAGE_ALERT_NEW_TOKENS', '100000000', 'An agent with under 3 measured days: warn at this many tokens in 24 hours.'),
  s('usage', 'HATCHABOT_COST_BADGES', 'on', 'The home screen\'s cost badges ($$ to $$$$: each agent\'s last 7 days at API prices, as a monthly rate) and View by → Cost. off hides them.'),
  s('usage', 'HATCHABOT_USAGE_SAMPLE_MS', '600000', 'How often usage and rate limits are read from the agents (0 = never).'),
  s('usage', 'HATCHABOT_USAGE_CONCURRENCY', '6', 'Agents read at once in a usage pass.'),
  s('usage', 'HATCHABOT_USAGE_PASS_MS', '300000', 'Longest one usage pass may take.'),

  // Memory search service
  s('memory', 'HATCHABOT_EMBED_DEFAULT', 'baked', 'What NEW agents get: baked (their own engine) or shared (this service).'),
  s('memory', 'HATCHABOT_EMBED_PORT', '8093', 'The service\'s port, on the address agents reach this machine at.'),
  s('memory', 'HATCHABOT_EMBED_BIND', null, 'That address. Unset: found automatically (the Docker bridge gateway).'),
  s('memory', 'HATCHABOT_EMBED_PER_MIN', '600', 'Calls a minute, per agent.'),
  s('memory', 'HATCHABOT_EMBEDDER_MEMORY', '2g', 'The engine\'s memory limit.'),
  s('memory', 'HATCHABOT_EMBEDDER_IMAGE', null, 'The engine image. Unset: the one pinned by digest in this release.'),
  s('memory', 'HATCHABOT_EMBED_HEALTH_MS', '300000', 'How often a running service is checked (and restarted if it stopped).'),
  s('memory', 'HATCHABOT_EMBED_BOOT_MS', '15000', 'Delay after start before the service is checked the first time.'),
  s('memory', 'HATCHABOT_EMBED_URL', null, 'Use a server you already run instead (Ollama speaks the same API). It must be reachable from the agents\' containers, not 127.0.0.1.'),
  s('memory', 'HATCHABOT_EMBED_KEY', null, 'That server\'s key.'),
  s('memory', 'HATCHABOT_EMBED_MODEL', null, 'That server\'s model name.'),

  // Docker and runtime
  s('runtime', 'HATCHABOT_IMAGE', 'hatchabot-runtime:latest', 'The image agents run on.'),
  s('runtime', 'HATCHABOT_IMAGE_REGISTRY', 'ghcr.io/hatchabot/runtime', 'Where published runtime images are pulled from.'),
  s('runtime', 'HATCHABOT_PREFIX', 'hatchabot', 'Name prefix for containers and volumes. Change only to run two installations on one machine.'),
  s('runtime', 'HATCHABOT_AGENT_NETWORK', 'hatchabot-agents', 'The Docker network agents run on (isolated from each other). bridge = the old shared network.'),
  s('runtime', 'HATCHABOT_GATEWAY_PORT_BASE', '19100', 'First loopback port for the agents\' own gateways.'),
  s('runtime', 'HATCHABOT_INTERNAL_URL', null, 'How agents reach this app from inside Docker. Unset: the Docker host address and PORT.'),
  s('runtime', 'HATCHABOT_HOST_ALIAS_IP', null, 'The address agents use for this machine. Unset: found automatically.'),
  s('runtime', 'HATCHABOT_DOCKER_ROOTLESS', null, '1 or 0 to say whether Docker is rootless. Unset: detected.'),
  s('runtime', 'HATCHABOT_DOCKER_DESKTOP', null, '1 or 0 to say whether this is Docker Desktop. Unset: detected.'),
  s('runtime', 'HATCHABOT_CONTAINERS_ON_LOOPBACK', null, '1 publishes agent ports on 127.0.0.1 only. Unset: set automatically under rootless Docker.'),
  s('runtime', 'HATCHABOT_OPENCLAW_GATEWAY_UNIT', 'openclaw-gateway', 'The systemd unit of an OpenClaw install on this machine, for bringing its agents in.'),
  s('runtime', 'HATCHABOT_CLAUDE_BIN', null, 'Path to the claude command, if it is not on PATH.'),
  s('runtime', 'HATCHABOT_SSH_DIR', null, 'Where runner SSH keys and config live. Unset: ~/.ssh.'),
  s('runtime', 'HATCHABOT_BROWSER_MEMORY', '1g', 'Memory limit of each agent\'s own browser (docs/browser.md).'),
  s('runtime', 'HATCHABOT_BROWSER_SWEEP_MS', '60000', 'How often the agents\' browsers are brought in step with them (started, moved to a restarted agent, removed).'),

  // Management agent
  s('manager', 'HATCHABOT_OPS_PORT', '8091', 'The port the Hatchabot agent\'s tools are served on (reachable only from its own network).'),
  s('manager', 'HATCHABOT_OPS_BIND', null, 'That port\'s address. Unset: where the agent\'s gatekeeper can reach it.'),
  s('manager', 'HATCHABOT_OPS_MAX_TUNNELS', '24', 'Web connections the Hatchabot agent may hold open at once.'),
  s('manager', 'HATCHABOT_OPS_TUNNEL_IDLE_MS', '600000', 'Close such a connection after this long idle.'),
  s('manager', 'HATCHABOT_OPS_DRIFT_MS', '600000', 'How often its setup is checked for drift.'),
  s('manager', 'HATCHABOT_MODEL_REVIEW', 'weekly', 'The Hatchabot agent\'s weekly model review (Mondays 09:00): it proposes a better-fitting model per agent, for you to confirm. off removes the task at its next rebuild.'),
  s('manager', 'HATCHABOT_MGMT_ANTHROPIC_KEY', null, 'An Anthropic key or setup token for the management chat when no AI source is chosen for it.'),

  // Managed installs
  s('managed', 'HATCHABOT_MANAGED_BY', null, 'Who runs this install, shown in the app.'),
  s('managed', 'HATCHABOT_SUPPORT_URL', null, 'Their support link, shown with it.'),
  s('managed', 'HATCHABOT_NOTICE', null, 'A notice shown at the top of the app.'),
  s('managed', 'HATCHABOT_MANAGED_ALLOW_CLAUDE_PLAN', null, '1 lets a hosted install (HATCHABOT_MANAGED_BY set) add Claude plan sources (setup token, machine login). Unset: hosted installs take Claude by API key only, as Anthropic\'s terms require of a provider without its written agreement.'),
  s('managed', 'HATCHABOT_SIGNIN_KEY_FILE', null, 'One-time sign-in links from the provider\'s account page: the Ed25519 PUBLIC key (PEM, absolute path, chmod 600) they are signed with; HATCHABOT_PUBLIC_URL must be set. Unset: no links (docs/signin-links.md).'),

  // Timeouts and sweeps
  s('timings', 'HATCHABOT_DOCKER_TIMEOUT_MS', '60000', 'One docker command.'),
  s('timings', 'HATCHABOT_DOCKER_IO_TIMEOUT_MS', '900000', 'Copying an agent\'s storage in or out, and seeding it.'),
  s('timings', 'HATCHABOT_CHECKPOINT_TIMEOUT_MS', '180000', 'Saving a conversation to memory before a rebuild.'),
  s('timings', 'HATCHABOT_READY_TIMEOUT_MS', '90000', 'Waiting for a new container to answer.'),
  s('timings', 'HATCHABOT_READY_POLL_MS', '3000', 'How often it is asked while waiting.'),
  s('timings', 'HATCHABOT_BASE_BUILD_TIMEOUT_MS', '5400000', 'Building a runtime image.'),
  s('timings', 'HATCHABOT_CLI_TIMEOUT_MS', '180000', 'One claude command turn (Claude Max sources).'),
  s('timings', 'HATCHABOT_CONSOLE_TIMEOUT_MS', '60000', 'An agent\'s console page loading.'),
  s('timings', 'HATCHABOT_WAKE_TIMEOUT_MS', '120000', 'Waking a sleeping agent.'),
  s('timings', 'HATCHABOT_WAKE_POLL_MS', '20000', 'How often sleeping agents are checked for new messages.'),
  s('timings', 'HATCHABOT_HIBERNATE_SWEEP_MS', '300000', 'How often idle agents are looked for.'),
  s('timings', 'HATCHABOT_REBUILD_SWEEP_MS', '300000', 'How often waiting rebuilds are looked for.'),
  s('timings', 'HATCHABOT_PAIRING_SWEEP_MS', '300000', 'How often chat access settings are checked.'),
  s('timings', 'HATCHABOT_RECONCILE_MS', '120000', 'How often each agent\'s real state is re-checked.'),
  s('timings', 'HATCHABOT_BOOT_RECONCILE_MS', '30000', 'Longest the start-up check may delay the app.'),
  s('timings', 'HATCHABOT_PINS_BOOT_MS', '60000', 'Delay after start before stale session settings are cleared.'),
  s('timings', 'HATCHABOT_SWAP_BOOT_MS', '45000', 'Delay after start before the first limits check (each agent\'s memory and swap limits as the kernel holds them, applied again where they drifted).'),
  s('timings', 'HATCHABOT_SWAP_PROBE_MS', '600000', 'How often the limits check runs (compressed swap on each host; memory and swap limits a systemd reload reset).'),
  s('timings', 'HATCHABOT_NAME_REPAIR_MS', '120000', 'How often Telegram bot names are repaired.'),
  s('timings', 'HATCHABOT_IDLE_RENAME_MS', '900000', 'Rename a bot only after it has been idle this long.'),
  s('timings', 'HATCHABOT_KNOCK_CACHE_MS', '30000', 'How long a "someone is knocking" answer is reused.'),
  s('timings', 'HATCHABOT_POSTURE_SWEEP_MS', '86400000', 'How often the security check runs.'),

  // Never in production
  s('never', 'HATCHABOT_ALLOW_OWNER_HEADER', null, '1 lets a request header choose the owner. For tests only; the security check flags it as critical.'),
];

/**
 * Names the code reads that are not settings for .env: values Hatchabot gives
 * agents, the CLI's own config (~/.config/hatchabot/env), installer and script
 * knobs, and test hooks. Listed so the guard test can tell them from a new
 * setting nobody documented.
 */
export const ENV_INTERNAL: string[] = [
  // given to agent containers
  'HATCHABOT_AGENT_TOKEN', 'HATCHABOT_HOST_NAME', 'HATCHABOT_MEMORY_CAP', 'HATCHABOT_MCP_URL', 'HATCHABOT_TURN_TOKEN',
  // the CLI's own config
  'HATCHABOT_URL', 'HATCHABOT_TOKEN', 'HATCHABOT_REFRESH_TOKEN', 'HATCHABOT_BOT_TOKEN', 'HATCHABOT_CWD', 'HATCHABOT_DEV_DIR', 'HATCHABOT_CLI',
  // installer, upgrade and release scripts
  'HATCHABOT_CHANNEL', 'HATCHABOT_DIR', 'HATCHABOT_DRY_RUN', 'HATCHABOT_YES', 'HATCHABOT_SETUP_ENV', 'HATCHABOT_SETUP_PASSWORD',
  'HATCHABOT_SETUP_PORT', 'HATCHABOT_SETUP_SIGNIN', 'HATCHABOT_UPGRADE_COPY', 'HATCHABOT_UPGRADE_DIR', 'HATCHABOT_UPGRADE_IMAGE', 'HATCHABOT_UPGRADE_BY_TIMER',
  'HATCHABOT_INSTALL_CMD', 'HATCHABOT_RESTART_CMD', 'HATCHABOT_PROD_DIR', 'HATCHABOT_SERVICE', 'HATCHABOT_HEALTH_URL',
  'HATCHABOT_REPO', 'HATCHABOT_IMAGE_REPO', 'HATCHABOT_PROMOTE_TRAILERS', 'HATCHABOT_PROMOTE_IGNORE_CI', 'HATCHABOT_PROMOTE_IGNORE_LIVE', 'HATCHABOT_DRILL_DB', 'HATCHABOT_ENV_FILE',
  // the release bundle (install.sh, upgrade.sh, build-bundle.sh, sqlite-driver.sh, with-docker.sh)
  'HATCHABOT_NATIVE', 'HATCHABOT_SLUG', 'HATCHABOT_BUNDLE_BASE', 'HATCHABOT_BUNDLE_REF', 'HATCHABOT_APP_DIR', 'HATCHABOT_IN_DOCKER_GROUP',
  // test knobs
  'HATCHABOT_TAILSCALE_BIN', 'HATCHABOT_BACKUP_SCRIPT', 'HATCHABOT_SMOKE_AI_KEY', 'HATCHABOT_SMOKE_BOT_TOKEN', 'HATCHABOT_SMOKE_GATEWAY_BASE', 'HATCHABOT_SMOKE_EMBED_PORT', 'HATCHABOT_CONSOLE_TEST_PORT', 'HATCHABOT_SMOKE_PORT',
  // marker text in the page, and placeholders in the service unit templates (__HATCHABOT_PATH__)
  'HATCHABOT_VERSION', 'HATCHABOT_PATH',
];
