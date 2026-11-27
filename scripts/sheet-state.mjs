// The agent sheet's forms belong to one agent at a time (HB-0644), checked for check-web.mjs.
// One set of edit forms serves every agent; whose they are is the page's editAgentId, which
// changes whenever another agent's forms are filled (prepareEdit). A save or a read learns
// its agent once, at the press, from its handle (sheetSave(), sheetRead(): f.id), and what
// comes back goes into the forms only through that handle, which refuses an answer for
// an agent no longer shown or for a read asked again since (web/app/connections.js, forAgent).
// So, in the page's scripts:
//
// 1. No async function reads editAgentId, before its first await or after, and no function
//    that runs later does: one an async function makes (a closure runs later), one handed to
//    a call that runs it later (LATER, and the page's own, found by deferringParams:
//    v2FollowOp's onEnd, handOverBot's say, saveFromServer's check, pageSignedIn's show,
//    setupSignIn's onToken, a read's own test given to sheetRead), by name too (`.then(done)`),
//    or one set as an element's onload. By then it may name another agent, and an answer read
//    against it lands on that agent's forms (HB-0584: one agent's folders sent to another;
//    HB-0590: one agent's model menu drawn for another). The handles read it, in plain
//    functions, at the press. A listener (addEventListener) set by a plain function is a press
//    of its own: it reads the agent when its event comes.
// 2. After an await, nothing draws into the edit forms but inside a handle's draw or fill:
//    no call of sheetFill, or of a function that fills the forms (formFillers: a plain
//    function that takes an element of the edit dialog by its id, or calls one that does,
//    unless NOT_FILLERS names it, with why), and none of them is handed to a call that runs
//    it later.
// 3. Nothing touches the shared error box (editErr: $('editErr'), $(`editErr`),
//    getElementById('editErr')) after an await but inside a handle's draw or fill (or by its
//    fail): written by hand, an error lands under another agent's forms, or under forms out
//    of sight. Taking it is enough, as an element held to write later is one written.
// 4. The unsaved-edit baselines are noted only by sheetFill (v2SheetBaseline) and a save's
//    press only by sheetSave (v2SheetSaving), so a fill cannot forget one on some path.
// 5. No handle is taken after an await or in a function that runs later (sheetSave(),
//    sheetRead() there): it would be for the agent shown by then, not the one pressed for.
//    LATE_READS names the reads that mean to be (a list read again for the agent shown). Nor,
//    there, is a button held (`.hold()`, sheetPress()), or set as an agent has it
//    (sheetButton()) but inside a handle's draw or fill: for the agent shown by then, it holds
//    or sets that agent's button for this one's press (HB-1484).
// 6. No element of the edit dialog is turned on or off (`$('x').disabled = …`, or its
//    `disabled` attribute removed, set or toggled) after an await or in a function that runs
//    later but inside a handle's draw or fill (HB-1484). The forms' buttons are shared too:
//    given back by hand in a save's finally, A's answer turned B's button on under B's forms,
//    over B's own lock (the model button's "Apply the source change first", audit #050) or
//    B's own save still out. A press holds its button through its handle (f.hold) and gives it
//    back with f.done(), which sets it only while the forms are still its agent's, and as that
//    agent has it (sheetButton, in web/app/connections.js). OWN_BUTTON names the functions,
//    and the one button each, that have a guard of their own, with why.
// 7. Every button held (`.hold('x')`), or pressed or set as an agent has it (sheetPress('x'),
//    sheetButton('x')) when it is the edit dialog's, is one the page's SHEET_BUTTONS lists, by
//    name: a fill for another agent sets each one listed there for it (prepareEdit), and a
//    button left out would stay off under B's forms for A's press, with nothing to give it back.
// 8. A function that holds a button gives it back in a finally of its own, whenever that
//    finally runs (not in a branch, a loop, a catch or an optional call there): `f.hold()`
//    with `f.done()`, and `const end = sheetPress()` with `end(…)`. Else an answer that
//    throws, or a done skipped (`finally { if (f.shown()) f.done(); }`), leaves the press
//    counted and the button off for its agent until the page is loaded again. A list save
//    (`f.redraws('data')`) is held the same way, to `f.done()`: one never ended is out for
//    good, and the list's legacy × refused for its agent (f.busy) until a reload (HB-1485).
//
// "After an await" is in source order, within the function the await is in. What this does
// not see, so a review must:
// - a helper called after an await that reads editAgentId itself, when it draws nothing
//   into the forms (one that draws is a filler, unless NOT_FILLERS names it);
// - an element taken before the await and written after (`const el = $('x'); await …;
//   el.innerHTML = …`, a button held in a variable and enabled again in a finally), and the
//   forms' own elements written by hand after one other than their `disabled` (rule 6);
// - a function under another name (`const b = v2SheetBaseline; b()`, a method of an object);
// - a loop's second pass: what stands before an await in a loop's body runs after it the
//   next time round;
// - an element of the forms made by the page (a list's rows, their buttons), not in web/index.html;
// - a draw or fill of something that is not a handle: `x.draw(fn)` passes for any x;
// - a button of another form than the edit dialog's (the Schedule form's Add is cronDlg's:
//   addCronJob gives it back by its own agent, cronAgentId, through sheetPress);
// - a button set by hand at a fill or a read's start (before any await) for the agent shown:
//   whether it is set as its agent has it (sheetButton) is for review; and a button turned on
//   or off another way (`Object.assign(el, { disabled })`, a `[disabled]` selector);
// - a button named by a variable (`sheetPress(button, …)`, `sheetButton(button, …)`: rule 7
//   checks a literal only), and a helper of the page's that calls `sheetButton(b, id)` with
//   them, called after an await: rule 5 sees only a call of sheetButton itself;
// - a hold given back in a finally that a path leaves out (a return between the hold and its
//   try, or one in the finally before its done): rule 8 asks that the done is in the finally
//   and in no branch of it, not that every path reaches it.
import { parseAst } from 'vite';

