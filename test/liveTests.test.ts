import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error — a plain .mjs script, no types
import { LIVE_TESTS, committedRuns, dueFor, readRuns, resultOf, touches } from '../scripts/live.mjs';

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
      // A test for every release (privacy) has no files of its own.
      if (!(t as { everyRelease?: boolean }).everyRelease) expect(t.area.length, t.name).toBeGreaterThan(0);
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
  it('a test for every release (privacy): due on each new one, whatever changed', () => {
    const every = [{ name: 'alpha', cmd: ['node', 'a.mjs'], area: [], everyRelease: true }];
    const dir = repo();
    expect(dueFor('v3', [run('v2')], every, dir)).toEqual([{ test: 'alpha', why: expect.stringMatching(/every release/) }]);
    expect(dueFor('v3', [run('v3')], every, dir)).toEqual([]);
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

type Area = Array<string | { path: string; near: RegExp }>;

/**
 * scripts/runner-scenarios.mjs against a fake install (an HTTP server here)
 * and a docker shim that only logs: no real docker, runner or install.
 */
describe('runner-scenarios.mjs in a sandbox (review, 2026-10-09)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  async function world(ping: (n: number) => object, onCreate?: (child: ReturnType<typeof spawn>) => void) {
    const root = mkdtempSync(join(tmpdir(), 'hb-runner-')); dirs.push(root);
    mkdirSync(join(root, 'bin'));
    const dockerLog = join(root, 'docker.log');
    writeFileSync(join(root, 'bin', 'docker'), `#!/bin/sh
echo "$*" >> '${dockerLog}'
case "$*" in
  *"image inspect hatchabot-runtime:latest"*) echo sha256:0000current00000000 ;;
  *"image inspect old-image:test"*) echo sha256:0000old000000000000 ;;
esac
exit 0
`, { mode: 0o755 });
    writeFileSync(join(root, 'bin', 'hbt'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    let pings = 0;
    let child: ReturnType<typeof spawn> | undefined;
    const server = createServer((req, res) => {
      const send = (body: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      const url = req.url ?? '';
      if (url === '/v1/hosts') return send([{ id: 'local', kind: 'local', name: 'This machine' }, { id: 'r1', kind: 'cloud', name: 'Test runner', settings: { dockerHost: 'ssh://runner.test' } }]);
      if (url === '/v1/agents' && req.method === 'GET') return send([]);
      if (url === '/v1/hosts/r1/ping') return send(ping(pings++));
      if (url === '/v1/ai-profiles') return send([{ id: 'p1', defaultSource: true }]);
      if (url === '/v1/agents' && req.method === 'POST') { onCreate?.(child!); return; } // never answers
      res.statusCode = 404; send({ error: 'not here' });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
      child = spawn(process.execPath, ['scripts/runner-scenarios.mjs', '--runner', 'Test runner', ...args], {
        env: { HOME: root, PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HATCHABOT_URL: `http://127.0.0.1:${port}`, HATCHABOT_TOKEN: 'x' },
      });
      let out = '';
      child.stdout!.on('data', (c) => { out += String(c); });
      child.stderr!.on('data', (c) => { out += String(c); });
      child.on('close', (code) => { server.close(); resolve({ code, out }); });
    });
    return { run, dockerLog: () => (existsSync(dockerLog) ? readFileSync(dockerLog, 'utf8') : '') };
  }

  it('--old-image: Ctrl-C points the runner\'s default image back before stopping', async () => {
    const w = await world(
      (n) => ({ reachable: true, hasImage: true, imageVersion: n === 0 ? '2026.9.8' : '2026.7.1', currentVersion: '2026.9.8' }),
      (child) => child.kill('SIGINT'),
    );
    const r = await w.run(['--old-image', 'old-image:test']);
    expect(r.code, r.out).toBe(130);
    const lines = w.dockerLog().split('\n').filter((l) => / tag /.test(l));
    expect(lines).toEqual(['-H ssh://runner.test tag old-image:test hatchabot-runtime:latest', '-H ssh://runner.test tag sha256:0000current00000000 hatchabot-runtime:latest']);
    expect(r.out).toMatch(/if this run is killed outright: docker -H ssh:\/\/runner\.test tag sha256:0000current00000000 hatchabot-runtime:latest/);
  }, 30_000);

  it('nothing to test (both phases skipped) is not a pass: it says SKIP and fails', async () => {
    const w = await world(() => ({ reachable: true, hasImage: true, imageVersion: '2026.9.6', currentVersion: '2026.9.8' }));
    const r = await w.run(['--no-image']);
    expect(r.out).toMatch(/SKIP phase A/);
    expect(r.out).toMatch(/SKIP phase B: Test runner is on 2026\.9\.6, this machine on 2026\.9\.8 \(--no-image\)/);
    expect(r.code).toBe(1);
    expect(resultOf(r.code, r.out)).toBe('fail');
  }, 30_000);
});

describe('review of 2026-10-09: when a test is due', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'hb-live2-')); dirs.push(dir);
    const env = { HOME: dir, PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' };
    const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: dir, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
    git('init', '-q', '-b', 'main');
    mkdirSync(join(dir, 'src', 'api'), { recursive: true }); mkdirSync(join(dir, 'docs'));
    const commit = (file: string, body: string, tag?: string) => { writeFileSync(join(dir, file), body); git('add', '.'); git('commit', '-q', '-m', tag ?? 'change'); if (tag) git('tag', tag); };
    return { dir, git, commit };
  }
  /** A routes file: two handlers, the first with its path on the line after `app.post(`. */
  const routes = (moveBody: string, otherBody: string) => [
    "import { x } from './x.js';",
    'export function registerRoutes(app) {',
    '  app.post<{ Params: { id: string } }>(',
    "    '/v1/agents/:id/move-host',",
    '    async (req, reply) => {',
    `      ${moveBody}`,
    '    });',
    "  app.get('/v1/agents/:id/other', async (req, reply) => {",
    `    ${otherBody}`,
    '  });',
    '}',
    '',
  ].join('\n');
  const T = [{ name: 'alpha', cmd: ['node', 'a.mjs'], area: ['src/a.ts', { path: 'src/api/routes.ts', near: /move-host/ }] }];
  const pass = (release: string) => ({ date: '2026-10-08', test: 'alpha', result: 'pass', release, minutes: 1, note: '' });

  it('a big shared file counts only where the test uses it: a change inside its route, not elsewhere', () => {
    const r = repo();
    r.commit('src/a.ts', 'a');
    r.commit('src/api/routes.ts', routes('return 1;', 'return 1;'), 'v1');
    r.commit('src/api/routes.ts', routes('return 1;', 'return 2;'), 'v2'); // the other route
    r.commit('src/api/routes.ts', routes('return 3;', 'return 2;'), 'v3'); // inside move-host, no route string on the line
    expect(dueFor('v2', [pass('v1')], T, r.dir)).toEqual([]);
    expect(dueFor('v3', [pass('v2')], T, r.dir)).toEqual([{ test: 'alpha', why: expect.stringMatching(/src\/api\/routes\.ts \(where it uses it\)/) }]);
    // A plain path in the same area still counts whole.
    r.commit('src/a.ts', 'b', 'v4');
    expect(dueFor('v4', [pass('v3')], T, r.dir)[0]?.why).toMatch(/src\/a\.ts/);
  });

  it('a test this machine cannot run is still due, marked manual — not left out', () => {
    const r = repo();
    r.commit('src/a.ts', 'a', 'v1');
    const X = [{ name: 'alpha', cmd: ['node', 'a.mjs'], area: ['src/a.ts'], arch: 'x64' }];
    expect(dueFor('v1', [], X, r.dir, 'arm64')).toEqual([{ test: 'alpha', why: expect.stringMatching(/never passed/), manual: expect.stringMatching(/x64 machine, not this one \(arm64\)/) }]);
    expect(dueFor('v1', [], X, r.dir, 'x64')[0]?.manual).toBeUndefined();
    expect(dueFor('v1', [pass('v1')], X, r.dir, 'arm64')).toEqual([]);
  });

  it('the gate reads the committed record: a row nobody committed does not count', () => {
    const r = repo();
    r.commit('docs/live-test-runs.md', '| Date | Test |\n', 'v1');
    writeFileSync(join(r.dir, 'docs', 'live-test-runs.md'), '| Date | Test |\n| 2026-10-08 | alpha | pass | v1 | 3 | |\n');
    expect(committedRuns(r.dir)).toEqual([]);
    r.git('commit', '-q', '-am', 'record');
    expect(committedRuns(r.dir)).toEqual([expect.objectContaining({ test: 'alpha', result: 'pass', release: 'v1' })]);
  });

  it('every path an area names exists (a typo there would make a test never due)', () => {
    for (const t of LIVE_TESTS as Array<{ name: string; area: Area }>) {
      for (const a of t.area) expect(existsSync(typeof a === 'string' ? a : a.path), `${t.name}: ${JSON.stringify(a)}`).toBe(true);
    }
  });

  it('in the real routes.ts, a change inside each test\'s route is found', () => {
    const src = readFileSync('src/api/routes.ts', 'utf8');
    // A git that serves the real file on both sides and a one-line change three lines below the route's path.
    const fake = (line: number) => (...a: string[]) => (a[0] === 'show'
      ? { status: 0, stdout: src }
      : { status: 0, stdout: `diff --git a/x b/x\n@@ -${line + 3} +${line + 3} @@\n-a\n+b\n` });
    for (const [route, test] of [['/v1/agents/:id/move-host', 'runner-scenarios'], ['/v1/agents/:id/clone', 'transfer'], ['/v1/agents/:id/app/rollback', 'apps'], ['/v1/agents/:id/browser', 'browser']] as const) {
      const line = src.split('\n').findIndex((l) => l.includes(`'${route}'`)) + 1;
      expect(line, route).toBeGreaterThan(0);
      const near = (LIVE_TESTS as Array<{ name: string; area: Area }>).find((t) => t.name === test)!.area
        .find((a): a is { path: string; near: RegExp } => typeof a !== 'string' && a.path === 'src/api/routes.ts')!.near;
      expect(touches(fake(line), 'a', 'b', 'src/api/routes.ts', near), route).toBe(true);
    }
  });
});

