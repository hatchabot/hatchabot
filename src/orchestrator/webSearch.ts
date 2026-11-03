/**
 * Which web search the fleet uses, whether it works, and moving agents off a
 * provider that has run out (HB-0390, HB-0391).
 *
 * OpenClaw's own fallback never reaches DuckDuckGo: past the first provider it
 * tries only those holding a key (`resolveWebSearchCandidates`, 2026.9.8), and
 * its auto-detection skips a keyless one altogether, so an agent with no key
 * had no search unless told by name (HB-0392). So this file decides, and an
 * agent is told `tools.web.search.provider`, which OpenClaw reloads live.
 *
 * Only two states are ever written: `duckduckgo`, or no setting (a key in the
 * container then wins by auto-detection, as it always has). Any other provider
 * set by hand on an agent is left alone. An agent leaves DuckDuckGo for Brave
 * only when its container holds the key that was checked: each holds the key of
 * its last build, and a replaced one's old key may be the empty one.
 */
import { createHash } from 'node:crypto';
import type { Agent } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';

export const WEB_SEARCH_PREF_OWNER = '__machine__';
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search?count=1&q=weather%20forecast';
const DDG_URL = 'https://html.duckduckgo.com/html/?q=weather%20forecast';
/** Left in the quota when agents move off Brave: enough for the checks that see it come back. */
const RESERVE = 10;
const HOUR = 3_600_000;
export const DEFAULT_CHECK_MS = 6 * HOUR;
/** A check asked for by a failure (not by a person) waits this long after the last one. */
const NUDGE_GAP_MS = 15 * 60_000;

export type SearchProviderId = 'brave' | 'duckduckgo';
export type ProbeStatus = 'ok' | 'low' | 'exhausted' | 'rejected' | 'busy' | 'unreachable' | 'blocked';
export interface Probe {
  status: ProbeStatus;
  /** Plain words for the owner; never the key or a raw response. */
  detail: string;
  remaining?: number;
  limit?: number;
  /** When the quota comes back, if the provider said. */
  resetsAt?: string;
}
export interface WebSearchState {
  /** `auto`: Brave while it has quota, then DuckDuckGo, and back. `duckduckgo`: always DuckDuckGo. */
  mode: 'auto' | 'duckduckgo';
  active: SearchProviderId;
  /** Why the fleet is on what it is on, in the owner's words. */
  why?: string;
  since?: string;
  checkedAt?: string;
  nextCheckAt?: string;
  brave?: Probe;
  duckduckgo?: Probe;
  /** The last pass over the agents. `rebuild`: they stay on DuckDuckGo until a rebuild gives them the current key. */
  applied?: { at: string; changed: number; failed: string[]; rebuild?: number };
  /** Which key the last check was about, so a key the owner changed is not announced as a quota returning. */
  keyMark?: string;
}

/**
 * Environment variables that give an agent a search of its own, by provider
 * (OpenClaw 2026.9.8's manifests). Set on the agent, the fleet's state does not
 * move it. Read from its own settings, not its container: the fleet's Gemini key
 * is in every container too.
 */
const OWN_SEARCH_KEYS = new Set([
  'BRAVE_API_KEY', 'EXA_API_KEY', 'FIRECRAWL_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'KIMI_API_KEY',
  'MINIMAX_API_KEY', 'MOONSHOT_API_KEY', 'PERPLEXITY_API_KEY', 'TAVILY_API_KEY', 'XAI_API_KEY',
]);
export function ownSearchKeys(env: ReadonlyArray<{ name: string }>): string[] {
  return env.map((e) => e.name).filter((n) => OWN_SEARCH_KEYS.has(n));
}
/** Names the key, not the secret: a hash of it is what the script compares in the container. */
const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');

export function readWebSearch(store: Pick<Store, 'getOwnerPref'>): WebSearchState {
  const raw = store.getOwnerPref(WEB_SEARCH_PREF_OWNER, 'webSearch');
  if (raw) {
    try {
      const s = JSON.parse(raw) as Partial<WebSearchState>;
      if (s.active === 'brave' || s.active === 'duckduckgo') return { mode: s.mode === 'duckduckgo' ? 'duckduckgo' : 'auto', ...s, active: s.active };
    } catch { /* a damaged row is a fresh start */ }
  }
  return { mode: 'auto', active: 'brave' };
}

function saveWebSearch(store: Pick<Store, 'setOwnerPref'>, s: WebSearchState): void {
  store.setOwnerPref(WEB_SEARCH_PREF_OWNER, 'webSearch', JSON.stringify(s));
}

/**
 * The provider to name for an agent at its build, or undefined to name none.
 * An agent's own key is its own quota, so the fleet's state does not move it.
 */
