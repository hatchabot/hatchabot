import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/store.js';
import { hashPassword, newRecoveryCode, normalizeRecoveryCode } from '../src/api/signIn/accountsAuth.js';
import type { LocalAccount } from '../src/domain/types.js';
import { createFamilyAccounts, FAMILY_ACCOUNT_EXISTS, FAMILY_SWITCH_WAITING, type FamilyAccountsDeps } from '../src/orchestrator/accounts/familyAccounts.js';
import { createTelegramRecovery, type TelegramRecoveryDeps } from '../src/orchestrator/accounts/telegramRecovery.js';
import { createCliTokens } from '../src/orchestrator/accounts/cliTokens.js';
import { createPeople } from '../src/orchestrator/accounts/people.js';
import { DISCORD_ID } from './support/fixtures.js';

/**
 * The accounts service with no HTTP server (HB-0808 step 15 part B): the
 * switch to an account per person, "Forgot password?" by Telegram and its
 * throttles, the CLI tokens, and the people an account deals with.
 */

// Made up at run time: nothing here is shaped like a real credential.
const PASSWORD = ['a', 'long', 'enough', 'phrase'].join('-');
const BOT = ['fake', 'bot', 'value'].join(':');
const OWNER = { ownsMachine: () => true };
const SOMEONE = { ownsMachine: () => false };

afterEach(() => { vi.useRealTimers(); });

