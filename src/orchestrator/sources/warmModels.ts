/**
 * Which local models are resident right now, per model server: the agent
 * list's `modelWarm` (lifecycle/agentList.ts). A cold model means the next
 * message stalls ~10s while tens of GB load — worth showing rather than
 * letting the owner wonder whether the agent is broken.
 *
 * Kept per base address (`warmCache`, a cache): two local sources point at
 * different model servers, so a single global cache reported the FIRST
 * server's warm set for the second agent's card for up to 15s. An answer is
 * kept for 15 seconds from when it came, and the question under way is kept
 * too: the list builds every tile at once, and each asked the same server
 * before any answer had come, one `/api/ps` per agent on every refresh
 * (HB-1102). Never rejects: a server that does not answer has nothing warm.
 */
export const WARM_FOR_MS = 15_000;

/**
 * Whether the names a local model server gives (its model list, or `/api/ps`)
 * hold `model`, as Ollama reads a name: one with no tag is its `:latest`
 * (listed `llama3:latest`, served for `llama3`); another tag is another model.
 * Read exactly, a source naming none was refused (HB-1339) and its tile always
 * read cold.
 */
export function localModelListed(names: readonly string[], model: string): boolean {
  return names.includes(model) || (!/:[^/]*$/.test(model) && names.includes(`${model}:latest`));
}

export interface WarmModelsDeps {
  /** The request (tests hand a fake). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** The clock (tests move it). */
  now?: () => number;
}

export function createWarmLocalModels(deps: WarmModelsDeps = {}): (baseUrl: string) => Promise<string[]> {
  const ask = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const now = deps.now ?? Date.now;
  /** `at`: when its answer came; absent while it is being asked. */
  const warmCache = new Map<string, { at?: number; models: Promise<string[]> }>();
  const read = async (baseUrl: string): Promise<string[]> => {
    try {
      const root = baseUrl.replace(/\/v1\/?$/, '');
      const res = await ask(`${root}/api/ps`, { signal: AbortSignal.timeout(2000) });
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    } catch {
      return [];
    }
  };
  return (baseUrl) => {
    const hit = warmCache.get(baseUrl);
    if (hit && (hit.at === undefined || now() - hit.at < WARM_FOR_MS)) return hit.models;
    const entry: { at?: number; models: Promise<string[]> } = { models: Promise.resolve([]) };
    entry.models = read(baseUrl).then((models) => { entry.at = now(); return models; });
    warmCache.set(baseUrl, entry);
    return entry.models;
  };
}
