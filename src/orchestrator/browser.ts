/**
 * An agent's own browser (docs/browser.md). OpenClaw's browser tool drives a
 * Chromium; Hatchabot gives each agent that has the browser switched on its
 * own, in a separate container that shares only the agent's network
 * namespace. The agent's OpenClaw attaches to it at 127.0.0.1:9222 (an
 * attach-only profile); it holds none of the agent's files, has its own
 * memory limit, and keeps its profile in memory only. Off by default: one
 * browsing question cost 315K tokens in the 2026-10-08 trial.
 *
 * The sweep keeps the containers in step with the agents: a running agent
 * with the browser on has one sharing its CURRENT network (an agent restart
 * makes a new one); anything else has none.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Store } from '../store/store.js';
import type { RuntimeProvider } from '../providers/provider.js';

/** Where an agent's OpenClaw finds its browser (in its own network namespace). */
export const BROWSER_CDP_URL = 'http://127.0.0.1:9222';
/** The attach-only OpenClaw profile Hatchabot writes for it. */
export const BROWSER_PROFILE = 'hatchabot';

export interface BrowserSpec {
  /** The agent's container: the browser joins its network namespace. */
  agentContainer: string;
  image: string;
  /** Built from this when the image is missing (on that machine). */
  dockerfile: string;
  /** docker --memory for the browser container. */
  memory: string;
}

let cached: { dockerfile: string; image: string } | undefined;
/** The browser image: tagged by its Dockerfile's hash, so a change builds a new one. */
export function browserImage(): { dockerfile: string; image: string } {
  if (!cached) {
    const dockerfile = readFileSync(fileURLToPath(new URL('../../docker/Dockerfile.browser', import.meta.url)), 'utf8');
    cached = { dockerfile, image: `hatchabot-browser:${createHash('sha256').update(dockerfile).digest('hex').slice(0, 12)}` };
  }
  return cached;
}

/** The container a runtime ref names (docker://<name>). */
export const containerOf = (runtimeRef: string | undefined): string | undefined =>
  /^[a-z]+:\/\/(.+)$/.exec(runtimeRef ?? '')?.[1];

/**
 * What the sweeps share (2026-10-09). Each machine is swept by one sweep at a
 * time: the sweep runs every minute, and a slow image build (minutes) used to
 * have the next sweep start another build beside it, and a sweep that listed
 * the browsers before a start could remove the one just made. A build that
 * failed is not tried again on that machine until its back-off is over
 * (1 minute, doubling to an hour): every agent logged a failure every minute.
 */
export interface BrowserSweepState {
  /** The sweep under way on each machine. */
  sweeping: Map<string, Promise<unknown>>;
  /** `<host>|<image>` → when a build may be tried again, and how many have failed. */
  buildFailed: Map<string, { until: number; fails: number }>;
}
const sharedState: BrowserSweepState = { sweeping: new Map(), buildFailed: new Map() };
const BUILD_BACKOFF_MS = 60_000;
const BUILD_BACKOFF_MAX_MS = 3600_000;

/**
 * Bring every machine's browsers in line with its agents. `only` limits the
 * starts to one agent (right after it starts); removals are always checked.
 * A machine that is asleep is skipped, and so is one another sweep is still
 * on — except for `only` (an agent just started), which waits its turn.
 */
export async function browserSweep(deps: {
  store: Store;
  hostIds: () => string[];
  providerFor: (hostId: string) => RuntimeProvider;
  log?: (agentId: string | undefined, event: string, detail: Record<string, unknown>) => void;
  memory?: string;
  state?: BrowserSweepState;
  now?: () => number;
}, only?: string): Promise<{ started: string[]; removed: string[]; failed: string[] }> {
  const out = { started: [] as string[], removed: [] as string[], failed: [] as string[] };
  const st = deps.state ?? sharedState;
  for (const hostId of deps.hostIds()) {
    const busy = st.sweeping.get(hostId);
    if (busy && !only) continue;
    const run = (async () => {
      if (busy) await busy.catch(() => {});
      await sweepHost(deps, st, hostId, out, only);
    })();
    st.sweeping.set(hostId, run);
    try { await run; } finally { if (st.sweeping.get(hostId) === run) st.sweeping.delete(hostId); }
  }
  return out;
}

async function sweepHost(
  deps: Parameters<typeof browserSweep>[0],
  st: BrowserSweepState,
  hostId: string,
  out: { started: string[]; removed: string[]; failed: string[] },
  only?: string,
): Promise<void> {
  const p = deps.providerFor(hostId);
  if (!p.ensureBrowser || !p.listBrowsers || !p.stopBrowser) return;
  if (p.reachable && !(await p.reachable().catch(() => false))) return;
  // The agents as they are now, not when an earlier sweep began.
  const agents = deps.store.listAllActiveAgents();
  const want = new Map<string, string>();
  for (const a of agents) {
    const c = containerOf(a.runtimeRef);
    if (a.hostId === hostId && a.browser === true && a.state === 'RUNNING' && c) want.set(c, a.id);
  }
  const have = await p.listBrowsers().catch(() => []);
  for (const b of have) {
    if (want.has(b.agentContainer)) continue;
    try { await p.stopBrowser(b.agentContainer); out.removed.push(b.name); deps.log?.(undefined, 'browser.removed', { container: b.name }); }
    catch { out.failed.push(b.name); }
  }
  const img = browserImage();
  const key = `${hostId}|${img.image}`;
  const now = deps.now ?? Date.now;
  for (const [c, agentId] of want) {
    if (only && agentId !== only) continue;
    // A build that failed here waits out its back-off: no new build, no line per agent per minute.
    const failed = st.buildFailed.get(key);
    if (failed && now() < failed.until) { out.failed.push(c); continue; }
    try {
      const r = await p.ensureBrowser({ agentContainer: c, ...img, memory: deps.memory ?? (process.env.HATCHABOT_BROWSER_MEMORY?.trim() || '1g') });
      st.buildFailed.delete(key);
      if (r === 'started') { out.started.push(c); deps.log?.(agentId, 'browser.started', {}); }
    } catch (err) {
      out.failed.push(c);
      const message = err instanceof Error ? err.message : String(err);
      if (/browser image build failed/.test(message)) {
        const fails = (failed?.fails ?? 0) + 1;
        const wait = Math.min(BUILD_BACKOFF_MS * 2 ** (fails - 1), BUILD_BACKOFF_MAX_MS);
        st.buildFailed.set(key, { until: now() + wait, fails });
        deps.log?.(agentId, 'browser.start_failed', { error: message.slice(0, 300), retryInSec: Math.round(wait / 1000) });
      } else {
        deps.log?.(agentId, 'browser.start_failed', { error: message.slice(0, 300) });
      }
    }
  }
}
