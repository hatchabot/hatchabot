import { describe, expect, it } from 'vitest';
import { durationMinutes, matchAgent, matchTask, parseArgs, pickProfile } from '../src/cli.js';

describe('CLI flags (audit: unknown flags swallowed the next argument)', () => {
  it('knows its on/off flags, so they no longer eat what follows', () => {
    const a = parseArgs(['create', '--no-telegram', 'Foo', '--persona', 'helps']);
    expect(a.positional).toEqual(['create', 'Foo']);
    expect(a.flags.get('no-telegram')).toBe('1');
    expect(a.flags.get('persona')).toBe('helps');
    const b = parseArgs(['switch-source', '--rebuild', '--to', 'Claude']);
    expect(b.flags.get('to')).toBe('Claude');
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
    { id: 'abcdef00-1111', name: 'Tax', slug: 'tax' },
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
