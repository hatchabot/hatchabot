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
  // `wc -c` each candidate; missing files print an error we drop.
  const script = INSPECTABLE_FILES.map((f) => `wc -c ${q(`${dir}/${f}`)} 2>/dev/null || true`).join('\n');
  const res = await provider.execShellOnVolume(runtimeRef, script, { readOnly: true });
  const out: Array<{ name: string; bytes: number }> = [];
  for (const line of res.stdout.split('\n')) {
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
  const res = await provider.execShellOnVolume(runtimeRef, `head -c ${MAX_FILE_BYTES + 1} ${q(path)} 2>/dev/null || true`, { readOnly: true });
  const truncated = Buffer.byteLength(res.stdout, 'utf8') > MAX_FILE_BYTES;
  // Slice on BYTES, not JS chars, so a multibyte file caps at the real budget
  // and doesn't split a codepoint (matches the files route's byte handling).
  const content = truncated
    ? Buffer.from(res.stdout, 'utf8').subarray(0, MAX_FILE_BYTES).toString('utf8')
    : res.stdout;
  return { name, content, truncated };
}

export interface TranscriptTurn {
  role: 'user' | 'assistant' | 'tool' | 'system';
  text: string;
  at?: string;
}

/**
 * The agent's main conversation, rendered from its session store into plain
 * readable turns. OpenClaw writes one JSONL per session; we take the largest
 * (the main thread) and flatten each entry to role + text, dropping tool
 * plumbing to what a human would want to re-read. Best-effort: an unfamiliar
 * shape yields fewer turns, never an error.
 */
export async function readTranscript(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
  opts: { maxTurns?: number } = {},
): Promise<{ turns: TranscriptTurn[]; sessionFile?: string; totalTurns: number }> {
  const dir = `/home/node/.openclaw/agents/${slug}/sessions`;
  // Pick the biggest jsonl (the main thread accumulates the most), then tail
  // it — a long history's tail is what "remind me what we discussed" wants,
  // and it bounds the transfer.
  const maxTurns = Math.floor(Math.min(Math.max(opts.maxTurns ?? 400, 1), 2000)); // integer for `tail -n`
  const pick = await provider.execShellOnVolume(
    runtimeRef,
    `ls -S ${q(dir)}/*.jsonl 2>/dev/null | head -1`,
    { readOnly: true },
  );
  const sessionFile = pick.stdout.trim().split('\n')[0]?.trim();
  if (!sessionFile) return { turns: [], totalTurns: 0 };
  const countRes = await provider.execShellOnVolume(runtimeRef, `wc -l ${q(sessionFile)} 2>/dev/null || true`, { readOnly: true });
  const totalTurns = Number(/^\s*(\d+)/.exec(countRes.stdout)?.[1] ?? 0);
  const res = await provider.execShellOnVolume(
    runtimeRef,
    // Cap the byte transfer too: a huge session shouldn't balloon the response.
    `tail -n ${maxTurns} ${q(sessionFile)} 2>/dev/null | head -c ${4 * 1024 * 1024} || true`,
    { readOnly: true },
  );
  const turns: TranscriptTurn[] = [];
  for (const line of res.stdout.split('\n')) {
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
  return { turns, sessionFile: sessionFile.split('/').pop(), totalTurns };
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
