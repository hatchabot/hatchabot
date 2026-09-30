import { describe, expect, it } from 'vitest';
import { Duplex } from 'node:stream';
import {
  FrameReader, GUEST_METHODS, LOCAL_BROWSER_ADDRESS, encodeFrame, forwardedClientAddress, guestHttpAllowed,
  guestRequestVerdict, scrubForGuest, spliceGuest, stripClientIdentity, withConsoleIdentity,
} from '../src/api/consoleProxy.js';

/**
 * The console proxy's guest half (consoleProxy.ts): what reaches the gateway
 * about a person, and what a web-chat guest may do through it. Each refusal
 * here is one a guest with OpenClaw's own read/write scopes would otherwise
 * have been granted (proven against 2026.9.6: the gateway log with other
 * people's replies, the audit trail, the config, the list of people).
 */

const GUEST = ['guest-00000000000000000000aaaa', 'hatchabot.invalid'].join('@');
const OWNER = ['owner-00000000000000000000bbbb', 'hatchabot.invalid'].join('@');

describe('identity headers', () => {
  it('whatever the browser sent is dropped: identity, scope caps, forwarded claims, internal headers', () => {
    const h = stripClientIdentity({
      'x-hatchabot-user': OWNER, 'X-OpenClaw-Scopes': 'operator.admin', 'x-forwarded-for': '10.0.0.1', 'x-forwarded-user': OWNER,
      'x-hatchabot-owner': 'u', 'x-hatchabot-internal': 'k', 'cf-access-authenticated-user-email': OWNER, 'x-auth-request-email': OWNER,
      'x-pomerium-claim-email': OWNER, 'remote-user': OWNER, 'x-remote-user': OWNER, 'tailscale-user-login': OWNER, forwarded: 'for=x',
      'x-real-ip': '1.2.3.4', via: 'x', accept: 'text/html', cookie: 'a=b',
    });
    expect(Object.keys(h).sort()).toEqual(['accept', 'cookie']);
  });

  it("a guest is named and capped at read + write; the owner is named with no cap; the browser's claims are replaced", () => {
    const g = withConsoleIdentity({ 'x-hatchabot-user': OWNER, 'x-openclaw-scopes': 'operator.admin', 'sec-websocket-extensions': 'permessage-deflate' },
      { identity: GUEST, guest: true, clientAddress: '192.0.2.7' });
    expect(g['x-hatchabot-user']).toBe(GUEST);
    expect(g['x-openclaw-scopes']).toBe('operator.read,operator.write');
    expect(g['x-forwarded-for']).toBe('192.0.2.7');
    // A guest's frames are read by the proxy: no compression is negotiated.
    expect(g['sec-websocket-extensions']).toBeUndefined();
    const o = withConsoleIdentity({ 'x-openclaw-scopes': 'operator.read', 'sec-websocket-extensions': 'permessage-deflate' },
      { identity: OWNER, guest: false, clientAddress: '192.0.2.7' });
    expect(o['x-hatchabot-user']).toBe(OWNER);
    expect(o['x-openclaw-scopes']).toBeUndefined();
    expect(o['sec-websocket-extensions']).toBe('permessage-deflate');
  });

  it('a browser Hatchabot sees as local is reported as a documentation address (OpenClaw refuses loopback)', () => {
    expect(forwardedClientAddress('127.0.0.1')).toBe(LOCAL_BROWSER_ADDRESS);
    expect(forwardedClientAddress('::1')).toBe(LOCAL_BROWSER_ADDRESS);
    expect(forwardedClientAddress('::ffff:127.0.0.1')).toBe(LOCAL_BROWSER_ADDRESS);
    expect(forwardedClientAddress(undefined)).toBe(LOCAL_BROWSER_ADDRESS);
    expect(forwardedClientAddress('::ffff:100.64.1.2')).toBe('100.64.1.2');
    expect(forwardedClientAddress('bad, 1.2.3.4')).toBe(LOCAL_BROWSER_ADDRESS);
  });
});

