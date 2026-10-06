import { createHash } from 'node:crypto';
import type { Agent } from '../domain/types.js';
import type { RuntimeProvider } from '../providers/provider.js';
import type { Store } from '../store/store.js';
import {
  CONSOLE_USER_HEADER, OWNER_ROLE, NO_PROXY_YET, consoleIdentity, guestConsoleSessionKey, isConsoleIdentity,
} from '../openclaw/consoleIdentity.js';

/**
 * The running side of the console with identities (openclaw/consoleIdentity.ts):
 * which agents have it, keeping each gateway's list of names in step with who
 * may use it, giving the owner's profile the owner role, and ending a removed
 * guest's open connection.
 */

/** Off switch for a quick rollback: HATCHABOT_CONSOLE_IDENTITY=off builds token consoles again (on the next rebuild). */
export function consoleIdentityEnabled(): boolean {
  return (process.env.HATCHABOT_CONSOLE_IDENTITY ?? '').trim().toLowerCase() !== 'off';
}

/** The people besides the owner who may use the console: active members the owner gave web chat. */
export function consoleGuests(store: Store, agent: Pick<Agent, 'id' | 'ownerId'>): Array<{ userId: string; displayName?: string }> {
  return store.listMemberships(agent.id)
    .filter((m) => m.status === 'active' && m.webChat && m.userId !== agent.ownerId)
    .map((m) => ({ userId: m.userId, displayName: m.displayName }));
}

/** The names the gateway must admit: the owner's, then each guest's. */
export function consoleAllowUsers(store: Store, agent: Pick<Agent, 'id' | 'ownerId'>, secret: string): string[] {
  return [consoleIdentity(secret, 'owner', agent.ownerId), ...consoleGuests(store, agent).map((g) => consoleIdentity(secret, 'guest', g.userId))];
}

/**
 * Read in the container: the gateway's auth mode, its current names and
 * trusted proxies, and the container's default route (the address Hatchabot's
 * connections arrive from — the agent network's gateway). A node one-shot, not
 * the CLI: it runs on every console open that is not cached.
 */
export const CONSOLE_STATE_SCRIPT = String.raw`
const fs = require("fs");
let c = {}; try { c = JSON.parse(fs.readFileSync((process.env.OPENCLAW_STATE_DIR || "/home/node/.openclaw") + "/openclaw.json", "utf8")); } catch {}
const g = c.gateway || {}, a = g.auth || {};
let route = "";
try {
  for (const l of fs.readFileSync("/proc/net/route", "utf8").split(String.fromCharCode(10)).slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f[1] === "00000000" && /^[0-9A-Fa-f]{8}$/.test(f[2] || "") && f[2] !== "00000000") { const h = f[2]; route = [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join("."); break; }
  }
} catch {}
process.stdout.write(JSON.stringify({
  mode: String(a.mode || (a.token ? "token" : a.password ? "password" : "none")),
  allowUsers: (a.trustedProxy && Array.isArray(a.trustedProxy.allowUsers)) ? a.trustedProxy.allowUsers : [],
  trustedProxies: Array.isArray(g.trustedProxies) ? g.trustedProxies : [],
  roles: !!g.roles,
  route,
}));
`;

export interface ConsoleState {
  /** 'identity': the console with identities; 'token': as before (not rebuilt yet, or an older OpenClaw). */
  mode: 'identity' | 'token';
  allowUsers: string[];
  trustedProxies: string[];
  route?: string;
}

