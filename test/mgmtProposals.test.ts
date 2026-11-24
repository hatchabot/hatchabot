import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { markInterruptedConfirms } from '../src/api/mgmtChat.js';
import { readFileSync } from 'node:fs';

/** Proposals live in the database: listed on the home screen, approvable from
 *  anywhere the owner is signed in, gone for everyone else, single-use. */

class MemSecrets implements SecretStore {
  map = new Map<string, string>();
  async put(r: string, v: string) { this.map.set(r, v); }
  async get(r: string) { const v = this.map.get(r); if (v === undefined) throw new Error('missing'); return v; }
  async delete(r: string) { this.map.delete(r); }
}
const A = { 'x-hatchabot-owner': 'owner-a' };
const B = { 'x-hatchabot-owner': 'owner-b' };

async function server(db: Database.Database) {
  const store = new Store(db);
  const f = Fastify();
  await registerRoutes(f, {
    store, secrets: new MemSecrets(), providers: new Map([['mock', new MockProvider()]]),
    channel: { pool: { availableCount: () => 0 } } as any,
    mgmtLlmComplete: async () => ({ stopReason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'run_backup', input: {} }] }) as any,
  });
  return { store, f };
}

describe('management proposals', () => {
  it('list, survive a restart, stay private to their owner, and resolve once', async () => {
    const db = new Database(':memory:');
    const one = await server(db);
    for (const o of ['owner-a', 'owner-b']) {
      one.store.insertHost({ id: `h-${o}`, ownerId: o, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
      one.store.insertAIProfile({ id: `p-${o}`, ownerId: o, name: 'Key', vendor: 'anthropic', kind: 'api_key', model: 'm', secretRef: 'ai/x', createdAt: 'now' });
    }
    // A card as the Hatchabot agent files one: a pending record in the store,
    // which is what the home screen lists and what Confirm resolves. (The
    // Claude-only web chat that used to file these was removed in v2.2.0.)
    const now = Date.now();
    one.store.putMgmtProposal({
      id: 'c_1', ownerId: 'owner-a', chatId: 0, fromUserId: 0, messageId: 0, tool: 'run_backup',
      resolved: { rest: { call: { method: 'POST', path: '/v1/backups/run', body: {} }, card: '💾 Back up every agent' } },
      summary: '💾 Back up every agent', createdAtMs: now, expiresAtMs: now + 3600_000, status: 'pending', source: 'agent',
    } as never);
    const listed = (await one.f.inject({ method: 'GET', url: '/v1/proposals', headers: A })).json();
    expect(listed.pending.length).toBeGreaterThan(0);
    expect(listed.pending[0].summary).toMatch(/Back up every agent/);
    const id = listed.pending[0].confirmId;

    // Another account sees nothing and cannot touch it.
    expect((await one.f.inject({ method: 'GET', url: '/v1/proposals', headers: B })).json().pending).toEqual([]);
    expect((await one.f.inject({ method: 'POST', url: `/v1/proposals/${id}/confirm`, headers: B })).statusCode).toBe(404);

    // "Restart": a new server on the same database still has the card.
    const two = await server(db);
    const after = (await two.f.inject({ method: 'GET', url: '/v1/proposals', headers: A })).json();
    expect(after.pending.map((p: any) => p.confirmId)).toContain(id);

    const ok = await two.f.inject({ method: 'POST', url: `/v1/proposals/${id}/cancel`, headers: A });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().text).toMatch(/Cancelled/);
    expect((await two.f.inject({ method: 'POST', url: `/v1/proposals/${id}/confirm`, headers: A })).statusCode).toBe(409);
    const end = (await two.f.inject({ method: 'GET', url: '/v1/proposals', headers: A })).json();
    expect(end.pending.map((p: any) => p.confirmId)).not.toContain(id);
    expect(end.recent.find((r: any) => r.confirmId === id)?.status).toBe('cancelled');
    expect((await two.f.inject({ method: 'POST', url: `/v1/proposals/${id}/explode`, headers: A })).statusCode).toBe(404);
  });
});

describe('cancelling a card while another is being carried out (HB-0940)', () => {
  it('answers at once, while a second confirm still waits its turn', async () => {
    const { store, f } = await server(new Database(':memory:'));
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    // What the first card does: a change whose answer is held until the test lets it go (a rebuild being followed, say).
    f.post('/v1/test/slow-change', async () => { entered(); await held; order.push('slow change done'); return {}; });
    f.post('/v1/test/quick-change', async () => { order.push('quick change ran'); return {}; });
    const now = Date.now();
    const card = (id: string, path: string, summary: string) => store.putMgmtProposal({
      id, ownerId: 'owner-a', chatId: 0, fromUserId: 0, messageId: 0, tool: 'run_backup',
      resolved: { rest: { call: { method: 'POST', path, body: {} }, card: summary } },
      summary, createdAtMs: now, expiresAtMs: now + 3600_000, status: 'pending', source: 'agent',
    } as never);
    card('c_slow', '/v1/test/slow-change', '🔄 The slow change');
    card('c_other', '/v1/test/quick-change', '🛑 Another change');
    card('c_next', '/v1/test/quick-change', '🛑 A third change');
    try {
      const slow = f.inject({ method: 'POST', url: '/v1/proposals/c_slow/confirm', headers: A });
      await inside;
      const next = f.inject({ method: 'POST', url: '/v1/proposals/c_next/confirm', headers: A });
      // The cancel is answered with the first change still held. (The timer only
      // turns a cancel stuck behind it into a failure rather than a hang.)
      const stuck = Symbol('still waiting');
      const cancel = await Promise.race([
        f.inject({ method: 'POST', url: '/v1/proposals/c_other/cancel', headers: A }),
        new Promise<typeof stuck>((r) => { setTimeout(() => r(stuck), 5_000).unref(); }),
      ]);
      expect(cancel).not.toBe(stuck);
      const res = cancel as Awaited<ReturnType<typeof f.inject>>;
      expect(res.statusCode).toBe(200);
      expect(res.json().text).toMatch(/^✖ Cancelled — 🛑 Another change/);
      expect(store.getMgmtProposal<{ status: string }>('c_other')?.status).toBe('cancelled');
      expect(order).toEqual([]);
      // Confirms are still one at a time: the third runs once the first is over.
      order.push('released');
      release();
      expect((await slow).json().text).toMatch(/^✅ 🔄 The slow change/);
      expect((await next).json().text).toMatch(/^✅ 🛑 A third change/);
      expect(order).toEqual(['released', 'slow change done', 'quick change ran']);
      // Still single-use and owner-bound: the cancelled card cannot be confirmed, nor cancelled by another account.
      expect((await f.inject({ method: 'POST', url: '/v1/proposals/c_other/confirm', headers: A })).statusCode).toBe(409);
      expect((await f.inject({ method: 'POST', url: '/v1/proposals/c_next/cancel', headers: B })).statusCode).toBe(404);
    } finally { release(); }
  });
});

describe('a confirm the process ended in the middle of (HB-1053)', () => {
  it('says so after the restart, as a failure does, and is never run again', async () => {
    const db = new Database(':memory:');
    const one = await server(db);
    const now = Date.now();
    const card = (id: string, summary: string) => one.store.putMgmtProposal({
      id, ownerId: 'owner-a', chatId: 0, fromUserId: 0, messageId: 0, tool: 'run_backup',
      resolved: { rest: { call: { method: 'POST', path: '/v1/backups/run', body: {} }, card: summary } },
      summary, createdAtMs: now, expiresAtMs: now + 3600_000, status: 'pending', source: 'owner',
    } as never);
    card('c_cut', '💾 Back up every agent');
    card('c_done', '💾 Back up again');
    card('c_off', '💾 Back up once more');
    // A confirm's claim, and then the process ends before the change runs.
    expect(one.store.resolveMgmtProposal('c_cut', 'confirmed', now)).toBe(true);
    // One that finished and one cancelled, each with what it said.
    one.store.resolveMgmtProposal('c_done', 'confirmed', now);
    one.store.setMgmtProposalOutcome('c_done', '✅ 💾 Back up again');
    expect((await one.f.inject({ method: 'POST', url: '/v1/proposals/c_off/cancel', headers: A })).statusCode).toBe(200);

    // The restart: the start-up step, then a server on the same database.
    expect(markInterruptedConfirms(new Store(db))).toBe(1);
    const two = await server(db);
    const recent = (await two.f.inject({ method: 'GET', url: '/v1/proposals', headers: A })).json().recent as Array<{ confirmId: string; status: string; outcome?: string }>;
    const cut = recent.find((r) => r.confirmId === 'c_cut');
    expect(cut?.status).toBe('confirmed');
    // ⚠ first: the home screen shows it with the failed ones (web/app/start.js loadProposals).
    expect(cut?.outcome).toMatch(/^⚠ Interrupted — 💾 Back up every agent: .*may not have happened/);
    expect(recent.find((r) => r.confirmId === 'c_done')?.outcome).toBe('✅ 💾 Back up again');
    expect(recent.find((r) => r.confirmId === 'c_off')?.outcome).toMatch(/^✖ Cancelled/);
    // Still single-use: confirming it again runs nothing.
    expect((await two.f.inject({ method: 'POST', url: '/v1/proposals/c_cut/confirm', headers: A })).statusCode).toBe(409);
    // A second start has nothing more to mark.
    expect(markInterruptedConfirms(two.store)).toBe(0);
  });

  it('is done at every start, before the server answers anyone', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const at = src.indexOf('markInterruptedConfirms(store)');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf('await app.listen('));
  });
});
