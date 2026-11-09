import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hangingStep, scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * The channel timers and the production deploy, in a sandbox: a temp HOME, a
 * PATH of shims (systemctl, curl, a git that can be told to fail) and the
 * system dirs, hooks off, an environment built from scratch, and a throwaway
 * git origin standing in for GitHub (review, 2026-10-09):
 *  - follow-channel.sh / follow-latest.sh set a release aside only when it was
 *    tried and did not come up (exit 1); one whose install keeps failing is
 *    retried less and less often, then set aside;
 *  - deploy-release.sh restarts nothing when the install failed, installs
 *    through ensure-deps.sh, and a step that fails part-way puts prod back.
 */
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const lines = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);

describe('scripts/follow-channel.sh', () => {
  /**
   * An install whose release-target.sh says v1.1.0 and whose upgrade.sh exits with what rc.txt says.
   * `beside`: another install of the same user (same HOME), in the same root.
   */
  function world(beside?: { root: string; home: string }, name = 'app') {
    const root = beside?.root ?? mkdtempSync(join(tmpdir(), 'hb-follow-channel-')); if (!beside) dirs.push(root);
    const home = beside?.home ?? join(root, 'home'); mkdirSync(home, { recursive: true });
    const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true });
    // node and docker too: --install refuses without them, and on GitHub's runners
    // node is not in /usr/bin (setup-node's is under /opt/hostedtoolcache, HB-0379).
    for (const s of ['systemctl', 'node', 'docker']) writeFileSync(join(bin, s), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const app = join(root, name); mkdirSync(join(app, 'scripts'), { recursive: true });
    for (const f of ['follow-channel.sh', 'systemd-quote.sh', 'follow-tries.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    const asked = join(root, `${name}-asked.log`);
    writeFileSync(join(app, 'scripts', 'release-target.sh'), `#!/usr/bin/env bash\necho "$1" >> ${JSON.stringify(asked)}\necho v1.1.0\n`, { mode: 0o755 });
    const log = join(root, `${name}-upgrades.log`), rc = join(root, `${name}-rc.txt`);
    writeFileSync(join(app, 'scripts', 'upgrade.sh'), `#!/usr/bin/env bash\necho "upgrade $* timer=\${HATCHABOT_UPGRADE_BY_TIMER:-} target=\${HATCHABOT_UPGRADE_TARGET:-}" >> ${JSON.stringify(log)}\nexit "$(cat ${JSON.stringify(rc)})"\n`, { mode: 0o755 });
    const state = join(home, '.local', 'state', 'hatchabot');
    const follow = (...args: string[]) => spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), ...args], { encoding: 'utf8', env: scriptEnv(home, `${bin}:/usr/bin:/bin`) });
    const run = (code: number) => {
      writeFileSync(rc, String(code));
      return follow('stable');
    };
    // Its records are its own, keyed on its path as the upgrade lock is (audit #034).
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', app], { encoding: 'utf8' }).trim();
    return { root, home, run, follow, log, asked, state, tries: join(state, `follow-channel-tries-${key}`), failed: join(state, `follow-channel-failed-${key}`), channelFile: join(app, 'data', 'channel'), userChannelFile: join(home, '.config', 'hatchabot', 'channel') };
  }

  it('a bundle swap that was cut off with the new BUNDLE.json in is handed to upgrade.sh to repair, not taken as done (HB-0049)', () => {
    const w = world();
    const app = join(w.root, 'app');
    writeFileSync(join(app, 'BUNDLE.json'), JSON.stringify({ tag: 'v1.1.0' }) + '\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual([]); // on it already: nothing to do
    writeFileSync(join(app, '.swapping'), 'from v1.0.0\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual(['upgrade stable timer=1 target=v1.1.0']);
  });

  it('a git install\'s upgrade killed part-way, on the new release already, is handed to upgrade.sh to repair, not taken as done (HB-0266)', () => {
    const w = world();
    const app = join(w.root, 'app');
    const env = scriptEnv(w.home, '/usr/bin:/bin');
    const git = (...args: string[]) => execFileSync(REAL_GIT, args, { cwd: app, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'v1.1.0'); git('tag', 'v1.1.0');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual([]); // on it already: nothing to do
    // The record upgrade.sh keeps beside its lock while it changes the tree.
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', app], { encoding: 'utf8' }).trim();
    mkdirSync(w.state, { recursive: true }); writeFileSync(join(w.state, `upgrade-${key}.from`), 'from v1.0.0\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual(['upgrade stable timer=1 target=v1.1.0']);
    // A release set aside earlier: the repair still runs (it puts the earlier release back).
    writeFileSync(join(w.state, `follow-channel-failed-${key}`), 'v1.1.0\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual(['upgrade stable timer=1 target=v1.1.0', 'upgrade stable timer=1 target=v1.1.0']);
  });

  it('follows its own install\'s channel, not another install\'s choice; the user\'s one file only when it has none (HB-0235)', () => {
    const w = world();
    const other = world({ root: w.root, home: w.home }, 'other');
    expect(w.follow('--install', 'stable').status).toBe(0);
    // `hatchabot upgrade beta` in the other install: its own file.
    mkdirSync(dirname(other.channelFile), { recursive: true }); writeFileSync(other.channelFile, 'beta\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.asked)).toEqual(['stable']);
    // An install from before v2.169.0 knew only the user's file: read when this install has none.
    rmSync(w.channelFile);
    mkdirSync(dirname(w.userChannelFile), { recursive: true }); writeFileSync(w.userChannelFile, 'beta\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.asked)).toEqual(['stable', 'beta']);
  });

  it('asks upgrade.sh as the timer (so it leaves the chosen channel alone), for the release it resolved', () => {
    const w = world();
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual(['upgrade stable timer=1 target=v1.1.0']);
  });

  it('follows the channel chosen last, not the one the timer was installed with (audit #043)', () => {
    const w = world();
    const installed = w.follow('--install', 'stable');
    expect(installed.status, installed.stdout + installed.stderr).toBe(0);
    expect(readFileSync(w.channelFile, 'utf8').trim()).toBe('stable'); // --install remembers it, as `hatchabot upgrade stable` does
    // Found in the sandbox's own shims, not wherever this machine keeps them (HB-0379).
    const shims = join(w.root, 'bin');
    expect(readFileSync(join(w.home, '.config', 'systemd', 'user', 'hatchabot-follow-channel.service'), 'utf8')).toContain(`Environment="PATH=${shims}:${shims}:`);
    // `hatchabot upgrade beta` remembers beta (scripts/upgrade.sh); the timer still says stable.
    writeFileSync(w.channelFile, 'beta\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.asked)).toEqual(['beta']);
    expect(lines(w.log)).toEqual(['upgrade beta timer=1 target=v1.1.0']);
    // A version there is a pin: the timer leaves the machine alone, and asks nothing.
    writeFileSync(w.channelFile, 'v1.0.0\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.asked)).toEqual(['beta']);
    expect(lines(w.log)).toHaveLength(1);
  });

  it('a pinned install is left alone, but an upgrade killed part-way goes to upgrade.sh for the pinned release at the next tick (HB-0372)', () => {
    for (const cut of ['record', 'swap'] as const) {
      const w = world();
      const app = join(w.root, 'app');
      mkdirSync(dirname(w.channelFile), { recursive: true }); writeFileSync(w.channelFile, 'v1.0.0\n');
      expect(w.run(0).status).toBe(0);
      expect(lines(w.log)).toEqual([]);
      const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', app], { encoding: 'utf8' }).trim();
      if (cut === 'record') { mkdirSync(w.state, { recursive: true }); writeFileSync(join(w.state, `upgrade-${key}.from`), 'from v1.1.0\nto v1.0.0\n'); }
      else writeFileSync(join(app, '.swapping'), 'from v1.1.0\n');
      expect(w.run(0).status).toBe(0);
      expect(lines(w.log)).toEqual(['upgrade v1.0.0 timer=1 target=v1.0.0']);
      expect(lines(w.asked)).toEqual([]); // the pin is the release: no channel asked, no network needed
    }
  });

  it('a release that keeps failing to install is retried less and less often, then set aside', () => {
    const w = world();
    const first = w.run(3);
    expect(first.status).toBe(1);
    expect(first.stdout).toContain('tried again later (1 of 8)');
    expect(readFileSync(w.tries, 'utf8')).toMatch(/^v1\.1\.0 1 \d+\n$/);
    // Ten minutes later is too soon after the first failure? No: the first retry is the next tick.
    // Straight away is too soon.
    w.run(3);
    expect(lines(w.log)).toHaveLength(1);
    // Six minutes on: the next tick tries again; the wait then doubles.
    writeFileSync(w.tries, `v1.1.0 1 ${Math.floor(Date.now() / 1000) - 6 * 60}\n`);
    w.run(3);
    expect(lines(w.log)).toHaveLength(2);
    writeFileSync(w.tries, `v1.1.0 2 ${Math.floor(Date.now() / 1000) - 6 * 60}\n`);
    w.run(3);
    expect(lines(w.log)).toHaveLength(2); // 15 minutes now
    // The eighth failure in a row sets it aside, like a release that did not start.
    writeFileSync(w.tries, 'v1.1.0 7 0\n');
    const last = w.run(3);
    expect(last.stdout).toContain('did not complete 8 times in a row');
    expect(readFileSync(w.failed, 'utf8').trim()).toBe('v1.1.0');
    w.run(0);
    expect(lines(w.log)).toHaveLength(3); // not tried again
  });

  it('with no follow-tries.sh (a checkout cut off, a permission) the tick still reaches upgrade.sh, and says it counts nothing (fifth review of HB-0470)', () => {
    const w = world();
    rmSync(join(w.root, 'app', 'scripts', 'follow-tries.sh'));
    const first = w.run(3);
    expect(first.status, first.stdout + first.stderr).toBe(1);
    expect(first.stdout).toContain('this tick keeps no count of its tries');
    expect(w.run(3).status).toBe(1); // no wait: tried again
    expect(lines(w.log)).toEqual(['upgrade stable timer=1 target=v1.1.0', 'upgrade stable timer=1 target=v1.1.0']);
    expect(existsSync(w.tries)).toBe(false);
    expect(existsSync(w.failed)).toBe(false);
  });

  it('a full disk (exit 5) waits like a failure but never sets the release aside, nor counts towards it (HB-0470)', () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    writeFileSync(w.tries, 'v1.1.0 7 0\n'); // seven failures in a row: the eighth exit 3 would set it aside
    const full = w.run(5);
    expect(full.status).toBe(1);
    expect(full.stdout).toContain('does not count against v1.1.0');
    expect(existsSync(w.failed)).toBe(false);
    expect(readFileSync(w.tries, 'utf8')).toMatch(/^v1\.1\.0 8 \d+\n$/);
    expect(readFileSync(`${w.tries}.disk`, 'utf8')).toBe('v1.1.0 1\n'); // the disk's, counted beside the record (tenth review)
    // A disk that stays full for days: still not set aside, and the wait is a day at most.
    writeFileSync(w.tries, 'v1.1.0 30 0\n'); writeFileSync(`${w.tries}.disk`, 'v1.1.0 30\n');
    expect(w.run(5).status).toBe(1);
    expect(existsSync(w.failed)).toBe(false);
    // Once the disk is freed, a failure of the release's own is its first.
    writeFileSync(w.tries, 'v1.1.0 31 0\n'); writeFileSync(`${w.tries}.disk`, 'v1.1.0 31\n');
    const after = w.run(3);
    expect(after.stdout).toContain('tried again later (1 of 8)');
    expect(existsSync(w.failed)).toBe(false);
    expect(readFileSync(w.tries, 'utf8')).toMatch(/^v1\.1\.0 32 \d+\n$/);
    expect(readFileSync(`${w.tries}.disk`, 'utf8')).toBe('v1.1.0 31\n');
    expect(lines(w.log)).toHaveLength(3);
  });

  // A folder this user cannot write stands in for the full disk; root writes it anyway.
  it.skipIf(process.getuid?.() === 0)('a try that cannot be recorded on the full disk is said, and kept in the runtime folder so the next tick still waits (third review of HB-0470)', () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    const runtime = mkdtempSync(join(tmpdir(), 'hb-follow-runtime-')); dirs.push(runtime);
    const held = join(runtime, `hatchabot-follow-channel-tries-${w.tries.split('-').at(-1)}`);
    const app = join(w.root, 'app');
    const tick = (code: number, env: Record<string, string>) => {
      writeFileSync(join(w.root, 'app-rc.txt'), String(code));
      return spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), 'stable'], { encoding: 'utf8', env: scriptEnv(w.home, `${join(w.root, 'bin')}:/usr/bin:/bin`, env) });
    };
    execFileSync('chmod', ['555', w.state]);
    try {
      const r = tick(5, { XDG_RUNTIME_DIR: runtime });
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toContain('Could not record this try');
      expect(r.stdout).toContain('does not count against v1.1.0'); // the run went on to say it
      expect(readFileSync(held, 'utf8')).toMatch(/^v1\.1\.0 1 \d+\n$/);
      expect(readFileSync(`${held}.disk`, 'utf8')).toBe('v1.1.0 1\n');
      // The next tick waits, as it would on the record it could not write.
      expect(tick(5, { XDG_RUNTIME_DIR: runtime }).status).toBe(0);
      expect(lines(w.log)).toHaveLength(1);
      // With nowhere to keep it, it says so, and still ends as a failure, not silently.
      const nowhere = tick(5, {});
      expect(nowhere.status).toBe(1);
      expect(nowhere.stdout).toContain('so the next tick tries again');
    } finally {
      execFileSync('chmod', ['755', w.state]);
    }
    // Writable again: the record goes where it belongs, and the kept one goes.
    writeFileSync(held, 'v1.1.0 1 0\n'); writeFileSync(`${held}.disk`, 'v1.1.0 1\n');
    expect(tick(5, { XDG_RUNTIME_DIR: runtime }).status).toBe(1);
    expect(readFileSync(w.tries, 'utf8')).toMatch(/^v1\.1\.0 2 \d+\n$/);
    expect(readFileSync(`${w.tries}.disk`, 'utf8')).toBe('v1.1.0 2\n');
    expect(existsSync(held)).toBe(false);
    expect(existsSync(`${held}.disk`)).toBe(false);
  });

  // A folder this user cannot write stands in for the full disk.
  it.skipIf(process.getuid?.() === 0)('a set-aside it cannot write still counts the try, and the next tick waits: set -e no longer ends the tick first (thirteenth review)', () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    const app = join(w.root, 'app');
    const runtime = mkdtempSync(join(tmpdir(), 'hb-follow-runtime-')); dirs.push(runtime);
    const tick = (code: number) => {
      writeFileSync(join(w.root, 'app-rc.txt'), String(code));
      return spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), 'stable'], { encoding: 'utf8', env: scriptEnv(w.home, `${join(w.root, 'bin')}:/usr/bin:/bin`, { XDG_RUNTIME_DIR: runtime }) });
    };
    for (const [code, said] of [[3, 'Upgrading to v1.1.0 did not complete 8 times in a row.'], [1, 'Upgrading to v1.1.0 failed and was rolled back.']] as const) {
      execFileSync('chmod', ['755', w.state]);
      writeFileSync(w.tries, 'v1.1.0 7 0\n'); // seven of its own: the eighth sets it aside
      for (const f of readdirSync(runtime)) rmSync(join(runtime, f));
      const before = lines(w.log).length;
      execFileSync('chmod', ['555', w.state]);
      try {
        const r = tick(code);
        expect(r.status, r.stdout + r.stderr).toBe(1);
        expect(r.stdout).toContain(`${said} Could not write ${w.failed} to set v1.1.0 aside (a full disk?): this try is counted instead, so the next ones wait.`);
        expect(r.stdout).toContain('kept in');
        expect(existsSync(w.failed)).toBe(false);
        // The next tick waits: the upgrade is not run again at once.
        expect(tick(code).status).toBe(0);
        expect(lines(w.log)).toHaveLength(before + 1);
      } finally { execFileSync('chmod', ['755', w.state]); }
    }
    // With room again, the tick after the wait sets it aside, whole.
    for (const f of readdirSync(runtime)) rmSync(join(runtime, f));
    writeFileSync(w.tries, 'v1.1.0 8 0\n');
    expect(tick(3).stdout).toContain('did not complete 8 times in a row. It will not be retried');
    expect(readFileSync(w.failed, 'utf8')).toBe('v1.1.0\n');
    expect(existsSync(`${w.failed}.tmp`)).toBe(false);
  });

  it('the two timers keep one set_aside (thirteenth review)', () => {
    const fn = (f: string) => { const t = readFileSync(join('scripts', f), 'utf8'); const at = t.indexOf('# set_aside RELEASE'); expect(at, f).toBeGreaterThan(0); return t.slice(at, t.indexOf('\n}\n', at)); };
    expect(fn('follow-latest.sh')).toBe(fn('follow-channel.sh'));
  });

  // As above, a folder this user cannot write stands in for the full disk.
  it.skipIf(process.getuid?.() === 0)('a try is kept meanwhile only in the user\'s own runtime folder: never TMPDIR, never through a symlink (fourth review of HB-0470)', () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    const app = join(w.root, 'app');
    const name = `hatchabot-follow-channel-tries-${w.tries.split('-').at(-1)}`;
    const tick = (env: Record<string, string>) => {
      writeFileSync(join(w.root, 'app-rc.txt'), '5');
      return spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), 'stable'], { encoding: 'utf8', env: scriptEnv(w.home, `${join(w.root, 'bin')}:/usr/bin:/bin`, env) });
    };
    const shared = mkdtempSync(join(tmpdir(), 'hb-follow-shared-')); dirs.push(shared);
    const runtime = mkdtempSync(join(tmpdir(), 'hb-follow-runtime-')); dirs.push(runtime);
    const victim = join(shared, 'someone-elses-file');
    writeFileSync(victim, 'left alone\n');
    execFileSync('chmod', ['555', w.state]);
    try {
      // A shared TMPDIR, with no runtime folder: nothing kept there.
      const tmp = tick({ TMPDIR: shared });
      expect(tmp.status, tmp.stdout + tmp.stderr).toBe(1);
      expect(tmp.stdout).toContain('so the next tick tries again');
      expect(readdirSync(shared)).toEqual(['someone-elses-file']);
      // A link planted where the try is kept: not written through, and not read.
      symlinkSync(victim, join(runtime, name));
      const linked = tick({ XDG_RUNTIME_DIR: runtime });
      expect(linked.status, linked.stdout + linked.stderr).toBe(1);
      expect(linked.stdout).toContain('so the next tick tries again');
      expect(readFileSync(victim, 'utf8')).toBe('left alone\n');
      writeFileSync(victim, `v1.1.0 3 ${Math.floor(Date.now() / 1000)}\n`); // a record that would make it wait
      expect(tick({ XDG_RUNTIME_DIR: runtime }).status).toBe(1); // it ran
      expect(lines(w.log)).toHaveLength(3);
      // A runtime folder that is itself a link is not the user's own.
      rmSync(join(runtime, name));
      const alias = join(w.root, 'runtime-link'); symlinkSync(shared, alias);
      expect(tick({ XDG_RUNTIME_DIR: alias }).stdout).toContain('so the next tick tries again');
      expect(readdirSync(shared)).toEqual(['someone-elses-file']);
    } finally {
      execFileSync('chmod', ['755', w.state]);
    }
  });

  it('a disk full for months: the wait stays an hour, however large the count (review of HB-0470, twelfth review)', () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    const ago = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;
    // From 64 on, 1 << (count - 1) wrapped: a wait of -5 minutes at 64, 5 at 65, a try every tick.
    // And the disk's tries drove the doubling: after nine, a day's wait (twelfth review).
    let tried = 0;
    for (const count of [9, 63, 64, 65, 100, 1000]) {
      writeFileSync(w.tries, `v1.1.0 ${count} ${ago(30)}\n`); writeFileSync(`${w.tries}.disk`, `v1.1.0 ${count}\n`);
      const r = w.run(5);
      expect(r.status, `${count}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(lines(w.log), String(count)).toHaveLength(tried);
      // An hour on, it is tried.
      writeFileSync(w.tries, `v1.1.0 ${count} ${ago(60)}\n`); writeFileSync(`${w.tries}.disk`, `v1.1.0 ${count}\n`);
      expect(w.run(5).status, String(count)).toBe(1);
      expect(lines(w.log), String(count)).toHaveLength(++tried);
    }
  });

  it('the wait doubles by the release\'s own tries, not the disk\'s: 9 disk and 3 of its own wait 35 minutes (twelfth review)', () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    const ago = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;
    writeFileSync(w.tries, `v1.1.0 12 ${ago(30)}\n`); writeFileSync(`${w.tries}.disk`, 'v1.1.0 9\n');
    expect(w.run(3).status).toBe(0);
    expect(lines(w.log)).toEqual([]);
    writeFileSync(w.tries, `v1.1.0 12 ${ago(40)}\n`); writeFileSync(`${w.tries}.disk`, 'v1.1.0 9\n');
    w.run(3);
    expect(lines(w.log)).toHaveLength(1);
    // With the disk's left over from another release, every try is its own: 12 of them wait the day.
    writeFileSync(w.tries, `v1.1.0 12 ${ago(120)}\n`); writeFileSync(`${w.tries}.disk`, 'v1.0.9 9\n');
    expect(w.run(3).status).toBe(0);
    expect(lines(w.log)).toHaveLength(1);
  });

  it('offline, an upgrade cut off part-way is still repaired from what is here, and nothing is counted (HB-0547)', () => {
    const w = world();
    const app = join(w.root, 'app');
    const log = join(w.root, 'repair.log');
    writeFileSync(join(app, 'scripts', 'release-target.sh'), '#!/usr/bin/env bash\necho "no network" >&2\nexit 9\n', { mode: 0o755 });
    writeFileSync(join(app, 'scripts', 'upgrade.sh'), `#!/usr/bin/env bash\necho "upgrade $* timer=\${HATCHABOT_UPGRADE_BY_TIMER:-} repair=\${HATCHABOT_UPGRADE_REPAIR_ONLY:-} target=\${HATCHABOT_UPGRADE_TARGET:-}" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
    expect(w.run(0).status).toBe(0);
    expect(lines(log)).toEqual([]); // nothing to repair: offline is a quiet tick
    writeFileSync(join(app, '.swapping'), 'from v1.0.0\nto v1.1.0\nin scripts\n');
    const r = w.run(0);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('only the upgrade that was cut off is repaired');
    expect(lines(log)).toEqual(['upgrade stable timer=1 repair=1 target=']);
    expect(existsSync(w.tries)).toBe(false);
    expect(existsSync(w.failed)).toBe(false);
  });

  it('only exit 1 — tried and rolled back — sets a release aside at once; 2 and 4 are tried again next time', () => {
    for (const code of [2, 4]) {
      const w = world();
      w.run(code); w.run(code);
      expect(lines(w.log)).toHaveLength(2);
      expect(existsSync(w.failed)).toBe(false);
    }
    const w = world();
    w.run(1);
    expect(readFileSync(w.failed, 'utf8').trim()).toBe('v1.1.0');
  });

  it('the try record keeps three fields (tenth review), as the timers of releases before read it; the disk\'s count is beside it', () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    // An older timer's reader (follow-channel.sh and follow-latest.sh before follow-tries.sh), as it was.
    const older = (file: string) => spawnSync('bash', ['-c', 'T_TARGET=""; T_COUNT=0; T_LAST=0\n{ read -r T_TARGET T_COUNT T_LAST < "$1"; } 2>/dev/null || true\ncase "${T_COUNT:-}${T_LAST:-}" in \'\'|*[!0-9]*) T_COUNT=0; T_LAST=0 ;; esac\necho "$T_TARGET $T_COUNT"', '_', file], { encoding: 'utf8' }).stdout.trim();
    expect(w.run(5).status).toBe(1);
    expect(older(w.tries)).toBe('v1.1.0 1');
    writeFileSync(w.tries, 'v1.1.0 3 0\n'); writeFileSync(`${w.tries}.disk`, 'v1.1.0 3\n');
    expect(w.run(5).status).toBe(1);
    expect(older(w.tries)).toBe('v1.1.0 4');
    expect(readFileSync(`${w.tries}.disk`, 'utf8')).toBe('v1.1.0 4\n');
    // An older timer counted on without the count beside it, or it names another release: never more than the failures.
    writeFileSync(w.tries, 'v1.1.0 7 0\n'); writeFileSync(`${w.tries}.disk`, 'v1.0.9 7\n');
    expect(w.run(3).stdout).toContain('did not complete 8 times in a row');
    // The release set aside: both go.
    expect(existsSync(w.tries)).toBe(false);
    expect(existsSync(`${w.tries}.disk`)).toBe(false);
  });

  it('4, another upgrade holding the lock, is routine on both paths: the tick ends 0 and counts nothing; 5 ends 1 and is never counted against the release (ninth review)', () => {
    const w = world();
    const busy = w.run(4);
    expect(busy.status, busy.stdout + busy.stderr).toBe(0);
    expect(busy.stdout).toContain('Another upgrade of');
    expect(existsSync(w.tries)).toBe(false);
    expect(existsSync(w.failed)).toBe(false);
    const full = w.run(5);
    expect(full.status, full.stdout + full.stderr).toBe(1);
    expect(full.stdout).toContain('does not count against v1.1.0');
    expect(readFileSync(w.tries, 'utf8')).toMatch(/^v1\.1\.0 1 \d+\n$/); // a disk try: waited on, not counted against it
    expect(readFileSync(`${w.tries}.disk`, 'utf8')).toBe('v1.1.0 1\n');
    // Offline, with a cut-off upgrade to repair: the same.
    const v = world();
    const app = join(v.root, 'app');
    const rc = join(v.root, 'repair-rc.txt');
    writeFileSync(join(app, 'scripts', 'release-target.sh'), '#!/usr/bin/env bash\necho "no network" >&2\nexit 9\n', { mode: 0o755 });
    writeFileSync(join(app, 'scripts', 'upgrade.sh'), `#!/usr/bin/env bash\nexit "$(cat ${JSON.stringify(rc)})"\n`, { mode: 0o755 });
    writeFileSync(join(app, '.swapping'), 'from v1.0.0\nto v1.1.0\nin scripts\n');
    const repair = (code: number) => { writeFileSync(rc, String(code)); return v.follow('stable'); };
    expect(repair(4).status).toBe(0);
    expect(repair(5).status).toBe(1);
    expect(repair(3).status).toBe(1);
    expect(existsSync(v.tries)).toBe(false);
    expect(existsSync(v.failed)).toBe(false);
  });

  it('a release that failed on one install of the user\'s is still tried on another, and their retries are counted apart (audit #034)', () => {
    const first = world();
    const second = world(first, 'second-app');
    expect(first.run(1).status).toBe(1);
    expect(readFileSync(first.failed, 'utf8').trim()).toBe('v1.1.0');
    expect(second.run(0).status).toBe(0);
    expect(lines(second.log)).toEqual(['upgrade stable timer=1 target=v1.1.0']);
    // A failing install on the second does not make the first wait, or count towards its MAX_TRIES.
    const third = world(first, 'third-app');
    expect(second.run(3).status).toBe(1);
    expect(third.run(3).stdout).toContain('(1 of 8)');
    expect(lines(third.log)).toHaveLength(1);
  });

  it('a record from before, not yet keyed on an install, is taken over: the release stays set aside', () => {
    const w = world();
    mkdirSync(w.state, { recursive: true });
    writeFileSync(join(w.state, 'follow-channel-failed'), 'v1.1.0\n');
    expect(w.run(0).status).toBe(0);
    expect(lines(w.log)).toEqual([]);
    expect(readFileSync(w.failed, 'utf8').trim()).toBe('v1.1.0');
    expect(existsSync(join(w.state, 'follow-channel-failed'))).toBe(false);
  });
});

