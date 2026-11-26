import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { markBusy, clearBusy } from '../src/orchestrator/lifecycle/busy.js';
import { beginOperation } from '../src/orchestrator/lifecycle/operations.js';
import { createMachines, type Machines } from '../src/orchestrator/machines/machines.js';
import { createImageInstalls } from '../src/orchestrator/machines/imageInstalls.js';
import { registerMachineRoutes } from '../src/api/machine/machineRoutes.js';
import { blockedMessage, cleanPackages } from '../src/orchestrator/machines/runtimeImages.js';
import { sameEndpoint } from '../src/orchestrator/machines/hosts.js';
import { dockerNames } from '../src/providers/dockerNames.js';
import type { Agent, Host } from '../src/domain/types.js';

// Install image's copy, held by the test: nothing is saved or loaded.
const copies = vi.hoisted(() => ({ calls: [] as string[], opts: [] as Array<Record<string, unknown>>, release: undefined as undefined | ((r: { ok: boolean; error?: string; pulled?: string; differs?: string }) => void) }));
vi.mock('../src/orchestrator/machines/runnerSetup.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/orchestrator/machines/runnerSetup.js')>();
  return {
    ...real,
    ensureRunnerKey: async () => 'ssh-ed25519 made-up',
    ensureSshConfigBlock: async () => {},
    installRuntimeImage: (dockerHost: string, opts: Record<string, unknown> = {}) => {
      copies.calls.push(dockerHost);
      copies.opts.push(opts);
      return new Promise((resolve) => { copies.release = resolve; });
    },
  };
});

// A runner's probe answers what the test says, and never runs docker; held while `hold` is set.
const pings = vi.hoisted(() => ({ calls: [] as string[], images: [] as Array<string | undefined>, hold: false, held: [] as Array<() => void> }));
vi.mock('../src/providers/resolveProvider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/resolveProvider.js')>()),
  pingRunner: async (dockerHost: string, opts: { image?: string } = {}) => {
    pings.calls.push(dockerHost);
    pings.images.push(opts.image);
    if (pings.hold) await new Promise<void>((r) => { pings.held.push(r); });
    return { ok: false, error: 'not reached in this test' };
  },
}));

// No release manifest is fetched: Install image asks for one only to pull on a runner of another CPU.
vi.mock('../src/providers/releaseManifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/releaseManifest.js')>()),
  publishedRuntimeImage: async () => ({ problem: 'No release manifest in this test.' }),
}));

/**
 * The machines, runners and images service (HB-0808): this machine and its
 * runners, Install image, live CPU and memory, and the runtime images,
 * driven as the routes drive them but with no HTTP server. A real store on
 * an in-memory database; runtime providers that are plain objects answering
 * from what each test sets; builds that are functions the test resolves.
 * Made-up data only.
 */
const OWNER = 'user-owner';
const MEMBER = 'user-member';
const BASE = 'hatchabot-runtime:latest';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A machine as the service sees it: what each provider call answers. */
interface FakeMachine {
  reachable?: boolean;
  /** What a quick connect answers, when not at once (a slow probe). */
  reachableAnswer?: () => Promise<boolean>;
  daemon?: string;
  browsers?: Array<{ name: string; agentContainer: string }>;
  stopped: string[];
  /** What a stop answers, when not at once (a slow stop). */
  stopAnswer?: (ref: string) => Promise<void>;
  inUse?: { containers: Array<{ name: string; imageId: string; state: string }>; tags: Array<{ tag: string; imageId: string }> };
  statsCalls: number;
  /** What a docker stats sample answers, when not at once with nothing. */
  statsAnswer?: () => Promise<never[]>;
  /** Its image tags, as listImageTags answers. */
  tags?: Array<{ tag: string; imageId: string; size?: string; extraPackages?: string[]; buildInputs?: string }>;
  /** Its image listing fails, as a `docker images` that timed out does. */
  listFails?: boolean;
  /** The OpenClaw its default image runs, and each container's. */
  defaultRuns?: string;
  /** The memory search engine its images carry, as currentImageInfo answers. */
  imageEngine?: 'baked' | 'none';
  runs?: Record<string, string>;
  /** The container a ref names, where it is not the ref's own name (a legacy ref). */
  names?: Record<string, string>;
  /** Tags moved (from, to); `tagFails` makes docker refuse. */
  tagged?: Array<[string, string]>;
  tagFails?: boolean;
}

interface World {
  store: Store;
  svc: Machines;
  machines: Record<string, FakeMachine>;
  traced: string[];
  told: Array<{ ownerId: string; body: string }>;
  disowned: string[];
  removing: Set<string>;
  forgotten: string[];
  embedRemoved: Array<{ hostId: string; onMachine: boolean }>;
  derived: Array<{ name: string; finish: (r: { ok: boolean; error?: string }) => void }>;
  base: Array<{ opts: Record<string, unknown>; finish: (r: { ok: boolean; error?: string }) => void }>;
  distReads: number;
  /** Whether the shared memory search service is on (unset: on). */
  searchOn?: boolean;
  /** What npm answers, when not at once (a slow read). */
  distAnswer?: () => Promise<Record<string, string>>;
}

