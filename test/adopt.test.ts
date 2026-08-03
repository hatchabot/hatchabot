import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { AdoptError, inspectWorkspace, packWorkspace } from '../src/orchestrator/adopt.js';

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
