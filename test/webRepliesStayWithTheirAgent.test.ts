/**
 * The web page's own functions (web/index.html as shipped), each run against a
 * small made-up DOM and an api() whose answers come back when the test says.
 * A reply lands only on the agent, draft or request it was for; what a reply
 * says is read in full (applied, saved for later, refused); a change made and
 * saved does not hold the sheet's redraw back (deep audit of v2.177.0: HB-0583
 * to HB-0591, HB-0595, HB-0466, HB-0474, HB-0475, HB-0495). The click-through
 * (scripts/ui-clickthrough.mjs, repliesStayWithTheirAgent and the scenarios
 * beside it) drives the same paths in a real browser. Names are the invented
 * household's (docs/deck/shot-data.mjs).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const js = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
function source(name: string): string {
  const m = new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^\\}`, 'm').exec(js)
    ?? new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{.*\\}$`, 'm').exec(js);
  if (!m) throw new Error(`no function ${name} in web/index.html`);
  return m[0];
}
/** A top-level `const name = …;` of the page (to the first line that ends with ";"). */
function constant(name: string): string {
  const m = new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm').exec(js);
  if (!m) throw new Error(`no const ${name} in web/index.html`);
  return m[0].replace(/^const /, 'var ');
}

type El = {
  id: string; value: string; textContent: string; innerHTML: string; hidden: boolean; disabled: boolean; checked: boolean;
  style: Record<string, string>; dataset: Record<string, string>; isConnected: boolean; childElementCount: number;
  focus(): void; querySelectorAll(sel: string): unknown[]; closest(sel: string): unknown; contains(el: unknown): boolean;
};
function element(id = ''): El {
  let inner = '';
  const el: El = {
    id, value: '', textContent: '', hidden: false, disabled: false, checked: false, style: {}, dataset: {}, isConnected: true,
    childElementCount: 0, focus() {}, querySelectorAll: () => [], closest: () => null, contains: () => false,
    get innerHTML() { return inner; },
    set innerHTML(v: string) {
      inner = v;
      // A <select>'s value follows its selected option, as a browser's does.
      const options = [...v.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      if (options.length) el.value = (options.find((o) => /selected/.test(o[2]!)) ?? options[0]!)[1]!;
    },
  };
  return el;
}

const AGENTS = [
  { id: 'a1', name: 'Homework Helper', aiProfileId: 'p1', profileModels: ['claude-sonnet-5'], state: 'RUNNING', runtimeRef: 'docker://x', image: 'hatchabot/runtime:trial' },
  { id: 'a2', name: 'Soccer Schedule', aiProfileId: 'p1', profileModels: ['claude-sonnet-5'], state: 'RUNNING', runtimeRef: 'docker://y' },
  { id: 'a3', name: 'Garden Planner', aiProfileId: 'p1', profileModels: ['claude-sonnet-5'], state: 'STOPPED', runtimeRef: 'docker://z' },
];
type Init = { method?: string; body?: Record<string, unknown> };
type Call = Init & { url: string };
/** A gate: the request waits until the test opens it. */
function gate<T = unknown>() {
  let open!: (v: T) => void, fail!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => { open = res; fail = rej; });
  return { p, open, fail };
}

/** The named page functions (and one-line consts) in a context of their own, with `extra` as its globals. */
function page(names: string[], extra: Record<string, unknown> = {}, consts: string[] = []) {
  const nodes = new Map<string, El>();
  const $ = (id: string) => { if (!nodes.has(id)) nodes.set(id, element(id)); return nodes.get(id)!; };
  const calls: Call[] = [];
  const toasts: string[] = [];
  const noop = () => {};
  const c = vm.createContext({
    $, console, Intl, encodeURIComponent, Math, Date, Promise, String, JSON, Map, Set, Number, Array, Object,
    agents: AGENTS.map((a) => ({ ...a })), profiles: [], agentClasses: [], appConfig: {},
    api: async (url: string, init?: Init) => { calls.push({ url, ...init }); return {}; },
    confirm: () => true, toast: (t: string) => { toasts.push(t); }, refresh: async () => {},
    esc: (v: unknown) => String(v ?? ''), jsq: (v: unknown) => String(v ?? ''), fmtBytes: String,
    v2SheetSaving: () => noop, v2SheetBaseline: noop, V2_SHEET_FORMS: [], onRepoPublic: noop, onParamTypeChange: noop,
    v2CtlDrawn: (el: { defaultValue?: string }) => el.defaultValue ?? '', editAgentId: 'a1', v2AgentId: null, editParamsFills: 0, searchTests: new Set(),
    v2AgentDlg: { open: false }, editDlg: { open: false },
    ...extra,
  });
  // One "Its name: " helper for every answer about an agent (HB-0584, HB-0587, HB-0590), and one
  // for where an edit form's answer goes (forAgent), as shipped.
  if (!('agentPrefix' in extra)) vm.runInContext(source('agentPrefix'), c);
  if (!('forAgent' in extra)) vm.runInContext(source('forAgent'), c);
  for (const n of names) vm.runInContext(source(n), c);
  for (const n of consts) vm.runInContext(constant(n), c);
  return { c: c as Record<string, any>, $, calls, toasts };
}

describe('the image picker: A, then B while its list loads, then A again: Pin sends nothing of B (HB-0583)', () => {
  it("A's picker is drawn again for A, and Pin waits for A's own list", async () => {
    const lists: Array<ReturnType<typeof gate<string>>> = [];
    const { c, $, calls, toasts } = page(['populateImagePicker', 'saveImagePin'], {
      imagePickGen: 0, confirmRebuild: () => true,
      imageOptionsHtml: () => { const g = gate<string>(); lists.push(g); return g.p; },
    });
    c.api = async (url: string, init: Init) => { calls.push({ url, ...init }); return {}; };
    const A_PIN = 'hatchabot/runtime:trial', B_PIN = 'hatchabot/runtime:candidate';
    const first = c.populateImagePicker(A_PIN);
    lists[0]!.open(`<option value="">Fleet default</option><option value="${A_PIN}" selected>trial</option>`); await first;
    c.editAgentId = 'a2'; const b = c.populateImagePicker(B_PIN); // B's list still loading
    expect($('editImage').dataset.agent).toBe('a2');
    c.editAgentId = 'a1'; const again = c.populateImagePicker(A_PIN); // back to A before it came
    expect([$('editImage').innerHTML, $('editImage').value]).toEqual([`<option value="${A_PIN}">Loading images…</option>`, A_PIN]);
    await c.saveImagePin();
    expect(calls).toEqual([]);
    expect(toasts).toEqual(['Homework Helper: Its list of images is still loading — choose again once it has.']);
    lists[1]!.open(`<option value="">Fleet default</option><option value="${B_PIN}" selected>candidate</option>`); await b;
    lists[2]!.open(`<option value="">Fleet default</option><option value="${A_PIN}" selected>trial</option>`); await again;
    await c.saveImagePin();
    expect(calls.map((x) => [x.url, x.body])).toEqual([['/v1/agents/a1', { image: A_PIN }], ['/v1/agents/a1/rebuild', { stoppedWaits: true }]]);
  });
});

describe('the image picker: filled again for the same agent (a pin moved elsewhere), it loads as the first fill does', () => {
  it('only the new pin is offered while the list loads, Pin waits, and the answer brings the list', async () => {
    const lists: Array<ReturnType<typeof gate<string>>> = [];
    const { c, $, calls, toasts } = page(['populateImagePicker', 'saveImagePin'], {
      imagePickGen: 0, confirmRebuild: () => true,
      imageOptionsHtml: () => { const g = gate<string>(); lists.push(g); return g.p; },
    });
    c.api = async (url: string, init: Init) => { calls.push({ url, ...init }); return {}; };
    const OLD = 'hatchabot/runtime:trial', MOVED = 'hatchabot/runtime:candidate';
    const first = c.populateImagePicker(OLD);
    lists[0]!.open(`<option value="">Fleet default</option><option value="${OLD}" selected>trial</option><option value="${MOVED}">candidate</option>`); await first;
    expect($('editImage').dataset.loading).toBeUndefined();
    const again = c.populateImagePicker(MOVED);
    expect([$('editImage').innerHTML, $('editImage').value, $('editImage').dataset.loading]).toEqual([`<option value="${MOVED}">Loading images…</option>`, MOVED, '1']);
    await c.saveImagePin();
    expect(calls).toEqual([]);
    expect(toasts).toEqual(['Homework Helper: Its list of images is still loading — choose again once it has.']);
    lists[1]!.open(`<option value="">Fleet default</option><option value="${OLD}">trial</option><option value="${MOVED}" selected>candidate</option>`); await again;
    expect([$('editImage').value, $('editImage').dataset.loading]).toEqual([MOVED, undefined]);
  });
});

describe('the image picker: a list for the agent opened before lands nowhere (HB-0583)', () => {
  it("A's list, answered after B's sheet opened, leaves B's pin; while B's loads, only B's pin is offered", async () => {
    const lists = new Map<string, ReturnType<typeof gate<string>>>();
    const { c, $ } = page(['populateImagePicker'], {
      imagePickGen: 0,
      imageOptionsHtml: (pin: string) => { const g = gate<string>(); lists.set(pin, g); return g.p; },
    });
    const a = c.populateImagePicker('hatchabot/runtime:trial');
    c.editAgentId = 'a2';
    const b = c.populateImagePicker('');
    expect($('editImage').innerHTML).toBe('<option value="">Loading images…</option>');
    expect($('editImage').value).toBe('');
    lists.get('')!.open('<option value="" selected>Fleet default</option><option value="hatchabot/runtime:trial">trial</option>'); await b;
    lists.get('hatchabot/runtime:trial')!.open('<option value="">Fleet default</option><option value="hatchabot/runtime:trial" selected>trial</option>'); await a;
    expect($('editImage').value).toBe('');
    expect($('editImage').dataset.agent).toBe('a2');
  });
});

describe("the Data tab: a change answered late is the first agent's alone (HB-0584)", () => {
  it("A's folder add, late, leaves B's list; B's legacy folder removal sends B's own folders to B", async () => {
    const { c, calls, toasts } = page(['addDataSource', 'removeDataSource'], {
      editData: [], renderDataList(data: unknown[]) { c.editData = data ?? []; },
    });
    const added = gate();
    c.api = async (url: string, init: Init) => { calls.push({ url, ...init }); return init.method === 'POST' ? added.p : { dataSources: [] }; };
    c.$('pathNew').value = '/home/made-up/notes'; c.$('pathAccess').value = 'ro';
    const pending = c.addDataSource();
    // B's sheet opens: its own two legacy folders.
    c.editAgentId = 'a2';
    c.editData = [
      { id: 'b-one', legacy: true, hostPath: '/srv/made-up/b-one', mountName: 'b-one', kind: 'folder' },
      { id: 'b-two', legacy: true, hostPath: '/srv/made-up/b-two', mountName: 'b-two', kind: 'folder' },
    ];
    added.open({ dataSources: [{ id: 'a-one', legacy: true, hostPath: '/srv/made-up/a-one', mountName: 'a-one', kind: 'folder' }] });
    await pending;
    expect(c.editData.map((d: { id: string }) => d.id)).toEqual(['b-one', 'b-two']);
    expect(toasts.at(-1)).toBe('Homework Helper: Folder added — Rebuild to apply it.');
    expect(c.$('pathNew').value).toBe('/home/made-up/notes'); // B's box is not A's to empty
    await c.removeDataSource('b-one');
    expect(calls.at(-1)).toEqual({ url: '/v1/agents/a2', method: 'PATCH', body: { sharedPaths: ['/srv/made-up/b-two'] } });
  });

  it('an answer for the agent still shown is drawn, as before', async () => {
    const { c } = page(['addDataSource'], {
      editData: [], renderDataList(data: unknown[]) { c.editData = data ?? []; },
      api: async () => ({ dataSources: [{ id: 'a-one', hostPath: '/srv/made-up/a-one', kind: 'folder' }] }),
    });
    c.$('pathNew').value = '/srv/made-up/a-one';
    await c.addDataSource();
    expect(c.editData.map((d: { id: string }) => d.id)).toEqual(['a-one']);
    expect(c.$('pathNew').value).toBe('');
  });
});

