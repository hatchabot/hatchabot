import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

/** Peer servers may live on a LAN, but never on loopback or link-local addresses. */
export function allowedPeerAddress(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const localV4 = (h: string) => /^(?:127\.|0\.|169\.254\.)/.test(h);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || localV4(host)) return false;
  if (host === '::' || host === '::1' || /^fe[89ab][0-9a-f]:/.test(host)) return false;
  // URL canonicalizes IPv4-mapped literals to hex, e.g. ::ffff:7f00:1.
  const mapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
    if (localV4(`${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`)) return false;
  }
  return true;
}

/**
 * The resolved-address side of the same policy: loopback, "this host",
 * link-local (cloud metadata lives there) and IPv4-compatible IPv6. A LAN or
 * tailnet address is a normal place for another Hatchabot. BlockList also
 * judges an IPv4-mapped IPv6 address (::ffff:127.0.0.1) by its IPv4 rules.
 */
const LOCAL_PEER = new BlockList();
LOCAL_PEER.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL_PEER.addSubnet('0.0.0.0', 8, 'ipv4');
LOCAL_PEER.addSubnet('169.254.0.0', 16, 'ipv4');
LOCAL_PEER.addSubnet('::', 96, 'ipv6'); // ::, ::1 and ::a.b.c.d
LOCAL_PEER.addSubnet('fe80::', 10, 'ipv6');

export function allowedPeerIp(ip: string): boolean {
  const family = isIP(ip);
  return family !== 0 && !LOCAL_PEER.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

export interface PeerRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}
/** How another Hatchabot server is called; tests hand in a stub. */
export type PeerFetch = (url: string, init?: PeerRequestInit) => Promise<Response>;
type Resolve = (host: string) => Promise<LookupAddress[]>;

/**
 * Every request to another Hatchabot server goes through here. The peer's URL
 * was checked as text when it was registered, but a NAME can resolve to
 * 127.0.0.1 or 169.254.169.254 (or start to, later: DNS rebinding), and a
 * redirect can point anywhere. So the socket's own lookup is checked — the
 * address judged is the address dialled, with no second lookup in between —
 * and a redirect is refused, never followed (a 307/308 would also carry a
 * migration's archive to wherever it pointed). An IP literal is not looked up:
 * the registration check judged it.
 */
export function pinnedPeerFetch(url: string, init: PeerRequestInit = {}, resolve: Resolve = (h) => dnsLookup(h, { all: true })): Promise<Response> {
  return new Promise((done, fail) => {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail(new Error('Another server is reached over http or https only.'));
    const lookup = (host: string, opts: { all?: boolean } | number | undefined, cb: (...a: unknown[]) => void) => {
      resolve(host).then((addrs) => {
        if (!addrs.length || addrs.some((a) => !allowedPeerIp(a.address))) {
          return cb(Object.assign(new Error(`${host} resolves to a local address, which is never another server.`), { code: 'EPEERLOCAL' }));
        }
        if (typeof opts === 'object' && opts?.all) return cb(null, addrs);
        cb(null, addrs[0]!.address, addrs[0]!.family);
      }, (err) => cb(err));
    };
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(typeof init.body === 'string' ? Buffer.byteLength(init.body) : init.body.byteLength);
    }
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, { method, headers, lookup: lookup as never, signal: init.signal }, (res) => {
      const status = res.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        return fail(new Error(`${u.host} answered with a redirect (${status}); another server is only called at its own address.`));
      }
      if (status < 200 || status > 599) {
        res.resume();
        return fail(new Error(`${u.host} answered with status ${status}.`));
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) v.forEach((x) => h.append(k, x));
        else if (v !== undefined) h.set(k, String(v));
      }
      const noBody = method === 'HEAD' || [204, 205, 304].includes(status);
      if (noBody) res.resume();
      done(new Response(noBody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? '', headers: h }));
    });
    req.on('error', fail);
    if (init.body === undefined) req.end(); else req.end(init.body);
  });
}
