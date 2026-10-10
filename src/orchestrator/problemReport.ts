import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname, homedir, userInfo } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { maskKnownValues, redactSecrets } from '../domain/redact.js';

/**
 * "Report a problem" (docs/field-reports.md): the manager agent — or the
 * person, from ⚙ — writes what happened and, when it can, a diagnosis and a
 * patch against the release installed here; Hatchabot adds the facts (version,
 * doctor, recent failures, an agent's log tail), strips what must not be
 * public, and keeps it as a private draft. Only the person sends it: a GitHub
 * issue they open themselves, pre-filled, or a file. Nothing here posts.
 */

export const REPORT_SLUG = 'hatchabot/hatchabot';
export const REPORT_FORMAT = 'hatchabot-report v1';

/**
 * What makes a home machine identifiable, for a PUBLIC issue: on top of redactSecrets.
 * `names` (agents' names and slugs, members' names), `hosts` (machine names) and
 * `secrets` (known credential values) are what the app knows is private: the
 * patterns alone let an agent's name in a log line through (security audit,
 * 2026-10-09). Held for one call, never stored or logged.
 */
export interface PublicRedactContext {
  home?: string; user?: string; host?: string;
  names?: Iterable<string>; hosts?: Iterable<string>; secrets?: Iterable<string>;
}

export function localContext(): PublicRedactContext {
  let user: string | undefined;
  try { user = userInfo().username; } catch { /* no passwd entry */ }
  return { home: homedir(), user, host: hostname() };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPrivateV4 = (a: number, b: number) =>
  a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
// Never masked as a private name: the manager's own names, and the words the masks and headings are made of.
const NOT_PRIVATE = /^(hatchabot([ -](agent|manager))?|openclaw|agent|name|host|user|bot|email)$/i;

/**
 * Private words masked as whole words, longest first. In any case from 6
 * characters; a shorter name ("To Do") only as written, or every "to do" in
 * the prose would go too.
 */
function maskWords(text: string, words: Iterable<string> | undefined, as: string): string {
  const list = [...new Set([...(words ?? [])].map((w) => String(w ?? '').trim()).filter((w) => w.length >= 3 && !NOT_PRIVATE.test(w)))]
    .sort((a, b) => b.length - a.length).slice(0, 2000);
  let out = text;
  for (const [group, flags] of [[list.filter((w) => w.length >= 6), 'gi'], [list.filter((w) => w.length < 6), 'g']] as const) {
    if (group.length) out = out.replace(new RegExp(`(?<![A-Za-z0-9_])(?:${group.map(esc).join('|')})(?![A-Za-z0-9_])`, flags), as);
  }
  return out;
}

/**
 * Blunt on purpose, like redactSecrets: an issue is public and permanent, so a
 * harmless path masked is the right side to err on. The person still reviews
 * every line before it goes anywhere.
 */
export function redactForPublic(text: string, ctx: PublicRedactContext = localContext()): string {
  let out = redactSecrets(maskKnownValues(text, ctx.secrets));
  if (ctx.home && ctx.home.length > 1) out = out.replace(new RegExp(esc(ctx.home), 'g'), '~');
  out = out
    .replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, '<email>')                                          // addresses, incl. ssh user@host
    .replace(/\b[\w-]+(\.[\w-]+)*\.ts\.net\b/g, '<tailnet-host>')                                   // Tailscale names
    // Whole addresses only ("00:23:10.123" in a timestamp is not one), and only private ones.
    .replace(/\b(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, (m, a: string, b: string) => (isPrivateV4(+a, +b) ? '<private-ip>' : m))
    // A Telegram bot's username (they all end in "bot"): public, so anyone could write to it. Not our own name.
    .replace(/@?\b(?!hatchabot\b)[A-Za-z][A-Za-z0-9_]{2,}bot\b/gi, '<bot>');
  if (ctx.user && ctx.user.length >= 3) out = out.replace(new RegExp(`\\b${esc(ctx.user)}\\b`, 'g'), '<user>');
  if (ctx.host && ctx.host.length >= 3 && ctx.host !== 'localhost') out = out.replace(new RegExp(`\\b${esc(ctx.host)}\\b`, 'g'), '<host>');
  out = maskWords(out, [...(ctx.hosts ?? [])].filter((h) => h !== 'localhost'), '<host>');
  return maskWords(out, ctx.names, '<name>');
}

export interface ReportInput {
  title: string;
  whatHappened: string;
  steps?: string;
  diagnosis?: string;
  confidence?: 'low' | 'medium' | 'high';
  /** A unified diff against the installed release, paths from the repo root. */
  suggestedPatch?: string;
  /** Who wrote the words: the person, or the manager agent on their behalf. */
  by: 'person' | 'agent';
}

export interface ReportFacts {
  version: string;
  /** "bundle linux-arm64", "git", … */
  install: string;
  platform: string;
  node: string;
  openclaw?: string;
  doctor?: Array<{ level: string; text: string; fix?: string }>;
  /** `agent` is for the manager agent (diagnostics); a public report leaves names out. */
  failures?: Array<{ at: string; event: string; agent?: string; detail?: string }>;
  agent?: { name: string; state: string; reason?: string; model?: string; image?: string; onRunner?: boolean; logs?: string };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fence = (s: string, lang = '') => `\`\`\`${lang}\n${s.replace(/```/g, "'''")}\n\`\`\``;