export function searchProviderFor(a: { hasFleetKey: boolean; hasOwnKey: boolean; state: Pick<WebSearchState, 'active'> }): 'duckduckgo' | undefined {
  if (a.hasOwnKey) return undefined;
  return a.hasFleetKey && a.state.active === 'brave' ? undefined : 'duckduckgo';
}

/** The last number of a list header: Brave sends the per-second window, then the monthly one. */
function lastNumber(h: string | null): number | undefined {
  const n = Number(h?.split(',').pop()?.trim());
  return h && Number.isFinite(n) ? n : undefined;
}

/**
 * Asks Brave once, which spends one query. A 429 is either its per-second limit
 * or an empty quota, and they are not reliably told apart, so it asks again
 * two seconds on: only an empty quota is still refusing. A refused request
 * spends nothing.
 */
export async function probeBrave(key: string, deps: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number } = {}): Promise<Probe> {
  const f = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const ask = () => f(BRAVE_URL, { headers: { accept: 'application/json', 'x-subscription-token': key }, signal: AbortSignal.timeout(15_000) });
  let r: Response;
  try {
    r = await ask();
    if (r.status === 429) { await sleep(2000); r = await ask(); }
  } catch {
    return { status: 'unreachable', detail: "Brave could not be reached from this machine, so this says nothing about the key." };
  }
  const remaining = lastNumber(r.headers.get('x-ratelimit-remaining'));
  const limit = lastNumber(r.headers.get('x-ratelimit-limit'));
  const resetIn = lastNumber(r.headers.get('x-ratelimit-reset'));
  const quota = {
    ...(remaining !== undefined ? { remaining } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(resetIn !== undefined ? { resetsAt: new Date(now() + resetIn * 1000).toISOString() } : {}),
  };
  // Quota left and still refusing: its per-second limit, whatever was asked at once.
  if (r.status === 429 && remaining !== undefined && remaining > RESERVE) return { status: 'busy', detail: 'Brave is limiting requests for now, with quota left.', ...quota };
  if (r.status === 429 || r.status === 402) return { status: 'exhausted', detail: 'The Brave key has run out of quota.', ...quota };
  if (r.status === 401 || r.status === 403 || r.status === 422) return { status: 'rejected', detail: `Brave refused the key (${r.status}). It may be wrong, or its plan ended.` };
  if (!r.ok) return { status: 'busy', detail: `Brave answered ${r.status}. That is usually its own trouble and passes.` };
  if (remaining !== undefined && remaining <= RESERVE) return { status: 'low', detail: `The Brave key has ${remaining} queries left.`, ...quota };
  return { status: 'ok', detail: remaining !== undefined ? `Brave works, with ${remaining}${limit !== undefined ? ` of ${limit}` : ''} queries left.` : 'Brave works.', ...quota };
}

/** Asks DuckDuckGo once. It has no key or quota, but it can turn a machine's address away. */
export async function probeDuckDuckGo(deps: { fetchImpl?: typeof fetch } = {}): Promise<Probe> {
  const f = deps.fetchImpl ?? fetch;
  try {
    const r = await f(DDG_URL, { headers: { 'user-agent': 'Mozilla/5.0 (Hatchabot)' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { status: 'blocked', detail: `DuckDuckGo answered ${r.status}.` };
    // A challenge page answers 200 or 202 with no results in it.
    if (!(await r.text()).includes('result__a')) return { status: 'blocked', detail: 'DuckDuckGo answered with no results: it may be turning this address away for now.' };
    return { status: 'ok', detail: 'DuckDuckGo works.' };
  } catch {
    return { status: 'unreachable', detail: 'DuckDuckGo could not be reached from this machine.' };
  }
}

/**
 * The script that puts one running agent right; prints what it did. `own`: the
 * agent's own search keys, which it uses once they reach its container.
 * `fleetKey`: the hash of the fleet's key. `fleetOn`: the fleet is on Brave, so
 * the agent may use it, if that key is the one it holds. Everything put in is a
 * fixed name or hex.
 */
export function applySearchScript(a: { own?: string[]; fleetKey?: string; fleetOn?: boolean }): string {
  const own = (a.own ?? []).filter((n) => OWN_SEARCH_KEYS.has(n));
  const fleet = (a.fleetKey ?? '').replace(/[^a-f0-9]/g, '');
  const others = own.filter((n) => n !== 'BRAVE_API_KEY').map((n) => `$${n}`).join('');
  // A Brave key equal to the fleet's is the fleet's, still there from its last build: not its own yet.
  const ownBrave = own.includes('BRAVE_API_KEY') ? `{ [ -n "$BRAVE_API_KEY" ] && [ "$have" != "${fleet}" ]; }` : '';
  const ownHere = [others ? `[ -n "${others}" ]` : '', ownBrave].filter(Boolean).join(' || ');
  const fleetCase = a.fleetOn && fleet
    ? `if [ "$have" = "${fleet}" ]; then want=""; else note=" needs-rebuild"; fi`
    : own.length ? `note=" needs-rebuild"` : ':';
  const usesBrave = ownHere ? `if ${ownHere}; then want=""; else ${fleetCase}; fi` : fleetCase;
  return [
    // The hash first: it is never empty, and the provider may be.
    `set -- $(node -e 'const c=(()=>{try{return JSON.parse(require("fs").readFileSync("/home/node/.openclaw/openclaw.json","utf8"))}catch{return {}}})();process.stdout.write(require("crypto").createHash("sha256").update(process.env.BRAVE_API_KEY||"").digest("hex")+" "+String((c.tools&&c.tools.web&&c.tools.web.search&&c.tools.web.search.provider)||""))')`,
    `have="$1"; cur="\${2:-}"`,
    // Set by hand: not ours to move.
    `case "$cur" in ""|duckduckgo) ;; *) echo custom; exit 0 ;; esac`,
    `want=duckduckgo; note=""`,
    usesBrave,
    `[ "$cur" = "$want" ] && { echo "same$note"; exit 0; }`,
    `if [ -n "$want" ]; then openclaw config set tools.web.search.provider "$want" >/dev/null; else openclaw config unset tools.web.search.provider >/dev/null; fi && echo "changed$note"`,
  ].join('\n');
}

export interface SearchWatchDeps {
  store: Pick<Store, 'getOwnerPref' | 'setOwnerPref' | 'listAllActiveAgents' | 'listAgentEnv'>;
  /** The fleet's Brave key, undefined if none is set. Rejects when the key could not be read: that is not "none". */
  braveKey(): Promise<string | undefined>;
  providerFor(hostId: string): RuntimeProvider;
  isBusy?(agentId: string): boolean;
  /** Tell the machine's owner. Only when the fleet moved by itself, or nothing works. */
  notify?(headline: string, detail: string): void;
  log?(event: string, detail: Record<string, unknown>): void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  checkEveryMs?: number;
}

export interface SearchWatch {
  /** Probes now and decides. One at a time: a second caller shares the first's answer. Agents move after, in the background. */
  check(): Promise<WebSearchState>;
  /** A setting just changed: a check that starts after this, not one already under way that read the old one. */
  recheck(): Promise<WebSearchState>;
  /** A search just failed somewhere: check soon, unless one was just made. */
  nudge(): void;
  /** The timer's tick: a check if one is due, then any agent not yet right. */
  tick(): Promise<void>;
  setMode(mode: WebSearchState['mode']): Promise<WebSearchState>;
  state(): WebSearchState;
  /** Whether agents are being gone through right now. */
  moving(): boolean;
  /** Resolves when no pass over the agents is running. */
  idle(): Promise<void>;
}

export function createSearchWatch(deps: SearchWatchDeps): SearchWatch {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const every = deps.checkEveryMs ?? DEFAULT_CHECK_MS;
  /** Agents known to be right for what is named in the entry. A stopped one leaves, so its next start is looked at. */
  const settled = new Set<string>();
  let running: Promise<WebSearchState> | undefined;
  let passing: Promise<void> | undefined;
  let passAgain = false;
  let lastCheck = 0;

  const iso = (t: number) => new Date(t).toISOString();

  /**
   * When to ask again. An empty quota refuses for free, so it is asked on the
   * usual round as well as at its reset: a wrong "empty" must not park the fleet
   * for a month. Near the end each answer spends one of the last queries.
   */
  function nextCheck(p: Probe): number {
    const t = now();
    const reset = p.resetsAt ? Date.parse(p.resetsAt) + 60_000 : NaN;
    const untilReset = (most: number) => (Number.isFinite(reset) && reset > t ? Math.min(reset, t + most) : t + most);
    if (p.status === 'exhausted') return untilReset(every);
    if (p.status === 'low') return untilReset(24 * HOUR);
    if (p.status === 'ok' && p.remaining !== undefined && p.limit && p.remaining / p.limit < 0.1) return t + Math.min(every, HOUR);
    if (p.status === 'busy' || p.status === 'unreachable') return t + Math.min(every, HOUR);
    return t + every;
  }

  /** One pass. Reads the state at each agent, so a change made during the pass reaches the rest of it. */
  async function goThroughAgents(): Promise<void> {
    const key = await deps.braveKey();
    const fleetKey = key ? keyHash(key) : undefined;
    const failed: string[] = [];
    let changed = 0;
    let rebuild = 0;
    let looked = false;
    for (const a of deps.store.listAllActiveAgents() as Agent[]) {
      if (a.ops || !a.runtimeRef || a.migratedTo) continue;
      const s = readWebSearch(deps.store);
      const mark = `${a.id}:${s.active}:${fleetKey ?? ''}`;
      if (a.state !== 'RUNNING') { settled.delete(mark); continue; }
      if (settled.has(mark) || deps.isBusy?.(a.id)) continue;
      looked = true;
      const own = ownSearchKeys(deps.store.listAgentEnv(a.id));
      try {
        const r = await deps.providerFor(a.hostId).execShell(
          a.runtimeRef,
          applySearchScript({ own, ...(fleetKey ? { fleetKey } : {}), fleetOn: s.active === 'brave' }),
          { timeoutMs: 60_000, secret: true },
        );
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).slice(0, 200));
        if (r.stdout.includes('changed')) changed++;
        // Not settled: only looking again sees a rebuild happen, and the count stays true of the fleet.
        if (r.stdout.includes('needs-rebuild')) rebuild++;
        else settled.add(mark);
      } catch (err) {
        failed.push(a.name);
        log('search.apply_failed', { agentId: a.id, error: String((err as Error)?.message ?? err).slice(0, 200) });
      }
    }
    const was = readWebSearch(deps.store);
    // Nothing needed a look: what the last pass named is over, whoever it was.
    if (!looked && !was.applied?.failed.length) return;
    saveWebSearch(deps.store, { ...was, applied: { at: iso(now()), changed, failed, ...(rebuild ? { rebuild } : {}) } });
    if (changed || failed.length) log('search.applied', { active: was.active, changed, failed: failed.length, rebuild });
  }

  /** One pass at a time; asked for during one, another follows it, so nothing it read is left standing. */
  function pass(): Promise<void> {
    if (passing) { passAgain = true; return passing; }
    passing = (async () => {
      try {
        do { passAgain = false; await goThroughAgents(); } while (passAgain);
      } finally { passing = undefined; }
    })();
    return passing;
  }

  const moved = (s: WebSearchState, active: SearchProviderId, why: string): WebSearchState =>
    s.active === active ? { ...s, why } : { ...s, active, why, since: iso(now()) };

  async function runCheck(): Promise<WebSearchState> {
    lastCheck = now();
    const key = await deps.braveKey();
    const duckduckgo = await probeDuckDuckGo(deps);
    const brave = key ? await probeBrave(key, deps) : undefined;
    // After the probes, and no await until it is saved: a mode set while they ran is the one that counts.
    const before = readWebSearch(deps.store);
    const keyMark = key ? keyHash(key).slice(0, 16) : undefined;
    let s: WebSearchState = { ...before, checkedAt: iso(now()), duckduckgo, nextCheckAt: iso(brave ? nextCheck(brave) : now() + every) };
    if (keyMark) s.keyMark = keyMark; else delete s.keyMark;
    if (!brave) {
      delete s.brave;
      s = moved(s, 'duckduckgo', 'No Brave key is set.');
    } else {
      s.brave = brave;
      if (s.mode === 'duckduckgo') s = moved(s, 'duckduckgo', 'You chose DuckDuckGo.');
      else if (brave.status === 'ok') s = moved(s, 'brave', 'Brave has quota.');
      else if (brave.status === 'exhausted' || brave.status === 'low' || brave.status === 'rejected') s = moved(s, 'duckduckgo', brave.detail);
      // busy, unreachable: says nothing about the key, so nothing moves.
    }
    saveWebSearch(deps.store, s);
    // What an agent was settled for may have been true before: on the way back it is not.
    if (s.active !== before.active || s.keyMark !== before.keyMark) settled.clear();
    if (s.active !== before.active) {
      log('search.switched', { from: before.active, to: s.active, brave: s.brave?.status });
      // Only what happened by itself: the owner knows they saved a key or changed the setting.
      const sameKey = before.keyMark === keyMark;
      if (s.active === 'duckduckgo' && key && s.mode === 'auto') {
        deps.notify?.('Web search moved to DuckDuckGo', `${s.why} Agents are moving now, with no rebuild${s.brave?.resetsAt ? `, and go back to Brave when its quota returns (${s.brave.resetsAt.slice(0, 10)}).` : ', and go back when Brave answers again.'}`);
      } else if (s.active === 'brave' && sameKey && before.mode === 'auto' && before.brave && ['exhausted', 'low', 'rejected'].includes(before.brave.status)) {
        deps.notify?.('Web search is back on Brave', 'Its quota returned, so agents are moving back, with no rebuild.');
      }
    }
    // Nothing left to move to: worth saying once, when it starts.
    const stuck = (x: WebSearchState) => x.active === 'duckduckgo' && !!x.duckduckgo && x.duckduckgo.status !== 'ok';
    if (stuck(s) && !stuck(before)) deps.notify?.('Web search may not be working', `Agents are on DuckDuckGo, and from this machine: ${duckduckgo.detail}`);
    // A move takes minutes across a fleet; nobody waits for it, and a check can run beside it.
    void pass().catch((err) => log('search.check_failed', { error: String(err) }));
    return s;
  }

  function check(): Promise<WebSearchState> {
    running ??= runCheck().finally(() => { running = undefined; });
    return running;
  }
  function recheck(): Promise<WebSearchState> {
    return running ? running.catch(() => undefined).then(() => check()) : check();
  }

  return {
    check,
    recheck,
    state: () => readWebSearch(deps.store),
    moving: () => !!passing,
    async idle() { while (passing) await passing.catch(() => {}); },
    nudge() {
      if (running || now() - lastCheck < NUDGE_GAP_MS) return;
      void check().catch((err) => log('search.check_failed', { error: String(err) }));
    },
    async tick() {
      const next = readWebSearch(deps.store).nextCheckAt;
      if (!next || now() >= Date.parse(next)) await check();
      else await pass();
    },
    async setMode(mode) {
      saveWebSearch(deps.store, { ...readWebSearch(deps.store), mode });
      return recheck();
    },
  };
}

export type AgentSearchTest =
  | { ok: true; provider: string; results: number; tookMs?: number; detail: string }
  | { ok: false; why: 'quota' | 'key' | 'no-provider' | 'network' | 'unknown'; provider?: string; detail: string };

/** What to run in an agent: a real search, through the agent's own settings and keys. It spends one query. */
export const AGENT_SEARCH_TEST_ARGV = ['infer', 'web', 'search', '--query', 'weather forecast', '--limit', '1', '--json'];

const PROVIDER_NAMES: Record<string, string> = { brave: 'Brave', duckduckgo: 'DuckDuckGo', gemini: 'Gemini' };
const named = (id: string) => PROVIDER_NAMES[id] ?? id;

/** The test's output in plain words. Its text can quote a provider, so no raw part of it reaches the page. */
export function readAgentSearchTest(stdout: string, stderr: string): AgentSearchTest {
  const start = stdout.indexOf('{');
  let j: { ok?: boolean; provider?: string; error?: { message?: string }; outputs?: Array<{ result?: { results?: unknown[]; count?: number; tookMs?: number } }> } | undefined;
  if (start >= 0) { try { j = JSON.parse(stdout.slice(start)); } catch { /* the words below still say why */ } }
  if (j?.ok === true) {
    const result = j.outputs?.[0]?.result;
    const results = result?.count ?? result?.results?.length ?? 0;
    const provider = j.provider ?? 'unknown';
    return {
      ok: true, provider, results, ...(result?.tookMs !== undefined ? { tookMs: result.tookMs } : {}),
      detail: results ? `Search works: ${named(provider)} answered.` : `${named(provider)} answered, but with no results for the test search.`,
    };
  }
  const text = `${j?.error?.message ?? ''}\n${stderr}\n${start < 0 ? stdout : ''}`;
  const provider = /\b(brave|duckduckgo|gemini)\b/i.exec(text)?.[1]?.toLowerCase();
  if (/no provider is available|is disabled/i.test(text)) return { ok: false, why: 'no-provider', detail: 'This agent has no search provider it can use. Rebuild it to set one.' };
  if (/\b(402|429)\b|quota|usage.?limit|rate.?limit|exhausted|credit/i.test(text)) return { ok: false, why: 'quota', ...(provider ? { provider } : {}), detail: `${provider ? named(provider) : 'The search provider'} refused: its quota or rate limit is used up.` };
  if (/\b(401|403|422)\b|credential|api.?key|unauthori/i.test(text)) return { ok: false, why: 'key', ...(provider ? { provider } : {}), detail: `${provider ? named(provider) : 'The search provider'} refused this agent's key.` };
  if (/EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|timed? ?out/i.test(text)) return { ok: false, why: 'network', ...(provider ? { provider } : {}), detail: "The search provider could not be reached from this agent's machine." };
  return { ok: false, why: 'unknown', ...(provider ? { provider } : {}), detail: 'The search failed for a reason this test does not recognise. The service log has it.' };
}
