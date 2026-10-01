import { randomBytes, timingSafeEqual } from 'node:crypto';
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
  return typeof mark === 'string' && mark.length === REPLAY_SECRET.length && timingSafeEqual(Buffer.from(mark), Buffer.from(REPLAY_SECRET));
}

const last = (v: string | string[] | undefined): string | undefined => {
  const s = Array.isArray(v) ? v[v.length - 1] : v;
  return s?.split(',').pop()?.trim() || undefined;
};

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

/** A coarse form of an address for a notice: enough to say "somewhere new", not a precise locator. */
export function approximateSource(addr: string): string {
  if (addr.includes(':')) return addr.split(':').slice(0, 3).join(':') + '::/48';
  const p = addr.split('.');
  return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.x` : addr;
}
