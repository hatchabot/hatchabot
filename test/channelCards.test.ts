import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { urlHost } from './helpers/urlHost.js';
import { SecretNotFoundError } from '../src/secrets/secretStore.js';

/**
 * An agent's channel cards (GET /v1/agents/:id/channels): what each card
 * says about its bot. Telegram answers getMe from a fake; nothing leaves the
 * process. Every token here is made up and shaped like none.
 */

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };

class MemSecrets {
  map = new Map<string, string>();
  /** Refs whose read fails as a store that did not answer, the token there all the same. */
  failing = new Set<string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) {
    if (this.failing.has(r)) throw new Error('made-up read failure');
    const v = this.map.get(r); if (v === undefined) throw new SecretNotFoundError(r); return v;
  }
  async delete(r: string) { this.map.delete(r); }
}

/** Each bot's display name, by token, as Telegram's getMe answers it. */
const tgNames = new Map<string, string>();
/** What getMe answers for a token instead, when set: its status and raw body. */
const tgAnswers = new Map<string, { status: number; body: string }>();
let getMes = 0;
afterEach(() => { vi.restoreAllMocks(); tgNames.clear(); tgAnswers.clear(); getMes = 0; });

async function world(pool: Record<string, unknown> = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (urlHost(input as string) !== 'api.telegram.org') return new Response('{}', { status: 404 });
    const token = /\/bot([^/]+)\/getMe/.exec(String(input))?.[1] ?? '';
    getMes++;
    const given = tgAnswers.get(token);
    if (given) return new Response(given.body, { status: given.status });
    return new Response(JSON.stringify({ ok: true, result: { first_name: tgNames.get(token) ?? 'Fresh Bot', can_join_groups: true, can_read_all_group_messages: true } }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Meal Planner', slug: 'meal', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://a1',
    persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now',
  } as never);
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: secrets as never, providers: new Map([['mock', new MockProvider()]]),
    channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0, ...pool } } as never,
  } as never);
  const telegram = async (accountId: string, token: string) => {
    const ref = `telegram/bot/${accountId}`;
    await secrets.put(ref, token);
    store.insertChannel({ id: `c-${accountId}`, agentId: 'a1', kind: 'telegram', accountId, secretRef: ref, deepLink: `https://t.me/${accountId}`, createdAt: 'now' });
  };
  const card = async (kind: string) => {
    const r = await f.inject({ method: 'GET', url: '/v1/agents/a1/channels', headers: H });
    expect(r.statusCode, r.body).toBe(200);
    return (r.json().channels as Array<Record<string, unknown>>).find((c) => c.kind === kind)!;
  };
  return { store, secrets, f, telegram, card };
}

describe('the Telegram card\'s file limit (HB-1036)', () => {
  it('says the agent\'s own cap, not Telegram\'s 50 MB', async () => {
    const w = await world();
    try {
      await w.telegram('mealplannerbot', 'tok-meal');
      w.store.setAgentFilesMaxMb('a1', 5);
      expect((await w.card('telegram')).filesMb).toBe(5);
      w.store.setAgentFilesMaxMb('a1', null);
      expect((await w.card('telegram')).filesMb).toBe(50);
    } finally { await w.f.close(); }
  });
});

describe('a bot rename still queued, on its card (HB-1040)', () => {
  const retryAt = '2099-01-01T00:40:00.000Z';

  it('a Discord or Slack bot\'s queued name and when it is tried again', async () => {
    const w = await world();
    try {
      w.store.insertChannel({
        id: 'c-d', agentId: 'a1', kind: 'discord', accountId: '1234567890123456789', secretRef: 'channel/a1/discord', deepLink: 'https://x', createdAt: 'now',
        settings: { botName: 'Old Name', pendingName: { name: 'Meal Planner', retryAt } },
      });
      expect((await w.card('discord')).pendingName).toEqual({ name: 'Meal Planner', retryAt });
      // Nothing queued: nothing said.
      w.store.setChannelSettings('a1', 'discord', { botName: 'Meal Planner' });
      expect((await w.card('discord')).pendingName).toBeUndefined();
    } finally { await w.f.close(); }
  });

  it('a Telegram pool bot\'s queued name, from the pool', async () => {
    const w = await world({ owns: () => true, pendingName: (u: string) => (u === 'mealplannerbot' ? { name: 'Meal Planner', retryAt } : undefined) });
    try {
      await w.telegram('mealplannerbot', 'tok-meal');
      expect((await w.card('telegram')).pendingName).toEqual({ name: 'Meal Planner', retryAt });
    } finally { await w.f.close(); }
  });
});

