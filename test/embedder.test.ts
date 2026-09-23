import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { EmbedderService, embedKeyHash, fileMode, sha256File, EMBED_MODEL_FILE } from '../src/embedder/embedder.js';

/**
 * The machine's embedding service: model file, keys file, start/stop, and
 * the health loop that brings an enabled service back.
 */

const OWNER = 'o';
class MemSecrets {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  const provider = new MockProvider();
  const secrets = new MemSecrets();
  const dataDir = mkdtempSync(join(tmpdir(), 'hb-embed-'));
  const events: Array<[string, Record<string, unknown>]> = [];
  const svc = new EmbedderService({
    provider: () => provider, secrets, store, dataDir, runtimeImage: 'hatchabot-runtime:latest',
    doorScript: 'noop', doorBind: async () => '172.17.0.1', log: (e, d) => events.push([e, d]),
    modelSha256: 'set-below',
  });
  return { store, provider, secrets, dataDir, svc, events };
}

/** A stand-in model file and the checksum the service must demand. */
async function withModel(w: ReturnType<typeof world>, where: 'data' | 'image') {
  const content = 'copied-model';
  if (where === 'data') {
    mkdirSync(join(w.dataDir, 'models'), { recursive: true });
    writeFileSync(join(w.dataDir, 'models', EMBED_MODEL_FILE), content);
  } else {
    w.provider.copyFromImageWorks = true;
  }
  const tmp = join(w.dataDir, 'ref');
  writeFileSync(tmp, content);
  (w.svc as unknown as { '#o': unknown }); // (private) — pass the checksum through a fresh service instead
  return sha256File(tmp);
}