describe('Report a problem: a save or a discard leaves what came after it (HB-0585, HB-0586)', () => {
  const draft = (id: string, title: string, body: string) => ({ id, title, body });
  /** Each PATCH waits for the test, and answers with what the server keeps: "home-server" masked. */
  const saves = () => {
    const sent: Array<{ title: string; body: string }> = [], gates: Array<ReturnType<typeof gate>> = [];
    const api = (_url: string, init: Init) => { sent.push(init.body as { title: string; body: string }); const g = gate(); gates.push(g); return g.p; };
    const answer = async (i: number) => { await until(() => gates[i]); const b = sent[i]!; gates[i]!.open(draft('r-a', b.title.replaceAll('home-server', '{name}'), b.body.replaceAll('home-server', '{name}'))); };
    return { sent, api, answer };
  };
  const until = async (f: () => unknown) => { for (let i = 0; i < 50 && !f(); i++) await new Promise((r) => setTimeout(r, 1)); };

  it('words typed while it saved are kept, and saved too before it goes on (HB-0585)', async () => {
    const s = saves();
    const { c, $, toasts } = page(['reportSaveEdits'], { reportCur: draft('r-a', 'Backups stopped', 'It stopped.'), reportGen: 1, api: s.api });
    $('reportRTitle').value = 'Backups stopped'; $('reportBody').value = 'It stopped.\nAt night.';
    const pending = c.reportSaveEdits();
    $('reportBody').value = 'It stopped.\nAt night. And on Sunday.';
    await s.answer(0);
    expect($('reportBody').value).toBe('It stopped.\nAt night. And on Sunday.'); // not put back to what was sent
    await s.answer(1);
    const r = await pending;
    expect(s.sent.map((x) => x.body)).toEqual(['It stopped.\nAt night.', 'It stopped.\nAt night. And on Sunday.']);
    expect(r.body).toBe('It stopped.\nAt night. And on Sunday.'); // what Copy, the file or GitHub goes on with
    expect(toasts).toEqual([]);
  });

  it('masked in either save: the field shows what will be sent, and that is said once', async () => {
    const s = saves();
    const { c, $, toasts } = page(['reportSaveEdits'], { reportCur: draft('r-a', 'Backups stopped', 'It stopped.'), reportGen: 1, api: s.api });
    $('reportRTitle').value = 'Backups stopped on home-server'; $('reportBody').value = 'It stopped.';
    const pending = c.reportSaveEdits();
    $('reportBody').value = 'It stopped. Typed while it saved.';
    await s.answer(0); await s.answer(1);
    const r = await pending;
    expect([$('reportRTitle').value, $('reportBody').value]).toEqual(['Backups stopped on {name}', 'It stopped. Typed while it saved.']);
    expect([r.title, r.body]).toEqual(['Backups stopped on {name}', 'It stopped. Typed while it saved.']);
    expect(toasts).toEqual(['Some of what you wrote was masked (a private name or key) — the report shows what will be sent.']);
  });

  it('typed through the second save as well: nothing goes out, and it says why', async () => {
    const s = saves();
    const { c, $, toasts } = page(['reportSaveEdits'], { reportCur: draft('r-a', 'Backups stopped', 'It stopped.'), reportGen: 1, api: s.api });
    $('reportRTitle').value = 'Backups stopped'; $('reportBody').value = 'One.';
    const pending = c.reportSaveEdits();
    $('reportBody').value = 'One. Two.';
    await s.answer(0);
    await until(() => s.sent.length === 2);
    $('reportBody').value = 'One. Two. Three.';
    await s.answer(1);
    expect(await pending).toBe(null);
    expect($('reportBody').value).toBe('One. Two. Three.');
    expect(s.sent).toHaveLength(2);
    expect(toasts.at(-1)).toMatch(/newest words are not saved yet/);
  });

  it('discarding A leaves B, opened while A was deleted; with nothing opened since, A closes', async () => {
    const deleted = gate();
    const { c, $ } = page(['reportDiscard'], { reportCur: draft('r-a', 'A', ''), reportGen: 1, reportLoading: null, api: () => deleted.p, reportLoadDrafts: async () => {} });
    const pending = c.reportDiscard();
    c.reportCur = draft('r-b', 'B', 'B, being typed'); c.reportGen++; $('reportReview').hidden = false;
    deleted.open({}); await pending;
    expect(c.reportCur.id).toBe('r-b');
    expect($('reportReview').hidden).toBe(false);
    // Nothing else: closed.
    c.api = async () => ({});
    await c.reportDiscard();
    expect(c.reportCur).toBe(null);
    expect($('reportReview').hidden).toBe(true);
  });

  it('A opened again while it was deleted closes once the delete succeeds; a load of B begun meanwhile still paints', async () => {
    const deleted = gate();
    const { c, $ } = page(['reportDiscard'], { reportCur: draft('r-a', 'A', ''), reportGen: 1, reportLoading: null, api: () => deleted.p, reportLoadDrafts: async () => {} });
    const pending = c.reportDiscard();
    c.reportGen++; c.reportCur = draft('r-a', 'A', 'A, read again'); $('reportReview').hidden = false; // reportShow('r-a') answered
    deleted.open({}); await pending;
    expect(c.reportCur).toBe(null);
    expect([$('reportReview').hidden, $('reportForm').hidden]).toEqual([true, false]);
    // A shown, and a load of B under way, as A's delete answers: A closes, and B's load is not stopped.
    const second = gate();
    c.api = () => second.p;
    c.reportCur = draft('r-a', 'A', ''); $('reportReview').hidden = false;
    const p2 = c.reportDiscard();
    const loadingB = ++c.reportGen; c.reportLoading = 'r-b'; // reportShow('r-b') began
    second.open({}); await p2;
    expect([c.reportCur, $('reportReview').hidden, c.reportGen]).toEqual([null, true, loadingB]);
  });

  it('A clicked again while it was deleted, its load still under way: that load does not paint the deleted draft', async () => {
    const deleted = gate(), loaded = gate();
    const painted: unknown[] = [];
    const { c, $ } = page(['reportDiscard', 'reportShow'], {
      reportCur: draft('r-a', 'A', ''), reportGen: 1, reportLoading: null, reportLoadDrafts: async () => {}, reportPaint: (r: unknown) => painted.push(r),
      api: (_url: string, init?: Init) => (init?.method === 'DELETE' ? deleted.p : loaded.p),
    });
    $('reportReview').hidden = false;
    const pending = c.reportDiscard();
    const again = c.reportShow('r-a'); // clicked in the list while the delete was under way
    deleted.open({}); await pending;
    loaded.open(draft('r-a', 'A', 'as it was')); await again;
    expect([painted, c.reportCur, $('reportReview').hidden]).toEqual([[], null, true]);
  });
});

describe("an app update's answer for an agent no longer shown (HB-0587)", () => {
  it("A's needs-values answer, late, asks nothing in B's sheet and names A in a toast", async () => {
    const answered = gate(), asked: string[] = [];
    const { c, toasts } = page(['v2AppUpdate'], {
      v2AgentId: 'a1', v2AgentDlg: { open: true }, v2Find: (id: string) => AGENTS.find((a) => a.id === id),
      api: () => answered.p, v2AppAskValues: (id: string) => asked.push(id), v2AppShow: () => asked.push('shown'), v2LoadApp: async () => {},
    });
    const btn = { disabled: false, textContent: '' };
    const pending = c.v2AppUpdate('a1', btn);
    c.v2AgentId = 'a2';
    answered.fail(Object.assign(new Error('It needs a value.'), { data: { needs: [{ key: 'calendar_name', type: 'string' }] } }));
    await pending;
    expect(asked).toEqual([]);
    expect(toasts.at(-1)).toBe("Homework Helper's app was not updated: it needs a value first. Give it on its Overview, under App, and press Update again.");
    expect(btn).toEqual({ disabled: false, textContent: '⬆ Update' });
    // Still shown: asked for under its row, as before.
    c.v2AgentId = 'a1';
    c.api = async () => { throw Object.assign(new Error('It needs a value.'), { data: { needs: [{ key: 'calendar_name', type: 'string' }] } }); };
    await c.v2AppUpdate('a1', btn);
    expect(asked).toEqual(['a1']);
  });
});

describe('a task made elsewhere that runs more often than every 15 seconds (HB-0588)', () => {
  const job = { id: 'job1', name: 'Reminder', message: 'Water the beds', everyMs: 1500 };
  // Edit filled the box with the task's interval in minutes, to two places: 0.03 (cronFormOf).
  const cron = (extra: Record<string, unknown> = {}) => page(['addCronJob', 'cronFormOf', 'clearCronForm'], {
    cronAgentId: 'a1', cronCache: [job], cronNotes: new Set(), cronEditingId: 'job1', cronEditFilled: null, cancelCronEdit() {}, cronModeChanged() {}, loadCrons: async () => {}, ...extra,
  });
  it('its name and message can be changed; its cadence is not sent', async () => {
    const { c, $, calls } = cron();
    $('cronName').value = 'Water reminder'; $('cronMsg').value = 'Water the beds'; $('cronMode').value = 'every';
    $('cronEvery').value = String(Math.round(job.everyMs / 600) / 100); // as Edit shows it: 0.03
    await c.addCronJob();
    expect(calls).toEqual([{ url: '/v1/agents/a1/crons/job1', method: 'PATCH', body: { name: 'Water reminder' } }]);
  });
  it('a new or changed interval under 0.25 minutes is still refused', async () => {
    const changed = cron();
    changed.$('cronName').value = 'Reminder'; changed.$('cronMsg').value = 'Water the beds'; changed.$('cronMode').value = 'every'; changed.$('cronEvery').value = '0.1';
    await changed.c.addCronJob();
    expect(changed.calls).toEqual([]);
    expect(changed.$('cronErr').textContent).toMatch(/0\.25/);
    const fresh = cron({ cronEditingId: null });
    fresh.$('cronName').value = 'Reminder'; fresh.$('cronMsg').value = 'Water the beds'; fresh.$('cronMode').value = 'every'; fresh.$('cronEvery').value = '0.03';
    await fresh.c.addCronJob();
    expect(fresh.calls).toEqual([]);
  });
  it('a change near the old interval is a change: refused under 0.25 minutes, not dropped unsaid', async () => {
    // 0.02 minutes is 1.2 seconds, within a second of the task's 1.5: it used to count as unchanged.
    const near = cron();
    near.$('cronName').value = 'Water reminder'; near.$('cronMsg').value = 'Water the beds'; near.$('cronMode').value = 'every'; near.$('cronEvery').value = '0.02';
    await near.c.addCronJob();
    expect(near.calls).toEqual([]);
    expect(near.$('cronErr').textContent).toMatch(/0\.25/);
  });
  it('an emptied box is an error, even for a task under a second', async () => {
    const quick = { ...job, everyMs: 600 }; // Edit shows 0.01
    const emptied = cron({ cronCache: [quick] });
    emptied.$('cronName').value = 'Water reminder'; emptied.$('cronMsg').value = 'Water the beds'; emptied.$('cronMode').value = 'every'; emptied.$('cronEvery').value = '';
    await emptied.c.addCronJob();
    expect(emptied.calls).toEqual([]);
    expect(emptied.$('cronErr').textContent).toMatch(/interval/);
  });
  it('the number Edit put there, written another way (1.670 for 1.67), is the same interval: not sent', async () => {
    const odd = { ...job, everyMs: 100000 }; // Edit shows 1.67
    const same = cron({ cronCache: [odd] });
    same.$('cronName').value = 'Water reminder'; same.$('cronMsg').value = 'Water the beds'; same.$('cronMode').value = 'every'; same.$('cronEvery').value = '1.670';
    await same.c.addCronJob();
    expect(same.calls).toEqual([{ url: '/v1/agents/a1/crons/job1', method: 'PATCH', body: { name: 'Water reminder' } }]);
  });
  it('a longer interval typed again as it was (30.0 for 30) is not sent', async () => {
    const half = { ...job, everyMs: 30 * 60000 };
    const same = cron({ cronCache: [half] });
    same.$('cronName').value = 'Reminder'; same.$('cronMsg').value = 'Water the beds'; same.$('cronMode').value = 'every'; same.$('cronEvery').value = '30.0';
    await same.c.addCronJob();
    expect(same.calls).toEqual([]);
    expect(same.$('cronErr').textContent).toBe('');
  });
  it('Save sends only what was changed from what Edit put in the form: a change made elsewhere since is not undone', async () => {
    // Edit filled the form; then the agent changed the task's message and interval, and the list was read again.
    const changedElsewhere = { ...job, message: 'Water the beds and the pots', everyMs: 30 * 60000, scheduleTz: '' };
    const { c, $, calls } = cron({ cronCache: [changedElsewhere], cronEditFilled: { name: 'Reminder', message: 'Water the beds', mode: 'every', every: '0.03', cron: '', tz: '', notify: false } });
    $('cronName').value = 'Water reminder'; $('cronMsg').value = 'Water the beds'; $('cronMode').value = 'every'; $('cronEvery').value = '0.03';
    await c.addCronJob();
    expect(calls).toEqual([{ url: '/v1/agents/a1/crons/job1', method: 'PATCH', body: { name: 'Water reminder' } }]);
  });
});

