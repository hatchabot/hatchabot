/**
 * The add-a-runner streamlining: dedicated key management, the ssh-config
 * block that makes the HEADLESS service authenticate deterministically, the
 * paste-on-the-runner snippet, and the image copy. Each of these automates a
 * step that silently broke the first live runner when done by hand.
 */
import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ensureRunnerKey,
  ensureSshConfigBlock,
  installRuntimeImage,
  parseSshEndpoint,
  runnerSetupSnippet,
  sshConfigPath,
} from '../src/orchestrator/runnerSetup.js';

describe('parseSshEndpoint', () => {
  it('parses user/host/port and rejects non-ssh schemes', () => {
    expect(parseSshEndpoint('ssh://bob@runner.example')).toEqual({ user: 'bob', host: 'runner.example', port: undefined });
    expect(parseSshEndpoint('ssh://runner.example:2222')).toEqual({ user: undefined, host: 'runner.example', port: '2222' });
    expect(parseSshEndpoint('tcp://runner:2376')).toBeUndefined();
    expect(parseSshEndpoint('ssh://a@b@c')).toBeUndefined();
  });
});

describe('ensureRunnerKey', () => {
  it('creates a passphrase-less key once and returns the same pubkey after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-sshdir-'));
    const pub1 = await ensureRunnerKey({ sshDir: dir });
    expect(pub1).toMatch(/^ssh-ed25519 /);
    expect(existsSync(join(dir, 'agentclaw_runner'))).toBe(true);
    const pub2 = await ensureRunnerKey({ sshDir: dir });
    expect(pub2).toBe(pub1); // reused, not regenerated
  });
});

/** What ssh itself makes of a config for a host (no connection is made), or '' where no ssh client is installed. */
function sshResolve(dir: string, host: string): string {
  try {
    return execFileSync('ssh', ['-G', '-F', join(dir, 'config'), host], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: dir } });
  } catch { return ''; }
}

