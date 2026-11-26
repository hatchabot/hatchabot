import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { sheetFormIds, sheetStarters, sheetStateProblems } from '../scripts/sheet-state.mjs';

/**
 * scripts/sheet-state.mjs (run by check-web): the agent sheet's forms belong to one agent at a time
 * (HB-0644). A save or a read takes its agent once, at the press, from its handle; no async function,
 * and nothing that runs later, reads editAgentId, and after an await nothing draws into the forms or
 * touches the shared error box but through that handle; only sheetFill notes a baseline. Each case is
 * a small made-up script.
 */
const problems = (code: string, formIds: string[] = []) => sheetStateProblems([{ name: 'web/app/x.js', code }], { formIds });
const READS = 'by its answer it may name another agent. Take the agent from a handle at the press (sheetSave(), sheetRead(): f.id) (HB-0644)';

describe('a read of editAgentId where the answer may be for another agent', () => {
  it('in an async function, before its await as after (HB-0590: the next agent drawn for the one pressed)', () => {
    const p = problems(`async function setIt() {
  const id = editAgentId;
  await api('/v1/agents/' + id);
  if (editAgentId === id) draw();
}`);
    expect(p).toEqual([
      `web/app/x.js:2: setIt reads editAgentId in an async function: ${READS}`,
      `web/app/x.js:4: setIt reads editAgentId in an async function: ${READS}`,
    ]);
  });
  it('in a catch or finally, and in a callback run there', () => {
    const p = problems(`async function s() {
  try { await api('/x'); } catch { say(editAgentId); } finally { list.forEach((x) => x === editAgentId); }
}`);
    expect(p).toHaveLength(2);
  });
  it('in a callback run at once before the await: the handle reads it, in a plain function', () => {
    const p = problems(`async function s() {
  const a = agents.find((x) => x.id === editAgentId), f = sheetSave();
  await api('/v1/agents/' + f.id);
  f.draw(() => paint(a));
}`);
    expect(p).toEqual([`web/app/x.js:2: s reads editAgentId in an async function: ${READS}`]);
  });
  it('in a closure an async function keeps, though it is written before the await (it runs after)', () => {
    const p = problems(`async function load() {
  const forId = editAgentId, stale = () => editAgentId !== forId;
  await api('/x');
  if (stale()) return;
}`);
    expect(p.map((x) => x.replace(/: by its answer.*/, ''))).toEqual([
      'web/app/x.js:2: load reads editAgentId in an async function',
      'web/app/x.js:2: load reads editAgentId in a function that runs later',
    ]);
  });
  it("in a promise's callback or a timer's, from any function (HB-0584: a late list drawn in the next agent's forms)", () => {
    expect(problems(`function f() { api('/x').then(() => { if (editAgentId) draw(); }); }`)).toHaveLength(1);
    expect(problems(`function f() { setTimeout(() => editAgentId, 5); }`)).toHaveLength(1);
  });
  it('in a function handed by name to one that runs it later', () => {
    const p = problems(`function done() { draw(editAgentId); }
function f() { api('/x').then(done); }`);
    expect(p).toEqual([`web/app/x.js:1: done reads editAgentId in a function that runs later: ${READS}`]);
  });
  it("in a callback the page's own functions run later: kept for later (v2FollowOp's onEnd), or called after their await", () => {
    expect(problems(`function v2FollowOp(op, onEnd) { if (onEnd) ends.set(op.id, onEnd); }
function f() { v2FollowOp(op, () => { use(editAgentId); }); }`)).toHaveLength(1);
    expect(problems(`async function handOver(id, say) { await api('/x'); say('done'); }
function f() { handOver('a', (m) => use(editAgentId, m)); }`)).toHaveLength(1);
    expect(problems(`function follow(op, then) { v2FollowOp(op, then); }
function v2FollowOp(op, onEnd) { ends.set(op.id, onEnd); }
function f() { follow(op, () => use(editAgentId)); }`)).toHaveLength(1);
  });
  it("in an observer's callback or an element's onload", () => {
    expect(problems(`function f() { img.onload = () => use(editAgentId); new ResizeObserver(() => use(editAgentId)); }`)).toHaveLength(2);
  });
  it('in an async function an async one makes, which runs later', () => {
    expect(problems(`async function f() { follow(async () => { use(editAgentId); }); }`)).toHaveLength(1);
  });
  it('not in a plain function, a callback it runs at once included, nor in one the page runs at once after it is handed it', () => {
    expect(problems(`function onPick() { return agents.find((x) => x.id === editAgentId); }
function forAgent(id) { return { mine: () => editAgentId === id }; }
async function pageHold(fn) { try { return await fn(); } finally { done(); } }
function g() { pageHold(() => editAgentId); }`)).toEqual([]);
  });
});

