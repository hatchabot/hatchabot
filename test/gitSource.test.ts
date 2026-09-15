import { describe, expect, it } from 'vitest';
import { buildGitSyncScript, normalizeGitUrl, gitSyncReason, buildPublicGitSyncScript, isPublicGitUrl } from '../src/orchestrator/gitSource.js';

describe('normalizeGitUrl', () => {
  it('normalizes ssh, ssh://, and https forms to the ssh clone URL', () => {
    for (const input of [
      'git@github.com:cksci/portoml-ai-defs.git',
      'git@github.com:cksci/portoml-ai-defs',
      'https://github.com/cksci/portoml-ai-defs',
      'https://github.com/cksci/portoml-ai-defs.git',
      'ssh://git@github.com/cksci/portoml-ai-defs.git',
    ]) {
      expect(normalizeGitUrl(input)).toEqual({
        sshUrl: 'git@github.com:cksci/portoml-ai-defs.git',
        httpsUrl: 'https://github.com/cksci/portoml-ai-defs.git',
        host: 'github.com',
        repoName: 'portoml-ai-defs',
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
      'github.com/cksci/repo', // no scheme/user
      'git@github.com:cksci/../secret.git',
      'git@github.com:cksci/re;po.git',
      'https://github.com/onlyowner',
      '',
    ]) {
      expect(normalizeGitUrl(bad), bad).toBeNull();
    }
  });
});

describe('buildGitSyncScript', () => {
  const script = buildGitSyncScript(
    { mountName: 'defs', sshUrl: 'git@github.com:cksci/defs.git', host: 'github.com' },
    'QkFTRTY0',
    { name: 'Stock Advisor', email: 'stock-advisor@hatchabot.local' },
  );

  it('writes the key, pins the host, and clones only when absent', () => {
    expect(script).toContain('/home/node/.openclaw/.ssh/defs_deploy');
    expect(script).toContain('base64 -d'); // key written from base64
    expect(script).toContain('ssh-keyscan');
    expect(script).toContain("if [ ! -d '/home/node/.openclaw/defs'/.git ]"); // idempotent clone
    expect(script).toContain("git clone 'git@github.com:cksci/defs.git'");
    expect(script).toContain('core.sshCommand');
    expect(script).toContain("user.email 'stock-advisor@hatchabot.local'");
  });

  it('shell-quotes the commit name so spaces are safe', () => {
    expect(script).toContain("user.name 'Stock Advisor'");
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
    const s = buildPublicGitSyncScript({ mountName: 'hatchabot', httpsUrl: 'https://github.com/hatchabot/hatchabot.git' }, { name: "O'Brien Bot", email: 'k@hatchabot.local' });
    expect(s).toContain("git -c credential.helper= clone --quiet 'https://github.com/hatchabot/hatchabot.git' '/home/node/.openclaw/hatchabot'");
    expect(s).toContain('GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https');
    expect(s).toContain("if [ ! -d '/home/node/.openclaw/hatchabot'/.git ]"); // idempotent
    expect(s).toContain('remote.origin.pushurl');
    expect(s).toContain("'O'\\''Brien Bot'"); // quoted
    expect(s).not.toMatch(/ssh|base64|_deploy/);
  });
  it('explains a private repo reached as public in terms of the fix', () => {
    expect(gitSyncReason("fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'public')).toMatch(/isn't public.*deploy key/);
    expect(gitSyncReason('remote: Repository not found.\nfatal: repository not found', 'public')).toMatch(/wasn't found.*deploy key/);
    // the deploy-key wording is unchanged
    expect(gitSyncReason('git@github.com: Permission denied (publickey).')).toMatch(/deploy key/);
  });
});
