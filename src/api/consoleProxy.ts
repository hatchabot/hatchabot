import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { CONSOLE_SCOPES_HEADER, CONSOLE_USER_HEADER, GUEST_SCOPES } from '../openclaw/consoleIdentity.js';

/**
 * The console proxy's half of the console with identities
 * (openclaw/consoleIdentity.ts): which headers reach the agent's gateway, and
 * what a web-chat GUEST may do through it.
 *
 * OpenClaw's own guest role already hides other people's sessions (proven on
 * 2026.9.6: every per-session RPC on a foreign key answers "not found"). But
 * its operator scopes are a control-plane guardrail, not a boundary between
 * people: with operator.read a guest could still read the gateway log (which
 * carries every reply the agent sends), the audit trail, the config, the list
 * of people, and with operator.write invoke tools directly, send channel
 * messages or rewrite shared skills. So a guest's connection is cut down to
 * what a chat needs: an allowlist of RPC methods (the rest answered with a
 * refusal before they reach the gateway), an allowlist of HTTP paths, and the
 * hello, presence and health frames scrubbed of other people.
 *
 * The owner's connection is not parsed at all: identity headers, then bytes.
 */

/** Headers a browser (or anything in front of Hatchabot) must never get to set at the gateway. */
const IDENTITY_HEADER_RE = /^(x-hatchabot-|x-openclaw-|cf-access-|x-forwarded-|x-auth-request-|x-pomerium-|tailscale-|x-remote-user$|remote-user$|x-real-ip$|forwarded$|via$|x-client-ip$|true-client-ip$|cf-connecting-ip$)/i;

/** Drop every identity- or proxy-shaped header the caller sent. */
export function stripClientIdentity(headers: Record<string, string | string[] | undefined>): Record<string, string | string[] | undefined> {
  const h: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) if (!IDENTITY_HEADER_RE.test(k)) h[k] = v;
  return h;
}

/**
 * The address the gateway is told the person connected from. OpenClaw refuses
 * a trusted proxy's request whose X-Forwarded-For is missing or loopback
 * ("proxy_attribution_required"); behind Tailscale Serve, or at the machine
 * itself, Hatchabot only ever sees 127.0.0.1. Such a person is reported as a
 * fixed documentation address (TEST-NET-2): never a real peer, never local.
 */
export const LOCAL_BROWSER_ADDRESS = '198.51.100.1';
export function forwardedClientAddress(remote: string | undefined): string {
  const a = (remote ?? '').replace(/^::ffff:/, '');
  if (!a || a === '::1' || /^127\./.test(a) || !/^[0-9a-fA-F:.]+$/.test(a)) return LOCAL_BROWSER_ADDRESS;
  return a;
}

/**
 * Headers for one proxied request to an identity gateway: the caller's own
 * identity-shaped headers are gone first, then Hatchabot names the person. A
 * guest's scopes are capped at read + write — on HTTP too, where OpenClaw
 * would otherwise grant a trusted-proxy request the full default operator set.
 */
export function withConsoleIdentity(
  headers: Record<string, string | string[] | undefined>,
  who: { identity: string; guest: boolean; clientAddress: string },
): Record<string, string | string[] | undefined> {
  const h = stripClientIdentity(headers);
  h[CONSOLE_USER_HEADER] = who.identity;
  h['x-forwarded-for'] = who.clientAddress;
  if (who.guest) {
    h[CONSOLE_SCOPES_HEADER] = GUEST_SCOPES.join(',');
    // A guest's frames are read by the proxy; compressed ones could not be.
    delete h['sec-websocket-extensions'];
  }
  return h;
}

/** Static files the Control UI loads (by top-level directory or root file). */
const STATIC_DIRS = new Set(['assets', 'fonts', 'themes', 'app-art', 'community-art', 'file-icons', 'provider-icons', 'cloud-provider-icons']);
const STATIC_ROOT_FILES = /^(favicon[^/]*|apple-touch-icon[^/]*\.png|manifest\.webmanifest|sw\.js|social-card\.png|asset-manifest\.json|index\.html|control-ui-config\.json)$/;

/**
 * May a guest make this HTTP request through the console proxy? The app's
 * document and static files, avatars, and the media of their own chat (both
 * signed per reader by OpenClaw). Everything else — /tools/invoke, the
 * OpenAI-compatible API, hooks, session-history endpoints, plugin routes — is
 * an operator surface and stays closed to guests.
 */
export function guestHttpAllowed(method: string, path: string): boolean {
  return guestHttpPath(method, path) !== undefined;
}

/**
 * The path a guest's request is judged on and forwarded as, or undefined when
 * it is refused. The path arrives decoded; the gateway reads it with
 * `new URL()`, which takes '\' for '/', drops tabs and newlines, resolves
 * dot segments (%2e too) and reads a leading '//' as a host. So what is
 * judged must be exactly what the gateway will read: anything it would read
 * differently is refused, and only the judged path is sent on.
 */
export function guestHttpPath(method: string, path: string): string | undefined {
  const m = method.toUpperCase();
  const p = path.replace(/\/{2,}/g, '/');
  // '?' and '#' here came from %3F / %23: the real query is not part of `path`.
  // ';' (matrix parameters) and a literal '%' (from %25: a second round of
  // decoding at the gateway) are refused too: no path a guest's chat uses
  // has either, and a router could read them otherwise than this check (HB-0055).
  if (/[\\?#;%\x00-\x20\x7f]/.test(p)) return undefined;
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) return undefined;
  let read: string;
  try { read = new URL(p, 'http://gateway').pathname; } catch { return undefined; }
  if (read !== p) return undefined;
  return guestPathAllowed(m, p) ? p : undefined;
}

function guestPathAllowed(m: string, p: string): boolean {
  const segs = p.split('/').filter(Boolean);
  if (m === 'GET' || m === 'HEAD') {
    if (segs.length === 0) return true; // the app itself
    if (STATIC_DIRS.has(segs[0]!)) return true;
    if (segs.length === 1 && STATIC_ROOT_FILES.test(segs[0]!)) return true;
    if (/^\/api\/users\/[A-Za-z0-9-]{1,80}\/avatar$/.test(p)) return true;
    if (p === '/__openclaw__/assistant-media' || p.startsWith('/__openclaw__/assistant-media/')) return true;
    if (/^\/__openclaw__\/workspace-icon\/[^/]+$/.test(p)) return true;
    if (p.startsWith('/api/chat/media/outgoing/')) return true;
    // The chat's own route (a reload lands here). Not any extension-less
    // path: the gateway serves operator endpoints that way too (/mcp, /v1, …).
    if (segs[0] === 'chat' && !/\.[a-z0-9]{1,12}$/i.test(segs[segs.length - 1]!)) return true;
    return false;
  }
  // The one write a chat makes over HTTP: an attachment the guest sends.
  if (m === 'POST' && p === '/api/chat/media/outgoing') return true;
  return false;
}

/**
 * The gateway RPCs a guest's chat needs. Anything else is refused by the
 * proxy — including methods OpenClaw would have allowed a read/write
 * operator. OpenClaw still decides, on top, which SESSIONS they touch.
 */
export const GUEST_METHODS: ReadonlySet<string> = new Set([
  'connect',
  // chat
  'chat.history', 'chat.send', 'chat.abort', 'chat.message.get', 'chat.metadata', 'chat.startup', 'chat.toolTitles',
  'agent', 'agent.wait', 'agent.identity.get', 'agents.list',
  // their own sessions (OpenClaw hides everyone else's)
  'sessions.list', 'sessions.create', 'sessions.get', 'sessions.describe', 'sessions.preview', 'sessions.resolve',
  'sessions.search', 'sessions.subscribe', 'sessions.messages.subscribe', 'sessions.messages.unsubscribe',
  'sessions.patch', 'sessions.delete', 'sessions.abort', 'sessions.send', 'sessions.steer', 'sessions.title.prepare',
  'sessions.activitySummary.ensure', 'sessions.setInvolvement', 'sessions.viewers.set', 'sessions.observer.visibility',
  'sessions.branches.list', 'sessions.branches.switch', 'sessions.fork', 'sessions.compact', 'sessions.groups.list',
  // OpenClaw re-checks each listed catalog entry against the reader's session visibility.
  'sessions.catalog.list',
  'session.typing',
  // Questions the agent asks in their own run (OpenClaw binds each to its run and session).
  'question.list', 'question.get', 'question.resolve',
  // the app's own furniture
  'health', 'models.list', 'commands.list', 'tools.catalog', 'gateway.identity.get',
  'users.self', 'users.prefs.get', 'users.prefs.set', 'themes.list', 'themes.get', 'themes.set',
  'mentions.list', 'mentions.dismiss', 'push.web.vapidPublicKey',
]);

/** What a guest's connection is confined to: their agent (slug) and their own conversation on it. */
export interface GuestScope {
  /** The OpenClaw agent the guest's role lets them use. */
  agentId?: string;
  /** Their conversation (guestConsoleSessionKey): `agent:<agentId>:guest:<…>`. */
  sessionKey?: string;
}

/** The part of the guest's session key after `agent:<agentId>:` — what the UI calls the main key. */
function guestMainKey(scope: GuestScope): string | undefined {
  const head = `agent:${scope.agentId}:`;
  return scope.agentId && scope.sessionKey?.startsWith(head) && scope.sessionKey.length > head.length ? scope.sessionKey.slice(head.length) : undefined;
}

/**
 * What a guest's Control UI is told about the agents (2026-09-30): only the
 * one their role lets them use (the gateway's role already confines them to
 * it), with their own conversation as its main one — the sidebar's Home opened
 * the owner's ("Session … was not found") — and no `defaultPermissionMode`:
 * the composer showed "Default (Full Access)" from it, an operator setting a
 * guest cannot choose; without it the composer says "Default" ("follow the
 * agent's configured execution permissions"), which is what a guest's turns do.
 */
export function guestAgentsList(payload: unknown, scope: GuestScope = {}): unknown {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { agents?: unknown }).agents)) return payload;
  const { agentId } = scope;
  const p = { ...(payload as Record<string, unknown>) };
  let agents = (p.agents as unknown[]).filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && !Array.isArray(a));
  if (agentId && agents.some((a) => a.id === agentId)) agents = agents.filter((a) => a.id === agentId);
  p.agents = agents.map(({ defaultPermissionMode: _mode, ...rest }) => rest);
  if (agentId && agents.some((a) => a.id === agentId)) {
    p.defaultId = agentId;
    const mainKey = guestMainKey(scope);
    if (mainKey && typeof p.mainKey === 'string') p.mainKey = mainKey;
  }
  return p;
}

