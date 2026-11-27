import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { createConversations, type Conversations } from '../src/orchestrator/conversation/conversations.js';
import { pickAutoRebuilds } from '../src/domain/rebuildPolicy.js';
import type { Agent } from '../src/domain/types.js';
import type { ExecResult } from '../src/providers/provider.js';

/**
 * The conversations service (HB-0808 step 13, HB-0826), driven as the agent
 * list, the sweeps and src/api/chat/conversationRoutes.ts drive it, with no HTTP
 * server: a real store on an in-memory database, and a container that
 * answers its sessions file (and its tasks) as the test says.
 */
const OWNER = 'user-owner', STRANGER = 'user-stranger';
afterEach(() => { vi.useRealTimers(); });

interface World { store: Store; c: Conversations; reads: string[]; sessions: () => ExecResult | Promise<ExecResult>; tasks: () => ExecResult; agent(id: string, o?: Partial<Agent>): Agent }
function world(): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = { store, reads: [] } as unknown as World;
  w.sessions = () => ({ code: 0, stdout: '{}', stderr: '' });
  w.tasks = () => ({ code: 0, stdout: '{"jobs":[]}', stderr: '' });
  const provider = {
    execShell: async (_ref: string, script: string) => {
      if (script.includes('sessions.json')) { w.reads.push('sessions'); return w.sessions(); }
      if (/cron/.test(script)) { w.reads.push('tasks'); return w.tasks(); }
      w.reads.push('other');
      return { code: 1, stdout: '', stderr: '' };
    },
  };
  w.c = createConversations({ store, providerFor: () => provider as never });
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `docker://hatchabot-${id}`, ...o,
    } as unknown as Agent);
    return store.getAgent(id)!;
  };
  return w;
}
const at = (ms: number) => JSON.stringify({ 'agent:main:main': { updatedAt: ms, lastChannel: 'webchat' } });

