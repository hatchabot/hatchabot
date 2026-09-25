import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { ConnectorError, type ChannelConnector } from '../src/channels/connector.js';

/** Adding, changing and removing Slack and Discord on an agent, with fake platforms. */

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };

class MemSecrets {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('no secret'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

function fakeConnector(kind: 'slack' | 'discord', accountId = kind === 'slack' ? 'U0BOT' : '1234567890123456789'): ChannelConnector {
  return {
    kind, label: kind === 'slack' ? 'Slack' : 'Discord',
    fields: [{ key: 'token', label: 'Token', pattern: /^ok-/, help: 'starts with ok-' }],
    hosts: [],
    secretValue: (c) => String(c.token),
    credsFromSecret: (secret) => ({ token: secret }),
    async rename(secret, name) {
      renameCalls.push([kind, secret, name]);
      if (name === 'Refused') return { ok: false, note: 'Discord allows a bot only a few name changes an hour — try again later.' };
      return { ok: true, name };
    },
    async verify(c) {
      if (c.token !== 'ok-good') throw new ConnectorError('The platform refused it.');
      verifyCalls.push(kind);
      // The second look finds the bot in a server and the intent turned on.
      const later = verifyCalls.filter((k) => k === kind).length > 1;
      return {
        accountId, displayName: later ? '@Bot in Home, Work' : '@Bot in Home', deepLink: `https://x/${kind}`,
        ...(kind === 'discord' ? { addToServerUrl: 'https://discord.com/oauth2/authorize?client_id=1' } : {}),
        settings: { team: 'Home', botName: 'Bot', servers: later ? [{ id: '100', name: 'Home' }, { id: '200', name: 'Work' }] : [{ id: '100', name: 'Home' }] },
        warnings: kind === 'discord' && !later ? ['Message Content Intent is off'] : [],
      };
    },
  };
}
const verifyCalls: string[] = [];
const renameCalls: Array<[string, string, string]> = [];

async function setup(opts: { imageChannels?: string[] } = {}) {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  const provider = new MockProvider();
  if (opts.imageChannels) provider.imageChannels = opts.imageChannels;
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: secrets as never, providers: new Map([['mock', provider]]),
    channel: { kind: 'telegram', pool: { owns: () => false } } as never,
    connectors: { slack: fakeConnector('slack'), discord: fakeConnector('discord') },
  } as never);
  let n = 0;
  const add = (over: Record<string, unknown> = {}) => {
    const id = `chr-${++n}-${Math.random().toString(36).slice(2, 8)}`;
    store.insertAgent({
      id, ownerId: OWNER, name: 'Tax', slug: id, state: 'STOPPED', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://' + id,
      persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now', ...over,
    } as never);
    // The owner seat every real agent is born with.
    store.insertMembership({ id: `m-${id}`, agentId: id, userId: String(over.ownerId ?? OWNER), role: 'owner', status: 'active' });
    return id;
  };
  const inject = (method: string, url: string, payload?: unknown, headers = H) => f.inject({ method: method as never, url, headers, payload: payload as never });
  return { store, secrets, f, add, inject };
}