/** The issue body: the person's (or agent's) words, then the facts. Redacted for public use. */
export function buildReport(input: ReportInput, facts: ReportFacts, ctx: PublicRedactContext = localContext()): { title: string; body: string } {
  // The agent it is about is private wherever it turns up — its log, the prose, the patch — not only in the facts.
  const own = { ...ctx, names: [...(ctx.names ?? []), ...(facts.agent?.name ? [facts.agent.name] : [])] };
  const r = (s: string) => redactForPublic(s, own);
  const parts: string[] = [];
  parts.push(`<!-- ${REPORT_FORMAT} version=${facts.version} install=${facts.install.replace(/\s+/g, '-')} -->`);
  parts.push('### What happened', r(clip(input.whatHappened.trim(), 4000)));
  if (input.steps?.trim()) parts.push('### Steps to reproduce', r(clip(input.steps.trim(), 2000)));
  if (input.diagnosis?.trim()) {
    parts.push(`### Diagnosis${input.by === 'agent' ? ' (by the Hatchabot agent on this machine' + (input.confidence ? ` — confidence: ${input.confidence}` : '') + ')' : ''}`, r(clip(input.diagnosis.trim(), 5000)));
  }
  if (input.suggestedPatch?.trim()) {
    parts.push(`### Suggested fix (against ${facts.version})`, fence(r(clip(input.suggestedPatch.trim(), 12000)), 'diff'));
  }
  const env = [`- Hatchabot ${facts.version} (${facts.install}) · ${facts.platform} · Node ${facts.node}${facts.openclaw ? ` · OpenClaw ${facts.openclaw}` : ''}`];
  if (facts.agent) {
    const a = facts.agent;
    env.push(`- Agent: ${a.state}${a.reason ? ` — ${clip(a.reason, 300)}` : ''}${a.model ? ` · ${a.model}` : ''}${a.image ? ` · image ${a.image}` : ''}${a.onRunner ? ' · on a runner' : ''}`);
  }
  parts.push('### Environment', r(env.join('\n')));
  if (facts.doctor?.length) {
    const mark = (l: string) => (l === 'ok' ? '✓' : l === 'warn' ? '⚠' : l === 'fail' ? '✗' : '·');
    parts.push('### hatchabot doctor', fence(r(facts.doctor.map((d) => `${mark(d.level)} ${d.text}${d.fix && d.level !== 'ok' ? `\n    → ${d.fix}` : ''}`).join('\n'))));
  }
  if (facts.failures?.length) {
    parts.push('### Recent failures (last 3 days)', fence(r(facts.failures.slice(0, 15).map((f) => `${f.at.slice(0, 16).replace('T', ' ')}  ${f.event}${f.detail ? `  ${clip(f.detail, 200)}` : ''}`).join('\n'))));
  }
  if (facts.agent?.logs?.trim()) parts.push('### Agent log (last lines)', fence(r(clip(facts.agent.logs.trim(), 6000))));
  parts.push(`<sub>Prepared with Hatchabot's Report a problem${input.by === 'agent' ? ' by the Hatchabot agent' : ''}, and reviewed by the person who sent it.</sub>`);
  return { title: r(clip(input.title.trim(), 120)), body: parts.join('\n\n') };
}

/**
 * The pre-filled "new issue" link. GitHub refuses very long URLs, so past
 * `max` the long sections are cut from the LINK (never from the draft) and a
 * line asks for the saved file to be attached.
 */
