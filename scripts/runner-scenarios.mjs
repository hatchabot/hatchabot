#!/usr/bin/env node
/**
 * Real moves between this machine and a runner, end to end, against a live
 * install (not part of `npm test`: it creates agents, copies images and takes
 * many minutes). Each scenario is checked the way a person would notice it:
 * the agent runs, on the OpenClaw it should, and a memory note written before
 * the move is still found by MEANING afterwards (`openclaw memory search` with
 * a query that shares no words with the note, so only embeddings can find
 * it). No AI turns are used.
 *
 *   node scripts/runner-scenarios.mjs --runner "<name or id>" [--keep] [--no-image]
 *                                     [--old-image <an image on the runner older than 2026.8>]
 *
 * Phase A runs only while the runner's image is older than 2026.8 (the
 * cases a laptop left on an old image meets): a current agent may not move
 * there, and an old agent moves here and is migrated. Then the runner gets
 * this machine's image (Install image), unless --no-image. Phase B: an old
 * agent rebuilt in place on the runner, a current agent moved there and back,
 * each machine's door holding only its own agents' keys, and a plain rebuild
 * that does not re-index.
 *
 * --old-image runs phase A on a runner already on the current image: for
 * those few minutes the runner's default (hatchabot-runtime:latest) points at
 * the old image, and it is pointed back afterwards (always, even on failure).
 * Running containers are not affected by a tag moving.
 *
 * It touches only agents it creates ("zz runner test …"), and deletes them at
 * the end unless --keep. Reads HATCHABOT_URL / HATCHABOT_TOKEN from the
 * environment (as `hatchabot` does: ~/.config/hatchabot/env).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };

const envFile = join(homedir(), '.config', 'hatchabot', 'env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
const BASE = (process.env.HATCHABOT_URL || 'http://localhost:8080').replace(/\/$/, '');
const TOKEN = process.env.HATCHABOT_TOKEN || '';
const PREFIX = 'zz runner test';

// ---- the API -----------------------------------------------------------------
async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  let payload;
  if (raw) { headers['content-type'] = 'application/octet-stream'; payload = raw; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(30 * 60_000) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { text }; }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Until the agent settles in `want` (not busy); FAILED or the deadline throws. */
async function settle(id, want = 'RUNNING', minutes = 20) {
  const deadline = Date.now() + minutes * 60_000;
  let last;
  while (Date.now() < deadline) {
    const r = await api(`/v1/agents/${id}`);
    last = r.json;
    if (last.state === want && !last.busy) return last;
    if (last.state === 'FAILED') throw new Error(`FAILED: ${last.stateReason ?? 'no reason'}`);
    await sleep(5000);
  }
  throw new Error(`still ${last?.state}${last?.busy ? ' (busy)' : ''} after ${minutes} min`);
}

