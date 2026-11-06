import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAst } from 'vite';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { registerRoutes } from '../src/api/routes.js';
import { checkOpsDrift } from '../src/ops/opsDrift.js';
import { Store } from '../src/store/store.js';

/**
 * Node ends the process on an unhandled rejection, so one `void x.then(...)`
 * with no failure handler takes every agent's control plane down with it
 * (HB-0278, HB-0374). This reads every `void` call in src/: it ends in a
 * `.catch(...)` or a two-handler `.then(a, b)`, or what it starts from is
 * listed here with the reason it cannot reject. Add to the list only with that
 * reason; a `.catch` is usually shorter.
 */
const CANNOT_REJECT: Record<string, string> = {
  // Lock tails: each is the `run.catch(...)` or `run.then(f, f)` of the line above it.
  tail: 'a queue tail, already caught', turn: 'a queue tail, already caught', settled: 'a queue tail, already caught', next: 'ops/notify.ts: the chain ends in .catch',
  // Their own bodies catch what can fail.
  'this.#reapOneShot': 'catches the docker call', 'this.#settleOneShot': 'catches every docker call, and its callback only resolves',
  browsersNow: 'ends in .catch', syncDocsHeld: 'ends in .catch', runUsageSample: 'ends in .catch',
  // The first of these is proved below, with a store that throws.
  runPausedReplies: 'try/catch', refreshDetectedUrl: 'catches the only await',
  retargetCronSweep: 'try/catch per step', quickCronRetarget: 'try/catch per step',
  postureSweep: 'try/catch per step', checkOpsDrift: 'try/catch per agent', runPendingApp: 'try/catch around each run',
  sink: 'try/catch around the append', explainFailedCheckpoint: 'catches the send',
  'recentTracker.note': 'note() catches everything', 'opsPush.waiting': 'catches its sends; the rest only reads',
  'opsNotifier.notify': 'its chain ends in .catch',
  verifyLater: 'two-handler .then', 'api.stopListener': 'nothing in it rejects', 'worker.terminate': 'resolves once the worker has gone',
  // void (async () => {...})() whose whole body is inside a try/catch.
  'an async function in src/index.ts': 'the tools restart: try/catch',
  'an async function in src/orchestrator/compaction.ts': 'the summarise run: try/catch, and failed() catches its own',
  // Not a promise that matters: a Fastify reply is returned for chaining.
  reply: 'not a rejecting promise',
};

type Node = { type: string; start: number; end: number; [k: string]: any };
/** Through the wrappers that change nothing here: `(x)`, `x!`, `x?.y`. */
function bare(n: Node): Node {
  while (['ParenthesizedExpression', 'TSNonNullExpression', 'ChainExpression'].includes(n.type)) n = n.expression;
  return n;
}
const method = (call: Node): string | undefined => {
  const callee = bare(call.callee);
  return callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : undefined;
};
/** The object a chain's method was called on: `a().then(f)` is `a()`. */
const receiver = (call: Node): Node => bare(bare(call.callee).object);
function handled(call: Node): boolean {
  const m = method(call);
  if (m === 'catch') return true;
  if (m === 'then') return call.arguments.length >= 2;
  // finally passes a rejection on: what it follows decides.
  if (m === 'finally' && receiver(call).type === 'CallExpression') return handled(receiver(call));
  return false;
}
/** The name a chain starts from: `a.b().then(f).finally(g)` is `a.b`, `next.then(f)` is `next`. */
function rootOf(call: Node, text: string, path: string): string {
  let n = call;
  while (n.type === 'CallExpression' && ['then', 'finally', 'catch'].includes(method(n) ?? '')) n = receiver(n);
  if (n.type === 'CallExpression') n = bare(n.callee);
  if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') return `an async function in ${path}`;
  return text.slice(n.start, n.end).replace(/\s+/g, '');
}

