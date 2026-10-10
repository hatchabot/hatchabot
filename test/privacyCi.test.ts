import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { scriptEnv } from './helpers/scriptEnv.js';
// @ts-expect-error — a plain .mjs script, no types
import { checkWorkflow } from '../scripts/workflow-pins.mjs';

/**
 * The privacy check GitHub runs (scripts/privacy-ci.mjs) and the fingerprints
 * the owner's machine sends it (privacy-check.mjs --export-digests / --sync-ci),
 * against a made-up household: its own database and env file, a throwaway git
 * repo with hooks off, its own HOME (where the key is made), and a gh shim
 * that records what it was given. Nothing reaches GitHub or this machine's
 * install (--no-machine).
 */
const ROOT = join(__dirname, '..');
const CHECK = join(ROOT, 'scripts', 'privacy-check.mjs');
const CI = join(ROOT, 'scripts', 'privacy-ci.mjs');
const MADE_UP = 'made-up-secret-value-0002';
let dir: string, repo: string, db: string, env: string, bin: string;
const PATH = () => `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`;
const ZERO = '0'.repeat(40);

const check = (args: string[], extra: Record<string, string> = {}) => spawnSync('node', [CHECK, ...args, '--db', db, '--env', env, '--no-machine'], {
  cwd: repo, encoding: 'utf8', env: scriptEnv(dir, PATH(), extra),
});
/** The blob --export-digests makes for the made-up household. */
const exportBlob = () => {
  const out = join(dir, 'blob.json');
  const r = check(['--export-digests', '--out', out]);
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return readFileSync(out, 'utf8').trim();
};
const g = (...a: string[]) => {
  const r = spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: scriptEnv(dir, PATH()) });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
/** A commit as someone, with a message. */
const commitAs = (who: string, files: Record<string, string>, msg: string) => {
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), text); g('add', f); }
  const [, name, email] = /^(.*) <(.*)>$/.exec(who)!;
  g('-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-qm', msg, '--author', who);
  return g('rev-parse', 'HEAD');
};
const OWNER = 'Ada Owner <owner@example.org>';
/** privacy-ci.mjs for a pull request base...head (or a push), with the given secret. */
const ci = (blob: string | undefined, event: object, name = 'pull_request', extra: string[] = []) => {
  const ev = join(dir, 'event.json');
  writeFileSync(ev, JSON.stringify(event));
  return spawnSync('node', [CI, '--dir', repo, '--event', ev, '--event-name', name, ...extra], {
    cwd: dir, encoding: 'utf8', env: scriptEnv(dir, PATH(), blob === undefined ? {} : { PRIVACY_FINGERPRINTS: blob }),
  });
};
const pr = (base: string, head: string, title = 'A change', body = '') => ({ pull_request: { base: { sha: base }, head: { sha: head, ref: 'a-branch' }, title, body } });
const shown = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;
/** None of the made-up household's values, in any case, appears in what was printed. */
const masked = (r: { stdout: string; stderr: string }) => {
  for (const v of ['Mapleford Helper', 'mapleford-helper', 'someone@example.org', MADE_UP, 'Quillon', 'Varga', 'owner@example.org', 'Condo B']) expect(shown(r).toLowerCase()).not.toContain(v.toLowerCase());
};

