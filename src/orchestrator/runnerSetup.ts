import { createGzip } from 'node:zlib';
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
  const m = /^ssh:\/\/(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9._-]+)(?::(\d+))?\/?$/.exec(endpoint.trim()); // hostname/IPv4 chars only — no ssh_config globs
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

/** How far a copy has come: bytes of the image read so far, of about `total`. */
export interface ImageCopyProgress { bytes: number; total?: number }

/**
 * Copy the control plane's runtime image to a runner:
 * `docker save … | gzip | docker -H <endpoint> load` (load reads gzip as
 * is). Big (2 GB or more before compression) and slow: over a tailnet that
 * relays instead of connecting directly it took longer than the old fixed
 * 15-minute ceiling (a laptop runner, 2026-10-08), and the copy was killed
 * while still moving. Now a copy is stopped only when nothing has moved for
 * `stallMs` (default 3 minutes), or after `timeoutMs` (default 3 hours) at
 * worst; `onProgress` follows it. Requires the ssh-config block in place.
 */
export async function installRuntimeImage(
  endpoint: string,
  opts: {
    image?: string; docker?: string; timeoutMs?: number; stallMs?: number; total?: number; onProgress?: (p: ImageCopyProgress) => void;
    /** The published multi-arch image of the same OpenClaw, pulled there when the runner's CPU differs. */
    published?: { ref: string; openclawVersion: string };
  } = {},
): Promise<{ ok: boolean; error?: string; pulled?: string }> {
  const docker = opts.docker ?? 'docker';
  const image = opts.image ?? 'hatchabot-runtime:latest';
  // This machine's image runs on this machine's CPU only: copied to a runner
  // of another kind (an arm64 box to an Intel laptop) it loads, and every
  // agent built there dies with "exec format error" (2026-10-09). The two
  // daemons say what they run on; when they differ the runner pulls the
  // published image of the same OpenClaw (multi-arch) instead.
  const [here, there] = await Promise.all([dockerArch(docker, []), dockerArch(docker, ['-H', endpoint])]);
  if (here && there && here !== there) {
    if (!opts.published) {
      return { ok: false, error: `This machine's image is built for ${here}, and that runner is ${there}: a copy would not run there, and there is no published image of this version to pull instead.` };
    }
    const { ref, openclawVersion } = opts.published;
    const pulled = await dockerRun(docker, ['-H', endpoint, 'pull', '--quiet', ref], opts.timeoutMs ?? 3 * 3600_000);
    if (pulled.code !== 0) {
      return { ok: false, error: `That runner is ${there} and this machine ${here}, so it needs the published image ${ref}, and pulling it there failed: ${pulled.stderr.slice(-300) || `exit ${pulled.code}`}` };
    }
    // The tag must hold the OpenClaw asked for (build-runtime-image.sh's rule: a pulled image proves its version by its label).
    const has = (await dockerRun(docker, ['-H', endpoint, 'image', 'inspect', '--format', '{{ index .Config.Labels "org.agentclaw.openclaw-version" }}', ref], 60_000)).stdout.trim();
    if (has !== openclawVersion) return { ok: false, error: `The published image ${ref} carries OpenClaw ${has || 'unknown'}, not ${openclawVersion}; not using it.` };
    const tagged = await dockerRun(docker, ['-H', endpoint, 'tag', ref, image], 60_000);
    if (tagged.code !== 0) return { ok: false, error: `Tagging ${ref} as ${image} on the runner failed: ${tagged.stderr.slice(-300)}` };
    return { ok: true, pulled: ref };
  }
  return new Promise((resolve) => {
    const save = spawn(docker, ['save', image]);
    const load = spawn(docker, ['-H', endpoint, 'load']);
    // Fast compression: the layers are plain tars, so even level 1 roughly
    // halves what crosses the link, at little CPU here.
    const gzip = createGzip({ level: 1 });
    save.stdout.pipe(gzip).pipe(load.stdin);
    // A dead receiver EPIPEs the sender; without handlers that's an uncaught
    // stream error that kills the whole control plane.
    save.stdout.on('error', () => {});
    gzip.on('error', () => {});
    load.stdin.on('error', () => {});
    let stderr = '';
    save.stderr.on('data', (d) => (stderr += d));
    load.stderr.on('data', (d) => (stderr += d));
    let settled = false;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(overall);
      clearTimeout(stall);
      resolve(r);
    };
    const kill = (error: string) => { save.kill('SIGKILL'); load.kill('SIGKILL'); finish({ ok: false, error }); };
    const stallMs = opts.stallMs ?? 3 * 60_000;
    let stall = setTimeout(() => kill('The copy stopped moving (nothing for 3 minutes): is the runner still reachable?'), stallMs);
    const overall = setTimeout(() => kill('Timed out copying the image to the runner.'), opts.timeoutMs ?? 3 * 3600_000);
    stall.unref();
    overall.unref();
    let bytes = 0;
    let told = 0;
    save.stdout.on('data', (c: Buffer) => {
      bytes += c.length;
      clearTimeout(stall);
      stall = setTimeout(() => kill('The copy stopped moving (nothing for 3 minutes): is the runner still reachable?'), stallMs);
      stall.unref();
      if (opts.onProgress && Date.now() - told > 1000) { told = Date.now(); opts.onProgress({ bytes, total: opts.total }); }
    });
    let saveCode: number | null = null;
    save.on('close', (code) => {
      saveCode = code;
      if (code !== 0) load.kill('SIGKILL');
      // Everything is sent: the runner unpacks the last layers now, and on a
      // slow disk that can take minutes with nothing moving here — it was
      // killed as "stalled" just before it finished (2026-10-09). The overall
      // limit still stands.
      else clearTimeout(stall);
    });
    load.on('close', (code) => {
      opts.onProgress?.({ bytes, total: opts.total });
      if (code === 0 && saveCode === 0) return finish({ ok: true });
      finish({ ok: false, error: stderr.slice(-400) || `exit ${saveCode ?? '?'}/${code}` });
    });
    save.on('error', (err) => { load.kill('SIGKILL'); finish({ ok: false, error: String(err.message).slice(0, 200) }); });
    load.on('error', (err) => { save.kill('SIGKILL'); finish({ ok: false, error: String(err.message).slice(0, 200) }); });
  });
}

/** What CPU a Docker daemon runs on (`docker info`'s Architecture: x86_64, aarch64), or undefined when it does not say. */
async function dockerArch(docker: string, conn: string[]): Promise<string | undefined> {
  const r = await dockerRun(docker, [...conn, 'info', '--format', '{{.Architecture}}'], 30_000);
  const a = r.stdout.trim();
  return r.code === 0 && /^[A-Za-z0-9_-]{1,32}$/.test(a) ? a : undefined;
}

/** One docker call with no input, its output, and a time limit. */
function dockerRun(docker: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(docker, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(err.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });
}
