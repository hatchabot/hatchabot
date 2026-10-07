import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createAgentRecord, runProvisionSteps, skipPoolOnce } from '../src/orchestrator/provision.js';
import { eventLabel } from '../src/orchestrator/eventLabels.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { registerRoutes } from '../src/api/routes.js';
import { ChannelSetupRequired } from '../src/channels/channel.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * An unarchived agent with no pool bot free used to sit in PROVISIONING on
 * "waiting for a bot token" until somebody pasted one (2026-10-07). The flows
 * that never ask about Telegram — unarchive, clone, derive, template import —
 * now carry on web-only, as `hbt skip-telegram` would, and the owner is told
 * in Alerts. Create still parks: its form and the CLI ask, so a token is coming.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error(`no secret ${r}`); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'owner-example';
const H = { 'x-hatchabot-owner': OWNER };

/** A pool that is empty unless stocked; a pasted token wins as it does in the composite. */
function channel(opts: { spare?: boolean } = {}) {
  return {
    kind: 'telegram' as const,
    pool: { owns: (u: string) => u === 'sparebot', addToPool: async () => {}, availableCount: () => (opts.spare ? 1 : 0) },
    discardPending: () => {},
    async provision(req: { agentId: string; skipPool?: boolean }) {
      if (req.skipPool || !opts.spare) throw new ChannelSetupRequired('paste a token', req.agentId);
      return { accountId: 'sparebot', secretRef: 'chan/spare', deepLink: 'https://t.me/sparebot' };
    },
    async release() {},
  };
}

function base() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  void secrets.put('ai/p1', 'sk-example');
  void secrets.put('chan/spare', '1:example');
  return { store, secrets };
}

describe('no pool bot free, in a flow that never asked', () => {
  it('carries on web-only instead of parking, and records why', async () => {
    const { store, secrets } = base();
    const agent = createAgentRecord(store, { ownerId: OWNER, name: 'Reading List', aiProfileId: 'p1', hostId: 'h1' });
    // The Setup log, as the routes' trace() writes it.
    const log = (e: string, d: Record<string, unknown>) => store.recordEvent(agent.id, e, d);
    const deps = { store, secrets, provider: new MockProvider(), channel: channel() as unknown as ChannelProvisioner, sleep: async () => {}, log, webOnlyIfNoBot: true };
    const res = await runProvisionSteps(deps, agent.id);
    expect(res.agent.state).toBe('RUNNING');
    expect(res.setupRequired).toBeUndefined();
    const after = store.getAgent(agent.id)!;
    expect(after.webOnly).toBe(true);
    expect(after.pendingAction).toBeUndefined();
    expect(store.getChannelForAgent(agent.id)).toBeUndefined();
    const ev = store.listEvents([agent.id], 200).find((e) => e.event === 'telegram.skipped')!;
    expect(ev.detail).toMatchObject({ auto: true });
    expect(eventLabel(ev.event, ev.detail)).toMatch(/no Telegram bot was free/);
    expect(store.telegramSkippedForNoBot(agent.id)).toBe(ev.at);
  });

  it('takes a spare bot when there is one', async () => {
    const { store, secrets } = base();
    const deps = { store, secrets, provider: new MockProvider(), channel: channel({ spare: true }) as unknown as ChannelProvisioner, sleep: async () => {}, webOnlyIfNoBot: true };
    const agent = createAgentRecord(store, { ownerId: OWNER, name: 'Reading List', aiProfileId: 'p1', hostId: 'h1' });
    await runProvisionSteps(deps, agent.id);
    expect(store.getAgent(agent.id)!.webOnly).toBeFalsy();
    expect(store.getChannelForAgent(agent.id)!.accountId).toBe('sparebot');
    expect(store.telegramSkippedForNoBot(agent.id)).toBeUndefined();
  });

  it('still parks without the option (create), and when the owner skipped the pool on purpose', async () => {
    const { store, secrets } = base();
    const plain = { store, secrets, provider: new MockProvider(), channel: channel() as unknown as ChannelProvisioner, sleep: async () => {} };
    const a = createAgentRecord(store, { ownerId: OWNER, name: 'Meal Plans', aiProfileId: 'p1', hostId: 'h1' });
    expect((await runProvisionSteps(plain, a.id)).setupRequired).toBeDefined();
    expect(store.getAgent(a.id)!.pendingAction?.type).toBe('bot_token');

    const b = createAgentRecord(store, { ownerId: OWNER, name: 'Bespoke', aiProfileId: 'p1', hostId: 'h1' });
    skipPoolOnce.add(b.id);
    expect((await runProvisionSteps({ ...plain, webOnlyIfNoBot: true }, b.id)).setupRequired).toBeDefined();
    expect(store.getAgent(b.id)!.webOnly).toBeFalsy();
  });

  it('the notice ends once a Telegram bot is attached or detached; a Discord change does not end it', () => {
    const { store } = base();
    const a = createAgentRecord(store, { ownerId: OWNER, name: 'Reading List', aiProfileId: 'p1', hostId: 'h1' });
    store.recordEvent(a.id, 'telegram.skipped', { why: 'no bot available' });
    expect(store.telegramSkippedForNoBot(a.id)).toBeUndefined(); // the owner's own choice: nothing to tell
    store.recordEvent(a.id, 'telegram.skipped', { why: 'no bot free', auto: true });
    store.recordEvent(a.id, 'channel.attached', { kind: 'discord', accountId: 'example-app' });
    expect(store.telegramSkippedForNoBot(a.id)).toBeDefined();
    store.recordEvent(a.id, 'channel.attached', { accountId: 'sparebot' });
    expect(store.telegramSkippedForNoBot(a.id)).toBeUndefined();
  });
});

