/**
 * Deep audit of v2.166.2 (2026-10-24), the "accounts" group: class models and
 * the subscription guard, data-source limits and mount names, memberships and
 * invites, Google connections, and the manager's tools and proposal list.
 * Each case asserts what should happen; the audit number is in its name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { as, makeWorld, MemSecrets, seedRunningAgent, type World } from './support/world.js';
import { Store } from '../src/store/store.js';
import { registerMgmtChat } from '../src/api/mgmtChat.js';
import * as gitSource from '../src/orchestrator/gitSource.js';
import { GOOGLE_CLIENT_REF, materializeConnection } from '../src/orchestrator/googleConnections.js';
import { exportTemplate, parseTemplate } from '../src/orchestrator/template.js';
import { MAX_DATA_SOURCES } from '../src/orchestrator/dataSourceLimits.js';
import { Broker, followOperation } from '../src/mgmt/broker.js';
import { HttpApiClient } from '../src/mgmt/apiClient.js';
import { PendingStore, type PendingConfirm } from '../src/mgmt/pendingStore.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** The seeded agent on a source that offers two models, so a class can move it. */
async function classWorld(kind: 'api_key' | 'subscription' = 'api_key'): Promise<World & { id: string }> {
  const w = await makeWorld();
  w.store.insertAIProfile({ id: 'p2', ownerId: w.owner, name: 'Family plan', vendor: 'anthropic', kind, model: 'claude-sonnet-5', models: ['claude-haiku-4-5', 'claude-opus-5-5'], secretRef: 'ai/p2', createdAt: 'now' });
  await w.secrets.put('ai/p2', 'made-up-key');
  const id = await seedRunningAgent(w, { name: 'Homework Helper', slug: 'homework' });
  w.store.setAgentAIProfile(id, 'p2');
  w.store.setAgentApplied(id, 'p2', 'claude-sonnet-5');
  return { ...w, id };
}

