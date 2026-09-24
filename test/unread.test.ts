import { describe, expect, it } from 'vitest';
import { consoleActivity, sessionsReadShell } from '../src/orchestrator/unread.js';

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
  it('takes the newest of several and survives junk', () => {
    expect(consoleActivity({ a: { updatedAt: 1 }, b: { lastInteractionAt: 9 }, c: null as never, d: { updatedAt: 'x' as never } }, { webOnly: false })).toBe(9);
    expect(consoleActivity(undefined, { webOnly: false })).toBe(0);
  });
});

describe('reading the session records', () => {
  it('prefers sessions.json and falls back to the agent SQLite (2026.8+), never a shell-breaking quote', () => {
    const sh = sessionsReadShell('to-do-agent');
    expect(sh).toContain('/home/node/.openclaw/agents/to-do-agent/sessions/sessions.json');
    expect(sh).toContain('/home/node/.openclaw/agents/to-do-agent/agent/openclaw-agent.sqlite');
    expect(sh).toContain('session_nodes');
    expect(sh).toContain('readOnly:true');
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
