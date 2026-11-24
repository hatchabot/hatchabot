// Building a derived runtime image: `FROM hatchabot-runtime:<base>` plus the
// owner's own Dockerfile lines, for system packages a volume install can't
// provide (apt, root-level setup). See docs/embedding-and-images.md → derived
// images. This shells out to `docker build` exactly like the provider shells
// out to `docker run` — the whole feature is host-owner gated at the API,
// because running a Dockerfile on this box is a privilege the local-host owner
// already has (they can run docker directly).

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { close as fsClose, constants as fsc, fstat, ftruncate, open as fsOpen, write as fsWrite } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Readable, Writable } from 'node:stream';
import { IMAGE_FACTS_FORMAT, parseImageFacts, type ImageFacts } from '../../providers/provider.js';

// A trailing "-" is apt's REMOVE syntax ("curl-" removes curl), so never
// the last character. A trailing "+" is part of real names (g++, libstdc++):
// apt installs a package by its exact name before reading "+" as its
// install operator (#137). The one rule for an extra package's name,
// exported from imageRecipe.ts too.
export const APT_PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]*[a-z0-9+]$|^[a-z0-9]$/;

/** The line that lays system packages on a base, root's, before anything else. */
export function aptInstallLine(packages: readonly string[]): string {
  return `RUN apt-get update && apt-get install -y --no-install-recommends ${packages.join(' ')} && rm -rf /var/lib/apt/lists/*`;
}

/** Images are named hatchabot-runtime:derived-<name>, so they sort beside the base. */
export const DERIVED_TAG_PREFIX = 'derived-';

/**
 * On a derived image, what it was built from: its base's name, its lines and
 * the packages under them (its base's and its own), hashed (recipeStamp). Its
 * lines are in no other label, so a same-named image on another machine is
 * the record's only when this says so (HB-1325 review: a runner's copy never
 * has this machine's layers, and was built again on every move). A base's
 * name is not what it runs (`:latest` moves): what it was built on is its
 * build-inputs label's to say (ensureImageOn).
 */
