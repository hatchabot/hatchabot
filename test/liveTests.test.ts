import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — a plain .mjs script, no types
import { LIVE_TESTS, dueFor, readRuns, resultOf } from '../scripts/live.mjs';

/**
 * The live tests' register (scripts/live.mjs): every test names a script that
 * exists and a row in docs/live-tests.md, the record parses, and "due" means
 * what docs/live-tests.md says — checked in a throwaway git repository
 * (hooks off, no global config).
 */
type T = { name: string; cmd: string[]; area: string[]; onHold?: string };
const tests = LIVE_TESTS as T[];

describe('the register', () => {
  it('every live test runs a script that exists, and docs/live-tests.md has a row for it', () => {
    const doc = readFileSync('docs/live-tests.md', 'utf8');
    for (const t of tests) {
      expect(existsSync(t.cmd[1] ?? ''), `${t.name}: ${t.cmd[1]}`).toBe(true);
      expect(doc, t.name).toContain(`| \`${t.name}\` |`);
      expect(t.area.length, t.name).toBeGreaterThan(0);
    }
    const rows = [...doc.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    expect(rows.sort()).toEqual(tests.map((t) => t.name).sort());
  });

  it('the record parses, and every test it names is in the register', () => {
    const runs = readRuns(readFileSync('docs/live-test-runs.md', 'utf8'));
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(tests.map((t) => t.name)).toContain(r.test);
    expect(readRuns('| 2026-10-08 | x | maybe | v1 | 3 | |\n| not a row |')).toEqual([]);
  });
});

describe('when a live test is due', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  /** A repo with v1 → v2 (changes src/x.ts, the area) → v3 (changes elsewhere only). */
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'hb-live-')); dirs.push(dir);
    const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
    const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'src'));
    const commit = (file: string, body: string, tag: string) => { writeFileSync(join(dir, file), body); git('add', '.'); git('commit', '-q', '-m', tag); git('tag', tag); };
    commit('src/x.ts', 'one', 'v1');
    commit('src/x.ts', 'two', 'v2');
    commit('README.md', 'docs', 'v3');
    return dir;
  }
  const T1 = [{ name: 'alpha', cmd: ['node', 'a.mjs'], area: ['src/x.ts'] }];
  const run = (release: string, result = 'pass') => ({ date: '2026-10-08', test: 'alpha', result, release, minutes: 1, note: '' });

  it('never passed: due', () => {
    expect(dueFor('v1', [], T1, repo())).toEqual([{ test: 'alpha', why: expect.stringMatching(/never passed/) }]);
  });
  it('passed on this release: not due', () => {
    expect(dueFor('v2', [run('v2')], T1, repo())).toEqual([]);
  });
  it('its area changed since it passed: due, naming the files', () => {
    expect(dueFor('v2', [run('v1')], T1, repo())).toEqual([{ test: 'alpha', why: expect.stringMatching(/changed since it passed on v1: src\/x\.ts/) }]);
  });
  it('only files outside its area changed: not due', () => {
    expect(dueFor('v3', [run('v2')], T1, repo())).toEqual([]);
  });
  it('a failed or skipped run does not count; a pass on a LATER release does not cover an earlier one', () => {
    const r = repo();
    expect(dueFor('v2', [run('v1'), run('v2', 'fail'), run('v2', 'skip')], T1, r)[0]?.why).toMatch(/changed since it passed on v1/);
    expect(dueFor('v1', [run('v3')], T1, r)[0]?.why).toMatch(/never passed/);
  });
  it('a version bump in package.json is not a change; a dependency is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-live-pkg-')); dirs.push(dir);
    const env = { ...process.env, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
    const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    git('init', '-q', '-b', 'main');
    const pkg = (v: string, deps: Record<string, string>) => JSON.stringify({ name: 'x', version: v, dependencies: deps }, null, 2) + '\n';
    const commit = (body: string, tag: string) => { writeFileSync(join(dir, 'package.json'), body); git('add', '.'); git('commit', '-q', '-m', tag); git('tag', tag); };
    commit(pkg('1.0.0', { a: '1' }), 'v1');
    commit(pkg('1.0.1', { a: '1' }), 'v2');
    commit(pkg('1.0.2', { a: '2' }), 'v3');
    const T = [{ name: 'alpha', cmd: ['node', 'a.mjs'], area: ['package.json'] }];
    expect(dueFor('v2', [run('v1')], T, dir)).toEqual([]);
    expect(dueFor('v3', [run('v2')], T, dir)[0]?.why).toMatch(/package\.json/);
  });
  it('a test on hold is never due', () => {
    expect(dueFor('v1', [], [{ ...T1[0], onHold: 'Cloud is on hold' }], repo())).toEqual([]);
  });
});

describe('a run\'s result', () => {
  it('a test that had nothing to test is a skip, even in colour; a non-zero exit is a fail', () => {
    expect(resultOf(0, '\x1b[33mSKIP\x1b[0m: set HATCHABOT_SMOKE_BOT_TOKEN')).toBe('skip');
    expect(resultOf(0, 'SKIP: no runner')).toBe('skip');
    expect(resultOf(0, '✓ 14 passed (SKIPPED none)')).toBe('pass');
    expect(resultOf(0, 'all good')).toBe('pass');
    expect(resultOf(1, 'SKIP')).toBe('fail');
  });
});

