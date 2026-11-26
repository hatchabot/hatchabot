import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hangingStep, scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/upgrade-helpers.sh: the helpers upgrade.sh and deploy-release.sh
 * share, one file where each kept a copy (HB-0636). Both run while the
 * release under them changes, and across releases: any release's timer runs
 * a release's deploy script as a temporary copy with nothing beside it, and
 * a script of a release before the file carries its own helpers. So each
 * reads the file once, at its start, by its git blob id, and stops before it
 * changes anything when it finds none. Every script here runs in a sandbox:
 * a temp HOME and TMPDIR, a PATH of shims and the system dirs, git hooks off,
 * throwaway repositories, and an environment built from scratch.
 */
vi.setConfig({ testTimeout: 60_000 });

const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const BASH = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
const LIB = readFileSync('scripts/upgrade-helpers.sh', 'utf8');
const UPGRADE = readFileSync('scripts/upgrade.sh', 'utf8');
const DEPLOY = readFileSync('scripts/deploy-release.sh', 'utf8');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** What `git hash-object` says of `text`: its git blob id. */
const blobOf = (text: string) => { const b = Buffer.from(text); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };

/** A helpers file put where a script must not read it: it says so at once, and its lock helper ends the run. */
const PLANTED = 'echo "PLANTED helpers read"\nupgrade_helpers_end() { :; }\ntake_lock() { echo "PLANTED take_lock"; exit 99; }\n';

/** deploy-release.sh as a release before the file ships it: the helpers written into it, and no loader. */
function selfContainedDeploy(): string {
  const from = DEPLOY.indexOf('\nHELPERS_BLOB=') + 1, end = '\nunset HELPERS\n', to = DEPLOY.indexOf(end) + end.length;
  expect(from).toBeGreaterThan(0); expect(to).toBeGreaterThan(from);
  const s = DEPLOY.slice(0, from) + LIB + DEPLOY.slice(to);
  expect(s).not.toMatch(/^HELPERS_BLOB=/m);
  return s;
}

/** upgrade.sh as a release before the file has it: the helpers written into it, its copy made with cp. */
function selfContainedUpgrade(): string {
  const from = UPGRADE.indexOf('\nHELPERS_BLOB=') + 1, guard = UPGRADE.indexOf('declare -F upgrade_helpers_end'), to = UPGRADE.indexOf('\n', guard) + 1;
  expect(from).toBeGreaterThan(0); expect(guard).toBeGreaterThan(from);
  const oldCopy = 'if [ -z "${HATCHABOT_UPGRADE_COPY:-}" ]; then\n'
    + '  tmp="$(mktemp)" && cp "$0" "$tmp" || { echo "Could not make a temporary copy of this script (a full disk?): nothing was changed. Free some space, then try again."; exit 5; }\n'
    + '  HATCHABOT_UPGRADE_COPY="$tmp" HATCHABOT_UPGRADE_DIR="$DIR" exec bash "$tmp" "$@"\n'
    + 'fi\nDIR="$HATCHABOT_UPGRADE_DIR"; cd "$DIR"\n';
  const s = UPGRADE.slice(0, from) + LIB + oldCopy + UPGRADE.slice(to);
  expect(s).not.toMatch(/^HELPERS_BLOB=/m);
  return s;
}

type Files = Record<string, string | null>;
/**
 * A throwaway origin with one tag per entry, each its files on top of the one
 * before (null removes one), and a clone of it on the first tag with its
 * dependencies (node_modules/marker). The shims: a systemctl and an npm that
 * write down what they were asked, and a curl that answers as the release
 * checked out serves (deploy-release.sh's serving check).
 */
