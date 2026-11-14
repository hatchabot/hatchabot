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
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Store } from '../store/store.js';
import type { RuntimeProvider } from '../providers/provider.js';
import { DEFAULT_PREFIX, dockerNames } from '../providers/dockerNames.js';

/** Where an agent's OpenClaw finds its browser (in its own network namespace). */
export const BROWSER_CDP_URL = 'http://127.0.0.1:9222';
/** The attach-only OpenClaw profile Hatchabot writes for it. */
export const BROWSER_PROFILE = 'hatchabot';

export interface BrowserSpec {
  /** The agent's container: the browser joins its network namespace. */
  agentContainer: string;
  /** The agent's id: a kept profile's volume is labelled with it. */
  agentId?: string;
  /** Keep its logins: the profile it keeps (its volume's id). Unset, the profile is in memory only. */
  logins?: string;
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

/**
 * The user Chromium runs as in its image: not the agent's (1000), so a rule in
 * the network namespace they share can hold the browser alone (HB-0679).
 */
export const BROWSER_UID = 1001;
/**
 * Where the browser may not open a connection: this machine and the agent's
 * own ports (loopback), the LAN, the tailnet (100.64/10), link-local (cloud
 * metadata), and the reserved rest. Docker's own DNS (127.0.0.11) stays open.
 */
export const BROWSER_FENCED_V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'];
export const BROWSER_FENCED_V6 = ['::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'];
/**
 * The fence (HB-0679), run as root with NET_ADMIN only, once per browser start,
 * in a throwaway container in the agent's network namespace, before Chromium
 * starts. OpenClaw refuses a private address the agent asks for, and guards
 * page loads while an action runs; a page that sends itself to one LATER (a
 * timer) went out unguarded and reached it (2026-11-12). This holds the
 * browser's user off those addresses in the kernel; the agent (another user)
 * keeps its own reach (Ollama on the LAN, say). Its own chain, flushed and
 * filled again, so a second run leaves one copy. Prints FENCED when the rule
 * is in place; anything else, and the browser is not started.
 */
export const BROWSER_FENCE_SCRIPT = `set -e
fence() {
  t=$1; shift
  $t -w -N HB_BROWSER 2>/dev/null || true
  $t -w -F HB_BROWSER
  if [ "$t" = iptables ]; then $t -w -A HB_BROWSER -d 127.0.0.11 -j RETURN; fi
  for d in "$@"; do $t -w -A HB_BROWSER -d "$d" -m conntrack --ctstate NEW -j REJECT; done
  $t -w -C OUTPUT -m owner --uid-owner ${BROWSER_UID} -j HB_BROWSER 2>/dev/null || $t -w -I OUTPUT 1 -m owner --uid-owner ${BROWSER_UID} -j HB_BROWSER
}
fence iptables ${BROWSER_FENCED_V4.join(' ')}
if [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null)" = 1 ]; then echo "IPv6 is off here"; else fence ip6tables ${BROWSER_FENCED_V6.join(' ')}; fi
iptables -w -C OUTPUT -m owner --uid-owner ${BROWSER_UID} -j HB_BROWSER && echo FENCED`;

/**
 * Keep its logins (HB-0680, docs/browser-logins-design.md). The profile is a
 * volume per agent, named for the agent's container and an id the agent's
 * record holds. Forget gives the agent a new id: the old volume is never
 * mounted again, even when its machine cannot be reached at that moment, and
 * the sweep removes it once it can. Never in a backup, a download, a template
 * or a clone: its cookies are as good as passwords.
 */
export const newBrowserLogins = (): string => randomBytes(6).toString('hex');
export const BROWSER_LOGINS_RE = /^[0-9a-f]{12}$/;
export const browserLoginsVolume = (agentContainer: string, logins: string): string => `${agentContainer}-browser-logins-${logins}`;
/** Its label, which the backup script leaves out by (scripts/backup-volumes.sh). */
export const BROWSER_LOGINS_ROLE = 'browser-logins';
/** A kept profile past this is said in its agent's timeline, once a day. */
export const BROWSER_PROFILE_WARN_BYTES = 500 * 1024 * 1024;
/**
 * A new profile volume, once, as root with only the right to change owners:
 * a new volume is root's, and Chromium (1001) did not start on it. "Continue
 * where you left off" too: without it Chromium drops session cookies when it
 * ends, and a session cookie is how most sites keep a sign-in (the trial).
 */
export const BROWSER_PROFILE_PREP = `set -e
mkdir -p /profile/Default
[ -e /profile/Default/Preferences ] || printf '%s' '{"session":{"restore_on_startup":1}}' > /profile/Default/Preferences
chown -R ${BROWSER_UID}:${BROWSER_UID} /profile
echo READY`;
/**
 * Before each start, as the browser's user: the lock a browser removed
 * without closing leaves (a power cut, an agent's container gone first).
 * Another Chromium may take it for its own and refuse the profile.
 */
export const BROWSER_PROFILE_UNLOCK = 'rm -f /profile/SingletonLock /profile/SingletonSocket /profile/SingletonCookie && echo UNLOCKED';
/**
 * Closing a browser that keeps logins: run with node in the agent's container,
 * as the agent's user (the fence holds the browser's user off loopback, where
 * the port is). Browser.close writes the profile and Chromium exits in about
 * two seconds; `docker stop` or `rm -f` ends it first, and what changed in
 * the last half minute, a sign-in included, was lost (the trial). Prints
 * CLOSING once the browser has the command.
 */
export const BROWSER_CLOSE_SOURCE = `const quit = (c) => process.exit(c);
setTimeout(() => quit(2), 6000);
try {
  const v = await (await fetch('${BROWSER_CDP_URL}/json/version', { signal: AbortSignal.timeout(3000) })).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  const done = () => { console.log('CLOSING'); quit(0); };
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  ws.onmessage = (m) => { try { if (JSON.parse(String(m.data)).id === 1) done(); } catch {} };
  ws.onclose = done;
  ws.onerror = () => quit(1);
} catch { quit(1); }`;

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
  const want = new Map<string, { agentId: string; logins?: string }>();
  for (const a of agents) {
    const c = a.hostId === hostId ? containerOf(a.runtimeRef, p) : undefined;
    if (a.hostId === hostId && a.browser === true && a.state === 'RUNNING' && c) want.set(c, { agentId: a.id, ...(a.browserLogins ? { logins: a.browserLogins } : {}) });
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
  for (const [c, { agentId, logins }] of want) {
    if (only && agentId !== only) continue;
    // A build that failed here waits out its back-off: no new build, no line per agent per minute.
    const failed = st.buildFailed.get(key);
    if (failed && now() < failed.until) { out.failed.push(c); continue; }
    try {
      const r = await p.ensureBrowser({ agentContainer: c, agentId, ...(logins ? { logins } : {}), ...img, memory: deps.memory ?? (process.env.HATCHABOT_BROWSER_MEMORY?.trim() || '1g') });
      st.buildFailed.delete(key);
      if (r === 'started') { out.started.push(c); deps.log?.(agentId, 'browser.started', {}); }
    } catch (err) {
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
  await sweepLogins(deps, st, hostId, p, agents, want, out, now);
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
  agents: ReturnType<Store['listAllActiveAgents']>,
  want: Map<string, { agentId: string; logins?: string }>,
  out: { removed: string[] },
  now: () => number,
): Promise<void> {
  if (p.listBrowserLogins && p.removeBrowserLogins) {
    const byId = new Map(agents.map((a) => [a.id, a]));
    for (const v of await p.listBrowserLogins().catch(() => [])) {
      const a = v.agentId ? byId.get(v.agentId) : undefined;
      const c = a ? containerOf(a.runtimeRef, p) : undefined;
      const why = !a ? 'agent gone'
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
