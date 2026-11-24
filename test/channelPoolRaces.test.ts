import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import type { ChannelConnector } from '../src/channels/connector.js';

/**
 * Spare Discord bots and Slack apps while the platform is slow to answer: a
 * request that waited on it must judge the pool row and the agent's channel
 * as they are once it answers, not as they were when it asked (deep audit
 * 2026-11-23).
 */

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };
// Made-up application ids, Discord-shaped (17–20 digits).
const OLD = '1111111111111111111';
const B = '2222222222222222222';
const C = '3333333333333333333';

class MemSecrets {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('no secret'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const gate = () => {
  let open!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const reached = new Promise<void>((r) => { entered = r; });
  return { open, entered, opened, reached };
};

async function world() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  const provider = new MockProvider();
  // The platform answers for a token: its account is the token's name. A test
  // holds one token's answer (`hold`), or changes what is listed (`listing`).
  const holds = new Map<string, Promise<void>>();
  const entered = new Map<string, () => void>();
  const listing: { servers?: Array<{ id: string; name: string }> } = { servers: [] };
  /** Each direct message a bot sent: [its token, to whom, the text]. */
  const dms: Array<[string, string, string]> = [];
  const connector: ChannelConnector = {
    kind: 'discord', label: 'Discord',
    fields: [{ key: 'token', label: 'Token', pattern: /^tok-/, help: '' }],
    secretValue: (c) => String(c.token),
    credsFromSecret: (s) => ({ token: s }),
    async dm(secret, userId, text) { dms.push([secret, userId, text]); return true; },
    async verify(c) {
      const token = String(c.token);
      // One-shot: only the first call for a held token waits; the ones after answer at once.
      const held = holds.get(token);
      holds.delete(token);
      if (held) { entered.get(token)?.(); await held; }
      const accountId = token.replace(/^tok-/, '');
      return {
        accountId, displayName: `@Bot ${accountId.slice(0, 2)}`, deepLink: `https://x/${accountId}`,
        settings: { botName: `Bot ${accountId.slice(0, 2)}`, ...(listing.servers ? { servers: listing.servers } : {}) },
        warnings: [],
      };
    },
  };
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: secrets as never, providers: new Map([['mock', provider]]),
    channel: { kind: 'telegram', pool: { owns: () => false } } as never,
    connectors: { discord: connector },
  } as never);
  const inject = (method: string, url: string, payload?: unknown) => f.inject({ method: method as never, url, headers: H, payload: payload as never });
  /** Hold the platform's next answer for one token until `open()`; `reached` settles once a request is waiting on it. */
  const hold = (token: string) => {
    const g = gate();
    holds.set(token, g.opened);
    entered.set(token, g.entered);
    return g;
  };
  const addAgent = (id = 'agent-1') => {
    store.insertAgent({
      id, ownerId: OWNER, name: 'Helper', slug: id, state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://' + id,
      persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now',
    } as never);
    store.insertMembership({ id: `m-${id}`, agentId: id, userId: OWNER, role: 'owner', status: 'active' });
    return id;
  };
  /** An agent already on the bot OLD. */
  const onOld = async (settings: Record<string, unknown> = {}) => {
    const id = addAgent();
    await secrets.put('old-secret', `tok-${OLD}`);
    store.insertChannel({ id: 'old-row', agentId: id, kind: 'discord', accountId: OLD, secretRef: 'old-secret', deepLink: 'https://x/old', createdAt: 'now', settings });
    return id;
  };
  const park = async (account: string) => {
    const r = await inject('POST', '/v1/discord-bots', { token: `tok-${account}` });
    expect(r.statusCode, r.body).toBe(200);
  };
  return { store, secrets, provider, f, inject, hold, addAgent, onOld, park, listing, dms };
}

