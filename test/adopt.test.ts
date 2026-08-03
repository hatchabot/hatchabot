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
});

describe('inspectWorkspace', () => {
  it('reports every file, not just the three AgentClaw seeds', () => {
    const p = inspectWorkspace(ws);
    expect(p.markdownFiles).toContain('INVESTING_RULES.md');
    expect(p.markdownFiles).toContain('IDENTITY.md');
    expect(p.markdownFiles.length).toBe(7);
    expect(p.bytes).toBeGreaterThan(0);
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
