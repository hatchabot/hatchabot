#!/usr/bin/env node
/**
 * The privacy check that GitHub runs (2026-10-10). The household's private
 * values exist only on the owner's machine, so the pre-push hook, `--text`
 * and the `privacy` live test (scripts/privacy-check.mjs) never see what is
 * written elsewhere: another machine's agent, a web edit, a pull request made
 * on GitHub. This scanner needs no private value. The owner's machine sends
 * GitHub keyed fingerprints of them — HMAC-SHA256 of each value's words, with
 * a key of its own (`privacy-check.mjs --sync-ci`, the PRIVACY_FINGERPRINTS
 * secret) — and this splits text into words the same way and looks each run
 * of words up. A hit prints its kind, a masked hint ('Ma…(16)') and where it
 * is; never the value.
 *
 *   node scripts/privacy-ci.mjs                 # in Actions: the pull request or push in $GITHUB_EVENT_PATH
 *   node scripts/privacy-ci.mjs --watch [--days 2] [--repo owner/name]
 *       # issues, comments, pull requests and release notes changed lately (privacy-watch.yml)
 *
 * Options: --event <file> and --event-name <name> (default: GitHub's own),
 * --dir <checkout> (default: the current directory).
 *
 * What it reads, for a pull request (base...head) or a push to main
 * (before..after): every added line, every changed file's path, each commit's
 * message, author and committer, and the pull request's title, body and branch
 * name. The identities in scripts/privacy-identity.txt — the owner's, already
 * public on every commit — are not findings as author, committer or in a
 * Co-authored-by/Signed-off-by trailer; anywhere else they still are. A line
 * there counts only once that exact identity is the author or committer of a
 * commit already on the trusted side (the base), so a pull request cannot
 * allow a name by adding it.
 *
 * Words: letters and digits, with . @ - _ kept inside a word
 * ("mapleford-helper.md", "someone@example.org", "10.0.0.7"); a word's
 * dotted or dashed parts are tried too, so a slug inside a file name is found.
 * Text is read a line at a time: a name broken across two lines is not
 * matched. Names keep their case as privacy-check.mjs does ("Condo B" is not
 * "condo board"); slugs, emails, machine names and ids match in any case;
 * secrets as written.
 *
 * Exit 0: clean; 1: found something; 2: usage; 3: incomplete — no secret (a
 * pull request from a fork gets none), a garbled one, a range or a GitHub
 * answer it could not read. Never a pass.
 */
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLEAN = 0, FOUND = 1, USAGE = 2, INCOMPLETE = 3;
/** One letter per kind of value: what the fingerprints say instead of the value. */
export const CATS = { A: 'agent name', S: 'agent slug', E: 'email', I: 'person id', P: 'person name', B: 'bot', M: 'machine', T: 'tailnet', N: 'ip', D: 'path', K: 'secret' };
export const LETTER = Object.fromEntries(Object.entries(CATS).map(([k, v]) => [v, k]));
export const IDENTITY_FILE = 'scripts/privacy-identity.txt';
export const SECRET_NAME = 'PRIVACY_FINGERPRINTS';
export const NOT_COVERED = 'binary files and images (no OCR); a private value the owner\'s install does not record; a value split across lines or paraphrased';
const DIGEST_BYTES = 16;
/** Parts of a word longer than this are not tried in every combination (a long URL). */
const MAX_SPAN = 16;

// ---- words and fingerprints ------------------------------------------------------
/** A word: letters, marks and digits, joined by . @ - _ (never at its ends). */
const WORD = /[\p{L}\p{M}\p{N}]+(?:[.@_-]+[\p{L}\p{M}\p{N}]+)*/gu;
export const words = (text) => String(text).match(WORD) ?? [];
export const digest = (key, s) => createHmac('sha256', key).update(s, 'utf8').digest().subarray(0, DIGEST_BYTES).toString('base64url');

/**
 * The fingerprints of the private values, [{ value, cat, caseless }]: each
 * value's words joined by one space, keyed. `caseless` values go in `lower`,
 * lowercased; names and secrets in `exact`, as written. The blob holds the
 * key, so the whole of it is the secret.
 */
