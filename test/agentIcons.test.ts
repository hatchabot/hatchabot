import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { ICON_PALETTE, colorFor, keywordIcon, parseChoices, pickIcons, validIcon, validIconColor } from '../src/orchestrator/agentIcons.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import type { Agent, AIProfile } from '../src/domain/types.js';

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };

function agent(id: string, name: string, extra: Partial<Agent> = {}): Agent {
  return {
    id, ownerId: OWNER, name, slug: id, state: 'RUNNING', aiProfileId: 'p', hostId: 'mock',
    persona: '', sharedMemory: false, createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra,
  } as Agent;
}

async function world(reply?: string | Error) {
  const store = new Store(new Database(':memory:'));
  const f = Fastify();
  const calls: string[] = [];
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
    mgmtLlmComplete: async (_s, _p, req) => {
      calls.push(JSON.stringify(req.messages));
      if (reply instanceof Error) throw reply;
      return { stopReason: 'end_turn', content: [{ type: 'text', text: reply ?? '[]' }] };
    },
  });
  return { store, f, calls };
}

const PROFILE = {
  id: 'p', ownerId: OWNER, name: 'Key', vendor: 'anthropic', kind: 'api_key',
  model: 'claude-sonnet-5', secretRef: 'ai/p', createdAt: 'now',
} as AIProfile;

describe('icon validation', () => {
  it('accepts one emoji, including ZWJ sequences, flags and variation selectors', () => {
    for (const ok of ['📈', '⚖️', '👩‍💻', '🇨🇦', '👍🏽', '☂️']) expect(validIcon(ok), ok).toBe(true);
  });
  it('refuses text, markup, two emoji and empty', () => {
    for (const bad of ['', 'A', 'ab', '<b>', '📈📈', '1', '📈x', '"><img', ' 📈']) expect(validIcon(bad), bad).toBe(false);
  });
  it('colours must be #rrggbb', () => {
    expect(validIconColor('#3a8fd0')).toBe(true);
    for (const bad of ['red', '#fff', 'url(x)', '#3a8fd0;x']) expect(validIconColor(bad)).toBe(false);
  });
});

describe('picking icons', () => {
  it('keywords: name first, then the description, else a robot', () => {
    expect(keywordIcon('Stock Advisor')).toBe('📈');
    expect(keywordIcon('Helper', 'plans our trip to Sicily')).toBe('🧭');
    expect(keywordIcon('Zork')).toBe('🤖');
  });
  it('colour is stable and from the palette', () => {
    expect(colorFor('Tax Advisor')).toBe(colorFor('tax advisor'));
    expect(ICON_PALETTE).toContain(colorFor('Tax Advisor'));
  });
  it('keeps only valid AI answers; the rest fall back per agent', async () => {
    const out = await pickIcons(
      [{ id: 'a', name: 'Stock Advisor' }, { id: 'b', name: 'Taco Agent' }, { id: 'c', name: 'Zork' }],
      async () => 'Sure! [{"id":"a","icon":"💹","color":"#3a8fd0"},{"id":"b","icon":"<script>","color":"#3a8fd0"},{"id":"c","icon":"🐉","color":"#123456"}]',
    );
    expect(out[0]).toEqual({ id: 'a', icon: '💹', color: '#3a8fd0', via: 'ai' });
    expect(out[1]).toMatchObject({ id: 'b', icon: '🍳', via: 'keywords' });   // bad icon → keywords
    expect(out[2]).toMatchObject({ id: 'c', icon: '🐉', color: colorFor('Zork'), via: 'ai' }); // off-palette colour → stable pick
  });
  it('a failing AI never blocks: everything falls back', async () => {
    const out = await pickIcons([{ id: 'a', name: 'Legal Advisor' }], async () => { throw new Error('429'); });
    expect(out).toEqual([{ id: 'a', icon: '⚖️', color: colorFor('Legal Advisor'), via: 'keywords' }]);
  });
  it('parseChoices ignores junk', () => {
    expect(parseChoices('no json here').size).toBe(0);
    expect(parseChoices('[{"id":1,"icon":"📈"}]').size).toBe(0);
  });
});

describe('icon routes', () => {
  it('PATCH sets and clears an icon, and rejects a non-emoji', async () => {
    const { store, f } = await world();
    store.insertAgent(agent('a1', 'Stock Advisor'));
    let r = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { icon: '📈', iconColor: '#3aa36b' } });
    expect(r.statusCode).toBe(200);
    expect(store.getAgent('a1')).toMatchObject({ icon: '📈', iconColor: '#3aa36b' });
    r = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { icon: '<img src=x>' } });
    expect(r.statusCode).toBe(400);
    r = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { icon: null } });
    expect(r.statusCode).toBe(200);
    expect(store.getAgent('a1')?.icon).toBeUndefined();
    expect(store.getAgent('a1')?.iconColor).toBe('#3aa36b');
    await f.close();
  });

  it('auto fills only agents without an icon, via the management AI', async () => {
    const { store, f, calls } = await world('[{"id":"a2","icon":"🌮","color":"#e0a13a"}]');
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Stock Advisor', { icon: '💹' }));
    store.insertAgent(agent('a2', 'Taco Agent'));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/icons/auto', headers: H, payload: {} });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ assigned: 1, via: 'ai' });
    expect(store.getAgent('a1')?.icon).toBe('💹'); // chosen by the owner: untouched
    expect(store.getAgent('a2')).toMatchObject({ icon: '🌮', iconColor: '#e0a13a' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('Stock Advisor'); // only the ones being picked are sent
    await f.close();
  });

  it('auto without any AI source uses keywords; never touches another owner', async () => {
    const { store, f } = await world();
    store.insertAgent(agent('a1', 'Legal Advisor'));
    store.insertAgent({ ...agent('x1', 'Stock Advisor'), ownerId: 'someone-else' });
    const r = await f.inject({ method: 'POST', url: '/v1/agents/icons/auto', headers: H, payload: {} });
    expect(r.json()).toMatchObject({ assigned: 1, via: 'keywords' });
    expect(store.getAgent('a1')?.icon).toBe('⚖️');
    expect(store.getAgent('x1')?.icon).toBeUndefined();
    await f.close();
  });

  it('redo re-picks the named agents even when they have one', async () => {
    const { store, f } = await world('[{"id":"a1","icon":"💹","color":"#3a8fd0"}]');
    store.insertAIProfile(PROFILE);
    store.insertAgent(agent('a1', 'Stock Advisor', { icon: '📈' }));
    const r = await f.inject({ method: 'POST', url: '/v1/agents/icons/auto', headers: H, payload: { ids: ['a1'], redo: true } });
    expect(r.json().icons).toEqual([{ id: 'a1', icon: '💹', color: '#3a8fd0' }]);
    expect(store.getAgent('a1')?.icon).toBe('💹');
    await f.close();
  });
});
