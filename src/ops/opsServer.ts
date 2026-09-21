import http from 'node:http';
import net from 'node:net';

/**
 * The management agent's only way out of its jail (docs/ops-agent-design.md).
 *
 * A small server bound to the isolated network's gateway address — so it is
 * reachable from that network and from this host, and from nowhere else. The
 * agent never touches Hatchabot's main port. Two jobs:
 *
 *  - POST /mcp: Hatchabot's tools, as an MCP server over HTTP. Authenticated
 *    by the agent's propose-only key; every call goes through the broker.
 *  - CONNECT host:443: an allowlisting HTTPS proxy, so the agent can reach its
 *    AI provider (and Telegram, if it has a bot) and nothing else.
 */

export interface OpsHandlers {
  /** JSON-RPC in, JSON-RPC out (undefined for a notification). Throws OpsAuthError for a bad key. */
  mcp(token: string, message: unknown): Promise<unknown>;
  /** Hosts this key may CONNECT to, or undefined for a bad key. */
  allowedHosts(token: string): string[] | undefined;
  /**
   * May this peer address use the door at all? Every legitimate connection
   * arrives from a management agent's own doorman; anything else on this
   * machine is refused before its key is even looked at.
   */
  peerOk?: (ip: string) => Promise<boolean>;
  /** How the tunnel reaches the far side. Tests pass a socket that never answers. */
  dial?: (host: string, port: number, onReady: () => void) => net.Socket;
  log?(event: string, detail: Record<string, unknown>): void;
}

export class OpsAuthError extends Error {}

/** ::ffff:172.20.0.2 and 172.20.0.2 are the same peer. */
export const normalizeIp = (ip: string | undefined): string => String(ip ?? '').replace(/^::ffff:/, '');

const bearer = (h: string | undefined): string => (h && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : '');
function proxyToken(h: string | undefined): string {
  if (!h || !/^Basic\s+/i.test(h)) return '';
  const raw = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  return raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : '';
}

export function createOpsServer(handlers: OpsHandlers): http.Server {
  const log = handlers.log ?? (() => {});
  const server = http.createServer((req, res) => {
    const send = (code: number, body?: unknown) => {
      res.writeHead(code, body === undefined ? {} : { 'content-type': 'application/json' });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.url !== '/mcp') return send(404, { error: 'Not found' });
    // Streamable HTTP without a server-initiated stream: POST only.
    if (req.method !== 'POST') return send(405, { error: 'POST only' });

    void (async () => {
      // Only a management agent's own doorman may use the door: anything else
      // on this machine is turned away before its key is looked at
      // (docs/ops-agent-design.md).
      const peer = normalizeIp(req.socket.remoteAddress);
      if (handlers.peerOk && !(await handlers.peerOk(peer).catch(() => false))) {
        log('ops.peer_refused', { peer, path: 'mcp' });
        return send(403, { error: 'Not your door.' });
      }

      const body = await new Promise<Buffer | undefined>((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 1_000_000) { req.destroy(); resolve(undefined); } else chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(undefined));
      });
      if (body === undefined) return;

      let msg: unknown;
      try { msg = JSON.parse(body.toString('utf8')); } catch { return send(400, { error: 'Bad JSON' }); }
      try {
        const token = bearer(req.headers.authorization);
        const out = Array.isArray(msg)
          ? (await Promise.all(msg.map((m) => handlers.mcp(token, m)))).filter((x) => x !== undefined)
          : await handlers.mcp(token, msg);
        if (out === undefined || (Array.isArray(out) && !out.length)) return send(202);
        return send(200, out);
      } catch (e) {
        if (e instanceof OpsAuthError) return send(401, { error: 'Unknown key' });
        log('ops.mcp_error', { error: String((e as Error).message ?? e).slice(0, 300) });
        return send(500, { error: 'Internal error' });
      }
    })();
  });

  // The allowlisting proxy. Anything not CONNECT host:443 to a listed host is
  // refused; plain-HTTP proxying is never offered. A bounded number of tunnels
  // at a time: a confused agent must not be able to hold the box's sockets open.
  const MAX_TUNNELS = Number(process.env.HATCHABOT_OPS_MAX_TUNNELS) || 24;
  let tunnels = 0;
  server.on('connect', (req, client, head) => {
    const sock = client as net.Socket;
    const deny = (code: string) => { sock.end(`HTTP/1.1 ${code}\r\n\r\n`); };
    sock.on('error', () => {});
    const peer = normalizeIp(sock.remoteAddress);
    const allowed = handlers.allowedHosts(proxyToken(req.headers['proxy-authorization']));
    if (!allowed) return deny('407 Proxy Authentication Required');
    const m = /^([A-Za-z0-9.-]+):(\d+)$/.exec(req.url ?? '');
    if (!m || m[2] !== '443' || !allowed.includes(m[1]!.toLowerCase())) {
      log('ops.proxy_refused', { target: String(req.url).slice(0, 120) });
      return deny('403 Forbidden');
    }
    const host = m[1]!;
    if (tunnels >= MAX_TUNNELS) {
      log('ops.proxy_busy', { tunnels });
      return deny('429 Too Many Requests');
    }

    const openTunnel = () => {
      tunnels++;
      let closed = false;
      const done = () => { if (!closed) { closed = true; tunnels--; } };
      const ready = () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up.write(head);
        up.pipe(sock); sock.pipe(up);
      };
      const up = handlers.dial ? handlers.dial(host, 443, ready) : net.connect(443, host, ready);
      up.on('error', () => { deny('502 Bad Gateway'); done(); });
      sock.on('close', () => { up.destroy(); done(); });
      up.on('close', () => { sock.destroy(); done(); });
    };

    // Only a management agent's own doorman may use the door — checked before
    // anything is dialled (docs/ops-agent-design.md).
    if (!handlers.peerOk) return openTunnel();
    void handlers.peerOk(peer)
      .then((ok) => {
        if (!ok) { log('ops.peer_refused', { peer, path: 'connect' }); return deny('403 Forbidden'); }
        openTunnel();
      })
      .catch(() => deny('403 Forbidden'));
  });

  return server;
}

