import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { appendBuildLogLine, buildDerivedImage, openBuildLog, readLogTail } from '../src/orchestrator/machines/derivedImage.js';
import { createRuntimeImages } from '../src/orchestrator/machines/runtimeImages.js';

/**
 * A build log's own file work (derivedImage.ts, BuildLog): what it does
 * when the file takes its writes slowly, never, or not all at once. node:fs
 * is itself here, but a test may hold or watch each write, cut and close
 * the log makes (`fsHooks`), as a slow or stuck disk would. No build here
 * runs docker: a made-up one, on a PATH of its own.
 */
type Op = 'write' | 'ftruncate' | 'close';
type Real = (...args: unknown[]) => unknown;
const fsHooks = vi.hoisted(() => ({} as Partial<Record<'write' | 'ftruncate' | 'close', (real: Real, args: unknown[]) => unknown>>));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const hooked = (op: Op) => (...args: unknown[]) => {
    const fn = real[op] as unknown as Real;
    const hook = fsHooks[op];
    return hook ? hook(fn, args) : fn(...args);
  };
  return { ...real, write: hooked('write'), ftruncate: hooked('ftruncate'), close: hooked('close') };
});

/** A program's full path: the made-up docker runs on a PATH that has only itself. */
const tool = (name: string) => ['/usr/bin', '/bin'].map((d) => join(d, name)).find((p) => existsSync(p)) ?? name;
const LAYER = (c: string) => `sha256:${c.repeat(64)}`;
/** What a made-up docker says of an image: the base is one layer, what a build makes (its check name) runs as node on it. */
const CHECKS = `case "$1" in image) case "$5" in *-check:*) echo '["${LAYER('c')}","node",["${LAYER('a')}","${LAYER('c')}"],null]';; *) echo '["${LAYER('a')}","node",["${LAYER('a')}"],null]';; esac; exit 0;; tag|rmi) exit 0;; esac`;
/** Until `ok`, or `ms` have gone by. */
const until = async (ok: () => boolean, ms = 3000) => { for (const t0 = Date.now(); !ok() && Date.now() - t0 < ms;) await new Promise((r) => setTimeout(r, 20)); };
/** What comes first on a log: its open, its error's code, or nothing for `ms` ("waiting"). */
const firstOf = (log: NodeJS.EventEmitter, ms = 2000) => new Promise<string>((r) => {
  log.once('open', () => r('open'));
  log.once('error', (e: NodeJS.ErrnoException) => r(e.code ?? String(e)));
  setTimeout(() => r('waiting'), ms).unref();
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hb-build-log-')); });
afterEach(() => {
  for (const k of Object.keys(fsHooks) as Op[]) delete fsHooks[k];
  rmSync(dir, { recursive: true, force: true });
});

describe("a line put at a build log's end once it is closed (HB-1508)", () => {
  it('goes after what is there, makes no log that is gone, and never waits on a pipe nobody reads', async () => {
    const p = join(dir, '_base.log');
    writeFileSync(p, 'Built hatchabot-runtime:2026.9.8 (candidate — :latest untouched)\n');
    await appendBuildLogLine(p, 'Then Hatchabot made it the fleet default.');
    expect(readFileSync(p, 'utf8')).toBe('Built hatchabot-runtime:2026.9.8 (candidate — :latest untouched)\nThen Hatchabot made it the fleet default.\n');
    const gone = join(dir, 'gone.log');
    await appendBuildLogLine(gone, 'Then Hatchabot made it the fleet default.');
    expect(existsSync(gone)).toBe(false);
    if (existsSync(tool('mkfifo'))) {
      const fifo = join(dir, 'pipe.log');
      execFileSync(tool('mkfifo'), [fifo]);
      const t0 = Date.now();
      await appendBuildLogLine(fifo, 'Then Hatchabot made it the fleet default.');
      expect(Date.now() - t0).toBeLessThan(2000);
    }
  });
});

describe('a build log that is a pipe is never waited on (HB-1289)', () => {
  it.runIf(existsSync(tool('mkfifo')))('a pipe nobody reads fails the open at once, and holds no thread that does file work', async () => {
    // Opened to wait, the open waited for a reader before the build's time
    // limit was even set, on one of the four threads all file work shares.
    const p = join(dir, 'media.log');
    execFileSync(tool('mkfifo'), [p]);
    const log = openBuildLog(p);
    const first = await firstOf(log);
    try {
      expect(first).toBe('ENXIO');
    } finally {
      // Waited on (the old way): a reader lets the open end, and the thread go.
      if (first === 'waiting') {
        const reader = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        await firstOf(log);
        log.destroy();
        closeSync(reader);
      }
    }
  });

  it.runIf(existsSync(tool('mkfifo')))('a pipe whose reader has stopped reading takes what it can, and the log finishes', async () => {
    // Once the pipe was full, a write to it waited for good, holding a thread
    // that does file work; after four every file read and write in the service stalled.
    const p = join(dir, 'media.log');
    execFileSync(tool('mkfifo'), [p]);
    const reader = openSync(p, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const log = openBuildLog(p);
    try {
      const finished = new Promise<string>((r) => {
        log.once('finish', () => r('finished'));
        log.once('error', (e: NodeJS.ErrnoException) => r(e.code ?? String(e)));
        setTimeout(() => r('waiting'), 3000).unref();
      });
      for (let i = 0; i < 64; i++) log.write(Buffer.alloc(16 * 1024, 'x'));
      log.end('the last line\n');
      expect(await finished).toBe('finished');
      // What the pipe took is the log's start.
      const got = Buffer.alloc(2 ** 20);
      const n = readSync(reader, got);
      expect(n).toBeGreaterThan(0);
      expect(got.subarray(0, n).every((b) => b === 0x78)).toBe(true);
    } finally {
      closeSync(reader); // a write still waiting on the pipe (the old way) ends with it
      log.destroy();
    }
  });

  it.runIf(existsSync(tool('mkfifo')))('reading the end of a log that is a pipe nobody writes to gives nothing, at once', async () => {
    // The base build's page and a derived image's log are read every few
    // seconds: each read of a pipe with no writer waited on a thread that
    // does file work, until somebody wrote to it.
    const p = join(dir, 'media.log');
    execFileSync(tool('mkfifo'), [p]);
    const read = readLogTail(p, 16_000);
    const got = await Promise.race([read, new Promise<string>((r) => setTimeout(() => r('waiting'), 2000).unref())]);
    try {
      expect(got).toBe('');
    } finally {
      if (got === 'waiting') { closeSync(openSync(p, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)); await read.catch(() => {}); }
    }
  });
});

describe("a build's log let go after its grace (review of HB-1026)", () => {
  it.runIf(existsSync(tool('sleep')))('keeps its file open until the write in flight on it ends, and the build is not held up by it', async () => {
    // Closed under that write, its number was free for another file, where
    // the rest of a partial write could land; and a close behind the stuck
    // write held the build up again. The write is held here, as a stuck disk
    // holds it (a pipe nobody reads no longer does, HB-1289).
    mkdirSync(join(dir, 'bin'));
    const docker = join(dir, 'bin', 'docker');
    writeFileSync(docker, `#!/bin/sh\n${CHECKS}\necho "the first line"; exec ${tool('sleep')} 5\n`);
    chmodSync(docker, 0o755);
    let held: (() => void) | undefined;
    let heldFd = -1;
    const closed: number[] = [];
    fsHooks.write = (real, args) => {
      const buf = args[1] as Buffer;
      if (held || !buf.includes('the first line')) return real(...args);
      heldFd = args[0] as number;
      held = () => { held = () => {}; real(...args); };
      return undefined;
    };
    // Once the held write has its file: an earlier test's log may close late, under a number this one takes after.
    fsHooks.close = (real, args) => { if (heldFd >= 0) closed.push(args[0] as number); return real(...args); };
    const was = process.env.PATH;
    process.env.PATH = join(dir, 'bin');
    try {
      const t0 = Date.now();
      const res = await buildDerivedImage({ name: 'media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', docker, dataDir: join(dir, 'data'), timeoutMs: 500, logGraceMs: 300 });
      expect(res).toEqual({ ok: false, error: 'Build timed out.' });
      expect(Date.now() - t0).toBeLessThan(3000);
      expect(heldFd).toBeGreaterThanOrEqual(0);
      expect(closed).not.toContain(heldFd);
      // The write ends, and only then the file closes.
      held!();
      await until(() => closed.includes(heldFd));
      expect(closed).toContain(heldFd);
    } finally {
      process.env.PATH = was;
      held?.();
    }
  }, 10_000);
});

describe('a build log read while it is cut back (HB-1293)', () => {
  it('begins with its first lines and ends with the newest output written, at every moment a reader can look', async () => {
    // The cut truncated the log to its first lines, then wrote the note and
    // the last lines after them: a poll in between read a log of its first
    // lines alone, or a part of its end. Each write and cut is looked at
    // here just before it starts, which is what a reader can find between them.
    const p = join(dir, 'x.log');
    const line = (n: number) => `line ${n} of the build\n`;
    let fd = -1;
    let written = 0;
    const seen: Array<{ text: string; written: number }> = [];
    const look = (real: Real, args: unknown[]) => {
      if (args[0] === fd) seen.push({ text: readFileSync(p, 'utf8'), written });
      return real(...args);
    };
    fsHooks.write = look;
    fsHooks.ftruncate = look;
    const log = openBuildLog(p, { cap: 2000, head: 200, keep: 600, kept: 3 });
    log.once('open', (n: number) => { fd = n; });
    for (let n = 1; n <= 400; n++) {
      await new Promise<void>((ok, fail) => log.write(line(n), (e) => { if (e) fail(e); else { written = n; ok(); } }));
    }
    await new Promise((r) => { log.once('close', r); log.end(); });
    seen.push({ text: readFileSync(p, 'utf8'), written });
    expect(seen.filter((s) => s.text.includes('bytes of output left out here')).length).toBeGreaterThan(10);
    for (const s of seen.filter((x) => x.written > 0)) {
      expect(s.text.startsWith(line(1))).toBe(true);
      const last = /line (\d+) of the build\n$/.exec(s.text);
      expect(last, s.text.slice(-120)).toBeTruthy();
      expect(Number(last![1]), s.text.slice(-120)).toBeGreaterThanOrEqual(s.written);
    }
    // And the log as it is left is whole: its first lines, the note, its last lines.
    expect(seen.at(-1)!.text).toMatch(/^line 1 of the build\n[^]*\n\[\.\.\. \d+ bytes of output left out here[^\n]*\]\n\n[^]*line 400 of the build\n$/);
  });

  it('a read whose log is cut back between its size and its read reads the end again (review of HB-1293)', async () => {
    // The cut ends by setting the file's new end, shorter than the old: a
    // poll that had its size before that read past the new end, nothing,
    // and showed an empty log.
    const p = join(dir, 'x.log');
    const cutTo = 'line 1 of the build\n\n[... 9000 bytes of output left out here: a build log keeps its first and last lines ...]\n\nline 400 of the build\n';
    writeFileSync(p, 'line 1 of the build\n' + 'line 2 of the build\n'.repeat(400));
    const fh = await open(p, 'r');
    const proto = Object.getPrototypeOf(fh) as { stat: (...a: unknown[]) => Promise<unknown> };
    await fh.close();
    const realStat = proto.stat;
    let cut = false;
    const spy = vi.spyOn(proto, 'stat').mockImplementation(async function (this: unknown, ...a: unknown[]) {
      const st = await realStat.apply(this, a);
      // Cut back just after the poll has its size, as a cut does it: written over, then shortened.
      if (!cut) { cut = true; writeFileSync(p, cutTo); }
      return st;
    });
    try {
      expect(await readLogTail(p, 60)).toBe(cutTo.slice(-60));
      expect(cut).toBe(true);
    } finally { spy.mockRestore(); }
  });
});

describe("the base build's log end is waited for a while, not for ever (HB-1290)", () => {
  it('a build whose last write to its log does not finish ends all the same, by its exit code', async () => {
    // The script has exited and its output closed; the log's last write
    // hangs (a disk that does not answer). The build waited for the log to
    // finish with no limit: "a base image build is already running" until
    // the service restarted.
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'bash'), '#!/bin/sh\necho "built the image"\n');
    chmodSync(join(dir, 'bin', 'bash'), 0o755);
    let held: (() => void) | undefined;
    fsHooks.write = (real, args) => {
      if (held || !(args[1] as Buffer).includes('built the image')) return real(...args);
      held = () => { held = () => {}; real(...args); };
      return undefined;
    };
    const images = createRuntimeImages({
      store: new Store(new Database(':memory:')),
      providerFor: () => { throw new Error('no machine in this test'); },
      defaultBase: 'hatchabot-runtime:latest',
      dataDir: join(dir, 'data'),
      notify: async () => {},
      log: { info: () => {}, error: () => {} },
      baseLogGraceMs: 300,
    });
    const was = process.env.PATH;
    process.env.PATH = join(dir, 'bin');
    try {
      images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
      await until(() => !!held);
      expect(held).toBeDefined();
      await until(() => !images.baseBuildNow().running, 5000);
      expect(images.baseBuildNow()).toMatchObject({ running: false, ok: true });
    } finally {
      process.env.PATH = was;
      images.stop();
      held?.();
    }
  }, 10_000);

  it('a failed build whose log cannot be read back ends all the same, by its exit code (review of HB-1290)', async () => {
    // A failure is judged by its log's end, read back from the disk; on a
    // disk that hangs that read never ended, and nor did the build.
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'bash'), '#!/bin/sh\necho "made-up failure"\nexit 3\n');
    chmodSync(join(dir, 'bin', 'bash'), 0o755);
    const fh = await open(join(dir, 'bin', 'bash'), 'r');
    const proto = Object.getPrototypeOf(fh) as { stat: (...a: unknown[]) => Promise<unknown> };
    await fh.close();
    let reads = 0;
    const spy = vi.spyOn(proto, 'stat').mockImplementation(() => { reads++; return new Promise(() => {}); });
    const images = createRuntimeImages({
      store: new Store(new Database(':memory:')),
      providerFor: () => { throw new Error('no machine in this test'); },
      defaultBase: 'hatchabot-runtime:latest',
      dataDir: join(dir, 'data'),
      notify: async () => {},
      log: { info: () => {}, error: () => {} },
      baseLogGraceMs: 300,
    });
    const was = process.env.PATH;
    process.env.PATH = join(dir, 'bin');
    try {
      images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
      await until(() => reads > 0 && !images.baseBuildNow().running, 5000);
      expect(reads).toBe(1);
      expect(images.baseBuildNow()).toMatchObject({ running: false, ok: false, error: 'The build stopped with code 3; see its log.' });
    } finally {
      process.env.PATH = was;
      spy.mockRestore();
      images.stop();
    }
  }, 10_000);
});

