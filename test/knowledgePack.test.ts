import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';

/**
 * The knowledge pack (docs/troubleshooting.md, docs/architecture-map.md):
 * shipped with every release for the Hatchabot agent to diagnose from. A pack
 * that names a file or function that moved sends the agent the wrong way, so
 * every path must exist and every symbol must still be in its file; a "Fixed
 * in" must be a real release. Both are public: no addresses of any kind.
 */
const PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*(\/|\.(ts|mjs|cjs|js|sh|md|html|json|yml|yaml|service|timer|example|plist|runtime))$/;
const read = (p: string) => readFileSync(p, 'utf8');
const releases = new Set([...read('CHANGELOG.md').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]));

/** Backticked tokens in order, grouped: a path, then the symbols that must be in it. */
function refs(text: string): Array<{ path: string; symbols: string[] }> {
  const out: Array<{ path: string; symbols: string[] }> = [];
  for (const [, tok] of text.matchAll(/`([^`]+)`/g)) {
    if (PATH.test(tok!) && !tok!.startsWith('/')) out.push({ path: tok!, symbols: [] });
    else if (out.length) out.at(-1)!.symbols.push(tok!);
  }
  return out;
}
function checkRefs(where: string, text: string, bad: string[]) {
  for (const { path, symbols } of refs(text)) {
    const st = existsSync(path) ? statSync(path) : undefined;
    if (!st) { bad.push(`${where}: no ${path}`); continue; }
    if (st.isDirectory()) continue;
    const src = read(path);
    for (const s of symbols) if (!src.includes(s)) bad.push(`${where}: \`${s}\` is not in ${path}`);
  }
}
const PUBLIC = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, 'an email address'],
  [/\b(10|192\.168|172\.(1[6-9]|2\d|3[01])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))(\.\d{1,3}){2,3}\b/, 'a private IP address'],
  [/\.ts\.net\b/, 'a Tailscale name'],
] as const;

describe('docs/troubleshooting.md', () => {
  const doc = existsSync('docs/troubleshooting.md') ? read('docs/troubleshooting.md') : '';
  const entries = doc.split(/^### /m).slice(1);

  it('exists, with entries', () => {
    expect(doc, 'docs/troubleshooting.md is missing').not.toBe('');
    expect(entries.length).toBeGreaterThanOrEqual(20);
  });

  it('every entry says how to check, the cause, the fix, when it was fixed and where the code is', () => {
    const bad: string[] = [];
    for (const e of entries) {
      const title = e.split('\n')[0]!.slice(0, 70);
      for (const f of ['Check', 'Cause', 'Fix', 'Fixed in', 'Code']) if (!new RegExp(`^- \\*\\*${f}:\\*\\*`, 'm').test(e)) bad.push(`${title}: no ${f}`);
      const fixed = /^- \*\*Fixed in:\*\*\s*(.*)$/m.exec(e)?.[1] ?? '';
      for (const [, v] of fixed.matchAll(/`v(\d+\.\d+\.\d+)`/g)) if (!releases.has(v!)) bad.push(`${title}: v${v} is not a release in CHANGELOG.md`);
      if (fixed && !/`v\d+\.\d+\.\d+`|—/.test(fixed)) bad.push(`${title}: Fixed in is a version in backticks or —`);
      const code = /^- \*\*Code:\*\*\s*(.*)$/m.exec(e)?.[1] ?? '';
      if (code && !refs(code).length) bad.push(`${title}: Code names no file`);
      checkRefs(title, code, bad);
    }
    expect(bad).toEqual([]);
  });

  it('is public: no addresses', () => {
    for (const [re, what] of PUBLIC) expect(re.test(doc), `troubleshooting.md has ${what}: ${re.exec(doc)?.[0]}`).toBe(false);
  });
});

describe('docs/architecture-map.md', () => {
  const doc = existsSync('docs/architecture-map.md') ? read('docs/architecture-map.md') : '';

  it('exists, with sections', () => {
    expect(doc, 'docs/architecture-map.md is missing').not.toBe('');
    expect(doc.match(/^## /gm)?.length ?? 0).toBeGreaterThanOrEqual(8);
  });

  it('every file it names exists, and every symbol after a file is in it', () => {
    const bad: string[] = [];
    for (const line of doc.split('\n')) {
      if (!/^\s*- `/.test(line)) continue;
      // The symbols end where the description starts: the first ": " after a backtick.
      const head = line.split(/`:\s/)[0]! + '`';
      checkRefs(line.trim().slice(0, 60), head, bad);
    }
    expect(bad).toEqual([]);
  });

  it('is public: no addresses', () => {
    for (const [re, what] of PUBLIC) expect(re.test(doc), `architecture-map.md has ${what}: ${re.exec(doc)?.[0]}`).toBe(false);
  });
});
