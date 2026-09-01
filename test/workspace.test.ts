import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceSeed,
  dataSourcePath,
  dataSourcesSection,
  memoryPolicySection,
  replaceMemoryPolicy,
  replaceSection,
  DATA_SOURCES_HEADING,
  installConventionsSection,
  INSTALL_HEADING,
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

describe('replaceSection must not eat the user\'s file', () => {
  const SEC = '## Data sources\n- `/data/new` — folder';

  it('keeps everything after the section when no `## ` follows it', () => {
    // The old indexOf('\n## ') returned -1 here and truncated the tail.
    const doc = '## Data sources\n- old\n\nMy own rules:\n- always CC me\n\n### Escalation\nCall the owner.\n';
    const out = replaceSection(doc, DATA_SOURCES_HEADING, SEC);
    expect(out).toContain('### Escalation');
    expect(out).toContain('Call the owner.');
    expect(out).toContain('/data/new');
    expect(out).not.toContain('- old');
  });

  it('does not match a deeper heading that merely starts with the same words', () => {
    const doc = '# A\n\n### Data sources (mine)\n- keep me\n';
    const out = replaceSection(doc, DATA_SOURCES_HEADING, SEC);
    // No real section existed, so ours is APPENDED and the h3 survives intact.
    expect(out).toContain('### Data sources (mine)');
    expect(out).toContain('- keep me');
    expect(out.match(/## Data sources$/gm)).toHaveLength(1);
  });

  it('ignores the heading text inside a fenced code block', () => {
    const doc = '# A\n\n## Notes\nExample:\n```\n## Data sources\n```\nafter fence\n';
    const out = replaceSection(doc, DATA_SOURCES_HEADING, SEC);
    // The fence body is not a heading line, so it must survive untouched...
    expect(out).toContain('```\n## Data sources\n```');
    expect(out).toContain('after fence');
    // ...and our real section is appended once.
    expect(out.trimEnd().endsWith('- `/data/new` — folder')).toBe(true);
  });

  it('is idempotent — re-running changes nothing', () => {
    const doc = '# A\n\n## Data sources\n- old\n\n## Tail\nkeep\n';
    const once = replaceSection(doc, DATA_SOURCES_HEADING, SEC);
    expect(replaceSection(once, DATA_SOURCES_HEADING, SEC)).toBe(once);
    expect(once).toContain('## Tail');
    expect(once).toContain('keep');
  });
});

describe('installConventionsSection: the rules of the house, told to the agent', () => {
  it('teaches every volume-layer install path, and warns off apt', () => {
    const t = installConventionsSection();
    // Each of these mechanisms exists in the runtime; the section is the ONLY
    // place an agent learns them, so losing one silently breaks self-serve.
    expect(t).toContain('~/.local/bin');
    expect(t).toContain('npm install -g');
    expect(t).toContain('pip install --target ~/.openclaw/pylibs');
    expect(t).toContain('openclaw skills install');
    expect(t).toContain('on-rebuild.sh');
    expect(t).toMatch(/no apt/i); // the failure mode that escalated to a human
    expect(t.startsWith(INSTALL_HEADING)).toBe(true);
  });

  it('replaces cleanly into an existing TOOLS.md without touching the agent\'s notes', () => {
    const file = `# TOOLS.md - Local Notes\n\n### SSH\n\n- home-server -> 192.168.1.100\n`;
    const once = replaceSection(file, INSTALL_HEADING, installConventionsSection());
    expect(once).toContain('home-server'); // agent's notes intact
    expect(once).toContain('~/.local/bin');
    // Idempotent: a second sync with unchanged content is a no-op, which is
    // what lets provisioning skip the write entirely.
    expect(replaceSection(once, INSTALL_HEADING, installConventionsSection())).toBe(once);
  });
});
