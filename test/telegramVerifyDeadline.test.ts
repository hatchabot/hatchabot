import { describe, expect, it } from 'vitest';
import { InvalidBotTokenError, TelegramUnavailableError, verifyBotToken } from '../src/channels/telegramManual.js';

/** Rejects once the signal aborts, as fetch and a body read do. */
const untilAborted = (signal: AbortSignal | null | undefined) => new Promise<never>((_, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
});

/**
 * The deep audit of v2.177.0 (2026-11-07), HB-0552: checking a bot token
 * with Telegram had no deadline, so adding a bot or pasting a token could
 * wait for minutes, or for good while a body dribbled in.
 */
describe('a bot token check has one deadline, answer and body together (HB-0552)', () => {
  it('a Telegram that never answers ends in a "try again", and the request is called off by the deadline itself', async () => {
    let signal: AbortSignal | undefined;
    const stalled = ((_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return untilAborted(signal);
    }) as unknown as typeof fetch;
    const err = await verifyBotToken('123:made-up', stalled, 50).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramUnavailableError);
    expect(err.userMessage).toMatch(/Try again/);
    expect(err.message).toMatch(/no answer in time/);
    expect(signal?.aborted).toBe(true);
    // The fetch's own signal is the deadline (it cuts off the body too), not a
    // controller aborted beside a race.
    expect((signal?.reason as Error | undefined)?.name).toBe('TimeoutError');
  });

  it('a body that never ends is cut off at the same deadline', async () => {
    const dribble = (async (_url: unknown, init?: RequestInit) =>
      ({ status: 200, json: () => untilAborted(init?.signal) })) as unknown as typeof fetch;
    await expect(verifyBotToken('123:made-up', dribble, 50)).rejects.toBeInstanceOf(TelegramUnavailableError);
  });

  it('no connection is a "try again" too, never "that token didn\'t work"', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const err = await verifyBotToken('123:made-up', down).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramUnavailableError);
    expect(err).not.toBeInstanceOf(InvalidBotTokenError);
  });

  it('an answer in time works as before', async () => {
    const ok = (async () => new Response(JSON.stringify({ ok: true, result: { username: 'made_up_bot' } }))) as unknown as typeof fetch;
    expect(await verifyBotToken('123:made-up', ok, 1000)).toBe('made_up_bot');
  });
});

/**
 * The review of the HB-0552 fix: a proxy's 502 page, Telegram's 5xx and its
 * 429 all said "That token didn't work". Only Telegram's own no is that.
 */
describe('only Telegram\'s own "no" means a wrong token', () => {
  const answer = (status: number, body: string, type = 'application/json') =>
    (async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;
  const no = (description: string) => JSON.stringify({ ok: false, error_code: 0, description });

  it.each([
    ['a proxy\'s 502 page', answer(502, '<html>502 Bad Gateway</html>', 'text/html')],
    ['a proxy\'s 504 page', answer(504, '<html>504 Gateway Time-out</html>', 'text/html')],
    ['an HTML page with 200', answer(200, '<html>maintenance</html>', 'text/html')],
    ['Telegram\'s 500', answer(500, no('Internal Server Error'))],
    ['Telegram\'s 502 in JSON', answer(502, no('Bad Gateway'))],
    ['Telegram\'s 429', answer(429, JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } }))],
    ['an ok:false with no 401 or 404', answer(200, no('Something else'))],
  ])('%s is "try again"', async (_name, fetchImpl) => {
    const err = await verifyBotToken('123:made-up', fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(TelegramUnavailableError);
    expect(err.statusCode).toBe(503);
  });

  it('the body of a 5xx or 429 is let go, not left holding its connection', async () => {
    for (const status of [502, 429]) {
      let cancelled = false;
      const body = new ReadableStream({ pull() { /* never sends */ }, cancel() { cancelled = true; } });
      const fetchImpl = (async () => new Response(body, { status })) as unknown as typeof fetch;
      await expect(verifyBotToken('123:made-up', fetchImpl)).rejects.toBeInstanceOf(TelegramUnavailableError);
      expect(cancelled, String(status)).toBe(true);
    }
  });

  it.each([
    ['401', answer(401, no('Unauthorized'))],
    ['404', answer(404, no('Not Found'))],
  ])('ok:false with %s is a wrong token', async (_name, fetchImpl) => {
    await expect(verifyBotToken('123:made-up', fetchImpl)).rejects.toBeInstanceOf(InvalidBotTokenError);
  });
});
