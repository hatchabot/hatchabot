import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

// Runtime tab (v1.2.0): fleet image inventory, promote, base build, classes
// carrying an image, and the 🧪 trial flag.

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}
const OWNER = 'user-owner';
const as = { 'x-hatchabot-owner': OWNER };

async function world(buildBase?: (o: { version?: string; candidate: boolean; logPath: string; engine?: 'none' }) => Promise<{ ok: boolean; error?: string }>) {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  provider.tags = [
    { tag: 'hatchabot-runtime:latest', imageId: 'img-A' },
    { tag: 'hatchabot-runtime:2026.7.1-2', imageId: 'img-A' },
    { tag: 'hatchabot-runtime:2026.9.4', imageId: 'img-B' },
    { tag: 'hatchabot-runtime:derived-pdf', imageId: 'img-C' },
  ];
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  for (const [id, name] of [['a1', 'Kitchen'], ['a2', 'Garage']] as const) {
    const { runtimeRef } = await provider.provision({ agentId: id, slug: name.toLowerCase(), workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} });
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: OWNER, name, slug: name.toLowerCase(), state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
    store.setAgentRuntimeRef(id, runtimeRef); store.setAgentState(id, 'RUNNING');
  }
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any, ...(buildBase ? { buildBase } : {}) });
  return { store, provider, f };
}

describe('GET /v1/runtime/images', () => {
  it('lists every tag with the default first, marks which share its image id, and who follows it', async () => {
    const { f, store } = await world();
    store.setAgentImage('a2', 'hatchabot-runtime:2026.9.4');
    const r = (await f.inject({ method: 'GET', url: '/v1/runtime/images', headers: as })).json();
    expect(r.default).toBe('hatchabot-runtime:latest');
    expect(r.latestImageId).toBe('img-A');
    expect(r.tags[0].tag).toBe('hatchabot-runtime:latest'); expect(r.tags[0].isDefault).toBe(true);
    expect(r.defaultInfo.resolvesTo).toEqual(['hatchabot-runtime:2026.7.1-2']);
    expect(r.tags.slice(1).map((t: any) => t.tag).sort()).toEqual(['hatchabot-runtime:2026.7.1-2', 'hatchabot-runtime:2026.9.4', 'hatchabot-runtime:derived-pdf']);
    expect(r.tags.find((t: any) => t.tag === 'hatchabot-runtime:2026.7.1-2').isLatest).toBe(true);
    const cand = r.tags.find((t: any) => t.tag === 'hatchabot-runtime:2026.9.4');
    expect(cand.isLatest).toBe(false);
    expect(cand.pinned.map((a: any) => a.name)).toEqual(['Garage']);
    expect(r.unpinned.map((a: any) => a.name)).toEqual(['Kitchen']);
  });
  it('shows a pin to a tag that is not built, flagged exists:false', async () => {
    const { f, store } = await world();
    store.setAgentImage('a1', 'hatchabot-runtime:typo');
    const r = (await f.inject({ method: 'GET', url: '/v1/runtime/images', headers: as })).json();
    expect(r.tags.find((t: any) => t.tag === 'hatchabot-runtime:typo').exists).toBe(false);
  });
  it('is host-owner only', async () => {
    const { f } = await world();
    expect((await f.inject({ method: 'GET', url: '/v1/runtime/images', headers: { 'x-hatchabot-owner': 'user-other' } })).statusCode).toBe(403);
  });
});

describe('POST /v1/runtime/images/promote', () => {
  it('retags a built candidate as the default and names the followers', async () => {
    const { f, provider, store } = await world();
    store.setAgentImage('a2', 'hatchabot-runtime:2026.9.4'); // pinned: not a follower
    const res = await f.inject({ method: 'POST', url: '/v1/runtime/images/promote', headers: as, payload: { tag: 'hatchabot-runtime:2026.9.4' } });
    expect(res.statusCode).toBe(200);
    expect(provider.tagged).toEqual([['hatchabot-runtime:2026.9.4', 'hatchabot-runtime:latest']]);
    expect(res.json().followers.map((a: any) => a.name)).toEqual(['Kitchen']);
  });
  it('refuses the default itself, derived images, unknown tags and bad refs', async () => {
    const { f } = await world();
    const post = (tag: string) => f.inject({ method: 'POST', url: '/v1/runtime/images/promote', headers: as, payload: { tag } });
    expect((await post('hatchabot-runtime:latest')).statusCode).toBe(400);
    expect((await post('hatchabot-runtime:derived-pdf')).statusCode).toBe(400);
    expect((await post('hatchabot-runtime:nope')).statusCode).toBe(404);
    expect((await post('--privileged')).statusCode).toBe(400);
  });
});

