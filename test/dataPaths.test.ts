import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scanWorkspacePaths } from '../src/orchestrator/dataPaths.js';

// Root under the repo, not /tmp — the scan (correctly) excludes /tmp and other
// system trees, so a fixture there would be filtered out.
const root = mkdtempSync(join(process.cwd(), 'acl-dp-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
});
