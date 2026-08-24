/**
 * Isolated, full live end-to-end smoke test of the adopt flow.
 *
 * Stands up a THROWAWAY AgentClaw server — its own port, its own temp data dir,
 * its own `aclawsmoke` Docker namespace, and its own throwaway OpenClaw config +
 * state DB (pre-seeded with one agent, one cron, and an external-folder
 * reference) — then adopts that agent through the real HTTP API against real
 * Docker and a real Telegram bot, and asserts:
 *
 *   • the agent reaches RUNNING with a real backing Docker container,
 *   • the source agent's cron was carried in (disabled),
 *   • the external data folder is detected and mounts at its host path.
 *
 * Then it deletes the agent, kills the server, and removes every temp file and
 * every `aclawsmoke-*` container/volume. It never touches your real server,
 * config, gateway, or containers.
 *
 *   AGENTCLAW_SMOKE_BOT_TOKEN=<throwaway BotFather token> npm run smoke:adopt:full
 *
 * Optional: AGENTCLAW_SMOKE_AI_KEY (a real Anthropic key makes the agent's
 * model usable; a dummy still boots the container), AGENTCLAW_SMOKE_PORT.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

// Convenience: load a git-ignored .env.smoke (KEY=VALUE lines) if present, so
// you only fill one 0600 file and run the npm script. A real env var wins.
if (existsSync('.env.smoke')) {
  for (const line of readFileSync('.env.smoke', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k && process.env[k] === undefined) process.env[k] = (v ?? '').replace(/^["']|["']$/g, '');
  }
}

const TOKEN = process.env.AGENTCLAW_SMOKE_BOT_TOKEN;
const AI_KEY = process.env.AGENTCLAW_SMOKE_AI_KEY || 'sk-smoke-dummy-key';
const PORT = Number(process.env.AGENTCLAW_SMOKE_PORT || 18099);
const PREFIX = 'aclawsmoke';
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER_HEADER: Record<string, string> = { 'x-agentclaw-owner': 'dev-owner' };

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const step = (s: string) => console.log(`\n${bold('• ' + s)}`);
const ok = (s: string) => console.log(`  ${green('✓')} ${s}`);

class SmokeError extends Error {}
const assert = (cond: unknown, msg: string) => { if (!cond) throw new SmokeError(msg); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN) {
  console.log('\x1b[33mSKIP\x1b[0m: set AGENTCLAW_SMOKE_BOT_TOKEN to a throwaway BotFather token to run the live test.');
  process.exit(0);
}

// ---- temp layout ------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'aclaw-smoke-'));
const dataDir = join(work, 'data'); mkdirSync(dataDir, { recursive: true });
const ocConfig = join(work, 'openclaw.json');
const ocStateDb = join(work, 'oc-state.sqlite');
const ws = join(work, 'workspace-smoke'); mkdirSync(join(ws, 'memory'), { recursive: true });
// External data dir must live OUTSIDE /tmp — the folder scan excludes /tmp.
const extRoot = mkdtempSync(join(process.cwd(), 'aclaw-smoke-data-'));
const extDir = join(extRoot, 'briefing-docs'); mkdirSync(extDir, { recursive: true });
writeFileSync(join(extDir, 'notes.md'), 'external data the agent reads');

let server: ChildProcess | undefined;
let agentId: string | undefined;

function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  // Only claim a JSON body when there is one — Fastify 400s an empty body that
  // still carries content-type (e.g. a body-less DELETE).
  const headers = body === undefined ? OWNER_HEADER : { ...OWNER_HEADER, 'content-type': 'application/json' };
  return fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}
async function poll<T>(fn: () => Promise<T | undefined>, tries = 45, gap = 2000): Promise<T> {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v !== undefined) return v; await sleep(gap); }
  throw new SmokeError('timed out waiting for a condition');
}
function docker(args: string[]): string {
  try { return execFileSync('docker', args, { encoding: 'utf8' }).trim(); } catch { return ''; }
}

async function seed() {
  step('Seed a throwaway OpenClaw install');
  writeFileSync(join(ws, 'SOUL.md'), `# Smoke Agent\nA disposable agent. You read briefing docs from ${extDir}.`);
  writeFileSync(join(ws, 'AGENTS.md'), 'Answer briefly.');
  writeFileSync(join(ws, 'MEMORY.md'), '(smoke — no memory)');
  writeFileSync(ocConfig, JSON.stringify({
    agents: { list: [{ id: 'smoke', workspace: ws }] },
    bindings: [{ agentId: 'smoke', match: { channel: 'telegram', accountId: 'smokebot' } }],
    channels: { telegram: { accounts: { smokebot: { botToken: TOKEN, enabled: false, allowFrom: [] } } } },
  }));
  const db = new Database(ocStateDb);
  db.exec(`CREATE TABLE cron_jobs (agent_id TEXT, name TEXT, description TEXT, schedule_kind TEXT,
    schedule_expr TEXT, schedule_tz TEXT, every_ms INTEGER, at TEXT, payload_kind TEXT,
    payload_message TEXT, sort_order INTEGER, created_at_ms INTEGER)`);
  db.prepare(`INSERT INTO cron_jobs (agent_id,name,schedule_kind,schedule_expr,payload_kind,payload_message,sort_order,created_at_ms)
    VALUES ('smoke','Daily brief','cron','0 8 * * *','agentTurn',?,0,1)`).run(`Summarise notes in ${ws}/memory.`);
  db.close();
  ok('workspace, OpenClaw config (bot disabled), and a cron are staged');
}

async function startServer() {
  step(`Start a throwaway AgentClaw on :${PORT} (docker prefix ${PREFIX})`);
  // Loopback + no password → every request is the owner; the header is
  // belt-and-suspenders. Delete any inherited password so we don't land in
  // password mode with an empty credential.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(PORT),
    AGENTCLAW_BIND: '127.0.0.1',
    AGENTCLAW_DB: join(dataDir, 'agentclaw.sqlite'),
    AGENTCLAW_SECRET_KEY: randomBytes(32).toString('hex'),
    AGENTCLAW_PREFIX: PREFIX,
    // Offset gateway ports well clear of the real server's range (19100+), so a
    // throwaway container can't collide with a live agent's published port.
    AGENTCLAW_GATEWAY_PORT_BASE: process.env.AGENTCLAW_SMOKE_GATEWAY_BASE || '29100',
    AGENTCLAW_ALLOW_OWNER_HEADER: '1',
    OPENCLAW_CONFIG: ocConfig,
    OPENCLAW_STATE_DB: ocStateDb,
    AGENTCLAW_IMAGE: process.env.AGENTCLAW_IMAGE || 'agentclaw-runtime:latest',
  };
  delete env.AGENTCLAW_PASSWORD;
  server = spawn('node_modules/.bin/tsx', ['src/index.ts'], { cwd: process.cwd(), env, stdio: ['ignore', 'inherit', 'inherit'] });
  let exited: { code: number | null; sig: string | null } | undefined;
  server.on('exit', (code, sig) => { exited = { code, sig }; });
  // Retry through startup: connection-refused is expected until it's listening.
  await poll(async () => {
    if (exited) throw new SmokeError(`server exited during startup (code ${exited.code}${exited.sig ? `, ${exited.sig}` : ''}) — see its output above`);
    try { return (await api('GET', '/v1/agents')).status === 200 ? true : undefined; }
    catch { return undefined; }
  }, 40, 1000);
  ok('server is up and answering');
}

async function run() {
  await seed();
  await startServer();

  step('Create an AI source on the throwaway server');
  const prof = await api('POST', '/v1/ai-profiles', { kind: 'api_key', name: 'Smoke AI', vendor: 'anthropic', model: 'claude-opus-4-8', apiKey: AI_KEY });
  assert(prof.status === 201 || prof.status === 200, `ai-profile create failed: ${prof.status} ${JSON.stringify(prof.json)}`);
  const aiProfileId = prof.json.id;
  ok(`AI source ${aiProfileId}`);

  step('Discover the OpenClaw agent');
  const disc = await api('GET', '/v1/openclaw/agents');
  assert(disc.status === 200, `discovery failed: ${disc.status}`);
  const found = disc.json.agents.find((a: any) => a.id === 'smoke');
  assert(found?.bot?.accountId === 'smokebot', 'discovery did not surface smokebot');
  ok('discovery found the agent and its (disabled) bot');

  step('Adopt it: create → take over its bot → boot the container');
  const created = await api('POST', '/v1/agents', { name: 'aclaw-smoke', aiProfileId, hostId: 'host-local-default', sharedMemory: false });
  // 202 Accepted: the record exists and provisioning runs in the background.
  assert(created.status === 201 || created.status === 202, `create failed: ${created.status} ${JSON.stringify(created.json)}`);
  agentId = created.json.id;

  let a = await poll(async () => {
    try {
      const r = await api('GET', `/v1/agents/${agentId}`);
      return r.json.pendingAction || r.json.state === 'RUNNING' || r.json.state === 'FAILED' ? r.json : undefined;
    } catch { return undefined; }
  });
  if (a.pendingAction?.type === 'bot_token') {
    const tk = await api('POST', `/v1/agents/${agentId}/channel-token`, { fromWorkspace: ws });
    assert(tk.status < 400, `bot takeover failed: ${tk.status} ${JSON.stringify(tk.json)}`);
  }
  a = await poll(async () => {
    try {
      const r = await api('GET', `/v1/agents/${agentId}`);
      if (r.json.state === 'FAILED') throw new SmokeError(`agent FAILED: ${r.json.stateReason ?? 'unknown'}`);
      return r.json.state === 'RUNNING' ? r.json : undefined;
    } catch (e) { if (e instanceof SmokeError) throw e; return undefined; }
  });
  ok('agent reached RUNNING');

  step('Assert a real Docker container backs it');
  const cname = await poll(async () => {
    const n = docker(['ps', '--format', '{{.Names}}', '--filter', `name=${PREFIX}-`]).split('\n').find(Boolean);
    return n || undefined;
  }, 10, 1000);
  ok(`container up: ${cname}`);

  step('Copy the workspace + carry crons');
  const adopt = await api('POST', `/v1/agents/${agentId}/adopt-workspace`, { path: ws });
  assert(adopt.status === 200, `adopt-workspace failed: ${adopt.status} ${JSON.stringify(adopt.json)}`);
  assert(adopt.json.crons?.carried === 1, `expected 1 cron carried, got ${JSON.stringify(adopt.json.crons)}`);
  ok(`carried ${adopt.json.crons.carried} cron (disabled)`);
  const crons = await api('GET', `/v1/agents/${agentId}/crons`);
  assert((crons.json.crons ?? []).length >= 1, 'cron not present in the container');
  ok('cron is present in the container');

  step('Detect + share the external data folder (mounts at its host path)');
  const scan = await api('POST', '/v1/workspaces/scan-paths', { path: ws });
  assert((scan.json.candidates ?? []).includes(extDir), `scan did not surface ${extDir}: ${JSON.stringify(scan.json.candidates)}`);
  ok(`scan found ${extDir}`);
  const share = await api('POST', `/v1/agents/${agentId}/data-sources`, { kind: 'folder', access: 'ro', path: extDir, atHostPath: true });
  assert(share.status === 200, `folder share failed: ${share.status} ${JSON.stringify(share.json)}`);
  const rebuilt = await api('POST', `/v1/agents/${agentId}/rebuild`, {});
  assert(rebuilt.status < 400, `rebuild failed: ${rebuilt.status}`);
  // wait for the new container, then confirm the bind mount lands at extDir → extDir
  await poll(async () => (docker(['ps', '--format', '{{.Names}}', '--filter', `name=${PREFIX}-`]).includes(PREFIX) ? true : undefined), 20, 1500);
  const mounted = await poll(async () => {
    const c = docker(['ps', '--format', '{{.Names}}', '--filter', `name=${PREFIX}-`]).split('\n').find(Boolean);
    if (!c) return undefined;
    const mounts = docker(['inspect', '-f', '{{range .Mounts}}{{.Source}}=>{{.Destination}}\n{{end}}', c]);
    return mounts.includes(`${extDir}=>${extDir}`) ? true : undefined;
  }, 20, 1500);
  assert(mounted, `external folder did not mount at its host path ${extDir}`);
  ok(`folder is mounted read-only at ${extDir} inside the container`);

  console.log(`\n${bold(green('SMOKE PASS'))} — adopt stood up a live container, carried the cron, and mounted the data folder.`);
}

async function cleanup() {
  step('Teardown');
  if (agentId) { await api('DELETE', `/v1/agents/${agentId}`).catch(() => {}); await sleep(1500); }
  // belt-and-suspenders: remove any aclawsmoke-* containers/volumes this run made
  const cs = docker(['ps', '-aq', '--filter', `name=${PREFIX}-`]).split('\n').filter(Boolean);
  if (cs.length) docker(['rm', '-f', ...cs]);
  const vs = docker(['volume', 'ls', '-q', '--filter', `name=${PREFIX}-`]).split('\n').filter(Boolean);
  if (vs.length) docker(['volume', 'rm', ...vs]);
  if (server) { server.kill('SIGTERM'); await sleep(1000); server.kill('SIGKILL'); }
  rmSync(work, { recursive: true, force: true });
  rmSync(extRoot, { recursive: true, force: true });
  ok('deleted the agent, killed the server, removed all temp files and aclawsmoke-* containers/volumes');
}

// A Ctrl-C or kill mid-run must still tear everything down.
let tearingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (tearingDown) return;
    tearingDown = true;
    console.log(`\n(received ${sig})`);
    await cleanup().catch(() => {});
    process.exit(130);
  });
}

run()
  .then(() => cleanup().then(() => process.exit(0)))
  .catch(async (err) => {
    console.error(`\n  ${red('✗ ' + (err instanceof Error ? err.message : String(err)))}`);
    await cleanup().catch(() => {});
    console.log(`\n${bold(red('SMOKE FAIL'))}`);
    process.exit(1);
  });
