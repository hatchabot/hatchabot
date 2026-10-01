import { afterEach, describe, expect, it } from 'vitest';
import { claudePlanAllowed } from '../src/config/claudePlan.js';
import { usableForMgmt } from '../src/api/mgmtLlm.js';
import type { AIProfile } from '../src/domain/types.js';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { buildRuntimeSpec, type ProvisionDeps } from '../src/orchestrator/provision.js';

function world(kind: 'subscription' | 'api_key') {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind, model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const map = new Map([['ai/p1', 'not-a-real-credential']]);
  const secrets = { async get(r: string) { const v = map.get(r); if (v === undefined) throw new Error('missing'); return v; }, async put() {}, async delete() {} };
  store.insertAgent({ id: 'a1', ownerId: 'o', name: 'A', slug: 'a', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
  return { store, secrets, provider: new MockProvider(), channel: { kind: 'telegram', pool: { owns: () => false } }, log: () => {}, sleep: async () => {} } as unknown as ProvisionDeps;
}

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

const plan = { vendor: 'anthropic', kind: 'subscription', secretRef: 'x' } as unknown as AIProfile;
const key = { vendor: 'anthropic', kind: 'api_key', secretRef: 'y' } as unknown as AIProfile;

describe('a hosted Hatchabot never relays a Claude plan', () => {
  it('the rule: home allows, hosted refuses, the setting re-enables', () => {
    delete process.env.HATCHABOT_MANAGED_BY;
    expect(claudePlanAllowed()).toBe(true);
    process.env.HATCHABOT_MANAGED_BY = 'Example Cloud';
    expect(claudePlanAllowed()).toBe(false);
    process.env.HATCHABOT_MANAGED_ALLOW_CLAUDE_PLAN = '1';
    expect(claudePlanAllowed()).toBe(true);
  });
  it('the management chat skips an existing plan source when hosted', () => {
    process.env.HATCHABOT_MANAGED_BY = 'Example Cloud';
    expect(usableForMgmt(plan)).toBe(false);
    expect(usableForMgmt(key)).toBe(true);
    delete process.env.HATCHABOT_MANAGED_BY;
    expect(usableForMgmt(plan)).toBe(true);
  });
  it('a build on an existing plan source is refused when hosted, and goes ahead at home', async () => {
    process.env.HATCHABOT_MANAGED_BY = 'Example Cloud';
    await expect(buildRuntimeSpec(world('subscription'), 'a1')).rejects.toThrow(/API key from console\.anthropic\.com/);
    await expect(buildRuntimeSpec(world('api_key'), 'a1')).resolves.toBeTruthy();
    delete process.env.HATCHABOT_MANAGED_BY;
    await expect(buildRuntimeSpec(world('subscription'), 'a1')).resolves.toBeTruthy();
  });
});
