import type { RuntimeProvider } from '../providers/provider.js';
import { MAX_FILE_BYTES } from './snapshots.js';

/**
 * Read-only inspection of an agent's volume WITHOUT its container running —
 * for archived agents especially. Archiving releases the scarce thing (the
 * Telegram bot) but keeps the volume whole; this lets an owner look back at
 * what an agent knew and discussed months later, using a one-shot container
 * that mounts the volume (execShellOnVolume). Nothing here writes or starts
 * anything, so it is safe on any non-deleted agent regardless of state.
 */

/** The trained/memory files worth showing, in the order an owner reads them. */
export const INSPECTABLE_FILES = ['MEMORY.md', 'SOUL.md', 'AGENTS.md', 'USER.md', 'IDENTITY.md', 'TOOLS.md'] as const;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Where the agent's own files live on the volume (mounted at /home/node). */
function agentDir(slug: string): string {
  return `/home/node/.openclaw/agents/${slug}/agent`;
}

/** A volume read that did not work (the one-shot did not run, a file could not be read). */
export class InspectReadError extends Error {
  constructor(message = "Couldn't read the agent's stored files. Its machine or Docker may not be answering — try again in a moment.") { super(message); }
}

/** The script's answer, or an error: a failed read is not an empty one (#151). */
function ok(res: { code: number; stdout: string; volumeMissing?: boolean }): string {
  if (res.volumeMissing) throw new InspectReadError("This agent's stored files are not on its machine: its volume is gone.");
  if (res.code !== 0) throw new InspectReadError();
  return res.stdout;
}

/**
 * The first `max` bytes of `buf` as text, ending on a whole character: the
 * byte after the cut is a UTF-8 continuation byte when the cut splits one,
 * so back up to that character's first byte (#152).
 */