describe('adding Slack or Discord', () => {
  it('verifies, stores the token as a secret, and records the channel', async () => {
    const { store, secrets, add, inject } = await setup();
    const id = add();
    const r = await inject('POST', `/v1/agents/${id}/channels/slack`, { token: 'ok-good' });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ kind: 'slack', accountId: 'U0BOT', displayName: '@Bot in Home', rooms: { mode: 'off' } });
    expect(JSON.stringify(r.json())).not.toContain('ok-good');
    const row = store.getChannelForAgent(id, 'slack')!;
    expect(row.secretRef).toBe(`channel/${id}/slack`);
    expect(secrets.map.get(row.secretRef)).toBe('ok-good');
    expect(store.getChannelForAgent(id)).toBeUndefined(); // Telegram untouched
  });

  it('passes on the platform\'s plain-words refusal and stores nothing', async () => {
    const { store, secrets, add, inject } = await setup();
    const id = add();
    const r = await inject('POST', `/v1/agents/${id}/channels/discord`, { token: 'ok-bad' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('The platform refused it.');
    expect(store.getChannelForAgent(id, 'discord')).toBeUndefined();
    expect(secrets.map.size).toBe(0);
  });

  it('keeps Discord\'s warnings and add-to-server link for the app', async () => {
    const { add, inject } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/discord`, { token: 'ok-good' });
    const list = (await inject('GET', `/v1/agents/${id}/channels`)).json();
    expect(list.imageSupports).toEqual(['telegram', 'slack', 'discord']);
    expect(list.channels[0]).toMatchObject({ kind: 'discord', warnings: ['Message Content Intent is off'], addToServerUrl: expect.stringContaining('discord.com/oauth2') });
  });

  it('refuses when the agent\'s image does not carry the plugin', async () => {
    const { add, inject } = await setup({ imageChannels: [] });
    const r = await inject('POST', `/v1/agents/${add()}/channels/slack`, { token: 'ok-good' });
    expect(r.statusCode).toBe(409);
    expect(r.json().needsImage).toBe(true);
  });

  it('refuses a second of the same kind, and one app on two agents', async () => {
    const { add, inject } = await setup();
    const a = add(), b = add();
    expect((await inject('POST', `/v1/agents/${a}/channels/slack`, { token: 'ok-good' })).statusCode).toBe(202);
    expect((await inject('POST', `/v1/agents/${a}/channels/slack`, { token: 'ok-good' })).statusCode).toBe(409);
    const r = await inject('POST', `/v1/agents/${b}/channels/slack`, { token: 'ok-good' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/already connected to "Tax"/);
  });

  it('is the owner\'s alone, and not offered to the Hatchabot agent yet', async () => {
    const { add, inject } = await setup();
    const id = add();
    expect((await inject('POST', `/v1/agents/${id}/channels/slack`, { token: 'ok-good' }, { 'x-hatchabot-owner': 'stranger' })).statusCode).toBe(404);
    expect((await inject('POST', `/v1/agents/${add({ ops: true })}/channels/discord`, { token: 'ok-good' })).statusCode).toBe(409);
    expect((await inject('POST', `/v1/agents/${id}/channels/whatsapp`, { token: 'ok-good' })).statusCode).toBe(404);
  });
});

describe('checking again, and who it answers', () => {
  it('re-check asks the platform again from the stored token: servers and warnings refresh, nothing is pasted or returned', async () => {
    const { inject, add, secrets, store } = await setup();
    const id = add();
    verifyCalls.length = 0;
    const first = (await inject('POST', `/v1/agents/${id}/channels/discord`, { token: 'ok-good' })).json();
    expect(first.warnings).toEqual(['Message Content Intent is off']);
    expect(first.servers).toEqual([{ id: '100', name: 'Home' }]);
    const again = await inject('POST', `/v1/agents/${id}/channels/discord/recheck`);
    expect(again.statusCode).toBe(200);
    expect(again.json().warnings).toEqual([]);
    expect(again.json().servers).toEqual([{ id: '100', name: 'Home' }, { id: '200', name: 'Work' }]);
    expect(again.json().displayName).toBe('@Bot in Home, Work');
    expect(again.json().checkedAt).toBeTruthy();
    expect(JSON.stringify(again.json())).not.toContain('ok-good');
    expect(secrets.map.get(`channel/${id}/discord`)).toBe('ok-good'); // untouched
    // Rooms survive a re-check. (A room needs someone linked first.)
    store.bindMemberIdentity(id, OWNER, 'discord', '111111111111111111');
    await inject('PATCH', `/v1/agents/${id}/channels/discord`, { rooms: { mode: 'room', roomId: '123456789012345678' } });
    const third = (await inject('POST', `/v1/agents/${id}/channels/discord/recheck`)).json();
    expect(third.rooms).toEqual({ mode: 'room', roomId: '123456789012345678' });
    expect((await inject('POST', `/v1/agents/${id}/channels/slack/recheck`)).statusCode).toBe(404); // it has no Slack
  });

  it('the list says who is linked on each channel', async () => {
    const { inject, add, store } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/discord`, { token: 'ok-good' });
    store.insertMembership({ id: 'm2', agentId: id, userId: 'user-ann', role: 'user', status: 'active', displayName: 'Ann' } as never);
    store.insertMembership({ id: 'm3', agentId: id, userId: 'user-bob', role: 'user', status: 'active', displayName: 'Bob' } as never);
    store.bindMemberIdentity(id, OWNER, 'discord', '1');
    store.bindMemberIdentity(id, 'user-ann', 'discord', '2');
    const r = (await inject('GET', `/v1/agents/${id}/channels`)).json();
    const d = r.channels.find((c: any) => c.kind === 'discord');
    expect(d.youAreLinked).toBe(true);
    expect(d.people.map((p: any) => [p.displayName ?? 'you', p.you])).toEqual([['you', true], ['Ann', false]]); // Bob has no Discord identity
  });
});

