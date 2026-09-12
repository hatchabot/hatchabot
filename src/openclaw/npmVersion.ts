/**
 * OpenClaw ships on npm; its dist-tags are the source of truth for "what stable
 * versions exist". `latest` is the current stable, `extended-stable` a more
 * conservative track. Hatchabot reads these so the app can tell you a newer
 * stable dropped — it never compares against `beta`/`alpha`.
 */
export interface OpenclawDistTags {
  latest?: string;
  extendedStable?: string;
}

export function parseDistTags(raw: unknown): OpenclawDistTags {
  const o = (raw ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return { latest: s(o.latest), extendedStable: s(o['extended-stable']) };
}

/**
 * Fetch OpenClaw's dist-tags from the npm registry. Best-effort: returns `{}` on
 * any failure (network off, timeout, bad JSON) so a runtime-status view degrades
 * to "unknown" rather than breaking.
 */
export async function fetchOpenclawDistTags(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<OpenclawDistTags> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://registry.npmjs.org/-/package/openclaw/dist-tags', {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return {};
    return parseDistTags(await res.json());
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}
