import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGitSyncScript, normalizeGitUrl, gitSyncReason, buildPublicGitSyncScript, isPublicGitUrl } from '../src/orchestrator/gitSource.js';

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