describe('what a guest may fetch over HTTP', () => {
  it.each([
    ['GET', '/'], ['GET', '/chat'], ['GET', '/chat/taco/guest/abc'], ['GET', '/assets/index-x.js'], ['GET', '/fonts/a.woff2'],
    ['GET', '/favicon.svg'], ['GET', '/sw.js'], ['GET', '/manifest.webmanifest'], ['GET', '/control-ui-config.json'],
    ['GET', '/api/users/0ef51984-a983-430b-8282-88762f780209/avatar'], ['GET', '/__openclaw__/assistant-media'],
    ['GET', '/__openclaw__/workspace-icon/agent%3Ataco%3Amain'], ['HEAD', '/assets/x.css'], ['POST', '/api/chat/media/outgoing'],
  ])('%s %s is the chat app', (m, p) => expect(guestHttpAllowed(m, p)).toBe(true));
  it.each([
    ['POST', '/tools/invoke'], ['GET', '/v1/models'], ['POST', '/v1/chat/completions'], ['POST', '/v1/responses'],
    ['POST', '/hooks/agent'], ['GET', '/sessions/agent:taco:main/history'], ['GET', '/__openclaw__/canvas/x'],
    ['GET', '/__openclaw__/plugins/control-ui/x.js'], ['GET', '/api/artifacts/download/x'], ['GET', '/j/abc'],
    ['POST', '/'], ['DELETE', '/chat'], ['GET', '/assets/../../tools/invoke'], ['GET', '/assets/%2e%2e/x'], ['GET', '/secret.json'],
    ['GET', '/mcp'], ['POST', '/mcp'], ['GET', '/metrics'], ['GET', '/systems'], ['GET', '/settings'], ['GET', '/chat/x.json'],
  ])('%s %s is an operator surface, refused', (m, p) => expect(guestHttpAllowed(m, p)).toBe(false));
});

describe('what a guest may ask the gateway', () => {
  const req = (method: string, params: unknown = {}) => ({ type: 'req', id: 'r1', method, params });
  it.each(['connect', 'chat.send', 'chat.history', 'sessions.list', 'sessions.create', 'agent', 'models.list', 'question.list'])('%s: allowed', (m) => {
    expect(guestRequestVerdict(req(m, m === 'connect' ? { role: 'operator' } : {})).allow).toBe(true);
  });
  // Each of these answered a read/write guest with data or an action on 2026.9.6.
  it.each(['logs.tail', 'audit.list', 'audit.activity.list', 'audit.run.inspect', 'config.get', 'config.set', 'users.list',
    'users.mentionable', 'agents.files.get', 'agents.files.set', 'tools.invoke', 'send', 'message.action', 'cron.list', 'cron.add',
    'usage.cost', 'transcripts.list', 'system-presence', 'status', 'device.pair.approve', 'node.invoke', 'skills.library.mutate',
    'session.members.list', 'sessions.catalog.read', 'sessions.catalog.startTerminal', 'users.setRole', 'something.new'])('%s: refused', (m) => {
    const v = guestRequestVerdict(req(m));
    expect(v.allow).toBe(false);
    expect(v.id).toBe('r1');
  });
  it('connects as an operator only (a node is the owner\'s to pair)', () => {
    expect(guestRequestVerdict(req('connect', { role: 'node' })).allow).toBe(false);
    expect(guestRequestVerdict(req('connect', {})).allow).toBe(true);
  });
  it('anything that is not a request is refused', () => {
    expect(guestRequestVerdict({ type: 'event', event: 'x' }).allow).toBe(false);
    expect(guestRequestVerdict([1]).allow).toBe(false);
    expect(guestRequestVerdict(null).allow).toBe(false);
  });
  it('the list stays a chat list', () => {
    for (const m of GUEST_METHODS) expect(m).not.toMatch(/^(config|logs|audit|users\.(list|setRole|link)|cron|tools\.invoke|device|node|exec|plugins)/);
  });
});

