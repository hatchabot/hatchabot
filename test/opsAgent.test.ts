import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import http from 'node:http';
import net from 'node:net';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { buildRuntimeSpec } from '../src/orchestrator/provision.js';
import { createOpsServer, getOpsHandlers, OpsAuthError } from '../src/ops/opsServer.js';
import { OPS_TOOLS_DENY, buildConfigCommands } from '../src/openclaw/configWriter.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/** The management agent: a propose-only key, a jail, locked-down tools. */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const OWNER = 'owner-a';
const H = { 'x-hatchabot-owner': OWNER };

async function world() {
  const store = new Store(new Database(':memory:'));
  const secrets = new MemSecrets();
  const provider = new MockProvider();
  for (const o of [OWNER, 'owner-b']) {
    store.insertHost({ id: `h-${o}`, ownerId: o, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: `p-${o}`, ownerId: o, name: 'GPT', vendor: 'openai', kind: 'api_key', model: 'gpt-5', secretRef: `ai/${o}`, createdAt: 'now' });
    await secrets.put(`ai/${o}`, 'sk-test');
  }
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', provider]]), channel: { pool: { availableCount: () => 0 } } as any, allowUnjailedOps: true });
  return { store, secrets, provider, f };
}
const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: '2.0', id, method, params });

describe('creating the management agent', () => {
  it('works on a non-Claude source, is web-only, one per account, with Hatchabot’s definition', async () => {
    const { store, f } = await world();
    const r = await f.inject({ method: 'POST', url: '/v1/ops-agent', headers: H, payload: {} });
    expect(r.statusCode).toBe(202);
    const a = store.getOpsAgent(OWNER)!;
    expect(a).toMatchObject({ ops: true, webOnly: true, name: 'Hatchabot', icon: '🐣', aiProfileId: `p-${OWNER}` });
    expect(store.getAgentSeed(a.id)['SOUL.md']).toMatch(/never change it|Waiting for you/);
    expect((await f.inject({ method: 'POST', url: '/v1/ops-agent', headers: H, payload: {} })).statusCode).toBe(409);
    expect((await f.inject({ method: 'GET', url: '/v1/ops-agent', headers: H })).json().agent.id).toBe(a.id);
    expect((await f.inject({ method: 'GET', url: '/v1/ops-agent', headers: { 'x-hatchabot-owner': 'owner-b' } })).json().agent).toBeNull();
  });
});

