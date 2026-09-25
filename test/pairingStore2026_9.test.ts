import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { pairingListShell, parsePairingList } from '../src/orchestrator/claim.js';
import { denyPairing, grantChannelAccess, revokeMember } from '../src/orchestrator/members.js';

/**
 * OpenClaw 2026.9 keeps pairing requests and approvals in its state database;
 * the credentials files Hatchabot read and edited are simply absent. Every
 * script below is run for real against a temp volume that has ONLY the
 * database — the shape a 2026.9 agent has — and must find, delete, add and
 * scrub there. (Taco Agent's Discord knock was invisible and the owner's own
 * first message was never claimed, 2026-09-24.)
 */
const HOME = '/home/node/.openclaw';

function volume() {
  const dir = mkdtempSync(join(tmpdir(), 'oc29-'));
  mkdirSync(join(dir, 'state'));
  mkdirSync(join(dir, 'credentials'));
  const db = new Database(join(dir, 'state', 'openclaw.sqlite'));
  db.exec(`
    CREATE TABLE "channel_pairing_requests" ( channel_key TEXT NOT NULL, account_id TEXT NOT NULL, request_id TEXT NOT NULL, code TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, meta_json TEXT, PRIMARY KEY (channel_key, account_id, request_id) ) STRICT;
    CREATE TABLE "channel_pairing_allow_entries" ( channel_key TEXT NOT NULL, account_id TEXT NOT NULL, entry TEXT NOT NULL, sort_order INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (channel_key, account_id, entry) ) STRICT;
  `);
  db.prepare(`INSERT INTO channel_pairing_requests VALUES ('discord','hatchabot','1550586313743278091','K9DWSP94','2026-09-25T01:27:37.249Z','2026-09-25T01:27:42.378Z',?)`)
    .run(JSON.stringify({ tag: 'christopherkrueger0816', name: 'christopherkrueger0816', accountId: 'hatchabot' }));
  db.prepare(`INSERT INTO channel_pairing_requests VALUES ('telegram','fambot','555','CODE1','2026-09-25T01:00:00Z','2026-09-25T01:00:00Z',?)`)
    .run(JSON.stringify({ username: 'gran', firstName: 'Grandma' }));
  db.prepare(`INSERT INTO channel_pairing_allow_entries VALUES ('discord','hatchabot','123456789012345678',0,1)`).run();
  db.prepare(`INSERT INTO channel_pairing_allow_entries VALUES ('telegram','fambot','555',0,1)`).run();
  db.prepare(`INSERT INTO channel_pairing_allow_entries VALUES ('telegram','fambot','777',1,1)`).run();
  db.close();
  writeFileSync(join(dir, 'openclaw.json'), JSON.stringify({ channels: {
    telegram: { accounts: { FamBot: { dmPolicy: 'pairing', allowFrom: ['555', '777'] } } },
    discord: { accounts: { hatchabot: { dmPolicy: 'pairing', allowFrom: ['123456789012345678'] } } },
  } }));
  const run = (script: string) => execFileSync('sh', ['-c', script.replaceAll(HOME, dir)], { encoding: 'utf8' });
  const rows = (sql: string) => { const d = new Database(join(dir, 'state', 'openclaw.sqlite'), { readonly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
  return { dir, run, rows, done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function world() {
  const store = new Store(new Database(':memory:'));
  const provider = new MockProvider();
  const { runtimeRef } = await provider.provision({ agentId: 'a1', slug: 'a1', workspace: { files: {}, configPatch: { agentId: 'a1', authMode: 'api-key' } }, env: {} });
  store.insertAgent({ id: 'a1', ownerId: 'u1', name: 'Fam', slug: 'a1', state: 'RUNNING', aiProfileId: 'p', hostId: 'h', persona: '', sharedMemory: true, createdAt: 'now', updatedAt: 'now' });
  store.setAgentRuntimeRef('a1', runtimeRef);
  store.insertMembership({ id: 'm1', agentId: 'a1', userId: 'u1', role: 'owner', status: 'active' });
  return { store, provider, runtimeRef };
}

describe('pairing requests on a 2026.9 volume (database, no files)', () => {
  it('the list shell reads them from the database in the file\'s shape, and the app sees Discord names', () => {
    const v = volume();
    try {
      const out = run(v, pairingListShell('discord'));
      const list = parsePairingList(out);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: '1550586313743278091', code: 'K9DWSP94' });
      expect(list[0]!.meta).toMatchObject({ username: 'christopherkrueger0816', firstName: 'christopherkrueger0816' });
      expect(parsePairingList(run(v, pairingListShell('telegram')))[0]).toMatchObject({ id: '555', code: 'CODE1', meta: { username: 'gran' } });
      expect(parsePairingList(run(v, pairingListShell('slack')))).toEqual([]);
    } finally { v.done(); }
  });

  it('the file still wins where it exists (2026.7)', () => {
    const v = volume();
    try {
      writeFileSync(join(v.dir, 'credentials', 'telegram-pairing.json'), JSON.stringify({ version: 1, requests: [{ id: '9', code: 'FILE1', meta: {} }] }));
      expect(parsePairingList(run(v, pairingListShell('telegram')))).toEqual([{ id: '9', code: 'FILE1', meta: { username: undefined, firstName: undefined } }]);
    } finally { v.done(); }
  });

  it('deny deletes the request row and reports one', async () => {
    const { store, provider, runtimeRef } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: '1\n', stderr: '' });
    await denyPairing({ store, provider }, { agentId: 'a1', runtimeRef, code: 'K9DWSP94', kind: 'discord' });
    const script = provider.execLog.find((a) => a[0] === 'sh-volume')![1]!;
    const v = volume();
    try {
      expect(run(v, script).trim()).toBe('1');
      expect(v.rows(`select code from channel_pairing_requests`).map((r: any) => r.code)).toEqual(['CODE1']);
      expect(run(v, script).trim()).toBe('0'); // already gone
    } finally { v.done(); }
  });

  it('grant adds an approval row (and the config allow list), instead of a file the gateway would ignore', async () => {
    const { store, provider, runtimeRef } = await world();
    await grantChannelAccess({ store, provider }, { agentId: 'a1', runtimeRef, kind: 'discord', accountId: 'hatchabot', channelUserId: '999999999999999999' });
    const script = provider.execLog.find((a) => a[0] === 'sh-volume')![1]!;
    const v = volume();
    try {
      run(v, script);
      expect(v.rows(`select entry, sort_order from channel_pairing_allow_entries where channel_key='discord' order by sort_order`)).toEqual([
        { entry: '123456789012345678', sort_order: 0 }, { entry: '999999999999999999', sort_order: 1 },
      ]);
      expect(JSON.parse(readFileSync(join(v.dir, 'openclaw.json'), 'utf8')).channels.discord.accounts.hatchabot.allowFrom).toEqual(['123456789012345678', '999999999999999999']);
      run(v, script); // twice is fine
      expect(v.rows(`select count(*) as n from channel_pairing_allow_entries where channel_key='discord'`)).toEqual([{ n: 2 }]);
    } finally { v.done(); }
  });

  it('revoke scrubs the approval rows on every channel the member is known on, and the config', async () => {
    const { store, provider, runtimeRef } = await world();
    store.insertChannel({ id: 'ct', agentId: 'a1', kind: 'telegram', accountId: 'FamBot', secretRef: 'x', deepLink: 'x', createdAt: 'now' });
    store.insertChannel({ id: 'cd', agentId: 'a1', kind: 'discord', accountId: '1', secretRef: 'z', deepLink: 'z', createdAt: 'now' });
    store.insertMembership({ id: 'm2', agentId: 'a1', userId: 'u2', role: 'user', displayName: 'Gran', channelUserId: '555', status: 'active' });
    store.bindMemberIdentity('a1', 'u2', 'discord', '123456789012345678');
    await revokeMember({ store, provider }, 'a1', 'u2');
    const script = provider.execLog.find((a) => a[0] === 'sh-volume')![1]!;
    const v = volume();
    try {
      run(v, script);
      // Telegram's account id is stored lowercased by OpenClaw; the config key keeps its case.
      expect(v.rows(`select channel_key, entry from channel_pairing_allow_entries order by channel_key, entry`)).toEqual([{ channel_key: 'telegram', entry: '777' }]);
      const cfg = JSON.parse(readFileSync(join(v.dir, 'openclaw.json'), 'utf8')).channels;
      expect(cfg.telegram.accounts.FamBot.allowFrom).toEqual(['777']);
      expect(cfg.discord.accounts.hatchabot.allowFrom).toEqual([]);
    } finally { v.done(); }
  });
});

function run(v: ReturnType<typeof volume>, script: string): string { return v.run(script); }
