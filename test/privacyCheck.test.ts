import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

/**
 * scripts/privacy-check.mjs against a made-up household: a database with its
 * own agents and people, an env file with a made-up secret, and a throwaway
 * git repo (hooks off) with a bare "origin". It never reads this machine's
 * install or its tailnet (--no-machine, its own HOME, a tailscale shim). One
 * test of the record of machines seen before runs without --no-machine: it
 * reads this machine's host and IP names in memory only, and its text names
 * none of them.
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
const commit = (file: string, text: string | Buffer) => {
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

  it('finds a name split across a line break: wrapped text, a comment, a quote (2026-10-22)', () => {
    for (const text of [
      'Ask what the Mapleford\nHelper agent did.\n',
      '/**\n * Seen on Mapleford\n * Helper, 2026-09-24.\n */\n',
      '// the Mapleford\n// Helper agent\n',
      '> the Mapleford\n> Helper agent\n',
    ]) {
      const r = run(['--pre-push', 'origin', 'x'], commit('wrap.md', text));
      expect(r.status, text).toBe(1);
      expect(r.stderr).toContain("[agent name] 'Ma…(16)' wrap.md (commit");
      expect(r.stderr + r.stdout).not.toContain('Mapleford');
      sh('push', '-q', 'origin', 'main');                 // each case on its own
    }
    // Two line breaks (a paragraph between) is not one name.
    expect(run(['--pre-push', 'origin', 'x'], commit('wrap.md', 'Mapleford\n\nHelper\n')).status).toBe(0);
    // Only the second half new: a line added under an old one.
    commit('half.md', 'Ask what the Mapleford\nbot did.\n');
    sh('push', '-q', 'origin', 'main');
    const half = run(['--pre-push', 'origin', 'x'], commit('half.md', 'Ask what the Mapleford\nHelper did.\n'));
    expect(half.status).toBe(1);
    expect(half.stderr).toContain("[agent name] 'Ma…(16)' half.md (commit");
    // --text reads a file whole.
    writeFileSync(join(dir, 'notes.md'), 'release notes: the Mapleford\n  Helper fix\n');
    expect(run(['--text', join(dir, 'notes.md')]).status).toBe(1);
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

  it('reads the text inside a file git treats as binary: UTF-8 and UTF-16, both byte orders', () => {
    const name = 'Mapleford Helper';
    const utf16be = Buffer.from(name, 'utf16le').swap16();
    for (const [file, data] of [
      ['photo.jpg', Buffer.concat([Buffer.from([0xff, 0xd8, 0, 0, 1, 2]), Buffer.from(`Author: ${name}`), Buffer.from([0, 0, 3])])],
      ['notes.docx', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(name, 'utf16le'), Buffer.from([0, 0])])],
      ['old.doc', Buffer.concat([Buffer.from([0, 1]), utf16be, Buffer.from([0, 0])])],
    ] as const) {
      const r = run(['--pre-push', 'origin', 'x'], commit(file, data));
      expect(r.status, `${file}: ${r.stderr}`).toBe(1);
      expect(r.stderr).toContain(`${file} (commit`);
      expect(r.stderr).toContain('text inside a binary file');
      expect(r.stderr).not.toContain('Mapleford');
      sh('reset', '-q', '--hard', 'HEAD~1');
    }
    const clean = run(['--pre-push', 'origin', 'x'], commit('pixels.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0, 7, 9])));
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stderr).toContain('1 binary file(s) in this push read for the text inside them');
  });

  it('--text reads the text inside a binary file too', () => {
    const f = join(dir, 'notes.pdf');
    writeFileSync(f, Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('Made by Mapleford Helper'), Buffer.from([0])]));
    const r = run(['--text', f]);
    expect(r.status, r.stdout).toBe(1);
    expect(r.stdout).toContain('text inside a binary file');
  });

  it('says what it checked and what it never reads', () => {
    const line = commit('notes.md', 'nothing private\n');
    const r = run(['--pre-push', 'origin', 'x'], line);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain('not covered: pictures and compressed data inside binary files (no OCR, no unpacking)');
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
    const seen = join(dir, 'home', '.config', 'hatchabot', 'privacy-machines.json');
    const notes: string[] = [];
    tailnetValues(() => {}, notes, join(dir, 'no-such-tailscale'), seen);
    expect(notes).toEqual([expect.stringContaining('no record yet'), 'tailnet names (no tailscale command here)']);
    const shim = join(dir, 'tailscale-fails'); writeFileSync(shim, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failed: string[] = [];
    tailnetValues(() => {}, failed, shim, seen);
    expect(failed).toEqual([expect.stringContaining('no record yet'), 'tailnet names (tailscale status failed)']);
  });
});

