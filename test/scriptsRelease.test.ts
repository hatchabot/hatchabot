import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/release.sh and scripts/release-check.sh in a sandbox (release by
 * workflow, issue #37, 2026-10-10; through the publish kit, 2026-10-16): a
 * throwaway repo with a local bare "origin" (the dev repo) and "public" (the
 * public repo), a temp HOME, hooks off, PATH of shims. gh is a fake that
 * answers CI from HB_CI; scripts/privacy-check.mjs is a fake that records
 * what it was given and exits HB_PRIVACY_TEXT / HB_PRIVACY_SYNC. Nothing
 * reaches GitHub.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SCRIPTS = ['release.sh', 'release-check.sh'];
const CHANGELOG = (v: string, body = '### Fixed\n- An agent no longer stalls.\n') => `# Changelog\n\n## [${v}] — 2026-10-10\n\n${body}\n## [9.8.6] — 2026-10-09\n\n- Older.\n`;

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hb-release-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'gh.log');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "gh $*" >> ${JSON.stringify(log)}
ci="\${HB_CI:-success}"
case "$1 $2" in
  "run list")
    case "$ci" in late:*) n=$(cat ${JSON.stringify(log)}.ci 2>/dev/null || echo 0); echo $((n+1)) > ${JSON.stringify(log)}.ci; if [ "$n" -ge 2 ]; then echo "4242 completed \${ci#late:}"; fi ;; none) ;; pr-only) case "$*" in *"--event push"*) ;; *) echo "4243 completed success" ;; esac ;; running:*) echo "4242 in_progress " ;; *) echo "4242 completed $ci" ;; esac ;;
  "run watch") [ "\${ci#running:}" = success ] ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = scriptEnv(home, `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, { HATCHABOT_DEV_SLUG: 'example-owner/example-dev', HATCHABOT_DISPATCH_POLL: '0', HATCHABOT_CI_APPEAR_SECS: '2' });
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const origin = join(root, 'origin.git');
  const pub = join(root, 'public.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '--bare', '-b', 'main', pub);
  const work = join(root, 'work'); mkdirSync(join(work, 'scripts'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  for (const s of SCRIPTS) writeFileSync(join(work, 'scripts', s), readFileSync(join('scripts', s)), { mode: 0o755 });
  // The privacy check, faked: it records its arguments and the notes it was given.
  writeFileSync(join(work, 'scripts', 'privacy-check.mjs'), `import { appendFileSync, readFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, 'privacy.log'))}, a.join(' ') + '\\n');
