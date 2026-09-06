import { describe, expect, it } from 'vitest';
import { listInspectableFiles, readInspectableFile, readTranscript } from '../src/orchestrator/inspect.js';
import type { RuntimeProvider } from '../src/providers/provider.js';

/**
 * Read-only volume inspection for archived agents. A script-aware fake
 * provider stands in for execShellOnVolume so each distinct read (list,
 * file body, transcript pick/tail) can be asserted independently.
 */

function fakeProvider(respond: (script: string) => string): RuntimeProvider {
  return {
    async execShellOnVolume(_ref: string, script: string) {
      return { code: 0, stdout: respond(script), stderr: '' };
    },
  } as unknown as RuntimeProvider;
}

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
});

describe('readTranscript', () => {
  // OpenClaw's real shape: {type:'message', message:{role, content}}.
  const SESSION = [
    JSON.stringify({ type: 'session', version: 1, timestamp: '2026-08-27T20:00:00Z' }),
    JSON.stringify({ type: 'message', timestamp: '2026-08-27T20:01:00Z', message: { role: 'user', content: 'Which conference should I attend?' } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Tell me your field and budget.' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'tool', content: 'search(...)' } }), // dropped
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'Boston DevConf, Oct 3-5, fits both.' } }),
  ].join('\n');

  it('picks the session file, flattens dialogue turns, drops tool noise', async () => {
    const p = fakeProvider((s) => {
      if (s.includes('ls -S')) return '/home/node/.openclaw/agents/x/sessions/main.jsonl\n';
      if (s.startsWith('wc -l')) return '   5 /home/node/.openclaw/agents/x/sessions/main.jsonl\n';
      if (s.includes('tail -n')) return SESSION;
      return '';
    });
    const t = await readTranscript(p, 'docker://x', 'x', { maxTurns: 400 });
    expect(t.sessionFile).toBe('main.jsonl');
    expect(t.totalTurns).toBe(5);
    expect(t.turns.map((x) => x.role)).toEqual(['user', 'assistant', 'assistant']); // no tool/system
    expect(t.turns[0]!.text).toContain('Which conference');
    expect(t.turns[1]!.text).toBe('Tell me your field and budget.'); // array-of-parts flattened
    expect(t.turns[2]!.text).toContain('Boston DevConf');
  });

  it('no sessions → empty, not an error', async () => {
    const p = fakeProvider(() => '');
    const t = await readTranscript(p, 'docker://x', 'x');
    expect(t).toEqual({ turns: [], totalTurns: 0 });
  });
});
