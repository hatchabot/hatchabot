import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Paths a file finds from its own location (`import.meta`), which an import
 * rewrite does not see (HB-0877). When src/orchestrator/ was sorted into
 * folders (HB-0815), the backup and restore-drill scripts' paths needed one
 * more `../` each, and no test failed for either: Back up now and the drill
 * would have found no script on every install. Each such path in src/ must
 * name a file or folder that exists, and a use of `import.meta` this test
 * does not know fails it, so a new form gets a rule here.
 */

const srcFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? srcFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);

const lit = String.raw`'([^']+)'`;
/** The quoted literals of a captured argument list (", 'a', 'b'"). */
const literals = (list: string): string[] => [...list.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
/** Each form, with how it resolves against the file that holds it; `m[1]` is its one literal, or for `import.meta.dirname` the list of them. */
const FORMS: Array<{ re: RegExp; to: (file: string, m: RegExpMatchArray) => string }> = [
  { re: new RegExp(String.raw`resolve\(fileURLToPath\(import\.meta\.url\), ${lit}\)`, 'g'), to: (f, m) => resolve(f, m[1]!) },
  { re: new RegExp(String.raw`new URL\(${lit}, import\.meta\.url\)`, 'g'), to: (f, m) => fileURLToPath(new URL(m[1]!, pathToFileURL(f))) },
  { re: /resolve\(import\.meta\.dirname((?:, '[^']+')+)\)/g, to: (f, m) => resolve(dirname(f), ...literals(m[1]!)) },
  { re: new RegExp(String.raw`resolve\(dirname\(fileURLToPath\(import\.meta\.url\)\), ${lit}\)`, 'g'), to: (f, m) => resolve(dirname(f), m[1]!) },
  { re: new RegExp(String.raw`createRequire\(import\.meta\.url\)\(${lit}\)`, 'g'), to: (f, m) => resolve(dirname(f), m[1]!) },
];
/** Uses that name no path: a require for packages, and "am I the script that was run". */
const NO_PATH = [/createRequire\(import\.meta\.url\);/, /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/];
const first = (re: RegExp, text: string): RegExpMatchArray => text.matchAll(re).next().value!;

describe('paths found from a file\'s own location', () => {
  it('each form resolves as the code does', () => {
    const f = resolve('src/orchestrator/backups/x.ts');
    expect(FORMS[0]!.to(f, first(FORMS[0]!.re, `resolve(fileURLToPath(import.meta.url), '../../../../scripts/a.sh')`))).toBe(resolve('scripts/a.sh'));
    expect(FORMS[1]!.to(f, first(FORMS[1]!.re, `new URL('../../../docker/b', import.meta.url)`))).toBe(resolve('docker/b'));
    expect(FORMS[2]!.to(resolve('src/index.ts'), first(FORMS[2]!.re, `resolve(import.meta.dirname, '../web/index.html')`))).toBe(resolve('web/index.html'));
    expect(FORMS[2]!.to(resolve('src/api/routes.ts'), first(FORMS[2]!.re, `resolve(import.meta.dirname, '..', '..')`))).toBe(resolve('.'));
    expect(FORMS[3]!.to(resolve('src/cli.ts'), first(FORMS[3]!.re, `resolve(dirname(fileURLToPath(import.meta.url)), '..')`))).toBe(resolve('.'));
    expect(FORMS[4]!.to(resolve('src/domain/v.ts'), first(FORMS[4]!.re, `createRequire(import.meta.url)('../../package.json')`))).toBe(resolve('package.json'));
  });

  it('every one in src/ names something that exists', () => {
    const missing: string[] = [];
    const unknown: string[] = [];
    let found = 0;
    for (const file of srcFiles('src')) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('import.meta')) continue;
      const abs = resolve(file);
      const known = new Set<number>();
      for (const { re, to } of FORMS) {
        for (const m of text.matchAll(re)) {
          found++;
          known.add(text.slice(0, m.index).split('\n').length);
          const target = to(abs, m);
          if (!existsSync(target)) missing.push(`${file}: ${m[0]} → ${target}`);
        }
      }
      text.split('\n').forEach((line, i) => {
        if (!line.includes('import.meta') || /^\s*(\/\/|\*)/.test(line) || known.has(i + 1)) return;
        if (!NO_PATH.some((re) => re.test(line))) unknown.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(missing, 'A path found from the file\'s own location names nothing: fix its ../ after a move.').toEqual([]);
    expect(unknown, 'A use of import.meta this test does not know: add its form to FORMS (or NO_PATH if it names no path).').toEqual([]);
    expect(found).toBeGreaterThanOrEqual(8);
  });
});
