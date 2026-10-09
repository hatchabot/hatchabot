#!/usr/bin/env node
/**
 * The live tests: what each one proves, what it needs, when it is due, and a
 * record of every run (docs/live-test-runs.md). The unit suite fakes Docker,
 * OpenClaw and the machines; these do not. Release, let the main machine
 * deploy it, run what is due, then promote (scripts/promote.sh refuses while
 * anything is due). docs/live-tests.md explains each one.
 *
 *   node scripts/live.mjs list
 *   node scripts/live.mjs due [<tag>]               what is due for that release (default: what the live install runs)
 *   node scripts/live.mjs run <name> [--note <text>] [-- <the test's own arguments>]
 *   node scripts/live.mjs gate <tag>                exit 1 when anything is due (promote.sh)
 *
 * A test is due for a release when it has never passed, or when a file in its
 * area changed between the release it last passed on and that one.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RECORD = join(ROOT, 'docs', 'live-test-runs.md');

/**
 * Every live test. `against`: what the release under test is — the live
 * install (`install`: the version it reports) or this checkout (`checkout`).
 * `area`: git pathspecs whose change makes it due again, or `{ path, near }`
 * for a big file most releases touch (routes.ts, cli.ts, store.ts): there a
 * change counts only when a changed line, or the route or command it sits in
 * (the `app.get(…)` / `case '…'` line above it), matches `near` (`touches`).
 */
