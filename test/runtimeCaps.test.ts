/**
 * The Runtime tab's capability list is probed from the image, never
 * hand-maintained — these tests pin the probe's parsing and caching against
 * a stub docker, so the list stays truthful without needing docker in CI.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { probeImageCapabilities } from '../src/orchestrator/runtimeCaps.js';

/** A stub docker: `image inspect` prints the id in its folder's `id` file; `run` prints `body`. */
function stubDocker(body: string, id = 'sha256:0123456789abcdef'): string {
  const dir = mkdtempSync(join(tmpdir(), 'acl-capsdocker-'));
  const bin = join(dir, 'docker');
  writeFileSync(join(dir, 'id'), id);
  writeFileSync(join(dir, 'body'), body);
  writeFileSync(bin, `#!/usr/bin/env bash\nd="$(dirname "$0")"\nif [ "$1" = image ]; then cat "$d/id"; echo; else cat "$d/body"; echo; fi\n`, { mode: 0o755 });
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

  it('omits tools whose probe printed nothing, and caches per image', async () => {
    const docker = stubDocker(['openclaw=OpenClaw X', 'claude-code=', 'node=v22'].join('\n'));
    const caps = await probeImageCapabilities('test-image-b:1', { docker });
    expect(caps.tools['claude-code']).toBeUndefined(); // empty = not present
    expect(caps.tools.node).toBe('v22');

    // Cached: a second call for the same image runs no probe.
    writeFileSync(join(dirname(docker), 'body'), 'openclaw=SHOULD NOT BE PROBED');
    const caps2 = await probeImageCapabilities('test-image-b:1', { docker });
    expect(caps2).toBe(caps);
  });

  it('a probe that times out has its container removed, not left running on the daemon (review, 2026-10-22)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-capsdocker-'));
    const bin = join(dir, 'docker');
    // `run` hangs (a version command that never returns); every call is logged.
    writeFileSync(bin, `#!/usr/bin/env bash\necho "$*" >> "$(dirname "$0")/log"\nif [ "$1" = image ]; then echo sha256:3333333333333333; elif [ "$1" = run ]; then exec sleep 30; fi\n`, { mode: 0o755 });
    await expect(probeImageCapabilities('test-image-d:1', { docker: bin, timeoutMs: 300 })).rejects.toThrow();
    const log = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');
    const run = log.find((l) => l.startsWith('run '))!;
    const name = /--name (hatchabot-caps-[0-9a-f]+)/.exec(run)?.[1];
    expect(name).toBeTruthy();
    expect(log).toContain(`rm -f ${name}`);
  });

  it('a tag rebuilt onto another image is probed again, not answered from the cache (#124)', async () => {
    const docker = stubDocker('openclaw=OpenClaw 1\nnode=v22', 'sha256:1111111111111111');
    expect((await probeImageCapabilities('test-image-c:1', { docker })).tools.openclaw).toBe('OpenClaw 1');
    writeFileSync(join(dirname(docker), 'id'), 'sha256:2222222222222222');
    writeFileSync(join(dirname(docker), 'body'), 'openclaw=OpenClaw 2\nnode=v22\nhave=ffmpeg');
    const again = await probeImageCapabilities('test-image-c:1', { docker });
    expect(again.tools.openclaw).toBe('OpenClaw 2');
    expect(again.missing).not.toContain('ffmpeg');
  });
});
