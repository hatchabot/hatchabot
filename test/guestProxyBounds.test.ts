/**
 * What one guest connection may make this process hold (deep audit of
 * v2.177.0). HB-0593: the guest proxy wrote to a side that was not reading
 * and kept reading the other, so a stalled reader grew the write queue
 * without bound. Now whatever writes into a side that is behind is held back
 * (what the browser sent, held, counts as active; the gateway streaming to
 * it does not), what waits is handed over a piece at a time so a slow
 * reader's progress shows, a side that takes nothing for a minute closes the
 * connection, and so does a write past maxQueued; the gateway's side closes
 * with 1011 and its name. HB-0594: a message's size
 * was capped but not its frames, so a peer could leave any number of empty
 * ones waiting for a message it never finished. Fake sockets and Unix
 * sockets, no gateway.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFrame, FrameReader, GUEST_DRAIN_MS, GUEST_HELD_LIMIT, GuestActivity, GUEST_KEEP_LIMIT, MESSAGE_DEADLINE_MS, WsFrame, GUEST_QUEUE_SLACK, GUEST_REFUSAL_BUDGET, GUEST_REPLY_WAIT_MS, GUEST_STALL_MS, MAX_GUEST_PENDING, MAX_GUEST_ID_LENGTH, MAX_MESSAGE_FRAMES, spliceGuest } from '../src/api/consoleProxy.js';

/**
 * An in-memory socket. `stall` stops it taking what it is written (the bytes
 * wait in its queue) until `catchUp`; `takeOne` takes one waiting write.
 */
