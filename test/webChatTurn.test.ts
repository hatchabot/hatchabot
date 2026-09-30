import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import { MockProvider } from '../src/providers/mockProvider.js';
import { runWebChatTurn, TURN_SCRIPT, turnScript, WEB_CHAT_SCOPES, webChatSessionKey } from '../src/orchestrator/webChat.js';

/**
 * Chat on the web, step 2 (2026-09-29): the in-container client that sends a
 * web turn to the agent's gateway. Run here against a fake gateway speaking
 * OpenClaw's WebSocket protocol (connect.challenge → connect → hello-ok with
 * the granted scopes → agent: "accepted", then the final result). What the
 * real 2026.9.6 gateway does with the scopes was proven live; this pins the
 * request shape and the refusals.
 */

type Frame = { type: string; id?: string; method?: string; params?: any };
interface FakeOpts {
  /** The scopes hello-ok reports for what was asked (default: exactly what was asked). */
  grant?: (asked: string[]) => string[] | null;
  /** The final answer to `agent` (after "accepted"), or an error. */
  agent?: (params: any) => { ok: true; payload: unknown } | { ok: false; error: unknown };
}

/** A minimal WebSocket server (RFC 6455, text frames only) — enough for the client under test. */
function fakeGateway(opts: FakeOpts = {}) {
  const frames: Frame[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((_q, r) => { r.statusCode = 404; r.end(); });
  const send = (s: Socket, obj: unknown) => {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = data.length < 126 ? Buffer.from([0x81, data.length])
      : data.length < 65536 ? Buffer.from([0x81, 126, data.length >> 8, data.length & 255])
        : (() => { const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(data.length), 2); return h; })();
    s.write(Buffer.concat([head, data]));
  };
  server.on('upgrade', (req, socket: Socket) => {
    sockets.add(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    send(socket, { type: 'event', event: 'connect.challenge', payload: { nonce: 'n', ts: Date.now() } });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0]! & 15;
        let len = buf[1]! & 127, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const body = Buffer.from(buf.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < body.length; i++) body[i]! ^= mask[i % 4]!;
        buf = buf.subarray(off + 4 + len);
        if (op === 8) { socket.end(); return; }
        if (op !== 1) continue;
        const f = JSON.parse(body.toString('utf8')) as Frame;
        frames.push(f);
        if (f.method === 'connect') {
          const asked: string[] = f.params?.scopes ?? [];
          const scopes = opts.grant ? opts.grant(asked) : asked;
          send(socket, { type: 'res', id: f.id, ok: true, payload: { type: 'hello-ok', protocol: 4, auth: scopes === null ? undefined : { role: 'operator', scopes } } });
        } else if (f.method === 'agent') {
          send(socket, { type: 'res', id: f.id, ok: true, payload: { runId: 'r1', status: 'accepted' } });
          const out = opts.agent ? opts.agent(f.params) : { ok: true as const, payload: { runId: 'r1', status: 'ok', result: { payloads: [{ text: 'Hello from the agent.' }] } } };
          send(socket, { type: 'res', id: f.id, ...out });
        }
      }
    });
  });
  return new Promise<{ port: number; frames: Frame[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ port, frames, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }) });
    });
  });
}

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A made-up gateway secret, assembled at runtime.
const FAKE_TOKEN = ['fake', 'gw', randomBytes(4).toString('hex')].join('-');

/** Runs TURN_SCRIPT the way the container would, pointed at the fake gateway. */
async function runClient(port: number, req: Record<string, unknown>, cfg: unknown = { gateway: { auth: { mode: 'token', token: FAKE_TOKEN } } }) {
  const dir = mkdtempSync(join(tmpdir(), 'hb-webturn-'));
  dirs.push(dir);
  const cfgPath = join(dir, 'openclaw.json');
  if (cfg !== undefined) writeFileSync(cfgPath, typeof cfg === 'string' ? cfg : JSON.stringify(cfg));
  const body = { agentId: 'kitchen', sessionKey: 'web:00000000000000aa', message: '[Sam via the web app]\nhi', rights: 'member', scopes: [...WEB_CHAT_SCOPES.member], timeoutMs: 10_000, ...req };
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ['-e', TURN_SCRIPT], {
      env: { PATH: process.env.PATH, HOME: dir, CFG_PATH: cfgPath, GW_PORT: String(port), REQ: Buffer.from(JSON.stringify(body)).toString('base64') },
      timeout: 20_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr }));
  });
}

