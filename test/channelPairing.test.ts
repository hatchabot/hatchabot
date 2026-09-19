import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { claimFirstContact } from '../src/orchestrator/claim.js';

/** Join requests on Slack and Discord: listed, approved, turned away, and claimed per channel. */

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };

async function setup(files: Record<string, unknown>) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  const provider = new MockProvider();
  const id = `pair-${Math.random().toString(36).slice(2, 8)}`;
  await provider.provision({ agentId: id, slug: id, workspace: { files: {}, configPatch: { agentId: id, authMode: 'api-key' } }, env: {} } as never);
  const ref = [...provider.runtimes.keys()].pop()!;
  // Serve a different pairing file per channel.
  vi.spyOn(provider, 'execShell').mockImplementation(async (_r: string, script: string) => {
    const hit = Object.entries(files).find(([name]) => script.includes(`${name}-pairing.json`));
    return { code: 0, stdout: hit ? JSON.stringify(hit[1]) : '', stderr: '' } as never;
  });
  provider.execResponses.set('pairing approve', { code: 0, stdout: 'ok', stderr: '' });
  const f = Fastify();
  await registerRoutes(f, { store, secrets: { put: async () => {}, get: async () => 'x', delete: async () => {} } as never,
    providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } as never } as never);
  store.insertAgent({ id, ownerId: OWNER, name: 'Tax', slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: ref,
    persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
  store.insertMembership({ id: 'mo', agentId: id, userId: OWNER, role: 'owner', status: 'active' });
  store.insertChannel({ id: 'ct', agentId: id, kind: 'telegram', accountId: 'TaxBot', secretRef: 's', deepLink: 'https://t.me/TaxBot', createdAt: 'now' });
  store.insertChannel({ id: 'cs', agentId: id, kind: 'slack', accountId: 'U0BOT', secretRef: 's2', deepLink: 'https://slack', createdAt: 'now', settings: { team: 'Home' } });
  const inject = (method: string, url: string, payload?: unknown) => f.inject({ method: method as never, url, headers: H, payload: payload as never });
  return { store, provider, id, ref, inject, f };
}

const FILES = {
  telegram: { requests: [{ id: '555', code: 'TGCODE01', meta: { firstName: 'Gran' } }] },
  slack: { requests: [{ id: 'U0SIS', code: 'SLCODE01', meta: { firstName: 'Sis', accountId: 'hatchabot' } }] },
};

describe('join requests per channel', () => {
  it('lists requests from every channel, each marked', async () => {
    const { id, inject } = await setup(FILES);
    const list = (await inject('GET', `/v1/agents/${id}/pairing`)).json();
    expect(list.map((r: { kind: string; code: string }) => `${r.kind}:${r.code}`).sort()).toEqual(['slack:SLCODE01', 'telegram:TGCODE01']);
    const pending = (await inject('GET', '/v1/pending')).json();
    expect(pending.find((p: { kind: string }) => p.kind === 'slack')).toMatchObject({ channelUserId: 'U0SIS', code: 'SLCODE01' });
    expect(pending.find((p: { kind: string }) => p.kind === 'slack').telegramId).toBeUndefined();
    expect(pending.find((p: { kind: string }) => p.kind === 'telegram').telegramId).toBe('555');
  });

  it('approving a Slack code without naming the channel still lands on Slack', async () => {
    const { store, provider, id, inject } = await setup(FILES);
    const r = await inject('POST', `/v1/agents/${id}/pairing/approve`, { code: 'SLCODE01' });
    expect(r.statusCode).toBe(200);
    expect(provider.execLog.map((a) => a.join(' '))).toContain('pairing approve slack SLCODE01 --account hatchabot');
    expect(store.getMemberByIdentity(id, 'slack', 'U0SIS')).toBeDefined();
  });

  it('a Telegram code still goes to Telegram, unchanged', async () => {
    const { provider, id, inject } = await setup(FILES);
    expect((await inject('POST', `/v1/agents/${id}/pairing/approve`, { code: 'TGCODE01' })).statusCode).toBe(200);
    expect(provider.execLog.map((a) => a.join(' '))).toContain('pairing approve telegram TGCODE01 --account TaxBot');
  });

  it('turning a Slack request away edits the Slack pairing file', async () => {
    const { provider, id, inject } = await setup(FILES);
    provider.execResponses.set('sh-volume', { code: 0, stdout: '1', stderr: '' });
    const r = await inject('POST', `/v1/agents/${id}/pairing/deny`, { code: 'SLCODE01', kind: 'slack' });
    expect(r.json()).toEqual({ denied: true });
    expect(provider.execLog.find((a) => a[0] === 'sh-volume')![1]).toContain('slack-pairing.json');
  });

  it('refuses an unknown channel name', async () => {
    const { id, inject } = await setup(FILES);
    expect((await inject('POST', `/v1/agents/${id}/pairing/approve`, { code: 'SLCODE01', kind: 'whatsapp' })).statusCode).toBe(400);
  });
});

describe('claiming on Slack', () => {
  it('binds the first Slack request to the member, leaving Telegram alone', async () => {
    const { store, provider, id, ref } = await setup(FILES);
    const got = await claimFirstContact({ store, provider, sleep: async () => {} }, { agentId: id, runtimeRef: ref, accountId: 'hatchabot', forUserId: OWNER, kind: 'slack', timeoutMs: 1000 });
    expect(got).toBe('U0SIS');
    expect(store.memberIdentities(id, OWNER)).toEqual({ slack: 'U0SIS' });
  });

  it('never binds a Slack identity that already belongs to someone else', async () => {
    const { store, provider, id, ref } = await setup(FILES);
    store.insertMembership({ id: 'm2', agentId: id, userId: 'sis', role: 'user', status: 'active' });
    store.bindMemberIdentity(id, 'sis', 'slack', 'U0SIS');
    const got = await claimFirstContact({ store, provider, sleep: async () => {} }, { agentId: id, runtimeRef: ref, accountId: 'hatchabot', forUserId: OWNER, kind: 'slack', timeoutMs: 50, pollIntervalMs: 10 });
    expect(got).toBeNull();
  });
});

describe('joining through a Slack invite', () => {
  const invite = (store: Store, agentId: string, code: string) => store.insertInvite({
    id: code, agentId, code, role: 'user', createdBy: OWNER, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  });

  it('answers with the chosen channel and every way in', async () => {
    const { store, id, f } = await setup(FILES);
    invite(store, id, 'JOINSLACK1');
    const r = await f.inject({ method: 'POST', url: '/v1/join', payload: { code: 'JOINSLACK1', name: 'Sis', channel: 'slack' } });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body).toMatchObject({ agentName: 'Tax', channel: 'slack', deepLink: 'https://slack' });
    expect(body.botUsername).toBeUndefined();
    expect(body.channels.map((c: { kind: string }) => c.kind)).toEqual(['telegram', 'slack']);
    expect(body.channels[1].team).toBe('Home');
  });

  it('an old join page (no channel) still means Telegram', async () => {
    const { store, id, f } = await setup(FILES);
    invite(store, id, 'JOINTG0001');
    const body = (await f.inject({ method: 'POST', url: '/v1/join', payload: { code: 'JOINTG0001', name: 'Gran' } })).json();
    expect(body).toMatchObject({ channel: 'telegram', botUsername: 'TaxBot', deepLink: 'https://t.me/TaxBot' });
  });

  it('refuses a channel it does not know', async () => {
    const { store, id, f } = await setup(FILES);
    invite(store, id, 'JOINBAD001');
    expect((await f.inject({ method: 'POST', url: '/v1/join', payload: { code: 'JOINBAD001', channel: 'sms' } })).statusCode).toBe(400);
  });
});
