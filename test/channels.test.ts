import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { TelegramPoolProvisioner, PoolExhaustedError } from '../src/channels/telegramPool.js';
import { CompositeTelegramProvisioner } from '../src/channels/composite.js';
import { ChannelSetupRequired } from '../src/channels/channel.js';
import type { TelegramManualProvisioner } from '../src/channels/telegramManual.js';
import { verifyBotToken, InvalidBotTokenError } from '../src/channels/telegramManual.js';
import { setTelegramDisplayName } from '../src/channels/telegramName.js';
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
      // getMe reports the bot still wearing its old name.
      return new Response(String(url).includes('/getMe')
        ? '{"ok":true,"result":{"first_name":"Someone Else"}}'
        : '{"ok":true}');
    }) as unknown as typeof fetch;
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl: recorder });
    await pool.addToPool('recycledbot', 'tok-r');
    await pool.provision({ agentId: 'a1', agentName: 'Art Test', slug: 'art-test' });
    const renames = calls.filter((c) => c.url.includes('setMyName'));
    expect(renames).toHaveLength(1);
    expect(renames[0]!.url).toContain('/bottok-r/setMyName');
    expect(JSON.parse(renames[0]!.body)).toEqual({ name: 'Art Test' });
    // The idempotent re-lease does NOT rename again (nothing changed).
    calls.length = 0;
    await pool.provision({ agentId: 'a1', agentName: 'Art Test', slug: 'art-test' });
    expect(calls).toHaveLength(0);
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

  it('treats usernames case-insensitively (no duplicate row for the same bot)', async () => {
    // An adopt-sourced accountId differing only in case must not create a
    // second pool row → two leases → two pollers on one token.
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl: stubFetch });
    await pool.addToPool('MyBot', 'tok');
    expect(pool.owns('mybot')).toBe(true);
    expect(pool.owns('MYBOT')).toBe(true);
    await pool.removeFromPool('MYBOT'); // remove by a different case
    expect(pool.owns('mybot')).toBe(false);
    expect(pool.availableCount()).toBe(0);
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