const FN = /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;
/** Calls whose function argument runs later, not at once. The page's own are found (deferringParams). */
const LATER = new Set(['then', 'catch', 'finally', 'setTimeout', 'setInterval', 'queueMicrotask', 'requestAnimationFrame', 'requestIdleCallback',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver']);
/** A function set as one of these runs when it comes: later. */
const LATER_PROPS = new Set(['onload', 'onerror', 'onmessage']);
/** A handle's methods that run their function only while the answer is still the forms' (forAgent). */
const GUARDED = new Set(['draw', 'fill']);
/** The one caller each may have. */
const ONLY_IN = { v2SheetBaseline: 'sheetFill', v2SheetSaving: 'sheetSave' };
/** The handles: they read editAgentId at the press, which is what they are for. */
const SHEET_HANDLES = ['forAgent', 'sheetSave', 'sheetRead', 'sheetFill'];
/**
 * Functions that touch the forms but draw no answer of one agent's into another's: not fillers
 * (rule 2), nor is a function for calling them, and why. A function told its agent (prepareEdit)
 * is a filler: called with an answer's agent after an await, it fills the forms for that agent
 * under another's sheet.
 */
const NOT_FILLERS = {
  pageClearLast: 'another person signed in: every form is emptied, whoever it was filled for',
  sharingForget: 'signed out, or another person: every sharing list is emptied, whoever it was read for',
  v2RenderSheet: 'draws the sheet of the agent shown, v2AgentId, read when it runs: a redraw of the view',
};
/** Reads run later on purpose, for whichever agent is shown then (rule 5), and why. */
const LATE_READS = {
  // None now: a members list read again once a member is removed (kick) or web chat shared goes through the press's handle (HB-1487).
};
/** Async functions whose form has a guard of its own, not a handle's (rule 2), and why. */
const OWN_GUARD = {
  addCronJob: "the Schedule form is its own: its agent is cronAgentId, asked after the answer",
};
/**
 * Functions that turn an edit dialog's button on or off after an await outside a handle (rule 6):
 * function → that button → why it stays the agent's. Any other element they turn is held to the rule.
 */
const OWN_BUTTON = {
  // None now: the web chat's Share button is held and set through the handles too (HB-1489).
};
const ownButtonIn = (table) => (top, id) => Object.hasOwn(table, top) && Object.hasOwn(table[top], id);
/** The page's list of the forms' buttons a press may hold (rule 7). */
const BUTTONS_LIST = 'SHEET_BUTTONS';
/** The handle that makes a hold and its end (rule 8: it keeps the end for f.done()), and the calls that turn an element's attribute (rule 6). */
const HOLDS_IN = 'sheetSave';
const ATTRIBUTE_CALLS = new Set(['removeAttribute', 'setAttribute', 'toggleAttribute']);
const literal = (a) => a?.type === 'Literal' && typeof a.value === 'string' ? a.value
  : a?.type === 'TemplateLiteral' && !a.expressions.length ? a.quasis[0].value.cooked : null;

/**
 * Rule 8: the holds a function takes (`f.hold('x')`, `const end = sheetPress('x')`) that no finally
 * of its own gives back (`f.done()`, `end(…)`), each with its call. Functions inside it are their own.
 */
function holdsNotGivenBack(fn) {
  const holds = [], ends = new Set(), inner = [];
  // inFinally: false; 'sure' (in a finally, reached whenever it runs); 'maybe' (in a branch or a loop of one: may not be).
  const scan = (n, decl, inFinally) => {
    if (FN.test(n.type)) { inner.push(n); return; }
    const maybe = inFinally && 'maybe';
    if (n.type === 'VariableDeclarator') { if (n.init) scan(n.init, n.id.type === 'Identifier' ? n.id.name : null, inFinally); return; }
    if (n.type === 'TryStatement') {
      scan(n.block, null, inFinally);
      if (n.handler) scan(n.handler, null, maybe);
      if (n.finalizer) scan(n.finalizer, null, inFinally === 'maybe' ? 'maybe' : 'sure');
      return;
    }
    if (n.type === 'IfStatement') { scan(n.test, null, inFinally); scan(n.consequent, null, maybe); if (n.alternate) scan(n.alternate, null, maybe); return; }
    if (n.type === 'ConditionalExpression') { scan(n.test, null, inFinally); scan(n.consequent, decl, maybe); scan(n.alternate, decl, maybe); return; }
    if (n.type === 'LogicalExpression') { scan(n.left, decl, inFinally); scan(n.right, decl, maybe); return; }
    if (/^(?:For|ForIn|ForOf|While|DoWhile|Switch)Statement$/.test(n.type)) { children(n, (k) => scan(k, null, maybe)); return; }
    if (n.type === 'CallExpression') {
      const c = n.callee;
      // A list save (`.redraws`) is ended by `f.done()` too.
      if (c.type === 'MemberExpression' && !c.computed && (c.property.name === 'hold' || c.property.name === 'redraws')) {
        holds.push({ n, kind: 'hold', via: c.property.name, name: c.object.type === 'Identifier' ? c.object.name : decl });
      }
      if (c.type === 'Identifier' && c.name === 'sheetPress') holds.push({ n, kind: 'press', name: decl });
      const sure = inFinally === 'sure' && !n.optional && !(c.type === 'MemberExpression' && c.optional);
      if (sure && c.type === 'MemberExpression' && !c.computed && c.property.name === 'done' && c.object.type === 'Identifier') ends.add(`hold ${c.object.name}`);
      if (sure && c.type === 'Identifier') ends.add(`press ${c.name}`);
      // In a chain (`const f = sheetSave().hold('x')`), the hold is the declared handle's.
      scan(c, c.type === 'MemberExpression' ? decl : null, inFinally);
      for (const a of n.arguments) scan(a, null, inFinally);
      return;
    }
    if (n.type === 'MemberExpression') { scan(n.object, decl, inFinally); if (n.computed) scan(n.property, null, inFinally); return; }
    children(n, (k) => scan(k, null, inFinally));
  };
  for (const p of fn.params) scan(p, null, false);
  scan(fn.body, null, false);
  const left = holds.filter((h) => !(h.name && ends.has(`${h.kind} ${h.name}`)));
  for (const f of inner) left.push(...holdsNotGivenBack(f));
  return left;
}

function children(n, visit) {
  for (const k of Object.keys(n)) {
    if (k === 'type' || k === 'start' || k === 'end') continue;
    const v = n[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c); }
    else if (v && typeof v.type === 'string') visit(v);
  }
}

/** Where a function's own first await ends (not one in a function inside it): Infinity when it has none. */
function firstAwaitEnd(fn) {
  let at = Infinity, end = Infinity;
  const scan = (n) => {
    if (FN.test(n.type)) return;
    if ((n.type === 'AwaitExpression' || (n.type === 'ForOfStatement' && n.await)) && n.start < at) {
      at = n.start; end = n.type === 'AwaitExpression' ? n.end : n.start;
    }
    children(n, scan);
  };
  children(fn.body.type === 'BlockStatement' ? fn.body : { body: [fn.body] }, scan);
  return end;
}

/** The id a call takes an element by ($('x'), $(`x`), getElementById('x'), querySelector('#x')), or null. */
function elementId(n) {
  if (n.type !== 'CallExpression') return null;
  const c = n.callee;
  const method = c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : '';
  const text = literal(n.arguments[0]);
  if (text === null) return null;
  if (method === '$' || method === 'getElementById') return text;
  if (method === 'querySelector') return /^#([\w-]+)$/.exec(text)?.[1] ?? null;
  return null;
}

/** The ids of the edit dialog's elements in the page (web/index.html): the forms the sheet borrows. */
export function sheetFormIds(html) {
  const start = html.search(/<dialog\b[^>]*\bid="editDlg"/);
  if (start < 0) return [];
  const body = html.slice(start, html.indexOf('</dialog>', start));
  if (body.indexOf('<dialog', 1) >= 0) throw new Error('sheetFormIds: a dialog inside editDlg, so where it ends is not known');
  return [...new Set([...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))];
}

/** The page's top-level functions, declared or a const's: name → its function. */
function topFunctions(parsed) {
  const fns = new Map();
  for (const { ast } of parsed) for (const st of ast.body) {
    if (st.type === 'FunctionDeclaration') fns.set(st.id.name, st);
    else if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) if (d.id.type === 'Identifier' && d.init && FN.test(d.init.type)) fns.set(d.id.name, d.init);
    }
  }
  return fns;
}