/** `defaultBase`: the image agents run on (HATCHABOT_IMAGE); BASE unless a test pins it. */
function world(o: { defaultBase?: string } = {}): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'This machine', settings: {}, createdAt: 'now' });
  store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'cloud', provider: 'remote-docker', name: 'Laptop runner', settings: { dockerHost: 'ssh://runner@10.0.0.9' }, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = {
    store, machines: { h1: { daemon: 'daemon-one', stopped: [], statsCalls: 0 }, h2: { daemon: 'daemon-two', stopped: [], statsCalls: 0 } },
    traced: [], told: [], disowned: [], removing: new Set(), forgotten: [], embedRemoved: [], derived: [], base: [], distReads: 0,
  } as unknown as World;
  const providerFor = (hostId: string) => {
    const m = w.machines[hostId];
    if (!m) throw new Error(`no host ${hostId}`);
    return {
      key: hostId,
      reachable: async () => (m.reachableAnswer ? m.reachableAnswer() : m.reachable ?? true),
      daemonId: async () => m.daemon,
      listBrowsers: async () => m.browsers ?? [],
      stopBrowser: async (c: string) => { m.stopped.push(`browser:${c}`); },
      sweepOneShots: async () => {},
      stop: async (ref: string) => { m.stopped.push(ref); if (m.stopAnswer) await m.stopAnswer(ref); },
      imagesInUse: async () => m.inUse ?? { containers: [], tags: [] },
      containerName: (ref: string) => m.names?.[ref] ?? ref.replace(/^mock:\/\//, ''),
      listImageTags: async () => { if (m.listFails) throw new Error('docker images: context deadline exceeded'); return m.tags ?? []; },
      currentImageInfo: async () => ({ ...(m.defaultRuns ? { openclawVersion: m.defaultRuns } : {}), ...(m.imageEngine ? { embedEngine: m.imageEngine } : {}) }),
      info: async (ref: string) => (m.runs?.[ref] ? { openclawVersion: m.runs[ref] } : {}),
      stats: async () => { m.statsCalls++; return m.statsAnswer ? m.statsAnswer() : []; },
      tagImage: async (from: string, to: string) => { if (m.tagFails) throw new Error('No such image'); (m.tagged ??= []).push([from, to]); },
    } as never;
  };
  const data = mkdtempSync(join(tmpdir(), 'hb-machines-'));
  dirs.push(data);
  w.svc = createMachines({
    store, providerFor,
    trace: () => (event) => { w.traced.push(event); },
    disownPauseOnStop: (id) => { w.disowned.push(id); },
    beginRemoval: (id) => { if (w.removing.has(id)) return false; w.removing.add(id); return true; },
    endRemoval: (id) => { w.removing.delete(id); },
    embedderOf: (hostId) => ({ remove: async (onMachine) => { w.embedRemoved.push({ hostId, onMachine }); return {}; } }),
    forgetEmbedder: (id) => { w.forgotten.push(`embedder:${id}`); },
    forgetProviders: (id) => { w.forgotten.push(`providers:${id}`); },
    defaultBase: o.defaultBase ?? BASE,
    dataDir: data,
    sharedMemorySearchOn: () => w.searchOn !== false,
    notify: async (ownerId, body) => { w.told.push({ ownerId, body }); },
    log: { info: () => {}, error: () => {} },
    buildImage: ((o: { name: string }) => new Promise((finish) => { w.derived.push({ name: o.name, finish: finish as never }); })) as never,
    buildBase: (opts) => new Promise((finish) => { w.base.push({ opts, finish }); }),
    openclawDistTags: async () => { w.distReads++; return (w.distAnswer ? await w.distAnswer() : { latest: '2026.9.8' }) as never; },
  });
  return w;
}

function agent(w: World, id: string, o: { ownerId?: string; state?: Agent['state']; hostId?: string; image?: string } = {}): Agent {
  const state = o.state ?? 'RUNNING';
  w.store.insertAgent({
    id, ownerId: o.ownerId ?? OWNER, name: `Agent ${id}`, slug: id, state, aiProfileId: 'p1', hostId: o.hostId ?? 'h1',
    persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now', ...(state === 'RUNNING' ? { runtimeRef: `mock://${id}` } : {}),
  } as never);
  if (o.image) w.store.setAgentImage(id, o.image);
  return w.store.getAgent(id)!;
}