function family(over: Partial<FamilyAccountsDeps> = {}, env = 'HATCHABOT_SECRET_KEY=x\nHATCHABOT_PASSWORD=shared\n') {
  const dir = mkdtempSync(join(tmpdir(), 'hb-accounts-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, env, { mode: 0o600 });
  const store = new Store(new Database(':memory:'));
  const traced: string[] = [];
  const warned: string[] = [];
  let exits = 0;
  const svc = createFamilyAccounts({
    store, authMode: () => 'password', envPath: () => envPath,
    hashPassword: (pw) => hashPassword(pw), newRecoveryCode, normalizeRecoveryCode,
    trace: () => (event) => { traced.push(event); },
    warn: (_d, msg) => { warned.push(msg); },
    supervised: () => false, restartOn: () => false, exit: () => { exits++; },
    ...over,
  });
  return { svc, store, envPath, traced, warned, exits: () => exits, env: () => readFileSync(envPath, 'utf8') };
}
const chosen = (username = 'owner') => () => ({ username, password: PASSWORD });

describe('switching to an account per person', () => {
  it('makes account #1 the host owner with a recovery code, then writes the mode', async () => {
    const w = family();
    const done = await w.svc.switchOn(OWNER, chosen());
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.answer).toMatchObject({ ok: true, username: 'owner', restarting: false });
    expect(done.answer.recoveryCode).toMatch(/\w/);
    const acct = w.store.localAccountByUsername('owner')!;
    expect(acct).toMatchObject({ id: done.answer.ownerId, hostOwner: true, disabled: false });
    expect(acct.recoveryHash).toBeTruthy();
    expect(w.env()).toMatch(/^HATCHABOT_AUTH=accounts$/m);
    expect(w.traced).toEqual(['auth.family_accounts_on']);
  });

  it('never backwards: an install with accounts already is refused first, before who is asking', async () => {
    for (const mode of ['accounts', 'identity'] as const) {
      let read = 0;
      const w = family({ authMode: () => mode });
      expect(await w.svc.switchOn(SOMEONE, () => { read++; return { username: 'owner', password: PASSWORD }; }))
        .toEqual({ ok: false, why: 'refused', status: 409, error: 'This installation already has accounts.' });
      expect(read).toBe(0);
      expect(w.store.countLocalAccounts()).toBe(0);
    }
  });

  it('only the machine\'s owner, and the credentials are not read for anyone else', async () => {
    let read = 0;
    const w = family();
    expect(await w.svc.switchOn(SOMEONE, () => { read++; return { username: 'owner', password: PASSWORD }; })).toEqual({ ok: false, why: 'machine-owner' });
    expect(read).toBe(0);
    expect(w.env()).not.toContain('HATCHABOT_AUTH');
  });

  it('a credentials problem is a 400 in its words, and nothing is made or written', async () => {
    const w = family();
    expect(await w.svc.switchOn(OWNER, () => ({ problem: 'Username must be 3–64 characters.' })))
      .toEqual({ ok: false, why: 'refused', status: 400, error: 'Username must be 3–64 characters.' });
    expect(w.store.countLocalAccounts()).toBe(0);
    expect(w.env()).not.toContain('HATCHABOT_AUTH');
  });

  it('one at a time: a second switch while the first runs is told to wait', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = family({ hashPassword: async (pw) => { await gate; return hashPassword(pw); } });
    const first = w.svc.switchOn(OWNER, chosen());
    const second = await w.svc.switchOn(OWNER, chosen('other'));
    expect(second).toEqual({ ok: false, why: 'refused', status: 409, error: FAMILY_SWITCH_WAITING });
    release();
    expect((await first).ok).toBe(true);
    // The first is over: the next is refused because an account exists now and the .env says accounts.
    expect(await w.svc.switchOn(OWNER, chosen('other'))).toEqual({ ok: false, why: 'refused', status: 409, error: FAMILY_SWITCH_WAITING });
  });

  it('an account made another way stays: the switch is refused', async () => {
    const w = family();
    const made: LocalAccount = { id: 'acct-cli', username: 'made-by-cli', pwHash: '', pwSalt: '', hostOwner: true, disabled: false, createdAt: new Date().toISOString() };
    w.store.insertLocalAccount(made);
    expect(await w.svc.switchOn(OWNER, chosen())).toEqual({ ok: false, why: 'refused', status: 409, error: FAMILY_ACCOUNT_EXISTS });
    expect(w.store.localAccount('acct-cli')).toBeTruthy();
  });

  it('an account a crash left half made (never used, .env not written) is replaced', async () => {
    const w = family();
    const first = await w.svc.switchOn(OWNER, chosen('first-try'));
    expect(first.ok).toBe(true);
    // The crash: the .env was never written.
    writeFileSync(w.envPath, 'HATCHABOT_SECRET_KEY=x\nHATCHABOT_PASSWORD=shared\n');
    const again = await w.svc.switchOn(OWNER, chosen('second-try'));
    expect(again.ok).toBe(true);
    expect(w.store.localAccountByUsername('first-try')).toBeUndefined();
    expect(w.store.localAccountByUsername('second-try')?.hostOwner).toBe(true);
    expect(w.warned).toEqual(['family accounts: replaced the account a crash left half made']);
  });

  it('a .env that cannot be written undoes the account', async () => {
    const w = family({ envPath: () => '/nonexistent-dir-for-this-test/.env' });
    const done = await w.svc.switchOn(OWNER, chosen());
    expect(done).toMatchObject({ ok: false, why: 'refused', status: 409 });
    expect(w.store.countLocalAccounts()).toBe(0);
  });

  it('restarts 1.2 s after the answer only when supervised and allowed; stop() ends that timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const unsupervised = family({ restartOn: () => true });
    expect(await unsupervised.svc.switchOn(OWNER, chosen())).toMatchObject({ ok: true, answer: { restarting: false } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(unsupervised.exits()).toBe(0);

    const held = family({ supervised: () => true, restartOn: () => false });
    expect(await held.svc.switchOn(OWNER, chosen())).toMatchObject({ ok: true, answer: { restarting: true } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(held.exits()).toBe(0);

    const live = family({ supervised: () => true, restartOn: () => true });
    expect(await live.svc.switchOn(OWNER, chosen())).toMatchObject({ ok: true, answer: { restarting: true } });
    await vi.advanceTimersByTimeAsync(1_199);
    expect(live.exits()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(live.exits()).toBe(1);

    const stopped = family({ supervised: () => true, restartOn: () => true });
    await stopped.svc.switchOn(OWNER, chosen());
    stopped.svc.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped.exits()).toBe(0);
  });
});

// ---- "Forgot password?" ------------------------------------------------------

function recovery(over: Partial<TelegramRecoveryDeps> = {}, storeOver: Record<string, unknown> = {}) {
  const accounts: LocalAccount[] = [
    { id: 'acct-owner', username: 'owner', pwHash: 'h', pwSalt: 's', hostOwner: true, disabled: false, createdAt: 'now' },
    { id: 'acct-member', username: 'member', pwHash: 'h', pwSalt: 's', hostOwner: false, disabled: false, createdAt: 'now' },
  ];
  const tg: Record<string, string> = { 'acct-owner': '424242', 'acct-member': '434343' };
  const sent: Array<{ chat: unknown; text: string }> = [];
  const warned: Array<[Record<string, unknown>, string]> = [];
  const store = {
    localAccountByUsername: (u: string) => accounts.find((a) => a.username === u.toLowerCase()),
    knownChannelUserId: (id: string) => tg[id],
    identityOfUserAnywhere: () => undefined,
    listLocalAccounts: () => accounts,
    listAllActiveAgents: () => [{ id: 'a1', ownerId: 'acct-owner', state: 'RUNNING', ops: true }],
    listAllowedChannelUserIds: () => ['424242', '434343'],
    getChannelForAgent: (_id: string, kind: string) => (kind === 'telegram' ? { secretRef: 'tg/a1', accountId: 'bot1' } : undefined),
    setLocalAccountClaim: (id: string, code: string, expires: string) => {
      const a = accounts.find((x) => x.id === id)!;
      a.claimCode = code; a.claimExpires = expires;
    },
    ...storeOver,
  } as unknown as TelegramRecoveryDeps['store'];
  const svc = createTelegramRecovery({
    store,
    secrets: { get: async () => BOT },
    hasOwnerRights: () => false,
    appUrlFor: () => 'https://box.example-tailnet.ts.net',
    linkUrlFor: () => 'https://box.example-tailnet.ts.net:8443',
    connectorFor: () => undefined,
    telegramFetch: () => (async (_url: string, init: { body: string }) => {
      const b = JSON.parse(init.body) as { chat_id: unknown; text: string };
      sent.push({ chat: b.chat_id, text: b.text });
      return new Response('{"ok":true}');
    }) as unknown as typeof fetch,
    warn: (d, msg) => { warned.push([d, msg]); },
    ...over,
  });
  return { svc, sent, warned, accounts };
}
const PRIVATE = { fromPublic: false, address: () => { throw new Error('the private address is never counted by address'); } };
const fromAddress = (address: string) => ({ fromPublic: true, address: () => address });

describe('"Forgot password?" by Telegram', () => {
  it('sends a member a one-use link for the address links are made for, and logs that it did', async () => {
    const r = recovery();
    await r.svc.ask('member', PRIVATE);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.chat).toBe('434343');
    const code = r.accounts[1]!.claimCode!;
    expect(code).toBeTruthy();
    expect(r.sent[0]!.text).toContain(`https://box.example-tailnet.ts.net:8443/?claim=${code}`);
    expect(r.warned.at(-1)).toEqual([{ account: 'acct-member', via: 'bot1' }, 'account.recovery_link_sent']);
  });

  it('an owner\'s link is for the private address, and says so', async () => {
    const r = recovery();
    await r.svc.ask('owner', PRIVATE);
    expect(r.sent[0]!.text).toContain('https://box.example-tailnet.ts.net/?claim=');
    expect(r.sent[0]!.text).toContain('the link works at the private address only');
  });

  it('nothing is sent for a name that is not an account, is too long, or has no Telegram', async () => {
    const r = recovery();
    await r.svc.ask('nobody', PRIVATE);
    await r.svc.ask('', PRIVATE);
    await r.svc.ask('x'.repeat(65), PRIVATE);
    r.accounts.push({ id: 'acct-quiet', username: 'quiet', pwHash: 'h', pwSalt: 's', hostOwner: false, disabled: false, createdAt: 'now' });
    await r.svc.ask('quiet', PRIVATE);
    expect(r.sent).toEqual([]);
  });

  it('at the private address a name may ask once in five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T10:00:00Z'));
    const r = recovery();
    await r.svc.ask('member', PRIVATE);
    vi.setSystemTime(new Date('2026-11-22T10:04:59Z'));
    await r.svc.ask('MEMBER', PRIVATE);
    expect(r.sent).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-22T10:05:00Z'));
    await r.svc.ask('member', PRIVATE);
    expect(r.sent).toHaveLength(2);
    r.svc.resetLimits();
    await r.svc.ask('member', PRIVATE);
    expect(r.sent).toHaveLength(3);
  });

  it('from the internet: no link for an owner, only a note naming the private address', async () => {
    const r = recovery();
    await r.svc.ask('owner', fromAddress('203.0.113.7'));
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]!.text).not.toContain('claim=');
    expect(r.sent[0]!.text).toContain('(https://box.example-tailnet.ts.net)');
    expect(r.accounts[0]!.claimCode).toBeUndefined();
    expect(r.warned.at(-1)).toEqual([{ account: 'acct-owner', via: 'bot1', from: 'the public address', link: false }, 'account.recovery_link_sent']);
  });

  it('from the internet: a link still good is never replaced, and a name asks once an hour, three times a day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));
    const r = recovery();
    await r.svc.ask('member', fromAddress('203.0.113.7'));
    expect(r.sent).toHaveLength(1);
    const first = r.accounts[1]!.claimCode;
    vi.setSystemTime(new Date('2026-11-22T00:10:00Z'));
    await r.svc.ask('member', fromAddress('198.51.100.9'));
    expect(r.sent).toHaveLength(1);
    expect(r.accounts[1]!.claimCode).toBe(first);
    // The link has run out, but the hour has not.
    vi.setSystemTime(new Date('2026-11-22T00:59:59Z'));
    await r.svc.ask('member', fromAddress('198.51.100.9'));
    expect(r.sent).toHaveLength(1);
    for (const hour of ['01', '02', '03']) {
      vi.setSystemTime(new Date(`2026-11-22T${hour}:00:00Z`));
      await r.svc.ask('member', fromAddress(`198.51.100.${hour}`));
    }
    expect(r.sent).toHaveLength(3);
    // The private address is counted apart: it still works.
    await r.svc.ask('member', PRIVATE);
    expect(r.sent).toHaveLength(4);
  });

  it('from the internet: an address asks five times an hour, whatever the names', async () => {
    const r = recovery();
    for (const name of ['a1', 'a2', 'a3', 'a4', 'a5']) await r.svc.ask(name, fromAddress('2001:db8:1:2::/64'));
    await r.svc.ask('member', fromAddress('2001:db8:1:2::/64'));
    expect(r.sent).toEqual([]);
    await r.svc.ask('member', fromAddress('2001:db8:9:9::/64'));
    expect(r.sent).toHaveLength(1);
  });

  it('from the internet: thirty asks an hour from everyone together', async () => {
    const r = recovery();
    for (let i = 0; i < 30; i++) await r.svc.ask(`name${i}`, fromAddress(`198.51.100.${i}`));
    await r.svc.ask('member', fromAddress('203.0.113.200'));
    expect(r.sent).toEqual([]);
  });

  /** Telegram at the fetch seam: each bot (by its token) answers as `answers` says; every try is recorded. */
  const telegramAnswering = (answers: Record<string, () => Promise<Response>>) => {
    const tried: Array<{ token: string; text: string }> = [];
    const telegramFetch = () => (async (url: string, init: { body: string }) => {
      const token = /\/bot(.+)\/sendMessage$/.exec(url)![1]!;
      tried.push({ token, text: (JSON.parse(init.body) as { text: string }).text });
      return answers[token]!();
    }) as unknown as typeof fetch;
    return { tried, telegramFetch };
  };
  /** undici's error for a fetch that failed, with the code of what went wrong. */
  const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });

  it('a send Telegram refuses (500, 403, or ok: false) is not logged as sent, and the link it carried goes (HB-0950)', async () => {
    for (const refusal of [
      async () => new Response('{"ok":false,"error_code":500,"description":"Internal Server Error"}', { status: 500 }),
      async () => new Response('{"ok":false,"error_code":403,"description":"Forbidden: bot was blocked by the user"}', { status: 403 }),
      async () => new Response('{"ok":false,"description":"Bad Request: chat not found"}'),
      // Telegram's own no to too many, and a 4xx in any words: the request was not taken.
      async () => new Response('{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 5","parameters":{"retry_after":5}}', { status: 429 }),
      async () => new Response('<html>404 Not Found</html>', { status: 404 }),
      // Never reached Telegram: nothing was sent.
      async () => { throw fetchFailed('ECONNREFUSED'); },
      async () => { throw fetchFailed('ENOTFOUND'); },
    ]) {
      const t = telegramAnswering({ [BOT]: refusal });
      const r = recovery({ telegramFetch: t.telegramFetch });
      await r.svc.ask('member', PRIVATE);
      expect(t.tried).toHaveLength(1);
      expect(r.warned.map(([, msg]) => msg)).not.toContain('account.recovery_link_sent');
      expect(r.warned.at(-1)![1]).toBe('account.recovery_not_delivered');
      expect(r.warned.at(-1)![0]).toMatchObject({ account: 'acct-member', notTaken: [{ via: 'bot1' }] });
      expect(r.accounts[1]!.claimCode ?? null).toBeNull();
    }
  });

  it('a send that may have arrived keeps its link and says so, and the same message still goes on to the next bot (HB-0950 review)', async () => {
    for (const maybe of [
      // Telegram took it but answered after the time limit.
      async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
      // The connection was lost once the request had gone, or "fetch failed" with nothing to tell which.
      async () => { throw fetchFailed('UND_ERR_SOCKET'); },
      async () => { throw fetchFailed('ECONNRESET'); },
      async () => { throw new TypeError('fetch failed'); },
      // A 200 whose words are not Telegram's.
      async () => new Response('<html>ok</html>'),
      // Its front's 5xx, not Telegram's words: a 504 can come after the message was sent (HB-0950 round 3).
      async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
      async () => new Response('<html>504 Gateway Time-out</html>', { status: 504 }),
      async () => new Response('', { status: 500 }),
    ]) {
      const t = telegramAnswering({ [BOT]: maybe });
      const r = recovery({ telegramFetch: t.telegramFetch });
      await r.svc.ask('member', PRIVATE);
      const carried = /\?claim=([A-Za-z0-9_-]+)/.exec(t.tried[0]!.text)![1];
      expect(r.accounts[1]!.claimCode).toBe(carried);
      expect(r.warned.map(([, msg]) => msg)).toEqual(['account.recovery_link_unconfirmed']);
      expect(r.warned[0]![0]).toMatchObject({ account: 'acct-member', unconfirmed: [{ via: 'bot1' }] });
      expect(r.warned[0]![0]).not.toHaveProperty('notTaken');
    }
    // With a second bot: the same message goes to it, and taken there it is sent, the first named unconfirmed.
    const one = ['fake', 'one'].join(':'), two = ['fake', 'two'].join(':');
    const t = telegramAnswering({
      [one]: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
      [two]: async () => new Response('{"ok":true}'),
    });
    const r = recovery({ telegramFetch: t.telegramFetch, secrets: { get: async (ref: string) => (ref === 'tg/a1' ? one : two) } as never }, {
      listAllActiveAgents: () => [{ id: 'a1', ownerId: 'acct-owner', state: 'RUNNING', ops: true }, { id: 'a2', ownerId: 'acct-owner', state: 'RUNNING' }],
      getChannelForAgent: (id: string, kind: string) => (kind === 'telegram' ? { secretRef: `tg/${id}`, accountId: `bot-${id}` } : undefined),
    });
    await r.svc.ask('member', PRIVATE);
    expect(t.tried.map((x) => x.token)).toEqual([one, two]);
    expect(t.tried[1]!.text).toBe(t.tried[0]!.text);
    expect(t.tried[1]!.text).toContain(`?claim=${r.accounts[1]!.claimCode}`);
    expect(r.warned.at(-1)).toEqual([{ account: 'acct-member', via: 'bot-a2', unconfirmed: [{ via: 'bot-a1', error: 'The operation was aborted due to timeout' }] }, 'account.recovery_link_sent']);
  });

  it('a bot Telegram holds back (429) is a refusal, so the next bot carries the link (HB-0950 round 3)', async () => {
    const one = ['fake', 'one'].join(':'), two = ['fake', 'two'].join(':');
    const t = telegramAnswering({
      [one]: async () => new Response('{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 5","parameters":{"retry_after":5}}', { status: 429 }),
      [two]: async () => new Response('{"ok":true}'),
    });
    const r = recovery({ telegramFetch: t.telegramFetch, secrets: { get: async (ref: string) => (ref === 'tg/a1' ? one : two) } as never }, {
      listAllActiveAgents: () => [{ id: 'a1', ownerId: 'acct-owner', state: 'RUNNING', ops: true }, { id: 'a2', ownerId: 'acct-owner', state: 'RUNNING' }],
      getChannelForAgent: (id: string, kind: string) => (kind === 'telegram' ? { secretRef: `tg/${id}`, accountId: `bot-${id}` } : undefined),
    });
    await r.svc.ask('member', PRIVATE);
    expect(t.tried.map((x) => x.token)).toEqual([one, two]);
    expect(t.tried[1]!.text).toContain(`?claim=${r.accounts[1]!.claimCode}`);
    expect(r.warned.at(-1)).toEqual([{ account: 'acct-member', via: 'bot-a2', notTaken: [{ via: 'bot-a1', error: 'Too Many Requests: retry after 5' }] }, 'account.recovery_link_sent']);
  });

  it('every send of an ask shares one time limit: three bots that hang take no longer than one (HB-0950 review)', async () => {
    const tokens = ['fake:a', 'fake:b', 'fake:c'];
    const tried: string[] = [];
    // Each bot hangs until the send's signal ends it.
    const hang = (() => (url: string, init: { signal: AbortSignal }) => new Promise<Response>((_answer, fail) => {
      tried.push(url);
      init.signal.addEventListener('abort', () => fail(init.signal.reason), { once: true });
    })) as unknown as TelegramRecoveryDeps['telegramFetch'];
    const r = recovery({ telegramFetch: hang, sendWithinMs: 300, secrets: { get: async (ref: string) => tokens[Number(ref.slice(-1))]! } as never }, {
      listAllActiveAgents: () => tokens.map((_t, i) => ({ id: `a${i}`, ownerId: 'acct-owner', state: 'RUNNING' })),
      getChannelForAgent: (id: string, kind: string) => (kind === 'telegram' ? { secretRef: `tg/${id}`, accountId: `bot-${id}` } : undefined),
    });
    const started = Date.now();
    await r.svc.ask('member', PRIVATE);
    const took = Date.now() - started;
    expect(took, `${took} ms`).toBeLessThan(2000);
    expect(tried).toHaveLength(1);
    // The one that hung may have delivered it: the link stays, and the log says time ran out.
    expect(r.accounts[1]!.claimCode).toBeTruthy();
    expect(r.warned.at(-1)![1]).toBe('account.recovery_link_unconfirmed');
    expect(r.warned.at(-1)![0]).toMatchObject({ unconfirmed: [{ via: 'bot-a0' }], outOfTime: true });

    // A Discord DM takes no signal: its answer is waited for until the limit, and one that never comes may have arrived.
    const dc = recovery({ sendWithinMs: 300, connectorFor: () => ({ dm: () => new Promise<boolean>(() => {}) }) as never }, {
      knownChannelUserId: () => undefined,
      identityOfUserAnywhere: (id: string) => (id === 'acct-member' ? DISCORD_ID : undefined),
      listAllowedChannelUserIds: () => [DISCORD_ID],
      getChannelForAgent: (_id: string, kind: string) => (kind === 'discord' ? { secretRef: 'dc/a1', accountId: 'house' } : undefined),
    });
    const t0 = Date.now();
    await dc.svc.ask('member', PRIVATE);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(dc.accounts[1]!.claimCode).toBeTruthy();
    expect(dc.warned.at(-1)).toEqual([{ account: 'acct-member', unconfirmed: [{ via: 'discord:house', error: 'Discord did not answer in time' }] }, 'account.recovery_link_unconfirmed']);
  }, 40_000);

  it('a bot that refuses hands the same link to the next, then to Discord; a link they had stays when none takes it (HB-0950)', async () => {
    const ok = async () => new Response('{"ok":true}');
    const refuse = async () => new Response('{"ok":false,"description":"Forbidden: bot was blocked by the user"}', { status: 403 });
    const one = ['fake', 'one'].join(':'), two = ['fake', 'two'].join(':');
    const secrets = { get: async (ref: string) => ({ 'tg/a1': one, 'tg/a2': two, 'dc/a1': 'fake-discord' } as Record<string, string>)[ref]! };
    // Two bots that have talked to the member (the manager's first), and a Discord bot they are linked on.
    const twoBots = {
      listAllActiveAgents: () => [{ id: 'a1', ownerId: 'acct-owner', state: 'RUNNING', ops: true }, { id: 'a2', ownerId: 'acct-owner', state: 'RUNNING' }],
      getChannelForAgent: (id: string, kind: string) => (kind === 'telegram' ? { secretRef: `tg/${id}`, accountId: `bot-${id}` } : id === 'a1' ? { secretRef: 'dc/a1', accountId: 'house' } : undefined),
      identityOfUserAnywhere: (id: string) => (id === 'acct-member' ? DISCORD_ID : undefined),
      listAllowedChannelUserIds: () => ['434343', DISCORD_ID],
    };
    const dms: string[] = [];
    let discordTakes = true;
    const discord = () => ({ dm: async (_secret: string, _to: string, text: string) => { dms.push(text); return discordTakes; } }) as never;

    // The manager's bot refuses; the next bot takes it, with the link the first was given.
    const t = telegramAnswering({ [one]: refuse, [two]: ok });
    const r = recovery({ telegramFetch: t.telegramFetch, secrets: secrets as never, connectorFor: discord }, twoBots);
    await r.svc.ask('member', PRIVATE);
    expect(t.tried.map((x) => x.token)).toEqual([one, two]);
    expect(t.tried[1]!.text).toBe(t.tried[0]!.text);
    expect(t.tried[1]!.text).toContain(`?claim=${r.accounts[1]!.claimCode}`);
    expect(dms).toEqual([]);
    expect(r.warned.at(-1)).toEqual([{ account: 'acct-member', via: 'bot-a2', notTaken: [{ via: 'bot-a1', error: 'Forbidden: bot was blocked by the user' }] }, 'account.recovery_link_sent']);

    // Neither bot takes it: Discord does.
    const t2 = telegramAnswering({ [one]: refuse, [two]: refuse });
    const r2 = recovery({ telegramFetch: t2.telegramFetch, secrets: secrets as never, connectorFor: discord }, twoBots);
    await r2.svc.ask('member', PRIVATE);
    expect(t2.tried).toHaveLength(2);
    expect(dms).toEqual([t2.tried[0]!.text]);
    expect(r2.warned.at(-1)![0]).toMatchObject({ via: 'discord:house' });
    const delivered = r2.accounts[1]!.claimCode!;
    expect(dms[0]).toContain(`?claim=${delivered}`);

    // Five minutes on, nothing takes the next one: the link they got stays good.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5 * 60_000);
    discordTakes = false;
    await r2.svc.ask('member', PRIVATE);
    expect(dms).toHaveLength(2);
    expect(r2.accounts[1]!.claimCode).toBe(delivered);
    expect(r2.warned.at(-1)).toEqual([{ account: 'acct-member', notTaken: [
      { via: 'bot-a1', error: 'Forbidden: bot was blocked by the user' },
      { via: 'bot-a2', error: 'Forbidden: bot was blocked by the user' },
      { via: 'discord:house', error: 'Discord did not take it' },
    ] }, 'account.recovery_not_delivered']);
  });
});

