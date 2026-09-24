/**
 * Browsing and downloading an agent's files (its home on the volume): the
 * owner opens a folder, sees what is there, takes a file or a folder.
 *
 * Everything runs against the VOLUME in a read-only one-shot, never in the
 * agent's own container: it works while the agent is stopped or archived,
 * and nothing here can write. Paths are relative to the agent's home
 * (/home/node), checked here before any shell sees them and again inside
 * the one-shot (`realpath`), so a `..` or a symlink cannot reach past the
 * volume. The path text never lands in a shell unquoted.
 */

export const AGENT_HOME = '/home/node';

/** A listing entry as the API returns it. */
export interface AgentFileEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  /** Modified, ISO. */
  mtime: string;
}

/**
 * A relative path the owner asked for, made safe: no empty or dot-dot
 * segments, no NUL, no leading slash, at most 1024 bytes and 64 segments.
 * Returns the cleaned relative path ('' = home) or undefined when refused.
 */
export function cleanRelPath(input: unknown): string | undefined {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') return undefined;
  if (input.length > 1024 || input.includes('\0')) return undefined;
  const segs = input.split('/').filter((s) => s !== '' && s !== '.');
  if (segs.length > 64) return undefined;
  if (segs.some((s) => s === '..')) return undefined;
  return segs.join('/');
}

/** Absolute path inside the container for a cleaned relative path. */
export function absPath(rel: string): string {
  return rel ? `${AGENT_HOME}/${rel}` : AGENT_HOME;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The guard every shell below starts with: the path must resolve, with
 * symlinks followed, to somewhere inside the home. `realpath -e` fails on a
 * missing path. Exits 3 when the path escapes, 2 when it does not exist.
 */
function guard(rel: string): string {
  const p = q(absPath(rel));
  return `P=$(realpath -e ${p} 2>/dev/null) || exit 2; case "$P" in ${AGENT_HOME}|${AGENT_HOME}/*) ;; *) exit 3;; esac;`;
}

/** Lists one directory, one entry per line: type\tsize\tmtime\tname. */
export function listShell(rel: string): string {
  // find -printf: %y type letter, %s bytes, %T@ mtime epoch, %f name. GNU
  // find, which the runtime image has. Only the direct children.
  // NUL between entries: a newline in a file name must not split a record.
  return `${guard(rel)} [ -d "$P" ] || exit 4; find "$P" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0' 2>/dev/null`;
}

/** Type letter, size and kind of one path: "y\tsize" (d = dir, f = file). */
export function statShell(rel: string): string {
  return `${guard(rel)} stat -c '%F\t%s' "$P"`;
}

/** Total bytes under a directory (what a folder download would carry). */
export function duShell(rel: string): string {
  return `${guard(rel)} du -sb "$P" | cut -f1`;
}

export function parseListing(stdout: string): AgentFileEntry[] {
  const out: AgentFileEntry[] = [];
  for (const line of stdout.split('\0')) {
    if (!line) continue;
    const [t, size, mtime, ...rest] = line.split('\t');
    const name = rest.join('\t');
    if (!name || t === undefined) continue;
    const type: AgentFileEntry['type'] = t === 'd' ? 'dir' : t === 'f' ? 'file' : t === 'l' ? 'link' : 'other';
    const at = Number(mtime);
    out.push({ name, type, size: Number(size) || 0, mtime: Number.isFinite(at) ? new Date(at * 1000).toISOString() : '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** The argv a read-only one-shot runs to stream one file's bytes to stdout. */
export function catArgv(rel: string): string[] {
  return ['sh', '-c', `${guard(rel)} [ -f "$P" ] || exit 4; exec cat "$P"`];
}

/** The argv a read-only one-shot runs to stream a directory as tar.gz. */
export function tarArgv(rel: string): string[] {
  return ['sh', '-c', `${guard(rel)} [ -d "$P" ] || exit 4; cd "$(dirname "$P")" && exec tar cz "$(basename "$P")"`];
}

/** A download name for a path: the last segment, or the agent's slug for home. */
export function downloadName(rel: string, slug: string): string {
  const last = rel.split('/').filter(Boolean).pop();
  return (last ?? slug).replace(/[^\w.+-]+/g, '_').slice(0, 120) || slug;
}

/** A file name the owner uploads: one segment, no slash, no NUL, not a dot name, ≤255 bytes. */
export function cleanFileName(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const n = input.trim();
  if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\0') || Buffer.byteLength(n) > 255) return undefined;
  return n;
}

/**
 * Where an upload may land: anywhere in the home EXCEPT OpenClaw's own state
 * (`.openclaw/…`), other than the agent's workspace inside it — that is
 * where a file for the agent belongs, and overwriting its config or
 * databases by hand would break it.
 */
export function uploadAllowed(relDir: string, slug: string): boolean {
  const ws = `.openclaw/agents/${slug}/agent`;
  if (relDir === '.openclaw' || relDir.startsWith('.openclaw/')) return relDir === ws || relDir.startsWith(`${ws}/`);
  return true;
}

/**
 * The argv a writable one-shot runs to write stdin to <dir>/<name>: the
 * directory is guarded like a read, the file is written beside its target
 * and moved into place, so a broken upload never leaves a half file. Exit 5
 * when the name exists and overwriting was not asked for.
 */
export function putArgv(relDir: string, name: string, overwrite: boolean, slug: string): string[] {
  const n = q(name);
  // The .openclaw rule again, on the RESOLVED directory: a symlink an agent
  // made (`~/inbox -> ~/.openclaw`) must not route an upload into its state.
  const ws = `${AGENT_HOME}/.openclaw/agents/${slug}/agent`;
  const stateGuard = `case "$P" in ${ws}|${ws}/*) ;; ${AGENT_HOME}/.openclaw|${AGENT_HOME}/.openclaw/*) exit 6;; esac;`;
  // A directory (or a link to one) under the target name is refused, not
  // written into.
  return ['sh', '-c', `${guard(relDir)} [ -d "$P" ] || exit 4; ${stateGuard} T="$P"/${n}; if [ -d "$T" ]; then exit 4; fi; if [ -e "$T" ] && [ "${overwrite ? 1 : 0}" != 1 ]; then exit 5; fi; cat > "$T.part-$$" && mv -f "$T.part-$$" "$T"`];
}

/**
 * How a file opens in the browser (the Files tab's links): a type the
 * browser shows as itself, or text for anything text-like. HTML and SVG can
 * carry scripts, so they are shown too — but the response also carries a
 * `Content-Security-Policy: sandbox`, which makes the document originless:
 * no cookies, no scripts, no reach into the app. Unknown binaries download.
 */
export function inlineType(name: string): string | undefined {
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');
  const map: Record<string, string> = {
    txt: 'text/plain', md: 'text/plain', markdown: 'text/plain', log: 'text/plain', csv: 'text/plain', tsv: 'text/plain',
    json: 'text/plain', jsonl: 'text/plain', yaml: 'text/plain', yml: 'text/plain', toml: 'text/plain', ini: 'text/plain', cfg: 'text/plain', conf: 'text/plain',
    py: 'text/plain', js: 'text/plain', mjs: 'text/plain', ts: 'text/plain', sh: 'text/plain', c: 'text/plain', cc: 'text/plain', cpp: 'text/plain', h: 'text/plain',
    sql: 'text/plain', xml: 'text/plain', v: 'text/plain', sv: 'text/plain', diff: 'text/plain', patch: 'text/plain', env: 'text/plain',
    html: 'text/html', htm: 'text/html', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
    pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  };
  if (!ext) return 'text/plain'; // README, Makefile, LICENSE…
  return map[ext];
}