describe('two bot swaps at once (HB-0988)', () => {
  it('the swap that finished first stands; the late one is refused and moves nothing', async () => {
    const w = await world();
    try {
      const id = await w.onOld();
      await w.park(B);
      await w.park(C);
      const g = w.hold(`tok-${B}`);
      const late = Promise.resolve(w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B }));
      await g.reached;
      const first = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: C });
      expect(first.statusCode, first.body).toBe(200);
      const onC = w.store.getChannelForAgent(id, 'discord')!;
      expect(onC.accountId).toBe(C);
      g.open();
      const r = await late;
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatch(/changed meanwhile/);
      // Still on C, with C's token; the old bot parked by the swap that won; B still a spare.
      expect(w.store.getChannelForAgent(id, 'discord')).toMatchObject({ id: onC.id, accountId: C, secretRef: onC.secretRef });
      expect(w.secrets.map.get(onC.secretRef)).toBe(`tok-${C}`);
      expect(w.store.getDiscordBot(OLD)).toBeDefined();
      expect(w.secrets.map.get(w.store.getDiscordBot(OLD)!.secretRef)).toBe(`tok-${OLD}`);
      expect(w.store.getDiscordBot(B)).toBeDefined();
      expect(w.secrets.map.get(w.store.getDiscordBot(B)!.secretRef)).toBe(`tok-${B}`);
      expect(w.store.getDiscordBot(C)).toBeUndefined();
      // Nothing was written under the late swap's key.
      expect(w.secrets.map.has(`channel/${id}/discord/${B}`)).toBe(false);
    } finally { await w.f.close(); }
  });

  it('a spare removed from the pool while it was checked is not put on the agent', async () => {
    const w = await world();
    try {
      const id = await w.onOld();
      await w.park(B);
      const g = w.hold(`tok-${B}`);
      const swap = Promise.resolve(w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B }));
      await g.reached;
      expect((await w.inject('DELETE', `/v1/discord-bots/${B}`)).statusCode).toBe(200);
      g.open();
      const r = await swap;
      expect(r.statusCode, r.body).toBe(409);
      expect(w.store.getChannelForAgent(id, 'discord')).toMatchObject({ accountId: OLD, secretRef: 'old-secret' });
      expect(w.secrets.map.get('old-secret')).toBe(`tok-${OLD}`);
    } finally { await w.f.close(); }
  });

  it('a swap arriving while another holds the agent is a 409, not a server error', async () => {
    const w = await world();
    try {
      const id = await w.onOld();
      await w.park(B);
      const { markBusy, clearBusy } = await import('../src/orchestrator/lifecycle/busy.js');
      const g = w.hold(`tok-${B}`);
      const swap = Promise.resolve(w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B }));
      await g.reached;
      markBusy(id);
      try {
        g.open();
        const r = await swap;
        expect(r.statusCode, r.body).toBe(409);
      } finally { clearBusy(id); }
      expect(w.store.getChannelForAgent(id, 'discord')?.accountId).toBe(OLD);
    } finally { await w.f.close(); }
  });
});