function socket() {
  const sent: Buffer[] = [];
  const held: Array<() => void> = [];
  let stalled = false;
  const s = new Duplex({ read() {}, write(chunk, _enc, cb) { sent.push(Buffer.from(chunk)); if (stalled) held.push(cb); else cb(); } });
  return {
    s, sent,
    feed: (b: Buffer) => s.push(b),
    stall: () => { stalled = true; },
    catchUp: () => { stalled = false; while (held.length) held.shift()!(); },
    takeOne: () => { held.shift()?.(); },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const frames = (bs: Buffer[]) => new FrameReader(1 << 26).push(Buffer.concat(bs));
const texts = (bs: Buffer[]) => frames(bs).filter((f) => f.opcode === 1).map((f) => JSON.parse(f.payload.toString()));
const closeOf = (bs: Buffer[]) => {
  const c = frames(bs).find((f) => f.opcode === 0x8);
  return c ? { code: c.payload.readUInt16BE(0), reason: c.payload.subarray(2).toString() } : undefined;
};
const wire = (v: unknown, masked: boolean) => encodeFrame(1, Buffer.from(JSON.stringify(v)), masked);
/** Pings from the browser adding up to exactly `total` bytes on the wire (each 6–131 bytes). */
function pings(total: number): Buffer {
  const out: Buffer[] = [];
  let left = total;
  const ping = (size: number) => { out.push(encodeFrame(0x9, Buffer.alloc(size - 6, 1), true)); left -= size; };
  while (left > 137) ping(131);
  if (left > 131) ping(left - 6);
  if (left > 0) ping(left);
  return Buffer.concat(out);
}
/** A frame with FIN cleared: more of its message follows. */
const notLast = (b: Buffer) => { b[0] = b[0]! & 0x7f; return b; };

describe('what waits to be sent is bounded (HB-0593)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const chatSends = (n: number) => Array.from({ length: n }, (_, i) => wire({ type: 'req', id: `send-${i}`, method: 'chat.send', params: { message: 'x'.repeat(10_000) } }, true));
  const chatEvents = (n: number) => Array.from({ length: n }, (_, i) => wire({ type: 'event', event: 'chat', seq: i, payload: { text: 'y'.repeat(10_000) } }, false));

  it('a gateway that falls behind: the browser is held back (and counts as active) until it catches up, then everything goes through in order', async () => {
    const browser = socket(), gateway = socket();
    gateway.stall();
    let active = 0;
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', onActive: () => { active++; } });
    const sends = chatSends(200);
    for (const f of sends) browser.feed(f);
    await tick();
    expect(browser.s.isPaused()).toBe(true);
    expect(gateway.s.writableLength).toBeLessThanOrEqual(gateway.s.writableHighWaterMark + sends[0]!.length);
    expect(active).toBeGreaterThan(0);
    const whileHeld = active;
    gateway.catchUp();
    for (let i = 0; i < 50 && texts(gateway.sent).length < sends.length; i++) await tick();
    expect(Buffer.concat(gateway.sent).equals(Buffer.concat(sends))).toBe(true);
    expect(browser.s.isPaused()).toBe(false);
    expect(active).toBeGreaterThan(whileHeld); // marked again as the gateway took them
    expect(texts(browser.sent)).toEqual([]);
    browser.s.destroy(); gateway.s.destroy();
  });

  it(`a browser that falls behind is still read: its pongs, and a stop with nothing kept, reach the gateway at once; its other requests, and a stop after them, are kept in order, up to GUEST_KEEP_LIMIT (${GUEST_KEEP_LIMIT / 1024} KB, then it is not read), and go once it catches up; the gateway is not read meanwhile`, async () => {
    const browser = socket(), gateway = socket();
    browser.stall();
    let active = 0;
    const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', onActive: () => { active++; } });
    const events = chatEvents(200);
    for (const f of events) gateway.feed(f);
    await tick();
    expect(gateway.s.isPaused()).toBe(true);
    expect(browser.s.isPaused()).toBe(false);
    expect(browser.s.writableLength).toBeLessThanOrEqual(browser.s.writableHighWaterMark + events[0]!.length);
    expect(active).toBe(0); // the gateway streaming to a slow browser is not the person
    // With nothing kept, their pong and their stop go at once.
    const pong = encodeFrame(0xa, Buffer.from('still here'), true);
    const abort = wire({ type: 'req', id: 'stop-1', method: 'chat.abort', params: { sessionKey: 's-0' } }, true);
    browser.feed(pong);
    browser.feed(abort);
    await tick();
    expect(Buffer.concat(gateway.sent).equals(Buffer.concat([pong, abort]))).toBe(true);
    // A stalled reader asking for its history (about 2 KB each), then sending, then stopping it: all kept, in order; a pong still goes.
    const asks = Array.from({ length: 40 }, (_, i) => wire({ type: 'req', id: `hist-${i}`, method: 'chat.history', params: { sessionKey: `s-${i}`, pad: 'h'.repeat(2000) } }, true));
    const say = wire({ type: 'req', id: 'say', method: 'chat.send', params: { sessionKey: 's-1', message: 'hello' } }, true);
    const stop = wire({ type: 'req', id: 'stop-2', method: 'chat.abort', params: { sessionKey: 's-1' } }, true);
    const pong2 = encodeFrame(0xa, Buffer.from('still here 2'), true);
    const heldBefore = splice.held();
    for (const a of [...asks.slice(0, 3), say, stop, pong2]) { browser.feed(a); await tick(); }
    expect(Buffer.concat(gateway.sent).equals(Buffer.concat([pong, abort, pong2]))).toBe(true);
    // The rest: kept up to GUEST_KEEP_LIMIT, counted in what the chat holds; then the browser is not read.
    for (const a of asks.slice(3)) browser.feed(a);
    await tick();
    expect(browser.s.isPaused()).toBe(true);
    const queue = [...asks.slice(0, 3), say, stop, ...asks.slice(3)];
    let unread = 0;
    while (asks.slice(asks.length - unread).reduce((n, a) => n + a.length, 0) < browser.s.readableLength) unread++;
    expect(asks.slice(asks.length - unread).reduce((n, a) => n + a.length, 0)).toBe(browser.s.readableLength);
    expect(unread).toBeGreaterThan(0);
    const keptBytes = queue.slice(0, queue.length - unread).reduce((n, a) => n + a.length, 0);
    expect(keptBytes).toBeGreaterThanOrEqual(GUEST_KEEP_LIMIT);
    expect(keptBytes - asks[0]!.length).toBeLessThan(GUEST_KEEP_LIMIT);
    expect(splice.held() - heldBefore).toBeGreaterThanOrEqual(GUEST_KEEP_LIMIT);
    expect(Buffer.concat(gateway.sent).equals(Buffer.concat([pong, abort, pong2]))).toBe(true);
    browser.catchUp();
    for (let i = 0; i < 100 && (texts(browser.sent).length < events.length || gateway.sent.length < queue.length + 3); i++) await tick();
    expect(texts(browser.sent).map((m) => m.seq)).toEqual(events.map((_, i) => i));
    // The send, then its stop.
    expect(Buffer.concat(gateway.sent).equals(Buffer.concat([pong, abort, pong2, ...queue]))).toBe(true);
    expect(texts(gateway.sent).map((m) => m.id).filter((id) => !String(id).startsWith('hist-'))).toEqual(['stop-1', 'say', 'stop-2']);
    expect(active).toBeGreaterThan(0);
    expect(gateway.s.isPaused()).toBe(false);
    expect(browser.s.isPaused()).toBe(false);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a browser that closes while requests of its are kept: its close goes at once, what is kept is dropped, and nothing it sends after is passed on', async () => {
    const browser = socket(), gateway = socket();
    browser.stall();
    const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    for (const f of chatEvents(20)) gateway.feed(f);
    await tick();
    const asks = Array.from({ length: 5 }, (_, i) => wire({ type: 'req', id: `hist-${i}`, method: 'chat.history', params: { pad: 'h'.repeat(2000) } }, true));
    for (const a of asks) browser.feed(a);
    await tick();
    expect(gateway.sent).toEqual([]);
    const heldKeeping = splice.held();
    const close = encodeFrame(0x8, Buffer.from([0x03, 0xe9]), true); // 1001: going away
    browser.feed(close);
    browser.feed(wire({ type: 'req', id: 'after', method: 'chat.send', params: { message: 'late' } }, true));
    await tick();
    expect(Buffer.concat(gateway.sent).equals(close)).toBe(true);
    expect(splice.held()).toBeLessThan(heldKeeping - asks.reduce((n, a) => n + a.length, 0) + 1);
    browser.catchUp();
    for (let i = 0; i < 20; i++) await tick();
    expect(Buffer.concat(gateway.sent).equals(close)).toBe(true);
    expect(frames(gateway.sent).map((f) => f.opcode)).toEqual([0x8]);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('while the browser is behind, the refusals it earns are bounded: past maxQueued it is closed with 1008', async () => {
    const limit = 20_000;
    const browser = socket(), gateway = socket();
    browser.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', maxQueued: limit });
    gateway.feed(wire({ type: 'event', event: 'chat', payload: { text: 'z'.repeat(15_000) } }, false));
    await tick();
    const refused = (n: number) => Buffer.concat(Array.from({ length: n }, (_, i) => wire({ type: 'req', id: `r${i}`, method: 'logs.tail', params: {} }, true)));
    browser.feed(refused(5));
    await tick();
    expect(closeOf(gateway.sent)).toBeUndefined();
    browser.feed(refused(100));
    await tick();
    expect(closeOf(gateway.sent)).toEqual({ code: 1008, reason: 'refused: too much waiting to be sent' });
    browser.s.destroy(); gateway.s.destroy();
  });

  it(`what one read of the browser earns in refusals is bounded on its own: past GUEST_REFUSAL_BUDGET (${GUEST_REFUSAL_BUDGET / 1024} KB) it is closed with 1008`, async () => {
    // A made-up method name is repeated in its refusal: about 1.1 KB each.
    const refused = (n: number) => Buffer.concat(Array.from({ length: n }, (_, i) => wire({ type: 'req', id: `r${i}`, method: `made.up${'x'.repeat(1000)}`, params: {} }, true)));
    for (const [n, closes] of [[200, false], [300, true]] as const) {
      const browser = socket(), gateway = socket();
      browser.stall();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      browser.feed(refused(n));
      await tick();
      // About 220 KB waits for 200; 300 are past it.
      expect(closeOf(gateway.sent)).toEqual(closes ? { code: 1008, reason: 'refused: too many answers waiting to be sent' } : undefined);
      browser.s.destroy(); gateway.s.destroy();
    }
  });

  it(`answers for requests the agent left unanswered are not charged to GUEST_REFUSAL_BUDGET: ${MAX_GUEST_PENDING} expiring at once do not close the guest`, async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    browser.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    // Long ids (within MAX_GUEST_ID_LENGTH): about 330 bytes an answer, over 300 KB in all.
    const id = (i: number) => `${i}-`.padEnd(200, 'p');
    expect(id(0).length).toBeLessThanOrEqual(MAX_GUEST_ID_LENGTH);
    browser.feed(Buffer.concat(Array.from({ length: MAX_GUEST_PENDING }, (_, i) => wire({ type: 'req', id: id(i), method: 'health', params: {} }, true))));
    await tick();
    vi.advanceTimersByTime(GUEST_REPLY_WAIT_MS + 1);
    await tick();
    expect(closeOf(gateway.sent)).toBeUndefined();
    browser.catchUp();
    for (let i = 0; i < 20; i++) await tick();
    const answers = texts(browser.sent);
    expect(answers).toHaveLength(MAX_GUEST_PENDING);
    expect(Buffer.concat(browser.sent).length).toBeGreaterThan(GUEST_REFUSAL_BUDGET);
    expect(answers.every((m) => m.error?.message?.includes('took too long'))).toBe(true);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('an ordinary reply does not hold the gateway back: only more than four pieces waiting does', async () => {
    const browser = socket(), gateway = socket();
    browser.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    const reply = (n: number) => wire({ type: 'event', event: 'chat', seq: n, payload: { text: 'r'.repeat(30_000) } }, false);
    gateway.feed(reply(1));
    await tick();
    expect(gateway.s.isPaused()).toBe(false);
    gateway.feed(reply(2));
    await tick();
    expect(gateway.s.isPaused()).toBe(false); // about 60 KB waits: not yet 64
    gateway.feed(reply(3));
    await tick();
    expect(gateway.s.isPaused()).toBe(true);
    browser.catchUp();
    await tick();
    expect(gateway.s.isPaused()).toBe(false);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a write that would leave more than maxQueued waiting for the gateway closes with 1011, naming it, and is not made; up to it, not', async () => {
    const limit = 10_000;
    for (const [bytes, closes] of [[limit, false], [limit + 1, true]] as const) {
      const browser = socket(), gateway = socket();
      gateway.stall();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', maxQueued: limit });
      const sent = pings(bytes);
      browser.feed(sent);
      await tick();
      gateway.catchUp();
      await tick();
      if (closes) {
        expect(closeOf(browser.sent)).toEqual({ code: 1011, reason: 'gateway: too much waiting to be sent to the gateway' });
        // The gateway gets what it was already handed (the first ping), then the close: what waited is dropped.
        const got = frames(gateway.sent);
        expect(got.map((f) => f.opcode)).toEqual([0x9, 0x8]);
      } else {
        expect(closeOf(browser.sent)).toBeUndefined();
        expect(Buffer.concat(gateway.sent).equals(sent)).toBe(true); // all of it waited, none refused
      }
      browser.s.destroy(); gateway.s.destroy();
    }
  });

  it('too much waiting for the browser closes with 1008', async () => {
    const browser = socket(), gateway = socket();
    browser.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', maxQueued: 10_000 });
    gateway.feed(Buffer.concat(Array.from({ length: 20 }, (_, i) => wire({ type: 'event', event: 'chat', seq: i, payload: { text: 'z'.repeat(1000) } }, false))));
    await tick();
    expect(closeOf(gateway.sent)).toEqual({ code: 1008, reason: 'refused: too much waiting to be sent' });
    browser.s.destroy(); gateway.s.destroy();
  });

  it('by default the allowance is the largest message and GUEST_QUEUE_SLACK', async () => {
    const maxMessage = 1024;
    const limit = maxMessage + GUEST_QUEUE_SLACK;
    for (const [bytes, closes] of [[limit, false], [limit + 1, true]] as const) {
      const browser = socket(), gateway = socket();
      gateway.stall();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', maxMessage });
      browser.feed(pings(bytes));
      await tick();
      expect(closeOf(browser.sent)?.code).toBe(closes ? 1011 : undefined);
      browser.s.destroy(); gateway.s.destroy();
    }
  });

  it(`a gateway that takes nothing for GUEST_STALL_MS closes the connection with 1011; at ${GUEST_STALL_MS - 1} ms, not`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    gateway.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    for (const f of chatSends(20)) browser.feed(f);
    await tick();
    expect(browser.s.isPaused()).toBe(true);
    vi.advanceTimersByTime(GUEST_STALL_MS - 1);
    await tick();
    expect(closeOf(browser.sent)).toBeUndefined();
    vi.advanceTimersByTime(1);
    await tick();
    expect(closeOf(browser.sent)).toEqual({ code: 1011, reason: 'gateway: took nothing it was sent for 60 s' });
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a browser that takes nothing for GUEST_STALL_MS closes the connection with 1008', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    browser.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    for (const f of chatEvents(20)) gateway.feed(f);
    await tick();
    vi.advanceTimersByTime(GUEST_STALL_MS);
    await tick();
    expect(closeOf(gateway.sent)).toEqual({ code: 1008, reason: 'refused: took nothing it was sent for 60 s' });
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a slow gateway that takes something within each GUEST_STALL_MS is not closed, and the browser it holds back stays active; a full one without, closed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    gateway.stall();
    let active = 0;
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', onActive: () => { active++; } });
    for (const f of chatSends(20)) browser.feed(f);
    await tick();
    for (let minute = 0; minute < 5; minute++) {
      const before = active;
      vi.advanceTimersByTime(GUEST_STALL_MS - 1);
      await tick();
      expect(closeOf(browser.sent)).toBeUndefined();
      gateway.takeOne();
      expect(active).toBeGreaterThan(before);
    }
    vi.advanceTimersByTime(GUEST_STALL_MS);
    await tick();
    expect(closeOf(browser.sent)).toEqual({ code: 1011, reason: 'gateway: took nothing it was sent for 60 s' });
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a slow browser that takes something within each GUEST_STALL_MS is not closed, and the gateway streaming to it is not activity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    browser.stall();
    let active = 0;
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', onActive: () => { active++; } });
    for (const f of chatEvents(20)) gateway.feed(f);
    await tick();
    for (let minute = 0; minute < 5; minute++) {
      vi.advanceTimersByTime(GUEST_STALL_MS - 1);
      await tick();
      browser.takeOne();
    }
    expect(closeOf(gateway.sent)).toBeUndefined();
    expect(active).toBe(0);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('an open tab that only pongs, pings and polls is not active: the person is, by each message and each piece of a slow upload', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    let active = 0;
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', onActive: () => { active++; } });
    for (let minute = 0; minute < 10; minute++) {
      browser.feed(encodeFrame(0xa, Buffer.from(`pong-${minute}`), true));
      browser.feed(encodeFrame(0x9, Buffer.from(`ping-${minute}`), true));
      browser.feed(wire({ type: 'req', id: `h${minute}`, method: 'health', params: {} }, true));
      browser.feed(wire({ type: 'req', id: `a${minute}`, method: 'agents.list', params: {} }, true));
      browser.feed(wire({ type: 'req', id: `c${minute}`, method: 'config.get', params: {} }, true)); // refused here
      await tick();
      vi.advanceTimersByTime(60_000);
    }
    expect(active).toBe(0);
    expect(texts(gateway.sent).map((m) => m.method).filter((m, i, all) => all.indexOf(m) === i)).toEqual(['health', 'agents.list']);
    // A 2 MB message arriving 64 KB at a time: active with each piece, though it is not whole until the end.
    const upload = wire({ type: 'req', id: 'big', method: 'chat.send', params: { message: 'see attached', attachment: 'u'.repeat(2 * 1024 * 1024) } }, true);
    const pieces = Math.ceil(upload.length / 65_536);
    for (let i = 0; i < pieces; i++) {
      const before = active;
      browser.feed(upload.subarray(i * 65_536, (i + 1) * 65_536));
      await tick();
      expect(active).toBeGreaterThan(before);
      vi.advanceTimersByTime(10_000);
    }
    expect(closeOf(browser.sent)).toBeUndefined();
    expect(texts(gateway.sent).at(-1)).toMatchObject({ id: 'big', method: 'chat.send' });
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a poll split across two reads is not the person; a small message split so counts once, when whole', async () => {
    const browser = socket(), gateway = socket();
    let active = 0;
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', onActive: () => { active++; } });
    const poll = wire({ type: 'req', id: 'h1', method: 'health', params: {} }, true);
    browser.feed(poll.subarray(0, 10));
    await tick();
    browser.feed(poll.subarray(10));
    await tick();
    expect(active).toBe(0);
    expect(texts(gateway.sent).map((m) => m.method)).toEqual(['health']);
    const say = wire({ type: 'req', id: 's1', method: 'chat.send', params: { message: 'hi' } }, true);
    browser.feed(say.subarray(0, 10));
    await tick();
    expect(active).toBe(0);
    browser.feed(say.subarray(10));
    await tick();
    expect(active).toBeGreaterThan(0);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('each piece of a large message still arriving counts as an upload; once whole, one that does not count (refused, a poll, a key given twice) is put back, a chat.send is not', async () => {
    const trickle = async (frame: Buffer, size = 1024) => {
      const browser = socket(), gateway = socket();
      const told: string[] = [];
      spliceGuest(browser.s, gateway.s, {
        identity: 'fixture-guest',
        onActive: (what) => told.push(what === 'upload' ? 'piece' : what === 'waiting' ? 'taken' : 'whole'),
        onUploadRefused: () => told.push('put back'),
      });
      for (let at = 0; at < frame.length; at += size) { browser.feed(frame.subarray(at, at + size)); await tick(); }
      const passed = texts(gateway.sent).map((m) => m.method);
      browser.s.destroy(); gateway.s.destroy();
      return { told, passed };
    };
    const big = (head: Record<string, unknown>, method: string) => ({ ...head, method, params: { message: 'w'.repeat(20_000) } });
    const putBack = (r: { told: string[] }) => {
      expect(r.told.filter((t) => t === 'piece').length).toBeGreaterThan(3);
      expect(r.told).not.toContain('whole');
      expect(r.told.at(-1)).toBe('put back');
    };
    // Refused here (not a guest's), a poll, not a request: each piece counted, then put back.
    putBack(await trickle(wire(big({ type: 'req', id: 'r1' }, 'logs.tail'), true)));
    const poll = await trickle(wire(big({ type: 'req', id: 'p1' }, 'health'), true));
    putBack(poll);
    expect(poll.passed).toEqual(['health']); // passed on, but not the person
    putBack(await trickle(wire(big({ type: 'event', id: 'e1' }, 'chat.send'), true)));
    // A key given twice is judged by the whole, as JSON.parse reads it: the last.
    const twice = await trickle(encodeFrame(0x1, Buffer.from(`{"type":"req","id":"d1","method":"chat.send","method":"logs.tail","params":{"message":"${'w'.repeat(20_000)}"}}`), true));
    putBack(twice);
    expect(twice.passed).toEqual([]);
    // In frames, the same.
    const text = JSON.stringify(big({ type: 'req', id: 'r2' }, 'logs.tail'));
    putBack(await trickle(Buffer.concat([0, 1, 2, 3].map((i) => {
      const f = encodeFrame(i ? 0x0 : 0x1, Buffer.from(text.slice(i * 5100, (i + 1) * 5100)), true);
      return i < 3 ? notLast(f) : f;
    }))));
    // A chat.send, its method first or last: counted from its first full piece, and kept.
    for (const msg of [big({ type: 'req', id: 's1' }, 'chat.send'), { type: 'req', id: 's2', params: { message: 'w'.repeat(20_000) }, method: 'chat.send' }]) {
      const send = await trickle(wire(msg, true));
      expect(send.told.filter((t) => t === 'piece').length).toBeGreaterThan(3);
      expect(send.told.filter((t) => t !== 'taken').at(-1)).toBe('whole'); // then the gateway taking it
      expect(send.told).not.toContain('put back');
      expect(send.passed).toEqual(['chat.send']);
    }
    // A small message is judged only when whole: no pieces.
    const small = await trickle(wire({ type: 'req', id: 's3', method: 'chat.send', params: { message: 'hi' } }, true), 8);
    expect(small.told.filter((t) => t === 'piece')).toEqual([]);
    expect(small.told).toContain('whole');
  });

  it('a large message that is not a request is refused as any other, whatever it names: answered, not closed', async () => {
    const browser = socket(), gateway = socket();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    const frame = wire({ type: 'event', id: 'e1', method: 'chat.send', params: { message: 'w'.repeat(20_000) } }, true);
    for (let at = 0; at < frame.length; at += 1024) { browser.feed(frame.subarray(at, at + 1024)); await tick(); }
    expect(closeOf(gateway.sent)).toBeUndefined();
    expect(closeOf(browser.sent)).toBeUndefined();
    expect(texts(browser.sent)).toEqual([{ type: 'res', id: 'e1', ok: false, error: { code: 'FORBIDDEN', message: expect.any(String) } }]);
    expect(texts(gateway.sent)).toEqual([]);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('while a message of theirs waits, the person is marked only as the gateway takes some of it: not for the gateway talking, nor the browser reading', async () => {
    const browser = socket(), gateway = socket();
    gateway.stall();
    let active = 0;
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', onActive: () => { active++; } });
    browser.feed(chatSends(1)[0]!); // about 10 KB: one piece, with the gateway
    await tick();
    const afterRead = active;
    for (const f of chatEvents(5)) gateway.feed(f); // the gateway talks, the browser takes it all
    await tick();
    expect(texts(browser.sent)).toHaveLength(5);
    expect(active).toBe(afterRead);
    gateway.takeOne();
    expect(active).toBe(afterRead + 1);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a message of theirs in many frames is the person with every piece the gateway takes, not only its last frame', async () => {
    const browser = socket(), gateway = socket();
    gateway.stall();
    let active = 0;
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', onActive: () => { active++; } });
    const text = JSON.stringify({ type: 'req', id: 'up', method: 'chat.send', params: { message: 'z'.repeat(100_000) } });
    const parts = Array.from({ length: 5 }, (_, i) => Buffer.from(text.slice(i * 20_100, (i + 1) * 20_100)));
    expect(Buffer.concat(parts).toString()).toBe(text);
    const msg = parts.map((p, i) => { const f = encodeFrame(i ? 0x0 : 0x1, p, true); return i < parts.length - 1 ? notLast(f) : f; });
    browser.feed(Buffer.concat(msg));
    await tick();
    const afterRead = active;
    // About 100 KB: seven pieces, the first six of them before the last frame.
    for (let piece = 1; piece <= 7; piece++) {
      gateway.takeOne();
      expect(active).toBe(afterRead + piece);
    }
    expect(Buffer.concat(gateway.sent).equals(Buffer.concat(msg))).toBe(true);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a pong held for a slow gateway is not the person; a message they sent is', async () => {
    const browser = socket(), gateway = socket();
    gateway.stall();
    let active = 0;
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', onActive: () => { active++; } });
    browser.feed(encodeFrame(0xa, Buffer.from('p1'), true));
    await tick();
    browser.feed(encodeFrame(0xa, Buffer.from('p2'), true));
    await tick();
    gateway.takeOne(); // the first taken, the second waits
    await tick();
    expect(active).toBe(0);
    browser.feed(wire({ type: 'req', id: 'm1', method: 'chat.send', params: { message: 'hi' } }, true));
    await tick();
    expect(active).toBeGreaterThan(0);
    const before = active;
    gateway.catchUp();
    await tick();
    expect(frames(gateway.sent).map((f) => f.opcode)).toEqual([0xa, 0xa, 0x1]);
    expect(active).toBeGreaterThan(before); // marked as each piece of theirs was taken
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a side that has taken everything is not closed however long it then waits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    browser.feed(wire({ type: 'req', id: 'm1', method: 'chat.send', params: { message: 'hi' } }, true));
    gateway.feed(wire({ type: 'event', event: 'chat', payload: { text: 'hello' } }, false));
    await tick();
    vi.advanceTimersByTime(10 * GUEST_STALL_MS);
    await tick();
    expect(closeOf(browser.sent)).toBeUndefined();
    expect(closeOf(gateway.sent)).toBeUndefined();
    expect(texts(gateway.sent).map((m) => m.id)).toEqual(['m1']);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('progress is seen piece by piece, even on a socket that merges what waits into one write (as net.Socket does)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // A socket with writev: what is written while a write is out goes in one
    // batch, and a batch is taken (its callback) only once every byte of it is.
    const pending: Array<{ left: number; cb: () => void }> = [];
    const out = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) { pending.push({ left: chunk.length, cb }); },
      writev(chunks, cb) { pending.push({ left: chunks.reduce((n, c) => n + (c.chunk as Buffer).length, 0), cb }); },
    });
    /** The reader takes `n` bytes. */
    const read = (n: number) => {
      while (n > 0 && pending.length) {
        const w = pending[0]!;
        const k = Math.min(n, w.left);
        w.left -= k; n -= k;
        if (!w.left) { pending.shift(); w.cb(); }
      }
    };
    const gateway = socket();
    spliceGuest(out, gateway.s, { identity: 'fixture-guest' });
    // A long history: one 2 MB message, read at 5 KB a second.
    const history = wire({ type: 'event', event: 'chat', payload: { text: 'h'.repeat(2 * 1024 * 1024) } }, false);
    gateway.feed(history);
    await tick();
    for (let s = 0; s < 3 * GUEST_STALL_MS / 1000; s++) {
      vi.advanceTimersByTime(1000);
      read(5_000);
      await tick();
    }
    expect(closeOf(gateway.sent)).toBeUndefined();
    out.destroy(); gateway.s.destroy();
  });
});

describe('a slow reader on a real socket (HB-0593)', () => {
  // A Unix socket: its kernel buffers are small and fixed (TCP's grow), so
  // most of what waits stays in this process, as it does for a phone on a
  // slow line. Node merges what waits for a socket into one write; before,
  // progress showed only when all of it was out.
  const dir = mkdtempSync(join(tmpdir(), 'hb-slow-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  const listen = (onConn: (s: net.Socket) => void) => new Promise<string>((r) => {
    const path = join(dir, `s${n++}`);
    net.createServer(onConn).listen(path, () => r(path));
  });

  it('a browser reading a long history slowly (400 KB/s, a stall limit of 1.5 s) is not closed, and gets all of it', async () => {
    let gatewayPeer: net.Socket | undefined;
    const upstream = net.connect(await listen((s) => { gatewayPeer = s; }));
    await new Promise((r) => upstream.once('connect', r));
    while (!gatewayPeer) await tick();
    const browser = net.connect(await listen((client) => spliceGuest(client, upstream, { identity: 'fixture-guest', stallMs: 1500 })));
    await new Promise((r) => browser.once('connect', r));
    const history = wire({ type: 'event', event: 'chat', payload: { text: 'h'.repeat(4 * 1024 * 1024) } }, false);
    gatewayPeer.write(history);
    const got: Buffer[] = [];
    let size = 0;
    // Three stall limits, 40 KB every 100 ms.
    for (let i = 0; i < 45; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const chunk = browser.read(Math.min(40_000, browser.readableLength)) as Buffer | null;
      if (chunk) { got.push(chunk); size += chunk.length; }
    }
    expect(size).toBeGreaterThan(1_000_000);
    expect(size).toBeLessThan(history.length);
    // The rest at full speed: it is all there, and nothing after it (a close frame).
    await new Promise<void>((done) => {
      const t = setTimeout(done, 5000);
      browser.on('data', (c: Buffer) => { got.push(c); size += c.length; if (size >= history.length) { clearTimeout(t); setTimeout(done, 100); } });
    });
    expect(Buffer.concat(got).equals(history)).toBe(true);
    browser.destroy(); upstream.destroy(); gatewayPeer.destroy();
  }, 20_000);
});

describe('a message comes in a bounded number of frames (HB-0594)', () => {
  const start = (payload: string) => notLast(encodeFrame(0x1, Buffer.from(payload), true));
  const more = (mask: boolean) => notLast(encodeFrame(0x0, Buffer.alloc(0), mask));
  const last = (mask: boolean) => encodeFrame(0x0, Buffer.alloc(0), mask);

  it(`from the browser: ${MAX_MESSAGE_FRAMES} frames are one message; one more ends the connection, however small they are`, async () => {
    {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', maxMessage: 64 });
      const msg = [start('{"type":"req","id":"f1","method":"chat.send","params":{}}'), ...Array.from({ length: MAX_MESSAGE_FRAMES - 2 }, () => more(true)), last(true)];
      browser.feed(Buffer.concat(msg));
      await tick();
      expect(closeOf(browser.sent)).toBeUndefined();
      expect(Buffer.concat(gateway.sent).equals(Buffer.concat(msg))).toBe(true);
      browser.s.destroy(); gateway.s.destroy();
    }
    {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', maxMessage: 64 });
      browser.feed(Buffer.concat([start(''), ...Array.from({ length: MAX_MESSAGE_FRAMES }, () => more(true))]));
      await tick();
      expect(closeOf(browser.sent)).toEqual({ code: 1008, reason: 'refused: message in too many frames' });
      expect(frames(gateway.sent).every((f) => f.opcode === 0x8)).toBe(true);
      browser.s.destroy(); gateway.s.destroy();
    }
    {
      // One more than MAX_MESSAGE_FRAMES in all, the last of them final: the final frame counts too.
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', maxMessage: 64 });
      const msg = [start('{"type":"req","id":"f2","method":"chat.send","params":{}}'), ...Array.from({ length: MAX_MESSAGE_FRAMES - 1 }, () => more(true)), last(true)];
      expect(msg).toHaveLength(MAX_MESSAGE_FRAMES + 1);
      browser.feed(Buffer.concat(msg));
      await tick();
      expect(closeOf(browser.sent)).toEqual({ code: 1008, reason: 'refused: message in too many frames' });
      expect(frames(gateway.sent).every((f) => f.opcode === 0x8)).toBe(true);
      browser.s.destroy(); gateway.s.destroy();
    }
  });

  it('from the gateway: the same', async () => {
    {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', maxMessage: 64 });
      const msg = [notLast(encodeFrame(0x1, Buffer.from('{"type":"event","event":"chat"}'), false)), ...Array.from({ length: MAX_MESSAGE_FRAMES - 2 }, () => more(false)), last(false)];
      gateway.feed(Buffer.concat(msg));
      await tick();
      expect(closeOf(browser.sent)).toBeUndefined();
      expect(Buffer.concat(browser.sent).equals(Buffer.concat(msg))).toBe(true);
      browser.s.destroy(); gateway.s.destroy();
    }
    {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', maxMessage: 64 });
      gateway.feed(Buffer.concat([notLast(encodeFrame(0x1, Buffer.alloc(0), false)), ...Array.from({ length: MAX_MESSAGE_FRAMES }, () => more(false))]));
      await tick();
      expect(closeOf(browser.sent)).toEqual({ code: 1011, reason: 'gateway: message in too many frames' });
      browser.s.destroy(); gateway.s.destroy();
    }
  });
});

describe('what is held for a message not finished is not kept for ever, nor without bound across a guest\'s consoles (HB-0594)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const start = (payload: Buffer | string, mask: boolean) => notLast(encodeFrame(0x1, Buffer.from(payload), mask));
  const more = (payload: Buffer | string, mask: boolean) => notLast(encodeFrame(0x0, Buffer.from(payload), mask));

  it(`a browser that sends part of a message and then nothing for GUEST_STALL_MS is closed with 1008; while more keeps coming, not`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Part of a frame…
    {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      const whole = wire({ type: 'req', id: 's1', method: 'chat.send', params: { message: 'half' } }, true);
      browser.feed(whole.subarray(0, 20));
      await tick();
      vi.advanceTimersByTime(GUEST_STALL_MS - 1);
      expect(closeOf(browser.sent)).toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(closeOf(browser.sent)).toEqual({ code: 1008, reason: 'refused: stopped sending' });
      expect(closeOf(gateway.sent)).toEqual({ code: 1008, reason: 'refused: stopped sending' });
      expect(texts(gateway.sent)).toEqual([]);
      browser.s.destroy(); gateway.s.destroy();
    }
    // …or frames of a message, more arriving within each GUEST_STALL_MS, then none.
    {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      browser.feed(start('{"type":"req","id":"s2","method":"chat.send","params":{"message":"', true));
      await tick();
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(GUEST_STALL_MS - 1000);
        browser.feed(more('slow ', true));
        await tick();
      }
      expect(closeOf(browser.sent)).toBeUndefined();
      vi.advanceTimersByTime(GUEST_STALL_MS);
      expect(closeOf(browser.sent)).toEqual({ code: 1008, reason: 'refused: stopped sending' });
      browser.s.destroy(); gateway.s.destroy();
    }
    // A finished message leaves nothing to wait for: an idle tab is not closed by this.
    {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      const whole = wire({ type: 'req', id: 's3', method: 'chat.send', params: { message: 'whole' } }, true);
      browser.feed(whole.subarray(0, 20));
      await tick();
      browser.feed(whole.subarray(20));
      await tick();
      vi.advanceTimersByTime(10 * GUEST_STALL_MS);
      expect(closeOf(browser.sent)).toBeUndefined();
      browser.s.destroy(); gateway.s.destroy();
    }
  });

  it('a gateway that does the same is closed with 1011, naming it; but not while it is held back for a browser that is behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      gateway.feed(start('{"type":"event","event":"chat","payload":', false));
      await tick();
      vi.advanceTimersByTime(GUEST_STALL_MS);
      expect(closeOf(browser.sent)).toEqual({ code: 1011, reason: 'gateway: stopped sending' });
      browser.s.destroy(); gateway.s.destroy();
    }
    {
      const browser = socket(), gateway = socket();
      browser.stall();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      // A long event the browser is slow to take (seven pieces), and the start of the next in the same read.
      const long = wire({ type: 'event', event: 'chat', payload: { text: 'h'.repeat(100_000) } }, false);
      gateway.feed(Buffer.concat([long, start('{"type":"event","event":"chat","payload":', false)]));
      await tick();
      expect(gateway.s.isPaused()).toBe(true);
      // The browser takes a piece every 50 s (not stalled); the gateway is not
      // read meanwhile, more than GUEST_STALL_MS in all, and not closed for it.
      let waited = 0;
      while (gateway.s.isPaused()) {
        vi.advanceTimersByTime(50_000);
        waited += 50_000;
        browser.takeOne();
        await tick();
        expect(closeOf(gateway.sent)).toBeUndefined();
      }
      expect(waited).toBeGreaterThan(GUEST_STALL_MS);
      browser.catchUp();
      await tick();
      expect(frames(browser.sent).filter((f) => f.opcode === 0x1)).toHaveLength(1);
      // Read again, its message still unfinished and nothing more coming
      // (what it sent meanwhile would be read now): closed GUEST_STALL_MS later.
      vi.advanceTimersByTime(GUEST_STALL_MS);
      expect(closeOf(gateway.sent)).toEqual({ code: 1011, reason: 'gateway: stopped sending' });
      browser.s.destroy(); gateway.s.destroy();
    }
  });

  it(`one guest's consoles together hold at most maxGuestHeld (by default GUEST_HELD_LIMIT, ${GUEST_HELD_LIMIT / 1024 / 1024} MB): the one that pushes past it is closed, the others stay; one alone is not`, async () => {
    const limit = 200_000;
    let total = 0; // what ConsoleAccess.addGuestHeld keeps
    const countHeld = (change: number) => (total += change);
    const open = () => {
      const browser = socket(), gateway = socket();
      const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', countHeld, maxGuestHeld: limit });
      return { browser, gateway, splice };
    };
    // One holds 120 KB of a message not finished (a frame of 400 KB, begun).
    const a = open();
    const big = wire({ type: 'req', id: 'big', method: 'chat.send', params: { message: 'b'.repeat(400_000) } }, true);
    a.browser.feed(big.subarray(0, 120_000));
    await tick();
    expect(a.splice.held()).toBe(120_000 + 64); // its bytes, and what the chunk they came in costs
    expect(total).toBe(a.splice.held());
    // Another queues 100 KB for a gateway that is not taking it: together past the limit, so this one is closed.
    const b = open();
    b.gateway.stall();
    b.browser.feed(wire({ type: 'req', id: 'q', method: 'chat.send', params: { message: 'q'.repeat(100_000) } }, true));
    await tick();
    expect(closeOf(b.browser.sent)).toEqual({ code: 1008, reason: 'refused: your open chats hold too much at once; close one and reload' });
    expect(b.splice.held()).toBe(0);
    expect(total).toBe(a.splice.held()); // given back
    expect(closeOf(a.browser.sent)).toBeUndefined();
    // The first carries on, past the limit on its own: closing another would free nothing, its own limits apply.
    a.browser.feed(big.subarray(120_000, 300_000));
    await tick();
    expect(closeOf(a.browser.sent)).toBeUndefined();
    expect(total).toBe(300_000 + 2 * 64);
    a.browser.feed(big.subarray(300_000));
    await tick();
    expect(closeOf(a.browser.sent)).toBeUndefined();
    expect(texts(a.gateway.sent).map((m) => m.id)).toEqual(['big']);
    for (const x of [a, b]) { x.browser.s.destroy(); x.gateway.s.destroy(); }
    await tick();
    expect(total).toBe(0);
  });

  it('one chat with a 30 MB upload under way and a 32 MB reply waiting stays open: a message in frames is counted once', async () => {
    let total = 0;
    const browser = socket(), gateway = socket();
    browser.stall();
    const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', countHeld: (change) => (total += change) });
    // The upload, in frames of 1 MB, all but its last sent.
    const text = Buffer.from(JSON.stringify({ type: 'req', id: 'up', method: 'chat.send', params: { message: 'see attached', attachment: 'u'.repeat(30_000_000) } }));
    const parts = Array.from({ length: Math.ceil(text.length / 1_000_000) }, (_, i) => text.subarray(i * 1_000_000, (i + 1) * 1_000_000));
    const upload = parts.map((p, i) => { const f = encodeFrame(i ? 0x0 : 0x1, p, true); return i < parts.length - 1 ? notLast(f) : f; });
    for (const f of upload.slice(0, -1)) browser.feed(f);
    await tick();
    // The reply, for a browser slow to take it.
    const reply = wire({ type: 'event', event: 'chat', payload: { text: 'r'.repeat(32_000_000) } }, false);
    gateway.feed(reply);
    await tick();
    expect(closeOf(gateway.sent)).toBeUndefined();
    // Held: the reply waiting, and the upload's frames as read, once each.
    const framed = upload.slice(0, -1).reduce((n, f) => n + f.length, 0);
    expect(splice.held()).toBe(reply.length + framed);
    expect(total).toBe(splice.held());
    // The browser takes the reply, then sends the rest of its upload.
    browser.catchUp();
    for (let i = 0; i < 50 && frames(browser.sent).length < 1; i++) await tick();
    browser.feed(upload.at(-1)!);
    for (let i = 0; i < 10 && gateway.sent.length < upload.length; i++) await tick();
    expect(closeOf(gateway.sent)).toBeUndefined();
    expect(Buffer.concat(gateway.sent).equals(Buffer.concat(upload))).toBe(true);
    expect(closeOf(browser.sent)).toBeUndefined();
    browser.s.destroy(); gateway.s.destroy();
  }, 30_000);

  it('a side held back by the proxy has GUEST_STALL_MS from when it is read again: paused 59 s, it is not closed at 60', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    browser.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    const long = wire({ type: 'event', event: 'chat', payload: { text: 'h'.repeat(100_000) } }, false);
    gateway.feed(Buffer.concat([long, start('{"type":"event","event":"chat","payload":', false)]));
    await tick();
    expect(gateway.s.isPaused()).toBe(true);
    vi.advanceTimersByTime(59_000);
    browser.catchUp();
    await tick();
    expect(gateway.s.isPaused()).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(closeOf(gateway.sent)).toBeUndefined();
    vi.advanceTimersByTime(GUEST_STALL_MS - 1_001);
    expect(closeOf(gateway.sent)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(closeOf(gateway.sent)).toEqual({ code: 1011, reason: 'gateway: stopped sending' });
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a 32 MB frame read 64 KB at a time is copied once, when it is whole', () => {
    const frame = encodeFrame(0x1, Buffer.alloc(32 * 1024 * 1024, 0x61), false);
    const chunks = Array.from({ length: Math.ceil(frame.length / 65_536) }, (_, i) => frame.subarray(i * 65_536, (i + 1) * 65_536));
    const reader = new FrameReader(32 * 1024 * 1024);
    const concat = vi.spyOn(Buffer, 'concat');
    let got: ReturnType<FrameReader['push']> = [];
    let calls: Parameters<typeof Buffer.concat>[] = [];
    try {
      for (const c of chunks) got = got.concat(reader.push(c));
      calls = [...concat.mock.calls];
    } finally {
      concat.mockRestore();
    }
    expect(got).toHaveLength(1);
    expect(got[0]!.raw.equals(frame)).toBe(true);
    expect(got[0]!.payload.length).toBe(32 * 1024 * 1024);
    const copied = calls.reduce((n, [list, len]) => n + (len ?? (list as Buffer[]).reduce((m, b) => m + b.length, 0)), 0);
    expect(calls).toHaveLength(1);
    expect(copied).toBe(frame.length);
    expect(reader.buffered).toBe(0);
  });

  it('pings and pongs are not a message\'s bytes: a part followed only by pings is closed at GUEST_STALL_MS', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    browser.feed(start('{"type":"req","id":"p1","method":"chat.send","params":{"message":"', true));
    await tick();
    vi.advanceTimersByTime(GUEST_STALL_MS - 1000);
    browser.feed(encodeFrame(0x9, Buffer.from('still here'), true));
    browser.feed(encodeFrame(0xa, Buffer.from('still here'), true));
    await tick();
    vi.advanceTimersByTime(999);
    expect(closeOf(browser.sent)).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(closeOf(browser.sent)).toEqual({ code: 1008, reason: 'refused: stopped sending' });
    browser.s.destroy(); gateway.s.destroy();
  });

  it(`a message must be whole within MESSAGE_DEADLINE_MS (${MESSAGE_DEADLINE_MS / 60_000} min) of its first bytes, however they come; the next has its own`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      browser.feed(start('{"type":"req","id":"t1","method":"chat.send","params":{"message":"', true));
      await tick();
      // A little more every 59 s: never stalled.
      let t = 0;
      while (t + 59_000 < MESSAGE_DEADLINE_MS) {
        vi.advanceTimersByTime(59_000);
        t += 59_000;
        browser.feed(more('trickle ', true));
        await tick();
      }
      expect(closeOf(browser.sent)).toBeUndefined();
      vi.advanceTimersByTime(MESSAGE_DEADLINE_MS - t - 1);
      expect(closeOf(browser.sent)).toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(closeOf(browser.sent)).toEqual({ code: 1008, reason: `refused: took over ${MESSAGE_DEADLINE_MS / 60_000} minutes to send one message` });
      browser.s.destroy(); gateway.s.destroy();
    }
    {
      // One finished at 9 minutes, the next begun in the same read: its deadline starts there.
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      browser.feed(start('{"type":"req","id":"t2","method":"chat.send","params":{"message":"', true));
      await tick();
      for (let i = 0; i < 9; i++) { vi.advanceTimersByTime(60_000 - 1); browser.feed(more('m', true)); await tick(); }
      browser.feed(Buffer.concat([encodeFrame(0x0, Buffer.from('"}}'), true), start('{"type":"req","id":"t3","method":"chat.send","params":{"message":"', true)]));
      await tick();
      const sent = Buffer.concat(frames(gateway.sent).filter((f) => f.opcode < 0x8).map((f) => f.payload)).toString();
      expect(JSON.parse(sent).id).toBe('t2');
      // Past the first one's deadline, not past its own.
      for (let i = 0; i < 11; i++) { vi.advanceTimersByTime(50_000); browser.feed(more('n', true)); await tick(); }
      vi.advanceTimersByTime(MESSAGE_DEADLINE_MS - 11 * 50_000 - 1);
      expect(closeOf(browser.sent)).toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(closeOf(browser.sent)?.reason).toContain('minutes to send one message');
      browser.s.destroy(); gateway.s.destroy();
    }
  });

  it(`only time a side is free to send counts toward its MESSAGE_DEADLINE_MS: a gateway mid-message, held back 17 minutes for a phone slowly downloading a long history, is not closed; once free, it has what was left`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const browser = socket(), gateway = socket();
    browser.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    // A long history (about 500 KB), and in the same read the first frame of the next message.
    const history = Array.from({ length: 50 }, (_, i) => wire({ type: 'event', event: 'chat', seq: i, payload: { text: 'y'.repeat(10_000) } }, false));
    const next = JSON.stringify({ type: 'event', event: 'chat', seq: 'next', payload: { text: 'r'.repeat(200) } });
    gateway.feed(Buffer.concat([...history, notLast(encodeFrame(0x1, Buffer.from(next.slice(0, 10)), false))]));
    await tick();
    expect(gateway.s.isPaused()).toBe(true);
    // The phone takes a piece every 50 s for 17 minutes: still behind.
    for (let t = 0; t < 17 * 60_000; t += 50_000) {
      await vi.advanceTimersByTimeAsync(50_000);
      browser.takeOne();
      await tick();
    }
    expect(gateway.s.isPaused()).toBe(true);
    expect(closeOf(gateway.sent)).toBeUndefined();
    browser.catchUp();
    await tick();
    expect(gateway.s.isPaused()).toBe(false);
    // Free again: a little more every 50 s, and its ten minutes run out (not reset by the pause).
    let free = 0;
    for (let i = 0; i < 11; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
      free += 50_000;
      gateway.feed(notLast(encodeFrame(0x0, Buffer.from(' '), false)));
      await tick();
    }
    expect(closeOf(gateway.sent)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(MESSAGE_DEADLINE_MS - free + 5);
    expect(closeOf(gateway.sent)).toEqual({ code: 1011, reason: `gateway: took over ${MESSAGE_DEADLINE_MS / 60_000} minutes to send one message` });
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a header that comes a byte at a time, then a body in 10,000 tiny chunks, is read in linear work; each chunk held counts for more than its bytes', () => {
    const body = Buffer.alloc(100_000, 0x62);
    const frame = encodeFrame(0x1, body, true);
    expect(frame.length - body.length).toBe(14);
    const reader = new FrameReader(1 << 20);
    const concat = vi.spyOn(Buffer, 'concat');
    const got: WsFrame[] = [];
    let calls: Parameters<typeof Buffer.concat>[] = [];
    let mid = { held: 0, buffered: 0 };
    try {
      for (let i = 0; i < 14; i++) got.push(...reader.push(frame.subarray(i, i + 1)));
      expect(reader.partial).toEqual({ opcode: 1, length: body.length });
      for (let at = 14, n = 0; at < frame.length; at += 10, n++) {
        got.push(...reader.push(frame.subarray(at, at + 10)));
        if (n === 5000) mid = { held: reader.held, buffered: reader.buffered };
      }
      calls = [...concat.mock.calls];
    } finally {
      concat.mockRestore();
    }
    expect(got).toHaveLength(1);
    expect(got[0]!.payload.equals(body)).toBe(true);
    // Each chunk is gone over a few times at most, not once for every read after it.
    const walked = calls.reduce((n, [list]) => n + (list as Buffer[]).length, 0);
    expect(calls.length).toBeLessThan(20);
    expect(walked).toBeLessThan(2 * (14 + 10_000));
    expect(mid.held).toBeGreaterThanOrEqual(mid.buffered + 64 * 5000);
  });

  it('a message in frames is unmasked once, into one buffer, when it is whole: not as each frame comes', async () => {
    const into = vi.spyOn(WsFrame.prototype, 'payloadInto');
    const payload = vi.spyOn(WsFrame.prototype, 'payload', 'get');
    try {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      const text = Buffer.from(JSON.stringify({ type: 'req', id: 'up', method: 'chat.send', params: { message: 'f'.repeat(50_000) } }));
      const parts = Array.from({ length: 5 }, (_, i) => text.subarray(i * 10_100, (i + 1) * 10_100));
      const msg = parts.map((p, i) => { const f = encodeFrame(i ? 0x0 : 0x1, p, true); return i < parts.length - 1 ? notLast(f) : f; });
      for (const f of msg.slice(0, -1)) browser.feed(f);
      await tick();
      expect(into).not.toHaveBeenCalled();
      expect(payload).not.toHaveBeenCalled();
      browser.feed(msg.at(-1)!);
      await tick();
      expect(into).toHaveBeenCalledTimes(5);
      expect(payload).not.toHaveBeenCalled();
      expect(Buffer.concat(gateway.sent).equals(Buffer.concat(msg))).toBe(true);
      browser.s.destroy(); gateway.s.destroy();
    } finally {
      into.mockRestore();
      payload.mockRestore();
    }
  });

  it('a console can be closed by the caller with a code and reason both sides read', async () => {
    const browser = socket(), gateway = socket();
    const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    splice.close(1001, 'opened in another tab');
    await tick();
    expect(closeOf(browser.sent)).toEqual({ code: 1001, reason: 'opened in another tab' });
    expect(closeOf(gateway.sent)).toEqual({ code: 1001, reason: 'opened in another tab' });
    browser.s.destroy(); gateway.s.destroy();
  });

  it("the gateway closing while what waits for the browser is still being written: its close is answered at once; all that waits goes first, then the gateway's close, its code and reason; with nothing waiting, at once", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gatewayClose = (code: number, reason: string) => {
      const p = Buffer.alloc(2 + Buffer.byteLength(reason));
      p.writeUInt16BE(code, 0);
      p.write(reason, 2);
      return encodeFrame(0x8, p, false);
    };
    {
      const browser = socket(), gateway = socket();
      browser.stall();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      const big = wire({ type: 'event', event: 'chat', payload: { text: 'q'.repeat(40_000) } }, false);
      const close = gatewayClose(4001, 'gateway policy changed');
      gateway.feed(Buffer.concat([big, close, wire({ type: 'event', event: 'after' }, false)]));
      await tick();
      // Its close is answered at once, with the same code.
      expect(frames(gateway.sent).map((f) => f.opcode)).toEqual([0x8]);
      expect(closeOf(gateway.sent)).toEqual({ code: 4001, reason: '' });
      gateway.s.destroy(); // and its connection ends
      await tick();
      expect(browser.sent).toHaveLength(1); // a piece of it being written
      expect(browser.s.destroyed).toBe(false);
      browser.catchUp();
      for (let i = 0; i < 20; i++) await tick();
      expect(Buffer.concat(browser.sent).equals(Buffer.concat([big, close]))).toBe(true);
      expect(closeOf(browser.sent)).toEqual({ code: 4001, reason: 'gateway policy changed' });
      vi.advanceTimersByTime(50);
      expect(browser.s.destroyed).toBe(true);
    }
    {
      // Nothing waiting: at once. A code no endpoint may send becomes 1000.
      for (const [code, expected] of [[4001, 4001], [1006, 1000]] as const) {
        const browser = socket(), gateway = socket();
        spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
        gateway.feed(gatewayClose(code, 'bye'));
        await tick();
        expect(closeOf(browser.sent)?.code).toBe(expected);
        // Answered with the same code; one no endpoint may send, with none.
        expect(frames(gateway.sent).filter((f) => f.opcode === 0x8).map((f) => (f.payload.length ? f.payload.readUInt16BE(0) : 'none'))).toEqual([code === 1006 ? 'none' : code]);
        browser.s.destroy(); gateway.s.destroy();
      }
    }
    {
      // A browser that takes nothing more is still closed by its stall.
      const browser = socket(), gateway = socket();
      browser.stall();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', stallMs: 1000 });
      gateway.feed(Buffer.concat([wire({ type: 'event', event: 'chat', payload: { text: 'q'.repeat(40_000) } }, false), gatewayClose(4001, 'bye')]));
      await tick();
      gateway.s.destroy();
      await tick();
      vi.advanceTimersByTime(1000 + 50);
      expect(browser.s.destroyed).toBe(true);
    }
  });

  it('closed in the middle of a frame to it, nothing more is written there (the rest could not be read), and the connection ends; with none begun, only the close frame', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    {
      const browser = socket(), gateway = socket();
      browser.stall();
      const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      const big = wire({ type: 'event', event: 'chat', payload: { text: 'q'.repeat(40_000) } }, false);
      gateway.feed(big);
      await tick();
      expect(browser.sent).toHaveLength(1); // its first piece, not yet taken
      splice.close(1001, 'opened in another tab');
      browser.catchUp();
      await tick();
      expect(browser.sent).toHaveLength(1);
      expect(big.subarray(0, browser.sent[0]!.length).equals(browser.sent[0]!)).toBe(true);
      expect(closeOf(gateway.sent)).toEqual({ code: 1001, reason: 'opened in another tab' }); // nothing part written there
      vi.advanceTimersByTime(50);
      expect(browser.s.destroyed).toBe(true);
      expect(gateway.s.destroyed).toBe(true);
    }
    {
      const browser = socket(), gateway = socket();
      const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      gateway.feed(wire({ type: 'event', event: 'chat', payload: { text: 'small' } }, false));
      await tick();
      const before = browser.sent.length;
      splice.close(1001, 'opened in another tab');
      await tick();
      expect(browser.sent).toHaveLength(before + 1);
      expect(closeOf([browser.sent.at(-1)!])).toEqual({ code: 1001, reason: 'opened in another tab' });
      browser.s.destroy(); gateway.s.destroy();
    }
  });
});

