import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { createRuntimeImages, type RuntimeImages } from '../src/orchestrator/machines/runtimeImages.js';
import { beginOperation, newBootForTests } from '../src/orchestrator/lifecycle/operations.js';

/**
 * The base build's log (HB-0878). It could not be opened (a directory at its
 * name, a full or read-only disk), and the write stream's error, with no
 * listener, ended the whole process. Now it fails the build, says why, and
 * starts no script; a log that fails part-way stops the script first.
 *
 * The build runs `bash scripts/build-runtime-image.sh`. Here `bash` is a shim
 * on a PATH of its own, so no real build script runs.
 */

let dir: string;
let path: string | undefined;
let images: RuntimeImages;
let told: string[];

/** A program's full path: the shim runs on a PATH that has only itself. */
const tool = (name: string) => ['/usr/bin', '/bin'].map((d) => join(d, name)).find((p) => existsSync(p)) ?? name;

function shim(body: string): void {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'bash'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, 'bash'), 0o755);
}

const logPath = () => join(dir, 'data', 'derived-builds', '_base.log');

async function settled(): Promise<ReturnType<RuntimeImages['baseBuildNow']>> {
  const until = Date.now() + 10_000;
  while (images.baseBuildNow().running) {
    if (Date.now() > until) throw new Error('the base build never ended');
    await new Promise((r) => setTimeout(r, 20));
  }
  return images.baseBuildNow();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-base-log-'));
  path = process.env.PATH;
  process.env.PATH = join(dir, 'bin');
  told = [];
  images = createRuntimeImages({
    store: new Store(new Database(':memory:')),
    providerFor: () => { throw new Error('no machine in this test'); },
    defaultBase: 'hatchabot-runtime:latest',
    dataDir: join(dir, 'data'),
    notify: async (_owner, body) => { told.push(body); },
    log: { info: () => {}, error: () => {} },
  });
});

afterEach(() => {
  images.stop();
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});

