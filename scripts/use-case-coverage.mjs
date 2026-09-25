#!/usr/bin/env node
// Reads docs/use-cases.md and says which use cases nothing automated
// exercises ("none" / "manual"), and which "auto (…)" notes name a test file
// that does not exist — so the matrix cannot quietly drift from the suite.
//
//   node scripts/use-case-coverage.mjs           # the report
//   node scripts/use-case-coverage.mjs --check   # exit 1 on a stale test reference
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const doc = readFileSync(join(root, 'docs', 'use-cases.md'), 'utf8');
const tests = new Set(readdirSync(join(root, 'test')).filter((f) => f.endsWith('.ts')).map((f) => f.replace(/\.test\.ts$|\.ts$/, '')));
const scripts = new Set(readdirSync(join(root, 'scripts')));
const rows = [...doc.matchAll(/^\| (\w[\w–-]*) \| (.+?) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ id: m[1], text: m[2], surfaces: m[3], coverage: m[4] }));
const gaps = rows.filter((r) => /^(none|manual)/.test(r.coverage));
const stale = [];
for (const r of rows) {
  for (const ref of r.coverage.matchAll(/\(([^)]*)\)/g)) {
    for (const part of ref[1].split(/[,;]/)) {
      // A reference is one file-like token (`crons.test.ts`, `restore-drill.sh`); anything with spaces is prose.
      if (!/^[\w.–-]+$/.test(part.trim())) continue;
      const name = part.trim().replace(/\.test\.ts$|\.ts$|\.sh$|\.mjs$/, '');
      if (!name || /^(UI|LXD|npm)$/i.test(name)) continue;
      const bare = name.replace(/\*$/, '');
      const ok = [...tests].some((t) => t === bare || t.startsWith(bare)) || scripts.has(part.trim()) || existsSync(join(root, 'scripts', part.trim()));
      if (!ok) stale.push(`${r.id}: "${part.trim()}"`);
    }
  }
}
console.log(`${rows.length} use cases · ${gaps.length} with no automated coverage:`);
for (const g of gaps) console.log(`  ${g.id.padEnd(6)} ${g.text}  [${g.coverage}]`);
if (stale.length) { console.log(`\nstale test references (${stale.length}):`); for (const s of stale) console.log(`  ${s}`); }
if (process.argv.includes('--check') && stale.length) process.exit(1);
