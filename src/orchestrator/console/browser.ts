/**
 * An agent's own browser (docs/browser.md). OpenClaw's browser tool drives a
 * Chromium; Hatchabot gives each agent that has the browser switched on its
 * own, in a separate container that shares only the agent's network
 * namespace. The agent's OpenClaw attaches to it at 127.0.0.1:9222 (an
 * attach-only profile); it holds none of the agent's files, has its own
 * memory limit, and keeps its profile in memory only, unless its owner
 * switches on Keep its logins (HB-0680): then the profile is a volume of its
 * own, kept until they forget it. Off by default: one browsing question cost
 * 315K tokens in the 2026-10-08 trial.
 *
 * The sweep keeps the containers in step with the agents: a running agent
 * with the browser on has one sharing its CURRENT network (an agent restart
 * makes a new one); anything else has none. And the kept profiles: one for
 * each agent here that keeps logins, whatever its state; the rest go.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Store } from '../../store/store.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import { DEFAULT_PREFIX, dockerNames } from '../../providers/dockerNames.js';

let cached: { dockerfile: string; image: string } | undefined;
/** The browser image: tagged by its Dockerfile's hash, so a change builds a new one. */
export function browserImage(): { dockerfile: string; image: string } {
  if (!cached) {
    const dockerfile = readFileSync(fileURLToPath(new URL('../../../docker/Dockerfile.browser', import.meta.url)), 'utf8');
    cached = { dockerfile, image: `hatchabot-browser:${createHash('sha256').update(dockerfile).digest('hex').slice(0, 12)}` };
  }
  return cached;
}

/** A kept profile past this is said in its agent's timeline, once a day. */
export const BROWSER_PROFILE_WARN_BYTES = 500 * 1024 * 1024;

/** The day the browser image's Chromium was last refreshed (its Dockerfile's CHROMIUM_REFRESH), or undefined. */
export function browserRefreshDate(dockerfile: string = browserImage().dockerfile): string | undefined {
  return /^ARG CHROMIUM_REFRESH=(\d{4}-\d{2}-\d{2})\s*$/m.exec(dockerfile)?.[1];
}

/**
 * The container a runtime ref names, by its provider's rule: a legacy
 * docker://<uuid> agent's container is not its bare fragment (HB-0325).
 * A provider without one: docker's rule (dockerNames) for a docker:// ref,
 * else the ref's name.
 */
export const containerOf = (runtimeRef: string | undefined, p?: Pick<RuntimeProvider, 'containerName'>): string | undefined => {
  if (!runtimeRef) return undefined;
  if (p?.containerName) return p.containerName(runtimeRef);
  if (/^docker:\/\/./.test(runtimeRef)) return dockerNames(runtimeRef, process.env.HATCHABOT_PREFIX || DEFAULT_PREFIX).container;
  return /^[a-z]+:\/\/(.+)$/.exec(runtimeRef)?.[1];
};

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
  /** A kept profile's size: when it was last measured, and last said to be large. */
  sizes?: Map<string, { at: number; warnedAt?: number }>;
}
const sharedState: BrowserSweepState = { sweeping: new Map(), buildFailed: new Map(), sizes: new Map() };
const SIZE_EVERY_MS = 3600_000;
const SIZE_WARN_EVERY_MS = 24 * 3600_000;
const BUILD_BACKOFF_MS = 60_000;
const BUILD_BACKOFF_MAX_MS = 3600_000;

