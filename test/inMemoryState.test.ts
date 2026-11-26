import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The table of in-memory state is held to the code (HB-0809,
 * docs/architecture.md, "In-memory state, sorted").
 *
 * Every Map and Set that outlives a request is sorted there: a lock, a
 * cache, or a hold whose loss at a restart leaves something wrong. A hold
 * may not be in memory only. Nothing stops the next Map from being one but
 * the question being asked, so this test asks it: a Map or Set that
 * outlives a request and is not in the table fails here, with what to do.
 *
 * What it finds: an empty `new Map()` or `new Set()` (Weak ones too), or a
 * `keyedLock()` (src/util/queues.ts: a Map of turns of its own), kept
 *   - at the top of a module,
 *   - as a field of a class,
 *   - at the top of a function that builds something long-lived
 *     (`registerX`, `createX`, `makeX`: the routes, a service, a watch).
 * One filled where it is declared (`new Set(['a', 'b'])`) is a fixed list,
 * not state. One inside a handler or any other function is gone when that
 * returns. It asks that a row's State cell names it, in any table of the
 * section: a mention in the prose around them is no row. Where a Map moves
 * to another file its row's "Where" should follow, but the test does not
 * ask which file a row gives.
 */
const SPEC = 'docs/architecture.md';
const read = (p: string) => readFileSync(p, 'utf8');

/**
 * Not state of this process: found by the same patterns, in a place the
 * patterns cannot tell apart.
 */
const NOT_STATE: Record<string, string[]> = {
  // Scripts that run inside an agent's container, kept here as text.
  'src/orchestrator/conversation/webChat.ts': ['pending', 'seen'],
  'src/orchestrator/usage/usage.ts': ['seen'],
  'src/orchestrator/memory/transcript.ts': ['seen', 'fromDb'],
  // The mock machine of the tests, and the two command-line programs (each a process of its own, that ends).
  'src/providers/mockProvider.ts': ['*'],
  'src/cli.ts': ['*'],
  'src/doctor.ts': ['*'],
};

interface Found { file: string; line: number; name: string }

const EMPTY = String.raw`(?:new (?:Map|Set|WeakMap|WeakSet)(?:<.*>)?\(\)|keyedLock\()`;
const MODULE = new RegExp(String.raw`^(?:export )?(?:const|let) ([A-Za-z_$][\w$]*)(?:: [^=]+)? = ${EMPTY}`);
const FIELD = new RegExp(String.raw`^  (?:(?:readonly|private|protected|public|static) )*(#?[A-Za-z_$][\w$]*)(?:: [^=]+)? = ${EMPTY}`);
const IN_FACTORY = new RegExp(String.raw`^  (?:const|let) ([A-Za-z_$][\w$]*)(?:: [^=]+)? = (?:[\w.]+ \?\? )?${EMPTY}`);
const TOP_LEVEL_NAME = /^(?:export )?(?:default )?(?:async )?function\*? ([A-Za-z_$][\w$]*)|^(?:export )?(?:abstract )?class ([A-Za-z_$][\w$]*)|^(?:export )?const ([A-Za-z_$][\w$]*) = /;
const FACTORY = /^(?:register|create|make)[A-Z]/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** The Maps and Sets of `text` that outlive a request (see the top of this file). */
function longLived(file: string, text: string): Found[] {
  const out: Found[] = [];
  let within: { name: string; kind: 'function' | 'class' | 'const' } | undefined;
  text.split('\n').forEach((raw, i) => {
    const top = TOP_LEVEL_NAME.exec(raw);
    if (top) within = top[1] ? { name: top[1], kind: 'function' } : top[2] ? { name: top[2], kind: 'class' } : { name: top[3]!, kind: 'const' };
    const name = MODULE.exec(raw)?.[1]
      ?? (within?.kind === 'class' ? FIELD.exec(raw)?.[1] : undefined)
      ?? (within?.kind === 'function' && FACTORY.test(within.name) ? IN_FACTORY.exec(raw)?.[1] : undefined);
    if (name) out.push({ file, line: i + 1, name });
  });
  return out;
}

/**
 * The section of the spec, and the rows of its state tables: the tables
 * with a "Kind" column, each row as its state cell and its kind. (The table
 * of former holds has no such column: what it names is no longer in memory.)
 */
