import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { isPublic, markProxySocket, viaProxy } from './trust.js';
import { proxyPort, type ProxyListenerState } from '../ops/tailnet.js';
import { believePeer, capLookups, machineLookup, socketInode, trustedUids, type PeerUser, type PeerUserLookup } from '../ops/peerUser.js';
import { publicConfig } from './safeguards.js';

/**
 * The proxy's own listener (HB-1239): a second door into the same app, on
 * 127.0.0.1 only, for `tailscale serve` (or another reverse proxy on this
 * machine) to be pointed at. Every socket it accepts is marked (trust.ts
 * markProxySocket), and only there is a request's X-Forwarded-For believed,
 * as the visitor's own address for the sign-in limits. On the app's own port
 * the peer counts as itself: under a rootless daemon or Docker Desktop an
 * agent's container is a loopback peer there, and named a new address for
 * every sign-in try.
 *
 * Plain HTTP, whatever the main listener is: the proxy in front holds the
 * certificate. Everything else is the main listener's: the same routes and
 * hooks (Fastify's router), the same timeouts, and the console's WebSocket
 * handed to the app's own upgrade handler.
 */
// Its port and the command that points serve at it live with the rest of serve's code (a layer the reach service may import).
export { PROXY_PORT_DEFAULT, proxyPort, serveCommand, type ProxyListenerState } from '../ops/tailnet.js';

export interface ProxyListener {
  listening: boolean;
  port: number;
  /** The address it listens on: 127.0.0.1, never every interface. */
  host?: string;
  error?: string;
  close(): Promise<void>;
}

/**
 * This process's listener, as it last opened or failed to (undefined: none
 * was tried, as in a test's own app). The setup guide reads it before it
 * moves or turns on serve: never onto a listener that is not open.
 */
let current: ProxyListenerState | undefined;
export const proxyListenerState = (): ProxyListenerState | undefined => current;

/** Why the listener may not have this port (the app's own, or the public listener's), or undefined. */
export function proxyPortClash(port: number, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const mainPort = Number(env.PORT ?? 8080) || 8080;
  const clash = port === mainPort ? `the app's own port (PORT=${mainPort})`
    : publicConfig(env).port === port ? `the public listener's (HATCHABOT_PUBLIC_PORT=${port})`
    : (Number(env.HATCHABOT_OPS_PORT ?? 8091) || 8091) === port ? `the management door's (HATCHABOT_OPS_PORT=${port})`
    : (Number(env.HATCHABOT_EMBED_PORT ?? 8093) || 8093) === port ? `memory search's (HATCHABOT_EMBED_PORT=${port})` : undefined;
  return clash ? `HATCHABOT_PROXY_PORT=${port} is ${clash}: choose another port for it.` : undefined;
}

/**
 * How the listener learns who connected (src/ops/peerUser.ts): this
 * machine's answer by default; a test hands in its own, as others hand in fetch.
 */
export interface ProxyListenerOptions {
  peerUser?: PeerUserLookup;
  /** Hatchabot's own uid (process.getuid). */
  ownUid?: number;
  /** Lookups waiting at once, at most (LOOKUPS_WAITING_MAX). */
  lookupsWaitingMax?: number;
}

/**
 * What the listener knows of one connection: its first lookup (`first`, which
 * its first request waits for), the answer, and whether it is being asked
 * again. `inode`: its own end, fixed at its connection.
 */
interface Decision { first: Promise<void>; answered: boolean; peer: PeerUser; retrying: boolean; inode: number | undefined }

/** Said once a start: a connection of Hatchabot's own user that brought X-Forwarded-For, so not believed. */
let saidOwnUser = false;
export const ownUserWords = (uid: number | 'unknown'): string =>
  `A connection to the listener for tailscale serve came from Hatchabot's own user (uid ${uid}) with X-Forwarded-For, which is not believed from that user: it is counted as itself. If Tailscale runs as your own user, every device on your tailnet shares one sign-in limit: hatchabot doctor says what to do.`;

