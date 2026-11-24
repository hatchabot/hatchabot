import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { browserSweep } from './browser.js';

/**
 * Each agent's own browser (HB-0808; src/orchestrator/console/browser.ts): the
 * browsers kept in step with the agents that have one switched on, on every
 * machine, by the sweep (`browsersNow`), now for one agent (it started, woke
 * or was rebuilt, or its logins changed) and every minute for all of them.
 */
export interface AgentBrowsers {
  /** Sweep now: every agent's browser, or `only` that agent's. Never rejects (a failure is logged). */
  browsersNow(only?: string): Promise<Awaited<ReturnType<typeof browserSweep>> | undefined>;
  /** End the minute's sweep: at shutdown. */
  stop(): void;
}

/** What the browsers need from the process they run in. Functions only, so a test hands them fakes. */
export interface AgentBrowsersDeps {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** The service log. */
  warn: (detail: Record<string, unknown>, event: string) => void;
  /** How often every browser is swept, in ms; 0 for never (tests). */
  browserSweepEveryMs: number;
}

export function createAgentBrowsers(deps: AgentBrowsersDeps): AgentBrowsers {
  const { store, providerFor, trace } = deps;
  const browsersNow = (only?: string) => browserSweep({
    store,
    hostIds: () => [store.localHostId(), ...store.listRunnerHostIds()].filter((h): h is string => !!h),
    providerFor,
    log: (agentId, e, d) => trace(agentId)(e, d),
  }, only).catch((err) => { deps.warn({ err }, 'browser sweep failed'); return undefined; });
  // Any other number is an interval, as the setting always was (Node takes one below 1 as 1).
  const sweepTimer = deps.browserSweepEveryMs !== 0
    ? setInterval(() => { void browsersNow(); }, deps.browserSweepEveryMs).unref()
    : undefined;
  return {
    browsersNow,
    stop: () => { if (sweepTimer) clearInterval(sweepTimer); },
  };
}
