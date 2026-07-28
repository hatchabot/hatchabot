// Syntax-checks the inline <script> of every page in web/. One bad escape in
// a template literal blanks the whole app (it's a single inline script), so
// this runs as part of `npm test` — a page that doesn't parse fails CI.
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'agentclaw-checkweb-'));
let failed = false;
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
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
