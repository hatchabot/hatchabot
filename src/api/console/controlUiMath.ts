import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlUiScriptInsertionPoint } from './controlUiHtml.js';

/** All URLs stay under the authenticated console that owns the document. */
export const CONTROL_UI_MATH_PREFIX = '/__hatchabot/math/';
export const KATEX_SCRIPT_PATH = `${CONTROL_UI_MATH_PREFIX}katex.min.js`;
export const KATEX_STYLES_PATH = `${CONTROL_UI_MATH_PREFIX}katex.min.css`;
export const CONTROL_UI_MATH_SOURCE_PATH = `${CONTROL_UI_MATH_PREFIX}control-ui-math-source.js`;
export const CONTROL_UI_MATH_SCRIPT_PATH = `${CONTROL_UI_MATH_PREFIX}control-ui-math.js`;
export const CONTROL_UI_MATH_STYLES_PATH = `${CONTROL_UI_MATH_PREFIX}control-ui-math.css`;

type AssetSource = { root: 'katex' | 'web'; file: string; contentType: string };
export interface ControlUiMathAsset { body: Buffer; contentType: string }
const assets = new Map<string, AssetSource>([
  [KATEX_SCRIPT_PATH, { root: 'katex', file: 'katex.min.js', contentType: 'text/javascript; charset=utf-8' }],
  [KATEX_STYLES_PATH, { root: 'katex', file: 'katex.min.css', contentType: 'text/css; charset=utf-8' }],
  [CONTROL_UI_MATH_SOURCE_PATH, { root: 'web', file: 'control-ui-math-source.js', contentType: 'text/javascript; charset=utf-8' }],
  [CONTROL_UI_MATH_SCRIPT_PATH, { root: 'web', file: 'control-ui-math.js', contentType: 'text/javascript; charset=utf-8' }],
  [CONTROL_UI_MATH_STYLES_PATH, { root: 'web', file: 'control-ui-math.css', contentType: 'text/css; charset=utf-8' }],
]);

// The exact families/styles referenced by the pinned KaTeX 0.19.1 stylesheet.
// No directory listing or request-derived path is used to choose a file. Keep
// fonts/ beside the CSS so its unchanged relative URLs work under the proxy.
const FONT_NAMES = [
  'AMS-Regular', 'Caligraphic-Bold', 'Caligraphic-Regular', 'Fraktur-Bold', 'Fraktur-Regular',
  'Main-Bold', 'Main-BoldItalic', 'Main-Italic', 'Main-Regular', 'Math-BoldItalic', 'Math-Italic',
  'SansSerif-Bold', 'SansSerif-Italic', 'SansSerif-Regular', 'Script-Regular',
  'Size1-Regular', 'Size2-Regular', 'Size3-Regular', 'Size4-Regular', 'Typewriter-Regular',
] as const;
for (const name of FONT_NAMES) {
  for (const [extension, contentType] of [['woff2', 'font/woff2'], ['woff', 'font/woff'], ['ttf', 'font/ttf']] as const) {
    const file = `fonts/KaTeX_${name}.${extension}`;
    assets.set(`${CONTROL_UI_MATH_PREFIX}${file}`, { root: 'katex', file, contentType });
  }
}

const require = createRequire(import.meta.url);
const cache = new Map<string, ControlUiMathAsset>();
const webRoot = fileURLToPath(new URL('../../../web/', import.meta.url));
const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** Static package assets only. Unknown or unavailable assets return undefined;
 * callers must return 404, never forward this private namespace upstream.
 * Successful reads are cached. Missing files are not, which also permits the
 * adapter to appear during development without poisoning the process cache. */
export function readControlUiMathAsset(path: string): ControlUiMathAsset | undefined {
  const source = assets.get(path);
  if (!source) return undefined;
  const cached = cache.get(path);
  if (cached) return cached;
  let fd: number | undefined;
  try {
    // Resolve relative to this module/package, not the service's working dir.
    // KaTeX is a production dependency, included by build-bundle's npm ci.
    const root = realpathSync(source.root === 'web' ? webRoot : dirname(require.resolve('katex')));
    const file = join(root, source.file), real = realpathSync(file), rel = relative(root, real);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || real !== file) return undefined;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ASSET_BYTES) return undefined;
    const body = readFileSync(fd);
    if (body.length > MAX_ASSET_BYTES) return undefined;
    const asset = { body, contentType: source.contentType };
    cache.set(path, asset); return asset;
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** External styles and deferred scripts preserve upstream inline CSP hashes.
 * Deferred classic scripts execute in document order: KaTeX, parser, adapter. */
export function withControlUiMath(html: string, prefix: string): string {
  const insertion = controlUiScriptInsertionPoint(html, 'data-hatchabot-math');
  if (insertion.installed) return html;
  const p = prefix.replace(/\/+$/, '');
  const url = (path: string) => `${p}${path}`.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tags = `<link rel="stylesheet" href="${url(KATEX_STYLES_PATH)}">\n`
    + `<link rel="stylesheet" href="${url(CONTROL_UI_MATH_STYLES_PATH)}">\n`
    + `<script defer src="${url(KATEX_SCRIPT_PATH)}"></script>\n`
    + `<script defer src="${url(CONTROL_UI_MATH_SOURCE_PATH)}"></script>\n`
    + `<script defer data-hatchabot-math src="${url(CONTROL_UI_MATH_SCRIPT_PATH)}"></script>`;
  return html.slice(0, insertion.at) + tags + html.slice(insertion.at);
}