export const RECIPE_LABEL = 'org.hatchabot.recipe';
export function recipeStamp(base: string, lines: string, packages: readonly string[] = []): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([base, lines.trim(), [...new Set(packages)].sort()])).digest('hex')}`;
}
export function deriveTag(name: string, repo = 'hatchabot-runtime'): string {
  return `${repo}:${DERIVED_TAG_PREFIX}${name}`;
}

/** Where a build's streamed output is kept, so the CLI/web can tail it. */
export function buildLogPath(name: string, dataDir = 'data'): string {
  return join(dataDir, 'derived-builds', `${name}.log`);
}

/**
 * The last `chars` characters of a build log, read from its end and without
 * holding up the server. Each poll read and decoded the whole log, however
 * long a verbose build had made it, to send its last few thousand characters
 * (HB-0884). Each character a string counts is at most three bytes of UTF-8
 * (a four-byte one counts as two), so the window always holds them; one the
 * window cuts into is left out, never shown as garbage. Throws as `open`
 * does (ENOENT: no log yet).
 */
export async function readLogTail(path: string, chars: number): Promise<string> {
  const h = await open(path, 'r');
  try {
    const { size } = await h.stat();
    const want = Math.min(size, chars * 3 + 3);
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await h.read(buf, got, want - got, size - want + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    let from = 0;
    if (want < size) while (from < Math.min(got, 3) && (buf[from]! & 0xc0) === 0x80) from++;
    return buf.subarray(from, got).toString('utf8').slice(-chars);
  } finally {
    await h.close();
  }
}

/**
 * What a build log keeps (HB-1190): at most `cap` bytes, its first lines
 * (up to `head` bytes: what was built, from what) and its last `keep` bytes
 * or so, with a line between saying how much was left out; and `kept` logs
 * of each image, this build's and the ones before it (`<name>.log.1`, …).
 * The end is what a failed build is judged by (buildFailureReason reads
 * 200,000 characters of it) and what the app shows.
 */
export const BUILD_LOG = { cap: 4 * 2 ** 20, head: 64 * 2 ** 10, keep: 2 ** 20, kept: 3 };

/**
 * A build's log, opened as a write stream: its 'open' comes once the file
 * is open, an error on it is the stream's. The log of the build before is
 * moved aside first (`.1`, that one's to `.2`, …), and only a regular file
 * is moved; one that grows past its cap is cut back to its first and last
 * lines in place, so whoever reads its end goes on reading it. A log that
 * is not a regular file (a pipe, a device) is written as it comes. Build
 * logs grew without end, and every build's output was kept until the next
 * build of that image replaced it.
 */
export function openBuildLog(path: string, limits: typeof BUILD_LOG = BUILD_LOG): Writable {
  return new BuildLog(path, limits);
}

/** The logs of an image's builds, this one's and the ones before it, removed (an image deleted). */
export async function removeBuildLogs(name: string, dataDir = 'data', kept = BUILD_LOG.kept): Promise<void> {
  const path = buildLogPath(name, dataDir);
  for (let n = 0; n < kept; n++) await rm(n ? `${path}.${n}` : path, { force: true });
}

class BuildLog extends Writable {
  readonly #path: string;
  readonly #limits: typeof BUILD_LOG;
  #fd = -1;
  /** Only a regular file is cut back. */
  #cut = false;
  /** Bytes in the file, and of output so far. */
  #size = 0;
  #seen = 0;
  /**
   * The output's first `head` bytes, and its last `keep` or a little more:
   * in `#last` from `#lastAt`, and the latest chunks in `#recent` until
   * there are enough of them to join into one. A Buffer was kept for each
   * chunk, however small: a build printing a few bytes at a time held
   * hundreds of thousands of them (review of HB-1190).
   */
  #first: Buffer[] = [];
  #firstBytes = 0;
  #last: Buffer[] = [];
  #lastAt = 0;
  #recent: Buffer[] = [];
  #recentBytes = 0;
  #lastBytes = 0;
  /** Where the first lines kept end, once the log has been cut. */
  #headEnd?: number;
  /** A write or cut on the file not yet finished, and the close waiting for it. */
  #inFlight = false;
  #afterWrite?: () => void;

  constructor(path: string, limits: typeof BUILD_LOG) {
    super();
    this.#path = path;
    this.#limits = limits;
  }

  override _construct(done: (err?: Error | null) => void): void {
    moveAside(this.#path, this.#limits.kept).then(() => {
      fsOpen(this.#path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_APPEND, 0o666, (err, fd) => {
        if (err) return done(err);
        this.#fd = fd;
        fstat(fd, (e, st) => {
          this.#cut = !e && st.isFile();
          done();
          this.emit('open', fd);
        });
      });
    }, done);
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, done: (err?: Error | null) => void): void {
    const { cap, head, keep } = this.#limits;
    this.#seen += chunk.length;
    if (this.#firstBytes < head) {
      const part = chunk.subarray(0, head - this.#firstBytes);
      this.#first.push(part);
      this.#firstBytes += part.length;
    }
    this.#recent.push(chunk);
    this.#recentBytes += chunk.length;
    this.#lastBytes += chunk.length;
    if (this.#recent.length >= JOIN_CHUNKS || this.#recentBytes >= keep / 16) {
      this.#last.push(this.#recent.length === 1 ? chunk : Buffer.concat(this.#recent));
      this.#recent = [];
      this.#recentBytes = 0;
    }
    while (this.#lastAt < this.#last.length && this.#lastBytes - this.#last[this.#lastAt]!.length >= keep) this.#lastBytes -= this.#last[this.#lastAt++]!.length;
    if (this.#lastAt > 1024 && this.#lastAt * 2 > this.#last.length) { this.#last = this.#last.slice(this.#lastAt); this.#lastAt = 0; }
    this.#inFlight = true;
    const stopped = () => this.destroyed;
    const finish = (err?: Error | null) => { this.#settled(); done(err); };
    if (!this.#cut || this.#size + chunk.length <= cap) {
      return writeAll(this.#fd, chunk, (err) => {
        if (!err) this.#size += chunk.length;
        finish(err);
      }, stopped);
    }
    // Cut back: the first lines, a line saying what is left out, the last lines.
    const first = Buffer.concat(this.#first);
    if (this.#headEnd === undefined) {
      const nl = first.lastIndexOf(10);
      // No line ends in it: cut before the character the head ends in, never through it (review of HB-1190).
      this.#headEnd = nl >= 0 ? nl + 1 : wholeChars(first, first.length);
    }
    const headEnd = this.#headEnd;
    let tail = Buffer.concat([...this.#last.slice(this.#lastAt), ...this.#recent]);
    tail = tail.subarray(Math.max(0, tail.length - keep));
    const nl = tail.indexOf(10);
    if (nl >= 0 && nl < tail.length - 1) tail = tail.subarray(nl + 1);
    else { let from = 0; while (from < Math.min(tail.length, 3) && (tail[from]! & 0xc0) === 0x80) from++; tail = tail.subarray(from); }
    const note = Buffer.from(`\n[... ${this.#seen - headEnd - tail.length} bytes of output left out here: a build log keeps its first and last lines ...]\n\n`);
    const from = Math.min(this.#size, headEnd);
    ftruncate(this.#fd, from, (err) => {
      if (err || stopped()) return finish(err);
      const out = Buffer.concat([first.subarray(from, headEnd), note, tail]);
      writeAll(this.#fd, out, (e) => {
        if (!e) this.#size = from + out.length;
        finish(e);
      }, stopped);
    });
  }

  /** A write is done: a close that waited for it goes ahead. */
  #settled(): void {
    this.#inFlight = false;
    const then = this.#afterWrite;
    this.#afterWrite = undefined;
    then?.();
  }

  /** How many pieces of output it holds for the log's end (for tests). */
  get heldPieces(): number {
    return this.#last.length - this.#lastAt + this.#recent.length;
  }

  override _destroy(err: Error | null, done: (err?: Error | null) => void): void {
    const close = () => {
      if (this.#fd < 0) return done(err);
      const fd = this.#fd;
      this.#fd = -1;
      fsClose(fd, (e) => done(err ?? e));
    };
    // Not under a write still in flight: its number, freed, could be another
    // file's by the time a write after a partial one lands (review of HB-1026).
    // A write that never ends (a pipe nobody reads) keeps the file open until
    // it does; the build does not wait for it.
    if (this.#inFlight) this.#afterWrite = close;
    else close();
  }
}

/** How many chunks of output a build log keeps apart before it joins them into one. */
const JOIN_CHUNKS = 1000;

/** `end`, or where the UTF-8 character that `end` cuts into starts. */
function wholeChars(buf: Buffer, end: number): number {
  let i = end;
  while (i > 0 && end - i < 3 && (buf[i - 1]! & 0xc0) === 0x80) i--;
  if (i === 0) return end;
  const lead = buf[i - 1]!;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return end - (i - 1) < need ? i - 1 : end;
}

/** Move a build's earlier logs aside: `.1` to `.2`, the log to `.1`, … Only regular files; a failure leaves the log to be replaced. */
async function moveAside(path: string, kept: number): Promise<void> {
  for (let n = kept - 1; n >= 1; n--) {
    const from = n === 1 ? path : `${path}.${n - 1}`;
    try {
      if ((await lstat(from)).isFile()) await rename(from, `${path}.${n}`);
    } catch { /* none there, or it can't be moved: the log is written over */ }
  }
}

/** Write all of `buf` at the file's end, however many writes it takes, until `stopped` (the log let go). */
function writeAll(fd: number, buf: Buffer, done: (err?: Error | null) => void, stopped: () => boolean = () => false): void {
  fsWrite(fd, buf, 0, buf.length, null, (err, n) => {
    if (err) return done(err);
    if (n < buf.length) return stopped() ? done() : writeAll(fd, buf.subarray(n), done, stopped);
    done();
  });
}


/**
 * The base must be a hatchabot-runtime tag — a derived image is a thin layer on
 * the fleet base, not an arbitrary FROM. This both scopes the feature and stops
 * a snippet from smuggling extra build args via the base field. `derived-*` is
 * refused so images can't chain into an unrebuildable tower.
 *
 * `repo` is the fleet's (HATCHABOT_IMAGE's): a fleet on another repository
 * had every derived image refused (HB-0882). The default repository's name
 * stays accepted, so a base saved before the repository changed still rebuilds.
 */
export function baseProblem(base: string, repo = 'hatchabot-runtime'): string | null {
  if (!base) return 'A base image is required.';
  // `agentclaw-runtime:*` is the pre-rename repo; the migration retags it, but stored bases keep the old name.
  const repoUsed = [repo, 'hatchabot-runtime', 'agentclaw-runtime'].find((r) => base.startsWith(`${r}:`));
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
 * A RUN's own flags (or an ONBUILD RUN's), as BuildKit reads them
 * (extractBuilderFlags): the words after RUN that begin with `--`, up to the
 * first that does not, or a bare `--`, each with its quotes and escapes taken
 * out. What follows them is the command, and its words are not RUN's.
 */
export function runFlags(line: string): string[] {
  const m = /^(?:ONBUILD[ \t\v\f\r]+)?RUN(?:[ \t\v\f\r]+|$)/i.exec(line);
  if (!m) return [];
  const rest = line.slice(m[0].length);
  // Go's unicode.IsSpace, which ends a flag's word: JavaScript's \s, and NEL.
  const space = (ch: string) => /[\s\u0085]/.test(ch);
  const words: string[] = [];
  let i = 0;
  for (;;) {
    while (i < rest.length && space(rest[i]!)) i++;
    if (!rest.startsWith('--', i)) return words;
    let word = '';
    let quote = '';
    for (; i < rest.length; i++) {
      const ch = rest[i]!;
      if (!quote && space(ch)) break;
      if (quote ? ch === quote : ch === '"' || ch === "'") { quote = quote ? '' : ch; continue; }
      if (ch === '\\') { if (i + 1 < rest.length) word += rest[++i]; continue; }
      word += ch;
    }
    if (word === '--') return words;
    words.push(word);
  }
}

/**
 * The snippet is meant to be a thin layer on the base. Reject directives that
 * would escape that: a second FROM (last stage wins), bind/secret mounts of
 * other local images, host networking during the build, a step run without
 * the build's sandbox or with a device of the machine, or a USER of its own.
 */
export function dockerfileProblem(snippet: string): string | null {
  // Judge what docker will PARSE, not the physical lines: BuildKit drops
  // comment lines and joins `\`-continued lines first, so `RUN --network\` +
  // `=host …` is one instruction with `--network=host` (found by the 26th
  // audit; the split hid it from the preview too).
  // Plain text only (HB-1291 review): docker and these checks do not agree on
  // what else is a space (Go's unicode.IsSpace is not JavaScript's \s), so a
  // NEL before FROM was a space to docker and a letter here, and a no-break
  // space after RUN the other way round. A comment line, which both drop
  // whole, may hold any but control characters (C0 and C1), Unicode's line
  // and paragraph separators, and the marks that reorder what is shown
  // (U+202A–U+202E, U+2066–U+2069: a preview that reads other than what is
  // built), so a record whose comments say `—` or `é` still builds. Only CRLF is a line break here: BuildKit
  // splits at LF alone (bufio.ScanLines drops a CR just before it), and a
  // lone CR is a space to it, so `RUN\r--device=x` was RUN's flag and
  // `# note\rRUN echo \` a comment that does not continue (round-2 review).
  // A lone CR that is left is refused here, as any control character is.
  const physical = snippet.replace(/\r\n/g, '\n').split('\n');
  const odd = physical.findIndex((l) => (/^[ \t]*#/.test(l) ? /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/ : /[^\t\x20-\x7e]/).test(l));
  if (odd >= 0) return `Line ${odd + 1} has a character that is not plain text. Derived image lines may hold only ordinary letters, digits, punctuation, spaces and tabs, except in a # comment line.`;
  // A parser directive (`# escape=`, `# syntax=`) changes how everything
  // below is read — the escape character itself — so none is allowed.
  if (/^\s*#\s*(escape|syntax|check)\s*=/im.test(snippet)) return 'Parser directives (# escape=, # syntax=) are not allowed in a derived image.';
  const unjoined = snippet
    .replace(/\r\n/g, '\n')
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
    // The flag's whole name: `\b` also stopped at a `-`, so a command's own
    // `--network-timeout` or `--mount-point` was refused as RUN's flag.
    if (/--mount(?![\w-])/i.test(line)) return 'RUN --mount is not allowed in a derived image.';
    if (/--network(?![\w-])/i.test(line)) return 'RUN --network is not allowed in a derived image.';
    // And as RUN's own flags, their quotes and escapes out: `--net"work"=host` is that flag (HB-1291 review).
    const flags = runFlags(line);
    if (flags.some((f) => /^--mount(=|$)/i.test(f))) return 'RUN --mount is not allowed in a derived image.';
    if (flags.some((f) => /^--network(=|$)/i.test(f))) return 'RUN --network is not allowed in a derived image.';
    // --security=insecure runs the line without the build's sandbox (as
    // `docker run --privileged` does), and --device gives it a device of this
    // machine; both are stable Dockerfile syntax (1.20, 1.27). BuildKit runs
    // them only with an entitlement the daemon allows and the build asks for
    // (--allow), and no build here asks; but Docker's daemon allows `device`
    // unless told not to, and a device whose CDI spec lets it in needs no
    // asking (HB-1291). Only RUN's own flags, read as BuildKit reads them
    // (runFlags): `--sec"urity"=insecure` is that flag, and the command's
    // `--device cpu` or `--security` is not (HB-1291 review).
    if (flags.some((f) => /^--security(=|$)/i.test(f))) return 'RUN --security is not allowed in a derived image.';
    if (flags.some((f) => /^--device(=|$)/i.test(f))) return 'RUN --device is not allowed in a derived image.';
    if (/^USER\b/i.test(line)) return 'USER is managed for you (root during your lines, node at the end).';
    // Hatchabot's own labels say what the image was built from, and a base's
    // are read to match it on another machine (HB-0986): lines that plainly
    // set them are told so here. Quotes and escapes come out of a key first
    // (`o"rg".hatchabot…`). One named from a variable, or hidden, is found in
    // the image built (labelProblem), so a variable in the owner's own label
    // (`LABEL v=${VER}`) is theirs (HB-0986 review). So are the ones its
    // agents' containers carry (hatchabot.console-port, .agent, .role), as a
    // key (`hatchabot.x=` or `LABEL hatchabot.x y`): a container takes its
    // image's labels, and the status reads them (HB-0986 review).
    const keys = line.replace(/["'\\]/g, '');
    if (/^(ONBUILD\s+)?LABEL\b/i.test(line) && (/org\.(hatchabot|agentclaw)\./i.test(keys) || /(^|\s)hatchabot\.[^\s=]*=/i.test(keys) || /^(ONBUILD\s+)?LABEL\s+hatchabot\./i.test(keys))) {
      return "A derived image cannot set Hatchabot's own labels (org.hatchabot.…, hatchabot.…): they say what its base was built from, and what its agents' containers are.";
    }
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

/** The base's packages (an imported image's, HB-0986) go on first, as root, then the owner's lines. */
export function renderDockerfile(base: string, snippet: string, basePackages: readonly string[] = []): string {
  return `FROM ${base}\nUSER root\n${basePackages.length ? `${aptInstallLine(basePackages)}\n` : ''}${snippet}\nUSER node\n`;
}

export interface BuildResult {
  ok: boolean;
  /** Why it failed: docker's own last output when `fromDocker`, else Hatchabot's words (a refusal, a time limit). */
  error?: string;
  /** The error is the tail of what docker printed. */
  fromDocker?: true;
}

/**
 * Build the derived image, streaming docker's output to `<dataDir>/derived-builds/
 * <name>.log` (truncated first) and to `onLog`. Long by nature (apt) — the
 * default ceiling is 30 min. The Dockerfile is the caller's lines appended
 * verbatim after the FROM; we never parse or rewrite them.
 *
 * The log is one stream, written in order, and docker's output waits while it
 * is behind; the build has ended only once the log is closed. Each chunk was
 * its own append, started and never waited for: the build was reported done
 * with its output still being written, and a timed-out build's late output
 * landed in the next build's log (HB-1026).
 *
 * It builds to a name of its own (checkTag), and takes the record's tag only
 * once the image is seen to run as node: a line that hides the USER node
 * added after the owner's lines (a heredoc that runs to their end) made an
 * image that runs as root, whatever reading the lines had found (HB-1032).
 */
export async function buildDerivedImage(opts: {
  name: string;
  base: string;
  dockerfile: string;
  /** Laid on the base before the lines (the record's base packages). */
  basePackages?: readonly string[];
  tag?: string;
  docker?: string;
  dataDir?: string;
  onLog?: (chunk: string) => void;
  timeoutMs?: number;
  /** How long a build that has ended waits for its log to be written; then the log is let go. */
  logGraceMs?: number;
  /** Aborted: the build stops as a timed-out one does, with all it started (the service stopping). */
  signal?: AbortSignal;
  /** How long a time limit or a stop that comes while a checked image is being named waits for that to end. */
  nameGraceMs?: number;
}): Promise<BuildResult> {
  const STOPPED = 'The build was stopped: the service stopped.';
  if (opts.signal?.aborted) return { ok: false, error: STOPPED };
  // Checked again here, not only when the lines were saved: a record saved
  // before a rule existed (B002's trailing `\`) is rebuilt from the database.
  const problem = dockerfileProblem(opts.dockerfile);
  if (problem) return { ok: false, error: problem };
  const basePackages = opts.basePackages ?? [];
  if (basePackages.length > 32 || basePackages.some((p) => p.length > 64 || !APT_PACKAGE_NAME.test(p))) return { ok: false, error: 'Its base packages are not all package names.' };
  const docker = opts.docker ?? 'docker';
  const dataDir = opts.dataDir ?? 'data';
  const tag = opts.tag ?? deriveTag(opts.name);
  const building = checkTag(tag);
  const logFile = buildLogPath(opts.name, dataDir);

  const contextDir = await mkdtemp(join(tmpdir(), `hatchabot-derive-${opts.name}-`));
  const cleanup = () => void rm(contextDir, { recursive: true, force: true }).catch(() => {}); // force does not cover EACCES or EBUSY (HB-0374)
  // Whatever fails before the build starts takes the build context and the
  // log with it: they were left behind (review of HB-1026).
  let log: Writable | undefined;
  try {
    await mkdir(join(dataDir, 'derived-builds'), { recursive: true });
    await writeFile(join(contextDir, 'Dockerfile'), renderDockerfile(opts.base, opts.dockerfile, basePackages), 'utf8');
    const opening = openBuildLog(logFile);
    log = opening;
    // A log that cannot be opened fails the build, as it did.
    await new Promise<void>((ok, fail) => {
      opening.once('open', () => { opening.off('error', fail); ok(); });
      opening.once('error', fail);
    });
  } catch (err) {
    cleanup();
    log?.destroy();
    throw err;
  }
  const out = log;
  const closed = new Promise<void>((r) => out.once('close', () => r()));
  out.write(`# building ${tag}\n# FROM ${opts.base}\n\n`);

  return await new Promise<BuildResult>((resolve) => {
    let tail = '';
    let ended = false;
    /** A checked image is being given the record's tag: that is let end (nameGraceMs), so the answer says what is under the tag. */
    let naming = false;
    let late: ReturnType<typeof setTimeout> | undefined;
    let proc: ReturnType<typeof spawn> | undefined;
    let outputs: Readable[] = [];
    /** Stop writing docker's output to the log, and let it drain unread, so docker never waits on it. */
    const letGo = () => { for (const o of outputs) { o.unpipe(out); o.resume(); } };
    // Logging is best-effort: a log that fails part-way never fails the build.
    out.on('error', letGo);
    /**
     * The outcome, once the log has all of this build's output and is closed.
     * Output after it is not this build's to log. A log whose writes do not
     * finish (a pipe nobody reads) is let go after a grace: the build waited
     * on it past its time limit, its name locked until a restart (review of
     * HB-1026).
     */
    const end = (res: BuildResult, last?: string) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      clearTimeout(late);
      opts.signal?.removeEventListener('abort', onAbort);
      letGo();
      cleanup();
      if (last && !out.destroyed) out.write(last);
      out.end();
      // The outcome comes at the grace's end whether or not the log has
      // closed by then: a close waits for a write still in flight.
      const grace = setTimeout(() => { out.destroy(); resolve(res); }, opts.logGraceMs ?? 10_000);
      grace.unref();
      closed.then(() => { clearTimeout(grace); resolve(res); });
    };
    /** Stop the build and all it started: docker leads a process group of its own, as the base build's script does (HB-0883). */
    const stopAll = () => {
      try { if (proc?.pid) process.kill(-proc.pid, 'SIGKILL'); else proc?.kill('SIGKILL'); } catch { proc?.kill('SIGKILL'); }
    };
    /**
     * Stopped (a time limit, the service): all it started is ended, unless a
     * checked image is being named. Killed then, its tag may or may not have
     * moved, and the build was told failed with the checked image under the
     * tag (review of e6a219f4); it is let end instead, for a while, and the
     * answer is what it did.
     */
    const halt = (res: BuildResult, last: string) => {
      if (naming) {
        if (!late) { late = setTimeout(() => { stopAll(); end(res, last); }, opts.nameGraceMs ?? 10_000); late.unref(); }
        return;
      }
      stopAll();
      end(res, last);
    };
    const timer = setTimeout(() => halt({ ok: false, error: 'Build timed out.' }, '\n[timed out]\n'), opts.timeoutMs ?? 30 * 60_000);
    timer.unref();
    // The service stopping: docker's own process group outlived it (review of HB-1026).
    const onAbort = () => halt({ ok: false, error: STOPPED }, '\n[stopped: the service stopped]\n');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    // Stopped while the build was being set up: the listener came after it.
    if (opts.signal?.aborted) return onAbort();

    /** One docker command beside the build, under its time limit and stop: its output read, never logged. `failed`: docker could not be run. */
    const step = (args: string[]) => new Promise<{ code: number | null; out: string; err: string; failed?: string }>((done) => {
      if (ended) return done({ code: null, out: '', err: '' });
      let p: ReturnType<typeof spawn>;
      try { p = spawn(docker, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
      catch (err) { const m = err instanceof Error ? err.message : String(err); return done({ code: null, out: '', err: m, failed: m }); }
      proc = p;
      let said = '', whined = '';
      p.stdout?.on('data', (d: Buffer) => { said = (said + d.toString()).slice(-4000); });
      p.stderr?.on('data', (d: Buffer) => { whined = (whined + d.toString()).slice(-4000); });
      p.on('error', (e) => done({ code: null, out: said, err: whined || e.message, failed: e.message }));
      p.on('close', (code) => done({ code, out: said, err: whined }));
    });
    const why = (r: { code: number | null; err: string }, what: string) => r.err.trim().slice(-400) || `${what} exited ${r.code}`;
    const inspect = async (ref: string): Promise<ImageFacts | string> => {
      const r = await step(['image', 'inspect', '--format', IMAGE_FACTS_FORMAT, ref]);
      return (r.code === 0 && parseImageFacts(r.out)) || (r.code === 0 ? `docker image inspect answered ${JSON.stringify(r.out.trim().slice(0, 80))}` : why(r, 'docker image inspect'));
    };
    const ops: BuiltImageOps = {
      inspect,
      name: async (id, to) => {
        naming = true;
        const r = await step(['tag', id, to]).finally(() => { naming = false; });
        return r.code === 0 ? null : why(r, 'docker tag');
      },
      remove: async (ref) => { await step(['rmi', ref]); },
    };

    const run = async () => {
      // The base as it is now, before the build reads it: what the image
      // built must be built on (its layers begin the image's). A base moved
      // meanwhile (a promote) makes the build refused, never wrongly taken.
      const base = await step(['image', 'inspect', '--format', IMAGE_FACTS_FORMAT, opts.base]);
      if (ended) return;
      if (base.failed) return end({ ok: false, error: `Could not run docker: ${base.failed}` }, `\n[spawn error] ${base.failed}\n`);
      const baseFacts = base.code === 0 ? parseImageFacts(base.out) : undefined;
      if (!baseFacts) {
        const error = `The base ${opts.base} could not be read, so nothing was built: ${base.code === 0 ? 'its answer was not one' : why(base, 'docker image inspect')}. Rebuild to try again.`;
        return end({ ok: false, error }, `\n[${error}]\n`);
      }
      // The packages under the lines: the base's, by its labels, and the record's own.
      const label = (k: string) => baseFacts.labels[k] ?? '';
      const under = [...label('org.hatchabot.extra-packages').split(' '), ...(/(?:^|;)packages=([^;]*)/.exec(label('org.hatchabot.build-inputs'))?.[1] ?? '').split(' '), ...(opts.basePackages ?? [])].filter(Boolean);
      const setLabels = { 'org.hatchabot.derived': opts.name, [RECIPE_LABEL]: recipeStamp(opts.base, opts.dockerfile, under) };
      // NO --pull: the base is a LOCAL image (built by build-runtime-image.sh),
      // not in any registry — --pull would try to fetch it and always fail. Docker
      // resolves the FROM against the local base tag, so a local base rebuild or
      // fleet promote is picked up on the next derived rebuild automatically.
      let built: ReturnType<typeof spawn>;
      try {
        // Labelled as a derived image (buildInputs.ts DERIVED_LABEL): never taken as a base, whatever it is tagged.
        built = spawn(docker, ['build', '-t', building, ...Object.entries(setLabels).flatMap(([k, v]) => ['--label', `${k}=${v}`]), contextDir], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (err) {
        // spawn throws some errors (a bad argument, E2BIG, ENOMEM) rather than emitting them.
        const why = err instanceof Error ? err.message : String(err);
        return end({ ok: false, error: `Could not run docker: ${why}` }, `\n[spawn error] ${why}\n`);
      }
      proc = built;
      // A docker that could not start (EMFILE) has no output streams, and emits its error.
      outputs = [built.stdout, built.stderr].filter((o): o is Readable => !!o);
      for (const o of outputs) {
        o.on('data', (d: Buffer) => {
          if (ended) return;
          const s = d.toString();
          tail = (tail + s).slice(-4000);
          opts.onLog?.(s);
        });
        // A log that failed before docker started (while the base was read)
        // had nothing to let go then: its output is drained unread from the
        // start, or docker waits on a log that will never take it.
        if (out.destroyed || out.errored) o.resume();
        else o.pipe(out, { end: false });
      }

      built.on('close', (code) => {
        if (ended) return;
        if (code !== 0) return end(tail.trim() ? { ok: false, error: tail.trim().slice(-1200), fromDocker: true } : { ok: false, error: `docker build exited ${code}` });
        // Why it is not used goes in the log too: the build's own output ends well.
        const refused = (r: BuildResult) => end(r.ok ? { ok: true } : { ok: false, error: r.error }, r.ok ? undefined : `\n[${r.error}]\n`);
        void useBuiltImage(ops, building, tag, { name: opts.base, layers: baseFacts.layers, labels: baseFacts.labels }, setLabels)
          .then(refused, (err) => refused({ ok: false, error: notChecked(err instanceof Error ? err.message : String(err)) }));
      });
      built.on('error', (err) => {
        end({ ok: false, error: `Could not run docker: ${err.message}` }, `\n[spawn error] ${err.message}\n`);
      });
    };
    void run().catch((err) => end({ ok: false, error: `Could not run docker: ${err instanceof Error ? err.message : String(err)}` }));
  });
}

/**
 * Why an image a build made is not used, when it does not run as node: a
 * line hid the USER node added after the lines. Null when it does. The same
 * words for a derived build here and a recipe's build on another machine.
 */
export function ranAsProblem(user: string): string | null {
  if (user === 'node') return null;
  const who = user === '' || /^(root|0)(:|$)/.test(user) ? 'root' : `"${user.replace(/[^\x20-\x7e]/g, '?').slice(0, 64)}"`;
  return `The built image would run as ${who}, not node: a line in it hides the USER node Hatchabot adds at the end (a heredoc that runs to the end, for example). Change the lines and Rebuild.`;
}

/**
 * Why an image a build made is not used, when it is not built on `base`: the
 * base's layers do not begin its own (buildInputs.ts builtOn, which imports
 * from here).
 */
export function builtOnProblem(layers: readonly string[], baseLayers: readonly string[], base: string): string | null {
  const on = baseLayers.length > 0 && layers.length >= baseLayers.length && baseLayers.every((l, i) => layers[i] === l);
  return on ? null : `The built image is not built on ${base}: a line in it starts another image (a FROM hidden in a heredoc or an escape). Change the lines and Rebuild.`;
}

/**
 * Why an image a build made is not used, when it has one of Hatchabot's own
 * labels (org.hatchabot.…, or the old org.agentclaw.…, or hatchabot.…, which
 * its agents' containers carry and would take from it) other than its base's,
 * besides those the build itself set (`set`, with --label, which docker puts
 * over any the lines set): a line hid a LABEL that no reading of the lines
 * saw, and those labels say what an image was built from (HB-0986 review).
 */
export function labelProblem(labels: Readonly<Record<string, string>>, baseLabels: Readonly<Record<string, string>>, set: Readonly<Record<string, string>>): string | null {
  const ours = (k: string) => /^(org\.(hatchabot|agentclaw)|hatchabot)\./i.test(k) && !Object.hasOwn(set, k);
  const key = [...new Set([...Object.keys(labels), ...Object.keys(baseLabels)])].filter(ours).sort()
    .find((k) => Object.hasOwn(labels, k) !== Object.hasOwn(baseLabels, k) || labels[k] !== baseLabels[k]);
  if (key === undefined) return null;
  // A key that cannot be shown as it is is named by its own prefix (`hatchabot.…`).
  const said = /^(org\.(hatchabot|agentclaw)|hatchabot)\.[a-z0-9][a-z0-9._-]{0,63}$/i.test(key) ? key : `${/^(org\.(hatchabot|agentclaw)|hatchabot)\./i.exec(key)![0]}…`;
  return `The built image sets Hatchabot's own label ${said}: a line in it hides a LABEL (in a heredoc or an escape). Change the lines and Rebuild.`;
}

/** An image a build made, not used because nothing about it could be seen: the check fails closed. */
export const notChecked = (why: string): string => `The built image could not be checked, so it is not used: ${why}. Rebuild to try again.`;

/** How an image a build made is looked at, named and its build's name removed: docker steps here, a provider's calls on another machine. */
export interface BuiltImageOps {
  /** What the image runs as and its layers; a string says why it could not be seen. */
  inspect(ref: string): Promise<ImageFacts | string>;
  /** Name the image `id` as `to`; a string says why it could not be. */
  name(id: string, to: string): Promise<string | null>;
  /** Remove a name, as best it can: never rejects. */
  remove(ref: string): Promise<void>;
}

/**
 * The image a build made, under `building` (checkTag), takes `tag` only if
 * it runs as node, its base's layers, as read before the build, begin its
 * own (HB-1032), and Hatchabot's own labels on it are its base's, but for
 * those the build set (`set`; labelProblem). It is named by the id that was looked at, so the image
 * checked is the image named. Else `building` is removed, `tag` stays on the
 * image it had, and why is the error. Not seen is not used. Once named, the
 * answer is ok whatever happens to the build's own name, removed after it as
 * best it can be. One helper for a derived build here and a recipe's build
 * on another machine (imageRecipe.ts buildRecipeOn).
 */
export async function useBuiltImage(
  ops: BuiltImageOps,
  building: string,
  tag: string,
  base: { name: string; layers: readonly string[]; labels: Readonly<Record<string, string>> },
  set: Readonly<Record<string, string>>,
): Promise<BuildResult & { refused?: true }> {
  const seen = await ops.inspect(building);
  if (typeof seen === 'string') { await ops.remove(building); return { ok: false, error: notChecked(seen) }; }
  const why = ranAsProblem(seen.user) ?? builtOnProblem(seen.layers, base.layers, base.name) ?? labelProblem(seen.labels, base.labels, set);
  // Refused: the lines made an image they may not (not a check that could not be made).
  if (why) { await ops.remove(building); return { ok: false, error: why, refused: true }; }
  const not = await ops.name(seen.id, tag);
  if (not !== null) { await ops.remove(building); return { ok: false, error: `The built image could not be named ${tag}: ${not}.` }; }
  void ops.remove(building).catch(() => {});
  return { ok: true };
}

/**
 * The name a derived build builds to before its image is checked: in a
 * repository of its own, so it is never listed, pinned or taken for a base,
 * and one per record's tag, so one a build left is replaced by the next.
 */
export function checkTag(tag: string): string {
  const at = tag.lastIndexOf(':');
  return at > tag.lastIndexOf('/') ? `${tag.slice(0, at)}-check${tag.slice(at)}` : `${tag}-check`;
}

/**
 * Remove the image from docker, and the name a build of it may have left
 * (checkTag: a build stopped between its check and its tag). Absence is
 * success (idempotent delete). The build's name goes first: one that could
 * not be removed leaves the image, and its record, as they were.
 */
export async function removeDerivedImage(
  tag: string,
  opts: { docker?: string } = {},
): Promise<BuildResult> {
  const docker = opts.docker ?? 'docker';
  const rmi = (ref: string) => new Promise<BuildResult>((resolve) => {
    const proc = spawn(docker, ['rmi', ref]);
    let tail = '';
    proc.stderr.on('data', (d) => (tail += d.toString()));
    proc.on('close', (code) => {
      if (code === 0 || /No such image|reference does not exist/i.test(tail)) resolve({ ok: true });
      else resolve({ ok: false, error: tail.trim().slice(-400) || `docker rmi exited ${code}` });
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
  const left = await rmi(checkTag(tag));
  return left.ok ? await rmi(tag) : left;
}
