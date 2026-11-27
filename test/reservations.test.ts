import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AgentBusyError, forgetReservation, freeWithin, heldFor, isReserved, PURPOSES, reserve, waitersFor, whenFree, whileReserved } from '../src/orchestrator/lifecycle/reservations.js';
import { isBusy, markBusy, whileBusy } from '../src/orchestrator/lifecycle/busy.js';
import { reconcileAgents } from '../src/orchestrator/lifecycle/reconcile.js';
import { workspacePath } from '../src/orchestrator/files/snapshots.js';
import { as, makeWorld, restartWorld, seedRunningAgent, type World } from './support/world.js';

/**
 * One reservation per agent (src/orchestrator/lifecycle/reservations.ts,
 * HB-1465 step 4): the busy flag, with what it was taken for, and `reuse`
 * in place of `busyHeld`. busy.ts is its facade: test/busy.test.ts holds the
 * flag's own rules through it. Ids are made up.
 */

/** A promise held open until `release`, and one that says when it was reached. */
function gate() {
  let release!: () => void; let signal!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { signal = r; });
  return { held, reached, release, signal };
}
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const id of ['kitchen', 'garden', 'a1']) forgetReservation(id);
  for (const c of closers.splice(0)) await c();
});

describe('a reservation and its purpose', () => {
  it('is taken in the tick it is asked for, says what it is for while held, and is gone however its work ends', async () => {
    expect(heldFor('kitchen')).toBeUndefined();
    const g = gate();
    const holding = whileReserved('kitchen', 'rebuild', async (held) => { expect(held.purpose).toBe('rebuild'); g.signal(); await g.held; return 'rebuilt'; });
    // Held before anything else runs: nothing can come between a caller's last look and it.
    expect(isReserved('kitchen')).toBe(true);
    expect(heldFor('kitchen')).toBe('rebuild');
    await g.reached;
    g.release();
    expect(await holding).toBe('rebuilt');
    expect(isReserved('kitchen')).toBe(false);
    expect(heldFor('kitchen')).toBeUndefined();
    await expect(whileReserved('kitchen', 'stop', async () => { throw new Error('made-up failure'); })).rejects.toThrow('made-up failure');
    expect(isReserved('kitchen')).toBe(false);
  });

  it('a take refused by a holder says the words it always said, and carries the holder\'s purpose for a log', async () => {
    const g = gate();
    const holding = whileBusy('kitchen', 'move-host', async () => { g.signal(); await g.held; });
    await g.reached;
    // A refusal is a rejection, never a throw from the call.
    const refused = whileBusy('kitchen', 'start', async () => 'started');
    await expect(refused).rejects.toBeInstanceOf(AgentBusyError);
    await expect(refused).rejects.toMatchObject({ userMessage: 'Another operation is already running on this agent.', heldFor: 'move-host' });
    expect(() => markBusy('kitchen', 'download')).toThrow(AgentBusyError);
    expect(heldFor('kitchen')).toBe('move-host');
    g.release();
    await holding;
  });

  it('busy.ts is its facade: a mark and a flag are a reservation', () => {
    const release = markBusy('kitchen', 'import');
    expect(isBusy('kitchen')).toBe(true);
    expect(isReserved('kitchen')).toBe(true);
    expect(heldFor('kitchen')).toBe('import');
    expect(() => reserve('kitchen', 'stop')).toThrow(AgentBusyError);
    release();
    expect(isBusy('kitchen')).toBe(false);
    // A holder that names none (tests' stand-in for another holder) holds it all the same.
    const standIn = markBusy('kitchen');
    expect(isBusy('kitchen')).toBe(true);
    expect(heldFor('kitchen')).toBeUndefined();
    standIn();
    expect(isBusy('kitchen')).toBe(false);
  });

  it('a release lets go of its own reservation only', () => {
    const first = reserve('kitchen', 'file-save');
    expect(first.held).toBe(true);
    first.release();
    expect(first.held).toBe(false);
    const second = reserve('kitchen', 'task-add');
    first.release(); // the first holder's finally, run a second time
    expect(second.held).toBe(true);
    expect(heldFor('kitchen')).toBe('task-add');
    second.release();
    expect(isReserved('kitchen')).toBe(false);
  });

  it('every purpose is a name of its own', () => {
    expect(new Set(PURPOSES).size).toBe(PURPOSES.length);
    for (const p of PURPOSES) expect(p).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });
});

