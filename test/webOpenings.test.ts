/**
 * The web page's own functions (web/index.html as shipped) against a small
 * made-up DOM: what a press or a read does when its dialog was closed and
 * opened again (on another agent, another repo) before the answer came, and
 * what a few settings say (audit of v2.170.1, 2026-10-29: HB-0265, HB-0283,
 * HB-0350 to HB-0353, HB-0367). The click-through (scripts/ui-clickthrough.mjs,
 * its audit… scenarios) drives the same paths in a real browser. Agents are
 * the invented household's; addresses are example.org.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { mergeConfig, type AppManifest } from '../src/orchestrator/apps.js';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const js = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
function source(name: string): string {
  const m = new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^\\}`, 'm').exec(js);
  if (!m) throw new Error(`no function ${name} in web/index.html`);
  return m[0];
}

type El = Record<string, any>;
function element(): El {
  return {
    value: '', textContent: '', innerHTML: '', hidden: false, disabled: false, checked: false, title: '', style: {}, dataset: {},
    isConnected: true, open: false, focus() {}, querySelectorAll: () => [], addEventListener() {}, scrollIntoView() {},
    showModal() { this.open = true; }, close() { this.open = false; },
  };
}
type Call = { url: string; method?: string; body?: any };
function gate<T = unknown>() {
  let open!: (v: T) => void;
  const p = new Promise<T>((res) => { open = res; });
  return { p, open };
}

/** The named page functions in a context of their own, with `extra` as its globals. */
function page(names: string[], extra: Record<string, unknown> = {}) {
  const nodes = new Map<string, El>();
  const $ = (id: string) => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id)!; };
  const calls: Call[] = [];
  const toasts: string[] = [];
  const c: any = vm.createContext({
    $, console, Intl, Date, Math, JSON, String, Number, Promise, Set, Map, encodeURIComponent, setTimeout: () => 0, clearTimeout() {},
    esc: (v: unknown) => String(v ?? ''), jsq: (v: unknown) => String(v ?? ''),
    api: async (url: string, init: { method?: string; body?: unknown } = {}) => { calls.push({ url, ...init }); return {}; },
    toast: (m: string) => toasts.push(m), confirm: () => true, refresh: async () => {},
    hosts: [{ id: 'h1', kind: 'local' }], profiles: [{ id: 'p1', name: 'Household plan' }],
    agents: [{ id: 'a1', name: 'Homework Helper' }, { id: 'a2', name: 'Soccer Schedule' }],
    document: { querySelectorAll: () => [] },
    ...extra,
  });
  for (const n of names) vm.runInContext(source(n), c);
  return { c, $, calls, toasts };
}

describe('an agent left DELETING (HB-0265)', () => {
  it('still has Delete at the foot of its Overview, and says it finishes the delete', () => {
    const fn = source('v2Pane');
    const ctx = { jsq: String, esc: String, v2PlaceInGroup: () => undefined, v2Status: () => ({ why: [] }), TEMPLATE_WHY: 'fixture', v2Mine: () => false,
      profiles: [], hosts: [], agents: [], agentNotices: () => '', v2OpGoing: () => false, v2ChannelKinds: () => [], V2_NEW_GROUP: 'new', v2Sort: { key: 'manual' } };
    const pane = vm.runInNewContext('(' + fn + ')', ctx);
    const deleting = pane({ id: 'a1', name: 'Homework Helper', state: 'DELETING' }, 'overview');
    expect(deleting).toContain(`del('a1','Homework Helper')`);
    expect(deleting).toContain('Delete… finishes it');
    expect(deleting).not.toContain('📥 Archive');
    const stopped = pane({ id: 'a1', name: 'Homework Helper', state: 'STOPPED' }, 'overview');
    expect(stopped).toContain('Delete…');
    expect(stopped).not.toContain('finishes it');
  });
});

describe('Try on agents (HB-0350)', () => {
  it('rebuilds with the Chat → Memory checkpoint its question promises', async () => {
    const { c, calls } = page(['runTryOnAgents'], {
      tryState: { tag: 'hatchabot-runtime:candidate', picked: new Set(['a1', 'a2']) }, tryDlg: element(), updateTryBtn() {}, loadRuntimeImages: async () => {},
    });
    let asked = '';
    c.confirm = (s: string) => { asked = s; return true; };
    await c.runTryOnAgents();
    expect(asked).toContain('Chat → Memory runs first');
    expect(calls.filter((x) => x.url.endsWith('/rebuild')).map((x) => [x.url, x.body])).toEqual([
      ['/v1/agents/a1/rebuild', { checkpoint: true }], ['/v1/agents/a2/rebuild', { checkpoint: true }]]);
  });
});