function world(tags: Array<[string, Files]>) {
  const root = mkdtempSync(join(tmpdir(), 'hb-helpers-')); dirs.push(root);
  const home = join(root, 'home'), bin = join(root, 'bin'), tmp = join(root, 'tmp');
  for (const d of [home, bin, tmp]) mkdirSync(d, { recursive: true });
  const log = join(root, 'calls.log');
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\necho "npm $*" >> ${JSON.stringify(log)}\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\nv="$(sed -n \'s/.*"version":"\\([^"]*\\)".*/\\1/p\' package.json)"\necho "<script>window.HATCHABOT_VERSION=\\"$v\\"</script>"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'fake-restart'), `#!/usr/bin/env bash\necho restart >> ${JSON.stringify(log)}\nexit "\${FAKE_RESTART_RC:-0}"\n`, { mode: 0o755 });
  symlinkSync(process.execPath, join(bin, 'node'));
  const env = scriptEnv(home, `${bin}:/usr/bin:/bin`, { TMPDIR: tmp });
  const git = (cwd: string, ...args: string[]) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  const src = join(root, 'src'); mkdirSync(join(src, 'scripts'), { recursive: true });
  git(src, 'init', '-q', '-b', 'main');
  writeFileSync(join(src, '.gitignore'), 'node_modules/\nnode_modules.prev/\ndata/\n');
  writeFileSync(join(src, 'scripts', 'release-target.sh'), readFileSync('scripts/release-target.sh'), { mode: 0o755 });
  for (const [tag, files] of tags) {
    const v = tag.slice(1);
    writeFileSync(join(src, 'package.json'), `{"name":"x","version":"${v}"}\n`);
    writeFileSync(join(src, 'channels.json'), `{"stable":"${tag}","beta":"${tag}"}\n`);
    for (const [f, body] of Object.entries(files)) {
      if (body === null) rmSync(join(src, f), { force: true });
      else writeFileSync(join(src, f), body, { mode: f.endsWith('helpers.sh') ? 0o644 : 0o755 });
    }
    git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', tag); git(src, 'tag', tag);
  }
  const origin = join(root, 'origin.git');
  git(root, 'clone', '-q', '--bare', src, origin);
  const prod = join(root, 'prod');
  git(root, 'clone', '-q', origin, prod);
  git(prod, 'checkout', '-q', tags[0]![0]);
  mkdirSync(join(prod, 'node_modules')); writeFileSync(join(prod, 'node_modules', 'marker'), 'deps');
  const state = join(home, '.local', 'state', 'hatchabot');
  const at = () => git(prod, 'describe', '--tags', '--exact-match');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  /** upgrade.sh of the release checked out, as the channel timer and `hatchabot upgrade` run it. */
  const upgrade = (extra: Record<string, string> = {}, args = ['stable'], from?: { cwd: string; script: string }) => spawnSync('bash', [from?.script ?? join(prod, 'scripts', 'upgrade.sh'), ...args], {
    cwd: from?.cwd, encoding: 'utf8', env: { ...env, HATCHABOT_RESTART_CMD: join(bin, 'fake-restart'), HATCHABOT_UPGRADE_IMAGE: '0', HATCHABOT_INSTALL_CMD: 'true', ...extra },
  });
  return { root, home, bin, tmp, env, git, src, prod, state, at, calls, upgrade };
}
type World = ReturnType<typeof world>;

/** The deploy script TAG ships, run as every follow-latest.sh since v2.34.6 runs it: a temporary copy, nothing beside it. */
const OLD_TICK = 'set -u\ndeploy="$(mktemp)"\ngit -C "$PROD" show "$1:scripts/deploy-release.sh" > "$deploy" || exit 9\nrc=0; HATCHABOT_PROD_DIR="$PROD" bash "$deploy" "$1" || rc=$?\nrm -f "$deploy"\nexit "$rc"\n';
const oldTick = (w: World, tag: string) => spawnSync('bash', ['-c', OLD_TICK, '_', tag], { encoding: 'utf8', env: { ...w.env, PROD: w.prod } });
/** This release's follow-latest.sh, beside its follow-tries.sh, as its timer runs it. */
const followLatest = (w: World) => {
  for (const f of ['follow-latest.sh', 'follow-tries.sh']) writeFileSync(join(w.root, f), readFileSync(join('scripts', f)), { mode: 0o755 });
  return spawnSync('bash', [join(w.root, 'follow-latest.sh')], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
};
const NEW_DEPLOY: Files = { 'scripts/deploy-release.sh': DEPLOY, 'scripts/upgrade-helpers.sh': LIB };
const OLD_DEPLOY: Files = { 'scripts/deploy-release.sh': selfContainedDeploy(), 'scripts/upgrade-helpers.sh': null };
const NEW_UPGRADE: Files = { 'scripts/upgrade.sh': UPGRADE, 'scripts/upgrade-helpers.sh': LIB };
const OLD_UPGRADE: Files = { 'scripts/upgrade.sh': selfContainedUpgrade(), 'scripts/upgrade-helpers.sh': null };
const NO_HELPERS_LINE = 'needs scripts/upgrade-helpers.sh as its own release has it';

describe('scripts/upgrade-helpers.sh, the helpers upgrade.sh and deploy-release.sh share (HB-0636)', () => {
  it('each script names the file by its git blob id, so each reads only the one it was made with', () => {
    const want = `HELPERS_BLOB=${blobOf(LIB)}`;
    for (const f of ['scripts/upgrade.sh', 'scripts/deploy-release.sh']) {
      const got = readFileSync(f, 'utf8').match(/^HELPERS_BLOB=.*$/gm) ?? [];
      expect(got, `scripts/upgrade-helpers.sh changed: set this line in ${f}: ${want}`).toEqual([want]);
    }
  });

  it('is definitions only: read by a bash with no command to run, it says nothing, ends with upgrade_helpers_end, and lets no SYSTEMD_MAJOR in', () => {
    expect(LIB.startsWith('#!')).toBe(false);
    const r = spawnSync(BASH, ['--norc', '--noprofile', '-c', 'set -euo pipefail; . "$1"; declare -F; echo "major=${SYSTEMD_MAJOR-unset}"', '_', join(process.cwd(), 'scripts', 'upgrade-helpers.sh')], {
      encoding: 'utf8', env: { PATH: '/nonexistent', SYSTEMD_MAJOR: '252' },
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const defined = r.stdout.trim().split('\n').map((l) => l.replace(/^declare -f /, ''));
    expect(defined.pop()).toBe('major=unset');
    const named = [...LIB.matchAll(/^([a-z_][a-z0-9_]*)\(\) \{/gm)].map((m) => m[1]!);
    expect(named.at(-1)).toBe('upgrade_helpers_end');
    expect([...defined].sort()).toEqual([...named].sort());
  });
});

describe('deploy-release.sh reads its helpers as every release\'s timer runs it (HB-0636)', () => {
  it('an older timer\'s tick (git show TAG:scripts/deploy-release.sh into a temporary file, nothing beside it) deploys this release: the helpers come from the checkout\'s git, never from a file planted beside the copy', () => {
    const w = world([['v1.0.0', NEW_DEPLOY], ['v1.1.0', { 'scripts/ensure-deps.sh': '#!/usr/bin/env bash\nexit 0\n' }]]);
    writeFileSync(join(w.tmp, 'upgrade-helpers.sh'), PLANTED);
    const r = oldTick(w, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('PLANTED');
    expect(w.at()).toBe('v1.1.0');
    expect(readdirSync(w.tmp)).toEqual(['upgrade-helpers.sh']);
  });

  it('a release whose helpers its checkout\'s git has not got stops before it changes anything, and says so (2), a file planted beside the copy or not', () => {
    for (const planted of [false, true]) {
      const w = world([['v1.0.0', { 'scripts/deploy-release.sh': DEPLOY }], ['v1.1.0', {}]]);
      if (planted) writeFileSync(join(w.tmp, 'upgrade-helpers.sh'), PLANTED);
      const r = oldTick(w, 'v1.1.0');
      expect(r.status, `planted ${planted}: ${r.stdout}${r.stderr}`).toBe(2);
      expect(r.stdout).toContain(`This deploy-release.sh ${NO_HELPERS_LINE}, and found it neither in ${w.prod}'s git nor beside it, so nothing was changed.`);
      expect(r.stdout + r.stderr).not.toContain('PLANTED');
      expect(w.at()).toBe('v1.0.0');
      expect(existsSync(w.state), 'no lock, no record').toBe(false);
      expect(existsSync(join(w.prod, 'node_modules', 'marker'))).toBe(true);
      expect(w.calls()).toEqual([]);
    }
  });

  it('run from a checkout (hbt deploy) whose helpers the production checkout\'s git has not got: the file beside it, once git says it is that file', () => {
    const w = world([['v1.0.0', { 'scripts/deploy-release.sh': selfContainedDeploy() }], ['v1.1.0', {}]]);
    const dev = join(w.root, 'dev', 'scripts'); mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, 'deploy-release.sh'), DEPLOY, { mode: 0o755 });
    const deploy = () => spawnSync('bash', [join(dev, 'deploy-release.sh'), 'v1.1.0'], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    // Edited since its id was written: not the one it was made with.
    writeFileSync(join(dev, 'upgrade-helpers.sh'), LIB + PLANTED);
    const edited = deploy();
    expect(edited.status, edited.stdout + edited.stderr).toBe(2);
    expect(edited.stdout).toContain(NO_HELPERS_LINE);
    expect(edited.stdout + edited.stderr).not.toContain('PLANTED');
    expect(w.at()).toBe('v1.0.0');
    writeFileSync(join(dev, 'upgrade-helpers.sh'), LIB);
    // By a relative path, with an exported CDPATH (cd then says the folder it found).
    const r = spawnSync('bash', ['dev/scripts/deploy-release.sh', 'v1.1.0'], { cwd: w.root, encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod, CDPATH: `.:${join(w.root, 'no-such')}` } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.at()).toBe('v1.1.0');
  });

  it('a deploy of an older tag whose helpers differ from its own (hbt deploy of a rollback) runs its own, by their id, never the tag\'s', () => {
    const w = world([['v1.0.0', { 'scripts/deploy-release.sh': DEPLOY, 'scripts/upgrade-helpers.sh': LIB + PLANTED }], ['v1.1.0', { 'scripts/upgrade-helpers.sh': LIB }]]);
    w.git(w.prod, 'checkout', '-q', 'v1.1.0');
    const dev = join(w.root, 'dev', 'scripts'); mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, 'deploy-release.sh'), DEPLOY, { mode: 0o755 });
    const r = spawnSync('bash', [join(dev, 'deploy-release.sh'), 'v1.0.0'], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    expect(r.stdout + r.stderr).not.toContain('PLANTED');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.at()).toBe('v1.0.0');
  });

  it('helpers that are the file it names but do not end with upgrade_helpers_end (cut short) are not run on: 2, nothing changed', () => {
    const w = world([['v1.0.0', { 'scripts/deploy-release.sh': DEPLOY }], ['v1.1.0', {}]]);
    const short = LIB.slice(0, LIB.indexOf('upgrade_helpers_end() {'));
    expect(short.length).toBeGreaterThan(1000);
    const dev = join(w.root, 'dev', 'scripts'); mkdirSync(dev, { recursive: true });
    writeFileSync(join(dev, 'deploy-release.sh'), DEPLOY.replace(/^HELPERS_BLOB=.*$/m, `HELPERS_BLOB=${blobOf(short)}`), { mode: 0o755 });
    writeFileSync(join(dev, 'upgrade-helpers.sh'), short);
    const r = spawnSync('bash', [join(dev, 'deploy-release.sh'), 'v1.1.0'], { encoding: 'utf8', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod } });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(NO_HELPERS_LINE);
    expect(w.at()).toBe('v1.0.0');
    expect(existsSync(w.state)).toBe(false);
    expect(w.calls()).toEqual([]);
  });

  it('this release\'s follow-latest.sh deploys a tag whose deploy script is a release\'s from before the file, which carries its own helpers', () => {
    const w = world([['v1.0.0', NEW_DEPLOY], ['v1.1.0', OLD_DEPLOY]]);
    const r = followLatest(w);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Following latest: v1.0.0 → v1.1.0');
    expect(w.at()).toBe('v1.1.0');
    expect(readdirSync(w.tmp)).toEqual([]);
  });

  it('this release\'s follow-latest.sh puts a deploy cut off part-way back with the deploy script of the release it came from, one from before the file', async () => {
    const w = world([['v1.0.0', OLD_DEPLOY], ['v1.1.0', NEW_DEPLOY]]);
    // The deploy of v1.1.0, run as a timer runs it, killed in its install.
    const copy = join(w.tmp, 'deploy-copy');
    writeFileSync(copy, w.git(w.prod, 'show', 'v1.1.0:scripts/deploy-release.sh') + '\n');
    const started = join(w.root, 'started');
    writeFileSync(join(w.bin, 'hanging-step'), hangingStep(started), { mode: 0o755 });
    const p = spawn('bash', [copy, 'v1.1.0'], { detached: true, stdio: 'ignore', env: { ...w.env, HATCHABOT_PROD_DIR: w.prod, HATCHABOT_INSTALL_CMD: join(w.bin, 'hanging-step') } });
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (existsSync(started)) { clearInterval(poll); process.kill(-p.pid!, 'SIGKILL'); }
        else if (Date.now() - t0 > 20_000) { clearInterval(poll); process.kill(-p.pid!, 'SIGKILL'); reject(new Error('never reached the install')); }
      }, 20);
      p.on('exit', () => resolve());
    });
    rmSync(copy);
    expect(w.at()).toBe('v1.1.0');
    const record = readdirSync(w.state).find((n) => n.endsWith('.from'));
    expect(record, 'the cut-off deploy\'s record').toBeTruthy();
    expect(readFileSync(join(w.state, record!), 'utf8')).toMatch(/^from v1\.0\.0$/m);
    // v1.1.0 set aside: the tick only repairs, with v1.0.0's own deploy script.
    writeFileSync(join(w.state, 'follow-latest-failed'), 'v1.1.0\n');
    const r = followLatest(w);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('This tick repairs the deploy that was cut off, and only that.');
    expect(r.stdout).toContain('Serving 1.0.0.');
    expect(w.at()).toBe('v1.0.0');
    expect(existsSync(join(w.state, record!))).toBe(false);
    // Put back, then installed again and restarted, as that release's deploy does.
    expect(existsSync(join(w.prod, 'node_modules', 'half-installed'))).toBe(false);
    expect(existsSync(join(w.prod, 'node_modules.prev'))).toBe(false);
    expect(w.calls()).toEqual(['npm ci --silent', 'systemctl --user restart hatchabot']);
  });
});