describe('the base build log (HB-0878)', () => {
  it('a log that cannot be opened fails the build, says why, and runs no script', async () => {
    shim(`${tool('touch')} "${join(dir, 'ran')}"; echo built`);
    mkdirSync(logPath(), { recursive: true }); // a directory where the log goes: EISDIR
    images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
    const b = await settled();
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/build log .*_base\.log could not be written: .*EISDIR/);
    expect(existsSync(join(dir, 'ran'))).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(told.join('\n')).toMatch(/FAILED to build/);
  });

  it.runIf(existsSync('/dev/full'))('a log that fails part-way stops the script, and the build is running until it has stopped', async () => {
    const pidFile = join(dir, 'pid');
    // The shim prints without end, as a long build does, so output is still
    // queued when the log fails: unread, it would hold the build open.
    shim(`echo $$ > "${pidFile}"; while :; do echo step; done`);
    mkdirSync(join(dir, 'data', 'derived-builds'), { recursive: true });
    symlinkSync('/dev/full', logPath()); // opens, then every write is ENOSPC
    const started = Date.now();
    images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
    const b = await settled();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/could not be written: .*ENOSPC/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).toThrow(); // gone, not left building
  }, 15_000);

  it.runIf(existsSync(tool('mkfifo')) && existsSync(tool('sleep')))('a log that fails after the script has exited, while its output is still open, still settles', async () => {
    // The script exits at once; a part it left running holds its output open
    // and prints twice more, once the test says so. The log is a named pipe
    // whose reader has gone by then, so the first of those prints fails
    // (EPIPE) after the script's exit and before its output closes. The
    // output, paused there, then held the second print unread, never reached
    // its end, and the build was running for ever. Each step waits for the
    // one before, not for a time.
    const sleep = tool('sleep');
    const pidFile = join(dir, 'pid');
    const go = join(dir, 'go');
    shim(`echo $$ > "${pidFile}"; echo first; (while [ ! -e "${go}" ]; do ${sleep} 0.05; done; echo late; ${sleep} 0.5; echo later; ${sleep} 0.5) & exit 0`);
    mkdirSync(join(dir, 'data', 'derived-builds'), { recursive: true });
    execFileSync(tool('mkfifo'), [logPath()]);
    // Read by hand, without blocking: a ReadStream keeps a read waiting on
    // the pipe, and closes only once that read has taken the next line.
    const reader = openSync(logPath(), constants.O_RDONLY | constants.O_NONBLOCK);
    let read = '';
    const buf = Buffer.alloc(4096);
    images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
    const until = Date.now() + 5_000;
    while (!read.includes('first') && Date.now() < until) {
      try { read += buf.toString('utf8', 0, readSync(reader, buf)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e; }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(read).toContain('first');
    // The script has exited and been reaped (a zombie still answers a
    // signal), so its exit has been handled before the log fails.
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(1);
    const gone = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
    while (!gone() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(gone()).toBe(true);
    closeSync(reader);
    writeFileSync(go, '');
    const b = await settled();
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/could not be written: .*EPIPE/);
  }, 15_000);

  it.runIf(process.platform === 'linux')('a script that cannot be started at all fails the build, not the process', async () => {
    // An environment value longer than Linux allows one to be (128 KB):
    // spawn throws E2BIG, where most failures to start are an 'error' event
    // instead. macOS limits only the total, so there it would start.
    shim('echo never');
    process.env.HB_TEST_TOO_LONG = 'x'.repeat(200_000);
    try {
      images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
      const b = await settled();
      expect(b.ok).toBe(false);
      expect(b.error).toMatch(/E2BIG/);
    } finally {
      delete process.env.HB_TEST_TOO_LONG;
    }
  });

  it.runIf(existsSync(tool('sleep')))('the time limit stops the whole build: a hung part the script started is ended too, and the build is over (HB-0883)', async () => {
    // The script waits for a part it started (a hung docker or npm call),
    // which holds the build's output open. Killed alone, the script went and
    // the part stayed: the output never closed, and the build was running
    // until the part ended on its own.
    const partPid = join(dir, 'part-pid');
    shim(`${tool('sleep')} 30 & echo $! > "${partPid}"; echo waiting; wait`);
    const was = process.env.HATCHABOT_BASE_BUILD_TIMEOUT_MS;
    process.env.HATCHABOT_BASE_BUILD_TIMEOUT_MS = '500';
    let part = 0;
    let ended = false;
    try {
      const started = Date.now();
      images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
      const b = await settled();
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(b).toMatchObject({ ok: false, error: 'The build ran past its time limit and was stopped.' });
      part = Number(readFileSync(partPid, 'utf8'));
      expect(part).toBeGreaterThan(1);
      // Gone, once its parent's end has let it be reaped (a zombie still answers a signal).
      const gone = () => { try { process.kill(part, 0); return false; } catch { return true; } };
      const until = Date.now() + 5_000;
      while (!gone() && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      ended = gone();
      expect(ended).toBe(true);
      expect(readFileSync(logPath(), 'utf8')).toContain('waiting');
    } finally {
      if (was === undefined) delete process.env.HATCHABOT_BASE_BUILD_TIMEOUT_MS; else process.env.HATCHABOT_BASE_BUILD_TIMEOUT_MS = was;
      if (!part && existsSync(partPid)) part = Number(readFileSync(partPid, 'utf8'));
      // Left running (the old way): ended here, by its own pid only.
      if (!ended && part > 1) try { process.kill(part, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 20_000);

  it.runIf(existsSync(tool('sleep')))('the service stopping stops the build with it: the script and what it started are ended (HB-0883)', async () => {
    // A build of its own process group outlived the service: launchd ends a
    // job's group and Ctrl-C reaches the foreground one, so the script ran on,
    // and the restarted service, not knowing, could start another onto the
    // same tag and log.
    const buildPid = join(dir, 'build-pid');
    const partPid = join(dir, 'part-pid');
    shim(`echo $$ > "${buildPid}"; ${tool('sleep')} 30 & echo $! > "${partPid}"; wait`);
    const pids: number[] = [];
    const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    try {
      images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
      const until = Date.now() + 5_000;
      while (!(existsSync(partPid) && readFileSync(partPid, 'utf8').trim()) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      pids.push(Number(readFileSync(buildPid, 'utf8')), Number(readFileSync(partPid, 'utf8')));
      expect(pids.every((p) => p > 1)).toBe(true);
      images.stop();
      const b = await settled();
      expect(b).toMatchObject({ ok: false, error: 'The build was stopped as Hatchabot stopped.' });
      const reaped = Date.now() + 5_000;
      while (!pids.every(gone) && Date.now() < reaped) await new Promise((r) => setTimeout(r, 20));
      expect(pids.filter((p) => !gone(p))).toEqual([]);
    } finally {
      // Left running (the old way): ended here, by their own pids only.
      for (const p of pids) if (p > 1 && !gone(p)) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 20_000);

  it.runIf(existsSync(tool('sleep')) && ['/bin/ps', '/usr/bin/ps'].some((p) => existsSync(p)))('a default build the process before left running as it died is stopped at the next start, and said so (HB-1507)', async () => {
    // Under launchd a crash or a SIGKILL of the service left the build's
    // group running: the next start said it was cut off while it went on,
    // to end unseen onto the tag and log the next build takes.
    const buildPid = join(dir, 'build-pid');
    const partPid = join(dir, 'part-pid');
    shim(`echo $$ > "${buildPid}"; ${tool('sleep')} 30 & echo $! > "${partPid}"; wait`);
    const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    const pids: number[] = [];
    const file = join(dir, 'hatchabot.db');
    const deps = (store: Store) => ({
      store, providerFor: () => { throw new Error('no machine in this test'); }, defaultBase: 'hatchabot-runtime:latest', dataDir: join(dir, 'data'),
      notify: async () => {}, log: { info: () => {}, error: () => {} },
    });
    const makeDefault = { hostId: 'h1', tag: 'hatchabot-runtime:2026.9.8', latest: 'hatchabot-runtime:latest', version: '2026.9.8' };
    const opOf = (store: Store) => store.listMachineOperations(['h1']).find((o) => o.kind === 'base-build')!;
    // Another process now under a pid a record kept: one that is no build, and one that looks like one, started long after its record.
    const stray = spawn(tool('sleep'), ['30'], { detached: true, stdio: 'ignore' });
    const lookalike = spawn('/bin/sh', ['-c', `${tool('sleep')} 30; :`, 'scripts/build-runtime-image.sh'], { detached: true, stdio: 'ignore' });
    const opened: Database.Database[] = [];
    const open = () => { const db = new Database(file); opened.push(db); return new Store(db); };
    let before: RuntimeImages | undefined, after: RuntimeImages | undefined, again: RuntimeImages | undefined;
    try {
      const first = open();
      before = createRuntimeImages(deps(first));
      before.startBaseBuild({ version: '2026.9.8', candidate: false, forOwner: 'owner-a', makeDefault });
      const until = Date.now() + 5_000;
      while (!(existsSync(partPid) && readFileSync(partPid, 'utf8').trim()) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      pids.push(Number(readFileSync(buildPid, 'utf8')), Number(readFileSync(partPid, 'utf8')));
      expect(pids.every((p) => p > 1)).toBe(true);
      // Its group's leader is on the record.
      expect(opOf(first).params).toMatchObject({ pid: pids[0], pidAt: expect.any(String) });
      // The service dies without its stop: its database goes with it; the build's group runs on.
      opened[0]!.close();
      newBootForTests();
      const second = open();
      after = createRuntimeImages(deps(second));
      const said = 'The default base image build for OpenClaw 2026.9.8 was cut off by a restart, so it was not made the fleet default. It was still running after the restart, and was stopped before its end: build it again.';
      expect(after.baseBuildNow()).toMatchObject({ running: false, ok: false, error: said });
      expect(opOf(second)).toMatchObject({ status: 'failed', outcome: said });
      const reaped = Date.now() + 5_000;
      while (!pids.every(gone) && Date.now() < reaped) await new Promise((r) => setTimeout(r, 20));
      expect(pids.filter((p) => !gone(p))).toEqual([]);
      // A record whose pid is now another process's (not the build script, or not started then) stops nothing: said as cut off, as before.
      for (const [pid, pidAt] of [[stray.pid!, new Date().toISOString()], [process.pid, new Date().toISOString()], [lookalike.pid!, '2026-01-01T00:00:00.000Z']] as const) {
        beginOperation(second, 'base-build', null, { version: '2026.9.8', tag: makeDefault.tag, latest: makeDefault.latest, pid, pidAt }, { hostId: 'h1', requestedBy: 'owner-a' });
        newBootForTests();
        again?.stop();
        again = createRuntimeImages(deps(second));
        expect(again.baseBuildNow().error, String(pid)).toMatch(/^The default base image build for OpenClaw 2026\.9\.8 was cut off by a restart, so it was not made the fleet default\. If it got to its end/);
        expect([gone(stray.pid!), gone(lookalike.pid!)]).toEqual([false, false]);
      }
    } finally {
      for (const i of [before, after, again]) i?.stop();
      for (const db of opened) if (db.open) db.close();
      // Left running (the old way): ended here, by their own pids only.
      for (const p of [...pids, stray.pid ?? 0, lookalike.pid ?? 0]) if (p > 1 && !gone(p)) try { process.kill(p, 'SIGKILL'); } catch { /* gone */ }
      for (const c of [stray, lookalike]) if (c.pid) try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 20_000);

  it.runIf(existsSync(tool('setsid')) && existsSync(tool('sleep')))('a step that starts a session of its own is stopped with the build (HB-1186)', async () => {
    // setsid puts the step in a session, and so a process group, of its own:
    // the kill of the build's group did not reach it, and it ran on after
    // the service had stopped.
    const partPid = join(dir, 'part-pid');
    shim(`${tool('setsid')} ${tool('sleep')} 30 & echo $! > "${partPid}"; echo waiting; wait`);
    const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
    let part = 0;
    try {
      images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
      const until = Date.now() + 5_000;
      while (!(existsSync(partPid) && readFileSync(partPid, 'utf8').trim()) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      part = Number(readFileSync(partPid, 'utf8'));
      expect(part).toBeGreaterThan(1);
      // In a session of its own, as setsid makes it (its session id is its own pid).
      const sid = () => readFileSync(`/proc/${part}/stat`, 'utf8').replace(/^.*\) /, '').split(' ')[3];
      if (existsSync(`/proc/${part}/stat`)) {
        for (const t0 = Date.now(); sid() !== String(part) && Date.now() - t0 < 2000;) await new Promise((r) => setTimeout(r, 20));
        expect(sid()).toBe(String(part));
      }
      images.stop();
      const b = await settled();
      expect(b).toMatchObject({ ok: false, error: 'The build was stopped as Hatchabot stopped.' });
      const reaped = Date.now() + 5_000;
      while (!gone(part) && Date.now() < reaped) await new Promise((r) => setTimeout(r, 20));
      expect(gone(part)).toBe(true);
    } finally {
      // Left running (the old way): ended here, by its own pid only.
      if (part > 1 && !gone(part)) try { process.kill(part, 'SIGKILL'); } catch { /* gone */ }
    }
  }, 20_000);

  it('a log that works: success by the exit code, with the output in the log', async () => {
    shim('echo the image is built');
    images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
    const b = await settled();
    expect(b).toMatchObject({ ok: true, error: undefined });
    expect(readFileSync(logPath(), 'utf8')).toContain('the image is built');
  });

  it('a log that works: a failed script is a failure, read from its log', async () => {
    shim('echo "npm ERR! 404 Not Found - openclaw@9.9.9" >&2; exit 1');
    images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
    const b = await settled();
    expect(b.ok).toBe(false);
    expect(b.error).not.toMatch(/could not be written/);
    expect(readFileSync(logPath(), 'utf8')).toContain('npm ERR! 404');
  });

  it.runIf(existsSync(tool('yes')) && existsSync(tool('head')))('the log is capped, keeps its first and last lines, and the build before is kept beside it (HB-1190)', async () => {
    mkdirSync(join(dir, 'data', 'derived-builds'), { recursive: true });
    writeFileSync(logPath(), 'the build before\n');
    // Six megabytes of output, more than a log keeps, then why it failed.
    shim(`echo "building OpenClaw 2026.9.8"; ${tool('yes')} "#9 12.3 a line of a long build" | ${tool('head')} -n 200000; echo "✗ the build failed here"; exit 1`);
    images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
    const b = await settled();
    expect(b).toMatchObject({ ok: false, error: 'the build failed here' });
    const log = readFileSync(logPath(), 'utf8');
    expect(statSync(logPath()).size).toBeLessThanOrEqual(4 * 2 ** 20);
    expect(log).toMatch(/^building OpenClaw 2026\.9\.8\n#9 12\.3 a line/);
    expect(log).toMatch(/\[\.\.\. \d+ bytes of output left out here/);
    expect(log).toMatch(/a line of a long build\n✗ the build failed here\n$/);
    expect(readFileSync(`${logPath()}.1`, 'utf8')).toBe('the build before\n');
  }, 20_000);
});

describe('the repository the base build writes to (HB-1352)', () => {
  it("is the fleet's, the one the image list and its guards read, whatever HATCHABOT_IMAGE_REPO says in the service's environment", async () => {
    // The shim says which repository the script was told, and the image it was given.
    const said = join(dir, 'said');
    shim(`echo "\${HATCHABOT_IMAGE_REPO-unset} \${HATCHABOT_IMAGE-unset}" > "${said}"`);
    const was = process.env.HATCHABOT_IMAGE_REPO;
    try {
      // An ordinary install: the script is told the repository it read for itself (its own
      // dry run says it builds there either way: scriptsBuildRuntimeImage.test.ts, HB-1352).
      delete process.env.HATCHABOT_IMAGE_REPO;
      images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
      expect((await settled()).ok).toBe(true);
      expect(readFileSync(said, 'utf8').trim().split(' ')[0]).toBe('hatchabot-runtime');
      // Set where the service runs: the fleet's default still says where its images are.
      process.env.HATCHABOT_IMAGE_REPO = 'elsewhere.example/other-runtime';
      images.stop();
      images = createRuntimeImages({
        store: new Store(new Database(':memory:')),
        providerFor: () => { throw new Error('no machine in this test'); },
        defaultBase: 'registry.example:5000/family/runtime:2026.9.8',
        dataDir: join(dir, 'data'),
        notify: async () => {},
        log: { info: () => {}, error: () => {} },
      });
      images.startBaseBuild({ candidate: true, forOwner: 'owner-a' });
      expect((await settled()).ok).toBe(true);
      expect(readFileSync(said, 'utf8').trim().split(' ')[0]).toBe('registry.example:5000/family/runtime');
    } finally {
      if (was === undefined) delete process.env.HATCHABOT_IMAGE_REPO; else process.env.HATCHABOT_IMAGE_REPO = was;
    }
  });
});