describe('a close the browser starts, and what counts as being answered (HB-0593)', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const closeWith = (code: number, masked: boolean) => encodeFrame(0x8, Buffer.from([code >> 8, code & 0xff]), masked);

  it('a close the browser starts goes to the gateway once: its answer is not answered, and the end sends no other', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const how of ['the gateway answers', 'closed here'] as const) {
      const browser = socket(), gateway = socket();
      const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      browser.feed(closeWith(1001, true));
      await tick();
      if (how === 'the gateway answers') gateway.feed(closeWith(1001, false));
      else splice.close(1000, '');
      await tick();
      vi.advanceTimersByTime(50);
      expect(frames(gateway.sent).filter((f) => f.opcode === 0x8)).toHaveLength(1);
      expect(closeOf(gateway.sent)?.code).toBe(1001);
      expect(closeOf(browser.sent)?.code).toBe(how === 'the gateway answers' ? 1001 : 1000);
      browser.s.destroy(); gateway.s.destroy();
    }
  });

  it('a browser behind on 30 MB that sends its close gets the answer to it without the rest: only the frame part written is finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    browser.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    const MB = 1024 * 1024;
    const events = Array.from({ length: 30 }, (_, i) => wire({ type: 'event', event: 'chat', seq: i, payload: { text: 'z'.repeat(MB - 100) } }, false));
    gateway.feed(Buffer.concat(events));
    await tick();
    expect(browser.sent).toHaveLength(1); // the first piece, not taken
    browser.feed(closeWith(1001, true));
    await tick();
    expect(frames(gateway.sent).map((f) => f.opcode)).toEqual([0x8]);
    gateway.feed(closeWith(1001, false));
    await tick();
    browser.catchUp();
    for (let i = 0; i < 50; i++) await tick();
    const got = frames(browser.sent);
    expect(got.map((f) => f.opcode)).toEqual([0x1, 0x8]);
    expect(JSON.parse(got[0]!.payload.toString()).seq).toBe(0);
    expect(closeOf(browser.sent)?.code).toBe(1001);
    expect(Buffer.concat(browser.sent).length).toBe(events[0]!.length + 4);
    expect(frames(gateway.sent).filter((f) => f.opcode === 0x8)).toHaveLength(1);
    vi.advanceTimersByTime(50);
    expect(browser.s.destroyed).toBe(true);
  });

  it("being answered counts only chat events for the guest's own session", async () => {
    const realNow = performance.now.bind(performance);
    let ahead = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + ahead);
    const scope = { agentId: 'recipe', sessionKey: 'agent:recipe:guest:fixture-one' };
    const browser = socket(), gateway = socket();
    const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', scope });
    expect(splice.answering()).toBe(false);
    // A run of theirs, acknowledged, then quiet past every bound.
    browser.feed(wire({ type: 'req', id: 's1', method: 'chat.send', params: { message: 'hi', idempotencyKey: 'run-1' } }, true));
    await tick();
    gateway.feed(wire({ type: 'res', id: 's1', ok: true, payload: { runId: 'run-1', status: 'started' } }, false));
    await tick();
    ahead += 11 * 60_000;
    expect(splice.answering()).toBe(false);
    gateway.feed(wire({ type: 'event', event: 'chat', payload: { runId: 'run-1', sessionKey: 'agent:recipe:guest:fixture-two', state: 'delta' } }, false));
    gateway.feed(wire({ type: 'event', event: 'chat', payload: { runId: 'run-1', state: 'delta' } }, false));
    await tick();
    expect(splice.answering()).toBe(false);
    gateway.feed(wire({ type: 'event', event: 'chat', payload: { runId: 'run-1', sessionKey: scope.sessionKey, state: 'delta' } }, false));
    await tick();
    expect(splice.answering()).toBe(true);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a chat.send whose id is too long to keep is not followed: it does not make the chat answering', async () => {
    const browser = socket(), gateway = socket();
    const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', scope: { agentId: 'recipe', sessionKey: 'agent:recipe:guest:fixture-one' } });
    browser.feed(wire({ type: 'req', id: 'x'.repeat(MAX_GUEST_ID_LENGTH + 1), method: 'chat.send', params: { message: 'hi' } }, true));
    await tick();
    expect(texts(gateway.sent).map((m) => m.method)).toEqual(['chat.send']); // sent, not followed
    expect(splice.answering()).toBe(false);
    browser.feed(wire({ type: 'req', id: 'x'.repeat(MAX_GUEST_ID_LENGTH), method: 'chat.send', params: { message: 'hi' } }, true));
    await tick();
    expect(splice.answering()).toBe(true);
    browser.s.destroy(); gateway.s.destroy();
  });

  it(`once the gateway has closed, the browser has GUEST_DRAIN_MS (${GUEST_DRAIN_MS / 1000} s) to take what waits, however steadily it takes it; then the connection is ended`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browser = socket(), gateway = socket();
    browser.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    gateway.feed(Buffer.concat([wire({ type: 'event', event: 'chat', payload: { text: 'q'.repeat(400_000) } }, false), closeWith(1000, false)]));
    await tick();
    // A piece every 4 s: never stalled.
    for (let i = 0; i < 7; i++) { vi.advanceTimersByTime(4000); browser.takeOne(); await tick(); }
    expect(browser.s.destroyed).toBe(false);
    vi.advanceTimersByTime(GUEST_DRAIN_MS - 28_000);
    await tick();
    expect(browser.s.destroyed).toBe(true);
    expect(gateway.s.destroyed).toBe(true);
  });

  it('while the browser takes what waits after the gateway closed, what the console holds is told as it goes down', async () => {
    const browser = socket(), gateway = socket();
    browser.stall();
    let total = 0;
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', countHeld: (change) => (total += change) });
    gateway.feed(Buffer.concat([wire({ type: 'event', event: 'chat', payload: { text: 'q'.repeat(200_000) } }, false), closeWith(1000, false)]));
    await tick();
    const atClose = total;
    expect(atClose).toBeGreaterThan(150_000);
    for (let i = 0; i < 5; i++) { browser.takeOne(); await tick(); }
    expect(browser.s.destroyed).toBe(false);
    expect(total).toBeLessThanOrEqual(atClose - 5 * 16_384);
    browser.catchUp();
    for (let i = 0; i < 20; i++) await tick();
    expect(total).toBe(0);
    browser.s.destroy(); gateway.s.destroy();
  });

  it("a chat.send is being answered until its run's last chat event: not ended by the ack, nor by another reply under its id; a refusal ends it", async () => {
    const realNow = performance.now.bind(performance);
    let ahead = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + ahead);
    const minutes = (n: number) => { ahead += n * 60_000; };
    const scope = { agentId: 'recipe', sessionKey: 'agent:recipe:guest:fixture-one' };
    const browser = socket(), gateway = socket();
    const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', scope });
    browser.feed(wire({ type: 'req', id: 'x', method: 'chat.send', params: { message: 'hi', idempotencyKey: 'run-x' } }, true));
    browser.feed(wire({ type: 'req', id: 'x', method: 'health', params: {} }, true));
    browser.feed(wire({ type: 'req', id: 'x', method: 'chat.history', params: {} }, true));
    await tick();
    // health's reply is rewritten: it goes under an id of the proxy's own, never one of theirs.
    const ours = texts(gateway.sent).find((m) => m.method === 'health')!.id;
    expect(ours).toMatch(/^hatchabot-[0-9a-f]{24}-\d+$/);
    gateway.feed(wire({ type: 'res', id: ours, ok: true, payload: { ok: true } }, false));
    // chat.history's comes under their id, but names no run: not chat.send's.
    gateway.feed(wire({ type: 'res', id: 'x', ok: true, payload: { messages: [] } }, false));
    await tick();
    expect(texts(browser.sent).filter((m) => m.id === 'x')).toHaveLength(2);
    minutes(3);
    expect(splice.answering()).toBe(true);
    // The ack (the run started), then three minutes with nothing: still answering.
    gateway.feed(wire({ type: 'res', id: 'x', ok: true, payload: { runId: 'run-x', status: 'started' } }, false));
    await tick();
    minutes(3);
    expect(splice.answering()).toBe(true);
    // Another session's last chat event for a run of the same name ends nothing; theirs does, two minutes on.
    gateway.feed(wire({ type: 'event', event: 'chat', payload: { runId: 'run-x', sessionKey: 'agent:recipe:guest:fixture-two', state: 'final' } }, false));
    await tick();
    minutes(2.5);
    expect(splice.answering()).toBe(true);
    gateway.feed(wire({ type: 'event', event: 'chat', payload: { runId: 'run-x', sessionKey: scope.sessionKey, state: 'final' } }, false));
    await tick();
    expect(splice.answering()).toBe(true);
    minutes(2.5);
    expect(splice.answering()).toBe(false);
    // A refusal ends one at once.
    browser.feed(wire({ type: 'req', id: 'y', method: 'chat.send', params: { message: 'again', idempotencyKey: 'run-y' } }, true));
    await tick();
    expect(splice.answering()).toBe(true);
    gateway.feed(wire({ type: 'res', id: 'y', ok: false, error: { code: 'UNAVAILABLE', message: 'busy' } }, false));
    await tick();
    minutes(2.5);
    expect(splice.answering()).toBe(false);
    browser.s.destroy(); gateway.s.destroy();
  });

  it("a message of theirs taken by the gateway while an upload of theirs arrives is told as taken, not as a piece of the upload: what a put-back keeps (GuestActivity)", async () => {
    const browser = socket(), gateway = socket();
    gateway.stall();
    const told: string[] = [];
    spliceGuest(browser.s, gateway.s, {
      identity: 'fixture-guest',
      onActive: (what) => told.push(what === 'upload' ? 'piece' : what === 'waiting' ? 'taken' : 'whole'),
      onUploadRefused: () => told.push('put back'),
    });
    // A chat.send of theirs, in pieces for a slow gateway.
    browser.feed(wire({ type: 'req', id: 's1', method: 'chat.send', params: { message: 'm'.repeat(40_000) } }, true));
    await tick();
    expect(told).toEqual(['whole']);
    // An upload starts (one refused once whole); meanwhile the gateway takes a piece of the chat.send.
    const upload = wire({ type: 'req', id: 'u1', method: 'logs.tail', params: { pad: 'w'.repeat(20_000) } }, true);
    browser.feed(upload.subarray(0, 4096));
    await tick();
    gateway.takeOne();
    await tick();
    browser.feed(upload.subarray(4096));
    await tick();
    expect(told).toEqual(['whole', 'piece', 'taken', 'put back']);
    gateway.takeOne();
    await tick();
    expect(told.at(-1)).toBe('taken');
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a control frame over 125 bytes, or in fragments, closes the chat with 1002 and is not passed on: from either side', async () => {
    const cases = [
      { from: 'browser', frame: encodeFrame(0x9, Buffer.alloc(126, 1), true), reason: 'refused: a control frame over 125 bytes' },
      { from: 'browser', frame: notLast(encodeFrame(0x9, Buffer.from('ping'), true)), reason: 'refused: a control frame in fragments' },
      { from: 'gateway', frame: encodeFrame(0x9, Buffer.alloc(126, 1), false), reason: 'gateway: a control frame over 125 bytes' },
      { from: 'gateway', frame: notLast(encodeFrame(0xa, Buffer.from('pong'), false)), reason: 'gateway: a control frame in fragments' },
    ] as const;
    for (const c of cases) {
      const browser = socket(), gateway = socket();
      spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
      const [from, to] = c.from === 'browser' ? [browser, gateway] : [gateway, browser];
      from.feed(c.frame);
      await tick();
      expect(frames(to.sent).map((f) => f.opcode)).toEqual([0x8]);
      expect(closeOf(to.sent)).toEqual({ code: 1002, reason: c.reason });
      expect(closeOf(from.sent)).toEqual({ code: 1002, reason: c.reason });
      browser.s.destroy(); gateway.s.destroy();
    }
  });

  it('an upload put back goes to the last activity that was not the upload: a message of theirs the gateway took meanwhile is kept', () => {
    const realNow = performance.now.bind(performance);
    let ahead = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + ahead);
    vi.useFakeTimers({ toFake: ['Date'] });
    const minutes = (n: number) => { ahead += n * 60_000; vi.setSystemTime(Date.now() + n * 60_000); };
    const at = (x: GuestActivity) => ({ usedAt: x.usedAt, wallAt: x.wallAt });
    const a = new GuestActivity();
    minutes(3); a.mark('upload');
    minutes(1); a.mark('waiting');
    const taken = at(a);
    minutes(1); a.mark('upload');
    a.putBack();
    expect(at(a)).toEqual(taken);
    // With nothing else meanwhile, back to before the upload.
    const b = new GuestActivity();
    const before = at(b);
    minutes(3); b.mark('upload');
    minutes(1); b.mark('upload');
    b.putBack();
    expect(at(b)).toEqual(before);
    // A whole message ends the upload: nothing to put back.
    minutes(1); b.mark('upload');
    minutes(1); b.mark();
    const whole = at(b);
    b.putBack();
    expect(at(b)).toEqual(whole);
    // Taken with no upload arriving: plain activity.
    minutes(1); b.mark('waiting');
    const plain = at(b);
    b.putBack();
    expect(at(b)).toEqual(plain);
    expect(plain.usedAt).toBeGreaterThan(whole.usedAt);
  });

  it("only the console that asked is being answered: another tab on the same session, seeing the same run's events, is not", async () => {
    const realNow = performance.now.bind(performance);
    let ahead = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + ahead);
    const scope = { agentId: 'recipe', sessionKey: 'agent:recipe:guest:fixture-one' };
    const [a, b] = [0, 1].map(() => {
      const browser = socket(), gateway = socket();
      return { browser, gateway, splice: spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', scope }) };
    }) as [{ browser: ReturnType<typeof socket>; gateway: ReturnType<typeof socket>; splice: ReturnType<typeof spliceGuest> }, { browser: ReturnType<typeof socket>; gateway: ReturnType<typeof socket>; splice: ReturnType<typeof spliceGuest> }];
    a.browser.feed(wire({ type: 'req', id: 's1', method: 'chat.send', params: { message: 'hi', idempotencyKey: 'run-a' } }, true));
    await tick();
    a.gateway.feed(wire({ type: 'res', id: 's1', ok: true, payload: { runId: 'run-a', status: 'started' } }, false));
    await tick();
    ahead += 3 * 60_000;
    for (const side of [a, b]) {
      side.gateway.feed(wire({ type: 'event', event: 'agent', payload: { runId: 'run-a', sessionKey: scope.sessionKey, stream: 'tool', data: {} } }, false));
      side.gateway.feed(wire({ type: 'event', event: 'chat', payload: { runId: 'run-a', sessionKey: scope.sessionKey, state: 'delta' } }, false));
    }
    await tick();
    expect(texts(b.browser.sent).map((m) => m.event)).toEqual(['agent', 'chat']); // it sees them
    expect(a.splice.answering()).toBe(true);
    expect(b.splice.answering()).toBe(false);
    for (const side of [a, b]) { side.browser.s.destroy(); side.gateway.s.destroy(); }
  });

  it('a run started with the agent method, or acknowledged as "accepted", is followed like a chat.send: being answered until its result', async () => {
    const realNow = performance.now.bind(performance);
    let ahead = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + ahead);
    const minutes = (n: number) => { ahead += n * 60_000; };
    const scope = { agentId: 'recipe', sessionKey: 'agent:recipe:guest:fixture-one' };
    const browser = socket(), gateway = socket();
    const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest', scope });
    browser.feed(wire({ type: 'req', id: 'r1', method: 'agent', params: { message: 'hello', idempotencyKey: 'run-1' } }, true));
    await tick();
    gateway.feed(wire({ type: 'res', id: 'r1', ok: true, payload: { runId: 'run-1', status: 'accepted' } }, false));
    await tick();
    minutes(5);
    expect(splice.answering()).toBe(true);
    // Its result, the second reply under the same id: ended.
    gateway.feed(wire({ type: 'res', id: 'r1', ok: true, payload: { runId: 'run-1', status: 'ok' } }, false));
    await tick();
    expect(splice.answering()).toBe(false);
    // A chat.send acknowledged "accepted": the same, until its run's last chat event.
    browser.feed(wire({ type: 'req', id: 's2', method: 'chat.send', params: { message: 'again', idempotencyKey: 'run-2' } }, true));
    await tick();
    gateway.feed(wire({ type: 'res', id: 's2', ok: true, payload: { runId: 'run-2', status: 'accepted' } }, false));
    await tick();
    minutes(5);
    expect(splice.answering()).toBe(true);
    gateway.feed(wire({ type: 'event', event: 'chat', payload: { runId: 'run-2', sessionKey: scope.sessionKey, state: 'final' } }, false));
    await tick();
    minutes(2.5);
    expect(splice.answering()).toBe(false);
    browser.s.destroy(); gateway.s.destroy();
  });

  it('a browser held back when the gateway closes is read again while what waits for it goes: what it sends then is dropped', async () => {
    const browser = socket(), gateway = socket();
    browser.stall();
    gateway.stall();
    spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    // Over BEHIND waiting for a stalled gateway: the browser is not read.
    browser.feed(wire({ type: 'req', id: 's1', method: 'chat.send', params: { message: 'm'.repeat(100_000) } }, true));
    await tick();
    browser.feed(wire({ type: 'req', id: 's2', method: 'chat.send', params: { message: 'later' } }, true));
    await tick();
    expect(browser.s.readableFlowing).toBe(false);
    expect(browser.s.readableLength).toBeGreaterThan(0);
    // The gateway sends some and closes; the browser has it still to take.
    gateway.feed(Buffer.concat([wire({ type: 'event', event: 'chat', payload: { text: 'q'.repeat(40_000) } }, false), closeWith(1001, false)]));
    await tick();
    expect(browser.s.destroyed).toBe(false);
    expect(browser.s.readableFlowing).toBe(true);
    expect(browser.s.readableLength).toBe(0);
    expect(texts(gateway.sent).map((m) => m.id)).not.toContain('s2');
    browser.s.destroy(); gateway.s.destroy();
  });

  it("the browser's close, still waiting for a slow gateway when the chat is closed, is written then: the gateway is told", async () => {
    const browser = socket(), gateway = socket();
    gateway.stall();
    const splice = spliceGuest(browser.s, gateway.s, { identity: 'fixture-guest' });
    browser.feed(wire({ type: 'req', id: 'h1', method: 'chat.history', params: {} }, true));
    await tick();
    browser.feed(wire({ type: 'req', id: 'h2', method: 'chat.history', params: {} }, true));
    const close = closeWith(1001, true);
    browser.feed(close);
    await tick();
    expect(gateway.sent).toHaveLength(1); // h1, not taken yet; h2 and the close wait
    splice.close(1001, 'opened in another tab');
    gateway.catchUp(); // h1 taken: what the socket held after it is written
    await tick();
    expect(frames(gateway.sent).map((f) => f.opcode)).toEqual([0x1, 0x8]);
    expect(gateway.sent.at(-1)!.equals(close)).toBe(true);
    browser.s.destroy(); gateway.s.destroy();
  });
});
