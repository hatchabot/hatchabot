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
