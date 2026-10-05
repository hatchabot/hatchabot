import type { Store } from '../store/store.js';
import type { Agent } from '../domain/types.js';

/**
 * "Token use went up and I don't know where it's from" (Chris, 2026-09-28).
 *
 * After each usage pass, every agent's last 24 hours is compared with its own
 * usual day: the average of the seven days before, counting only days it
 * existed and was being measured (an average, not a median, so an agent busy
 * two days a week is not news on those days). Far above that, and big enough to matter, the owner is told
 * once — which agent, how much, how much more than usual. An agent always
 * this busy is its normal and says nothing; a new agent with no usual day yet
 * is judged against a fixed size instead.
 */

const DAY = 86_400_000;

export interface UsageAlertRules {
  /** A day at least this many times the usual one (default 3). */
  ratio: number;
  /** ...and at least this many tokens (default 20M), so a quiet agent's 5K → 50K says nothing. */
  minTokens: number;
  /** An agent with fewer than 3 measured days: warn at this many in 24 hours (default 100M). */
  newAgentTokens: number;
}

export function usageAlertRules(env: NodeJS.ProcessEnv = process.env): UsageAlertRules {
  const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d; };
  return {
    ratio: num(env.HATCHABOT_USAGE_ALERT_RATIO, 3),
    minTokens: num(env.HATCHABOT_USAGE_ALERT_MIN_TOKENS, 20_000_000),
    newAgentTokens: num(env.HATCHABOT_USAGE_ALERT_NEW_TOKENS, 100_000_000),
  };
}

export interface UsageSpike {
  agent: Agent;
  /** Tokens in the last 24 hours. */
  tokens: number;
  /** Its usual day (average of the measured days before). */
  usual: number;
  /** False when it has fewer than 3 measured days: judged on size alone. */
  hasUsual: boolean;
  /** The busiest hour of the last 24, ISO, and its tokens: where to look. */
  peakHour?: { at: string; tokens: number };
}


/** Agents whose last 24 hours are far above their usual day. Pure over the store. */
export function findUsageSpikes(store: Store, agents: Agent[], rules: UsageAlertRules, now = Date.now()): UsageSpike[] {
  const out: UsageSpike[] = [];
  const dayStart = now - DAY;
  // Measuring began with the oldest reading anywhere (the first real reading
  // wrote 8 days back, but only from an agent's first call in them).
  const measuringSince = Date.parse(store.firstTokenSample() ?? '');
  if (!Number.isFinite(measuringSince)) return out;
  for (const a of agents) {
    if (!store.firstTokenSample(a.id)) continue;
    const deltas = store.tokenDeltas(new Set([a.id]), new Date(now - 8 * DAY).toISOString());
    let tokens = 0;
    const days = new Array<number>(7).fill(0);
    const hours = new Map<string, number>();
    for (const d of deltas) {
      const t = Date.parse(d.at);
      if (t > dayStart) {
        tokens += d.delta;
        const h = d.at.slice(0, 13);
        hours.set(h, (hours.get(h) ?? 0) + d.delta);
      } else {
        const k = Math.floor((dayStart - t) / DAY);
        if (k >= 0 && k < 7) days[k]! += d.delta;
      }
    }
    if (tokens < rules.minTokens) continue;
    // Only days wholly after it existed and was measured say what is usual.
    const since = Math.max(measuringSince, Date.parse(a.createdAt) || 0);
    const measured = days.filter((_, k) => dayStart - (k + 1) * DAY >= since);
    const hasUsual = measured.length >= 3;
    const usual = hasUsual ? measured.reduce((x, y) => x + y, 0) / measured.length : 0;
    const spike = hasUsual ? tokens >= rules.ratio * Math.max(usual, 1) : tokens >= rules.newAgentTokens;
    if (!spike) continue;
    let peakHour: UsageSpike['peakHour'];
    for (const [h, t] of hours) if (!peakHour || t > peakHour.tokens) peakHour = { at: `${h}:00:00.000Z`, tokens: t };
    out.push({ agent: a, tokens, usual, hasUsual, ...(peakHour ? { peakHour } : {}) });
  }
  return out.sort((x, y) => y.tokens - x.tokens);
}

const fmt = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n)));

/** The warning, as the owner reads it in Telegram. */
export function usageSpikeText(s: UsageSpike): string {
  const than = !s.hasUsual ? 'a lot for an agent this new'
    : s.usual < 1e6 ? `after a quiet week (its usual day: ${fmt(s.usual)})`
    : `about ${Math.round(s.tokens / s.usual)}× its usual day (${fmt(s.usual)})`;
  const peak = s.peakHour ? ` The busiest hour began ${new Date(s.peakHour.at).toISOString().slice(11, 16)} UTC (${fmt(s.peakHour.tokens)}).` : '';
  return `⚠️ Hatchabot: "${s.agent.name}" used ${fmt(s.tokens)} tokens in the last 24 hours — ${than}.${peak} Usage shows it by the hour; a scheduled task or a long conversation is the usual cause.`;
}

export interface UsageAlertDeps {
  store: Store;
  /** Deliver the warning to the owner; resolves true if it reached them. */
  tell(ownerId: string, agent: Agent, text: string): Promise<boolean>;
  rules?: UsageAlertRules;
  log?(event: string, detail: Record<string, unknown>): void;
}

/** One check over every active agent: warn about each new spike, once a day per agent. */
export async function runUsageAlerts(deps: UsageAlertDeps, now = Date.now()): Promise<UsageSpike[]> {
  const { store } = deps;
  const rules = deps.rules ?? usageAlertRules();
  const agents = store.listAllActiveAgents().filter((a) => a.state !== 'DELETED' && a.state !== 'ARCHIVED');
  const sent: UsageSpike[] = [];
  for (const s of findUsageSpikes(store, agents, rules, now)) {
    // Once per agent per 24 hours: the same spike is not news every ten minutes.
    if (store.usageAlertsSince(new Date(now - DAY).toISOString(), { agentId: s.agent.id }).length) continue;
    const told = await deps.tell(s.agent.ownerId, s.agent, usageSpikeText(s)).catch(() => false);
    store.addUsageAlert({ agentId: s.agent.id, ownerId: s.agent.ownerId, at: new Date(now).toISOString(), tokens: s.tokens, usual: s.usual, told });
    deps.log?.('usage.spike', { agentId: s.agent.id, tokens: s.tokens, usual: s.usual, told });
    sent.push(s);
  }
  return sent;
}
