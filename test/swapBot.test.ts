import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';

/**
 * Moving an agent to a different bot. The agent survives whole; the Telegram
 * conversation cannot, because scrollback belongs to the bot and a bot cannot
 * message someone who has never opened a chat with it. So the order matters:
 * take the new identity, tell everyone on the OLD bot, and only then let go.
 */
const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };

let n = 0;
async function world(opts: { spare?: boolean } = {}) {
  const id = `a${++n}`;
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
  const { runtimeRef } = await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
  store.insertAgent({
    id, ownerId: OWNER, name: 'October Agent', slug: 'october', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
  } as never);
  store.insertChannel({ id: 'c1', agentId: id, kind: 'telegram', accountId: 'oldbot', secretRef: 'chan/old', deepLink: 'https://t.me/oldbot', createdAt: 'now' } as never);
  store.insertMembership({ id: 'm0', agentId: id, userId: OWNER, role: 'owner', status: 'active' } as never);
  store.bindMembershipChannelUser(id, OWNER, '111');
  store.insertMembership({ id: 'm1', agentId: id, userId: 'user-maria', role: 'user', status: 'active', displayName: 'Maria' } as never);
  store.bindMembershipChannelUser(id, 'user-maria', '555');

  const told: string[] = [];
  const released: string[] = [];
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: { put: async () => {}, get: async () => 'tok', delete: async () => {} } as never,
    providers: new Map([['mock', provider]]),
    channel: {
      kind: 'telegram',
      pool: { owns: () => true, availableCount: () => (opts.spare === false ? 0 : 2), list: () => [] },
      provision: async () => ({ accountId: 'newbot', secretRef: 'pool/newbot', deepLink: 'https://t.me/newbot' }),
      release: async (id: string) => { released.push(id); },
    } as never,
  } as never);
  const origExec = provider.exec.bind(provider);
  provider.exec = (async (ref: string, argv: string[]) => {
    if (argv[0] === 'message') told.push(argv.join(' '));
    return origExec(ref, argv);
  }) as never;
  return { store, f, told, released, id };
}

describe('changing an agent’s bot', () => {
  it('names the new bot in the farewell, then releases the old one and swaps the row', async () => {
    const { store, f, told, released, id } = await world();
    const res = await f.inject({ method: 'POST', url: `/v1/agents/${id}/channel/swap`, headers: H, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ swapped: true, from: 'oldbot', to: 'newbot' });

    // Everyone was told, on the bot that still worked, and told where to go.
    expect(told.join(' ')).toContain('@newbot');
    expect(told.filter((t) => t.includes('--target 111') || t.includes('--target 555')).length).toBe(2); // owner + Maria

    expect(released).toContain('oldbot');
    const chan = store.getChannelForAgent(id, 'telegram')!;
    expect(chan.accountId).toBe('newbot');
    expect(chan.deepLink).toBe('https://t.me/newbot');

    // What must survive, survives: members keep their identities, so nobody pairs again.
    expect(store.listAllowedChannelUserIds(id).sort()).toEqual(['111', '555']);
  });

  it('refuses when there is no spare bot, and changes nothing', async () => {
    const { store, f, released, id } = await world({ spare: false });
    const res = await f.inject({ method: 'POST', url: `/v1/agents/${id}/channel/swap`, headers: H, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/spare bot/i);
    expect(released).toEqual([]);
    expect(store.getChannelForAgent(id, 'telegram')!.accountId).toBe('oldbot');
  });

  it('is owner-scoped', async () => {
    const { f, id } = await world();
    const res = await f.inject({ method: 'POST', url: `/v1/agents/${id}/channel/swap`, headers: { 'x-hatchabot-owner': 'someone-else' }, payload: {} });
    expect(res.statusCode).toBe(404);
  });
});