describe('ensureSshConfigBlock', () => {
  it('writes an IdentitiesOnly block once per host and leaves other config alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-sshcfg-'));
    writeFileSync(join(dir, 'config'), '# my own stuff\nHost mine\n    User me\n');
    await ensureSshConfigBlock('ssh://bob@runner.example:2222', { sshDir: dir });
    const cfg = readFileSync(join(dir, 'config'), 'utf8');
    expect(cfg).toContain('# my own stuff'); // untouched
    expect(cfg).toContain('Host runner.example');
    // User and port come from the address on every call, never from here (HB-0300).
    expect(cfg.split('Host *')[0]).not.toMatch(/^\s*(User|Port) /m);
    expect(cfg).toContain('IdentitiesOnly yes'); // beats any ssh-agent
    expect(cfg).toContain('StrictHostKeyChecking accept-new'); // no first-connect stall

    // Idempotent: a second add of the same host appends nothing.
    const before = cfg.length;
    await ensureSshConfigBlock('ssh://bob@runner.example:2222', { sshDir: dir });
    expect(readFileSync(join(dir, 'config'), 'utf8').length).toBe(before);
  });

  it('quotes a key path with spaces (or %) so ssh reads the real file (#153)', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'acl-sshcfg-')), 'Ada Lovelace 100%', '.ssh');
    await ensureSshConfigBlock('ssh://bob@runner.example', { sshDir: dir });
    const cfg = readFileSync(join(dir, 'config'), 'utf8');
    expect(cfg).toContain(`IdentityFile "${dir.replace(/%/g, '%%')}/agentclaw_runner"`);
    // What ssh itself makes of it, where ssh is installed (no connection is made).
    let resolved = '';
    try {
      resolved = execFileSync('ssh', ['-G', '-F', join(dir, 'config'), 'runner.example'], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: dir } });
    } catch { /* no ssh client here */ }
    // (-G prints the value before ssh expands its %% token back to %.)
    if (resolved) expect(resolved).toContain(`identityfile ${dir.replace(/%/g, '%%')}/agentclaw_runner\n`);
    expect(() => sshConfigPath('/home/x"y/.ssh/key')).toThrow(/quote or line break/);
  });

  it('a second address for the same machine on the default port is not sent to the first one\'s port (HB-0300)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-sshcfg-'));
    await ensureSshConfigBlock('ssh://bob@runner.example:2222', { sshDir: dir });
    await ensureSshConfigBlock('ssh://runner.example', { sshDir: dir });
    const cfg = readFileSync(join(dir, 'config'), 'utf8');
    expect(cfg.match(/^Host runner\.example$/gm)).toHaveLength(1);
    const resolved = sshResolve(dir, 'runner.example');
    if (resolved) {
      expect(resolved).toMatch(/^port 22$/m);
      expect(resolved).not.toMatch(/^user bob$/m);
    }
  });

  it('wins over a Host * written before it, and leaves what was there in force for every host (HB-0316)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-sshcfg-'));
    const mine = 'ServerAliveInterval 42\nHost *\n    IdentitiesOnly no\n    StrictHostKeyChecking ask\nHost mine\n    User me\n';
    writeFileSync(join(dir, 'config'), mine);
    await ensureSshConfigBlock('ssh://bob@runner.example', { sshDir: dir });
    await ensureSshConfigBlock('ssh://second.example', { sshDir: dir });
    const cfg = readFileSync(join(dir, 'config'), 'utf8');
    expect(cfg.endsWith(mine)).toBe(true); // the person's own lines, untouched, after ours
    const runner = sshResolve(dir, 'runner.example');
    if (runner) {
      expect(runner).toMatch(/^identitiesonly yes$/m);
      expect(runner).toMatch(/^stricthostkeychecking accept-new$/m);
      expect(runner).toMatch(/^serveraliveinterval 42$/m); // a top-level line still applies everywhere
      expect(sshResolve(dir, 'second.example')).toMatch(/^identitiesonly yes$/m);
      const other = sshResolve(dir, 'mine');
      expect(other).toMatch(/^identitiesonly no$/m);
      expect(other).toMatch(/^stricthostkeychecking ask$/m);
      expect(other).toMatch(/^user me$/m);
      expect(other).toMatch(/^serveraliveinterval 42$/m);
    }
  });

  it('two runners added at once both get their block; a symlinked config stays a symlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-sshcfg-'));
    const real = join(dir, 'dotfiles-config');
    writeFileSync(real, '# my own stuff\n', { mode: 0o644 });
    symlinkSync(real, join(dir, 'config'));
    await Promise.all([ensureSshConfigBlock('ssh://one.example', { sshDir: dir }), ensureSshConfigBlock('ssh://two.example', { sshDir: dir })]);
    expect(lstatSync(join(dir, 'config')).isSymbolicLink()).toBe(true);
    const cfg = readFileSync(real, 'utf8');
    expect(cfg).toContain('Host one.example');
    expect(cfg).toContain('Host two.example');
    expect(cfg).toContain('# my own stuff');
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.includes('hatchabot-'))).toEqual([]); // no temp file left
  });

  it('ignores tcp endpoints (no ssh side to configure)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-sshcfg2-'));
    await ensureSshConfigBlock('tcp://runner:2376', { sshDir: dir });
    expect(existsSync(join(dir, 'config'))).toBe(false);
  });
});

describe('runnerSetupSnippet', () => {
  it('authorizes the key idempotently and fixes PATH for non-interactive ssh', () => {
    const s = runnerSetupSnippet('ssh-ed25519 AAAA test-key');
    expect(s).toContain("k='ssh-ed25519 AAAA test-key'");
    expect(s).toContain('grep -qxF "$k"'); // a whole line: no duplicates, and a glued-on key is not "there"
    expect(s).toContain('authorized_keys');
    expect(s).toContain('/usr/local/bin'); // the macOS docker-not-found fix
    expect(s).toContain('command -v docker'); // self-check at the end
  });
});

