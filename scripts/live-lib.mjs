/**
 * What the live scenario scripts share (scripts/live.mjs runs them): the
 * install's API, agents settling, docker on the right machine, memory notes
 * found by meaning, and the scenario report. Made-up content only.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function loadEnv() {
  const f = join(homedir(), '.config', 'hatchabot', 'env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();
export const BASE = (process.env.HATCHABOT_URL || 'http://localhost:8080').replace(/\/$/, '');
const TOKEN = process.env.HATCHABOT_TOKEN || '';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function api(path, { method = 'GET', body, raw, headers: extra } = {}) {
  const headers = { authorization: `Bearer ${TOKEN}`, ...extra };
  let payload;
  if (raw) { headers['content-type'] = 'application/octet-stream'; payload = raw; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(30 * 60_000) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { text }; }
  return { status: res.status, json };
}

/**
 * Live tests never use a Telegram bot: bots are scarce (about 20 per Telegram
 * account) and a test agent holding one keeps it from a real agent. A test
 * agent found with one is deleted at once — which hands the bot back to the
 * pool — and the test fails (a clone on a release without web-only clones
 * took the last free pool bot, 2026-10-08).
 */
async function refuseBot(agent) {
  if (!agent?.deepLink && !agent?.botUsername) return;
  await api(`/v1/agents/${agent.id}`, { method: 'DELETE' }).catch(() => {});
  throw new Error(`"${agent.name}" was given a Telegram bot — deleted it at once to hand the bot back. Live tests must stay web-only.`);
}

/** Refuse to run against a Hatchabot older than `min` (a test that needs what it added). */
export async function requireVersion(min) {
  const v = String((await api('/v1/diagnostics')).json.version ?? '').replace(/^v/, '');
  const n = (x) => x.split('.').map(Number);
  const [a, b] = [n(v), n(min.replace(/^v/, ''))];
  const older = a.length !== 3 || a.some(Number.isNaN) || a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  if (older) throw new Error(`This test needs Hatchabot ${min} or newer on the install (it runs v${v || '?'}).`);
}

/** Until the agent settles in `want` (not busy); FAILED or the deadline throws. */
export async function settle(id, want = 'RUNNING', minutes = 20) {
  const deadline = Date.now() + minutes * 60_000;
  let last;
  while (Date.now() < deadline) {
    const r = await api(`/v1/agents/${id}`);
    last = r.json;
    await refuseBot(last);
    if (last.state === want && !last.busy) return last;
    if (last.state === 'FAILED') throw new Error(`FAILED: ${last.stateReason ?? 'no reason'}`);
    await sleep(5000);
  }
  throw new Error(`still ${last?.state}${last?.busy ? ' (busy)' : ''} after ${minutes} min`);
}

/** The agent by name (the newest), or undefined. */
export async function byName(name) {
  const all = (await api('/v1/agents')).json;
  return Array.isArray(all) ? all.filter((a) => a.name === name).at(-1) : undefined;
}

/** A web-only agent on the default AI source, settled RUNNING. */
export async function createAgent(name, hostId) {
  const profiles = (await api('/v1/ai-profiles')).json;
  const profile = profiles.find((p) => p.defaultSource) ?? profiles[0];
  hosts ??= (await api('/v1/hosts')).json;
  const host = hostId ?? hosts.find((h) => h.kind === 'local')?.id;
  const r = await api('/v1/agents', { method: 'POST', body: { name, aiProfileId: profile.id, hostId: host, telegram: false } });
  if (r.status >= 300) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return settle(r.json.id, 'RUNNING', 25);
}

let hosts;
async function connFor(hostId) {
  hosts ??= (await api('/v1/hosts')).json;
  const h = hosts.find((x) => x.id === hostId);
  return h && h.kind !== 'local' && h.settings?.dockerHost ? ['-H', h.settings.dockerHost] : [];
}
export async function inAgent(agent, argv, timeoutMs = 600_000) {
  const name = String(agent.runtimeRef || '').replace(/^docker:\/\//, '');
  const r = spawnSync('docker', [...(await connFor(agent.hostId)), 'exec', name, ...argv], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
export const workspaceOf = (agent) => `/home/node/.openclaw/agents/${agent.slug}/agent`;

/** Upload a file into the agent (the app's own upload route). */
export async function putFile(agent, dir, name, body) {
  await inAgent(agent, ['mkdir', '-p', `/home/node/${dir}`], 60_000);
  const r = await api(`/v1/agents/${agent.id}/fs/file?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}&overwrite=1`, { method: 'PUT', raw: Buffer.from(body) });
  if (r.status !== 200) throw new Error(`upload ${name}: ${r.status} ${JSON.stringify(r.json)}`);
}

/** A note found by a query that shares no word with it: only working embeddings find it. */
export async function recalls(agent, file, query) {
  await inAgent(agent, ['openclaw', 'memory', 'index', '--agent', agent.slug]);
  const s = await inAgent(agent, ['openclaw', 'memory', 'search', '--agent', agent.slug, '--json', '--max-results', '5', '--query', query], 180_000);
  const st = await inAgent(agent, ['openclaw', 'memory', 'status', '--deep', '--agent', agent.slug], 180_000);
  const found = s.out.includes(file);
  const ready = /embeddings:\s*ready/i.test(st.out);
  return { ok: found && ready, detail: found && ready ? '' : `${s.out.slice(-300)} | ${st.out.slice(-200)}` };
}

/** The `hatchabot` CLI, as a person runs it. */
export function hbt(args, timeoutMs = 20 * 60_000) {
  const r = spawnSync(process.env.HATCHABOT_CLI || 'hbt', args, { encoding: 'utf8', timeout: timeoutMs, input: '' });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// ---- the report ---------------------------------------------------------------
export const results = [];
export async function scenario(name, fn) {
  log(`▶ ${name}`);
  const t0 = Date.now();
  try {
    const checks = await fn();
    const bad = checks.filter(([, ok]) => !ok);
    results.push({ name, ok: !bad.length, secs: Math.round((Date.now() - t0) / 1000) });
    for (const [what, ok, detail] of checks) log(`   ${ok ? '✓' : '✗'} ${what}${!ok && detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, secs: Math.round((Date.now() - t0) / 1000) });
    log(`   ✗ ${err.message || err}`);
  }
}
export function summary() {
  console.log('\nSummary');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${r.secs}s)`);
  return results.length > 0 && results.every((r) => r.ok);
}
/** Delete every agent whose name starts with `prefix` (the test's own). */
export async function cleanupAgents(prefix) {
  const all = (await api('/v1/agents')).json;
  for (const a of (Array.isArray(all) ? all : []).filter((x) => x.name?.startsWith(prefix))) {
    const r = await api(`/v1/agents/${a.id}`, { method: 'DELETE' }).catch((e) => ({ status: String(e) }));
    log(`cleanup: deleted ${a.name} (${r.status})`);
  }
}