const APP_FNS = ['openAppDlg', 'appRead', 'appGo', 'appValues', 'appConnPicked', 'appConnMismatch', 'appSharedOk', 'appAttachProblem'];
function appPage(extra: Record<string, unknown> = {}) {
  const p = page(APP_FNS, {
    appDlgMode: 'create', appDlgAgent: null, appInspected: null, appConns: [], appDlgGen: 0, appReadGen: 0,
    appDlg: element(), v2Find: (id: string) => ({ id, name: id === 'a1' ? 'Homework Helper' : 'Soccer Schedule' }),
    sourceOptionLabel: (x: { name: string }) => x.name, v2AgentId: null, v2LoadApp: async () => {}, ...extra,
  });
  return p;
}
const MAN = (name: string) => ({ app: name.toLowerCase().replace(/\W/g, ''), name, tasks: [], config: { fields: [] } });

describe('the app dialog: a read that answers late (HB-0351)', () => {
  it('lands nowhere when the dialog was opened again on another agent', async () => {
    const { c, $ } = appPage();
    c.openAppDlg('install', 'a1');
    $('appSource').value = '~/demoapp';
    const g = gate<unknown>();
    c.api = () => g.p;
    const reading = c.appRead();
    c.openAppDlg('install', 'a2');
    $('appSource').value = '~/otherapp';
    g.open({ manifest: MAN('Demo App'), sha: 'c0ffee01', ask: [{ key: 'mode', default: 'shadow' }] });
    await reading;
    expect(c.appInspected).toBeNull();
    expect($('appGoBtn').disabled).toBe(true);
    expect($('appInfo').innerHTML).not.toContain('Demo App');
    expect($('appForm').innerHTML).toBe('');
    expect($('appReadBtn').disabled).toBe(false);
  });

  it('lands nowhere when another repo was read since, even if it fails after', async () => {
    const { c, $ } = appPage();
    c.openAppDlg('install', 'a1');
    const first = gate<unknown>(), second = gate<unknown>();
    const answers = [first.p, second.p];
    c.api = () => answers.shift();
    $('appSource').value = '~/demoapp';
    const a = c.appRead();
    $('appSource').value = '~/otherapp';
    const b = c.appRead();
    second.open({ manifest: MAN('Other App'), sha: 'feedc0de', ask: [] });
    await b;
    first.open({ manifest: MAN('Demo App'), sha: 'c0ffee01', ask: [] });
    await a;
    expect(c.appInspected.source).toBe('~/otherapp');
    expect($('appInfo').innerHTML).toContain('Other App');
    expect($('appGoBtn').disabled).toBe(false);
  });
});

