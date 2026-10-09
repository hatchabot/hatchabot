/**
 * Long changes in the background (docs/operations-and-one-interface-design.md,
 * phase 3): a move, a move to another Hatchabot, a full-copy import and a
 * snapshot restore answer 202 { operation } once they are validated and have
 * begun, and go on after the answer. Their refusals stay the request's
 * answer; `?wait=1` keeps the old shape; the other Hatchabot's side of a move
 * (POST /v1/agents/restore) stays synchronous. The Activity list shows one row
 * per operation, its steps inside.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockProvider } from '../src/providers/mockProvider.js';
import { beginOperation, operationSummary, operationTitles, runInBackground, spanWords } from '../src/orchestrator/operations.js';
import { followOperation } from '../src/mgmt/broker.js';
import { exportAgent, importAgent } from '../src/orchestrator/transfer.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

afterEach(() => vi.restoreAllMocks());

const octet = (owner?: string) => ({ ...as(owner), 'content-type': 'application/octet-stream' });

/** A runner whose memory copy waits until the test lets it go: the move is caught in the middle. */
function gatedRunner(w: World) {
  w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
  const runner = new MockProvider();
  w.providers.set('mock2', runner);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const importState = runner.importState.bind(runner);
  runner.importState = async (ref: string, data: Buffer) => { await gate; return importState(ref, data); };
  return { runner, release };
}

const opOf = async (w: World, id: string) => (await w.f.inject({ method: 'GET', url: `/v1/operations/${id}`, headers: as() })).json();

describe('a move answers 202 with its operation and goes on in the background', () => {
  it('202 at once, Working-on words and step n of m while it runs, the outcome when it ends', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    const { release } = gatedRunner(w);
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h2' } });
    expect(r.statusCode).toBe(202);
    const { operation, agent } = r.json();
    expect(operation).toMatchObject({ kind: 'move-host', status: 'running', title: 'Moving to Test Runner', steps: 10 });
    expect(operation.id).toMatch(/^op_/);
    expect(agent).toMatchObject({ id });
    // Caught in the middle: it has stopped here and is copying its memory out to the runner.
    await vi.waitFor(async () => expect((await opOf(w, operation.id)).stepN).toBeGreaterThanOrEqual(4));
    const mid = await opOf(w, operation.id);
    expect(mid).toMatchObject({ status: 'running', title: 'Moving to Test Runner', stepLabel: 'made on the other machine', stepN: 4, steps: 10 });
    // The agent's own view carries it (the sheet's Working on line, the tile's ring).
    const a = (await w.f.inject({ method: 'GET', url: `/v1/agents/${id}`, headers: as() })).json();
    expect(a.operation).toMatchObject({ id: operation.id, status: 'running', stepN: 4, title: 'Moving to Test Runner' });
    // Busy on disk meanwhile: Start is refused with the step it is on.
    const start = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/start`, headers: as() });
    expect(start.statusCode).toBe(409);
    release();
    await vi.waitFor(async () => expect((await opOf(w, operation.id)).status).toBe('succeeded'));
    const done = await opOf(w, operation.id);
    expect(done).toMatchObject({ outcome: 'Moved to Test Runner.', summary: 'Moved to Test Runner', result: { movedTo: 'Test Runner', hostId: 'h2' } });
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h2', state: 'RUNNING' });
  });

  it('?wait=1 keeps the old answer: 200, the agent, the operation id', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
    w.providers.set('mock2', new MockProvider());
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host?wait=1`, headers: as(), payload: { hostId: 'h2' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id, hostId: 'h2', state: 'RUNNING' });
    expect(r.json().operation).toMatch(/^op_/);
  });

  it('its refusals are still the answer, and begin nothing', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    for (const hostId of ['h1', 'nope']) {
      const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId } });
      expect(r.statusCode).toBe(400);
    }
    expect(w.store.listOperations([id])).toEqual([]);
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h1', state: 'RUNNING' });
  });
});

describe('a move to another Hatchabot', () => {
  function peer(w: World, preflight: unknown) {
    w.store.insertPeer({ id: 'peer1', ownerId: w.owner, name: 'Test Peer', url: 'http://peer.example.org', secretRef: 'peer/tok', createdAt: 'now' });
    void w.secrets.put('peer/tok', 'made-up-peer-credential');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/v1/agents/preflight')) return new Response(JSON.stringify(preflight), { status: 200 });
      if (u.includes('/v1/agents/restore')) return new Response(JSON.stringify({ id: 'remote-1', name: 'Test Agent', slug: 'kitchen', state: 'RUNNING' }), { status: 201 });
      if (u.endsWith('/v1/agents')) return new Response(JSON.stringify([{ slug: 'kitchen', state: 'RUNNING' }]), { status: 200 });
      throw new Error(`unexpected fetch ${u}`);
    });
  }

  it('answers 202 after the other server said yes, and tells its id there when done', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    peer(w, { ok: true, reasons: [] });
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rehost`, headers: as(), payload: { peerId: 'peer1' } });
    expect(r.statusCode).toBe(202);
    expect(r.json().operation).toMatchObject({ kind: 'migrate', title: 'Moving to Test Peer' });
    const opId = r.json().operation.id;
    await vi.waitFor(async () => expect((await opOf(w, opId)).status).toBe('succeeded'));
    expect((await opOf(w, opId)).result).toEqual({ movedTo: 'Test Peer', remoteAgentId: 'remote-1' });
  });

  it("the other server's refusal at the preflight is still a 400, and the agent keeps running", async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    peer(w, { ok: false, reasons: ['Its bot is already wired to an agent there.'] });
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/rehost`, headers: as(), payload: { peerId: 'peer1' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/already wired/);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });
});

