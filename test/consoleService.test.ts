import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Host } from '../src/domain/types.js';
import { createConsoles, type Consoles, type ConsolesDeps } from '../src/orchestrator/console/consoles.js';
import type { ConsoleSocket } from '../src/orchestrator/console/consoleSockets.js';
import type { PanelAccess } from '../src/orchestrator/console/signInPanels.js';
import type { BrowserPanelChannel } from '../src/providers/browserPanelRelay.js';

/**
 * The console and the browser panel (HB-0808): who may reach an agent's
 * console, what ends a console request, handshake or open socket, the
 * sign-in panels' access, and the three sweeps, driven as the routes drive
 * them but with no HTTP server. The store is a small stand-in over made-up
 * agents (it answers only what the service asks); the sign-in in use, the
 * public gate and a browser's session are functions the test sets. Made-up
 * data only.
 */
const OWNER = 'user-owner';
const GUEST = 'user-guest';
const STRANGER = 'user-stranger';
/** A gateway's token, made at run time (no token-shaped literal in the source). */
const gatewayToken = ['gw', 'made', 'up'].join('-');

interface World {
  agents: Map<string, Agent>;
  hosts: Map<string, Host>;
  /** userId → the agents they may web chat with. */
  webChat: Map<string, Set<string>>;
  /** Cookie header → who it signs in as. */
  sessions: Map<string, string>;
  /** Set to false for "no sign-in reads a cookie" (route fixtures with no auth). */
  cookieSignIn: boolean;
  /** The public gate's refusal for an open connection, or undefined to let it be; null for no gate at all. */
  gateSays: string | undefined | null;
  woken: string[];
  warned: Array<{ event: string; detail: Record<string, unknown> }>;
  traced: Array<{ agentId: string | undefined; event: string }>;
  sitesNoted: string[];
  svc: Consoles;
}

