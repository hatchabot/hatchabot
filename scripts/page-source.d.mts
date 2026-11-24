import type { PageScript } from './inline-scripts.mjs';
/** A page's text (web/index.html, web/join.html) with each page script's code in place of its tag (HB-0811). */
export function readPage(page: string): string;
/** A page's scripts in the order it runs them. */
export function readPageScripts(page: string): PageScript[];