export function buildFingerprints(entries, key) {
  const exact = new Set(), lower = new Set(), cats = {}, lengths = new Set();
  for (const { value, cat, caseless } of entries) {
    const ws = words(value);
    if (!ws.length) continue;
    const norm = ws.join(' ');
    const d = digest(key, caseless ? norm.toLowerCase() : norm);
    (caseless ? lower : exact).add(d);
    cats[d] = LETTER[cat] ?? '?';
    lengths.add(ws.length);
  }
  return { v: 1, key: key.toString('base64url'), lengths: [...lengths].sort((a, b) => a - b), exact: [...exact].sort(), lower: [...lower].sort(), cats };
}

/** The secret, checked: { key, lengths, exact, lower, cats }; throws with why. */
export function parseFingerprints(raw) {
  if (!raw || !String(raw).trim()) throw new Error(`${SECRET_NAME} is not set here (a pull request from a fork gets no secrets; the owner sets it with \`node scripts/privacy-check.mjs --sync-ci\`)`);
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error(`${SECRET_NAME} is not valid JSON — sync it again from the owner's machine`); }
  const fp = /^[A-Za-z0-9_-]{22}$/;
  const key = typeof j?.key === 'string' ? Buffer.from(j.key, 'base64url') : Buffer.alloc(0);
  const ok = j && j.v === 1 && key.length === 32
    && Array.isArray(j.lengths) && j.lengths.length && j.lengths.every((n) => Number.isInteger(n) && n > 0 && n <= 64)
    && Array.isArray(j.exact) && Array.isArray(j.lower) && [...j.exact, ...j.lower].every((d) => typeof d === 'string' && fp.test(d))
    && j.exact.length + j.lower.length > 0 && j.cats && typeof j.cats === 'object';
  if (!ok) throw new Error(`${SECRET_NAME} is not a fingerprint set this scanner reads (v1) — sync it again from the owner's machine`);
  return { key, lengths: [...j.lengths].sort((a, b) => a - b), exact: new Set(j.exact), lower: new Set(j.lower), cats: j.cats };
}

/**
 * A joined word's runs of parts: "a-b.c" → a, a-b, a-b.c, b, b.c, c. `head`:
 * only the runs that start it (the last word of a run of words); `tail`: only
 * those that end it (the first word).
 */
function spans(word, { head = false, tail = false } = {}) {
  const bits = word.split(/([.@_-]+)/);
  const n = (bits.length + 1) / 2;
  if (n === 1) return [word];
  const out = new Set([word]);
  for (let a = 0; a < (head ? 1 : n); a++) {
    for (let b = tail ? Math.max(a, n - 1) : a; b < n && b - a < MAX_SPAN; b++) out.add(bits.slice(2 * a, 2 * b + 1).join(''));
  }
  return [...out];
}

export const mask = (value) => `${[...value].slice(0, 2).join('')}…(${[...value].length})`;

/**
 * Hits in one line: [{ cat, shown }]. Every run of words of a length some value
 * has; a run's first word may be any tail of a joined word, its last any head
 * ("x-Condo B" holds "Condo B"), and a single word any of its parts.
 */
export function scanLine(line, fp) {
  const ws = words(line);
  if (!ws.length) return [];
  const out = [], seen = new Set();
  const hit = (set, d, cand) => { if (set.has(d) && !seen.has(d)) { seen.add(d); out.push({ cat: fp.cats[d] ?? '?', shown: mask(cand) }); } };
  const check = (cand) => {
    const d = digest(fp.key, cand);
    hit(fp.exact, d, cand);
    const low = cand.toLowerCase();
    hit(fp.lower, low === cand ? d : digest(fp.key, low), cand);
  };
  for (let i = 0; i < ws.length; i++) {
    for (const n of fp.lengths) {
      if (i + n > ws.length) break;
      if (n === 1) { for (const s of spans(ws[i])) check(s); continue; }
      const middle = ws.slice(i + 1, i + n - 1);
      for (const first of spans(ws[i], { tail: true })) {
        for (const last of spans(ws[i + n - 1], { head: true })) check([first, ...middle, last].join(' '));
      }
    }
  }
  return out;
}

/** Hits in a text, a line at a time: [{ cat, shown, where, line }]. */
export function scanText(text, where, fp, { lines = true } = {}) {
  const out = [];
  String(text ?? '').split('\n').forEach((l, i) => {
    for (const h of scanLine(l, fp)) out.push({ ...h, where, line: lines ? i + 1 : 0 });
  });
  return out;
}