describe('the Telegram card after its bot is changed (HB-1044)', () => {
  it('names the new bot at once, not the old one for ten minutes', async () => {
    const w = await world();
    try {
      tgNames.set('tok-meal', 'Meal Planner');
      tgNames.set('tok-budget', 'Budget Bot');
      await w.telegram('mealplannerbot', 'tok-meal');
      expect((await w.card('telegram')).botName).toBe('Meal Planner');
      // Change bot replaces the row with the new bot's, as a swap does.
      await w.secrets.put('telegram/bot/budgetbot', 'tok-budget');
      w.store.replaceChannelRow('a1', 'telegram', {
        id: 'c-new', agentId: 'a1', kind: 'telegram', accountId: 'budgetbot', secretRef: 'telegram/bot/budgetbot',
        deepLink: 'https://t.me/budgetbot', createdAt: 'now',
      } as never);
      const after = await w.card('telegram');
      expect(after.accountId).toBe('budgetbot');
      expect(after.botName).toBe('Budget Bot');
      // The new bot's name is cached in its turn.
      const asked = getMes;
      expect((await w.card('telegram')).botName).toBe('Budget Bot');
      expect(getMes).toBe(asked);
    } finally { await w.f.close(); }
  });
});

describe('Re-check on a Telegram card while Telegram is not answering properly (HB-1038)', () => {
  const recheck = (w: Awaited<ReturnType<typeof world>>) => w.f.inject({ method: 'POST', url: '/v1/agents/a1/channels/telegram/recheck', headers: H });

  it('an outage page or a rate limit is "try again", not a refused token', async () => {
    const w = await world();
    try {
      await w.telegram('mealplannerbot', 'tok-meal');
      for (const answer of [
        { status: 503, body: '<html>Service Unavailable</html>' },
        { status: 502, body: 'Bad Gateway' },
        { status: 429, body: JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } }) },
        { status: 500, body: JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }) },
        // JSON, but null: read as "not a bot", not a 500 (HB-1260 review).
        { status: 200, body: 'null' },
      ]) {
        tgAnswers.set('tok-meal', answer);
        const r = await recheck(w);
        expect(r.statusCode, `${answer.status}: ${r.body}`).toBe(502);
        expect(r.json().error).not.toMatch(/refused|fresh token/i);
        expect(r.json().error).toMatch(/try again/i);
      }
      // Nothing written from a check that did not happen.
      expect(w.store.getChannelForAgent('a1')?.settings?.checkedAt).toBeUndefined();
    } finally { await w.f.close(); }
  });

  it('Telegram\'s own "no" is still a refused token, and a good answer is still a check', async () => {
    const w = await world();
    try {
      await w.telegram('mealplannerbot', 'tok-meal');
      tgAnswers.set('tok-meal', { status: 401, body: JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }) });
      const refused = await recheck(w);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toMatch(/fresh token from @BotFather/);
      tgAnswers.delete('tok-meal');
      tgNames.set('tok-meal', 'Meal Planner');
      const ok = await recheck(w);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ botName: 'Meal Planner', warnings: [] });
    } finally { await w.f.close(); }
  });
});

describe('Re-check on a parked pool bot while Telegram is not answering properly (HB-1260)', () => {
  const spare = { username: 'sparebot', secretRef: 'telegram/bot/sparebot', ownerId: OWNER };
  const recheck = (w: Awaited<ReturnType<typeof world>>) => w.f.inject({ method: 'POST', url: '/v1/pool/sparebot/recheck', headers: H });

  it('an outage page or a rate limit is "try again", never "delete it"', async () => {
    const w = await world({ list: () => [spare] });
    try {
      await w.secrets.put(spare.secretRef, 'tok-spare');
      for (const answer of [
        { status: 503, body: '<html>Service Unavailable</html>' },
        { status: 502, body: 'Bad Gateway' },
        { status: 429, body: JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } }) },
        { status: 500, body: JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }) },
        { status: 200, body: 'not json' },
        // JSON, but null: read as "not a bot", not a 500 (HB-1260 review).
        { status: 200, body: 'null' },
        { status: 502, body: 'null' },
      ]) {
        tgAnswers.set('tok-spare', answer);
        const r = await recheck(w);
        expect(r.statusCode, `${answer.status}: ${r.body}`).toBe(502);
        expect(r.json().error).toMatch(/not checked\. Try again/);
        expect(r.body).not.toMatch(/refused|Delete it/i);
      }
    } finally { await w.f.close(); }
  });

  it('Telegram\'s own "no" (401, or 404 for a token it does not know) is still a refused token', async () => {
    const w = await world({ list: () => [spare] });
    try {
      await w.secrets.put(spare.secretRef, 'tok-spare');
      for (const status of [401, 404]) {
        tgAnswers.set('tok-spare', { status, body: JSON.stringify({ ok: false, error_code: status, description: status === 401 ? 'Unauthorized' : 'Not Found' }) });
        const r = await recheck(w);
        expect(r.statusCode, r.body).toBe(200);
        expect(r.json()).toMatchObject({ username: 'sparebot', alive: false, warnings: [expect.stringMatching(/Telegram refused this token.*Delete it here/)] });
      }
      tgAnswers.delete('tok-spare');
      tgNames.set('tok-spare', 'Spare');
      expect((await recheck(w)).json()).toMatchObject({ alive: true, botName: 'Spare', warnings: [] });
    } finally { await w.f.close(); }
  });
});

