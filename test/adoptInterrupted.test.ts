/**
 * An adopt cut off part way (HB-0980). Copying a workspace into an agent
 * stops it and replaces its files, and the extract is not atomic: a failure
 * or a restart in the middle left a half-copied workspace that started as if
 * whole, with nothing on disk to say so. The adopt is now recorded as an
 * operation (`adopt-workspace`); cut off part way it is held, Start is
 * refused until the owner chooses, and the choice is Adopt again (every file
 * in the folder copied in again, whole), with Start it as it is only when the folder can no
 * longer be copied from.
 *
 * A restart here is what it is on a machine (test/support/world.ts,
 * restartWorld): the database and the containers stay, the process's memory
 * goes. The workspaces and the household are made up.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearBusy, isBusy } from '../src/orchestrator/lifecycle/busy.js';
import { beginOperation, newBootForTests, operationRefusal, setStepHookForTests, settleStartsOwedOn, SimulatedCrash } from '../src/orchestrator/lifecycle/operations.js';
import { as, makeWorld, restartWorld, seedRunningAgent, type World } from './support/world.js';

const tmp = mkdtempSync(join(tmpdir(), 'hb-adopt-cut-'));
const prev = { cfg: process.env.OPENCLAW_CONFIG, db: process.env.OPENCLAW_STATE_DB };
beforeAll(() => {
  // Never this machine's own OpenClaw: no config, no task store.
  process.env.OPENCLAW_CONFIG = join(tmp, 'no-openclaw.json');
  process.env.OPENCLAW_STATE_DB = join(tmp, 'no-state.sqlite');
});
afterAll(() => {
  if (prev.cfg === undefined) delete process.env.OPENCLAW_CONFIG; else process.env.OPENCLAW_CONFIG = prev.cfg;
  if (prev.db === undefined) delete process.env.OPENCLAW_STATE_DB; else process.env.OPENCLAW_STATE_DB = prev.db;
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => setStepHookForTests(undefined));

let n = 0;
/** A hand-built workspace: more than the three files Hatchabot seeds. */
function workspace(): string {
  const ws = join(tmp, `workspace-${++n}`);
  mkdirSync(join(ws, 'memory'), { recursive: true });
  writeFileSync(join(ws, 'SOUL.md'), 'You keep the pantry list.\n');
  writeFileSync(join(ws, 'AGENTS.md'), '# agents\n');
  writeFileSync(join(ws, 'MEMORY.md'), '# memory\n');
  writeFileSync(join(ws, 'memory', '2026-11-01.md'), '# a day\n');
  return ws;
}

const adopt = (w: World, id: string, path: string) =>
  w.f.inject({ method: 'POST', url: `/v1/agents/${id}/adopt-workspace`, headers: as(), payload: { path } });
const recover = (w: World, opId: string, action: string) =>
  w.f.inject({ method: 'POST', url: `/v1/operations/${opId}/recover`, headers: as(), payload: { action } });
const start = (w: World, id: string) => w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });

/** A running agent, and its workspace as the container holds it (the archive last copied in). */
async function world() {
  const w = await makeWorld();
  const id = await seedRunningAgent(w, { id: 'a1', name: 'Pantry', slug: 'pantry' });
  const ref = w.store.getAgent(id)!.runtimeRef!;
  const copied = () => w.provider.workspaceStore.get(`${ref}:pantry`);
  const phase = async () => (await w.provider.status(ref)).phase;
  return { w, id, ref, copied, phase };
}

/** The rebuild a Start kicked has run (it holds the agent's busy flag, which the next test's agent of the same id would meet). */
async function rebuilt(w: World, id: string): Promise<void> {
  for (let i = 0; i < 400 && (isBusy(id) || w.store.getAgent(id)?.state === 'REBUILDING'); i++) await new Promise((d) => setTimeout(d, 10));
  expect(isBusy(id)).toBe(false);
}
/** The adopt's own record (a rebuild a Start kicked has one of its own). */
const adoptOp = (w: World, id: string) => w.store.listOperations([id]).find((o) => o.kind === 'adopt-workspace')!;

/** Hatchabot restarts: a new process over the same database and machine; what it was doing is left where it stood. */
async function restart(w: World, id: string): Promise<World> {
  setStepHookForTests(undefined);
  clearBusy(id);
  newBootForTests();
  const next = await restartWorld(w);
  await next.routes!.resumeOperations();
  return next;
}

/** The extract dies part way, as a killed process would: some of the archive written, nothing after. */
function dieMidCopy(w: World): () => void {
  const real = w.provider.importWorkspace.bind(w.provider);
  w.provider.importWorkspace = async (ref, slug, data) => {
    w.provider.workspaceStore.set(`${ref}:${slug}`, data.subarray(0, 8));
    throw new SimulatedCrash();
  };
  return () => { w.provider.importWorkspace = real; };
}

