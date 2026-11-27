// Building a derived runtime image: `FROM hatchabot-runtime:<base>` plus the
// owner's own Dockerfile lines, for system packages a volume install can't
// provide (apt, root-level setup). See docs/embedding-and-images.md → derived
// images. This shells out to `docker build` exactly like the provider shells
// out to `docker run` — the whole feature is host-owner gated at the API,
// because running a Dockerfile on this box is a privilege the local-host owner
// already has (they can run docker directly).

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { close as fsClose, constants as fsc, existsSync, fstat, ftruncate, open as fsOpen, write as fsWrite } from 'node:fs';
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
  // Without waiting: a pipe at the log's name with nobody writing to it held
  // a thread that does file work until somebody did, and four such reads
  // stalled every file read and write in the service (HB-1289). A pipe or a
  // device has no size, so nothing is read from it.
  const h = await open(path, fsc.O_RDONLY | fsc.O_NONBLOCK);
  try {
    for (let again = true; ; again = false) {
      const { size } = await h.stat();
      const want = Math.min(size, chars * 3 + 3);
      const buf = Buffer.alloc(want);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await h.read(buf, got, want - got, size - want + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      // Short: the log was cut back between its size and the read (a cut
      // ends by setting the file's new, shorter end, HB-1293), and the read
      // went past that end: read its end as it is now, once.
      if (got < want && again) continue;
      let from = 0;
      if (want < size) while (from < Math.min(got, 3) && (buf[from]! & 0xc0) === 0x80) from++;
      return buf.subarray(from, got).toString('utf8').slice(-chars);
    }
  } finally {
    await h.close();
  }
}

/**
 * A line put at the end of a build log that has been written and closed: what Hatchabot did with
 * the build once its script had ended (HB-1508). Without waiting, as the log is opened: a pipe at
 * its name that nobody reads takes nothing, and a log that is gone is not made again. Never throws.
 */
