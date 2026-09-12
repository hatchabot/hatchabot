import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileP = promisify(execFile);

/**
 * Everything that makes "add a runner" a paste-an-address experience instead
 * of an SSH treasure hunt. Validated the hard way on the first live runner
 * (a MacBook): the manual path needed a dedicated key, an ssh-config block,
 * known-hosts acceptance, a PATH fix on the runner, and the runtime image —
 * each one a silent failure when missed. This module automates the
 * control-plane half and generates the one-liner for the runner half.
 *
 * Design rules learned live:
 *  - The service must NEVER depend on an ssh-agent. A keyring agent works in
 *    an interactive shell and dies headless (locked, empty after reboot), so
 *    the dedicated key is passphrase-less and pinned with IdentitiesOnly.
 *  - `docker -H ssh://…` shells out to `ssh`, which reads ~/.ssh/config — the
 *    per-host block is how we control identity without docker's cooperation.
 */

export interface RunnerPaths {
  sshDir?: string; // default ~/.ssh — overridable for tests
}

const KEY_NAME = 'agentclaw_runner';
const CONFIG_MARK = '# agentclaw-runner:'; // + host — marks blocks we own

function sshDir(p: RunnerPaths = {}): string {
  // Env override so tests (and unusual deployments) never touch the real
  // ~/.ssh of whoever runs the process.
  return p.sshDir ?? process.env.HATCHABOT_SSH_DIR ?? join(homedir(), '.ssh');
}

/**
 * The control plane's dedicated runner key — created on first use, reused for
 * every runner. Passphrase-less on purpose (see module note). Returns the
 * public key line for the UI to hand to the runner.
 */
export async function ensureRunnerKey(p: RunnerPaths = {}): Promise<string> {
  const dir = sshDir(p);
  const key = join(dir, KEY_NAME);
  if (!existsSync(key)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await execFileP('ssh-keygen', [
      '-t', 'ed25519', '-N', '', '-f', key, '-C', 'agentclaw control-plane -> runner',
    ]);
    await chmod(key, 0o600);
  }
  return (await readFile(`${key}.pub`, 'utf8')).trim();
}

/** `ssh://user@host[:port]` → its parts, or undefined for non-ssh endpoints. */
export function parseSshEndpoint(
  endpoint: string,
): { user?: string; host: string; port?: string } | undefined {
  // Exclude whitespace from user/host so the parser is safe standalone — a
  // caller that skips the route's zod validation still can't smuggle a newline
  // + ssh_config directive into ~/.ssh/config.
  const m = /^ssh:\/\/(?:([^@/\s]+)@)?([^@:/\s]+)(?::(\d+))?\/?$/.exec(endpoint.trim());
  if (!m || !m[2]) return undefined;
  return { user: m[1], host: m[2], port: m[3] };
}

/**
 * Pin the dedicated key for this runner's hostname in ~/.ssh/config, so the
 * headless service authenticates deterministically: IdentitiesOnly beats any
 * ssh-agent (a passphrase-protected default key exhausts the server's auth
 * attempts), and accept-new means the first connect doesn't stall on a
 * host-key prompt. Idempotent: one marked block per hostname, never edited
 * if present — and never touching config the user wrote themselves.
 */
export async function ensureSshConfigBlock(endpoint: string, p: RunnerPaths = {}): Promise<void> {
  const parsed = parseSshEndpoint(endpoint);
  if (!parsed) return; // tcp:// endpoints have no ssh side
  const dir = sshDir(p);
  const cfg = join(dir, 'config');
  const mark = `${CONFIG_MARK} ${parsed.host}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const existing = existsSync(cfg) ? await readFile(cfg, 'utf8') : '';
  // Whole-line match: `.includes(mark)` treats `# agentclaw-runner: vm` as
  // present inside `# agentclaw-runner: vm2`, so registering `vm` after `vm2`
  // would silently skip writing its block (and the runner then authenticates
  // with the wrong key).
  if (existing.split('\n').some((l) => l.trim() === mark)) return;
  const lines = [
    '',
    mark,
    `Host ${parsed.host}`,
    ...(parsed.user ? [`    User ${parsed.user}`] : []),
    ...(parsed.port ? [`    Port ${parsed.port}`] : []),
    `    IdentityFile ${join(dir, KEY_NAME)}`,
    '    IdentitiesOnly yes',
    '    StrictHostKeyChecking accept-new',
    '',
  ];
  await appendFile(cfg, lines.join('\n'), { mode: 0o600 });
  await chmod(cfg, 0o600);
}

