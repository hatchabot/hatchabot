import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Phase C: the web management chat. The scripted "model" emits tool_use blocks;
 * everything under it is REAL — the broker, the in-process ApiClient riding
 * app.inject with the caller's auth, and the actual /v1 routes it lands on.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const H = { 'x-agentclaw-owner': OWNER };

type Scripted = { stopReason: string; content: unknown[] };

async function world(script: Scripted[]) {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Spare Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({
    id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'PROVISIONING',
    aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now',
  });
  store.insertMembership({ id: 'm-owner', agentId: 'a1', userId: OWNER, role: 'owner', status: 'active' });
  store.insertChannel({
    id: 'c1', agentId: 'a1', kind: 'telegram', accountId: 'kitchenbot',
    secretRef: 'chan/a1', deepLink: 'https://t.me/kitchenbot', createdAt: 'now',
  });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'kitchen',
    workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {},
  } as any);
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.setAgentState('a1', 'RUNNING');

  const modelCalls: Array<{ messages: unknown[] }> = [];
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0, owns: () => false }, release: async () => {} } as any,
    mgmtLlmComplete: async (_s, _p, req) => {
      modelCalls.push({ messages: [...req.messages] });
      const next = script.shift();
      if (!next) throw new Error('model script exhausted');
      return next as any;
    },
  });
  return { store, f, provider, modelCalls };
}

const chat = (f: any, message: string) =>
  f.inject({ method: 'POST', url: '/v1/mgmt/chat', headers: H, payload: { message } });