describe('the sessions read', () => {
  it('is read once, cached, then answered at once and refreshed behind the answer after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = world();
    const a = w.agent('a1');
    w.sessions = () => ({ code: 0, stdout: at(1_700_000_000_000), stderr: '' });
    expect(await w.c.lastActiveFor(a)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(await w.c.lastActiveFor(a)).toBe(new Date(1_700_000_000_000).toISOString());
    expect(w.reads.filter((r) => r === 'sessions')).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000);
    w.sessions = () => ({ code: 0, stdout: at(1_700_000_100_000), stderr: '' });
    // The cached answer first; the refresh lands for the next look.
    expect(await w.c.lastActiveFor(a)).toBe(new Date(1_700_000_000_000).toISOString());
    await new Promise((r) => setImmediate(r));
    expect(await w.c.lastActiveFor(a)).toBe(new Date(1_700_000_100_000).toISOString());
  });

  it('forget makes the next look read afresh; a stopped agent is never read', async () => {
    const w = world();
    const a = w.agent('a1');
    await w.c.sessionsFor(a);
    w.c.forget('a1');
    await w.c.sessionsFor(a);
    expect(w.reads.filter((r) => r === 'sessions')).toHaveLength(2);
    const s = w.agent('a2', { state: 'STOPPED' });
    expect(await w.c.sessionsFor(s)).toBeUndefined();
    expect(w.reads.filter((r) => r === 'sessions')).toHaveLength(2);
  });

  it('a read begun before a forget, finishing after a newer one, does not put its older news back (HB-0895)', async () => {
    const w = world();
    const a = w.agent('a1');
    let finish!: (r: ExecResult) => void;
    w.sessions = () => new Promise<ExecResult>((r) => { finish = r; });
    void w.c.sessionsFor(a); // a slow read
    await new Promise((r) => setImmediate(r));
    const old = finish;
    w.c.forget('a1'); // a turn just ran
    w.sessions = () => ({ code: 0, stdout: at(2000), stderr: '' });
    expect(w.c.newestActivity(await w.c.sessionsFor(a))).toBe(new Date(2000).toISOString());
    old({ code: 0, stdout: at(1000), stderr: '' }); // the old read finishes last
    await new Promise((r) => setImmediate(r));
    expect(w.c.newestActivity(await w.c.sessionsFor(a))).toBe(new Date(2000).toISOString());
  });

  it('a refresh begun before a forget does not fill the cache after it (HB-0895)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = world();
    const a = w.agent('a1');
    w.sessions = () => ({ code: 0, stdout: at(1000), stderr: '' });
    await w.c.sessionsFor(a);
    vi.setSystemTime(Date.now() + 61_000);
    let finish!: (r: ExecResult) => void;
    w.sessions = () => new Promise<ExecResult>((r) => { finish = r; });
    await w.c.sessionsFor(a); // answered from the cache; its refresh is slow
    const old = finish;
    w.c.forget('a1');
    w.sessions = () => ({ code: 0, stdout: at(3000), stderr: '' });
    expect(w.c.newestActivity(await w.c.sessionsFor(a))).toBe(new Date(3000).toISOString());
    old({ code: 0, stdout: at(2000), stderr: '' });
    await new Promise((r) => setImmediate(r));
    expect(w.c.newestActivity(await w.c.sessionsFor(a))).toBe(new Date(3000).toISOString());
  });

  it('a first read that hangs is waited for three seconds, and the list goes on without it', async () => {
    vi.useFakeTimers();
    const w = world();
    const a = w.agent('a1');
    w.sessions = () => new Promise(() => {});
    const look = w.c.lastActiveFor(a);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await look).toBeUndefined();
  });

  it("an agent with a bot has its tasks read only when it has scheduled runs, and again only after one ran", async () => {
    const w = world();
    const a = w.agent('a1');
    w.sessions = () => ({ code: 0, stdout: at(1), stderr: '' });
    await w.c.readSessions(a);
    expect(w.reads).toEqual(['sessions']);
    w.sessions = () => ({ code: 0, stdout: JSON.stringify({ 'agent:a1:cron:job1:run:x': { updatedAt: 5 } }), stderr: '' });
    await w.c.readSessions(a);
    await w.c.readSessions(a);
    expect(w.reads).toEqual(['sessions', 'sessions', 'tasks', 'sessions']);
  });

  it('a deleted agent leaves nothing cached: its sessions and its quiet tasks go, another agent\'s stay (HB-0914)', async () => {
    const w = world();
    const a = w.agent('a1'), b = w.agent('b1');
    const runs = JSON.stringify({ 'agent:x:cron:job1:run:x': { updatedAt: 5 } });
    w.sessions = () => ({ code: 0, stdout: runs, stderr: '' });
    await w.c.sessionsFor(a); await w.c.sessionsFor(b);
    expect(w.reads).toEqual(['sessions', 'tasks', 'sessions', 'tasks']);
    w.c.forgetAgent('a1');
    w.reads.length = 0;
    await w.c.sessionsFor(b); // the other agent's reads are still cached
    expect(w.reads).toEqual([]);
    await w.c.sessionsFor(a); // nothing of a1 was kept: its sessions and its tasks are read again
    expect(w.reads).toEqual(['sessions', 'tasks']);

    // A read under way when the agent is deleted caches nothing when it ends,
    // and a look with the agent as it was before the delete starts none.
    let finish!: (r: ExecResult) => void;
    w.tasks = () => new Promise<ExecResult>((r) => { finish = r; }) as never;
    w.sessions = () => ({ code: 0, stdout: JSON.stringify({ 'agent:x:cron:job1:run:y': { updatedAt: 6 } }), stderr: '' }); // a task ran since
    const late = w.c.readSessions(b);
    await new Promise((r) => setImmediate(r));
    w.c.forgetAgent('b1');
    w.store.setAgentState('b1', 'DELETING');
    finish({ code: 0, stdout: '{"jobs":[]}', stderr: '' });
    await late;
    w.reads.length = 0;
    expect(await w.c.sessionsFor(b)).toBeUndefined();
    expect(w.reads).toEqual([]);
    // Its quiet tasks were not put back: a read with the same runs reads them again.
    w.tasks = () => ({ code: 0, stdout: '{"jobs":[]}', stderr: '' });
    await w.c.readSessions(b);
    expect(w.reads).toEqual(['sessions', 'tasks']);
  });

  it('a read under way when the agent is archived does not put its quiet tasks back (HB-1362 review)', async () => {
    const w = world();
    const a = w.agent('a1');
    const runs = JSON.stringify({ 'agent:x:cron:job1:run:x': { updatedAt: 5 } });
    w.sessions = () => ({ code: 0, stdout: runs, stderr: '' });
    let finish!: (r: ExecResult) => void;
    w.tasks = () => new Promise<ExecResult>((r) => { finish = r; }) as never;
    const late = w.c.readSessions(a);
    await new Promise((r) => setImmediate(r));
    // The archive is done, and forgets what was cached (agentRecords' archive).
    w.store.setAgentState('a1', 'ARCHIVED');
    w.c.forgetAgent('a1');
    finish({ code: 0, stdout: '{"jobs":[]}', stderr: '' });
    await late;
    // Brought back where it was: its tasks are read again, not answered from before the archive.
    w.store.setAgentState('a1', 'PROVISIONING');
    w.store.setAgentState('a1', 'RUNNING');
    w.tasks = () => ({ code: 0, stdout: '{"jobs":[]}', stderr: '' });
    w.reads.length = 0;
    await w.c.readSessions(w.store.getAgent('a1')!);
    expect(w.reads).toEqual(['sessions', 'tasks']);
  });

  it('after a move, its sessions and its quiet tasks are read where it runs now, and a read begun where it ran is never answered (HB-1362)', async () => {
    const w = world();
    w.store.insertHost({ id: 'h2', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'other box', settings: {}, createdAt: 'now' });
    const a = w.agent('a1');
    const runs = JSON.stringify({ 'agent:x:cron:job1:run:x': { updatedAt: 5 } });
    w.sessions = () => ({ code: 0, stdout: runs, stderr: '' });
    await w.c.sessionsFor(a);
    await w.c.sessionsFor(a);
    expect(w.reads).toEqual(['sessions', 'tasks']); // read once, then cached
    w.store.setAgentHost('a1', 'h2');
    w.reads.length = 0;
    await w.c.sessionsFor(w.store.getAgent('a1')!);
    expect(w.reads).toEqual(['sessions', 'tasks']); // nothing of the other machine's was kept
    // A rebuild keeps its place, and its entry: the same volume.
    w.reads.length = 0;
    await w.c.sessionsFor(w.store.getAgent('a1')!);
    expect(w.reads).toEqual([]);

    // A first read under way on the old container, ending after the agent
    // was put somewhere else, does not put the old answer back.
    const b = w.agent('b1');
    let finish!: (r: ExecResult) => void;
    w.sessions = () => new Promise<ExecResult>((r) => { finish = r; });
    void w.c.sessionsFor(b);
    await new Promise((r) => setImmediate(r));
    const old = finish;
    w.store.setAgentRuntimeRef('b1', 'docker://hatchabot-b1-elsewhere');
    const movedB = w.store.getAgent('b1')!;
    w.sessions = () => ({ code: 0, stdout: at(3000), stderr: '' });
    expect(w.c.newestActivity(await w.c.sessionsFor(movedB))).toBe(new Date(3000).toISOString());
    old({ code: 0, stdout: at(1000), stderr: '' });
    await new Promise((r) => setImmediate(r));
    expect(w.c.newestActivity(await w.c.sessionsFor(movedB))).toBe(new Date(3000).toISOString());
  });

  it('activity evidence for an unattended rebuild is read now, never the list\'s cached idle reading (HB-0896)', async () => {
    const w = world();
    const a = w.agent('a1');
    const hourAgo = Date.now() - 3_600_000;
    w.sessions = () => ({ code: 0, stdout: at(hourAgo), stderr: '' });
    await w.c.sessionsFor(a); // the list's poll caches it idle
    w.sessions = () => ({ code: 0, stdout: at(Date.now()), stderr: '' }); // a conversation starts
    const evidence = await w.c.activityEvidence(a);
    expect(evidence).toEqual({ read: true, lastActiveAt: expect.any(String) });
    expect(Date.parse(evidence.lastActiveAt!)).toBeGreaterThan(hourAgo);
    expect(w.reads.filter((r) => r === 'sessions')).toHaveLength(2);
    const candidate = { id: 'a1', state: 'RUNNING' as const, busy: false, need: { level: 'required' as const, reasons: ['made up'] }, lastActiveAt: evidence.lastActiveAt, activityRead: evidence.read };
    expect(pickAutoRebuilds([candidate], 'auto', new Date())).toEqual([]);
    // A read that fails is no evidence, whatever the cache holds.
    w.sessions = () => ({ code: 1, stdout: '', stderr: 'gone' });
    expect(await w.c.activityEvidence(a)).toEqual({ read: false });
  });

  it('activity evidence is strict: a failed read is not "nothing said"', async () => {
    const w = world();
    const a = w.agent('a1');
    w.sessions = () => ({ code: 1, stdout: '', stderr: 'gone' });
    expect(await w.c.activityEvidence(a)).toEqual({ read: false });
    w.sessions = () => ({ code: 0, stdout: '', stderr: '' });
    w.c.forget('a1');
    expect(await w.c.activityEvidence(a)).toEqual({ read: true, lastActiveAt: undefined });
  });
});