describe('the embedding service', () => {
  afterEach(() => { delete process.env.HATCHABOT_EMBED_URL; });

  it('starts: model out of the runtime image, a keys file only this user can read, both containers up', async () => {
    const w = world();
    const sha = await withModel(w, 'image');
    const svc = new EmbedderService({
      provider: () => w.provider, secrets: w.secrets, store: w.store, dataDir: w.dataDir, runtimeImage: 'hatchabot-runtime:latest',
      doorScript: 'noop', doorBind: async () => '172.17.0.1', log: (e, d) => w.events.push([e, d]), modelSha256: sha,
    });
    expect((await svc.status())).toMatchObject({ enabled: false, embedder: 'absent', modelPresent: false });
    const v = await svc.start();
    expect(v).toMatchObject({ enabled: true, embedder: 'running', door: 'running', doorAddress: '172.17.0.1:8093', modelPresent: true });
    expect(w.events.map((e) => e[0])).toContain('embedder.model_copied');
    expect(fileMode(svc.keysFile)).toBe(0o600);
    expect(JSON.parse(readFileSync(svc.keysFile, 'utf8'))).toEqual({});
    const spec = w.provider.embedderSpecs[0]!;
    expect(spec.key).toBe(await w.secrets.get('embedder/key')); // the server's key, kept as a secret
    expect(spec.modelPath).toBe(join(w.dataDir, 'models', EMBED_MODEL_FILE));
    expect(spec.doorBind).toBe('172.17.0.1');
    // A second start reuses everything: same key, no second copy.
    await svc.start();
    expect(w.provider.embedderSpecs[1]!.key).toBe(spec.key);
    expect(w.events.filter((e) => e[0] === 'embedder.model_copied')).toHaveLength(1);
  });

  it('the keys file carries only live agents, and stop turns it off', async () => {
    const w = world();
    const sha = await withModel(w, 'data');
    const svc = new EmbedderService({
      provider: () => w.provider, secrets: w.secrets, store: w.store, dataDir: w.dataDir, runtimeImage: 'x:1',
      doorScript: 'noop', doorBind: async () => '127.0.0.1', modelSha256: sha,
    });
    const agent = (id: string, state: string) => w.store.insertAgent({
      id, ownerId: OWNER, name: id, slug: id, state, aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now',
    } as never);
    agent('live', 'RUNNING'); agent('parked', 'STOPPED'); agent('building', 'REBUILDING'); agent('gone', 'ARCHIVED');
    for (const id of ['live', 'parked', 'building', 'gone']) w.store.setEmbedToken(id, embedKeyHash(`${id}-key`));
    await svc.start();
    // A stopped agent keeps its key (it will be started without a rebuild); an archived one does not.
    expect(JSON.parse(readFileSync(svc.keysFile, 'utf8'))).toEqual({
      [embedKeyHash('live-key')]: 'live',
      [embedKeyHash('parked-key')]: 'parked',
      [embedKeyHash('building-key')]: 'building',
    });
    // A rebuild's new key joins the old one until the build is accepted.
    w.store.setEmbedToken('live', embedKeyHash('live-key-2'));
    svc.syncKeys();
    let keys = JSON.parse(readFileSync(svc.keysFile, 'utf8'));
    expect(keys[embedKeyHash('live-key')]).toBe('live');
    expect(keys[embedKeyHash('live-key-2')]).toBe('live');
    w.store.commitEmbedToken('live');
    svc.syncKeys();
    keys = JSON.parse(readFileSync(svc.keysFile, 'utf8'));
    expect(keys[embedKeyHash('live-key')]).toBeUndefined();
    expect(keys[embedKeyHash('live-key-2')]).toBe('live');
    expect(fileMode(svc.serverKeyFile)).toBe(0o600);
    expect(w.provider.embedderSpecs.at(-1)!.serverKeyFile).toBe(svc.serverKeyFile);
    w.store.deleteEmbedToken('live');
    svc.syncKeys();
    expect(Object.values(JSON.parse(readFileSync(svc.keysFile, 'utf8'))).sort()).toEqual(['building', 'parked']);
    const off = await svc.stop();
    expect(off).toMatchObject({ enabled: false, embedder: 'absent', door: 'absent' });
    expect(existsSync(svc.enabledFile)).toBe(false);
  });

  it('the health loop brings an enabled service back, and leaves a stopped one alone', async () => {
    const w = world();
    const sha = await withModel(w, 'data');
    const svc = new EmbedderService({
      provider: () => w.provider, secrets: w.secrets, store: w.store, dataDir: w.dataDir, runtimeImage: 'x:1',
      doorScript: 'noop', doorBind: async () => '127.0.0.1', modelSha256: sha, log: (e, d) => w.events.push([e, d]),
    });
    expect(await svc.healthTick()).toBe('off');
    await svc.start();
    expect(await svc.healthTick()).toBe('ok');
    w.provider.embedder = { embedder: 'stopped', door: 'running' }; // fell over
    expect(await svc.healthTick()).toBe('restarted');
    expect(w.provider.embedder.embedder).toBe('running');
    expect(w.events.some((e) => e[0] === 'embedder.unhealthy')).toBe(true);
    await svc.stop();
    w.provider.embedder = { embedder: 'stopped', door: 'stopped' };
    expect(await svc.healthTick()).toBe('off');
    expect(w.provider.embedder.embedder).toBe('stopped');
  });

  it('a model file that fails its checksum is replaced, never used', async () => {
    const w = world();
    mkdirSync(join(w.dataDir, 'models'), { recursive: true });
    writeFileSync(join(w.dataDir, 'models', EMBED_MODEL_FILE), 'corrupt');
    w.provider.copyFromImageWorks = true; // the image's copy is good
    const ref = join(w.dataDir, 'ref'); writeFileSync(ref, 'copied-model');
    const svc = new EmbedderService({
      provider: () => w.provider, secrets: w.secrets, store: w.store, dataDir: w.dataDir, runtimeImage: 'x:1',
      doorScript: 'noop', doorBind: async () => '127.0.0.1', modelSha256: await sha256File(ref),
    });
    await svc.ensureModel();
    expect(readFileSync(join(w.dataDir, 'models', EMBED_MODEL_FILE), 'utf8')).toBe('copied-model');
  });

  it('with an external server configured, there is nothing to start', async () => {
    const w = world();
    process.env.HATCHABOT_EMBED_URL = 'http://ollama.local:11434/v1';
    await expect(w.svc.start()).rejects.toThrow(/external/);
    expect((await w.svc.status()).external).toBe('http://ollama.local:11434/v1');
  });
});

