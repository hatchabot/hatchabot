/**
 * The memory cap on an agent's container: a ceiling, not a reservation.
 *
 * One fleet-wide number sized for the typical agent starves the heavy one
 * (Genetic Algorithm Trading ran a 12-worker backtest into a 2 GiB cap, had
 * 27 workers killed by the kernel, and its gateway quit; 2026-09-24). So:
 * the fleet default (HATCHABOT_AGENT_MEMORY) covers OpenClaw's own baseline
 * with headroom; a class or an agent can carry its own cap; members may raise
 * their own agents up to HATCHABOT_AGENT_MEMORY_MAX, the machine owner beyond
 * it. A change applies live (`docker update`) and sticks across rebuilds.
 * The agent is told its budget (env + AGENTS.md) so it can size its jobs.
 */
import type { Agent, AgentClass } from '../domain/types.js';

export const MEMORY_CAP_MIN_BYTES = 512 * 1024 ** 2;
/** A ceiling on what any setting accepts, so a typo cannot ask docker for 400 TB. */
export const MEMORY_CAP_CEILING_BYTES = 512 * 1024 ** 3;
export const DEFAULT_MEMORY_CAP = '3g';
export const DEFAULT_MEMBER_MAX = '8g';

/** "3g", "4096m", "2.5G", "1536M" → bytes; undefined when it is not a cap. */
export function parseMemoryCap(input: unknown): number | undefined {
  if (typeof input !== 'string') return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([mMgG])[bB]?\s*$/.exec(input);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const bytes = Math.round(n * (m[2]!.toLowerCase() === 'g' ? 1024 ** 3 : 1024 ** 2));
  if (bytes < MEMORY_CAP_MIN_BYTES || bytes > MEMORY_CAP_CEILING_BYTES) return undefined;
  return bytes;
}

/** Bytes → the shortest docker-style string that means the same ("3g", "1536m"). */
export function formatMemoryCap(bytes: number): string {
  const g = bytes / 1024 ** 3;
  if (Number.isInteger(g)) return `${g}g`;
  return `${Math.round(bytes / 1024 ** 2)}m`;
}

/** Bytes → what a person reads ("3 GB", "1.5 GB", "768 MB"). */
export function describeMemoryCap(bytes: number): string {
  const g = bytes / 1024 ** 3;
  if (g >= 1) return `${Number.isInteger(g) ? g : g.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** The fleet default, from the environment; a bad value falls back to 3g. */
export function defaultMemoryCap(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.HATCHABOT_AGENT_MEMORY ?? '').trim();
  return parseMemoryCap(v) ? formatMemoryCap(parseMemoryCap(v)!) : DEFAULT_MEMORY_CAP;
}

/** The most a member may give one of their own agents; the machine owner is not bound by it. */
export function memberMemoryMax(env: NodeJS.ProcessEnv = process.env): string {
  const v = (env.HATCHABOT_AGENT_MEMORY_MAX ?? '').trim();
  const parsed = parseMemoryCap(v);
  const floor = parseMemoryCap(defaultMemoryCap(env))!;
  // Never below the default: a max the default already exceeds would forbid the default.
  return formatMemoryCap(Math.max(parsed ?? parseMemoryCap(DEFAULT_MEMBER_MAX)!, floor));
}

/** The cap an agent's container gets: its own, else its class's, else the fleet default. */
export function effectiveMemoryCap(agent: Pick<Agent, 'memoryCap'>, cls: Pick<AgentClass, 'memoryCap'> | undefined, env: NodeJS.ProcessEnv = process.env): string {
  for (const v of [agent.memoryCap, cls?.memoryCap]) {
    const b = parseMemoryCap(v);
    if (b) return formatMemoryCap(b);
  }
  return defaultMemoryCap(env);
}

/** One step up from a cap: +1 GB, on a GB boundary. */
export function bumpMemoryCap(cap: string): string {
  const b = parseMemoryCap(cap) ?? parseMemoryCap(DEFAULT_MEMORY_CAP)!;
  const g = Math.floor(b / 1024 ** 3) + 1;
  return `${g}g`;
}

/** The choices a picker offers, the fleet default first, up to `max` (bytes). */
export function memoryCapChoices(max: number): string[] {
  return ['1g', '2g', '3g', '4g', '6g', '8g', '12g', '16g', '24g', '32g', '48g', '64g'].filter((c) => parseMemoryCap(c)! <= max);
}

/**
 * The AGENTS.md section that tells the agent its budget. OpenClaw already
 * tells the model when a command was killed by SIGKILL and suggests narrowing
 * it; with the number in hand it can size a job before running it.
 */
export function memoryBudgetSection(cap: string): string {
  const bytes = parseMemoryCap(cap) ?? parseMemoryCap(DEFAULT_MEMORY_CAP)!;
  return `## Memory budget
- Your container has **${describeMemoryCap(bytes)}** of memory in total (also in the
  environment as \`HATCHABOT_MEMORY_CAP=${formatMemoryCap(bytes)}\`). OpenClaw itself uses
  about 1 GB of that; the rest is for the commands and scripts you run.
- Size jobs to fit: fewer parallel workers, chunked data, streaming over
  loading whole files. A command killed with SIGKILL and no other reason was
  killed for memory — run it smaller, do not just retry it.
- If a job genuinely needs more, say so: your owner can raise the cap from
  your settings (Runtime → Memory cap).`;
}
