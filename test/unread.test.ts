import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { consoleActivity, cronJobOfKey, cronRunsSignature, markQuietTasks, quietTaskIds, sessionsReadShell } from '../src/orchestrator/unread.js';

describe('unread: what counts as console activity', () => {
  it('counts a web console exchange', () => {
    expect(consoleActivity({ 'agent:x:main': { updatedAt: 500, lastChannel: 'webchat' } }, { webOnly: false })).toBe(500);
  });
  it('counts a conversation with no channel recorded', () => {
    expect(consoleActivity({ 'agent:x:main': { updatedAt: 7 } }, { webOnly: true })).toBe(7);
  });
  it('ignores an exchange that went to Telegram (Telegram shows its own unread mark)', () => {
    expect(consoleActivity({ 'agent:x:main': { updatedAt: 900, lastChannel: 'telegram', lastTo: 'telegram:123' } }, { webOnly: false })).toBe(0);
    expect(consoleActivity({ 'agent:x:main': { updatedAt: 900, lastTo: 'telegram:123' } }, { webOnly: false })).toBe(0);
    expect(consoleActivity({ 'agent:x:tg': { lastInteractionAt: 900, origin: { from: 'telegram:5' } } }, { webOnly: false })).toBe(0);
  });
  it('scheduled runs count only for a web-only agent', () => {
    const s = { 'agent:x:cron:abc': { updatedAt: 300 } };
    expect(consoleActivity(s, { webOnly: false })).toBe(0);
    expect(consoleActivity(s, { webOnly: true })).toBe(300);
  });
  it('on an agent with a bot, a quiet task\'s runs count: they went nowhere else (HB-0302)', () => {
    expect(cronJobOfKey('agent:x:cron:abc')).toBe('abc');
    expect(cronJobOfKey('agent:x:cron:abc:run:1700')).toBe('abc');
    expect(cronJobOfKey('agent:x:main')).toBeUndefined();
    const quiet = quietTaskIds(JSON.stringify({ jobs: [{ id: 'abc', delivery: { mode: 'none' } }, { id: 'def', delivery: { mode: 'announce' } }, { id: 'ghi' }] }));
    expect([...quiet!]).toEqual(['abc']);
    expect(quietTaskIds('')).toBeUndefined();
    const s = markQuietTasks({ 'agent:x:cron:abc:run:1': { updatedAt: 300 }, 'agent:x:cron:def': { updatedAt: 400 } }, quiet!);
    expect(consoleActivity(s, { webOnly: false })).toBe(300);
  });
  it('OpenClaw\'s own quiet upkeep (a declared job) is never a quiet task of the owner\'s (HB-0302)', () => {
    const quiet = quietTaskIds(JSON.stringify({ jobs: [
      { id: 'abc', delivery: { mode: 'none' } },
      { id: 'review', declarationKey: 'skill-collection-review', delivery: { mode: 'none' } },
    ] }));
    expect([...quiet!]).toEqual(['abc']);
  });
  it('the scheduled runs\' signature changes only when a task has run again (HB-0302)', () => {
    const sig = cronRunsSignature({ 'agent:x:cron:b:run:1': { updatedAt: 5 }, 'agent:x:cron:a': { updatedAt: 3 }, 'agent:x:cron:b:run:2': { updatedAt: 9 }, 'agent:x:main': { updatedAt: 99 } });
    expect(sig).toBe('a@3,b@9');
    expect(cronRunsSignature({ 'agent:x:main': { updatedAt: 99 } })).toBe('');
    expect(cronRunsSignature({ 'agent:x:cron:b:run:3': { updatedAt: 12 }, 'agent:x:cron:a': { updatedAt: 3 } })).not.toBe(sig);
  });
  it('takes the newest of several and survives junk', () => {
    expect(consoleActivity({ a: { updatedAt: 1 }, b: { lastInteractionAt: 9 }, c: null as never, d: { updatedAt: 'x' as never } }, { webOnly: false })).toBe(9);
    expect(consoleActivity(undefined, { webOnly: false })).toBe(0);
  });
});

