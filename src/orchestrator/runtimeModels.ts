import type { RuntimeProvider } from '../providers/provider.js';

/**
 * What models an agent's RUNTIME can actually serve — as opposed to what we
 * think it should.
 *
 * Why this exists: the model picker used to offer a hardcoded Anthropic list.
 * `claude-opus-5` was on it, so it became a fleet default — but OpenClaw's
 * claude-cli (Claude Max) runtime has no catalog entry for it. Ordinary
 * messages passed through; COMPACTION, which resolves the model strictly,
 * failed once a conversation filled up ("Unknown model: anthropic/claude-opus-5
 * … registering it there will not make it usable"). Offering a model the
 * runtime can't serve is therefore a real outage, not a cosmetic slip.
 *
 * `openclaw models list --all --json` is the authority, but it lists CONFIGURED
 * models too — including ones Hatchabot itself wrote in — so mere presence
 * proves nothing. The tell is the metadata: a genuinely catalogued model has a
 * human display name ("Claude Opus 4.8"), while a model OpenClaw knows nothing
 * about is echoed back with its raw id as the name and placeholder specs
 * (text-only, 200k). Verified against OpenClaw 2026.7.1.
 */

export interface RuntimeModel {
  /** Provider-qualified, e.g. "anthropic/claude-opus-4-8". */
  key: string;
  /** Bare id as Hatchabot stores it, e.g. "claude-opus-4-8". */
  id: string;
  name: string;
  contextWindow?: number;
  input?: string;
  /** False when the runtime echoed the id back instead of naming it — the
   *  signature of a model it cannot actually serve. */
  catalogued: boolean;
}

/** A stub entry names itself after its own id; a real one has a display name. */
export function isCatalogued(m: { key: string; name?: string }): boolean {
  const id = m.key.includes('/') ? m.key.slice(m.key.indexOf('/') + 1) : m.key;
  const name = (m.name ?? '').trim();
  if (!name) return false;
  return name.toLowerCase() !== id.toLowerCase() && name.toLowerCase() !== m.key.toLowerCase();
}

/** Tolerant parser for `openclaw models list --json`. */
export function parseRuntimeModels(stdout: string): RuntimeModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).models)
      ? (parsed as any).models
      : [];
  return arr
    .filter((m: any) => m && typeof m.key === 'string' && m.key)
    .map((m: any) => ({
      key: m.key,
      id: m.key.includes('/') ? m.key.slice(m.key.indexOf('/') + 1) : m.key,
      name: typeof m.name === 'string' ? m.name : '',
      contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : undefined,
      input: typeof m.input === 'string' ? m.input : undefined,
      catalogued: isCatalogued(m),
    }));
}

/**
 * Ask a live agent what its runtime serves. Returns [] when the agent can't be
 * reached or the CLI is older than `--all` — callers fall back to their static
 * list rather than showing an empty picker.
 */
export async function runtimeModels(
  provider: RuntimeProvider,
  runtimeRef: string,
  providerId: string,
): Promise<RuntimeModel[]> {
  try {
    const res = await provider.exec(runtimeRef, [
      'models', 'list', '--provider', providerId, '--all', '--json',
    ]);
    if (res.code !== 0) return [];
    return parseRuntimeModels(res.stdout);
  } catch {
    return [];
  }
}