describe('importing a full copy', () => {
  async function fileOf() {
    const src = await makeWorld();
    await seedRunningAgent(src, { name: 'Test Agent' });
    return (await src.f.inject({ method: 'GET', url: '/v1/agents/a1/backup', headers: as() })).rawPayload;
  }

  it("the other Hatchabot's side of a move (POST /v1/agents/restore) stays synchronous: the agent is in the answer", async () => {
    const file = await fileOf();
    const dst = await makeWorld('owner-b');
    // As migrate.ts posts it: no marker, no query — it reads body.state.
    const r = await dst.f.inject({ method: 'POST', url: '/v1/agents/restore', headers: octet('owner-b'), payload: file });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ state: 'RUNNING', slug: 'kitchen' });
  });

  it('the CLI asks ?async=1 on /restore, and the app imports through /import: both 202 with the operation and the new agent', async () => {
    const file = await fileOf();
    for (const url of ['/v1/agents/restore?async=1', '/v1/agents/import']) {
      const dst = await makeWorld('owner-b');
      const r = await dst.f.inject({ method: 'POST', url, headers: octet('owner-b'), payload: file });
      expect(r.statusCode, url).toBe(202);
      expect(r.json().operation).toMatchObject({ kind: 'import', title: 'Importing' });
      expect(r.json().agent).toMatchObject({ slug: 'kitchen' });
      const opId = r.json().operation.id;
      const op = async () => (await dst.f.inject({ method: 'GET', url: `/v1/operations/${opId}`, headers: as('owner-b') })).json();
      await vi.waitFor(async () => expect((await op()).status).toBe('succeeded'));
      expect(dst.store.getAgent(r.json().agent.id)!.state).toBe('RUNNING');
    }
  });

  it("a file's own refusals come before anything is made — a bot token Telegram rejects leaves no record behind", async () => {
    const src = await makeWorld();
    await seedRunningAgent(src, { name: 'Test Agent' });
    const { data } = await exportAgent({ store: src.store, secrets: src.secrets, provider: src.provider, channel: src.channel }, 'a1');
    const dst = await makeWorld('owner-b');
    const deps = { store: dst.store, secrets: dst.secrets, provider: dst.provider, channel: dst.channel, sleep: async () => {} };
    let begun = false;
    await expect(importAgent(deps, data, { ownerId: 'owner-b', verifyToken: async () => { throw new Error('401'); }, onOperation: () => { begun = true; } }))
      .rejects.toThrow(/Telegram rejected the bot token/);
    // Before v2.156.0 the row and its operation were made first, then rolled back.
    expect(begun).toBe(false);
    expect(dst.store.listOperations(dst.store.listAgents('owner-b').map((a) => a.id))).toEqual([]);
    expect(dst.store.listAllActiveAgents().filter((a) => a.ownerId === 'owner-b')).toEqual([]);
  });
});

describe('a snapshot restore', () => {
  it('202 with the operation; the files restored and the undo snapshot come with the outcome', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    w.provider.execResponses.set('sh', { code: 0, stdout: 'soul text', stderr: '' });
    const snap = (await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/snapshots`, headers: as(), payload: { label: 'before the trip' } })).json();
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/snapshots/${snap.id}/restore`, headers: as(), payload: {} });
    expect(r.statusCode).toBe(202);
    expect(r.json().operation).toMatchObject({ kind: 'restore-snapshot', title: 'Restoring its files from "before the trip"' });
    const opId = r.json().operation.id;
    await vi.waitFor(async () => expect((await opOf(w, opId)).status).toBe('succeeded'));
    const done = await opOf(w, opId);
    expect(done.result.safetySnapshotId).toEqual(expect.any(String));
    expect(Array.isArray(done.result.restored)).toBe(true);
    // A stopped agent is refused synchronously, as before.
    await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/stop`, headers: as() });
    const refused = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/snapshots/${snap.id}/restore`, headers: as(), payload: {} });
    expect(refused.statusCode).toBe(409);
  });
});

