import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { notifyAgentChat, ownerChatRoutes, tellOwner } from '../src/channels/notify.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

function seed() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Household Finances', slug: 'finances', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
  store.insertChannel({ id: 'ch1', agentId: 'a1', kind: 'telegram', accountId: 'mombot', secretRef: 'channel/a1', deepLink: 'https://t.me/mombot', createdAt: 'now' } as any);
  return store;
}

describe('notifyAgentChat', () => {
  it('posts the text to Telegram via the agent bot, to the given chat ids', async () => {
    const store = seed();
    const secrets = new MemSecrets();
    await secrets.put('channel/a1', 'BOTTOKEN123');
    const calls: Array<{ url: string; body: any }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    const sent = await notifyAgentChat(store, secrets, 'a1', 'hello', { chatIds: ['555'], fetchImpl });
    expect(sent).toBe(1);
    expect(calls[0]!.url).toContain('/botBOTTOKEN123/sendMessage');
    expect(calls[0]!.body).toMatchObject({ chat_id: '555', text: 'hello' });
  });

  it('is a no-op (0 sent) when the agent has no bot, and never throws', async () => {
    const store = seed();
    const secrets = new MemSecrets();
    // no channel token stored, and a non-existent agent
    expect(await notifyAgentChat(store, secrets, 'nope', 'x', { fetchImpl: (async () => ({}) as Response) as any })).toBe(0);
  });

  it('rejects non-numeric chat ids (no send)', async () => {
    const store = seed();
    const secrets = new MemSecrets();
    await secrets.put('channel/a1', 'T');
    let hits = 0;
    const fetchImpl = (async () => { hits++; return {} as Response; }) as unknown as typeof fetch;
    const sent = await notifyAgentChat(store, secrets, 'a1', 'x', { chatIds: ['not-a-number', '$(evil)'], fetchImpl });
    expect(sent).toBe(0);
    expect(hits).toBe(0);
  });
});

describe('tellOwner: budgets, spikes and loops reach the owner by whatever path exists (HB-0403)', () => {
  const OWNER = 'o';
  const DISCORD_ID = '1'.repeat(18), SLACK_ID = 'UFAKE0001', TG = ['55', '50', '02'].join('');
  function world() {
    const store = seed();
    store.insertAgent({ id: 'm1', ownerId: OWNER, name: 'Hatchabot', slug: 'hatchabot', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, ops: true, createdAt: 'now', updatedAt: 'now' } as any);
    const secrets = new MemSecrets();
    const attach = async (agentId: string, kind: string, id: string) => {
      store.insertChannel({ id: `ch-${agentId}-${kind}`, agentId, kind, accountId: `${agentId}${kind}`, secretRef: `channel/${agentId}/${kind}`, deepLink: 'https://example.test/x', createdAt: 'now' } as any);
      await secrets.put(`channel/${agentId}/${kind}`, `fake-${agentId}-${kind}`);
      store.insertMembership({ id: `mem-${agentId}-${kind}`, agentId, userId: OWNER, role: 'owner', status: 'active', joinedAt: 'now' } as any);
      expect(store.bindMemberIdentity(agentId, OWNER, kind as never, id)).toBe(true);
    };
    const dms: Array<{ kind: string; secret: string; to: string; text: string }> = [];
    const tg: Array<{ url: string; chat: string }> = [];
    let tgOk = true, dmOk = true;
    const deps = {
      store, secrets,
      dmFor: (kind: 'discord' | 'slack') => async (secret: string, to: string, text: string) => { dms.push({ kind, secret, to, text }); return dmOk; },
      fetchImpl: (async (url: string, init: any) => {
        tg.push({ url, chat: JSON.parse(init.body).chat_id });
        return { ok: tgOk, json: async () => ({ ok: tgOk }) };
      }) as unknown as typeof fetch,
    };
    return { store, secrets, attach, dms, tg, deps, setTg: (v: boolean) => { tgOk = v; }, setDm: (v: boolean) => { dmOk = v; } };
  }

  it('an owner whose manager is on Discord hears by a Discord DM from it', async () => {
    const w = world();
    await w.attach('m1', 'discord', DISCORD_ID);
    expect(await tellOwner(w.deps, OWNER, 'a1', 'spent')).toBe(true);
    expect(w.dms).toHaveLength(1);
    expect(w.dms[0]).toMatchObject({ kind: 'discord', to: DISCORD_ID, text: 'spent' });
    expect(w.dms[0]!.secret).toBe('fake-m1-discord');
    expect(w.tg).toEqual([]);
  });

  it('a Telegram route still comes first, and one that fails falls through to Discord', async () => {
    const w = world();
    await w.attach('m1', 'discord', DISCORD_ID);
    w.store.setAccountTelegram(OWNER, TG);
    await w.secrets.put('channel/m1/telegram', 'tok');
    w.store.insertChannel({ id: 'ch-m-tg', agentId: 'm1', kind: 'telegram', accountId: 'mbot', secretRef: 'channel/m1/telegram', deepLink: 'https://t.me/mbot', createdAt: 'now' } as any);
    expect(ownerChatRoutes(w.deps, OWNER).map((r) => r.kind)).toEqual(['telegram', 'discord']);
    expect(await tellOwner(w.deps, OWNER, 'm1', 'spent')).toBe(true);
    expect(w.tg).toHaveLength(1);
    expect(w.dms).toEqual([]);
    w.setTg(false);
    expect(await tellOwner(w.deps, OWNER, 'm1', 'spent')).toBe(true);
    expect(w.dms).toHaveLength(1);
  });

  it('with no manager route, the busy agent\'s own Discord or Slack bot', async () => {
    const w2 = world();
    w2.store.insertAgent({ id: 'b1', ownerId: OWNER, name: 'Garden Notes', slug: 'garden', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    await w2.attach('b1', 'slack', SLACK_ID);
    expect(ownerChatRoutes(w2.deps, OWNER)).toEqual([]);
    expect(ownerChatRoutes(w2.deps, OWNER, 'b1').map((r) => `${r.via}:${r.kind}`)).toEqual(['b1:slack']);
    expect(await tellOwner(w2.deps, OWNER, 'b1', 'loop')).toBe(true);
    expect(w2.dms[0]).toMatchObject({ kind: 'slack', to: SLACK_ID });
  });

  it('a path that exists but cannot send is not "told"; none at all is false without trying', async () => {
    const w = world();
    expect(ownerChatRoutes(w.deps, OWNER, 'a1')).toEqual([]);
    expect(await tellOwner(w.deps, OWNER, 'a1', 'x')).toBe(false);
    await w.attach('m1', 'discord', DISCORD_ID);
    w.setDm(false);
    expect(await tellOwner(w.deps, OWNER, 'a1', 'x')).toBe(false);
    // A connector with no way to DM is no route.
    expect(ownerChatRoutes({ ...w.deps, dmFor: () => undefined }, OWNER)).toEqual([]);
  });
});
