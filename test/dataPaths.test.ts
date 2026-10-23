import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCAN_MAX_FILES, SYSTEM_PREFIXES, scanWorkspacePaths as scanWith } from '../src/orchestrator/dataPaths.js';

// Root under the repo, not /tmp — the scan (correctly) excludes /tmp and other
// system trees, so a fixture there would be filtered out.
const root = mkdtempSync(join(process.cwd(), 'acl-dp-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
// A checkout that is itself under a system tree (a self-hosted runner's
// /var/lib/...) keeps every other system prefix.
const prefixes = SYSTEM_PREFIXES.filter((s) => !root.startsWith(`${s}/`));
const scanWorkspacePaths = (ws: string) => scanWith(ws, prefixes);

// A real external data folder (with a file), and the agent's workspace.
const data = join(root, 'condo-documents');
const dataSub = join(data, 'minutes');
mkdirSync(dataSub, { recursive: true });
writeFileSync(join(data, 'bylaws.pdf'), 'x');
const ws = join(root, 'workspace-legal');
mkdirSync(join(ws, 'memory'), { recursive: true });

writeFileSync(
  join(ws, 'SOUL.md'),
  [
    `You read board documents from ${data}.`,          // external dir → keep
    `Detailed minutes live in ${dataSub}.`,             // nested → collapses into parent
    `The bylaws file is ${join(data, 'bylaws.pdf')}.`,  // a file → its parent (${data})
    `Your own notes are in ${join(ws, 'memory')}.`,     // inside workspace → drop
    `System tool at /usr/bin/pandoc is available.`,     // system → drop
    `Ignore ${join(root, 'does-not-exist')}.`,          // missing → drop
  ].join('\n'),
);
// An OpenClaw-internal path in another file → drop.
writeFileSync(join(ws, 'TOOLS.md'), `sessions in ${join(root, '.openclaw', 'agents', 'x')}`);
mkdirSync(join(root, '.openclaw', 'agents', 'x'), { recursive: true });

describe('scanWorkspacePaths', () => {
  it('returns only real external data folders, collapsing files and nested paths', () => {
    const found = scanWorkspacePaths(ws);
    expect(found).toEqual([data]); // just the one external folder
  });

  it('returns [] for a workspace that references nothing external', () => {
    const bare = join(root, 'workspace-bare');
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'SOUL.md'), 'You are helpful. No paths here.');
    expect(scanWorkspacePaths(bare)).toEqual([]);
  });

  it('reads at most SCAN_MAX_FILES files, even all in one folder (review 2026-10-22, A43)', () => {
    expect(SCAN_MAX_FILES).toBe(400);
    // Its own root with no hidden folder on the way (a checkout in .claude/worktrees has one).
    const top = mkdtempSync(join(tmpdir(), 'acl-dp-flat-'));
    try {
      const flat = join(top, 'workspace-flat');
      mkdirSync(flat, { recursive: true });
      for (let i = 0; i < 450; i++) {
        const d = join(top, 'flat-data', `d${i}`);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(flat, `note-${i}.md`), `Reads ${d}.`);
      }
      const found = scanWith(flat, SYSTEM_PREFIXES.filter((s) => !top.startsWith(`${s}/`)));
      expect(found.length).toBeGreaterThan(0);
      expect(found.length).toBeLessThanOrEqual(400);
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  it("a folder's own files are read before its subfolders: 400 notes in memory/ don't crowd out TOOLS.md", () => {
    const top = mkdtempSync(join(tmpdir(), 'acl-dp-deep-'));
    try {
      const w = join(top, 'workspace-old');
      // Named to come first in any listing order a test could rely on.
      mkdirSync(join(w, 'a-memory'), { recursive: true });
      for (let i = 0; i < 450; i++) writeFileSync(join(w, 'a-memory', `2025-${i}.md`), 'A day.');
      const ext = join(top, 'ext', 'data');
      mkdirSync(ext, { recursive: true });
      writeFileSync(join(w, 'z-tools.md'), `Reads ${ext}.`);
      expect(scanWith(w, SYSTEM_PREFIXES.filter((s) => !top.startsWith(`${s}/`)))).toEqual([ext]);
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  it('finds a quoted folder whose name has a space (report A23, 2026-10-22)', () => {
    const spaced = join(root, 'Board Papers');
    mkdirSync(spaced, { recursive: true });
    const w = join(root, 'workspace-spaced');
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, 'AGENTS.md'), `Read the papers in "${spaced}" and \`${join(spaced, 'agenda.md')}\`.`);
    expect(scanWorkspacePaths(w)).toEqual([spaced]);
  });
});
