#!/usr/bin/env -S npx tsx
/**
 * hatchabot — command-line companion to the web app, speaking the same /v1
 * HTTP API. Exists for the things a browser is clumsy at: scripting, remote
 * management, and above all moving agents between machines:
 *
 *   laptop$  hatchabot backup kitchen-helper -o kitchen.hatchabot
 *   desktop$ hatchabot restore kitchen.hatchabot
 *
 * Config: HATCHABOT_URL (default http://localhost:8080) and
 * HATCHABOT_PASSWORD, or --url/--password flags.
 */
import './envCompat.js'; // must stay the first import: aliases AGENTCLAW_* env on load
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Flags > environment > ~/.config/hatchabot/env (KEY=VALUE lines, chmod 600 —
// keeps the password out of shell history and .bashrc).
function configDefaults(): Record<string, string> {
  // Pre-rename ~/.config/agentclaw/env first, then the current file on top —
  // a fresh `login` writes only the token to the new file and must not hide
  // the URL that still lives in the old one. Keys are aliased on read.
  const out: Record<string, string> = {};
  for (const file of [join(homedir(), '.config', 'agentclaw', 'env'), configPath()]) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      const l = raw.trim();
      if (!l || l.startsWith('#') || !l.includes('=')) continue;
      out[l.slice(0, l.indexOf('=')).replace(/^AGENTCLAW_/, 'HATCHABOT_')] = unquoteEnvValue(l.slice(l.indexOf('=') + 1));
    }
  }
  return out;
}

/**
 * setup-host.sh writes the password shell-single-quoted (the one form both
 * systemd's EnvironmentFile and shell sourcing agree on), e.g.
 * `HATCHABOT_PASSWORD='p@ss'`. Without undoing that here the CLI sent the
 * literal quotes and every login 401'd while the web UI worked. Mirror the
 * two quoting styles a shell would: single-quoted (with `'\''` escapes) and
 * double-quoted; leave a bare value untouched.
 */
function unquoteEnvValue(v: string): string {
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/'\\''/g, "'");
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  return v;
}

const USAGE = `hatchabot <command> [options]      (hbt is the same command, shorter)

Commands:
  login [--token <tok>]        Save an access token from the app (⚙ Settings → Security).
                               Works with any sign-in method, including Google.
                               [--email <addr>] uses email/password instead.
  accounts [list]              Local sign-in accounts (HATCHABOT_AUTH=accounts).
  accounts create <user> [--host-owner] [--cli-token [--token-days N]] [--json]
                               Make an account from the machine itself; the
                               person chooses a password on the one-time link it
                               prints. --host-owner makes the first one, the
                               owner; --cli-token also prints a CLI token.
  accounts reset-password <user> [<new>]
                               Reset a password from the machine itself — the
                               way back in when the host owner is locked out.
  upgrade [channel|vX.Y.Z]     Move this machine to the newest release on its
                               channel (stable unless you chose another), or
                               to stable | beta | latest | an exact version —
                               which is also how you roll back. Restores the
                               previous release if the new one does not start.
  doctor [--json]              Check this installation: Node, Docker, runtime
                               image, .env, database, service, control plane,
                               disk, backups, Tailscale — with the fix for
                               anything wrong. --json: for a program (the same
                               lines plus the facts; exit 1 on any ✗).
  list [--all]                 Agents with state, model, and last activity.
                               --all (host owner): every user's agents, with
                               the owner id — find another login's leftovers.
  users [--all]                Every Telegram user across your agents: which
                               agents they belong to, when they joined, and
                               when they were last heard from.
  migrate-source <from> --to <target> [--no-checkpoint] [--recover] [--yes]
                               Host owner: move EVERY agent on source <from> —
                               other accounts' included — to the SHARED source
                               <target> and rebuild them. Lists the agents and
                               asks first. Names or ids. --no-checkpoint skips
                               Chat → Memory (use when the old source is dead);
                               --recover restores lost context afterwards.
  bots [--check]               Every Telegram bot this + your registered servers
                               use, flagging reclaimable/dead slots. --check adds
                               a live Telegram probe per bot.
  sources                      Summary: which agents are on which AI source
                               (yours + other accounts' counts, shared flag,
                               id), which models they run, and each source's
                               live spend — requests over the last 5 h / 7 d,
                               refusals, the heaviest agents, and whether the
                               source is being rate-limited right now.
  switch-source --to <id|name> [--agents a,b,c] [--rebuild]
                               Move agents onto one AI source in a single call
                               (default: all of yours). --rebuild applies now,
                               else each shows "rebuild to apply".
  create <name> [--persona <text>] [--profile <id|name>] [--host <id>]
         [--private] [--bot-token <tok>] [--no-telegram] [--timeout <min>]
                               Create an agent and wait for it to boot (up to
                               15 min). Without --profile it gets your ⭐
                               default AI source, as in the app.
                               Prompts for a BotFather token if the bot pool
                               is empty. --no-telegram: no bot at all; talk
                               to it in the web app instead.
  ask <agent> <message>        Say something to an agent and print its answer —
                               the console, from a terminal. No message: read
                               it from stdin. --json for scripts.
  tasks <agent>                Its scheduled tasks: schedule, on/off, how the
                               last run went, when the next one is due.
  tasks <agent> add <name> (--every 30m | --cron "0 8 * * *") [--tz <zone>]
         [--message <text>] [--quiet]
                               Something it does on its own, on a schedule. The
                               message is what it is told each time (stdin if
                               omitted). --quiet: don't post the result to its chat.
  tasks <agent> run <task> [--wait] [--timeout <min>]
                               Run it now; --wait prints the result and exits
                               non-zero if the run failed.
  tasks <agent> runs <task> [--limit <n>]
                               What its recent runs produced.
  tasks <agent> pause|resume|rm <task>
  delete <agent> [--yes]       Delete an agent and its memory forever
                               (retypes the name unless --yes)
  archive <agent> [--yes]      Park an agent and hand its Telegram bot back for
                               another agent to use. Keeps memory, members and
                               settings; members are told in the chat.
  unarchive <agent>            Bring an archived agent back (the web app calls
                               this Restore). It gets a NEW bot — send members
                               the new link.
  download <agent> [-o <file>] Download a complete private copy (.hatchabot) — for
                               your own keeping (contains its bot token, so treat
                               as a secret; the agent is left STOPPED)
  restore <file> [--profile <aiProfileId>] [--host <id>] [--build-image|--drop-pin]
                               Restore an agent from a downloaded copy and boot it.
                               Pinned to an image this machine lacks: shows its
                               recipe and asks (build it here, or default image)
  share <agent> [-o <file>] [--include-memory]
                               Share a TEMPLATE for someone else — the agent's
                               trained SOUL/AGENTS, no bot token/members. Memory
                               stays private unless --include-memory
  import <file> [--name <n>] [--profile <aiProfileId>] [--host <id>] [--values <json>]
                               Import a template as a fresh agent (you give it
                               its own bot); prompts for the template's setup
                               fields ({{key}} placeholders) and prints what it
                               still needs
  clone <agent> [new name]     Duplicate an agent here — a faithful copy with its
                               own bot and name
  start|stop|rebuild <agent> [--wait]
                               Lifecycle controls; --wait returns once it is
                               RUNNING (or STOPPED)
  rebuild --outdated [--required] [--dry-run]
                               Rebuild every running agent that needs it (says
                               why); a stopped one is rebuilt when started
  rebuild-policy [required-only|auto|manual] [--at-once <N>]
                               When this machine rebuilds agents on its own:
                               required ones once idle (default), those plus
                               the rest in the quiet hours, or never
  retry <agent>                Retry a FAILED agent's provisioning
  skip-telegram <agent>        An agent parked on "paste a bot token" (the pool
                               is empty): finish it as a web-only agent instead
  rename <agent> <new name>    Change the display name
  ai [<agent>] [<profileId>]   Show AI sources, or point an agent at one
                               (applies on the agent's next rebuild)
  adopt <workspace-dir> <name> [--reuse-bot] [--bot-token <tok>] [--profile <id>]
                               Turn an existing OpenClaw agent's workspace
                               into a managed Hatchabot agent (copies the
                               WHOLE folder; the original is only read)
  folders <agent>              List everything an agent can access (folders and
                               git repos), each at /data/<name>
  folders <agent> add <path> [--rw]
                               Share a host folder (read-only, or --rw writable)
  folders <agent> add-repo <git-url> [--rw | --public]
                               Clone a git repo onto the agent's volume; prints
                               the deploy key to add to the repo
  folders <agent> rm <name>    Stop sharing a folder or repo (by its /data/<name>)
  servers                      Other Hatchabot servers you can move agents to
  servers add <name> <url> <token>
                               Register one (on that server: ⚙ Settings →
                               Security → "Token for moving agents here")
  rehost <agent> <server> [--drop-pin]
                               Move an agent there: preflight, transfer, verify.
                               The source is left STOPPED, never deleted.
                               A pinned image is rebuilt there from its recipe
                               (if your token is that server's owner's);
                               --drop-pin runs its default image instead
  invite <agent>               Mint a join link for the web flow
  pairing [<agent>]            Pending "wants to talk" requests
  approve <agent> <code>       Let a pending requester in (creates a member)
  deny <agent> <code>          Turn a pending requester away (not a ban)
  members <agent>              List members
  kick <agent> <userId>        Revoke a member
  env <agent>                  List env var names (values are write-only)
  env <agent> set <NAME> [<value>]
                               Set one (omit the value to read it from stdin,
                               keeping secrets out of shell history)
  env <agent> rm <NAME>        Remove one
  checkpoint <agent>           Write the chat's key facts to MEMORY.md now (~20s)
  snapshot <agent> [--label <text>]
                               Save a restore point of SOUL/AGENTS/MEMORY
  snapshots <agent>            List restore points
  revert <agent> <snapshotId>  Roll those files back (current state is saved first)
  token <agent>                Reveal the agent's Telegram bot token
  telegram remove <agent> [--yes]
                               Take its bot away: the bot goes back to your pool,
                               the agent keeps everything and becomes web-only
  logs <agent> [-n <lines>]    Recent runtime output
  events <agent> [-n <count>]  The setup log: what Hatchabot did to it and when
                               (each step of a setup, rebuild or move)
  memory <agent> [<cap>|default]
                               Its container's memory cap ("4g"): show, set (applied
                               live, kept across rebuilds), or back to the default
  console <agent> [--check]    The agent's OpenClaw console address; --check
                               loads it the way a browser would and says
                               whether the app bundle is reachable
  files <agent> [path]         List a folder inside the agent (its home by
                               default; the workspace is agents/<slug>/agent
                               under .openclaw). Works stopped or archived.
  get <agent> <path> [-o <file>]
                               Download a file, or a folder as .tar.gz
  put <agent> <file> [dir] [--overwrite]
                               Upload a file into a folder of the agent (its
                               workspace when no dir is given)
  health <agent>               Live gateway health — is it actually answering
  usage [agent]                Token usage by model; no agent → the fleet ranked by tokens
  top [--sort cpu|mem|name]    Live CPU and memory per agent, per machine
                               (docker's own measurement; a second per machine).
  embedder [status|start|stop|restart]
                               The machine's embedding service: one engine for
                               every agent's semantic memory search (Settings →
                               Hosts). Nothing uses it until an agent is switched to it.
  embedder use <agent> shared|baked
                               Which engine an agent's memory search uses —
                               the shared service, or the one in its image.
                               Applies on its next rebuild (it re-indexes then).
  embedder default [shared|baked]
                               Which engine NEW agents get (shows it when bare).
  embedder move-all shared|baked [--now]
                               Switch every agent on this machine; --now
                               rebuilds the idle running ones at once, otherwise
                               the quiet hours do it (never mid-conversation).
  runtime                      Runtime image's OpenClaw version vs the npm latest
  upgrade-image [--version <X>] [--candidate] [--no-engine]
                               Rebuild the shared runtime image to a new OpenClaw
                               version (default: latest stable), for the whole
                               fleet. --candidate builds without promoting to
                               :latest so you can smoke-test first. --no-engine
                               leaves out the memory search engine (agents use
                               the shared service; 2026.8+ always). Run on the host.
  image [list]                 Derived runtime images (host owner). A derived
                               image is FROM the base + your Dockerfile lines,
                               for system packages (apt) a volume install can't
                               provide; your lines run as root, then USER node.
  image derive <name> [--from <file>] [--base <tag>]
                               Build one (Dockerfile lines from --from or stdin)
                               and follow the build. Run on the host.
  image rebuild <name> [--base <tag>]   Rebuild (e.g. onto a promoted base)
  image rm <name>              Delete it (refused while an agent pins it)
  image log <name>             Show the last build's output
  image pin <agent> <name-or-tag>       Pin an agent to an image (next rebuild)
  image tags                   Every runtime image tag on this machine, who is
                               pinned to each, which one is the fleet default.
  image try <agent> <tag>      Pin ONE agent to a tag and rebuild it now (memory
                               kept) — the safe way to test a candidate.
  image promote <tag>          Make a built candidate the fleet default; agents
                               without a pin adopt it on their next rebuild.
  image unpin <agent>          Return an agent to the fleet default image

Global options:
  --url <url>        Control plane (env HATCHABOT_URL, default http://localhost:8080)
  --password <pw>    Shared password (env HATCHABOT_PASSWORD)
  --json             Machine-readable output (list, ask, tasks, doctor, accounts create)

<agent> is an agent's name or slug (any case), or 4+ characters of its id.
Options must be ones listed here: a mistyped one is an error, not a guess.`;

// Only on the machine Hatchabot is developed on (HATCHABOT_DEV_DIR is set).
const MAINTAINER_USAGE = `

Release (this is the development machine):
  deploy [vX.Y.Z]              Put a release on this machine now (default: the newest tag)
  promote [vX.Y.Z] [channel]   New installs get it (default: what this machine runs → stable)
  channels [all]               Where stable, beta and latest point, and every release`;

// `hatchabot list | head` must not crash when the pipe closes early.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

interface Ctx {
  url: string;
  cookie: string;
  /** Identity mode: a fresh ID token, exchanged from the stored refresh token. */
  bearer?: string;
}

interface IdentityConfig {
  authMode: string;
  identity?: { apiKey?: string; projectId?: string };
}

/** ~/.config/hatchabot/env — same file the password default lives in. */
function configPath(): string {
  return join(homedir(), '.config', 'hatchabot', 'env');
}

/** Read side: prefer the new path, fall back to the pre-rename ~/.config/agentclaw/env. */
function existingConfigPath(): string {
  const modern = configPath();
  if (existsSync(modern)) return modern;
  const legacy = join(homedir(), '.config', 'agentclaw', 'env');
  return existsSync(legacy) ? legacy : modern;
}

