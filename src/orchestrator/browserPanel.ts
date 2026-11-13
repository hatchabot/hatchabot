/**
 * "Sign in to a site" (HB-0680; docs/browser-logins-design.md, section 1):
 * the owner sees the agent's browser in the app and clicks and types in it,
 * to sign it in to a site, type a two-step code, or get past a cookie banner
 * or a CAPTCHA the agent is stuck on.
 *
 *   the app's page ⇄ Hatchabot (a stream of frames down, input posts up)
 *                  ⇄ `docker exec -i <agent container>`: the relay below, in Node
 *                  ⇄ the browser's DevTools port, 127.0.0.1:9222, in the agent's network
 *
 * The relay opens a tab of its own and passes DevTools commands between its
 * stdin and stdout and that tab. It goes through the Docker connection
 * Hatchabot already has to the agent's machine, so a runner works the same
 * way, and nothing new is opened: the port stays inside the agent's network.
 *
 * The page never sends DevTools commands. It sends a few kinds of input
 * (`panelCommands`), which Hatchabot turns into commands from a fixed list
 * (PANEL_CDP_METHODS); the relay refuses anything else as well. Nothing on
 * the list reads cookies or storage or runs a script, so even a fault in the
 * app's page cannot read the browser's sign-ins through the panel. What
 * comes back is filtered the same way: frames, the address, loading.
 *
 * What the owner types is not stored or logged. A panel closes after ten
 * minutes with no input; opening another for the same agent closes the first.
 */
import { randomBytes } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** The DevTools commands a panel may send: the screencast, input, addresses. Nothing that reads the browser's data. */
export const PANEL_CDP_METHODS = [
  'Page.enable',
  'Page.navigate',
  'Page.reload',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.screencastFrameAck',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Emulation.setDeviceMetricsOverride',
] as const;
type PanelMethod = (typeof PANEL_CDP_METHODS)[number];

/** A panel with no input for this long closes (design: ten minutes). */
export const PANEL_IDLE_MS = 10 * 60_000;
/** The longest line taken from the relay: a frame at 1,600 × 1,600 twice over is well under it. */
const MAX_RELAY_LINE = 8 * 1024 * 1024;

/**
 * The relay, run with `node --input-type=module -e` in the agent's container
 * (its runtime image has Node 22+, whose WebSocket it uses). Newline-delimited
 * JSON both ways; `{relay: …}` lines are its own. It ends, closing its tab,
 * when its stdin ends or the tab's connection closes.
 */
export const PANEL_RELAY_SOURCE = `
const CDP = 'http://127.0.0.1:9222';
const ALLOW = new Set(${JSON.stringify(PANEL_CDP_METHODS)});
const out = (o) => { try { process.stdout.write(JSON.stringify(o) + '\\n'); } catch {} };
if (typeof WebSocket !== 'function') { out({ relay: 'error', message: 'this agent runs an image too old for the panel: rebuild it on a current one' }); process.exit(3); }
let tab;
try { tab = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json(); }
catch (e) { out({ relay: 'error', message: 'its browser did not answer' }); process.exit(4); }
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let open = false, ended = false;
const queue = [];
const finish = async () => {
  if (ended) return; ended = true;
  try { ws.close(); } catch {}
  try { await fetch(CDP + '/json/close/' + tab.id); } catch {}
  out({ relay: 'closed' });
  setTimeout(() => process.exit(0), 100);
};
ws.onopen = () => { open = true; out({ relay: 'ready' }); for (const q of queue.splice(0)) ws.send(q); };
ws.onmessage = (m) => { if (typeof m.data === 'string') { try { process.stdout.write(m.data + '\\n'); } catch {} } };
ws.onclose = () => { void finish(); };
ws.onerror = () => { out({ relay: 'error', message: 'it lost its browser' }); };
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (!msg || typeof msg.id !== 'number' || !ALLOW.has(msg.method)) { out({ id: msg && msg.id, error: { message: 'refused' } }); continue; }
    const s = JSON.stringify({ id: msg.id, method: msg.method, params: msg.params || {} });
    if (open) ws.send(s); else queue.push(s);
  }
  if (buf.length > 1048576) buf = '';
});
process.stdin.on('end', () => { void finish(); });
process.stdout.on('error', () => { void finish(); });
`;

