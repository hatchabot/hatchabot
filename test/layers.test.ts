import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/**
 * The layers of src/ and the direction they may import in
 * (docs/architecture.md, "Intended dependency direction"; HB-0803):
 *
 *   api  ->  orchestrator  ->  providers, openclaw, channels, embedder, ops, mgmt
 *     ->  store  ->  domain, config, secrets, util
 *
 * A folder may import its own rank or any lower one, never a higher one.
 * Type-only and dynamic imports count too: a type from a higher layer still
 * ties the lower one to it. The files at the top of src/ (index, cli, doctor)
 * may import anything; envCompat.ts is a leaf every layer may use.
 *
 * mgmt sits with ops: its tool list is data the ops agent serves, and the
 * broker needs only rules from src/domain/.
 *
 * KNOWN is for a backwards import that cannot be fixed in the pull request
 * that finds it. It was emptied by HB-0805 and should stay empty; an entry
 * that no longer exists fails the test, so it can only shrink.
 */
const RANK: Record<string, number> = {
  domain: 0, config: 0, secrets: 0, util: 0, envCompat: 0,
  store: 1,
  providers: 2, openclaw: 2, channels: 2, embedder: 2, ops: 2, mgmt: 2,
  orchestrator: 3,
  api: 4,
  index: 9, cli: 9, doctor: 9,
};

/** `importing file -> imported module`, both relative to src/. */
const KNOWN = new Set<string>([]);

const SRC = resolve(import.meta.dirname, '../src');

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}

/** Every relative module a file names: static, re-export, side-effect, dynamic and `import('…')` types. */
function importsOf(text: string): string[] {
  const out: string[] = [];
  const forms = [
    /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of forms) for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

/** The layer a path under src/ belongs to: its first folder, or the file's own name at the top. */
function layerOf(srcRelative: string): string {
  const [first, ...rest] = srcRelative.split('/');
  return rest.length ? first! : first!.replace(/\.ts$/, '');
}

/** Each backwards import in the tree, as `file -> module`. */
function backwards(): string[] {
  const out: string[] = [];
  for (const file of tsFiles(SRC)) {
    const from = relative(SRC, file);
    const fromRank = RANK[layerOf(from)];
    for (const spec of importsOf(readFileSync(file, 'utf8'))) {
      const to = relative(SRC, resolve(dirname(file), spec)).replace(/\.js$/, '.ts');
      if (to.startsWith('..')) continue;
      const toRank = RANK[layerOf(to)];
      if (fromRank === undefined || toRank === undefined) {
        out.push(`${from} -> ${to} (a layer this test has no rank for: add it to RANK)`);
        continue;
      }
      if (toRank > fromRank) out.push(`${from} -> ${to}`);
    }
  }
  return [...new Set(out)];
}

describe('the import direction between layers', () => {
  it('reads every import form, and only relative ones', () => {
    const text = [
      `import { a } from '../orchestrator/a.js';`,
      `import type { B } from "../store/store.js";`,
      `export { c } from './c.js';`,
      `import '../ops/side.js';`,
      `const m = await import('../api/m.js');`,
      `type T = import('../orchestrator/browser.js').BrowserSpec;`,
      `import {\n  d,\n  e,\n} from '../domain/types.js';`,
      `import Fastify from 'fastify';`,
      `import { join } from 'node:path';`,
    ].join('\n');
    expect(importsOf(text).sort()).toEqual([
      '../api/m.js', '../domain/types.js', '../ops/side.js', '../orchestrator/a.js',
      '../orchestrator/browser.js', '../store/store.js', './c.js',
    ]);
  });

  it('places top-level files and folders in their layers', () => {
    expect(layerOf('api/routes.ts')).toBe('api');
    expect(layerOf('orchestrator/sub/x.ts')).toBe('orchestrator');
    expect(layerOf('index.ts')).toBe('index');
    expect(layerOf('envCompat.ts')).toBe('envCompat');
  });

  it('has a rank for every folder in src/', () => {
    const layers = readdirSync(SRC, { withFileTypes: true })
      .map((e) => (e.isDirectory() ? e.name : e.name.replace(/\.ts$/, '')));
    expect(layers.filter((l) => RANK[l] === undefined)).toEqual([]);
  });

  it('no layer imports a higher one, beyond the known list', () => {
    const found = backwards();
    const added = found.filter((b) => !KNOWN.has(b));
    expect(added, 'A lower layer imports a higher one (docs/architecture.md, "Intended dependency direction"). '
      + 'Move what it needs down to the lower layer, or to src/domain/, instead of adding to KNOWN.').toEqual([]);
  });

  it('the known list names only imports that still exist (it only shrinks)', () => {
    const found = new Set(backwards());
    const gone = [...KNOWN].filter((k) => !found.has(k));
    expect(gone, 'Fixed: delete these from KNOWN in test/layers.test.ts.').toEqual([]);
  });
});
