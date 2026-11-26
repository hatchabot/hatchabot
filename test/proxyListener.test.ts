import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import Fastify from 'fastify';
import { viaServe } from './helpers/viaServe.js';
import { publicApp, freePort, type PublicApp } from './helpers/publicApp.js';
import { tailscaleShim, SHIM_DNS, type Shim } from './helpers/tailscaleShim.js';
import { _loginThrottleKeys, _resetLoginThrottle, noteFailure } from '../src/api/signIn/auth.js';
import { servedRequest } from './helpers/viaServe.js';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetForwardedOnAppPort, forwardedOnAppPort, openProxyListener, proxyListenerState, proxyPort, serveOffAppPort, watchForwardedOnAppPort, type ProxyListener } from '../src/api/proxyListener.js';
import { markPublicSocket } from '../src/api/trust.js';
import { world, closeAfterEach, privCookie } from './helpers/publicWorld.js';
import type { PeerUserLookup } from '../src/ops/peerUser.js';
import { funnelOn, listenerDownWords, parseFunnelStatus, parseServeStatus, repointArgs, repointServe, serveLeftOnMainPort, tailnetInfo } from '../src/ops/tailnet.js';
import { evaluateSafeguards, failingSafeguards, type SafeguardFacts } from '../src/api/safeguards.js';
import { doctorReport, hatchabotUid, probeProxyListener, publicAccessFacts, type DoctorFacts } from '../src/doctor.js';
import { funnelOnPrivatePort } from '../src/api/machine/reachRoutes.js';

/**
 * HB-1239 and HB-1435, the owner's choice (a), 2026-11-24. The sign-in
 * limits believed X-Forwarded-For from any loopback peer, its FIRST value:
 * under a rootless daemon or Docker Desktop an agent's container is a
 * loopback peer, and named a new address for every try; and the first value
 * is the one a client sends itself. `tailscale serve` now goes to a loopback
 * listener of its own (src/api/proxyListener.ts), the forwarded address is
 * believed only there, and only the one the proxy added (the last). An
 * install whose serve still lands on the app's own port is pointed at the
 * new one at the start, and told what to run where Tailscale refuses.
 */
let h: PublicApp | undefined;
let proxy: ProxyListener | undefined;
let shim: Shim | undefined;
const savedBin = process.env.HATCHABOT_TAILSCALE_BIN;
afterEach(async () => {
  await proxy?.close(); proxy = undefined;
  await h?.close(); h = undefined;
  shim?.cleanup(); shim = undefined;
  if (savedBin === undefined) delete process.env.HATCHABOT_TAILSCALE_BIN; else process.env.HATCHABOT_TAILSCALE_BIN = savedBin;
  vi.unstubAllGlobals();
});

const LIMIT = 3;
/** A Hatchabot whose uid is 1000, with the listener for tailscale serve; `who` finds each connection's user (root: tailscaled). */
const OWN = 1000;
async function withProxy(who: PeerUserLookup = async () => 0, env: NodeJS.ProcessEnv = {}): Promise<{ h: PublicApp; proxy: ProxyListener }> {
  h = await publicApp({ off: true, env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: String(LIMIT) } });
  for (let i = 0; i < 5 && !proxy?.listening; i++) proxy = await openProxyListener(h.app, await freePort(), { ...process.env, ...env }, { peerUser: who, ownUid: OWN });
  if (!proxy?.listening) throw new Error(`no proxy listener: ${proxy?.error}`);
  return { h, proxy };
}
/** A wrong sign-in for a made-up name (a new one each time: only the address's count is shared). */
const miss = (i: number) => ({ username: `nobody-${i}`, password: 'not-the-password' });
const ipKeys = () => _loginThrottleKeys().filter((k) => k.startsWith('ip:'));

