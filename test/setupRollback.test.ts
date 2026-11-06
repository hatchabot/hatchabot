import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { TelegramPoolProvisioner } from '../src/channels/telegramPool.js';
import { TelegramManualProvisioner } from '../src/channels/telegramManual.js';
import { CompositeTelegramProvisioner } from '../src/channels/composite.js';
import { ChannelSetupRequired } from '../src/channels/channel.js';
import { runProvisionSteps } from '../src/orchestrator/provision.js';
import { reconcileAgents } from '../src/orchestrator/reconcile.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { Store } from '../src/store/store.js';
import { MemSecrets } from './support/world.js';

/**
 * A setup that failed and can be retried: nothing is over for the people on the
 * agent (HB-0412), and what the owner already gave it is still there for the
 * Retry, with the agent left waiting on them rather than failed (HB-0414, HB-0415).
 */

const OWNER = 'owner-a';

function world(providerOpts: ConstructorParameters<typeof MockProvider>[0] = {}) {
  const db = new Database(':memory:');
  const store = new Store(db);
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' } as never);
  void secrets.put('ai/p1', 'not-a-real-key');
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1',
    persona: 'helps cook', sharedMemory: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active', channelUserId: '4242' } as never);
  store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'someone', role: 'user', status: 'active', channelUserId: '4343' } as never);
  const sent: string[] = [];
  const fetchImpl = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes('/sendMessage')) sent.push(String(init?.body ?? ''));
    return new Response('{"ok":true,"result":{"username":"pastedbot"}}');
  }) as unknown as typeof fetch;
  const pool = new TelegramPoolProvisioner(db, secrets, { fetchImpl });
  const manual = new TelegramManualProvisioner(secrets);
  const channel = new CompositeTelegramProvisioner(pool, manual);
  const provider = new MockProvider(providerOpts);
  const deps = { store, secrets, provider, channel, sleep: async () => {} };
  return { store, secrets, pool, manual, channel, provider, deps, sent };
}

afterEach(() => vi.restoreAllMocks());

describe('a failed setup says nothing to the people on the agent (HB-0412)', () => {
  it('no "this agent has been removed", though the bot goes back to the pool', async () => {
    const w = world({ failOn: 'start' });
    await w.pool.addToPool('sparebot', 'not-a-real-token');
    const r = await runProvisionSteps(w.deps as never, 'a1');
    expect(r.agent.state).toBe('FAILED');
    expect(w.sent.filter((b) => /removed|end of this agent/.test(b))).toEqual([]);
    expect(w.pool.availableCount()).toBe(1);
    expect(w.store.getChannelForAgent('a1')).toBeUndefined();
  });

  it('an ordinary delete still says goodbye', async () => {
    const w = world();
    await w.pool.addToPool('sparebot', 'not-a-real-token');
    const leased = await w.pool.provision({ agentId: 'a1', agentName: 'Kitchen', slug: 'kitchen' });
    w.sent.length = 0;
    await w.pool.release(leased.accountId, { agentId: 'a1', reason: 'deleted' });
    expect(w.sent.some((b) => b.includes('removed'))).toBe(true);
  });
});

