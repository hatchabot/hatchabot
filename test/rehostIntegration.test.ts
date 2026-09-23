import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { registerAuth } from '../src/api/auth.js';
import { migrateAgent, MigrateError, versionBehind } from '../src/orchestrator/migrate.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { ChannelProvisioner } from '../src/channels/channel.js';

/**
 * Cross-server rehost over REAL HTTP: two in-process servers, real auth (a CLI
 * bearer token, exactly what peers use), real routes on the destination. The
 * unit tests stub the peer with canned Responses; this is the transport layer
 * they can't see — preflight refusals travelling the wire, the import route's
 * body handling, and the source's rollback behaviour on refusal.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

const channelStub = {
  kind: 'telegram',
  pool: { availableCount: () => 0, owns: () => false },
  release: async () => {},
} as unknown as ChannelProvisioner;

const openServers: FastifyInstance[] = [];
afterAll(async () => { for (const f of openServers) await f.close(); });

/** A destination server with real routes + real bearer auth, listening on 127.0.0.1. */
async function destination() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'hB', ownerId: 'owner-b', kind: 'local', provider: 'mock', name: 'dest', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'pB', ownerId: 'owner-b', name: 'B-AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/pB', createdAt: 'now' });
  await secrets.put('ai/pB', 'sk-b');

  const f = Fastify();
  await registerAuth(f, {
    password: 'dest-password',
    secret: Buffer.alloc(32, 7), // session-cookie HMAC key; any 32 bytes for tests
    cliTokenOwner: (token) => store.ownerForCliToken(token),
  });
  await registerRoutes(f, {
    store, secrets,
    providers: new Map([['mock', provider]]),
    channel: channelStub as never,
  });
  await f.listen({ port: 0, host: '127.0.0.1' });
  openServers.push(f);
  const addr = f.server.address() as { port: number };
  const { token } = store.createCliToken('owner-b', 'peer');
  return { store, provider, url: `http://127.0.0.1:${addr.port}`, token };
}

