#!/usr/bin/env -S npx tsx
/**
 * agentclaw — command-line companion to the web app, speaking the same /v1
 * HTTP API. Exists for the things a browser is clumsy at: scripting, remote
 * management, and above all moving agents between machines:
 *
 *   laptop$  agentclaw export kitchen-helper -o kitchen.agentclaw
 *   desktop$ agentclaw import kitchen.agentclaw
 *
 * Config: AGENTCLAW_URL (default http://localhost:8080) and
 * AGENTCLAW_PASSWORD, or --url/--password flags.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
  } catch {
    return {};
  }
}

const USAGE = `agentclaw <command> [options]

Commands:
  login [--token <tok>]        Save an access token from the app (⚙ → CLI access).
                               Works with any sign-in method, including Google.
                               [--email <addr>] uses email/password instead.
  list                         Agents with state, model, and last activity
  create <name> [--persona <text>] [--profile <id>] [--host <id>]
         [--private] [--bot-token <tok>]
                               Create an agent and wait for it to boot.
                               Prompts for a BotFather token if the bot pool
                               is empty (or use --bot-token to recycle one).
  delete <agent> [--yes]       Delete an agent and its memory forever
                               (retypes the name unless --yes)
  export <agent> [-o <file>]   Download an agent as a portable .agentclaw file
                               (contains its bot token — treat as a secret;
                               the agent is left STOPPED on the source)
  import <file> [--profile <aiProfileId>] [--host <id>]
                               Import an exported agent and boot it
  start|stop|rebuild <agent>   Lifecycle controls
  retry <agent>                Retry a FAILED agent's provisioning
  rename <agent> <new name>    Change the display name
  ai [<agent>] [<profileId>]   Show AI sources, or point an agent at one
                               (applies on the agent's next rebuild)
  adopt <workspace-dir> <name> [--bot-token <tok>] [--profile <id>]
                               Turn an existing OpenClaw agent's workspace
                               into a managed AgentClaw agent (copies the
                               WHOLE folder; the original is only read)
  servers                      Other AgentClaw servers you can move agents to
  servers add <name> <url> <token>
                               Register one (token from that server's ⚙ AI)
  migrate <agent> <server>     Move an agent there: preflight, transfer, verify.
                               The source is left STOPPED, never deleted.
  invite <agent>               Mint a join link for the web flow
  pairing [<agent>]            Pending "wants to talk" requests
  approve <agent> <code>       Let a pending requester in (creates a member)
  members <agent>              List members
  kick <agent> <userId>        Revoke a member
  snapshot <agent> [--label <text>]
                               Save a restore point of SOUL/AGENTS/MEMORY
  snapshots <agent>            List restore points
  restore <agent> <snapshotId> Roll those files back (current state is saved first)
  token <agent>                Reveal the agent's Telegram bot token
  logs <agent> [-n <lines>]    Recent runtime output

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

const BOOL_FLAGS = new Set(['private', 'yes', 'help']);

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
        `Open ${url} → ⚙ AI → "CLI access" → New token, then paste it here.\nToken: `,
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
    return new Promise((resolve) => rl.once('line', (l) => { rl.close(); resolve(l.trim()); }));
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
      const profile = flags.get('profile') ?? profiles[0]?.id ?? fail('no AI profile — set one up first (web ⚙ AI)');
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
        console.log(`${a.name}: ${cur?.name ?? '(unknown)'} — ${cur?.model ?? a.model}`);
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
      console.log(`  ${preview.files.length} files (${(preview.bytes / 1e6).toFixed(1)} MB), incl. ${preview.markdownFiles.join(', ')}`);

      const profiles: any[] = await (await api(ctx, '/v1/ai-profiles')).json() as any[];
      const hosts: any[] = await (await api(ctx, '/v1/hosts')).json() as any[];
      const profile = flags.get('profile') ?? profiles[0]?.id ?? fail('no AI source configured');
      const host = (hosts.find((h) => h.kind === 'local') ?? hosts[0])?.id ?? fail('no host configured');

      console.log(`creating "${name}"…`);
      const created: any = await (await jsonPost('/v1/agents', {
        name, aiProfileId: profile, hostId: host, sharedMemory: false,
      })).json();

      let a = await pollAgent(created.id);
      if (a.pendingAction?.type === 'bot_token') {
        let tok = flags.get('bot-token');
        if (!tok) {
          console.log(a.pendingAction.instructions ?? 'A Telegram bot token is needed.');
          tok = await askLine('Paste bot token: ');
        }
        await jsonPost(`/v1/agents/${a.id}/channel-token`, { token: tok });
        a = await pollAgent(a.id);
      }
      if (a.state === 'FAILED') fail(`could not start: ${a.stateReason ?? 'unknown'}`);

      const res: any = await (await jsonPost(`/v1/agents/${a.id}/adopt-workspace`, { path: dir })).json();
      console.log(`adopted ${res.files} files (${(res.bytes / 1e6).toFixed(1)} MB) into "${name}".`);
      console.log(`The original at ${preview.path} is untouched — retire it when you're happy,`);
      console.log(`and do not point both at the same Telegram bot.`);
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
    case 'migrate': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw migrate <agent> <server>'));
      const ref = rest[1] ?? fail('give the destination server (see: agentclaw servers)');
      const peers: any[] = await (await api(ctx, '/v1/peers')).json() as any[];
      const peer = peers.find((p) => p.id === ref || p.name === ref);
      if (!peer) fail(`no server matches "${ref}"`);
      console.log(`moving "${a.name}" to ${peer.name}…`);
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/migrate`, { peerId: peer.id })).json();
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
    case 'list': {
      const list = await agents(ctx);
      if (!list.length) return console.log('no agents');
      const w = Math.max(...list.map((a) => a.name.length));
      for (const a of list) {
        console.log(
          `${a.name.padEnd(w)}  ${String(a.state).padEnd(12)} ${(a.model ?? '-').padEnd(20)} active ${ago(a.lastActiveAt)}`,
        );
      }
      return;
    }
    case 'export': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw export <agent> [-o file]'));
      const res = await api(ctx, `/v1/agents/${a.id}/export`);
      const out = flags.get('out') ?? `${a.slug}.agentclaw`;
      await writeFile(out, Buffer.from(await res.arrayBuffer()));
      console.log(`exported to ${out}`);
      console.log('note: the file contains the bot token — treat it like a password.');
      console.log(`note: "${a.name}" is now STOPPED here; keep it stopped once imported elsewhere.`);
      return;
    }
    case 'import': {
      const file = rest[0] ?? fail('usage: agentclaw import <file> [--profile <aiProfileId>]');
      const data = await readFile(file);
      const params = new URLSearchParams();
      if (flags.has('profile')) params.set('aiProfileId', flags.get('profile')!);
      if (flags.has('host')) params.set('hostId', flags.get('host')!);
      const q = params.size ? `?${params}` : '';
      const res = await api(ctx, `/v1/agents/import${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: data,
      });
      const agent: any = await res.json();
      console.log(`imported "${agent.name}" (${agent.state})`);
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
    case 'restore': {
      const a = await resolveAgent(ctx, rest[0] ?? fail('usage: agentclaw restore <agent> <snapshotId>'));
      const snapId = rest[1] ?? fail('give the snapshot id (see: agentclaw snapshots)');
      const res: any = await (await jsonPost(`/v1/agents/${a.id}/snapshots/${snapId}/restore`, {})).json();
      console.log(`restored ${res.restored.join(', ')}`);
      if (res.safetySnapshotId) console.log(`undo with: agentclaw restore "${a.name}" ${res.safetySnapshotId}`);
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
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().catch((err) => fail(String(err?.message ?? err)));
