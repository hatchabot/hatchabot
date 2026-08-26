#!/usr/bin/env -S npx tsx
/**
 * agentclaw — command-line companion to the web app, speaking the same /v1
 * HTTP API. Exists for the things a browser is clumsy at: scripting, remote
 * management, and above all moving agents between machines:
 *
 *   laptop$  agentclaw backup kitchen-helper -o kitchen.agentclaw
 *   desktop$ agentclaw restore kitchen.agentclaw
 *
 * Config: AGENTCLAW_URL (default http://localhost:8080) and
 * AGENTCLAW_PASSWORD, or --url/--password flags.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Flags > environment > ~/.config/agentclaw/env (KEY=VALUE lines, chmod 600 —
// keeps the password out of shell history and .bashrc).
function configDefaults(): Record<string, string> {
  try {
    const text = readFileSync(join(homedir(), '.config', 'agentclaw', 'env'), 'utf8');
    return Object.fromEntries(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), unquoteEnvValue(l.slice(l.indexOf('=') + 1))]),
    );
  } catch {
    return {};
  }
}

/**
 * setup-host.sh writes the password shell-single-quoted (the one form both
 * systemd's EnvironmentFile and shell sourcing agree on), e.g.
 * `AGENTCLAW_PASSWORD='p@ss'`. Without undoing that here the CLI sent the
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

const USAGE = `agentclaw <command> [options]

Commands:
  login [--token <tok>]        Save an access token from the app (⚙ Settings → Access).
                               Works with any sign-in method, including Google.
                               [--email <addr>] uses email/password instead.
  list [--all]                 Agents with state, model, and last activity.
                               --all (host owner): every user's agents, with
                               the owner id — find another login's leftovers.
  bots [--check]               Every Telegram bot this + your registered servers
                               use, flagging reclaimable/dead slots. --check adds
                               a live Telegram probe per bot.
  create <name> [--persona <text>] [--profile <id>] [--host <id>]
         [--private] [--bot-token <tok>]
                               Create an agent and wait for it to boot.
                               Prompts for a BotFather token if the bot pool
                               is empty.
  delete <agent> [--yes]       Delete an agent and its memory forever
                               (retypes the name unless --yes)
  download <agent> [-o <file>] Download a complete private copy (.agentclaw) — for
                               your own keeping (contains its bot token, so treat
                               as a secret; the agent is left STOPPED)
  restore <file> [--profile <aiProfileId>] [--host <id>]
                               Restore an agent from a downloaded copy and boot it
  share <agent> [-o <file>]    Share a TEMPLATE for someone else — the agent's
                               trained SOUL/AGENTS (+memory), no bot token/members
  import <file> [--name <n>] [--profile <aiProfileId>]
                               Import a template as a fresh agent (you give it
                               its own bot); prints what it still needs
  clone <agent> [new name]     Duplicate an agent here — a faithful copy with its
                               own bot and name
  start|stop|rebuild <agent>   Lifecycle controls
  retry <agent>                Retry a FAILED agent's provisioning
  rename <agent> <new name>    Change the display name
  ai [<agent>] [<profileId>]   Show AI sources, or point an agent at one
                               (applies on the agent's next rebuild)
  adopt <workspace-dir> <name> [--reuse-bot] [--bot-token <tok>] [--profile <id>]
                               Turn an existing OpenClaw agent's workspace
                               into a managed AgentClaw agent (copies the
                               WHOLE folder; the original is only read)
  folders <agent>              List everything an agent can access (folders and
                               git repos), each at /data/<name>
  folders <agent> add <path> [--rw]
                               Share a host folder (read-only, or --rw writable)
  folders <agent> add-repo <git-url> [--rw]
                               Clone a git repo onto the agent's volume; prints
                               the deploy key to add to the repo
  folders <agent> rm <name>    Stop sharing a folder or repo (by its /data/<name>)
  servers                      Other AgentClaw servers you can move agents to
  servers add <name> <url> <token>
                               Register one (token from that server's
                               ⚙ Settings → Access)
  rehost <agent> <server>      Move an agent there: preflight, transfer, verify.
                               The source is left STOPPED, never deleted.
  invite <agent>               Mint a join link for the web flow
  pairing [<agent>]            Pending "wants to talk" requests
  approve <agent> <code>       Let a pending requester in (creates a member)
  members <agent>              List members
  kick <agent> <userId>        Revoke a member
  snapshot <agent> [--label <text>]
                               Save a restore point of SOUL/AGENTS/MEMORY
  snapshots <agent>            List restore points
  revert <agent> <snapshotId>  Roll those files back (current state is saved first)
  token <agent>                Reveal the agent's Telegram bot token
  logs <agent> [-n <lines>]    Recent runtime output
  health <agent>               Live gateway health — is it actually answering
  usage [agent]                Token usage by model; no agent → the fleet ranked by tokens
  runtime                      Runtime image's OpenClaw version vs the npm latest
  upgrade-image [--version <X>] [--candidate]
                               Rebuild the shared runtime image to a new OpenClaw
                               version (default: latest stable), for the whole
                               fleet. --candidate builds without promoting to
                               :latest so you can smoke-test first. Run on the host.
  mgmt-bot <setup|status|disable> [--bot-token <tok>] [--yes]
                               Set up the Telegram management bot: mints a token,
                               pre-fills your Telegram id, writes .env.mgmt, and
                               installs the service (needs a BotFather token).

Global options:
  --url <url>        Control plane (env AGENTCLAW_URL, default http://localhost:8080)
  --password <pw>    Shared password (env AGENTCLAW_PASSWORD)

<agent> matches an agent's name, slug, or id prefix.`;

// `agentclaw list | head` must not crash when the pipe closes early.
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

/** ~/.config/agentclaw/env — same file the password default lives in. */
function configPath(): string {
  return join(homedir(), '.config', 'agentclaw', 'env');
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
  if (!res.ok) fail(`session expired (${data?.error?.message ?? res.status}) — run: agentclaw login`);
  return data.id_token as string;
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
      .replace(/__AGENTCLAW_DIR__/g, repoDir())
      .replace(/__AGENTCLAW_PATH__/g, process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin');
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

const BOOL_FLAGS = new Set(['private', 'yes', 'help', 'none', 'reuse-bot', 'rw', 'candidate', 'check', 'all']);

function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOL_FLAGS.has(name)) flags.set(name, '1');
      else flags.set(name, argv[++i] ?? '');
    } else if (a === '-o') flags.set('out', argv[++i] ?? '');
    else if (a === '-n') flags.set('lines', argv[++i] ?? '');
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
  if (!res.ok) fail(`login failed (${res.status}) — check AGENTCLAW_PASSWORD`);
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
    throw new Error(
      (data as any).error ?? (data as any).message ?? `${init.method ?? 'GET'} ${path} → ${res.status}`,
    );
  }
  return res;
}