describe('its runtime spec', () => {
  it('is isolated, proxied, locked down, and gets a fresh key each build', async () => {
    const { store, secrets, provider, f } = await world();
    await f.inject({ method: 'POST', url: '/v1/ops-agent', headers: H, payload: {} });
    const a = store.getOpsAgent(OWNER)!;
    const deps = { store, secrets, provider, channel: {} as any };
    const one = await buildRuntimeSpec(deps, a.id);
    expect(one.isolated).toBe(true);
    expect(one.env.HTTPS_PROXY).toMatch(/^http:\/\/ops:[\w-]+@/);
    expect(one.env.NODE_USE_ENV_PROXY).toBe('1');
    const patch = one.workspace.configPatch as any;
    expect(patch.ops.mcpUrl).toMatch(/\/mcp$/);
    expect(patch.telegram).toBeUndefined();
    const cmds = buildConfigCommands(patch).map((c) => c.argv.join(' '));
    expect(cmds.some((c) => c.startsWith('config set tools.deny') && OPS_TOOLS_DENY.every((d) => c.includes(d)))).toBe(true);
    expect(cmds.some((c) => c.startsWith('mcp set hatchabot'))).toBe(true);
    expect(buildConfigCommands(patch).find((c) => c.argv[0] === 'mcp')?.sensitive).toBe(true);
    // The old key dies when a new one is minted.
    const two = await buildRuntimeSpec(deps, a.id);
    const k1 = (one.workspace.configPatch as any).ops.token, k2 = (two.workspace.configPatch as any).ops.token;
    expect(k1).not.toBe(k2);
    store.setAgentState(a.id, 'RUNNING');
    expect(store.opsAgentForToken(k1)).toBeUndefined();
    expect(store.opsAgentForToken(k2)?.id).toBe(a.id);
  });

  it('an ordinary agent is untouched', async () => {
    const { store, secrets, provider } = await world();
    store.insertAgent({ id: 'n1', ownerId: OWNER, name: 'N', slug: 'n', state: 'RUNNING', aiProfileId: `p-${OWNER}`, hostId: `h-${OWNER}`, persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as any);
    const spec = await buildRuntimeSpec({ store, secrets, provider, channel: {} as any }, 'n1');
    expect(spec.isolated).toBeUndefined();
    expect(spec.env.HTTPS_PROXY).toBeUndefined();
    expect((spec.workspace.configPatch as any).ops).toBeUndefined();
  });
});

describe('its door: reads run, changes only become proposals', () => {
  async function ready() {
    const w = await world();
    const { runtimeRef } = await w.provider.provision({ agentId: 't1', slug: 'taco', workspace: { files: {}, configPatch: { agentId: 'taco', authMode: 'api-key' } }, env: {} } as any);
    await w.provider.start(runtimeRef);
    w.store.insertAgent({ id: 't1', ownerId: OWNER, name: 'Taco Agent', slug: 'taco', state: 'RUNNING', runtimeRef, aiProfileId: `p-${OWNER}`, hostId: `h-${OWNER}`, persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as any);
    w.store.insertAgent({ id: 'x1', ownerId: 'owner-b', name: 'Secret Agent', slug: 'secret', state: 'RUNNING', aiProfileId: 'p-owner-b', hostId: 'h-owner-b', persona: '', sharedMemory: true, webOnly: true, createdAt: 'now', updatedAt: 'now' } as any);
    await w.f.inject({ method: 'POST', url: '/v1/ops-agent', headers: H, payload: {} });
    const a = w.store.getOpsAgent(OWNER)!;
    w.store.setAgentState(a.id, 'RUNNING');
    w.store.setOpsToken(a.id, OWNER, 'key-123');
    return { ...w, door: getOpsHandlers()! };
  }

  it('refuses an unknown key', async () => {
    const { door } = await ready();
    await expect(door.mcp('nope', rpc('tools/list'))).rejects.toBeInstanceOf(OpsAuthError);
    expect(door.allowedHosts('nope')).toBeUndefined();
  });

  it('speaks MCP: initialize, tools/list, notifications', async () => {
    const { door } = await ready();
    expect(((await door.mcp('key-123', rpc('initialize', { protocolVersion: '2025-06-18' }))) as any).result.serverInfo.name).toBe('hatchabot');
    const tools = ((await door.mcp('key-123', rpc('tools/list'))) as any).result.tools;
    expect(tools.some((t: any) => t.name === 'archive_agent' && t.inputSchema)).toBe(true);
    expect(tools.some((t: any) => /promote|delete_agent/.test(t.name))).toBe(false);
    expect(await door.mcp('key-123', { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
  });

  it('a read sees only its owner’s agents', async () => {
    const { door } = await ready();
    const out = (await door.mcp('key-123', rpc('tools/call', { name: 'list_agents', arguments: {} }))) as any;
    const names = JSON.parse(out.result.content[0].text).map((x: any) => x.name);
    expect(names).toContain('Taco Agent');
    expect(names).not.toContain('Secret Agent');
  });

  it('a change is filed for the owner and nothing happens until THEY confirm', async () => {
    const { door, store, f } = await ready();
    const out = (await door.mcp('key-123', rpc('tools/call', { name: 'stop_agent', arguments: { agent: 'Taco Agent' } }))) as any;
    expect(out.result.content[0].text).toMatch(/NOT done/);
    expect(store.getAgent('t1')!.state).toBe('RUNNING');
    const list = (await f.inject({ method: 'GET', url: '/v1/proposals', headers: H })).json();
    expect(list.pending).toHaveLength(1);
    // Another account can't approve it.
    expect((await f.inject({ method: 'POST', url: `/v1/proposals/${list.pending[0].confirmId}/confirm`, headers: { 'x-hatchabot-owner': 'owner-b' } })).statusCode).toBe(404);
    const done = await f.inject({ method: 'POST', url: `/v1/proposals/${list.pending[0].confirmId}/confirm`, headers: H });
    expect(done.statusCode).toBe(200);
    expect(store.getAgent('t1')!.state).toBe('STOPPED');
  });

  it('cannot reach another owner’s agent even by id', async () => {
    const { door } = await ready();
    const out = (await door.mcp('key-123', rpc('tools/call', { name: 'stop_agent', arguments: { agent: 'x1' } }))) as any;
    expect(out.result.isError).toBe(true);
  });

  it('a stopped management agent’s key is dead; its allowed hosts follow its AI source', async () => {
    const { door, store } = await ready();
    expect(door.allowedHosts('key-123')).toEqual(['api.openai.com']);
    store.setAgentState(store.getOpsAgent(OWNER)!.id, 'STOPPED');
    expect(door.allowedHosts('key-123')).toBeUndefined();
  });
});

describe('the ops server', () => {
  it('serves /mcp with a bearer key and proxies only allowlisted hosts on 443', async () => {
    const server = createOpsServer({
      mcp: async (token, msg: any) => { if (token !== 'k') throw new OpsAuthError('x'); return msg.id === undefined ? undefined : { jsonrpc: '2.0', id: msg.id, result: {} }; },
      allowedHosts: (token) => (token === 'k' ? ['api.openai.com'] : undefined),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as any).port;
    const post = (auth: string | undefined, body: unknown) => new Promise<{ status: number; body: string }>((resolve) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) } }, (res) => {
        let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, body: b }));
      });
      rq.end(JSON.stringify(body));
    });
    expect((await post('Bearer k', rpc('ping'))).status).toBe(200);
    expect((await post('Bearer k', { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    expect((await post('Bearer wrong', rpc('ping'))).status).toBe(401);
    expect((await post(undefined, rpc('ping'))).status).toBe(401);

    const connect = (target: string, auth?: string) => new Promise<string>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(`ops:${auth}`).toString('base64')}\r\n` : ''}\r\n`));
      s.once('data', (d) => { resolve(d.toString().split('\r\n')[0]!); s.destroy(); });
    });
    expect(await connect('api.openai.com:443')).toMatch(/407/);
    expect(await connect('evil.example.com:443', 'k')).toMatch(/403/);
    expect(await connect('api.openai.com:80', 'k')).toMatch(/403/);
    expect(await connect('172.17.0.1:8080', 'k')).toMatch(/403/);
    server.close();
  });
});
