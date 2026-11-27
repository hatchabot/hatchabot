import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';

/**
 * Inbox sharing plumbing: email↔owner mapping and share addressing/claiming.
 * The transport is a template blob (covered elsewhere); here we verify a share
 * reaches the right person whether or not they've signed in yet.
 */
function store() { return new Store(new Database(':memory:')); }

describe('email delivery requires a verified identity (HB-0665)', () => {
  it('ignores a password username and reclaims only pending copies previously misbound to it', () => {
    const s = store();
    s.insertLocalAccount({ id: 'acct-example', username: 'recipient@example.com', pwHash: 'made-up', pwSalt: 'made-up', hostOwner: false, disabled: false, createdAt: 'now' });
    s.recordAccount('acct-example', 'recipient@example.com');
    expect(s.ownerForEmail('recipient@example.com')).toBeUndefined();
    expect(s.listAccounts()).toEqual([]);
    for (const id of ['waiting', 'misbound', 'accepted']) s.insertShare({ id, fromOwner: 'user-sender', toEmail: 'recipient@example.com',
      toOwner: id === 'waiting' ? undefined : 'acct-example', agentName: 'Example', blob: Buffer.from('example'), createdAt: 'now' });
    s.setShareStatus('accepted', 'accepted', 'acct-example');
    expect(s.claimSharesForEmail('acct-example', 'recipient@example.com')).toBe(0);
    expect(s.listInbox('acct-example', 'recipient@example.com')).toEqual([]);
    expect(s.getShareFor('misbound', 'acct-example', 'recipient@example.com')).toBeUndefined();
    s.recordAccount('user-recipient', 'recipient@example.com');
    expect(s.ownerForEmail('RECIPIENT@example.com')).toBe('user-recipient');
    expect(s.listAccounts()).toEqual([{ ownerId: 'user-recipient', email: 'recipient@example.com' }]);
    expect(s.claimSharesForEmail('user-recipient', 'recipient@example.com')).toBe(2);
    expect(s.listInbox('user-recipient', 'recipient@example.com')).toHaveLength(2);
    expect(s.getShareFor('accepted', 'user-recipient', 'recipient@example.com')).toBeUndefined();
  });
});

describe('accounts registry', () => {
  it('maps an email to its owner, case-insensitively, and lists others', () => {
    const s = store();
    s.recordAccount('user-u1', 'Alice@Example.com');
    s.recordAccount('user-u2', 'bob@example.com');
    expect(s.ownerForEmail('alice@example.com')).toBe('user-u1');
    expect(s.ownerForEmail('ALICE@EXAMPLE.COM')).toBe('user-u1');
    expect(s.ownerForEmail('nobody@example.com')).toBeUndefined();
    expect(s.listAccounts('user-u1').map(a => a.ownerId)).toEqual(['user-u2']); // excludes self
  });
});

describe('agent shares reach the recipient', () => {
  const blob = Buffer.from('template-bytes');

  it('a share to a KNOWN account is bound and shows in their inbox', () => {
    const s = store();
    s.recordAccount('user-u2', 'bob@example.com');
    s.insertShare({ id: 'sh1', fromOwner: 'user-u1', fromEmail: 'a@example.com', toEmail: 'bob@example.com',
      toOwner: s.ownerForEmail('bob@example.com'), agentName: 'Stock Watcher', blob, createdAt: 'now' });
    const inbox = s.listInbox('user-u2', 'bob@example.com');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.agentName).toBe('Stock Watcher');
    expect(s.getShareFor('sh1', 'user-u2', 'bob@example.com')!.blob.toString()).toBe('template-bytes');
    // ...and NOT to anyone else.
    expect(s.getShareFor('sh1', 'user-u3', 'eve@example.com')).toBeUndefined();
  });

  it('a share to an email that has NOT signed in waits, then binds on sign-in', () => {
    const s = store();
    s.insertShare({ id: 'sh2', fromOwner: 'user-u1', toEmail: 'later@example.com',
      toOwner: undefined, agentName: 'HOA Advisor', blob, createdAt: 'now' });
    // Not visible to a random owner...
    expect(s.listInbox('user-u9', 'other@example.com')).toHaveLength(0);
    // ...but visible by the unclaimed email, and claimable on sign-in.
    expect(s.listInbox('user-u9', 'later@example.com')).toHaveLength(1);
    const claimed = s.claimSharesForEmail('user-u9', 'later@example.com');
    expect(claimed).toBe(1);
    expect(s.listInbox('user-u9', 'later@example.com')).toHaveLength(1); // now bound to u9
  });

  it('accept/dismiss remove it from the inbox', () => {
    const s = store();
    s.recordAccount('user-u2', 'bob@example.com');
    s.insertShare({ id: 'sh3', fromOwner: 'user-u1', toEmail: 'bob@example.com', toOwner: 'user-u2',
      agentName: 'A', blob, createdAt: 'now' });
    s.setShareStatus('sh3', 'accepted', 'user-u2');
    expect(s.listInbox('user-u2', 'bob@example.com')).toHaveLength(0);
    expect(s.getShareFor('sh3', 'user-u2', 'bob@example.com')).toBeUndefined(); // no double-accept
  });
});

