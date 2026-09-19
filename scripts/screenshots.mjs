#!/usr/bin/env node
/**
 * Renders the screenshots used on hatchabot.com and in docs/deck, from the
 * REAL web/index.html driven by a stubbed fetch (docs/deck/shot-data.mjs).
 * Nothing real is in them: invented household agents, no tokens, no usage.
 *
 *   node scripts/screenshots.mjs            # all of them, into docs/deck/
 *   node scripts/screenshots.mjs --out DIR  # somewhere else
 *
 * Needs docker (it drives headless Chrome in a throwaway container).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHOTS, STUB } from '../docs/deck/shot-data.mjs';


const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const outDir = outArg > 0 ? resolve(process.argv[outArg + 1]) : join(root, 'docs', 'deck');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
// The app's own icon, inlined: the page asks the server for it, and these
// shots have no server.
const icon = `data:image/png;base64,${readFileSync(join(root, 'web', 'icons', 'icon-192.png')).toString('base64')}`;
const page = readFileSync(join(root, 'web', 'index.html'), 'utf8')
  .replaceAll('src="/icons/icon-192.png"', `src="${icon}"`);
const work = mkdtempSync(join(tmpdir(), 'hb-shots-'));

try {
  for (const shot of SHOTS) {
    // Light theme, the stub, then (after the app has painted) whatever this shot opens.
    const head = `<head><script>localStorage.setItem('theme','light')</script><script>${STUB.replace('__VERSION__', version)}</script>`;
    const tail = shot.open ? `<script>setTimeout(() => { ${shot.open}; }, 2500)</script></body>` : '</body>';
    const name = shot.file.replace(/\.png$/, '.html');
    writeFileSync(join(work, name), page.replace('<head>', head).replace('</body>', tail));
    const made = join(work, shot.file);
    // Headless Chrome drops a big page now and then; three goes is plenty.
    for (let tries = 1; !existsSync(made); tries++) {
      try {
        execFileSync('docker', [
          'run', '--rm', '--shm-size=1g', '-v', `${work}:/w`, 'zenika/alpine-chrome',
          '--no-sandbox', '--headless', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
          `--window-size=${shot.width},${shot.height}`, '--force-device-scale-factor=2',
          '--virtual-time-budget=10000', `--screenshot=/w/${shot.file}`, `file:///w/${name}`,
        ], { stdio: 'inherit' });
      } catch { /* the exit code is not the signal; the file is */ }
      if (!existsSync(made) && tries >= 3) throw new Error(`chrome produced no ${shot.file}`);
    }
    copyFileSync(made, join(outDir, shot.file));
    console.log(`${shot.file}  ${shot.width * 2}×${shot.height * 2}  → ${outDir}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