const host = (w: World, id: string): Host => w.store.getHost(id)!;
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the machines', () => {
  it('the machine owner counts every agent and sees each row\'s settings; a member counts their own and sees none of the owner\'s', async () => {
    const w = world();
    agent(w, 'a1', { hostId: 'h2' });
    agent(w, 'a2', { hostId: 'h2', ownerId: MEMBER });
    const owner = await w.svc.hosts.list(OWNER, true);
    const runner = owner.find((h) => h.id === 'h2')!;
    expect(runner).toMatchObject({ agentCount: 2, settings: { dockerHost: 'ssh://runner@10.0.0.9' }, reachable: true });
    expect(owner.find((h) => h.id === 'h1')).toHaveProperty('hostname');
    const member = await w.svc.hosts.list(MEMBER, false);
    // The member is listed the owner's rows as Store lists them, never with their settings.
    for (const h of member) expect(h).not.toHaveProperty('settings');
  });

  it('an address that cannot sign in, or one already added (written another way), is refused before anything is saved', () => {
    const w = world();
    expect(w.svc.hosts.addProblem(OWNER, 'ssh://runner@[fd00::1]')).toMatchObject({ invalid: expect.stringContaining('IPv6') });
    expect(w.svc.hosts.addProblem(OWNER, 'tcp://runner.example:2376')).toHaveProperty('invalid');
    expect(w.svc.hosts.addProblem(OWNER, 'SSH://runner@10.0.0.9/')).toMatchObject({ already: { id: 'h2' } });
    expect(w.svc.hosts.addProblem(OWNER, 'ssh://runner@10.0.0.8')).toBeUndefined();
    expect(sameEndpoint(' ssh://A@b/ ', 'ssh://a@b')).toBe(true);
    expect(sameEndpoint('', '')).toBe(false);
  });

  it('a runner is saved whether its probe answered or not, owned by whoever added it', async () => {
    const w = world();
    const r = await w.svc.hosts.add({ ownerId: OWNER, name: 'Spare', dockerHost: 'ssh://spare.invalid' });
    if (!('host' in r)) throw new Error('not added');
    const { host: added, ping } = r;
    expect(ping.ok).toBe(false);
    expect(w.store.getHost(added.id)).toMatchObject({ name: 'Spare', ownerId: OWNER, kind: 'cloud', settings: { dockerHost: 'ssh://spare.invalid' } });
  });

  it('Add and Check look on the runner for the image its agents run, HATCHABOT_IMAGE, not hatchabot-runtime:latest (HB-1108)', async () => {
    const custom = 'registry.example:5000/family/runtime:2026.9.8';
    const w = world({ defaultBase: custom });
    pings.images.length = 0;
    const r = await w.svc.hosts.add({ ownerId: OWNER, name: 'Spare', dockerHost: 'ssh://spare.invalid' });
    expect(r).toHaveProperty('host');
    const app = Fastify();
    registerMachineRoutes(app, {
      store: w.store, providerFor: () => ({}), ownedAgent: () => undefined, ownsLocalHost: () => true, holdOnce: () => true,
      hostBeingRemoved: () => false, machines: w.svc,
    } as never);
    try {
      const check = await app.inject({ method: 'GET', url: '/v1/hosts/h2/ping' });
      expect(check.statusCode, check.body).toBe(200);
      expect(pings.images).toEqual([custom, custom]);
      // An ordinary install looks for what it always did.
      pings.images.length = 0;
      await world().svc.hosts.add({ ownerId: OWNER, name: 'Spare', dockerHost: 'ssh://spare.invalid' });
      expect(pings.images).toEqual([BASE]);
    } finally { await app.close(); }
  });

  it('two adds of one address written two ways at once make one row: the second finds the first when its probe answers (HB-1119)', async () => {
    const w = world();
    pings.hold = true;
    try {
      const first = w.svc.hosts.add({ ownerId: OWNER, name: 'Spare', dockerHost: 'ssh://spare@10.0.0.7' });
      const second = w.svc.hosts.add({ ownerId: OWNER, name: 'Spare again', dockerHost: 'ssh://Spare@10.0.0.7/' });
      for (let i = 0; i < 20 && pings.held.length < 2; i++) await settle();
      expect(pings.held).toHaveLength(2);
      for (const go of pings.held.splice(0)) go();
      const [a, b] = await Promise.all([first, second]);
      expect(a).toHaveProperty('host');
      expect(b).toEqual({ already: expect.objectContaining({ name: 'Spare' }) });
      expect(w.store.listHosts(OWNER).filter((h) => sameEndpoint(h.settings?.dockerHost, 'ssh://spare@10.0.0.7'))).toHaveLength(1);
    } finally { pings.hold = false; for (const go of pings.held.splice(0)) go(); }
  });

  it('drain stops the running agents on the host and names the busy one it skipped', async () => {
    const w = world();
    agent(w, 'a1', { hostId: 'h2' });
    agent(w, 'a2', { hostId: 'h2' });
    agent(w, 'a3', { hostId: 'h1' });
    markBusy('a2');
    try {
      const r = await w.svc.hosts.drain(host(w, 'h2'));
      expect(r).toEqual({ stopped: 1, skipped: ['Agent a2'] });
    } finally { clearBusy('a2'); }
    expect(w.machines.h2!.stopped).toEqual(['mock://a1']);
    expect(w.store.getAgent('a1')!.state).toBe('STOPPED');
    expect(w.store.getAgent('a3')!.state).toBe('RUNNING');
    expect(w.disowned).toEqual(['a1']);
  });

  it('drain stops an agent as it is when its turn comes: one moved away meanwhile is left running where it is now (HB-0904)', async () => {
    const w = world();
    agent(w, 'a1', { hostId: 'h2' });
    agent(w, 'a2', { hostId: 'h2' });
    agent(w, 'a3', { hostId: 'h2' });
    // a1's stop is slow; meanwhile a2 moves to this machine (its old copy left
    // on the runner), and a3 is rebuilt there under a new container.
    let stopped!: () => void;
    w.machines.h2!.stopAnswer = (ref) => (ref === 'mock://a1' ? new Promise((r) => { stopped = r; }) : Promise.resolve());
    const draining = w.svc.hosts.drain(host(w, 'h2'));
    for (let i = 0; i < 20 && !stopped; i++) await settle();
    w.store.setAgentHost('a2', 'h1');
    w.store.setAgentRuntimeRef('a2', 'mock://a2-moved');
    w.store.setAgentRuntimeRef('a3', 'mock://a3-rebuilt');
    stopped();
    expect(await draining).toEqual({ stopped: 2, skipped: [] });
    expect(w.machines.h2!.stopped).toEqual(['mock://a1', 'mock://a3-rebuilt']);
    expect(w.machines.h1!.stopped).toEqual([]);
    expect(w.store.getAgent('a2')).toMatchObject({ hostId: 'h1', state: 'RUNNING' });
    expect(w.disowned).toEqual(['a1', 'a3']);
  });

  it('a host is not removed while an agent runs on it, a move to or from it is not over, or another removal holds it', async () => {
    const w = world();
    agent(w, 'a1', { hostId: 'h2' });
    expect(await w.svc.hosts.remove(host(w, 'h2'))).toEqual({ refused: { error: '1 agent still run on this host — move or delete them first.' } });
    const m = world();
    const mover = agent(m, 'a2', { hostId: 'h1' });
    const op = beginOperation(m.store, 'move-host', mover.id, { from: 'h1', to: 'h2' });
    const refused = await m.svc.hosts.remove(host(m, 'h2'));
    expect(refused).toMatchObject({ refused: { operation: op.id, error: expect.stringContaining('Agent a2') } });
    op.done('moved');
    m.removing.add('h2');
    expect(await m.svc.hosts.remove(host(m, 'h2'))).toEqual({ going: true });
    expect(m.store.getHost('h2')).toBeDefined();
    expect(m.removing.has('h2')).toBe(true); // the other removal's hold is not let go
  });

  it('a removed runner takes what Hatchabot ran there with it, and lets go of its hold', async () => {
    const w = world();
    w.machines.h2!.browsers = [{ name: 'b1', agentContainer: 'hatchabot-gone' }];
    const r = await w.svc.hosts.remove(host(w, 'h2'));
    expect(r).toEqual({ ok: true });
    expect(w.store.getHost('h2')).toBeUndefined();
    expect(w.machines.h2!.stopped).toEqual(['browser:hatchabot-gone']);
    expect(w.embedRemoved).toEqual([{ hostId: 'h2', onMachine: true }]);
    expect(w.forgotten).toEqual(['embedder:h2', 'providers:h2']);
    expect(w.removing.size).toBe(0);
    expect(w.traced).toContain('host.removed');
  });

  it('a runner that does not answer, or reports this machine\'s Docker, is removed here only, and the owner is told what is left', async () => {
    const w = world();
    w.machines.h2!.reachable = false;
    const away = await w.svc.hosts.remove(host(w, 'h2'));
    expect(away).toMatchObject({ ok: true, warning: expect.stringContaining('did not answer') });
    expect(w.machines.h2!.stopped).toEqual([]);
    expect(w.embedRemoved).toEqual([{ hostId: 'h2', onMachine: false }]);

    const same = world();
    same.machines.h2!.daemon = 'daemon-one';
    same.machines.h2!.browsers = [{ name: 'b1', agentContainer: 'hatchabot-here' }];
    const r = await same.svc.hosts.remove(host(same, 'h2'));
    expect(r).toMatchObject({ ok: true, warning: expect.stringContaining('reports the same Docker as "This machine"') });
    expect(same.machines.h2!.stopped).toEqual([]);
  });
});

