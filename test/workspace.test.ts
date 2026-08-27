import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceSeed,
  dataSourcePath,
  dataSourcesSection,
  memoryPolicySection,
  replaceMemoryPolicy,
  replaceSection,
  DATA_SOURCES_HEADING,
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

describe('dataSourcePath', () => {
  it('gives the path the agent actually finds each kind at', () => {
    // Git repos are cloned beside OpenClaw's own dirs on the volume...
    expect(dataSourcePath({ kind: 'git', mountName: 'notes' })).toBe('/home/node/.openclaw/notes');
    // ...folders are bind-mounted under /data, unless adopted at their host path.
    expect(dataSourcePath({ kind: 'folder', mountName: 'taxes' })).toBe('/data/taxes');
    expect(dataSourcePath({ kind: 'folder', mountName: 'x', hostPath: '/home/me/x', mountAtHostPath: true }))
      .toBe('/home/me/x');
  });
});

describe('dataSourcesSection', () => {
  it('lists every source with its real path and whether it may be written', () => {
    const out = dataSourcesSection([
      { kind: 'git', access: 'rw', mountName: 'notes', repoUrl: 'git@github.com:me/notes.git' },
      { kind: 'folder', access: 'ro', mountName: 'taxes', hostPath: '/home/me/taxes' },
    ]);
    expect(out).toContain('/home/node/.openclaw/notes');
    expect(out).toContain('git@github.com:me/notes.git');
    expect(out).toContain('you may read and write');
    expect(out).toContain('/data/taxes');
    expect(out).toContain('read-only — do not modify');
  });

  it('says so plainly when there are none', () => {
    expect(dataSourcesSection([])).toContain('None. You can only see your own workspace.');
  });

  it('replaces only its own section, leaving the rest of AGENTS.md alone', () => {
    const seeded = buildWorkspaceSeed({ agentName: 'A', slug: 'a', persona: 'p', sharedMemory: true })['AGENTS.md']!;
    const withUser = seeded + '\n## House rules\n- be kind\n';
    const once = replaceSection(withUser, DATA_SOURCES_HEADING, dataSourcesSection([
      { kind: 'git', access: 'ro', mountName: 'notes' },
    ]));
    expect(once).toContain('## House rules\n- be kind');   // user's section survives
    expect(once).toContain('## Memory policy');              // and the other managed one
    expect(once).toContain('/home/node/.openclaw/notes');

    // Re-running with a changed source swaps ONLY the data section (idempotent).
    const twice = replaceSection(once, DATA_SOURCES_HEADING, dataSourcesSection([
      { kind: 'folder', access: 'rw', mountName: 'taxes', hostPath: '/home/me/taxes' },
    ]));
    expect(twice).not.toContain('/home/node/.openclaw/notes'); // old entry gone
    expect(twice).toContain('/data/taxes');
    expect(twice).toContain('## House rules\n- be kind');
    expect(twice.match(/## Data sources/g)).toHaveLength(1);   // never duplicated
  });
});