describe('other people are taken out of what the gateway tells a guest', () => {
  const me = { mode: 'webchat', user: { email: GUEST.toUpperCase(), name: 'me' }, ip: '192.0.2.1' };
  const them = { mode: 'webchat', user: { email: OWNER, name: 'Owner' }, ip: '192.0.2.2' };
  const gw = { mode: 'gateway', reason: 'self', host: 'x' };
  const health = { ok: true, agents: [{ agentId: 'taco', sessions: { count: 3, recent: [{ key: 'agent:taco:main' }] } }] };

  it('the hello: presence down to the gateway and themselves, no recent sessions', () => {
    const out = scrubForGuest({ type: 'res', id: 'c', ok: true, payload: { type: 'hello-ok', snapshot: { presence: [gw, me, them], health } } }, GUEST, new Set()) as any;
    expect(out.payload.snapshot.presence).toEqual([gw, me]);
    expect(out.payload.snapshot.health.agents[0].sessions.recent).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('agent:taco:main');
  });
  it('presence and health events, and the reply to their own health call', () => {
    expect((scrubForGuest({ type: 'event', event: 'presence', payload: { presence: [them, me] } }, GUEST, new Set()) as any).payload.presence).toEqual([me]);
    expect(JSON.stringify(scrubForGuest({ type: 'event', event: 'health', payload: health }, GUEST, new Set()))).not.toContain('agent:taco:main');
    const ids = new Set(['h9']);
    expect(JSON.stringify(scrubForGuest({ type: 'res', id: 'h9', ok: true, payload: health }, GUEST, ids))).not.toContain('agent:taco:main');
    expect(ids.has('h9')).toBe(false);
  });
  it('anything else passes untouched', () => {
    expect(scrubForGuest({ type: 'event', event: 'chat', payload: { text: 'hi' } }, GUEST, new Set())).toBeUndefined();
    expect(scrubForGuest({ type: 'res', id: 'x', ok: true, payload: { sessions: [] } }, GUEST, new Set())).toBeUndefined();
  });
});

describe('WebSocket frames', () => {
  it('round-trips masked and unmasked frames of every length form, split anywhere', () => {
    for (const len of [0, 5, 125, 126, 1000, 65535, 65536, 200_000]) {
      for (const mask of [true, false]) {
        const payload = Buffer.alloc(len, 7);
        const wire = encodeFrame(0x1, payload, mask);
        const r = new FrameReader(1 << 20);
        const got = [...r.push(wire.subarray(0, 3)), ...r.push(wire.subarray(3, 11)), ...r.push(wire.subarray(11))];
        expect(got).toHaveLength(1);
        expect(got[0]!.masked).toBe(mask);
        expect(got[0]!.payload.equals(payload)).toBe(true);
        expect(got[0]!.raw.equals(wire)).toBe(true);
      }
    }
  });
  it('refuses a frame over the cap before reading it', () => {
    const r = new FrameReader(1000);
    expect(() => r.push(encodeFrame(0x1, Buffer.alloc(2000), true).subarray(0, 12))).toThrow(/too large/);
  });
});

/** An in-memory socket: what it is sent is kept; `feed` delivers bytes as if from the other side. */
function fakeSocket() {
  const sent: Buffer[] = [];
  const s = new Duplex({ read() {}, write(chunk, _e, cb) { sent.push(Buffer.from(chunk)); cb(); } });
  return { s, sent, feed: (b: Buffer) => s.push(b) };
}
const texts = (bufs: Buffer[]) => { const r = new FrameReader(1 << 24); return bufs.flatMap((b) => r.push(b)).filter((f) => f.opcode === 1).map((f) => JSON.parse(f.payload.toString())); };
const tick = () => new Promise((r) => setImmediate(r));

