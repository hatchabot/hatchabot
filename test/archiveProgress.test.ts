import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { ExecResult } from '../src/providers/provider.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Archiving with "save the conversation first" runs an agent turn (~20 s)
 * before the state changes. The tile used to look untouched all that time, as
 * if the click had done nothing (2026-10-07). The server now says it is
 * archiving from the first moment — on the agent, in the list, and as its
 * progress step — and clears that however the archive ends.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

/** A checkpoint turn that waits until the test lets it finish. */
class SlowTurnProvider extends MockProvider {
  release!: (r: ExecResult) => void;
  turnStarted!: Promise<void>;
  #started!: () => void;
  constructor() {
    super();
    this.turnStarted = new Promise((r) => { this.#started = r; });
  }
  override async exec(runtimeRef: string, argv: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
    if (argv[0] === 'agent') {
      this.#started();
      return new Promise<ExecResult>((r) => { this.release = r; });
    }
    return super.exec(runtimeRef, argv, opts);
  }
}

const OWNER = 'owner-example';
const as = { 'x-hatchabot-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new SlowTurnProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'garden',
    workspace: { files: {}, configPatch: { agentId: 'garden', authMode: 'api-key' } },
    env: {},
  });
  await provider.start(runtimeRef);
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Garden Helper', slug: 'garden', state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as never);
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.setAgentState('a1', 'RUNNING');
  const f = Fastify();
  await registerRoutes(f, {
    store,
    secrets: new MemSecrets(),
    providers: new Map([['mock', provider]]),
    channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 }, release: async () => {}, discardPending: () => {} } as any,
  });
  return { f, store, provider };
}

describe('archiving shows from the click, not from the end', () => {
  it('says "saving its conversation" while the checkpoint runs, then archives', async () => {
    const { f, store, provider } = await world();
    const pending = f.inject({ method: 'POST', url: '/v1/agents/a1/archive', headers: as, payload: { checkpoint: true } });
    await provider.turnStarted;

    // The agent itself, the list (as its progress step) — every browser and the CLI see it.
    const one = (await f.inject({ method: 'GET', url: '/v1/agents/a1', headers: as })).json();
    expect(one.state).toBe('RUNNING');
    expect(one.archiving?.step).toMatch(/saving its conversation to memory/);
    const list = (await f.inject({ method: 'GET', url: '/v1/agents', headers: as })).json();
    const row = list.find((a: { id: string }) => a.id === 'a1');
    expect(row.archiving?.step).toMatch(/saving its conversation/);
    expect(row.progress?.step).toMatch(/saving its conversation/);
    // The Setup log says so too.
    expect(store.listEvents(['a1'], 5).some((e) => e.event === 'agent.archiving')).toBe(true);

    // A second tap is told, not run as a second checkpoint.
    const again = await f.inject({ method: 'POST', url: '/v1/agents/a1/archive', headers: as, payload: { checkpoint: true } });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatch(/already being archived/);
    // Nor does a rebuild start under it (the stop would cut it off).
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/rebuild', headers: as, payload: {} })).statusCode).toBe(409);

    provider.release({ code: 0, stdout: 'DONE', stderr: '' });
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('ARCHIVED');
    expect(res.json().archiving).toBeUndefined();
    expect(res.json().checkpointWarning).toBeUndefined();
    const after = (await f.inject({ method: 'GET', url: '/v1/agents/a1', headers: as })).json();
    expect(after.archiving).toBeUndefined();
  });

  it('a checkpoint that fails still archives, with the warning, and the marker goes', async () => {
    const { f, provider } = await world();
    const pending = f.inject({ method: 'POST', url: '/v1/agents/a1/archive', headers: as, payload: { checkpoint: true } });
    await provider.turnStarted;
    provider.release({ code: 1, stdout: '', stderr: 'out of credits' });
    const res = await pending;
    expect(res.json().state).toBe('ARCHIVED');
    expect(res.json().checkpointWarning).toMatch(/couldn't save the conversation/);
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1', headers: as })).json().archiving).toBeUndefined();
  });

  it('an archive that fails clears the marker, so the tile does not spin forever', async () => {
    const { f, store, provider } = await world();
    // The stop throws while it is RUNNING: archiveAgent refuses and the bot is kept.
    provider.stop = async () => { throw new Error('docker did not answer'); };
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/archive', headers: as, payload: {} });
    expect(res.statusCode).toBe(502);
    expect(store.getAgent('a1')!.state).toBe('RUNNING');
    expect((await f.inject({ method: 'GET', url: '/v1/agents/a1', headers: as })).json().archiving).toBeUndefined();
  });
});
