import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { clearBusy, isBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { filesReplacingCount, markInterrupted, newBootForTests, setStepHookForTests } from '../src/orchestrator/lifecycle/operations.js';
import { resumeOperations } from '../src/orchestrator/lifecycle/operationsResume.js';
import { reconcileAgents } from '../src/orchestrator/lifecycle/reconcile.js';
import { MigrateError } from '../src/orchestrator/transfer/migrate.js';
import { peekFormat, TransferError } from '../src/orchestrator/transfer/transfer.js';
import { createTransfers, type Transfers } from '../src/orchestrator/transfer/transfers.js';
import { createAgentRecords } from '../src/orchestrator/lifecycle/agentRecords.js';
import { CORE_FILES_WAIT_MS, createCoreFileTurns, type CoreFileTurns } from '../src/orchestrator/files/coreFileTurns.js';
import { ADOPT_PASS_TURN_WAIT_MS } from '../src/orchestrator/transfer/adopts.js';
import { workspacePath } from '../src/orchestrator/files/snapshots.js';
import { parseTemplate, readTemplate } from '../src/orchestrator/transfer/template.js';
import { migrateCrons } from '../src/orchestrator/transfer/cronImport.js';
import { MemSecrets, seedRunningAgent } from './support/world.js';
import Fastify from 'fastify';
import { installErrorHandler } from '../src/api/errorHandler.js';
import { registerTransferRoutes } from '../src/api/data/transferRoutes.js';
import type { RouteContext } from '../src/api/routeContext.js';
import * as zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';

// zlib's calls on the event loop, counted (HB-1162); each does what it always did.
vi.mock('node:zlib', async (importOriginal) => {
  const z = await importOriginal<typeof import('node:zlib')>();
  return { ...z, gzipSync: vi.fn(z.gzipSync), gunzipSync: vi.fn(z.gunzipSync), gunzip: vi.fn(z.gunzip) };
});

/**
 * The moves, import and export service (HB-0808 step 12), driven as the
 * routes drive it but with no HTTP server: a real store on an in-memory
 * database, two mock machines (this one, h1, and a runner, h2), secrets in
 * memory, and another Hatchabot played by a stubbed `peerFetch`. Made-up
 * data only; the one address is built at run time.
 */
const OWNER = 'user-owner';
const FRIEND = 'user-friend';
const friendAddress = ['friend', 'example.test'].join('@');
const ownerAddress = ['owner', 'example.test'].join('@');
const peerToken = () => ['hatchabot', 'peer', 'made', 'up'].join('_');

interface World {
  store: Store;
  secrets: MemSecrets;
  local: MockProvider;
  runner: MockProvider;
  svc: Transfers;
  /** The agents' core-files turns, as the agent files service hands them on. */
  turns: CoreFileTurns;
  kicked: string[];
  forgotten: string[];
  notes: string[];
  /** The events traced, by name. */
  events: string[];
  peerCalls: string[];
  /** What the other server answers, by the end of its path. */
  peer: Record<string, { status: number; body: unknown }>;
  gone: Set<string>;
}

function world(): World {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const local = new MockProvider();
  const runner = new MockProvider();
  local.daemonId = async () => 'daemon-here';
  runner.daemonId = async () => 'daemon-runner';
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'cloud', provider: 'mock', name: 'Runner', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now', shared: true } as never);
  const w = { store, secrets, local, runner, kicked: [], forgotten: [], notes: [], events: [], peerCalls: [], peer: {}, gone: new Set() } as unknown as World;
  w.turns = createCoreFileTurns({ store, agentGone: (id) => w.gone.has(id) });
  w.svc = createTransfers({
    store, secrets,
    providerFor: (hostId) => {
      if (hostId === 'h1') return local;
      if (hostId === 'h2') return runner;
      throw new Error(`no host ${hostId}`);
    },
    trace: () => (event) => { w.events.push(event); },
    channel: { kind: 'telegram', pool: { availableCount: () => 0, owns: () => false }, release: async () => {}, discardPending: () => {} } as never,
    embedder: () => undefined as never,
    isInFlight: () => false,
    peerFetch: async (url: string) => {
      w.peerCalls.push(url);
      const hit = Object.entries(w.peer).find(([end]) => url.endsWith(end));
      if (!hit) throw new Error(`unexpected call ${url}`);
      return new Response(JSON.stringify(hit[1].body), { status: hit[1].status, headers: { 'content-type': 'application/json' } });
    },
    agentGone: (id) => w.gone.has(id),
    kickProvision: (id) => { w.kicked.push(id); },
    forgetAgent: (id) => { w.forgotten.push(id); },
    notify: (_ownerId, body) => { w.notes.push(body); },
    logError: () => {},
    withCoreFilesTurn: (id, fn, waitMs?: number) => w.turns.withCoreFilesTurn(id, fn, waitMs),
  });
  return w;
}

async function seed(w: World, o: { id?: string; slug?: string; name?: string } = {}) {
  await w.secrets.put('ai/p1', 'made-up-key');
  return seedRunningAgent({ store: w.store, provider: w.local, secrets: w.secrets, owner: OWNER } as never, { id: o.id ?? 'a1', slug: o.slug ?? 'kitchen', name: o.name ?? 'Kitchen', accountId: `${o.slug ?? 'kitchen'}bot` });
}

describe('moves: to another machine', () => {
  it('refuses a move to a runner of an agent with folders of this machine, before anything stops', async () => {
    const w = world();
    const id = await seed(w);
    const agent = { ...w.store.getAgent(id)!, sharedPaths: ['/srv/made-up-share'] };
    const refused = w.svc.moves.foldersStayHere(agent, w.store.getHost('h2')!);
    expect(refused).toMatchObject({ code: 'folders_stay_here' });
    expect(refused!.error).toMatch(/reads 1 folder of this machine \(\/srv\/made-up-share\), which Runner cannot see/);
    // This machine mounts its own folders: no refusal.
    expect(w.svc.moves.foldersStayHere(agent, w.store.getHost('h1')!)).toBeUndefined();
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
  });

  it('rechecks what the move was judged on: ownership, then machine, source and image', async () => {
    const w = world();
    const id = await seed(w);
    const agent = w.store.getAgent(id)!;
    let current: typeof agent | undefined = agent;
    const recheck = w.svc.moves.preflightRefusal(agent, w.store.getHost('h2')!, () => current);
    expect(recheck()).toBeUndefined();
    current = { ...agent, aiProfileId: 'p-other' };
    expect(recheck()).toBe('Its machine, AI source or image changed while the move was checked. Look again, then move it.');
    current = undefined;
    expect(recheck()).toBe('It was deleted or its ownership changed while the move was checked.');
    current = agent;
    w.gone.add(id);
    expect(recheck()).toBe('It was deleted or its ownership changed while the move was checked.');
  });

  it('moves an agent to the runner: the same record, its memory there, and the operation named', async () => {
    const w = world();
    const id = await seed(w);
    const agent = w.store.getAgent(id)!;
    const host = w.store.getHost('h2')!;
    expect(w.svc.moves.foldersStayHere(agent, host)).toBeUndefined();
    expect(await w.svc.moves.crossesDown(agent, host, false)).toBeUndefined();
    let operation: string | undefined;
    const moved = await w.svc.moves.moveToHost(agent, host, {
      dropPin: false, requestedBy: OWNER, onOperation: (op) => { operation = op; },
      preflightRefusal: w.svc.moves.preflightRefusal(agent, host, () => w.store.getAgent(id)),
    });
    expect(moved.id).toBe(id);
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h2', state: 'RUNNING' });
    expect(operation).toBeTruthy();
    expect(w.store.getOperation(operation!)?.status).toBe('succeeded');
    expect(isBusy(id)).toBe(false);
  });

  it('a move refused under its lock (the source changed) leaves the agent where it was', async () => {
    const w = world();
    const id = await seed(w);
    const agent = w.store.getAgent(id)!;
    const host = w.store.getHost('h2')!;
    await expect(w.svc.moves.moveToHost(agent, host, {
      dropPin: false, requestedBy: OWNER, onOperation: () => {},
      preflightRefusal: () => 'Its machine, AI source or image changed while the move was checked. Look again, then move it.',
    })).rejects.toThrow(/changed while the move was checked/);
    expect(w.store.getAgent(id)).toMatchObject({ hostId: 'h1', state: 'RUNNING' });
  });
});

describe('moves: another Hatchabot', () => {
  it('keeps a server only once its token is proved, and words each refusal as before', async () => {
    const w = world();
    expect(await w.svc.moves.peers.refusal('http://127.0.0.1:8080', peerToken())).toBe('Give the other server\'s own address (its Tailscale or LAN name), not a local one.');
    w.peer['/v1/agents'] = { status: 401, body: {} };
    expect(await w.svc.moves.peers.refusal('http://desktop.example.test:8080', peerToken())).toBe('That server rejected the token.');
    w.peer['/v1/agents'] = { status: 500, body: {} };
    expect(await w.svc.moves.peers.refusal('http://desktop.example.test:8080', peerToken())).toBe('That address did not answer like a Hatchabot server.');
    w.peer['/v1/agents'] = { status: 200, body: [] };
    expect(await w.svc.moves.peers.refusal('http://desktop.example.test:8080/', peerToken())).toBeUndefined();
    const kept = await w.svc.moves.peers.add(OWNER, { name: 'Desktop', url: 'http://desktop.example.test:8080', token: peerToken() });
    expect(w.svc.moves.peers.list(OWNER)).toEqual([expect.objectContaining({ id: kept.id, name: 'Desktop' })]);
    expect(JSON.stringify(w.svc.moves.peers.list(OWNER))).not.toContain(peerToken());
    expect(await w.svc.moves.peers.remove('user-someone-else', kept.id)).toBe(false);
    expect(await w.svc.moves.peers.remove(OWNER, kept.id)).toBe(true);
    expect(w.svc.moves.peers.list(OWNER)).toEqual([]);
  });

  it('a server whose token cannot be removed is kept, and the forget says so, to be tried again (HB-1024)', async () => {
    const w = world();
    w.peer['/v1/agents'] = { status: 200, body: [] };
    const kept = await w.svc.moves.peers.add(OWNER, { name: 'Desktop', url: 'http://desktop.example.test:8080', token: peerToken() });
    const del = w.secrets.delete.bind(w.secrets);
    w.secrets.delete = async () => { throw new Error('disk is read-only'); };
    await expect(w.svc.moves.peers.remove(OWNER, kept.id)).rejects.toMatchObject({ name: 'TransferError', userMessage: expect.stringMatching(/Couldn't remove Desktop's token here \(disk is read-only\)\. It is still listed: forget it again\./) });
    expect(w.svc.moves.peers.list(OWNER).map((p) => p.id)).toEqual([kept.id]);
    expect([...w.secrets.map.keys()].filter((k) => k.startsWith('peer/'))).toHaveLength(1);
    // Tried again once the store takes it: gone, token and all.
    w.secrets.delete = del;
    expect(await w.svc.moves.peers.remove(OWNER, kept.id)).toBe(true);
    expect(w.svc.moves.peers.list(OWNER)).toEqual([]);
    expect([...w.secrets.map.keys()].filter((k) => k.startsWith('peer/'))).toEqual([]);
  });

  it('rehost: refused at the other server\'s preflight leaves the agent running; a yes moves it and stops the copy here', async () => {
    const w = world();
    const id = await seed(w);
    const kept = await w.svc.moves.peers.add(OWNER, { name: 'Desktop', url: 'http://desktop.example.test:8080', token: peerToken() });
    const peer = w.store.getPeer(OWNER, kept.id)!;
    w.peer['/v1/agents/preflight'] = { status: 200, body: { ok: false, reasons: ['Its bot is already wired to an agent here.'] } };
    await expect(w.svc.moves.rehost(w.store.getAgent(id)!, peer, { requestedBy: OWNER })).rejects.toBeInstanceOf(MigrateError);
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');

    w.peer['/v1/agents/preflight'] = { status: 200, body: { ok: true, reasons: [] } };
    w.peer['/v1/agents/restore'] = { status: 201, body: { id: 'r1', name: 'Kitchen', slug: 'kitchen', state: 'RUNNING' } };
    w.peer['/v1/agents'] = { status: 200, body: [{ slug: 'kitchen', state: 'RUNNING' }] };
    await w.svc.moves.rehost(w.store.getAgent(id)!, peer, { requestedBy: OWNER });
    expect(w.store.getAgent(id)!.state).toBe('STOPPED');
    expect(w.peerCalls.some((u) => u.endsWith('/v1/agents/restore'))).toBe(true);
  });

  it('answers another server\'s preflight, and a move it never sent is unknown', async () => {
    const w = world();
    await seed(w);
    const answer = await w.svc.moves.answerPreflight(OWNER, { slug: 'kitchen', accountId: 'kitchenbot' });
    expect(answer.ok).toBe(false);
    expect(w.svc.moves.moveState('a-made-up-move', OWNER)).toBe('unknown');
  });
});

describe('copies', () => {
  it('a template and its scan mention the same things; the scan makes no file', async () => {
    const w = world();
    const id = await seed(w);
    const agent = w.store.getAgent(id)!;
    const made = await w.svc.copies.template(agent, true);
    expect(made.filename).toMatch(/\.hatchabot$/);
    expect(await w.svc.copies.isTemplate(made.data)).toBe(true);
    const scan = await w.svc.copies.scan(agent, true);
    expect(scan).toEqual({ personal: made.personal, edited: made.edited });
  });

  it('a download is a full copy, read under the busy flag, that another install restores as the same agent', async () => {
    const w = world();
    const id = await seed(w);
    const { data, filename } = await w.svc.copies.download(w.store.getAgent(id)!);
    expect(filename).toMatch(/\.hatchabot$/);
    expect(isBusy(id)).toBe(false);
    expect(await w.svc.copies.isTemplate(data)).toBe(false);

    const there = world();
    await there.secrets.put('ai/p1', 'made-up-key');
    let operation: string | undefined;
    const restored = await there.svc.copies.importCopy(there.store.getHost('h1')!, data, { ownerId: OWNER, onOperation: (op) => { operation = op; } });
    expect(restored).toMatchObject({ name: 'Kitchen', slug: 'kitchen', ownerId: OWNER, state: 'RUNNING' });
    expect(there.store.getAgent(restored.id)).toBeDefined();
    expect(operation).toBeTruthy();
    // Its tasks came in its volume, unrecorded there: a folder adopted into it again is matched by look (HB-0985).
    expect(there.store.mayHoldUnrecordedCarriedTasks(restored.id)).toBe(true);
    expect(w.store.mayHoldUnrecordedCarriedTasks(id)).toBe(false);
  });

  it('a template imported is a fresh agent the importer owns, set up by the caller', async () => {
    const w = world();
    const id = await seed(w);
    const { data } = await w.svc.copies.template(w.store.getAgent(id)!, false);
    const { agent } = await w.svc.copies.importTemplateFile(w.store.getHost('h1')!, data, { ownerId: OWNER, name: 'Kitchen Two' });
    expect(agent).toMatchObject({ name: 'Kitchen Two', ownerId: OWNER });
    expect(agent.id).not.toBe(id);
    // A template with no tasks gives it none: nothing to match by look (HB-0985).
    expect(w.store.mayHoldUnrecordedCarriedTasks(agent.id)).toBe(false);
    // The route kicks setup (it may make it web-only first), not the service.
    expect(w.kicked).toEqual([]);
  });

  it('clone reads what was asked once its template is made, copies its memory, and frees the source', async () => {
    const w = world();
    const id = await seed(w);
    const order: string[] = [];
    const { clone, carried } = await w.svc.copies.clone(w.store.getAgent(id)!, {
      owner: OWNER,
      current: () => { order.push('current'); return w.store.getAgent(id); },
      ask: () => { order.push('ask'); expect(isBusy(id)).toBe(true); return { name: 'Kitchen Copy', telegram: false }; },
    });
    expect(order.slice(0, 2)).toEqual(['current', 'ask']);
    expect(clone).toMatchObject({ name: 'Kitchen Copy', ownerId: OWNER, hostId: 'h1', aiProfileId: 'p1' });
    expect(w.store.getAgent(clone.id)!.webOnly).toBe(true);
    expect(w.store.getAgent(clone.id)!.parentAgentId).toBe(id);
    expect(carried).toHaveProperty('files');
    expect(w.kicked).toEqual([clone.id]);
    expect(isBusy(id)).toBe(false);
  });

  it('a clone keeps its source\'s model pin where its AI source offers it, and drops one it does not (HB-1082)', async () => {
    const w = world();
    const id = await seed(w);
    w.store.setAIProfileModels('p1', ['claude-made-up-small']);
    w.store.setAgentModel(id, 'claude-made-up-small');
    const ask = () => ({ telegram: false });
    const { clone } = await w.svc.copies.clone(w.store.getAgent(id)!, { owner: OWNER, current: () => w.store.getAgent(id), ask });
    expect(w.store.getAgent(clone.id)!.aiProfileId).toBe('p1');
    expect(w.store.getAgent(clone.id)!.model).toBe('claude-made-up-small');
    // A pin the source no longer lists is not carried: the copy follows its source's default.
    w.store.setAIProfileModels('p1', undefined);
    const { clone: second, modelNotCopied } = await w.svc.copies.clone(w.store.getAgent(id)!, { owner: OWNER, current: () => w.store.getAgent(id), ask: () => ({ name: 'Kitchen Again', telegram: false }) });
    expect(w.store.getAgent(second.id)!.model).toBeUndefined();
    // And the answer says so, not only its timeline (HB-1165).
    expect(modelNotCopied).toBe('claude-made-up-small');
  });

  it('a clone and a download carry the owner\'s model, not the cheaper one a budget moved it to (HB-1165)', async () => {
    const menu = ['claude-made-up-small', 'claude-made-up-big'];
    /** An agent its budget moved to the small model until the 1st; `fromModel`: its owner's own choice before (null: its source's default). */
    const movedByBudget = async (fromModel: string | null) => {
      const w = world();
      const id = await seed(w);
      w.store.setAIProfileModels('p1', menu);
      w.store.setAgentModel(id, 'claude-made-up-small');
      w.store.addBudgetPause(id, '2026-11', `agent:${id}`, 'now', { fromModel, toModel: 'claude-made-up-small' });
      return { w, id };
    };
    const cloneOf = (w: World, id: string) => w.svc.copies.clone(w.store.getAgent(id)!, { owner: OWNER, current: () => w.store.getAgent(id), ask: () => ({ telegram: false }) });
    /** Its download restored on another install whose source offers the same models. */
    const restoredModel = async (w: World, id: string) => {
      const there = world();
      await there.secrets.put('ai/p1', 'made-up-key');
      there.store.setAIProfileModels('p1', menu);
      const { data } = await w.svc.copies.download(w.store.getAgent(id)!);
      const restored = await there.svc.copies.importCopy(there.store.getHost('h1')!, data, { ownerId: OWNER, onOperation: () => {} });
      return there.store.getAgent(restored.id)!.model;
    };

    // Its owner pinned the big one: the copies are on the big one.
    const pinned = await movedByBudget('claude-made-up-big');
    const one = await cloneOf(pinned.w, pinned.id);
    expect(pinned.w.store.getAgent(one.clone.id)!.model).toBe('claude-made-up-big');
    expect(one.modelNotCopied).toBeUndefined();
    expect(await restoredModel(pinned.w, pinned.id)).toBe('claude-made-up-big');

    // Its owner had chosen no model: the copies follow their source's default.
    const followed = await movedByBudget(null);
    const two = await cloneOf(followed.w, followed.id);
    expect(followed.w.store.getAgent(two.clone.id)!.model).toBeUndefined();
    expect(two.modelNotCopied).toBeUndefined();
    expect(await restoredModel(followed.w, followed.id)).toBeUndefined();

    // Changed by hand since the budget's switch: that choice is the owner's, and it is carried.
    const changed = await movedByBudget(null);
    changed.w.store.setAgentModel(changed.id, 'claude-made-up-big');
    const three = await cloneOf(changed.w, changed.id);
    expect(changed.w.store.getAgent(three.clone.id)!.model).toBe('claude-made-up-big');
    expect(await restoredModel(changed.w, changed.id)).toBe('claude-made-up-big');
  });

  it('a clone whose source changed during the copy is refused, and what was asked is never read', async () => {
    const w = world();
    const id = await seed(w);
    let asked = false;
    await expect(w.svc.copies.clone(w.store.getAgent(id)!, {
      owner: OWNER, current: () => undefined, ask: () => { asked = true; return null; },
    })).rejects.toBeInstanceOf(TransferError);
    expect(asked).toBe(false);
    expect(w.kicked).toEqual([]);
    expect(isBusy(id)).toBe(false);
  });

  it('derive makes a child with its own name, its master recorded, set up in the background', async () => {
    const w = world();
    const id = await seed(w);
    const child = await w.svc.copies.derive(w.store.getAgent(id)!, { ownerId: OWNER, name: 'Unit 4B' });
    expect(child).toMatchObject({ name: 'Unit 4B', ownerId: OWNER });
    expect(w.store.getAgent(child.id)!.parentAgentId).toBe(id);
    expect(w.kicked).toEqual([child.id]);
  });
});

describe('templates made and read off the event loop (HB-1162)', () => {
  it('a template made, imported, cloned, derived and accepted is compressed and inflated off the loop, and so is a file read whole to learn its kind', async () => {
    const w = world();
    const id = await seed(w);
    w.store.recordAccount(FRIEND, friendAddress);
    // A file whose JSON does not begin with its format (an older or a foreign
    // one), past the 4 KB head the kind is first looked for in.
    const odd = zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, format: 'hatchabot-template', pad: randomBytes(20_000).toString('base64') })));
    const onLoop = () => [
      ...vi.mocked(zlib.gzipSync).mock.calls.map(([d]) => `gzipSync of ${Buffer.byteLength(d as Buffer)} bytes`),
      // All but the look at a file's first 4 KB for its kind (a partial inflate, bounded).
      ...vi.mocked(zlib.gunzipSync).mock.calls.filter(([d, o]) => (d as Buffer).length > 4096 || (o as zlib.ZlibOptions | undefined)?.finishFlush !== zlib.constants.Z_SYNC_FLUSH)
        .map(([d]) => `gunzipSync of ${(d as Buffer).length} bytes`),
    ];
    vi.mocked(zlib.gzipSync).mockClear();
    vi.mocked(zlib.gunzipSync).mockClear();
    const agent = w.store.getAgent(id)!;
    const { data } = await w.svc.copies.template(agent, true);
    const imported = await w.svc.copies.importTemplateFile(w.store.getHost('h1')!, data, { ownerId: OWNER, name: 'Kitchen Two' });
    await w.svc.copies.clone(agent, { owner: OWNER, current: () => w.store.getAgent(id), ask: () => ({ name: 'Kitchen Copy', telegram: false }) });
    await w.svc.copies.derive(agent, { ownerId: OWNER, name: 'Kitchen Child' });
    w.store.insertShare({ id: 'sh-1', fromOwner: OWNER, toEmail: friendAddress, toOwner: FRIEND, agentName: 'Kitchen', blob: data, createdAt: 'now' });
    const share = w.store.getShareFor('sh-1', FRIEND, friendAddress)!;
    expect(w.store.setShareStatus('sh-1', 'accepted', FRIEND)).toBe(true);
    const accepted = await w.svc.inbox.accept('sh-1', share, { ownerId: FRIEND, email: friendAddress }, { name: 'Their Kitchen', hostId: 'h1' });
    expect(await w.svc.copies.isTemplate(odd)).toBe(true);
    expect(onLoop()).toEqual([]);
    // Each did what it always did.
    expect(imported.agent).toMatchObject({ name: 'Kitchen Two', ownerId: OWNER });
    expect(accepted.agent).toMatchObject({ name: 'Their Kitchen', ownerId: FRIEND });
    expect(w.store.listAgents(OWNER).map((a) => a.name).sort()).toEqual(['Kitchen', 'Kitchen Child', 'Kitchen Copy', 'Kitchen Two']);
  });

  it('whole files are inflated two at a time across the process, not as many as were sent at once', async () => {
    const w = world();
    const id = await seed(w);
    const { data } = await w.svc.copies.template(w.store.getAgent(id)!, false);
    // Read whole to learn its kind: its JSON does not begin with its format.
    const odd = zlib.gzipSync(Buffer.from(JSON.stringify({ version: 1, format: 'hatchabot-template', pad: randomBytes(6_000).toString('base64') })));
    const { gunzip: realGunzip } = await vi.importActual<typeof import('node:zlib')>('node:zlib');
    let now = 0;
    let most = 0;
    vi.mocked(zlib.gunzip).mockImplementation(((buf: Buffer, opts: zlib.ZlibOptions, cb: (e: Error | null, r: Buffer) => void) => {
      now++; most = Math.max(most, now);
      setTimeout(() => realGunzip(buf, opts, (e, r) => { now--; cb(e, r); }), 5);
    }) as never);
    try {
      const [kinds, read] = await Promise.all([
        Promise.all([1, 2, 3, 4].map(() => peekFormat(odd))),
        Promise.all([1, 2, 3, 4].map(() => readTemplate(data))),
      ]);
      expect(kinds).toEqual(Array(4).fill('hatchabot-template'));
      expect(read.map((m) => m.agent.name)).toEqual(Array(4).fill('Kitchen'));
      expect(most).toBe(2);
    } finally {
      vi.mocked(zlib.gunzip).mockImplementation(realGunzip as never);
    }
  });
});