describe('a swap whose agent cannot be confirmed stopped (HB-0997)', () => {
  it('changes nothing: the old bot stays with its token, the spare stays parked, nobody is told it moved', async () => {
    const w = await world();
    try {
      const id = await w.onOld();
      w.store.bindMemberIdentity(id, OWNER, 'discord', '555555555555555555');
      await w.park(B);
      w.provider.stop = async () => { throw new Error('machine unavailable'); };
      w.provider.status = async () => { throw new Error('machine unavailable'); };
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatch(/would not stop/);
      expect(w.store.getChannelForAgent(id, 'discord')).toMatchObject({ id: 'old-row', accountId: OLD, secretRef: 'old-secret' });
      expect(w.secrets.map.get('old-secret')).toBe(`tok-${OLD}`);
      expect(w.store.getDiscordBot(B)).toBeDefined();
      expect(w.secrets.map.get(`discord-pool/${B}`)).toBe(`tok-${B}`);
      expect(w.store.getDiscordBot(OLD)).toBeUndefined();
      expect(w.secrets.map.has(`channel/${id}/discord/${B}`)).toBe(false);
      expect(w.dms).toEqual([]);
    } finally { await w.f.close(); }
  });

  it('a running agent that would not stop stays running on its old bot', async () => {
    const w = await world();
    try {
      const id = await w.onOld();
      const { runtimeRef } = await w.provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: {} }, env: {} } as never);
      await w.provider.start(runtimeRef);
      w.store['db'].prepare(`UPDATE agents SET state = 'RUNNING', runtime_ref = ? WHERE id = ?`).run(runtimeRef, id);
      await w.park(B);
      w.provider.stop = async () => { throw new Error('machine unavailable'); };
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode, r.body).toBe(409);
      expect(w.store.getAgent(id)?.state).toBe('RUNNING');
      expect(w.store.getChannelForAgent(id, 'discord')?.accountId).toBe(OLD);
      expect(w.store.getDiscordBot(B)).toBeDefined();
    } finally { await w.f.close(); }
  });

  it('a confirmed stop swaps as before: the new bot on, the old parked with its token, people told on the old bot', async () => {
    const w = await world();
    try {
      const id = await w.onOld();
      w.store.bindMemberIdentity(id, OWNER, 'discord', '555555555555555555');
      await w.park(B);
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ swapped: true, from: OLD, to: B, parked: true, told: 1 });
      const row = w.store.getChannelForAgent(id, 'discord')!;
      expect(row.accountId).toBe(B);
      expect(w.secrets.map.get(row.secretRef)).toBe(`tok-${B}`);
      expect(w.secrets.map.get(w.store.getDiscordBot(OLD)!.secretRef)).toBe(`tok-${OLD}`);
      expect(w.store.getDiscordBot(B)).toBeUndefined();
      expect(w.dms).toEqual([[`tok-${OLD}`, '555555555555555555', expect.stringContaining('is moving to the bot')]]);
    } finally { await w.f.close(); }
  });

  it('a spare another agent takes while this one stops: it stays on its old bot, and its rebuild is owed', async () => {
    const w = await world();
    try {
      const id = await w.onOld();
      const other = w.addAgent('agent-2');
      await w.park(B);
      const stop = w.provider.stop.bind(w.provider);
      w.provider.stop = async (ref: string) => {
        // While this agent stops, another takes the same spare.
        w.store.insertChannel({ id: 'other-row', agentId: other, kind: 'discord', accountId: B, secretRef: 'other-secret', deepLink: 'x', createdAt: 'now' });
        return stop(ref);
      };
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatch(/just taken/);
      expect(w.store.getChannelForAgent(id, 'discord')).toMatchObject({ id: 'old-row', accountId: OLD, secretRef: 'old-secret' });
      expect(w.secrets.map.get('old-secret')).toBe(`tok-${OLD}`);
      expect(w.secrets.map.has(`channel/${id}/discord/${B}`)).toBe(false);
      expect(w.store.getAgent(id)?.rebuildOnStart).toBeTruthy();
    } finally { await w.f.close(); }
  });
});

describe('a swap that fails part way (HB-0997 follow-up)', () => {
  /** A running agent on OLD, with B parked. */
  const running = async () => {
    const w = await world();
    const id = await w.onOld();
    const { runtimeRef } = await w.provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: {} }, env: {} } as never);
    await w.provider.start(runtimeRef);
    w.store['db'].prepare(`UPDATE agents SET state = 'RUNNING', runtime_ref = ? WHERE id = ?`).run(runtimeRef, id);
    await w.park(B);
    return { w, id, runtimeRef };
  };

  it('a new token the store will not take refuses the swap before anything stops', async () => {
    const { w, id, runtimeRef } = await running();
    try {
      const put = w.secrets.put.bind(w.secrets);
      w.secrets.put = async (ref: string, v: string) => { if (ref.startsWith('channel/')) throw new Error('no space left on device'); return put(ref, v); };
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode).toBe(500);
      expect(w.store.getAgent(id)?.state).toBe('RUNNING');
      expect((await w.provider.status(runtimeRef)).phase).toBe('running');
      expect(w.store.getAgent(id)?.rebuildOnStart).toBeFalsy();
      expect(w.store.getChannelForAgent(id, 'discord')).toMatchObject({ id: 'old-row', accountId: OLD, secretRef: 'old-secret' });
      expect(w.store.getDiscordBot(B)).toBeDefined();
    } finally { await w.f.close(); }
  });

  it('a row the store will not take once it has stopped: the new token goes, the old bot stays, and it comes back up', async () => {
    const { w, id } = await running();
    try {
      w.store.replaceChannelRow = () => { throw new Error('database is locked'); };
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode).toBe(500);
      expect(w.store.getChannelForAgent(id, 'discord')).toMatchObject({ id: 'old-row', accountId: OLD, secretRef: 'old-secret' });
      expect(w.secrets.map.get('old-secret')).toBe(`tok-${OLD}`);
      expect(w.secrets.map.has(`channel/${id}/discord/${B}`)).toBe(false);
      expect(w.store.getDiscordBot(B)).toBeDefined();
      // Not left stopped: its rebuild was asked for, as the swap would have.
      expect(w.store.listOperations([id]).some((o) => o.kind === 'rebuild')).toBe(true);
    } finally { await w.f.close(); }
  });

  it('a stop that fails takes the new token back out', async () => {
    const { w, id } = await running();
    try {
      w.provider.stop = async () => { throw new Error('machine unavailable'); };
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode, r.body).toBe(409);
      expect(w.secrets.map.has(`channel/${id}/discord/${B}`)).toBe(false);
      expect([...w.secrets.map.keys()].sort()).toEqual([`discord-pool/${B}`, 'old-secret']);
    } finally { await w.f.close(); }
  });
});

