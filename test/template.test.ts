import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { exportTemplate, importTemplate, parseTemplate } from '../src/orchestrator/template.js';
import { buildWorkspaceSeed } from '../src/openclaw/workspace.js';

/**
 * A template is a SHAREABLE copy: trained files, no identity. These tests pin
 * the two guarantees that make it safe to email — nothing identifying leaves in
 * the file, and importing stands up a FRESH agent (own owner, no members, seeded
 * with the trained SOUL/AGENTS, fresh memory).
 */

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  store.insertHost({ id: 'h1', ownerId: 'owner-a', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'pa', ownerId: 'owner-a', name: 'A-AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/pa', createdAt: 'now' });
  store.insertAIProfile({ id: 'pb', ownerId: 'owner-b', name: 'B-AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/pb', createdAt: 'now' });
  const { runtimeRef } = await provider.provision({
    agentId: 'a1', slug: 'advisor', workspace: { files: {}, configPatch: { agentId: 'advisor', authMode: 'api-key' } }, env: {},
  } as any);
  store.insertAgent({ id: 'a1', ownerId: 'owner-a', name: 'Advisor', slug: 'advisor', state: 'RUNNING', aiProfileId: 'pa', hostId: 'h1', runtimeRef, persona: 'a wise advisor', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
  // A member (the exporter's family) and a data source + env var it uses.
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'owner-a', role: 'owner', status: 'active' });
  store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'family-1', role: 'user', status: 'active', channelUserId: '555111' });
  store.insertDataSource({ id: 'ds1', agentId: 'a1', kind: 'git', access: 'ro', mountName: 'defs', repoUrl: 'git@github.com:o/defs.git', secretRef: 'data-source/ds1', pubKey: 'k', createdAt: 'now' });
  store.insertAgentEnv({ id: 'e1', agentId: 'a1', name: 'MARKETDATA_API_KEY', secretRef: 'agent-env/e1', createdAt: 'now' });
  provider.execResponses.set('sh', { code: 0, stdout: '# TRAINED CONTENT', stderr: '' });
  return { store, provider };
}

describe('exportTemplate', () => {
  it('captures the trained files + needs, and leaks NO identity', async () => {
    const { store, provider } = await world();
    const { filename, data } = await exportTemplate({ store, provider }, 'a1');
    const m = parseTemplate(data);
    expect(filename).toMatch(/\.template\.agentclaw$/);
    expect(m.format).toBe('agentclaw-template');
    expect(m.files['SOUL.md']).toContain('TRAINED');
    expect(m.files['AGENTS.md']).toContain('TRAINED');
    expect(m.ai.vendor).toBe('anthropic');
    expect(m.dataNeeds).toEqual([{ kind: 'git', access: 'ro', mountName: 'defs', repoUrl: 'git@github.com:o/defs.git' }]);
    expect(m.envNeeds).toEqual(['MARKETDATA_API_KEY']);
    // Memory travels by default (a faithful copy)…
    expect(m.files['MEMORY.md']).toContain('TRAINED');
    // …but no bot token, members, Telegram IDs, or conversation history do.
    const raw = JSON.stringify(m);
    for (const leak of ['botToken', 'channel', 'memberships', 'family-1', '555111']) {
      expect(raw).not.toContain(leak);
    }
  });

  it('excludeMemory leaves MEMORY.md out', async () => {
    const { store, provider } = await world();
    const { data } = await exportTemplate({ store, provider }, 'a1', { includeMemory: false });
    const m = parseTemplate(data);
    expect(m.files['SOUL.md']).toBeDefined();
    expect(m.files['MEMORY.md']).toBeUndefined();
  });

  it('refuses to export a stopped agent', async () => {
    const { store, provider } = await world();
    store.setAgentState('a1', 'STOPPED');
    await expect(exportTemplate({ store, provider }, 'a1')).rejects.toThrow(/Start the agent/);
  });
});

