import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { inFlightCountForTests, LocalDockerProvider, resetVolumeWritersForTests, setVolumeEventSink, volumeEntriesForTests } from '../src/providers/localDockerProvider.js';
import { runtimeEventLog } from '../src/orchestrator/operations.js';
import { eventLabel } from '../src/orchestrator/eventLabels.js';
import { Store } from '../src/store/store.js';

/**
 * An everyday write to an agent's volume (a Files edit, a config write, an
 * adopt's workspace copy) looks first for a one-shot an earlier call left
 * writing there (HB-0509), as a restore's import does (HB-0385). A recording
 * docker stub that keeps its containers as files: name → status|volume|rw.
 */
let dir: string;
let C: string;
let LOG: string;
let bin: string;

function stub(over: { rm?: string; run?: string; ps?: string; inspect?: string } = {}) {
  writeFileSync(bin, `#!/usr/bin/env bash
[ "$1" = -H ] && shift 2 # a runner's: logged as a local call
printf '%s\\n' "$*" >> ${JSON.stringify(LOG)}
C=${JSON.stringify(C)}
name=; vol=; rw=true; vf=; prev=; fmt=
for a in "$@"; do
  case "$prev" in
    --name) name=$a ;; --format) fmt=$a ;;
    -v) [ -n "$vol" ] || { vol=\${a%%:*}; case "$a" in *:ro) rw=false ;; esac; } ;; # the first mount: the agent's volume
    --filter) case "$a" in volume=*) vf=\${a#volume=} ;; esac ;;
  esac
  prev=$a
done
field() { cut -d"|" -f"$1" "$2"; }
case "$1" in
  volume) exit 0 ;;
  ps)
    ${over.ps ?? ':'}
    for f in "$C"/*; do [ -f "$f" ] || continue; n=\${f##*/}; [ -z "$vf" ] || [ "$(field 2 "$f")" = "$vf" ] || continue; echo "$n|$(field 1 "$f")"; done ;;
  container)
    ${over.inspect ?? ':'}
    shift 4; gone=0
    for n in "$@"; do
      [ -f "$C/$n" ] || { echo "Error: No such container: $n" >&2; gone=1; continue; }
      case "$fmt" in *.Mounts*) echo "/$n|$(field 3 "$C/$n")" ;; *) echo "$(field 1 "$C/$n")|2026-11-06T08:00:00Z" ;; esac
    done
    exit $gone ;;
  rm) ${over.rm ?? 'for n in "$@"; do case "$n" in rm|-f) ;; *) rm -f "$C/$n" ;; esac; done'} ;;
  run) printf 'running|%s|%s\\n' "$vol" "$rw" > "$C/$name"; case " $* " in *" -i "*) cat >/dev/null ;; esac; ${over.run ?? ':'}; rm -f "$C/$name" ;;
esac
exit 0
`, { mode: 0o755 });
}
const seed = (name: string, status: string, volume: string, rw: boolean) => writeFileSync(join(C, name), `${status}|${volume}|${rw}\n`);
const left = () => readdirSync(C).sort();
const argv = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '');
const provider = () => new LocalDockerProvider({ docker: bin, image: 'test-image:latest', reapRetryMs: 10 });
// What this process knows of each volume's writers is reset before each test
// (resetVolumeWritersForTests), as a new process would start.
const AGENT = { ref: 'docker://hatchabot-kitchen-helper-a0000001', vol: 'hatchabot-kitchen-helper-a0000001-vol' };
const OTHER = { ref: 'docker://hatchabot-garden-helper-a0000002', vol: 'hatchabot-garden-helper-a0000002-vol' };
const lists = (vol: string) => argv().split('\n').filter((l) => l.startsWith(`ps -a --filter volume=${vol} `)).length;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hb-writers-'));
  C = join(dir, 'containers');
  mkdirSync(C);
  LOG = join(dir, 'argv.log');
  bin = join(dir, 'docker');
  stub();
  resetVolumeWritersForTests();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('an everyday write looks for a writer an earlier call left (HB-0509)', () => {
  it('each write removes one left writing, and leaves readers, finished ones and other volumes alone', async () => {
    const p = provider();
    const writes: Array<(ref: string) => Promise<unknown>> = [
      (ref) => p.execShellOnVolume(ref, 'echo note > /home/node/notes.md'),
      (ref) => p.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/notes.md'], Buffer.from('note')),
      (ref) => p.importWorkspace(ref, 'kitchen-helper', Buffer.from('not really a tarball')),
    ];
    for (const write of writes) {
      // Each as a new process: one a previous process left writing.
      resetVolumeWritersForTests();
      const { ref, vol } = AGENT;
      for (const c of left()) rmSync(join(C, c));
      writeFileSync(LOG, '');
      seed('hatchabot-io-0b0b0b0b0b0b', 'running', vol, true); // a copy left writing
      seed('hatchabot-fs-0a0a0a0a0a0a', 'running', vol, false); // a Download
      seed('hatchabot-io-0c0c0c0c0c0c', 'exited', vol, true); // finished: the sweep's
      seed('hatchabot-io-0d0d0d0d0d0d', 'running', 'hatchabot-garden-0e0e0e0e-vol', true); // another agent's
      await write(ref);
      expect(left()).toEqual(['hatchabot-fs-0a0a0a0a0a0a', 'hatchabot-io-0c0c0c0c0c0c', 'hatchabot-io-0d0d0d0d0d0d']);
      // Looked for first, removed, then written.
      const lines = argv().split('\n');
      const ps = lines.findIndex((l) => l.startsWith(`ps -a --filter volume=${vol} `));
      const rm = lines.findIndex((l) => l === 'rm -f hatchabot-io-0b0b0b0b0b0b');
      const run = lines.findIndex((l) => l.startsWith('run '));
      expect(ps).toBeGreaterThan(-1);
      expect(rm).toBeGreaterThan(ps);
      expect(run).toBeGreaterThan(rm);
    }
  });

  it('one that cannot be removed: nothing is written, and the answer says why', async () => {
    stub({ rm: 'echo "error during connect" >&2; exit 1' });
    const { ref: REF, vol: VOL } = AGENT;
    seed('hatchabot-io-0b0b0b0b0b0b', 'running', VOL, true);
    const p = provider();
    expect(await p.execShellOnVolume(REF, 'echo note > /home/node/notes.md')).toMatchObject({ code: 1, stderr: expect.stringMatching(/still writing to the agent's files: hatchabot-io-0b0b0b0b0b0b is still running/) });
    expect(await p.writeToVolume(REF, ['sh', '-c', 'cat > /home/node/x'], Buffer.from('x'))).toMatchObject({ code: 1, stderr: expect.stringMatching(/still writing/) });
    await expect(p.importWorkspace(REF, 'kitchen-helper', Buffer.from('x'))).rejects.toMatchObject({ userMessage: expect.stringMatching(/an earlier copy is still writing there/) });
    expect(argv()).not.toMatch(/^run /m);
    // A read goes ahead: it writes nothing.
    expect(await p.execShellOnVolume(REF, 'cat /home/node/notes.md', { readOnly: true })).toMatchObject({ code: 0 });
  });

  it('two writes of this process at once: neither removes the other', async () => {
    stub({ run: 'case "$*" in *drop*) exit 255 ;; *one*) sleep 1 ;; esac' });
    const { ref: REF } = AGENT;
    const p = provider();
    const first = p.execShellOnVolume(REF, 'echo one > /home/node/a.md');
    for (let i = 0; i < 100 && !left().length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(left()).toHaveLength(1); // the first one-shot, running
    // Meanwhile a write there is cut off, and its one-shot then ends by itself:
    // the next write looks, and must still spare the first.
    expect((await p.execShellOnVolume(REF, 'echo drop > /home/node/c.md')).code).toBe(255);
    const dropped = argv().split('\n').find((l) => l.startsWith('run ') && l.includes('drop'))?.match(/--name (\S+)/)?.[1];
    rmSync(join(C, dropped!));
    expect(left()).toHaveLength(1);
    // Another provider of the same process (a runner's is cached apart): its write is ours too.
    writeFileSync(LOG, '');
    const second = await provider().writeToVolume(REF, ['sh', '-c', 'cat > /home/node/b.md'], Buffer.from('two'));
    expect(second.code).toBe(0);
    expect(argv()).toMatch(/^ps -a /m); // it looked, and saw the first one
    expect((await first).code).toBe(0);
    expect(argv()).not.toMatch(/^rm /m);
  });
});

describe('an everyday write removes only one-shots known to write (HB-0509, sixth review)', () => {
  it("a backup's read-only export whose mount could not be inspected survives a Files edit; one whose name says nothing, that Docker answers for without its mount, refuses the write", async () => {
    // Docker does not answer how they mount the volume.
    stub({ inspect: 'case "$fmt" in *.Mounts*) echo "context deadline exceeded" >&2; exit 1 ;; esac' });
    const { ref, vol } = AGENT;
    seed('hatchabot-bk-4242-17', 'running', vol, false); // the nightly backup's
    seed('hatchabot-ex-0a0a0a0a0a0a', 'running', vol, false); // a copy being taken
    const p = provider();
    expect((await p.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/notes.md'], Buffer.from('note'))).code).toBe(0);
    expect(left()).toEqual(['hatchabot-bk-4242-17', 'hatchabot-ex-0a0a0a0a0a0a']);
    expect(argv()).not.toMatch(/^rm /m);
    // One whose name does not say it reads, that Docker answers for without saying how it mounts the volume: not removed, and nothing written.
    resetVolumeWritersForTests();
    writeFileSync(LOG, '');
    seed('hatchabot-io-0b0b0b0b0b0b', 'running', vol, true);
    stub({ inspect: 'case "$fmt" in *.Mounts*) exit 0 ;; esac' });
    expect(await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md')).toMatchObject({ code: 1, stderr: "couldn't check what else is writing to its files; try again" });
    await expect(p.importWorkspace(ref, 'kitchen-helper', Buffer.from('x'))).rejects.toMatchObject({ userMessage: expect.stringMatching(/could not be checked/) });
    expect(argv()).not.toMatch(/^(rm|run) /m);
    expect(left()).toEqual(['hatchabot-bk-4242-17', 'hatchabot-ex-0a0a0a0a0a0a', 'hatchabot-io-0b0b0b0b0b0b']);
    // Docker answers again: the known writer is removed, the readers stay, and the write goes ahead.
    stub();
    expect((await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md')).code).toBe(0);
    expect(left()).toEqual(['hatchabot-bk-4242-17', 'hatchabot-ex-0a0a0a0a0a0a']);
  });

  it("a look at the mounts that fails, or ends with no answer (as one that ran out of time does), is as a listing that failed: the write goes ahead, said once, and the look waits as long (eighth review)", async () => {
    const { ref, vol } = AGENT;
    seed('hatchabot-io-0b0b0b0b0b0b', 'running', vol, true);
    const inspects = () => argv().split('\n').filter((l) => l.startsWith('container inspect ')).length;
    const warned: Array<[string, Record<string, unknown>]> = [];
    setVolumeEventSink((e, d) => { warned.push([e, d]); });
    try {
      const p = new LocalDockerProvider({ docker: bin, image: 'test-image:latest', reapRetryMs: 10, listRetryMs: 400 });
      for (const fails of ['echo "context deadline exceeded" >&2; exit 1', 'exit 125']) {
        resetVolumeWritersForTests();
        setVolumeEventSink((e, d) => { warned.push([e, d]); });
        warned.length = 0;
        writeFileSync(LOG, '');
        stub({ inspect: `case "$fmt" in *.Mounts*) ${fails} ;; esac` });
        expect((await p.execShellOnVolume(ref, 'echo one > /home/node/a.md')).code, fails).toBe(0);
        // The retries right after it neither list nor look at the mounts again.
        expect((await p.execShellOnVolume(ref, 'echo two > /home/node/b.md')).code).toBe(0);
        expect((await p.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/c.md'], Buffer.from('three'))).code).toBe(0);
        expect(inspects(), fails).toBe(1);
        expect(lists(vol)).toBe(1);
        expect(argv().match(/^run /gm)).toHaveLength(3);
        expect(left()).toEqual(['hatchabot-io-0b0b0b0b0b0b']);
        expect(warned).toEqual([['volume.writers_unlisted', expect.objectContaining({ volume: vol, error: expect.stringMatching(/how hatchabot-io-0b0b0b0b0b0b mount its files could not be read/) })]]);
      }
      // A while later Docker answers: the writer left there is found and removed, and the write goes ahead.
      stub();
      await new Promise((r) => setTimeout(r, 450));
      expect((await p.execShellOnVolume(ref, 'echo four > /home/node/d.md')).code).toBe(0);
      expect(left()).toEqual([]);
      expect(warned).toHaveLength(1);
    } finally {
      setVolumeEventSink(() => {});
    }
  });

  it('a one-shot that ended between the listing and the look at its mount does not refuse the write: Docker said it is gone (seventh review)', async () => {
    const { ref, vol } = AGENT;
    seed('hatchabot-io-0b0b0b0b0b0b', 'running', vol, true);
    // It ends, and is removed, just as its mount is asked about.
    stub({ inspect: 'case "$fmt" in *.Mounts*) rm -f "$C/hatchabot-io-0b0b0b0b0b0b" ;; esac' });
    const p = provider();
    expect((await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md')).code).toBe(0);
    expect(argv()).toMatch(/^run /m);
    expect(argv()).not.toMatch(/^rm -f hatchabot-io-/m);
  });
});

describe('an everyday write looks only where a writer may be left (HB-0509 review)', () => {
  it('looks once after start-up, then only after a write there was given up', async () => {
    const { ref, vol } = AGENT;
    const p = provider();
    expect((await p.execShellOnVolume(ref, 'echo one > /home/node/a.md')).code).toBe(0);
    expect((await p.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/b.md'], Buffer.from('two'))).code).toBe(0);
    expect((await p.execShellOnVolume(ref, 'echo three > /home/node/c.md')).code).toBe(0);
    expect(lists(vol)).toBe(1);
    // Another provider of the process (a runner's is cached apart) knows it was looked at.
    expect((await provider().execShellOnVolume(ref, 'echo four > /home/node/d.md')).code).toBe(0);
    expect(lists(vol)).toBe(1);
    // A write there times out and its one-shot is removed: nothing is left writing, and nothing looked for.
    stub({ run: 'case "$*" in *slow*) exec sleep 3 ;; esac' });
    vi.stubEnv('HATCHABOT_DOCKER_TIMEOUT_MS', '500');
    try {
      expect(await p.execShellOnVolume(ref, 'echo slow > /home/node/e.md')).toMatchObject({ timedOut: true });
    } finally { vi.unstubAllEnvs(); }
    expect(left()).toEqual([]);
    expect((await p.execShellOnVolume(ref, 'echo five > /home/node/f.md')).code).toBe(0);
    expect(lists(vol)).toBe(1);
    // One that times out and cannot be removed (its runner gone quiet) is given up: the next write looks, once.
    stub({ run: 'case "$*" in *slow*) exec sleep 3 ;; esac', rm: 'echo "error during connect" >&2; exit 1' });
    vi.stubEnv('HATCHABOT_DOCKER_TIMEOUT_MS', '500');
    try {
      expect(await p.execShellOnVolume(ref, 'echo slow > /home/node/e.md')).toMatchObject({ timedOut: true });
    } finally { vi.unstubAllEnvs(); }
    expect(left()).toHaveLength(1);
    stub();
    expect((await p.execShellOnVolume(ref, 'echo six > /home/node/g.md')).code).toBe(0);
    expect(left()).toEqual([]);
    expect((await p.execShellOnVolume(ref, 'echo seven > /home/node/h.md')).code).toBe(0);
    expect(lists(vol)).toBe(2);
  });

  it("a listing that fails: the write goes ahead, the agent's Activity says so, writes go ahead unlooked for a while, then one looks again and finds the leftover (HB-0509 review)", async () => {
    const { ref, vol } = AGENT;
    stub({ ps: 'echo "error during connect" >&2; exit 1' });
    const store = new Store(new Database(':memory:'));
    store.insertAgent({ id: 'a1', ownerId: 'u1', name: 'Kitchen Helper', slug: 'kitchen-helper', state: 'RUNNING', aiProfileId: 'p', hostId: 'h', runtimeRef: ref, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const warned: Array<[string, Record<string, unknown>]> = [];
    setVolumeEventSink(runtimeEventLog(store, (e, d) => warned.push([e, d])));
    try {
      const p = new LocalDockerProvider({ docker: bin, image: 'test-image:latest', reapRetryMs: 10, listRetryMs: 400 });
      expect((await p.execShellOnVolume(ref, 'echo one > /home/node/a.md')).code).toBe(0);
      expect((await p.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/b.md'], Buffer.from('two'))).code).toBe(0);
      await p.importWorkspace(ref, 'kitchen-helper', Buffer.from('not really a tarball'));
      expect(argv().match(/^run /gm)).toHaveLength(3);
      // Asked once, not three times, and not again by the writes right after it.
      expect(lists(vol)).toBe(1);
      expect(warned).toEqual([['volume.writers_unlisted', { agentId: 'a1', runtimeRef: ref, volume: vol, error: expect.stringMatching(/could not be listed \(error during connect\)/) }]]);
      expect(store.lastEventFor('a1')).toMatchObject({ event: 'volume.writers_unlisted' });
      expect(eventLabel('volume.writers_unlisted', warned[0]![1])).toMatch(/could not be listed.*written anyway/);
      // A restore's own look still refuses on a failed listing.
      expect(await p.stopVolumeWriters(ref)).toMatch(/could not be listed/);
      // A while later it still fails: asked again, and not said again.
      await new Promise((r) => setTimeout(r, 450));
      const looked = lists(vol);
      expect((await p.execShellOnVolume(ref, 'echo three > /home/node/c.md')).code).toBe(0);
      expect(lists(vol)).toBe(looked + 1);
      expect(warned).toHaveLength(1);
      // Later, the listing works again, and a copy is left writing there: the check was never off for good.
      seed('hatchabot-io-0b0b0b0b0b0b', 'running', vol, true);
      stub();
      await new Promise((r) => setTimeout(r, 450));
      writeFileSync(LOG, '');
      expect((await p.execShellOnVolume(ref, 'echo four > /home/node/d.md')).code).toBe(0);
      const lines = argv().split('\n');
      const ps = lines.findIndex((l) => l.startsWith(`ps -a --filter volume=${vol} `));
      const rm = lines.findIndex((l) => l === 'rm -f hatchabot-io-0b0b0b0b0b0b');
      const run = lines.findIndex((l) => l.startsWith('run '));
      expect(ps).toBeGreaterThan(-1);
      expect(rm).toBeGreaterThan(ps);
      expect(run).toBeGreaterThan(rm);
      expect(warned).toHaveLength(1);
    } finally {
      setVolumeEventSink(() => {});
    }
  });

  it("an everyday write spares this process's own export of the same volume, and every writer is let go when its client ends: readers are never listed (HB-0509 review)", async () => {
    stub({ run: 'case "$*" in *"tar cz"*) sleep 1 ;; esac' });
    const { ref: busyRef, vol: busyVol } = AGENT;
    const p0 = provider();
    const exporting = p0.exportState(busyRef);
    for (let i = 0; i < 200 && !left().some((c) => readFileSync(join(C, c), 'utf8').startsWith(`running|${busyVol}|`)); i++) await new Promise((r) => setTimeout(r, 10));
    expect(left()).toHaveLength(1);
    writeFileSync(LOG, '');
    expect((await p0.execShellOnVolume(busyRef, 'echo one > /home/node/a.md')).code).toBe(0);
    expect(argv()).not.toMatch(/^rm -f /m);
    await exporting;
    stub();
    const { ref } = AGENT;
    const p = provider();
    const before = inFlightCountForTests();
    expect((await p.execShellOnVolume(ref, 'cat /home/node/a.md', { readOnly: true })).code).toBe(0);
    await new Promise<void>((resolve, reject) => { const s = p.streamFromVolume(ref, ['cat', '/home/node/a.md']); s.on('error', reject); s.on('end', () => resolve()); s.resume(); });
    await p.exportState(ref);
    expect((await p.execShellOnVolume(ref, 'echo one > /home/node/a.md')).code).toBe(0);
    expect((await p.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/b.md'], Buffer.from('two'))).code).toBe(0);
    await p.importWorkspace(ref, 'kitchen-helper', Buffer.from('not really a tarball'));
    expect(inFlightCountForTests()).toBe(before);
  });

  it("an everyday write is refused while this process restores the same agent's files (HB-0509 review)", async () => {
    // The restore's extract takes a while.
    stub({ run: 'case "$*" in *"find /vol"*|*"tar xz"*) sleep 1 ;; esac' });
    const { ref, vol } = AGENT;
    const p = provider();
    const archive = join(dir, 'snapshot.tar.gz');
    writeFileSync(archive, gzipSync(Buffer.from('not really a tarball')));
    const restore = p.importStateFromFile(ref, archive).catch((e: unknown) => e);
    for (let i = 0; i < 200 && !left().some((c) => readFileSync(join(C, c), 'utf8').startsWith(`running|${vol}|true`)); i++) await new Promise((r) => setTimeout(r, 10));
    expect(left()).toHaveLength(1); // the restore's one-shot, extracting
    expect(await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md')).toMatchObject({ code: 1, stderr: "a restore is running on this agent's files; try again when it ends" });
    expect(await provider().writeToVolume(ref, ['sh', '-c', 'cat > /home/node/x'], Buffer.from('x'))).toMatchObject({ code: 1, stderr: expect.stringMatching(/a restore is running/) });
    await expect(p.importWorkspace(ref, 'kitchen-helper', Buffer.from('x'))).rejects.toMatchObject({ userMessage: expect.stringMatching(/a restore is running on them/) });
    // A read goes ahead; another agent's files too.
    expect(await p.execShellOnVolume(ref, 'cat /home/node/notes.md', { readOnly: true })).toMatchObject({ code: 0 });
    expect((await p.execShellOnVolume(OTHER.ref, 'echo other > /home/node/o.md')).code).toBe(0);
    await restore;
    // Once it is over, writes go ahead again.
    expect((await p.execShellOnVolume(ref, 'echo after > /home/node/after.md')).code).toBe(0);
  });

  it("a write during the restore's own look for writers is refused (HB-0509, fifth review)", async () => {
    // The restore's look takes a while; then its archive is refused (exit 4), and its one-shot removed.
    stub({ ps: 'sleep 1', run: 'case "$*" in *"find /vol"*) exit 4 ;; esac' });
    const { ref } = AGENT;
    const p = provider();
    const archive = join(dir, 'snapshot.tar.gz');
    writeFileSync(archive, gzipSync(Buffer.from('not really a tarball')));
    const restore = p.importStateFromFile(ref, archive).catch((e: unknown) => e);
    for (let i = 0; i < 300 && !/^ps -a /m.test(argv()); i++) await new Promise((r) => setTimeout(r, 10));
    expect(argv()).not.toMatch(/^run /m);
    expect(await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md')).toMatchObject({ code: 1, stderr: expect.stringMatching(/a restore is running/) });
    expect(await restore).toBeInstanceOf(Error);
    expect(left()).toEqual([]);
    expect(inFlightCountForTests()).toBe(0);
  });

  it("an everyday write waiting on its runner when a restore starts: the restore waits for it, never both at once (HB-0509, sixth review)", async () => {
    // Each run says whether another one-shot was running on the same volume as it began, then takes a moment.
    stub({ run: `for f in "$C"/*; do [ "$f" = "$C/$name" ] && continue; case "$(cat "$f")" in "running|$vol|"*) echo "overlap $name" >> ${JSON.stringify(LOG)} ;; esac; done; sleep 0.5` });
    const { ref, vol } = AGENT;
    const host = 'ssh://runner@10.0.0.9';
    // The write's third look at its runner (the volume check, the look for writers, then its start) is held.
    let probes = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let holding = false;
    const writer = new LocalDockerProvider({ docker: bin, image: 'test-image:latest', host, reapRetryMs: 10, reachProbe: async () => { if (++probes === 3) { holding = true; await held; } return true; } });
    // The restore comes from another provider of the same process (the runner's is cached apart).
    const restorer = new LocalDockerProvider({ docker: bin, image: 'test-image:latest', host, reapRetryMs: 10, reachProbe: async () => true });
    const real = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + (skew += 40_000)); // each call asks the runner afresh
    try {
      const write = writer.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/notes.md'], Buffer.from('note'));
      for (let i = 0; i < 300 && !holding; i++) await new Promise((r) => setTimeout(r, 10));
      expect(holding).toBe(true);
      expect(argv()).toMatch(new RegExp(`^ps -a --filter volume=${vol} `, 'm'));
      expect(argv()).not.toMatch(/^run /m);
      const archive = join(dir, 'snapshot.tar.gz');
      writeFileSync(archive, gzipSync(Buffer.from('not really a tarball')));
      const restore = restorer.importStateFromFile(ref, archive);
      await new Promise((r) => setTimeout(r, 300));
      expect(argv()).not.toMatch(/^run /m); // the restore waits
      release();
      expect((await write).code).toBe(0);
      await restore;
      const runs = argv().split('\n').filter((l) => l.startsWith('run '));
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatch(/cat > \/home\/node\/notes\.md/);
      expect(argv()).not.toMatch(/^overlap /m);
      // The import's one-shot is removed after it, unawaited: seen to before the folder goes.
      for (let i = 0; i < 300 && !/^rm -f hatchabot-io-/m.test(argv()); i++) await new Promise((r) => setTimeout(r, 10));
    } finally { clock.mockRestore(); }
  });

  it('a restore that runs past 65 minutes still keeps everyday writes out, and its one-shot is not taken for a stale writer (HB-0509, sixth review)', async () => {
    stub({ run: 'case "$*" in *"find /vol"*) sleep 1.5 ;; esac' });
    const { ref, vol } = AGENT;
    const p = provider();
    const archive = join(dir, 'snapshot.tar.gz');
    writeFileSync(archive, gzipSync(Buffer.from('not really a tarball')));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const restore = p.importStateFromFile(ref, archive, { ownCopy: true });
      for (let i = 0; i < 200 && !left().some((c) => readFileSync(join(C, c), 'utf8').startsWith(`running|${vol}|true`)); i++) await new Promise((r) => setTimeout(r, 10));
      expect(left()).toHaveLength(1); // the restore's one-shot, extracting
      // An agent's own copy going back may take an hour and more.
      vi.setSystemTime(Date.now() + 66 * 60_000);
      expect(await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md')).toMatchObject({ code: 1, stderr: expect.stringMatching(/a restore is running/) });
      expect(argv()).not.toMatch(/^rm -f hatchabot-io-/m);
      await restore;
      expect((await p.execShellOnVolume(ref, 'echo after > /home/node/after.md')).code).toBe(0);
      for (let i = 0; i < 300 && !/^rm -f hatchabot-io-/m.test(argv()); i++) await new Promise((r) => setTimeout(r, 10));
    } finally { vi.useRealTimers(); }
  });

  it('a restore whose client was cut off (exit 125) keeps everyday writes out until it is removed (HB-0509, fourth review)', async () => {
    // The client goes with 125 and the one-shot stays, unpacking; removing it takes a moment.
    stub({
      run: 'case "$*" in *"find /vol"*) exit 125 ;; esac',
      rm: 'case "$*" in *hatchabot-io-*) sleep 1 ;; esac; for n in "$@"; do case "$n" in rm|-f) ;; *) rm -f "$C/$n" ;; esac; done',
    });
    const { ref } = AGENT;
    const p = provider();
    const archive = join(dir, 'snapshot.tar.gz');
    writeFileSync(archive, gzipSync(Buffer.from('not really a tarball')));
    const restore = p.importStateFromFile(ref, archive).catch((e: unknown) => e);
    // Its removal has begun.
    for (let i = 0; i < 300 && !/^rm -f hatchabot-io-/m.test(argv()); i++) await new Promise((r) => setTimeout(r, 10));
    expect(argv()).toMatch(/^rm -f hatchabot-io-/m);
    expect(left()).toHaveLength(1);
    expect(await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md')).toMatchObject({ code: 1, stderr: expect.stringMatching(/a restore is running/) });
    expect(await restore).toBeInstanceOf(Error);
    expect(left()).toEqual([]);
    // Removed: writes go ahead.
    expect((await p.execShellOnVolume(ref, 'echo after > /home/node/after.md')).code).toBe(0);
  });

  it('a write given up after a failed listing: the next write looks at once, not minutes later (HB-0509, fourth review)', async () => {
    const { ref, vol } = AGENT;
    stub({ ps: 'echo "error during connect" >&2; exit 1' });
    const p = provider(); // writes go unlooked for 5 minutes after a failed listing
    expect((await p.execShellOnVolume(ref, 'echo one > /home/node/a.md')).code).toBe(0);
    expect(lists(vol)).toBe(1);
    // The listing works again, and a write's link drops with its one-shot still writing.
    stub({ run: 'case "$*" in *drop*) exit 255 ;; esac' });
    expect((await p.execShellOnVolume(ref, 'echo drop > /home/node/b.md')).code).toBe(255);
    expect(lists(vol)).toBe(1); // before the give-up: not asked
    const dropped = left();
    expect(dropped).toHaveLength(1);
    expect((await p.execShellOnVolume(ref, 'echo two > /home/node/c.md')).code).toBe(0);
    expect(lists(vol)).toBe(2);
    expect(argv()).toMatch(new RegExp(`^rm -f ${dropped[0]}$`, 'm'));
    expect(left()).toEqual([]);
  });

  it('a runner that stops answering before a write starts: no entry is left, and nothing counts as given up (HB-0509, fourth review)', async () => {
    const { ref, vol } = AGENT;
    const answers: boolean[] = [];
    const p = new LocalDockerProvider({ docker: bin, image: 'test-image:latest', host: 'ssh://runner@10.0.0.9', reapRetryMs: 10, reachProbe: async () => answers.shift() ?? true });
    // Each call asks the runner afresh.
    const real = Date.now.bind(Date);
    let skew = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => real() + (skew += 40_000));
    try {
      // Up for the volume check and the look, down by the write's start.
      answers.push(true, true, false);
      const before = inFlightCountForTests();
      await expect(p.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/x'], Buffer.from('x'))).rejects.toThrow(/unreachable/);
      expect(inFlightCountForTests()).toBe(before);
      expect(lists(vol)).toBe(1);
      // Up for the volume check, down by the run: nothing started, so nothing to reap, and no give-up.
      writeFileSync(LOG, '');
      answers.push(true, false);
      expect(await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md')).toMatchObject({ code: 1, unreachable: true });
      expect(argv()).not.toMatch(/^(container inspect|rm) /m);
      // Up again: the next write does not look, as nothing was given up.
      expect((await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md')).code).toBe(0);
      expect(lists(vol)).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it('a write whose client exits 255 (a dropped link to a runner) with its one-shot still writing: the next write looks, and removes it first (HB-0509 review)', async () => {
    // The dropped link: the client goes, the container stays, writing.
    stub({ run: 'case "$*" in *drop*) exit 255 ;; esac' });
    const p = provider();
    const writes: Array<(ref: string) => Promise<{ code: number }>> = [
      (ref) => p.execShellOnVolume(ref, 'echo drop > /home/node/a.md'),
      (ref) => p.writeToVolume(ref, ['sh', '-c', 'cat > /home/node/drop.md'], Buffer.from('drop')),
    ];
    for (const write of writes) {
      resetVolumeWritersForTests();
      const { ref, vol } = AGENT;
      for (const c of left()) rmSync(join(C, c));
      writeFileSync(LOG, '');
      expect((await p.execShellOnVolume(ref, 'echo one > /home/node/one.md')).code).toBe(0);
      expect(lists(vol)).toBe(1);
      expect((await write(ref)).code).toBe(255);
      const dropped = left();
      expect(dropped).toHaveLength(1);
      writeFileSync(LOG, '');
      expect((await p.execShellOnVolume(ref, 'echo two > /home/node/two.md')).code).toBe(0);
      const lines = argv().split('\n');
      const ps = lines.findIndex((l) => l.startsWith(`ps -a --filter volume=${vol} `));
      const rm = lines.findIndex((l) => l === `rm -f ${dropped[0]}`);
      const run = lines.findIndex((l) => l.startsWith('run '));
      expect(ps).toBeGreaterThan(-1);
      expect(rm).toBeGreaterThan(ps);
      expect(run).toBeGreaterThan(rm);
      expect(left()).toEqual([]);
    }
    // A write whose own script failed (exit 1, 2…): an attached one-shot that
    // said so has ended, so nothing is asked about it, and nothing looked for
    // (in the stub its container is slow to go).
    stub({ run: 'case "$*" in *fails*) exit 1 ;; esac' });
    writeFileSync(LOG, '');
    resetVolumeWritersForTests();
    const { ref, vol } = AGENT;
    expect((await p.execShellOnVolume(ref, 'echo one > /home/node/one.md')).code).toBe(0);
    expect((await p.execShellOnVolume(ref, 'false # fails')).code).toBe(1);
    expect(argv()).not.toMatch(/^container inspect /m);
    expect((await p.execShellOnVolume(ref, 'echo two > /home/node/two.md')).code).toBe(0);
    expect(lists(vol)).toBe(1);
  });
});

describe("what this process keeps about a volume's writers goes with it (seventh review)", () => {
  it('a destroy that removes the volume leaves no entries for it, an archive forgets them, and a lock goes once nobody holds it', async () => {
    const p = provider();
    // A listing that failed (asked again later), and a write whose link dropped (given up).
    stub({ ps: 'echo "error during connect" >&2; exit 1', run: 'case "$*" in *drop*) exit 255 ;; esac' });
    expect((await p.execShellOnVolume(AGENT.ref, 'echo one > /home/node/a.md')).code).toBe(0);
    expect((await p.execShellOnVolume(AGENT.ref, 'echo drop > /home/node/b.md')).code).toBe(255);
    expect(volumeEntriesForTests(AGENT.vol)).toBe(2);
    // Another agent's: looked at, and a restore of it under way.
    stub({ run: 'case "$*" in *"find /vol"*) sleep 1 ;; esac' });
    expect((await p.execShellOnVolume(OTHER.ref, 'echo one > /home/node/a.md')).code).toBe(0);
    const archive = join(dir, 'snapshot.tar.gz');
    writeFileSync(archive, gzipSync(Buffer.from('not really a tarball')));
    const restore = p.importStateFromFile(OTHER.ref, archive);
    for (let i = 0; i < 200 && volumeEntriesForTests(OTHER.vol) < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(volumeEntriesForTests(OTHER.vol)).toBe(2); // looked, and locked
    // Deleted with its volume: nothing is kept for it.
    for (const c of left()) if (readFileSync(join(C, c), 'utf8').includes(`|${AGENT.vol}|`)) rmSync(join(C, c));
    await p.destroy(AGENT.ref, { purge: true });
    expect(volumeEntriesForTests(AGENT.vol)).toBe(0);
    // Forgotten while its restore runs: its lock stays until the restore ends, then goes.
    p.forgetVolumeWriters(OTHER.ref);
    expect(volumeEntriesForTests(OTHER.vol)).toBe(1);
    await restore;
    expect(volumeEntriesForTests()).toBe(0);
    for (let i = 0; i < 300 && !/^rm -f hatchabot-io-/m.test(argv()); i++) await new Promise((r) => setTimeout(r, 10));
  });
});

describe('a seed that timed out and could not be removed is a stale writer, not this process\'s own (HB-0509 review)', () => {
  beforeEach(() => { vi.stubEnv('HATCHABOT_DOCKER_IO_TIMEOUT_MS', '1000'); vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('the next write does not write beside it', async () => {
    const { LocalDockerProvider: Fresh } = await import('../src/providers/localDockerProvider.js');
    vi.spyOn(process, 'getuid').mockReturnValue(1000); // the seed bind-mounted, not streamed
    const { ref, vol } = AGENT;
    // The seed hangs past its deadline; removing a one-shot fails (a runner gone quiet).
    stub({ run: 'case "$*" in *seed.sh*) exec sleep 5 ;; esac', rm: 'echo "error during connect" >&2; exit 1' });
    const p = new Fresh({ docker: bin, image: 'test-image:latest', reapRetryMs: 10 });
    await expect(p.provision({
      agentId: 'df918a55-88cd-4d00-a17c-b8415a26ceb6', slug: 'kitchen-helper', previousRef: ref,
      workspace: { files: { 'SOUL.md': '# soul' }, configPatch: { agentId: 'kitchen-helper', authMode: 'api-key' } }, env: {},
    } as any)).rejects.toThrow();
    const seedShot = left().find((c) => readFileSync(join(C, c), 'utf8').startsWith(`running|${vol}|true`));
    expect(seedShot, argv()).toBeDefined();
    const res = await p.execShellOnVolume(ref, 'echo note > /home/node/notes.md');
    expect(res).toMatchObject({ code: 1, stderr: expect.stringContaining(`still writing to the agent's files: ${seedShot} is still running`) });
    expect(argv()).not.toMatch(/^run .*echo note/m);
  }, 20_000);
});
