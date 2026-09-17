import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { recordApplied } from '../src/orchestrator/provision.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

const OWNER = 'user-o';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

async function world(provider: MockProvider = new MockProvider()) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  for (const [id, slug, name] of [['x', 'investing', 'Investing'], ['y', 'tax', 'Tax']] as const) {
    const { runtimeRef } = await provider.provision({ agentId: id, slug, workspace: { files: {}, configPatch: { agentId: slug, authMode: 'api-key' } as any }, env: {} });
    await provider.start(runtimeRef);
    store.insertAgent({ id, ownerId: OWNER, name, slug, state: 'PROVISIONING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    store.setAgentRuntimeRef(id, runtimeRef);
    store.setAgentState(id, 'RUNNING');
  }
  const secrets = new MemSecrets();
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
  // The Tax agent's turn returns a canned reply (prefix-matched on argv).
  provider.execResponses.set('agent --agent tax', { code: 0, stdout: 'Harvest the losses; watch the wash-sale window.', stderr: '' });
  return { store, provider, secrets, f };
}

describe('agent-to-agent consult', () => {
  it('a granted agent consults its peer and gets the reply', async () => {
    const { store, f } = await world();
    store.setAgentPeers('x', ['y']); // Investing may consult Tax
    const token = store.createAgentCallToken('x', OWNER);

    const res = await f.inject({
      method: 'POST', url: '/v1/agents/y/message',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'Should I harvest these losses?' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().reply).toMatch(/harvest the losses/i);
  });

  it('rejects a call with no token (401)', async () => {
    const { f } = await world();
    const res = await f.inject({ method: 'POST', url: '/v1/agents/y/message', payload: { text: 'hi' } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a caller without a grant (403), and does not run a turn', async () => {
    const { store, provider, f } = await world();
    const token = store.createAgentCallToken('x', OWNER); // token but NO peer grant
    const before = provider.execLog.length;
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/y/message',
      headers: { authorization: `Bearer ${token}` }, payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(403);
    expect(provider.execLog.length).toBe(before); // never reached the turn
  });

  it('an A2A token cannot act as a general owner bearer (ownerForCliToken rejects it)', async () => {
    const { store } = await world();
    const token = store.createAgentCallToken('x', OWNER);
    expect(store.ownerForCliToken(token)).toBeUndefined(); // scoped to /message only
  });

  it('granting peers marks the agent peersPending until a rebuild snapshots them', async () => {
    const { store, f } = await world();
    // No peers yet → not pending.
    let x = (await f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': OWNER } })).json().find((a: any) => a.id === 'x');
    expect(x.peersPending).toBe(false);
    // Grant a peer → pending (call-agent tool isn't installed until a rebuild).
    store.setAgentPeers('x', ['y']);
    x = (await f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': OWNER } })).json().find((a: any) => a.id === 'x');
    expect(x.peersPending).toBe(true);
    // A LIVE model change calls recordApplied too — it must NOT clear the flag
    // (nothing installed the call-agent tool). Audit 2026-09-11 MAJOR.
    recordApplied(store, 'x');
    x = (await f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': OWNER } })).json().find((a: any) => a.id === 'x');
    expect(x.peersPending).toBe(true);
    // Only the provision/rebuild path records the peer set as installed.
    store.recordAppliedPeers('x');
    x = (await f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': OWNER } })).json().find((a: any) => a.id === 'x');
    expect(x.peersPending).toBe(false);
  });

  it('a live model change via POST /model leaves peersPending set', async () => {
    const { store, f } = await world();
    store.setAgentPeers('x', ['y']);
    const res = await f.inject({ method: 'POST', url: '/v1/agents/x/model', headers: { 'x-hatchabot-owner': OWNER }, payload: { model: null } });
    expect(res.json().live).toBe(true);
    const x = (await f.inject({ method: 'GET', url: '/v1/agents', headers: { 'x-hatchabot-owner': OWNER } })).json().find((a: any) => a.id === 'x');
    expect(x.peersPending).toBe(true);
  });

  it('never hands the caller a docker/openclaw error as the peer\'s answer (502/504)', async () => {
    const { store, provider, f } = await world();
    store.setAgentPeers('x', ['y']);
    const token = store.createAgentCallToken('x', OWNER);
    provider.execResponses.set('agent --agent tax', { code: 1, stdout: '', stderr: 'auth profile missing: sk-...' });
    let res = await f.inject({ method: 'POST', url: '/v1/agents/y/message', headers: { authorization: `Bearer ${token}` }, payload: { text: 'q' } });
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toContain('sk-'); // stderr never relayed
    provider.execResponses.set('agent --agent tax', { code: 1, timedOut: true, stdout: '', stderr: 'docker exec timed out' } as any);
    res = await f.inject({ method: 'POST', url: '/v1/agents/y/message', headers: { authorization: `Bearer ${token}` }, payload: { text: 'q' } });
    expect(res.statusCode).toBe(504);
  });

  it('rate-limits consults per caller agent (HATCHABOT_A2A_PER_HOUR)', async () => {
    process.env.HATCHABOT_A2A_PER_HOUR = '2';
    try {
      const { store, f } = await world();
      store.setAgentPeers('x', ['y']);
      const token = store.createAgentCallToken('x', OWNER);
      const call = () => f.inject({ method: 'POST', url: '/v1/agents/y/message', headers: { authorization: `Bearer ${token}` }, payload: { text: 'q' } });
      expect((await call()).statusCode).toBe(200);
      expect((await call()).statusCode).toBe(200);
      const third = await call();
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toMatch(/consult limit/i);
    } finally { delete process.env.HATCHABOT_A2A_PER_HOUR; }
  });

  it('refuses a consult to an agent that is itself mid-consult (breaks A→B→A loops)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    class SlowProvider extends MockProvider {
      override async exec(ref: string, argv: string[]) { if (argv[0] === 'agent') await gate; return super.exec(ref, argv); }
    }
    const provider = new SlowProvider();
    const { store, f } = await world(provider);
    store.setAgentPeers('x', ['y']);
    const token = store.createAgentCallToken('x', OWNER);
    const first = f.inject({ method: 'POST', url: '/v1/agents/y/message', headers: { authorization: `Bearer ${token}` }, payload: { text: 'one' } });
    await new Promise((r) => setTimeout(r, 20)); // first consult is now awaiting the peer's turn
    const second = await f.inject({ method: 'POST', url: '/v1/agents/y/message', headers: { authorization: `Bearer ${token}` }, payload: { text: 'two' } });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toMatch(/already answering/i);
    release();
    expect((await first).statusCode).toBe(200);
  });

  it('lists/revokes only user CLI tokens — the A2A token is invisible and unrevokable there, and re-mintable', async () => {
    const { store } = await world();
    const token = store.createAgentCallToken('x', OWNER);
    expect(store.listCliTokens(OWNER).some((t) => t.label === 'a2a')).toBe(false);
    const row = store['db'].prepare('SELECT id FROM cli_tokens WHERE agent_id = ?').get('x') as { id: string };
    expect(store.revokeCliToken(OWNER, row.id)).toBe(false); // not a user token
    expect(store.hasAgentCallToken('x')).toBe(true);
    expect(store.agentForCallToken(token)?.agentId).toBe('x');
  });
});

describe('a peer the owner authorized may be asked to act', () => {
  it('changes the framing the peer actually receives', async () => {
    const { store, provider, f } = await world();
    const token = store.createAgentCallToken('x', OWNER);

    // Default grant: the peer is told to answer but never act.
    store.setAgentPeers('x', ['y']);
    await f.inject({ method: 'POST', url: '/v1/agents/y/message', headers: { authorization: `Bearer ${token}` }, payload: { text: 'reset the test jobs' } });
    let sent = provider.execLog.at(-1)!.join(' ');
    expect(sent).toContain('UNTRUSTED');
    expect(sent).toContain('Do NOT take actions');

    // Authorized pair: it may act — but the secret rule survives either way.
    store.setAgentPeers('x', ['y'], ['y']);
    await f.inject({ method: 'POST', url: '/v1/agents/y/message', headers: { authorization: `Bearer ${token}` }, payload: { text: 'reset the test jobs' } });
    sent = provider.execLog.at(-1)!.join(' ');
    expect(sent).toContain('AUTHORIZED this peer');
    expect(sent).not.toContain('Do NOT take actions');
    expect(sent).toContain('never reveal credentials'); // not negotiable
  });

  // A QA agent resetting the system it tests has to ask that system to change
  // its own state — the default framing tells the peer to refuse exactly that.
  // The flag is per pair, owner-set, and never relaxes the secret rule.
  it('frames an authorized consult as actionable and an ordinary one as untrusted', async () => {
    const store = new Store(new Database(':memory:'));
    store.setAgentPeers('qa', ['sched'], ['sched']);
    expect(store.peerMayRequestActions('qa', 'sched')).toBe(true);
    expect(store.listAgentActionPeers('qa')).toEqual(['sched']);

    // The reverse direction was not authorized, so it stays untrusted.
    store.setAgentPeers('sched', ['qa']);
    expect(store.peerMayRequestActions('sched', 'qa')).toBe(false);
    expect(store.agentMayCall('sched', 'qa')).toBe(true); // …but it may still consult
  });

  it('drops the flag for a peer that is no longer granted', async () => {
    const store = new Store(new Database(':memory:'));
    store.setAgentPeers('qa', ['sched'], ['sched']);
    store.setAgentPeers('qa', []); // revoke
    expect(store.peerMayRequestActions('qa', 'sched')).toBe(false);
    store.setAgentPeers('qa', ['sched']); // re-grant, plain
    expect(store.peerMayRequestActions('qa', 'sched')).toBe(false);
  });
});