describe('Files: a picture, a player or a reader at the public address gets the second factor when it fails (HB-0589)', () => {
  /** The preview's element: its listeners, and the src it is given. */
  const shownEl = () => {
    const on: Array<{ fn: () => unknown; once: boolean }> = [];
    return {
      src: '', isConnected: true, on,
      addEventListener: (_ev: string, fn: () => unknown, o?: { once?: boolean }) => { on.push({ fn, once: !!o?.once }); },
      async fail() { const now = on.splice(0); for (const l of now) { if (!l.once) on.push(l); await l.fn(); } },
    };
  };
  const files = (appConfig: Record<string, unknown>, api: (url: string) => Promise<unknown>) => {
    const shown = shownEl();
    const p = page(['v2OpenFile'], {
      appConfig, api, v2FilesGen: new Map(),
      V2_TEXT_FILE: /\.(txt|md)$/i, V2_IMAGE_FILE: /\.png$/i, V2_AUDIO_FILE: /\.mp3$/i, V2_VIDEO_FILE: /\.mp4$/i, V2_PDF_FILE: /\.pdf$/i, V2_VIEW_MAX: 2 * 1024 * 1024,
    });
    p.$('v2Files').dataset.agent = 'a1';
    Object.assign(p.$('v2Files'), { querySelector: () => shown });
    return { ...p, shown };
  };
  /** What /v1/config says when this page came in through the public listener (isPublic). */
  const PUBLIC = { publicAddress: true };
  it('the picture, player or reader is drawn at once: no read of its folder first', async () => {
    const read: string[] = [];
    for (const name of ['plan.png', 'note.mp3', 'walk.mp4']) {
      const { c, $ } = files(PUBLIC, async (url) => { read.push(url); return { entries: [] }; });
      await c.v2OpenFile('a1', 'garden', name, 10);
      expect($('v2Files').innerHTML).toContain(`/v1/agents/a1/fs/file?path=${encodeURIComponent('garden/' + name)}&inline=1`);
    }
    expect(read).toEqual([]);
  });
  it("its load failing: the file's check through api() (which asks; it reads no file and no folder), then the file once more; failing again, said", async () => {
    const read: string[] = [];
    const { c, $, shown } = files(PUBLIC, async (url) => { read.push(url); return {}; });
    await c.v2OpenFile('a1', 'garden', 'plan.png', 10);
    await shown.fail();
    expect(read).toEqual([`/v1/agents/a1/fs/file?path=${encodeURIComponent('garden/plan.png')}&check=1`]);
    expect(shown.src).toBe(`/v1/agents/a1/fs/file?path=${encodeURIComponent('garden/plan.png')}&inline=1&again=1`);
    await shown.fail();
    expect(read).toHaveLength(1); // once
    expect($('v2Files').innerHTML).toContain('It could not be shown here.');
  });
  it('the factor not given: said, and no broken picture; at home, a failure reads nothing', async () => {
    const refused = files(PUBLIC, async () => { throw new Error('The second factor was not given.'); });
    await refused.c.v2OpenFile('a1', '', 'plan.png', 10);
    await refused.shown.fail();
    expect(refused.$('v2Files').innerHTML).toContain('The second factor was not given.');
    expect(refused.$('v2Files').innerHTML).not.toContain('<img');
    const read: string[] = [];
    const home = files({}, async (url) => { read.push(url); return {}; });
    await home.c.v2OpenFile('a1', '', 'plan.png', 10);
    expect(home.shown.on).toEqual([]);
    expect(read).toEqual([]);
  });
  it("a reader in a frame, which cannot say it failed: the file's check first through api() (which asks; it reads nothing), then the sandboxed URL in the frame; no folder, no second download", async () => {
    const read: string[] = [];
    const { c, $ } = files(PUBLIC, async (url) => { read.push(url); return {}; });
    await c.v2OpenFile('a1', 'garden', 'map.pdf', 10);
    const url = `/v1/agents/a1/fs/file?path=${encodeURIComponent('garden/map.pdf')}`;
    expect(read).toEqual([`${url}&check=1`]);
    expect($('v2Files').innerHTML).toContain(`<iframe src="${url}&inline=1"`);
    // Open in a tab asks the same check first, not the folder.
    expect($('v2Files').innerHTML).toContain(`sfOpen(event, this, '${url}&check=1')`);
    // The factor not given, or the file refused: said, and no frame.
    const refused = files(PUBLIC, async () => { throw new Error('The second factor was not given.'); });
    await refused.c.v2OpenFile('a1', 'garden', 'map.pdf', 10);
    expect(refused.$('v2Files').innerHTML).toContain('The second factor was not given.');
    expect(refused.$('v2Files').innerHTML).not.toContain('<iframe');
    const gone = files(PUBLIC, async () => { throw new Error('No such file or folder.'); });
    await gone.c.v2OpenFile('a1', 'garden', 'map.pdf', 10);
    expect([gone.$('v2Files').innerHTML.includes('No such file or folder.'), gone.$('v2Files').innerHTML.includes('<iframe')]).toEqual([true, false]);
    // Over the size limit: the check says so (the download's own refusal), and that is shown, not a frame.
    const big = files(PUBLIC, async () => { throw new Error('Too big to download here (600 MB; the limit is 512 MB — HATCHABOT_FILE_MAX_MB).'); });
    await big.c.v2OpenFile('a1', 'garden', 'map.pdf', 10);
    expect([big.$('v2Files').innerHTML.includes('Too big to download here'), big.$('v2Files').innerHTML.includes('<iframe')]).toEqual([true, false]);
  });
  it('reached at the private address (publicAddress false, a public address set up or not): a reader reads nothing first', async () => {
    const read: string[] = [];
    const { c, $ } = files({ publicAddress: false }, async (url) => { read.push(url); return {}; });
    await c.v2OpenFile('a1', 'garden', 'map.pdf', 10);
    expect(read).toEqual([]);
    expect($('v2Files').innerHTML).toContain('<iframe');
  });
});

describe('the Schedule form: a task typed for A is not carried to B (HB-0591)', () => {
  it("B's form starts empty, and Add there creates nothing; A again keeps what was typed", async () => {
    const { c, $, calls } = page(['prepareCrons', 'addCronJob', 'clearCronForm'], {
      cronAgentId: 'a1', cronCache: [], cronNotes: new Set(), cronEditingId: null, cronEditFilled: null,
      cancelCronEdit() {}, cronModeChanged() {}, loadCrons: async () => {},
    });
    c.api = async (url: string, init: Init) => { calls.push({ url, ...init }); return {}; };
    const boxes = () => ['cronName', 'cronMsg', 'cronExpr', 'cronEvery', 'cronTz', 'cronMode'].map((id) => $(id).value);
    $('cronName').value = 'Water reminder'; $('cronMsg').value = 'Water the beds'; $('cronMode').value = 'every'; $('cronEvery').value = '30';
    c.prepareCrons('a1', 'Homework Helper');
    expect(boxes()).toEqual(['Water reminder', 'Water the beds', '', '30', '', 'every']);
    c.prepareCrons('a2', 'Soccer Schedule');
    expect(boxes()).toEqual(['', '', '', '', '', 'cron']);
    await c.addCronJob();
    expect(calls).toEqual([]);
    expect($('cronErr').textContent).toMatch(/are all needed/);
  });
  it('a task added: the form is empty after, its interval and time zone too, and the kind back to a schedule (clearCronForm)', async () => {
    const boxes = (p: ReturnType<typeof page>) => ['cronName', 'cronMsg', 'cronExpr', 'cronEvery', 'cronTz', 'cronMode'].map((id) => p.$(id).value);
    const every = page(['addCronJob', 'cronFormOf', 'clearCronForm'], {
      cronAgentId: 'a1', cronCache: [], cronNotes: new Set(), cronEditingId: null, cronEditFilled: null, cancelCronEdit() {}, cronModeChanged() {}, loadCrons: async () => {},
    });
    every.$('cronName').value = 'Water reminder'; every.$('cronMsg').value = 'Water the beds'; every.$('cronMode').value = 'every'; every.$('cronEvery').value = '30';
    await every.c.addCronJob();
    expect(every.calls.map((x) => x.url)).toEqual(['/v1/agents/a1/crons']);
    expect(boxes(every)).toEqual(['', '', '', '', '', 'cron']);
    const zoned = page(['addCronJob', 'cronFormOf', 'clearCronForm'], {
      cronAgentId: 'a1', cronCache: [], cronNotes: new Set(), cronEditingId: null, cronEditFilled: null, cancelCronEdit() {}, cronModeChanged() {}, loadCrons: async () => {},
    });
    zoned.$('cronName').value = 'Morning brief'; zoned.$('cronMsg').value = 'Good morning'; zoned.$('cronMode').value = 'cron'; zoned.$('cronExpr').value = '0 8 * * *'; zoned.$('cronTz').value = 'Pacific/Chatham';
    await zoned.c.addCronJob();
    expect(zoned.calls.map((x) => (x.body as { tz?: string }).tz)).toEqual(['Pacific/Chatham']);
    expect(boxes(zoned)).toEqual(['', '', '', '', '', 'cron']);
  });
  it('an Edit under way stays one when the same agent\'s Schedule tab is drawn again; another agent ends it', () => {
    let ended = 0;
    const { c } = page(['prepareCrons', 'clearCronForm'], { cronAgentId: 'a1', cronEditingId: 'job1', cancelCronEdit() { ended++; c.cronEditingId = null; }, cronModeChanged() {} });
    c.prepareCrons('a1', 'Homework Helper'); // Overview and back
    expect([c.cronEditingId, ended]).toEqual(['job1', 0]);
    c.prepareCrons('a2', 'Soccer Schedule');
    expect([c.cronEditingId, ended]).toEqual([null, 1]);
  });
});

describe("a folder's Test, answered after B's forms opened, is said for A (checkDataSource)", () => {
  const rowed = () => {
    const out = element('ds-check');
    const p = page(['checkDataSource'], { CSS: { escape: (s: string) => s }, showDeployKey() {} });
    Object.assign(p.$('dataList'), { querySelector: () => ({ querySelector: () => out }) });
    return { ...p, out };
  };
  it("not under B's rows: a toast with A's name", async () => {
    const checked = gate();
    const { c, out, toasts, calls } = rowed();
    c.api = (url: string, init: Init) => { calls.push({ url, ...init }); return checked.p; };
    const pending = c.checkDataSource('ds-a');
    c.editAgentId = 'a2'; out.isConnected = false; // B's list drawn over A's rows
    checked.open({ ok: true, message: 'The folder is there and readable.' }); await pending;
    expect(calls.map((x) => x.url)).toEqual(['/v1/agents/a1/data-sources/ds-a/check']);
    expect(toasts).toEqual(['Homework Helper: ✅ The folder is there and readable.']);
  });
  it('its own row in sight: under it, and no toast', async () => {
    const { c, $, out, toasts } = rowed();
    c.v2AgentDlg.open = true; c.v2AgentId = 'a1'; $('v2Pane').contains = () => true;
    c.api = async () => ({ ok: false, message: 'Not readable by the service.' });
    await c.checkDataSource('ds-a');
    expect([out.textContent, out.style.color, toasts]).toEqual(['⚠️ Not readable by the service.', 'var(--warn)', []]);
  });
});

