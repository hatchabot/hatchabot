/**
 * Compressed swap for agents: a swap allowance per agent, on top of its
 * memory cap, given only where the machine compresses what is swapped.
 *
 * Why: an idle OpenClaw gateway holds ~0.7 GiB, most of it cold. Pushed into
 * zram or zswap with zstd it shrinks 2.5–3.6:1 and answers again in 6–15 ms;
 * a whole turn on a swapped-out gateway costs 1–2 s more (measurements
 * 2026-10-01, B2). Plain disk swap resumes in 150–500 ms and writes the
 * agent's memory — keys included — to disk, so it is never used: with no
 * compressed swap on the host the allowance is withheld.
 *
 * Semantics: HATCHABOT_AGENT_SWAP (fleet), a class's or an agent's own
 * setting is the swap an agent may use IN ADDITION to its memory cap. Docker's
 * --memory-swap is the TOTAL (memory + swap), so a 3g cap with a 2g allowance
 * runs with --memory 3g --memory-swap 5g. Off by default; an agent or class
 * can say "off" against a fleet that is on. Never more than the memory cap.
 */
import type { Agent, AgentClass } from '../domain/types.js';
import { describeMemoryCap, effectiveMemoryCap, formatMemoryCap, MEMORY_CAP_CEILING_BYTES } from './memoryCap.js';

export const SWAP_ALLOWANCE_MIN_BYTES = 256 * 1024 ** 2;
const OFF_WORDS = new Set(['off', '0', 'none', 'no', 'false']);

/**
 * "2g", "512m" → bytes; "off" (and 0/none/no) → 0; undefined when it is not
 * a setting. Unlike a memory cap the floor is 256m: less is not worth a flag.
 */
export function parseSwapAllowance(input: unknown): number | undefined {
  if (typeof input !== 'string') return undefined;
  const v = input.trim().toLowerCase();
  if (OFF_WORDS.has(v)) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([mg])b?$/.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const bytes = Math.round(n * (m[2] === 'g' ? 1024 ** 3 : 1024 ** 2));
  if (bytes < SWAP_ALLOWANCE_MIN_BYTES || bytes > MEMORY_CAP_CEILING_BYTES) return undefined;
  return bytes;
}

/** The stored form: "off" or the shortest docker-style size. */
export function formatSwapAllowance(bytes: number): string {
  return bytes > 0 ? formatMemoryCap(bytes) : 'off';
}

/** What a person reads: "off", "2 GB". */
export function describeSwapAllowance(bytes: number): string {
  return bytes > 0 ? describeMemoryCap(bytes) : 'off';
}

/** The fleet setting (HATCHABOT_AGENT_SWAP); unset or bad = off. */
export function defaultSwapAllowance(env: NodeJS.ProcessEnv = process.env): string {
  const b = parseSwapAllowance(env.HATCHABOT_AGENT_SWAP ?? '');
  return formatSwapAllowance(b ?? 0);
}

/**
 * The allowance an agent's container gets, in bytes (0 = none): its own
 * setting, else its class's, else the fleet's — never more than the memory
 * cap it runs with (a cap can be lowered after the allowance was set).
 */
export function effectiveSwapAllowance(
  agent: Pick<Agent, 'swapAllowance' | 'memoryCap'>,
  cls: Pick<AgentClass, 'swapAllowance' | 'memoryCap'> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  let bytes = 0;
  for (const v of [agent.swapAllowance, cls?.swapAllowance, env.HATCHABOT_AGENT_SWAP]) {
    const b = parseSwapAllowance(v);
    if (b !== undefined) { bytes = b; break; }
  }
  if (!bytes) return 0;
  const cap = parseMemoryCapBytes(effectiveMemoryCap(agent, cls, env));
  return Math.min(bytes, cap);
}

const parseMemoryCapBytes = (cap: string): number => {
  const m = /^(\d+(?:\.\d+)?)([mg])$/.exec(cap);
  return m ? Math.round(Number(m[1]) * (m[2] === 'g' ? 1024 ** 3 : 1024 ** 2)) : 0;
};

/** The two numbers docker is given for an agent: its cap, and its swap allowance (absent = none). */
export function agentMemoryLimits(
  store: { getAgentClass(id: string): AgentClass | undefined },
  agent: Agent,
  env: NodeJS.ProcessEnv = process.env,
): { memory: string; swap?: string } {
  const cls = agent.classId ? store.getAgentClass(agent.classId) : undefined;
  const memory = effectiveMemoryCap(agent, cls, env);
  const swap = effectiveSwapAllowance(agent, cls, env);
  return swap ? { memory, swap: formatMemoryCap(swap) } : { memory };
}

