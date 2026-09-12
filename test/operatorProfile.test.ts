import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { operatorSection, OPERATOR_HEADING } from '../src/openclaw/workspace.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

const OWNER = 'user-o';
const H = { 'x-hatchabot-owner': OWNER };

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}

describe('operatorSection (managed AGENTS.md block)', () => {
  it('renders the content and strips markdown headings (so they cannot end the section)', () => {
    const s = operatorSection('I am Chris.\n## Secret plans\nMove to Mexico');
    expect(s.startsWith(OPERATOR_HEADING)).toBe(true);
    expect(s).toContain('I am Chris.');
    expect(s).toContain('Secret plans'); // heading text kept
    expect(s).not.toContain('## Secret plans'); // but the heading marker stripped
  });
  it('neutralises fence delimiters so an unbalanced \`\`\` cannot swallow later managed sections', () => {
    const s = operatorSection('code:\n```\nnot closed');
    expect(s).not.toMatch(/^\s*```/m); // no line starts a fence any more
    expect(s).toContain('not closed');
  });
  it('shows a "not set" placeholder when empty', () => {
    expect(operatorSection('   ')).toContain('Not set');
  });
});

describe('operator-profile endpoint', () => {
  async function world() {
    const store = new Store(new Database(':memory:'));
    const provider = new MockProvider();
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } as any }, env: {} });
    await provider.start(runtimeRef);
    store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Kitchen', slug: 'kitchen', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', runtimeRef, persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' } as any);
    const f = Fastify();
    await registerRoutes(f, { store, secrets: new MemSecrets(), providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any });
    return { store, f };
  }

  it('stores the content and reports pushing it to running agents', async () => {
    const { store, f } = await world();
    const put = await f.inject({ method: 'PUT', url: '/v1/operator-profile', headers: H, payload: { content: 'I am Chris, Toronto, 3 kids.' } });
    expect(put.statusCode).toBe(202); // fan-out runs in the background now
    expect(put.json()).toMatchObject({ pushing: 1 });
    expect(store.getOperatorProfile(OWNER)).toBe('I am Chris, Toronto, 3 kids.');
    const get = await f.inject({ method: 'GET', url: '/v1/operator-profile', headers: H });
    expect(get.json().content).toBe('I am Chris, Toronto, 3 kids.');
  });

  it('is private per owner', async () => {
    const { store, f } = await world();
    await f.inject({ method: 'PUT', url: '/v1/operator-profile', headers: H, payload: { content: 'mine' } });
    const other = await f.inject({ method: 'GET', url: '/v1/operator-profile', headers: { 'x-hatchabot-owner': 'user-other' } });
    expect(other.json().content).toBe(''); // not shared
    expect(store.getOperatorProfile('user-other')).toBe('');
  });
});
