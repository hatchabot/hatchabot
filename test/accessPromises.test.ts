import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRoutes } from '../src/api/routes.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { closeKnockWindow, holdDoorForKnocks } from '../src/orchestrator/claim.js';
import { grantChannelAccess, grantRoomAccess } from '../src/orchestrator/members.js';
import type { Agent } from '../src/domain/types.js';

/**
 * Access promises the app makes, each checked against what enforces it
 * (2026-09-30): the Telegram invite's "wants to join" prompt, "Let them in
 * again" opening only the app they joined with, the Hatchabot agent never
 * taking members, and a newly admitted Slack/Discord person being let into
 * the rooms without a rebuild.
 */
const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };
// Made-up chat ids, built here rather than written as long literals.
const tgId = (n: number) => String(40_000 + n);
const discordId = (n: number) => '1' + String(n).padStart(17, '0');

async function world(opts: { ops?: boolean } = {}) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Tax', slug: 'a1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
    persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', ...(opts.ops ? { ops: true } : {}),
  } as unknown as Agent);
  const provider = new MockProvider();
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} } as never);
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'TaxBot', secretRef: 's', deepLink: 'https://t.me/TaxBot', createdAt: 'now' } as never);
  // The owner is linked, so the door rests in allowlist.
  store.insertMembership({ id: 'm0', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' } as never);
  store.bindMembershipChannelUser('a1', OWNER, tgId(1));
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
    providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never,
  } as never);
  /** The pending requests the container's pairing store holds. */
  const knocks = (requests: Array<{ id: string; code: string; meta?: Record<string, string> }>) => {
    provider.execShell = (async () => ({ code: 0, stdout: JSON.stringify({ version: 1, requests }), stderr: '' })) as never;
  };
  const policies = () => provider.execLog
    .filter((c) => c[0] === 'sh-volume')
    .map((c) => /"policy":"(allowlist|pairing)"/.exec(c[1] ?? '')?.[1])
    .filter(Boolean);
  return { store, provider, f, knocks, policies };
}

