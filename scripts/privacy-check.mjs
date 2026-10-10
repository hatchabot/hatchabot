#!/usr/bin/env node
/**
 * The privacy check: nothing that leaves this machine for the public repo may
 * name this household's private values — its agents' names and slugs, its
 * people's names, ids and emails, its bots, its machines and tailnet, the
 * secrets in its .env. A pattern scanner cannot know those ("Budget Tracker"
 * is just words); this reads them from the live install each time it runs,
 * keeps them in memory only, and prints a hit masked
 * ("[agent name] 'Bu…(14)' CHANGELOG.md:812"). The script itself holds
 * nothing private. Written after the 2026-10-09 review found real agent names
 * in docs, tests and release notes, and the pre-1.0 history on GitHub through
 * 212 v0.* tags pushed with `--tags` (docs/releasing.md).
 *
 *   node scripts/privacy-check.mjs --install-hook     # this clone's pre-push hook (once)
 *   node scripts/privacy-check.mjs --check-hook       # does this clone's pre-push run it?
 *   node scripts/privacy-check.mjs --pre-push <remote> <url>   # the hook: stdin is git's pre-push lines
 *   node scripts/privacy-check.mjs --text <file>...   # e.g. release notes, before `gh release create`
 *   node scripts/privacy-check.mjs --public [--check-hook]   # everything GitHub serves (the `privacy` live test)
 *   node scripts/privacy-check.mjs --sync-ci [--repo owner/name]   # GitHub's keyed fingerprints (scripts/privacy-ci.mjs)
 *   node scripts/privacy-check.mjs --export-digests [--out <file>] # the same fingerprints, to a file
 *
 * Options: --db <hatchabot.sqlite>, --env <file> (repeatable), --no-machine
 * (skip this machine's host, tailnet and IP values; for tests), --repo
 * <owner/name> (the GitHub repository, when origin's URL does not say),
 * --accepted-history <commit> (the accepted base; for tests).
 * Generic words that happen to be agent names ("Test", "Laptop runner") are
 * in scripts/privacy-ignore.txt. The owner's own author identities, already
 * public on every commit, are in scripts/privacy-identity.txt: not findings as
 * author, committer or in a Co-authored-by trailer (a squash merge adds one).
 *
 * GitHub cannot read these values, so CI checks keyed fingerprints of them
 * instead (2026-10-10): --sync-ci sends HMAC-SHA256(key, the value's words)
 * of each, with the key, as the PRIVACY_FINGERPRINTS secret, and
 * scripts/privacy-ci.mjs looks up the words of every pull request and push.
 * The key is made once and kept in ~/.config/hatchabot/privacy-ci.key (0600).
 *
 * Exit 0: clean (of what it says it checked); 1: found something; 2: usage;
 * 3: incomplete — something it needed could not be read (the database, an
 * env file, GitHub's release notes or issues), so it cannot say "clean". It
 * used to say clean, or SKIP with exit 0, in those cases (audit issue #41,
 * 2026-10-09). Every result says what is not covered (binary files and
 * images: no OCR) and, for --public, how many accepted historical commits it
 * did not check (#40). The hook lets a push through, with a warning, on a
 * machine with no install at all: the `privacy` live test covers what it
 * cannot see; an install it can only partly read blocks the push.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir, hostname, networkInterfaces, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { IDENTITY_FILE, SECRET_NAME, allowedIdentities, buildFingerprints, publishedIdentities, withoutAllowedLines, withoutOwnTrailers } from './privacy-ci.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const opts = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const has = (name) => args.includes(name);

export const CLEAN = 0, FOUND = 1, USAGE = 2, INCOMPLETE = 3;
/** Never read, in any mode: said with every result, so "clean" is never unrestricted. */
export const NOT_COVERED = 'binary files and images (no OCR)';

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

/** Tables every install has: one that cannot be read leaves the check incomplete. */
const REQUIRED_TABLES = ['agents', 'accounts'];

