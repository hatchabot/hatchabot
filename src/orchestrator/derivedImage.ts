// Building a derived runtime image: `FROM agentclaw-runtime:<base>` plus the
// owner's own Dockerfile lines, for system packages a volume install can't
// provide (apt, root-level setup). See docs/embedding-and-images.md → derived
// images. This shells out to `docker build` exactly like the provider shells
// out to `docker run` — the whole feature is host-owner gated at the API,
// because running a Dockerfile on this box is a privilege the local-host owner
// already has (they can run docker directly).

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Images are named agentclaw-runtime:derived-<name>, so they sort beside the base. */
export const DERIVED_TAG_PREFIX = 'derived-';
export function deriveTag(name: string, repo = 'agentclaw-runtime'): string {
  return `${repo}:${DERIVED_TAG_PREFIX}${name}`;
}

/** Where a build's streamed output is kept, so the CLI/web can tail it. */
export function buildLogPath(name: string, dataDir = 'data'): string {
  return join(dataDir, 'derived-builds', `${name}.log`);
}

/**
 * A derived-image name is both a docker tag component and a filename, so keep it
 * strict: lowercase kebab, must start with a letter, 2–40 chars. Returns a
 * human message on rejection, or null when valid.
 */
export function derivedNameProblem(name: string): string | null {
  if (!name || typeof name !== 'string') return 'A name is required.';
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(name)) {
    return 'Use 2–40 chars: lowercase letters, digits, and hyphens, starting with a letter.';
  }
  if (name.includes('--') || name.endsWith('-')) return 'No trailing or doubled hyphens.';
  return null;
}

/**
 * The base must be an agentclaw-runtime tag — a derived image is a thin layer on
 * the fleet base, not an arbitrary FROM. This both scopes the feature and stops
 * a snippet from smuggling extra build args via the base field. `derived-*` is
 * refused so images can't chain into an unrebuildable tower.
 */
export function baseProblem(base: string, repo = 'agentclaw-runtime'): string | null {
  if (!base) return 'A base image is required.';
  if (!base.startsWith(`${repo}:`)) return `Base must be a ${repo}:* tag.`;
  const tag = base.slice(repo.length + 1);
  if (tag.startsWith(DERIVED_TAG_PREFIX)) return 'A derived image cannot be based on another derived image.';
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) return 'Invalid base tag.';
  return null;
}

/**
 * Wrap the owner's lines so they run as root (the base ends as USER node, and
 * the whole point of a derived image is root-level packages like apt), then
 * restore USER node — the runtime contract the rest of AgentClaw depends on
 * (the volume is uid 1000; Claude Code refuses to run as root). Forcing the
 * trailing USER node is a guardrail, not just convenience: an image that ended
 * as root would break every agent that ran on it.
 */
export function renderDockerfile(base: string, snippet: string): string {
  return `FROM ${base}\nUSER root\n${snippet}\nUSER node\n`;
}

export interface BuildResult {
  ok: boolean;
  /** Trimmed tail of the build output on failure. */
  error?: string;
}

/**
 * Build the derived image, streaming docker's output to `<dataDir>/derived-builds/
 * <name>.log` (truncated first) and to `onLog`. Long by nature (apt) — the
 * default ceiling is 30 min. The Dockerfile is the caller's lines appended
 * verbatim after the FROM; we never parse or rewrite them.
 */
export async function buildDerivedImage(opts: {
  name: string;
  base: string;
  dockerfile: string;
  tag?: string;
  docker?: string;
  dataDir?: string;
  onLog?: (chunk: string) => void;
  timeoutMs?: number;
}): Promise<BuildResult> {
  const docker = opts.docker ?? 'docker';
  const dataDir = opts.dataDir ?? 'data';
  const tag = opts.tag ?? deriveTag(opts.name);
  const logFile = buildLogPath(opts.name, dataDir);

  const contextDir = await mkdtemp(join(tmpdir(), `agentclaw-derive-${opts.name}-`));
  await mkdir(join(dataDir, 'derived-builds'), { recursive: true });
  await writeFile(join(contextDir, 'Dockerfile'), renderDockerfile(opts.base, opts.dockerfile), 'utf8');
  await writeFile(logFile, `# building ${tag}\n# FROM ${opts.base}\n\n`, 'utf8');

  const sink = async (chunk: string) => {
    opts.onLog?.(chunk);
    try {
      await appendFile(logFile, chunk);
    } catch {
      /* logging is best-effort — never fail a build because the log write did */
    }
  };

  return await new Promise<BuildResult>((resolve) => {
    // NO --pull: the base is a LOCAL image (built by build-runtime-image.sh),
    // not in any registry — --pull would try to fetch it and always fail. Docker
    // resolves the FROM against the local base tag, so a local base rebuild or
    // fleet promote is picked up on the next derived rebuild automatically.
    const proc = spawn(docker, ['build', '-t', tag, contextDir]);
    let tail = '';
    const onData = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      void sink(s);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    const cleanup = () => void rm(contextDir, { recursive: true, force: true });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      void sink('\n[timed out]\n');
      cleanup();
      resolve({ ok: false, error: 'Build timed out.' });
    }, opts.timeoutMs ?? 30 * 60_000);
    timer.unref();

    proc.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: tail.trim().slice(-1200) || `docker build exited ${code}` });
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      void sink(`\n[spawn error] ${err.message}\n`);
      resolve({ ok: false, error: `Could not run docker: ${err.message}` });
    });
  });
}

/** Remove the image from docker. Absence is success (idempotent delete). */
export async function removeDerivedImage(
  tag: string,
  opts: { docker?: string } = {},
): Promise<BuildResult> {
  const docker = opts.docker ?? 'docker';
  return await new Promise<BuildResult>((resolve) => {
    const proc = spawn(docker, ['rmi', tag]);
    let tail = '';
    proc.stderr.on('data', (d) => (tail += d.toString()));
    proc.on('close', (code) => {
      if (code === 0 || /No such image|reference does not exist/i.test(tail)) resolve({ ok: true });
      else resolve({ ok: false, error: tail.trim().slice(-400) || `docker rmi exited ${code}` });
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}
