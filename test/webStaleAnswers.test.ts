/**
 * The web page's own functions (web/index.html as shipped) run against a small
 * made-up DOM and an api() whose answers come back in the order a test says.
 * An answer for what was open before lands nowhere; one press acts on what was
 * open when it was pressed; a setup form sends what it shows (deep audit of
 * v2.166.2, #047–#050 and #062–#067). The click-through
 * (scripts/ui-clickthrough.mjs, its audit… scenarios) drives the same paths in a
 * real browser. Agents and sources are the invented household's.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolveParamValues, type TemplateParam } from '../src/orchestrator/template.js';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const js = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
function source(name: string): string {
  const m = new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^\\}`, 'm').exec(js);
  if (!m) throw new Error(`no function ${name} in web/index.html`);
  return m[0];
}

type El = {
  value: string; textContent: string; innerHTML: string; hidden: boolean; disabled: boolean; checked: boolean; title: string;
  style: Record<string, string>; dataset: Record<string, string>; isConnected: boolean; childElementCount: number;
  focus(): void; querySelectorAll(sel: string): unknown[];
};
function element(): El {
  let inner = '';
  const el: El = {
    value: '', textContent: '', hidden: false, disabled: false, checked: false, title: '', style: {}, dataset: {}, isConnected: true,
    childElementCount: 0, focus() {}, querySelectorAll: () => [],
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
  { id: 'a1', name: 'Homework Helper', aiProfileId: 'p1', profileModels: ['claude-sonnet-5'], profileDefaultModel: 'claude-sonnet-5', state: 'RUNNING', runtimeRef: 'docker://x' },
  { id: 'a2', name: 'Soccer Schedule', aiProfileId: 'p1', profileModels: ['claude-sonnet-5'], profileDefaultModel: 'claude-sonnet-5', state: 'RUNNING', runtimeRef: 'docker://y' },
];
const PROFILES = [
  { id: 'p1', name: 'Anthropic API (household)', vendor: 'anthropic', model: 'claude-sonnet-5' },
  { id: 'p2', name: 'Second source', vendor: 'anthropic', model: 'claude-opus-5-5' },
];

type Init = { method?: string; body?: Record<string, unknown> };
type Call = Init & { url: string };
/** A gate: the request waits until the test opens it. */
function gate<T = unknown>() {
  let open!: (v: T) => void, fail!: (e: Error) => void;
  const p = new Promise<T>((res, rej) => { open = res; fail = rej; });
  return { p, open, fail };
}

/** The named page functions in a context of their own, with `extra` as its globals. */
function page(names: string[], extra: Record<string, unknown> = {}) {
  const nodes = new Map<string, El>();
  const $ = (id: string) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id)!; };
  const calls: Call[] = [];
  const closed: string[] = [];
  const noop = () => {};
  const c = vm.createContext({
    $, console, Intl, encodeURIComponent, Math, Date, Promise, String, JSON,
    agents: AGENTS.map((a) => ({ ...a })), profiles: PROFILES, agentClasses: [], appConfig: { authMode: 'accounts' },
    api: async (url: string, init?: { method?: string; body?: Record<string, unknown> }) => { calls.push({ url, ...init }); return {}; },
    confirm: () => true, prompt: () => '', toast: noop, refresh: async () => {},
    editDlg: { close: () => closed.push('edit') }, inviteDlg: { showModal: noop }, proposalsDlg: { showModal: noop },
    esc: (v: unknown) => String(v ?? ''), jsq: (v: unknown) => String(v ?? ''), ago: () => 'just now',
    sourceOptionLabel: (p: { name: string }) => p.name, localClashWarning: () => '', confirmRebuild: () => true,
    showEditTab: noop, populateImagePicker: async () => {}, embedModeText: () => '', renderSetupValues: noop, renderGroupAccess: noop,
    renderEditMembers: async () => {}, renderParamList: noop, renderDataList: noop, renderEnvList: noop, renderClassList: noop,
    v2ChannelKinds: () => ['telegram'], location: { origin: 'https://hatchabot.example' }, navigator: {}, document: { querySelectorAll: () => [] },
    editAgentId: 'a1', editLoaded: null, editLoadGen: 0, editReverting: new Set(), EDIT_REVERTING: 'Reverting…',
    invWebFor: null, invShare: null, proposalsMasterId: null, proposalsGen: 0,
    spendRange: 'week', spendAgents: [], spendChartSeq: 0, spendChartHTML: (d: unknown) => JSON.stringify(d),
    ...extra,
  });
  for (const n of names) vm.runInContext(source(n), c);
  return { c: c as Record<string, any>, $, calls, closed };
}

