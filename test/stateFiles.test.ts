import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { agentArchiveName, dropMoveCopy, newMoveCopy, recoverBackupRestore, restoreAgentFromBackup, RestoreError, restoreSafetyDir, resumeBackupRestore, sweepMoveCopies } from '../src/orchestrator/backups.js';
import { moveAgentToHost } from '../src/orchestrator/moveHost.js';
import { SimulatedCrash } from '../src/orchestrator/operations.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { isDiskFull, ProviderError, VolumeGoneError, VolumeUntouchedError } from '../src/providers/provider.js';
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

const root = mkdtempSync(join(tmpdir(), 'acl-statefile-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = join(root, String(n++)); mkdirSync(d); return d; };
const REF = 'docker://hatchabot-kitchen-helper-df918a55';

function dockerStub(d: string, onRun: string) {
  const log = join(d, 'argv.log');
  const bin = join(d, 'docker');
  writeFileSync(bin, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = run ]; then ${onRun}
fi
exit 0
`, { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { p: new LocalDockerProvider({ docker: bin, image: 'test-image:latest' }), argv: () => (existsSync(log) ? readFileSync(log, 'utf8') : '') };
}

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

  it('only the script\'s own early exits prove the volume untouched: docker\'s 125 may come from a one-shot already extracting', async () => {
    const d = fresh();
    const file = archive(d, false);
    const stub = (code: number) => {
      const bin = join(d, `docker${code}`);
      writeFileSync(bin, `#!/usr/bin/env bash\ncase "$1" in run) cat >/dev/null; echo "error waiting for container" >&2; exit ${code};; esac\nexit 0\n`, { mode: 0o755 });
      return new LocalDockerProvider({ docker: bin }).importStateFromFile('kitchen-helper-df918a55', file).catch((e) => e);
    };
    expect(await stub(125)).not.toBeInstanceOf(VolumeUntouchedError);
    expect(await stub(5)).toBeInstanceOf(VolumeUntouchedError);
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
