/** One script of a page: an inline one's code (src null), or a page script's file name in web/app/ and its code. */
export interface PageScript { src: string | null; code: string; line: number }
/** The code of each inline script in one of the project's pages; throws on any script tag that is not a bare <script> … </script>. */
export function inlineScripts(html: string): string[];
/** Each script of a page, in order; a page script (<script src="app/NAME.js"></script>) read by readSrc. Throws on any other script tag. */
export function pageScripts(html: string, readSrc?: (name: string) => string): PageScript[];
/** The page with each page script's tag replaced by a bare <script> holding its file. */
export function pageWithScripts(html: string, readSrc: (name: string) => string): string;