// ---- the machines ------------------------------------------------------------
let hosts = [];
const conn = (hostId) => {
  const h = hosts.find((x) => x.id === hostId);
  return h && h.kind !== 'local' && h.settings?.dockerHost ? ['-H', h.settings.dockerHost] : [];
};
function docker(hostId, argv, timeoutMs = 10 * 60_000) {
  const r = spawnSync('docker', [...conn(hostId), ...argv], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function inAgent(agent, argv, timeoutMs) {
  const name = String(agent.runtimeRef || '').replace(/^docker:\/\//, '');
  return docker(agent.hostId, ['exec', name, ...argv], timeoutMs);
}
const versionOf = (agent) => (/(\d{4}\.\d+\.\d+(?:-\d+)?)/.exec(inAgent(agent, ['openclaw', '--version'], 120_000).out) || [])[1];
const below2026_8 = (v) => { const m = /^(\d+)\.(\d+)/.exec(v || ''); return !!m && (Number(m[1]) < 2026 || (Number(m[1]) === 2026 && Number(m[2]) < 8)); };

// ---- memory notes: written before, found by meaning after ----------------------
// Made-up facts; each query shares no word with its note.
const NOTES = {
  1: { text: 'Marguerite paints watercolours of herons every Sunday morning.', query: 'which bird does the artist depict on weekends' },
  2: { text: 'The allotment shed key hangs behind the blue enamel teapot.', query: 'where is the garden hut opened from' },
  3: { text: 'Our quarterly bonfire night moved from November to late March.', query: 'when is the fire celebration held now' },
};
async function writeNote(agent, n) {
  const dir = `.openclaw/agents/${agent.slug}/agent/memory`;
  inAgent(agent, ['mkdir', '-p', `/home/node/${dir}`], 60_000); // a new agent has no memory/ folder yet
  const r = await api(`/v1/agents/${agent.id}/fs/file?path=${encodeURIComponent(dir)}&name=zz-test-note-${n}.md&overwrite=1`, { method: 'PUT', raw: Buffer.from(`# Test note\n\n${NOTES[n].text}\n`) });
  if (r.status !== 200) throw new Error(`note upload: ${r.status} ${JSON.stringify(r.json)}`);
}
/** The note is found by a query with none of its words, and the engine says ready. */
function recalls(agent, n) {
  inAgent(agent, ['openclaw', 'memory', 'index', '--agent', agent.slug], 10 * 60_000);
  const s = inAgent(agent, ['openclaw', 'memory', 'search', '--agent', agent.slug, '--json', '--max-results', '5', '--query', NOTES[n].query], 180_000);
  const found = s.out.includes(`zz-test-note-${n}`);
  const st = inAgent(agent, ['openclaw', 'memory', 'status', '--deep', '--agent', agent.slug], 180_000);
  const ready = /embeddings:\s*ready/i.test(st.out);
  return { ok: found && ready, found, ready, detail: found && ready ? '' : `${s.out.slice(-300)} | ${st.out.slice(-300)}` };
}
const keysOn = (hostId) => {
  if (!conn(hostId).length) {
    try { return Object.values(JSON.parse(readFileSync(join(homedir(), 'hatchabot-data', 'embed', 'keys.json'), 'utf8'))); } catch { return []; }
  }
  const vol = docker(hostId, ['volume', 'ls', '--format', '{{.Name}}']).out.split('\n').find((v) => v.endsWith('-embed-keys'));
  if (!vol) return [];
  const r = docker(hostId, ['run', '--rm', '--network', 'none', '--user', '0', '-v', `${vol}:/v:ro`, '--entrypoint', 'cat', 'hatchabot-runtime:latest', '/v/keys.json']);
  try { return Object.values(JSON.parse(r.out)); } catch { return []; }
};

// ---- results -------------------------------------------------------------------
const results = [];
async function scenario(name, fn) {
  log(`▶ ${name}`);
  const t0 = Date.now();
  try {
    const checks = await fn();
    const bad = checks.filter(([, ok]) => !ok);
    results.push({ name, ok: !bad.length, secs: Math.round((Date.now() - t0) / 1000), checks });
    for (const [what, ok, detail] of checks) log(`   ${ok ? '✓' : '✗'} ${what}${!ok && detail ? ` — ${String(detail).slice(0, 400)}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, secs: Math.round((Date.now() - t0) / 1000), checks: [[String(err.message || err), false]] });
    log(`   ✗ ${err.message || err}`);
  }
}

async function create(name, hostId) {
  const profiles = (await api('/v1/ai-profiles')).json;
  const profile = profiles.find((p) => p.defaultSource) ?? profiles[0];
  const r = await api('/v1/agents', { method: 'POST', body: { name, aiProfileId: profile.id, hostId, telegram: false } });
  if (r.status >= 300) throw new Error(`create ${name}: ${r.status} ${JSON.stringify(r.json)}`);
  return settle(r.json.id, 'RUNNING', 25);
}
const move = (id, hostId) => api(`/v1/agents/${id}/move-host`, { method: 'POST', body: { hostId } });
const rebuild = (id) => api(`/v1/agents/${id}/rebuild`, { method: 'POST', body: {} });
const eventsOf = async (id) => (await api(`/v1/agents/${id}/events?limit=200`)).json;

// ---- the run -------------------------------------------------------------------
const made = [];
/** The runner's default image to point back at, while --old-image borrows the tag. */
let restoreLatest;
function pointBack() {
  if (!restoreLatest) return;
  const r = docker(restoreLatest.hostId, ['tag', restoreLatest.id, 'hatchabot-runtime:latest']);
  log(`${r.code === 0 ? '' : '✗ '}the runner's default image pointed back at ${restoreLatest.id.slice(7, 19)}${r.code === 0 ? '' : `: ${r.out.slice(-200)}`}`);
  if (r.code === 0) restoreLatest = undefined;
}
async function main() {
  if (!TOKEN) throw new Error('No HATCHABOT_TOKEN (see ~/.config/hatchabot/env).');
  hosts = (await api('/v1/hosts')).json;
  const local = hosts.find((h) => h.kind === 'local');
  const want = opt('runner');
  const runner = hosts.find((h) => h.kind !== 'local' && (h.id === want || h.name === want)) ?? (want ? undefined : hosts.find((h) => h.kind !== 'local'));
  if (!local || !runner) throw new Error(`No runner ${want ?? ''} (hosts: ${hosts.map((h) => h.name).join(', ')})`);
  const existing = (await api('/v1/agents')).json.filter((a) => a.name?.startsWith(PREFIX));
  if (existing.length) throw new Error(`Test agents from an earlier run are still there: ${existing.map((a) => a.name).join(', ')} — delete them first.`);
  let ping = (await api(`/v1/hosts/${runner.id}/ping`)).json;
  if (!ping.reachable) throw new Error(`${runner.name} is not answering: ${ping.error ?? ''}`);
  const old = opt('old-image');
  if (old && !(ping.hasImage && below2026_8(ping.imageVersion))) {
    const cur = docker(runner.id, ['image', 'inspect', 'hatchabot-runtime:latest', '--format', '{{.Id}}']);
    const oldId = docker(runner.id, ['image', 'inspect', old, '--format', '{{.Id}}']);
    if (cur.code !== 0 || oldId.code !== 0) throw new Error(`--old-image: ${cur.code ? 'the runner has no default image' : `the runner has no ${old}`}`);
    restoreLatest = { hostId: runner.id, id: cur.out.trim() };
    docker(runner.id, ['tag', old, 'hatchabot-runtime:latest']);
    log(`for phase A, ${runner.name}'s default image points at ${old} (it will be pointed back)`);
    ping = (await api(`/v1/hosts/${runner.id}/ping`)).json;
  }
  log(`${runner.name}: ${ping.hasImage ? `OpenClaw ${ping.imageVersion} (this machine: ${ping.currentVersion})` : 'no runtime image (hatchabot-runtime:latest)'}`);

  const T = {};
  // ---- Phase A: the runner on an image older than 2026.8 ----------------------
  if (ping.hasImage && below2026_8(ping.imageVersion)) {
    await scenario('A0 set up: two agents on the runner\'s old image, one here', async () => {
      T.old1 = await create(`${PREFIX} old one`, runner.id); made.push(T.old1.id);
      T.old2 = await create(`${PREFIX} old two`, runner.id); made.push(T.old2.id);
      T.cur = await create(`${PREFIX} current`, local.id); made.push(T.cur.id);
      await writeNote(T.old1, 1); await writeNote(T.old2, 2); await writeNote(T.cur, 3);
      const r1 = recalls(T.old1, 1), r3 = recalls(T.cur, 3);
      return [
        [`old one runs ${versionOf(T.old1)} on ${runner.name}`, below2026_8(versionOf(T.old1))],
        ['old one recalls its note (its own engine)', r1.ok, r1.detail],
        [`current runs ${versionOf(T.cur)} here`, !below2026_8(versionOf(T.cur))],
        ['current recalls its note (this machine\'s service)', r3.ok, r3.detail],
      ];
    });
    await scenario('A1 a current agent may not move onto the old image (it could not read its data)', async () => {
      const r = await move(T.cur.id, runner.id);
      const after = await settle(T.cur.id, 'RUNNING', 5);
      return [
        [`refused: ${r.status} ${r.json.error ?? ''}`, r.status === 409 && /cannot read its data/.test(r.json.error ?? '')],
        ['still here, running', after.hostId === local.id],
      ];
    });
    await scenario('A2 an old agent moves here: migrated to this machine\'s OpenClaw, memory kept and searchable', async () => {
      const r = await move(T.old1.id, local.id);
      if (r.status !== 200) return [[`move: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`, false]];
      T.old1 = await settle(T.old1.id, 'RUNNING', 30);
      const v = versionOf(T.old1), rc = recalls(T.old1, 1);
      return [
        ['now here', T.old1.hostId === local.id],
        [`runs ${v}`, v === ping.currentVersion],
        ['recalls the note written on the runner', rc.ok, rc.detail],
        ['this machine\'s door holds its key', keysOn(local.id).includes(T.old1.id)],
      ];
    });
  } else {
    log(`(phase A skipped: ${runner.name} is not on an image older than 2026.8)`);
  }

  // ---- the runner gets this machine's image -----------------------------------
  if (restoreLatest) pointBack();
  else if (!flag('no-image') && (!ping.hasImage || ping.imageVersion !== ping.currentVersion)) {
    await scenario(`I  ${runner.name} gets this machine's image (Install image)`, async () => {
      // The copy runs on the server; it is followed, not waited on (a request held
      // open for many minutes is dropped while the copy goes on).
      const r = await api(`/v1/hosts/${runner.id}/install-image`, { method: 'POST', body: {} });
      if (r.status !== 202) return [[`install: ${r.status} ${r.json.error ?? ''}`, false]];
      let j = r.json, lastLog = 0;
      while (!j.done) {
        await sleep(10_000);
        j = (await api(`/v1/hosts/${runner.id}/install-image`)).json;
        if (Date.now() - lastLog > 60_000) { lastLog = Date.now(); log(`   copying… ${(j.bytes / 1e9).toFixed(2)}${j.total ? ` of ${(j.total / 1e9).toFixed(2)}` : ''} GB`); }
      }
      const mins = Math.round((Date.parse(j.finishedAt) - Date.parse(j.startedAt)) / 60_000);
      const p = (await api(`/v1/hosts/${runner.id}/ping`)).json;
      return [[`copied in ${mins} min${j.ok ? '' : `: ${j.error}`}`, !!j.ok], [`runner now on ${p.imageVersion}`, p.imageVersion === p.currentVersion]];
    });
  }

  // ---- Phase B: the runner on the current image -------------------------------
  const now = (await api(`/v1/hosts/${runner.id}/ping`)).json;
  if (!now.hasImage || now.imageVersion !== now.currentVersion) {
    log(`(phase B skipped: ${runner.name} is on ${now.imageVersion ?? 'no image'}, this machine on ${now.currentVersion})`);
    return;
  }
  if (T.old2) {
    await scenario('B1 an old agent rebuilt in place on the runner (the path a runner agent takes to the new OpenClaw)', async () => {
      const r = await rebuild(T.old2.id);
      if (r.status >= 300) return [[`rebuild: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`, false]];
      await sleep(5000);
      T.old2 = await settle(T.old2.id, 'RUNNING', 30);
      const v = versionOf(T.old2), rc = recalls(T.old2, 2);
      const svc = (await api(`/v1/embedder?host=${runner.id}`)).json;
      return [
        [`runs ${v}`, !below2026_8(v)],
        [`the runner's memory search is ${svc.enabled ? 'on' : 'off'}, engine ${svc.embedder}, door ${svc.door}`, svc.enabled && svc.embedder === 'running' && svc.door === 'running'],
        ['recalls its note through the runner\'s own service', rc.ok, rc.detail],
        ['the runner\'s door holds its key', keysOn(runner.id).includes(T.old2.id)],
        ['this machine\'s door does not', !keysOn(local.id).includes(T.old2.id)],
      ];
    });
  }
  if (!T.cur) { T.cur = await create(`${PREFIX} current`, local.id); made.push(T.cur.id); await writeNote(T.cur, 3); }
  const reindexes = async (id) => JSON.stringify(await eventsOf(id)).split('"memory.reindex"').length - 1;
  await scenario('B2 a current agent moves to the runner: built on the runner\'s service, re-indexed there', async () => {
    const before = await reindexes(T.cur.id);
    const r = await move(T.cur.id, runner.id);
    if (r.status !== 200) return [[`move: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`, false]];
    T.cur = await settle(T.cur.id, 'RUNNING', 30);
    const rc = recalls(T.cur, 3);
    const reindexed = (await reindexes(T.cur.id)) > before;
    return [
      ['now on the runner', T.cur.hostId === runner.id],
      ['recalls its note there', rc.ok, rc.detail],
      ['re-indexed on the move', reindexed],
      ['the runner\'s door holds its key', keysOn(runner.id).includes(T.cur.id)],
      ['this machine\'s door forgot it', !keysOn(local.id).includes(T.cur.id)],
    ];
  });
  await scenario('B3 and back here: this machine\'s service again, the runner forgets it', async () => {
    const r = await move(T.cur.id, local.id);
    if (r.status !== 200) return [[`move: ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`, false]];
    T.cur = await settle(T.cur.id, 'RUNNING', 30);
    const rc = recalls(T.cur, 3);
    return [
      ['back here', T.cur.hostId === local.id],
      ['recalls its note', rc.ok, rc.detail],
      ['this machine\'s door holds its key', keysOn(local.id).includes(T.cur.id)],
      ['the runner\'s door forgot it', !keysOn(runner.id).includes(T.cur.id)],
    ];
  });
  if (T.old2) {
    await scenario('B4 a plain rebuild on the runner keeps its index (no re-index)', async () => {
      const before = await reindexes(T.old2.id);
      const r = await rebuild(T.old2.id);
      if (r.status >= 300) return [[`rebuild: ${r.status}`, false]];
      await sleep(5000);
      T.old2 = await settle(T.old2.id, 'RUNNING', 20);
      const after = await reindexes(T.old2.id);
      const rc = recalls(T.old2, 2);
      return [['no re-index', after === before], ['still recalls its note', rc.ok, rc.detail]];
    });
  }
  const dry = spawnSync('hbt', ['rebuild', '--outdated', '--dry-run'], { encoding: 'utf8' });
  log(`outdated agents now: ${(dry.stdout || dry.stderr).trim().split('\n').join(' | ')}`);
}

main()
  .catch((err) => { results.push({ name: 'run', ok: false, checks: [[String(err.message || err), false]] }); log(`✗ ${err.message || err}`); })
  .finally(async () => {
    pointBack();
    if (!flag('keep')) {
      for (const id of made) {
        const r = await api(`/v1/agents/${id}`, { method: 'DELETE' }).catch((e) => ({ status: String(e) }));
        log(`cleanup: deleted ${id.slice(0, 8)} (${r.status})`);
      }
    }
    console.log('\nSummary');
    for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.secs !== undefined ? `  (${r.secs}s)` : ''}`);
    process.exitCode = results.every((r) => r.ok) ? 0 : 1;
  });