describe('classes: what the runtime did with the model (audit #068)', () => {
  it('a class edit the runtime refused is reported per agent, not counted as applied', async () => {
    const w = await classWorld();
    w.store.upsertAgentClass({ id: 'k1', ownerId: w.owner, name: 'Light', model: 'claude-sonnet-5' });
    w.store.setAgentClass(w.id, 'k1');
    w.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: 'gateway not answering' });
    const res = await w.f.inject({ method: 'PUT', url: '/v1/agent-classes/k1', headers: as(), payload: { model: 'claude-haiku-4-5' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 0, needRebuild: 0, skipped: [] });
    expect(res.json().modelPending).toEqual([expect.stringContaining('Homework Helper: its runtime did not take claude-haiku-4-5')]);
    // The record has the class's model; the runtime is still on the old one.
    expect(w.store.getAgent(w.id)).toMatchObject({ model: 'claude-haiku-4-5', appliedModel: 'claude-sonnet-5' });
  });

  it('joining a class whose model the runtime refused says so', async () => {
    const w = await classWorld();
    w.store.upsertAgentClass({ id: 'k1', ownerId: w.owner, name: 'Light', model: 'claude-haiku-4-5' });
    w.provider.execResponses.set('models set', { code: 1, stdout: '', stderr: 'gateway not answering' });
    const res = await w.f.inject({ method: 'POST', url: `/v1/agents/${w.id}/class`, headers: as(), payload: { classId: 'k1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ classId: 'k1', rebuild: false });
    expect(res.json().modelPending).toMatch(/did not take claude-haiku-4-5/);
  });

  it('a model the runtime took is applied, with nothing pending', async () => {
    const w = await classWorld();
    w.store.upsertAgentClass({ id: 'k1', ownerId: w.owner, name: 'Light', model: 'claude-sonnet-5' });
    w.store.setAgentClass(w.id, 'k1');
    const res = await w.f.inject({ method: 'PUT', url: '/v1/agent-classes/k1', headers: as(), payload: { model: 'claude-haiku-4-5' } });
    expect(res.json()).toMatchObject({ applied: 1, needRebuild: 0, skipped: [], modelPending: [] });
    expect(w.store.getAgent(w.id)!.appliedModel).toBe('claude-haiku-4-5');
  });
});

describe('classes: the subscription runtime guard (audit #069)', () => {
  const tooOld = (w: World & { id: string }) => {
    w.provider.infoOverride.set(w.store.getAgent(w.id)!.runtimeRef!, { openclawVersion: '2026.9.6' });
  };

  it('a class cannot give a subscription agent a model its OpenClaw is too old for', async () => {
    const w = await classWorld('subscription');
    tooOld(w);
    const direct = await w.f.inject({ method: 'POST', url: `/v1/agents/${w.id}/model`, headers: as(), payload: { model: 'claude-opus-5-5' } });
    expect(direct.statusCode).toBe(409);
    w.store.upsertAgentClass({ id: 'k1', ownerId: w.owner, name: 'Deep', model: 'claude-opus-5-5' });
    const assigned = await w.f.inject({ method: 'POST', url: `/v1/agents/${w.id}/class`, headers: as(), payload: { classId: 'k1' } });
    expect(assigned.statusCode).toBe(400);
    expect(assigned.json().error).toMatch(/needs OpenClaw 2026\.9\.7/);
    expect(w.provider.execLog).not.toContainEqual(['models', 'set', 'anthropic/claude-opus-5-5']);
    expect(w.store.getAgent(w.id)).toMatchObject({ model: undefined, appliedModel: 'claude-sonnet-5' });
  });

  it('a class edit skips the member it would break, naming why', async () => {
    const w = await classWorld('subscription');
    tooOld(w);
    w.store.upsertAgentClass({ id: 'k1', ownerId: w.owner, name: 'Deep', model: 'claude-sonnet-5' });
    w.store.setAgentClass(w.id, 'k1');
    const res = await w.f.inject({ method: 'PUT', url: '/v1/agent-classes/k1', headers: as(), payload: { model: 'claude-opus-5-5' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: 0 });
    expect(res.json().skipped).toEqual([expect.stringMatching(/^Homework Helper: claude-opus-5-5 needs OpenClaw 2026\.9\.7/)]);
    expect(w.provider.execLog).not.toContainEqual(['models', 'set', 'anthropic/claude-opus-5-5']);
  });

  it('a new enough runtime takes it from a class as from the model menu', async () => {
    const w = await classWorld('subscription');
    w.provider.infoOverride.set(w.store.getAgent(w.id)!.runtimeRef!, { openclawVersion: '2026.9.8' });
    w.store.upsertAgentClass({ id: 'k1', ownerId: w.owner, name: 'Deep', model: 'claude-opus-5-5' });
    const assigned = await w.f.inject({ method: 'POST', url: `/v1/agents/${w.id}/class`, headers: as(), payload: { classId: 'k1' } });
    expect(assigned.statusCode).toBe(200);
    expect(w.store.getAgent(w.id)!.appliedModel).toBe('claude-opus-5-5');
  });

  it('a class that also changes the image is checked against that image', async () => {
    const w = await classWorld('subscription');
    w.provider.tags.push({ tag: 'hatchabot-runtime:2026.9.6', imageId: 'old-image', openclawVersion: '2026.9.6' });
    w.store.upsertAgentClass({ id: 'k1', ownerId: w.owner, name: 'Deep', model: 'claude-opus-5-5', image: 'hatchabot-runtime:2026.9.6' });
    const assigned = await w.f.inject({ method: 'POST', url: `/v1/agents/${w.id}/class`, headers: as(), payload: { classId: 'k1' } });
    expect(assigned.statusCode).toBe(400);
    expect(assigned.json().error).toMatch(/runs 2026\.9\.6/);
  });

  it('a class that moves a too-old agent to a new enough image gives it the model with that rebuild, not now', async () => {
    const w = await classWorld('subscription');
    tooOld(w);
    w.provider.tags.push({ tag: 'hatchabot-runtime:2026.9.8', imageId: 'new-image', openclawVersion: '2026.9.8' });
    w.store.upsertAgentClass({ id: 'k1', ownerId: w.owner, name: 'Deep', model: 'claude-opus-5-5', image: 'hatchabot-runtime:2026.9.8' });
    const assigned = await w.f.inject({ method: 'POST', url: `/v1/agents/${w.id}/class`, headers: as(), payload: { classId: 'k1' } });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({ classId: 'k1', rebuild: true });
    expect(w.provider.execLog).not.toContainEqual(['models', 'set', 'anthropic/claude-opus-5-5']);
    expect(w.store.getAgent(w.id)).toMatchObject({ model: 'claude-opus-5-5', appliedModel: 'claude-sonnet-5', image: 'hatchabot-runtime:2026.9.8' });
  });
});

describe('data sources: the limit a copy can carry, and one name per agent (audit #070, #073)', () => {
  const repo = (i: number) => ({ id: `ds-${i}`, agentId: 'a1', kind: 'git' as const, access: 'ro' as const, mountName: `notes-${i}`, repoUrl: `https://example.test/household/notes-${i}.git`, createdAt: 'now' });

  it('a 33rd source is refused before anything is written, so the agent still exports and reads back', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    for (let i = 0; i < MAX_DATA_SOURCES; i++) w.store.insertDataSource(repo(i));
    const keys = vi.spyOn(gitSource, 'generateDeployKey');
    const secretsBefore = w.secrets.map.size;
    const added = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources', headers: as(), payload: { kind: 'git', access: 'ro', repoUrl: 'https://example.test/household/recipes.git' } });
    expect(added.statusCode).toBe(409);
    expect(added.json().error).toMatch(/already has 32 data sources/);
    expect(w.store.listDataSources('a1')).toHaveLength(MAX_DATA_SOURCES);
    expect(keys).not.toHaveBeenCalled();
    expect(w.secrets.map.size).toBe(secretsBefore);
    const pub = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources', headers: as(), payload: { kind: 'git', access: 'ro', repoUrl: 'https://example.test/household/recipes.git', public: true } });
    expect(pub.statusCode).toBe(409);
    // What it has is still a template that reads back.
    w.provider.execResponses.set('sh', { code: 0, stdout: 'Helps the household cook.', stderr: '' });
    const exported = await exportTemplate({ store: w.store, provider: w.provider }, 'a1');
    expect(parseTemplate(exported.data).dataNeeds).toHaveLength(MAX_DATA_SOURCES);
  });

  it('two adds of repos with one name at once: one is added, the other refused', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    w.store.setAgentState('a1', 'STOPPED');
    vi.spyOn(gitSource, 'generateDeployKey').mockReturnValue({ privateKey: 'made-up private half', publicKey: 'made-up public half' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let saving = 0;
    const put = w.secrets.put.bind(w.secrets);
    w.secrets.put = async (ref: string, v: string) => { if (ref.startsWith('data-source/')) { saving++; await gate; } return put(ref, v); };
    const add = (owner: string) => w.f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources', headers: as(), payload: { kind: 'git', access: 'rw', repoUrl: `https://example.test/${owner}/shared-notes.git` } });
    try {
      // The first is saving its deploy key when the second arrives.
      const first = add('alder');
      await vi.waitFor(() => expect(saving).toBe(1));
      const second = await Promise.race([add('birch'), new Promise<'still saving'>((r) => setTimeout(() => r('still saving'), 1000))]);
      expect(second === 'still saving' ? second : second.statusCode).toBe(409);
      expect(saving).toBe(1);
      release();
      expect((await first).statusCode).toBe(200);
    } finally { release(); }
    expect(w.store.listDataSources('a1').map((d) => d.mountName)).toEqual(['shared-notes']);
    // Once the first is in, the name stays taken; and a different name is still fine.
    expect((await add('cedar')).statusCode).toBe(409);
    const other = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/data-sources', headers: as(), payload: { kind: 'git', access: 'rw', repoUrl: 'https://example.test/alder/garden-log.git' } });
    expect(other.statusCode).toBe(200);
  });
});

describe('members: adding someone you know who was removed here before (audit #071)', () => {
  it('takes up their old seat, active and linked, instead of failing on a second one', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'a1', name: 'Kitchen' });
    await seedRunningAgent(w, { id: 'a2', name: 'Garden', slug: 'garden', accountId: 'gardenbot',
      members: [{ userId: 'user-maria', displayName: 'Maria', channelUserId: '555' }] });
    w.store.insertMembership({ id: 'm-old', agentId: 'a1', userId: 'user-maria', role: 'user', status: 'active', displayName: 'Maria', channelUserId: '555' });
    w.store.revokeMembership('a1', 'user-maria');
    const offered = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/known-people', headers: as() });
    expect(offered.json()).toContainEqual({ userId: 'user-maria', name: 'Maria', on: ['telegram'] });

    const add = await w.f.inject({ method: 'POST', url: '/v1/agents/a1/members/known', headers: as(), payload: { userId: 'user-maria' } });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toEqual({ added: true, name: 'Maria' });
    expect(w.store.getMembership('a1', 'user-maria')).toMatchObject({ status: 'active', channelUserId: '555', displayName: 'Maria' });
    expect(w.store.listMemberships('a1').filter((m) => m.userId === 'user-maria')).toHaveLength(1);
    // The runtime's allowlist and the seat agree: offered no longer, and a second add is refused.
    expect((await w.f.inject({ method: 'GET', url: '/v1/agents/a1/known-people', headers: as() })).json()).toEqual([]);
    expect((await w.f.inject({ method: 'POST', url: '/v1/agents/a1/members/known', headers: as(), payload: { userId: 'user-maria' } })).statusCode).toBe(404);
  });
});