/** The relay as a provider runs it: one per open panel, in the agent's container. */
export interface BrowserPanelChannel {
  /** One command to the relay (a line on its stdin). */
  send(msg: { id: number; method: PanelMethod; params?: Record<string, unknown> }): void;
  /** Each line the relay writes, parsed: its tab's replies and events, and its own `{relay}` lines. */
  onMessage(fn: (m: Record<string, unknown>) => void): void;
  /** Once, when the relay has ended (its tab closed, the browser or the agent gone); `detail` is what it said last. */
  onClose(fn: (detail: string) => void): void;
  /** End it: its stdin is closed, so it closes its tab and exits; killed if it has not within a few seconds. */
  close(): void;
}

/** A relay's child process (`docker exec -i … node -e PANEL_RELAY_SOURCE`) as a channel. */
export function channelFromChild(child: Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'kill' | 'on'>): BrowserPanelChannel {
  let onMessage: (m: Record<string, unknown>) => void = () => {};
  let onClose: (detail: string) => void = () => {};
  let closed = false, said = '', buf = '';
  const ended = (detail: string) => { if (closed) return; closed = true; onClose(detail); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m: unknown;
      try { m = JSON.parse(line); } catch { continue; }
      if (m && typeof m === 'object' && !Array.isArray(m)) onMessage(m as Record<string, unknown>);
    }
    // A line this long is not one the panel wants: dropped, not held.
    if (buf.length > MAX_RELAY_LINE) buf = '';
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d: string) => { said = (said + d).slice(-400); });
  child.stdin.on('error', () => {});
  child.on('error', (err: Error) => ended(`could not start it: ${err.message}`));
  child.on('close', () => ended(said.trim()));
  return {
    send: (msg) => { if (!closed) child.stdin.write(`${JSON.stringify(msg)}\n`); },
    onMessage: (fn) => { onMessage = fn; },
    onClose: (fn) => { onClose = fn; },
    close: () => {
      try { child.stdin.end(); } catch { /* already gone */ }
      setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 3000).unref();
    },
  };
}

// ---- what the page may send ---------------------------------------------------

/** The panel's size: CSS pixels of the page in it, and the screen's pixel ratio (1–2). */
export interface PanelSize { w: number; h: number; mobile: boolean; dpr: number }

const SPECIAL_KEYS: Record<string, number> = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};
const MOUSE_TYPES: Record<string, string> = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' };
const BUTTONS = new Set(['left', 'middle', 'right', 'none']);
/** The most a page may send in one post, and the most text in one piece. */
export const PANEL_MAX_OPS = 200;
export const PANEL_MAX_TEXT = 4000;

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

/** The page's size, clamped to what a panel may be. */
export function panelSize(v: unknown): PanelSize | undefined {
  const o = (v ?? {}) as Record<string, unknown>;
  const w = num(o.w, 200, 4000), h = num(o.h, 200, 4000);
  if (w === undefined || h === undefined) return undefined;
  const dpr = num(o.dpr, 0.5, 8) ?? 1;
  return { w: Math.round(Math.min(w, 1600)), h: Math.round(Math.min(h, 1600)), mobile: o.mobile === true, dpr: Math.min(2, Math.max(1, Math.round(dpr * 4) / 4)) };
}

/**
 * An address typed in the panel's box, as the browser is asked to open it:
 * http or https only (never file:, javascript:, data: or the browser's own
 * pages), https added when no scheme was typed. Private addresses are the
 * fence's to refuse (HB-0679), as for the agent.
 */