describe('what provisioning is handed', () => {
  afterEach(() => { delete process.env.HATCHABOT_EMBED_URL; delete process.env.HATCHABOT_EMBED_KEY; delete process.env.HATCHABOT_EMBED_MODEL; });
  async function app() {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'a1', slug: 'a1', state: 'RUNNING', aiProfileId: 'p', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const provider = new MockProvider();
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } } as never);
    const adapter = (f as unknown as { embedderForProvision: { credentialsFor(id: string): Promise<{ baseUrl: string; token: string; model: string }> } }).embedderForProvision;
    const svc = (f as unknown as { embedder: EmbedderService }).embedder;
    return { store, provider, adapter, svc };
  }

  it('an external server: its address, key and model as given, nothing started, no key minted', async () => {
    process.env.HATCHABOT_EMBED_URL = 'http://ollama.lan:11434/v1/';
    process.env.HATCHABOT_EMBED_KEY = 'ollama-key';
    process.env.HATCHABOT_EMBED_MODEL = 'nomic-embed-text';
    const w = await app();
    expect(await w.adapter.credentialsFor('a1')).toEqual({ baseUrl: 'http://ollama.lan:11434/v1', token: 'ollama-key', model: 'nomic-embed-text' });
    expect(w.provider.embedder.embedder).toBe('absent');
    expect(w.store.listEmbedTokens()).toEqual([]);
  });

  it('the machine\'s own service, already on: a key minted and written for the door; loopback becomes host.docker.internal', async () => {
    const w = await app();
    Object.defineProperty(w.svc, 'enabled', { value: true });
    w.svc.status = async () => ({ embedder: 'running', door: 'running', doorAddress: '127.0.0.1:8093', enabled: true, modelPresent: true });
    w.svc.syncKeys = () => { mkdirSync(w.svc.dir, { recursive: true }); writeFileSync(w.svc.keysFile, JSON.stringify(Object.fromEntries(w.store.listEmbedTokens().map((t) => [t.tokenHash, t.agentId])))); };
    const creds = await w.adapter.credentialsFor('a1');
    expect(creds.baseUrl).toBe('http://host.docker.internal:8093/v1');
    expect(creds.model).toBe('embeddinggemma');
    expect(w.store.listEmbedTokens().map((t) => t.agentId)).toEqual(['a1']);
    expect(JSON.parse(readFileSync(w.svc.keysFile, 'utf8'))).toEqual({ [embedKeyHash(creds.token)]: 'a1' });
  });

  it('the service off: nothing is started on an agent owner\'s behalf — the agent is built on its own engine', async () => {
    const w = await app();
    await expect(w.adapter.credentialsFor('a1')).rejects.toThrow(/turned on/);
    expect(w.provider.embedder.embedder).toBe('absent');
    expect(w.store.listEmbedTokens()).toEqual([]);
  });
});

describe('over the API', () => {
  it('anyone signed in sees the status; only the machine owner starts or stops it', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { kind: 'telegram', pool: { owns: () => false } },
    } as never);
    const st = await f.inject({ method: 'GET', url: '/v1/embedder', headers: { 'x-hatchabot-owner': 'member' } });
    expect(st.json()).toMatchObject({ enabled: false, embedder: 'absent', door: 'absent' });
    expect((await f.inject({ method: 'POST', url: '/v1/embedder/start', headers: { 'x-hatchabot-owner': 'member' }, payload: {} })).statusCode).toBe(403);
  });
});
