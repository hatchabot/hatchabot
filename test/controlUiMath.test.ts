import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_UI_MATH_PREFIX, CONTROL_UI_MATH_SCRIPT_PATH, CONTROL_UI_MATH_SOURCE_PATH, CONTROL_UI_MATH_STYLES_PATH,
  KATEX_SCRIPT_PATH, KATEX_STYLES_PATH, readControlUiMathAsset, withControlUiMath } from '../src/api/controlUiMath.js';

const require = createRequire(import.meta.url);

describe('local Control UI math assets', () => {
  it('loads exact production-pinned KaTeX bytes from the package', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies.katex).toBe('0.19.1');
    expect(pkg.devDependencies.katex).toBeUndefined();
    const dist = dirname(require.resolve('katex'));
    expect(readControlUiMathAsset(KATEX_SCRIPT_PATH)).toEqual({ contentType: 'text/javascript; charset=utf-8', body: readFileSync(join(dist, 'katex.min.js')) });
    expect(readControlUiMathAsset(KATEX_STYLES_PATH)).toEqual({ contentType: 'text/css; charset=utf-8', body: readFileSync(join(dist, 'katex.min.css')) });
    expect(readControlUiMathAsset(KATEX_SCRIPT_PATH)).toBe(readControlUiMathAsset(KATEX_SCRIPT_PATH));
  });

  it('serves only the three repository adapter assets with their expected MIME types', () => {
    for (const [path, file, contentType] of [
      [CONTROL_UI_MATH_SOURCE_PATH, 'control-ui-math-source.js', 'text/javascript; charset=utf-8'],
      [CONTROL_UI_MATH_SCRIPT_PATH, 'control-ui-math.js', 'text/javascript; charset=utf-8'],
      [CONTROL_UI_MATH_STYLES_PATH, 'control-ui-math.css', 'text/css; charset=utf-8'],
    ]) {
      expect(readControlUiMathAsset(path!), file).toEqual({ contentType, body: readFileSync(`web/${file}`) });
    }
  });

  it('serves every unchanged CSS-relative font URL at the authenticated console prefix', () => {
    const css = readControlUiMathAsset(KATEX_STYLES_PATH)!.body.toString('utf8');
    const fonts = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1]!.replace(/^['"]|['"]$/g, ''));
    expect(fonts).toHaveLength(60);
    const prefix = 'https://example.test/v1/agents/garden-notes/ui';
    for (const font of fonts) {
      const url = new URL(font, `${prefix}${KATEX_STYLES_PATH}`);
      expect(url.origin).toBe('https://example.test');
      expect(url.pathname).toBe(`/v1/agents/garden-notes/ui${CONTROL_UI_MATH_PREFIX}${font}`);
      const asset = readControlUiMathAsset(`${CONTROL_UI_MATH_PREFIX}${font}`);
      expect(asset, font).toBeDefined();
      expect(asset!.contentType).toBe(`font/${font.split('.').at(-1)}`);
      expect(asset!.body.length).toBeGreaterThan(100);
    }
  });

  it.each([
    '/__hatchabot/math/../package.json', '/__hatchabot/math/../../.env', '/__hatchabot/math/%2e%2e/package.json',
    '/__hatchabot/math/fonts/../../katex.min.js', '/__hatchabot/math/fonts/KaTeX_Main-Regular.woff2/other',
    '/__hatchabot/math/fonts/KaTeX_Unknown-Regular.woff2', '/__hatchabot/math/fonts/KaTeX_Main-Regular.otf',
    '/__hatchabot/math/katex.min.js.map', '/__hatchabot/math/katex.min.js?path=../../.env',
    '/__hatchabot/math/katex.min.js\0', '/__hatchabot/math//katex.min.js', '/__hatchabot/math/contrib/auto-render.min.js',
    '/__hatchabot/math/README.md', '/__hatchabot/math/LICENSE', '/__hatchabot/math/package.json',
    '/__hatchabot/math/control-ui-math.js/../index.html', '/web/index.html', '/__proto__',
  ])('refuses non-allowlisted path %s', (path) => {
    expect(readControlUiMathAsset(path)).toBeUndefined();
  });
});

