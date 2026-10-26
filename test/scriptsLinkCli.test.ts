import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptEnv } from './helpers/scriptEnv.js';

// Every test here runs real shell scripts in a sandbox; vitest's 5 s was not
// enough under load on the self-hosted runner (2026-10-23).
vi.setConfig({ testTimeout: 30_000 });

/**
 * scripts/link-cli.sh on a bundle install, in a sandbox: a temp HOME (the
 * launchers go in its ~/.local/bin), a made-up bundle whose Node only prints
 * what it was asked to run, and a PATH of shims and the system dirs.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const shim = (dir: string, name: string, body: string) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });

function bundle(folder = 'hatchabot') {
  const root = mkdtempSync(join(tmpdir(), 'hb-link-cli-')); dirs.push(root);
  const home = join(root, 'home'), bin = join(root, 'bin'), app = join(root, folder), launchers = join(home, '.local', 'bin');
  for (const d of [join(app, 'scripts'), join(app, '.node', 'bin'), join(app, 'bin'), bin, launchers]) mkdirSync(d, { recursive: true });
  writeFileSync(join(app, 'BUNDLE.json'), '{"tag":"v1.0.0","platform":"linux-x64"}\n');
  shim(join(app, '.node', 'bin'), 'node', 'printf "node ran: %s\\n" "$*"');
  writeFileSync(join(app, 'bin', 'hatchabot.mjs'), '// a made-up CLI\n');
  for (const f of ['link-cli.sh', 'uninstall.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
  for (const t of ['systemctl', 'docker', 'npm', 'launchctl']) shim(bin, t, 'exit 0');
  const env = scriptEnv(home, `${launchers}:${bin}:/usr/bin:/bin`);
  const run = (script: string, ...args: string[]) => spawnSync('bash', [join(app, 'scripts', script), ...args], { encoding: 'utf8', input: '', env });
  return { root, app, launchers, env, run };
}

describe('scripts/link-cli.sh on a bundle install', () => {
  it('replaces a link left by a native install instead of writing through it (audit #038)', () => {
    const b = bundle();
    // An npm-linked native checkout's command, and hbt linked through it.
    const old = join(b.root, 'old-native', 'bin'); mkdirSync(old, { recursive: true });
    const oldCli = join(old, 'hatchabot.mjs'), source = '#!/usr/bin/env node\nconsole.log("the old CLI");\n';
    writeFileSync(oldCli, source, { mode: 0o755 });
    symlinkSync(oldCli, join(b.launchers, 'hatchabot'));
    symlinkSync(join(b.launchers, 'hatchabot'), join(b.launchers, 'hbt'));
    const r = b.run('link-cli.sh', '--no-doctor');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(oldCli, 'utf8')).toBe(source); // the other install is untouched
    for (const name of ['hatchabot', 'hbt']) {
      const l = join(b.launchers, name);
      expect(lstatSync(l).isSymbolicLink(), name).toBe(false);
      expect(readFileSync(l, 'utf8'), name).toContain(`"${b.app}/bin/hatchabot.mjs"`);
    }
  });

  it('a $, a backtick or a quote in the folder\'s name: the launchers run this install, and uninstall finds them (audit #039)', () => {
    const b = bundle('bundle$HOME `x` "q"');
    const r = b.run('link-cli.sh', '--no-doctor');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const name of ['hatchabot', 'hbt']) {
      const cli = spawnSync(join(b.launchers, name), ['version'], { encoding: 'utf8', env: b.env });
      expect(cli.status, name + cli.stderr).toBe(0);
      expect(cli.stdout.trim(), name).toBe(`node ran: ${b.app}/bin/hatchabot.mjs version`);
    }
    const u = b.run('uninstall.sh', '--yes');
    expect(u.status, u.stdout + u.stderr).toBe(0);
    expect(existsSync(join(b.launchers, 'hatchabot'))).toBe(false);
    expect(existsSync(join(b.launchers, 'hbt'))).toBe(false);
  });
});
