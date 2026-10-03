import type { AIProfile } from '../domain/types.js';

/**
 * The models an agent can be moved between, with their API prices and one
 * line on what each is good for: what the management agent's model steward
 * matches an agent's work against (docs/features.md, "Right-size").
 *
 * Prices are USD per million tokens, read from Anthropic's pricing page
 * (https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-03.
 * Cache writes (5-minute) are 1.25× input; cache reads are `cacheRead` × input
 * (a tenth, except where Anthropic lists less). A guard test keeps these in
 * step with pricing.ts where both price a model.
 *
 * `tier` orders capability (1 smallest). It is a coarse guide, not a
 * benchmark: within a tier the newer model is the better buy.
 */
export interface ModelOption {
  id: string;
  label: string;
  input: number;
  output: number;
  /** A cache read as a share of the input price. */
  cacheRead: number;
  tier: 1 | 2 | 3 | 4;
  note: string;
  /** Retired or superseded: not a model to move an agent TO. */
  legacy?: boolean;
  /** Offered by invitation only. */
  limited?: boolean;
}

const TOOLS_SMALL = 'Fine for short chats and simple lookups; less reliable with many tools, long conversations or multi-step tool chains (more malformed or wrong tool calls).';

export const MODEL_CATALOG: ModelOption[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', input: 10, output: 50, cacheRead: 0.025, tier: 4, note: 'The largest model: long, hard, multi-step work and the most reliable tool use. Rarely worth its price for a routine agent.' },
  { id: 'claude-fable-5', label: 'Fable 5', input: 10, output: 50, cacheRead: 0.1, tier: 4, note: 'Largest-class model; Fable 5.1 costs the same and reads cache for a quarter of the price.' },
  { id: 'claude-mythos-5', label: 'Mythos 5', input: 10, output: 50, cacheRead: 0.1, tier: 4, limited: true, note: 'Invitation only (Project Glasswing). Priced like Fable.' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', input: 4, output: 20, cacheRead: 0.05, tier: 3, note: 'Frontier capability at the lowest Opus price; strong, reliable tool use over long conversations. Cheaper than every older Opus.' },
  { id: 'claude-opus-5', label: 'Opus 5', input: 5, output: 25, cacheRead: 0.1, tier: 3, note: 'Strong reasoning and tool use; Opus 5.5 is cheaper.' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', input: 5, output: 25, cacheRead: 0.1, tier: 3, note: 'Strong reasoning and tool use; Opus 5.5 is cheaper and newer.' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', input: 5, output: 25, cacheRead: 0.1, tier: 3, legacy: true, note: 'Older Opus; Opus 5.5 is cheaper and stronger.' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', input: 5, output: 25, cacheRead: 0.1, tier: 3, legacy: true, note: 'Older Opus; Opus 5.5 is cheaper and stronger.' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5', input: 5, output: 25, cacheRead: 0.1, tier: 3, legacy: true, note: 'Older Opus; Opus 5.5 is cheaper and stronger.' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', input: 2, output: 10, cacheRead: 0.1, tier: 2, note: 'The default for most agent work: good reasoning and reliable tool use at half the Opus price.' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', input: 2, output: 10, cacheRead: 0.1, tier: 2, note: 'Good reasoning and reliable tool use; Sonnet 5.5 costs the same.' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', input: 3, output: 15, cacheRead: 0.1, tier: 2, legacy: true, note: 'Older Sonnet; costs more than Sonnet 5 and 5.5.' },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', input: 3, output: 15, cacheRead: 0.1, tier: 2, legacy: true, note: 'Older Sonnet; costs more than Sonnet 5 and 5.5.' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', input: 1, output: 5, cacheRead: 0.1, tier: 1, note: `The smallest and cheapest. ${TOOLS_SMALL}` },
];

const BY_ID = new Map(MODEL_CATALOG.map((m) => [m.id, m]));

/** "anthropic/claude-haiku-4-5-20251001" → "claude-haiku-4-5": the catalog's key. */
export function modelKey(model: string): string {
  return model.replace(/^[a-z-]+\//, '').replace(/-\d{8}$/, '');
}

export function modelOption(model: string): ModelOption | undefined {
  return BY_ID.get(modelKey(model));
}

export interface TokenMix { input: number; output: number; cacheRead: number; cacheWrite: number }

/** The API price of a token mix on a model, in USD; undefined when the model has no known price. */
export function priceMix(model: string, t: TokenMix): number | undefined {
  const m = modelOption(model);
  if (!m) return undefined;
  return ((t.input + 1.25 * t.cacheWrite + m.cacheRead * t.cacheRead) * m.input + t.output * m.output) / 1e6;
}

/** The models a source offers, as its owner listed them (its default first), once each. */
export function sourceModels(p: Pick<AIProfile, 'model' | 'models'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [p.model, ...(p.models ?? [])]) {
    if (!m) continue;
    const k = modelKey(m);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}

export interface SourceOptions {
  source: string;
  kind: 'subscription' | 'api_key';
  vendor: string;
  /** subscription: the plan pays, so prices are what the same use would cost by API (and how much of the plan it takes). */
  billing: 'plan' | 'api' | 'local';
  models: Array<{ id: string; label?: string; inUSDPerM?: number; outUSDPerM?: number; cacheReadUSDPerM?: number; tier?: number; note: string; legacy?: boolean }>;
}

/**
 * Per source the caller may use: its models with prices and a note. Only
 * what the source lists (the agent sheet's menu); set_model still checks the
 * live list when a change is proposed.
 */
export function modelOptionsFor(profiles: AIProfile[]): { sources: SourceOptions[]; notes: string[] } {
  const sources = profiles.map((p): SourceOptions => {
    const billing = p.vendor === 'local' ? 'local' : p.kind === 'subscription' ? 'plan' : 'api';
    const models = sourceModels(p).map((id): SourceOptions['models'][number] => {
      const o = modelOption(id);
      if (!o) {
        return { id, note: p.vendor === 'local' ? 'Runs on this machine: no per-token price; slower, and weaker at tool use than Claude.' : 'No price known to Hatchabot.' };
      }
      return {
        id, label: o.label, inUSDPerM: o.input, outUSDPerM: o.output, cacheReadUSDPerM: Math.round(o.input * o.cacheRead * 1000) / 1000,
        tier: o.tier, note: o.note, ...(o.legacy ? { legacy: true } : {}),
      };
    }).sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0) || (b.inUSDPerM ?? 0) - (a.inUSDPerM ?? 0));
    return { source: p.name, kind: p.kind, vendor: p.vendor, billing, models };
  });
  return {
    sources,
    notes: [
      'Prices: USD per million tokens (Anthropic, read 2026-10-03). Cache writes cost 1.25x input.',
      'Larger models are more reliable at tool use: an agent that calls many tools per turn, or carries a long conversation, is the last to move to a smaller model.',
      'On a Claude plan nothing is billed per token: a cheaper model leaves more of the plan\'s limits for the other agents.',
    ],
  };
}
