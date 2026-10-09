#!/usr/bin/env node
/**
 * The privacy check: nothing that leaves this machine for the public repo may
 * name this household's private values — its agents' names and slugs, its
 * people's names, ids and emails, its bots, its machines and tailnet, the
 * secrets in its .env. A pattern scanner cannot know those ("Girlfriend
 * Advisor" is just words); this reads them from the live install each time
 * it runs, keeps them in memory only, and prints a hit masked
 * ("[agent name] 'Gi…(18)' CHANGELOG.md:812"). The script itself holds
 * nothing private. Written after the 2026-10-09 review found real agent names
 * in docs, tests and release notes, and the pre-1.0 history on GitHub through
 * 212 v0.* tags pushed with `--tags` (docs/releasing.md).
 *
 *   node scripts/privacy-check.mjs --install-hook     # this clone's pre-push hook (once)
 *   node scripts/privacy-check.mjs --pre-push <remote> <url>   # the hook: stdin is git's pre-push lines
 *   node scripts/privacy-check.mjs --text <file>...   # e.g. release notes, before `gh release create`
 *   node scripts/privacy-check.mjs --public           # everything GitHub serves (the `privacy` live test)
 *
 * Options: --db <hatchabot.sqlite>, --env <file> (repeatable), --no-machine
 * (skip this machine's host, tailnet and IP values; for tests).
 * Generic words that happen to be agent names ("Test", "Laptop runner") are
 * in scripts/privacy-ignore.txt. Exit 0: clean; 1: found something; 2: could
 * not run (no install to read). The hook lets a push through, with a warning,
 * on a machine with no install: the live test covers what it cannot see.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, hostname, networkInterfaces, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const opts = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const has = (name) => args.includes(name);

// ---- what is private --------------------------------------------------------
/** "KEY=value" lines of an env file. */
function envOf(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}
const DEFAULT_ENVS = [join(homedir(), 'hatchabot-prod', '.env'), join(homedir(), 'hatchabot', '.env'), join(homedir(), '.config', 'hatchabot', 'env')];
function defaultDb(envFiles) {
  if (process.env.HATCHABOT_DB) return process.env.HATCHABOT_DB;
  for (const f of envFiles) { const e = envOf(f); if (e.HATCHABOT_DB) return e.HATCHABOT_DB.replace(/^~(?=\/)/, homedir()); }
  return [join(homedir(), 'hatchabot-data', 'hatchabot.sqlite'), join(homedir(), 'hatchabot', 'data', 'hatchabot.sqlite')].find(existsSync);
}

/**
 * value → { cat, secret }. Names keep their case: a real name is matched as
 * written ("Condo B" is not "condo board"); slugs, emails and machine names
 * match in any case.
 */