export async function openProxyListener(app: FastifyInstance, port: number = proxyPort(), env: NodeJS.ProcessEnv = process.env, opts: ProxyListenerOptions = {}): Promise<ProxyListener> {
  const clash = proxyPortClash(port, env);
  if (clash) {
    current = { listening: false, port, error: clash };
    return { ...current, close: async () => {} };
  }
  const sockets = new Set<Socket>();
  // Who connected, decided once per connection when it is accepted, and its requests wait for that:
  // tailscaled's keep-alive connection is asked about once (HB-1239, the owner's call 2026-11-24).
  // At most so many waiting at once (HB-1239 review): beyond it a connection is "cannot tell", not believed and not dropped.
  const own = opts.ownUid ?? process.getuid?.();
  const trusted = trustedUids(env);
  // Made once the port is open (its lines are the ones read); no connection comes before.
  let lookup: PeerUserLookup = async () => undefined;
  const decided = new WeakMap<Socket, Decision>();
  const ask = (socket: Socket, inode: number | undefined): Promise<PeerUser> =>
    lookup({ address: socket.remoteAddress ?? '', port: socket.remotePort ?? 0 }, { address: socket.localAddress ?? '127.0.0.1', port: socket.localPort ?? port }, inode)
      .catch(() => undefined);
  const settle = (socket: Socket, d: Decision, peer: PeerUser) => {
    d.peer = peer;
    d.answered = true;
    markProxySocket(socket, believePeer(peer, own, trusted));
  };
  const s: Server = createServer((req, res) => {
    const socket = req.socket;
    const d = decided.get(socket);
    // Came after an answer: the first request of a connection waits for it, a later one does not.
    const afterAnswer = !!d?.answered;
    void (d?.first ?? Promise.resolve()).then(() => {
      // "Cannot tell" (the cap was full, or the peer was not found), never Hatchabot's own user:
      // asked again at a request after that answer, one at a time, and this request counts as
      // not believed meanwhile. A keep-alive connection that lasts hours, tailscaled's, is not
      // left in one shared bucket by a flood it met when it was made (HB-1239 review).
      if (d && afterAnswer && d.peer === undefined && !d.retrying) {
        d.retrying = true;
        void ask(socket, d.inode).then((peer) => { d.retrying = false; settle(socket, d, peer); }).catch(() => { d.retrying = false; });
      }
      const peer = d?.peer;
      if (!saidOwnUser && peer !== undefined && peer === own && !trusted.includes(peer) && req.headers['x-forwarded-for'] !== undefined) {
        saidOwnUser = true;
        app.log.warn({ uid: peer }, ownUserWords(peer));
      }
      app.routing(req, res);
    }).catch(() => { res.statusCode = 503; res.end(); });
  });
  s.on('connection', (socket) => {
    markProxySocket(socket);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    const d: Decision = { first: Promise.resolve(), answered: false, peer: undefined, retrying: false, inode: socketInode(socket) };
    d.first = ask(socket, d.inode).then((peer) => settle(socket, d, peer));
    decided.set(socket, d);
  });
  s.on('upgrade', (req, socket, head) => {
    // Node takes its own error listener off a socket it hands to 'upgrade': a reset with none
    // would end the process (HB-1239 review). Put one on before anything else.
    socket.on('error', () => socket.destroy());
    if (app.server.listenerCount('upgrade') === 0) { socket.destroy(); return; }
    // Handed on at once: nothing on the upgrade path reads whether the peer is believed, and
    // a socket not decided yet reads as not believed (markProxySocket at its connection).
    app.server.emit('upgrade', req, socket, head);
  });
  // As the main listener has them (Fastify's: no limit on a request, so a
  // big upload through the tailnet is not cut off at Node's five minutes).
  s.requestTimeout = app.server.requestTimeout;
  s.headersTimeout = app.server.headersTimeout;
  s.keepAliveTimeout = app.server.keepAliveTimeout;
  s.timeout = app.server.timeout;
  try {
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      // Loopback only: tailscaled is on this machine, and nothing on the LAN reaches this port. A tailscaled
      // without a TUN device (userspace networking) is the exception: it dials 127.0.0.1 for any tailnet
      // connection to this machine's own address, so the tailnet reaches it too (hatchabot doctor says so).
      s.listen(port, '127.0.0.1', () => { s.off('error', reject); resolve(); });
    });
  } catch (err) {
    current = { listening: false, port, error: `The listener for tailscale serve could not open 127.0.0.1:${port}: ${String((err as Error)?.message ?? err)}` };
    return { ...current, close: async () => {} };
  }
  s.on('error', (err) => app.log.error({ err: String(err) }, 'proxy_listener.error'));
  const bound = s.address() as { port: number; address: string };
  const opened = bound.port;
  lookup = capLookups(opts.peerUser ?? machineLookup({ port: opened, own, trusted }), opts.lookupsWaitingMax);
  const mine: ProxyListenerState = { listening: true, port: opened };
  current = mine;
  const close = (): Promise<void> => new Promise((resolve) => {
    if (current === mine) current = { listening: false, port: opened, error: 'Hatchabot closed it.' };
    s.close(() => resolve());
    for (const sock of sockets) sock.destroy();
    sockets.clear();
  });
  return { listening: true, port: opened, host: bound.address, close };
}