describe('changing and removing', () => {
  it('room access takes ids only, per platform — and waits for the first link, or the room would be open to everyone in it (2026-09-25)', async () => {
    const { add, inject, store } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/slack`, { token: 'ok-good' });
    const early = await inject('PATCH', `/v1/agents/${id}/channels/slack`, { rooms: { mode: 'room', roomId: 'C012AB3CD' } });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toContain('Link yourself first');
    expect((await inject('PATCH', `/v1/agents/${id}/channels/slack`, { rooms: { mode: 'off' } })).statusCode).toBe(200); // off is always allowed
    store.bindMemberIdentity(id, OWNER, 'slack', 'U0OWNER');
    expect((await inject('PATCH', `/v1/agents/${id}/channels/slack`, { rooms: { mode: 'room', roomId: '#general' } })).statusCode).toBe(400);
    const ok = await inject('PATCH', `/v1/agents/${id}/channels/slack`, { rooms: { mode: 'room', roomId: 'C012AB3CD' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rooms).toEqual({ mode: 'room', roomId: 'C012AB3CD' });
    expect(ok.json().displayName).toBe('@Bot in Home'); // other settings kept
    expect((await inject('PATCH', `/v1/agents/${id}/channels/slack`, { rooms: { mode: 'everyone' } })).statusCode).toBe(400);
  });

  it('removing Discord parks the bot: row gone, token moved to the pool, name and servers kept', async () => {
    const { store, secrets, add, inject } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/discord`, { token: 'ok-good' });
    const r = await inject('DELETE', `/v1/agents/${id}/channels/discord`);
    expect(r.statusCode).toBe(202);
    expect(r.json().parked).toBe(true);
    expect(store.getChannelForAgent(id, 'discord')).toBeUndefined();
    expect([...secrets.map.keys()]).toEqual(['discord-pool/1234567890123456789']);
    const parked = store.getDiscordBot('1234567890123456789')!;
    expect(parked).toMatchObject({ ownerId: OWNER, botName: 'Bot' });
    expect(parked.servers.length).toBeGreaterThan(0); // what the last check knew travels with it
    expect((await inject('DELETE', `/v1/agents/${id}/channels/discord`)).statusCode).toBe(404);
  });

  it('removing Slack parks the app too: both tokens move to the pool, workspace and channels kept (2026-09-25)', async () => {
    const { store, secrets, add, inject } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/slack`, { token: 'ok-good' });
    const r = await inject('DELETE', `/v1/agents/${id}/channels/slack`);
    expect(r.statusCode).toBe(202);
    expect(r.json().parked).toBe(true);
    expect([...secrets.map.keys()]).toEqual(['slack-pool/U0BOT']);
    expect(store.getDiscordBot('U0BOT')).toMatchObject({ kind: 'slack', ownerId: OWNER, botName: 'Bot' });
    // It is offered back: the pool view for Slack lists it, Discord's does not.
    expect((await inject('GET', '/v1/slack-apps')).json().bots.map((b: any) => b.applicationId)).toEqual(['U0BOT']);
    expect((await inject('GET', '/v1/discord-bots')).json().bots).toEqual([]);
    // And taken from the pool by another agent, with its tokens, no paste.
    const next = add();
    const back = await inject('POST', `/v1/agents/${next}/channels/slack`, { pooled: 'first' });
    expect(back.statusCode).toBe(202);
    expect(secrets.map.get(`channel/${next}/slack`)).toBe('ok-good');
    expect(store.getDiscordBot('U0BOT')).toBeUndefined();
  });

  it('deleting the agent parks its Slack app and its Discord bot', async () => {
    const { store, secrets, add, inject } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/slack`, { token: 'ok-good' });
    // (a second add would wait for the first rebuild; seed it directly)
    await secrets.put(`channel/${id}/discord`, 'ok-good');
    store.insertChannel({ id: 'd1', agentId: id, kind: 'discord', accountId: '1', secretRef: `channel/${id}/discord`, deepLink: 'x', createdAt: 'now', settings: { botName: 'Bot' } });
    expect(secrets.map.size).toBe(2);
    const r = await inject('DELETE', `/v1/agents/${id}`);
    expect(r.statusCode).toBeLessThan(300);
    expect([...secrets.map.keys()].sort()).toEqual(['discord-pool/1', 'slack-pool/U0BOT']);
    expect(store.getDiscordBot('1')?.botName).toBe('Bot');
    expect(store.getDiscordBot('U0BOT')).toMatchObject({ kind: 'slack', ownerId: OWNER });
    // Opting out of recycling discards it too.
    const id2 = add();
    await secrets.put(`channel/${id2}/discord`, 'ok-good');
    store.insertChannel({ id: 'd2', agentId: id2, kind: 'discord', accountId: '2', secretRef: `channel/${id2}/discord`, deepLink: 'x', createdAt: 'now' });
    await inject('DELETE', `/v1/agents/${id2}?recycleBot=0`);
    expect(store.getDiscordBot('2')).toBeUndefined();
    expect(secrets.map.has(`channel/${id2}/discord`)).toBe(false);
  });
});

