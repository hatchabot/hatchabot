import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { buildRuntimeSpec, createAgentRecord, runProvisionSteps } from '../src/orchestrator/provision.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { ChannelSetupRequired } from '../src/channels/channel.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Telegram is optional: an agent can be web-only (talked to in Hatchabot's own
 * console), gain a bot later, or give its bot back.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error(`no secret ${r}`); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };

function channel(opts: { empty?: boolean } = {}) {
  const released: Array<{ id: string; reason?: string }> = [];
  const parked: string[] = [];
  let provisions = 0;
  const submitted = new Map<string, string>();
  const chan = {
    kind: 'telegram' as const,
    released, parked,
    provisions: () => provisions,
    pool: {
      owns: (u: string) => u === 'poolbot',
      addToPool: async (u: string) => { parked.push(u); },
      availableCount: () => (opts.empty ? 0 : 1),
    },
    async submitToken(agentId: string, token: string) {
      if (!token.includes(':')) {
        const { InvalidBotTokenError } = await import('../src/channels/telegramManual.js');
        throw new (InvalidBotTokenError as any)('bad token');
      }
      submitted.set(agentId, token); return { username: 'mybot' };
    },
    discardPending: (id: string) => { submitted.delete(id); },
    async provision(req: { agentId: string; skipPool?: boolean }) {
      if (req.skipPool || submitted.has(req.agentId)) {
        if (!submitted.has(req.agentId)) throw new ChannelSetupRequired('paste a token', req.agentId);
        provisions++;
        return { accountId: 'mybot', secretRef: `channel/${req.agentId}/bot-token`, deepLink: 'https://t.me/mybot' };
      }
      if (opts.empty) throw new ChannelSetupRequired('paste a token', req.agentId);
      provisions++;
      return { accountId: 'poolbot', secretRef: 'chan/pool', deepLink: 'https://t.me/poolbot' };
    },
    async release(accountId: string, o?: { reason?: string }) { released.push({ id: accountId, reason: o?.reason }); },
  };
  return chan;
}

function base() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  void secrets.put('ai/p1', 'sk-test');
  void secrets.put('chan/pool', '1:pooltoken');
  return { store, secrets };
}

describe('provisioning a web-only agent', () => {
  it('skips the bot entirely and writes no Telegram channel into its config', async () => {
    const { store, secrets } = base();
    const chan = channel();
    const provider = new MockProvider();
    const deps = { store, secrets, provider, channel: chan as unknown as ChannelProvisioner, sleep: async () => {} };
    const agent = createAgentRecord(store, { ownerId: OWNER, name: 'Notes', aiProfileId: 'p1', hostId: 'h1' });
    store.setAgentWebOnly(agent.id, true);
    const res = await runProvisionSteps(deps, agent.id);
    expect(res.agent.state).toBe('RUNNING');
    expect(chan.provisions()).toBe(0);
    expect(store.getChannelForAgent(agent.id)).toBeUndefined();
    const spec = await buildRuntimeSpec(deps, agent.id);
    expect((spec.workspace.configPatch as { telegram?: unknown }).telegram).toBeUndefined();
  });

  it('an agent that is NOT web-only still refuses to build without a bot', async () => {
    const { store, secrets } = base();
    const deps = { store, secrets, provider: new MockProvider(), channel: channel() as unknown as ChannelProvisioner, sleep: async () => {} };
    const agent = createAgentRecord(store, { ownerId: OWNER, name: 'Notes', aiProfileId: 'p1', hostId: 'h1' });
    await expect(buildRuntimeSpec(deps, agent.id)).rejects.toThrow(/no channel/);
  });
});

async function api(opts: { empty?: boolean } = {}) {
  const { store, secrets } = base();
  const chan = channel(opts);
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: chan as any });
  const add = (id: string, webOnly: boolean) => store.insertAgent({
    id, ownerId: OWNER, name: id, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://' + id,
    persona: '', sharedMemory: true, webOnly, createdAt: 'now', updatedAt: 'now',
  } as any);
  return { store, secrets, chan, f, add };
}

describe('create, add and remove Telegram', () => {
  it('POST /v1/agents with telegram:false makes a web-only agent', async () => {
    const { store, f } = await api();
    const r = await f.inject({ method: 'POST', url: '/v1/agents', headers: H, payload: { name: 'Web Pal', aiProfileId: 'p1', hostId: 'h1', telegram: false } });
    expect(r.statusCode).toBeLessThan(300);
    const a = store.listAgents(OWNER).find((x) => x.name === 'Web Pal')!;
    expect(a.webOnly).toBe(true);
  });

  it('adds a pool bot to a web-only agent', async () => {
    const { store, f, add } = await api();
    add('a1', true);
    const r = await f.inject({ method: 'POST', url: '/v1/agents/a1/telegram', headers: H, payload: {} });
    expect(r.statusCode).toBe(202);
    expect(r.json().username).toBe('poolbot');
    expect(store.getChannelForAgent('a1')?.accountId).toBe('poolbot');
    expect(store.getAgent('a1')?.webOnly).toBe(false);
  });

  it('with an empty pool, asks for a token — then takes one', async () => {
    const { store, f, add } = await api({ empty: true });
    add('b1', true);
    let r = await f.inject({ method: 'POST', url: '/v1/agents/b1/telegram', headers: H, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().needsToken).toBe(true);
    expect(store.getChannelForAgent('b1')).toBeUndefined();
    r = await f.inject({ method: 'POST', url: '/v1/agents/b1/telegram', headers: H, payload: { token: 'nope' } });
    expect(r.statusCode).toBe(400);
    r = await f.inject({ method: 'POST', url: '/v1/agents/b1/telegram', headers: H, payload: { token: '123:abc' } });
    expect(r.statusCode).toBe(202);
    expect(store.getChannelForAgent('b1')?.accountId).toBe('mybot');
  });

  it('removing Telegram parks a pasted bot in the pool, says goodbye, and goes web-only', async () => {
    const { store, secrets, chan, f, add } = await api();
    add('c1a', false);
    await secrets.put('channel/c1a/bot-token', '9:mine');
    store.setAgentState('c1a', 'STOPPED'); // the mock has no container to stop
    store.insertChannel({ id: 'c1', agentId: 'c1a', kind: 'telegram', accountId: 'mybot', secretRef: 'channel/c1a/bot-token', deepLink: 'https://t.me/mybot', createdAt: 'now' });
    const r = await f.inject({ method: 'DELETE', url: '/v1/agents/c1a/telegram', headers: H });
    expect(r.statusCode).toBe(202);
    expect(chan.parked).toEqual(['mybot']);                        // the token stays usable
    expect(chan.released).toEqual([{ id: 'mybot', reason: 'detached' }]);
    expect(store.getChannelForAgent('c1a')).toBeUndefined();
    expect(store.getAgent('c1a')?.webOnly).toBe(true);
  });

  it('refuses to add a second bot, and to remove one that is not there', async () => {
    const { store, f, add } = await api();
    add('d1', false);
    store.insertChannel({ id: 'c1', agentId: 'd1', kind: 'telegram', accountId: 'poolbot', secretRef: 'chan/pool', deepLink: 'https://t.me/poolbot', createdAt: 'now' });
    expect((await f.inject({ method: 'POST', url: '/v1/agents/d1/telegram', headers: H, payload: {} })).statusCode).toBe(409);
    add('d2', true);
    expect((await f.inject({ method: 'DELETE', url: '/v1/agents/d2/telegram', headers: H })).statusCode).toBe(404);
  });
});
