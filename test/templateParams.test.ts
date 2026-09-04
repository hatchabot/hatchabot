import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * Sharing Phase 2a over HTTP: declaring setup fields on an agent, and filling
 * them on import — file path and inbox path. The core substitution rules are
 * pinned in template.test.ts; these pin the API boundary.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(ref: string, v: string) { this.map.set(ref, v); }
  async get(ref: string) { const v = this.map.get(ref); if (v === undefined) throw new Error('missing'); return v; }
  async delete(ref: string) { this.map.delete(ref); }
}

const OWNER = 'user-owner';
const H = { 'x-agentclaw-owner': OWNER };

const TEMPLATE = gzipSync(Buffer.from(JSON.stringify({
  format: 'agentclaw-template', version: 1, exportedAt: 'now',
  agent: { name: 'Stock Advisor', persona: 'p', sharedMemory: false },
  files: { 'SOUL.md': 'A {{style}} advisor.', 'AGENTS.md': '# A' },
  ai: { vendor: 'anthropic' }, dataNeeds: [], envNeeds: [],
  parameters: [
    { key: 'style', label: 'Investment style', required: true, type: 'choice', options: ['value', 'growth'], target: 'soul' },
  ],
})));

async function world() {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  store.insertAgent({ id: 'a1', ownerId: OWNER, name: 'Mine', slug: 'mine', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
  const f = Fastify();
  const provider = new MockProvider();
  const secrets = new MemSecrets();
  await registerRoutes(f, {
    store, secrets,
    providers: new Map([['mock', provider]]),
    channel: { pool: { availableCount: () => 0 }, release: async () => {} } as any,
  });
  return { store, f, provider, secrets };
}

describe('PATCH /v1/agents/:id parameters', () => {
  it('declares, exposes on the agent, and clears with null', async () => {
    const { store, f } = await world();
    const params = [{ key: 'style', label: 'Style', required: true, type: 'text', target: 'soul' }];
    const res = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { parameters: params } });
    expect(res.statusCode).toBe(200);
    expect(res.json().parameters).toMatchObject(params);
    expect(store.getAgent('a1')!.parameters).toMatchObject(params);

    const clear = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { parameters: null } });
    expect(clear.statusCode).toBe(200);
    expect(store.getAgent('a1')!.parameters).toBeUndefined();
  });

  it('rejects duplicate keys and malformed keys', async () => {
    const { f } = await world();
    const dup = [
      { key: 'x', label: 'X', required: false, type: 'text', target: 'soul' },
      { key: 'x', label: 'X2', required: false, type: 'text', target: 'soul' },
    ];
    expect((await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { parameters: dup } })).statusCode).toBe(400);
    const bad = [{ key: 'Bad Key', label: 'B', required: false, type: 'text', target: 'soul' }];
    expect((await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { parameters: bad } })).statusCode).toBe(400);
  });
});