describe('scripts/follow-channel.sh with the real upgrade.sh (audit #042)', () => {
  it('the release it sets aside is the one upgrade.sh tried, though the channel moved between the two', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-target-')); dirs.push(root);
    const app = join(root, 'app'), home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [join(app, 'scripts'), home, bin]) mkdirSync(d, { recursive: true });
    const asked = join(root, 'asked'), restarts = join(root, 'restarts');
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_RESTART_CMD: join(app, 'scripts', 'restart.sh'), HATCHABOT_UPGRADE_IMAGE: '0' });
    const git = (...args: string[]) => execFileSync(REAL_GIT, args, { cwd: app, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    for (const f of ['follow-channel.sh', 'follow-tries.sh', 'upgrade.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    // stable names v1.1.0 when asked first, and v1.2.0 from the next question on (promoted meanwhile).
    writeFileSync(join(app, 'scripts', 'release-target.sh'), `#!/usr/bin/env bash\necho "$1" >> ${JSON.stringify(asked)}\nif [ "$(wc -l < ${JSON.stringify(asked)})" -le 1 ]; then echo v1.1.0; else echo v1.2.0; fi\n`, { mode: 0o755 });
    // v1.2.0 does not come up; the others do.
    writeFileSync(join(app, 'scripts', 'restart.sh'), `#!/usr/bin/env bash\ntag="$(git describe --tags --exact-match)"\necho "$tag" >> ${JSON.stringify(restarts)}\n[ "$tag" != v1.2.0 ]\n`, { mode: 0o755 });
    writeFileSync(join(app, '.gitignore'), 'node_modules/\nnode_modules.prev/\n');
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
      writeFileSync(join(app, 'package.json'), JSON.stringify({ version: v }));
      git('add', '-A'); git('commit', '-qm', `v${v}`); git('tag', `v${v}`);
    }
    git('checkout', '-q', 'v1.0.0');
    const tick = () => spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), 'stable'], { env, encoding: 'utf8' });
    // This install's own record, keyed on its path (audit #034).
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', app], { encoding: 'utf8' }).trim();
    const failed = join(home, '.local', 'state', 'hatchabot', `follow-channel-failed-${key}`);
    const first = tick();
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('Upgrading v1.0.0 → v1.1.0'); // what the timer resolved, not a second answer
    expect(lines(asked)).toEqual(['stable']);
    const second = tick();
    expect(second.status, second.stdout + second.stderr).toBe(1);
    expect(readFileSync(failed, 'utf8').trim()).toBe('v1.2.0'); // the release that failed, by its own name
    const third = tick();
    expect(third.status, third.stdout + third.stderr).toBe(0);
    expect(lines(restarts)).toEqual(['v1.1.0', 'v1.2.0', 'v1.1.0']); // tried once, rolled back, not tried again
    expect(git('describe', '--tags', '--exact-match')).toBe('v1.1.0');
  });
});