/**
 * The whole runner-side setup as one paste-able snippet: authorize the
 * control plane's key, and (harmlessly, everywhere) make sure docker's usual
 * homes are on PATH for non-interactive ssh — the macOS gotcha where
 * `docker -H ssh://` fails with "command not found" against a default PATH
 * of /usr/bin:/bin. Idempotent by construction.
 */
export function runnerSetupSnippet(pubKey: string): string {
  return [
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh`,
    `grep -qF '${pubKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pubKey}' >> ~/.ssh/authorized_keys`,
    `chmod 600 ~/.ssh/authorized_keys`,
    // zsh reads ~/.zshenv for every invocation, including non-interactive ssh
    // (macOS default shell); bash reads ~/.bashrc via sshd's shell (Linux
    // distros commonly source it non-interactively; harmless where not).
    `for f in ~/.zshenv ~/.bashrc; do grep -qs 'agentclaw: docker on PATH' "$f" || printf '\\n# agentclaw: docker on PATH for non-interactive ssh\\nexport PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"\\n' >> "$f"; done`,
    `command -v docker >/dev/null && docker version --format 'docker OK — server {{.Server.Version}}' || echo 'WARNING: docker not found — install Docker first'`,
  ].join('\n');
}

/**
 * Copy the control plane's runtime image to a runner:
 * `docker save … | docker -H <endpoint> load`. Big (a GB or more) and slow
 * (minutes over a tailnet) — callers should treat it as a long job, and the
 * default 15-minute ceiling exists so a dead pipe can't hang the route
 * forever. Requires the ssh-config block to already be in place.
 */
export async function installRuntimeImage(
  endpoint: string,
  opts: { image?: string; docker?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const docker = opts.docker ?? 'docker';
  const image = opts.image ?? 'hatchabot-runtime:latest';
  return new Promise((resolve) => {
    const save = spawn(docker, ['save', image]);
    const load = spawn(docker, ['-H', endpoint, 'load']);
    save.stdout.pipe(load.stdin);
    // A dead receiver EPIPEs the sender; without handlers that's an uncaught
    // stream error that kills the whole control plane.
    save.stdout.on('error', () => {});
    load.stdin.on('error', () => {});
    let stderr = '';
    save.stderr.on('data', (d) => (stderr += d));
    load.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      save.kill('SIGKILL');
      load.kill('SIGKILL');
      resolve({ ok: false, error: 'Timed out copying the image to the runner.' });
    }, opts.timeoutMs ?? 15 * 60_000);
    timer.unref();
    let saveCode: number | null = null;
    save.on('close', (code) => {
      saveCode = code;
      if (code !== 0) load.kill('SIGKILL');
    });
    load.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && saveCode === 0) return resolve({ ok: true });
      resolve({ ok: false, error: stderr.slice(-400) || `exit ${saveCode ?? '?'}/${code}` });
    });
    save.on('error', (err) => {
      clearTimeout(timer);
      load.kill('SIGKILL');
      resolve({ ok: false, error: String(err.message).slice(0, 200) });
    });
    load.on('error', (err) => {
      clearTimeout(timer);
      save.kill('SIGKILL');
      resolve({ ok: false, error: String(err.message).slice(0, 200) });
    });
  });
}