describe('POST /v1/agents/import with values', () => {
  it('substitutes provided values into the seeded files', async () => {
    const { store, f } = await world();
    const res = await f.inject({
      method: 'POST',
      url: `/v1/agents/import?values=${encodeURIComponent(JSON.stringify({ style: 'value' }))}`,
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: TEMPLATE,
    });
    expect(res.statusCode).toBe(201);
    const seeded = store.getAgentSeed(res.json().id);
    expect(seeded['SOUL.md']).toBe('A value advisor.');
  });

  it('400s naming the missing required field, creating nothing', async () => {
    const { store, f } = await world();
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/import',
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: TEMPLATE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Investment style/);
    expect(store.listAgents(OWNER)).toHaveLength(1); // only the pre-existing agent
  });

  it('400s on malformed values JSON instead of 500', async () => {
    const { f } = await world();
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/import?values=%7Bnot-json',
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: TEMPLATE,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('env-target setup fields (sharing Phase 2b)', () => {
  const ENV_TEMPLATE = gzipSync(Buffer.from(JSON.stringify({
    format: 'agentclaw-template', version: 1, exportedAt: 'now',
    agent: { name: 'Broker', persona: 'p', sharedMemory: false },
    files: { 'SOUL.md': 'A {{style}} broker.', 'AGENTS.md': '# A' },
    ai: { vendor: 'anthropic' }, dataNeeds: [], envNeeds: [],
    parameters: [
      { key: 'style', label: 'Style', required: true, type: 'choice', options: ['value', 'growth'], target: 'soul' },
      { key: 'brave_api_key', label: 'Brave Search key', required: true, type: 'text', target: 'env' },
    ],
  })));

  it('the filled value becomes a real env var — secret stored, never in paramValues or files', async () => {
    const { store, f } = await world();
    const res = await f.inject({
      method: 'POST',
      url: `/v1/agents/import?values=${encodeURIComponent(JSON.stringify({ style: 'value', brave_api_key: 'brv-12345' }))}`,
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: ENV_TEMPLATE,
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const envs = store.listAgentEnv(id);
    expect(envs.map((e) => e.name)).toEqual(['BRAVE_API_KEY']);
    // never persisted as a readable setup value
    expect(store.getAgent(id)!.paramValues).toEqual({ style: 'value' });
    // never substituted into the seeded files
    expect(JSON.stringify(store.getAgentSeed(id))).not.toContain('brv-12345');
    // the response never echoes it either
    expect(res.body).not.toContain('brv-12345');
  });

  it('a required env field missing refuses BEFORE creating anything', async () => {
    const { store, f } = await world();
    const res = await f.inject({
      method: 'POST',
      url: `/v1/agents/import?values=${encodeURIComponent(JSON.stringify({ style: 'value' }))}`,
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: ENV_TEMPLATE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Brave Search key/);
    expect(store.listAgents(OWNER)).toHaveLength(1); // only the pre-seeded a1
  });

  it('a failing secret write rolls the fresh agent back whole (audit 2026-09-04 M4)', async () => {
    const { store, f, secrets } = await world();
    const realPut = secrets.put.bind(secrets);
    secrets.put = async (ref: string, v: string) => {
      if (ref.startsWith('agent-env/')) throw new Error('disk full');
      return realPut(ref, v);
    };
    const res = await f.inject({
      method: 'POST',
      url: `/v1/agents/import?values=${encodeURIComponent(JSON.stringify({ style: 'value', brave_api_key: 'brv-x' }))}`,
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: ENV_TEMPLATE,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/setup credentials/);
    // no half-made agent survives — slug free for the retry
    expect(store.listAgents(OWNER).filter((a) => a.name === 'Broker')).toHaveLength(0);
    expect(store.listAllActiveAgents().some((a) => a.slug === 'broker')).toBe(false);
  });

  it('inbox accept materializes env values through the same path', async () => {
    const { store, f } = await world();
    store.insertShare({
      id: 'sh-env', agentName: 'Broker', fromOwner: 'sender', fromEmail: 'sender@example.com',
      toEmail: 'me@example.com', toOwner: OWNER, blob: ENV_TEMPLATE,
      message: 'here', createdAt: new Date().toISOString(),
    } as any);
    const res = await f.inject({
      method: 'POST', url: '/v1/inbox/sh-env/accept', headers: H,
      payload: { values: { style: 'growth', brave_api_key: 'brv-inbox' } },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    expect(store.listAgentEnv(id).map((e) => e.name)).toEqual(['BRAVE_API_KEY']);
    expect(res.body).not.toContain('brv-inbox');
  });

  it('a reserved key cannot be declared as an env field', async () => {
    const { f, store } = await world();
    store.setAgentRuntimeRef('a1', 'docker://x');
    const res = await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: H,
      payload: { parameters: [{ key: 'anthropic_base_url', label: 'Endpoint', required: false, type: 'text', target: 'env' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/reserved/);
  });
});

describe('datasource-target setup fields (per-child repo bindings)', () => {
  const DS_TEMPLATE = gzipSync(Buffer.from(JSON.stringify({
    format: 'agentclaw-template', version: 1, exportedAt: 'now',
    agent: { name: 'Condo Advisor', persona: 'p', sharedMemory: false },
    files: { 'SOUL.md': 'A {{building}} advisor.', 'AGENTS.md': '# A' },
    ai: { vendor: 'anthropic' }, dataNeeds: [], envNeeds: [],
    parameters: [
      { key: 'building', label: 'Building', required: true, type: 'text', target: 'soul' },
      { key: 'docs_repo', label: 'Document repo', required: true, type: 'text', target: 'datasource' },
    ],
  })));
  const importWith = (f: any, values: Record<string, string>) => f.inject({
    method: 'POST',
    url: `/v1/agents/import?values=${encodeURIComponent(JSON.stringify(values))}`,
    headers: { ...H, 'content-type': 'application/octet-stream' },
    payload: DS_TEMPLATE,
  });

  it('the filled URL becomes a real git data source — deploy key stored, not in paramValues or files', async () => {
    const { store, f, secrets } = await world();
    const res = await importWith(f, { building: 'Maple Court', docs_repo: 'https://github.com/acme/maple-court-docs' });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const sources = store.listDataSources(id);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      kind: 'git', access: 'ro', mountName: 'maple-court-docs',
      repoUrl: 'git@github.com:acme/maple-court-docs.git',
    });
    expect(sources[0]!.pubKey).toMatch(/^ssh-ed25519 /);
    await expect(secrets.get(sources[0]!.secretRef!)).resolves.toMatch(/PRIVATE KEY/);
    // split off like env: the binding record is the truth, not a setup value
    expect(store.getAgent(id)!.paramValues).toEqual({ building: 'Maple Court' });
    expect(JSON.stringify(store.getAgentSeed(id))).not.toContain('maple-court');
  });

  it('an unparsable URL, a reserved repo name, and a missing required binding all refuse before creating anything', async () => {
    const { store, f } = await world();
    for (const [values, msg] of [
      [{ building: 'B', docs_repo: 'not a repo' }, /recognizable git repo/],
      [{ building: 'B', docs_repo: 'git@github.com:acme/skills.git' }, /reserved/],
      [{ building: 'B' }, /Document repo/],
    ] as const) {
      const res = await importWith(f, values as Record<string, string>);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(msg);
    }
    expect(store.listAgents(OWNER)).toHaveLength(1); // only the pre-seeded a1
  });

  it('two bindings resolving to the same clone directory are refused', async () => {
    const { f } = await world();
    const TWO = gzipSync(Buffer.from(JSON.stringify({
      format: 'agentclaw-template', version: 1, exportedAt: 'now',
      agent: { name: 'Two Repos', persona: 'p', sharedMemory: false },
      files: { 'SOUL.md': 's', 'AGENTS.md': '# A' },
      ai: { vendor: 'anthropic' }, dataNeeds: [], envNeeds: [],
      parameters: [
        { key: 'repo_a', label: 'Repo A', required: true, type: 'text', target: 'datasource' },
        { key: 'repo_b', label: 'Repo B', required: true, type: 'text', target: 'datasource' },
      ],
    })));
    const res = await f.inject({
      method: 'POST',
      url: `/v1/agents/import?values=${encodeURIComponent(JSON.stringify({
        repo_a: 'git@github.com:one/docs.git', repo_b: 'git@github.com:two/docs.git',
      }))}`,
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: TWO,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/both named "docs"/);
  });

  it('declaring a datasource field that is not plain text, or that has a default, is refused', async () => {
    const { f } = await world();
    for (const param of [
      { key: 'r', label: 'R', required: true, type: 'choice', options: ['a'], target: 'datasource' },
      { key: 'r', label: 'R', required: true, type: 'text', default: 'git@github.com:me/mine.git', target: 'datasource' },
    ]) {
      const res = await f.inject({ method: 'PATCH', url: '/v1/agents/a1', headers: H, payload: { parameters: [param] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/datasource-target/);
    }
  });
});

describe('inbox with parameters', () => {
  it('lists a share with its parameters, and accept substitutes values', async () => {
    const { store, f } = await world();
    // Identity mode isn't on in this harness; insert the share directly, bound
    // to the owner — the routes under test are list + accept.
    store.insertShare({
      id: 's1', fromOwner: 'user-other', fromEmail: 'o@example.com', toEmail: 'me@example.com',
      toOwner: OWNER, agentName: 'Stock Advisor', message: 'try it', blob: TEMPLATE,
      createdAt: new Date().toISOString(),
    });

    const list = await f.inject({ method: 'GET', url: '/v1/inbox', headers: H });
    expect(list.statusCode).toBe(200);
    expect(list.json().shares[0].parameters).toMatchObject([{ key: 'style' }]);

    const missing = await f.inject({ method: 'POST', url: '/v1/inbox/s1/accept', headers: H, payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/Investment style/);

    const ok = await f.inject({ method: 'POST', url: '/v1/inbox/s1/accept', headers: H, payload: { values: { style: 'growth' } } });
    expect(ok.statusCode).toBe(201);
    expect(store.getAgentSeed(ok.json().id)['SOUL.md']).toBe('A growth advisor.');
  });
});

describe('PUT /v1/agents/:id/params (edit values later)', () => {
  async function importedWorld() {
    const { store, f, provider } = await world();
    const res = await f.inject({
      method: 'POST',
      url: `/v1/agents/import?values=${encodeURIComponent(JSON.stringify({ style: 'value' }))}`,
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: TEMPLATE,
    });
    const id = res.json().id as string;
    // The import stored the full editable state.
    const a = store.getAgent(id)!;
    expect(a.parameters?.map((p) => p.key)).toEqual(['style']);
    expect(a.paramValues).toEqual({ style: 'value' });
    expect(a.paramFiles?.soul).toContain('{{style}}'); // raw layer, not rendered
    // Bring it up so the params route (RUNNING-gated, like file edits) works.
    // The background kickProvision fails on the stub channel (→ FAILED), so
    // wait for it and walk the legal FAILED → PROVISIONING → RUNNING path.
    await new Promise((r) => setTimeout(r, 30));
    const { runtimeRef } = await provider.provision({
      agentId: id, slug: 'sb',
      workspace: { files: {}, configPatch: { agentId: 'sb', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef(id, runtimeRef);
    if (store.getAgent(id)!.state === 'FAILED') store.setAgentState(id, 'PROVISIONING');
    store.setAgentState(id, 'RUNNING');
    return { store, f, id };
  }

  it('edits a value: files re-render, persona and stored values update', async () => {
    const { store, f, id } = await importedWorld();
    const res = await f.inject({ method: 'PUT', url: `/v1/agents/${id}/params`, headers: H, payload: { values: { style: 'growth' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().values).toEqual({ style: 'growth' });
    expect(store.getAgent(id)!.paramValues).toEqual({ style: 'growth' });
    // the raw layer is untouched — editable forever
    expect(store.getAgent(id)!.paramFiles?.soul).toContain('{{style}}');
  });

  it('reset re-applies defaults, and refuses when a required field has none', async () => {
    const { store, f, id } = await importedWorld();
    // "style" is required with NO default in TEMPLATE — a blanket reset must say so.
    const res = await f.inject({ method: 'PUT', url: `/v1/agents/${id}/params`, headers: H, payload: { reset: true } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Investment style/);
    expect(store.getAgent(id)!.paramValues).toEqual({ style: 'value' }); // unchanged
  });

  it('rejects an invalid choice and an agent without editable state', async () => {
    const { store, f, id } = await importedWorld();
    expect((await f.inject({ method: 'PUT', url: `/v1/agents/${id}/params`, headers: H, payload: { values: { style: 'yolo' } } })).statusCode).toBe(400);
    // a1 (created directly, no template import) has no editable values
    store.setAgentRuntimeRef('a1', 'docker://a1'); // ensure the 400 is about state, not 404
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/a1/params', headers: H, payload: { values: {} } })).statusCode).toBe(400);
  });

  async function runningMaster(store: Store, provider: MockProvider) {
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'mine',
      workspace: { files: {}, configPatch: { agentId: 'mine', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef('a1', runtimeRef);
  }

  it('a MASTER (fields declared here, no imported layer) seeds its layer from the live files', async () => {
    const { store, f, provider } = await world();
    await runningMaster(store, provider);
    await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: H,
      payload: { parameters: [{ key: 'style', label: 'Style', required: true, type: 'choice', options: ['value', 'growth'], target: 'soul' }] },
    });
    // The live SOUL.md still carries the author's literal placeholder — the
    // seed reads it via `cat` (mock cans every execShell as 'sh').
    provider.execResponses.set('sh', { code: 0, stdout: 'A {{style}} advisor.\n', stderr: '' });
    const res = await f.inject({ method: 'PUT', url: '/v1/agents/a1/params', headers: H, payload: { values: { style: 'growth' } } });
    expect(res.statusCode).toBe(200);
    const a = store.getAgent('a1')!;
    expect(a.paramValues).toEqual({ style: 'growth' });
    expect(a.paramFiles?.soul).toContain('{{style}}'); // seeded raw layer persisted
    // second edit works off the stored layer like any imported copy
    expect((await f.inject({ method: 'PUT', url: '/v1/agents/a1/params', headers: H, payload: { values: { style: 'value' } } })).statusCode).toBe(200);
    expect(store.getAgent('a1')!.paramValues).toEqual({ style: 'value' });
  });

  it('an empty body is refused — it would silently re-apply every default', async () => {
    const { f, id, store } = await importedWorld();
    const res = await f.inject({ method: 'PUT', url: `/v1/agents/${id}/params`, headers: H, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/reset: true/);
    expect(store.getAgent(id)!.paramValues).toEqual({ style: 'value' }); // untouched
  });

  it('a direct file edit updates the template layer, so the next Apply does not revert it', async () => {
    const { f, id, store } = await importedWorld();
    const rewritten = 'Rewritten by hand. Style stays {{style}}.';
    const put = await f.inject({
      method: 'PUT', url: `/v1/agents/${id}/files/SOUL.md`, headers: H, payload: { content: rewritten },
    });
    expect(put.statusCode).toBe(200);
    expect(store.getAgent(id)!.paramFiles?.soul).toBe(rewritten); // layer follows the edit
    // Applying a new value renders from the NEW layer, not the import-time one.
    await f.inject({ method: 'PUT', url: `/v1/agents/${id}/params`, headers: H, payload: { values: { style: 'growth' } } });
    expect(store.getAgent(id)!.paramFiles?.soul).toBe(rewritten);
    expect(store.getAgent(id)!.paramValues).toEqual({ style: 'growth' });
  });

  it('a master whose files have NO placeholders is refused with a pointer, not silently no-oped', async () => {
    const { store, f, provider } = await world();
    await runningMaster(store, provider);
    await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: H,
      payload: { parameters: [{ key: 'style', label: 'Style', required: false, type: 'text', target: 'soul' }] },
    });
    provider.execResponses.set('sh', { code: 0, stdout: 'Plain prose, nothing templated.\n', stderr: '' });
    const res = await f.inject({ method: 'PUT', url: '/v1/agents/a1/params', headers: H, payload: { values: { style: 'x' } } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/placeholder/i);
    expect(store.getAgent('a1')!.paramFiles).toBeUndefined(); // nothing persisted
  });
});

describe('master ⇄ child lineage (condo-fleet pattern)', () => {
  async function masterWorld() {
    const { store, f, provider, secrets } = await world();
    // make a1 a RUNNING master with fields + placeholder-bearing files
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'mine',
      workspace: { files: {}, configPatch: { agentId: 'mine', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef('a1', runtimeRef);
    await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: H,
      payload: { parameters: [{ key: 'style', label: 'Style', required: true, type: 'choice', options: ['value', 'growth'], target: 'soul' }] },
    });
    provider.execResponses.set('sh', { code: 0, stdout: 'A {{style}} advisor at work.\n', stderr: '' });
    return { store, f, provider, secrets };
  }

  it('derive creates a child with its own values, lineage recorded, no memory carried', async () => {
    const { store, f } = await masterWorld();
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/a1/derive', headers: H,
      payload: { name: 'Condo B', values: { style: 'growth' } },
    });
    expect(res.statusCode).toBe(201);
    const child = store.listAgents(OWNER).find((x) => x.name === 'Condo B')!;
    expect(child.parentAgentId).toBe('a1');
    expect(child.paramValues).toEqual({ style: 'growth' });
    expect(store.getAgentSeed(child.id)['SOUL.md']).toContain('growth advisor');
    expect(store.getAgentSeed(child.id)['MEMORY.md']).toBeUndefined(); // fresh memory
    expect(store.listChildren('a1').map((c) => c.id)).toEqual([child.id]);
  });

  it('push-definition re-renders each child from the master, keeping child values; memory untouched', async () => {
    const { store, f, provider } = await masterWorld();
    await f.inject({ method: 'POST', url: '/v1/agents/a1/derive', headers: H, payload: { name: 'Condo B', values: { style: 'growth' } } });
    const child = store.listAgents(OWNER).find((x) => x.name === 'Condo B')!;
    // bring the child up (background provision fails on the stub channel)
    await new Promise((r) => setTimeout(r, 30));
    const { runtimeRef } = await provider.provision({
      agentId: child.id, slug: 'condo-b',
      workspace: { files: {}, configPatch: { agentId: 'condo-b', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef(child.id, runtimeRef);
    if (store.getAgent(child.id)!.state === 'FAILED') store.setAgentState(child.id, 'PROVISIONING');
    store.setAgentState(child.id, 'RUNNING');

    // master's files evolved since the derive
    provider.execResponses.set('sh', { code: 0, stdout: 'IMPROVED {{style}} playbook v2.\n', stderr: '' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/push-definition', headers: H, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().pushed).toBe(1);
    const after = store.getAgent(child.id)!;
    expect(after.paramFiles?.soul).toContain('IMPROVED {{style}}'); // new layer stored raw
    expect(after.paramValues).toEqual({ style: 'growth' }); // child's answers kept
    expect(store.listSnapshots(child.id).some((s) => s.reason === 'pre-params')).toBe(true);
  });

  it('push refuses when there are no children; a non-running child is skipped by name', async () => {
    const { store, f } = await masterWorld();
    const none = await f.inject({ method: 'POST', url: '/v1/agents/a1/push-definition', headers: H, payload: {} });
    expect(none.statusCode).toBe(400);
    await f.inject({ method: 'POST', url: '/v1/agents/a1/derive', headers: H, payload: { name: 'Condo B', values: { style: 'value' } } });
    const child = store.listAgents(OWNER).find((x) => x.name === 'Condo B')!;
    await new Promise((r) => setTimeout(r, 30)); // child stays non-RUNNING (stub provision failed)
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/push-definition', headers: H, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().pushed).toBe(0);
    expect(res.json().results[0]).toMatchObject({ name: 'Condo B', ok: false });
    expect(store.getAgent(child.id)!.paramValues).toEqual({ style: 'value' }); // untouched
  });
});

describe('distillation: child→master proposals', () => {
  it('distill parks a proposal; merge appends to AGENTS.md with snapshot; push carries it to the child', async () => {
    const { store, f, provider } = await world();
    // master a1 RUNNING with a real mock runtime
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'mine',
      workspace: { files: {}, configPatch: { agentId: 'mine', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef('a1', runtimeRef);
    await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: H,
      payload: { parameters: [{ key: 'style', label: 'Style', required: false, type: 'text', default: 'calm', target: 'soul' }] },
    });
    provider.execResponses.set('sh', { code: 0, stdout: 'playbook {{style}} v1\n', stderr: '' });
    // derive a child and bring it RUNNING
    await f.inject({ method: 'POST', url: '/v1/agents/a1/derive', headers: H, payload: { name: 'Kid', values: { style: 'calm' } } });
    const child = store.listAgents(OWNER).find((x) => x.name === 'Kid')!;
    await new Promise((r) => setTimeout(r, 30));
    const kid = await provider.provision({
      agentId: child.id, slug: 'kid',
      workspace: { files: {}, configPatch: { agentId: 'kid', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef(child.id, kid.runtimeRef);
    if (store.getAgent(child.id)!.state === 'FAILED') store.setAgentState(child.id, 'PROVISIONING');
    store.setAgentState(child.id, 'RUNNING');

    // the child's model writes the distillation (canned agent turn)
    provider.execResponses.set('agent', { code: 0, stdout: '## Lesson\nAlways confirm quotes in writing before approving vendors.\n', stderr: '' });
    const d = await f.inject({ method: 'POST', url: `/v1/agents/${child.id}/distill`, headers: H, payload: { topic: 'vendors' } });
    expect(d.statusCode).toBe(201);
    expect(store.listProposals('a1')).toHaveLength(1);

    // merge (the mock cans every cat, so simulate the merged file for the
    // separate push step below — production reads the real file)
    const pid = store.listProposals('a1')[0]!.id;
    const res = await f.inject({
      method: 'POST', url: `/v1/agents/a1/proposals/${pid}/resolve`, headers: H,
      payload: { action: 'merge', push: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ merged: true });
    expect(store.listProposals('a1')).toHaveLength(0); // consumed
    expect(store.listSnapshots('a1').some((s) => s.reason === 'pre-edit')).toBe(true); // master snapshotted

    provider.execResponses.set('sh', { code: 0, stdout: 'playbook {{style}} v2\nAlways confirm quotes in writing.\n', stderr: '' });
    const push = await f.inject({ method: 'POST', url: '/v1/agents/a1/push-definition', headers: H, payload: {} });
    expect(push.json().pushed).toBe(1);
    expect(store.getAgent(child.id)!.paramFiles?.agents).toContain('confirm quotes in writing');
  });

  it('distill refuses an agent with no master; dismiss closes without touching files', async () => {
    const { store, f, provider } = await world();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'mine',
      workspace: { files: {}, configPatch: { agentId: 'mine', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef('a1', runtimeRef);
    expect((await f.inject({ method: 'POST', url: '/v1/agents/a1/distill', headers: H, payload: {} })).statusCode).toBe(400);
    store.insertProposal({ id: 'pr1', masterAgentId: 'a1', childAgentId: 'x', childName: 'Kid', text: 'lesson text here padded to pass' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/proposals/pr1/resolve', headers: H, payload: { action: 'dismiss' } });
    expect(res.json()).toEqual({ dismissed: true });
    expect(store.listProposals('a1')).toHaveLength(0);
    expect(store.listSnapshots('a1')).toHaveLength(0); // nothing written
  });
});

describe('template-carried schedules', () => {
  it('import parks schedule declarations for provision to apply at RUNNING', async () => {
    const { store, f } = await world();
    const T = gzipSync(Buffer.from(JSON.stringify({
      format: 'agentclaw-template', version: 1, exportedAt: 'now',
      agent: { name: 'Sched', persona: 'p', sharedMemory: false },
      files: { 'SOUL.md': 'x', 'AGENTS.md': 'y' },
      ai: { vendor: 'anthropic' }, dataNeeds: [], envNeeds: [], parameters: [],
      schedules: [{ name: 'Pre-market briefing', message: 'Post the briefing.', cron: '0 8 * * 1-5', tz: 'America/New_York' }],
    })));
    const res = await f.inject({
      method: 'POST', url: '/v1/agents/import',
      headers: { ...H, 'content-type': 'application/octet-stream' }, payload: T,
    });
    expect(res.statusCode).toBe(201);
    const parked = store.getPendingSchedules(res.json().id);
    expect(parked).toEqual([{ name: 'Pre-market briefing', message: 'Post the briefing.', cron: '0 8 * * 1-5', tz: 'America/New_York' }]);
  });
});

describe('10th audit regressions', () => {
  it('accept refuses a foreign unshared AI profile and a foreign host — no cross-owner billing', async () => {
    const { store, f } = await world();
    store.insertAIProfile({ id: 'p-foreign', ownerId: 'user-other', name: 'Their Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-opus-4-8', secretRef: 'ai/p-foreign', createdAt: 'now' });
    store.insertHost({ id: 'h-foreign', ownerId: 'user-other', kind: 'cloud', provider: 'mock', name: 'their-laptop', settings: {}, createdAt: 'now' });
    store.insertShare({
      id: 'sh-x', agentName: 'Advisor', fromOwner: 'sender', fromEmail: 's@example.com',
      toEmail: 'me@example.com', toOwner: OWNER, blob: TEMPLATE, message: 'hi', createdAt: new Date().toISOString(),
    } as any);
    for (const [payload, msg] of [
      [{ values: { style: 'value' }, aiProfileId: 'p-foreign' }, /Unknown AI profile/],
      [{ values: { style: 'value' }, hostId: 'h-foreign' }, /Unknown host/],
    ] as const) {
      const res = await f.inject({ method: 'POST', url: '/v1/inbox/sh-x/accept', headers: H, payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(msg);
    }
    expect(store.listAgents(OWNER)).toHaveLength(1); // nothing half-made
  });

  it('a failing deploy-key write rolls back the env secrets from the same import', async () => {
    const { store, f, secrets } = await world();
    const BOTH = gzipSync(Buffer.from(JSON.stringify({
      format: 'agentclaw-template', version: 1, exportedAt: 'now',
      agent: { name: 'Both', persona: 'p', sharedMemory: false },
      files: { 'SOUL.md': 's', 'AGENTS.md': '# A' },
      ai: { vendor: 'anthropic' }, dataNeeds: [], envNeeds: [],
      parameters: [
        { key: 'api_key', label: 'Key', required: true, type: 'text', target: 'env' },
        { key: 'docs_repo', label: 'Repo', required: true, type: 'text', target: 'datasource' },
      ],
    })));
    const realPut = secrets.put.bind(secrets);
    secrets.put = async (ref: string, v: string) => {
      if (ref.startsWith('data-source/')) throw new Error('disk full');
      return realPut(ref, v);
    };
    const res = await f.inject({
      method: 'POST',
      url: `/v1/agents/import?values=${encodeURIComponent(JSON.stringify({ api_key: 'sk-test-x', docs_repo: 'git@github.com:a/b.git' }))}`,
      headers: { ...H, 'content-type': 'application/octet-stream' },
      payload: BOTH,
    });
    expect(res.statusCode).toBe(400);
    // the env secret written BEFORE the failure must be gone too
    expect([...secrets.map.keys()].filter((k) => k.startsWith('agent-env/'))).toHaveLength(0);
    expect(store.listAgents(OWNER).filter((a) => a.name === 'Both')).toHaveLength(0);
  });

  it('clone succeeds on a master with a required no-default datasource field', async () => {
    const { store, f, provider } = await world();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'mine',
      workspace: { files: {}, configPatch: { agentId: 'mine', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef('a1', runtimeRef);
    await f.inject({
      method: 'PATCH', url: '/v1/agents/a1', headers: H,
      payload: { parameters: [
        { key: 'style', label: 'Style', required: true, type: 'text', target: 'soul' },
        { key: 'docs_repo', label: 'Docs repo', required: true, type: 'text', target: 'datasource' },
      ] },
    });
    store.setAgentParamState('a1', { style: 'calm' }, { soul: 'A {{style}} one.' });
    provider.execResponses.set('sh', { code: 0, stdout: 'A calm one.\n', stderr: '' });
    const res = await f.inject({ method: 'POST', url: '/v1/agents/a1/clone', headers: H, payload: {} });
    expect(res.statusCode).toBe(201);
    const clone = store.listAgents(OWNER).find((a) => a.name === 'Mine (copy)')!;
    expect(clone).toBeTruthy();
    expect(clone.paramValues).toEqual({ style: 'calm' }); // source's own answers carried
  });

  it('distill refuses once 3 proposals are already pending from the same child', async () => {
    const { store, f, provider } = await world();
    store.insertAgent({ id: 'kid1', ownerId: OWNER, name: 'Kid', slug: 'kid1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1', persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now' });
    const kid = await provider.provision({
      agentId: 'kid1', slug: 'kid1',
      workspace: { files: {}, configPatch: { agentId: 'kid1', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef('kid1', kid.runtimeRef);
    store.setAgentState('kid1', 'RUNNING');
    store.setAgentParent('kid1', 'a1');
    for (let i = 0; i < 3; i++) {
      store.insertProposal({ id: `pp${i}`, masterAgentId: 'a1', childAgentId: 'kid1', childName: 'Kid', text: 'x'.repeat(50) });
    }
    const res = await f.inject({ method: 'POST', url: '/v1/agents/kid1/distill', headers: H, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/3 proposals/);
    expect(store.listProposals('a1')).toHaveLength(3); // no 4th
  });

  it('a proposal merges exactly once — the second resolve 404s instead of double-appending', async () => {
    const { store, f, provider } = await world();
    const { runtimeRef } = await provider.provision({
      agentId: 'a1', slug: 'mine',
      workspace: { files: {}, configPatch: { agentId: 'mine', authMode: 'api-key' } }, env: {},
    } as any);
    store.setAgentRuntimeRef('a1', runtimeRef);
    provider.execResponses.set('sh', { code: 0, stdout: 'playbook v1\n', stderr: '' });
    store.insertProposal({ id: 'pm1', masterAgentId: 'a1', childAgentId: 'kidX', childName: 'Kid', text: 'A lesson worth keeping around.' });
    const first = await f.inject({ method: 'POST', url: '/v1/agents/a1/proposals/pm1/resolve', headers: H, payload: { action: 'merge' } });
    expect(first.statusCode).toBe(200);
    const second = await f.inject({ method: 'POST', url: '/v1/agents/a1/proposals/pm1/resolve', headers: H, payload: { action: 'merge' } });
    expect(second.statusCode).toBe(404);
  });

  it('deleting a master scrubs its pending proposals', async () => {
    const { store } = await world();
    store.insertProposal({ id: 'ps1', masterAgentId: 'a1', childAgentId: 'kidY', childName: 'Kid', text: 'text' });
    store.scrubAgentResidue('a1');
    expect(store.listProposals('a1')).toHaveLength(0);
  });
});
