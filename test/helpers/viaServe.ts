import type { FastifyInstance } from 'fastify';
import { onTestFinished } from 'vitest';
import { markProxySocket } from '../../src/api/trust.js';
import { openProxyListener, type ProxyListener } from '../../src/api/proxyListener.js';
import { freePort } from './ports.js';

/**
 * Requests as `tailscale serve` sends them (HB-1239): through the app's
 * listener for the proxy, a real one on a free loopback port, where only the
 * X-Forwarded-For the proxy appended (the last) names the client. The answer
 * has the shape `app.inject` gives, so a test can swap one for the other.
 * Closed when the test ends.
 */
export interface ServedReply { statusCode: number; body: string; headers: Record<string, string>; cookies: Array<{ name: string; value: string }>; json(): any }
export interface Served {
  port: number;
  inject(o: { method?: string; url: string; payload?: unknown; headers?: Record<string, string> }): Promise<ServedReply>;
}

/**
 * `peer`: the user the connection is made by, as the listener finds it (src/ops/peerUser.ts): root by default, as
 * tailscaled runs; the machine's own lookup is never asked in a test.
 */
export async function viaServe(app: FastifyInstance, peer: number | undefined = 0): Promise<Served> {
  await app.ready();
  let l: ProxyListener | undefined;
  for (let i = 0; i < 5 && !l?.listening; i++) l = await openProxyListener(app, await freePort(), {}, { peerUser: async () => peer, ownUid: 1000 });
  if (!l?.listening) throw new Error(`no listener for tailscale serve: ${l?.error}`);
  const listener = l;
  onTestFinished(() => listener.close());
  return {
    port: listener.port,
    async inject({ method = 'GET', url, payload, headers = {} }) {
      const body = payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload);
      const r = await fetch(`http://127.0.0.1:${listener.port}${url}`, {
        method, redirect: 'manual',
        headers: { ...(body !== undefined && typeof payload !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers },
        body,
      });
      const text = await r.text();
      const cookies = r.headers.getSetCookie().map((c) => { const [pair = ''] = c.split(';'); const at = pair.indexOf('='); return { name: pair.slice(0, at), value: pair.slice(at + 1) }; });
      return { statusCode: r.status, body: text, headers: Object.fromEntries(r.headers), cookies, json: () => JSON.parse(text) };
    },
  };
}

/** A made-up request object as the proxy's listener hands it to the sign-in limits, naming `fwd` as the client. */
/** A request through the listener for tailscale serve, from a peer whose header is believed (tailscaled, as root). */
export function servedRequest(fwd: string, extra: Record<string, unknown> = {}): never {
  const socket = {};
  markProxySocket(socket, true);
  return { ip: '127.0.0.1', headers: { 'x-forwarded-for': fwd }, raw: { socket }, socket, server: {}, log: { warn() {} }, ...extra } as never;
}