describe('an adopt cut off by a restart in the middle of the copy (HB-0980)', () => {
  it('is held after the restart: the agent stays stopped, Start is refused, and Adopt again copies the folder in whole and starts it', async () => {
    const r = await world();
    const ws = workspace();
    const machineAgain = dieMidCopy(r.w);
    expect((await adopt(r.w, r.id, ws)).statusCode).toBe(500); // the process "died" under the request
    machineAgain();
    expect(r.copied()!.length).toBe(8); // half the archive

    const w = await restart(r.w, r.id);
    const op = w.store.listOperations([r.id])[0]!;
    expect(op).toMatchObject({ kind: 'adopt-workspace', status: 'held', step: 'stopped' });
    expect(op.params).toMatchObject({ from: ws, wasRunning: true });
    expect(op.recovery).toEqual({ actions: [{ action: 'adopt-again', label: 'Adopt again' }], recommended: 'adopt-again' });
    expect(op.outcome).toMatch(/interrupted by a restart while it was being copied in, so its files may be half-replaced/);
    expect(w.store.getAgent(r.id)!.state).toBe('STOPPED');
    expect(await r.phase()).toBe('stopped');

    // Start waits for the owner's choice; so does another adopt.
    const s = await start(w, r.id);
    expect(s.statusCode).toBe(409);
    expect(s.json().error).toMatch(/half-replaced.*Choose what to do on its page first/s);
    expect((await adopt(w, r.id, ws)).statusCode).toBe(409);
    const page = (await w.f.inject({ method: 'GET', url: `/v1/agents/${r.id}`, headers: as() })).json();
    expect(page.operation).toMatchObject({ kind: 'adopt-workspace', status: 'held', kindLabel: 'Workspace adopt' });

    // The folder is there: starting it as it is is not one of the choices.
    expect((await recover(w, op.id, 'start-as-is')).statusCode).toBe(400);
    expect(r.copied()!.length).toBe(8);

    const again = await recover(w, op.id, 'adopt-again');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().operation).toMatchObject({ status: 'succeeded' });
    expect(r.copied()!.length).toBeGreaterThan(8);
    expect(r.copied()!.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // a whole gzip archive
    expect(w.store.getAgent(r.id)!.state).toBe('RUNNING');
    expect(await r.phase()).toBe('running');
    expect(operationRefusal(w.store, r.id)).toBeUndefined();
    w.routes!.stop();
  });

  it('the folder gone: said plainly, and Start it as it is is offered and starts it with the files it has', async () => {
    const r = await world();
    const ws = workspace();
    const machineAgain = dieMidCopy(r.w);
    await adopt(r.w, r.id, ws);
    machineAgain();
    rmSync(ws, { recursive: true, force: true });

    const w = await restart(r.w, r.id);
    const op = w.store.listOperations([r.id])[0]!;
    expect(op.status).toBe('held');
    expect(op.outcome).toContain(`No such folder on this machine: ${ws}`);
    expect(op.recovery).toEqual({
      actions: [{ action: 'adopt-again', label: 'Adopt again' }, { action: 'start-as-is', label: 'Start it as it is' }],
      recommended: 'start-as-is',
    });
    expect((await start(w, r.id)).statusCode).toBe(409);

    // Adopting again cannot work: said so, and it stays held.
    const again = await recover(w, op.id, 'adopt-again');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/cannot be copied from again.*No such folder on this machine/s);
    expect(w.store.getOperation(op.id)!.status).toBe('held');
    expect(w.store.getAgent(r.id)!.state).toBe('STOPPED');

    const asIs = await recover(w, op.id, 'start-as-is');
    expect(asIs.statusCode, asIs.body).toBe(200);
    expect(asIs.json().operation.status).toBe('succeeded');
    expect(r.copied()!.length).toBe(8); // nothing copied: as it is
    expect(w.store.getAgent(r.id)!.state).toBe('RUNNING');
    expect(await r.phase()).toBe('running');
    w.routes!.stop();
  });

  it('a folder that comes back after Start it as it is was offered: that choice is refused and the hold offers Adopt again only', async () => {
    const r = await world();
    const ws = workspace();
    const machineAgain = dieMidCopy(r.w);
    await adopt(r.w, r.id, ws);
    machineAgain();
    rmSync(ws, { recursive: true, force: true });
    const w = await restart(r.w, r.id);
    const op = w.store.listOperations([r.id])[0]!;
    expect(op.recovery!.actions.map((a) => a.action)).toEqual(['adopt-again', 'start-as-is']);

    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'SOUL.md'), 'back again\n');
    const asIs = await recover(w, op.id, 'start-as-is');
    expect(asIs.statusCode).toBe(409);
    expect(asIs.json().error).toMatch(/is there to copy from again/);
    expect(w.store.getOperation(op.id)).toMatchObject({ status: 'held', recovery: { actions: [{ action: 'adopt-again', label: 'Adopt again' }] } });
    expect(w.store.getAgent(r.id)!.state).toBe('STOPPED');
    w.routes!.stop();
  });

  it('cut off before anything was copied: put back as it was, and started again', async () => {
    const r = await world();
    const ws = workspace();
    // Dead as it stopped the agent, before the copy began.
    setStepHookForTests((_op, k) => { if (k === 'stopped') throw new SimulatedCrash(); });
    await adopt(r.w, r.id, ws);
    expect(await r.phase()).toBe('stopped');
    const w = await restart(r.w, r.id);
    const op = w.store.listOperations([r.id])[0]!;
    expect(op).toMatchObject({ kind: 'adopt-workspace', status: 'rolled_back', step: 'packed' });
    expect(op.outcome).toMatch(/before anything was copied in/);
    expect(r.copied()).toBeUndefined();
    expect(w.store.getAgent(r.id)!.state).toBe('RUNNING');
    expect(await r.phase()).toBe('running');
    w.routes!.stop();
  });

  it('cut off once the copy was whole: finished, and started again', async () => {
    const r = await world();
    const ws = workspace();
    setStepHookForTests((_op, k) => { if (k === 'started') throw new SimulatedCrash(); });
    await adopt(r.w, r.id, ws);
    const w = await restart(r.w, r.id);
    const op = w.store.listOperations([r.id])[0]!;
    expect(op).toMatchObject({ kind: 'adopt-workspace', status: 'succeeded' });
    expect(r.copied()!.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(w.store.getAgent(r.id)!.state).toBe('RUNNING');
    expect(await r.phase()).toBe('running');
    w.routes!.stop();
  });
});

