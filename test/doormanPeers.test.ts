import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { getOpsHandlers } from '../src/ops/opsServer.js';

/**
 * Only a management agent's doorman may use the door — but a rebuild replaces
 * that doorman, and docker gives the new one a different address. Refusing it
 * cost a live agent its AI for half a minute (2026-09-19).
 */

async function world(addresses: () => string[]) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const looks: string[] = [];
  // A real method, using `this` — the real provider's does (it reaches for
  // docker), and a detached call would throw instead of answering.
  class Probing extends MockProvider {
    readonly marker = 'doorman-probe';
    async doormanAddresses(id: string): Promise<string[]> {
      if (this?.marker !== 'doorman-probe') throw new TypeError('called without its provider');
      looks.push(id);
      return addresses();
    }
  }
  const provider = new Probing();
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} },
    providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } },
  } as never);
  store.insertAgent({
    id: 'ops-1', ownerId: 'o', name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    runtimeRef: 'docker://ops-1', persona: '', sharedMemory: false, webOnly: true, ops: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  return { store, f, looks, peerOk: getOpsHandlers()!.peerOk! };
}

describe('who the door lets in', () => {
  it('lets the current doorman in and keeps everyone else out', async () => {
    const { peerOk } = await world(() => ['172.17.0.2', '172.20.0.2']);
    expect(await peerOk('172.17.0.2')).toBe(true);
    expect(await peerOk('172.17.0.9')).toBe(false); // an ordinary agent on the same bridge
    expect(await peerOk('')).toBe(false);
  });

  it('follows the doorman to its new address after a rebuild', async () => {
    let current = ['172.17.0.2'];
    const { peerOk } = await world(() => current);
    expect(await peerOk('172.17.0.2')).toBe(true);
    // A rebuild replaces the doorman; docker hands out a different address.
    current = ['172.17.0.7'];
    await new Promise((r) => setTimeout(r, 1100)); // past the "look again" gate
    expect(await peerOk('172.17.0.7')).toBe(true);
  }, 10_000);

  it('does not ask docker on every knock', async () => {
    const { peerOk, looks } = await world(() => ['172.17.0.2']);
    expect(await peerOk('172.17.0.2')).toBe(true);
    const after = looks.length;
    for (let i = 0; i < 20; i++) await peerOk('172.17.0.99'); // a stranger, hammering
    expect(looks.length - after).toBeLessThanOrEqual(2);
  });
});