/**
 * This machine's tailnet names and addresses. No tailscale command, or one
 * that fails, is said in `notes` (not covered), not passed over in silence.
 */
export function tailnetValues(add, notes, cmd = 'tailscale') {
  const ts = spawnSync(cmd, ['status', '--json'], { encoding: 'utf8', timeout: 10_000 });
  if (ts.error) { notes.push('tailnet names (no tailscale command here)'); return; }
  if (ts.status !== 0) { notes.push('tailnet names (tailscale status failed)'); return; }
  try {
    const j = JSON.parse(ts.stdout);
    if (j.MagicDNSSuffix) add(j.MagicDNSSuffix, 'tailnet', { min: 6 });
    for (const p of [j.Self || {}, ...Object.values(j.Peer || {})]) {
      add(p.HostName, 'machine', { min: 5 });
      add((p.DNSName || '').replace(/\.$/, ''), 'machine', { min: 8 });
      for (const ip of p.TailscaleIPs || []) if (ip.includes('.')) add(ip, 'ip', { min: 7 });
    }
  } catch { notes.push('tailnet names (tailscale status unreadable)'); }
}

/**
 * value → { cat, secret }. Names keep their case: a real name is matched as
 * written ("Condo B" is not "condo board"); slugs, emails and machine names
 * match in any case. What it needed and could not read goes in `gaps` (the
 * result is then incomplete); what it chose not to read, in `notes`.
 */
export function privateValues({ db, envFiles, machine = true, gaps = [], notes = [] }) {
  const v = new Map();
  const add = (value, cat, { secret = false, min = 4 } = {}) => {
    if (value === null || value === undefined) return;
    const s = String(value).trim();
    if (s.length < min || /^\d{1,5}$/.test(s)) return;
    if (!v.has(s)) v.set(s, { cat, secret });
  };
  if (db && existsSync(db)) {
    let d;
    try {
      const Database = createRequire(join(ROOT, 'package.json'))('better-sqlite3');
      d = new Database(db, { readonly: true, fileMustExist: true });
    } catch (e) { gaps.push(`the database ${db} could not be opened (${String(e?.message ?? e).split('\n')[0]})`); }
    if (d) {
      // A required table that cannot be read used to give [] in silence, and
      // the check then said clean on the env file's values alone (#41).
      const rows = (sql) => {
        try { return d.prepare(sql).all(); } catch {
          const table = /\bfrom (\w+)/.exec(sql)?.[1];
          if (REQUIRED_TABLES.includes(table)) gaps.push(`the database ${db} has no readable ${table} table`);
          return [];
        }
      };
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
    }
  }
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
    tailnetValues(add, notes);
  } else notes.push("this machine's host, tailnet and IP names (--no-machine)");
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

/**
 * The publishing clone's own git identity (user.name, user.email): it is on
 * every commit by choice, so as an author or committer it is not a finding.
 * The same value anywhere else (a file, a message) still is.
 */
function ownIdentity(cwd) {
  return new Set(['user.name', 'user.email'].map((k) => git(cwd, 'config', '--get', k).stdout.trim().toLowerCase()).filter(Boolean));
}
const withoutOwn = (ms, own) => ms.filter((m) => !own.has(m.low));

/**
 * The identities that are not findings where git puts one (author, committer,
 * a Co-authored-by or Signed-off-by trailer): the clone's own, and the lines
 * of scripts/privacy-identity.txt (as `fileRev` has it) that a commit on
 * `revs` already carries as its author or committer. A squash merge on GitHub
 * puts the owner's address in a Co-authored-by trailer, and the hook and
 * --public flagged it (2026-10-10). → { pairs, names, emails, low } (`low`:
 * lowercased names and emails, for withoutOwn).
 */