describe('what draws into the forms after an await', () => {
  const FILL = "which draws into the edit forms: they may be another agent's by then";
  it("a function that fills them, called outside a handle's draw or fill, or handed to a promise (HB-0590: a model menu drawn for another agent)", () => {
    const p = problems(`function renderEnvList(list) { $('envList').innerHTML = list.join(''); }
function renderPicker(a) { renderEnvList(a.models); }
const paint = (v) => { $('editModel').value = v; };
async function remove() {
  const f = sheetSave();
  const u = await api('/v1/agents/' + f.id);
  renderPicker(u);
  paint(u.model);
  f.draw(() => renderPicker(u));
  f.fill(['editModel'], () => paint(u.model));
  api('/x').then(renderEnvList);
}`, ['envList', 'editModel']);
    expect(p.map((x) => x.replace(/, which draws.*|, to a call.*/, ''))).toEqual([
      'web/app/x.js:7: remove calls renderPicker after an await',
      'web/app/x.js:8: remove calls paint after an await',
      'web/app/x.js:11: remove hands renderEnvList',
    ]);
    expect(p[0]).toContain(FILL);
  });
  it('a plain sheetFill after an await is no guard: it does not ask whose the forms are', () => {
    const p = problems(`async function s() { await api('/x'); sheetFill(['a'], () => { $('editErr').textContent = ''; }); }`);
    expect(p.map((x) => x.replace(/^web\/app\/x\.js:1: s /, '').replace(/ after an await.*/, ''))).toEqual(['calls sheetFill', 'touches the shared error box']);
  });
  it('a fill told its agent fails though it reads editAgentId too (prepareEdit compares it); a redraw named in NOT_FILLERS does not', () => {
    const p = problems(`function prepareEdit(id) { if (id !== editAgentId) clear(); editAgentId = id; $('envList').textContent = id; }
function v2RenderSheet() { const a = agents.find((x) => x.id === v2AgentId); $('envList').textContent = a.name; }
async function s() { const f = sheetSave(); await api('/v1/agents/' + f.id); prepareEdit(f.id); v2RenderSheet(); }`, ['envList']);
    expect(p.map((x) => x.replace(/ after an await.*/, ''))).toEqual(['web/app/x.js:3: s calls prepareEdit']);
  });
  it('not a fill before the await', () => {
    expect(problems(`function renderEnvList(list) { $('envList').innerHTML = list.join(''); }
async function s() { const f = sheetSave(); renderEnvList([]); await api('/v1/agents/' + f.id); }`, ['envList'])).toEqual([]);
  });
  it('not a function that takes no element of the forms', () => {
    expect(problems(`function note(t) { $('toast').textContent = t; }
async function s() { await api('/x'); note('done'); }`, ['envList'])).toEqual([]);
  });
});

describe('the shared error box', () => {
  it('touched by hand after an await fails; through a draw or fill, or before the await, does not', () => {
    const p = problems(`async function s() {
  $('editErr').textContent = '';
  const f = sheetSave();
  try { await api('/x'); f.draw(() => { $('editErr').textContent = 'Reverting'; }); f.fill(['a'], () => { $('editErr').textContent = ''; }); }
  catch (e) { $('editErr').textContent = e.message; }
}`);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^web\/app\/x\.js:5: s touches the shared error box after an await/);
  });
  it('however it is taken, and taken only (an element held is written later)', () => {
    const p = problems(`async function s() {
  await api('/x');
  $(\`editErr\`).textContent = 'a';
  document.getElementById('editErr').textContent = 'b';
  const box = $('editErr');
  box.textContent = 'c';
}`);
    expect(p.map((x) => x.slice(0, 16))).toEqual(['web/app/x.js:3: ', 'web/app/x.js:4: ', 'web/app/x.js:5: ']);
  });
});

describe('a handle taken late', () => {
  it('after an await, or in a callback that runs later, is for the agent shown by then', () => {
    const p = problems(`async function s() { await api('/x'); const f = sheetSave(); await api('/v1/agents/' + f.id); }
function t() { api('/x').then(() => { const r = sheetRead('y'); return r; }); }
async function u() { const f = sheetSave(); await api('/v1/agents/' + f.id); f.draw(() => sheetRead('z')); }`);
    expect(p.map((x) => x.replace(/: it is for.*/, ''))).toEqual([
      'web/app/x.js:1: s takes its handle (sheetSave) after an await',
      'web/app/x.js:2: t takes its handle (sheetRead) in a function that runs later',
    ]);
  });
});

