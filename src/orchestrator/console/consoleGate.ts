import type { Agent } from '../../domain/types.js';
import type { ConsoleRole } from '../../openclaw/consoleIdentity.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { ConsoleAccess } from './consoleAccess.js';
import { ConsoleSockets, type ConsoleSocket } from './consoleSockets.js';

/**
 * The console's gate (HB-0808): who may reach which agent's OpenClaw console,
 * where its gateway answers, and what ends a console once it is open.
 *
 *  - Who: `consoleCaller`, the agent's owner, or a web-chat guest the owner
 *    gave it; never the management agent's guest.
 *  - Where: `gatewayAddr` and `consoleTarget` (a sleeping agent is woken
 *    first), and `consoleAccess`, which keeps the gateway's list of people in
 *    step and counts each guest's open consoles (consoleAccess.ts).
 *  - What ends it: a request or a handshake under way is held to what let it
 *    in across each wait (`consoleContext`, `consoleStillCurrent`), and ends
 *    when its browser signs out (`pendingSession`, `signedOut`); an open
 *    socket is judged again by the same rules after each request that changed
 *    something and every 30 seconds (`revalidateConsoleSockets`).
 *
 * The proxy itself (the HTTP forward, the WebSocket splice, the guest's
 * filter) is HTTP through and through: src/api/console/consoleRoutes.ts. This holds
 * the rules it asks, and their state.
 */
export interface ConsoleGate {
  /** Where an agent's gateway answers: its loopback-published port (or a runner's tunnel). Wakes a sleeping agent. */
  gatewayAddr(agent: Agent): Promise<{ host: string; port: number } | undefined>;
  /** Wake a sleeping agent for its console, then where its gateway answers. */
  consoleTarget(agent: Agent): Promise<{ agent: Agent; addr: { host: string; port: number } } | undefined>;
  /** The gateway's list of people and the guests' open consoles (consoleAccess.ts): one per process. */
  consoleAccess: ConsoleAccess;
  /** Who may open this agent's console, and as what: its owner, or a web-chat guest. Never the management agent's guest. */
  consoleCaller(userId: string, id: string): { agent: Agent; role: ConsoleRole } | undefined;
  /** What a console was let in on (the owner, the runtime, the machine): compared after each wait. */
  consoleContext(a: Agent): string;
  /** The same caller, in the same role, on the same running runtime as when `context` was taken. */
  consoleStillCurrent(me: string, caller: { agent: Agent; role: ConsoleRole }, context: string): boolean;
  /**
   * A console request or handshake under way for a browser session (its
   * cookie's signed value, or none): `revoked` once that session signs out.
   * `done` when it has answered or closed.
   */
  pendingSession(session: string | undefined): { revoked(): boolean; done(): void };
  /** That browser session signed out: its handshakes under way end, and so do its open sockets. */
  signedOut(ended: string): void;
  /** Remember an open console socket, with what let it in. Returns the function that forgets it. */
  addSocket(s: ConsoleSocket): () => void;
  /** Judge every open socket again by the rules that let it in; closes those no longer allowed. Returns how many. */
  revalidateConsoleSockets(): number;
  /** Close one person's sockets whatever their standing (their second factor was reset or removed). */
  closeSocketsFor(ownerId: string, opts?: { publicOnly?: boolean }): number;
  /** How many console sockets are open. */
  socketCount(): number;
  /** End the 30-second sweep: at shutdown. */
  stop(): void;
}

