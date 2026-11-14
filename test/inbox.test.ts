import { describe, expect, it } from 'vitest';
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