describe('Activity: one row per operation', () => {
  it("a move is one row that opens to its steps; its step lines are not rows of their own, and stay in the agent's own timeline", async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent' });
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Test Runner', settings: {}, createdAt: 'now' });
    w.providers.set('mock2', new MockProvider());
    w.store.recordEvent(id, 'member.admitted', { who: 'before the move' });
    await new Promise((r) => setTimeout(r, 5));
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/move-host`, headers: as(), payload: { hostId: 'h2' } });
    const opId = r.json().operation.id;
    await vi.waitFor(async () => expect((await opOf(w, opId)).status).toBe('succeeded'));
    const feed = (await w.f.inject({ method: 'GET', url: '/v1/events?limit=40', headers: as() })).json() as Array<Record<string, any>>;
    const opRows = feed.filter((e) => e.op?.id === opId);
    expect(opRows).toHaveLength(1);
    expect(opRows[0]).toMatchObject({ agentId: id, agentName: 'Test Agent', event: 'op.done', op: { status: 'succeeded', summary: 'Moved to Test Runner' } });
    expect(opRows[0]!.label).toMatch(/^Moved to Test Runner · \d+ s$/);
    expect(opRows[0]!.op.steps.map((s: { label: string }) => s.label)).toEqual(expect.arrayContaining(['its memory copied in (step 5 of 10)', 'Moved to Test Runner.']));
    // No row per step, and none for what the move itself logged (agent.moved…).
    expect(feed.filter((e) => String(e.event).startsWith('op.') && !e.op)).toEqual([]);
    expect(feed.some((e) => e.event === 'agent.moved')).toBe(false);
    // What happened before it is still there.
    expect(feed.some((e) => e.event === 'member.admitted')).toBe(true);
    // The agent's own timeline (the Setup log) keeps every step.
    const own = (await w.f.inject({ method: 'GET', url: `/v1/events?agentId=${id}&limit=100`, headers: as() })).json() as Array<{ event: string }>;
    expect(own.filter((e) => e.event === 'op.step')).toHaveLength(10);
  });

  it('a held operation reads as waiting; another owner sharing the agent sees what, not where or why', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { name: 'Test Agent', members: [{ userId: 'user-member', displayName: 'Test Member' }] });
    const op = beginOperation(w.store, 'move-host', id, { toName: 'Test Runner' });
    op.step('checked');
    op.hold('The move to Test Runner was interrupted.', { actions: [{ action: 'put-back', label: 'Put it back' }] });
    const mine = (await w.f.inject({ method: 'GET', url: '/v1/events', headers: as() })).json() as Array<Record<string, any>>;
    expect(mine.find((e) => e.op?.id === op.id)).toMatchObject({ event: 'op.held', op: { summary: 'Move to Test Runner is waiting for your choice', outcome: 'The move to Test Runner was interrupted.' } });
  });
});

describe('the words', () => {
  it('titles and summaries by kind and status; spans as people say them', () => {
    expect(operationTitles('move-host', { toName: 'Test Runner' })).toEqual({ what: 'Move to Test Runner', doing: 'Moving to Test Runner', done: 'Moved to Test Runner' });
    expect(operationSummary('restore-backup', 'failed', { date: '2026-10-01' })).toBe('Restore from the 2026-10-01 backup failed');
    expect(operationSummary('import', 'rolled_back', {})).toBe('Import undone');
    expect(spanWords(4_000)).toBe('4 s');
    expect(spanWords(185_000)).toBe('3 min');
    expect(spanWords(2 * 3600_000 + 5 * 60_000)).toBe('2 h 5 min');
  });

  it('runInBackground: a refusal thrown before the operation begins rejects; one begun answers started', async () => {
    const w = await makeWorld();
    await expect(runInBackground(w.store, async () => { throw new Error('refused'); })).rejects.toThrow('refused');
    let release!: () => void;
    const bg = await runInBackground(w.store, async (onOp) => {
      const op = beginOperation(w.store, 'import', null, {});
      onOp(op.id);
      await new Promise<void>((r) => { release = r; });
      op.done('Imported.');
      return 'value';
    });
    expect(bg.started).toBe(true);
    release();
    if (bg.started) expect(await bg.done).toBe('value');
  });

  it("the Hatchabot agent's tools follow an operation to its end (followOperation)", async () => {
    const seen: string[] = [];
    const answers = [
      { id: 'op_t', status: 'running', stepN: 2, steps: 4, stepLabel: 'a copy of how it was saved to disk', title: 'Restoring from the 2026-10-01 backup' },
      { id: 'op_t', status: 'succeeded', outcome: 'Restored from the 2026-10-01 backup.' },
    ];
    const said = await followOperation({ operation: { id: 'op_t', status: 'running' } }, async (p) => { seen.push(p); return answers.shift(); }, { sleep: async () => {} });
    expect(said).toBe('Restored from the 2026-10-01 backup.');
    expect(seen).toEqual(['/v1/operations/op_t', '/v1/operations/op_t']);
    // An old synchronous answer is not followed.
    expect(await followOperation({ restored: ['MEMORY.md'] }, async () => { throw new Error('no'); })).toBeUndefined();
  });
});