export function privateValues({ db, envFiles, machine = true }) {
  const v = new Map();
  const add = (value, cat, { secret = false, min = 4 } = {}) => {
    if (value === null || value === undefined) return;
    const s = String(value).trim();
    if (s.length < min || /^\d{1,5}$/.test(s)) return;
    if (!v.has(s)) v.set(s, { cat, secret });
  };
  if (!db || !existsSync(db)) return null;
  const Database = createRequire(join(ROOT, 'package.json'))('better-sqlite3');
  const d = new Database(db, { readonly: true, fileMustExist: true });
  const rows = (sql) => { try { return d.prepare(sql).all(); } catch { return []; } };
  for (const r of rows('select name, slug from agents')) { add(r.name, 'agent name'); add(r.slug, 'agent slug', { min: 5 }); }
  for (const r of rows('select agent_name, from_email, to_email from agent_shares')) { add(r.agent_name, 'agent name'); add(r.from_email, 'email'); add(r.to_email, 'email'); }
  for (const r of rows('select email, telegram_user_id from accounts')) { add(r.email, 'email'); add(r.telegram_user_id, 'person id', { min: 6 }); }
  for (const r of rows('select email from connections')) add(r.email, 'email');
  for (const r of rows('select username, display_name from local_accounts')) { add(r.username, 'person name', { min: 4 }); add(r.display_name, 'person name'); }
  for (const r of rows('select channel_user_id, display_name from memberships')) { add(r.channel_user_id, 'person id', { min: 6 }); add(r.display_name, 'person name'); }
  for (const r of rows('select channel_user_id from member_identities')) add(r.channel_user_id, 'person id', { min: 6 });
  for (const r of rows('select expect_handle from invites')) add(r.expect_handle, 'person name', { min: 4 });
  for (const r of rows('select username, desired_name from telegram_pool')) { add(r.username, 'bot', { min: 5 }); add(r.desired_name, 'bot', { min: 6 }); }
  for (const r of rows('select bot_user_id, bot_name from discord_bots')) { add(r.bot_user_id, 'bot', { min: 8 }); add(r.bot_name, 'bot', { min: 6 }); }
  for (const r of rows('select name, settings from hosts')) {
    add(r.name, 'machine', { min: 5 });
    try { for (const s of Object.values(JSON.parse(r.settings || '{}'))) if (typeof s === 'string' && /ssh:\/\/|tcp:\/\/|\.ts\.net|\d+\.\d+\.\d+\.\d+/.test(s)) add(s.replace(/^\w+:\/\//, '').replace(/^[^@]*@/, '').replace(/[:/].*$/, ''), 'machine', { min: 6 }); } catch { /* not JSON */ }
  }
  for (const r of rows('select name from peers')) add(r.name, 'machine', { min: 5 });
  for (const r of rows('select host_path from data_sources')) add(r.host_path, 'path', { min: 8 });
  d.close();
  for (const f of envFiles) {
    for (const [k, val] of Object.entries(envOf(f))) {
      if (/KEY|SECRET|TOKEN|PASSWORD|PASSWD|COOKIE|CLIENT_ID/.test(k) && val.length >= 8 && !/^(true|false|\d+|\/[\w./-]*)$/.test(val)) add(val, 'secret', { secret: true, min: 8 });
      else if (/EMAIL|ALLOWED|OWNER/.test(k)) for (const p of val.split(/[,\s]+/)) if (p.includes('@')) add(p, 'email');
      else if (/PUBLIC_URL|DOMAIN|HOSTNAME/.test(k)) { const h = val.replace(/^\w+:\/\//, '').replace(/[:/].*$/, ''); add(h, 'machine', { min: 6 }); const t = /([a-z0-9-]+\.ts\.net)$/.exec(h.split('.').slice(1).join('.')); if (t) add(t[1], 'tailnet'); }
    }
  }
  if (machine) {
    add(hostname(), 'machine', { min: 4 });
    add(userInfo().username, 'person name', { min: 5 });
    add(homedir(), 'path', { min: 8 });
    for (const [name, list] of Object.entries(networkInterfaces())) {
      if (/^(lo|docker|br-|veth|lxdbr|virbr|tailscale|utun)/.test(name)) continue;
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal) add(a.address, 'ip', { min: 7 });
    }
    const ts = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 10_000 });
    if (ts.status === 0) {
      try {
        const j = JSON.parse(ts.stdout);
        if (j.MagicDNSSuffix) add(j.MagicDNSSuffix, 'tailnet', { min: 6 });
        for (const p of [j.Self || {}, ...Object.values(j.Peer || {})]) {
          add(p.HostName, 'machine', { min: 5 });
          add((p.DNSName || '').replace(/\.$/, ''), 'machine', { min: 8 });
          for (const ip of p.TailscaleIPs || []) if (ip.includes('.')) add(ip, 'ip', { min: 7 });
        }
      } catch { /* no tailnet */ }
    }
  }
  const ignore = new Set(readFileSync(join(ROOT, 'scripts', 'privacy-ignore.txt'), 'utf8').split('\n')
    .map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean));
  // The live tests' own agents are named "zz … test" (scripts/live-lib.mjs).
  for (const k of [...v.keys()]) if (ignore.has(k.toLowerCase()) || /^zz[ -]/i.test(k)) v.delete(k);
  return v;
}

// ---- matching ------------------------------------------------------------------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** One matcher per value: names as written, the rest in any case; whole words. */
function matchers(values) {
  return [...values].map(([value, meta]) => {
    const named = ['agent name', 'person name', 'bot'].includes(meta.cat) && /[A-Z]/.test(value);
    const caseless = !meta.secret && !named;
    const edge = meta.secret ? '' : '(?<![A-Za-z0-9])';
    const tail = meta.secret ? '' : '(?![A-Za-z0-9])';
    return { value, ...meta, low: value.toLowerCase(), re: new RegExp(edge + esc(value) + tail, caseless ? 'i' : '') };
  });
}
export const mask = (value) => `${value.slice(0, 2)}…(${value.length})`;
/** Hits in one text: { where, line, cat, shown }. */
export function scan(text, where, ms) {
  const low = text.toLowerCase();
  const out = [];
  for (const m of ms) {
    if (!low.includes(m.low)) continue;
    const r = m.re.exec(text);
    if (!r) continue;
    const line = text.slice(0, r.index).split('\n').length;
    out.push({ where, line, cat: m.cat, shown: mask(m.value) });
  }
  return out;
}
const report = (hits, say = console.log) => { for (const h of hits) say(`  [${h.cat}] '${h.shown}' ${h.where}${h.line ? ':' + h.line : ''}`); };

// ---- git helpers ---------------------------------------------------------------
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 1 << 30 });
/** Contents of many objects at once: [{ id, type, data }]. */
function catBatch(cwd, ids) {
  if (!ids.length) return [];
  const buf = execFileSync('git', ['-C', cwd, 'cat-file', '--batch'], { input: ids.join('\n') + '\n', maxBuffer: 1 << 30 });
  const out = [];
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(10, at);
    const [id, type, size] = buf.slice(at, nl).toString().split(' ');
    if (type === 'missing' || !size) { at = nl + 1; continue; }
    const start = nl + 1, n = Number(size);
    out.push({ id, type, data: buf.slice(start, start + n) });
    at = start + n + 1;
  }
  return out;
}
const isText = (b) => !b.subarray(0, 4096).includes(0);