describe('the inbox a page at a time (HB-1167)', () => {
  const blob = Buffer.from('template-bytes');
  const at = (i: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

  it('a page ends at a place, not a count: shares sent or settled meanwhile neither repeat one nor skip one', () => {
    const s = store();
    s.recordAccount('user-u2', 'bob@example.com');
    const send = (id: string, i: number) => s.insertShare({ id, fromOwner: 'user-u1', toEmail: 'bob@example.com', toOwner: 'user-u2', agentName: id, blob, createdAt: at(i) });
    for (let i = 0; i < 7; i++) send(`sh-${i}`, i);
    // Two sent in the same moment as sh-3: told apart by their ids.
    send('sh-tie-a', 3); send('sh-tie-b', 3);
    const one = s.listInbox('user-u2', 'bob@example.com', { limit: 4 });
    expect(ids(one)).toEqual(['sh-6', 'sh-5', 'sh-4', 'sh-tie-b']);
    const last = one.at(-1)!;
    // Meanwhile two new ones arrive, one of the first page is accepted and one not listed yet is dismissed.
    send('sh-new-1', 100); send('sh-new-2', 101);
    s.setShareStatus('sh-5', 'accepted', 'user-u2');
    s.setShareStatus('sh-1', 'dismissed', 'user-u2');
    // From its last one's place: the rest, none of the first page again (a count of rows would give sh-tie-b again).
    expect(ids(s.listInbox('user-u2', 'bob@example.com', { limit: 4, after: { createdAt: last.createdAt, id: last.id } }))).toEqual(['sh-tie-a', 'sh-3', 'sh-2', 'sh-0']);
    // The new ones are on the newest page, and the count is of every one waiting.
    expect(ids(s.listInbox('user-u2', 'bob@example.com', { limit: 2 }))).toEqual(['sh-new-2', 'sh-new-1']);
    expect(s.countInbox('user-u2', 'bob@example.com')).toBe(9);
    // No page: every one, newest first, as before.
    expect(ids(s.listInbox('user-u2', 'bob@example.com'))).toEqual(['sh-new-2', 'sh-new-1', 'sh-6', 'sh-4', 'sh-tie-b', 'sh-tie-a', 'sh-3', 'sh-2', 'sh-0']);
  });

  it('counts what it lists: pending, and theirs by account or by an address not claimed yet', () => {
    const s = store();
    s.insertShare({ id: 'mine', fromOwner: 'user-u1', toEmail: 'later@example.com', toOwner: 'user-u9', agentName: 'A', blob, createdAt: at(1) });
    s.insertShare({ id: 'waiting', fromOwner: 'user-u1', toEmail: 'Later@Example.com', agentName: 'B', blob, createdAt: at(2) });
    s.insertShare({ id: 'someone-else', fromOwner: 'user-u1', toEmail: 'other@example.com', toOwner: 'user-u3', agentName: 'C', blob, createdAt: at(3) });
    s.insertShare({ id: 'done', fromOwner: 'user-u1', toEmail: 'later@example.com', toOwner: 'user-u9', agentName: 'D', blob, createdAt: at(4) });
    s.setShareStatus('done', 'dismissed', 'user-u9');
    expect([ids(s.listInbox('user-u9', 'later@example.com', { limit: 10 })), s.countInbox('user-u9', 'later@example.com')]).toEqual([['waiting', 'mine'], 2]);
    expect([s.countInbox('user-u9'), s.countInbox('acct-example', 'later@example.com')]).toEqual([1, 0]);
    // One bound to another owner, though to my address, is theirs; one bound to me is counted once, not again by its address.
    s.insertShare({ id: 'bound-away', fromOwner: 'user-u1', toEmail: 'LATER@example.com', toOwner: 'user-u3', agentName: 'E', blob, createdAt: at(5) });
    expect([ids(s.listInbox('user-u9', 'later@example.com')), s.countInbox('user-u9', 'later@example.com')]).toEqual([['waiting', 'mine'], 2]);
  });

  /**
   * The plan SQLite makes of each statement the inbox prepares (the real
   * ones, caught at prepare, with the values they ran with). Each row's blob
   * comes before its status, so a scan of agent_shares reads every file kept.
   */
  function inboxPlans(run: (s: Store) => void): string[] {
    const db = new Database(':memory:');
    const s = new Store(db);
    const prepare = db.prepare.bind(db);
    const ran: Array<{ sql: string; args: unknown[] }> = [];
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      const st = prepare(sql);
      const caught = (k: 'get' | 'all') => (...args: unknown[]) => { ran.push({ sql, args }); return (st[k] as (...a: unknown[]) => unknown)(...args); };
      return new Proxy(st, { get: (t, k) => (k === 'get' || k === 'all' ? caught(k) : Reflect.get(t, k)) });
    }) as typeof db.prepare);
    try { run(s); } finally { spy.mockRestore(); }
    return ran.map(({ sql, args }) => (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(' | '));
  }

  it('finds and counts them on the two indexes, never by a scan of every share (HB-1167 review)', () => {
    for (const [what, run] of [
      ['count', (s: Store) => s.countInbox('user-u9', 'later@example.com')],
      ['first page', (s: Store) => s.listInbox('user-u9', 'later@example.com', { limit: 51 })],
      ['a later page', (s: Store) => s.listInbox('user-u9', 'later@example.com', { limit: 51, after: { createdAt: at(3), id: 'sh-3' } })],
      ['every one', (s: Store) => s.listInbox('user-u9', 'later@example.com')],
    ] as const) {
      const plans = inboxPlans(run);
      expect(plans, what).toHaveLength(1);
      expect(plans[0], what).toMatch(/SEARCH agent_shares USING (COVERING )?INDEX shares_to_owner \(to_owner=\? AND status=\?\)/);
      expect(plans[0], what).toMatch(/SEARCH agent_shares USING (COVERING )?INDEX shares_to_email_nocase \(to_email=\? AND status=\?\)/);
      expect(plans[0], what).not.toMatch(/SCAN agent_shares/);
    }
  });
});