/** A source world with one RUNNING agent, wired to trust the destination. */
async function source(dest: { url: string; token: string }) {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  store.insertHost({ id: 'hA', ownerId: 'o', kind: 'local', provider: 'mock', name: 'src', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'pA', ownerId: 'o', name: 'A-AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/pA', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING', aiProfileId: 'pA', hostId: 'hA', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'o', role: 'owner', status: 'active' });
  store.insertChannel({ id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'kitchenbot', secretRef: 'chan/a1', deepLink: 'https://t.me/kitchenbot', createdAt: 'now' });
  await secrets.put('ai/pA', 'sk-a');
  await secrets.put('chan/a1', 'bot-token-secret');
  await secrets.put('peer/tok', dest.token);
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen',
    workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {},
  });
  store.setAgentRuntimeRef('a1', runtimeRef);
  await provider.start(runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  provider.stateStore.set(runtimeRef, Buffer.from('the-volume'));
  const peer = { id: 'p1', ownerId: 'o', name: 'Desktop', url: dest.url, secretRef: 'peer/tok', createdAt: 'now' };
  const deps = { store, secrets, provider, channel: channelStub as never, sleep: async () => {} };
  return { store, provider, deps, peer };
}

describe('rehost over real HTTP', () => {
  it('moves the agent: it lands on the destination, the source is tombstoned STOPPED', async () => {
    const dest = await destination();
    const src = await source(dest);

    const res = await migrateAgent(src.deps as never, 'a1', src.peer as never);
    expect(res.sourceState).toBe('STOPPED');

    // Landed: same slug, owned by the token's account, with the bot's secret.
    const arrived = dest.store.listAgents('owner-b').find((a) => a.slug === 'kitchen');
    expect(arrived).toBeDefined();
    expect(arrived!.name).toBe('Kitchen');
    // Source is tombstoned in place: STOPPED, marked moved, never deleted.
    const left = src.store.getAgent('a1')!;
    expect(left.state).toBe('STOPPED');
    expect(left.migratedTo).toBeTruthy();
  });

  it('a slug collision is refused over the wire and the source keeps RUNNING', async () => {
    const dest = await destination();
    // The destination already has a "kitchen" (any owner counts).
    dest.store.insertAgent({ id: 'zz', ownerId: 'owner-b', name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'pB', hostId: 'hB', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const src = await source(dest);

    await expect(migrateAgent(src.deps as never, 'a1', src.peer as never))
      .rejects.toThrow(/already lives here/);
    // Refused at preflight — nothing moved, nothing stopped, no tombstone.
    const a = src.store.getAgent('a1')!;
    expect(a.state).toBe('RUNNING');
    expect(a.migratedTo).toBeUndefined();
  });

  // A pinned derived image travels as its recipe, and is rebuilt there only
  // because the token belongs to that server's owner.
  const pinDerived = (src: Awaited<ReturnType<typeof source>>) => {
    src.store.upsertDerivedImage({ name: 'media', tag: 'hatchabot-runtime:derived-media', base: 'hatchabot-runtime:2026.7.1-2', dockerfile: 'RUN apt-get install -y ffmpeg', createdBy: 'o' });
    src.store.setDerivedImageStatus('media', 'READY');
    src.store.setAgentImage('a1', 'hatchabot-runtime:derived-media');
  };

  it('a pinned image is rebuilt on the destination from its recipe', async () => {
    const dest = await destination();
    dest.provider.publishedBases.add('hatchabot-runtime:2026.7.1-2');
    const src = await source(dest);
    pinDerived(src);

    const res = await migrateAgent(src.deps as never, 'a1', src.peer as never);
    expect(res.sourceState).toBe('STOPPED');
    const arrived = dest.store.listAgents('owner-b').find((a) => a.slug === 'kitchen');
    expect(arrived?.image).toBe('hatchabot-runtime:derived-media'); // the pin travelled
    expect(dest.provider.built.map((b) => b.tag)).toEqual(['hatchabot-runtime:derived-media']);
    expect(dest.provider.built[0]!.dockerfile).toContain('RUN apt-get install -y ffmpeg');
    // It is one of that machine's images now, so it can travel on from there.
    expect(dest.store.getDerivedImage('media')?.status).toBe('READY');
  });

  it("won't build for a token that isn't the destination owner's: refused, source back RUNNING", async () => {
    const dest = await destination();
    dest.provider.publishedBases.add('hatchabot-runtime:2026.7.1-2');
    dest.store.insertAIProfile({ id: 'pC', ownerId: 'guest', name: 'C-AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/pB', createdAt: 'now', shared: true } as never);
    const { token } = dest.store.createCliToken('guest', 'peer');
    const src = await source({ url: dest.url, token });
    pinDerived(src);

    await expect(migrateAgent(src.deps as never, 'a1', src.peer as never))
      .rejects.toThrow(/won't build it for this move .*--drop-pin/s);
    expect(dest.provider.built).toEqual([]);
    expect(src.store.getAgent('a1')!.state).toBe('RUNNING'); // undone
    expect(src.store.getAgent('a1')!.migratedTo).toBeUndefined();
  });

  it('--drop-pin moves it onto the default image, building nothing', async () => {
    const dest = await destination();
    const src = await source(dest);
    pinDerived(src);
    const res = await migrateAgent(src.deps as never, 'a1', src.peer as never, { allowDroppedPin: true });
    expect(res.sourceState).toBe('STOPPED');
    const arrived = dest.store.listAgents('owner-b').find((a) => a.slug === 'kitchen');
    expect(arrived?.image).toBeUndefined();
    expect(dest.provider.built).toEqual([]);
  });

  it('a bad peer token is a clean auth error, not a hang or a half-move', async () => {
    const dest = await destination();
    const src = await source({ url: dest.url, token: 'hatchabot_wrong' });
    await expect(migrateAgent(src.deps as never, 'a1', src.peer as never))
      .rejects.toThrow(/rejected our access token/);
    expect(src.store.getAgent('a1')!.state).toBe('RUNNING');
  });
});

describe('versionBehind (image-skew guard)', () => {
  it('compares dotted versions numerically, not lexicographically', () => {
    expect(versionBehind('2026.7.1-2', '2026.10.0')).toBe(true);  // the string-compare trap
    expect(versionBehind('2026.10.0', '2026.7.1-2')).toBe(false);
    expect(versionBehind('2026.7.1-2', '2026.7.1-2')).toBe(false); // equal is fine
    expect(versionBehind('2026.7.1', '2026.7.1-2')).toBe(true);    // build suffix counts
  });
});