/**
 * The history published before the scrub (2026-10-09): it still names real
 * agents, and the owner chose not to rewrite it. --public checks what came
 * after it, main's files as they are now, and every release note and issue.
 */
export const ACCEPTED_HISTORY = '4dfbb0fe9f4cef05e0d0653fa02af9f0c05390fe';

/** v0.* tags, and tags whose commit is not on main: what --tags once leaked. */
function tagRefusals(cwd, tags, main) {
  const bad = [];
  for (const { name, commit } of tags) {
    if (/^v0\./.test(name)) { bad.push(`${name}: a pre-1.0 tag (that history is private)`); continue; }
    if (main && git(cwd, 'merge-base', '--is-ancestor', commit, main).status !== 0) bad.push(`${name}: its commit is not on main`);
  }
  return bad;
}

// ---- modes ---------------------------------------------------------------------
function load() {
  const envFiles = opts('--env').length ? opts('--env') : DEFAULT_ENVS.filter(existsSync);
  const db = opt('--db') || defaultDb(envFiles);
  const values = privateValues({ db, envFiles, machine: !has('--no-machine') });
  return values && matchers(values);
}

function prePush() {
  const cwd = process.cwd();
  const remote = args[args.indexOf('--pre-push') + 1] || 'origin';
  const lines = readFileSync(0, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 4);
  const zero = /^0+$/;
  const tags = [], commits = new Set(), annotated = [];
  for (const [localRef, localSha, remoteRef] of lines) {
    if (zero.test(localSha)) continue; // a delete
    if (remoteRef.startsWith('refs/tags/')) {
      const commit = git(cwd, 'rev-parse', `${localSha}^{commit}`).stdout.trim();
      tags.push({ name: remoteRef.slice('refs/tags/'.length), commit });
      if (git(cwd, 'cat-file', '-t', localSha).stdout.trim() === 'tag') annotated.push(localSha);
    }
    for (const c of git(cwd, 'rev-list', localSha, '--not', `--remotes=${remote}`).stdout.split('\n').filter(Boolean)) commits.add(c);
  }
  const main = git(cwd, 'rev-parse', '-q', '--verify', 'refs/heads/main').stdout.trim();
  const refused = tagRefusals(cwd, tags, main || undefined);
  if (refused.length) {
    console.error('\n🔒 Privacy check: these tags may not be pushed:');
    for (const r of refused) console.error('  ' + r);
    console.error('Push a release tag by name (git push origin main vX.Y.Z), never --tags. docs/releasing.md\n');
    return 1;
  }
  const ms = load();
  if (!ms) {
    console.error('Privacy check: no Hatchabot install here to read private values from — not checked (the `privacy` live test covers it).');
    return 0;
  }
  const hits = [];
  for (const c of commits) {
    const show = git(cwd, 'show', '--format=%B%x00', '--unified=0', '--no-color', '--no-ext-diff', c).stdout;
    const [msg, diff = ''] = show.split('\0');
    hits.push(...scan(msg, `commit ${c.slice(0, 7)} message`, ms));
    let file = '?', line = 0;
    for (const l of diff.split('\n')) {
      if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
      const h = /^@@ -\S+ \+(\d+)/.exec(l);
      if (h) { line = Number(h[1]); continue; }
      if (l.startsWith('+')) { for (const x of scan(l.slice(1), `${file} (commit ${c.slice(0, 7)})`, ms)) hits.push({ ...x, line }); line++; }
    }
  }
  for (const t of catBatch(cwd, annotated)) hits.push(...scan(t.data.toString(), `tag message ${t.id.slice(0, 7)}`, ms));
  if (!hits.length) return 0;
  console.error(`\n🔒 Privacy check blocked this push: ${hits.length} private value(s) in what it would publish:`);
  report(hits, console.error);
  console.error('Use a made-up value (the invented household: docs/deck/shot-data.mjs). A generic word that is only by chance an agent\'s name goes in scripts/privacy-ignore.txt.\n');
  return 1;
}