function sorted(): { section: string; rows: Array<{ state: string; kind: string }> } {
  const doc = read(SPEC);
  const from = doc.indexOf('\n## In-memory state, sorted');
  const to = doc.indexOf('\n## ', from + 1);
  const section = from < 0 ? '' : doc.slice(from, to < 0 ? undefined : to);
  const cells = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());
  const rows: Array<{ state: string; kind: string }> = [];
  let kindAt = -1;
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) { kindAt = -1; continue; }
    const row = cells(line);
    if (row.includes('Kind') && row[0] === 'State') { kindAt = row.indexOf('Kind'); continue; }
    if (kindAt < 0 || /^-+$/.test(row[0] ?? '')) continue;
    rows.push({ state: row[0] ?? '', kind: row[kindAt] ?? '' });
  }
  return { section, rows };
}
const names = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

describe('in-memory state is sorted (HB-0809)', () => {
  it('finds what outlives a request, and nothing else', () => {
    const found = longLived('x.ts', [
      'const cache = new Map<string, number>();',
      'export const busy = new Set<string>();',
      'const seen = new WeakMap<object, Map<string, number>>();',
      "const WORDS = new Set(['a', 'b']);", // a fixed list
      'const rowTurns = keyedLock();',
      'export function registerThings(app: App) {',
      '  const turns = new Map<string, Promise<unknown>>();',
      '  const providers = deps.providers ?? new Map<string, Provider>();',
      '  const applies = keyedLock({ refusal: () => new Error("busy") });',
      '  app.get("/x", async () => {',
      '    const local = new Set<string>();', // a handler's own
      '  });',
      '}',
      'export function summarize(rows: Row[]) {',
      '  const byDay = new Map<string, number>();', // gone when it returns
      '}',
      'export class Keeper {',
      '  readonly #last = new Map<string, number>();',
      '  private readonly open = new Set<Socket>();',
      '  readonly #nameTurns = keyedLock();',
      '  sweep() {',
      '    const gone = new Set<string>();',
      '  }',
      '}',
    ].join('\n')).map((f) => f.name);
    expect(found).toEqual(['cache', 'busy', 'seen', 'rowTurns', 'turns', 'providers', 'applies', '#last', 'open', '#nameTurns']);
  });

  it('every Map and Set that outlives a request has a row in the table', () => {
    const { section, rows } = sorted();
    expect(section, `${SPEC} has no "In-memory state, sorted" section`).not.toBe('');
    // A row's State cell names it: a word of the prose around the tables sorts nothing.
    const inRows = new Set(rows.flatMap((r) => names(r.state)));
    const missing = sourceFiles('src').flatMap((file) => {
      const skip = NOT_STATE[file] ?? [];
      if (skip.includes('*')) return [];
      return longLived(file, read(file)).filter((f) => !skip.includes(f.name) && !inRows.has(f.name));
    }).map((f) => `${f.file}:${f.line} ${f.name}`);
    expect(missing, [
      `These outlive a request and are not sorted in ${SPEC} ("In-memory state, sorted").`,
      'Give each a row: a lock (it orders or carries work that ends with the process) or a cache (lost, it is worked out again).',
      'If losing it at a restart would leave an agent, a count, a cap, a model or a limit wrong, it is a hold: keep it in the store',
      '(agent_holds, Store.setAgentHold) or have the start make up for it, and test it as test/holdsAcrossRestart.test.ts does.',
    ].join('\n')).toEqual([]);
  });

  it('every row names state that is still in the code', () => {
    const { rows } = sorted();
    expect(rows.length).toBeGreaterThan(50);
    const all = sourceFiles('src').map(read).join('\n');
    const gone = rows.flatMap((r) => names(r.state)).filter((n) => !new RegExp(`(?<![\\w$#])${n.replace(/[$#]/g, '\\$&')}\\b`).test(all));
    expect(gone, `Rows of ${SPEC} ("In-memory state, sorted") for state that is gone or renamed: take the row out, or name it as it is now.`).toEqual([]);
  });

  it('no row is a hold: what a restart may not lose is not in memory', () => {
    const { rows } = sorted();
    const holds = rows.filter((r) => /\bhold\b/i.test(r.kind)).map((r) => r.state);
    expect(holds, `A hold is in the store or made up for at the start (${SPEC}), never a Map or Set alone.`).toEqual([]);
    // A lock, a cache, or one each for the names a row lists.
    const unknown = rows.filter((r) => !/^(lock|cache)(, (lock|cache))*$/.test(r.kind)).map((r) => `${r.state}: ${r.kind}`);
    expect(unknown, 'Each row is a lock or a cache (one kind for each name where a row lists several of different kinds).').toEqual([]);
  });
});
