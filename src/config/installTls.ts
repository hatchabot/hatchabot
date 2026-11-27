/**
 * The CLI's requests to this install's own listener when Hatchabot serves
 * TLS itself (HB-1375). setup-host.sh saves https://<bind or localhost>:<port>
 * for it, but a plain fetch trusts only Node's bundled authorities and checks
 * the name: a self-signed or mkcert certificate, or one naming the machine's
 * real name while the address says localhost, failed every command.
 *
 * So, for this install's own address only (loopback, or its HATCHABOT_BIND),
 * the certificate the server serves (the first in HATCHABOT_TLS_CERT, from
 * the install's .env) is trusted beside the bundled authorities, as itself
 * and nothing more: the listener's certificate passes without its name
 * checked only when it is that very certificate (its fingerprint). Any other
 * certificate there is checked as fetch checks it: the rest of the file (a
 * chain, a local authority) is not trusted, nor is a certificate the pinned
 * one signed. Any other address is a plain fetch. Certificate checks are
 * never turned off.
 *
 * And an address with a zone (a link-local fe80::1%eth0, HB-1539), which no
 * fetch can take: it is asked by host and port, as doctor asks it
 * (zonedTarget, the one helper both use).
 */
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { checkServerIdentity, rootCertificates, type DetailedPeerCertificate, type PeerCertificate } from 'node:tls';
import { activeValues, envValue } from './envFile.js';

export interface OwnTls {
  /** The bundled authorities and the install's own certificate (the file's first, alone). */
  ca: string[];
  /** The install's own certificate (the file's first), as a peer certificate gives it. */
  fingerprint256: string;
}

/** HATCHABOT_TLS_CERT and HATCHABOT_BIND from the install's .env, as the service reads them (AGENTCLAW_* for an unset one). */
export function installTlsSettings(envFile: string): { cert?: string; bind?: string } {
  let text: string;
  try { text = readFileSync(envFile, 'utf8'); } catch { return {}; }
  const m = activeValues(text);
  const get = (name: string) => {
    const v = m.get(`HATCHABOT_${name}`) ?? m.get(`AGENTCLAW_${name}`);
    return v === undefined ? undefined : envValue(v) || undefined;
  };
  return { cert: get('TLS_CERT'), bind: get('BIND') };
}

const bare = (h: string) => h.trim().replace(/^\[|\]$/g, '').toLowerCase();

/**
 * A URL whose host is an IPv6 address with a zone (http://[fe80::1%25eth0]:8080/, its % as
 * RFC 6874 writes it, or bare), in the parts a request by host and port takes. Node's URL
 * parser takes a zone in neither form, so fetch() and a request by URL refuse the address,
 * while a connection to it by host and port works (HB-1378). Undefined for any other URL.
 * Doctor's probe (src/doctor.ts gives it from there too) and the CLI's requests
 * (installFetch, HB-1539) ask such an address by these parts.
 */
export function zonedTarget(url: string): { protocol: 'http:' | 'https:'; host: string; port: number; path: string } | undefined {
  const m = /^(https?):\/\/\[([0-9a-f:.]+)%(?:25)?([\w.~-]+)\](?::(\d+))?(\/.*)?$/i.exec(url);
  if (!m) return undefined;
  const protocol = m[1]!.toLowerCase() === 'https' ? 'https:' : 'http:';
  return { protocol, host: `${m[2]}%${m[3]}`, port: Number(m[4] ?? (protocol === 'https:' ? 443 : 80)), path: m[5] || '/' };
}

/**
 * What a request to `url` trusts, when `url` is this install's own https
 * address and its certificate file reads; undefined for anything else.
 */
export function ownTls(url: string, settings: { cert?: string; bind?: string }, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): OwnTls | undefined {
  if (!settings.cert) return undefined;
  // An address with a zone by its parts (no URL takes it): its own when it is the bind address, zone and all.
  const zoned = zonedTarget(url);
  let host: string;
  if (zoned) {
    if (zoned.protocol !== 'https:') return undefined;
    host = zoned.host.toLowerCase();
  } else {
    let u: URL;
    try { u = new URL(url); } catch { return undefined; }
    if (u.protocol !== 'https:') return undefined;
    host = bare(u.hostname);
  }
  const bind = settings.bind ? bare(settings.bind) : '';
  const own = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host) || (bind !== '' && host === bind);
  if (!own) return undefined;
  try {
    // The first certificate alone: with every one in the file trusted, a
    // local authority beside the leaf signed for any server at the address
    // (review of HB-1375).
    const leaf = new X509Certificate(read(settings.cert));
    return { ca: [...rootCertificates, leaf.toString()], fingerprint256: leaf.fingerprint256 };
  } catch { return undefined; }
}

/**
 * A fetch over node:https with `tls`, for the bodies the CLI sends (none, a
 * string, bytes), answered as a Response (status, headers, a streamed body).
 * Its own connection each time, as doctor's probe: a TLS session kept from a
 * pinned handshake is never reused elsewhere. It fails as fetch fails: a
 * TypeError "fetch failed" with the socket's error as its cause, or the
 * signal's reason (before the answer, or while its body streams), so the
 * CLI's retries read it as they read fetch's (noAnswer: a hand-over whose
 * connection dropped is sent again). It has fetch's own bounds (undici's):
 * a connection within 10 seconds, the answer's headers within 300, and its
 * body never 300 without a byte (review of HB-1375). It follows no
 * redirect: the install's own address has none to give, and one fails,
 * saying where it pointed.
 *
 * An address with a zone (zonedTarget) is asked by its host and port, over
 * node:http or node:https as it says, `tls` for https only, and with none a
 * request checked as fetch checks one (HB-1539): fetch, and a request by URL,
 * take no zone.
 */