describe('scripts/follow-channel.sh, a pinned upgrade killed part-way, with the real upgrade.sh (HB-0372)', () => {
  it('the next tick puts the earlier release back and finishes the upgrade to the pin; the tick after does nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-pin-')); dirs.push(root);
    const app = join(root, 'app'), home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [join(app, 'scripts'), home, bin]) mkdirSync(d, { recursive: true });
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_RESTART_CMD: 'true', HATCHABOT_UPGRADE_IMAGE: '0' });
    const git = (...args: string[]) => execFileSync(REAL_GIT, args, { cwd: app, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    for (const f of ['follow-channel.sh', 'follow-tries.sh', 'upgrade.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    writeFileSync(join(app, 'scripts', 'release-target.sh'), '#!/usr/bin/env bash\necho "asked, though pinned" >&2\nexit 9\n', { mode: 0o755 });
    writeFileSync(join(app, '.gitignore'), 'node_modules/\nnode_modules.prev/\ndata/\n');
    for (const v of ['1.0.0', '1.1.0']) { writeFileSync(join(app, 'package.json'), JSON.stringify({ version: v })); git('add', '-A'); git('commit', '-qm', `v${v}`); git('tag', `v${v}`); }
    git('checkout', '-q', 'v1.0.0');
    // `hatchabot upgrade v1.1.0` killed in the install: the pin written, on v1.1.0, half its dependencies.
    mkdirSync(join(app, 'data')); writeFileSync(join(app, 'data', 'channel'), 'v1.1.0\n');
    git('checkout', '-q', 'v1.1.0');
    mkdirSync(join(app, 'node_modules')); writeFileSync(join(app, 'node_modules', 'half'), '');
    mkdirSync(join(app, 'node_modules.prev')); writeFileSync(join(app, 'node_modules.prev', 'marker'), 'old deps');
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', app], { encoding: 'utf8' }).trim();
    const state = join(home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
    writeFileSync(join(state, `upgrade-${key}.from`), 'from v1.0.0\nto v1.1.0\n');
    const tick = () => spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), 'stable'], { env, encoding: 'utf8' });
    const r = tick();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/cut off part-way — putting v1\.0\.0 back first/);
    expect(r.stdout).toContain('Upgrading v1.0.0 → v1.1.0 (v1.1.0)');
    expect(git('describe', '--tags', '--exact-match')).toBe('v1.1.0');
    expect(existsSync(join(state, `upgrade-${key}.from`))).toBe(false);
    expect(readFileSync(join(app, 'data', 'channel'), 'utf8').trim()).toBe('v1.1.0');
    const next = tick();
    expect(next.status).toBe(0);
    expect(next.stdout).toBe('');
  });
});

describe('scripts/follow-channel.sh, an upgrade killed part-way and no network, with the real upgrade.sh (HB-0547)', () => {
  it('the tick puts the earlier release back from this machine, and the tick after does nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-offline-')); dirs.push(root);
    const app = join(root, 'app'), home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [join(app, 'scripts'), home, bin]) mkdirSync(d, { recursive: true });
    const restarts = join(root, 'restarts');
    writeFileSync(join(bin, 'restart'), `#!/usr/bin/env bash\necho restarted >> ${JSON.stringify(restarts)}\n`, { mode: 0o755 });
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_RESTART_CMD: join(bin, 'restart'), HATCHABOT_UPGRADE_IMAGE: '0' });
    const git = (...args: string[]) => execFileSync(REAL_GIT, args, { cwd: app, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    for (const f of ['follow-channel.sh', 'follow-tries.sh', 'upgrade.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    writeFileSync(join(app, 'scripts', 'release-target.sh'), '#!/usr/bin/env bash\necho "no network" >&2\nexit 9\n', { mode: 0o755 });
    writeFileSync(join(app, '.gitignore'), 'node_modules/\nnode_modules.prev/\ndata/\n');
    for (const v of ['1.0.0', '1.1.0']) { writeFileSync(join(app, 'package.json'), JSON.stringify({ version: v })); git('add', '-A'); git('commit', '-qm', `v${v}`); git('tag', `v${v}`); }
    // The timer's upgrade to v1.1.0 killed in the install, after the restart: on v1.1.0 with half its dependencies.
    mkdirSync(join(app, 'data')); writeFileSync(join(app, 'data', 'channel'), 'stable\n');
    mkdirSync(join(app, 'node_modules')); writeFileSync(join(app, 'node_modules', 'half'), '');
    mkdirSync(join(app, 'node_modules.prev')); writeFileSync(join(app, 'node_modules.prev', 'marker'), 'old deps');
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', app], { encoding: 'utf8' }).trim();
    const state = join(home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
    writeFileSync(join(state, `upgrade-${key}.from`), 'from v1.0.0\nto v1.1.0\npins-recorded\nrestarted\n');
    const tick = () => spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), 'stable'], { env, encoding: 'utf8' });
    const r = tick();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/cut off part-way — putting v1\.0\.0 back first/);
    expect(git('describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(readFileSync(join(app, 'node_modules', 'marker'), 'utf8')).toBe('old deps');
    expect(existsSync(join(app, 'node_modules.prev'))).toBe(false);
    expect(existsSync(join(state, `upgrade-${key}.from`))).toBe(false);
    expect(lines(restarts)).toEqual(['restarted']); // back onto the old release
    expect(readFileSync(join(app, 'data', 'channel'), 'utf8').trim()).toBe('stable');
    for (const f of ['tries', 'failed']) expect(existsSync(join(state, `follow-channel-${f}-${key}`)), f).toBe(false);
    const next = tick();
    expect(next.status).toBe(0);
    expect(next.stdout).toBe('');
  });
});

describe('scripts/follow-channel.sh, a pin left by a kill on a clone, with the real upgrade.sh (HB-0428)', () => {
  /** `hatchabot upgrade v1.1.0` killed in the install. `record`: the pre-pin record its run wrote. */
  const cut = (record: boolean, extra: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-pin-')); dirs.push(root);
    const app = join(root, 'app'), home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [join(app, 'scripts'), home, bin]) mkdirSync(d, { recursive: true });
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`, { HATCHABOT_INSTALL_CMD: 'true', HATCHABOT_RESTART_CMD: 'true', HATCHABOT_UPGRADE_IMAGE: '0', ...extra });
    const git = (...args: string[]) => execFileSync(REAL_GIT, args, { cwd: app, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    for (const f of ['follow-channel.sh', 'follow-tries.sh', 'upgrade.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    writeFileSync(join(app, 'scripts', 'release-target.sh'), `#!/usr/bin/env bash\necho "$1" >> '${root}/asked.log'\necho v1.0.0\n`, { mode: 0o755 });
    writeFileSync(join(app, '.gitignore'), 'node_modules/\nnode_modules.prev/\ndata/\n');
    for (const v of ['1.0.0', '1.1.0']) { writeFileSync(join(app, 'package.json'), JSON.stringify({ version: v })); git('add', '-A'); git('commit', '-qm', `v${v}`); git('tag', `v${v}`); }
    git('checkout', '-q', 'v1.1.0');
    mkdirSync(join(app, 'data')); writeFileSync(join(app, 'data', 'channel'), 'v1.1.0\n');
    mkdirSync(join(app, 'node_modules')); writeFileSync(join(app, 'node_modules', 'half'), '');
    mkdirSync(join(app, 'node_modules.prev')); writeFileSync(join(app, 'node_modules.prev', 'marker'), 'old deps');
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', app], { encoding: 'utf8' }).trim();
    const state = join(home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
    const from = join(state, `upgrade-${key}.from`), pin = join(state, `upgrade-${key}.pin`);
    writeFileSync(from, 'from v1.0.0\nto v1.1.0\n');
    if (record) writeFileSync(pin, 'pin v1.1.0\nchannel stable\nuser \n');
    const tick = () => spawnSync('bash', [join(app, 'scripts', 'follow-channel.sh'), 'stable'], { env, encoding: 'utf8' });
    const channel = () => { const f = join(app, 'data', 'channel'); return existsSync(f) ? readFileSync(f, 'utf8').trim() : undefined; };
    return { root, git, tick, channel, from, pin };
  };

  it('an install that fails on the repair\'s try: the channel comes back, and the timer asks it', () => {
    const w = cut(true, { HATCHABOT_INSTALL_CMD: 'false' });
    const r = w.tick();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('Not pinned to v1.1.0');
    expect(w.git('describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(w.channel()).toBe('stable');
    expect(existsSync(w.from)).toBe(false);
    expect(existsSync(w.pin)).toBe(false);
    expect(w.tick().status).toBe(0);
    expect(lines(join(w.root, 'asked.log'))).toEqual(['stable']);
  });
  it('a restart that fails on that try: the same', () => {
    const w = cut(true, { HATCHABOT_RESTART_CMD: 'false' });
    const r = w.tick();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.git('describe', '--tags', '--exact-match')).toBe('v1.0.0');
    expect(w.channel()).toBe('stable');
    expect(existsSync(w.pin)).toBe(false);
  });
  it('with no record, from an earlier upgrade.sh: the pin is taken off', () => {
    const w = cut(false, { HATCHABOT_INSTALL_CMD: 'false' });
    expect(w.tick().status).toBe(1);
    expect(w.channel()).toBeUndefined();
    expect(w.tick().status).toBe(0);
    expect(lines(join(w.root, 'asked.log'))).toEqual(['stable']);
  });
  it('the release comes up: the pin was meant, and stays', () => {
    const w = cut(true, {});
    const r = w.tick();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.git('describe', '--tags', '--exact-match')).toBe('v1.1.0');
    expect(w.channel()).toBe('v1.1.0');
    expect(existsSync(w.pin)).toBe(false);
    expect(w.tick().stdout).toBe('');
  });
});

