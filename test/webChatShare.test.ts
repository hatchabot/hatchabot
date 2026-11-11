import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { MemSecrets } from './support/world.js';

/**
 * Sharing an agent with someone on this Hatchabot, no link (2026-11-10): the
 * owner picks a person who signs in here and the agent is on their home
 * screen at once, with web chat, as a web chat invite would leave them. And
 * the web chat join page is told how this browser is signed in already, so a
 * Google install no longer offers only Google.
 */

const OWNER = 'user-owner';   // owns the machine and the agent
const SAM = 'user-sam';       // a member with web chat already
const PAT = 'user-pat';       // a member on a chat app, no web chat
const RAE = 'user-rae';       // signs in here, not a member
const as = (who: string) => ({ 'x-hatchabot-owner': who });

async function world(opts: { authMode?: 'password' | 'accounts' | 'identity'; passwords?: boolean } = {}) {
  if (opts.passwords ?? true) process.env.HATCHABOT_LOCAL_ACCOUNTS = '1';
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const agent = (id: string, ownerId: string, extra: Record<string, unknown> = {}) => store.insertAgent({
    id, ownerId, name: id === 'a1' ? 'Kitchen' : 'Garden', slug: id, state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now', ...extra,
  } as never);
  agent('a1', OWNER);
  agent('a2', PAT);
  agent('ops', OWNER, { ops: true });
  store.insertMembership({ id: 'm0', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: SAM, role: 'user', displayName: 'Sam', status: 'active', webChat: true });
  store.insertMembership({ id: 'm2', agentId: 'a1', userId: PAT, role: 'user', displayName: 'Pat', status: 'active' });
  for (const [id, email] of [[OWNER, 'owner@example.com'], [SAM, 'sam@example.com'], [PAT, 'pat@example.com'], [RAE, 'rae@example.com']]) {
    store.recordAccount(id!, email);
  }
  // Password accounts: one named with Sam's email (a separate account), one disabled.
  const local = (id: string, username: string, extra: Record<string, unknown> = {}) => store.insertLocalAccount({
    id, username, pwHash: 'made-up', pwSalt: 'made-up', hostOwner: false, disabled: false, createdAt: 'now', ...extra,
  } as never);
  local('acct-robin', 'robin', { displayName: 'Robin' });
  local('acct-sam', 'sam@example.com');
  local('acct-gone', 'kit', { disabled: true });
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    authMode: opts.authMode ?? 'identity',
  });
  const people = async (who: string, id = 'a1') => f.inject({ method: 'GET', url: `/v1/agents/${id}/web-chat/people`, headers: as(who) });
  const share = async (who: string, userId: string, id = 'a1') =>
    f.inject({ method: 'POST', url: `/v1/agents/${id}/web-chat/people`, headers: as(who), payload: { userId } });
  return { store, f, people, share };
}

afterEach(() => { delete process.env.HATCHABOT_LOCAL_ACCOUNTS; });