describe('an adopt whose copy fails part way (HB-0980)', () => {
  it('is held at once: the answer says so, Start is refused, and Adopt again puts it right', async () => {
    const r = await world();
    const ws = workspace();
    const real = r.w.provider.importWorkspace.bind(r.w.provider);
    r.w.provider.importWorkspace = async (ref, slug, data) => {
      r.w.provider.workspaceStore.set(`${ref}:${slug}`, data.subarray(0, 8));
      throw new Error('fixture: broken pipe');
    };
    const res = await adopt(r.w, r.id, ws);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/failed part way.*left stopped.*Adopt again/s);
    const op = r.w.store.listOperations([r.id])[0]!;
    expect(op).toMatchObject({ kind: 'adopt-workspace', status: 'held' });
    expect(op.recovery!.actions.map((a) => a.action)).toEqual(['adopt-again']);
    expect(r.w.store.getAgent(r.id)!.state).toBe('STOPPED');
    expect((await start(r.w, r.id)).statusCode).toBe(409);

    r.w.provider.importWorkspace = real;
    const again = await recover(r.w, op.id, 'adopt-again');
    expect(again.statusCode, again.body).toBe(200);
    expect(r.copied()!.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(r.w.store.getAgent(r.id)!.state).toBe('RUNNING');
    r.w.routes!.stop();
  });

  it('a volume that is gone: nothing was copied, so nothing is held and a Rebuild is not refused', async () => {
    const r = await world();
    r.w.provider.goneVolumes.add(r.ref);
    const res = await adopt(r.w, r.id, workspace());
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Nothing was copied in/);
    expect(r.w.store.listOperations([r.id])[0]).toMatchObject({ kind: 'adopt-workspace', status: 'failed' });
    expect(operationRefusal(r.w.store, r.id)).toBeUndefined();
    r.w.routes!.stop();
  });

  it('an adopt that ends is recorded and over: nothing is held, Start is not refused', async () => {
    const r = await world();
    const res = await adopt(r.w, r.id, workspace());
    expect(res.statusCode, res.body).toBe(200);
    const op = r.w.store.listOperations([r.id])[0]!;
    expect(op).toMatchObject({ kind: 'adopt-workspace', status: 'succeeded', step: 'started' });
    expect(operationRefusal(r.w.store, r.id)).toBeUndefined();
    r.w.routes!.stop();
  });
});