/** A throwaway origin with v1.0.0 and v1.1.0, and production cloned from it at v1.0.0. */
function prodWorld(v11: Record<string, string> = {}, [oldTag, newTag] = ['v1.0.0', 'v1.1.0']) {
  const root = mkdtempSync(join(tmpdir(), 'hb-deploy-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'calls.log');
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> ${JSON.stringify(log)}\nexit "\${FAKE_SYSTEMCTL_RC:-0}"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho "npm $*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\necho \'<script>window.HATCHABOT_VERSION="1.1.0"</script>\'\n', { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, 'node'));
  const env = scriptEnv(home, `${bin}:/usr/bin:/bin`);
  const git = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  const src = join(root, 'src'); mkdirSync(join(src, 'scripts'), { recursive: true });
  git(src, 'init', '-q', '-b', 'main');
  writeFileSync(join(src, '.gitignore'), 'node_modules/\nnode_modules.prev/\n');
  writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  writeFileSync(join(src, 'scripts', 'deploy-release.sh'), readFileSync('scripts/deploy-release.sh'), { mode: 0o755 });
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v1'); git(src, 'tag', oldTag);
  writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.1.0"}\n');
  // The new release's ensure-deps: recorded, and it fails when FAKE_DEPS_RC says so.
  writeFileSync(join(src, 'scripts', 'ensure-deps.sh'), `#!/usr/bin/env bash\necho "ensure-deps $*" >> ${JSON.stringify(log)}\nexit "\${FAKE_DEPS_RC:-0}"\n`, { mode: 0o755 });
  for (const [f, body] of Object.entries(v11)) writeFileSync(join(src, f), body, { mode: 0o755 });
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v2'); git(src, 'tag', newTag);
  const origin = join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', src, origin);
  const prod = join(root, 'prod');
  git(root, 'clone', '-q', origin, prod);
  git(prod, 'checkout', '-q', oldTag);
  mkdirSync(join(prod, 'node_modules')); writeFileSync(join(prod, 'node_modules', 'marker'), 'deps');
  // As follow-latest.sh runs it: saying it knows 5 (an older timer does not; seventh review).
  const deploy = (extra: Record<string, string> = {}) => spawnSync('bash', [join(prod, 'scripts', 'deploy-release.sh'), newTag], {
    encoding: 'utf8', env: { ...env, HATCHABOT_PROD_DIR: prod, HATCHABOT_FOLLOW_KNOWS_5: '1', ...extra },
  });
  const at = () => git(prod, 'describe', '--tags', '--exact-match');
  return { root, home, bin, env, log, prod, deploy, at, git };
}

describe('scripts/deploy-release.sh (review, 2026-10-09)', () => {
  it('serves the new release, installed through ensure-deps (it compiles the driver and writes the stamp; bare npm ci did neither)', () => {
    const w = prodWorld();
    const r = w.deploy();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Serving 1.1.0.');
    expect(lines(w.log)).toEqual(['ensure-deps --quiet', 'systemctl --user restart hatchabot']);
    expect(existsSync(join(w.prod, 'node_modules.prev'))).toBe(false);
  });

  it('an install that fails: back on the old release with its dependencies, exit 3, and the service is NOT restarted', () => {
    const w = prodWorld();
    const r = w.deploy({ FAKE_DEPS_RC: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(w.at()).toBe('v1.0.0');
    expect(existsSync(join(w.prod, 'node_modules', 'marker'))).toBe(true);
    expect(lines(w.log).filter((l) => l.startsWith('systemctl'))).toEqual([]);
  });

  it('after a deploy killed right after moving node_modules aside, a failed install still rolls back to those dependencies (audit #033)', () => {
    const w = prodWorld();
    renameSync(join(w.prod, 'node_modules'), join(w.prod, 'node_modules.prev')); // the only working copy
    const r = w.deploy({ FAKE_DEPS_RC: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(w.at()).toBe('v1.0.0');
    expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(existsSync(join(w.prod, 'node_modules.prev'))).toBe(false);
  });

  it('a release whose service does not restart: rolled back, the old one restarted, exit 1', () => {
    const w = prodWorld();
    const r = w.deploy({ FAKE_SYSTEMCTL_RC: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(w.at()).toBe('v1.0.0');
    expect(existsSync(join(w.prod, 'node_modules', 'marker'))).toBe(true);
    expect(lines(w.log).filter((l) => l.startsWith('systemctl'))).toHaveLength(2);
  });

  it('a service that takes the connection and never answers: each request ends, the wait ends, and it rolls back (HB-0553)', () => {
    const w = prodWorld();
    // curl waits for ever unless given a deadline, which it then reaches (exit 28); no real waits between tries.
    writeFileSync(join(w.bin, 'curl'), `#!/usr/bin/env bash\necho "curl $*" >> ${JSON.stringify(join(w.root, 'curl.log'))}\ncase " $* " in *" --max-time "*) exit 28 ;; esac\nexec /bin/sleep 20\n`, { mode: 0o755 });
    writeFileSync(join(w.bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const r = spawnSync('bash', [join(w.prod, 'scripts', 'deploy-release.sh'), 'v1.1.0'], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod }, timeout: 15_000 });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain('is not serving 1.1.0');
    expect(w.at()).toBe('v1.0.0');
    const asked = lines(join(w.root, 'curl.log'));
    expect(asked.length).toBeGreaterThan(1);
    for (const c of asked) expect(c).toMatch(/--connect-timeout \d+ --max-time \d+ /);
  });

  it('a step that fails part-way (the checkout, after node_modules moved aside) puts prod back and says 3, not 1', () => {
    const w = prodWorld();
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1 $2 $3" = "checkout --quiet v1.1.0" ] && { echo "error: simulated" >&2; exit 1; }\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    const r = w.deploy();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(existsSync(join(w.prod, 'node_modules', 'marker'))).toBe(true);
    expect(existsSync(join(w.prod, 'node_modules.prev'))).toBe(false);
  });

  describe('asks the listener the service is configured with (audit #030, #031)', () => {
    /** Production's .env (kept out of git status), and a service that answers only at `url`. */
    function serving(env: string, url: string) {
      const w = prodWorld();
      writeFileSync(join(w.prod, '.git', 'info', 'exclude'), '.env\n');
      writeFileSync(join(w.prod, '.env'), env);
      const asked = join(w.root, 'asked.log');
      writeFileSync(join(w.bin, 'curl'), `#!/usr/bin/env bash\necho "\${@: -1}" >> ${JSON.stringify(asked)}\n[ "\${@: -1}" = ${JSON.stringify(url)} ] || exit 7\necho '<script>window.HATCHABOT_VERSION="1.1.0"</script>'\n`, { mode: 0o755 });
      writeFileSync(join(w.bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
      return { ...w, r: w.deploy(), asked: () => lines(asked) };
    }

    it('a service bound to one LAN or IPv6 address is asked there, and the healthy release stays', () => {
      for (const [bind, url] of [['192.0.2.10', 'http://192.0.2.10:9090/'], ['2001:db8::10', 'http://[2001:db8::10]:9090/']] as const) {
        const w = serving(`HATCHABOT_BIND=${bind}\nPORT=9090\n`, url);
        expect(w.r.status, w.r.stdout + w.r.stderr).toBe(0);
        expect(w.r.stdout).toContain('Serving 1.1.0.');
        expect(w.at()).toBe('v1.1.0');
        expect(w.asked()).toEqual([url]);
      }
    });

    it('a setting written with spaces around the = is read as systemd reads it (audit, 2026-10-29)', () => {
      const w = serving('PORT = 9137\n', 'http://127.0.0.1:9137/');
      expect(w.r.status, w.r.stdout + w.r.stderr).toBe(0);
      expect(w.asked()).toEqual(['http://127.0.0.1:9137/']);
    });

    it('a name set twice in .env is read as the service reads it: the last one, without its comment', () => {
      const w = serving('PORT=8080\nHATCHABOT_TLS_CERT=\nPORT=9090   # moved off 8080\n', 'http://127.0.0.1:9090/');
      expect(w.r.status, w.r.stdout + w.r.stderr).toBe(0);
      expect(w.asked()).toEqual(['http://127.0.0.1:9090/']);
    });
  });

  it('a fetch that fails before anything changed (another fetch\'s ref lock) says 3, try again — not 1, set aside (audit #032)', () => {
    const w = prodWorld();
    // What a concurrent fetch leaves while it runs: its lock on the remote-tracking ref.
    w.git(w.prod, 'update-ref', '-d', 'refs/remotes/origin/main');
    mkdirSync(join(w.prod, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    writeFileSync(join(w.prod, '.git', 'refs', 'remotes', 'origin', 'main.lock'), 'held by another fetch');
    const r = w.deploy();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stderr).toContain('cannot lock ref');
    expect(r.stdout).toContain('nothing was changed');
    expect(w.at()).toBe('v1.0.0');
    expect(existsSync(join(w.prod, 'node_modules', 'marker'))).toBe(true);
    expect(lines(w.log)).toEqual([]); // nothing installed, nothing restarted
  });

  describe('cut off part-way through the install (HB-0266)', () => {
    /**
     * A deploy whose install leaves half a node_modules and hangs, as `npm ci`
     * cut off would. It runs in its own process group, so a signal reaches it
     * and the install as `systemctl stop` of the timer's unit does.
     */
    function cutOff(w: ReturnType<typeof prodWorld>, signal: NodeJS.Signals) {
      const started = join(w.root, 'started');
      writeFileSync(join(w.bin, 'hanging-step'), hangingStep(started), { mode: 0o755 });
      const p = spawn('bash', [join(w.prod, 'scripts', 'deploy-release.sh'), 'v1.1.0'], {
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...w.env, HATCHABOT_PROD_DIR: w.prod, HATCHABOT_INSTALL_CMD: join(w.bin, 'hanging-step') },
      });
      let out = '';
      p.stdout!.on('data', (c) => (out += c)); p.stderr!.on('data', (c) => (out += c));
      return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        const t0 = Date.now();
        const poll = setInterval(() => {
          if (existsSync(started)) { clearInterval(poll); process.kill(-p.pid!, signal); }
          else if (Date.now() - t0 > 15_000) { clearInterval(poll); process.kill(-p.pid!, 'SIGKILL'); reject(new Error(`never reached the install: ${out}`)); }
        }, 20);
        p.on('exit', (code) => resolve({ code, out }));
      });
    }
    const deps = (w: ReturnType<typeof prodWorld>) => existsSync(join(w.prod, 'node_modules', 'marker')) && !existsSync(join(w.prod, 'node_modules', 'half-installed')) && !existsSync(join(w.prod, 'node_modules.prev'));

    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      it(`${signal} in the install: the old release and its dependencies are put back at once, and it says 3`, async () => {
        const w = prodWorld();
        const r = await cutOff(w, signal);
        expect(r.code, r.out).toBe(3);
        expect(r.out).toMatch(/stopped part-way — putting v1\.0\.0 back/);
        expect(w.at()).toBe('v1.0.0');
        expect(deps(w)).toBe(true);
        expect(lines(w.log).filter((l) => l.startsWith('systemctl'))).toEqual([]);
        // Nothing left for the next run to repair.
        const next = w.deploy({ FAKE_DEPS_RC: '1' });
        expect(next.stdout).not.toMatch(/cut off part-way/);
      });
    }

    it('killed in the install (SIGKILL, a power cut): the next run puts the old release back first, not the half-installed one aside', async () => {
      const w = prodWorld();
      const r = await cutOff(w, 'SIGKILL');
      expect(r.code).toBe(null);
      expect(w.at()).toBe('v1.1.0'); // half-way: the new code, half its dependencies
      const next = w.deploy({ FAKE_DEPS_RC: '1' });
      expect(next.status, next.stdout + next.stderr).toBe(3);
      expect(next.stdout).toMatch(/cut off part-way — putting v1\.0\.0 back first/);
      expect(next.stdout).toMatch(/currently v1\.0\.0/);
      expect(w.at()).toBe('v1.0.0');
      expect(deps(w)).toBe(true);
      expect(lines(w.log).filter((l) => l.startsWith('systemctl'))).toEqual([]); // the service never left the old release
      const third = w.deploy();
      expect(third.status, third.stdout + third.stderr).toBe(0);
      expect(w.at()).toBe('v1.1.0');
    });

    it('killed in the install: follow-latest, though prod is on the newest tag, runs the deploy that repairs it', async () => {
      const w = prodWorld();
      for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
      const follow = () => spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
      expect((await cutOff(w, 'SIGKILL')).code).toBe(null);
      expect(w.at()).toBe('v1.1.0');
      expect(existsSync(join(w.prod, 'node_modules', 'half-installed'))).toBe(true);
      const r = follow();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/cut off part-way — putting v1\.0\.0 back first/);
      expect(r.stdout).toContain('Serving 1.1.0.');
      expect(w.at()).toBe('v1.1.0');
      expect(existsSync(join(w.prod, 'node_modules', 'half-installed'))).toBe(false);
      expect(lines(w.log).filter((l) => l.startsWith('ensure-deps'))).toEqual(['ensure-deps --quiet']);
      // Repaired and deployed: the next tick has nothing to do.
      const next = follow();
      expect(next.status, next.stdout + next.stderr).toBe(0);
      expect(next.stdout).toBe('');
    });

    it('killed in a hand deploy of a tag the timer had set aside: follow-latest still repairs it', async () => {
      const w = prodWorld();
      for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
      const follow = () => spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
      const state = join(w.env.HOME!, '.local', 'state', 'hatchabot');
      mkdirSync(state, { recursive: true }); writeFileSync(join(state, 'follow-latest-failed'), 'v1.1.0\n');
      expect((await cutOff(w, 'SIGKILL')).code).toBe(null);
      expect(w.at()).toBe('v1.1.0');
      const r = follow();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/cut off part-way — putting v1\.0\.0 back first/);
      expect(existsSync(join(w.prod, 'node_modules', 'half-installed'))).toBe(false);
    });
  });

  it('a checkout cut off part-way (HEAD and index still on the old tag, files rewritten): the rollback puts every tracked file back (HB-0266)', () => {
    const w = prodWorld();
    // The checkout writes the new files, then stops before it records the new HEAD and index.
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash
if [ "$1 $2 $3" = "checkout --quiet v1.1.0" ]; then
  ${JSON.stringify(REAL_GIT)} "$@" || exit 1
  ${JSON.stringify(REAL_GIT)} update-ref --no-deref HEAD "$(${JSON.stringify(REAL_GIT)} rev-parse 'v1.0.0^{commit}')"
  ${JSON.stringify(REAL_GIT)} read-tree v1.0.0
  exit 1
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`, { mode: 0o755 });
    const r = w.deploy();
    expect(r.status, r.stdout + r.stderr).toBe(3);
    rmSync(join(w.bin, 'git'));
    expect(w.at()).toBe('v1.0.0');
    expect(w.git(w.prod, 'status', '--porcelain')).toBe('');
    expect(readFileSync(join(w.prod, 'package.json'), 'utf8')).toContain('"1.0.0"');
    expect(existsSync(join(w.prod, 'scripts', 'ensure-deps.sh'))).toBe(false);
    expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    // And the next deploy is not refused as local changes.
    const next = w.deploy();
    expect(next.status, next.stdout + next.stderr).toBe(0);
    expect(w.at()).toBe('v1.1.0');
  });

  describe('killed in the checkout, leaving .git/index.lock (HB-0372)', () => {
    /** A deploy killed by SIGKILL while its git holds the index lock, its files rewritten and HEAD not moved yet. */
    async function killedInCheckout(w: ReturnType<typeof prodWorld>) {
      const started = join(w.root, 'in-checkout');
      writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash
if [ "$1 $2 $3" = "checkout --quiet v1.1.0" ]; then
  ${JSON.stringify(REAL_GIT)} "$@" || exit 1
  ${JSON.stringify(REAL_GIT)} update-ref --no-deref HEAD "$(${JSON.stringify(REAL_GIT)} rev-parse 'v1.0.0^{commit}')"
  ${JSON.stringify(REAL_GIT)} read-tree v1.0.0
  : > .git/index.lock
  touch ${JSON.stringify(started)}
  exec sleep 30
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`, { mode: 0o755 });
      const p = spawn('bash', [join(w.prod, 'scripts', 'deploy-release.sh'), 'v1.1.0'], { detached: true, stdio: 'ignore', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
      await new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const poll = setInterval(() => {
          if (existsSync(started)) { clearInterval(poll); process.kill(-p.pid!, 'SIGKILL'); }
          else if (Date.now() - t0 > 15_000) { clearInterval(poll); process.kill(-p.pid!, 'SIGKILL'); reject(new Error('never reached the checkout')); }
        }, 20);
        p.on('exit', () => resolve());
      });
      rmSync(join(w.bin, 'git'));
      const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
      const record = join(w.home, '.local', 'state', 'hatchabot', `upgrade-${key}.from`);
      const indexLock = join(w.prod, '.git', 'index.lock');
      /** As if killed that long ago: the record first, the lock after it, as they were made. */
      const age = (recordAge = '10 minutes ago', lockAge = '9 minutes ago') => { execFileSync('touch', ['-d', recordAge, record]); execFileSync('touch', ['-d', lockAge, indexLock]); };
      return { record, indexLock, age };
    }

    it('its own stale lock goes: every tracked file is put back, not refused as local changes, and the next deploy works', async () => {
      const w = prodWorld();
      const k = await killedInCheckout(w);
      expect(lines(k.record)[0]).toBe('from v1.0.0');
      expect(lines(k.record)[1]).toBe('to v1.1.0');
      expect(lines(k.record)[2]).toBe('pins-recorded');
      expect(lines(k.record)[3]).toMatch(/^git \d+ /);
      k.age();
      const r = w.deploy({ FAKE_DEPS_RC: '1' });
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toContain('Removing the .git/index.lock');
      expect(existsSync(k.indexLock)).toBe(false);
      expect(w.at()).toBe('v1.0.0');
      expect(w.git(w.prod, 'status', '--porcelain')).toBe('');
      expect(existsSync(join(w.prod, 'scripts', 'ensure-deps.sh'))).toBe(false);
      expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
      const next = w.deploy();
      expect(next.status, next.stdout + next.stderr).toBe(0);
      expect(w.at()).toBe('v1.1.0');
    });

    it('a lock it cannot prove is its own stays, and says so: too fresh, older than the record, or no git named', async () => {
      for (const kind of ['fresh', 'older', 'unnamed'] as const) {
        const w = prodWorld();
        const k = await killedInCheckout(w);
        if (kind === 'older') k.age('5 minutes ago', '20 minutes ago');
        if (kind === 'unnamed') { writeFileSync(k.record, 'from v1.0.0\nto v1.1.0\n'); k.age(); }
        const r = w.deploy();
        expect(r.status, kind + r.stdout + r.stderr).toBe(3);
        expect(r.stdout).toMatch(/index\.lock is in the way, and nothing shows it is that deploy's own/);
        expect(existsSync(k.indexLock), kind).toBe(true);
        expect(existsSync(k.record), kind).toBe(true);
      }
    });

    it('git killed alone, the deploy living on: the dependencies go back, and a later run takes the lock as its own', () => {
      const w = prodWorld();
      writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash
if [ "$1 $2 $3" = "checkout --quiet v1.1.0" ]; then
  ${JSON.stringify(REAL_GIT)} "$@" || exit 1
  ${JSON.stringify(REAL_GIT)} update-ref --no-deref HEAD "$(${JSON.stringify(REAL_GIT)} rev-parse 'v1.0.0^{commit}')"
  ${JSON.stringify(REAL_GIT)} read-tree v1.0.0
  : > .git/index.lock
  kill -9 $$
fi
exec ${JSON.stringify(REAL_GIT)} "$@"
`, { mode: 0o755 });
      const first = w.deploy();
      expect(first.status, first.stdout + first.stderr).toBe(3);
      rmSync(join(w.bin, 'git'));
      expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
      expect(existsSync(join(w.prod, 'node_modules.prev'))).toBe(false);
      const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
      const record = join(w.home, '.local', 'state', 'hatchabot', `upgrade-${key}.from`);
      const lock = join(w.prod, '.git', 'index.lock');
      // The rollback's own checkout, which could not run, did not move the record on.
      expect(lines(record).filter((l) => l.startsWith('git '))).toHaveLength(1);
      expect(statSync(record).mtimeMs).toBeLessThanOrEqual(statSync(lock).mtimeMs);
      execFileSync('touch', ['-d', '10 minutes ago', record]); execFileSync('touch', ['-d', '9 minutes ago', lock]);
      const next = w.deploy();
      expect(next.status, next.stdout + next.stderr).toBe(0);
      expect(next.stdout).toContain('Removing the .git/index.lock');
      expect(w.at()).toBe('v1.1.0');
    });

    it('a git someone else is running here keeps its lock, however old it looks', async () => {
      const w = prodWorld();
      const k = await killedInCheckout(w);
      k.age();
      // A real git: a commit sitting in its editor, as a person leaves one.
      rmSync(k.indexLock);
      writeFileSync(join(w.prod, 'package.json'), '{"name":"being-committed"}\n');
      const editing = join(w.root, 'in-editor');
      writeFileSync(join(w.bin, 'slow-editor'), `#!/bin/sh\ntouch ${JSON.stringify(editing)}\nexec sleep 30\n`, { mode: 0o755 });
      const person = spawn(REAL_GIT, ['commit', '-a', '-q'], { cwd: w.prod, stdio: 'ignore', env: { ...w.env, GIT_EDITOR: join(w.bin, 'slow-editor') } });
      try {
        await vi.waitFor(() => { if (!existsSync(editing)) throw new Error('not in the editor yet'); }, { timeout: 15_000, interval: 20 });
        expect(existsSync(k.indexLock)).toBe(true);
        k.age();
        const r = w.deploy();
        expect(r.status, r.stdout + r.stderr).toBe(3);
        expect(r.stdout).toMatch(/index\.lock is held by a git running there \(pid \d+\)/);
        expect(r.stdout).not.toContain('Removing the .git/index.lock');
        expect(existsSync(k.indexLock)).toBe(true);
      } finally {
        person.kill('SIGKILL');
        rmSync(k.indexLock, { force: true });
      }
    });

    it('a hand edit made since the kill is kept and named before the release goes back', async () => {
      const w = prodWorld();
      const k = await killedInCheckout(w);
      k.age();
      rmSync(k.indexLock); // gone by whatever means: the edit is what is under test
      writeFileSync(join(w.prod, 'package.json'), '{"name":"hand-patched"}\n');
      const r = w.deploy({ FAKE_DEPS_RC: '1' });
      expect(r.stdout, r.stdout + r.stderr).toMatch(/match neither v1\.0\.0 nor v1\.1\.0/);
      expect(r.stdout).toMatch(/^ {4}package\.json$/m);
      const where = /kept in (\S+):/.exec(r.stdout)![1]!;
      expect(readFileSync(join(where, 'package.json'), 'utf8')).toBe('{"name":"hand-patched"}\n');
      expect(statSync(where).mode & 0o777).toBe(0o700);
      // A file the kill left at the new release's own content is nobody's edit.
      expect(r.stdout).not.toMatch(/^ {4}scripts\/ensure-deps\.sh$/m);
      expect(w.at()).toBe('v1.0.0');
    });

    it('a git the record names that is still running: its lock stays and nothing is touched', async () => {
      const w = prodWorld();
      const k = await killedInCheckout(w);
      const holder = execFileSync('bash', ['-c', `LC_ALL=C ps -o lstart= -p ${process.pid} | tr -s ' ' | sed 's/^ //;s/ $//'`], { encoding: 'utf8' }).trim();
      writeFileSync(k.record, `from v1.0.0\nto v1.1.0\ngit ${process.pid} ${holder}\n`); k.age();
      const r = w.deploy();
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toMatch(/still running \(pid \d+\)/);
      expect(existsSync(k.indexLock)).toBe(true);
    });

    it('a lock with no record is another git\'s: refused with nothing moved, not left half way by a failed checkout and rollback', () => {
      const w = prodWorld();
      writeFileSync(join(w.prod, '.git', 'index.lock'), '');
      const r = w.deploy();
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toContain('index.lock is held, so nothing was changed');
      expect(existsSync(join(w.prod, '.git', 'index.lock'))).toBe(true);
      expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
      expect(existsSync(join(w.prod, 'node_modules.prev'))).toBe(false);
    });

    it('with no network the repair still runs: the fetch comes after it', () => {
      const w = prodWorld();
      const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
      const state = join(w.home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
      w.git(w.prod, 'checkout', '-q', 'v1.1.0');
      writeFileSync(join(state, `upgrade-${key}.from`), 'from v1.0.0\nto v1.1.0\n');
      w.git(w.prod, 'remote', 'set-url', 'origin', join(w.root, 'gone.git'));
      const r = w.deploy();
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).toMatch(/cut off part-way — putting v1\.0\.0 back first/);
      expect(w.at()).toBe('v1.0.0');
    });
  });

  describe('cut off while it removes a node_modules.prev (HB-0266)', () => {
    const REAL_RM = spawnSync('sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).stdout.trim();
    /** An rm that, removing a node_modules.prev holding `file`, deletes that one file and signals the deploy. */
    const cutRm = (w: ReturnType<typeof prodWorld>, file: string, signal: string) => writeFileSync(join(w.bin, 'rm'), `#!/usr/bin/env bash
if [ "$1 $2" = "-rf node_modules.prev" ] && [ -f node_modules.prev/${file} ]; then ${JSON.stringify(REAL_RM)} -f node_modules.prev/${file}; kill -${signal} "$PPID"; exit 1; fi
exec ${JSON.stringify(REAL_RM)} "$@"
`, { mode: 0o755 });
    const installNew = (w: ReturnType<typeof prodWorld>) => {
      writeFileSync(join(w.bin, 'install-new'), '#!/usr/bin/env bash\nmkdir -p node_modules && echo new > node_modules/new-marker\n', { mode: 0o755 });
      return { HATCHABOT_INSTALL_CMD: join(w.bin, 'install-new') };
    };

    for (const signal of ['KILL', 'TERM']) {
      it(`SIG${signal} once the new release is serving, while the old dependencies are removed: the next deploy leaves the new release alone`, () => {
        const w = prodWorld();
        cutRm(w, 'marker', signal);
        const first = w.deploy(installNew(w));
        // Stopped by a signal it can see, it says what is true: deployed (HB-0266).
        if (signal === 'TERM') { expect(first.status, first.stdout + first.stderr).toBe(0); expect(first.stdout).toContain('Serving 1.1.0.'); }
        expect(w.at()).toBe('v1.1.0');
        expect(readFileSync(join(w.prod, 'node_modules', 'new-marker'), 'utf8')).toBe('new\n');
        const next = w.deploy(installNew(w));
        expect(next.stdout).not.toMatch(/cut off part-way/);
        expect(next.status, next.stdout + next.stderr).toBe(0);
        expect(next.stdout).toMatch(/currently v1\.1\.0/);
        expect(w.at()).toBe('v1.1.0');
        expect(readFileSync(join(w.prod, 'node_modules', 'new-marker'), 'utf8')).toBe('new\n');
      });
    }

    it('SIGTERM while a stale node_modules.prev is removed, before anything moved: production\'s node_modules is left alone', () => {
      const w = prodWorld();
      mkdirSync(join(w.prod, 'node_modules.prev')); writeFileSync(join(w.prod, 'node_modules.prev', 'stale'), 'x');
      cutRm(w, 'stale', 'TERM');
      const r = w.deploy(installNew(w));
      expect(r.status, r.stdout + r.stderr).toBe(3);
      expect(r.stdout).not.toMatch(/Rolling back/);
      expect(w.at()).toBe('v1.0.0');
      expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
      expect(lines(w.log).filter((l) => l.startsWith('systemctl'))).toEqual([]);
      const next = w.deploy(installNew(w));
      expect(next.stdout).not.toMatch(/cut off part-way/);
      expect(next.status, next.stdout + next.stderr).toBe(0);
    });
  });

  it('takes its lock in the user\'s state folder, not /tmp', () => {
    const w = prodWorld();
    const sum = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
    mkdirSync(join(w.home, '.local', 'state', 'hatchabot', `upgrade-${sum}.lock.d`), { recursive: true });
    const r = w.deploy();
    expect(r.status, r.stdout + r.stderr).toBe(4);
  });
});

describe('scripts/deploy-release.sh on a full disk: exit 5, the machine\'s, never the tag\'s (third review of HB-0470)', () => {
  const lockOf = (w: ReturnType<typeof prodWorld>) => {
    const sum = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
    return join(w.home, '.local', 'state', 'hatchabot', `upgrade-${sum}.lock.d`);
  };
  it('an install that fails for want of room puts the old release back and says 5; the inotify watcher limit\'s ENOSPC is the tag\'s, 3', () => {
    const w = prodWorld();
    writeFileSync(join(w.bin, 'nospace-install'), '#!/bin/sh\necho "npm ERR! nospc ENOSPC: no space left on device, write" >&2\nexit 1\n', { mode: 0o755 });
    const r = w.deploy({ HATCHABOT_INSTALL_CMD: join(w.bin, 'nospace-install') });
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain(`The disk holding ${w.prod} is full`);
    expect(w.at()).toBe('v1.0.0');
    expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    expect(lines(w.log).filter((l) => l.startsWith('systemctl'))).toEqual([]);
    writeFileSync(join(w.bin, 'watchers-install'), '#!/bin/sh\necho "Error: ENOSPC: System limit for number of file watchers reached" >&2\nexit 1\n', { mode: 0o755 });
    const watchers = w.deploy({ HATCHABOT_INSTALL_CMD: join(w.bin, 'watchers-install') });
    expect(watchers.status, watchers.stdout + watchers.stderr).toBe(3);
    expect(w.at()).toBe('v1.0.0');
  });
  it('the lock\'s folder and the record before anything moves: something in the way named (2), else the machine\'s, 5 (seventh and ninth reviews)', () => {
    const w = prodWorld();
    const notADir = join(w.root, 'state-is-a-file'); writeFileSync(notADir, '');
    const inWay = w.deploy({ XDG_STATE_HOME: notADir });
    expect(inWay.status, inWay.stdout + inWay.stderr).toBe(2);
    expect(inWay.stdout).toContain(`${notADir} is in the way`);
    const record = lockOf(w).replace(/\.lock\.d$/, '.from');
    mkdirSync(record, { recursive: true });
    const folder = w.deploy();
    expect(folder.status, folder.stdout + folder.stderr).toBe(2);
    expect(folder.stdout).toContain(`${record} is in the way`);
    rmSync(record, { recursive: true });
    for (const [said, rc] of [['Permission denied', 5], ['No space left on device', 5]] as const) {
      writeFileSync(join(w.bin, 'mkdir'), `#!/bin/sh\ncase "$*" in *.local/state/hatchabot) echo "mkdir: cannot create directory: ${said}" >&2; exit 1 ;; esac\nexec /bin/mkdir "$@"\n`, { mode: 0o755 });
      const m = w.deploy();
      expect(m.status, said + m.stdout + m.stderr).toBe(rc);
      expect(m.stdout).toContain('where deploys keep their lock');
      rmSync(join(w.bin, 'mkdir'));
      writeFileSync(join(w.bin, 'mv'), `#!/bin/sh\ncase "$*" in *.from.tmp*) echo "mv: cannot move: ${said}" >&2; exit 1 ;; esac\nexec /bin/mv "$@"\n`, { mode: 0o755 });
      const f = w.deploy();
      expect(f.status, said + f.stdout + f.stderr).toBe(rc);
      expect(f.stdout).toContain(`Could not write ${record}`);
      expect(existsSync(record)).toBe(false);
      rmSync(join(w.bin, 'mv'));
    }
    expect(w.at()).toBe('v1.0.0');
    expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
  });
  it('to a caller that does not say it knows 5 (the follow-latest.sh of a release before), the disk is 3, as it was (seventh review)', () => {
    const w = prodWorld();
    writeFileSync(join(w.bin, 'nospace-install'), '#!/bin/sh\necho "npm ERR! nospc ENOSPC: no space left on device, write" >&2\nexit 1\n', { mode: 0o755 });
    const old = w.deploy({ HATCHABOT_INSTALL_CMD: join(w.bin, 'nospace-install'), HATCHABOT_FOLLOW_KNOWS_5: '' });
    expect(old.status, old.stdout + old.stderr).toBe(3);
    expect(old.stdout).toContain(`The disk holding ${w.prod} is full`); // said all the same
    expect(w.at()).toBe('v1.0.0');
    const knows = w.deploy({ HATCHABOT_INSTALL_CMD: join(w.bin, 'nospace-install') });
    expect(knows.status, knows.stdout + knows.stderr).toBe(5);
  });
  it('the lock: one whose holder cannot be written is let go (5), one let go just as it asked is taken, a file in its place is named (2)', () => {
    const w = prodWorld();
    writeFileSync(join(w.bin, 'mv'), `#!/bin/sh\ncase "$*" in *.lock.d/owner.*) echo "mv: No space left on device" >&2; exit 1 ;; esac\nexec /bin/mv "$@"\n`, { mode: 0o755 });
    const full = w.deploy();
    expect(full.status, full.stdout + full.stderr).toBe(5);
    expect(full.stdout).toContain('Could not take the upgrade lock');
    expect(existsSync(lockOf(w))).toBe(false);
    expect(w.at()).toBe('v1.0.0');
    rmSync(join(w.bin, 'mv'));
    const file = lockOf(w);
    writeFileSync(file, 'not a lock\n');
    const inWay = w.deploy();
    expect(inWay.status, inWay.stdout + inWay.stderr).toBe(2);
    expect(inWay.stdout).toContain(`${file} is in the way of the upgrade lock`);
    rmSync(file);
    const once = join(w.root, 'mkdir-once');
    writeFileSync(join(w.bin, 'mkdir'), `#!/bin/sh\ncase "$1" in *.lock.d) [ -f ${JSON.stringify(once)} ] || { : > ${JSON.stringify(once)}; echo "mkdir: File exists" >&2; exit 1; } ;; esac\nexec /bin/mkdir "$@"\n`, { mode: 0o755 });
    const raced = w.deploy();
    expect(raced.status, raced.stdout + raced.stderr).toBe(0);
    expect(raced.stdout).toContain('Serving 1.1.0.');
  });
  it.skipIf(!existsSync('/dev/full'))('the deploy\'s record that cannot take "restarted" is judged like a step: the disk\'s words are 5, the old release back (fifth and sixth reviews)', () => {
    const w = prodWorld();
    const from = lockOf(w).replace(/\.lock\.d$/, '.from');
    writeFileSync(join(w.bin, 'spoil-install'), `#!/bin/sh\nrm -f ${JSON.stringify(from)} && ln -s /dev/full ${JSON.stringify(from)}\n`, { mode: 0o755 });
    const r = w.deploy({ HATCHABOT_INSTALL_CMD: join(w.bin, 'spoil-install') });
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain(`Could not write ${from}`);
    expect(r.stdout).toContain(`The disk holding ${w.prod} is full`);
    expect(w.at()).toBe('v1.0.0');
    expect(lines(w.log).filter((l) => l.startsWith('systemctl'))).toEqual([]);
    expect(existsSync(from)).toBe(false);
  });
  it('words of its own: the tag\'s with room left (100 MB, 3), the disk\'s under 64 MB (50 MB, 5: eighth review; the sixth had them win there)', () => {
    const w = prodWorld();
    writeFileSync(join(w.bin, 'mismatch-install'), '#!/bin/sh\necho "npm ERR! code EUSAGE" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(w.bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 897600 102400 90% /"\n', { mode: 0o755 });
    const r = w.deploy({ HATCHABOT_INSTALL_CMD: join(w.bin, 'mismatch-install') });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).not.toContain('is full');
    expect(w.at()).toBe('v1.0.0');
    writeFileSync(join(w.bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 948800 51200 99% /"\n', { mode: 0o755 });
    const low = w.deploy({ HATCHABOT_INSTALL_CMD: join(w.bin, 'mismatch-install') });
    expect(low.status, low.stdout + low.stderr).toBe(5);
    expect(low.stdout).toContain('is full (50 MB free)');
    expect(w.at()).toBe('v1.0.0');
  });
  it('a rollback that did not work is said, with what to run, and is 3; a lock folder it cannot write in is the machine\'s, 5, with the folder named (eighth and ninth reviews)', () => {
    const w = prodWorld();
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1 $2 $3" = "checkout --quiet --force" ] && { echo "error: unable to unlink old 'package.json': Permission denied" >&2; exit 1; }\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
    const r = w.deploy({ HATCHABOT_INSTALL_CMD: 'false' });
    expect(r.status, r.stdout + r.stderr).toBe(3);
    expect(r.stdout).toContain(`Putting v1.0.0 back did not work either (above), so ${w.prod} may be part-way between v1.0.0 and v1.1.0.`);
    expect(r.stdout).toContain('Then run scripts/deploy-release.sh v1.1.0: it puts v1.0.0 back first, from its record.');
    expect(existsSync(lockOf(w).replace(/\.lock\.d$/, '.from'))).toBe(true);
    rmSync(join(w.bin, 'git'));
    const next = w.deploy({ HATCHABOT_INSTALL_CMD: 'false' });
    expect(next.stdout).toMatch(/cut off part-way — putting v1\.0\.0 back first/);
    expect(next.status, next.stdout + next.stderr).toBe(3);
    expect(w.at()).toBe('v1.0.0');
    expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
    if (process.getuid?.() === 0) return; // root writes anywhere
    const locks = dirname(lockOf(w));
    chmodSync(locks, 0o555);
    try {
      const shut = w.deploy();
      expect(shut.status, shut.stdout + shut.stderr).toBe(5);
      expect(shut.stdout).toContain(`Could not take the upgrade lock ${lockOf(w)} (above)`);
      expect(shut.stdout).toContain(`Check that ${locks} is a folder this user can write in`);
      expect(shut.stderr).toContain('Permission denied');
    } finally { chmodSync(locks, 0o755); }
    expect(w.at()).toBe('v1.0.0');
  });
  it('a symlink in the lock\'s place, dangling or not, is named (2); the steps are asked in English, and their errors kept off TMPDIR (fourth review)', () => {
    const w = prodWorld();
    mkdirSync(dirname(lockOf(w)), { recursive: true });
    symlinkSync('nowhere-made-up', lockOf(w));
    const dangling = w.deploy();
    expect(dangling.status, dangling.stdout + dangling.stderr).toBe(2);
    expect(dangling.stdout).toContain(`${lockOf(w)} is in the way of the upgrade lock`);
    expect(dangling.stdout).not.toContain('Could not take the upgrade lock');
    rmSync(lockOf(w));
    // An install that says the disk only in English, run in French, with no TMPDIR to write in: still 5.
    writeFileSync(join(w.bin, 'fr-install'), `#!/bin/sh\nif [ "\${LC_ALL:-\${LC_MESSAGES:-\${LANG:-}}}" = C ]; then echo "npm ERR! nospc ENOSPC: No space left on device, write" >&2; else echo "npm ERR! nospc : Aucun espace disponible sur le périphérique" >&2; fi\nexit 1\n`, { mode: 0o755 });
    const r = w.deploy({ HATCHABOT_INSTALL_CMD: join(w.bin, 'fr-install'), LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8', TMPDIR: join(w.root, 'no-such-tmp') });
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain(`The disk holding ${w.prod} is full`);
    expect(w.at()).toBe('v1.0.0');
    expect(readdirSync(dirname(lockOf(w))).filter((n) => n.includes('.step.'))).toEqual([]);
  });
});

describe('scripts/follow-latest.sh (review, 2026-10-09)', () => {
  it('its own temporary files on a full disk count a try the disk failed, said, and the next tick waits: set -e no longer ends it with no word (fourteenth review)', () => {
    const REAL_MKTEMP = spawnSync('sh', ['-c', 'command -v mktemp'], { encoding: 'utf8' }).stdout.trim();
    // when: 'all' fails every mktemp (the private copy first); 'deploy' only those of the copy it runs from.
    for (const when of ['all', 'deploy'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'hb-follow-latest-full-')); dirs.push(root);
      const deploys = join(root, 'deploys.log');
      const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(deploys)}\nexit 0\n` });
      for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
      const state = join(w.home, '.local', 'state', 'hatchabot');
      const cond = when === 'all' ? 'true' : '[ -n "${FOLLOW_LATEST_COPY:-}" ]';
      writeFileSync(join(w.bin, 'mktemp'), `#!/usr/bin/env bash\nif ${cond}; then echo "mktemp: failed to create file via template '/tmp/tmp.XXXXXXXXXX': No space left on device" >&2; exit 1; fi\nexec ${JSON.stringify(REAL_MKTEMP)} "$@"\n`, { mode: 0o755 });
      const follow = () => spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
      const r = follow();
      expect(r.status, `${when}: ${r.stdout}${r.stderr}`).toBe(1);
      expect(r.stdout, when).toContain(`(a full disk?), so this tick stops before changing anything. This does not count against v1.1.0; the next ticks wait.`);
      expect(readFileSync(join(state, 'follow-latest-tries'), 'utf8'), when).toMatch(/^v1\.1\.0 1 \d+\n$/);
      expect(readFileSync(join(state, 'follow-latest-tries.disk'), 'utf8'), when).toBe('v1.1.0 1\n');
      expect(follow().status, when).toBe(0); // waits
      expect(lines(deploys), when).toEqual([]);
    }
  });

  it.skipIf(process.getuid?.() === 0)('a tag it cannot set aside (a folder it cannot write) still counts the try, and the next tick waits (thirteenth review)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-latest-aside-')); dirs.push(root);
    const deploys = join(root, 'deploys.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(deploys)}\nexit 1\n` });
    for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
    const state = join(w.home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
    const runtime = mkdtempSync(join(tmpdir(), 'hb-follow-runtime-')); dirs.push(runtime);
    const follow = () => spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod, XDG_RUNTIME_DIR: runtime } });
    execFileSync('chmod', ['555', state]);
    try {
      const r = follow();
      expect(r.status, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toContain(`Deploying v1.1.0 failed and was rolled back. Could not write ${join(state, 'follow-latest-failed')} to set v1.1.0 aside (a full disk?): this try is counted instead, so the next ones wait.`);
      expect(readFileSync(join(runtime, 'hatchabot-follow-latest-tries'), 'utf8')).toMatch(/^v1\.1\.0 1 \d+\n$/);
      expect(follow().status).toBe(0); // waits
      expect(lines(deploys)).toHaveLength(1);
    } finally { execFileSync('chmod', ['755', state]); }
  });

  it('a tag whose deploy keeps failing to install waits longer each time, then is set aside', () => {
    // v1.1.0's deploy script: recorded, and exits with what rc.txt says.
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-latest-rc-')); dirs.push(root);
    const rc = join(root, 'rc.txt'), deploys = join(root, 'deploys.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(deploys)}\nexit "$(cat ${JSON.stringify(rc)})"\n` });
    mkdirSync(join(w.prod, 'scripts'), { recursive: true });
    for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
    const state = join(w.home, '.local', 'state', 'hatchabot');
    const follow = (code: number) => {
      writeFileSync(rc, String(code));
      return spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    };
    expect(follow(3).stdout).toContain('tried again later (1 of 8)');
    follow(3);
    expect(lines(deploys)).toHaveLength(1); // too soon
    writeFileSync(join(state, 'follow-latest-tries'), 'v1.1.0 7 0\n');
    expect(follow(3).stdout).toContain('did not complete 8 times in a row');
    expect(readFileSync(join(state, 'follow-latest-failed'), 'utf8').trim()).toBe('v1.1.0');
    follow(0);
    expect(lines(deploys)).toHaveLength(2);
  });

  it('with no follow-tries.sh beside it the tick still reaches the deploy, and says it counts nothing (fifth review of HB-0470)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-latest-notries-')); dirs.push(root);
    const deploys = join(root, 'deploys.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(deploys)}\nexit 3\n` });
    writeFileSync(join(w.root, 'follow-latest.sh'), readFileSync('scripts/follow-latest.sh'), { mode: 0o755 });
    const follow = () => spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    const r = follow();
    expect(r.stdout + r.stderr).toContain('this tick keeps no count of its tries');
    follow();
    expect(lines(deploys)).toHaveLength(2); // no wait: tried again
    expect(existsSync(join(w.home, '.local', 'state', 'hatchabot', 'follow-latest-tries'))).toBe(false);
  });

  it('a full disk (exit 5) waits like a failure but never sets the tag aside, nor counts towards it; the wait stays a day at most (third review of HB-0470)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-latest-disk-')); dirs.push(root);
    const rc = join(root, 'rc.txt'), deploys = join(root, 'deploys.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(deploys)}\nexit "$(cat ${JSON.stringify(rc)})"\n` });
    for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
    const state = join(w.home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
    const tries = join(state, 'follow-latest-tries'), failed = join(state, 'follow-latest-failed');
    const follow = (code: number) => {
      writeFileSync(rc, String(code));
      return spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    };
    writeFileSync(tries, 'v1.1.0 7 0\n'); // seven failures in a row: the eighth exit 3 would set it aside
    const full = follow(5);
    expect(full.status).toBe(1);
    expect(full.stdout).toContain('does not count against v1.1.0');
    expect(existsSync(failed)).toBe(false);
    expect(readFileSync(tries, 'utf8')).toMatch(/^v1\.1\.0 8 \d+\n$/);
    expect(readFileSync(`${tries}.disk`, 'utf8')).toBe('v1.1.0 1\n');
    // Once the disk is freed, a failure of the tag's own is its first.
    writeFileSync(tries, 'v1.1.0 31 0\n'); writeFileSync(`${tries}.disk`, 'v1.1.0 31\n');
    expect(follow(3).stdout).toContain('tried again later (1 of 8)');
    expect(existsSync(failed)).toBe(false);
    expect(lines(deploys)).toHaveLength(2);
    // A disk full for months: from 64 on the doubling wrapped to a try every tick;
    // and nine of the disk's tries waited a day, not the hour at most (twelfth review).
    const ago = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;
    for (const count of [9, 63, 64, 65, 1000]) {
      writeFileSync(tries, `v1.1.0 ${count} ${ago(30)}\n`); writeFileSync(`${tries}.disk`, `v1.1.0 ${count}\n`);
      expect(follow(5).status, String(count)).toBe(0);
    }
    expect(lines(deploys)).toHaveLength(2);
    writeFileSync(tries, `v1.1.0 9 ${ago(60)}\n`); writeFileSync(`${tries}.disk`, 'v1.1.0 9\n');
    expect(follow(5).status).toBe(1);
    expect(lines(deploys)).toHaveLength(3);
  });

  it('says it knows 5 to the deploy it runs, and to the repair\'s (seventh review)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-latest-knows-')); dirs.push(root);
    const deploys = join(root, 'deploys.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $* knows=\${HATCHABOT_FOLLOW_KNOWS_5:-}" >> ${JSON.stringify(deploys)}\nexit 3\n` });
    for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
    const follow = () => spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    follow();
    expect(lines(deploys)).toEqual(['deploy v1.1.0 knows=1']);
    // A deploy of v1.1.0 cut off part-way: the repair runs v1.1.0's own deploy script.
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
    const state = join(w.home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
    w.git(w.prod, 'checkout', '-q', 'v1.1.0');
    writeFileSync(join(state, `upgrade-${key}.from`), 'from v1.1.0\nto v1.1.0\n');
    const r = follow();
    expect(r.stdout).toContain('was cut off part-way; putting v1.1.0 back');
    expect(lines(deploys)).toEqual(['deploy v1.1.0 knows=1', 'deploy v1.1.0 knows=1']);
  });
});