export async function appendBuildLogLine(path: string, line: string): Promise<void> {
  let h;
  try { h = await open(path, fsc.O_WRONLY | fsc.O_APPEND | fsc.O_NONBLOCK); } catch { return; }
  try { await h.write(`${line}\n`); } catch { /* full, or nobody reading: the line is left out */ } finally { await h.close().catch(() => {}); }
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
 * is not a regular file (a pipe, a device) is written as it comes, and never
 * waited on: opened and written without blocking, so a pipe nobody reads
 * fails the open (ENXIO), and the build with it, at once, and one whose
 * reader has stopped reading takes no more of the output once it is full
 * (HB-1289). Build logs grew without end,
 * and every build's output was kept until the next build of that image
 * replaced it.
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
  /**
   * A pipe (or a device) that took no more without waiting (EAGAIN): the
   * output after it is not written, as nobody is reading it. Opened to wait,
   * a write to a pipe nobody read held a thread that does file work for good,
   * and after four every file read and write in the service stalled (HB-1289).
   */
  #stalled = false;
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
      // O_NONBLOCK: opening a pipe nobody reads waited for a reader, before
      // the build's time limit was even set (HB-1289). A regular file is not
      // changed by it. No O_APPEND: a regular file is written where its end
      // is (`#size`), so a cut writes the log's new end before it lets the
      // old one go (HB-1293); with O_APPEND, a write lands at the end
      // wherever it is asked to.
      fsOpen(this.#path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_NONBLOCK, 0o666, (err, fd) => {
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
    if (this.#stalled) return done();
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
    const finish = (err?: NodeJS.ErrnoException | null) => {
      // Full, and nobody reading it: let go of the rest, not an error (HB-1289).
      if (err?.code === 'EAGAIN') { this.#stalled = true; err = null; }
      this.#settled();
      done(err);
    };
    if (!this.#cut || this.#size + chunk.length <= cap) {
      return writeAll(this.#fd, chunk, (err) => {
        if (!err) this.#size += chunk.length;
        finish(err);
      }, stopped, this.#cut ? this.#size : null);
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
    const out = Buffer.concat([first.subarray(from, headEnd), note, tail]);
    // Written over the old output first, and only then the file cut to its
    // new end: a reader between the two finds the end the log had (its newest
    // output but this chunk), which lies past what is written over. Cut
    // first, a poll in between read a log of its first lines alone, or a
    // part of its new end (HB-1293). A write let go part-way leaves the old
    // end where it was, uncut.
    writeAll(this.#fd, out, (err, whole) => {
      if (err || !whole) return finish(err);
      ftruncate(this.#fd, from + out.length, (e) => {
        if (!e) this.#size = from + out.length;
        finish(e);
      });
    }, stopped, from);
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

/**
 * Write all of `buf` at `position` (null: where the file is, as for a pipe),
 * however many writes it takes, until `stopped` (the log let go); `whole`:
 * all of it was written.
 */
function writeAll(fd: number, buf: Buffer, done: (err: NodeJS.ErrnoException | null, whole?: boolean) => void, stopped: () => boolean = () => false, position: number | null = null): void {
  fsWrite(fd, buf, 0, buf.length, position, (err, n) => {
    if (err) return done(err);
    if (n < buf.length) return stopped() ? done(null, false) : writeAll(fd, buf.subarray(n), done, stopped, position === null ? null : position + n);
    done(null, true);
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
  // "an" before a vowel: "a example-runtime:* tag" (HB-1191).
  if (!repoUsed) return `Base must be ${/^[aeiou]/i.test(repo) ? 'an' : 'a'} ${repo}:* tag.`;
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
  return ownFlags(line, /^(?:ONBUILD[ \t\v\f\r]+)?RUN(?:[ \t\v\f\r]+|$)/i)?.flags ?? [];
}

/** A COPY's own flags (or an ONBUILD COPY's), read as runFlags reads RUN's: BuildKit reads every instruction's flags so. */
function copyFlags(line: string): string[] {
  return ownFlags(line, /^(?:ONBUILD[ \t\v\f\r]+)?COPY(?:[ \t\v\f\r]+|$)/i)?.flags ?? [];
}

/**
 * The sources an ADD (or an ONBUILD ADD) names, after its own flags: its
 * words as BuildKit reads them (parseMaybeJSONToList), a JSON array's
 * strings or the words between spaces and tabs, and both when the words
 * begin with `[`; every word but the last, the destination (or the one word
 * there is).
 */
function addSources(line: string): string[] {
  const read = ownFlags(line, /^(?:ONBUILD[ \t\v\f\r]+)?ADD(?:[ \t\v\f\r]+|$)/i);
  if (!read) return [];
  const args = read.args.trim();
  const lists = [args.split(/[ \t]+/).filter(Boolean)];
  if (args.startsWith('[')) {
    try {
      const json: unknown = JSON.parse(args);
      if (Array.isArray(json) && json.every((w) => typeof w === 'string')) lists.push(json as string[]);
    } catch { /* not JSON: docker reads the words */ }
  }
  return lists.flatMap((words) => (words.length > 1 ? words.slice(0, -1) : words));
}

/**
 * A source BuildKit might fetch over the network, judged widely, as any
 * version reads it (dfgitutil.ParseGitRef, isHTTPSource): one with a `:`
 * (a URL or git address of any scheme, an scp-style `user@host:path`), a
 * `$` (an ARG or ENV can hold a URL) or a `\` (an escape can spell either),
 * and the old `github.com/…` form.
 */
function fetchedSource(src: string): boolean {
  return /[:$\\]/.test(src) || /^github\.com\//i.test(src.replace(/["']/g, ''));
}

/** An instruction's own flags, as BuildKit reads them (extractBuilderFlags), and the words after them (`args`); undefined when the line is not that instruction. */
function ownFlags(line: string, instruction: RegExp): { flags: string[]; args: string } | undefined {
  const m = instruction.exec(line);
  if (!m) return undefined;
  const rest = line.slice(m[0].length);
  // Go's unicode.IsSpace, which ends a flag's word: JavaScript's \s, and NEL.
  const space = (ch: string) => /[\s\u0085]/.test(ch);
  const words: string[] = [];
  let i = 0;
  for (;;) {
    while (i < rest.length && space(rest[i]!)) i++;
    if (!rest.startsWith('--', i)) return { flags: words, args: rest.slice(i) };
    let word = '';
    let quote = '';
    for (; i < rest.length; i++) {
      const ch = rest[i]!;
      if (!quote && space(ch)) break;
      if (quote ? ch === quote : ch === '"' || ch === "'") { quote = quote ? '' : ch; continue; }
      if (ch === '\\') { if (i + 1 < rest.length) word += rest[++i]; continue; }
      word += ch;
    }
    if (word === '--') return { flags: words, args: rest.slice(i) };
    words.push(word);
  }
}

/**
 * The snippet is meant to be a thin layer on the base. Reject directives that
 * would escape that: a second FROM (last stage wins), bind/secret mounts of
 * other local images, a COPY of another image's files, an ADD of a URL
 * (fetched from the machine's own network), host networking during the
 * build, a step run without the build's sandbox or with a device of the
 * machine, or a USER of its own.
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
  // The lines with comment lines out, and each one's line number.
  const lines: string[] = [];
  const lineNo: number[] = [];
  for (const [n, l] of physical.entries()) if (!/^\s*#/.test(l)) { lines.push(l); lineNo.push(n + 1); }
  // BuildKit joins a continued line with NOTHING: `RUN --net\` + `work=host`
  // is `--network=host`, and `FR\` + `OM x` is FROM. Joined with a space,
  // those passed (night review, 2026-09-28). Judge both joinings, and blank
  // lines inside a continuation vanish as BuildKit drops them.
  const each = joinEachLine(lines);
  // How this reads the lines: where each instruction starts, and which lines
  // are a heredoc's text. It decides only which USER lines are text, and the
  // rules that keep this reading plain (a line ending in \\, a heredoc's
  // name): nothing below that keeps the image on its base depends on it.
  const instructions = joinInstructions(each);
  const starts = new Set(instructions.map((ins) => ins.start));
  const text = heredocText(lines, instructions);
  // A line that ends with \\ does not go on for BuildKit, whose continuation
  // needs its last \ not to follow another (CONTINUED): refused, so that
  // every instruction that goes on ends with one \. Not in a heredoc's text,
  // whose lines docker never joins.
  const doubled = lines.findIndex((l, i) => !text.has(i) && /\\\\[ \t]*$/.test(l));
  if (doubled >= 0) return `Line ${lineNo[doubled]} ends with \\\\: docker reads that as an escaped \\, not as a line that goes on. End it with one \\ to go on to the next line, or with none.`;
  // Every line is judged as the start of an instruction, joined from there
  // as BuildKit would join it, whatever this reading of the lines takes it
  // for (HB-1032 review). Docker starts each instruction at a line's start,
  // so no misreading of a heredoc or of a continuation, in any BuildKit
  // version, can hide an instruction from these rules: four rounds of review
  // found a line this reading took for a heredoc's text, or for part of the
  // line above, that docker read as an instruction (a FROM, which starts a
  // stage on any image whose ONBUILD lines run with RUN flags nothing here
  // reads, before any check of the image built). The rules judged so: FROM;
  // --mount and --network anywhere on the line; RUN's own flags --mount,
  // --network, --security and --device (an ONBUILD RUN's too); COPY's own
  // --from (an ONBUILD COPY's too); an ADD of a URL (an ONBUILD ADD's too);
  // and Hatchabot's own labels. The
  // plain-text and parser-directive rules above are judged on every line
  // already. A line refused so that this reading
  // takes for a heredoc's text or part of an instruction is told that every
  // line is judged so, and how to write it. The cost: such a line that
  // begins as an instruction would (`from os import path` in a script a RUN
  // writes, or `RUN echo a\` then `FROM …`, one line to BuildKit) is refused.
  // Only USER is judged where this reading starts an instruction outside a
  // heredoc: a script a RUN writes may set `USER=…` (HB-1032). A USER that
  // docker reads as an instruction where it is taken for text here only
  // changes who the lines after it run as, never more than root, which they
  // run as already; the image built must run as node (useBuiltImage).
  for (let i = 0; i < lines.length; i++) {
    const reads = starts.has(i) && !text.has(i);
    const why = (rule: string) => (reads ? rule : `${rule} Hatchabot judges every line as if an instruction began on it, since its reading of heredocs and of lines that go on may not be docker's. Write line ${lineNo[i]} another way, such as joined to the line before it, or have a RUN write that file's line with printf.`);
    for (const joined of [each[i]!.tight, each[i]!.spaced]) {
      const line = joined.trim();
      if (/^FROM\b/i.test(line)) return why('A derived image cannot contain its own FROM — the base field sets it.');
      // The flag's whole name: `\b` also stopped at a `-`, so a command's own
      // `--network-timeout` or `--mount-point` was refused as RUN's flag.
      // Anywhere on the line, so on the line an instruction starts on: one
      // that goes on is a part of it.
      if (starts.has(i) && /--mount(?![\w-])/i.test(line)) return why('RUN --mount is not allowed in a derived image.');
      if (starts.has(i) && /--network(?![\w-])/i.test(line)) return why('RUN --network is not allowed in a derived image.');
      // And as RUN's own flags, their quotes and escapes out: `--net"work"=host` is that flag (HB-1291 review).
      // One that got past these would not run either, on Docker's default
      // builder (the docker driver): BuildKit runs a step on the host's
      // network only with the network.host entitlement, which a build gets
      // only by asking (buildx's --allow, or the classic API's
      // --network=host), and no build of these lines asks; the legacy
      // builder refuses any RUN flag (HB-1328). That holds only there: a
      // machine whose builder is a buildx docker-container one made with
      // --driver-opt network=host runs every RUN on the host's network,
      // whatever the lines say.
      const flags = runFlags(line);
      if (flags.some((f) => /^--mount(=|$)/i.test(f))) return why('RUN --mount is not allowed in a derived image.');
      if (flags.some((f) => /^--network(=|$)/i.test(f))) return why('RUN --network is not allowed in a derived image.');
      // --security=insecure runs the line without the build's sandbox (as
      // `docker run --privileged` does), and --device gives it a device of this
      // machine; both are stable Dockerfile syntax (1.20, 1.27). BuildKit runs
      // them only with an entitlement the daemon allows and the build asks for
      // (--allow), and no build here asks; but Docker's daemon allows `device`
      // unless told not to, and a device whose CDI spec lets it in needs no
      // asking (HB-1291). Only RUN's own flags, read as BuildKit reads them
      // (runFlags): `--sec"urity"=insecure` is that flag, and the command's
      // `--device cpu` or `--security` is not (HB-1291 review).
      if (flags.some((f) => /^--security(=|$)/i.test(f))) return why('RUN --security is not allowed in a derived image.');
      if (flags.some((f) => /^--device(=|$)/i.test(f))) return why('RUN --device is not allowed in a derived image.');
      // COPY --from copies another image's files into this one: any image on
      // the machine (one whose files hold keys; another derived image, which
      // then cannot be rebuilt where that one is missing, HB-1470), or one
      // docker pulls with the machine's registry logins. The reach of RUN
      // --mount=from=…, refused above, and no check of the image built can
      // see it: its base, user and labels are unchanged. The lines start no
      // stage to copy from (FROM is refused), so every --from is another
      // image (HB-1473). COPY's own flags, read as BuildKit reads them (an
      // ONBUILD COPY's too); ADD has no --from.
      if (copyFlags(line).some((f) => /^--from(=|$)/i.test(f))) return why(COPY_FROM);
      // ADD fetches a URL or a git address itself, in Docker's daemon: from
      // this machine's own network, where services only this machine can
      // reach answer (those on its loopback, which a build's RUN cannot
      // reach), redirects followed, so a public URL can lead there too (the
      // owner's decision, HB-1500). Judged widely, for any
      // BuildKit's reading (fetchedSource), its flags read first so none
      // hides a source. What ADD is left: a heredoc's text, or a path in the
      // build's folder, which holds only the Dockerfile.
      if (addSources(line).some(fetchedSource)) return why(ADD_URL);
      if (reads && /^USER\b/i.test(line)) return 'USER is managed for you (root during your lines, node at the end).';
      // Hatchabot's own labels say what the image was built from, and a base's
      // are read to match it on another machine (HB-0986): lines that plainly
      // set them are told so here. Quotes and escapes come out of a key first
      // (`o"rg".hatchabot…`). One named from a variable, or hidden, is found in
      // the image built (labelProblem), so a variable in the owner's own label
      // (`LABEL v=${VER}`) is theirs (HB-0986 review). So are the ones its
      // agents' containers carry (hatchabot.console-port, .agent, .role), as a
      // key (`hatchabot.x=` or `LABEL hatchabot.x y`): a container takes its
      // image's labels, and the status reads them (HB-0986 review).
      if (/^(ONBUILD\s+)?LABEL\b/i.test(line)) {
        const keys = line.replace(/["'\\]/g, '');
        if (/org\.(hatchabot|agentclaw)\./i.test(keys) || /(^|\s)hatchabot\.[^\s=]*=/i.test(keys) || /^(ONBUILD\s+)?LABEL\s+hatchabot\./i.test(keys)) {
          return why("A derived image cannot set Hatchabot's own labels (org.hatchabot.…, hatchabot.…): they say what its base was built from, and what its agents' containers are.");
        }
      }
    }
  }
  // The USER node appended after the snippet must stay an instruction of its
  // own. A last line ending in `\` continues into it (comment and blank lines
  // between are dropped first), so `RUN echo installed \` swallowed it and
  // the image stayed root (B002); an unterminated heredoc (`RUN <<EOF` with
  // no EOF line) would take it in as text the same way.
  const last = [...lines].reverse().find((l) => l.trim());
  if (last !== undefined && CONTINUED.test(last)) return 'The last line ends with a \\ that continues it into nothing — finish that instruction.';
  // The heredocs each instruction opens, as this reads them (not a
  // heredoc's text, whose lines docker never reads for one), joined as
  // BuildKit joins it: a `<<` split over a continued line (`RUN cat <\` then
  // `<'CMD\'`) is one there (HB-1032 review).
  for (const ins of instructions) {
    if (text.has(ins.start)) continue;
    for (const { dash, word, plain, written } of heredocsOn(ins.tight)) {
      // A name is a plain word, so this reading closes it where BuildKit
      // does. BuildKit names a heredoc by the whole word after `<<`, its
      // quotes and escapes taken out: `<<'CMD\'` is named `CMD\`, so the
      // line `CMD\` closes it, where a reading that took `CMD` joined that
      // line to the next (HB-1032 review). `<<EOF;` and `<<EOF>/x` are
      // named `EOF;` and `EOF>/x` there too.
      if (!plain) return `The heredoc ${written} is not named with a plain word. A heredoc's name must be a plain word such as EOF (letters, digits and _, quoted or not: <<EOF, <<'EOF').`;
      const body = (l: string) => (dash ? l.replace(/^\t+/, '') : l);
      const close = lines.findIndex((l, n) => n > ins.end && body(l) === word);
      if (close < 0) return `The heredoc <<${word} is never closed by a line "${word}".`;
      // Nor a line that is its name with a \ after it. It is text to
      // BuildKit, which ends a heredoc only at its name alone, but the lines'
      // joinings carry it into the line after it: refused, so where the
      // heredoc ends is never in doubt.
      const escaped = lines.slice(ins.end + 1, close).find((l) => new RegExp(`^${word}\\\\[ \t]*$`).test(body(l)));
      if (escaped !== undefined) return `The heredoc <<${word} has a line "${escaped.trim()}" that ends with a \\. A heredoc ends at a line that is its name alone, ${word}, with nothing after it.`;
    }
  }
  return null;
}

/** Why an ADD of a URL is refused (HB-1500). */
const ADD_URL = "ADD of a URL is not allowed in a derived image: Docker fetches it from this machine's own network, where it can reach services only this machine can (a git address, or a source named by a variable such as $X, counts as one). Download it with RUN curl instead, which runs in the build's own network.";

/** Why a COPY --from is refused (HB-1473). */
const COPY_FROM = "COPY --from is not allowed in a derived image: it copies another image's files into this one (any image on this machine, or one Docker can pull with this machine's logins). Install what you need with RUN instead, such as apt-get install or a download.";

/** A line that goes on to the next, as BuildKit's continuation reads it: a last \ (spaces and tabs after it aside) that does not follow another \. */
const CONTINUED = /(?:^|[^\\])\\[ \t]*$/;

interface Heredoc {
  dash: boolean;
  /** Its name, quotes and escapes out. */
  word: string;
  /** Letters, digits and _ only, its quotes closed: the only names taken. */
  plain: boolean;
  /** As the line has it, from its `<<`, for a refusal. */
  written: string;
}

/**
 * The heredocs BuildKit opens on an instruction, joined as BuildKit joins it
 * (heredocsFromLine, as since v0.22): none unless it has a `<<`; else each
 * shell word that begins with `<<` (or `<<-`), digits before it allowed,
 * then a name with no `<` in it, after any spaces or tabs a `<<` keeps in
 * its word (shellWords). BuildKit fills in no variable there (SkipUnsetEnv),
 * so a word that begins with `$` opens none. So `$((1<<2))` opens none,
 * `1 << 4` one named `4`, and `<<=` one named `=`.
 */
function heredocsOn(instruction: string): Heredoc[] {
  if (!instruction.includes('<<')) return [];
  const found: Heredoc[] = [];
  for (const w of shellWords(instruction)) {
    const m = /^[0-9]*<<(-?)[ \t]*/.exec(w);
    if (!m) continue;
    const rest = w.slice(m[0].length);
    if (!rest || rest.includes('<')) continue; // BuildKit: no name, or a < in it, is no heredoc (`<<<` among them)
    const { name, whole } = unquoted(rest);
    found.push({ dash: m[1] === '-', word: name, plain: whole && /^[A-Za-z0-9_]+$/.test(name), written: w.slice(w.indexOf('<<')) });
  }
  return found;
}

/**
 * An instruction's shell words as BuildKit's lexer splits them for its
 * heredocs (quotes and escapes kept): at a space or a tab outside quotes and
 * ${…}; none inside '…'; a \ takes the character after it; a ${…} runs to
 * its } (quotes and ${…} inside it read as well); and a `<<` keeps the
 * spaces and tabs after it (processPossibleHeredoc, BuildKit v0.22 and
 * later), so `<< EOF` is one word.
 */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let text = '';
  const stack: string[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!, top = stack.at(-1);
    if (top === "'") { text += c; if (c === "'") stack.pop(); continue; }
    if (c === '\\') { text += line.slice(i, i + 2); i++; continue; }
    if (c === '$' && line[i + 1] === '{') { stack.push('{'); text += '${'; i++; continue; }
    if (top === '"') { text += c; if (c === '"') stack.pop(); continue; }
    if (c === '}' && top === '{') { text += c; stack.pop(); continue; }
    if (c === '"' || c === "'") { stack.push(c); text += c; continue; }
    if (c === '<' && line[i + 1] === '<' && !stack.length) { const op = /^<<[ \t]*/.exec(line.slice(i))![0]; text += op; i += op.length - 1; continue; }
    if ((c === ' ' || c === '\t') && !stack.length) { if (text) words.push(text); text = ''; continue; }
    text += c;
  }
  if (text) words.push(text);
  return words;
}

/** A heredoc's name with its quotes and escapes out, as BuildKit takes them (none inside '…'; in "…", a \ before ", $, ` or \ only); `whole` when every quote is closed. */
function unquoted(rest: string): { name: string; whole: boolean } {
  let name = '';
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (c === "'") {
      const close = rest.indexOf("'", i + 1);
      if (close < 0) return { name, whole: false };
      name += rest.slice(i + 1, close); i = close;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < rest.length && rest[j] !== '"'; j++) {
        if (rest[j] === '\\' && j + 1 < rest.length) { name += '"$`\\'.includes(rest[j + 1]!) ? rest[j + 1]! : `\\${rest[j + 1]!}`; j++; } else name += rest[j]!;
      }
      if (j >= rest.length) return { name, whole: false };
      i = j;
    } else if (c === '\\') {
      if (i + 1 >= rest.length) return { name: name + c, whole: false };
      name += rest[++i]!;
    } else name += c;
  }
  return { name, whole: true };
}

/**
 * Each line (comment lines out) joined forward as BuildKit joins an
 * instruction that starts on it: while a line goes on (CONTINUED), its \ out
 * and the next line after it, blank lines between dropped. Joined with
 * nothing (`tight`, BuildKit's) and with a space (`spaced`); `end`: the last
 * line taken. Built from the last line back, so each line's is its own part
 * and the next one's.
 */
function joinEachLine(lines: readonly string[]): Array<{ end: number; tight: string; spaced: string }> {
  const out: Array<{ end: number; tight: string; spaced: string }> = new Array(lines.length);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!CONTINUED.test(l)) { out[i] = { end: i, tight: l, spaced: l }; continue; }
    const part = l.replace(/\\[ \t]*$/, '');
    let j = i + 1;
    while (j < lines.length && /^[ \t]*$/.test(lines[j]!)) j++; // a blank line inside a continuation, dropped as BuildKit drops it
    out[i] = j < lines.length ? { end: out[j]!.end, tight: part + out[j]!.tight, spaced: `${part} ${out[j]!.spaced}` } : { end: lines.length - 1, tight: part, spaced: part };
  }
  return out;
}

