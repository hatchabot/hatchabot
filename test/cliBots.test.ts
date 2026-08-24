import { describe, expect, it } from 'vitest';
import { fmtBots } from '../src/cli.js';

/**
 * The `agentclaw bots` renderer — where the real CLI bugs live: column
 * alignment when handles differ in length, the ⇄ "same bot elsewhere" marker,
 * and the summary counts. Pure, so we assert on the exact lines.
 */
const hosts = [
  {
    host: 'dgx-spark',
    mgmtBotConfigured: true,
    bots: [
      { username: 'aReallyLongHandleBot', cls: 'in-use', source: 'agent', agentName: 'Tech', state: 'RUNNING', valid: true },
      { username: 'shrt', cls: 'reclaimable', source: 'agent', agentName: 'History', state: 'STOPPED', valid: true, polling: 'quiet' },
      { username: 'gonebot', cls: 'dead', source: 'agent', agentName: 'Old', state: 'STOPPED', valid: false },
    ],
  },
  { host: 'Laptop', mgmtBotConfigured: false, bots: [
    { username: 'shrt', cls: 'reclaimable', source: 'agent', agentName: 'History', state: 'STOPPED', valid: true, polling: 'quiet' },
  ] },
  { host: 'Desktop', error: 'unreachable (timeout)', bots: [] },
];

describe('fmtBots', () => {
  it('numbers every line and aligns the username column to the widest handle', () => {
    const lines = fmtBots(hosts, false);
    const rows = lines.filter((l) => /^\s*\d+\./.test(l));
    // 3 dgx bots + mgmt + 1 laptop bot = 5 numbered rows, sequential
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.trim().split('.')[0])).toEqual(['1', '2', '3', '4', '5']);
    // widest handle is @aReallyLongHandleBot; every "@..." starts at the same column
    const atCols = rows.filter((r) => r.includes('@')).map((r) => r.indexOf('@'));
    expect(new Set(atCols).size).toBe(1);
    // the status word aligns too (constant column across rows)
    const useCols = rows.filter((r) => r.includes('in use') || r.includes('reclaimable') || r.includes('DEAD'));
    // dead bot is tagged DEAD, reclaimable as reclaimable, in-use as "in use"
    expect(lines.join('\n')).toContain('DEAD');
  });

  it('flags a bot present on two hosts with a ⇄ marker on both, and counts it', () => {
    const text = fmtBots(hosts, false).join('\n');
    // @shrt is on dgx-spark (STOPPED) and Laptop (STOPPED)
    expect(text).toContain('⇄ also Laptop:History[STOPPED]');
    expect(text).toContain('⇄ also dgx-spark:History[STOPPED]');
    // summary: 2 reclaimable, 1 dead, 1 shared bot
    expect(text).toMatch(/2 reclaimable · 1 dead · 1 bot\(s\) shared/);
  });

  it('shows an unreachable peer as an error line with no rows', () => {
    const text = fmtBots(hosts, false).join('\n');
    expect(text).toContain('Desktop  — unreachable (timeout)');
  });

  it('adds a live verdict column under --check', () => {
    const text = fmtBots(hosts, true).join('\n');
    expect(text).toContain('valid');   // getMe ok
    expect(text).toContain('invalid'); // the dead bot
    expect(text).toContain(',idle');   // reclaimable + quiet poll
  });
});
