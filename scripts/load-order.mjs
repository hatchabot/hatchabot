// What splitting the page's code into classic scripts (HB-0811) makes possible, checked for
// check-web.mjs. The page's scripts share one global scope and run one after another, so:
//
// 1. Code that runs at load may reach only what its own script and the ones before it
//    declare. In one script a function is hoisted to the top; across scripts it exists only
//    once its own script has run, so a call made at load to a function in a later script
//    throws. "Runs at load" is a top-level statement or initialiser, a function it calls
//    (followed through), a callback a call it makes may run at once (forEach, an IIFE), and
//    what a class runs as it is made (its extends, computed keys, static fields and blocks);
//    not a function handed to addEventListener, a timer, a promise or an observer, nor one
//    stored for later. A name a block, loop, catch or switch declares is its own there.
// 2. No name is declared at the top level of two scripts where either is let, const or
//    class: the second script then fails as a whole ("already been declared"), which no
//    syntax check of one file can see. (Two functions of one name: check-web's own check.)
// 3. In its own script, code that runs at load reads a let, const or class only after the
//    statement that declares it (HB-1494): before it the name is there but not yet set, and
//    the read throws, which stops the rest of that script. A function is hoisted, so a call
//    to one is fine; what that function reads at once is followed as in 1.
//
// It errs towards reporting: a name a function only mentions counts as reached.
import { parseAst } from 'vite';

const FN = /^(Arrow)?FunctionExpression$/;
/** Calls that keep a function for later instead of running it. */
const LATER = new Set(['addEventListener', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'then', 'catch', 'finally', 'queueMicrotask', 'observe']);

function names(p) {
  if (!p) return [];
  if (p.type === 'Identifier') return [p.name];
  if (p.type === 'ObjectPattern') return p.properties.flatMap((q) => names(q.type === 'RestElement' ? q.argument : q.value));
  if (p.type === 'ArrayPattern') return p.elements.flatMap(names);
  if (p.type === 'AssignmentPattern') return names(p.left);
  if (p.type === 'RestElement') return names(p.argument);
  return [];
}

/** `bound` and the names a block's statements declare in it (a let, const, class or function; a var too, harmlessly). */
function scoped(bound, statements) {
  const inner = new Set(bound);
  for (const st of statements) {
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) for (const n of names(d.id)) inner.add(n);
    else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) inner.add(st.id.name);
  }
  return inner;
}

/** The names a function body declares for itself (its own, not its inner functions'). */
function declaredWithin(node, into) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'VariableDeclaration') for (const d of node.declarations) for (const n of names(d.id)) into.add(n);
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') { if (node.id) into.add(node.id.name); return; }
  if (FN.test(node.type)) return;
  if (node.type === 'CatchClause' && node.param) for (const n of names(node.param)) into.add(n);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => declaredWithin(c, into));
    else if (v && typeof v.type === 'string') declaredWithin(v, into);
  }
}

/**
 * @param {{ name: string, code: string }[]} scripts a page's scripts, in the order it runs them
 * @returns {string[]} what is wrong, one line each
 */