/** Which arguments of a call run later: a test of each one's index. */
function laterAt(n, deferring) {
  const c = n.callee;
  const method = c.type === 'MemberExpression' && !c.computed ? c.property.name : c.type === 'Identifier' ? c.name : '';
  if (LATER.has(method)) return () => true;
  const own = c.type === 'Identifier' ? deferring.get(c.name) : undefined;
  return own ? (i) => own.has(i) : () => false;
}

/**
 * Walk code, telling `on` each node with where it runs. ctx: top (the top-level function's name);
 * inAsync and awaitEnd (where the async function it runs in first awaits); late (in a closure an
 * async function keeps, or a callback that runs later); now (a function handed to a call that runs
 * it at once: find, map, a handle's draw); guarded (in a handle's draw or fill).
 */
function walk(node, ctx, on, deferring) {
  const visit = (n, ctx) => {
    if (FN.test(n.type)) {
      // Run at once (a plain function handed to a call), it runs where it stands. Kept (declared, stored, returned)
      // in an async function, or async itself there, it runs later: after an await, maybe.
      const inner = ctx.now && !n.async ? { ...ctx, now: false }
        : !ctx.late && !ctx.inAsync && n.async ? { ...ctx, now: false, inAsync: true, awaitEnd: firstAwaitEnd(n) }
        : { ...ctx, now: false, late: ctx.late || ctx.inAsync, awaitEnd: Infinity };
      for (const p of n.params) visit(p, inner);
      visit(n.body, inner);
      return;
    }
    if (ctx.now) ctx = { ...ctx, now: false };
    on(n, ctx, ctx.late || n.start >= ctx.awaitEnd);
    if (n.type === 'MemberExpression') { visit(n.object, ctx); if (n.computed) visit(n.property, ctx); return; }
    if (n.type === 'Property' || n.type === 'MethodDefinition' || n.type === 'PropertyDefinition') { if (n.computed) visit(n.key, ctx); if (n.value) visit(n.value, ctx); return; }
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && LATER_PROPS.has(n.left.property.name)) {
      visit(n.left, ctx); visit(n.right, { ...ctx, late: true }); return;
    }
    if (n.type === 'CallExpression' || n.type === 'NewExpression') {
      const c = n.callee, later = laterAt(n, deferring);
      visit(c, ctx);
      n.arguments.forEach((a, i) => {
        const sub = !FN.test(a.type) ? ctx
          : later(i) ? { ...ctx, late: true }
          : { ...ctx, now: true, guarded: ctx.guarded || (GUARDED.has(c.property?.name) && c.type === 'MemberExpression' && !c.computed) };
        visit(a, sub);
      });
      return;
    }
    children(n, (k) => visit(k, ctx));
  };
  visit(node, ctx);
}
const startCtx = (top, late = false) => ({ top, inAsync: false, late, now: false, guarded: false, awaitEnd: Infinity });
const topName = (st) => st.type === 'FunctionDeclaration' ? st.id.name
  : st.type === 'VariableDeclaration' && st.declarations.length === 1 && st.declarations[0].id.type === 'Identifier' ? st.declarations[0].id.name : '';

