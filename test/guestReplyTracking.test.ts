/**
 * A guest's health and agents.list replies are rewritten (other people's
 * sessions taken out), so each must be found for its request. A request the
 * proxy could not follow to its reply used to go through, and its reply
 * reached the guest as the gateway sent it (deep audit of v2.166.2, #009).
 * Found by the guest's own id, a reply could also be taken for another's:
 * under an id two requests shared, or a second reply to one request, a reply
 * consumed the entry and the health reply after it passed unscrubbed
 * (HB-0592, deep audit of v2.177.0). Such requests are now sent under an id
 * of the proxy's own; every other request goes as it came, unfollowed. Fake
 * sockets, no gateway: the fake gateway answers each request under the id it
 * was sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Duplex } from 'node:stream';
import { CONSOLE_POLLS, encodeFrame, FrameReader, GUEST_REPLY_WAIT_MS, GUEST_REWRITTEN_REPLIES, GuestReplies, MAX_GUEST_ID_LENGTH, MAX_GUEST_PENDING, spliceGuest } from '../src/api/consoleProxy.js';

function socket() {
  const sent: Buffer[] = [];
  const s = new Duplex({ read() {}, write(chunk, _enc, cb) { sent.push(Buffer.from(chunk)); cb(); } });
  return { s, sent, feed: (b: Buffer) => s.push(b) };
}
const tick = () => new Promise((r) => setImmediate(r));
const wire = (v: unknown, masked: boolean) => encodeFrame(1, Buffer.from(JSON.stringify(v)), masked);
const texts = (bs: Buffer[]) => new FrameReader(1 << 24).push(Buffer.concat(bs)).filter((f) => f.opcode === 1).map((f) => JSON.parse(f.payload.toString()));
/** The close frame sent, if any: its code and reason. */
const closeOf = (bs: Buffer[]) => {
  const f = new FrameReader(1 << 24).push(Buffer.concat(bs)).find((x) => x.opcode === 0x8);
  return f && { code: f.payload.readUInt16BE(0), reason: f.payload.subarray(2).toString() };
};
const health = (id?: string | number) => ({ type: 'req', ...(id !== undefined ? { id } : {}), method: 'health', params: {} });
const req = (id: string, method: string) => ({ type: 'req', id, method, params: {} });
const SECRET_KEY = 'agent:meal-planner:someone-elses-session';
const PRIVATE = { agents: [{ agentId: 'meal-planner', sessions: { count: 1, recent: [{ key: SECRET_KEY }] } }] };

function splice() {
  const client = socket(), upstream = socket();
  spliceGuest(client.s, upstream.s, { identity: 'fixture-guest' });
  return { client, upstream, close: () => { client.s.destroy(); upstream.s.destroy(); } };
}