/** The instructions as this reads the lines: one starts on the first line, and each on the line after the last the one before it takes (joinEachLine). */
function joinInstructions(each: ReturnType<typeof joinEachLine>): Array<{ start: number; end: number; tight: string; spaced: string }> {
  const out: Array<{ start: number; end: number; tight: string; spaced: string }> = [];
  for (let i = 0; i < each.length; i = each[i]!.end + 1) out.push({ start: i, ...each[i]! });
  return out;
}

/**
 * The lines (comment lines out) that are a heredoc's text, as this reads
 * them: after a RUN, COPY or ADD (or an ONBUILD of one) that opens heredocs
 * (heredocsOn), each one's text up to the line that closes it, in turn. Not
 * the closing lines. A heredoc never closed takes nothing: the lines are
 * refused for it. On these lines a USER is not judged (HB-1032), nor the
 * rules that keep this reading plain; docker may read one as an
 * instruction, so FROM and the rules that keep the image on its base are
 * judged on every line, these too (dockerfileProblem).
 */
function heredocText(lines: readonly string[], instructions: ReturnType<typeof joinInstructions>): Set<number> {
  const text = new Set<number>();
  let next = 0; // the first line no heredoc has taken yet
  for (const ins of instructions) {
    if (ins.start < next) continue; // a heredoc's text, as this reads it
    next = ins.end + 1;
    if (!/^[ \t]*(ONBUILD[ \t]+)?(RUN|COPY|ADD)([ \t]|$)/i.test(ins.tight)) continue;
    for (const { dash, word, plain } of heredocsOn(ins.tight)) {
      if (!plain) return text; // refused, so its text is no matter
      let close = next;
      while (close < lines.length && (dash ? lines[close]!.replace(/^\t+/, '') : lines[close]) !== word) close++;
      if (close >= lines.length) return text;
      for (let t = next; t < close; t++) text.add(t);
      next = close + 1;
    }
  }
  return text;
}