export function panelAddress(typed: unknown): string | undefined {
  if (typeof typed !== 'string') return undefined;
  let t = typed.trim();
  if (!t || t.length > 2048 || /\s/.test(t)) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) t = `https://${t}`;
  let u: URL;
  try { u = new URL(t); } catch { return undefined; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (!u.hostname || u.username || u.password) return undefined;
  return u.href;
}

/** One kind of input the page sends, as the commands it becomes; a navigation step needs the history first. */
export type PanelCommand =
  | { method: PanelMethod; params: Record<string, unknown> }
  | { history: -1 | 1 }
  | { resize: PanelSize };

/**
 * The page's input, as commands from the panel's list. Each op is one of:
 * `{k:'mouse', type:'move'|'down'|'up', x, y, button?, clicks?, mods?}`,
 * `{k:'wheel', x, y, dx, dy}`, `{k:'key', key, mods?}` (a key from a short
 * list: Enter, Backspace, Tab, the arrows…), `{k:'text', text}`,
 * `{k:'go', url}`, `{k:'back'}`, `{k:'forward'}`, `{k:'reload'}`,
 * `{k:'size', w, h, mobile, dpr}`. Anything else refuses the whole post.
 */
export function panelCommands(ops: unknown): { commands: PanelCommand[] } | { error: string } {
  if (!Array.isArray(ops) || ops.length > PANEL_MAX_OPS) return { error: `Send a list of at most ${PANEL_MAX_OPS} inputs.` };
  const commands: PanelCommand[] = [];
  for (const raw of ops) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const mods = num(o.mods ?? 0, 0, 15);
    if (mods === undefined || !Number.isInteger(mods)) return { error: 'An input has modifiers that are not 0–15.' };
    switch (o.k) {
      case 'mouse': {
        const type = MOUSE_TYPES[String(o.type)];
        const x = num(o.x, 0, 4000), y = num(o.y, 0, 4000);
        const button = o.button === undefined ? (o.type === 'move' ? 'none' : 'left') : String(o.button);
        const clicks = num(o.clicks ?? (o.type === 'move' ? 0 : 1), 0, 3);
        if (!type || x === undefined || y === undefined || !BUTTONS.has(button) || clicks === undefined) return { error: 'A mouse input is not one the panel takes.' };
        commands.push({ method: 'Input.dispatchMouseEvent', params: { type, x, y, button, clickCount: Math.round(clicks), modifiers: mods } });
        break;
      }
      case 'wheel': {
        const x = num(o.x, 0, 4000), y = num(o.y, 0, 4000), dx = num(o.dx ?? 0, -10000, 10000), dy = num(o.dy ?? 0, -10000, 10000);
        if (x === undefined || y === undefined || dx === undefined || dy === undefined) return { error: 'A scroll input is not one the panel takes.' };
        commands.push({ method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, modifiers: mods } });
        break;
      }
      case 'key': {
        const key = typeof o.key === 'string' ? o.key : '';
        const vk = Object.hasOwn(SPECIAL_KEYS, key) ? SPECIAL_KEYS[key] : undefined;
        if (vk === undefined) return { error: 'A key is not one the panel takes: type text as text.' };
        const base = { key, code: key, windowsVirtualKeyCode: vk, modifiers: mods };
        // Enter carries its character, as a real key does, so a form is sent.
        commands.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) } });
        commands.push({ method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', ...base } });
        break;
      }
      case 'text': {
        if (typeof o.text !== 'string' || !o.text || o.text.length > PANEL_MAX_TEXT) return { error: `Text is sent in pieces of at most ${PANEL_MAX_TEXT} characters.` };
        commands.push({ method: 'Input.insertText', params: { text: o.text } });
        break;
      }
      case 'go': {
        const url = panelAddress(o.url);
        if (!url) return { error: 'That is not a web address (http or https) the panel can open.' };
        commands.push({ method: 'Page.navigate', params: { url } });
        break;
      }
      case 'back': commands.push({ history: -1 }); break;
      case 'forward': commands.push({ history: 1 }); break;
      case 'reload': commands.push({ method: 'Page.reload', params: {} }); break;
      case 'size': {
        const size = panelSize(o);
        if (!size) return { error: 'A size is not one the panel takes.' };
        commands.push({ resize: size });
        break;
      }
      default: return { error: 'An input is not one the panel takes.' };
    }
  }
  return { commands };
}

