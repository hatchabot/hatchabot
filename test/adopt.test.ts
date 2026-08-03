import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  AdoptError,
  findExistingBot,
  inspectWorkspace,
  botPollState,
  packWorkspace,
} from '../src/orchestrator/adopt.js';

let ws: string;
beforeAll(() => {
  ws = mkdtempSync(join(tmpdir(), 'acl-ws-'));
  // A realistic hand-built OpenClaw workspace: far more than three files.
  for (const f of ['SOUL.md', 'AGENTS.md', 'MEMORY.md', 'IDENTITY.md', 'USER.md', 'TOOLS.md', 'INVESTING_RULES.md']) {
    writeFileSync(join(ws, f), `# ${f}\ncontent\n`);
  }
  writeFileSync(join(ws, 'openclaw-agent.sqlite'), 'x'.repeat(5000));
  writeFileSync(join(ws, 'auth-profiles.json'), '{"secret":"do-not-copy"}');
  mkdirSync(join(ws, '.git'), { recursive: true });
  writeFileSync(join(ws, '.git', 'HEAD'), 'ref: refs/heads/main');
  mkdirSync(join(ws, 'memory'), { recursive: true });
  writeFileSync(join(ws, 'memory', '2026-06-14.md'), '# day one\n');
  mkdirSync(join(ws, 'projects'), { recursive: true });
  writeFileSync(join(ws, 'projects', 'spec.md'), '# spec\n');
  mkdirSync(join(ws, 'nested'), { recursive: true });
  writeFileSync(join(ws, 'nested', 'auth-profiles.json'), '{"secret":"nope"}');
  // The real thing: a 1.2 GB venv and a node_modules sat next to the notes.
  mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'pkg', 'index.js'), 'module.exports=1');
  mkdirSync(join(ws, 'venv', 'bin'), { recursive: true });
  writeFileSync(join(ws, 'venv', 'bin', 'python'), 'binary');
});

