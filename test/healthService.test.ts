import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import type { LiveMemoryLimits, RuntimeProvider } from '../src/providers/provider.js';
import { agentMemoryLimits, wantedLimits } from '../src/domain/swap.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { createHealthChecks, type HealthChecks } from '../src/orchestrator/health/healthChecks.js';
import { snapshotOf } from '../src/orchestrator/health/posture.js';
import type { Agent } from '../src/domain/types.js';
import { limitsCheckLine } from '../src/doctor.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The health, logs and events service (HB-0808), driven as its routes, the
 * registry and src/index.ts drive it but with no HTTP server: an agent's
 * Setup log, Activity for a caller, the posture against the last snapshot,
 * the limits check (drift found, applied again, said once), the storage
 * measurement, and the two timers. A real store on an in-memory database; a
 * runtime that holds each container's limits. Every name is made up.
 */
const OWNER = 'user-owner';
const OTHER = 'user-other';

interface World {
  store: Store;
  svc: HealthChecks;
  live: Map<string, LiveMemoryLimits>;
  updates: string[];
  measured: string[];
  traced: Array<{ event: string; agentId?: string }>;
  warned: string[];
  inFlight: Set<string>;
  agent(id: string, opts?: { owner?: string; state?: Agent['state'] }): Agent;
}

function world(opts: { timers?: { bootMs: number; everyMs: number } } = {}): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  const w = { store, live: new Map(), updates: [], measured: [], traced: [], warned: [], inFlight: new Set() } as unknown as World;
  const provider = {
    updateMemory: async (ref: string, memory: string, swap?: string) => {
      w.updates.push(ref);
      const want = wantedLimits({ memory, ...(swap ? { swap } : {}) }, false);
      w.live.set(ref, { running: true, dockerMemory: want.memoryMax, dockerMemorySwap: want.memoryMax + want.swapMax, cgroup: { memoryMax: want.memoryMax, swapMax: want.swapMax } });
    },
    memoryLimitsLive: async (refs: string[]) => new Map(refs.flatMap((r) => (w.live.has(r) ? [[r, w.live.get(r)!] as const] : []))),
    execShellOnVolume: async (ref: string) => { w.measured.push(ref); return { code: 0, stdout: '4096\n', stderr: '' }; },
  } as unknown as RuntimeProvider;
  w.svc = createHealthChecks({
    store,
    providerFor: () => provider,
    trace: (agentId) => (event) => { w.traced.push({ event, agentId }); },
    inLimitsTurn: (_id, fn) => fn(),
    inFlight: (id) => w.inFlight.has(id),
    limitsCheckFile: undefined,
    warn: (_d, msg) => { w.warned.push(msg); },
    limitsTimers: opts.timers,
  });
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: o.owner ?? OWNER, name: `Agent ${id}`, slug: id, state: o.state ?? 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `rt-${id}`,
    } as never);
    return store.getAgent(id)!;
  };
  return w;
}
/** The limits the agent should have, as docker and the cgroup would hold them. */
const held = (w: World, a: Agent): LiveMemoryLimits => {
  const want = wantedLimits(agentMemoryLimits(w.store, a), false);
  return { running: true, dockerMemory: want.memoryMax, dockerMemorySwap: want.memoryMax + want.swapMax, cgroup: { memoryMax: want.memoryMax, swapMax: want.swapMax } };
};

afterEach(() => { vi.useRealTimers(); clearBusy('a1'); });

