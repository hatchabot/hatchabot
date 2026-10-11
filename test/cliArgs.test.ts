import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { durationMinutes, matchAgent, matchTask, parseArgs, pickProfile, writeConfigValue } from '../src/cli.js';

describe('CLI flags (audit: unknown flags swallowed the next argument)', () => {
  it('knows its on/off flags, so they no longer eat what follows', () => {
    const a = parseArgs(['create', '--no-telegram', 'Foo', '--persona', 'helps']);
    expect(a.positional).toEqual(['create', 'Foo']);
    expect(a.flags.get('no-telegram')).toBe('1');
    expect(a.flags.get('persona')).toBe('helps');
    const b = parseArgs(['switch-source', '--rebuild', '--to', 'Claude']);
    expect(b.flags.get('to')).toBe('Claude');
  });

  it('hbt release takes --draft-only as an on/off flag (release by workflow, 2026-10-10)', () => {
    const a = parseArgs(['release', '--draft-only', '2.159.0']);
    expect(a.positional).toEqual(['release', '2.159.0']);
    expect(a.flags.get('draft-only')).toBe('1');
  });

  it('refuses an unknown option instead of guessing', () => {
    expect(() => parseArgs(['delete', 'x', '--yess'])).toThrow(/unknown option --yess/);
  });

  it('refuses a value flag with no value, or with the next flag as its value', () => {
    expect(() => parseArgs(['create', 'Foo', '--persona'])).toThrow(/--persona needs a value/);
    expect(() => parseArgs(['create', 'Foo', '--profile', '--no-telegram'])).toThrow(/--profile needs a value/);
  });

  it('takes --name=value, and treats everything after -- as positional', () => {
    const a = parseArgs(['tasks', 'x', 'add', 'n', '--every=30m', '--', '--not-a-flag']);
    expect(a.flags.get('every')).toBe('30m');
    expect(a.positional).toEqual(['tasks', 'x', 'add', 'n', '--not-a-flag']);
  });
});

describe('<agent> matching (audit: any id prefix matched)', () => {
  const list = [
    { id: 'a1b2c3d4-0000', name: 'Kitchen Helper', slug: 'kitchen-helper' },
    { id: 'abcdef00-1111', name: 'Ledger', slug: 'ledger' },
    { id: 'ffff0000-2222', name: 'abcd', slug: 'abcd-agent' },
  ];
  it('matches a name or slug exactly, then a name in any case', () => {
    expect(matchAgent(list, 'kitchen-helper').hit?.name).toBe('Kitchen Helper');
    expect(matchAgent(list, 'kitchen helper').hit?.name).toBe('Kitchen Helper');
  });
  it('never matches a 1–3 character id prefix', () => {
    expect(matchAgent(list, 'a').hit).toBeUndefined();
    expect(matchAgent(list, 'a1b').problem).toMatch(/at least 4 characters/);
    expect(matchAgent(list, 'a1b2').hit?.name).toBe('Kitchen Helper');
  });
  it('an exact name beats an id prefix that also fits', () => {
    expect(matchAgent(list, 'abcd').hit?.name).toBe('abcd');
  });
});

describe('the AI source create picks (audit: it took the first in the list)', () => {
  const profiles = [
    { id: 'p-local', name: 'Local Qwen', mine: true },
    { id: 'p-shared', name: 'Their Claude', mine: false },
    { id: 'p-default', name: 'Claude Max', mine: true, defaultSource: true },
  ];
  it('is the ⭐ default unless one is named', () => {
    expect(pickProfile(profiles).hit?.id).toBe('p-default');
    expect(pickProfile(profiles, 'local qwen').hit?.id).toBe('p-local');
    expect(pickProfile(profiles, 'p-shared').hit?.id).toBe('p-shared');
    expect(pickProfile(profiles, 'nope').problem).toMatch(/no AI source/);
  });
  it('without a default, one of your own before a shared one', () => {
    expect(pickProfile([profiles[1]!, profiles[0]!]).hit?.id).toBe('p-local');
  });
});

describe('tasks', () => {
  const tasks = [{ id: 'job-12345', name: 'Morning brief' }, { id: 'job-67890', name: 'Inbox' }];
  it('matches by id, name in any case, or a 4+ character id prefix', () => {
    expect(matchTask(tasks, 'job-67890').hit?.name).toBe('Inbox');
    expect(matchTask(tasks, 'morning brief').hit?.id).toBe('job-12345');
    expect(matchTask(tasks, 'job-1').hit?.id).toBe('job-12345');
    expect(matchTask(tasks, 'job-').problem).toMatch(/more than one/);
  });
  it('reads durations as people type them', () => {
    expect(durationMinutes('90s')).toBe(1.5);
    expect(durationMinutes('15m')).toBe(15);
    expect(durationMinutes('2h')).toBe(120);
    expect(durationMinutes('1d')).toBe(1440);
    expect(durationMinutes('30')).toBe(30);
    expect(durationMinutes('soon')).toBeUndefined();
  });
});

describe('--yes and its short forms', () => {
  it('-y, -f and --force all mean --yes: the y/N question of a destructive command is skipped', () => {
    for (const argv of [['kick', 'Ledger', 'u1', '--yes'], ['kick', 'Ledger', 'u1', '-y'], ['kick', 'Ledger', 'u1', '-f'], ['kick', 'Ledger', 'u1', '--force']]) {
      const r = parseArgs(argv);
      expect(r.flags.get('yes'), argv.join(' ')).toBe('1');
      expect(r.positional).toEqual(['kick', 'Ledger', 'u1']);
    }
  });
});

describe('the CLI config file holds a sign-in token (A068)', () => {
  it('is left 0600 even when it was already there and readable by everyone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-cli-config-'));
    try {
      const file = join(dir, 'env');
      writeFileSync(file, 'HATCHABOT_URL=http://hatchabot.example.org\n', { mode: 0o644 });
      chmodSync(file, 0o644);
      writeConfigValue('HATCHABOT_TOKEN', 'hatchabot_made-up-token', file);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, 'utf8')).toBe('HATCHABOT_URL=http://hatchabot.example.org\nHATCHABOT_TOKEN=hatchabot_made-up-token\n');
      expect(readdirSync(dir)).toEqual(['env']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('on/off flags never take a value (#85), and every flag the CLI reads is known (#84)', () => {
  it('refuses --force=false and --yes=false instead of skipping the question', () => {
    expect(() => parseArgs(['delete', 'Ledger', '--force=false'])).toThrow(/--force takes no value/);
    expect(() => parseArgs(['delete', 'Ledger', '--yes=false'])).toThrow(/--yes takes no value/);
  });
  it('takes the documented `reach on --invited-only`', () => {
    const a = parseArgs(['reach', 'on', '--invited-only']);
    expect(a.positional).toEqual(['reach', 'on']);
    expect(a.flags.get('invited-only')).toBe('1');
  });
  it('parses every --flag that src/cli.ts reads', () => {
    const src = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const read = new Set([...src.matchAll(/flags\.(?:has|get)\('([a-z-]+)'\)/g)].map((m) => m[1]!));
    expect(read.size).toBeGreaterThan(20);
    for (const f of read) {
      expect(() => parseArgs([`--${f}`, 'x']), `--${f}`).not.toThrow(/unknown option/);
    }
  });
});
