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
  const m = method.toUpperCase();
  const p = path.split('?')[0]!.replace(/\/{2,}/g, '/');
  if (p.split('/').some((seg) => seg === '..' || seg === '.' || /%2e|%2f|%5c/i.test(seg))) return false;
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

export interface GuestVerdict { allow: boolean; id?: string; method?: string; reason?: string }

/** Judge one client→gateway message from a guest. */
export function guestRequestVerdict(msg: unknown): GuestVerdict {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { allow: false, reason: 'not a request' };
  const m = msg as { type?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? String(m.id) : undefined;
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

/** What a refused guest request is answered with. */
export function guestRefusal(id: string | undefined, method: string | undefined): string {
  return JSON.stringify({
    type: 'res', id: id ?? null, ok: false,
    error: { code: 'FORBIDDEN', message: `${method ? `"${method}" is` : 'That is'} not available to guests of this agent — its owner has the full console.` },
  });
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

/** Replies the proxy rewrites for a guest, by the method asked: their request ids are remembered on the way out. */
export const GUEST_REWRITTEN_REPLIES: ReadonlySet<string> = new Set(['health', 'agents.list']);

/**
 * A gateway→guest message, with other people taken out: the hello's presence
 * and health snapshot, presence and health events, and a health reply — and
 * an agents.list reply told the guest's truth (guestAgentsList). `pending`
 * maps a guest's request ids to the method asked (GUEST_REWRITTEN_REPLIES).
 * Returns undefined when nothing needed changing (the bytes pass as they came).
 */
export function scrubForGuest(msg: unknown, identity: string, pending: Map<string, string>, scope: GuestScope = {}): unknown | undefined {
  if (!msg || typeof msg !== 'object') return undefined;
  const f = msg as { type?: string; event?: string; id?: string; ok?: boolean; payload?: any };
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
    const asked = f.id !== undefined ? pending.get(String(f.id)) : undefined;
    if (asked) {
      pending.delete(String(f.id));
      if (asked === 'health') return { ...f, payload: scrubHealth(f.payload) };
      if (asked === 'agents.list') return { ...f, payload: guestAgentsList(f.payload, scope) };
    }
    return undefined;
  }
  // A refused reply: nothing to rewrite, nothing left to remember.
  if (f.type === 'res' && f.id !== undefined) pending.delete(String(f.id));
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

export interface WsFrame { fin: boolean; rsv: number; opcode: number; masked: boolean; payload: Buffer; raw: Buffer }

/** Reads frames out of a byte stream. Throws on a protocol error or a frame over the cap. */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);
  constructor(private readonly maxPayload: number) {}
  push(chunk: Buffer): WsFrame[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: WsFrame[] = [];
    for (;;) {
      const b = this.#buf;
      if (b.length < 2) break;
      const fin = (b[0]! & 0x80) !== 0;
      const rsv = (b[0]! >> 4) & 0x07;
      const opcode = b[0]! & 0x0f;
      const masked = (b[1]! & 0x80) !== 0;
      let len = b[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) throw new Error('frame too large');
        len = Number(big); off = 10;
      }
      if (len > this.maxPayload) throw new Error('frame too large');
      const maskAt = off;
      if (masked) off += 4;
      if (b.length < off + len) break;
      let payload = b.subarray(off, off + len);
      if (masked) {
        const key = b.subarray(maskAt, maskAt + 4);
        const p = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) p[i] = payload[i]! ^ key[i & 3]!;
        payload = p;
      } else {
        payload = Buffer.from(payload);
      }
      out.push({ fin, rsv, opcode, masked, payload, raw: Buffer.from(b.subarray(0, off + len)) });
      this.#buf = b.subarray(off + len);
    }
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

/** Assembles data frames into messages; control frames come out on their own. */
class MessageAssembler {
  #frames: WsFrame[] = [];
  #size = 0;
  constructor(private readonly maxMessage: number) {}
  /** Complete items in order: a control frame, or a whole message (its frames and joined payload). */
  take(f: WsFrame): { control?: WsFrame; message?: { opcode: number; frames: WsFrame[]; data: Buffer } } | undefined {
    if (f.rsv !== 0) throw new Error('unexpected extension bits');
    if (f.opcode >= 0x8) return { control: f };
    if (f.opcode !== 0 && this.#frames.length) throw new Error('interleaved message');
    if (f.opcode === 0 && !this.#frames.length) throw new Error('continuation without a start');
    this.#frames.push(f);
    this.#size += f.payload.length;
    if (this.#size > this.maxMessage) throw new Error('message too large');
    if (!f.fin) return undefined;
    const frames = this.#frames;
    this.#frames = []; this.#size = 0;
    return { message: { opcode: frames[0]!.opcode, frames, data: Buffer.concat(frames.map((x) => x.payload)) } };
  }
}

export interface GuestSpliceOptions {
  identity: string;
  /** Their agent and conversation: what agents.list and the hello's session defaults are told (guestAgentsList). */
  scope?: GuestScope;
  /** Largest message either way (chat attachments ride inside chat.send). */
  maxMessage?: number;
  /** Told of each refused method, for the activity trail. */
  onRefused?: (method: string | undefined) => void;
}

/**
 * Splice a guest's browser socket to the gateway, reading every message:
 * requests are judged (guestRequestVerdict) and refused ones answered here;
 * replies and events are scrubbed of other people (scrubForGuest). A protocol
 * error or an oversized message ends the connection.
 */
export function spliceGuest(client: Duplex, upstream: Duplex, opts: GuestSpliceOptions): void {
  const max = opts.maxMessage ?? 32 * 1024 * 1024;
  const fromClient = new FrameReader(max);
  const fromGateway = new FrameReader(max);
  const clientMsgs = new MessageAssembler(max);
  const gatewayMsgs = new MessageAssembler(max);
  const pending = new Map<string, string>();
  let closed = false;
  const end = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    try { client.write(closeFrame(code, reason, false)); } catch { /* gone */ }
    try { upstream.write(closeFrame(code, reason, true)); } catch { /* gone */ }
    setTimeout(() => { client.destroy(); upstream.destroy(); }, 50).unref?.();
  };

  client.on('data', (chunk: Buffer) => {
    if (closed) return;
    try {
      for (const f of fromClient.push(chunk)) {
        if (!f.masked) throw new Error('unmasked client frame');
        const item = clientMsgs.take(f);
        if (!item) continue;
        if (item.control) { upstream.write(item.control.raw); continue; }
        const msg = item.message!;
        if (msg.opcode !== 0x1) throw new Error('binary message');
        let parsed: unknown;
        try { parsed = JSON.parse(msg.data.toString('utf8')); } catch { throw new Error('not JSON'); }
        const v = guestRequestVerdict(parsed);
        if (!v.allow) {
          opts.onRefused?.(v.method);
          client.write(encodeFrame(0x1, Buffer.from(guestRefusal(v.id, v.method), 'utf8'), false));
          continue;
        }
        if (v.method && GUEST_REWRITTEN_REPLIES.has(v.method) && v.id !== undefined && pending.size < 1000) pending.set(v.id, v.method);
        for (const fr of msg.frames) upstream.write(fr.raw);
      }
    } catch (e) {
      end(1008, `refused: ${(e as Error).message}`);
    }
  });

  upstream.on('data', (chunk: Buffer) => {
    if (closed) return;
    try {
      for (const f of fromGateway.push(chunk)) {
        if (f.masked) throw new Error('masked server frame');
        const item = gatewayMsgs.take(f);
        if (!item) continue;
        if (item.control) { client.write(item.control.raw); continue; }
        const msg = item.message!;
        if (msg.opcode === 0x1) {
          let scrubbed: unknown;
          try { scrubbed = scrubForGuest(JSON.parse(msg.data.toString('utf8')), opts.identity, pending, opts.scope); } catch { scrubbed = undefined; }
          if (scrubbed !== undefined) { client.write(encodeFrame(0x1, Buffer.from(JSON.stringify(scrubbed), 'utf8'), false)); continue; }
        }
        for (const fr of msg.frames) client.write(fr.raw);
      }
    } catch (e) {
      end(1011, `gateway: ${(e as Error).message}`);
    }
  });

  const kill = () => { closed = true; client.destroy(); upstream.destroy(); };
  client.on('close', kill);
  upstream.on('close', kill);
  client.on('error', kill);
  upstream.on('error', kill);
}
