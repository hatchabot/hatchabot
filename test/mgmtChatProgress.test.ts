import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { toolStep } from '../src/api/mgmtChat.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/** The chat pane's live status line: a slow turn must read as work, not a hang. */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };

describe('GET /v1/mgmt/chat/progress', () => {
  it('says what the assistant is doing while a turn runs, and nothing once it is done', async () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'claude-sonnet-5', secretRef: 'ai/p1', createdAt: 'now' });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 } } as any,
      mgmtLlmComplete: async () => {
        calls++;
        if (calls === 1) return { stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'list_agents', input: {} }] } as any;
        await gate; // the second model call is "slow"
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'You have no agents.' }] } as any;
      },
    });
    expect((await f.inject({ method: 'GET', url: '/v1/mgmt/chat/progress', headers: H })).json()).toEqual({ busy: false });
    const turn = f.inject({ method: 'POST', url: '/v1/mgmt/chat', headers: H, payload: { message: 'what do I have?' } });
    // Let the first model call and the tool run, so the turn sits in the slow second call.
    for (let i = 0; i < 50 && calls < 2; i++) await new Promise((r) => setTimeout(r, 5));
    const mid = (await f.inject({ method: 'GET', url: '/v1/mgmt/chat/progress', headers: H })).json();
    expect(mid.busy).toBe(true);
    expect(mid.step).toBe('Thinking about what it found');
    expect(typeof mid.elapsedMs).toBe('number');
    release();
    const done = (await turn).json();
    expect(done.texts).toEqual(['You have no agents.']);
    expect((await f.inject({ method: 'GET', url: '/v1/mgmt/chat/progress', headers: H })).json()).toEqual({ busy: false });
  });

  it('names tools in plain words, and anything else as preparing a card', () => {
    expect(toolStep('get_runtime')).toBe('Checking the runtime version');
    expect(toolStep('build_base_candidate')).toBe('Preparing a card: build base candidate');
  });
});