describe('waiting for a bot token after a failed setup (HB-0414)', () => {
  it('the sweep leaves it waiting, and does not call it FAILED', async () => {
    const w = world();
    // Parked on the token prompt with no container, its record still naming the old one.
    w.store.setAgentRuntimeRef('a1', 'mock://a1');
    w.store.setAgentPendingAction('a1', { type: 'bot_token', instructions: 'Make a bot' });
    await reconcileAgents(w.store, new Map([['mock', w.provider]]) as never, () => false);
    const a = w.store.getAgent('a1')!;
    expect(a.state).toBe('PROVISIONING');
    expect(a.pendingAction?.type).toBe('bot_token');
  });

  it('with nothing it is waiting for, a missing runtime is still FAILED', async () => {
    const w = world();
    w.store.setAgentRuntimeRef('a1', 'mock://a1');
    await reconcileAgents(w.store, new Map([['mock', w.provider]]) as never, () => false);
    expect(w.store.getAgent('a1')!.state).toBe('FAILED');
  });

  it('a pasted token survives the rollback, and the Retry uses it without asking again', async () => {
    const w = world({ failOn: 'start' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { username: 'pastedbot' } })));
    await w.manual.submitToken('a1', '123456:not-a-real-token');
    const failed = await runProvisionSteps(w.deps as never, 'a1');
    expect(failed.agent.state).toBe('FAILED');
    expect(w.store.getChannelForAgent('a1')).toBeUndefined();
    expect(w.manual.hasPending('a1')).toBe(true);
    const healthy = new MockProvider();
    const retried = await runProvisionSteps({ ...w.deps, provider: healthy } as never, 'a1');
    expect(retried.setupRequired).toBeUndefined();
    expect(retried.agent.state).toBe('RUNNING');
    expect(w.store.getChannelForAgent('a1')?.accountId).toBe('pastedbot');
    expect(await w.secrets.get('telegram/bot/pastedbot')).toBe('123456:not-a-real-token');
  });

  it('any other release of a pasted bot still drops our copy of its token', async () => {
    const w = world();
    await w.secrets.put('telegram/bot/pastedbot', '123456:not-a-real-token');
    await w.manual.release('pastedbot', { reason: 'deleted', agentId: 'a1' });
    await expect(w.secrets.get('telegram/bot/pastedbot')).rejects.toThrow();
    expect(w.manual.hasPending('a1')).toBe(false);
  });
});

describe('Retry keeps the "comes back web-only" promise (HB-0415)', () => {
  async function routed(deps: { noBot: boolean }) {
    const store = new Store(new Database(':memory:'));
    const secrets = new MemSecrets();
    await secrets.put('ai/p1', 'not-a-real-key');
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' } as never);
    const provider = new MockProvider();
    const channel = {
      kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 },
      provision: async () => { if (deps.noBot) throw new ChannelSetupRequired('Make a bot', 'x'); return { accountId: 'bot', secretRef: 'pool/bot', deepLink: 'https://t.me/bot' }; },
      release: async () => {},
    };
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel } as never);
    return { store, f };
  }
  const H = { 'x-hatchabot-owner': OWNER };
  const seed = (store: Store, id: string, promise: boolean) => {
    store.insertAgent({ id, ownerId: OWNER, name: 'Kitchen', slug: id, state: 'FAILED', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    if (promise) store.setAgentWebOnlyIfNoBot(id, true);
  };

  it('a restored or cloned agent with no bot free goes on web-only at the Retry, not on a token prompt', async () => {
    const { store, f } = await routed({ noBot: true });
    seed(store, 'retry-a', true);
    const r = await f.inject({ method: 'POST', url: '/v1/agents/retry-a/provision', headers: H, payload: {} });
    expect(r.statusCode).toBe(202);
    await vi.waitFor(() => expect(store.getAgent('retry-a')!.state).toBe('RUNNING'), { timeout: 4000, interval: 20 });
    expect(store.getAgent('retry-a')!.webOnly).toBe(true);
    expect(store.getAgent('retry-a')!.pendingAction).toBeUndefined();
    // Promise kept: it is over once it runs.
    expect(store.getAgent('retry-a')!.webOnlyIfNoBot).toBeFalsy();
  });

  it('an agent never promised that still waits for a token', async () => {
    const { store, f } = await routed({ noBot: true });
    seed(store, 'retry-b', false);
    await f.inject({ method: 'POST', url: '/v1/agents/retry-b/provision', headers: H, payload: {} });
    await vi.waitFor(() => expect(store.getAgent('retry-b')!.pendingAction?.type).toBe('bot_token'), { timeout: 4000, interval: 20 });
    expect(store.getAgent('retry-b')!.webOnly).toBeFalsy();
  });
});
