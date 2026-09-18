import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import { MANIFEST } from '../src/mgmt/tools.js';
import type { SecretStore } from '../src/secrets/secretStore.js';

/**
 * The management chat on a subscription source: the Claude CLI gets the tools
 * over MCP. Here a scripted "CLI" plays that part by calling the same door the
 * MCP server uses, so everything under it is real: the one-turn token, the
 * broker, the confirm cards.
 */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const OWNER = 'user-owner';
const H = { 'x-hatchabot-owner': OWNER };

async function world(turn: (token: string, f: ReturnType<typeof Fastify>) => Promise<string>) {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'claude-sonnet-5', secretRef: undefined as any, createdAt: 'now' });
  const f = Fastify();
  const holder: { token?: string } = {};
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 } } as any,
    mgmtMcpTurn: async (token) => { holder.token = token; return turn(token, f); },
  });
  await f.inject({ method: 'POST', url: '/v1/mgmt/chat/mode', headers: H, payload: { readWrite: true } });
  return { f, store, holder };
}
const mcp = (f: any, token: string, body: unknown, remoteAddress?: string) =>
  f.inject({ method: 'POST', url: '/v1/mgmt/mcp', headers: { 'x-hatchabot-turn': token }, payload: body, ...(remoteAddress ? { remoteAddress } : {}) });

describe('POST /v1/mgmt/mcp — the tool server’s door', () => {
  it('lists the menu, runs reads, turns changes into cards, and closes when the turn ends', async () => {
    let seen: any = {};
    const { f, holder } = await world(async (token, app) => {
      seen.list = (await mcp(app, token, { op: 'list' })).json();
      seen.read = (await mcp(app, token, { op: 'call', name: 'list_agents', input: {} })).json();
      seen.change = (await mcp(app, token, { op: 'call', name: 'build_image', input: { name: 'pdf', dockerfile: 'RUN true' } })).json();
      seen.forbidden = (await mcp(app, token, { op: 'call', name: 'promote_image', input: {} })).json();
      seen.wrong = (await mcp(app, 'nope', { op: 'list' })).statusCode;
      seen.remote = (await mcp(app, token, { op: 'list' }, '10.0.0.5')).statusCode;
      return 'I proposed building the pdf image — confirm the card.';
    });
    const r = (await f.inject({ method: 'POST', url: '/v1/mgmt/chat', headers: H, payload: { message: 'make a pdf image' } })).json();
    expect(seen.list.tools.map((t: any) => t.name)).toEqual(MANIFEST.map((t) => t.name));
    expect(seen.list.tools[0].inputSchema).toBeTruthy();
    expect(JSON.parse(seen.read.text)).toEqual([]);
    expect(seen.change.text).toMatch(/NOT done yet/);
    expect(seen.forbidden.isError).toBe(true);
    expect(seen.forbidden.text).toMatch(/FORBIDDEN_TOOL/);
    expect(seen.wrong).toBe(401);
    expect(seen.remote).toBe(403);
    // The card reached the pane, and the prose too.
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].tool).toBe('build_image');
    expect(r.texts).toEqual(['I proposed building the pdf image — confirm the card.']);
    // The token is dead once the turn is over.
    expect((await mcp(f, holder.token!, { op: 'list' })).statusCode).toBe(401);
  });

  it('the next turn sees the previous one in its history', async () => {
    const histories: unknown[][] = [];
    const store = new Store(new Database(':memory:'));
    store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
    store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'Max', vendor: 'anthropic', kind: 'subscription', model: 'm', secretRef: undefined as any, createdAt: 'now' });
    const f = Fastify();
    await registerRoutes(f, {
      store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
      channel: { pool: { availableCount: () => 0 } } as any,
      mgmtMcpTurn: async (_t, req) => { histories.push(req.messages); return `answer ${histories.length}`; },
    });
    await f.inject({ method: 'POST', url: '/v1/mgmt/chat', headers: H, payload: { message: 'first' } });
    await f.inject({ method: 'POST', url: '/v1/mgmt/chat', headers: H, payload: { message: 'second' } });
    expect(histories[1]).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer 1' },
      { role: 'user', content: 'second' },
    ]);
  });
});

describe('src/mgmt/mcpServer.mjs speaks MCP over stdio', () => {
  it('initialize → tools/list → tools/call, forwarding with the turn token', async () => {
    const got: Array<{ token: string; body: any }> = [];
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => {
        const body = JSON.parse(b); got.push({ token: String(req.headers['x-hatchabot-turn']), body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body.op === 'list'
          ? { tools: [{ name: 'list_agents', description: 'd', inputSchema: { type: 'object' } }] }
          : { text: '[]' }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const child = spawn(process.execPath, ['src/mgmt/mcpServer.mjs'], {
      env: { ...process.env, HATCHABOT_MCP_URL: `http://127.0.0.1:${port}`, HATCHABOT_TURN_TOKEN: 'tok123' },
    });
    const lines: any[] = [];
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const ask = (msg: any) => child.stdin.write(JSON.stringify(msg) + '\n');
    const waitFor = async (id: number) => { for (let i = 0; i < 200; i++) { const m = lines.find((l) => l.id === id); if (m) return m; await new Promise((r) => setTimeout(r, 10)); } throw new Error('no reply ' + id); };
    ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect((await waitFor(1)).result.serverInfo.name).toBe('hatchabot');
    ask({ jsonrpc: '2.0', method: 'notifications/initialized' });
    ask({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((await waitFor(2)).result.tools[0].name).toBe('list_agents');
    ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_agents', arguments: {} } });
    expect((await waitFor(3)).result).toEqual({ content: [{ type: 'text', text: '[]' }], isError: false });
    expect(got.every((g) => g.token === 'tok123')).toBe(true);
    expect(got[1]!.body).toEqual({ op: 'call', name: 'list_agents', input: {} });
    child.kill(); srv.close();
  });
});
