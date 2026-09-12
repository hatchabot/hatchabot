/**
 * The add-a-runner streamlining: dedicated key management, the ssh-config
 * block that makes the HEADLESS service authenticate deterministically, the
 * paste-on-the-runner snippet, and the image copy. Each of these automates a
 * step that silently broke the first live runner when done by hand.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureRunnerKey,
  ensureSshConfigBlock,
  installRuntimeImage,
  parseSshEndpoint,
  runnerSetupSnippet,
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

describe('ensureSshConfigBlock', () => {
  it('writes an IdentitiesOnly block once per host and leaves other config alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acl-sshcfg-'));
    writeFileSync(join(dir, 'config'), '# my own stuff\nHost mine\n    User me\n');
    await ensureSshConfigBlock('ssh://bob@runner.example:2222', { sshDir: dir });
    const cfg = readFileSync(join(dir, 'config'), 'utf8');
    expect(cfg).toContain('# my own stuff'); // untouched
    expect(cfg).toContain('Host runner.example');
    expect(cfg).toContain('User bob');
    expect(cfg).toContain('Port 2222');
    expect(cfg).toContain('IdentitiesOnly yes'); // beats any ssh-agent
    expect(cfg).toContain('StrictHostKeyChecking accept-new'); // no first-connect stall

    // Idempotent: a second add of the same host appends nothing.
    const before = cfg.length;
    await ensureSshConfigBlock('ssh://bob@runner.example:2222', { sshDir: dir });
    expect(readFileSync(join(dir, 'config'), 'utf8').length).toBe(before);
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
    expect(s).toContain("grep -qF 'ssh-ed25519 AAAA test-key'"); // no duplicate lines
    expect(s).toContain('authorized_keys');
    expect(s).toContain('/usr/local/bin'); // the macOS docker-not-found fix
    expect(s).toContain('command -v docker'); // self-check at the end
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
});