describe('runtime guards (audit 15)', () => {
  it('history/delete only touch the runtime repo; build refuses latest/derived versions', async () => {
    const { f } = await world();
    expect((await f.inject({ method: 'DELETE', url: '/v1/runtime/images/' + encodeURIComponent('postgres:16'), headers: as })).statusCode).toBe(400);
    expect((await f.inject({ method: 'GET', url: '/v1/runtime/images/' + encodeURIComponent('postgres:16') + '/history', headers: as })).statusCode).toBe(400);
    expect((await f.inject({ method: 'POST', url: '/v1/runtime/build', headers: as, payload: { version: 'latest', candidate: true } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'POST', url: '/v1/runtime/build', headers: as, payload: { version: 'derived-x' } })).statusCode).toBe(400);
  });
});

describe('image history + delete', () => {
  it('shows build steps and removes a tag only when nothing depends on it', async () => {
    const { f, provider, store } = await world();
    const hist = await f.inject({ method: 'GET', url: '/v1/runtime/images/' + encodeURIComponent('hatchabot-runtime:2026.9.4') + '/history', headers: as });
    expect(hist.json().steps[0].step).toMatch(/openclaw/);
    const del = (tag: string) => f.inject({ method: 'DELETE', url: '/v1/runtime/images/' + encodeURIComponent(tag), headers: as });
    expect((await del('hatchabot-runtime:latest')).statusCode).toBe(400);
    // A derived image that still has its row is deleted from THERE (that path
    // also forgets its Dockerfile); one whose row is gone is a leftover this
    // route must take — see 'deleting a derived image tag' below.
    store.upsertDerivedImage({ name: 'pdf', tag: 'hatchabot-runtime:derived-pdf', base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: OWNER });
    expect((await del('hatchabot-runtime:derived-pdf')).statusCode).toBe(400);
    store.deleteDerivedImage('pdf');
    store.setAgentImage('a2', 'hatchabot-runtime:2026.9.4');
    expect((await del('hatchabot-runtime:2026.9.4')).statusCode).toBe(409); // pinned
    store.setAgentImage('a2', null);
    expect((await del('hatchabot-runtime:2026.9.4')).statusCode).toBe(200);
    expect(provider.removed).toEqual(['hatchabot-runtime:2026.9.4']);
    expect((await del('hatchabot-runtime:2026.9.4')).statusCode).toBe(200); // mock rmi is idempotent; real docker would 409
  });
});

describe('POST /v1/runtime/build', () => {
  it('runs the base build through the hook, reports progress and refuses a second concurrent build', async () => {
    let release!: (r: { ok: boolean }) => void;
    const { f } = await world(() => new Promise((r) => { release = r; }));
    const start = await f.inject({ method: 'POST', url: '/v1/runtime/build', headers: as, payload: { version: '2026.7.9', candidate: true } });
    expect(start.statusCode).toBe(202);
    expect((await f.inject({ method: 'POST', url: '/v1/runtime/build', headers: as, payload: {} })).statusCode).toBe(409);
    expect((await f.inject({ method: 'GET', url: '/v1/runtime/build', headers: as })).json().running).toBe(true);
    release({ ok: true }); await new Promise((r) => setTimeout(r, 10));
    const done = (await f.inject({ method: 'GET', url: '/v1/runtime/build', headers: as })).json();
    expect(done.running).toBe(false); expect(done.ok).toBe(true); expect(done.version).toBe('2026.7.9');
    expect((await f.inject({ method: 'POST', url: '/v1/runtime/build', headers: as, payload: { version: 'x;rm -rf /' } })).statusCode).toBe(400);
  });

  it('an engine-free image (asked for, or any 2026.8+) needs the shared memory search service, which is off here', async () => {
    const seen: Array<{ version?: string; candidate: boolean; logPath: string; engine?: string }> = [];
    const { f } = await world(async (o) => { seen.push(o); return { ok: true }; });
    expect((await f.inject({ method: 'POST', url: '/v1/runtime/build', headers: as, payload: { engine: 'sideways' } })).statusCode).toBe(400);
    const lite = await f.inject({ method: 'POST', url: '/v1/runtime/build', headers: as, payload: { version: '2026.7.1-2', engine: 'none' } });
    expect(lite.statusCode).toBe(400); expect(lite.json().error).toMatch(/shared memory search service/);
    const nine = await f.inject({ method: 'POST', url: '/v1/runtime/build', headers: as, payload: { version: '2026.9.4' } });
    expect(nine.statusCode).toBe(400); expect(nine.json().error).toMatch(/2026\.9\.4 has no memory search engine/);
    // The proven line still builds, with its own engine.
    const ok = await f.inject({ method: 'POST', url: '/v1/runtime/build', headers: as, payload: { version: '2026.7.1-2' } });
    expect(ok.statusCode).toBe(202); expect(ok.json().engine).toBe('baked');
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[0]?.engine).toBeUndefined();
  });
});