// ---- the open panels ----------------------------------------------------------

/** What the page is sent, in order. */
export type PanelEvent =
  | { t: 'frame'; data: string; w: number; h: number }
  | { t: 'url'; url: string }
  | { t: 'loading'; on: boolean }
  | { t: 'note'; text: string }
  | { t: 'closed'; why: string };

/** Where a panel's events go: the page's stream. Resolves once it has taken the event (a frame is acknowledged then). */
export type PanelSink = (ev: PanelEvent) => Promise<void>;

const JPEG_BASE64 = /^\/9j\/[A-Za-z0-9+/]*={0,2}$/;
const CLOSED_WHY = {
  idle: 'Closed after ten minutes with nothing clicked or typed. Open it again to carry on: the browser keeps the page.',
  replaced: 'Opened again in another window, so this one closed.',
  person: 'Closed.',
  gone: 'The browser closed: the agent stopped, restarted or was rebuilt.',
  shutdown: 'Hatchabot is restarting.',
} as const;
export type PanelCloseReason = keyof typeof CLOSED_WHY;

class Panel {
  readonly id = randomBytes(16).toString('base64url');
  #next = 1;
  #pending = new Map<number, (m: Record<string, unknown>) => void>();
  #mainFrame: string | undefined;
  #sink: PanelSink | undefined;
  /** Events before the page's stream is there (the address, a note); frames are held one at a time below. */
  #early: PanelEvent[] = [];
  #frame: { data: string; w: number; h: number; sessionId: number } | undefined;
  #pumping = false;
  #idle: NodeJS.Timeout | undefined;
  #size: PanelSize;
  closed = false;

  constructor(
    readonly agentId: string,
    readonly ownerId: string,
    readonly channel: BrowserPanelChannel,
    size: PanelSize,
    readonly idleMs: number,
    readonly onClosed: (p: Panel, why: PanelCloseReason, detail?: string) => void,
  ) {
    this.#size = size;
    channel.onMessage((m) => this.#fromRelay(m));
    channel.onClose((detail) => this.close('gone', detail));
    this.#send('Page.enable', {});
    this.#screencast(size);
    this.touch();
  }

  /** Input arrived: the idle clock starts again. */
  touch(): void {
    if (this.closed) return;
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.close('idle'), this.idleMs);
    this.#idle.unref();
  }