describe('X-Forwarded-For is believed only from a peer of another user (HB-1239, the owner\'s call 2026-11-24)', () => {
  /** Misses through the listener, each naming a new address: the buckets they were counted in. */
  const forged = async (port: number, n = 4) => {
    for (let i = 0; i < n; i++) {
      await fetch(`http://127.0.0.1:${port}/v1/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` }, body: JSON.stringify(miss(i)) });
    }
    return ipKeys().sort();
  };

  it('from root (tailscaled): believed, each address its own bucket', async () => {
    const { proxy } = await withProxy(async () => 0);
    expect(await forged(proxy.port)).toEqual(['ip:fwd:203.0.113.1', 'ip:fwd:203.0.113.2', 'ip:fwd:203.0.113.3', 'ip:fwd:203.0.113.4']);
  });

  it('from Hatchabot\'s own user (a container under rootless Docker, through slirp4netns): not believed, one bucket, its own address', async () => {
    const { proxy } = await withProxy(async () => OWN);
    expect(await forged(proxy.port)).toEqual(['ip:127.0.0.1']);
  });

  it('from a peer that could not be found (gone already, or no way to tell): not believed', async () => {
    const { proxy } = await withProxy(async () => undefined);
    expect(await forged(proxy.port)).toEqual(['ip:127.0.0.1']);
  });

  it('nor when looking it up failed', async () => {
    const { proxy } = await withProxy(async () => { throw new Error('no /proc here'); });
    expect(await forged(proxy.port)).toEqual(['ip:127.0.0.1']);
  });

  it('from a user listed in HATCHABOT_PROXY_TRUST_UIDS (a Tailscale run as Hatchabot\'s own user): believed', async () => {
    const { proxy } = await withProxy(async () => OWN, { HATCHABOT_PROXY_TRUST_UIDS: `${OWN}` });
    expect(await forged(proxy.port, 2)).toEqual(['ip:fwd:203.0.113.1', 'ip:fwd:203.0.113.2']);
  });

  it('decided once per connection: a keep-alive connection is asked about once, and its requests wait for the answer', async () => {
    const asked: Array<[string, number]> = [];
    let answer!: (uid: number) => void;
    const { proxy } = await withProxy((peer) => { asked.push([peer.address, peer.port]); return new Promise((r) => { answer = r; }); });
    const { request, Agent } = await import('node:http');
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const post = (i: number) => new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: proxy.port, path: '/v1/login', method: 'POST', agent, headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      r.on('error', reject); r.end(JSON.stringify(miss(i)));
    });
    const first = post(0);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(ipKeys()).toEqual([]);
    answer(0);
    expect(await first).toBe(401);
    expect(await post(1)).toBe(401);
    expect(asked).toHaveLength(1);
    expect(asked[0]![0]).toBe('127.0.0.1');
    expect(ipKeys().sort()).toEqual(['ip:fwd:203.0.113.1', 'ip:fwd:203.0.113.2']);
    agent.destroy();
  });

  it('each connection is asked about with the inode of Hatchabot\'s own end of it, which pins the answer to that connection (HB-1239 review)', async () => {
    const inodes: Array<number | undefined> = [];
    const { proxy } = await withProxy(async (_peer, _listener, inode) => { inodes.push(inode); return 0; });
    const { request } = await import('node:http');
    const get = () => new Promise<void>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: proxy.port, path: '/v1/login', agent: false }, (res) => { res.resume(); res.on('end', () => resolve()); });
      r.on('error', reject); r.end();
    });
    await get(); await get();
    expect(inodes).toHaveLength(2);
    expect(inodes.every((n) => Number.isInteger(n) && n! > 0)).toBe(true);
    expect(inodes[0]).not.toBe(inodes[1]);
  });

  it('beyond the lookups waiting at once, a connection is not believed and still answered (HB-1239 review)', async () => {
    const answers: Array<() => void> = [];
    const slow: PeerUserLookup = () => new Promise((r) => { answers.push(() => r(0)); });
    h = await publicApp({ off: true, env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: String(LIMIT) } });
    for (let i = 0; i < 5 && !proxy?.listening; i++) proxy = await openProxyListener(h.app, await freePort(), process.env, { peerUser: slow, ownUid: OWN, lookupsWaitingMax: 2 });
    const { request } = await import('node:http');
    const post = (i: number) => new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port: proxy!.port, path: '/v1/login', method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      r.on('error', reject); r.end(JSON.stringify(miss(i)));
    });
    const held = [post(0), post(1)];
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    // The third: no lookup, counted as itself, and answered while the other two still wait.
    expect(await post(2)).toBe(401);
    expect(answers).toHaveLength(2);
    expect(ipKeys()).toEqual(['ip:127.0.0.1']);
    answers.forEach((a) => a());
    expect(await Promise.all(held)).toEqual([401, 401]);
    expect(ipKeys().sort()).toEqual(['ip:127.0.0.1', 'ip:fwd:203.0.113.1', 'ip:fwd:203.0.113.2']);
  });

  it('an Upgrade reset while its connection is still being looked up does not take the process down, and the app still serves (HB-1239 review)', async () => {
    const uncaught: unknown[] = [];
    const record = (err: unknown) => { uncaught.push(err); };
    process.on('uncaughtException', record);
    onTestFinished(() => { process.off('uncaughtException', record); });
    let release!: () => void;
    const looked = new Promise<void>((r) => { release = r; });
    const app = Fastify();
    app.get('/x', async () => 'ok');
    await app.ready();
    onTestFinished(() => app.close());
    // The console's handler: it takes the socket and holds it, as a WebSocket would.
    const handed: Socket[] = [];
    app.server.on('upgrade', (_req, socket: Socket) => { handed.push(socket); });
    let l: ProxyListener | undefined;
    for (let i = 0; i < 5 && !l?.listening; i++) l = await openProxyListener(app, await freePort(), {}, { peerUser: async () => { await looked; return 0; }, ownUid: OWN });
    onTestFinished(() => l!.close());
    const c = connect(l!.port, '127.0.0.1');
    c.on('error', () => {});
    await once(c, 'connect');
    c.write('GET /console HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    // Handed on without waiting for the lookup: nothing on the upgrade path reads whether the peer is believed.
    await vi.waitFor(() => expect(handed).toHaveLength(1), { timeout: 1000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    c.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 100));
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(uncaught).toEqual([]);
    expect(handed).toHaveLength(1);
    const r = await fetch(`http://127.0.0.1:${l!.port}/x`);
    expect([r.status, await r.text()]).toEqual([200, 'ok']);
  });

  /** Misses on one keep-alive connection, as tailscaled sends them. */
  const keptAlive = async (port: number) => {
    const { request, Agent } = await import('node:http');
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    onTestFinished(() => agent.destroy());
    return (i: number) => new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path: '/v1/login', method: 'POST', agent, headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      r.on('error', reject); r.end(JSON.stringify(miss(i)));
    });
  };

  it('a connection the cap left undecided is asked again at its next request: tailscaled\'s keep-alive connection is believed again once a flood has passed (HB-1239 review)', async () => {
    const held: Array<() => void> = [];
    let answerAgain!: () => void;
    let calls = 0;
    const who: PeerUserLookup = () => {
      calls++;
      return calls <= 2 ? new Promise((r) => { held.push(() => r(OWN)); }) : new Promise((r) => { answerAgain = () => r(0); });
    };
    h = await publicApp({ off: true, env: { HATCHABOT_LOGIN_FAILS_PER_WINDOW: String(LIMIT) } });
    for (let i = 0; i < 5 && !proxy?.listening; i++) proxy = await openProxyListener(h.app, await freePort(), process.env, { peerUser: who, ownUid: OWN, lookupsWaitingMax: 2 });
    // The flood: two connections that take every place.
    const flood = [connect(proxy!.port, '127.0.0.1'), connect(proxy!.port, '127.0.0.1')];
    for (const f of flood) f.on('error', () => {});
    await vi.waitFor(() => expect(calls).toBe(2));
    // tailscaled's connection, made during it: "cannot tell", so its request counts as 127.0.0.1.
    const post = await keptAlive(proxy!.port);
    expect(await post(0)).toBe(401);
    expect(ipKeys()).toEqual(['ip:127.0.0.1']);
    expect(calls).toBe(2);
    held.forEach((r) => r());
    for (const f of flood) f.destroy();
    // Its next request asks again, and counts as not believed while it waits; the one after it is believed.
    expect(await post(1)).toBe(401);
    expect(calls).toBe(3);
    expect(ipKeys()).toEqual(['ip:127.0.0.1']);
    answerAgain();
    await new Promise((r) => setTimeout(r, 20));
    expect(await post(2)).toBe(401);
    expect(ipKeys().sort()).toEqual(['ip:127.0.0.1', 'ip:fwd:203.0.113.3']);
    // Decided now: not asked again.
    expect(await post(3)).toBe(401);
    expect(calls).toBe(3);
  });

  it('asked again one at a time, at a request after each "cannot tell"; never for Hatchabot\'s own user', async () => {
    let release!: () => void, answerRoot!: () => void;
    const answers: Array<() => Promise<number | undefined>> = [
      async () => undefined,
      () => new Promise((r) => { release = () => r(undefined); }),
      () => new Promise((r) => { answerRoot = () => r(0); }),
    ];
    let calls = 0;
    const { proxy } = await withProxy(() => answers[calls++]!());
    const post = await keptAlive(proxy.port);
    // Each counted as 127.0.0.1 (the fourth is over its limit there, and refused).
    await post(0); // the first answer: cannot tell
    await post(1); // asks again; that one waits
    await post(2); // one is under way: not asked
    expect(calls).toBe(2);
    release();
    await new Promise((r) => setTimeout(r, 20));
    await post(3); // cannot tell again: asked once more
    expect(calls).toBe(3);
    answerRoot();
    await new Promise((r) => setTimeout(r, 20));
    expect(await post(4)).toBe(401);
    expect(ipKeys().sort()).toEqual(['ip:127.0.0.1', 'ip:fwd:203.0.113.5']);
    // Hatchabot's own user is an answer, not "cannot tell": asked once.
    let ownCalls = 0;
    const ownListener = await openProxyListener(h!.app, await freePort(), process.env, { peerUser: async () => { ownCalls++; return OWN; }, ownUid: OWN });
    onTestFinished(() => ownListener.close());
    const ownPost = await keptAlive(ownListener.port);
    for (let i = 0; i < 3; i++) await ownPost(10 + i);
    expect(ownCalls).toBe(1);
  });

  it('a connection of Hatchabot\'s own user that brings X-Forwarded-For is said once a start, with where to look', async () => {
    _resetForwardedOnAppPort();
    const lines: string[] = [];
    const app = Fastify({ logger: { level: 'warn', stream: { write: (l: string) => { lines.push(JSON.parse(l).msg); } } } });
    app.get('/x', async () => 'ok');
    let l: ProxyListener | undefined;
    for (let i = 0; i < 5 && !l?.listening; i++) l = await openProxyListener(app, await freePort(), {}, { peerUser: async () => OWN, ownUid: OWN });
    for (let i = 0; i < 2; i++) await fetch(`http://127.0.0.1:${l!.port}/x`, { headers: { 'x-forwarded-for': '100.64.0.9' } });
    expect(lines).toEqual(['A connection to the listener for tailscale serve came from Hatchabot\'s own user (uid 1000) with X-Forwarded-For, which is not believed from that user: it is counted as itself. If Tailscale runs as your own user, every device on your tailnet shares one sign-in limit: hatchabot doctor says what to do.']);
    await l!.close(); await app.close();
  });
});

