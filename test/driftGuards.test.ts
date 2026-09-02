import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { EMBED_MODEL_PATH, EMBED_PLUGIN_DIR } from '../src/openclaw/configWriter.js';

/**
 * Cross-file drift guards (audit 2026-09-02). Each pair here is two files that
 * MUST agree but share no import edge — the classic silent-drift shape: one
 * side changes, nothing fails, and the symptom surfaces weeks later in
 * production. These tests are the missing import edge.
 */

const read = (p: string) => readFileSync(p, 'utf8');

describe('embed paths: configWriter ↔ Dockerfile.runtime', () => {
  // configWriter points every agent's memorySearch at these image paths. If the
  // Dockerfile moves or renames them (a model bump changes the FILENAME), the
  // config silently points at nothing and semantic memory search dies quietly.
  it('the Dockerfile bakes exactly the paths configWriter references', () => {
    const df = read('docker/Dockerfile.runtime');
    expect(df).toContain(EMBED_PLUGIN_DIR);
    expect(df).toContain(EMBED_MODEL_PATH);
    // The env the image exports for discovery must name the same paths.
    expect(df).toMatch(new RegExp(`AGENTCLAW_EMBED_PLUGIN=${EMBED_PLUGIN_DIR}`));
    expect(df).toMatch(new RegExp(`AGENTCLAW_EMBED_MODEL=${EMBED_MODEL_PATH}`));
  });
});

describe('OPENCLAW_VERSION: Dockerfile ARG ↔ build script default', () => {
  // A bare `docker build` must produce the same version the build script ships;
  // the Dockerfile's own comment demands this and nothing enforced it.
  it('defaults match', () => {
    const df = /ARG OPENCLAW_VERSION=(\S+)/.exec(read('docker/Dockerfile.runtime'));
    const sh = /OPENCLAW_VERSION="\$\{OPENCLAW_VERSION:-([^}]+)\}"/.exec(
      read('scripts/build-runtime-image.sh'),
    );
    expect(df?.[1]).toBeTruthy();
    expect(df?.[1]).toBe(sh?.[1]);
  });
});

describe('claude-opus-5 must stay banished from offered model lists', () => {
  // The claude-cli (Max) runtime has no catalog entry for it: it once became a
  // fleet default and every conversation broke on compaction. The server list
  // was fixed; the web copy resurrected it (found by audit). Pin both.
  it('web and e2e never offer it', () => {
    const web = read('web/index.html');
    const models = /const CLAUDE_MODELS = \[([\s\S]*?)\]/.exec(web)?.[1] ?? '';
    expect(models).not.toContain('claude-opus-5');
    expect(read('scripts/e2e.ts')).not.toContain('claude-opus-5');
  });

  it('web offers every curated model the server would stock', () => {
    // CURATED_ANTHROPIC_MODELS in routes.ts is the server-side source of
    // truth; the web fallback list must at least cover it.
    const routes = read('src/api/routes.ts');
    const curated = [...(/CURATED_ANTHROPIC_MODELS = \[([\s\S]*?)\]/.exec(routes)?.[1] ?? '')
      .matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(curated.length).toBeGreaterThan(2);
    const webModels = /const CLAUDE_MODELS = \[([\s\S]*?)\]/.exec(read('web/index.html'))?.[1] ?? '';
    for (const m of curated) expect(webModels).toContain(`'${m}'`);
  });
});
