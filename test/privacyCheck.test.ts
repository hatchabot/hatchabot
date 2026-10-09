import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('lets a push through, with a warning, where there is no install to read', () => {
    const line = commit('notes.md', 'Mapleford Helper\n');
    const r = spawnSync('node', [SCRIPT, '--pre-push', 'origin', 'x', '--db', join(dir, 'none.sqlite'), '--env', env, '--no-machine'], { cwd: repo, input: line, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir } });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('not checked');
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