/** What the gate needs from the process it runs in. Functions only, so a test hands it fakes. */
export interface ConsoleGateDeps {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  trace: (agentId: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Wake a sleeping agent (hibernate.ts), as opening its console does. Returns it as it is then. */
  ensureAwake: (agent: Agent, why: string) => Promise<Agent>;
  /** Who a browser's Cookie header signs in as, by the sign-in in use (auth.ts): undefined for no one, or with no sign-in. Read at each call. */
  signedInAs: (cookie: string | undefined, https: boolean) => { ownerId: string } | undefined;
  /** The public gate (publicAccess.ts), when it is set up: its word on a socket open at the public address. Read at each call. */
  publicGate: () => { refuseOpenSocket(cookie: string | undefined, ownerId: string, lastActive: number): string | undefined } | undefined;
  /** The signed value of the session in a Cookie header (sessionCookie.ts readSessionCookie), or undefined. */
  sessionOf: (cookie: string | undefined, https: boolean) => string | undefined;
  /** The service log. */
  warn: (detail: Record<string, unknown>, event: string) => void;
}

export function createConsoleGate(deps: ConsoleGateDeps): ConsoleGate {
  const { store, providerFor, trace, ensureAwake } = deps;
  /** Where an agent's gateway answers: its loopback-published port. A jailed
   *  management agent publishes nothing itself — its doorman publishes that
   *  same port and forwards into the jail (src/ops/doorman.ts). */
  const gatewayAddr = async (agentIn: Agent): Promise<{ host: string; port: number } | undefined> => {
    // Opening a sleeping agent's console is a reason to wake it (hibernate.ts).
    const agent = agentIn.hibernatedAt && agentIn.state === 'STOPPED' ? await ensureAwake(agentIn, 'its console was opened') : agentIn;
    if (!agent.gatewayToken || agent.state !== 'RUNNING') return undefined;
    if (agent.gatewayPort) {
      // A runner's agent publishes on the RUNNER's loopback: the provider
      // tunnels to it. This machine's own agents: the port itself.
      const p = providerFor(agent.hostId);
      return p.gatewayEndpoint ? p.gatewayEndpoint(agent.gatewayPort, agent.runtimeRef) : { host: '127.0.0.1', port: agent.gatewayPort };
    }
    // An older management agent, built before the doorman: reached by container address.
    const ip = agent.ops && agent.runtimeRef ? await providerFor(agent.hostId).containerIp?.(agent.runtimeRef) : undefined;
    return ip ? { host: ip, port: 18789 } : undefined;
  };
  /**
   * The console with identities (openclaw/consoleIdentity.ts): the owner and,
   * on a rebuilt agent, the people the owner gave web chat reach OpenClaw's
   * own Control UI through this proxy, each named to the gateway.
   */
  const consoleAccess = new ConsoleAccess({ store, providerFor, gatewayAddr, trace: (id) => trace(id) });
  /** Who may open this agent's console, and as what: its owner, or a web-chat guest. Never the management agent's guest. */
  const consoleCaller = (userId: string, id: string): { agent: Agent; role: ConsoleRole } | undefined => {
    const agent = store.getAgent(id);
    if (!agent || agent.state === 'DELETED' || agent.state === 'DELETING') return undefined;
    if (agent.ownerId === userId) return { agent, role: 'owner' };
    if (agent.ops || !agent.gatewayToken) return undefined;
    return store.webChatAllowed(agent.id, userId) ? { agent, role: 'guest' } : undefined;
  };
  // Both HTTP and socket handshakes wait on runners and gateway readiness.
  // Those waits must not carry earlier permissions or an earlier runtime on.
  const consoleContext = (a: Agent): string => JSON.stringify([
    a.ownerId, a.runtimeRef, a.hostId, a.gatewayPort, a.gatewayToken, a.slug, store.getHost(a.hostId),
  ]);
  const consoleStillCurrent = (me: string, caller: { agent: Agent; role: ConsoleRole }, context: string): boolean => {
    const now = consoleCaller(me, caller.agent.id);
    return !!now && now.role === caller.role && now.agent.state === 'RUNNING' && consoleContext(now.agent) === context;
  };
  /** Console requests and handshakes under way, each with the browser session it came with (watchConsoleSession). */
  const pendingConsoleSessions = new Set<{ session: string | undefined; revoked: boolean }>();
  const pendingSession = (session: string | undefined) => {
    const pending = { session, revoked: false };
    pendingConsoleSessions.add(pending);
    return { revoked: () => pending.revoked, done: () => { pendingConsoleSessions.delete(pending); } };
  };
  /** Wake a sleeping agent for its console, then where its gateway answers. */
  const consoleTarget = async (agentIn: Agent): Promise<{ agent: Agent; addr: { host: string; port: number } } | undefined> => {
    const agent = agentIn.hibernatedAt && agentIn.state === 'STOPPED' ? await ensureAwake(agentIn, 'its console was opened') : agentIn;
    const addr = await gatewayAddr(agent);
    return addr ? { agent, addr } : undefined;
  };

  /**
   * Every console socket that is open, re-judged by the rules that let it in
   * (consoleSockets.ts): the session, at the public address the pass, its idle
   * limit and the second factor, and the caller's standing on that agent.
   */
  const consoleSockets = new ConsoleSockets();
  const consoleSocketProblem = (s: ConsoleSocket): string | undefined => {
    const who = deps.signedInAs(s.cookie, s.https);
    if (!who || who.ownerId !== s.ownerId) return 'signed out';
    if (s.public) {
      const publicAccess = deps.publicGate();
      const why = publicAccess ? publicAccess.refuseOpenSocket(s.cookie, s.ownerId, s.lastActive) : 'no public gate';
      if (why) return why;
    }
    const now = consoleCaller(s.ownerId, s.agentId);
    if (!now || now.role !== s.role) return 'no longer allowed on this agent';
    if (s.stillCurrent && !s.stillCurrent()) return 'the agent runtime changed';
    return undefined;
  };
  const revalidateConsoleSockets = (): number => consoleSockets.size() === 0 ? 0
    : consoleSockets.sweep(consoleSocketProblem, (s, why) => {
      deps.warn({ agent: s.agentId, ownerId: s.ownerId, public: s.public, why }, 'console.socket_closed');
      try { trace(s.agentId)('console.socket_closed', { userId: s.ownerId, why }); } catch { /* the trace is best effort */ }
    });
  const signedOut = (ended: string): void => {
    for (const pending of pendingConsoleSessions) if (pending.session === ended) pending.revoked = true;
    consoleSockets.sweep((s) => deps.sessionOf(s.cookie, s.https) === ended ? 'signed out' : undefined);
  };
  // …and for what no request announces: the public idle limit, a session that
  // ran out, a change made by another process (the command line).
  const consoleSweep = setInterval(() => { try { revalidateConsoleSockets(); } catch { /* next time */ } }, 30_000);
  consoleSweep.unref?.();

  return {
    gatewayAddr, consoleTarget, consoleAccess, consoleCaller, consoleContext, consoleStillCurrent,
    pendingSession, signedOut,
    addSocket: (s) => consoleSockets.add(s),
    revalidateConsoleSockets,
    closeSocketsFor: (ownerId: string, opts: { publicOnly?: boolean } = {}) =>
      consoleSockets.sweep((s) => (s.ownerId === ownerId && (!opts.publicOnly || s.public) ? 'second factor changed' : undefined),
        (s, why) => deps.warn({ agent: s.agentId, ownerId: s.ownerId, public: s.public, why }, 'console.socket_closed')),
    socketCount: () => consoleSockets.size(),
    stop: () => { clearInterval(consoleSweep); },
  };
}
