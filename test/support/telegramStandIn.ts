/**
 * Telegram as it answers a token that is no bot's (401), for a test that does
 * not mean to talk to it: a push to the owner's phone, a bot's name on the
 * agent list, a token pasted to park. What the real one said to the tests'
 * made-up tokens before every test file was kept from it (HB-1437,
 * test/support/noTelegram.ts). A test that means Telegram to say something
 * hands the code a fetch of its own.
 */
export const telegramRefuses = (async () => new Response(
  JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }),
  { status: 401, headers: { 'content-type': 'application/json' } },
)) as typeof fetch;