describe('the Telegram invite opens a knock window when sent (finding 1)', () => {
  it('copying opens one 30-minute window: the named person is SHOWN, a stranger is not, and nobody is admitted without a tap', async () => {
    const w = await world();
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: { for: '@Maria_K' } })).json();
    expect(w.store.pairingWindows('a1')).toEqual([]); // minting alone opens nothing

    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${inv.code}/knock-window`, headers: H });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ open: true, minutes: 30, for: 'maria_k' });
    const wins = w.store.pairingWindows('a1');
    expect(wins).toHaveLength(1);
    expect(wins[0]!.expect).toBe('maria_k');
    const mins = (Date.parse(wins[0]!.until) - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(29);
    expect(mins).toBeLessThanOrEqual(30);
    expect(w.policies()).toContain('pairing'); // the door answers while it stands

    // Pressing Copy again refreshes the same window, never a second one.
    await w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${inv.code}/knock-window`, headers: H });
    expect(w.store.pairingWindows('a1')).toHaveLength(1);

    w.knocks([
      { id: tgId(9), code: 'STRANGER', meta: { username: 'randomer' } },
      { id: tgId(5), code: 'MARIA', meta: { username: 'maria_k', firstName: 'Maria' } },
    ]);
    const pending = (await w.f.inject({ method: 'GET', url: '/v1/agents/a1/pairing', headers: H })).json();
    expect(pending.map((p: { code: string }) => p.code)).toEqual(['MARIA']); // shown as wanting to join
    // Shown, not admitted: no approval ran and nobody new is a member.
    expect(w.provider.execLog.some((c) => c[0] === 'pairing' && c[1] === 'approve')).toBe(false);
    expect(w.store.listMemberships('a1').filter((m) => m.status === 'active')).toHaveLength(1);

    // The owner's tap lets her in, and the window has done its job.
    const ok = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'MARIA', kind: 'telegram' } });
    expect(ok.statusCode).toBe(200);
    expect(w.store.getActiveMembershipByChannelUser('a1', tgId(5))).toBeTruthy();
    expect(w.store.pairingWindows('a1')).toEqual([]);
    expect(w.policies().at(-1)).toBe('allowlist'); // back to silence
  });

  it('refuses a code of another agent, a web-chat invite, and an agent that is not running', async () => {
    const w = await world();
    const post = (code: string) => w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${code}/knock-window`, headers: H });
    expect((await post('NOPE234567')).statusCode).toBe(404);
    w.store.insertInvite({ id: 'i-web', agentId: 'a1', code: 'WEBCHAT234', role: 'user', createdBy: OWNER, createdAt: 'now', expiresAt: new Date(Date.now() + 60_000).toISOString(), webChat: true });
    expect((await post('WEBCHAT234')).statusCode).toBe(404);
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} })).json();
    expect((await w.f.inject({ method: 'POST', url: `/v1/agents/a1/invites/${inv.code}/knock-window`, headers: { 'x-hatchabot-owner': 'someone-else' } })).statusCode).toBe(404);
    w.store.setAgentState('a1', 'STOPPED');
    expect((await post(inv.code)).statusCode).toBe(409);
    expect(w.store.pairingWindows('a1')).toEqual([]);
  });

  it('closes itself on time and puts the door back to silence', async () => {
    const w = await world();
    const deps = { store: w.store, provider: w.provider };
    const { seat } = await holdDoorForKnocks(deps, { agentId: 'a1', runtimeRef: w.store.getAgent('a1')!.runtimeRef!, accountId: 'TaxBot', key: 'inv-1', noTimer: true });
    expect(w.store.pairingWindows('a1').map((x) => x.seat)).toEqual([seat]);
    await closeKnockWindow(deps, 'a1', seat);
    expect(w.store.pairingWindows('a1')).toEqual([]);
    expect(w.policies()).toEqual(['pairing', 'allowlist']);
  });
});

describe('"Let them in again" opens only the app they joined with (finding 3)', () => {
  async function withDiscord() {
    const w = await world();
    w.store.insertChannel({ id: 'c2', agentId: 'a1', kind: 'discord', accountId: '123456789012345678', secretRef: 's2', deepLink: 'https://discord.com/users/x', createdAt: 'now' } as never);
    return w;
  }

  it('joined on Telegram: reopens Telegram, not Discord', async () => {
    const w = await withDiscord();
    const inv = (await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} })).json();
    const join = await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: inv.code, name: 'Maria', channel: 'telegram' } });
    expect(join.statusCode).toBe(201);
    const member = w.store.listMemberships('a1').find((m) => m.displayName === 'Maria')!;
    w.store.closePairingWindow('a1'); // the join's own window lapsed
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/a1/members/${member.userId}/reopen`, headers: H });
    expect(r.statusCode).toBe(200);
    expect(r.json().on).toEqual(['telegram']);
    await new Promise((res) => setTimeout(res, 20)); // the detached claim opens its window
    expect(w.store.pairingWindows('a1').map((x) => x.seat)).toEqual([`telegram:${member.userId}`]);
    w.store.closePairingWindow('a1');
  });

  it('app never recorded: refuses without a handle, and with one narrows every window to it', async () => {
    const w = await withDiscord();
    w.store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'member-old', role: 'user', status: 'active', displayName: 'Old' } as never);
    const url = '/v1/agents/a1/members/member-old/reopen';
    const bare = await w.f.inject({ method: 'POST', url, headers: H, payload: {} });
    expect(bare.statusCode).toBe(409);
    expect(bare.json().code).toBe('needs-handle');
    expect(w.store.pairingWindows('a1')).toEqual([]);
    const named = await w.f.inject({ method: 'POST', url, headers: H, payload: { handle: '@Old_One' } });
    expect(named.statusCode).toBe(200);
    expect(named.json().for).toBe('Old_One');
    await new Promise((res) => setTimeout(res, 20));
    const wins = w.store.pairingWindows('a1');
    expect(wins.length).toBe(2);
    expect(wins.every((x) => x.expect === 'old_one')).toBe(true);
    w.store.closePairingWindow('a1');
  });
});