describe('Install image', () => {
  // A test that fails midway leaves no copy behind for the next one.
  beforeEach(() => { copies.calls.length = 0; copies.opts.length = 0; copies.release = undefined; });
  it('one copy per runner: a second ask while it runs gets the same one; afterwards a new one starts', async () => {
    const w = world();
    expect(w.svc.installs.status('h2')).toEqual({ idle: true });
    const first = w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER);
    const again = w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER);
    expect(again).toBe(first);
    await settle(); await settle();
    expect(copies.calls).toEqual(['ssh://runner@10.0.0.9']);
    expect(w.svc.installs.status('h2')).toMatchObject({ done: false, bytes: 0 });
    copies.release!({ ok: false, error: 'made-up failure' });
    const done = await first.finished;
    expect(done).toMatchObject({ done: true, ok: false, error: 'Image install failed: made-up failure' });
    expect(w.traced).toContain('host.image_copy_failed');
    const next = w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER);
    expect(next).not.toBe(first);
    await settle(); await settle();
    copies.release!({ ok: true });
    expect(await next.finished).toMatchObject({ ok: true });
    copies.calls.length = 0;
    copies.opts.length = 0;
  });

  it('an image that cannot read the data of the runner\'s agents already past it is not installed as its default (HB-1061)', async () => {
    const w = world();
    w.machines.h1!.defaultRuns = '2026.7.1-2';
    agent(w, 'r1', { hostId: 'h2' });                                   // follows the runner's default, on 2026.9
    agent(w, 'r2', { hostId: 'h2' }); w.store.setAgentState('r2', 'STOPPED'); w.store.setAgentState('r2', 'ARCHIVED'); // archived: a restore runs the default
    agent(w, 'r3', { hostId: 'h2', image: 'hatchabot-runtime:2026.9.6' }); // pinned: keeps its own image
    agent(w, 'l1', { hostId: 'h1' });                                   // this machine's: not the runner's default
    w.machines.h2!.runs = { 'mock://r1': '2026.9.6', 'mock://r2': '2026.9.8', 'mock://r3': '2026.9.6' };
    w.machines.h1!.runs = { 'mock://l1': '2026.9.8' };
    const refused = await w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER).finished;
    expect(refused).toMatchObject({ done: true, ok: false });
    expect(refused.error).toBe("This machine's image runs OpenClaw 2026.7.1-2, which cannot read the data of Laptop runner's agents already on 2026.8 or newer (Agent r1, Agent r2). Installed as that runner's default, their next rebuild would fail: make this machine's default 2026.8 or newer first (Settings → Advanced → Runtime images), then install it.");
    expect(copies.calls).toEqual([]);
    expect(w.store.listMachineOperations(['h2'], 5).find((o) => o.kind === 'install-image')).toMatchObject({ status: 'failed', outcome: refused.error });
    // Upward is the normal path: a 2026.9 image goes in over them.
    w.machines.h1!.defaultRuns = '2026.9.8';
    const up = w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER);
    for (let i = 0; i < 50 && !copies.calls.length; i++) await settle();
    expect(copies.calls).toEqual(['ssh://runner@10.0.0.9']);
    expect(copies.opts[0]).toMatchObject({ unpublished: 'No release manifest in this test.' });
    copies.release!({ ok: true });
    expect(await up.finished).toMatchObject({ ok: true });
    copies.calls.length = 0;
    copies.opts.length = 0;
  });

  it('with HATCHABOT_IMAGE pinned to a version tag, a runner agent pinned to that tag is asked too: the copy replaces what it runs (HB-1187)', async () => {
    const had = process.env.HATCHABOT_IMAGE;
    process.env.HATCHABOT_IMAGE = 'hatchabot-runtime:2026.9.4';
    try {
      const w = world({ defaultBase: 'hatchabot-runtime:2026.9.4' });
      w.machines.h1!.defaultRuns = '2026.7.1-2';
      agent(w, 'r1', { hostId: 'h2', image: 'hatchabot-runtime:2026.9.4' });
      w.machines.h2!.runs = { 'mock://r1': '2026.9.6' };
      const refused = await w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER).finished;
      expect(refused).toMatchObject({ done: true, ok: false, error: expect.stringContaining('(Agent r1)') });
      expect(copies.calls).toEqual([]);
    } finally { if (had === undefined) delete process.env.HATCHABOT_IMAGE; else process.env.HATCHABOT_IMAGE = had; }
  });

  it('this machine\'s extra packages go with the image, for a runner on another CPU to build them on (HB-1062)', async () => {
    const w = world();
    w.machines.h1!.tags = [{ tag: BASE, imageId: 'img1', size: '2GB', extraPackages: ['jq', 'ripgrep'] }];
    const copy = w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER);
    await settle(); await settle();
    expect(copies.opts[0]).toMatchObject({ image: BASE, total: 2e9, extraPackages: ['jq', 'ripgrep'] });
    copies.release!({ ok: true, pulled: 'registry.example.org/runtime:2026.9.8' });
    await copy.finished;
    const op = w.store.listMachineOperations(['h2'], 5).find((o) => o.kind === 'install-image')!;
    expect(op.outcome).toBe("Laptop runner pulled the published image registry.example.org/runtime:2026.9.8, with this machine's extra packages (jq, ripgrep) built onto it.");
    copies.calls.length = 0;
    copies.opts.length = 0;
  });

  it('what this machine\'s image was built from goes too, and how the published image differs is said in the record and the job (HB-1189)', async () => {
    const w = world();
    w.machines.h1!.tags = [{ tag: BASE, imageId: 'img1', extraPackages: ['jq'], buildInputs: 'v1;made-up-label' }];
    const copy = w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER);
    await settle(); await settle();
    expect(copies.opts[0]).toMatchObject({ extraPackages: ['jq'], buildInputs: 'v1;made-up-label' });
    copies.release!({ ok: true, pulled: 'registry.example.org/runtime:2026.9.8', differs: "the published image has its own memory search engine, and this machine's image is engine-free" });
    const job = await copy.finished;
    const said = "It is not built quite as this machine's image is: the published image has its own memory search engine, and this machine's image is engine-free. Only extra packages can be built again on a runner of another CPU; agents there run it as it is.";
    expect(job).toMatchObject({ done: true, ok: true, differs: said });
    const op = w.store.listMachineOperations(['h2'], 5).find((o) => o.kind === 'install-image')!;
    expect(op.outcome).toBe(`Laptop runner pulled the published image registry.example.org/runtime:2026.9.8, with this machine's extra packages (jq) built onto it. ${said}`);
    // After a restart the job in memory is gone, and the record says it too (HB-1189 review).
    const restarted = createImageInstalls({ store: w.store, providerFor: () => { throw new Error('nothing is asked'); }, trace: () => () => {} });
    expect(restarted.status('h2')).toMatchObject({ done: true, ok: true, differs: said });
    copies.calls.length = 0;
    copies.opts.length = 0;
  });

  it('a runner is not removed while an image is being installed on it, nor when a copy began while it was asked; once the copy ends it is (HB-1025)', async () => {
    const w = world();
    const copy = w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER);
    await settle(); await settle();
    expect(copies.calls).toEqual(['ssh://runner@10.0.0.9']);
    const busy = 'The runtime image is being installed on this host — wait for Install image to finish (its row shows how far it has come), then remove it.';
    expect(await w.svc.hosts.remove(host(w, 'h2'))).toEqual({ refused: { error: busy } });
    expect(w.store.getHost('h2')).toBeDefined();
    expect(w.removing.size).toBe(0);
    copies.release!({ ok: true });
    await copy.finished;
    // A copy that began while the runner was asked (its probe slow) holds it too.
    let answer!: (v: boolean) => void;
    w.machines.h2!.reachableAnswer = () => new Promise((r) => { answer = r; });
    const going = w.svc.hosts.remove(host(w, 'h2'));
    for (let i = 0; i < 20 && !answer; i++) await settle();
    const late = w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER);
    answer(true);
    expect(await going).toEqual({ refused: { error: busy } });
    expect(w.store.getHost('h2')).toBeDefined();
    expect(w.forgotten).toEqual([]);
    for (let i = 0; i < 50 && copies.calls.length < 2; i++) await settle();
    copies.release!({ ok: true });
    await late.finished;
    w.machines.h2!.reachableAnswer = undefined;
    expect(await w.svc.hosts.remove(host(w, 'h2'))).toEqual({ ok: true });
    expect(w.store.getHost('h2')).toBeUndefined();
    copies.calls.length = 0;
    copies.opts.length = 0;
  });

  it('Install image is refused onto a runner whose removal is under way, and nothing is copied (HB-1025)', async () => {
    const w = world();
    // The routes, over this service: the machine's owner asks.
    const app = Fastify();
    registerMachineRoutes(app, {
      store: w.store, providerFor: () => { throw new Error('unused'); }, ownedAgent: () => undefined, ownsLocalHost: () => true, holdOnce: () => true,
      hostBeingRemoved: (id: string) => w.removing.has(id), machines: w.svc,
    } as never);
    let answer!: (v: boolean) => void;
    w.machines.h2!.reachableAnswer = () => new Promise((r) => { answer = r; });
    const going = w.svc.hosts.remove(host(w, 'h2'));
    for (let i = 0; i < 20 && !answer; i++) await settle();
    const install = await app.inject({ method: 'POST', url: '/v1/hosts/h2/install-image', payload: {} });
    expect(install.statusCode).toBe(409);
    expect(install.json()).toEqual({ error: 'That host is being removed.' });
    answer(true);
    expect(await going).toEqual({ ok: true });
    for (let i = 0; i < 20; i++) await settle();
    expect(copies.calls).toEqual([]);
    expect(w.store.listMachineOperations(['h2'], 5).some((o) => o.kind === 'install-image')).toBe(false);
    await app.close();
  });

  it('a listing that could not be read is not "no extra packages": the copy is told, so another CPU pulls nothing (HB-1062)', async () => {
    const w = world();
    // The listing of this machine's images fails, as a `docker images` that timed out does.
    w.machines.h1!.listFails = true;
    const copy = w.svc.installs.start(host(w, 'h2'), 'ssh://runner@10.0.0.9', OWNER);
    await settle(); await settle();
    expect(copies.opts[0]).toMatchObject({ image: BASE, extraPackages: [], extrasUnread: "this machine's images could not be read" });
    copies.release!({ ok: false, error: 'refused' });
    await copy.finished;
    copies.calls.length = 0;
    copies.opts.length = 0;
  });
});

