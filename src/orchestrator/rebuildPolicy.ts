/**
 * When does an agent need a rebuild, how badly, and may this machine do it on
 * its own?
 *
 * A rebuild recreates the container from the current image and the current
 * way of making containers; memory is on the volume and survives. Releases
 * used to have no way to say "this one needs every agent rebuilt": the move
 * onto the isolated agents network (v1.16.0) shipped, and a week later most
 * agents on the development machine were still on the shared one, because
 * nothing told anyone and the app badged every image difference alike.
 *
 * Three signals, each with a level:
 * - the container sits on docker's shared network instead of the isolated
 *   one — REQUIRED (other agents can reach it directly);
 * - the container was made before a release that changed how containers are
 *   made (SETUP_CHANGES, below) — that change's level;
 * - it runs an older runtime image than the default — RECOMMENDED.
 *
 * The machine's policy (HATCHABOT_REBUILD_POLICY) decides what happens on its
 * own: `required-only` (the default) rebuilds required ones once the agent is
 * idle; `auto` also does recommended ones in the quiet hours; `manual` only
 * shows them.
 */

export type RebuildLevel = 'required' | 'recommended';

export interface SetupChange {
  /** Stamped on every container made from this release on (label hatchabot.gen). */
  gen: number;
  /** The release that made the change. */
  version: string;
  /** optional: no badge at all — the next rebuild for any reason picks it up. */
  level: RebuildLevel | 'optional';
  /** What the owner is told, completing "needs a rebuild: …". */
  why: string;
}

/**
 * Append one entry when a release changes how containers are MADE (docker run
 * flags, mounts, network, what the seed writes) such that existing agents
 * should be remade. Never edit or remove an entry: containers carry the
 * number. Containers from before this list existed count as generation 0.
 */
export const SETUP_CHANGES: SetupChange[] = [];

export const CONTAINER_GEN = SETUP_CHANGES.reduce((n, c) => Math.max(n, c.gen), 0);

export interface RebuildNeed {
  level: RebuildLevel;
  reasons: string[];
}

export function rebuildNeed(
  info: { containerGen?: number; onAgentNetwork?: boolean },
  imageBehind: boolean,
  changes: SetupChange[] = SETUP_CHANGES,
): RebuildNeed | undefined {
  const required: string[] = [];
  const recommended: string[] = [];
  if (info.onAgentNetwork === false) required.push('it is still on the shared network, where other agents can reach it');
  const gen = info.containerGen ?? 0;
  for (const c of changes) {
    if (c.gen <= gen || c.level === 'optional') continue;
    (c.level === 'required' ? required : recommended).push(c.why);
  }
  if (imageBehind) recommended.push('a newer runtime image is available');
  const reasons = [...required, ...recommended];
  if (!reasons.length) return undefined;
  return { level: required.length ? 'required' : 'recommended', reasons };
}

export type RebuildPolicy = 'auto' | 'required-only' | 'manual';
export const REBUILD_POLICIES: RebuildPolicy[] = ['required-only', 'auto', 'manual'];

export function rebuildPolicy(env: NodeJS.ProcessEnv = process.env): RebuildPolicy {
  const v = (env.HATCHABOT_REBUILD_POLICY ?? '').trim();
  return (REBUILD_POLICIES as string[]).includes(v) ? (v as RebuildPolicy) : 'required-only';
}

/** Quiet hours, local time: "3-5" = from 03:00 until 05:00. Wraps midnight ("23-5"). */
export function inQuietHours(now: Date, spec = process.env.HATCHABOT_REBUILD_QUIET_HOURS ?? '3-5'): boolean {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec);
  const [from, to] = m ? [Number(m[1]) % 24, Number(m[2]) % 24] : [3, 5];
  const h = now.getHours();
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

export interface RebuildCandidate {
  id: string;
  need?: RebuildNeed;
  state: string;
  ops?: boolean;
  /** Already rebuilding, provisioning, moving, or otherwise held. */
  busy: boolean;
  /** Its newest conversation activity (ISO), if known. */
  lastActiveAt?: string;
  /** Its memory search engine was switched and the rebuild is still owed: done
   *  in the quiet hours under any policy but manual (the owner asked for it). */
  switchPending?: boolean;
}

/**
 * Which agents to rebuild now, on the machine's own initiative. Never the
 * Hatchabot agent (it moves last, by a deliberate action), never a stopped
 * one (a rebuild would start it), never one in a conversation: idle for
 * `idleMinutes` first, so a rebuild never lands mid-reply. A few at a time.
 */
export function pickAutoRebuilds(
  candidates: RebuildCandidate[],
  policy: RebuildPolicy,
  now: Date,
  opts: { max?: number; idleMinutes?: number; quiet?: boolean } = {},
): string[] {
  if (policy === 'manual') return [];
  const quiet = opts.quiet ?? inQuietHours(now);
  const idleMs = (opts.idleMinutes ?? 10) * 60_000;
  const due = candidates.filter((c) => {
    if ((!c.need && !c.switchPending) || c.ops || c.busy || c.state !== 'RUNNING') return false;
    if (c.lastActiveAt && now.getTime() - Date.parse(c.lastActiveAt) < idleMs) return false;
    if (c.switchPending && quiet) return true;
    return !!c.need && (c.need.level === 'required' || (policy === 'auto' && quiet));
  });
  // Required first; then the longest idle.
  due.sort((a, b) =>
    (a.need?.level === 'required' ? 0 : 1) - (b.need?.level === 'required' ? 0 : 1) ||
    Date.parse(a.lastActiveAt ?? '1970-01-01') - Date.parse(b.lastActiveAt ?? '1970-01-01'));
  return due.slice(0, opts.max ?? 2).map((c) => c.id);
}
