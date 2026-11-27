import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Readable } from 'node:stream';
import { Store } from '../src/store/store.js';
import { createFiles, type Files } from '../src/orchestrator/files/files.js';
import { TurnRefused } from '../src/orchestrator/files/coreFileTurns.js';
import { cleanRelPath } from '../src/orchestrator/files/agentFiles.js';
import { AgentBusyError, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import type { Agent } from '../src/domain/types.js';
import type { ExecResult } from '../src/providers/provider.js';

/**
 * The agent files service (HB-0808 step 13): its core-files turn, its core
 * files read and saved, and its home browsed, checked for a download and
 * uploaded to, driven as src/api/data/fileRoutes.ts drives them but with no HTTP
 * server. A real store on an in-memory database and a provider that answers
 * each one-shot as the test says.
 */
const OWNER = 'user-owner';

interface World {
  store: Store;
  files: Files;
  /** Every shell script run in the agent, in order. */
  shells: string[];
  /** What a core-file read answers (execShell), and a one-shot on the volume. */
  shell: (script: string) => ExecResult;
  volume: (script: string) => ExecResult;
  writes: Array<{ argv: string[]; body: string }>;
  write: () => ExecResult;
  archiving: Set<string>;
  agent(id: string, o?: { state?: Agent['state'] }): Agent;
}
const made: World[] = [];
afterEach(() => {
  for (const w of made.splice(0)) w.files.stop();
  vi.useRealTimers();
});

function world(opts: { streams?: boolean; uploads?: boolean } = {}): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = {
    store, shells: [], writes: [], archiving: new Set<string>(),
    shell: () => ({ code: 0, stdout: 'notes\n', stderr: '' }),
    volume: () => ({ code: 0, stdout: '', stderr: '' }),
    write: () => ({ code: 0, stdout: '', stderr: '' }),
  } as unknown as World;
  const provider = {
    execShell: async (_ref: string, script: string) => { w.shells.push(script); return w.shell(script); },
    execShellOnVolume: async (_ref: string, script: string) => { w.shells.push(script); return w.volume(script); },
    ...(opts.streams === false ? {} : { streamFromVolume: () => Readable.from([Buffer.from('bytes')]) }),
    ...(opts.uploads === false ? {} : { writeToVolume: async (_ref: string, argv: string[], body: Buffer) => { w.writes.push({ argv, body: body.toString('utf8') }); return w.write(); } }),
  };
  w.files = createFiles({
    store,
    providerFor: (hostId) => { if (hostId !== 'h1') throw new Error(`no host ${hostId}`); return provider as never; },
    trace: () => () => {},
    agentGone: (id) => { const s = store.getAgent(id)?.state; return !s || s === 'DELETED' || s === 'DELETING'; },
    isArchiving: (id) => w.archiving.has(id),
    fileMaxBytes: 1024,
  });
  made.push(w);
  w.agent = (id, o = {}) => {
    store.insertAgent({
      id, ownerId: OWNER, name: `Agent ${id}`, slug: id, state: o.state ?? 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: `docker://hatchabot-${id}`,
    } as unknown as Agent);
    return store.getAgent(id)!;
  };
  return w;
}

/** A promise and the function that settles it, to hold a turn open. */
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