describe('the AI tab: one press acts on the agent it was pressed for (audit #047, #050)', () => {
  it("Use this: A's source saved, A rebuilt with A's checkpoint box, though B's sheet opened meanwhile", async () => {
    const { c, $, calls, closed } = page(['switchProfile'], { renderModelPickerForAgent: () => {} });
    $('editProfile').value = 'p2'; $('editCheckpoint').checked = true;
    const saved = gate();
    c.api = async (url: string, init: Init) => { calls.push({ url, ...init }); return init.method === 'PATCH' ? saved.p : {}; };
    const pending = c.switchProfile();
    // A's sheet closed, B's AI tab opened, its box unticked — before A's answer.
    c.editAgentId = 'a2'; $('editCheckpoint').checked = false;
    saved.open({}); await pending;
    expect(calls.map((x) => [x.method, x.url])).toEqual([['PATCH', '/v1/agents/a1'], ['POST', '/v1/agents/a1/rebuild']]);
    expect(calls[1]!.body).toEqual({ checkpoint: true });
    expect(closed).toEqual([]); // B's sheet stays open
  });

  it('the image pin and the peers grant rebuild the agent they saved', async () => {
    const pin = page(['saveImagePin']);
    pin.$('editImage').value = 'hatchabot-runtime:candidate';
    const saved = gate();
    pin.c.api = async (url: string, init: Init) => { pin.calls.push({ url, ...init }); return init.method === 'PATCH' ? saved.p : {}; };
    const p1 = pin.c.saveImagePin(); pin.c.editAgentId = 'a2'; saved.open({}); await p1;
    expect(pin.calls.map((x) => x.url)).toEqual(['/v1/agents/a1', '/v1/agents/a1/rebuild']);

    const peers = page(['savePeers'], { peersLoadedFor: 'a1', document: { querySelectorAll: (sel: string) => sel === '.peerCb:checked' ? [{ dataset: { id: 'a2' } }] : [] } });
    const put = gate();
    peers.c.api = async (url: string, init: Init) => { peers.calls.push({ url, ...init }); return init.method === 'PUT' ? put.p : {}; };
    const p2 = peers.c.savePeers(); peers.c.editAgentId = 'a2'; put.open({}); await p2;
    expect(peers.calls.map((x) => x.url)).toEqual(['/v1/agents/a1/peers', '/v1/agents/a1/rebuild']);
    expect(peers.closed).toEqual([]);
  });

  it("a source picked and not applied leaves the model button usable on the next agent's sheet", () => {
    const { c, $ } = page(['prepareEdit', 'renderModelPicker', 'renderModelPickerForAgent', 'renderModelPickerForProfile', 'onEditProfileChange']);
    c.prepareEdit('a1', 'Homework Helper');
    $('editProfile').value = 'p2'; c.onEditProfileChange();
    expect($('modelBtn').disabled).toBe(true); // A: a source chosen, not applied yet
    c.prepareEdit('a2', 'Soccer Schedule');
    expect($('editProfile').value).toBe('p1');
    expect($('modelBtn').disabled).toBe(false);
    expect($('modelBtn').title).toBe('');
  });
});

describe('Files: a read older than the last one lands nowhere (audit #048)', () => {
  it('SOUL.md, MEMORY.md, SOUL.md again: the first SOUL.md read, late, leaves the edit and Save alone', async () => {
    const { c, $, calls } = page(['loadEditFile', 'saveEditFile']);
    const reads: Array<ReturnType<typeof gate>> = [];
    c.api = (url: string, init?: Init) => {
      if (init) { calls.push({ url, ...init }); return Promise.resolve({}); }
      const g = gate(); reads.push(g); return g.p;
    };
    $('editFile').value = 'SOUL.md'; const first = c.loadEditFile();
    $('editFile').value = 'MEMORY.md'; const memory = c.loadEditFile();
    $('editFile').value = 'SOUL.md'; const again = c.loadEditFile();
    reads[2]!.open({ content: 'current soul' }); await again;
    $('editContent').value = 'current soul, edited';
    reads[0]!.open({ content: 'older soul' }); await first;
    expect($('editContent').value).toBe('current soul, edited');
    expect($('editSaveBtn').disabled).toBe(false);
    reads[1]!.fail(new Error('too big')); await memory;
    expect($('editContent').value).toBe('current soul, edited'); // nor does a late failure empty it
    expect($('editErr').textContent).toBe('');
    await c.saveEditFile();
    expect(calls).toEqual([{ url: '/v1/agents/a1/files/SOUL.md', method: 'PUT', body: { content: 'current soul, edited' } }]);
  });
});