describe('the app dialog: Install (HB-0283)', () => {
  it('installs on the agent, repo and values it was pressed for, and leaves the dialog opened since alone', async () => {
    const { c, $, calls } = appPage();
    c.openAppDlg('install', 'a1');
    c.appInspected = { source: '~/demoapp', manifest: MAN('Demo App'), ask: [{ key: 'mailbox', type: 'email', required: true }], connections: [] };
    $('appF_mailbox').value = 'helper@example.org';
    $('appConn').value = 'c2';
    c.appConns = [{ id: 'c2', kind: 'google', email: 'helper@example.org', attachedTo: [] }];
    const attach = gate<unknown>();
    c.api = async (url: string, init: { method?: string; body?: unknown } = {}) => { calls.push({ url, ...init }); return calls.length === 1 ? attach.p : {}; };
    const going = c.appGo();
    c.appDlg.close();
    c.openAppDlg('install', 'a2');
    c.appInspected = { source: '~/otherapp', manifest: MAN('Other App'), ask: [{ key: 'colour' }] };
    $('appGoBtn').disabled = false;
    attach.open({ attached: true, live: true });
    await going;
    expect(calls.map((x) => [x.url, x.body])).toEqual([
      ['/v1/agents/a1/connections/attach', { connectionId: 'c2' }],
      ['/v1/agents/a1/app', { source: '~/demoapp', values: { mailbox: 'helper@example.org' } }],
    ]);
    expect(c.appDlg.open).toBe(true);
    expect(c.appDlgAgent).toBe('a2');
    expect($('appGoBtn').disabled).toBe(false);
  });

  it('says a failure in a toast, not in the dialog opened since', async () => {
    const { c, $, toasts } = appPage();
    c.openAppDlg('install', 'a1');
    c.appInspected = { source: '~/demoapp', manifest: MAN('Demo App'), ask: [] };
    let fail!: (e: Error) => void;
    c.api = () => new Promise((_, rej) => { fail = rej; });
    const going = c.appGo();
    c.appDlg.close();
    c.openAppDlg('install', 'a2');
    fail(Object.assign(new Error('Its tests failed.'), { data: { test: { output: 'made-up test output' } } }));
    await going;
    expect(toasts.at(-1)).toBe('Demo App was not installed: Its tests failed.');
    expect($('appErr').textContent).toBe('');
    expect($('appOut').hidden).toBe(true);
  });

  it('a failed attach names the account picked when Install was pressed, not the one picked since', async () => {
    const { c, $, toasts } = appPage();
    c.openAppDlg('install', 'a1');
    c.appInspected = { source: '~/demoapp', manifest: MAN('Demo App'), ask: [], connections: [] };
    c.appConns = [{ id: 'c1', kind: 'google', email: 'first@example.org', attachedTo: [] }];
    $('appConn').value = 'c1';
    const attach = gate<unknown>();
    c.api = () => attach.p;
    const going = c.appGo();
    c.appDlg.close();
    c.openAppDlg('install', 'a2');
    c.appConns = [{ id: 'c2', kind: 'google', email: 'second@example.org', attachedTo: [] }];
    $('appConn').value = 'c2';
    attach.open({ attached: false, error: 'denied' });
    await going;
    expect(toasts.at(-1)).toBe('Demo App was not installed: first@example.org was not attached (denied), so nothing was installed. Try again.');
  });

  it('a new agent from a repo takes the name, source and Telegram choice as they were when Create was pressed', async () => {
    const { c, $, calls } = appPage({ profiles: [{ id: 'p1', name: 'Household plan' }, { id: 'p2', name: 'Second source' }] });
    c.openAppDlg('create');
    c.appInspected = { source: '~/demoapp', manifest: { ...MAN('Demo App'), chat: 'Run in {app_dir}.' }, ask: [] };
    $('appName').value = 'Garden Helper'; $('appProfile').value = 'p2'; $('appNoTelegram').checked = true;
    const chat = gate<unknown>();
    c.api = async (url: string, init: { method?: string; body?: unknown } = {}) => { calls.push({ url, ...init }); return calls.length === 1 ? chat.p : url === '/v1/agents' ? { id: 'new1' } : {}; };
    const going = c.appGo();
    c.appDlg.close();
    c.openAppDlg('create');
    $('appName').value = 'Something Else'; $('appProfile').value = 'p1'; $('appNoTelegram').checked = false;
    chat.open({ chat: 'Run in the app folder.' });
    await going;
    const made = calls.find((x) => x.url === '/v1/agents');
    expect(made?.body).toMatchObject({ name: 'Garden Helper', aiProfileId: 'p2', telegram: false });
    expect(calls.find((x) => x.url === '/v1/agents/new1/app/pending')?.body).toEqual({ source: '~/demoapp', values: {} });
    expect(c.appDlg.open).toBe(true);
  });
});

describe('the app form: on/off defaults (HB-0352)', () => {
  it('ticks a bool field as the server reads its default', async () => {
    const defaults: Array<[string, unknown]> = [['quiet', 'false'], ['dry', 'off'], ['slow', 'No'], ['zero', '0'], ['loud', 'yes'], ['fast', true], ['on1', ' TRUE '], ['none', undefined]];
    const ask = defaults.map(([key, d]) => ({ key, type: 'bool' as const, ...(d === undefined ? {} : { default: d }) }));
    const m = { app: 'demoapp', name: 'Demo App', tasks: [], config: { file: 'config.json', fields: ask } } as unknown as AppManifest;
    const { c, $ } = appPage();
    c.openAppDlg('create');
    $('appSource').value = '~/demoapp';
    c.api = async () => ({ manifest: m, sha: 'c0ffee01', ask });
    await c.appRead();
    const form = $('appForm').innerHTML as string;
    const ticked = (key: string) => new RegExp(`id="appF_${key}"[^>]*checked`).test(form);
    const server = mergeConfig(m, { slug: 'demo', name: 'Demo' } as never, {}, {}).config;
    for (const [key] of defaults) expect([key, ticked(key)]).toEqual([key, server[key] === true]);
    expect(defaults.filter(([k]) => ticked(k)).map(([k]) => k)).toEqual(['loud', 'fast', 'on1']);
  });
});