describe('a copy of an agent whose tasks the gateway runs (HB-1018)', () => {
  const job = (id: string, name: string, expr: string, tz?: string) => ({
    id, name, enabled: true, schedule: { kind: 'cron', expr, ...(tz ? { tz } : {}) }, payload: { kind: 'agentTurn', message: `Run ${name}.` },
  });
  it('clones and derives with a nickname, a zero-padded step and an offset zone; a task no gateway runs is refused as a copy\'s', async () => {
    const w = world();
    const id = await seed(w);
    const agent = () => w.store.getAgent(id)!;
    const runs = [
      job('j1', 'Midnight tidy', '@midnight'),
      job('j2', 'Every five', '*/05 * * * *', '+05:00'),
      job('j3', 'Daily note', '@daily', '-0800'),
      job('j4', 'Morning steps', '1-10/02 8 * * *'),
    ];
    w.local.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: runs }) });
    const { clone } = await w.svc.copies.clone(agent(), { owner: OWNER, current: agent, ask: () => ({ name: 'Kitchen Copy', telegram: false }) });
    expect(w.store.getPendingSchedules(clone.id)!.map((s) => [s.name, s.cron, s.tz])).toEqual([
      ['Midnight tidy', '@midnight', undefined], ['Every five', '*/05 * * * *', '+05:00'], ['Daily note', '@daily', '-0800'], ['Morning steps', '1-10/02 8 * * *', undefined],
    ]);
    const child = await w.svc.copies.derive(agent(), { ownerId: OWNER, name: 'Kitchen Child' });
    expect(w.store.getPendingSchedules(child.id)).toHaveLength(4);
    // One no gateway runs: said as a copy of the agent, not as a file.
    w.local.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs: [job('j5', 'On boot', '@reboot')] }) });
    const said = 'Can\'t copy Kitchen: its scheduled task "On boot" has a cron expression that can\'t run ("@reboot").';
    await expect(w.svc.copies.clone(agent(), { owner: OWNER, current: agent, ask: () => ({ name: 'Kitchen Again', telegram: false }) })).rejects.toThrow(said);
    await expect(w.svc.copies.derive(agent(), { ownerId: OWNER, name: 'Kitchen Again' })).rejects.toThrow(said);
    // The same file, downloaded and brought in: a template file's words.
    const { data } = await w.svc.copies.template(agent(), false);
    await expect(w.svc.copies.importTemplateFile(w.store.getHost('h1')!, data, { ownerId: OWNER, name: 'Kitchen File' }))
      .rejects.toThrow('That template can\'t be used: its scheduled task "On boot" has a cron expression that can\'t run ("@reboot").');
    expect(w.store.listAgents(OWNER).map((a) => a.name).sort()).toEqual(['Kitchen', 'Kitchen Child', 'Kitchen Copy']);
  });
});