describe('the resources', () => {
  it('a reading below the cap-hit baseline is a new container counting from zero; one from the same container counts from the baseline', () => {
    const w = world();
    const a = { ...agent(w, 'a1'), memoryCapBaseline: 5 } as Agent;
    expect(w.svc.resources.capHitsSince(a, 8)).toBe(3);
    expect(w.svc.resources.capHitsSince(a, 2)).toBe(2);
    expect(w.svc.resources.capHitsSince(a, undefined)).toBeUndefined();
    expect(w.svc.resources.peakSinceClear(a, 900, 100)).toBe(900);
  });

  it('an agent on a legacy runtime ref is counted under the container its machine names, and Clear keeps its cap hits as they stand (HB-1117)', async () => {
    const w = world();
    agent(w, 'a1', { hostId: 'h1' });
    const legacy = 'docker://0f1e2d3c4b5a69788796a5b4c3d2e1f0';
    w.store.setAgentRuntimeRef('a1', legacy);
    // Docker's rule for such a ref (dockerNames), as the real provider names it.
    expect(dockerNames(legacy).container).toBe('agentclaw-0f1e2d3c4b5a');
    w.machines.h1!.names = { [legacy]: 'agentclaw-0f1e2d3c4b5a' };
    w.machines.h1!.statsAnswer = async () => [{ name: 'agentclaw-0f1e2d3c4b5a', cpuPct: 5, memBytes: 100, memLimitBytes: 1000, pids: 3, memCapHits: 9, startedAt: '2026-11-01T00:00:00Z' }] as never;
    const f = await w.svc.resources.fleet(OWNER, true);
    const here = (f.hosts as Array<{ id: string; containers: Array<Record<string, unknown>>; totals?: { memBytes: number } }>).find((h) => h.id === 'h1')!;
    expect(here.containers).toEqual([expect.objectContaining({ agentId: 'a1', memCapHits: 9 })]);
    expect(here.totals!.memBytes).toBe(100);
    expect(await w.svc.resources.clearPeaksOf([w.store.getAgent('a1')!])).toBe(1);
    expect(w.store.getAgent('a1')!.memoryCapBaseline).toBe(9);
  });

  it('one docker stats sample per machine serves every viewer for three seconds', async () => {
    const w = world();
    await w.svc.resources.fleet(OWNER, true);
    await w.svc.resources.fleet(OWNER, true);
    expect(w.machines.h1!.statsCalls).toBe(1);
    expect(w.machines.h2!.statsCalls).toBe(1);
  });

  it('a slow sample is shared until it answers, then for three seconds from its answer; a failed one is taken again (HB-0880)', async () => {
    const w = world();
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const m = w.machines.h1!;
      let answer!: (rows: never[]) => void;
      m.statsAnswer = () => new Promise((r) => { answer = r; });
      const first = w.svc.resources.fleet(OWNER, true);
      await settle(); await settle();
      expect(m.statsCalls).toBe(1);
      // Docker takes longer than three seconds: the viewers polling meanwhile
      // wait for the same sample, never start another.
      now += 3_001;
      const second = w.svc.resources.fleet(OWNER, true);
      now += 3_001;
      const third = w.svc.resources.fleet(OWNER, true);
      await settle(); await settle();
      expect(m.statsCalls).toBe(1);
      answer([]);
      await Promise.all([first, second, third]);
      // Fresh for three seconds from its answer, not from its start.
      now += 2_000;
      await w.svc.resources.fleet(OWNER, true);
      expect(m.statsCalls).toBe(1);
      now += 1_001;
      m.statsAnswer = () => Promise.reject(new Error('made-up docker failure'));
      const failed = await w.svc.resources.fleet(OWNER, true);
      expect(m.statsCalls).toBe(2);
      expect((failed.hosts as Array<{ id: string; error?: string }>).find((h) => h.id === 'h1')!.error).toBeTruthy();
      // A failure is not kept: the next look takes a new sample.
      m.statsAnswer = undefined;
      await w.svc.resources.fleet(OWNER, true);
      expect(m.statsCalls).toBe(3);
    } finally { clock.mockRestore(); }
  });
});