// ---- CLI tokens -----------------------------------------------------------------

describe('CLI tokens', () => {
  it('a token is answered once, listed without itself, and revoked by its owner only', () => {
    const store = new Store(new Database(':memory:'));
    const tokens = createCliTokens({ store });
    const made = tokens.mint('acct-owner', 'laptop');
    expect(Object.keys(made).sort()).toEqual(['id', 'token']);
    expect(made.token.startsWith('hatchabot_')).toBe(true);
    const listed = tokens.list('acct-owner');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: made.id, label: 'laptop' });
    expect(JSON.stringify(listed)).not.toContain(made.token);
    // Only the hash is kept.
    expect(JSON.stringify(store.rawDb().prepare('SELECT * FROM cli_tokens').all())).not.toContain(made.token);
    // About 90 days.
    const days = (Date.parse(listed[0]!.expiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
    expect(tokens.list('acct-member')).toEqual([]);
    expect(tokens.revoke('acct-member', made.id)).toBe(false);
    expect(tokens.revoke('acct-owner', made.id)).toBe(true);
    expect(tokens.list('acct-owner')).toEqual([]);
    expect(tokens.revoke('acct-owner', made.id)).toBe(false);
  });

  it('a rehost token carries its scope', () => {
    const store = new Store(new Database(':memory:'));
    const tokens = createCliTokens({ store });
    tokens.mint('acct-owner', 'other server', 'rehost');
    expect(tokens.list('acct-owner')[0]).toMatchObject({ label: 'other server', scope: 'rehost' });
  });
});

