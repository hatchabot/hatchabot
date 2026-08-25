/**
 * The bot pool as a first-class UI feature: stocking it from the app,
 * removing from it, and the delete-time recycle that parks a hand-pasted
 * bot's token instead of forgetting it (the Telegram bot ceiling makes every
 * recycled slot count).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompositeTelegramProvisioner } from '../src/channels/composite.js';
import { makeWorld, seedRunningAgent, as } from './support/world.js';

/** verifyBotToken hits api.telegram.org — fake Telegram's getMe. */
function fakeTelegram(username: string | undefined) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify(
        username
          ? { ok: true, result: { username } }
          : { ok: false, description: 'Unauthorized' },
      ),
      { status: username ? 200 : 401 },
    ),
  );
}

afterEach(() => vi.restoreAllMocks());

describe('GET /v1/pool', () => {
  it('lists the roster for the host owner, count-only for members', async () => {
    const w = await makeWorld();
    await w.channel.pool.addToPool('sparebot', 'tok-1');
    const mine = (await w.f.inject({ method: 'GET', url: '/v1/pool', headers: as() })).json();
    expect(mine.availableBots).toBe(1);
    expect(mine.bots).toEqual([{ username: 'sparebot', leasedTo: undefined }]);
    const theirs = (await w.f.inject({ method: 'GET', url: '/v1/pool', headers: as('someone-else') })).json();
    expect(theirs.availableBots).toBe(1);
    expect(theirs.bots).toBeUndefined(); // roster is host-owner detail
  });
});

describe('POST /v1/pool', () => {
  it('verifies the token with Telegram and stocks the pool', async () => {
    const w = await makeWorld();
    fakeTelegram('freshbot');
    const res = await w.f.inject({ method: 'POST', url: '/v1/pool', headers: as(), payload: { token: '1:AA' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ username: 'freshbot', availableBots: 1 });
    expect(w.channel.pool.entries[0]).toMatchObject({ username: 'freshbot', token: '1:AA' });
  });

  it('rejects a bad token (400) and a bot already wired to an agent (409)', async () => {
    const w = await makeWorld();
    fakeTelegram(undefined);
    expect((await w.f.inject({ method: 'POST', url: '/v1/pool', headers: as(), payload: { token: 'bad' } })).statusCode).toBe(400);
    vi.restoreAllMocks();

    await seedRunningAgent(w, { accountId: 'kitchenbot' });
    fakeTelegram('kitchenbot');
    const dupe = await w.f.inject({ method: 'POST', url: '/v1/pool', headers: as(), payload: { token: '2:BB' } });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error).toMatch(/live identity/);
  });

  it('is host-owner only', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'POST', url: '/v1/pool', headers: as('intruder'), payload: { token: 'x' } })).statusCode).toBe(403);
  });
});

describe('DELETE /v1/pool/:username', () => {
  it('removes an available bot; refuses a leased one and an unknown one', async () => {
    const w = await makeWorld();
    await w.channel.pool.addToPool('sparebot', 'tok-1');
    await w.channel.pool.addToPool('busybot', 'tok-2');
    w.channel.pool.entries.find((e: any) => e.username === 'busybot').leasedTo = 'a9';

    expect((await w.f.inject({ method: 'DELETE', url: '/v1/pool/sparebot', headers: as() })).statusCode).toBe(200);
    expect(w.channel.pool.owns('sparebot')).toBe(false);
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/pool/busybot', headers: as() })).statusCode).toBe(409);
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/pool/ghost', headers: as() })).statusCode).toBe(409);
  });
});

describe('media key — GET/PUT/DELETE /v1/media-key', () => {
  it('is write-only, host-owner-gated, and round-trips set/unset', async () => {
    const w = await makeWorld();
    expect((await w.f.inject({ method: 'GET', url: '/v1/media-key', headers: as() })).json()).toEqual({ set: false });
    expect((await w.f.inject({ method: 'PUT', url: '/v1/media-key', headers: as(), payload: { key: 'gm-1' } })).statusCode).toBe(200);
    expect((await w.f.inject({ method: 'GET', url: '/v1/media-key', headers: as() })).json()).toEqual({ set: true });
    expect(w.secrets.map.get('media/gemini-api-key')).toBe('gm-1');
    expect((await w.f.inject({ method: 'DELETE', url: '/v1/media-key', headers: as() })).statusCode).toBe(200);
    expect(w.secrets.map.has('media/gemini-api-key')).toBe(false);
    expect((await w.f.inject({ method: 'GET', url: '/v1/media-key', headers: as('intruder') })).statusCode).toBe(403);
  });
});

describe('skipPool — the "use a pool bot" checkbox, unchecked', () => {
  it('routes provisioning straight to the manual path even when the pool has bots', async () => {
    const chan = { accountId: 'x', secretRef: 's', deepLink: 'd' };
    const pool = { provision: vi.fn().mockResolvedValue({ ...chan, accountId: 'poolbot' }) } as any;
    const manual = { provision: vi.fn().mockResolvedValue({ ...chan, accountId: 'mintedbot' }) } as any;
    const c = new CompositeTelegramProvisioner(pool, manual);
    const req = { agentId: 'a1', agentName: 'A', slug: 'a' };

    // Default: pool first.
    expect((await c.provision(req)).accountId).toBe('poolbot');
    // Owner declined the pool: manual, and the pool is never consulted.
    pool.provision.mockClear();
    expect((await c.provision({ ...req, skipPool: true })).accountId).toBe('mintedbot');
    expect(pool.provision).not.toHaveBeenCalled();
  });
});

describe('delete-time recycle — parking the bot is the DEFAULT', () => {
  it('a plain delete parks the hand-pasted bot (token included) in the pool', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { accountId: 'kitchenbot', botToken: 'the-live-token' });
    const res = await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}`, headers: as() });
    expect(res.statusCode).toBe(200);
    expect(w.channel.pool.entries).toEqual([
      expect.objectContaining({ username: 'kitchenbot', token: 'the-live-token' }),
    ]);
  });

  it('?recycleBot=0 opts out — the token is forgotten', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { accountId: 'kitchenbot' });
    await w.f.inject({ method: 'DELETE', url: `/v1/agents/${id}?recycleBot=0`, headers: as() });
    expect(w.channel.pool.entries).toEqual([]);
  });

  it('the agent list tells the app which bots are pooled', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { accountId: 'kitchenbot' });
    const list = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as() })).json();
    expect(list[0]).toMatchObject({ botUsername: 'kitchenbot', botPooled: false });
  });
});