// ---- one per process, started the first time a management agent needs it ----
let started: Promise<{ host: string; port: number }> | undefined;
let handlersRef: OpsHandlers | undefined;
let boundHost = '';

/**
 * Where the door ended up listening. `127.0.0.1` means no Docker address could
 * be bound — Docker Desktop — and a doorman therefore reaches it through the
 * VM's forwarder, which rewrites the source address. See `loopbackDoorman`.
 */
export const opsBoundHost = (): string => boundHost;

/**
 * On Docker Desktop a container's connection to `host.docker.internal` arrives
 * at a loopback listener from the forwarder, never from the container's own
 * address — so "is this peer one of my doormen?" can never be true there, and
 * the management agent is refused both its tools and its AI (a Mac, 2026-09-21).
 *
 * When the door is on loopback, a loopback peer is therefore accepted: nothing
 * outside this machine can reach it at all, and both paths still demand the
 * per-agent key that is the actual authorisation. On Linux the door binds a
 * Docker address, this returns false, and the doorman check is unchanged.
 */
export const loopbackDoorman = (ip: string): boolean =>
  boundHost === '127.0.0.1' && (normalizeIp(ip) === '127.0.0.1' || ip === '::1');
export function setOpsHandlers(h: OpsHandlers): void { handlersRef = h; }
/** The registered handlers (tests drive the door through these). */
export const getOpsHandlers = (): OpsHandlers | undefined => handlersRef;

export const opsPort = (): number => {
  const set = process.env.HATCHABOT_OPS_PORT;
  // 0 means "any free port" — what the tests use, so a running Hatchabot on
  // the same machine never collides with them.
  return set !== undefined && set !== '' && Number.isFinite(Number(set)) ? Number(set) : 8091;
};

/**
 * Why the door could not open, in words the owner can act on. The address is
 * the jail network's gateway: on Linux that is a real address on this machine,
 * but on Docker Desktop (macOS, Windows) it lives inside Docker's VM and
 * cannot be bound here — which is why the management agent needs Linux Docker.
 */
export function opsListenError(err: NodeJS.ErrnoException, host: string, port: number): Error & { userMessage: string } {
  const why = err?.code === 'EADDRNOTAVAIL'
    ? `Hatchabot could not listen on ${host}:${port}, the management agent's private network address. On Docker Desktop (macOS or Windows) that address lives inside Docker's own virtual machine, so the management agent can only run where Docker runs natively (Linux). Your other agents are unaffected.`
    : err?.code === 'EADDRINUSE'
      ? `Something else is already using ${host}:${port}, which the management agent needs. Stop it, or set HATCHABOT_OPS_PORT to a free port and try again.`
      : `Hatchabot could not open the management agent's door on ${host}:${port} (${err?.code ?? 'unknown error'}).`;
  return Object.assign(new Error(`ops listen failed on ${host}:${port}: ${err?.code ?? err?.message}`), { userMessage: why });
}

/**
 * Start (once) on this machine's loopback; management agents reach it through
 * their doorman container (src/ops/doorman.ts). Loopback is deliberate: it
 * works on Docker Desktop, where no Docker address can be bound from the host,
 * and it keeps the door off every other container's reach.
 */
export function ensureOpsServer(candidates: Array<string | undefined> = []): Promise<{ host: string; port: number }> {
  started ??= (async () => {
    if (!handlersRef) throw new Error('ops handlers not registered');
    const port = opsPort();
    // Where a doorman can reach this machine differs by platform: on Linux it
    // is the docker bridge's gateway (an address on the host); on Docker
    // Desktop no Docker address can be bound here, and `host.docker.internal`
    // reaches the host's loopback instead. Take the first that binds.
    const wanted = process.env.HATCHABOT_OPS_BIND
      ? [process.env.HATCHABOT_OPS_BIND]
      : [...candidates.filter((x): x is string => !!x), '127.0.0.1'];
    const server = createOpsServer(handlersRef);
    let host = '';
    let last: Error | undefined;
    for (const candidate of wanted) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: NodeJS.ErrnoException) => reject(opsListenError(err, candidate, port));
          server.once('error', onError);
          server.listen(port, candidate, () => { server.off('error', onError); resolve(); });
        });
        host = candidate;
        break;
      } catch (err) {
        last = err as Error;
      }
    }
    if (!host) throw last ?? new Error('ops server could not bind');
    boundHost = host;
    // With port 0 the kernel picked one: report what it actually bound.
    const bound = server.address();
    const actualPort = typeof bound === 'object' && bound ? bound.port : port;
    server.unref();
    return { host, port: actualPort };
  })().catch((e) => { started = undefined; throw e; });
  return started;
}