describe('invites: the app chosen on the page must still be there (audit #072)', () => {
  const invite = (w: World, code: string) => w.store.insertInvite({ id: `inv-${code}`, agentId: 'a1', code, role: 'user', createdBy: w.owner, createdAt: 'now', expiresAt: new Date(Date.now() + 3600_000).toISOString() });

  it('an app removed after the page loaded is refused without spending the invite', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    w.store.insertChannel({ id: 'c-discord', agentId: 'a1', kind: 'discord', accountId: 'default', secretRef: 'chan/a1-discord', deepLink: 'https://example.test/discord-invite', createdAt: 'now' });
    invite(w, 'PANTRYCODE');
    const page = await w.f.inject({ method: 'GET', url: '/v1/invites/PANTRYCODE' });
    expect(page.json().channels.map((c: { kind: string }) => c.kind)).toEqual(['telegram', 'discord']);
    w.store.deleteChannelForAgent('a1', 'discord'); // the owner removes Discord meanwhile

    const joined = await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: 'PANTRYCODE', name: 'Sam', channel: 'discord' } });
    expect(joined.statusCode).toBe(409);
    expect(joined.json().error).toMatch(/no longer on Discord.*reload this page/);
    expect(w.store.getInviteByCode('PANTRYCODE')!.redeemedAt).toBeFalsy();
    expect(w.store.listMemberships('a1').map((m) => m.userId)).toEqual([w.owner]);

    // Reloaded, the page offers Telegram, and the same invite works there.
    const again = await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: 'PANTRYCODE', name: 'Sam', channel: 'telegram' } });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ channel: 'telegram', deepLink: 'https://t.me/kitchenbot' });
  });

  it('an agent on no app yet still takes a Telegram join, as its invite page offers', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    w.store.deleteChannelForAgent('a1', 'telegram');
    invite(w, 'GARDENCODE');
    const joined = await w.f.inject({ method: 'POST', url: '/v1/join', payload: { code: 'GARDENCODE', name: 'Sam' } });
    expect(joined.statusCode).toBe(201);
    expect(w.store.getInviteByCode('GARDENCODE')!.redeemedAt).toBeTruthy();
  });
});