/** The hello's session defaults, for a guest: their agent, their conversation (as guestAgentsList). */
export function guestSessionDefaults(defaults: unknown, scope: GuestScope = {}): unknown {
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || !scope.agentId) return defaults;
  const d = { ...(defaults as Record<string, unknown>) };
  d.defaultAgentId = scope.agentId;
  const mainKey = guestMainKey(scope);
  if (mainKey) {
    if ('mainKey' in d) d.mainKey = mainKey;
    if ('mainSessionKey' in d) d.mainSessionKey = scope.sessionKey;
  }
  return d;
}

/**
 * The Control UI's boot settings (`control-ui-config.json`), for a guest: no
 * community invite card (it invites whoever runs the gateway to OpenClaw's
 * Discord). `terminalEnabled` is left as it is: the app reloads itself when it
 * differs from the page's own attribute (an endless reload loop, seen
 * 2026-09-30), and a guest's terminal is hidden anyway — it needs
 * operator.admin and `terminal.open`, which the hello does not advertise.
 */
export function guestControlUiConfig(body: string): string | undefined {
  let j: unknown;
  try { j = JSON.parse(body); } catch { return undefined; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
  return JSON.stringify({ ...(j as Record<string, unknown>), communityInvite: false });
}

/** Where a guest's page loads the script below from (under the console prefix; served by Hatchabot, never proxied). */
export const GUEST_VIEW_SCRIPT_PATH = '/__hatchabot/guest-view.js';

/** The sidebar pages a guest can use: their conversations. Pinned conversations (`session:`) stay too. */
export const GUEST_SIDEBAR_ROUTES: readonly string[] = ['route:sessions'];

/**
 * A guest's sidebar (2026-09-30). The Control UI decides which pages the
 * sidebar shows from one per-browser setting — `sidebarEntries` in
 * `openclaw.control.settings.v1:<gateway url>` — with a fixed default
 * (Agents, Dashboards, Systems, Automations, Plugins); neither the hello's
 * methods nor its scopes hide them (verified on 2026.9.6). So a guest's page
 * starts with that setting pruned to what a guest can open, before the app
 * reads it: data the UI already honours, not a change to the UI. Run as a
 * classic script ahead of the app's modules; storage that is blocked leaves
 * the default view, nothing worse.
 */
export const GUEST_VIEW_SCRIPT = `// Hatchabot: a web-chat guest's view of this console.
(function () {
  try {
    var m = /^(.*\\/v1\\/agents\\/[^/]+\\/ui)(?:\\/|$)/.exec(location.pathname);
    if (!m) return;
    var gw = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + m[1];
    var key = 'openclaw.control.settings.v1:' + gw;
    var keep = ${JSON.stringify(GUEST_SIDEBAR_ROUTES)};
    var s = null;
    try { s = JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { s = null; }
    if (!s || typeof s !== 'object' || Array.isArray(s)) s = { gatewayUrl: gw };
    var had = Array.isArray(s.sidebarEntries) ? s.sidebarEntries : null;
    var kept = (had || []).filter(function (e) { return typeof e === 'string' && (e.indexOf('session:') === 0 || keep.indexOf(e) >= 0); });
    if (had && kept.length === had.length) return;
    s.sidebarEntries = kept;
    if (!s.gatewayUrl) s.gatewayUrl = gw;
    localStorage.setItem(key, JSON.stringify(s));
  } catch (e) { /* blocked storage: the default view */ }
})();
`;

/** A guest's copy of the app's document: the script above runs first (same origin, so the page's CSP allows it). */
export function withGuestView(html: string, prefix: string): string {
  const tag = `<script src="${prefix.replace(/\/+$/, '')}${GUEST_VIEW_SCRIPT_PATH}"></script>`;
  if (/<script\b/i.test(html)) return html.replace(/<script\b/i, `${tag}\n    <script`);
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}\n</head>`) : `${tag}${html}`;
}

export interface GuestVerdict { allow: boolean; id?: string | number; method?: string; reason?: string }

/** Judge one client→gateway message from a guest. */
export function guestRequestVerdict(msg: unknown): GuestVerdict {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { allow: false, reason: 'not a request' };
  const m = msg as { type?: unknown; id?: unknown; method?: unknown; params?: unknown };
  // As sent, string or number: a refusal is answered under it, and the console matches by it.
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : undefined;
  if (m.type !== 'req' || typeof m.method !== 'string') return { allow: false, id, reason: 'not a request' };
  const method = m.method;
  if (!GUEST_METHODS.has(method)) return { allow: false, id, method, reason: 'not available to guests' };
  if (method === 'connect') {
    // Only as an operator: a node (a device that runs commands for the agent)
    // is the owner's to pair.
    const role = (m.params as { role?: unknown } | undefined)?.role;
    if (role !== undefined && role !== 'operator') return { allow: false, id, method, reason: 'guests connect as operators only' };
  }
  return { allow: true, id, method };
}

/**
 * Requests that stop something: passed on at once even while the browser is
 * behind, unless requests it sent before are kept (GUEST_KEEP_LIMIT); then
 * in order behind them, so a stop never overtakes what it stops.
 */
export const GUEST_CANCELS: ReadonlySet<string> = new Set(['chat.abort', 'sessions.abort']);


/** A guest's request answered here, not by the gateway: an error under the id it came with. */
export function guestError(id: string | number | undefined, code: string, message: string): string {
  return JSON.stringify({ type: 'res', id: id ?? null, ok: false, error: { code, message } });
}

/** What a refused guest request is answered with. */
export function guestRefusal(id: string | number | undefined, method: string | undefined): string {
  return guestError(id, 'FORBIDDEN', `${method ? `"${method}" is` : 'That is'} not available to guests of this agent — its owner has the full console.`);
}

const sameIdentity = (a: unknown, identity: string): boolean => typeof a === 'string' && a.toLowerCase() === identity.toLowerCase();

/** Keep the gateway's own presence and this guest's; drop everyone else's. */
function scrubPresence(list: unknown, identity: string): unknown {
  if (!Array.isArray(list)) return list;
  return list.filter((e) => {
    if (!e || typeof e !== 'object') return false;
    const p = e as { mode?: unknown; reason?: unknown; user?: { email?: unknown } };
    if (p.mode === 'gateway') return true;
    return sameIdentity(p.user?.email, identity);
  });
}

/** Health lists each agent's most recent sessions — other people's among them. */
function scrubHealth(h: unknown): unknown {
  if (!h || typeof h !== 'object') return h;
  const out = { ...(h as Record<string, unknown>) };
  const scrubSessions = (s: unknown) => (s && typeof s === 'object' ? { ...(s as object), recent: [], count: undefined } : s);
  if (Array.isArray(out.agents)) out.agents = out.agents.map((a) => (a && typeof a === 'object' ? { ...a, sessions: scrubSessions((a as { sessions?: unknown }).sessions) } : a));
  if (out.sessions) out.sessions = scrubSessions(out.sessions);
  return out;
}

/** Replies the proxy rewrites for a guest, by the method asked: their requests are followed to their replies (GuestReplies). */
export const GUEST_REWRITTEN_REPLIES: ReadonlySet<string> = new Set(['health', 'agents.list']);
/** How many of those a guest may have waiting for their answer at once. */
export const MAX_GUEST_PENDING = 1000;
/** The longest id one of those may have: each id waiting is remembered (GuestReplies), so each is bounded too. The console's are UUIDs. */
export const MAX_GUEST_ID_LENGTH = 256;
/**
 * How long one of those waits for its answer: then the guest is answered
 * here ("took too long"), and an answer that comes later is dropped, never
 * passed on.
 */
export const GUEST_REPLY_WAIT_MS = 2 * 60_000;
/**
 * What the console sends on its own, on a timer: not the person, for the
 * public address's idle limit. The ones seen are its health and agent-list
 * polls; requests refused here never count either. Kept apart from
 * GUEST_REWRITTEN_REPLIES on purpose: that is what gets scrubbed, this is
 * what is not the person. Their members agree today by chance, and a test
 * names both, so changing either is deliberate.
 */
export const CONSOLE_POLLS: ReadonlySet<string> = new Set(['health', 'agents.list']);
/**
 * Consoles one guest may have open at once (each may hold up to maxQueued).
 * Opening one more closes their least recently active, if they have used it
 * for none of GUEST_IDLE_TO_CLOSE_MS (routes.ts): a connection whose browser
 * went without a word looks open to the server.
 */
export const MAX_GUEST_CONSOLES = 8;
/**
 * How long a guest's console must have gone unused before a new one may
 * close it to make room. Tabs in use cannot then close each other in turn
 * (one reconnecting closes another, which reconnects…): past the limit with
 * all in use, the new one is refused.
 */
export const GUEST_IDLE_TO_CLOSE_MS = 2 * 60_000;
/**
 * How often one of a guest's consoles may be closed to make room for a new
 * one: at most once in this long. Within it, past MAX_GUEST_CONSOLES, a new
 * one is refused, so idle tabs that reconnect cannot close each other in
 * turn either.
 */
export const GUEST_ROOM_EVERY_MS = 10 * 60_000;
/** How long a guest's console may wait for the gateway's handshake, holding one of those, before both sides are closed. */
export const GUEST_CONNECT_TIMEOUT_MS = 30_000;

/** The error for a followed request whose answer could not be made into a guest's copy (scrubForGuest, spliceGuest). */
const unscrubbable = (method: string) => ({
  code: 'UNAVAILABLE', message: `"${method}" was answered in a form a guest's copy could not be made from, so it was not passed on.`,
});
/** That answer, made here under the guest's id. */
export function guestUnscrubbable(id: string | number, method: string): string {
  const e = unscrubbable(method);
  return guestError(id, e.code, e.message);
}

