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

const USAGE = `agentclaw <command> [options]

Commands:
  list                         Agents with state, model, and last activity
  export <agent> [-o <file>]   Download an agent as a portable .agentclaw file
                               (contains its bot token — treat as a secret;
                               the agent is left STOPPED on the source)
  import <file> [--profile <aiProfileId>]
                               Import an exported agent and boot it
  start|stop|rebuild <agent>   Lifecycle controls
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
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) flags.set(a.slice(2), argv[++i] ?? '');
    else if (a === '-o') flags.set('out', argv[++i] ?? '');
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
  const res = await fetch(`${ctx.url}${path}`, {
    ...init,
    headers: { cookie: ctx.cookie, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}) as any);
    fail((data as any).error ?? (data as any).message ?? `${init.method ?? 'GET'} ${path} → ${res.status}`);
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

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = positional;
  if (!cmd || cmd === 'help' || flags.has('help')) {
    console.log(USAGE);
    return;
  }

  const url = (flags.get('url') ?? process.env.AGENTCLAW_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const password = flags.get('password') ?? process.env.AGENTCLAW_PASSWORD ?? '';
  const ctx = await login(url, password);

  switch (cmd) {
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
      const q = flags.has('profile') ? `?aiProfileId=${encodeURIComponent(flags.get('profile')!)}` : '';
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