/**
 * Docker's --memory-swap for a container: the cap plus the allowance where
 * the host compresses swap, else the cap alone (swap.max = 0, no swap).
 */
export function dockerMemorySwap(memory: string, swap: string | undefined, compressed: boolean): string {
  if (!swap || !compressed) return memory;
  const m = parseMemoryCapBytes(memory), s = parseMemoryCapBytes(swap);
  if (!m || !s) return memory;
  return formatMemoryCap(m + Math.min(s, m));
}

// ---- the machine's swap, as the kernel reports it ------------------------------

export interface SwapDevice { name: string; type: string; sizeBytes: number; usedBytes: number; priority: number }
export interface CompressedSwap {
  /** zswap in front of a swap device, zram as a swap device, neither, or could not tell. */
  kind: 'zswap' | 'zram' | 'none' | 'unknown';
  /** Agents may be given swap: zswap or zram is there. */
  compressed: boolean;
  /** When not compressed: why, in words, and what to do. */
  why?: string;
  swapDevices: SwapDevice[];
  zswap?: { enabled: boolean; compressor?: string; zpool?: string; maxPoolPercent?: number;
    /** /proc/meminfo Zswap (pool held in memory) and Zswapped (what it stores), when the kernel reports them. */
    poolBytes?: number; storedBytes?: number };
  zram?: Array<{ device: string; algorithm?: string; origBytes?: number; comprBytes?: number; memUsedBytes?: number }>;
}

/** The fix the app, the doctor and the log name. */
export const COMPRESSED_SWAP_FIX = 'sudo scripts/enable-compressed-swap.sh (zswap with zstd in front of the existing swap file; --zram for zram instead)';

/**
 * The shell that reads everything detection needs, readable by any user and
 * from inside a container (sysfs and /proc/swaps are the host's there):
 * remote and Docker Desktop hosts run it in a one-shot.
 */
export const SWAP_PROBE_SCRIPT =
  'for f in enabled compressor zpool max_pool_percent; do printf "zswap.%s=%s\\n" "$f" "$(cat /sys/module/zswap/parameters/$f 2>/dev/null)"; done; ' +
  'echo "--swaps"; cat /proc/swaps 2>/dev/null; echo "--meminfo"; grep -E "^(Zswap|Zswapped):" /proc/meminfo 2>/dev/null; echo "--zram"; ' +
  'for d in /sys/block/zram*; do [ -e "$d/mm_stat" ] || continue; n=${d##*/}; printf "zram.%s.algo=%s\\n" "$n" "$(cat $d/comp_algorithm 2>/dev/null)"; printf "zram.%s.mm=%s\\n" "$n" "$(cat $d/mm_stat 2>/dev/null)"; done; echo "--end"';