describe('reuse, in place of busyHeld', () => {
  it('code that would take the agent again goes on under its holder\'s own reservation: neither refused nor let go when it ends', async () => {
    const ran: string[] = [];
    const out = await whileBusy('kitchen', 'recover-operation', async (held) => {
      const inner = await whileBusy('kitchen', 'provision', async (same) => {
        ran.push('inner');
        expect(same).toBe(held);
        // Still the holder's purpose: the inner take took nothing.
        expect(heldFor('kitchen')).toBe('recover-operation');
        return 'set up';
      }, { reuse: held });
      // The agent is still held when the inner work is done: its holder lets it go.
      expect(isBusy('kitchen')).toBe(true);
      expect(held.held).toBe(true);
      ran.push('outer');
      return inner;
    });
    expect(out).toBe('set up');
    expect(ran).toEqual(['inner', 'outer']);
    expect(isBusy('kitchen')).toBe(false);
  });

  it('an inner failure is its caller\'s, and the holder still lets go', async () => {
    await expect(whileBusy('kitchen', 'recover-operation', (held) =>
      whileBusy('kitchen', 'rebuild', async () => { throw new Error('made-up failure'); }, { reuse: held }),
    )).rejects.toThrow('made-up failure');
    expect(isBusy('kitchen')).toBe(false);
  });

  it('without reuse, the same code refuses its own holder, as it would have without busyHeld', async () => {
    await expect(whileBusy('kitchen', 'recover-operation', () =>
      whileBusy('kitchen', 'provision', async () => 'never'),
    )).rejects.toBeInstanceOf(AgentBusyError);
    expect(isBusy('kitchen')).toBe(false);
  });

  it('a reservation no longer held is no reservation: the agent is taken afresh, and refused when another holds it', async () => {
    const stale = reserve('kitchen', 'recover-operation');
    stale.release();
    // Free: taken afresh, under its own purpose, and let go at its end.
    expect(await whileBusy('kitchen', 'provision', async () => heldFor('kitchen'), { reuse: stale })).toBe('provision');
    expect(isBusy('kitchen')).toBe(false);
    // Held by another: refused, and the other keeps it.
    const other = reserve('kitchen', 'move-host');
    await expect(whileBusy('kitchen', 'provision', async () => 'never', { reuse: stale })).rejects.toBeInstanceOf(AgentBusyError);
    expect(other.held).toBe(true);
    other.release();
  });

  it("another agent's reservation is none for this one", async () => {
    const garden = reserve('garden', 'recover-operation');
    expect(await whileBusy('kitchen', 'rebuild', async () => heldFor('kitchen'), { reuse: garden })).toBe('rebuild');
    expect(isBusy('kitchen')).toBe(false);
    expect(garden.held).toBe(true);
    garden.release();
  });
});

describe('waiting for an agent to be free', () => {
  it('a waiter is let go when its reservation is, and one that gives up is forgotten', async () => {
    const r = reserve('kitchen', 'archive');
    let freed = false;
    void whenFree('kitchen').then(() => { freed = true; });
    const gaveUp = freeWithin('kitchen', 5);
    expect(waitersFor('kitchen')).toBe(2);
    expect(await gaveUp).toBe(false);
    expect(waitersFor('kitchen')).toBe(1);
    expect(freed).toBe(false);
    const inTime = freeWithin('kitchen', 60_000);
    r.release();
    expect(await inTime).toBe(true);
    await ticks();
    expect(freed).toBe(true);
    expect(waitersFor('kitchen')).toBe(0);
  });

  it('a restart forgets every reservation and lets its waiters go (forgetReservation, the tests\' stand-in for one)', async () => {
    const r = reserve('kitchen', 'stop');
    const waiting = whenFree('kitchen');
    forgetReservation('kitchen');
    await waiting;
    expect(isReserved('kitchen')).toBe(false);
    expect(r.held).toBe(false);
    r.release(); // the old process's holder lets go of nothing
    const next = reserve('kitchen', 'start');
    r.release();
    expect(next.held).toBe(true);
    next.release();
  });
});