describe("an app update needing a value, answered with A's sheet on another tab (v2AppUpdate)", () => {
  it('the App row not on screen: said with its name and where to give it, no form drawn', async () => {
    const asked: unknown[] = [];
    const { c, toasts } = page(['v2AppUpdate'], { v2AgentDlg: { open: true }, v2AgentId: 'a1', v2AppAskValues: (...a: unknown[]) => asked.push(a), v2AppShow() {}, v2LoadApp() {} });
    const plain = c.$;
    c.$ = (id: string) => id === 'v2AppOut' ? null : plain(id); // its Advanced tab: no App row
    c.api = async () => { throw Object.assign(new Error('Needs a value for: mailbox.'), { data: { needs: [{ key: 'mailbox', label: 'its address' }], unchanged: true } }); };
    await c.v2AppUpdate('a1', element('btn'));
    expect(asked).toEqual([]);
    expect(toasts.at(-1)).toBe("Homework Helper's app was not updated: it needs a value first. Give it on its Overview, under App, and press Update again.");
  });
});

describe("a class set for A, answered after B's sheet opened (HB-0590)", () => {
  it("leaves B's model menu, and says A's name", async () => {
    const set = gate(), painted: string[] = [];
    const { c, $, toasts } = page(['assignClass'], { v2AgentId: 'a1', v2AgentDlg: { open: true }, api: () => set.p, renderModelPickerForAgent: (a: { id: string }) => painted.push(a.id) });
    $('editClass').value = 'class-school';
    const pending = c.assignClass();
    c.v2AgentId = 'a2'; c.editAgentId = 'a2';
    set.open({ classId: 'class-school', rebuild: false }); await pending;
    expect(painted).toEqual([]);
    expect(toasts.at(-1)).toBe('Homework Helper: Class set — model applied.');
    // Still A's: its menu is drawn again, as before.
    c.v2AgentId = 'a1'; c.editAgentId = 'a1'; c.api = async () => ({ classId: 'class-school', rebuild: false });
    await c.assignClass();
    expect(painted).toEqual(['a1']);
  });
});

describe('the AI tab: a model or source answered after another agent opened is said for its own agent', () => {
  it("A's model switch, late: named in a toast; its failure too, and B's form shows no error of A's", async () => {
    const answered = gate();
    const { c, $, toasts } = page(['switchModel'], { v2AgentId: 'a1', v2AgentDlg: { open: true }, api: () => answered.p });
    $('editModel').value = 'claude-sonnet-5';
    const pending = c.switchModel();
    c.v2AgentId = 'a2'; c.editAgentId = 'a2';
    answered.open({ model: 'claude-sonnet-5', live: true }); await pending;
    expect(toasts).toEqual(['Homework Helper: Now running claude-sonnet-5 — effective on the next message, no rebuild.']);
    const refused = gate();
    c.api = () => refused.p; c.v2AgentId = 'a1'; c.editAgentId = 'a1';
    const failing = c.switchModel();
    c.v2AgentId = 'a2'; c.editAgentId = 'a2';
    refused.fail(new Error('That model is not on its source.')); await failing;
    expect(toasts.at(-1)).toBe('Homework Helper: That model is not on its source.');
    expect($('editErr').textContent).toBe('');
  });
  it("A's source switch failing after B opened: named in a toast, not in B's form", async () => {
    const refused = gate();
    const { c, $, toasts } = page(['switchProfile'], {
      v2AgentId: 'a1', v2AgentDlg: { open: true }, api: () => refused.p, localClashWarning: () => '',
      profiles: [{ id: 'p2', name: 'Spare key', model: 'claude-sonnet-5' }],
    });
    $('editProfile').value = 'p2';
    const pending = c.switchProfile();
    c.v2AgentId = 'a2'; c.editAgentId = 'a2';
    refused.fail(new Error('That source is not shared with you.')); await pending;
    expect(toasts.at(-1)).toBe('Homework Helper: That source is not shared with you.');
    expect($('editErr').textContent).toBe('');
  });
});

describe('the sheet\'s notes do not build up (v2SheetUnsaved)', () => {
  it('a control drawn over since (no longer in the page) loses its note when the sheet is next checked, and only then', () => {
    const gone = { isConnected: false, value: 'changed' }, kept = { isConnected: true, value: 'kept' }, filled = { isConnected: true, value: 'new' };
    const notes = new Map<unknown, string>([[gone, 'old'], [kept, 'kept']]);
    const { c } = page(['v2SheetBaseline', 'v2SheetUnsaved'], { v2SheetNotes: notes, v2SheetFills: new WeakMap(), v2SheetControlsOf: () => [filled], v2CtlValue: (el: { value: string }) => el.value, cronEditingId: null, v2EditFor: null });
    c.v2SheetBaseline(filled); // a fill notes what it filled, and nothing else
    expect([...notes.keys()]).toEqual([gone, kept, filled]);
    expect(c.v2SheetUnsaved()).toBe(false); // the one drawn over is not an edit; its note goes
    expect([...notes.keys()]).toEqual([kept, filled]);
  });
});

describe("an edit form's answer goes by what is on screen (forAgent)", () => {
  it("A's variable removed, answered after B's forms opened: B's list stays B's, and A is named", async () => {
    const removed = gate();
    const drawn: unknown[] = [];
    const { c, calls, toasts } = page(['removeEnvVar'], { renderEnvList: (v: unknown) => drawn.push(v) });
    c.api = (url: string, init: Init) => { calls.push({ url, ...init }); return removed.p; };
    const pending = c.removeEnvVar('env-a', 'MADE_UP_A');
    c.editAgentId = 'a2'; c.v2AgentId = 'a2'; c.v2AgentDlg.open = true;
    removed.open({ envVars: [] }); await pending;
    expect(calls.map((x) => [x.method, x.url])).toEqual([['DELETE', '/v1/agents/a1/env/env-a']]);
    expect(drawn).toEqual([]);
    expect(toasts).toEqual(['Homework Helper: MADE_UP_A removed — Rebuild to apply it.']);
  });
  it("A's failure with B's Overview shown (the forms still A's, out of sight): a toast with A's name", async () => {
    const refused = gate();
    const { c, $, toasts } = page(['saveImagePin'], { v2AgentId: 'a1', v2AgentDlg: { open: true }, api: () => refused.p, confirmRebuild: () => true });
    $('editImage').value = 'hatchabot/runtime:trial';
    const pending = c.saveImagePin();
    c.v2AgentId = 'a2'; // B's Overview: no prepareEdit, so editAgentId stays a1
    refused.fail(new Error('No such image here.')); await pending;
    expect(toasts).toEqual(['Homework Helper: No such image here.']);
    expect($('editErr').textContent).toBe('');
  });
  it("A's own forms in sight: under them, as before; A's Overview: a toast without a name", async () => {
    const { c, $, toasts } = page(['resetSetupValues'], { v2AgentId: 'a1', v2AgentDlg: { open: true }, renderSetupValues() {} });
    c.api = async () => { throw new Error('No setup fields to reset.'); };
    $('v2Pane').contains = () => true;
    await c.resetSetupValues();
    expect($('editErr').textContent).toBe('No setup fields to reset.');
    $('editErr').textContent = ''; $('v2Pane').contains = () => false;
    await c.resetSetupValues();
    expect([$('editErr').textContent, toasts]).toEqual(['', ['No setup fields to reset.']]);
  });
  it("A's setup fields saved after B's forms opened: B's list is not marked saved", async () => {
    const saved = gate();
    const { c } = page(['saveSetupFields'], { editParams: [{ key: 'mailbox' }], editParamsSaved: '[]', api: () => saved.p });
    const pending = c.saveSetupFields();
    c.editAgentId = 'a2'; c.editParams = [{ key: 'team' }]; c.editParamsSaved = '[]';
    saved.open({}); await pending;
    expect(c.editParamsSaved).toBe('[]');
  });
  it("setup fields saved while the same agent's forms were filled again: the fill's list is the baseline", async () => {
    // Pressed with one field added; the sheet closed and opened again before the answer (prepareEdit counts a fill).
    const saved = gate();
    const { c } = page(['saveSetupFields'], { editParams: [{ key: 'mailbox' }], editParamsSaved: '[]', api: () => saved.p });
    const pending = c.saveSetupFields();
    c.editParams = []; c.editParamsSaved = '[]'; c.editParamsFills++;
    saved.open({}); await pending;
    expect(c.editParamsSaved).toBe('[]'); // not the list sent, which the forms no longer show: nothing held unsaved
    // Not filled again: the list sent is the saved one.
    const again = page(['saveSetupFields'], { editParams: [{ key: 'mailbox' }], editParamsSaved: '[]' });
    await again.c.saveSetupFields();
    expect(again.c.editParamsSaved).toBe(JSON.stringify([{ key: 'mailbox' }]));
  });
  it('a repo added: the same words, with when it is cloned, on screen or not (addGitSource)', async () => {
    const stopped = { dataSources: [{ id: 'g1', kind: 'git', repoUrl: 'https://example.com/made-up/notes.git' }], state: 'STOPPED' };
    const add = (shown: boolean) => {
      const p = page(['addGitSource'], { api: async () => stopped, renderDataList() {}, showDeployKeyForSource() {}, v2SheetSaving: () => () => {} });
      p.$('repoUrl').value = 'https://example.com/made-up/notes.git'; p.$('repoPublic').checked = true;
      if (!shown) p.c.editAgentId = 'a1', Object.assign(p.c, { v2AgentDlg: { open: true }, v2AgentId: 'a2' });
      return p;
    };
    const away = add(false);
    const sent = away.c.addGitSource(); away.c.editAgentId = 'a2'; await sent;
    expect(away.toasts).toEqual(['Homework Helper: Public repo added — it is cloned on the next Rebuild.']);
    expect(away.$('repoUrl').value).toBe('https://example.com/made-up/notes.git'); // B's forms are not touched
    const here = add(true);
    here.c.editDlg = { open: true };
    await here.c.addGitSource();
    expect(here.toasts).toEqual(['Public repo added — it is cloned on the next Rebuild.']);
    expect([here.$('repoUrl').value, here.$('repoPublic').checked]).toEqual(['', false]);
  });
});

describe('"Its name: " is decided once, from the agent shown (agentPrefix)', () => {
  it("the sheet closed while a class saved: named, though the edit forms are still that agent's", async () => {
    const set = gate();
    const { c, $, toasts } = page(['assignClass'], { v2AgentId: 'a1', v2AgentDlg: { open: true }, api: () => set.p, renderModelPickerForAgent() {} });
    $('editClass').value = 'class-school';
    const classed = c.assignClass();
    c.v2AgentDlg.open = false; c.v2AgentId = null; // closed: editAgentId stays a1, but nothing shows it
    set.open({ classId: 'class-school' }); await classed;
    expect(toasts).toEqual(['Homework Helper: Class set — model applied.']);
  });
  it('the sheet decides, then the classic edit dialog; nothing open names every agent', () => {
    const { c } = page([], { v2AgentId: 'a1', editAgentId: 'a2' });
    expect([c.agentPrefix('a1'), c.agentPrefix('a2')]).toEqual(['Homework Helper: ', 'Soccer Schedule: ']);
    c.v2AgentDlg.open = true;
    expect([c.agentPrefix('a1'), c.agentPrefix('a2')]).toEqual(['', 'Soccer Schedule: ']);
    c.v2AgentDlg.open = false; c.editDlg.open = true;
    expect([c.agentPrefix('a1'), c.agentPrefix('a2'), c.agentPrefix('gone')]).toEqual(['Homework Helper: ', '', 'The agent: ']);
  });
});

