import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * scripts/check-web.mjs fails the gate on an action that names no function.
 * The page names actions in markup (data-on-click="fn") and through
 * onAction() in its scripts, helpers included (B(label, onAction(…)), the
 * channel setup button); a function renamed and used only through a helper
 * once shipped a dead button unseen (audit 2026-10-23, B20). It also fails
 * on an inline on…="" handler, which the page's script policy cannot allow
 * without 'unsafe-inline' (HB-0810, HB-0812). Since HB-0811 the page's code
 * is classic scripts in web/app/: it fails on an inline script, a file no page
 * loads, and code that cannot run in the order the page loads it.
 */
const SCRIPT = resolve('scripts/check-web.mjs');
// Each case runs check-web over a copy of web/ (about half a second, one to
// three times): on a busy runner that alone can pass the five-second unit
// default, as two cases did on one run. As HB-0801 gave the script tests.
vi.setConfig({ testTimeout: 30_000 });
/** The files of web/ check-web reads: the pages and their scripts. */
const WEB = [...readdirSync('web').filter((f) => f.endsWith('.html')), ...readdirSync('web/app').map((f) => `app/${f}`)];
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** check-web over a copy of web/ with `from` replaced by `to` in the file that has it (or `in`). */
function check(from: string, to: string, opts: { in?: string; add?: Record<string, string> } = {}) {
  const at = opts.in ?? WEB.find((f) => readFileSync(join('web', f), 'utf8').includes(from));
  expect(at, `"${from}" is in a file of web/`).toBeDefined();
  expect(readFileSync(join('web', at!), 'utf8')).toContain(from);
  const d = mkdtempSync(join(tmpdir(), 'hb-checkweb-'));
  dirs.push(d);
  cpSync('web', join(d, 'web'), { recursive: true });
  writeFileSync(join(d, 'web', at!), readFileSync(join('web', at!), 'utf8').replace(from, to));
  for (const [f, text] of Object.entries(opts.add ?? {})) writeFileSync(join(d, 'web', f), text);
  return spawnSync(process.execPath, [SCRIPT], { cwd: d, encoding: 'utf8' });
}

describe('check-web sees the actions the page names', () => {
  it('the page as it is passes', () => {
    expect(check('<!doctype', '<!doctype').status).toBe(0);
  });
  it('a renamed function used only through B(label, onAction(…)) fails it', () => {
    const r = check('async function v2AppRollback(', 'async function v2AppRollbackRenamed(');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the action table names "v2AppRollback", which is not defined');
  });
  it('a renamed function used only through the channel setup button fails it', () => {
    const r = check('function openChanSetup(', 'function openChanSetupRenamed(');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the action table names "openChanSetup", which is not defined');
  });
  it('an action named in markup but missing from the table fails it', () => {
    const r = check('data-on-click="openInbox"', 'data-on-click="openInboxElsewhere"');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the action "openInboxElsewhere" is not in the action table');
  });
  it('an action named through onAction() but missing from the table fails it', () => {
    const r = check("onAction('click', 'v2AppRollback'", "onAction('click', 'v2AppRollbackElsewhere'");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the action "v2AppRollbackElsewhere" is not in the action table');
  });
  it('an action name that is not a string literal fails it: it could not be checked', () => {
    const r = check("onAction('click', 'v2AppRollback'", "onAction('click', someName");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('name the action with a string literal');
  });
  it('an inline handler, in markup or in a string the script builds, fails it', () => {
    for (const [from, to] of [
      ['data-on-click="openInbox"', 'onclick="openInbox()"'],
      ["${onAction('click', 'v2StopCheck')}", 'onclick="v2StopCheck()"'],
    ] as const) {
      const r = check(from, to);
      expect(r.status, to).toBe(1);
      expect(r.stderr, to).toMatch(/line \d+: an inline onclick= handler/);
    }
  });
  it('a script tag that is neither a bare <script> nor a page script fails it, with the line named (HB-0620)', () => {
    for (const [from, to] of [
      ['<script src="app/core.js"></script>', '<script type="module" src="app/core.js"></script>'],
      ['<script src="app/core.js"></script>', '<script src="https://example.com/core.js"></script>'],
      ['<script src="app/core.js"></script>', '<script src="app/core.js" defer></script>'],
      ['<script src="app/core.js"></script>', '<script src="app/core.js"></script >'],
    ] as const) {
      const r = check(from, to, { in: 'index.html' });
      expect(r.status, to).toBe(1);
      expect(r.stderr, to).toMatch(/✗ web\/index\.html: inline-scripts: line \d+: a script (end )?tag that is/);
    }
  });
});

describe('check-web sees what splitting the page into scripts makes possible (HB-0811)', () => {
  it('an inline script in a page fails it: the code goes in web/app/', () => {
    const r = check('<script src="app/core.js"></script>', '<script>const x = 1;</script><script src="app/core.js"></script>', { in: 'index.html' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/✗ web\/index\.html: line \d+: an inline <script>; put its code in a file in web\/app\//);
  });
  it('a file in web/app/ that no page loads fails it, and so does a page script that is not there', () => {
    expect(check('<!doctype', '<!doctype', { in: 'index.html', add: { 'app/spare.js': 'const spare = 1;\n' } }).stderr)
      .toContain('✗ web/app/spare.js: no page loads it');
    const gone = check('<script src="app/pwa.js"></script>', '<script src="app/pwa.js"></script><script src="app/missing.js"></script>', { in: 'index.html' });
    expect(gone.status).toBe(1);
    expect(gone.stderr).toMatch(/missing\.js/);
  });
  it('a script that does not parse fails it, named by its file', () => {
    const r = check('function onAction(', 'function onAction(}', { in: 'app/actions.js' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('✗ web/app/actions.js:');
    // Read as a browser reads a classic script, not as a CommonJS file (node --check), which allows a top-level return.
    const ret = check('const $ = (id) => document.getElementById(id);', 'const $ = (id) => document.getElementById(id);\nreturn;', { in: 'app/core.js' });
    expect(ret.status).toBe(1);
    expect(ret.stderr).toMatch(/✗ web\/app\/core\.js:[\s\S]*Illegal return/);
  });
  it('code that runs at load and reaches a later script fails it: there, the function does not exist yet', () => {
    // core.js runs first; initV2 is declared in start.js, the last.
    const call = check('const $ = (id) => document.getElementById(id);', 'const $ = (id) => document.getElementById(id);\ninitV2();', { in: 'app/core.js' });
    expect(call.status).toBe(1);
    expect(call.stderr).toMatch(/web\/app\/core\.js:\d+: runs at load and reaches initV2 \(initV2\), which web\/app\/start\.js declares/);
    // A handler only registered at load is fine: it runs after every script has.
    const handler = check('const $ = (id) => document.getElementById(id);', "const $ = (id) => document.getElementById(id);\naddEventListener('resize', () => initV2());", { in: 'app/core.js' });
    expect(handler.status, handler.stderr).toBe(0);
  });
  it('a let or const declared at the top of two scripts fails it: the second would not run at all', () => {
    // chanDlg is channels.js's; core.js runs first.
    const r = check('const $ = (id) => document.getElementById(id);', 'const $ = (id) => document.getElementById(id);\nlet chanDlg = null;', { in: 'app/core.js' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/web\/app\/channels\.js:\d+: "chanDlg" is declared at the top of web\/app\/core\.js too/);
  });
});
