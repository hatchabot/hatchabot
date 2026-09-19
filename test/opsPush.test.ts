import { describe, expect, it } from 'vitest';
import { createOpsPush } from '../src/ops/push.js';

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