describe('a value typed for one agent and not added does not carry to the next (HB-0591)', () => {
  it("the environment variable, folder and repo boxes empty when the agent changes, and stay for the same agent", () => {
    const noop = () => {};
    const { c, $ } = page(['prepareEdit', 'onRepoPublic'], {
      showEditTab: noop, renderModelPickerForAgent: noop, populateImagePicker: async () => {}, renderSetupValues: noop, renderBotWho: noop,
      renderEditMembers: async () => {}, renderParamList: noop, renderDataList: noop, renderEnvList: noop, embedModeText: () => '', sourceOptionLabel: () => '',
    });
    const fill = () => { $('envName').value = 'MADE_UP_KEY'; $('envValue').value = 'made-up-value'; $('pathNew').value = '/srv/made-up'; $('repoUrl').value = 'https://example.com/made-up.git'; };
    fill();
    c.prepareEdit('a1', 'Homework Helper');
    expect($('envValue').value).toBe('made-up-value'); // the same agent: its own draft
    c.prepareEdit('a2', 'Soccer Schedule');
    expect([$('envName').value, $('envValue').value, $('pathNew').value, $('repoUrl').value]).toEqual(['', '', '', '']);
  });
  it('and the choices beside them go back to read-only, not public', () => {
    const noop = () => {};
    const { c, $ } = page(['prepareEdit', 'onRepoPublic'], {
      showEditTab: noop, renderModelPickerForAgent: noop, populateImagePicker: async () => {}, renderSetupValues: noop, renderBotWho: noop,
      renderEditMembers: async () => {}, renderParamList: noop, renderDataList: noop, renderEnvList: noop, embedModeText: () => '', sourceOptionLabel: () => '',
    });
    $('pathAccess').value = 'rw'; $('repoAccess').value = 'rw'; $('repoPublic').checked = true; $('repoAccess').disabled = true;
    c.prepareEdit('a1', 'Homework Helper');
    expect([$('pathAccess').value, $('repoAccess').value, $('repoPublic').checked]).toEqual(['rw', 'rw', true]); // the same agent: as chosen
    c.prepareEdit('a2', 'Soccer Schedule');
    expect([$('pathAccess').value, $('repoAccess').value, $('repoPublic').checked, $('repoAccess').disabled]).toEqual(['ro', 'ro', false, false]);
  });
  it('and a setup field being declared: its key, label, type, target, default and options as drawn', () => {
    const noop = () => {}, shown: string[] = [];
    const { c, $ } = page(['prepareEdit', 'onRepoPublic'], {
      showEditTab: noop, renderModelPickerForAgent: noop, populateImagePicker: async () => {}, renderSetupValues: noop, renderBotWho: noop,
      renderEditMembers: async () => {}, renderParamList: noop, renderDataList: noop, renderEnvList: noop, embedModeText: () => '', sourceOptionLabel: () => '',
      onParamTypeChange: () => shown.push($('paramType').value),
    }, ['v2CtlDrawn']);
    const select = (id: string, values: string[]) => Object.assign($(id), { tagName: 'SELECT', options: values.map((value, i) => ({ value, defaultSelected: i === 0 })) });
    select('paramType', ['text', 'choice', 'boolean']); select('paramTarget', ['soul', 'agents', 'env']);
    for (const f of ['paramKey', 'paramLabel', 'paramDefault', 'paramOptions']) Object.assign($(f), { defaultValue: '' });
    Object.assign($('paramRequired'), { type: 'checkbox', defaultChecked: false });
    const typed = () => {
      $('paramKey').value = 'city'; $('paramLabel').value = 'Your city'; $('paramDefault').value = 'Springfield'; $('paramOptions').value = 'north, south';
      $('paramRequired').checked = true; $('paramType').value = 'choice'; $('paramTarget').value = 'env';
    };
    const boxes = () => ['paramKey', 'paramLabel', 'paramDefault', 'paramOptions', 'paramType', 'paramTarget'].map((f) => $(f).value).concat(String($('paramRequired').checked));
    typed();
    c.prepareEdit('a1', 'Homework Helper');
    expect(boxes()).toEqual(['city', 'Your city', 'Springfield', 'north, south', 'choice', 'env', 'true']); // the same agent: its draft
    c.prepareEdit('a2', 'Soccer Schedule');
    expect(boxes()).toEqual(['', '', '', '', 'text', 'soul', 'false']);
    expect(shown).toEqual(['text']); // the options box hidden again with its type
  });
});

describe("Bulk actions' result line, part by part (faResultLine)", () => {
  const none = { ok: 0, memoryLater: 0, skipped: 0, atRebuild: 0, notApplied: [], nothingNew: 0, nextStart: 0, marked: 0, notRebuilt: 0, notSaved: 0, failed: 0 };
  const line = (n: Record<string, unknown>) => page(['faResultLine', 'reasonFor']).c.faResultLine({ ...none, ...n });
  it('each count in its words, one and many, in order, and the noughts left out', () => {
    expect(line({ ok: 2 })).toBe('✓ 2 done.');
    expect(line({ ok: 1, memoryLater: 1 })).toBe('✓ 1 done (its memory limits at its next rebuild).');
    expect(line({ ok: 3, memoryLater: 3 })).toBe('✓ 3 done (their memory limits at each one’s next rebuild).');
    expect(line({ ok: 3, memoryLater: 2 })).toBe('✓ 3 done (2 of them: memory limits at each one’s next rebuild).');
    expect(line({ ok: 0, skipped: 2, atRebuild: 1, nothingNew: 1, nextStart: 2, marked: 1 }))
      .toBe('✓ 0 done · 2 skipped (not applicable) · 1 saved, applied at its next rebuild · 1 found nothing new to save · 2 not running, so they move when each next starts · 1 not running: rebuilt when it next starts.');
    expect(line({ ok: 1, notRebuilt: 1, notSaved: 2, failed: 1 }))
      .toBe('✓ 1 done · <span style="color:var(--warn)">1 pinned, but not rebuilt yet</span> · <span style="color:var(--warn)">2 not saved (AI source didn\'t respond)</span> · <span style="color:var(--bad)">1 failed</span>.');
  });
  it('every agent saved but not applied, with its own reason, its full stop dropped', () => {
    expect(line({ ok: 0, notApplied: [{ name: 'Homework Helper', why: 'Its runtime refused the model.' }, { name: 'Garden Planner', why: 'Its memory limit waits.' }] }))
      .toBe('✓ 0 done · <span style="color:var(--warn)">2 saved, but not applied: Homework Helper: Its runtime refused the model; Garden Planner: Its memory limit waits</span>.');
  });
});

describe('Bulk actions: a model or class saved but refused by the runtime is not "done" (HB-0595)', () => {
  const bulk = (action: string, answers: Record<string, unknown>[]) => {
    const p = page(['faApply', 'faResultLine', 'reasonFor', 'reasonsSaid'], {
      faSelected: () => answers.map((_, i) => ({ dataset: { id: AGENTS[i]!.id } })),
      agentClasses: [{ id: 'class-school', model: 'claude-sonnet-5' }], renderClassList() {},
    });
    let n = 0;
    p.c.api = async () => answers[n++];
    p.$('faAction').value = action; p.$('faModel').value = 'claude-sonnet-5'; p.$('faClass').value = 'class-school';
    return p;
  };
  it('model: refused, applied, waiting for a rebuild — each counted as what it is', async () => {
    const { c, $ } = bulk('model', [{ live: false, failed: true }, { live: true }, { rebuild: true }]);
    await c.faApply();
    expect($('faResults').innerHTML).toMatch(/^✓ 1 done · 1 saved, applied at its next rebuild · <span[^>]*>1 saved, but not applied: Homework Helper: saved, but its runtime refused it: it answers on the old model until you try again or Rebuild<\/span>\.$/);
    expect($('faErr').textContent).toBe(''); // the failures' line: none failed
  });
  it('3 failures, then 2 refused: each refused agent with its own reason, apart from the failures', async () => {
    const five = [...AGENTS, { id: 'a4', name: 'Piano Practice', profileModels: ['claude-sonnet-5'], state: 'RUNNING' }, { id: 'a5', name: 'Meal Planner', profileModels: ['claude-sonnet-5'], state: 'RUNNING' }];
    const p = page(['faApply', 'faResultLine', 'reasonFor', 'reasonsSaid'], { agents: five, faSelected: () => five.map((a) => ({ dataset: { id: a.id } })), renderClassList() {} });
    const down = new Error('The model service did not answer.');
    const answers = [down, down, down, { failed: true }, { failed: true }];
    let n = 0;
    p.c.api = async () => { const a = answers[n++]; if (a instanceof Error) throw a; return a; };
    p.$('faAction').value = 'model'; p.$('faModel').value = 'claude-sonnet-5';
    await p.c.faApply();
    const refusedWhy = 'saved, but its runtime refused it: it answers on the old model until you try again or Rebuild';
    expect(p.$('faResults').innerHTML).toContain(`2 saved, but not applied: Piano Practice: ${refusedWhy}; Meal Planner: ${refusedWhy}</span>`);
    expect(p.$('faResults').innerHTML).toMatch(/<span style="color:var\(--bad\)">3 failed<\/span>\.$/);
    expect(p.$('faErr').textContent).toBe('Homework Helper: The model service did not answer; Soccer Schedule: The model service did not answer; Garden Planner: The model service did not answer'); // reasonsSaid, as Rebuild all names them
  });
  it('class: a model or memory limit the runtime refused, a source to rebuild, and one applied', async () => {
    const { c, $ } = bulk('class', [{ modelPending: 'It joined the class, but its runtime refused the model.' }, { rebuild: true }, { classId: 'class-school' }]);
    await c.faApply();
    expect($('faResults').innerHTML).toContain('1 done');
    expect($('faResults').innerHTML).toContain('1 saved, applied at its next rebuild');
    expect($('faResults').innerHTML).toContain('1 saved, but not applied: Homework Helper: It joined the class, but its runtime refused the model</span>');
    expect($('faErr').textContent).toBe('');
  });
  it('class: memory limits waiting for a rebuild are applied, with a note; a source to rebuild is counted as that', async () => {
    const memory = 'Its container kept its old memory limits (busy); a rebuild applies them.';
    const { c, $ } = bulk('class', [{ memoryPending: memory }, { memoryPending: memory, rebuild: true }, { classId: 'class-school' }]);
    await c.faApply();
    expect($('faResults').innerHTML).toBe('✓ 2 done (1 of them: memory limits at its next rebuild) · 1 saved, applied at its next rebuild.');
    expect($('faErr').textContent).toBe('');
    const one = bulk('class', [{ memoryPending: memory }]);
    await one.c.faApply();
    expect(one.$('faResults').innerHTML).toBe('✓ 1 done (its memory limits at its next rebuild).');
  });
});

