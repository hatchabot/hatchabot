import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { createBackups, type Backups } from '../src/orchestrator/backups/backups.js';
import { AgentBusyError, clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { beginOperation } from '../src/orchestrator/lifecycle/operations.js';
import { SnapshotError } from '../src/orchestrator/files/snapshots.js';
import type { Agent } from '../src/domain/types.js';

/**
 * The backups service (HB-0808): an agent's snapshots, the backup sets and
 * the restore drills, driven as the routes drive them but with no HTTP
 * server. A real store on an in-memory database; backup sets made up on disk
 * in a temp folder, as backup-volumes.sh writes them; a runtime provider that
 * answers each core-file read. Nothing here runs a backup or a drill script:
 * under a test runner both refuse to start (backups.ts, drills.ts).
 */
const OWNER = 'user-owner';
const NEIGHBOUR = 'user-neighbour';

const dirs: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const env = { ...process.env };
let base = '';
beforeEach(() => {
  base = tmp('hb-bksvc-');
  process.env.HATCHABOT_BACKUP_DIR = base;
  process.env.HATCHABOT_PREFIX = 'hatchabot';
  delete process.env.HATCHABOT_BACKUP_SCRIPT;
  delete process.env.HATCHABOT_DRILL_SCRIPT;
  delete process.env.HATCHABOT_DRILL_EVERY;
});
const running: Backups[] = [];
afterEach(() => {
  for (const b of running.splice(0)) b.stop();
  vi.useRealTimers();
  process.env = { ...env };
});

/** A dated set with its archives and its record. */
const set = (date: string, vols: string[], record: Record<string, unknown> = {}) => {
  mkdirSync(join(base, date), { recursive: true });
  writeFileSync(join(base, date, 'hatchabot.sqlite'), 'db');
  for (const v of vols) writeFileSync(join(base, date, `${v}.tgz`), 'archive');
  writeFileSync(join(base, date, 'backup-status.json'), JSON.stringify({
    startedAt: `${date}T03:30:00`, finishedAt: `${date}T03:40:00`, state: 'complete', captured: vols,
    failedVolumes: [], missing: [], orphans: [], skipped: [], ...record,
  }));
};

interface World {
  store: Store;
  backups: Backups;
  /** What the core-file read answers, and a hook run on each read. */
  fileText: string;
  onRead?: () => void;
  inFlight: Set<string>;
  /** Agents being deleted (agentGone). */
  gone: Set<string>;
  archiving: Set<string>;
  warned: string[];
  traced: string[];
  /** The core-files turns, as routes.ts chains them (one at a time per agent). */
  turns: string[];
  agent(id: string, opts?: { owner?: string; state?: Agent['state']; hostId?: string }): Agent;
}

function world(opts: { drillSweepEveryMs?: number } = {}): World {
  const db = new Database(':memory:');
  const store = new Store(db);
  const secrets = new LocalSecretStore(db, Buffer.alloc(32, 7));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'remote', provider: 'mock', name: 'Laptop runner', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = { store, fileText: 'notes\n', inFlight: new Set(), gone: new Set(), archiving: new Set(), warned: [], traced: [], turns: [] } as unknown as World;
  const provider = {
    execShell: async () => { w.onRead?.(); return { code: 0, stdout: w.fileText, stderr: '' }; },
    reachable: async () => false,
  };
  const chain = new Map<string, Promise<unknown>>();
  w.backups = createBackups({
    store, secrets,
    providerFor: (hostId) => { if (hostId !== 'h1' && hostId !== 'h2') throw new Error(`no host ${hostId}`); return provider as never; },
    trace: () => (event) => { w.traced.push(event); },
    agentGone: (id) => w.gone.has(id) || !store.getAgent(id),
    withCoreFilesTurn: <T>(agentId: string, fn: () => Promise<T>) => {
      const run = (chain.get(agentId) ?? Promise.resolve()).then(() => { w.turns.push(agentId); return fn(); });
      chain.set(agentId, run.catch(() => undefined));
      return run;
    },
    channel: {} as never,
    embedder: () => undefined,
    afterStart: () => {},
    inFlight: (id) => w.inFlight.has(id),
    isArchiving: (id) => w.archiving.has(id),
    warn: (_d, event) => { w.warned.push(event); },
    drillSweepEveryMs: opts.drillSweepEveryMs ?? 0,
  });
  running.push(w.backups);
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: o.owner ?? OWNER, name: `Agent ${id}`, slug: id, state: o.state ?? 'RUNNING', aiProfileId: 'p1', hostId: o.hostId ?? 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `docker://hatchabot-${id}`,
    } as unknown as Agent);
    return store.getAgent(id)!;
  };
  return w;
}