describe('Bulk actions: the class read once, as the model and image are (audit #049)', () => {
  it('a class changed in the menu while Apply works leaves the later agents on the one applied', async () => {
    const { c, $, calls } = page(['faApply'], {
      faSelected: () => [{ dataset: { id: 'a1' } }, { dataset: { id: 'a2' } }],
      agentClasses: [{ id: 'class-school' }, { id: 'class-sport' }],
    });
    $('faAction').value = 'class'; $('faClass').value = 'class-school';
    const first = gate();
    c.api = async (url: string, init: Init) => { calls.push({ url, ...init }); return calls.length === 1 ? first.p : {}; };
    const pending = c.faApply();
    $('faClass').value = 'class-sport'; first.open({}); await pending;
    expect(calls.map((x) => [x.url, x.body?.classId])).toEqual([['/v1/agents/a1/class', 'class-school'], ['/v1/agents/a2/class', 'class-school']]);
  });
});

describe('Invite: a web-chat link lands only in the invite it was made for (audit #063)', () => {
  it("A's link, made late, is not shown in B's invite, whose Make link stays", async () => {
    const { c, $, calls } = page(['invite', 'makeWebChatInvite']);
    c.v2ChannelKinds = () => []; // web only: no Telegram question
    await c.invite('a1', 'Homework Helper');
    const made = gate();
    c.api = async (url: string, init: Init) => { calls.push({ url, ...init }); return made.p; };
    const pending = c.makeWebChatInvite();
    await c.invite('a2', 'Soccer Schedule');
    made.open({ url: 'https://hatchabot.example/join?code=made-up-code-a1' }); await pending;
    expect(calls[0]!.url).toBe('/v1/agents/a1/invites');
    expect($('invAgent').textContent).toBe('Soccer Schedule');
    expect($('invWebLink').textContent).toBe('');
    expect([$('invWebLink').hidden, $('invWebCopy').hidden, $('invWebBtn').hidden, $('invWebBtn').disabled]).toEqual([true, true, false, false]);
    // B's own link still lands in B's.
    c.api = async (url: string, init: Init) => { calls.push({ url, ...init }); return { url: 'https://hatchabot.example/join?code=made-up-code-a2' }; };
    await c.makeWebChatInvite();
    expect(calls.at(-1)!.url).toBe('/v1/agents/a2/invites');
    expect($('invWebLink').textContent).toContain('made-up-code-a2');
  });

  it("the Telegram invite: A's answer, late, does not fill B's", async () => {
    const { c, $, calls } = page(['invite']);
    const made = gate();
    c.api = async (url: string, init: Init) => { calls.push({ url, ...init }); return url.includes('/a1/') ? made.p : { url: 'https://hatchabot.example/i/b', code: 'b' }; };
    const pending = c.invite('a1', 'Homework Helper');
    await c.invite('a2', 'Soccer Schedule');
    made.open({ url: 'https://hatchabot.example/i/a', code: 'a' }); await pending;
    expect($('invAgent').textContent).toBe('Soccer Schedule');
    expect($('invLink').textContent).toBe('https://hatchabot.example/i/b');
  });
});

