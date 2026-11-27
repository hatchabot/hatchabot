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
import vm from 'node:vm';
import { readPage, readPageScripts } from '../scripts/page-source.mjs';
import { resolveParamValues, type TemplateParam } from '../src/orchestrator/transfer/template.js';

const html = readPage(new URL('../web/index.html', import.meta.url).pathname); // with its scripts (web/app/, HB-0811)
const js = readPageScripts(new URL('../web/index.html', import.meta.url).pathname).map((s) => s.code).join('\n');
function source(name: string): string {
  const m = new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^\\}`, 'm').exec(js);
  if (!m) throw new Error(`no function ${name} in web/index.html`);
  return m[0];
}
/** A top-level `const name = …;` of the page (to the first line that ends with ";"), as a var of the context. */
function constant(name: string): string {
  const m = new RegExp(`^const ${name} = [\\s\\S]*?;$`, 'm').exec(js);
  if (!m) throw new Error(`no const ${name} in web/index.html`);
  return m[0].replace(/^const /, 'var ');
}
/** The page's own onAction (its event-action attributes), with esc as the sandboxes stub it. */
const onAction = vm.runInNewContext(`(${source('onAction')})`, { esc: (v: unknown) => String(v ?? '') });

type El = {
  value: string; textContent: string; innerHTML: string; hidden: boolean; disabled: boolean; checked: boolean; title: string;
  style: Record<string, string>; dataset: Record<string, string>; isConnected: boolean; childElementCount: number;
  options: Array<{ value: string; defaultSelected: boolean }>;
  focus(): void; querySelectorAll(sel: string): unknown[]; contains(el: unknown): boolean;
};
function element(): El {
  let inner = '';
  const el: El = {
    value: '', textContent: '', hidden: false, disabled: false, checked: false, title: '', style: {}, dataset: {}, isConnected: true,
    childElementCount: 0, options: [], focus() {}, querySelectorAll: () => [], contains: () => false,
    get innerHTML() { return inner; },
    set innerHTML(v: string) {
      inner = v;
      // A <select>'s options are what it holds, and its value follows its selected option, as a browser's does.
      const options = [...v.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      el.options = options.map((o) => ({ value: o[1]!, defaultSelected: /selected/.test(o[2]!) }));
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
    editDlg: { open: false, close: () => closed.push('edit') }, v2AgentDlg: { open: false }, v2AgentId: null, editParamsFills: 0, inviteDlg: { open: false, showModal() { this.open = true; } }, proposalsDlg: { showModal: noop },
    peersLoadedFor: null, peersCurrent: null, sharePeopleFor: null, // what the shared buttons' locks ask (SHEET_BUTTONS)
    esc: (v: unknown) => String(v ?? ''), jsq: (v: unknown) => String(v ?? ''), onAction, ago: () => 'just now',
    sourceOptionLabel: (p: { name: string }) => p.name, localClashWarning: () => '', confirmRebuild: () => true,
    showEditTab: noop, populateImagePicker: async () => {}, embedModeText: () => '', renderSetupValues: noop, renderBotWho: noop,
    renderEditMembers: async () => {}, renderParamList: noop, renderDataList: noop, renderEnvList: noop, renderClassList: noop,
    v2ChannelKinds: () => ['telegram'], location: { origin: 'https://hatchabot.example' }, navigator: {}, document: { querySelectorAll: () => [] },
    editAgentId: 'a1', editLoaded: null, editLoadGen: 0, editReverting: new Set(), EDIT_REVERTING: 'Reverting…',
    v2SheetSaving: () => noop, v2SheetBaseline: noop, V2_SHEET_FORMS: [], sheetReads: new Map(), // the sheet's record of unsaved edits (HB-0475): not what these check
    onRepoPublic: noop, onParamTypeChange: noop, v2CtlDrawn: () => '',
    invWebFor: null, invShare: null, proposalsMasterId: null, proposalsGen: 0,
    sharingEpoch: 0, sharingView: 0, sharingReads: new WeakMap(), pagePerson: 'synthetic-owner', pagePersonAway: false, pageSignedOut: false,
    spendRange: 'week', spendAgents: [], spendChartSeq: 0, spendChartHTML: (d: unknown) => JSON.stringify(d),
    ...extra,
  });
  // Whose forms an answer is drawn in, and where it is said: the page's own helpers (forAgent, agentPrefix, and the saves, reads and fills
  // built on it), and the forms' shared buttons, held by a press and given back to its own agent's forms (HB-1484).
  for (const n of ['agentPrefix', 'forAgent', 'sheetSave', 'sheetRead', 'sheetFill', 'sheetPress', 'sheetButton', 'sourceAsSaved', 'inviteCurrent', 'sharingRead', 'sharingPage', ...names]) vm.runInContext(source(n), c);
  for (const n of ['sheetPresses', 'MODEL_WAITS_ON_SOURCE', 'SHEET_BUTTONS', 'SHEET_HINTS', 'HANDLE_LINK', 'HANDLE_MAX']) vm.runInContext(constant(n), c);
  vm.runInContext("const v2Find = id => agents.find(a => a.id === id); const v2Mine = a => !a.role || a.role === 'owner';", c);
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
    expect(calls[1]!.body).toEqual({ checkpoint: true, stoppedWaits: true });
    expect(closed).toEqual([]); // B's sheet stays open
  });

  it("the image pin rebuilds its original agent; a peer grant answered in another agent view offers its own agent's rebuild, by its name (HB-1486)", async () => {
    const pin = page(['saveImagePin']);
    pin.$('editImage').value = 'hatchabot-runtime:candidate';
    const saved = gate();
    pin.c.api = async (url: string, init: Init) => { pin.calls.push({ url, ...init }); return init.method === 'PATCH' ? saved.p : {}; };
    const p1 = pin.c.saveImagePin(); pin.c.editAgentId = 'a2'; saved.open({}); await p1;
    expect(pin.calls.map((x) => x.url)).toEqual(['/v1/agents/a1', '/v1/agents/a1/rebuild']);

    const toasts: string[] = [], asked: string[] = [];
    const peers = page(['savePeers'], { peersLoadedFor: 'a1', toast: (t: string) => toasts.push(t), document: { querySelectorAll: (sel: string) => sel === '.peerCb:checked' ? [{ dataset: { id: 'a2' } }] : [] } });
    peers.c.peersCurrent = peers.c.sharingRead(peers.$('agentPeerList'), 'a1');
    peers.c.confirm = (q: string) => { asked.push(q); return true; };
    let put = gate();
    peers.c.api = async (url: string, init: Init) => { peers.calls.push({ url, ...init }); return init.method === 'PUT' ? put.p : {}; };
    const p2 = peers.c.savePeers(); peers.c.editAgentId = 'a2'; put.open({}); await p2;
    // Was: saved, and nothing asked or said: the grant waited for a rebuild nobody was offered (HB-1486).
    expect(peers.calls.map((x) => [x.method, x.url])).toEqual([['PUT', '/v1/agents/a1/peers'], ['POST', '/v1/agents/a1/rebuild']]);
    expect(peers.calls[0]!.body).toEqual({ peerIds: ['a2'], allowActions: [] });
    expect(asked).toEqual([expect.stringMatching(/^Saved\. Rebuild "Homework Helper" now so it can consult 1 peer\?/)]);
    expect(toasts).toEqual(['Homework Helper: Rebuilding so it can consult its peers…']);
    expect(peers.closed).toEqual([]); // B's sheet stays open
    peers.c.editAgentId = 'a1'; peers.$('peerSaveBtn').disabled = false;
    peers.c.peersCurrent = peers.c.sharingRead(peers.$('agentPeerList'), 'a1');
    await peers.c.savePeers();
    expect(asked).toHaveLength(2);
    expect(peers.calls.at(-1)!.url).toBe('/v1/agents/a1/rebuild');
    // The session ended before the answer: nothing asked, said or sent after the save.
    peers.$('peerSaveBtn').disabled = false; put = gate();
    peers.c.peersCurrent = peers.c.sharingRead(peers.$('agentPeerList'), 'a1');
    const sent = peers.calls.length, said = toasts.length;
    const p3 = peers.c.savePeers(); peers.c.pageSignedOut = true; put.open({}); await p3;
    expect([peers.calls.slice(sent).map((x) => x.method), asked.length, toasts.length]).toEqual([['PUT'], 2, said]);
  });

  it('a late peer save: no rebuild offered for an agent deleted or no longer theirs, and nothing said once the rebuild answers to another person (HB-1486 review)', async () => {
    const toasts: string[] = [], asked: string[] = [];
    const peers = page(['savePeers'], { peersLoadedFor: 'a1', toast: (t: string) => toasts.push(t), document: { querySelectorAll: (sel: string) => sel === '.peerCb:checked' ? [{ dataset: { id: 'a2' } }] : [] } });
    peers.c.confirm = (q: string) => { asked.push(q); return true; };
    let put = gate(), rebuild = gate();
    peers.c.api = async (url: string, init: Init) => { peers.calls.push({ url, ...init }); return init.method === 'PUT' ? put.p : rebuild.p; };
    const press = async (meanwhile: () => void, answer = () => put.open({})) => {
      peers.$('peerSaveBtn').disabled = false; put = gate(); rebuild = gate();
      peers.c.peersCurrent = peers.c.sharingRead(peers.$('agentPeerList'), 'a1');
      const from = peers.calls.length;
      const pressed = peers.c.savePeers(); meanwhile(); answer(); await pressed;
      return peers.calls.slice(from).map((x) => `${x.method} ${x.url}`);
    };
    // No longer theirs (now shared with them as a member) while it saved: saved, no rebuild offered.
    expect(await press(() => { peers.c.editAgentId = 'a2'; peers.c.agents[0].role = 'member'; })).toEqual(['PUT /v1/agents/a1/peers']);
    expect([asked, toasts]).toEqual([[], ['Homework Helper: Saved.']]);
    // Deleted meanwhile: the same, by no name.
    peers.c.editAgentId = 'a1'; delete peers.c.agents[0].role;
    expect(await press(() => { peers.c.editAgentId = 'a2'; peers.c.agents = peers.c.agents.slice(1); })).toEqual(['PUT /v1/agents/a1/peers']);
    expect([asked, toasts.at(-1)]).toEqual([[], 'The agent: Saved.']);
    // Its rebuild answered after the session ended: rebuilt as asked, then nothing said and nothing closed.
    peers.c.editAgentId = 'a1'; peers.c.agents = AGENTS.map((a) => ({ ...a }));
    const said = toasts.length;
    expect(await press(() => {}, () => { put.open({}); setTimeout(() => { peers.c.pageSignedOut = true; rebuild.open({}); }, 0); }))
      .toEqual(['PUT /v1/agents/a1/peers', 'POST /v1/agents/a1/rebuild']);
    expect([asked.length, toasts.length, peers.closed]).toEqual([1, said, []]);
  });

  it('a Gmail test, a removal and a bot token answered once the page is not its person\'s: nothing said, nothing shown (HB-1486 review)', async () => {
    const ends: Array<[string, (c: Record<string, any>) => void]> = [
      ['signed out', (c) => { c.pageSignedOut = true; }],
      ['another person', (c) => { c.pagePerson = 'synthetic-other'; }],
      ['away', (c) => { c.pagePersonAway = true; }],
      ['sharing put away', (c) => { c.sharingEpoch++; }],
    ];
    for (const [end, change] of ends) {
      for (const fails of [false, true]) {
        const toasts: string[] = [];
        const { c, $, calls } = page(['testAgentGmail', 'kick', 'showBotToken'], { toast: (t: string) => toasts.push(t), pairTick: 1, copyText: async () => true });
        let answer = gate();
        c.api = async (url: string, init?: Init) => { calls.push({ url, ...init }); return answer.p; };
        const run = async (press: () => Promise<void>, body: unknown) => {
          answer = gate();
          const pressed = press(); change(c);
          if (fails) answer.fail(new Error('Refused, made up.')); else answer.open(body);
          await pressed;
          c.pageSignedOut = false; c.pagePerson = 'synthetic-owner'; c.pagePersonAway = false;
        };
        const btn = element();
        await run(() => c.testAgentGmail(btn, 'family@example.com', 0), { ok: true, detail: 'Inbox read.' });
        await run(() => c.kick('a1', 'u-made-up', 'Sam Example'), {});
        await run(() => c.showBotToken(), { botToken: 'made-up-bot-token', pooled: true });
        const what = `${end}, ${fails ? 'refused' : 'answered'}`;
        expect(calls.map((x) => x.url), what).toEqual(['/v1/agents/a1/connections/family%40example.com/test', '/v1/agents/a1/members/u-made-up', '/v1/agents/a1/bot-token']);
        expect(toasts, what).toEqual([]);
        expect([$('connGmailOut0').textContent, $('editBotToken').value, $('editErr').textContent], what).toEqual(['Testing…', '', '']);
        expect(c.pairTick, what).toBe(1);
      }
    }
    // The same presses with the page still its person's, under another agent's sheet: said with the agent's name.
    const toasts: string[] = [];
    const { c } = page(['testAgentGmail', 'kick', 'showBotToken'], { toast: (t: string) => toasts.push(t), pairTick: 1, copyText: async () => true });
    let answer = gate();
    c.api = async () => answer.p;
    for (const press of [() => c.testAgentGmail(element(), 'family@example.com', 0), () => c.kick('a1', 'u-made-up', 'Sam Example'), () => c.showBotToken()]) {
      answer = gate(); c.editAgentId = 'a1';
      const pressed = press(); c.editAgentId = 'a2'; answer.fail(new Error('Refused, made up.')); await pressed;
    }
    expect(toasts).toEqual(['Homework Helper: ⚠ Refused, made up.', 'Homework Helper: Refused, made up.', 'Homework Helper: Refused, made up.']);
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

  it("A's model switch answered after B's source was changed and not applied: B's model button still waits on Use this (HB-1484)", async () => {
    const { c, $ } = page(['prepareEdit', 'renderModelPicker', 'renderModelPickerForAgent', 'renderModelPickerForProfile', 'onEditProfileChange', 'switchModel']);
    c.prepareEdit('a1', 'Homework Helper');
    const answered = gate();
    c.api = async () => answered.p;
    const pending = c.switchModel();
    expect($('modelBtn').disabled).toBe(true); // A's Use this is out
    c.prepareEdit('a2', 'Soccer Schedule');
    expect($('modelBtn').disabled).toBe(false); // B's own: nothing of B's is out
    $('editProfile').value = 'p2'; c.onEditProfileChange();
    answered.open({ live: true, model: 'claude-sonnet-5' }); await pending;
    expect([$('modelBtn').disabled, $('modelBtn').title]).toEqual([true, 'Apply the source change first (Use this, above), then pick a model.']);
    $('editProfile').value = 'p1'; c.onEditProfileChange(); // back on its own source
    expect([$('modelBtn').disabled, $('modelBtn').title]).toEqual([false, '']);
  });

  it("Use this for p2, then p3 picked while it saved: after the answer the model button still waits on Use this, with p3's models (HB-1484)", async () => {
    const third = { id: 'p3', name: 'Third source', vendor: 'anthropic', model: 'claude-haiku-5', models: [] };
    const { c, $ } = page(['prepareEdit', 'renderModelPicker', 'renderModelPickerForAgent', 'renderModelPickerForProfile', 'onEditProfileChange', 'switchProfile'],
      { profiles: [...PROFILES, third] });
    c.prepareEdit('a1', 'Homework Helper');
    $('editProfile').value = 'p2'; c.onEditProfileChange();
    const saved = gate();
    c.api = async (_url: string, init: Init) => init.method === 'PATCH' ? saved.p : {};
    let asked = 0; c.confirm = () => ++asked === 1; // Use this: yes; rebuild now: no, so the sheet stays open
    c.refresh = async () => { Object.assign(c.agents.find((a: { id: string }) => a.id === 'a1'), { aiProfileId: 'p2', profileModels: ['claude-opus-5-5'], profileDefaultModel: 'claude-opus-5-5' }); };
    const pending = c.switchProfile();
    $('editProfile').value = 'p3'; c.onEditProfileChange();
    saved.open({}); await pending;
    expect([$('modelBtn').disabled, $('modelBtn').title]).toEqual([true, 'Apply the source change first (Use this, above), then pick a model.']);
    expect($('editModel').innerHTML).toContain('claude-haiku-5'); // the source shown, not the one applied
    $('editProfile').value = 'p2'; c.onEditProfileChange(); // back on the source it now runs
    expect([$('modelBtn').disabled, $('modelBtn').title]).toEqual([false, '']);
    expect($('editModel').innerHTML).toContain('claude-opus-5-5');
  });

  it("Use this saved and the poll after it failed: the model button is on, with the new source's models, not waiting on the poll (HB-1484)", async () => {
    for (const answer of [
      { id: 'a1', aiProfileId: 'p2', profileModels: ['claude-opus-5-5'], profileDefaultModel: 'claude-opus-5-5' }, // the agent as saved
      {}, // an answer without it: what was sent
    ]) {
      const { c, $ } = page(['prepareEdit', 'renderModelPicker', 'renderModelPickerForAgent', 'renderModelPickerForProfile', 'onEditProfileChange', 'switchProfile']);
      c.prepareEdit('a1', 'Homework Helper');
      $('editProfile').value = 'p2'; c.onEditProfileChange();
      c.api = async (_url: string, init: Init) => init.method === 'PATCH' ? answer : {};
      let asked = 0; c.confirm = () => ++asked === 1; // Use this: yes; rebuild now: no, so the sheet stays open
      c.refresh = async () => {}; // the poll failed: the page's list is as it was
      await c.switchProfile();
      expect([$('modelBtn').disabled, $('modelBtn').title], JSON.stringify(answer)).toEqual([false, '']);
      expect(c.agents[0].aiProfileId).toBe('p2');
      if ('profileModels' in answer) expect($('editModel').innerHTML).toContain('claude-opus-5-5 — default');
    }
  });

  it("an agent whose source the menu does not list: the menu's first is its own, as drawn, and another waits on Use this", () => {
    const { c, $ } = page(['prepareEdit', 'renderModelPicker', 'renderModelPickerForAgent', 'renderModelPickerForProfile', 'onEditProfileChange']);
    c.agents[0].aiProfileId = 'p-not-shared';
    c.prepareEdit('a1', 'Homework Helper');
    expect([$('editProfile').value, $('modelBtn').disabled, $('modelBtn').title]).toEqual(['p1', false, '']);
    $('editProfile').value = 'p2'; c.onEditProfileChange();
    expect($('modelBtn').disabled).toBe(true);
    $('editProfile').value = 'p1'; c.onEditProfileChange();
    expect([$('modelBtn').disabled, $('modelBtn').title]).toEqual([false, '']);
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
    const { c, $, calls } = page(['faApply', 'faResultLine', 'reasonFor', 'reasonsSaid'], {
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
    const { c, $, calls } = page(['invite', 'askHandle', 'handleTyped']); // its handle asked as the page does (HB-1439 review)
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
    const { c } = page(['loadSpendChart', 'drawSpendChart', 'spendChartWidth', 'spendChartsPrune'], { spendChartFit: null, spendChartsSeen: new Set(), phoneQuery: null });
    const box = Object.assign(element(), { querySelector: () => null });
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
  it('a read that fails lets its chart go: not watched, nothing left to fit', async () => {
    const watching = new Set<unknown>();
    const fit = { observe: (el: unknown) => watching.add(el), unobserve: (el: unknown) => watching.delete(el) };
    const { c } = page(['loadSpendChart', 'drawSpendChart', 'spendChartWidth', 'spendChartsPrune'], { spendChartFit: fit, spendChartsSeen: new Set() });
    const box = Object.assign(element(), { querySelector: () => null });
    box.dataset = { agent: '' };
    c.api = async () => ({ range: 'week', totals: { cost: 7 } });
    await c.loadSpendChart(box);
    expect(c.spendChartsSeen.has(box) && watching.has(box)).toBe(true);
    c.api = async () => { throw new Error('Bad Gateway'); };
    await c.loadSpendChart(box);
    expect(box.innerHTML).toContain('Bad Gateway');
    expect((box as unknown as { _spend: unknown })._spend).toBeNull();
    expect(c.spendChartsSeen.has(box) || watching.has(box)).toBe(false);
  });
});

describe('The spend chart on a phone: fitted again a frame after its width changes (review 2026-11-08)', () => {
  type Pic = { innerHTML: string };
  type Box = { clientWidth: number; isConnected: boolean; _spend: { W: number; boxW: number; d: { range: string } } | null; pic: Pic; querySelector(sel: string): Pic | null };
  const setup = () => {
    const frames: Array<() => void> = [], unobserved: Box[] = [];
    const { c } = page(['spendChartResized', 'spendChartsRefit', 'spendChartsPrune'], {
      spendChartsSeen: new Set(), spendChartsDue: new Set(), requestAnimationFrame: (f: () => void) => frames.push(f),
      spendChartWidth: (el: Box) => el.clientWidth - 24, spendChartSVG: (_d: unknown, W: number) => `<svg ${W}>`,
      spendChartFit: { unobserve: (el: Box) => unobserved.push(el) },
    });
    const box = (w: number): Box => {
      const pic = { innerHTML: '<svg old>' };
      const b: Box = { clientWidth: w, isConnected: true, _spend: { W: w - 24, boxW: w, d: { range: 'week' } }, pic, querySelector: (sel) => sel === '.spendsvg' ? pic : null };
      c.spendChartsSeen.add(b);
      return b;
    };
    return { c, box, frames, unobserved };
  };
  it('its height changed by drawing it: nothing to do (no loop)', () => {
    const { c, box, frames } = setup();
    c.spendChartResized([{ target: box(300) }]);
    expect(frames).toHaveLength(0);
  });
  it('its width changed: only its picture drawn, in the next frame, once, and only the box that changed', () => {
    const { c, box, frames } = setup();
    const a = box(300), other = box(300);
    other.clientWidth = 280; other._spend!.boxW = 280; // changed too, but not reported: left alone
    a.clientWidth = 340;
    c.spendChartResized([{ target: a }]); c.spendChartResized([{ target: a }]);
    expect(frames).toHaveLength(1);
    expect(a.pic.innerHTML).toBe('<svg old>');
    frames[0]!();
    expect(a.pic.innerHTML).toBe('<svg 316>');
    expect(a._spend).toMatchObject({ W: 316, boxW: 340 });
    expect(other.pic.innerHTML).toBe('<svg old>');
    c.spendChartResized([{ target: a }]);
    expect(frames).toHaveLength(1);
  });
  it('hidden when refitted: fitted once it shows, at whatever width (it may have missed a change)', () => {
    const { c, box, frames } = setup();
    const a = box(300);
    a.clientWidth = 0;
    c.spendChartsRefit([a]);
    expect(a._spend!.boxW).toBe(0);
    a.clientWidth = 300; // shown again at the width it had
    c.spendChartResized([{ target: a }]);
    expect(frames).toHaveLength(1);
  });
  it('a chart gone from the page, or in a dialog that closed, is let go and no longer watched', () => {
    const { c, box, unobserved } = setup();
    const gone = box(300), kept = box(300), shut = box(300);
    gone.isConnected = false;
    c.spendChartsRefit([gone, kept, shut]);
    expect([...c.spendChartsSeen]).toEqual([kept, shut]);
    c.spendChartsPrune({ contains: (el: Box) => el === shut });
    expect([...c.spendChartsSeen]).toEqual([kept]);
    expect(unobserved).toEqual([gone, shut]);
    expect(gone._spend).toBeNull();
    expect(shut._spend).toBeNull();
    expect((shut as unknown as { innerHTML: string }).innerHTML).toContain('Loading…'); // opened again, never a stale chart
    expect(kept._spend).not.toBeNull();
  });
});

describe('The spend chart: tokens with no known price are never $0 (audit #062)', () => {
  const render = (d: Record<string, unknown>) => {
    const { c } = page(['spendChartHTML', 'spendChartSVG', 'spendChartWords'], {
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

describe('an error goes where it is seen (forAgent, as shipped)', () => {
  it("A's pin refused with B's Overview open (A's forms parked, out of sight): a toast with A's name", async () => {
    const toasts: string[] = [];
    const refused = gate();
    const { c, $ } = page(['saveImagePin'], { toast: (t: string) => toasts.push(t), v2AgentDlg: { open: true }, v2AgentId: 'a1', api: () => refused.p });
    $('editImage').value = 'hatchabot-runtime:candidate';
    const pending = c.saveImagePin();
    c.v2AgentId = 'a2'; // B's Overview: the edit forms stay A's (editAgentId), and editErr is parked with them
    refused.fail(new Error('No such image on this machine.')); await pending;
    expect(toasts).toEqual(['Homework Helper: No such image on this machine.']);
    expect($('editErr').textContent).toBe('');
  });
  it("A's own tab of forms in sight: under them, and no toast", async () => {
    const toasts: string[] = [];
    const { c, $ } = page(['saveImagePin'], { toast: (t: string) => toasts.push(t), v2AgentDlg: { open: true }, v2AgentId: 'a1' });
    $('v2Pane').contains = (el: unknown) => el === $('editErr');
    c.api = async () => { throw new Error('No such image on this machine.'); };
    $('editImage').value = 'hatchabot-runtime:candidate';
    await c.saveImagePin();
    expect([$('editErr').textContent, toasts]).toEqual(['No such image on this machine.', []]);
  });
});
