import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { COVERAGE } from '../src/mgmt/coverage.js';
import { MANIFEST } from '../src/mgmt/tools.js';

/**
 * The management chat must not quietly fall behind the app: every route that
 * changes something is either covered by a chat tool or deliberately left to
 * the app with a reason (src/mgmt/coverage.ts).
 */

function mutatingRoutes(): string[] {
  const out = new Set<string>();
  for (const f of readdirSync('src/api').filter((x) => x.endsWith('.ts'))) {
    const s = readFileSync(`src/api/${f}`, 'utf8');
    for (const m of s.matchAll(/app\.(post|put|patch|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*'([^']+)'/g)) {
      out.add(`${m[1]!.toUpperCase()} ${m[2]}`);
    }
  }
  return [...out].sort();
}

describe('management chat coverage', () => {
  const routes = mutatingRoutes();

  it('finds the routes (sanity: the scan is not silently empty)', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it('every route that changes something is covered by a tool, or marked app-only with a reason', () => {
    const missing = routes.filter((r) => !(r in COVERAGE));
    expect(missing, `Add these to src/mgmt/coverage.ts (a tool name, or "app: <reason>"):\n${missing.join('\n')}`).toEqual([]);
  });

  it('the ledger names only routes that exist', () => {
    const stale = Object.keys(COVERAGE).filter((r) => !routes.includes(r));
    expect(stale).toEqual([]);
  });

  it('every tool the ledger names is on the menu', () => {
    const tools = new Set(MANIFEST.map((t) => t.name));
    const named = Object.values(COVERAGE)
      .filter((v) => !v.startsWith('app:'))
      .flatMap((v) => v.split(',').map((x) => x.trim().split(' ')[0]!));
    expect(named.filter((n) => !tools.has(n))).toEqual([]);
  });

  it('app-only entries say which kind and why', () => {
    const bad = Object.entries(COVERAGE)
      .filter(([, v]) => v.startsWith('app:'))
      .filter(([, v]) => !/^app: (secret|fleet-wide\/irreversible|browser|internal|later) — .{8,}/.test(v));
    expect(bad).toEqual([]);
  });

  it('the dangerous ones stay off the menu', () => {
    for (const r of ['DELETE /v1/agents/:id', 'POST /v1/runtime/images/promote', 'POST /v1/ai-profiles', 'POST /v1/agents/:id/channel-token', 'POST /v1/agents/:id/env']) {
      expect(COVERAGE[r], r).toMatch(/^app: (secret|fleet-wide\/irreversible)/);
    }
  });
});