function world(o: Partial<Pick<ConsolesDeps, 'browserSweepEveryMs'>> & { failSweep?: boolean } = {}): World {
  const w = {
    agents: new Map(), hosts: new Map(), webChat: new Map(), sessions: new Map(),
    cookieSignIn: true, gateSays: undefined, woken: [], warned: [], traced: [], sitesNoted: [],
  } as unknown as World;
  w.hosts.set('h1', { id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as Host);
  w.hosts.set('h2', { id: 'h2', ownerId: OWNER, kind: 'remote', provider: 'mock', name: 'Laptop runner', settings: {}, createdAt: 'now' } as never);
  const store = {
    getAgent: (id: string) => w.agents.get(id),
    getHost: (id: string) => w.hosts.get(id),
    webChatAllowed: (agentId: string, userId: string) => {
      const a = w.agents.get(agentId);
      if (!a || a.state === 'DELETED') return false;
      return a.ownerId === userId || !!w.webChat.get(userId)?.has(agentId);
    },
    noteAgentBrowserSite: (_id: string, _logins: string, site: string) => { w.sitesNoted.push(site); },
    localHostId: () => { if (o.failSweep) throw new Error('the database is gone'); return 'h1'; },
    listRunnerHostIds: () => [],
    listAgents: () => [...w.agents.values()],
  };
  const local = { gatewayEndpoint: undefined, containerIp: async () => '10.9.8.7' };
  const runner = { gatewayEndpoint: (port: number) => ({ host: '127.0.0.1', port: port + 1000 }) };
  w.svc = createConsoles({
    store: store as never,
    providerFor: (hostId) => (hostId === 'h2' ? runner : local) as never,
    trace: (agentId) => (event) => { w.traced.push({ agentId, event }); },
    ensureAwake: async (a, why) => {
      w.woken.push(`${a.id}: ${why}`);
      const up = { ...a, state: 'RUNNING' as const, hibernatedAt: undefined };
      w.agents.set(a.id, up);
      return up;
    },
    cookieSignIn: () => w.cookieSignIn,
    signedInAs: (cookie) => {
      const who = cookie === undefined ? undefined : w.sessions.get(cookie);
      return who ? { ownerId: who } : undefined;
    },
    publicGate: () => (w.gateSays === null ? undefined : { refuseOpenSocket: () => w.gateSays as string | undefined }),
    sessionOf: (cookie) => cookie?.replace(/^s=/, ''),
    warn: (detail, event) => { w.warned.push({ event, detail }); },
    browserSweepEveryMs: o.browserSweepEveryMs ?? 0,
  });
  return w;
}

const live: World[] = [];
afterEach(() => { for (const w of live.splice(0)) { w.svc.stop(); w.svc.panels.panels.closeAll(); } vi.useRealTimers(); });
function made(o?: Parameters<typeof world>[0]): World { const w = world(o); live.push(w); return w; }

function agent(w: World, id: string, o: Partial<Agent> = {}): Agent {
  const a = {
    id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now',
    runtimeRef: `mock://${id}`, gatewayPort: 18800, gatewayToken, ...o,
  } as Agent;
  w.agents.set(id, a);
  return a;
}
const change = (w: World, id: string, o: Partial<Agent>) => { w.agents.set(id, { ...w.agents.get(id)!, ...o }); };

/** An open console socket as the upgrade handler remembers it. */
function socket(w: World, o: Partial<ConsoleSocket> & { agentId: string }): ConsoleSocket & { closed: boolean } {
  const s = {
    ownerId: OWNER, role: 'owner' as const, cookie: 's=owner-1', https: true, public: false, lastActive: Date.now(), closed: false,
    ...o,
    close: () => { s.closed = true; },
  };
  w.svc.gateway.addSocket(s);
  return s;
}

describe('who may reach a console', () => {
  it('the owner as owner, a web-chat guest as guest, and nobody else', () => {
    const w = made();
    agent(w, 'a1');
    w.webChat.set(GUEST, new Set(['a1']));
    const { consoleCaller } = w.svc.gateway;
    expect(consoleCaller(OWNER, 'a1')?.role).toBe('owner');
    expect(consoleCaller(GUEST, 'a1')?.role).toBe('guest');
    expect(consoleCaller(STRANGER, 'a1')).toBeUndefined();
    expect(consoleCaller(OWNER, 'nope')).toBeUndefined();
  });

  it('never the management agent\'s guest, nor a guest of an agent with no gateway token', () => {
    const w = made();
    agent(w, 'ops', { ops: true });
    agent(w, 'old', { gatewayToken: undefined });
    w.webChat.set(GUEST, new Set(['ops', 'old']));
    const { consoleCaller } = w.svc.gateway;
    expect(consoleCaller(GUEST, 'ops')).toBeUndefined();
    expect(consoleCaller(GUEST, 'old')).toBeUndefined();
    // Its owner still may.
    expect(consoleCaller(OWNER, 'ops')?.role).toBe('owner');
  });

  it('nobody, owner included, once the agent is being deleted or is deleted', () => {
    const w = made();
    agent(w, 'a1', { state: 'DELETING' });
    agent(w, 'a2', { state: 'DELETED' });
    expect(w.svc.gateway.consoleCaller(OWNER, 'a1')).toBeUndefined();
    expect(w.svc.gateway.consoleCaller(OWNER, 'a2')).toBeUndefined();
  });

  it('a wait does not carry an earlier right or an earlier runtime on', () => {
    const w = made();
    const a = agent(w, 'a1');
    w.webChat.set(GUEST, new Set(['a1']));
    const { consoleContext, consoleStillCurrent } = w.svc.gateway;
    const context = consoleContext(a);
    const guest = { agent: a, role: 'guest' as const };
    expect(consoleStillCurrent(GUEST, guest, context)).toBe(true);
    // The owner took web chat away during the wait.
    w.webChat.get(GUEST)!.delete('a1');
    expect(consoleStillCurrent(GUEST, guest, context)).toBe(false);
    // The owner, after a rebuild gave it a new runtime.
    const owner = { agent: a, role: 'owner' as const };
    expect(consoleStillCurrent(OWNER, owner, context)).toBe(true);
    change(w, 'a1', { runtimeRef: 'mock://a1-new' });
    expect(consoleStillCurrent(OWNER, owner, context)).toBe(false);
    // Stopped.
    change(w, 'a1', { runtimeRef: 'mock://a1', state: 'STOPPED' });
    expect(consoleStillCurrent(OWNER, owner, context)).toBe(false);
  });
});

describe('where a gateway answers', () => {
  it('this machine\'s port, a runner\'s tunnel, an old management agent by its address, and nothing for one not running', async () => {
    const w = made();
    const a = agent(w, 'a1');
    const r = agent(w, 'r1', { hostId: 'h2', gatewayPort: 18801 });
    const ops = agent(w, 'ops', { ops: true, gatewayPort: undefined });
    const off = agent(w, 'off', { state: 'STOPPED' });
    const { gatewayAddr } = w.svc.gateway;
    expect(await gatewayAddr(a)).toEqual({ host: '127.0.0.1', port: 18800 });
    expect(await gatewayAddr(r)).toEqual({ host: '127.0.0.1', port: 19801 });
    expect(await gatewayAddr(ops)).toEqual({ host: '10.9.8.7', port: 18789 });
    expect(await gatewayAddr(off)).toBeUndefined();
    expect(w.woken).toEqual([]);
  });

  it('opening a sleeping agent\'s console wakes it first', async () => {
    const w = made();
    const asleep = agent(w, 'a1', { state: 'STOPPED', hibernatedAt: 'earlier' });
    const t = await w.svc.gateway.consoleTarget(asleep);
    expect(w.woken[0]).toBe('a1: its console was opened');
    expect(t).toEqual({ agent: expect.objectContaining({ id: 'a1', state: 'RUNNING' }), addr: { host: '127.0.0.1', port: 18800 } });
  });
});

describe('a console request or handshake under way', () => {
  it('ends when its browser signs out, and only for that session', () => {
    const w = made();
    const mine = w.svc.gateway.pendingSession('owner-1');
    const other = w.svc.gateway.pendingSession('owner-2');
    expect(mine.revoked()).toBe(false);
    w.svc.gateway.signedOut('owner-1');
    expect(mine.revoked()).toBe(true);
    expect(other.revoked()).toBe(false);
  });

  it('one that has answered is forgotten: a later sign-out has nothing to end', () => {
    const w = made();
    const p = w.svc.gateway.pendingSession('owner-1');
    p.done();
    w.svc.gateway.signedOut('owner-1');
    expect(p.revoked()).toBe(false);
  });
});

describe('an open console socket is judged again by what let it in', () => {
  it('signing out closes that browser\'s sockets and no others', () => {
    const w = made();
    agent(w, 'a1');
    const mine = socket(w, { agentId: 'a1', cookie: 's=owner-1' });
    const other = socket(w, { agentId: 'a1', cookie: 's=owner-2' });
    w.svc.gateway.signedOut('owner-1');
    expect(mine.closed).toBe(true);
    expect(other.closed).toBe(false);
    expect(w.svc.gateway.socketCount()).toBe(1);
  });

  it('a session that no longer signs in its person is closed, with the reason in the log and the timeline', () => {
    const w = made();
    agent(w, 'a1');
    w.sessions.set('s=owner-1', OWNER);
    const s = socket(w, { agentId: 'a1' });
    expect(w.svc.gateway.revalidateConsoleSockets()).toBe(0);
    w.sessions.delete('s=owner-1');
    expect(w.svc.gateway.revalidateConsoleSockets()).toBe(1);
    expect(s.closed).toBe(true);
    expect(w.warned).toEqual([{ event: 'console.socket_closed', detail: expect.objectContaining({ agent: 'a1', why: 'signed out' }) }]);
    expect(w.traced).toContainEqual({ agentId: 'a1', event: 'console.socket_closed' });
  });

  it('a guest whose web chat was taken away is closed; the owner\'s socket stays', () => {
    const w = made();
    agent(w, 'a1');
    w.webChat.set(GUEST, new Set(['a1']));
    w.sessions.set('s=guest-1', GUEST).set('s=owner-1', OWNER);
    const g = socket(w, { agentId: 'a1', ownerId: GUEST, role: 'guest', cookie: 's=guest-1' });
    const o = socket(w, { agentId: 'a1' });
    w.webChat.get(GUEST)!.delete('a1');
    expect(w.svc.gateway.revalidateConsoleSockets()).toBe(1);
    expect(g.closed).toBe(true);
    expect(o.closed).toBe(false);
    expect(w.warned[0]!.detail.why).toBe('no longer allowed on this agent');
  });

  it('at the public address the gate\'s word counts, and with no gate it is closed', () => {
    const w = made();
    agent(w, 'a1');
    w.sessions.set('s=owner-1', OWNER);
    const pub = socket(w, { agentId: 'a1', public: true });
    const priv = socket(w, { agentId: 'a1' });
    expect(w.svc.gateway.revalidateConsoleSockets()).toBe(0);
    w.gateSays = 'idle';
    expect(w.svc.gateway.revalidateConsoleSockets()).toBe(1);
    expect(pub.closed).toBe(true);
    expect(priv.closed).toBe(false);
    const pub2 = socket(w, { agentId: 'a1', public: true });
    w.gateSays = null;
    w.svc.gateway.revalidateConsoleSockets();
    expect(pub2.closed).toBe(true);
    expect(w.warned.map((x) => x.detail.why)).toEqual(['idle', 'no public gate']);
  });

  it('a runtime that changed under it closes it, and one that cannot be judged is closed, not kept', () => {
    const w = made();
    agent(w, 'a1');
    w.sessions.set('s=owner-1', OWNER);
    let current = true;
    const s = socket(w, { agentId: 'a1', stillCurrent: () => current });
    current = false;
    w.svc.gateway.revalidateConsoleSockets();
    expect(s.closed).toBe(true);
    const t = socket(w, { agentId: 'a1', stillCurrent: () => { throw new Error('the database is gone'); } });
    expect(w.svc.gateway.revalidateConsoleSockets()).toBe(1);
    expect(t.closed).toBe(true);
    expect(w.warned.map((x) => x.detail.why)).toEqual(['the agent runtime changed', 'could not be checked']);
  });

  it('a second factor reset closes that person\'s sockets, at the public address only when asked', () => {
    const w = made();
    agent(w, 'a1');
    const pub = socket(w, { agentId: 'a1', public: true });
    const priv = socket(w, { agentId: 'a1' });
    const theirs = socket(w, { agentId: 'a1', ownerId: GUEST, role: 'guest', public: true });
    expect(w.svc.gateway.closeSocketsFor(OWNER, { publicOnly: true })).toBe(1);
    expect([pub.closed, priv.closed, theirs.closed]).toEqual([true, false, false]);
    expect(w.svc.gateway.closeSocketsFor(OWNER)).toBe(1);
    expect(priv.closed).toBe(true);
  });
});

describe('the sign-in panels', () => {
  /** A relay as a panel sees it (as in test/browserPanel.test.ts): what the tab says can be emitted. */
  function channel(): BrowserPanelChannel & { closed: boolean; emit: (m: Record<string, unknown>) => void } {
    let onMessage: (m: Record<string, unknown>) => void = () => {};
    let onClose: (d: string) => void = () => {};
    const ch = {
      closed: false,
      send: () => {},
      onMessage: (fn: (m: Record<string, unknown>) => void) => { onMessage = fn; },
      onClose: (fn: (d: string) => void) => { onClose = fn; },
      close: () => { if (!ch.closed) { ch.closed = true; onClose(''); } },
      emit: (m: Record<string, unknown>) => onMessage(m),
    };
    return ch;
  }
  const size = { w: 1000, h: 700, mobile: false, dpr: 1 };
  function open(w: World, a: Agent, o: Partial<PanelAccess> = {}): { id: string; access: PanelAccess; ch: ReturnType<typeof channel> } {
    const ch = channel();
    const id = w.svc.panels.panels.open(a.id, a.ownerId, ch, size);
    const access: PanelAccess = { id, agent: a, cookie: 's=owner-1', https: true, public: false, lastActive: Date.now(), ...o };
    w.svc.panels.rememberPanel(a.id, access);
    return { id, access, ch };
  }

  it('need the owner\'s signed-in browser where a sign-in reads cookies, and the gate\'s yes at the public address', () => {
    const w = made();
    const { panelSessionValid } = w.svc.panels;
    const access = { cookie: 's=owner-1', https: true, public: false, lastActive: Date.now() };
    expect(panelSessionValid(access, OWNER)).toBe(false);
    w.sessions.set('s=owner-1', OWNER);
    expect(panelSessionValid(access, OWNER)).toBe(true);
    expect(panelSessionValid(access, STRANGER)).toBe(false);
    expect(panelSessionValid({ ...access, public: true }, OWNER)).toBe(true);
    w.gateSays = 'no second factor';
    expect(panelSessionValid({ ...access, public: true }, OWNER)).toBe(false);
    w.gateSays = null;
    expect(panelSessionValid({ ...access, public: true }, OWNER)).toBe(false);
    // No sign-in reads a cookie (an auth-free fixture): the private address is let in.
    w.cookieSignIn = false;
    w.sessions.clear();
    expect(panelSessionValid(access, OWNER)).toBe(true);
  });

  it('close once the agent stops, its browser goes off, or its logins change', () => {
    const w = made();
    w.sessions.set('s=owner-1', OWNER);
    for (const [id, edit] of [['a1', { state: 'STOPPED' }], ['a2', { browser: false }], ['a3', { browserLogins: 'logins-new' }]] as const) {
      const a = agent(w, id, { browser: true, browserLogins: 'logins-1' });
      const p = open(w, a);
      expect(w.svc.panels.panelAccessValid(p.access)).toBe(true);
      change(w, id, edit as Partial<Agent>);
      expect(w.svc.panels.panelAccessValid(p.access)).toBe(false);
      w.svc.panels.revalidatePanels();
      expect(p.ch.closed, id).toBe(true);
      // Closing it forgets what let it in.
      expect(w.svc.panels.panelAccessOf(id)).toBeUndefined();
    }
  });

  it('a sign-out refuses that browser\'s panels being opened and closes its open ones', () => {
    const w = made();
    w.sessions.set('s=owner-1', OWNER).set('s=owner-2', OWNER);
    const a = agent(w, 'a1', { browser: true });
    const b = agent(w, 'a2', { browser: true });
    const mine = open(w, a);
    const other = open(w, b, { cookie: 's=owner-2' });
    const opening = w.svc.panels.pendingPanelOpen('owner-1');
    const elsewhere = w.svc.panels.pendingPanelOpen('owner-2');
    w.svc.panels.signedOut('owner-1');
    expect(opening.revoked()).toBe(true);
    expect(elsewhere.revoked()).toBe(false);
    expect(mine.ch.closed).toBe(true);
    expect(other.ch.closed).toBe(false);
    // A logout with no session in its cookie ends nothing.
    w.svc.panels.signedOut(undefined);
    expect(other.ch.closed).toBe(false);
    expect(w.traced.filter((t) => t.event === 'browser.panel_closed').map((t) => t.agentId)).toEqual(['a1']);
  });

  it('a site its page reaches is listed for an agent that keeps its logins, while the panel is still let in', () => {
    const w = made();
    w.sessions.set('s=owner-1', OWNER);
    const a = agent(w, 'a1', { browser: true, browserLogins: 'logins-1' });
    const p = open(w, a);
    // The page's address as the tab reports it; the panel's access is checked first.
    p.ch.emit({ method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://shop.example.org/basket' } } });
    w.sessions.clear();
    p.ch.emit({ method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://bank.example.org/' } } });
    expect(w.sitesNoted).toEqual(['shop.example.org']);
    expect(p.ch.closed).toBe(false);
  });
});

describe('the browsers and the timers', () => {
  it('a sweep that fails is logged, never thrown', async () => {
    const w = made({ failSweep: true });
    await expect(w.svc.browsers.browsersNow('a1')).resolves.toBeUndefined();
    expect(w.warned.map((x) => x.event)).toEqual(['browser sweep failed']);
  });

  it('the console sockets\' and the panels\' sweeps run every 30 seconds, the browsers\' only when asked for; stop() ends all three', () => {
    vi.useFakeTimers();
    const off = made();
    expect(vi.getTimerCount()).toBe(2);
    off.svc.stop();
    expect(vi.getTimerCount()).toBe(0);
    const on = made({ browserSweepEveryMs: 60_000 });
    expect(vi.getTimerCount()).toBe(3);
    on.svc.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the sweeps close what no request announced: a socket whose session ran out, a panel whose agent stopped', async () => {
    vi.useFakeTimers();
    const w = made();
    w.sessions.set('s=owner-1', OWNER);
    const a = agent(w, 'a1', { browser: true });
    const s = socket(w, { agentId: 'a1' });
    const ch = { closed: false, send: () => {}, onMessage: () => {}, onClose: (_fn: (d: string) => void) => {}, close: () => { ch.closed = true; } };
    const id = w.svc.panels.panels.open('a1', OWNER, ch, { w: 10, h: 10, mobile: false, dpr: 1 });
    w.svc.panels.rememberPanel('a1', { id, agent: a, cookie: 's=owner-1', https: true, public: false, lastActive: Date.now() });
    w.sessions.delete('s=owner-1');
    change(w, 'a1', { state: 'STOPPED' });
    await vi.advanceTimersByTimeAsync(29_000);
    expect([s.closed, ch.closed]).toEqual([false, false]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect([s.closed, ch.closed]).toEqual([true, true]);
  });
});