export function loadOrderProblems(scripts) {
  const problems = [];
  // name -> { at: script index, kind, fn, set, line }; `set`: for a let, const or class,
  // where in its script the name is set (the end of its declarator, or of the class), before
  // which reading it throws; `line`: the line its declaration starts on.
  const declared = new Map();
  const asts = scripts.map((s, at) => {
    const ast = parseAst(s.code);
    const declare = (name, kind, fn, node, set, from = node) => {
      const had = declared.get(name);
      if (had && had.at !== at && (had.kind !== 'function' || kind !== 'function')) {
        problems.push(`${s.name}:${lineOf(s.code, node.start)}: "${name}" is declared at the top of ${scripts[had.at].name} too; as ${kind} in a second script it stops that script from running at all`);
      }
      if (!had || had.at !== at || kind === 'function') declared.set(name, { at, kind, fn, set, line: lineOf(s.code, from.start) });
    };
    for (const n of ast.body) {
      if (n.type === 'FunctionDeclaration') declare(n.id.name, 'function', n, n);
      else if (n.type === 'ClassDeclaration') declare(n.id.name, 'class', null, n, n.end);
      else if (n.type === 'VariableDeclaration') for (const d of n.declarations) for (const id of names(d.id)) declare(id, n.kind, d.init && FN.test(d.init.type) ? d.init : null, n, n.kind === 'var' ? undefined : d.end, d);
    }
    return ast;
  });

  // The names a node mentions at once (refs) and, of those, the ones it calls at once (calls).
  // A name a block, a loop, a catch or a switch declares is its own there, not the script's
  // (HB-1494 review: at the top level, `for (const x of …)` read as a read of a later const x).
  function eager(node, refs, calls, bound) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'FunctionExpression': case 'ArrowFunctionExpression': case 'FunctionDeclaration': return;
      case 'ClassDeclaration': case 'ClassExpression': {
        // What runs as the class is made: what it extends, its computed keys, its static
        // fields and blocks, where its own name is set; not its methods or instance fields.
        eager(node.superClass, refs, calls, bound);
        const inner = node.id ? new Set([...bound, node.id.name]) : bound;
        for (const m of node.body.body) {
          if (m.computed) eager(m.key, refs, calls, inner);
          if (m.type === 'StaticBlock') { const b = new Set(inner); m.body.forEach((st) => declaredWithin(st, b)); m.body.forEach((st) => eager(st, refs, calls, b)); }
          else if (m.type === 'PropertyDefinition' && m.static) eager(m.value, refs, calls, inner);
        }
        return;
      }
      case 'BlockStatement': bound = scoped(bound, node.body); break;
      case 'SwitchStatement': bound = scoped(bound, node.cases.flatMap((c) => c.consequent)); break;
      case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': {
        const d = node.init ?? node.left;
        if (d?.type === 'VariableDeclaration') bound = scoped(bound, [d]);
        break;
      }
      case 'CatchClause': bound = new Set([...bound, ...names(node.param)]); break;
      case 'LabeledStatement': eager(node.body, refs, calls, bound); return;
      case 'BreakStatement': case 'ContinueStatement': return;
      case 'Identifier': if (!bound.has(node.name)) refs.add(node.name); return;
      case 'MemberExpression': eager(node.object, refs, calls, bound); if (node.computed) eager(node.property, refs, calls, bound); return;
      case 'Property': if (node.computed) eager(node.key, refs, calls, bound); eager(node.value, refs, calls, bound); return;
      case 'CallExpression': case 'NewExpression': {
        const c = node.callee;
        const method = c.type === 'MemberExpression' && !c.computed ? c.property.name : c.type === 'Identifier' ? c.name : '';
        const later = LATER.has(method) || /Observer$/.test(method);
        if (FN.test(c.type)) body(c, refs, calls, bound);
        else if (c.type === 'Identifier') { if (!bound.has(c.name)) { refs.add(c.name); calls.add(c.name); } }
        else eager(c, refs, calls, bound);
        for (const a of node.arguments) {
          if (FN.test(a.type)) { if (!later) body(a, refs, calls, bound); }
          else if (a.type === 'Identifier') { if (!bound.has(a.name)) { refs.add(a.name); if (!later) calls.add(a.name); } }
          else eager(a, refs, calls, bound);
        }
        return;
      }
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach((c) => eager(c, refs, calls, bound));
      else if (v && typeof v.type === 'string') eager(v, refs, calls, bound);
    }
  }
  function body(fn, refs, calls, bound) {
    const inner = new Set(bound);
    for (const p of fn.params) for (const n of names(p)) inner.add(n);
    declaredWithin(fn.body, inner);
    eager(fn.body, refs, calls, inner);
  }
  const ofFunction = new Map();
  const reachOf = (name) => {
    if (!ofFunction.has(name)) {
      const r = { refs: new Set(), calls: new Set() };
      ofFunction.set(name, r);
      const fn = declared.get(name)?.fn;
      if (fn) body(fn, r.refs, r.calls, new Set());
    }
    return ofFunction.get(name);
  };

  asts.forEach((ast, at) => {
    const code = scripts[at].code;
    for (const st of ast.body) {
      if (st.type === 'FunctionDeclaration') continue;
      // What runs at once, each from where it is: a declaration's initialisers one by one
      // (`const a = 1, b = a;` reads a once it is set), any other statement as a whole.
      const parts = st.type === 'VariableDeclaration'
        ? st.declarations.filter((d) => d.init && !FN.test(d.init.type)).map((d) => ({ node: d.init, from: d.start }))
        : [{ node: st, from: st.start }];
      for (const { node, from } of parts) {
        const refs = new Set(), calls = new Set();
        eager(node, refs, calls, new Set());
        const path = new Map([...refs].map((n) => [n, [n]]));
        const queue = [...refs], seen = new Set();
        while (queue.length) {
          const n = queue.shift();
          if (seen.has(n)) continue;
          seen.add(n);
          const d = declared.get(n);
          if (!d) continue;
          if (d.at > at) {
            problems.push(`${scripts[at].name}:${lineOf(code, st.start)}: runs at load and reaches ${n} (${path.get(n).join(' → ')}), which ${scripts[d.at].name} declares, a script that runs later`);
            continue;
          }
          if (d.at === at && d.set !== undefined && d.set > from) {
            problems.push(`${scripts[at].name}:${lineOf(code, st.start)}: runs at load and reads ${n} (${path.get(n).join(' → ')}) before its ${d.kind} on line ${d.line} has set it: that read throws, and the rest of ${scripts[at].name} does not run`);
            continue;
          }
          if (!calls.has(n) || !d.fn) continue;
          const r = reachOf(n);
          for (const m of r.calls) calls.add(m);
          for (const m of r.refs) if (!path.has(m)) { path.set(m, [...path.get(n), m]); queue.push(m); }
        }
      }
    }
  });
  return problems;
}

function lineOf(code, offset) {
  return code.slice(0, offset).split('\n').length;
}
