import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserPanels, channelFromChild, PANEL_CDP_METHODS, PANEL_MAX_OPS, PANEL_RELAY_SOURCE,
  panelAddress, panelCommands, panelSize, panelTransportOk, type BrowserPanelChannel, type PanelEvent,
} from '../src/orchestrator/browserPanel.js';
import { makeWorld, seedRunningAgent, as, type World } from './support/world.js';

// Made-up frames: "/9j/" is how every JPEG's base64 begins.
const FRAME = '/9j/4AAQSkZJRgABAQAAAQABAAD';

/** A relay as the panel sees it: what it was sent, and a way to answer or end it. */
function fakeChannel() {
  let onMessage: (m: Record<string, unknown>) => void = () => {};
  let onClose: (d: string) => void = () => {};
  const sent: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  const ch: BrowserPanelChannel & { sent: typeof sent; emit: (m: Record<string, unknown>) => void; end: (d?: string) => void; closed: boolean } = {
    sent, closed: false,
    send: (m) => { sent.push(m); },
    onMessage: (fn) => { onMessage = fn; },
    onClose: (fn) => { onClose = fn; },
    close: () => { if (!ch.closed) { ch.closed = true; onClose(''); } },
    emit: (m) => onMessage(m),
    end: (d = '') => { if (!ch.closed) { ch.closed = true; onClose(d); } },
  };
  return ch;
}
const size = { w: 1000, h: 700, mobile: false, dpr: 1 };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('what the page may send becomes commands from the fixed list', () => {
  it('each kind of input, as its commands', () => {
    const r = panelCommands([
      { k: 'mouse', type: 'down', x: 10, y: 20 },
      { k: 'wheel', x: 1, y: 2, dy: 300 },
      { k: 'key', key: 'Enter' },
      { k: 'key', key: 'Tab', mods: 8 },
      { k: 'text', text: 'made-up words' },
      { k: 'go', url: 'example.org/sign-in' },
      { k: 'back' }, { k: 'forward' }, { k: 'reload' },
      { k: 'size', w: 390, h: 760, mobile: true, dpr: 3 },
    ]);
    if ('error' in r) throw new Error(r.error);
    expect(r.commands).toEqual([
      { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1, modifiers: 0 } },
      { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 1, y: 2, deltaX: 0, deltaY: 300, modifiers: 0 } },
      // Enter carries its character, so a form is sent.
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 } },
      { method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 } },
      { method: 'Input.insertText', params: { text: 'made-up words' } },
      { method: 'Page.navigate', params: { url: 'https://example.org/sign-in' } },
      { history: -1 }, { history: 1 },
      { method: 'Page.reload', params: {} },
      // A phone's ratio is held to 2: sharp enough to read, half the bytes of 3.
      { resize: { w: 390, h: 760, mobile: true, dpr: 2 } },
    ]);
  });

  it('anything else refuses the whole post', () => {
    const bad: unknown[] = [
      { k: 'cdp', method: 'Runtime.evaluate', params: { expression: 'document.cookie' } },
      { k: 'go', url: 'javascript:alert(1)' },
      { k: 'go', url: 'file:///etc/passwd' },
      { k: 'go', url: 'chrome://settings' },
      { k: 'go', url: 'data:text/html,hello' },
      { k: 'go', url: 'https://someone:secret@example.org/' },
      { k: 'go', url: 'https://example.org/a b' },
      { k: 'key', key: 'a' }, { k: 'key', key: 'F12' }, { k: 'key', key: '__proto__' },
      { k: 'text', text: '' }, { k: 'text', text: 'x'.repeat(4001) },
      { k: 'mouse', type: 'down', x: -1, y: 5 }, { k: 'mouse', type: 'down', x: Number.NaN, y: 5 }, { k: 'mouse', type: 'drag', x: 1, y: 1 },
      { k: 'mouse', type: 'down', x: 1, y: 1, button: 'back' },
      { k: 'mouse', type: 'down', x: 1, y: 1, mods: 16 },
      { k: 'size', w: 10, h: 10 },
      null, 'text',
    ];
    for (const op of bad) expect(panelCommands([{ k: 'reload' }, op]), JSON.stringify(op)).toHaveProperty('error');
    expect(panelCommands('reload')).toHaveProperty('error');
    expect(panelCommands(Array.from({ length: PANEL_MAX_OPS + 1 }, () => ({ k: 'reload' })))).toHaveProperty('error');
  });

  it('the list reads nothing of the browser\'s: no scripts, cookies, storage, other tabs or screenshots', () => {
    for (const m of PANEL_CDP_METHODS) expect(m).toMatch(/^(Page|Input|Emulation)\./);
    expect(PANEL_CDP_METHODS).not.toContain('Page.captureScreenshot');
    expect(PANEL_CDP_METHODS.filter((m) => /cookie|storage|evaluate|script|target|close/i.test(m))).toEqual([]);
    // …and the relay holds the same list, apart from Hatchabot's own.
    expect(PANEL_RELAY_SOURCE).toContain(`new Set(${JSON.stringify(PANEL_CDP_METHODS)})`);
  });

  it('the relay is a module Node accepts', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'hb-relay-')), 'relay.mjs');
    writeFileSync(f, PANEL_RELAY_SOURCE);
    expect(() => execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' })).not.toThrow();
  });

  it('addresses: http and https only, https when none was typed', () => {
    expect(panelAddress('example.org')).toBe('https://example.org/');
    expect(panelAddress(' http://example.org/x?y=1 ')).toBe('http://example.org/x?y=1');
    expect(panelAddress('ftp://example.org/')).toBeUndefined();
    expect(panelAddress(42)).toBeUndefined();
    expect(panelAddress(`https://example.org/${'a'.repeat(2050)}`)).toBeUndefined();
  });

  it('sizes are clamped to what a panel may be', () => {
    expect(panelSize({ w: 3000, h: 900, dpr: 1.3 })).toEqual({ w: 1600, h: 900, mobile: false, dpr: 1.25 });
    expect(panelSize({ w: 390, h: 700, mobile: true, dpr: 0.5 })).toEqual({ w: 390, h: 700, mobile: true, dpr: 1 });
    expect(panelSize({ w: 100, h: 700 })).toBeUndefined();
    expect(panelSize(undefined)).toBeUndefined();
  });
});

