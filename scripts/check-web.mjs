// Checks the scripts of every page in web/: each parses (one bad escape in a
// template literal stops its whole script), the pages hold no inline script
// (their code is in web/app/, HB-0811), every file there is a page's, the
// scripts can run in the order a page loads them (load-order.mjs), and the
// event actions are sound. It runs as part of `npm test`: a page that doesn't
// parse fails CI.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { pageScripts, pageWithScripts } from './inline-scripts.mjs';
import { loadOrderProblems } from './load-order.mjs';

let failed = false;

/**
 * The page's event actions (HB-0810; web/index.html, onAction and actionFor).
 * No inline on…="" handler may come back: it needs 'unsafe-inline' in the
 * page's script policy (HB-0812). Every action an element names, in its
 * markup or through onAction(), must be in the action table, and every name
 * in the table must be DEFINED in the page's scripts: a button whose function
 * was never written shipped twice (📊 Sources, ⟳ Sync models), and a renamed
 * one once (audit 2026-10-23, B20), each a silent failure caught by a user.
 */
function checkHandlers(file, html, js) {
  const fail = (msg) => { failed = true; console.error(`✗ web/${file}: ${msg}`); };
  for (const m of html.matchAll(/(?<![\w-])on([a-z]+)\s*=\s*\\?["']/g)) {
    const line = html.slice(0, m.index).split('\n').length;
    fail(`line ${line}: an inline on${m[1]}= handler; name an action with data-on-${m[1]} (onAction() in a script) instead`);
  }
  // Definitions: function declarations and const/let/var fn = ...
  const defined = new Set([
    ...[...js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
  ]);
  // A second top-level function of the same name silently replaces the first
  // in one script: Discord/Slack "Add to pool", the roster's "Copy invitation"
  // and the master's Proposals all ran someone else's function (2026-09-27).
  const decl = [...js.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  for (const name of new Set(decl.filter((n, i) => decl.indexOf(n) !== i))) fail(`function "${name}" is declared twice — the second replaces the first`);

  const named = new Set();
  for (const m of html.matchAll(/\bdata-on-[a-z]+="([^"$]*)"/g)) for (const n of m[1].split(' ')) named.add(n);
  for (const m of js.matchAll(/\bonAction\(\s*'[a-z]+'\s*,\s*([^,)]+)/g)) {
    const lit = /^'([A-Za-z_$][\w$]*(?: [A-Za-z_$][\w$]*)*)'$/.exec(m[1].trim());
    if (!lit) { fail(`onAction(…, ${m[1].trim()}): name the action with a string literal, so it can be checked`); continue; }
    for (const n of lit[1].split(' ')) named.add(n);
  }
  if (!named.size) return;
  const table = /function actionFor\(name\) \{\s*ACTIONS \?\?= \{([^}]*)\};/.exec(js);
  if (!table) { fail('names actions but has no action table (actionFor)'); return; }
  const inTable = new Set(table[1].split(',').map((n) => n.trim()).filter(Boolean));
  for (const n of named) if (!inTable.has(n)) fail(`the action "${n}" is not in the action table (actionFor)`);
  for (const n of inTable) {
    if (!defined.has(n)) fail(`the action table names "${n}", which is not defined`);
    if (!named.has(n)) fail(`the action table names "${n}", which nothing uses: remove it`);
  }
}

/**
 * A script as the browser reads it: classic, not a module, and not a function
 * body (`node --check` reads a .js file as CommonJS, which allows a top-level
 * return). Compiled, never run; one process for all of them.
 */
function syntaxOk(label, code) {
  try {
    new Script(code, { filename: label });
  } catch (e) {
    failed = true;
    console.error(`✗ ${label}:\n${e instanceof Error ? (e.stack ?? e.message).split('\n    at ')[0] : e}`);
    return false;
  }
  console.log(`✓ ${label}`);
  return true;
}

{
  // External console enhancements ship as classic scripts alongside the app.
  for (const file of readdirSync('web').filter(f => f.startsWith('control-ui-') && f.endsWith('.js'))) syntaxOk(`web/${file}`, readFileSync(join('web', file), 'utf8'));
  const used = new Set(), checked = new Map();
  const readSrc = (name) => readFileSync(join('web', 'app', name), 'utf8');
  for (const file of readdirSync('web').filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join('web', file), 'utf8');
    // Every script is a bare <script> or <script src="app/NAME.js"></script> (inline-scripts.mjs
    // refuses anything else, so a module, another src or a tag it can't read fails here rather
    // than going unchecked).
    let scripts;
    try {
      scripts = pageScripts(html, readSrc);
    } catch (e) {
      failed = true;
      console.error(`✗ web/${file}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    let parsed = true;
    for (const [i, sc] of scripts.entries()) {
      if (sc.src === null) {
        // The page's code lives in web/app/: an inline script would need 'unsafe-inline' in the
        // page's script policy (HB-0812), and puts code back where a test reading web/app/ misses it.
        failed = true;
        console.error(`✗ web/${file}: line ${sc.line}: an inline <script>; put its code in a file in web/app/ and name it with <script src="app/NAME.js"></script> (HB-0811)`);
        parsed = syntaxOk(`web/${file} script #${i}`, sc.code) && parsed;
        continue;
      }
      used.add(sc.src);
      if (!checked.has(sc.src)) checked.set(sc.src, syntaxOk(`web/app/${sc.src}`, sc.code));
      parsed = checked.get(sc.src) && parsed;
    }
    if (parsed) for (const p of loadOrderProblems(scripts.map((sc, i) => ({ name: sc.src ? `web/app/${sc.src}` : `web/${file} script #${i}`, code: sc.code })))) {
      failed = true;
      console.error(`✗ web/${file}: ${p}`);
    }
    checkHandlers(file, pageWithScripts(html, readSrc), scripts.map((sc) => sc.code).join('\n'));
  }
  for (const name of readdirSync(join('web', 'app'))) {
    if (!used.has(name)) { failed = true; console.error(`✗ web/app/${name}: no page loads it; name it in a page, or remove it`); }
  }
}
process.exit(failed ? 1 : 0);