if (a[0] === '--text') { appendFileSync(${JSON.stringify(join(root, 'notes.log'))}, readFileSync(a[1], 'utf8')); process.exit(Number(process.env.HB_PRIVACY_TEXT ?? 0)); }
process.exit(Number(process.env.HB_PRIVACY_SYNC ?? 0));
`);
  const commitVersion = (v: string, changelog = CHANGELOG(v)) => {
    writeFileSync(join(work, 'package.json'), `{\n  "name": "example",\n  "version": "${v}",\n  "private": true\n}\n`);
    writeFileSync(join(work, 'CHANGELOG.md'), changelog);
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', `Release v${v}`);
    return git(work, 'rev-parse', 'HEAD');
  };
  commitVersion('9.8.6', '# Changelog\n\n## [9.8.6] — 2026-10-09\n\n- Older.\n');
  git(work, 'tag', 'v9.8.6');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main', 'v9.8.6');
  git(work, 'push', '-q', pub, 'main', 'v9.8.6');
  git(work, 'remote', 'add', '--no-tags', 'public', pub);
  const run = (script: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [join(work, 'scripts', script), ...args], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
  const release = (args: string[], extra: Record<string, string> = {}) => run('release.sh', args, extra);
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');
  const landed = (v: string, changelog?: string) => { const sha = commitVersion(v, changelog); git(work, 'push', '-q', 'origin', 'main'); return sha; };
  /** The tag on origin, peeled, and its message ('' when origin has none). */
  const originTag = (tag: string) => { const r = spawnSync('git', ['--git-dir', origin, 'for-each-ref', '--format=%(objecttype) %(*objectname) %(contents:subject)', `refs/tags/${tag}`], { env, encoding: 'utf8' }); return r.stdout.trim(); };
  return { root, work, origin, pub, git, release, run, landed, commitVersion, originTag, ghLog: () => read('gh.log'), privacyLog: () => read('privacy.log'), notes: () => read('notes.log') };
}

const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe('scripts/release.sh tags the version commit in the dev repo once everything it needs has landed', () => {
  it('checks, runs the privacy steps, then pushes an annotated tag on the checked commit to origin', () => {
    const w = world();
    const sha = w.landed('9.8.7');
    const r = w.release(['9.8.7']);
    expect(r.status, out(r)).toBe(0);
    expect(w.ghLog()).toContain('--repo example-owner/example-dev --workflow ci.yml --commit ' + sha + ' --event push --branch main');
    // The notes are the CHANGELOG section, checked before the fingerprints are synced and the tag is made.
    expect(w.notes()).toBe('### Fixed\n- An agent no longer stalls.\n');
    expect(w.privacyLog()).toMatch(/^--text \S+notes\.md\n--sync-ci\n$/);
    expect(w.originTag('v9.8.7')).toBe(`tag ${sha} hatchabot v9.8.7`);
    expect(r.stdout).toContain(`✓ tagged v9.8.7 on ${sha.slice(0, 9)} in example-owner/example-dev.`);
    expect(r.stdout).toContain('gh workflow run publish.yml -R cksci/publisher');
    expect(w.ghLog()).not.toContain('workflow run');
  });

  it('--draft-only is gone: the release is built only on the public repo', () => {
    const w = world();
    w.landed('9.8.7');
    const r = w.release(['v9.8.7', '--draft-only']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--draft-only is gone');
    expect(w.originTag('v9.8.7')).toBe('');
  });

  it('waits for CI still running on the commit, then goes on', () => {
    const w = world();
    w.landed('9.8.7');
    const r = w.release(['9.8.7'], { HB_CI: 'running:success' });
    expect(r.status, out(r)).toBe(0);
    expect(r.stderr).toContain('still running — waiting');
  });

  it('waits for the push\'s CI run to appear: GitHub lists it a few seconds after the merge', () => {
    const w = world();
    w.landed('9.8.7');
    const r = w.release(['9.8.7'], { HB_CI: 'late:success' });
    expect(r.status, out(r)).toBe(0);
    expect(r.stderr).toContain('No CI run listed yet');
  });

  it('a refused tag push: exit 1, and the local tag is deleted again', () => {
    const w = world();
    w.landed('9.8.7');
    w.git(w.work, 'remote', 'set-url', '--push', 'origin', join(w.root, 'nowhere.git'));
    const r = w.release(['9.8.7']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The push of v9.8.7 was refused');
    expect(spawnSync('git', ['-C', w.work, 'tag', '-l', 'v9.8.7'], { encoding: 'utf8' }).stdout).toBe('');
  });

  /** A refusal: exit non-zero, the reason, and no tag on origin. */
  const refused = (r: ReturnType<ReturnType<typeof world>['release']>, w: ReturnType<typeof world>, why: RegExp) => {
    expect(r.status, out(r)).not.toBe(0);
    expect(r.stderr).toMatch(why);
    expect(w.originTag('v9.8.7')).toBe('');
  };

  it('refuses a tag name the public repo already has, and a clone with no public remote', () => {
    const w = world();
    const sha = w.landed('9.8.7');
    w.git(w.work, 'push', '-q', w.pub, `${sha}:refs/tags/v9.8.7`);
    refused(w.release(['9.8.7']), w, /The tag v9\.8\.7 already exists on the public repo/);
    const n = world();
    n.landed('9.8.7');
    n.git(n.work, 'remote', 'remove', 'public');
    refused(n.release(['9.8.7']), n, /No remote 'public' for the public repo/);
  });

  it('refuses while local main is not origin/main (the version commit has not landed)', () => {
    const w = world();
    w.commitVersion('9.8.7');
    refused(w.release(['9.8.7']), w, /Local main is not origin\/main \(1 commits ahead, 0 behind\)/);
  });

  it('refuses when package.json on main says another version', () => {
    const w = world();
    w.landed('9.8.7');
    refused(w.release(['9.8.8']), w, /package\.json at \w+ says 9\.8\.7, not 9\.8\.8/);
  });

  it('refuses a version with no CHANGELOG section, or an empty one', () => {
    const w = world();
    w.landed('9.8.7', '# Changelog\n\n## [9.8.6] — 2026-10-09\n\n- Older.\n');
    refused(w.release(['9.8.7']), w, /CHANGELOG\.md at \w+ has no "## \[9\.8\.7\]" section/);
    const e = world();
    e.landed('9.8.7', '# Changelog\n\n## [9.8.7] — 2026-10-10\n\n## [9.8.6] — 2026-10-09\n\n- Older.\n');
    refused(e.release(['9.8.7']), e, /section for 9\.8\.7 is empty/);
  });

  it('refuses a tag that already exists: a version is released once', () => {
    const w = world();
    w.landed('9.8.7');
    w.git(w.work, 'tag', 'v9.8.7'); w.git(w.work, 'push', '-q', 'origin', 'v9.8.7');
    expect(w.release(['9.8.7']).stderr).toMatch(/The tag v9\.8\.7 already exists — a version is released once/);
  });

  it('refuses failed CI, no CI run for the push to main, and a pull-request run alone', () => {
    for (const [ci, why] of [['failure', /CI failed on \w+ \(failure\): https:\/\/github\.com\/example-owner\/example-dev\/actions\/runs\/4242/], ['none', /No CI run for the push to main/], ['pr-only', /No CI run for the push to main/]] as const) {
      const w = world();
      w.landed('9.8.7');
      refused(w.release(['9.8.7'], { HB_CI: ci }), w, why);
    }
  }, 20_000); // three runs of the script, each fetching the public main

  it('refuses when the notes do not pass the privacy check, or the fingerprints cannot be synced', () => {
    const w = world();
    w.landed('9.8.7');
    refused(w.release(['9.8.7'], { HB_PRIVACY_TEXT: '1' }), w, /release notes did not pass the privacy check/);
    expect(w.privacyLog()).not.toContain('--sync-ci');
    refused(w.release(['9.8.7'], { HB_PRIVACY_TEXT: '3' }), w, /did not pass the privacy check/);
    refused(w.release(['9.8.7'], { HB_PRIVACY_SYNC: '3' }), w, /privacy fingerprints up to date/);
  });

  it('usage: no version, a bad one, an unknown option', () => {
    const w = world();
    expect(w.release([]).status).toBe(2);
    expect(w.release(['9.8.7', '--publish-now']).status).toBe(2);
    w.landed('9.8.7');
    const bad = w.release(['latest']);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('"latest" is not a version');
  });
});

describe('scripts/release.sh refuses a commit whose channels.json would put a channel back (audit, 2026-10-20)', () => {
  const channels = (w: ReturnType<typeof world>, stable: string) =>
    writeFileSync(join(w.work, 'channels.json'), `{\n  "stable": "${stable}",\n  "beta": "v9.8.6"\n}\n`);

  it('the public main names a newer release (a promote copied there since): refused, no tag', () => {
    const w = world();
    channels(w, 'v9.8.5'); w.landed('9.8.7');
    // The fast lane, on the public repo only: a commit there whose channels.json says v9.8.6.
    w.git(w.work, 'checkout', '-q', '-b', 'pubside'); channels(w, 'v9.8.6');
    w.git(w.work, 'commit', '-qam', 'Update channels'); w.git(w.work, 'push', '-q', '-f', w.pub, 'pubside:main');
    w.git(w.work, 'checkout', '-q', 'main');
    const r = w.release(['9.8.7']);
    expect(r.status).toBe(1);
    // The commit is origin's main (a rollback landed there): only the fast lane is behind, so
    // the advice is to wait for it, not to release another commit (regression audit, 2026-10-22).
    expect(r.stderr).toContain("says stable → v9.8.5, as origin's main does, but the public repo's main still says v9.8.6");
    expect(r.stderr).toContain("waiting for the publisher's fast lane");
    expect(r.stderr).not.toContain('Release a commit that has the promote in it');
    expect(w.originTag('v9.8.7')).toBe('');
  });

  it("an earlier commit (--commit) behind origin's main, where a promote has landed: refused", () => {
    const w = world();
    channels(w, 'v9.8.5'); const sha = w.landed('9.8.7');
    channels(w, 'v9.8.6'); w.git(w.work, 'commit', '-qam', 'Promote v9.8.6 to stable'); w.git(w.work, 'push', '-q', 'origin', 'main');
    const r = w.release(['9.8.7', '--commit', sha]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("but origin's main says v9.8.6");
    expect(r.stderr).toContain('Release a commit that has the promote in it');
  });

  it('the same or a newer channel than both mains: tagged', () => {
    const w = world();
    channels(w, 'v9.8.6'); w.landed('9.8.7');   // the public main has no channels.json yet
    const r = w.release(['9.8.7']);
    expect(r.status, out(r)).toBe(0);
  });
});

describe('scripts/release-check.sh (the public repo\'s release workflow runs it too, --tagged)', () => {
  it('--tagged: the tag on origin names a commit on main; that commit is checked, and CI is not asked', () => {
    const w = world();
    const sha = w.landed('9.8.7');
    w.git(w.work, 'tag', '-a', 'v9.8.7', '-m', 'hatchabot v9.8.7', sha); w.git(w.work, 'push', '-q', 'origin', 'v9.8.7');
    w.landed('9.8.8');
    const r = w.run('release-check.sh', ['9.8.7', '--tagged', '--repo', 'example-owner/example']);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toBe(`version=9.8.7\ntag=v9.8.7\ncommit=${sha}\nnewest=true\nprerelease=false\n`);
    expect(w.ghLog()).toBe('');
    const none = w.run('release-check.sh', ['9.8.9', '--tagged']);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('The tag v9.8.9 is not on origin');
    w.git(w.work, 'checkout', '-q', '-b', 'side', sha);
    const side = w.commitVersion('9.9.0');
    w.git(w.work, 'tag', 'v9.9.0', side); w.git(w.work, 'push', '-q', 'origin', 'v9.9.0');
    const off = w.run('release-check.sh', ['9.9.0', '--tagged']);
    expect(off.status).toBe(1);
    expect(off.stderr).toContain('which is not on main');
    expect(w.run('release-check.sh', ['9.8.7', '--tagged', '--commit', sha]).status).toBe(2);
  });

  it('prints the outputs; newest only when above every release tag; a pre-release is never newest', () => {
    const w = world();
    const sha = w.landed('9.8.7');
    const r = w.run('release-check.sh', ['9.8.7', '--repo', 'example-owner/example']);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toBe(`version=9.8.7\ntag=v9.8.7\ncommit=${sha}\nnewest=true\nprerelease=false\n`);
    w.git(w.work, 'tag', 'v9.10.0', 'HEAD~1'); w.git(w.work, 'push', '-q', 'origin', 'v9.10.0');
    expect(w.run('release-check.sh', ['9.8.7']).stdout).toContain('newest=false');
    const pre = world();
    pre.landed('9.9.0-rc.1');
    const p = pre.run('release-check.sh', ['9.9.0-rc.1']);
    expect(p.status, out(p)).toBe(0);
    expect(p.stdout).toContain('newest=false\nprerelease=true');
  });

  // Audit, 2026-10-22 (A04).
  it("release.sh tags no pre-release (the publisher publishes X.Y.Z only); release.yml takes the versions release-check.sh takes", () => {
    const w = world();
    w.landed('9.9.0-rc.1');
    const r = w.release(['9.9.0-rc.1']);
    expect(r.status, out(r)).toBe(2);
    expect(r.stderr).toContain('is a pre-release');
    expect(w.originTag('v9.9.0-rc.1')).toBe('');
    const re = /\[\[ "\$GITHUB_REF" =~ (\S+) \]\]/.exec(readFileSync('.github/workflows/release.yml', 'utf8'))![1]!;
    const takes = (ref: string) => spawnSync('bash', ['-c', '[[ "$1" =~ $2 ]]', '_', ref, re]).status === 0;
    for (const v of ['9.8.7', '9.9.0-rc.1']) {
      expect(takes(`refs/tags/v${v}`), v).toBe(true);
      expect(w.run('release-check.sh', [v, '--tagged']).stderr).not.toContain('is not a version');
    }
    for (const bad of ['refs/tags/v9.9', 'refs/tags/v9.9.0-', 'refs/tags/channels-20261022T000000Z', 'refs/heads/v9.9.0']) expect(takes(bad), bad).toBe(false);
  });

  it('a commit on main may be named; one off main is refused', () => {
    const w = world();
    const old = w.landed('9.8.7');
    w.landed('9.8.8');
    const r = w.run('release-check.sh', ['9.8.7', '--commit', old]);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toContain(`commit=${old}`);
    w.git(w.work, 'checkout', '-q', '-b', 'side', old);
    const side = w.commitVersion('9.8.9');
    w.git(w.work, 'push', '-q', 'origin', 'side');
    const off = w.run('release-check.sh', ['9.8.9', '--commit', side]);
    expect(off.status).toBe(1);
    expect(off.stderr).toContain('is not on main');
  });

  it('CI still running is refused without --wait-ci (the workflow never waits)', () => {
    const w = world();
    w.landed('9.8.7');
    const r = w.run('release-check.sh', ['9.8.7'], { HB_CI: 'running:success' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is still running');
    expect(r.stdout).toBe('');
  });

  it('--notes writes the CHANGELOG section alone', () => {
    const w = world();
    w.landed('9.8.7', CHANGELOG('9.8.7', '### Added\n- A thing.\n\n### Fixed\n- Another.\n'));
    const notes = join(w.root, 'notes.md');
    const r = w.run('release-check.sh', ['9.8.7', '--notes', notes]);
    expect(r.status, out(r)).toBe(0);
    expect(readFileSync(notes, 'utf8')).toBe('### Added\n- A thing.\n\n### Fixed\n- Another.\n');
  });

  it('reads a CHANGELOG far bigger than a pipe buffer (the first dry run ended silently, exit 141)', () => {
    const w = world();
    const older = Array.from({ length: 6000 }, (_, i) => `## [1.0.${i}] — 2026-01-01\n\n- An older change, number ${i}.\n`).join('\n');
    w.landed('9.8.7', CHANGELOG('9.8.7') + older);
    const notes = join(w.root, 'notes.md');
    const r = w.run('release-check.sh', ['9.8.7', '--notes', notes]);
    expect(r.status, out(r)).toBe(0);
    expect(readFileSync(notes, 'utf8')).toBe('### Fixed\n- An agent no longer stalls.\n');
  });
});