describe('a template read beside a change to its definition', () => {
  /** The agent's workspace files, served to a core-file read (the `head -c` the reader sends). */
  function workspace(w: World, slug: string, files: Record<string, string>) {
    const on = new Map(Object.entries(files).map(([name, text]) => [workspacePath(slug, name), text]));
    const sh = w.local.execShell.bind(w.local);
    w.local.execShell = async (ref, script, opts) => {
      const read = /^head -c \d+ "([^"]+)"/.exec(script);
      if (read) {
        const text = on.get(read[1]!);
        return text === undefined ? { code: 0, stdout: '', stderr: '' } : { code: 0, stdout: text, stderr: '' };
      }
      return sh(ref, script, opts);
    };
    return { write: (name: string, text: string) => { on.set(workspacePath(slug, name), text); } };
  }
  /** A change to the definition that writes SOUL.md, then AGENTS.md, in its core-files turn (as setup values do). */
  function changeInTurn(w: World, id: string, files: ReturnType<typeof workspace>) {
    let go!: () => void;
    const between = new Promise<void>((r) => { go = r; });
    let wrote!: () => void;
    const half = new Promise<void>((r) => { wrote = r; });
    const done = w.turns.withCoreFilesTurn(id, async () => {
      files.write('SOUL.md', 'New soul.');
      wrote();
      await between;
      files.write('AGENTS.md', 'New rules.');
    });
    return { half, go, done };
  }

  for (const via of ['template', 'scan', 'clone', 'derive', 'send'] as const) {
    it(`${via} waits for the change and copies one generation of the files (HB-0964)`, async () => {
      const w = world();
      const id = await seed(w);
      const files = workspace(w, 'kitchen', { 'SOUL.md': 'Old soul.', 'AGENTS.md': 'Old rules.' });
      const change = changeInTurn(w, id, files);
      await change.half;
      const agent = w.store.getAgent(id)!;
      let copied: Promise<Record<string, string> | undefined>;
      if (via === 'template') copied = w.svc.copies.template(agent, false).then((t) => parseTemplate(t.data).files);
      else if (via === 'scan') copied = w.svc.copies.scan(agent, false).then(() => undefined);
      else if (via === 'clone') copied = w.svc.copies.clone(agent, { owner: OWNER, current: () => w.store.getAgent(id), ask: () => ({ name: 'Kitchen Copy' }) }).then((c) => w.store.getAgentSeed(c.clone.id));
      else if (via === 'derive') copied = w.svc.copies.derive(agent, { ownerId: OWNER, name: 'Kitchen Child' }).then((c) => w.store.getAgentSeed(c.id));
      else {
        w.store.recordAccount(FRIEND, friendAddress);
        copied = w.svc.inbox.send(agent, { ownerId: OWNER, email: ownerAddress }, friendAddress, undefined)
          .then(() => parseTemplate(w.store.getShareFor(w.store.listInbox(FRIEND, friendAddress)[0]!.id, FRIEND, friendAddress)!.blob).files);
      }
      let settled = false;
      void copied.then(() => { settled = true; }, () => { settled = true; });
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      expect(settled).toBe(false);
      change.go();
      await change.done;
      const out = await copied;
      if (out) expect({ soul: out['SOUL.md'], rules: out['AGENTS.md'] }).toEqual({ soul: 'New soul.', rules: 'New rules.' });
    });
  }

  it('a turn that does not come in time refuses the copy in its own words (HB-0964)', async () => {
    const w = world();
    const id = await seed(w);
    const turns = w.turns;
    w.turns = { ...turns, withCoreFilesTurn: (agentId, fn) => turns.withCoreFilesTurn(agentId, fn, 0) };
    const files = workspace(w, 'kitchen', { 'SOUL.md': 'Old soul.', 'AGENTS.md': 'Old rules.' });
    const change = changeInTurn(w, id, files);
    await change.half;
    // A busy refusal, as every other one is (HB-1166): the routes answer it 409.
    await expect(w.svc.copies.template(w.store.getAgent(id)!, false)).rejects.toMatchObject({ name: 'AgentBusyError', userMessage: expect.stringMatching(/Another change to its files is still running/) });
    change.go();
    await change.done;
  });

  it.each([
    ['export', 'GET', '/v1/agents/a1/export', undefined],
    ['scan', 'GET', '/v1/agents/a1/export/scan', undefined],
    ['clone', 'POST', '/v1/agents/a1/clone', { name: 'Kitchen Copy' }],
    ['derive', 'POST', '/v1/agents/a1/derive', { name: 'Kitchen Child' }],
    ['send', 'POST', '/v1/agents/a1/send', { toEmail: friendAddress }],
  ] as const)('%s refused because its files are being changed answers 409 with the reason (HB-1166)', async (_via, method, url, body) => {
    const w = world();
    const id = await seed(w);
    const turns = w.turns;
    w.turns = { ...turns, withCoreFilesTurn: (agentId, fn) => turns.withCoreFilesTurn(agentId, fn, 0) };
    const change = changeInTurn(w, id, workspace(w, 'kitchen', { 'SOUL.md': 'Old soul.', 'AGENTS.md': 'Old rules.' }));
    await change.half;
    // The routes over the service, with the app's own error handler; everything else they ask passes.
    const app = Fastify();
    installErrorHandler(app);
    registerTransferRoutes(app, {
      deps: { authMode: 'identity' }, store: w.store, trace: () => () => {},
      ownedAgent: (_req: unknown, agentId: string) => w.store.getAgent(agentId),
      movedAway: () => false, busyNow: () => false, capProblem: () => undefined, capRowMade: () => {},
      publicAgent: (a: { id: string }) => ({ id: a.id }), hostBeingRemoved: () => false,
      transfers: w.svc,
    } as unknown as RouteContext);
    try {
      const res = await app.inject({ method, url, headers: { 'x-hatchabot-owner': OWNER }, ...(body ? { payload: body } : {}) });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe('Another change to its files is still running; try again when it ends.');
      expect(isBusy(id)).toBe(false);
      expect(w.store.listAgents(OWNER).map((a) => a.name)).toEqual(['Kitchen']);
    } finally {
      change.go();
      await change.done;
      await app.close();
    }
  });
});

