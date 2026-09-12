import type { RuntimeProvider } from '../providers/provider.js';

/**
 * Per-agent token usage, read from the agent's own OpenClaw session store via
 * `sessions list --json` (the same source as "last active"). Each session
 * carries a cumulative `totalTokens`; we sum across sessions and break down by
 * model. This is an accurate USAGE signal — not a cost figure: the counter is
 * combined input+output with no cumulative split, and subscription/local agents
 * have no marginal dollar cost at all. The app renders the billing context
 * (included / local / API-key price) from the agent's AI profile.
 */
export interface AgentUsage {
  totalTokens: number;
  sessions: number;
  lastActive?: string;
  byModel: Array<{ model: string; tokens: number; sessions: number }>;
  /** Active span in ms: earliest session start → latest activity. */
  spanMs?: number;
  /** Lifetime average tokens/hour (totalTokens ÷ span). Undefined when the
   *  span is too short to be meaningful (< 10 min) — a rate over a few seconds
   *  is noise, not signal. */
  tokensPerHour?: number;
}

const EMPTY: AgentUsage = { totalTokens: 0, sessions: 0, byModel: [] };
const MIN_SPAN_MS = 10 * 60_000; // below this, a rate is noise

export async function agentUsage(
  provider: RuntimeProvider,
  runtimeRef: string,
  slug: string,
): Promise<AgentUsage> {
  const res = await provider.exec(runtimeRef, ['sessions', 'list', '--agent', slug, '--json']);
  if (res.code !== 0) return EMPTY;
  let sessions: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(res.stdout).sessions;
    sessions = Array.isArray(parsed) ? parsed : [];
  } catch {
    return EMPTY;
  }

  const byModel = new Map<string, { tokens: number; sessions: number }>();
  let totalTokens = 0;
  let lastAt = 0;
  let firstAt = Infinity;
  for (const s of sessions) {
    const t = typeof s.totalTokens === 'number' ? s.totalTokens : 0;
    totalTokens += t;
    if (typeof s.updatedAt === 'number' && s.updatedAt > lastAt) lastAt = s.updatedAt;
    // Span start = earliest session start we can see (fall back to updatedAt).
    const start = typeof s.sessionStartedAt === 'number' ? s.sessionStartedAt
      : typeof s.updatedAt === 'number' ? s.updatedAt : undefined;
    if (start !== undefined && start < firstAt) firstAt = start;
    const model = typeof s.model === 'string' ? s.model : '(unknown)';
    const cur = byModel.get(model) ?? { tokens: 0, sessions: 0 };
    cur.tokens += t;
    cur.sessions += 1;
    byModel.set(model, cur);
  }

  const spanMs = firstAt !== Infinity && lastAt > firstAt ? lastAt - firstAt : undefined;
  const tokensPerHour = spanMs && spanMs >= MIN_SPAN_MS ? Math.round(totalTokens / (spanMs / 3_600_000)) : undefined;

  return {
    totalTokens,
    sessions: sessions.length,
    lastActive: lastAt > 0 ? new Date(lastAt).toISOString() : undefined,
    byModel: [...byModel.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.tokens - a.tokens),
    spanMs,
    tokensPerHour,
  };
}