/**
 * Bring every machine's browsers in line with its agents. `only` limits the
 * starts to one agent (right after it starts); removals are always checked.
 * A machine that is asleep is skipped, and so is one another sweep is still
 * on — except `only`'s own machine (its agent just started), which it
 * sweeps first, waiting its turn there. It waited for each machine's sweep
 * in turn, a slow build on another machine too, before it reached its own
 * (HB-0949).
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
  const sweepOne = async (hostId: string, waitTurn: boolean) => {
    const busy = st.sweeping.get(hostId);
    if (busy && !waitTurn) return;
    const run = (async () => {
      if (busy) await busy.catch(() => {});
      await sweepHost(deps, st, hostId, out, only);
    })();
    st.sweeping.set(hostId, run);
    try { await run; } finally { if (st.sweeping.get(hostId) === run) st.sweeping.delete(hostId); }
  };
  const hosts = deps.hostIds();
  const own = only ? deps.store.getAgent(only)?.hostId : undefined;
  if (own && hosts.includes(own)) await sweepOne(own, true);
  for (const hostId of hosts) if (hostId !== own) await sweepOne(hostId, false);
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
  const host = deps.store.getHost(hostId);
  const hostStillCurrent = () => {
    const current = deps.store.getHost(hostId);
    return current?.ownerId === host?.ownerId && current?.provider === host?.provider
      && JSON.stringify(current?.settings) === JSON.stringify(host?.settings);
  };
  if (p.reachable && !(await p.reachable().catch(() => false))) return;
  const wanted = () => {
    const want = new Map<string, { agentId: string; logins?: string; stillWanted: () => boolean }>();
    for (const a of deps.store.listAllActiveAgents()) {
      const c = a.hostId === hostId ? containerOf(a.runtimeRef, p) : undefined;
      if (a.browser !== true || a.state !== 'RUNNING' || !c) continue;
      const stillWanted = () => {
        const current = deps.store.getAgent(a.id);
        return hostStillCurrent() && current?.ownerId === a.ownerId && current.hostId === hostId
          && current.runtimeRef === a.runtimeRef && current.state === 'RUNNING' && current.browser === true
          && current.browserLogins === a.browserLogins;
      };
      want.set(c, { agentId: a.id, ...(a.browserLogins ? { logins: a.browserLogins } : {}), stillWanted });
    }
    return want;
  };
  // Which agent each container here is, read once: each browser is then
  // checked against its own agent as it is now. The whole fleet was read for
  // every browser, the minute's sweep over N browsers N times (HB-1023).
  const agentOf = new Map<string, string>();
  for (const a of deps.store.listAllActiveAgents()) {
    const c = a.hostId === hostId ? containerOf(a.runtimeRef, p) : undefined;
    if (c) agentOf.set(c, a.id);
  }
  const wantedNow = (c: string) => {
    const id = agentOf.get(c);
    const a = id ? deps.store.getAgent(id) : undefined;
    return !!a && a.hostId === hostId && a.browser === true && a.state === 'RUNNING' && containerOf(a.runtimeRef, p) === c;
  };
  const have = await p.listBrowsers().catch(() => []);
  for (const b of have) {
    if (!hostStillCurrent()) return;
    if (wantedNow(b.agentContainer)) continue;
    try { await p.stopBrowser(b.agentContainer); out.removed.push(b.name); deps.log?.(undefined, 'browser.removed', { container: b.name }); }
    catch { out.failed.push(b.name); }
  }
  const img = browserImage();
  const key = `${hostId}|${img.image}`;
  const now = deps.now ?? Date.now;
  for (const [c, { agentId, logins, stillWanted }] of wanted()) {
    if (only && agentId !== only) continue;
    if (!stillWanted()) continue;
    // A build that failed here waits out its back-off: no new build, no line per agent per minute.
    const failed = st.buildFailed.get(key);
    if (failed && now() < failed.until) { out.failed.push(c); continue; }
    try {
      const r = await p.ensureBrowser({ agentContainer: c, agentId, ...(logins ? { logins } : {}), ...img, memory: deps.memory ?? (process.env.HATCHABOT_BROWSER_MEMORY?.trim() || '1g'), stillWanted });
      if (!stillWanted()) { await p.stopBrowser(c); continue; }
      st.buildFailed.delete(key);
      if (r === 'started') { out.started.push(c); deps.log?.(agentId, 'browser.started', {}); }
    } catch (err) {
      // A cancelled request is expected, but confirm a possibly started stale
      // browser is gone before suppressing its failure.
      if (!stillWanted()) {
        try { await p.stopBrowser(c); } catch { out.failed.push(c); }
        continue;
      }
      out.failed.push(c);
      const message = err instanceof Error ? err.message : String(err);
      // A fence that cannot be set fails the same way for every agent there: it backs off too.
      if (/browser image build failed|browser fence failed/.test(message)) {
        const fails = (failed?.fails ?? 0) + 1;
        const wait = Math.min(BUILD_BACKOFF_MS * 2 ** (fails - 1), BUILD_BACKOFF_MAX_MS);
        st.buildFailed.set(key, { until: now() + wait, fails });
        deps.log?.(agentId, 'browser.start_failed', { error: message.slice(0, 300), retryInSec: Math.round(wait / 1000) });
      } else {
        deps.log?.(agentId, 'browser.start_failed', { error: message.slice(0, 300) });
      }
    }
  }
  if (hostStillCurrent()) await sweepLogins(deps, st, hostId, p, wanted(), out, now, hostStillCurrent);
}

/**
 * The kept profiles on one machine: each stays while its agent is here, not
 * archived, has the browser on and keeps that profile (any state: a stopped or
 * sleeping agent keeps its logins). The rest are removed: forgotten, switched
 * off, archived, deleted, moved away. One a browser still holds is refused by
 * Docker and tried again next time. Then how big the running ones are, hourly.
 */
async function sweepLogins(
  deps: Parameters<typeof browserSweep>[0],
  st: BrowserSweepState,
  hostId: string,
  p: RuntimeProvider,
  want: Map<string, { agentId: string; logins?: string }>,
  out: { removed: string[] },
  now: () => number,
  hostStillCurrent: () => boolean,
): Promise<void> {
  if (p.listBrowserLogins && p.removeBrowserLogins) {
    for (const v of await p.listBrowserLogins().catch(() => [])) {
      if (!hostStillCurrent()) return;
      const a = v.agentId ? deps.store.getAgent(v.agentId) : undefined;
      const c = a ? containerOf(a.runtimeRef, p) : undefined;
      const why = !a || a.state === 'DELETED' ? 'agent gone'
        : a.hostId !== hostId ? 'moved'
        : a.state === 'ARCHIVED' ? 'archived'
        : a.browser !== true ? 'browser off'
        : a.browserLogins !== v.logins ? (a.browserLogins ? 'forgotten' : 'switched off')
        : c && c !== v.agentContainer ? 'another container'
        : undefined;
      if (!why) continue;
      if (await p.removeBrowserLogins(v.name).catch(() => false)) { out.removed.push(v.name); deps.log?.(a?.id, 'browser.logins_removed', { why }); }
    }
  }
  if (!p.browserProfileBytes) return;
  const sizes = st.sizes ?? (st.sizes = new Map());
  for (const [c, { agentId, logins }] of want) {
    if (!logins) continue;
    const seen = sizes.get(c);
    if (seen && now() - seen.at < SIZE_EVERY_MS) continue;
    const bytes = await p.browserProfileBytes(c).catch(() => undefined);
    const warn = bytes !== undefined && bytes > BROWSER_PROFILE_WARN_BYTES && (!seen?.warnedAt || now() - seen.warnedAt >= SIZE_WARN_EVERY_MS);
    sizes.set(c, { at: now(), ...(warn ? { warnedAt: now() } : seen?.warnedAt ? { warnedAt: seen.warnedAt } : {}) });
    if (warn) deps.log?.(agentId, 'browser.profile_large', { mb: Math.round(bytes / 1048576) });
  }
}
