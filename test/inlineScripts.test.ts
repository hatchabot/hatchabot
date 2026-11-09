import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inlineScripts } from '../scripts/inline-scripts.mjs';

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

  it('reads the real pages: three scripts in index.html, one in join.html', () => {
    expect(inlineScripts(readFileSync('web/index.html', 'utf8'))).toHaveLength(3);
    expect(inlineScripts(readFileSync('web/join.html', 'utf8'))).toHaveLength(1);
  });

  it('stays quick on hostile text', () => {
    const hostile = ['<'.repeat(200000), '<script>' + '<'.repeat(200000), '<p>' + '</scrip'.repeat(30000), '<script>a()</script>'.repeat(20000)];
    for (const h of hostile) {
      const t0 = performance.now();
      try { inlineScripts(h); } catch { /* refused */ }
      expect(performance.now() - t0, h.slice(0, 20)).toBeLessThan(1000);
    }
  });
});