/** The copy fails every time while the folder is there (a full disk): Adopt again cannot put it right. */
function copyAlwaysFails(w: World): void {
  w.provider.importWorkspace = async (ref, slug, data) => {
    w.provider.workspaceStore.set(`${ref}:${slug}`, data.subarray(0, 8));
    throw new Error('fixture: tar: write error: No space left on device');
  };
}
const del = (w: World, id: string) => w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}`, headers: as() });

describe('a held adopt is never a dead end: Delete goes through it (HB-0980 review)', () => {
  it('a copy that fails every time: Adopt again stays held, Start and Rebuild are refused, and Delete removes it and ends the hold', async () => {
    const r = await world();
    copyAlwaysFails(r.w);
    const res = await adopt(r.w, r.id, workspace());
    expect(res.statusCode).toBe(400);
    const op = r.w.store.listOperations([r.id])[0]!;
    // The answer names the held operation and what failed, for the web app's and the CLI's cleanup.
    expect(res.json()).toMatchObject({ code: 'adopt-held', operation: op.id, detail: 'fixture: tar: write error: No space left on device' });
    expect(res.json().error).toMatch(/Or delete it\.$/);
    expect((await recover(r.w, op.id, 'adopt-again')).statusCode).toBe(409);
    expect(r.w.store.getOperation(op.id)!.status).toBe('held');
    expect((await start(r.w, r.id)).statusCode).toBe(409);
    expect((await r.w.f.inject({ method: 'POST', url: `/v1/agents/${r.id}/rebuild`, headers: as() })).statusCode).toBe(409);

    const gone = await del(r.w, r.id);
    expect(gone.statusCode, gone.body).toBe(200);
    expect(r.w.store.getAgent(r.id)!.state).toBe('DELETED');
    expect(await r.phase()).toBe('absent'); // its volume went with it
    expect(r.w.store.getOperation(op.id)).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/deleted while this waited for your choice/) });
    expect(operationRefusal(r.w.store, r.id)).toBeUndefined();
    r.w.routes!.stop();
  });

  it('a Delete that cannot remove the runtime keeps the hold: Start still waits, and Delete again finishes it', async () => {
    const r = await world();
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, workspace());
    const op = r.w.store.listOperations([r.id])[0]!;
    const destroy = r.w.provider.destroy.bind(r.w.provider);
    r.w.provider.destroy = async () => { throw new Error('fixture: docker did not answer'); };
    expect((await del(r.w, r.id)).statusCode).toBe(502);
    expect(r.w.store.getOperation(op.id)!.status).toBe('held');
    expect(operationRefusal(r.w.store, r.id)).toMatch(/half-replaced/);
    r.w.provider.destroy = destroy;
    expect((await del(r.w, r.id)).statusCode).toBe(200);
    expect(r.w.store.getOperation(op.id)!.status).toBe('failed');
    r.w.routes!.stop();
  });

  it('Adopt again is refused once a Delete is under way (it does not take the busy flag)', async () => {
    const r = await world();
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, workspace());
    const op = r.w.store.listOperations([r.id])[0]!;
    let release!: () => void;
    r.w.provider.destroy = () => new Promise<void>((done) => { release = done; });
    const deleting = del(r.w, r.id);
    await new Promise((d) => setTimeout(d, 20));
    expect(r.w.store.getAgent(r.id)!.state).toBe('DELETING');
    const again = await recover(r.w, op.id, 'adopt-again');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/being deleted/);
    release();
    expect((await deleting).statusCode).toBe(200);
    r.w.routes!.stop();
  });

  it('a hold of another kind still refuses Delete', async () => {
    const r = await world();
    const held = beginOperation(r.w.store, 'restore-backup', r.id, { set: 'fixture-set' });
    held.hold('The restore was cut off part way.', { actions: [{ action: 'retry', label: 'Try again' }], recommended: 'retry' });
    const refused = await del(r.w, r.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/Choose what to do on its page first/);
    expect(r.w.store.getAgent(r.id)!.state).toBe('RUNNING');
    expect(r.w.store.getOperation(held.id)!.status).toBe('held');
    r.w.routes!.stop();
  });
});

describe('a first adopt whose start fails once the copy is whole (HB-0980 review)', () => {
  it('is finished, says it could not be started, and still owes the repoint of its own paths and tasks', async () => {
    const r = await world();
    const ws = workspace();
    // The workspace is an OpenClaw agent's here, so its own paths and tasks are re-pointed once it runs.
    writeFileSync(process.env.OPENCLAW_CONFIG!, JSON.stringify({ agents: { list: [{ id: 'pantry-old', workspace: ws }] } }));
    try {
      const real = r.w.provider.start.bind(r.w.provider);
      r.w.provider.start = async () => { r.w.provider.start = real; throw new Error('fixture: docker did not answer'); };
      const res = await adopt(r.w, r.id, ws);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/copied in whole, but it could not be started \(fixture: docker did not answer\): start it once its machine answers/);
      // Said apart from a torn copy, so the web app and the CLI keep the agent the copy is in (HB-0980 re-review).
      expect(res.json().code).toBe('adopt-not-started');
      const op = r.w.store.listOperations([r.id])[0]!;
      expect(op).toMatchObject({ kind: 'adopt-workspace', status: 'succeeded', step: 'copied' });
      expect(r.copied()!.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
      expect(r.w.store.getAgent(r.id)!.state).toBe('STOPPED');
      expect(operationRefusal(r.w.store, r.id)).toBeUndefined();
      expect(r.w.store.listAdoptPending()).toMatchObject([{ agentId: r.id, path: ws }]);
    } finally {
      rmSync(process.env.OPENCLAW_CONFIG!, { force: true });
    }
    r.w.routes!.stop();
  });
});

describe('Start it as it is starts it as Start does, and only if it ran (HB-0980 review)', () => {
  /** A torn copy held on the agent, and its folder gone since, so the way out is offered. */
  async function heldWithFolderGone(r: Awaited<ReturnType<typeof world>>) {
    const ws = workspace();
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, ws);
    const op = r.w.store.listOperations([r.id])[0]!;
    rmSync(ws, { recursive: true, force: true });
    expect((await recover(r.w, op.id, 'adopt-again')).statusCode).toBe(409); // told the folder is gone
    return r.w.store.getOperation(op.id)!;
  }

  it('an agent stopped before the adopt: offered as Keep it as it is, the hold ends and it stays stopped', async () => {
    const r = await world();
    await r.w.f.inject({ method: 'POST', url: `/v1/agents/${r.id}/stop`, headers: as() });
    const op = await heldWithFolderGone(r);
    expect(op.params).toMatchObject({ wasRunning: false });
    expect(op.recovery).toEqual({ actions: [{ action: 'adopt-again', label: 'Adopt again' }, { action: 'start-as-is', label: 'Keep it as it is' }], recommended: 'start-as-is' });
    expect(op.outcome).toMatch(/Keep it as it is ends this with the files it has now; it stays stopped, as it was before the adopt\./);
    const kept = await recover(r.w, op.id, 'start-as-is');
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json().operation).toMatchObject({ status: 'succeeded', outcome: expect.stringMatching(/It stays stopped, as it was before the adopt\./) });
    expect(r.w.store.getAgent(r.id)!.state).toBe('STOPPED');
    expect(await r.phase()).toBe('stopped');
    // Over: an ordinary Start now.
    expect((await start(r.w, r.id)).statusCode).toBe(200);
    r.w.routes!.stop();
  });

  it('a stopped agent owed a rebuild at its next start: not started on its old container; the rebuild is still owed', async () => {
    const r = await world();
    await r.w.f.inject({ method: 'POST', url: `/v1/agents/${r.id}/stop`, headers: as() });
    r.w.store.setRebuildOnStart(r.id, new Date().toISOString());
    const op = await heldWithFolderGone(r);
    expect((await recover(r.w, op.id, 'start-as-is')).statusCode).toBe(200);
    expect(await r.phase()).toBe('stopped');
    expect(r.w.store.getAgent(r.id)!.rebuildOnStart).toBeTruthy();
    r.w.routes!.stop();
  });

  it('an agent that ran, owed a rebuild by a change saved while it was held: started as Start starts it, which is that rebuild', async () => {
    const r = await world();
    const op = await heldWithFolderGone(r);
    expect(op.recovery!.actions.map((a) => a.label)).toEqual(['Adopt again', 'Start it as it is']);
    r.w.store.setRebuildOnStart(r.id, new Date().toISOString());
    const asIs = await recover(r.w, op.id, 'start-as-is');
    expect(asIs.statusCode, asIs.body).toBe(200);
    expect(asIs.json().operation.status).toBe('succeeded');
    expect(r.w.store.listEvents([r.id]).map((e) => e.event)).toContain('rebuild.on_start');
    await rebuilt(r.w, r.id);
    r.w.routes!.stop();
  });

  it('an agent that ran, nothing owed: started, and up', async () => {
    const r = await world();
    const op = await heldWithFolderGone(r);
    const asIs = await recover(r.w, op.id, 'start-as-is');
    expect(asIs.statusCode, asIs.body).toBe(200);
    expect(r.w.store.getAgent(r.id)!.state).toBe('RUNNING');
    expect(await r.phase()).toBe('running');
    r.w.routes!.stop();
  });
});

/** The entries of a gzipped tar the adopt packed (ustar: a 512-byte header, then the data in 512-byte blocks). */
function untar(data: Buffer): Array<{ name: string; body: Buffer }> {
  const raw = gunzipSync(data), out: Array<{ name: string; body: Buffer }> = [];
  const text = (at: number, len: number) => raw.subarray(at, at + len).toString('utf8').replace(/\0.*$/s, '');
  for (let at = 0; at + 512 <= raw.length;) {
    const name = text(at, 100);
    if (!name) break;
    const size = parseInt(text(at + 124, 12).trim() || '0', 8), type = text(at + 156, 1), prefix = text(at + 345, 155);
    const body = raw.subarray(at + 512, at + 512 + size);
    if (type === '0' || type === '') out.push({ name: (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, ''), body: Buffer.from(body) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/**
 * The workspace folder as a real extract leaves it: each file the archive
 * holds written over what is there, and every other file kept. `tornAt`: the
 * copy dies part way through that file, as a full disk would leave it.
 */
function extractsOver(w: World) {
  const files = new Map<string, Buffer>();
  let tornAt: string | undefined;
  w.provider.importWorkspace = async (_ref, _slug, data) => {
    for (const e of untar(data)) {
      if (e.name === tornAt) {
        files.set(e.name, e.body.subarray(0, 100));
        tornAt = undefined;
        throw new Error('fixture: tar: write error: No space left on device');
      }
      files.set(e.name, e.body);
    }
  };
  return { files, tearAt: (name: string) => { tornAt = name; } };
}

describe('Adopt again copies over what the cut-off copy left (HB-0980 review)', () => {
  it('a file the cut-off copy left half-written, and the folder no longer has, stays as it was left: the hold and the outcome say so', async () => {
    const r = await world();
    const ws = workspace();
    writeFileSync(join(ws, 'memory', 'pantry-long.md'), 'Shelf notes. '.repeat(200));
    const box = extractsOver(r.w);
    box.tearAt('memory/pantry-long.md');
    expect((await adopt(r.w, r.id, ws)).statusCode).toBe(400);
    const op = r.w.store.listOperations([r.id])[0]!;
    expect(op.status).toBe('held');
    expect(op.outcome).toMatch(/Adopt again copies every file in the folder in again, whole; one the cut-off copy wrote that the folder no longer has stays as it was left\.$/);
    expect(op.outcome).not.toMatch(/copies the folder in again, whole\./); // what it said before: not so
    expect(box.files.get('memory/pantry-long.md')!.length).toBe(100);

    // Renamed in the folder since: Adopt again writes every file it has, whole, over the rest.
    renameSync(join(ws, 'memory', 'pantry-long.md'), join(ws, 'memory', 'pantry-shelves.md'));
    const again = await recover(r.w, op.id, 'adopt-again');
    expect(again.statusCode, again.body).toBe(200);
    expect(box.files.get('memory/pantry-shelves.md')!.length).toBe(2600);
    expect(box.files.get('SOUL.md')!.toString()).toBe('You keep the pantry list.\n');
    // What the cut-off copy left of the file the folder no longer has: still there, as it was left.
    expect(box.files.get('memory/pantry-long.md')!.length).toBe(100);
    expect(r.w.store.getOperation(op.id)!.outcome).toMatch(/^Adopted the workspace from .* again: every file in it copied in whole\. One the cut-off copy wrote that the folder no longer has may still be there, as it was left\. It was started again, as Start starts it\.$/);
    r.w.routes!.stop();
  });
});

describe('every start an adopt makes after a hold or a restart is a Start (HB-0980 re-review)', () => {
  const events = (w: World, id: string) => w.store.listEvents([id]).map((e) => e.event);

  it('Adopt again on an agent that ran, owed a rebuild by a change saved during the hold: that rebuild is its start', async () => {
    const r = await world();
    const real = r.w.provider.importWorkspace.bind(r.w.provider);
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, workspace());
    const op = r.w.store.listOperations([r.id])[0]!;
    r.w.provider.importWorkspace = real;
    r.w.store.setRebuildOnStart(r.id, new Date().toISOString());
    const again = await recover(r.w, op.id, 'adopt-again');
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().operation.status).toBe('succeeded');
    expect(events(r.w, r.id)).toContain('rebuild.on_start');
    await rebuilt(r.w, r.id);
    r.w.routes!.stop();
  });

  it('Adopt again on an agent stopped before the adopt: copied in, and left stopped', async () => {
    const r = await world();
    await r.w.f.inject({ method: 'POST', url: `/v1/agents/${r.id}/stop`, headers: as() });
    const real = r.w.provider.importWorkspace.bind(r.w.provider);
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, workspace());
    const op = r.w.store.listOperations([r.id])[0]!;
    r.w.provider.importWorkspace = real;
    r.w.store.setRebuildOnStart(r.id, new Date().toISOString());
    expect((await recover(r.w, op.id, 'adopt-again')).statusCode).toBe(200);
    expect(r.w.store.getAgent(r.id)!.state).toBe('STOPPED');
    expect(await r.phase()).toBe('stopped');
    expect(events(r.w, r.id)).not.toContain('rebuild.on_start');
    expect(r.w.store.getAgent(r.id)!.rebuildOnStart).toBeTruthy();
    r.w.routes!.stop();
  });

  it('a restart after the stop, before the copy, owed a rebuild meanwhile: started again by that rebuild', async () => {
    const r = await world();
    setStepHookForTests((_op, k) => { if (k === 'stopped') throw new SimulatedCrash(); });
    await adopt(r.w, r.id, workspace());
    expect(await r.phase()).toBe('stopped');
    r.w.store.setRebuildOnStart(r.id, new Date().toISOString());
    const w = await restart(r.w, r.id);
    expect(adoptOp(w, r.id)).toMatchObject({ status: 'rolled_back', step: 'packed' });
    expect(events(w, r.id)).toContain('rebuild.on_start');
    await rebuilt(w, r.id);
    w.routes!.stop();
  });

  it('a restart once the copy was whole, before its start, owed a rebuild meanwhile: started by that rebuild', async () => {
    const r = await world();
    const real = r.w.provider.start.bind(r.w.provider);
    r.w.provider.start = async () => { throw new SimulatedCrash(); }; // the process dies as it starts the agent
    await adopt(r.w, r.id, workspace());
    r.w.provider.start = real;
    expect(r.w.store.listOperations([r.id])[0]).toMatchObject({ step: 'copied' });
    expect(await r.phase()).toBe('stopped');
    r.w.store.setRebuildOnStart(r.id, new Date().toISOString());
    const w = await restart(r.w, r.id);
    expect(adoptOp(w, r.id)).toMatchObject({ status: 'succeeded', step: 'copied' });
    expect(events(w, r.id)).toContain('rebuild.on_start');
    await rebuilt(w, r.id);
    w.routes!.stop();
  });

  it('Adopt again whose start fails: the copy is whole and finished, it is stopped, and the record and the answer say so', async () => {
    const r = await world();
    const real = { copy: r.w.provider.importWorkspace.bind(r.w.provider), start: r.w.provider.start.bind(r.w.provider) };
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, workspace());
    const op = r.w.store.listOperations([r.id])[0]!;
    r.w.provider.importWorkspace = real.copy;
    r.w.provider.start = async () => { throw new Error('fixture: docker did not answer'); };
    const again = await recover(r.w, op.id, 'adopt-again');
    r.w.provider.start = real.start;
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/^Adopted again, every file in it whole, but it could not be started: fixture: docker did not answer Start it once its machine answers\.$/);
    expect(adoptOp(r.w, r.id)).toMatchObject({ status: 'succeeded', step: 'copied' });
    expect(adoptOp(r.w, r.id).outcome).toMatch(/It could not be started \(fixture: docker did not answer\), so it is stopped: start it once that is put right\.$/);
    expect(r.w.store.getAgent(r.id)!.state).toBe('STOPPED');
    expect(events(r.w, r.id)).toContain('op.start_failed');
    r.w.routes!.stop();
  });

  it('a restart after the stop whose start fails: as it was, stopped, and the record says why', async () => {
    const r = await world();
    setStepHookForTests((_op, k) => { if (k === 'stopped') throw new SimulatedCrash(); });
    await adopt(r.w, r.id, workspace());
    const real = r.w.provider.start.bind(r.w.provider);
    r.w.provider.start = async () => { throw new Error('fixture: docker did not answer'); };
    const w = await restart(r.w, r.id);
    w.provider.start = real;
    expect(adoptOp(w, r.id)).toMatchObject({ status: 'rolled_back', step: 'packed' });
    expect(adoptOp(w, r.id).outcome).toMatch(/it is as it was\. It could not be started \(fixture: docker did not answer\), so it is stopped: start it once that is put right\.$/);
    expect(w.store.getAgent(r.id)!.state).toBe('STOPPED');
    expect(await r.phase()).toBe('stopped');
    expect(events(w, r.id)).toContain('op.start_failed');
    w.routes!.stop();
  });

  it('a restart before it was stopped: nothing to start, it runs as it did', async () => {
    const r = await world();
    setStepHookForTests((_op, k) => { if (k === 'packed') throw new SimulatedCrash(); });
    await adopt(r.w, r.id, workspace());
    expect(await r.phase()).toBe('running');
    const w = await restart(r.w, r.id);
    expect(w.store.listOperations([r.id])[0]).toMatchObject({ status: 'rolled_back' });
    expect(w.store.getAgent(r.id)!.state).toBe('RUNNING');
    expect(await r.phase()).toBe('running');
    w.routes!.stop();
  });
});

describe('the start an adopt owes is on its record until it has run, so a restart before it or during it still starts it (HB-0980 re-review, P10)', () => {
  const owes = (w: World, id: string) => (adoptOp(w, id).params as { startOwed?: unknown }).startOwed !== undefined;
  /** Held on a torn copy of an agent that ran, the folder there to copy from again. */
  async function held(r: Awaited<ReturnType<typeof world>>) {
    const real = r.w.provider.importWorkspace.bind(r.w.provider);
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, workspace());
    r.w.provider.importWorkspace = real;
    return adoptOp(r.w, r.id);
  }

  it('Adopt again, then a restart before its Start: the next boot starts it, once, and the record says so', async () => {
    const r = await world();
    const op = await held(r);
    setStepHookForTests((_op, k) => { if (k === '#start-owed') throw new SimulatedCrash(); });
    await recover(r.w, op.id, 'adopt-again').catch(() => undefined);
    setStepHookForTests(undefined);
    expect(adoptOp(r.w, r.id)).toMatchObject({ status: 'succeeded' });
    expect(owes(r.w, r.id)).toBe(true);
    expect(await r.phase()).toBe('stopped');
    const w = await restart(r.w, r.id);
    expect(await r.phase()).toBe('running');
    expect(w.store.getAgent(r.id)!.state).toBe('RUNNING');
    expect(owes(w, r.id)).toBe(false);
    expect(adoptOp(w, r.id).outcome).toMatch(/copied in whole\. .* It was started again, as Start starts it\.$/);
    // Once: stopped by its owner since, the boot after leaves it stopped.
    await w.f.inject({ method: 'POST', url: `/v1/agents/${r.id}/stop`, headers: as() });
    const w2 = await restart(w, r.id);
    expect(await r.phase()).toBe('stopped');
    expect(w2.store.getAgent(r.id)!.state).toBe('STOPPED');
    w2.routes!.stop();
  });

  it('Adopt again, then a restart during its Start: the next boot starts it', async () => {
    const r = await world();
    const op = await held(r);
    const real = r.w.provider.start.bind(r.w.provider);
    r.w.provider.start = async () => { throw new SimulatedCrash(); };
    await recover(r.w, op.id, 'adopt-again').catch(() => undefined);
    r.w.provider.start = real;
    expect(owes(r.w, r.id)).toBe(true);
    const w = await restart(r.w, r.id);
    expect(await r.phase()).toBe('running');
    expect(owes(w, r.id)).toBe(false);
    w.routes!.stop();
  });

  it('Start it as it is, then a restart before its Start: the next boot starts it; the record said no start until it ran', async () => {
    const r = await world();
    const ws = workspace();
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, ws);
    const op = adoptOp(r.w, r.id);
    rmSync(ws, { recursive: true, force: true });
    expect((await recover(r.w, op.id, 'adopt-again')).statusCode).toBe(409);
    setStepHookForTests((_op, k) => { if (k === '#start-owed') throw new SimulatedCrash(); });
    await recover(r.w, op.id, 'start-as-is').catch(() => undefined);
    setStepHookForTests(undefined);
    expect(adoptOp(r.w, r.id).outcome).toMatch(/could not be copied from again\.$/);
    const w = await restart(r.w, r.id);
    expect(await r.phase()).toBe('running');
    expect(adoptOp(w, r.id).outcome).toMatch(/could not be copied from again\. It was started again, as Start starts it\.$/);
    w.routes!.stop();
  });

  it('a restart after the stop, then another during the Start that boot made: the boot after starts it', async () => {
    const r = await world();
    setStepHookForTests((_op, k) => { if (k === 'stopped') throw new SimulatedCrash(); });
    await adopt(r.w, r.id, workspace());
    const real = r.w.provider.start.bind(r.w.provider);
    r.w.provider.start = async () => { throw new SimulatedCrash(); };
    const w = await restart(r.w, r.id);
    w.provider.start = real;
    expect(adoptOp(w, r.id)).toMatchObject({ status: 'rolled_back' });
    expect(owes(w, r.id)).toBe(true);
    expect(await r.phase()).toBe('stopped');
    const w2 = await restart(w, r.id);
    expect(await r.phase()).toBe('running');
    expect(owes(w2, r.id)).toBe(false);
    expect(adoptOp(w2, r.id).outcome).toMatch(/it is as it was\. It was started again, as Start starts it\.$/);
    w2.routes!.stop();
  });

  /** A new process over the same database, serving requests before its boot pass has run (a move check can hold that pass for minutes). */
  async function servingBeforeItsPass(w: World, id: string): Promise<World> {
    setStepHookForTests(undefined);
    clearBusy(id);
    newBootForTests();
    return restartWorld(w);
  }

  it('a restart leaves its start owed, and its owner starts it and stops it again before the boot pass: it stays stopped, owed nothing', async () => {
    const r = await world();
    const op = await held(r);
    setStepHookForTests((_op, k) => { if (k === '#start-owed') throw new SimulatedCrash(); });
    await recover(r.w, op.id, 'adopt-again').catch(() => undefined);
    const w = await servingBeforeItsPass(r.w, r.id);
    expect(owes(w, r.id)).toBe(true);
    expect((await start(w, r.id)).statusCode).toBe(200);
    expect(owes(w, r.id)).toBe(false);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${r.id}/stop`, headers: as() })).statusCode).toBe(200);
    await w.routes!.resumeOperations();
    expect(w.store.getAgent(r.id)!.state).toBe('STOPPED');
    expect(await r.phase()).toBe('stopped');
    expect(adoptOp(w, r.id).outcome).toMatch(/copied in whole\. .* Its owner has started it since\.$/);
    w.routes!.stop();
  });

  it('started some other way after a restart left its start owed, then stopped by its owner: the boot pass leaves it stopped', async () => {
    const r = await world();
    const op = await held(r);
    setStepHookForTests((_op, k) => { if (k === '#start-owed') throw new SimulatedCrash(); });
    await recover(r.w, op.id, 'adopt-again').catch(() => undefined);
    const w = await servingBeforeItsPass(r.w, r.id);
    // Up without its owner's Start (a wake for a message starts the container it has).
    await w.provider.start(r.ref);
    w.store.setAgentState(r.id, 'RUNNING');
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/${r.id}/stop`, headers: as() })).statusCode).toBe(200);
    expect(owes(w, r.id)).toBe(false);
    await w.routes!.resumeOperations();
    expect(w.store.getAgent(r.id)!.state).toBe('STOPPED');
    expect(await r.phase()).toBe('stopped');
    expect(adoptOp(w, r.id).outcome).toMatch(/Its owner has stopped it since, so it stays stopped\.$/);
    w.routes!.stop();
  });

  it('its owner stops it just as the boot pass comes to its start (the pass had read it as owed): not started', async () => {
    const r = await world();
    const op = await held(r);
    setStepHookForTests((_op, k) => { if (k === '#start-owed') throw new SimulatedCrash(); });
    await recover(r.w, op.id, 'adopt-again').catch(() => undefined);
    const w = await servingBeforeItsPass(r.w, r.id);
    setStepHookForTests((_op, k) => { if (k === '#start-owed') settleStartsOwedOn(w.store, r.id, 'owner-stop'); });
    await w.routes!.resumeOperations();
    setStepHookForTests(undefined);
    expect(w.store.getAgent(r.id)!.state).toBe('STOPPED');
    expect(await r.phase()).toBe('stopped');
    expect(owes(w, r.id)).toBe(false);
    expect(adoptOp(w, r.id).outcome).toMatch(/copied in whole\. .* Its owner has stopped it since, so it stays stopped\.$/);
    w.routes!.stop();
  });

  it('a start still owed for an agent no longer stopped is owed nothing: not started, and taken off the record', async () => {
    const r = await world();
    const op = await held(r);
    setStepHookForTests((_op, k) => { if (k === '#start-owed') throw new SimulatedCrash(); });
    await recover(r.w, op.id, 'adopt-again').catch(() => undefined);
    setStepHookForTests(undefined);
    // Up some other way before the restart: a wake for a message starts the container it has
    // (its owner's own Start would have settled it: the tests above).
    await r.w.provider.start(r.ref);
    r.w.store.setAgentState(r.id, 'RUNNING');
    const starts: string[] = [];
    const real = r.w.provider.start.bind(r.w.provider);
    r.w.provider.start = async (ref) => { starts.push(ref); return real(ref); };
    const w = await restart(r.w, r.id);
    w.provider.start = real;
    expect(starts).toEqual([]);
    expect(owes(w, r.id)).toBe(false);
    expect(adoptOp(w, r.id).outcome).toMatch(/as it was left\.$/);
    w.routes!.stop();
  });
});

describe('a start a restart left is the machine’s own, the owner’s choice is the owner’s (HB-0980 re-review)', () => {
  const events = (w: World, id: string) => w.store.listEvents([id]).map((e) => e.event);
  /** Its peers changed while it was down: what only the owner's own Start rebuilds for (power.ts rebuildOwedAtStart). */
  async function peersChanged(w: World, id: string) {
    // What its container was built with (none), recorded as a provision records it: a
    // record never made is taken as the peers it has when the store is opened (store.ts).
    w.store.recordAppliedPeers(id);
    await seedRunningAgent(w, { id: 'a2', name: 'Meal Planner', slug: 'meal-planner', accountId: 'made_up_meal_bot', botToken: 'made-up-meal-token' });
    w.store.setAgentPeers(id, ['a2']);
  }

  it('a restart after the stop, its peers changed meanwhile: started again on its container, not rebuilt for that', async () => {
    const r = await world();
    setStepHookForTests((_op, k) => { if (k === 'stopped') throw new SimulatedCrash(); });
    await adopt(r.w, r.id, workspace());
    await peersChanged(r.w, r.id);
    const w = await restart(r.w, r.id);
    expect(events(w, r.id)).not.toContain('rebuild.on_start');
    expect(await r.phase()).toBe('running');
    expect(adoptOp(w, r.id).outcome).toMatch(/It was started again, as Start starts it\.$/);
    w.routes!.stop();
  });

  it('Adopt again, a restart before its Start, its peers changed meanwhile: the boot starts it on its container', async () => {
    const r = await world();
    const real = r.w.provider.importWorkspace.bind(r.w.provider);
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, workspace());
    r.w.provider.importWorkspace = real;
    setStepHookForTests((_op, k) => { if (k === '#start-owed') throw new SimulatedCrash(); });
    await recover(r.w, adoptOp(r.w, r.id).id, 'adopt-again').catch(() => undefined);
    setStepHookForTests(undefined);
    await peersChanged(r.w, r.id);
    const w = await restart(r.w, r.id);
    expect(events(w, r.id)).not.toContain('rebuild.on_start');
    expect(await r.phase()).toBe('running');
    expect(adoptOp(w, r.id).outcome).toMatch(/It was started again, as Start starts it\.$/);
    w.routes!.stop();
  });

  it('Adopt again, its peers changed while it was held: the owner’s choice is the owner’s Start, rebuilt for them', async () => {
    const r = await world();
    const real = r.w.provider.importWorkspace.bind(r.w.provider);
    copyAlwaysFails(r.w);
    await adopt(r.w, r.id, workspace());
    r.w.provider.importWorkspace = real;
    await peersChanged(r.w, r.id);
    const again = await recover(r.w, adoptOp(r.w, r.id).id, 'adopt-again');
    expect(again.statusCode, again.body).toBe(200);
    expect(events(r.w, r.id)).toContain('rebuild.on_start');
    expect(adoptOp(r.w, r.id).outcome).toMatch(/Its start is the rebuild it was owed\.$/);
    await rebuilt(r.w, r.id);
    r.w.routes!.stop();
  });
});
