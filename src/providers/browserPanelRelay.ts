/**
 * The relay behind "Sign in to a site" (HB-0680): the Node program a provider
 * runs with `docker exec -i` in the agent's container, which passes a fixed
 * list of DevTools commands between its stdin and stdout and a tab of the
 * agent's browser, and the channel a provider makes of that process. What the
 * page may send, and the panels themselves, are orchestrator/console/browserPanel.ts.
 */
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
export type PanelMethod = (typeof PANEL_CDP_METHODS)[number];

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
let tab, ws, connecting;
let open = false, ended = false;
const startup = new AbortController();
const queue = [];
const finish = async (code = 0) => {
  if (ended) return; ended = true;
  startup.abort(); clearTimeout(connecting);
  // Arm before contacting DevTools: an unresponsive browser must not leave
  // this exec alive after the host's Docker CLI has been killed (3 seconds).
  const deadline = setTimeout(() => process.exit(code), 2000);
  try { ws?.close(); } catch {}
  try { if (tab?.id) await fetch(CDP + '/json/close/' + tab.id, { signal: AbortSignal.timeout(1500) }); } catch {}
  clearTimeout(deadline);
  out({ relay: 'closed' });
  setTimeout(() => process.exit(code), 100);
};
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (ended) return;
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
// Watch shutdown before the first await: closing a panel while DevTools is
// starting must abort its request instead of leaving a detached exec behind.
try {
  tab = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.any([startup.signal, AbortSignal.timeout(5000)]) })).json();
  if (!ended) {
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    connecting = setTimeout(() => { out({ relay: 'error', message: 'its browser did not answer' }); void finish(4); }, 5000);
    ws.onopen = () => { if (ended) return; clearTimeout(connecting); open = true; out({ relay: 'ready' }); for (const q of queue.splice(0)) ws.send(q); };
    ws.onmessage = (m) => { if (!ended && typeof m.data === 'string') { try { process.stdout.write(m.data + '\\n'); } catch {} } };
    ws.onclose = () => { void finish(); };
    ws.onerror = () => { out({ relay: 'error', message: 'it lost its browser' }); void finish(4); };
  }
} catch (e) {
  if (!ended) { out({ relay: 'error', message: 'its browser did not answer' }); void finish(4); }
}
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