let base: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-privacy-ci-test-'));
  repo = join(dir, 'repo'); bin = join(dir, 'bin');
  mkdirSync(bin);
  db = join(dir, 'hatchabot.sqlite');
  const d = new Database(db);
  d.exec(`create table agents (name text, slug text);
          create table accounts (email text, telegram_user_id text);
          create table memberships (channel_user_id text, display_name text);`);
  d.prepare('insert into agents values (?, ?)').run('Mapleford Helper', 'mapleford-helper');
  d.prepare('insert into agents values (?, ?)').run('Condo B', 'condo-b');
  d.prepare('insert into accounts values (?, ?)').run('someone@example.org', '987654321');
  d.prepare('insert into accounts values (?, ?)').run('owner@example.org', null);
  d.prepare('insert into memberships values (?, ?)').run('123456789012', 'Quillon Varga');
  d.close();
  env = join(dir, '.env');
  writeFileSync(env, `HATCHABOT_SECRET_KEY=${MADE_UP}\nHATCHABOT_AUTH=identity\n`);
  mkdirSync(repo);
  g('init', '-q', '-b', 'main');
  // main's history: the owner authors it, so their identity is already public there.
  base = commitAs(OWNER, { 'README.md': 'A project.\n' }, 'start');
  // gh: records its arguments and stdin; HB_GH=fail refuses; HB_GH_OUT is what `api` prints.
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(join(dir, 'gh-argv'))}\ncat > ${JSON.stringify(join(dir, 'gh-stdin'))}\n[ "$HB_GH" = fail ] && { echo "HTTP 403: Resource not accessible" >&2; exit 1; }\n[ "$1" = api ] && [ -n "$HB_GH_OUT" ] && cat "$HB_GH_OUT"\nexit 0\n`, { mode: 0o755 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('fingerprints: made on the owner\'s machine, read by CI', () => {
  it('holds no value, keeps one key (0600), and lists the word lengths', () => {
    const blob = exportBlob();
    for (const v of ['Mapleford', 'mapleford-helper', 'someone@example.org', MADE_UP, 'Quillon']) expect(blob).not.toContain(v);
    const j = JSON.parse(blob);
    expect(j.v).toBe(1);
    expect(j.lengths).toEqual([1, 2]);
    expect(Object.values(j.cats).sort().join('')).toMatch(/A/);
    const keyFile = join(dir, '.config', 'hatchabot', 'privacy-ci.key');
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(exportBlob()).key).toBe(j.key);
  });

  it('a pull request: a multi-word name, a slug, an email, a secret and a person, masked; the case rule holds', () => {
    const head = commitAs('Test <test@example.org>', {
      'notes.md': 'Today the Mapleford Helper agent did well.\nTest the condo board flow.\nCondo B is a name.\n',
      't.ts': `const a = 'mapleford-helper';\nconst b = 'someone@example.org';\nconst k = '${MADE_UP}';\n`,
    }, 'notes');
    const r = ci(exportBlob(), pr(base, head, 'Notes', 'Thanks to Quillon Varga.'));
    expect(r.status, shown(r)).toBe(1);
    expect(r.stdout).toContain("[A agent name] 'Ma…(16)' notes.md:1");
    expect(r.stdout).toContain("[A agent name] 'Co…(7)' notes.md:3");
    expect(r.stdout).not.toContain('notes.md:2');
    expect(r.stdout).toContain("[S agent slug] 'ma…(16)' t.ts:1");
    expect(r.stdout).toContain("[E email] 'so…(19)' t.ts:2");
    expect(r.stdout).toContain("[K secret] 'ma…(25)' t.ts:3");
    expect(r.stdout).toContain("[P person name] 'Qu…(13)' PR body:1");
    masked(r);
  });

  it('clean when nothing private is added; a slug inside a file name is found, and the path is not printed', () => {
    const head = commitAs('Test <test@example.org>', { 'docs/plain.md': 'The Budget Tracker example.\n' }, 'plain');
    const clean = ci(exportBlob(), pr(base, head));
    expect(clean.status, shown(clean)).toBe(0);
    expect(clean.stdout).toContain('✓ privacy: pull request clean');
    const named = commitAs('Test <test@example.org>', { 'docs/mapleford-helper.md': 'Mapleford Helper\n' }, 'named');
    const r = ci(exportBlob(), pr(base, named));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[S agent slug] 'ma…(16)' a changed file's name");
    expect(r.stdout).toContain("(a file whose name is private, 'ma…(16)'):1");
    masked(r);
  });

  it('commit messages and authors, and a push to main', () => {
    const head = commitAs('Quillon Varga <q@example.org>', { 'a.md': 'x\n' }, 'For the Mapleford Helper');
    const r = ci(exportBlob(), { before: base, after: head }, 'push');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\[A agent name\] 'Ma…\(16\)' commit message [0-9a-f]{7}:1/);
    expect(r.stdout).toMatch(/\[P person name\] 'Qu…\(13\)' commit [0-9a-f]{7} author\/committer/);
    masked(r);
  });

  it('a name broken across two lines is not matched (the text is read a line at a time)', () => {
    const head = commitAs('Test <test@example.org>', { 'wrap.md': 'the Mapleford\nHelper agent\n' }, 'wrap');
    expect(ci(exportBlob(), pr(base, head)).status).toBe(0);
  });
});

describe('the owner\'s identity (scripts/privacy-identity.txt)', () => {
  it('is not a finding as author or in a squash merge\'s Co-authored-by trailer; in a file it still is', () => {
    const head = commitAs(OWNER, { 'scripts/privacy-identity.txt': `# the maintainer\n${OWNER}\n`, 'a.md': 'x\n' },
      `A squash merge (#1)\n\n* one\n\n---------\n\nCo-authored-by: ${OWNER}\nSigned-off-by: ${OWNER}\n`);
    const ok = ci(exportBlob(), pr(base, head));
    expect(ok.status, shown(ok)).toBe(0);
    const inFile = commitAs(OWNER, { 'b.md': 'mail owner@example.org\n' }, 'b');
    const r = ci(exportBlob(), pr(base, inFile));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("[E email] 'ow…(17)' b.md:1");
  });

  it('a line no commit on the base carries allows nothing, and is itself checked', () => {
    const head = commitAs('Quillon Varga <someone@example.org>', { 'scripts/privacy-identity.txt': 'Quillon Varga <someone@example.org>\n' },
      'Co-authored-by: Quillon Varga <someone@example.org>');
    const r = ci(exportBlob(), pr(base, head));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('scripts/privacy-identity.txt:1');
    expect(r.stdout).toMatch(/commit message [0-9a-f]{7}:1/);
    expect(r.stdout).toContain('author/committer');
    masked(r);
  });
});

