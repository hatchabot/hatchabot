import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * scripts/check-web.mjs fails the gate on a handler that names no function.
 * It read only literal on*="fn(" attributes; the page builds many through
 * helpers (B(label, `fn(…)`), onclick="${setup}"), and a function renamed
 * and used only there shipped a dead button unseen (audit 2026-10-23, B20).
 */
const SCRIPT = resolve('scripts/check-web.mjs');
const PAGE = readFileSync('web/index.html', 'utf8');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** check-web over a copy of the page with `from` replaced by `to`. */
function check(from: string, to: string) {
  expect(PAGE).toContain(from);
  const d = mkdtempSync(join(tmpdir(), 'hb-checkweb-'));
  dirs.push(d);
  mkdirSync(join(d, 'web'));
  writeFileSync(join(d, 'web', 'index.html'), PAGE.replace(from, to));
  return spawnSync(process.execPath, [SCRIPT], { cwd: d, encoding: 'utf8' });
}

describe('check-web sees handlers built by helpers', () => {
  it('the page as it is passes', () => {
    expect(check('<!doctype', '<!doctype').status).toBe(0);
  });
  it('a renamed function used only through B(label, call) fails it', () => {
    const r = check('async function v2AppRollback(', 'async function v2AppRollbackRenamed(');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('handler references undefined function "v2AppRollback"');
  });
  it('a renamed function used only through onclick="${setup}" fails it', () => {
    const r = check('function openChanSetup(', 'function openChanSetupRenamed(');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('handler references undefined function "openChanSetup"');
  });
});
