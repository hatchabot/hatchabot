import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SCAN_MAX_FILES, SCAN_MAX_PATHS, SYSTEM_PREFIXES, scanWorkspacePaths as scanWith } from '../src/orchestrator/transfer/dataPaths.js';

// Its own root in the temp folder, not under the checkout: the scan leaves
// out a path with a hidden folder on the way (credential folders), and a
// checkout in an agent's worktree (.claude/worktrees) has one (HB-0817). The
// temp folder is a system tree the scan excludes too, so the scan here keeps
// every system prefix but the one the root is under.
const root = mkdtempSync(join(tmpdir(), 'acl-dp-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
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
  it('returns only real external data folders, collapsing files and nested paths', async () => {
    const found = await scanWorkspacePaths(ws);
    expect(found).toEqual([data]); // just the one external folder
  });

  it('returns [] for a workspace that references nothing external', async () => {
    const bare = join(root, 'workspace-bare');
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'SOUL.md'), 'You are helpful. No paths here.');
    expect(await scanWorkspacePaths(bare)).toEqual([]);
  });

  it('reads at most SCAN_MAX_FILES files, even all in one folder (review 2026-10-22, A43)', async () => {
    expect(SCAN_MAX_FILES).toBe(400);
    const top = mkdtempSync(join(tmpdir(), 'acl-dp-flat-'));
    try {
      const flat = join(top, 'workspace-flat');
      mkdirSync(flat, { recursive: true });
      for (let i = 0; i < 450; i++) {
        const d = join(top, 'flat-data', `d${i}`);
        mkdirSync(d, { recursive: true });
        writeFileSync(join(flat, `note-${i}.md`), `Reads ${d}.`);
      }
      const found = await scanWith(flat, SYSTEM_PREFIXES.filter((s) => !top.startsWith(`${s}/`)));
      expect(found.length).toBeGreaterThan(0);
      expect(found.length).toBeLessThanOrEqual(400);
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  it("a folder's own files are read before its subfolders: 400 notes in memory/ don't crowd out TOOLS.md", async () => {
    const top = mkdtempSync(join(tmpdir(), 'acl-dp-deep-'));
    try {
      const w = join(top, 'workspace-old');
      // Named to come first in any listing order a test could rely on.
      mkdirSync(join(w, 'a-memory'), { recursive: true });
      for (let i = 0; i < 450; i++) writeFileSync(join(w, 'a-memory', `2025-${i}.md`), 'A day.');
      const ext = join(top, 'ext', 'data');
      mkdirSync(ext, { recursive: true });
      writeFileSync(join(w, 'z-tools.md'), `Reads ${ext}.`);
      expect(await scanWith(w, SYSTEM_PREFIXES.filter((s) => !top.startsWith(`${s}/`)))).toEqual([ext]);
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  it('finds a quoted folder whose name has a space (report A23, 2026-10-22)', async () => {
    const spaced = join(root, 'Board Papers');
    mkdirSync(spaced, { recursive: true });
    const w = join(root, 'workspace-spaced');
    mkdirSync(w, { recursive: true });
    writeFileSync(join(w, 'AGENTS.md'), `Read the papers in "${spaced}" and \`${join(spaced, 'agenda.md')}\`.`);
    expect(await scanWorkspacePaths(w)).toEqual([spaced]);
  });

  it('looks at no more than SCAN_MAX_PATHS of the paths its files name, the first found (HB-1168)', async () => {
    const top = mkdtempSync(join(tmpdir(), 'acl-dp-many-'));
    try {
      const w = join(top, 'workspace-many');
      mkdirSync(w, { recursive: true });
      const first = join(top, 'ext', 'first');
      const later = join(top, 'ext', 'later');
      mkdirSync(first, { recursive: true });
      mkdirSync(later, { recursive: true });
      // A folder, then more made-up paths than it looks at, then another folder.
      const many = Array.from({ length: SCAN_MAX_PATHS }, (_, i) => `/nowhere/made-up-${i}/notes`).join(' ');
      writeFileSync(join(w, 'AGENTS.md'), `Reads ${first}. ${many} Also reads ${later}.`);
      const scan = (ws: string) => scanWith(ws, SYSTEM_PREFIXES.filter((s) => !top.startsWith(`${s}/`)));
      expect(await scan(w)).toEqual([first]);
      // Under the cap, both are found.
      writeFileSync(join(w, 'AGENTS.md'), `Reads ${first}. ${many.split(' ').slice(10).join(' ')} Also reads ${later}.`);
      expect(await scan(w)).toEqual([first, later]);
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  it('counts toward SCAN_MAX_PATHS only the paths it could suggest: links, dates and "and/or" before the data folder do not use it up (HB-1168)', async () => {
    const top = mkdtempSync(join(tmpdir(), 'acl-dp-links-'));
    try {
      const w = join(top, 'workspace-links');
      mkdirSync(join(w, 'memory'), { recursive: true });
      const real = join(top, 'ext', 'garden-notes');
      mkdirSync(real, { recursive: true });
      const links = Array.from({ length: SCAN_MAX_PATHS }, (_, i) => `https://example.test/page/${i}/more and/or 2026/11/${i}`).join(' ');
      const own = Array.from({ length: SCAN_MAX_PATHS }, (_, i) => `${w}/memory/day-${i}.md /usr/share/made-up-${i} ${top}/.hidden-${i}/x`).join(' ');
      writeFileSync(join(w, 'AGENTS.md'), `${links} ${own} Plans are in ${real}.`);
      const scan = (ws: string) => scanWith(ws, SYSTEM_PREFIXES.filter((s) => !top.startsWith(`${s}/`)));
      // Was: the links' paths filled the cap, and the folder was never looked at.
      expect(await scan(w)).toEqual([real]);
      // A hidden file's folder is still suggested, and a link to a file here still names its folder.
      writeFileSync(join(real, '.env-made-up'), 'X=1');
      writeFileSync(join(real, 'plan.md'), 'plan');
      writeFileSync(join(w, 'AGENTS.md'), `See ${real}/.env-made-up.`);
      expect(await scan(w)).toEqual([real]);
      writeFileSync(join(w, 'AGENTS.md'), `See file://${real}/plan.md.`);
      expect(await scan(w)).toEqual([real]);
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  it('still finds a path glued to what comes before it, as v2.192.0 did: only links and dates are passed by before the cap (HB-1168)', async () => {
    const top = mkdtempSync(join(tmpdir(), 'acl-dp-glued-'));
    try {
      const w = join(top, 'workspace-glued');
      mkdirSync(w, { recursive: true });
      const real = join(top, 'srv', 'data');
      mkdirSync(real, { recursive: true });
      const scan = (ws: string) => scanWith(ws, SYSTEM_PREFIXES.filter((s) => !top.startsWith(`${s}/`)));
      // What v2.192.0's scan suggested for each (run against it: the same).
      for (const glued of [`-v${real}:/data`, `e.g.${real}`, `1.${real}`, `-${real}`, `/${real}`, `file://${real}`, `key:${real}`]) {
        writeFileSync(join(w, 'AGENTS.md'), `Mounted with ${glued} here.`);
        expect(await scan(w), glued).toEqual([real]);
      }
      // A link's path, a host name's and a date are not this machine's: passed by.
      for (const not of [`https://example.test${real}`, `example.test${real}`]) {
        writeFileSync(join(w, 'AGENTS.md'), `See ${not} here.`);
        expect(await scan(w), not).toEqual([]);
      }
    } finally { rmSync(top, { recursive: true, force: true }); }
  });

  it('lets other work run while it reads, and finds what it found before (HB-0983)', async () => {
    const top = mkdtempSync(join(tmpdir(), 'acl-dp-busy-'));
    try {
      const w = join(top, 'workspace-busy');
      mkdirSync(join(w, 'memory'), { recursive: true });
      const ext = join(top, 'ext', 'records');
      mkdirSync(ext, { recursive: true });
      writeFileSync(join(ext, 'ledger.txt'), 'x');
      // Notes naming folders and files there and not there, and much else besides.
      for (let i = 0; i < 40; i++) writeFileSync(join(w, 'memory', `day-${i}.md`), `Checked ${join(ext, 'ledger.txt')} and /nowhere/made-up-${i}/notes. `.repeat(500));
      writeFileSync(join(w, 'TOOLS.md'), `Records: ${ext}.`);
      let otherWorkRuns = 0;
      const tick = () => { otherWorkRuns++; if (otherWorkRuns < 1000) setImmediate(tick); };
      setImmediate(tick);
      const found = await scanWith(w, SYSTEM_PREFIXES.filter((s) => !top.startsWith(`${s}/`)));
      expect(found).toEqual([ext]);
      // Others had many turns during it, not one at its end: it waited on the disk off the loop, file by file.
      expect(otherWorkRuns).toBeGreaterThan(40);
    } finally { rmSync(top, { recursive: true, force: true }); }
  });
});
