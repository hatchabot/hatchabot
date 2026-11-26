import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { as, makeWorld, seedRunningAgent, type World } from './support/world.js';

const OWNER = 'user-o';
const H = { 'x-hatchabot-owner': OWNER };

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', models: ['claude-sonnet-5', 'claude-fable-5'], secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } as any }, env: {} });
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
  const f = Fastify();
  await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  return { store, provider, f };
}

describe('agent classes', () => {
  it('a number where an image, memory cap or swap allowance belongs is a 400, not a 500 (HB-0362)', async () => {
    const { store, f } = await world();
    for (const field of ['image', 'memoryCap', 'swapAllowance']) {
      const r = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Pantry', [field]: 42 } });
      expect(r.statusCode, field).toBe(400);
      expect(r.json().error).toBe(`${field}: a string.`);
    }
    expect(store.listAgentClasses(OWNER)).toEqual([]);
  });

  it('creates a class and assigning it applies the class model live (no rebuild)', async () => {
    const { store, provider, f } = await world();
    const created = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Light', model: 'claude-sonnet-5' } });
    expect(created.statusCode).toBe(200);
    const classId = created.json().class.id;

    const assign = await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    expect(assign.statusCode).toBe(200);
    expect(assign.json()).toMatchObject({ classId, rebuild: false });
    // wrote the override + live-applied via `models set`, no rebuild
    expect(store.getAgent('a1')!.model).toBe('claude-sonnet-5');
    expect(store.getAgent('a1')!.classId).toBe(classId);
    expect(provider.execLog.some((c) => Array.isArray(c) && c[0] === 'models' && c[1] === 'set')).toBe(true);
  });

  it('editing a class re-applies its model to member agents', async () => {
    const { store, f } = await world();
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Tier', model: 'claude-sonnet-5' } })).json().class.id;
    await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    const edit = await f.inject({ method: 'PUT', url: `/v1/agent-classes/${classId}`, headers: H, payload: { model: 'claude-fable-5' } });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 1 });
    expect(store.getAgent('a1')!.model).toBe('claude-fable-5'); // propagated
  });

  it('deleting a class clears the tag but leaves the agent model as-is', async () => {
    const { store, f } = await world();
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'X', model: 'claude-sonnet-5' } })).json().class.id;
    await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    await f.inject({ method: 'DELETE', url: `/v1/agent-classes/${classId}`, headers: H });
    expect(store.getAgent('a1')!.classId).toBeUndefined();
    expect(store.getAgent('a1')!.model).toBe('claude-sonnet-5'); // kept
    expect(store.listAgentClasses(OWNER)).toHaveLength(0);
  });

  it('refuses a duplicate class name (case-insensitive) on create and rename', async () => {
    const { f } = await world();
    const a = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Light' } });
    expect(a.statusCode).toBe(200);
    const dup = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'light' } });
    expect(dup.statusCode).toBe(400); // was an unhandled SQLITE_CONSTRAINT → 500
    const b = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Heavy' } })).json().class.id;
    const ren = await f.inject({ method: 'PUT', url: `/v1/agent-classes/${b}`, headers: H, payload: { name: 'Light' } });
    expect(ren.statusCode).toBe(400);
  });

  it('a class whose model the target source cannot run leaves the agent UNTOUCHED (no half-switch)', async () => {
    const { store, f } = await world();
    store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Local', vendor: 'local', kind: 'api_key', model: 'gpt-oss', secretRef: 'ai/p2', createdAt: 'now' });
    // Refused when it is saved now (HB-0060); one saved before is still refused when given.
    const create = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Bad', model: 'claude-sonnet-5', aiProfileId: 'p2' } });
    expect(create.statusCode).toBe(400);
    const classId = 'c-bad';
    store.upsertAgentClass({ id: classId, ownerId: OWNER, name: 'Bad', model: 'claude-sonnet-5', aiProfileId: 'p2' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    expect(res.statusCode).toBe(400);
    const a = store.getAgent('a1')!;
    expect(a.aiProfileId).toBe('p1');      // source NOT switched
    expect(a.model).toBeUndefined();       // override NOT written
    expect(a.classId).toBeUndefined();
  });

  it('a class\'s model is checked against its own source when it is saved (HB-0060)', async () => {
    const { store, f } = await world();
    store.insertAIProfile({ id: 'p2', ownerId: OWNER, name: 'Local', vendor: 'local', kind: 'api_key', model: 'gpt-oss', secretRef: 'ai/p2', createdAt: 'now' });
    const offMenu = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Typo', model: 'claude-opus-4.8', aiProfileId: 'p1' } });
    expect(offMenu.statusCode).toBe(400);
    expect(offMenu.json().error).toMatch(/isn’t one of this source’s models/);
    const local = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Local', model: 'gpt-oss', aiProfileId: 'p2' } });
    expect(local.statusCode).toBe(400);
    // No source of its own: each agent's source judges it when the class is given.
    expect((await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Any', model: 'claude-opus-4.8' } })).statusCode).toBe(200);
    const ok = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Light', model: 'claude-sonnet-5', aiProfileId: 'p1' } });
    expect(ok.statusCode).toBe(200);
    const id = ok.json().class.id;
    // An edit naming the model, or a source that lacks it, is refused and changes nothing.
    expect((await f.inject({ method: 'PUT', url: `/v1/agent-classes/${id}`, headers: H, payload: { model: 'claude-opus-4.8' } })).statusCode).toBe(400);
    expect((await f.inject({ method: 'PUT', url: `/v1/agent-classes/${id}`, headers: H, payload: { aiProfileId: 'p2' } })).statusCode).toBe(400);
    expect(store.getAgentClass(id)).toMatchObject({ model: 'claude-sonnet-5', aiProfileId: 'p1' });
    // A rename alone is not judged on what was stored before.
    store.upsertAgentClass({ id, ownerId: OWNER, name: 'Light', model: 'claude-retired-1', aiProfileId: 'p1' });
    expect((await f.inject({ method: 'PUT', url: `/v1/agent-classes/${id}`, headers: H, payload: { name: 'Lighter' } })).statusCode).toBe(200);
  });

  it('refuses a class that would put the agent on another account\'s machine-login source', async () => {
    const { store, f } = await world();
    store.insertAIProfile({ id: 'p-ml', ownerId: 'user-other', name: 'Their Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', shared: true, createdAt: 'now' } as any);
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'ML', aiProfileId: 'p-ml' } })).json().class.id;
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/machine-login/i);
    expect(store.getAgent('a1')!.aiProfileId).toBe('p1');
  });

  it('a shared source its owner stops sharing while a join is checked is not written to the agent (HB-0970)', async () => {
    const { store, provider, f } = await world();
    store.insertAIProfile({ id: 'p-theirs', ownerId: 'user-other', name: 'Their plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-5-5', secretRef: 'ai/p-theirs', shared: true, createdAt: 'now' } as any);
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Plan', aiProfileId: 'p-theirs' } })).json().class.id;
    // The join's runtime check reads the image it would be rebuilt on; meanwhile its owner unshares it.
    const real = provider.currentImageInfo.bind(provider);
    provider.currentImageInfo = async (image) => {
      store.setAIProfileShared('p-theirs', false);
      return { ...(await real(image)), openclawVersion: '2026.10.1' };
    };
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('class source unavailable');
    const a = store.getAgent('a1')!;
    expect(a.aiProfileId).toBe('p1');
    expect(a.classId).toBeUndefined();
    // Shared again: the join goes through.
    provider.currentImageInfo = async (image) => ({ ...(await real(image)), openclawVersion: '2026.10.1' });
    store.setAIProfileShared('p-theirs', true);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } })).json()).toMatchObject({ classId, rebuild: true });
    expect(store.getAgent('a1')!.aiProfileId).toBe('p-theirs');
  });

  it('editing a class skips ARCHIVED members', async () => {
    const { store, f } = await world();
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'T', model: 'claude-sonnet-5' } })).json().class.id;
    await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    store.setAgentState('a1', 'STOPPED'); store.setAgentState('a1', 'ARCHIVED');
    const edit = await f.inject({ method: 'PUT', url: `/v1/agent-classes/${classId}`, headers: H, payload: { model: 'claude-fable-5' } });
    expect(edit.json().applied).toBe(0);
    expect(store.getAgent('a1')!.model).toBe('claude-sonnet-5'); // untouched while archived
  });

  it('changing the model by hand detaches a class that pins a different one (no silent yank-back later)', async () => {
    const { store, f } = await world();
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Light', model: 'claude-sonnet-5' } })).json().class.id;
    await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    expect(store.getAgent('a1')!.classId).toBe(classId);
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: H, payload: { model: 'claude-fable-5' } });
    expect(res.json().classDetached).toBe(true);
    expect(store.getAgent('a1')!.classId).toBeUndefined();
    // Setting the SAME model the class pins keeps the tag.
    await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    const same = await f.inject({ method: 'POST', url: '/v1/agents/a1/model', headers: H, payload: { model: 'claude-sonnet-5' } });
    expect(same.json().classDetached).toBe(false);
    expect(store.getAgent('a1')!.classId).toBe(classId);
  });

  it('rejects a class model the agent’s source cannot run', async () => {
    const { f } = await world();
    // local source can't take an anthropic model override
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Bad', model: 'not-a-real-model' } })).json().class.id;
    const assign = await f.inject({ method: 'POST', url: '/v1/agents/a1/class', headers: H, payload: { classId } });
    expect(assign.statusCode).toBe(400); // modelOverrideProblem: not on this source's menu
  });
});