describe('incomplete is never a pass', () => {
  it('no secret (a fork\'s pull request), or a garbled one, exits 3', () => {
    const head = commitAs('Test <test@example.org>', { 'a.md': 'x\n' }, 'a');
    for (const blob of [undefined, '', 'not json', '{}', JSON.stringify({ v: 1, key: 'short', lengths: [1], exact: [], lower: [], cats: {} })]) {
      const r = ci(blob, pr(base, head));
      expect(r.status, String(blob)).toBe(3);
      expect(r.stdout).toContain('✗ privacy: incomplete');
    }
  });

  it('a range that is not in the checkout exits 3', () => {
    const r = ci(exportBlob(), pr('1'.repeat(40), base));
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('not in this checkout');
  });
});

describe('the daily watch (privacy-watch.yml)', () => {
  const watch = (blob: string, extra: Record<string, string>) => spawnSync('node', [CI, '--watch', '--repo', 'example/project'], {
    cwd: dir, encoding: 'utf8', env: scriptEnv(dir, PATH(), { PRIVACY_FINGERPRINTS: blob, ...extra }),
  });
  const now = new Date().toISOString();

  it('a private value in an issue or a release note fails, masked; clean passes; GitHub refusing is incomplete', () => {
    const blob = exportBlob();
    const out = join(dir, 'gh-out');
    writeFileSync(out, `${JSON.stringify({ w: 'issue #7', d: now, t: 'It stalls', b: 'Since Monday the\nMapleford Helper stalls.' })}\n`);
    const hit = watch(blob, { HB_GH_OUT: out });
    expect(hit.status, shown(hit)).toBe(1);
    expect(hit.stdout).toContain("[A agent name] 'Ma…(16)' issue #7 body:2");
    masked(hit);
    writeFileSync(out, `${JSON.stringify({ w: 'release v2.0.0', d: '2001-01-01T00:00:00Z', t: 'old', b: 'Mapleford Helper' })}\n${JSON.stringify({ w: 'issue #8', d: now, t: 'Fine', b: 'nothing private' })}\n`);
    const clean = watch(blob, { HB_GH_OUT: out });
    expect(clean.status, shown(clean)).toBe(0);
    expect(clean.stdout).toContain('✓ privacy watch');
    const refused = watch(blob, { HB_GH: 'fail' });
    expect(refused.status).toBe(3);
    expect(refused.stdout).toContain('GitHub did not answer');
  });
});