describe('Rebuild all and Bulk Rebuild: a stopped agent is marked when a rebuild would change it (HB-0466)', () => {
  // Garden Planner stopped on an older image (the server's own answer: rebuild); Piano Practice stopped, already current.
  const behind = { ...AGENTS[2]!, updateAvailable: true, rebuild: { level: 'recommended', reasons: ['a made-up reason'] } };
  const current = { id: 'a4', name: 'Piano Practice', state: 'STOPPED', runtimeRef: 'docker://w' };
  const fleet = () => [{ ...AGENTS[0]! }, { ...AGENTS[1]! }, { ...behind }, { ...current }];
  const answer = (calls: Call[]) => async (url: string, init: Init) => { calls.push({ url, ...init }); return url.includes('/a3/') ? { rebuilding: false, atNextStart: true } : { rebuilding: true }; };
  it('Rebuild all: the running ones, and the stopped one behind; the current one is left as it is', async () => {
    const { c, calls, toasts } = page(['rebuildAll', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], { agents: fleet() });
    c.api = answer(calls);
    await c.rebuildAll();
    expect(calls.map((x) => [x.url, x.body])).toEqual([
      ['/v1/agents/a1/rebuild', { stoppedWaits: true }], ['/v1/agents/a2/rebuild', { stoppedWaits: true }], ['/v1/agents/a3/rebuild', { stoppedWaits: true }],
    ]);
    expect(toasts[0]).toBe('Queuing 2 rebuilds… 1 not running: marked for a rebuild when it next starts.');
    expect(toasts.at(-1)).toMatch(/^Rebuilding 2 agents, 6 at a time — about 1 minute\. 1 not running: it is rebuilt when it next starts\. Memory is kept\.$/);
  });
  it('only stopped ones: no "Rebuilding 0"; none behind: nothing to do', async () => {
    const { c, toasts } = page(['rebuildAll', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], { agents: [{ ...behind }], api: async () => ({ rebuilding: false, atNextStart: true }) });
    await c.rebuildAll();
    expect(toasts).toEqual(['1 not running: marked for a rebuild when it next starts.', '1 not running: it is rebuilt when it next starts. Memory is kept.']);
    const none = page(['rebuildAll', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], { agents: [{ ...current }] });
    await none.c.rebuildAll();
    expect([none.calls, none.toasts]).toEqual([[], ['Nothing to rebuild right now.']]);
  });
  it("a rebuild would change it by the server's own answer (rebuild), not by updateAvailable alone", async () => {
    const { c, calls, toasts } = page(['rebuildAll', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], { agents: [{ ...current, updateAvailable: true }] });
    await c.rebuildAll();
    expect([calls, toasts]).toEqual([[], ['Nothing to rebuild right now.']]);
    expect(c.rebuildChangesIt({ ...current, rebuild: { level: 'required', reasons: ['a made-up reason'] } })).toBe(true);
  });
  it('marked by the page\'s own needs-rebuild rule: peers waiting, or a model waiting, as the Needs rebuild chip counts', async () => {
    for (const waiting of [{ peersPending: true }, { pendingModel: 'claude-opus-5', model: 'claude-sonnet-5' }]) {
      const { c, calls } = page(['rebuildAll', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], { agents: [{ ...current, ...waiting }], api: async (url: string, init: Init) => { calls.push({ url, ...init }); return { rebuilding: false, atNextStart: true }; } });
      await c.rebuildAll();
      expect(calls.map((x) => [x.url, x.body])).toEqual([['/v1/agents/a4/rebuild', { stoppedWaits: true }]]);
    }
    // A model the same as the one it runs, or one being re-checked: none.
    const { c } = page(['rebuildChangesIt', 'isRechecking']);
    expect([c.rebuildChangesIt({ ...current, pendingModel: 'm', model: 'm' }), c.rebuildChangesIt({ ...current, peersPending: true, busy: true })]).toEqual([false, false]);
  });
  it('Rebuild all: busy (409) is skipped; any other failure is counted as failed, named, with its reason', async () => {
    const { c, toasts } = page(['rebuildAll', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], { agents: fleet() });
    const refused = (status: number, message: string) => Object.assign(new Error(message), { status });
    c.api = async (url: string) => {
      if (url.includes('/a1/')) throw refused(500, 'The machine did not answer.');
      if (url.includes('/a2/')) throw refused(409, 'Another operation is already running on this agent.');
      return { rebuilding: false, atNextStart: true };
    };
    await c.rebuildAll();
    expect(toasts.at(-1)).toBe('1 not running: it is rebuilt when it next starts. 1 skipped (busy or already changing). 1 failed — Homework Helper: The machine did not answer. Memory is kept.');
    // Many failures: the first three by name, and how many more.
    const many = page(['rebuildAll', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], {
      agents: ['a1', 'a2', 'a5', 'a6'].map((id, i) => ({ id, name: ['Homework Helper', 'Soccer Schedule', 'Meal Planner', 'Book Club'][i], state: 'RUNNING', runtimeRef: 'docker://' + id })),
      api: async () => { throw new Error('Failed to fetch'); },
    });
    await many.c.rebuildAll();
    expect(many.toasts.at(-1)).toBe('4 failed — Homework Helper: Failed to fetch; Soccer Schedule: Failed to fetch; Meal Planner: Failed to fetch; and 1 more. Memory is kept.');
  });
  it('Bulk Rebuild goes the same way: the stopped one behind is marked, not skipped; the current one is skipped', async () => {
    const agents = fleet();
    const { c, calls, $ } = page(['faApply', 'faResultLine', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], { agents, faSelected: () => [agents[0], agents[2], agents[3]].map((a) => ({ dataset: { id: a!.id } })), renderClassList() {} });
    c.api = answer(calls);
    $('faAction').value = 'rebuild';
    await c.faApply();
    expect(calls.map((x) => x.url)).toEqual(['/v1/agents/a1/rebuild', '/v1/agents/a3/rebuild']);
    expect($('faResults').innerHTML).toBe('✓ 1 done · 1 skipped (not applicable) · 1 not running: rebuilt when it next starts.');
  });
  it('Bulk Rebuild counts a 409 (busy, or already changing) as skipped, as Rebuild all does (rebuildOrMark says busy); any other error failed, named the same way', async () => {
    const agents = [{ ...AGENTS[0]! }, { ...AGENTS[1]! }, { ...AGENTS[0]!, id: 'a5', name: 'Reading Log' }];
    const { c, $ } = page(['faApply', 'faResultLine', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], { agents, faSelected: () => agents.map((a) => ({ dataset: { id: a.id } })), renderClassList() {} });
    c.api = async (url: string) => {
      if (url === '/v1/agents/a1/rebuild') throw Object.assign(new Error('It is already being rebuilt.'), { status: 409 });
      if (url === '/v1/agents/a2/rebuild') throw new Error('Failed to fetch');
      return { rebuilding: true };
    };
    $('faAction').value = 'rebuild';
    await c.faApply();
    expect($('faResults').innerHTML).toBe('✓ 1 done · 1 skipped (busy or already changing) · <span style="color:var(--bad)">1 failed</span>.');
    expect($('faErr').textContent).toBe('Soccer Schedule: Failed to fetch');
  });
  it('Bulk Rebuild skips one never built or moved to another machine, as Rebuild all does: nothing sent, skipped, not failed', async () => {
    const agents = [{ ...AGENTS[0]!, runtimeRef: undefined }, { ...AGENTS[1]!, migratedTo: 'h2' }, { ...behind, runtimeRef: undefined }, { ...AGENTS[0]!, id: 'a5', name: 'Reading Log' }];
    const { c, calls, $ } = page(['faApply', 'faResultLine', 'rebuildPlan', 'rebuildOrMark', 'rebuildChangesIt', 'isRechecking', 'reasonFor', 'reasonsSaid'], { agents, faSelected: () => agents.map((a) => ({ dataset: { id: a.id } })), renderClassList() {} });
    c.api = answer(calls);
    $('faAction').value = 'rebuild';
    await c.faApply();
    expect(calls.map((x) => x.url)).toEqual(['/v1/agents/a5/rebuild']);
    expect($('faResults').innerHTML).toBe('✓ 1 done · 3 skipped (not applicable).');
  });
});

describe('Bulk Connect says which sleeping agents take it at their next Start or Rebuild', () => {
  it("the answer's note follows what was done", async () => {
    const { c, $ } = page(['faApply', 'faResultLine', 'reasonFor', 'reasonsSaid'], { faSelected: () => AGENTS.map((a) => ({ dataset: { id: a.id } })), renderClassList() {} });
    const note = 'Garden Planner is asleep. A sleeping agent wakes for a message as it was; it takes this change at its next Start or Rebuild, and its card says its peers changed.';
    c.api = async () => ({ connected: true, agents: 3, changed: 3, grants: 6, needRebuild: [], skipped: [], note });
    $('faAction').value = 'peers-connect';
    await c.faApply();
    expect($('faResults').innerHTML).toBe(`✓ 3 agents can now consult each other (6 grants). ${note}`);
  });
});

describe('the Telegram tab: people who use another agent, and a search test, are the agent they were read for', () => {
  it("A's list, answered after B's forms opened, is not drawn; Add adds to the agent the list was drawn for", async () => {
    const listed = gate();
    const { c, $, calls } = page(['renderKnownPeople', 'addKnownPerson'], { api: () => listed.p, renderEditMembers: async () => {} });
    const pending = c.renderKnownPeople();
    c.editAgentId = 'a2';
    listed.open([{ userId: 'u-made-up', name: 'Sam' }]); await pending;
    expect($('tgKnownPeople').innerHTML).toBe('');
    c.editAgentId = 'a1';
    c.api = async (url: string, init?: Init) => { calls.push({ url, ...init }); return init ? {} : [{ userId: 'u-made-up', name: 'Sam' }]; };
    await c.renderKnownPeople();
    expect($('tgKnownPeople').innerHTML).toContain(`addKnownPerson('a1','u-made-up','Sam')`);
    c.editAgentId = 'a2'; // B's forms opened; the Add drawn for A is pressed
    await c.addKnownPerson('a1', 'u-made-up', 'Sam');
    expect(calls.at(-1)).toEqual({ url: '/v1/agents/a1/members/known', method: 'POST', body: { userId: 'u-made-up' } });
  });
  it("A's search test, answered after B's forms opened: not under B's button, said with A's name", async () => {
    const tested = gate();
    const { c, $, toasts, calls } = page(['testAgentSearch'], { api: (url: string, init: Init) => { calls.push({ url, ...init }); return tested.p; } });
    const pending = c.testAgentSearch();
    // B's forms: renderEnvList empties the line, and prepareEdit sets the button for B's own test (none running).
    c.editAgentId = 'a2'; $('agentSearchTestOut').textContent = ''; $('agentSearchTestBtn').disabled = c.searchTests.has('a2');
    tested.open({ ok: true, detail: 'Search works: DuckDuckGo answered.' }); await pending;
    expect(calls.map((x) => x.url)).toEqual(['/v1/agents/a1/search-test']);
    expect($('agentSearchTestOut').textContent).toBe('');
    expect(toasts).toEqual(['Homework Helper: ✓ Search works: DuckDuckGo answered.']);
    expect([$('agentSearchTestBtn').disabled, c.searchTests.size]).toEqual([false, 0]);
  });
  it("A's search test ending while B's runs leaves B's button waiting; B's own end frees it", async () => {
    const forA = gate(), forB = gate();
    const { c, $ } = page(['testAgentSearch'], { api: (url: string) => (url.includes('/a1/') ? forA.p : forB.p) });
    const a = c.testAgentSearch();
    c.editAgentId = 'a2'; $('agentSearchTestBtn').disabled = c.searchTests.has('a2');
    const b = c.testAgentSearch();
    forA.open({ ok: true, detail: 'Search works.' }); await a;
    expect($('agentSearchTestBtn').disabled).toBe(true);
    forB.open({ ok: true, detail: 'Search works.' }); await b;
    expect($('agentSearchTestBtn').disabled).toBe(false);
  });
});

describe('the AI sources: the poll reads the Costs charts again (HB-0474)', () => {
  /** Charts under the source rows, each in its drawer (open or folded) at a height on the page. */
  const sources = (charts: Array<{ open: boolean; top: number }>) => {
    const read: number[] = [];
    const els = charts.map((x, i) => ({ i, open: x.open, getBoundingClientRect: () => ({ top: x.top, bottom: x.top + 200, height: 200 }) }));
    const aiList = Object.assign(element('aiList'), {
      querySelectorAll: (sel: string) => sel.includes('[open]') ? els.filter((x) => x.open) : els,
    });
    const p = page(['loadSourceUsage'], {
      profiles: [{ id: 'p1' }], sourceUsagePanel: () => '', innerHeight: 800,
      loadSpendChart: async (el: { i: number }, reread: boolean) => { if (reread) read.push(el.i); },
      api: async () => ({ sources: [] }), aiDlg: { open: true, getBoundingClientRect: () => ({ top: 50, bottom: 750 }) }, aiChartsAt: 0,
    });
    p.c.$ = (id: string) => id === 'aiList' ? aiList : element(id);
    return { ...p, read, aiList };
  };
  it('only charts in an open drawer and on screen, at most once a minute', async () => {
    // Open and in view; folded after it was opened; open but scrolled out of the dialog.
    const s = sources([{ open: true, top: 100 }, { open: false, top: 320 }, { open: true, top: 900 }]);
    await s.c.loadSourceUsage();
    expect(s.read).toEqual([0]);
    await s.c.loadSourceUsage();
    expect(s.read).toEqual([0]); // within the minute
    s.c.aiChartsAt = Date.now() - 61_000;
    await s.c.loadSourceUsage();
    expect(s.read).toEqual([0, 0]);
  });
  it('not with Settings closed, nor on another of its tabs', async () => {
    const s = sources([{ open: true, top: 100 }]);
    s.c.aiDlg.open = false;
    await s.c.loadSourceUsage();
    s.c.aiDlg.open = true; s.aiList.closest = (sel: string) => sel === '[hidden]' ? {} : null;
    await s.c.loadSourceUsage();
    expect(s.read).toEqual([]);
  });
  it('a read again that fails keeps the chart drawn, with a note; a first read that fails says why', async () => {
    const chart = () => {
      let inner = '<svg>the week</svg>';
      return {
        dataset: { source: 'p1' } as Record<string, string>, isConnected: true,
        get innerHTML() { return inner; }, set innerHTML(v: string) { inner = v; },
        querySelector: (sel: string) => sel === 'svg' ? (inner.includes('<svg') ? {} : null)
          : sel === '.spendstale' && inner.includes('spendstale') ? { remove: () => { inner = inner.replace(/<div class="sub spendstale">.*?<\/div>/, ''); } } : null,
        insertAdjacentHTML: (_where: string, html: string) => { inner += html; },
      };
    };
    const { c } = page(['loadSpendChart'], {
      spendRange: 'week', spendAgents: [], spendChartSeq: 0, spendChartHTML: () => '<svg>new</svg>',
      // A first read that fails lets its chart go (unwatched), as the phone's fitted charts do.
      spendChartFit: null, spendChartsSeen: new Set(),
      api: async () => { throw new Error('The usage could not be read.'); },
    });
    const drawn = chart();
    await c.loadSpendChart(drawn, true);
    await c.loadSpendChart(drawn, true);
    expect(drawn.innerHTML).toBe('<svg>the week</svg><div class="sub spendstale">Not read again just now: The usage could not be read.</div>');
    const first = chart();
    await c.loadSpendChart(first);
    expect(first.innerHTML).toBe('<div class="sub">The usage could not be read.</div>');
  });
});