describe('Google connections: freshness and an unreadable list (audit #074, #075)', () => {
  it('a reconnect during a slow import leaves that agent shown as stale', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    const conn = { id: 'conn-1', ownerId: w.owner, kind: 'google', email: 'grandma@example.org', services: ['gmail'], secretRef: 'connection/conn-1', clientId: 'made-up-client' };
    await w.secrets.put(GOOGLE_CLIENT_REF, JSON.stringify({ clientId: 'made-up-client', clientSecret: 'made-up client half' }));
    await w.secrets.put(conn.secretRef, 'first made-up refresh value');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const importing = new Promise<void>((r) => { entered = r; });
    const shell = w.provider.execShell.bind(w.provider);
    w.provider.execShell = async (ref, script, opts) => {
      if (!script.includes('gog auth import')) return shell(ref, script, opts);
      entered(); await gate; return { code: 0, stdout: '', stderr: '' };
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
      w.store.insertConnection(conn);
      w.store.attachConnection('a1', conn.id, false);
      const done = materializeConnection({ store: w.store, secrets: w.secrets, provider: w.provider }, { id: 'a1', slug: 'kitchen', runtimeRef: w.store.getAgent('a1')!.runtimeRef! }, conn.id);
      await importing;
      // The owner reconnects the account: a new token and a new consent time.
      vi.setSystemTime(new Date('2026-10-20T10:01:00Z'));
      await w.secrets.put(conn.secretRef, 'second made-up refresh value');
      w.store.insertConnection(conn);
      vi.setSystemTime(new Date('2026-10-20T10:02:00Z'));
      release();
      expect(await done).toEqual({ ok: true });
      const listed = await w.f.inject({ method: 'GET', url: '/v1/connections', headers: as() });
      expect(listed.json().connections[0]).toMatchObject({ staleCount: 1, attachedTo: [{ id: 'a1', stale: true }] });
      // A later import reads the new token and is current again.
      w.provider.execShell = async () => ({ code: 0, stdout: '', stderr: '' });
      vi.setSystemTime(new Date('2026-10-20T10:03:00Z'));
      await materializeConnection({ store: w.store, secrets: w.secrets, provider: w.provider }, { id: 'a1', slug: 'kitchen', runtimeRef: w.store.getAgent('a1')!.runtimeRef! }, conn.id);
      const again = await w.f.inject({ method: 'GET', url: '/v1/connections', headers: as() });
      expect(again.json().connections[0]).toMatchObject({ staleCount: 0, attachedTo: [{ id: 'a1', stale: false }] });
    } finally { release(); vi.useRealTimers(); }
  });
});

