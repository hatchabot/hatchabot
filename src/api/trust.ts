import { randomBytes } from 'node:crypto';
import { safeEqual } from '../util/safeEqual.js';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';

/**
 * Where a request came from, as a trust class (docs/public-access.md).
 *
 *   public   it arrived on the PUBLIC listener: the port Tailscale Funnel is
 *            pointed at, and nothing else. Anyone on the internet. The least
 *            trusted class: never "on this machine", never the tailnet.
 *   private  everything else: this machine, the LAN, the tailnet (`tailscale
 *            serve`), exactly as before public access existed.
 *
 * The class is a fact about the CONNECTION, never about a header. Funnel
 * traffic reaches us from 127.0.0.1 (tailscaled proxies it), and tailscaled
 * marks it `Tailscale-Funnel-Request: ?1`; but a design that read that header
 * would trust any request that lacks it, so a proxy change, a missing header
 * or a second path to the port would silently upgrade strangers to "local".
 * Instead Funnel is pointed at a separate port, and every socket that port
 * accepts is recorded here when it connects. A request is public if and only
 * if its socket is in this set: no header a client could send adds a socket
 * to it or takes one out, on either listener.
 *
 * One more way in, and it only ever LOWERS trust: a route that replays a
 * request inside this process on the caller's behalf (the management chat
 * executing a confirmed change with the confirmer's cookie) has no socket to
 * inherit. When the caller was public it stamps the replay with a marker
 * holding a secret that never leaves this process, and the replay is public
 * too, so a confirmed change gets the same route class and the same step-up
 * as if the person had called the route themselves.
 */
const publicSockets = new WeakSet<object>();

/** Called by the public listener for every connection it accepts. */
export function markPublicSocket(socket: Socket): void {
  publicSockets.add(socket);
}

type Rawish = { socket?: object | null; raw?: { socket?: object | null }; headers?: Record<string, string | string[] | undefined> };

const REPLAY_HEADER = 'x-hatchabot-public-replay';
const REPLAY_SECRET = randomBytes(32).toString('hex');
/** Headers for an in-process replay of this request: marks it public when the request was. */
export function publicReplayHeaders(req: Rawish | IncomingMessage): Record<string, string> {
  return isPublic(req) ? { [REPLAY_HEADER]: REPLAY_SECRET } : {};
}

/** Did this request arrive on the public listener? Takes Fastify's request or a raw one (an upgrade). */
export function isPublic(req: Rawish | IncomingMessage | undefined | null): boolean {
  if (!req) return false;
  const r = req as Rawish;
  const socket = r.raw?.socket ?? r.socket;
  if (socket && publicSockets.has(socket)) return true;
  const mark = r.headers?.[REPLAY_HEADER];
  if (typeof mark !== 'string') return false;
  return safeEqual(mark, REPLAY_SECRET);
}

const last = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v[v.length - 1] : v;
  return s?.split(',').pop()?.trim() || undefined;
};

/**
 * The proxy's own listener (proxyListener.ts): the loopback port `tailscale
 * serve` is pointed at, and the one place a request's X-Forwarded-For is
 * believed on the private side (HB-1239). As with the public listener, it is
 * a fact about the connection: every socket that port accepts is recorded
 * here, and no header adds one. Before, the forwarded address was believed
 * from any loopback peer, and under a rootless daemon or Docker Desktop an
 * agent's container is one, so it could name a new address for every
 * sign-in try. A request here is private, as before, and never "on this
 * machine" (accountsAuth.ts onThisMachine): it came through the proxy.
 *
 * And even here the header is believed only from a process of a user other
 * than Hatchabot's own (the owner's call, 2026-11-24): a container under
 * rootless Docker or Docker Desktop reaches this port as easily as the app's
 * own, through processes of Hatchabot's user. Each connection's answer is
 * kept with it, decided once when it is accepted (src/ops/peerUser.ts); not
 * believed, the peer's own address is its bucket, as on the app's own port.
 */
const proxySockets = new WeakMap<object, boolean>();

/** Called by the proxy's listener for every connection it accepts; `believed` once its peer's user is known. */
export function markProxySocket(socket: object, believed = false): void {
  proxySockets.set(socket, believed);
}

/** Did this request arrive on the proxy's listener? Takes Fastify's request or a raw one (an upgrade). */
export function viaProxy(req: Rawish | IncomingMessage | undefined | null): boolean {
  if (!req) return false;
  const r = req as Rawish;
  const socket = r.raw?.socket ?? r.socket;
  return !!socket && proxySockets.has(socket);
}

/**
 * The visitor's address as the proxy reports it, on the proxy's listener
 * only (undefined anywhere else; 'unknown' there when it gave none). The LAST
 * X-Forwarded-For value, the one the proxy itself added: tailscaled (1.40 and
 * later, ipn/ipnlocal/serve.go addProxyForwardedHeaders) SETS the header to
 * the tailnet address the connection came from, after Go's ReverseProxy has
 * dropped what the client sent (a Rewrite proxy); 1.38 used Go's Director
 * proxy, which APPENDS that address to whatever the client sent, and Caddy
 * and nginx append too. Either way the client's own text comes first, so
 * the first value was one a device on the tailnet could choose (HB-1435).
 */
export function proxiedClientAddress(req: Rawish & { headers: Record<string, string | string[] | undefined> }): string | undefined {
  if (!viaProxy(req)) return undefined;
  // Its peer's user is Hatchabot's own, or was not found: the header is not believed.
  if (proxySockets.get((req as Rawish).raw?.socket ?? (req as Rawish).socket!) !== true) return undefined;
  const a = last(req.headers['x-forwarded-for']);
  return a && /^[0-9a-fA-F:.]{2,45}$/.test(a) ? a : 'unknown';
}

/**
 * The visitor's address, for limits and the sign-in record — on the public
 * listener only. tailscaled SETS X-Forwarded-For to the address the Funnel
 * connection came from (one value; Go's reverse proxy drops what the client
 * sent before its Rewrite runs). The last value is taken, so even a proxy
 * that appended instead would not let a visitor choose their own bucket.
 * Something on this machine connecting straight to the public port can forge
 * it; that only moves it between per-address buckets, and the per-account
 * lockout and the global ceiling do not read it.
 */
export function publicClientAddress(req: { headers: Record<string, string | string[] | undefined> }): string {
  const a = last(req.headers['x-forwarded-for']);
  return a && /^[0-9a-fA-F:.]{2,45}$/.test(a) ? a : 'unknown';
}

/**
 * The bucket an address is counted in. An IPv6 visitor usually holds a whole
 * /64 and can change the rest at will, so the first four groups are the
 * bucket; an IPv4 address is its own.
 */
export function addressBucket(addr: string): string {
  if (!addr.includes(':')) return addr;
  const [head, tail] = addr.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The bucket a forwarded address is counted in: per /64, as a direct one is,
 * except in Tailscale's own range (fd7a:115c:a1e0::/48), where one tailnet's
 * devices share their first 64 bits and each address is one device the
 * coordination server gave it. An IPv4-mapped form is its IPv4 address.
 */
export function forwardedBucket(addr: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) return mapped[1]!;
  if (/^fd7a:115c:a1e0:/i.test(addr)) return addr.toLowerCase();
  return addressBucket(addr);
}

/** A coarse form of an address for a notice: enough to say "somewhere new", not a precise locator. */
export function approximateSource(addr: string): string {
  if (addr.includes(':')) return addr.split(':').slice(0, 3).join(':') + '::/48';
  const p = addr.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : addr;
}