describe('the sheet: only an unsaved edit holds back the redraw after Start or Stop (HB-0475)', () => {
  type Ctl = { id: string; type: string; value: string; checked: boolean; multiple: boolean; isConnected: boolean; matches(): boolean; closest(): null; hasAttribute(name: string): boolean };
  const ctl = (id: string, value: string, attrs: string[] = []): Ctl => ({ id, type: 'text', value, checked: false, multiple: false, isConnected: true, matches: () => true, closest: () => null, hasAttribute: (name: string) => attrs.includes(name) });
  const sheet = () => {
    let redraws = 0;
    const pane = Object.assign(element('v2Pane'), { contains: (_el: unknown): boolean => false, scrollTop: 0, querySelector: () => null });
    const ctls: Record<string, Ctl> = { editName: ctl('editName', 'Soccer Schedule'), editDesc: ctl('editDesc', 'Helps with soccer.'), pathNew: ctl('pathNew', '') };
    const cronBody = element('cronBody');
    const p = page(['v2RefreshSheet', 'v2SheetUnsaved', 'v2SheetSaving', 'v2SheetBaseline'], {
      v2AgentDlg: { open: true }, v2AgentId: 'a2', editAgentId: 'a2', v2Tab: 'personality', v2SheetDrawnState: 'RUNNING', v2SheetSig: '', v2EditFor: 'a2',
      v2Find: () => ({ id: 'a2', state: 'STOPPED' }), v2Mine: () => true, v2SheetSigOf: () => '',
      V2_EMBED: { personality: [] }, V2_SELF_LOADING: {}, v2RenderSheet: () => { redraws++; }, v2RenderSheetBar() {},
      document: { activeElement: null }, v2SheetNotes: new Map(), v2SheetFills: new WeakMap(), cronEditingId: null, editParams: [], editParamsSaved: '[]',
    }, ['V2_CONTROLS', 'v2CtlValue', 'v2SheetEdits', 'v2SheetControlsOf', 'v2SheetCounts']);
    p.c.$ = (id: string) => id === 'v2Pane' ? pane : id === 'cronBody' ? cronBody : ctls[id] ?? element(id);
    p.c.v2SheetBaseline('editName', 'editDesc', 'pathNew'); // as prepareEdit fills them
    const type = (id: string, value: string) => { ctls[id]!.value = value; };
    return { ...p, ctls, type, pane, cronBody, redraws: () => redraws };
  };
  it('a change not saved holds it; saved for this agent, it does not', async () => {
    const s = sheet();
    s.type('editDesc', 'Helps with soccer, made up.');
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(0);
    const saved = s.c.v2SheetSaving('editDesc');
    saved('a2');
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(1);
  });
  it('a save answered after its control was filled again (the sheet closed and opened, or another agent and back) notes nothing over the fill', () => {
    const s = sheet();
    s.type('editName', 'Soccer Schedule, renamed');
    const saved = s.c.v2SheetSaving('editName');
    s.type('editName', 'Soccer Schedule'); s.c.v2SheetBaseline('editName'); // the page filled it again, from the list read before the save
    saved('a2');
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(1); // the box shows what was filled: nothing unsaved, so the sheet is drawn again
  });
  it("a slow save for another agent leaves this one's edit unsaved (a rename of A, B's name typed)", () => {
    const s = sheet();
    s.type('editName', 'Soccer Schedule, typed');
    s.c.v2SheetSaving('editName')('a1'); // A's rename answers while B's sheet is open
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(0);
  });
  it('a box its save emptied, a control another tab drew over: nothing unsaved', () => {
    const s = sheet();
    s.type('pathNew', '/srv/made-up'); s.ctls.pathNew!.value = ''; // Add took it
    s.type('editDesc', 'Gone with its tab'); s.ctls.editDesc!.isConnected = false;
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(1);
  });
  it('an edit made by a press holds it: a task armed by Edit, a setup field added or removed', () => {
    const s = sheet();
    s.c.cronEditingId = 'job1'; s.pane.contains = (el: unknown) => el === s.cronBody; // the task form in the sheet
    s.c.v2RefreshSheet();
    s.c.cronEditingId = null; s.c.editParams = [{ key: 'city' }];
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(0);
    s.c.editParamsSaved = JSON.stringify(s.c.editParams); // Save fields
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(1);
  });
  it('one rule for what is noted and what counts (v2SheetEdits): a control whose change saves it (data-saves) is neither', () => {
    const s = sheet();
    const saver = ctl('v2Browser', 'on', ['data-saves']); // Browser: its change saves it
    s.ctls.v2Browser = saver;
    s.c.v2SheetBaseline('v2Browser');
    expect([s.c.v2SheetNotes.has(saver), s.c.v2SheetCounts(saver)]).toEqual([false, false]);
    expect([s.c.v2SheetNotes.has(s.ctls.editName), s.c.v2SheetCounts(s.ctls.editName)]).toEqual([true, true]);
  });
  it('a control code fills again (a model menu drawn for a class, a row refilled) is noted as filled: no edit', () => {
    const s = sheet();
    s.ctls.editName!.value = 'Soccer Schedule, drawn again'; // as a fill helper sets it
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(0); // filled with no note of it: read as an edit…
    s.c.v2SheetBaseline('editName'); // …which is why every fill helper notes what it fills
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(1);
  });
  it("one left from before (the task form not in the sheet, the fields filled for another agent) holds nothing", () => {
    const s = sheet();
    s.c.cronEditingId = 'job1'; // armed, then the sheet closed; reopened on a stopped agent's Schedule tab
    s.c.editParams = [{ key: 'city' }]; s.c.v2EditFor = null;
    s.c.v2RefreshSheet();
    expect(s.redraws()).toBe(1);
  });
});

describe('a file that would not load: the file chosen is noted with its empty editor (HB-0475)', () => {
  it('the failure baselines the file picker as well as the editor', async () => {
    const noted: string[][] = [];
    const { c, $ } = page(['loadEditFile'], {
      editLoaded: null, editLoadGen: 0, editReverting: new Set(), EDIT_REVERTING: 'Reverting…',
      v2SheetBaseline: (...ids: string[]) => noted.push(ids), api: async () => { throw new Error('MEMORY.md is over the size limit.'); },
    });
    $('editFile').value = 'MEMORY.md';
    await c.loadEditFile();
    expect(noted.at(-1)).toEqual(['editFile', 'editContent']);
    expect($('editErr').textContent).toMatch(/nothing to save/);
  });
});