describe('a set_class card from the Hatchabot agent (audit #097)', () => {
  const WHO = { ownerId: OWNER, chatId: 123, fromUserId: 456 };
  async function brokerFor(f: Awaited<ReturnType<typeof world>>['f']) {
    const { Broker } = await import('../src/mgmt/broker.js');
    const { HttpApiClient } = await import('../src/mgmt/apiClient.js');
    const { PendingStore } = await import('../src/mgmt/pendingStore.js');
    const broker = new Broker(new HttpApiClient(async (method, path, body) => {
      const res = await f.inject({ method: method as any, url: path, headers: H, payload: body as any });
      if (res.statusCode >= 400) throw new Error(res.json().error ?? String(res.statusCode));
      return res.json();
    }), new PendingStore());
    broker.setMode(true);
    return broker;
  }

  it('confirmed after the class changed, it applies nothing and says what changed; a fresh card applies the class as it is', async () => {
    const { store, f } = await world();
    const classId = (await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: H, payload: { name: 'Light', model: 'claude-sonnet-5' } })).json().class.id;
    const broker = await brokerFor(f);
    const card = await broker.handleTool('set_class', { agent: 'a1', class: 'Light' }, WHO) as any;
    expect(card.pending.summary).toContain('model claude-sonnet-5');
    // Edited from another tab before Confirm.
    expect((await f.inject({ method: 'PUT', url: `/v1/agent-classes/${classId}`, headers: H, payload: { model: 'claude-fable-5' } })).statusCode).toBe(200);
    const stale = await broker.confirm(card.pending.confirmId, 'confirm', WHO);
    expect(stale.ok && stale.text).toMatch(/^⚠ Failed/);
    expect(stale.ok && stale.text).toMatch(/changed after this was shown: it now has model claude-fable-5\. Nothing was changed/);
    expect(store.getAgent('a1')!.classId).toBeFalsy();
    expect(store.getAgent('a1')!.model).toBeUndefined();
    // Asked again, the card shows the class as it is, and that is what is applied.
    const fresh = await broker.handleTool('set_class', { agent: 'a1', class: 'Light' }, WHO) as any;
    expect(fresh.pending.summary).toContain('model claude-fable-5');
    const done = await broker.confirm(fresh.pending.confirmId, 'confirm', WHO);
    expect(done.ok && done.text).toMatch(/^✅/);
    expect(store.getAgent('a1')).toMatchObject({ classId, model: 'claude-fable-5' });
  });
});

