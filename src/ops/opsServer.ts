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
  log?(event: string, detail: Record<string, unknown>): void;
}

export class OpsAuthError extends Error {}

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
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > 1_000_000) req.destroy(); else chunks.push(c); });
    req.on('end', async () => {
      let msg: unknown;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'Bad JSON' }); }
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
    });
  });

  // The allowlisting proxy. Anything not CONNECT host:443 to a listed host is
  // refused; plain-HTTP proxying is never offered.
  server.on('connect', (req, client, head) => {
    const deny = (code: string) => { client.end(`HTTP/1.1 ${code}\r\n\r\n`); };
    client.on('error', () => {});
    const allowed = handlers.allowedHosts(proxyToken(req.headers['proxy-authorization']));
    if (!allowed) return deny('407 Proxy Authentication Required');
    const m = /^([A-Za-z0-9.-]+):(\d+)$/.exec(req.url ?? '');
    if (!m || m[2] !== '443' || !allowed.includes(m[1]!.toLowerCase())) {
      log('ops.proxy_refused', { target: String(req.url).slice(0, 120) });
      return deny('403 Forbidden');
    }
    const up = net.connect(443, m[1]!, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client); client.pipe(up);
    });
    up.on('error', () => deny('502 Bad Gateway'));
    client.on('close', () => up.destroy());
    up.on('close', () => client.destroy());
  });
  return server;
}

// ---- one per process, started the first time a management agent needs it ----
let started: Promise<{ host: string; port: number }> | undefined;
let handlersRef: OpsHandlers | undefined;
export function setOpsHandlers(h: OpsHandlers): void { handlersRef = h; }
/** The registered handlers (tests drive the door through these). */
export const getOpsHandlers = (): OpsHandlers | undefined => handlersRef;

export const opsPort = (): number => Number(process.env.HATCHABOT_OPS_PORT) || 8091;

/** Start (once) on the isolated network's gateway address; returns where the
 *  agent reaches it. `gateway` comes from the provider. */
export function ensureOpsServer(gateway: () => Promise<string>): Promise<{ host: string; port: number }> {
  started ??= (async () => {
    if (!handlersRef) throw new Error('ops handlers not registered');
    const host = await gateway();
    const port = opsPort();
    const server = createOpsServer(handlersRef);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve());
    });
    server.unref();
    return { host, port };
  })().catch((e) => { started = undefined; throw e; });
  return started;
}