function allowedHere(cwd, revs, fileRev) {
  const file = git(cwd, 'show', `${fileRev}:${IDENTITY_FILE}`);
  const a = allowedIdentities(file.status === 0 ? file.stdout : '', publishedIdentities(cwd, revs));
  const name = git(cwd, 'config', '--get', 'user.name').stdout.trim(), email = git(cwd, 'config', '--get', 'user.email').stdout.trim().toLowerCase();
  if (name) a.names.add(name);
  if (email) a.emails.add(email);
  return { ...a, low: new Set([...ownIdentity(cwd), ...[...a.names].map((n) => n.toLowerCase()), ...a.emails]) };
}

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
 * agents, and the maintainer decided to keep it, not rewrite it (docs/
 * releasing.md, "Retained history"). --public checks what came after it, main's
 * files as they are now, and every release note and issue, and says how many
 * commits it leaves out (#40).
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

// ---- the hook --------------------------------------------------------------------
const HOOK_BODY = '#!/bin/sh\n# Hatchabot\'s privacy check: this household\'s private values and the tag guard (scripts/privacy-check.mjs).\nexec node "$(git rev-parse --show-toplevel)/scripts/privacy-check.mjs" --pre-push "$@"\n';
const executable = (f) => { try { return statSync(f).isFile() && (statSync(f).mode & 0o111) !== 0; } catch { return false; } };
const runsCheck = (f) => executable(f) && /privacy-check\.mjs"?\s+--pre-push/.test(readFileSync(f, 'utf8'));

/**
 * Does this clone's pre-push hook run the privacy check? Git runs
 * <core.hooksPath>/pre-push when core.hooksPath is set (a machine-wide hook
 * folder), else the repo's own hooks/pre-push; a machine-wide hook counts only
 * when it runs the check itself or hands on to the repo's own hook and that one
 * runs it. --install-hook alone never showed whether it was in place (#41).
 * → { ok, how } or { ok: false, why }.
 */
export function hookStatus(cwd) {
  const common = git(cwd, 'rev-parse', '--git-common-dir').stdout.trim();
  if (!common) return { ok: false, why: `${cwd} is not a git checkout` };
  const own = join(resolve(cwd, common), 'hooks', 'pre-push');
  const ownState = () => (runsCheck(own) ? null : existsSync(own) ? `${own} does not run the privacy check` : `there is no ${own}`);
  let path = git(cwd, 'config', '--get', 'core.hooksPath').stdout.trim();
  if (path) {
    path = path.replace(/^~(?=\/|$)/, homedir());
    const top = git(cwd, 'rev-parse', '--show-toplevel').stdout.trim() || cwd;
    const dir = resolve(top, path);
    if (dir === '/dev/null') return { ok: false, why: 'git hooks are off here (core.hooksPath=/dev/null)' };
    const hook = join(dir, 'pre-push');
    if (resolve(hook) !== resolve(own)) {
      if (runsCheck(hook)) return { ok: true, how: `${hook} runs it (core.hooksPath)` };
      if (!executable(hook)) return { ok: false, why: `core.hooksPath is ${dir} and has no pre-push hook, so the repo's own hook never runs` };
      const text = readFileSync(hook, 'utf8');
      if (!/hooks\/pre-push/.test(text) || !/--git-(common-)?dir|GIT_DIR/.test(text)) return { ok: false, why: `core.hooksPath is ${dir}; its pre-push runs neither the privacy check nor the repo's own hook` };
      const why = ownState();
      return why ? { ok: false, why: `${hook} hands on to the repo's own hook, but ${why}` } : { ok: true, how: `${hook} hands on to ${own}, which runs it` };
    }
  }
  const why = ownState();
  return why ? { ok: false, why } : { ok: true, how: `${own} runs it` };
}
const hookLine = (s) => (s.ok ? `✓ pre-push hook: ${s.how}` : `✗ pre-push hook: ${s.why} — node scripts/privacy-check.mjs --install-hook`);

// ---- modes ---------------------------------------------------------------------
/**
 * The private values, as matchers, with what could not be read (`gaps`) and
 * what is not read (`notes`). null: no install here at all (no database and
 * no env file). A database missing beside an env file that is there used to
 * read as "no install", and the hook let the push through (#41).
 */
export function load() {
  const asked = opts('--env');
  const envFiles = asked.length ? asked : DEFAULT_ENVS.filter(existsSync);
  const present = envFiles.filter(existsSync);
  const db = opt('--db') || defaultDb(present);
  const haveDb = Boolean(db && existsSync(db));
  if (!haveDb && !present.length) return null;
  const gaps = [], notes = [];
  for (const f of envFiles) if (!existsSync(f)) gaps.push(`the env file ${f} is not there`);
  if (!haveDb) gaps.push(`the database ${db || '(none named in the env file, none in the usual places)'} is not there — only the env file's values could be read`);
  const values = privateValues({ db: haveDb ? db : undefined, envFiles: present, machine: !has('--no-machine'), gaps, notes });
  return { ms: matchers(values), gaps, notes };
}

/** The last lines of every result: what could not be read, and what is never read. */
function coverage(say, { gaps, notes }, extra = []) {
  for (const g of gaps) say(`✗ incomplete: ${g}`);
  say(`not covered: ${[NOT_COVERED, ...notes, ...extra].join('; ')}`);
}

function prePush() {
  const cwd = process.cwd();
  const remote = args[args.indexOf('--pre-push') + 1] || 'origin';
  const lines = readFileSync(0, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 4);
  const zero = /^0+$/;
  const tags = [], commits = new Set(), annotated = [], refs = [];
  for (const [, localSha, remoteRef] of lines) {
    if (zero.test(localSha)) continue; // a delete
    refs.push(remoteRef);
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
    return FOUND;
  }
  const loaded = load();
  if (!loaded) {
    console.error('Privacy check: no Hatchabot install here to read private values from — not checked (the `privacy` live test covers it).');
    return CLEAN;
  }
  const { ms } = loaded;
  const allowed = allowedHere(cwd, [`--remotes=${remote}`], 'HEAD');
  const people = withoutOwn(ms, allowed.low);
  const hits = [];
  // The names being published, not only what is in them (#41).
  for (const r of refs) hits.push(...scan(r, 'ref name', ms));
  let binary = 0;
  for (const c of commits) {
    const short = c.slice(0, 7);
    const show = git(cwd, 'show', '--format=%B%x00', '--unified=0', '--no-color', '--no-ext-diff', c).stdout;
    const [msg, diff = ''] = show.split('\0');
    hits.push(...scan(withoutOwnTrailers(msg, allowed), `commit ${short} message`, ms));
    hits.push(...scan(git(cwd, 'show', '-s', '--format=%an%n%ae%n%cn%n%ce', c).stdout, `commit ${short} author/committer`, people));
    for (const f of git(cwd, 'show', '--format=', '--name-only', '--no-renames', '--diff-filter=d', c).stdout.split('\n').filter(Boolean)) hits.push(...scan(f, `file name (commit ${short})`, ms));
    let file = '?', line = 0;
    for (const l of diff.split('\n')) {
      if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
      if (/^Binary files .* differ$/.test(l)) { binary++; continue; }
      const h = /^@@ -\S+ \+(\d+)/.exec(l);
      if (h) { line = Number(h[1]); continue; }
      if (l.startsWith('+')) {
        const added = file === IDENTITY_FILE ? withoutAllowedLines(l.slice(1), allowed) : l.slice(1);
        for (const x of scan(added, `${file} (commit ${short})`, ms)) hits.push({ ...x, line });
        line++;
      }
    }
  }
  for (const t of catBatch(cwd, annotated)) {
    const [head, ...body] = t.data.toString().split('\n\n');
    hits.push(...scan(head.split('\n').filter((l) => l.startsWith('tagger ')).join('\n'), `tag ${t.id.slice(0, 7)} tagger`, people));
    hits.push(...scan(body.join('\n\n'), `tag message ${t.id.slice(0, 7)}`, ms));
  }
  const extra = binary ? [`${binary} binary file change(s) in this push`] : [];
  if (hits.length) {
    console.error(`\n🔒 Privacy check blocked this push: ${hits.length} private value(s) in what it would publish:`);
    report(hits, console.error);
    console.error('Use a made-up value (the invented household: docs/deck/shot-data.mjs). A generic word that is only by chance an agent\'s name goes in scripts/privacy-ignore.txt.');
    coverage(console.error, loaded, extra);
    console.error('');
    return FOUND;
  }
  if (loaded.gaps.length) {
    console.error('\n🔒 Privacy check could not read all of this install\'s private values, so it cannot pass this push:');
    coverage(console.error, loaded, extra);
    console.error('Fix what it names (or pass --db/--env to the hook\'s script), then push again.\n');
    return INCOMPLETE;
  }
  console.error(`privacy: ${commits.size} commit(s) and ${refs.length} ref(s) checked — contents, file and ref names, authors, messages, tags`);
  coverage(console.error, loaded, extra);
  return CLEAN;
}

function text() {
  const files = args.slice(args.indexOf('--text') + 1).filter((a) => !a.startsWith('--') && !opts('--env').includes(a) && a !== opt('--db'));
  if (!files.length) { console.error('usage: privacy-check.mjs --text <file>...'); return USAGE; }
  const loaded = load();
  if (!loaded) { console.log('✗ privacy: incomplete — no Hatchabot install here to read private values from; nothing was checked'); return INCOMPLETE; }
  const { ms, gaps } = loaded;
  const hits = [], extra = [];
  for (const f of files) {
    let b;
    try { b = readFileSync(f); } catch { gaps.push(`${f} could not be read`); continue; }
    if (!isText(b)) { extra.push(`${f} (binary)`); continue; }
    hits.push(...scan(b.toString('utf8'), f, ms));
  }
  if (hits.length) { console.log(`✗ privacy: ${hits.length} private value(s):`); report(hits); coverage(console.log, loaded, extra); return FOUND; }
  if (gaps.length) { console.log(`✗ privacy: incomplete — ${files.join(', ')} could not be fully checked`); coverage(console.log, loaded, extra); return INCOMPLETE; }
  console.log(`✓ privacy: ${files.join(', ')} name nothing private`);
  coverage(console.log, loaded, extra);
  return CLEAN;
}

function publicScan() {
  const loaded = load();
  const accepted = opt('--accepted-history') || ACCEPTED_HISTORY;
  const hook = has('--check-hook') ? hookStatus(ROOT) : null;
  if (!loaded) {
    console.log('✗ privacy: incomplete — no Hatchabot install here to read private values from; nothing was checked');
    if (hook) console.log(hookLine(hook));
    return INCOMPLETE;
  }
  const { ms, gaps } = loaded;
  const url = git(ROOT, 'remote', 'get-url', 'origin').stdout.trim();
  const repo = opt('--repo') || /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1];
  const work = mkdtempSync(join(tmpdir(), 'hb-privacy-'));
  const mirror = join(work, 'public.git');
  try {
    const clone = spawnSync('git', ['clone', '-q', '--mirror', url, mirror], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (clone.status !== 0) {
      console.log(`✗ privacy: incomplete — could not fetch ${url}: ${clone.stderr.trim()}`);
      if (hook) console.log(hookLine(hook));
      return INCOMPLETE;
    }
    const hits = [];
    const allowed = allowedHere(mirror, ['refs/heads/main'], 'refs/heads/main');
    for (const v of ownIdentity(ROOT)) allowed.low.add(v);
    const people = withoutOwn(ms, allowed.low);
    // Tags: none from before 1.0, none off main.
    const tagLines = git(mirror, 'for-each-ref', 'refs/tags', '--format=%(refname:short) %(*objectname)%(objectname)').stdout.split('\n').filter(Boolean);
    const tags = tagLines.map((l) => { const [name, ids] = l.split(' '); return { name, commit: ids.slice(0, 40) }; });
    const refused = tagRefusals(mirror, tags, 'refs/heads/main');
    // Every ref GitHub serves, by name: branches, tags, pull requests (#41).
    hits.push(...scan(git(mirror, 'for-each-ref', '--format=%(refname)').stdout, 'ref names', ms));
    // Every unique file version, with a path that names it.
    const paths = new Map();
    for (const l of git(mirror, 'rev-list', '--all', '--objects').stdout.split('\n')) { const i = l.indexOf(' '); if (i > 0 && !paths.has(l.slice(0, i))) paths.set(l.slice(0, i), l.slice(i + 1)); }
    const haveBase = git(mirror, 'cat-file', '-e', `${accepted}^{commit}`).status === 0;
    const base = haveBase ? [`^${accepted}`] : [];
    const newerLines = git(mirror, 'rev-list', '--objects', '--all', ...base).stdout.split('\n').filter(Boolean);
    const newer = newerLines.map((l) => l.split(' ')[0]);
    const nowLines = git(mirror, 'ls-tree', '-r', '-t', '--format=%(objectname) %(path)', 'refs/heads/main').stdout.split('\n').filter(Boolean);
    const now = nowLines.map((l) => l.split(' ')[0]);
    // File and folder names, not only what is in them (#41).
    const names = [...new Set([...newerLines, ...nowLines].filter((l) => l.includes(' ')).map((l) => l.slice(l.indexOf(' ') + 1)))];
    hits.push(...scan(names.join('\n'), 'file/folder names', ms).map((h) => ({ ...h, line: 0 })));
    const blobs = [...new Set([...newer, ...now])];
    let files = 0, binary = 0;
    for (const b of catBatch(mirror, blobs)) {
      if (b.type !== 'blob') continue;
      if (!isText(b.data)) { binary++; continue; }
      files++;
      const body = paths.get(b.id) === IDENTITY_FILE ? withoutAllowedLines(b.data.toString(), allowed) : b.data.toString();
      hits.push(...scan(body, `${paths.get(b.id) ?? b.id.slice(0, 7)} (${b.id.slice(0, 7)})`, ms));
    }
    hits.push(...scan(withoutOwnTrailers(git(mirror, 'log', '--all', '--format=%B', ...base).stdout, allowed), 'commit messages', ms));
    hits.push(...scan(git(mirror, 'log', '--all', '--format=%an%n%ae%n%cn%n%ce', ...base).stdout, 'commit authors/committers', people));
    const newTags = tags.filter((t) => !haveBase || git(mirror, 'merge-base', '--is-ancestor', t.commit, accepted).status !== 0).map((t) => `refs/tags/${t.name}`);
    if (newTags.length) {
      hits.push(...scan(git(mirror, 'for-each-ref', '--format=%(contents)', ...newTags).stdout, 'tag messages', ms));
      hits.push(...scan(git(mirror, 'for-each-ref', '--format=%(taggername)%0a%(taggeremail)', ...newTags).stdout, 'taggers', people));
    }
    // What GitHub publishes beside the code. Not reading it is incomplete,
    // never a pass: it used to print SKIP and exit 0 (#41).
    const ghRead = [];
    const gh = (path) => spawnSync('gh', ['api', '--paginate', path, '-q', '.[] | (.tag_name // .html_url // "") + "\\n" + (.title // "") + "\\n" + (.body // "") + "\\n" + ([.assets[]?.name] | join("\\n"))'], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const ghOk = spawnSync('gh', ['--version'], { encoding: 'utf8' }).status === 0;
    if (!repo) gaps.push(`release notes and issues: ${url} is not a GitHub address (pass --repo <owner/name>)`);
    else if (!ghOk) gaps.push('release notes and issues: no gh command here');
    else {
      for (const [path, what] of [[`repos/${repo}/releases?per_page=100`, 'release notes'], [`repos/${repo}/issues?state=all&per_page=100`, 'issues'], [`repos/${repo}/issues/comments?per_page=100`, 'issue comments']]) {
        const r = gh(path);
        if (r.status !== 0) { gaps.push(`${what}: GitHub did not answer (${(r.stderr || '').trim().split('\n')[0] || `gh exit ${r.status}`})`); continue; }
        ghRead.push(what);
        hits.push(...scan(r.stdout, what, ms));
      }
    }
    if (hook && !hook.ok) gaps.push(`this checkout's pre-push hook: ${hook.why}`);
    const historyCount = haveBase ? Number(git(mirror, 'rev-list', '--count', accepted).stdout.trim()) : 0;
    const historyLine = haveBase
      ? `${historyCount} accepted historical commits not checked (retained by decision, docs/releasing.md): up to ${accepted.slice(0, 7)}`
      : `0 accepted historical commits: ${accepted.slice(0, 7)} is not in ${repo ?? url}, so all of its history was checked`;
    console.log(`privacy: ${ms.length} private values; ${files} file versions (main now, and all since ${haveBase ? accepted.slice(0, 7) : 'the start'}), file and ref names, commits, authors and tags of ${repo ?? url}${ghRead.length ? `, ${ghRead.join(', ')}` : ''}`);
    console.log(historyLine);
    if (hook) console.log(hookLine(hook));
    for (const r of refused) console.log(`✗ tag ${r}`);
    if (hits.length) { console.log(`✗ ${hits.length} private value(s):`); report(hits); }
    coverage(console.log, loaded, binary ? [`${binary} binary file versions`] : []);
    if (refused.length || hits.length) return FOUND;
    if (gaps.length) { console.log('✗ privacy: incomplete — not everything GitHub serves could be checked (above); this is not a pass'); return INCOMPLETE; }
    console.log(`✓ privacy: what was checked is clean — main now and everything since ${haveBase ? accepted.slice(0, 7) : 'the start'}; the accepted history before it was not checked`);
    return CLEAN;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

// ---- GitHub's copy: keyed fingerprints (scripts/privacy-ci.mjs) ---------------------
/** GitHub's limit for one secret. */
const SECRET_MAX = 48 * 1024;
export const keyFile = () => join(homedir(), '.config', 'hatchabot', 'privacy-ci.key');

/** The fingerprint key: 32 random bytes, made once, 0600. A garbled file is said, not replaced. */
function ciKey() {
  const f = keyFile();
  if (existsSync(f)) {
    const k = Buffer.from(readFileSync(f, 'utf8').trim(), 'base64url');
    if (k.length !== 32) throw new Error(`${f} is not a 32-byte key — remove it to make a new one`);
    chmodSync(f, 0o600);
    return k;
  }
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  const k = randomBytes(32);
  writeFileSync(f, k.toString('base64url') + '\n', { mode: 0o600 });
  chmodSync(f, 0o600);
  return k;
}

/**
 * The fingerprint blob for this install, or why not. An install it cannot
 * fully read is refused (load's rules), as the hook does: half the values
 * would let the other half through on GitHub.
 */
function exportBlob() {
  const loaded = load();
  if (!loaded) return { why: 'no Hatchabot install here to read private values from' };
  if (loaded.gaps.length) return { why: 'this install could not be fully read', loaded };
  let key;
  try { key = ciKey(); } catch (e) { return { why: e.message, loaded }; }
  // The same case rule as the local matchers: a value matched in any case goes in `lower`.
  const blob = buildFingerprints(loaded.ms.map((m) => ({ value: m.value, cat: m.cat, caseless: m.re.flags.includes('i') })), key);
  return { blob, json: JSON.stringify(blob), loaded };
}
const blobSummary = (b, json) => {
  const kinds = {};
  for (const l of Object.values(b.cats)) kinds[l] = (kinds[l] ?? 0) + 1;
  return `${b.exact.length + b.lower.length} fingerprints (${b.exact.length} as written, ${b.lower.length} in any case; ${Object.entries(kinds).sort().map(([k, n]) => `${k}=${n}`).join(' ')}), word lengths ${b.lengths.join(',')}, ${Math.ceil(Buffer.byteLength(json) / 1024)} KB`;
};
function refuseExport(r, say) {
  say(`✗ privacy fingerprints: not made — ${r.why}`);
  if (r.loaded) coverage(say, r.loaded);
  return INCOMPLETE;
}

/** --export-digests [--out file]: the blob, to a 0600 file or a pipe (never a terminal). */
function exportDigests() {
  const out = opt('--out');
  if (!out && process.stdout.isTTY) { console.error('usage: privacy-check.mjs --export-digests --out <file> (or into a pipe): the output is a secret'); return USAGE; }
  const r = exportBlob();
  if (!r.blob) return refuseExport(r, console.error);
  if (out) { writeFileSync(out, r.json + '\n', { mode: 0o600 }); chmodSync(out, 0o600); } else process.stdout.write(r.json + '\n');
  console.error(`✓ privacy fingerprints: ${blobSummary(r.blob, r.json)}`);
  return CLEAN;
}

/**
 * --sync-ci: the blob as the repository's PRIVACY_FINGERPRINTS secret. It goes
 * to `gh secret set` on stdin — never in its arguments, where any process on
 * the machine could read it — and only counts are printed.
 */
function syncCi() {
  const r = exportBlob();
  if (!r.blob) return refuseExport(r, console.log);
  const url = git(ROOT, 'remote', 'get-url', 'origin').stdout.trim();
  const repo = opt('--repo') || /github\.com[:/](.+?)(?:\.git)?$/.exec(url)?.[1];
  if (!repo) { console.log(`✗ privacy fingerprints: not sent — ${url || 'origin'} is not a GitHub address (pass --repo <owner/name>)`); return USAGE; }
  if (Buffer.byteLength(r.json) > SECRET_MAX) { console.log(`✗ privacy fingerprints: not sent — ${Math.ceil(Buffer.byteLength(r.json) / 1024)} KB is over GitHub's 48 KB for a secret`); return FOUND; }
  // Twice: for Actions, and for Dependabot — its pull requests get only
  // Dependabot secrets, so without this their required privacy check could
  // never pass (2026-10-10).
  for (const app of ['actions', 'dependabot']) {
    const set = spawnSync('gh', ['secret', 'set', SECRET_NAME, '--repo', repo, '--app', app], { input: r.json, encoding: 'utf8' });
    if (set.error || set.status !== 0) {
      console.log(`✗ privacy fingerprints: not sent to ${app} — gh secret set failed (${(set.stderr || String(set.error?.message ?? '')).trim().split('\n')[0] || `exit ${set.status}`})`);
      return FOUND;
    }
  }
  console.log(`✓ ${SECRET_NAME} set on ${repo} (Actions and Dependabot): ${blobSummary(r.blob, r.json)}`);
  coverage(console.log, r.loaded);
  return CLEAN;
}

function installHook() {
  const dir = join(git(ROOT, 'rev-parse', '--git-common-dir').stdout.trim().replace(/^(?!\/)/, ROOT + '/'), 'hooks');
  const file = join(dir, 'pre-push');
  if (existsSync(file) && readFileSync(file, 'utf8') !== HOOK_BODY) { console.error(`${file} exists and is not this hook: add the line from scripts/privacy-check.mjs to it by hand.`); return FOUND; }
  writeFileSync(file, HOOK_BODY); chmodSync(file, 0o755);
  const s = hookStatus(ROOT);
  console.log(`✓ installed ${file}`);
  console.log(hookLine(s));
  return s.ok ? CLEAN : FOUND;
}

function checkHook() {
  const s = hookStatus(ROOT);
  console.log(hookLine(s));
  return s.ok ? CLEAN : FOUND;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const code = has('--install-hook') ? installHook() : has('--pre-push') ? prePush() : has('--text') ? text() : has('--public') ? publicScan()
    : has('--sync-ci') ? syncCi() : has('--export-digests') ? exportDigests()
    : has('--check-hook') ? checkHook()
    : (console.error('usage: privacy-check.mjs --install-hook | --check-hook | --pre-push <remote> <url> | --text <file>... | --public [--check-hook] | --sync-ci [--repo owner/name] | --export-digests [--out file]'), USAGE);
  process.exitCode = code;
}