describe('the Setup log and Activity', () => {
  it('an agent\'s trail is newest first, in plain words, with its note', () => {
    const w = world();
    const a = w.agent('a1');
    w.store.recordEvent('a1', 'provision.started');
    w.store.recordEvent('a1', 'provision.failed', { error: 'the image is gone' });
    const t = w.svc.timeline(a, 10);
    expect(t).toMatchObject({ agent: 'Agent a1', state: 'RUNNING' });
    expect(t.events.map((e) => e.event)).toEqual(['provision.failed', 'provision.started']);
    expect(t.events[0]).toMatchObject({ note: 'the image is gone', label: expect.any(String) });
    expect(w.svc.timeline(a, 1).events).toHaveLength(1);
  });

  it('Activity shows only the agents a caller can see, and nothing for another\'s agent asked by id', () => {
    const w = world();
    w.agent('a1');
    w.agent('b1', { owner: OTHER });
    w.store.recordEvent('a1', 'agent.started');
    w.store.recordEvent('b1', 'agent.started');
    expect(w.svc.feed(OWNER, 40).map((r) => r.agentName)).toEqual(['Agent a1']);
    expect(w.svc.feed(OWNER, 40, 'b1')).toEqual([]);
    expect(w.svc.feed(OTHER, 40, 'b1').map((r) => r.agentId)).toEqual(['b1']);
  });

  it('rebuilds newer than a move do not use up Activity\'s rows: the move is still listed (HB-1012)', () => {
    const w = world();
    w.agent('a1');
    const at = (min: number) => new Date(Date.parse('2026-11-01T10:00:00.000Z') + min * 60_000).toISOString();
    const op = (id: string, kind: string, min: number) => ({
      id, agentId: 'a1', kind, requestedAt: at(min), params: {}, status: 'succeeded' as const, bootId: 'b', updatedAt: at(min), finishedAt: at(min),
    });
    w.store.insertOperation(op('op_move', 'move-host', 0) as never);
    for (let i = 1; i <= 20; i++) w.store.insertOperation(op(`op_rb${i}`, 'rebuild', i) as never);
    const rows = w.svc.feed(OWNER, 20);
    expect(rows.map((r) => (r.op as { kind?: string } | undefined)?.kind)).toEqual(['move-host']);
  });
});

describe('the posture', () => {
  it('compares with the owner\'s last snapshot before today, and only says so when there was one', () => {
    const w = world();
    w.agent('a1');
    const first = w.svc.posture({ ownerId: OWNER, isHostOwner: true, authMode: 'accounts' });
    expect(first).toMatchObject({ comparedToPrior: false, changes: { added: [], removed: [] } });
    w.store.upsertPostureSnapshot(OWNER, '2000-01-01', snapshotOf(['a-risk-that-is-gone']));
    const second = w.svc.posture({ ownerId: OWNER, isHostOwner: true, authMode: 'accounts' });
    expect(second.comparedToPrior).toBe(true);
    expect(second.changes.removed).toEqual(['a-risk-that-is-gone']);
  });

  it('a snapshot of the older key format is not compared with: nothing "appeared" or "resolved" on the upgrade day (HB-1103)', () => {
    const w = world();
    w.agent('a1');
    w.store.upsertPostureSnapshot(OWNER, '2000-01-01', ['a-risk-that-is-gone']);
    expect(w.svc.posture({ ownerId: OWNER, isHostOwner: true, authMode: 'accounts' })).toMatchObject({ comparedToPrior: false, changes: { added: [], removed: [] } });
  });
});