describe('a class edit tried again asks only the machines of members changed since (HB-0642)', () => {
  const NEWER = 'hatchabot-runtime:newer-trial', OLDER = 'hatchabot-runtime:older-trial', MID = 'hatchabot-runtime:mid-trial';
  const closers: Array<() => Promise<unknown>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });
  const send = (w: World, method: 'POST' | 'PUT', url: string, payload: object) => w.f.inject({ method, url, headers: as(), payload });
  /**
   * Three running agents, the first two in a class with no image. Each read
   * of a container is counted (an image pin's check reads the agent's
   * container and the image), on this machine and on a runner (`h2`).
   * `meanwhile`: run once, while the edit's first check of the first member
   * waits for its container, which answers as it was when asked.
   */
  async function classOfTwo() {
    const w = await makeWorld();
    closers.push(() => w.f.close());
    const agents: Array<[string, string, string]> = [['a1', 'Meal Planner', 'meal-planner'], ['a2', 'Garden Notes', 'garden-notes'], ['a3', 'Homework Helper', 'homework-helper']];
    for (const [id, name, slug] of agents) {
      await seedRunningAgent(w, { id, name, slug, accountId: `${slug.replace('-', '')}bot` });
    }
    w.store.upsertAgentClass({ id: 'c1', ownerId: w.owner, name: 'Tier' });
    for (const id of ['a1', 'a2']) w.store.setAgentClassIf(id, null, 'c1');
    w.provider.tags.push({ tag: NEWER, imageId: 'newer-image', openclawVersion: '2026.9.8' }, { tag: OLDER, imageId: 'older-image', openclawVersion: '2026.7.1' });
    const runner = new MockProvider();
    w.providers.set('mock2', runner);
    w.store.insertHost({ id: 'h2', ownerId: w.owner, kind: 'cloud', provider: 'mock2', name: 'Runner', settings: {}, createdAt: 'now' } as never);
    const ref = (id: string) => w.store.getAgent(id)!.runtimeRef!;
    const reads = { h1: new Map<string, number>(), h2: new Map<string, number>() };
    let during: (() => Promise<unknown>) | undefined;
    for (const [host, p] of [['h1', w.provider], ['h2', runner]] as const) {
      const info = p.info.bind(p);
      p.info = async (r) => {
        reads[host].set(r ?? '', (reads[host].get(r ?? '') ?? 0) + 1);
        const answer = info(r);
        // Its rejection, if it has one, is its caller's: not left unhandled while the hold runs.
        answer.catch(() => undefined);
        if (r === ref('a1') && during) { const d = during; during = undefined; await d(); }
        return answer;
      };
    }
    const readsOf = (id: string, host: 'h1' | 'h2' = 'h1') => reads[host].get(ref(id)) ?? 0;
    return { w, readsOf, meanwhile: (fn: () => Promise<unknown>) => { during = fn; } };
  }
  const join = async (w: World, id: string) => {
    const r = await send(w, 'POST', `/v1/agents/${id}/class`, { classId: 'c1' });
    expect(r.statusCode, r.body).toBe(200);
  };

  it('one joining while the edit checks: the members checked already are not asked again', async () => {
    const { w, readsOf, meanwhile } = await classOfTwo();
    meanwhile(() => join(w, 'a3'));
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { image: NEWER });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 3, needRebuild: 3, skipped: [], modelPending: [] });
    for (const id of ['a1', 'a2', 'a3']) expect(w.store.getAgent(id)).toMatchObject({ classId: 'c1', image: NEWER });
    // Each container read once: the first try's checks of the first two
    // stand for the second, which checks only the one that joined.
    expect(['a1', 'a2', 'a3'].map((id) => readsOf(id))).toEqual([1, 1, 1]);
  });

  it('the class renamed while the edit checks: its next try finds the checks still fit, and asks no machine again', async () => {
    const { w, readsOf, meanwhile } = await classOfTwo();
    meanwhile(async () => { w.store.upsertAgentClass({ ...w.store.getAgentClass('c1')!, name: 'Tier two' }); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { image: NEWER });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ class: { name: 'Tier two', image: NEWER }, applied: 2, skipped: [] });
    expect(['a1', 'a2'].map((id) => readsOf(id))).toEqual([1, 1]);
  });

  it('a member moved to another machine, or rebuilt, since the try before is checked again, and its new answer counts', async () => {
    const { w, readsOf, meanwhile } = await classOfTwo();
    meanwhile(async () => {
      await join(w, 'a3');
      // The first is moved to the runner; the second is rebuilt onto
      // OpenClaw 2026.9.8, whose data the class's older image cannot read.
      w.store.setAgentHost('a1', 'h2');
      await new Promise((r) => setTimeout(r, 5)); // its record written at a later time than it was read
      w.provider.infoOverride.set(w.store.getAgent('a2')!.runtimeRef!, { openclawVersion: '2026.9.8' });
      w.store.setAgentState('a2', 'REBUILDING');
      w.store.setAgentState('a2', 'RUNNING');
    });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { image: OLDER });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 2, needRebuild: 2, modelPending: [] });
    expect(edit.json().skipped).toEqual([`Garden Notes: This agent's data was migrated for OpenClaw 2026.9.8; ${OLDER} runs 2026.7.1, which cannot read it. To go back, restore the copy downloaded before the move.`]);
    expect(w.store.getAgent('a1')).toMatchObject({ hostId: 'h2', image: OLDER });
    expect(w.store.getAgent('a2')!.image).toBeUndefined();
    expect(w.store.getAgent('a3')!.image).toBe(OLDER);
    // The first asked on each machine it was on, the second once before and once after its rebuild.
    expect([readsOf('a1'), readsOf('a1', 'h2'), readsOf('a2'), readsOf('a3')]).toEqual([1, 1, 2, 1]);
  });

  it('a container that gave no answer on the first try is asked again on the next, and its answer counts', async () => {
    const { w, readsOf, meanwhile } = await classOfTwo();
    // Its runner gives no OpenClaw version on the first try (asleep, timed
    // out), and answers on the next: 2026.9.8, whose data the class's older image cannot read.
    const ref = w.store.getAgent('a1')!.runtimeRef!;
    w.provider.infoOverride.set(ref, { openclawVersion: undefined });
    meanwhile(async () => { await join(w, 'a3'); w.provider.infoOverride.set(ref, { openclawVersion: '2026.9.8' }); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { image: OLDER });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 2, needRebuild: 2, modelPending: [] });
    expect(edit.json().skipped).toEqual([`Meal Planner: This agent's data was migrated for OpenClaw 2026.9.8; ${OLDER} runs 2026.7.1, which cannot read it. To go back, restore the copy downloaded before the move.`]);
    expect(w.store.getAgent('a1')!.image).toBeUndefined();
    expect(['a2', 'a3'].map((id) => w.store.getAgent(id)!.image)).toEqual([OLDER, OLDER]);
    expect(['a1', 'a2', 'a3'].map((id) => readsOf(id))).toEqual([2, 1, 1]);
  });

  it("the source a class moves its members to given a new default between tries: each is checked again against it", async () => {
    const { w, readsOf, meanwhile } = await classOfTwo();
    // A subscription source whose default runs on OpenClaw 2026.9.6, the
    // image the edit pins, until it becomes claude-opus-5-5, which needs 2026.9.7.
    w.store.insertAIProfile({ id: 'plan', ownerId: w.owner, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', models: ['claude-opus-5-5'], secretRef: 'ai/plan', createdAt: 'now' });
    w.provider.tags.push({ tag: MID, imageId: 'mid-image', openclawVersion: '2026.9.6' });
    meanwhile(async () => { await join(w, 'a3'); w.store.setAIProfileModel('plan', 'claude-opus-5-5'); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { aiProfileId: 'plan', image: MID });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 0, needRebuild: 0 });
    expect(edit.json().skipped).toEqual(['Meal Planner', 'Garden Notes', 'Homework Helper'].map((name) => `${name}: claude-opus-5-5 needs OpenClaw 2026.9.7 or newer on a Claude subscription, and this agent runs 2026.9.6: Anthropic would refuse every message ("request format rejected, HTTP 400"). Try a newer runtime image on this agent (Settings → Advanced → Runtime images), or use an API-key source.`));
    for (const id of ['a1', 'a2', 'a3']) expect(w.store.getAgent(id)).toMatchObject({ aiProfileId: 'p1' });
    for (const id of ['a1', 'a2', 'a3']) expect(w.store.getAgent(id)!.image).toBeUndefined();
    expect(['a1', 'a2', 'a3'].map((id) => readsOf(id))).toEqual([2, 2, 1]);
  });

  it("the class's own settings changed between tries: its members are checked again for them, and the edit goes ahead", async () => {
    const { w, readsOf, meanwhile } = await classOfTwo();
    // The class given a source (the one its members are on) while the edit, which names only its image, checks.
    meanwhile(async () => { w.store.upsertAgentClass({ ...w.store.getAgentClass('c1')!, aiProfileId: 'p1' }); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { image: NEWER });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ class: { aiProfileId: 'p1', image: NEWER }, applied: 2, skipped: [] });
    expect(['a1', 'a2'].map((id) => readsOf(id))).toEqual([2, 2]);
  });

  /** The refusal of a class image an agent's data, migrated for 2026.9.8, cannot go back to. */
  const cannotRead = (name: string) => `${name}: This agent's data was migrated for OpenClaw 2026.9.8; ${OLDER} runs 2026.7.1, which cannot read it. To go back, restore the copy downloaded before the move.`;
  /** The refusal of claude-opus-5-5 on a subscription, on OpenClaw 2026.9.6. */
  const tooOld = (name: string) => `${name}: claude-opus-5-5 needs OpenClaw 2026.9.7 or newer on a Claude subscription, and this agent runs 2026.9.6: Anthropic would refuse every message ("request format rejected, HTTP 400"). Try a newer runtime image on this agent (Settings → Advanced → Runtime images), or use an API-key source.`;
  /** A subscription source that offers claude-opus-5-5, with `model` its default. */
  const plan = (w: World, model: string) => w.store.insertAIProfile({ id: 'plan', ownerId: w.owner, name: 'Plan', vendor: 'anthropic', kind: 'subscription', model, models: ['claude-opus-5-5', 'claude-sonnet-5'], secretRef: 'ai/plan', createdAt: 'now' });

  it("a container whose read failed on the first try is asked again, and its answer counts", async () => {
    const { w, meanwhile } = await classOfTwo();
    const ref = w.store.getAgent('a1')!.runtimeRef!;
    // Its first read fails (its runner timed out); the next answers 2026.9.8.
    meanwhile(async () => { await join(w, 'a3'); w.provider.infoOverride.set(ref, { openclawVersion: '2026.9.8' }); });
    const counted = w.provider.info.bind(w.provider);
    let failed = false;
    w.provider.info = async (r) => {
      const answer = await counted(r);
      if (r === ref && !failed) { failed = true; throw new Error('the runner did not answer'); }
      return answer;
    };
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { image: OLDER });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 2, skipped: [cannotRead('Meal Planner')] });
    expect(w.store.getAgent('a1')!.image).toBeUndefined();
  });

  it("a class image not on the machine yet on the first try is asked about again, and its answer counts", async () => {
    const { w, meanwhile } = await classOfTwo();
    w.provider.infoOverride.set(w.store.getAgent('a1')!.runtimeRef!, { openclawVersion: '2026.9.8' });
    // The image gives no version until it is there, on OpenClaw 2026.7.1.
    let there = false;
    const image = w.provider.currentImageInfo.bind(w.provider);
    w.provider.currentImageInfo = async (tag) => (tag === OLDER && !there ? {} : image(tag));
    meanwhile(async () => { await join(w, 'a3'); there = true; });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { image: OLDER });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 2, skipped: [cannotRead('Meal Planner')] });
    expect(w.store.getAgent('a1')!.image).toBeUndefined();
  });

  it("a subscription member's container that gave no version on the first try is asked again for the class's model", async () => {
    const { w, meanwhile } = await classOfTwo();
    plan(w, 'claude-sonnet-5');
    for (const id of ['a1', 'a2', 'a3']) w.store.setAgentAIProfile(id, 'plan');
    const ref = (id: string) => w.store.getAgent(id)!.runtimeRef!;
    for (const id of ['a2', 'a3']) w.provider.infoOverride.set(ref(id), { openclawVersion: '2026.9.8' });
    // The first gives no version, then answers 2026.9.6, too old for the class's new model.
    w.provider.infoOverride.set(ref('a1'), { openclawVersion: undefined });
    meanwhile(async () => { await join(w, 'a3'); w.provider.infoOverride.set(ref('a1'), { openclawVersion: '2026.9.6' }); });
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { model: 'claude-opus-5-5' });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 2, skipped: [tooOld('Meal Planner')] });
    expect(w.store.getAgent('a1')!.model).toBeUndefined();
    expect(['a2', 'a3'].map((id) => w.store.getAgent(id)!.model)).toEqual(['claude-opus-5-5', 'claude-opus-5-5']);
  });

  it("a switch to a subscription whose rebuild image gave no version on the first try is asked again, and its answer counts", async () => {
    const { w } = await classOfTwo();
    plan(w, 'claude-opus-5-5');
    // The image they would be rebuilt on (the default) gives no version on
    // the first try, its first read held while one joins; then it answers 2026.9.6.
    let answers = false, joining: Promise<void> | undefined;
    const image = w.provider.currentImageInfo.bind(w.provider);
    w.provider.currentImageInfo = async (tag) => {
      if (tag || answers) return image(tag);
      if (!joining) {
        joining = join(w, 'a3').then(() => { w.provider.imageOpenclawVersion = '2026.9.6'; answers = true; });
        await joining;
      }
      return {};
    };
    const edit = await send(w, 'PUT', '/v1/agent-classes/c1', { aiProfileId: 'plan' });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(edit.json()).toMatchObject({ applied: 0, skipped: ['Meal Planner', 'Garden Notes', 'Homework Helper'].map(tooOld) });
    for (const id of ['a1', 'a2', 'a3']) expect(w.store.getAgent(id)!.aiProfileId).toBe('p1');
  });
});
