// What splitting the page's code into classic scripts (HB-0811) makes possible, checked for
// check-web.mjs. The page's scripts share one global scope and run one after another, so:
//
// 1. Code that runs at load may reach only what its own script and the ones before it
//    declare. In one script a function is hoisted to the top; across scripts it exists only
//    once its own script has run, so a call made at load to a function in a later script
//    throws. "Runs at load" is a top-level statement or initialiser, a function it calls
//    (followed through), and a callback a call it makes may run at once (forEach, an IIFE);
//    not a function handed to addEventListener, a timer, a promise or an observer, nor one
//    stored for later.
// 2. No name is declared at the top level of two scripts where either is let, const or
//    class: the second script then fails as a whole ("already been declared"), which no
//    syntax check of one file can see. (Two functions of one name: check-web's own check.)
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
  const declared = new Map(); // name -> { at: script index, kind, fn }
  const asts = scripts.map((s, at) => {
    const ast = parseAst(s.code);
    const declare = (name, kind, fn, node) => {
      const had = declared.get(name);
      if (had && had.at !== at && (had.kind !== 'function' || kind !== 'function')) {
        problems.push(`${s.name}:${lineOf(s.code, node.start)}: "${name}" is declared at the top of ${scripts[had.at].name} too; as ${kind} in a second script it stops that script from running at all`);
      }
      if (!had || had.at !== at || kind === 'function') declared.set(name, { at, kind, fn });
    };
    for (const n of ast.body) {
      if (n.type === 'FunctionDeclaration') declare(n.id.name, 'function', n, n);
      else if (n.type === 'ClassDeclaration') declare(n.id.name, 'class', null, n);
      else if (n.type === 'VariableDeclaration') for (const d of n.declarations) for (const id of names(d.id)) declare(id, n.kind, d.init && FN.test(d.init.type) ? d.init : null, n);
    }
    return ast;
  });

  // The names a node mentions at once (refs) and, of those, the ones it calls at once (calls).
  function eager(node, refs, calls, bound) {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'FunctionExpression': case 'ArrowFunctionExpression': case 'FunctionDeclaration': case 'ClassDeclaration': case 'ClassExpression': return;
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
    for (const st of ast.body) {
      if (st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') continue;
      const refs = new Set(), calls = new Set();
      if (st.type === 'VariableDeclaration') for (const d of st.declarations) { if (d.init && !FN.test(d.init.type)) eager(d.init, refs, calls, new Set()); }
      else eager(st, refs, calls, new Set());
      const path = new Map([...refs].map((n) => [n, [n]]));
      const queue = [...refs], seen = new Set();
      while (queue.length) {
        const n = queue.shift();
        if (seen.has(n)) continue;
        seen.add(n);
        const d = declared.get(n);
        if (!d) continue;
        if (d.at > at) {
          problems.push(`${scripts[at].name}:${lineOf(scripts[at].code, st.start)}: runs at load and reaches ${n} (${path.get(n).join(' → ')}), which ${scripts[d.at].name} declares, a script that runs later`);
          continue;
        }
        if (!calls.has(n) || !d.fn) continue;
        const r = reachOf(n);
        for (const m of r.calls) calls.add(m);
        for (const m of r.refs) if (!path.has(m)) { path.set(m, [...path.get(n), m]); queue.push(m); }
      }
    }
  });
  return problems;
}

function lineOf(code, offset) {
  return code.slice(0, offset).split('\n').length;
}
