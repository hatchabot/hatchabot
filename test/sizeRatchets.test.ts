import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPage } from '../scripts/page-source.mjs';

/**
 * Ceilings that keep the restructuring from losing ground (HB-0804). Each
 * count may only fall. The test fails above its ceiling, and also below it:
 * the pull request that lowers a count records the new ceiling here, so
 * nothing can creep back.
 */
const CEILING = {
  /** Routes registered in src/api/routes.ts. A new route goes in a feature file, like src/api/inspectRoutes.ts. */
  routesInRoutesTs: 0,
  /** `req.body as` casts in src/api/. Parse the body with a zod schema instead (HB-0814). */
  bodyCastsInApi: 0,
  /** Inline `on…=` handlers in web/index.html: none since HB-0810. Name an action with data-on-<event> (onAction() in a script). */
  inlineHandlersInPage: 0,
};

const read = (p: string) => readFileSync(p, 'utf8');

function countRoutes(text: string): number {
  return text.match(/\bapp\.(get|post|put|patch|delete|head|options|all|route)\b/g)?.length ?? 0;
}
function countBodyCasts(text: string): number {
  return text.match(/\breq\.body\s+as\b/g)?.length ?? 0;
}
/** An inline handler attribute, in markup or in a string the script builds markup from. */
function countInlineHandlers(text: string): number {
  return text.match(/\bon[a-z]+=\\?["']/g)?.length ?? 0;
}

function apiFiles(): string[] {
  return readdirSync('src/api').filter((f) => f.endsWith('.ts')).map((f) => join('src/api', f));
}

const HOW = 'A ceiling in test/sizeRatchets.test.ts.';

describe('size ratchets', () => {
  it('counts each form it is meant to', () => {
    expect(countRoutes(`app.get('/a', h); app.post<{ Body: X }>('/b', h); app.delete('/c', h); this.app.getX`)).toBe(3);
    expect(countBodyCasts(`const b = req.body as { a: string }; const c = (req.body as X).y; req.bodyAs`)).toBe(2);
    expect(countInlineHandlers(`<button onclick="go()">x</button> '<i onchange=\\"f()\\">' el.onclick = f; json="x"`)).toBe(2);
  });

  it('src/api/routes.ts registers no more routes than its ceiling', () => {
    const n = countRoutes(read('src/api/routes.ts'));
    expect(n, `${HOW} Put a new route in a feature file (registerXRoutes(app, ctx: RouteContext), the pattern of src/api/inspectRoutes.ts), not in registerRoutes.`)
      .toBeLessThanOrEqual(CEILING.routesInRoutesTs);
    expect(n, `${HOW} Routes moved out: lower routesInRoutesTs to ${n}.`).toBe(CEILING.routesInRoutesTs);
  });

  it('src/api/ casts no more request bodies than its ceiling', () => {
    const n = apiFiles().reduce((sum, f) => sum + countBodyCasts(read(f)), 0);
    expect(n, `${HOW} Parse the body with a zod schema (zodMessage in src/api/routeContext.ts words the error).`)
      .toBeLessThanOrEqual(CEILING.bodyCastsInApi);
    expect(n, `${HOW} Casts replaced: lower bodyCastsInApi to ${n}.`).toBe(CEILING.bodyCastsInApi);
  });

  it('web/index.html has no more inline handlers than its ceiling', () => {
    const n = countInlineHandlers(readPage('web/index.html'));
    expect(n, `${HOW} Inline handlers keep 'unsafe-inline' in the page's script policy (HB-0812); name an action with data-on-<event> (onAction() in a script).`)
      .toBeLessThanOrEqual(CEILING.inlineHandlersInPage);
    expect(n, `${HOW} Handlers replaced: lower inlineHandlersInPage to ${n}.`).toBe(CEILING.inlineHandlersInPage);
  });
});
