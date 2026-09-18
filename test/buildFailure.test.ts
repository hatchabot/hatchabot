import { describe, expect, it } from 'vitest';
import { buildFailureReason, openclawBuildable } from '../src/orchestrator/buildFailure.js';

describe('why a base-image build failed', () => {
  it('quotes the script\'s own marked reason, through docker\'s line prefixes', () => {
    const log = [
      '#10 3.840 Installed plugin: llama-cpp',
      '#10 4.219 ✗ OpenClaw 2026.9.4: its embedding plugin (2026.9.4) no longer carries its own engine.',
      '#10 4.219   From OpenClaw 2026.8 the plugin runs a separate llama-server.',
      '#10 4.219   Not building it.',
      '#10 ERROR: process "/bin/sh -c export HOME=/tmp/ocbuild" did not complete successfully: exit code: 1',
    ].join('\n');
    const r = buildFailureReason(log, 1);
    expect(r).toMatch(/^OpenClaw 2026\.9\.4: its embedding plugin/);
    expect(r).toMatch(/separate llama-server\. Not building it\.$/);
  });
  it('falls back to the last real error line, never the echoed shell command', () => {
    const log = '#6 4.4 E: Failed to fetch http://deb.debian.org/x.deb  File has unexpected size\n#6 ERROR: process "/bin/sh -c apt-get update" did not complete';
    expect(buildFailureReason(log, 100)).toMatch(/^E: Failed to fetch/);
  });
  it('says so when the log has nothing', () => {
    expect(buildFailureReason('', 1)).toMatch(/code 1/);
  });
});

describe('which OpenClaw versions can be built here', () => {
  it('the proven line and its revisions can; 2026.8 onward cannot yet', () => {
    expect(openclawBuildable('2026.7.1-2')).toBe(true);
    expect(openclawBuildable('2026.7.33')).toBe(true);
    expect(openclawBuildable('2026.8.0')).toBe(false);
    expect(openclawBuildable('2026.9.4')).toBe(false);
    expect(openclawBuildable(undefined)).toBe(true);
  });
});