describe('runnerSetupSnippet on a runner (in a sandbox: a temp HOME and a PATH of shims, no docker)', () => {
  const sandbox = () => {
    const home = mkdtempSync(join(tmpdir(), 'acl-runnerhome-'));
    mkdirSync(join(home, 'bin'));
    for (const c of ['mkdir', 'chmod', 'grep', 'cat', 'rm', 'cp', 'mv', 'tail', 'awk']) {
      const at = ['/usr/bin', '/bin'].map((d) => join(d, c)).find((f) => existsSync(f));
      if (at) symlinkSync(at, join(home, 'bin', c));
    }
    return { home, env: { HOME: home, PATH: join(home, 'bin') } };
  };
  // zsh wherever it is: a Mac's default, and not on every machine this runs on.
  const zsh = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout.trim();
  const shells = ['/bin/bash', zsh || '/bin/zsh', '/bin/sh'].filter((sh) => existsSync(sh));

  describe('authorized_keys (HB-0434)', () => {
    const NEW = 'ssh-ed25519 AAAAnew agentclaw control-plane -> runner';
    const paste = (sh: string, env: NodeJS.ProcessEnv) => spawnSync(sh, ['-c', `set -o noclobber\n${runnerSetupSnippet(NEW)}`], { env, encoding: 'utf8' });
    const keys = (home: string, text?: string) => {
      const f = join(home, '.ssh', 'authorized_keys');
      if (text !== undefined) { mkdirSync(join(home, '.ssh'), { recursive: true }); writeFileSync(f, text); }
      return readFileSync(f, 'utf8');
    };
    it('a last line with no newline stays whole, the key on its own line; a second paste changes nothing', () => {
      for (const sh of shells) {
        const { home, env } = sandbox();
        keys(home, 'ssh-ed25519 AAAAold someone-at-laptop');
        for (let i = 0; i < 2; i++) expect(paste(sh, env).status, sh).toBe(0);
        expect(keys(home), sh).toBe(`ssh-ed25519 AAAAold someone-at-laptop\n${NEW}\n`);
        expect(statSync(join(home, '.ssh', 'authorized_keys')).mode & 0o777, sh).toBe(0o600);
      }
    });
    it('a key an earlier paste glued on is split off, keeping both, and pasting again now repairs it', () => {
      for (const sh of shells) {
        const { home, env } = sandbox();
        keys(home, `ssh-ed25519 AAAAold someone-at-laptop${NEW}\nssh-ed25519 AAAAother x\n`);
        expect(paste(sh, env).status, sh).toBe(0);
        expect(keys(home), sh).toBe(`ssh-ed25519 AAAAold someone-at-laptop\n${NEW}\nssh-ed25519 AAAAother x\n`);
        expect(readdirSync(join(home, '.ssh')).filter((f) => f.includes('agentclaw-new')), sh).toEqual([]);
      }
    });
    it('a file this user cannot read: said so plainly, not one byte written, its mode kept; once readable a paste works', () => {
      if (process.getuid?.() === 0) return; // root reads everything
      for (const sh of shells) {
        for (const text of ['ssh-rsa AAAAold someone-at-laptop', `ssh-rsa AAAAold someone-at-laptop\n${NEW}\n`]) {
          const { home, env } = sandbox();
          keys(home, text);
          const f = join(home, '.ssh', 'authorized_keys');
          chmodSync(f, 0o200);
          const r = paste(sh, env);
          expect(r.status, sh).toBe(0);
          expect(r.stdout + r.stderr, sh).toMatch(/WARNING: could not read .*authorized_keys, so the key was not added/);
          expect(statSync(f).mode & 0o777, sh).toBe(0o200);
          chmodSync(f, 0o600);
          expect(readFileSync(f, 'utf8'), sh).toBe(text);
          // Made readable, the same paste does what it does for any file.
          expect(paste(sh, env).status, sh).toBe(0);
          expect(keys(home), sh).toBe(text.endsWith('\n') ? text : `${text}\n${NEW}\n`);
        }
      }
    });
    describe('a line that has the key any other way is the owner\'s: left to the byte, nothing added', () => {
      const BLOB = 'ssh-ed25519 AAAAnew';
      const MINE = 'ssh-rsa AAAAmine someone-at-laptop';
      const cases: Record<string, string> = {
        'from= options': `from="10.0.0.1" ${NEW}\n`,
        'from= options, no final newline': `${MINE}\nfrom="10.0.0.1" ${NEW}`,
        'restrict,command= options': `restrict,command="/usr/bin/docker system dial-stdio" ${NEW}\n`,
        'a command that itself looks like a key': `command="ssh-rsa AAAAquoted c" ${NEW}\n`,
        'options with no key of their own, run into it': `from="10.0.0.1"${NEW}\n`,
        'options, the key under another comment': `from="10.0.0.1" ${BLOB} the owner's own name\n`,
        'options, the key with no comment': `from="10.0.0.1" ${BLOB}\n`,
        'disabled by a comment': `# disabled by owner: ${NEW}\n`,
        'disabled, no space': `#${NEW}\n`,
        'disabled, a comment that names a key first': `# ${MINE}${NEW}\n`,
        'a longer comment': `${NEW} and more\n`,
        'a longer comment, run on': `${NEW}-and-more\n`,
        'another comment': `${BLOB} the owner's own name\n`,
        'CRLF endings': `${MINE}\r\n${NEW}\r\n`,
        'a later key run onto it (the key itself is read)': `${NEW}ssh-ed25519 AAAAlater y\n`,
        'a space before it, not a glue': `${MINE} ${NEW}\n`,
        'limited on one line, glued on another: the limit stands': `from="10.0.0.1" ${NEW}\n${MINE}${NEW}\n`,
      };
      for (const [name, text] of Object.entries(cases)) {
        it(name, () => {
          for (const sh of shells) {
            const { home, env } = sandbox();
            keys(home, text);
            for (let i = 0; i < 2; i++) {
              const r = paste(sh, env);
              expect(r.status, `${sh}: ${r.stderr}`).toBe(0);
              expect(keys(home), sh).toBe(text);
              expect(r.stdout, sh).toContain('this key is already in');
            }
            expect(readdirSync(join(home, '.ssh')).filter((f) => f.includes('agentclaw-new')), sh).toEqual([]);
          }
        });
      }
    });
    describe('a true glue, in every shell', () => {
      const glues: Record<string, string> = {
        'an earlier key with a comment': 'ssh-ed25519 AAAAold someone-at-laptop',
        'an earlier key with no comment': 'ssh-ed25519 AAAAold',
        'an earlier key with options, which stay on it': 'from="10.0.0.2",command="echo hi there" ssh-rsa AAAAold+/= c',
      };
      for (const [name, old] of Object.entries(glues)) {
        it(name, () => {
          for (const sh of shells) {
            const { home, env } = sandbox();
            keys(home, `# mine\n${old}${NEW}\nssh-rsa AAAAother y\n`);
            const r = paste(sh, env);
            expect(r.status, `${sh}: ${r.stderr}`).toBe(0);
            expect(keys(home), sh).toBe(`# mine\n${old}\n${NEW}\nssh-rsa AAAAother y\n`);
            expect(r.stdout, sh).not.toContain('this key is already in');
            expect(paste(sh, env).status, sh).toBe(0);
            expect(keys(home), sh).toBe(`# mine\n${old}\n${NEW}\nssh-rsa AAAAother y\n`);
          }
        });
      }
      it('the other lines keep their CRLF, and each glue in the file is split', () => {
        const { home, env } = sandbox();
        keys(home, `ssh-rsa AAAAa c\r\nssh-rsa AAAAb d${NEW}\nssh-rsa AAAAe f${NEW}\n`);
        expect(paste(shells[0]!, env).status).toBe(0);
        expect(keys(home)).toBe(`ssh-rsa AAAAa c\r\nssh-rsa AAAAb d\n${NEW}\nssh-rsa AAAAe f\n${NEW}\n`);
      });
    });
    describe('the write-back of a repair', () => {
      const GLUED = `ssh-ed25519 AAAAold x${NEW}\nssh-rsa AAAAother y\n`, SPLIT = `ssh-ed25519 AAAAold x\n${NEW}\nssh-rsa AAAAother y\n`;
      const COPY = 'authorized_keys.agentclaw-new';
      it('failing cuts the file short: the whole text stays beside it, it is said, and the next paste does not overwrite it', () => {
        for (const sh of shells) {
          const { home, env } = sandbox();
          keys(home, GLUED);
          // A disk that fills between the copy and the write: `>|` has already emptied the file.
          rmSync(join(home, 'bin', 'cat'));
          writeFileSync(join(home, 'bin', 'cat'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
          const r = paste(sh, env);
          expect(r.stdout, sh).toContain(`could not write ${home}/.ssh/authorized_keys; if it is now cut short, its whole text is in ${home}/.ssh/${COPY}`);
          expect(keys(home), sh).toBe('');
          expect(readFileSync(join(home, '.ssh', COPY), 'utf8'), sh).toBe(SPLIT);
          const again = paste(sh, env);
          expect(again.stdout, sh).toContain(`${home}/.ssh/${COPY} is left from an earlier try`);
          expect(readFileSync(join(home, '.ssh', COPY), 'utf8'), sh).toBe(SPLIT);
          expect(keys(home), sh).toBe('');
        }
      });
      it('the copy that cannot be written leaves the file as it was', () => {
        const { home, env } = sandbox();
        keys(home, GLUED);
        const awk = readlinkSync(join(home, 'bin', 'awk'));
        rmSync(join(home, 'bin', 'awk'));
        writeFileSync(join(home, 'bin', 'awk'), `#!/bin/sh\ncase "$*" in *m=fix*) echo half; exit 1 ;; esac\nexec '${awk}' "$@"\n`, { mode: 0o755 });
        const r = paste(shells[0]!, env);
        expect(r.stdout).toContain(`could not write ${home}/.ssh/${COPY}, so ${home}/.ssh/authorized_keys was left as it was`);
        expect(keys(home)).toBe(GLUED);
        expect(existsSync(join(home, '.ssh', COPY))).toBe(false);
      });
      it('a read-only file is said, and no copy is left', () => {
        if (process.getuid?.() === 0) return;
        const { home, env } = sandbox();
        keys(home, GLUED);
        chmodSync(join(home, '.ssh', 'authorized_keys'), 0o400);
        const r = paste(shells[0]!, env);
        expect(r.stdout).toContain('it is read-only');
        expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(GLUED);
        expect(existsSync(join(home, '.ssh', COPY))).toBe(false);
      });
    });
    it('a different key that only starts the same is not this one', () => {
      const { home, env } = sandbox();
      keys(home, 'ssh-ed25519 AAAAnewer agentclaw control-plane -> runner\n');
      expect(paste(shells[0]!, env).status).toBe(0);
      expect(keys(home)).toBe(`ssh-ed25519 AAAAnewer agentclaw control-plane -> runner\n${NEW}\n`);
    });
    it('a comment with bytes that are not UTF-8 is read as it is', () => {
      const { home, env } = sandbox();
      mkdirSync(join(home, '.ssh'));
      const f = join(home, '.ssh', 'authorized_keys');
      const text = Buffer.concat([Buffer.from('ssh-rsa AAAAold caf'), Buffer.from([0xe9]), Buffer.from(`${NEW}\n`)]);
      writeFileSync(f, text);
      expect(paste(shells[0]!, env).status).toBe(0);
      expect(readFileSync(f)).toEqual(Buffer.concat([Buffer.from('ssh-rsa AAAAold caf'), Buffer.from([0xe9]), Buffer.from(`\n${NEW}\n`)]));
    });
    it('a line already whole, and a file with a final newline or none yet, are left as they are', () => {
      const { home, env } = sandbox();
      expect(paste(shells[0]!, env).status).toBe(0);
      expect(keys(home)).toBe(`${NEW}\n`);
      keys(home, `ssh-ed25519 AAAAold x\n${NEW}\nssh-ed25519 AAAAmore y\n`);
      expect(paste(shells[0]!, env).status).toBe(0);
      expect(keys(home)).toBe(`ssh-ed25519 AAAAold x\n${NEW}\nssh-ed25519 AAAAmore y\n`);
    });
    it('a symlinked file stays a symlink', () => {
      const { home, env } = sandbox();
      mkdirSync(join(home, '.ssh'));
      writeFileSync(join(home, 'dot-keys'), `ssh-ed25519 AAAAold x${NEW}`);
      symlinkSync(join(home, 'dot-keys'), join(home, '.ssh', 'authorized_keys'));
      expect(paste(shells[0]!, env).status).toBe(0);
      expect(lstatSync(join(home, '.ssh', 'authorized_keys')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(home, 'dot-keys'), 'utf8')).toBe(`ssh-ed25519 AAAAold x\n${NEW}\n`);
    });
  });

  it('puts the PATH line above a ~/.bashrc that returns early for non-interactive shells (HB-0315)', () => {
    for (const sh of shells) {
      const { home, env } = sandbox();
      const guard = 'case $- in *i*) ;; *) return;; esac\nalias ll="ls -l"\n';
      writeFileSync(join(home, 'dotfiles-bashrc'), guard, { mode: 0o640 });
      symlinkSync(join(home, 'dotfiles-bashrc'), join(home, '.bashrc'));
      for (let i = 0; i < 2; i++) { // twice: idempotent
        // As pasted into a shell that refuses to overwrite files with > (set -o noclobber).
        const r = spawnSync(sh, ['-c', `set -o noclobber\n${runnerSetupSnippet('ssh-ed25519 AAAA test-key')}`], { env, encoding: 'utf8' });
        expect(r.status, `${sh}: ${r.stderr}`).toBe(0);
        expect(r.stdout).toContain('docker not found');
      }
      const rc = readFileSync(join(home, '.bashrc'), 'utf8');
      expect(rc.match(/agentclaw: docker on PATH/g), sh).toHaveLength(1);
      expect(rc.endsWith(guard), sh).toBe(true); // the person's own lines, whole, after ours
      expect(lstatSync(join(home, '.bashrc')).isSymbolicLink(), sh).toBe(true);
      expect(statSync(join(home, 'dotfiles-bashrc')).mode & 0o777).toBe(0o640);
      expect(readdirSync(home).filter((f) => f.includes('agentclaw-new'))).toEqual([]);
      // What a non-interactive ssh command's bash makes of it.
      const after = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', '. "$HOME/.bashrc"; printf "%s" "$PATH"'], { env, encoding: 'utf8' });
      expect(after.stdout, sh).toContain('/usr/local/bin');
      // A missing ~/.zshenv is made, holding just the line.
      expect(readFileSync(join(home, '.zshenv'), 'utf8')).toContain('export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"');
      expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe('ssh-ed25519 AAAA test-key\n');
    }
  });

  it('replaces a plain ~/.bashrc whole (its mode kept), and leaves one it cannot rewrite as it was, saying so', () => {
    const run = (sh: string, env: NodeJS.ProcessEnv) => spawnSync(sh, ['-c', `set -o noclobber\n${runnerSetupSnippet('ssh-ed25519 AAAA test-key')}`], { env, encoding: 'utf8' });
    const guard = '[ -z "$PS1" ] && return\nalias ll="ls -l"\n';
    for (const sh of shells) {
      const { home, env } = sandbox();
      writeFileSync(join(home, '.bashrc'), guard, { mode: 0o640 });
      expect(run(sh, env).status, sh).toBe(0);
      const rc = readFileSync(join(home, '.bashrc'), 'utf8');
      expect(rc.startsWith('# agentclaw: docker on PATH'), sh).toBe(true);
      expect(rc.endsWith(guard), sh).toBe(true);
      expect(statSync(join(home, '.bashrc')).mode & 0o777, sh).toBe(0o640);
      expect(readdirSync(home).filter((f) => f.includes('agentclaw-new')), sh).toEqual([]);
      if (process.getuid?.() === 0) continue; // root reads and writes anything
      // One it cannot read: never replaced by the PATH line alone.
      const { home: h2, env: e2 } = sandbox();
      writeFileSync(join(h2, '.bashrc'), guard, { mode: 0o200 });
      const r2 = run(sh, e2);
      expect(r2.stdout, sh).toContain(`could not add docker's PATH line to ${h2}/.bashrc`);
      chmodSync(join(h2, '.bashrc'), 0o600);
      expect(readFileSync(join(h2, '.bashrc'), 'utf8'), sh).toBe(guard);
      expect(readdirSync(h2).filter((f) => f.includes('agentclaw-new')), sh).toEqual([]);
      // A symlink into a store it cannot write (home-manager): left whole, said, no litter.
      const { home: h3, env: e3 } = sandbox();
      writeFileSync(join(h3, 'store-bashrc'), guard, { mode: 0o444 });
      symlinkSync(join(h3, 'store-bashrc'), join(h3, '.bashrc'));
      const r3 = run(sh, e3);
      expect(r3.stdout, sh).toContain('it is read-only');
      expect(readFileSync(join(h3, 'store-bashrc'), 'utf8'), sh).toBe(guard);
      expect(lstatSync(join(h3, '.bashrc')).isSymbolicLink(), sh).toBe(true);
      expect(readdirSync(h3).filter((f) => f.includes('agentclaw-new')), sh).toEqual([]);
    }
  });
});

describe('installRuntimeImage', () => {
  const stub = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-imgdocker-'));
    const bin = join(dir, 'docker');
    writeFileSync(bin, `#!/usr/bin/env bash\n${script}`, { mode: 0o755 });
    return bin;
  };

  it('pipes save into load and reports success', async () => {
    const docker = stub(`
if [ "$1" = save ]; then echo image-bytes; exit 0; fi
cat > /dev/null; exit 0  # -H … load: consume stdin
`);
    const res = await installRuntimeImage('ssh://r@x', { docker });
    expect(res).toEqual({ ok: true });
  });

  it('reports the receiving side failing', async () => {
    const docker = stub(`
if [ "$1" = save ]; then echo image-bytes; exit 0; fi
cat > /dev/null; echo 'no space left' >&2; exit 1
`);
    const res = await installRuntimeImage('ssh://r@x', { docker });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('no space left');
  });

  it('a receiver that fails early takes the sender with it (no docker save left blocked on its pipe, audit 2026-10-22)', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'acl-imgpid-')), 'save.pid');
    const docker = stub(`
if [ "$1" = save ]; then echo $$ > ${JSON.stringify(pidFile)}; echo start; exec sleep 30; fi
echo 'load refused' >&2; exit 1
`);
    const res = await installRuntimeImage('ssh://r@x', { docker, stallMs: 10_000 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('load refused');
    // Killed before it wrote its pid is gone too; otherwise its pid must be.
    const { readFileSync } = await import('node:fs');
    const pid = () => { try { return Number(readFileSync(pidFile, 'utf8')) || 0; } catch { return 0; } };
    const alive = () => { const p = pid(); if (!p) return false; try { process.kill(p, 0); return true; } catch { return false; } };
    for (let i = 0; i < 120 && alive(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(alive()).toBe(false);
  });

  it('sends it compressed (docker load reads gzip) and reports how far it has come', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-imgcopy-'));
    const got = join(dir, 'received.gz');
    const docker = stub(`
if [ "$1" = save ]; then head -c 300000 /dev/zero; exit 0; fi
cat > ${JSON.stringify(got)}; exit 0
`);
    const seen: number[] = [];
    const res = await installRuntimeImage('ssh://r@x', { docker, total: 300000, onProgress: (p) => seen.push(p.bytes) });
    expect(res).toEqual({ ok: true });
    expect(seen.at(-1)).toBe(300000);
    const { gunzipSync } = await import('node:zlib');
    const { readFileSync } = await import('node:fs');
    const body = readFileSync(got);
    expect(body.length).toBeLessThan(300000 / 10); // zeros compress: it went over gzipped
    expect(gunzipSync(body).length).toBe(300000);
  });

  it('a copy that stops moving is stopped (not a fixed ceiling: a slow copy that moves goes on)', async () => {
    const docker = stub(`
if [ "$1" = save ]; then echo start; sleep 30; exit 0; fi
cat > /dev/null; exit 0
`);
    const res = await installRuntimeImage('ssh://r@x', { docker, stallMs: 300 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/stopped moving/);
  });

  it('a receiver that has loaded it before the sender closes is a good copy, not a failed one (HB-0319)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-imgorder-'));
    const docker = join(dir, 'docker');
    // The sender closes its output, then takes a moment to exit 0; the receiver exits 0 at the end of its input.
    writeFileSync(docker, `#!${process.execPath}
const fs = require('fs'); const a = process.argv.slice(2);
if (a.includes('info')) console.log('x86_64');
else if (a.includes('save')) { fs.writeSync(1, 'image-bytes'); fs.closeSync(1); setTimeout(() => process.exit(0), 700); }
else if (a.includes('load')) { process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); }
else process.exit(2);
`, { mode: 0o755 });
    expect(await installRuntimeImage('ssh://r@x', { docker, stallMs: 10_000 })).toEqual({ ok: true });
    // The sender failing after the receiver loaded is still a failure, with its exit code.
    writeFileSync(docker, readFileSync(docker, 'utf8').replace('process.exit(0), 700', 'process.exit(5), 300'));
    expect(await installRuntimeImage('ssh://r@x', { docker, stallMs: 10_000 })).toEqual({ ok: false, error: 'exit 5/0' });
  });

  it('a runner unpacking the last layers after the image is all sent is not "stalled" (2026-10-09)', async () => {
    const docker = stub(`
if [ "$1" = save ]; then echo image-bytes; exit 0; fi
cat > /dev/null; sleep 1; exit 0  # load: still unpacking after save ended
`);
    const res = await installRuntimeImage('ssh://r@x', { docker, stallMs: 300 });
    expect(res).toEqual({ ok: true });
  });

  describe('a runner on another CPU (2026-10-09)', () => {
    const archStub = (dir: string, extra = '') => stub(`
echo "$*" >> ${JSON.stringify(join(dir, 'calls'))}
if [ "$1" = info ]; then echo aarch64; exit 0; fi
if [ "$1" = -H ] && [ "$3" = info ]; then echo x86_64; exit 0; fi
${extra}
if [ "$1" = save ]; then echo image-bytes; exit 0; fi
cat > /dev/null; exit 0
`);
    it('is not sent this machine\'s image (it would not run there)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'acl-imgarch-'));
      const res = await installRuntimeImage('ssh://r@x', { docker: archStub(dir) });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/built for aarch64.*runner is x86_64/);
      expect(readFileSync(join(dir, 'calls'), 'utf8')).not.toMatch(/^save /m);
    });
    it('pulls the published image of the same OpenClaw there and tags it as the runtime image', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'acl-imgarch-'));
      const docker = archStub(dir, `if [ "$3" = image ] && [ "$4" = inspect ]; then echo 2026.9.8; exit 0; fi`);
      const res = await installRuntimeImage('ssh://r@x', { docker, published: { ref: 'registry.example.org/runtime:2026.9.8', openclawVersion: '2026.9.8' } });
      expect(res).toEqual({ ok: true, pulled: 'registry.example.org/runtime:2026.9.8' });
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      expect(calls).toContain('-H ssh://r@x pull --quiet registry.example.org/runtime:2026.9.8');
      expect(calls).toContain('-H ssh://r@x tag registry.example.org/runtime:2026.9.8 hatchabot-runtime:latest');
      expect(calls).not.toMatch(/^save /m);
    });
    it('refuses a published image whose label says another OpenClaw', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'acl-imgarch-'));
      const docker = archStub(dir, `if [ "$3" = image ] && [ "$4" = inspect ]; then echo 2026.7.1; exit 0; fi`);
      const res = await installRuntimeImage('ssh://r@x', { docker, published: { ref: 'registry.example.org/runtime:2026.9.8', openclawVersion: '2026.9.8' } });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/carries OpenClaw 2026\.7\.1/);
      expect(readFileSync(join(dir, 'calls'), 'utf8')).not.toMatch(/ tag /);
    });
  });
});

