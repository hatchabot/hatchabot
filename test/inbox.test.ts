import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';

/**
 * Inbox sharing plumbing: email↔owner mapping and share addressing/claiming.
 * The transport is a template blob (covered elsewhere); here we verify a share
 * reaches the right person whether or not they've signed in yet.
 */
function store() { return new Store(new Database(':memory:')); }

describe('accounts registry', () => {
  it('maps an email to its owner, case-insensitively, and lists others', () => {
    const s = store();
    s.recordAccount('u1', 'Alice@Example.com');
    s.recordAccount('u2', 'bob@example.com');
    expect(s.ownerForEmail('alice@example.com')).toBe('u1');
    expect(s.ownerForEmail('ALICE@EXAMPLE.COM')).toBe('u1');
    expect(s.ownerForEmail('nobody@example.com')).toBeUndefined();
    expect(s.listAccounts('u1').map(a => a.ownerId)).toEqual(['u2']); // excludes self
  });
});

describe('agent shares reach the recipient', () => {
  const blob = Buffer.from('template-bytes');

  it('a share to a KNOWN account is bound and shows in their inbox', () => {
    const s = store();
    s.recordAccount('u2', 'bob@example.com');
    s.insertShare({ id: 'sh1', fromOwner: 'u1', fromEmail: 'a@example.com', toEmail: 'bob@example.com',
      toOwner: s.ownerForEmail('bob@example.com'), agentName: 'Stock Advisor', blob, createdAt: 'now' });
    const inbox = s.listInbox('u2', 'bob@example.com');
    expect(inbox).toHaveLength(1);
    expect(inbox[0]!.agentName).toBe('Stock Advisor');
    expect(s.getShareFor('sh1', 'u2', 'bob@example.com')!.blob.toString()).toBe('template-bytes');
    // ...and NOT to anyone else.
    expect(s.getShareFor('sh1', 'u3', 'eve@example.com')).toBeUndefined();
  });

  it('a share to an email that has NOT signed in waits, then binds on sign-in', () => {
    const s = store();
    s.insertShare({ id: 'sh2', fromOwner: 'u1', toEmail: 'later@example.com',
      toOwner: undefined, agentName: 'Condo Advisor', blob, createdAt: 'now' });
    // Not visible to a random owner...
    expect(s.listInbox('u9', 'other@example.com')).toHaveLength(0);
    // ...but visible by the unclaimed email, and claimable on sign-in.
    expect(s.listInbox('u9', 'later@example.com')).toHaveLength(1);
    const claimed = s.claimSharesForEmail('u9', 'later@example.com');
    expect(claimed).toBe(1);
    expect(s.listInbox('u9', 'later@example.com')).toHaveLength(1); // now bound to u9
  });

  it('accept/dismiss remove it from the inbox', () => {
    const s = store();
    s.recordAccount('u2', 'bob@example.com');
    s.insertShare({ id: 'sh3', fromOwner: 'u1', toEmail: 'bob@example.com', toOwner: 'u2',
      agentName: 'A', blob, createdAt: 'now' });
    s.setShareStatus('sh3', 'accepted', 'u2');
    expect(s.listInbox('u2', 'bob@example.com')).toHaveLength(0);
    expect(s.getShareFor('sh3', 'u2', 'bob@example.com')).toBeUndefined(); // no double-accept
  });
});