describe('classes carry an image', () => {
  it('assigning the class pins the agent (rebuild needed); a manual pin elsewhere detaches it and shows as a trial', async () => {
    const { f, store } = await world();
    const made = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: as, payload: { name: 'PDF workers', image: 'hatchabot-runtime:derived-pdf' } });
    expect(made.statusCode).toBe(200);
    const cls = made.json().class; expect(cls.image).toBe('hatchabot-runtime:derived-pdf');
    const assign = await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: as, payload: { classId: cls.id } });
    expect(assign.json().rebuild).toBe(true);
    expect(store.getAgent('a1')!.image).toBe('hatchabot-runtime:derived-pdf');
    let list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
    expect(list.find((a: any) => a.id === 'a1').imageTrial).toBe(false); // class prescribes it — not a trial
    // Class image change propagates to members and says they need a rebuild.
    const upd = await f.inject({ method: 'PUT', url: `/v1/agent-classes/${cls.id}`, headers: as, payload: { image: 'hatchabot-runtime:2026.9.4' } });
    expect(upd.json().needRebuild).toBe(1);
    expect(store.getAgent('a1')!.image).toBe('hatchabot-runtime:2026.9.4');
    // Manual pin to something else → trial, class detached.
    await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { image: 'hatchabot-runtime:derived-pdf' } });
    list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
    const a1 = list.find((a: any) => a.id === 'a1');
    expect(a1.imageTrial).toBe(true); expect(a1.classId ?? null).toBeNull();
    // Clearing the class image sends members it had pinned back to the fleet default (rebuild needed).
    await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: as, payload: { classId: cls.id } });
    await f.inject({ method: 'PUT', url: `/v1/agent-classes/${cls.id}`, headers: as, payload: { image: 'hatchabot-runtime:2026.9.4' } });
    const cleared = await f.inject({ method: 'PUT', url: `/v1/agent-classes/${cls.id}`, headers: as, payload: { image: '' } });
    expect(cleared.json().needRebuild).toBe(1);
    expect(store.getAgent('a1')!.image ?? null).toBeNull();
    // Members can't set class images (that's a machine-owner call).
    expect((await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: { 'x-hatchabot-owner': 'user-other' }, payload: { name: 'X', image: 'hatchabot-runtime:2026.9.4' } })).statusCode).toBe(403);
  });
});

describe('deleting a derived image tag', () => {
  it('points at its own row when it has one, and deletes a leftover that has none', async () => {
    const { f, store } = await world();
    const tag = 'hatchabot-runtime:derived-pdf';
    // With a row: the tag route refuses and names where it IS deleted, because
    // that path also forgets the Dockerfile.
    store.upsertDerivedImage({ name: 'pdf', tag, base: 'hatchabot-runtime:latest', dockerfile: 'RUN true', createdBy: OWNER });
    store.setDerivedImageStatus('pdf', 'READY');
    const refused = await f.inject({ method: 'DELETE', url: '/v1/runtime/images/' + encodeURIComponent(tag), headers: as });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/Derived images/);

    // Its row gone, the image left behind: the Derived images tab has nothing
    // to delete, so this route must (2026-09-19 dead end).
    store.deleteDerivedImage('pdf');
    const gone = await f.inject({ method: 'DELETE', url: '/v1/runtime/images/' + encodeURIComponent(tag), headers: as });
    expect(gone.statusCode).toBe(200);
  });
});


describe('the agent list knows who runs the fleet default', () => {
  it('unpinned, or pinned to a tag that is the same image as :latest', async () => {
    const { f, store } = await world();
    store.setAgentImage('a1', 'hatchabot-runtime:2026.7.1-2'); // same image id as :latest in this world
    store.setAgentImage('a2', 'hatchabot-runtime:2026.9.4');   // another image
    const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
    const by = Object.fromEntries(list.map((a: any) => [a.id, a.imageIsDefault]));
    expect(by).toEqual({ a1: true, a2: false });
    // …and only the pin to something else is a trial.
    expect(Object.fromEntries(list.map((a: any) => [a.id, a.imageTrial]))).toEqual({ a1: false, a2: true });
  });
});

describe('a pin says whether it changes anything', () => {
  it('PATCH image answers sameImage when the tag is the image the agent already runs', async () => {
    const { f, provider } = await world();
    provider.infoOverride.set('mock://a1', { imageId: 'img-A' }); // runs the default's image
    const same = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { image: 'hatchabot-runtime:2026.7.1-2' } });
    expect(same.json().sameImage).toBe(true);
    const other = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { image: 'hatchabot-runtime:2026.9.4' } });
    expect(other.json().sameImage).toBe(false);
    const unpin = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: as, payload: { image: null } });
    expect(unpin.json().sameImage).toBe(true);
  });
});