describe('a swap when the platform does not list the rooms just now (HB-0998)', () => {
  const KNOWN = [{ id: '666666666666666666', name: 'Family' }];

  it('the spare keeps the servers it was known to be in, so "every server it is in" still has them', async () => {
    const w = await world();
    try {
      const id = await w.onOld({ rooms: { mode: 'members' } });
      w.listing.servers = KNOWN;
      await w.park(B);
      expect(w.store.getDiscordBot(B)?.servers).toEqual(KNOWN);
      w.listing.servers = undefined; // the listing fails during the swap's check
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().channel).toMatchObject({ accountId: B, rooms: { mode: 'members' }, servers: KNOWN });
      expect(w.store.getChannelForAgent(id, 'discord')?.settings?.servers).toEqual(KNOWN);
    } finally { await w.f.close(); }
  });

  it('a listing that answers wins, even when it is empty', async () => {
    const w = await world();
    try {
      const id = await w.onOld({ rooms: { mode: 'members' } });
      w.listing.servers = KNOWN;
      await w.park(B);
      w.listing.servers = [];
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode, r.body).toBe(200);
      expect(w.store.getChannelForAgent(id, 'discord')?.settings?.servers).toEqual([]);
    } finally { await w.f.close(); }
  });
});

describe('re-checking a parked bot (HB-0987)', () => {
  it('a bot removed while the platform was asked stays removed; the re-check says it changed', async () => {
    const w = await world();
    try {
      await w.park(B);
      const g = w.hold(`tok-${B}`);
      const recheck = Promise.resolve(w.inject('POST', `/v1/discord-bots/${B}/recheck`));
      await g.reached;
      expect((await w.inject('DELETE', `/v1/discord-bots/${B}`)).statusCode).toBe(200);
      g.open();
      const r = await recheck;
      expect(r.statusCode, r.body).toBe(409);
      expect(w.store.getDiscordBot(B)).toBeUndefined();
      expect(w.secrets.map.has(`discord-pool/${B}`)).toBe(false);
    } finally { await w.f.close(); }
  });

  it('a bot an agent took while the platform was asked is not listed as a spare again', async () => {
    const w = await world();
    try {
      const id = w.addAgent();
      await w.park(B);
      const g = w.hold(`tok-${B}`);
      const recheck = Promise.resolve(w.inject('POST', `/v1/discord-bots/${B}/recheck`));
      await g.reached;
      // An agent takes it from the pool while the re-check waits.
      const att = await w.inject('POST', `/v1/agents/${id}/channels/discord`, { pooled: B });
      expect(att.statusCode, att.body).toBe(202);
      expect(w.store.getDiscordBot(B)).toBeUndefined();
      g.open();
      const r = await recheck;
      expect(r.statusCode, r.body).toBe(409);
      expect(w.store.getChannelForAgent(id, 'discord')?.accountId).toBe(B);
      expect(w.store.getDiscordBot(B)).toBeUndefined();
    } finally { await w.f.close(); }
  });

  it('a re-check with nothing changed meanwhile still refreshes the parked bot, and keeps what it does not answer', async () => {
    const w = await world();
    try {
      await w.park(B);
      const before = w.store.getDiscordBot(B)!;
      w.listing.servers = [{ id: '444444444444444444', name: 'Club' }];
      const r = await w.inject('POST', `/v1/discord-bots/${B}/recheck`);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().bot.servers).toEqual([{ id: '444444444444444444', name: 'Club' }]);
      const after = w.store.getDiscordBot(B)!;
      expect(after).toMatchObject({ secretRef: before.secretRef, addedAt: before.addedAt, ownerId: OWNER, servers: [{ id: '444444444444444444', name: 'Club' }] });
      // A listing that failed is "unknown": the servers it had are kept.
      w.listing.servers = undefined;
      expect((await w.inject('POST', `/v1/discord-bots/${B}/recheck`)).json().bot.servers).toEqual([{ id: '444444444444444444', name: 'Club' }]);
    } finally { await w.f.close(); }
  });
});