describe('snapshots', () => {
  it('takes one by hand in its files turn, with its label', async () => {
    const w = world();
    const a = w.agent('a1');
    const snap = await w.backups.snapshots.take(a, 'before the trip');
    expect(snap.label).toBe('before the trip');
    expect(w.turns).toEqual(['a1']);
    expect(w.store.listSnapshots('a1').map((s) => s.id)).toEqual([snap.id]);
  });

  it('refuses one under a rebuild, an archive or a change that replaces its files, in those words', async () => {
    const w = world();
    const a = w.agent('a1');
    w.inFlight.add('a1');
    await expect(w.backups.snapshots.take(a, undefined)).rejects.toThrow('It is busy (a rebuild); take the snapshot when that ends.');
    w.inFlight.clear();
    w.archiving.add('a1');
    await expect(w.backups.snapshots.take(a, undefined)).rejects.toThrow('It is busy (being archived); take the snapshot when that ends.');
    w.archiving.clear();
    const op = beginOperation(w.store, 'app-update', 'a1', {});
    await expect(w.backups.snapshots.take(a, undefined)).rejects.toBeInstanceOf(SnapshotError);
    op.done('Updated.');
    // Work that does not replace its files does not hold it up.
    const other = beginOperation(w.store, 'backup-run', null, {}, { hostId: 'h1' });
    await expect(w.backups.snapshots.take(a, undefined)).resolves.toMatchObject({ reason: 'manual' });
    other.done('Backed up.');
    expect(w.store.listSnapshots('a1')).toHaveLength(1);
  });

  it('drops what it read when a rebuild began meanwhile', async () => {
    const w = world();
    const a = w.agent('a1');
    w.onRead = () => { w.inFlight.add('a1'); };
    await expect(w.backups.snapshots.take(a, undefined)).rejects.toThrow('A rebuild or restore started while the snapshot read its files; take it again.');
    expect(w.store.listSnapshots('a1')).toEqual([]);
  });

  it('a restore refuses an agent deleted or moved while it waited', async () => {
    const w = world();
    const a = w.agent('a1');
    const snap = await w.backups.snapshots.take(a, 'kept');
    w.gone.add('a1'); // being deleted
    await expect(w.backups.snapshots.restore(a, snap.id, OWNER)()).rejects.toThrow('It was deleted.');
    const b = w.agent('b1');
    const bSnap = await w.backups.snapshots.take(b, 'kept');
    w.store.setAgentHost('b1', 'h2');
    await expect(w.backups.snapshots.restore(b, bSnap.id, OWNER)()).rejects.toThrow('It moved while this waited; restore again.');
  });

  it('a restore takes the busy flag, after its files turn', async () => {
    const w = world();
    const a = w.agent('a1');
    const snap = await w.backups.snapshots.take(a, 'kept');
    markBusy('a1');
    try {
      await expect(w.backups.snapshots.restore(a, snap.id, OWNER)()).rejects.toBeInstanceOf(AgentBusyError);
    } finally { clearBusy('a1'); }
    expect(w.turns).toEqual(['a1', 'a1']);
  });

  it('deletes one unless a restore not yet finished still needs it', async () => {
    const w = world();
    const a = w.agent('a1');
    const snap = await w.backups.snapshots.take(a, 'kept');
    const op = beginOperation(w.store, 'restore-snapshot', 'a1', { snapshotId: snap.id });
    expect(w.backups.snapshots.remove('a1', snap.id)).toBe('in-use');
    op.done('Restored.');
    expect(w.backups.snapshots.remove('a1', snap.id)).toBe('deleted');
    expect(w.backups.snapshots.remove('a1', snap.id)).toBe('not-found');
  });
});

describe('backup sets', () => {
  it('lists the sets with each volume matched to a live agent of any owner, and who the newest leaves out', () => {
    const w = world();
    w.agent('a1');
    w.agent('n1', { owner: NEIGHBOUR });
    w.agent('r1', { hostId: 'h2' });
    set('2026-11-20', ['hatchabot-a1-vol', 'hatchabot-gone-vol']);
    set('2026-11-21', ['hatchabot-a1-vol', 'hatchabot-n1-vol']);
    const full = w.backups.sets.list({ latest: false }) as { dir: string; backups: Array<{ date: string; volumes: Array<{ file: string; agentId?: string }> }>; missing: Array<{ agentId: string; host?: string }> };
    expect(full.dir).toBe(base);
    expect(full.backups.map((b) => b.date)).toEqual(['2026-11-21', '2026-11-20']);
    const newest = full.backups[0]!.volumes;
    expect(newest.map((v) => v.agentId).sort()).toEqual(['a1', 'n1']);
    expect(full.backups[1]!.volumes.find((v) => v.file === 'hatchabot-gone-vol')?.agentId).toBeUndefined();
    expect(full.missing).toEqual([expect.objectContaining({ agentId: 'r1', host: 'Laptop runner' })]);

    const latest = w.backups.sets.list({ latest: true }) as { backups: Array<{ date: string; volumes: unknown[] }>; missing: Array<{ agentId: string }> };
    expect(Object.keys(latest).sort()).toEqual(['backups', 'missing']);
    expect(latest.backups).toEqual([expect.objectContaining({ date: '2026-11-21', volumes: [] })]);
    expect(latest.missing.map((m) => m.agentId)).toEqual(['r1']);
  });

  it('Back up now is recorded as a machine operation, failed when it could not start', () => {
    const w = world();
    const run = w.backups.sets.runNow(OWNER);
    expect(run.status).toBe('error'); // no script under a test runner
    const op = w.store.listMachineOperations(['h1']).find((o) => o.kind === 'backup-run')!;
    expect(op).toMatchObject({ status: 'failed', requestedBy: OWNER });
  });

  it('a restore from a set holds the busy flag and refuses a date that is not one', async () => {
    const w = world();
    const a = w.agent('a1');
    await expect(w.backups.sets.restore({ agent: a, date: 'last tuesday', otherKey: false, requestedBy: OWNER })()).rejects.toThrow('Not a backup date.');
    set('2026-11-21', ['hatchabot-other-vol']);
    await expect(w.backups.sets.restore({ agent: a, date: '2026-11-21', otherKey: false, requestedBy: OWNER })()).rejects.toThrow("The 2026-11-21 backup doesn't contain this agent.");
    markBusy('a1');
    try {
      await expect(w.backups.sets.restore({ agent: a, date: '2026-11-21', otherKey: false, requestedBy: OWNER })()).rejects.toBeInstanceOf(AgentBusyError);
    } finally { clearBusy('a1'); }
  });
});

