import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/providers/mockProvider.js';
import { LocalDockerProvider } from '../src/providers/localDockerProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { EmbedderService, embedKeyHash, sha256File, EMBED_MODEL_FILE, EMBEDDER_KEY_REF } from '../src/embedder/embedder.js';

/**
 * Each runner runs its own memory search service (2.147). Before, the one
 * service was on the main machine, out of a runner's reach: runner agents
 * stayed on images with their own engine, and from OpenClaw 2026.8 (no
 * engine to bake) no current agent could be built on a runner at all.
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
  store.insertHost({ id: 'local', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: '1' } as never);
  store.insertHost({ id: 'runner1', ownerId: OWNER, kind: 'cloud', provider: 'mock', name: 'laptop', settings: {}, createdAt: '2' } as never);
  for (const [id, hostId] of [['a-home', 'local'], ['a-away', 'runner1']]) {
    store.insertAgent({ id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p', hostId, persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'hb-embed-runner-'));
  mkdirSync(join(dataDir, 'models'), { recursive: true });
  writeFileSync(join(dataDir, 'models', EMBED_MODEL_FILE), 'model');
  const secrets = new MemSecrets();
  const local = new MockProvider();
  const runner = new MockProvider();
  const make = (hostId: string | undefined, provider: MockProvider, sha: string) => new EmbedderService({
    provider: () => provider, hostId, localHostId: () => 'local', secrets, store, dataDir, runtimeImage: 'hatchabot-runtime:latest',
    doorScript: 'noop', doorBind: async () => (hostId ? '127.0.0.1' : '172.17.0.1'), modelSha256: sha,
  });
  return { store, secrets, dataDir, local, runner, make };
}

describe('a runner\'s own memory search service', () => {
  it('keeps its own state, holds only its own agents\' keys, and has its own server key', async () => {
    const w = world();
    const sha = await sha256File(join(w.dataDir, 'models', EMBED_MODEL_FILE));
    const home = w.make(undefined, w.local, sha);
    const away = w.make('runner1', w.runner, sha);
    expect(away.dir).toBe(join(w.dataDir, 'embed-hosts', 'runner1'));
    expect(home.dir).toBe(join(w.dataDir, 'embed'));
    // A key from before keys named a machine (null) is this machine's.
    w.store.setEmbedToken('a-home', embedKeyHash('k-home'));
    w.store.setEmbedToken('a-away', embedKeyHash('k-away'), 'runner1');
    await home.start();
    await away.start();
    expect(JSON.parse(readFileSync(home.keysFile, 'utf8'))).toEqual({ [embedKeyHash('k-home')]: 'a-home' });
    expect(JSON.parse(readFileSync(away.keysFile, 'utf8'))).toEqual({ [embedKeyHash('k-away')]: 'a-away' });
    expect(w.secrets.map.get(EMBEDDER_KEY_REF)).toBeTruthy();
    expect(w.secrets.map.get(`${EMBEDDER_KEY_REF}/runner1`)).toBeTruthy();
    expect(w.secrets.map.get(EMBEDDER_KEY_REF)).not.toBe(w.secrets.map.get(`${EMBEDDER_KEY_REF}/runner1`));
    // The runner's spec carries the model's checksum, so its copy is compared without hashing again.
    expect(w.runner.embedderSpecs[0]!.modelSha256).toBe(sha);
  });

  it('copies its keys file to the runner when keys change, once per change, and the build can wait for it', async () => {
    const w = world();
    const sha = await sha256File(join(w.dataDir, 'models', EMBED_MODEL_FILE));
    const away = w.make('runner1', w.runner, sha);
    await away.start();
    const before = w.runner.pushedKeys.length;
    w.store.setEmbedToken('a-away', embedKeyHash('k1'), 'runner1');
    await away.syncKeysNow();
    expect(w.runner.pushedKeys.length).toBe(before + 1);
    expect(JSON.parse(w.runner.pushedKeys.at(-1)!)).toEqual({ [embedKeyHash('k1')]: 'a-away' });
    await away.syncKeysNow(); // nothing changed: no copy
    expect(w.runner.pushedKeys.length).toBe(before + 1);
  });

  it('ignores an external server and the bind override (both this machine\'s), and an asleep runner is not "fell over"', async () => {
    process.env.HATCHABOT_EMBED_URL = 'http://elsewhere.example.org/v1';
    process.env.HATCHABOT_EMBED_BIND = '10.0.0.9';
    try {
      const w = world();
      const sha = await sha256File(join(w.dataDir, 'models', EMBED_MODEL_FILE));
      const away = w.make('runner1', w.runner, sha);
      expect(away.external).toBeUndefined();
      await away.start();
      expect(w.runner.embedderSpecs[0]!.doorBind).toBe('127.0.0.1');
      w.runner.awake = false;
      w.runner.embedder = { embedder: 'absent', door: 'absent' };
      expect(await away.healthTick()).toBe('unreachable');
      expect(w.runner.embedderSpecs.length).toBe(1);
    } finally {
      delete process.env.HATCHABOT_EMBED_URL;
      delete process.env.HATCHABOT_EMBED_BIND;
    }
  });
});

describe('what a build on a runner is handed', () => {
  afterEach(() => { delete process.env.HATCHABOT_DB; });
  async function app() {
    process.env.HATCHABOT_DB = join(mkdtempSync(join(tmpdir(), 'hb-embed-runner-app-')), 'hatchabot.sqlite');
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'local', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: '1' } as never);
    store.insertHost({ id: 'runner1', ownerId: OWNER, kind: 'cloud', provider: 'mock', name: 'laptop', settings: {}, createdAt: '2' } as never);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'a1', slug: 'a1', state: 'RUNNING', aiProfileId: 'p', hostId: 'local', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
    const provider = new MockProvider();
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } } as never);
    const adapter = (f as unknown as { embedderForProvision: { credentialsFor(id: string, host?: string): Promise<{ baseUrl: string; token: string }> } }).embedderForProvision;
    const embedderFor = (f as unknown as { embedderFor: (h: string | undefined) => EmbedderService }).embedderFor;
    // Both services as already on (start itself is covered above).
    const on = (svc: EmbedderService, door: string) => {
      Object.defineProperty(svc, 'enabled', { value: true });
      svc.status = async () => ({ embedder: 'running', door: 'running', doorAddress: door, enabled: true, modelPresent: true });
      svc.syncKeys = () => {};
    };
    on(embedderFor(undefined), '172.17.0.1:8093');
    on(embedderFor('runner1'), '127.0.0.1:8093');
    return { f, store, adapter, embedderFor };
  }

  it('a key for the runner\'s own door; a move re-checks the index on the new machine; the old machine\'s door forgets it', async () => {
    const w = await app();
    const home = await w.adapter.credentialsFor('a1', 'local');
    expect(home.baseUrl).toBe('http://172.17.0.1:8093/v1');
    expect(w.store.embedTokenHost('a1')).toBe('local');
    w.store.setAgentEmbedIndex('a1', '2026-10-07T00:00:00Z', null);
    // A rebuild on the same machine keeps the confirmation.
    await w.adapter.credentialsFor('a1', 'local');
    expect(w.store.getAgent('a1')!.embedIndexedAt).toBe('2026-10-07T00:00:00Z');
    // Built for the runner (a move): its Docker Desktop door is reached as host.docker.internal.
    let forgot = 0;
    w.embedderFor(undefined).syncKeys = () => { forgot++; };
    const away = await w.adapter.credentialsFor('a1', 'runner1');
    expect(away.baseUrl).toBe('http://host.docker.internal:8093/v1');
    expect(w.store.embedTokenHost('a1')).toBe('runner1');
    expect(w.store.getAgent('a1')!.embedIndexedAt).toBeFalsy();
    expect(forgot).toBe(1);
  });

  it('an external server (this machine\'s setting) is for this machine\'s agents only; a runner\'s agent gets the runner\'s door', async () => {
    process.env.HATCHABOT_EMBED_URL = 'http://embed.example.org:11434/v1';
    try {
      const w = await app();
      expect((await w.adapter.credentialsFor('a1', 'local')).baseUrl).toBe('http://embed.example.org:11434/v1');
      // Before 2026-10-09 the external check came before the machine was known: this was the URL above.
      expect((await w.adapter.credentialsFor('a1', 'runner1')).baseUrl).toBe('http://host.docker.internal:8093/v1');
      expect(w.store.embedTokenHost('a1')).toBe('runner1');
    } finally {
      delete process.env.HATCHABOT_EMBED_URL;
    }
  });

  it('Settings → Hosts reads and drives each machine\'s service; another account\'s runner is not found', async () => {
    const w = await app();
    const as = { 'x-hatchabot-owner': OWNER };
    const r = await w.f.inject({ method: 'GET', url: '/v1/embedder?host=runner1', headers: as });
    expect(r.statusCode).toBe(200);
    expect(r.json().doorAddress).toBe('127.0.0.1:8093');
    expect((await w.f.inject({ method: 'GET', url: '/v1/embedder?host=nope', headers: as })).statusCode).toBe(404);
    // Another account sees no such machine, and cannot drive it.
    expect((await w.f.inject({ method: 'GET', url: '/v1/embedder?host=runner1', headers: { 'x-hatchabot-owner': 'member' } })).statusCode).toBe(404);
    let stopped = 0;
    w.embedderFor('runner1').stop = async () => { stopped++; return { embedder: 'absent', door: 'absent', enabled: false, modelPresent: true }; };
    expect((await w.f.inject({ method: 'POST', url: '/v1/embedder/stop', headers: { 'x-hatchabot-owner': 'member' }, payload: { host: 'runner1' } })).statusCode).toBe(404);
    expect(stopped).toBe(0);
    expect((await w.f.inject({ method: 'POST', url: '/v1/embedder/stop', headers: as, payload: { host: 'runner1' } })).statusCode).toBe(200);
    expect(stopped).toBe(1);
  });
});

describe('the containers on a runner (docker -H)', () => {
  function remoteStub() {
    const dir = mkdtempSync(join(tmpdir(), 'hb-embed-remote-'));
    const log = join(dir, 'argv.log');
    const stub = join(dir, 'docker');
    writeFileSync(stub, `#!/usr/bin/env bash
cat > /dev/null &
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
d=${JSON.stringify(dir)}
shift 2   # -H <host>
case "$*" in
  "info --format {{.NCPU}}") echo 8 ;;
  "image inspect "*) echo sha256:abc ;;
  "network inspect "*) exit 0 ;;
  "run --rm --network none --user 0 -v "*"sha256sum"*) echo "0000  /v/model" ;;
  "inspect --format {{.State.Running}} hatchabot-embedder") [ -f "$d/embedder" ] && echo true || exit 1 ;;
  "inspect --format {{.State.Running}} hatchabot-embed-door") [ -f "$d/door" ] && echo true || exit 1 ;;
  "run -d --name hatchabot-embedder "*) touch "$d/embedder"; echo embedderid ;;
  "run -d --name hatchabot-embed-door "*) touch "$d/door"; echo doorid ;;
  "port "*) echo "8093/tcp -> 127.0.0.1:8093" ;;
esac
exit 0
`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    let fetched = 0;
    const provider = new LocalDockerProvider({
      docker: stub, host: 'ssh://laptop.example.org', image: 'test-image:latest', reachProbe: async () => true,
      fetchImpl: (async () => { fetched++; return new Response('{}', { status: 200 }); }) as typeof fetch,
    });
    return { provider, dir, fetched: () => fetched, argv: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []) };
  }

  it('copies the model and key files into volumes there, mounts the volumes, and asks the door\'s health from inside it', async () => {
    const { provider, dir, argv, fetched } = remoteStub();
    for (const f of ['server-key', 'keys.json', 'model.gguf']) writeFileSync(join(dir, f), f);
    const s = await provider.ensureEmbedder({
      image: 'test-image:latest', modelPath: join(dir, 'model.gguf'), modelAlias: 'embeddinggemma', key: 'k',
      doorImage: 'test-image:latest', doorScript: 'noop', doorPort: 8093, doorBind: '127.0.0.1',
      keysFile: join(dir, 'keys.json'), serverKeyFile: join(dir, 'server-key'), uid: 1000, gid: 1000, perMin: 600, modelSha256: 'ffff',
    });
    expect(s.doorAddress).toBe('127.0.0.1:8093');
    const lines = argv().map((l) => l.replace(/^-H \S+ /, ''));
    const copies = lines.filter((l) => l.startsWith('run --rm -i --network none --user 0 -v '));
    // The model (its checksum differed) and both key files.
    expect(copies.some((l) => l.includes('hatchabot-embed-model:/v') && l.includes('/v/model.gguf'))).toBe(true);
    expect(copies.filter((l) => l.includes('hatchabot-embed-keys:/v')).length).toBe(2);
    expect(copies.every((l) => /chown \d+:\d+ /.test(l))).toBe(true);
    const engine = lines.find((l) => l.startsWith('run -d --name hatchabot-embedder '))!;
    expect(engine).toContain('-v hatchabot-embed-model:/models:ro');
    expect(engine).toContain('-v hatchabot-embed-keys:/keys:ro');
    expect(engine).not.toContain(dir); // nothing from this machine's disk
    expect(engine).toContain('-t 8');
    const door = lines.find((l) => l.startsWith('run -d --name hatchabot-embed-door '))!;
    expect(door).toContain('-v hatchabot-embed-keys:/keys:ro');
    expect(door).toContain('-p 127.0.0.1:8093:8093');
    expect(lines.some((l) => l.startsWith('exec hatchabot-embed-door node -e '))).toBe(true);
    expect(fetched()).toBe(0);
  });
});

describe('removing a runner (2026-10-09)', () => {
  afterEach(() => { delete process.env.HATCHABOT_DB; });
  async function app() {
    const dbDir = mkdtempSync(join(tmpdir(), 'hb-embed-runner-rm-'));
    process.env.HATCHABOT_DB = join(dbDir, 'hatchabot.sqlite');
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'local', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: '1' } as never);
    store.insertHost({ id: 'runner1', ownerId: OWNER, kind: 'cloud', provider: 'mock-runner', name: 'laptop', settings: {}, createdAt: '2' } as never);
    const home = new MockProvider();
    const provider = new MockProvider();
    const secrets = new MemSecrets();
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', home], ['mock-runner', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } } as never);
    const embedderFor = (f as unknown as { embedderFor: (h: string | undefined) => EmbedderService }).embedderFor;
    const svc = embedderFor('runner1');
    mkdirSync(svc.dir, { recursive: true });
    writeFileSync(svc.keysFile, '{}');
    await secrets.put(`${EMBEDDER_KEY_REF}/runner1`, 'made-up-engine-key');
    provider.browsers.set('hatchabot-left-behind', true);
    return { f, store, home, provider, secrets, svc, embedderFor };
  }
  it('takes its memory search service and browsers with it, there and here', async () => {
    const w = await app();
    const r = await w.f.inject({ method: 'DELETE', url: '/v1/hosts/runner1', headers: { 'x-hatchabot-owner': OWNER } });
    expect(r.statusCode).toBe(200);
    expect(r.json().warning).toBeUndefined();
    expect(w.store.getHost('runner1')).toBeUndefined();
    expect(w.provider.embedderRemoved).toBe(true);
    expect(w.provider.browsers.size).toBe(0);
    expect(w.secrets.map.has(`${EMBEDDER_KEY_REF}/runner1`)).toBe(false);
    expect(existsSync(w.svc.dir)).toBe(false);
    expect(w.embedderFor('runner1')).not.toBe(w.svc); // the old service object is forgotten
  });
  it('a runner row that is this machine\'s own Docker: nothing there is touched (it is this machine\'s service)', async () => {
    const w = await app();
    w.provider.daemonId = w.home.daemonId.bind(w.home);
    const r = await w.f.inject({ method: 'DELETE', url: '/v1/hosts/runner1', headers: { 'x-hatchabot-owner': OWNER } });
    expect(r.statusCode).toBe(200);
    expect(w.provider.embedderRemoved).toBe(false);
    expect(w.provider.browsers.size).toBe(1);
    expect(w.store.getHost('runner1')).toBeUndefined();
  });
  it('a runner that does not answer: removed here, and the owner is told what is left on it', async () => {
    const w = await app();
    w.provider.awake = false;
    const r = await w.f.inject({ method: 'DELETE', url: '/v1/hosts/runner1', headers: { 'x-hatchabot-owner': OWNER } });
    expect(r.statusCode).toBe(200);
    expect(r.json().warning).toMatch(/did not answer/);
    expect(w.provider.embedderRemoved).toBe(false);
    expect(w.secrets.map.has(`${EMBEDDER_KEY_REF}/runner1`)).toBe(false);
    expect(existsSync(w.svc.dir)).toBe(false);
  });
});

describe('a file copied into a volume on a runner (2026-10-09)', () => {
  /** A docker whose `run … sh -c <script>` runs the script here, with /v a temp folder; `cut` sends only the first bytes. */
  function volumeStub(cut?: number) {
    const dir = mkdtempSync(join(tmpdir(), 'hb-embed-vol-'));
    mkdirSync(join(dir, 'v'));
    const stub = join(dir, 'docker');
    writeFileSync(stub, `#!/usr/bin/env bash
script="\${@: -1}"
script="\${script//\\/v\\//${dir}/v/}"
${cut ? `head -c ${cut} | sh -c "$script"` : 'sh -c "$script"'}
`, { mode: 0o755 });
    chmodSync(stub, 0o755);
    const provider = new LocalDockerProvider({ docker: stub, host: 'ssh://laptop.example.org', image: 'test-image:latest', reachProbe: async () => true });
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'keys.json'), JSON.stringify({ abc: 'agent-one', def: 'agent-two' }));
    writeFileSync(join(src, 'server-key'), 'made-up-server-key\n');
    const files = {
      keysFile: join(src, 'keys.json'), serverKeyFile: join(src, 'server-key'), doorImage: 'test-image:latest',
      uid: process.getuid!(), gid: process.getgid!(),
    };
    return { provider, files, volume: join(dir, 'v') };
  }
  it('lands whole', async () => {
    const { provider, files, volume } = volumeStub();
    await provider.pushEmbedKeys(files);
    expect(readFileSync(join(volume, 'keys.json'), 'utf8')).toBe(readFileSync(files.keysFile, 'utf8'));
  });
  it('a copy cut short is not renamed into place, and its part is removed', async () => {
    const { provider, files, volume } = volumeStub(5);
    writeFileSync(join(volume, 'server-key'), 'the-copy-before\n');
    await expect(provider.pushEmbedKeys(files)).rejects.toThrow(/Could not copy|copy server-key/);
    expect(readFileSync(join(volume, 'server-key'), 'utf8')).toBe('the-copy-before\n');
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(volume).filter((f) => f.endsWith('.part'))).toEqual([]);
  });
});

describe('moving onto a runner across the 2026.8 line', async () => {
  const { moveCrossesDown } = await import('../src/openclaw/configWriter.js');
  it('refuses only the way down (2026.7 cannot read a migrated volume); up is the normal path', () => {
    expect(moveCrossesDown('2026.9.8', '2026.7.1-2')).toBe(true);
    // Inverted before 2026-10-07: this refused, and the line above passed.
    expect(moveCrossesDown('2026.7.1-2', '2026.9.8')).toBe(false);
    expect(moveCrossesDown('2026.9.6', '2026.9.8')).toBe(false);
    expect(moveCrossesDown(undefined, '2026.7.1')).toBe(false);
  });
});
