import { describe, expect, it } from 'vitest';
import { buildGitSyncScript, normalizeGitUrl } from '../src/orchestrator/gitSource.js';

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
    { name: 'Stock Advisor', email: 'stock-advisor@agentclaw.local' },
  );

  it('writes the key, pins the host, and clones only when absent', () => {
    expect(script).toContain('/home/node/.openclaw/.ssh/defs_deploy');
    expect(script).toContain('base64 -d'); // key written from base64
    expect(script).toContain('ssh-keyscan');
    expect(script).toContain("if [ ! -d '/home/node/.openclaw/defs'/.git ]"); // idempotent clone
    expect(script).toContain("git clone 'git@github.com:cksci/defs.git'");
    expect(script).toContain('core.sshCommand');
    expect(script).toContain("user.email 'stock-advisor@agentclaw.local'");
  });

  it('shell-quotes the commit name so spaces are safe', () => {
    expect(script).toContain("user.name 'Stock Advisor'");
  });
});