describe('whose address the sign-in limits count (HB-1239, HB-1435)', () => {
  it('on the app\'s own port a loopback peer cannot choose its bucket with X-Forwarded-For', async () => {
    const { h } = await withProxy();
    const seen: number[] = [];
    for (let i = 0; i < LIMIT + 3; i++) {
      seen.push((await h.app.inject({ method: 'POST', url: '/v1/login', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': `203.0.113.${i + 1}` }, payload: miss(i) })).statusCode);
    }
    expect(seen).toEqual([401, 401, 401, 429, 429, 429]);
    expect(ipKeys()).toEqual(['ip:127.0.0.1']);
  });

  it('on the proxy\'s listener, the address the proxy added is the bucket: a prefix the client sent changes nothing', async () => {
    const { proxy } = await withProxy();
    const viaServe = async (xff: string | undefined, i: number) => (await fetch(`http://127.0.0.1:${proxy.port}/v1/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(xff !== undefined ? { 'x-forwarded-for': xff } : {}) }, body: JSON.stringify(miss(i)),
    })).status;
    const a: number[] = [];
    // Device A sends an X-Forwarded-For of its own, a new one each try; the proxy appends A's tailnet address.
    for (let i = 0; i < LIMIT + 2; i++) a.push(await viaServe(`198.51.100.${i + 1}, 100.64.0.5`, i));
    expect(a).toEqual([401, 401, 401, 429, 429]);
    // Device B is its own bucket, not locked out by A's misses; nor is a request the proxy sent no address with.
    expect(await viaServe('100.64.0.6', 50)).toBe(401);
    expect(await viaServe(undefined, 51)).toBe(401);
    expect(await viaServe('not an address', 52)).toBe(401);
    expect(ipKeys().sort()).toEqual(['ip:fwd:100.64.0.5', 'ip:fwd:100.64.0.6', 'ip:fwd:unknown']);
  });

  it('a request on the proxy\'s listener is never "on this machine", whatever headers it lacks', async () => {
    const { h, proxy } = await withProxy();
    const first = { username: 'first', password: 'long-enough-password' };
    const viaServe = await fetch(`http://127.0.0.1:${proxy.port}/v1/local-accounts/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(first) });
    expect(viaServe.status).toBe(403);
    expect((await viaServe.json() as { error: string }).error).toMatch(/setup code/);
    expect(h.store.countLocalAccounts()).toBe(0);
    // The same request at the app's own port, on this machine: as before.
    expect((await h.app.inject({ method: 'POST', url: '/v1/local-accounts/bootstrap', payload: first })).statusCode).toBe(201);
  });

  it('serves the app\'s routes, refuses a port another listener has, and has a fixed loopback default', async () => {
    const { h, proxy } = await withProxy();
    expect((await fetch(`http://127.0.0.1:${proxy.port}/v1/config`)).status).toBe(200);
    // On loopback only, never every interface.
    expect(proxy.host).toBe('127.0.0.1');
    // What the setup guide reads before it moves serve.
    expect(proxyListenerState()).toEqual({ listening: true, port: proxy.port });
    // And what doctor sees from outside: the app's page, with its version (the test app has no pages: one that does).
    const paged = Fastify();
    paged.get('/', async (_req, reply) => reply.header('x-hatchabot-version', '2.192.0').type('text/html').send('<!doctype html>'));
    const door = await viaServe(paged);
    expect(await probeProxyListener(door.port)).toEqual({ port: door.port, ok: true });
    await paged.close();
    const same = await openProxyListener(h.app, 8080, { PORT: '8080' } as NodeJS.ProcessEnv);
    expect(same).toMatchObject({ listening: false, error: 'HATCHABOT_PROXY_PORT=8080 is the app\'s own port (PORT=8080): choose another port for it.' });
    const pub = await openProxyListener(h.app, 8092, { PORT: '8080' } as NodeJS.ProcessEnv);
    expect(pub.error).toMatch(/public listener/);
    expect(proxyListenerState()).toEqual({ listening: false, port: 8092, error: pub.error });
    const taken = await openProxyListener(h.app, proxy.port, { PORT: '8080' } as NodeJS.ProcessEnv);
    expect(taken).toMatchObject({ listening: false, error: expect.stringMatching(new RegExp(`^The listener for tailscale serve could not open 127\\.0\\.0\\.1:${proxy.port}: .*EADDRINUSE`)) });
    expect(proxyListenerState()?.listening).toBe(false);
    const free = await freePort();
    expect(await probeProxyListener(free, {} as NodeJS.ProcessEnv)).toMatchObject({ port: free, ok: false, error: expect.any(String) });
    // Its port set to the app's own: refused to open, and doctor says why instead of reaching the app there
    // (a free port, so that even a regression asks nothing that is listening on this machine).
    const appPort = await freePort();
    expect(await probeProxyListener(appPort, { PORT: String(appPort) } as NodeJS.ProcessEnv))
      .toEqual({ port: appPort, ok: false, clash: `HATCHABOT_PROXY_PORT=${appPort} is the app's own port (PORT=${appPort}): choose another port for it.` });
    expect(proxyPort({} as NodeJS.ProcessEnv)).toBe(8094);
    expect(proxyPort({ HATCHABOT_PROXY_PORT: '9001' } as NodeJS.ProcessEnv)).toBe(9001);
    for (const bad of ['', '0', '70000', 'x']) expect(proxyPort({ HATCHABOT_PROXY_PORT: bad } as NodeJS.ProcessEnv), bad).toBe(8094);
  });
});

describe('an install whose tailscale serve still lands on the app\'s own port (HB-1239)', () => {
  const OPEN = { listening: true, port: 8094 };
  const OLD = { TCP: { '443': { HTTPS: true } }, Web: { [`${SHIM_DNS}:443`]: { Handlers: { '/': { Proxy: 'http://localhost:8080' } } } } };
  const shimmed = (cfg: unknown): Shim => {
    shim = tailscaleShim();
    process.env.HATCHABOT_TAILSCALE_BIN = shim.bin;
    shim.setConfig(cfg);
    return shim;
  };
  const changes = (s: Shim) => s.calls().filter((c) => c[0] === 'serve' && c[1] !== 'status').map((c) => c.join(' '));

  it('is pointed at the new listener at the start, where it listens and its path kept; the next start has nothing to do', async () => {
    const s = shimmed({
      TCP: { '443': { HTTPS: true }, '80': { HTTP: true } },
      Web: {
        [`${SHIM_DNS}:443`]: { Handlers: { '/': { Proxy: 'http://localhost:8080' } } },
        [`${SHIM_DNS}:80`]: { Handlers: { '/app': { Proxy: 'http://127.0.0.1:8080' } } },
      },
    });
    const r = await repointServe(8080, OPEN);
    expect(r).toEqual({ moved: [`${SHIM_DNS}:443`, `${SHIM_DNS}:80/app`], left: [] });
    expect(changes(s)).toEqual(['serve --bg --https=443 http://127.0.0.1:8094', 'serve --bg --http=80 --set-path=/app http://127.0.0.1:8094']);
    expect(s.config().Web![`${SHIM_DNS}:443`]!.Handlers['/']!.Proxy).toBe('http://127.0.0.1:8094');
    expect(await repointServe(8080, OPEN)).toEqual({ moved: [], left: [] });
    expect(changes(s)).toHaveLength(2);
  });

  it('leaves Funnel, a terminal\'s serve and a target elsewhere as they are, and says what to run for what it left', async () => {
    const s = shimmed({
      TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } },
      Web: {
        [`${SHIM_DNS}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } },
        [`${SHIM_DNS}:443`]: { Handlers: { '/': { Proxy: 'http://192.0.2.10:8080' } } },
      },
      AllowFunnel: { [`${SHIM_DNS}:8443`]: true },
      Foreground: { session1: { TCP: { '10000': { HTTPS: true } }, Web: { [`${SHIM_DNS}:10000`]: { Handlers: { '/': { Proxy: 'http://localhost:8080' } } } } } },
    });
    const r = await repointServe(8080, OPEN);
    expect(changes(s)).toEqual([]);
    expect(r.moved).toEqual([]);
    expect(r.left).toEqual([{ where: `${SHIM_DNS}:10000`, why: 'a `tailscale serve` running in a terminal made it: stop that one (Ctrl+C), then run tailscale serve --bg --https=10000 http://127.0.0.1:8094' }]);
  });

  it('a move Tailscale refuses (no operator rights) is said, with the command, and nothing is claimed moved', async () => {
    const s = shimmed(OLD);
    s.failServe('Access denied: serve config denied\nUse \'sudo tailscale serve\' or \'tailscale set --operator=$USER\'');
    const r = await repointServe(8080, OPEN);
    expect(r.moved).toEqual([]);
    expect(r.left).toEqual([{ where: `${SHIM_DNS}:443`, command: 'tailscale serve --bg --https=443 http://127.0.0.1:8094' }]);
    expect(r.error).toMatch(/^Access denied: serve config denied/);
  });

  it('is never moved onto a listener that did not open: nothing changed, and why (the owner\'s call, 2026-11-24)', async () => {
    const s = shimmed(OLD);
    const why = 'The listener for tailscale serve could not open 127.0.0.1:8094: listen EADDRINUSE: address already in use 127.0.0.1:8094';
    const r = await repointServe(8080, { listening: false, port: 8094, error: why });
    expect(changes(s)).toEqual([]);
    expect(s.config().Web![`${SHIM_DNS}:443`]!.Handlers['/']!.Proxy).toBe('http://localhost:8080');
    expect(r).toEqual({
      moved: [], noListener: true,
      left: [{ where: `${SHIM_DNS}:443`, command: 'tailscale serve --bg --https=443 http://127.0.0.1:8094' }],
      error: `Tailscale serve was left as it is: Hatchabot's listener for it, 127.0.0.1:8094, is not open. ${why}.`,
    });
  });

  it('the start\'s log line says what a closed listener means for the tailnet, as it is', () => {
    const why = 'The listener for tailscale serve could not open 127.0.0.1:8094: listen EADDRINUSE: address already in use 127.0.0.1:8094';
    const head = `Tailscale serve was left as it is: Hatchabot's listener for it, 127.0.0.1:8094, is not open. ${why}.`;
    const on = (proxy: string) => parseServeStatus(JSON.stringify({ ...OLD, Web: { [`${SHIM_DNS}:443`]: { Handlers: { '/': { Proxy: proxy } } } } })).handlers;
    expect(listenerDownWords(on('http://127.0.0.1:8094'), 8080, 8094, why)).toBe(`${head} Tailscale serve sends your tailnet there, so your tailnet address does not answer until it opens. hatchabot doctor says what to do.`);
    expect(listenerDownWords(on('http://localhost:8080'), 8080, 8094, why)).toBe(`${head} Tailscale serve still sends your tailnet to port 8080, where every device on it shares one sign-in limit. hatchabot doctor says what to do.`);
    expect(listenerDownWords([], 8080, 8094, why)).toBe(`${head} hatchabot doctor says what to do.`);
    // A reason with its own full stop keeps just that one.
    expect(listenerDownWords([], 8080, 8094, 'HATCHABOT_PROXY_PORT=8080 is the app\'s own port (PORT=8080): choose another port for it.'))
      .toBe('Tailscale serve was left as it is: Hatchabot\'s listener for it, 127.0.0.1:8094, is not open. HATCHABOT_PROXY_PORT=8080 is the app\'s own port (PORT=8080): choose another port for it. hatchabot doctor says what to do.');
  });

  it('a tailscaled in userspace-networking mode (no TUN device) dials 127.0.0.1 for its own address: doctor says any tailnet device reaches the listener there as itself (HB-1239 review)', async () => {
    const NEW = { ...OLD, Web: { [`${SHIM_DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8094' } } } } };
    shimmed(NEW);
    vi.stubGlobal('fetch', async () => new Response('ok'));
    shim!.setStatus({ TUN: false });
    expect(await tailnetInfo(8094, 8080)).toMatchObject({ serving: true, userspace: true });
    shim!.setStatus({ TUN: true });
    expect((await tailnetInfo(8094, 8080)).userspace).toBeUndefined();
    const facts = {
      nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true }, envFile: { present: true, secretKey: true, password: true, authMode: 'accounts' },
      db: { path: '/x/hatchabot.sqlite', present: true }, service: { manager: 'systemd', active: true, enabled: true },
      controlPlane: { url: 'http://localhost:8080', ok: true }, backups: { dir: '/b', lastSet: '2026-11-23', ageDays: 0 },
      tailscale: { installed: true, up: true, dns: SHIM_DNS, serving: true, reachable: true, url: `https://${SHIM_DNS}`, userspace: true },
      proxyListener: { port: 8094, ok: true },
    } as DoctorFacts;
    const line = { level: 'warn', text: 'Tailscale runs without a TUN device (userspace networking), so a tailnet connection to this machine\'s own address reaches 127.0.0.1 from tailscaled: any device on your tailnet can open Hatchabot\'s listener for tailscale serve, port 8094, itself and name its own address there',
      fix: 'Run tailscaled with a TUN device: the tailscaled system service\'s default; in the Tailscale container, TS_USERSPACE=false with /dev/net/tun' };
    expect(doctorReport(facts).find((l) => /TUN device/.test(l.text))).toEqual(line);
    expect(doctorReport({ ...facts, tailscale: { ...facts.tailscale!, userspace: undefined } }).some((l) => /TUN device/.test(l.text))).toBe(false);
    expect(doctorReport({ ...facts, tailscale: { ...facts.tailscale!, serving: false } }).some((l) => /TUN device/.test(l.text))).toBe(false);
  });

  it('the setup guide\'s probe sees it as served, at the old port; hatchabot doctor says what to run', async () => {
    shimmed(OLD);
    // The probe asks the address itself: answered here, never the network.
    vi.stubGlobal('fetch', async () => new Response('ok'));
    expect(await tailnetInfo(8094, 8080)).toMatchObject({ installed: true, dns: SHIM_DNS, serving: true, oldPort: true, reachable: true });
    const moved = { ...OLD, Web: { [`${SHIM_DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8094' } } } } };
    shim!.setConfig(moved);
    const now = await tailnetInfo(8094, 8080);
    expect(now.serving).toBe(true);
    expect(now.oldPort).toBeUndefined();

    const left = serveLeftOnMainPort(parseServeStatus(JSON.stringify(OLD)).handlers, 8080, 8094);
    const facts = {
      nodeVersion: 'v22.22.2', dockerCli: true, dockerDaemon: { ok: true }, envFile: { present: true, secretKey: true, password: true, authMode: 'accounts' },
      db: { path: '/x/hatchabot.sqlite', present: true }, service: { manager: 'systemd', active: true, enabled: true },
      controlPlane: { url: 'http://localhost:8080', ok: true }, backups: { dir: '/b', lastSet: '2026-11-23', ageDays: 0 },
      tailscale: { installed: true, up: true, dns: SHIM_DNS, serving: true, reachable: true, url: `https://${SHIM_DNS}`, oldPort: true, mainPort: 8080, proxyPort: 8094, repoint: left.map((l) => l.command!) },
      proxyListener: { port: 8094, ok: true },
    } as DoctorFacts;
    const line = doctorReport(facts).find((l) => /Tailscale serve still sends/.test(l.text));
    expect(line).toEqual({
      level: 'warn',
      text: 'Tailscale serve still sends your tailnet to port 8080, not to port 8094, the one for it: every device on your tailnet shares one sign-in limit there, so one person\'s wrong passwords lock the others out',
      fix: 'Run: tailscale serve --bg --https=443 http://127.0.0.1:8094   (with sudo if Tailscale says access denied; restarting Hatchabot does it too when Tailscale lets it)',
    });
    expect(doctorReport({ ...facts, tailscale: { ...facts.tailscale!, oldPort: undefined } }).some((l) => /still sends/.test(l.text))).toBe(false);
    // On a Mac moving it does not yet give each device its own limit: the line does not promise it (the review of HB-1239).
    expect(doctorReport({ ...facts, tailscale: { ...facts.tailscale!, mac: true } }).find((l) => /Tailscale serve still sends/.test(l.text))!.text)
      .toBe('Tailscale serve still sends your tailnet to port 8080, not to port 8094, the one for it. On a Mac every device on your tailnet shares one sign-in limit at either port for now, unless Tailscale runs as your own user and your uid is in HATCHABOT_PROXY_TRUST_UIDS (docs/tailscale.md)');
    // Not asked (the app does not answer): no command either, since nothing is listening for serve.
    expect(doctorReport({ ...facts, proxyListener: undefined }).find((l) => /Tailscale serve still sends/.test(l.text))!.fix)
      .toBe('Start Hatchabot first (it does not answer: see above); at its start it moves serve itself where Tailscale lets it, and then hatchabot doctor gives the command where it does not');

    // The listener not open: no command to move serve onto it, and the line that says why (the owner's call, 2026-11-24).
    const closed = { ...facts, proxyListener: { port: 8094, ok: false, error: 'connect ECONNREFUSED 127.0.0.1:8094' } };
    const lines = doctorReport(closed);
    expect(lines.find((l) => /Tailscale serve still sends/.test(l.text))!.fix).toBe('First Hatchabot\'s listener for it has to open (the next line); then restarting Hatchabot moves serve itself');
    const why = { level: 'warn', text: 'Hatchabot\'s listener for tailscale serve, 127.0.0.1:8094, is not open: Hatchabot leaves Tailscale serve as it is until it opens',
      fix: 'See why in the service log ("Tailscale serve was left as it is"). If another program has port 8094, set HATCHABOT_PROXY_PORT to a free port in .env, then restart Hatchabot' };
    expect(lines.find((l) => /listener for tailscale serve/.test(l.text))).toEqual(why);
    // Serve already sends the tailnet there: the tailnet address is down, a failure.
    const onIt = doctorReport({ ...closed, tailscale: { ...facts.tailscale!, oldPort: undefined }, proxyListener: { port: 8094, ok: false, other: true } });
    expect(onIt.find((l) => /listener for tailscale serve/.test(l.text))).toEqual({ ...why, level: 'fail',
      text: 'Hatchabot\'s listener for tailscale serve, 127.0.0.1:8094, is not open (another program answers there): Tailscale serve sends your tailnet there, so your tailnet address does not answer' });
    expect(doctorReport({ ...facts, proxyListener: { port: 8094, ok: true } }).some((l) => /listener for tailscale serve/.test(l.text))).toBe(false);
    // Tailscale running as Hatchabot's own user: its header is not believed, and doctor says what to do (the owner's call, 2026-11-24).
    const ownTs = { own: 501, trusted: [] as number[], procs: [{ pid: 914, uid: 501, name: 'tailscaled' }] };
    const said = (tu: DoctorFacts['tailscaleUser']) => doctorReport({ ...facts, tailscaleUser: tu }).filter((l) => /runs as your own user|On a Mac/.test(l.text));
    expect(said(ownTs)).toEqual([{
      level: 'warn',
      text: 'Tailscale (tailscaled) runs as your own user (uid 501), so Hatchabot does not believe the address serve adds for each device: every device on your tailnet shares one sign-in limit',
      fix: 'Run Tailscale as root (the tailscaled system service). Or set HATCHABOT_PROXY_TRUST_UIDS=501 in .env and restart Hatchabot; then every program of your user, an agent\'s container under rootless Docker included, can choose its sign-in limit there',
    }]);
    // As root, or its uid listed: nothing to say.
    for (const tu of [{ ...ownTs, procs: [{ pid: 1, uid: 0, name: 'tailscaled' }] }, { ...ownTs, trusted: [501] }]) expect(said(tu)).toEqual([]);
    // On a Mac nothing of another user is believed yet (lsof sees only this user's programs, one at a time: the review of HB-1239),
    // so a root Tailscale (the Standalone app's system extension) is not either, and doctor says so.
    const mac = { own: 501, trusted: [] as number[], procs: [{ pid: 812, uid: 0, name: 'io.tailscale.ipn.macsys.network-extension' }], mac: true as const };
    const macLine = {
      level: 'warn',
      text: 'On a Mac, Hatchabot cannot yet tell which user made a connection to its listener for tailscale serve when it is not your own, so it does not believe the address serve adds for each device: every device on your tailnet shares one sign-in limit',
      fix: 'Nothing to change for now; until then one person\'s wrong passwords on your tailnet lock the others out for a while',
    };
    expect(said(mac)).toEqual([macLine]);
    expect(said({ ...mac, trusted: [0] })).toEqual([macLine]);
    expect(said({ ...mac, procs: [] })).toEqual([macLine]);
    // The App Store app, which runs as you: not believed unless listed, and the Standalone app does not help yet.
    const appStore = { ...mac, procs: [{ pid: 913, uid: 501, name: 'IPNExtension' }] };
    expect(said(appStore)).toEqual([{
      level: 'warn',
      text: 'Tailscale (IPNExtension) runs as your own user (uid 501), so Hatchabot does not believe the address serve adds for each device: every device on your tailnet shares one sign-in limit',
      fix: 'On a Mac, running Tailscale as root (the Standalone app) does not help yet: Hatchabot cannot tell there which user a connection is from when it is not yours, so it believes none. HATCHABOT_PROXY_TRUST_UIDS=501 in .env would believe this app, but also every other program of yours, an agent\'s container under Docker Desktop included, which could then choose its sign-in limit there',
    }]);
    expect(said({ ...appStore, trusted: [501] })).toEqual([]);
    // `sudo hatchabot doctor`: root's uid is doctor's, the user who ran sudo is Hatchabot's (the review of HB-1239).
    expect(hatchabotUid(0, { SUDO_UID: '1000' })).toBe(1000);
    expect([hatchabotUid(0, {}), hatchabotUid(1000, { SUDO_UID: '1001' }), hatchabotUid(0, { SUDO_UID: '0' }), hatchabotUid(0, { SUDO_UID: 'x' }), hatchabotUid(undefined, { SUDO_UID: '1000' })])
      .toEqual([0, 1000, 0, 0, undefined]);
    // Its port is the app's own: the fix says so.
    const own = "HATCHABOT_PROXY_PORT=8080 is the app's own port (PORT=8080): choose another port for it.";
    expect(doctorReport({ ...facts, proxyListener: { port: 8080, ok: false, clash: own } }).find((l) => /listener for tailscale serve/.test(l.text))!.fix)
      .toBe(`${own} Set HATCHABOT_PROXY_PORT to a free port in .env, then restart Hatchabot`);
  });
});

describe('the listener for tailscale serve is private, as the app\'s own port is', () => {
  it('the running gate finds Funnel pointed at it, as at the app\'s own port, and not at the public one', async () => {
    shim = tailscaleShim();
    process.env.HATCHABOT_TAILSCALE_BIN = shim.bin;
    const at = (port: number) => ({ TCP: { '8443': { HTTPS: true } }, Web: { [`${SHIM_DNS}:8443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } }, AllowFunnel: { [`${SHIM_DNS}:8443`]: true } });
    shim.setConfig(at(8094));
    expect(await funnelOnPrivatePort(8080)).toBe(true);
    shim.setConfig(at(8080));
    expect(await funnelOnPrivatePort(8080)).toBe(true);
    shim.setConfig(at(8092));
    expect(await funnelOnPrivatePort(8080)).toBe(false);
  });

  it('Funnel is not turned on while it publishes that port, and safeguard d fails for it', async () => {
    shim = tailscaleShim();
    process.env.HATCHABOT_TAILSCALE_BIN = shim.bin;
    shim.setConfig({ TCP: { '443': { HTTPS: true } }, Web: { [`${SHIM_DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8094' } } } }, AllowFunnel: { [`${SHIM_DNS}:443`]: true } });
    const r = await funnelOn(8092, 8443, 8080, 8094);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(`Funnel already publishes ${SHIM_DNS}:443 to the private port 8094. Turn that off first (tailscale funnel --https=443 off): internet traffic there is treated as this machine.`);
    expect(shim.calls().some((c) => c[0] === 'funnel' && c[1] !== 'status')).toBe(false);
    // hatchabot doctor sees it too: Funnel on a private port, safeguard d off.
    const seen = await publicAccessFacts({ HATCHABOT_AUTH: 'accounts' }, '/nonexistent.sqlite', 8080,
      { autoUpgrade: async () => ({ ok: true }), funnel: async () => parseFunnelStatus(JSON.stringify(shim!.config())), envPath: `${shim.dir}/.env` });
    expect(seen.funnel).toEqual({ toPublicPort: false, toPrivatePort: true });
    expect(seen.safeguards.find((c) => c.id === 'separate-listener')!.ok).toBe(false);

    const good: SafeguardFacts = {
      authMode: 'accounts', managed: false, admins: [{ id: 'a1', name: 'owner', totp: 1, passkeyRpIds: [] }], invitedOnly: true, ownerHeader: false,
      ports: { main: 8080, public: 8092, ops: 8091, embed: 8093, proxy: 8094 }, autoUpgrade: { ok: true }, funnelOnPrivatePort: false, loginFailLimit: 10,
    };
    const fails = (f: SafeguardFacts) => failingSafeguards(evaluateSafeguards(f)).map((c) => c.id);
    expect(fails(good)).toEqual([]);
    expect(fails({ ...good, ports: { ...good.ports, public: 8094 } })).toEqual(['separate-listener']);
    const d = evaluateSafeguards({ ...good, funnelOnPrivatePort: true }).find((c) => c.id === 'separate-listener')!;
    expect(d.detail).toBe('Tailscale Funnel is pointed at a private port (the app\'s 8080 or tailscale serve\'s 8094): internet traffic would arrive looking like this machine.');
  });
});

describe('the review\'s small things (HB-1239)', () => {
  it('a target\'s own path is kept when serve is moved', () => {
    const h = { hostPort: `${SHIM_DNS}:443`, port: 443, mount: '/', proxy: 'http://localhost:8080/x', https: true, funnel: false, foreground: false };
    expect(repointArgs(h, 8094)).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:8094/x']);
    expect(repointArgs({ ...h, proxy: 'http://localhost:8080/' }, 8094).at(-1)).toBe('http://127.0.0.1:8094');
  });

  it('the listener refuses the management door\'s port and memory search\'s too', async () => {
    const app = Fastify();
    const env = { PORT: '8080' } as NodeJS.ProcessEnv;
    expect((await openProxyListener(app, 8091, env)).error).toBe('HATCHABOT_PROXY_PORT=8091 is the management door\'s (HATCHABOT_OPS_PORT=8091): choose another port for it.');
    expect((await openProxyListener(app, 8093, env)).error).toBe('HATCHABOT_PROXY_PORT=8093 is memory search\'s (HATCHABOT_EMBED_PORT=8093): choose another port for it.');
    expect((await openProxyListener(app, 7001, { ...env, HATCHABOT_OPS_PORT: '7001' })).listening).toBe(false);
    await app.close();
  });

  it('a forwarded IPv6 address is counted per /64, as a direct one is, but a tailnet device\'s address is its own', () => {
    _resetLoginThrottle();
    for (const a of ['2001:db8:1:2::a', '2001:db8:1:2:ffff::b', 'fd7a:115c:a1e0::11', 'fd7a:115c:a1e0::12', '::ffff:100.64.0.7']) noteFailure(servedRequest(a));
    const keys = _loginThrottleKeys().filter((k) => k.startsWith('ip:fwd:'));
    expect(keys.sort()).toEqual(['ip:fwd:100.64.0.7', 'ip:fwd:2001:db8:1:2::/64', 'ip:fwd:fd7a:115c:a1e0::11', 'ip:fwd:fd7a:115c:a1e0::12']);
  });

  it('under a test runner, Tailscale is never even looked up unless the test named its own binary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-ts-lookup-'));
    const rec = join(dir, 'called');
    writeFileSync(join(dir, 'tailscale'), `#!/bin/sh\necho "$@" >> '${rec}'\necho 1.80.0\n`, { mode: 0o755 });
    const was = { PATH: process.env.PATH, BIN: process.env.HATCHABOT_TAILSCALE_BIN };
    try {
      delete process.env.HATCHABOT_TAILSCALE_BIN;
      process.env.PATH = `${dir}:${was.PATH}`;
      expect(await tailnetInfo(8094, 8080)).toMatchObject({ installed: false });
      expect(existsSync(rec) ? readFileSync(rec, 'utf8') : '').toBe('');
    } finally {
      process.env.PATH = was.PATH;
      if (was.BIN === undefined) delete process.env.HATCHABOT_TAILSCALE_BIN; else process.env.HATCHABOT_TAILSCALE_BIN = was.BIN;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a reverse proxy still pointed at the app\'s own port (HB-1239 review)', () => {
  closeAfterEach();
  const said = 'A proxy on this machine sends visitors to port 8080 with X-Forwarded-For, which Hatchabot believes only on 127.0.0.1:8094: every visitor behind it shares one sign-in limit, so one person\'s wrong passwords lock out everyone. Point it at 127.0.0.1:8094 instead (in a Caddyfile: reverse_proxy 127.0.0.1:8094).';
  /** An app with the watch, armed unless asked not to; `who` finds each connection's user (root: Caddy's or nginx's own user, believed). */
  const watched = (o: { who?: PeerUserLookup; armed?: boolean; now?: () => number; before?: (app: ReturnType<typeof Fastify>) => void } = {}) => {
    const lines: string[] = [];
    const app = Fastify({ logger: { level: 'warn', stream: { write: (l: string) => { lines.push(JSON.parse(l).msg); } } } });
    o.before?.(app);
    let asked = 0;
    const who = o.who ?? (async () => 0);
    const watch = watchForwardedOnAppPort(app, { main: 8080, proxy: 8094, own: OWN, env: {}, now: o.now, lookup: (...a) => { asked++; return who(...a); } });
    if (o.armed !== false) watch.arm();
    app.get('/x', async () => 'ok');
    return { app, lines, watch, asked: () => asked };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('is noticed on a loopback request there that carries X-Forwarded-For from a peer the listener would believe: logged once a start, nothing else changed', async () => {
    _resetForwardedOnAppPort();
    const { app, lines } = watched();
    expect((await app.inject({ url: '/x' })).statusCode).toBe(200);
    await settle();
    expect(forwardedOnAppPort()).toBeUndefined();
    for (let i = 0; i < 3; i++) { expect((await app.inject({ url: '/x', headers: { 'x-forwarded-for': `198.51.100.${i}` } })).statusCode).toBe(200); await settle(); }
    expect(forwardedOnAppPort()).toMatchObject({ port: 8080, proxyPort: 8094 });
    expect(lines).toEqual([said]);
    await app.close();
  });

  it('not before the start\'s move of tailscale serve has left nothing on the app\'s port: until then serve itself sends the tabs there', async () => {
    _resetForwardedOnAppPort();
    const { app, watch, asked } = watched({ armed: false });
    await app.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.1' } });
    await settle();
    expect([forwardedOnAppPort(), asked()]).toEqual([undefined, 0]);
    watch.arm();
    await app.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.1' } });
    await settle();
    expect(forwardedOnAppPort()).toMatchObject({ port: 8080 });
    // What the start arms it on: the move finished, nothing left on the app's port, nothing unread.
    expect(serveOffAppPort({ left: [] })).toBe(true);
    expect(serveOffAppPort({ left: [{ where: 'https:443 /' }] })).toBe(false);
    expect(serveOffAppPort({ left: [], error: 'Tailscale\'s serve configuration could not be read.' })).toBe(false);
    await app.close();
  });

  it('not from a peer the listener would not believe either (an agent\'s container, as Hatchabot\'s own user; one not found)', async () => {
    _resetForwardedOnAppPort();
    for (const who of [async () => OWN, async () => undefined] as PeerUserLookup[]) {
      const { app, lines } = watched({ who });
      await app.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.2' } });
      await settle();
      expect([forwardedOnAppPort(), lines]).toEqual([undefined, []]);
      await app.close();
    }
  });

  it('one lookup at a time: requests while one is out are not looked up', async () => {
    _resetForwardedOnAppPort();
    let answer!: (u: number) => void;
    const { app, asked } = watched({ who: () => new Promise((r) => { answer = r; }) });
    for (let i = 0; i < 3; i++) await app.inject({ url: '/x', headers: { 'x-forwarded-for': `198.51.100.${i}` } });
    expect(asked()).toBe(1);
    answer(0);
    await settle();
    expect(forwardedOnAppPort()).toMatchObject({ port: 8080 });
    await app.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.9' } });
    expect(asked()).toBe(2);
    await app.close();
  });

  it('shown while seen in the last hour: a proxy pointed at the listener clears it', async () => {
    _resetForwardedOnAppPort();
    let t = Date.parse('2026-11-24T10:00:00Z');
    const { app, lines } = watched({ now: () => t });
    await app.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.3' } });
    await settle();
    expect(forwardedOnAppPort(t)).toEqual({ at: '2026-11-24T10:00:00.000Z', lastSeen: '2026-11-24T10:00:00.000Z', port: 8080, proxyPort: 8094 });
    t += 30 * 60_000;
    await app.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.3' } });
    await settle();
    expect(forwardedOnAppPort(t)).toMatchObject({ at: '2026-11-24T10:00:00.000Z', lastSeen: '2026-11-24T10:30:00.000Z' });
    expect(forwardedOnAppPort(t + 59 * 60_000)).toBeDefined();
    expect(forwardedOnAppPort(t + 60 * 60_000)).toBeUndefined();
    // Seen again after that: shown again, as a new sighting; the log said it once this start.
    t += 2 * 60 * 60_000;
    await app.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.3' } });
    await settle();
    expect(forwardedOnAppPort(t)).toMatchObject({ at: '2026-11-24T12:30:00.000Z' });
    expect(lines).toEqual([said]);
    await app.close();
  });

  it('not for a request from elsewhere: one not from loopback, or the public listener\'s (Funnel, from the internet)', async () => {
    _resetForwardedOnAppPort();
    const lan = watched();
    await lan.app.inject({ url: '/x', remoteAddress: '192.0.2.10', headers: { 'x-forwarded-for': '198.51.100.4' } });
    await settle();
    expect([forwardedOnAppPort(), lan.asked()]).toEqual([undefined, 0]);
    await lan.app.close();
    const pub = watched({ before: (app) => app.addHook('onRequest', async (req: { raw: { socket: Socket } }) => { markPublicSocket(req.raw.socket); }) });
    await pub.app.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.5' } });
    await settle();
    expect([forwardedOnAppPort(), pub.asked()]).toEqual([undefined, 0]);
    await pub.app.close();
  });

  it('not through the listener for it, where the header is the proxy\'s to give', async () => {
    _resetForwardedOnAppPort();
    const { app, lines } = watched();
    const door = await viaServe(app);
    expect((await door.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.7' } })).statusCode).toBe(200);
    await settle();
    expect(forwardedOnAppPort()).toBeUndefined();
    expect(lines).toEqual([]);
    await app.close();
  });

  it('the machine\'s owner is told under Alerts (/v1/account), and nobody else', async () => {
    _resetForwardedOnAppPort();
    const w = await world();
    expect((await w.call('GET', '/v1/account')).json().proxyOnAppPort).toBeUndefined();
    const { app } = watched();
    await app.inject({ url: '/x', headers: { 'x-forwarded-for': '198.51.100.9' } });
    await settle();
    await app.close();
    expect((await w.call('GET', '/v1/account')).json().proxyOnAppPort).toMatchObject({ port: 8080, proxyPort: 8094 });
    const other = await w.h.addAccount('sam', { totp: false });
    const seen = await w.h.app.inject({ method: 'GET', url: '/v1/account', headers: { cookie: await privCookie(w.h, 'sam', other.password) } });
    expect(seen.json().proxyOnAppPort).toBeUndefined();
  }, 60_000);
});
