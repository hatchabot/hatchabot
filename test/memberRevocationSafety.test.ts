import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runInNewContext } from 'node:vm';
import { allowlistScrubScript } from '../src/orchestrator/members.js';
import { PAIRING_DB } from '../src/orchestrator/claim.js';
import { DISCORD_ID } from './support/fixtures.js';

describe('member revocation across persisted approval forms', () => {
  it.each([['telegram', '555'], ['slack', 'U0GUEST'], ['discord', DISCORD_ID]])('removes both plain and %s-prefixed pairing rows without touching other accounts', (channel, id) => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE channel_pairing_allow_entries (channel_key TEXT, account_id TEXT, entry TEXT)');
      const add = db.prepare('INSERT INTO channel_pairing_allow_entries VALUES (?, ?, ?)');
      add.run(channel, 'hatchabot', id);
      add.run(channel, 'Hatchabot', `${channel}:${id}`);
      add.run(channel, 'hatchabot', '777');
      add.run(channel, 'other-account', `${channel}:${id}`);
      add.run('other-channel', 'hatchabot', id);
      const fs = { existsSync: (path: string) => path === PAIRING_DB };
      const script = allowlistScrubScript([{ channel, acct: 'hatchabot', id, cred: '/fixture/credentials.json' }]);
      expect(script).toMatch(/^node -e '\n[\s\S]*'$/);
      runInNewContext(script.slice("node -e '".length, -1), {
        require: (name: string) => {
          if (name === 'fs') return fs;
          if (name === 'node:sqlite') return { DatabaseSync: class { constructor() { return db; } } };
          throw new Error(`Unexpected module: ${name}`);
        },
      });
      expect(db.prepare('SELECT channel_key, account_id, entry FROM channel_pairing_allow_entries ORDER BY rowid').all()).toEqual([
        { channel_key: channel, account_id: 'hatchabot', entry: '777' },
        { channel_key: channel, account_id: 'other-account', entry: `${channel}:${id}` },
        { channel_key: 'other-channel', account_id: 'hatchabot', entry: id },
      ]);
    } finally { db.close(); }
  });
});