function writeConfigValue(key: string, value: string): void {
  const path = configPath();
  let lines: string[] = [];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter((l) => !l.startsWith(`${key}=`));
  } catch { /* first write */ }
  lines = lines.filter((l) => l.trim().length > 0);
  lines.push(`${key}=${value}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
}

async function serverConfig(url: string): Promise<IdentityConfig> {
  try {
    const res = await fetch(`${url}/v1/config`);
    if (res.ok) return (await res.json()) as IdentityConfig;
  } catch { /* older server: password mode */ }
  return { authMode: 'password' };
}

/** Refresh token → short-lived ID token (the securetoken endpoint is form-encoded). */
async function idTokenFrom(refreshToken: string, apiKey: string): Promise<string> {
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  const data = (await res.json()) as any;
  if (!res.ok) fail(`session expired (${data?.error?.message ?? res.status}) — run: hatchabot login`);
  return data.id_token as string;
}

/**
 * Read a secret without echoing it. The old prompts echoed passwords to the
 * screen (and to any terminal recording) — CLI audit. Not a terminal (a pipe,
 * a script): read one plain line.
 */
async function askSecret(q: string): Promise<string> {
  process.stderr.write(q);
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: stdin, terminal: false });
    return new Promise((r) => { let got = false; rl.once('line', (l) => { got = true; rl.close(); r(l); }); rl.once('close', () => { if (!got) r(''); }); });
  }
  return new Promise((resolveSecret) => {
    let buf = '';
    const done = () => { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); resolveSecret(buf); };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n' || c === '\u0004') return done();
        if (c === '\u0003') { stdin.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** <repo> root, from this file's location (<repo>/src/cli.ts). */
function repoDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/** Run `systemctl --user …`, never throwing — returns exit code + output. */
function systemctlUser(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('systemctl', ['--user', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout || err.stderr || '').toString().trim() };
  }
}

/** Template deploy/<unit> into ~/.config/systemd/user and enable it now. */
function installUserUnit(unitName: string): boolean {
  try {
    const tmpl = readFileSync(join(repoDir(), 'deploy', unitName), 'utf8');
    const unit = tmpl
      .replace(/__HATCHABOT_DIR__/g, repoDir())
      .replace(/__HATCHABOT_PATH__/g, process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin');
    const dest = join(homedir(), '.config', 'systemd', 'user', unitName);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, unit);
    systemctlUser(['daemon-reload']);
    return systemctlUser(['enable', '--now', unitName]).code === 0;
  } catch {
    return false;
  }
}

/** Single-quote for a systemd EnvironmentFile / shell .env line. */
function envQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

// Every flag the CLI knows. An unknown one is an error, not a guess: the old
// parser took any unlisted flag to have a value, so `--no-telegram` (missing
// from the list) swallowed the next argument — `create --no-telegram Foo` lost
// its name, `switch-source --rebuild --to X` lost its target (CLI audit, v2.33).
/**
 * A file the person named on the command line, resolved against THEIR
 * directory. A wrapper that `cd`s into the install before running the CLI
 * (the Spark's hbt shim does) exports HATCHABOT_CWD; without it the process
 * cwd is theirs already. Found when `hbt get -o report.pdf` landed in the
 * install directory (2026-09-24).
 */
const userPath = (p: string): string => resolve(process.env.HATCHABOT_CWD || process.cwd(), p);

const BOOL_FLAGS = new Set(['private', 'yes', 'help', 'none', 'no-engine', 'overwrite', 'reuse-bot', 'rw', 'candidate', 'check', 'all', 'include-memory', 'drop-pin', 'build-image', 'host-owner', 'cli-token', 'outdated', 'required', 'dry-run', 'now', 'no-checkpoint', 'recover', 'public', 'no-telegram', 'rebuild', 'json', 'wait', 'quiet']);
const VALUE_FLAGS = new Set(['at-once', 'agents', 'base', 'bot-token', 'email', 'from', 'host', 'label', 'lines', 'name', 'new-password', 'out', 'password', 'persona', 'profile', 'to', 'token', 'url', 'values', 'version', 'timeout', 'every', 'cron', 'tz', 'message', 'limit', 'token-days', 'sort']);

export function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  const value = (name: string, i: number): string => {
    const v = argv[i];
    if (v === undefined || (v.startsWith('--') && v.length > 2)) throw new Error(`--${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (BOOL_FLAGS.has(name)) {
        if (eq > 0) throw new Error(`--${name} takes no value`);
        flags.set(name, '1');
      } else if (VALUE_FLAGS.has(name)) {
        flags.set(name, eq > 0 ? a.slice(eq + 1) : value(name, ++i));
      } else {
        throw new Error(`unknown option --${name}`);
      }
    } else if (a === '-o') flags.set('out', value('o', ++i));
    else if (a === '-n') flags.set('lines', value('n', ++i));
    else positional.push(a);
  }
  return { flags, positional };
}

async function login(url: string, password: string): Promise<Ctx> {
  const res = await fetch(`${url}/v1/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) fail(`login failed (${res.status}) — check HATCHABOT_PASSWORD`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return { url, cookie };
}

async function api(ctx: Ctx, path: string, init: RequestInit = {}): Promise<Response> {
  const auth: Record<string, string> = ctx.bearer
    ? { authorization: `Bearer ${ctx.bearer}` }
    : { cookie: ctx.cookie };
  const res = await fetch(`${ctx.url}${path}`, {
    ...init,
    headers: { ...auth, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as any);
    // Throw (not exit) so callers can catch expected misses; uncaught ones
    // still land in main().catch → fail().
    throw Object.assign(
      new Error((data as any).error ?? (data as any).message ?? `${init.method ?? 'GET'} ${path} → ${res.status}`),
      { data }, // the whole answer, for the callers that act on a `code`
    );
  }
  return res;
}

/**
 * Upload a .hatchabot file. One pinned to an image this machine lacks stops
 * with the recipe: shown here, then built only on a yes (or --build-image),
 * or run on the default image (--drop-pin).
 */
async function uploadAgentFile(ctx: Ctx, path: string, params: URLSearchParams, data: Buffer, flags: Map<string, string>,
  askLine: (q: string) => Promise<string>): Promise<any> {
  if (flags.has('build-image')) params.set('image', 'build');
  if (flags.has('drop-pin')) params.set('image', 'drop');
  const send = async () => (await api(ctx, `${path}${params.size ? `?${params}` : ''}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: data,
  })).json();
  try {
    return await send();
  } catch (e: any) {
    const d = e?.data;
    if (d?.code !== 'image_decision' || params.has('image')) throw e;
    console.log(d.error);
    if (d.recipe) {
      console.log(`\n  FROM ${d.recipe.base}`);
      if (d.recipe.packages?.length) console.log(`  apt packages: ${d.recipe.packages.join(' ')}`);
      if (d.recipe.lines) console.log(d.recipe.lines.split('\n').map((l: string) => `  | ${l}`).join('\n'));
      console.log('');
    }
    if (!process.stdin.isTTY) {
      throw new Error(`${d.mayBuild ? 'Re-run with --build-image to build it, or ' : 'Re-run with '}--drop-pin to use the default image.`);
    }
    const build = d.mayBuild && /^y/i.test(await askLine('Build this image here (it runs as root while building)? [y/N] '));
    if (!build && !/^y/i.test(await askLine('Run the agent on the default image instead? [y/N] '))) throw new Error('nothing imported');
    params.set('image', build ? 'build' : 'drop');
    if (build) console.log('building… (a few minutes)');
    return send();
  }
}

async function agents(ctx: Ctx): Promise<any[]> {
  return (await api(ctx, '/v1/agents')).json() as Promise<any[]>;
}

/**
 * Poll a derived image's build log and stream new output until it finishes.
 * The build runs server-side (survives the CLI exiting); this just follows it.
 * Exits non-zero via fail() on FAILED so scripts can trust the status.
 */
async function streamImageBuild(ctx: Ctx, name: string): Promise<void> {
  let printed = 0;
  for (;;) {
    const r: any = await (await api(ctx, `/v1/images/${encodeURIComponent(name)}/log`)).json();
    const log: string = r.log ?? '';
    if (log.length > printed) {
      process.stdout.write(log.slice(printed));
      printed = log.length;
    }
    if (r.status === 'READY') {
      console.log(`\n✓ Built hatchabot-runtime:derived-${name}. Pin an agent:  hatchabot image pin <agent> ${name}`);
      return;
    }
    if (r.status === 'FAILED') fail(`\n✗ Build failed: ${r.error ?? 'see the log above'}`);
    await new Promise((res) => setTimeout(res, 1200));
  }
}

/**
 * `<agent>` → one agent. An exact name or slug wins; then a case-insensitive
 * name; an id prefix only from 4 characters. The old rule matched ANY id
 * prefix, so `hatchabot delete a` picked whichever agent's id began with "a".
 */
export function matchAgent<T extends { id: string; name: string; slug: string }>(list: T[], ref: string): { hit?: T; problem?: string } {
  const r = ref.trim();
  if (!r) return { problem: 'give an agent (name, slug or id)' };
  const one = (xs: T[], what: string) =>
    xs.length === 1 ? { hit: xs[0] } : xs.length > 1 ? { problem: `"${r}" ${what} ${xs.length} agents: ${xs.map((a) => a.name).join(', ')}` } : undefined;
  return one(list.filter((a) => a.name === r || a.slug === r), 'names')
    ?? one(list.filter((a) => a.name.toLowerCase() === r.toLowerCase()), 'names')
    ?? (r.length >= 4 ? one(list.filter((a) => a.id.startsWith(r)), 'starts the id of') : undefined)
    ?? { problem: `no agent matches "${r}"${r.length < 4 ? ' (an id needs at least 4 characters)' : ''} — try \`hatchabot list\`` };
}

async function resolveAgent(ctx: Ctx, ref: string): Promise<any> {
  const { hit, problem } = matchAgent(await agents(ctx), ref);
  return hit ?? fail(problem!);
}

/** A task by id, name, or id prefix (4+). */
export function matchTask<T extends { id: string; name?: string }>(list: T[], ref: string): { hit?: T; problem?: string } {
  const r = ref.trim();
  const exact = list.filter((t) => t.id === r || t.name === r);
  if (exact.length === 1) return { hit: exact[0] };
  if (exact.length > 1) return { problem: `"${r}" matches more than one task — use its id` };
  const loose = list.filter((t) => (t.name ?? '').toLowerCase() === r.toLowerCase() || (r.length >= 4 && t.id.startsWith(r)));
  if (loose.length === 1) return { hit: loose[0] };
  if (loose.length > 1) return { problem: `"${r}" matches more than one task — use its id` };
  return { problem: `no task matches "${r}" — see: hatchabot tasks <agent>` };
}

/** The AI source an agent should get: the one named, else your ⭐ default. */
export function pickProfile<T extends { id: string; name: string; defaultSource?: boolean; mine?: boolean }>(profiles: T[], ref?: string): { hit?: T; problem?: string } {
  if (ref) {
    const hit = profiles.find((p) => p.id === ref) ?? profiles.find((p) => p.name.toLowerCase() === ref.toLowerCase());
    return hit ? { hit } : { problem: `no AI source "${ref}" — see: hatchabot sources` };
  }
  // Not simply the first: that could be a local model nobody meant, or another
  // account's shared source. The app picks the ⭐ default; so does the CLI.
  const hit = profiles.find((p) => p.defaultSource) ?? profiles.find((p) => p.mine !== false) ?? profiles[0];
  return hit ? { hit } : { problem: 'no AI source — set one up first (web ⚙ Settings → AI sources)' };
}

/** Durations as people type them: 90s, 15m, 2h, 1d (bare number = minutes) → minutes. */
export function durationMinutes(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit === 's' ? n / 60 : unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n;
}

