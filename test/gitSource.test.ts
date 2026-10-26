import { describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitRemovalScript, buildGitSyncScript, normalizeGitUrl, gitSyncReason, buildPublicGitSyncScript, isPublicGitUrl } from '../src/orchestrator/gitSource.js';

describe('normalizeGitUrl', () => {
  it('normalizes ssh, ssh://, and https forms to the ssh clone URL', () => {
    for (const input of [
      'git@github.com:example-owner/household-ai-defs.git',
      'git@github.com:example-owner/household-ai-defs',
      'https://github.com/example-owner/household-ai-defs',
      'https://github.com/example-owner/household-ai-defs.git',
      'ssh://git@github.com/example-owner/household-ai-defs.git',
    ]) {
      expect(normalizeGitUrl(input)).toEqual({
        sshUrl: 'git@github.com:example-owner/household-ai-defs.git',
        httpsUrl: 'https://github.com/example-owner/household-ai-defs.git',
        host: 'github.com',
        repoName: 'household-ai-defs',
      });
    }
  });

  it('supports non-github hosts', () => {
    expect(normalizeGitUrl('git@gitlab.com:team/thing.git')).toMatchObject({
      host: 'gitlab.com',
      repoName: 'thing',
    });
  });

  it('rejects junk, traversal, and shell metacharacters', () => {
    for (const bad of [
      'not a url',
      'github.com/example-owner/repo', // no scheme/user
      'git@github.com:example-owner/../secret.git',
      'git@github.com:example-owner/re;po.git',
      'https://github.com/onlyowner',
      '',
    ]) {
      expect(normalizeGitUrl(bad), bad).toBeNull();
    }
  });
});

describe('buildGitSyncScript', () => {
  const script = buildGitSyncScript(
    { mountName: 'defs', sshUrl: 'git@github.com:example-owner/defs.git', host: 'github.com' },
    'QkFTRTY0',
    { name: 'Stock Watcher', email: 'stock-watcher@example.org' },
  );

  it('writes the key, pins the host, and clones only when absent', () => {
    expect(script).toContain('/home/node/.openclaw/.ssh/defs_deploy');
    expect(script).toContain('base64 -d'); // key written from base64
    expect(script).toContain('ssh-keyscan');
    expect(script).toContain("if [ ! -d '/home/node/.openclaw/defs'/.git ]"); // idempotent clone
    expect(script).toContain("git clone 'git@github.com:example-owner/defs.git'");
    expect(script).toContain('core.sshCommand');
    expect(script).toContain("user.email 'stock-watcher@example.org'");
  });

  it('shell-quotes the commit name so spaces are safe', () => {
    expect(script).toContain("user.name 'Stock Watcher'");
  });

  it('takes away a .pub or -cert.pub beside the key, which ssh would offer instead of it (HB-0001)', () => {
    const lines = script.split('\n');
    const write = lines.findIndex((l) => l.includes('base64 -d > /home/node/.openclaw/.ssh/defs_deploy'));
    const clean = lines.indexOf('rm -f /home/node/.openclaw/.ssh/defs_deploy.pub /home/node/.openclaw/.ssh/defs_deploy-cert.pub');
    expect(write).toBeGreaterThan(-1);
    expect(clean).toBeGreaterThan(write);
    expect(clean).toBeLessThan(lines.findIndex((l) => l.includes('git clone')));
  });
});

