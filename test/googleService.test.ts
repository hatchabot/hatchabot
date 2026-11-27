import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { importsTook } from '../src/providers/mockProvider.js';
import type { ExecResult, RuntimeProvider } from '../src/providers/provider.js';
import { clearBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { GOOGLE_CLIENT_REF, withConnectionLock } from '../src/orchestrator/google/googleConnections.js';
import { createConnectionsAndAccess, type ConnectionsAndAccess } from '../src/orchestrator/google/connectionsAndAccess.js';
import type { Agent } from '../src/domain/types.js';
import { LocalSecretStore } from '../src/secrets/localSecretStore.js';
import { eventLabel } from '../src/orchestrator/health/eventLabels.js';
import { MemSecrets } from './support/world.js';

/**
 * The Google connections and access service (HB-0808), driven as the routes
 * drive it but with no HTTP server: attach and detach, Disconnect, the
 * installation's client, a new client secret delivered and the pass for what
 * is still owed, and Verify now. A real store on an in-memory database; a
 * runtime that only answers shell lines (gog's import, list and remove);
 * Google at the fetch seam. Every address, id and token is made up, and the
 * client's and tokens' values are put together at run time.
 */
const OWNER = 'user-owner';
const OTHER = 'user-other';
const SAM = 'sam@example.com';
const made = (...parts: string[]) => parts.join('-');
const CLIENT_A = { clientId: made('fixture', 'client', 'a'), clientSecret: made('fixture', 'first', 'value') };
const CLIENT_B = { clientId: made('fixture', 'client', 'b'), clientSecret: made('fixture', 'other', 'value') };

interface Call { ref: string; script: string; secret: boolean }
interface World {
  db: Database.Database;
  store: Store;
  secrets: MemSecrets;
  google: ConnectionsAndAccess;
  calls: Call[];
  traced: Array<{ event: string; detail: Record<string, unknown> }>;
  docsSynced: string[];
  warned: string[];
  /** What the owner was told on their chat app, and whether a chat app takes it. */
  told: Array<{ ownerId: string; text: string }>;
  chatTakes: boolean;
  /** What the runtime answers a shell line; the default takes every import and every remove. */
  answer: (script: string) => ExecResult | Promise<ExecResult>;
  agent(id: string, opts?: { owner?: string; state?: Agent['state'] }): Agent;
  connection(id: string, opts?: { owner?: string; email?: string; clientId?: string }): string;
  /** The process ends and the next one starts: a new store and service on the same database and secret store. */
  restart(): void;
}

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const defaultAnswer = (script: string): ExecResult => (script.includes('gog auth import') ? ok(importsTook(script)) : ok());

function world(opts: { sweepEveryMs?: number; oauthFetch?: typeof fetch } = {}): World {
  const db = new Database(':memory:');
  const store = new Store(db);
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const secrets = new MemSecrets();
  const w = { db, store, secrets, calls: [], traced: [], docsSynced: [], warned: [], told: [], chatTakes: true, answer: defaultAnswer } as unknown as World;
  const provider = {
    execShell: async (ref: string, script: string, o?: { secret?: boolean }) => {
      w.calls.push({ ref, script, secret: !!o?.secret });
      return w.answer(script);
    },
    reachable: async () => true,
  } as unknown as RuntimeProvider;
  const service = (on: Store) => createConnectionsAndAccess({
    store: on, secrets,
    providerFor: () => provider,
    trace: (agentId) => (event, detail) => { w.traced.push({ event, detail: { ...(agentId ? { agentId } : {}), ...detail } }); },
    oauthFetch: opts.oauthFetch ?? (async () => { throw new Error('Google was asked'); }) as unknown as typeof fetch,
    syncDocsHeld: async (agent) => { w.docsSynced.push(agent.id); },
    warn: (_detail, msg) => { w.warned.push(msg); },
    sweepEveryMs: opts.sweepEveryMs ?? 0,
    tellOwner: async (ownerId, text) => { w.told.push({ ownerId, text }); return w.chatTakes; },
  });
  w.google = service(store);
  w.restart = () => { w.google.stop(); w.store = new Store(db); w.google = service(w.store); };
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: o.owner ?? OWNER, name: `Agent ${id}`, slug: id, state: o.state ?? 'STOPPED', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `rt-${id}`,
    } as never);
    return store.getAgent(id)!;
  };
  w.connection = (id, o = {}) => {
    store.insertConnection({ id, ownerId: o.owner ?? OWNER, kind: 'google', email: o.email ?? SAM, services: ['gmail'], secretRef: `connection/${id}`, clientId: o.clientId ?? CLIENT_A.clientId });
    void secrets.put(`connection/${id}`, made('fixture', 'refresh', id));
    return id;
  };
  return w;
}

/** A promise and the function that settles it: a step held until the test lets it go. */
function gate<T = void>() {
  let open!: (v: T) => void;
  const held = new Promise<T>((r) => { open = r; });
  return { held, open };
}

afterEach(() => { vi.useRealTimers(); });

describe('attach and detach', () => {
  it('attaches only a connection of the caller\'s own', async () => {
    const w = world();
    const a = w.agent('a1');
    w.connection('c-other', { owner: OTHER });
    expect(await w.google.vault.attach(a, OWNER, 'c-other', false)).toBeNull();
    expect(await w.google.vault.attach(a, OWNER, 'c-none', false)).toBeNull();
    expect(await w.google.vault.attach(a, OWNER, undefined, false)).toBeNull();
    expect(w.store.listAgentConnections('a1')).toEqual([]);
    expect(w.traced).toEqual([]);
  });

  it('a stopped agent gets it at its next start; a removal still pending from a detach is called off', async () => {
    const w = world();
    const a = w.agent('a1');
    w.connection('c1');
    w.store.addConnectionRemoval('a1', SAM);
    expect(await w.google.vault.attach(a, OWNER, 'c1', true)).toEqual({ attached: true, live: false });
    expect(w.store.listAgentConnections('a1')).toEqual([expect.objectContaining({ connectionId: 'c1', gmailNoSend: true })]);
    expect(w.store.connectionRemovals('a1')).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(w.traced.map((t) => t.event)).toEqual(['connection.attached']);
    expect(w.docsSynced).toEqual([]); // AGENTS.md is written at its next start
  });

  it('a running agent has the account imported at once, the token over stdin, and its AGENTS.md told', async () => {
    const w = world();
    await w.secrets.put(GOOGLE_CLIENT_REF, JSON.stringify(CLIENT_A));
    const a = w.agent('a1', { state: 'RUNNING' });
    w.connection('c1');
    expect(await w.google.vault.attach(a, OWNER, 'c1', false)).toEqual({ attached: true, live: true, error: undefined });
    const imports = w.calls.filter((c) => c.script.includes('gog auth import'));
    expect(imports).toHaveLength(1);
    expect(imports[0]!.secret).toBe(true);
    expect(w.docsSynced).toEqual(['a1']);
  });

  it('an attach that waits behind a delete of the same connection is refused, and leaves nothing attached', async () => {
    const w = world();
    const a = w.agent('a1', { state: 'RUNNING' });
    w.connection('c1');
    w.store.attachConnection('a1', 'c1', false);
    const removing = gate();
    w.answer = async (script) => { if (script.includes('gog auth remove')) await removing.held; return ok(); };
    const deleting = w.google.vault.remove('c1', OWNER);
    await vi.waitFor(() => expect(w.calls.some((c) => c.script.includes('gog auth remove'))).toBe(true));
    const attaching = w.google.vault.attach(a, OWNER, 'c1', false);
    removing.open();
    // (Google is not reached in this world: its revoke is left to the pass.)
    expect(await deleting).toEqual({ removed: true, pendingOn: 0, stillEnding: true });
    expect(await attaching).toBeNull();
    expect(w.store.listAgentConnections('a1')).toEqual([]);
    expect(w.store.getConnection('c1')).toBeUndefined();
  });

  it('an attach that waits its turn while the agent is deleted puts nothing back on it (HB-0899)', async () => {
    const w = world();
    const a = w.agent('a1');
    w.connection('c1');
    w.store.addConnectionRemoval('a1', SAM);
    // Something else holds the agent's connection turn while it is deleted.
    const holding = gate();
    const held = withConnectionLock('a1', () => holding.held);
    const attaching = w.google.vault.attach(a, OWNER, 'c1', false);
    w.store.setAgentState('a1', 'DELETING');
    w.store.scrubAgentResidue('a1');
    w.store.setAgentState('a1', 'DELETED');
    holding.open();
    await held;
    expect(await attaching).toEqual({ agentGone: true });
    expect(w.store.listAgentConnections('a1')).toEqual([]);
    expect(w.traced.map((t) => t.event)).not.toContain('connection.attached');
    // Given to another account since the route read it: not the caller's to attach to either.
    const b = { ...w.agent('b1', { owner: OTHER }), ownerId: OWNER };
    expect(await w.google.vault.attach(b, OWNER, 'c1', false)).toEqual({ agentGone: true });
    expect(w.store.listAgentConnections('b1')).toEqual([]);
  });

  it('a delete records the removal on every agent first, and a stopped one keeps it for its next start', async () => {
    const w = world({ oauthFetch: (async () => new Response('', { status: 200 })) as unknown as typeof fetch });
    w.agent('a1');
    w.connection('c1');
    w.store.attachConnection('a1', 'c1', false);
    expect(await w.google.vault.remove('c1', OTHER)).toBeUndefined();
    expect(w.store.getConnection('c1')).toBeDefined();
    expect(await w.google.vault.remove('c1', OWNER)).toEqual({ removed: true, pendingOn: 1 });
    expect(w.store.connectionRemovals('a1')).toEqual([SAM]);
    expect(w.store.listAgentConnections('a1')).toEqual([]);
    expect(w.secrets.map.has('connection/c1')).toBe(false);
  });

  it('a detach records the removal before the attachment goes; a stopped agent keeps it for its next start', async () => {
    const w = world();
    const a = w.agent('a1');
    w.connection('c1');
    w.store.attachConnection('a1', 'c1', false);
    expect(await w.google.vault.detach(a, OTHER, 'c1')).toBeNull();
    expect(w.store.listAgentConnections('a1')).toHaveLength(1);
    expect(await w.google.vault.detach(a, OWNER, 'c1')).toEqual({ detached: true, removed: false });
    expect(w.store.listAgentConnections('a1')).toEqual([]);
    expect(w.store.connectionRemovals('a1')).toEqual([SAM]);
    expect(w.traced.map((t) => t.event)).toEqual(['connection.detached']);
  });
});

