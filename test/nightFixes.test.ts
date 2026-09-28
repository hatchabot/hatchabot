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
