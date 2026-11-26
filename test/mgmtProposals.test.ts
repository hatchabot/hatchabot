import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { Store } from '../src/store/store.js';
import { MockProvider } from '../src/providers/mockProvider.js';
import { registerRoutes } from '../src/api/routes.js';
import type { SecretStore } from '../src/secrets/secretStore.js';
import { interruptedConfirmsNote, markInterruptedConfirms } from '../src/api/ops/mgmtChat.js';
import { makeWorld, seedRunningAgent } from './support/world.js';
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
    expect(markInterruptedConfirms(new Store(db)).map((c) => c.id)).toEqual(['c_cut']);
    const two = await server(db);
    const recent = (await two.f.inject({ method: 'GET', url: '/v1/proposals', headers: A })).json().recent as Array<{ confirmId: string; status: string; outcome?: string }>;
    const cut = recent.find((r) => r.confirmId === 'c_cut');
    expect(cut?.status).toBe('confirmed');
    // ⚠ first: the home screen shows it with the failed ones (web/app/cards.js loadProposals).
    expect(cut?.outcome).toMatch(/^⚠ Interrupted — 💾 Back up every agent: .*may not have happened/);
    expect(recent.find((r) => r.confirmId === 'c_done')?.outcome).toBe('✅ 💾 Back up again');
    expect(recent.find((r) => r.confirmId === 'c_off')?.outcome).toMatch(/^✖ Cancelled/);
    // Still single-use: confirming it again runs nothing.
    expect((await two.f.inject({ method: 'POST', url: '/v1/proposals/c_cut/confirm', headers: A })).statusCode).toBe(409);
    // A second start has nothing more to mark.
    expect(markInterruptedConfirms(two.store)).toEqual([]);
  });

  it('is done at every start, before the server answers anyone', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const at = src.indexOf('markInterruptedConfirms(store)');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf('await app.listen('));
  });
});

describe('File it again: a card a restart cut off, as a new card for its owner to confirm (HB-1053)', () => {
  /** A card confirmed `agoMs` before the restart, whose change the restart then cut off. */
  async function cutOff(agoMs = 0) {
    const db = new Database(':memory:');
    const one = await server(db);
    const at = Date.now() - agoMs;
    one.store.putMgmtProposal({
      id: 'c_cut', ownerId: 'owner-a', chatId: 0, fromUserId: 0, messageId: 0, tool: 'run_backup',
      resolved: { rest: { call: { method: 'POST', path: '/v1/backups/run', body: {} }, card: '💾 Back up every agent' } },
      summary: '💾 Back up every agent\nAll of them, now.', createdAtMs: at, expiresAtMs: at + 3 * 3600_000, status: 'pending', source: 'agent', note: 'before the trip', risk: 'routine',
    } as never);
    one.store.resolveMgmtProposal('c_cut', 'confirmed', at);
    const marked = markInterruptedConfirms(new Store(db));
    const two = await server(db);
    const list = async (h = A) => (await two.f.inject({ method: 'GET', url: '/v1/proposals', headers: h })).json() as { pending: Array<Record<string, unknown>>; recent: Array<Record<string, unknown>> };
    const again = (id = 'c_cut', h = A) => two.f.inject({ method: 'POST', url: `/v1/proposals/${id}/again`, headers: h });
    return { db, two, marked, list, again };
  }

  it('makes a fresh card with the same change, waiting for Confirm; nothing runs, and the old card says it was filed again', async () => {
    const t = await cutOff();
    expect(t.marked).toEqual([{ id: 'c_cut', ownerId: 'owner-a', summary: '💾 Back up every agent\nAll of them, now.', tool: 'run_backup' }]);
    const before = await t.list();
    expect(before.pending).toEqual([]);
    expect(before.recent[0]).toMatchObject({ confirmId: 'c_cut', status: 'confirmed', interrupted: true, refiled: false });
    expect(String(before.recent[0]!.outcome)).toBe('⚠ Interrupted — 💾 Back up every agent\nAll of them, now.: Hatchabot restarted while it was carrying this out, so it may not have happened, or only in part. Check, and if it is not done, File it again.');

    const r = await t.again();
    expect(r.statusCode, r.body).toBe(200);
    const { confirmId, summary } = r.json() as { confirmId: string; summary: string };
    expect(confirmId).not.toBe('c_cut');
    expect(summary).toBe('💾 Back up every agent');
    const fresh = t.two.store.getMgmtProposal<Record<string, unknown>>(confirmId)!;
    expect(fresh).toMatchObject({
      status: 'pending', ownerId: 'owner-a', tool: 'run_backup', summary: '💾 Back up every agent\nAll of them, now.', source: 'agent', note: 'before the trip', risk: 'routine', refiledFrom: 'c_cut',
      resolved: { rest: { call: { method: 'POST', path: '/v1/backups/run', body: {} }, card: '💾 Back up every agent' } },
    });
    expect(fresh.outcome).toBeUndefined();
    // As long to decide as the first card had.
    expect((fresh.expiresAtMs as number) - (fresh.createdAtMs as number)).toBe(24 * 3600_000); // the store's day, the longer of the two
    const after = await t.list();
    expect(after.pending.map((p) => p.confirmId)).toEqual([confirmId]);
    expect(after.recent.find((x) => x.confirmId === 'c_cut')).toMatchObject({ interrupted: true, refiled: true });
    // Once per card.
    const twice = await t.again();
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe('It was filed again already: its card is under Alerts.');
    expect((await t.list()).pending).toHaveLength(1);
  });

  it("another account's card is not found, and a card no restart cut off is not filed again", async () => {
    const t = await cutOff();
    expect((await t.again('c_cut', B)).statusCode).toBe(404);
    expect((await t.again('c_nobody')).statusCode).toBe(404);
    t.two.store.putMgmtProposal({ id: 'c_done', ownerId: 'owner-a', chatId: 0, fromUserId: 0, messageId: 0, tool: 'run_backup', resolved: {}, summary: '💾 Again', createdAtMs: Date.now(), expiresAtMs: Date.now() + 3600_000, status: 'pending' } as never);
    const pending = await t.again('c_done');
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error).toBe('Only a change a restart cut off can be filed again.');
    t.two.store.resolveMgmtProposal('c_done', 'confirmed', Date.now());
    t.two.store.setMgmtProposalOutcome('c_done', '⚠ Failed — 💾 Again: no room');
    expect((await t.again('c_done')).statusCode).toBe(409);
  });

  it('a card confirmed long before the restart (the machine was off) is shown from the restart, its hour counted from then', async () => {
    const t = await cutOff(3 * 24 * 3600_000);
    const cut = (await t.list()).recent.find((x) => x.confirmId === 'c_cut');
    expect(cut).toMatchObject({ interrupted: true, refiled: false });
    expect(Date.now() - (cut!.resolvedAtMs as number)).toBeLessThan(60_000);
  });

  it('is held to the limit of waiting cards, as the management agent is', async () => {
    const t = await cutOff();
    for (let i = 0; i < 20; i++) t.two.store.putMgmtProposal({ id: `c_w${i}`, ownerId: 'owner-a', chatId: 0, fromUserId: 0, messageId: 0, tool: 'run_backup', resolved: {}, summary: `💾 ${i}`, createdAtMs: Date.now(), expiresAtMs: Date.now() + 3600_000, status: 'pending' } as never);
    const r = await t.again();
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('There are already 20 changes waiting for you. Confirm or cancel some first.');
    expect(t.two.store.getMgmtProposal<Record<string, unknown>>('c_cut')!.refiledAs).toBeUndefined();
  });
});