async function gateway(opts?: FakeOpts) {
  const g = await fakeGateway(opts);
  closers.push(g.close);
  return g;
}

describe('the web chat client (inside the container)', () => {
  it("a guest's turn: a backend client on loopback with the gateway's own token, read + write only, into their web session", async () => {
    const g = await gateway();
    const out = await runClient(g.port, {});
    expect(out, out.stderr).toMatchObject({ code: 0, stdout: 'Hello from the agent.' });
    const [connect, agent] = g.frames;
    expect(connect).toMatchObject({ type: 'req', method: 'connect', params: {
      minProtocol: 4, maxProtocol: 4, role: 'operator',
      client: { id: 'gateway-client', mode: 'backend' },
      scopes: ['operator.read', 'operator.write'],
      auth: { token: FAKE_TOKEN },
    } });
    expect(agent).toMatchObject({ type: 'req', method: 'agent', params: {
      agentId: 'kitchen', sessionKey: 'web:00000000000000aa', message: '[Sam via the web app]\nhi', deliver: false, timeout: 10,
    } });
    expect(agent!.params.idempotencyKey).toMatch(/^hb-web-[0-9a-f-]{36}$/);
    // Nothing that would make it the owner's turn or change the model.
    expect(agent!.params).not.toHaveProperty('model');
    expect(g.frames).toHaveLength(2);
  });

  it('refuses before sending the message when the gateway does not limit the connection', async () => {
    const admin = await gateway({ grant: (asked) => [...asked, 'operator.admin'] });
    const a = await runClient(admin.port, {});
    expect(a.code).toBe(21);
    expect(a.stderr).toMatch(/did not limit/);
    expect(admin.frames.map((f) => f.method)).toEqual(['connect']);
    // A gateway that reports no scopes at all proves nothing either.
    const silent = await gateway({ grant: () => null });
    const b = await runClient(silent.port, {});
    expect(b.code).toBe(21);
    expect(silent.frames.map((f) => f.method)).toEqual(['connect']);
  });

  it('a member request carrying operator.admin is refused before it connects', async () => {
    const g = await gateway();
    const out = await runClient(g.port, { scopes: ['operator.admin', 'operator.write'] });
    expect(out.code).toBe(2);
    expect(g.frames).toHaveLength(0);
  });

  it("the owner's turn asks for operator.admin and goes ahead", async () => {
    const g = await gateway();
    const out = await runClient(g.port, { rights: 'owner', scopes: [...WEB_CHAT_SCOPES.owner] });
    expect(out.code).toBe(0);
    expect(g.frames[0]!.params.scopes).toContain('operator.admin');
  });

  it('owner-only commands, timeouts and a run already in flight each have their own exit', async () => {
    const forbidden = await gateway({ agent: () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'missing scope: operator.admin' } }) });
    expect((await runClient(forbidden.port, { message: '/reset' })).code).toBe(23);
    const failed = await gateway({ agent: () => ({ ok: false, error: { code: 'UNAVAILABLE', message: 'agent is busy' } }) });
    expect((await runClient(failed.port, {})).code).toBe(1);
    const slow = await gateway({ agent: () => ({ ok: true, payload: { status: 'timeout' } }) });
    expect((await runClient(slow.port, {})).code).toBe(124);
    const twice = await gateway({ agent: () => ({ ok: true, payload: { status: 'in_flight' } }) });
    expect((await runClient(twice.port, {})).code).toBe(25);
    const broken = await gateway({ agent: () => ({ ok: true, payload: { status: 'error', summary: 'model refused' } }) });
    expect((await runClient(broken.port, {})).code).toBe(1);
  });

  it('several payloads are joined; a media link comes along', async () => {
    const g = await gateway({ agent: () => ({ ok: true, payload: { status: 'ok', result: { payloads: [{ text: 'One.' }, { text: 'Two.', mediaUrl: 'https://example.com/a.png' }, { text: '' }] } } }) });
    expect((await runClient(g.port, {})).stdout).toBe('One.\n\nTwo.\nhttps://example.com/a.png');
  });

  it('no usable gateway credential in its config: refused as needing a rebuild (21), never sent', async () => {
    const g = await gateway();
    expect((await runClient(g.port, {}, { gateway: { auth: { mode: 'token' } } })).code).toBe(21);
    expect((await runClient(g.port, {}, { gateway: { auth: { mode: 'token', token: { source: 'env', id: 'X' } } } })).code).toBe(21);
    expect((await runClient(g.port, {}, { gateway: { auth: { mode: 'trusted-proxy' } } })).code).toBe(21);
    expect((await runClient(g.port, {}, 'not json')).code).toBe(21);
    // A broken file is refused without quoting it (the credential is in there).
    const broken = await runClient(g.port, {}, `{"gateway":{"auth":{"mode":"token","token":"${FAKE_TOKEN}"}}`);
    expect(broken.code).toBe(21);
    expect(broken.stderr).not.toContain(FAKE_TOKEN);
    expect(g.frames).toHaveLength(0);
    // No-auth loopback gateways (older seeds) connect without a credential.
    const none = await runClient(g.port, {}, { gateway: { auth: { mode: 'none' } } });
    expect(none.code).toBe(0);
    expect(g.frames[0]!.params).not.toHaveProperty('auth');
  });

  it('a gateway that never answers: the client gives up at its own deadline', async () => {
    const server = createServer();
    const held: Socket[] = [];
    server.on('upgrade', (_q, s: Socket) => { held.push(s); /* accept nothing, say nothing */ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise((r) => { for (const s of held) s.destroy(); server.close(() => r()); }));
    const out = await runClient((server.address() as { port: number }).port, { timeoutMs: 1500 });
    expect(out.code).toBe(124);
  });
});

