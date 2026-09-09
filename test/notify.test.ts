import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { notifyAgentChat } from '../src/channels/notify.js';
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
  store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Mom Finances', slug: 'mom', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
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
      return { ok: true } as Response;
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