export function parseConsoleState(stdout: string): ConsoleState | undefined {
  try {
    const j = JSON.parse(stdout) as { mode?: string; allowUsers?: unknown; trustedProxies?: unknown; roles?: boolean; route?: string };
    const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
    return {
      mode: j.mode === 'trusted-proxy' && j.roles ? 'identity' : 'token',
      allowUsers: strings(j.allowUsers),
      trustedProxies: strings(j.trustedProxies),
      ...(typeof j.route === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(j.route) ? { route: j.route } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The config edit that brings names and proxies in step; undefined when they already are. */
export function consoleSyncBatch(state: ConsoleState, want: string[]): Array<{ path: string; value: unknown }> | undefined {
  const ops: Array<{ path: string; value: unknown }> = [];
  const have = new Set(state.allowUsers);
  if (want.length !== state.allowUsers.length || want.some((u) => !have.has(u))) {
    ops.push({ path: 'gateway.auth.trustedProxy.allowUsers', value: want });
  }
  // The address connections really arrive from, kept with whatever else was
  // set (the placeholder of a build that did not know it is dropped).
  if (state.route && !state.trustedProxies.includes(state.route)) {
    ops.push({ path: 'gateway.trustedProxies', value: [...state.trustedProxies.filter((p) => p !== NO_PROXY_YET), state.route] });
  }
  return ops.length ? ops : undefined;
}

type Gateway = { host: string; port: number };

/**
 * One connection to an agent's gateway as a named person, from here — the
 * trusted proxy — with a handful of calls. Node's WebSocket (undici) takes
 * headers. The backend client id with no device: only identity grants apply,
 * which is exactly the owner's operator.admin.
 */
export async function gatewayCallAs(
  gw: Gateway, identity: string, calls: Array<[string, unknown]>, timeoutMs = 8000,
): Promise<{ scopes: string[]; results: Array<{ ok: boolean; payload?: any; error?: any }> }> {
  const WS = (globalThis as { WebSocket?: any }).WebSocket;
  if (typeof WS !== 'function') throw new Error('this Node has no WebSocket client');
  return await new Promise((resolve, reject) => {
    const ws = new WS(`ws://${gw.host}:${gw.port}/`, { headers: { [CONSOLE_USER_HEADER]: identity, 'x-forwarded-for': '198.51.100.1' } });
    const timer = setTimeout(() => done(() => reject(new Error('the gateway did not answer in time'))), timeoutMs);
    const pending = new Map<string, (f: any) => void>();
    let n = 0;
    const call = (method: string, params: unknown) => new Promise<any>((res) => {
      const id = `hb${++n}`;
      pending.set(id, res);
      ws.send(JSON.stringify({ type: 'req', id, method, params }));
    });
    // Once only, and the handlers off before the close: closing a socket that
    // never opened fires its close event right there, which called done, which
    // closed again — until the stack ran out, an uncaught exception that can
    // stop the control plane (every Node 22; seen in CI, 2026-10-06).
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.onerror = ws.onclose = ws.onmessage = null;
      try { ws.close(); } catch { /* */ }
      fn();
    };
    ws.onerror = () => done(() => reject(new Error('could not reach the gateway')));
    ws.onclose = (e: { code?: number; reason?: string }) => done(() => reject(new Error(`the gateway closed the connection (${e?.code ?? ''} ${e?.reason ?? ''})`)));
    ws.onmessage = async (ev: { data: unknown }) => {
      let f: any; try { f = JSON.parse(String(ev.data)); } catch { return; }
      if (f.type === 'event' && f.event === 'connect.challenge') {
        const hello = await call('connect', {
          minProtocol: 4, maxProtocol: 4,
          client: { id: 'gateway-client', version: 'hatchabot', platform: process.platform, mode: 'backend', displayName: 'Hatchabot' },
          role: 'operator', scopes: [], caps: [],
        });
        if (!hello.ok) { ws.onclose = null; done(() => reject(new Error(`refused: ${hello.error?.message ?? hello.error?.code ?? 'unknown'}`))); return; }
        const scopes: string[] = Array.isArray(hello.payload?.auth?.scopes) ? hello.payload.auth.scopes : [];
        const results: Array<{ ok: boolean; payload?: any; error?: any }> = [];
        for (const [m, p] of calls) {
          const r = await call(m, p);
          results.push({ ok: !!r.ok, payload: r.payload, error: r.error });
        }
        ws.onclose = null;
        done(() => resolve({ scopes, results }));
        return;
      }
      if (f.type === 'res' && pending.has(f.id)) {
        if (f.ok && f.payload?.status === 'accepted') return;
        const r = pending.get(f.id)!; pending.delete(f.id); r(f);
      }
    };
  });
}

export interface ConsoleAccessDeps {
  store: Store;
  providerFor: (hostId: string) => RuntimeProvider;
  /** Where Hatchabot reaches the agent's gateway (its loopback port, or a runner's tunnel). */
  gatewayAddr: (agent: Agent) => Promise<Gateway | undefined>;
  trace?: (agentId: string) => (event: string, detail: Record<string, unknown>) => void;
  /** How long to wait for a new list of names to take effect at the gateway (default 20 s). */
  reloadWaitMs?: number;
}

export type ConsoleReady =
  | { mode: 'token' }
  | { mode: 'identity' }
  /** identity: the gateway IS an identity one (so the owner is still sent as a named person), it just is not in step. */
  | { mode: 'unavailable'; reason: string; identity?: boolean };

/**
 * Why the gateway is being brought in step, for the activity trail. The list
 * of names is changed when access changes (a grant, a removal, a start) —
 * never, in the normal course, when someone opens the console: changing it
 * reloads the gateway's auth, and every open console (the owner's too)
 * reconnects (2026-09-30).
 */
export type ConsoleSyncReason = 'open' | 'grant' | 'removal' | 'start';

/**
 * Per process: what each agent's gateway runs, and whether it has been
 * brought in step. Cheap to ask: a state read is cached for 15 s, a
 * successful sync for a minute (or until the names it was made for change).
 */
export class ConsoleAccess {
  readonly #deps: ConsoleAccessDeps;
  readonly #state = new Map<string, { key: string; at: number; state: ConsoleState | undefined }>();
  readonly #ready = new Map<string, { key: string; at: number }>();
  /** One run per agent at a time, keyed by the list of people it was started for. */
  readonly #inflight = new Map<string, { key: string; p: Promise<ConsoleReady> }>();
  readonly #named = new Map<string, number>();
  /** Open guest consoles, so a removal ends them at once. */
  readonly #sockets = new Map<string, Set<{ userId: string; destroy: () => void }>>();
  #sweep?: NodeJS.Timeout;

  constructor(deps: ConsoleAccessDeps) {
    this.#deps = deps;
  }

  /** What the agent's gateway was built with (cached briefly). */
  async state(agent: Agent): Promise<ConsoleState | undefined> {
    if (!agent.runtimeRef || agent.state !== 'RUNNING') return undefined;
    const key = `${agent.runtimeRef}|${agent.updatedAt}`;
    const c = this.#state.get(agent.id);
    if (c && c.key === key && Date.now() - c.at < 15_000) return c.state;
    const b64 = Buffer.from(CONSOLE_STATE_SCRIPT, 'utf8').toString('base64');
    const res = await this.#deps.providerFor(agent.hostId)
      .execShell(agent.runtimeRef, `echo ${b64} | base64 -d > /tmp/hb-console-state.cjs && node /tmp/hb-console-state.cjs; rc=$?; rm -f /tmp/hb-console-state.cjs; exit $rc`, { timeoutMs: 15_000 })
      .catch(() => undefined);
    const state = res && res.code === 0 ? parseConsoleState(res.stdout) : undefined;
    this.#state.set(agent.id, { key, at: Date.now(), state });
    return state;
  }

  /** Forget what is known of an agent (it was rebuilt, restarted, or its people changed). */
  invalidate(agentId: string): void {
    this.#state.delete(agentId);
    this.#ready.delete(agentId);
  }

  /**
   * Bring the agent's gateway in step: its names (the owner and every current
   * guest), its trusted proxy, and the owner role on the owner's profile. A
   * token gateway needs nothing.
   *
   * Called where access CHANGES — a web chat grant (invite or switch), a
   * removal, a start — so the reload a new list of names costs happens while
   * no guest is connected yet; at a console open it then only verifies. An
   * open that finds the list out of step anyway (the agent was stopped when
   * access changed, or that sync failed) still fixes it, and waits for the
   * reload to land before letting anyone in.
   *
   * A call for the list a run in flight was started for shares that run; a
   * call for a newer list waits for it and runs again, so a grant made while
   * an older run is in flight is never answered by the older list.
   */
  async ensureReady(agent: Agent, why: ConsoleSyncReason = 'open'): Promise<ConsoleReady> {
    const key = this.#namesKey(agent);
    const running = this.#inflight.get(agent.id);
    if (running && running.key === key) return running.p;
    const before = running ? running.p.catch(() => undefined) : Promise.resolve(undefined);
    const p: Promise<ConsoleReady> = before
      .then(() => this.#ensure(agent, why))
      .finally(() => { if (this.#inflight.get(agent.id)?.p === p) this.#inflight.delete(agent.id); });
    this.#inflight.set(agent.id, { key, p });
    return p;
  }

  /** What a run is for: the agent's container and the names its gateway must admit now. */
  #namesKey(agent: Agent): string {
    const want = agent.gatewayToken ? consoleAllowUsers(this.#deps.store, agent, agent.gatewayToken) : [];
    return `${agent.hostId}|${agent.runtimeRef}|${createHash('sha256').update(want.join(',')).digest('hex')}`;
  }

  /**
   * After a start or a wake, once its gateway answers: bring the names in
   * step if access changed while it was down (a grant to a stopped or
   * sleeping agent could not reach its gateway). Only the state read when
   * nothing changed — no connection, no CLI — so a fleet start stays cheap.
   */
  async syncWhenUp(agentId: string, opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<ConsoleReady | undefined> {
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < (opts.attempts ?? 24); i++) {
      const a = this.#deps.store.getAgent(agentId);
      if (!a || a.state === 'DELETED' || !a.runtimeRef || !a.gatewayToken || a.ops) return undefined;
      if (a.state === 'RUNNING') {
        const st = await this.#deps.providerFor(a.hostId).status(a.runtimeRef).catch(() => undefined);
        if (st?.phase === 'stopped' || st?.phase === 'error') return undefined;
        if (st?.phase === 'running' && st.healthy) {
          this.invalidate(a.id);
          const state = await this.state(a);
          if (!state || state.mode !== 'identity') return undefined;
          const batch = consoleSyncBatch(state, consoleAllowUsers(this.#deps.store, a, a.gatewayToken));
          if (!batch?.some((b) => b.path === 'gateway.auth.trustedProxy.allowUsers')) return undefined;
          return this.ensureReady(a, 'start');
        }
      }
      await sleep(5000); // a fleet start is many of these at once: not one docker inspect a second each
    }
    return undefined;
  }

  async #ensure(agent: Agent, why: ConsoleSyncReason): Promise<ConsoleReady> {
    if (!agent.gatewayToken) return { mode: 'unavailable', reason: 'no console' };
    const want = consoleAllowUsers(this.#deps.store, agent, agent.gatewayToken);
    const readyKey = `${agent.hostId}|${agent.runtimeRef}|${agent.updatedAt}|${createHash('sha256').update(want.join(',')).digest('hex')}`;
    const r = this.#ready.get(agent.id);
    // A minute at most: a rebuild by another release, or a hand edit, is noticed soon.
    if (r && r.key === readyKey && Date.now() - r.at < 60_000) return { mode: 'identity' };
    const state = await this.state(agent);
    if (!state) return { mode: 'unavailable', reason: 'its gateway settings could not be read' };
    if (state.mode === 'token') return { mode: 'token' };
    const provider = this.#deps.providerFor(agent.hostId);
    const trace = this.#deps.trace?.(agent.id);
    const batch = consoleSyncBatch(state, want);
    // Names the gateway does not admit yet: the reload must have landed before they connect.
    const added = want.filter((u) => !state.allowUsers.includes(u));
    if (batch) {
      const res = await provider.exec(agent.runtimeRef!, ['config', 'set', '--batch-json', JSON.stringify(batch), '--replace'], { timeoutMs: 60_000 });
      trace?.('console.names_synced', { ok: res.code === 0, names: want.length, paths: batch.map((b) => b.path), why });
      this.#state.delete(agent.id);
      if (res.code !== 0) return { mode: 'unavailable', reason: 'its gateway would not take the list of people', identity: true };
    }
    const gw = await this.#deps.gatewayAddr(agent);
    if (!gw) return { mode: 'unavailable', reason: 'its gateway is not reachable', identity: true };
    const owner = consoleIdentity(agent.gatewayToken, 'owner', agent.ownerId);
    if (batch && added.length) {
      // The edit reloads the gateway's auth a moment later. Until then a new
      // name is still refused — the "unauthorized" a new guest's first open
      // met. Wait until the gateway admits one of them (a connection with no
      // device and no scopes: it reads nothing and changes nothing).
      if (!(await this.#admitted(gw, added.find((u) => u !== owner) ?? added[0]!))) {
        trace?.('console.unavailable', { reason: 'the new list of people did not take effect in time' });
        return { mode: 'unavailable', reason: 'its gateway did not take the new list of people in time — try again in a moment', identity: true };
      }
    }
    // A reload after the edit above closes and reopens the gateway's doors:
    // give it a moment rather than failing the owner's first open.
    let scopes: string[] | undefined;
    let lastErr = '';
    for (let i = 0; i < (batch ? 8 : 2) && !scopes; i++) {
      if (i) await new Promise((res) => setTimeout(res, 500));
      try { scopes = (await gatewayCallAs(gw, owner, [])).scopes; } catch (e) { lastErr = (e as Error).message; }
    }
    if (!scopes) {
      trace?.('console.unavailable', { reason: lastErr.slice(0, 200) });
      return { mode: 'unavailable', reason: `its gateway refused the console (${lastErr.slice(0, 120)})`, identity: true };
    }
    if (!scopes.includes('operator.admin')) {
      // First open since the build: the owner's profile exists now (that
      // connection made it) and gets the owner role, from inside the
      // container where the CLI holds the gateway password. Anyone else
      // holding the owner role (a previous owner) loses it.
      const ok = await this.#assignOwnerRole(provider, agent.runtimeRef!, owner);
      trace?.('console.owner_role', { ok });
      if (ok) {
        try { scopes = (await gatewayCallAs(gw, owner, [])).scopes; } catch { /* checked below */ }
      }
      if (!scopes?.includes('operator.admin')) return { mode: 'unavailable', reason: 'the owner role could not be set on its gateway', identity: true };
    }
    this.#ready.set(agent.id, { key: readyKey, at: Date.now() });
    return { mode: 'identity' };
  }

  /** Does the gateway admit this name yet? Asked every 300 ms until it does, for up to `reloadWaitMs`. */
  async #admitted(gw: Gateway, identity: string): Promise<boolean> {
    const until = Date.now() + (this.#deps.reloadWaitMs ?? 20_000);
    for (;;) {
      try { await gatewayCallAs(gw, identity, [], 5000); return true; } catch { /* not yet */ }
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  async #assignOwnerRole(provider: RuntimeProvider, runtimeRef: string, owner: string): Promise<boolean> {
    const list = await provider.exec(runtimeRef, ['gateway', 'call', 'users.list', '--params', '{}', '--json'], { timeoutMs: 30_000 });
    if (list.code !== 0) return false;
    let profiles: Array<{ id?: string; emails?: string[]; role?: string | null }> = [];
    try { profiles = (JSON.parse(list.stdout) as { profiles?: typeof profiles }).profiles ?? []; } catch { return false; }
    const mine = profiles.find((p) => (p.emails ?? []).some((e) => e.toLowerCase() === owner.toLowerCase()));
    if (!mine?.id) return false;
    for (const p of profiles) {
      if (p.id && p.id !== mine.id && p.role === OWNER_ROLE) {
        await provider.exec(runtimeRef, ['gateway', 'call', 'users.setRole', '--params', JSON.stringify({ profileId: p.id, role: null }), '--json'], { timeoutMs: 30_000 });
      }
    }
    if (mine.role === OWNER_ROLE) return true;
    const set = await provider.exec(runtimeRef, ['gateway', 'call', 'users.setRole', '--params', JSON.stringify({ profileId: mine.id, role: OWNER_ROLE }), '--json'], { timeoutMs: 30_000 });
    return set.code === 0;
  }

  /**
   * Give the owner readable names for the guests' sessions: each guest's
   * profile is named after them as a member, the owner's "Owner"
   * (best-effort; the names are only shown to the owner — a guest's view of
   * other people is scrubbed and the people-listing calls are refused).
   */
  async nameGuests(agent: Agent, force = false): Promise<void> {
    if (!agent.gatewayToken) return;
    // At most every few minutes per agent, unless someone new just arrived.
    const last = this.#named.get(agent.id) ?? 0;
    if (!force && Date.now() - last < 5 * 60_000) return;
    this.#named.set(agent.id, Date.now());
    const gw = await this.#deps.gatewayAddr(agent).catch(() => undefined);
    if (!gw) return;
    const owner = consoleIdentity(agent.gatewayToken, 'owner', agent.ownerId);
    const names = new Map(consoleGuests(this.#deps.store, agent).map((g) => [consoleIdentity(agent.gatewayToken!, 'guest', g.userId), (g.displayName || '').trim().slice(0, 64)]));
    // The owner is "Owner", as OpenClaw calls its shared owner (the CLI's, Telegram's).
    names.set(owner, 'Owner');
    const { results } = await gatewayCallAs(gw, owner, [['users.list', {}]]);
    const profiles = (results[0]?.payload?.profiles ?? []) as Array<{ id: string; displayName?: string; emails?: string[] }>;
    const calls: Array<[string, unknown]> = [];
    for (const p of profiles) {
      const email = (p.emails ?? []).find((e) => isConsoleIdentity(e));
      const name = email ? names.get(email.toLowerCase()) : undefined;
      if (name && p.displayName !== name) calls.push(['users.setDisplayName', { profileId: p.id, displayName: name }]);
    }
    if (calls.length) await gatewayCallAs(gw, owner, calls);
  }

  /** Where a guest's console opens: their own conversation. */
  guestSessionKey(agent: Agent, userId: string): string {
    return guestConsoleSessionKey(agent.gatewayToken ?? '', agent.slug, userId);
  }

  /** Remember an open guest console; returns its forget function. */
  trackGuest(agentId: string, userId: string, destroy: () => void): () => void {
    let set = this.#sockets.get(agentId);
    if (!set) { set = new Set(); this.#sockets.set(agentId, set); }
    const entry = { userId, destroy };
    set.add(entry);
    this.#ensureSweep();
    return () => { set!.delete(entry); if (!set!.size) this.#sockets.delete(agentId); };
  }

  /** How many guest consoles are open (for tests and the sweep). */
  openGuests(agentId?: string): number {
    if (agentId) return this.#sockets.get(agentId)?.size ?? 0;
    let n = 0; for (const s of this.#sockets.values()) n += s.size; return n;
  }

  /**
   * A person lost the console (removed, web chat turned off, the agent
   * deleted): close what they have open NOW, and take their name off the
   * gateway at the next sync. No userId: everyone on that agent.
   */
  dropGuests(agentId: string, userId?: string): number {
    this.#ready.delete(agentId);
    const set = this.#sockets.get(agentId);
    let n = 0;
    for (const e of [...(set ?? [])]) {
      if (userId && e.userId !== userId) continue;
      try { e.destroy(); } catch { /* already gone */ }
      set!.delete(e); n++;
    }
    return n;
  }

  /** Every 30 s: any open guest console whose person may no longer use it is closed (whatever path removed them). */
  sweepNow(): number {
    let n = 0;
    for (const [agentId, set] of this.#sockets) {
      const agent = this.#deps.store.getAgent(agentId);
      for (const e of [...set]) {
        const still = !!agent && agent.state === 'RUNNING' && agent.ownerId !== e.userId && this.#deps.store.webChatAllowed(agentId, e.userId);
        if (!still) { try { e.destroy(); } catch { /* */ } set.delete(e); n++; }
      }
      if (!set.size) this.#sockets.delete(agentId);
    }
    return n;
  }

  #ensureSweep(): void {
    if (this.#sweep) return;
    this.#sweep = setInterval(() => {
      this.sweepNow();
      if (!this.#sockets.size && this.#sweep) { clearInterval(this.#sweep); this.#sweep = undefined; }
    }, 30_000);
    this.#sweep.unref?.();
  }
}
