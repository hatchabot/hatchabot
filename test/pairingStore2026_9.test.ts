import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockProvider } from '../src/providers/mockProvider.js';
import { Store } from '../src/store/store.js';
import { listPairingRequests, pairingListShell, parsePairingList } from '../src/orchestrator/members/claim.js';
import type { RuntimeProvider } from '../src/providers/provider.js';
import { denyPairing, grantChannelAccess, revokeMember, scrubChannelAllowlist } from '../src/orchestrator/members/members.js';
import { DISCORD_ID } from './support/fixtures.js';

/**
 * OpenClaw 2026.9 keeps pairing requests and approvals in its state database;
 * the credentials files Hatchabot read and edited are simply absent. Every
 * script below is run for real against a temp volume that has ONLY the
 * database — the shape a 2026.9 agent has — and must find, delete, add and
 * scrub there. (One agent's Discord knock was invisible and the owner's own
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
  db.prepare(`INSERT INTO channel_pairing_requests VALUES ('discord','hatchabot','100000000000000001','K9DWSP94','2026-09-25T01:27:37.249Z','2026-09-25T01:27:42.378Z',?)`)
    .run(JSON.stringify({ tag: 'somebody0816', name: 'somebody0816', accountId: 'hatchabot' }));
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
  const exec = (sql: string) => { const d = new Database(join(dir, 'state', 'openclaw.sqlite')); try { d.exec(sql); } finally { d.close(); } };
  return { dir, run, rows, exec, done: () => rmSync(dir, { recursive: true, force: true }) };
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
      expect(list[0]).toMatchObject({ id: '100000000000000001', code: 'K9DWSP94' });
      expect(list[0]!.meta).toMatchObject({ username: 'somebody0816', firstName: 'somebody0816' });
      expect(parsePairingList(run(v, pairingListShell('telegram')))[0]).toMatchObject({ id: '555', code: 'CODE1', meta: { username: 'gran' } });
      expect(parsePairingList(run(v, pairingListShell('slack')))).toEqual([]);
    } finally { v.done(); }
  });

  it('a 2026.7 volume (the tables made but empty, requests in the file) lists the file\'s', () => {
    const v = volume();
    try {
      v.exec('delete from channel_pairing_requests');
      writeFileSync(join(v.dir, 'credentials', 'telegram-pairing.json'), JSON.stringify({ version: 1, requests: [{ id: '9', code: 'FILE1', meta: {} }] }));
      expect(parsePairingList(run(v, pairingListShell('telegram')))).toEqual([{ id: '9', code: 'FILE1', meta: { username: undefined, firstName: undefined } }]);
    } finally { v.done(); }
  });

  it('a 2026.7 file left on a 2026.9 volume no longer hides the database: its rows first, then the file\'s; an unreadable file adds nothing (HB-0033)', () => {
    const v = volume();
    try {
      const f = join(v.dir, 'credentials', 'telegram-pairing.json');
      writeFileSync(f, JSON.stringify({ version: 1, requests: [{ id: '9', code: 'FILE1', meta: {} }, { id: '555', code: 'CODE1', meta: {} }] }));
      expect(parsePairingList(run(v, pairingListShell('telegram'))).map((r) => r.code)).toEqual(['CODE1', 'FILE1']);
      writeFileSync(f, '{"version":1,"requests":[{"id":"9",');
      expect(parsePairingList(run(v, pairingListShell('telegram'))).map((r) => r.code)).toEqual(['CODE1']);
    } finally { v.done(); }
  });

  it('with a left-over file, deny takes the request from both stores and grant writes both (HB-0033)', async () => {
    const { store, provider, runtimeRef } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: '2\n', stderr: '' });
    await denyPairing({ store, provider }, { agentId: 'a1', runtimeRef, code: 'CODE1', kind: 'telegram' });
    await grantChannelAccess({ store, provider }, { agentId: 'a1', runtimeRef, kind: 'telegram', accountId: 'FamBot', channelUserId: '888' });
    const [deny, grant] = provider.execLog.filter((a) => a[0] === 'sh-volume').map((a) => a[1]!);
    const v = volume();
    try {
      const f = join(v.dir, 'credentials', 'telegram-pairing.json');
      const cred = join(v.dir, 'credentials', 'telegram-fambot-allowFrom.json');
      writeFileSync(f, JSON.stringify({ version: 1, requests: [{ id: '555', code: 'CODE1', meta: {} }] }));
      writeFileSync(cred, JSON.stringify({ version: 1, allowFrom: ['555'] }));
      expect(run(v, deny!).trim()).toBe('2');
      expect(v.rows(`select code from channel_pairing_requests where channel_key='telegram'`)).toEqual([]);
      expect(JSON.parse(readFileSync(f, 'utf8')).requests).toEqual([]);
      run(v, grant!);
      expect(v.rows(`select entry from channel_pairing_allow_entries where channel_key='telegram' and entry='888'`)).toEqual([{ entry: '888' }]);
      expect(JSON.parse(readFileSync(cred, 'utf8')).allowFrom).toEqual(['555', '888']);
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
    store.bindMemberIdentity('a1', 'u2', 'discord', DISCORD_ID);
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

describe('a pairing store that is there but cannot be read (HB-1050)', () => {
  // The list shell run for real against the volume, as the container would.
  const on = (dir: string) => ({
    execShell: async (_ref: string, script: string) => {
      const { stdout } = await promisify(execFile)('sh', ['-c', script.replaceAll(HOME, dir)], { encoding: 'utf8' });
      return { code: 0, stdout, stderr: '' };
    },
  } as unknown as RuntimeProvider);
  const read = (dir: string, strict: boolean) => listPairingRequests(on(dir), 'ref', 'fambot', 'telegram', { strict });

  it('a damaged database is a read that failed when strict, and none otherwise', async () => {
    const v = volume();
    try {
      writeFileSync(join(v.dir, 'state', 'openclaw.sqlite'), 'not a database, a page of something else'.repeat(200));
      await expect(read(v.dir, true)).rejects.toThrow(/could not be read \(its database/);
      expect(await read(v.dir, false)).toEqual([]);
    } finally { v.done(); }
  });

  it('a database OpenClaw is writing is waited for, not read as nobody knocking', async () => {
    const v = volume();
    const lock = new Database(join(v.dir, 'state', 'openclaw.sqlite'));
    try {
      lock.exec('BEGIN EXCLUSIVE');
      const pending = read(v.dir, true);
      await new Promise((r) => setTimeout(r, 400));
      lock.exec('COMMIT');
      expect((await pending).map((r) => r.code)).toEqual(['CODE1']);
    } finally { lock.close(); v.done(); }
  });

  // A pairing table made as the test says, in place of the volume's.
  const table = (dir: string, columns: string, rows: string[] = []) => {
    const db = join(dir, 'state', 'openclaw.sqlite');
    rmSync(db);
    const d = new Database(db);
    d.exec(`CREATE TABLE channel_pairing_requests (${columns})`);
    for (const r of rows) d.exec(`INSERT INTO channel_pairing_requests VALUES (${r})`);
    d.close();
  };
  const fileOf = (dir: string, requests: unknown[]) =>
    writeFileSync(join(dir, 'credentials', 'telegram-pairing.json'), JSON.stringify({ version: 1, requests }));

  it('a column renamed that is not read (not the gate\'s) leaves the database read, not taken for nobody knocking (HB-1050)', async () => {
    const v = volume();
    try {
      table(v.dir, 'channel_key TEXT, account_id TEXT, request_id TEXT, code TEXT, created_at TEXT, last_seen_ms INTEGER, meta_json TEXT',
        [`'telegram', 'fambot', '555', 'CODE1', '2026-09-25T01:00:00Z', 1, '{}'`]);
      expect((await read(v.dir, true)).map((r) => r.code)).toEqual(['CODE1']);
    } finally { v.done(); }
  });

  it('2026.7: its table read and empty, or one the query does not fit, and the file answers, strictly too (HB-1050)', async () => {
    const v = volume();
    try {
      // 2026.7 makes the tables but keeps its requests in the file. A table
      // with the columns read (candidate-gate.sh checks them) and no rows:
      table(v.dir, 'channel_key TEXT, account_id TEXT, request_id TEXT, code TEXT, created_at TEXT, meta_json TEXT');
      fileOf(v.dir, [{ id: '42', code: 'FILE1', meta: {} }]);
      expect((await read(v.dir, true)).map((r) => r.code)).toEqual(['FILE1']);
      // One the query does not fit at all is not this version's store, not one that could not be read.
      table(v.dir, 'channel_key TEXT, id TEXT, code TEXT, meta TEXT');
      expect((await read(v.dir, true)).map((r) => r.code)).toEqual(['FILE1']);
      // With nothing in the file it is nobody knocking, not a read that failed.
      fileOf(v.dir, []);
      expect(await read(v.dir, true)).toEqual([]);
    } finally { v.done(); }
  });

  it('HB-1369: no store found (the table gone for a moment, a migration between its steps; or no knock yet) is said, and fails only a read that needs a store', async () => {
    const v = volume();
    const on2 = (dir: string, opts: { strict?: boolean; needsStore?: boolean }) => listPairingRequests(on(dir), 'ref', 'fambot', 'telegram', opts);
    try {
      // The table there, its rows gone, no file: nobody knocking, a store found.
      v.exec('delete from channel_pairing_requests');
      expect(JSON.parse(v.run(pairingListShell('telegram')))).toEqual({ version: 1, requests: [] });
      expect(await on2(v.dir, { strict: true, needsStore: true })).toEqual([]);
      // The table gone, no file: none found.
      v.exec('drop table channel_pairing_requests');
      expect(JSON.parse(v.run(pairingListShell('telegram')))).toEqual({ version: 1, requests: [], none: true });
      await expect(on2(v.dir, { strict: true, needsStore: true })).rejects.toThrow(/could not be read \(no store of them was found\)/);
      // Was: the same as nobody knocking for every read. Every other read still takes it so.
      expect(await on2(v.dir, { strict: true })).toEqual([]);
      expect(await on2(v.dir, {})).toEqual([]);
      // A file read is a store found, though the table is gone.
      fileOf(v.dir, []);
      expect(JSON.parse(v.run(pairingListShell('telegram')))).toEqual({ version: 1, requests: [] });
      // No database and no file: none found.
      rmSync(join(v.dir, 'credentials', 'telegram-pairing.json'));
      rmSync(join(v.dir, 'state', 'openclaw.sqlite'));
      expect(JSON.parse(v.run(pairingListShell('telegram')))).toEqual({ version: 1, requests: [], none: true });
    } finally { v.done(); }
  });

  it('a file that cannot be read fails a strict read on 2026.7, and not beside the database\'s rows on 2026.9 (HB-0033)', async () => {
    const v = volume();
    try {
      writeFileSync(join(v.dir, 'credentials', 'telegram-pairing.json'), '{"version":1,"requests":[{"id":"9",');
      expect((await read(v.dir, true)).map((r) => r.code)).toEqual(['CODE1']);
      v.exec('delete from channel_pairing_requests');
      await expect(read(v.dir, true)).rejects.toThrow(/could not be read \(its file/);
      expect(await read(v.dir, false)).toEqual([]);
    } finally { v.done(); }
  });
});

describe('removing a channel forgets its approvals on the volume (2026-09-25)', () => {
  it('the allow rows, the pending requests and the credentials file for that channel go; the other channel keeps its own', async () => {
    const { store, provider, runtimeRef } = await world();
    provider.execResponses.set('sh-volume', { code: 0, stdout: '3\n', stderr: '' });
    expect(await scrubChannelAllowlist({ store, provider }, { agentId: 'a1', runtimeRef, kind: 'discord', accountId: 'hatchabot' })).toBe(true);
    const script = provider.execLog.find((a) => a[0] === 'sh-volume')![1]!;
    const v = volume();
    try {
      writeFileSync(join(v.dir, 'credentials', 'discord-hatchabot-allowFrom.json'), JSON.stringify({ allowFrom: ['123456789012345678'] }));
      expect(Number(run(v, script).trim())).toBe(3); // 1 allow row, 1 request, 1 file
      expect(v.rows(`select channel_key, entry from channel_pairing_allow_entries order by entry`)).toEqual([{ channel_key: 'telegram', entry: '555' }, { channel_key: 'telegram', entry: '777' }]);
      expect(v.rows(`select channel_key from channel_pairing_requests`)).toEqual([{ channel_key: 'telegram' }]);
      expect(existsSync(join(v.dir, 'credentials', 'discord-hatchabot-allowFrom.json'))).toBe(false);
      expect(run(v, script).trim()).toBe('0'); // twice is fine
    } finally { v.done(); }
    // An account key that is not a plain name never reaches the volume.
    expect(await scrubChannelAllowlist({ store, provider }, { agentId: 'a1', runtimeRef, kind: 'telegram', accountId: 'bad name' })).toBe(false);
  });
});

function run(v: ReturnType<typeof volume>, script: string): string { return v.run(script); }
