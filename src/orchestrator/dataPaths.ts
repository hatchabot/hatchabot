/**
 * Guessing which host folders an adopted OpenClaw agent depends on. OpenClaw
 * agents run with the whole filesystem in reach; Hatchabot agents are boxed in
 * a container and see only their volume plus folders you share. So after adopt
 * we scan the agent's own files for absolute paths it mentions and surface the
 * real, external directories among them — candidates to share (bound at their
 * original path so the references keep working).
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
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

/** At most this many files are read, each up to SCAN_FILE_BYTES: the count
 *  was checked only on entering a folder, so a flat folder was read whole
 *  (review 2026-10-22, A43). */
export const SCAN_MAX_FILES = 400;
export const SCAN_FILE_BYTES = 1 << 20;

function collectFiles(dir: string, depth: number, acc: string[]): void {
  if (depth > 3 || acc.length >= SCAN_MAX_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
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
  for (const d of dirs) collectFiles(d, depth + 1, acc);
}

/**
 * Absolute directories referenced in an adopted workspace's own text that
 * actually exist on the host and sit OUTSIDE the workspace itself — i.e. real
 * external data the agent reads. Files collapse to their parent directory;
 * nested hits collapse to the shallowest shared ancestor already in the list.
 * `systemPrefixes` is for tests whose checkout itself sits under one (a
 * self-hosted CI runner's work dir in /var/lib).
 */
export function scanWorkspacePaths(workspaceDir: string, systemPrefixes: readonly string[] = SYSTEM_PREFIXES): string[] {
  const ws = resolve(workspaceDir);
  const files: string[] = [];
  collectFiles(ws, 0, files);

  const found = new Set<string>();
  for (const f of files) {
    let text: string;
    try {
      const fd = openSync(f, 'r');
      try {
        const buf = Buffer.alloc(Math.min(SCAN_FILE_BYTES, fstatSync(fd).size));
        text = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
      } finally { closeSync(fd); }
    } catch {
      continue;
    }
    // Trim trailing sentence/markdown punctuation the greedy class swallowed
    // (e.g. "reads from /home/you/docs." → drop the period).
    for (const m of text.matchAll(PATH_RE)) found.add(m[0].replace(/[.,;:!?)\]}'"`]+$/, ''));
    for (const m of text.matchAll(QUOTED_PATH_RE)) if (m[2]!.includes(' ')) found.add(m[2]!);
  }

  const dirs = new Set<string>();
  for (const raw of found) {
    let p = resolve(raw);
    // A referenced file → the folder that holds it.
    try {
      if (existsSync(p) && statSync(p).isFile()) p = dirname(p);
    } catch {
      continue;
    }
    if (!existsSync(p)) continue;
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
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