// ---- the people an account deals with ---------------------------------------------

describe('people', () => {
  it('a share is addressed to anyone who signed in, for the machine\'s owner; to the owner and past swaps for anyone else', () => {
    const calls: unknown[][] = [];
    const store = {
      listAccounts: (...a: unknown[]) => { calls.push(['all', ...a]); return [{ ownerId: 'x' }]; },
      listHosts: () => [{ kind: 'local', ownerId: 'acct-owner' }],
      listRelatedAccounts: (...a: unknown[]) => { calls.push(['related', ...a]); return [{ ownerId: 'acct-owner' }]; },
    } as never;
    const people = createPeople({ store, providerFor: () => { throw new Error('not used'); } });
    expect(people.addressees('acct-owner', () => true)).toEqual({ accounts: [{ ownerId: 'x' }] });
    expect(people.addressees('acct-member', () => false)).toEqual({ accounts: [{ ownerId: 'acct-owner' }] });
    expect(calls).toEqual([['all', 'acct-owner'], ['related', 'acct-member', ['acct-owner']]]);
  });

  it('the roster: members by Telegram id, last seen from the sessions, read once a minute per agent', async () => {
    let reads = 0;
    const agents = [{ id: 'a1', ownerId: 'acct-owner', name: 'Kettle', slug: 'kettle', state: 'RUNNING', runtimeRef: 'c1', hostId: 'h1' }];
    const store = {
      listAllActiveAgents: () => agents,
      listMemberships: () => [{ userId: 'u1', channelUserId: '434343', displayName: 'Member', role: 'member', status: 'active', joinedAt: 'then' }],
    } as never;
    const provider = { execShell: async () => { reads++; return { code: 0, stdout: JSON.stringify({ 'agent:main:telegram:dm:434343': { lastTo: 'telegram:434343', lastInteractionAt: Date.parse('2026-11-22T09:00:00Z'), chatType: 'direct' } }), stderr: '' }; } };
    const people = createPeople({ store, providerFor: () => provider as never });
    const one = await people.roster('acct-owner', false);
    expect(one.users).toEqual([{
      channelUserId: '434343', displayName: 'Member',
      memberships: [{ agentId: 'a1', agentName: 'Kettle', agentState: 'RUNNING', role: 'member', status: 'active', joinedAt: 'then' }],
      lastSeen: { at: '2026-11-22T09:00:00.000Z', agentName: 'Kettle', thread: 'dm' },
    }]);
    await people.roster('acct-owner', false);
    expect(reads).toBe(1);
    expect((await people.roster('acct-member', false)).users).toEqual([]);
  });

  it('forgets the sessions it read for an agent once the agent is gone and the minute is past (HB-1132)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-22T09:00:00Z'));
    let agents = [
      { id: 'a-kept', ownerId: 'acct-owner', name: 'Kettle', slug: 'kettle', state: 'RUNNING', runtimeRef: 'c1', hostId: 'h1' },
      { id: 'a-gone', ownerId: 'acct-owner', name: 'Toaster', slug: 'toaster', state: 'RUNNING', runtimeRef: 'c2', hostId: 'h1' },
    ];
    const store = { listAllActiveAgents: () => agents, listMemberships: () => [] } as never;
    const provider = { execShell: async () => ({ code: 0, stdout: JSON.stringify({ 'agent:main:telegram:dm:434343': { lastTo: 'telegram:434343', lastInteractionAt: Date.parse('2026-11-22T08:00:00Z') } }), stderr: '' }) };
    // The service's cache, found as it stores its first reading.
    const caches = new Set<Map<unknown, unknown>>();
    const realSet = Map.prototype.set;
    const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (key === 'a-gone' && !!value && typeof value === 'object' && 'fetchedAt' in value) caches.add(this);
      return realSet.call(this, key, value) as never;
    });
    try {
      const people = createPeople({ store, providerFor: () => provider as never });
      await people.roster('acct-owner', false);
      expect(caches.size).toBe(1);
      const [cache] = [...caches];
      expect(cache!.has('a-gone')).toBe(true);
      // Deleted; the roster is looked at again, within the minute and after it.
      agents = agents.filter((a) => a.id !== 'a-gone');
      await people.roster('acct-owner', false);
      expect(cache!.has('a-gone')).toBe(true);
      vi.setSystemTime(new Date('2026-11-22T09:01:00Z'));
      await people.roster('acct-owner', false);
      expect(cache!.has('a-gone')).toBe(false);
      expect([...cache!.keys()]).toEqual(['a-kept']);
    } finally { spy.mockRestore(); }
  });
});