describe('the limits check', () => {
  it('applies a drifted limit again, says so once per drift, and keeps the last check of all agents', async () => {
    const w = world();
    const a = w.agent('a1');
    const ok = w.agent('a2');
    w.live.set('rt-a2', held(w, ok));
    w.live.set('rt-a1', { ...held(w, a), cgroup: { memoryMax: held(w, a).cgroup!.memoryMax, swapMax: null } });
    const sum = await w.svc.limitsCheck();
    expect(sum).toMatchObject({ checked: 2, cgroupDrifted: 1, reasserted: 1, failed: 0 });
    expect(w.updates).toEqual(['rt-a1']);
    expect(w.traced).toEqual([{ event: 'runtime.swap_reasserted', agentId: 'a1' }]);
    expect(w.svc.lastLimitsCheck()).toBe(sum);
    // The same drift again is applied again but not said again.
    w.live.set('rt-a1', { ...held(w, a), cgroup: { memoryMax: held(w, a).cgroup!.memoryMax, swapMax: null } });
    await w.svc.limitsCheck();
    expect(w.updates).toEqual(['rt-a1', 'rt-a1']);
    expect(w.traced).toHaveLength(1);
  });

  it('agents whose limits could not be read are counted as not read, and the doctor does not say none drifted (HB-1106)', async () => {
    const w = world();
    const a = w.agent('a1');
    w.agent('a2');
    // The runner gave no reading for either.
    const empty = await w.svc.limitsCheck();
    expect(empty).toMatchObject({ checked: 0, failed: 0, unread: 2 });
    expect(limitsCheckLine(empty)).toMatchObject({ level: 'warn', text: expect.stringContaining('the limits of 2 agents could not be read, so they were not checked') });
    expect(limitsCheckLine(empty).text).not.toContain('none drifted');
    // One read, one not: the read one is checked, the other said.
    w.live.set('rt-a1', held(w, a));
    const mixed = await w.svc.limitsCheck();
    expect(mixed).toMatchObject({ checked: 1, unread: 1 });
    expect(limitsCheckLine(mixed)).toMatchObject({ level: 'warn', text: expect.stringContaining('1 agent checked, none drifted; the limits of 1 agent could not be read, so it was not checked') });
    // All read: as before.
    w.live.set('rt-a2', held(w, w.store.getAgent('a2')!));
    expect(limitsCheckLine(await w.svc.limitsCheck())).toMatchObject({ level: 'ok', text: expect.stringContaining('2 agents checked, none drifted') });
  });

  it('a runner whose docker does not answer leaves its agents counted as not read (HB-1106)', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Agent a1', slug: 'a1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: 'rt-a1' } as never);
    const provider = {
      updateMemory: async () => {},
      memoryLimitsLive: async () => { throw new Error('cannot connect to the Docker daemon'); },
    } as unknown as RuntimeProvider;
    const svc = createHealthChecks({
      store, providerFor: () => provider, trace: () => () => {}, inLimitsTurn: (_id, fn) => fn(), inFlight: () => false, limitsCheckFile: undefined, warn: () => {},
    });
    const sum = await svc.limitsCheck();
    expect(sum).toMatchObject({ checked: 0, unread: 1 });
    expect(svc.lastLimitsCheck()).toBe(sum);
    expect(limitsCheckLine(sum).level).toBe('warn');
  });

  it('an asleep runner and a stopped agent with no container are said, not warned about; a running one with no reading still is (HB-1106)', async () => {
    const store = new Store(new Database(':memory:'));
    for (const h of ['laptop', 'box']) store.insertHost({ id: h, ownerId: OWNER, kind: h === 'box' ? 'local' : 'remote', provider: 'mock', name: h, settings: {}, createdAt: 'now' } as never);
    const add = (id: string, hostId: string, state: string) => store.insertAgent({ id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state, aiProfileId: 'p1', hostId, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `rt-${id}` } as never);
    add('away1', 'laptop', 'RUNNING');
    add('away2', 'laptop', 'STOPPED');
    add('pruned', 'box', 'STOPPED');
    let laptop = { reachable: async () => false, read: async (): Promise<Map<string, LiveMemoryLimits>> => new Map() };
    const prov = (hostId: string) => ({
      updateMemory: async () => {},
      reachable: hostId === 'laptop' ? () => laptop.reachable() : async () => true,
      // This machine's docker says it has neither container.
      memoryLimitsLive: hostId === 'laptop' ? () => laptop.read() : async (refs: string[], o?: { missing?: Set<string> }) => { for (const r of refs) o?.missing?.add(r); return new Map(); },
    }) as unknown as RuntimeProvider;
    const svc = createHealthChecks({ store, providerFor: prov, trace: () => () => {}, inLimitsTurn: (_id, fn) => fn(), inFlight: () => false, limitsCheckFile: undefined, warn: () => {} });
    let sum = await svc.limitsCheck();
    expect(sum).toMatchObject({ checked: 0, unread: 0, away: 2, noContainer: 1 });
    expect(limitsCheckLine(sum)).toEqual({ level: 'ok', text: expect.stringMatching(/: 0 agents checked; not checked now: 2 agents on a machine that is not answering \(asleep or offline\), 1 stopped agent with no container yet \(made when it starts\)$/) });
    // It said it was there, then its docker did not answer: asleep by the time it was asked.
    let asked = 0;
    laptop = { reachable: async () => asked++ === 0, read: async () => { throw new Error('ssh: connect to host: Connection timed out'); } };
    expect(await svc.limitsCheck()).toMatchObject({ unread: 0, away: 2 });
    // A running agent on a machine that answers, with no container: that one should have answered.
    add('lost', 'box', 'RUNNING');
    sum = await svc.limitsCheck();
    expect(sum).toMatchObject({ unread: 1, noContainer: 1 });
    expect(limitsCheckLine(sum).level).toBe('warn');
  });

  it('a stopped agent has "no container yet" only when docker says so; an inspect that failed as a whole is not read (HB-1106)', async () => {
    // The real provider, with a docker on a path of its own: never the machine's.
    const d = mkdtempSync(join(tmpdir(), 'hb-limits-'));
    try {
      const mode = join(d, 'mode');
      writeFileSync(join(d, 'docker'), `#!/usr/bin/env bash
case "$1" in
  inspect)
    case "$(cat ${JSON.stringify(mode)})" in
      down) echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' >&2 ;;
      empty) ;;
      *) for n in "\${@:4}"; do echo "Error: No such object: $n" >&2; done ;;
    esac
    exit 1 ;;
  info) echo "Ubuntu|[name=seccomp]" ;;
esac
exit 0
`, { mode: 0o755 });
      const store = new Store(new Database(':memory:'));
      store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'docker', name: 'box', settings: {}, createdAt: 'now' });
      for (const id of ['s1', 's2']) store.insertAgent({ id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `docker://hatchabot-${id}-4141abcd` } as never);
      const prov = new LocalDockerProvider({ docker: join(d, 'docker'), image: 'test-image:latest' });
      const svc = createHealthChecks({ store, providerFor: () => prov, trace: () => () => {}, inLimitsTurn: (_id, fn) => fn(), inFlight: () => false, limitsCheckFile: undefined, warn: () => {} });
      // Pruned: docker names each one it has not got.
      writeFileSync(mode, 'gone');
      let sum = await svc.limitsCheck();
      expect(sum).toMatchObject({ checked: 0, unread: 0, noContainer: 2 });
      expect(limitsCheckLine(sum).level).toBe('ok');
      // Its machine answers, its dockerd does not: that is not two pruned containers.
      writeFileSync(mode, 'down');
      sum = await svc.limitsCheck();
      expect(sum).toMatchObject({ checked: 0, unread: 2, noContainer: 0 });
      expect(limitsCheckLine(sum)).toMatchObject({ level: 'warn', text: expect.stringContaining('the limits of 2 agents could not be read') });
      // A failed inspect that said nothing at all is not "none there" either.
      writeFileSync(mode, 'empty');
      expect(await svc.limitsCheck()).toMatchObject({ unread: 2, noContainer: 0 });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  it('for one agent, leaves the last check of all alone; an agent mid-change is not touched', async () => {
    const w = world();
    const a = w.agent('a1');
    w.live.set('rt-a1', { ...held(w, a), dockerMemory: 1 });
    markBusy('a1');
    expect(await w.svc.limitsCheck({ agentIds: ['a1'] })).toMatchObject({ checked: 0, reasserted: 0 });
    clearBusy('a1');
    expect(await w.svc.limitsCheck({ agentIds: ['a1'] })).toMatchObject({ checked: 1, reasserted: 1 });
    expect(w.svc.lastLimitsCheck()).toBeUndefined();
  });
});

describe('each agent\'s storage', () => {
  it('measures the running and stopped agents, not one with a setup or rebuild in flight', async () => {
    const w = world();
    w.agent('a1');
    w.agent('a2', { state: 'STOPPED' });
    w.agent('a3');
    w.inFlight.add('a3');
    expect(await w.svc.diskSweep()).toEqual({ measured: 2, failed: 0 });
    expect(w.measured.sort()).toEqual(['rt-a1', 'rt-a2']);
  });
});

describe('the limits check\'s timers', () => {
  it('none without timings; with them, the first check after bootMs and then every everyMs, until stop()', async () => {
    vi.useFakeTimers();
    const off = world();
    expect(vi.getTimerCount()).toBe(0);
    off.svc.stop();
    const w = world({ timers: { bootMs: 1000, everyMs: 5000 } });
    expect(vi.getTimerCount()).toBe(2);
    expect(w.svc.lastLimitsCheck()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.svc.lastLimitsCheck()).toBeDefined();
    w.svc.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