describe('sharing with someone on this Hatchabot', () => {
  it("the machine's owner is offered everyone who signs in here, Google and password apart, never themselves", async () => {
    const w = await world();
    const res = await w.people(OWNER);
    expect(res.statusCode, res.body).toBe(200);
    const byId = Object.fromEntries(res.json().people.map((p: { userId: string }) => [p.userId, p]));
    expect(Object.keys(byId).sort()).toEqual(['acct-robin', 'acct-sam', PAT, RAE, SAM].sort());
    expect(byId[SAM]).toMatchObject({ kind: 'google', label: 'sam@example.com', shared: true });
    // The same email as a password account: a second person, marked so.
    expect(byId['acct-sam']).toMatchObject({ kind: 'password', label: 'sam@example.com', shared: false });
    expect(byId['acct-robin']).toMatchObject({ kind: 'password', label: 'Robin', username: 'robin' });
    expect(byId[PAT].shared).toBe(false);
  });

  it('password accounts are offered only where they can sign in', async () => {
    const w = await world({ passwords: false });
    const kinds = (await w.people(OWNER)).json().people.map((p: { kind: string }) => p.kind);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k: string) => k === 'google')).toBe(true);
  });

  it('shares: a new member with web chat, a chat-app member keeps their seat and name, one who has it is told', async () => {
    const w = await world();
    const rae = await w.share(OWNER, RAE);
    expect(rae.statusCode, rae.body).toBe(201);
    expect(rae.json()).toMatchObject({ userId: RAE, webChat: true, name: 'rae' });
    expect(w.store.getMembership('a1', RAE)).toMatchObject({ status: 'active', role: 'user', webChat: true, displayName: 'rae' });
    expect(w.store.webChatAllowed('a1', RAE)).toBe(true);
    // On their home screen.
    const list = (await w.f.inject({ method: 'GET', url: '/v1/agents', headers: as(RAE) })).json();
    expect(list.map((a: { id: string }) => a.id)).toContain('a1');
    const pat = await w.share(OWNER, PAT);
    expect(pat.statusCode, pat.body).toBe(201);
    expect(w.store.getMembership('a1', PAT)).toMatchObject({ status: 'active', webChat: true, displayName: 'Pat' });
    const sam = await w.share(OWNER, SAM);
    expect(sam.statusCode).toBe(200);
    expect(sam.json()).toMatchObject({ already: true });
    const robin = await w.share(OWNER, 'acct-robin');
    expect(w.store.getMembership('a1', 'acct-robin')).toMatchObject({ webChat: true, displayName: 'Robin' });
    expect(robin.statusCode).toBe(201);
  });

  it('a removed member shared with again is back, with web chat', async () => {
    const w = await world();
    await w.share(OWNER, RAE);
    const del = await w.f.inject({ method: 'DELETE', url: `/v1/agents/a1/members/${RAE}`, headers: as(OWNER) });
    expect(del.statusCode, del.body).toBe(200);
    expect(w.store.webChatAllowed('a1', RAE)).toBe(false);
    expect((await w.share(OWNER, RAE)).statusCode).toBe(201);
    expect(w.store.getMembership('a1', RAE)).toMatchObject({ status: 'active', webChat: true });
  });

  it('refuses anyone the list does not offer: an unknown id, a disabled account, the owner', async () => {
    const w = await world();
    for (const id of ['user-nobody', 'acct-gone', OWNER]) {
      const r = await w.share(OWNER, id);
      expect(r.statusCode, id).toBe(404);
      expect(w.store.getMembership('a1', id)?.webChat ?? false, id).toBe(false);
    }
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/web-chat/people', headers: as(OWNER), payload: {} })).statusCode).toBe(400);
  });

  it("someone who is not the machine's owner is offered only people they already know, not the household", async () => {
    const w = await world();
    const ids = (await w.people(PAT, 'a2')).json().people.map((p: { userId: string }) => p.userId);
    // The machine's owner, and nobody else they have dealings with.
    expect(ids).toEqual([OWNER]);
    // Pat cannot share their agent with Rae by sending her id: that would tell Pat who has an account here.
    expect((await w.share(PAT, RAE, 'a2')).statusCode).toBe(404);
    // Someone already in one of Pat's agents is known to Pat.
    w.store.insertMembership({ id: 'm9', agentId: 'a2', userId: 'acct-robin', role: 'user', displayName: 'Robin', status: 'active' });
    expect((await w.people(PAT, 'a2')).json().people.map((p: { userId: string }) => p.userId).sort()).toEqual(['acct-robin', OWNER].sort());
  });

  it("only the agent's owner, never the Hatchabot agent, never on a one-password install", async () => {
    const w = await world();
    expect((await w.people(SAM)).statusCode).toBe(404);
    expect((await w.share(SAM, RAE)).statusCode).toBe(404);
    expect((await w.people(OWNER, 'ops')).statusCode).toBe(400);
    expect((await w.share(OWNER, RAE, 'ops')).statusCode).toBe(400);
    const pw = await world({ authMode: 'password' });
    expect((await pw.people(OWNER)).statusCode).toBe(400);
    expect((await pw.share(OWNER, RAE)).statusCode).toBe(400);
  });
});

describe('the web chat join page is told how this browser signs in', () => {
  const mint = async (w: Awaited<ReturnType<typeof world>>) =>
    (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: as(OWNER), payload: { webChat: true } })).json().code as string;

  it('signed in: who as, and whether it is their own agent; not signed in: neither; password accounts said', async () => {
    const w = await world();
    const code = await mint(w);
    const look = async (headers: Record<string, string> = {}) => (await w.f.inject({ method: 'GET', url: `/v1/invites/${code}`, headers })).json();
    const anon = await look();
    expect(anon).toMatchObject({ valid: true, webChat: true, authMode: 'identity', localAccounts: true });
    expect(anon.signedInAs).toBeUndefined();
    expect(anon.own).toBeUndefined();
    expect(await look(as(RAE))).toMatchObject({ signedInAs: 'rae@example.com' });
    expect((await look(as(RAE))).own).toBeUndefined();
    expect(await look(as('acct-robin'))).toMatchObject({ signedInAs: 'Robin' });
    expect(await look(as(OWNER))).toMatchObject({ signedInAs: 'owner@example.com', own: true });
    // Joining with that session works on a Google install: no Google token needed.
    const joined = await w.f.inject({ method: 'POST', url: '/v1/join', headers: as('acct-robin'), payload: { code, name: 'Robin' } });
    expect(joined.statusCode, joined.body).toBe(201);
    expect(w.store.getMembership('a1', 'acct-robin')).toMatchObject({ webChat: true });
  });

  it('a Google install without password accounts says so', async () => {
    const w = await world({ passwords: false });
    const code = await mint(w);
    expect((await w.f.inject({ method: 'GET', url: `/v1/invites/${code}` })).json()).toMatchObject({ localAccounts: false });
  });
});