describe('the images', () => {
  it('a derived build cut off by a restart is failed as the service is built', () => {
    const store = new Store(new Database(':memory:'));
    store.upsertDerivedImage({ name: 'tools', tag: 'hatchabot-runtime:derived-tools', base: BASE, dockerfile: 'RUN true', createdBy: OWNER });
    expect(store.getDerivedImage('tools')!.status).toBe('BUILDING');
    createMachines({
      store, providerFor: () => { throw new Error('unused'); }, trace: () => () => {}, disownPauseOnStop: () => {},
      beginRemoval: () => true, endRemoval: () => {}, embedderOf: () => ({ remove: async () => ({}) }), forgetEmbedder: () => {}, forgetProviders: () => {},
      defaultBase: BASE, dataDir: tmpdir(), notify: async () => {}, log: { info: () => {}, error: () => {} },
    });
    expect(store.getDerivedImage('tools')!.status).toBe('FAILED');
  });

  it('a derived image builds once at a time, and its owner is told how it ended', async () => {
    const w = world();
    w.store.upsertDerivedImage({ name: 'tools', tag: 'hatchabot-runtime:derived-tools', base: BASE, dockerfile: 'RUN true', createdBy: OWNER });
    w.svc.images.kickImageBuild('tools');
    w.svc.images.kickImageBuild('tools');
    expect(w.derived).toHaveLength(1);
    expect(w.svc.images.isBuilding('tools')).toBe(true);
    w.derived[0]!.finish({ ok: true });
    await settle(); await settle();
    expect(w.svc.images.isBuilding('tools')).toBe(false);
    expect(w.store.getDerivedImage('tools')!.status).toBe('READY');
    expect(w.told).toEqual([{ ownerId: OWNER, body: expect.stringContaining('finished building') }]);
  });

  it('the base build runs in the background and says how it ended', async () => {
    const w = world();
    expect(w.svc.images.baseBuildNow()).toEqual({ running: false, candidate: true });
    w.svc.images.startBaseBuild({ version: '2026.9.8', candidate: true, packages: 'jq', forOwner: OWNER });
    expect(w.svc.images.baseBuildNow()).toMatchObject({ running: true, version: '2026.9.8', candidate: true });
    expect(w.base[0]!.opts).toMatchObject({ version: '2026.9.8', candidate: true, packages: 'jq', logPath: expect.stringContaining('_base') });
    w.base[0]!.finish({ ok: false, error: 'made-up failure' });
    await settle();
    expect(w.svc.images.baseBuildNow()).toMatchObject({ running: false, ok: false, error: 'made-up failure' });
    expect(w.told[0]!.body).toContain('base image candidate for OpenClaw 2026.9.8 with jq FAILED to build');
    w.svc.stop();
  });

  it('a default base build is made the default as it ends, only if no follower would be stranded then, and its owner is told which (HB-1187)', async () => {
    const w = world();
    agent(w, 'l1', { hostId: 'h1' });
    w.machines.h1!.runs = { 'mock://l1': '2026.7.1-2' };
    const makeDefault = { hostId: 'h1', tag: 'hatchabot-runtime:2026.7.1-2', latest: BASE, version: '2026.7.1-2' };
    const build = () => w.svc.images.startBaseBuild({ version: '2026.7.1-2', candidate: false, forOwner: OWNER, makeDefault });
    build();
    expect(w.base[0]!.opts).toMatchObject({ candidate: true }); // the script leaves the default alone
    w.machines.h1!.runs = { 'mock://l1': '2026.9.8' };              // l1 moved on while it built
    w.base[0]!.finish({ ok: true });
    for (let i = 0; i < 20 && w.svc.images.baseBuildNow().running; i++) await settle();
    expect(w.svc.images.baseBuildNow()).toMatchObject({ running: false, ok: false, error: expect.stringContaining('(Agent l1)') });
    expect(w.machines.h1!.tagged).toBeUndefined();
    expect(w.told.at(-1)!.body).toBe('The base image default for OpenClaw 2026.7.1-2 finished building, but was not made the default: OpenClaw 2026.7.1-2 cannot read the data of agents that reached 2026.8 or newer while it built (Agent l1). It is kept as hatchabot-runtime:2026.7.1-2: pin those agents to their current image, then promote it.');
    // Docker refusing the tag is said too.
    w.machines.h1!.runs = {};
    w.machines.h1!.tagFails = true;
    build();
    w.base[1]!.finish({ ok: true });
    for (let i = 0; i < 20 && w.svc.images.baseBuildNow().running; i++) await settle();
    expect(w.svc.images.baseBuildNow().error).toBe('Built, but not made the default: docker could not tag it as hatchabot-runtime:latest (No such image). It is kept as hatchabot-runtime:2026.7.1-2.');
    w.machines.h1!.tagFails = false;
    build();
    w.base[2]!.finish({ ok: true });
    for (let i = 0; i < 20 && w.svc.images.baseBuildNow().running; i++) await settle();
    expect(w.svc.images.baseBuildNow()).toMatchObject({ running: false, ok: true });
    expect(w.machines.h1!.tagged).toEqual([['hatchabot-runtime:2026.7.1-2', BASE]]);
    expect(w.told.at(-1)!.body).toBe("The base image default for OpenClaw 2026.7.1-2 finished building and is now the fleet default. Nothing restarts by itself: agents on this machine without a pin move onto it when they are rebuilt; agents on runners keep their runner's image.");
    // A candidate is never made the default.
    w.svc.images.startBaseBuild({ version: '2026.7.1-2', candidate: true, forOwner: OWNER, makeDefault });
    w.base[3]!.finish({ ok: true });
    for (let i = 0; i < 20 && w.svc.images.baseBuildNow().running; i++) await settle();
    expect(w.machines.h1!.tagged).toHaveLength(1);
    expect(w.told.at(-1)!.body).toBe('The base image candidate for OpenClaw 2026.7.1-2 finished building. Nothing changes for any agent until it is tried on one and promoted.');
    // Its tag or OpenClaw unknown here (no makeDefault), the script makes it the default itself: said so, not "until it is promoted" (review, L3).
    w.svc.images.startBaseBuild({ version: '2026.7.1-2', candidate: false, forOwner: OWNER });
    expect(w.base[4]!.opts).toMatchObject({ candidate: false });
    w.base[4]!.finish({ ok: true });
    for (let i = 0; i < 20 && w.svc.images.baseBuildNow().running; i++) await settle();
    expect(w.told.at(-1)!.body).toBe("The base image default for OpenClaw 2026.7.1-2 finished building and is now the fleet default. Nothing restarts by itself: agents on this machine without a pin move onto it when they are rebuilt; agents on runners keep their runner's image.");
    w.svc.stop();
  });

  it('with HATCHABOT_IMAGE pinned to a version tag, a default build moves :latest, as the script does, never the pin; the agents that run :latest are the ones asked (HB-1187)', async () => {
    const pin = 'hatchabot-runtime:2026.9.4';
    const w = world({ defaultBase: pin });
    agent(w, 'p1', { hostId: 'h1', image: pin });  // pinned to the tag HATCHABOT_IMAGE names, on 2026.9 data
    agent(w, 'u1', { hostId: 'h1' });              // unpinned: runs the pin too
    w.machines.h1!.runs = { 'mock://p1': '2026.9.6', 'mock://u1': '2026.9.6' };
    const makeDefault = { hostId: 'h1', tag: 'hatchabot-runtime:2026.7.1-2', latest: BASE, version: '2026.7.1-2' };
    const finish = async () => { w.base.at(-1)!.finish({ ok: true }); for (let i = 0; i < 20 && w.svc.images.baseBuildNow().running; i++) await settle(); };
    w.svc.images.startBaseBuild({ version: '2026.7.1-2', candidate: false, forOwner: OWNER, makeDefault });
    await finish();
    expect(w.machines.h1!.tagged).toEqual([['hatchabot-runtime:2026.7.1-2', BASE]]);
    expect(w.svc.images.baseBuildNow()).toMatchObject({ ok: true });
    // Not "default": the default is the pin (HB-1256).
    expect(w.told.at(-1)!.body).toBe(`The base image for OpenClaw 2026.7.1-2 finished building and is now ${BASE}. The fleet default stays ${pin}, as HATCHABOT_IMAGE pins it: only agents pinned to ${BASE} move onto it when they are rebuilt.`);
    // One pinned to :latest runs what moves: it is asked, and told of as one pinned to :latest, with no Promote (it would retag the pin).
    agent(w, 'l1', { hostId: 'h1', image: BASE });
    w.machines.h1!.runs = { ...w.machines.h1!.runs, 'mock://l1': '2026.9.8' };
    w.svc.images.startBaseBuild({ version: '2026.7.1-2', candidate: false, forOwner: OWNER, makeDefault });
    await finish();
    const stranded = `OpenClaw 2026.7.1-2 cannot read the data of agents pinned to ${BASE} that reached 2026.8 or newer while it built (Agent l1). It is kept as hatchabot-runtime:2026.7.1-2: pin those agents to a version tag, then build it again to move ${BASE}.`;
    expect(w.svc.images.baseBuildNow()).toMatchObject({ ok: false, error: `Built, but ${BASE} was not moved to it: ${stranded}` });
    expect(w.told.at(-1)!.body).toBe(`The base image for OpenClaw 2026.7.1-2 finished building, but ${BASE} was not moved to it: ${stranded}`);
    expect(w.machines.h1!.tagged).toHaveLength(1);
    // An image with no memory search engine while the shared service is off: the same tag named, no Promote.
    w.machines.h1!.imageEngine = 'none';
    w.searchOn = false;
    w.svc.images.startBaseBuild({ version: '2026.7.1-2', candidate: false, engine: 'none', forOwner: OWNER, makeDefault: { ...makeDefault, tag: 'hatchabot-runtime:2026.7.1-2-lite' } });
    await finish();
    expect(w.svc.images.baseBuildNow().error).toBe(`Built, but ${BASE} was not moved to it: it has no memory search engine of its own and the shared service is off, so no agent could be built on it. It is kept as hatchabot-runtime:2026.7.1-2-lite: turn the service on (Settings → Hosts), then build it again to move ${BASE}.`);
    // Review (L3): a candidate under the pin cannot be promoted, and the words say what makes it the default.
    w.machines.h1!.imageEngine = undefined;
    w.svc.images.startBaseBuild({ version: '2026.9.9', candidate: true, forOwner: OWNER });
    await finish();
    expect(w.told.at(-1)!.body).toBe(`The base image candidate for OpenClaw 2026.9.9 finished building. Nothing changes for any agent until it is tried on one. Promote is off while HATCHABOT_IMAGE pins the fleet default to ${pin}: to make it the default, set HATCHABOT_IMAGE in .env to its tag and restart Hatchabot.`);
    // A build that is no candidate, its tag unknown here (no makeDefault): the script moves :latest itself, and the words say so.
    w.svc.images.startBaseBuild({ version: '2026.9.9', candidate: false, forOwner: OWNER });
    await finish();
    expect(w.base.at(-1)!.opts).toMatchObject({ candidate: false });
    expect(w.told.at(-1)!.body).toBe(`The base image for OpenClaw 2026.9.9 finished building and is now ${BASE}. The fleet default stays ${pin}, as HATCHABOT_IMAGE pins it: only agents pinned to ${BASE} move onto it when they are rebuilt.`);
    expect(w.machines.h1!.tagged).toHaveLength(1);
    w.svc.stop();
  });

  it('a default build of an image with no memory search engine is not made the default while the shared service is off, as Promote holds it (HB-1187)', async () => {
    const w = world();
    w.machines.h1!.imageEngine = 'none';
    w.searchOn = false;
    const makeDefault = { hostId: 'h1', tag: 'hatchabot-runtime:2026.7.1-2-lite', latest: BASE, version: '2026.7.1-2' };
    w.svc.images.startBaseBuild({ version: '2026.7.1-2', candidate: false, engine: 'none', forOwner: OWNER, makeDefault });
    w.base[0]!.finish({ ok: true });
    for (let i = 0; i < 20 && w.svc.images.baseBuildNow().running; i++) await settle();
    expect(w.svc.images.baseBuildNow().error).toBe('Built, but not made the default: it has no memory search engine of its own and the shared service is off, so no agent could be built on it. It is kept as hatchabot-runtime:2026.7.1-2-lite: turn the service on (Settings → Hosts), then promote it.');
    expect(w.machines.h1!.tagged).toBeUndefined();
    // With the service on, it is.
    w.searchOn = true;
    w.svc.images.startBaseBuild({ version: '2026.7.1-2', candidate: false, engine: 'none', forOwner: OWNER, makeDefault });
    w.base[1]!.finish({ ok: true });
    for (let i = 0; i < 20 && w.svc.images.baseBuildNow().running; i++) await settle();
    expect(w.machines.h1!.tagged).toEqual([['hatchabot-runtime:2026.7.1-2-lite', BASE]]);
    w.svc.stop();
  });

  it('npm is asked once an hour', async () => {
    const w = world();
    await w.svc.images.distTags();
    expect((await w.svc.images.distTags()).latest).toBe('2026.9.8');
    expect(w.distReads).toBe(1);
  });

  it('viewers asking while npm is slow share its one read, fresh for an hour from its answer; a failed read is asked again (HB-0905)', async () => {
    const w = world();
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let answer!: (tags: Record<string, string>) => void;
      w.distAnswer = () => new Promise((r) => { answer = r; });
      const asks = Array.from({ length: 8 }, () => w.svc.images.distTags());
      for (let i = 0; i < 20 && !answer; i++) await settle();
      expect(w.distReads).toBe(1);
      now += 3_600_000; // npm took an hour to answer
      answer({ latest: '2026.9.8' });
      for (const t of await Promise.all(asks)) expect(t.latest).toBe('2026.9.8');
      w.distAnswer = undefined;
      now += 3_600_000;
      await w.svc.images.distTags();
      expect(w.distReads).toBe(1);
      now += 1;
      w.distAnswer = () => Promise.reject(new Error('made-up npm failure'));
      await expect(w.svc.images.distTags()).rejects.toThrow('made-up npm failure');
      w.distAnswer = undefined;
      expect((await w.svc.images.distTags()).latest).toBe('2026.9.8');
      expect(w.distReads).toBe(3);
    } finally { clock.mockRestore(); }
  });

  it('an npm read that came back empty (a timeout, a refusal) is kept five minutes, not the hour (HB-0905)', async () => {
    const w = world();
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      w.distAnswer = async () => ({});
      expect((await w.svc.images.distTags()).latest).toBeUndefined();
      now += 4 * 60_000;
      await w.svc.images.distTags();
      expect(w.distReads).toBe(1);
      now += 60_001;
      w.distAnswer = undefined;
      expect((await w.svc.images.distTags()).latest).toBe('2026.9.8');
      expect(w.distReads).toBe(2);
      now += 59 * 60_000;
      await w.svc.images.distTags();
      expect(w.distReads).toBe(2);
    } finally { clock.mockRestore(); }
  });

  it('what stops a tag being deleted: a pin, a class, a derived image on it, and a container only on the image\'s last tag', () => {
    const w = world();
    const tag = 'hatchabot-runtime:2026.9.8';
    agent(w, 'a1', { image: tag });
    agent(w, 'a2', { ownerId: MEMBER, image: tag, hostId: 'h2' });
    w.store.upsertAgentClass({ id: 'c1', ownerId: OWNER, name: 'Helpers', image: tag });
    w.store.upsertDerivedImage({ name: 'tools', tag: 'hatchabot-runtime:derived-tools', base: tag, dockerfile: 'RUN true', createdBy: OWNER });
    agent(w, 'a3');
    const local = host(w, 'h1');
    const inUse = { tags: [{ tag, imageId: 'img1' }], containers: [{ name: 'a3', imageId: 'img1', state: 'running' }, { name: 'a1', imageId: 'img1', state: 'running' }, { name: 'stray', imageId: 'img1', state: 'exited' }] };
    const b = w.svc.images.imageBlockers(tag, OWNER, local, inUse);
    expect(b.map((x) => [x.kind, x.name, x.mine])).toEqual([
      ['pin', 'Agent a1', true], ['pin', 'Agent a2', false], ['class', 'Helpers', true], ['derived', 'tools', true],
      ['container', 'Agent a3', true], ['container', 'stray', true],
    ]);
    expect(b[1]!.label).toBe('pinned, on Laptop runner, another account');
    // Another tag on the same image: Docker takes the name only, so no container holds it.
    const twoTags = { ...inUse, tags: [...inUse.tags, { tag: 'hatchabot-runtime:other', imageId: 'img1' }] };
    expect(w.svc.images.imageBlockers(tag, OWNER, local, twoTags).some((x) => x.kind === 'container')).toBe(false);
    // The name a build of it left is not another tag: Delete removes that too, so the containers still hold it (HB-1032).
    const leftover = { ...inUse, tags: [...inUse.tags, { tag: 'hatchabot-runtime-check:2026.9.8', imageId: 'img1' }] };
    expect(w.svc.images.imageBlockers(tag, OWNER, local, leftover).filter((x) => x.kind === 'container').map((x) => x.name)).toEqual(['Agent a3', 'stray']);
    expect(w.svc.images.imageBlockers('hatchabot-runtime:unused', OWNER, local, null)).toEqual([]);
    expect(blockedMessage(tag, b.slice(2, 3))).toBe(`${tag} is still in use. Helpers (class): Change the class's image.`);
  });

  it('extra packages are apt names, eight at most', () => {
    expect(cleanPackages(undefined)).toEqual({ ok: true });
    expect(cleanPackages('jq, ripgrep  JQ')).toEqual({ ok: true, value: 'jq ripgrep jq' });
    expect(cleanPackages(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])).toMatchObject({ ok: false });
    expect(cleanPackages('jq; rm -rf /')).toEqual({ ok: false, error: '"jq;" is not a package name.' });
  });

  it('an extra package ending in "-" is refused: apt reads it as "remove" (HB-0972)', () => {
    for (const p of ['curl-', 'jq git-', ['git-']]) {
      expect(cleanPackages(p), String(p)).toMatchObject({ ok: false, error: expect.stringContaining('tells apt to remove it') });
    }
    // A "+" at the end, or a "-" inside, is part of real names.
    expect(cleanPackages('g++ libstdc++6 build-essential')).toEqual({ ok: true, value: 'g++ libstdc++6 build-essential' });
    expect(cleanPackages('x'.repeat(64))).toMatchObject({ ok: true });
    expect(cleanPackages('x'.repeat(65))).toMatchObject({ ok: false });
  });
});
