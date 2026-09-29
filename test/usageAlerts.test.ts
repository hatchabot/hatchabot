import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { findUsageSpikes, runUsageAlerts, usageSpikeText } from '../src/orchestrator/usageAlerts.js';

// "Token use went up and I don't know where it's from" (2026-09-28).

const OWNER = 'user-o';
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const H = 3_600_000, D = 24 * H;
const RULES = { ratio: 3, minTokens: 20_000_000, newAgentTokens: 100_000_000 };

/** An agent whose counter rises `perDay[k]` on the k-th day back (k = 0 is the last 24 hours). */
function world(agents: Array<{ id: string; name: string; perDay: number[]; createdDaysAgo?: number }>) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p', ownerId: OWNER, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/p', createdAt: 'now' } as never);
  for (const a of agents) {
    const created = new Date(NOW - (a.createdDaysAgo ?? 30) * D).toISOString();
    store.insertAgent({ id: a.id, ownerId: OWNER, name: a.name, slug: a.id, state: 'RUNNING', aiProfileId: 'p', hostId: 'h1', runtimeRef: `mock://${a.id}`, persona: '', sharedMemory: true, createdAt: created, updatedAt: created } as never);
    // One reading at the start, then one in the middle of each day with that day's rise.
    const start = Math.max(NOW - 8 * D, NOW - (a.createdDaysAgo ?? 30) * D);
    let total = 1_000;
    store.addTokenSample(a.id, 'p', new Date(start).toISOString(), total);
    for (let k = a.perDay.length - 1; k >= 0; k--) {
      const at = NOW - k * D - D / 2;
      if (at <= start) continue;
      total += a.perDay[k]!;
      store.addTokenSample(a.id, 'p', new Date(at).toISOString(), total);
    }
  }
  return store;
}

describe('usage spikes', () => {
  it('an agent using 5× its usual day is news; one always this busy is not', () => {
    const store = world([
      { id: 'sched', name: 'Scheduler', perDay: [100e6, 20e6, 20e6, 20e6, 20e6, 20e6, 20e6, 20e6] },
      { id: 'qa', name: 'QA', perDay: [500e6, 500e6, 500e6, 500e6, 500e6, 500e6, 500e6, 500e6] },
    ]);
    const spikes = findUsageSpikes(store, store.listAllActiveAgents(), RULES, NOW);
    expect(spikes.map((s) => [s.agent.name, s.tokens, Math.round(s.usual)])).toEqual([['Scheduler', 100e6, 20e6]]);
    expect(usageSpikeText(spikes[0]!)).toMatch(/"Scheduler" used 100M tokens in the last 24 hours — about 5× its usual day \(20M\)/);
  });

  it('a busy two days a week is its usual, not news (an average, not a median)', () => {
    const store = world([{ id: 'wk', name: 'Weekly', perDay: [50e6, 0, 0, 0, 0, 0, 70e6, 70e6] }]);
    expect(findUsageSpikes(store, store.listAllActiveAgents(), RULES, NOW)).toEqual([]);
  });

  it('small numbers say nothing, however many times usual', () => {
    const store = world([{ id: 'q', name: 'Quiet', perDay: [5e6, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000] }]);
    expect(findUsageSpikes(store, store.listAllActiveAgents(), RULES, NOW)).toEqual([]);
  });

  it('a new agent has no usual day: judged on size alone', () => {
    const store = world([
      { id: 'n1', name: 'New big', perDay: [150e6, 1e6], createdDaysAgo: 2 },
      { id: 'n2', name: 'New fine', perDay: [60e6, 1e6], createdDaysAgo: 2 },
      { id: 'old', name: 'Old', perDay: [0, 0, 0, 0, 0, 0, 0, 0] },
    ]);
    const spikes = findUsageSpikes(store, store.listAllActiveAgents(), RULES, NOW);
    expect(spikes.map((s) => s.agent.name)).toEqual(['New big']);
    expect(usageSpikeText(spikes[0]!)).toContain('a lot for an agent this new');
  });

  it('tells the owner once a day per agent, and records whether it reached them', async () => {
    const store = world([{ id: 'sched', name: 'Scheduler', perDay: [100e6, 20e6, 20e6, 20e6, 20e6, 20e6, 20e6, 20e6] }]);
    const told: string[] = [];
    const tell = async (ownerId: string, _a: unknown, text: string) => { told.push(`${ownerId}: ${text.slice(0, 30)}`); return false; };
    await runUsageAlerts({ store, tell, rules: RULES }, NOW);
    await runUsageAlerts({ store, tell, rules: RULES }, NOW + 10 * 60_000);
    expect(told).toEqual(['user-o: ⚠️ Hatchabot: "Scheduler" used']);
    expect(store.usageAlertsSince(new Date(NOW - D).toISOString(), { ownerId: OWNER })).toMatchObject([{ agentId: 'sched', tokens: 100e6, usual: 20e6, told: false }]);
    expect(store.usageAlertsSince(new Date(NOW - D).toISOString(), { ownerId: 'someone-else' })).toEqual([]);
  });
});
