import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * scripts/privacy-check.mjs against a made-up household: a database with its
 * own agents and people, an env file with a made-up secret, and a throwaway
 * git repo (hooks off) with a bare "origin". It never reads this machine's
 * install or its host, tailnet or IP values (--no-machine, its own HOME).
 */
const SCRIPT = join(__dirname, '..', 'scripts', 'privacy-check.mjs');
let dir: string, repo: string, db: string, env: string;

const run = (args: string[], input = '') => spawnSync('node', [SCRIPT, ...args, '--db', db, '--env', env, '--no-machine'], {
  cwd: repo, input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir },
});
const sh = (...a: string[]) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...a], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
/** Commit a file and return the pre-push line git would send for main. */
const commit = (file: string, text: string) => {
  writeFileSync(join(repo, file), text);
  sh('add', file); sh('commit', '-qm', `add ${file}`);
  return `refs/heads/main ${sh('rev-parse', 'HEAD')} refs/heads/main ${'0'.repeat(40)}\n`;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-privacy-test-'));
  repo = join(dir, 'repo');
  spawnSync('git', ['init', '-q', '--bare', join(dir, 'origin.git')]);
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  sh('remote', 'add', 'origin', join(dir, 'origin.git'));
  writeFileSync(join(repo, 'README.md'), 'A project.\n');
  sh('add', '.'); sh('commit', '-qm', 'start'); sh('push', '-q', 'origin', 'main');
  db = join(dir, 'hatchabot.sqlite');
  const d = new Database(db);
  d.exec(`create table agents (name text, slug text);
          create table accounts (email text, telegram_user_id text);
          create table memberships (channel_user_id text, display_name text);`);
  d.prepare('insert into agents values (?, ?)').run('Mapleford Helper', 'mapleford-helper');
  d.prepare('insert into agents values (?, ?)').run('Condo B', 'condo-b');
  d.prepare('insert into agents values (?, ?)').run('Test', 'test');
  d.prepare('insert into accounts values (?, ?)').run('someone@example.org', '987654321');
  d.prepare('insert into memberships values (?, ?)').run('123456789012', 'Quillon Varga');
  d.close();
  env = join(dir, '.env');
  writeFileSync(env, 'HATCHABOT_SECRET_KEY=made-up-secret-value-0001\nHATCHABOT_AUTH=identity\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the pre-push check', () => {
  it('blocks a push that adds a private name, and prints it masked', () => {
    const line = commit('notes.md', 'Today the Mapleford Helper agent did well.\n');
    const r = run(['--pre-push', 'origin', 'x'], line);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[agent name] 'Ma…(16)' notes.md");
    expect(r.stderr + r.stdout).not.toContain('Mapleford');
  });

  it('finds slugs, emails, ids and .env secrets, and never prints a secret', () => {
    const line = commit('t.ts', "const a = 'mapleford-helper';\nconst b = 'someone@example.org';\nconst c = '123456789012';\nconst k = 'made-up-secret-value-0001';\n");
    const r = run(['--pre-push', 'origin', 'x'], line);
    expect(r.status).toBe(1);
    for (const cat of ['agent slug', 'email', 'person id', 'secret']) expect(r.stderr).toContain(`[${cat}]`);
    expect(r.stderr).not.toContain('made-up-secret');
  });

  it('checks commit messages too', () => {
    writeFileSync(join(repo, 'a.md'), 'x\n'); sh('add', 'a.md'); sh('commit', '-qm', 'Fix for Quillon Varga');
    const r = run(['--pre-push', 'origin', 'x'], `refs/heads/main ${sh('rev-parse', 'HEAD')} refs/heads/main ${'0'.repeat(40)}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('message');
  });

  it('lets generic words and lower-case phrases through: "Test", "the condo board"', () => {
    const line = commit('doc.md', 'Test the condo board flow; HATCHABOT_AUTH=identity.\n');
    expect(run(['--pre-push', 'origin', 'x'], line).status).toBe(0);
  });

  it('only checks what the remote does not have yet', () => {
    commit('old.md', 'Mapleford Helper\n');
    sh('push', '-q', 'origin', 'main');
    const line = commit('new.md', 'nothing private\n');
    expect(run(['--pre-push', 'origin', 'x'], line).status).toBe(0);
  });

  it('lets a push through, with a warning, where there is no install to read (no database, no env file)', () => {
    const line = commit('notes.md', 'Mapleford Helper\n');
    const r = spawnSync('node', [SCRIPT, '--pre-push', 'origin', 'x', '--db', join(dir, 'none.sqlite'), '--env', join(dir, 'none.env'), '--no-machine'], { cwd: repo, input: line, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('not checked');
  });

  it('says what it checked and what it never reads', () => {
    const line = commit('notes.md', 'nothing private\n');
    const r = run(['--pre-push', 'origin', 'x'], line);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('not covered: binary files and images (no OCR)');
  });
});

describe('incomplete is never clean (audit issue #41)', () => {
  /** Run with a database path of the test's choosing, beside the env file. */
  const runDb = (dbPath: string, args: string[], input = '') => spawnSync('node', [SCRIPT, ...args, '--db', dbPath, '--env', env, '--no-machine'], {
    cwd: repo, input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir },
  });

  it('pre-push: a database that is not there, beside an env file that is, blocks the push (exit 3)', () => {
    const line = commit('notes.md', 'Mapleford Helper\n');
    const r = runDb(join(dir, 'none.sqlite'), ['--pre-push', 'origin', 'x'], line);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/incomplete: the database .* is not there/);
  });

  it('pre-push: a database without the agents table blocks the push', () => {
    const empty = join(dir, 'empty.sqlite');
    new Database(empty).close();
    const r = runDb(empty, ['--pre-push', 'origin', 'x'], commit('notes.md', 'Mapleford Helper\n'));
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('no readable agents table');
  });

  it('--text: a missing database, or a note file that cannot be read, is incomplete (exit 3), not clean', () => {
    writeFileSync(join(dir, 'ok.md'), 'nothing private\n');
    const noDb = runDb(join(dir, 'none.sqlite'), ['--text', join(dir, 'ok.md')]);
    expect(noDb.status).toBe(3);
    expect(noDb.stdout).toContain('incomplete');
    const noFile = run(['--text', join(dir, 'missing.md')]);
    expect(noFile.status).toBe(3);
    expect(noFile.stdout).toContain('could not be read');
  });

  it('an env file asked for and not there is incomplete', () => {
    writeFileSync(join(dir, 'ok.md'), 'nothing private\n');
    const r = spawnSync('node', [SCRIPT, '--text', join(dir, 'ok.md'), '--db', db, '--env', join(dir, 'gone.env'), '--no-machine'], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('the env file');
  });

  it('a missing tailscale command is said, not passed over (an optional tool)', async () => {
    // @ts-expect-error — a plain .mjs script
    const { tailnetValues } = await import('../scripts/privacy-check.mjs');
    const notes: string[] = [];
    tailnetValues(() => {}, notes, join(dir, 'no-such-tailscale'));
    expect(notes).toEqual(['tailnet names (no tailscale command here)']);
    const shim = join(dir, 'tailscale-fails'); writeFileSync(shim, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failed: string[] = [];
    tailnetValues(() => {}, failed, shim);
    expect(failed).toEqual(['tailnet names (tailscale status failed)']);
  });
});

describe('names, refs and identities, not only contents (audit issue #41)', () => {
  it('a file name', () => {
    const r = run(['--pre-push', 'origin', 'x'], commit('mapleford-helper.md', 'nothing private\n'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[agent slug\] 'ma…\(16\)' file name/);
  });

  it('a branch name being pushed', () => {
    commit('a.md', 'nothing private\n');
    const r = run(['--pre-push', 'origin', 'x'], `refs/heads/main ${sh('rev-parse', 'HEAD')} refs/heads/mapleford-helper ${'0'.repeat(40)}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('ref name');
  });

  it('a commit author, and an annotated tag\'s tagger', () => {
    writeFileSync(join(repo, 'a.md'), 'x\n'); sh('add', 'a.md');
    sh('-c', 'user.name=Quillon Varga', 'commit', '-qm', 'plain message');
    const byAuthor = run(['--pre-push', 'origin', 'x'], `refs/heads/main ${sh('rev-parse', 'HEAD')} refs/heads/main ${'0'.repeat(40)}\n`);
    expect(byAuthor.status).toBe(1);
    expect(byAuthor.stderr).toContain('author/committer');
    sh('push', '-q', 'origin', 'main');
    sh('-c', 'user.name=Quillon Varga', 'tag', '-a', 'v2.0.0', '-m', 'release');
    const byTagger = run(['--pre-push', 'origin', 'x'], `refs/tags/v2.0.0 ${sh('rev-parse', 'v2.0.0')} refs/tags/v2.0.0 ${'0'.repeat(40)}\n`);
    expect(byTagger.status).toBe(1);
    expect(byTagger.stderr).toContain('tagger');
  });

  it('the clone\'s own git identity is not a finding as author; the same value in a file still is', () => {
    sh('config', 'user.email', 'someone@example.org');
    writeFileSync(join(repo, 'a.md'), 'x\n'); sh('add', 'a.md');
    sh('-c', 'user.email=someone@example.org', 'commit', '-qm', 'mine');
    expect(run(['--pre-push', 'origin', 'x'], `refs/heads/main ${sh('rev-parse', 'HEAD')} refs/heads/main ${'0'.repeat(40)}\n`).status).toBe(0);
    const inFile = run(['--pre-push', 'origin', 'x'], commit('b.md', 'mail someone@example.org\n'));
    expect(inFile.status).toBe(1);
  });

  it('the owner\'s identity (scripts/privacy-identity.txt, already an author on the remote) is not a finding in a Co-authored-by trailer; others are (2026-10-10)', () => {
    // A commit by the owner is already on origin, so their identity is public there.
    writeFileSync(join(repo, 'a.md'), 'a\n'); sh('add', 'a.md');
    sh('-c', 'user.name=Quillon Varga', '-c', 'user.email=someone@example.org', 'commit', '-qm', 'by the owner', '--author', 'Quillon Varga <someone@example.org>');
    sh('push', '-q', 'origin', 'main');
    mkdirSync(join(repo, 'scripts'));
    writeFileSync(join(repo, 'scripts', 'privacy-identity.txt'), '# the maintainer\nQuillon Varga <someone@example.org>\n'); sh('add', 'scripts/privacy-identity.txt');
    sh('commit', '-qm', 'Fix a thing (#1)\n\n---------\n\nCo-authored-by: Quillon Varga <someone@example.org>\n');
    const ok = run(['--pre-push', 'origin', 'x'], `refs/heads/main ${sh('rev-parse', 'HEAD')} refs/heads/main ${'0'.repeat(40)}\n`);
    expect(ok.status, ok.stderr).toBe(0);
    sh('push', '-q', 'origin', 'main');
    // Not named in the file, or not yet an author on the remote: still a finding.
    writeFileSync(join(repo, 'b.md'), 'b\n'); sh('add', 'b.md');
    sh('commit', '-qm', 'Fix (#2)\n\nCo-authored-by: Mapleford Helper <helper@example.org>\n');
    expect(run(['--pre-push', 'origin', 'x'], `refs/heads/main ${sh('rev-parse', 'HEAD')} refs/heads/main ${'0'.repeat(40)}\n`).stderr).toContain('message');
  });
});

/**
 * --public and --check-hook read the checkout the script lives in, so these
 * run a copy of it inside a throwaway repo (its own origin, a gh shim, no
 * hooks run). Nothing reaches GitHub.
 */
describe('--public and the hook check (audit issues #40, #41)', () => {
  let work: string, bin: string;
  const REPO_ROOT = join(__dirname, '..');
  const g = (...a: string[]) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.org', ...a], { cwd: work, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const put = (file: string, text: string, msg = `add ${file}`) => { writeFileSync(join(work, file), text); g('add', file); g('commit', '-qm', msg); g('push', '-q', 'origin', 'main'); return g('rev-parse', 'HEAD'); };
  const pub = (args: string[], extra: Record<string, string> = {}) => spawnSync('node', [join(work, 'scripts', 'privacy-check.mjs'), ...args, '--db', db, '--env', env, '--no-machine'], {
    cwd: work, encoding: 'utf8',
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra },
  });
  const publicRun = (extra: Record<string, string> = {}, more: string[] = []) => pub(['--public', '--repo', 'example/project', ...more], extra);

  beforeEach(() => {
    work = join(dir, 'work'); bin = join(dir, 'bin');
    mkdirSync(join(work, 'scripts'), { recursive: true }); mkdirSync(bin);
    copyFileSync(join(REPO_ROOT, 'scripts', 'privacy-check.mjs'), join(work, 'scripts', 'privacy-check.mjs'));
    copyFileSync(join(REPO_ROOT, 'scripts', 'privacy-ci.mjs'), join(work, 'scripts', 'privacy-ci.mjs'));
    copyFileSync(join(REPO_ROOT, 'scripts', 'privacy-ignore.txt'), join(work, 'scripts', 'privacy-ignore.txt'));
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(work, 'node_modules'));
    writeFileSync(join(work, '.gitignore'), 'node_modules\nscripts\n'); // the copy names the made-up household's values in its comments
    spawnSync('git', ['init', '-q', '--bare', join(dir, 'public.git')]);
    g('init', '-q', '-b', 'main'); g('remote', 'add', 'origin', join(dir, 'public.git'));
    g('add', '.'); g('commit', '-qm', 'start'); g('push', '-q', 'origin', 'main');
    // gh: HB_GH=ok (default; prints HB_GH_TEXT), fail (GitHub refuses), missing.
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\ncase "$1" in\n  --version) [ "$HB_GH" = missing ] && exit 127; echo "gh version 0"; exit 0 ;;\n  api) [ "$HB_GH" = fail ] && { echo "HTTP 401: Bad credentials" >&2; exit 1; }; printf "%s\\n" "$HB_GH_TEXT"; exit 0 ;;\nesac\nexit 1\n', { mode: 0o755 });
  });

  it('clean: says so only for what it checked, with the accepted-history line and what is not covered', async () => {
    const r = publicRun();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/0 accepted historical commits/);
    expect(r.stdout).toContain('not covered: binary files and images (no OCR)');
    expect(r.stdout).toContain('✓ privacy: what was checked is clean');
    // @ts-expect-error — a plain .mjs script
    const { resultOf } = await import('../scripts/live.mjs');
    expect(resultOf(r.status, r.stdout)).toBe('pass');
  });

  it('GitHub not answering, or no gh, is incomplete (exit 3) — a failed live test, not a skip', async () => {
    // @ts-expect-error — a plain .mjs script
    const { resultOf } = await import('../scripts/live.mjs');
    const refused = publicRun({ HB_GH: 'fail' });
    expect(refused.status).toBe(3);
    expect(refused.stdout).toMatch(/incomplete: release notes: GitHub did not answer/);
    expect(resultOf(refused.status, refused.stdout)).toBe('fail');
    const none = publicRun({ HB_GH: 'missing' });
    expect(none.status).toBe(3);
    expect(none.stdout).toContain('no gh command here');
    const noRepo = pub(['--public']);
    expect(noRepo.status).toBe(3);
    expect(noRepo.stdout).toContain('is not a GitHub address');
  });

  it('a private value in release notes or issues is a finding', () => {
    const r = publicRun({ HB_GH_TEXT: 'v2.0.0\nRelease\nMapleford Helper is faster.' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('release notes');
  });

  it('accepted history is left out and counted; anything after it, and any file name, is checked', () => {
    put('old.md', 'Mapleford Helper\n');
    const base = put('old.md', 'scrubbed\n', 'scrub');
    const r = publicRun({}, ['--accepted-history', base]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('3 accepted historical commits not checked (retained by decision, docs/releasing.md)');
    put('later.md', 'Mapleford Helper again\n');
    expect(publicRun({}, ['--accepted-history', base]).status).toBe(1);
    g('rm', '-q', 'later.md'); put('mapleford-helper.txt', 'nothing private\n');
    const named = publicRun({}, ['--accepted-history', g('rev-parse', 'HEAD~1')]);
    expect(named.status).toBe(1);
    expect(named.stdout).toContain('file/folder names');
  });

  it('the owner\'s identity in a squash merge\'s Co-authored-by trailer is not a finding (2026-10-10)', () => {
    // The owner authors main's history; the identity file names them; their address is a private value.
    const d = new Database(db); d.prepare('insert into accounts values (?, ?)').run('owner@example.org', null); d.close();
    const owner = ['-c', 'user.name=Ada Owner', '-c', 'user.email=owner@example.org'];
    writeFileSync(join(work, 'a.md'), 'a\n'); g('add', 'a.md'); g(...owner, 'commit', '-qm', 'by the owner');
    writeFileSync(join(work, 'scripts', 'privacy-identity.txt'), '# the maintainer\nAda Owner <owner@example.org>\n');
    g('add', '-f', 'scripts/privacy-identity.txt');
    const squash = 'Fix a thing (#1)\n\n* one\n\n---------\n\nCo-authored-by: Ada Owner <owner@example.org>\n';
    g(...owner, 'commit', '-qm', squash); g('push', '-q', 'origin', 'main');
    const r = publicRun();
    expect(r.status, r.stdout).toBe(0);
    // Someone the file does not name, in the same trailer, still is.
    writeFileSync(join(work, 'b.md'), 'b\n'); g('add', 'b.md');
    g(...owner, 'commit', '-qm', 'Fix (#2)\n\nCo-authored-by: Quillon Varga <q@example.org>\n'); g('push', '-q', 'origin', 'main');
    expect(publicRun().stdout).toContain('commit messages');
  });

  it('--check-hook: not installed, installed, and through a core.hooksPath that hands on to it', () => {
    expect(pub(['--check-hook']).status).toBe(1);
    const missing = publicRun({}, ['--check-hook']);
    expect(missing.status).toBe(3);
    expect(missing.stdout).toContain('✗ pre-push hook');
    expect(pub(['--install-hook']).status).toBe(0);
    expect(pub(['--check-hook']).stdout).toContain('✓ pre-push hook');
    expect(publicRun({}, ['--check-hook']).status).toBe(0);
    // A machine-wide hook folder: counts only when its pre-push hands on to the repo's own hook.
    const shared = join(dir, 'shared-hooks'); mkdirSync(shared);
    g('config', 'core.hooksPath', shared);
    writeFileSync(join(shared, 'pre-push'), '#!/bin/sh\necho other checks\nexit 0\n', { mode: 0o755 });
    expect(pub(['--check-hook']).status).toBe(1);
    writeFileSync(join(shared, 'pre-push'), '#!/bin/sh\nown="$(git rev-parse --git-common-dir)/hooks/pre-push"\n[ -x "$own" ] && exec "$own" "$@"\nexit 0\n', { mode: 0o755 });
    const chained = pub(['--check-hook']);
    expect(chained.status, chained.stdout).toBe(0);
    expect(chained.stdout).toContain('hands on to');
    g('config', 'core.hooksPath', '/dev/null');
    expect(pub(['--check-hook']).stdout).toContain('hooks are off');
  });
});

describe('the tag guard', () => {
  it('refuses a v0.* tag, and a tag whose commit is not on main', () => {
    sh('tag', 'v0.9.0');
    const v0 = run(['--pre-push', 'origin', 'x'], `refs/tags/v0.9.0 ${sh('rev-parse', 'v0.9.0')} refs/tags/v0.9.0 ${'0'.repeat(40)}\n`);
    expect(v0.status).toBe(1);
    expect(v0.stderr).toContain('v0.9.0: a pre-1.0 tag');
    sh('checkout', '-q', '-b', 'side'); writeFileSync(join(repo, 's.md'), 's\n'); sh('add', 's.md'); sh('commit', '-qm', 'side'); sh('tag', 'v2.0.1'); sh('checkout', '-q', 'main');
    const off = run(['--pre-push', 'origin', 'x'], `refs/tags/v2.0.1 ${sh('rev-parse', 'v2.0.1')} refs/tags/v2.0.1 ${'0'.repeat(40)}\n`);
    expect(off.status).toBe(1);
    expect(off.stderr).toContain('not on main');
  });

  it('lets a release tag on main through', () => {
    sh('tag', 'v2.0.0');
    expect(run(['--pre-push', 'origin', 'x'], `refs/tags/v2.0.0 ${sh('rev-parse', 'v2.0.0')} refs/tags/v2.0.0 ${'0'.repeat(40)}\n`).status).toBe(0);
  });
});

describe('--text (release notes)', () => {
  it('passes clean notes and fails notes that name a private value', () => {
    writeFileSync(join(dir, 'ok.md'), '### Fixed\n- The Budget Tracker example works.\n');
    writeFileSync(join(dir, 'bad.md'), '### Fixed\n- Mapleford Helper no longer stalls.\n');
    expect(run(['--text', join(dir, 'ok.md')]).status).toBe(0);
    const bad = run(['--text', join(dir, 'bad.md')]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("'Ma…(16)'");
  });
});
