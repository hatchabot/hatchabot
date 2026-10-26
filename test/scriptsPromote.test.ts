import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts (git, bash, a fake gh) in a sandbox. On the
// self-hosted runner CI shares the machine with other work, and vitest's 5 s was not
// enough under load (land, promote, release, first-run-link; 2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * scripts/promote.sh in a sandbox: a throwaway repo with a local bare
 * "origin" (the dev repo) and "public" (the public repo, which has the
 * published tags), a temp HOME, hooks off, PATH confined to the system dirs.
 * It used to stamp every promote commit with a fixed Co-Authored-By and an
 * old session URL (review, 2026-09-29); trailers now come only from the
 * caller.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hb-promote-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  // A fake gh ahead of the real one (/usr/bin/gh): CI's answer comes from
  // HB_CI — "success" (default), "failure", "running:success", "running:failure" (listed as
  // in progress the first time, then finished so), "running" (never finishes), "none",
  // "pr-only" (a passing pull-request run on the commit, and no run for the push to main).
  // `gh run watch` answers as it does for a fine-grained token: HTTP 403 (audit #036).
  // HB_DEV_NONE: the dev repo has no run (a release from before it), the public repo answers.
  // The tag's GitHub release from HB_RELEASE — "ok" (default; published, with the
  // manifest), "none" (gh fails: no release), "draft", "nomanifest".
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
ci="\${HB_CI:-success}"
echo "gh $*" >> ${JSON.stringify(join(root, 'gh.log'))}
case "$1 $2" in
  "release view")
    case "\${HB_RELEASE:-ok}" in ok) echo "false true" ;; draft) echo "true true" ;; nomanifest) echo "false false" ;; *) echo "release not found" >&2; exit 1 ;; esac ;;
  "run list")
    case "$*" in *"--repo cksci/hatchabot-dev "*) [ -z "\${HB_DEV_NONE:-}" ] || exit 0 ;; esac
    case "$ci" in none) ;; pr-only) case "$*" in *"--event push"*) ;; *) echo "4243 completed success" ;; esac ;;
      running) echo "4242 in_progress " ;;
      running:*) if [ -f ${JSON.stringify(join(root, 'listed'))} ]; then echo "4242 completed \${ci#running:}"; else touch ${JSON.stringify(join(root, 'listed'))}; echo "4242 in_progress "; fi ;;
      *) echo "4242 completed $ci" ;; esac ;;
  "run watch") echo "HTTP 403: Resource not accessible by personal access token" >&2; exit 1 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const origin = join(root, 'origin.git');
  const pub = join(root, 'public.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '--bare', '-b', 'main', pub);
  const work = join(root, 'work'); mkdirSync(join(work, 'scripts'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'scripts', 'promote.sh'), readFileSync('scripts/promote.sh'), { mode: 0o755 });
  // promote.sh lands through land.sh; this throwaway remote has no pull-request rule.
  writeFileSync(join(work, 'scripts', 'land.sh'), readFileSync('scripts/land.sh'), { mode: 0o755 });
  writeFileSync(join(work, 'channels.json'), '{\n  "stable": "v1.0.0",\n  "beta": "v1.0.0"\n}\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'tag', 'v1.1.0');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', '--tags', 'origin', 'main');
  git(work, 'remote', 'add', '--no-tags', 'public', pub);
  /** The publisher published it: the public repo has the tag. */
  const publish = (tag: string) => git(work, 'push', '-q', pub, `refs/tags/${tag}`);
  git(work, 'push', '-q', pub, 'main');
  publish('v1.1.0');
  const promote = (extra: Record<string, string> = {}, ...args: string[]) =>
    spawnSync('bash', [join(work, 'scripts', 'promote.sh'), ...args], { cwd: work, env: { ...env, HATCHABOT_LAND_DIRECT: '1', HATCHABOT_DISPATCH_POLL: '0', ...extra }, encoding: 'utf8' });
  const channels = () => readFileSync(join(work, 'channels.json'), 'utf8');
  /** The fast-lane tags on origin: "name commit subject". */
  const fastLane = () => git(origin, 'for-each-ref', '--format=%(refname:short) %(*objectname) %(contents:subject)', 'refs/tags/channels-*').trim();
  /** The publisher's fast lane for a tag (the newest by default): its channels.json on the
   *  public main as an "Update channels" commit dated with the tag's date, as publish.py makes it. */
  const publishFastLane = (name?: string) => {
    const tag = name ?? fastLane().split('\n').pop()!.split(' ')[0]!;
    const date = git(origin, 'for-each-ref', '--format=%(taggerdate:unix)', `refs/tags/${tag}`).trim();
    const pw = join(root, 'pubfl');
    if (!existsSync(pw)) git(root, 'clone', '-q', pub, pw);
    git(pw, 'fetch', '-q', 'origin'); git(pw, 'reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(pw, 'channels.json'), git(origin, 'show', `${tag}:channels.json`));
    const r = spawnSync('git', ['commit', '-qam', 'Update channels'], { cwd: pw, encoding: 'utf8',
      env: { ...env, GIT_AUTHOR_DATE: `@${date} +0000`, GIT_COMMITTER_DATE: `@${date} +0000` } });
    if (r.status !== 0) throw new Error(r.stderr);
    git(pw, 'push', '-q', 'origin', 'HEAD:main');
  };
  return { root, bin, origin, pub, work, git, promote, channels, publish, fastLane, publishFastLane };
}

describe('scripts/promote.sh', () => {
  it('commits with no trailer of its own', () => {
    const w = world();
    const r = w.promote({}, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const msg = w.git(w.work, 'log', '-1', '--format=%B');
    expect(msg.trim()).toBe('Promote v1.1.0 to stable');
    expect(msg).not.toMatch(/Claude-Session|Co-Authored-By/);
  });

  it('adds the trailers the caller passes', () => {
    const w = world();
    const r = w.promote({ HATCHABOT_PROMOTE_TRAILERS: 'Co-Authored-By: Someone <someone@example.com>' }, 'v1.1.0', 'beta');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.git(w.work, 'log', '-1', '--format=%B').trim()).toBe('Promote v1.1.0 to beta\n\nCo-Authored-By: Someone <someone@example.com>');
  });
});

describe('scripts/promote.sh asks CI first (it was red for eight days unseen, 2026-10-06)', () => {
  it('passed: promotes', () => {
    const w = world();
    const r = w.promote({}, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ CI passed on v1.1.0');
    expect(w.channels()).toContain('"stable": "v1.1.0"');
  });

  it('failed: refuses, names the run, changes nothing', () => {
    const w = world();
    const r = w.promote({ HB_CI: 'failure' }, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('CI failed on v1.1.0 (failure): https://github.com/cksci/hatchabot-dev/actions/runs/4242');
    expect(w.channels()).toContain('"stable": "v1.0.0"');
  });

  it('still running: waits, then follows the result', () => {
    const ok = world();
    const a = ok.promote({ HB_CI: 'running:success' }, 'v1.1.0');
    expect(a.status, a.stdout + a.stderr).toBe(0);
    expect(a.stdout).toContain('still running — waiting');
    const bad = world();
    const b = bad.promote({ HB_CI: 'running:failure' }, 'v1.1.0');
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('CI failed on v1.1.0 (failure)');
    expect(bad.channels()).toContain('"stable": "v1.0.0"');
  });

  it('a run still going is polled through the run listing, not `gh run watch` (a fine-grained token cannot read its annotations; audit #036)', () => {
    const w = world();
    const r = w.promote({ HB_CI: 'running:success' }, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const log = readFileSync(join(w.root, 'gh.log'), 'utf8');
    expect(log).not.toContain('run watch');
    expect(log.match(/gh run list/g)).toHaveLength(2);
    expect(w.channels()).toContain('"stable": "v1.1.0"');
    // One that never finishes: refused at the wait's end, said as still running, nothing changed.
    const slow = world();
    const s = slow.promote({ HB_CI: 'running', HATCHABOT_CI_WAIT_SECS: '0' }, 'v1.1.0');
    expect(s.status).toBe(1);
    expect(s.stderr).toContain('CI for v1.1.0 is still running after 0 min');
    expect(s.stderr).not.toContain('CI failed');
    expect(slow.channels()).toContain('"stable": "v1.0.0"');
  });

  it('no run for the commit: refuses, and says how to go on without the check', () => {
    const w = world();
    const r = w.promote({ HB_CI: 'none' }, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No CI run for v1\.1\.0 .*HATCHABOT_PROMOTE_IGNORE_CI=1/);
    const forced = w.promote({ HB_CI: 'none', HATCHABOT_PROMOTE_IGNORE_CI: '1' }, 'v1.1.0');
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(forced.stdout).toContain('CI not checked');
  });

  it('a release from before the dev repo: its CI run is the public repo\'s', () => {
    const w = world();
    const r = w.promote({ HB_DEV_NONE: '1' }, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(w.root, 'gh.log'), 'utf8')).toContain('run list --repo hatchabot/hatchabot --workflow ci.yml');
  });

  it('a rollback is not held to CI', () => {
    const w = world();
    w.git(w.work, 'tag', 'v0.9.0'); w.publish('v0.9.0');
    // Built from scratch, as every script test's environment is (review, 2026-10-09).
    const r = spawnSync('bash', [join(w.work, 'scripts', 'promote.sh'), 'v0.9.0'], {
      cwd: w.work, encoding: 'utf8', input: 'y\n',
      env: scriptEnv(join(w.work, '..', 'home'), `${join(w.work, '..', 'bin')}:/usr/bin:/bin`, { HB_CI: 'failure', HATCHABOT_LAND_DIRECT: '1' }),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.channels()).toContain('"stable": "v0.9.0"');
  });
});

describe('scripts/promote.sh asks for the live tests (docs/live-tests.md)', () => {
  /** The sandbox with the live register and a record; node on PATH. */
  const withLive = (record: string) => {
    const w = world();
    mkdirSync(join(w.work, 'docs'), { recursive: true });
    writeFileSync(join(w.work, 'scripts', 'live.mjs'), readFileSync('scripts/live.mjs'));
    writeFileSync(join(w.work, 'docs', 'live-test-runs.md'), record);
    w.git(w.work, 'add', '.'); w.git(w.work, 'commit', '-q', '-m', 'live');
    w.git(w.work, 'push', '-q', 'origin', 'main');
    const PATH = `${join(w.work, '..', 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`;
    return { ...w, run: (extra: Record<string, string> = {}) => w.promote({ PATH, ...extra }, 'v1.1.0') };
  };
  const passedAll = async () => {
    // @ts-expect-error — a plain .mjs script
    const { LIVE_TESTS } = await import('../scripts/live.mjs');
    return (LIVE_TESTS as Array<{ name: string }>).map((t) => `| 2026-10-08 | ${t.name} | pass | v1.1.0 | 5 | |`).join('\n') + '\n';
  };

  it('due: refuses, says what to run, changes nothing', () => {
    const w = withLive('');
    const r = w.run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/live test\(s\) due for v1\.1\.0/);
    expect(r.stderr).toMatch(/Live tests are due for v1\.1\.0 .*HATCHABOT_PROMOTE_IGNORE_LIVE=1/);
    expect(w.channels()).toContain('"stable": "v1.0.0"');
  });

  it('all passed on the release: promotes', async () => {
    const w = withLive(await passedAll());
    const r = w.run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('✓ No live test is due for v1.1.0');
    expect(w.channels()).toContain('"stable": "v1.1.0"');
  });

  it('the override goes on without them, and says so', () => {
    const w = withLive('');
    const r = w.run({ HATCHABOT_PROMOTE_IGNORE_LIVE: '1' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Live tests not checked');
  });
});

describe('scripts/promote.sh publishes only the promote (review, 2026-10-09)', () => {
  const originMain = (w: ReturnType<typeof world>) => w.git(w.work, 'rev-parse', 'origin/main').trim();

  it('refuses while local main has a commit origin does not (it rode along with the push)', () => {
    const w = world();
    writeFileSync(join(w.work, 'wip.txt'), 'half done');
    w.git(w.work, 'add', 'wip.txt'); w.git(w.work, 'commit', '-q', '-m', 'wip');
    const before = originMain(w);
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/1 commits ahead, 0 behind/);
    expect(w.git(w.origin, 'rev-parse', 'main').trim()).toBe(before);
  });

  it('refuses a tag that is not on main', () => {
    const w = world();
    w.git(w.work, 'checkout', '-q', '-b', 'side');
    writeFileSync(join(w.work, 'side.txt'), 'x'); w.git(w.work, 'add', 'side.txt'); w.git(w.work, 'commit', '-q', '-m', 'side');
    w.git(w.work, 'tag', 'v1.2.0'); w.git(w.work, 'checkout', '-q', 'main'); w.publish('v1.2.0');
    const r = w.promote({}, 'v1.2.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v1.2.0 is not on main');
    expect(w.channels()).toContain('"stable": "v1.0.0"');
  });

  it('a refused push takes its commit back off, so a re-run does not say "already points at"', () => {
    const w = world();
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1" = push ] && { echo "! [rejected] main -> main (fetch first)" >&2; exit 1; }\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The promote did not land');
    expect(w.git(w.work, 'rev-parse', 'HEAD').trim()).toBe(originMain(w));
    expect(w.channels()).toContain('"stable": "v1.0.0"');
    expect(w.git(w.work, 'status', '--porcelain').trim()).toBe('');
    rmSync(join(w.bin, 'git'));
    const again = w.promote({}, 'v1.1.0');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).not.toContain('already points at');
  });

  /**
   * The caller's own work (audit issue #43, 2026-10-09): a tracked file with
   * an unstaged edit, a new file staged, and an untracked one. The promote
   * commit used to take the whole index, so the staged file went to main.
   */
  const withWork = () => {
    const w = world();
    writeFileSync(join(w.work, 'notes.md'), 'first\n');
    w.git(w.work, 'add', 'notes.md'); w.git(w.work, 'commit', '-q', '-m', 'notes'); w.git(w.work, 'push', '-q', 'origin', 'main');
    writeFileSync(join(w.work, 'notes.md'), 'first\nedited, not staged\n');
    writeFileSync(join(w.work, 'staged.txt'), 'staged, not for the promote\n');
    w.git(w.work, 'add', 'staged.txt');
    writeFileSync(join(w.work, 'loose.txt'), 'untracked\n');
    const state = () => ({
      status: w.git(w.work, 'status', '--porcelain'),
      staged: w.git(w.work, 'diff', '--cached'),
      unstaged: w.git(w.work, 'diff'),
    });
    return { ...w, state, before: state() };
  };

  it('commits only channels.json, and leaves staged and unstaged work as it was', () => {
    const w = withWork();
    const r = w.promote({}, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(w.git(w.origin, 'diff', '--name-only', 'main^', 'main').trim()).toBe('channels.json');
    expect(w.git(w.origin, 'show', 'main:channels.json')).toContain('"stable": "v1.1.0"');
    expect(w.channels()).toContain('"stable": "v1.1.0"');
    expect(w.state()).toEqual(w.before);
  });

  it('a refused push leaves HEAD, the index and the working tree exactly as they were', () => {
    const w = withWork();
    const head = w.git(w.work, 'rev-parse', 'HEAD').trim();
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(join(w.bin, 'git'), `#!/usr/bin/env bash\n[ "$1" = push ] && { echo "! [rejected] main -> main (fetch first)" >&2; exit 1; }\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The promote did not land');
    expect(w.git(w.work, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(w.channels()).toContain('"stable": "v1.0.0"');
    expect(w.state()).toEqual(w.before);
  });

  it('refuses before pushing when the commit would change anything but channels.json', () => {
    const w = withWork();
    const head = w.git(w.work, 'rev-parse', 'HEAD').trim();
    // A pre-commit hook (this sandbox's own) that slips another file in.
    const hooks = join(w.root, 'hooks'); mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho slipped > slipped.txt && git add slipped.txt\n', { mode: 0o755 });
    const r = w.promote({ GIT_CONFIG_VALUE_0: hooks }, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('more than channels.json');
    expect(w.git(w.origin, 'rev-parse', 'main').trim()).toBe(head);
    expect(w.git(w.work, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(w.channels()).toContain('"stable": "v1.0.0"');
    expect(w.git(w.work, 'diff', '--cached')).toBe(w.before.staged);
  });

  it('CI is the run for the push to main — a passing pull-request run on the commit does not count', () => {
    const w = world();
    const r = w.promote({ HB_CI: 'pr-only' }, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No CI run for v1\.1\.0/);
    expect(readFileSync(join(w.root, 'gh.log'), 'utf8')).toContain('--event push --branch main');
  });
});

describe('scripts/promote.sh asks the publisher for the fast lane (publish kit, 2026-10-16)', () => {
  it('lands channels.json on the dev repo, then tags that commit channels-<UTC time> on origin', () => {
    const w = world();
    const r = w.promote({}, 'v1.1.0', 'beta');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const main = w.git(w.origin, 'rev-parse', 'main').trim();
    expect(w.fastLane()).toMatch(new RegExp(`^channels-\\d{8}T\\d{6}Z ${main} hatchabot channels: beta → v1\\.1\\.0$`));
    expect(r.stdout).toContain('beta → v1.1.0 asked of the publisher');
    expect(r.stdout).toContain('promote-images.yml moves the image :beta');
  });

  it('only a published release: a tag the public repo does not have is refused, nothing changed', () => {
    const w = world();
    w.git(w.work, 'tag', 'v1.3.0'); w.git(w.work, 'push', '-q', 'origin', 'v1.3.0');
    const r = w.promote({}, 'v1.3.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v1.3.0 is not published yet');
    expect(w.channels()).toContain('"stable": "v1.0.0"');
    expect(w.fastLane()).toBe('');
  });

  it('run again: one fast-lane tag waits; once the public repo has the file, nothing more to do', () => {
    const w = world();
    expect(w.promote({}, 'v1.1.0').status).toBe(0);
    const again = w.promote({}, 'v1.1.0');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('is waiting for the publisher');
    expect(w.fastLane().split('\n')).toHaveLength(1);
    w.publishFastLane();
    const done = w.promote({}, 'v1.1.0');
    expect(done.stdout).toContain('✓ stable points at v1.1.0 on the public repo.');
  });

  it('no public remote: refused, with the command that adds it', () => {
    const w = world();
    w.git(w.work, 'remote', 'remove', 'public');
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("No remote 'public' for the public repo");
  });
});

describe('scripts/promote.sh promotes only a release GitHub has published (audit, 2026-10-20)', () => {
  it('no release for the tag (release.yml failed or still running): refused, nothing changed', () => {
    const w = world();
    const r = w.promote({ HB_RELEASE: 'none' }, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v1.1.0 has no GitHub release on hatchabot/hatchabot yet');
    expect(w.channels()).toContain('"stable": "v1.0.0"');
    expect(w.fastLane()).toBe('');
  });

  it('a draft: refused', () => {
    const w = world();
    const r = w.promote({ HB_RELEASE: 'draft' }, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('still a draft');
    expect(w.channels()).toContain('"stable": "v1.0.0"');
  });

  it('no manifest: refused from v2.159.0 on, allowed for a release from before manifests', () => {
    const w = world();
    w.git(w.work, 'tag', 'v2.160.0'); w.git(w.work, 'push', '-q', 'origin', 'v2.160.0'); w.publish('v2.160.0');
    const r = w.promote({ HB_RELEASE: 'nomanifest' }, 'v2.160.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('has no release-manifest.json, which every release from v2.159.0 on has');
    const old = w.promote({ HB_RELEASE: 'nomanifest' }, 'v1.1.0');
    expect(old.status, old.stdout + old.stderr).toBe(0);
    expect(w.channels()).toContain('"stable": "v1.1.0"');
  });
});

// Each runs several promotes, each fetching both remotes: slow on a shared CI runner.
describe('scripts/promote.sh and a release tagged before it (audit, 2026-10-20)', () => {
  /** A release tagged on origin, not published yet, whose channels.json says stable → `says`. */
  const pending = (w: ReturnType<typeof world>, tag: string, says: string) => {
    writeFileSync(join(w.work, 'channels.json'), `{\n  "stable": "${says}",\n  "beta": "v1.0.0"\n}\n`);
    writeFileSync(join(w.work, 'more.txt'), tag);
    w.git(w.work, 'add', '.'); w.git(w.work, 'commit', '-q', '-m', `Release ${tag}`);
    w.git(w.work, 'tag', tag); w.git(w.work, 'push', '-q', 'origin', 'main', tag);
  };

  it('refuses while a newer unpublished release would put the channel back', () => {
    const w = world();
    pending(w, 'v1.2.0', 'v1.0.0');
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v1.2.0 is tagged but not published yet, and its channels.json says stable → v1.0.0');
    expect(w.fastLane()).toBe('');
    const forced = w.promote({ HATCHABOT_PROMOTE_IGNORE_PENDING: '1' }, 'v1.1.0');
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(forced.stdout).toContain('not checked (HATCHABOT_PROMOTE_IGNORE_PENDING=1)');
  });

  it('goes on when it already names the release, or once it is published', () => {
    const w = world();
    pending(w, 'v1.2.0', 'v1.1.0');
    const r = w.promote({}, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const v = world();
    pending(v, 'v1.2.0', 'v1.0.0'); v.publish('v1.2.0');
    const p = v.promote({}, 'v1.1.0');
    expect(p.status, p.stdout + p.stderr).toBe(0);
  });

  it('asks the publisher again once the public repo has lost the file it had', () => {
    const w = world();
    expect(w.promote({}, 'v1.1.0').status).toBe(0);
    // The publisher copies it, then a release from before the promote puts the old file back.
    w.publishFastLane();
    const clone = join(w.root, 'pubwork');
    w.git(w.root, 'clone', '-q', w.pub, clone);
    writeFileSync(join(clone, 'channels.json'), '{\n  "stable": "v1.0.0",\n  "beta": "v1.0.0"\n}\n');
    w.git(clone, 'commit', '-qam', 'Release v1.2.0'); w.git(clone, 'push', '-q', 'origin', 'main');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);   // tag names go by the second
    const again = w.promote({}, 'v1.1.0');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('has lost it since');
    expect(w.fastLane().split('\n')).toHaveLength(2);
  });

  // Regression audit, 2026-10-22.
  it('a pre-release tag is never waited for: the publisher publishes only vX.Y.Z', () => {
    const w = world();
    pending(w, 'v1.2.0-rc.1', 'v1.0.0');
    const r = w.promote({}, 'v1.1.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it("origin's tags that cannot be listed stop it, rather than skipping the check", () => {
    const w = world();
    // A git ahead of the real one whose `ls-remote --tags origin` fails.
    writeFileSync(join(w.bin, 'git'), '#!/usr/bin/env bash\n[ "$*" = "ls-remote --tags origin refs/tags/v*" ] && { echo "fatal: could not read from remote" >&2; exit 128; }\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Could not list origin's tags.");
    expect(w.fastLane()).toBe('');
  });

  it('a fast-lane tag still waiting for another file holds a new one back; the same file is only waiting', () => {
    const w = world();
    expect(w.promote({}, 'v1.1.0').status).toBe(0);         // T1: stable → v1.1.0, not copied yet
    expect(w.fastLane().split('\n')).toHaveLength(1);
    const same = w.promote({}, 'v1.1.0');
    expect(same.status, same.stdout + same.stderr).toBe(0);
    expect(same.stdout).toContain('is waiting for the publisher');
    w.git(w.work, 'tag', 'v1.2.0'); w.git(w.work, 'push', '-q', 'origin', 'v1.2.0'); w.publish('v1.2.0');
    const before = w.git(w.work, 'rev-parse', 'origin/main').trim();
    const r = w.promote({}, 'v1.2.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is still waiting for the publisher');
    expect(r.stderr).toContain('git push origin :refs/tags/channels-');   // the way out when the publisher blocked it
    expect(w.fastLane().split('\n')).toHaveLength(1);       // no second tag judged against the wrong file
    // Refused before it landed: main is as it was, and so is the checkout.
    w.git(w.work, 'fetch', '-q', 'origin');
    expect(w.git(w.work, 'rev-parse', 'origin/main').trim()).toBe(before);
    expect(w.channels()).toContain('"stable": "v1.1.0"');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);   // tag names go by the second
    const forced = w.promote({ HATCHABOT_PROMOTE_IGNORE_WAITING: '1' }, 'v1.2.0');
    expect(forced.status, forced.stdout + forced.stderr).toBe(0);
    expect(w.fastLane().split('\n')).toHaveLength(2);
  });

  it('a release that puts an older tag\'s file back: the published tags are done, and it asks again', () => {
    const w = world();
    const copy = () => w.publishFastLane();
    const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    expect(w.promote({}, 'v1.1.0', 'stable').status).toBe(0); copy(); tick();   // T1 {1.1, 1.0}, published
    expect(w.promote({}, 'v1.1.0', 'beta').status).toBe(0); copy(); tick();     // T2 {1.1, 1.1}, published
    // A release tagged before T2 puts T1's file back on the public repo.
    const clone = join(w.root, 'pubwork');
    w.git(w.root, 'clone', '-q', w.pub, clone);
    writeFileSync(join(clone, 'channels.json'), '{\n  "stable": "v1.1.0",\n  "beta": "v1.0.0"\n}\n');
    w.git(clone, 'commit', '-qam', 'Release v1.2.0'); w.git(clone, 'push', '-q', 'origin', 'main');
    const again = w.promote({}, 'v1.1.0', 'beta');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('has lost it since');
    expect(w.fastLane().split('\n')).toHaveLength(3);
  });

  // Final audit, 2026-10-22: which tags the publisher is done with is read from its commits.
  const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);   // tag names go by the second
  const releaseFile = (w: ReturnType<typeof world>, stable: string, beta: string) => {
    const clone = join(w.root, 'pubrel');
    if (!existsSync(clone)) w.git(w.root, 'clone', '-q', w.pub, clone);
    w.git(clone, 'fetch', '-q', 'origin'); w.git(clone, 'reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(clone, 'channels.json'), `{\n  "stable": "${stable}",\n  "beta": "${beta}"\n}\n`);
    w.git(clone, 'commit', '-qam', 'Release v9.9.9'); w.git(clone, 'push', '-q', 'origin', 'main');
  };
  const back = (w: ReturnType<typeof world>, tag: string, ch = 'stable') => spawnSync('bash', [join(w.work, 'scripts', 'promote.sh'), tag, ch], {
    cwd: w.work, encoding: 'utf8', input: 'y\n',
    env: scriptEnv(join(w.work, '..', 'home'), `${join(w.work, '..', 'bin')}:/usr/bin:/bin`, { HATCHABOT_LAND_DIRECT: '1' }),
  });

  it('a tag asked again after a release put the old file back waits, so a rollback after it is held', () => {
    const w = world();
    w.git(w.work, 'tag', 'v1.0.0'); w.publish('v1.0.0');
    expect(w.promote({}, 'v1.1.0').status).toBe(0); w.publishFastLane(); tick();   // T0: stable v1.1.0, published
    releaseFile(w, 'v1.0.0', 'v1.0.0');                                             // a release puts the old file back
    const again = w.promote({}, 'v1.1.0');                                          // T1 asks for T0's file again
    expect(again.stdout).toContain('has lost it since');
    tick();
    const r = back(w, 'v1.0.0');
    expect(r.status, r.stdout + r.stderr).toBe(1);   // T1 is still to come: a rollback now would be undone by it
    expect(r.stderr).toContain('is still waiting for the publisher');
    expect(w.fastLane().split('\n')).toHaveLength(2);
  });

  it('a blocked tag before a published one is done, even when a release brings its file back', () => {
    const w = world();
    expect(w.promote({}, 'v1.1.0').status).toBe(0); tick();                       // T1: its gate blocks it, never published
    w.git(w.work, 'tag', 'v1.2.0'); w.git(w.work, 'push', '-q', 'origin', 'v1.2.0'); w.publish('v1.2.0');
    expect(w.promote({ HATCHABOT_PROMOTE_IGNORE_WAITING: '1' }, 'v1.2.0').status).toBe(0);   // T2
    w.publishFastLane(); tick();
    releaseFile(w, 'v1.1.0', 'v1.0.0');                                             // T1's file, by a release
    const r = w.promote({}, 'v1.2.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('has lost it since');                               // T2 was published: asked again
    expect(w.fastLane().split('\n')).toHaveLength(3);
  });

  it('a published tag named by hand does not make later tags count as done', () => {
    const w = world();
    expect(w.promote({}, 'v1.1.0').status).toBe(0);                              // T1, then renamed by hand
    const t1 = w.fastLane().split(' ')[0]!;
    w.git(w.work, 'fetch', '-q', 'origin', `+refs/tags/${t1}:refs/tags/${t1}`);
    w.git(w.work, 'tag', '-a', 'channels-manual', `${t1}^{commit}`, '-m', 'hatchabot channels: stable → v1.1.0');
    w.git(w.work, 'push', '-q', 'origin', 'refs/tags/channels-manual', `:refs/tags/${t1}`);
    w.publishFastLane('channels-manual'); tick();
    expect(w.promote({}, 'v1.1.0', 'beta').status).toBe(0); tick();             // T2: sorts before "channels-manual"
    w.git(w.work, 'tag', 'v1.2.0'); w.git(w.work, 'push', '-q', 'origin', 'v1.2.0'); w.publish('v1.2.0');
    const r = w.promote({}, 'v1.2.0');
    expect(r.status, r.stdout + r.stderr).toBe(1);                               // T2 still waits
    expect(r.stderr).toContain('is still waiting for the publisher');
  });

  it('a hand-made fast-lane tag with no channels.json (lightweight too) is one the publisher stops at', () => {
    const w = world();
    w.git(w.work, 'checkout', '-q', '--orphan', 'bare');
    w.git(w.work, 'rm', '-rq', '--cached', '.');
    w.git(w.work, 'commit', '-q', '--allow-empty', '-m', 'empty');
    w.git(w.work, 'tag', 'channels-20200101T000000Z');                            // lightweight
    w.git(w.work, 'push', '-q', 'origin', 'refs/tags/channels-20200101T000000Z');
    w.git(w.work, 'checkout', '-q', '-f', 'main');
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('channels-20200101T000000Z');
  });

  it('a fast-lane tag older than one the public repo has is done, published or blocked', () => {
    const w = world();
    expect(w.promote({}, 'v1.1.0').status).toBe(0);         // T1: its gate blocks it, so it never reaches the public repo
    w.git(w.work, 'tag', 'v1.2.0'); w.git(w.work, 'push', '-q', 'origin', 'v1.2.0'); w.publish('v1.2.0');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    expect(w.promote({ HATCHABOT_PROMOTE_IGNORE_WAITING: '1' }, 'v1.2.0').status).toBe(0);   // T2
    w.publishFastLane();   // the publisher copies T2's file
    w.git(w.work, 'tag', 'v1.3.0'); w.git(w.work, 'push', '-q', 'origin', 'v1.3.0'); w.publish('v1.3.0');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    const r = w.promote({}, 'v1.3.0');
    expect(r.status, r.stdout + r.stderr).toBe(0);           // T1, blocked for good, no longer holds it back
    expect(w.fastLane().split('\n')).toHaveLength(3);
  });

  it("a rollback states itself in the fast-lane tag, as the publisher's gate requires", () => {
    const w = world();
    w.git(w.work, 'tag', 'v0.9.0'); w.publish('v0.9.0');
    const r = spawnSync('bash', [join(w.work, 'scripts', 'promote.sh'), 'v0.9.0'], {
      cwd: w.work, encoding: 'utf8', input: 'y\n',
      env: scriptEnv(join(w.work, '..', 'home'), `${join(w.work, '..', 'bin')}:/usr/bin:/bin`, { HATCHABOT_LAND_DIRECT: '1' }),
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const msg = w.git(w.origin, 'for-each-ref', '--format=%(contents)', 'refs/tags/channels-*');
    expect(msg).toContain('hatchabot channels: stable → v0.9.0\nrollback stable v1.0.0 → v0.9.0');
    expect(msg).not.toContain('rollback beta');
  });

  it('rolling back both channels before the publisher runs: the second waits for the first, though the public repo had both files', () => {
    const w = world();
    const back = (ch: string) => spawnSync('bash', [join(w.work, 'scripts', 'promote.sh'), 'v1.0.0', ch], {
      cwd: w.work, encoding: 'utf8', input: 'y\n',
      env: scriptEnv(join(w.work, '..', 'home'), `${join(w.work, '..', 'bin')}:/usr/bin:/bin`, { HATCHABOT_LAND_DIRECT: '1' }),
    });
    const copy = () => w.publishFastLane();   // the publisher copies the fast lane
    const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);   // tag names go by the second
    w.git(w.work, 'tag', 'v1.0.0'); w.publish('v1.0.0');
    // Public history: {1.0, 1.0} → {1.0, 1.1} → {1.1, 1.1}.
    expect(w.promote({}, 'v1.1.0', 'beta').status).toBe(0); copy(); tick();
    expect(w.promote({}, 'v1.1.0', 'stable').status).toBe(0); copy(); tick();
    // Back: {1.0, 1.1} (had before), then {1.0, 1.0} (had before), the first not copied yet.
    const s = back('stable');
    expect(s.status, s.stdout + s.stderr).toBe(0);
    expect(w.fastLane().split('\n')).toHaveLength(3);
    tick();
    const b = back('beta');
    expect(b.status).toBe(1);
    expect(b.stderr).toContain('is still waiting for the publisher');
    expect(w.fastLane().split('\n')).toHaveLength(3);   // no tag stating two rollbacks against the wrong file
    expect(w.channels()).toContain('"beta": "v1.1.0"');   // and channels.json as it was
  });

  it("a failed read of the public repo leaves channels.json as it was", () => {
    const w = world();
    // A git ahead of the real one whose fetch of the public main fails (the tag list still reads).
    writeFileSync(join(w.bin, 'git'), '#!/usr/bin/env bash\n[ "$*" = "fetch -q --no-tags public main" ] && { echo "fatal: unable to access" >&2; exit 128; }\nexec /usr/bin/git "$@"\n', { mode: 0o755 });
    const before = w.channels();
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(1);
    expect(w.channels()).toBe(before);
    expect(w.git(w.work, 'status', '--porcelain').trim()).toBe('');
  });
});

describe('scripts/promote.sh when land.sh stops waiting (audit, 2026-10-20)', () => {
  it('exit 3: does not claim nothing changed; once the pull request merges, a re-run asks for the fast lane', () => {
    const w = world();
    // land.sh's timeout: the pull request merges later (here: at once), and it exits 3.
    writeFileSync(join(w.work, 'scripts', 'land.sh'), '#!/usr/bin/env bash\ngit push -q origin HEAD:refs/heads/main\necho "✗ Still waiting after 45 min: https://example.invalid/pull/1 merges by itself when its checks pass." >&2\nexit 3\n', { mode: 0o755 });
    const start = w.git(w.work, 'rev-parse', 'HEAD').trim();
    const r = w.promote({}, 'v1.1.0');
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('pull request is still open');
    expect(r.stderr).toContain('run scripts/promote.sh v1.1.0 stable again');
    expect(r.stderr).not.toContain('nothing changed');
    expect(w.git(w.work, 'rev-parse', 'HEAD').trim()).toBe(start);
    expect(w.fastLane()).toBe('');
    w.git(w.work, 'pull', '-q', '--ff-only', 'origin', 'main');
    writeFileSync(join(w.work, 'scripts', 'land.sh'), readFileSync('scripts/land.sh'), { mode: 0o755 });
    const again = w.promote({}, 'v1.1.0');
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('stable already points at v1.1.0 on main.');
    expect(w.fastLane()).toMatch(/hatchabot channels: stable → v1\.1\.0$/);
  });
});