/**
 * A reverse proxy still pointed at the app's own port (a Caddyfile's
 * `reverse_proxy 127.0.0.1:8080`, as docs/deploy-gce.md had it before
 * 2.192.0): its X-Forwarded-For is not believed there, so every visitor
 * behind it shares one sign-in limit, and one stranger's wrong passwords lock
 * out everyone. Logged once per start, and shown to the machine's owner under
 * Alerts (`/v1/account`'s proxyOnAppPort) while it was seen in the last hour,
 * so pointing the proxy at the listener clears it (the review of HB-1239).
 *
 * Counted only:
 *  - once the start's move of `tailscale serve` has finished and left
 *    nothing on the app's port (`arm`): until then serve itself sends the
 *    household's tabs there, and doctor and the setup guide say so;
 *  - from a loopback peer the listener for the proxy would believe (the
 *    same lookup, one at a time, skipped while one is out): an agent's
 *    container cannot raise it, and "point it there" is true.
 */
export interface ForwardedOnAppPort { at: string; lastSeen: string; port: number; proxyPort: number }
let onAppPort: { at: number; lastSeen: number; port: number; proxyPort: number } | undefined;
let saidOnAppPort = false;
/** How long a sighting is shown under Alerts. */
export const ON_APP_PORT_SHOWN_MS = 60 * 60_000;
export const forwardedOnAppPort = (now: number = Date.now()): ForwardedOnAppPort | undefined =>
  onAppPort && now - onAppPort.lastSeen < ON_APP_PORT_SHOWN_MS
    ? { at: new Date(onAppPort.at).toISOString(), lastSeen: new Date(onAppPort.lastSeen).toISOString(), port: onAppPort.port, proxyPort: onAppPort.proxyPort }
    : undefined;
/** Test hook. */
export function _resetForwardedOnAppPort(): void { onAppPort = undefined; saidOnAppPort = false; saidOwnUser = false; }
export const forwardedOnAppPortWords = (port: number, proxy: number): string =>
  `A proxy on this machine sends visitors to port ${port} with X-Forwarded-For, which Hatchabot believes only on 127.0.0.1:${proxy}: every visitor behind it shares one sign-in limit, so one person's wrong passwords lock out everyone. Point it at 127.0.0.1:${proxy} instead (in a Caddyfile: reverse_proxy 127.0.0.1:${proxy}).`;
const LOOPBACK = /^(?:127\.|::1$|::ffff:127\.)/;

/** The start's move of serve has finished with nothing left on the app's port: what `arm` waits for. */
export const serveOffAppPort = (r: { left: unknown[]; error?: string }): boolean => !r.left.length && !r.error;

export interface AppPortWatchOptions {
  main: number;
  proxy: number;
  /** Tests: the lookup (this machine's for the app's port by default), Hatchabot's uid, the clock. */
  lookup?: PeerUserLookup;
  own?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}
export function watchForwardedOnAppPort(app: FastifyInstance, o: AppPortWatchOptions): { arm(): void } {
  let armed = false, asking = false;
  const own = o.own ?? process.getuid?.();
  const trusted = trustedUids(o.env);
  const lookup = o.lookup ?? machineLookup({ port: o.main, own, trusted });
  const now = o.now ?? Date.now;
  app.addHook('onRequest', async (req) => {
    if (!armed || asking || req.headers['x-forwarded-for'] === undefined) return;
    if (viaProxy(req) || isPublic(req) || !LOOPBACK.test(req.socket?.remoteAddress ?? '')) return;
    const socket = req.raw.socket;
    asking = true;
    void lookup({ address: socket.remoteAddress ?? '', port: socket.remotePort ?? 0 }, { address: socket.localAddress ?? '127.0.0.1', port: socket.localPort ?? o.main }, socketInode(socket))
      .then((peer) => {
        asking = false;
        if (!believePeer(peer, own, trusted)) return;
        const t = now();
        onAppPort = { at: onAppPort && t - onAppPort.lastSeen < ON_APP_PORT_SHOWN_MS ? onAppPort.at : t, lastSeen: t, port: o.main, proxyPort: o.proxy };
        if (saidOnAppPort) return;
        saidOnAppPort = true;
        app.log.warn({ port: o.main, proxyPort: o.proxy }, forwardedOnAppPortWords(o.main, o.proxy));
      })
      .catch(() => { asking = false; });
  });
  return { arm: () => { armed = true; } };
}