describe('HB-0029: tcp:// runners need a TLS client certificate here', () => {
  it('tcpTlsProblem names what is missing; ssh:// never needs one', async () => {
    const { tcpTlsProblem, dockerConnArgs } = await import('../src/providers/runnerEndpoint.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const empty = mkdtempSync(join(tmpdir(), 'hb-certs-'));
    expect(tcpTlsProblem('tcp://runner:2376', { DOCKER_CERT_PATH: empty })).toMatch(/ca\.pem, cert\.pem, key\.pem/);
    expect(tcpTlsProblem('ssh://runner@host', { DOCKER_CERT_PATH: empty })).toBeUndefined();
    for (const f of ['ca.pem', 'cert.pem', 'key.pem']) writeFileSync(join(empty, f), 'made-up\n');
    expect(tcpTlsProblem('tcp://runner:2376', { DOCKER_CERT_PATH: empty })).toBeUndefined();
    // Default place: ~/.docker of the given home.
    expect(tcpTlsProblem('tcp://runner:2376', {}, empty)).toMatch(/\.docker/);
    expect(dockerConnArgs('tcp://runner:2376')).toEqual(['-H', 'tcp://runner:2376', '--tlsverify']);
    expect(dockerConnArgs('ssh://runner@host')).toEqual(['-H', 'ssh://runner@host']);
  });
});
