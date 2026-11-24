import { request as httpRequest, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Agent } from '../domain/types.js';
import { consoleIdentity, type ConsoleRole } from '../openclaw/consoleIdentity.js';
import { isBusy } from '../orchestrator/lifecycle/busy.js';
import type { ConsoleAccess, RoomPromise } from '../orchestrator/console/consoleAccess.js';
import type { ConsoleGate } from '../orchestrator/console/consoleGate.js';
import type { ConsoleSocket } from '../orchestrator/console/consoleSockets.js';
import { operationRefusal } from '../orchestrator/lifecycle/operations.js';
import { parsePendingPairing, pendingPairingShell } from '../orchestrator/console/pairing.js';
import {
  forwardedClientAddress, GUEST_CONNECT_TIMEOUT_MS, GUEST_IDLE_TO_CLOSE_MS, GuestActivity, GUEST_ROOM_EVERY_MS, GUEST_VIEW_SCRIPT, GUEST_VIEW_SCRIPT_PATH, guestControlUiConfig, guestHttpPath, MAX_GUEST_CONSOLES,
  spliceGuest, stripClientIdentity, withConsoleIdentity, withGuestView, type GuestSplice,
} from './consoleProxy.js';
import { CONSOLE_WORKER_STUB } from './consoleWorkerStub.js';
import { CONTROL_UI_MATH_PREFIX, readControlUiMathAsset, withControlUiMath } from './controlUiMath.js';
import { isControlUiDocument, rebaseControlUi, TALK_PROXY_SCRIPT, TALK_PROXY_SCRIPT_PATH, withTalkProxy } from './controlUiRebase.js';
import { GuestConsoleLog } from './guestConsoleLog.js';
import { ownerIdOf } from './principal.js';
import { deviceLabel } from './publicAccess.js';
import { foreignRequest } from './requestOrigin.js';
import { escapeHtml, NO_COMPRESS, type RouteContext } from './routeContext.js';
import { readSessionCookie, requestIsHttps, SESSION_COOKIE_NAME, type RequestLike } from './sessionCookie.js';
import { isPublic, publicClientAddress } from './trust.js';

/**
 * A console request or handshake, held to the browser session it came with
 * across its waits (on a runner, on a gateway getting ready). `valid()` is
 * false once that session signed out (the gate's `pendingSession`), the
 * cookie no longer signs in the person it did at entry, or, at the public
 * address, the gate's rules no longer let it in. Bearer and in-process
 * requests keep their own way in.
 *
 * Built once per process in registerRoutes (src/api/routes.ts), beside the
 * console's gate, and on the shared context: the skill-file and voice routes
 * there use `watchConsoleHttp` too.
 */
export function consoleSessionWatch(app: FastifyInstance, gate: Pick<ConsoleGate, 'pendingSession'>): {
  watchConsoleSession: (req: FastifyRequest | IncomingMessage, me: string) => { valid: () => boolean; done: () => void };
  watchConsoleHttp: (req: FastifyRequest, reply: FastifyReply, me: string) => { valid: () => boolean; done: () => void };
} {
  const watchConsoleSession = (req: FastifyRequest | IncomingMessage, me: string) => {
    const https = requestIsHttps(req), cookie = typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined;
    // Bearer/in-process requests retain their existing auth path. Recheck a
    // browser cookie only when it was the authenticated person at entry.
    const browser = app.principalFromCookieHeader?.(cookie, https)?.ownerId === me;
    const pending = gate.pendingSession(readSessionCookie(cookie, https)?.value);
    return {
      valid: () => !pending.revoked() && (!browser || app.principalFromCookieHeader?.(cookie, https)?.ownerId === me) &&
        (!isPublic(req) || (!!app.publicAccess && !app.publicAccess.refuseSession('raw' in req ? req.raw : req, me))),
      done: pending.done,
    };
  };
  const watchConsoleHttp = (req: FastifyRequest, reply: FastifyReply, me: string) => {
    const session = watchConsoleSession(req, me);
    reply.raw.once('finish', session.done);
    reply.raw.once('close', session.done);
    return { ...session, valid: () => !reply.raw.destroyed && session.valid() };
  };
  return { watchConsoleSession, watchConsoleHttp };
}

