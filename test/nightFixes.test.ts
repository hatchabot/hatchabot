import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { botPollState } from '../src/orchestrator/adopt.js';

// Night review, 2026-09-27: regressions for the fixes made that night.

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('Telegram probes never confirm the queue', () => {
  it('the poll probe sends no offset (a negative one forgets every earlier update)', async () => {
    const urls: string[] = [];
    const f = (async (u: any) => { urls.push(String(u)); return new Response('{"ok":true,"result":[]}'); }) as unknown as typeof fetch;
    expect(await botPollState('123:fake', f)).toBe('quiet');
    expect(urls[0]).not.toMatch(/offset=/);
  });
  it('no source file asks getUpdates with a negative offset', () => {
    for (const file of sources('src')) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/getUpdates\?[^'"`]*offset=-/);
    }
  });
});

describe('switching to family accounts keeps the owner\'s links (night review)', () => {
  it('Slack/Discord identities, parked bots, pending cards and the Telegram link move to the new account', async () => {
    const Database = (await import('better-sqlite3')).default;
    const { Store } = await import('../src/store/store.js');
    const store = new Store(new Database(':memory:'));
    const db = (store as any).db;
    db.prepare(`INSERT INTO member_identities (agent_id, user_id, kind, channel_user_id, bound_at) VALUES ('a1','dev-owner','discord','123456789012345678','now')`).run();
    db.prepare(`INSERT INTO discord_bots (application_id, secret_ref, owner_id, added_at) VALUES ('app1','ref1','dev-owner','now')`).run();
    db.prepare(`INSERT INTO mgmt_proposals (id, owner_id, record, status, created_at_ms, expires_at_ms) VALUES ('p1','dev-owner','{}','pending',1,2)`).run();
    db.prepare(`INSERT INTO accounts (owner_id, email, last_seen, telegram_user_id) VALUES ('dev-owner', NULL, 'now', '555')`).run();
    store.adoptLocalOwnerData('acct-new');
    expect(db.prepare(`SELECT user_id FROM member_identities`).get().user_id).toBe('acct-new');
    expect(db.prepare(`SELECT owner_id FROM discord_bots`).get().owner_id).toBe('acct-new');
    expect(db.prepare(`SELECT owner_id FROM mgmt_proposals`).get().owner_id).toBe('acct-new');
    expect(store.telegramBoundOutside('555', 'acct-new')).toBe(false);
  });
});

describe('big files are written on stdin, not in one shell argument (night review)', () => {
  it('a 150 KB MEMORY.md goes through the volume write; a small one through the shell', async () => {
    const { MockProvider } = await import('../src/providers/mockProvider.js');
    const { writeCoreFile } = await import('../src/orchestrator/snapshots.js');
    const provider = new MockProvider();
    const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'kitchen', workspace: { files: {}, configPatch: { agentId: 'kitchen', authMode: 'api-key' } }, env: {} });
    const big = 'x'.repeat(150_000);
    await writeCoreFile(provider, runtimeRef, 'kitchen', 'MEMORY.md', big);
    expect(provider.written).toHaveLength(1);
    expect(provider.written[0]!.bytes.toString('utf8')).toBe(big);
    expect(provider.written[0]!.argv.at(-1)).toBe('/home/node/.openclaw/agents/kitchen/agent/MEMORY.md');
    const before = provider.written.length;
    await writeCoreFile(provider, runtimeRef, 'kitchen', 'SOUL.md', 'small');
    expect(provider.written.length).toBe(before);
    expect(provider.execLog.some((c) => String(c).includes('base64 -d'))).toBe(true);
  });
});

async function routeWorld() {
  const Database = (await import('better-sqlite3')).default;
  const Fastify = (await import('fastify')).default;
  const { Store } = await import('../src/store/store.js');
  const { MockProvider } = await import('../src/providers/mockProvider.js');
  const { registerRoutes } = await import('../src/api/routes.js');
  const store = new Store(new Database(':memory:'));
  const map = new Map<string, string>();
  const secrets = { put: async (r: string, v: string) => { map.set(r, v); }, get: async (r: string) => { const v = map.get(r); if (v === undefined) throw new Error('missing'); return v; }, delete: async (r: string) => { map.delete(r); } };
  store.insertHost({ id: 'h1', ownerId: 'o', kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' } as never);
  const f = Fastify();
  await registerRoutes(f, { store, secrets, providers: new Map([['mock', new MockProvider()]]), channel: { kind: 'telegram', pool: { owns: () => false, availableCount: () => 0 }, release: async () => {} }, allowUnjailedOps: true } as never);
  const as = (owner = 'o') => ({ 'x-hatchabot-owner': owner });
  return { store, f, as };
}

describe('night review: route refusals', () => {
  it('the manager cannot be set up on a local model (its network cannot reach one)', async () => {
    const { store, f, as } = await routeWorld();
    store.insertAIProfile({ id: 'loc', ownerId: 'o', name: 'Ollama', vendor: 'local', kind: 'api_key', model: 'qwen', createdAt: 'now' } as never);
    const r = await f.inject({ method: 'POST', url: '/v1/ops-agent', headers: as(), payload: { aiProfileId: 'loc' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/can't use a local model/);
    const none = await f.inject({ method: 'POST', url: '/v1/ops-agent', headers: as(), payload: {} });
    expect(none.statusCode).toBe(400);
  });
  it('a class whose source was deleted can still be renamed, and forgets that source', async () => {
    const { store, f, as } = await routeWorld();
    store.insertAIProfile({ id: 'p1', ownerId: 'o', name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/p1', createdAt: 'now' } as never);
    const c = await f.inject({ method: 'POST', url: '/v1/agent-classes', headers: as(), payload: { name: 'Helpers', aiProfileId: 'p1' } });
    expect(c.statusCode).toBeLessThan(300);
    const id = c.json().class.id;
    store.deleteAIProfile('p1');
    const put = await f.inject({ method: 'PUT', url: `/v1/agent-classes/${id}`, headers: as(), payload: { name: 'Helpers 2' } });
    expect(put.statusCode, put.body).toBe(200);
    expect(store.getAgentClass(id)!.aiProfileId ?? null).toBeNull();
  });
});

describe('git URLs (night review)', () => {
  it('an ssh:// URL on another port than 22 is not accepted (it used to be cloned from 22)', async () => {
    const { normalizeGitUrl } = await import('../src/orchestrator/gitSource.js');
    expect(normalizeGitUrl('ssh://git@gitea.example.com:2222/me/notes.git')).toBeNull();
    expect(normalizeGitUrl('ssh://git@gitea.example.com:22/me/notes.git')?.sshUrl).toBe('git@gitea.example.com:me/notes.git');
    expect(normalizeGitUrl('ssh://git@gitea.example.com/me/notes.git')?.repoName).toBe('notes');
  });
});