/**
 * The page's own functions that run a function they are given later, and at which argument:
 * one that calls it after its first await or in a callback that runs later, hands it on to a
 * call that does, or keeps it (`x = fn`, `x.set(k, fn)`, `x.push(fn)`) for later (v2FollowOp's onEnd).
 * A value kept that is not a function counts too: only a function handed there is taken as late.
 */
function deferringParams(fns) {
  const deferring = new Map();
  const KEEP = new Set(['set', 'push', 'unshift', 'add']);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, fn] of fns) {
      const params = fn.params.map((p) => p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : null);
      if (!params.some(Boolean)) continue;
      const at = new Set(deferring.get(name)), had = at.size;
      const param = (x) => x?.type === 'Identifier' ? params.indexOf(x.name) : -1;
      walk(fn, startCtx(name), (n, ctx, after) => {
        if (n.type === 'CallExpression' || n.type === 'NewExpression') {
          if (after && param(n.callee) >= 0) at.add(param(n.callee));
          const later = laterAt(n, deferring), c = n.callee;
          const keeps = c.type === 'MemberExpression' && !c.computed && KEEP.has(c.property.name);
          n.arguments.forEach((a, i) => { if (param(a) >= 0 && (later(i) || keeps)) at.add(param(a)); });
        }
        if (n.type === 'AssignmentExpression' && param(n.right) >= 0) at.add(param(n.right));
      }, deferring);
      if (at.size > had) { deferring.set(name, at); grew = true; }
    }
  }
  return deferring;
}

