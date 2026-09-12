import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sharePathProblem } from '../src/orchestrator/provision.js';

/**
 * Sharing a folder with an agent is deliberately powerful, so the list of
 * things that must NEVER be shared is the security boundary.
 */
describe('sharePathProblem', () => {
  const home = '/home/tester';

  it('allows an ordinary data folder', () => {
    expect(sharePathProblem('/home/tester/Documents/taxes', { home })).toBeUndefined();
    expect(sharePathProblem('/srv/shared', { home })).toBeUndefined();
  });

  it('refuses the credentials and keys that would hand over the installation', () => {
    for (const p of [
      '/home/tester/.claude',
      '/home/tester/.claude/subdir',
      '/home/tester/.ssh',
      '/home/tester/.config/hatchabot',
    ]) {
      expect(sharePathProblem(p, { home }), p).toBeTruthy();
    }
  });

  it('refuses system paths and every agent volume', () => {
    for (const p of ['/', '/etc', '/etc/shadow', '/root', '/var/lib/docker', '/proc', '/sys']) {
      expect(sharePathProblem(p, { home }), p).toBeTruthy();
    }
  });

  it('refuses a relative path, and normalises traversal before judging', () => {
    expect(sharePathProblem('Documents', { home })).toMatch(/absolute/i);
    // ../ must not sneak past the prefix check
    expect(sharePathProblem('/home/tester/Documents/../.ssh', { home })).toBeTruthy();
  });

  it('uses the real home by default', () => {
    expect(sharePathProblem(join(homedir(), '.ssh'))).toBeTruthy();
  });
});