describe('one way to note what the forms hold', () => {
  it('a baseline noted by hand fails, and so does a press noted outside sheetSave', () => {
    const p = problems(`function fillIt() { $('a').value = 'x'; v2SheetBaseline('a'); }
async function saveIt() { const saved = v2SheetSaving('a'); await api('/x'); saved(); }
function sheetFill(where, fn) { fn(); v2SheetBaseline(...where); }
function sheetSave(...where) { return v2SheetSaving(...where); }`);
    expect(p.map((x) => x.replace(/: only.*/, ''))).toEqual([
      'web/app/x.js:1: fillIt calls v2SheetBaseline',
      'web/app/x.js:2: saveIt calls v2SheetSaving',
    ]);
  });
});

describe("the forms' buttons, shared too (HB-1484)", () => {
  const LIST = 'const SHEET_BUTTONS = { renameBtn: null, modelBtn: () => false };\n';
  it("one turned on or off by hand after an await fails, in a finally or a promise's callback; through the handle, in a draw or fill, or before the await, does not", () => {
    const p = problems(LIST + `async function s() {
  const f = sheetSave().hold('renameBtn');
  $('modelBtn').disabled = true;
  try { await api('/x'); f.draw(() => { $('modelBtn').disabled = false; }); f.fill(['a'], () => { $('renameBtn').disabled = false; }); }
  finally { $('renameBtn').disabled = false; f.done(); }
}
function t() { api('/x').then(() => { $('modelBtn').disabled = false; }); }`, ['renameBtn', 'modelBtn']);
    expect(p.map((x) => x.replace(/ on or off after an await.*/, ''))).toEqual([
      'web/app/x.js:6: s turns renameBtn',
      'web/app/x.js:8: t turns modelBtn',
    ]);
    expect(p[0]).toMatch(/give it back with f\.done\(\).* \(HB-1484\)$/);
  });
  it("not an element of another form than the edit dialog's", () => {
    expect(problems(`async function s() { await api('/x'); $('cronAddBtn').disabled = false; }`, ['renameBtn'])).toEqual([]);
  });
  it('a hold of a button the list does not name, or names by no id, fails', () => {
    const p = problems(LIST + `async function s(b) {
  const f = sheetSave().hold('renameBtn').hold('descBtn');
  f.hold(b);
  try { await api('/x'); } finally { f.done(); }
}`);
    expect(p.map((x) => x.replace(/, which SHEET_BUTTONS.*/, ''))).toEqual([
      'web/app/x.js:3: s holds descBtn',
      'web/app/x.js:4: s holds a button not named by its id',
    ]);
  });
  it("a hold is given back in a finally of its own function, by its own handle; a press by its own end", () => {
    const p = problems(LIST + `async function given() {
  const f = sheetSave().hold('renameBtn');
  try { await api('/x'); } finally { f.done(); }
}
async function other() {
  const f = sheetSave().hold('renameBtn'), g = sheetSave();
  try { await api('/x'); } finally { g.done(); }
}
async function notInFinally() {
  const end = sheetPress('cronAddBtn', 'a1');
  await api('/x');
  end(true);
}
function inner() {
  return async () => { const f = sheetSave(); f.hold('modelBtn'); try { await api('/x'); } finally { f.done(); } };
}`, ['renameBtn', 'modelBtn']);
    expect(p.map((x) => x.replace(/ that no finally.*/, ''))).toEqual([
      'web/app/x.js:7: other holds a button (.hold)',
      'web/app/x.js:11: notInFinally holds a button (sheetPress)',
    ]);
  });
  it('a give-back in a branch, a loop, a catch or an optional call of the finally may not run: it fails; one in a try of the finally runs', () => {
    const fn = (name: string, fin: string) => `async function ${name}() {\n  const f = sheetSave().hold('renameBtn');\n  try { await api('/x'); } finally { ${fin} }\n}\n`;
    const p = problems(LIST + fn('ifs', 'if (f.shown()) f.done();') + fn('ands', 'f.mine() && f.done();') + fn('ternary', 'f.mine() ? f.done() : 0;')
      + fn('loops', 'for (const x of list) f.done();') + fn('catches', 'try { go(); } catch { f.done(); }') + fn('optional', 'f.done?.();')
      + fn('tried', 'try { f.done(); } catch { /* none */ }') + fn('after', 'if (f.shown()) note(); f.done();'), ['renameBtn']);
    expect(p.map((x) => x.replace(/ holds a button.*/, ''))).toEqual([3, 7, 11, 15, 19, 23].map((at, i) => `web/app/x.js:${at}: ${['ifs', 'ands', 'ternary', 'loops', 'catches', 'optional'][i]}`));
  });
  it("a button held, pressed or set as its agent has it after an await, or its disabled attribute turned there, fails", () => {
    const p = problems(LIST + `async function s() {
  const f = sheetSave();
  await api('/x');
  f.hold('renameBtn');
  sheetButton('modelBtn', f.id);
  f.draw(() => sheetButton('modelBtn', f.id));
  $('renameBtn').removeAttribute('disabled');
  $('modelBtn').toggleAttribute('disabled', false);
  $('renameBtn').setAttribute('title', 'x');
  f.done();
}`, ['renameBtn', 'modelBtn']);
    expect(p.map((x) => x.replace(/(after an await).*/, '$1'))).toEqual([
      'web/app/x.js:5: s holds a button (.hold) after an await',
      'web/app/x.js:6: s sets a button as its agent has it (sheetButton) after an await',
      'web/app/x.js:8: s turns renameBtn on or off after an await',
      'web/app/x.js:9: s turns modelBtn on or off after an await',
      "web/app/x.js:5: s holds a button (.hold) that no finally of its own gives back (f.done(), in no branch of it): an answer that throws, or a give-back skipped, leaves the press counted and the button off for its agent until the page is loaded again (HB-1484)",
    ]);
  });
  it("an edit-dialog button pressed or set by name that the list leaves out fails; another form's does not", () => {
    const p = problems(LIST + `function s() {
  sheetButton('descBtn', 'a1');
  sheetButton('cronAddBtn', 'a1');
  const end = sheetPress('descBtn', 'a1');
  try { go(); } finally { end(true); }
}`, ['renameBtn', 'modelBtn', 'descBtn']);
    expect(p.map((x) => x.replace(/, which SHEET_BUTTONS.*/, ''))).toEqual([
      'web/app/x.js:3: s sets descBtn',
      'web/app/x.js:5: s presses descBtn',
    ]);
  });
});

