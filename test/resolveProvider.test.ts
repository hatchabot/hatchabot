import { describe, expect, it } from 'vitest';
import { resolveProvider } from '../src/providers/resolveProvider.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import type { RuntimeProvider } from '../src/providers/provider.js';
import type { Host } from '../src/domain/types.js';

const host = (over: Partial<Host> = {}): Host => ({
  id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now', ...over,
});

describe('resolveProvider', () => {
  it('resolves the shared, name-keyed provider for a plain host', () => {
    const mock = new MockProvider();
    const shared = new Map<string, RuntimeProvider>([['mock', mock]]);
    expect(resolveProvider(host(), shared, new Map())).toBe(mock);
  });

  it('builds a remote-pointed provider for a runner host (settings.dockerHost), cached per host', () => {
    const shared = new Map<string, RuntimeProvider>();
    const cache = new Map<string, RuntimeProvider>();
    const runner = host({ id: 'runner1', kind: 'cloud', provider: 'remote-docker', settings: { dockerHost: 'ssh://runner@10.0.0.9' } });

    const p = resolveProvider(runner, shared, cache, { image: 'img:latest', prefix: 'aclaw' });
    expect(p).toBeInstanceOf(LocalDockerProvider);
    expect((p as LocalDockerProvider).remote).toBe(true);
    expect((p as LocalDockerProvider).key).toBe('remote-docker');
    // second call returns the SAME instance (built once, kept for the process)
    expect(resolveProvider(runner, shared, cache, {})).toBe(p);
  });

  it('rebuilds when the endpoint changes', () => {
    const cache = new Map<string, RuntimeProvider>();
    const a = resolveProvider(host({ id: 'r', settings: { dockerHost: 'ssh://a' } }), new Map(), cache);
    const b = resolveProvider(host({ id: 'r', settings: { dockerHost: 'ssh://b' } }), new Map(), cache);
    expect(a).not.toBe(b);
  });

  it('throws for a plain host whose named provider is not registered', () => {
    expect(() => resolveProvider(host({ provider: 'nope' }), new Map(), new Map())).toThrow(/No provider registered/);
  });
});