describe('a guest request whose reply could not be rewritten is answered here, never sent', () => {
  it('the replies rewritten and the console polls are two lists, named here so a change to either is deliberate', () => {
    // What gets scrubbed (and so followed to its reply)…
    expect([...GUEST_REWRITTEN_REPLIES]).toEqual(['health', 'agents.list']);
    // …and what is not the person, for the idle limit. The same today, by chance.
    expect([...CONSOLE_POLLS]).toEqual(['health', 'agents.list']);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('one not answered within GUEST_REPLY_WAIT_MS is forgotten: a full cap clears with time, and a late answer is dropped', async () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const { client, upstream, close } = splice();
    client.feed(Buffer.concat(Array.from({ length: MAX_GUEST_PENDING }, (_, i) => wire(health(`poll-${i}`), true))));
    await tick();
    const sent = texts(upstream.sent);
    expect(sent).toHaveLength(MAX_GUEST_PENDING);
    client.feed(wire(health('full'), true));
    await tick();
    expect(texts(client.sent).map((m) => [m.id, m.error?.code])).toEqual([['full', 'UNAVAILABLE']]);
    vi.advanceTimersByTime(GUEST_REPLY_WAIT_MS - 1);
    client.feed(wire(health('still-full'), true));
    await tick();
    expect(texts(client.sent).at(-1)).toMatchObject({ id: 'still-full', ok: false });
    vi.advanceTimersByTime(1);
    client.feed(wire(health('served'), true));
    await tick();
    const asked = texts(upstream.sent).at(-1);
    expect(texts(upstream.sent)).toHaveLength(MAX_GUEST_PENDING + 1);
    // A late answer to a forgotten request goes nowhere; the new one is answered under its own id.
    upstream.feed(wire({ type: 'res', id: sent[0].id, ok: true, payload: PRIVATE }, false));
    upstream.feed(wire({ type: 'res', id: asked.id, ok: true, payload: PRIVATE }, false));
    await tick();
    const answered = texts(client.sent).filter((m) => m.ok);
    expect(answered.map((m) => m.id)).toEqual(['served']);
    // The forgotten ones were each told so, under their own ids.
    const tooLong = texts(client.sent).filter((m) => m.error?.message?.includes('took too long'));
    expect(tooLong.map((m) => m.id)).toEqual(sent.map((_, i) => `poll-${i}`));
    expect(JSON.stringify(texts(client.sent))).not.toContain(SECRET_KEY);
    close();
  });

  it('a followed request the gateway never answers is answered here after GUEST_REPLY_WAIT_MS, under its own id; its late answer is dropped', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
    const { client, upstream, close } = splice();
    client.feed(wire(health('h1'), true));
    await tick();
    const [asked] = texts(upstream.sent);
    vi.advanceTimersByTime(GUEST_REPLY_WAIT_MS - 1);
    await tick();
    expect(texts(client.sent)).toEqual([]);
    vi.advanceTimersByTime(2);
    await tick();
    expect(texts(client.sent)).toEqual([{ type: 'res', id: 'h1', ok: false, error: { code: 'UNAVAILABLE', message: '"health" got no answer: the agent took too long to answer.' } }]);
    upstream.feed(wire({ type: 'res', id: asked.id, ok: true, payload: PRIVATE }, false));
    await tick();
    expect(texts(client.sent)).toHaveLength(1);
    close();
  });

  it('the wait is timed by a clock that only goes forward: the wall clock set forward or back moves nothing', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const replies = new GuestReplies();
    replies.track('h1', 'health');
    // Set forward a day (a clock corrected, a laptop's resume): nothing is due yet.
    vi.setSystemTime(Date.now() + 24 * 3600_000);
    expect(replies.prune()).toEqual([]);
    // Set back a day: still due within GUEST_REPLY_WAIT_MS, not a day and more.
    vi.setSystemTime(Date.now() - 48 * 3600_000);
    expect(replies.nextDue()).toBeLessThanOrEqual(GUEST_REPLY_WAIT_MS);
    expect(replies.size).toBe(1);
  });

  it('a reply or event that cannot be scrubbed is dropped, and a followed request it answers is answered with an error; the connection stays', async () => {
    const errors: unknown[] = [];
    const client = socket(), upstream = socket();
    spliceGuest(client.s, upstream.s, { identity: 'fixture-guest', onScrubError: (e) => errors.push(e) });
    client.feed(wire(health('deep'), true));
    await tick();
    const [asked] = texts(upstream.sent);
    // Nested too deep to be written out again (JSON.stringify throws): the gateway's, but Hatchabot's failure.
    const nested = `{"type":"res","id":"${asked.id}","ok":true,"payload":{"agents":[${'['.repeat(20_000)}${']'.repeat(20_000)}]}}`;
    upstream.feed(encodeFrame(1, Buffer.from(nested), false));
    // A health event the same way: dropped, nothing to answer.
    upstream.feed(encodeFrame(1, Buffer.from(`{"type":"event","event":"health","payload":{"x":${'['.repeat(20_000)}${']'.repeat(20_000)}}}`), false));
    upstream.feed(wire({ type: 'event', event: 'chat', payload: { text: 'still here' } }, false));
    await tick();
    expect(errors).toHaveLength(2);
    const got = texts(client.sent);
    expect(got).toEqual([
      { type: 'res', id: 'deep', ok: false, error: { code: 'UNAVAILABLE', message: expect.stringContaining('"health" was answered in a form') } },
      { type: 'event', event: 'chat', payload: { text: 'still here' } },
    ]);
    expect(closeOf(client.sent)).toBeUndefined();
    client.s.destroy(); upstream.s.destroy();
  });

  it('a hello that cannot be scrubbed closes the chat (1011), which would otherwise wait for it for ever; logged, not blamed on the gateway', async () => {
    const errors: unknown[] = [];
    const client = socket(), upstream = socket();
    spliceGuest(client.s, upstream.s, { identity: 'fixture-guest', onScrubError: (e) => errors.push(e) });
    client.feed(wire(req('c1', 'connect'), true));
    await tick();
    upstream.feed(encodeFrame(1, Buffer.from(`{"type":"res","id":"c1","ok":true,"payload":{"type":"hello-ok","snapshot":{"health":{"x":${'['.repeat(20_000)}${']'.repeat(20_000)}}}}}`), false));
    upstream.feed(wire({ type: 'event', event: 'chat', payload: { text: 'after' } }, false));
    await tick();
    expect(errors).toHaveLength(1);
    expect(texts(client.sent)).toEqual([]);
    expect(closeOf(client.sent)).toEqual({ code: 1011, reason: 'Hatchabot could not prepare this chat' });
    expect(closeOf(upstream.sent)).toEqual({ code: 1011, reason: 'Hatchabot could not prepare this chat' });
    client.s.destroy(); upstream.s.destroy();
  });

  it("what the gateway sends that is not a JSON object is never passed on as it came: the chat is closed (1011), as a request it answered would wait for ever, and it is logged", async () => {
    const someoneElse = { mode: 'webchat', host: 'someone-elses-phone', user: { name: 'someone-else' } };
    const cases: Array<[string, Buffer]> = [
      // A followed request's reply, cut short, other people's sessions in it.
      ['a text message that is not JSON', encodeFrame(1, Buffer.from(JSON.stringify({ type: 'res', id: 'ours', ok: true, payload: PRIVATE }).slice(0, -1)), false)],
      // A chat.send's answer the same way: nothing would ever answer it.
      ['a text message that is not JSON', encodeFrame(1, Buffer.from(`not json ${SECRET_KEY}`), false)],
      ['a binary message', encodeFrame(2, Buffer.from(SECRET_KEY), false)],
      // A batch: an array of messages, presence among them.
      ['a JSON array', wire([{ type: 'event', event: 'presence', payload: { presence: [someoneElse] } }, { type: 'res', id: 's1', ok: true, payload: { key: SECRET_KEY } }], false)],
      ['a JSON value that is not an object', wire(SECRET_KEY, false)],
      ['a JSON value that is not an object', wire(null, false)],
      ['a JSON value that is not an object', wire(42, false)],
    ];
    for (const [what, frame] of cases) {
      const errors: unknown[] = [];
      const client = socket(), upstream = socket();
      spliceGuest(client.s, upstream.s, { identity: 'fixture-guest', onScrubError: (e) => errors.push(e) });
      client.feed(wire(req('s1', 'chat.send'), true));
      await tick();
      upstream.feed(frame);
      upstream.feed(wire({ type: 'event', event: 'chat', payload: { text: 'after' } }, false));
      await tick();
      expect(errors.map((e) => (e as Error).message), what).toEqual([expect.stringContaining(`the gateway sent ${what}`)]);
      expect(JSON.stringify(errors.map((e) => (e as Error).message))).not.toContain(SECRET_KEY);
      const bytes = Buffer.concat(client.sent).toString();
      expect(bytes).not.toContain(SECRET_KEY);
      expect(bytes).not.toContain('someone-else');
      expect(texts(client.sent)).toEqual([]);
      expect(closeOf(client.sent)).toEqual({ code: 1011, reason: "Hatchabot could not read the agent's answer" });
      expect(closeOf(upstream.sent)).toEqual({ code: 1011, reason: "Hatchabot could not read the agent's answer" });
      client.s.destroy(); upstream.s.destroy();
    }
  });

  it('past the cap: refused while the others wait, accepted again once one is answered — and every reply that goes back is scrubbed', async () => {
    const { client, upstream, close } = splice();
    client.feed(Buffer.concat(Array.from({ length: MAX_GUEST_PENDING + 1 }, (_, i) => wire(health(String(i)), true))));
    await tick();
    const sent = texts(upstream.sent);
    expect(sent).toHaveLength(MAX_GUEST_PENDING);
    const refused = texts(client.sent);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ type: 'res', id: String(MAX_GUEST_PENDING), ok: false, error: { code: 'UNAVAILABLE' } });
    expect(refused[0].error.message).toContain('too many requests are waiting');
    upstream.feed(wire({ type: 'res', id: sent[0].id, ok: true, payload: PRIVATE }, false));
    await tick();
    client.feed(wire(health('again'), true));
    await tick();
    expect(texts(upstream.sent)).toHaveLength(MAX_GUEST_PENDING + 1);
    const again = texts(upstream.sent).at(-1);
    expect(again.method).toBe('health');
    upstream.feed(wire({ type: 'res', id: again.id, ok: true, payload: PRIVATE }, false));
    await tick();
    const answered = texts(client.sent).filter((m) => m.ok);
    expect(answered.map((m) => m.id)).toEqual(['0', 'again']);
    for (const r of answered) expect(r.payload.agents[0].sessions.recent).toEqual([]);
    close();
  });

  it('only those requests are counted: unanswered chat requests take no place, and chat goes through at the cap', async () => {
    const { client, upstream, close } = splice();
    // More unanswered chat requests than the cap: none is followed, so none holds anything.
    client.feed(Buffer.concat(Array.from({ length: MAX_GUEST_PENDING + 5 }, (_, i) => wire(req(`c${i}`, 'chat.send'), true))));
    client.feed(wire(health('h'), true));
    await tick();
    expect(texts(client.sent)).toEqual([]);
    expect(texts(upstream.sent)).toHaveLength(MAX_GUEST_PENDING + 6);
    // Health requests up to the cap, unanswered: chat still goes through.
    client.feed(Buffer.concat(Array.from({ length: MAX_GUEST_PENDING - 1 }, (_, i) => wire(health(`h${i}`), true))));
    client.feed(wire(req('after-cap', 'chat.send'), true));
    await tick();
    expect(texts(upstream.sent).at(-1).id).toBe('after-cap');
    expect(texts(client.sent)).toEqual([]);
    close();
  });

  it(`an id of up to ${MAX_GUEST_ID_LENGTH} characters is followed; a longer one is refused under that id (each id waiting is remembered)`, async () => {
    const { client, upstream, close } = splice();
    const longest = 'i'.repeat(MAX_GUEST_ID_LENGTH);
    client.feed(wire(health(longest), true));
    client.feed(wire(health(`${longest}x`), true));
    // Requests that are not followed keep their ids, whatever their length.
    client.feed(wire(req(`${longest}y`, 'chat.history'), true));
    await tick();
    expect(texts(upstream.sent).map((m) => m.method)).toEqual(['health', 'chat.history']);
    const [refused] = texts(client.sent);
    expect(refused).toMatchObject({ id: `${longest}x`, ok: false, error: { code: 'UNAVAILABLE' } });
    expect(refused.error.message).toContain('its id is too long');
    close();
  });

  it('a refusal is answered under the id as the guest sent it: a number stays a number', async () => {
    const { client, upstream, close } = splice();
    client.feed(wire({ type: 'req', id: 7, method: 'logs.tail', params: {} }, true));
    client.feed(Buffer.concat(Array.from({ length: MAX_GUEST_PENDING }, (_, i) => wire(health(`p${i}`), true))));
    client.feed(wire(health(4242), true));
    await tick();
    expect(texts(upstream.sent)).toHaveLength(MAX_GUEST_PENDING);
    expect(texts(client.sent).map((m) => [m.id, m.error.code])).toEqual([[7, 'FORBIDDEN'], [4242, 'UNAVAILABLE']]);
    close();
  });

  it('a health request without an id is refused (its reply could not be matched)', async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(health(), true));
    await tick();
    expect(texts(upstream.sent)).toHaveLength(0);
    expect(texts(client.sent)[0]).toMatchObject({ ok: false, id: null, error: { code: 'UNAVAILABLE' } });
    expect(texts(client.sent)[0].error.message).toContain('it has no id');
    close();
  });
});