describe('a panel: what goes to the browser, and what comes back to the page', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('opens with the screencast at its size, then the address asked for', () => {
    const ch = fakeChannel();
    new BrowserPanels().open('a1', 'o1', ch, { w: 390, h: 700, mobile: true, dpr: 2 }, 'https://example.org/');
    expect(ch.sent.map((m) => m.method)).toEqual(['Page.enable', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast', 'Page.navigate']);
    expect(ch.sent[1]!.params).toEqual({ width: 390, height: 700, deviceScaleFactor: 2, mobile: true });
    expect(ch.sent[2]!.params).toMatchObject({ format: 'jpeg', maxWidth: 780, maxHeight: 1400 });
    expect(new Set(ch.sent.map((m) => m.id)).size).toBe(ch.sent.length);
  });

  it('frames go one at a time and are acknowledged once the page has taken them; only JPEG', async () => {
    const ch = fakeChannel();
    const panels = new BrowserPanels();
    const id = panels.open('a1', 'o1', ch, size);
    const got: PanelEvent[] = [];
    let release!: () => void;
    const p = panels.get(id, 'a1', 'o1')!;
    p.attach((ev) => { got.push(ev); return ev.t === 'frame' && got.length === 1 ? new Promise<void>((r) => { release = r; }) : Promise.resolve(); });
    const acks = () => ch.sent.filter((m) => m.method === 'Page.screencastFrameAck').map((m) => m.params!.sessionId);
    ch.emit({ method: 'Page.screencastFrame', params: { data: FRAME, sessionId: 1, metadata: { deviceWidth: 1000, deviceHeight: 700 } } });
    expect(got).toEqual([{ t: 'frame', data: FRAME, w: 1000, h: 700 }]);
    expect(acks()).toEqual([]); // not until the page has it
    ch.emit({ method: 'Page.screencastFrame', params: { data: FRAME, sessionId: 2, metadata: {} } });
    ch.emit({ method: 'Page.screencastFrame', params: { data: `${FRAME}A`, sessionId: 3, metadata: {} } });
    expect(acks()).toEqual([2]); // dropped for the newer one, and acknowledged so the browser sends on
    release();
    await tick(); await tick();
    expect(got.map((e) => (e.t === 'frame' ? e.data : e.t))).toEqual([FRAME, `${FRAME}A`]);
    expect(acks()).toEqual([2, 1, 3]);
    // Not a JPEG: acknowledged, never shown.
    ch.emit({ method: 'Page.screencastFrame', params: { data: 'PHN2Zz48L3N2Zz4=', sessionId: 4, metadata: {} } });
    await tick();
    expect(got).toHaveLength(2);
    expect(acks()).toContain(4);
  });

  it('only the page\'s address and loading come back, for its main frame; the rest the tab says stays', () => {
    const ch = fakeChannel();
    const panels = new BrowserPanels();
    const p = panels.get(panels.open('a1', 'o1', ch, size), 'a1', 'o1')!;
    const got: PanelEvent[] = [];
    p.attach(async (ev) => { got.push(ev); });
    ch.emit({ method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://example.org/sign-in' } } });
    ch.emit({ method: 'Page.frameNavigated', params: { frame: { id: 'F2', parentId: 'F1', url: 'https://ads.example.net/' } } });
    ch.emit({ method: 'Page.navigatedWithinDocument', params: { frameId: 'F1', url: 'https://example.org/sign-in#step2' } });
    ch.emit({ method: 'Page.navigatedWithinDocument', params: { frameId: 'F2', url: 'https://ads.example.net/#x' } });
    ch.emit({ method: 'Page.frameStartedLoading', params: { frameId: 'F1' } });
    ch.emit({ method: 'Page.frameStoppedLoading', params: { frameId: 'F2' } });
    ch.emit({ method: 'Network.requestWillBeSent', params: { request: { url: 'https://example.org/', headers: { cookie: 'made-up' } } } });
    ch.emit({ method: 'Runtime.consoleAPICalled', params: { args: [] } });
    ch.emit({ relay: 'error', message: 'it lost its browser' });
    expect(got).toEqual([
      { t: 'url', url: 'https://example.org/sign-in' },
      { t: 'url', url: 'https://example.org/sign-in#step2' },
      { t: 'loading', on: true },
      { t: 'note', text: 'Its browser: it lost its browser.' },
    ]);
  });

  it('what came before the page\'s stream is sent when it attaches; a second stream ends the first', () => {
    const ch = fakeChannel();
    const panels = new BrowserPanels();
    const p = panels.get(panels.open('a1', 'o1', ch, size), 'a1', 'o1')!;
    ch.emit({ method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://example.org/' } } });
    const first: PanelEvent[] = [], second: PanelEvent[] = [];
    const s1 = async (ev: PanelEvent) => { first.push(ev); };
    p.attach(s1);
    expect(first).toEqual([{ t: 'url', url: 'https://example.org/' }]);
    p.attach(async (ev) => { second.push(ev); });
    expect(first.at(-1)).toMatchObject({ t: 'closed', why: expect.stringMatching(/another window/) });
    expect(p.detach(s1)).toBe(false); // not the one watching: the panel stays open
    expect(p.closed).toBe(false);
  });

  it('a page that does not open says why; the fence\'s refusal says a private address never opens', () => {
    const ch = fakeChannel();
    const panels = new BrowserPanels();
    const p = panels.get(panels.open('a1', 'o1', ch, size), 'a1', 'o1')!;
    const got: PanelEvent[] = [];
    p.attach(async (ev) => { got.push(ev); });
    for (const err of ['net::ERR_CONNECTION_REFUSED', 'net::ERR_NAME_NOT_RESOLVED']) {
      p.run([{ method: 'Page.navigate', params: { url: 'https://example.org/' } }]);
      ch.emit({ id: ch.sent.at(-1)!.id, result: { frameId: 'F1', errorText: err } });
    }
    expect(got.map((e) => (e.t === 'note' ? e.text : ''))).toEqual([
      'It did not open (net::ERR_CONNECTION_REFUSED). A private address (this machine, your network) never opens in the agent\'s browser.',
      'It did not open (net::ERR_NAME_NOT_RESOLVED).',
    ]);
  });

  it('back and forward: the history is asked, then its entry opened; nothing past either end', () => {
    const ch = fakeChannel();
    const panels = new BrowserPanels();
    const p = panels.get(panels.open('a1', 'o1', ch, size), 'a1', 'o1')!;
    const history = { currentIndex: 1, entries: [{ id: 7 }, { id: 8 }, { id: 9 }] };
    p.run([{ history: -1 }]);
    ch.emit({ id: ch.sent.at(-1)!.id, result: history });
    expect(ch.sent.at(-1)).toMatchObject({ method: 'Page.navigateToHistoryEntry', params: { entryId: 7 } });
    p.run([{ history: 1 }]);
    ch.emit({ id: ch.sent.at(-1)!.id, result: history });
    expect(ch.sent.at(-1)).toMatchObject({ method: 'Page.navigateToHistoryEntry', params: { entryId: 9 } });
    const n = ch.sent.length;
    p.run([{ history: -1 }]);
    ch.emit({ id: ch.sent.at(-1)!.id, result: { currentIndex: 0, entries: [{ id: 7 }] } });
    expect(ch.sent.length).toBe(n + 1); // only the history was asked
  });

  it('a new size restarts the screencast at it', () => {
    const ch = fakeChannel();
    const panels = new BrowserPanels();
    const p = panels.get(panels.open('a1', 'o1', ch, size), 'a1', 'o1')!;
    const n = ch.sent.length;
    p.run([{ resize: { w: 390, h: 700, mobile: true, dpr: 2 } }]);
    expect(ch.sent.slice(n).map((m) => m.method)).toEqual(['Page.stopScreencast', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast']);
  });

  it('closes after ten minutes with no input; input keeps it open', () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const ch = fakeChannel();
    const panels = new BrowserPanels({ log: (_a, e, d) => logs.push(`${e} ${JSON.stringify(d)}`) });
    const p = panels.get(panels.open('a1', 'o1', ch, size), 'a1', 'o1')!;
    const got: PanelEvent[] = [];
    p.attach(async (ev) => { got.push(ev); });
    vi.advanceTimersByTime(9 * 60_000);
    p.touch();
    vi.advanceTimersByTime(9 * 60_000);
    expect(p.closed).toBe(false);
    vi.advanceTimersByTime(60_001);
    expect(p.closed).toBe(true);
    expect(ch.closed).toBe(true); // the relay is ended, so it closes its tab
    expect(got.at(-1)).toMatchObject({ t: 'closed', why: expect.stringMatching(/ten minutes/) });
    expect(panels.size).toBe(0);
    expect(logs).toEqual(['browser.panel_opened {}', 'browser.panel_closed {"why":"idle"}']);
  });

  it('one per agent: opening another closes the first; the relay ending closes it; only its person and agent reach it', () => {
    const panels = new BrowserPanels();
    const c1 = fakeChannel(), c2 = fakeChannel();
    const id1 = panels.open('a1', 'o1', c1, size);
    const id2 = panels.open('a1', 'o1', c2, size);
    expect(c1.closed).toBe(true);
    expect(panels.get(id1, 'a1', 'o1')).toBeUndefined();
    expect(panels.get(id2, 'a1', 'o2')).toBeUndefined();
    expect(panels.get(id2, 'a2', 'o1')).toBeUndefined();
    const p = panels.get(id2, 'a1', 'o1')!;
    const got: PanelEvent[] = [];
    p.attach(async (ev) => { got.push(ev); });
    c2.end('Error response from daemon: container is not running');
    expect(got.at(-1)).toEqual({ t: 'closed', why: 'The browser closed: the agent stopped, restarted or was rebuilt.' });
    expect(panels.size).toBe(0);
  });
});

describe('the relay\'s process as a channel', () => {
  afterEach(() => { vi.useRealTimers(); });
  function fakeChild() {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    return child;
  }
  it('lines in pieces are put together; what is not JSON is skipped; it ends once, with what it said', async () => {
    const child = fakeChild();
    const ch = channelFromChild(child as never);
    const got: unknown[] = [], ends: string[] = [];
    ch.onMessage((m) => got.push(m));
    ch.onClose((d) => ends.push(d));
    child.stdout.write('{"relay":"rea');
    child.stdout.write('dy"}\nnot json\n[1]\n{"id":1,"result":{}}\n');
    child.stderr.write('Error response from daemon: made-up\n');
    await tick();
    expect(got).toEqual([{ relay: 'ready' }, { id: 1, result: {} }]);
    let wrote = '';
    child.stdin.on('data', (d) => { wrote += d; });
    ch.send({ id: 2, method: 'Page.reload', params: {} });
    await tick();
    expect(wrote).toBe('{"id":2,"method":"Page.reload","params":{}}\n');
    child.emit('close', 1);
    child.emit('close', 1);
    expect(ends).toEqual(['Error response from daemon: made-up']);
  });
  it('closing ends its stdin, and kills it if it has not ended in a few seconds', () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const ch = channelFromChild(child as never);
    ch.close();
    expect(child.stdin.writableEnded).toBe(true);
    vi.advanceTimersByTime(3001);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('a connection fit to type a password on', () => {
  const req = (ip: string, headers: Record<string, string> = {}) => ({ ip, headers });
  it('https, this machine, or a device on the tailnet directly', () => {
    expect(panelTransportOk(req('192.168.1.20'), true, false)).toBe(true);
    expect(panelTransportOk(req('127.0.0.1'), false, true)).toBe(true);
    expect(panelTransportOk(req('100.101.102.103'), false, false)).toBe(true);
    expect(panelTransportOk(req('::ffff:100.64.0.9'), false, false)).toBe(true);
    expect(panelTransportOk(req('fd7a:115c:a1e0::12'), false, false)).toBe(true);
  });
  it('not plain http on the LAN, nor through a proxy that does not say https', () => {
    expect(panelTransportOk(req('192.168.1.20'), false, false)).toBe(false);
    expect(panelTransportOk(req('100.128.0.1'), false, false)).toBe(false);
    expect(panelTransportOk(req('10.0.0.5'), false, false)).toBe(false);
    expect(panelTransportOk(req('100.101.102.103', { 'x-forwarded-for': '192.168.1.20' }), false, false)).toBe(false);
  });
});

describe('the routes', () => {
  async function ready(): Promise<{ w: World; relay: () => World['provider']['panelRelays'][number] }> {
    const w = await makeWorld();
    await seedRunningAgent(w);
    (w.store as unknown as { db: Database.Database }).db.prepare(`UPDATE agents SET browser = 1 WHERE id = 'a1'`).run();
    w.provider.browsers.set('a1', true);
    return { w, relay: () => w.provider.panelRelays.at(-1)! };
  }
  const open = (w: World, extra: Record<string, unknown> = {}, opts: { headers?: Record<string, string>; remoteAddress?: string } = {}) =>
    w.f.inject({ method: 'POST', url: '/v1/agents/a1/browser/panel', headers: { ...as(), ...(opts.headers ?? {}) }, payload: { w: 1000, h: 700, ...extra }, ...(opts.remoteAddress ? { remoteAddress: opts.remoteAddress } : {}) });

  it('opens a relay in the agent\'s container, at the address asked for; input becomes its commands; close ends it', async () => {
    const { w, relay } = await ready();
    const r = await open(w, { url: 'example.org' });
    expect(r.statusCode).toBe(201);
    const { panel } = r.json() as { panel: string };
    expect(relay().agentContainer).toBe('a1');
    expect(relay().sent.at(-1)).toMatchObject({ method: 'Page.navigate', params: { url: 'https://example.org/' } });
    const input = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/browser/panel/${panel}/input`, headers: as(), payload: { ops: [{ k: 'text', text: 'made-up name' }, { k: 'key', key: 'Enter' }] } });
    expect(input.statusCode).toBe(204);
    expect(relay().sent.slice(-3).map((m) => m.method)).toEqual(['Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
    const bad = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/browser/panel/${panel}/input`, headers: as(), payload: { ops: [{ k: 'cdp', method: 'Network.getAllCookies' }] } });
    expect(bad.statusCode).toBe(400);
    expect(relay().sent.some((m) => !(PANEL_CDP_METHODS as readonly string[]).includes(m.method))).toBe(false);
    expect((await w.f.inject({ method: 'DELETE', url: `/v1/agents/a1/browser/panel/${panel}`, headers: as() })).statusCode).toBe(204);
    expect(relay().closed).toBe(true);
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/a1/browser/panel/${panel}/input`, headers: as(), payload: { ops: [] } })).statusCode).toBe(404);
    // On its timeline: opened and closed, nothing typed.
    const events = w.store.listEvents(['a1'], 50).map((e) => `${e.event} ${JSON.stringify(e.detail)}`).filter((e) => e.startsWith('browser.panel'));
    expect(events.sort()).toEqual(['browser.panel_closed {"why":"person"}', 'browser.panel_opened {}']);
  });

  it('the stream: frames and the address as server-sent events, and the end when the panel closes', async () => {
    const { w, relay } = await ready();
    const { panel } = (await open(w)).json() as { panel: string };
    const stream = w.f.inject({ method: 'GET', url: `/v1/agents/a1/browser/panel/${panel}/stream`, headers: as() });
    await new Promise((r) => setTimeout(r, 30));
    relay().emit({ method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://example.org/' } } });
    relay().emit({ method: 'Page.screencastFrame', params: { data: FRAME, sessionId: 5, metadata: { deviceWidth: 1000, deviceHeight: 700 } } });
    relay().emit({ method: 'Network.responseReceived', params: { response: { headers: { 'set-cookie': 'made-up' } } } });
    await new Promise((r) => setTimeout(r, 30));
    await w.f.inject({ method: 'DELETE', url: `/v1/agents/a1/browser/panel/${panel}`, headers: as() });
    const res = await stream;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['content-encoding']).toBeUndefined();
    const events = res.payload.split('\n\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
    expect(events).toEqual([
      { t: 'url', url: 'https://example.org/' },
      { t: 'frame', data: FRAME, w: 1000, h: 700 },
      { t: 'closed', why: 'Closed.' },
    ]);
    expect(relay().sent.some((m) => m.method === 'Page.screencastFrameAck' && m.params?.sessionId === 5)).toBe(true);
    expect(res.payload).not.toContain('made-up');
  });

  it('the agent\'s owner only: not another person, not for an agent without a running browser, not the manager', async () => {
    const { w } = await ready();
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/browser/panel', headers: as('someone-else'), payload: { w: 1000, h: 700 } })).statusCode).toBe(404);
    const { panel } = (await open(w)).json() as { panel: string };
    for (const [method, url] of [['GET', 'stream'], ['POST', 'input']] as const) {
      expect((await w.f.inject({ method, url: `/v1/agents/a1/browser/panel/${panel}/${url}`, headers: as('someone-else'), ...(method === 'POST' ? { payload: { ops: [] } } : {}) })).statusCode).toBe(404);
    }
    w.provider.browsers.delete('a1');
    expect((await open(w)).json().error).toMatch(/not running yet/);
    w.provider.browsers.set('a1', true);
    const db = (w.store as unknown as { db: Database.Database }).db;
    db.prepare(`UPDATE agents SET state = 'STOPPED' WHERE id = 'a1'`).run();
    expect((await open(w)).json().error).toMatch(/not running/);
    db.prepare(`UPDATE agents SET state = 'RUNNING', browser = 0 WHERE id = 'a1'`).run();
    expect((await open(w)).json().error).toMatch(/browser is off/);
    db.prepare(`UPDATE agents SET browser = 1, ops = 1 WHERE id = 'a1'`).run();
    expect((await open(w)).statusCode).toBe(409);
  });

  it('over an encrypted connection only: refused over plain http from the LAN, opened over the tailnet or https', async () => {
    const { w } = await ready();
    const lan = await open(w, {}, { remoteAddress: '192.168.1.20' });
    expect(lan.statusCode).toBe(403);
    expect(lan.json().error).toMatch(/encrypted connection/);
    expect((await open(w, {}, { remoteAddress: '100.101.102.103' })).statusCode).toBe(201);
    expect((await open(w, {}, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '192.168.1.20' } })).statusCode).toBe(201);
    // A panel opened over https takes no input over plain http.
    const { panel } = (await open(w)).json() as { panel: string };
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/a1/browser/panel/${panel}/input`, headers: as(), payload: { ops: [] }, remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
  });

  it('a size and an address it can use, or it says so', async () => {
    const { w } = await ready();
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/browser/panel', headers: as(), payload: {} })).statusCode).toBe(400);
    const bad = await open(w, { url: 'javascript:alert(1)' });
    expect(bad.statusCode).toBe(400);
    expect(w.provider.panelRelays).toHaveLength(0);
  });
});
