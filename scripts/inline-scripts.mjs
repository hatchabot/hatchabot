// The scripts of the project's own pages (web/*.html), for check-web.mjs and the web tests
// (CodeQL js/bad-tag-filter, HB-0620). It reads no HTML. Every script in these pages is a
// bare `<script>` … `</script>`, and anything else that starts like a script tag fails
// loudly: a type or src, another case, a space before '>', an end tag with no script open,
// a script that never ends. So it can over-read (a `<script>` written in a comment is read
// and checked too) but never skip a script a browser would run: each script tag a browser
// reads starts with the letters "<script", and each of those is read here or refused.
// A script holding "<!--" and then "<script" (the tokenizer's escaped states) would end
// later in a browser than here; what follows then reads as a stray </script> and fails.

const OPEN = '<script>';
const CLOSE = '</script>';

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
 * The code of each script in one of the project's pages, in order.
 * @param {string} html
 * @returns {string[]}
 */
export function inlineScripts(html) {
  const out = [];
  let at = 0;
  for (;;) {
    const lt = html.indexOf('<', at);
    if (lt < 0) return out;
    at = lt + 1;
    if (scriptTagAt(html, lt, true)) refuse(html, lt, 'a script end tag with no script open');
    if (!scriptTagAt(html, lt, false)) continue;
    if (!html.startsWith(OPEN, lt)) refuse(html, lt, 'a script tag that is not a bare <script>');
    const start = lt + OPEN.length;
    let end = start;
    for (;;) {                                 // the body ends at the first "</script", as in a browser
      end = html.indexOf('<', end);
      if (end < 0) refuse(html, lt, 'a script that never ends');
      if (scriptTagAt(html, end, true)) break;
      end++;
    }
    if (!html.startsWith(CLOSE, end)) refuse(html, end, 'a script end tag that is not a bare </script>');
    out.push(html.slice(start, end));
    at = end + CLOSE.length;
  }
}