describe("a derived build's stop and log leftovers (HB-1292)", () => {
  it('a build whose image took its tag is READY, though the service stops while its log is still being written', async () => {
    // docker has built, the image is checked and named, and the log's last
    // write has not finished (its grace, up to 10 seconds). The record was
    // made READY only once the log closed: a stop of the service then left
    // it BUILDING, and the start after marked a good image failed.
    mkdirSync(join(dir, 'bin'));
    const tagged = join(dir, 'tagged');
    writeFileSync(join(dir, 'bin', 'docker'), `#!/bin/sh\ncase "$1" in tag) echo "$2 $3" > "${tagged}";; esac\n${CHECKS}\necho "the last line"\n`);
    chmodSync(join(dir, 'bin', 'docker'), 0o755);
    let held: (() => void) | undefined;
    fsHooks.write = (real, args) => {
      if (held || !(args[1] as Buffer).includes('the last line')) return real(...args);
      held = () => { held = () => {}; real(...args); };
      return undefined;
    };
    const store = new Store(new Database(':memory:'));
    const start = () => createRuntimeImages({
      store, providerFor: () => { throw new Error('no machine in this test'); }, defaultBase: 'hatchabot-runtime:latest', dataDir: join(dir, 'data'),
      notify: async () => {}, log: { info: () => {}, error: () => {} },
    });
    const images = start();
    store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: 'owner-a' });
    const was = process.env.PATH;
    process.env.PATH = join(dir, 'bin');
    try {
      images.kickImageBuild('media');
      await until(() => existsSync(tagged), 5000);
      expect(readFileSync(tagged, 'utf8')).toMatch(/ hatchabot-runtime:derived-media\n$/);
      await until(() => store.getDerivedImage('media')?.status !== 'BUILDING', 1000);
      expect(held).toBeDefined();
      expect(images.isBuilding('media')).toBe(true); // its log is still in its grace
      images.stop();
      // The start after: a build a restart cut off is marked failed, one whose image took its tag is not.
      start();
      expect(store.getDerivedImage('media')?.status).toBe('READY');
    } finally {
      process.env.PATH = was;
      held?.();
    }
  }, 10_000);

  it('a write cut short is not gone on with once the log has been let go (review of HB-1026)', async () => {
    // The rest of a partial write, after the log was let go, could land in
    // another file that had taken the log's number: it is never written.
    const p = join(dir, 'x.log');
    let fd = -1;
    const asked: number[] = [];
    let answer: (() => void) | undefined;
    fsHooks.write = (real, args) => {
      if (args[0] !== fd) return real(...args);
      asked.push(args[3] as number);
      if (asked.length > 1) return real(...args);
      // The first write takes five bytes only, and is answered once the test says so.
      const cb = args[5] as (err: Error | null, n: number) => void;
      return real(args[0], args[1], args[2], 5, args[4], (err: Error | null, n: number) => { answer = () => cb(err, n); });
    };
    const log = openBuildLog(p);
    fd = await new Promise<number>((r) => log.once('open', r));
    // Closes from here on: an earlier test's log may close late, with a number this one has taken since.
    const closed: number[] = [];
    fsHooks.close = (real, args) => { closed.push(args[0] as number); return real(...args); };
    log.write('a line of build output\n');
    await until(() => !!answer);
    log.destroy(); // let go: the build's grace is over
    expect(closed).not.toContain(fd); // not under the write in flight
    answer!();
    await until(() => closed.includes(fd));
    expect(asked).toEqual([23]);
    expect(readFileSync(p, 'utf8')).toBe('a lin');
  });
});
