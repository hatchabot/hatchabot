// Building a derived runtime image: `FROM hatchabot-runtime:<base>` plus the
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

/** Images are named hatchabot-runtime:derived-<name>, so they sort beside the base. */
export const DERIVED_TAG_PREFIX = 'derived-';
export function deriveTag(name: string, repo = 'hatchabot-runtime'): string {
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
 * The base must be a hatchabot-runtime tag — a derived image is a thin layer on
 * the fleet base, not an arbitrary FROM. This both scopes the feature and stops
 * a snippet from smuggling extra build args via the base field. `derived-*` is
 * refused so images can't chain into an unrebuildable tower.
 */
export function baseProblem(base: string, repo = 'hatchabot-runtime'): string | null {
  if (!base) return 'A base image is required.';
  // `agentclaw-runtime:*` is the pre-rename repo; the migration retags it, but stored bases keep the old name.
  const repoUsed = [repo, 'agentclaw-runtime'].find((r) => base.startsWith(`${r}:`));
  if (!repoUsed) return `Base must be a ${repo}:* tag.`;
  const tag = base.slice(repoUsed.length + 1);
  if (tag.startsWith(DERIVED_TAG_PREFIX)) return 'A derived image cannot be based on another derived image.';
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag)) return 'Invalid base tag.';
  return null;
}

/**
 * Wrap the owner's lines so they run as root (the base ends as USER node, and
 * the whole point of a derived image is root-level packages like apt), then
 * restore USER node — the runtime contract the rest of Hatchabot depends on
 * (the volume is uid 1000; Claude Code refuses to run as root). Forcing the
 * trailing USER node is a guardrail, not just convenience: an image that ended
 * as root would break every agent that ran on it.
 */
/**
 * The snippet is meant to be a thin layer on the base. Reject directives that
 * would escape that: a second FROM (last stage wins), bind/secret mounts of
 * other local images, host networking during the build, or a USER of its own.
 */
export function dockerfileProblem(snippet: string): string | null {
  // Judge what docker will PARSE, not the physical lines: BuildKit drops
  // comment lines and joins `\`-continued lines first, so `RUN --network\` +
  // `=host …` is one instruction with `--network=host` (found by the 26th
  // audit; the split hid it from the preview too).
  // A parser directive (`# escape=`, `# syntax=`) changes how everything
  // below is read — the escape character itself — so none is allowed.
  if (/^\s*#\s*(escape|syntax|check)\s*=/im.test(snippet)) return 'Parser directives (# escape=, # syntax=) are not allowed in a derived image.';
  const unjoined = snippet
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  // BuildKit joins a continued line with NOTHING: `RUN --net\` + `work=host`
  // is `--network=host`, and `FR\` + `OM x` is FROM. Joined with a space,
  // those passed (night review, 2026-09-28). Judge both joinings, and blank
  // lines inside a continuation vanish as BuildKit drops them.
  const joinedTight = unjoined.replace(/\\[ \t]*\n(?:[ \t]*\n)*/g, '');
  const joinedSpaced = unjoined.replace(/\\[ \t]*\n(?:[ \t]*\n)*/g, ' ');
  const logical = `${joinedTight}\n${joinedSpaced}`;
  for (const raw of logical.split('\n')) {
    const line = raw.trim();
    if (/^FROM\b/i.test(line)) return 'A derived image cannot contain its own FROM — the base field sets it.';
    if (/--mount\b/i.test(line)) return 'RUN --mount is not allowed in a derived image.';
    if (/--network\b/i.test(line)) return 'RUN --network is not allowed in a derived image.';
    if (/^USER\b/i.test(line)) return 'USER is managed for you (root during your lines, node at the end).';
  }
  // The USER node appended after the snippet must stay an instruction of its
  // own. A last line ending in `\` continues into it (comment and blank lines
  // between are dropped first), so `RUN echo installed \` swallowed it and
  // the image stayed root (B002); an unterminated heredoc (`RUN <<EOF` with
  // no EOF line) would take it in as text the same way.
  if (/\\\s*$/.test(unjoined)) return 'The last line ends with a \\ that continues it into nothing — finish that instruction.';
  const lines = unjoined.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // A line that starts an instruction is read from an unquoted start, so a
    // `<<` inside its quotes is text, as BuildKit reads it: `RUN echo "a
    // <<EOF"` was refused as an open heredoc (review, 2026-10-22). A line
    // continuing another (`\` before it, blank lines between) may start
    // inside a quote, so every `<<` on it still counts.
    let prev = i - 1;
    while (prev >= 0 && !lines[prev]!.trim()) prev--;
    const fresh = prev < 0 || !/\\\s*$/.test(lines[prev]!);
    const quoted = fresh ? quotedSpans(lines[i]!) : [];
    for (const hit of lines[i]!.matchAll(/(?<!<)<<(?!<)(-?)\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/g)) {
      const [, dash, word] = hit;
      if (quoted.some(([a, b]) => hit.index! > a && hit.index! < b)) continue;
      const closed = lines.slice(i + 1).some((l) => (dash ? l.replace(/^\t+/, '') : l) === word);
      if (!closed) return `The heredoc <<${word} is never closed by a line "${word}".`;
    }
  }
  return null;
}

/**
 * The quoted stretches of one line, as [open, close] indexes, read the way
 * the shell (and BuildKit's lexer) does: no escapes inside '…', `\` escapes
 * the next character inside "…" and outside. A quote left open runs to the
 * end of the line.
 */
function quotedSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let open = -1;
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q === "'") {
      if (c === "'") { spans.push([open, i]); q = ''; }
    } else if (c === '\\') {
      i++;
    } else if (q === '"') {
      if (c === '"') { spans.push([open, i]); q = ''; }
    } else if (c === '"' || c === "'") {
      q = c; open = i;
    }
  }
  if (q) spans.push([open, line.length]);
  return spans;
}

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
  // Checked again here, not only when the lines were saved: a record saved
  // before a rule existed (B002's trailing `\`) is rebuilt from the database.
  const problem = dockerfileProblem(opts.dockerfile);
  if (problem) return { ok: false, error: problem };
  const docker = opts.docker ?? 'docker';
  const dataDir = opts.dataDir ?? 'data';
  const tag = opts.tag ?? deriveTag(opts.name);
  const logFile = buildLogPath(opts.name, dataDir);

  const contextDir = await mkdtemp(join(tmpdir(), `hatchabot-derive-${opts.name}-`));
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