  run(commands: PanelCommand[]): void {
    for (const c of commands) {
      if ('resize' in c) { this.#send('Page.stopScreencast', {}); this.#screencast(c.resize); }
      else if ('history' in c) {
        const step = c.history;
        this.#send('Page.getNavigationHistory', {}, (m) => {
          const r = m.result as { currentIndex?: number; entries?: Array<{ id?: number }> } | undefined;
          const to = r?.entries?.[(r.currentIndex ?? -2) + step]?.id;
          if (typeof to === 'number') this.#send('Page.navigateToHistoryEntry', { entryId: to });
        });
      } else if (c.method === 'Page.navigate') {
        this.#send(c.method, c.params, (m) => {
          const err = (m.result as { errorText?: string } | undefined)?.errorText;
          // The fence refuses a private address the way a closed port does (REJECT).
          const fenced = /CONNECTION_REFUSED|ADDRESS_UNREACHABLE/.test(err ?? '') ? ' A private address (this machine, your network) never opens in the agent\'s browser.' : '';
          if (typeof err === 'string' && err) this.#emit({ t: 'note', text: `It did not open (${err.slice(0, 80)}).${fenced}` });
        });
      } else this.#send(c.method, c.params);
    }
  }

  /** The page's stream: what was waiting goes first, then the latest frame. A second stream replaces the first. */
  attach(sink: PanelSink): void {
    // The stream it replaces ends: one page at a time watches a panel.
    if (this.#sink && this.#sink !== sink) void this.#sink({ t: 'closed', why: CLOSED_WHY.replaced }).catch(() => {});
    this.#sink = sink;
    for (const ev of this.#early.splice(0)) void sink(ev).catch(() => {});
    this.#pump();
  }
  /** The stream `sink` ended; true when it was the one watching (so the panel is no longer watched). */
  detach(sink: PanelSink): boolean {
    if (this.#sink !== sink) return false;
    this.#sink = undefined;
    return true;
  }

  close(why: PanelCloseReason, detail?: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.#idle);
    this.channel.close();
    // What Docker said goes to the log only; the relay's own words reached the page as a note.
    const ev: PanelEvent = { t: 'closed', why: CLOSED_WHY[why] };
    if (this.#sink) void this.#sink(ev).catch(() => {}); else this.#early.push(ev);
    this.onClosed(this, why, detail);
  }

  #screencast(size: PanelSize): void {
    this.#size = size;
    this.#send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: size.dpr, mobile: size.mobile });
    this.#send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: Math.round(size.w * size.dpr), maxHeight: Math.round(size.h * size.dpr), everyNthFrame: 1 });
  }

  #send(method: PanelMethod, params: Record<string, unknown>, then?: (m: Record<string, unknown>) => void): void {
    if (this.closed) return;
    const id = this.#next++;
    if (then) this.#pending.set(id, then);
    this.channel.send({ id, method, params });
  }

  #emit(ev: PanelEvent): void {
    if (this.closed) return;
    if (this.#sink) void this.#sink(ev).catch(() => {});
    else { this.#early.push(ev); if (this.#early.length > 20) this.#early.shift(); }
  }

  /** Only these come back to the page: its frames, its address, whether it is loading. */
  #fromRelay(m: Record<string, unknown>): void {
    if (typeof m.relay === 'string') {
      if (m.relay === 'error' && typeof m.message === 'string') this.#emit({ t: 'note', text: `Its browser: ${m.message.slice(0, 160)}.` });
      return;
    }
    if (typeof m.id === 'number') {
      const then = this.#pending.get(m.id);
      this.#pending.delete(m.id);
      then?.(m);
      return;
    }
    const p = (m.params ?? {}) as Record<string, unknown>;
    switch (m.method) {
      case 'Page.screencastFrame': {
        const meta = (p.metadata ?? {}) as Record<string, unknown>;
        const sessionId = typeof p.sessionId === 'number' ? p.sessionId : undefined;
        if (sessionId === undefined) return;
        const data = typeof p.data === 'string' && JPEG_BASE64.test(p.data) ? p.data : undefined;
        if (!data) { this.#send('Page.screencastFrameAck', { sessionId }); return; }
        // The latest frame only: one the page has not taken yet is dropped, and acknowledged so the browser sends on.
        if (this.#frame) this.#send('Page.screencastFrameAck', { sessionId: this.#frame.sessionId });
        this.#frame = { data, w: num(meta.deviceWidth, 1, 8000) ?? this.#size.w, h: num(meta.deviceHeight, 1, 8000) ?? this.#size.h, sessionId };
        this.#pump();
        return;
      }
      case 'Page.frameNavigated': {
        const f = (p.frame ?? {}) as Record<string, unknown>;
        if (f.parentId || typeof f.id !== 'string' || typeof f.url !== 'string') return;
        this.#mainFrame = f.id;
        this.#emit({ t: 'url', url: f.url.slice(0, 2048) });
        return;
      }
      case 'Page.navigatedWithinDocument':
        if (p.frameId === this.#mainFrame && typeof p.url === 'string') this.#emit({ t: 'url', url: p.url.slice(0, 2048) });
        return;
      case 'Page.frameStartedLoading':
      case 'Page.frameStoppedLoading':
        if (p.frameId === this.#mainFrame) this.#emit({ t: 'loading', on: m.method === 'Page.frameStartedLoading' });
        return;
      default:
        return; // everything else the tab says stays here
    }
  }

  /** One frame at a time: sent, taken by the stream, then acknowledged so the browser sends the next. */
  #pump(): void {
    if (this.#pumping || !this.#sink || !this.#frame || this.closed) return;
    this.#pumping = true;
    const f = this.#frame;
    this.#frame = undefined;
    const sink = this.#sink;
    void sink({ t: 'frame', data: f.data, w: f.w, h: f.h }).catch(() => {}).finally(() => {
      this.#send('Page.screencastFrameAck', { sessionId: f.sessionId });
      this.#pumping = false;
      this.#pump();
    });
  }
}

/** Every open panel of this Hatchabot: at most one per agent. */
export class BrowserPanels {
  #byId = new Map<string, Panel>();
  #byAgent = new Map<string, Panel>();
  constructor(private readonly opts: { idleMs?: number; log?: (agentId: string, event: string, detail: Record<string, unknown>) => void } = {}) {}

  /** A new panel for `agentId`, its relay already started; one already open for that agent is closed. */
  open(agentId: string, ownerId: string, channel: BrowserPanelChannel, size: PanelSize, url?: string): string {
    this.#byAgent.get(agentId)?.close('replaced');
    const p = new Panel(agentId, ownerId, channel, size, this.opts.idleMs ?? PANEL_IDLE_MS, (gone, why, detail) => {
      this.#byId.delete(gone.id);
      if (this.#byAgent.get(gone.agentId) === gone) this.#byAgent.delete(gone.agentId);
      this.opts.log?.(gone.agentId, 'browser.panel_closed', { why, ...(why === 'gone' && detail ? { detail: detail.slice(0, 200) } : {}) });
    });
    this.#byId.set(p.id, p);
    this.#byAgent.set(agentId, p);
    if (url) p.run([{ method: 'Page.navigate', params: { url } }]);
    this.opts.log?.(agentId, 'browser.panel_opened', {});
    return p.id;
  }

  /** The panel `id`, if it is open, for that agent and that person. */
  get(id: string, agentId: string, ownerId: string): Panel | undefined {
    const p = this.#byId.get(id);
    return p && !p.closed && p.agentId === agentId && p.ownerId === ownerId ? p : undefined;
  }

  /** Close the panel of `agentId`, if one is open (the agent stopped, was archived or deleted). */
  closeAgent(agentId: string, why: PanelCloseReason = 'gone'): void { this.#byAgent.get(agentId)?.close(why); }

  closeAll(why: PanelCloseReason = 'shutdown'): void { for (const p of [...this.#byId.values()]) p.close(why); }

  /** How many are open (for tests and the doctor). */
  get size(): number { return this.#byId.size; }
}

/**
 * Whether what is typed in a panel reaches Hatchabot encrypted: HTTPS (or the
 * public address, which is HTTPS), this machine itself, or a device on the
 * tailnet talking to it directly (WireGuard). Anything that came through
 * another proxy is judged by the proxy's word only (requestIsHttps).
 */
export function panelTransportOk(req: { ip?: string; headers: Record<string, string | string[] | undefined> }, https: boolean, onThisMachine: boolean): boolean {
  if (https || onThisMachine) return true;
  const h = req.headers;
  if (h['x-forwarded-for'] || h['forwarded'] || h['x-forwarded-host'] || h['x-forwarded-proto']) return false;
  const ip = (req.ip ?? '').replace(/^::ffff:/, '');
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(ip);
}