describe('restore drills', () => {
  it('readiness: the machine owner sees every agent, anyone else their own, and one agent keeps its restore choices', async () => {
    const w = world();
    w.agent('a1');
    w.agent('n1', { owner: NEIGHBOUR });
    set('2026-11-21', ['hatchabot-a1-vol', 'hatchabot-n1-vol']);
    const all = await w.backups.drills.readiness({ admin: true, ownerId: OWNER }) as { agents: Array<{ agentId: string; restorable?: unknown }>; canRestore: boolean; drill: Record<string, unknown> };
    expect(all.agents.map((a) => a.agentId).sort()).toEqual(['a1', 'n1']);
    expect(all.agents.every((a) => a.restorable === undefined)).toBe(true);
    expect(all.canRestore).toBe(true);
    expect(all.drill).toMatchObject({ every: 'off', run: expect.any(Object) });
    const mine = await w.backups.drills.readiness({ admin: false, ownerId: NEIGHBOUR }) as typeof all;
    expect(mine.agents.map((a) => a.agentId)).toEqual(['n1']);
    expect(mine.canRestore).toBe(false);
    expect(mine.drill.run).toBeUndefined();
    const one = await w.backups.drills.readiness({ admin: true, ownerId: OWNER, agentId: 'a1' }) as typeof all;
    expect(one.agents.map((a) => a.agentId)).toEqual(['a1']);
    expect(one.agents[0]!.restorable).toEqual([expect.objectContaining({ date: '2026-11-21' })]);
  });

  it('the schedule is written to .env and live at once; the sweep is off until then', async () => {
    const w = world();
    const envDir = tmp('hb-bksvc-env-');
    process.env.HATCHABOT_ENV_FILE = join(envDir, '.env');
    writeFileSync(process.env.HATCHABOT_ENV_FILE, 'PORT=8080\n');
    const five = new Date(); five.setHours(5, 30, 0, 0);
    expect(w.backups.drills.drillSweep(five)).toBe(false);
    expect(await w.backups.drills.setDrillEvery('weekly')).toMatchObject({ ok: true });
    expect(readFileSync(process.env.HATCHABOT_ENV_FILE, 'utf8')).toMatch(/^HATCHABOT_DRILL_EVERY=weekly$/m);
    expect(process.env.HATCHABOT_DRILL_EVERY).toBe('weekly');
    expect(w.traced).toContain('backup.drill_schedule_set');
    const noon = new Date(five); noon.setHours(12);
    expect(w.backups.drills.drillSweep(noon)).toBe(false); // not in the quiet hours
  });

  it('a drill started from the app is a machine operation, failed when it could not start', () => {
    const w = world();
    const run = w.backups.drills.runDrill('app', OWNER);
    expect(run.status).toBe('error'); // no script under a test runner
    const op = w.store.listMachineOperations(['h1']).find((o) => o.kind === 'restore-drill')!;
    expect(op).toMatchObject({ status: 'failed', requestedBy: OWNER, params: { trigger: 'app' } });
  });

  it('the schedule\'s timer runs only when given an interval, and stop() ends it', () => {
    vi.useFakeTimers();
    const off = world();
    expect(vi.getTimerCount()).toBe(0);
    off.backups.stop();
    const on = world({ drillSweepEveryMs: 60_000 });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000); // a sweep with the schedule off: nothing started, nothing warned
    expect(on.warned).toEqual([]);
    expect(on.store.listMachineOperations(['h1'])).toEqual([]);
    on.backups.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
