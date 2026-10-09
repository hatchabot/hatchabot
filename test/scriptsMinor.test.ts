import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

/**
 * The smaller script findings of the 2026-10-09 review, each in a sandbox: a
 * temp HOME, a PATH of shims and the system dirs, an environment built from
 * scratch. Nothing here reaches Docker, systemd or the network.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const shim = (bin: string, name: string, body: string) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });

describe('scripts/sqlite-driver.sh', () => {
  it('writes its build log to a file of its own, never through a name someone made first in /tmp', () => {
    const root = temp('hb-sqlite-');
    const home = join(root, 'home'), bin = join(root, 'bin'), tmp = join(root, 'tmp'), app = join(root, 'app');
    for (const d of [home, bin, tmp, join(app, 'scripts'), join(app, 'node_modules', 'better-sqlite3')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(app, 'scripts', 'sqlite-driver.sh'), readFileSync('scripts/sqlite-driver.sh'), { mode: 0o755 });
    const npmRoot = join(root, 'npm-global');
    mkdirSync(join(npmRoot, 'npm', 'node_modules', 'node-gyp', 'bin'), { recursive: true });
    writeFileSync(join(npmRoot, 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'), '');
    shim(bin, 'npm', `[ "$1 $2" = "root -g" ] && echo ${JSON.stringify(npmRoot)}`);
    shim(bin, 'node', 'echo "gyp ERR! simulated compile failure" >&2; exit 1');
    // What another user on a shared host could have left at the old fixed name.
    const victim = join(root, 'victim.txt'); writeFileSync(victim, 'mine');
    symlinkSync(victim, join(tmp, 'hatchabot-sqlite-build.log'));
    const r = spawnSync('bash', [join(app, 'scripts', 'sqlite-driver.sh'), '--compile'], { encoding: 'utf8', env: scriptEnv(home, `${bin}:/usr/bin:/bin`, { TMPDIR: tmp }) });
    expect(r.status).toBe(1);
    expect(readFileSync(victim, 'utf8')).toBe('mine');
    const log = /see (\S+) \(make/.exec(r.stderr)?.[1];
    expect(log, r.stderr).toBeTruthy();
    expect(log).not.toBe(join(tmp, 'hatchabot-sqlite-build.log'));
    expect(readFileSync(log!, 'utf8')).toContain('simulated compile failure');
  });
});

describe('scripts/build-runtime-image.sh', () => {
  it('a rebuild under an existing tag that fails its version check gives the tag back to the previous image', () => {
    const root = temp('hb-image-');
    const home = join(root, 'home'), bin = join(root, 'bin'), app = join(root, 'app');
    for (const d of [home, bin, join(app, 'scripts'), join(app, 'docker')]) mkdirSync(d, { recursive: true });
    writeFileSync(join(app, 'scripts', 'build-runtime-image.sh'), readFileSync('scripts/build-runtime-image.sh'), { mode: 0o755 });
    writeFileSync(join(app, 'scripts', 'runtime-pins.mjs'), readFileSync('scripts/runtime-pins.mjs'));
    writeFileSync(join(app, 'docker', 'Dockerfile.runtime'), readFileSync('docker/Dockerfile.runtime'));
    symlinkSync(process.execPath, join(bin, 'node'));
    const log = join(root, 'docker.log'), built = join(root, 'built');
    // The tag names sha256:0ld until the build moves it to sha256:new; the new image runs the wrong OpenClaw.
    shim(bin, 'docker', `echo "docker $*" >> ${JSON.stringify(log)}
case "$1 $2" in
  "image inspect") [ -f ${JSON.stringify(built)} ] && echo sha256:new || echo sha256:0ld ;;
  "build "*|build*) touch ${JSON.stringify(built)} ;;
  "run --rm") echo "OpenClaw 1999.1.1" ;;
esac
exit 0`);
    const r = spawnSync('bash', [join(app, 'scripts', 'build-runtime-image.sh')], {
      encoding: 'utf8', env: scriptEnv(home, `${bin}:/usr/bin:/bin`, { BUILD_LOCAL: '1', NO_LATEST: '1', IMAGE_TAG: 'test-tag' }),
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('docker rmi hatchabot-runtime:test-tag');
    expect(calls).toContain('docker tag sha256:0ld hatchabot-runtime:test-tag');
    expect(calls.indexOf('docker rmi')).toBeLessThan(calls.indexOf('docker tag sha256:0ld'));
  });
});

describe('scripts/migrate-rename-host.sh', () => {
  it('writes the env files 600 from the start (they hold the secret key), not readable until a chmod', () => {
    const root = temp('hb-migrate-');
    const home = join(root, 'home'), bin = join(root, 'bin');
    for (const d of [home, bin]) mkdirSync(d, { recursive: true });
    const env = scriptEnv(home, `${bin}:/usr/bin:/bin`);
    // The new release, at a tag, in a local origin.
    const src = join(root, 'src'); mkdirSync(join(src, 'deploy'), { recursive: true });
    writeFileSync(join(src, 'package.json'), '{"name":"x","version":"1.1.0"}\n');
    writeFileSync(join(src, 'deploy', 'hatchabot.service'), '[Service]\nWorkingDirectory=__HATCHABOT_DIR__\n');
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    git(src, 'init', '-q', '-b', 'main'); git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'v1'); git(src, 'tag', 'v1.1.0');
    // The old AgentClaw install.
    const old = join(home, 'agentclaw'); mkdirSync(join(old, 'data'), { recursive: true });
    writeFileSync(join(old, '.env'), 'AGENTCLAW_SECRET_KEY=made-up-key\nPORT=8080\n');
    writeFileSync(join(old, 'data', 'agentclaw.sqlite'), 'db');
    mkdirSync(join(home, '.config', 'agentclaw'), { recursive: true });
    writeFileSync(join(home, '.config', 'agentclaw', 'env'), 'AGENTCLAW_URL=http://127.0.0.1:8080\n');
    const modes = join(root, 'modes.log');
    for (const t of ['systemctl', 'docker', 'npm']) shim(bin, t, 'exit 0');
    shim(bin, 'uname', 'echo Linux');
    shim(bin, 'curl', 'echo \'HATCHABOT_VERSION="1.1.0"\'');
    symlinkSync(process.execPath, join(bin, 'node'));
    // chmod notes each file's mode as it was BEFORE the chmod.
    shim(bin, 'chmod', `for a in "$@"; do [ -f "$a" ] && echo "$a $(stat -c %a "$a")" >> ${JSON.stringify(modes)}; done\nexec /bin/chmod "$@"`);
    const r = spawnSync('bash', ['-c', 'umask 022; exec bash "$@"', '_', 'scripts/migrate-rename-host.sh', 'v1.1.0', '--yes', '--old', old], {
      encoding: 'utf8', timeout: 60_000, env: { ...env, HATCHABOT_REPO: src },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const seen = readFileSync(modes, 'utf8').split('\n').filter((l) => /\/(\.env|env)\s/.test(l));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const l of seen) expect(l, l).toMatch(/ 600$/);
    expect(existsSync(join(home, 'hatchabot-prod', '.env'))).toBe(true);
    expect(readdirSync(join(home, 'hatchabot-data'))).toContain('hatchabot.sqlite');
  });
});