describe('--sync-ci', () => {
  it('hands the blob to gh on stdin, never in its arguments, and prints counts only', () => {
    const r = check(['--sync-ci', '--repo', 'example/project']);
    expect(r.status, shown(r)).toBe(0);
    const argv = readFileSync(join(dir, 'gh-argv'), 'utf8');
    // Two calls: the Actions copy, then Dependabot's (its pull requests see only Dependabot secrets).
    expect(argv.split('\n')).toEqual(['secret', 'set', 'PRIVACY_FINGERPRINTS', '--repo', 'example/project', '--app', 'actions', 'secret', 'set', 'PRIVACY_FINGERPRINTS', '--repo', 'example/project', '--app', 'dependabot', '']);
    const sent = JSON.parse(readFileSync(join(dir, 'gh-stdin'), 'utf8'));
    expect(sent.v).toBe(1);
    expect(argv).not.toContain(sent.key);
    expect(shown(r)).not.toContain(sent.key);
    expect(shown(r)).not.toContain(sent.exact[0]);
    expect(r.stdout).toMatch(/✓ PRIVACY_FINGERPRINTS set on example\/project \(Actions and Dependabot\): \d+ fingerprints/);
    masked(r);
  });

  it('refuses (exit 3) an install it cannot fully read, and never calls gh', () => {
    const r = spawnSync('node', [CHECK, '--sync-ci', '--repo', 'example/project', '--db', join(dir, 'none.sqlite'), '--env', env, '--no-machine'], {
      cwd: repo, encoding: 'utf8', env: scriptEnv(dir, PATH()),
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('not made');
    expect(existsSync(join(dir, 'gh-argv'))).toBe(false);
  });

  it('gh refusing is not a success', () => {
    expect(check(['--sync-ci', '--repo', 'example/project'], { HB_GH: 'fail' }).status).toBe(1);
  });

  it('the daily timer runs it (systemd --user, in a sandbox)', () => {
    writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(dir, 'systemctl.log'))}\n`, { mode: 0o755 });
    const r = spawnSync('bash', [join(ROOT, 'scripts', 'privacy-sync.sh'), '--install'], { encoding: 'utf8', env: scriptEnv(dir, PATH()) });
    expect(r.status, shown(r)).toBe(0);
    const units = join(dir, '.config', 'systemd', 'user');
    expect(readFileSync(join(units, 'hatchabot-privacy-sync.service'), 'utf8')).toMatch(/^ExecStart=.*scripts\/privacy-check\.mjs" --sync-ci$/m);
    expect(readFileSync(join(units, 'hatchabot-privacy-sync.timer'), 'utf8')).toContain('OnCalendar=daily');
    expect(readFileSync(join(dir, 'systemctl.log'), 'utf8')).toContain('--user enable --now hatchabot-privacy-sync.timer');
  });
});

describe('the workflows', () => {
  it('CI\'s privacy job and the watch pass the pin rules; the secret reaches only the scanner\'s step, through env', () => {
    for (const f of ['ci.yml', 'privacy-watch.yml']) expect(checkWorkflow(f, readFileSync(join(ROOT, '.github', 'workflows', f), 'utf8'))).toEqual([]);
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/\n {2}privacy:\n/);
    expect(ci.match(/secrets\.PRIVACY_FINGERPRINTS/g)).toHaveLength(1);
    expect(ci).toMatch(/ {10}PRIVACY_FINGERPRINTS: \$\{\{ secrets\.PRIVACY_FINGERPRINTS \}\}/);
    const watch = readFileSync(join(ROOT, '.github', 'workflows', 'privacy-watch.yml'), 'utf8');
    expect(watch).toMatch(/permissions:\n {2}contents: read\n {2}issues: read\n {2}pull-requests: read\n/);
    expect(watch).toContain('workflow_dispatch');
  });
});