describe('Proposals: a master opened before lists nothing over the one open now (audit #064)', () => {
  it("master A's slow read leaves B's list, and B's buttons act on B's proposals", async () => {
    const { c, $, calls } = page(['openProposals', 'loadMasterProposals', 'resolveProposal']);
    const slowA = gate();
    c.api = async (url: string, init?: Init) => {
      calls.push({ url, ...init });
      if (url === '/v1/agents/a1/proposals' && !init) return slowA.p;
      if (url.endsWith('/resolve')) return {};
      return { proposals: [{ id: 'proposal-b', childName: 'Soccer U10', text: 'Practice moves to Thursday' }] };
    };
    const a = c.openProposals('a1', 'Homework Helper');
    await c.openProposals('a2', 'Soccer Schedule');
    slowA.open({ proposals: [{ id: 'proposal-a', childName: 'Math', text: 'Show the working' }] }); await a;
    expect($('proposalsAgent').textContent).toBe('Soccer Schedule');
    expect($('proposalsList').innerHTML).toContain('Practice moves to Thursday');
    expect($('proposalsList').innerHTML).not.toContain('Show the working');
    // A failed read, late, does not replace it either.
    const failA = gate();
    c.api = async (url: string, init?: Init) => { calls.push({ url, ...init }); return url.includes('/a1/') ? failA.p : { proposals: [] }; };
    const again = c.openProposals('a1', 'Homework Helper');
    await c.openProposals('a2', 'Soccer Schedule');
    failA.fail(new Error('Not found')); await again;
    expect($('proposalsList').innerHTML).not.toContain('Not found');
    // A resolve goes to the master that was open when it was pressed.
    c.proposalsMasterId = 'a2';
    const resolved = gate();
    c.api = async (url: string, init?: Init) => { calls.push({ url, ...init }); return url.endsWith('/resolve') ? resolved.p : { proposals: [] }; };
    const r = c.resolveProposal('proposal-b', 'dismiss', false);
    c.proposalsMasterId = 'a1'; resolved.open({}); await r;
    expect(calls.filter((x) => x.url.endsWith('/resolve')).map((x) => x.url)).toEqual(['/v1/agents/a2/proposals/proposal-b/resolve']);
  });
});

describe('The spend chart: the newest range or pick is the one drawn (audit #065)', () => {
  it("a week asked first and answered last leaves the day's chart", async () => {
    const { c } = page(['loadSpendChart']);
    const box = element();
    box.dataset = { agent: '' };
    const week = gate();
    c.api = async (url: string) => url.includes('range=week') ? week.p : { range: 'day', totals: { cost: 1 } };
    const first = c.loadSpendChart(box);
    c.spendRange = 'day'; await c.loadSpendChart(box);
    expect(box.innerHTML).toContain('"day"');
    week.open({ range: 'week', totals: { cost: 7 } }); await first;
    expect(box.innerHTML).toContain('"day"');
    // And its error, late, too.
    const slow = gate();
    c.api = async () => slow.p;
    const failing = c.loadSpendChart(box);
    c.api = async () => ({ range: 'month', totals: { cost: 30 } });
    await c.loadSpendChart(box);
    slow.fail(new Error('Bad Gateway')); await failing;
    expect(box.innerHTML).toContain('"month"');
  });
});

describe('The spend chart: tokens with no known price are never $0 (audit #062)', () => {
  const render = (d: Record<string, unknown>) => {
    const { c } = page(['spendChartHTML'], {
      SPEND_PARTS: [['cacheWrite', 'Cache writes', '#c9822b'], ['cacheRead', 'Cache reads', '#4f9a8f'], ['output', 'Output', '#7a6fd6'], ['input', 'New input', '#8a8f98']],
      SPEND_RANGE_LABELS: [['day', '1 day']], SPEND_RANGE_WORDS: { day: ['the last 24 hours', '24 hours'] }, spendPickOpen: false,
      v2Money: (v: number) => '$' + v.toFixed(2), fmtTokens: (v: number) => String(v), fmtN: String,
      modelPieSlices: () => [], agentPieSlices: () => [], donutHTML: (_s: unknown, _t: unknown, big: string) => `[${big}]`, pieLegend: () => '', niceTop: () => 1,
    });
    return c.spendChartHTML({ range: 'day', bucketHours: 1, buckets: [], planShare: 0, models: [], choices: [], monthly: 0, ...d }) as string;
  };
  it('all of it unpriced: no price, not $0.00', () => {
    const html = render({ totals: { cost: 0, tokens: 1_000_000 }, unpriced: { tokens: 1_000_000, models: ['made-up-cloud-model'] } });
    expect(html).toContain('[No price]');
    expect(html).not.toContain('[$0.00]');
    expect(html).toMatch(/1000000 tokens on <code>made-up-cloud-model<\/code> with no price known.*the amount is unknown/);
  });
  it('part of it unpriced: the priced part, marked as only part', () => {
    const html = render({ totals: { cost: 4.2, tokens: 2_000_000 }, monthly: 126, unpriced: { tokens: 1_000_000, models: ['made-up-cloud-model'] } });
    expect(html).toContain('[$4.20+]');
    expect(html).toContain('only part of it');
    expect(html).toContain('$126.00+ a month at this pace');
  });
  it('all priced: as it was', () => {
    const html = render({ totals: { cost: 4.2, tokens: 2_000_000 } });
    expect(html).toContain('[$4.20]');
    expect(html).not.toMatch(/no price known/);
  });
});