async function agents(ctx: Ctx): Promise<any[]> {
  return (await api(ctx, '/v1/agents')).json() as Promise<any[]>;
}

async function resolveAgent(ctx: Ctx, ref: string): Promise<any> {
  const list = await agents(ctx);
  const hit = list.filter(
    (a) => a.name === ref || a.slug === ref || a.id.startsWith(ref),
  );
  if (hit.length === 1) return hit[0];
  if (hit.length === 0) fail(`no agent matches "${ref}" — try \`agentclaw list\``);
  fail(`"${ref}" is ambiguous: ${hit.map((a) => a.name).join(', ')}`);
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
        `Open ${url} → ⚙ Settings → Access → New token, then paste it here.\nToken: `,
      ));
    if (!token.startsWith('agentclaw_')) fail('that does not look like an AgentClaw token');
    const res = await fetch(`${url}/v1/agents`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) fail(`that token was rejected (${res.status})`);
    writeConfigValue('AGENTCLAW_TOKEN', token);
    console.log(`signed in. Token saved to ${configPath()} (chmod 600)`);
    return;
  }

  if (server.authMode !== 'identity') {
    fail('this server uses a shared password — set AGENTCLAW_PASSWORD instead (no login needed)');
  }
  const apiKey = server.identity?.apiKey ?? fail('server did not advertise an identity API key');
  const { createInterface } = await import('node:readline');
  const ask = (q: string): Promise<string> => {
    process.stderr.write(q);
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
    return new Promise((r) => rl.once('line', (l) => { rl.close(); r(l.trim()); }));
  };
  const email = flags.get('email') || (await ask('Email: '));
  const password = await ask('Password: ');
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
  writeConfigValue('AGENTCLAW_REFRESH_TOKEN', data.refreshToken);
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
  const usage = 'usage: agentclaw folders <agent> [add <path> [--rw] | add-repo <git-url> [--rw] | rm <name>]';
  const a = await io.resolveAgent(rest[0] ?? io.fail(usage));
  const sub = rest[1];

  // Back-compat: --none still clears the legacy read-only folder list.
  if (flags.has('none')) {
    await io.jsonPost(`/v1/agents/${a.id}`, { sharedPaths: [] }, 'PATCH');
    io.log(`"${a.name}" no longer reads any legacy host folder (on its next rebuild).`);
    return;
  }

  if (sub === 'add') {
    const raw = rest[2] ?? io.fail('usage: agentclaw folders <agent> add <path> [--rw]');
    const p = io.resolvePath(raw);
    const access = flags.has('rw') ? 'rw' : 'ro';
    await io.jsonPost(`/v1/agents/${a.id}/data-sources`, { kind: 'folder', access, path: p });
    io.log(`added ${access} folder ${p}  →  /data/${p.split('/').pop()} for "${a.name}".`);
    io.log('Takes effect on the next rebuild: agentclaw rebuild ' + JSON.stringify(a.name));
    return;
  }
  if (sub === 'add-repo') {
    const url = rest[2] ?? io.fail('usage: agentclaw folders <agent> add-repo <git-url> [--rw]');
    const access = flags.has('rw') ? 'rw' : 'ro';
    const up: any = await (await io.jsonPost(`/v1/agents/${a.id}/data-sources`, { kind: 'git', access, repoUrl: url })).json();
    const src = (up.dataSources ?? []).filter((d: any) => d.kind === 'git').slice(-1)[0];
    io.log(`added ${access} git repo  →  /data/${src?.mountName ?? '?'} for "${a.name}".`);
    if (src?.pubKey) {
      io.log(`\nAdd this deploy key to the repo${access === 'rw' ? ' (tick "Allow write access")' : ''}, then rebuild:`);
      io.log(src.pubKey);
    }
    return;
  }
  if (sub === 'rm') {
    const ref = rest[2] ?? io.fail('usage: agentclaw folders <agent> rm <name>');
    const src = (a.dataSources ?? []).find((d: any) => d.mountName === ref || d.id === ref);
    if (!src) io.fail(`no data source named "${ref}" on "${a.name}" — see: agentclaw folders ${JSON.stringify(a.name)}`);
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

/** `agentclaw health <agent>` output — a live gateway probe, mirroring ❤️ Health. */
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
    if (h.mgmtBotConfigured)
      out.push(`${`${String(++idx)}.`.padStart(4)} ${'(mgmt bot)'.padEnd(uw)}  ${'in use'.padEnd(11)}${live ? '  ' + ''.padEnd(13) : '  '}management bot — token stored outside the registry`);
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

/** `agentclaw usage <agent>` output — tokens by model, mirroring 📊 Usage. */
export function fmtUsage(name: string, u: any): string {
  if (!u.sessions) return `${name}: no sessions yet`;
  const lines = [`${name}: ${fmtTok(u.totalTokens)} tokens · ${u.sessions} session${u.sessions > 1 ? 's' : ''}`];
  for (const m of u.byModel ?? []) lines.push(`  ${String(m.model).padEnd(24)} ${fmtTok(m.tokens)}`);
  return lines.join('\n');
}

/** `agentclaw usage` (no agent) — running agents ranked by tokens. */
export function fmtFleetUsage(f: any): string {
  const agents: any[] = f.agents ?? [];
  if (!agents.length) {
    return f.skipped ? `No running agents to measure (${f.skipped} stopped — usage is live-only).` : 'No agents yet.';
  }
  const nw = Math.max(5, ...agents.map((a) => String(a.name).length));
  const lines = agents.map((a) => {
    const top = a.byModel?.[0]?.model ? `  ${a.byModel[0].model}${a.byModel.length > 1 ? ` +${a.byModel.length - 1}` : ''}` : '';
    return `  ${String(a.name).padEnd(nw)}  ${fmtTok(a.totalTokens).padStart(6)}  ${String(a.sessions).padStart(3)} sess${top}`;
  });
  lines.push(`  ${'—'.repeat(nw)}  ${fmtTok(f.totalTokens).padStart(6)}  ${String(f.totalSessions).padStart(3)} sess  (${f.counted} running${f.skipped ? `, ${f.skipped} not counted — live-only` : ''})`);
  return lines.join('\n');
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  if (!cmd || cmd === 'help' || flags.has('help')) {
    console.log(USAGE);
    return;
  }

  const defaults = configDefaults();
  const url = (
    flags.get('url') ?? process.env.AGENTCLAW_URL ?? defaults.AGENTCLAW_URL ?? 'http://localhost:8080'
  ).replace(/\/$/, '');
  const password =
    flags.get('password') ?? process.env.AGENTCLAW_PASSWORD ?? defaults.AGENTCLAW_PASSWORD ?? '';

  const server = await serverConfig(url);
  if (cmd === 'login') {
    await doLogin(url, server, flags);
    return;
  }

  // Local host ops that don't touch the control plane — answer before auth.
  if (cmd === 'mgmt-bot' && (rest[0] === 'status' || rest[0] === 'disable')) {
    const unit = 'agentclaw-mgmt-bot.service';
    if (rest[0] === 'status') {
      console.log(`service: ${systemctlUser(['is-active', unit]).out || 'unknown'} (${systemctlUser(['is-enabled', unit]).out || 'unknown'})`);
      const envPath = join(repoDir(), '.env.mgmt');
      console.log(`config : ${existsSync(envPath) ? envPath : 'not set up — run: agentclaw mgmt-bot setup'}`);
    } else {
      const r = systemctlUser(['disable', '--now', unit]);
      console.log(r.code === 0 ? 'Management bot stopped and disabled.' : `systemctl: ${r.out}`);
      console.log('(.env.mgmt kept — delete it yourself to remove the stored secrets.)');
    }
    return;
  }

  const savedToken = process.env.AGENTCLAW_TOKEN ?? defaults.AGENTCLAW_TOKEN;

  let ctx: Ctx;
  if (savedToken) {
    ctx = { url, cookie: '', bearer: savedToken };
  } else if (server.authMode === 'identity') {
    const refresh = process.env.AGENTCLAW_REFRESH_TOKEN ?? defaults.AGENTCLAW_REFRESH_TOKEN;
    const apiKey = server.identity?.apiKey;
    if (!refresh || !apiKey) fail('this server uses accounts — run: agentclaw login');
    ctx = { url, cookie: '', bearer: await idTokenFrom(refresh, apiKey) };
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

  const pollAgent = async (id: string): Promise<any> => {
    for (;;) {
      const a = (await (await api(ctx, `/v1/agents/${id}`)).json()) as any;
      if (a.state === 'RUNNING' || a.state === 'FAILED' || a.pendingAction) return a;
      await new Promise((r) => setTimeout(r, 3000));
    }
  };

  switch (cmd) {
    case 'create': {
      const name = rest.join(' ').trim() || fail('usage: agentclaw create <name> [options]');
      const profiles: any[] = await (await api(ctx, '/v1/ai-profiles')).json() as any[];
      const hosts: any[] = await (await api(ctx, '/v1/hosts')).json() as any[];
      const profile = flags.get('profile') ?? profiles[0]?.id ?? fail('no AI profile — set one up first (web ⚙ Settings → AI sources)');
      const host = flags.get('host') ?? (hosts.find((h) => h.kind === 'local') ?? hosts[0])?.id ?? fail('no host configured');
      const res = await jsonPost('/v1/agents', {
        name,
        persona: flags.get('persona') || undefined,
        aiProfileId: profile,
        hostId: host,
        sharedMemory: !flags.has('private'),
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
      if (a.state === 'FAILED') fail(`provisioning failed: ${a.stateReason ?? 'unknown'} (try: agentclaw retry "${name}")`);
      console.log(`"${a.name}" is RUNNING.`);
      if (a.deepLink) console.log(`Say hi to claim it as owner: ${a.deepLink}`);
      return;
    }
    case 'delete': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw delete <agent> [--yes]'));
      try {
        const t: any = await (await api(ctx, `/v1/agents/${a.id}/bot-token`)).json();
        if (!t.pooled) console.log(`note: bot @${t.accountId} is not pool-managed — save its token first (agentclaw token) if you want to recycle it.`);
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
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw retry <agent>'));
      await jsonPost(`/v1/agents/${a.id}/provision`, {});
      console.log(`retry requested for "${a.name}" — watch with: agentclaw list`);
      return;
    }
    case 'rename': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw rename <agent> <new name>'));
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
        console.log('\nagentclaw ai <agent> <profileId>   to point an agent at one');
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
      console.log(`"${a.name}" will use that AI source after: agentclaw rebuild "${a.name}"`);
      return;
    }
    case 'adopt': {
      const dir = rest[0] ?? fail('usage: agentclaw adopt <workspace-dir> <name>');
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
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw health <agent>'));
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
      else if (r.upgradeAvailable) console.log(`  ⬆ latest stable on npm is ${r.npmLatest} — upgrade with: agentclaw upgrade-image`);
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
      if (!existsSync(script)) fail(`Build script not found at ${script} — run this on the AgentClaw host.`);
      console.log(`Building agentclaw-runtime for OpenClaw ${version}${candidate ? ' (candidate — :latest untouched)' : ' (promotes to :latest)'}…\n`);
      try {
        execFileSync('bash', [script], {
          stdio: 'inherit',
          env: { ...process.env, OPENCLAW_VERSION: version, NO_LATEST: candidate ? '1' : '' },
        });
      } catch {
        fail('Image build failed — see the output above.');
      }
      if (candidate) {
        console.log(`\nCandidate built (:latest untouched). Smoke-test it, then promote:`);
        console.log(`  AGENTCLAW_IMAGE=agentclaw-runtime:${version} npm run e2e:docker   (from ${repoDir()})`);
        console.log(`  docker tag agentclaw-runtime:${version} agentclaw-runtime:latest`);
      } else {
        console.log(`\nDone — :latest is now OpenClaw ${version}. Each agent shows "update available";`);
        console.log(`Rebuild it to adopt the new version, memory kept:  agentclaw rebuild "<agent>"`);
      }
      return;
    }
    case 'servers': {
      if (rest[0] === 'add') {
        const [, name, url, token] = rest;
        if (!name || !url || !token) fail('usage: agentclaw servers add <name> <url> <token>');
        const p: any = await (await jsonPost('/v1/peers', { name, url, token })).json();
        console.log(`added "${p.name}" (${p.url})`);
        return;
      }
      const peers: any[] = await (await api(ctx, '/v1/peers')).json() as any[];
      if (!peers.length) return console.log('no servers yet — agentclaw servers add <name> <url> <token>');
      for (const p of peers) console.log(`${p.id}  ${p.name.padEnd(20)} ${p.url}`);
      return;
    }
    case 'rehost':
    case 'migrate': { // 'migrate' kept as an alias for the old name
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw rehost <agent> <server>'));
      const ref = rest[1] ?? fail('give the destination server (see: agentclaw servers)');
      const peers: any[] = await (await api(ctx, '/v1/peers')).json() as any[];
      const peer = peers.find((p) => p.id === ref || p.name === ref);
      if (!peer) fail(`no server matches "${ref}"`);
      console.log(`rehosting "${a.name}" to ${peer.name}…`);
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/rehost`, { peerId: peer.id })).json();
      console.log(`done — now running on ${res.movedTo} as ${res.remoteAgentId}`);
      console.log(`"${a.name}" here is ${res.sourceState} and was NOT deleted.`);
      console.log(`Keep it that way: two copies polling one bot token fight over messages.`);
      return;
    }
    case 'invite': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw invite <agent>'));
      const inv: any = await (await jsonPost(`/v1/agents/${a.id}/invites`, {})).json();
      console.log(inv.url ?? `${ctx.url}${inv.path}  (set AGENTCLAW_PUBLIC_URL for a shareable link)`);
      console.log(`single-use, expires ${inv.expiresAt}`);
      if (a.deepLink) console.log(`no-Tailscale path: send them ${a.deepLink} and run \`agentclaw pairing\` when they message it`);
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
          console.log(`${a.name}: ${r.meta?.firstName ?? r.meta?.username ?? r.id} wants to talk — approve with: agentclaw approve "${a.name}" ${r.code}`);
        }
      }
      if (!any) console.log('no pending requests');
      return;
    }
    case 'approve': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw approve <agent> <code>'));
      const code = rest[1] ?? fail('give the pairing code (see: agentclaw pairing)');
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/pairing/approve`, { code })).json();
      console.log(res.member?.alreadyMember
        ? `${res.member.displayName} is already a member — access restored`
        : `${res.member?.displayName ?? 'Guest'} is in — now a member`);
      return;
    }
    case 'members': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw members <agent>'));
      const ms: any[] = await (await api(ctx, `/v1/agents/${a.id}/members`)).json() as any[];
      for (const m of ms) {
        console.log(`${(m.displayName ?? m.userId).padEnd(24)} ${m.role.padEnd(6)} ${m.channelUserId ? 'linked' : 'not linked'}  ${m.userId}`);
      }
      return;
    }
    case 'kick': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw kick <agent> <userId>'));
      const userId = rest[1] ?? fail('give the member userId (see: agentclaw members)');
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
    case 'list': {
      // --all (host owner): every user's agents, with the owner id — the
      // admin view for finding another login's leftovers.
      const all = flags.has('all');
      const res = await api(ctx, `/v1/agents${all ? '?all=1' : ''}`);
      const list = (await res.json()) as any[];
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
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw download <agent> [-o file]'));
      const res = await api(ctx, `/v1/agents/${a.id}/backup`);
      const out = flags.get('out') ?? `${a.slug}.agentclaw`;
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
      console.log(`backed up to ${out}`);
      console.log('note: the file is a complete private copy — it contains the bot token, treat it like a password.');
      console.log(`note: "${a.name}" is now STOPPED here; keep it stopped once restored elsewhere.`);
      return;
    }
    case 'restore': {
      const file = rest[0] ?? fail('usage: agentclaw restore <file> [--profile <aiProfileId>]');
      const data = await readFile(file);
      const params = new URLSearchParams();
      if (flags.has('profile')) params.set('aiProfileId', flags.get('profile')!);
      if (flags.has('host')) params.set('hostId', flags.get('host')!);
      const q = params.size ? `?${params}` : '';
      const res = await api(ctx, `/v1/agents/restore${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: data,
      });
      const agent: any = await res.json();
      console.log(`restored "${agent.name}" (${agent.state})`);
      return;
    }
    case 'share':
    case 'export': { // template — a trained copy for someone else. ('export' alias)
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw share <agent> [-o file]'));
      const res = await api(ctx, `/v1/agents/${a.id}/export`);
      const out = flags.get('out') ?? `${a.slug}.template.agentclaw`;
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
      console.log(`exported template to ${out}`);
      console.log('a shareable copy — no bot token, members, or memory. Safe to send to someone.');
      return;
    }
    case 'import': { // template
      const file = rest[0] ?? fail('usage: agentclaw import <file> [--name <name>] [--profile <aiProfileId>]');
      const data = await readFile(file);
      const params = new URLSearchParams();
      if (flags.has('name')) params.set('name', flags.get('name')!);
      if (flags.has('profile')) params.set('aiProfileId', flags.get('profile')!);
      if (flags.has('host')) params.set('hostId', flags.get('host')!);
      const q = params.size ? `?${params}` : '';
      const res = await api(ctx, `/v1/agents/import${q}`, {
        method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: data,
      });
      const j: any = await res.json();
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
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw clone <agent> [new name]'));
      const name = rest.slice(1).join(' ').trim() || `${a.name} (copy)`;
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/clone`, { name })).json();
      console.log(`cloned "${a.name}" → "${res.name}" (${res.state}) — connect its Telegram bot to finish.`);
      return;
    }
    case 'start':
    case 'stop':
    case 'rebuild': {
      const a = await resolveAgent(ctx, rest[0] ?? fail(`usage: agentclaw ${cmd} <agent>`));
      await api(ctx, `/v1/agents/${a.id}/${cmd}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      console.log(`${cmd} requested for "${a.name}"`);
      return;
    }
    case 'snapshot': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw snapshot <agent> [--label text]'));
      const s: any = await (await jsonPost(`/v1/agents/${a.id}/snapshots`, { label: flags.get('label') })).json();
      console.log(`saved "${s.label}" (${s.files.join(', ')})`);
      console.log(s.id);
      return;
    }
    case 'snapshots': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw snapshots <agent>'));
      const list: any[] = await (await api(ctx, `/v1/agents/${a.id}/snapshots`)).json() as any[];
      if (!list.length) return console.log('no snapshots yet');
      for (const s of list) {
        console.log(`${s.id}  ${ago(s.createdAt).padEnd(10)} ${s.reason.padEnd(12)} ${s.label}`);
      }
      return;
    }
    case 'revert': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw revert <agent> <snapshotId>'));
      const snapId = rest[1] ?? fail('give the snapshot id (see: agentclaw snapshots)');
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/snapshots/${snapId}/restore`, {})).json();
      console.log(`reverted ${res.restored.join(', ')}`);
      if (res.safetySnapshotId) console.log(`undo with: agentclaw revert "${a.name}" ${res.safetySnapshotId}`);
      console.log('applies to new conversations — send /new in Telegram');
      return;
    }
    case 'token': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw token <agent>'));
      const t = (await (await api(ctx, `/v1/agents/${a.id}/bot-token`)).json()) as any;
      console.log(`bot: @${t.accountId}${t.pooled ? ' (pool — recycles automatically)' : ''}`);
      console.log(t.botToken);
      return;
    }
    case 'logs': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw logs <agent> [-n lines]'));
      const lines = flags.get('lines') ?? '80';
      const { text } = (await (await api(ctx, `/v1/agents/${a.id}/logs?lines=${lines}`)).json()) as any;
      console.log(text || '(no recent output)');
      return;
    }
    case 'mgmt-bot': {
      const unit = 'agentclaw-mgmt-bot.service';
      const envPath = join(repoDir(), '.env.mgmt');
      // status/disable are handled before auth, above; only setup reaches here.
      if ((rest[0] ?? 'setup') !== 'setup') fail('usage: agentclaw mgmt-bot <setup|status|disable>');

      console.error('Setting up the AgentClaw management bot.\n');
      // 1. Mint the bot's own owner-scoped bearer.
      const minted = (await (await jsonPost('/v1/cli-tokens', { label: 'mgmt-bot' })).json()) as {
        token: string;
      };
      // 2. Pre-fill the allowlist from the owner's Telegram id (the owner seat
      //    on any existing agent), so you don't have to look up your numeric id.
      const found = new Set<string>();
      for (const a of await agents(ctx)) {
        try {
          const members = (await (await api(ctx, `/v1/agents/${a.id}/members`)).json()) as any[];
          for (const m of members) if (m.role === 'owner' && m.channelUserId) found.add(String(m.channelUserId));
        } catch {
          /* skip agents we can't read members for */
        }
      }
      let allow = [...found];
      if (allow.length) {
        const ans = (await askLine(`Allow these Telegram id(s) to control the fleet: ${allow.join(', ')}? [Y/n] `)).toLowerCase();
        if (ans === 'n' || ans === 'no') allow = [];
      }
      if (!allow.length) {
        const raw = await askLine('Telegram user id(s) allowed to control (comma-separated): ');
        allow = raw.split(',').map((s) => s.trim()).filter(Boolean);
      }
      if (!allow.length) fail('an allowlist is required — the bot would otherwise accept nobody.');
      if (!allow.every((id) => /^\d{1,20}$/.test(id))) fail('Telegram ids are numeric.');

      // 3. The one thing no tool can automate: the BotFather token.
      const botToken =
        flags.get('bot-token') || (await askLine('Paste the BotFather token for the management bot: '));
      if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
        fail('that does not look like a BotFather token (e.g. 123456789:AA…).');
      }

      // 4. Write .env.mgmt (secrets isolated from the control plane's .env).
      writeFileSync(
        envPath,
        [
          `AGENTCLAW_MGMT_BOT_TOKEN=${envQuote(botToken)}`,
          `AGENTCLAW_MGMT_TOKEN=${envQuote(minted.token)}`,
          `AGENTCLAW_MGMT_ALLOWLIST=${allow.join(',')}`,
          `AGENTCLAW_URL=${ctx.url}`,
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      console.error(`wrote ${envPath} (chmod 600)`);

      // 5. Install + start the service (best-effort; falls back to a manual hint).
      const wantSvc =
        flags.has('yes') ||
        (await askLine('Install and start the background service now? [Y/n] ')).toLowerCase() !== 'n';
      if (wantSvc && installUserUnit(unit)) {
        console.log('\n✅ Management bot installed and running.');
        console.log('   DM your bot /list to check. It starts READ-ONLY — send /mode readwrite to arm changes.');
      } else {
        console.log(`\nConfig ready. Start it with:  npm run mgmt   (from ${repoDir()})`);
      }
      return;
    }
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

// Run only when invoked as the CLI, not when a test imports this module for its
// exported helpers (runFolders, …). realpath BOTH sides: the `agentclaw` bin is
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
