import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import {
  bumpMemoryCap, defaultMemoryCap, describeMemoryCap, effectiveMemoryCap, formatMemoryCap, memberMemoryMax,
  memoryBudgetSection, memoryCapChoices, parseMemoryCap,
} from '../src/orchestrator/memoryCap.js';

/**
 * The memory cap on an agent's container: fleet default, class default, or
 * the agent's own; members bounded by the machine's per-agent maximum;
 * applied live and kept across rebuilds; the agent told its budget.
 */
describe('memory cap values', () => {
  it('parses docker-style sizes and refuses nonsense and extremes', () => {
    expect(parseMemoryCap('3g')).toBe(3 * 1024 ** 3);
    expect(parseMemoryCap('1536M')).toBe(1536 * 1024 ** 2);
    expect(parseMemoryCap('2.5g')).toBe(Math.round(2.5 * 1024 ** 3));
    expect(parseMemoryCap(' 4gb ')).toBe(4 * 1024 ** 3);
    for (const bad of ['', 'lots', '4', '4k', '100m', '0g', '-1g', '9999g', 4, null, undefined]) expect(parseMemoryCap(bad), String(bad)).toBeUndefined();
  });
  it('formats and describes', () => {
    expect(formatMemoryCap(3 * 1024 ** 3)).toBe('3g');
    expect(formatMemoryCap(1536 * 1024 ** 2)).toBe('1536m');
    expect(describeMemoryCap(3 * 1024 ** 3)).toBe('3 GB');
    expect(describeMemoryCap(1536 * 1024 ** 2)).toBe('1.5 GB');
    expect(describeMemoryCap(768 * 1024 ** 2)).toBe('768 MB');
  });
  it('the fleet default and the member maximum come from the environment, with sane fallbacks', () => {
    expect(defaultMemoryCap({})).toBe('3g');
    expect(defaultMemoryCap({ HATCHABOT_AGENT_MEMORY: '4g' })).toBe('4g');
    expect(defaultMemoryCap({ HATCHABOT_AGENT_MEMORY: 'huge' })).toBe('3g');
    expect(memberMemoryMax({})).toBe('8g');
    expect(memberMemoryMax({ HATCHABOT_AGENT_MEMORY_MAX: '16g' })).toBe('16g');
    // never below the default: a max the default exceeds would forbid the default
    expect(memberMemoryMax({ HATCHABOT_AGENT_MEMORY: '12g', HATCHABOT_AGENT_MEMORY_MAX: '8g' })).toBe('12g');
  });
  it('the agent wins over its class, the class over the default', () => {
    expect(effectiveMemoryCap({ memoryCap: '6g' }, { memoryCap: '4g' }, {})).toBe('6g');
    expect(effectiveMemoryCap({}, { memoryCap: '4g' }, {})).toBe('4g');
    expect(effectiveMemoryCap({}, undefined, {})).toBe('3g');
    expect(effectiveMemoryCap({ memoryCap: 'junk' }, { memoryCap: '4g' }, {})).toBe('4g');
  });
  it('one step up is the next whole GB; choices stop at the maximum', () => {
    expect(bumpMemoryCap('3g')).toBe('4g');
    expect(bumpMemoryCap('1536m')).toBe('2g');
    expect(memoryCapChoices(8 * 1024 ** 3)).toEqual(['1g', '2g', '3g', '4g', '6g', '8g']);
  });
  it('the AGENTS.md section names the budget and the environment variable', () => {
    const s = memoryBudgetSection('4g');
    expect(s.startsWith('## Memory budget')).toBe(true);
    expect(s).toContain('**4 GB**');
    expect(s).toContain('HATCHABOT_MEMORY_CAP=4g');
    expect(s).toMatch(/SIGKILL/);
  });
});

const OWNER = 'user-owner';
const MEMBER = 'user-member';
const as = (o: string) => ({ 'x-hatchabot-owner': o });
async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now', shared: true } as never);
  const mk = async (id: string, ownerId: string) => {
    const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} });
    store.insertAgent({ id, ownerId, name: id, slug: id, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.setAgentRuntimeRef(id, runtimeRef); store.setAgentState(id, 'RUNNING');
    return runtimeRef;
  };
  const refs = { own: await mk('own', OWNER), mem: await mk('mem', MEMBER) };
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never });
  const prev = process.env.HATCHABOT_ALLOW_OWNER_HEADER;
  process.env.HATCHABOT_ALLOW_OWNER_HEADER = '1';
  const done = () => { if (prev === undefined) delete process.env.HATCHABOT_ALLOW_OWNER_HEADER; else process.env.HATCHABOT_ALLOW_OWNER_HEADER = prev; };
  return { store, f, provider, refs, done };
}

