import { describe, expect, it } from 'vitest';
import { msToEvery } from '../src/orchestrator/crons.js';
import { extractSection, replaceSection } from '../src/openclaw/workspace.js';

describe('msToEvery (10th audit: 20s intervals became "0m")', () => {
  it('is seconds-accurate and never emits a zero interval', () => {
    expect(msToEvery(20_000)).toBe('20s');
    expect(msToEvery(90_000)).toBe('90s');
    expect(msToEvery(60_000)).toBe('1m');
    expect(msToEvery(15 * 60_000)).toBe('15m');
    expect(msToEvery(2 * 3_600_000)).toBe('2h');
    expect(msToEvery(1)).toBe('1s'); // floor, not 0
  });
});

describe('extractSection', () => {
  const DOC = '# Top\nintro\n\n## Data sources\n- repo at /x\n- folder at /y\n\n## Next\nafter\n';
  it('lifts a section with the same boundaries replaceSection uses', () => {
    const s = extractSection(DOC, '## Data sources');
    expect(s).toBe('## Data sources\n- repo at /x\n- folder at /y');
    // round-trips through replaceSection
    const other = '# Other\n\n## Data sources\n- their stuff\n\n## Tail\nz\n';
    const spliced = replaceSection(other, '## Data sources', s);
    expect(spliced).toContain('- repo at /x');
    expect(spliced).not.toContain('their stuff');
    expect(spliced).toContain('## Tail');
  });
  it('ignores fenced copies and returns empty when absent', () => {
    const fenced = '```\n## Data sources\nfake\n```\nreal text\n';
    expect(extractSection(fenced, '## Data sources')).toBe('');
    expect(extractSection('no sections here', '## Data sources')).toBe('');
  });
});
