import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { createMemorySearch, type MemorySearch } from '../src/orchestrator/memorySearch/memorySearch.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import type { Agent } from '../src/domain/types.js';

/**
 * The memory search service (HB-0808 step 13), driven as
 * src/api/machine/embedderRoutes.ts drives it but with no HTTP server: a real store
 * on an in-memory database, a data folder of its own, and a provider that
 * answers the image reads the test sets. No container is started.
 */
const OWNER = 'user-owner', OTHER = 'user-other';
const ENV_KEYS = ['HATCHABOT_ENV_FILE', 'HATCHABOT_EMBED_DEFAULT', 'HATCHABOT_EMBED_URL'] as const;
let saved: Record<string, string | undefined> = {};
let dir = '';
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'hb-memsearch-'));
});
afterEach(() => {
  for (const w of made.splice(0)) w.ms.stop();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const id of ['a1', 'a2', 'a3']) clearBusy(id);
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

interface World {
  store: Store; ms: MemorySearch; kicked: string[]; images: Record<string, string | undefined>; imageReads: number; inFlight: Set<string>; last: Record<string, string>; agent(id: string, o?: Partial<Agent>): Agent;
  /** The images read, in the order the reads began; while `held` is set, each read waits for it. */
  imagesRead: string[]; held?: Promise<void>;
}
const made: World[] = [];

function world(): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertHost({ id: 'r1', ownerId: OWNER, kind: 'cloud', provider: 'mock', name: 'runner', settings: {}, createdAt: 'now' });
  store.insertHost({ id: 'r2', ownerId: OTHER, kind: 'cloud', provider: 'mock', name: 'theirs', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = { store, kicked: [], images: {}, imageReads: 0, imagesRead: [], inFlight: new Set<string>(), last: {} } as unknown as World;
  const provider = {
    currentImageInfo: async (image?: string) => {
      w.imageReads++; w.imagesRead.push(image ?? 'default');
      if (w.held) await w.held;
      return { embedEngine: w.images[image ?? 'default'] };
    },
  };
  w.ms = createMemorySearch({
    store, secrets: {} as never, providerFor: () => provider as never, trace: () => () => {},
    dataDir: dir, defaultBase: 'runtime:test',
    switchPendingFor: (a) => (a.embedMode ?? 'baked') !== (a.appliedEmbedMode ?? 'baked'),
    isInFlight: (id) => w.inFlight.has(id),
    lastActiveFor: async (a) => w.last[a.id],
    kickRebuild: (id) => { w.kicked.push(id); return true; },
    warn: () => {},
  });
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `docker://hatchabot-${id}`, ...o,
    } as unknown as Agent);
    return store.getAgent(id)!;
  };
  made.push(w);
  return w;
}
/** Turns this machine's service on, as Start leaves it (its "enabled" file), with no container. */
const turnOn = () => { mkdirSync(join(dir, 'embed'), { recursive: true }); writeFileSync(join(dir, 'embed', 'enabled'), ''); };

describe('the machines', () => {
  it('this machine is the local service; a runner gets its own once, and forget drops it', () => {
    const w = world();
    expect(w.ms.serviceFor(undefined)).toBe(w.ms.local);
    expect(w.ms.serviceFor('h1')).toBe(w.ms.local);
    expect(w.ms.madeFor('r1')).toBeUndefined();
    const r = w.ms.serviceFor('r1');
    expect(r.hostId).toBe('r1');
    expect(w.ms.serviceFor('r1')).toBe(r);
    expect(w.ms.madeFor('r1')).toBe(r);
    w.ms.forget('r1');
    expect(w.ms.madeFor('r1')).toBeUndefined();
    expect(w.ms.serviceFor('r1')).not.toBe(r);
  });

  it("`at` answers this machine with whether the caller owns it, an account's runner, and no one else's", () => {
    const w = world();
    const mine = { ownerId: () => OWNER, ownsLocal: () => true };
    expect(w.ms.at(undefined, mine)).toEqual({ svc: w.ms.local, owns: true });
    expect(w.ms.at('h1', { ownerId: () => OTHER, ownsLocal: () => false })).toEqual({ svc: w.ms.local, owns: false });
    expect(w.ms.at('r1', mine)).toEqual({ svc: w.ms.serviceFor('r1'), owns: true });
    expect(w.ms.at('r2', mine)).toBeUndefined();
    expect(w.ms.at('nowhere', mine)).toBeUndefined();
  });
});