describe('every take in src names what it is for', () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk('src');
  const FACADE = join('src', 'orchestrator', 'lifecycle', 'busy.ts');
  const MODULE = join('src', 'orchestrator', 'lifecycle', 'reservations.ts');
  const callers = files.filter((f) => f !== FACADE && f !== MODULE);
  const TAKE = /\b(whileBusy|markBusy)\(/g;
  const NAMED = /\b(?:whileBusy|markBusy)\([^,()]+, '([a-z-]+)'/g;

  it('each whileBusy and markBusy names a purpose of PURPOSES, and each purpose is named somewhere', () => {
    const unnamed: string[] = [];
    const named = new Set<string>();
    let takes = 0;
    for (const f of callers) {
      const text = readFileSync(f, 'utf8');
      const all = [...text.matchAll(TAKE)].length;
      const withPurpose = [...text.matchAll(NAMED)].map((m) => m[1]!);
      takes += all;
      if (withPurpose.length !== all) unnamed.push(`${f}: ${all - withPurpose.length} of ${all}`);
      for (const p of withPurpose) named.add(p);
    }
    expect(unnamed, 'A take of an agent names its purpose (src/orchestrator/lifecycle/reservations.ts, PURPOSES), on the line it is taken: whileBusy(id, \'rebuild\', fn).').toEqual([]);
    expect(takes).toBeGreaterThan(50);
    expect([...named].filter((p) => !(PURPOSES as readonly string[]).includes(p))).toEqual([]);
    expect(PURPOSES.filter((p) => !named.has(p)), 'A purpose no take names: take it out of PURPOSES.').toEqual([]);
  });

  it('src takes an agent only through the facade, and lets one go only through its holder', () => {
    // Any path to the module, from anywhere in src but its facade: an import,
    // an export from it, or an import() (NodeNext: every one ends `.js`).
    const direct = files.filter((f) => f !== FACADE && /reservations\.js['"`]/.test(readFileSync(f, 'utf8')));
    expect(direct, 'Take an agent through busy.ts (whileBusy, markBusy), its facade.').toEqual([]);
    const forgets = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\bforgetReservation\s*\(/g)].map(() => f));
    // Its definition, and busy.ts's clearBusy, which only tests call (test/busy.test.ts).
    expect(forgets.sort()).toEqual([FACADE, MODULE].sort());
    // Forgetting all of them is the tests' setup's alone (test/support/freshReservations.ts, HB-0873): only its definition is in src.
    const forgetsAll = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\bforgetAllReservationsForTests\s*\(/g)].map(() => f));
    expect(forgetsAll).toEqual([MODULE]);
  });
});

/**
 * A restart in the middle of a held reservation, as
 * test/holdsAcrossRestart.test.ts restarts: the database and the containers
 * as they were, a new Store and new routes over them, and nothing of the
 * process's memory. The reservations are this module's, which the next
 * process does not have (forgetReservation stands for that). What the
 * work left is made up for at the start by what its purpose names: one of
 * each kind here.
 */