describe("the owner's management agent hears of the changes a restart cut off (HB-1053)", () => {
  it('one note per owner in its own conversation, quoting each card, once its container is up; an owner with no manager is told nothing', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { id: 'ops1', slug: 'hatchabot', name: 'Hatchabot' });
    w.store.setAgentOps(id, true);
    const cards = [
      { id: 'c1', ownerId: w.owner, summary: '📸 Snapshot "Piano Practice"\nNow.', tool: 'snapshot_agent' },
      { id: 'c2', ownerId: w.owner, summary: '🔁 Rebuild "Homework Helper" [now]', tool: 'rebuild_agent' },
      { id: 'c3', ownerId: 'someone-else', summary: '💾 Back up every agent', tool: 'run_backup' },
    ];
    await w.routes!.tellInterruptedConfirms(cards);
    const turns = w.provider.execLog.filter((argv) => argv[0] === 'agent');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.slice(0, 4)).toEqual(['agent', '--agent', 'hatchabot', '-m']);
    const note = turns[0]![4]!;
    expect(note).toContain('Hatchabot restarted while it was carrying out 2 changes your owner had confirmed, so they may not have happened, or only in part: "📸 Snapshot "Piano Practice""; "🔁 Rebuild "Homework Helper" now". Their cards on the Hatchabot home screen, under Alerts, say Interrupted, with a File it again button that files the same change again for them to confirm. Nothing is tried again by itself.');
    expect(note).not.toContain('Back up every agent');
    await w.f.close();
  });

  it('says it of one change in the singular', () => {
    expect(interruptedConfirmsNote([{ id: 'c1', ownerId: 'o', summary: '💾 Back up every agent' }])).toBe(
      'Hatchabot restarted while it was carrying out a change your owner had confirmed, so it may not have happened, or only in part: "💾 Back up every agent". Its card on the Hatchabot home screen, under Alerts, says Interrupted, with a File it again button that files the same change again for them to confirm. Nothing is tried again by itself.');
  });

  it('is asked for at every start, with the cards the start marked', () => {
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    const marked = src.indexOf('interruptedConfirms = markInterruptedConfirms(store)');
    expect(marked).toBeGreaterThan(-1);
    expect(src.indexOf('routes.tellInterruptedConfirms(interruptedConfirms)')).toBeGreaterThan(marked);
  });
});