/** A command's output's last line with something on it. */
const lastLine = (text: string | undefined): string | undefined => (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop();

/**
 * An agent's OpenClaw console (Control UI): the routes (HB-0808; the map's
 * "Web chat and the OpenClaw console").
 *
 *  - The proxy: /v1/agents/:id/ui and /ui/* over HTTP, and the WebSocket
 *    upgrade on the raw server, each forwarded to the agent's gateway with
 *    the person's identity (an owner, or a web-chat guest in their own
 *    conversation, whose messages are filtered both ways).
 *  - /v1/agents/:id/console/access (what this caller's console is),
 *    …/console/pending and …/console/approve (a new browser's pairing).
 *  - The hooks that end what a sign-out or a change of rights ends: after
 *    each request that changed something, the open sockets are judged again.
 *
 * The rules and their state are the console's gate (`ctx.consoles.gateway`,
 * src/orchestrator/console/consoleGate.ts): who may reach which console,
 * where its gateway answers, the handshakes under way and the open sockets,
 * and the 30-second sweep. This file is the HTTP and WebSocket plumbing: it
 * reads the request, asks the gate before and after each wait, and words
 * the answer. Registered where these routes stood in registerRoutes, so the
 * hooks and the upgrade listener keep their place among the others.
 */
export function registerConsoleRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { store, trace, providerFor, ownedAgent, watchConsoleHttp, watchConsoleSession, hostKnownAway } = ctx;
  const {
    gatewayAddr, consoleTarget, consoleAccess, consoleCaller, consoleContext, consoleStillCurrent,
    signedOut, addSocket, revalidateConsoleSockets, closeSocketsFor, socketCount, stop: stopConsoleSweep,
  } = ctx.consoles.gateway;
  // What a web-chat guest's console visits leave in the timeline (guestConsoleLog.ts).
  const guestConsoleLog = new GuestConsoleLog();
  /**
   * Reverse-proxy an agent's OpenClaw Control UI through the control plane.
   *
   * The gateway port is published on the HOST's loopback only — deliberately,
   * since it grants full control of that agent and must not be reachable from
   * the LAN/tailnet. But that also meant the "OpenClaw (debug)" button opened
   * `http://<whatever-host-you-browse>:<port>` and simply hung: correct for
   * someone sitting at the machine, broken for everyone else.
   *
   * Proxying instead keeps the port closed and reuses the session you already
   * have. The gateway's own bearer token still rides in the URL *fragment*,
   * which browsers never send to a server, so it stays client-side exactly as
   * before. Relative asset paths resolve under this prefix, so the UI loads
   * unmodified.
   */
  // Where each gateway answers, who may reach it and what ends a console are
  // the console's gate (orchestrator/console/consoleGate.ts); the sessions
  // watched across a wait are consoleSessionWatch's, above.
  (app as unknown as { consoleAccess?: ConsoleAccess }).consoleAccess = consoleAccess;
  /**
   * The headers one console request carries to the gateway. On an identity
   * gateway: the person's name (and a guest's scope cap), never anything the
   * browser claimed. On a token gateway (not rebuilt yet): as before.
   */
  const consoleHeaders = (
    raw: Record<string, string | string[] | undefined>, agent: Agent, role: ConsoleRole, userId: string,
    identity: boolean, remote: string | undefined,
  ): Record<string, string | string[] | undefined> => {
    const base = stripSessionCookie(raw);
    if (!identity) return stripClientIdentity(base);
    return withConsoleIdentity(base, {
      identity: consoleIdentity(agent.gatewayToken!, role, role === 'owner' ? agent.ownerId : userId),
      guest: role === 'guest',
      clientAddress: forwardedClientAddress(remote),
    });
  };
  const needsRebuildForGuests = (name: string) =>
    `${name} needs a rebuild before its guests can use the full chat. Until then, use the chat here — or ask its owner to rebuild it.`;

  // The agent gateway is the least-trusted component (it runs AI-authored tool
  // and MCP code) and authenticates via its own bearer token carried in the URL
  // fragment — it never needs, and must never receive, the owner's Hatchabot
  // session cookie. Strip only that cookie from proxied headers; keep any
  // gateway-set cookies and the Authorization bearer intact (audit 2026-09-08).
  const stripSessionCookie = (headers: Record<string, string | string[] | undefined>) => {
    const h = { ...headers };
    if (typeof h.cookie === 'string') {
      const kept = h.cookie.split(';').map((s) => s.trim()).filter((c) => c && !SESSION_COOKIE_NAME.test(c.split('=')[0]!.trim()));
      if (kept.length) h.cookie = kept.join('; ');
      else delete h.cookie;
    }
    // Our long-lived bearer tokens are for /v1/*, never for the gateway.
    if (typeof h.authorization === 'string' && /^Bearer (hatchabot|agentclaw)_/.test(h.authorization)) delete h.authorization;
    // The browser → Hatchabot hop's proxy headers (an HTTPS front such as
    // Tailscale Serve adds X-Forwarded-For/-Proto) describe THAT hop, not
    // this one. OpenClaw 2026.9 refuses gateway-authenticated routes that
    // carry forwarded claims from an address it does not trust
    // ("proxy_attribution_required" — one agent, 2026-09-24), and
    // 2026.7 already warned about them. They never belonged to the gateway.
    for (const k of Object.keys(h)) {
      const l = k.toLowerCase();
      // Tailscale Serve/Funnel adds Tailscale-User-Login and friends; 2026.9's
      // gateway counts "Tailscale-owned" headers as proxy-shaped too
      // (resolveGatewayIngressAttribution: forwarded OR Tailscale headers
      // from an untrusted address → refused). Seen on one agent, 2026-09-24.
      if (l.startsWith('x-forwarded-') || l.startsWith('tailscale-') || l === 'forwarded' || l === 'x-real-ip' || l === 'via' || l === 'x-client-ip' || l === 'true-client-ip' || l === 'cf-connecting-ip') delete h[k];
    }
    return h;
  };

  /**
   * OpenClaw asks each new browser to be approved once before it may use the
   * console — "run `openclaw devices approve <id>` on the Gateway host". The
   * gateway host is the agent's CONTAINER, which the owner can't reach from a
   * laptop, so the instruction dead-ended.
   *
   * Approving on the owner's behalf is safe for one reason: a pending request
   * can only come from a browser that reached the gateway through this proxy,
   * which requires the owner's session. The gateway itself is bound to the
   * host's loopback, and loopback clients never need pairing. So: explicit
   * click, owner only, and only requests from the last few minutes — the one
   * this person just caused, not anything that has been sitting there.
   */
  const CONSOLE_PAIRING_WINDOW_MS = 10 * 60_000;
  /**
   * The recent pairing requests, or undefined when neither the store nor the
   * CLI could be read: that is not "nothing waiting", which the page takes
   * just after an approval for "another approval took it" (HB-1134 review).
   */
  const pendingConsoleRequests = async (agent: Agent): Promise<Array<{ requestId: string; ts: number }> | undefined> => {
    if (!agent.runtimeRef) return [];
    const provider = providerFor(agent.hostId);
    // Fast path: read OpenClaw's pending store directly (~50 ms) — the JSON
    // file on 2026.7, the state database on 2026.9 (pairing.ts). The CLI
    // takes over two seconds to start, and the panel polls this while
    // someone stares at a pairing screen. Anything the shell could not read
    // or does not recognise falls back to the CLI: a missing store is not
    // "nothing pending".
    try {
      const raw = await provider.execShell(agent.runtimeRef, pendingPairingShell());
      const rows = raw.code === 0 ? parsePendingPairing(raw.stdout) : undefined;
      if (rows) {
        const since = Date.now() - CONSOLE_PAIRING_WINDOW_MS;
        return rows.filter((r) => r.ts >= since && /^[A-Za-z0-9-]{8,64}$/.test(r.requestId));
      }
    } catch { /* fall through to the CLI */ }
    const res = await provider.exec(agent.runtimeRef, ['devices', 'list', '--json'], { timeoutMs: 20_000 });
    if (res.code !== 0) return undefined;
    try {
      const j = JSON.parse(res.stdout) as { pending?: Array<{ requestId?: string; ts?: number }> };
      const since = Date.now() - CONSOLE_PAIRING_WINDOW_MS;
      return (j.pending ?? [])
        .filter((r): r is { requestId: string; ts: number } => typeof r.requestId === 'string' && typeof r.ts === 'number')
        .filter((r) => r.ts >= since && /^[A-Za-z0-9-]{8,64}$/.test(r.requestId));
    } catch {
      return undefined;
    }
  };
  /** Said when the pending requests could not be read (the console page shows the button with it). */
  const PENDING_UNREAD = 'Could not read which browsers are waiting for approval: OpenClaw did not answer. Try again in a moment; if it keeps failing, rebuild the agent.';

  app.get<{ Params: { id: string } }>('/v1/agents/:id/console/pending', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent || agent.state !== 'RUNNING') return reply.code(404).send({ error: 'Not found' });
    const session = watchConsoleHttp(req, reply, agent.ownerId), context = consoleContext(agent);
    const pending = await pendingConsoleRequests(agent);
    if (!session.valid() || !consoleStillCurrent(agent.ownerId, { agent, role: 'owner' }, context)) return reply.code(404).send({ error: 'Not found' });
    if (!pending) return reply.code(502).send({ error: PENDING_UNREAD });
    return { pending: pending.length };
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/console/approve', async (req, reply) => {
    const agent = ownedAgent(req, req.params.id);
    if (!agent?.runtimeRef || agent.state !== 'RUNNING') return reply.code(404).send({ error: 'Not found' });
    const session = watchConsoleHttp(req, reply, agent.ownerId), context = consoleContext(agent);
    const current = () => session.valid() && consoleStillCurrent(agent.ownerId, { agent, role: 'owner' }, context);
    if (isBusy(agent.id) || operationRefusal(store, agent.id)) return reply.code(409).send({ error: 'The agent is busy. Try again when its operation finishes.' });
    const pending = await pendingConsoleRequests(agent);
    if (!current()) return reply.code(404).send({ error: 'Not found' });
    if (!pending) return reply.code(502).send({ error: PENDING_UNREAD });
    if (!pending.length) {
      return reply.code(409).send({ error: 'Nothing is waiting for approval. Open the console first — it asks once per browser.' });
    }
    let approved = 0;
    /** OpenClaw's last line from an approval that failed, for the timeline (its words are the container's, not the answer's). */
    let failure: string | undefined;
    for (const r of pending) {
      if (!current()) return reply.code(404).send({ error: 'Not found' });
      if (isBusy(agent.id) || operationRefusal(store, agent.id)) return reply.code(409).send({ error: 'The agent is busy. Try again when its operation finishes.' });
      const res = await providerFor(agent.hostId).exec(agent.runtimeRef, ['devices', 'approve', r.requestId], { timeoutMs: 20_000 });
      if (res.code === 0) approved++;
      // Its error's last line, from stderr first: stdout's progress lines came after, and hid it (HB-1134 review).
      else failure = (lastLine(res.stderr) ?? lastLine(res.stdout))?.slice(0, 200) ?? `exit ${res.code}`;
    }
    if (!current()) return reply.code(404).send({ error: 'Not found' });
    const failed = pending.length - approved;
    trace(agent.id)('console.device_approved', { approved, requested: pending.length, ...(failed ? { failed, error: failure } : {}) });
    // A request was found and none of it was approved: a failure, said as one,
    // never 200 with nothing approved, which the page took for "approved" and
    // stopped watching on OpenClaw's pairing screen (HB-1134).
    if (!approved) return reply.code(502).send({ error: 'OpenClaw did not approve this browser. Try again in a moment; if it keeps failing, rebuild the agent (its timeline has what OpenClaw said).' });
    return { approved, ...(failed ? { failed } : {}) };
  });

  app.all<{ Params: { id: string; '*': string } }>('/v1/agents/:id/ui', NO_COMPRESS, async (req, reply) => {
    // The UI is a SPA served from a directory; without the trailing slash its
    // relative asset paths would resolve one level too high.
    return reply.redirect(`/v1/agents/${req.params.id}/ui/`);
  });

  /**
   * What this caller's console is, before they open it: the owner learns
   * whether the token still rides in the address (a gateway not rebuilt yet);
   * a guest learns whether the full chat is there for them, and which
   * conversation is theirs — or that the agent needs a rebuild first.
   */
  app.get<{ Params: { id: string } }>('/v1/agents/:id/console/access', async (req, reply) => {
    const me = ownerIdOf(req);
    const caller = consoleCaller(me, req.params.id);
    if (!caller) return reply.code(404).send({ error: 'Not found' });
    const { agent, role } = caller;
    const session = watchConsoleHttp(req, reply, me);
    if (agent.state !== 'RUNNING' && !(agent.hibernatedAt && agent.state === 'STOPPED')) {
      return { role, console: 'unavailable', reason: 'It is not running right now.' };
    }
    // A sleeping agent: what it runs is known once it is awake; the owner's
    // console wakes it, a guest is offered the chat here meanwhile.
    if (agent.state !== 'RUNNING') return { role, console: role === 'owner' ? 'token' : 'unavailable', reason: 'It is asleep.' };
    const context = consoleContext(agent);
    const ready = await consoleAccess.ensureReady(agent);
    if (!session.valid() || !consoleStillCurrent(me, caller, context)) return reply.code(404).send({ error: 'Not found' });
    if (role === 'owner') return { role, console: ready.mode === 'unavailable' ? (ready.identity ? 'identity' : 'token') : ready.mode, ...(ready.mode === 'unavailable' ? { reason: ready.reason } : {}) };
    if (ready.mode !== 'identity') {
      return { role, console: ready.mode === 'token' ? 'needs-rebuild' : 'unavailable', reason: ready.mode === 'token' ? needsRebuildForGuests(agent.name) : ready.reason };
    }
    return { role, console: 'identity', session: consoleAccess.guestSessionKey(agent, me) };
  });

  // A guest's page loads this ahead of the app (consoleProxy.ts GUEST_VIEW_SCRIPT):
  // Hatchabot's own file, never the gateway's. Static, so anyone who may open the console may load it.
  app.get<{ Params: { id: string } }>(`/v1/agents/:id/ui${GUEST_VIEW_SCRIPT_PATH}`, async (req, reply) => {
    if (!consoleCaller(ownerIdOf(req), req.params.id)) return reply.code(404).send({ error: 'Not found' });
    return reply.header('content-type', 'text/javascript; charset=utf-8').header('cache-control', 'no-cache').send(GUEST_VIEW_SCRIPT);
  });

  /** The console of an agent whose machine (a runner) isn't answering: a plain page, not JSON in the frame. */
  const machineAway = (reply: FastifyReply, agent: Agent) => {
    const host = store.getHost(agent.hostId)?.name ?? 'its machine';
    const text = `${agent.name} runs on ${host}, which isn't answering — it may be asleep or offline. Its chat opens again once that machine is back.`;
    return reply.code(503).header('cache-control', 'no-store').type('text/html; charset=utf-8')
      .send(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(agent.name)}</title><body style="font:15px system-ui,sans-serif;padding:32px;color:#555;max-width:520px">${escapeHtml(text)}</body>`);
  };
  app.all<{ Params: { id: string; '*': string } }>('/v1/agents/:id/ui/*', NO_COMPRESS, async (req, reply) => {
    const me = ownerIdOf(req);
    const caller = consoleCaller(me, req.params.id);
    if (!caller) return reply.code(404).send({ error: 'No debug gateway for this agent.' });
    const session = watchConsoleHttp(req, reply, me);
    // Local renderer assets follow this console's access checks. Even unknown
    // paths in this namespace stop here; no package path reaches the gateway.
    const localPath = `/${req.params['*']}`;
    if (localPath.startsWith(CONTROL_UI_MATH_PREFIX)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return reply.code(404).send({ error: 'Not found' });
      const asset = readControlUiMathAsset(localPath);
      if (!asset) return reply.code(404).send({ error: 'Not found' });
      return reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
        .header('content-length', String(asset.body.length)).type(asset.contentType).send(req.method === 'HEAD' ? undefined : asset.body);
    }
    // An owner console's small compatibility shim keeps OpenAI's brokered
    // Talk offer under this agent's proxy. Never forwarded to the gateway.
    if (`/${req.params['*']}` === TALK_PROXY_SCRIPT_PATH) {
      if (caller.role !== 'owner' || (req.method !== 'GET' && req.method !== 'HEAD')) return reply.code(404).send({ error: 'Not found' });
      return reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8').send(TALK_PROXY_SCRIPT);
    }
    // The console's service worker is not OpenClaw's: every agent's console
    // registered one under its own path on this one site and cached its own
    // copy of the console (55 MB a build, three builds kept), and fifty agents
    // filled the browser's storage for the site — every console then warned
    // "Could not store the previous draft in browser storage" on each keystroke.
    // The stand-in (consoleWorkerStub.ts) clears those caches and unregisters
    // itself. Answered here, whatever the agent's machine is doing.
    if ((req.method === 'GET' || req.method === 'HEAD') && req.params['*'] === 'sw.js') {
      return reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8').send(CONSOLE_WORKER_STUB);
    }
    // A machine already known not to answer: say so in words, without waiting on it.
    if (hostKnownAway(caller.agent.hostId)) return machineAway(reply, caller.agent);
    const hostContext = JSON.stringify(store.getHost(caller.agent.hostId));
    const target = await consoleTarget(caller.agent).catch(() => undefined);
    const fresh = consoleCaller(me, caller.agent.id);
    if (!session.valid() || !fresh || fresh.role !== caller.role || fresh.agent.ownerId !== caller.agent.ownerId) return reply.code(404).send({ error: 'Not found' });
    const targetCaller = target && { agent: target.agent, role: caller.role };
    const context = target && consoleContext(target.agent);
    const current = () => session.valid() && !!targetCaller && !!context && targetCaller.agent.ownerId === caller.agent.ownerId &&
      hostContext === JSON.stringify(store.getHost(caller.agent.hostId)) && consoleStillCurrent(me, targetCaller, context);
    if (target && !current()) return reply.code(404).send({ error: 'Not found' });
    if (!target) {
      if (store.getHost(caller.agent.hostId)?.kind !== 'local') return machineAway(reply, caller.agent);
      return reply.code(404).send({ error: 'No debug gateway for this agent.' });
    }
    let path = `/${req.params['*'] ?? ''}`;
    const ready = await consoleAccess.ensureReady(target.agent);
    if (!current()) return reply.code(404).send({ error: 'Not found' });
    const identity = ready.mode === 'identity' || (ready.mode === 'unavailable' && !!ready.identity);
    if (caller.role === 'guest') {
      // A guest only ever reaches an identity gateway, and only its chat's paths.
      if (ready.mode !== 'identity') return reply.code(409).send({ code: 'needs-rebuild', error: ready.mode === 'token' ? needsRebuildForGuests(target.agent.name) : ready.reason });
      const judged = guestHttpPath(req.method, path);
      if (judged === undefined) {
        app.log.info({ agent: target.agent.id, userId: me, http: `${req.method} ${JSON.stringify(path.slice(0, 80))}` }, 'console.guest_refused');
        return reply.code(403).send({ error: 'That part of the console is for its owner.' });
      }
      // What the gateway gets is exactly what was judged.
      path = judged;
    }
    const qs = req.raw.url?.includes('?') ? req.raw.url.slice(req.raw.url.indexOf('?')) : '';
    // The app's document (a route, not a file) is rewritten onto this prefix
    // below — so it is asked for uncompressed. Assets pass through as they
    // come, gzip/brotli included.
    const isDocument = isControlUiDocument(path);
    // A guest's copy of the UI's boot settings is rewritten too (guestControlUiConfig).
    const guestConfig = caller.role === 'guest' && req.method === 'GET' && path === '/control-ui-config.json';
    const forwarded: Record<string, string | string[] | undefined> = {
      ...consoleHeaders(req.headers, target.agent, caller.role, me, identity, req.socket.remoteAddress),
      host: `127.0.0.1:${target.addr.port}`, connection: 'close',
    };
    if (isDocument || guestConfig) delete forwarded['accept-encoding'];
    // Rewritten pages have Hatchabot's scripts and prefix. A gateway 304
    // could otherwise keep a cached page from before these changes.
    if (isDocument || guestConfig) { delete forwarded['if-none-match']; delete forwarded['if-modified-since']; }
    // The body as it will be sent, and a content-length that matches it: a
    // parsed JSON body re-serialised can be shorter than the client's declared
    // length, and the gateway then waits for bytes that never come (30th audit).
    const outBody: Buffer | undefined = req.body === undefined || req.body === null ? undefined
      : Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    delete forwarded['content-length'];
    if (outBody) forwarded['content-length'] = String(outBody.length);
    const upstream = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>(
      (resolve, reject) => {
        const r = httpRequest(
          {
            host: target.addr.host,
            port: target.addr.port,
            path: path + qs,
            method: req.method,
            // Drop hop-by-hop and our own host header; keep auth/content ones.
            // The owner's session cookie is stripped — the gateway must not see it.
            headers: forwarded,
            // A gateway that accepts and never answers must not park the request for ever.
            timeout: Number(process.env.HATCHABOT_CONSOLE_TIMEOUT_MS) || 60_000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('the gateway closed its response')));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }),
            );
          },
        );
        const cancel = () => r.destroy(new Error('the console request was cancelled'));
        reply.raw.once('close', cancel);
        r.once('close', () => reply.raw.off('close', cancel));
        r.on('error', reject);
        r.on('timeout', () => r.destroy(new Error('the gateway did not answer in time')));
        if (outBody) r.end(outBody); else r.end();
      },
    ).catch(() => undefined as never);
    if (!current()) return reply.code(404).send({ error: 'Not found' });
    if (!upstream) return reply.code(502).send({ error: "The agent's gateway did not answer." });
    const rewritten = isDocument || guestConfig;
    for (const [k, v] of Object.entries(upstream.headers)) {
      // set-cookie: the gateway is the least-trusted component; it must not plant cookies on our origin.
      // CORS: OpenClaw has handlers that echo any Origin back as allowed; relayed,
      // that would let a page on another site (a neighbouring tenant's) read the
      // console's answers with this browser's cookie. Hatchabot allows no other origin.
      if (v === undefined || /^(transfer-encoding|connection|content-length|set-cookie|access-control-[a-z-]+|timing-allow-origin)$/i.test(k)) continue;
      if (rewritten && /^(etag|last-modified)$/i.test(k)) continue;
      // OpenClaw forbids framing outright (X-Frame-Options: DENY and
      // frame-ancestors 'none'), which forced the console into a separate tab.
      // Served through us it is same-origin, so permit framing by THIS app and
      // no one else: clickjacking protection against other sites is unchanged.
      if (/^x-frame-options$/i.test(k)) { reply.header(k, 'SAMEORIGIN'); continue; }
      if (/^content-security-policy$/i.test(k)) {
        const csp = (Array.isArray(v) ? v.join('; ') : v).replace(/frame-ancestors\s+[^;]*/i, "frame-ancestors 'self'");
        reply.header(k, csp);
        continue;
      }
      reply.header(k, v);
    }
    // OpenClaw 2026.9 writes root-absolute asset links and an empty base
    // path into its page; served from under our prefix, those point at
    // Hatchabot's root and the app never starts. Move the page onto the
    // prefix (see controlUiRebase.ts). Only an uncompressed HTML document.
    let body = upstream.body;
    const ctype = String(upstream.headers['content-type'] ?? '');
    if (isDocument && /text\/html/i.test(ctype) && !upstream.headers['content-encoding']) {
      const prefix = `/v1/agents/${req.params.id}/ui`;
      const page = withControlUiMath(rebaseControlUi(body.toString('utf8'), prefix), prefix);
      // A guest's sidebar starts with only what a guest can open (consoleProxy.ts GUEST_VIEW_SCRIPT).
      body = Buffer.from(caller.role === 'guest' ? withGuestView(page, prefix) : withTalkProxy(page, prefix), 'utf8');
    }
    if (guestConfig && upstream.status === 200 && !upstream.headers['content-encoding']) {
      const cfg = guestControlUiConfig(body.toString('utf8'));
      if (cfg !== undefined) body = Buffer.from(cfg, 'utf8');
    }
    return reply.code(upstream.status).send(body);
  });

  // The Control UI opens a WebSocket for live updates; without it the page
  // loads but never comes alive ("Could not connect"). Fastify never sees an
  // upgrade, so hook the raw server and splice the sockets together.
  //
  // Authorization goes through auth.ts's own resolver rather than a re-implementation:
  // deriving the principal here by hand would duplicate session logic across
  // password and identity modes, and anything that silently fell back to
  // LOCAL_OWNER would forward an UNAUTHENTICATED upgrade on a password-mode
  // install. No resolver (or no session) means the socket is destroyed.
  //
  // A guest's socket is not spliced blind: every message is read
  // (consoleProxy.ts spliceGuest) and a removal closes it (consoleAccess).
  /**
   * Every console socket that is open, re-judged by the rules that let it in
   * (the gate's revalidateConsoleSockets): the session, at the public address
   * the pass, its idle limit and the second factor, and the caller's standing
   * on that agent. secondFactor.ts and publicAccess.ts reach it here.
   */
  app.decorate('consoleSockets', {
    revalidate: revalidateConsoleSockets,
    closeFor: (ownerId: string, opts: { publicOnly?: boolean } = {}) => closeSocketsFor(ownerId, opts),
    size: () => socketCount(),
  });
  // After any request that changed something (a sign-out, a password, an
  // account, a member's access, a factor): what it ended, it ends for open
  // sockets too. Reads change nothing and are not worth a sweep. At onSend,
  // which comes with every answer: onResponse never comes for a caller that
  // hung up (HB-1405, as the request holds in routes.ts, HB-0630), and a
  // sign-out whose tab closed left its sockets open until the sweep. What it
  // throws never turns the request's own answer into an error.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || reply.statusCode >= 400) return payload;
    try {
      if (req.routeOptions.url === '/v1/logout') {
        const ended = readSessionCookie(req.headers.cookie, requestIsHttps(req))?.value;
        if (ended) signedOut(ended);
      }
      revalidateConsoleSockets();
    } catch (err) { app.log.warn({ err }, 'console.revalidate_failed'); }
    return payload;
  });
  // …and for what no request announces (the public idle limit, a session that
  // ran out, a change made by another process): the gate's 30-second sweep,
  // which ends with the app as before.
  app.addHook('onClose', async () => { stopConsoleSweep(); });

  app.server.on('upgrade', async (rawReq, socket, head) => {
    const url = rawReq.url ?? '';
    const m = /^\/v1\/agents\/([^/]+)\/ui\/?([^?]*)/.exec(url);
    // Not a console: nobody else answers upgrades here, and one left alone
    // stayed open until the client gave up (HB-0056). The public listener does the same.
    if (!m) { if (app.server.listenerCount('upgrade') <= 1) socket.destroy(); return; }
    const deny = () => socket.destroy();
    // A page on another site — a neighbouring tenant's is the SAME site, so
    // SameSite does not stop it — must not open a console with this
    // browser's cookie (requestOrigin.ts).
    const foreign = foreignRequest(rawReq as RequestLike);
    if (foreign) {
      app.log.warn({ path: url.split('?')[0], why: foreign }, 'console.foreign_upgrade_refused');
      return deny();
    }
    const resolve = app.principalFromCookieHeader;
    if (!resolve) return deny();
    const principal = resolve(rawReq.headers.cookie, requestIsHttps(rawReq as RequestLike));
    if (!principal) return deny();
    // On the public listener the gate's rules apply to the socket too: the
    // public pass, its idle limit, the second factor (publicAccess.ts).
    if (isPublic(rawReq)) {
      const refused = app.publicAccess ? app.publicAccess.refuseSession(rawReq, principal.ownerId) : 'no public gate';
      if (refused) {
        app.log.warn({ path: url.split('?')[0], why: refused }, 'console.public_upgrade_refused');
        return deny();
      }
    }

    // Same rule as the page itself, against the real caller: the owner, or a
    // guest the owner gave web chat.
    const caller = consoleCaller(principal.ownerId, m[1]!);
    if (!caller || caller.agent.state !== 'RUNNING') return deny();
    const session = watchConsoleSession(rawReq, principal.ownerId);
    socket.once('close', session.done);
    const context = consoleContext(caller.agent);
    const current = () => !socket.destroyed && session.valid() && consoleStillCurrent(principal.ownerId, caller, context) &&
      resolve(rawReq.headers.cookie, requestIsHttps(rawReq as RequestLike))?.ownerId === principal.ownerId &&
      (!isPublic(rawReq) || (!!app.publicAccess && !app.publicAccess.refuseSession(rawReq, principal.ownerId)));
    socket.on('error', () => {}); // the awaits below must not leave an unhandled error
    const addr = await gatewayAddr(caller.agent).catch(() => undefined);
    if (!addr || !current()) return deny();
    const ready = await consoleAccess.ensureReady(caller.agent).catch(() => ({ mode: 'unavailable' as const, reason: 'error', identity: false }));
    if (!current()) return deny();
    const identity = ready.mode === 'identity' || (ready.mode === 'unavailable' && !!ready.identity);
    const guest = caller.role === 'guest';
    if (guest && ready.mode !== 'identity') return deny();
    // A guest's socket is the app's own, at the root — not a worker, node or plugin door.
    if (guest && (m[2] ?? '') !== '') return deny();
    if (socket.destroyed) return;
    // A guest's consoles are counted from here (not once the gateway answers),
    // connecting and connected together, so ones opened at the same moment
    // are counted too; each may hold up to its queue limit, so how many is
    // bounded (MAX_GUEST_CONSOLES). Past it, room is promised here, so the
    // next one sees it taken: their least recently active connected one,
    // unused for GUEST_IDLE_TO_CLOSE_MS and not being answered (promiseRoom:
    // one unused for under GUEST_ROOM_EVERY_MS at most once in that long), so
    // a browser gone without a word (a phone that slept) never locks them
    // out. It is closed once the new one has connected; if that fails,
    // nothing is. With none to promise it is refused at the door, so tabs in
    // use cannot close each other in turn. At most MAX_GUEST_CONSOLES of
    // theirs may be connecting at once; until the gateway answers, the slot
    // is held by the request: closing the guest's socket aborts it, and so
    // does GUEST_CONNECT_TIMEOUT_MS.
    let guestUp: Duplex | undefined;
    let upReq: ReturnType<typeof httpRequest> | undefined;
    let forgetGuest: (() => void) | undefined;
    let connecting: NodeJS.Timeout | undefined;
    let usedAt = 0; // when the guest last used it (performance.now(): a wall clock set forward makes nothing idle)
    let spliced: GuestSplice | undefined;
    let room: RoomPromise | undefined;
    if (guest) {
      if (consoleAccess.openGuests(undefined, principal.ownerId, 'connecting') >= MAX_GUEST_CONSOLES) {
        app.log.warn({ agent: caller.agent.id, userId: principal.ownerId }, 'console.guest_too_many_connecting');
        return deny();
      }
      if (consoleAccess.openGuests(undefined, principal.ownerId) >= MAX_GUEST_CONSOLES) {
        room = consoleAccess.promiseRoom(principal.ownerId, { idleFor: GUEST_IDLE_TO_CLOSE_MS, every: GUEST_ROOM_EVERY_MS });
        if (!room) {
          app.log.warn({ agent: caller.agent.id, userId: principal.ownerId, why: `you have ${MAX_GUEST_CONSOLES} chats open; close one` }, 'console.guest_too_many');
          return deny();
        }
      }
      // Not connected (it failed, timed out, or the guest left): the room promised goes back.
      const drop = () => { clearTimeout(connecting); room?.release(); room = undefined; socket.destroy(); upReq?.destroy(); guestUp?.destroy(); };
      usedAt = performance.now();
      forgetGuest = consoleAccess.trackGuest(caller.agent.id, principal.ownerId, drop, {
        connecting: () => !spliced,
        // Being answered (a reply streaming) is not idle.
        lastActive: () => spliced?.answering() ? performance.now() : usedAt,
        evict: () => { if (spliced) spliced.close(1001, 'opened in another tab'); else drop(); },
      });
      socket.on('close', () => { forgetGuest!(); drop(); });
      connecting = setTimeout(() => {
        app.log.warn({ agent: caller.agent.id, userId: principal.ownerId }, 'console.guest_connect_timeout');
        drop();
      }, GUEST_CONNECT_TIMEOUT_MS);
      connecting.unref?.();
    }

    const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    const up = httpRequest({
      host: addr.host,
      port: addr.port,
      path: `/${m[2] ?? ''}${qs}`,
      method: 'GET',
      headers: { ...consoleHeaders(rawReq.headers, caller.agent, caller.role, principal.ownerId, identity, rawReq.socket.remoteAddress), host: `127.0.0.1:${addr.port}` },
    });
    upReq = up;
    up.on('upgrade', (upRes, upSocket, upHead) => {
      if (!current()) { upSocket.destroy(); socket.destroy(); forgetGuest?.(); return; }
      session.done(); // from here the established socket's cookie is tracked below
      if (guest) {
        clearTimeout(connecting);
        // The guest left while the gateway was answering: nothing to splice.
        if (socket.destroyed) { upSocket.destroy(); forgetGuest!(); return; }
      }
      socket.write(
        [
          `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`,
          ...Object.entries(upRes.headers).flatMap(([k, v]) =>
            Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v !== undefined ? [`${k}: ${v}`] : [],
          ),
          '',
          '',
        ].join('\r\n'),
      );
      if (upHead?.length) upSocket.unshift(upHead);
      // Remembered while it is open, so it can be closed when what let it in ends.
      const entry: ConsoleSocket = {
        ownerId: principal.ownerId, agentId: caller.agent.id, role: caller.role,
        cookie: rawReq.headers.cookie, https: requestIsHttps(rawReq as RequestLike), public: isPublic(rawReq),
        lastActive: Date.now(), close: () => { socket.destroy(); upSocket.destroy(); },
        stillCurrent: () => consoleStillCurrent(principal.ownerId, caller, context),
      };
      const forgetSocket = addSocket(entry);
      socket.on('close', forgetSocket);
      // A guest's browser may still be taking what waits for it after the
      // gateway has closed (spliceGuest drains it, at most GUEST_DRAIN_MS):
      // it stays counted, and closable, until its own socket ends.
      if (!guest) upSocket.on('close', forgetSocket);
      // What an upload's pieces marked is put back if it does not count once
      // whole (onUploadRefused), but not what else they did meanwhile (GuestActivity).
      const activity = new GuestActivity(usedAt, entry.lastActive);
      const markActive = (what?: 'upload' | 'waiting') => {
        activity.mark(what);
        ({ usedAt, wallAt: entry.lastActive } = activity);
      };
      if (guest) {
        // Whatever the browser sent after its upgrade request goes through the
        // filter too: put back before any 'data' listener, which would get it
        // alone (unshift emits at once to a flowing socket) and lose it.
        if (head?.length) socket.unshift(head);
        guestUp = upSocket;
        const refusedOnce = new Set<string>();
        spliced = spliceGuest(socket, upSocket, {
          identity: consoleIdentity(caller.agent.gatewayToken!, 'guest', principal.ownerId),
          scope: { agentId: caller.agent.slug, sessionKey: consoleAccess.guestSessionKey(caller.agent, principal.ownerId) },
          // The person's own messages, read or waiting: what the idle limit goes by for a guest (HB-0593).
          onActive: markActive,
          onUploadRefused: () => {
            activity.putBack();
            ({ usedAt, wallAt: entry.lastActive } = activity);
          },
          // Once per method per connection: the app polls some of them. The
          // timeline gets only what guestConsoleLog lets through (the app's
          // startup calls never, others once a day); the service log gets each.
          onRefused: (method) => {
            const name = String(method ?? '').slice(0, 60);
            // Bounded too: past this many names, a connection's refusals are only answered.
            if (refusedOnce.has(name) || refusedOnce.size >= 100) return;
            refusedOnce.add(name);
            const recorded = guestConsoleLog.refusal(caller.agent.id, principal.ownerId, name);
            if (recorded) trace(caller.agent.id)('console.guest_refused', { userId: principal.ownerId, method: recorded });
            else app.log.info({ agent: caller.agent.id, userId: principal.ownerId, method: name }, 'console.guest_refused');
          },
          // Not passed on (not a JSON object, or Hatchabot's own failure to scrub it): logged.
          onScrubError: (e) => app.log.error({ err: e, agent: caller.agent.id, userId: principal.ownerId }, 'console.guest_scrub_failed'),
          // Across the guest's consoles (GUEST_HELD_LIMIT).
          countHeld: (change) => consoleAccess.addGuestHeld(principal.ownerId, change),
        });
        // Connected: the console promised as its room is closed now. Used
        // again meanwhile (rare), it stays, and this one gives way.
        const promised = room;
        room = undefined;
        const kept = promised?.keep();
        if (kept?.closed) app.log.warn({ agent: kept.closed, userId: principal.ownerId }, 'console.guest_oldest_closed');
        if (kept?.refused) {
          const why = `you have ${MAX_GUEST_CONSOLES} chats open; close one`;
          app.log.warn({ agent: caller.agent.id, userId: principal.ownerId, why }, 'console.guest_too_many');
          forgetGuest!();
          spliced.close(1008, `refused: ${why}`);
          return;
        }
        // Where the visit came from, so an owner who sees one they don't
        // recognise can tell which device it is (2026-10-10): the browser,
        // the address Tailscale Serve or Funnel forwarded, and the tailnet
        // user Serve names. None of it is a credential.
        const tsUser = String(rawReq.headers['tailscale-user-login'] ?? '').slice(0, 120);
        const visit = { userId: principal.ownerId, device: deviceLabel(rawReq.headers['user-agent']), from: publicClientAddress(rawReq), ...(tsUser ? { tailnetUser: tsUser } : {}) };
        if (guestConsoleLog.opened(caller.agent.id, principal.ownerId)) trace(caller.agent.id)('console.guest_opened', visit);
        else app.log.info({ agent: caller.agent.id, ...visit }, 'console.guest_opened');
        // The owner's view names guests' sessions after them (best-effort).
        void consoleAccess.nameGuests(caller.agent, true).catch(() => {});
        return;
      }
      socket.on('data', () => markActive());
      if (identity) void consoleAccess.nameGuests(caller.agent).catch(() => {});
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
      upSocket.pipe(socket).pipe(upSocket);
    });
    // The gateway answered without upgrading (it refused): say so, then close.
    up.on('response', (res) => {
      try { socket.write(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
      res.resume();
      socket.destroy();
    });
    up.on('error', deny);
    // An owner's early bytes went with the request as before; a guest's went through the filter above.
    up.end(!guest && head?.length ? head : undefined);
  });
}
