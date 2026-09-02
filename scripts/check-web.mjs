// Syntax-checks the inline <script> of every page in web/. One bad escape in
// a template literal blanks the whole app (it's a single inline script), so
// this runs as part of `npm test` — a page that doesn't parse fails CI.
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'agentclaw-checkweb-'));
let failed = false;

/**
 * Every function an inline event handler names must be DEFINED in the page's
 * scripts. This exact bug shipped twice (📊 Sources, ⟳ Sync models): the
 * commit added the button but never the function, and every click was a
 * silent ReferenceError — invisible to a syntax check, caught only by a user.
 */
function checkHandlers(file, html, js) {
  // onclick="fn(...)" etc. — first identifier called in any on* attribute.
  const handlers = new Set(
    [...html.matchAll(/\son[a-z]+="\s*([A-Za-z_$][\w$]*)\s*[(.]/g)].map((m) => m[1]),
  );
  // Definitions: function declarations, const/let/var fn = ..., plus DOM ids
  // (elements with an id are window globals, e.g. someDlg.close()).
  const defined = new Set([
    ...[...js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...js.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
    ...[...html.matchAll(/\bid="([A-Za-z_$][\w$]*)"/g)].map((m) => m[1]),
  ]);
  for (const h of handlers) {
    // `this`/`event`, window built-ins, and statement keywords (inline
    // `onkeydown="if (...)"`) used directly in handlers.
    if (['this', 'event', 'window', 'document', 'location', 'navigator', 'confirm', 'alert',
         'if', 'for', 'while', 'return', 'void', 'new'].includes(h)) continue;
    if (!defined.has(h)) {
      failed = true;
      console.error(`✗ web/${file}: handler references undefined function "${h}"`);
    }
  }
}

try {
  for (const file of readdirSync('web').filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join('web', file), 'utf8');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    scripts.forEach((m, i) => {
      const tmp = join(dir, `${file}.${i}.js`);
      writeFileSync(tmp, m[1]);
      const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
      if (res.status !== 0) {
        failed = true;
        console.error(`✗ web/${file} script #${i}:\n${res.stderr}`);
      } else {
        console.log(`✓ web/${file} script #${i}`);
      }
    });
    checkHandlers(file, html, scripts.map((m) => m[1]).join('\n'));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