describe('a template import storing its setup answers', () => {
  /** A template of the seeded agent with one setup field its importer answers with a credential. */
  async function templateWithKey(w: World) {
    const id = await seed(w);
    w.store.setAgentParameters(id, [{ key: 'api_key', label: 'Key', required: false, type: 'text', target: 'env' }]);
    return (await w.svc.copies.template(w.store.getAgent(id)!, false)).data;
  }
  /** The secret writes for env values wait until let go. */
  function holdEnvWrites(w: World) {
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    let begun!: () => void;
    const started = new Promise<void>((r) => { begun = r; });
    const put = w.secrets.put.bind(w.secrets);
    w.secrets.put = async (ref, v) => { if (ref.startsWith('agent-env/')) { begun(); await gate; } return put(ref, v); };
    return { started, go };
  }
  const records = (w: World) => createAgentRecords({
    store: w.store, secrets: w.secrets, providerFor: () => w.local, trace: () => () => {},
    channel: { kind: 'telegram', pool: { owns: () => false }, release: async () => {}, discardPending: () => {} } as never,
    hostGoing: () => undefined, connectorFor: () => undefined, dmChannelPeople: async () => 0, parkArchivedChannels: async () => {},
    forgetSettings: () => {}, forgetConversations: () => {}, kickProvision: () => {}, provisionWhenFree: () => {}, inFlight: () => undefined, callOff: () => {},
    logError: () => {}, warn: () => {},
  });

  it('a delete of the draft meanwhile is refused, and no credential is left on a tombstone (HB-0926)', async () => {
    const w = world();
    const data = await templateWithKey(w);
    const held = holdEnvWrites(w);
    const importing = w.svc.copies.importTemplateFile(w.store.getHost('h1')!, data, { ownerId: OWNER, name: 'Kitchen Two', values: { api_key: 'made-up-value' } });
    await held.started;
    const draft = w.store.listAgents(OWNER).find((a) => a.name === 'Kitchen Two')!;
    expect(isBusy(draft.id)).toBe(true);
    expect(await records(w).remove(draft, {}, (a) => a.state)).toMatchObject({ ok: false, status: 409 });
    held.go();
    const { agent } = await importing;
    expect(w.store.getAgent(agent.id)!.state).toBe('PROVISIONING');
    expect(w.store.listAgentEnv(agent.id).map((e) => e.name)).toEqual(['API_KEY']);
    expect(isBusy(agent.id)).toBe(false);
    // Free again once its answers are stored: a delete then goes through, credential and all.
    expect(await records(w).remove(w.store.getAgent(agent.id)!, {}, (a) => a.state)).toMatchObject({ ok: true, value: 'DELETED' });
    expect(w.store.listAgentEnv(agent.id)).toEqual([]);
    expect([...w.secrets.map.keys()].filter((k) => k.startsWith('agent-env/'))).toEqual([]);
  });

  /** A template asking two credentials of its importer. */
  async function templateWithTwoKeys(w: World) {
    const id = await seed(w);
    w.store.setAgentParameters(id, [
      { key: 'api_key', label: 'Key', required: false, type: 'text', target: 'env' },
      { key: 'second_key', label: 'Second key', required: false, type: 'text', target: 'env' },
    ]);
    return (await w.svc.copies.template(w.store.getAgent(id)!, false)).data;
  }
  /** The process dies as the second credential is written: that write never ends, and nothing after it runs. */
  function dieAtSecondWrite(w: World) {
    const put = w.secrets.put.bind(w.secrets);
    let n = 0;
    let reached!: () => void;
    const dead = new Promise<void>((r) => { reached = r; });
    w.secrets.put = async (ref, v) => {
      if (ref.startsWith('agent-env/') && ++n === 2) { reached(); return new Promise<void>(() => {}); }
      return put(ref, v);
    };
    return { dead, heal: () => { w.secrets.put = put; } };
  }
  /** A new process: no busy flag, a new boot id; then the boot's order, reconcile before the resume. */
  async function restart(w: World, draftId: string) {
    clearBusy(draftId);
    newBootForTests();
    markInterrupted(w.store);
    await reconcileAgents(w.store, new Map([['mock', w.local]]), () => {});
    const midway = w.store.getAgent(draftId)!.state;
    await resumeOperations({ store: w.store, secrets: w.secrets, channel: {} as never, sleep: async () => {}, providerForHost: () => w.local });
    return midway;
  }
  const values = { api_key: 'made-up-one', second_key: 'made-up-two' };

  it('a restart part way undoes the draft whole, never leaving it to be built with some of its credentials (HB-0927)', async () => {
    const w = world();
    const data = await templateWithTwoKeys(w);
    const death = dieAtSecondWrite(w);
    void w.svc.copies.importTemplateFile(w.store.getHost('h1')!, data, { ownerId: OWNER, name: 'Kitchen Two', values });
    await death.dead;
    death.heal();
    const draft = w.store.listAgents(OWNER).find((a) => a.name === 'Kitchen Two')!;
    expect(w.store.listAgentEnv(draft.id).map((e) => e.name)).toEqual(['API_KEY']);
    // Reconcile leaves it alone (not FAILED, so no Retry builds it half-filled); the resume undoes it.
    expect(await restart(w, draft.id)).toBe('PROVISIONING');
    expect(w.store.getAgent(draft.id)!.state).toBe('DELETED');
    expect(w.store.listOperations([draft.id])[0]).toMatchObject({ kind: 'import', status: 'rolled_back', outcome: 'Import interrupted — import the file again.' });
    expect(w.store.listAgentEnv(draft.id)).toEqual([]);
    expect([...w.secrets.map.keys()].filter((k) => k.startsWith('agent-env/'))).toEqual([]);
    // Imported again under its name, it is whole.
    const { agent } = await w.svc.copies.importTemplateFile(w.store.getHost('h1')!, data, { ownerId: OWNER, name: 'Kitchen Two', values });
    expect(w.store.listAgentEnv(agent.id).map((e) => e.name).sort()).toEqual(['API_KEY', 'SECOND_KEY']);
    expect(w.store.listOperations([agent.id])[0]).toMatchObject({ kind: 'import', status: 'succeeded' });
    expect(w.store.activeOperationFor(agent.id)).toBeUndefined();
  });

  it('a share accepted when a restart cut its setup off is back in the inbox (HB-0927)', async () => {
    const w = world();
    const data = await templateWithTwoKeys(w);
    w.store.recordAccount(FRIEND, friendAddress);
    w.store.insertShare({ id: 'sh-1', fromOwner: OWNER, toEmail: friendAddress, toOwner: FRIEND, agentName: 'Kitchen', blob: data, createdAt: 'now' });
    const me = { ownerId: FRIEND, email: friendAddress };
    const share = w.store.getShareFor('sh-1', FRIEND, friendAddress)!;
    expect(w.store.setShareStatus('sh-1', 'accepted', FRIEND)).toBe(true);
    const death = dieAtSecondWrite(w);
    void w.svc.inbox.accept('sh-1', share, me, { name: 'Their Kitchen', hostId: 'h1', values });
    await death.dead;
    const draft = w.store.listAgents(FRIEND).find((a) => a.name === 'Their Kitchen')!;
    await restart(w, draft.id);
    expect(w.store.getAgent(draft.id)!.state).toBe('DELETED');
    expect(w.store.listOperations([draft.id])[0]).toMatchObject({ status: 'rolled_back', outcome: 'Import interrupted — it is back in your inbox: accept it again.' });
    expect(w.store.listInbox(FRIEND, friendAddress).map((s) => s.id)).toEqual(['sh-1']);
  });

  it('a child cut off by a restart is undone, and its owner told to make it again from its master (HB-0927)', async () => {
    const w = world();
    await templateWithTwoKeys(w);
    const death = dieAtSecondWrite(w);
    void w.svc.copies.derive(w.store.getAgent('a1')!, { ownerId: OWNER, name: 'Kitchen Child', values });
    await death.dead;
    death.heal();
    const draft = w.store.listAgents(OWNER).find((a) => a.name === 'Kitchen Child')!;
    await restart(w, draft.id);
    expect(w.store.getAgent(draft.id)!.state).toBe('DELETED');
    expect(w.store.listOperations([draft.id])[0]).toMatchObject({ status: 'rolled_back', outcome: 'Making the child of Kitchen was interrupted — make it again from Kitchen.' });
    expect([...w.secrets.map.keys()].filter((k) => k.startsWith('agent-env/'))).toEqual([]);
  });

  it('a clone cut off by a restart as it copies its variables is undone whole, and its owner told to clone it again (HB-1164)', async () => {
    const w = world();
    const id = await seed(w);
    for (const [n, name] of ['FIRST_KEY', 'SECOND_KEY'].entries()) {
      await w.secrets.put(`agent-env/src-${n}`, `made-up-${n}`);
      w.store.insertAgentEnv({ id: `src-${n}`, agentId: id, name, secretRef: `agent-env/src-${n}`, createdAt: 'now' });
    }
    const death = dieAtSecondWrite(w);
    void w.svc.copies.clone(w.store.getAgent(id)!, { owner: OWNER, current: () => w.store.getAgent(id), ask: () => ({ name: 'Kitchen Copy', telegram: false }) });
    await death.dead;
    death.heal();
    const draft = w.store.listAgents(OWNER).find((a) => a.name === 'Kitchen Copy')!;
    expect(w.store.listAgentEnv(draft.id).map((e) => e.name)).toEqual(['FIRST_KEY']);
    clearBusy(id);
    // Reconcile leaves it alone (no Retry builds it with one variable); the resume undoes it.
    expect(await restart(w, draft.id)).toBe('PROVISIONING');
    expect(w.store.getAgent(draft.id)!.state).toBe('DELETED');
    expect(w.store.listOperations([draft.id])[0]).toMatchObject({ kind: 'import', status: 'rolled_back', outcome: 'Cloning Kitchen was interrupted — clone it again.' });
    expect(w.store.listAgentEnv(draft.id)).toEqual([]);
    expect([...w.secrets.map.keys()].filter((k) => k.startsWith('agent-env/')).sort()).toEqual(['agent-env/src-0', 'agent-env/src-1']);
    // The source is as it was; cloned again, the copy is whole and its operation over.
    expect(w.store.getAgent(id)!.state).toBe('RUNNING');
    const { clone } = await w.svc.copies.clone(w.store.getAgent(id)!, { owner: OWNER, current: () => w.store.getAgent(id), ask: () => ({ name: 'Kitchen Copy', telegram: false }) });
    expect(w.store.listAgentEnv(clone.id).map((e) => e.name).sort()).toEqual(['FIRST_KEY', 'SECOND_KEY']);
    expect(w.store.listOperations([clone.id])[0]).toMatchObject({ kind: 'import', status: 'succeeded' });
    expect(w.store.activeOperationFor(clone.id)).toBeUndefined();
    expect(w.kicked).toEqual([clone.id]);
  });

  it('setup answers that cannot be stored roll the draft back, and its operation says so (HB-0927)', async () => {
    const w = world();
    const data = await templateWithTwoKeys(w);
    const put = w.secrets.put.bind(w.secrets);
    let n = 0;
    w.secrets.put = async (ref, v) => { if (ref.startsWith('agent-env/') && ++n === 2) throw new Error('disk full'); return put(ref, v); };
    await expect(w.svc.copies.importTemplateFile(w.store.getHost('h1')!, data, { ownerId: OWNER, name: 'Kitchen Two', values })).rejects.toBeInstanceOf(TransferError);
    const [op] = w.store.operationsWithStatus(['rolled_back']);
    expect(op).toMatchObject({ kind: 'import', params: expect.objectContaining({ template: true }) });
    expect(op!.outcome).toMatch(/^Couldn't store the setup credentials: disk full/);
    expect(w.store.getAgent(op!.agentId!)!.state).toBe('DELETED');
    expect([...w.secrets.map.keys()].filter((k) => k.startsWith('agent-env/'))).toEqual([]);
  });

  it('a copy and a template with answers to store are imports: each counts once as its row begins, under its draft\'s take; with none to store, no row and nothing counted; the original counts nothing (HB-1465)', async () => {
    // The count a snapshot by hand and an access check compare (operations.ts, filesReplacingCount).
    const w = world();
    const data = await templateWithTwoKeys(w);
    const seen: Array<{ count: number; held: boolean }> = [];
    setStepHookForTests((op, k) => { if (op.kind === 'import' && k === '#succeeded') seen.push({ count: filesReplacingCount(op.agentId!), held: isBusy(op.agentId!) }); });
    try {
      const { agent: answered } = await w.svc.copies.importTemplateFile(w.store.getHost('h1')!, data, { ownerId: OWNER, name: 'Kitchen Two', values });
      expect(filesReplacingCount(answered.id)).toBe(1);
      const { agent: bare } = await w.svc.copies.importTemplateFile(w.store.getHost('h1')!, data, { ownerId: OWNER, name: 'Kitchen Three' });
      expect(w.store.listOperations([bare.id])).toEqual([]);
      expect(filesReplacingCount(bare.id)).toBe(0);
      const before = filesReplacingCount('a1');
      const { clone } = await w.svc.copies.clone(w.store.getAgent('a1')!, { owner: OWNER, current: () => w.store.getAgent('a1'), ask: () => ({ name: 'Kitchen Copy', telegram: false }) });
      expect(w.store.listOperations([clone.id])[0]).toMatchObject({ kind: 'import', status: 'succeeded' });
      expect(filesReplacingCount(clone.id)).toBe(1);
      expect(filesReplacingCount('a1')).toBe(before);
      // Each ended under its draft's take, counted once.
      expect(seen).toEqual([{ count: 1, held: true }, { count: 1, held: true }]);
    } finally { setStepHookForTests(undefined); }
  });
});

describe('inbox', () => {
  it('a template sent lands in the recipient\'s inbox with its setup fields, and an accept stands it up as theirs', async () => {
    const w = world();
    const id = await seed(w);
    w.store.recordAccount(FRIEND, friendAddress);
    w.store.insertHost({ id: 'h-friend', ownerId: FRIEND, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    expect(await w.svc.inbox.send(w.store.getAgent(id)!, { ownerId: OWNER }, friendAddress, 'For your kitchen')).toBe('sent');
    const me = { ownerId: FRIEND, email: friendAddress };
    const [share] = await w.svc.inbox.list(me);
    expect(share).toMatchObject({ agentName: 'Kitchen', message: 'For your kitchen', parameters: [] });
    const shareId = String(share!.id);
    // The route reads the share, claims it (setShareStatus), then the service stands it up.
    const found = w.store.getShareFor(shareId, FRIEND, friendAddress)!;
    expect(w.store.setShareStatus(shareId, 'accepted', FRIEND)).toBe(true);
    const { agent } = await w.svc.inbox.accept(shareId, found, me, { name: 'Their Kitchen', hostId: 'h1' });
    expect(agent).toMatchObject({ name: 'Their Kitchen', ownerId: FRIEND });
    expect(w.store.getAgent(agent.id)!.parentAgentId).toBe(id);
    expect(w.kicked).toEqual([agent.id]);
    expect(await w.svc.inbox.list(me)).toEqual([]);
  });

  it('an accept that fails puts the share back for another try; a dismissed one leaves the inbox', async () => {
    const w = world();
    w.store.recordAccount(FRIEND, friendAddress);
    w.store.insertShare({ id: 'sh-bad', fromOwner: OWNER, toEmail: friendAddress, toOwner: FRIEND, agentName: 'Broken', blob: Buffer.from('not a template'), createdAt: 'now' });
    const me = { ownerId: FRIEND, email: friendAddress };
    const share = w.store.getShareFor('sh-bad', FRIEND, friendAddress)!;
    expect(w.store.setShareStatus('sh-bad', 'accepted', FRIEND)).toBe(true);
    await expect(w.svc.inbox.accept('sh-bad', share, me, { hostId: 'h1' })).rejects.toThrow();
    expect((await w.svc.inbox.list(me)).map((s) => s.id)).toEqual(['sh-bad']);
    // Dismiss is the route's one store call (transferRoutes.ts).
    w.store.setShareStatus('sh-bad', 'dismissed', FRIEND);
    expect(await w.svc.inbox.list(me)).toEqual([]);
    expect(w.kicked).toEqual([]);
  });

  /** A template of the seeded agent asking its importer one setup field. */
  async function templateAsking(w: World) {
    const id = await seed(w);
    w.store.setAgentParameters(id, [{ key: 'api_key', label: 'Key', required: true, type: 'text', target: 'env' }]);
    return id;
  }

  it('a list shows each share\'s setup fields without reading its file (HB-0960)', async () => {
    const w = world();
    const id = await templateAsking(w);
    w.store.recordAccount(FRIEND, friendAddress);
    expect(await w.svc.inbox.send(w.store.getAgent(id)!, { ownerId: OWNER }, friendAddress, undefined)).toBe('sent');
    const me = { ownerId: FRIEND, email: friendAddress };
    const reads = vi.spyOn(w.store, 'getShareFor');
    const [share] = await w.svc.inbox.list(me);
    expect(share!.parameters).toEqual([expect.objectContaining({ key: 'api_key', label: 'Key', required: true })]);
    expect(reads).not.toHaveBeenCalled();
    // What it shows is what the file holds, the fields an Accept asks.
    const { parameters } = parseTemplate(w.store.getShareFor(String(share!.id), FRIEND, friendAddress)!.blob);
    expect(share!.parameters).toEqual(parameters);
  });

  it('a share sent before its fields were kept has its file read once, off the event loop (HB-0960)', async () => {
    const w = world();
    const id = await templateAsking(w);
    const { data } = await w.svc.copies.template(w.store.getAgent(id)!, false);
    w.store.recordAccount(FRIEND, friendAddress);
    w.store.insertShare({ id: 'sh-old', fromOwner: OWNER, toEmail: friendAddress, toOwner: FRIEND, agentName: 'Kitchen', blob: data, createdAt: '2026-11-01T00:00:00.000Z' });
    w.store.insertShare({ id: 'sh-unreadable', fromOwner: OWNER, toEmail: friendAddress, toOwner: FRIEND, agentName: 'Broken', blob: Buffer.from('not a template'), createdAt: '2026-11-02T00:00:00.000Z' });
    const me = { ownerId: FRIEND, email: friendAddress };
    const reads = vi.spyOn(w.store, 'getShareFor');
    let otherWorkRan = false;
    setImmediate(() => { otherWorkRan = true; });
    const listing = w.svc.inbox.list(me);
    const ranFirst = await Promise.resolve(listing).then(() => otherWorkRan);
    // Other work waiting on the loop ran before the list was done: the files
    // were inflated off it, not in one go on it.
    expect(ranFirst).toBe(true);
    const first = await listing;
    expect(first.map((s) => [s.id, (s.parameters as Array<{ key: string }>).map((p) => p.key)])).toEqual([['sh-unreadable', []], ['sh-old', ['api_key']]]);
    expect(reads).toHaveBeenCalledTimes(2);
    // Kept: the next list reads neither file, and shows the same.
    expect(await w.svc.inbox.list(me)).toEqual(first);
    expect(reads).toHaveBeenCalledTimes(2);
  });
});

describe('adopts', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hb-transfer-adopt-'));
  const ws = join(tmp, 'workspace-made-up');
  const prevCfg = process.env.OPENCLAW_CONFIG;
  const prevDb = process.env.OPENCLAW_STATE_DB;
  beforeAll(() => {
    process.env.OPENCLAW_CONFIG = join(tmp, 'openclaw.json');
    process.env.OPENCLAW_STATE_DB = join(tmp, 'state.sqlite');
    mkdirSync(join(ws, 'memory'), { recursive: true });
    writeFileSync(join(ws, 'SOUL.md'), 'You are helpful.');
    writeFileSync(join(ws, 'AGENTS.md'), '# agents');
    writeFileSync(join(ws, 'MEMORY.md'), '# memory');
    writeFileSync(process.env.OPENCLAW_CONFIG, JSON.stringify({ agents: { list: [{ id: 'made', workspace: ws }] } }));
    const db = new Database(process.env.OPENCLAW_STATE_DB);
    db.exec(`CREATE TABLE cron_jobs (agent_id TEXT, name TEXT, description TEXT, schedule_kind TEXT,
      schedule_expr TEXT, schedule_tz TEXT, every_ms INTEGER, at TEXT, payload_kind TEXT,
      payload_message TEXT, sort_order INTEGER, created_at_ms INTEGER)`);
    db.prepare(`INSERT INTO cron_jobs (agent_id,name,schedule_kind,schedule_expr,payload_kind,payload_message,sort_order,created_at_ms)
                VALUES ('made','Morning note','cron','0 8 * * *','agentTurn','Write the note',0,1)`).run();
    db.close();
  });
  afterAll(() => {
    if (prevCfg === undefined) delete process.env.OPENCLAW_CONFIG; else process.env.OPENCLAW_CONFIG = prevCfg;
    if (prevDb === undefined) delete process.env.OPENCLAW_STATE_DB; else process.env.OPENCLAW_STATE_DB = prevDb;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('inspects a workspace, adopts it into a running agent and carries its task disabled', async () => {
    const w = world();
    const id = await seed(w);
    const look = await w.svc.adopts.inspect(ws);
    expect(look).toMatchObject({ files: ['AGENTS.md', 'MEMORY.md', 'SOUL.md'] });
    expect(look.existingBot).toBeUndefined();
    const adopted = await w.svc.adopts.adoptInto(w.store.getAgent(id)!, ws);
    expect(adopted.files).toBeGreaterThan(0);
    expect(adopted.crons).toEqual({ total: 1, carried: 1, failed: 0 });
    expect(w.local.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')).toContain('--disabled');
    expect(w.store.listAdoptPending()).toEqual([]);
  });

  it('into a stopped agent, its tasks wait, and the quick pass carries them once it runs', async () => {
    const w = world();
    const id = await seed(w);
    await w.local.stop(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'STOPPED');
    const adopted = await w.svc.adopts.adoptInto(w.store.getAgent(id)!, ws);
    expect(adopted.crons).toMatchObject({ total: 1, carried: 0, deferred: 1 });
    await w.svc.adopts.finishDeferredAdopts();
    expect(w.store.listAdoptPending()).toHaveLength(1);
    await w.local.start(w.store.getAgent(id)!.runtimeRef!);
    w.store.setAgentState(id, 'RUNNING');
    await w.svc.adopts.finishDeferredAdopts();
    expect(w.store.listAdoptPending()).toEqual([]);
    expect(w.local.execLog.find((a) => a[0] === 'cron' && a[1] === 'add')).toContain('--disabled');
  });

  it('a deferred adopt whose agent moved while its gateway was looked at writes where the agent is now (HB-0978)', async () => {
    const w = world();
    const id = await seed(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    await w.local.stop(ref);
    w.store.setAgentState(id, 'STOPPED');
    await w.svc.adopts.adoptInto(w.store.getAgent(id)!, ws);
    await w.local.start(ref);
    w.store.setAgentState(id, 'RUNNING');
    // The quick pass looks at its gateway on this machine; a move to the runner ends meanwhile.
    await w.runner.provision({ agentId: id, slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} });
    await w.runner.start(ref);
    const exec = w.local.exec.bind(w.local);
    w.local.exec = async (r, argv, o) => {
      const out = await exec(r, argv, o);
      if (argv[0] === 'cron' && argv[1] === 'list' && w.store.getAgent(id)!.hostId === 'h1') w.store.setAgentHost(id, 'h2');
      return out;
    };
    const adds = (p: MockProvider) => p.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add');
    const before = adds(w.local).length;
    await w.svc.adopts.finishDeferredAdopts();
    expect(adds(w.runner)).toHaveLength(1);
    expect(adds(w.local)).toHaveLength(before);
    expect(w.store.listAdoptPending()).toEqual([]);
  });

  it('a deferred adopt whose agent stopped while its gateway was looked at waits for the next pass (HB-0978)', async () => {
    const w = world();
    const id = await seed(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    await w.local.stop(ref);
    w.store.setAgentState(id, 'STOPPED');
    await w.svc.adopts.adoptInto(w.store.getAgent(id)!, ws);
    await w.local.start(ref);
    w.store.setAgentState(id, 'RUNNING');
    const exec = w.local.exec.bind(w.local);
    w.local.exec = async (r, argv, o) => {
      const out = await exec(r, argv, o);
      if (argv[0] === 'cron' && argv[1] === 'list') w.store.setAgentState(id, 'STOPPED');
      return out;
    };
    await w.svc.adopts.finishDeferredAdopts();
    expect(w.local.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add')).toHaveLength(0);
    expect(w.store.listAdoptPending()).toHaveLength(1);
  });

  it('a deferred adopt whose old task store cannot be read keeps trying for its day, then tells the owner (HB-0979)', async () => {
    const w = world();
    const id = await seed(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    await w.local.stop(ref);
    w.store.setAgentState(id, 'STOPPED');
    expect((await w.svc.adopts.adoptInto(w.store.getAgent(id)!, ws)).crons).toMatchObject({ deferred: 1 });
    // Then the old install's task store goes unreadable (damaged, or out of reach).
    const damaged = join(tmp, 'damaged.sqlite');
    writeFileSync(damaged, 'not a database at all, made up for the test');
    const good = process.env.OPENCLAW_STATE_DB;
    process.env.OPENCLAW_STATE_DB = damaged;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-11-20T09:00:00.000Z'));
      await w.local.start(ref);
      w.store.setAgentState(id, 'RUNNING');
      await w.svc.adopts.finishDeferredAdopts();
      expect(w.store.listAdoptPending()).toHaveLength(1);   // not read as "no tasks"
      expect(w.notes).toEqual([]);
      vi.setSystemTime(Date.parse('2026-11-21T10:00:00.000Z'));   // a day of not reading it
      await w.svc.adopts.finishDeferredAdopts();
    } finally {
      vi.useRealTimers();
      process.env.OPENCLAW_STATE_DB = good;
    }
    expect(w.store.listAdoptPending()).toEqual([]);
    expect(w.notes).toHaveLength(1);
    expect(w.notes[0]).toMatch(/^The scheduled tasks of the OpenClaw agent adopted into Kitchen could not be read \(the task store could not be read .*\), so none of them came over\. Add them again in its Tasks page\.$/);
  });

  const adds = (w: World) => w.local.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add');
  const looks = (w: World) => w.local.execLog.filter((a) => a[0] === 'cron' && a[1] === 'list').length;
  /**
   * The two refusals a re-point meets (HB-1466), each let go by what it
   * returns. Another operation takes the agent's busy flag between the copy
   * and the re-point (as the adopt keeps its record), or at the quick pass's
   * look at its gateway; or a change holds the agent's files turn, and the
   * re-point does not wait for it.
   */
  function takenAfterTheCopy(w: World, id: string) {
    let release: (() => void) | undefined;
    const set = w.store.setAdoptPending.bind(w.store);
    w.store.setAdoptPending = (...args) => { set(...args); release ??= markBusy(id); };
    return async () => { release?.(); w.store.setAdoptPending = set; };
  }
  function takenAtTheLook(w: World, id: string) {
    let release: (() => void) | undefined;
    const exec = w.local.exec.bind(w.local);
    w.local.exec = async (r, argv, o) => {
      const out = await exec(r, argv, o);
      if (argv[0] === 'cron' && argv[1] === 'list') release ??= markBusy(id);
      return out;
    };
    return async () => { release?.(); w.local.exec = exec; };
  }
  function filesTurnHeld(w: World, id: string) {
    const turns = w.turns;
    w.turns = { ...turns, withCoreFilesTurn: (agentId, fn) => turns.withCoreFilesTurn(agentId, fn, 0) };
    let go!: () => void;
    const until = new Promise<void>((r) => { go = r; });
    const held = turns.withCoreFilesTurn(id, () => until);
    return async () => { go(); await held; w.turns = turns; };
  }

  it.each([
    ['another operation takes the agent after the copy', takenAfterTheCopy],
    ['its files turn does not come in time', filesTurnHeld],
  ] as const)('an adopt into a running agent whose re-point is refused (%s) says its tasks were put off, and the pass carries them (HB-1466)', async (_how, refuse) => {
    const w = world();
    const id = await seed(w);
    const free = refuse(w, id);
    let adopted;
    try { adopted = await w.svc.adopts.adoptInto(w.store.getAgent(id)!, ws); } finally { await free(); }
    // It answered no tasks at all, though its record carried them later.
    expect(adopted.crons).toEqual({ total: 1, carried: 0, failed: 0, deferred: 1 });
    expect(w.store.listAdoptPending()).toHaveLength(1);
    expect(adds(w)).toHaveLength(0);
    await w.svc.adopts.finishDeferredAdopts();
    expect(w.store.listAdoptPending()).toEqual([]);
    expect(adds(w)[0]).toContain('--disabled');
  });

  /** Adopted into a stopped agent, then started: its adopt waits for the quick pass. */
  async function putOffThenStarted(w: World) {
    const id = await seed(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    await w.local.stop(ref);
    w.store.setAgentState(id, 'STOPPED');
    expect((await w.svc.adopts.adoptInto(w.store.getAgent(id)!, ws)).crons).toMatchObject({ deferred: 1 });
    await w.local.start(ref);
    w.store.setAgentState(id, 'RUNNING');
    return id;
  }

  it.each([
    ['another operation takes the agent at its look', takenAtTheLook],
    ['its files turn does not come in time', filesTurnHeld],
  ] as const)('a put-off adopt whose re-point is refused (%s) is tried again at the next pass, not an hour on (HB-1466)', async (_how, refuse) => {
    const w = world();
    const id = await putOffThenStarted(w);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-11-20T09:00:00.000Z'));
      const free = refuse(w, id);
      try { await w.svc.adopts.finishDeferredAdopts(); } finally { await free(); }
      expect(w.store.listAdoptPending()).toHaveLength(1);
      expect(adds(w)).toHaveLength(0);
      vi.setSystemTime(Date.parse('2026-11-20T09:05:00.000Z'));   // the next quick pass
      await w.svc.adopts.finishDeferredAdopts();
    } finally { vi.useRealTimers(); }
    expect(w.store.listAdoptPending()).toEqual([]);
    expect(adds(w)[0]).toContain('--disabled');
  });

  /**
   * A change that holds the agent's files turn until let go (`free`), and
   * `asked`, settled once something else asks for the turn (the copy before
   * it reads and packs real files, not on the fake clock), as `next()` is
   * for the ask after. What waits for it keeps the turn's own limits.
   */
  function changeHoldsTheTurn(w: World, id: string) {
    const turns = w.turns;
    let go!: () => void;
    const until = new Promise<void>((r) => { go = r; });
    const held = turns.withCoreFilesTurn(id, () => until);
    let ask: (() => void) | undefined;
    /** Settled once something next asks for the turn. */
    const next = () => new Promise<void>((r) => { ask = r; });
    const asked = next();
    w.turns = { ...turns, withCoreFilesTurn: (agentId, fn, waitMs) => { ask?.(); return turns.withCoreFilesTurn(agentId, fn, waitMs); } };
    return { asked, next, free: async () => { go(); await held; w.turns = turns; } };
  }
  const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

  it('the pass\'s re-point waits a short while for a held files turn, then lets the agent go and is left for the next pass (HB-1466)', async () => {
    const w = world();
    const id = await putOffThenStarted(w);
    const { asked, free } = changeHoldsTheTurn(w, id);
    let settled = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-11-20T09:00:00.000Z'));
      const pass = w.svc.adopts.finishDeferredAdopts().finally(() => { settled = true; });
      await asked;
      await vi.advanceTimersByTimeAsync(ADOPT_PASS_TURN_WAIT_MS - 1);
      await ticks();
      expect(settled).toBe(false);
      expect(isBusy(id)).toBe(true);       // it waits for the turn under the agent's busy flag
      await vi.advanceTimersByTimeAsync(1);
      await ticks();
      // Refused at the short wait, the flag let go: at the turn's full limit
      // (2 minutes) the owner's other operations were refused as busy meanwhile.
      expect(settled).toBe(true);
      expect(isBusy(id)).toBe(false);
      await pass;
      expect(w.store.listAdoptPending()).toHaveLength(1);
      expect(adds(w)).toHaveLength(0);
      await free();
      vi.setSystemTime(Date.parse('2026-11-20T09:05:00.000Z'));   // the next quick pass
      const again = w.svc.adopts.finishDeferredAdopts();
      await vi.advanceTimersByTimeAsync(60_000);
      await again;
    } finally {
      // Failing, let what still waits end before the timers are real again.
      if (!settled) { await free(); await vi.advanceTimersByTimeAsync(CORE_FILES_WAIT_MS); }
      vi.useRealTimers();
    }
    expect(w.store.listAdoptPending()).toEqual([]);
    expect(adds(w)[0]).toContain('--disabled');
  });

  it('an adopt\'s own re-point still waits the files turn\'s full limit (HB-1466)', async () => {
    const w = world();
    const id = await seed(w);
    const { asked, free } = changeHoldsTheTurn(w, id);
    let settled = false;
    let adopted;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const adopting = w.svc.adopts.adoptInto(w.store.getAgent(id)!, ws).finally(() => { settled = true; });
      await asked;                                                       // its re-point waits for the turn
      await vi.advanceTimersByTimeAsync(CORE_FILES_WAIT_MS - 1_000);   // well past the pass's short wait
      await ticks();
      expect(settled).toBe(false);
      await free();
      await vi.advanceTimersByTimeAsync(60_000);
      adopted = await adopting;
    } finally {
      if (!settled) { await free(); await vi.advanceTimersByTimeAsync(CORE_FILES_WAIT_MS); }
      vi.useRealTimers();
    }
    // It got the turn once the change ended, and carried the task then.
    expect(adopted.crons).toEqual({ total: 1, carried: 1, failed: 0 });
    expect(w.store.listAdoptPending()).toEqual([]);
  });

  it('a run of refused passes is said once, and goes straight to the re-point with no look at its gateway each time (HB-1466)', async () => {
    const w = world();
    const id = await putOffThenStarted(w);
    const turn = changeHoldsTheTurn(w, id);
    const before = looks(w);
    const start = Date.parse('2026-11-20T09:00:00.000Z');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // An hour of the turn held: twelve passes, each refused at the short wait.
      for (let i = 0; i < 12; i++) {
        vi.setSystemTime(start + i * 5 * 60_000);
        const asked = i === 0 ? turn.asked : turn.next();
        const pass = w.svc.adopts.finishDeferredAdopts();
        await asked;
        await vi.advanceTimersByTimeAsync(ADOPT_PASS_TURN_WAIT_MS);
        await pass;
      }
      // Twelve of each before: the timeline keeps 200 events an agent.
      expect(w.events.filter((e) => e === 'adopt.repoint_busy')).toHaveLength(1);
      expect(looks(w) - before).toBe(1);   // the first pass's look only
      expect(w.store.listAdoptPending()).toHaveLength(1);
      expect(adds(w)).toHaveLength(0);
      await turn.free();
      vi.setSystemTime(start + 12 * 5 * 60_000);
      const pass = w.svc.adopts.finishDeferredAdopts();
      await vi.advanceTimersByTimeAsync(60_000);
      await pass;
    } finally { await turn.free(); vi.useRealTimers(); }
    expect(w.store.listAdoptPending()).toEqual([]);
    expect(adds(w)[0]).toContain('--disabled');
    expect(w.events).toContain('adopt.deferred_done');
  });

  // What ends a run of refusals (HB-1466): a re-point that runs, the agent
  // found stopped, the record gone. After each the next pass looks first,
  // and a new refusal is said again.
  const said = (w: World) => w.events.filter((e) => e === 'adopt.repoint_busy').length;

  it('a refused adopt whose next re-point runs and finds its gateway down looks at it first again after that (HB-1466)', async () => {
    const w = world();
    const id = await putOffThenStarted(w);
    const start = Date.parse('2026-11-20T09:00:00.000Z');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.setSystemTime(start);
      const free = takenAtTheLook(w, id);
      await w.svc.adopts.finishDeferredAdopts();                 // looked, then refused
      await free();
      // Its gateway stops answering. The next pass goes straight to the
      // re-point, which runs, and finds it so: the adopt waits.
      w.local.execResponses.set('cron list', { code: 1, stdout: '', stderr: 'gateway not ready' });
      vi.setSystemTime(start + 5 * 60_000);
      let pass = w.svc.adopts.finishDeferredAdopts();
      await vi.advanceTimersByTimeAsync(60_000);
      await pass;
      expect(w.events).toContain('adopt.deferred_waiting');
      expect(w.store.listAdoptPending()).toHaveLength(1);
      // An hour on, it looks first (one `cron list`, outside the busy flag)
      // and stops there, rather than the re-point's two under the flag.
      const before = looks(w);
      vi.setSystemTime(start + 66 * 60_000);
      pass = w.svc.adopts.finishDeferredAdopts();
      await vi.advanceTimersByTimeAsync(60_000);
      await pass;
      expect(looks(w) - before).toBe(1);
    } finally { vi.useRealTimers(); }
    expect(w.store.listAdoptPending()).toHaveLength(1);
  });

  it('a refused adopt whose agent stops and starts again says a new refusal again (HB-1466)', async () => {
    const w = world();
    const id = await putOffThenStarted(w);
    const ref = w.store.getAgent(id)!.runtimeRef!;
    const turn = changeHoldsTheTurn(w, id);
    const start = Date.parse('2026-11-20T09:00:00.000Z');
    const refusedPass = async (asked: Promise<void>) => {
      const pass = w.svc.adopts.finishDeferredAdopts();
      await asked;
      await vi.advanceTimersByTimeAsync(ADOPT_PASS_TURN_WAIT_MS);
      await pass;
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      vi.setSystemTime(start);
      await refusedPass(turn.asked);
      expect(said(w)).toBe(1);
      await w.local.stop(ref);
      w.store.setAgentState(id, 'STOPPED');
      vi.setSystemTime(start + 5 * 60_000);
      await w.svc.adopts.finishDeferredAdopts();                 // found stopped
      await w.local.start(ref);
      w.store.setAgentState(id, 'RUNNING');
      vi.setSystemTime(start + 10 * 60_000);
      await refusedPass(turn.next());                            // the turn still held
    } finally { await turn.free(); vi.useRealTimers(); }
    expect(said(w)).toBe(2);
    expect(w.store.listAdoptPending()).toHaveLength(1);
  });

  it('a refused adopt whose record goes is forgotten: the folder adopted again and refused is said again (HB-1466)', async () => {
    const w = world();
    const id = await putOffThenStarted(w);
    let free = takenAtTheLook(w, id);
    await w.svc.adopts.finishDeferredAdopts();                   // refused, and said
    await free();
    expect(said(w)).toBe(1);
    // Its record goes (as a newer adopt with nothing to re-point drops it),
    // and the pass after that forgets the refusal.
    w.store.dropAdoptPending(id);
    await w.svc.adopts.finishDeferredAdopts();
    free = takenAfterTheCopy(w, id);
    let adopted;
    try { adopted = await w.svc.adopts.adoptInto(w.store.getAgent(id)!, ws); } finally { await free(); }
    expect(adopted.crons).toMatchObject({ deferred: 1 });
    expect(said(w)).toBe(2);
  });

  it('a put-off adopt whose re-point failed, not refused, is looked at again an hour on, not at every pass (HB-1466)', async () => {
    const w = world();
    const id = await putOffThenStarted(w);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-11-20T09:00:00.000Z'));
      // Its machine is one this server does not know when the re-point reads
      // it, after the look: the re-point throws, and nothing refused it.
      const exec = w.local.exec.bind(w.local);
      w.local.exec = async (r, argv, o) => {
        const out = await exec(r, argv, o);
        if (argv[0] === 'cron' && argv[1] === 'list') w.store.setAgentHost(id, 'h-made-up');
        return out;
      };
      await w.svc.adopts.finishDeferredAdopts();
      w.local.exec = exec;
      w.store.setAgentHost(id, 'h1');
      expect(w.store.listAdoptPending()).toHaveLength(1);
      // Said as a failure, tried again within the hour: not as the agent busy.
      expect(w.events.filter((e) => e.startsWith('adopt.repoint_'))).toEqual(['adopt.repoint_failed']);
      const before = looks(w);
      vi.setSystemTime(Date.parse('2026-11-20T09:05:00.000Z'));
      await w.svc.adopts.finishDeferredAdopts();
      expect(looks(w)).toBe(before);                                // not looked at again yet
      expect(w.store.listAdoptPending()).toHaveLength(1);
      vi.setSystemTime(Date.parse('2026-11-20T10:01:00.000Z'));
      await w.svc.adopts.finishDeferredAdopts();
    } finally { vi.useRealTimers(); }
    expect(w.store.listAdoptPending()).toEqual([]);
    expect(adds(w)[0]).toContain('--disabled');
  });
});

describe('tasks an agent did not adopt itself (HB-0985)', () => {
  it('a clone of an adopted agent: adopting the same folder into the clone adds nothing again', async () => {
    const w = world();
    const id = await seed(w);
    // The OpenClaw agent adopted into it, and its one task (all made up).
    const dir = mkdtempSync(join(tmpdir(), 'hb-carried-'));
    try {
      const cfg = join(dir, 'openclaw.json');
      const ws = join(dir, 'ws-garden');
      writeFileSync(cfg, JSON.stringify({ agents: { list: [{ id: 'garden-advisor', workspace: ws }] } }));
      const src = join(dir, 'openclaw.sqlite');
      const s = new Database(src);
      s.exec('CREATE TABLE cron_jobs (job_id TEXT, agent_id TEXT, declaration_key TEXT, job_json TEXT, updated_at INTEGER)');
      const task = { name: 'Daily brief', schedule: { kind: 'every', everyMs: 3_600_000 }, payload: { kind: 'agentTurn', message: 'Write the brief' }, sessionTarget: 'isolated', delivery: { mode: 'announce' } };
      s.prepare('INSERT INTO cron_jobs VALUES (?,?,?,?,?)').run('s0', 'garden-advisor', null, JSON.stringify(task), 1);
      s.close();
      const adopt = (agentId: string) => migrateCrons({ store: w.store, provider: w.local }, agentId, ws, { configPath: cfg, dbPath: src, readyGapMs: 0 });
      const adds = () => w.local.execLog.filter((a) => a[0] === 'cron' && a[1] === 'add');
      const listing = (jobs: object[]) => w.local.execResponses.set('cron list', { code: 0, stderr: '', stdout: JSON.stringify({ jobs }) });
      listing([]);
      w.local.execResponses.set('cron add', { code: 0, stderr: '', stdout: JSON.stringify({ id: 'c1' }) });
      expect(await adopt(id)).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(adds()).toHaveLength(1);
      // Switched on by its owner, so its template carries it.
      listing([{ id: 'c1', enabled: true, ...task }]);
      const { clone } = await w.svc.copies.clone(w.store.getAgent(id)!, { owner: OWNER, current: () => w.store.getAgent(id), ask: () => ({ name: 'Kitchen Copy', telegram: false }) });
      expect(w.store.getPendingSchedules(clone.id)).toEqual([expect.objectContaining({ name: 'Daily brief', message: 'Write the brief' })]);
      expect(w.store.mayHoldUnrecordedCarriedTasks(clone.id)).toBe(true);
      // Built: the task is there, made from the template under an id of its own, in the clone's console.
      const { runtimeRef } = await w.local.provision({ agentId: clone.id, slug: clone.slug, workspace: { files: {}, configPatch: { agentId: clone.slug, authMode: 'api-key' } }, env: {} });
      w.store.setAgentRuntimeRef(clone.id, runtimeRef);
      await w.local.start(runtimeRef);
      w.store.setAgentState(clone.id, 'RUNNING');
      listing([{ id: 'k1', enabled: true, ...task, sessionTarget: 'current', sessionKey: `agent:${clone.slug}:main` }]);
      expect(await adopt(clone.id)).toEqual({ total: 1, carried: 1, failed: 0 });
      expect(adds()).toHaveLength(1);
      expect(w.store.carriedTasks(clone.id)).toEqual([{ sourceAgent: 'garden-advisor', sourceId: 's0', copyId: 'k1' }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