/** The base's packages (an imported image's, HB-0986) go on first, as root, then the owner's lines. */
export function renderDockerfile(base: string, snippet: string, basePackages: readonly string[] = []): string {
  return `FROM ${base}\nUSER root\n${basePackages.length ? `${aptInstallLine(basePackages)}\n` : ''}${snippet}\nUSER node\n`;
}

/**
 * What a derived build refuses before docker runs: its lines
 * (dockerfileProblem) and its base packages. The routes judge a record by it
 * before marking it building: a Rebuild of lines saved before a rule (a
 * COPY --from, HB-1473) marked a working image FAILED, with a new base if
 * one was given and no log of why (review of HB-1473).
 */
export function derivedBuildProblem(dockerfile: string, basePackages: readonly string[] = []): string | null {
  const problem = dockerfileProblem(dockerfile);
  if (problem) return problem;
  if (basePackages.length > 32 || basePackages.some((p) => p.length > 64 || !APT_PACKAGE_NAME.test(p))) return 'Its base packages are not all package names.';
  return null;
}

export interface BuildResult {
  ok: boolean;
  /** Why it failed: docker's own last output when `fromDocker`, else Hatchabot's words (a refusal, a time limit). */
  error?: string;
  /** The error is the tail of what docker printed. */
  fromDocker?: true;
}