describe('the unread mark and Recent', () => {
  it('a first look starts from now; later console activity is unread until seen; a stranger sees none', async () => {
    const w = world();
    const a = w.agent('a1');
    w.sessions = () => ({ code: 0, stdout: at(Date.now() + 60_000), stderr: '' });
    expect(await w.c.unreadFor(a, OWNER)).toBe(false);
    expect(w.store.getAgentSeen(OWNER, 'a1')).toBeTypeOf('number');
    expect(await w.c.unreadFor(a, OWNER)).toBe(true);
    w.store.setAgentSeen(OWNER, 'a1', Date.now() + 120_000);
    expect(await w.c.unreadFor(a, OWNER)).toBe(false);
    expect(await w.c.unreadFor(a, STRANGER)).toBe(false);
    expect(w.store.getAgentSeen(STRANGER, 'a1')).toBeUndefined();
  });

  it("lists the agents this person can open, with the owner's alerts, and nobody else's agents", async () => {
    const w = world();
    w.agent('a1');
    w.agent('a2', { state: 'FAILED' } as Partial<Agent>);
    w.agent('a3', { state: 'ARCHIVED' } as Partial<Agent>);
    // a1 is read live; a2 is not running, so its stored line's time is used.
    w.sessions = () => ({ code: 0, stdout: at(Date.now() - 60_000), stderr: '' });
    for (const id of ['a2', 'a3']) w.store.setAgentRecent(id, { lastActiveAt: Date.now() - 120_000, sessions: {} });
    const mine = await w.c.recent(OWNER, true);
    expect(mine.cap).toBeGreaterThan(0);
    const rows = mine.items as Array<{ id: string; by?: string; line?: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual(['a1', 'a2']);
    expect(rows.find((r) => r.id === 'a2')).toMatchObject({ by: 'needs-you', line: expect.stringContaining('it failed') });
    expect((await w.c.recent(STRANGER, true)).items).toEqual([]);
  });
});