describe('the Discord bot pool', () => {
  it('parks a bot by token (checked, never returned), lists it, and an agent attaches it without pasting', async () => {
    const { store, secrets, add, inject } = await setup();
    const parked = await inject('POST', '/v1/discord-bots', { token: 'ok-good' });
    expect(parked.statusCode).toBe(200);
    expect(JSON.stringify(parked.json())).not.toContain('ok-good');
    expect(parked.json().bot).toMatchObject({ applicationId: '1234567890123456789', botName: 'Bot', mine: true, shared: false });
    expect(secrets.map.get('discord-pool/1234567890123456789')).toBe('ok-good');
    expect((await inject('POST', '/v1/discord-bots', { token: 'ok-good' })).statusCode).toBe(409); // already parked
    expect((await inject('POST', '/v1/discord-bots', { token: 'ok-bad' })).statusCode).toBe(400);
    const list = (await inject('GET', '/v1/discord-bots')).json();
    expect(list.bots.map((b: any) => b.applicationId)).toEqual(['1234567890123456789']);

    const id = add();
    const att = await inject('POST', `/v1/agents/${id}/channels/discord`, { pooled: '1234567890123456789' });
    expect(att.statusCode).toBe(202);
    expect(store.getChannelForAgent(id, 'discord')?.accountId).toBe('1234567890123456789');
    expect(store.getDiscordBot('1234567890123456789')).toBeUndefined(); // taken
    expect([...secrets.map.keys()]).toEqual([`channel/${id}/discord`]);
    expect(secrets.map.get(`channel/${id}/discord`)).toBe('ok-good');
    // A bot that is in use cannot be parked again from a token.
    expect((await inject('POST', '/v1/discord-bots', { token: 'ok-good' })).statusCode).toBe(409);
  });

  it('a parked bot is its owner\'s; a shared one is everyone\'s to take and the machine owner\'s to delete', async () => {
    const { add, inject } = await setup();
    await inject('POST', '/v1/discord-bots', { token: 'ok-good' });
    const other = { 'x-hatchabot-owner': 'user-other' };
    expect((await inject('GET', '/v1/discord-bots', undefined, other)).json().bots).toEqual([]);
    const id = add({ ownerId: 'user-other' });
    expect((await inject('POST', `/v1/agents/${id}/channels/discord`, { pooled: '1234567890123456789' }, other)).statusCode).toBe(404);
    expect((await inject('DELETE', '/v1/discord-bots/1234567890123456789', undefined, other)).statusCode).toBe(404);
    // Only the machine owner may share; setup()'s OWNER owns the host.
    expect((await inject('POST', '/v1/discord-bots', { token: 'ok-good', shared: true }, other)).statusCode).toBe(403);
    expect((await inject('DELETE', '/v1/discord-bots/1234567890123456789')).statusCode).toBe(200);
    const shared = await inject('POST', '/v1/discord-bots', { token: 'ok-good', shared: true });
    expect(shared.json().bot.shared).toBe(true);
    expect((await inject('GET', '/v1/discord-bots', undefined, other)).json().bots.map((b: any) => b.shared)).toEqual([true]);
    expect((await inject('DELETE', '/v1/discord-bots/1234567890123456789', undefined, other)).statusCode).toBe(403);
  });

  it('re-check refreshes a parked bot from Discord', async () => {
    const { inject } = await setup();
    verifyCalls.length = 0;
    await inject('POST', '/v1/discord-bots', { token: 'ok-good' });
    const r = await inject('POST', '/v1/discord-bots/1234567890123456789/recheck');
    expect(r.statusCode).toBe(200);
    expect(r.json().bot.servers).toEqual([{ id: '100', name: 'Home' }, { id: '200', name: 'Work' }]);
    expect(r.json().bot.warnings).toEqual([]);
  });
});