describe('inspectWorkspace', () => {
  it('reports every file, not just the three AgentClaw seeds', () => {
    const p = inspectWorkspace(ws);
    expect(p.markdownFiles).toContain('INVESTING_RULES.md');
    expect(p.markdownFiles).toContain('IDENTITY.md');
    expect(p.bytes).toBeGreaterThan(0);
  });

  it('counts subdirectories, because that is what gets copied', () => {
    // A real workspace keeps daily notes in memory/ and work in projects/.
    // Counting only the top level understated tech-advisor as 8 files when
    // the copy actually moved 17.
    const p = inspectWorkspace(ws);
    expect(p.files).toContain('memory/2026-06-14.md');
    expect(p.files).toContain('projects/spec.md');
    expect(p.markdownFiles.length).toBe(9);
  });

  it('skips build artifacts and says which, rather than silently dropping them', () => {
    const p = inspectWorkspace(ws);
    expect(p.files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(p.files.some((f) => f.includes('venv/'))).toBe(false);
    expect(p.skipped).toContain('node_modules');
    expect(p.skipped).toContain('venv');
  });

  it('refuses a workspace whose real content is too big to own a copy of', () => {
    const big = mkdtempSync(join(tmpdir(), 'acl-big-'));
    writeFileSync(join(big, 'SOUL.md'), '# soul');
    mkdirSync(join(big, 'data'), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(big, 'data', `f${i}.bin`), Buffer.alloc(20 * 1024 * 1024));
    expect(() => inspectWorkspace(big)).toThrow(/too big|share it as a folder/);
  });

  it('excludes credentials at any depth, not just the top level', () => {
    const p = inspectWorkspace(ws);
    expect(p.files.some((f) => f.includes('auth-profiles.json'))).toBe(false);
    expect(p.files.some((f) => f.startsWith('.git/'))).toBe(false);
  });

  it('excludes session databases and credentials', () => {
    const p = inspectWorkspace(ws);
    expect(p.files).not.toContain('openclaw-agent.sqlite');
    expect(p.files).not.toContain('auth-profiles.json');
  });

  it('refuses a folder with no markdown — that is not a workspace', () => {
    const empty = mkdtempSync(join(tmpdir(), 'acl-empty-'));
    writeFileSync(join(empty, 'notes.txt'), 'hi');
    expect(() => inspectWorkspace(empty)).toThrow(AdoptError);
  });

  it('refuses a missing folder and a credential directory', () => {
    expect(() => inspectWorkspace('/definitely/not/here')).toThrow(AdoptError);
    expect(() => inspectWorkspace(join(homedir(), '.ssh'))).toThrow(AdoptError);
  });
});

describe('packWorkspace', () => {
  it('produces a tarball carrying the markdown but not the excluded files', async () => {
    const tar = await packWorkspace(ws);
    expect(tar.length).toBeGreaterThan(0);
    const listing = execFileSync('tar', ['tz'], { input: tar, encoding: 'utf8' });
    expect(listing).toContain('SOUL.md');
    expect(listing).toContain('INVESTING_RULES.md');
    expect(listing).not.toContain('openclaw-agent.sqlite');
    expect(listing).not.toContain('auth-profiles.json');
  });
});

describe('reusing the bot a workspace already owns', () => {
  const cfgFor = (dir: string) => {
    const p = join(mkdtempSync(join(tmpdir(), 'acl-cfg-')), 'openclaw.json');
    writeFileSync(p, JSON.stringify({
      agents: { list: [
        { id: 'main' },
        { id: 'tech-advisor', workspace: dir, agentDir: dir + '/agent' },
      ] },
      bindings: [
        { type: 'route', agentId: 'other', match: { channel: 'telegram', accountId: 'OtherBot' } },
        { type: 'route', agentId: 'tech-advisor', match: { channel: 'telegram', accountId: 'TechAdvBot' } },
      ],
      channels: { telegram: { accounts: {
        OtherBot: { botToken: 'nope' },
        TechAdvBot: { botToken: '123:secret', allowFrom: ['1000000001', 'bogus'] },
      } } },
    }));
    return p;
  };

  it('resolves workspace -> agent -> binding -> token', () => {
    const found = findExistingBot(ws, cfgFor(ws));
    expect(found?.accountId).toBe('TechAdvBot');
    expect(found?.botToken).toBe('123:secret');
    expect(found?.sourceAgentId).toBe('tech-advisor');
  });

  it('carries only well-formed Telegram ids, so the owner skips pairing', () => {
    // The whole point: adopting used to make you approve yourself.
    expect(findExistingBot(ws, cfgFor(ws))?.allowFrom).toEqual(['1000000001']);
  });

  it('returns nothing for a workspace with no bot, rather than throwing', () => {
    const other = mkdtempSync(join(tmpdir(), 'acl-nobot-'));
    expect(findExistingBot(other, cfgFor(ws))).toBeUndefined();
    expect(findExistingBot(ws, '/no/such/config.json')).toBeUndefined();
  });

  it('confirms a conflict but never reports one clear', async () => {
    const conflict = async () => new Response(JSON.stringify({ ok: false, error_code: 409 }), { status: 409 });
    expect(await botPollState('t', conflict as unknown as typeof fetch)).toBe('busy');
    // 'quiet', deliberately not 'free': a poller resting between long-polls
    // answers ok:true exactly like an unused bot, so this can never clear one.
    const quiet = async () => new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
    expect(await botPollState('t', quiet as unknown as typeof fetch)).toBe('quiet');
    // Unreachable Telegram must never read as "free" — that would green-light
    // the one thing this check exists to prevent.
    const down = async () => { throw new Error('offline'); };
    expect(await botPollState('t', down as unknown as typeof fetch)).toBe('unknown');
  });

  it('reports whether the source instance would still poll the bot', () => {
    // The deterministic signal the refusal actually turns on.
    const dir = mkdtempSync(join(tmpdir(), 'acl-en-'));
    writeFileSync(join(dir, 'SOUL.md'), '# s');
    const mk = (enabled?: boolean) => {
      const p = join(mkdtempSync(join(tmpdir(), 'acl-c-')), 'openclaw.json');
      writeFileSync(p, JSON.stringify({
        agents: { list: [{ id: 'a', workspace: dir }] },
        bindings: [{ agentId: 'a', match: { channel: 'telegram', accountId: 'B' } }],
        channels: { telegram: { accounts: { B: { botToken: 't', ...(enabled === undefined ? {} : { enabled }) } } } },
      }));
      return p;
    };
    expect(findExistingBot(dir, mk(true))?.enabledInSource).toBe(true);
    expect(findExistingBot(dir, mk(false))?.enabledInSource).toBe(false);
    // Absent means on, matching how OpenClaw reads it.
    expect(findExistingBot(dir, mk())?.enabledInSource).toBe(true);
  });
});