describe('a conversation known only by its origin (#58)', () => {
  it('a Telegram-origin record with no lastChannel or lastTo is Telegram\'s, not the console\'s', () => {
    expect(consoleActivity({ 'agent:a:main': { updatedAt: 5, origin: { provider: 'telegram' } } }, { webOnly: false })).toBe(0);
    expect(consoleActivity({ 'agent:a:main': { updatedAt: 5, origin: { provider: 'webchat' } } }, { webOnly: false })).toBe(5);
    expect(consoleActivity({ 'agent:a:main': { updatedAt: 5, origin: { from: 'telegram:4242', provider: 'webchat' } } }, { webOnly: false })).toBe(0);
    expect(consoleActivity({ 'agent:a:main': { updatedAt: 5 } }, { webOnly: false })).toBe(5);
  });
});

describe('reading the session records', () => {
  it('reads the agent SQLite first, the sessions.json an upgrade left behind only when the store has no session table (review, 2026-10-22)', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-unread-both-'));
    try {
      const base = join(root, 'agents', 'to-do-agent');
      mkdirSync(join(base, 'sessions'), { recursive: true });
      mkdirSync(join(base, 'agent'), { recursive: true });
      const sh = () => execFileSync('sh', ['-c', sessionsReadShell('to-do-agent').replaceAll('/home/node/.openclaw', root)], { encoding: 'utf8' });
      expect(sh()).toBe('{}');
      writeFileSync(join(base, 'sessions', 'sessions.json'), JSON.stringify({ 'agent:to-do-agent:main': { updatedAt: 1 } }));
      expect(JSON.parse(sh())).toEqual({ 'agent:to-do-agent:main': { updatedAt: 1 } });
      const file = join(base, 'agent', 'openclaw-agent.sqlite');
      let db = new Database(file);
      db.exec('CREATE TABLE other_things (id TEXT)');
      db.close();
      expect(JSON.parse(sh())).toEqual({ 'agent:to-do-agent:main': { updatedAt: 1 } });
      db = new Database(file);
      db.exec('CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)');
      db.prepare('INSERT INTO session_nodes VALUES (?, ?)').run('agent:to-do-agent:main', JSON.stringify({ updatedAt: 2 }));
      db.close();
      expect(JSON.parse(sh())).toEqual({ 'agent:to-do-agent:main': { updatedAt: 2 } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reads sessions.json or the agent SQLite (2026.8+), never a shell-breaking quote', () => {
    const sh = sessionsReadShell('to-do-agent');
    expect(sh).toContain('/home/node/.openclaw/agents/to-do-agent/sessions/sessions.json');
    expect(sh).toContain('/home/node/.openclaw/agents/to-do-agent/agent/openclaw-agent.sqlite');
    expect(sh).toContain('session_nodes');
    expect(sh).toContain('readOnly:true');
    // No file at all is "no sessions", not the empty answer of a failed read (#99).
    expect(sh).toContain('else printf "{}"; fi');
    const node = sh.slice(sh.indexOf("node -e '") + 9, sh.lastIndexOf("'"));
    expect(node).not.toContain("'");
  });
});

describe('2026.8+ delivery records', () => {
  it('a record delivered nowhere counts for the console; one delivered to an app does not', () => {
    const at = 1_790_000_000_000;
    expect(consoleActivity({ 'agent:a:main': { updatedAt: at, delivery: { kind: 'none' } } }, { webOnly: false })).toBe(at);
    expect(consoleActivity({ 'agent:a:main': { updatedAt: at, delivery: { kind: 'channel', channel: 'telegram' } } }, { webOnly: false })).toBe(0);
    expect(consoleActivity({ 'agent:a:main': { updatedAt: at, delivery: { kind: 'telegram' } } }, { webOnly: false })).toBe(0);
  });
});