describe("an agent's Google accounts when the read fails (audit #075)", () => {
  it('a failed read is a 502, not an empty list', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w);
    w.provider.execResponses.set('sh', { code: 1, stdout: '', stderr: 'temporary exec failure' });
    const failed = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/connections', headers: as() });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).not.toHaveProperty('accounts');
    w.provider.execResponses.set('sh', { code: 0, stdout: JSON.stringify({ accounts: [{ email: 'grandma@example.org', auth: 'oauth' }] }), stderr: '' });
    const read = await w.f.inject({ method: 'GET', url: '/v1/agents/a1/connections', headers: as() });
    expect(read.json()).toEqual({ accounts: [{ email: 'grandma@example.org', client: 'default', auth: 'oauth' }] });
    w.provider.execResponses.set('sh', { code: 0, stdout: '{"accounts":[]}', stderr: '' });
    expect((await w.f.inject({ method: 'GET', url: '/v1/agents/a1/connections', headers: as() })).json()).toEqual({ accounts: [] });
  });
});

// ---- the Hatchabot agent's tools (src/mgmt) ---------------------------------
const WHO = { ownerId: 'user-owner', chatId: 7001, fromUserId: 7002 };
const KITCHEN = { id: 'a1', name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1' };
function manager(request: (method: string, path: string, body?: unknown) => Promise<unknown>) {
  const pending = new PendingStore();
  const broker = new Broker(new HttpApiClient(request), pending);
  broker.setMode(true);
  const propose = async (tool: string, input: Record<string, unknown>) => {
    const r = await broker.handleTool(tool, input, WHO);
    if (!r.ok || !('pending' in r)) throw new Error(`no card: ${JSON.stringify(r)}`);
    return r.pending;
  };
  const confirm = async (tool: string, input: Record<string, unknown>) => {
    const card = await propose(tool, input);
    const done = await broker.confirm(card.confirmId, 'confirm', WHO);
    if (!done.ok) throw new Error(done.reason);
    return done.text;
  };
  return { broker, pending, propose, confirm };
}

describe('manager: a source name more than one source has (audit #076)', () => {
  const sources = [{ id: 'src-alder', name: 'Family plan' }, { id: 'src-birch', name: 'Family plan' }, { id: 'src-cedar', name: 'Work key' }];
  const api = async (_m: string, path: string) => (path === '/v1/agents' ? [KITCHEN] : path === '/v1/ai-profiles' ? sources : {});

  it('is refused with the ids to choose from, and no card', async () => {
    const r = await manager(api).broker.handleTool('set_source', { agent: 'a1', source: 'family PLAN' }, WHO);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toMatch(/More than one AI source is called "family PLAN": src-alder, src-birch/);
  });

  it('chosen by id, the card names which one', async () => {
    const { propose, pending } = manager(api);
    const card = await propose('set_source', { agent: 'a1', source: 'src-birch' });
    expect(card.summary).toContain('Family plan (src-birch)');
    expect(pending.peek(card.confirmId)!.resolved.rest!.call.body).toEqual({ aiProfileId: 'src-birch' });
    // A unique name is still enough, and its card needs no id.
    const plain = await propose('set_source', { agent: 'a1', source: 'work key' });
    expect(plain.summary).toContain('"Work key"');
    expect(pending.peek(plain.confirmId)!.resolved.rest!.call.body).toEqual({ aiProfileId: 'src-cedar' });
  });
});

describe('manager: what a confirmed change actually did (audit #077, #078)', () => {
  const api = (answers: Record<string, unknown>) => async (method: string, path: string) => {
    if (path === '/v1/agents') return [KITCHEN];
    if (path.endsWith('/available-models')) return { models: ['claude-haiku-4-5'] };
    if (path.includes('/model-check')) return { from: 'claude-opus-4-8', evidence: '', warnings: [], downgrade: false };
    const key = `${method} ${path}`;
    return key in answers ? answers[key] : {};
  };

  it('set_model that the runtime refused is a failure, with the way on', async () => {
    const { confirm } = manager(api({ 'POST /v1/agents/a1/model': { model: 'claude-haiku-4-5', live: false, staged: false, rebuild: false, failed: true } }));
    const text = await confirm('set_model', { agent: 'a1', model: 'claude-haiku-4-5' });
    expect(text).toMatch(/^⚠ Failed — /);
    expect(text).toMatch(/did not take claude-haiku-4-5.*still answers on its old model.*rebuild_agent/);
  });

  it('set_model says live, staged, waiting for a rebuild, or only recorded', async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ live: true }, /^✅ .*\nIt answers on claude-haiku-4-5 from its next message\./],
      [{ staged: true }, /^✅ .*\nIt is stopped: claude-haiku-4-5 is written to it/],
      [{ rebuild: true }, /^✅ .*\nAn AI-source switch is waiting for its rebuild too/],
      [{}, /^✅ .*\nRecorded, but not on the agent yet/],
    ];
    for (const [how, said] of cases) {
      const { confirm } = manager(api({ 'POST /v1/agents/a1/model': { model: 'claude-haiku-4-5', live: false, staged: false, rebuild: false, failed: false, ...how } }));
      expect(await confirm('set_model', { agent: 'a1', model: 'claude-haiku-4-5' })).toMatch(said);
    }
  });

  it('checkpoint_memory whose turn did not complete is a failure with the reason', async () => {
    const { confirm } = manager(api({ 'POST /v1/agents/a1/checkpoint': { ok: false, saved: false, error: "Couldn't save to memory — the agent's AI source didn't complete the turn." } }));
    const text = await confirm('checkpoint_memory', { agent: 'a1' });
    expect(text).toMatch(/^⚠ Failed — .*Couldn't save to memory/);
  });

  it('checkpoint_memory with nothing confirmed saved says so; a real save is a plain ✅', async () => {
    const unsure = manager(api({ 'POST /v1/agents/a1/checkpoint': { ok: true, saved: false, nothingNew: false, note: "It finished, but its memory files couldn't be checked, so it isn't known whether anything was saved." } }));
    expect(await unsure.confirm('checkpoint_memory', { agent: 'a1' })).toMatch(/^✅ .*\nIt finished, but its memory files couldn't be checked/);
    const saved = manager(api({ 'POST /v1/agents/a1/checkpoint': { ok: true, saved: true, notified: 1 } }));
    expect(await saved.confirm('checkpoint_memory', { agent: 'a1' })).toBe('✅ 📝 Save "Kitchen"\'s current conversation into its memory');
  });

  it('archive_agent passes on that the conversation was not saved first', async () => {
    const { confirm } = manager(api({ 'POST /v1/agents/a1/archive': { ...KITCHEN, state: 'ARCHIVED', checkpointWarning: "Archived, but couldn't save the conversation to memory first." } }));
    expect(await confirm('archive_agent', { agent: 'a1' })).toMatch(/^✅ .*\n⚠ Archived, but couldn't save the conversation to memory first\./);
  });
});

describe('manager: an operation answer already held or over (audit #079)', () => {
  const held = {
    id: 'op_m1', status: 'held', kind: 'move-host', agentId: 'a1',
    outcome: "Moving to Garden Runner was interrupted, and Garden Runner isn't answering.",
    recovery: { actions: [{ action: 'retry', label: 'Try again when Garden Runner is back' }, { action: 'put-back', label: 'Put it back on Home box' }], recommended: 'retry' },
  };

  it('recover_operation that is held again says so, with the choices, and polls nothing', async () => {
    const seen: string[] = [];
    const { confirm } = manager(async (method, path) => {
      seen.push(`${method} ${path}`);
      if (path === '/v1/agents') return [KITCHEN];
      if (path === '/v1/operations/op_m1') return held;
      if (method === 'POST' && path === '/v1/operations/op_m1/recover') return { operation: held, agent: KITCHEN };
      throw new Error(`unexpected ${method} ${path}`);
    });
    const text = await confirm('recover_operation', { operation: 'op_m1', action: 'retry' });
    expect(text).toContain("Garden Runner isn't answering");
    expect(text).toContain('It is waiting for the owner\'s choice (recover_operation op_m1): "retry" — Try again when Garden Runner is back; "put-back" — Put it back on Home box.');
    expect(seen.filter((x) => x === 'POST /v1/operations/op_m1/recover')).toHaveLength(1);
    expect(seen.filter((x) => x === 'GET /v1/operations/op_m1')).toHaveLength(1); // the card's own look-up, no polling after
  });

  it('an answer that already failed throws its outcome; one that succeeded says its outcome', async () => {
    const get = vi.fn(async () => ({}));
    await expect(followOperation({ operation: { id: 'op_f', status: 'failed', outcome: 'Garden Runner refused the copy.' } }, get)).rejects.toThrow('Garden Runner refused the copy.');
    await expect(followOperation({ operation: { id: 'op_r', status: 'rolled_back', outcome: 'Put back as it was.' } }, get)).rejects.toThrow('Put back as it was.');
    expect(await followOperation({ operation: { id: 'op_s', status: 'succeeded', outcome: 'Moved to Garden Runner.' } }, get)).toBe('Moved to Garden Runner.');
    expect(get).not.toHaveBeenCalled();
  });

  it("an agent's own record carrying its held operation is not this call's answer", async () => {
    const get = vi.fn(async () => ({}));
    expect(await followOperation({ ...KITCHEN, operation: held }, get)).toBeUndefined();
    expect(await followOperation({ restored: ['MEMORY.md'] }, get)).toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('proposals: a waiting card is not pushed out by a busy day (audit #080)', () => {
  it('stays in the list, and in the open-card count, behind 50 newer resolved ones', async () => {
    const store = new Store(new Database(':memory:'));
    const now = Date.now();
    const card = (id: string, createdAtMs: number): PendingConfirm => ({ id, ownerId: 'user-owner', chatId: 0, fromUserId: 0, messageId: 0, tool: 'stop_agent', resolved: { agentId: 'a1', agentName: 'Kitchen' }, summary: 'Stop Kitchen', createdAtMs, expiresAtMs: now + 3600_000, status: 'pending', source: 'agent' });
    for (let i = 0; i < 3; i++) store.putMgmtProposal(card(`waiting-${i}`, now - 100_000 + i));
    for (let i = 0; i < 50; i++) {
      store.putMgmtProposal(card(`done-${i}`, now - 50_000 + i));
      store.resolveMgmtProposal(`done-${i}`, 'confirmed', now - 49_000 + i);
      store.setMgmtProposalOutcome(`done-${i}`, 'Stopped.');
    }
    const listed = store.listMgmtProposals<PendingConfirm>('user-owner', now);
    expect(listed.filter((p) => p.status === 'pending').map((p) => p.id)).toEqual(['waiting-2', 'waiting-1', 'waiting-0']);
    expect(listed.filter((p) => p.status !== 'pending')).toHaveLength(50);
    expect(listed[0]!.id).toBe('done-49'); // newest first, as before

    const f = Fastify();
    try {
      registerMgmtChat(f, { store, secrets: new MemSecrets() });
      const res = await f.inject({ method: 'GET', url: '/v1/proposals', headers: as() });
      expect(res.statusCode).toBe(200);
      expect(res.json().pending.map((p: { confirmId: string }) => p.confirmId)).toEqual(['waiting-2', 'waiting-1', 'waiting-0']);
      expect(res.json().recent).toHaveLength(10);
    } finally { await f.close(); }
  });
});