describe('a reservation held when the process ends', () => {
  const send = (w: World, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    w.f.inject({ method, url, headers: as(), ...(payload !== undefined ? { payload: payload as object } : {}) });
  /** The world after a restart: the old app's request never answers, so it is left as it is rather than closed. */
  const restart = async (w: World, id: string): Promise<World> => {
    const next = await restartWorld({ ...w, f: { close: async () => undefined } as never });
    closers.push(() => next.f.close());
    expect(heldFor(id)).toBeDefined(); // the old process's, until it is gone with it
    forgetReservation(id);
    return next;
  };
  const settle = async (done: () => boolean, ms = 4000) => { for (let i = 0; i < ms / 10 && !done(); i++) await new Promise((r) => setTimeout(r, 10)); };

  it('a Stop cut off in its docker stop: reconcile, at the start, records the stopped container, and Start takes the agent', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const stop = w.provider.stop.bind(w.provider);
    const reached = gate();
    // The container stops; the answer never comes back to this process.
    w.provider.stop = async (ref) => { await stop(ref); reached.signal(); await new Promise(() => {}); };
    void send(w, 'POST', `/v1/agents/${id}/stop`).catch(() => undefined);
    await reached.reached;
    expect(heldFor(id)).toBe('stop');
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    w.provider.stop = stop;

    w = await restart(w, id);
    // What src/index.ts does first: the record judged by its container.
    await reconcileAgents(w.store, w.providers, () => {});
    expect(w.store.getAgent(id)?.state).toBe('STOPPED');
    const started = await send(w, 'POST', `/v1/agents/${id}/start`);
    expect(started.statusCode).toBe(200);
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    expect(isBusy(id)).toBe(false);
  });

  it("an Archive cut off as its bot went back: the operation on disk is finished by the start's pass, and reconcile leaves it alone until then", async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    const reached = gate();
    const release = w.channel.release;
    w.channel.release = async () => { reached.signal(); await new Promise(() => {}); };
    void send(w, 'POST', `/v1/agents/${id}/archive`, {}).catch(() => undefined);
    await reached.reached;
    expect(heldFor(id)).toBe('archive');
    const [op] = w.store.listOperations([id]);
    expect(op).toMatchObject({ kind: 'archive', status: 'running', step: 'stopped' });
    w.channel.release = release;
    w.store.updateOperation(op!.id, { bootId: 'an-earlier-boot' }); // its process ended

    w = await restart(w, id);
    // Reconcile judges nothing of an agent with an operation not over: the
    // stopped container of a record that still says RUNNING is the archive's.
    await reconcileAgents(w.store, w.providers, () => {});
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    await w.routes!.resumeOperations();
    expect(w.store.getOperation(op!.id)?.status).toBe('succeeded');
    expect(w.store.getAgent(id)?.state).toBe('ARCHIVED');
    expect(w.store.getChannelForAgent(id)).toBeUndefined();
    expect(isBusy(id)).toBe(false);
  });

  it('an AGENTS.md sync cut off under its reservation: its ask stays in the store, and the next start serves it', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    w.store.setAgentHold(id, 'docs-sync', 'made-up-ask');
    w = await restartWorld(w);
    closers.push(() => w.f.close());
    const SYNC_READ = /^cat "[^"]*\/AGENTS\.md" 2>\/dev\/null \|\| true$/;
    const shell = w.provider.execShell.bind(w.provider);
    const reached = gate();
    // This process's sync never gets its read back.
    w.provider.execShell = async (ref, script, opts) => { if (SYNC_READ.test(script)) { reached.signal(); await new Promise(() => {}); } return shell(ref, script, opts); };
    void w.routes!.resumeOperations().catch(() => undefined);
    await reached.reached;
    expect(heldFor(id)).toBe('docs-sync');
    expect(w.store.agentHold(id, 'docs-sync')).toBeDefined();

    w.provider.execShell = shell;
    w = await restart(w, id);
    const synced: string[] = [];
    w.provider.execShell = async (ref, script, opts) => { if (SYNC_READ.test(script)) synced.push(ref); return shell(ref, script, opts); };
    await w.routes!.resumeOperations();
    await settle(() => w.store.agentHold(id, 'docs-sync') === undefined);
    expect(synced).toEqual([w.store.getAgent(id)!.runtimeRef]);
    expect(w.store.agentHold(id, 'docs-sync')).toBeUndefined();
    expect(isBusy(id)).toBe(false);
  });

  it('a file save cut off before its rename: it ends where it stood, the file whole as it was and its snapshot from before kept, so the next process reads the old file and its next save lands', async () => {
    let w = await makeWorld();
    closers.push(() => w.f.close());
    const id = await seedRunningAgent(w);
    // The agent's files, as the read and the write in snapshots.ts see them:
    // a read is `head -c` of the file, a write is base64 to a file of its own,
    // then one rename over the file. Nothing else is modelled.
    const disk = new Map<string, string>();
    const soul = workspacePath(w.store.getAgent(id)!.slug, 'SOUL.md');
    disk.set(soul, 'You help cook.');
    const READ = /^head -c \d+ "([^"]+)"/;
    const WRITE = /echo "([A-Za-z0-9+/=]*)" \| base64 -d > \S+ && mv -fT -- \S+ "([^"]+)"$/;
    let cut: (() => void) | undefined;
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => {
      const read = READ.exec(script);
      if (read) return { code: 0, stdout: disk.get(read[1]!) ?? '', stderr: '' };
      const write = WRITE.exec(script);
      if (write && cut) { cut(); await new Promise(() => {}); } // the old process: its rename never runs
      if (write) { disk.set(write[2]!, Buffer.from(write[1]!, 'base64').toString('utf8')); return { code: 0, stdout: '', stderr: '' }; }
      return shell(ref, script, opts);
    };
    const reached = gate();
    cut = reached.signal;
    void send(w, 'PUT', `/v1/agents/${id}/files/SOUL.md`, { content: 'You help cook, and bake.' }).catch(() => undefined);
    await reached.reached;
    expect(heldFor(id)).toBe('file-save');
    cut = undefined;

    w = await restart(w, id);
    await reconcileAgents(w.store, w.providers, () => {});
    // Nothing for the start to judge or settle: the record as it was, no operation.
    expect(w.store.getAgent(id)?.state).toBe('RUNNING');
    expect(w.store.listOperations([id])).toEqual([]);
    // Its snapshot from before the write is the one the next process has.
    expect(w.store.latestSnapshot(id)).toMatchObject({ reason: 'pre-edit', files: { 'SOUL.md': 'You help cook.' } });
    const before = await send(w, 'GET', `/v1/agents/${id}/files/SOUL.md`);
    expect(before.statusCode).toBe(200);
    expect(before.json()).toEqual({ name: 'SOUL.md', content: 'You help cook.' });
    const saved = await send(w, 'PUT', `/v1/agents/${id}/files/SOUL.md`, { content: 'You help cook, and bake.' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ saved: true });
    expect(disk.get(soul)).toBe('You help cook, and bake.');
    const after = await send(w, 'GET', `/v1/agents/${id}/files/SOUL.md`);
    expect(after.json()).toEqual({ name: 'SOUL.md', content: 'You help cook, and bake.' });
    expect(isBusy(id)).toBe(false);
  });
});