const ago = (iso?: string) => {
  if (!iso) return '-';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/** Interactive sign-in for identity mode; stores the refresh token 0600. */
async function doLogin(url: string, server: IdentityConfig, flags: Map<string, string>): Promise<void> {
  const { createInterface: mkRl } = await import('node:readline');
  const prompt = (q: string): Promise<string> => {
    process.stderr.write(q);
    const rl = mkRl({ input: process.stdin, output: process.stderr, terminal: false });
    return new Promise((r) => rl.once('line', (l) => { rl.close(); r(l.trim()); }));
  };

  // An access token minted by the app. The only path that works for accounts
  // with no password — i.e. anyone who signed in with Google.
  if (flags.has('token') || !flags.has('email')) {
    const token =
      flags.get('token') ||
      (await prompt(
        `Open ${url} → ⚙ Settings → Security → New token, then paste it here.\nToken: `,
      ));
    if (!token.startsWith('hatchabot_') && !token.startsWith('agentclaw_')) fail('that does not look like a Hatchabot token');
    const res = await fetch(`${url}/v1/agents`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) fail(`that token was rejected (${res.status})`);
    writeConfigValue('HATCHABOT_TOKEN', token);
    console.log(`signed in. Token saved to ${configPath()} (chmod 600)`);
    return;
  }

  if (server.authMode !== 'identity') {
    fail('this server uses a shared password — set HATCHABOT_PASSWORD instead (no login needed)');
  }
  const apiKey = server.identity?.apiKey ?? fail('server did not advertise an identity API key');
  const { createInterface } = await import('node:readline');
  const ask = (q: string): Promise<string> => {
    process.stderr.write(q);
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    return new Promise((r) => rl.once('line', (l) => { rl.close(); r(l.trim()); }));
  };
  const email = flags.get('email') || (await ask('Email: '));
  const password = await askSecret('Password: ');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const data = (await res.json()) as any;
  if (!res.ok) fail(`sign-in failed: ${data?.error?.message ?? res.status}`);
  writeConfigValue('HATCHABOT_REFRESH_TOKEN', data.refreshToken);
  console.log(`signed in as ${data.email}`);
  console.log(`refresh token saved to ${configPath()} (chmod 600)`);
}

/**
 * The `folders`/`data` command, extracted from main()'s switch so it can be
 * unit-tested with a fake API — its rm branch (legacy sharedPaths vs a real
 * data source) is real logic that would otherwise fail silently.
 */
export interface FoldersIo {
  resolveAgent: (ref: string) => Promise<any>;
  jsonPost: (path: string, body: unknown, method?: string) => Promise<{ json: () => Promise<any> }>;
  apiDelete: (path: string) => Promise<unknown>;
  log: (msg: string) => void;
  fail: (msg: string) => never;
  resolvePath: (raw: string) => string;
}

export async function runFolders(
  io: FoldersIo,
  rest: string[],
  flags: { has(k: string): boolean },
): Promise<void> {
  const usage = 'usage: hatchabot folders <agent> [add <path> [--rw] | add-repo <git-url> [--rw | --public] | rm <name>]';
  const a = await io.resolveAgent(rest[0] ?? io.fail(usage));
  const sub = rest[1];

  // Back-compat: --none still clears the legacy read-only folder list.
  if (flags.has('none')) {
    await io.jsonPost(`/v1/agents/${a.id}`, { sharedPaths: [] }, 'PATCH');
    io.log(`"${a.name}" no longer reads any legacy host folder (on its next rebuild).`);
    return;
  }

  if (sub === 'add') {
    const raw = rest[2] ?? io.fail('usage: hatchabot folders <agent> add <path> [--rw]');
    const p = io.resolvePath(raw);
    const access = flags.has('rw') ? 'rw' : 'ro';
    await io.jsonPost(`/v1/agents/${a.id}/data-sources`, { kind: 'folder', access, path: p });
    io.log(`added ${access} folder ${p}  →  /data/${p.split('/').pop()} for "${a.name}".`);
    io.log('Takes effect on the next rebuild: hatchabot rebuild ' + JSON.stringify(a.name));
    return;
  }
  if (sub === 'add-repo') {
    const url = rest[2] ?? io.fail('usage: hatchabot folders <agent> add-repo <git-url> [--rw | --public]');
    const isPublic = flags.has('public');
    if (isPublic && flags.has('rw')) io.fail('a public repo is cloned without credentials, so it can only be read-only — drop --rw, or add it with a deploy key (no --public)');
    const access = flags.has('rw') ? 'rw' : 'ro';
    const up: any = await (await io.jsonPost(`/v1/agents/${a.id}/data-sources`, { kind: 'git', access, repoUrl: url, ...(isPublic ? { public: true } : {}) })).json();
    const src = (up.dataSources ?? []).filter((d: any) => d.kind === 'git').slice(-1)[0];
    io.log(`added ${isPublic ? 'public read-only' : access} git repo  →  /data/${src?.mountName ?? '?'} for "${a.name}".`);
    if (isPublic) io.log(up.state === 'RUNNING' ? 'No deploy key needed — cloning it now.' : 'No deploy key needed — it is cloned on the next rebuild.');
    if (src?.pubKey) {
      io.log(`\nAdd this deploy key to the repo${access === 'rw' ? ' (tick "Allow write access")' : ''}, then rebuild:`);
      io.log(src.pubKey);
    }
    return;
  }
  if (sub === 'rm') {
    const ref = rest[2] ?? io.fail('usage: hatchabot folders <agent> rm <name>');
    const src = (a.dataSources ?? []).find((d: any) => d.mountName === ref || d.id === ref);
    if (!src) io.fail(`no data source named "${ref}" on "${a.name}" — see: hatchabot folders ${JSON.stringify(a.name)}`);
    if (src.legacy) {
      // Legacy folders live in the whole-list sharedPaths; drop just this one.
      const remaining = (a.sharedPaths ?? []).filter((p: string) => p !== src.hostPath);
      await io.jsonPost(`/v1/agents/${a.id}`, { sharedPaths: remaining }, 'PATCH');
    } else {
      await io.apiDelete(`/v1/agents/${a.id}/data-sources/${src.id}`);
    }
    io.log(`removed /data/${src.mountName} from "${a.name}" — rebuild to apply.`);
    return;
  }
  if (sub) io.fail(`unknown subcommand "${sub}" — ${usage}`);

  // List: one unified view of everything the agent can access (legacy read-only
  // folders + folder/git data sources), matching the web UI.
  const sources: any[] = a.dataSources ?? [];
  if (!sources.length) {
    io.log(`"${a.name}" has no data sources.`);
    return;
  }
  io.log(`"${a.name}" data (each mounted at /data/<name>):`);
  for (const d of sources) {
    const where = d.kind === 'git' ? d.repoUrl : d.hostPath;
    const tag = `${d.access} ${d.kind}`.padEnd(11);
    io.log(`  ${tag} ${String(d.mountName).padEnd(16)} ${where}${d.legacy ? '   (legacy)' : ''}`);
  }
}

function fmtTok(n: unknown): string {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(v);
}

/** A dollar amount, cents-aware for small figures: $0.05, $1.2, $47. */
function fmtUsd(n: number): string {
  if (n < 10) return '$' + n.toFixed(2);
  if (n < 100) return '$' + n.toFixed(1);
  return '$' + Math.round(n);
}

/** A cost range as one cell — collapses to a single figure when the bounds
 *  round the same, appends "+" when some tokens went unpriced. */
function fmtCostRange(c: { low: number; high: number; partial?: boolean }): string {
  const lo = fmtUsd(c.low);
  const hi = fmtUsd(c.high);
  const body = lo === hi ? lo : `${lo}–${hi}`;
  return body + (c.partial ? '+' : '');
}

/** `hatchabot health <agent>` output — a live gateway probe, mirroring ❤️ Health. */
/**
 * Render the consolidated bot census as aligned, numbered lines. Pure so the
 * column alignment and the ⇄ "same bot elsewhere" markers are testable. `hosts`
 * is the `/v1/bots` response's host list.
 */
export function fmtBots(hosts: any[], live: boolean): string[] {
  const out: string[] = [];
  const order: Record<string, number> = { 'in-use': 0, reclaimable: 1, dead: 2 };
  // Size the username column to the widest bot across every host.
  const allBots = hosts.flatMap((h: any) => (h.error ? [] : h.bots));
  const uw = Math.max(10, ...allBots.map((b: any) => `@${b.username ?? '?'}`.length));

  // Same handle in more than one place = a bot that moved between agents/hosts.
  const places = new Map<string, Array<{ host: string; agent: string; state: string }>>();
  for (const h of hosts) {
    if (h.error) continue;
    for (const b of h.bots) {
      if (!b.username) continue;
      const at = { host: h.host, agent: b.agentName ?? b.source, state: b.state ?? '?' };
      (places.get(b.username) ?? places.set(b.username, []).get(b.username)!).push(at);
    }
  }
  const movedCount = [...places.values()].filter((v) => v.length > 1).length;

  let idx = 0;
  let reclaim = 0;
  let dead = 0;
  for (const h of hosts) {
    out.push(`\n${h.host}${h.error ? `  — ${h.error}` : ''}`);
    if (h.error) continue;
    if (!h.bots.length) out.push('  (no Telegram bots)');
    for (const b of [...h.bots].sort((x, y) => (order[x.cls] ?? 9) - (order[y.cls] ?? 9))) {
      if (b.cls === 'reclaimable') reclaim++;
      if (b.cls === 'dead') dead++;
      const tag = b.cls === 'in-use' ? 'in use' : b.cls === 'dead' ? 'DEAD' : 'reclaimable';
      const live_ = live
        ? (b.valid === false ? 'invalid' : 'valid') +
          (b.polling && b.polling !== 'unknown' ? `,${b.polling === 'busy' ? 'polled' : 'idle'}` : '')
        : '';
      const who = b.source === 'pool' ? 'pool bot (unleased)' : `${b.agentName} [${b.state}]`;
      const others = (places.get(b.username) ?? []).filter(
        (o) => !(o.host === h.host && o.agent === (b.agentName ?? b.source)),
      );
      const moved = others.length
        ? `  ⇄ also ${others.map((o) => `${o.host}:${o.agent}[${o.state}]`).join(', ')}`
        : '';
      const uname = `@${b.username ?? '?'}`.padEnd(uw);
      const n = `${String(++idx)}.`.padStart(4);
      out.push(`${n} ${uname}  ${tag.padEnd(11)}${live ? `  ${live_.padEnd(13)}` : '  '}${who}${moved}`);
    }
  }
  out.push(`\n${idx} line(s) · ${reclaim} reclaimable · ${dead} dead${movedCount ? ` · ${movedCount} bot(s) shared across agents/hosts (⇄)` : ''}`);
  out.push(`Telegram won't list your bots — open @BotFather → /mybots and /deletebot any not shown above.`);
  out.push(`Not counted here: OpenClaw's own bots — check with:  openclaw config get channels.telegram.accounts`);
  return out;
}

export function fmtHealth(name: string, h: any): string {
  const label =
    { healthy: 'responding', degraded: 'degraded', unreachable: 'not answering' }[
      h.status as string
    ] ?? String(h.status);
  const lines = [`${name}: ${label}`];
  if (h.reachable && h.telegram) {
    const t = h.telegram;
    lines.push(`  telegram: ${t.connected ? 'connected' : `disconnected${t.lastError ? ` (${t.lastError})` : ''}`}`);
  }
  if (h.eventLoop?.degraded) {
    lines.push(`  event loop: degraded${h.eventLoop.reasons?.length ? ' — ' + h.eventLoop.reasons.join(', ') : ''}`);
  }
  if (h.pluginErrors?.length) lines.push(`  plugin errors: ${h.pluginErrors.join(', ')}`);
  return lines.join('\n');
}

/** `hatchabot usage <agent>` output — tokens by model, mirroring 📊 Usage. */
export function fmtUsage(name: string, u: any): string {
  if (!u.sessions) return `${name}: no sessions yet`;
  const lines = [`${name}: ${fmtTok(u.totalTokens)} tokens · ${u.sessions} session${u.sessions > 1 ? 's' : ''}`];
  for (const m of u.byModel ?? []) lines.push(`  ${String(m.model).padEnd(24)} ${fmtTok(m.tokens)}`);
  return lines.join('\n');
}

/** One agent's cost cell for the fleet table: a range for API-keyed agents,
 *  else the reason it has no per-token cost. */
function usageCostCell(a: any): string {
  if (a.billing === 'local') return 'local';
  if (a.billing === 'included') return 'incl.';
  return a.cost ? fmtCostRange(a.cost) : '—';
}

/** `hatchabot usage` (no agent) — running agents ranked by tokens, with an
 *  estimated API cost range (est. — OpenClaw reports combined in+out tokens). */
export function fmtFleetUsage(f: any): string {
  const agents: any[] = f.agents ?? [];
  if (!agents.length) {
    return f.skipped ? `No running agents to measure (${f.skipped} stopped — usage is live-only).` : 'No agents yet.';
  }
  const nw = Math.max(5, ...agents.map((a) => String(a.name).length));
  const cells = agents.map(usageCostCell);
  const cw = Math.max(4, ...cells.map((c) => c.length), f.cost ? fmtCostRange(f.cost).length : 0);
  const lines = agents.map((a, i) => {
    const top = a.byModel?.[0]?.model ? `  ${a.byModel[0].model}${a.byModel.length > 1 ? ` +${a.byModel.length - 1}` : ''}` : '';
    return `  ${String(a.name).padEnd(nw)}  ${fmtTok(a.totalTokens).padStart(6)}  ${cells[i]!.padStart(cw)}  ${String(a.sessions).padStart(3)} sess${top}`;
  });
  const totalCost = f.cost ? fmtCostRange(f.cost) : '—';
  lines.push(`  ${'—'.repeat(nw)}  ${fmtTok(f.totalTokens).padStart(6)}  ${totalCost.padStart(cw)}  ${String(f.totalSessions).padStart(3)} sess  (${f.counted} running${f.skipped ? `, ${f.skipped} not counted — live-only` : ''})`);
  if (f.cost) lines.push(`  est. API cost across ${f.cost.agents} API-keyed agent${f.cost.agents > 1 ? 's' : ''}: ${totalCost} — range brackets in/out; subscription & local agents cost $0.`);
  return lines.join('\n');
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  const devDir = process.env.HATCHABOT_DEV_DIR ?? configDefaults().HATCHABOT_DEV_DIR;
  if (!cmd || cmd === 'help' || flags.has('help')) {
    console.log(USAGE + (devDir ? MAINTAINER_USAGE : ''));
    return;
  }

  // Release commands for the machine Hatchabot is DEVELOPED on: HATCHABOT_DEV_DIR
  // names the development checkout (the scripts, your push rights). Anywhere else
  // they do not exist — nobody else publishes releases, and `upgrade` is their verb.
  if (cmd === 'deploy' || cmd === 'promote' || cmd === 'channels') {
    if (!devDir) fail(`"${cmd}" is for the machine Hatchabot is developed on. To update this machine: hatchabot upgrade`);
    const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    let argv: string[];
    if (cmd === 'deploy') {
      git(devDir, 'fetch', '--tags', '--force', '--quiet', 'origin');
      const tag = rest[0] ?? git(devDir, 'tag', '-l', 'v[0-9]*', '--sort=-v:refname').split('\n').find((t) => t && !/-(rc|beta|alpha)/.test(t));
      argv = [join(devDir, 'scripts', 'deploy-release.sh'), tag ?? fail('no release tags')];
    } else if (cmd === 'promote') {
      // Default: what this machine runs — you promote what you have been running.
      let tag = rest[0];
      if (!tag) { try { tag = git(repoDir(), 'describe', '--tags', '--exact-match'); } catch { fail('this machine is not on a release — say which: hatchabot promote vX.Y.Z'); } }
      argv = [join(devDir, 'scripts', 'promote.sh'), tag!, rest[1] ?? 'stable'];
    } else {
      argv = [join(devDir, 'scripts', 'channels.sh'), ...rest];
    }
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('bash', argv, { stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
    return;
  }

  const defaults = configDefaults();
  const url = (
    flags.get('url') ?? process.env.HATCHABOT_URL ?? defaults.HATCHABOT_URL ?? 'http://localhost:8080'
  ).replace(/\/$/, '');
  const password =
    flags.get('password') ?? process.env.HATCHABOT_PASSWORD ?? defaults.HATCHABOT_PASSWORD ?? '';

  // Diagnostics must work when the control plane is down — no handshake, no login.
  /**
   * Accounts-mode recovery, run ON the machine. Deliberately NOT an API call:
   * the point is to get back in when nobody can sign in — a forgotten host
   * owner password is otherwise an unrecoverable lockout, since there is no
   * email to send a reset to. Write access to the database IS the proof of
   * ownership here, the same trust as editing HATCHABOT_PASSWORD in .env.
   */
  if (cmd === 'accounts' || cmd === 'account') {
    process.chdir(repoDir());
    const sub = rest[0] ?? 'list';
    const { Store } = await import('./store/store.js');
    const { default: Database } = await import('better-sqlite3');
    const { defaultDbPath } = await import('./envCompat.js');
    // The checkout's .env says where the data lives (a production install keeps
    // it outside the checkout); without reading it, this found no database there.
    const { envMap } = await import('./doctor.js');
    const dotenv = envMap('.env');
    const dbPath = process.env.HATCHABOT_DB ?? dotenv.HATCHABOT_DB ?? defaultDbPath();
    if (!existsSync(dbPath)) {
      console.error(`No database at ${dbPath}. Is this the Hatchabot checkout?`);
      process.exitCode = 1;
      return;
    }
    const store = new Store(new Database(dbPath));
    const rows = store.listLocalAccounts();
    if (sub === 'list') {
      if (!rows.length) {
        console.log('No local accounts. Either this install is not in accounts mode');
        console.log('(HATCHABOT_AUTH=accounts in .env), or nobody has created the first one yet —');
        console.log('open the app and it offers to.');
        return;
      }
      for (const a of rows) {
        const agents = store.listAgents(a.id).filter((x) => x.state !== 'DELETED').length;
        console.log(`${a.username}${a.hostOwner ? '  (host owner)' : ''}${a.disabled ? '  [disabled]' : ''}  ${agents} agent${agents === 1 ? '' : 's'}`);
      }
      return;
    }
    if (sub === 'reset-password' || sub === 'reset') {
      const username = rest[1];
      // Typed at a hidden prompt when not given: an argument lands in shell history.
      const newPassword = rest[2] ?? flags.get('new-password') ?? (username ? await askSecret(`New password for ${username}: `) : '');
      if (!username || !newPassword) {
        console.error('Usage: hatchabot accounts reset-password <username>   (prompts for the password)');
        process.exitCode = 1;
        return;
      }
      const account = store.localAccountByUsername(username);
      if (!account) {
        console.error(`No account "${username}". Known: ${rows.map((r) => r.username).join(', ') || '(none)'}`);
        process.exitCode = 1;
        return;
      }
      const { hashPassword, passwordProblem } = await import('./api/accountsAuth.js');
      const problem = passwordProblem(newPassword);
      if (problem) { console.error(problem); process.exitCode = 1; return; }
      const { hash, salt } = await hashPassword(newPassword);
      store.setLocalAccountPassword(account.id, hash, salt);
      console.log(`Password reset for ${account.username}. Every session of that account is now signed out.`);
      return;
    }
    if (sub === 'create' || sub === 'add') {
      // An account made from the machine itself — for a machine set up by a
      // program (a hosting provisioner) or by someone with no browser at hand.
      // Opening this database is the credential, as for reset-password. No
      // password is set here: the person chooses their own on a one-time link.
      const username = (rest[1] ?? '').trim();
      const owner = flags.has('host-owner');
      const { usernameProblem } = await import('./api/accountsAuth.js');
      const problem = username ? usernameProblem(username) : 'Usage: hatchabot accounts create <username> [--host-owner] [--cli-token [--token-days N]] [--json]';
      if (problem) { console.error(problem); process.exitCode = 1; return; }
      if (store.localAccountByUsername(username)) { console.error(`There is already an account "${username}".`); process.exitCode = 1; return; }
      if (owner && rows.some((r) => r.hostOwner)) {
        console.error('This installation already has its owner. Add other people without --host-owner.');
        process.exitCode = 1; return;
      }
      if (!owner && !rows.some((r) => r.hostOwner)) {
        console.error('Create the owner first: hatchabot accounts create <username> --host-owner');
        process.exitCode = 1; return;
      }
      const { randomBytes, randomUUID } = await import('node:crypto');
      const id = `acct-${randomUUID()}`;
      store.insertLocalAccount({ id, username, pwHash: '', pwSalt: '', hostOwner: owner, disabled: false, createdAt: new Date().toISOString() });
      // The owner inherits what an earlier password-mode install made, as account #1 does in the app.
      if (owner) store.adoptLocalOwnerData(id);
      store.recordAccount(id, username.includes('@') ? username : undefined);
      const code = randomBytes(16).toString('base64url');
      const expiresAt = new Date(Date.now() + 48 * 3600_000).toISOString();
      store.setLocalAccountClaim(id, code, expiresAt);
      const days = Math.min(Math.max(Math.floor(Number(flags.get('token-days') ?? 1)) || 1, 1), 90);
      const token = flags.has('cli-token') ? store.createCliToken(id, 'command line', days) : undefined;
      const base = (process.env.HATCHABOT_PUBLIC_URL ?? dotenv.HATCHABOT_PUBLIC_URL ?? `http://localhost:${dotenv.PORT ?? 8080}`).replace(/\/$/, '');
      const link = `${base}/?claim=${code}`;
      const mode = process.env.HATCHABOT_AUTH ?? dotenv.HATCHABOT_AUTH ?? 'password';
      if (flags.has('json')) {
        console.log(JSON.stringify({ id, username, hostOwner: owner, claimUrl: link, claimExpiresAt: expiresAt,
          ...(token ? { cliToken: token.token, cliTokenExpiresAt: token.expiresAt } : {}), authMode: mode }));
      } else {
        console.log(`Created ${username}${owner ? ' (host owner)' : ''}. They choose a password here — once, within 48 hours:`);
        console.log(`  ${link}`);
        if (token) console.log(`CLI token (expires ${token.expiresAt.slice(0, 10)}):\n  ${token.token}`);
      }
      if (mode !== 'accounts') console.error(`note: this install signs in with "${mode}", so accounts are not used yet — set HATCHABOT_AUTH=accounts in .env and restart.`);
      return;
    }
    console.error(`Unknown: accounts ${sub}. Try: list | create <username> [--host-owner] | reset-password <username>`);
    process.exitCode = 1;
    return;
  }

  if (cmd === 'upgrade') {
    // A shell script, not TypeScript: it checks out a different release of the
    // very code this process is running from, then restarts the service.
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync('bash', [join(repoDir(), 'scripts', 'upgrade.sh'), ...rest.slice(0, 1)], { stdio: 'inherit' });
    process.exitCode = r.status ?? 1;
    return;
  }

  if (cmd === 'doctor') {
    process.chdir(repoDir()); // .env, data/ and the scripts live in the checkout, wherever doctor was typed
    const { doctorReport, gatherFacts } = await import('./doctor.js');
    const facts = await gatherFacts(url);
    const lines = doctorReport(facts);
    if (flags.has('json')) {
      // For a program watching many installs (a hosting monitor): the verdict,
      // the same lines a person reads, and the raw facts behind them.
      const fails = lines.filter((l) => l.level === 'fail').length;
      console.log(JSON.stringify({
        ok: fails === 0,
        fails,
        warns: lines.filter((l) => l.level === 'warn').length,
        at: new Date().toISOString(),
        lines,
        facts,
      }));
      if (fails) process.exitCode = 1;
      return;
    }
    for (const l of lines) console.log(`${l.level === 'ok' ? '✓' : l.level === 'warn' ? '⚠' : '✗'} ${l.text}${l.fix ? `\n    → ${l.fix}` : ''}`);
    const fails = lines.filter((l) => l.level === 'fail').length, warns = lines.filter((l) => l.level === 'warn').length;
    console.log(fails ? `\n${fails} problem${fails === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}.` : `\nAll good${warns ? ` (${warns} warning${warns === 1 ? '' : 's'})` : ''}.`);
    if (fails) process.exitCode = 1;
    return;
  }

  const server = await serverConfig(url);
  if (cmd === 'login') {
    await doLogin(url, server, flags);
    return;
  }

  // A saved token belongs to the server it was minted on. Pointing the CLI at a
  // different one (--url, HATCHABOT_URL) used to send it anyway, and the answer
  // was a bare "auth required" that blamed the wrong thing.
  const savedUrl = (defaults.HATCHABOT_URL ?? '').replace(/\/$/, '');
  const tokenFromEnv = !!process.env.HATCHABOT_TOKEN;
  const savedToken = process.env.HATCHABOT_TOKEN ?? defaults.HATCHABOT_TOKEN;
  // Pointing at another server on purpose, with a password for it? That beats a
  // token saved for somewhere else — most saved configs carry a token and no
  // URL, so the mismatch can't always be detected from the config alone.
  const urlWasChosen = flags.has('url') || !!process.env.HATCHABOT_URL;
  const passwordWasChosen = flags.has('password') || !!process.env.HATCHABOT_PASSWORD;
  const preferPassword = urlWasChosen && passwordWasChosen && (!savedUrl || savedUrl !== url);
  const tokenFitsUrl = !preferPassword && (tokenFromEnv || !savedUrl || savedUrl === url);

  let ctx: Ctx;
  if (savedToken && preferPassword) {
    ctx = await login(url, password);
  } else if (savedToken && tokenFitsUrl) {
    ctx = { url, cookie: '', bearer: savedToken };
  } else if (savedToken) {
    fail(
      `the saved access token was minted for ${savedUrl}, but you asked for ${url}.\n` +
        `  Use a password for this one:  HATCHABOT_PASSWORD=… hatchabot --url ${url} …\n` +
        `  or sign in to it:             hatchabot login --url ${url}`,
    );
    throw new Error('unreachable');
  } else if (server.authMode === 'identity') {
    const refresh = process.env.HATCHABOT_REFRESH_TOKEN ?? defaults.HATCHABOT_REFRESH_TOKEN;
    const apiKey = server.identity?.apiKey;
    if (!refresh || !apiKey) fail('this server uses accounts — run: hatchabot login');
    ctx = { url, cookie: '', bearer: await idTokenFrom(refresh, apiKey) };
  } else if (server.authMode === 'accounts') {
    // Accounts have no shared password: a stale HATCHABOT_PASSWORD from an
    // older install (or a copied laptop) got a bare "login failed (401) — check
    // HATCHABOT_PASSWORD", which sent people looking for the wrong thing.
    fail('this server uses per-person accounts, not a shared password — sign in once with: hatchabot login\n  (open the app → ⚙ Settings → Security → New token, then paste it)');
  } else {
    ctx = await login(url, password);
  }

  const jsonPost = (path: string, body: unknown, method = 'POST') =>
    api(ctx, path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const askLine = async (promptText: string): Promise<string> => {
    process.stderr.write(promptText);
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    return new Promise((res, rej) => {
      let got = false;
      rl.once('line', (l) => { got = true; rl.close(); res(l.trim()); });
      // Non-interactive stdin closes without ever emitting a line. Without
      // this the command hangs forever holding a half-made agent.
      rl.once('close', () => { if (!got) rej(new Error('no input available — pass the value as a flag')); });
    });
  };

  const minutesFlag = (fallback: number): number => {
    const v = Number(flags.get('timeout') ?? fallback);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  // Bounded: an agent stuck provisioning used to hold the command forever,
  // which a script or a regression run can't tell from progress (CLI audit).
  const pollAgent = async (id: string): Promise<any> => {
    const limit = minutesFlag(15);
    const deadline = Date.now() + limit * 60_000;
    for (;;) {
      const a = (await (await api(ctx, `/v1/agents/${id}`)).json()) as any;
      if (a.state === 'RUNNING' || a.state === 'FAILED' || a.pendingAction) return a;
      if (Date.now() > deadline) fail(`still ${a.state} after ${limit} min — it may yet finish; check: hatchabot list`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  };

  switch (cmd) {
    case 'sources': {
      // Summary: which agents are on which AI source, and which models they run.
      const [profiles, list, usage] = await Promise.all([
        (await api(ctx, '/v1/ai-profiles')).json() as Promise<any[]>,
        (await api(ctx, '/v1/agents')).json() as Promise<any[]>,
        // Live spend and rate-limit state. Best-effort: an older server, or one
        // that hasn't sampled yet, simply has nothing to add.
        (async () => { try { return (await (await api(ctx, '/v1/ai-profiles/usage')).json()) as any; } catch { return { sources: [] }; } })(),
      ]);
      const usageOf = (id: string) => (usage?.sources ?? []).find((u: any) => u.id === id);
      const owned = list.filter((a) => !a.role || a.role === 'owner');
      const bySource = new Map<string, any[]>();
      for (const a of owned) (bySource.get(a.aiProfileId) ?? bySource.set(a.aiProfileId, []).get(a.aiProfileId)!).push(a);

      console.log('AI sources:');
      for (const p of profiles) {
        const n = (bySource.get(p.id) ?? []).length;
        const cred = p.kind === 'subscription'
          ? (p.credential === 'setup-token' ? 'subscription · setup-token' : 'subscription · machine-login')
          : p.kind === 'local' ? 'local' : `api key · ${p.vendor}`;
        const others = p.inUse?.others ?? 0;
        console.log(`  ${p.name}  [${cred}${p.shared ? ' · shared' : ''}]  ${n} agent${n === 1 ? '' : 's'}${others ? ` + ${others} on other accounts` : ''}  ${p.id}`);
        // The answer to "why has everything gone quiet?" belongs here, not
        // only in the web app.
        const u = usageOf(p.id);
        if (u && u.status !== 'idle') {
          const w5 = u.window5h ?? {}, w7 = u.window7d ?? {};
          const state = u.status === 'limited'
            ? `RATE-LIMITED since ${new Date(u.limitedSince ?? u.lastLimitAt).toLocaleString()}`
            : 'answering';
          console.log(`      ${state} · last 5 h: ${w5.requests ?? 0} requests${w5.limited ? `, ${w5.limited} refused` : ''} · last 7 d: ${w7.requests ?? 0} requests${w7.limited ? `, ${w7.limited} refused` : ''}`);
          const top = (u.topAgents ?? []).slice(0, 3).map((a: any) => `${a.name} ${a.requests}`).join(' · ');
          if (top) console.log(`      heaviest: ${top}`);
        }
      }
      const orphanIds = [...bySource.keys()].filter((id) => !profiles.some((p) => p.id === id));
      for (const id of orphanIds) console.log(`  (unknown source ${id.slice(0, 8)})  ${bySource.get(id)!.length} agents`);

      console.log('\nModels in use now:');
      const byModel = new Map<string, number>();
      for (const a of owned) byModel.set(a.model ?? '(none)', (byModel.get(a.model ?? '(none)') ?? 0) + 1);
      for (const [m, c] of [...byModel.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${String(c).padStart(3)}  ${m}`);
      const pending = owned.filter((a) => a.pendingModel && a.pendingModel !== a.model);
      if (pending.length) console.log(`  (${pending.length} will change on next rebuild)`);

      console.log('\nBy source:');
      for (const p of profiles) {
        const ags = bySource.get(p.id) ?? [];
        if (!ags.length) continue;
        console.log(`  ${p.name}:`);
        for (const a of ags.sort((x, y) => x.name.localeCompare(y.name))) {
          const pin = a.modelOverride ? ' (pinned)' : '';
          const soon = a.pendingModel && a.pendingModel !== a.model ? ` -> ${a.pendingModel} on rebuild` : '';
          console.log(`    - ${a.name}  ${a.model ?? '(no model)'}${pin}${soon}`);
        }
      }
      return;
    }
    case 'switch-source': {
      // Move agents onto one AI source in a single call. --to <id|name>,
      // optional --agents a,b,c (default: ALL of yours), --rebuild to apply now.
      const profiles: any[] = await (await api(ctx, '/v1/ai-profiles')).json() as any[];
      const want = flags.get('to') ?? fail('usage: hatchabot switch-source --to <source id or name> [--agents a,b] [--rebuild]');
      const target = profiles.find((p) => p.id === want || p.name.toLowerCase() === want.toLowerCase())
        ?? fail(`no AI source matches "${want}". Have: ${profiles.map((p) => p.name).join(', ') || '(none)'}`);
      const apply = flags.get('agents')?.split(',').map((x) => x.trim()).filter(Boolean);
      let ids: string[] | undefined;
      if (apply) {
        // Resolve names/slugs to ids so a human can pass either.
        const all: any[] = await (await api(ctx, '/v1/agents')).json() as any[];
        ids = apply.map((a) => all.find((x) => x.id === a || x.slug === a || x.name.toLowerCase() === a.toLowerCase())?.id ?? a);
      }
      const res: any = await (await jsonPost(`/v1/ai-profiles/${target.id}/adopt-agents`, {
        apply: ids,
        rebuild: flags.has('rebuild'),
      })).json();
      console.log(`switched ${res.switched} agent(s) to "${target.name}"${res.rebuilding ? `, rebuilding ${res.rebuilding} now` : ' (rebuild to apply)'}`);
      for (const s of res.skipped ?? []) console.log(`  skipped ${s.name}: ${s.reason}`);
      return;
    }
    case 'create': {
      const name = rest.join(' ').trim() || fail('usage: hatchabot create <name> [options]');
      const profiles: any[] = await (await api(ctx, '/v1/ai-profiles')).json() as any[];
      const hosts: any[] = await (await api(ctx, '/v1/hosts')).json() as any[];
      const picked = pickProfile(profiles, flags.get('profile'));
      const profile = picked.hit?.id ?? fail(picked.problem!);
      const host = flags.get('host') ?? (hosts.find((h) => h.kind === 'local') ?? hosts[0])?.id ?? fail('no host configured');
      const res = await jsonPost('/v1/agents', {
        name,
        persona: flags.get('persona') || undefined,
        aiProfileId: profile,
        hostId: host,
        sharedMemory: !flags.has('private'),
        // --no-telegram: no bot; talk to it in the web app's console.
        telegram: flags.has('no-telegram') ? false : undefined,
      });
      const created: any = await res.json();
      console.log(`creating "${name}"…`);
      let a = await pollAgent(created.id);
      if (a.pendingAction?.type === 'bot_token') {
        let tok = flags.get('bot-token');
        if (!tok) {
          console.log(a.pendingAction.instructions ?? 'A Telegram bot token is needed.');
          tok = await askLine('Paste bot token: ');
        }
        const sub: any = await (await jsonPost(`/v1/agents/${a.id}/channel-token`, { token: tok })).json();
        console.log(`bot @${sub.username} attached — provisioning…`);
        a = await pollAgent(a.id);
      }
      if (a.state === 'FAILED') fail(`provisioning failed: ${a.stateReason ?? 'unknown'} (try: hatchabot retry "${name}")`);
      console.log(`"${a.name}" is RUNNING.`);
      if (a.deepLink) console.log(`Say hi to claim it as owner: ${a.deepLink}`);
      else if (a.webOnly) console.log('No Telegram bot: talk to it in the web app (click its icon).');
      return;
    }
    case 'delete': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot delete <agent> [--yes]'));
      try {
        const t: any = await (await api(ctx, `/v1/agents/${a.id}/bot-token`)).json();
        if (!t.pooled) console.log(`note: bot @${t.accountId} is not pool-managed — save its token first (hatchabot token) if you want to recycle it.`);
      } catch { /* no channel yet — nothing to save */ }
      if (!flags.has('yes')) {
        const typed = await askLine(`This permanently erases "${a.name}" and everything it remembers.\nType the agent's name to confirm: `);
        if (typed !== a.name) fail('name did not match — nothing deleted');
      }
      await api(ctx, `/v1/agents/${a.id}`, { method: 'DELETE' });
      console.log(`"${a.name}" deleted.`);
      return;
    }
    case 'retry': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot retry <agent>'));
      await jsonPost(`/v1/agents/${a.id}/provision`, {});
      console.log(`retry requested for "${a.name}" — watch with: hatchabot list`);
      return;
    }
    case 'rename': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot rename <agent> <new name>'));
      const name = rest.slice(1).join(' ').trim() || fail('give the new name');
      await jsonPost(`/v1/agents/${a.id}`, { name }, 'PATCH');
      console.log(`renamed to "${name}"`);
      return;
    }
    case 'ai': {
      const profiles: any[] = await (await api(ctx, '/v1/ai-profiles')).json() as any[];
      if (!rest[0]) {
        for (const p of profiles) {
          console.log(`${p.id}  ${p.model.padEnd(24)} ${p.vendor === 'local' ? 'local' : p.kind}  ${p.name}`);
        }
        console.log('\nhatchabot ai <agent> <profileId>   to point an agent at one');
        return;
      }
      const a = await resolveAgent(ctx, rest[0]);
      if (!rest[1]) {
        const cur = profiles.find((p) => p.id === a.aiProfileId);
        // Prefer the agent's effective model (its per-agent override if any)
        // over the source's default — that's what this agent actually runs.
        console.log(`${a.name}: ${cur?.name ?? '(unknown)'} — ${a.model ?? cur?.model}`);
        return;
      }
      await jsonPost(`/v1/agents/${a.id}`, { aiProfileId: rest[1] }, 'PATCH');
      console.log(`"${a.name}" will use that AI source after: hatchabot rebuild "${a.name}"`);
      return;
    }
    case 'adopt': {
      const dir = rest[0] ?? fail('usage: hatchabot adopt <workspace-dir> <name>');
      const name = rest.slice(1).join(' ').trim() || fail('give the new agent a name');

      const preview: any = await (await jsonPost('/v1/workspaces/inspect', { path: dir })).json();
      console.log(`${preview.path}`);
      const md: string[] = preview.markdownFiles;
      const shown = md.slice(0, 8).join(', ') + (md.length > 8 ? `, +${md.length - 8} more` : '');
      console.log(`  ${preview.files.length} files (${(preview.bytes / 1e6).toFixed(1)} MB), ${md.length} markdown: ${shown}`);
      if (preview.skipped?.length) {
        console.log(`  skipping ${preview.skipped.join(', ')} — built for this machine, and the agent can rebuild them`);
      }

      const bot = preview.existingBot;
      if (bot) {
        console.log(`  already has a bot: @${bot.accountId} (used by "${bot.sourceAgentId}" in your hand-built instance)`);
        if (!flags.has('reuse-bot')) {
          console.log(`  --reuse-bot takes it over: costs no new bot slot, and whoever already`);
          console.log(`  messages @${bot.accountId} keeps the same conversation.`);
        }
      }
      if (flags.has('reuse-bot')) {
        if (!bot) fail(`no existing bot is bound to ${preview.path} — drop --reuse-bot and make one with @BotFather`);
        // Telegram hands each message to exactly ONE poller. Taking over a bot
        // the old instance still polls does not fail loudly — messages just
        // start disappearing into whichever copy won the race.
        if (bot.enabledInSource || bot.polling === 'busy') {
          fail(`@${bot.accountId} is still live for "${bot.sourceAgentId}" in your hand-built instance.\n` +
            `Hand the bot over there first — two pollers on one token lose messages silently:\n` +
            `  openclaw config set channels.telegram.accounts.${bot.accountId}.enabled false\n` +
            `  systemctl --user restart openclaw-gateway\n` +
            `Then run this again.`);
        }
      }

      const profiles: any[] = await (await api(ctx, '/v1/ai-profiles')).json() as any[];
      const hosts: any[] = await (await api(ctx, '/v1/hosts')).json() as any[];
      const profile = flags.get('profile') ?? profiles[0]?.id ?? fail('no AI source configured');
      const host = (hosts.find((h) => h.kind === 'local') ?? hosts[0])?.id ?? fail('no host configured');

      console.log(`creating "${name}"…`);
      // Carry the people already cleared to talk to it, so adopting doesn't
      // make the owner pair with their own agent. Independent of which bot it
      // ends up on: the allowlist names Telegram *users*, and they are the same
      // people whether or not the bot is reused.
      const seedMembers: string[] = bot?.allowFrom ?? [];
      if (seedMembers.length) {
        console.log(`  keeping ${seedMembers.length} approved chat member(s) — no re-pairing`);
      }
      const created: any = await (await jsonPost('/v1/agents', {
        name, aiProfileId: profile, hostId: host, sharedMemory: false,
        ...(seedMembers.length ? { seedMembers } : {}),
      })).json();

      // Everything past this point owns a half-made agent. If any step fails we
      // delete it before exiting: leaving it behind would hold the name, so the
      // obvious next move — run the same command again — would fail on a
      // collision instead of retrying.
      let res: any;
      try {
        let a = await pollAgent(created.id);
        if (a.pendingAction?.type === 'bot_token' && flags.has('reuse-bot')) {
          await jsonPost(`/v1/agents/${a.id}/channel-token`, { fromWorkspace: dir });
          console.log(`  took over @${bot!.accountId} — same bot, same conversations`);
          a = await pollAgent(a.id);
        } else if (a.pendingAction?.type === 'bot_token') {
          console.log(a.pendingAction.instructions ?? 'A Telegram bot token is needed.');
          let tok = flags.get('bot-token');
          // A wrong or already-used token is a typo-grade mistake, and we are
          // sitting at a prompt — ask again rather than discard the agent.
          for (let attempt = 0; ; attempt++) {
            if (!tok) tok = await askLine('Paste bot token: ');
            try {
              await jsonPost(`/v1/agents/${a.id}/channel-token`, { token: tok });
              break;
            } catch (err) {
              if (attempt >= 2 || flags.get('bot-token')) throw err;
              console.error(`  ${err instanceof Error ? err.message : String(err)}`);
              tok = undefined;
            }
          }
          a = await pollAgent(a.id);
        }
        if (a.state === 'FAILED') throw new Error(`could not start: ${a.stateReason ?? 'unknown'}`);

        res = await (await jsonPost(`/v1/agents/${a.id}/adopt-workspace`, { path: dir })).json();
      } catch (err) {
        await api(ctx, `/v1/agents/${created.id}`, { method: 'DELETE' }).catch(() => {});
        fail(`${err instanceof Error ? err.message : String(err)}\n` +
          `Nothing was adopted and "${name}" was cleaned up — fix the cause and run it again.`);
      }
      console.log(`adopted ${res.files} files (${(res.bytes / 1e6).toFixed(1)} MB) into "${name}".`);
      console.log(`The original at ${preview.path} is untouched — retire it when you're happy,`);
      console.log(`and do not point both at the same Telegram bot.`);
      return;
    }
    case 'data':
    case 'folders': {
      await runFolders(
        {
          resolveAgent: (ref) => resolveAgent(ctx, ref),
          jsonPost,
          apiDelete: (p) => api(ctx, p, { method: 'DELETE' }),
          log: console.log,
          fail,
          resolvePath: (raw) => resolve(raw.replace(/^~(?=\/|$)/, homedir())),
        },
        rest,
        flags,
      );
      return;
    }
    case 'health': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot health <agent>'));
      const h: any = await (await api(ctx, `/v1/agents/${a.id}/health`)).json();
      console.log(fmtHealth(a.name, h));
      return;
    }
    case 'usage': {
      // No agent named → the fleet rollup, agents ranked by tokens.
      if (!rest[0]) {
        const f: any = await (await api(ctx, '/v1/usage')).json();
        console.log(fmtFleetUsage(f));
        return;
      }
      const a = await resolveAgent(ctx, rest[0]);
      const u: any = await (await api(ctx, `/v1/agents/${a.id}/usage`)).json();
      console.log(fmtUsage(a.name, u));
      return;
    }
    case 'runtime': {
      const r: any = await (await api(ctx, '/v1/runtime')).json();
      console.log(`Runtime image: OpenClaw ${r.imageVersion ?? 'unknown'}`);
      if (!r.npmLatest) console.log('  (could not reach npm to check the latest stable)');
      else if (r.upgradeAvailable) {
        console.log(`  ⬆ latest stable on npm is ${r.npmLatest} — upgrade with: hatchabot upgrade-image`);
        if (r.upgradeNeedsSharedEmbedder) console.log(`    an image for it carries no memory search engine: its agents use the shared service${r.upgradeBuildable ? '' : ' — start it first: hatchabot embedder start'}`);
      }
      else console.log(`  ✓ up to date with the latest stable (${r.npmLatest})`);
      if (r.npmExtendedStable) console.log(`  extended-stable track: ${r.npmExtendedStable}`);
      return;
    }
    case 'upgrade-image': {
      let version = flags.get('version');
      if (!version) {
        const r: any = await (await api(ctx, '/v1/runtime')).json();
        version = r.npmLatest;
        if (!version) fail('Could not determine the latest OpenClaw version from npm — pass one with --version <X>.');
        console.log(`No --version given; using the latest stable on npm: ${version}`);
      }
      const candidate = flags.has('candidate');
      const script = join(repoDir(), 'scripts', 'build-runtime-image.sh');
      if (!existsSync(script)) fail(`Build script not found at ${script} — run this on the Hatchabot host.`);
      console.log(`Building hatchabot-runtime for OpenClaw ${version}${candidate ? ' (candidate — :latest untouched)' : ' (promotes to :latest)'}…\n`);
      try {
        execFileSync('bash', [script], {
          stdio: 'inherit',
          env: { ...process.env, OPENCLAW_VERSION: version, NO_LATEST: candidate ? '1' : '', ...(flags.has('no-engine') ? { EMBED_ENGINE: 'none' } : {}) },
        });
      } catch {
        fail('Image build failed — see the output above.');
      }
      if (candidate) {
        console.log(`\nCandidate built (:latest untouched). Smoke-test it, then promote:`);
        console.log(`  HATCHABOT_IMAGE=hatchabot-runtime:${version} npm run e2e:docker   (from ${repoDir()})`);
        console.log(`  docker tag hatchabot-runtime:${version} hatchabot-runtime:latest`);
      } else {
        console.log(`\nDone — :latest is now OpenClaw ${version}. Each agent shows "update available";`);
        console.log(`Rebuild it to adopt the new version, memory kept:  hatchabot rebuild "<agent>"`);
      }
      return;
    }
    case 'image':
    case 'images': {
      // Derived runtime images: FROM the base + your Dockerfile lines, for system
      // packages a volume install can't provide. Host-owner only (the API gates
      // it). A bare name means the derived tag from deriveTag — imported, not
      // re-spelled, so the tag scheme has exactly one definition.
      const { deriveTag } = await import('./orchestrator/derivedImage.js');
      const toTag = (ref: string) => (ref.includes(':') ? ref : deriveTag(ref));
      const sub = rest[0];

      if (!sub || sub === 'list') {
        const r: any = await (await api(ctx, '/v1/images')).json();
        if (!r.images?.length) {
          console.log(`No derived images. Build one:\n  hatchabot image derive <name> --from <Dockerfile-snippet>`);
          console.log(`(base: ${r.base})`);
          return;
        }
        console.log(`base: ${r.base}\n`);
        for (const img of r.images) {
          const mark = img.status === 'READY' ? '✓' : img.status === 'FAILED' ? '✗' : '…';
          const pins = img.pinnedBy ? `  ${img.pinnedBy} agent(s)` : '';
          console.log(`${mark} ${img.name.padEnd(20)} ${img.tag.padEnd(38)} ${img.status}${pins}`);
          if (img.status === 'FAILED' && img.error) console.log(`    ${img.error.split('\n').pop()}`);
        }
        return;
      }

      if (sub === 'derive') {
        const name = rest[1] ?? fail('usage: hatchabot image derive <name> [--from <file>] [--base <tag>]');
        // The Dockerfile snippet comes from --from <file>, or stdin if piped.
        const fromFile = flags.get('from');
        let dockerfile: string;
        if (fromFile) {
          dockerfile = readFileSync(resolve(fromFile.replace(/^~(?=\/|$)/, homedir())), 'utf8');
        } else if (!process.stdin.isTTY) {
          dockerfile = readFileSync(0, 'utf8');
        } else {
          fail('Provide the Dockerfile lines with --from <file>, or pipe them on stdin.\n' +
            "  e.g.  echo 'RUN apt-get update && apt-get install -y ffmpeg' | hatchabot image derive media");
        }
        if (!dockerfile.trim()) fail('The Dockerfile snippet is empty.');
        const body: any = { name, dockerfile };
        if (flags.get('base')) body.base = flags.get('base');
        const res: any = await (await jsonPost('/v1/images', body)).json();
        console.log(`Building ${res.tag}… (runs as root, then restores USER node)\n`);
        await streamImageBuild(ctx, name);
        return;
      }

      if (sub === 'rebuild') {
        const name = rest[1] ?? fail('usage: hatchabot image rebuild <name> [--base <tag>]');
        const body: any = {};
        if (flags.get('base')) body.base = flags.get('base');
        await jsonPost(`/v1/images/${encodeURIComponent(name)}/rebuild`, body);
        console.log(`Rebuilding ${name}…\n`);
        await streamImageBuild(ctx, name);
        return;
      }

      if (sub === 'rm' || sub === 'delete') {
        const name = rest[1] ?? fail('usage: hatchabot image rm <name>');
        await api(ctx, `/v1/images/${encodeURIComponent(name)}`, { method: 'DELETE' });
        console.log(`Removed derived image "${name}".`);
        return;
      }

      if (sub === 'log') {
        const name = rest[1] ?? fail('usage: hatchabot image log <name>');
        const r: any = await (await api(ctx, `/v1/images/${encodeURIComponent(name)}/log`)).json();
        console.log(r.log || '(no build log yet)');
        return;
      }

      if (sub === 'pin') {
        const agentRef = rest[1] ?? fail('usage: hatchabot image pin <agent> <name-or-tag>');
        const image = rest[2] ?? fail('usage: hatchabot image pin <agent> <name-or-tag>');
        const a = await resolveAgent(ctx, agentRef);
        await jsonPost(`/v1/agents/${a.id}`, { image: toTag(image) }, 'PATCH');
        console.log(`"${a.name}" pinned to ${toTag(image)} — applies on: hatchabot rebuild "${a.name}"`);
        return;
      }

      if (sub === 'unpin') {
        const agentRef = rest[1] ?? fail('usage: hatchabot image unpin <agent>');
        const a = await resolveAgent(ctx, agentRef);
        const r: any = await (await jsonPost(`/v1/agents/${a.id}`, { image: null }, 'PATCH')).json();
        console.log(r.sameImage ? `"${a.name}" unpinned — it already runs the fleet default image, nothing to rebuild.` : `"${a.name}" returned to the fleet default image — applies on: hatchabot rebuild "${a.name}"`);
        return;
      }

      if (sub === 'tags') {
        const r = (await (await api(ctx, '/v1/runtime/images')).json()) as any;
        console.log(`fleet default: ${r.default}  (${r.unpinned.length} agents follow it)`);
        for (const t of r.tags) {
          const kind = t.derived ? `derived ${t.derived.status}` : t.isLatest ? 'same as default' : t.exists ? 'candidate' : 'NOT BUILT';
          const pins = t.pinned.map((a: any) => a.name).join(', ');
          console.log(`  ${t.tag}  [${kind}]${pins ? '  pinned: ' + pins : ''}${t.classes.length ? '  classes: ' + t.classes.map((c: any) => c.name).join(', ') : ''}`);
        }
        return;
      }
      if (sub === 'try') {
        const agentRef = rest[1] ?? fail('usage: hatchabot image try <agent> <tag>');
        const image = rest[2] ?? fail('usage: hatchabot image try <agent> <tag>');
        const a = await resolveAgent(ctx, agentRef);
        const r: any = await (await jsonPost(`/v1/agents/${a.id}`, { image: toTag(image) }, 'PATCH')).json();
        if (r.sameImage) { console.log(`"${a.name}" pinned to ${toTag(image)} — it already runs that image, nothing to rebuild.`); return; }
        await jsonPost(`/v1/agents/${a.id}/rebuild`, {}, 'POST');
        console.log(`"${a.name}" is rebuilding on ${toTag(image)} (memory kept). Undo: hatchabot image unpin "${a.name}" && hatchabot rebuild "${a.name}"`);
        return;
      }
      if (sub === 'promote') {
        const tag = rest[1] ?? fail('usage: hatchabot image promote <tag>');
        const r = (await (await jsonPost('/v1/runtime/images/promote', { tag: toTag(tag) }, 'POST')).json()) as any;
        console.log(`${r.promoted} is now ${r.now}. ${(r.followers ?? []).length} agent(s) without a pin will adopt it on rebuild — hatchabot list shows "update available"; rebuild them via Bulk actions or: hatchabot rebuild <agent>`);
        return;
      }
      fail(`unknown: hatchabot image ${sub}\n  try: list | tags | derive | rebuild | rm | log | pin | unpin | try | promote`);
    }
    case 'servers': {
      if (rest[0] === 'add') {
        const [, name, url] = rest;
        if (!name || !url) fail('usage: hatchabot servers add <name> <url>   (prompts for its token)');
        const token = rest[3] ?? await askSecret(`Token from ${url} (⚙ Settings → Security): `);
        if (!token) fail('no token given');
        const p: any = await (await jsonPost('/v1/peers', { name, url, token })).json();
        console.log(`added "${p.name}" (${p.url})`);
        return;
      }
      const peers: any[] = await (await api(ctx, '/v1/peers')).json() as any[];
      if (!peers.length) return console.log('no servers yet — hatchabot servers add <name> <url> <token>');
      for (const p of peers) console.log(`${p.id}  ${p.name.padEnd(20)} ${p.url}`);
      return;
    }
    case 'rehost':
    case 'migrate': { // 'migrate' kept as an alias for the old name
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot rehost <agent> <server>'));
      const ref = rest[1] ?? fail('give the destination server (see: hatchabot servers)');
      const peers: any[] = await (await api(ctx, '/v1/peers')).json() as any[];
      const peer = peers.find((p) => p.id === ref || p.name === ref);
      if (!peer) fail(`no server matches "${ref}"`);
      console.log(`rehosting "${a.name}" to ${peer.name}…`);
      // A pinned image is rebuilt there from its recipe; --drop-pin opts out.
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/rehost`, {
        peerId: peer.id, ...(flags.has('drop-pin') ? { allowDroppedPin: true } : {}),
      })).json();
      console.log(`done — now running on ${res.movedTo} as ${res.remoteAgentId}`);
      console.log(`"${a.name}" here is ${res.sourceState} and was NOT deleted.`);
      console.log(`Keep it that way: two copies polling one bot token fight over messages.`);
      return;
    }
    case 'invite': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot invite <agent>'));
      const inv: any = await (await jsonPost(`/v1/agents/${a.id}/invites`, {})).json();
      console.log(inv.url ?? `${ctx.url}${inv.path}  (set HATCHABOT_PUBLIC_URL for a shareable link)`);
      console.log(`single-use, expires ${inv.expiresAt}`);
      if (a.deepLink) console.log(`no-Tailscale path: send them ${a.deepLink} and run \`hatchabot pairing\` when they message it`);
      return;
    }
    case 'pairing': {
      const targets = rest[0]
        ? [await resolveAgent(ctx, rest[0])]
        : ((await agents(ctx)).filter((a) => a.state === 'RUNNING') as any[]);
      let any = false;
      for (const a of targets) {
        const reqs: any[] = await (await api(ctx, `/v1/agents/${a.id}/pairing`)).json() as any[];
        for (const r of reqs) {
          any = true;
          console.log(`${a.name}: ${r.meta?.firstName ?? r.meta?.username ?? r.id} wants to talk — approve with: hatchabot approve "${a.name}" ${r.code}`);
        }
      }
      if (!any) console.log('no pending requests');
      return;
    }
    case 'approve': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot approve <agent> <code>'));
      const code = rest[1] ?? fail('give the pairing code (see: hatchabot pairing)');
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/pairing/approve`, { code })).json();
      console.log(res.member?.alreadyMember
        ? `${res.member.displayName} is already a member — access restored`
        : `${res.member?.displayName ?? 'Guest'} is in — now a member`);
      return;
    }
    case 'deny': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot deny <agent> <code>'));
      const code = rest[1] ?? fail('give the pairing code (see: hatchabot pairing)');
      await jsonPost(`/v1/agents/${a.id}/pairing/deny`, { code });
      console.log('turned away — not a ban; they can ask again by messaging the bot');
      return;
    }
    case 'checkpoint': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot checkpoint <agent>'));
      await jsonPost(`/v1/agents/${a.id}/checkpoint`, {});
      console.log("checkpoint requested — the agent is writing the conversation's key facts to MEMORY.md (~20s)");
      return;
    }
    case 'env': {
      const usage = 'usage: hatchabot env <agent> [set <NAME> [<value>] | rm <NAME>]';
      const a = await resolveAgent(ctx, rest[0] ?? fail(usage));
      const sub = rest[1];
      const envOf = async () =>
        ((await (await api(ctx, `/v1/agents/${a.id}`)).json()) as any).envVars ?? [];
      if (!sub) {
        const vars = await envOf();
        if (!vars.length) return console.log('no env vars set');
        for (const e of vars) console.log(`${e.name.padEnd(32)} set ${e.createdAt?.slice(0, 10) ?? ''}`);
        return;
      }
      if (sub === 'set') {
        const name = rest[2] ?? fail(usage);
        // Value from argv, or stdin when omitted — argv lands in shell
        // history and `ps`, which is no place for a secret.
        let value = rest[3];
        if (value === undefined) {
          if (process.stdin.isTTY) console.error(`enter the value for ${name} (end with Ctrl-D):`);
          value = readFileSync(0, 'utf8').replace(/\n$/, '');
        }
        if (!value) fail('empty value');
        await jsonPost(`/v1/agents/${a.id}/env`, { name, value });
        console.log(`${name} set — applies on the next rebuild`);
        return;
      }
      if (sub === 'rm') {
        const name = rest[2] ?? fail(usage);
        const e = (await envOf()).find((v: any) => v.name === name) ?? fail(`no env var "${name}" (see: hatchabot env "${a.name}")`);
        await api(ctx, `/v1/agents/${a.id}/env/${e.id}`, { method: 'DELETE' });
        console.log(`${name} removed — applies on the next rebuild`);
        return;
      }
      return fail(usage);
    }
    case 'members': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot members <agent>'));
      const ms: any[] = await (await api(ctx, `/v1/agents/${a.id}/members`)).json() as any[];
      for (const m of ms) {
        console.log(`${(m.displayName ?? m.userId).padEnd(24)} ${m.role.padEnd(6)} ${m.channelUserId ? 'linked' : 'not linked'}  ${m.userId}`);
      }
      return;
    }
    case 'kick': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot kick <agent> <userId>'));
      const userId = rest[1] ?? fail('give the member userId (see: hatchabot members)');
      await api(ctx, `/v1/agents/${a.id}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      console.log('member revoked');
      return;
    }
    case 'bots': {
      // Consolidated across registered servers, so you see every slot in one
      // place. --check adds a live Telegram getMe/poll probe per bot.
      const live = flags.has('check');
      const { hosts } = (await (
        await api(ctx, `/v1/bots?consolidated=1&live=${live ? 1 : 0}`)
      ).json()) as { hosts: any[] };
      for (const line of fmtBots(hosts, live)) console.log(line);
      return;
    }
    case 'migrate-source': {
      // Host-owner admin: the CLI twin of "↪ Migrate all off…" in the app. Shows
      // exactly which agents (and whose) will move before doing anything.
      const fromArg = rest[0] ?? fail('usage: hatchabot migrate-source <from> --to <target> [--no-checkpoint] [--recover] [--yes]');
      const toArg = flags.get('to') ?? fail('--to <target source> is required');
      const profiles = (await (await api(ctx, '/v1/ai-profiles')).json()) as any[];
      const pick = (q: string, what: string) => {
        const m = profiles.filter((p) => p.id === q || p.name.toLowerCase() === q.toLowerCase());
        if (m.length === 1) return m[0];
        fail(m.length ? `"${q}" matches several ${what} sources — use the id (hatchabot sources)` : `no AI source named "${q}" (hatchabot sources lists them)`);
      };
      const from = pick(fromArg, 'from'); const to = pick(toArg, 'target');
      if (from.id === to.id) fail('from and target are the same source');
      if (!to.shared) fail(`"${to.name}" is not shared — other accounts' agents can only move to a shared source. Share it in the app first, or pick one of: ${profiles.filter((p) => p.shared && p.id !== from.id).map((p) => p.name).join(', ') || '(none shared)'}`);
      const agents = ((await (await api(ctx, '/v1/agents?all=1')).json()) as any[]).filter((a) => a.aiProfileId === from.id);
      if (!agents.length) return console.log(`no agents on "${from.name}" — nothing to move (delete it in the app if you're done with it)`);
      const w = Math.max(...agents.map((a) => a.name.length));
      console.log(`Agents on "${from.name}" → "${to.name}":`);
      for (const a of agents) console.log(`  ${a.name.padEnd(w)}  ${String(a.state).padEnd(10)} owner ${a.ownerId ?? '-'}`);
      const others = new Set(agents.map((a) => a.ownerId)).size;
      console.log(`${agents.length} agent(s) across ${others} account(s); each is rebuilt on the new source (memory kept, chat restarts)${flags.has('no-checkpoint') ? ', WITHOUT saving chats to memory first' : ', after Chat → Memory'}.`);
      if (!flags.has('yes')) {
        const { createInterface } = await import('node:readline');
        const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
        process.stderr.write('Proceed? [y/N] ');
        const ans = await new Promise<string>((r) => rl.once('line', (l) => { rl.close(); r(l.trim().toLowerCase()); }));
        if (ans !== 'y' && ans !== 'yes') return console.log('aborted');
      }
      const res = await api(ctx, `/v1/ai-profiles/${from.id}/migrate-agents`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toProfileId: to.id, rebuild: true, checkpoint: !flags.has('no-checkpoint'), recoverAfter: flags.has('recover') }),
      });
      const r = (await res.json()) as any;
      console.log(`moved ${r.switched} of ${r.agents}; rebuilding ${r.rebuilding} (3 at a time)${(r.skipped ?? []).length ? '; skipped: ' + r.skipped.map((s: any) => s.name).join(', ') : ''}`);
      console.log(`watch: hatchabot list --all   ·  then delete "${from.name}" in the app once none remain on it`);
      return;
    }
    case 'users': {
      // Who talks to your agents, and when they were last heard from. --all
      // (host owner) widens to every account's agents.
      const all = flags.has('all');
      const res = await api(ctx, `/v1/users${all ? '?all=1' : ''}`);
      const { users } = (await res.json()) as {
        users: Array<{
          channelUserId?: string;
          displayName?: string;
          memberships: Array<{ agentName: string; agentState: string; role: string; joinedAt?: string }>;
          lastSeen?: { at: string; agentName: string; thread: string };
        }>;
      };
      if (!users.length) return console.log('no members on any agent');
      console.log(`${users.length} Telegram user(s) across your agents\n`);
      for (const u of users) {
        const id = u.channelUserId ? `telegram:${u.channelUserId}` : '(not linked — invited, never messaged)';
        const who = u.displayName ? `${u.displayName}  ${id}` : id;
        const seen = u.lastSeen
          ? `last exchange ${ago(u.lastSeen.at)} (${u.lastSeen.agentName}${u.lastSeen.thread === 'group' ? ', group chat' : ''})`
          : 'no activity recorded';
        console.log(`${who}`);
        console.log(`  ${seen}`);
        for (const m of u.memberships.sort((a2, b2) => a2.agentName.localeCompare(b2.agentName))) {
          const joined = m.joinedAt ? `, joined ${m.joinedAt.slice(0, 10)}` : '';
          const state = m.agentState === 'RUNNING' ? '' : ` [${m.agentState.toLowerCase()}]`;
          console.log(`  - ${m.agentName}${state} (${m.role}${joined})`);
        }
        console.log('');
      }
      console.log('note: "last exchange" is per agent thread — in a shared thread only the most recent speaker is recorded, so an earlier speaker shows their older reading.');
      return;
    }
    case 'list': {
      // --all (host owner): every user's agents, with the owner id — the
      // admin view for finding another login's leftovers.
      const all = flags.has('all');
      const res = await api(ctx, `/v1/agents${all ? '?all=1' : ''}`);
      const list = (await res.json()) as any[];
      if (flags.has('json')) return console.log(JSON.stringify(list.map((a) => ({
        id: a.id, name: a.name, slug: a.slug, state: a.state, model: a.model ?? null,
        webOnly: !!a.webOnly, lastActiveAt: a.lastActiveAt ?? null, ...(all ? { ownerId: a.ownerId } : {}),
      })), null, 2));
      if (!list.length) return console.log('no agents');
      const w = Math.max(...list.map((a) => a.name.length));
      for (const a of list) {
        const owner = all ? `  ${String(a.ownerId ?? '-').padEnd(34)}` : '';
        console.log(
          `${a.name.padEnd(w)}  ${String(a.state).padEnd(12)} ${(a.model ?? '-').padEnd(20)}${owner} active ${ago(a.lastActiveAt)}`,
        );
      }
      return;
    }
    case 'download':
    case 'backup': { // 'backup' kept as an alias
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot download <agent> [-o file]'));
      const res = await api(ctx, `/v1/agents/${a.id}/backup`);
      const out = userPath(flags.get('out') ?? `${a.slug}.hatchabot`);
      // 0600: this archive embeds the live bot token, so it must not be
      // readable by other accounts on the machine (the note below says as much).
      await writeFile(out, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
      // `mode` only applies when the file is CREATED: writing over an existing,
      // world-readable file kept its old mode. Set it explicitly (CLI audit).
      await chmod(out, 0o600);
      console.log(`backed up to ${out}`);
      console.log('note: the file is a complete private copy — it contains the bot token, treat it like a password.');
      console.log(`note: "${a.name}" is now STOPPED here; keep it stopped once restored elsewhere.`);
      return;
    }
    case 'restore': {
      const file = rest[0] ?? fail('usage: hatchabot restore <file> [--profile <aiProfileId>]');
      const data = await readFile(userPath(file));
      const params = new URLSearchParams();
      if (flags.has('profile')) params.set('aiProfileId', flags.get('profile')!);
      if (flags.has('host')) params.set('hostId', flags.get('host')!);
      const agent = await uploadAgentFile(ctx, '/v1/agents/restore', params, data, flags, askLine);
      console.log(`restored "${agent.name}" (${agent.state})`);
      return;
    }
    case 'share':
    case 'export': { // template — a trained copy for someone else. ('export' alias)
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot share <agent> [-o file]'));
      // MEMORY.md is what the agent was TOLD — often personal. The export route
      // includes it unless asked not to, so a bare call shipped memory while the
      // line below promised it hadn't. Default to excluding it; opt in loudly.
      const withMemory = flags.has('include-memory');
      const res = await api(ctx, `/v1/agents/${a.id}/export${withMemory ? '' : '?excludeMemory=1'}`);
      const out = userPath(flags.get('out') ?? `${a.slug}.template.hatchabot`);
      await writeFile(out, Buffer.from(await res.arrayBuffer()), { mode: 0o600 });
      // `mode` only applies when the file is CREATED: writing over an existing,
      // world-readable file kept its old mode. Set it explicitly (CLI audit).
      await chmod(out, 0o600);
      console.log(`exported template to ${out}`);
      console.log(withMemory
        ? 'a trained copy INCLUDING MEMORY.md — it may hold personal facts the agent was told. Share only with someone you trust.'
        : 'a shareable copy — no bot token, members, or memory. Safe to send to someone.');
      return;
    }
    case 'import': { // template
      const file = rest[0] ?? fail('usage: hatchabot import <file> [--name <name>] [--profile <aiProfileId>] [--values <json>]');
      const data = await readFile(userPath(file));
      const params = new URLSearchParams();
      if (flags.has('name')) params.set('name', flags.get('name')!);
      if (flags.has('profile')) params.set('aiProfileId', flags.get('profile')!);
      if (flags.has('host')) params.set('hostId', flags.get('host')!);
      // Setup fields (sharing Phase 2a): the template may declare {{key}}
      // fields the importer fills. Peek the file LOCALLY (it's right here) and
      // prompt for each; --values '{"key":"v"}' skips prompting for scripts.
      let values: Record<string, string> | undefined;
      if (flags.has('values')) {
        values = JSON.parse(flags.get('values')!);
      } else {
        try {
          const { gunzipSync } = await import('node:zlib');
          const manifest = JSON.parse(gunzipSync(data, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'));
          const fields: any[] = Array.isArray(manifest?.parameters) ? manifest.parameters : [];
          if (fields.length && process.stdin.isTTY) {
            console.log('This template has setup fields:');
            values = {};
            for (const p of fields) {
              const hints = [
                p.options?.length ? `one of: ${p.options.join(', ')}` : '',
                p.default !== undefined ? `default: ${p.default}` : '',
                p.required ? 'required' : 'optional — Enter to skip',
              ].filter(Boolean).join('; ');
              if (p.help) console.log(`  ${p.help}`);
              const v = await askLine(`  ${p.label}${hints ? ` (${hints})` : ''}: `);
              if (v) values[p.key] = v;
            }
          }
          // Non-TTY with required fields: let the server's validation name them.
        } catch { /* not gunzippable here (full backup?) — server sorts it out */ }
      }
      if (values && Object.keys(values).length) params.set('values', JSON.stringify(values));
      const j = await uploadAgentFile(ctx, '/v1/agents/import', params, data, flags, askLine);
      if (j.kind === 'agent') {
        console.log(`restored "${j.name}" (${j.state})`);
        return;
      }
      console.log(`imported "${j.name}" (${j.state}) — connect its Telegram bot to finish.`);
      const ds = (j.needs?.dataSources ?? []).map((d: any) => `${d.kind} ${d.mountName}`);
      const env = j.needs?.envVars ?? [];
      if (ds.length || env.length) {
        console.log('it still needs setting up:');
        for (const d of ds) console.log(`  data: ${d}`);
        for (const e of env) console.log(`  env:  ${e}`);
      }
      return;
    }
    case 'clone': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot clone <agent> [new name]'));
      const name = rest.slice(1).join(' ').trim() || `${a.name} (copy)`;
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/clone`, { name })).json();
      console.log(`cloned "${a.name}" → "${res.name}" (${res.state}) — connect its Telegram bot to finish.`);
      return;
    }
    case 'archive': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot archive <agent> [--yes]'));
      if (!flags.has('yes')) {
        const ok = await askLine(
          `Archive "${a.name}"? It keeps its memory and members, stops, and hands its\n` +
            `Telegram bot back for another agent. Members are told in the chat, and on\n` +
            `restore it gets a DIFFERENT bot — its current link stops working. [y/N] `,
        );
        if (!/^y(es)?$/i.test(ok.trim())) fail('nothing archived');
      }
      await jsonPost(`/v1/agents/${a.id}/archive`, {});
      console.log(`"${a.name}" archived — its bot is back in the pool.`);
      return;
    }
    // NOT `restore` — that verb already means "restore from a downloaded
    // .hatchabot file" and has since before archiving existed. The web app can
    // call its button Restore because context makes it unambiguous; a CLI verb
    // cannot. `unarchive` pairs with `archive` and leaves the older command's
    // meaning (and anyone's scripts) alone.
    case 'unarchive': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot unarchive <agent>'));
      await jsonPost(`/v1/agents/${a.id}/restore`, {});
      console.log(
        `restoring "${a.name}" — watch with: hatchabot list\n` +
          `It comes back on a NEW bot; send members the new link (hatchabot invite).`,
      );
      return;
    }
    case 'start':
    case 'stop':
    case 'rebuild': {
      if (cmd === 'rebuild' && flags.has('outdated')) {
        // Every agent the app says needs one — the Rebuild button, in bulk,
        // through the server's own queue (a few at a time).
        const outdated = (await agents(ctx)).filter((x) => x.rebuild && (!flags.has('required') || x.rebuild.level === 'required'));
        // A rebuild STARTS an agent; a stopped one gets its rebuild when it is next started.
        const all = outdated.filter((x) => x.state === 'RUNNING');
        const parked = outdated.length - all.length;
        if (parked) console.log(`(${parked} stopped agent${parked > 1 ? 's' : ''} left alone — rebuilt when started)`);
        if (!all.length) { console.log(`No running agent needs a${flags.has('required') ? ' required' : ''} rebuild.`); return; }
        for (const x of all) {
          console.log(`${x.rebuild.level === 'required' ? '!' : '-'} ${x.name}: ${x.rebuild.reasons.join('; ')}`);
          if (flags.has('dry-run')) continue;
          await api(ctx, `/v1/agents/${x.id}/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
            .catch((e: Error) => console.log(`  not started: ${e.message}`));
        }
        console.log(flags.has('dry-run') ? `${all.length} would be rebuilt.` : `${all.length} rebuild(s) queued; they run a few at a time.`);
        return;
      }
      const a = await resolveAgent(ctx, rest[0] ?? fail(`usage: hatchabot ${cmd} <agent>`));
      await api(ctx, `/v1/agents/${a.id}/${cmd}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (!flags.has('wait')) {
        console.log(`${cmd} requested for "${a.name}"${cmd === 'stop' ? '' : ' — add --wait to wait until it is running'}`);
        return;
      }
      // --wait: scripts need "stopped" / "running", not "requested" (CLI audit).
      const want = cmd === 'stop' ? 'STOPPED' : 'RUNNING';
      const limit = minutesFlag(15);
      const deadline = Date.now() + limit * 60_000;
      await new Promise((r) => setTimeout(r, 2000));
      for (;;) {
        const now = (await (await api(ctx, `/v1/agents/${a.id}`)).json()) as any;
        if (now.state === want) { console.log(`"${a.name}" is ${want}.`); return; }
        if (now.state === 'FAILED') fail(`"${a.name}" failed: ${now.stateReason ?? 'unknown'}`);
        if (Date.now() > deadline) fail(`"${a.name}" is still ${now.state} after ${limit} min`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    case 'top': {
      const r: any = await (await api(ctx, '/v1/resources')).json();
      const mb = (b: number) => `${Math.round(b / 1048576)}M`;
      for (const h of r.hosts) {
        console.log(`\n${h.name}${h.error ? `  (${h.error})` : `  ·  ${h.totals.cpuPct}% CPU  ·  ${mb(h.totals.memBytes)} in ${h.containers.length} container(s)`}`);
        const by = flags.get('sort') ?? 'mem';
        const who0 = (c: any) => c.agentName ?? c.role ?? c.name;
        const rows = [...h.containers].sort((a: any, b: any) =>
          by === 'name' ? who0(a).localeCompare(who0(b)) : by === 'cpu' ? b.cpuPct - a.cpuPct : b.memBytes - a.memBytes);
        for (const c of rows) {
          const who = c.agentName ?? ({ embedder: 'memory search service', 'embed-door': 'memory search door', doorman: 'doorman' } as any)[c.role] ?? c.name;
          const peak = c.memPeakBytes ? `  peak ${mb(c.memPeakBytes)}` : '';
          const cap = c.memCapHits ? `  hit cap ${c.memCapHits}×${c.memOomKills ? ` (killed ${c.memOomKills}×)` : ''}` : '';
          console.log(`  ${String(c.cpuPct.toFixed(1)).padStart(6)}%  ${mb(c.memBytes).padStart(7)} / ${mb(c.memLimitBytes).padEnd(6)}  ${who}${peak}${cap}`);
        }
        if (h.containers.some((c: any) => c.memCapHits)) console.log('  ⚠ containers that hit their memory cap need a bigger one (HATCHABOT_AGENT_MEMORY, then Rebuild) or their heavy work moved out.');
      }
      return;
    }
    case 'telegram': {
      const sub = rest[0];
      if (sub !== 'remove') fail('usage: hatchabot telegram remove <agent> [--yes]');
      const a = await resolveAgent(ctx, rest[1] ?? fail('usage: hatchabot telegram remove <agent> [--yes]'));
      if (!a.botUsername) fail(`"${a.name}" has no Telegram bot.`);
      if (!flags.has('yes')) {
        const typed = await askLine(`Take @${a.botUsername} off "${a.name}"?\nIt keeps everything it knows and becomes web-only; people who reach it on Telegram lose access and get a goodbye. The bot goes back to your pool.\nType y to confirm: `);
        if (!/^y(es)?$/i.test(typed.trim())) fail('not confirmed — nothing changed');
      }
      const r: any = await (await api(ctx, `/v1/agents/${a.id}/telegram`, { method: 'DELETE' })).json();
      console.log(`@${r.released ?? a.botUsername} is back in your pool. "${a.name}" is rebuilding as a web-only agent — talk to it in the app; a bot can be attached again later.`);
      return;
    }
    case 'skip-telegram': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot skip-telegram <agent>'));
      await jsonPost(`/v1/agents/${a.id}/channel-token`, { webOnly: true });
      console.log(`"${a.name}" is finishing without Telegram — talk to it in the web app; a bot can be attached later.`);
      return;
    }
    case 'embedder': {
      const sub = rest[0] ?? 'status';
      if (sub === 'use') {
        const a = await resolveAgent(ctx, rest[1] ?? fail('usage: hatchabot embedder use <agent> shared|baked'));
        const mode = rest[2];
        if (mode !== 'shared' && mode !== 'baked') fail('usage: hatchabot embedder use <agent> shared|baked');
        await api(ctx, `/v1/agents/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ embedMode: mode }) });
        console.log(`"${a.name}" will use the ${mode === 'shared' ? 'shared memory search service' : "image's own engine"} from its next rebuild: hatchabot rebuild ${JSON.stringify(a.name)}`);
        return;
      }
      if (sub === 'default') {
        const r: any = rest[1]
          ? await (await api(ctx, '/v1/embed-default', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ default: rest[1] }) })).json()
          : await (await api(ctx, '/v1/embed-default')).json();
        console.log(`new agents use: ${r.default === 'shared' ? 'the shared service' : "the image's own engine"} · ${r.shared} of ${r.total} agents on the shared service${r.pending ? ` · ${r.pending} waiting for a rebuild` : ''}`);
        return;
      }
      if (sub === 'move-all') {
        const mode = rest[1];
        if (mode !== 'shared' && mode !== 'baked') fail('usage: hatchabot embedder move-all shared|baked [--now]');
        const r: any = await (await jsonPost('/v1/embed/move-all', { mode, when: flags.has('now') ? 'now' : 'quiet' })).json();
        console.log(`${r.switched} agent(s) switched; ${r.queued} rebuilding now, ${r.deferred} in the quiet hours. ${r.shared} of ${r.total} on the shared service.`);
        return;
      }
      if (!['status', 'start', 'stop', 'restart'].includes(sub)) fail('usage: hatchabot embedder [status|start|stop|restart|use <agent> shared|baked|default [shared|baked]|move-all shared|baked [--now]]');
      const r: any = sub === 'status'
        ? await (await api(ctx, '/v1/embedder')).json()
        : await (await api(ctx, `/v1/embedder/${sub}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
      if (r.external) console.log(`embedding: an external server is used — ${r.external}`);
      console.log(`embedding service: ${r.enabled ? 'on' : 'off'} · engine ${r.embedder} · door ${r.door}${r.doorAddress ? ` at ${r.doorAddress}` : ''} · model ${r.modelPresent ? 'present' : 'not fetched yet'}`);
      return;
    }
    case 'rebuild-policy': {
      if (flags.has('at-once')) {
        const res = await api(ctx, '/v1/rebuild-concurrency', {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ atOnce: Number(flags.get('at-once')) }),
        });
        const r: any = await res.json();
        if (!res.ok) fail(r.error ?? 'could not set it');
        console.log(`rebuilds at once: ${r.atOnce}`);
        if (!rest[0]) return;
      }
      if (rest[0]) {
        const res = await api(ctx, '/v1/rebuild-policy', {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy: rest[0] }),
        });
        console.log(`rebuild policy: ${((await res.json()) as any).policy}`);
        return;
      }
      const r: any = await (await api(ctx, '/v1/rebuild-policy')).json();
      console.log(`rebuild policy: ${r.policy}  (choices: ${r.policies.join(', ')}; quiet hours ${r.quietHours})`);
      const c: any = await (await api(ctx, '/v1/rebuild-concurrency')).json().catch(() => null);
      if (c) console.log(`rebuilds at once: ${c.atOnce} (1–${c.max}; --at-once N to change)${c.queued ? ` · ${c.queued} waiting` : ''}${c.running ? ` · ${c.running} running` : ''}`);
      return;
    }
    case 'snapshot': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot snapshot <agent> [--label text]'));
      const s: any = await (await jsonPost(`/v1/agents/${a.id}/snapshots`, { label: flags.get('label') })).json();
      console.log(`saved "${s.label}" (${s.files.join(', ')})`);
      console.log(s.id);
      return;
    }
    case 'snapshots': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot snapshots <agent>'));
      const list: any[] = await (await api(ctx, `/v1/agents/${a.id}/snapshots`)).json() as any[];
      if (!list.length) return console.log('no snapshots yet');
      for (const s of list) {
        console.log(`${s.id}  ${ago(s.createdAt).padEnd(10)} ${s.reason.padEnd(12)} ${s.label}`);
      }
      return;
    }
    case 'revert': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot revert <agent> <snapshotId>'));
      const snapId = rest[1] ?? fail('give the snapshot id (see: hatchabot snapshots)');
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/snapshots/${snapId}/restore`, {})).json();
      console.log(`reverted ${res.restored.join(', ')}`);
      if (res.safetySnapshotId) console.log(`undo with: hatchabot revert "${a.name}" ${res.safetySnapshotId}`);
      console.log('applies to new conversations — send /new in Telegram');
      return;
    }
    case 'token': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot token <agent>'));
      const t = (await (await api(ctx, `/v1/agents/${a.id}/bot-token`)).json()) as any;
      console.log(`bot: @${t.accountId}${t.pooled ? ' (pool — recycles automatically)' : ''}`);
      console.log(t.botToken);
      return;
    }
    case 'logs': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot logs <agent> [-n lines]'));
      const lines = flags.get('lines') ?? '80';
      if (!/^\d{1,5}$/.test(lines)) fail('-n takes a number of lines');
      const { text } = (await (await api(ctx, `/v1/agents/${a.id}/logs?lines=${lines}`)).json()) as any;
      console.log(text || '(no recent output)');
      return;
    }
    case 'events':
    case 'setup-log': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot events <agent> [-n count]'));
      const n = flags.get('lines') ?? '40';
      if (!/^\d{1,3}$/.test(n)) fail('-n takes a number');
      const r: any = await (await api(ctx, `/v1/agents/${a.id}/events?limit=${n}`)).json();
      if (flags.has('json')) { console.log(JSON.stringify(r)); return; }
      console.log(`${r.agent} (${r.state}) — setup log, newest first`);
      for (const e of r.events) console.log(`  ${e.at.slice(0, 19).replace('T', ' ')}  ${e.label}${e.note ? ` — ${String(e.note).slice(0, 160)}` : ''}`);
      if (!r.events.length) console.log('  (nothing recorded yet)');
      return;
    }
    case 'memory': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot memory <agent> [<cap>|default]'));
      if (rest[1]) {
        const cap = rest[1] === 'default' ? null : rest[1];
        const res = await api(ctx, `/v1/agents/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memoryCap: cap }) });
        const r: any = await res.json();
        console.log(`${a.name}: memory cap ${cap ? `set to ${cap}` : 'back to the default'} → its container runs with ${r.memoryCapEffective ?? cap ?? 'the default'}${r.state === 'RUNNING' ? ' (applied live)' : ''}`);
        return;
      }
      const list = await agents(ctx);
      const cur: any = list.find((x: any) => x.id === a.id) ?? a;
      const mb = (b: number) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
      console.log(`${cur.name}: ${cur.memoryCap ? `own cap ${cur.memoryCap}` : 'no cap of its own (class or fleet default)'} · container runs with ${cur.memoryCapEffective ?? '?'}`
        + (cur.memoryPeakBytes ? ` · peak ${mb(cur.memoryPeakBytes)}` : '')
        + (cur.memoryCapHits ? ` · hit its cap ${cur.memoryCapHits}×` : '')
        + (cur.memoryKills ? ` · ${cur.memoryKills} process${cur.memoryKills === 1 ? '' : 'es'} killed for memory` : ''));
      return;
    }
    case 'console': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot console <agent> [--check]'));
      const prefix = `/v1/agents/${a.id}/ui`;
      console.log(`${ctx.url}${prefix}/`);
      if (!flags.has('check')) return;
      // What a browser does: load the document, then the module script it
      // names — through the proxy, on the same path the browser would use.
      // 2026.9 writes root-absolute links that only work once the proxy has
      // moved them under its prefix; a 401/404 here is the "Control UI did
      // not start" page.
      const doc = await api(ctx, `${prefix}/`);
      const html = await doc.text();
      if (!/text\/html/i.test(doc.headers.get('content-type') ?? '')) fail(`the console answered with ${doc.headers.get('content-type') ?? 'no content type'}, not a page`);
      const script = /<script[^>]*\ssrc="([^"]+)"/i.exec(html)?.[1];
      if (!script) fail('the console page names no app script');
      const scriptPath = script.startsWith('/') ? script : `${prefix}/${script.replace(/^\.\//, '')}`;
      const problems: string[] = [];
      if (!scriptPath.startsWith(`${prefix}/`)) problems.push(`app script points outside the console: ${script}`);
      const base = /data-openclaw-control-ui-base-path="([^"]*)"/.exec(html)?.[1];
      if (base !== undefined && base !== prefix) problems.push(`base path is "${base}", expected ${prefix}`);
      const js = await fetch(`${ctx.url}${scriptPath}`, { headers: ctx.bearer ? { authorization: `Bearer ${ctx.bearer}` } : { cookie: ctx.cookie } });
      if (!js.ok) problems.push(`app script ${scriptPath} → HTTP ${js.status}`);
      else if (!/javascript/i.test(js.headers.get('content-type') ?? '')) problems.push(`app script served as ${js.headers.get('content-type')}`);
      // The gateway answers its config with 401 until the browser presents
      // the agent's token (carried in the URL fragment, which we do not have
      // here): 401 means the request reached the gateway; 404 means it did not.
      const cfg = await fetch(`${ctx.url}${prefix}/control-ui-config.json`, { headers: ctx.bearer ? { authorization: `Bearer ${ctx.bearer}` } : { cookie: ctx.cookie } });
      if (!cfg.ok && cfg.status !== 401) problems.push(`control-ui-config.json → HTTP ${cfg.status}`);
      if (problems.length) fail(`the console would not start in a browser:\n  ${problems.join('\n  ')}`);
      console.log(`ok: page, app script (${scriptPath.slice(prefix.length)}) and config all load through the proxy`);
      return;
    }
    case 'files':
    case 'ls': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot files <agent> [path]'));
      const path = rest.slice(1).join(' ');
      const r: any = await (await api(ctx, `/v1/agents/${a.id}/fs?path=${encodeURIComponent(path)}`)).json();
      const entries: any[] = r.entries ?? [];
      if (flags.has('json')) { console.log(JSON.stringify(r)); return; }
      console.log(`${a.name}: ~/${r.path || ''}  (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);
      const size = (n: number) => { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${i ? v.toFixed(1) : v} ${u[i]}`; };
      for (const e of entries) {
        const when = e.mtime ? e.mtime.slice(0, 16).replace('T', ' ') : '';
        console.log(`  ${e.type === 'dir' ? 'd' : e.type === 'link' ? 'l' : '-'}  ${(e.type === 'dir' ? '' : size(e.size)).padStart(9)}  ${when}  ${e.name}${e.type === 'dir' ? '/' : ''}`);
      }
      return;
    }
    case 'get': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot get <agent> <path> [-o file]'));
      const path = rest.slice(1).join(' ').trim() || fail('give the path inside the agent (see: hatchabot files <agent>)');
      // A folder comes as .tar.gz; a file as itself. Ask which it is first.
      const parent = path.split('/').filter(Boolean).slice(0, -1).join('/');
      const leaf = path.split('/').filter(Boolean).pop() ?? '';
      const listing: any = await (await api(ctx, `/v1/agents/${a.id}/fs?path=${encodeURIComponent(parent)}`)).json();
      const entry = (listing.entries ?? []).find((e: any) => e.name === leaf);
      const isDir = entry?.type === 'dir';
      const res = await api(ctx, `/v1/agents/${a.id}/fs/${isDir ? 'archive' : 'file'}?path=${encodeURIComponent(path)}`);
      const out = userPath(flags.get('out') ?? (leaf + (isDir ? '.tar.gz' : '')));
      const { createWriteStream } = await import('node:fs');
      const { pipeline } = await import('node:stream/promises');
      const { Readable } = await import('node:stream');
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(out, { mode: 0o600 }));
      console.log(`saved ${out}${isDir ? ' (folder as .tar.gz)' : ''}`);
      return;
    }
    case 'put': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot put <agent> <file> [dir] [--overwrite]'));
      const file = rest[1] ?? fail('give the file to upload');
      const dir = rest[2] ?? `.openclaw/agents/${a.slug}/agent`;
      const data = await readFile(userPath(file));
      const { basename: base } = await import('node:path');
      const name = base(file);
      const res = await api(ctx, `/v1/agents/${a.id}/fs/file?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}${flags.has('overwrite') ? '&overwrite=1' : ''}`,
        { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: data });
      const r: any = await res.json();
      if (!res.ok) fail(r.error ?? `upload failed (${res.status})`);
      console.log(`put ${name} (${r.size} bytes) into ~/${r.path || ''} of "${a.name}"`);
      return;
    }
    case 'ask': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: hatchabot ask <agent> <message>   (or pipe the message in)'));
      let text = rest.slice(1).join(' ').trim();
      if (!text || text === '-') {
        if (process.stdin.isTTY) console.error('type the message (end with Ctrl-D):');
        text = readFileSync(0, 'utf8').trim();
      }
      if (!text) fail('nothing to say');
      const r: any = await (await jsonPost(`/v1/agents/${a.id}/ask`, { text })).json();
      if (flags.has('json')) console.log(JSON.stringify({ agent: a.name, reply: r.reply }));
      else console.log(r.reply);
      return;
    }
    case 'tasks':
    case 'task': {
      const usage = 'usage: hatchabot tasks <agent> [add <name> (--every 30m | --cron "<expr>") [--message <text>] | run <task> [--wait] | runs <task> | pause <task> | resume <task> | rm <task>]';
      const a = await resolveAgent(ctx, rest[0] ?? fail(usage));
      const sub = rest[1];
      const base = `/v1/agents/${a.id}/crons`;
      const listTasks = async (): Promise<any[]> => ((await (await api(ctx, base)).json()) as any).crons ?? [];
      const pick = async (ref?: string): Promise<any> => {
        const { hit, problem } = matchTask(await listTasks(), ref ?? fail(usage));
        return hit ?? fail(problem!);
      };
      const runsOf = async (id: string, n: number): Promise<any[]> =>
        ((await (await api(ctx, `${base}/${encodeURIComponent(id)}/runs?limit=${n}`)).json()) as any).runs ?? [];
      const whenAgo = (ms?: number) => (ms ? ago(new Date(ms).toISOString()) : '-');
      const whenIn = (ms?: number) => {
        if (!ms) return '-';
        const m = Math.round((ms - Date.now()) / 60_000);
        return m <= 0 ? 'due now' : m < 90 ? `in ${m}m` : m < 2880 ? `in ${Math.round(m / 60)}h` : `in ${Math.round(m / 1440)}d`;
      };
      const schedule = (t: any) =>
        t.scheduleKind === 'every' && t.everyMs ? `every ${t.everyMs % 3_600_000 === 0 ? `${t.everyMs / 3_600_000}h` : t.everyMs % 60_000 === 0 ? `${t.everyMs / 60_000}m` : `${Math.round(t.everyMs / 1000)}s`}`
        : t.scheduleKind === 'cron' ? `${t.scheduleExpr}${t.scheduleTz ? ` ${t.scheduleTz}` : ''}`
        : t.scheduleKind === 'at' && t.atMs ? `once ${new Date(t.atMs).toISOString().slice(0, 16).replace('T', ' ')}`
        : String(t.scheduleKind ?? '?');
      const printRun = (r: any) => {
        console.log(`${new Date(r.runAtMs).toISOString().slice(0, 19).replace('T', ' ')}  ${r.status}${r.durationMs ? ` in ${Math.round(r.durationMs / 1000)}s` : ''}${r.delivered === false ? ' (not delivered)' : ''}`);
        if (r.error) console.log(`  error: ${r.error}`);
        if (r.summary) console.log(r.summary.split('\n').map((l: string) => `  ${l}`).join('\n'));
      };

      if (!sub) {
        const list = await listTasks();
        if (flags.has('json')) return console.log(JSON.stringify(list, null, 2));
        if (!list.length) return console.log(`"${a.name}" has no scheduled tasks. Add one: hatchabot tasks "${a.name}" add <name> --every 1h --message "…"`);
        const w = Math.max(4, ...list.map((t) => (t.name ?? '').length));
        for (const t of list) {
          console.log(`${t.id.slice(0, 8)}  ${(t.name ?? '').padEnd(w)}  ${schedule(t).padEnd(26)} ${t.enabled ? 'on ' : 'off'}  last: ${t.lastStatus ?? 'never'} ${t.lastRunAtMs ? whenAgo(t.lastRunAtMs) : ''}${t.consecutiveErrors ? ` (${t.consecutiveErrors} failing)` : ''}  next: ${t.enabled ? whenIn(t.nextRunAtMs) : 'paused'}`);
        }
        return;
      }
      if (sub === 'add') {
        const name = rest.slice(2).join(' ').trim() || fail(usage);
        const every = flags.get('every');
        const cron = flags.get('cron');
        if (!!every === !!cron) fail('give exactly one of --every <90s|30m|2h|1d> or --cron "<expr>"');
        const everyMinutes = every !== undefined
          ? durationMinutes(every) ?? fail(`--every "${every}" is not a duration like 90s, 30m, 2h or 1d`)
          : undefined;
        let message = flags.get('message');
        if (!message) {
          if (process.stdin.isTTY) console.error('what should it do each time? (end with Ctrl-D):');
          message = readFileSync(0, 'utf8').trim();
        }
        if (!message) fail('the task needs a message: what the agent is told each time it runs');
        const r: any = await (await jsonPost(base, {
          name, message, cron, everyMinutes, tz: flags.get('tz'), announce: !flags.has('quiet'),
        })).json();
        if (flags.has('json')) return console.log(JSON.stringify(r));
        console.log(`task "${name}" added${r.id ? ` (${String(r.id).slice(0, 8)})` : ''} — ${flags.has('quiet') ? 'runs without posting to its chat' : 'each result is posted to its chat'}.`);
        return;
      }
      if (sub === 'run') {
        const t = await pick(rest[2]);
        const before = Math.max(t.lastRunAtMs ?? 0, ...(await runsOf(t.id, 1)).map((r) => r.runAtMs));
        await jsonPost(`${base}/${encodeURIComponent(t.id)}/run`, {});
        if (!flags.has('wait')) return console.log(`"${t.name}" is running. How it went: hatchabot tasks "${a.name}" runs ${t.id.slice(0, 8)}`);
        const limit = minutesFlag(10);
        const deadline = Date.now() + limit * 60_000;
        for (;;) {
          const [latest] = await runsOf(t.id, 1);
          if (latest && latest.runAtMs > before) {
            if (flags.has('json')) console.log(JSON.stringify(latest));
            else printRun(latest);
            if (latest.status !== 'ok') process.exitCode = 1;
            return;
          }
          if (Date.now() > deadline) fail(`no finished run of "${t.name}" within ${limit} min`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (sub === 'runs') {
        const t = await pick(rest[2]);
        const n = Math.min(Math.max(Number(flags.get('limit') ?? 5) || 5, 1), 50);
        const runs = await runsOf(t.id, n);
        if (flags.has('json')) return console.log(JSON.stringify(runs, null, 2));
        if (!runs.length) return console.log(`"${t.name}" has not run yet.`);
        for (const r of runs) printRun(r);
        return;
      }
      if (sub === 'pause' || sub === 'resume') {
        const t = await pick(rest[2]);
        await jsonPost(`${base}/${encodeURIComponent(t.id)}`, { enabled: sub === 'resume' }, 'PATCH');
        console.log(`"${t.name}" ${sub === 'resume' ? 'resumed' : 'paused'}.`);
        return;
      }
      if (sub === 'rm' || sub === 'remove' || sub === 'delete') {
        const t = await pick(rest[2]);
        if (!flags.has('yes')) {
          const ok = await askLine(`Remove the task "${t.name}" from "${a.name}"? [y/N] `);
          if (!/^y(es)?$/i.test(ok.trim())) fail('nothing removed');
        }
        await api(ctx, `${base}/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
        console.log(`task "${t.name}" removed.`);
        return;
      }
      fail(usage);
    }
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

// Run only when invoked as the CLI, not when a test imports this module for its
// exported helpers (runFolders, …). realpath BOTH sides: the `hatchabot` bin is
// a symlink, so a raw path compare left main() unrun and every command silent.
function invokedAsCli(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedAsCli()) {
  main().catch((err) => fail(String(err?.message ?? err)));
}