const label = (h) => `[${h.cat} ${CATS[h.cat] ?? 'private value'}] '${h.shown}' ${h.where}${h.line ? ':' + h.line : ''}`;

// ---- the owner's identity ---------------------------------------------------------
const git = (cwd, ...a) => spawnSync('git', ['-C', cwd, '-c', 'core.quotePath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 30 });
const pairOf = (name, email) => `${name.trim()} <${email.trim().toLowerCase()}>`;

/** "Name <email>" lines of the identity file. */
export function parseIdentities(text) {
  return String(text ?? '').split('\n').map((l) => l.replace(/#.*/, '').trim())
    .map((l) => /^(.+?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(l)).filter(Boolean)
    .map((m) => ({ name: m[1].trim(), email: m[2].toLowerCase() }));
}

/** The authors and committers of the commits `revs` reach: identities already public there. */
export function publishedIdentities(cwd, revs) {
  const r = git(cwd, 'log', '--format=%an%x00%ae%n%cn%x00%ce', ...revs, '--');
  const out = new Set();
  if (r.status !== 0) return out;
  for (const l of r.stdout.split('\n')) { const [n, e] = l.split('\0'); if (n && e) out.add(pairOf(n, e)); }
  return out;
}

/**
 * The identity file's lines that are already public as an author or
 * committer: { pairs, names, emails }. A line no published commit carries is
 * not allowed (an agent cannot allow a private name by adding it).
 */
export function allowedIdentities(fileText, published) {
  const ok = parseIdentities(fileText).filter((i) => published.has(pairOf(i.name, i.email)));
  return { pairs: new Set(ok.map((i) => pairOf(i.name, i.email))), names: new Set(ok.map((i) => i.name)), emails: new Set(ok.map((i) => i.email)) };
}

/** A commit message with the allowed names and emails taken out of its identity trailers. */
export function withoutOwnTrailers(msg, allowed) {
  return String(msg).split('\n').map((l) => {
    const m = /^(\s*(?:Co-authored-by|Signed-off-by):\s*)(.*?)\s*<([^<>]*)>\s*$/i.exec(l);
    if (!m) return l;
    return `${m[1]}${allowed.names.has(m[2].trim()) ? '' : m[2]} <${allowed.emails.has(m[3].trim().toLowerCase()) ? '' : m[3]}>`;
  }).join('\n');
}

/** The identity file's own text, less its allowed lines (the rest is checked as usual). */
export function withoutAllowedLines(text, allowed) {
  return String(text).split('\n').map((l) => {
    const [i] = parseIdentities(l);
    return i && allowed.pairs.has(pairOf(i.name, i.email)) ? l.replace(/^[^#]*/, '') : l;
  }).join('\n');
}

// ---- a pull request or a push --------------------------------------------------------
const ZERO = /^0+$/;
const isCommit = (cwd, sha) => Boolean(sha) && git(cwd, 'cat-file', '-e', `${sha}^{commit}`).status === 0;

/** What GitHub's event says to check: { base, head, title, body, ref, kind } or { why }. */
export function rangeOf(event, name, cwd) {
  if (name === 'pull_request' || name === 'pull_request_target') {
    const pr = event.pull_request ?? {};
    const base = pr.base?.sha, head = pr.head?.sha;
    if (!isCommit(cwd, base) || !isCommit(cwd, head)) return { why: `the pull request's commits (${String(base).slice(0, 7)}...${String(head).slice(0, 7)}) are not in this checkout (fetch-depth: 0?)` };
    return { kind: 'pull request', base, head, title: pr.title ?? '', body: pr.body ?? '', ref: pr.head?.ref ?? '' };
  }
  if (name === 'push') {
    const { before, after } = event;
    if (!isCommit(cwd, after)) return { why: `the pushed commit ${String(after).slice(0, 7)} is not in this checkout` };
    if (!before || ZERO.test(before)) {
      // A new branch: only its last commit (main is never new; rulesets refuse force-pushes).
      const parent = git(cwd, 'rev-parse', '-q', '--verify', `${after}^`).stdout.trim();
      return { kind: 'push', base: parent || null, head: after, ref: '', note: 'a new branch: only its last commit was checked' };
    }
    if (!isCommit(cwd, before)) return { why: `the push's previous commit ${before.slice(0, 7)} is not in this checkout (fetch-depth: 0?)` };
    return { kind: 'push', base: before, head: after, ref: '' };
  }
  return { why: `${name || '(no event)'} is not a pull request or a push` };
}

/** Everything a pull request or push adds: hits and counts. */
export function scanRange(cwd, r, fp) {
  const EMPTY = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const from = r.base ?? EMPTY;
  const range = r.base ? [`${r.base}..${r.head}`] : ['-1', r.head];
  const hits = [];
  // The identities already public on the trusted side; the file as the change leaves it.
  const published = r.base ? publishedIdentities(cwd, [r.base]) : new Set();
  const idFile = git(cwd, 'show', `${r.head}:${IDENTITY_FILE}`);
  const allowed = allowedIdentities(idFile.status === 0 ? idFile.stdout : '', published);

  // Paths first: a file whose name is private is not named again beside its lines.
  const paths = git(cwd, 'diff', '--name-only', '--no-renames', '--diff-filter=d', `${from}...${r.head}`).stdout.split('\n').filter(Boolean);
  const privatePath = new Map();
  for (const p of paths) {
    const h = scanText(p, 'a changed file\'s name', fp, { lines: false });
    if (h.length) { privatePath.set(p, `(a file whose name is private, '${h[0].shown}')`); hits.push(...h); }
  }
  const shown = (p) => privatePath.get(p) ?? p;

  const diff = git(cwd, 'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-renames', `${from}...${r.head}`).stdout;
  let file = '?', line = 0, added = 0, binary = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) { file = l.slice(4).replace(/^b\//, ''); continue; }
    if (l.startsWith('--- ')) continue;
    if (/^Binary files .* differ$/.test(l)) { binary++; continue; }
    const h = /^@@ -\S+ \+(\d+)/.exec(l);
    if (h) { line = Number(h[1]); continue; }
    if (l.startsWith('+')) {
      added++;
      const text = file === IDENTITY_FILE ? withoutAllowedLines(l.slice(1), allowed) : l.slice(1);
      for (const x of scanLine(text, fp)) hits.push({ ...x, where: shown(file), line });
      line++;
    }
  }

  const log = git(cwd, 'log', '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e', ...range, '--').stdout;
  let commits = 0;
  for (const rec of log.split('\x1e')) {
    const [sha, an, ae, cn, ce, msg] = rec.replace(/^\n/, '').split('\0');
    if (!sha || msg === undefined) continue;
    commits++;
    const short = sha.slice(0, 7);
    hits.push(...scanText(withoutOwnTrailers(msg, allowed), `commit message ${short}`, fp));
    for (const [name, email] of [[an, ae], [cn, ce]]) {
      if (!allowed.names.has(name.trim())) hits.push(...scanText(name, `commit ${short} author/committer`, fp, { lines: false }));
      if (!allowed.emails.has(email.trim().toLowerCase())) hits.push(...scanText(email, `commit ${short} author/committer`, fp, { lines: false }));
    }
  }
  if (r.kind === 'pull request') {
    hits.push(...scanText(r.title, 'PR title', fp, { lines: false }));
    hits.push(...scanText(r.body, 'PR body', fp));
    hits.push(...scanText(r.ref, 'PR branch name', fp, { lines: false }));
  }
  return { hits, commits, added, files: paths.length, binary };
}

function report(hits, say = console.log) { for (const h of hits) say(`  ${label(h)}`); }
const advice = (say) => say('Replace it with a made-up value (the invented household: docs/deck/shot-data.mjs). What GitHub holds is keyed fingerprints of the owner\'s private values, never the values (docs/releasing.md, "The privacy check").');

function ciMain(args) {
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const cwd = resolve(opt('--dir') ?? process.cwd());
  let fp;
  try { fp = parseFingerprints(process.env[SECRET_NAME]); } catch (e) { console.log(`✗ privacy: incomplete — ${e.message}`); return INCOMPLETE; }
  const eventPath = opt('--event') ?? process.env.GITHUB_EVENT_PATH;
  const name = opt('--event-name') ?? process.env.GITHUB_EVENT_NAME;
  let event;
  try { event = JSON.parse(readFileSync(eventPath, 'utf8')); } catch { console.log(`✗ privacy: incomplete — the event (${eventPath ?? 'no GITHUB_EVENT_PATH'}) could not be read`); return INCOMPLETE; }
  const r = rangeOf(event, name, cwd);
  if (r.why) { console.log(`✗ privacy: incomplete — ${r.why}`); return INCOMPLETE; }
  const { hits, commits, added, files, binary } = scanRange(cwd, r, fp);
  const notCovered = `not covered: ${NOT_COVERED}${binary ? `; ${binary} binary file change(s)` : ''}`;
  if (hits.length) {
    console.log(`✗ privacy: ${hits.length} private value(s) in this ${r.kind}:`);
    report(hits); advice(console.log); console.log(notCovered);
    return FOUND;
  }
  console.log(`✓ privacy: ${r.kind} clean — ${commits} commit(s), ${added} added line(s), ${files} file name(s)${r.kind === 'pull request' ? ', the title, body and branch name' : ''}; ${fp.exact.size + fp.lower.size} fingerprints`);
  if (r.note) console.log(`note: ${r.note}`);
  console.log(notCovered);
  return CLEAN;
}

// ---- the daily watch: what is published beside the code -----------------------------
/**
 * Issues and pull requests (their titles and bodies), issue comments, review
 * comments and release notes changed in the last `days` days, through `gh
 * api` with the workflow's read-only token. GitHub not answering is incomplete.
 */
function watchMain(args) {
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  let fp;
  try { fp = parseFingerprints(process.env[SECRET_NAME]); } catch (e) { console.log(`✗ privacy watch: incomplete — ${e.message}`); return INCOMPLETE; }
  const repo = opt('--repo') ?? process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { console.log('✗ privacy watch: incomplete — no repository (--repo owner/name)'); return INCOMPLETE; }
  const days = Number(opt('--days') ?? 2);
  if (!(days > 0)) { console.error('usage: privacy-ci.mjs --watch [--days N] [--repo owner/name]'); return USAGE; }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const sources = [
    ['issues and pull requests', `repos/${repo}/issues?state=all&since=${since}&per_page=100`,
      '.[] | {w: ((if .pull_request then "pull request #" else "issue #" end) + (.number|tostring)), d: .updated_at, t: .title, b: .body} | tojson'],
    ['issue comments', `repos/${repo}/issues/comments?since=${since}&per_page=100`, '.[] | {w: ("comment " + .html_url), d: .updated_at, b: .body} | tojson'],
    ['review comments', `repos/${repo}/pulls/comments?since=${since}&per_page=100`, '.[] | {w: ("review comment " + .html_url), d: .updated_at, b: .body} | tojson'],
    ['release notes', `repos/${repo}/releases?per_page=100`, '.[] | {w: ("release " + .tag_name), d: (.published_at // .created_at), t: .name, b: .body} | tojson'],
  ];
  const hits = [], gaps = [], read = [];
  let items = 0;
  for (const [what, path, jq] of sources) {
    const r = spawnSync('gh', ['api', '--paginate', path, '--jq', jq], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.error || r.status !== 0) { gaps.push(`${what}: GitHub did not answer (${(r.stderr || String(r.error?.message ?? '')).trim().split('\n')[0] || `gh exit ${r.status}`})`); continue; }
    read.push(what);
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      let it;
      try { it = JSON.parse(line); } catch { gaps.push(`${what}: an answer that is not JSON`); break; }
      if (it.d && it.d < since) continue;
      items++;
      hits.push(...scanText(it.t ?? '', `${it.w} title`, fp, { lines: false }));
      hits.push(...scanText(it.b ?? '', `${it.w} body`, fp));
    }
  }
  const notCovered = `not covered: ${NOT_COVERED}; review summaries, discussions, wiki; anything older than ${days} day(s)`;
  if (hits.length) {
    console.log(`✗ privacy watch: ${hits.length} private value(s) published on ${repo} since ${since}:`);
    report(hits); advice(console.log);
    for (const g of gaps) console.log(`✗ incomplete: ${g}`);
    console.log(notCovered);
    return FOUND;
  }
  for (const g of gaps) console.log(`✗ incomplete: ${g}`);
  if (gaps.length) { console.log('✗ privacy watch: incomplete — not everything could be read; this is not a pass'); console.log(notCovered); return INCOMPLETE; }
  console.log(`✓ privacy watch: ${items} item(s) changed since ${since} — ${read.join(', ')} — name nothing private (${fp.exact.size + fp.lower.size} fingerprints)`);
  console.log(notCovered);
  return CLEAN;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  process.exitCode = args.includes('--watch') ? watchMain(args) : ciMain(args);
}
