import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Adding/removing data sources (Slice A: folders, ro/rw). Host-folder mounts are
 * the machine owner's privilege and pass the sharePathProblem blocklist.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'ds-')); tmps.push(d); return d; };
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

async function world(hostOwner = OWNER) {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: hostOwner, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, secrets, f };
}

const addSource = (f: any, body: unknown) =>
  f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources', headers: as, payload: body });

describe('POST /v1/agents/:id/data-sources', () => {
  it('adds a read-only folder and reflects it in dataSources + summary', async () => {
    const { store, f } = await world();
    const dir = tmp();
    const res = await addSource(f, { kind: 'folder', access: 'ro', path: dir });
    expect(res.statusCode).toBe(200);
    const sources = store.listDataSources('a1');
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ kind: 'folder', access: 'ro', hostPath: dir });
    expect(res.json().dataSummary).toMatch(/reads 1 folder/);
  });

  it('adds a writable folder (readonly false in the source, "writable" in the summary)', async () => {
    const { store, f } = await world();
    const res = await addSource(f, { kind: 'folder', access: 'rw', path: tmp() });
    expect(res.statusCode).toBe(200);
    expect(store.listDataSources('a1')[0]!.access).toBe('rw');
    expect(res.json().dataSummary).toMatch(/1 writable folder/);
  });

  it('refuses a blocklisted path', async () => {
    const { store, f } = await world();
    const res = await addSource(f, { kind: 'folder', access: 'ro', path: '/etc' });
    expect(res.statusCode).toBe(400);
    expect(store.listDataSources('a1')).toHaveLength(0);
  });

  it('refuses a non-existent path', async () => {
    const { f } = await world();
    const res = await addSource(f, { kind: 'folder', access: 'ro', path: '/no/such/dir/here' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/No such folder/);
  });

  it('refuses a second source at the same /data/<name>', async () => {
    const { f } = await world();
    const a = mkdtempSync(join(tmpdir(), 'dup-')); tmps.push(a);
    await addSource(f, { kind: 'folder', access: 'ro', path: a });
    // A different dir whose basename collides would map to the same mount.
    const res = await addSource(f, { kind: 'folder', access: 'ro', path: a });
    expect(res.statusCode).toBe(409);
  });

  it('atHostPath: stores mount-at-host-path and keeps distinct paths that share a basename', async () => {
    const { store, f } = await world();
    const p1 = tmp(); mkdirSync(join(p1, 'docs'));
    const p2 = tmp(); mkdirSync(join(p2, 'docs'));
    // Same basename "docs" — would clash at /data/docs, but host-path mounts key
    // off the full path, so both are accepted.
    expect((await addSource(f, { kind: 'folder', access: 'ro', path: join(p1, 'docs'), atHostPath: true })).statusCode).toBe(200);
    expect((await addSource(f, { kind: 'folder', access: 'ro', path: join(p2, 'docs'), atHostPath: true })).statusCode).toBe(200);
    const sources = store.listDataSources('a1');
    expect(sources).toHaveLength(2);
    expect(sources.every((s) => s.mountAtHostPath === true)).toBe(true);
    expect(sources[0]!.hostPath).toBe(join(p1, 'docs'));
  });

  it('atHostPath: refuses sharing the exact same path twice', async () => {
    const { f } = await world();
    const dir = tmp();
    expect((await addSource(f, { kind: 'folder', access: 'ro', path: dir, atHostPath: true })).statusCode).toBe(200);
    const res = await addSource(f, { kind: 'folder', access: 'ro', path: dir, atHostPath: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already shared/i);
  });

  it('rejects git for now (Slice B)', async () => {
    const { f } = await world();
    const res = await addSource(f, { kind: 'git', access: 'ro', path: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('is gated to the machine owner (403 when a non-owner owns the local host)', async () => {
    const { f } = await world('someone-else');
    const res = await addSource(f, { kind: 'folder', access: 'rw', path: tmp() });
    expect(res.statusCode).toBe(403);
  });
});

describe('git data sources (Slice B)', () => {
  it('creates a git source with a generated deploy key and no host access needed', async () => {
    const { store, secrets, f } = await world('someone-else'); // NOT the machine owner
    const res = await addSource(f, { kind: 'git', access: 'rw', repoUrl: 'https://github.com/cksci/defs' });
    expect(res.statusCode).toBe(200); // git needs no local-host ownership
    const sources = store.listDataSources('a1');
    expect(sources[0]).toMatchObject({ kind: 'git', access: 'rw', mountName: 'defs', repoUrl: 'git@github.com:cksci/defs.git' });
    // Public key is surfaced; private key is stored in the SecretStore.
    const inList = res.json().dataSources.find((d: any) => d.kind === 'git');
    expect(inList.pubKey).toMatch(/^ssh-ed25519 /);
    expect(secrets.map.has(sources[0]!.secretRef!)).toBe(true);
    expect(res.json().dataSummary).toMatch(/1 git repo/);
  });

  it('rejects an unrecognizable repo url', async () => {
    const { f } = await world();
    const res = await addSource(f, { kind: 'git', access: 'ro', repoUrl: 'not a repo' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a repo host that starts with a dash (argv-injection shape)', async () => {
    const { store, f } = await world();
    const res = await addSource(f, { kind: 'git', access: 'ro', repoUrl: 'git@-oProxyCommand.evil:owner/repo.git' });
    expect(res.statusCode).toBe(400);
    expect(store.listDataSources('a1')).toHaveLength(0);
  });

  it('rejects a repo whose name collides with an OpenClaw internal dir', async () => {
    const { store, f } = await world();
    const res = await addSource(f, { kind: 'git', access: 'ro', repoUrl: 'git@github.com:cksci/agents.git' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/reserved/);
    expect(store.listDataSources('a1')).toHaveLength(0);
  });

  it('deleting a git source scrubs its private key', async () => {
    const { store, secrets, f } = await world();
    const added = (await addSource(f, { kind: 'git', access: 'ro', repoUrl: 'git@github.com:cksci/defs.git' })).json();
    const ref = store.listDataSources('a1')[0]!.secretRef!;
    expect(secrets.map.has(ref)).toBe(true);
    const id = added.dataSources[0].id;
    await f.inject({ method: 'DELETE', url: `/v1/agents/a1/data-sources/${id}`, headers: as });
    expect(store.listDataSources('a1')).toHaveLength(0);
    expect(secrets.map.has(ref)).toBe(false); // portable secret gone
  });
});

describe('legacy sharedPaths vs data sources', () => {
  it('PATCH sharedPaths refuses a folder that would shadow an existing data source', async () => {
    const { f } = await world();
    const dir = tmp();
    await addSource(f, { kind: 'folder', access: 'ro', path: dir });
    // Same dir → same /data/<basename> as the data source above: a silent
    // double-mount, which the route must now reject.
    const res = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { sharedPaths: [dir] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already lives at \/data\//);
  });
});

describe('DELETE /v1/agents/:id/data-sources/:dsId', () => {
  it('removes a source', async () => {
    const { store, f } = await world();
    const added = (await addSource(f, { kind: 'folder', access: 'ro', path: tmp() })).json();
    const id = added.dataSources[0].id;
    const res = await f.inject({ method: 'DELETE', url: `/v1/agents/a1/data-sources/${id}`, headers: as });
    expect(res.statusCode).toBe(200);
    expect(store.listDataSources('a1')).toHaveLength(0);
  });

  it('404s an unknown id', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'DELETE', url: '/v1/agents/a1/data-sources/nope', headers: as });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /v1/agents/:id/data-sources/:dsId (change access)', () => {
  const patch = (f: any, id: string, body: unknown, owner = OWNER) =>
    f.inject({ method: 'PATCH', url: `/v1/agents/a1/data-sources/${id}`, headers: { 'x-hatchabot-owner': owner }, payload: body });

  it('flips a folder read-only → writable and back, without re-adding it', async () => {
    const { store, f } = await world();
    const added = (await addSource(f, { kind: 'folder', access: 'ro', path: tmp() })).json();
    const id = added.dataSources[0].id;

    expect((await patch(f, id, { access: 'rw' })).statusCode).toBe(200);
    expect(store.getDataSource('a1', id)!.access).toBe('rw');
    // ...and back, so it's a real toggle, not a one-way upgrade.
    expect((await patch(f, id, { access: 'ro' })).statusCode).toBe(200);
    expect(store.getDataSource('a1', id)!.access).toBe('ro');
  });

  it('flips a git source, keeping its clone and deploy key intact', async () => {
    const { store, secrets, f } = await world();
    const added = (await addSource(f, { kind: 'git', access: 'ro', repoUrl: 'git@github.com:me/notes.git' })).json();
    const src = added.dataSources[0];
    const keyBefore = await secrets.get(store.getDataSource('a1', src.id)!.secretRef!);

    expect((await patch(f, src.id, { access: 'rw' })).statusCode).toBe(200);
    const after = store.getDataSource('a1', src.id)!;
    expect(after.access).toBe('rw');
    // The whole point of PATCH over remove+re-add: same repo row, same key, so
    // nothing has to be re-pasted on GitHub and nothing is re-cloned.
    expect(after.mountName).toBe(src.mountName);
    expect(after.pubKey).toBe(src.pubKey);
    expect(await secrets.get(after.secretRef!)).toBe(keyBefore);
  });

  it('only the machine owner may grant write to a HOST FOLDER', async () => {
    // Agent owner is not the machine owner here.
    const { store, f } = await world('someone-else');
    store.insertDataSource({
      id: 'ds1', agentId: 'a1', kind: 'folder', access: 'ro', mountName: 'notes',
      hostPath: '/home/me/notes', createdAt: 'now',
    });
    expect((await patch(f, 'ds1', { access: 'rw' })).statusCode).toBe(403);
    expect(store.getDataSource('a1', 'ds1')!.access).toBe('ro');
    // Going back to read-only is always allowed — it only ever removes access.
    store.setDataSourceAccess('a1', 'ds1', 'rw');
    expect((await patch(f, 'ds1', { access: 'ro' })).statusCode).toBe(200);
  });

  it('rejects a bad access value, an unknown id, and another owner', async () => {
    const { f } = await world();
    const added = (await addSource(f, { kind: 'folder', access: 'ro', path: tmp() })).json();
    const id = added.dataSources[0].id;
    expect((await patch(f, id, { access: 'sideways' })).statusCode).toBe(400);
    expect((await patch(f, 'nope', { access: 'rw' })).statusCode).toBe(404);
    expect((await patch(f, id, { access: 'rw' }, 'other-user')).statusCode).toBe(404);
  });
});