export function utf8Prefix(buf: Buffer, max: number): string {
  let end = Math.min(max, buf.length);
  while (end > 0 && end < buf.length && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Which of the inspectable files exist and their sizes — one cheap volume
 * mount, so the UI can list before fetching any body.
 */
export async function listInspectableFiles(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
): Promise<Array<{ name: string; bytes: number }>> {
  const dir = agentDir(slug);
  // `wc -c` each candidate that is there; one that is there but cannot be
  // read fails the listing rather than vanishing from it.
  const script = INSPECTABLE_FILES.map((f) => `if [ -e ${q(`${dir}/${f}`)} ]; then wc -c ${q(`${dir}/${f}`)} || exit 1; fi`).join('\n');
  const res = await provider.execShellOnVolume(runtimeRef, script, { readOnly: true });
  const out: Array<{ name: string; bytes: number }> = [];
  for (const line of ok(res).split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[2]!.split('/').pop()!;
    if ((INSPECTABLE_FILES as readonly string[]).includes(name)) out.push({ name, bytes: Number(m[1]) });
  }
  return out;
}

/** One file's content, byte-capped like the live editor. */
export async function readInspectableFile(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  name: string,
): Promise<{ name: string; content: string; truncated: boolean } | null> {
  if (!(INSPECTABLE_FILES as readonly string[]).includes(name)) return null;
  const path = `${agentDir(slug)}/${name}`;
  // Exit 3: not there (the route's 404). Any other failure is an error.
  const res = await provider.execShellOnVolume(runtimeRef, `[ -e ${q(path)} ] || exit 3; head -c ${MAX_FILE_BYTES + 1} ${q(path)}`, { readOnly: true });
  if (res.code === 3) return null;
  const stdout = ok(res);
  const truncated = Buffer.byteLength(stdout, 'utf8') > MAX_FILE_BYTES;
  // Slice on BYTES, not JS chars, so a multibyte file caps at the real budget,
  // and on a character boundary, so the last character is not mangled.
  const content = truncated ? utf8Prefix(Buffer.from(stdout, 'utf8'), MAX_FILE_BYTES) : stdout;
  return { name, content, truncated };
}

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  at?: string;
}

/**
 * Finds the agent's main conversation on the volume and prints the tail of
 * its records: a first line of JSON ({ sessionFile, totalTurns }, or {} for
 * none), then one record per line. The main conversation is the current
 * session of `agent:<slug>:main`, even one a reset left empty: in the
 * agent's database on 2026.9 (openclaw-agent.sqlite, as the other readers
 * read it), else named by sessions.json beside the 2026.7 .jsonl files. Only
 * when neither names it,
 * the biggest one. A store that is there but cannot be read exits 3: it is
 * not an empty history (HB-0306, HB-0307, HB-0308).
 */
export const TRANSCRIPT_TAIL_SCRIPT = String.raw`
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const env = process.env;
const slug = env.SLUG, max = Number(env.MAX_TURNS) || 400, budget = Number(env.MAX_BYTES) || 4194304;
const root = (env.AGENTS_DIR || '/home/node/.openclaw/agents') + '/' + slug; // AGENTS_DIR: tests only
const dir = root + '/sessions', mainKey = 'agent:' + slug + ':main';
// A part of the store that is there but cannot be read: said, and exit 3.
// A system error by its code (EACCES); node:sqlite's code (ERR_SQLITE_ERROR) says
// nothing, so its message ("file is not a database").
class Unreadable extends Error { constructor(what, e) { super(what + ': ' + String((e && (e.code && !String(e.code).startsWith('ERR_') ? e.code : e.message || e.code)) || e)); } }
// The newest records that fit the byte budget, oldest first.
const emit = (r) => {
  const kept = []; let bytes = 0;
  for (let i = r.lines.length - 1; i >= 0 && kept.length < max; i--) { bytes += Buffer.byteLength(r.lines[i]) + 1; if (bytes > budget) break; kept.push(r.lines[i]); }
  process.stdout.write(JSON.stringify(r.head) + '\n' + kept.reverse().join('\n'));
};
// A stored event on one line; a damaged one is left out.
const oneLine = (j) => { try { return JSON.stringify(JSON.parse(j)); } catch { return null; } };

// 2026.9: the agent's database. The main conversation (the current session
// of its key) and, in case nothing names one, the biggest.
function fromDb() {
  let sqlite = null; try { sqlite = require('node:sqlite'); } catch {}
  const dbf = path.join(root, 'agent', 'openclaw-agent.sqlite');
  if (!sqlite || !fs.existsSync(dbf)) return {};
  const read = (name) => {
    const db = new sqlite.DatabaseSync(name, { readOnly: true });
    try {
      try { db.exec('PRAGMA busy_timeout = 3000'); } catch {}
      const noTable = (e) => /no such (table|column)/i.test(String(e && e.message));
      const get = (sql, ...a) => { try { return db.prepare(sql).get(...a); } catch (e) { if (noTable(e)) return undefined; throw e; } };
      const tail = (id) => {
        const total = get('SELECT COUNT(*) AS n FROM transcript_events WHERE session_id = ?', id).n;
        const rows = db.prepare('SELECT * FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT ?').all(id, max).reverse();
        const lines = rows.map((r) => {
          if (r.event_json != null) return oneLine(r.event_json);
          try { return r.event_zstd ? oneLine(zlib.zstdDecompressSync(Buffer.from(r.event_zstd)).toString('utf8')) : null; } catch { return null; }
        }).filter(Boolean);
        return { head: { sessionFile: id, totalTurns: total }, lines };
      };
      if (!get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'transcript_events'")) return {};
      // The main key's current session is the chat even when a reset just
      // emptied it: an empty history, never another key's conversation.
      const node = get('SELECT current_session_id AS id FROM session_nodes WHERE session_key = ?', mainKey);
      if (node && node.id) return { main: tail(node.id) };
      const big = get('SELECT session_id AS id FROM transcript_events GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 1');
      return big ? { biggest: tail(big.id) } : {};
    } finally { try { db.close(); } catch {} }
  };
  try { return read(dbf); }
  catch (first) {
    // The volume is mounted read-only, and a WAL database cannot make the
    // -wal and -shm files it reads through. With no -wal left (the agent
    // stopped cleanly) the file alone is the whole database: read it as
    // immutable. With one left, read a copy of both in /tmp.
    let wal = 0; try { wal = fs.statSync(dbf + '-wal').size; } catch {}
    let tmp = null;
    try {
      if (!wal) return read(require('url').pathToFileURL(dbf).href + '?immutable=1');
      tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hatchabot-inspect-db-'));
      const copy = path.join(tmp, 'agent.sqlite');
      fs.copyFileSync(dbf, copy); fs.copyFileSync(dbf + '-wal', copy + '-wal');
      return read(copy);
    } catch (e) { throw new Unreadable('the agent database', e); }
    finally { if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  }
}

// 2026.7: one .jsonl per conversation; sessions.json names the current one of each key.
function fromFiles() {
  let files;
  try { files = fs.readdirSync(dir); }
  catch (e) { if (e && e.code === 'ENOENT') return {}; throw new Unreadable('the sessions folder', e); }
  let named = null, index = null;
  try { index = fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'); }
  catch (e) { if (e && e.code !== 'ENOENT') throw new Unreadable('sessions.json', e); }
  try {
    const sj = index && JSON.parse(index);
    const id = sj && sj[mainKey] && sj[mainKey].sessionId;
    if (typeof id === 'string' && files.includes(id + '.jsonl')) named = id + '.jsonl';
  } catch {} // a damaged index names nothing
  if (named) return { main: named };
  let biggest = null, size = -1;
  for (const f of files) {
    if (!/\.jsonl$/.test(f) || f.includes('.trajectory.')) continue;
    let st; try { st = fs.statSync(path.join(dir, f)); } catch (e) { throw new Unreadable(f, e); }
    if (st.isFile() && st.size > size) { size = st.size; biggest = f; }
  }
  return biggest ? { biggest } : {};
}

// Count every line, keep the newest within the budget: read in pieces, never whole.
function fileTail(f) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, f), 'r');
    const size = fs.fstatSync(fd).size, chunk = Buffer.alloc(1 << 20);
    let total = 0, last = 10;
    for (let at = 0; at < size;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, at);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) if (chunk[i] === 10) total++;
      last = chunk[n - 1]; at += n;
    }
    if (size && last !== 10) total++;
    const from = Math.max(0, size - budget), buf = Buffer.alloc(size - from);
    for (let got = 0; got < buf.length;) { const n = fs.readSync(fd, buf, got, buf.length - got, from + got); if (n <= 0) break; got += n; }
    const lines = buf.toString('utf8').split('\n');
    if (from > 0) lines.shift(); // cut by the budget
    return { head: { sessionFile: f, totalTurns: total }, lines: lines.filter((l) => l.trim()) };
  } catch (e) { throw new Unreadable(f, e); }
  finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {} }
}

try {
  const db = fromDb();
  const files = db.main ? {} : fromFiles();
  // What names the main conversation first; only then the biggest, the database's before an older file's.
  emit(db.main || (files.main && fileTail(files.main)) || db.biggest || (files.biggest && fileTail(files.biggest)) || { head: {}, lines: [] });
} catch (e) {
  process.stderr.write('transcript unreadable: ' + (e instanceof Unreadable ? e.message : String(e && e.message || e)));
  process.exitCode = 3;
}
`;

/**
 * The agent's main conversation, rendered from its session store into plain
 * readable turns (TRANSCRIPT_TAIL_SCRIPT finds it and sends its tail), each
 * entry flattened to role + text, dropping tool plumbing to what a human
 * would want to re-read. A record of an unfamiliar shape is left out; a
 * store that cannot be read is an InspectReadError, not an empty history.
 */
export async function readTranscript(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  opts: { maxTurns?: number } = {},
): Promise<{ turns: TranscriptTurn[]; sessionFile?: string; totalTurns: number }> {
  // A long history's tail is what "remind me what we discussed" wants, and it bounds the transfer.
  const maxTurns = Math.floor(Math.min(Math.max(opts.maxTurns ?? 400, 1), 2000));
  const b64 = Buffer.from(TRANSCRIPT_TAIL_SCRIPT, 'utf8').toString('base64');
  const res = await provider.execShellOnVolume(
    runtimeRef,
    // The slug is a fixed-charset name; quoted all the same.
    `set -e; T=/tmp/hatchabot-inspect-$$.cjs; echo ${b64} | base64 -d > $T; SLUG=${q(slug)} MAX_TURNS=${maxTurns} node $T; rm -f $T`,
    { readOnly: true },
  );
  // The store was reached but cannot be read (exit 3): say what, not that
  // Docker may not be answering (HB-0308).
  const why = res.code !== 0 && /transcript unreadable: ([^\n]*)/.exec(res.stderr ?? '');
  if (why) throw new InspectReadError(`Couldn't read the agent's chat history: ${why[1]!.slice(0, 300)}. The volume was reached; this part of it could not be read.`);
  const out = ok(res);
  const nl = out.indexOf('\n');
  let head: { sessionFile?: unknown; totalTurns?: unknown };
  try { head = JSON.parse(nl < 0 ? out : out.slice(0, nl)); } catch { throw new InspectReadError(); }
  if (typeof head.sessionFile !== 'string') return { turns: [], totalTurns: 0 };
  const turns: TranscriptTurn[] = [];
  for (const line of (nl < 0 ? '' : out.slice(nl + 1)).split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const turn = flattenEntry(e);
    if (turn) turns.push(turn);
  }
  return { turns, sessionFile: head.sessionFile.split('/').pop(), totalTurns: Number(head.totalTurns) || 0 };
}

/** Flatten one session entry to a readable turn, or null to skip it.
 *  OpenClaw's shape is `{type:'message', message:{role, content}}`; older/
 *  flatter shapes (role+content at top level) are handled too. */
function flattenEntry(e: Record<string, unknown>): TranscriptTurn | null {
  const env = (e.message && typeof e.message === 'object' && !Array.isArray(e.message))
    ? (e.message as Record<string, unknown>)
    : e;
  const roleRaw = String(env.role ?? e.role ?? e.type ?? '');
  const at = typeof e.timestamp === 'string' ? e.timestamp
    : typeof e.ts === 'number' ? new Date(e.ts).toISOString()
    : undefined;
  const text = extractText(env.content ?? env.text ?? e.content ?? e.text);
  if (!text) return null;
  const role: TranscriptTurn['role'] =
    roleRaw === 'user' ? 'user'
    : roleRaw === 'assistant' || roleRaw === 'model' ? 'assistant'
    : roleRaw === 'tool' || roleRaw === 'tool_result' ? 'tool'
    : 'system';
  // Tool plumbing is noise for a human re-read; keep only real dialogue.
  if (role === 'tool' || role === 'system') return null;
  return { role, text: text.slice(0, 8000), at };
}

/** Pull human-readable text out of the many content shapes OpenClaw emits. */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (typeof p.text === 'string') return p.text;
        }
        return '';
      })
      .join('')
      .trim();
  }
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text.trim();
    if (Array.isArray(c.content)) return extractText(c.content);
  }
  return '';
}
