import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { probeGitSource, type GitProbeRunner } from '../src/orchestrator/apps/gitSource.js';

/**
 * The Test button on a data source (Settings → Data, 2026-10-23): a folder is
 * checked on this machine; a repo is `git ls-remote`d with its own deploy key.
 * The git command is substituted here, so no test reaches a git host.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dsc-')); tmps.push(d); return d; };
afterEach(() => { while (tmps.length) { const d = tmps.pop()!; try { chmodSync(d, 0o755); } catch {} rmSync(d, { recursive: true, force: true }); } });

async function world() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, secrets, f };
}

describe('POST /v1/agents/:id/data-sources/:dsId/check — folders', () => {
  it('a readable folder passes and says where the agent sees it', async () => {
    const { store, f } = await world();
    const dir = tmp();
    store.insertDataSource({ id: 'd1', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'notes', hostPath: dir, createdAt: 'now' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources/d1/check', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.json().message).toContain('/data/notes');
  });

  it('a folder that is gone fails with its path', async () => {
    const { store, f } = await world();
    store.insertDataSource({ id: 'd1', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'gone', hostPath: '/no/such/folder/here', createdAt: 'now' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources/d1/check', headers: as });
    expect(res.json()).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('a writable source on a folder the service cannot write fails as not-writable', async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const { store, f } = await world();
    const dir = tmp();
    chmodSync(dir, 0o555);
    store.insertDataSource({ id: 'd1', agentId: 'a1', kind: 'folder', access: 'rw', mountName: 'ro', hostPath: dir, createdAt: 'now' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources/d1/check', headers: as });
    expect(res.json()).toMatchObject({ ok: false, reason: 'not-writable' });
  });

  it('someone else\'s agent is not found; a missing source is 404', async () => {
    const { store, f } = await world();
    store.insertDataSource({ id: 'd1', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'n', hostPath: tmp(), createdAt: 'now' });
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources/d1/check', headers: { 'x-hatchabot-owner': 'someone-else' } })).statusCode).toBe(404);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources/nope/check', headers: as })).statusCode).toBe(404);
  });
});

describe('probeGitSource', () => {
  const calls: Array<{ cmd: string; args: string[]; env: Record<string, string> }> = [];
  const runner = (answer: { code: number | null; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException }): GitProbeRunner =>
    async (cmd, args, opts) => { calls.push({ cmd, args, env: opts.env }); opts.onStdout(answer.stdout ?? ''); return { code: answer.code, stderr: answer.stderr ?? '', error: answer.error }; };
  // Not shaped like a real key on purpose: the machine's PII scan refuses anything that looks like one.
  const KEY = 'made-up-key-text-for-the-test\nsecond line of made-up key text\n';

  it('a private repo is listed with its deploy key, over ssh with no prompts, and counts the refs', async () => {
    calls.length = 0;
    const r = await probeGitSource({ repoUrl: 'git@github.com:example-owner/thing.git', privateKey: KEY, access: 'rw' },
      { run: runner({ code: 0, stdout: `${'a'.repeat(40)}\trefs/heads/main\n${'b'.repeat(40)}\trefs/tags/v1\n` }) });
    expect(r).toMatchObject({ ok: true, refs: 2 });
    expect(r.message).toMatch(/Read access works/);
    expect(r.message).toMatch(/Write access cannot be tested/);
    const c = calls[0]!;
    expect(c.cmd).toBe('git');
    expect(c.args.slice(-3)).toEqual(['--tags', '--', 'git@github.com:example-owner/thing.git']);
    expect(c.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(c.env.GIT_SSH_COMMAND).toMatch(/BatchMode=yes/);
    expect(c.env.GIT_SSH_COMMAND).toMatch(/IdentitiesOnly=yes/);
    expect(c.env.GIT_SSH_COMMAND).toMatch(/UserKnownHostsFile='[^']*hb-git-probe-/);
  });

  it('the key is written to a private temp dir and removed afterwards', async () => {
    let keyFile = '';
    const r = await probeGitSource({ repoUrl: 'git@github.com:example-owner/thing.git', privateKey: KEY }, {
      run: async (_cmd, _args, opts) => {
        keyFile = /-i '([^']+)'/.exec(opts.env.GIT_SSH_COMMAND ?? '')?.[1] ?? '';
        const { readFileSync, statSync } = await import('node:fs');
        expect(readFileSync(keyFile, 'utf8')).toBe(KEY);
        expect(statSync(keyFile).mode & 0o777).toBe(0o600);
        return { code: 0, stderr: '' };
      },
    });
    expect(r.ok).toBe(true);
    const { existsSync } = await import('node:fs');
    expect(keyFile).not.toBe('');
    expect(existsSync(keyFile)).toBe(false);
  });

  it('a public repo is listed over https with no key', async () => {
    calls.length = 0;
    const r = await probeGitSource({ repoUrl: 'https://github.com/example-owner/pub.git' }, { run: runner({ code: 0, stdout: `${'c'.repeat(40)}\trefs/heads/main\n` }) });
    expect(r).toMatchObject({ ok: true, refs: 1 });
    expect(calls[0]!.env.GIT_SSH_COMMAND).toBeUndefined();
    expect(calls[0]!.env.GIT_ALLOW_PROTOCOL).toBe('https');
  });

  it('reads the host\'s refusals into one sentence each', async () => {
    const cases: Array<[string, string]> = [
      ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'key-not-added'],
      ['ERROR: Repository not found.\nfatal: Could not read from remote repository.', 'not-found'],
      ['Host key verification failed.\nfatal: Could not read from remote repository.', 'host-key'],
      ['ssh: Could not resolve hostname github.example: Name or service not known', 'unreachable'],
      ['fatal: something else entirely', 'error'],
    ];
    for (const [stderr, reason] of cases) {
      const r = await probeGitSource({ repoUrl: 'git@github.com:example-owner/thing.git', privateKey: KEY }, { run: runner({ code: 128, stderr }) });
      expect(r.ok, stderr).toBe(false);
      expect(r.reason, stderr).toBe(reason);
      expect(r.message, stderr).not.toContain('fatal');
    }
  });

  /**
   * The real runner, with `git` a shim in a PATH of its own and a temp HOME:
   * nothing reaches a git host. Each test's processes are killed by their
   * PID afterwards, whatever the test found.
   */
  const strays: number[] = [];
  afterEach(() => { for (const pid of strays.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } });
  const gone = async (pid: number) => {
    for (let i = 0; i < 200; i++) {
      try { process.kill(pid, 0); } catch { return true; }
      // A process killed but not yet reaped by its new parent is gone too.
      try { if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return true; } catch { return true; }
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  };
  async function withShimGit<T>(script: string, fn: (home: string) => Promise<T>): Promise<T> {
    const home = tmp();
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    const was = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = bin;
    process.env.HOME = home;
    try { return await fn(home); } finally { process.env.PATH = was.PATH; process.env.HOME = was.HOME; }
  }

  it('a timeout ends git and the ssh it started, answers at once, and removes the key (HB-0930)', async () => {
    await withShimGit(
      // An ssh that hangs after it connected, keeping git's output open.
      '/bin/sleep 30 &\necho $! > "$HOME/ssh.pid"\nprintf "%s" "$GIT_SSH_COMMAND" > "$HOME/ssh-command"\nwait',
      async (home) => {
        const started = Date.now();
        const probe = probeGitSource({ repoUrl: 'git@github.com:example-owner/thing.git', privateKey: KEY }, { timeoutMs: 1000 });
        const answer = await Promise.race([probe, new Promise((r) => setTimeout(() => r('still waiting'), 8000))]);
        const ssh = Number(readFileSync(join(home, 'ssh.pid'), 'utf8'));
        strays.push(ssh);
        expect(answer).toMatchObject({ ok: false, reason: 'timeout' });
        expect(Date.now() - started).toBeLessThan(8000);
        expect(await gone(ssh)).toBe(true);
        const keyFile = /-i '([^']+)'/.exec(readFileSync(join(home, 'ssh-command'), 'utf8'))?.[1] ?? '';
        expect(keyFile).toMatch(/hb-git-probe-/);
        expect(existsSync(keyFile)).toBe(false);
      },
    );
  }, 20_000);

  it('a host that lists without end is counted as it comes, and the test stops reading at its limit (HB-0971)', async () => {
    const line = `${'0'.repeat(40)}\trefs/heads/made-up-branch-name`;
    const LIMIT = 64 * 1024 * 1024;
    const big = LIMIT + 6 * 1024 * 1024;
    // More than the limit on stdout, then a clean exit: listed, but not all of it read.
    const listed = await withShimGit(`/usr/bin/yes '${line}' | /usr/bin/head -c ${big}`,
      () => probeGitSource({ repoUrl: 'https://github.com/example-owner/pub.git' }, { timeoutMs: 60_000 }));
    expect(listed).toMatchObject({ ok: true });
    expect(listed.message).toMatch(/^Reachable: more than \d+ branches and tags listed \(the test stopped reading after 64 MB\)/);
    expect(listed.refs).toBeGreaterThan((LIMIT - 1024 * 1024) / (line.length + 1));
    expect(listed.refs).toBeLessThanOrEqual(Math.ceil(LIMIT / (line.length + 1)));
    // As much on stderr, with no listing: said, not kept.
    const noisy = await withShimGit(`/usr/bin/yes 'debug1: made-up ssh chatter' | /usr/bin/head -c ${big} >&2; exit 128`,
      () => probeGitSource({ repoUrl: 'https://github.com/example-owner/pub.git' }, { timeoutMs: 60_000 }));
    expect(noisy).toMatchObject({ ok: false, reason: 'error', message: expect.stringMatching(/stopped reading it/) });
    // A listing under the limit is counted whole, a ref split across reads once.
    const whole = await withShimGit(`/usr/bin/yes '${line}' | /usr/bin/head -n 300000`,
      () => probeGitSource({ repoUrl: 'https://github.com/example-owner/pub.git' }, { timeoutMs: 60_000 }));
    expect(whole).toMatchObject({ ok: true, refs: 300000 });
  }, 60_000);

  it('no git on this machine, and a host that never answers, are said plainly', async () => {
    const enoent = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
    expect((await probeGitSource({ repoUrl: 'https://github.com/example-owner/pub.git' }, { run: runner({ code: null, error: enoent }) })).reason).toBe('no-git');
    expect((await probeGitSource({ repoUrl: 'https://github.com/example-owner/pub.git' }, { run: runner({ code: null }), timeoutMs: 5000 })).reason).toBe('timeout');
    expect((await probeGitSource({ repoUrl: 'git@github.com:example-owner/thing.git' }, { run: runner({ code: 0 }) })).reason).toBe('error');
  });
});

describe('POST /v1/agents/:id/data-sources/:dsId/check — repos', () => {
  it('a repo whose key is missing from the store is said, not thrown', async () => {
    const { store, f } = await world();
    store.insertDataSource({ id: 'g1', agentId: 'a1', kind: 'git', access: 'ro', mountName: 'thing', repoUrl: 'git@github.com:example-owner/thing.git', secretRef: 'data-source/g1', pubKey: 'ssh-ed25519 AAAA test', createdAt: 'now' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources/g1/check', headers: as });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, reason: 'error' });
  });
});