describe('a connection deleted, revoked at Google unless another account shares its grant', () => {
  /** A client ID of Google's shape, in the made-up project numbered `project`. */
  const clientOf = (project: string, name: string) => [project, `${name}.apps.googleusercontent.com`].join('-');
  const revokes = () => {
    const calls: string[] = [];
    const oauthFetch = (async (url: string, init?: { body?: string }) => {
      calls.push(`${url} ${new URLSearchParams(init?.body ?? '').get('token')}`);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, oauthFetch };
  };

  it('another account holding it under a client of another Google Cloud project shares no grant: it is revoked (HB-0968)', async () => {
    const r = revokes();
    const w = world({ oauthFetch: r.oauthFetch });
    w.connection('c-a', { clientId: clientOf('100000000001', 'fixtureold') });
    w.connection('c-b', { owner: OTHER, clientId: clientOf('100000000002', 'fixturenew') });
    expect(await w.google.vault.remove('c-a', OWNER)).toEqual({ removed: true, pendingOn: 0 });
    expect(r.calls).toEqual([`https://oauth2.googleapis.com/revoke ${made('fixture', 'refresh', 'c-a')}`]);
    expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).toMatchObject({ revoked: true, keptForOtherAccount: false });
    expect(w.store.getConnection('c-b')).toBeDefined();
  });

  it('one of the same project (another client of it), the same client, or a client that cannot be placed: shared, not revoked', async () => {
    for (const [mine, theirs] of [
      [clientOf('100000000001', 'fixtureone'), clientOf('100000000001', 'fixturetwo')],
      [clientOf('100000000001', 'fixtureone'), clientOf('100000000001', 'fixtureone')],
      [CLIENT_A.clientId, CLIENT_B.clientId],
      [clientOf('100000000001', 'fixtureone'), CLIENT_B.clientId],
      [clientOf('100000000001', 'fixtureone'), null],
    ] as const) {
      const r = revokes();
      const w = world({ oauthFetch: r.oauthFetch });
      w.connection('c-a', { clientId: mine });
      // Another case of the address is the same account.
      w.store.insertConnection({ id: 'c-b', ownerId: OTHER, kind: 'google', email: SAM.toUpperCase(), services: ['gmail'], secretRef: 'connection/c-b', clientId: theirs });
      expect(await w.google.vault.remove('c-a', OWNER)).toEqual({ removed: true, pendingOn: 0 });
      expect(r.calls, `${mine} / ${theirs}`).toEqual([]);
      expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).toMatchObject({ revoked: false, keptForOtherAccount: true });
    }
  });

  /** Google at the fetch seam: a consent's code exchanged for `fresh`, the account SAM, and each revoke recorded (held while `revoking` is). */
  const google = (fresh: string, revoking?: Promise<void>) => {
    const revoked: string[] = [];
    const asked: string[] = [];
    const oauthFetch = (async (url: string, init?: { body?: string }) => {
      const u = String(url);
      asked.push(u.replace(/^https:\/\/[^/]+/, ''));
      if (u.includes('/revoke')) { await revoking; revoked.push(new URLSearchParams(init?.body ?? '').get('token') ?? ''); return new Response('', { status: 200 }); }
      if (u.includes('/token')) return new Response(JSON.stringify({ access_token: made('fixture', 'access'), refresh_token: fresh, scope: 'https://mail.google.com/' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ email: SAM }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { revoked, asked, oauthFetch };
  };
  const claim = { ownerId: OWNER, services: ['gmail'] };

  it('connected again while a delete takes it off its agents: the new consent stays, unrevoked (HB-0879)', async () => {
    const fresh = made('fixture', 'refresh', 'again');
    const g = google(fresh);
    const w = world({ oauthFetch: g.oauthFetch });
    w.agent('a1', { state: 'RUNNING' });
    w.connection('c1');
    w.store.attachConnection('a1', 'c1', false);
    const removing = gate();
    w.answer = async (script) => { if (script.includes('gog auth remove')) await removing.held; return ok(); };
    const deleting = w.google.vault.remove('c1', OWNER);
    await vi.waitFor(() => expect(w.calls.some((c) => c.script.includes('gog auth remove'))).toBe(true));
    // A consent takes a while: the reconnect's time is not the first connect's.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    expect(await w.google.client.link(claim, CLIENT_A, 'https://example.invalid/cb', 'code-1')).toMatchObject({ email: SAM, granted: ['gmail'] });
    removing.open();
    expect(await deleting).toEqual({ removed: false, connectedAgain: true, pendingOn: 0 });
    expect(w.store.getConnection('c1')).toMatchObject({ email: SAM });
    expect(await w.secrets.get('connection/c1')).toBe(fresh);
    expect(g.revoked).toEqual([]);
    // What the delete asked for still holds: it is off the agent.
    expect(w.store.listAgentConnections('a1')).toEqual([]);
  });

  it('connected again while a delete revokes it: the link waits, then saves its own token (HB-0879)', async () => {
    const fresh = made('fixture', 'refresh', 'again');
    const revoking = gate();
    const g = google(fresh, revoking.held);
    const w = world({ oauthFetch: g.oauthFetch });
    w.connection('c1');
    const deleting = w.google.vault.remove('c1', OWNER);
    await vi.waitFor(() => expect(g.asked).toEqual(['/revoke']));
    const linking = w.google.client.link(claim, CLIENT_A, 'https://example.invalid/cb', 'code-1');
    await new Promise((r) => setTimeout(r, 30));
    // The code is not exchanged while the delete revokes: Google would end the new grant with the old.
    expect(g.asked).toEqual(['/revoke']);
    revoking.open();
    expect(await deleting).toEqual({ removed: true, pendingOn: 0 });
    await linking;
    expect(g.revoked).toEqual([made('fixture', 'refresh', 'c1')]);
    const [now] = w.store.listConnections(OWNER);
    expect(now).toMatchObject({ email: SAM });
    expect(now!.id).not.toBe('c1');
    expect(await w.secrets.get(`connection/${now!.id}`)).toBe(fresh);
  });

  it("another account connecting the same address while the pass revokes it: its consent is exchanged after the revoke, and keeps its token (HB-0903)", async () => {
    const fresh = made('fixture', 'refresh', 'theirs');
    const revoking = gate();
    const g = google(fresh, revoking.held);
    const w = world({ oauthFetch: g.oauthFetch });
    w.connection('c1');
    w.store.retireConnection('c1'); // left by an earlier try
    const pass = w.google.vault.retryCleanups();
    await vi.waitFor(() => expect(g.asked).toEqual(['/revoke']));
    const linking = w.google.client.link({ ownerId: OTHER, services: ['gmail'] }, CLIENT_A, 'https://example.invalid/cb', 'code-1');
    await new Promise((r) => setTimeout(r, 30));
    const whileRevoking = [...g.asked];
    revoking.open(); // before any check, so a failed one leaves no turn held for the tests after
    // Not exchanged while the revoke is on its way: Google would end the new token with the grant.
    expect(whileRevoking).toEqual(['/revoke']);
    expect(await pass).toBe(1);
    expect(await linking).toMatchObject({ email: SAM, granted: ['gmail'] });
    expect(g.asked[0]).toBe('/revoke');
    expect(g.asked.slice(1)).toContain('/token');
    expect(w.traced.find((t) => t.event === 'connection.token_ended')?.detail).toMatchObject({ revoked: true, keptForOtherAccount: false });
    const [theirs] = w.store.listConnections(OTHER);
    expect(await w.secrets.get(`connection/${theirs!.id}`)).toBe(fresh);
  });

  it("another account's consent of the same address being exchanged when a delete judges the grant: the delete waits, sees it, and revokes nothing (HB-0903)", async () => {
    const fresh = made('fixture', 'refresh', 'theirs');
    const exchanging = gate();
    const asked: string[] = [];
    const oauthFetch = (async (url: string) => {
      const u = String(url).replace(/^https:\/\/[^/]+/, '');
      asked.push(u);
      if (u.includes('/revoke')) return new Response('', { status: 200 });
      if (u.includes('/token')) {
        await exchanging.held;
        return new Response(JSON.stringify({ access_token: made('fixture', 'access'), refresh_token: fresh, scope: 'https://mail.google.com/' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ email: SAM }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const w = world({ oauthFetch });
    w.connection('c1');
    const linking = w.google.client.link({ ownerId: OTHER, services: ['gmail'] }, CLIENT_A, 'https://example.invalid/cb', 'code-1');
    await vi.waitFor(() => expect(asked).toEqual(['/token']));
    const deleting = w.google.vault.remove('c1', OWNER);
    await new Promise((r) => setTimeout(r, 30));
    const whileExchanging = [...asked];
    exchanging.open(); // before any check, so a failed one leaves no turn held for the tests after
    expect(whileExchanging).toEqual(['/token']);
    await linking;
    expect(await deleting).toEqual({ removed: true, pendingOn: 0 });
    // Their consent is on the grant: nothing revoked, and only the old token is gone.
    expect(asked).not.toContain('/revoke');
    expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).toMatchObject({ revoked: false, keptForOtherAccount: true });
    expect(w.secrets.map.has('connection/c1')).toBe(false);
    const [theirs] = w.store.listConnections(OTHER);
    expect(await w.secrets.get(`connection/${theirs!.id}`)).toBe(fresh);
  });

  it('two first consents of one account finishing together leave one connection and one stored token (HB-0900)', async () => {
    // Each consent's exchange answers with a token of its own, the second first.
    const tokens = [made('fixture', 'refresh', 'one'), made('fixture', 'refresh', 'two')];
    const exchanges: Array<() => void> = [];
    const oauthFetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/token')) {
        const refresh = tokens.shift()!;
        await new Promise<void>((r) => exchanges.push(r));
        return new Response(JSON.stringify({ access_token: made('fixture', 'access'), refresh_token: refresh, scope: 'https://mail.google.com/' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ email: SAM }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const w = world({ oauthFetch });
    const first = w.google.client.link(claim, CLIENT_A, 'https://example.invalid/cb', 'code-1');
    const second = w.google.client.link(claim, CLIENT_A, 'https://example.invalid/cb', 'code-2');
    // Only one exchange is under way at a time: the owner's vault turn.
    await vi.waitFor(() => expect(exchanges).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(exchanges).toHaveLength(1);
    exchanges.shift()!();
    await first;
    await vi.waitFor(() => expect(exchanges).toHaveLength(1));
    exchanges.shift()!();
    await second;
    const conns = w.store.listConnections(OWNER);
    expect(conns).toHaveLength(1);
    const stored = [...w.secrets.map.keys()].filter((k) => k.startsWith('connection/'));
    expect(stored).toEqual([`connection/${conns[0]!.id}`]);
    expect(await w.secrets.get(stored[0]!)).toBe(made('fixture', 'refresh', 'two'));
  });

  it('a token the secret store would not delete stays on record, and the pass deletes it, after a restart too (HB-0901)', async () => {
    const r = revokes();
    const w = world({ oauthFetch: r.oauthFetch });
    w.connection('c1');
    const deleteNow = w.secrets.delete.bind(w.secrets);
    w.secrets.delete = async () => { throw new Error('the secret store is locked'); };
    // Revoked at Google: not "still being ended" there (HB-1336 review).
    expect(await w.google.vault.remove('c1', OWNER)).toEqual({ removed: true, pendingOn: 0 });
    expect(w.store.getConnection('c1')).toBeUndefined();
    expect(w.secrets.map.has('connection/c1')).toBe(true);
    expect(w.store.connectionCleanups()).toEqual([expect.objectContaining({
      secretRef: 'connection/c1', kind: 'google', ownerId: OWNER, email: SAM, clientId: CLIENT_A.clientId, tries: 1, error: expect.stringContaining('the secret store is locked'),
    })]);
    expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).toMatchObject({ tokenLeft: true });
    // A pass while the store still refuses: kept, the try counted.
    expect(await w.google.vault.retryCleanups()).toBe(0);
    expect(w.store.connectionCleanups()[0]!.tries).toBe(2);
    // The process ends; the next one, on the same database, finishes it.
    w.secrets.delete = deleteNow;
    w.restart();
    expect(await w.google.vault.retryCleanups()).toBe(1);
    expect(w.secrets.map.has('connection/c1')).toBe(false);
    expect(w.store.connectionCleanups()).toEqual([]);
    expect(w.traced.map((t) => t.event)).toContain('connection.token_ended');
    // Nothing is left to try.
    expect(await w.google.vault.retryCleanups()).toBe(0);
  });

  it('a connection whose token was never stored, or is gone already, ends at once: nothing is revoked or kept (HB-0901)', async () => {
    const r = revokes();
    const w = world({ oauthFetch: r.oauthFetch });
    w.store.insertConnection({ id: 'c9', ownerId: OWNER, kind: 'google', email: SAM, services: ['gmail'], secretRef: 'connection/c9', clientId: CLIENT_A.clientId });
    expect(await w.google.vault.remove('c9', OWNER)).toEqual({ removed: true, pendingOn: 0 });
    expect(r.calls).toEqual([]);
    expect(w.store.connectionCleanups()).toEqual([]);
    expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).toMatchObject({ revoked: false, keptForOtherAccount: false });
    expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).not.toHaveProperty('tokenLeft');
    // One a store could not read is another thing: kept, and why.
    w.connection('c8');
    w.secrets.get = async () => { throw new Error('the secret store is locked'); };
    await w.google.vault.remove('c8', OWNER);
    expect(w.store.connectionCleanups()).toEqual([expect.objectContaining({ secretRef: 'connection/c8', error: 'its token could not be read: the secret store is locked' })]);
    expect(r.calls).toEqual([]);
  });

  it('the pass runs as the service is built and then on its timer, and stop() ends it (HB-0901)', async () => {
    vi.useFakeTimers();
    const w = world({ sweepEveryMs: 60_000, oauthFetch: (async () => new Response('', { status: 200 })) as unknown as typeof fetch });
    w.connection('c1');
    w.store.retireConnection('c1');
    // As built: nothing was left then. Then a token is left, and the timer finds it.
    expect(w.store.connectionCleanups()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.store.connectionCleanups()).toEqual([]);
    expect(w.secrets.map.has('connection/c1')).toBe(false);
    // One left before the next process starts is tried as it is built.
    w.connection('c2');
    w.store.retireConnection('c2');
    w.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(w.store.connectionCleanups()).toEqual([]);
    w.google.stop();
    w.connection('c3');
    w.store.retireConnection('c3');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(w.store.connectionCleanups()).toHaveLength(1);
  });

  it("revoked at Google with only Hatchabot's copy kept by the secret store: never said not confirmed at Google, and listed as a copy left (HB-1336 review)", async () => {
    for (const [what, setUp] of [
      ['revoked', (w: ReturnType<typeof world>) => w.connection('c1')],
      ['kept for another connection of its grant', (w: ReturnType<typeof world>) => { w.connection('c1'); w.connection('c-other', { owner: OTHER }); }],
    ] as const) {
      const r = revokes();
      const w = world({ oauthFetch: r.oauthFetch });
      setUp(w);
      w.secrets.delete = async () => { throw new Error('the secret store is locked'); };
      expect(await w.google.vault.remove('c1', OWNER), what).toEqual({ removed: true, pendingOn: 0 });
      expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail, what).toMatchObject({ tokenLeft: true });
      expect((await w.google.vault.list(OWNER)).ending, what).toEqual([expect.objectContaining({ copyLeft: true, lastAnswer: 'the secret store did not delete it: the secret store is locked' })]);
    }
    // Not confirmed at Google: no copy-left mark, and the answer says so.
    const w = world({ oauthFetch: revokeAnswers(status(503)).oauthFetch });
    w.connection('c1');
    expect(await w.google.vault.remove('c1', OWNER)).toEqual({ removed: true, pendingOn: 0, stillEnding: true });
    expect((await w.google.vault.list(OWNER)).ending[0]).not.toHaveProperty('copyLeft');
  });

  it('at the start, a token an older release left with nothing naming it is deleted; one a connection or a cleanup names stays (HB-0901)', async () => {
    const db = new Database(':memory:');
    const store = new Store(db);
    const secrets = new LocalSecretStore(db, Buffer.alloc(32, 7));
    for (const [id, email] of [['c-live', SAM], ['c-left', 'pat@example.com']] as const) {
      store.insertConnection({ id, ownerId: OWNER, kind: 'google', email, services: ['gmail'], secretRef: `connection/${id}`, clientId: CLIENT_A.clientId });
    }
    expect(store.retireConnection('c-left')).toMatchObject({ secretRef: 'connection/c-left' });
    for (const id of ['c-live', 'c-left', 'c-gone']) await secrets.put(`connection/${id}`, made('fixture', 'refresh', id));
    expect(store.sweepOrphanAgentSecrets()).toEqual(['connection/c-gone']);
    const left = (db.prepare('SELECT ref FROM secrets ORDER BY ref').all() as Array<{ ref: string }>).map((x) => x.ref);
    expect(left).toEqual(['connection/c-left', 'connection/c-live']);
  });

  /** Google at the fetch seam answering each revoke in turn from `answers` (the last one again once they run out), and the tokens it was asked to revoke. */
  const revokeAnswers = (...answers: Array<() => Response>) => {
    const asked: string[] = [];
    const oauthFetch = (async (_url: string, init?: { body?: string }) => {
      asked.push(new URLSearchParams(init?.body ?? '').get('token') ?? '');
      return (answers.length > 1 ? answers.shift()! : answers[0]!)();
    }) as unknown as typeof fetch;
    return { asked, oauthFetch };
  };
  const status = (code: number, body = '') => () => new Response(body, { status: code, headers: { 'content-type': 'application/json' } });
  const noAnswer = () => { throw new Error('connect ETIMEDOUT'); };

  it('a revoke Google does not confirm keeps the token on record, and the pass revokes it, after a restart too (HB-1203)', async () => {
    const g = revokeAnswers(status(503), noAnswer, status(200));
    const w = world({ oauthFetch: g.oauthFetch });
    w.connection('c1');
    expect(await w.google.vault.remove('c1', OWNER)).toEqual({ removed: true, pendingOn: 0, stillEnding: true });
    expect(w.store.getConnection('c1')).toBeUndefined();
    // Kept: revoking it is what is still owed.
    expect(w.secrets.map.has('connection/c1')).toBe(true);
    expect(w.store.connectionCleanups()).toEqual([expect.objectContaining({ secretRef: 'connection/c1', tries: 1, error: 'Google did not revoke it: Google answered 503' })]);
    expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).toMatchObject({ revoked: false, keptForOtherAccount: false, tokenLeft: true });
    // A pass Google does not answer: still kept, and why.
    expect(await w.google.vault.retryCleanups()).toBe(0);
    expect(w.store.connectionCleanups()[0]).toMatchObject({ tries: 2, error: expect.stringContaining('no answer from Google') });
    // The next process revokes it, then deletes it.
    w.restart();
    expect(await w.google.vault.retryCleanups()).toBe(1);
    expect(g.asked).toEqual(Array(3).fill(made('fixture', 'refresh', 'c1')));
    expect(w.secrets.map.has('connection/c1')).toBe(false);
    expect(w.store.connectionCleanups()).toEqual([]);
    expect(w.traced.find((t) => t.event === 'connection.token_ended')?.detail).toMatchObject({ revoked: true, keptForOtherAccount: false, tries: 3 });
  });

  it('Google answering that it knows no such token (expired, or revoked already) ends it; another 400 does not (HB-1203)', async () => {
    const gone = revokeAnswers(status(400, JSON.stringify({ error: 'invalid_token', error_description: 'Token expired or revoked' })));
    const w = world({ oauthFetch: gone.oauthFetch });
    w.connection('c1');
    await w.google.vault.remove('c1', OWNER);
    expect(w.secrets.map.has('connection/c1')).toBe(false);
    expect(w.store.connectionCleanups()).toEqual([]);
    // Said as it was: Google had ended it, this revoked nothing.
    expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).toMatchObject({ revoked: false, alreadyGone: true });
    const other = revokeAnswers(status(400, JSON.stringify({ error: 'invalid_request' })));
    const w2 = world({ oauthFetch: other.oauthFetch });
    w2.connection('c1');
    await w2.google.vault.remove('c1', OWNER);
    expect(w2.secrets.map.has('connection/c1')).toBe(true);
    expect(w2.store.connectionCleanups()[0]!.error).toBe('Google did not revoke it: Google answered 400 (invalid_request)');
  });

  it("only Google's own 200 ends a token: a captive portal's page, a redirect or another 2xx does not, and the pass asks again (HB-1345)", async () => {
    const at = (url: string, res: Response) => { Object.defineProperty(res, 'url', { value: url }); return res; };
    const notGoogle: Array<[string, () => Response]> = [
      ['a portal\'s page', () => new Response('<html><body>Sign in to the guest network</body></html>', { status: 200, headers: { 'content-type': 'text/html' } })],
      ['a page sent on from elsewhere', () => at('http://portal.example.org/login', new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))],
      ['a redirect', () => new Response('', { status: 302, headers: { location: 'http://portal.example.org/' } })],
      ['another 2xx', () => new Response('', { status: 204 })],
      ['a JSON list', () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })],
    ];
    for (const [what, answer] of notGoogle) {
      const inits: Array<RequestInit | undefined> = [];
      const g = revokeAnswers(answer);
      const w = world({ oauthFetch: (async (u: string, init?: RequestInit) => { inits.push(init); return g.oauthFetch(u, init as never); }) as unknown as typeof fetch });
      w.connection('c1');
      await w.google.vault.remove('c1', OWNER);
      // Kept, for the pass to ask Google again.
      expect(w.secrets.map.has('connection/c1'), what).toBe(true);
      expect(w.store.connectionCleanups(), what).toEqual([expect.objectContaining({ secretRef: 'connection/c1', tries: 1 })]);
      expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail, what).toMatchObject({ revoked: false, tokenLeft: true });
      // Never a redirect followed.
      expect(inits[0]?.redirect, what).toBe('manual');
    }
    expect((await (async () => {
      const w = world({ oauthFetch: revokeAnswers(notGoogle[0]![1]).oauthFetch });
      w.connection('c1');
      await w.google.vault.remove('c1', OWNER);
      return w.store.connectionCleanups()[0]!.error;
    })())).toBe("Google did not revoke it: an answer that was not Google's (200, text/html): a captive portal or a proxy in the way?");
    // Google's own: an empty body, or a JSON object, from the revoke address.
    for (const answer of [() => new Response('', { status: 200 }), () => at('https://oauth2.googleapis.com/revoke', new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))]) {
      const w = world({ oauthFetch: revokeAnswers(answer).oauthFetch });
      w.connection('c1');
      await w.google.vault.remove('c1', OWNER);
      expect(w.secrets.map.has('connection/c1')).toBe(false);
      expect(w.store.connectionCleanups()).toEqual([]);
      expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).toMatchObject({ revoked: true });
    }
  });

  it("a 200 whose answer is cut off part way is no revoke: the token is kept, and the pass asks again (HB-1345 review)", async () => {
    const cutOff = () => new Response(new ReadableStream({ start(c) { c.error(new Error('socket hang up')); } }), { status: 200 });
    const w = world({ oauthFetch: revokeAnswers(cutOff).oauthFetch });
    w.connection('c1');
    expect(await w.google.vault.remove('c1', OWNER)).toEqual({ removed: true, pendingOn: 0, stillEnding: true });
    expect(w.secrets.map.has('connection/c1')).toBe(true);
    expect(w.store.connectionCleanups()).toEqual([expect.objectContaining({ secretRef: 'connection/c1', tries: 1, error: 'Google did not revoke it: the answer was cut off' })]);
    expect(w.traced.find((t) => t.event === 'connection.unlinked')?.detail).toMatchObject({ revoked: false, tokenLeft: true });
  });

  it("the pass says how a token it ended went, and counts the tries as they are when its turn comes (HB-1203)", async () => {
    // The delete's own try is held at Google, and refused; the pass listed it meanwhile.
    const held = gate();
    const answers = [status(503), status(400, JSON.stringify({ error: 'invalid_token' }))];
    const asked: string[] = [];
    const oauthFetch = (async () => { asked.push('revoke'); if (asked.length === 1) await held.held; return answers.shift()!(); }) as unknown as typeof fetch;
    const w = world({ oauthFetch });
    w.connection('c1');
    const deleting = w.google.vault.remove('c1', OWNER);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(w.store.connectionCleanups()[0]!.tries).toBe(0);
    const pass = w.google.vault.retryCleanups();
    held.open();
    await deleting;
    expect(await pass).toBe(1);
    expect(asked).toHaveLength(2);
    expect(w.traced.find((t) => t.event === 'connection.token_ended')?.detail).toEqual({ email: SAM, revoked: false, alreadyGone: true, keptForOtherAccount: false, tries: 2 });
    expect(eventLabel('connection.token_ended', { revoked: false, alreadyGone: true })).toBe("a disconnected account's token, left by an earlier try, is now removed: Google had ended it already");
    expect(eventLabel('connection.token_ended', { revoked: true })).toBe("a disconnected account's token, left by an earlier try, is now revoked at Google and removed");
  });

  it('a revoke Google has not confirmed in seven days, over a day of tries, is given up: the token is deleted, its record goes, and its owner is told what was tried (HB-1203)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-02T09:00:00Z');
    const DAY = 24 * 60 * 60_000;
    /** The tries counted so far, as if the pass had run that often since the delete. */
    const triedSoFar = (on: World, n: number) => on.db.prepare('UPDATE connection_cleanups SET tries = ?').run(n);
    vi.setSystemTime(t0);
    const g = revokeAnswers(status(503));
    const w = world({ oauthFetch: g.oauthFetch });
    w.connection('c1');
    await w.google.vault.remove('c1', OWNER);
    // Tried all day long, but six days on: still asking.
    vi.setSystemTime(t0 + 6 * DAY);
    triedSoFar(w, 500);
    expect(await w.google.vault.retryCleanups()).toBe(0);
    expect(w.told).toEqual([]);
    // Eight days on, but the machine was off: its first pass, maybe before the network answers, is no reason to stop.
    triedSoFar(w, 1);
    vi.setSystemTime(t0 + 8 * DAY);
    expect(await w.google.vault.retryCleanups()).toBe(0);
    expect(w.store.connectionCleanups()).toEqual([expect.objectContaining({ tries: 2 })]);
    expect(w.secrets.map.has('connection/c1')).toBe(true);
    // Short of a day of tries (144 at the ten-minute pace): still asking.
    triedSoFar(w, 142);
    expect(await w.google.vault.retryCleanups()).toBe(0);
    expect(w.told).toEqual([]);
    // The 144th try, Google still not confirming: given up.
    expect(await w.google.vault.retryCleanups()).toBe(1);
    expect(w.secrets.map.has('connection/c1')).toBe(false);
    expect(w.store.connectionCleanups()).toEqual([]);
    expect(w.told).toEqual([{ ownerId: OWNER, text: `Hatchabot asked Google 144 times over 8 days to end its access to ${SAM}, and Google never confirmed it. It has stopped asking and deleted its copy of the token. To be sure the access is gone, remove it by hand: in that Google Account, Security → Your connections to third-party apps & services. It is listed in Hatchabot under ⚙ Settings → Connections until you mark it done.` }]);
    const given = w.traced.find((t) => t.event === 'connection.revoke_given_up');
    expect(given?.detail).toEqual({ email: SAM, since: new Date(t0).toISOString(), tries: 144, days: 8, error: 'Google answered 503', told: true });
    expect(w.traced.map((t) => t.event)).not.toContain('connection.token_ended');
    expect(eventLabel('connection.revoke_given_up', given!.detail)).toBe("Google never confirmed the revoke of a disconnected account's token in 144 tries over 8 days: Hatchabot deleted it, and its access is to be removed by hand in the Google Account (the owner was told)");
    const asked = g.asked.length;
    expect(await w.google.vault.retryCleanups()).toBe(0);
    expect(g.asked).toHaveLength(asked);

    // No chat app reaches the owner: given up all the same, and the log says nobody was told.
    vi.setSystemTime(t0);
    const g2 = revokeAnswers(noAnswer);
    const w2 = world({ oauthFetch: g2.oauthFetch });
    w2.chatTakes = false;
    w2.connection('c1');
    await w2.google.vault.remove('c1', OWNER);
    vi.setSystemTime(t0 + 8 * DAY);
    triedSoFar(w2, 1000);
    expect(await w2.google.vault.retryCleanups()).toBe(1);
    expect(w2.store.connectionCleanups()).toEqual([]);
    expect(w2.traced.find((t) => t.event === 'connection.revoke_given_up')?.detail).toMatchObject({ told: false, tries: 1001, error: expect.stringContaining('no answer from Google') });
    expect(eventLabel('connection.revoke_given_up', { told: false, tries: 1001, days: 8 })).not.toContain('the owner was told');

    // Confirmed late, after seven days and a day of tries: revoked, as any other.
    vi.setSystemTime(t0);
    const g3 = revokeAnswers(status(503), status(200));
    const w3 = world({ oauthFetch: g3.oauthFetch });
    w3.connection('c1');
    await w3.google.vault.remove('c1', OWNER);
    vi.setSystemTime(t0 + 9 * DAY);
    triedSoFar(w3, 1000);
    expect(await w3.google.vault.retryCleanups()).toBe(1);
    expect(w3.told).toEqual([]);
    expect(w3.traced.find((t) => t.event === 'connection.token_ended')?.detail).toMatchObject({ revoked: true });
  });

  it("the Connections page lists a deleted account's access still being ended, and one given up until its owner marks it done (HB-1336)", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-02T09:00:00Z');
    vi.setSystemTime(t0);
    const g = revokeAnswers(status(503));
    const w = world({ oauthFetch: g.oauthFetch });
    w.connection('c1');
    w.connection('c-other', { owner: OTHER, email: 'robin@example.org' });
    expect(await w.google.vault.remove('c1', OWNER)).toMatchObject({ removed: true, stillEnding: true });
    await w.google.vault.remove('c-other', OTHER);
    const listed = await w.google.vault.list(OWNER);
    expect(listed.connections).toEqual([]);
    expect(listed.ending).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{16}$/), email: SAM, since: new Date(t0).toISOString(), tries: 1,
      lastTriedAt: new Date(t0).toISOString(), lastAnswer: 'Google did not revoke it: Google answered 503', givenUpAt: null }]);
    // Never its token, nor where it is kept; never another account's.
    expect(JSON.stringify(listed)).not.toContain('connection/c1');
    expect(JSON.stringify(listed)).not.toContain(made('fixture', 'refresh', 'c1'));
    expect(JSON.stringify(listed)).not.toContain('robin@example.org');
    const id = listed.ending[0]!.id;
    // Still being asked: not the owner's to drop.
    expect(w.google.vault.dismissEnding(OWNER, id)).toBe(false);
    // Given up after a week and a day of tries: still listed, as a notice, and never asked again.
    vi.setSystemTime(t0 + 8 * 24 * 60 * 60_000);
    w.db.prepare('UPDATE connection_cleanups SET tries = 143').run();
    expect(await w.google.vault.retryCleanups()).toBe(2);
    expect(w.secrets.map.has('connection/c1')).toBe(false);
    const after = (await w.google.vault.list(OWNER)).ending;
    expect(after).toEqual([expect.objectContaining({ id, email: SAM, tries: 144, givenUpAt: new Date(t0 + 8 * 24 * 60 * 60_000).toISOString() })]);
    const asked = g.asked.length;
    w.restart();
    expect(await w.google.vault.retryCleanups()).toBe(0);
    expect(g.asked).toHaveLength(asked);
    expect((await w.google.vault.list(OWNER)).ending).toHaveLength(1);
    // Marked done by another account: refused; by its owner: gone.
    expect(w.google.vault.dismissEnding(OTHER, id)).toBe(false);
    expect(w.google.vault.dismissEnding(OWNER, id)).toBe(true);
    expect((await w.google.vault.list(OWNER)).ending).toEqual([]);
    expect(w.google.vault.dismissEnding(OWNER, id)).toBe(false);
    // The other account's, given up too, goes with that account when it is removed.
    expect((await w.google.vault.list(OTHER)).ending).toHaveLength(1);
    w.store.deleteLocalAccount(OTHER);
    expect((await w.google.vault.list(OTHER)).ending).toEqual([]);
  });

  it("giving up a revoke Google never confirmed while the secret store keeps the token is never listed as Google's part done (HB-1336 review)", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-02T09:00:00Z');
    vi.setSystemTime(t0);
    const w = world({ oauthFetch: revokeAnswers(status(503)).oauthFetch });
    w.connection('c1');
    await w.google.vault.remove('c1', OWNER);
    vi.setSystemTime(t0 + 8 * 24 * 60 * 60_000);
    w.db.prepare('UPDATE connection_cleanups SET tries = 143').run();
    const deleteNow = w.secrets.delete.bind(w.secrets);
    w.secrets.delete = async () => { throw new Error('the secret store is locked'); };
    expect(await w.google.vault.retryCleanups()).toBe(0);
    const [row] = (await w.google.vault.list(OWNER)).ending;
    expect(row).toMatchObject({ givenUpAt: null, lastAnswer: 'Google did not revoke it: Google answered 503; the secret store did not delete its copy: the secret store is locked' });
    expect(row).not.toHaveProperty('copyLeft');
    // The next pass, the store working again, gives it up as it would have.
    w.secrets.delete = deleteNow;
    expect(await w.google.vault.retryCleanups()).toBe(1);
    expect((await w.google.vault.list(OWNER)).ending).toEqual([expect.objectContaining({ givenUpAt: expect.any(String) })]);
    expect(w.secrets.map.has('connection/c1')).toBe(false);
  });

  it("a token still being ended when its account is removed is still revoked, and given up it is dropped, not kept as a notice nobody can read", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-02T09:00:00Z');
    vi.setSystemTime(t0);
    const g = revokeAnswers(status(503));
    const w = world({ oauthFetch: g.oauthFetch });
    w.connection('c-other', { owner: OTHER, email: 'robin@example.org' });
    w.connection('c-again', { owner: OTHER, email: 'kit@example.org' });
    await w.google.vault.remove('c-other', OTHER);
    await w.google.vault.remove('c-again', OTHER);
    w.store.deleteLocalAccount(OTHER);
    expect((await w.google.vault.list(OTHER)).ending).toEqual([]);
    // Both still asked, though nobody can see them now.
    g.asked.length = 0;
    expect(await w.google.vault.retryCleanups()).toBe(0);
    expect(g.asked).toHaveLength(2);
    vi.setSystemTime(t0 + 8 * 24 * 60 * 60_000);
    w.db.prepare('UPDATE connection_cleanups SET tries = 143').run();
    expect(await w.google.vault.retryCleanups()).toBe(2);
    expect(w.secrets.map.has('connection/c-other')).toBe(false);
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM connection_cleanups').get()).toEqual({ n: 0 });
    expect(w.told).toEqual([]);
    expect(w.traced.filter((t) => t.event === 'connection.revoke_given_up').map((t) => t.detail)).toEqual([
      expect.objectContaining({ told: false, ownerRemoved: true }), expect.objectContaining({ told: false, ownerRemoved: true }),
    ]);
  });

  it('the account connected again before the pass: the old token is deleted, not revoked, and the new one stays (HB-1203)', async () => {
    const g = revokeAnswers(status(503), status(200));
    const w = world({ oauthFetch: g.oauthFetch });
    w.connection('c1');
    await w.google.vault.remove('c1', OWNER);
    expect(g.asked).toHaveLength(1);
    // Connected again, with the same client: one grant at Google, which the old token's revoke would end.
    w.connection('c2');
    expect(await w.google.vault.retryCleanups()).toBe(1);
    expect(g.asked).toHaveLength(1);
    expect(w.secrets.map.has('connection/c1')).toBe(false);
    expect(w.secrets.map.has('connection/c2')).toBe(true);
    expect(w.traced.find((t) => t.event === 'connection.token_ended')?.detail).toMatchObject({ revoked: false, keptForOtherAccount: true });
  });

  it('the last two accounts holding it delete theirs at once: the grant is revoked, once both are gone (HB-0903)', async () => {
    const g = revokeAnswers(status(200));
    const w = world({ oauthFetch: g.oauthFetch });
    w.connection('c-a');
    w.connection('c-b', { owner: OTHER });
    const [a, b] = await Promise.all([w.google.vault.remove('c-a', OWNER), w.google.vault.remove('c-b', OTHER)]);
    expect(a).toEqual({ removed: true, pendingOn: 0 });
    expect(b).toEqual({ removed: true, pendingOn: 0 });
    expect(w.store.listConnections(OWNER)).toEqual([]);
    expect(w.store.listConnections(OTHER)).toEqual([]);
    // Revoking either token ends the one grant; neither is kept back for the other.
    expect(g.asked.length).toBeGreaterThanOrEqual(1);
    expect([...w.secrets.map.keys()].filter((k) => k.startsWith('connection/'))).toEqual([]);
    expect(w.store.connectionCleanups()).toEqual([]);
    // While one of them stays, it is kept for it: one removal alone revokes nothing.
    const g2 = revokeAnswers(status(200));
    const w2 = world({ oauthFetch: g2.oauthFetch });
    w2.connection('c-a');
    w2.connection('c-b', { owner: OTHER });
    await w2.google.vault.remove('c-a', OWNER);
    expect(g2.asked).toEqual([]);
    expect(w2.store.getConnection('c-b')).toBeDefined();
    await w2.google.vault.remove('c-b', OTHER);
    expect(g2.asked).toEqual([made('fixture', 'refresh', 'c-b')]);
    // The same account's own other connection of it (another case of the address) keeps it too.
    const g3 = revokeAnswers(status(200));
    const w3 = world({ oauthFetch: g3.oauthFetch });
    w3.connection('c-a');
    w3.connection('c-b', { email: SAM.toUpperCase() });
    await w3.google.vault.remove('c-a', OWNER);
    expect(g3.asked).toEqual([]);
    expect(w3.secrets.map.has('connection/c-a')).toBe(false);
  });

  it('nobody else holding it: revoked', async () => {
    const r = revokes();
    const w = world({ oauthFetch: r.oauthFetch });
    w.connection('c-a');
    w.connection('c-other-mail', { owner: OTHER, email: 'pat@example.com' });
    await w.google.vault.remove('c-a', OWNER);
    expect(r.calls).toHaveLength(1);
  });

  it('connected again with a client of another project: the token it replaces is revoked once the new one is stored (HB-1338)', async () => {
    const fresh = made('fixture', 'refresh', 'again');
    const old = made('fixture', 'refresh', 'c1');
    const newClient = { clientId: clientOf('100000000002', 'fixturenew'), clientSecret: made('fixture', 'new', 'value') };
    const g = google(fresh);
    const w = world({ oauthFetch: g.oauthFetch });
    w.connection('c1', { clientId: clientOf('100000000001', 'fixtureold') });
    expect(await w.google.client.link(claim, newClient, 'https://example.invalid/cb', 'code-1')).toMatchObject({ email: SAM, granted: ['gmail'] });
    expect(g.revoked).toEqual([old]);
    expect(g.asked.indexOf('/revoke')).toBeGreaterThan(g.asked.indexOf('/token'));
    expect(await w.secrets.get('connection/c1')).toBe(fresh);
    expect(w.store.getConnection('c1')).toMatchObject({ clientId: newClient.clientId });
    expect(w.traced.find((t) => t.event === 'connection.linked')?.detail).toMatchObject({ email: SAM, oldTokenRevoked: true });
  });

  it('connected again under the same grant, or with another account holding the old one: nothing is revoked (HB-1338)', async () => {
    const fresh = made('fixture', 'refresh', 'again');
    const oldProject = clientOf('100000000001', 'fixtureold');
    for (const [linkWith, otherHolds] of [
      [{ clientId: oldProject, clientSecret: made('fixture', 'same', 'value') }, false], // the same client: one grant, which a revoke would end
      [{ clientId: clientOf('100000000001', 'fixturesibling'), clientSecret: made('fixture', 'sibling', 'value') }, false], // another client of the same project
      [CLIENT_B, false], // a client that cannot be placed: taken as shared
      [{ clientId: clientOf('100000000002', 'fixturenew'), clientSecret: made('fixture', 'new', 'value') }, true], // another account holds the old grant
    ] as const) {
      const g = google(fresh);
      const w = world({ oauthFetch: g.oauthFetch });
      w.connection('c1', { clientId: oldProject });
      if (otherHolds) w.connection('c-other', { owner: OTHER, clientId: oldProject });
      expect(await w.google.client.link(claim, linkWith, 'https://example.invalid/cb', 'code-1')).toMatchObject({ granted: ['gmail'] });
      expect(g.revoked, linkWith.clientId).toEqual([]);
      expect(await w.secrets.get('connection/c1')).toBe(fresh);
      expect(w.traced.find((t) => t.event === 'connection.linked')?.detail).not.toHaveProperty('oldTokenRevoked');
    }
  });

  it('a revoke of the replaced token that Google does not confirm leaves the reconnect done, and is logged (HB-1338)', async () => {
    const fresh = made('fixture', 'refresh', 'again');
    const newClient = { clientId: clientOf('100000000002', 'fixturenew'), clientSecret: made('fixture', 'new', 'value') };
    const oauthFetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/revoke')) return new Response('{"error":"backend_error"}', { status: 503 });
      if (u.includes('/token')) return new Response(JSON.stringify({ access_token: made('fixture', 'access'), refresh_token: fresh, scope: 'https://mail.google.com/' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ email: SAM }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const w = world({ oauthFetch });
    w.connection('c1', { clientId: clientOf('100000000001', 'fixtureold') });
    expect(await w.google.client.link(claim, newClient, 'https://example.invalid/cb', 'code-1')).toMatchObject({ email: SAM, granted: ['gmail'] });
    expect(await w.secrets.get('connection/c1')).toBe(fresh);
    expect(w.traced.find((t) => t.event === 'connection.linked')?.detail).toMatchObject({ oldTokenNotRevoked: 'Google answered 503 (backend_error)' });
    expect(w.warned).toContain('connection.replaced_token_not_revoked');
  });

  it("a replaced token whose revoke Google does not confirm is kept on record, and the pass revokes it, after a restart too (HB-1396)", async () => {
    const fresh = made('fixture', 'refresh', 'again');
    const old = made('fixture', 'refresh', 'c1');
    const oldClient = clientOf('100000000001', 'fixtureold');
    const newClient = { clientId: clientOf('100000000002', 'fixturenew'), clientSecret: made('fixture', 'new', 'value') };
    const revokeAnswer: Array<() => Response> = [() => new Response('{"error":"backend_error"}', { status: 503 }), () => new Response('', { status: 200 })];
    const revoked: string[] = [];
    const oauthFetch = (async (url: string, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes('/revoke')) { revoked.push(new URLSearchParams(init?.body ?? '').get('token') ?? ''); return (revokeAnswer.length > 1 ? revokeAnswer.shift()! : revokeAnswer[0]!)(); }
      if (u.includes('/token')) return new Response(JSON.stringify({ access_token: made('fixture', 'access'), refresh_token: fresh, scope: 'https://mail.google.com/' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ email: SAM }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const w = world({ oauthFetch });
    w.connection('c1', { clientId: oldClient });
    expect(await w.google.client.link(claim, newClient, 'https://example.invalid/cb', 'code-1')).toMatchObject({ email: SAM, granted: ['gmail'] });
    expect(await w.secrets.get('connection/c1')).toBe(fresh);
    expect(w.traced.find((t) => t.event === 'connection.linked')?.detail).toMatchObject({ oldTokenNotRevoked: 'Google answered 503 (backend_error)', triedAgainLater: true });
    // The replaced token, under a ref of its own, with a record of it still to end.
    const [rec] = w.store.connectionCleanups();
    expect(rec).toMatchObject({ secretRef: expect.stringMatching(/^connection\/c1\/replaced\/[0-9a-f]{8}$/), ownerId: OWNER, email: SAM, clientId: oldClient, tries: 1, error: 'Google did not revoke it: Google answered 503 (backend_error)' });
    expect(await w.secrets.get(rec!.secretRef)).toBe(old);
    expect((await w.google.vault.list(OWNER)).ending).toEqual([expect.objectContaining({ email: SAM, replaced: true, givenUpAt: null })]);
    // The next process's pass revokes the old token, never the new one, and deletes its copy.
    w.restart();
    expect(await w.google.vault.retryCleanups()).toBe(1);
    expect(revoked).toEqual([old, old]);
    expect(w.secrets.map.has(rec!.secretRef)).toBe(false);
    expect(await w.secrets.get('connection/c1')).toBe(fresh);
    expect(w.store.getConnection('c1')).toMatchObject({ clientId: newClient.clientId });
    expect(w.store.connectionCleanups()).toEqual([]);
    const ended = w.traced.find((t) => t.event === 'connection.token_ended')!;
    expect(ended.detail).toMatchObject({ revoked: true, keptForOtherAccount: false, replaced: true });
    expect(eventLabel('connection.token_ended', ended.detail)).toBe("a reconnected account's earlier token, left by an earlier try, is now revoked at Google and removed");
  });

  it("a replaced token revoked at once, or kept for another account's grant, leaves no copy or record (HB-1396)", async () => {
    const fresh = made('fixture', 'refresh', 'again');
    const oldClient = clientOf('100000000001', 'fixtureold');
    const newClient = { clientId: clientOf('100000000002', 'fixturenew'), clientSecret: made('fixture', 'new', 'value') };
    for (const otherHolds of [false, true]) {
      const g = google(fresh);
      const w = world({ oauthFetch: g.oauthFetch });
      w.connection('c1', { clientId: oldClient });
      if (otherHolds) w.connection('c-other', { owner: OTHER, clientId: oldClient });
      await w.google.client.link(claim, newClient, 'https://example.invalid/cb', 'code-1');
      expect(g.revoked, String(otherHolds)).toEqual(otherHolds ? [] : [made('fixture', 'refresh', 'c1')]);
      expect(w.store.connectionCleanups(), String(otherHolds)).toEqual([]);
      expect([...w.secrets.map.keys()].sort(), String(otherHolds)).toEqual(otherHolds ? ['connection/c-other', 'connection/c1'] : ['connection/c1']);
      expect((await w.google.vault.list(OWNER)).ending).toEqual([]);
    }
  });

  it("a replaced token Google never confirms ending is given up as a deleted one's is, and its owner told which access to remove (HB-1396)", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-02T09:00:00Z');
    vi.setSystemTime(t0);
    const fresh = made('fixture', 'refresh', 'again');
    const oauthFetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('/revoke')) return new Response('', { status: 503 });
      if (u.includes('/token')) return new Response(JSON.stringify({ access_token: made('fixture', 'access'), refresh_token: fresh, scope: 'https://mail.google.com/' }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ email: SAM }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const w = world({ oauthFetch });
    w.connection('c1', { clientId: clientOf('100000000001', 'fixtureold') });
    await w.google.client.link(claim, { clientId: clientOf('100000000002', 'fixturenew'), clientSecret: made('fixture', 'new', 'value') }, 'https://example.invalid/cb', 'code-1');
    vi.setSystemTime(t0 + 8 * 24 * 60 * 60_000);
    w.db.prepare('UPDATE connection_cleanups SET tries = 143').run();
    expect(await w.google.vault.retryCleanups()).toBe(1);
    expect(w.told).toEqual([{ ownerId: OWNER, text: `Hatchabot asked Google 144 times over 8 days to end the access ${SAM} gave the OAuth client Hatchabot used before it was connected again, and Google never confirmed it. It has stopped asking and deleted its copy of the token. To be sure the access is gone, remove it by hand: in that Google Account, Security → Your connections to third-party apps & services (the app of that earlier client, not the one connected now). It is listed in Hatchabot under ⚙ Settings → Connections until you mark it done.` }]);
    expect(await w.secrets.get('connection/c1')).toBe(fresh);
    expect((await w.google.vault.list(OWNER)).ending).toEqual([expect.objectContaining({ replaced: true, givenUpAt: expect.any(String) })]);
    expect(eventLabel('connection.revoke_given_up', w.traced.find((t) => t.event === 'connection.revoke_given_up')!.detail)).toMatch(/^Google never confirmed the revoke of a reconnected account's earlier token in 144 tries/);
  });
});

describe('Disconnect', () => {
  it('an address that is not a plain mailbox is refused before anything is read or run', async () => {
    const w = world();
    const a = w.agent('a1', { state: 'RUNNING' });
    for (const email of ['-x@example.com', 'a"b@example.com', '$(id)@example.com', 'a b@example.com', `${'a'.repeat(250)}@example.com`]) {
      expect(await w.google.vault.disconnect(a, email)).toEqual({ refused: 'invalid' });
    }
    expect(w.calls).toEqual([]);
  });

  it('an attached account is detached (any case), its removal recorded first', async () => {
    const w = world();
    const a = w.agent('a1');
    w.connection('c1');
    w.store.attachConnection('a1', 'c1', false);
    expect(await w.google.vault.disconnect(a, SAM.toUpperCase())).toEqual({ removed: false, detached: true });
    expect(w.store.listAgentConnections('a1')).toEqual([]);
    expect(w.store.connectionRemovals('a1')).toEqual([SAM]);
  });

  it('one the agent added itself is taken out of its gog, only while it runs, in gog\'s own words when it fails', async () => {
    const w = world();
    expect(await w.google.vault.disconnect(w.agent('a0'), SAM)).toEqual({ refused: 'not-running' });
    const a = w.agent('a1', { state: 'RUNNING' });
    w.answer = () => ({ code: 2, stdout: '', stderr: 'made-up refusal' });
    expect(await w.google.vault.disconnect(a, SAM)).toEqual({ refused: 'failed', reason: 'made-up refusal' });
    w.answer = () => ok();
    expect(await w.google.vault.disconnect(a, SAM)).toEqual({ removed: true });
    expect(w.calls.map((c) => c.script)).toEqual([`gog auth remove --force -- "${SAM}"`, `gog auth remove --force -- "${SAM}"`]);
    expect(w.traced.map((t) => t.event)).toEqual(['connection.removed']);
  });

  it('only a list gog gave is an answer for the accounts it holds; what was granted comes from the connection', async () => {
    const w = world();
    const a = { ...w.agent('a1', { state: 'RUNNING' }), runtimeRef: 'rt-a1' };
    w.connection('c1');
    w.store.attachConnection('a1', 'c1', false);
    w.answer = () => ({ code: 127, stdout: '', stderr: '' });
    expect(await w.google.vault.accountsIn(a)).toEqual({ accounts: [] });
    w.answer = () => ({ code: 1, stdout: '', stderr: 'made-up failure' });
    expect(await w.google.vault.accountsIn(a)).toBeNull();
    w.answer = () => ok('not a list');
    expect(await w.google.vault.accountsIn(a)).toBeNull();
    w.answer = () => ok(JSON.stringify({ accounts: [{ email: SAM.toUpperCase() }, { email: 'pat@example.com', services: ['drive', 7] }, null] }));
    expect(await w.google.vault.accountsIn(a)).toEqual({ accounts: [
      { email: SAM.toUpperCase(), client: 'default', auth: 'oauth', services: ['gmail'] },
      { email: 'pat@example.com', client: 'default', auth: 'oauth', services: ['drive'] },
    ] });
  });
});

describe('the installation\'s OAuth client', () => {
  it('a different client ID is refused until confirmed, naming how many it breaks; the same one saved again is not', async () => {
    const w = world();
    expect(await w.google.client.save(CLIENT_A, false)).toEqual({ breaks: 0, sent: { pushing: 0, waiting: 0 } });
    w.connection('c1');
    expect(await w.google.client.save(CLIENT_B, false)).toEqual({ refused: 'client-change', breaks: 1 });
    expect(await w.google.client.get()).toEqual(CLIENT_A);
    expect(await w.google.client.save(CLIENT_A, false)).toMatchObject({ breaks: 0 });
    expect(await w.google.client.save(CLIENT_B, true)).toMatchObject({ breaks: 1 });
    expect(await w.google.client.get()).toEqual(CLIENT_B);
    expect(w.traced.map((t) => t.event)).toContain('google.client_replaced');
  });

  it('removing it says so when the secret store will not, and the client stays', async () => {
    const w = world();
    await w.google.client.save(CLIENT_A, false);
    const del = w.secrets.delete.bind(w.secrets);
    w.secrets.delete = async () => { throw new Error('made-up store failure'); };
    expect(await w.google.client.remove()).toBe(false);
    expect(await w.google.client.get()).toEqual(CLIENT_A);
    expect(w.traced.map((t) => t.event)).toEqual(['google.client_remove_failed']);
    w.secrets.delete = del;
    expect(await w.google.client.remove()).toBe(true);
    expect(await w.google.client.get()).toBeNull();
  });

  it('a consent state is single-use and bound to the browser\'s nonce', () => {
    const w = world();
    const s = w.google.client.issueState(OWNER, ['gmail'], 'nonce-1');
    expect(w.google.client.consumeState(s, 'nonce-2')).toBeNull();
    const t = w.google.client.issueState(OWNER, ['gmail'], 'nonce-1');
    expect(w.google.client.consumeState(t, 'nonce-1')).toEqual({ ownerId: OWNER, services: ['gmail'] });
    expect(w.google.client.consumeState(t, 'nonce-1')).toBeNull();
  });

  it('an account linked keeps only what Google granted, and with nothing granted nothing is stored', async () => {
    let scope = 'openid';
    const refresh = made('fixture', 'refresh', 'linked');
    const oauthFetch = (async (url: string) => {
      if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: made('fixture', 'access'), refresh_token: refresh, scope }), { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ email: SAM }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const w = world({ oauthFetch });
    const claim = { ownerId: OWNER, services: ['gmail', 'drive'] };
    expect(await w.google.client.link(claim, CLIENT_A, 'https://example.invalid/cb', 'code-1')).toEqual({ email: SAM, granted: [], refused: ['gmail', 'drive'] });
    expect(w.store.listConnections(OWNER)).toEqual([]);
    scope = 'https://mail.google.com/';
    expect(await w.google.client.link(claim, CLIENT_A, 'https://example.invalid/cb', 'code-2')).toEqual({ email: SAM, granted: ['gmail'], refused: ['drive'] });
    const [c] = w.store.listConnections(OWNER);
    expect(c).toMatchObject({ email: SAM, services: ['gmail'], clientId: CLIENT_A.clientId });
    expect(await w.secrets.get(`connection/${c!.id}`)).toBe(refresh);
  });
});

describe('a new client secret', () => {
  it('reaches the running agent owed it at once; a busy one waits for the pass', async () => {
    const w = world();
    await w.secrets.put(GOOGLE_CLIENT_REF, JSON.stringify(CLIENT_A));
    w.agent('a1', { state: 'RUNNING' });
    w.agent('a2', { state: 'RUNNING' });
    w.connection('c1');
    w.store.attachConnection('a1', 'c1', false);
    w.store.attachConnection('a2', 'c1', false);
    markBusy('a2');
    try {
      expect(w.google.delivery.pushClientSecret(CLIENT_A.clientId)).toEqual({ pushing: 1, waiting: 1 });
      await vi.waitFor(() => expect(w.calls.filter((c) => c.script.includes('gog auth import')).map((c) => c.ref)).toEqual(['rt-a1']));
      expect(w.traced.map((t) => t.event)).toContain('google.client_secret_changed');
    } finally { clearBusy('a2'); }
    // The pass asks the one that was busy, and nobody else.
    expect(await w.google.delivery.clientSecretSweep()).toEqual({ pushing: 1, waiting: 0 });
    expect(w.calls.filter((c) => c.script.includes('gog auth import')).map((c) => c.ref)).toEqual(['rt-a1', 'rt-a2']);
    expect(await w.google.delivery.clientSecretSweep()).toEqual({ pushing: 0, waiting: 0 });
  });

  it('the pass backs off an agent whose import keeps failing, and asks again ten minutes on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-22T10:00:00Z');
    vi.setSystemTime(t0);
    const w = world();
    await w.secrets.put(GOOGLE_CLIENT_REF, JSON.stringify(CLIENT_A));
    w.agent('a1', { state: 'RUNNING' });
    w.connection('c1');
    w.store.attachConnection('a1', 'c1', false);
    w.store.markClientSecretChanged('google', CLIENT_A.clientId, new Date(t0).toISOString()); // a new secret saved
    w.answer = (script) => (script.includes('gog auth import') ? ok(importsTook(script).replace(/ 0$/gm, ' 1')) : ok());
    const tries = () => w.calls.filter((c) => c.script.includes('gog auth import')).length;
    expect(await w.google.delivery.clientSecretSweep()).toEqual({ pushing: 1, waiting: 0 });
    expect(tries()).toBe(1);
    expect(w.traced.map((t) => t.event)).toContain('connection.sync_failed');
    expect(await w.google.delivery.clientSecretSweep()).toEqual({ pushing: 0, waiting: 1 });
    expect(tries()).toBe(1);
    vi.setSystemTime(t0 + 10 * 60_000);
    await w.google.delivery.clientSecretSweep();
    expect(tries()).toBe(2);
    // Saving the client again forgets the back-off: asked at once.
    vi.setSystemTime(t0 + 11 * 60_000);
    expect(w.google.delivery.deliverClientSecretNow(CLIENT_A.clientId)).toEqual({ pushing: 1, waiting: 0 });
    await vi.waitFor(() => expect(tries()).toBe(3));
  });

  it('one pass at a time, and none with no client set', async () => {
    const w = world();
    expect(await w.google.delivery.clientSecretSweep()).toBeUndefined();
    await w.secrets.put(GOOGLE_CLIENT_REF, JSON.stringify(CLIENT_A));
    w.agent('a1', { state: 'RUNNING' });
    w.connection('c1');
    w.store.attachConnection('a1', 'c1', false);
    w.store.markClientSecretChanged('google', CLIENT_A.clientId, new Date().toISOString()); // a new secret saved
    const importing = gate();
    w.answer = async (script) => { if (script.includes('gog auth import')) { await importing.held; return ok(importsTook(script)); } return ok(); };
    const first = w.google.delivery.clientSecretSweep();
    await vi.waitFor(() => expect(w.calls.length).toBeGreaterThan(0));
    expect(await w.google.delivery.clientSecretSweep()).toBeUndefined();
    importing.open();
    expect(await first).toEqual({ pushing: 1, waiting: 0 });
  });

  it('the pass runs every ten minutes, a failed one is logged, and stop() ends it', async () => {
    vi.useFakeTimers();
    const w = world({ sweepEveryMs: 10 * 60_000 });
    await w.secrets.put(GOOGLE_CLIENT_REF, JSON.stringify(CLIENT_A));
    let passes = 0;
    w.store.connectionsOwedClientSecret = () => { passes++; throw new Error('made-up failure'); };
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(passes).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(passes).toBe(1);
    expect(w.warned).toEqual(['client secret sweep failed']);
    w.google.stop();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(passes).toBe(1);
    // Off (tests, as before): no timer at all.
    const off = world({ sweepEveryMs: 0 });
    let offPasses = 0;
    off.store.connectionsOwedClientSecret = () => { offPasses++; return []; };
    await off.secrets.put(GOOGLE_CLIENT_REF, JSON.stringify(CLIENT_A));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(offPasses).toBe(0);
    off.google.stop();
  });
});

describe('Verify now', () => {
  it('one verification per agent at a time; a stopped agent is said not checkable', async () => {
    const w = world();
    const stopped = w.agent('a0');
    expect(await w.google.access.verify(stopped)).toMatchObject({ result: { status: 'not-checkable' }, access: expect.objectContaining({ name: 'Agent a0' }) });
    const a = w.agent('a1', { state: 'RUNNING' });
    const looking = gate();
    w.answer = async () => { await looking.held; return ok(JSON.stringify({ accounts: [] })); };
    const first = w.google.access.verify(a);
    await vi.waitFor(() => expect(w.calls.length).toBeGreaterThan(0));
    expect(await w.google.access.verify(a)).toBe('busy');
    looking.open();
    const out = await first;
    expect(out).not.toBe('busy');
    expect(w.traced.filter((t) => t.event === 'access.verified').map((t) => t.detail.agentId)).toEqual(['a0', 'a1']);
    // Let go once it has answered.
    w.answer = () => ok(JSON.stringify({ accounts: [] }));
    expect(await w.google.access.verify(a)).not.toBe('busy');
  });
});