/**
 * Each top-level function: whether it takes an edit form by id, whom it calls, and whether it hands
 * a function to a call that runs it later (its own code then runs after it returns: as an async one's).
 */
function summarise(fns, formIds, deferring) {
  const info = new Map();
  for (const [name, fn] of fns) {
    let touches = false, handsLater = false;
    const calls = new Set();
    walk(fn, startCtx(name), (n) => {
      if (n.type !== 'CallExpression' && n.type !== 'NewExpression') return;
      const later = laterAt(n, deferring);
      n.arguments.forEach((a, i) => { if (later(i) && (FN.test(a.type) || (a.type === 'Identifier' && fns.has(a.name)))) handsLater = true; });
    }, deferring);
    const scan = (n) => {
      const id = elementId(n);
      if (id !== null && formIds.has(id)) touches = true;
      if ((n.type === 'CallExpression' || n.type === 'NewExpression') && n.callee.type === 'Identifier') calls.add(n.callee.name);
      children(n, scan);
    };
    scan(fn.body);
    info.set(name, { async: !!fn.async, touches: touches || calls.has('sheetFill'), handsLater, calls });
  }
  return info;
}

/** The plain functions that fill the edit forms with what they are given (rule 2). */
function formFillers(info) {
  const fillers = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, f] of info) {
      if (fillers.has(name) || f.async || SHEET_HANDLES.includes(name) || name in NOT_FILLERS) continue;
      if (f.touches || [...f.calls].some((c) => fillers.has(c))) { fillers.add(name); grew = true; }
    }
  }
  return fillers;
}

