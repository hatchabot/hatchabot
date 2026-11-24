import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import { SecretNotFoundError, type SecretStore } from '../../secrets/secretStore.js';
import type { Store } from '../../store/store.js';
import { SEARCH_KEY_REF } from '../lifecycle/provision.js';
import { ownSearchKey } from '../usage/sourceUsage.js';
import { OWN_BRAVE, readSearchPrice, saveSearchPrice, SEARCH_CHECKS, searchUsageReport, type SearchPrice, type SearchUsageReport } from './searchUsage.js';
import { AGENT_SEARCH_TEST_ARGV, createSearchWatch, readAgentSearchTest, type AgentSearchTest, type SearchWatch, type WebSearchState } from './webSearch.js';

/**
 * Which search the fleet uses, and whether it works (HB-0808 step 15): the
 * one search watch (webSearch.ts, `createSearchWatch`), built here once per
 * process, its ten-minute tick, what the Settings page reads of it, the
 * month's searches (searchUsage.ts), and a real search inside one agent.
 * Nothing here knows about HTTP: who may ask is the route's.
 */
export interface FleetSearch {
  /** The one search watch: the manager's own search (mgmtChat's opsWeb) reads and nudges it too. */
  watch: SearchWatch;
  /** What the page shows: the watch's state, whether agents are moving, whether a key is set. */
  view(): Promise<SearchView>;
  /** Probe now (one at a time, however often it is pressed: a check spends one Brave query), then the view. */
  check(): Promise<SearchView>;
  /** The month's searches: Brave's against what the key allows, per day, per agent, and the cost (HB-0532). */
  usage(): Promise<SearchUsageReport>;
  /** Save what a Brave search costs and which search the fleet uses; the view after a mode, else the usage. */
  set(change: { mode?: WebSearchState['mode']; price?: SearchPrice }): Promise<SearchView | SearchUsageReport>;
  /** A real search in the agent, through its own settings and keys (the route has checked it may run one). */
  agentTest(agent: Agent & { runtimeRef: string }): Promise<AgentSearchTest>;
  /** A key changed, so what the fleet should use may have: checked again, in the background. */
  keyChanged(): void;
  /** End the tick's timer. */
  stop(): void;
}

export type SearchView = WebSearchState & { moving: boolean; keySet: boolean };

export interface FleetSearchDeps {
  store: Store;
  secrets: Pick<SecretStore, 'get'>;
  providerFor: (hostId: string) => RuntimeProvider;
  isBusy: (agentId: string) => boolean;
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Tell the machine's owner (the watch says when the fleet moved by itself, or nothing works). */
  notify: (headline: string, detail: string) => void;
  /** The watch's own lines. */
  info: (event: string, detail: Record<string, unknown>) => void;
  warn: (detail: Record<string, unknown>, msg: string) => void;
  /** The tests' stand-in for Brave and DuckDuckGo (no waits between tries then). */
  searchFetch?: typeof fetch;
  /** How often the watch asks Brave again (HATCHABOT_SEARCH_CHECK_MS), when set. */
  checkEveryMs?: number;
  /** The tick's interval; 0 for none (under VITEST, as before). */
  tickEveryMs: number;
  /** Whether a key change checks again at once: not in the tests, which would ask the real Brave. Read at each change. */
  recheckOn: () => boolean;
}

export function createFleetSearch(deps: FleetSearchDeps): FleetSearch {
  const { store, secrets, providerFor, trace } = deps;
  const searchWatch = createSearchWatch({
    store,
    braveKey: () => secrets.get(SEARCH_KEY_REF).catch((err) => { if (err instanceof SecretNotFoundError) return undefined; throw err; }),
    providerFor,
    isBusy: deps.isBusy,
    notify: deps.notify,
    log: deps.info,
    spentQuery: () => store.addSearch(SEARCH_CHECKS, 'brave', new Date().toISOString()),
    ...(deps.searchFetch ? { fetchImpl: deps.searchFetch, sleep: async () => {} } : {}),
    ...(deps.checkEveryMs !== undefined ? { checkEveryMs: deps.checkEveryMs } : {}),
  });
  /** A key changed, so what the fleet should use may have. Not in the tests: it asks the real Brave. */
  function recheckSearchSoon(): void {
    if (deps.recheckOn()) void searchWatch.recheck().catch((err) => deps.warn({ err: String(err) }, 'search check failed'));
  }
  const tick = deps.tickEveryMs > 0
    ? setInterval(() => { void searchWatch.tick().catch((err) => deps.warn({ err: String(err) }, 'search check failed')); }, deps.tickEveryMs)
    : undefined;
  tick?.unref();
  const searchView = async (): Promise<SearchView> => ({
    ...searchWatch.state(),
    moving: searchWatch.moving(),
    keySet: await secrets.get(SEARCH_KEY_REF).then(() => true, () => false),
  });
  const searchUsageView = async () => searchUsageReport({
    hours: (from, to) => store.searchHours(from, to),
    state: searchWatch.state(),
    keySet: await secrets.get(SEARCH_KEY_REF).then(() => true, () => false),
    price: readSearchPrice(store),
    nameOf: (id) => store.getAgent(id)?.name,
    now: Date.now(),
  });
  return {
    watch: searchWatch,
    view: searchView,
    async check() {
      await searchWatch.check();
      return searchView();
    },
    usage: searchUsageView,
    async set(change) {
      if (change.price) saveSearchPrice(store, change.price);
      if (change.mode) await searchWatch.setMode(change.mode);
      return change.mode ? searchView() : searchUsageView();
    },
    async agentTest(agent) {
      const res = await providerFor(agent.hostId).exec(agent.runtimeRef, AGENT_SEARCH_TEST_ARGV, { timeoutMs: 120_000 });
      const out = readAgentSearchTest(res.stdout, res.stderr);
      // A test is a real search: counted with Hatchabot's checks, under the provider that answered (HB-0532).
      if (out.ok) {
        const provider = out.provider.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown';
        // Brave on the agent's own key is its own bill, as its other searches
        // are (sourceUsage.ts, attributeBrave): the key its container was built
        // with, else its saved key. It was counted as the fleet key's (HB-0999).
        const applied = store.appliedSearchKey(agent.id);
        const own = provider === 'brave' && (applied ? applied === 'own'
          : (await ownSearchKey(store, secrets, agent.id)) ?? store.listAgentEnv(agent.id).some((e) => e.name === 'BRAVE_API_KEY'));
        store.addSearch(SEARCH_CHECKS, own ? OWN_BRAVE : provider, new Date().toISOString());
      }
      if (!out.ok) {
        trace(agent.id)('search.test_failed', { why: out.why, stderr: (res.stderr || res.stdout).slice(-300) });
        if (out.why === 'quota' || out.why === 'key') searchWatch.nudge();
      }
      return out;
    },
    keyChanged: recheckSearchSoon,
    stop() { if (tick) clearInterval(tick); },
  };
}