describe('The setup form for a child, an import or a share (audit #066, #067)', () => {
  const params: TemplateParam[] = [
    { key: 'style', label: 'Style', type: 'text', target: 'soul', required: false, default: 'Short answers' },
    { key: 'topics', label: 'Topics', type: 'multichoice', target: 'soul', required: false, options: ['Math', 'Reading'], default: 'Math' },
    { key: 'nickname', label: 'Nickname', type: 'text', target: 'soul', required: false },
    { key: 'reminders', label: 'Reminders', type: 'boolean', target: 'soul', required: false, default: 'yes' },
    { key: 'nightly', label: 'Nightly summary', type: 'boolean', target: 'soul', required: false, default: ' ON ' },
    { key: 'early', label: 'Early start', type: 'boolean', target: 'soul', required: false, default: '1' },
    { key: 'quiet', label: 'Quiet hours', type: 'boolean', target: 'soul', required: false, default: 'no' },
    { key: 'apiKey', label: 'Key', type: 'text', target: 'env', required: false, default: 'made-up' },
  ] as TemplateParam[];
  /** The form drawn from `params`, its controls as drawn (or as the test changes them), then Continue. */
  function form(change: (el: (i: number) => El & { picks: string[] }) => void = () => {}) {
    const nodes = new Map<string, El & { picks: string[] }>();
    const $ = (id: string) => { if (!nodes.has(id)) nodes.set(id, Object.assign(element(), { picks: [] as string[] })); return nodes.get(id)!; };
    const c = vm.createContext({ $, esc: (v: unknown) => String(v ?? ''), paramFormFields: [], paramFormResolve: null, paramFormDlg: { showModal() {}, close() {} }, String, RegExp }) as Record<string, any>;
    vm.runInContext([source('paramYes'), source('collectParamValues'), source('submitParamForm')].join('\n'), c as vm.Context);
    const sent: Promise<Record<string, string>> = c.collectParamValues(params, 'Homework Helper (child of Homework Helper)');
    const body = $('paramFormBody').innerHTML;
    params.forEach((p, i) => {
      const el = $(`pfv-${i}`);
      if (p.type === 'boolean') el.checked = new RegExp(`id="pfv-${i}"[^>]*checked`).test(body);
      else if (p.type === 'multichoice') el.picks = String(p.default ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      else if (p.target !== 'env') el.value = String(p.default ?? '');
      el.querySelectorAll = () => el.picks.map((o) => ({ dataset: { opt: o } }));
    });
    change((i) => $(`pfv-${i}`));
    vm.runInContext('submitParamForm()', c as vm.Context);
    return sent;
  }

  it('a yes default ("yes", "1", "on", any case) is drawn ticked, and untouched stays yes', async () => {
    const sent = await form();
    expect([sent.reminders, sent.nightly, sent.early, sent.quiet]).toEqual(['true', 'true', 'true', 'false']);
    expect(resolveParamValues(params, sent)).toMatchObject(resolveParamValues(params, {}));
  });

  it('a default cleared on purpose is sent empty and stays empty; untouched ones keep their default', async () => {
    const untouched = await form();
    expect(resolveParamValues(params, untouched)).toMatchObject({ style: 'Short answers', topics: 'Math' });
    const cleared = await form((el) => { el(0).value = ''; el(1).picks = []; });
    expect(cleared).toMatchObject({ style: '', topics: '' });
    expect(resolveParamValues(params, cleared)).toMatchObject({ style: '', topics: '' });
    // A field with no default left blank, and a credential, are still left out.
    expect('nickname' in cleared).toBe(false);
    expect('apiKey' in cleared).toBe(false);
  });
});
