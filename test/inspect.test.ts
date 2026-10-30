import { describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { InspectReadError, listInspectableFiles, readInspectableFile, readTranscript, utf8Prefix } from '../src/orchestrator/inspect.js';
import type { RuntimeProvider } from '../src/providers/provider.js';

/**
 * Read-only volume inspection for archived agents. A script-aware fake
 * provider stands in for execShellOnVolume so each distinct read (list,
 * file body, transcript pick/tail) can be asserted independently.
 */

function fakeProvider(respond: (script: string) => string, code = 0): RuntimeProvider {
  return {
    async execShellOnVolume(_ref: string, script: string) {
      return { code, stdout: respond(script), stderr: '' };
    },
  } as unknown as RuntimeProvider;
}

describe('a read that fails is not an empty one (#151)', () => {
  it('the listing, a file and the transcript each fail with the reason', async () => {
    const down = fakeProvider(() => '', 125); // the one-shot never ran
    await expect(listInspectableFiles(down, 'docker://x', 'x')).rejects.toBeInstanceOf(InspectReadError);
    await expect(readInspectableFile(down, 'docker://x', 'x', 'MEMORY.md')).rejects.toBeInstanceOf(InspectReadError);
    await expect(readTranscript(down, 'docker://x', 'x')).rejects.toBeInstanceOf(InspectReadError);
  });

  it('a file that is not there is null (404), not empty content', async () => {
    expect(await readInspectableFile(fakeProvider(() => '', 3), 'docker://x', 'x', 'USER.md')).toBeNull();
  });
});

describe('listInspectableFiles', () => {
  it('returns only known files that exist, with byte sizes', async () => {
    const p = fakeProvider((s) => {
      // `wc -c` output per existing file; MEMORY + SOUL exist, others missing.
      let out = '';
      if (s.includes('MEMORY.md')) out += '  4096 /home/node/.openclaw/agents/x/agent/MEMORY.md\n';
      if (s.includes('SOUL.md')) out += '  1200 /home/node/.openclaw/agents/x/agent/SOUL.md\n';
      return out;
    });
    const files = await listInspectableFiles(p, 'docker://x', 'x');
    expect(files).toEqual([
      { name: 'MEMORY.md', bytes: 4096 },
      { name: 'SOUL.md', bytes: 1200 },
    ]);
  });
});

describe('readInspectableFile', () => {
  it('reads a known file; refuses an unknown one', async () => {
    const p = fakeProvider(() => '# Memory\nWe discussed the Boston conference, Oct 3-5.\n');
    const f = await readInspectableFile(p, 'docker://x', 'x', 'MEMORY.md');
    expect(f?.content).toContain('Boston conference');
    expect(f?.truncated).toBe(false);
    expect(await readInspectableFile(p, 'docker://x', 'x', 'openclaw.json')).toBeNull();
  });

  it('flags truncation past the cap', async () => {
    const big = 'x'.repeat(256 * 1024 + 50);
    const p = fakeProvider(() => big);
    const f = await readInspectableFile(p, 'docker://x', 'x', 'AGENTS.md');
    expect(f?.truncated).toBe(true);
    expect(Buffer.byteLength(f!.content, 'utf8')).toBe(256 * 1024);
  });

  it('a cut in the middle of a character ends before it, not on a replacement character (#152)', async () => {
    const MAX = 256 * 1024;
    // What head -c MAX+1 hands back: the euro sign's first two bytes, decoded.
    const p = fakeProvider(() => Buffer.from('x'.repeat(MAX - 1) + '€€', 'utf8').subarray(0, MAX + 1).toString('utf8'));
    const f = await readInspectableFile(p, 'docker://x', 'x', 'MEMORY.md');
    expect(f?.truncated).toBe(true);
    expect(f!.content).toBe('x'.repeat(MAX - 1));
    expect(utf8Prefix(Buffer.from('a€b'), 2)).toBe('a');
    expect(utf8Prefix(Buffer.from('a€b'), 4)).toBe('a€');
    expect(utf8Prefix(Buffer.from('a😀'), 4)).toBe('a');
  });
});

describe('readTranscript', () => {
  // OpenClaw's real shape: {type:'message', message:{role, content}}.
  const SESSION = [
    { type: 'session', version: 1, timestamp: '2026-08-27T20:00:00Z' },
    { type: 'message', timestamp: '2026-08-27T20:01:00Z', message: { role: 'user', content: 'Which conference should I attend?' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Tell me your field and budget.' }] } },
    { type: 'message', message: { role: 'tool', content: 'search(...)' } }, // dropped
    { type: 'message', message: { role: 'assistant', content: 'Boston DevConf, Oct 3-5, fits both.' } },
  ];
  const jsonl = (events: object[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const say = (role: string, text: string) => ({ type: 'message', message: { role, content: text } });

  /**
   * A volume in a temp folder, and a provider that runs the real script on it
   * the way the one-shot container does (bash, node and a few coreutils on a
   * PATH of shims), with nothing written outside the folder.
   */
  function volume() {
    const root = mkdtempSync(join(tmpdir(), 'hb-inspect-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, 'node'));
    for (const c of ['base64', 'rm', 'ls', 'head', 'tail', 'wc']) symlinkSync(['/usr/bin', '/bin'].map((d) => join(d, c)).find((f) => existsSync(f))!, join(bin, c));
    const agents = join(root, 'agents');
    const base = join(agents, 'kitchen');
    mkdirSync(join(base, 'sessions'), { recursive: true });
    mkdirSync(join(base, 'agent'));
    const scripts: string[] = [];
    const provider = {
      async execShellOnVolume(_ref: string, script: string) {
        scripts.push(script);
        const r = spawnSync('/bin/bash', ['-c', script.replace(/T=\/tmp\//, `T=${root}/`)], { env: { HOME: root, PATH: bin, AGENTS_DIR: agents, TMPDIR: root }, encoding: 'utf8' });
        return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      },
    } as unknown as RuntimeProvider;
    // `wal`: written as 2026.9 does (WAL), closed cleanly ('clean', no -wal
    // left) or with its last writes still in a -wal beside it ('left').
    const db = (sessions: Record<string, object[]>, main?: string, wal?: 'clean' | 'left') => {
      const file = join(base, 'agent', 'openclaw-agent.sqlite');
      const d = new Database(wal === 'left' ? join(root, 'live.sqlite') : file);
      if (wal) d.pragma('journal_mode = WAL');
      if (wal === 'left') d.pragma('wal_autocheckpoint = 0');
      d.exec('CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT); CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB)');
      if (main) d.prepare('INSERT INTO session_nodes VALUES (?, ?)').run('agent:kitchen:main', main);
      const add = d.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?)');
      for (const [id, events] of Object.entries(sessions)) {
        events.forEach((e, i) => {
          // Every third one stored compressed, as 2026.9 does with big ones.
          const zstd = i % 3 === 2 && typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function';
          add.run(id, i + 1, zstd ? null : JSON.stringify(e), zstd ? zlib.zstdCompressSync(Buffer.from(JSON.stringify(e))) : null);
        });
      }
      // An agent that stopped without a checkpoint: the database and its -wal, no -shm.
      if (wal === 'left') { copyFileSync(join(root, 'live.sqlite'), file); copyFileSync(join(root, 'live.sqlite-wal'), `${file}-wal`); }
      d.close();
    };
    return { root, base, provider, scripts, db, rmRoot: () => rmSync(root, { recursive: true, force: true }) };
  }

  it('reads the main conversation from the agent database (OpenClaw 2026.9, HB-0306)', async () => {
    const v = volume();
    v.db({ 'sess-main': SESSION, 'sess-task': Array.from({ length: 30 }, (_, i) => say('assistant', `background step ${i}`)) }, 'sess-main');
    const t = await readTranscript(v.provider, 'docker://x', 'kitchen', { maxTurns: 400 });
    expect(t.totalTurns).toBe(5);
    expect(t.turns.map((x) => x.role)).toEqual(['user', 'assistant', 'assistant']); // no tool/system
    expect(t.turns[0]!.text).toContain('Which conference');
    expect(t.turns[1]!.text).toBe('Tell me your field and budget.'); // array-of-parts flattened
    expect(t.turns[2]!.text).toContain('Boston DevConf');
    expect(t.sessionFile).toBe('sess-main');
    // The read is read-only and the volume is left as it was.
    expect(v.scripts.every((s) => !/\brm -rf|>\s*\/home/.test(s))).toBe(true);
    v.rmRoot();
  });

  it('reads a 2026.9 database on the read-only mount an archived agent is inspected through', async () => {
    // A WAL database: SQLite reads it through -wal and -shm files it cannot
    // make on a read-only volume. Stopped cleanly (no -wal), and stopped
    // with its last writes still in the -wal.
    for (const wal of ['clean', 'left'] as const) {
      const v = volume();
      v.db({ 'sess-main': SESSION, 'sess-task': [say('assistant', 'background step')] }, 'sess-main', wal);
      expect(existsSync(join(v.base, 'agent', 'openclaw-agent.sqlite-wal'))).toBe(wal === 'left');
      if (process.getuid?.() !== 0) chmodSync(join(v.base, 'agent'), 0o555); // root writes anyway
      try {
        const t = await readTranscript(v.provider, 'docker://x', 'kitchen');
        expect(t.sessionFile).toBe('sess-main');
        expect(t.totalTurns).toBe(5);
        expect(t.turns.at(-1)!.text).toContain('Boston DevConf');
        expect(readdirSync(join(v.base, 'agent')).sort()).toEqual(wal === 'left' ? ['openclaw-agent.sqlite', 'openclaw-agent.sqlite-wal'] : ['openclaw-agent.sqlite']);
        expect(readdirSync(v.root).filter((f) => f.startsWith('hatchabot-inspect'))).toEqual([]); // its copy is gone
      } finally { chmodSync(join(v.base, 'agent'), 0o755); }
      v.rmRoot();
    }
  });

  it('takes the conversation sessions.json names as main, not the biggest file (HB-0307)', async () => {
    const v = volume();
    writeFileSync(join(v.base, 'sessions', 'sessions.json'), JSON.stringify({ 'agent:kitchen:main': { sessionId: 'main-id' }, 'agent:kitchen:cron:x': { sessionId: 'task' } }));
    writeFileSync(join(v.base, 'sessions', 'main-id.jsonl'), jsonl(SESSION));
    writeFileSync(join(v.base, 'sessions', 'task.jsonl'), jsonl(Array.from({ length: 50 }, (_, i) => say('assistant', `background step ${i}`))));
    const t = await readTranscript(v.provider, 'docker://x', 'kitchen');
    expect(t.sessionFile).toBe('main-id.jsonl');
    expect(t.totalTurns).toBe(5);
    expect(t.turns.at(-1)!.text).toContain('Boston DevConf');
    // A database with no main conversation does not hide the one sessions.json names.
    v.db({ other: [say('assistant', 'elsewhere')] });
    expect((await readTranscript(v.provider, 'docker://x', 'kitchen')).sessionFile).toBe('main-id.jsonl');
    v.rmRoot();
  });

  it('a main conversation a reset just emptied is an empty history, not the biggest of another key (HB-0307)', async () => {
    const v = volume();
    v.db({ 'sess-old-main': SESSION.slice(0, 3), 'sess-cron': Array.from({ length: 10 }, (_, i) => say('assistant', `background step ${i}`)) }, 'sess-new');
    writeFileSync(join(v.base, 'sessions', 'big.jsonl'), jsonl(Array.from({ length: 20 }, (_, i) => say('assistant', `older step ${i}`))));
    expect(await readTranscript(v.provider, 'docker://x', 'kitchen')).toEqual({ turns: [], sessionFile: 'sess-new', totalTurns: 0 });
    v.rmRoot();
  });

  it('with nothing naming the main conversation, the biggest (never a trajectory file); the tail of a long one', async () => {
    const v = volume();
    writeFileSync(join(v.base, 'sessions', 'small.jsonl'), jsonl([say('user', 'hi')]));
    writeFileSync(join(v.base, 'sessions', 'big.jsonl'), jsonl(Array.from({ length: 30 }, (_, i) => say(i % 2 ? 'assistant' : 'user', `turn ${i}`))));
    writeFileSync(join(v.base, 'sessions', 'big.trajectory.jsonl'), 'x'.repeat(100_000) + '\n');
    const t = await readTranscript(v.provider, 'docker://x', 'kitchen', { maxTurns: 4 });
    expect(t.sessionFile).toBe('big.jsonl');
    expect(t.totalTurns).toBe(30);
    expect(t.turns.map((x) => x.text)).toEqual(['turn 26', 'turn 27', 'turn 28', 'turn 29']);
    v.rmRoot();
  });

  it('no sessions → empty, not an error', async () => {
    const v = volume();
    expect(await readTranscript(v.provider, 'docker://x', 'kitchen')).toEqual({ turns: [], totalTurns: 0 });
    rmSync(join(v.base, 'sessions'), { recursive: true });
    expect(await readTranscript(v.provider, 'docker://x', 'kitchen')).toEqual({ turns: [], totalTurns: 0 });
    v.rmRoot();
  });

  it('a store that is there but cannot be read is an error, not an empty history (HB-0308)', async () => {
    const v = volume();
    rmSync(join(v.base, 'sessions'), { recursive: true });
    writeFileSync(join(v.base, 'sessions'), 'not a folder'); // ENOTDIR, as root too
    await expect(readTranscript(v.provider, 'docker://x', 'kitchen')).rejects.toBeInstanceOf(InspectReadError);
    rmSync(join(v.base, 'sessions'));
    mkdirSync(join(v.base, 'sessions'));
    writeFileSync(join(v.base, 'agent', 'openclaw-agent.sqlite'), 'not a database');
    await expect(readTranscript(v.provider, 'docker://x', 'kitchen')).rejects.toBeInstanceOf(InspectReadError);
    // It says which part, not that Docker may not be answering.
    const err = await readTranscript(v.provider, 'docker://x', 'kitchen').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/^Couldn't read the agent's chat history: the agent database: /);
    expect((err as Error).message).not.toMatch(/Docker/);
    expect((err as Error).message).toMatch(/not a database/i); // the reason, not node:sqlite's ERR_SQLITE_ERROR
    rmSync(join(v.base, 'agent', 'openclaw-agent.sqlite'));
    if (process.getuid?.() !== 0) { // root reads anything
      writeFileSync(join(v.base, 'sessions', 'main.jsonl'), jsonl(SESSION));
      chmodSync(join(v.base, 'sessions'), 0);
      try { await expect(readTranscript(v.provider, 'docker://x', 'kitchen')).rejects.toBeInstanceOf(InspectReadError); }
      finally { chmodSync(join(v.base, 'sessions'), 0o700); }
      chmodSync(join(v.base, 'sessions', 'main.jsonl'), 0);
      await expect(readTranscript(v.provider, 'docker://x', 'kitchen')).rejects.toBeInstanceOf(InspectReadError);
      // An index that cannot be read would let the wrong conversation through as main.
      chmodSync(join(v.base, 'sessions', 'main.jsonl'), 0o600);
      writeFileSync(join(v.base, 'sessions', 'sessions.json'), '{}', { mode: 0 });
      await expect(readTranscript(v.provider, 'docker://x', 'kitchen')).rejects.toBeInstanceOf(InspectReadError);
    }
    v.rmRoot();
  });
});