export function pinnedFetch(url: string, init: RequestInit, tls: OwnTls | undefined, bounds: Partial<PinnedBounds> = {}): Promise<Response> {
  const limit = { ...FETCH_BOUNDS, ...bounds };
  const zoned = zonedTarget(url);
  const secure = zoned ? zoned.protocol === 'https:' : /^https:/i.test(url);
  const where = secure ? 'the install\'s own https address' : 'the install\'s own address';
  return new Promise((resolve, reject) => {
    const body = init.body;
    if (body != null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      reject(new TypeError(`this request body cannot be sent to ${where}`));
      return;
    }
    const signal = init.signal ?? undefined;
    if (signal?.aborted) { reject(signal.reason); return; }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const method = (init.method ?? 'GET').toUpperCase();
    const late = (what: string, ms: number, code: string) => Object.assign(new Error(`${what} within ${ms / 1000} seconds`), { code });
    let answer: IncomingMessage | undefined;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => { if (answer) answer.destroy(signal!.reason); else req.destroy(signal!.reason); };
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const asked = {
      method, headers, agent: false as const,
      ...(secure && tls ? {
        ca: tls.ca,
        // A certificate a local authority signed (mkcert's), whose authority is
        // not in the file, is trusted as the file names it.
        allowPartialTrustChain: true,
        checkServerIdentity: (host: string, cert: PeerCertificate) => pinnedIdentity(host, cert, tls),
      } : {}),
      // By host and port: the only way a zoned address is taken.
      ...(zoned ? { host: zoned.host, port: zoned.port, path: zoned.path } : {}),
    };
    const onAnswer = (res: IncomingMessage) => {
      answer = res;
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      if (REDIRECTS.has(status)) {
        res.resume();
        done();
        reject(new Error(`${url} answered ${status}, a redirect to ${res.headers.location ?? 'nowhere'}: a request to ${where} follows none`));
        return;
      }
      // Never that long without a byte of the body, as fetch's bodyTimeout.
      res.socket.setTimeout(limit.body, () => res.destroy(new TypeError('terminated', { cause: late('the rest of the answer did not come', limit.body, 'UND_ERR_BODY_TIMEOUT') })));
      res.on('close', done);
      const h = new Headers();
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) h.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
      const empty = method === 'HEAD' || [101, 204, 205, 304].includes(status);
      if (empty) res.resume();
      try {
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), { status, statusText: res.statusMessage ?? '', headers: h }));
      } catch (err) { res.destroy(); reject(err); }
    };
    let req: ClientRequest;
    try {
      req = zoned ? (secure ? httpsRequest(asked, onAnswer) : httpRequest(asked, onAnswer))
        : secure ? httpsRequest(url, asked, onAnswer) : httpRequest(url, asked, onAnswer);
    } catch (err) {
      // Options it refuses, before there was a request: no timer yet.
      reject(new TypeError('fetch failed', { cause: err }));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    // Connected (TLS and all) within its bound; then the answer's headers within theirs.
    timer = setTimeout(() => req.destroy(late('no connection was made', limit.connect, 'UND_ERR_CONNECT_TIMEOUT')), limit.connect);
    req.on('socket', (socket) => socket.once(secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      if (!answer) timer = setTimeout(() => req.destroy(late('no answer came', limit.headers, 'UND_ERR_HEADERS_TIMEOUT')), limit.headers);
    }));
    req.on('error', (err) => { done(); reject(signal?.aborted ? signal.reason : new TypeError('fetch failed', { cause: err })); });
    req.end(body ?? undefined);
  });
}

/** How long a pinned request waits, as undici's fetch does by default: its connection, its answer's headers, the time between bytes of its body. */
export interface PinnedBounds { connect: number; headers: number; body: number }
const FETCH_BOUNDS: PinnedBounds = { connect: 10_000, headers: 300_000, body: 300_000 };
/** What fetch follows by default. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * The pinned certificate passes as itself. Any other must not lean on it:
 * the pin is in `ca` (so the handshake takes a certificate no authority
 * signed), and a pinned certificate that is also an authority (openssl
 * req -x509 makes one) would vouch for any certificate its key signed.
 * The rest is fetch's own name check.
 */
function pinnedIdentity(host: string, cert: PeerCertificate, tls: OwnTls): Error | undefined {
  if (cert.fingerprint256 === tls.fingerprint256) return undefined;
  // The handshake gives the whole chain (getPeerCertificate(true)); a self-signed one points at itself.
  for (let c = (cert as Partial<DetailedPeerCertificate>).issuerCertificate, n = 0; c && n < 16; c = c.issuerCertificate === c ? undefined : c.issuerCertificate, n++) {
    if (c.fingerprint256 === tls.fingerprint256) {
      return new Error(`the certificate at ${host} is not the install's own (HATCHABOT_TLS_CERT), and is signed by it: that one is trusted as itself only`);
    }
  }
  return checkServerIdentity(host, cert);
}

/**
 * A request from the CLI to the install it belongs to: pinned for its own
 * https address; an address with a zone by its host and port (HB-1539); a
 * plain fetch otherwise.
 */
export function installFetch(url: string, init: RequestInit, envFile: string): Promise<Response> {
  const zoned = zonedTarget(url);
  const tls = /^https:/i.test(url) ? ownTls(url, installTlsSettings(envFile)) : undefined;
  return tls || zoned ? pinnedFetch(url, init, tls) : fetch(url, init);
}