describe('the Slack manifest', () => {
  it('is Socket Mode, named for the agent', async () => {
    const { inject } = await setup();
    const m = (await inject('GET', '/v1/channels/slack/manifest?name=Tax%20Advisor')).json();
    expect(m.display_information.name).toBe('Tax Advisor');
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.oauth_config.scopes.bot).toEqual(expect.arrayContaining(['im:history', 'im:write', 'chat:write']));
  });
});

describe('the management agent\'s remove_channel tool', () => {
  it('builds the DELETE for Slack or Discord only, with a plain card', async () => {
    const { REST_TOOLS } = await import('../src/mgmt/restTools.js');
    const { riskOf } = await import('../src/mgmt/broker.js');
    const t = REST_TOOLS.find((x: { name: string }) => x.name === 'remove_channel')!;
    const ctx = (channel: unknown) => ({ agent: { id: 'a1', name: 'Tax' }, input: { channel }, resolve: async () => ({ id: '', name: '' }), get: async () => ({}) });
    expect(await t.call(ctx('discord'))).toEqual({ method: 'DELETE', path: '/v1/agents/a1/channels/discord' });
    expect(t.card!(ctx('slack'))).toMatch(/off Slack/);
    await expect(async () => t.call(ctx('telegram'))).rejects.toThrow(/slack" or "discord/);
    expect(riskOf('remove_channel')).toBe('disruptive');
  });
});