/** Every unhandled `void` call in a source text, with the name it starts from. */
function floating(path: string, text: string): Array<{ at: string; root: string }> {
  const out: Array<{ at: string; root: string }> = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    const node = n as Node;
    if (node.type === 'UnaryExpression' && node.operator === 'void') {
      const e = bare(node.argument);
      if (e.type === 'CallExpression' && !handled(e)) {
        const root = rootOf(e, text, path);
        out.push({ at: `${path}:${text.slice(0, node.start).split('\n').length}`, root: /^reply\b/.test(root) ? 'reply' : root });
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(parseAst(text, { lang: 'ts' } as never));
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? sourceFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/**
 * Every unhandled `void` call in src/, read once for the tests below. Parsing
 * and walking all of src/ (over 4 MB) took about 0.9 s here, and each of two
 * tests did it, so the file ran past vitest's 5 s on a busy machine (HB-0505).
 * A file without the word `void` cannot hold one, and is not parsed.
 */
let srcFloating: Array<{ at: string; root: string }> | undefined;
const floatingInSrc = () => (srcFloating ??= sourceFiles('src').flatMap((p) => {
  const text = readFileSync(p, 'utf8');
  return /\bvoid\b/.test(text) ? floating(p, text) : [];
}));

describe('void calls cannot end the process (HB-0374)', () => {
  it('every one in src/ handles a rejection, or is listed with why it cannot reject', () => {
    const bad = floatingInSrc()
      .filter((f) => !Object.hasOwn(CANNOT_REJECT, f.root))
      .map((f) => `${f.at} void ${f.root}(...)`);
    expect(bad).toEqual([]);
  });

  it('every name on the list is still used, so a stale reason does not linger', () => {
    const roots = new Set(floatingInSrc().map((f) => f.root));
    expect(Object.keys(CANNOT_REJECT).filter((k) => !roots.has(k))).toEqual([]);
  });

  it('tells the shapes apart', () => {
    const roots = (code: string) => floating('x.ts', code).map((f) => f.root);
    expect(roots('void a().then(f);')).toEqual(['a']);
    expect(roots('void a().catch(g).then(f);')).toEqual(['a']); // a throw in f is unhandled
    expect(roots('void b.then(f);')).toEqual(['b']);
    expect(roots('void a().finally(f);')).toEqual(['a']);
    expect(roots('void a();')).toEqual(['a']);
    expect(roots('const f = () => void a();')).toEqual(['a']);
    expect(roots('void a().then(f).catch(g);')).toEqual([]);
    expect(roots('void a().then(f, g);')).toEqual([]);
    expect(roots('void a().catch(g).finally(f);')).toEqual([]);
    expect(roots('void a?.b?.then(f).catch(g);')).toEqual([]);
    expect(roots('void (async () => {})();')).toEqual(['an async function in x.ts']);
    expect(roots('void (async () => {})().catch(g);')).toEqual([]);
    expect(roots('let x: void; const y = void 0;')).toEqual([]);
    // The Fastify reply and nothing else that happens to start like it.
    expect(roots('void reply.code(404).send(x);')).toEqual(['reply']);
    expect(roots('void replyToOwner(x).then(f);')).toEqual(['replyToOwner']);
    expect(roots('void replyAll();')).toEqual(['replyAll']);
  });

  describe('what the list says of the timers holds when the database fails (HB-0374)', () => {
    /** The real routes over a store whose reads all throw once `broken` is set, as a full or locked disk's do. */
    async function brokenStore() {
      const store = new Store(new Database(':memory:'));
      const f = Fastify();
      const secrets = { put: async () => {}, get: async () => 'made-up', delete: async () => {} };
      await registerRoutes(f, { store, secrets: secrets as never, providers: new Map(), channel: { pool: { availableCount: () => 0 }, release: async () => {} } as never });
      const fail = () => { throw new Error('SQLITE_FULL: database or disk is full'); };
      for (const m of ['getAppPending', 'getAgent', 'setAppPendingError', 'listBudgetPauses', 'listAllActiveAgents', 'listAdoptPending'] as const) (store as never as Record<string, unknown>)[m] = fail;
      return f as unknown as Record<'runPausedReplies' | 'retargetCronSweep' | 'quickCronRetarget' | 'runPendingApp', (id?: string) => Promise<void>>;
    }

    it('none of them rejects', async () => {
      const app = await brokenStore();
      await expect(app.runPausedReplies!()).resolves.toBeUndefined();
      await expect(app.retargetCronSweep!()).resolves.toBeUndefined();
      await expect(app.quickCronRetarget!()).resolves.toBeUndefined();
      await expect(app.runPendingApp!('a1')).resolves.toBeUndefined();
      // Each can run again: the guard it holds was let go.
      await expect(app.quickCronRetarget!()).resolves.toBeUndefined();
      await expect(app.runPausedReplies!()).resolves.toBeUndefined();
    });

    it('nor does the ops drift check', async () => {
      const store = { listOpsAgents: () => { throw new Error('SQLITE_FULL: database or disk is full'); } };
      const heard: string[] = [];
      await expect(checkOpsDrift({ store: store as never, providerFor: () => { throw new Error('unused'); }, log: (e) => heard.push(e) })).resolves.toBeUndefined();
      expect(heard).toEqual(['ops.drift_check_failed']);
    });
  });
});
