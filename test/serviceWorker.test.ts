import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** web/sw.js in a bare context: the caches it holds and the handlers it adds. */
function load(names: string[]) {
  const caches = new Set(names);
  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    addEventListener: (t: string, fn: (e: unknown) => void) => { handlers[t] = fn; },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    location: { origin: 'http://localhost:8080' },
  };
  const api = {
    keys: async () => [...caches],
    delete: async (k: string) => caches.delete(k),
    open: async (k: string) => { caches.add(k); return { addAll: async () => {}, put: async () => {} }; },
    match: async () => undefined,
  };
  runInNewContext(readFileSync('web/sw.js', 'utf8'), { self, caches: api, fetch: async () => ({}), URL });
  return { caches, handlers };
}

describe('the service worker (audit, 2026-10-22)', () => {
  it('on activate deletes only its own older shells, never another page\'s caches on the origin', async () => {
    const { caches, handlers } = load(['agentclaw-shell-v2', 'hatchabot-shell-v3', 'hatchabot-shell-v4', 'console-offline', 'other-app-v1']);
    let wait: Promise<unknown> = Promise.resolve();
    handlers.activate!({ waitUntil: (p: Promise<unknown>) => { wait = p; } });
    await wait;
    expect([...caches].sort()).toEqual(['console-offline', 'hatchabot-shell-v4', 'other-app-v1']);
  });
});