describe('turnScript and runWebChatTurn', () => {
  it('a guest request never carries operator.admin; bad slugs and keys are refused; the message stays out of the shell', () => {
    const s = turnScript({ agentId: 'kitchen', sessionKey: webChatSessionKey('user-sam'), message: "it's $(rm -rf /) `x`", rights: 'member', timeoutMs: 1000 });
    const r64 = /REQ='([A-Za-z0-9+/=]+)'/.exec(s)![1]!;
    const req = JSON.parse(Buffer.from(r64, 'base64').toString('utf8'));
    expect(req).toMatchObject({ agentId: 'kitchen', rights: 'member', scopes: ['operator.read', 'operator.write'], message: "it's $(rm -rf /) `x`" });
    expect(s).not.toContain('rm -rf');
    expect(() => turnScript({ agentId: "kitchen'; x", sessionKey: 'web:00000000000000aa', message: '', rights: 'member', timeoutMs: 1 })).toThrow();
    expect(() => turnScript({ agentId: 'kitchen', sessionKey: 'main', message: '', rights: 'member', timeoutMs: 1 })).toThrow();
  });

  it('maps what the client said to what the route answers', async () => {
    const p = new MockProvider();
    const { runtimeRef } = await p.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} } as any);
    await p.start(runtimeRef);
    const turn = { userId: 'user-sam', displayName: 'Sam', text: 'hi', rights: 'member' as const };
    const run = (reply: { code: number; stdout?: string; stderr?: string; timedOut?: boolean }) => {
      p.webChatReply = { stdout: '', stderr: '', ...reply };
      return runWebChatTurn(p, { slug: 'kitchen', runtimeRef }, turn, 30_000);
    };
    expect(await run({ code: 0, stdout: ' Hi Sam. \n' })).toEqual({ kind: 'reply', text: 'Hi Sam.' });
    expect(await run({ code: 21, stderr: 'the gateway did not limit this connection' })).toMatchObject({ kind: 'needs-rebuild' });
    expect(await run({ code: 23 })).toEqual({ kind: 'owner-only' });
    expect(await run({ code: 25 })).toEqual({ kind: 'busy' });
    expect(await run({ code: 124 })).toEqual({ kind: 'timeout' });
    expect(await run({ code: 137, timedOut: true })).toEqual({ kind: 'timeout' });
    expect(await run({ code: 1, stderr: 'x' })).toMatchObject({ kind: 'failed', code: 1 });
    expect(p.webChatTurns[0]).toMatchObject({ sessionKey: webChatSessionKey('user-sam'), message: '[Sam via the web app]\nhi', timeoutMs: 30_000 });
    expect(p.webChatTurnOpts[0]).toEqual({ timeoutMs: 45_000 });
  });
});