const TOO_MANY_WAITING = 'too many requests are waiting for an answer. Try again in a moment';
/** What a guest request the proxy could not follow to its reply is answered with (it is not sent on). */
export function guestUntracked(id: string | number | undefined, method: string | undefined, why = TOO_MANY_WAITING): string {
  return guestError(id, 'UNAVAILABLE', `${method ? `"${method}"` : 'That request'} was not sent: ${why}.`);
}

/**
 * A guest's requests whose replies are rewritten (GUEST_REWRITTEN_REPLIES),
 * on their way. Each is sent to the gateway under an id of the proxy's own —
 * this connection's random prefix and a count — and its reply is given the
 * guest's id back. Found by the guest's own id, a reply could be taken for
 * another's: a request under the same id, or a second answer to one (`agent`
 * answers "accepted", then its result), consumed the entry, and the health
 * reply after it passed as it came (HB-0592, after HB-0133). Under an id
 * only the proxy knows, no other reply can take its place; a reply under one
 * that nothing waits for is never passed on. One not answered within
 * GUEST_REPLY_WAIT_MS is given up on (prune): the guest is answered with an
 * error, and a gateway that never answers does not fill the cap for good.
 * Other requests go as they came, under the guest's own ids, and are not
 * followed.
 */
export class GuestReplies {
  readonly #prefix = `hatchabot-${randomBytes(12).toString('hex')}-`;
  #count = 0;
  /** In the order sent, so the oldest are first. `at` is performance.now(): a clock set back or forward does not move it. */
  readonly #waiting = new Map<string, { id: string | number; method: string; at: number }>();
  /** How many are waiting (MAX_GUEST_PENDING). */
  get size(): number { return this.#waiting.size; }
  /** Forget those that have waited GUEST_REPLY_WAIT_MS; returns them (the guest's id, the method), to be answered. */
  prune(now = performance.now()): Array<{ id: string | number; method: string }> {
    const gone: Array<{ id: string | number; method: string }> = [];
    for (const [ours, w] of this.#waiting) {
      if (now - w.at < GUEST_REPLY_WAIT_MS) break;
      this.#waiting.delete(ours);
      gone.push({ id: w.id, method: w.method });
    }
    return gone;
  }
  /** How long until the oldest is due to be pruned, or undefined when none waits. */
  nextDue(now = performance.now()): number | undefined {
    const first = this.#waiting.values().next();
    return first.done ? undefined : Math.max(0, first.value.at + GUEST_REPLY_WAIT_MS - now);
  }
  /** The request waiting under one of the proxy's ids, left waiting. */
  peek(id: unknown): { id: string | number; method: string } | undefined {
    const w = typeof id === 'string' ? this.#waiting.get(id) : undefined;
    return w && { id: w.id, method: w.method };
  }
  /** Remember a request (the guest's id, the method asked); returns the id to send it under. */
  track(id: string | number, method: string): string {
    const ours = `${this.#prefix}${this.#count++}`;
    this.#waiting.set(ours, { id, method, at: performance.now() });
    return ours;
  }
  /**
   * A reply's id, read: the request it answers (forgotten from here on);
   * 'stray' for an id of the proxy's that nothing waits under; undefined for
   * any other id (a reply to a request that is not followed).
   */
  answer(id: unknown): { id: string | number; method: string } | 'stray' | undefined {
    if (typeof id !== 'string' || !id.startsWith(this.#prefix)) return undefined;
    const asked = this.#waiting.get(id);
    if (!asked) return 'stray';
    this.#waiting.delete(id);
    return { id: asked.id, method: asked.method };
  }
}

/** scrubForGuest's answer for a message that must not reach the guest at all. */
export const GUEST_DROP: unique symbol = Symbol('guest-drop');

/**
 * A gateway→guest message, with other people taken out: the hello's presence
 * and health snapshot, presence and health events, and a health reply — and
 * an agents.list reply told the guest's truth (guestAgentsList). `pending`
 * holds the guest's requests whose replies are rewritten (GuestReplies).
 * Returns undefined when nothing needed changing (the bytes pass as they
 * came), GUEST_DROP when the message must not be passed on, else the message
 * to send instead.
 */
export function scrubForGuest(msg: unknown, identity: string, pending: GuestReplies, scope: GuestScope = {}): unknown | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const f = msg as { type?: string; event?: string; id?: unknown; ok?: boolean; payload?: any };
  const asked = f.type === 'res' ? pending.answer(f.id) : undefined;
  // A second reply, or one to a request the proxy never sent: what it holds is unknown.
  if (asked === 'stray') return GUEST_DROP;
  if (asked) {
    // The reply goes back as the gateway sent it, under the guest's id, but
    // for its payload: a refusal (anything but ok: true) loses any payload it
    // carried, which is not rewritten; a payload goes only once rewritten.
    const { payload, ...reply } = f;
    reply.id = asked.id;
    if (f.ok !== true) return { ...reply, ok: false };
    if (payload === undefined || payload === null) return { ...f, id: asked.id };
    if (typeof payload === 'object' && asked.method === 'health') return { ...reply, payload: scrubHealth(payload) };
    if (typeof payload === 'object' && asked.method === 'agents.list') return { ...reply, payload: guestAgentsList(payload, scope) };
    // A reply that is not the shape a guest's copy is made from is not passed
    // on, but the request is answered: the console does not wait for ever.
    return { ...reply, ok: false, error: unscrubbable(asked.method) };
  }
  if (f.type === 'res' && f.ok && f.payload && typeof f.payload === 'object') {
    if (f.payload.type === 'hello-ok') {
      const payload = { ...f.payload };
      if (payload.snapshot) {
        const snap = { ...payload.snapshot };
        if ('presence' in snap) snap.presence = scrubPresence(snap.presence, identity);
        if ('health' in snap) snap.health = scrubHealth(snap.health);
        if ('sessionDefaults' in snap) snap.sessionDefaults = guestSessionDefaults(snap.sessionDefaults, scope);
        payload.snapshot = snap;
      }
      // Only the methods a guest may use are advertised: the chat hides what
      // isn't, instead of offering Publish PR, automations, projects… and
      // showing "not available to guests" when one is opened (2026-09-30).
      if (payload.features && Array.isArray(payload.features.methods)) {
        payload.features = { ...payload.features, methods: payload.features.methods.filter((m: unknown) => typeof m === 'string' && GUEST_METHODS.has(m)) };
      }
      return { ...f, payload };
    }
    return undefined;
  }
  if (f.type === 'event') {
    if (f.event === 'presence') {
      const p = f.payload;
      if (Array.isArray(p)) return { ...f, payload: scrubPresence(p, identity) };
      if (p && typeof p === 'object' && 'presence' in p) return { ...f, payload: { ...p, presence: scrubPresence(p.presence, identity) } };
      return undefined;
    }
    if (f.event === 'health') return { ...f, payload: scrubHealth(f.payload) };
  }
  return undefined;
}

// ---- WebSocket frames (RFC 6455), just enough to read a guest's messages ----

/**
 * One frame, as read: its bytes (raw) and what its header said, read once.
 * Its payload is unmasked only when asked for, so a frame held for a message
 * not yet finished holds its bytes once, as they came.
 */
export class WsFrame {
  constructor(
    readonly fin: boolean, readonly rsv: number, readonly opcode: number, readonly masked: boolean,
    /** The frame as read: header, mask key and payload. */
    readonly raw: Buffer,
    /** Where its payload starts in raw. */
    readonly at: number,
  ) {}
  /** Payload bytes. */
  get length(): number { return this.raw.length - this.at; }
  /** The payload, unmasked: made each time it is asked for when masked, else a view of raw. */
  get payload(): Buffer {
    if (!this.masked) return this.raw.subarray(this.at);
    const p = Buffer.allocUnsafe(this.length);
    this.payloadInto(p, 0);
    return p;
  }
  /** Write the payload, unmasked, into `to` at `offset`. */
  payloadInto(to: Buffer, offset: number): void {
    const { raw, at } = this;
    if (!this.masked) { raw.copy(to, offset, at); return; }
    const key = raw.subarray(at - 4, at);
    for (let i = 0, n = raw.length - at; i < n; i++) to[offset + i] = raw[at + i]! ^ key[i & 3]!;
  }
}

/** A frame's header, read once: its payload's length, and where in the frame it starts. */
type FrameHead = { fin: boolean; rsv: number; opcode: number; masked: boolean; length: number; at: number };

/** What each chunk held costs beyond its bytes (FrameReader.held): many tiny ones count as more. */
const CHUNK_COST = 64;

/**
 * Reads frames out of a byte stream. Throws on a protocol error or a frame
 * over the cap. What is read is kept as it came, a list of chunks. A frame's
 * header is read once, when all of it is in (the chunks it spans joined
 * into one, at most 14 bytes, once), and the frame's bytes are copied once,
 * into a buffer of their own, when it is whole. Joining each chunk to all
 * before it copied a large frame over and over, and re-reading a header
 * that spans many tiny chunks walked them all on every read (HB-0594
 * review).
 */
export class FrameReader {
  #chunks: Buffer[] = [];
  #first = 0; // the first chunk still held
  #size = 0;
  /** The header of the frame being read, once all of it is in. */
  #head: FrameHead | undefined;
  #data = 0; // bytes of whole data frames read
  constructor(private readonly maxPayload: number) {}
  push(chunk: Buffer): WsFrame[] {
    if (chunk.length) { this.#chunks.push(chunk); this.#size += chunk.length; }
    const out: WsFrame[] = [];
    for (;;) {
      const h = this.#head ?? this.#header();
      this.#head = h;
      if (!h || this.#size < h.at + h.length) break;
      this.#head = undefined;
      const raw = this.#take(h.at + h.length);
      if (h.opcode < 0x8) this.#data += raw.length;
      out.push(new WsFrame(h.fin, h.rsv, h.opcode, h.masked, raw, h.at));
    }
    return out;
  }
  /** Bytes read but not yet a whole frame. */
  get buffered(): number { return this.#size; }
  /** What they hold: their bytes, and CHUNK_COST for each chunk they came in. */
  get held(): number { return this.#size + CHUNK_COST * (this.#chunks.length - this.#first); }
  /** Bytes of data frames read, whole or being read: it grows only as messages' own bytes come, not pings or pongs. */
  get dataRead(): number { return this.#data + (this.#head && this.#head.opcode < 0x8 ? this.#size : 0); }
  /** A frame begun but not yet whole: its opcode and payload length, once its header is in. */
  get partial(): { opcode: number; length: number } | undefined {
    const h = this.#head;
    return h && { opcode: h.opcode, length: h.length };
  }
  /** The next frame's header, once all of it is in. */
  #header(): FrameHead | undefined {
    if (this.#size < 2) return undefined;
    const b = this.#front(Math.min(this.#size, 14));
    let length = b[1]! & 0x7f;
    let at = 2;
    if (length === 126) {
      if (b.length < 4) return undefined;
      length = b.readUInt16BE(2); at = 4;
    } else if (length === 127) {
      if (b.length < 10) return undefined;
      const big = b.readBigUInt64BE(2);
      if (big > BigInt(this.maxPayload)) throw new Error('frame too large');
      length = Number(big); at = 10;
    }
    if (length > this.maxPayload) throw new Error('frame too large');
    const masked = (b[1]! & 0x80) !== 0;
    if (masked) at += 4;
    if (b.length < at) return undefined;
    const fin = (b[0]! & 0x80) !== 0, opcode = b[0]! & 0x0f;
    // A control frame is whole and small (RFC 6455 5.5): one that is not is refused before its payload is held.
    if (opcode >= 0x8 && length > 125) throw new ProtocolFault('a control frame over 125 bytes');
    if (opcode >= 0x8 && !fin) throw new ProtocolFault('a control frame in fragments');
    return { fin, rsv: (b[0]! >> 4) & 0x07, opcode, masked, length, at };
  }
  /**
   * The first `n` bytes held, copied into a buffer of their own. The chunks
   * they span are let go, but for what is left of the last; returned with
   * the index of the chunk the rest begins at.
   */
  #join(n: number): [Buffer, number] {
    let j = this.#first;
    let got = 0;
    while (got < n) got += this.#chunks[j++]!.length;
    const out = Buffer.concat(this.#chunks.slice(this.#first, j), n);
    const last = this.#chunks[j - 1]!;
    for (let k = this.#first; k < j; k++) this.#chunks[k] = NOTHING;
    if (got > n) this.#chunks[--j] = last.subarray(last.length - (got - n));
    return [out, j];
  }
  /** The first chunk, made to hold at least the first `n` bytes (n ≤ 14): the chunks they span are joined, once. */
  #front(n: number): Buffer {
    const first = this.#chunks[this.#first]!;
    if (first.length >= n) return first;
    // They span two chunks or more: the joined bytes go back in the slot just before the rest.
    const [joined, rest] = this.#join(n);
    this.#first = rest - 1;
    this.#chunks[this.#first] = joined;
    return joined;
  }
  /** Take the first `n` bytes held, copied into a buffer of their own; the chunks they came in are let go. */
  #take(n: number): Buffer {
    const [out, rest] = this.#join(n);
    this.#first = rest;
    this.#size -= n;
    if (this.#first === this.#chunks.length) { this.#chunks = []; this.#first = 0; }
    else if (this.#first >= 1024 && this.#first * 2 >= this.#chunks.length) { this.#chunks.splice(0, this.#first); this.#first = 0; }
    return out;
  }
}

/** One frame, FIN set. Client→server frames must be masked; server→client must not. */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.allocUnsafe(head + (mask ? 4 : 0) + len);
  out[0] = 0x80 | (opcode & 0x0f);
  if (len < 126) out[1] = len;
  else if (len < 65536) { out[1] = 126; out.writeUInt16BE(len, 2); }
  else { out[1] = 127; out.writeBigUInt64BE(BigInt(len), 2); }
  if (mask) {
    out[1]! |= 0x80;
    const key = randomBytes(4);
    key.copy(out, head);
    for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i]! ^ key[i & 3]!;
  } else {
    payload.copy(out, head);
  }
  return out;
}

const closeFrame = (code: number, reason: string, mask: boolean): Buffer => {
  const r = Buffer.from(reason.slice(0, 100), 'utf8');
  const p = Buffer.allocUnsafe(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return encodeFrame(0x8, p, mask);
};

/**
 * The most frames one message may come in. Browsers and OpenClaw's gateway
 * send each message as one frame; the size cap alone let a peer keep any
 * number of empty ones waiting for a message it never finished (HB-0594). With
 * this, what a half-sent message holds is bounded: its payload (the size cap)
 * plus at most this many frame headers and records.
 */
export const MAX_MESSAGE_FRAMES = 1024;

/**
 * Assembles data frames into messages; control frames come out on their own.
 * A message's frames are kept as read until it is whole; then its payload is
 * made once, unmasked into a buffer of its size (one frame's: that frame's
 * payload).
 */
class MessageAssembler {
  #frames: WsFrame[] = [];
  #size = 0;
  #held = 0;
  #finished = 0;
  constructor(private readonly maxMessage: number) {}
  /** Payload bytes of a message begun but not finished. */
  get size(): number { return this.#size; }
  /** A message is begun and not finished. */
  get begun(): boolean { return this.#frames.length > 0; }
  /** What its frames hold, as read. */
  get held(): number { return this.#held; }
  /** How many messages have been finished. */
  get finished(): number { return this.#finished; }
  /** Complete items in order: a control frame, or a whole message (its frames as read, and its payload). */
  take(f: WsFrame): { control?: WsFrame; message?: { opcode: number; raws: Buffer[]; data: Buffer } } | undefined {
    if (f.rsv !== 0) throw new Error('unexpected extension bits');
    if (f.opcode >= 0x8) return { control: f };
    if (f.opcode !== 0 && this.#frames.length) throw new Error('interleaved message');
    if (f.opcode === 0 && !this.#frames.length) throw new Error('continuation without a start');
    if (this.#frames.length >= MAX_MESSAGE_FRAMES) throw new Error('message in too many frames');
    this.#size += f.length;
    if (this.#size > this.maxMessage) throw new Error('message too large');
    if (!f.fin) {
      this.#frames.push(f);
      this.#held += f.raw.length;
      return undefined;
    }
    this.#finished++;
    if (!this.#frames.length) {
      this.#size = 0;
      return { message: { opcode: f.opcode, raws: [f.raw], data: f.payload } };
    }
    const frames = [...this.#frames, f];
    const data = Buffer.allocUnsafe(this.#size);
    let at = 0;
    for (const x of frames) { x.payloadInto(data, at); at += x.length; }
    this.#frames = []; this.#size = 0; this.#held = 0;
    return { message: { opcode: frames[0]!.opcode, raws: frames.map((x) => x.raw), data } };
  }
}

export interface GuestSpliceOptions {
  identity: string;
  /** Their agent and conversation: what agents.list and the hello's session defaults are told (guestAgentsList). */
  scope?: GuestScope;
  /** Largest message either way (chat attachments ride inside chat.send). */
  maxMessage?: number;
  /** Most bytes that may wait to be sent to either side; a write past it closes the connection (default: the largest message and GUEST_QUEUE_SLACK). */
  maxQueued?: number;
  /** How long a side may take nothing it was sent before the connection is closed (default GUEST_STALL_MS). */
  stallMs?: number;
  /**
   * Called when the person is active: the browser sends a message (read
   * whole, or each piece of an upload, UPLOAD_SIZE or more, still arriving),
   * and while one waits for the gateway, each time a side takes some. Not for
   * a ping, pong or close, a poll the console makes on its own
   * (CONSOLE_POLLS), a request refused here, or the gateway streaming to a
   * slow browser. A guest's
   * console is held to the public address's idle limit by this alone
   * (routes.ts, refuseOpenSocket). `upload` is true when only pieces of a
   * message still arriving were the person's (onUploadRefused may take them back).
   */
  onActive?: (what?: 'upload' | 'waiting') => void;
  /**
   * A message whose pieces were told to onActive as an upload ('upload')
   * did not count once whole (refused, or a poll): what they marked should
   * be put back.
   */
  onUploadRefused?: () => void;
  /** Told of each refused method, for the activity trail. */
  onRefused?: (method: string | undefined) => void;
  /** Told when a gateway message could not be read or scrubbed (it was not passed on): to log. */
  onScrubError?: (e: unknown) => void;
  /**
   * Told how much more (or, negative, less) this console holds than it last
   * said, and when it closes, all of it back; returns what the guest's open
   * consoles hold together (ConsoleAccess.addGuestHeld). Past maxGuestHeld,
   * the console whose bytes pushed it over is closed, unless it is the only
   * one holding any: its own limits are what apply then.
   */
  countHeld?: (change: number) => number;
  /** Default GUEST_HELD_LIMIT. */
  maxGuestHeld?: number;
}

/** An open guest connection (spliceGuest), for the caller. */
export interface GuestSplice {
  /** Bytes it holds now: messages begun and not finished, and what waits to be sent, both ways. */
  held(): number;
  /** Close both sides with `code` and `reason` (the browser reads it as CloseEvent.reason). */
  close(code: number, reason: string): void;
  /**
   * Whether the guest's chat is being answered: a chat or agent event for
   * their own session (scope.sessionKey) came within GUEST_IDLE_TO_CLOSE_MS,
   * or a chat.send of theirs is not answered yet or its run has not ended
   * (the ack, "started", is not its end; the run's last chat event is), for
   * up to GUEST_ROOM_EVERY_MS from it or the last such event, so an agent
   * that never answers does not keep a dead console open for ever. Such a
   * console is not idle (routes.ts).
   */
  answering(): boolean;
}

/**
 * Room, past the largest message, for what may wait to be sent to one side of
 * a guest's connection (HB-0593). Whatever writes into a side that is behind
 * waits, but a chunk already read is still passed on whole: one large
 * message, or many tiny refused requests answered with longer refusals, fit
 * in it.
 */
export const GUEST_QUEUE_SLACK = 4 * 1024 * 1024;
/**
 * How long a side may take nothing it was sent before the connection is
 * closed. Each piece it takes (WRITE_PIECE) restarts it: a slow phone may
 * need minutes for a long history, a stalled peer is let go after this.
 */
export const GUEST_STALL_MS = 60_000;

/**
 * How long a guest's browser has, once the gateway has closed, to take what
 * still waits for it before the connection is ended (HB-0593): a slow one
 * that takes a piece within each GUEST_STALL_MS is not drained for ever.
 */
export const GUEST_DRAIN_MS = 30_000;

/** The requests that start an agent run, followed for answering(): chat.send (the Control UI's) and agent (the RPC). */
const RUN_METHODS: ReadonlySet<string> = new Set(['chat.send', 'agent']);
/** A run request's first reply that only says the run is under way (OpenClaw: chat.send "started" or "in_flight", agent "accepted"). */
const RUN_ACKS: ReadonlySet<string> = new Set(['started', 'in_flight', 'accepted']);

/**
 * When the person last used a guest's console (routes.ts), on both clocks:
 * `usedAt` (performance.now(): room-making, which a wall clock set forward
 * must not fool) and `wallAt` (Date.now(): the public idle limit). The
 * pieces of an upload count as it arrives ('upload'); if it does not count
 * once whole, putBack goes back to the last activity that was not the
 * upload, a message of theirs the gateway took meanwhile ('waiting')
 * included. A whole message ends the upload (mark()).
 */
export class GuestActivity {
  #keep: { usedAt: number; wallAt: number } | undefined; // what putBack goes back to, while an upload arrives
  constructor(public usedAt = performance.now(), public wallAt = Date.now()) {}
  mark(what?: 'upload' | 'waiting'): void {
    const before = { usedAt: this.usedAt, wallAt: this.wallAt };
    this.usedAt = performance.now();
    this.wallAt = Date.now();
    if (what === 'upload') this.#keep ??= before;
    else if (what === 'waiting') { if (this.#keep) this.#keep = { usedAt: this.usedAt, wallAt: this.wallAt }; }
    else this.#keep = undefined;
  }
  putBack(): void {
    if (!this.#keep) return;
    ({ usedAt: this.usedAt, wallAt: this.wallAt } = this.#keep);
    this.#keep = undefined;
  }
}
/**
 * How long one message may take to arrive whole, from its first bytes,
 * however they come: a 32 MB attachment needs about 55 KB/s. A trickle of a
 * byte a minute is not held for ever (HB-0594).
 */
export const MESSAGE_DEADLINE_MS = 10 * 60_000;
/**
 * What waits for a side is handed to its socket in pieces of at most this
 * size, the next once the last is taken: a reader at 1 KB/s still takes one
 * well inside GUEST_STALL_MS.
 */
const WRITE_PIECE = 16 * 1024;
/** A side with more than this waiting for it is behind: whatever writes into it is not read. Ordinary replies fit. */
const BEHIND = 4 * WRITE_PIECE;
/**
 * Answers made here (refusals, "took too long") that may wait for a browser
 * at once. One read of the browser may hold many tiny refused requests, each
 * answered at more length, so what it earns this way is bounded on its own;
 * past it the guest is closed.
 */
export const GUEST_REFUSAL_BUDGET = 256 * 1024;
/**
 * The most one guest's open consoles may hold together (HB-0593, HB-0594):
 * messages begun and not finished, and what waits to be sent either way.
 * Each console is bounded on its own: by default about the largest message
 * and GUEST_QUEUE_SLACK waiting each way (2 × 36 MB) and a message being read
 * each way; this is above all of that, so one chat never reaches it alone.
 * A guest may have MAX_GUEST_CONSOLES; past this, the one whose bytes pushed
 * it over is closed.
 */
export const GUEST_HELD_LIMIT = 160 * 1024 * 1024;
/**
 * What the browser's requests may hold here, kept for the gateway, while the
 * browser is behind (it is still read, so its pongs, its close and a stop
 * get through); past it, it is not read until it catches up. Counted in held().
 */
export const GUEST_KEEP_LIMIT = 64 * 1024;
/** A message at least this large, arriving piece by piece, is an upload: the person (polls are small). */
const UPLOAD_SIZE = 16 * 1024;
const NOTHING = Buffer.alloc(0);
/**
 * First in, first out: taking from the front costs the same however long it
 * is, and what was taken is let go.
 */
class Queue<T> {
  #items: Array<T | undefined> = [];
  #head = 0;
  get length(): number { return this.#items.length - this.#head; }
  push(item: T): void { this.#items.push(item); }
  /** The first, not taken. */
  peek(): T | undefined { return this.#items[this.#head]; }
  /** The last added, not taken. */
  last(): T | undefined { return this.length ? this.#items[this.#items.length - 1] : undefined; }
  shift(): T | undefined {
    if (!this.length) return undefined;
    const item = this.#items[this.#head];
    this.#items[this.#head++] = undefined;
    if (this.#head === this.#items.length) this.clear();
    else if (this.#head >= 1024 && this.#head * 2 >= this.#items.length) { this.#items.splice(0, this.#head); this.#head = 0; }
    return item;
  }
  clear(): void { this.#items = []; this.#head = 0; }
}

/** A side's queue overflowed or stalled: the connection closes, naming that side. */
class QueueFault extends Error {
  constructor(readonly gateway: boolean, message: string) { super(message); }
}

/** A frame RFC 6455 forbids (a control frame too large or in fragments): the connection closes with 1002. */
export class ProtocolFault extends Error {}

/**
 * What waits to be sent to one side of a guest's connection (HB-0593). It
 * goes to the socket a piece at a time, the next once the socket has taken
 * the last (its write callback), so `taken` is called as the peer reads.
 * Not written straight to the socket: Node merges what waits there into one
 * write that reports nothing until all of it is out, so a slow phone loading
 * a long history looked stalled. A piece not taken within `stallMs` calls
 * `stalled`.
 */
class Outbox {
  readonly #queue = new Queue<{ bytes: Buffer; kind?: 'person' | 'answer' }>();
  #at = 0; // how much of the first message has been handed to the socket
  #waiting = 0; // bytes not yet taken, the piece being written among them
  #answers = 0; // bytes of answers made here not yet wholly taken
  #writing = false;
  #inFlight = 0; // bytes of the piece being written
  #inFlightAnswers = 0; // bytes of answers it finishes
  #shut = false;
  #timer: NodeJS.Timeout | undefined;
  constructor(
    readonly to: Duplex, readonly gateway: boolean, private readonly stallMs: number,
    private readonly stalled: () => void, private readonly taken: (person: boolean) => void,
  ) {}
  /** Bytes not yet taken by the socket. */
  get waiting(): number { return this.#waiting; }
  /** Bytes added as 'answer' (made here: refusals and the like) not yet taken. */
  get answers(): number { return this.#answers; }
  add(bytes: Buffer, kind?: 'person' | 'answer'): void {
    if (this.#shut || !bytes.length) return;
    this.#queue.push({ bytes, kind });
    this.#waiting += bytes.length;
    if (kind === 'answer') this.#answers += bytes.length;
    this.#pump();
  }
  /**
   * Stop. What waits is dropped, and `last` is written, unless a frame was
   * part written: nothing more is (after it, the rest of the stream could
   * not be read), and the connection's end ends it.
   */
  shut(last?: Buffer): void {
    if (this.#shut) return;
    this.#shut = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const partWritten = this.#at > 0;
    this.#queue.clear();
    this.#waiting = this.#answers = 0; // dropped: nothing waits here now
    if (!last || partWritten) return;
    try { this.to.write(last); } catch { /* gone */ }
  }
  /** Whether `bytes`, the last added, still waits with none of it handed to the socket. */
  unsent(bytes: Buffer): boolean {
    return this.#queue.last()?.bytes === bytes && !(this.#at > 0 && this.#queue.length === 1);
  }
  /**
   * Drop what waits, but for the rest of a frame part written (the stream
   * stays whole); the piece being written goes on.
   */
  dropWaiting(): void {
    const first = this.#at ? this.#queue.peek() : undefined;
    this.#queue.clear();
    if (first) this.#queue.push(first);
    this.#waiting = this.#inFlight + (first ? first.bytes.length - this.#at : 0);
    this.#answers = this.#inFlightAnswers + (first?.kind === 'answer' ? first.bytes.length : 0);
  }
  #pump(): void {
    if (this.#writing || this.#shut) return;
    if (!this.#queue.length) { clearTimeout(this.#timer); this.#timer = undefined; return; }
    // Small messages together, a large one in pieces.
    const parts: Buffer[] = [];
    let size = 0;
    let person = false; // bytes of a message the person sent are in this piece
    let answers = 0;
    while (this.#queue.length && size < WRITE_PIECE) {
      const msg = this.#queue.peek()!;
      const n = Math.min(msg.bytes.length - this.#at, WRITE_PIECE - size);
      parts.push(msg.bytes.subarray(this.#at, this.#at + n));
      size += n;
      this.#at += n;
      if (msg.kind === 'person') person = true;
      if (this.#at === msg.bytes.length) {
        if (msg.kind === 'answer') answers += msg.bytes.length;
        this.#queue.shift();
        this.#at = 0;
      }
    }
    this.#writing = true;
    this.#inFlight = size;
    this.#inFlightAnswers = answers;
    // Each piece has stallMs to be taken.
    if (this.#timer) this.#timer.refresh();
    else {
      this.#timer = setTimeout(() => { this.#timer = undefined; if (!this.#shut) this.stalled(); }, this.stallMs);
      this.#timer.unref?.();
    }
    this.to.write(parts.length === 1 ? parts[0]! : Buffer.concat(parts, size), (err) => {
      this.#writing = false;
      this.#inFlight = this.#inFlightAnswers = 0;
      if (err || this.#shut) { clearTimeout(this.#timer); this.#timer = undefined; return; }
      this.#waiting -= size;
      this.#answers -= answers;
      this.#pump();
      this.taken(person);
    });
  }
}
/**
 * Splice a guest's browser socket to the gateway, reading every message:
 * requests are judged (guestRequestVerdict) and refused ones answered here;
 * replies and events are scrubbed of other people (scrubForGuest). A protocol
 * error or an oversized message ends the connection.
 *
 * Backpressure (HB-0593): what is sent to each side waits in an Outbox.
 * The gateway is not read while the browser is behind (BEHIND). The browser
 * still is: its control frames go at once, a stop too when nothing is kept,
 * and its other requests are kept, in order, up to GUEST_KEEP_LIMIT, past
 * which it is not read until it catches up; nor while the gateway is
 * behind. The answers made here that wait for the browser are bounded on
 * their own (GUEST_REFUSAL_BUDGET).
 * A side that takes nothing for `stallMs`, or sends part of a message and
 * then none of it for `stallMs` (or all of it not within
 * MESSAGE_DEADLINE_MS), or a write that would leave more than
 * `maxQueued` bytes waiting, closes the connection: with 1011 and the gateway
 * named when it is the gateway's side, else 1008. So a slow or stalled peer
 * never grows this process without bound, nor holds its sockets open for
 * ever; and one guest's consoles together hold at most `maxGuestHeld`.
 */
export function spliceGuest(client: Duplex, upstream: Duplex, opts: GuestSpliceOptions): GuestSplice {
  const max = opts.maxMessage ?? 32 * 1024 * 1024;
  const maxQueued = opts.maxQueued ?? max + GUEST_QUEUE_SLACK;
  const stallMs = opts.stallMs ?? GUEST_STALL_MS;
  const maxGuestHeld = opts.maxGuestHeld ?? GUEST_HELD_LIMIT;
  const fromClient = new FrameReader(max);
  const fromGateway = new FrameReader(max);
  const clientMsgs = new MessageAssembler(max);
  const gatewayMsgs = new MessageAssembler(max);
  const pending = new GuestReplies();
  let closed = false;
  /** A piece of the message arriving was told to onActive as an upload (put back if it does not count once whole). */
  let uploadCounted = false;
  const outbox = (to: Duplex, gateway: boolean) => new Outbox(to, gateway, stallMs, () => {
    if (!closed) fail(new QueueFault(gateway, `took nothing it was sent for ${Math.round(stallMs / 1000)} s`), 'browser');
  }, (person) => {
    // The person is active while a message of theirs waits: each time the
    // gateway takes some of it ('waiting': not an upload's piece, so kept if
    // one arriving meanwhile is put back; GuestActivity).
    if (person && gateway && !closed) opts.onActive?.('waiting');
    flow();
  });
  const toBrowser = outbox(client, false);
  const toGateway = outbox(upstream, true);
  /** A request judged and let through, on its way to the gateway (forward). */
  type Asked = { raws: Buffer[]; size: number; id: string | number | undefined; method: string; mine: boolean; parsed?: unknown };
  /** The browser's requests read while it is behind, kept for the gateway in order (GUEST_KEEP_LIMIT). */
  const kept = new Queue<Asked>();
  let keptBytes = 0;
  /**
   * Whether a side is not read for now (flow): the gateway while the
   * browser is behind; the browser while the gateway is, or while what it
   * asked for is kept and has reached GUEST_KEEP_LIMIT.
   */
  const heldBack = (gateway: boolean) => gateway ? toBrowser.waiting > BEHIND : toGateway.waiting > BEHIND || keptBytes >= GUEST_KEEP_LIMIT;
  /** The browser's close came: what it asked and is kept is no longer wanted, and nothing it sends after is read. */
  let browserClosing = false;
  /** A close has gone to the gateway (the browser's): none more is sent, and its answer is not answered. */
  let closeToGateway = false;
  /** The browser's close, as it came, queued for the gateway. */
  let browserClose: Buffer | undefined;
  /** For a shut of the gateway's side once a close has gone: the browser's own, written now, if it was still waiting (shut drops it). */
  const closeLeft = () => (browserClose && toGateway.unsent(browserClose) ? browserClose : undefined);
  /**
   * The gateway's close, once it has closed: its close frame for the browser
   * (a code no endpoint may send, or none, becomes 1000), or null when its
   * connection ended without one (gatewayClosed).
   */
  let gatewayGone: Buffer | null | undefined;
  /**
   * A message begun must keep coming (HB-0594): a side that sends part of
   * one, then none of its bytes for stallMs (pings and pongs are not) while
   * it is read, is closed; and one not whole within MESSAGE_DEADLINE_MS of
   * its first bytes, however they come. So what the part holds is not kept
   * for ever. Only time the side is free to send counts: while it is not
   * read (heldBack) its stall waits and starts again when it is read again,
   * and its deadline stops and goes on (flow: paused, resumed).
   */
  const readWatch = (gateway: boolean, reader: FrameReader, msgs: MessageAssembler) => {
    const side = gateway ? 'gateway' : 'browser';
    let stall: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined; // while it runs
    let left: number | undefined; // what is left of the message's deadline; undefined: no message begun
    let since = 0; // when it last started running (performance.now())
    let seen = 0; // reader.dataRead at the last look
    let message = 0; // msgs.finished when the deadline was set: a message finished since is another's
    const begun = () => reader.buffered > 0 || msgs.begun;
    const armStall = () => {
      stall = setTimeout(() => {
        stall = undefined;
        if (closed || !begun()) return;
        if (heldBack(gateway)) armStall();
        else fail(new Error('stopped sending'), side);
      }, stallMs);
      stall.unref?.();
    };
    const run = () => {
      since = performance.now();
      deadline = setTimeout(() => {
        deadline = undefined;
        if (!closed && begun()) fail(new Error(`took over ${MESSAGE_DEADLINE_MS / 60_000} minutes to send one message`), side);
      }, left);
      deadline.unref?.();
    };
    const pause = () => {
      if (!deadline) return;
      clearTimeout(deadline);
      deadline = undefined;
      left = Math.max(0, left! - (performance.now() - since));
    };
    const stop = () => { clearTimeout(stall); stall = undefined; clearTimeout(deadline); deadline = undefined; left = undefined; };
    return {
      /** After each chunk: the message's own bytes restart its stall. */
      read() {
        if (closed) return;
        const now = reader.dataRead;
        const moved = now > seen;
        seen = now;
        if (!begun()) { stop(); return; }
        if (!stall) armStall(); else if (moved) stall.refresh();
        if (left !== undefined && message !== msgs.finished) { clearTimeout(deadline); deadline = undefined; left = undefined; }
        if (left === undefined) {
          message = msgs.finished;
          left = MESSAGE_DEADLINE_MS;
          if (!heldBack(gateway)) run();
        }
      },
      /** No longer read (held back): its deadline stops. */
      paused() { pause(); },
      /** Read again after being held back: stallMs from now, and the deadline goes on. */
      resumed() {
        if (closed) return;
        stall?.refresh();
        if (left !== undefined && !deadline) run();
      },
      stop,
    };
  };
  const readClient = readWatch(false, fromClient, clientMsgs);
  const readGateway = readWatch(true, fromGateway, gatewayMsgs);
  /** What this connection holds now (GuestSplice.held). */
  const held = () => closed ? 0 : fromClient.held + clientMsgs.held + fromGateway.held + gatewayMsgs.held + toBrowser.waiting + toGateway.waiting + keptBytes;
  let heldBefore = 0; // as last told (countHeld)
  /** Tell what it holds now; returns what the guest's consoles hold together. */
  const countHeld = (now: number): number => {
    const change = now - heldBefore;
    heldBefore = now;
    return opts.countHeld ? opts.countHeld(change) : now;
  };
  let expiry: NodeJS.Timeout | undefined;
  let draining: NodeJS.Timeout | undefined; // GUEST_DRAIN_MS, once the gateway has closed
  const stop = () => { clearTimeout(expiry); clearTimeout(draining); readClient.stop(); readGateway.stop(); countHeld(0); };
  /** Close both sides: the browser with `last` (by default a close frame of `code` and `reason`; null, none). */
  const end = (code: number, reason: string, last: Buffer | null = closeFrame(code, reason, false)) => {
    if (closed) return;
    closed = true;
    stop();
    toBrowser.shut(last ?? undefined);
    toGateway.shut(closeToGateway ? closeLeft() : closeFrame(code, reason, true));
    setTimeout(() => { client.destroy(); upstream.destroy(); }, 50).unref?.();
  };
  /** Close for an error: a queue's fault names its side; anything else is `side`'s. */
  const fail = (e: unknown, side: 'browser' | 'gateway') => {
    const gateway = e instanceof QueueFault ? e.gateway : side === 'gateway';
    end(e instanceof ProtocolFault ? 1002 : gateway ? 1011 : 1008, `${gateway ? 'gateway' : 'refused'}: ${(e as Error).message}`);
  };
  /**
   * Queue for a side, unless it would leave more waiting than a side may
   * hold. `kind`: 'person' for the guest's own message (not a ping, pong or
   * poll), 'answer' for one made here.
   */
  const send = (box: Outbox, bytes: Buffer, kind?: 'person' | 'answer') => {
    if (box.waiting + bytes.length > maxQueued) {
      throw new QueueFault(box.gateway, box.gateway ? 'too much waiting to be sent to the gateway' : 'too much waiting to be sent');
    }
    box.add(bytes, kind);
  };
  /** A message for the browser: the gateway's, scrubbed, or (`answer`) one made here, within GUEST_REFUSAL_BUDGET. */
  const toClient = (text: string, answer = false) => {
    if (browserClosing) return; // it has closed: only the gateway's close goes to it now
    const bytes = encodeFrame(0x1, Buffer.from(text, 'utf8'), false);
    if (answer && toBrowser.answers + bytes.length > GUEST_REFUSAL_BUDGET) throw new QueueFault(false, 'too many answers waiting to be sent');
    send(toBrowser, bytes, answer ? 'answer' : undefined);
  };
  /** Answer the guest's followed requests that have waited too long (GUEST_REPLY_WAIT_MS); their answers, if they come, are dropped. */
  const expire = () => {
    for (const w of pending.prune()) {
      // The agent's fault, not the guest's: not charged to GUEST_REFUSAL_BUDGET (at most MAX_GUEST_PENDING of them).
      toClient(guestError(w.id, 'UNAVAILABLE', `"${w.method}" got no answer: the agent took too long to answer.`));
    }
  };
  /** Look again when the oldest followed request is due. */
  const watchReplies = () => {
    if (expiry || closed) return;
    const due = pending.nextDue();
    if (due === undefined) return;
    expiry = setTimeout(() => {
      expiry = undefined;
      if (closed) return;
      try { expire(); } catch (e) { fail(e, 'browser'); }
      watchReplies();
      flow();
    }, due + 1);
    expiry.unref?.();
  };
  /**
   * Send on what was kept, in order, once the browser takes what it is sent
   * and the gateway what it is.
   */
  let releasing = false;
  const release = () => {
    if (releasing) return;
    releasing = true;
    try {
      while (kept.length && !closed && toBrowser.waiting <= BEHIND && toGateway.waiting <= BEHIND) {
        const a = kept.shift()!;
        keptBytes -= a.size;
        forward(a);
      }
    } finally {
      releasing = false;
    }
  };
  /**
   * Hold back the side that writes into one that is behind. While the
   * browser is behind, what it asks for is kept, not sent, so nothing new
   * loads the gateway while it is not taking replies (HB-0593 review); but
   * it is still read, so its pongs, its close and a stop get through (a stop
   * behind what is kept waits its turn), until what is kept reaches
   * GUEST_KEEP_LIMIT. Let them go once caught up. A browser that takes
   * nothing is closed by its Outbox's stall.
   */
  let gatewayHeldBack = false;
  let browserHeldBack = false;
  const flow = () => {
    if (closed) return;
    // The gateway has closed: once the browser has taken what waits, its
    // close follows (the browser's stall, and GUEST_DRAIN_MS, still end it).
    // Meanwhile what this holds is told as it goes down.
    if (gatewayGone !== undefined) {
      countHeld(held());
      if (!toBrowser.waiting) end(1000, '', gatewayGone);
      return;
    }
    try { release(); } catch (e) { fail(e, 'browser'); return; }
    // One guest's consoles together: the one whose bytes push them over is
    // closed. Not one holding alone: closing another would free nothing.
    const now = held();
    const grew = now > heldBefore;
    const together = countHeld(now);
    if (grew && together > maxGuestHeld && together > now) {
      end(1008, 'refused: your open chats hold too much at once; close one and reload');
      return;
    }
    const holdGateway = heldBack(true);
    const holdBrowser = heldBack(false);
    if (holdGateway) upstream.pause(); else upstream.resume();
    if (holdBrowser) client.pause(); else client.resume();
    // Held back, a message it had begun waits; read again, it has stallMs from now, not from its last bytes.
    if (!gatewayHeldBack && holdGateway) readGateway.paused();
    if (!browserHeldBack && holdBrowser) readClient.paused();
    if (gatewayHeldBack && !holdGateway) readGateway.resumed();
    if (browserHeldBack && !holdBrowser) readClient.resumed();
    gatewayHeldBack = holdGateway;
    browserHeldBack = holdBrowser;
  };

  /**
   * The gateway closed (gatewayGone). Nothing more is read from either
   * side; what waits for the browser is still sent, then its close (flow).
   */
  const gatewayClosed = (payload: Buffer | null) => {
    if (closed || gatewayGone !== undefined) return;
    const code = payload && payload.length >= 2 ? payload.readUInt16BE(0) : 0;
    const sendable = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
    gatewayGone = !payload ? null : sendable ? encodeFrame(0x8, payload, false) : closeFrame(1000, '', false);
    clearTimeout(expiry);
    readClient.stop();
    readGateway.stop();
    kept.clear(); keptBytes = 0; // nowhere to go now
    // Its close is answered at once, with the same code, as RFC 6455 asks;
    // unless it answered the browser's (written now if it still waited).
    toGateway.shut(closeToGateway ? closeLeft() : payload ? encodeFrame(0x8, sendable ? payload.subarray(0, 2) : NOTHING, true) : undefined);
    closeToGateway = true;
    // The browser is read again, if it was held back, so its leaving is seen; what it sends is dropped.
    client.resume();
    flow();
    // Still sending what waits: a browser taking it slowly, a piece within each stall, is not waited for longer than this.
    if (!closed) {
      draining = setTimeout(() => { if (!closed) kill(); }, GUEST_DRAIN_MS);
      draining.unref?.();
    }
  };
  /**
   * The guest's chat.send requests sent and not answered (their ids, each at
   * most MAX_GUEST_ID_LENGTH; at most MAX_GUEST_PENDING of them), and when
   * one went, or a chat or agent event for their own session came, last
   * (answering).
   */
  const unanswered = new Set<string | number>();
  /** Runs the gateway accepted for their chat.send or agent request (the ack's runId, each at most MAX_GUEST_ID_LENGTH), not ended: the id it was asked under, by runId. */
  const running = new Map<string, string | number>();
  let lastSent = -Infinity;
  let lastChat = -Infinity;
  const answering = (): boolean => {
    const now = performance.now();
    return now - lastChat < GUEST_IDLE_TO_CLOSE_MS || (unanswered.size + running.size > 0 && now - Math.max(lastSent, lastChat) < GUEST_ROOM_EVERY_MS);
  };
  /**
   * A reply under a chat.send or agent id of theirs ends it only when it is
   * that request's (it names a runId) or a refusal; another request of
   * theirs under the same id does not. A rewritten request's reply never
   * carries an id of theirs (GuestReplies: the proxy's own, unguessable, per
   * console). The ack (RUN_ACKS: the run started, accepted, or already
   * running) moves it to `running`, until the run's last chat event, or a
   * later reply under the same id with the run's result (agent's second).
   */
  const settleSend = (reply: { id?: unknown; ok?: unknown; payload?: unknown }) => {
    const id = reply.id;
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const p = reply.payload as { runId?: unknown; status?: unknown } | null | undefined;
    const runId = p && typeof p === 'object' && typeof p.runId === 'string' ? p.runId : undefined;
    const ack = reply.ok === true && typeof p?.status === 'string' && RUN_ACKS.has(p.status);
    if (runId !== undefined && !ack && running.get(runId) === id) { running.delete(runId); return; }
    if (!unanswered.has(id) || (reply.ok !== false && runId === undefined)) return;
    unanswered.delete(id);
    if (ack && runId!.length <= MAX_GUEST_ID_LENGTH && running.size < MAX_GUEST_PENDING) running.set(runId!, id);
  };
  /**
   * A chat or agent event for their own session, of a run this console
   * started (or while one it asked for is not acknowledged yet): they are
   * being answered here; a run's last chat event ends it. Another tab's run
   * on the same session does not keep this one from being idle.
   */
  const sessionEvent = (reply: { event?: unknown; payload?: unknown }) => {
    if (reply.event !== 'chat' && reply.event !== 'agent') return;
    const p = reply.payload as { sessionKey?: unknown; runId?: unknown; state?: unknown } | null | undefined;
    if (opts.scope?.sessionKey === undefined || !p || typeof p !== 'object' || p.sessionKey !== opts.scope.sessionKey) return;
    const runId = typeof p.runId === 'string' ? p.runId : undefined;
    if (!(runId !== undefined && running.has(runId)) && !unanswered.size) return;
    lastChat = performance.now();
    if (reply.event === 'chat' && (p.state === 'final' || p.state === 'error' || p.state === 'aborted') && runId !== undefined) running.delete(runId);
  };
  /** Send a judged request to the gateway: as it came, or (a reply rewritten) under an id of the proxy's own. */
  const forward = (a: Asked) => {
    if (RUN_METHODS.has(a.method) && a.id !== undefined && String(a.id).length <= MAX_GUEST_ID_LENGTH && unanswered.size < MAX_GUEST_PENDING) {
      unanswered.add(a.id);
      lastSent = performance.now();
    }
    if (!GUEST_REWRITTEN_REPLIES.has(a.method)) {
      // Every frame: a slow upload in many is the person while the gateway takes each.
      for (const raw of a.raws) send(toGateway, raw, a.mine ? 'person' : undefined);
      return;
    }
    // A reply that must be rewritten is followed by an id of the proxy's
    // own (GuestReplies). One that could not be followed would pass as it
    // came, other people's sessions and all: without an id to give back,
    // or past the cap. Such a request is answered here and never sent
    // (audit #009, HB-0592).
    const id = a.id;
    if (pending.size >= MAX_GUEST_PENDING) expire();
    const why = id === undefined ? 'it has no id'
      : String(id).length > MAX_GUEST_ID_LENGTH ? 'its id is too long'
        : pending.size >= MAX_GUEST_PENDING ? TOO_MANY_WAITING : undefined;
    if (why) {
      toClient(guestUntracked(id, a.method, why), true);
      return;
    }
    const ours = pending.track(id!, a.method);
    watchReplies();
    send(toGateway, encodeFrame(0x1, Buffer.from(JSON.stringify({ ...(a.parsed as object), id: ours }), 'utf8'), true));
  };
  client.on('data', (chunk: Buffer) => {
    if (closed || gatewayGone !== undefined) return;
    // The person is active when they send a message: one read whole, by its
    // method (not a ping, pong or close, a poll the console makes on its own,
    // or a request refused here), or each piece of a large one still
    // arriving (an upload, UPLOAD_SIZE or more; a small one is judged when
    // whole). An upload that does not count once whole (refused, or a poll)
    // puts back what its pieces marked (onUploadRefused).
    let person = false; // a message of theirs, whole
    let uploading = false; // a piece of an upload of theirs
    const putBack = () => { uploading = false; opts.onUploadRefused?.(); };
    try {
      for (const f of fromClient.push(chunk)) {
        if (!f.masked) throw new Error('unmasked client frame');
        if (browserClosing) continue;
        const item = clientMsgs.take(f);
        if (!item) { if (clientMsgs.size >= UPLOAD_SIZE) uploading = uploadCounted = true; continue; }
        if (item.control) {
          if (item.control.opcode === 0x8) {
            // The tab is closing: what is kept goes nowhere, nor what waits
            // for it (but the rest of a frame part written); its close goes
            // now, and the gateway's answer to it comes back as its own.
            browserClosing = true;
            closeToGateway = true;
            browserClose = item.control.raw;
            kept.clear(); keptBytes = 0;
            toBrowser.dropWaiting();
          }
          send(toGateway, item.control.raw);
          continue;
        }
        const counted = uploadCounted;
        uploadCounted = false;
        const msg = item.message!;
        if (msg.opcode !== 0x1) throw new Error('binary message');
        let parsed: unknown;
        try { parsed = JSON.parse(msg.data.toString('utf8')); } catch { throw new Error('not JSON'); }
        const v = guestRequestVerdict(parsed);
        if (!v.allow) {
          opts.onRefused?.(v.method);
          if (counted) putBack();
          toClient(guestRefusal(v.id, v.method), true);
          continue;
        }
        const method = v.method!;
        const mine = !CONSOLE_POLLS.has(method);
        person ||= mine;
        if (counted && !mine) putBack();
        const a: Asked = {
          raws: msg.raws, size: msg.raws.reduce((n, r) => n + r.length, 0), id: v.id, method, mine,
          ...(GUEST_REWRITTEN_REPLIES.has(method) ? { parsed } : {}),
        };
        // While the browser is behind, a request is kept, and while any is
        // kept, every one after it, in order; with none kept, a stop goes at once.
        if (!kept.length && (GUEST_CANCELS.has(method) || toBrowser.waiting <= BEHIND)) forward(a);
        else { kept.push(a); keptBytes += a.size; }
      }
      const partial = fromClient.partial;
      if (!browserClosing && partial && partial.opcode < 0x8 && clientMsgs.size + partial.length >= UPLOAD_SIZE) uploading = uploadCounted = true;
    } catch (e) {
      fail(e, 'browser');
    }
    if (!closed && (person || uploading)) opts.onActive?.(person ? undefined : 'upload');
    readClient.read();
    flow();
  });

  upstream.on('data', (chunk: Buffer) => {
    if (closed || gatewayGone !== undefined) return;
    let close: Buffer | undefined;
    try {
      for (const f of fromGateway.push(chunk)) {
        if (f.masked) throw new Error('masked server frame');
        const item = gatewayMsgs.take(f);
        if (!item) continue;
        // The browser has closed: only the gateway's close goes to it now.
        if (browserClosing && item.control?.opcode !== 0x8) continue;
        if (item.control) {
          if (item.control.opcode === 0x8) { close = item.control.payload; break; }
          send(toBrowser, item.control.raw);
          continue;
        }
        const msg = item.message!;
        // Only a JSON object is read and scrubbed, so only one reaches a
        // guest. Anything else (binary, text that is not JSON, an array — a
        // batch — or a bare value) is never passed on as it came; and as what
        // it answered cannot be told, a request (a chat.send) would wait for
        // ever: the chat is closed, and it is logged. Deliberate (HB-0592):
        // OpenClaw sends only JSON objects in text frames.
        let parsed: unknown;
        let readable = msg.opcode === 0x1;
        if (readable) { try { parsed = JSON.parse(msg.data.toString('utf8')); } catch { readable = false; } }
        if (!readable || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const what = msg.opcode !== 0x1 ? 'a binary message' : !readable ? 'a text message that is not JSON' : Array.isArray(parsed) ? 'a JSON array' : 'a JSON value that is not an object';
          opts.onScrubError?.(new Error(`the gateway sent ${what} (${msg.data.length} bytes); the guest's chat was closed`));
          end(1011, "Hatchabot could not read the agent's answer");
          return;
        }
        // One that cannot be scrubbed is Hatchabot's failure, not the
        // gateway's: it is dropped. A followed request it answers is answered
        // with an error, and the connection kept; a reply nothing here follows
        // (the hello, which the console waits for) closes the chat, which
        // would otherwise wait for ever.
        const reply = parsed as { type?: unknown; event?: unknown; id?: unknown; ok?: unknown; payload?: unknown };
        if (reply.type === 'res') settleSend(reply);
        const asked = pending.peek((parsed as { id?: unknown } | null)?.id);
        let text: string | undefined;
        try {
          const scrubbed = scrubForGuest(parsed, opts.identity, pending, opts.scope);
          if (scrubbed === GUEST_DROP) continue;
          if (reply.type === 'event') sessionEvent(reply);
          if (scrubbed !== undefined) text = JSON.stringify(scrubbed);
        } catch (e) {
          opts.onScrubError?.(e);
          if (asked) toClient(guestUnscrubbable(asked.id, asked.method));
          else if ((parsed as { type?: unknown } | null)?.type === 'res') { end(1011, 'Hatchabot could not prepare this chat'); return; }
          continue;
        }
        if (text !== undefined) toClient(text);
        else for (const raw of msg.raws) send(toBrowser, raw);
      }
    } catch (e) {
      fail(e, 'gateway');
    }
    if (close) { gatewayClosed(close); return; }
    readGateway.read();
    flow();
  });

  const kill = () => { closed = true; stop(); toBrowser.shut(); toGateway.shut(); client.destroy(); upstream.destroy(); };
  client.on('close', kill);
  client.on('error', kill);
  // The gateway gone without a close frame: what waits for the browser still goes first.
  upstream.on('close', () => gatewayClosed(null));
  upstream.on('error', () => gatewayClosed(null));
  return { held, close: end, answering };
}
