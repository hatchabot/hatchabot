// The scripts of the project's own pages (web/*.html), for check-web.mjs and the web tests
// (CodeQL js/bad-tag-filter, HB-0620). It reads no HTML. Every script in these pages is a
// bare `<script>` … `</script>` or, since HB-0811, exactly `<script src="app/NAME.js"></script>`
// (or "/app/…", the join page's) naming a file in web/app/; anything else that starts like a
// script tag fails loudly: a type or another src, another case, a space before '>', an end
// tag with no script open, a script that never ends. So it can over-read (a `<script>` written in a comment is read
// and checked too) but never skip a script a browser would run: each script tag a browser
// reads starts with the letters "<script", and each of those is read here or refused.
// A script holding "<!--" and then "<script" (the tokenizer's escaped states) would end
// later in a browser than here; what follows then reads as a stray </script> and fails.

const OPEN = '<script>';
const CLOSE = '</script>';
/** The one other script tag the pages may hold: a page script in web/app/, whole, with its end tag. */
const SRC_TAG = /^<script src="(\/?)app\/([a-z0-9-]+\.js)"><\/script>/;

/** Whether a script start tag (or, with `end`, an end tag) begins at i: any case, then what ends a tag name. */
function scriptTagAt(html, i, end) {
  const name = end ? '</script' : '<script';
  if (html.slice(i, i + name.length).toLowerCase() !== name) return false;
  const c = html[i + name.length];
  return c === undefined || c === '>' || c === '/' || c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' ';
}

function refuse(html, i, why) {
  const line = html.slice(0, i).split('\n').length;
  throw new Error(`inline-scripts: line ${line}: ${why}: ${JSON.stringify(html.slice(i, i + 40))}. These pages keep every script a bare <script> … </script>.`);
}

/**
 * The code of each inline script in one of the project's pages, in order. A
 * page script (src) is refused here: use pageScripts to read those too.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScripts(html) {
  return pageScripts(html).map((s) => s.code);
}

/**
 * Each script of one of the project's pages, in order: an inline one's code
 * ({ src: null }), or a page script's name and, given readSrc, its code.
 * With no readSrc a page script is refused (inlineScripts).
 * @param {string} html
 * @param {(name: string) => string} [readSrc]
 * @returns {{ src: string | null, code: string, line: number }[]}
 */
export function pageScripts(html, readSrc) {
  const out = [];
  let at = 0;
  // Each script's line, counted on from the last one's: counted from the top at each, a page
  // of many scripts took time in the square of its length (HB-0850).
  // `nl` is the first newline not yet counted, kept between scripts: looked for again from each
  // script instead, a page with no newline after it was searched to its end at every one.
  let line = 1, nl = html.indexOf('\n');
  const lineAt = (i) => {
    while (nl >= 0 && nl < i) { line++; nl = html.indexOf('\n', nl + 1); }
    return line;
  };
  for (;;) {
    const lt = html.indexOf('<', at);
    if (lt < 0) return out;
    at = lt + 1;
    if (scriptTagAt(html, lt, true)) refuse(html, lt, 'a script end tag with no script open');
    if (!scriptTagAt(html, lt, false)) continue;
    const line = lineAt(lt);
    const src = readSrc ? SRC_TAG.exec(html.slice(lt, lt + 80)) : null;
    if (src) {
      out.push({ src: src[2], code: readSrc(src[2]), line });
      at = lt + src[0].length;
      continue;
    }
    if (!html.startsWith(OPEN, lt)) refuse(html, lt, readSrc ? 'a script tag that is neither a bare <script> nor <script src="app/NAME.js"></script>' : 'a script tag that is not a bare <script>');
    const start = lt + OPEN.length;
    let end = start;
    for (;;) {                                 // the body ends at the first "</script", as in a browser
      end = html.indexOf('<', end);
      if (end < 0) refuse(html, lt, 'a script that never ends');
      if (scriptTagAt(html, end, true)) break;
      end++;
    }
    if (!html.startsWith(CLOSE, end)) refuse(html, end, 'a script end tag that is not a bare </script>');
    out.push({ src: null, code: html.slice(start, end), line });
    at = end + CLOSE.length;
  }
}

/**
 * A page as a browser runs it: each page script's tag replaced by a bare
 * <script> holding the file, so a test or check reading "the page" reads its
 * code too (web/index.html holds markup and styles only since HB-0811).
 * @param {string} html
 * @param {(name: string) => string} readSrc
 * @returns {string}
 */
export function pageWithScripts(html, readSrc) {
  pageScripts(html, readSrc); // refuses a tag it cannot read, as everywhere
  let out = '';
  let at = 0;
  for (;;) {
    const lt = html.indexOf('<script src="', at);
    if (lt < 0) return out + html.slice(at);
    const src = SRC_TAG.exec(html.slice(lt, lt + 80));
    if (!src) { out += html.slice(at, lt + 1); at = lt + 1; continue; }
    out += html.slice(at, lt) + OPEN + '\n' + readSrc(src[2]) + CLOSE;
    at = lt + src[0].length;
  }
}