describe('a stale <key>.pub on the volume no longer makes the host refuse the key (HB-0001)', () => {
  // The script's key lines in a sandbox (a temp folder for the container's),
  // then ssh -i that key against a throwaway sshd run as this user on a free
  // loopback port, which accepts only the stored key. Skipped where there is
  // no sshd. The failure it guards: ssh offered the .pub's key, never the -i one.
  // It judges the authentication (ssh's own "Authenticated to" line), not the
  // remote command: a CI runner's account let the key in, then exited 1.
  const sshd = '/usr/sbin/sshd';
  const freePort = () => new Promise<number>((done) => { const srv = createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address() as { port: number }; srv.close(() => done(port)); }); });
  const keygen = (file: string, comment: string) => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]);

  it.skipIf(!existsSync(sshd))('the stored key gets in although an old .pub and -cert.pub were beside it', async () => {
    const base = mkdtempSync(join(tmpdir(), 'hb-stalepub-'));
    const port = await freePort();
    try {
      const sshDir = join(base, '.ssh');
      mkdirSync(sshDir);
      keygen(join(base, 'hostkey'), 'host');
      keygen(join(base, 'stored'), 'stored');
      keygen(join(base, 'stale'), 'stale');
      writeFileSync(join(base, 'authorized_keys'), readFileSync(join(base, 'stored.pub')));
      writeFileSync(join(base, 'sshd_config'), [
        `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${join(base, 'hostkey')}`,
        `AuthorizedKeysFile ${join(base, 'authorized_keys')}`, `PidFile ${join(base, 'sshd.pid')}`,
        'StrictModes no', 'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', '',
      ].join('\n'));
      const live = spawn(sshd, ['-D', '-e', '-f', join(base, 'sshd_config')], { stdio: 'ignore' });
      try {
        const key = join(sshDir, 'defs_deploy');
        const login = () => spawnSync('ssh', ['-F', '/dev/null', '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=VERBOSE', '-p', String(port), '127.0.0.1', 'true'],
          { env: { PATH: process.env.PATH!, HOME: base }, encoding: 'utf8', timeout: 15_000 });
        // The left-over files, then the sync script's own key lines.
        writeFileSync(`${key}.pub`, readFileSync(join(base, 'stale.pub')));
        writeFileSync(`${key}-cert.pub`, 'not a certificate\n');
        const b64 = readFileSync(join(base, 'stored')).toString('base64');
        const lines = buildGitSyncScript({ mountName: 'defs', sshUrl: 'git@git.example.org:example-owner/defs.git', host: 'git.example.org' }, b64, { name: 'Stock Watcher', email: 'stock-watcher@example.org' })
          .split('\n').filter((l) => /base64 -d|^rm -f/.test(l)).map((l) => l.split('/home/node/.openclaw').join(base));
        // sshd takes a moment to listen; the stale .pub is refused once it does.
        let before = login();
        for (let i = 0; i < 50 && /Connection (refused|reset)|kex_exchange_identification/i.test(before.stderr); i++) { await new Promise((r) => setTimeout(r, 100)); before = login(); }
        expect(before.stderr).toMatch(/Permission denied \(publickey/);
        expect(before.stderr).not.toMatch(/Authenticated to/);
        execFileSync('bash', ['-c', ['set -e', ...lines].join('\n')], { env: { PATH: process.env.PATH!, HOME: base } });
        expect(readdirSync(sshDir).sort()).toEqual(['defs_deploy']);
        const after = login();
        expect(after.stderr).toMatch(/Authenticated to 127\.0\.0\.1 .* using "publickey"/);
        expect(after.stderr).not.toMatch(/Permission denied/);
      } finally { live.kill(); }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('removing a git source takes it off the volume (HB-0002)', () => {
  // The removal script's own lines in a sandbox: a temp folder for the container's.
  const env = (base: string) => ({ PATH: process.env.PATH!, HOME: base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  const volume = (origin?: string) => {
    const base = mkdtempSync(join(tmpdir(), 'hb-gitrm-'));
    mkdirSync(join(base, '.ssh'));
    for (const f of ['defs_deploy', 'defs_deploy.pub', 'defs_deploy-cert.pub', 'other_deploy']) writeFileSync(join(base, '.ssh', f), 'made-up');
    const clone = join(base, 'defs');
    const git = (...a: string[]) => execFileSync('git', ['-C', clone, ...a], { env: env(base), encoding: 'utf8' }).trim();
    if (origin) {
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', clone], { env: env(base) });
      git('remote', 'add', 'origin', origin);
      git('config', 'core.sshCommand', 'ssh -i /home/node/.openclaw/.ssh/defs_deploy -o IdentitiesOnly=yes'.split('/home/node/.openclaw').join(base));
      writeFileSync(join(clone, 'notes.md'), 'work');
    }
    return { base, clone, git };
  };
  const run = (script: string, base: string) =>
    spawnSync('bash', ['-c', script.split('/home/node/.openclaw').join(base)], { env: env(base), encoding: 'utf8' });

  it('the key, its .pub and -cert.pub, and the clone of that repo all go; nothing else does', () => {
    const v = volume('https://github.com/example-owner/defs'); // cloned public, added back with a key: same repo
    const res = run(buildGitRemovalScript('defs', 'git@github.com:example-owner/defs.git'), v.base);
    expect(res.status).toBe(0);
    expect(existsSync(v.clone)).toBe(false);
    expect(readdirSync(join(v.base, '.ssh'))).toEqual(['other_deploy']);
    rmSync(v.base, { recursive: true, force: true });
  });

  it('a folder holding another repo stays; only an sshCommand naming the key is taken off', () => {
    const v = volume('git@github.com:example-owner/old-notes.git');
    const res = run(buildGitRemovalScript('defs', 'git@github.com:example-owner/defs.git'), v.base);
    expect(res.status).toBe(0);
    expect(readFileSync(join(v.clone, 'notes.md'), 'utf8')).toBe('work');
    expect(() => v.git('config', '--get', 'core.sshCommand')).toThrow();
    rmSync(v.base, { recursive: true, force: true });
  });

  it('keeps the clone when another source has the name now, or the removal predates the address', () => {
    for (const script of [buildGitRemovalScript('defs', 'git@github.com:example-owner/defs.git', { keepClone: true }), buildGitRemovalScript('defs', null)]) {
      const v = volume('git@github.com:example-owner/defs.git');
      expect(run(script, v.base).status).toBe(0);
      expect(readFileSync(join(v.clone, 'notes.md'), 'utf8')).toBe('work');
      expect(existsSync(join(v.base, '.ssh', 'defs_deploy.pub'))).toBe(false);
      expect(() => v.git('config', '--get', 'core.sshCommand')).toThrow();
      rmSync(v.base, { recursive: true, force: true });
    }
  });

  it('a public repo that never cloned: done, with nothing to remove', () => {
    const v = volume();
    expect(run(buildGitRemovalScript('defs', 'https://github.com/example-owner/defs.git'), v.base).status).toBe(0);
    rmSync(v.base, { recursive: true, force: true });
  });
});

describe('gitSyncReason', () => {
  it('turns the common publickey failure into the actual fix', () => {
    // The real stderr Hatchabot saw in the field.
    const out = gitSyncReason(
      "Cloning into '/home/node/.openclaw/hatchabot-ai'...\n" +
      'git@github.com: Permission denied (publickey).\r\n' +
      'fatal: Could not read from remote repository.\n',
    );
    expect(out).toMatch(/deploy key/i);
    expect(out).toMatch(/rebuild/i);
    expect(out).not.toMatch(/publickey/); // git's words replaced by the user's
  });

  it('distinguishes the other failures an owner can act on', () => {
    expect(gitSyncReason('ERROR: Repository not found.')).toMatch(/wasn't found/i);
    expect(gitSyncReason('Host key verification failed.')).toMatch(/SSH key/i);
    expect(gitSyncReason('ssh: Could not resolve hostname github.com')).toMatch(/network or DNS/i);
  });

  it('keeps git\'s own words for anything unrecognised, bounded', () => {
    expect(gitSyncReason('fatal: something odd happened')).toContain('something odd happened');
    expect(gitSyncReason('')).toBe('Clone failed.');
    expect(gitSyncReason('x'.repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe('public repos over https (no deploy key)', () => {
  it('normalizeGitUrl also yields the https clone URL for every input shape', () => {
    for (const u of ['git@github.com:hatchabot/hatchabot.git', 'ssh://git@github.com/hatchabot/hatchabot', 'https://github.com/hatchabot/hatchabot', 'http://github.com/hatchabot/hatchabot.git'])
      expect(normalizeGitUrl(u)!.httpsUrl).toBe('https://github.com/hatchabot/hatchabot.git');
    expect(isPublicGitUrl('https://github.com/a/b.git')).toBe(true);
    expect(isPublicGitUrl('git@github.com:a/b.git')).toBe(false);
    expect(isPublicGitUrl(undefined)).toBe(false);
  });
  it('clones over https only, with no key, no ssh setup, no prompts, and push disabled', () => {
    const s = buildPublicGitSyncScript({ mountName: 'hatchabot', httpsUrl: 'https://github.com/hatchabot/hatchabot.git' }, { name: "O'Brien Bot", email: 'helper@example.org' });
    expect(s).toContain("git -c credential.helper= clone --quiet 'https://github.com/hatchabot/hatchabot.git' '/home/node/.openclaw/hatchabot'");
    expect(s).toContain('GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https');
    expect(s).toContain("if [ ! -d '/home/node/.openclaw/hatchabot'/.git ]"); // idempotent
    expect(s).toContain('remote.origin.pushurl');
    expect(s).toContain("'O'\\''Brien Bot'"); // quoted
    expect(s).not.toMatch(/ssh|base64|_deploy/);
  });
  describe('a clone kept on the volume from an earlier source at the same mount (#88, #89)', () => {
    // Run the script's own lines on a real clone in a sandbox: the lines that
    // reach the network are left out (the clone becomes an empty repo with
    // that origin), and the container's folder is a temp one.
    const run = (script: string, base: string) => {
      const lines = script.split('\n')
        .filter((l) => !/ssh-keyscan|base64 -d|mkdir -p/.test(l))
        .map((l) => l.replace(/then .* clone (?:--quiet )?('[^']*') ('[^']*'); fi$/, 'then git init -q $2 && git -C $2 remote add origin $1; fi'))
        .map((l) => l.split('/home/node/.openclaw').join(base));
      const env = { PATH: process.env.PATH!, HOME: base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      return execFileSync('bash', ['-c', lines.join('\n')], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    };
    const keptClone = (origin: string) => {
      const base = mkdtempSync(join(tmpdir(), 'hb-git-'));
      const clone = join(base, 'defs');
      const env = { PATH: process.env.PATH!, HOME: base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '-q', clone], { env });
      execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', origin], { env });
      return { base, clone, git: (...a: string[]) => execFileSync('git', ['-C', clone, ...a], { env, encoding: 'utf8' }).trim() };
    };
    const commit = { name: 'Stock Watcher', email: 'stock-watcher@example.org' };

    it('a public clone becomes the writable deploy-key source: ssh origin, push no longer disabled', () => {
      const k = keptClone('https://github.com/example-owner/defs.git');
      k.git('config', 'remote.origin.pushurl', 'PUSH-DISABLED-read-only-public-clone');
      run(buildGitSyncScript({ mountName: 'defs', sshUrl: 'git@github.com:example-owner/defs.git', host: 'github.com' }, 'QkFTRTY0', commit), k.base);
      expect(k.git('config', '--get', 'remote.origin.url')).toBe('git@github.com:example-owner/defs.git');
      expect(() => k.git('config', '--get', 'remote.origin.pushurl')).toThrow();
      expect(readdirSync(k.base)).toEqual(['defs']); // same repo: kept in place
      rmSync(k.base, { recursive: true, force: true });
    });

    it('a clone of another repo is moved aside (kept), so the new source clones fresh', () => {
      const k = keptClone('git@github.com:example-owner/old-notes.git');
      writeFileSync(join(k.clone, 'draft.md'), 'unsaved work');
      run(buildPublicGitSyncScript({ mountName: 'defs', httpsUrl: 'https://github.com/example-owner/defs.git' }, commit), k.base);
      const aside = readdirSync(k.base).filter((n) => n.startsWith('defs.replaced-'));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(k.base, aside[0]!, 'draft.md'), 'utf8')).toBe('unsaved work');
      expect(k.git('config', '--get', 'remote.origin.url')).toBe('https://github.com/example-owner/defs.git');
      rmSync(k.base, { recursive: true, force: true });
    });
  });

  it('explains a private repo reached as public in terms of the fix', () => {
    expect(gitSyncReason("fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'public')).toMatch(/isn't public.*deploy key/);
    expect(gitSyncReason('remote: Repository not found.\nfatal: repository not found', 'public')).toMatch(/wasn't found.*deploy key/);
    // the deploy-key wording is unchanged
    expect(gitSyncReason('git@github.com: Permission denied (publickey).')).toMatch(/deploy key/);
  });
});

describe('the git host key is trusted on first use only (#202)', () => {
  // The script's host-key line, run in a sandbox: a temp folder for the
  // container's, and an ssh-keyscan shim on PATH that answers with whatever
  // key "the network" serves today. ssh-keygen is the real one.
  const newKey = (dir: string, name: string) => {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', join(dir, name)]);
    return readFileSync(join(dir, `${name}.pub`), 'utf8').split(' ').slice(0, 2).join(' ');
  };
  const keyPair = () => {
    const keys = mkdtempSync(join(tmpdir(), 'hb-keys-'));
    try { return [newKey(keys, 'one'), newKey(keys, 'two')] as const; } finally { rmSync(keys, { recursive: true, force: true }); }
  };
  const sync = (served: string, knownHosts?: string) => {
    const base = mkdtempSync(join(tmpdir(), 'hb-hostkey-'));
    try {
      const bin = join(base, 'bin');
      mkdirSync(bin); mkdirSync(join(base, '.ssh'));
      writeFileSync(join(bin, 'ssh-keyscan'), `#!/bin/sh\necho "git.example.org ${served}"\n`, { mode: 0o755 });
      if (knownHosts !== undefined) writeFileSync(join(base, '.ssh', 'known_hosts'), knownHosts);
      const line = buildGitSyncScript({ mountName: 'defs', sshUrl: 'git@git.example.org:example-owner/defs.git', host: 'git.example.org' }, 'QkFTRTY0', { name: 'Stock Watcher', email: 'stock-watcher@example.org' })
        .split('\n').find((l) => l.includes('ssh-keyscan'))!.split('/home/node/.openclaw').join(base);
      execFileSync('bash', ['-c', `set -e\n${line}`], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: base }, stdio: ['ignore', 'pipe', 'pipe'] });
      return readFileSync(join(base, '.ssh', 'known_hosts'), 'utf8');
    } finally { rmSync(base, { recursive: true, force: true }); }
  };

  it('a different key served for a host it already trusts is not added; the trusted one stays', () => {
    const [trusted, swapped] = keyPair();
    const before = `git.example.org ${trusted}\n`;
    const after = sync(swapped, before);
    expect(after).toBe(before);
    expect(after).not.toContain(swapped.split(' ')[1]);
  });

  it('a host it has never seen is trusted on first contact', () => {
    const [first] = keyPair();
    expect(sync(first)).toBe(`git.example.org ${first}\n`);
    expect(sync(first, '')).toBe(`git.example.org ${first}\n`);
  });

  it('a refused key says how to proceed', () => {
    expect(gitSyncReason('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.')).toMatch(/not the key this agent trusted/);
  });
});

describe('HB-0237: the sync scripts refuse a mount name with shell syntax', () => {
  it('throws rather than paste it into a shell line', () => {
    const commit = { name: 'Stock Watcher', email: 'stock-watcher@example.org' };
    expect(() => buildGitSyncScript({ mountName: 'x$(id)', sshUrl: 'git@git.example.org:example-owner/x.git', host: 'git.example.org' }, 'QkFTRTY0', commit)).toThrow(/not allowed/);
    expect(() => buildPublicGitSyncScript({ mountName: '../x', httpsUrl: 'https://git.example.org/example-owner/x.git' }, commit)).toThrow(/not allowed/);
    expect(buildGitSyncScript({ mountName: 'defs.v2', sshUrl: 'git@git.example.org:example-owner/defs.v2.git', host: 'git.example.org' }, 'QkFTRTY0', commit)).toContain('defs.v2');
  });
});
