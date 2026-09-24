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
  return `${guard(rel)} [ -d "$P" ] || exit 4; find "$P" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null | LC_ALL=C sort -t $'\\t' -k4,4`;
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
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [t, size, mtime, ...rest] = line.split('\t');
    const name = rest.join('\t');
    if (!name || t === undefined) continue;
    const type: AgentFileEntry['type'] = t === 'd' ? 'dir' : t === 'f' ? 'file' : t === 'l' ? 'link' : 'other';
    const at = Number(mtime);
    out.push({ name, type, size: Number(size) || 0, mtime: Number.isFinite(at) ? new Date(at * 1000).toISOString() : '' });
  }
  return out;
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