function text() {
  const files = args.slice(args.indexOf('--text') + 1).filter((a) => !a.startsWith('--') && !opts('--env').includes(a) && a !== opt('--db'));
  const ms = load();
  if (!ms) { console.error('Privacy check: no Hatchabot install here to read private values from.'); return 2; }
  const hits = files.flatMap((f) => scan(readFileSync(f, 'utf8'), f, ms));
  if (!hits.length) { console.log(`✓ privacy: ${files.join(', ')} name nothing private`); return 0; }
  console.log(`✗ privacy: ${hits.length} private value(s):`);
  report(hits);
  return 1;
}

function publicScan() {
  const ms = load();
  if (!ms) { console.log('✗ privacy: no Hatchabot install here to read private values from'); return 2; }
  const url = git(ROOT, 'remote', 'get-url', 'origin').stdout.trim();
  const repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1];
  const work = mkdtempSync(join(tmpdir(), 'hb-privacy-'));
  const mirror = join(work, 'public.git');
  try {
    const clone = spawnSync('git', ['clone', '-q', '--mirror', url, mirror], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (clone.status !== 0) { console.log(`✗ privacy: could not fetch ${url}: ${clone.stderr.trim()}`); return 2; }
    const hits = [];
    // Tags: none from before 1.0, none off main.
    const tagLines = git(mirror, 'for-each-ref', 'refs/tags', '--format=%(refname:short) %(*objectname)%(objectname)').stdout.split('\n').filter(Boolean);
    const tags = tagLines.map((l) => { const [name, ids] = l.split(' '); return { name, commit: ids.slice(0, 40) }; });
    const refused = tagRefusals(mirror, tags, 'refs/heads/main');
    // Every unique file version, with a path that names it.
    const paths = new Map();
    for (const l of git(mirror, 'rev-list', '--all', '--objects').stdout.split('\n')) { const i = l.indexOf(' '); if (i > 0 && !paths.has(l.slice(0, i))) paths.set(l.slice(0, i), l.slice(i + 1)); }
    const base = git(mirror, 'cat-file', '-e', `${ACCEPTED_HISTORY}^{commit}`).status === 0 ? [`^${ACCEPTED_HISTORY}`] : [];
    const newer = git(mirror, 'rev-list', '--objects', '--all', ...base).stdout.split('\n').map((l) => l.split(' ')[0]).filter(Boolean);
    const now = git(mirror, 'ls-tree', '-r', '--format=%(objectname)', 'refs/heads/main').stdout.split('\n').filter(Boolean);
    const blobs = [...new Set([...newer, ...now])];
    let files = 0;
    for (const b of catBatch(mirror, blobs)) if (b.type === 'blob' && isText(b.data)) { files++; hits.push(...scan(b.data.toString(), `${paths.get(b.id) ?? b.id.slice(0, 7)} (${b.id.slice(0, 7)})`, ms)); }
    hits.push(...scan(git(mirror, 'log', '--all', '--format=%B', ...base).stdout, 'commit messages', ms));
    const newTags = tags.filter((t) => !base.length || git(mirror, 'merge-base', '--is-ancestor', t.commit, ACCEPTED_HISTORY).status !== 0).map((t) => `refs/tags/${t.name}`);
    if (newTags.length) hits.push(...scan(git(mirror, 'for-each-ref', '--format=%(contents)', ...newTags).stdout, 'tag messages', ms));
    // What GitHub publishes beside the code.
    let skipped = '';
    const gh = (path) => spawnSync('gh', ['api', '--paginate', path, '-q', '.[] | (.tag_name // .html_url // "") + "\\n" + (.title // "") + "\\n" + (.body // "")'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (repo && spawnSync('gh', ['--version']).status === 0) {
      for (const [path, what] of [[`repos/${repo}/releases?per_page=100`, 'release notes'], [`repos/${repo}/issues?state=all&per_page=100`, 'issues'], [`repos/${repo}/issues/comments?per_page=100`, 'issue comments']]) {
        const r = gh(path);
        if (r.status !== 0) { skipped += ` ${what}`; continue; }
        hits.push(...scan(r.stdout, what, ms));
      }
    } else skipped = ' release notes, issues (no gh)';
    console.log(`privacy: ${ms.length} private values; ${files} file versions (main now, and all since ${base.length ? ACCEPTED_HISTORY.slice(0, 7) : 'the start'}), commits and tags of ${repo ?? url}${skipped ? '' : ', release notes and issues'}`);
    for (const r of refused) console.log(`✗ tag ${r}`);
    if (hits.length) { console.log(`✗ ${hits.length} private value(s):`); report(hits); }
    if (refused.length || hits.length) return 1;
    console.log(skipped ? `SKIP:${skipped} not read — everything else clean` : '✓ nothing GitHub serves names a private value');
    return 0;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function installHook() {
  const dir = join(git(ROOT, 'rev-parse', '--git-common-dir').stdout.trim().replace(/^(?!\/)/, ROOT + '/'), 'hooks');
  const file = join(dir, 'pre-push');
  const body = '#!/bin/sh\n# Hatchabot\'s privacy check: this household\'s private values and the tag guard (scripts/privacy-check.mjs).\nexec node "$(git rev-parse --show-toplevel)/scripts/privacy-check.mjs" --pre-push "$@"\n';
  if (existsSync(file) && readFileSync(file, 'utf8') !== body) { console.error(`${file} exists and is not this hook: add the line from scripts/privacy-check.mjs to it by hand.`); return 1; }
  writeFileSync(file, body); chmodSync(file, 0o755);
  const global = git(ROOT, 'config', '--get', 'core.hooksPath').stdout.trim();
  console.log(`✓ installed ${file}${global ? `\n  core.hooksPath is ${global}: its pre-push must run the repo's own hook (the PII hook here does)` : ''}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = has('--install-hook') ? installHook() : has('--pre-push') ? prePush() : has('--text') ? text() : has('--public') ? publicScan()
    : (console.error('usage: privacy-check.mjs --install-hook | --pre-push <remote> <url> | --text <file>... | --public'), 2);
  process.exitCode = code;
}