/**
 * Every process below `root` now, by the process table (`ps`): its children,
 * theirs, and so on. Empty when the table cannot be read. A process that has
 * left the tree (a daemon whose parent has gone) is not in it. The base
 * build's stop and a derived build's read it (HB-1186, HB-1506).
 */
export function descendants(root: number): number[] {
  const ps = ['/bin/ps', '/usr/bin/ps'].find((p) => existsSync(p));
  if (!ps) return [];
  let table: string;
  try { table = execFileSync(ps, ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return []; }
  const children = new Map<number, number[]>();
  for (const line of table.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !Number.isInteger(ppid)) continue;
    children.set(ppid!, [...(children.get(ppid!) ?? []), pid]);
  }
  const found: number[] = [];
  for (let todo = [root]; todo.length;) {
    for (const pid of children.get(todo.pop()!) ?? []) {
      if (pid === process.pid || found.includes(pid)) continue;
      found.push(pid);
      todo.push(pid);
    }
  }
  return found;
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
  /** The outcome as soon as it is known, before the log has closed (its grace): what the record must not lose to a stop meanwhile. */
  onOutcome?: (res: BuildResult) => void;
}): Promise<BuildResult> {
  const STOPPED = 'The build was stopped: the service stopped.';
  if (opts.signal?.aborted) return { ok: false, error: STOPPED };
  // Checked again here, not only when the lines were saved: a record saved
  // before a rule existed (B002's trailing `\`) is rebuilt from the database.
  const basePackages = opts.basePackages ?? [];
  const problem = derivedBuildProblem(opts.dockerfile, basePackages);
  if (problem) return { ok: false, error: problem };
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
      opts.onOutcome?.(res);
      // The outcome comes at the grace's end whether or not the log has
      // closed by then: a close waits for a write still in flight.
      const grace = setTimeout(() => { out.destroy(); resolve(res); }, opts.logGraceMs ?? 10_000);
      grace.unref();
      closed.then(() => { clearTimeout(grace); resolve(res); });
    };
    /**
     * Stop the build and all it started: docker leads a process group of its
     * own, as the base build's script does (HB-0883). And every process below
     * it, as the table has them just before, first, while those above them
     * still stand: a step that starts a session of its own (setsid) is in no
     * group of docker's, and outlived the group's kill (HB-1506, as HB-1186
     * was for the base build).
     */
    const stopAll = () => {
      const p = proc;
      // Only while it has not been reaped: its number is its own until then.
      const below = p?.pid && p.exitCode === null && p.signalCode === null ? descendants(p.pid) : [];
      for (const pid of below) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone already */ } }
      try { if (p?.pid) process.kill(-p.pid, 'SIGKILL'); else p?.kill('SIGKILL'); } catch { p?.kill('SIGKILL'); }
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
