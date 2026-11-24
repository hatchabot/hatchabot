import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';

// No test may reach Telegram (AGENTS.md: a test never reaches the real machine
// or the network). Code that falls back to the global fetch when a test hands
// it none (hibernate.ts's wake sweep, say) asked the real api.telegram.org
// with a made-up token, and the test passed on whatever came back (HB-1221
// review). In every test file (vitest.config.ts's setupFiles, HB-1437), such a
// call fails, as a network that is down would; and as the code under test may
// well take that in its stride, the test that made it fails too, after it
// ends, naming the call: a test stubs what it means Telegram to say.
//
// A call made by work a test left going once it has ended (a timer, a
// promise it did not wait for) fails no other test, whichever runs then: the
// work is known by the test it began in (its async context), and the file
// fails once its tests are done, naming that test. One made while no test
// runs and from none is named by the test it came after.
const asked: string[] = [];
const late: string[] = [];
let running: string | undefined;
let lastEnded: string | undefined;
const begunIn = new AsyncLocalStorage<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/^https?:\/\/api\.telegram\.org(?:[/:?#]|$)/i.test(url)) {
    const shown = url.replace(/\/bot[^/]+\//, '/bot…/');
    const from = begunIn.getStore();
    if (running !== undefined && (from === undefined || from === running)) asked.push(shown);
    else if (from !== undefined) late.push(`${shown} (from "${from}", after it ended)`);
    else late.push(`${shown} (after ${lastEnded === undefined ? 'no test yet' : `"${lastEnded}" ended`})`);
    throw new TypeError(`A test asked the real Telegram (${shown}): hand the code a fetch of its own (test/support/noTelegram.ts)`);
  }
  return realFetch(input, init);
}) as typeof fetch;

beforeEach(() => {
  running = expect.getState().currentTestName ?? '(a test)';
  // What the test starts carries its name (the hooks and the test run in one context).
  begunIn.enterWith(running);
});

afterEach(() => {
  lastEnded = running;
  running = undefined;
  if (!asked.length) return;
  const calls = asked.splice(0);
  throw new Error(`This test asked the real Telegram ${calls.length} time(s), refused: ${[...new Set(calls)].join(', ')}. Hand the code a fetch of its own (test/support/noTelegram.ts).`);
});

afterAll(() => {
  if (!late.length) return;
  const calls = late.splice(0);
  throw new Error(`The real Telegram was asked ${calls.length} time(s) after the test whose work asked it had ended, refused: ${[...new Set(calls)].join(', ')}. Hand the code a fetch of its own, or have the test wait for that work before it ends (test/support/noTelegram.ts).`);
});