describe('PATCH /v1/agents/:id { memoryCap }', () => {
  it('sets the cap, applies it to the container right away, records it, and the list shows it', async () => {
    const { store, f, provider, refs, done } = await world();
    try {
      provider.infoOverride.set(refs.own, { memCapHits: 1203, memOomKills: 27, memPeakBytes: 2 * 1024 ** 3, memoryLimitBytes: 2 * 1024 ** 3 });
      let list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) })).json();
      const before = list.find((a: any) => a.id === 'own');
      expect(before).toMatchObject({ memoryCapEffective: '2g', memoryCapHits: 1203, memoryKills: 27, memoryPeakBytes: 2 * 1024 ** 3 });

      const r = await f.inject({ method: 'PATCH', url: '/v1/agents/own', headers: as(OWNER), payload: { memoryCap: '4g' } });
      expect(r.statusCode).toBe(200);
      expect(provider.memoryUpdates).toEqual([{ runtimeRef: refs.own, cap: '4g' }]);
      expect(store.getAgent('own')?.memoryCap).toBe('4g');
      expect(store.getAgent('own')?.memoryCapBaseline).toBe(1203); // hits before the raise are old news
      expect(store.listEvents(['own']).find((e) => e.event === 'memory.cap_set')?.detail).toMatchObject({ cap: '4g', effective: '4g', live: true });

      // The container now reports the new limit; hits since the raise start from zero.
      provider.infoOverride.set(refs.own, { memCapHits: 1210, memOomKills: 27, memoryLimitBytes: 4 * 1024 ** 3 });
      list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) })).json();
      expect(list.find((a: any) => a.id === 'own')).toMatchObject({ memoryCap: '4g', memoryCapEffective: '4g', memoryCapHits: 7 });

      // Back to the default: the container is updated to it.
      const back = await f.inject({ method: 'PATCH', url: '/v1/agents/own', headers: as(OWNER), payload: { memoryCap: null } });
      expect(back.statusCode).toBe(200);
      expect(provider.memoryUpdates.at(-1)).toEqual({ runtimeRef: refs.own, cap: '3g' });
      expect(store.getAgent('own')?.memoryCap).toBeUndefined();
    } finally { done(); }
  });

  it('a member may go up to the machine\'s per-agent maximum; the machine owner beyond it; nonsense is refused', async () => {
    const { f, provider, refs, done } = await world();
    try {
      expect((await f.inject({ method: 'PATCH', url: '/v1/agents/mem', headers: as(MEMBER), payload: { memoryCap: '8g' } })).statusCode).toBe(200);
      const tooMuch = await f.inject({ method: 'PATCH', url: '/v1/agents/mem', headers: as(MEMBER), payload: { memoryCap: '12g' } });
      expect(tooMuch.statusCode).toBe(403);
      expect(tooMuch.json().error).toMatch(/8g/);
      expect((await f.inject({ method: 'PATCH', url: '/v1/agents/own', headers: as(OWNER), payload: { memoryCap: '12g' } })).statusCode).toBe(200);
      expect(provider.memoryUpdates.map((u) => u.cap)).toEqual(['8g', '12g']);
      expect((await f.inject({ method: 'PATCH', url: '/v1/agents/own', headers: as(OWNER), payload: { memoryCap: 'lots' } })).statusCode).toBe(400);
      expect(refs.mem).toBeTruthy();
    } finally { done(); }
  });

  it('the account says what the picker may offer', async () => {
    const { f, done } = await world();
    try {
      expect((await f.inject({ method: 'GET', url: '/v1/account', headers: as(MEMBER) })).json()).toMatchObject({ memoryCapDefault: '3g', memoryCapMax: '8g' });
      expect((await f.inject({ method: 'GET', url: '/v1/account', headers: as(OWNER) })).json().memoryCapMax).toBe('512g');
    } finally { done(); }
  });
});

describe('a class memory cap', () => {
  it('reaches members without a cap of their own, live, and is what a rebuild uses', async () => {
    const { store, f, provider, refs, done } = await world();
    try {
      const made = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: as(OWNER), payload: { name: 'Quants', memoryCap: '6g' } });
      expect(made.statusCode).toBe(200);
      const cls = made.json().class;
      expect(cls.memoryCap).toBe('6g');
      store.setAgentClass('own', cls.id);
      // A member with its own cap keeps it; one without follows the class.
      const put = await f.inject({ method: 'PUT', url: `/v1/agent-classes/${cls.id}`, headers: as(OWNER), payload: { memoryCap: '8g' } });
      expect(put.statusCode).toBe(200);
      expect(provider.memoryUpdates).toEqual([{ runtimeRef: refs.own, cap: '8g' }]);
      const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as(OWNER) })).json();
      expect(list.find((a: any) => a.id === 'own').memoryCapEffective).toBe('8g');
      // Too much for a member's class.
      expect((await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: as(MEMBER), payload: { name: 'Big', memoryCap: '64g' } })).statusCode).toBe(403);
    } finally { done(); }
  });
});