describe('importTemplate', () => {
  it('stands up a FRESH agent: new owner, no members, seeded trained files, needs listed', async () => {
    const { store, provider } = await world();
    const { data } = await exportTemplate({ store, provider }, 'a1');

    const { agent, needs } = importTemplate({ store, provider }, data, { ownerId: 'owner-b' });
    expect(agent.id).not.toBe('a1');
    expect(agent.ownerId).toBe('owner-b');
    expect(agent.state).toBe('PROVISIONING');
    expect(agent.aiProfileId).toBe('pb'); // the importer's OWN profile
    // No members carried — only the importer's owner seat.
    expect(store.listMemberships(agent.id).filter((mm) => mm.role !== 'owner')).toHaveLength(0);
    // Needs surfaced for the importer to wire up.
    expect(needs.envVars).toEqual(['MARKETDATA_API_KEY']);
    expect(needs.dataSources).toHaveLength(1);

    // The trained files (incl. memory, by default) are staged to seed at first
    // provision — a faithful copy of the parent.
    const seed = store.getAgentSeed(agent.id);
    expect(seed['SOUL.md']).toContain('TRAINED');
    expect(seed['MEMORY.md']).toContain('TRAINED');
    const files = buildWorkspaceSeed({ agentName: agent.name, slug: agent.slug, persona: '', sharedMemory: false, seedFiles: seed });
    expect(files['SOUL.md']).toContain('TRAINED');
    expect(files['MEMORY.md']).toContain('TRAINED');
  });

  it('an excluded-memory template seeds a FRESH MEMORY.md', () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p', createdAt: 'now' });
    // Hand-craft a memory-less template.
    const { gzipSync } = require('node:zlib');
    const manifest = { format: 'agentclaw-template', version: 1, exportedAt: 'now',
      agent: { name: 'Bare', persona: 'p', sharedMemory: false },
      files: { 'SOUL.md': '# SOUL', 'AGENTS.md': '# AGENTS' }, ai: { vendor: 'anthropic' }, dataNeeds: [], envNeeds: [] };
    const { agent } = importTemplate({ store, provider: new MockProvider() }, gzipSync(Buffer.from(JSON.stringify(manifest))), { ownerId: 'o' });
    const files = buildWorkspaceSeed({ agentName: agent.name, slug: agent.slug, persona: '', sharedMemory: false, seedFiles: store.getAgentSeed(agent.id) });
    expect(files['MEMORY.md']).toMatch(/Memory/); // generated default, not carried
  });

  it('rejects a non-template / corrupt file', () => {
    const { store, provider } = { store: new Store(new Database(':memory:')), provider: new MockProvider() };
    expect(() => importTemplate({ store, provider }, Buffer.from('not a template'), { ownerId: 'o' })).toThrow();
  });
});

