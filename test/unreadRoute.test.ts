import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';

/** The unread mark on an agent's icon, and how opening its console clears it. */

const OWNER = 'o';
const H = { 'x-hatchabot-owner': OWNER };

async function setup(sessions: () => unknown, opts: { webOnly?: boolean; tasks?: unknown[] } = {}) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
  const provider = new MockProvider();
  vi.spyOn(provider, 'execShell').mockImplementation(async (_ref: string, script: string) =>
    ({ code: 0, stdout: script.includes('sessions.json') ? JSON.stringify(sessions()) : script.includes('cron_jobs') && opts.tasks ? JSON.stringify({ jobs: opts.tasks }) : '', stderr: '' }) as never);
  const f = Fastify();
  const secrets = { put: async () => {}, get: async () => 'x', delete: async () => {} };
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { kind: 'telegram', pool: { owns: () => false } } as never } as never);
  store.insertAgent({
    id: 'unread-a1', ownerId: OWNER, name: 'Notes', slug: 'notes', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef: 'mock://unread-a1',
    persona: '', sharedMemory: true, webOnly: opts.webOnly ?? true, createdAt: 'now', updatedAt: 'now',
  } as never);
  const unread = async () => ((await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json() as Array<{ id: string; unread?: boolean }>)
    .find((a) => a.id === 'unread-a1')?.unread;
  return { f, store, unread };
}

describe('unread mark', () => {
  it('does not flag an agent\'s whole past the first time it is looked at', async () => {
    const { unread } = await setup(() => ({ 'agent:notes:main': { updatedAt: Date.now() - 1000, lastChannel: 'webchat' } }));
    expect(await unread()).toBe(false);
  });

  it('flags console activity after the last look, and opening the console clears it', async () => {
    const { f, store, unread } = await setup(() => ({ 'agent:notes:main': { updatedAt: Date.now() - 1000, lastChannel: 'webchat' } }));
    store.setAgentSeen(OWNER, 'unread-a1', Date.now() - 60_000);
    expect(await unread()).toBe(true);
    const r = await f.inject({ method: 'POST', url: '/v1/agents/unread-a1/seen', headers: H });
    expect(r.statusCode).toBe(200);
    expect(await unread()).toBe(false);
  });

  it('a Telegram exchange is not flagged', async () => {
    const { store, unread } = await setup(() => ({ 'agent:notes:main': { updatedAt: Date.now() - 1000, lastChannel: 'telegram', lastTo: 'telegram:5' } }));
    store.setAgentSeen(OWNER, 'unread-a1', Date.now() - 60_000);
    expect(await unread()).toBe(false);
  });

  it('on an agent with a bot, a quiet task\'s run is flagged; an announcing task\'s is not (HB-0302)', async () => {
    const at = Date.now() - 1000;
    const tasks = [{ id: 'quiet-1', delivery: { mode: 'none' } }, { id: 'loud-1', delivery: { mode: 'announce', channel: 'telegram', to: '5' } }];
    const quiet = await setup(() => ({ 'agent:notes:cron:quiet-1:run:1': { updatedAt: at } }), { webOnly: false, tasks });
    quiet.store.setAgentSeen(OWNER, 'unread-a1', Date.now() - 60_000);
    expect(await quiet.unread()).toBe(true);
    const loud = await setup(() => ({ 'agent:notes:cron:loud-1': { updatedAt: at } }), { webOnly: false, tasks });
    loud.store.setAgentSeen(OWNER, 'unread-a1', Date.now() - 60_000);
    expect(await loud.unread()).toBe(false);
    // OpenClaw's own quiet upkeep (the weekly skill review) holds nothing to read.
    const upkeep = await setup(() => ({ 'agent:notes:cron:review-1:run:1': { updatedAt: at } }), { webOnly: false, tasks: [...tasks, { id: 'review-1', declarationKey: 'skill-collection-review', delivery: { mode: 'none' } }] });
    upkeep.store.setAgentSeen(OWNER, 'unread-a1', Date.now() - 60_000);
    expect(await upkeep.unread()).toBe(false);
    // Tasks that cannot be read: as before, a scheduled run is the bot's.
    const unknown = await setup(() => ({ 'agent:notes:cron:quiet-1': { updatedAt: at } }), { webOnly: false });
    unknown.store.setAgentSeen(OWNER, 'unread-a1', Date.now() - 60_000);
    expect(await unknown.unread()).toBe(false);
  });

  it('someone with no access cannot mark it read', async () => {
    const { f } = await setup(() => ({}));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/unread-a1/seen', headers: { 'x-hatchabot-owner': 'stranger' } });
    expect(r.statusCode).toBe(404);
  });
});