describe('the core-files turn', () => {
  it('serializes two callers of one agent, and leaves another agent free', async () => {
    const w = world();
    const order: string[] = [];
    const first = gate();
    const a = w.files.turns.withCoreFilesTurn('a1', async () => { order.push('a start'); await first.p; order.push('a end'); });
    const b = w.files.turns.withAgentsMdTurn('a1', async () => { order.push('b'); });
    const other = w.files.turns.withCoreFilesTurn('a2', async () => { order.push('other'); });
    await other;
    expect(order).toEqual(['a start', 'other']);
    first.open();
    await Promise.all([a, b]);
    // The AGENTS.md writer waits in the same queue as the change before it.
    expect(order).toEqual(['a start', 'other', 'a end', 'b']);
  });

  it('refuses a change whose turn did not come in time, and it never runs', async () => {
    const w = world();
    const held = gate();
    const first = w.files.turns.withCoreFilesTurn('a1', () => held.p);
    let ran = false;
    const late = w.files.turns.withCoreFilesTurn('a1', async () => { ran = true; }, 20);
    await expect(late).rejects.toBeInstanceOf(AgentBusyError);
    await expect(late).rejects.toThrow('Another change to its files is still running; try again when it ends.');
    held.open();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(false);
  });

  it('stop() refuses every change still waiting, as its deadline would, and none runs', async () => {
    const w = world();
    const held = gate();
    const first = w.files.turns.withCoreFilesTurn('a1', () => held.p);
    let ran = false;
    const waiting = w.files.turns.withCoreFilesTurn('a1', async () => { ran = true; });
    await new Promise((r) => setTimeout(r, 0)); // the first has its turn
    w.files.stop();
    await expect(waiting).rejects.toBeInstanceOf(AgentBusyError);
    held.open();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(false);
  });

  it('freshRunning reads the agent at its turn: deleted is a 404, stopped its own words', () => {
    const w = world();
    w.agent('a1', { state: 'STOPPED' });
    expect(() => w.files.turns.freshRunning('a1', (a) => `not running (${a.state})`)).toThrow(new TurnRefused(409, 'not running (STOPPED)'));
    try { w.files.turns.freshRunning('gone', () => 'x'); } catch (err) { expect(err).toMatchObject({ status: 404, message: 'It was deleted.' }); }
  });
});

describe('core files', () => {
  it('reads one, tells a missing file from an empty one, and words a failed read', async () => {
    const w = world();
    const a = w.agent('a1');
    expect(await w.files.core.read(a, 'SOUL.md')).toEqual({ ok: true, body: { name: 'SOUL.md', content: 'notes\n' } });
    w.shell = () => ({ code: 3, stdout: '', stderr: 'boom' });
    const failed = await w.files.core.read(a, 'SOUL.md');
    expect(failed.ok).toBe(false);
    expect(failed).toMatchObject({ status: 502 });
    expect((failed as { error: string }).error).toMatch(/Nothing was loaded\.$/);
  });

  it('saves one in its turn, a snapshot first, and keeps the template layer in step', async () => {
    const w = world();
    const a = w.agent('a1');
    w.store.setAgentParamFile('a1', 'soul', 'old {{x}}');
    const r = await w.files.core.save(a, 'SOUL.md', 'new text');
    expect(r).toEqual({ ok: true, body: { saved: true } });
    expect(w.shells.some((s) => s.includes('base64'))).toBe(true);
    expect(w.store.getAgent('a1')!.paramFiles?.soul).toBe('new text');
  });

  it('refuses a save when the agent was stopped while it waited, or is busy', async () => {
    const w = world();
    const a = w.agent('a1');
    w.store.setAgentState('a1', 'STOPPED');
    expect(await w.files.core.save(a, 'SOUL.md', 'x')).toEqual({ ok: false, status: 409, error: 'Start the agent to edit its files.' });
    w.store.setAgentState('a1', 'RUNNING');
    markBusy('a1');
    const busy = await w.files.core.save(a, 'SOUL.md', 'x');
    expect(busy).toMatchObject({ ok: false, status: 409 });
  });
});