describe('template parameters (sharing Phase 2a)', () => {
  const { gzipSync } = require('node:zlib');
  const mk = (extra: Record<string, unknown> = {}) => gzipSync(Buffer.from(JSON.stringify({
    format: 'agentclaw-template', version: 1, exportedAt: 'now',
    agent: { name: 'Stock Advisor', persona: 'advises with {{style}} discipline', sharedMemory: false },
    files: {
      'SOUL.md': 'You advise with a {{style}} philosophy and {{risk}} risk appetite.',
      'AGENTS.md': 'Report to {{ style }} standards.', // spaced placeholder form
    },
    ai: { vendor: 'anthropic' }, dataNeeds: [], envNeeds: [],
    parameters: [
      { key: 'style', label: 'Investment style', required: true, type: 'choice',
        options: ['value', 'growth', 'index'], target: 'soul' },
      { key: 'risk', label: 'Risk tolerance', required: false, type: 'text',
        default: 'moderate', target: 'soul' },
    ],
    ...extra,
  })));
  const freshStore = () => {
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p', createdAt: 'now' });
    return store;
  };

  it('substitutes values into SOUL/AGENTS and persona; defaults fill the rest', () => {
    const store = freshStore();
    const { agent } = importTemplate({ store, provider: new MockProvider() }, mk(), {
      ownerId: 'o', values: { style: 'value' },
    });
    const seed = store.getAgentSeed(agent.id);
    expect(seed['SOUL.md']).toBe('You advise with a value philosophy and moderate risk appetite.');
    expect(seed['AGENTS.md']).toBe('Report to value standards.'); // {{ spaced }} form works
    expect(agent.persona).toBe('advises with value discipline');
  });

  it('refuses a missing required value BEFORE creating anything, naming the field', () => {
    const store = freshStore();
    expect(() => importTemplate({ store, provider: new MockProvider() }, mk(), { ownerId: 'o' }))
      .toThrow(/Investment style/);
    // nothing half-made
    expect(store.listAgents('o')).toHaveLength(0);
  });

  it('refuses a choice value outside the options', () => {
    const store = freshStore();
    expect(() => importTemplate({ store, provider: new MockProvider() }, mk(), {
      ownerId: 'o', values: { style: 'yolo' },
    })).toThrow(/must be one of/);
  });

  it('multichoice accepts a comma-separated subset, normalizes it, and refuses strays', () => {
    const multi = mk({
      parameters: [
        { key: 'style', label: 'Trading styles', required: true, type: 'multichoice',
          options: ['buy-and-hold', 'swing', 'momentum'], target: 'soul' },
        { key: 'risk', label: 'Risk tolerance', required: false, type: 'text', default: 'moderate', target: 'soul' },
      ],
    });
    const store = freshStore();
    const { agent } = importTemplate({ store, provider: new MockProvider() }, multi, {
      ownerId: 'o', values: { style: 'buy-and-hold,  swing' }, // sloppy spacing in, prose out
    });
    expect(store.getAgentSeed(agent.id)['SOUL.md'])
      .toBe('You advise with a buy-and-hold, swing philosophy and moderate risk appetite.');
    expect(() => importTemplate({ store: freshStore(), provider: new MockProvider() }, multi, {
      ownerId: 'o', values: { style: 'swing, yolo' },
    })).toThrow(/allows only/);
  });

  it('a template with no parameters imports exactly as before', () => {
    const store = freshStore();
    const { agent } = importTemplate({ store, provider: new MockProvider() }, mk({ parameters: [] }), {
      ownerId: 'o', values: undefined,
    });
    // placeholders left verbatim — no declared fields means no substitution
    expect(store.getAgentSeed(agent.id)['SOUL.md']).toContain('{{style}}');
  });

  it('export carries declared params AND auto-derives undeclared {{placeholders}}', async () => {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p', createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'adv', workspace: { files: {}, configPatch: { agentId: 'adv', authMode: 'api-key' } }, env: {} } as any);
    store.insertAgent({ id: 'a1', ownerId: 'o', name: 'Adv', slug: 'adv', state: 'RUNNING', aiProfileId: 'p', hostId: 'h1', runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    store.setAgentParameters('a1', [
      { key: 'style', label: 'Investment style', required: true, type: 'choice', options: ['value', 'growth'], target: 'soul' },
    ]);
    // The trained files hand-write an UNDECLARED placeholder too.
    provider.execResponses.set('sh', { code: 0, stdout: 'Serve {{style}} clients from {{home_city}}.', stderr: '' });

    const { data } = await exportTemplate({ store, provider }, 'a1');
    const m = parseTemplate(data);
    expect(m.parameters.map((p) => p.key)).toEqual(['style', 'home_city']);
    // declared field survives verbatim; derived one is a required text field
    expect(m.parameters[0]).toMatchObject({ label: 'Investment style', type: 'choice' });
    expect(m.parameters[1]).toMatchObject({ label: 'home city', required: true, type: 'text' });
  });
});
