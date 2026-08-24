/**
 * Shared end-to-end harness: a real Fastify app with the real routes, backed by
 * an in-memory store, a MockProvider runtime, and a stub channel — so tests can
 * drive the actual HTTP endpoints the web UI and CLI call, no Docker or Telegram
 * required. Auth is the `x-agentclaw-owner` header the test principal reads.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import Database from 'better-sqlite3';
import { Store } from '../../src/store/store.js';
import { MockProvider } from '../../src/providers/mockProvider.js';
import { registerRoutes } from '../../src/api/routes.js';
import type { SecretStore } from '../../src/secrets/secretStore.js';

export class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) {
    const v = this.map.get(ref);
    if (v === undefined) throw new Error(`missing secret ${ref}`);
    return v;
  }
  async delete(ref: string) { this.map.delete(ref); }
}

export const OWNER = 'user-owner';
/** Auth header for a given principal (defaults to the local-host owner). */
export const as = (owner: string = OWNER) => ({ 'x-agentclaw-owner': owner });

// Enough of the channel surface for the routes that touch it (pool status +
// ownership checks). Provisioning a fresh bot is the background path we don't
// assert on; the transfer flows carry their own bot token.
function channelStub(availableBots = 0) {
  return {
    kind: 'telegram',
    pool: { availableCount: () => availableBots, owns: (_a: string) => false },
  } as any;
}

export interface World {
  store: Store;
  secrets: MemSecrets;
  provider: MockProvider;
  f: FastifyInstance;
  owner: string;
}

/** A fresh installation whose local host + AI profile belong to `owner`. */
export async function makeWorld(owner: string = OWNER, availableBots = 0): Promise<World> {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: owner, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: owner, name: 'Claude', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  await secrets.put('ai/p1', 'sk-test');
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: channelStub(availableBots) });
  return { store, secrets, provider, f, owner };
}

export interface SeedOpts {
  id?: string;
  name?: string;
  slug?: string;
  owner?: string;
  accountId?: string;
  botToken?: string;
  memory?: string;
  sharedMemory?: boolean;
  /** extra members beyond the owner: [userId, displayName, channelUserId] */
  members?: Array<{ userId: string; displayName?: string; channelUserId?: string; role?: 'user' | 'owner' }>;
  ownerChannelUserId?: string;
}

/** Insert a RUNNING agent with a real MockProvider runtime + channel + members,
 *  the state a Download/Rehost/Clone would act on. Returns its id. */
export async function seedRunningAgent(w: World, opts: SeedOpts = {}): Promise<string> {
  const id = opts.id ?? 'a1';
  const slug = opts.slug ?? 'kitchen';
  const owner = opts.owner ?? w.owner;
  const accountId = opts.accountId ?? 'kitchenbot';
  w.store.insertAgent({
    id, ownerId: owner, name: opts.name ?? 'Kitchen', slug, state: 'PROVISIONING',
    aiProfileId: 'p1', hostId: 'h1', persona: 'helps cook', sharedMemory: opts.sharedMemory ?? true,
    createdAt: 'now', updatedAt: 'now',
  });
  const { runtimeRef } = await w.provider.provision({
    agentId: id, slug,
    workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } },
    env: {},
  });
  w.store.setAgentRuntimeRef(id, runtimeRef);
  await w.provider.start(runtimeRef);
  w.store.setAgentState(id, 'RUNNING');
  w.provider.stateStore.set(runtimeRef, Buffer.from(opts.memory ?? 'the-agents-memory'));

  await w.secrets.put(`chan/${id}`, opts.botToken ?? 'bot-token-123');
  w.store.insertChannel({ id: `c-${id}`, agentId: id, kind: 'telegram', accountId, secretRef: `chan/${id}`, deepLink: `https://t.me/${accountId}`, createdAt: 'now' });

  w.store.insertMembership({ id: `m-${id}-owner`, agentId: id, userId: owner, role: 'owner', status: 'active', channelUserId: opts.ownerChannelUserId ?? '111' });
  for (const [i, m] of (opts.members ?? []).entries()) {
    w.store.insertMembership({ id: `m-${id}-${i}`, agentId: id, userId: m.userId, role: m.role ?? 'user', displayName: m.displayName, status: 'active', channelUserId: m.channelUserId });
  }
  return id;
}
