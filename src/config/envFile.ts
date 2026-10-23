import { ENV_GROUPS, ENV_SETTINGS, type EnvSetting } from './envCatalog.js';

/**
 * .env rebuilt from the catalog (Chris, 2026-09-29): every setting listed,
 * in groups, with what it does. A value the owner set stays in force exactly
 * as written; every other setting is a commented line with its default (or a
 * commented example the owner wrote there). Lines Hatchabot doesn't know —
 * DOCKER_HOST, pre-rename AGENTCLAW_* names — are kept, with the comments just
 * above them, under "Other settings".
 *
 * The one rule that matters: the settings in force never change. `syncEnv`
 * refuses to write unless the new file's active values equal the old file's.
 */

const LINE = /^\s*(#\s*)?([A-Z][A-Z0-9_]*)\s*=(.*)$/;

/** The values in force: the LAST uncommented KEY= line per name (systemd and the shell both take the last). */
export function activeValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (m && !m[1]) out.set(m[2]!, m[3]!);
  }
  return out;
}

/** `export NAME=value`: a shell-sourced file (the macOS launcher) assigns it in place, in order. */
const EXPORTED = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/**
 * The values a shell sourcing the file ends with: plain and exported
 * assignments alike, the last per name. The tidy moves `export` lines under
 * "Other settings", after the plain ones: an `export PORT=1` above a later
 * `PORT=2` would then win (#221), though every line compares equal.
 */
function sourcedValues(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (m) { if (!m[1]) out.set(m[2]!, m[3]!); continue; }
    const e = EXPORTED.exec(line);
    if (e) out.set(e[1]!, e[2]!);
  }
  return out;
}

interface Parsed {
  active: Map<string, string>;
  /** A commented `# NAME=value` the owner wrote, per name (the last one). */
  commented: Map<string, string>;
  /** The owner's own comments above a known setting (not its generated description). */
  notes: Map<string, string[]>;
  /** Unknown active lines, in order, with the comment lines just above each. */
  others: Array<{ name: string; value: string; notes: string[] }>;
  /** Lines that are no KEY=VALUE at all (`export X=1`, stray text): kept verbatim, never dropped. */
  raw: Array<{ line: string; notes: string[] }>;
}

/** Lines that are neither blank, a comment nor KEY=VALUE: what a rewrite must carry over untouched. */
function rawLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim() !== '' && !/^\s*#/.test(l) && !LINE.test(l));
}

const MARK = '# ~~';  // generated section rules start with this