describe('the bot inventory while Telegram is not answering properly (HB-1261)', () => {
  const inventory = async (w: Awaited<ReturnType<typeof world>>) => {
    const r = await w.f.inject({ method: 'GET', url: '/v1/bot-inventory', headers: H });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().bots as Array<{ username: string; alive?: boolean; displayName?: string }>;
  };

  it('a rate limit or an outage is unknown for each bot, not dead; Telegram\'s own "no" is dead; a bot that answers is alive', async () => {
    const spare = { username: 'sparebot', secretRef: 'telegram/bot/sparebot', ownerId: OWNER };
    const w = await world({ list: () => [spare] });
    try {
      await w.telegram('mealplannerbot', 'tok-meal');
      await w.secrets.put(spare.secretRef, 'tok-spare');
      for (const answer of [
        { status: 429, body: JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } }) },
        { status: 502, body: '<html>Bad Gateway</html>' },
        { status: 500, body: JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }) },
      ]) {
        tgAnswers.set('tok-meal', answer);
        tgAnswers.set('tok-spare', answer);
        const bots = await inventory(w);
        expect(bots.map((b) => [b.username, b.alive]), String(answer.status)).toEqual([['mealplannerbot', undefined], ['sparebot', undefined]]);
      }
      tgAnswers.set('tok-spare', { status: 401, body: JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }) });
      tgAnswers.delete('tok-meal');
      tgNames.set('tok-meal', 'Meal Planner');
      const bots = await inventory(w);
      expect(bots.map((b) => [b.username, b.alive, b.displayName])).toEqual([['mealplannerbot', true, 'Meal Planner'], ['sparebot', false, undefined]]);
    } finally { await w.f.close(); }
  });

  it('a bot whose token this server no longer has is said so, not taken for one Telegram rejects, and Telegram is not asked (HB-1384)', async () => {
    const spare = { username: 'sparebot', secretRef: 'telegram/bot/sparebot', ownerId: OWNER };
    const w = await world({ list: () => [spare] });
    try {
      await w.telegram('mealplannerbot', 'tok-meal');
      w.secrets.map.delete('telegram/bot/mealplannerbot');
      const bots = await inventory(w) as Array<{ username: string; alive?: boolean; tokenMissing?: boolean; where: string }>;
      expect(bots.map((b) => [b.username, b.where, b.alive, b.tokenMissing])).toEqual([['mealplannerbot', 'agent', undefined, true], ['sparebot', 'pool-free', undefined, true]]);
      expect(getMes).toBe(0);
      // One with its token is judged as before, and carries no such mark.
      await w.secrets.put(spare.secretRef, 'tok-spare');
      tgNames.set('tok-spare', 'Spare');
      const again = await inventory(w) as Array<{ username: string; alive?: boolean; tokenMissing?: boolean }>;
      expect(again.find((b) => b.username === 'sparebot')).toMatchObject({ alive: true });
      expect(again.find((b) => b.username === 'sparebot')).not.toHaveProperty('tokenMissing');
      // A read that failed is not a token gone: said as such, with nothing offered that would scrub it (HB-1384 review).
      w.secrets.failing.add(spare.secretRef);
      const asked = getMes;
      const unread = await inventory(w) as Array<{ username: string; alive?: boolean; tokenMissing?: boolean; tokenUnreadable?: boolean }>;
      expect(getMes).toBe(asked);
      const s = unread.find((b) => b.username === 'sparebot');
      expect(s).toMatchObject({ tokenUnreadable: true });
      expect(s).not.toHaveProperty('tokenMissing');
      expect(s?.alive).toBeUndefined();
    } finally { await w.f.close(); }
  });
});
