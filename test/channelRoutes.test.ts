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
    const { inject, add, secrets } = await setup();
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
    // Rooms survive a re-check.
    await inject('PATCH', `/v1/agents/${id}/channels/discord`, { rooms: { mode: 'room', roomId: '123456789012345678' } });
    const third = (await inject('POST', `/v1/agents/${id}/channels/discord/recheck`)).json();
    expect(third.rooms).toEqual({ mode: 'room', roomId: '123456789012345678' });
    expect((await inject('POST', `/v1/agents/${id}/channels/slack/recheck`)).statusCode).toBe(404); // it has no Slack
  });

  it('the list says who is linked on each channel', async () => {
    const { inject, add, store } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/discord`, { token: 'ok-good' });
    store.insertMembership({ id: 'm1', agentId: id, userId: OWNER, role: 'owner', status: 'active' } as never);
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
  it('room access takes ids only, per platform', async () => {
    const { add, inject } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/slack`, { token: 'ok-good' });
    expect((await inject('PATCH', `/v1/agents/${id}/channels/slack`, { rooms: { mode: 'room', roomId: '#general' } })).statusCode).toBe(400);
    const ok = await inject('PATCH', `/v1/agents/${id}/channels/slack`, { rooms: { mode: 'room', roomId: 'C012AB3CD' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().rooms).toEqual({ mode: 'room', roomId: 'C012AB3CD' });
    expect(ok.json().displayName).toBe('@Bot in Home'); // other settings kept
    expect((await inject('PATCH', `/v1/agents/${id}/channels/slack`, { rooms: { mode: 'everyone' } })).statusCode).toBe(400);
  });

  it('removal deletes the row and the token', async () => {
    const { store, secrets, add, inject } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/discord`, { token: 'ok-good' });
    const r = await inject('DELETE', `/v1/agents/${id}/channels/discord`);
    expect(r.statusCode).toBe(202);
    expect(store.getChannelForAgent(id, 'discord')).toBeUndefined();
    expect(secrets.map.size).toBe(0);
    expect((await inject('DELETE', `/v1/agents/${id}/channels/discord`)).statusCode).toBe(404);
  });

  it('deleting the agent leaves no Slack or Discord token behind', async () => {
    const { store, secrets, add, inject } = await setup();
    const id = add();
    await inject('POST', `/v1/agents/${id}/channels/slack`, { token: 'ok-good' });
    // (a second add would wait for the first rebuild; seed it directly)
    await secrets.put(`channel/${id}/discord`, 'ok-good');
    store.insertChannel({ id: 'd1', agentId: id, kind: 'discord', accountId: '1', secretRef: `channel/${id}/discord`, deepLink: 'x', createdAt: 'now' });
    expect(secrets.map.size).toBe(2);
    const r = await inject('DELETE', `/v1/agents/${id}`);
    expect(r.statusCode).toBeLessThan(300);
    expect(secrets.map.size).toBe(0);
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
