import { describe, expect, it } from 'vitest';
import { as, makeWorld, seedRunningAgent } from './support/world.js';

/** The use-case walk-through (2026-09-27): each case here was a person's path that went wrong. */
describe('use-case walk-through', () => {
  it('a password change makes a pending reset link moot', async () => {
    const w = await makeWorld();
    w.store.insertLocalAccount({ id: 'acct-x', username: 'x', pwHash: 'h', pwSalt: 's', hostOwner: false, disabled: false, createdAt: 'now' } as never);
    w.store.setLocalAccountClaim('acct-x', 'code-123', new Date(Date.now() + 3_600_000).toISOString());
    w.store.setLocalAccountPassword('acct-x', 'h2', 's2');
    const row = w.store['db'].prepare(`SELECT claim_code FROM local_accounts WHERE id = 'acct-x'`).get() as { claim_code: string | null };
    expect(row.claim_code).toBeNull();
  });

  it('the management agent cannot be cloned as a template', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w, { id: 'ops1', slug: 'mgr', accountId: 'mgrbot' });
    w.store.setAgentOps(id, true);
    const r = await w.f.inject({ method: 'POST', url: `/v1/agents/${id}/clone`, headers: as(), payload: { name: 'Copy' } });
    expect(r.statusCode).toBe(409);
  });

  it('a shared agent\'s events come without their details to someone who does not own it', async () => {
    const w = await makeWorld();
    const id = await seedRunningAgent(w);
    w.store.recordEvent(id, 'connection.attached', { email: 'owner@example.com' });
    w.store.insertMembership({ id: 'm-u', agentId: id, userId: 'user-other', role: 'user', status: 'active' } as never);
    const mine = (await w.f.inject({ method: 'GET', url: '/v1/events', headers: as() })).json();
    expect(mine.find((e: any) => e.event === 'connection.attached').detail).toMatchObject({ email: 'owner@example.com' });
    const theirs = (await w.f.inject({ method: 'GET', url: '/v1/events', headers: as('user-other') })).json();
    const seen = theirs.find((e: any) => e.event === 'connection.attached');
    if (seen) expect(seen.detail).toBeUndefined();
  });

  it('group arrows move among the groups the owner sees (not an archived agent\'s)', async () => {
    const w = await makeWorld();
    await seedRunningAgent(w, { id: 'g1', slug: 'g1', accountId: 'g1bot' });
    await seedRunningAgent(w, { id: 'g2', slug: 'g2', accountId: 'g2bot' });
    await seedRunningAgent(w, { id: 'g3', slug: 'g3', accountId: 'g3bot' });
    const setGroup = (id: string, g: string) => w.f.inject({ method: 'PATCH', url: `/v1/agents/${id}`, headers: as(), payload: { group: g } });
    await setGroup('g1', 'A'); await setGroup('g2', 'Old'); await setGroup('g3', 'B');
    w.store['db'].prepare(`UPDATE agents SET state = 'ARCHIVED' WHERE id = 'g2'`).run();
    const r = await w.f.inject({ method: 'POST', url: '/v1/groups/move', headers: as(), payload: { group: 'A', dir: 'down' } });
    expect(r.json()).toMatchObject({ ok: true, moved: true });
    const order = w.store.listAgents(w.owner).filter((a) => a.state !== 'ARCHIVED').map((a) => a.group);
    expect(order.indexOf('B')).toBeLessThan(order.indexOf('A'));
  });
});