function analyse(scripts, formIds) {
  const parsed = scripts.map(({ name, code }) => ({ name, code, ast: parseAst(code) }));
  const fns = topFunctions(parsed);
  const deferring = deferringParams(fns);
  const info = summarise(fns, new Set(formIds), deferring);
  return { parsed, fns, deferring, info, fillers: formFillers(info) };
}

/**
 * @param {{ name: string, code: string }[]} scripts the page's scripts (web/app/)
 * @param {{ formIds?: string[], ownButtons?: Record<string, Record<string, string>>, lateReads?: Record<string, string> }} [opts] the edit dialog's element ids (sheetFormIds); and, for a test, the exemptions in place of the page's (OWN_BUTTON, LATE_READS)
 * @returns {string[]} what is wrong, one line each
 */
export function sheetStateProblems(scripts, { formIds = [], ownButtons = OWN_BUTTON, lateReads = LATE_READS } = {}) {
  // The exemptions: the page's own tables, or a test's (both are empty for the page now, HB-1487, HB-1489).
  const ownButton = ownButtonIn(ownButtons);
  const { parsed, fns, deferring, fillers } = analyse(scripts, formIds);
  const draws = (name) => name === 'sheetFill' || fillers.has(name);
  // A top-level function handed by name to a call that runs it later runs later, all of it.
  const runLater = new Set();
  for (const { ast } of parsed) for (const st of ast.body) {
    walk(st, startCtx(topName(st)), (n) => {
      if (n.type === 'CallExpression' || n.type === 'NewExpression') {
        const later = laterAt(n, deferring);
        n.arguments.forEach((a, i) => { if (a.type === 'Identifier' && fns.has(a.name) && later(i)) runLater.add(a.name); });
      }
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && LATER_PROPS.has(n.left.property.name)
        && n.right.type === 'Identifier' && fns.has(n.right.name)) runLater.add(n.right.name);
    }, deferring);
  }
  // The buttons a press may hold (rule 7): the keys of the page's SHEET_BUTTONS.
  const listed = new Set();
  for (const { ast } of parsed) for (const st of ast.body) {
    if (st.type !== 'VariableDeclaration') continue;
    for (const d of st.declarations) {
      if (d.id.type !== 'Identifier' || d.id.name !== BUTTONS_LIST || d.init?.type !== 'ObjectExpression') continue;
      for (const p of d.init.properties) {
        if (p.type === 'Property' && !p.computed) listed.add(p.key.type === 'Identifier' ? p.key.name : String(p.key.value));
      }
    }
  }
  const forms = new Set(formIds);
  const problems = [];
  for (const { name, code, ast } of parsed) {
    const line = (pos) => code.slice(0, pos).split('\n').length;
    const say = (n, ctx, what, id = 'HB-0644') => problems.push(`${name}:${line(n.start)}: ${ctx.top || 'code'} ${what} (${id})`);
    // Rule 6: an element of the edit dialog turned on or off (its id) after an await, outside a handle.
    const switched = (n, ctx, after, el) => {
      const id = elementId(el);
      if (id !== null && forms.has(id) && after && !ctx.guarded && !ownButton(ctx.top, id)) {
        say(n, ctx, `turns ${id} on or off after an await: by then the forms may be another agent's, with a lock or a press of its own on it. Hold it through the handle (f.hold) and give it back with f.done(), or set it in f.draw / f.fill as its agent has it (sheetButton)`, 'HB-1484');
      }
    };
    const unlisted = (n, ctx, what, held) => say(n, ctx, `${what} ${held === null ? 'a button not named by its id' : held}, which ${BUTTONS_LIST} does not list: a fill for another agent sets each listed button for it (prepareEdit), and one left out stays off under that agent's forms for this press. Name it there, with its lock (or null)`, 'HB-1484');
    const on = (n, ctx, after) => {
      if (n.type === 'Identifier' && n.name === 'editAgentId' && (ctx.inAsync || ctx.late)) {
        say(n, ctx, `reads editAgentId ${ctx.late ? 'in a function that runs later' : 'in an async function'}: by its answer it may name another agent. Take the agent from a handle at the press (sheetSave(), sheetRead(): f.id)`);
      }
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && !n.left.computed && n.left.property.name === 'disabled') switched(n, ctx, after, n.left.object);
      if (n.type !== 'CallExpression' && n.type !== 'NewExpression') return;
      const c = n.callee;
      if (c.type === 'MemberExpression' && !c.computed && ATTRIBUTE_CALLS.has(c.property.name) && literal(n.arguments[0]) === 'disabled') switched(n, ctx, after, c.object);
      const holds = c.type === 'MemberExpression' && !c.computed && c.property.name === 'hold';
      if (holds) {
        const held = literal(n.arguments[0]);
        if (held === null || !listed.has(held)) unlisted(n, ctx, 'holds', held);
      }
      // Rule 7 for a press or a set by name: a literal id of the edit dialog's (the Schedule form's Add is cronDlg's).
      if (c.type === 'Identifier' && (c.name === 'sheetPress' || c.name === 'sheetButton')) {
        const held = literal(n.arguments[0]);
        if (held !== null && forms.has(held) && !listed.has(held)) unlisted(n, ctx, c.name === 'sheetPress' ? 'presses' : 'sets', held);
      }
      // Rule 5 for the buttons: held, or set as an agent has it, for the agent shown by then.
      const button = holds ? '.hold' : c.type === 'Identifier' && (c.name === 'sheetPress' || c.name === 'sheetButton') ? c.name : null;
      if (button && after && !ctx.guarded) {
        say(n, ctx, `${button === 'sheetButton' ? 'sets a button as its agent has it (sheetButton)' : `holds a button (${button})`} ${ctx.late ? 'in a function that runs later' : 'after an await'}: by then the forms may be another agent's, and it is that agent's button it ${button === 'sheetButton' ? 'sets' : 'holds'}. ${button === 'sheetButton' ? 'Set it in f.draw / f.fill, which refuse forms no longer its agent\'s' : 'Hold it at the press, before the first await'}`, 'HB-1484');
      }
      if (elementId(n) === 'editErr' && after && !ctx.guarded) {
        say(n, ctx, "touches the shared error box after an await: say it through the handle (f.fail), or in f.draw / f.fill, which refuse an answer for forms no longer its agent's");
      }
      if (c.type === 'Identifier' && draws(c.name) && after && !ctx.guarded && !(ctx.top in OWN_GUARD)) {
        say(n, ctx, `calls ${c.name} after an await, which draws into the edit forms: they may be another agent's by then. Draw in the handle's f.draw / f.fill, which refuse an answer for forms no longer its agent's`);
      }
      const later = laterAt(n, deferring);
      n.arguments.forEach((a, i) => {
        if (a.type === 'Identifier' && draws(a.name) && later(i) && !ctx.guarded) {
          say(a, ctx, `hands ${a.name}, which draws into the edit forms, to a call that runs it later: they may be another agent's by then. Draw in the handle's f.draw / f.fill`);
        }
      });
      if (c.type === 'Identifier' && (c.name === 'sheetSave' || c.name === 'sheetRead') && after && !ctx.guarded && !(c.name === 'sheetRead' && ctx.top in lateReads)) {
        say(n, ctx, `takes its handle (${c.name}) ${ctx.late ? 'in a function that runs later' : 'after an await'}: it is for the agent shown by then, not the one pressed for. Take it at the press, before the first await`);
      }
      if (c.type === 'Identifier' && ONLY_IN[c.name] && ctx.top !== ONLY_IN[c.name] && ctx.top !== c.name) {
        say(n, ctx, `calls ${c.name}: only ${ONLY_IN[c.name]}() does, so every ${c.name === 'v2SheetBaseline' ? 'fill notes its baseline' : 'save notes its press'} one way`);
      }
    };
    for (const st of ast.body) {
      const top = topName(st);
      walk(st, startCtx(top, runLater.has(top)), on, deferring);
      // Rule 8: each hold given back in a finally of its own function (the handle's own, sheetSave, keeps its ends for f.done()).
      if (top === HOLDS_IN) continue;
      const left = [];
      const scanFns = (n) => { if (FN.test(n.type)) left.push(...holdsNotGivenBack(n)); else children(n, scanFns); };
      scanFns(st);
      for (const h of left) {
        if (h.via === 'redraws') {
          say(h.n, startCtx(top), `saves a list (.redraws) that no finally of its own ends (${h.name ?? 'f'}.done(), in no branch of it): an answer that throws, or an end skipped, leaves the save out for good, and the list's legacy × refused for its agent until the page is loaded again`, 'HB-1485');
          continue;
        }
        say(h.n, startCtx(top), `holds a button (${h.kind === 'hold' ? '.hold' : 'sheetPress'}) that no finally of its own gives back (${h.kind === 'hold' ? `${h.name ?? 'f'}.done()` : `${h.name ?? 'its end'}(…)`}, in no branch of it): an answer that throws, or a give-back skipped, leaves the press counted and the button off for its agent until the page is loaded again`, 'HB-1484');
      }
    }
  }
  return problems;
}

