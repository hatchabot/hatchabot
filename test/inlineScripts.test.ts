import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inlineScripts, pageScripts, pageWithScripts } from '../scripts/inline-scripts.mjs';

describe('inlineScripts: the page code check-web and the web tests read (HB-0620)', () => {
  it('reads each bare <script> to the first </script>; text in a body is not markup', () => {
    const html = '<p>x</p><script>if (a < b) f("<script", \'<b>\');</script>\n<div><script>\ng()\n</script></div><scripts>no</scripts><script-x>no</script-x>';
    expect(inlineScripts(html)).toEqual(['if (a < b) f("<script", \'<b>\');', '\ng()\n']);
  });

  it('refuses every other shape, so a script a browser runs is never skipped', () => {
    const refused: [string, RegExp][] = [
      ['<script type="module">m()</script>', /not a bare <script>/],
      ['<script src="lib.js"></script>', /not a bare <script>/],
      ['<script type="application/json">{}</script>', /not a bare <script>/],
      ['<SCRIPT>a()</SCRIPT>', /not a bare <script>/],
      ['<script >a()</script>', /not a bare <script>/],
      ['<script\n>a()</script>', /not a bare <script>/],
      ['<script/>a()</script>', /not a bare <script>/],
      ['<script>a()</script >', /end tag that is not a bare/],
      ['<script>a()</SCRIPT>', /end tag that is not a bare/],
      ['<script>a()</script\tx>', /end tag that is not a bare/],
      ['<p>x</p></script>', /no script open/],
      ['<script>a()', /never ends/],
      ['<p>x</p><script', /not a bare <script>/],
    ];
    for (const [html, why] of refused) expect(() => inlineScripts(html), html).toThrow(why);
  });

  it('names the line, and reads a script written in a comment (checked, never skipped)', () => {
    expect(() => inlineScripts('<p>\n\n<script defer>a()</script>')).toThrow(/line 3: a script tag that is not a bare <script>: "<script defer>/);
    expect(inlineScripts('<!-- <script>old()</script> --><script>a()</script>')).toEqual(['old()', 'a()']);
  });

  it('a script holding "<!--" then "<script" fails rather than being cut short quietly', () => {
    // A browser reads past the first </script> here (the escaped states); this reader stops
    // there, so the rest shows up as a stray end tag.
    expect(() => inlineScripts('<script>x = "<!--<script>";</script>y();</script>')).toThrow(/no script open/);
  });

  it('reads the real pages: their scripts are files in web/app/, none inline', () => {
    // Since HB-0811 the pages hold no inline script: each names its files in web/app/.
    const read = (name: string) => readFileSync(`web/app/${name}`, 'utf8');
    const index = pageScripts(readFileSync('web/index.html', 'utf8'), read);
    expect(index.length).toBeGreaterThan(10);
    expect(index.every((s) => s.src !== null && s.code.length > 0)).toBe(true);
    expect(index.map((s) => s.src).slice(0, 2)).toEqual(['theme.js', 'core.js']);
    expect(pageScripts(readFileSync('web/join.html', 'utf8'), read).map((s) => s.src)).toEqual(['theme.js', 'join.js']);
    // Without a reader, a page script is refused rather than skipped.
    expect(() => inlineScripts(readFileSync('web/index.html', 'utf8'))).toThrow(/not a bare <script>/);
  });

  it('reads a page script by its file, exactly that shape, and puts it in place for a reader of the page (HB-0811)', () => {
    const files: Record<string, string> = { 'a.js': 'a()', 'b-2.js': 'b()' };
    const read = (name: string) => { if (!(name in files)) throw new Error(`no ${name}`); return files[name]!; };
    const html = '<p>x</p><script src="app/a.js"></script>\n<script src="/app/b-2.js"></script><script>c()</script>';
    expect(pageScripts(html, read)).toEqual([
      { src: 'a.js', code: 'a()', line: 1 }, { src: 'b-2.js', code: 'b()', line: 2 }, { src: null, code: 'c()', line: 2 },
    ]);
    expect(pageWithScripts(html, read)).toBe('<p>x</p><script>\na()</script>\n<script>\nb()</script><script>c()</script>');
    for (const tag of ['<script src="app/a.js" defer></script>', '<script src="app/../a.js"></script>', '<script src="app/A.js"></script>',
      '<script src="lib/a.js"></script>', '<script src="https://x.example/app/a.js"></script>', '<script src="app/a.js"></script >', "<script src='app/a.js'></script>"]) {
      expect(() => pageScripts(tag, read), tag).toThrow(/neither a bare <script> nor|not a bare/);
    }
    expect(() => pageScripts('<script src="app/gone.js"></script>', read)).toThrow(/no gone\.js/);
  });

  it('gives each script the line it starts on', () => {
    const html = '<script>a()</script><script>b()</script>\n\n<p>\n<script>\nc()\n</script>\n<script src="app/core.js"></script>';
    expect(pageScripts(html, (name) => `// ${name}`).map((x) => [x.src, x.line])).toEqual([[null, 1], [null, 1], [null, 4], ['core.js', 7]]);
  });

  it('stays quick on hostile text', () => {
    // Big enough that time in the square of the length shows whatever the machine: a page of
    // 160,000 scripts took 4 s in each function when every script's line was counted from the
    // top (HB-0850), and takes about 50 ms now. Each function is timed on its own.
    const hostile = ['<'.repeat(1_600_000), '<script>' + '<'.repeat(1_600_000), '<p>' + '</scrip'.repeat(240_000), '<script>a()</script>'.repeat(160_000)];
    for (const h of hostile) {
      for (const [name, read] of [['inlineScripts', () => inlineScripts(h)], ['pageScripts', () => pageScripts(h, () => '')]] as const) {
        const t0 = performance.now();
        try { read(); } catch { /* refused */ }
        expect(performance.now() - t0, `${name}: ${h.slice(0, 20)}`).toBeLessThan(1000);
      }
    }
  });
});