describe('the icon dialog (HB-0367)', () => {
  it("a save that ends after the dialog was opened on another agent leaves that opening alone", async () => {
    const dlg = element();
    const { c, $, calls } = page(['openV2Icon', 'v2IconSave'], {
      v2IconFor: null, v2IconColor: null, v2IconGen: 0, v2IconIdeasShown: [], v2IconDlg: dlg, V2_EMOJI: [],
      v2Find: (id: string) => ({ id, name: id === 'a1' ? 'Homework Helper' : 'Soccer Schedule' }), v2ColorFor: () => '#5a7fd6',
      v2RenderSwatches() {}, v2IconPreview() {},
    });
    c.openV2Icon('a1');
    $('v2IconInput').value = '🐣';
    const g = gate<unknown>();
    c.api = async (url: string, init: { method?: string; body?: unknown } = {}) => { calls.push({ url, ...init }); return g.p; };
    const saving = c.v2IconSave(element());
    dlg.close();
    c.openV2Icon('a2');
    $('v2IconInput').value = '🏡';
    g.open({});
    await saving;
    expect(calls.map((x) => [x.url, x.body.icon])).toEqual([['/v1/agents/a1', '🐣']]);
    expect(dlg.open).toBe(true);
    expect(c.v2IconFor).toBe('a2');
  });

  it("a save that ends after the dialog was opened again leaves that opening's Save button as it is", async () => {
    const dlg = element();
    const { c, $, calls } = page(['openV2Icon', 'v2IconSave'], {
      v2IconFor: null, v2IconColor: null, v2IconGen: 0, v2IconIdeasShown: [], v2IconDlg: dlg, V2_EMOJI: [],
      v2Find: (id: string) => ({ id, name: id === 'a1' ? 'Homework Helper' : 'Soccer Schedule' }), v2ColorFor: () => '#5a7fd6',
      v2RenderSwatches() {}, v2IconPreview() {},
    });
    const btn = $('v2IconSaveBtn');
    const [one, two] = [gate<unknown>(), gate<unknown>()];
    c.api = async (url: string, init: { method?: string; body?: unknown } = {}) => { calls.push({ url, ...init }); return (calls.length === 1 ? one : two).p; };
    c.openV2Icon('a1');
    const first = c.v2IconSave(btn);
    expect(btn.disabled).toBe(true);
    dlg.close();
    c.openV2Icon('a2');
    expect(btn.disabled).toBe(false);
    const second = c.v2IconSave(btn);
    one.open({});
    await first;
    expect(btn.disabled).toBe(true);
    two.open({});
    await second;
    expect(btn.disabled).toBe(false);
    expect(calls.map((x) => x.url)).toEqual(['/v1/agents/a1', '/v1/agents/a2']);
  });

  it('still closes its own opening when the save ends', async () => {
    const dlg = element();
    const { c, $ } = page(['openV2Icon', 'v2IconSave'], {
      v2IconFor: null, v2IconColor: null, v2IconGen: 0, v2IconIdeasShown: [], v2IconDlg: dlg, V2_EMOJI: [],
      v2Find: (id: string) => ({ id, name: 'Homework Helper' }), v2ColorFor: () => '#5a7fd6', v2RenderSwatches() {}, v2IconPreview() {},
    });
    c.openV2Icon('a1');
    $('v2IconInput').value = '🐣';
    await c.v2IconSave(element());
    expect(dlg.open).toBe(false);
  });
});

describe('Settings → Backups: the restore drill line (HB-0353)', () => {
  const LAST = { at: '2026-10-05T05:20:00Z', set: '2026-10-05', passed: true, checked: 3, restored: 3, failed: 0, database: 'ok', key: 'ok' };
  const draw = (d: unknown) => {
    const { c, $ } = page(['renderDrillRun'], { bkDrillTimer: null });
    c.renderDrillRun(d);
    return $('bkDrill');
  };
  it('says a newer failed run first, in the warning colour, ahead of the older pass', () => {
    const el = draw({ run: { status: 'error', startedAt: Date.parse('2026-10-09T05:10:00Z'), summary: 'Restoring 3 volumes\nThe newest backup could not be read' }, last: LAST });
    expect(el.textContent).toMatch(/^The latest restore drill failed: The newest backup could not be read\. Before it: Last drill 2026-10-05 on the 2026-10-05 backup: passed/);
    expect(el.style.color).toBe('var(--warn)');
  });
  it('a failed run whose own record was written is told by that record alone', () => {
    const el = draw({ run: { status: 'error', startedAt: Date.parse('2026-10-05T05:00:00Z'), summary: 'Restore drill failed (exit 1).' }, last: { ...LAST, passed: false, failed: 1 } });
    expect(el.textContent).toMatch(/^Last drill 2026-10-05 on the 2026-10-05 backup: failed/);
    expect(el.textContent).not.toContain('exit 1');
    expect(el.style.color).toBe('var(--warn)');
  });
  it('a pass with no failed run after it reads as before', () => {
    const el = draw({ run: { status: 'idle' }, last: LAST });
    expect(el.textContent).toMatch(/^Last drill 2026-10-05/);
    expect(el.style.color).toBe('');
  });
  it('a failed run with no drill before it says why, in the warning colour', () => {
    const el = draw({ run: { status: 'error', startedAt: 1, summary: 'Couldn\'t run the restore drill: spawn bash ENOENT' } });
    expect(el.textContent).toBe("No restore drill has run yet. Automatic drills are off. Couldn't run the restore drill: spawn bash ENOENT");
    expect(el.style.color).toBe('var(--warn)');
  });
});