describe('web chat: only what was said after the log was read is counted (HB-0495)', () => {
  // Each send keeps the read it followed: the log's newest time then (`after`), and the same
  // words in it (`logged`, with no time: `untimed`). Reopened, the log is the last 100 messages:
  // what came after that time is counted against the sends that followed the read.
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 8, 9, minute)).toISOString();
  const said = (n: number, from: number) => Array.from({ length: n }, (_, i) => [
    { role: 'user', text: 'ok', at: at(from + i) }, { role: 'assistant', text: 'Noted.', at: at(from + i) }]).flat();
  /** n sends of "ok" after one read; `unsure` those with no answer. */
  const sends = (n: number, read: Record<string, unknown>, unsure = false, open = 0) =>
    Array.from({ length: n }, () => ({ text: 'ok', logged: 10, untimed: 0, ...read, open, unsure }));
  const READ = { after: at(9) }; // read at 9:09, with ten "ok" in it
  const chat = (sent: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
    const offered: string[] = [];
    const p = page(['webChatOfferUnsure', 'webChatAnswered'], { webChatUnsure: new Map([['a1', sent]]), webChatOpens: 1, serverAheadMs: null, webChatGiveBack: (_id: string, text: string) => offered.push(text), ...extra }, ['webChatKey', 'WEBCHAT_CLOCKS_MS', 'WEBCHAT_DATE_MS', 'webChatSameWords']);
    return { ...p, offered };
  };
  it('the same words said before the read do not stand in for a message that never arrived', () => {
    // 39 "ok" sent and answered since, then one more that did not arrive.
    const { c, offered, $ } = chat([...sends(39, READ), ...sends(1, READ, true)]);
    c.webChatOfferUnsure('a1', { messages: [...said(10, 0), ...said(39, 10)] });
    expect(offered).toEqual(['ok']);
    expect($('wchatErr').textContent).toMatch(/may not have been delivered/);
  });
  it('one that arrived is there after the read, though older ones were cut from the log: not offered', () => {
    const { c, offered } = chat([...sends(39, READ), ...sends(1, READ, true)]);
    c.webChatOfferUnsure('a1', { messages: [...said(10, 0), ...said(40, 10)] });
    expect(offered).toEqual([]);
  });
  it('one answered after it is not taken for it', () => {
    const { c, offered } = chat([...sends(1, READ, true), ...sends(1, READ)]);
    c.webChatOfferUnsure('a1', { messages: [...said(10, 0), ...said(1, 10)] });
    expect(offered).toEqual(['ok']);
  });
  it('one sent while the log loaded is not counted against it (its copy was in that log)', () => {
    // "ok" sent while the log loaded, then "ok" again with a 504. The first is in the log as read.
    const loading = { after: undefined, logged: 0, untimed: 0 };
    const read = { after: at(10), logged: 11 }; // the log as read: eleven "ok", the last at 9:10
    const arrived = chat([...sends(1, loading), ...sends(1, read, true)]);
    arrived.c.webChatOfferUnsure('a1', { messages: [...said(11, 0), ...said(1, 11)] });
    expect(arrived.offered).toEqual([]);
    const lost = chat([...sends(1, loading), ...sends(1, read, true)]);
    lost.c.webChatOfferUnsure('a1', { messages: said(11, 0) });
    expect(lost.offered).toEqual(['ok']);
  });
  it('what was sent while this log loaded is kept, for the next read', () => {
    const { c, offered } = chat([...sends(1, READ, true), ...sends(1, { after: undefined, logged: 0 }, true, 1)]);
    c.webChatOfferUnsure('a1', { messages: [...said(10, 0), ...said(1, 10)] });
    expect(offered).toEqual([]);
    expect(c.webChatUnsure.get('a1')).toEqual(sends(1, { after: undefined, logged: 0 }, true, 1));
  });
  it('one the log gives no time: counted by its words, against those with no time when it was read', () => {
    // Read with one "ok" that had no time; the new one, delivered, has none either.
    const untimed = { role: 'user', text: 'ok' };
    const withOne = { ...READ, logged: 11, untimed: 1 };
    const arrived = chat(sends(1, withOne, true));
    arrived.c.webChatOfferUnsure('a1', { messages: [untimed, ...said(10, 0), untimed] });
    expect(arrived.offered).toEqual([]);
    const lost = chat(sends(1, withOne, true));
    lost.c.webChatOfferUnsure('a1', { messages: [untimed, ...said(10, 0)] });
    expect(lost.offered).toEqual(['ok']);
    // An earlier "ok" sent since the read, answered and in the log with no time, is that one, not this.
    const earlier = chat([...sends(1, READ), ...sends(1, READ, true)]);
    earlier.c.webChatOfferUnsure('a1', { messages: [...said(10, 0), untimed] });
    expect(earlier.offered).toEqual(['ok']);
  });
  it('one still waiting at a reopen is kept, with those sent after the same read; failing later, it is offered', () => {
    // "ok" answered, then "ok" again still waiting; the chat closed and reopened.
    const answered = { ...sends(1, READ)[0]!, waiting: false }, waiting = { ...sends(1, READ)[0]!, waiting: true };
    const { c, offered } = chat([answered, waiting]);
    const reread = { messages: [...said(10, 0), ...said(1, 10)] }; // the first one's copy came after the read
    c.webChatOfferUnsure('a1', reread);
    expect(offered).toEqual([]);
    expect(c.webChatUnsure.get('a1')).toEqual([answered, waiting]);
    // Its answer: a 504. The next reopen counts it with the first: one copy for two sends.
    Object.assign(waiting, { waiting: false, unsure: true }); c.webChatOpens = 2;
    c.webChatOfferUnsure('a1', reread);
    expect(offered).toEqual(['ok']);
    expect(c.webChatUnsure.has('a1')).toBe(false);
  });
  it('answered with nothing in doubt, its group goes; kept while one of it may not have arrived, still waits, or is from an earlier open', () => {
    const now = (o: Record<string, unknown> = {}) => ({ ...sends(1, READ, false, 1)[0]!, waiting: false, ...o });
    const settled = now(), other = now({ after: at(20) });
    const { c } = chat([settled, other]);
    c.webChatAnswered('a1', settled);
    expect(c.webChatUnsure.get('a1')).toEqual([other]);
    c.webChatAnswered('a1', other);
    expect(c.webChatUnsure.has('a1')).toBe(false);
    for (const before of [now({ unsure: true }), now({ waiting: true }), now({ open: 0 })]) {
      const answered = now(), kept = chat([before, answered]);
      kept.c.webChatAnswered('a1', answered);
      expect(kept.c.webChatUnsure.get('a1')).toEqual([before, answered]);
    }
    // Answered after the chat was opened again: kept, for that open's read (its bubble is not on this log).
    const late = now({ open: 0 }), reopened = chat([late]);
    reopened.c.webChatAnswered('a1', late);
    expect(reopened.c.webChatUnsure.get('a1')).toEqual([late]);
  });
  it('those answered before it, whose records went, still count against the read (before)', () => {
    // Two "ok" answered (their records gone), then a third with a 504: the log has two after the read.
    const lost = chat(sends(1, { ...READ, before: 2 }, true));
    lost.c.webChatOfferUnsure('a1', { messages: [...said(10, 0), ...said(2, 10)] });
    expect(lost.offered).toEqual(['ok']);
    const arrived = chat(sends(1, { ...READ, before: 2 }, true));
    arrived.c.webChatOfferUnsure('a1', { messages: [...said(10, 0), ...said(3, 10)] });
    expect(arrived.offered).toEqual([]);
  });
  it('a log that could not be read (a note): what may not have arrived waits, with its group; a group with nothing in doubt goes', () => {
    const doubt = [...sends(1, READ), ...sends(1, READ, true)], settled = sends(1, { after: at(20) });
    const { c, offered } = chat([...doubt, ...settled]);
    c.webChatOfferUnsure('a1', { messages: [], note: 'Its conversation cannot be read right now.' });
    expect([offered, c.webChatUnsure.get('a1')]).toEqual([[], doubt]);
    const none = chat(settled);
    none.c.webChatOfferUnsure('a1', { messages: [], note: 'Its conversation cannot be read right now.' });
    expect(none.c.webChatUnsure.has('a1')).toBe(false);
  });
  it('sent after a read that failed: only a copy timed from when it was sent counts; older ones, or none with a time, bring it back', () => {
    // No read before it: the moment it was sent, by this browser's clock (sentAt). Three "ok" from 9:00 to 9:02 in the log.
    const unread = { after: undefined, logged: 0, untimed: 0, sentAt: at(30) };
    const older = chat(sends(1, unread, true));
    older.c.webChatOfferUnsure('a1', { messages: said(3, 0) });
    expect(older.offered).toEqual(['ok']);
    const arrived = chat(sends(1, unread, true));
    arrived.c.webChatOfferUnsure('a1', { messages: [...said(3, 0), { role: 'user', text: 'ok', at: new Date(Date.parse(at(30)) - 2000).toISOString() }] });
    expect(arrived.offered).toEqual([]); // the clocks a little apart
    const untimed = chat(sends(1, unread, true));
    untimed.c.webChatOfferUnsure('a1', { messages: said(3, 0).map(({ role, text }) => ({ role, text })) });
    expect(untimed.offered).toEqual(['ok']);
    // An earlier one of the same, answered, stays with it (not dropped): two sent, one copy after the first.
    const answered = { ...sends(1, { ...unread, sentAt: at(31) })[0]!, waiting: false };
    const two = chat([...sends(1, unread, true), answered]);
    two.c.webChatOfferUnsure('a1', { messages: [...said(3, 0), { role: 'user', text: 'ok', at: at(31) }] });
    expect(two.offered).toEqual(['ok']);
    const now = { ...answered, open: 1 }, kept = chat([now]); // answered in this open, its read failed: not dropped
    kept.c.webChatAnswered('a1', now);
    expect(kept.c.webChatUnsure.get('a1')).toEqual([now]);
  });
  it("sent with no read, this browser's clock 20 s fast: compared in the server's time (an answer's Date header), its copy counts", () => {
    const unread = { after: undefined, logged: 0, untimed: 0, sentAt: at(30) }; // by this browser's clock
    const server = (ms: number) => new Date(Date.parse(at(30)) - 20000 + ms).toISOString(); // the server's, 20 s behind
    const fast = chat(sends(1, unread, true), { serverAheadMs: -20000 });
    fast.c.webChatOfferUnsure('a1', { messages: [...said(3, 0), { role: 'user', text: 'ok', at: server(500) }] });
    expect(fast.offered).toEqual([]);
    // Older than the send in the server's time, by more than the header's whole seconds allow: it comes back.
    const older = chat(sends(1, unread, true), { serverAheadMs: -20000 });
    older.c.webChatOfferUnsure('a1', { messages: [...said(3, 0), { role: 'user', text: 'ok', at: server(-3000) }] });
    expect(older.offered).toEqual(['ok']);
    // No Date header seen yet: today's rule, five seconds by this browser's clock.
    const blind = chat(sends(1, unread, true));
    blind.c.webChatOfferUnsure('a1', { messages: [...said(3, 0), { role: 'user', text: 'ok', at: server(500) }] });
    expect(blind.offered).toEqual(['ok']);
  });
  it("api() notes the server's clock from a quick answer's Date header, as its headers come; a slow answer, or one without the header, leaves it", async () => {
    const src = /^const api = async \(path, opts = \{\}\) => \{\n[\s\S]*?^\};$/m.exec(js)![0].replace(/^const /, 'var ');
    // This browser's clock, moved on by the trip and by the body's download; the server's 20 s behind it (whole seconds).
    let clock = Date.UTC(2026, 10, 8, 9, 0, 0);
    const answer = (trip: number, body: number, behind: number | null = 20000) => async () => {
      clock += trip;
      const date = behind === null ? null : new Date(clock - behind).toUTCString();
      return { status: 200, ok: true, headers: { get: (k: string) => (k === 'date' ? date : null) }, json: async () => { clock += body; return {}; } };
    };
    const ctx = vm.createContext({ serverAheadMs: null, SERVER_CLOCK_TRIP_MS: 1000, Date: { now: () => clock, parse: Date.parse }, fetch: answer(200, 2500) });
    vm.runInContext(src, ctx);
    await ctx.api('/v1/agents'); // a 2.5 s download on a slow link: not the server's
    expect(ctx.serverAheadMs).toBeGreaterThan(-21000);
    expect(ctx.serverAheadMs).toBeLessThanOrEqual(-20000);
    const known = ctx.serverAheadMs;
    ctx.fetch = answer(1500, 0, 5000); // back after 1.5 s (a chat turn): not taken
    await ctx.api('/v1/agents/a1/chat');
    expect(ctx.serverAheadMs).toBe(known);
    ctx.fetch = answer(100, 0, null); // no Date header: left
    await ctx.api('/v1/agents');
    expect(ctx.serverAheadMs).toBe(known);
    ctx.fetch = answer(100, 0, 5000); // a quick one: taken
    await ctx.api('/v1/agents');
    expect(ctx.serverAheadMs).toBeGreaterThan(-6000);
    expect(ctx.serverAheadMs).toBeLessThanOrEqual(-5000);
  });
  it('the send and the next open compare words the same way: a trailing space in the log as read (webChatSameWords)', async () => {
    // The log as read holds "ok " (a trailing space) at 9:05. The send counts it as already there, as the next open does.
    const log = [{ textContent: 'ok ', dataset: { at: at(5) } }];
    const { c, $ } = page(['webChatSend'], {
      webChatAgentId: 'a1', webChatDrafts: new Map(), webChatUnsure: new Map(), webChatSending: new Set(), pagePersonAway: false,
      webChatOpens: 1, webChatReadOpen: 1, webChatUnread: false, v2Find: () => ({ name: 'Homework Helper' }),
      webChatWait: () => null, webChatGiveBack() {}, webChatAnswered() {},
      api: async () => { throw Object.assign(new Error('No answer within 280 s.'), { status: 504 }); },
    }, ['webChatCanSend', 'webChatSameWords', 'webChatBubble', 'webChatScroll']);
    Object.assign($('wchatLog'), {
      querySelectorAll: (sel: string) => (sel === '.wchat-msg[data-at]' || sel === '.wchat-msg.me[data-log]' ? log : []),
      insertAdjacentHTML() {}, lastElementChild: { dataset: {}, remove() {} }, scrollTop: 0, scrollHeight: 0,
    });
    Object.assign($('wchatEmpty'), { remove() {} });
    $('wchatText').value = 'ok';
    await c.webChatSend();
    expect(c.webChatUnsure.get('a1').map((s: Record<string, unknown>) => [s.logged, s.after, s.unsure])).toEqual([[1, at(5), true]]);
    expect([c.webChatSameWords('ok ', 'ok'), c.webChatSameWords(' ok', 'ok\n'), c.webChatSameWords('ok', 'okay')]).toEqual([true, true, false]);
  });
  it('"ok" sent while the log loaded and answered, then "ok" after the read with a 504: counted together by time, not twice', async () => {
    // The first's copy is in the read (9:10), and its bubble is answered: counted against the read, it was counted in both.
    const early = { text: 'ok', after: undefined, logged: 0, untimed: 0, before: 0, open: 1, unsure: false, waiting: false, sentAt: at(10) };
    const unsure = new Map([['a1', [early]]]);
    const log = [{ textContent: 'ok', dataset: { at: at(10) } }], answeredBubbles = [{ textContent: 'ok', dataset: {} }];
    const { c, $ } = page(['webChatSend'], {
      webChatAgentId: 'a1', webChatDrafts: new Map(), webChatUnsure: unsure, webChatSending: new Set(), pagePersonAway: false,
      webChatOpens: 1, webChatReadOpen: 1, webChatUnread: false, v2Find: () => ({ name: 'Homework Helper' }),
      webChatWait: () => null, webChatGiveBack() {}, webChatAnswered() {},
      api: async () => { throw Object.assign(new Error('No answer within 280 s.'), { status: 504 }); },
    }, ['webChatCanSend', 'webChatSameWords', 'webChatBubble', 'webChatScroll', 'webChatKey']);
    Object.assign($('wchatLog'), {
      querySelectorAll: (sel: string) => (sel === '.wchat-msg[data-at]' || sel === '.wchat-msg.me[data-log]' ? log : sel === '.wchat-msg.me[data-answered]' ? answeredBubbles : []),
      insertAdjacentHTML() {}, lastElementChild: { dataset: {}, remove() {} }, scrollTop: 0, scrollHeight: 0,
    });
    Object.assign($('wchatEmpty'), { remove() {} });
    $('wchatText').value = 'ok';
    await c.webChatSend();
    const second = unsure.get('a1')![1]!;
    expect([second.before, !!second.sentAt, c.webChatKey(second) === c.webChatKey(early)]).toEqual([0, true, true]);
    // The next open: the second arrived (9:11): nothing comes back. It did not: it does.
    const copy = (m: number) => ({ role: 'user', text: 'ok', at: at(m) });
    const arrived = chat([...unsure.get('a1')!], { webChatOpens: 2 });
    arrived.c.webChatOfferUnsure('a1', { messages: [...said(9, 0), copy(10), copy(11)] });
    expect(arrived.offered).toEqual([]);
    const lost = chat([...unsure.get('a1')!], { webChatOpens: 2 });
    lost.c.webChatOfferUnsure('a1', { messages: [...said(9, 0), copy(10)] });
    expect(lost.offered).toEqual(['ok']);
  });
  it('a log with no times (an older one): counted whole, as before', () => {
    const { c, offered } = chat(sends(1, { after: undefined, logged: 2 }, true));
    c.webChatOfferUnsure('a1', { messages: said(3, 0).map(({ role, text }) => ({ role, text })) });
    expect(offered).toEqual([]);
  });
});

