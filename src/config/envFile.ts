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

/** The new text for a file, refused unless every value in force stays byte-for-byte the same. */
export function syncEnvText(existing: string): SyncResult {
  const text = renderEnv(existing);
  if (text === existing) return { ok: true, changed: false };
  const before = activeValues(existing), after = activeValues(text);
  const rawSame = JSON.stringify(rawLines(existing)) === JSON.stringify(rawLines(text));
  const same = rawSame && before.size === after.size && [...before].every(([k, v]) => after.get(k) === v);
  if (!same) {
    const diff = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
    return { ok: false, error: `would change ${diff.length ? diff.join(', ') : 'a line it does not understand'} — left as it was` };
  }
  return { ok: true, changed: true, text };
}

/**
 * Rewrite the .env at `path` in place, keeping its mode (0600), with a dated
 * copy of the old file beside it (the newest 3 kept). Never throws: a file
 * it can't read or write is left alone and the reason returned.
 */
export async function syncEnvFile(path: string, now = new Date()): Promise<{ changed: boolean; error?: string; backup?: string }> {
  const { readFile, writeFile, rename, stat, readdir, unlink } = await import('node:fs/promises');
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
    const tmp = `${path}.tmp`;
    await writeFile(tmp, r.text, { mode });
    await rename(tmp, path);
    // Keep the newest three copies: they hold secrets, so not forever.
    const dir = dirname(path), base = basename(path);
    const olds = (await readdir(dir)).filter((f) => f.startsWith(`${base}.bak-`)).sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 3))) await unlink(join(dir, f)).catch(() => {});
    return { changed: true, backup };
  } catch (err) {
    return { changed: false, error: `can't write ${path}: ${(err as Error).message}` };
  }
}
