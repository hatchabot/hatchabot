/**
 * The Runtime tab's capability list is probed from the image, never
 * hand-maintained — these tests pin the probe's parsing and caching against
 * a stub docker, so the list stays truthful without needing docker in CI.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeImageCapabilities } from '../src/orchestrator/runtimeCaps.js';

function stubDocker(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'acl-capsdocker-'));
  const bin = join(dir, 'docker');
  writeFileSync(bin, `#!/usr/bin/env bash\ncat <<'EOF'\n${body}\nEOF\n`, { mode: 0o755 });
  return bin;
}

describe('probeImageCapabilities', () => {
  it('parses tool versions and reports deliberately-absent binaries', async () => {
    const docker = stubDocker([
      'openclaw=OpenClaw 2026.7.1-2 (0790d9f)',
      'claude-code=2.1.224 (Claude Code)',
      'node=v22.16.0',
      'python=Python 3.11.2',
      'git=git version 2.39.5',
      'gog=v0.22.0 (9738b31)',
      'have=ffmpeg', // pretend ffmpeg exists → must NOT be listed missing
    ].join('\n'));

    const caps = await probeImageCapabilities('test-image-a:1', { docker });
    expect(caps.tools.openclaw).toBe('OpenClaw 2026.7.1-2 (0790d9f)');
    expect(caps.tools.gog).toBe('v0.22.0 (9738b31)');
    expect(caps.missing).toEqual(['whisper', 'chromium']); // ffmpeg present
  });

  it('omits tools whose probe printed nothing, and caches per image tag', async () => {
    const docker = stubDocker(['openclaw=OpenClaw X', 'claude-code=', 'node=v22'].join('\n'));
    const caps = await probeImageCapabilities('test-image-b:1', { docker });
    expect(caps.tools['claude-code']).toBeUndefined(); // empty = not present
    expect(caps.tools.node).toBe('v22');

    // Cached: a second call must not need docker at all.
    const caps2 = await probeImageCapabilities('test-image-b:1', { docker: '/nonexistent' });
    expect(caps2).toBe(caps);
  });
});