const ROUTES = 'src/api/routes.ts';
const CLI = 'src/cli.ts';
const STORE = 'src/store/store.ts';
const LIB = 'scripts/live-lib.mjs';
export const LIVE_TESTS = [
  {
    name: 'runner-scenarios', cmd: ['node', 'scripts/runner-scenarios.mjs'], against: 'install', minutes: '20–40', aiTurns: false,
    needs: 'a runner (Settings → Hosts); pass -- --runner "<name>", and --old-image <a pre-2026.8 image on it> once it is current',
    proves: 'moves and rebuilds between this machine and a runner across OpenClaw versions; each machine\'s memory search; Install image',
    area: ['src/orchestrator/moveHost.ts', 'src/orchestrator/transfer.ts', 'src/orchestrator/runnerSetup.ts', 'src/orchestrator/provision.ts', 'src/embedder', 'src/providers', 'src/openclaw/configWriter.ts', 'scripts/runner-scenarios.mjs',
      { path: ROUTES, near: /'\/v1\/(hosts|embedder|embed-)|'\/v1\/agents\/:id\/(move-host|rebuild|events)'/ }, { path: STORE, near: /host|embed/i }],
  },
  {
    name: 'transfer', cmd: ['node', 'scripts/transfer-scenarios.mjs'], against: 'install', minutes: '10–15', aiTurns: false,
    needs: 'room for 3 agents under the account\'s agent limit; Hatchabot 2.150.0+ (web-only clones)',
    proves: 'clone, a template shared with its memory and imported, and download → delete → restore: each copy runs web-only and still finds its notes by meaning',
    area: ['src/orchestrator/transfer.ts', 'src/orchestrator/template.ts', 'src/orchestrator/provision.ts', 'scripts/transfer-scenarios.mjs', LIB,
      { path: ROUTES, near: /'\/v1\/agents\/(:id\/)?(clone|export|backup|import|restore)'/ }, { path: CLI, near: /case '(clone|share|export|import|download|backup|restore)'/ }],
  },
  {
    name: 'apps', cmd: ['node', 'scripts/app-scenarios.mjs'], against: 'install', minutes: '10–15', aiTurns: false,
    needs: 'room for 1 agent under the account\'s agent limit',
    proves: 'an app installs into an agent (its tests run there), its scheduled command runs by itself, updates keep its config, a release with failing tests is refused, rollback and stop work',
    area: ['src/orchestrator/apps.ts', 'scripts/app-scenarios.mjs', LIB,
      { path: ROUTES, near: /'\/v1\/(agents\/:id\/app|apps)\b/ }, { path: CLI, near: /case '(app|data)'/ }],
  },
  {
    name: 'console', cmd: ['node', 'scripts/console-scenarios.mjs'], against: 'install', minutes: '2–5', aiTurns: false,
    needs: 'HATCHABOT_PUBLIC_URL (the HTTPS address other devices use); room for 1 agent',
    proves: 'a real browser opens an agent\'s console at the public address: a secure context, its app starts, its live connection to the agent opens and carries messages',
    area: ['src/api/consoleProxy.ts', 'src/api/consoleSockets.ts', 'src/orchestrator/consoleAccess.ts', 'src/openclaw/configWriter.ts', 'scripts/console-scenarios.mjs', LIB],
  },
  {
    name: 'browser', cmd: ['node', 'scripts/browser-scenarios.mjs'], against: 'install', minutes: '8–12', aiTurns: false,
    needs: 'room for 1 agent; internet from the agents',
    proves: 'an agent\'s own browser: off by default, switched on it opens and reads a real page, holds none of the agent\'s files, follows an agent restart, and is removed when switched off',
    area: ['src/orchestrator/browser.ts', 'docker/Dockerfile.browser', 'src/providers/localDockerProvider.ts', 'src/openclaw/configWriter.ts', 'scripts/browser-scenarios.mjs', LIB,
      { path: ROUTES, near: /browser/i }, { path: 'src/orchestrator/provision.ts', near: /browser/i }, { path: CLI, near: /case '(start|stop)'/ }],
  },
  {
    name: 'candidate-gate', cmd: ['bash', 'scripts/candidate-gate.sh'], defaultArgs: ['hatchabot-runtime:latest'], against: 'install', minutes: '5–10', aiTurns: 'one',
    needs: 'the image to check (default: this machine\'s default image)',
    proves: 'an agent on that image builds, answers, and keeps its memory search and tools',
    area: ['docker', 'scripts/build-runtime-image.sh', 'scripts/runtime-pins.mjs', 'scripts/candidate-gate.sh', 'src/openclaw', 'src/orchestrator/provision.ts'],
  },
  {
    name: 'regress-autonomous', cmd: ['bash', 'scripts/regress-autonomous.sh'], against: 'install', minutes: '10–15', aiTurns: 'about eight',
    needs: 'nothing beyond the live install',
    proves: 'an agent made from the CLI answers, remembers, runs a task on demand and on its schedule, pauses, and keeps both across a restart',
    area: ['src/openclaw', 'src/orchestrator/provision.ts', 'src/orchestrator/crons.ts', 'src/orchestrator/cronImport.ts', 'src/cli.ts', 'scripts/regress-autonomous.sh'],
  },
  {
    name: 'restore-drill', cmd: ['bash', 'scripts/restore-drill.sh'], against: 'install', minutes: '5–15', aiTurns: false,
    needs: 'a nightly backup set (newest by default)',
    proves: 'the newest complete backup restores, every part of it, without touching the live system',
    area: ['scripts/backup-volumes.sh', 'scripts/restore-drill.sh', 'src/orchestrator/backups.ts', 'src/orchestrator/transfer.ts'],
  },
  {
    name: 'upgrade-check', cmd: ['bash', 'scripts/upgrade-check.sh'], against: 'checkout', minutes: '2–5', aiTurns: false,
    needs: 'nothing (temporary databases)',
    proves: 'databases made by older releases open with this one',
    area: ['src/store', 'scripts/upgrade-check.sh'],
  },
  {
    name: 'smoke-adopt', cmd: ['bash', 'scripts/smoke.sh'], against: 'checkout', minutes: '5–10', aiTurns: false,
    needs: 'nothing (a throwaway control plane on its own ports); -- --with-telegram also takes over a bot from .env.smoke',
    proves: 'switching to Hatchabot: an OpenClaw agent is found and adopted web-only, its workspace and tasks arrive, its console answers, its data folder mounts',
    area: ['src/orchestrator/adopt.ts', 'src/orchestrator/cronImport.ts', 'scripts/smoke.sh', 'scripts/smoke-adopt-full.ts'],
  },
  {
    name: 'clean-install', cmd: ['bash', 'scripts/clean-install-test.sh'], against: 'checkout', minutes: '20–40', aiTurns: 'one',
    needs: 'LXD on this machine; pass -- --ai-source "<an AI source name>"; stop the VM afterwards',
    proves: 'a stranger\'s install on a brand-new Linux machine, and the first things a new owner does',
    area: ['install.sh', 'scripts/setup-host.sh', 'scripts/install-service.sh', 'scripts/build-bundle.sh', 'scripts/ensure-deps.sh', 'scripts/sqlite-driver.sh', 'scripts/link-cli.sh', 'scripts/first-run-link.sh', 'scripts/clean-install-test.sh', 'package.json', 'package-lock.json'],
  },
  {
    name: 'clean-install-ubuntu-2204', cmd: ['bash', 'scripts/clean-install-test.sh'], args: ['--image', 'ubuntu:22.04'], against: 'checkout', minutes: '20–40', aiTurns: 'one',
    needs: 'as clean-install; the oldest glibc the bundle supports (2.35)',
    proves: 'the clean install on Ubuntu 22.04 (a glibc bug broke stable there once)',
    area: ['install.sh', 'scripts/setup-host.sh', 'scripts/install-service.sh', 'scripts/build-bundle.sh', 'scripts/ensure-deps.sh', 'scripts/sqlite-driver.sh', 'scripts/link-cli.sh', 'scripts/first-run-link.sh', 'scripts/clean-install-test.sh', 'package.json', 'package-lock.json'],
  },
  {
    name: 'clean-install-debian-12', cmd: ['bash', 'scripts/clean-install-test.sh'], args: ['--image', 'images:debian/12/cloud'], against: 'checkout', minutes: '20–40', aiTurns: 'one',
    // LXD's image server has Debian 12 VM images for x86 only (2026-10-08).
    arch: 'x64',
    needs: 'as clean-install, on an x86 machine (there is no arm64 Debian 12 VM image)',
    proves: 'the clean install on Debian 12',
    area: ['install.sh', 'scripts/setup-host.sh', 'scripts/install-service.sh', 'scripts/build-bundle.sh', 'scripts/ensure-deps.sh', 'scripts/sqlite-driver.sh', 'scripts/link-cli.sh', 'scripts/first-run-link.sh', 'scripts/clean-install-test.sh', 'package.json', 'package-lock.json'],
  },
  {
    name: 'shared-host', cmd: ['bash', 'scripts/shared-host-test.sh'], against: 'checkout', minutes: '30+', aiTurns: false,
    needs: 'test VMs; only for Hatchabot Cloud', onHold: 'Hatchabot Cloud is on hold',
    proves: 'two tenants on one machine cannot reach each other',
    area: ['scripts/shared-host-test.sh'],
  },
];

// ---- the record ----------------------------------------------------------------
/** Rows of docs/live-test-runs.md: | date | test | pass/fail/skip | release | minutes | note | */
export function readRuns(text) {
  const runs = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([a-z0-9-]+)\s*\|\s*(pass|fail|skip)\s*\|\s*(v[0-9][^\s|]*)\s*\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (m) runs.push({ date: m[1], test: m[2], result: m[3], release: m[4], minutes: Number(m[5]), note: m[6] });
  }
  return runs;
}
const gitIn = (cwd) => (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const git = gitIn(ROOT);
const tagExists = (t, g = git) => g('rev-parse', '-q', '--verify', `refs/tags/${t}`).status === 0;

/**
 * package.json and its lock change on every release (the version bump): that
 * alone changes nothing a test proves, or the clean install would be due on
 * every release (2026-10-08). Their other changes (dependencies) still count.
 */
function versionOnly(git, a, b, file) {
  if (!/(^|\/)package(-lock)?\.json$/.test(file)) return false;
  const lines = git('diff', '-U0', a, b, '--', file).stdout.split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  return lines.length > 0 && lines.every((l) => /^[+-]\s*"version":\s*"[^"]*",?\s*$/.test(l));
}

/** The line a route or a CLI command starts on, or a function or method. */
const ANCHOR = /^\s*(?:app\.(?:get|post|put|patch|delete|all)\b|case\s+'[^']*'\s*:)|^ {2}[A-Za-z_$][\w$]*\([^)]*\)[^;=]*\{\s*$|^(?:export\s+)?(?:async\s+)?function\b/;

/**
 * Did `file` change between a and b in what `near` names? A changed line
 * that matches, or the route, command or function a change sits in (its
 * anchor line above, the `case` lines falling into it and the two lines
 * after, where a route's path often is). routes.ts changes in nearly every
 * release, so naming it whole made every live test due every time; naming
 * nothing missed its routes (review, 2026-10-09).
 */
export function touches(git, a, b, file, near) {
  const diff = git('diff', '-U0', a, b, '--', file).stdout;
  if (!diff.trim()) return false;
  const show = (rev) => { const r = git('show', `${rev}:${file}`); return r.status === 0 ? r.stdout.split('\n') : []; };
  const before = show(a), after = show(b);
  const around = (lines, n) => {
    let i = Math.min(Math.max(n, 1), lines.length) - 1;
    while (i >= 0 && !ANCHOR.test(lines[i])) i--;
    if (i < 0) return '';
    let s = i;
    while (s > 0 && /^\s*case\s+'[^']*'\s*:/.test(lines[s - 1])) s--;
    return lines.slice(s, i + 3).join('\n');
  };
  for (const line of diff.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) { if (near.test(around(before, Number(h[1]))) || near.test(around(after, Number(h[2])))) return true; continue; }
    if (/^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line) && near.test(line.slice(1))) return true;
  }
  return false;
}

/**
 * What is due for `tag`, and why (`cwd`: the repository, `arch`: this
 * machine's, both for tests). A test this machine cannot run (`arch`) is
 * still due when it would be; it is marked `manual`, to be run on a machine
 * that can — it was left out without a word before (review, 2026-10-09).
 */
export function dueFor(tag, runs, tests = LIVE_TESTS, cwd = ROOT, arch = process.arch) {
  const git = gitIn(cwd);
  const tagExists = (t) => git('rev-parse', '-q', '--verify', `refs/tags/${t}`).status === 0;
  /** Is release a at or before release b (in history)? */
  const atOrBefore = (a, b) => a === b || git('merge-base', '--is-ancestor', a, b).status === 0;
  const out = [];
  for (const t of tests) {
    if (t.onHold) continue;
    const manual = t.arch && t.arch !== arch ? { manual: `runs on an ${t.arch} machine, not this one (${arch})` } : {};
    const passes = runs.filter((r) => r.test === t.name && r.result === 'pass' && tagExists(r.release) && atOrBefore(r.release, tag));
    if (!passes.length) { out.push({ test: t.name, why: 'it has never passed (on this release or an earlier one)', ...manual }); continue; }
    // The latest pass: the release nearest the one being promoted.
    const last = passes.reduce((a, b) => (atOrBefore(a.release, b.release) ? b : a));
    if (last.release === tag) continue;
    const paths = t.area.filter((x) => typeof x === 'string');
    const changed = paths.length
      ? git('diff', '--name-only', last.release, tag, '--', ...paths).stdout.trim().split('\n').filter(Boolean)
        .filter((f) => !versionOnly(git, last.release, tag, f))
      : [];
    for (const n of t.area.filter((x) => typeof x !== 'string')) {
      if (changed.includes(n.path)) continue;
      if (touches(git, last.release, tag, n.path, n.near)) changed.push(`${n.path} (where it uses it)`);
    }
    if (changed.length) out.push({ test: t.name, why: `${changed.length} file(s) in its area changed since it passed on ${last.release}: ${changed.slice(0, 4).join(', ')}${changed.length > 4 ? ', …' : ''}`, ...manual });
  }
  return out;
}

/**
 * The record as committed (HEAD): what the gate reads. Rows a run appended
 * but nobody committed counted before, so a promote could pass on a record
 * that never reached the repository (review, 2026-10-09).
 */
export function committedRuns(cwd = ROOT) {
  const r = gitIn(cwd)('show', 'HEAD:docs/live-test-runs.md');
  return r.status === 0 ? readRuns(r.stdout) : [];
}

/**
 * A run's result from its exit code and the end of its output. A test that had
 * nothing to test exits 0 and says SKIP: not a pass. Colour codes are
 * stripped first ("\x1b[33mSKIP" hid the word, 2026-10-08).
 */
export function resultOf(code, output) {
  if (code !== 0) return 'fail';
  return /(^|\W)SKIP\b/.test(output.replace(/\x1b\[[0-9;]*m/g, '')) ? 'skip' : 'pass';
}

// ---- the live install --------------------------------------------------------
function loadEnv() {
  const f = join(homedir(), '.config', 'hatchabot', 'env');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
async function installVersion() {
  loadEnv();
  const base = (process.env.HATCHABOT_URL || 'http://localhost:8080').replace(/\/$/, '');
  try {
    const r = await fetch(`${base}/v1/diagnostics`, { headers: { authorization: `Bearer ${process.env.HATCHABOT_TOKEN || ''}` }, signal: AbortSignal.timeout(10_000) });
    const j = await r.json();
    return { version: j.version, openclaw: j.openclaw };
  } catch { return {}; }
}
function checkoutVersion() {
  const exact = git('describe', '--tags', '--exact-match').stdout.trim();
  if (exact) return exact;
  return `v${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`;
}

// ---- the commands --------------------------------------------------------------
async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const runs = existsSync(RECORD) ? readRuns(readFileSync(RECORD, 'utf8')) : [];
  if (cmd === 'list' || !cmd) {
    for (const t of LIVE_TESTS) {
      const last = runs.filter((r) => r.test === t.name).at(-1);
      const where = t.arch && t.arch !== process.arch ? ` (runs on an ${t.arch} machine, not this one)` : '';
      console.log(`${t.name.padEnd(20)} ${t.onHold ? `(on hold: ${t.onHold})` : last ? `last ${last.result} on ${last.release}, ${last.date}` : 'never recorded'}${where}`);
      console.log(`${''.padEnd(20)} ${t.proves}. ${t.minutes} min; AI turns: ${t.aiTurns || 'none'}. Needs: ${t.needs}.`);
    }
    return;
  }
  if (cmd === 'due' || cmd === 'gate') {
    const tag = rest[0] || (cmd === 'due' ? (await installVersion()).version : undefined);
    if (!tag) { console.error(`usage: live.mjs ${cmd} <tag>`); process.exit(2); }
    if (!tagExists(tag)) { console.error(`No tag ${tag} here (git fetch --tags).`); process.exit(2); }
    // The gate goes by the committed record only; `due` says what is not committed yet.
    const committed = committedRuns();
    const all = dueFor(tag, cmd === 'gate' ? committed : runs);
    if (cmd === 'due' && runs.length > committed.length) console.log(`(${runs.length - committed.length} run(s) in docs/live-test-runs.md are not committed yet — the gate counts only committed ones.)`);
    const due = all.filter((d) => !d.manual), manual = all.filter((d) => d.manual);
    if (manual.length) {
      console.log(`Due for ${tag} but not on this machine — run each where it can run, and commit the record:`);
      for (const d of manual) console.log(`  ${d.test.padEnd(20)} ${d.manual}; ${d.why}`);
    }
    if (!due.length) { console.log(`✓ No live test${manual.length ? ' this machine can run' : ''} is due for ${tag}.`); return; }
    console.log(`${due.length} live test(s) due for ${tag}:`);
    for (const d of due) console.log(`  ${d.test.padEnd(20)} ${d.why}`);
    console.log('Run each with: node scripts/live.mjs run <name> [-- its arguments]  (docs/live-tests.md)');
    if (cmd === 'gate') process.exit(1);
    return;
  }
  if (cmd === 'run') {
    const name = rest[0];
    const t = LIVE_TESTS.find((x) => x.name === name);
    if (!t) { console.error(`No live test "${name}". node scripts/live.mjs list`); process.exit(2); }
    const dash = rest.indexOf('--');
    const own = dash >= 0 ? rest.slice(dash + 1) : (t.defaultArgs ?? []);
    const before = dash >= 0 ? rest.slice(1, dash) : rest.slice(1);
    const ni = before.indexOf('--note');
    const note = ni >= 0 ? String(before[ni + 1] ?? '').replace(/\|/g, '/') : '';
    const release = t.against === 'install' ? (await installVersion()) : { version: checkoutVersion() };
    if (!release.version) { console.error('Could not ask the live install for its version (HATCHABOT_URL / HATCHABOT_TOKEN).'); process.exit(2); }
    const argv = [...t.cmd, ...(t.args ?? []), ...own];
    console.log(`▶ ${t.name} on ${release.version}${release.openclaw ? ` (OpenClaw ${release.openclaw})` : ''}: ${argv.join(' ')}`);
    const t0 = Date.now();
    let tail = '';
    const code = await new Promise((resolve) => {
      const child = spawn(argv[0], argv.slice(1), { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'] });
      const keep = (c) => { tail = (tail + c).slice(-20_000); };
      child.stdout.on('data', (c) => { process.stdout.write(c); keep(String(c)); });
      child.stderr.on('data', (c) => { process.stderr.write(c); keep(String(c)); });
      child.on('close', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(127));
    });
    const minutes = Math.max(1, Math.round((Date.now() - t0) / 60_000));
    // A test that had nothing to test (no token, no runner) says SKIP: that is not a pass.
    const result = resultOf(code, tail);
    const row = `| ${new Date().toISOString().slice(0, 10)} | ${t.name} | ${result} | ${release.version} | ${minutes} | ${[release.openclaw ? `OpenClaw ${release.openclaw}` : '', note].filter(Boolean).join('; ')} |\n`;
    appendFileSync(RECORD, row);
    console.log(`\n${result === 'pass' ? '✓' : result === 'skip' ? '–' : '✗'} ${t.name}: ${result} (${minutes} min). Recorded in docs/live-test-runs.md — commit it.`);
    process.exit(code === 0 ? 0 : 1);
  }
  console.error('usage: live.mjs list | due [<tag>] | run <name> [--note <text>] [-- args] | gate <tag>');
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