describe('setTelegramDisplayName', () => {
  it('sends the trimmed name, capped at Telegram\'s 64 chars', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const rec = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await setTelegramDisplayName('tok', '  Condo Adviser  ', rec)).toEqual({ ok: true });
    expect(calls[0]!.url).toContain('/bottok/setMyName');
    expect(JSON.parse(calls[0]!.body)).toEqual({ name: 'Condo Adviser' });
    await setTelegramDisplayName('tok', 'x'.repeat(200), rec);
    expect(JSON.parse(calls[1]!.body).name).toHaveLength(64);
  });

  it('reports failure instead of throwing — a rename must never break anything', async () => {
    // Telegram rate-limits setMyName, so a refusal is expected traffic.
    const limited = (async () => new Response('{"ok":false,"description":"Too Many Requests"}',
      { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    // The description matters: a silent false is what made the live failure
    // undiagnosable, so the caller gets Telegram's own words to log.
    expect(await setTelegramDisplayName('tok', 'New', limited))
      .toEqual({ ok: false, error: 'Too Many Requests', retryAfter: undefined });
    const down = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    expect((await setTelegramDisplayName('tok', 'New', down)).ok).toBe(false);
    const html = (async () => new Response('<html>502</html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    expect((await setTelegramDisplayName('tok', 'New', html)).ok).toBe(false);
    expect((await setTelegramDisplayName('tok', '   ')).ok).toBe(false); // empty → no call
  });

  it('waits out a SHORT rate limit and renames on the second try', async () => {
    // The case that plausibly cost the live bot its name: a lease renaming a
    // bot moments after the release that renamed it.
    let n = 0;
    const limiter = (async () => {
      n++;
      return n === 1
        ? new Response('{"ok":false,"description":"Too Many Requests","parameters":{"retry_after":1}}',
            { headers: { 'content-type': 'application/json' } })
        : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    expect(await setTelegramDisplayName('tok', 'New', limiter, [0, 0])).toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it('gives up on a LONG rate limit rather than blocking a lease', async () => {
    let n = 0;
    const hourLong = (async () => {
      n++;
      return new Response('{"ok":false,"description":"Too Many Requests","parameters":{"retry_after":3600}}',
        { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const res = await setTelegramDisplayName('tok', 'New', hourLong);
    expect(res).toEqual({ ok: false, error: 'Too Many Requests', retryAfter: 3600 });
    expect(n).toBe(1); // provisioning must not sit on an hour-long wait
  });
});

describe('a recycled pool bot does not keep the last agent\'s identity', () => {
  /** Records every Telegram call so we can assert on names and messages. */
  const recorder = () => {
    const calls: Array<{ method: string; body: any }> = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ method: String(url).split('/').pop()!, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  };

  it('says goodbye on release, and PARKS the idle name instead of spending a rename', async () => {
    const { calls, fetchImpl } = recorder();
    const db = new Database(':memory:');
    const pool = new TelegramPoolProvisioner(db, new MemSecrets(), { fetchImpl });
    await pool.addToPool('recycled', 'tok');
    await pool.provision({ agentId: 'a1', agentName: 'Condo Adviser', slug: 'condo' });
    // A member who has been chatting with it.
    db.prepare(`CREATE TABLE IF NOT EXISTS memberships (id TEXT, agent_id TEXT, user_id TEXT, role TEXT, channel_user_id TEXT, status TEXT)`).run();
    db.prepare(`INSERT INTO memberships VALUES ('m1','a1','u1','user','555','active')`).run();
    calls.length = 0;

    await pool.release('recycled');

    const sends = calls.filter((c) => c.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.body.chat_id).toBe('555');
    expect(sends[0]!.body.text).toMatch(/no longer applies|belongs to the old one|removed/i);
    // Telegram grants roughly ONE rename per bot per few hours (observed
    // retry_after: 11942s). An archive→restore used to spend two of them — to
    // "unassigned" and straight back — which is how a live agent's bot ended up
    // called "AgentClaw (unassigned)" for three hours. So release spends none:
    // it parks the idle name for the sweep to apply only if the bot is still
    // sitting free later.
    expect(calls.filter((c) => c.method === 'setMyName')).toHaveLength(0);
    const parked = db.prepare(`SELECT desired_name, rename_after FROM telegram_pool WHERE username='recycled'`).get() as any;
    expect(parked.desired_name).toBe(TelegramPoolProvisioner.IDLE_NAME);
    expect(Date.parse(parked.rename_after)).toBeGreaterThan(Date.now()); // deferred, not now
  });

  it('warns prior chatters when the bot comes back as a different agent', async () => {
    const { calls, fetchImpl } = recorder();
    const db = new Database(':memory:');
    const pool = new TelegramPoolProvisioner(db, new MemSecrets(), { fetchImpl });
    await pool.addToPool('recycled', 'tok');
    // Someone chatted with this bot under a PREVIOUS agent.
    db.prepare(`CREATE TABLE IF NOT EXISTS channels (id TEXT, agent_id TEXT, kind TEXT, account_id TEXT, secret_ref TEXT, deep_link TEXT, created_at TEXT)`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS memberships (id TEXT, agent_id TEXT, user_id TEXT, role TEXT, channel_user_id TEXT, status TEXT)`).run();
    db.prepare(`INSERT INTO channels VALUES ('c0','old','telegram','recycled','r','d','now')`).run();
    db.prepare(`INSERT INTO memberships VALUES ('m0','old','u0','user','777','active')`).run();

    await pool.provision({ agentId: 'a2', agentName: 'Tax Advisor', slug: 'tax' });

    const notice = calls.filter((c) => c.method === 'sendMessage');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.body.chat_id).toBe('777');
    expect(notice[0]!.body.text).toContain('Tax Advisor');
    expect(notice[0]!.body.text).toMatch(/above this line|no longer applies/i);
  });

  it('says nothing on a bot that has never served an agent', async () => {
    const { calls, fetchImpl } = recorder();
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl });
    await pool.addToPool('fresh', 'tok');
    await pool.provision({ agentId: 'a1', agentName: 'First', slug: 'first' });
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0); // nothing stale to disown
    expect(calls.filter((c) => c.method === 'setMyName').at(-1)!.body.name).toBe('First');
  });
});

describe('a mislabelled bot heals on rebuild', () => {
  it('re-applies the agent name to a pool bot, and leaves a user bot alone', async () => {
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const db = new Database(':memory:');
    const secrets = new MemSecrets();
    const pool = new TelegramPoolProvisioner(db, secrets, { fetchImpl });
    await pool.addToPool('poolbot', 'tok');
    await pool.provision({ agentId: 'a1', agentName: 'Wrong Name', slug: 'a1' });
    calls.length = 0;

    // Rebuild: the lease-time rename may have lost a race with Telegram's
    // limiter, so this is the second chance.
    const composite = new CompositeTelegramProvisioner(pool, { release: async () => {} } as any);
    await composite.syncDisplayName('poolbot', 'Right Name');
    expect(calls.filter((c) => c.url.includes('setMyName')).map((c) => c.body.name)).toEqual(['Right Name']);

    // A hand-minted bot belongs to whoever created it — never renamed here.
    calls.length = 0;
    await composite.syncDisplayName('someusersbot', 'Right Name');
    expect(calls).toHaveLength(0);
  });
});

describe('a rename that never reached Telegram is retried, then remembered', () => {
  /** Fails the first `failures` calls at the TRANSPORT layer, then succeeds. */
  const flaky = (failures: number) => {
    const state = { calls: 0 };
    const fetchImpl = (async () => {
      state.calls++;
      if (state.calls <= failures) {
        // Exactly how undici surfaces a connection failure: the reason is on
        // .cause, not the message.
        throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') });
      }
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { state, fetchImpl };
  };

  it('retries a transport failure and succeeds on a later attempt', async () => {
    const { state, fetchImpl } = flaky(2);
    expect(await setTelegramDisplayName('tok', 'Art Advisor', fetchImpl, [0, 0])).toEqual({ ok: true });
    expect(state.calls).toBe(3);
  });

  it('reports the CAUSE, not a bare "fetch failed"', async () => {
    const { fetchImpl } = flaky(99);
    const res = await setTelegramDisplayName('tok', 'Art Advisor', fetchImpl, [0, 0]);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ECONNREFUSED'); // the live log said only "fetch failed"
  });

  it('does not retry a REFUSAL — that is Telegram answering, not the network', async () => {
    let calls = 0;
    const refuses = (async () => {
      calls++;
      return new Response('{"ok":false,"description":"BOT_NAME_INVALID"}', {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    expect((await setTelegramDisplayName('tok', 'x', refuses)).ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('parks a failed rename and finishes it on the next sweep', async () => {
    // The live failure: the bot stayed "AgentClaw (unassigned)" after a restore
    // and nothing remembered it should have changed.
    // getMe + three setMyName attempts must all fail for the rename to be parked.
    const { state, fetchImpl } = flaky(4);
    const db = new Database(':memory:');
    const pool = new TelegramPoolProvisioner(db, new MemSecrets(), { fetchImpl, renameBackoffMs: [0, 0] });
    await pool.addToPool('bot', 'tok');
    await pool.provision({ agentId: 'a1', agentName: 'Art Advisor', slug: 'art' });

    // Rename lost, but not forgotten.
    const parked = db.prepare(`SELECT desired_name FROM telegram_pool WHERE username='bot'`).get() as any;
    expect(parked.desired_name).toBe('Art Advisor');

    state.calls = 99; // network is back
    // ...but the sweep waits for the deadline. Telegram answered a live rename
    // with retry_after 11942s (3h19m) and the old sweep retried every two
    // minutes regardless, which is both useless and rude.
    expect(await pool.retryPendingNames()).toBe(0);

    db.prepare(`UPDATE telegram_pool SET rename_after = ? WHERE username='bot'`)
      .run(new Date(Date.now() - 1000).toISOString()); // deadline passes
    expect(await pool.retryPendingNames()).toBe(1);
    const after = db.prepare(`SELECT desired_name FROM telegram_pool WHERE username='bot'`).get() as any;
    expect(after.desired_name).toBeNull(); // nothing left to do
    expect(await pool.retryPendingNames()).toBe(0); // and a healthy pool is free
  });
});

describe('an on-demand rename answers honestly', () => {
  it('reports the deadline rather than silently doing nothing', async () => {
    // A button that appears to work while Telegram refuses is worse than no
    // button. The quota runs to hours, so "try again later" needs a time on it.
    let calls = 0;
    const limited = (async (url: any) => {
      calls++;
      if (String(url).includes('/getMe')) {
        return new Response('{"ok":true,"result":{"first_name":"AgentClaw (unassigned)"}}',
          { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{"ok":false,"description":"Too Many Requests","parameters":{"retry_after":11942}}',
        { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const db = new Database(':memory:');
    const pool = new TelegramPoolProvisioner(db, new MemSecrets(), { fetchImpl: limited, renameBackoffMs: [0, 0] });
    await pool.addToPool('bot', 'tok');
    await pool.provision({ agentId: 'a1', agentName: 'Art Advisor', slug: 'art' });

    const pending = pool.pendingName('bot');
    expect(pending!.name).toBe('Art Advisor');
    // The deadline is Telegram's own number, not a constant of ours.
    const waitMs = Date.parse(pending!.retryAt!) - Date.now();
    expect(waitMs).toBeGreaterThan(11_000 * 1000);
    expect(waitMs).toBeLessThan(12_500 * 1000);
  });

  it('spends nothing when the bot already has the right name', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: any) => {
      calls.push(String(url).split('/').pop()!);
      return new Response('{"ok":true,"result":{"first_name":"Art Advisor"}}',
        { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const pool = new TelegramPoolProvisioner(new Database(':memory:'), new MemSecrets(), { fetchImpl });
    await pool.addToPool('bot', 'tok');
    await pool.provision({ agentId: 'a1', agentName: 'Art Advisor', slug: 'art' });
    // getMe only — the rename quota is untouched, which is the whole point of
    // checking first.
    expect(calls).toEqual(['getMe']);
    expect(pool.pendingName('bot')).toBeUndefined();
  });
});