describe('scripts/follow-latest.sh runs only a release the workflow published (#37)', () => {
  /**
   * Production at v2.159.1, a new tag v2.160.0 whose deploy script only records
   * that it ran, and a fake curl standing in for GitHub: the API's answer for
   * the release and the release's manifest come from files (none = a 404;
   * an `offline` file = no network). Every URL asked for is logged.
   */
  function world(newTag = 'v2.160.0', oldTag = 'v2.159.1') {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-verify-')); dirs.push(root);
    const ran = join(root, 'ran.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(ran)}\n` }, [oldTag, newTag]);
    const gh = join(root, 'gh'); mkdirSync(gh);
    writeFileSync(join(w.bin, 'curl'), [
      '#!/usr/bin/env bash',
      `GH=${JSON.stringify(gh)}`,
      'out=""; fmt=""; url=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; -w) fmt="$2"; shift ;; -H|--max-time|--max-filesize|--retry) shift ;; http*) url="$1" ;; esac; shift; done',
      'echo "$url" >> "$GH/urls.log"',
      '[ -e "$GH/offline" ] && { echo "curl: (6) Could not resolve host" >&2; exit 6; }',
      'case "$url" in */releases/tags/*) src="$GH/release.json" ;; */release-manifest.json) src="$GH/manifest.json" ;; *) src=/nonexistent ;; esac',
      'if [ -f "$src" ]; then cp "$src" "$out"; code=200; else echo "Not Found" > "$out"; code=404; fi',
      'printf "%s" "${fmt//%\\{http_code\\}/$code}"',
    ].join('\n') + '\n', { mode: 0o755 });
    for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
    const commit = w.git(w.prod, 'rev-parse', `${newTag}^{commit}`);
    const release = (over: Record<string, unknown> = {}) => writeFileSync(join(gh, 'release.json'), JSON.stringify({
      tag_name: newTag, draft: false, immutable: true,
      assets: [{ name: 'hatchabot-v2.160.0-linux-x64.tar.gz' }, { name: 'release-manifest.json' }], ...over,
    }));
    const manifest = (over: Record<string, unknown> = {}) => writeFileSync(join(gh, 'manifest.json'), JSON.stringify({
      schema: 1, version: newTag.slice(1), tag: newTag, commit, createdAt: '2026-10-10T12:00:00Z', ...over,
    }));
    const state = join(w.home, '.local', 'state', 'hatchabot');
    const follow = () => spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    const urls = () => lines(join(gh, 'urls.log'));
    return { ...w, gh, ran, commit, release, manifest, follow, urls, state };
  }

  describe('a hand deploy killed part-way, and a tag it must not run or go on to (HB-0372)', () => {
    /** Prod's real deploy script is the old release's: it is what repairs here. The record of a killed deploy, beside the lock. */
    function killedHandDeploy(w: ReturnType<typeof world>, from: string, to: string) {
      const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
      mkdirSync(w.state, { recursive: true });
      const record = join(w.state, `upgrade-${key}.from`);
      w.git(w.prod, 'checkout', '-q', to);
      rmSync(join(w.prod, 'node_modules'), { recursive: true });
      mkdirSync(join(w.prod, 'node_modules', 'half-installed'), { recursive: true });
      mkdirSync(join(w.prod, 'node_modules.prev')); writeFileSync(join(w.prod, 'node_modules.prev', 'marker'), 'deps');
      writeFileSync(record, `from ${from}\nto ${to}\n`);
      return record;
    }

    it('a tag verify_release refuses (30), set aside, then deployed by hand and killed: the tick repairs by the old release\'s script, none of the tag\'s code runs', () => {
      const w = world();
      w.release({ immutable: false }); w.manifest();
      const record = killedHandDeploy(w, 'v2.159.1', 'v2.160.0');
      writeFileSync(join(w.state, 'follow-latest-failed'), 'v2.160.0\n');
      const realCurl = readFileSync(join(w.bin, 'curl'), 'utf8');
      // The old release, once back, answers as itself.
      writeFileSync(join(w.bin, 'curl'), realCurl.replace('#!/usr/bin/env bash\n', `#!/usr/bin/env bash\ncase "$*" in *127.0.0.1*) echo '<script>window.HATCHABOT_VERSION="1.0.0"</script>'; exit 0 ;; esac\n`));
      const r = w.follow();
      expect(r.stdout, r.stdout + r.stderr).toContain('Not deploying v2.160.0');
      expect(r.stdout).toMatch(/cut off part-way — putting v2\.159\.1 back first/);
      expect(lines(w.ran)).toEqual([]); // the refused tag's deploy script never ran
      expect(w.at()).toBe('v2.159.1');
      expect(existsSync(record)).toBe(false);
      expect(existsSync(join(w.prod, 'node_modules', 'half-installed'))).toBe(false);
      expect(readFileSync(join(w.state, 'follow-latest-failed'), 'utf8').trim()).toBe('v2.160.0');
      const next = w.follow();
      expect(next.status, next.stdout + next.stderr).toBe(0); // set aside, and nothing left to repair: quiet again
    });

    it('a killed hand deploy of a tag ahead of the newest followed one (an rc) is repaired, not passed over; on to the newest from behind it', () => {
      const w = world();
      w.release(); w.manifest();
      w.git(w.prod, 'commit', '-q', '--allow-empty', '-m', 'rc'); w.git(w.prod, 'tag', 'v2.161.0-rc.1');
      const record = killedHandDeploy(w, 'v2.159.1', 'v2.161.0-rc.1');
      const r = w.follow();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(lines(w.ran)).toEqual(['deploy v2.160.0']); // the newest's script: it repairs, then deploys (recorded only, here)
      expect(existsSync(record)).toBe(true); // that stand-in script repairs nothing
    });

    it('a killed hand deploy that came from a release ahead of the newest tag goes back there, not backwards to the newest', () => {
      const w = world();
      for (const rc of ['v2.161.0-rc.1', 'v2.161.0-rc.2']) { w.git(w.prod, 'commit', '-q', '--allow-empty', '-m', rc); w.git(w.prod, 'tag', rc); }
      const realCurl = readFileSync(join(w.bin, 'curl'), 'utf8');
      writeFileSync(join(w.bin, 'curl'), realCurl.replace('#!/usr/bin/env bash\n', `#!/usr/bin/env bash\ncase "$*" in *127.0.0.1*) echo '<script>window.HATCHABOT_VERSION="1.0.0"</script>'; exit 0 ;; esac\n`));
      const record = killedHandDeploy(w, 'v2.161.0-rc.1', 'v2.161.0-rc.2');
      const r = w.follow();
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toMatch(/putting v2\.161\.0-rc\.1 back/);
      expect(lines(w.ran)).toEqual([]); // v2.160.0 is behind it: not deployed
      expect(w.at()).toBe('v2.161.0-rc.1');
      expect(existsSync(record)).toBe(false);
      const next = w.follow();
      expect(next.status).toBe(0);
      expect(lines(w.ran)).toEqual([]);
    });
  });

  it('deploys a published, immutable release whose manifest names the tag and its commit', () => {
    const w = world();
    w.release(); w.manifest();
    const r = w.follow();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lines(w.ran)).toEqual(['deploy v2.160.0']);
    expect(w.urls()).toEqual([
      'https://api.github.com/repos/hatchabot/hatchabot/releases/tags/v2.160.0',
      'https://github.com/hatchabot/hatchabot/releases/download/v2.160.0/release-manifest.json',
    ]);
  });

  it('refuses, without running any of the tag\'s code, a manifest for another commit, tag or version', () => {
    for (const [over, why] of [
      [{ commit: 'f'.repeat(40) }, /was built from f{40}, but the tag here is/],
      [{ tag: 'v2.159.9', version: '2.159.9' }, /is for "v2\.159\.9"/],
      [{ version: '2.160.1' }, /is for "v2\.160\.0" \("2\.160\.1"\)/],
    ] as const) {
      const w = world();
      w.release(); w.manifest(over);
      const r = w.follow();
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(why);
      expect(r.stdout).toContain('None of its code was run. It will not be retried');
      expect(lines(w.ran)).toEqual([]);
      expect(readFileSync(join(w.state, 'follow-latest-failed'), 'utf8').trim()).toBe('v2.160.0');
      // Set aside: the next tick does not look again.
      const before = w.urls().length;
      w.follow();
      expect(w.urls()).toHaveLength(before);
    }
  });

  it('refuses a release that is not immutable, or has no manifest', () => {
    for (const [setup, why] of [
      [(w: ReturnType<typeof world>) => { w.release({ immutable: false }); w.manifest(); }, /is not immutable/],
      [(w: ReturnType<typeof world>) => { w.release({ assets: [{ name: 'hatchabot-v2.160.0-linux-x64.tar.gz' }] }); w.manifest(); }, /has no release-manifest\.json/],
      [(w: ReturnType<typeof world>) => { w.release(); }, /listed but not there/],
    ] as const) {
      const w = world();
      setup(w);
      const r = w.follow();
      expect(r.stdout).toMatch(why);
      expect(lines(w.ran)).toEqual([]);
      expect(readFileSync(join(w.state, 'follow-latest-failed'), 'utf8').trim()).toBe('v2.160.0');
    }
  });

  it('a tag that is not (yet) a published release waits, longer each time, then is set aside', () => {
    const w = world();
    const first = w.follow();
    expect(first.stdout).toContain('Not deploying v2.160.0 yet: it is not a published release on GitHub. Looking again later (1 of 8)');
    w.follow();
    expect(w.urls()).toHaveLength(1); // too soon to look again
    writeFileSync(join(w.state, 'follow-latest-tries'), 'v2.160.0 7 0\n');
    expect(w.follow().stdout).toContain('8 times in a row. It will not be looked at again');
    expect(readFileSync(join(w.state, 'follow-latest-failed'), 'utf8').trim()).toBe('v2.160.0');
    expect(lines(w.ran)).toEqual([]);
  });

  it('no network: nothing deployed, nothing set aside, tried again next time', () => {
    const w = world();
    w.release(); w.manifest();
    writeFileSync(join(w.gh, 'offline'), '');
    const r = w.follow();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('GitHub did not answer');
    expect(existsSync(join(w.state, 'follow-latest-failed'))).toBe(false);
    rmSync(join(w.gh, 'offline'));
    expect(w.follow().status).toBe(0);
    expect(lines(w.ran)).toEqual(['deploy v2.160.0']);
  });

  it('a tag from before manifests (older than v2.159.0) is deployed as before, without asking GitHub', () => {
    const w = world('v2.158.9', 'v2.158.0');
    const r = w.follow();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lines(w.ran)).toEqual(['deploy v2.158.9']);
    expect(w.urls()).toEqual([]);
  });
});

