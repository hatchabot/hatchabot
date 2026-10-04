/**
 * The loop lines of an agent's gateway log (tokenHealth.ts): a chat-app
 * message that stalled past OpenClaw's handler limit and is retried, one that
 * was dead-lettered, a compaction that failed, a manual compaction starting.
 * Read on the usage pass's existing log read (localDockerProvider.modelCallLog
 * keeps these lines beside the model calls); only the kind, the event id and
 * the time are kept. Formats from OpenClaw 2026.9.6 (ingress-drain,
 * compaction-diagnostics).
 */

export type LoopMarkKind = 'stall' | 'retry' | 'deadletter' | 'compactFail' | 'compactStart';
export interface LoopMark { kind: LoopMarkKind; key: string; at: string; ms?: number; channel?: string }

const STALL = /stalled for event (\S+?) on lane .*? after (\d+)ms; applying retry policy \(handler-timeout\)/;
const KEEP = /spooled update (\S+) failed; keeping for retry/;
const DEAD = /spooled update (\S+) (?:failed with non-retryable|on lane .* reached retry limit).*dead-lettered/;
const COMPACT_FAIL = /context-engine compaction failed|Auto-compaction failed|Context overflow recovery failed|compaction-diag\] end .*outcome=fail|CLI (?:transcript|native harness) compaction failed/;
const COMPACT_START = /compaction-diag\] start .*trigger=manual/;
const CHANNEL = /\[(telegram|slack|discord|line|whatsapp|signal|imessage|matrix|msteams|googlechat)\]/i;
/** Every line the provider's log read keeps besides the model calls (localDockerProvider.modelCallLog). */
export const LOOP_LINE = /applying retry policy \(handler-timeout\)|keeping for retry|dead-lettered|compaction failed|Context overflow recovery failed|compaction-diag\] (?:end .*outcome=fail|start .*trigger=manual)/;

/** Loop lines in a `docker logs --timestamps` read: kind, the event they are about, when. No other text is kept. */
export function parseLoopLines(text: string): LoopMark[] {
  const out: LoopMark[] = [];
  for (const line of text.split('\n')) {
    if (!LOOP_LINE.test(line)) continue;
    const ts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/.exec(line);
    if (!ts) continue;
    const at = new Date(ts[1]!).toISOString();
    const channel = CHANNEL.exec(line)?.[1]?.toLowerCase();
    const id = (s: string) => s.replace(/[.;,]$/, '').replace(/^0+(?=\d)/, '').slice(0, 40);
    let m: RegExpExecArray | null;
    if ((m = STALL.exec(line))) out.push({ kind: 'stall', key: id(m[1]!), at, ms: Number(m[2]), ...(channel ? { channel } : {}) });
    else if ((m = DEAD.exec(line))) out.push({ kind: 'deadletter', key: id(m[1]!), at, ...(channel ? { channel } : {}) });
    else if ((m = KEEP.exec(line))) out.push({ kind: 'retry', key: id(m[1]!), at, ...(channel ? { channel } : {}) });
    else if (COMPACT_START.test(line)) out.push({ kind: 'compactStart', key: '', at });
    else if (COMPACT_FAIL.test(line)) out.push({ kind: 'compactFail', key: '', at });
  }
  return out;
}