describe('your Hatchabot agent is yours alone (finding 4)', () => {
  it('refuses invites, known people, admitting a knock and "anyone can knock" — but lets you link yourself', async () => {
    const w = await world({ ops: true });
    const said = (r: { statusCode: number; json: () => { error?: string } }) => [r.statusCode, r.json().error];
    const alone = [400, 'Your Hatchabot agent is yours alone.'];
    expect(said(await w.f.inject({ method: 'POST', url: '/v1/agents/a1/invites', headers: H, payload: {} }))).toEqual(alone);
    expect(said(await w.f.inject({ method: 'POST', url: '/v1/agents/a1/members/known', headers: H, payload: { userId: 'user-x' } }))).toEqual(alone);
    expect(said(await w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: true } }))).toEqual(alone);
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/allow-knocks', headers: H, payload: { on: false } })).statusCode).toBe(200);
    w.knocks([{ id: tgId(7), code: 'K1', meta: { firstName: 'Stranger' } }]);
    expect(said(await w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'K1', kind: 'telegram' } }))).toEqual(alone);
    expect(w.store.getActiveMembershipByChannelUser('a1', tgId(7))).toBeFalsy();
    const me = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/pairing/approve', headers: H, payload: { code: 'K1', kind: 'telegram', asSelf: true } });
    expect(me.statusCode).toBe(200);
    // A link minted for it before the refusal existed opens nothing either.
    w.store.insertInvite({ id: 'i-old', agentId: 'a1', code: 'OLDLINK234', role: 'user', createdBy: OWNER, createdAt: 'now', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect((await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: 'OLDLINK234', name: 'X', channel: 'telegram' } })).statusCode).toBe(400);
  });
});

describe('a newly admitted Slack/Discord person is let into the rooms live (finding 7)', () => {
  const HOME = '/home/node/.openclaw';
  function volume() {
    const dir = mkdtempSync(join(tmpdir(), 'rooms-'));
    mkdirSync(join(dir, 'credentials'));
    writeFileSync(join(dir, 'openclaw.json'), JSON.stringify({ channels: {
      discord: {
        accounts: { hatchabot: { dmPolicy: 'allowlist', allowFrom: [discordId(1)] } },
        guilds: { [discordId(900)]: { requireMention: true, users: [discordId(1)] }, [discordId(901)]: { requireMention: true } },
      },
      slack: { accounts: { hatchabot: { allowFrom: ['U0OWNER01'] } }, channels: { C0ROOM0001: { enabled: true, users: ['U0OWNER01'] } } },
    } }));
    const provider = {
      execShellOnVolume: async (_ref: string, script: string) => {
        try { return { code: 0, stdout: execFileSync('sh', ['-c', script.replaceAll(HOME, dir)], { encoding: 'utf8' }), stderr: '' }; }
        catch (e) { return { code: 1, stdout: '', stderr: String(e) }; }
      },
    } as never;
    const cfg = () => JSON.parse(readFileSync(join(dir, 'openclaw.json'), 'utf8'));
    return { dir, provider, cfg, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it('grantRoomAccess adds them to every room Hatchabot wrote, never to an open or empty one', async () => {
    const v = volume();
    try {
      const deps = { store: new Store(new Database(':memory:')), provider: v.provider };
      expect(await grantRoomAccess(deps, { agentId: 'a1', runtimeRef: 'r', kind: 'discord', channelUserId: discordId(2) })).toBe(true);
      const g = v.cfg().channels.discord.guilds;
      expect(g[discordId(900)].users).toEqual([discordId(1), discordId(2)]);
      expect(g[discordId(901)].users).toBeUndefined(); // no list = not ours to narrow
      // Twice is once.
      await grantRoomAccess(deps, { agentId: 'a1', runtimeRef: 'r', kind: 'discord', channelUserId: discordId(2) });
      expect(v.cfg().channels.discord.guilds[discordId(900)].users).toEqual([discordId(1), discordId(2)]);
      // Telegram has no per-room list: nothing to do.
      expect(await grantRoomAccess(deps, { agentId: 'a1', runtimeRef: 'r', kind: 'telegram', channelUserId: tgId(3) })).toBe(false);
    } finally { v.done(); }
  });

  it('grantChannelAccess (someone you already know) writes the rooms too', async () => {
    const v = volume();
    try {
      const deps = { store: new Store(new Database(':memory:')), provider: v.provider };
      await grantChannelAccess(deps, { agentId: 'a1', runtimeRef: 'r', kind: 'slack', accountId: 'hatchabot', channelUserId: 'U0GUEST001' });
      const sl = v.cfg().channels.slack;
      expect(sl.accounts.hatchabot.allowFrom).toEqual(['U0OWNER01', 'U0GUEST001']);
      expect(sl.channels.C0ROOM0001.users).toEqual(['U0OWNER01', 'U0GUEST001']);
    } finally { v.done(); }
  });
});
