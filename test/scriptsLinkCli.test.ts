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

function bundle(folder = 'hatchabot', homeName = 'home') {
  const root = mkdtempSync(join(tmpdir(), 'hb-link-cli-')); dirs.push(root);
  const home = join(root, homeName), bin = join(root, 'bin'), app = join(root, folder), launchers = join(home, '.local', 'bin');
  for (const d of [join(app, 'scripts'), join(app, '.node', 'bin'), join(app, 'bin'), bin, launchers]) mkdirSync(d, { recursive: true });
  writeFileSync(join(app, 'BUNDLE.json'), '{"tag":"v1.0.0","platform":"linux-x64"}\n');
  shim(join(app, '.node', 'bin'), 'node', 'printf "node ran: %s\\n" "$*"');
  writeFileSync(join(app, 'bin', 'hatchabot.mjs'), '// a made-up CLI\n');
  for (const f of ['link-cli.sh', 'uninstall.sh', 'backup-owner.sh']) writeFileSync(join(app, 'scripts', f), readFileSync(join('scripts', f)), { mode: 0o755 });
  for (const t of ['systemctl', 'docker', 'npm', 'launchctl']) shim(bin, t, 'exit 0');
  const env = scriptEnv(home, `${launchers}:${bin}:/usr/bin:/bin`);
  const run = (script: string, ...args: string[]) => spawnSync('bash', [join(app, 'scripts', script), ...args], { encoding: 'utf8', input: '', env });
  return { root, home, app, launchers, bin, env, run };
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

describe('scripts/link-cli.sh on a bundle install leaves another program\'s command where it is (HB-1077)', () => {
  // Another program's command, which writes that it ran when it does.
  const other = (b: ReturnType<typeof bundle>, at: string) => {
    const body = `#!/bin/sh\n# made-up-tool: not Hatchabot\necho "other program ran: $*" >> '${join(b.root, 'other.log')}'\n`;
    writeFileSync(at, body, { mode: 0o755 });
    return body;
  };
  const otherRan = (b: ReturnType<typeof bundle>) => existsSync(join(b.root, 'other.log'));

  for (const onPath of [true, false]) {
    it(`another program at ~/.local/bin/hbt (${onPath ? 'on the PATH' : 'not on the PATH'}): kept, and hatchabot is linked`, () => {
      const b = bundle();
      const at = join(b.launchers, 'hbt'), body = other(b, at);
      const env = onPath ? b.env : scriptEnv(b.home, `${b.bin}:/usr/bin:/bin`);
      const r = spawnSync('bash', [join(b.app, 'scripts', 'link-cli.sh'), '--no-doctor'], { encoding: 'utf8', input: '', env });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(readFileSync(at, 'utf8')).toBe(body);
      expect(r.stdout).toContain(`another program here is already called hbt (${at}), so use the full name: hatchabot`);
      expect(r.stdout).toContain(`linked: ${join(b.launchers, 'hatchabot')}\n`);
      expect(readFileSync(join(b.launchers, 'hatchabot'), 'utf8')).toContain(`"${b.app}/bin/hatchabot.mjs"`);
    });
  }

  it('a link there that leads to another program is kept too', () => {
    const b = bundle();
    const tool = join(b.root, 'other-tool'); const body = other(b, tool);
    symlinkSync(tool, join(b.launchers, 'hbt'));
    const r = b.run('link-cli.sh', '--no-doctor');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lstatSync(join(b.launchers, 'hbt')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(b.launchers, 'hbt'), 'utf8')).toBe(body);
  });

  it('another program at ~/.local/bin/hatchabot: kept and not run; the run says so and fails, hbt is still linked', () => {
    const b = bundle();
    const at = join(b.launchers, 'hatchabot'), body = other(b, at);
    const r = b.run('link-cli.sh'); // with the doctor at the end, which would run "hatchabot doctor"
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${at} is another program, not Hatchabot's, so it was left as it is`);
    expect(readFileSync(at, 'utf8')).toBe(body);
    expect(otherRan(b)).toBe(false);
    expect(readFileSync(join(b.launchers, 'hbt'), 'utf8')).toContain(`"${b.app}/bin/hatchabot.mjs"`);
  });

  it('its own launchers, from a run before or another bundle install, are still replaced', () => {
    const b = bundle();
    expect(b.run('link-cli.sh', '--no-doctor').status).toBe(0);
    for (const name of ['hatchabot', 'hbt']) writeFileSync(join(b.launchers, name), '#!/usr/bin/env bash\n# Hatchabot (x) — written by scripts/link-cli.sh\nexec "/elsewhere/.node/bin/node" "/elsewhere/bin/hatchabot.mjs" "$@"\n', { mode: 0o755 });
    const r = b.run('link-cli.sh', '--no-doctor');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const name of ['hatchabot', 'hbt']) expect(readFileSync(join(b.launchers, name), 'utf8'), name).toContain(`"${b.app}/bin/hatchabot.mjs"`);
  });

  it('the launcher the rename from AgentClaw wrote (scripts/migrate-rename-host.sh) is replaced, and the link to it then runs this install (review of HB-1077)', () => {
    const b = bundle();
    // What that script writes, for the checkout it moved.
    const migrated = `#!/usr/bin/env bash\ncd "${join(b.root, 'old-checkout')}" && exec node_modules/.bin/tsx src/cli.ts "$@"\n`;
    writeFileSync(join(b.launchers, 'hatchabot'), migrated, { mode: 0o755 });
    symlinkSync(join(b.launchers, 'hatchabot'), join(b.launchers, 'agentclaw'));
    expect(readFileSync('scripts/migrate-rename-host.sh', 'utf8')).toContain(`printf '#!/usr/bin/env bash\\ncd "%s" && exec node_modules/.bin/tsx src/cli.ts "$@"\\n'`);
    const r = b.run('link-cli.sh', '--no-doctor');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const name of ['hatchabot', 'agentclaw']) expect(readFileSync(join(b.launchers, name), 'utf8'), name).toContain(`"${b.app}/bin/hatchabot.mjs"`);
  });

  it('that launcher is replaced too while the checkout it runs is still there, as long as that checkout is Hatchabot\'s', () => {
    const b = bundle();
    const checkout = join(b.root, 'old-checkout'); mkdirSync(checkout);
    writeFileSync(join(checkout, 'package.json'), '{\n  "name": "hatchabot",\n  "version": "1.0.0"\n}\n');
    writeFileSync(join(b.launchers, 'hatchabot'), `#!/usr/bin/env bash\ncd "${checkout}" && exec node_modules/.bin/tsx src/cli.ts "$@"\n`, { mode: 0o755 });
    const r = b.run('link-cli.sh', '--no-doctor');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(b.launchers, 'hatchabot'), 'utf8')).toContain(`"${b.app}/bin/hatchabot.mjs"`);
  });

  // Another TypeScript tool's wrapper can look much like it: "cd to the
  // project, run its CLI with tsx" is a common shape (review of HB-1077).
  const wrappers: Array<[string, (b: ReturnType<typeof bundle>) => string]> = [
    ['a longer wrapper with the same run line', (b) => `#!/usr/bin/env bash\n# made-up-tool: not Hatchabot\nDIR="${join(b.root, 'other-tool')}"\ncd "$DIR" && exec node_modules/.bin/tsx src/cli.ts "$@"\n`],
    ['the same two lines, for a checkout of another tool', (b) => {
      const dir = join(b.root, 'other-tool'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), '{"name":"made-up-tool","version":"1.0.0"}\n');
      return `#!/usr/bin/env bash\ncd "${dir}" && exec node_modules/.bin/tsx src/cli.ts "$@"\n`;
    }],
  ];
  for (const [what, write] of wrappers) {
    for (const name of ['hatchabot', 'hbt']) {
      it(`another tool's tsx wrapper at ~/.local/bin/${name} (${what}) is kept`, () => {
        const b = bundle();
        const at = join(b.launchers, name), body = write(b);
        writeFileSync(at, body, { mode: 0o755 });
        const r = b.run('link-cli.sh', '--no-doctor');
        expect(readFileSync(at, 'utf8')).toBe(body);
        if (name === 'hbt') {
          expect(r.status, r.stdout + r.stderr).toBe(0);
          expect(r.stdout).toContain(`another program here is already called hbt (${at})`);
        } else {
          expect(r.status, r.stdout + r.stderr).toBe(1);
          expect(r.stdout).toContain(`${at} is another program, not Hatchabot's, so it was left as it is`);
        }
      });
    }
  }

  it('the rename\'s launcher shape at ~/.local/bin/hbt is kept: that script wrote no hbt', () => {
    const b = bundle();
    const at = join(b.launchers, 'hbt'), body = `#!/usr/bin/env bash\ncd "${join(b.root, 'old-checkout')}" && exec node_modules/.bin/tsx src/cli.ts "$@"\n`;
    writeFileSync(at, body, { mode: 0o755 });
    const r = b.run('link-cli.sh', '--no-doctor');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(at, 'utf8')).toBe(body);
    expect(readFileSync(join(b.launchers, 'hatchabot'), 'utf8')).toContain(`"${b.app}/bin/hatchabot.mjs"`);
  });

  it('a link left by a native install since removed (it leads nowhere now) is replaced', () => {
    const b = bundle();
    symlinkSync(join(b.root, 'removed-native', 'bin', 'hatchabot.mjs'), join(b.launchers, 'hatchabot'));
    symlinkSync(join(b.launchers, 'hatchabot'), join(b.launchers, 'hbt'));
    const r = b.run('link-cli.sh', '--no-doctor');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    for (const name of ['hatchabot', 'hbt']) expect(readFileSync(join(b.launchers, name), 'utf8'), name).toContain(`"${b.app}/bin/hatchabot.mjs"`);
  });
});