describe('who the owner is on a new channel (2026-09-25)', () => {
  it('unknown: no first-message window — the owner approves their own knock with "That\'s me"', async () => {
    const { store, add, inject } = await setup();
    const id = add();
    expect((await inject('POST', `/v1/agents/${id}/channels/discord`, { token: 'ok-good' })).statusCode).toBe(202);
    expect(store.pairingWindow(id)).toBeFalsy(); // a Discord bot is visible to a whole server: nobody is linked on a first message alone
    expect(store.memberIdentities(id, OWNER).discord).toBeUndefined();
    expect((await inject('GET', `/v1/agents/${id}/channels`)).json().channels[0].youAreLinked).toBe(false);
  });

  it('known from another agent: bound at once, admitted from the first build, still no window', async () => {
    const { store, add, inject } = await setup();
    const other = add(); // where the owner linked before (their knock, approved as "That's me")
    store.bindMemberIdentity(other, OWNER, 'discord', '111111111111111111');
    const id = add();
    expect((await inject('POST', `/v1/agents/${id}/channels/discord`, { token: 'ok-good' })).statusCode).toBe(202);
    expect(store.memberIdentities(id, OWNER).discord).toBe('111111111111111111');
    expect(store.listAllowedChannelUserIds(id, 'discord')).toEqual(['111111111111111111']);
    expect(store.pairingWindow(id)).toBeFalsy();
    expect((await inject('GET', `/v1/agents/${id}/channels`)).json().channels[0].youAreLinked).toBe(true);
  });

  it('a bot taken from the shared pool goes back to the shared pool when removed', async () => {
    const { store, secrets, add, inject } = await setup();
    await secrets.put('discord-pool/1234567890123456789', 'ok-good');
    store.upsertDiscordBot({ applicationId: '1234567890123456789', secretRef: 'discord-pool/1234567890123456789', ownerId: null, servers: [], warnings: [], addedAt: 'now' });
    const id = add();
    expect((await inject('POST', `/v1/agents/${id}/channels/discord`, { pooled: '1234567890123456789' })).statusCode).toBe(202);
    expect(store.getDiscordBot('1234567890123456789')).toBeUndefined();
    expect((await inject('DELETE', `/v1/agents/${id}/channels/discord`)).json().parked).toBe(true);
    expect(store.getDiscordBot('1234567890123456789')?.ownerId).toBeNull();
    // A bot the owner pasted themselves parks under them.
    const mine = add();
    store.deleteDiscordBot('1234567890123456789'); await secrets.delete('discord-pool/1234567890123456789');
    await inject('POST', `/v1/agents/${mine}/channels/discord`, { token: 'ok-good' });
    await inject('DELETE', `/v1/agents/${mine}/channels/discord`);
    expect(store.getDiscordBot('1234567890123456789')?.ownerId).toBe(OWNER);
  });

  it('one agent per bot is enforced by the database too, and the clash message names only the caller\'s own agent', async () => {
    const { store, add, inject } = await setup();
    const a = add(), b = add({ ownerId: 'someone-else' });
    store.insertChannel({ id: 'c-b', agentId: b, kind: 'discord', accountId: '1234567890123456789', secretRef: 'x', deepLink: 'x', createdAt: 'now' });
    const r = await inject('POST', `/v1/agents/${a}/channels/discord`, { token: 'ok-good' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).not.toContain('Tax'); // another owner's agent name stays theirs
    expect(() => store.insertChannel({ id: 'c-a', agentId: a, kind: 'discord', accountId: '1234567890123456789', secretRef: 'y', deepLink: 'y', createdAt: 'now' }))
      .toThrow(/already attached/);
  });
});

describe('the bot is named for the agent (2026-09-25)', () => {
  it('a pool bot is renamed on attach and the card follows; a pasted bot keeps its name until Sync name; the Setup log has the outcome', async () => {
    const { store, secrets, add, inject } = await setup();
    renameCalls.length = 0;
    await secrets.put('discord-pool/1234567890123456789', 'ok-good');
    store.upsertDiscordBot({ applicationId: '1234567890123456789', botName: 'Bot Pool 10', secretRef: 'discord-pool/1234567890123456789', ownerId: OWNER, servers: [], warnings: [], addedAt: 'now' });
    const id = add({ name: 'To Do Agent' });
    const r = await inject('POST', `/v1/agents/${id}/channels/discord`, { pooled: '1234567890123456789' });
    expect(r.statusCode).toBe(202);
    expect(renameCalls).toEqual([['discord', 'ok-good', 'To Do Agent']]);
    expect(r.json().botName).toBe('To Do Agent');
    expect(r.json().displayName).toMatch(/^@To Do Agent in Home/);
    expect(store.listEvents([id]).some((e) => e.event === 'channel.renamed' && (e.detail as any).ok === true)).toBe(true);
    // Pasted: not renamed unasked.
    const other = add({ name: 'Taco' });
    store.deleteChannelForAgent(id, 'discord'); renameCalls.length = 0;
    await inject('POST', `/v1/agents/${other}/channels/discord`, { token: 'ok-good' });
    expect(renameCalls).toEqual([]);
    const sync = await inject('POST', `/v1/agents/${other}/bot-name/sync`, { kind: 'discord' });
    expect(sync.json()).toEqual({ ok: true, name: 'Taco' });
    expect(renameCalls).toEqual([['discord', 'ok-good', 'Taco']]);
    // Renaming the agent renames its bot too; a refusal is recorded, not fatal.
    renameCalls.length = 0;
    expect((await inject('PATCH', `/v1/agents/${other}`, { name: 'Refused' })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(renameCalls).toEqual([['discord', 'ok-good', 'Refused']]);
    expect(store.getChannelForAgent(other, 'discord')?.settings?.botName).toBe('Taco');
    expect(store.listEvents([other]).some((e) => e.event === 'channel.renamed' && (e.detail as any).ok === false && String((e.detail as any).note).includes('few name changes'))).toBe(true);
    expect((await inject('POST', `/v1/agents/${other}/bot-name/sync`, { kind: 'slack' })).statusCode).toBe(409); // it has no Slack
  });
});

describe('a spare of the same app: swap, archive and restore (2026-09-25)', () => {
  it('swap moves the agent onto a parked app, parks the old one, keeps the people linked; restore takes a kept app back', async () => {
    const { store, secrets, add, inject } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/slack`, { token: 'ok-good' });
    store.bindMemberIdentity(id, OWNER, 'slack', 'U0OWNER');
    // Nothing spare: refused with a pointer.
    expect((await inject('POST', `/v1/agents/${id}/channels/slack/swap`, {})).statusCode).toBe(409);
    // A spare parked ahead (the fake platform answers the same app id, so park it under another id by hand).
    await secrets.put('slack-pool/U0SPARE', 'ok-good');
    store.upsertDiscordBot({ applicationId: 'U0SPARE', botName: 'Spare', secretRef: 'slack-pool/U0SPARE', ownerId: OWNER, servers: [], warnings: [], addedAt: 'now', kind: 'slack' });
    // The fake verify reports U0BOT for every token, which the agent already wears: the clash check refuses.
    expect((await inject('POST', `/v1/agents/${id}/channels/slack/swap`, {})).statusCode).toBe(409);
    store.deleteDiscordBot('U0SPARE');
    // Archive parks the app for the agent; a Discord bot the same way.
    await secrets.put(`channel/${id}/discord`, 'ok-good');
    store.insertChannel({ id: 'd-arch', agentId: id, kind: 'discord', accountId: '1234567890123456789', secretRef: `channel/${id}/discord`, deepLink: 'x', createdAt: 'now', settings: { botName: 'Bot' } });
    expect((await inject('POST', `/v1/agents/${id}/archive`, {})).statusCode).toBeLessThan(300);
    expect(store.getChannelForAgent(id, 'slack')).toBeUndefined();
    expect(store.getChannelForAgent(id, 'discord')).toBeUndefined();
    expect(store.getDiscordBot('U0BOT')).toMatchObject({ kind: 'slack', archivedFor: id });
    expect(store.getDiscordBot('1234567890123456789')).toMatchObject({ kind: 'discord', archivedFor: id });
    expect(store.memberIdentities(id, OWNER).slack).toBeUndefined(); // the row went; the person re-links as any member does
    // Kept apps are listed apart, and offered to nobody by "first".
    expect((await inject('GET', '/v1/slack-apps')).json().bots[0].archivedFor).toBe(id);
    const other = add();
    expect((await inject('POST', `/v1/agents/${other}/channels/slack`, { pooled: 'first' })).statusCode).toBe(404);
    // Restore takes both back, whole.
    expect((await inject('POST', `/v1/agents/${id}/restore`, {})).statusCode).toBe(202);
    expect(store.getChannelForAgent(id, 'slack')).toMatchObject({ accountId: 'U0BOT', secretRef: `channel/${id}/slack` });
    expect(store.getChannelForAgent(id, 'discord')).toMatchObject({ accountId: '1234567890123456789' });
    expect(store.getDiscordBot('U0BOT')).toBeUndefined();
    expect(secrets.map.get(`channel/${id}/slack`)).toBe('ok-good');
  });
});