describe("the agent's home", () => {
  it('the route cleans a path: no .., no absolute path leaves the home', () => {
    expect(cleanRelPath('../etc')).toBeUndefined();
    expect(cleanRelPath('a/../../b')).toBeUndefined();
    expect(cleanRelPath(5)).toBeUndefined();
    expect(cleanRelPath('/workspace/notes')).toBe('workspace/notes');
  });

  it('lists a folder, and words what the one-shot found', async () => {
    const w = world();
    const a = w.agent('a1');
    w.volume = () => ({ code: 0, stdout: 'f\t5\t1700000000\tnotes.md\0', stderr: '' });
    const listed = await w.files.home.list(a, 'workspace');
    expect(listed.ok && listed.body.path).toBe('workspace');
    expect(listed.ok && listed.body.entries.map((e) => e.name)).toEqual(['notes.md']);
    for (const [code, status, error] of [[2, 404, 'No such file or folder.'], [3, 400, 'That path leads outside the agent.'], [4, 400, 'Not that kind of path.'], [9, 502, "Couldn't read the agent's files."]] as const) {
      w.volume = () => ({ code, stdout: '', stderr: '' });
      expect(await w.files.home.list(a, 'x')).toEqual({ ok: false, status, error });
    }
  });

  it('checks a download before a byte streams: the machine, the kind and the size', async () => {
    const w = world();
    const a = w.agent('a1');
    w.volume = () => ({ code: 0, stdout: 'regular file\t5', stderr: '' });
    const ok = await w.files.home.readable(a, 'notes.md', 'file');
    expect(ok.ok && ok.size).toBe(5);
    w.volume = () => ({ code: 0, stdout: 'directory\t5', stderr: '' });
    expect(await w.files.home.readable(a, 'dir', 'file')).toEqual({ ok: false, status: 400, error: 'That is a folder — download it as an archive.' });
    w.volume = () => ({ code: 0, stdout: '2048', stderr: '' });
    expect(await w.files.home.readable(a, 'dir', 'archive')).toMatchObject({ ok: false, status: 413 });
    const noStream = world({ streams: false });
    expect(await noStream.files.home.readable(noStream.agent('a1'), 'x', 'file')).toEqual({ ok: false, status: 501, error: 'Downloads are not available from this machine.' });
  });

  it('uploads in the turn, keeps a core file layer, and refuses one moved or archived meanwhile', async () => {
    const w = world();
    const a = w.agent('a1');
    w.store.setAgentParamFile('a1', 'agents', 'old');
    w.write = () => ({ code: 0, stdout: 'hatchabot:core\n', stderr: '' });
    const owned = (id: string) => w.store.getAgent(id);
    const r = await w.files.home.upload(a, '.openclaw/agents/a1/agent', 'AGENTS.md', Buffer.from('fresh'), { overwrite: true, owned });
    expect(r).toEqual({ ok: true, body: { ok: true, path: '.openclaw/agents/a1/agent', name: 'AGENTS.md', size: 5 } });
    expect(w.writes[0]!.body).toBe('fresh');
    expect(w.store.getAgent('a1')!.paramFiles?.agents).toBe('fresh');

    w.write = () => ({ code: 5, stdout: '', stderr: '' });
    expect(await w.files.home.upload(a, 'inbox', 'n.txt', Buffer.from('x'), { overwrite: false, owned })).toEqual({ ok: false, status: 409, error: 'n.txt is already there — replace it?' });

    w.archiving.add('a1');
    expect(await w.files.home.upload(a, 'inbox', 'n.txt', Buffer.from('x'), { overwrite: true, owned })).toEqual({ ok: false, status: 409, error: 'Another change is under way — wait for it to finish.' });
    w.archiving.clear();
    expect(await w.files.home.upload({ ...a, runtimeRef: 'docker://elsewhere' }, 'inbox', 'n.txt', Buffer.from('x'), { overwrite: true, owned }))
      .toEqual({ ok: false, status: 409, error: 'The agent moved meanwhile; reload its files and try again.' });
    expect(await w.files.home.upload(a, 'inbox', 'n.txt', Buffer.from('x'), { overwrite: true, owned: () => undefined })).toEqual({ ok: false, status: 404, error: 'Not found' });
    const noUploads = world({ uploads: false });
    const b = noUploads.agent('a2');
    expect(await noUploads.files.home.upload(b, 'inbox', 'n.txt', Buffer.from('x'), { overwrite: true, owned: (id) => noUploads.store.getAgent(id) }))
      .toEqual({ ok: false, status: 501, error: 'Uploads are not available to this machine.' });
  });

  it('an upload waits for a core-file change under way', async () => {
    const w = world();
    const a = w.agent('a1');
    const held = gate();
    const before = w.files.turns.withCoreFilesTurn('a1', () => held.p);
    const upload = w.files.home.upload(a, 'inbox', 'n.txt', Buffer.from('x'), { overwrite: true, owned: (id) => w.store.getAgent(id) });
    await new Promise((r) => setTimeout(r, 10));
    expect(w.writes).toHaveLength(0);
    held.open();
    await before;
    expect((await upload).ok).toBe(true);
    expect(w.writes).toHaveLength(1);
  });
});