describe('scripts/link-cli.sh writes a PATH line a new shell reads as written (audit, 2026-10-29)', () => {
  it('a $, a backtick or a quote in the home folder\'s name stays in the profile\'s line, and a second run adds no other', () => {
    const b = bundle('hatchabot', 'home$EXPANSION `x` "q"');
    writeFileSync(join(b.home, '.bashrc'), '');
    // ~/.local/bin is not on the PATH yet, so the profile gets the line.
    const env = scriptEnv(b.home, `${b.bin}:/usr/bin:/bin`, { SHELL: '/bin/bash' });
    const link = () => spawnSync('bash', [join(b.app, 'scripts', 'link-cli.sh'), '--no-doctor'], { encoding: 'utf8', input: '', env });
    const r = link();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const shell = spawnSync('bash', ['--noprofile', '--norc', '-c', '. "$HOME/.bashrc"; printf %s "$PATH"'], { encoding: 'utf8', env: scriptEnv(b.home, '/usr/bin:/bin') });
    expect(shell.status, shell.stderr).toBe(0);
    expect(shell.stdout.split(':')[0]).toBe(b.launchers);
    expect(link().status).toBe(0);
    expect(readFileSync(join(b.home, '.bashrc'), 'utf8').match(/# hatchabot CLI/g)).toHaveLength(1);
  });
});