describe('what the click-through must race (sheetStarters)', () => {
  it('each function that starts a save or a read, and each async one that touches the forms, a const arrow too', () => {
    const s = sheetStarters([{ name: 'web/app/x.js', code: `async function save() { const f = sheetSave(); await api('/v1/agents/' + f.id); }
async function load() { const r = sheetRead('x'); await api('/v1/agents/' + r.id); }
const late = async () => { await api('/z'); $('envList').textContent = ''; };
const drawsLate = async () => { await api('/z'); renderEnvList([]); };
function renderEnvList(list) { $('envList').innerHTML = list.join(''); }
async function other() { await api('/w'); $('toast').textContent = ''; }
function plain() { api('/v').then((u) => { $('envList').textContent = u; }); }
function plainElsewhere() { setTimeout(() => { $('toast').textContent = ''; }, 5); }
function sheetSave() { return forAgent(editAgentId); }` }], { formIds: ['envList'] });
    expect(s).toEqual({ saves: ['save'], reads: ['load'], touchers: ['drawsLate', 'late', 'load', 'plain', 'save'] });
  });
  it("a plain function that draws by hand in a promise's callback, put in the shipped page, must be raced (check-web cannot see it)", () => {
    const files = readdirSync('web/app').filter((f) => f.endsWith('.js')).map((f) => ({ name: `web/app/${f}`, code: readFileSync(`web/app/${f}`, 'utf8') }));
    const formIds = sheetFormIds(readFileSync('web/index.html', 'utf8'));
    const page = files.map((f) => f.name !== 'web/app/connections.js' ? f : { ...f, code: f.code + `
function addThing() {
  const id = editAgentId;
  api('/v1/agents/' + id + '/env').then((u) => { $('envList').innerHTML = u.envVars.join(''); });
}
` });
    expect(sheetStateProblems(page, { formIds })).toEqual([]);
    expect(sheetStarters(page, { formIds }).touchers).toContain('addThing');
    expect(sheetStarters(files, { formIds }).touchers).not.toContain('addThing');
  });
});

it("the edit forms are the edit dialog's elements", () => {
  expect(sheetFormIds(`<dialog id="otherDlg"><input id="before"></dialog>
<dialog id="editDlg" class="x"><input id="a"><div data-id="not-an-id" id="b"></div></dialog>
<dialog id="after"><input id="c"></dialog>`)).toEqual(['editDlg', 'a', 'b']);
});

it('the page as shipped keeps to all of it', () => {
  const files = readdirSync('web/app').filter((f) => f.endsWith('.js')).map((f) => ({ name: `web/app/${f}`, code: readFileSync(`web/app/${f}`, 'utf8') }));
  const formIds = sheetFormIds(readFileSync('web/index.html', 'utf8'));
  expect(formIds).toContain('editErr');
  expect(sheetStateProblems(files, { formIds })).toEqual([]);
});
