import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper shared with the build script
import { embedEngine, pickPlugin, satisfies } from '../scripts/runtime-pins.mjs';
import { readFileSync } from 'node:fs';
import { parseEmbedEngineLabel } from '../src/providers/provider.js';
import { EMBED_MODEL_SHA256, EMBED_MODEL_URL } from '../src/embedder/embedder.js';

describe('runtime image pins', () => {
  const R9 = '>=24.16.0 <25 || >=26.1.0';
  it('reads an npm engines range', () => {
    expect(satisfies('v22.23.2', R9)).toBe(false);
    expect(satisfies('v24.15.9', R9)).toBe(false);
    expect(satisfies('v24.21.0', R9)).toBe(true);
    expect(satisfies('v25.9.0', R9)).toBe(false);
    expect(satisfies('26.1.0', R9)).toBe(true);
    expect(satisfies('v22.23.2', '>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0')).toBe(true);
  });
  it('never claims a fit for a range it cannot read', () => {
    expect(satisfies('v24.21.0', '^24.16.0')).toBe(false);
    expect(satisfies('garbage', R9)).toBe(false);
  });
  it('picks the newest full plugin release that is not newer than OpenClaw', () => {
    const list = ['2026.7.1', '2026.7.33', '2026.8.2', '2026.9.1-beta.1', '2026.9.1', '2026.9.4', '2026.9.5'];
    expect(pickPlugin('2026.9.4', list)).toBe('2026.9.4');
    expect(pickPlugin('2026.9.0', list)).toBe('2026.8.2');
    expect(pickPlugin('2026.7.1-2', list)).toBe('2026.7.1');
    expect(pickPlugin('2026.1.0', list)).toBeUndefined();
  });
});

describe('the memory search engine in an image', () => {
  it('2026.8 and later have nothing to bake; earlier versions bake their own', () => {
    expect(embedEngine('2026.7.1-2')).toBe('baked');
    expect(embedEngine('2026.7.33')).toBe('baked');
    expect(embedEngine('2026.8.0')).toBe('none');
    expect(embedEngine('2026.9.4')).toBe('none');
    expect(embedEngine('garbage')).toBe('baked');
  });
  it('the plugins label lists ids from id=package pairs', async () => {
    const { parsePluginsLabel } = await import('../src/providers/provider.js');
    expect(parsePluginsLabel('duckduckgo=@openclaw/duckduckgo-plugin')).toEqual(['duckduckgo']);
    expect(parsePluginsLabel('')).toEqual([]);
    expect(parsePluginsLabel(undefined)).toEqual([]);
    expect(parsePluginsLabel('a=b,Bad Id=x,c')).toEqual(['a', 'c']);
  });
  it('only an explicit none label means none: every image built before the label has an engine', () => {
    expect(parseEmbedEngineLabel('none')).toBe('none');
    expect(parseEmbedEngineLabel('baked')).toBe('baked');
    expect(parseEmbedEngineLabel('')).toBe('baked');
    expect(parseEmbedEngineLabel(undefined)).toBe('baked');
  });
  it('the Dockerfile takes the engine as an argument, labels it, and pins the same model the shared service serves', () => {
    const df = readFileSync('docker/Dockerfile.runtime', 'utf8');
    expect(df).toMatch(/^ARG EMBED_ENGINE=baked$/m);
    expect(df).toContain('LABEL org.hatchabot.embed-engine="${EMBED_ENGINE}"');
    expect(df).toMatch(/^ARG BAKED_PLUGINS=$/m);
    expect(df).toContain('LABEL org.hatchabot.plugins="${BAKED_PLUGINS}"');
    expect(df).toContain(`ARG EMBED_MODEL_URL=${EMBED_MODEL_URL}`);
    expect(df).toContain(`ARG EMBED_MODEL_SHA256=${EMBED_MODEL_SHA256}`);
  });
  it('the build script drops the engine for 2026.8+, tags a deliberate -lite build apart, and refuses a baked 2026.8+', async () => {
    const { execFileSync } = await import('node:child_process');
    const run = (env: Record<string, string>) => {
      try {
        return execFileSync('bash', ['scripts/build-runtime-image.sh'], { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, DRYRUN: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { const x = e as { stdout?: string; stderr?: string }; return String(x.stdout ?? '') + String(x.stderr ?? ''); }
    };
    expect(run({})).toMatch(/hatchabot-runtime:2026\.7\.1-2 \(OpenClaw 2026\.7\.1-2, engine baked\)/);
    expect(run({ EMBED_ENGINE: 'none' })).toMatch(/hatchabot-runtime:2026\.7\.1-2-lite \(.*engine none\)/);
    expect(run({ OPENCLAW_VERSION: '2026.9.4' })).toMatch(/hatchabot-runtime:2026\.9\.4 \(OpenClaw 2026\.9\.4, engine none\)/);
    expect(run({ OPENCLAW_VERSION: '2026.9.4', EMBED_ENGINE: 'baked' })).toMatch(/no embedding engine to bake/);
    expect(run({ EMBED_ENGINE: 'sideways' })).toMatch(/must be baked or none/);
  }, 30_000);
});

describe('extra packages in a base candidate', () => {
  it('the build script takes only apt names, and gives such an image its own tag', async () => {
    const { execFileSync } = await import('node:child_process');
    const run = (env: Record<string, string>) => {
      try {
        // Stop right after the naming decisions: nothing is built here.
        return execFileSync('bash', ['-c',
          'set -a; ' + Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('; ') +
          '; set +a; DRYRUN=1 bash -c "source scripts/build-runtime-image.sh" 2>&1 || true'],
          { encoding: 'utf8', cwd: process.cwd() });
      } catch (e) { return String((e as { stdout?: string }).stdout ?? e); }
    };
    expect(run({ EXTRA_PACKAGES: 'ping; rm -rf /', BUILD_LOCAL: '1' })).toMatch(/space-separated apt package names/);
  }, 30_000);
});
