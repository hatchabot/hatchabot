import { describe, expect, it } from 'vitest';
import { createOpsPush, PushBudget } from '../src/ops/push.js';

/**
 * The push the retired Telegram management bot used to do, through the
 * management agent's own bot: "something is waiting", one way, confirm in the app.
 */

function stubFetch(calls: Array<{ url: string; body: Record<string, unknown> }>, ok = true) {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify(ok ? { ok: true } : { ok: false, description: 'Unauthorized' }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('pushing "something is waiting" to the owner', () => {
  it('sends through the manager\'s bot, to the owner\'s own chat, with where to confirm', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const push = createOpsPush({
      botToken: async () => 'BOTTOKEN',
      chatId: () => '99',
      appUrl: () => 'https://box.example.ts.net',
      fetchImpl: stubFetch(calls),
    });
    expect(await push.waiting('o1', 'Your manager prepared a change.', 'Back up every agent')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/botBOTTOKEN/sendMessage');
    expect(calls[0]!.body.chat_id).toBe('99');
    expect(String(calls[0]!.body.text)).toContain('Back up every agent');
    expect(String(calls[0]!.body.text)).toContain('https://box.example.ts.net');
    // No markup parsing: an agent's summary is not trusted as formatting.
    expect(calls[0]!.body.parse_mode).toBeUndefined();
  });

  it('says nothing when the manager has no bot, or the owner has no linked Telegram', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const noBot = createOpsPush({ botToken: async () => undefined, chatId: () => '99', fetchImpl: stubFetch(calls) });
    const noChat = createOpsPush({ botToken: async () => 'T', chatId: () => undefined, fetchImpl: stubFetch(calls) });
    expect(await noBot.waiting('o1', 'x')).toBe(false);
    expect(await noChat.waiting('o1', 'x')).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('a refused or failed send is logged, never thrown', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const refused = createOpsPush({
      botToken: async () => 'T', chatId: () => '9',
      fetchImpl: stubFetch([], false), log: (e, d) => events.push([e, d]),
    });
    expect(await refused.waiting('o1', 'x')).toBe(false);
    expect(events[0]).toEqual(['ops.push', { ok: false, error: 'Unauthorized' }]);

    const threw = createOpsPush({
      botToken: async () => 'T', chatId: () => '9',
      fetchImpl: (async () => { throw new Error('offline'); }) as unknown as typeof fetch,
      log: (e, d) => events.push([e, d]),
    });
    await expect(threw.waiting('o1', 'x')).resolves.toBe(false);
  });
});

describe('a dead pool bot stops being renamed', () => {
  it('knows which Telegram failures no retry can fix', async () => {
    const { permanentTelegramFailure } = await import('../src/channels/telegramPool.js');
    expect(permanentTelegramFailure('Unauthorized')).toBe(true);
    expect(permanentTelegramFailure('Forbidden: bot was deleted')).toBe(true);
    expect(permanentTelegramFailure('Too Many Requests: retry after 3600')).toBe(false);
    expect(permanentTelegramFailure('fetch failed')).toBe(false);
    expect(permanentTelegramFailure(undefined)).toBe(false);
  });
});

describe('announcing a join request once', () => {
  it('is news the first time, silent the second, and news again after it went away', async () => {
    const { unannounced } = await import('../src/ops/push.js');
    const seen = new Set<string>();
    expect(unannounced(seen, ['a1:AB', 'a2:CD'])).toEqual(['a1:AB', 'a2:CD']);
    expect(unannounced(seen, ['a1:AB', 'a2:CD'])).toEqual([]);
    // a2's request was answered; a3 knocks.
    expect(unannounced(seen, ['a1:AB', 'a3:EF'])).toEqual(['a3:EF']);
    expect(seen.has('a2:CD')).toBe(false); // forgotten, so it cannot grow forever
    // The same person knocks again after being turned away.
    expect(unannounced(seen, ['a1:AB', 'a3:EF', 'a2:CD'])).toEqual(['a2:CD']);
  });
});

describe('a push budget, and Discord when Telegram cannot carry it (2026-09-25)', () => {
  it('six an hour per owner: the sixth says so, the seventh is dropped, the hour turning frees it', () => {
    let t = 0;
    const b = new PushBudget(3, () => t);
    expect([b.take('o'), b.take('o'), b.take('o'), b.take('o')]).toEqual(['send', 'send', 'last', 'drop']);
    expect(b.take('other')).toBe('send'); // per owner
    t = 3_600_001;
    expect(b.take('o')).toBe('send');
  });
  it('the push itself honours it, and falls back to a Discord DM when the manager has no Telegram', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const push = createOpsPush({ botToken: async () => 'T', chatId: () => '99', fetchImpl: stubFetch(calls), perHour: 2 });
    expect(await push.waiting('o1', 'one')).toBe(true);
    expect(await push.waiting('o1', 'two')).toBe(true);
    expect(String(calls[1]!.body.text)).toContain('last of these for this hour');
    expect(await push.waiting('o1', 'three')).toBe(false);
    expect(calls).toHaveLength(2);
    const dms: string[] = [];
    const viaDiscord = createOpsPush({ botToken: async () => undefined, chatId: () => undefined, sendDiscord: async (_o, text) => { dms.push(text); return true; }, fetchImpl: stubFetch(calls) });
    expect(await viaDiscord.waiting('o2', 'Someone wants to talk to "Taco".', 'Let them in under Waiting for you.')).toBe(true);
    expect(dms[0]).toContain('Taco'); expect(dms[0]).toContain('Confirm it in the Hatchabot app.');
    expect(calls).toHaveLength(2); // Telegram untouched
    const nothing = createOpsPush({ botToken: async () => undefined, chatId: () => undefined, fetchImpl: stubFetch(calls) });
    expect(await nothing.waiting('o3', 'x')).toBe(false);
  });
});