describe('Control UI math document injection', () => {
  const prefix = '/v1/agents/garden-notes/ui';
  it('loads both styles and deferred scripts in order without changing inline code or app URLs', () => {
    const inline = '<script nonce="existing">window.boot = "< & quoted";</script>';
    const app = '<script type="module" src="/assets/app.js"></script>';
    const page = `<html><head>${inline}${app}</head><body>Chat</body></html>`;
    const out = withControlUiMath(page, prefix);
    for (const path of [KATEX_STYLES_PATH, CONTROL_UI_MATH_STYLES_PATH]) expect(out).toContain(`<link rel="stylesheet" href="${prefix}${path}">`);
    expect(out).toContain(`<script defer src="${prefix}${KATEX_SCRIPT_PATH}"></script>`);
    expect(out).toContain(`<script defer src="${prefix}${CONTROL_UI_MATH_SOURCE_PATH}"></script>`);
    expect(out).toContain(`<script defer data-hatchabot-math src="${prefix}${CONTROL_UI_MATH_SCRIPT_PATH}"></script>`);
    expect(out.indexOf(KATEX_SCRIPT_PATH)).toBeLessThan(out.indexOf(CONTROL_UI_MATH_SOURCE_PATH));
    expect(out.indexOf(CONTROL_UI_MATH_SOURCE_PATH)).toBeLessThan(out.indexOf(CONTROL_UI_MATH_SCRIPT_PATH));
    expect(out.indexOf(CONTROL_UI_MATH_SCRIPT_PATH)).toBeLessThan(out.indexOf(inline));
    expect(out).toContain(inline); expect(out).toContain(app);
    expect(out).not.toMatch(/onload=|https:\/\/|unsafe-inline/);
    expect(withControlUiMath(out, prefix)).toBe(out);
  });

  it('handles script-free documents and prefix slashes without adding a second origin', () => {
    const page = '<html><head><title>Chat</title></head><body>Messages</body></html>';
    const out = withControlUiMath(page, prefix + '///');
    expect(out).toContain(`${prefix}${KATEX_SCRIPT_PATH}`);
    expect(out.indexOf(CONTROL_UI_MATH_SCRIPT_PATH)).toBeLessThan(out.indexOf('</head>'));
    expect(withControlUiMath('<body>Messages</body>', prefix)).toContain(`</script><body>Messages</body>`);
  });

  it('escapes a prefix as an HTML attribute without touching the original document', () => {
    const page = '<head><script>window.literal = "keep me";</script></head>';
    const out = withControlUiMath(page, '/x"<&>');
    expect(out).toContain('/x&quot;&lt;&amp;&gt;/__hatchabot/math/katex.min.js');
    expect(out).toContain('<script>window.literal = "keep me";</script>');
  });

  it.each([
    '<!-- example <script data-hatchabot-math>ignored</script> -->',
    '<template><script data-hatchabot-math>inert</script></template>',
    '<template><template><script>nested</script></template></template>',
    '<style>body::before{content:"<script data-hatchabot-math>"}</style>',
    '<textarea><script data-hatchabot-math>literal</script></textarea>',
    '<title>How a <script> works</title>',
  ])('injects outside inert markup without changing it: %s', (inert) => {
    const app = '<script type="module" src="/app.js"></script>';
    const page = `<!doctype html><html><head>${inert}${app}</head><body>Chat</body></html>`;
    const out = withControlUiMath(page, prefix);
    expect(out).toContain(inert);
    expect(out.indexOf(KATEX_STYLES_PATH)).toBeGreaterThan(out.indexOf(inert) + inert.length);
    expect(out.indexOf(CONTROL_UI_MATH_SCRIPT_PATH)).toBeLessThan(out.indexOf(app));
    expect(out.startsWith('<!doctype html>')).toBe(true);
    expect(withControlUiMath(out, prefix)).toBe(out);
  });

  it('does not read a quoted attribute value as an installed adapter marker', () => {
    const app = '<script data-description="example > data-hatchabot-math" src="/app.js"></script>';
    const out = withControlUiMath(`<head>${app}</head>`, prefix);
    expect(out).toContain(app);
    expect(out.indexOf(CONTROL_UI_MATH_SCRIPT_PATH)).toBeLessThan(out.indexOf(app));
    expect(withControlUiMath(out, prefix)).toBe(out);
  });

  it('preserves the leading doctype without an explicit head or script', () => {
    for (const page of ['<!doctype html><html><body>Chat</body></html>', '<!DOCTYPE html><html>Chat</html>']) {
      const out = withControlUiMath(page, prefix);
      expect(out.slice(0, 15).toLowerCase()).toBe('<!doctype html>');
      expect(out).toContain(CONTROL_UI_MATH_SCRIPT_PATH);
      expect(withControlUiMath(out, prefix)).toBe(out);
    }
  });
});