function parse(text: string, known: Set<string>): Parsed {
  const active = activeValues(text);
  const commented = new Map<string, string>();
  const ownNotes = new Map<string, string[]>();
  const others: Parsed['others'] = [];
  const raw: Parsed['raw'] = [];
  const seenOther = new Set<string>();
  let notes: string[] = [];
  for (const line of text.split('\n')) {
    const m = LINE.exec(line);
    if (m) {
      const name = m[2]!;
      if (known.has(name)) {
        const generated = new Set(helpLines(name));
        const mine = notes.filter((n) => !generated.has(n));
        if (mine.length) ownNotes.set(name, mine);
      }
    }
    if (m && m[1]) { commented.set(m[2]!, m[3]!); notes = []; continue; }
    if (m) {
      const name = m[2]!;
      if (!known.has(name) && !seenOther.has(name)) {
        seenOther.add(name);
        others.push({ name, value: active.get(name)!, notes });
      }
      notes = [];
      continue;
    }
    if (line.trim() !== '' && !/^\s*#/.test(line)) { raw.push({ line, notes }); notes = []; continue; }
    // A plain comment belongs to the line below it — unless it is ours.
    if (/^\s*#/.test(line) && !line.startsWith(MARK) && !line.startsWith('#   ') && !line.startsWith('# Hatchabot settings')) notes.push(line);
    else notes = [];
  }
  return { active, commented, notes: ownNotes, others, raw };
}

const wrap = (text: string, lead: string) => text.match(/.{1,76}(\s|$)/g)!.map((l) => `${lead}${l.trim()}`);
function helpLines(name: string): string[] {
  const set = ENV_SETTINGS.find((x) => x.name === name);
  return set ? wrap(set.help, '# ') : [];
}

function block(set: EnvSetting, p: Parsed): string[] {
  const out = [...wrap(set.help, '# '), ...(p.notes.get(set.name) ?? [])];
  if (p.active.has(set.name)) out.push(`${set.name}=${p.active.get(set.name)}`);
  else {
    const mine = p.commented.get(set.name);
    const shown = mine !== undefined && mine.trim() !== '' && mine.trim() !== (set.default ?? '') ? mine : (set.default ?? '');
    out.push(`# ${set.name}=${shown}`);
  }
  return out;
}

/** The whole file for `existing` (empty for a new install or .env.example). */
export function renderEnv(existing: string, opts: { example?: boolean } = {}): string {
  const known = new Set(ENV_SETTINGS.map((x) => x.name));
  const p = parse(existing, known);
  const out: string[] = [
    '# Hatchabot settings',
    '#   Lines without # are in force. Every other setting is listed with its',
    '#   default: remove the # and change the value to use it, then restart.',
    '#   Hatchabot keeps this file in order when it starts; your values, and',
    '#   anything it does not know (under "Other settings"), are kept as written.',
    '#   KEY=VALUE only: systemd reads it as is (no ~ or $VAR; absolute paths).',
    ...(opts.example ? ['#   (This is .env.example: the same file for an empty install.)'] : []),
  ];
  for (const g of ENV_GROUPS) {
    const items = ENV_SETTINGS.filter((x) => x.group === g.id);
    if (!items.length) continue;
    out.push('', `${MARK} ${g.title} ${'~'.repeat(Math.max(3, 70 - g.title.length))}`);
    if (g.intro) out.push(...g.intro.match(/.{1,76}(\s|$)/g)!.map((l) => `#   ${l.trim()}`));
    for (const set of items) out.push('', ...block(set, p));
  }
  if (p.others.length || p.raw.length) {
    out.push('', `${MARK} Other settings (not in Hatchabot's list; kept as written) ~~~~~~~~~~~~~`);
    for (const o of p.others) out.push('', ...o.notes, `${o.name}=${o.value}`);
    for (const r of p.raw) out.push('', ...r.notes, r.line);
  }
  return out.join('\n') + '\n';
}

export type SyncResult =
  | { ok: true; changed: false }
  | { ok: true; changed: true; text: string }
  | { ok: false; error: string };

/**
 * The first setting whose value goes on past its line: an opening quote that
 * is not closed on it, or a trailing backslash. systemd (and dotenv) read
 * those as one value across several lines; this file is rewritten line by
 * line, which moves the continuation away under "Other settings" and changes
 * the value while every single line still compares equal (#79).
 */
export function multilineSetting(text: string): string | undefined {
  for (const line of text.split('\n')) {
    // `export NAME="…` too: the tidy keeps it, but the lines inside the value
    // would be read (and moved) as settings of their own (audit, 2026-10-22).
    const p = LINE.exec(line), e = p ? undefined : EXPORTED.exec(line);
    const m = p && !p[1] ? [p[2]!, p[3]!] : e ? [e[1]!, e[2]!] : undefined;
    if (!m) continue;
    const v = m[1]!.trim();
    if (/(^|[^\\])(\\\\)*\\$/.test(v)) return m[0];
    const q = v[0];
    if (q !== '"' && q !== "'") continue;
    let closed = false;
    for (let i = 1; i < v.length && !closed; i++) {
      if (q === '"' && v[i] === '\\') i++;
      else if (v[i] === q) closed = true;
    }
    if (!closed) return m[0];
  }
  return undefined;
}

/** The assignments a shell sourcing the file runs, in order (plain and `export`). */
function assignments(text: string): string[] {
  return text.split('\n').filter((l) => { const m = LINE.exec(l); return m ? !m[1] : EXPORTED.test(l); }).map((l) => l.trim());
}
/** The settings a value names for a shell to expand (`$NAME`, `${NAME}`), outside single quotes. */
const refs = (v: string) => [...v.trim().replace(/'[^']*'/g, '').matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);

/** The new text for a file, refused unless every value in force stays byte-for-byte the same. */
export function syncEnvText(existing: string): SyncResult {
  const spans = multilineSetting(existing);
  if (spans) return { ok: false, error: `${spans} has a value on more than one line, which this tidy cannot keep together — left as it was` };
  const text = renderEnv(existing);
  if (text === existing) return { ok: true, changed: false };
  const before = activeValues(existing), after = activeValues(text);
  const rawSame = JSON.stringify(rawLines(existing)) === JSON.stringify(rawLines(text));
  const sameMap = (x: Map<string, string>, y: Map<string, string>) => x.size === y.size && [...x].every(([k, v]) => y.get(k) === v);
  const sourcedBefore = sourcedValues(existing), sourcedAfter = sourcedValues(text);
  const same = rawSame && sameMap(before, after) && sameMap(sourcedBefore, sourcedAfter);
  // PORT=$CUSTOM_PORT moved above CUSTOM_PORT=8123 reads the same line for
  // line, but a shell sourcing the file (the macOS launcher) gets another
  // value: reordered, a file whose value names another of its settings is
  // left alone (audit, 2026-10-22). A `$` naming none (a password's `pa$$`,
  // `$HOME`) reads the same in any order: refusing it left the file untidied,
  // with the same warning at every start (final audit, 2026-10-22).
  const reordered = JSON.stringify(assignments(existing)) !== JSON.stringify(assignments(text));
  const dollar = reordered ? [...sourcedBefore].find(([, v]) => refs(v).some((n) => sourcedBefore.has(n)))?.[0] : undefined;
  if (same && dollar) return { ok: false, error: `${dollar} uses a $ that would be read in another order — left as it was` };
  if (!same) {
    const diff = [...new Set([...before.keys(), ...after.keys(), ...sourcedBefore.keys(), ...sourcedAfter.keys()])]
      .filter((k) => before.get(k) !== after.get(k) || sourcedBefore.get(k) !== sourcedAfter.get(k));
    return { ok: false, error: `would change ${diff.length ? diff.join(', ') : 'a line it does not understand'} — left as it was` };
  }
  return { ok: true, changed: true, text };
}

const envLocks = new Map<string, Promise<unknown>>();

/**
 * Run one read-modify-write of the .env at `path` with no other in flight on
 * the same file. Each writer reads the whole file, changes a line and renames
 * a copy over it: two settings saved at once each wrote their own snapshot,
 * so the second rename silently dropped the first change (#160).
 */
export async function withEnvFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const { resolve } = await import('node:path');
  const key = resolve(path);
  const run = (envLocks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  envLocks.set(key, tail);
  void tail.then(() => { if (envLocks.get(key) === tail) envLocks.delete(key); });
  return run;
}

/** Write `text` to a staging file of its own beside `path`, then rename it over `path`. */
export async function replaceEnvFile(path: string, text: string, mode: number): Promise<void> {
  const { writeFile, rename, unlink } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  // Never a shared `.env.tmp`: another writer (or another process) staging at
  // the same name could rename our half-written copy, or its own, into place.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tmp, text, { mode, flag: 'wx' });
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Rewrite the .env at `path` in place, keeping its mode (0600), with a dated
 * copy of the old file beside it (the newest 3 kept). Never throws: a file
 * it can't read or write is left alone and the reason returned.
 */
export function syncEnvFile(path: string, now = new Date()): Promise<{ changed: boolean; error?: string; backup?: string }> {
  return withEnvFileLock(path, () => syncEnvFileNow(path, now));
}

async function syncEnvFileNow(path: string, now: Date): Promise<{ changed: boolean; error?: string; backup?: string }> {
  const { readFile, writeFile, stat, readdir, unlink } = await import('node:fs/promises');
  const { dirname, basename, join } = await import('node:path');
  let existing: string;
  try { existing = await readFile(path, 'utf8'); } catch (err) { return { changed: false, error: `can't read ${path}: ${(err as Error).message}` }; }
  const r = syncEnvText(existing);
  if (!r.ok) return { changed: false, error: r.error };
  if (!r.changed) return { changed: false };
  try {
    const mode = (await stat(path)).mode & 0o777;
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const backup = `${path}.bak-${stamp}`;
    await writeFile(backup, existing, { mode: 0o600 });
    await replaceEnvFile(path, r.text, mode);
    // Keep the newest three copies: they hold secrets, so not forever.
    const dir = dirname(path), base = basename(path);
    const olds = (await readdir(dir)).filter((f) => f.startsWith(`${base}.bak-`)).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 3))) await unlink(join(dir, f)).catch(() => {});
    return { changed: true, backup };
  } catch (err) {
    return { changed: false, error: `can't write ${path}: ${(err as Error).message}` };
  }
}
