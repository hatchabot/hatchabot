import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TelegramPoolProvisioner, PoolExhaustedError } from '../src/channels/telegramPool.js';
import { CompositeTelegramProvisioner } from '../src/channels/composite.js';
import { ChannelSetupRequired } from '../src/channels/channel.js';
import type { TelegramManualProvisioner } from '../src/channels/telegramManual.js';
import { verifyBotToken, InvalidBotTokenError } from '../src/channels/telegramManual.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/** Leasing renames the bot via Telegram (setMyName) — keep tests offline. */
const stubFetch = (async () => new Response('{"ok":true}')) as unknown as typeof fetch;

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error(`no secret ${ref}`);
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

const REQ = { agentId: 'a1', agentName: 'Kitchen', slug: 'kitchen' };

describe('verifyBotToken', () => {
  const ok = (username: string): typeof fetch =>
    (async () => new Response(JSON.stringify({ ok: true, result: { username } }),
      { headers: { 'content-type': 'application/json' } })) as any;

  it('returns the bot username on a good token', async () => {
    expect(await verifyBotToken('123:abc', ok('kitchenbot'))).toBe('kitchenbot');
  });

  it('treats a non-JSON response (outage/proxy page) as invalid, not a crash', async () => {
    // Telegram down → an HTML error page; res.json() throws a raw TypeError
    // that used to surface as an opaque 500. Must become a friendly error.
    const htmlPage: typeof fetch = (async () =>
      new Response('<html>502 Bad Gateway</html>', { headers: { 'content-type': 'text/html' } })) as any;
    await expect(verifyBotToken('123:abc', htmlPage)).rejects.toBeInstanceOf(InvalidBotTokenError);
  });

  it('rejects a token Telegram says no to', async () => {
    const rejected: typeof fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }),
        { headers: { 'content-type': 'application/json' } })) as any;
    await expect(verifyBotToken('123:abc', rejected)).rejects.toBeInstanceOf(InvalidBotTokenError);
  });
});

describe('TelegramPoolProvisioner', () => {
  it("renames the bot to the agent it now serves on lease (display name via setMyName)", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const recorder = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch;
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl: recorder });
    await pool.addToPool('recycledbot', 'tok-r');
    await pool.provision({ agentId: 'a1', agentName: 'Art Test', slug: 'art-test' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/bottok-r/setMyName');
    expect(JSON.parse(calls[0]!.body)).toEqual({ name: 'Art Test' });
    // The idempotent re-lease does NOT rename again (nothing changed).
    await pool.provision({ agentId: 'a1', agentName: 'Art Test', slug: 'art-test' });
    expect(calls).toHaveLength(1);
  });

  it('a rename failure never blocks the lease (cosmetic, best-effort)', async () => {
    const failing = (async () => { throw new Error('telegram down'); }) as unknown as typeof fetch;
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl: failing });
    await pool.addToPool('bot1', 'tok1');
    const leased = await pool.provision(REQ);
    expect(leased.accountId).toBe('bot1'); // lease succeeded despite the outage
  });

  it('never leases another user\'s bot — own first, then shared house bots', async () => {
    // A bot token belongs to whoever minted it at BotFather (they can revoke
    // it any time) — so user B's create must not consume user A's parked bot.
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl: stubFetch });
    await pool.addToPool('alices-bot', 'tok-a', 'user-alice');
    await pool.addToPool('house-bot', 'tok-h', null); // explicitly shared

    // Bob sees only the house bot — Alice's is invisible to him.
    expect(pool.availableCount('user-bob')).toBe(1);
    const bob = await pool.provision({ agentId: 'b1', agentName: 'B', slug: 'b', ownerId: 'user-bob' });
    expect(bob.accountId).toBe('house-bot');

    // Alice leases her own; with none left, exhaustion — never Bob's lease.
    const alice = await pool.provision({ agentId: 'a1', agentName: 'A', slug: 'a', ownerId: 'user-alice' });
    expect(alice.accountId).toBe('alices-bot');
    await expect(
      pool.provision({ agentId: 'a2', agentName: 'A2', slug: 'a2', ownerId: 'user-alice' }),
    ).rejects.toBeInstanceOf(PoolExhaustedError);
  });

  it('prefers a user\'s own bot over shared house stock', async () => {
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl: stubFetch });
    await pool.addToPool('house-bot', 'tok-h', null);
    await pool.addToPool('mine-bot', 'tok-m', 'user-alice');
    const leased = await pool.provision({ agentId: 'a1', agentName: 'A', slug: 'a', ownerId: 'user-alice' });
    expect(leased.accountId).toBe('mine-bot'); // house stock preserved for others
  });

  it('leases idempotently per agent and counts availability', async () => {
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl: stubFetch });
    await pool.addToPool('bot1', 'tok1');
    expect(pool.availableCount()).toBe(1);
    const first = await pool.provision(REQ);
    const again = await pool.provision(REQ); // retry finds the same lease
    expect(first.accountId).toBe('bot1');
    expect(again.accountId).toBe('bot1');
    expect(pool.availableCount()).toBe(0);
  });

  it('release returns the bot with its token intact for the next agent', async () => {
    const secrets = new MemSecrets();
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), secrets, { fetchImpl: stubFetch });
    await pool.addToPool('bot1', 'tok1');
    const leased = await pool.provision(REQ);
    await pool.release(leased.accountId);
    expect(pool.availableCount()).toBe(1);
    expect(await secrets.get(leased.secretRef)).toBe('tok1'); // token kept
    const next = await pool.provision({ ...REQ, agentId: 'a2' });
    expect(next.accountId).toBe('bot1');
  });

  it('throws PoolExhaustedError when empty', async () => {
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl: stubFetch });
    await expect(pool.provision(REQ)).rejects.toBeInstanceOf(PoolExhaustedError);
  });
});

describe('CompositeTelegramProvisioner', () => {
  const manualStub = (released: string[]) =>
    ({
      kind: 'telegram',
      key: 'manual',
      async provision(req: any) {
        throw new ChannelSetupRequired('paste a token', req.agentId);
      },
      async release(accountId: string) { released.push(accountId); },
      async submitToken() { return { username: 'userbot' }; },
      hasPending() { return false; },
    }) as unknown as TelegramManualProvisioner;

  it('falls back to manual (ChannelSetupRequired) when the pool is dry', async () => {
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl: stubFetch });
    const composite = new CompositeTelegramProvisioner(pool, manualStub([]));
    await expect(composite.provision(REQ)).rejects.toBeInstanceOf(ChannelSetupRequired);
  });

  it('routes release by ownership: pool bots repooled, user bots to manual', async () => {
    const secrets = new MemSecrets();
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), secrets, { fetchImpl: stubFetch });
    await pool.addToPool('poolbot', 'tok');
    const manualReleased: string[] = [];
    const composite = new CompositeTelegramProvisioner(pool, manualStub(manualReleased));

    await composite.provision(REQ); // leases poolbot
    await composite.release('poolbot');
    expect(pool.availableCount()).toBe(1); // back in the pool
    expect(manualReleased).toEqual([]);

    await composite.release('someusersbot');
    expect(manualReleased).toEqual(['someusersbot']);
  });
});
