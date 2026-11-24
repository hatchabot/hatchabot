// The project's pages with their scripts (HB-0811), read from disk: for check-web.mjs,
// the click-through and the tests that read "the page" (web/index.html holds markup and
// styles; its code is in web/app/).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pageScripts, pageWithScripts } from './inline-scripts.mjs';

const reader = (page) => (name) => readFileSync(join(dirname(page), 'app', name), 'utf8');

/** A page's text with each page script's code in place of its tag. */
export function readPage(page) {
  return pageWithScripts(readFileSync(page, 'utf8'), reader(page));
}

/** A page's scripts in order: { src, code, line } (src null for an inline one). */
export function readPageScripts(page) {
  return pageScripts(readFileSync(page, 'utf8'), reader(page));
}
