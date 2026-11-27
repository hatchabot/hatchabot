/**
 * Guessing which host folders an adopted OpenClaw agent depends on. OpenClaw
 * agents run with the whole filesystem in reach; Hatchabot agents are boxed in
 * a container and see only their volume plus folders you share. So after adopt
 * we scan the agent's own files for absolute paths it mentions and surface the
 * real, external directories among them — candidates to share (bound at their
 * original path so the references keep working).
 */
import { open, readdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// Directories that are never useful to share: the OS, and volatile/system trees.
export const SYSTEM_PREFIXES: readonly string[] = [
  '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/proc', '/sys', '/dev',
  '/run', '/tmp', '/var', '/opt', '/snap', '/boot', '/root/.cache',
];

/** Absolute paths a token could be. Stops at whitespace, quotes, and markdown
 *  punctuation so it doesn't swallow trailing prose. */
const PATH_RE = /\/(?:[\w.\-+@]+\/)*[\w.\-+@]+/g;
/** A path in quotes or backticks may hold spaces ("/home/you/My Documents"):
 *  PATH_RE alone stops at the first one (report A23, 2026-10-22). */
const QUOTED_PATH_RE = /(["'`])(\/[^"'`\n]*[^"'`\s])\1/g;

/** A host name's characters, and a host name with a top-level domain of letters (example.test). */
const HOST_CHAR = /^[A-Za-z0-9.-]$/;
const HOST_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

/** At most this many files are read, each up to SCAN_FILE_BYTES: the count
 *  was checked only on entering a folder, so a flat folder was read whole
 *  (review 2026-10-22, A43). */
export const SCAN_MAX_FILES = 400;
export const SCAN_FILE_BYTES = 1 << 20;
/** At most this many paths named in them are looked at, the first found:
 *  each is a look at the disk or two, and a megabyte of notes can name a
 *  hundred thousand (HB-1168). Only those the look could suggest count
 *  (`passedBy`): a page of links before the data folder used them all up. */
export const SCAN_MAX_PATHS = 2000;

async function collectFiles(dir: string, depth: number, acc: string[]): Promise<void> {
  if (depth > 3 || acc.length >= SCAN_MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  // A folder's own files before its subfolders: with the cap, 400 daily notes
  // in memory/ must not crowd out TOOLS.md beside it.
  const dirs: string[] = [];
  for (const e of entries) {
    if (acc.length >= SCAN_MAX_FILES) return;
    if (e.name.startsWith('.')) continue; // .git etc.
    const p = resolve(dir, e.name);
    if (e.isDirectory()) dirs.push(p);
    else if (e.isFile() && /\.(md|json|txt)$/i.test(e.name)) acc.push(p);
  }
  for (const d of dirs) await collectFiles(d, depth + 1, acc);
}

/** What is at `p`: a file, a folder, something else, or nothing it can see (missing, or not allowed). */
async function kindOf(p: string): Promise<'file' | 'dir' | 'other' | undefined> {
  try {
    const s = await stat(p);
    return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other';
  } catch {
    return undefined;
  }
}

/**
 * Absolute directories referenced in an adopted workspace's own text that
 * actually exist on the host and sit OUTSIDE the workspace itself — i.e. real
 * external data the agent reads. Files collapse to their parent directory;
 * nested hits collapse to the shallowest shared ancestor already in the list.
 * `systemPrefixes` is for tests whose checkout itself sits under one (a
 * self-hosted CI runner's work dir in /var/lib).
 *
 * Asked by a request, so it never holds the event loop for the whole scan
 * (up to SCAN_MAX_FILES files of SCAN_FILE_BYTES, and a look at every path
 * they name): each listing, read and look waits on the disk off the loop,
 * and other requests run between them (HB-0983). One file's text is still
 * searched in one go, at most SCAN_FILE_BYTES of it, and at most
 * SCAN_MAX_PATHS of the paths found are looked at (HB-1168).
 */
export async function scanWorkspacePaths(workspaceDir: string, systemPrefixes: readonly string[] = SYSTEM_PREFIXES): Promise<string[]> {
  const ws = resolve(workspaceDir);
  const files: string[] = [];
  await collectFiles(ws, 0, files);

  /**
   * A path never suggested, whatever is on the disk there, as the look below
   * judges it after a file's folder is taken for the file: in the agent's own
   * files, a hidden folder on the way (the last name may be a hidden file,
   * whose folder is suggested), the system's, or too shallow. Passed by
   * before the cap counts it (HB-1168 review).
   */
  const passedBy = (raw: string): boolean => {
    const r = resolve(raw);
    if (r === ws || r.startsWith(`${ws}/`)) return true;
    const segs = r.split('/').filter(Boolean);
    if (segs.length < 2 || segs.slice(0, -1).some((seg) => seg.startsWith('.'))) return true;
    return systemPrefixes.some((s) => r === s || r.startsWith(`${s}/`));
  };
  const found = new Set<string>();
  const add = (p: string): boolean => {
    if (passedBy(p) || found.has(p)) return true;
    if (found.size >= SCAN_MAX_PATHS) return false;
    found.add(p);
    return true;
  };
  /**
   * Not a path on this machine, clearly: a link's path (after `scheme://` or
   * a host name, `example.test/docs`) or a date (2026/11/25). Nothing else
   * is passed by here: a path glued to what comes before it (`-v/srv/data`,
   * `e.g./srv/data`, `1./srv/data`, `//srv/data`) is looked at, as before,
   * and "and/or" is too shallow to count (`passedBy`). HB-1168 review.
   */
  const notOnDisk = (text: string, at: number, path: string): boolean => {
    if (text.slice(at - 2, at) === ':/') return true;                    // https://example.test/…
    // The name right before it, read back a character at a time (no pattern run over the text).
    let i = at;
    while (i > 0 && at - i < 256 && HOST_CHAR.test(text[i - 1]!)) i--;
    const name = text.slice(i, at);
    if (HOST_NAME.test(name)) return true;                                 // example.test/…
    return /^\d+$/.test(name) && /^(?:\/\d+)+$/.test(path);            // 2026/11/25
  };
  for (const f of files) {
    if (found.size >= SCAN_MAX_PATHS) break;
    let text: string;
    try {
      const fh = await open(f, 'r');
      try {
        const buf = Buffer.alloc(Math.min(SCAN_FILE_BYTES, (await fh.stat()).size));
        text = buf.subarray(0, (await fh.read(buf, 0, buf.length, 0)).bytesRead).toString('utf8');
      } finally { await fh.close(); }
    } catch {
      continue;
    }
    // Trim trailing sentence/markdown punctuation the greedy class swallowed
    // (e.g. "reads from /home/you/docs." → drop the period).
    for (const m of text.matchAll(PATH_RE)) if (!notOnDisk(text, m.index, m[0]) && !add(m[0].replace(/[.,;:!?)\]}'"`]+$/, ''))) break;
    for (const m of text.matchAll(QUOTED_PATH_RE)) if (m[2]!.includes(' ') && !add(m[2]!)) break;
  }

  const dirs = new Set<string>();
  for (const raw of found) {
    let p = resolve(raw);
    // A referenced file → the folder that holds it.
    let kind = await kindOf(p);
    if (kind === 'file') { p = dirname(p); kind = await kindOf(p); }
    if (kind !== 'dir') continue;
    if (p === ws || p.startsWith(`${ws}/`)) continue; // the agent's own files
    // Any hidden segment: OpenClaw state (.openclaw) and, importantly, credential
    // dirs (.ssh, .aws, .gnupg, .kube, .docker, .config) the share-blocklist
    // doesn't all cover. Real data folders are not dot-directories.
    if (p.split('/').some((seg) => seg.startsWith('.'))) continue;
    if (systemPrefixes.some((s) => p === s || p.startsWith(`${s}/`))) continue;
    // Skip trivially-shallow roots ("/", "/home", "/home/user", "/mnt").
    if (p.split('/').filter(Boolean).length < 2) continue;
    dirs.add(p);
  }

  // Collapse a child into an ancestor that's also present, so we suggest the
  // broadest useful mount rather than several overlapping ones.
  const sorted = [...dirs].sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const d of sorted) {
    if (!kept.some((k) => d === k || d.startsWith(`${k}/`))) kept.push(d);
  }
  return kept.sort();
}