export function issueUrl(title: string, body: string, opts: { slug?: string; max?: number; file?: string } = {}): { url: string; trimmed: boolean } {
  const base = `https://github.com/${opts.slug ?? REPORT_SLUG}/issues/new?labels=field-report`;
  const make = (b: string) => `${base}&title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
  const max = opts.max ?? 7500;
  if (make(body).length <= max) return { url: make(body), trimmed: false };
  const note = `\n\n> **The full report is in the attached file** (\`${opts.file ?? 'hatchabot-report.md'}\`) — this link was too long for GitHub. Drag the file into this box to attach it.`;
  // Drop the bulkiest sections first, then cut what is left.
  let b = body;
  for (const h of ['### Agent log (last lines)', '### Recent failures (last 3 days)', '### hatchabot doctor', '### Suggested fix']) {
    if (make(b + note).length <= max) break;
    const i = b.indexOf(h);
    if (i < 0) continue;
    const j = b.indexOf('\n### ', i + h.length);
    const sub = b.lastIndexOf('\n\n<sub>');
    b = b.slice(0, i) + `${h} — in the attached file` + (j >= 0 ? b.slice(j) : sub > i ? b.slice(sub) : '');
  }
  while (make(b + note).length > max && b.length > 200) b = b.slice(0, Math.floor(b.length * 0.85));
  return { url: make(b + note), trimmed: true };
}

// ---- the installed source, read-only -------------------------------------
// The code and docs of the release on this machine, so the agent can diagnose
// against what actually runs and answer settings questions from the docs.
// Never the install's own state: .env, data, backups, node_modules, .git.

const SOURCE_ROOTS = ['src', 'web', 'scripts', 'docs', 'bin', 'docker', 'deploy', 'test'];
const SOURCE_FILES = ['README.md', 'CHANGELOG.md', 'package.json', 'install.sh', '.env.example', 'channels.json'];
const MAX_FILE = 2 * 1024 * 1024;

const inReadableSet = (rel: string) => SOURCE_ROOTS.includes(rel.split(sep)[0]!) || SOURCE_FILES.includes(rel);

/** The lexical check: a repo-relative path naming the readable set. */
function lexicalPath(appDir: string, path: string): string {
  const rel = normalize(String(path ?? '').replace(/^\.?\/+/, ''));
  if (!rel || rel.startsWith('..') || rel.includes(`${sep}..${sep}`) || rel.startsWith(sep)) throw new Error('A path inside the Hatchabot source, like src/api/routes.ts.');
  if (!inReadableSet(rel)) {
    throw new Error(`Only the source and docs: ${[...SOURCE_ROOTS.map((r) => `${r}/`), ...SOURCE_FILES].join(', ')}.`);
  }
  const abs = resolve(appDir, rel);
  if (relative(resolve(appDir), abs).startsWith('..')) throw new Error('Outside the source.');
  return abs;
}

/**
 * The real file or folder behind a path, when THAT is in the readable set.
 * A link is followed and its target checked, not its name: a link under src/
 * to .env or outside the install read what it pointed at (security audit,
 * 2026-10-09). A link to somewhere else in the source is fine. undefined: not
 * there, a loop, or outside.
 */
function realInside(realRoot: string, abs: string): string | undefined {
  let real: string;
  try { real = realpathSync(abs); } catch { return undefined; }
  const rel = relative(realRoot, real);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return inReadableSet(rel) ? real : undefined;
}
const realRootOf = (appDir: string): string => { try { return realpathSync(appDir); } catch { return resolve(appDir); } };

/** A path inside the readable set — as resolved, links followed — or an Error saying why not. */
export function sourcePath(appDir: string, path: string): string {
  const abs = lexicalPath(appDir, path);
  let real: string;
  try { real = realpathSync(abs); } catch {
    // Not there (readSource says so) — or a link that leads nowhere or round in a loop: refused.
    let link = false;
    try { link = lstatSync(abs).isSymbolicLink(); } catch { /* not there */ }
    if (link) throw new Error('Outside the source.');
    return abs;
  }
  if (!realInside(realRootOf(appDir), real)) throw new Error('Outside the source.');
  return real;
}

export function readSource(appDir: string, path: string, from = 1, to?: number): { path: string; from: number; to: number; lines: number; text: string } {
  const abs = sourcePath(appDir, path);
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) throw new Error(`No file ${path} in this release.`);
  if (st.isDirectory()) {
    // A link in the folder that leads out of the source is not listed either.
    const realRoot = realRootOf(appDir);
    const names = readdirSync(abs, { withFileTypes: true }).filter((d) => !d.isSymbolicLink() || realInside(realRoot, join(abs, d.name)))
      .map((d) => (d.isDirectory() || (d.isSymbolicLink() && statSync(join(abs, d.name), { throwIfNoEntry: false })?.isDirectory()) ? `${d.name}/` : d.name)).sort();
    return { path, from: 1, to: names.length, lines: names.length, text: names.join('\n') };
  }
  if (!st.isFile()) throw new Error(`${path} is not a file.`);
  if (st.size > MAX_FILE) throw new Error(`${path} is too big to read here.`);
  const all = readFileSync(abs, 'utf8').split('\n');
  const a = Math.max(1, Math.floor(from) || 1);
  const b = Math.min(all.length, to && to >= a ? Math.floor(to) : a + 399, a + 399);
  return { path, from: a, to: b, lines: all.length, text: all.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n') };
}

/** The knowledge pack: searched before anything else (AGENTS.md). */
export const PLAYBOOK = 'docs/troubleshooting.md';
const PACK = [PLAYBOOK, 'docs/architecture-map.md'];

/**
 * The bounds of one search (security audit, 2026-10-09): a pattern that
 * backtracks without end held the server's one thread, for every account.
 * The scan runs in a worker thread that is stopped at `ms`, over at most
 * `files` files and `bytes` bytes; a query is at most `query` characters, and
 * only so many searches run at once, per caller and in all.
 */
export const SEARCH_LIMITS = { query: 300, files: 5000, bytes: 48 * 1024 * 1024, line: 4000, ms: 3000, perCaller: 2, total: 6 };
let running = 0;
const runningFor = new Map<string, number>();
/** Searches running now (their workers alive): for tests. */
export const searchesRunning = (): number => running;

// The scan itself, run in the worker: plain JavaScript, no imports from the app.
const SEARCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { readFileSync } = require('node:fs');
const { files, query, regex, limit, packLimit, line: maxLine, playbook, truncated } = workerData;
const re = regex ? new RegExp(query, 'i') : null;
const lower = query.toLowerCase();
const hit = re ? (l) => re.test(l.length > maxLine ? l.slice(0, maxLine) : l) : (l) => l.toLowerCase().includes(lower);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '\\u2026' : s);
const matches = [];
let more = false, fromPack = 0;
for (const f of files) {
  if (!f.pack && more) break;
  let text;
  try { text = readFileSync(f.real, 'utf8'); } catch { continue; }
  const lines = text.split('\\n');
  let entry, n = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('### ')) entry = lines[i].slice(4).trim();
    if (!hit(lines[i])) continue;
    if (f.pack ? n++ >= packLimit : matches.length - fromPack >= limit) { if (!f.pack) more = true; break; }
    matches.push(Object.assign({ path: f.rel, line: i + 1, text: clip(lines[i].trim(), 200) }, entry && f.rel === playbook ? { entry: clip(entry, 160) } : {}));
  }
  if (f.pack) fromPack = matches.length;
}
parentPort.postMessage({ matches, more: more || truncated });
`;

/**
 * Lines containing the query (case-insensitive), across the readable set or
 * under one folder; `regex` for a regular expression. The knowledge pack
 * comes first, with its own room (`packLimit`): a broad search ("400", a model
 * id) filled the 40 lines with code before it reached docs/, and the
 * Hatchabot agent never saw the playbook entry that answered the question
 * (2026-10-07). A playbook line carries the entry it belongs to.
 *
 * Plain text by default, a regular expression only when asked, and either way
 * in a worker stopped at the time limit (SEARCH_LIMITS, 2026-10-09).
 */
export async function searchSource(appDir: string, query: string, under?: string, limit = 40, packLimit = 15,
  opts: { regex?: boolean; caller?: string; ms?: number } = {}): Promise<{
  matches: Array<{ path: string; line: number; text: string; entry?: string }>; more: boolean;
}> {
  const q = String(query ?? '');
  if (!q.trim()) throw new Error('Say what to look for.');
  if (q.length > SEARCH_LIMITS.query) throw new Error(`At most ${SEARCH_LIMITS.query} characters to look for.`);
  let regex = !!opts.regex;
  if (regex) { try { new RegExp(q, 'i'); } catch { regex = false; } } // not a valid expression: looked for as written
  const files = sourceFiles(appDir, under);
  const caller = opts.caller ?? '';
  if (running >= SEARCH_LIMITS.total || (runningFor.get(caller) ?? 0) >= SEARCH_LIMITS.perCaller) {
    throw new Error('Other searches are running: try again in a few seconds.');
  }
  running++;
  runningFor.set(caller, (runningFor.get(caller) ?? 0) + 1);
  const done = () => {
    running--;
    const n = (runningFor.get(caller) ?? 1) - 1;
    if (n > 0) runningFor.set(caller, n); else runningFor.delete(caller);
  };
  let worker: Worker;
  try {
    worker = new Worker(SEARCH_WORKER, {
      eval: true,
      workerData: { files: files.list, query: q, regex, limit, packLimit, line: SEARCH_LIMITS.line, playbook: PLAYBOOK, truncated: files.truncated },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
  } catch (e) { done(); throw e; }
  return new Promise((ok, no) => {
    let settled = false;
    const finish = (err?: Error, value?: { matches: Array<{ path: string; line: number; text: string; entry?: string }>; more: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) no(err); else ok(value!);
    };
    // Stopped, not abandoned: terminate() ends the thread mid-match, so the work ends with the request.
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(new Error(`The search took longer than ${Math.round((opts.ms ?? SEARCH_LIMITS.ms) / 1000)} s and was stopped: look for plain text, or a simpler expression.`));
    }, opts.ms ?? SEARCH_LIMITS.ms);
    worker.once('message', (m) => { finish(undefined, m); void worker.terminate(); });
    worker.once('error', (e: Error) => finish(new Error(`The search failed: ${e.message}`)));
    worker.once('exit', () => { done(); finish(new Error('The search stopped.')); });
  });
}

/**
 * The files a search reads, in order: the knowledge pack, then the rest.
 * Each one as resolved — a link counts as where it leads, and a folder
 * reached twice (a link loop, or a link to a folder already searched) is
 * searched once (2026-10-09). Bounded in files and bytes.
 */
function sourceFiles(appDir: string, under?: string): { list: Array<{ real: string; rel: string; pack: boolean }>; truncated: boolean } {
  const realRoot = realRootOf(appDir);
  const rest = under ? [lexicalPath(appDir, under)] : ['docs', 'README.md', ...SOURCE_ROOTS.filter((r) => r !== 'docs'), ...SOURCE_FILES.filter((f) => f !== 'README.md')].map((p) => join(appDir, p));
  if (under && statSync(rest[0]!, { throwIfNoEntry: false }) && !realInside(realRoot, rest[0]!)) throw new Error('Outside the source.');
  const pack = PACK.map((p) => join(appDir, p)).filter((abs) => !under || abs === rest[0] || abs.startsWith(rest[0] + sep));
  const list: Array<{ real: string; rel: string; pack: boolean }> = [];
  const seen = new Set<string>();
  let bytes = 0, truncated = false;
  const visit = (abs: string, isPack: boolean): void => {
    if (truncated) return;
    const real = realInside(realRoot, abs);
    if (!real || seen.has(real)) return;
    seen.add(real);
    const st = statSync(real, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const d of readdirSync(real).sort()) { if (d !== 'node_modules' && !d.startsWith('.')) visit(join(abs, d), false); if (truncated) return; }
      return;
    }
    // Only regular files: a pipe or a device would block the read.
    if (!st.isFile() || st.size > MAX_FILE || !/\.(ts|mjs|cjs|js|sh|md|html|json|yml|yaml|txt|example|service|timer|plist|conf)$|\/[A-Za-z]+file[^/]*$|\.runtime$/.test(abs) && !SOURCE_FILES.some((f) => abs.endsWith(f))) return;
    if (list.length >= SEARCH_LIMITS.files || bytes + st.size > SEARCH_LIMITS.bytes) { truncated = true; return; }
    bytes += st.size;
    list.push({ real, rel: relative(appDir, abs), pack: isPack });
  };
  for (const abs of pack) visit(abs, true);
  for (const s of rest) visit(s, false);
  return { list, truncated };
}

/**
 * Known problems this report may be: playbook entries sharing a quoted phrase
 * (an error message, a log line) with the report, either way round. The
 * Hatchabot agent drafted a public bug report — with a wrong diagnosis — for a
 * problem the playbook already explained (2026-10-07); now the draft says so,
 * to the agent and in the review panel.
 */
export function knownProblems(appDir: string, text: string, max = 3): Array<{ title: string; fixedIn?: string }> {
  let doc = '';
  try { doc = readFileSync(join(appDir, PLAYBOOK), 'utf8'); } catch { return []; }
  const norm = (v: string) => v.toLowerCase().replace(/[“”‘’]/g, "'").replace(/\s+/g, ' ').replace(/^[\s.,;:]+|[\s.,;:]+$/g, '');
  const quoted = (v: string) => [...v.matchAll(/"([^"\n]{10,240})"|'([^'\n]{10,240})'|`([^`\n]{10,240})`|“([^”\n]{10,240})”/g)]
    .map((m) => norm(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '')).filter((q) => q.length >= 10);
  const mine = norm(text), myPhrases = quoted(text);
  const out: Array<{ title: string; fixedIn?: string }> = [];
  for (const block of doc.split(/^### /m).slice(1)) {
    const title = block.split('\n')[0]!.trim();
    const body = norm(block);
    const hit = quoted(title).some((q) => mine.includes(q)) || myPhrases.some((q) => body.includes(q));
    if (!hit) continue;
    const fixed = /^- \*\*Fixed in:\*\*\s*`?(v[\d.]+)`?/m.exec(block)?.[1];
    out.push({ title, ...(fixed ? { fixedIn: fixed } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

const STOP = new Set(('about after again agent agents also because before being could every from have into just more most only other over same some such than that their them then there these they this those through when where which while with would your yours what does still after hatchabot').split(' '));
const versionParts = (v: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
/** a > b, as release versions. */
export function newerRelease(a: string, b: string): boolean {
  const x = versionParts(a), y = versionParts(b);
  if (x.length < 3 || y.length < 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/**
 * The playbook entries a symptom most likely is, best first, each in full (the
 * Hatchabot agent's check_known_problem). Scored on what a person or a log
 * actually shows: a quoted message shared either way (strongest), runs of
 * three words in common, then the distinctive words of the entry's title. A
 * weak overlap is not returned: no entry is better than a wrong one.
 */
export function matchKnownProblems(appDir: string, symptom: string, installed: string, max = 3): {
  installed: string;
  matches: Array<{ title: string; score: number; fixedIn?: string; fixedInNewerRelease?: boolean; text: string }>;
} {
  let doc = '';
  try { doc = readFileSync(join(appDir, PLAYBOOK), 'utf8'); } catch { return { installed, matches: [] }; }
  const norm = (v: string) => v.toLowerCase().replace(/[“”‘’]/g, "'").replace(/[^a-z0-9.'"`/:_ -]+/g, ' ').replace(/\s+/g, ' ').trim();
  const quoted = (v: string) => [...v.matchAll(/"([^"\n]{8,240})"|'([^'\n]{8,240})'|`([^`\n]{8,240})`|“([^”\n]{8,240})”/g)]
    .map((m) => norm(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '')).filter((q) => q.length >= 8);
  const words = (v: string) => norm(v).replace(/['"`]/g, ' ').split(' ').filter(Boolean);
  const sym = norm(symptom), symWords = words(symptom), symQuoted = quoted(symptom);
  const shingles = new Set(symWords.slice(0, -2).map((_, i) => symWords.slice(i, i + 3).join(' ')).filter((g) => g.replace(/ /g, '').length >= 9));
  const symKeys = new Set(symWords.filter((w) => w.length >= 4 && !STOP.has(w)));
  const scored: Array<{ title: string; score: number; fixedIn?: string; fixedInNewerRelease?: boolean; text: string }> = [];
  for (const block of doc.split(/^### /m).slice(1)) {
    const title = block.split('\n')[0]!.trim();
    const body = norm(block), bodyPlain = words(block).join(' ');
    let score = 0;
    for (const q of quoted(title)) if (sym.includes(q)) score += 12;
    for (const q of symQuoted) if (body.includes(q)) score += 12;
    for (const g of shingles) if (bodyPlain.includes(g)) score += 2;
    for (const w of new Set(words(title).filter((x) => x.length >= 4 && !STOP.has(x)))) if (symKeys.has(w)) score += 1;
    if (score < 5) continue;
    const fixedIn = /^- \*\*Fixed in:\*\*\s*`?(v[\d.]+)`?/m.exec(block)?.[1];
    scored.push({ title, score, ...(fixedIn ? { fixedIn, fixedInNewerRelease: newerRelease(fixedIn, installed) } : {}), text: `### ${block.trim()}` });
  }
  scored.sort((a, b) => b.score - a.score);
  return { installed, matches: scored.slice(0, max) };
}