describe('the follow timers refuse to guess where node and docker are (HB-0042)', () => {
  const tool = (name: string) => spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
  const BASH = tool('bash');
  /** A PATH of only what the install step uses, plus the shims asked for: no /usr/bin, where a real docker may be. */
  function sandbox(script: string, shims: string[], prod?: string) {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-path-')); dirs.push(root);
    const home = join(root, 'home'); mkdirSync(home, { recursive: true });
    const bin = join(root, 'bin'); mkdirSync(bin);
    for (const t of ['dirname', 'sed', 'cat', 'mkdir']) symlinkSync(tool(t), join(bin, t));
    for (const s of ['systemctl', ...shims]) writeFileSync(join(bin, s), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const app = join(root, 'app'); mkdirSync(join(app, 'scripts'), { recursive: true });
    for (const f of [script, 'systemd-quote.sh', 'follow-tries.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
    const run = (...args: string[]) => spawnSync(BASH, [join(app, 'scripts', script), '--install', ...args], { encoding: 'utf8', env: scriptEnv(home, bin, { HATCHABOT_PROD_DIR: prod ?? app }) });
    const unit = (name: string) => join(home, '.config', 'systemd', 'user', `${name}.service`);
    return { bin, run, unit };
  }
  for (const [script, args, name] of [['follow-channel.sh', ['stable'], 'hatchabot-follow-channel'], ['follow-latest.sh', [], 'hatchabot-follow-latest']] as const) {
    it(`${script} --install fails clearly without docker or node, and writes no unit`, () => {
      const noDocker = sandbox(script, ['node']);
      const r = noDocker.run(...args);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/docker not found on PATH/);
      expect(existsSync(noDocker.unit(name))).toBe(false);
      const noNode = sandbox(script, ['docker']);
      const n = noNode.run(...args);
      expect(n.status).toBe(1);
      expect(n.stderr).toMatch(/node not found on PATH/);
      expect(existsSync(noNode.unit(name))).toBe(false);
    });
    it(`${script} --install puts the node and docker it found on the unit's PATH`, () => {
      const both = sandbox(script, ['node', 'docker']);
      const r = both.run(...args);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(both.unit(name), 'utf8')).toContain(`Environment="PATH=${both.bin}:${both.bin}:/usr/local/bin:/usr/bin:/bin"`);
    });
  }
  it('follow-latest.sh --install writes a production folder with spaces, %, $, quotes and backslashes as systemd reads it (HB-0546)', () => {
    const prod = '/srv/production copy/50% a$b "q" back\\slash';
    const w = sandbox('follow-latest.sh', ['node', 'docker'], prod);
    const r = w.run();
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(w.unit('hatchabot-follow-latest'), 'utf8');
    const quoted = prod.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%');
    expect(text).toContain(`\nEnvironment="HATCHABOT_PROD_DIR=${quoted}"\n`);
    expect(text).toContain(`\nExecStart=/usr/bin/env bash "${quoted.replace(/\$/g, '$$$$')}/scripts/follow-latest.sh"\n`);
    // Read back as systemd does (quotes off, C escapes, %% and, in ExecStart, $$): the folder whole.
    const unquote = (v: string) => v.replace(/\\(.)|%%/g, (_m, c: string | undefined) => (c ?? '%'));
    const env = /^Environment="HATCHABOT_PROD_DIR=(.*)"$/m.exec(text)![1]!;
    expect(unquote(env)).toBe(prod);
    const exec = /^ExecStart=\/usr\/bin\/env bash "(.*)\/scripts\/follow-latest\.sh"$/m.exec(text)![1]!;
    expect(unquote(exec).replace(/\$\$/g, '$')).toBe(prod);
    // And systemd itself, where it is here: no assignment it cannot read.
    const analyze = '/usr/bin/systemd-analyze';
    if (existsSync(analyze)) {
      const unit = w.unit('hatchabot-follow-latest');
      const v = spawnSync(analyze, ['verify', '--man=no', '--generators=no', '--recursive-errors=no', unit], {
        encoding: 'utf8', env: scriptEnv(dirname(dirname(dirname(dirname(unit)))), '/usr/bin:/bin', { SYSTEMD_UNIT_PATH: `${dirname(unit)}:`, SYSTEMD_ENVIRONMENT_GENERATOR_PATH: '/dev/null', SYSTEMD_LOG_COLOR: '0' }),
      });
      expect(v.stderr).not.toContain('Invalid environment assignment');
    }
  });
});

describe('the timers and the deploy, tenth review', () => {
  function latestWorld() {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-latest-busy-')); dirs.push(root);
    const rc = join(root, 'rc.txt'), deploys = join(root, 'deploys.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(deploys)}\nexit "$(cat ${JSON.stringify(rc)})"\n` });
    for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
    const state = join(w.home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
    const follow = (code: number) => {
      writeFileSync(rc, String(code));
      return spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    };
    return { w, state, deploys, follow };
  }

  it('follow-latest.sh: a deploy that says 4 (another deploy or upgrade holds the lock) is routine: 0, nothing counted; the repair\'s too', () => {
    const { w, state, deploys, follow } = latestWorld();
    const busy = follow(4);
    expect(busy.status, busy.stdout + busy.stderr).toBe(0);
    expect(busy.stdout).toContain(`Another deploy or upgrade of ${w.prod} is running; this tick leaves v1.1.0 to it, or to the next tick.`);
    expect(existsSync(join(state, 'follow-latest-tries'))).toBe(false);
    expect(existsSync(join(state, 'follow-latest-failed'))).toBe(false);
    // A deploy of v1.1.0 cut off part-way, repaired by v1.1.0's own deploy script, which finds the lock held.
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
    w.git(w.prod, 'checkout', '-q', 'v1.1.0');
    writeFileSync(join(state, `upgrade-${key}.from`), 'from v1.1.0\nto v1.1.0\n');
    const repair = follow(4);
    expect(repair.status, repair.stdout + repair.stderr).toBe(0);
    expect(repair.stdout).toContain('it puts v1.1.0 back, or the next tick does');
    expect(lines(deploys)).toHaveLength(2);
    expect(existsSync(join(state, 'follow-latest-tries'))).toBe(false);
  });

  it('deploy-release.sh with a relative HATCHABOT_PROD_DIR, run from another folder: the disk judged and named where prod is', () => {
    const w = prodWorld();
    writeFileSync(join(w.bin, 'own-words-install'), '#!/bin/sh\necho "npm ERR! code EUSAGE" >&2\nexit 1\n', { mode: 0o755 });
    // df answers only for a path that is there, as the real one does.
    writeFileSync(join(w.bin, 'df'), '#!/bin/sh\n[ -e "$2" ] || { echo "df: $2: No such file or directory" >&2; exit 1; }\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/made-up 1000000 989760 10240 99% /"\n', { mode: 0o755 });
    const r = spawnSync('bash', [join(w.prod, 'scripts', 'deploy-release.sh'), 'v1.1.0'], {
      cwd: w.root, encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: 'prod', HATCHABOT_FOLLOW_KNOWS_5: '1', HATCHABOT_INSTALL_CMD: join(w.bin, 'own-words-install') },
    });
    expect(r.status, r.stdout + r.stderr).toBe(5);
    expect(r.stdout).toContain(`The disk holding ${w.prod} is full (10 MB free), so v1.1.0 could not be installed.`);
    expect(w.at()).toBe('v1.0.0');
    expect(readFileSync(join(w.prod, 'node_modules', 'marker'), 'utf8')).toBe('deps');
  });
});

describe('scripts/follow-latest.sh, fifteenth review: a repair the disk stopped waits; git\'s disk words are said_kind\'s', () => {
  function latest() {
    const root = mkdtempSync(join(tmpdir(), 'hb-follow-latest-15-')); dirs.push(root);
    const rc = join(root, 'rc.txt'), deploys = join(root, 'deploys.log');
    const w = prodWorld({ 'scripts/deploy-release.sh': `#!/usr/bin/env bash\necho "deploy $*" >> ${JSON.stringify(deploys)}\nexit "$(cat ${JSON.stringify(rc)})"\n` });
    for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
    const state = join(w.home, '.local', 'state', 'hatchabot'); mkdirSync(state, { recursive: true });
    const tries = join(state, 'follow-latest-tries');
    const key = execFileSync('bash', ['-c', 'printf %s "$1" | cksum | cut -d" " -f1', '_', w.prod], { encoding: 'utf8' }).trim();
    const cut = (record: string) => writeFileSync(join(state, `upgrade-${key}.from`), record);
    const follow = (code: number) => {
      writeFileSync(rc, String(code));
      return spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    };
    const ago = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;
    return { w, state, tries, deploys, cut, follow, ago };
  }

  it('a repair that says 5 (the disk) counts a try the disk failed, said; the next tick waits, then repairs again', () => {
    const { w, tries, deploys, cut, follow, ago } = latest();
    // A deploy of v1.1.0 cut off part-way, repaired by v1.1.0's own deploy script.
    w.git(w.prod, 'checkout', '-q', 'v1.1.0');
    cut('from v1.1.0\nto v1.1.0\n');
    const full = follow(5);
    expect(full.status, full.stdout + full.stderr).toBe(1);
    expect(full.stdout).toContain('Putting v1.1.0 back could not go ahead on this machine\'s disk (see above); it will be tried again later. This does not count against v1.1.0.');
    expect(readFileSync(tries, 'utf8')).toMatch(/^v1\.1\.0 1 \d+\n$/);
    expect(readFileSync(`${tries}.disk`, 'utf8')).toBe('v1.1.0 1\n');
    expect(follow(5).status).toBe(0); // waits
    expect(lines(deploys)).toHaveLength(1);
    writeFileSync(tries, `v1.1.0 1 ${ago(10)}\n`);
    expect(follow(0).status).toBe(0);
    expect(lines(deploys)).toHaveLength(2);
  });

  it('with a killed deploy to repair, the deploy of the newest tag waits on the disk\'s tries too (a $CUT no longer bypasses every wait)', () => {
    const { tries, deploys, cut, follow } = latest();
    cut('from v1.0.0\nto v1.1.0\n');
    const full = follow(5);
    expect(full.status, full.stdout + full.stderr).toBe(1);
    expect(readFileSync(`${tries}.disk`, 'utf8')).toBe('v1.1.0 1\n');
    expect(follow(5).status).toBe(0); // waits
    expect(lines(deploys)).toEqual(['deploy v1.1.0']);
  });

  it('git\'s words when it could not copy the deploy script: EDQUOT or a bare ENOSPC is the disk (disk_stop), as said_kind reads them', () => {
    for (const said of ['fatal: write failure on standard output: EDQUOT', 'fatal: write failure on standard output: ENOSPC']) {
      const { w, tries, deploys, follow } = latest();
      writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\ncase " $* " in *" show "*) echo ${JSON.stringify(said)} >&2; exit 128 ;; esac\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`, { mode: 0o755 });
      const r = follow(0);
      expect(r.status, said + ': ' + r.stdout + r.stderr).toBe(1);
      expect(r.stdout, said).toContain(`(${said}) (a full disk?), so this tick stops before changing anything. This does not count against v1.1.0; the next ticks wait.`);
      expect(readFileSync(`${tries}.disk`, 'utf8'), said).toBe('v1.1.0 1\n');
      expect(lines(deploys)).toEqual([]);
    }
  });
});
