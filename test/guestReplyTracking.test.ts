/**
 * A guest's health and agents.list replies are rewritten by their request's
 * id. A request the proxy could not follow to its reply used to go through,
 * and its reply reached the guest as the gateway sent it, other people's
 * sessions and all (deep audit of v2.166.2, #009). Fake sockets, no gateway.
 */
import { describe, expect, it } from 'vitest';
import { Duplex } from 'node:stream';
import { encodeFrame, FrameReader, MAX_GUEST_PENDING, spliceGuest } from '../src/api/consoleProxy.js';

function socket() {
  const sent: Buffer[] = [];
  const s = new Duplex({ read() {}, write(chunk, _enc, cb) { sent.push(Buffer.from(chunk)); cb(); } });
  return { s, sent, feed: (b: Buffer) => s.push(b) };
}
const tick = () => new Promise((r) => setImmediate(r));
const wire = (v: unknown, masked: boolean) => encodeFrame(1, Buffer.from(JSON.stringify(v)), masked);
const texts = (bs: Buffer[]) => new FrameReader(1 << 24).push(Buffer.concat(bs)).filter((f) => f.opcode === 1).map((f) => JSON.parse(f.payload.toString()));
const health = (id?: string | number) => ({ type: 'req', ...(id !== undefined ? { id } : {}), method: 'health', params: {} });
const PRIVATE = { agents: [{ agentId: 'meal-planner', sessions: { count: 1, recent: [{ key: 'agent:meal-planner:someone-elses-session' }] } }] };

function splice() {
  const client = socket(), upstream = socket();
  spliceGuest(client.s, upstream.s, { identity: 'fixture-guest' });
  return { client, upstream, close: () => { client.s.destroy(); upstream.s.destroy(); } };
}

describe('a guest request whose reply could not be rewritten is answered here, never sent', () => {
  it('past the cap: refused while the others wait, accepted again once one is answered — and every reply that goes back is scrubbed', async () => {
    const { client, upstream, close } = splice();
    client.feed(Buffer.concat(Array.from({ length: MAX_GUEST_PENDING + 1 }, (_, i) => wire(health(String(i)), true))));
    await tick();
    expect(texts(upstream.sent)).toHaveLength(MAX_GUEST_PENDING);
    const refused = texts(client.sent);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ type: 'res', id: String(MAX_GUEST_PENDING), ok: false, error: { code: 'UNAVAILABLE' } });
    upstream.feed(wire({ type: 'res', id: '0', ok: true, payload: PRIVATE }, false));
    await tick();
    client.feed(wire(health('again'), true));
    await tick();
    expect(texts(upstream.sent).map((m) => m.id).at(-1)).toBe('again');
    upstream.feed(wire({ type: 'res', id: 'again', ok: true, payload: PRIVATE }, false));
    await tick();
    for (const r of texts(client.sent).filter((m) => m.ok)) expect(r.payload.agents[0].sessions.recent).toEqual([]);
    close();
  });

  it('a health request without an id is refused (its reply could not be matched)', async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(health(), true));
    await tick();
    expect(texts(upstream.sent)).toHaveLength(0);
    expect(texts(client.sent)[0]).toMatchObject({ ok: false, id: null, error: { code: 'UNAVAILABLE' } });
    close();
  });

  it('an id still waiting is not reused, by the same method or another (1 and "1" are one id)', async () => {
    const { client, upstream, close } = splice();
    client.feed(wire(health(1), true));
    client.feed(wire({ type: 'req', id: '1', method: 'chat.history', params: {} }, true));
    client.feed(wire(health('1'), true));
    await tick();
    expect(texts(upstream.sent)).toHaveLength(1);
    expect(texts(client.sent).map((m) => m.error?.code)).toEqual(['UNAVAILABLE', 'UNAVAILABLE']);
    upstream.feed(wire({ type: 'res', id: 1, ok: true, payload: PRIVATE }, false));
    await tick();
    expect(texts(client.sent).at(-1).payload.agents[0].sessions.recent).toEqual([]);
    close();
  });
});