describe('a rewritten reply is bound to its own request (HB-0592)', () => {
  it("the audit's order: a request, then a health request under its id while it waits — the health reply is scrubbed whichever comes first", async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(req('same', 'chat.history'), true));
    client.feed(wire(health('same'), true));
    await tick();
    const [history, asked] = texts(upstream.sent);
    expect(history).toEqual(req('same', 'chat.history'));
    expect(asked.method).toBe('health');
    expect(asked.id).not.toBe('same');
    upstream.feed(wire({ type: 'res', id: 'same', ok: true, payload: { messages: [] } }, false));
    upstream.feed(wire({ type: 'res', id: asked.id, ok: true, payload: PRIVATE }, false));
    await tick();
    const got = texts(client.sent);
    expect(got.map((m) => m.id)).toEqual(['same', 'same']);
    expect(got[0].payload).toEqual({ messages: [] });
    expect(got[1].payload.agents[0].sessions.recent).toEqual([]);
    expect(JSON.stringify(got)).not.toContain(SECRET_KEY);
    close();
  });

  it('requests may share an id (1 and "1" too): each is sent, each health reply is scrubbed and given its own id back', async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(health(1), true));
    client.feed(wire(req('1', 'chat.history'), true));
    client.feed(wire(health('1'), true));
    await tick();
    const [first, history, second] = texts(upstream.sent);
    expect(history.id).toBe('1');
    expect(first.id).not.toBe(second.id);
    // The gateway answers the other way round.
    upstream.feed(wire({ type: 'res', id: '1', ok: true, payload: { messages: [] } }, false));
    upstream.feed(wire({ type: 'res', id: second.id, ok: true, payload: PRIVATE }, false));
    upstream.feed(wire({ type: 'res', id: first.id, ok: true, payload: PRIVATE }, false));
    await tick();
    const got = texts(client.sent);
    expect(got.map((m) => m.id)).toEqual(['1', '1', 1]);
    for (const r of got.slice(1)) expect(r.payload.agents[0].sessions.recent).toEqual([]);
    expect(JSON.stringify(got)).not.toContain(SECRET_KEY);
    close();
  });

  it('a second reply to one request (agent\'s "accepted", then its result) cannot take a health reply\'s place', async () => {
    const { client, upstream, close } = splice();
    client.feed(wire({ type: 'req', id: 'run-1', method: 'agent', params: { message: 'hello' } }, true));
    await tick();
    upstream.feed(wire({ type: 'res', id: 'run-1', ok: true, payload: { runId: 'r1', status: 'accepted' } }, false));
    await tick();
    client.feed(wire(health('run-1'), true));
    await tick();
    const asked = texts(upstream.sent).at(-1);
    expect(asked).toMatchObject({ type: 'req', method: 'health', params: {} });
    // The agent's result comes first, under the same id; then the health reply, under the id the gateway was sent.
    upstream.feed(wire({ type: 'res', id: 'run-1', ok: true, payload: { runId: 'r1', status: 'ok' } }, false));
    upstream.feed(wire({ type: 'res', id: asked.id, ok: true, payload: PRIVATE }, false));
    await tick();
    const got = texts(client.sent);
    expect(got.map((m) => m.id)).toEqual(['run-1', 'run-1', 'run-1']);
    expect(got[1].payload.status).toBe('ok');
    expect(got[2].payload.agents[0].sessions.recent).toEqual([]);
    expect(JSON.stringify(got)).not.toContain(SECRET_KEY);
    close();
  });

  it("the guest's id never reaches the gateway on a rewritten request, and the proxy's id never reaches the guest", async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(health('mine'), true));
    await tick();
    const [asked] = texts(upstream.sent);
    expect(asked.id).not.toBe('mine');
    expect({ ...asked, id: 'mine' }).toEqual(health('mine'));
    upstream.feed(wire({ type: 'res', id: asked.id, ok: false, error: { code: 'UNAVAILABLE', message: 'busy' } }, false));
    await tick();
    const [refusal] = texts(client.sent);
    expect(refusal).toEqual({ type: 'res', id: 'mine', ok: false, error: { code: 'UNAVAILABLE', message: 'busy' } });
    expect(JSON.stringify(texts(client.sent))).not.toContain(asked.id);
    close();
  });

  it("a reply under one of the proxy's ids that nothing waits for is not passed on", async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(health('h1'), true));
    await tick();
    const [asked] = texts(upstream.sent);
    upstream.feed(wire({ type: 'res', id: asked.id, ok: true, payload: PRIVATE }, false));
    upstream.feed(wire({ type: 'res', id: asked.id, ok: true, payload: PRIVATE }, false));
    // An id of the proxy's that was never handed out.
    upstream.feed(wire({ type: 'res', id: asked.id.replace(/\d+$/, '99'), ok: true, payload: PRIVATE }, false));
    await tick();
    const got = texts(client.sent);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe('h1');
    expect(JSON.stringify(got)).not.toContain(SECRET_KEY);
    close();
  });

  it('a refusal of a rewritten request (ok: false, or no ok at all) loses only a payload it carries: its error and other fields are kept', async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(health('h3'), true));
    client.feed(wire(health('h4'), true));
    await tick();
    const [a, b] = texts(upstream.sent);
    upstream.feed(wire({ type: 'res', id: a.id, ok: false, error: { code: 'UNAVAILABLE', message: 'busy' }, retryAfterMs: 500, payload: PRIVATE }, false));
    upstream.feed(wire({ type: 'res', id: b.id, seq: 9, payload: PRIVATE }, false));
    await tick();
    expect(texts(client.sent)).toEqual([
      { type: 'res', id: 'h3', ok: false, error: { code: 'UNAVAILABLE', message: 'busy' }, retryAfterMs: 500 },
      { type: 'res', id: 'h4', ok: false, seq: 9 },
    ]);
    close();
  });

  it("a rewritten reply keeps the gateway's other fields: only its id and payload change", async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(health('h5'), true));
    client.feed(wire(health('h6'), true));
    await tick();
    const [a, b] = texts(upstream.sent);
    upstream.feed(wire({ type: 'res', id: a.id, ok: true, payload: PRIVATE, seq: 3, cached: true }, false));
    upstream.feed(wire({ type: 'res', id: b.id, ok: true, payload: null, seq: 4 }, false));
    await tick();
    const [first, second] = texts(client.sent);
    expect(first).toMatchObject({ type: 'res', id: 'h5', ok: true, seq: 3, cached: true });
    expect(Object.keys(first).sort()).toEqual(['cached', 'id', 'ok', 'payload', 'seq', 'type']);
    expect(JSON.stringify(first)).not.toContain(SECRET_KEY);
    expect(second).toEqual({ type: 'res', id: 'h6', ok: true, payload: null, seq: 4 });
    close();
  });

  it('a health reply that is not an object (and not empty) is not passed on, but the request is answered under its id', async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(health('h2'), true));
    await tick();
    const [asked] = texts(upstream.sent);
    upstream.feed(wire({ type: 'res', id: asked.id, ok: true, payload: `recent: ${SECRET_KEY}` }, false));
    await tick();
    const got = texts(client.sent);
    expect(got).toEqual([{ type: 'res', id: 'h2', ok: false, error: { code: 'UNAVAILABLE', message: expect.stringContaining('"health"') } }]);
    expect(JSON.stringify(got)).not.toContain(SECRET_KEY);
    close();
  });
});