/** The probe script's output → what the machine has. Pure: tested without a kernel. */
export function parseSwapProbe(out: string | undefined): CompressedSwap {
  const text = out ?? '';
  // No /proc/swaps header: nothing was read (not Linux, the one-shot failed).
  if (!/^Filename\s+Type\s+Size\s+Used\s+Priority/m.test(text)) {
    return { kind: 'unknown', compressed: false, why: 'Could not read this machine\'s swap: agents get none.', swapDevices: [] };
  }
  const kv = new Map<string, string>();
  for (const l of text.split('\n')) {
    const m = /^(zswap\.[a-z_]+|zram\.[a-z0-9]+\.(?:algo|mm))=(.*)$/.exec(l.trim());
    if (m) kv.set(m[1]!, m[2]!.trim());
  }
  const swapsBlock = (/--swaps\n([\s\S]*?)(?:\n--|$)/.exec(text)?.[1] ?? '').split('\n');
  const swapDevices: SwapDevice[] = [];
  for (const l of swapsBlock) {
    const p = l.trim().split(/\s+/);
    if (p.length < 5 || p[0] === 'Filename' || !/^\d+$/.test(p[2]!)) continue;
    swapDevices.push({ name: p[0]!.replace(/\\040/g, ' '), type: p[1]!, sizeBytes: Number(p[2]) * 1024, usedBytes: Number(p[3]) * 1024, priority: Number(p[4]) });
  }
  const meminfoKb = (k: string) => { const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(text); return m ? Number(m[1]) * 1024 : undefined; };
  const enabledRaw = kv.get('zswap.enabled');
  const zswap = enabledRaw === undefined || enabledRaw === '' ? undefined : {
    enabled: /^(y|1)$/i.test(enabledRaw),
    compressor: kv.get('zswap.compressor') || undefined,
    zpool: kv.get('zswap.zpool') || undefined,
    maxPoolPercent: /^\d+$/.test(kv.get('zswap.max_pool_percent') ?? '') ? Number(kv.get('zswap.max_pool_percent')) : undefined,
    poolBytes: meminfoKb('Zswap'),
    storedBytes: meminfoKb('Zswapped'),
  };
  const zramNames = [...new Set([...kv.keys()].filter((k) => k.startsWith('zram.')).map((k) => k.split('.')[1]!))];
  const zram = zramNames.map((device) => {
    const algo = kv.get(`zram.${device}.algo`) ?? '';
    // "lzo [lzo-rle] lz4 zstd": the bracketed one is in use.
    const active = /\[([^\]]+)\]/.exec(algo)?.[1] ?? (algo.split(/\s+/).length === 1 ? algo : undefined);
    // mm_stat: orig_data_size compr_data_size mem_used_total …
    const mm = (kv.get(`zram.${device}.mm`) ?? '').split(/\s+/).map(Number);
    return { device, algorithm: active || undefined, origBytes: Number.isFinite(mm[0]) ? mm[0] : undefined, comprBytes: Number.isFinite(mm[1]) ? mm[1] : undefined, memUsedBytes: Number.isFinite(mm[2]) ? mm[2] : undefined };
  });
  const zramSwap = swapDevices.filter((d) => /^\/dev\/zram\d+$/.test(d.name));
  const behind = swapDevices.filter((d) => !/^\/dev\/zram\d+$/.test(d.name));
  const base = { swapDevices, ...(zswap ? { zswap } : {}), ...(zram.length ? { zram } : {}) };
  if (zramSwap.length) return { kind: 'zram', compressed: true, ...base };
  if (zswap?.enabled && behind.length) return { kind: 'zswap', compressed: true, ...base };
  const why = zswap?.enabled
    ? 'zswap is on, but there is no swap device behind it: agents get no swap.'
    : behind.length
      ? 'This machine swaps to disk only (uncompressed: slow to resume, and memory, keys included, written to disk): agents get no swap until zswap or zram is on.'
      : 'This machine has no swap: agents get none until zswap (with a swap file) or zram is on.';
  return { kind: 'none', compressed: false, why, ...base };
}

/** One line for the doctor and the CLI: "zswap (zstd, zsmalloc, pool ≤ 20%) · 1.2 GB stored in 0.4 GB (3.0:1)". */
export function describeCompressedSwap(s: CompressedSwap): string {
  const gb = (b: number) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
  const ratio = (orig?: number, held?: number) => orig && held ? ` (${(orig / held).toFixed(1)}:1)` : '';
  if (s.kind === 'zram') {
    const z = (s.zram ?? []).filter((d) => s.swapDevices.some((x) => x.name === `/dev/${d.device}`));
    const orig = z.reduce((n, d) => n + (d.origBytes ?? 0), 0), held = z.reduce((n, d) => n + (d.memUsedBytes ?? 0), 0);
    const algo = [...new Set(z.map((d) => d.algorithm).filter(Boolean))].join(', ');
    return `zram${algo ? ` (${algo})` : ''} · ${orig ? `${gb(orig)} stored in ${gb(held)}${ratio(orig, held)}` : 'nothing stored yet'}`;
  }
  if (s.kind === 'zswap') {
    const z = s.zswap!;
    const parts = [z.compressor, z.zpool, z.maxPoolPercent !== undefined ? `pool ≤ ${z.maxPoolPercent}%` : undefined].filter(Boolean).join(', ');
    const stored = z.storedBytes ? `${gb(z.storedBytes)} stored in ${gb(z.poolBytes ?? 0)}${ratio(z.storedBytes, z.poolBytes)}` : 'nothing stored yet';
    return `zswap (${parts}) in front of ${s.swapDevices.map((d) => d.name).join(', ')} · ${stored}`;
  }
  return s.kind === 'unknown' ? 'unknown' : 'none';
}
