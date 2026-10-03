import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanPreview, keysToRead, mergeRecent, orderRecent, parseRecentRead, previewFor, previewLine,
  RECENT_SCRIPT, recentReadShell, RecentTracker, type RecentPeople, type RecentRecord,
} from '../src/orchestrator/recent.js';

const NOW = 1_790_000_000_000;
const MIN = 60_000;
const DAY = 86_400_000;
const MARK = '⟦openclaw:ctx⟧';
const FENCE = '`'.repeat(3);

/** A Telegram message as OpenClaw 2026.9 stores it: the inbound context, then the text. */
const fromTelegram = (id: string, name: string, text: string) =>
  `[Sat 2026-10-03 09:00 EDT] Conversation info: ${MARK}\n${FENCE}json\n${JSON.stringify({ chat_id: `telegram:${id}`, message_id: '42', sender: { id, name, username: 'made_up' } }, null, 2)}\n${FENCE}\n\n${text}`;

describe('ordering: the home screen and Show all', () => {
  const row = (id: string, agoMin: number, unread = false) => ({ id, at: NOW - agoMin * MIN, unread });
  it('unread first, then newest first, at most eight, only the last seven days', () => {
    const rows = [
      row('a', 2), row('b', 14, true), row('c', 60), row('d', 180), row('e', 60 * 24), row('f', 5, true),
      row('g', 300), row('h', 400), row('i', 500), row('j', 600), row('old', 8 * 24 * 60), row('never', 0),
    ];
    rows.find((r) => r.id === 'never')!.at = 0;
    const out = orderRecent(rows, { now: NOW }).map((r) => r.id);
    expect(out).toEqual(['f', 'b', 'a', 'c', 'd', 'g', 'h', 'i']);
    expect(out).toHaveLength(8);
  });
  it('Show all: every agent active in the week, newest first, unread not lifted', () => {
    const rows = [row('a', 2), row('b', 14, true), row('old', 8 * 24 * 60), row('c', 60 * 24 * 6)];
    expect(orderRecent(rows, { now: NOW, all: true }).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('the edge of the window counts; a minute past it does not', () => {
    expect(orderRecent([{ id: 'x', at: NOW - 7 * DAY, unread: false }], { now: NOW })).toHaveLength(1);
    expect(orderRecent([{ id: 'x', at: NOW - 7 * DAY - MIN, unread: false }], { now: NOW })).toHaveLength(0);
  });
});

describe('cleaning a line', () => {
  it('strips markdown, the web-app marker, control and direction characters, and cuts to ~120 on a word', () => {
    expect(cleanPreview('## Booked **Thursday** at [Pasta Place](https://example.com/x)\n- 12:30\u0007')).toBe('Booked Thursday at Pasta Place 12:30');
    expect(cleanPreview('[Sam via the web app]\nthanks')).toBe('thanks');
    expect(cleanPreview('a ‮gnirts‬ b')).toBe('a gnirts b');
    expect(cleanPreview('`code` and _it_ and ~~gone~~ > quoted')).toBe('code and it and gone > quoted');
    const long = cleanPreview('word '.repeat(60));
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith('…')).toBe(true);
    expect(cleanPreview('x'.repeat(300)).length).toBe(120);
  });
});

describe('the in-container reader', () => {
  const ev = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'message', timestamp: '2026-10-03T13:00:00.000Z', message: { role, content, ...extra } });
  const run = (root: string, keys: string[]) => {
    // The real shell line, with the tests' agents directory.
    const out = execFileSync('sh', ['-c', recentReadShell('kitchen', keys)], { env: { ...process.env, AGENTS_DIR: root }, encoding: 'utf8' });
    expect(out.startsWith('{"v":1,')).toBe(true);
    return parseRecentRead(out);
  };

  it('2026.7 (.jsonl): the last line of each named conversation, its sender, the task that ran; nothing else read', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-recent-jsonl-'));
    try {
      const sd = join(root, 'kitchen', 'sessions');
      mkdirSync(sd, { recursive: true });
      writeFileSync(join(sd, 'sessions.json'), JSON.stringify({
        'agent:kitchen:main': { sessionId: 's-main', updatedAt: NOW },
        'agent:kitchen:cron:job1': { sessionId: 's-cron', updatedAt: NOW },
        'agent:kitchen:telegram:direct:777': { sessionId: 's-tg', updatedAt: NOW },
        'agent:kitchen:other': { sessionId: 's-other', updatedAt: NOW },
      }));
      writeFileSync(join(sd, 's-main.jsonl'), [
        JSON.stringify({ type: 'session', id: 's-main' }),
        ev('user', 'what is for lunch?'),
        ev('assistant', [{ type: 'text', text: 'Booked Thursday at Pasta Place' }, { type: 'toolCall', name: 'x' }]),
        ev('assistant', [{ type: 'toolCall', name: 'x' }]),
        ev('user', 'A background task completed.', { provenance: { kind: 'inter_session' } }),
        ev('assistant', 'NO_REPLY'),
      ].join('\n'));
      writeFileSync(join(sd, 's-cron.jsonl'), [
        ev('user', '[cron:job1 Daily brief] Write the brief'),
        ev('assistant', 'Here is your brief'),
      ].join('\n'));
      writeFileSync(join(sd, 's-tg.jsonl'), ev('user', fromTelegram('777', 'Alex', 'can you check the oven?')));
      writeFileSync(join(sd, 's-other.jsonl'), ev('user', 'never asked for'));
      const out = run(root, ['agent:kitchen:main', 'agent:kitchen:cron:job1', 'agent:kitchen:telegram:direct:777', 'agent:kitchen:missing']);
      expect(out['agent:kitchen:main']).toEqual({ role: 'assistant', text: 'Booked Thursday at Pasta Place' });
      expect(out['agent:kitchen:cron:job1']).toEqual({ role: 'assistant', text: 'Here is your brief', task: 'Daily brief' });
      expect(out['agent:kitchen:telegram:direct:777']).toEqual({ role: 'user', text: 'can you check the oven?', senderId: '777', senderName: 'Alex' });
      expect(out['agent:kitchen:other']).toBeUndefined();
      expect(out['agent:kitchen:missing']).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('2026.9 (SQLite): reads the current window, newest event first; a task prompt in the main conversation counts as the task', () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-recent-db-'));
    try {
      mkdirSync(join(root, 'kitchen', 'agent'), { recursive: true });
      const db = new Database(join(root, 'kitchen', 'agent', 'openclaw-agent.sqlite'));
      db.exec(`CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL, entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, updated_at INTEGER);
        CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, created_at INTEGER NOT NULL, event_zstd BLOB, PRIMARY KEY (session_id, seq));`);
      db.prepare('INSERT INTO session_nodes VALUES (?, ?, ?, ?)').run('agent:kitchen:main', 'w2', '{}', NOW);
      db.prepare('INSERT INTO session_nodes VALUES (?, ?, ?, ?)').run('agent:kitchen:guest:0123456789abcdef', 'g1', '{}', NOW);
      const put = db.prepare('INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, 0)');
      put.run('w1', 1, ev('assistant', 'an older window'));
      put.run('w2', 1, ev('user', '[cron:j9 Plant check] water the plants?'));
      put.run('w2', 2, ev('assistant', 'Watered'));
      put.run('g1', 1, ev('user', 'my own question'));
      db.close();
      const out = run(root, ['agent:kitchen:main', 'agent:kitchen:guest:0123456789abcdef']);
      expect(out['agent:kitchen:main']).toEqual({ role: 'assistant', text: 'Watered', task: 'Plant check' });
      expect(out['agent:kitchen:guest:0123456789abcdef']).toEqual({ role: 'user', text: 'my own question' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the shell carries the keys base64, never in the clear', () => {
    const sh = recentReadShell('kitchen', ["agent:kitchen:x'; rm -rf /"]);
    expect(sh).not.toContain('rm -rf');
    expect(() => recentReadShell("bad'slug", [])).toThrow();
    expect(RECENT_SCRIPT).toContain('readOnly: true');
  });

  it('junk output reads as nothing', () => {
    expect(parseRecentRead('not json')).toEqual({});
    expect(parseRecentRead(JSON.stringify({ v: 2, s: {} }))).toEqual({});
    expect(parseRecentRead(JSON.stringify({ v: 1, s: { k: { role: 'system', text: 'x' }, j: { role: 'user', text: 5 } } }))).toEqual({});
  });
});

describe('capture: reading only what moved', () => {
  const sessions = {
    'agent:k:main': { updatedAt: NOW - 2 * MIN },
    'agent:k:cron:a': { updatedAt: NOW - 3 * DAY },
    'agent:k:old': { updatedAt: NOW - 9 * DAY },
    'agent:k:subagent:x': { updatedAt: NOW - MIN },
  };
  it('first look reads the conversations of the week (no sub-agent runs); a second with nothing new reads none', () => {
    const keys = keysToRead(sessions, undefined, NOW);
    expect(keys).toEqual(['agent:k:main', 'agent:k:cron:a']);
    const rec = mergeRecent(undefined, sessions, { 'agent:k:main': { role: 'assistant', text: 'hi **there**' } }, keys, NOW);
    expect(rec.sessions['agent:k:main']).toEqual({ at: NOW - 2 * MIN, role: 'assistant', text: 'hi there' });
    // Read but nothing to show: remembered as empty, so it is not read again.
    expect(rec.sessions['agent:k:cron:a']).toEqual({ at: NOW - 3 * DAY, role: 'assistant', text: '' });
    expect(keysToRead(sessions, rec, NOW)).toEqual([]);
    expect(keysToRead({ ...sessions, 'agent:k:main': { updatedAt: NOW } }, rec, NOW)).toEqual(['agent:k:main']);
  });
  it('drops conversations that are gone or past the week, and keeps the newest activity', () => {
    const prev: RecentRecord = { lastActiveAt: NOW - DAY, sessions: { 'agent:k:gone': { at: NOW - MIN, role: 'assistant', text: 'x' }, 'agent:k:main': { at: NOW - 8 * DAY, role: 'assistant', text: 'y' } } };
    const rec = mergeRecent(prev, { 'agent:k:main': { updatedAt: NOW - 8 * DAY } }, {}, [], NOW);
    expect(rec.sessions).toEqual({});
    expect(rec.lastActiveAt).toBe(NOW - DAY);
  });
});

describe('what each person is shown', () => {
  const OWNER = 'owner-1', GUEST = 'guest-1', OTHER_GUEST = 'guest-2', MEMBER = 'member-1';
  const GKEY = 'agent:k:guest:0123456789abcdef', OKEY = 'agent:k:guest:fedcba9876543210';
  const people: RecentPeople = {
    byChannelId: new Map([['111', { userId: OWNER }], ['222', { userId: MEMBER, name: 'Robin' }]]),
    byKey: new Map([[GKEY, { userId: GUEST, name: 'Sam' }], [OKEY, { userId: OTHER_GUEST, name: 'Kai' }]]),
  };
  const rec = (lines: RecentRecord['sessions']): RecentRecord => ({ lastActiveAt: NOW, sessions: lines });
  const owner = { kind: 'owner' as const, userId: OWNER };
  const guest = { kind: 'guest' as const, userId: GUEST, keys: [GKEY] };
  const member = { kind: 'none' as const, userId: MEMBER };

  it('owner: the newest conversation, the agent speaking with no prefix', () => {
    const r = rec({ 'agent:k:main': { at: NOW, role: 'assistant', text: 'Booked Thursday' }, [GKEY]: { at: NOW - MIN, role: 'user', text: 'hey' } });
    const p = previewFor(r, owner, people);
    expect(previewLine(p)).toBe('Booked Thursday');
  });
  it('owner: their own console line is "You:", a member\'s Telegram line carries the member\'s name', () => {
    expect(previewLine(previewFor(rec({ 'agent:k:main': { at: NOW, role: 'user', text: 'thanks' } }), owner, people))).toBe('You: thanks');
    expect(previewLine(previewFor(rec({ 'agent:k:main': { at: NOW, role: 'user', text: 'thanks', senderId: '111' } }), owner, people))).toBe('You: thanks');
    expect(previewLine(previewFor(rec({ 'agent:k:main': { at: NOW, role: 'user', text: 'hello', senderId: '222', senderName: 'R' } }), owner, people))).toBe('Robin: hello');
    expect(previewLine(previewFor(rec({ 'agent:k:main': { at: NOW, role: 'user', text: 'hello', senderId: '999', senderName: 'Pat' } }), owner, people))).toBe('Pat: hello');
  });
  it('owner reads a guest\'s conversation as its console does, under the guest\'s name', () => {
    expect(previewLine(previewFor(rec({ [GKEY]: { at: NOW, role: 'user', text: 'hi there' } }), owner, people))).toBe('Sam: hi there');
  });
  it('guest: only their own conversation, their own line as "You:" — never the owner\'s or another guest\'s', () => {
    const r = rec({
      'agent:k:main': { at: NOW, role: 'assistant', text: 'owner secret' },
      [OKEY]: { at: NOW - MIN, role: 'user', text: 'other guest secret' },
      [GKEY]: { at: NOW - 5 * MIN, role: 'user', text: 'my question' },
    });
    expect(previewLine(previewFor(r, guest, people))).toBe('You: my question');
    expect(previewFor(rec({ 'agent:k:main': { at: NOW, role: 'assistant', text: 'owner secret' } }), guest, people)).toBeUndefined();
  });
  it('a member who cannot open the chat here sees no preview at all', () => {
    expect(previewFor(rec({ 'agent:k:main': { at: NOW, role: 'user', text: 'hello', senderId: '222' } }), member, people)).toBeUndefined();
  });
  it('a personal conversation nobody can place shows nothing, rather than a guess', () => {
    expect(previewFor(rec({ 'agent:k:guest:aaaaaaaaaaaaaaaa': { at: NOW, role: 'user', text: 'who?' } }), owner, people)).toBeUndefined();
  });
  it('a scheduled task: "⏰ <name> ran"; Needs you wins over everything', () => {
    const r = rec({ 'agent:k:cron:j': { at: NOW, role: 'assistant', text: 'brief', task: 'Daily brief' } });
    expect(previewLine(previewFor(r, owner, people))).toBe('⏰ Daily brief ran');
    expect(previewLine(previewFor(r, owner, people), 'waiting for a Telegram bot token')).toBe('needs you: waiting for a Telegram bot token');
    expect(previewLine(undefined)).toBe('');
  });
  it('an empty line (nothing to show) gives way to the next conversation', () => {
    const r = rec({ 'agent:k:main': { at: NOW, role: 'assistant', text: '' }, 'agent:k:x': { at: NOW - MIN, role: 'assistant', text: 'earlier' } });
    expect(previewLine(previewFor(r, owner, people))).toBe('earlier');
  });
});

describe('the tracker', () => {
  const make = (stdout: string) => {
    const db = new Map<string, unknown>();
    const exec = vi.fn(async () => ({ code: 0, stdout }));
    const t = new RecentTracker({ get: (id) => db.get(id), set: (id, r) => db.set(id, r), exec, now: () => NOW });
    return { t, db, exec };
  };
  it('one exec when a conversation moved, none when nothing did', async () => {
    const { t, exec } = make(JSON.stringify({ v: 1, s: { 'agent:k:main': { role: 'assistant', text: 'hello' } } }));
    const s = { 'agent:k:main': { updatedAt: NOW - MIN } };
    await t.note({ id: 'a1', slug: 'k' }, s);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(t.record('a1')?.sessions['agent:k:main']?.text).toBe('hello');
    await t.note({ id: 'a1', slug: 'k' }, s);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('a failed read marks nothing as read', async () => {
    const { t, exec } = make('');
    await t.note({ id: 'a1', slug: 'k' }, { 'agent:k:main': { updatedAt: NOW - MIN } });
    expect(t.record('a1')).toBeUndefined();
    await t.note({ id: 'a1', slug: 'k' }, { 'agent:k:main': { updatedAt: NOW - MIN } });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