describe('upgrade.sh puts its helpers in the temporary copy it runs from (HB-0636)', () => {
  it('the copy needs nothing of the tree once it runs: an upgrade onto a release from before the file, which takes the file away, rolls back and goes on whole, and leaves nothing in TMPDIR', () => {
    const w = world([['v1.0.0', NEW_UPGRADE], ['v1.1.0', OLD_UPGRADE]]);
    const down = w.upgrade({ FAKE_RESTART_RC: '1' });
    expect(down.status, down.stdout + down.stderr).toBe(1);
    expect(w.at()).toBe('v1.0.0');
    expect(readFileSync(join(w.prod, 'scripts', 'upgrade-helpers.sh'), 'utf8')).toBe(LIB);
    expect(w.calls()).toEqual(['restart', 'restart']); // onto the new one, then back onto the old
    expect(readdirSync(w.tmp)).toEqual([]);
    const up = w.upgrade();
    expect(up.status, up.stdout + up.stderr).toBe(0);
    expect(w.at()).toBe('v1.1.0');
    expect(existsSync(join(w.prod, 'scripts', 'upgrade-helpers.sh'))).toBe(false);
    expect(readdirSync(w.tmp)).toEqual([]);
  });

  it('an upgrade.sh from before the file upgrades onto this release, whose own upgrade.sh then reads the file from the install\'s git', () => {
    const w = world([['v1.0.0', OLD_UPGRADE], ['v1.1.0', NEW_UPGRADE]]);
    const up = w.upgrade();
    expect(up.status, up.stdout + up.stderr).toBe(0);
    expect(w.at()).toBe('v1.1.0');
    const again = w.upgrade();
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('Already on v1.1.0');
    expect(readdirSync(w.tmp)).toEqual([]);
  });

  it('a git install whose file beside it is not the one it was made with (an upgrade cut off in its checkout) reads the one from git, never that file', () => {
    const w = world([['v1.0.0', NEW_UPGRADE], ['v1.1.0', {}]]);
    writeFileSync(join(w.prod, 'scripts', 'upgrade-helpers.sh'), PLANTED);
    const r = w.upgrade();
    expect(r.stdout + r.stderr).not.toContain('PLANTED');
    // The helpers it read take the lock and find the change: refused, as any local change is.
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(`${w.prod} has local changes — an upgrade would overwrite them.`);
    expect(w.at()).toBe('v1.0.0');
  });

  it('run by a relative path from outside the install (bash upgrade.sh in scripts/, or ../install/scripts/upgrade.sh) it copies itself and upgrades, and leaves no temporary file', () => {
    for (const how of ['in scripts/', 'from beside the install'] as const) {
      const w = world([['v1.0.0', NEW_UPGRADE], ['v1.1.0', {}]]);
      const beside = join(w.root, 'elsewhere'); mkdirSync(beside);
      const from = how === 'in scripts/' ? { cwd: join(w.prod, 'scripts'), script: 'upgrade.sh' } : { cwd: beside, script: '../prod/scripts/upgrade.sh' };
      const r = w.upgrade({}, ['stable'], from);
      expect(r.status, `${how}: ${r.stdout}${r.stderr}`).toBe(0);
      expect(r.stdout, how).not.toContain('a full disk?');
      expect(w.at(), how).toBe('v1.1.0');
      expect(readdirSync(w.tmp), how).toEqual([]);
    }
  });

  it('found neither in git nor beside it, or not the one it was made with: it stops before it takes the lock or changes anything, and says so (2)', () => {
    for (const lib of [null, LIB + '# edited\n']) {
      const w = world([['v1.0.0', { 'scripts/upgrade.sh': UPGRADE, 'scripts/upgrade-helpers.sh': lib }], ['v1.1.0', {}]]);
      const r = w.upgrade();
      expect(r.status, r.stdout + r.stderr).toBe(2);
      expect(r.stdout).toContain(`This upgrade.sh ${NO_HELPERS_LINE}, and found it neither in ${w.prod}'s git nor beside it, so nothing was changed.`);
      expect(w.at()).toBe('v1.0.0');
      expect(existsSync(w.state), 'no lock, no record').toBe(false);
      expect(readdirSync(w.tmp)).toEqual([]);
      expect(w.calls()).toEqual([]);
    }
  });

  it('a bundle install with no file beside it stops the same way; a copy run without its helpers too', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-helpers-bundle-')); dirs.push(root);
    const home = join(root, 'home'), tmp = join(root, 'tmp'), bin = join(root, 'bin'), app = join(root, 'hatchabot');
    for (const d of [home, tmp, bin, join(app, 'scripts')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\necho "curl: no network in a test" >&2\nexit 7\n', { mode: 0o755 });
    writeFileSync(join(app, 'scripts', 'upgrade.sh'), UPGRADE, { mode: 0o755 });
    writeFileSync(join(app, 'VERSION'), 'v1.0.0');
    writeFileSync(join(app, 'BUNDLE.json'), JSON.stringify({ version: '1.0.0', tag: 'v1.0.0', platform: 'linux-arm64' }) + '\n');
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`, { TMPDIR: tmp, HATCHABOT_UPGRADE_IMAGE: '0' });
    const before = readdirSync(app).sort();
    const r = spawnSync('bash', [join(app, 'scripts', 'upgrade.sh'), 'stable'], { encoding: 'utf8', env });
    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stdout).toContain(`This upgrade.sh ${NO_HELPERS_LINE}, and found it neither in ${app}'s git nor beside it, so nothing was changed.`);
    expect(readdirSync(app).sort()).toEqual(before);
    expect(existsSync(join(home, '.local'))).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
    // With the file beside it, run by hand as install.sh runs it, and with an
    // exported CDPATH (cd then says the folder it found): found, and on to
    // the release (no network here: 3).
    writeFileSync(join(app, 'scripts', 'upgrade-helpers.sh'), LIB, { mode: 0o644 });
    for (const [script, extra] of [['./scripts/upgrade.sh', {}], ['scripts/upgrade.sh', { CDPATH: `.:${join(root, 'no-such')}` }]] as const) {
      const found = spawnSync('bash', [script, 'stable'], { encoding: 'utf8', env: { ...env, ...extra }, cwd: app });
      expect(found.stdout + found.stderr, script).not.toContain(NO_HELPERS_LINE);
      expect(found.status, found.stdout + found.stderr).toBe(3);
      expect(found.stdout).toContain('Could not find which release stable names now');
      expect(readdirSync(tmp)).toEqual([]);
    }
    // A copy it could not finish writing (the file, or itself after it): 5, the disk's, and no copy left.
    for (const what of ['upgrade-helpers.sh', 'upgrade.sh']) {
      const shims = join(root, `full-${what}`); mkdirSync(shims);
      writeFileSync(join(shims, 'cat'), `#!/usr/bin/env bash\ncase "$1" in */${what}) echo "cat: write error: No space left on device" >&2; exit 1 ;; esac\nexec /bin/cat "$@"\n`, { mode: 0o755 });
      const full = spawnSync('bash', [join(app, 'scripts', 'upgrade.sh'), 'stable'], { encoding: 'utf8', env: { ...env, PATH: `${shims}:${env.PATH}` } });
      expect(full.status, `${what}: ${full.stdout}${full.stderr}`).toBe(5);
      expect(full.stdout).toContain('Could not make a temporary copy of this script (a full disk?): nothing was changed.');
      expect(readdirSync(tmp), what).toEqual([]);
    }
    // What those runs made (their records) goes, for the run below.
    for (const p of [join(app, 'scripts', 'upgrade-helpers.sh'), join(app, 'data'), join(home, '.local')]) rmSync(p, { recursive: true, force: true });
    // As its copy, but not made by it (HATCHABOT_UPGRADE_COPY set): no helpers, so it stops.
    const copy = spawnSync('bash', [join(app, 'scripts', 'upgrade.sh'), 'stable'], { encoding: 'utf8', env: { ...env, HATCHABOT_UPGRADE_COPY: join(tmp, 'not-a-copy'), HATCHABOT_UPGRADE_DIR: app } });
    expect(copy.status, copy.stdout + copy.stderr).toBe(2);
    expect(copy.stdout).toContain('This run of upgrade.sh has not got the helpers it needs (scripts/upgrade-helpers.sh), so nothing was changed.');
    expect(readdirSync(app).sort()).toEqual(before);
    expect(existsSync(join(home, '.local'))).toBe(false);
  });
});