describe('unarchive with an empty pool (the route)', () => {
  async function app() {
    const { store, secrets } = base();
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'book-club',
      workspace: { files: {}, configPatch: { agentId: 'book-club', authMode: 'api-key' } },
      env: {},
    });
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Book Club', slug: 'book-club', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' } as never);
    store.setAgentRuntimeRef('a1', runtimeRef);
    store.setAgentState('a1', 'RUNNING');
    store.setAgentState('a1', 'STOPPED');
    store.setAgentState('a1', 'ARCHIVED');
    const f = Fastify();
    await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: channel() as any });
    return { f, store };
  }

  it('comes back web-only and running, and the list tells its owner', async () => {
    const { f, store } = await app();
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/restore', headers: H });
    expect(res.statusCode).toBe(202);
    await vi.waitFor(() => expect(store.getAgent('a1')!.state).toBe('RUNNING'), { timeout: 15_000, interval: 50 });
    const a = store.getAgent('a1')!;
    expect(a.webOnly).toBe(true);
    expect(a.pendingAction).toBeUndefined();
    const row = (await f.inject({ method: 'GET', url: '/v1/agents', headers: H })).json().find((x: { id: string }) => x.id === 'a1');
    expect(row.telegramSkipped?.at).toBeTruthy();
    // Only its owner is told.
    const other = (await f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': 'someone-else' } })).json();
    expect(other.find((x: { id: string }) => x.id === 'a1')).toBeUndefined();
  }, 20_000);

  it('create with an empty pool still waits for the token its owner chose to paste', async () => {
    const { f, store } = await app();
    const res = await f.inject({ method: 'POST', url: '/v1/agents', headers: H, payload: { name: 'Fresh One', aiProfileId: 'p1', hostId: 'h1' } });
    expect(res.statusCode).toBe(202);
    const id = res.json().id;
    await vi.waitFor(() => expect(store.getAgent(id)!.pendingAction?.type).toBe('bot_token'), { timeout: 15_000, interval: 50 });
    expect(store.getAgent(id)!.webOnly).toBeFalsy();
  }, 20_000);
});