describe('taking a spare for an agent that has no bot yet (HB-1154)', () => {
  const KNOWN = [{ id: '666666666666666666', name: 'Family' }];

  it('the spare keeps the servers it was known to be in when the platform does not list them just now', async () => {
    const w = await world();
    try {
      const id = w.addAgent();
      w.listing.servers = KNOWN;
      await w.park(B);
      w.listing.servers = undefined; // the listing fails during the attach's check
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord`, { pooled: B });
      expect(r.statusCode, r.body).toBe(202);
      expect(r.json().servers).toEqual(KNOWN);
      expect(w.store.getChannelForAgent(id, 'discord')?.settings?.servers).toEqual(KNOWN);
    } finally { await w.f.close(); }
  });

  it('a listing that answers wins, even when it is empty', async () => {
    const w = await world();
    try {
      const id = w.addAgent();
      w.listing.servers = KNOWN;
      await w.park(B);
      w.listing.servers = [];
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord`, { pooled: B });
      expect(r.statusCode, r.body).toBe(202);
      expect(w.store.getChannelForAgent(id, 'discord')?.settings?.servers).toEqual([]);
    } finally { await w.f.close(); }
  });

  it('a spare removed from the pool while it was checked is not connected', async () => {
    const w = await world();
    try {
      const id = w.addAgent();
      await w.park(B);
      const g = w.hold(`tok-${B}`);
      const attach = Promise.resolve(w.inject('POST', `/v1/agents/${id}/channels/discord`, { pooled: B }));
      await g.reached;
      expect((await w.inject('DELETE', `/v1/discord-bots/${B}`)).statusCode).toBe(200);
      g.open();
      const r = await attach;
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toMatch(/left the pool meanwhile/);
      expect(w.store.getChannelForAgent(id, 'discord')).toBeUndefined();
      expect(w.secrets.map.has(`channel/${id}/discord`)).toBe(false);
    } finally { await w.f.close(); }
  });
});

describe('Change bot onto a spare that served another agent before (HB-1049)', () => {
  it('the spare\'s former chats are told it now serves this agent, as when an agent takes it', async () => {
    const w = await world();
    try {
      const id = await w.onOld();
      w.store.bindMemberIdentity(id, OWNER, 'discord', '555555555555555555');
      await w.park(B);
      // Whom B wrote to for the agent it served before it was parked.
      w.store.upsertDiscordBot({ ...w.store.getDiscordBot(B)!, priorChatIds: ['777777777777777777'] });
      const r = await w.inject('POST', `/v1/agents/${id}/channels/discord/swap`, { pooled: B });
      expect(r.statusCode, r.body).toBe(200);
      expect(w.dms).toEqual([
        [`tok-${OLD}`, '555555555555555555', expect.stringContaining('is moving to the bot')],
        [`tok-${B}`, '777777777777777777', expect.stringContaining('— this bot is now “Helper” —')],
      ]);
    } finally { await w.f.close(); }
  });
});