describe('machine names seen before (HB-0504)', () => {
  // The publisher gates with the names of its last values sync; a peer gone from
  // the tailnet since was still one of them, and only the local check had lost it.
  // Invented names; a shim for tailscale; the record in the test's own folder.
  const shim = (peers: string[]) => {
    const f = join(dir, 'tailscale');
    const status = {
      MagicDNSSuffix: 'tail0example.ts.net',
      Self: { HostName: 'walnut-pantry', DNSName: 'walnut-pantry.tail0example.ts.net.', TailscaleIPs: ['100.64.0.1'] },
      Peer: Object.fromEntries(peers.map((p, i) => [`node${i}`, { HostName: p, DNSName: `${p}.tail0example.ts.net.`, TailscaleIPs: [`100.64.0.${i + 2}`] }])),
    };
    writeFileSync(f, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(status)}\nEOF\n`, { mode: 0o755 });
    return f;
  };
  const seenFile = () => join(dir, 'home', '.config', 'hatchabot', 'privacy-machines.json');
  const values = async (cmd: string, file = seenFile(), remember = true) => {
    // @ts-expect-error — a plain .mjs script
    const { tailnetValues } = await import('../scripts/privacy-check.mjs');
    const got = new Map<string, string>(); const notes: string[] = []; const gaps: string[] = [];
    tailnetValues((v: string, cat: string) => { if (v) got.set(v, cat); }, notes, cmd, file, { gaps, remember });
    return { got, notes, gaps };
  };
  const seed = (machine: string[]) => { mkdirSync(dirname(seenFile()), { recursive: true }); writeFileSync(seenFile(), JSON.stringify({ machine, tailnet: [] }), { mode: 0o600 }); };
  const home = () => join(dir, 'home');
  const binWith = (peers: string[]) => { const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true }); copyFileSync(shim(peers), join(bin, 'tailscale')); return bin; };
  /** The script itself, with this test's HOME and tailscale shim (no --no-machine: it reads the record). */
  const script = (args: string[], bin: string) => spawnSync('node', [SCRIPT, ...args, '--db', db, '--env', env], {
    cwd: repo, encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home() },
  });

  it('a peer tailscale no longer lists is still checked, from the record kept the run before', async () => {
    const first = await values(shim(['copper-kettle']));
    expect(first.got.get('copper-kettle')).toBe('machine');
    expect(first.got.get('copper-kettle.tail0example.ts.net')).toBe('machine');
    expect(first.notes).toEqual([expect.stringContaining('no record yet')]);
    expect(statSync(seenFile()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(seenFile())).mode & 0o077).toBe(0);
    // The peer has left the tailnet: tailscale lists only the machine itself.
    const later = await values(shim([]));
    expect(later.got.get('copper-kettle')).toBe('machine');
    expect(later.got.get('copper-kettle.tail0example.ts.net')).toBe('machine');
    expect(later.got.get('tail0example.ts.net')).toBe('tailnet');
    expect(later.notes).toEqual([]);
    // And with no tailscale at all, the names seen before still are.
    const none = await values(join(dir, 'no-such-tailscale'));
    expect(none.got.get('copper-kettle')).toBe('machine');
    expect(none.notes).toEqual(['tailnet names (no tailscale command here)']);
  });

  it('a new peer is added to the record, and nothing is dropped from it', async () => {
    await values(shim(['copper-kettle']));
    await values(shim(['linden-attic']));
    const record = JSON.parse(readFileSync(seenFile(), 'utf8'));
    expect(record.machine).toEqual(expect.arrayContaining(['walnut-pantry', 'copper-kettle', 'linden-attic', 'linden-attic.tail0example.ts.net']));
    expect(record.tailnet).toEqual(['tail0example.ts.net']);
  });

  it('a record that cannot be read makes the check incomplete, says how to fix it, and is left as it is', async () => {
    seed([]); writeFileSync(seenFile(), 'not json', { mode: 0o600 });
    const r = await values(shim(['copper-kettle']));
    expect(r.gaps).toEqual([expect.stringMatching(/privacy-machines\.json, is not the JSON this check writes: move it aside \(mv /)]);
    expect(r.got.get('copper-kettle')).toBe('machine'); // what tailscale lists now is still checked
    expect(readFileSync(seenFile(), 'utf8')).toBe('not json');
    expect([...r.gaps, ...r.notes].join(' ')).not.toContain(dir); // named from ~, no private path
    // The script: incomplete (3), never clean, until it is moved aside.
    const text = join(dir, 'ok.md'); writeFileSync(text, 'nothing here\n');
    const bin = binWith([]);
    const bad = script(['--text', text], bin);
    expect(bad.status, bad.stdout + bad.stderr).toBe(3);
    expect(bad.stdout).toContain('move it aside');
    renameSync(seenFile(), `${seenFile()}.bad`);
    expect(script(['--text', text], bin).status).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)('a record it may not read (EACCES) is a gap too', async () => {
    seed(['copper-kettle']); chmodSync(seenFile(), 0o000);
    try {
      const r = await values(shim([]));
      expect(r.gaps).toEqual([expect.stringMatching(/could not be read \(EACCES\): move it aside/)]);
    } finally { chmodSync(seenFile(), 0o600); }
    expect(JSON.parse(readFileSync(seenFile(), 'utf8')).machine).toEqual(['copper-kettle']);
  });

  it('--export-values (the publish kit\'s provider) carries the remembered names and never writes the record', () => {
    seed(['copper-kettle']);
    const before = readFileSync(seenFile(), 'utf8'); const mtime = statSync(seenFile()).mtimeMs;
    // tailscale lists a peer the record does not have: any other run would add it.
    const r = script(['--export-values'], binWith(['linden-attic']));
    expect(r.status).toBe(0);
    // Its output is the values themselves (this machine's among them): asked of, never shown.
    const given = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).value as string);
    expect(given.includes('copper-kettle')).toBe(true);
    expect(given.includes('linden-attic')).toBe(true);
    expect(readFileSync(seenFile(), 'utf8')).toBe(before);
    expect(statSync(seenFile()).mtimeMs).toBe(mtime);
    // With no record there, it makes none.
    rmSync(seenFile());
    expect(script(['--export-values'], binWith(['linden-attic'])).status).toBe(0);
    expect(existsSync(seenFile())).toBe(false);
  });

  it('read-only for the provider in the function too: remember false adds nothing', async () => {
    seed(['copper-kettle']);
    const r = await values(shim(['linden-attic']), seenFile(), false);
    expect(r.got.get('copper-kettle')).toBe('machine');
    expect(JSON.parse(readFileSync(seenFile(), 'utf8')).machine).toEqual(['copper-kettle']);
  });

  it('the folder is made the owner\'s alone, and a link planted at the temp file\'s name is not written through', async () => {
    mkdirSync(dirname(seenFile()), { recursive: true, mode: 0o775 });
    chmodSync(dirname(seenFile()), 0o775);
    const target = join(dir, 'elsewhere.txt'); writeFileSync(target, 'untouched\n');
    const tmp = `${seenFile()}.${process.pid}.tmp`;
    symlinkSync(target, tmp);
    const r = await values(shim(['copper-kettle']));
    expect(r.notes).toEqual([expect.stringContaining('no record yet')]);
    expect(statSync(dirname(seenFile())).mode & 0o777).toBe(0o700);
    expect(readFileSync(target, 'utf8')).toBe('untouched\n');
    expect(existsSync(tmp)).toBe(false);
    expect(lstatSync(seenFile()).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(seenFile(), 'utf8')).machine).toContain('copper-kettle');
  });

  it('a write that fails leaves no temp file and says so', async () => {
    // @ts-expect-error — a plain .mjs script
    const { writeSeen } = await import('../scripts/privacy-check.mjs');
    // The rename fails: where the record goes is a folder with something in it.
    mkdirSync(join(seenFile(), 'x'), { recursive: true });
    const notes: string[] = [];
    writeSeen(seenFile(), { machine: ['copper-kettle'], tailnet: [] }, notes);
    expect(notes).toEqual([expect.stringMatching(/not saved: (EISDIR|ENOTEMPTY|EEXIST); this run checked them all/)]);
    expect(readdirSync(dirname(seenFile()))).toEqual(['privacy-machines.json']); // no temp file left
  });

  it('a large record is said, with how to forget machines', async () => {
    seed(Array.from({ length: 201 }, (_, i) => `made-up-node-${i}`));
    const r = await values(shim([]));
    expect(r.notes).toEqual([expect.stringMatching(/holds 204 names, each a fingerprint.*forget the machines that are gone/)]);
  });

  it('--text names a remembered peer that tailscale no longer lists (the HB-0503 lines)', () => {
    const home = join(dir, 'home');
    const bin = join(dir, 'bin'); mkdirSync(bin, { recursive: true });
    const text = join(dir, 'notes.md'); writeFileSync(text, 'An example host: copper-kettle.local\n');
    const check = () => spawnSync('node', [SCRIPT, '--text', text, '--db', db, '--env', env], {
      cwd: repo, encoding: 'utf8', env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
    });
    copyFileSync(shim(['copper-kettle']), join(bin, 'tailscale'));
    const before = check();
    expect(before.status, before.stdout + before.stderr).toBe(1);
    copyFileSync(shim([]), join(bin, 'tailscale'));
    const after = check();
    expect(after.status, after.stdout + after.stderr).toBe(1);
    expect(after.stdout).toContain("[machine] 'co…(13)'");
    expect(after.stdout + after.stderr).not.toContain('copper-kettle');
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
    expect(r.stdout).toContain('not covered: pictures and compressed data inside binary files (no OCR, no unpacking)');
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
    // A release tag on it: a lightweight tag's message is that commit's (the v2.160.2 live run).
    g('tag', 'v2.0.1'); g('push', '-q', 'origin', 'v2.0.1');
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

describe('a value written another way is still found (HB-0070)', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  const textOf = (body: string) => { const f = join(dir, 'notes.md'); writeFileSync(f, `### Fixed\n${body}\n`); return run(['--text', f]); };

  it('a name with a typographic apostrophe, where the install has a plain one (and the other way round)', () => {
    const d = new Database(db);
    d.prepare('insert into memberships values (?, ?)').run('123456789013', "Ilse O'Rourke");
    d.prepare('insert into memberships values (?, ?)').run('123456789014', 'Bram D\u2019Souza');
    d.close();
    for (const body of ['Thanks to Ilse O\u2019Rourke.', 'Thanks to Ilse O\u02bcRourke.', "Thanks to Bram D'Souza."]) {
      const r = textOf(body);
      expect(r.status, body + r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(/\[person name\] '(Il|Br)…\(1[23]\)' .*notes\.md:2/);
      expect(r.stdout + r.stderr).not.toMatch(/Rourke|Souza/);
    }
  });

  it('percent-encoded, HTML-encoded and base64: found, masked, and marked how', () => {
    for (const [body, how] of [
      ['https://example.org/?a=Mapleford%20Helper', 'percent-encoded'],
      ['<b>Mapleford&#x20;Helper</b>', 'HTML-encoded'],
      [`blob ${b64('agent: Mapleford Helper')}`, 'base64'],
      [`key ${b64('made-up-secret-value-0001')}`, 'base64'],
    ] as const) {
      const r = textOf(body);
      expect(r.status, body + r.stdout + r.stderr).toBe(1);
      expect(r.stdout, body).toContain(`, ${how}] '`);
      expect(r.stdout, body).toContain('notes.md:2');
      expect(r.stdout + r.stderr).not.toContain('Mapleford');
    }
    const clean = textOf(`https://example.org/?a=Budget%20Tracker ${b64('Budget Tracker')} Budget&#32;Tracker`);
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    expect(clean.stdout).toContain('encodings other than percent, HTML and base64');
  });
});

describe('--export-values (the publish kit\'s provider, scripts/private-values)', () => {
  const lines = (out: string) => out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { cat: string; match: string; value: string });

  it('gives each value as a JSON line: names as written, the rest in any case; ignored words left out', () => {
    const r = run(['--export-values']);
    expect(r.status, r.stderr).toBe(0);
    const got = lines(r.stdout);
    expect(got).toContainEqual({ cat: 'agent name', match: 'exact', value: 'Mapleford Helper' });
    expect(got).toContainEqual({ cat: 'agent slug', match: 'lower', value: 'mapleford-helper' });
    expect(got).toContainEqual({ cat: 'email', match: 'lower', value: 'someone@example.org' });
    expect(got.find((v) => v.value === 'made-up-secret-value-0001')?.cat).toBe('secret');
    expect(got.map((v) => v.value)).not.toContain('Test');
    expect(r.stderr).toMatch(/✓ privacy values: \d+ given/);
  });

  it('an install it cannot fully read gives nothing (exit 3)', () => {
    const r = spawnSync('node', [SCRIPT, '--export-values', '--db', db, '--env', env, '--env', join(dir, 'missing.env'), '--no-machine'], {
      cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: dir },
    });
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('could not be fully read');
  });
});
