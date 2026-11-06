import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { agentArchiveName, BACKUP_LOCK, backupRunning, dropMoveCopy, pruneBackup, newMoveCopy, recoverBackupRestore, restoreAgentFromBackup, RestoreError, restoreSafetyDir, resumeBackupRestore, sweepMoveCopies } from '../src/orchestrator/backups.js';
import { moveAgentToHost } from '../src/orchestrator/moveHost.js';
import { SimulatedCrash } from '../src/orchestrator/operations.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { isDiskFull, OneShotNotGoneError, ProviderError, VolumeGoneError, VolumeUntouchedError } from '../src/providers/provider.js';
import { Store } from '../src/store/store.js';
import { makeWorld, seedRunningAgent } from './support/world.js';

/**
 * A copy of a volume goes through a private file, not one Buffer: a restore
 * was refused past about 1 GB compressed because its safety copy could not be
 * held, and a move likewise (HB-0066). The stub docker below stands in for the
 * daemon; nothing here reaches a real one.
 */

/** A file the next createWriteStream of `.part` turns into a full disk, once. */
const fullDisk = vi.hoisted(() => ({ on: false }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    createWriteStream: (p: string, o: never) => {
      if (!fullDisk.on) return real.createWriteStream(p, o);
      real.writeFileSync(p, 'half an archive', { mode: 0o600 });
      return new Writable({ write(_c, _e, cb) { cb(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })); } });
    },
  };
});

// Every test here runs a stub docker (a shell script): give a busy machine room.
vi.setConfig({ testTimeout: 30_000 });

const root = mkdtempSync(join(tmpdir(), 'acl-statefile-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** The local calendar day `back` days ago, as the backup script names its set (`date +%F`). */
const localDay = (back: number) => { const d = new Date(); d.setDate(d.getDate() - back); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fresh = () => { const d = join(root, String(n++)); mkdirSync(d); return d; };
const REF = 'docker://hatchabot-kitchen-helper-df918a55';

function dockerStub(d: string, onRun: string) {
  const log = join(d, 'argv.log');
  const bin = join(d, 'docker');
  writeFileSync(bin, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = run ]; then prev=; for a in "$@"; do [ "$prev" = --cidfile ] && printf f00dfeed > "$a"; prev=$a; done # docker writes the id once it has made the one-shot
${onRun}
fi
exit 0
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { p: new LocalDockerProvider({ docker: bin, image: 'test-image:latest' }), argv: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

/**
 * A docker that keeps one-shots as docker does, without --rm: one file per
 * container in `containers/`, holding status|startedAt|volume|rw|label. `made
 * [status] [startedAt]` is docker making the run's one-shot: it writes the id
 * to `--cidfile` (before it starts it) and keeps the container until `rm`.
 * `container inspect` (status and start, or a volume's mount mode), `ps`
 * (honouring --filter volume=, label= and status=) and `rm` read them back.
 * `run`, `rm`, `inspect` and `ps` replace what each does by default; `$st` is
 * the file of the container a command names, `$M` a folder for the test's
 * own marks. Anything before the command (`-H <host>`) is skipped.
 */
function cidDocker(d: string, body: { run: string; rm?: string; inspect?: string; ps?: string }) {
  const log = join(d, 'argv.log');
  const bin = join(d, 'docker');
  const C = join(d, 'containers');
  mkdirSync(C, { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
[ "$1" = -H ] && shift 2
C=${JSON.stringify(C)}; M=${JSON.stringify(d)}
cid=; name=; vol=; rw=true; label=; fmt=; prev=; vf=; lf=; sf=
for a in "$@"; do
  case "$prev" in
    --cidfile) cid=$a ;; --name) name=$a ;; --label) label=$a ;; --format) fmt=$a ;;
    -v) vol=\${a%:/*}; case "$a" in *:ro) rw=false ;; esac ;;
    --filter) case "$a" in volume=*) vf=\${a#volume=} ;; label=*) lf=\${a#label=} ;; status=*) sf="$sf \${a#status=} " ;; esac ;;
  esac
  prev=$a
done
if [ "$1" = run ]; then st="$C/$name"; else st="$C/\${@: -1}"; fi
made() { [ -z "$cid" ] || printf 'f00dfeed%056d' 0 > "$cid"; printf '%s|%s|%s|%s|%s\\n' "\${1:-running}" "\${2:-2026-11-06T08:00:00.000000000Z}" "$vol" "$rw" "$label" > "$st"; }
gone() { echo "Error response from daemon: No such container: \${@: -1}" >&2; exit 1; }
field() { cut -d"|" -f"$1" "$2"; }
dflt_rm() { miss=0; for n in "$@"; do case "$n" in rm|-f) continue ;; esac; if [ -f "$C/$n" ]; then rm -f "$C/$n"; else echo "Error response from daemon: No such container: $n" >&2; miss=1; fi; done; exit $miss; }
dflt_inspect() {
  shift 4; miss=0
  for n in "$@"; do
    if [ ! -f "$C/$n" ]; then echo "Error: No such container: $n" >&2; miss=1; continue; fi
    case "$fmt" in
      *.Mounts*) mv=\${fmt#*eq .Name \\"}; mv=\${mv%%\\"*}; if [ "$(field 3 "$C/$n")" = "$mv" ]; then echo "/$n|$(field 4 "$C/$n")"; else echo "/$n|"; fi ;;
      *) echo "$(field 1 "$C/$n")|$(field 2 "$C/$n")" ;;
    esac
  done
  exit $miss
}
dflt_ps() {
  for f in "$C"/*; do
    [ -f "$f" ] || continue; n=\${f##*/}; case "$n" in *.*) continue ;; esac
    [ -z "$vf" ] || [ "$(field 3 "$f")" = "$vf" ] || continue
    [ -z "$lf" ] || [ "$(field 5 "$f")" = "$lf" ] || continue
    [ -z "$sf" ] || case "$sf" in *" $(field 1 "$f") "*) ;; *) continue ;; esac
    case "$*" in *" -aq"*|*" -q"*) echo "$n" ;; *) echo "$n|$(field 1 "$f")" ;; esac
  done
}
case "$1" in
  run) ${body.run} ;;
  rm) ${body.rm ?? 'dflt_rm "$@"'} ;;
  container) ${body.inspect ?? 'dflt_inspect "$@"'} ;;
  ps) ${body.ps ?? 'dflt_ps "$@"'} ;;