/**
 * The functions the click-through's race tables must cover (scripts/ui-clickthrough.mjs): each
 * that starts a save (sheetSave, forAgent) or a read (sheetRead), and each async one that touches
 * the edit forms another way (takes an element of them, or calls sheetFill or a filler). A plain
 * function that hands a function to a call that runs it later (then, a timer, v2FollowOp…) counts
 * as async: what it touches there, it touches after its answer.
 * @param {{ name: string, code: string }[]} scripts
 * @param {{ formIds?: string[] }} [opts]
 * @returns {{ saves: string[], reads: string[], touchers: string[] }}
 */
export function sheetStarters(scripts, { formIds = [] } = {}) {
  const { info, fillers } = analyse(scripts, formIds);
  // sharingRead asks forAgent in the test it makes: a read's test, its callers' reads.
  const names = (test) => [...info].filter(([name, f]) => !SHEET_HANDLES.includes(name) && name !== 'sharingRead' && test(f)).map(([name]) => name).sort();
  return {
    saves: names((f) => f.calls.has('sheetSave') || f.calls.has('forAgent')),
    reads: names((f) => f.calls.has('sheetRead')),
    touchers: names((f) => (f.async || f.handsLater) && (f.touches || [...f.calls].some((c) => fillers.has(c) || SHEET_HANDLES.includes(c)))),
  };
}