describe('a guest socket, spliced', () => {
  it('forwards an allowed request as sent, answers a refused one itself, and never forwards it', async () => {
    const browser = fakeSocket(), gateway = fakeSocket();
    const refused: string[] = [];
    spliceGuest(browser.s, gateway.s, { identity: GUEST, onRefused: (m) => refused.push(String(m)) });
    const ok = encodeFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', id: '1', method: 'chat.send', params: { message: 'hi' } })), true);
    browser.feed(ok);
    browser.feed(encodeFrame(0x1, Buffer.from(JSON.stringify({ type: 'req', id: '2', method: 'logs.tail', params: {} })), true));
    await tick();
    expect(Buffer.concat(gateway.sent).equals(ok)).toBe(true); // byte for byte, mask and all
    const answers = texts(browser.sent);
    expect(answers).toEqual([expect.objectContaining({ type: 'res', id: '2', ok: false, error: expect.objectContaining({ code: 'FORBIDDEN' }) })]);
    expect(refused).toEqual(['logs.tail']);
  });

  it('a request split over frames is judged whole', async () => {
    const browser = fakeSocket(), gateway = fakeSocket();
    spliceGuest(browser.s, gateway.s, { identity: GUEST });
    const body = Buffer.from(JSON.stringify({ type: 'req', id: '3', method: 'config.get', params: {} }));
    const first = encodeFrame(0x1, body.subarray(0, 10), true); first[0] = first[0]! & 0x7f; // not FIN
    const rest = encodeFrame(0x0, body.subarray(10), true);
    browser.feed(first); await tick();
    expect(gateway.sent).toEqual([]);
    browser.feed(rest); await tick();
    expect(gateway.sent).toEqual([]);
    expect(texts(browser.sent)[0]).toMatchObject({ id: '3', ok: false });
  });

  it("scrubs the gateway's hello on the way back", async () => {
    const browser = fakeSocket(), gateway = fakeSocket();
    spliceGuest(browser.s, gateway.s, { identity: GUEST });
    const hello = { type: 'res', id: 'c', ok: true, payload: { type: 'hello-ok', snapshot: { presence: [{ mode: 'webchat', user: { email: OWNER } }], health: { agents: [{ sessions: { recent: [{ key: 'agent:t:main' }] } }] } } } };
    gateway.feed(encodeFrame(0x1, Buffer.from(JSON.stringify(hello)), false));
    await tick();
    const [got] = texts(browser.sent);
    expect(got.payload.snapshot.presence).toEqual([]);
    expect(JSON.stringify(got)).not.toContain(OWNER);
    expect(JSON.stringify(got)).not.toContain('agent:t:main');
  });

  it('ends the connection on anything but masked JSON text from the browser', async () => {
    for (const bad of [
      encodeFrame(0x1, Buffer.from('{"type":"req","id":"1","method":"chat.send"}'), false), // unmasked
      encodeFrame(0x2, Buffer.from([1, 2, 3]), true), // binary
      encodeFrame(0x1, Buffer.from('not json'), true),
    ]) {
      const browser = fakeSocket(), gateway = fakeSocket();
      spliceGuest(browser.s, gateway.s, { identity: GUEST });
      browser.feed(bad);
      await tick();
      const closes = new FrameReader(1 << 20).push(Buffer.concat(browser.sent)).filter((f) => f.opcode === 0x8);
      expect(closes.length).toBe(1);
      expect(closes[0]!.payload.readUInt16BE(0)).toBe(1008);
      // Nothing of it reached the gateway but the close.
      expect(new FrameReader(1 << 20).push(Buffer.concat(gateway.sent)).every((f) => f.opcode === 0x8)).toBe(true);
    }
  });

  it('control frames pass straight through', async () => {
    const browser = fakeSocket(), gateway = fakeSocket();
    spliceGuest(browser.s, gateway.s, { identity: GUEST });
    const ping = encodeFrame(0x9, Buffer.from('p'), true);
    browser.feed(ping); await tick();
    expect(Buffer.concat(gateway.sent).equals(ping)).toBe(true);
  });
});

describe('the guest hello advertises only what a guest may use (2026-09-30)', () => {
  it('drops methods like sessions.github.options, so the chat hides Publish PR instead of erroring', async () => {
    const { scrubForGuest, GUEST_METHODS } = await import('../src/api/consoleProxy.js');
    const allowed = [...GUEST_METHODS][0]!;
    const hello = { type: 'res', id: 'c', ok: true, payload: { type: 'hello-ok', features: { methods: [allowed, 'sessions.github.options', 'cron.list', 'config.get'], events: ['chat'] } } };
    const out = scrubForGuest(hello, GUEST, new Set()) as any;
    expect(out.payload.features.methods).toEqual([allowed]);
    expect(out.payload.features.events).toEqual(['chat']);
  });
});
