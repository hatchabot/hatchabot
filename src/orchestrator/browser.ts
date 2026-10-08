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
 * Bring every machine's browsers in line with its agents. `only` limits the
 * starts to one agent (right after it starts); removals are always checked.
 * A machine that is asleep is skipped.
 */
export async function browserSweep(deps: {
  store: Store;
  hostIds: () => string[];
  providerFor: (hostId: string) => RuntimeProvider;
  log?: (agentId: string | undefined, event: string, detail: Record<string, unknown>) => void;
  memory?: string;
}, only?: string): Promise<{ started: string[]; removed: string[]; failed: string[] }> {
  const out = { started: [] as string[], removed: [] as string[], failed: [] as string[] };
  const agents = deps.store.listAllActiveAgents();
  for (const hostId of deps.hostIds()) {
    const p = deps.providerFor(hostId);
    if (!p.ensureBrowser || !p.listBrowsers || !p.stopBrowser) continue;
    if (p.reachable && !(await p.reachable().catch(() => false))) continue;
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
    for (const [c, agentId] of want) {
      if (only && agentId !== only) continue;
      try {
        const r = await p.ensureBrowser({ agentContainer: c, ...browserImage(), memory: deps.memory ?? (process.env.HATCHABOT_BROWSER_MEMORY?.trim() || '1g') });
        if (r === 'started') { out.started.push(c); deps.log?.(agentId, 'browser.started', {}); }
      } catch (err) {
        out.failed.push(c);
        deps.log?.(agentId, 'browser.start_failed', { error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      }
    }
  }
  return out;
}
