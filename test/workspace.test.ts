import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceSeed,
  memoryPolicySection,
  replaceMemoryPolicy,
} from '../src/openclaw/workspace.js';

describe('replaceMemoryPolicy', () => {
  it('swaps the seeded policy for the other mode, round-trip', () => {
    const seeded = buildWorkspaceSeed({
      agentName: 'A', slug: 'a', persona: 'p', sharedMemory: true,
    })['AGENTS.md']!;
    const flipped = replaceMemoryPolicy(seeded, memoryPolicySection(false));
    expect(flipped).toContain("MEMORY.md is private to this agent's owner");
    expect(flipped).not.toContain('shared');
    // flipping back restores the original text exactly
    expect(replaceMemoryPolicy(flipped, memoryPolicySection(true))).toBe(seeded);
  });

  it('preserves user sections added after the policy', () => {
    const edited = `# A\n\n## Memory policy\n- old\n\n## House rules\n- be kind\n`;
    const out = replaceMemoryPolicy(edited, memoryPolicySection(false));
    expect(out).toContain('## House rules\n- be kind');
    expect(out).toContain("private to this agent's owner");
    expect(out).not.toContain('- old');
  });

  it('appends when the heading is missing', () => {
    const out = replaceMemoryPolicy('# A\n\ncustom\n', memoryPolicySection(true));
    expect(out).toMatch(/custom\n\n## Memory policy/);
  });
});
