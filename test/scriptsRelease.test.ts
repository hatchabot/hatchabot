import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * scripts/release.sh and scripts/release-check.sh in a sandbox (release by
 * workflow, issue #37, 2026-10-10): a throwaway repo with a local bare
 * "origin", a temp HOME, hooks off, PATH of shims. gh is a fake that answers
 * CI from HB_CI, records `workflow run`, and makes the release run succeed or
 * fail (HB_RUN); scripts/privacy-check.mjs is a fake that records what it was
 * given and exits HB_PRIVACY_TEXT / HB_PRIVACY_SYNC. Nothing reaches GitHub.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SCRIPTS = ['release.sh', 'release-check.sh', 'dispatch-run.sh'];
const CHANGELOG = (v: string, body = '### Fixed\n- An agent no longer stalls.\n') => `# Changelog\n\n## [${v}] — 2026-10-10\n\n${body}\n## [9.8.6] — 2026-10-09\n\n- Older.\n`;

function world() {
  const root = mkdtempSync(join(tmpdir(), 'hb-release-')); dirs.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'gh.log');
  const dispatched = join(root, 'dispatched');
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "gh $*" >> ${JSON.stringify(log)}
ci="\${HB_CI:-success}"
case "$1 $2" in
  "run list")
    case "$*" in
      *"--workflow release.yml"*) [ -f ${JSON.stringify(dispatched)} ] && echo 501; echo 500 ;;
      *) case "$ci" in none) ;; pr-only) case "$*" in *"--event push"*) ;; *) echo "4243 completed success" ;; esac ;; running:*) echo "4242 in_progress " ;; *) echo "4242 completed $ci" ;; esac ;;
    esac ;;
  "run watch") if [ "$3" = 4242 ]; then [ "\${ci#running:}" = success ]; else [ "\${HB_RUN:-success}" = success ]; fi ;;
  "workflow run") touch ${JSON.stringify(dispatched)} ;;
  "release view") echo "https://github.com/example-owner/example/releases/tag/$3" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = scriptEnv(home, `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, { HATCHABOT_SLUG: 'example-owner/example', HATCHABOT_DISPATCH_POLL: '0' });
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
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
  const run = (script: string, args: string[], extra: Record<string, string> = {}) =>
    spawnSync('bash', [join(work, 'scripts', script), ...args], { cwd: work, env: { ...env, ...extra }, encoding: 'utf8' });
  const release = (args: string[], extra: Record<string, string> = {}) => run('release.sh', args, extra);
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');
  const landed = (v: string, changelog?: string) => { const sha = commitVersion(v, changelog); git(work, 'push', '-q', 'origin', 'main'); return sha; };
  return { root, work, origin, git, release, run, landed, commitVersion, ghLog: () => read('gh.log'), privacyLog: () => read('privacy.log'), notes: () => read('notes.log') };
}

const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe('scripts/release.sh starts the release workflow once everything it needs has landed', () => {
  it('checks, runs the privacy steps, starts release.yml for the checked commit, follows it and prints the release', () => {
    const w = world();
    const sha = w.landed('9.8.7');
    const r = w.release(['9.8.7']);
    expect(r.status, out(r)).toBe(0);
    expect(w.ghLog()).toContain(`gh workflow run release.yml --repo example-owner/example --ref main -f version=9.8.7 -f commit=${sha} -f draft_only=false`);
    expect(w.ghLog()).toContain('gh run watch 501 --repo example-owner/example --exit-status');
    expect(w.ghLog()).toContain('--workflow ci.yml --commit ' + sha + ' --event push --branch main');
    // The notes are the CHANGELOG section, checked before the fingerprints are synced and the workflow starts.
    expect(w.notes()).toBe('### Fixed\n- An agent no longer stalls.\n');
    expect(w.privacyLog()).toMatch(/^--text \S+notes\.md\n--sync-ci\n$/);
    expect(r.stdout).toContain('→ v9.8.7 from ' + sha.slice(0, 9) + ': https://github.com/example-owner/example/actions/runs/501');
    expect(r.stdout).toContain('✓ released v9.8.7: https://github.com/example-owner/example/releases/tag/v9.8.7');
  });

  it('--draft-only asks the workflow for a draft and says how to remove it', () => {
    const w = world();
    w.landed('9.8.7');
    const r = w.release(['v9.8.7', '--draft-only']);
    expect(r.status, out(r)).toBe(0);
    expect(w.ghLog()).toMatch(/workflow run release\.yml .* -f draft_only=true/);
    expect(r.stdout).toContain('✓ draft v9.8.7 made, nothing published');
    expect(r.stdout).toContain('gh release delete v9.8.7');
  });

  it('waits for CI still running on the commit, then goes on', () => {
    const w = world();
    w.landed('9.8.7');
    const r = w.release(['9.8.7'], { HB_CI: 'running:success' });
    expect(r.status, out(r)).toBe(0);
    expect(r.stderr).toContain('still running — waiting');
  });

  it('a failed workflow run: exit 1, with the run and how to re-run it', () => {
    const w = world();
    w.landed('9.8.7');
    const r = w.release(['9.8.7'], { HB_RUN: 'failure' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('The release workflow failed: https://github.com/example-owner/example/actions/runs/501');
    expect(r.stderr).toContain('gh run rerun 501 --failed');
  });

  /** A refusal: exit non-zero, the reason, and no workflow started. */
  const refused = (r: ReturnType<ReturnType<typeof world>['release']>, w: ReturnType<typeof world>, why: RegExp) => {
    expect(r.status, out(r)).not.toBe(0);
    expect(r.stderr).toMatch(why);
    expect(w.ghLog()).not.toContain('workflow run');
  };

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
    refused(w.release(['9.8.7']), w, /The tag v9\.8\.7 already exists/);
  });

  it('refuses failed CI, no CI run for the push to main, and a pull-request run alone', () => {
    for (const [ci, why] of [['failure', /CI failed on \w+ \(failure\): https:\/\/github\.com\/example-owner\/example\/actions\/runs\/4242/], ['none', /No CI run for the push to main/], ['pr-only', /No CI run for the push to main/]] as const) {
      const w = world();
      w.landed('9.8.7');
      refused(w.release(['9.8.7'], { HB_CI: ci }), w, why);
    }
  });

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

describe('scripts/release-check.sh (the workflow\'s first job runs it too)', () => {
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
});