describe("the fleet's engine", () => {
  it('counts the local, live, non-manager agents, and the switches owed', () => {
    const w = world();
    w.agent('a1'); w.store.setAgentEmbedMode('a1', 'shared'); w.store.setAgentEmbedApplied('a1', 'shared');
    w.agent('a2'); w.store.setAgentEmbedMode('a2', 'shared');
    w.agent('a3', { state: 'ARCHIVED' } as Partial<Agent>);
    expect(w.ms.fleetView()).toEqual({ default: 'baked', total: 2, shared: 2, pending: 1 });
  });

  it('refuses the shared default while the service is off, and writes it once on', async () => {
    const w = world();
    process.env.HATCHABOT_ENV_FILE = join(dir, '.env');
    expect(await w.ms.setDefault('baked')).toEqual({ ok: false, status: 409, error: `No .env at ${join(dir, '.env')}` });
    writeFileSync(join(dir, '.env'), 'HATCHABOT_PORT=8080\n');
    expect(await w.ms.setDefault('shared')).toEqual({ ok: false, status: 400, error: 'Turn the memory search service on first (Settings → Hosts).' });
    turnOn();
    const r = await w.ms.setDefault('shared');
    expect(r.ok && r.body.default).toBe('shared');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toMatch(/^HATCHABOT_EMBED_DEFAULT=shared$/m);
  });

  it('move-all marks every local agent, rebuilds only the idle running ones now, and leaves the rest to the quiet hours', async () => {
    const w = world();
    turnOn();
    w.agent('a1');
    w.agent('a2'); markBusy('a2');
    w.agent('a3'); w.last.a3 = new Date().toISOString();
    const r = await w.ms.moveAll('shared', 'now');
    expect(r).toMatchObject({ ok: true, body: { switched: 3, queued: 1, deferred: 2, engineFree: 0 } });
    expect(w.kicked).toEqual(['a1']);
    expect(['a1', 'a2', 'a3'].map((id) => w.store.getAgent(id)!.embedMode)).toEqual(['shared', 'shared', 'shared']);
    const quiet = await w.ms.moveAll('shared', 'quiet');
    expect(quiet).toMatchObject({ ok: true, body: { switched: 0, queued: 0 } });
  });

  it('back to their own engine skips the engine-free images, which would only be switched back', async () => {
    const w = world();
    for (const [id, image] of [['a1', 'free'], ['a2', 'full']] as const) { w.agent(id); w.store.setAgentEmbedMode(id, 'shared'); w.store.setAgentImage(id, image); }
    w.images = { free: 'none', full: 'baked' };
    const r = await w.ms.moveAll('baked', 'quiet');
    expect(r).toMatchObject({ ok: true, body: { switched: 1, engineFree: 1, queued: 0 } });
    expect(w.store.getAgent('a1')!.embedMode).toBe('shared');
    expect(w.store.getAgent('a2')!.embedMode ?? 'baked').toBe('baked'); // baked is stored as the default
    expect(await w.ms.moveAll('shared', 'now')).toEqual({ ok: false, status: 400, error: 'Turn the memory search service on first (Settings → Hosts).' });
  });

  it('back to their own engine reads each image once, the different ones at the same time (HB-0947)', async () => {
    const w = world();
    // Twelve agents on the default image, two on an engine-free one, one on an image with an engine.
    const ids = [...Array.from({ length: 12 }, (_, i) => `d${i}`), 'f1', 'f2', 'e1'];
    for (const id of ids) { w.agent(id); w.store.setAgentEmbedMode(id, 'shared'); }
    for (const id of ['f1', 'f2']) w.store.setAgentImage(id, 'free');
    w.store.setAgentImage('e1', 'full');
    w.images = { default: 'baked', free: 'none', full: 'baked' };
    let open!: () => void;
    w.held = new Promise<void>((r) => { open = r; });
    const moving = w.ms.moveAll('baked', 'quiet');
    await new Promise((r) => setImmediate(r));
    // All three asked before any answered, and each once.
    expect([...w.imagesRead].sort()).toEqual(['default', 'free', 'full']);
    open();
    expect(await moving).toMatchObject({ ok: true, body: { switched: 13, engineFree: 2, queued: 0 } });
    expect(w.imageReads).toBe(3);
    expect(ids.filter((id) => (w.store.getAgent(id)!.embedMode ?? 'baked') === 'baked')).toEqual(ids.filter((id) => !id.startsWith('f')));
    expect(w.store.getAgent('f1')!.embedMode).toBe('shared');
  });
});

describe('provisioning and the timers', () => {
  it("refuses a key from a service that is off, unless it is the machine owner's own agent on an untouched one", async () => {
    const w = world();
    w.store.insertAgent({ id: 'b1', ownerId: OTHER, name: 'B', slug: 'b1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as unknown as Agent);
    await expect(w.ms.forProvision.credentialsFor('b1')).rejects.toThrow('the memory search service is not turned on (Settings → Hosts)');
    mkdirSync(join(dir, 'embed'), { recursive: true }); writeFileSync(join(dir, 'embed', 'stopped'), '');
    w.agent('a1');
    await expect(w.ms.forProvision.credentialsFor('a1')).rejects.toThrow("the memory search service was stopped by the machine's owner (Settings → Hosts)");
  });

  it('an external server is handed over as configured, with no container', async () => {
    const w = world();
    w.agent('a1');
    process.env.HATCHABOT_EMBED_URL = 'http://embed.example.test:11434/v1/';
    const c = await w.ms.forProvision.credentialsFor('a1');
    expect(c.baseUrl).toBe('http://embed.example.test:11434/v1');
  });

  it('stop() ends the boot start and the health loop before they run', async () => {
    vi.useFakeTimers();
    const w = world();
    w.ms.startTimers();
    w.ms.stop();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(w.imageReads).toBe(0);
  });

  it('the boot start looks at the image when its time comes', async () => {
    vi.useFakeTimers();
    const w = world();
    w.ms.startTimers();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(w.imageReads).toBe(1);
  });
});