esac
exit 0
`, { mode: 0o755 });
  return {
    bin,
    argv: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    /** The containers it holds, by name. */
    left: () => readdirSync(C).filter((n) => !n.includes('.')),
    /** A container made outside the test's own run (another call, the nightly backup). */
    seed: (name: string, status: string, volume: string, rw: boolean, label = 'hatchabot.oneshot=hatchabot') =>
      writeFileSync(join(C, name), `${status}|2026-11-06T08:00:00.000000000Z|${volume}|${rw}|${label}\n`),
  };
}
const NO_SPACE = 'echo "docker: Error response from daemon: mkdir /var/lib/docker/overlay2/f00d-init: no space left on device." >&2; exit 125';
const LOST = 'made; cat >/dev/null; echo "error waiting for container: unexpected EOF" >&2; exit 125';
const NO_DAEMON = 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1';
/** Made, then refused at start: the disk filled writing its hostname file. */
const NO_START = 'made created 0001-01-01T00:00:00Z; echo "docker: Error response from daemon: failed to create task for container: write /var/lib/docker/containers/f00d/hostname: no space left on device." >&2; exit 125';

describe('exportStateToFile', () => {
  it('streams the archive into an owner-only file, with the same excludes and a read-only mount', async () => {
    const d = fresh();
    const { p, argv } = dockerStub(d, `head -c 5000000 /dev/zero; exit 0`);
    const file = join(d, 'copy.tgz');
    await p.exportStateToFile(REF, file);
    expect(statSync(file).size).toBe(5_000_000);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.part`)).toBe(false);
    expect(argv()).toMatch(/^volume inspect /m);
    expect(argv()).toMatch(/run --rm .*hatchabot-kitchen-helper-df918a55-vol:\/vol:ro alpine tar cz .*--exclude/);
  });

  it('a docker that fails half-way leaves no file, and its one-shot is removed', async () => {
    const d = fresh();
    const { p, argv } = dockerStub(d, `printf 'partial'; echo 'tar: read error' >&2; exit 7`);
    const file = join(d, 'copy.tgz');
    await expect(p.exportStateToFile(REF, file)).rejects.toThrow(/\(7\): tar: read error/);
    expect(readdirSync(d).filter((f) => f.startsWith('copy'))).toEqual([]);
    expect(argv()).toMatch(/^rm -f hatchabot-/m);
  });

  it('an archive with nothing in it is not taken for a copy', async () => {
    const d = fresh();
    const { p } = dockerStub(d, `exit 0`);
    const file = join(d, 'copy.tgz');
    await expect(p.exportStateToFile(REF, file)).rejects.toThrow(/wrote nothing/);
    expect(readdirSync(d).filter((f) => f.startsWith('copy'))).toEqual([]);
  });

  it('a full disk says so, and takes the half-written file and the one-shot with it', async () => {
    const d = fresh();
    const { p, argv } = dockerStub(d, `head -c 1000000 /dev/zero; sleep 30`);
    const file = join(d, 'copy.tgz');
    fullDisk.on = true;
    try {
      const err = await p.exportStateToFile(REF, file).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(isDiskFull(err)).toBe(true);
      expect(err.userMessage).toMatch(/disk is full/);
    } finally { fullDisk.on = false; }
    expect(readdirSync(d).filter((f) => f.startsWith('copy'))).toEqual([]);
    expect(argv()).toMatch(/^rm -f hatchabot-/m);
  });

  it('a file it cannot create fails without leaving the one-shot', async () => {
    const d = fresh();
    const { p, argv } = dockerStub(d, `printf x; sleep 30`);
    await expect(p.exportStateToFile(REF, join(d, 'no-such-folder', 'copy.tgz'))).rejects.toBeInstanceOf(ProviderError);
    expect(argv()).toMatch(/^rm -f hatchabot-/m);
  });

  it('a volume that is gone is said, and nothing is made', async () => {
    const d = fresh();
    const bin = join(d, 'docker');
    const log = join(d, 'argv.log');
    writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nif [ "$1" = volume ]; then echo "get x-vol: no such volume" >&2; exit 1; fi\nexit 0\n`, { mode: 0o755 });
    await expect(new LocalDockerProvider({ docker: bin }).exportStateToFile(REF, join(d, 'copy.tgz'))).rejects.toBeInstanceOf(VolumeGoneError);
    expect(readFileSync(log, 'utf8')).not.toMatch(/^run /m);
  });
});

describe('importStateFromFile', () => {
  /**
   * Runs the import's real script in a sandbox folder, as backlogRuntime.test.ts
   * does: staged, checked and extracted for real, with the step that empties
   * the volume and the chown left out, so a slip here cannot delete anything.
   * That the delete comes only after the checks is asserted from the script.
   */
  function sandboxed(d: string, vol: string) {
    const bin = join(d, 'docker');
    writeFileSync(bin, `#!/usr/bin/env bash
[ "$1" = run ] || exit 0 # rm -f of the one-shot, and the like: done
prev=; for a in "$@"; do [ "$prev" = --cidfile ] && printf f00dfeed > "$a"; prev=$a; done # docker writes the id once it has made the one-shot
script="\${@: -1}"
script="\${script//find \\/vol -mindepth 1 -delete/true}"
script="\${script//\\/vol/${vol}}"
script="\${script//\\/tmp\\/s./${d}/s.}"
script="\${script//chown -R 1000:1000/true}"
case "$script" in *" /vol"*|*"/tmp/s."*) echo "unsandboxed path" >&2; exit 9;; esac
exec sh -c "$script"
`, { mode: 0o755 });
    return bin;
  }
  function archive(d: string, big: boolean): string {
    const from = join(d, 'from');
    mkdirSync(join(from, '.openclaw'), { recursive: true });
    writeFileSync(join(from, '.openclaw', 'openclaw.json'), big ? 'x'.repeat(64 * 1024) : '{}');
    const file = join(d, 'copy.tgz');
    execFileSync('tar', ['czf', file, '-C', from, '.']);
    return file;
  }

  it('the script\'s own early exits, and a one-shot docker never made, prove the volume untouched; a 125 from one it made does not', async () => {
    const d = fresh();
    const file = archive(d, false);
    const tryWith = async (run: string, ownCopy = false) => {
      const s = cidDocker(fresh(), { run });
      const err = await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).importStateFromFile('kitchen-helper-df918a55', file, { ownCopy }).catch((e) => e);
      return { err, argv: s.argv(), left: s.left().length > 0 };
    };
    // Made, then lost while it may be extracting (the daemon restarted, a runner's link dropped).
    const lost = await tryWith(LOST);
    expect(lost.err).toBeInstanceOf(ProviderError);
    expect(lost.err).not.toBeInstanceOf(VolumeUntouchedError);
    expect(lost.left).toBe(false); // removed by the call
    expect((await tryWith('cat >/dev/null; exit 5')).err).toBeInstanceOf(VolumeUntouchedError);
    // Refused at create on a full disk: docker never wrote an id, so it never started it (HB-0384).
    const refused = await tryWith(NO_SPACE);
    expect(refused.err).toBeInstanceOf(VolumeUntouchedError);
    expect(isDiskFull(refused.err)).toBe(true);
    expect(refused.argv).not.toMatch(/^run --rm/m); // its container stays until this call removes it
    const cid = /--cidfile (\S+)/.exec(refused.argv)?.[1];
    expect(cid).toBeTruthy();
    expect(existsSync(dirname(cid!))).toBe(false); // its folder goes with the call
    // An id file docker began and never filled is no id either.
    expect((await tryWith('[ -z "$cid" ] || : > "$cid"; exit 125')).err).toBeInstanceOf(VolumeUntouchedError);
    // An id, and no container to ask (something else removed it): it may have run.
    const idOnly = await tryWith('[ -z "$cid" ] || printf f00d > "$cid"; exit 125');
    expect(idOnly.err).toBeInstanceOf(ProviderError);
    expect(idOnly.err).not.toBeInstanceOf(VolumeUntouchedError);
    // No id because something emptied its folder (logind clears /dev/shm at the last logout): not proof.
    const cleared = await tryWith('rm -rf "$(dirname "$cid")"; exit 125');
    expect(cleared.err).not.toBeInstanceOf(VolumeUntouchedError);
    // An agent's own copy going back gets no id file, and its 125 is not taken as untouched.
    const own = await tryWith(NO_SPACE, true);
    expect(own.argv).not.toMatch(/--cidfile/);
    expect(own.err).not.toBeInstanceOf(VolumeUntouchedError);
  });

  it('a one-shot docker made and could not start never ran: untouched, and removed (HB-0384)', async () => {
    for (const ownCopy of [false, true]) {
      const d = fresh();
      const s = cidDocker(d, { run: NO_START });
      const err = await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).importStateFromFile('kitchen-helper-df918a55', archive(d, false), { ownCopy }).catch((e) => e);
      expect(err).toBeInstanceOf(VolumeUntouchedError);
      expect(isDiskFull(err)).toBe(true);
      expect(s.left()).toEqual([]);
    }
  });

  it('a finished import removes its own one-shot, without holding the caller', async () => {
    const d = fresh();
    const s = cidDocker(d, { run: 'made exited; cat >/dev/null' });
    await new LocalDockerProvider({ docker: s.bin }).importStateFromFile('kitchen-helper-df918a55', archive(d, false));
    for (let i = 0; i < 100 && s.left().length; i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.left()).toEqual([]);
    expect(s.argv()).toMatch(/^rm -f hatchabot-io-/m);
  });

  it('a docker that cannot make the id file imports as before, without one (HB-0384)', async () => {
    // Docker exits 126 for "permission denied" and 127 for "no such file or directory" here, not 125.
    for (const [code, why] of [[126, 'permission denied'], [127, 'no such file or directory']] as const) {
      const d = fresh();
      const landed = join(d, 'landed');
      const s = cidDocker(d, { run: `if [ -n "$cid" ]; then echo "docker: failed to create the container ID file: open $cid: ${why}" >&2; exit ${code}; fi; cat >/dev/null; touch ${JSON.stringify(landed)}` });
      await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).importStateFromFile('kitchen-helper-df918a55', archive(d, false));
      expect(existsSync(landed)).toBe(true);
      const runs = s.argv().split('\n').filter((l) => l.startsWith('run '));
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatch(/--cidfile/);
      expect(runs[1]).not.toMatch(/--cidfile/);
    }
  });

  it('a docker that cannot reach its daemon (exit 1, no id) made nothing: untouched, not "not gone" (HB-0384)', async () => {
    const DROP = 'cat >/dev/null; echo "error during connect: Get \\"http://docker.example.com/_ping\\": command [ssh ...] has exited with exit status 255" >&2; exit 1';
    const DOWN = 'echo "error during connect: command [ssh ...] has exited with exit status 255" >&2; exit 1';
    // On this machine, and on a runner whose link drops once the import has begun.
    for (const runner of [false, true]) {
      const d = fresh();
      const s = cidDocker(d, { run: DROP, rm: DOWN, inspect: DOWN });
      const p = runner
        ? new LocalDockerProvider({ docker: s.bin, host: 'ssh://runner.invalid', reapRetryMs: 10, reachProbe: async () => true })
        : new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 });
      const err = await p.importStateFromFile(REF, archive(d, false)).catch((e) => e);
      expect(err).toBeInstanceOf(VolumeUntouchedError);
      expect(err).not.toBeInstanceOf(OneShotNotGoneError);
    }
  });

  it('a one-shot first seen created and then running may have begun: not untouched (HB-0384)', async () => {
    const d = fresh();
    const s = cidDocker(d, {
      run: 'made created 0001-01-01T00:00:00Z; cat >/dev/null; exit 125',
      inspect: 'if [ -f "$M/looked" ]; then echo "running|2026-11-06T08:00:01.000000000Z"; else touch "$M/looked"; echo "created|0001-01-01T00:00:00Z"; fi',
      rm: 'if [ -f "$M/tried" ]; then dflt_rm "$@"; else touch "$M/tried"; echo "error during connect" >&2; exit 1; fi',
    });
    const err = await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).importStateFromFile(REF, archive(d, false)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(VolumeUntouchedError);
  });

  it('the copy of the archive a one-shot stages goes with it, however the script ends', async () => {
    const d = fresh();
    const vol = join(d, 'vol');
    mkdirSync(vol);
    const bin = sandboxed(d, vol);
    const junk = join(d, 'junk.tgz');
    writeFileSync(junk, 'not a gzip');
    await expect(new LocalDockerProvider({ docker: bin }).importStateFromFile('kitchen-helper-df918a55', junk)).rejects.toThrow(/volume import failed/);
    await new LocalDockerProvider({ docker: bin }).importStateFromFile('kitchen-helper-df918a55', archive(d, false));
    expect(readdirSync(d).filter((f) => f.startsWith('s.'))).toEqual([]);
  });

  it('a listing that fails once is asked again, not taken as a refusal', async () => {
    const d = fresh();
    const s = cidDocker(d, { run: 'cat >/dev/null', ps: 'if [ -f "$M/listed" ]; then dflt_ps "$@"; else touch "$M/listed"; echo "error during connect" >&2; exit 1; fi' });
    expect(await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).stopVolumeWriters(REF)).toBeUndefined();
    expect(s.argv().match(/^ps /gm)).toHaveLength(2);
  });

  it('"never ran" counts only from the look in the same try as the removal', async () => {
    const d = fresh();
    const s = cidDocker(d, {
      run: 'made created 0001-01-01T00:00:00Z; cat >/dev/null; exit 125',
      inspect: `if [ -f "$M/looked" ]; then ${NO_DAEMON}; else touch "$M/looked"; echo "created|0001-01-01T00:00:00Z"; fi`,
      rm: 'if [ -f "$M/tried" ]; then dflt_rm "$@"; else touch "$M/tried"; echo "error during connect" >&2; exit 1; fi',
    });
    const err = await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).importStateFromFile(REF, archive(d, false)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(VolumeUntouchedError);
  });

  it('a backup removed while the restore waited changes nothing, and says so', async () => {
    const d = fresh();
    const file = archive(d, false);
    // The set goes while an earlier copy is being looked for.
    const s = cidDocker(d, { run: 'cat >/dev/null', ps: `rm -f ${JSON.stringify(file)}; dflt_ps "$@"` });
    const err = await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).importStateFromFile(REF, file).catch((e) => e);
    expect(err).toBeInstanceOf(VolumeUntouchedError);
    expect(err.userMessage).toMatch(/no longer on disk.*nothing was changed/);
    expect(s.argv()).not.toMatch(/^run /m);
  });

  it('a restore\'s check leaves readers running: the nightly backup, a Download (HB-0385)', async () => {
    const d = fresh();
    const s = cidDocker(d, { run: 'cat >/dev/null' });
    const vol = 'hatchabot-kitchen-helper-df918a55-vol';
    s.seed('hatchabot-bk-4242-17', 'running', vol, false); // tonight's backup, read-only
    s.seed('hatchabot-fs-0a0a0a0a0a0a', 'running', vol, false); // a Download
    s.seed('hatchabot-io-0b0b0b0b0b0b', 'running', vol, true); // a copy left writing
    s.seed('hatchabot-io-0c0c0c0c0c0c', 'exited', vol, true); // finished, never removed
    s.seed('hatchabot-io-0d0d0d0d0d0d', 'running', 'hatchabot-garden-0e0e0e0e-vol', true); // another agent's
    s.seed('other-io-0f0f0f0f0f0f', 'running', vol, true, 'hatchabot.oneshot=other'); // another install's
    expect(await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).stopVolumeWriters(REF)).toBeUndefined();
    for (let i = 0; i < 100 && s.left().includes('hatchabot-io-0c0c0c0c0c0c'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(s.left().sort()).toEqual(['hatchabot-bk-4242-17', 'hatchabot-fs-0a0a0a0a0a0a', 'hatchabot-io-0d0d0d0d0d0d', 'other-io-0f0f0f0f0f0f']);
  });

  it('a runner that does not answer starts nothing, and says the volume is untouched (HB-0384)', async () => {
    const d = fresh();
    const s = cidDocker(d, { run: 'cat >/dev/null' });
    const p = new LocalDockerProvider({ docker: s.bin, host: 'ssh://runner.invalid', reachProbe: async () => false });
    const err = await p.importStateFromFile('kitchen-helper-df918a55', archive(d, false)).catch((e) => e);
    expect(err).toBeInstanceOf(VolumeUntouchedError);
    expect(err.userMessage).toMatch(/isn't answering/);
    expect(s.argv()).not.toMatch(/ run /);
  });

  it('a failed one-shot that cannot be shown gone is said so, after trying again (HB-0385)', async () => {
    const d = fresh();
    const s = cidDocker(d, { run: LOST, rm: NO_DAEMON, inspect: NO_DAEMON });
    const err = await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).importStateFromFile('kitchen-helper-df918a55', archive(d, false)).catch((e) => e);
    expect(err).toBeInstanceOf(OneShotNotGoneError);
    const name = /--name (\S+)/.exec(s.argv())![1]!;
    expect(err.oneShot).toBe(name);
    expect(err.message).toMatch(/could not be confirmed gone/);
    expect(s.argv().match(new RegExp(`^container inspect .* ${name}$`, 'gm'))).toHaveLength(3);
  });

  it('a one-shot whose removal was under way and then is not there is gone (HB-0385)', async () => {
    const d = fresh();
    const s = cidDocker(d, {
      run: LOST,
      rm: 'echo "Error response from daemon: removal of container f00d is already in progress" >&2; exit 1',
      inspect: '[ ! -f "$M/seen" ] || gone "$@"; touch "$M/seen"; echo "removing|2026-11-06T08:00:00Z"',
    });
    const err = await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).importStateFromFile('kitchen-helper-df918a55', archive(d, false)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(OneShotNotGoneError);
    expect(s.argv().match(/^rm -f /gm)).toHaveLength(1);
  });

  it('one that could not be removed but has finished writes nothing more: not "not gone" (HB-0385)', async () => {
    const d = fresh();
    const s = cidDocker(d, { run: 'made exited; cat >/dev/null; exit 1', rm: NO_DAEMON });
    const err = await new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 }).importStateFromFile('kitchen-helper-df918a55', archive(d, false)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).not.toBeInstanceOf(OneShotNotGoneError);
    expect(err).not.toBeInstanceOf(VolumeUntouchedError);
  });

  it('a runner whose link drops: each try asks again whether it answers, not the "down" it remembers (HB-0385)', async () => {
    const d = fresh();
    // The import's one-shot is lost; the first look at it fails (the link dropped).
    const s = cidDocker(d, { run: 'touch "$M/ran"; sleep 0.3; made; cat >/dev/null; exit 125', inspect: '[ -f "$M/asked" ] || { touch "$M/asked"; echo "error during connect" >&2; exit 1; }; dflt_inspect "$@"', rm: '[ -f "$M/asked2" ] || { touch "$M/asked2"; echo "error during connect" >&2; exit 1; }; dflt_rm "$@"' });
    const answers = [true, false, true, true, true];
    let probes = 0;
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    try {
      const p = new LocalDockerProvider({ docker: s.bin, host: 'ssh://runner.invalid', reapRetryMs: 10, reachProbe: async () => answers[probes++] ?? true });
      const call = p.importStateFromFile('kitchen-helper-df918a55', archive(d, false)).catch((e) => e);
      // A long extract: the "answers" it remembered has run out by the time it fails.
      for (let i = 0; i < 200 && !existsSync(join(d, 'ran')); i++) await new Promise((r) => setTimeout(r, 10));
      skew = 20_000;
      const err = await call;
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).not.toBeInstanceOf(OneShotNotGoneError);
      expect(probes).toBeGreaterThanOrEqual(3);
      expect(s.left()).toEqual([]);
    } finally { now.mockRestore(); }
  });

  it('an earlier copy still running on the volume is stopped first, or nothing starts (HB-0385)', async () => {
    const d = fresh();
    const stale = 'hatchabot-io-0000aaaa1111';
    const ps = `echo "${stale}|running"`;
    // It cannot be removed: the import does not begin, and says why.
    const stuck = cidDocker(d, { run: 'cat >/dev/null', ps, rm: NO_DAEMON, inspect: 'echo "running|2026-11-06T08:00:00Z"' });
    const err = await new LocalDockerProvider({ docker: stuck.bin, reapRetryMs: 10 }).importStateFromFile(REF, archive(d, false), { ownCopy: true }).catch((e) => e);
    expect(err).toBeInstanceOf(VolumeUntouchedError);
    expect(err.userMessage).toContain(stale);
    expect(stuck.argv()).toMatch(/^ps -a --filter volume=hatchabot-kitchen-helper-df918a55-vol --filter label=hatchabot\.oneshot=hatchabot /m);
    expect(stuck.argv()).not.toMatch(/^run /m);
    // Removed: then the import goes ahead.
    const d2 = fresh();
    const freed = cidDocker(d2, { run: 'cat >/dev/null', ps, inspect: 'echo "running|2026-11-06T08:00:00Z"' });
    await new LocalDockerProvider({ docker: freed.bin, reapRetryMs: 10 }).importStateFromFile(REF, archive(d2, false));
    const log = freed.argv();
    expect(log.indexOf(`rm -f ${stale}`)).toBeGreaterThan(-1);
    expect(log.indexOf(`rm -f ${stale}`)).toBeLessThan(log.search(/^run /m));
  });

  it('reads the file into the volume through the same checks', async () => {
    const d = fresh();
    const vol = join(d, 'vol');
    mkdirSync(vol);
    const bin = sandboxed(d, vol);
    const p = new LocalDockerProvider({ docker: bin });
    await p.importStateFromFile('kitchen-helper-df918a55', archive(d, false));
    expect(readFileSync(join(vol, '.openclaw', 'openclaw.json'), 'utf8')).toBe('{}');
  });

  it('a copy of the agent\'s own volume goes back past the limit on an untrusted archive; anything else is refused and left alone', async () => {
    const d = fresh();
    const vol = join(d, 'vol');
    mkdirSync(vol);
    writeFileSync(join(vol, 'old.md'), 'old');
    process.env.HATCHABOT_IMPORT_MAX_GB = String(16 * 1024 / 2 ** 30); // 16 KiB
    vi.resetModules();
    try {
      const { LocalDockerProvider: Fresh } = await import('../src/providers/localDockerProvider.js');
      const p = new Fresh({ docker: sandboxed(d, vol) });
      const file = archive(d, true);
      await expect(p.importStateFromFile('kitchen-helper-df918a55', file)).rejects.toThrow(/\(3\): archive expands past the size limit/);
      expect(readFileSync(join(vol, 'old.md'), 'utf8')).toBe('old');
      await p.importStateFromFile('kitchen-helper-df918a55', file, { ownCopy: true });
      expect(statSync(join(vol, '.openclaw', 'openclaw.json')).size).toBe(64 * 1024);
    } finally {
      delete process.env.HATCHABOT_IMPORT_MAX_GB;
      vi.resetModules();
    }
  });

  it('the volume is emptied only after every check, with or without the limit', async () => {
    for (const ownCopy of [false, true]) {
      const d = fresh();
      const { p, argv } = dockerStub(d, `cat > /dev/null`);
      const file = join(d, 'copy.tgz');
      writeFileSync(file, 'x');
      await p.importStateFromFile(REF, file, { ownCopy });
      const script = argv();
      expect(script.includes('expands past the size limit')).toBe(!ownCopy);
      expect(script.indexOf('gzip -t /tmp/s.tgz')).toBeGreaterThan(-1);
      expect(script.indexOf('tar tzf /tmp/s.tgz')).toBeGreaterThan(script.indexOf('gzip -t /tmp/s.tgz'));
      expect(script.indexOf('find /vol -mindepth 1 -delete')).toBeGreaterThan(script.indexOf('tar tzf /tmp/s.tgz'));
    }
  });

  it('a corrupt copy leaves the volume alone', async () => {
    const d = fresh();
    const vol = join(d, 'vol');
    mkdirSync(vol);
    writeFileSync(join(vol, 'old.md'), 'old');
    const file = join(d, 'junk.tgz');
    writeFileSync(file, 'not a gzip');
    await expect(new LocalDockerProvider({ docker: sandboxed(d, vol) }).importStateFromFile('kitchen-helper-df918a55', file)).rejects.toThrow(/volume import failed/);
    expect(readFileSync(join(vol, 'old.md'), 'utf8')).toBe('old');
  });

  it('a missing or empty file never reaches docker: an empty stdin must not get near the delete', async () => {
    const d = fresh();
    const { p, argv } = dockerStub(d, `exit 0`);
    await expect(p.importStateFromFile(REF, join(d, 'nope.tgz'))).rejects.toThrow(/ENOENT/);
    const empty = join(d, 'empty.tgz');
    writeFileSync(empty, '');
    await expect(p.importStateFromFile(REF, empty)).rejects.toThrow(/is empty/);
    expect(argv()).not.toMatch(/^run /m);
  });

  it('a disk that fills while unpacking says so', async () => {
    const d = fresh();
    const { p } = dockerStub(d, `cat > /dev/null; echo 'cat: write error: No space left on device' >&2; exit 1`);
    const file = join(d, 'copy.tgz');
    writeFileSync(file, 'x');
    const err = await p.importStateFromFile(REF, file).catch((e) => e);
    expect(err.userMessage).toMatch(/disk of the machine it runs on is full/);
    expect(isDiskFull(err)).toBe(true);
  });
});

describe('a restore keeps its safety copy on disk', () => {
  const base = mkdtempSync(join(root, 'backups-'));
  const before = process.env.HATCHABOT_BACKUP_DIR;
  beforeEach(() => { process.env.HATCHABOT_BACKUP_DIR = base; });
  // By its own path, never restoreSafetyDir(): with the setting gone that names this machine's real folder.
  afterEach(() => { process.env.HATCHABOT_BACKUP_DIR = before; for (const n of readdirSync(base)) if (n.startsWith('restore-safety')) rmSync(join(base, n), { recursive: true, force: true }); });

  async function agent(date: string, slug = 'kitchen') {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: 'x', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: slug === 'kitchen' ? 'a1' : slug, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } }, env: {} });
    store.setAgentRuntimeRef('a1', runtimeRef);
    await provider.start(runtimeRef);
    store.setAgentState('a1', 'RUNNING');
    provider.stateStore.set(runtimeRef, Buffer.from('current-memory'));
    mkdirSync(join(base, date), { recursive: true });
    writeFileSync(join(base, date, agentArchiveName(runtimeRef)), 'that-night');
    return { store, provider, runtimeRef };
  }

  it('never asks for the volume as a Buffer, whatever its size: this is what the 1 GB refusal was', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-01');
    provider.exportState = async () => { throw new Error('volume export failed: stdout maxBuffer length exceeded'); };
    let held: { mode: number; dir: number; part: boolean } | undefined;
    provider.exportStateToFile = async (_r, file) => { writeFileSync(file, 'current-memory', { mode: 0o600 }); };
    const importFile = provider.importStateFromFile.bind(provider);
    provider.importStateFromFile = async (r, file, o) => {
      const safety = readdirSync(restoreSafetyDir())[0]!;
      held = { mode: statSync(join(restoreSafetyDir(), safety)).mode & 0o777, dir: statSync(restoreSafetyDir()).mode & 0o777, part: safety.endsWith('.part') };
      return importFile(r, file, o);
    };
    await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-01');
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('that-night');
    expect(held).toEqual({ mode: 0o600, dir: 0o700, part: false });
    expect(existsSync(restoreSafetyDir())).toBe(false);
  });

  it('a rollback puts its own copy back as such: the limit on an untrusted archive must not strand it', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-02');
    const importFile = provider.importStateFromFile.bind(provider);
    const owns: Array<boolean | undefined> = [];
    provider.importStateFromFile = async (r, file, o) => {
      owns.push(o?.ownCopy);
      if (owns.length === 1) throw new Error('torn');
      return importFile(r, file, o);
    };
    const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-02').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(owns).toEqual([undefined, true]);
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
  });

  it('a full disk while copying first says so, changes nothing and takes the part-written file away', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-03');
    provider.exportStateToFile = async (_r, file) => {
      writeFileSync(`${file}.part`, 'half');
      throw new ProviderError('saving the volume export failed: ENOSPC', 'disk');
    };
    const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-03').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.userMessage).toMatch(/disk is too full.*nothing was changed.*Free some space/s);
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    expect(existsSync(restoreSafetyDir())).toBe(false);
  });

  it('a disk that fills during the extract is named, and the agent goes back', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-04');
    const importFile = provider.importStateFromFile.bind(provider);
    let calls = 0;
    provider.importStateFromFile = async (r, f, o) => {
      calls++;
      if (calls === 1) throw new Error('volume import failed (1): cat: write error: No space left on device');
      return importFile(r, f, o);
    };
    const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-04').catch((e) => e);
    expect(err.userMessage).toMatch(/disk is full — the agent was left as it was/);
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
  });

  it('a disk too full to stage the backup: the agent was never touched, so it goes back up with no re-import', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-06');
    const started: string[] = [];
    const start = provider.start.bind(provider);
    provider.start = async (r) => { started.push(r); return start(r); };
    const calls: boolean[] = [];
    provider.importStateFromFile = async (_r, _f, o) => {
      calls.push(o?.ownCopy === true);
      if (o?.ownCopy) throw new Error('volume import failed (5): cat: write error: No space left on device');
      throw new VolumeUntouchedError('volume import failed (5): cat: write error: No space left on device', 'full');
    };
    const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-06').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.userMessage).toMatch(/disk is full — the agent was left as it was/);
    expect(err.userMessage).not.toMatch(/half-restored/);
    expect(calls).toEqual([false]); // the safety copy was never staged after it
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    expect(started).toEqual([runtimeRef]);
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(existsSync(restoreSafetyDir())).toBe(false);
  });

  it('docker refusing the one-shot on a full disk leaves the agent exactly as it was (HB-0384)', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-11');
    // The restore's import goes through the real provider, to a docker that
    // refuses every one-shot at create: the backup's and the rollback's alike.
    const s = cidDocker(fresh(), { run: NO_SPACE });
    const local = new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 });
    provider.importStateFromFile = (r, f, o) => local.importStateFromFile(r, f, o);
    let opId = '';
    const err = await restoreAgentFromBackup({ store, provider, onOperation: (id) => { opId = id; } }, 'a1', '2026-09-11').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.userMessage).toMatch(/disk is full — the agent was left as it was/);
    expect(s.argv().match(/^run /gm)).toHaveLength(1); // nothing to put back, so no rollback
    const a = store.getAgent('a1')!;
    expect(a.state).toBe('RUNNING');
    expect(a.stateReason ?? '').not.toMatch(/half-restored/);
    expect((await provider.status(runtimeRef)).phase).toBe('running');
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(store.getOperation(opId)).toMatchObject({ status: 'rolled_back', outcome: expect.stringMatching(/disk is full/) });
    expect(store.eventsForOperation('a1', opId).some((e) => e.event === 'op.rolled_back' && /disk is full/.test(String(e.detail?.outcome)))).toBe(true);
    expect(existsSync(restoreSafetyDir())).toBe(false);
  });

  it('a rollback does not begin while the one-shot that failed may still be writing, and a restore again stops it first (HB-0385)', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-12');
    const d = fresh();
    const putBack = join(d, 'put-back');
    const awake = join(d, 'awake');
    // Until its machine answers again: the backup's one-shot (it carries the
    // size check) is lost after docker made it and cannot be removed; the
    // rollback's would land. Once it answers, everything works.
    const asleep = `[ -f ${JSON.stringify(awake)} ]`;
    const s = cidDocker(d, {
      run: `if ${asleep}; then cat >/dev/null; else case "$*" in *"expands past the size limit"*) ${LOST};; *) cat >/dev/null; touch ${JSON.stringify(putBack)};; esac; fi`,
      rm: `${asleep} || { ${NO_DAEMON}; }; dflt_rm "$@"`,
      inspect: `${asleep} || { ${NO_DAEMON}; }; dflt_inspect "$@"`,
    });
    const local = new LocalDockerProvider({ docker: s.bin, reapRetryMs: 10 });
    provider.importStateFromFile = (r, f, o) => local.importStateFromFile(r, f, o);
    Object.assign(provider, { stopVolumeWriters: (r: string) => local.stopVolumeWriters(r) });
    let opId = '';
    const err = await restoreAgentFromBackup({ store, provider, onOperation: (id) => { opId = id; } }, 'a1', '2026-09-12').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.userMessage).toMatch(/could not be confirmed gone, so putting it back did not begin/);
    expect(err.userMessage).not.toMatch(/left as it was/);
    expect(existsSync(putBack)).toBe(false); // never extracted alongside it
    expect(s.argv().match(/^run /gm)).toHaveLength(1);
    const stale = /--name (\S+)/.exec(s.argv())![1]!;
    const a = store.getAgent('a1')!;
    expect(a.state).toBe('FAILED');
    expect(a.stateReason).toContain(`docker rm -f ${stale}`);
    expect((await provider.status(runtimeRef)).phase).toBe('stopped');
    const kept = /kept at (\S+\.tgz)/.exec(err.userMessage)?.[1];
    expect(readFileSync(kept!, 'utf8')).toBe('current-memory');
    expect(store.getOperation(opId)?.status).toBe('failed');

    // Restore again while that one is still there and cannot be removed: nothing begins.
    const again = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-12').catch((e) => e);
    expect(again).toBeInstanceOf(RestoreError);
    expect(again.userMessage).toMatch(/did not begin — nothing was changed/);
    expect(again.userMessage).toContain(stale);
    expect(s.argv().match(/^run /gm)).toHaveLength(1);
    expect(readdirSync(restoreSafetyDir())).toEqual([basename(kept!)]); // no copy taken of a volume still being written

    // Its machine answers: the one left is removed first, then the restore goes ahead.
    writeFileSync(awake, '');
    await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-12');
    const log = s.argv();
    expect(log.lastIndexOf(`rm -f ${stale}`)).toBeLessThan(log.lastIndexOf('\nrun '));
    expect(store.getAgent('a1')!.stateReason).toMatch(/Restored from the 2026-09-12 backup — tap Retry/);
    rmSync(kept!, { force: true });
  });

  it('a runner that stops answering before the import: memory as it was, and it says the agent is stopped (HB-0384)', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-13');
    const s = cidDocker(fresh(), { run: 'cat >/dev/null' });
    const local = new LocalDockerProvider({ docker: s.bin, host: 'ssh://runner.invalid', reachProbe: async () => false });
    provider.importStateFromFile = (r, f, o) => local.importStateFromFile(r, f, o);
    provider.start = async () => { throw new ProviderError('remote docker host unreachable', "Its machine isn't answering — it may be asleep or offline."); };
    let opId = '';
    const err = await restoreAgentFromBackup({ store, provider, onOperation: (id) => { opId = id; } }, 'a1', '2026-09-13').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.userMessage).toMatch(/left as it was\. It could not be started again \(remote docker host unreachable\), so it is stopped: start it once its machine answers/);
    expect(s.argv()).not.toMatch(/(^| )run /m);
    expect(store.getAgent('a1')!.state).toBe('STOPPED');
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(store.getOperation(opId)).toMatchObject({ status: 'rolled_back', outcome: expect.stringMatching(/so it is stopped/) });
    expect(existsSync(restoreSafetyDir())).toBe(false);
  });

  it('a restore waits for a backup being made: nothing changes under tonight\'s copy (HB-0385)', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-14');
    const today = localDay(0);
    const lock = join(base, today, BACKUP_LOCK);
    const run = spawn('sleep', ['30']); // a backup run that is alive
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), String(run.pid));
    const calls: string[] = [];
    provider.exportStateToFile = async () => { calls.push('copy'); };
    try {
      const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-14').catch((e) => e);
      expect(err).toBeInstanceOf(RestoreError);
      expect(err.userMessage).toMatch(/A backup is being made right now.*nothing was changed/);
      expect(calls).toEqual([]);
      expect(store.getAgent('a1')!.state).toBe('RUNNING');
      expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    } finally { run.kill(); rmSync(join(base, today), { recursive: true, force: true }); }
    // A lock whose run is gone (killed outright) does not hold it up.
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, 'pid'), '2147483646');
    try {
      provider.exportStateToFile = async (_r, file) => { writeFileSync(file, 'current-memory', { mode: 0o600 }); };
      await expect(restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-14')).resolves.toMatchObject({ date: '2026-09-14' });
    } finally { rmSync(join(base, today), { recursive: true, force: true }); }
  });

  it('only a live run\'s recent lock on today\'s or yesterday\'s set of this install counts as a backup under way', async () => {
    const run = spawn('sleep', ['30']);
    const b = mkdtempSync(join(root, 'locks-'));
    const lockOn = (date: string, pid: number | undefined, owner?: string) => {
      mkdirSync(join(b, date, BACKUP_LOCK), { recursive: true });
      writeFileSync(join(b, date, BACKUP_LOCK, 'pid'), String(pid));
      if (owner) writeFileSync(join(b, date, '.backup-owner'), `${owner}\n`);
      return join(b, date, BACKUP_LOCK);
    };
    const clear = () => { for (const n of readdirSync(b)) rmSync(join(b, n), { recursive: true, force: true }); };
    const key = process.env.HATCHABOT_SECRET_KEY;
    try {
      lockOn(localDay(0), run.pid);
      expect(backupRunning(b)).toBe(true);
      clear(); lockOn(localDay(1), run.pid); // began before midnight
      expect(backupRunning(b)).toBe(true);
      clear(); lockOn(localDay(3), run.pid); // an old set: the script writes only today's
      expect(backupRunning(b)).toBe(false);
      clear(); lockOn(localDay(0), 1); // a pid now some other process's (EPERM), from a crash 13 hours ago
      const old = (Date.now() - 13 * 3600_000) / 1000;
      utimesSync(join(b, localDay(0), BACKUP_LOCK), old, old);
      expect(backupRunning(b)).toBe(false);
      clear(); lockOn(localDay(0), process.pid); // this process's own, from a Delete that failed
      expect(backupRunning(b)).toBe(false);
      process.env.HATCHABOT_SECRET_KEY = 'made-up-test-key-for-a-mark';
      clear(); lockOn(localDay(0), run.pid, '0123456789abcdef'); // another install's set in a shared folder
      expect(backupRunning(b)).toBe(false);
    } finally {
      if (key === undefined) delete process.env.HATCHABOT_SECRET_KEY; else process.env.HATCHABOT_SECRET_KEY = key;
      run.kill(); rmSync(b, { recursive: true, force: true });
    }
  });

  it('a Delete that cannot move its set takes its lock away again', () => {
    const b = mkdtempSync(join(root, 'prune-'));
    const date = localDay(0);
    mkdirSync(join(b, date));
    writeFileSync(join(b, date, 'hatchabot.sqlite'), '');
    chmodSync(b, 0o500); // the set cannot be moved out of the way
    try {
      expect(() => pruneBackup(date, b)).toThrow();
      expect(existsSync(join(b, date, BACKUP_LOCK))).toBe(false);
      expect(backupRunning(b)).toBe(false);
    } finally { chmodSync(b, 0o700); rmSync(b, { recursive: true, force: true }); }
  });

  it('a runner whose link drops as the import begins: the agent is as it was, not FAILED (HB-0384)', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-16');
    const DOWN = 'echo "error during connect: command [ssh ...] has exited with exit status 255" >&2; exit 1';
    const s = cidDocker(fresh(), { run: `cat >/dev/null; ${DOWN}`, rm: DOWN, inspect: DOWN });
    const local = new LocalDockerProvider({ docker: s.bin, host: 'ssh://runner.invalid', reapRetryMs: 10, reachProbe: async () => true });
    provider.importStateFromFile = (r, f, o) => local.importStateFromFile(r, f, o);
    const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-16').catch((e) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect(err.userMessage).toMatch(/the agent was left as it was/);
    expect(err.userMessage).not.toMatch(/half-restored|docker rm -f/);
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(existsSync(restoreSafetyDir())).toBe(false);
  });

  it('one restore ending leaves the folder another is about to write into', async () => {
    const a = await agent('2026-09-07');
    const b = await agent('2026-09-08', 'garden');
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const exportB = b.provider.exportStateToFile.bind(b.provider);
    let reached = () => {};
    const waiting = new Promise<void>((r) => { reached = r; });
    b.provider.exportStateToFile = async (ref, file) => { reached(); await gate; await exportB(ref, file); };
    const slow = restoreAgentFromBackup({ store: b.store, provider: b.provider }, 'a1', '2026-09-08');
    await waiting; // its folder is made, its file is not
    await restoreAgentFromBackup({ store: a.store, provider: a.provider }, 'a1', '2026-09-07');
    expect(existsSync(restoreSafetyDir())).toBe(true);
    release();
    await expect(slow).resolves.toBeTruthy();
    expect(existsSync(restoreSafetyDir())).toBe(false);
  });

  it('a volume that is gone is named, not put down to the disk', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-05');
    provider.goneVolumes.add(runtimeRef);
    const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-05').catch((e) => e);
    expect(err.userMessage).toMatch(/volume is gone.*nothing was changed.*Rebuild the agent.*then restore this backup/s);
    expect(err.userMessage).not.toMatch(/disk/);
  });

  it('a volume that is gone on a FAILED agent points at Retry, since Rebuild refuses it', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-10');
    provider.goneVolumes.add(runtimeRef);
    store.setAgentState('a1', 'FAILED');
    const err = await restoreAgentFromBackup({ store, provider }, 'a1', '2026-09-10').catch((e) => e);
    expect(err.userMessage).toMatch(/Tap Retry on the agent.*then restore this backup/s);
    expect(err.userMessage).not.toMatch(/Rebuild the agent/);
  });

  it('a restart while the copy was being written takes the part-written file away', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-06');
    let opId = '';
    let safetyFile = '';
    provider.exportStateToFile = async (_r, file) => {
      safetyFile = file;
      writeFileSync(`${file}.part`, 'half');
      throw new SimulatedCrash();
    };
    await expect(restoreAgentFromBackup({ store, provider, onOperation: (id) => { opId = id; } }, 'a1', '2026-09-06')).rejects.toBeInstanceOf(SimulatedCrash);
    expect(existsSync(`${safetyFile}.part`)).toBe(true); // a dead process tidies nothing
    await resumeBackupRestore({ store, provider }, opId);
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(existsSync(restoreSafetyDir())).toBe(false);
  });

  it('Put back and Finish on a held restore read their files, Put back as its own copy', async () => {
    const { store, provider, runtimeRef } = await agent('2026-09-07');
    let opId = '';
    const seen: Array<boolean | undefined> = [];
    const importFile = provider.importStateFromFile.bind(provider);
    provider.importStateFromFile = async () => { throw new SimulatedCrash(); }; // dies with the volume in question
    await restoreAgentFromBackup({ store, provider, onOperation: (id) => { opId = id; } }, 'a1', '2026-09-07').catch(() => {});
    provider.importStateFromFile = async (r, f, o) => { seen.push(o?.ownCopy); return importFile(r, f, o); };
    provider.exportState = async () => { throw new Error('asked for a Buffer'); };
    await resumeBackupRestore({ store, provider }, opId);
    expect(store.listOperations(['a1'])[0]!.status).toBe('held');
    await recoverBackupRestore({ store, provider }, opId, 'put-back');
    expect(seen).toEqual([true]);
    expect(provider.stateStore.get(runtimeRef)!.toString()).toBe('current-memory');
    expect(existsSync(restoreSafetyDir())).toBe(false);
  });
});

describe('a move carries the volume in a private file', () => {
  const base = mkdtempSync(join(root, 'moves-'));
  const copies = join(base, 'move-copies');
  const before = { db: process.env.HATCHABOT_DB, backups: process.env.HATCHABOT_BACKUP_DIR };
  const backupsGone = join(base, 'unmounted', 'share');
  beforeEach(() => { process.env.HATCHABOT_DB = join(base, 'hatchabot.sqlite'); process.env.HATCHABOT_BACKUP_DIR = backupsGone; });
  afterEach(() => {
    if (before.db === undefined) delete process.env.HATCHABOT_DB; else process.env.HATCHABOT_DB = before.db;
    if (before.backups === undefined) delete process.env.HATCHABOT_BACKUP_DIR; else process.env.HATCHABOT_BACKUP_DIR = before.backups;
  });

  async function moveWorld() {
    const w = await makeWorld();
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock', name: 'Runner', settings: {}, createdAt: 'now' });
    const target = new MockProvider();
    w.provider.daemonId = async () => 'daemon-source';
    target.daemonId = async () => 'daemon-target';
    const deps = { store: w.store, secrets: w.secrets, channel: { kind: 'telegram', pool: { availableCount: () => 0, owns: () => false } } as never, source: w.provider, target, sleep: async () => {} };
    return { w, target, deps };
  }

  it('owner-only while it is held, read from the file on the target, gone once the move is done', async () => {
    const { w, target, deps } = await moveWorld();
    const id = await seedRunningAgent(w, { memory: 'precious-memory' });
    w.provider.exportState = async () => { throw new Error('asked for a Buffer'); };
    w.provider.exportStateToFile = async (_r, file) => { writeFileSync(file, 'precious-memory', { mode: 0o600 }); };
    const importFile = target.importStateFromFile.bind(target);
    let seen: { file: number; dir: number } | undefined;
    target.importStateFromFile = async (r, file, o) => {
      seen = { file: statSync(file).mode & 0o777, dir: statSync(join(file, '..')).mode & 0o777 };
      return importFile(r, file, o);
    };
    const moved = await moveAgentToHost(deps as never, id, 'h2');
    expect(target.stateStore.get(moved.runtimeRef!)?.toString()).toBe('precious-memory');
    expect(seen).toEqual({ file: 0o600, dir: 0o700 });
    expect(existsSync(copies)).toBe(false);
  });

  it('gone when the export fails, and when the import does', async () => {
    const a = await moveWorld();
    const id = await seedRunningAgent(a.w);
    a.w.provider.exportStateToFile = async (_r, file) => { writeFileSync(`${file}.part`, 'half'); throw new Error('no'); };
    await expect(moveAgentToHost(a.deps as never, id, 'h2')).rejects.toThrow(/Couldn't read the agent's state/);
    expect(existsSync(copies)).toBe(false);

    const b = await moveWorld();
    const id2 = await seedRunningAgent(b.w);
    b.target.importStateFromFile = async () => { throw new Error('disk failure'); };
    await expect(moveAgentToHost(b.deps as never, id2, 'h2')).rejects.toThrow(/rolled back/);
    expect(existsSync(copies)).toBe(false);
  });

  it('one move ending leaves the folder another is about to write into, and the last one takes it', () => {
    const a = newMoveCopy(), b = newMoveCopy();
    dropMoveCopy(a);
    writeFileSync(`${b}.part`, 'state being written'); // threw ENOENT when the folder had gone
    dropMoveCopy(b);
    expect(existsSync(copies)).toBe(false);
  });

  it('goes in the data folder and never touches the backup folder, which may be a NAS that is not there (HB-0388)', async () => {
    const { w, target, deps } = await moveWorld();
    const id = await seedRunningAgent(w, { memory: 'precious-memory' });
    let held: string | undefined;
    w.provider.exportStateToFile = async (_r, file) => { held = file; writeFileSync(file, 'precious-memory', { mode: 0o600 }); };
    const moved = await moveAgentToHost(deps as never, id, 'h2');
    expect(dirname(held!)).toBe(copies);
    expect(target.stateStore.get(moved.runtimeRef!)?.toString()).toBe('precious-memory');
    expect(existsSync(backupsGone)).toBe(false);
  });

  it('a local disk too full for the copy says so, and the source is left running', async () => {
    const { w, deps } = await moveWorld();
    const id = await seedRunningAgent(w);
    w.provider.exportStateToFile = async () => { throw new ProviderError('saving the volume export failed: ENOSPC', 'disk'); };
    const err = await moveAgentToHost(deps as never, id, 'h2').catch((e) => e);
    expect(err.userMessage).toMatch(/disk is too full.*nothing was changed.*Free some space/s);
    expect(err.userMessage).not.toMatch(/Couldn't read/);
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    expect(existsSync(copies)).toBe(false);
  });

  it('a copy a dead process left is swept at boot', () => {
    const file = newMoveCopy();
    writeFileSync(file, 'secret-state');
    writeFileSync(`${file}.part`, 'half');
    expect(sweepMoveCopies()).toBe(2);
    expect(existsSync(copies)).toBe(false);
    expect(sweepMoveCopies()).toBe(0);
    dropMoveCopy(file); // nothing left: quietly nothing
  });
});
