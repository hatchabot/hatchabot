import { readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname, homedir, userInfo } from 'node:os';
import { join, normalize, relative, resolve, sep } from 'node:path';
import { redactSecrets } from '../domain/redact.js';

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

/** What makes a home machine identifiable, for a PUBLIC issue: on top of redactSecrets. */
export interface PublicRedactContext { home?: string; user?: string; host?: string }

export function localContext(): PublicRedactContext {
  let user: string | undefined;
  try { user = userInfo().username; } catch { /* no passwd entry */ }
  return { home: homedir(), user, host: hostname() };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPrivateV4 = (a: number, b: number) =>
  a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);

/**
 * Blunt on purpose, like redactSecrets: an issue is public and permanent, so a
 * harmless path masked is the right side to err on. The person still reviews
 * every line before it goes anywhere.
 */
export function redactForPublic(text: string, ctx: PublicRedactContext = localContext()): string {
  let out = redactSecrets(text);
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
  return out;
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
export function buildReport(input: ReportInput, facts: ReportFacts, ctx?: PublicRedactContext): { title: string; body: string } {
  const r = (s: string) => redactForPublic(s, ctx);
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

/** A repo-relative path inside the readable set, or an Error saying why not. */
export function sourcePath(appDir: string, path: string): string {
  const rel = normalize(String(path ?? '').replace(/^\.?\/+/, ''));
  if (!rel || rel.startsWith('..') || rel.includes(`${sep}..${sep}`) || rel.startsWith(sep)) throw new Error('A path inside the Hatchabot source, like src/api/routes.ts.');
  const top = rel.split(sep)[0]!;
  if (!SOURCE_ROOTS.includes(top) && !SOURCE_FILES.includes(rel)) {
    throw new Error(`Only the source and docs: ${[...SOURCE_ROOTS.map((r) => `${r}/`), ...SOURCE_FILES].join(', ')}.`);
  }
  const abs = resolve(appDir, rel);
  if (relative(resolve(appDir), abs).startsWith('..')) throw new Error('Outside the source.');
  return abs;
}

export function readSource(appDir: string, path: string, from = 1, to?: number): { path: string; from: number; to: number; lines: number; text: string } {
  const abs = sourcePath(appDir, path);
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) throw new Error(`No file ${path} in this release.`);
  if (st.isDirectory()) {
    const names = readdirSync(abs, { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort();
    return { path, from: 1, to: names.length, lines: names.length, text: names.join('\n') };
  }
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
 * Lines matching a regular expression (case-insensitive), across the readable
 * set or under one folder. The knowledge pack comes first, with its own room
 * (`packLimit`): a broad search ("400", a model id) filled the 40 lines with
 * code before it reached docs/, and the Hatchabot agent never saw the playbook
 * entry that answered the question (2026-10-07). A playbook line carries the
 * entry it belongs to.
 */
export function searchSource(appDir: string, query: string, under?: string, limit = 40, packLimit = 15): {
  matches: Array<{ path: string; line: number; text: string; entry?: string }>; more: boolean;
} {
  let re: RegExp;
  try { re = new RegExp(String(query ?? ''), 'i'); } catch { re = new RegExp(esc(String(query ?? '')), 'i'); }
  if (!String(query ?? '').trim()) throw new Error('Say what to look for.');
  const rest = under ? [sourcePath(appDir, under)] : ['docs', 'README.md', ...SOURCE_ROOTS.filter((r) => r !== 'docs'), ...SOURCE_FILES.filter((f) => f !== 'README.md')].map((p) => join(appDir, p));
  const pack = PACK.map((p) => join(appDir, p)).filter((abs) => !under || abs === rest[0] || abs.startsWith(rest[0] + sep));
  const matches: Array<{ path: string; line: number; text: string; entry?: string }> = [];
  const seen = new Set<string>();
  let more = false;
  const scan = (abs: string, cap: () => boolean): void => {
    seen.add(abs);
    const lines = readFileSync(abs, 'utf8').split('\n');
    let entry: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('### ')) entry = lines[i]!.slice(4).trim();
      if (!re.test(lines[i]!)) continue;
      if (cap()) { more = true; return; }
      matches.push({ path: relative(appDir, abs), line: i + 1, text: clip(lines[i]!.trim(), 200), ...(entry && abs.endsWith(PLAYBOOK) ? { entry: clip(entry, 160) } : {}) });
    }
  };
  for (const abs of pack) if (statSync(abs, { throwIfNoEntry: false })?.isFile()) { let n = 0; scan(abs, () => n++ >= packLimit); more = false; }
  const fromPack = matches.length;
  const visit = (abs: string): void => {
    if (more || seen.has(abs)) return;
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isDirectory()) {
      for (const d of readdirSync(abs).sort()) { if (d !== 'node_modules' && !d.startsWith('.')) visit(join(abs, d)); if (more) return; }
      return;
    }
    if (st.size > MAX_FILE || !/\.(ts|mjs|cjs|js|sh|md|html|json|yml|yaml|txt|example|service|timer|plist|conf)$|\/[A-Za-z]+file[^/]*$|\.runtime$/.test(abs) && !SOURCE_FILES.some((f) => abs.endsWith(f))) return;
    scan(abs, () => matches.length - fromPack >= limit);
  };
  for (const s of rest) visit(s);
  return { matches, more };
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