describe('POST /v1/mgmt/chat', () => {
  it('a read tool runs against the REAL routes with the caller\'s auth, and the result reaches the model', async () => {
    const { f, modelCalls } = await world([
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'list_agents', input: {} }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'You have one agent: Kitchen, RUNNING.' }] },
    ]);
    const res = await chat(f, 'what agents do I have?');
    expect(res.statusCode).toBe(200);
    expect(res.json().texts).toEqual(['You have one agent: Kitchen, RUNNING.']);
    expect(res.json().proposals).toEqual([]);
    // The tool_result the model saw came from GET /v1/agents through inject.
    const toolResult = JSON.stringify(modelCalls[1]!.messages);
    expect(toolResult).toContain('Kitchen');
    expect(toolResult).toContain('RUNNING');
  });

  it('the pane is owner-scoped: a stranger\'s session sees an empty fleet', async () => {
    const { f } = await world([
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'list_agents', input: {} }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    ]);
    const res = await f.inject({
      method: 'POST', url: '/v1/mgmt/chat',
      headers: { 'x-agentclaw-owner': 'stranger' }, payload: { message: 'list' },
    });
    // No profile for the stranger → the model can't even run.
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/AI sources/);
  });

  it('mutations are refused read-only; armed, they become a card; Confirm executes for real', async () => {
    const { store, f } = await world([
      // read-only attempt
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'stop_agent', input: { agent: 'a1' } }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'Arm changes first.' }] },
      // armed attempt
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'stop_agent', input: { agent: 'a1' } }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'Card posted — confirm to stop it.' }] },
    ]);
    const ro = await chat(f, 'stop kitchen');
    expect(ro.json().proposals).toEqual([]); // READ_ONLY_MODE — no card

    await f.inject({ method: 'POST', url: '/v1/mgmt/chat/mode', headers: H, payload: { readWrite: true } });
    const rw = await chat(f, 'stop kitchen');
    const [p] = rw.json().proposals;
    expect(p.summary).toContain('Stop "Kitchen"');
    expect(store.getAgent('a1')!.state).toBe('RUNNING'); // proposed, not done

    const confirmed = await f.inject({
      method: 'POST', url: '/v1/mgmt/chat/confirm', headers: H,
      payload: { confirmId: p.confirmId, verb: 'confirm' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().text).toContain('✅');
    expect(store.getAgent('a1')!.state).toBe('STOPPED'); // the REAL route ran

    const replay = await f.inject({
      method: 'POST', url: '/v1/mgmt/chat/confirm', headers: H,
      payload: { confirmId: p.confirmId, verb: 'confirm' },
    });
    expect(replay.statusCode).toBe(409); // single-use survives the web transport
  });

  it('authoring proposals carry the FULL spec for the web card', async () => {
    const longSoul = Array.from({ length: 40 }, (_, i) => `soul line ${i + 1}`).join('\n');
    const { f } = await world([
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'create_agent', input: { name: 'Fresh', soul: longSoul } }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'Review the card.' }] },
    ]);
    await f.inject({ method: 'POST', url: '/v1/mgmt/chat/mode', headers: H, payload: { readWrite: true } });
    const res = await chat(f, 'draft an agent');
    const [p] = res.json().proposals;
    expect(p.tool).toBe('create_agent');
    expect(p.spec.soul).toBe(longSoul); // every byte, not a preview
  });

  it('one turn at a time: a concurrent POST is 409, never a silently lost turn (audit 2026-09-04)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const store = new Store(new Database(':memory:'));
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'K', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' });
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0, owns: () => false }, release: async () => {} } as any,
      mgmtLlmComplete: async () => {
        await gate; // stall the first turn until we've probed the second
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'slow reply' }] } as any;
      },
    });
    const first = chat(f, 'first message'); // in flight, not awaited
    await new Promise((r) => setTimeout(r, 20)); // let it reach the model stall
    const second = await chat(f, 'second message');
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatch(/already being answered/);
    release();
    const done = await first;
    expect(done.statusCode).toBe(200);
    expect(done.json().texts).toEqual(['slow reply']);
    // and the session is usable again — busy cleared
    const after = await f.inject({ method: 'GET', url: '/v1/mgmt/chat', headers: H });
    expect(after.json().transcript.length).toBe(2);
    await f.close();
  });

  it('proposal cards survive a pane reload — pending ones stay confirmable (audit backlog #2)', async () => {
    const { store, f } = await world([
      { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'stop_agent', input: { agent: 'a1' } }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'Card posted.' }] },
    ]);
    await f.inject({ method: 'POST', url: '/v1/mgmt/chat/mode', headers: H, payload: { readWrite: true } });
    const [p] = (await chat(f, 'stop kitchen')).json().proposals;

    // Simulate a reload: GET must return the proposal entry, marked pending.
    const state = (await f.inject({ method: 'GET', url: '/v1/mgmt/chat', headers: H })).json();
    const entry = state.transcript.find((t: any) => t.kind === 'proposal');
    expect(entry).toBeTruthy();
    expect(entry.pending).toBe(true);
    expect(entry.proposal.confirmId).toBe(p.confirmId);

    // Confirm from the "reloaded" pane — the card is still live.
    const confirmed = await f.inject({
      method: 'POST', url: '/v1/mgmt/chat/confirm', headers: H,
      payload: { confirmId: entry.proposal.confirmId, verb: 'confirm' },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(store.getAgent('a1')!.state).toBe('STOPPED');

    // After resolution the reload shows it as no longer pending.
    const after = (await f.inject({ method: 'GET', url: '/v1/mgmt/chat', headers: H })).json();
    expect(after.transcript.find((t: any) => t.kind === 'proposal').pending).toBe(false);
  });

  it('history persists across calls — the second message sees the first exchange', async () => {
    const { f, modelCalls } = await world([
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'Hello Chris.' }] },
      { stopReason: 'end_turn', content: [{ type: 'text', text: 'As I said: hello.' }] },
    ]);
    await chat(f, 'hi there');
    await chat(f, 'what did you just say?');
    const second = modelCalls[1]!.messages as any[];
    expect(second.length).toBeGreaterThanOrEqual(3); // turn 1 (user+assistant) + turn 2 user
    expect(JSON.stringify(second)).toContain('hi there');
    expect(JSON.stringify(second)).toContain('Hello Chris.');

    // GET returns the display transcript for pane reloads
    const state = (await f.inject({ method: 'GET', url: '/v1/mgmt/chat', headers: H })).json();
    expect(state.transcript.map((t: any) => t.kind)).toEqual(['user', 'assistant', 'user', 'assistant']);

    // and New chat clears it
    await f.inject({ method: 'DELETE', url: '/v1/mgmt/chat', headers: H });
    const cleared = (await f.inject({ method: 'GET', url: '/v1/mgmt/chat', headers: H })).json();
    expect(cleared.transcript).toEqual([]);
  });
});
