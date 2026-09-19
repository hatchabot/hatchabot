import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { getOpsHandlers } from '../src/ops/opsServer.js';

/**
 * What the management agent is actually offered, through its own door. The
 * agent reads this list once at start-up, so when it says "I have no tool for
 * that", the first question is whether the door still serves the old list.
 */

async function door() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} },
    providers: new Map([['mock', new MockProvider()]]), channel: { kind: 'telegram', pool: { owns: () => false } },
  } as never);
  store.insertAgent({
    id: 'ops1', ownerId: 'o', name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    runtimeRef: 'docker://ops1', persona: '', sharedMemory: false, webOnly: true, ops: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  store.setOpsToken('ops1', 'o', 'key-abc');
  return getOpsHandlers()!;
}

describe('the tools the door serves', () => {
  it('offers a base candidate WITH extra packages', async () => {
    const handlers = await door();
    const res = await handlers.mcp('key-abc', { jsonrpc: '2.0', id: 1, method: 'tools/list' }) as
      { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }> } };
    const tools = res.result?.tools ?? [];
    const build = tools.find((t) => t.name === 'build_base_candidate');
    expect(build, 'build_base_candidate is on the menu').toBeDefined();
    // The exact thing the agent told its owner it could not do.
    expect(Object.keys(build!.inputSchema?.properties ?? {})).toContain('packages');
    expect(build!.description).toMatch(/packages/i);
  });
});
