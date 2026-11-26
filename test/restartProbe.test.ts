import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scriptEnv, systemPathWithout } from './helpers/scriptEnv.js';

// scripts/restart.sh's health probe asks the listener as the service is
// configured (#225). Sandboxed: a temp HOME, and shims for systemctl,
// launchctl, uname, curl and sleep, so nothing reaches the real machine.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/**
 * A listener that takes the connection and never answers: curl waits for ever,
 * unless it was given a deadline (--max-time), which it then reaches (exit 28).
 */
const HANGS = 'case " $* " in *" --max-time "*) exit 28 ;; esac\nexec /bin/sleep 20\n';

/** Restart a fake install whose service answers only at `serving`, and FAKE_ALSO_SERVING if given (with the file `page` beside the install, when there is one); returns the URLs curl was asked for. */
function restart(env: string, serving: string, os = 'Linux', hangs = false, extra: Record<string, string> = {}, data = false, depsRc = 0, folder = '', setup?: (repo: string, home: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'hb-restart-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const repo = join(root, 'install'); mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'restart.sh'), readFileSync('scripts/restart.sh'), { mode: 0o755 });
  writeFileSync(join(repo, 'scripts', 'ensure-deps.sh'), `#!/usr/bin/env bash\nexit ${depsRc}\n`, { mode: 0o755 });
  writeFileSync(join(repo, '.env'), env);
  if (data) mkdirSync(join(repo, 'data'));
  if (folder) mkdirSync(join(repo, folder));
  setup?.(repo, home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const asked = join(root, 'curl.log');
  for (const tool of ['systemctl', 'launchctl', 'sleep', 'journalctl']) writeFileSync(join(bin, tool), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, 'node')); // .env read as the service reads it (env_named)
  writeFileSync(join(bin, 'uname'), `#!/usr/bin/env bash\necho ${os}\n`, { mode: 0o755 });
  // The last argument is the URL; only the listener's real address answers.
  const page = join(root, 'page');
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash\nurl="\${@: -1}"\necho "$* " >> ${JSON.stringify(asked)}\n${hangs ? HANGS : ''}[ "$url" = ${JSON.stringify(serving)} ] || [ "$url" = "\${FAKE_ALSO_SERVING:-}" ] || exit 1\n[ ! -f ${JSON.stringify(page)} ] || cat ${JSON.stringify(page)}\n`, { mode: 0o755 });
  const r = spawnSync('bash', [join(repo, 'scripts', 'restart.sh')], { encoding: 'utf8', env: { ...scriptEnv(home, `${bin}:/usr/bin:/bin`), ...extra }, timeout: 15_000 });
  let calls: string[] = [];
  try { calls = readFileSync(asked, 'utf8').trim().split('\n'); } catch { /* never called */ }
  return { status: r.status, out: r.stdout + r.stderr, calls, repo };
}

describe('scripts/restart.sh health probe (#225)', () => {
  it('asks a native-TLS listener over https', () => {
    const r = restart('HATCHABOT_SECRET_KEY=x\nPORT=8443\nHATCHABOT_TLS_CERT=/etc/hb/cert.pem\nHATCHABOT_TLS_KEY=/etc/hb/key.pem\n', 'https://localhost:8443/healthz');
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('up on https://localhost:8443');
    expect(r.calls).toHaveLength(1);
  });

  it('asks a listener bound to one address at that address', () => {
    expect(restart('PORT="9090"  # quoted, with a comment\nHATCHABOT_BIND=192.0.2.10\n', 'http://192.0.2.10:9090/healthz').status).toBe(0);
    expect(restart('HATCHABOT_BIND=fd00::10\n', 'http://[fd00::10]:8080/healthz').status).toBe(0);
  });

  it('a plain listener (TLS in front, or none) is still asked at http://localhost', () => {
    const r = restart('HATCHABOT_BIND=0.0.0.0\n', 'http://localhost:8080/healthz');
    expect(r.status, r.out).toBe(0);
  });

  it('reads a setting written with spaces around the =, as systemd does (audit, 2026-10-29)', () => {
    const r = restart('PORT = 9137\n  HATCHABOT_TLS_CERT =/etc/hb/cert.pem\nHATCHABOT_BIND= 192.0.2.10\n', 'https://192.0.2.10:9137/healthz');
    expect(r.status, r.out).toBe(0);
    expect(r.calls).toHaveLength(1);
  });

  it('on a Mac, .env is read as the launchd job reads it, with bash: PORT = 9137 sets nothing there (audit, 2026-10-29)', () => {
    // launchd-plist.sh sources .env with bash: the service listens on 8080.
    expect(restart('PORT = 9137\n', 'http://localhost:8080/healthz', 'Darwin').status).toBe(0);
    expect(restart('PORT=7000\nPORT= 9137\n', 'http://localhost:7000/healthz', 'Darwin').status).toBe(0);
    expect(restart('  PORT="9137"  # moved\n', 'http://localhost:9137/healthz', 'Darwin').status).toBe(0);
  });

  it('a listener that takes the connection and never answers: each request ends, and so does the wait (HB-0553)', () => {
    const r = restart('PORT=8080\n', 'http://localhost:8080/healthz', 'Linux', true);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain("isn't answering at http://localhost:8080");
    expect(r.calls.length).toBeGreaterThan(1);
    for (const c of r.calls) expect(c).toMatch(/--connect-timeout \d+ --max-time \d+ /);
  });

  it('a listener that does not answer still fails, naming where it was asked', () => {
    const r = restart('HATCHABOT_TLS_CERT=/etc/hb/cert.pem\n', 'nowhere');
    expect(r.status).toBe(1);
    expect(r.out).toContain("isn't answering at https://localhost:8080");
  });
});

describe('scripts/restart.sh asked only whether it serves (HATCHABOT_RESTART_PROBE, review of HB-1456)', () => {
  /** The release in the tree is 1.0.0; its listener's page is `page` (none: nothing written). */
  const serves = (page: string | null, pkg = true) => (repo: string) => {
    if (pkg) writeFileSync(join(repo, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
    if (page !== null) writeFileSync(join(dirname(repo), 'page'), page);
  };
  const PAGE = (v: string) => `<!doctype html><meta name="hatchabot-version" content="${v}"><!-- HATCHABOT_VERSION="${v}" -->\n`;

  it('restarts nothing, writes nothing in a record, and asks once: 0 serving, 1 not', () => {
    const d = mkdtempSync(join(tmpdir(), 'hb-record-')); dirs.push(d);
    const rec = join(d, 'upgrade.from'), kept = 'from v1.0.0\nto v1.1.0\nsays-started\nrestarted\nback\ntries 1\n';
    writeFileSync(rec, kept);
    // ensure-deps fails: a restart would stop there, before asking anything.
    const probe = { HATCHABOT_RESTART_PROBE: '1', HATCHABOT_RESTART_RECORD: rec, HATCHABOT_RESTART_BACK: '1' };
    const up = restart('PORT=9090\n', 'http://localhost:9090/', 'Linux', false, probe, false, 1, '', serves(PAGE('1.0.0')));
    expect(up.status, up.out).toBe(0);
    expect(up.calls).toHaveLength(1);
    expect(up.out).toBe('');
    const down = restart('PORT=9090\n', 'nowhere', 'Linux', false, probe, false, 1, '', serves(PAGE('1.0.0')));
    expect(down.status, down.out).toBe(1);
    expect(down.calls).toHaveLength(1);
    expect(readFileSync(rec, 'utf8')).toBe(kept);
  });

  it('serving is serving the release in the tree: another version answering, a listener with no version (a file server holding a healthz), or a package.json it cannot read is not (review of HB-1456)', () => {
    // It answers at /healthz too, as any listener there may.
    const probe = { HATCHABOT_RESTART_PROBE: '1', FAKE_ALSO_SERVING: 'http://localhost:9090/healthz' };
    const ask = (setup: (repo: string) => void) => restart('PORT=9090\n', 'http://localhost:9090/', 'Linux', false, probe, false, 0, '', setup);
    expect(ask(serves(PAGE('1.0.0'))).status).toBe(0);
    for (const [what, setup] of [
      ['the release left, still running', serves(PAGE('1.1.0'))],
      ['a plain file server', serves('ok\n')],
      ['nothing in the page', serves('')],
      ['no package.json', serves(PAGE('1.0.0'), false)],
    ] as const) {
      const r = ask(setup);
      expect(r.status, what).toBe(1);
      expect(r.calls, what).toHaveLength(1);
      expect(r.calls[0], what).toMatch(/ http:\/\/localhost:9090\/$/); // the page, which names the version
    }
  });
});

describe('scripts/restart.sh under an upgrade that rolls back (HB-0840)', () => {
  // The upgrade.sh that runs is the release's being left: one from before
  // v2.191.0 writes no note of the rollback, but the new release's restart.sh is
  // what failed, and it writes one.
  const UNDER_UPGRADE = { HATCHABOT_UPGRADE_COPY: '/nonexistent/upgrade-copy' };
  const markIn = (repo: string) => join(repo, 'data', 'hatchabot.sqlite.rolled-back');
  /** A bundle install of v2.192.0 that an older upgrade.sh is swapping in from v2.191.0: its record says where it is going. */
  const swappingIn = (to = 'v2.192.0') => (repo: string) => {
    writeFileSync(join(repo, 'BUNDLE.json'), '{"tag":"v2.192.0","sha":"made-up"}\n');
    writeFileSync(join(repo, '.swapping'), `from v2.191.0\nto ${to}\nstage /made/up\npins-recorded\n`);
  };

  it('a release that does not answer under an upgrade writes the time beside the database', () => {
    const r = restart('PORT=8080\n', 'nothing answers', 'Linux', false, UNDER_UPGRADE, true, 0, '', swappingIn());
    expect(r.status, r.out).toBe(1);
    expect(readFileSync(markIn(r.repo), 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
  });

  it('nothing is written by a restart that answers, nor by one that fails outside an upgrade', () => {
    const up = restart('PORT=8080\n', 'http://localhost:8080/healthz', 'Linux', false, UNDER_UPGRADE, true);
    expect(up.status, up.out).toBe(0);
    expect(existsSync(markIn(up.repo))).toBe(false);
    const alone = restart('PORT=8080\n', 'nothing answers', 'Linux', false, {}, true);
    expect(alone.status, alone.out).toBe(1);
    expect(existsSync(markIn(alone.repo))).toBe(false);
  });

  // An upgrade.sh from v2.192.0 on names its record and writes its own note
  // (review of HB-0840): restart.sh tells the record once the service manager
  // has restarted the service, and writes no note of its own.
  const record = () => { const d = mkdtempSync(join(tmpdir(), 'hb-record-')); dirs.push(d); const f = join(d, 'upgrade.from'); writeFileSync(f, 'from v1.0.0\nto v1.1.0\nsays-started\nrestarted\n'); return f; };
  const tail = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(3);

  it('onto the new release: `started` in the record once the service manager restarted it, and no note of its own, answering or not', () => {
    for (const serving of ['http://localhost:8080/healthz', 'nothing answers']) {
      const rec = record();
      const r = restart('PORT=8080\n', serving, 'Linux', false, { ...UNDER_UPGRADE, HATCHABOT_RESTART_RECORD: rec }, true);
      expect(r.status, r.out).toBe(serving === 'nothing answers' ? 1 : 0);
      expect(tail(rec)).toEqual(['restarted', 'started']);
      expect(existsSync(markIn(r.repo))).toBe(false);
    }
  });

  it('the restart back onto the release gone back to: `back` in the record, and never a note, even when it does not answer in time', () => {
    for (const extra of [{ HATCHABOT_RESTART_BACK: '1' }, { HATCHABOT_RESTART_BACK: '1', HATCHABOT_RESTART_RECORD: record() }] as Array<Record<string, string>>) {
      const r = restart('PORT=8080\n', 'nothing answers', 'Linux', false, { ...UNDER_UPGRADE, ...extra }, true);
      expect(r.status, r.out).toBe(1);
      if (extra.HATCHABOT_RESTART_RECORD) expect(tail(extra.HATCHABOT_RESTART_RECORD)).toEqual(['restarted', 'back']);
      expect(existsSync(markIn(r.repo))).toBe(false);
    }
  });

  it('stopped before the service manager restarted anything (ensure-deps failed): neither line, and no note, under any upgrade', () => {
    for (const extra of [{}, { HATCHABOT_RESTART_RECORD: record() }] as Array<Record<string, string>>) {
      const r = restart('PORT=8080\n', 'nothing answers', 'Linux', false, { ...UNDER_UPGRADE, ...extra }, true, 1);
      expect(r.status, r.out).not.toBe(0);
      if (extra.HATCHABOT_RESTART_RECORD) expect(tail(extra.HATCHABOT_RESTART_RECORD)).toEqual(['restarted']);
      expect(existsSync(markIn(r.repo))).toBe(false);
    }
  });

  it('the note goes beside the database .env names, read as the service reads it: systemd\'s rules on Linux, the launchd job\'s bash on a Mac (review of HB-0840)', () => {
    for (const os of ['Linux', 'Darwin']) {
      const r = restart('PORT=8080\nHATCHABOT_DB=My\\ Data/hb.sqlite\n', 'nothing answers', os, false, UNDER_UPGRADE, false, 0, 'My Data', swappingIn());
      expect(r.status, r.out).toBe(1);
      expect(readFileSync(join(r.repo, 'My Data', 'hb.sqlite.rolled-back'), 'utf8'), os).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n$/);
    }
  });

  it('only on a restart onto the release that upgrade is going to, by its record: never on an older upgrade.sh\'s repair that restarts the release gone back to (review of HB-0840)', () => {
    // A bundle install: the record is .swapping, the tree's release BUNDLE.json's.
    const onto = restart('PORT=8080\n', 'nothing answers', 'Linux', false, UNDER_UPGRADE, true, 0, '', swappingIn('v2.192.0'));
    expect(existsSync(markIn(onto.repo)), onto.out).toBe(true);
    for (const setup of [swappingIn('v2.191.0'), (repo: string) => writeFileSync(join(repo, 'BUNDLE.json'), '{"tag":"v2.192.0"}\n')]) {
      const r = restart('PORT=8080\n', 'nothing answers', 'Linux', false, UNDER_UPGRADE, true, 0, '', setup);
      expect(r.status, r.out).toBe(1);
      expect(existsSync(markIn(r.repo)), r.out).toBe(false);
    }
    // A git install: the record beside the upgrade's lock, against the tags on the commit checked out.
    // From v2.192.0 the owner named v2.191.0, cut off once restarted; v2.191.0's repair checks v2.192.0 out
    // again and restarts it with this restart.sh, which is slow to answer: the release gone back to.
    const git = (to: string) => (repo: string, home: string) => {
      const env = scriptEnv(home, '/usr/bin:/bin');
      for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'v2.192.0'], ['tag', 'v2.192.0']]) {
        const g = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' });
        expect(g.status, g.stderr).toBe(0);
      }
      const sum = spawnSync('sh', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', repo], { encoding: 'utf8' }).stdout.trim();
      const locks = join(home, '.local', 'state', 'hatchabot'); mkdirSync(locks, { recursive: true });
      writeFileSync(join(locks, `upgrade-${sum}.from`), `from ${to === 'v2.191.0' ? 'v2.192.0' : 'v2.191.0'}\nto ${to}\npins-recorded\nrestarted\n`);
    };
    for (const [to, written] of [['v2.191.0', false], ['v2.192.0', true]] as const) {
      const r = restart('PORT=8080\n', 'nothing answers', 'Linux', false, UNDER_UPGRADE, true, 0, '', git(to));
      expect(r.status, r.out).toBe(1);
      expect(existsSync(markIn(r.repo)), `to ${to}: ${r.out}`).toBe(written);
    }
  });

  it('a git record from an upgrade.sh of v2.171.0 and older says only `from`: the restart onto the release it went to writes the note, one on the release it left does not (HB-1455)', () => {
    // Two releases in a git install; that upgrade.sh wrote `from <release>` and `restarted`, and no `to`.
    const git = (from: string, at: string) => (repo: string, home: string) => {
      const env = scriptEnv(home, '/usr/bin:/bin');
      const g = (...args: string[]) => { const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0); return r.stdout.trim(); };
      g('init', '-q'); g('add', '-A'); g('commit', '-qm', 'v2.171.0'); g('tag', 'v2.171.0');
      writeFileSync(join(repo, 'VERSION'), 'v2.192.0\n'); g('add', '-A'); g('commit', '-qm', 'v2.192.0'); g('tag', 'v2.192.0');
      g('checkout', '-q', at);
      const sum = spawnSync('sh', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', repo], { encoding: 'utf8' }).stdout.trim();
      const locks = join(home, '.local', 'state', 'hatchabot'); mkdirSync(locks, { recursive: true });
      writeFileSync(join(locks, `upgrade-${sum}.from`), `from ${from === 'sha' ? g('rev-parse', '--short', 'v2.171.0') : from}\nrestarted\n`);
    };
    for (const [from, at, written] of [['v2.171.0', 'v2.192.0', true], ['sha', 'v2.192.0', true], ['v2.171.0', 'v2.171.0', false], ['made-up-ref', 'v2.192.0', false]] as const) {
      const r = restart('PORT=8080\n', 'nothing answers', 'Linux', false, UNDER_UPGRADE, true, 0, '', git(from, at));
      expect(r.status, r.out).toBe(1);
      expect(existsSync(markIn(r.repo)), `from ${from}, at ${at}: ${r.out}`).toBe(written);
    }
  });

  it('a .env it cannot read (no node, or one that fails) is said: the note goes beside the default database, and where it may not be (review of HB-0840)', () => {
    // mark_rolled_back as restart.sh has it, the same as scripts/upgrade-helpers.sh's (test/nightScripts.test.ts).
    const fns = ['mark_rolled_back', 'systemd_major', 'env_named', 'rolled_back_note'].map((name) => {
      const src = readFileSync('scripts/restart.sh', 'utf8');
      const at = src.indexOf(`\n${name}() {\n`);
      return src.slice(at + 1, src.indexOf('\n}\n', at) + 2);
    }).join('\n');
    const mark = (node: 'none' | 'fails' | 'works', env: string | undefined) => {
      const root = mkdtempSync(join(tmpdir(), 'hb-unread-')); dirs.push(root);
      const dir = join(root, 'install'); mkdirSync(join(dir, 'data'), { recursive: true }); mkdirSync(join(dir, 'elsewhere'));
      if (env !== undefined) writeFileSync(join(dir, '.env'), env);
      const bin = join(root, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
      if (node === 'fails') writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "made-up crash" >&2\nexit 1\n', { mode: 0o755 });
      if (node === 'works') symlinkSync(process.execPath, join(bin, 'node'));
      const sys = systemPathWithout(join(root, 'sysbin'), ['node', 'nodejs', 'uname']);
      const r = spawnSync('bash', ['-c', `set -euo pipefail\n${fns}\nmark_rolled_back "$1"`, '_', dir], { encoding: 'utf8', env: scriptEnv(join(root, 'home'), `${bin}:${sys}`) });
      return { r, dir, out: r.stdout + r.stderr };
    };
    for (const node of ['none', 'fails'] as const) {
      const { r, dir, out } = mark(node, 'HATCHABOT_DB=elsewhere/hb.sqlite\n');
      expect(r.status, out).toBe(0);
      expect(out, node).toContain(`Could not read ${dir}/.env to find the database (no node to read it with, or it failed), so this rollback is written down beside the one the service opens when .env names none, ${dir}/data/hatchabot.sqlite. If .env names another (HATCHABOT_DB), the next start may take up what the release left had still to do for its agents.`);
      expect(existsSync(join(dir, 'data', 'hatchabot.sqlite.rolled-back')), node).toBe(true);
    }
    // No .env: the service opens the default, and nothing is said.
    const bare = mark('none', undefined);
    expect(bare.out).toBe('');
    expect(existsSync(join(bare.dir, 'data', 'hatchabot.sqlite.rolled-back'))).toBe(true);
    // Read: beside the database it names, and nothing said.
    const read = mark('works', 'HATCHABOT_DB=elsewhere/hb.sqlite\n');
    expect(read.out).toBe('');
    expect(existsSync(join(read.dir, 'elsewhere', 'hb.sqlite.rolled-back'))).toBe(true);
  });

  it('never makes a record that is not there', () => {
    const gone = join(mkdtempSync(join(tmpdir(), 'hb-record-')), 'upgrade.from');
    dirs.push(dirname(gone));
    const r = restart('PORT=8080\n', 'http://localhost:8080/healthz', 'Linux', false, { ...UNDER_UPGRADE, HATCHABOT_RESTART_RECORD: gone }, true);
    expect(r.status, r.out).toBe(0);
    expect(existsSync(gone)).toBe(false);
  });
});
