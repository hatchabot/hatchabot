#!/usr/bin/env node
/**
 * Click-through tests of the REAL web/index.html in headless Chrome, driven
 * by the screenshots' stubbed fleet (docs/deck/shot-data.mjs) plus a recorder
 * that remembers every request the page makes and answers mutations. Each
 * scenario does what a person does — presses, drags, opens — and asserts what
 * the page shows and what it asked the server for. Three of one week's five
 * UI reports were in paths no test touched (drag, the bulk bolt, the group
 * arrows, the schedule edit; 30th audit): this is the gate for those.
 *
 *   node scripts/ui-clickthrough.mjs           # all scenarios; exit 1 on a failure
 *   node scripts/ui-clickthrough.mjs --keep    # keep the work dir (the page + Chrome's DOM dump)
 *
 * Needs docker or podman (headless Chrome runs in a throwaway container, as
 * the screenshots do); CONTAINER_CLI=podman picks podman, as the dev repo's
 * own runners do (rootless, no docker there). Results travel out of the page as a data attribute on
 * <html>, read from Chrome's --dump-dom.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUB } from '../docs/deck/shot-data.mjs';

// Headless Chrome, pinned to a digest so CI runs the image it was reviewed with
// (#46, 2026-10-09). ci.yml pulls the same one; test/workflowPins.test.ts checks
// they agree. Bumping it: docs/releasing.md, "Updating pinned actions and images".
// Fully qualified: podman refuses a short name it would have to guess the registry of.
const CHROME_IMAGE = 'docker.io/zenika/alpine-chrome@sha256:eb3378c1ed0079f94db054a5fe1aaa790a254ec0d6bbc67eda052420d86a179d';
const CONTAINER_CLI = process.env.CONTAINER_CLI || 'docker';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const icon = `data:image/png;base64,${readFileSync(join(root, 'web', 'icons', 'icon-192.png')).toString('base64')}`;
const page = readFileSync(join(root, 'web', 'index.html'), 'utf8').replaceAll('src="/icons/icon-192.png"', `src="${icon}"`);
// The invite page, for the scenarios that open it in a frame; as JSON with no "<" so it cannot end the <script> it sits in.
const joinPage = JSON.stringify(readFileSync(join(root, 'web', 'join.html'), 'utf8')).replaceAll('<', '\\u003c');

/** Wraps the stub's fetch: records every call, lets a scenario override any GET, answers mutations. */
const RECORDER = `(() => {
  const stubFetch = window.fetch;
  window.__calls = []; window.__override = {}; window.__confirms = []; window.__confirmAnswer = true; window.__movedResult = true;
  window.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const path = url.split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    let body; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    window.__calls.push({ method, path, url, body, headers: init.headers || {} });
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    // Scripted answers: window.__answer['POST /v1/x'] = [{ status, body }, …], taken in order.
    const q = (window.__answer || {})[method + ' ' + path];
    // { reject: 'Failed to fetch' }: the request never reached the server (fetch rejects).
    if (q && q.length) { const a = q.shift(); if (a.reject) throw new TypeError(a.reject); return json(a.body ?? {}, a.status ?? 200); }
    if (method === 'GET') {
      if (path in window.__override) return json(window.__override[path]);
      if (/\\/crons$/.test(path)) return json({ crons: window.__crons || [] });
      return stubFetch(input, init);
    }
    if (/\\/move$/.test(path) && /\\/agents\\//.test(path)) return json({ ok: true, group: body?.group ?? '' });
    if (path === '/v1/groups/move') return json({ ok: true, moved: window.__movedResult });
    if (/\\/agents\\/[^/]+$/.test(path) && method === 'PATCH') return json({ ok: true, ...body });
    return json({ ok: true });
  };
  window.confirm = (text) => { window.__confirms.push(text); return window.__confirmAnswer; };
  window.prompt = () => window.__promptAnswer ?? null;
  window.alert = () => {};
  // Headless Chrome under virtual time draws no frames (2026-11-08): no requestAnimationFrame callback
  // runs and no ResizeObserver reports. window.__frame() stands in for one, in a browser's order: the
  // frame callbacks waiting run, then each ResizeObserver hears of the boxes it watches whose size has
  // changed (all of them, the first time), with the page's own callback.
  const nativeFrame = window.requestAnimationFrame.bind(window), NativeRO = window.ResizeObserver, waiting = new Map();
  let frames = 0;
  window.requestAnimationFrame = (f) => { const id = ++frames, run = (at) => { if (waiting.delete(id)) f(at); }; waiting.set(id, run); nativeFrame(run); return id; };
  window.cancelAnimationFrame = (id) => { waiting.delete(id); };
  const watchers = [];
  if (NativeRO) window.ResizeObserver = class extends NativeRO {
    constructor(cb) { super(cb); this.cb = cb; this.sizes = new Map(); watchers.push(this); }
    observe(el, o) { super.observe(el, o); if (!this.sizes.has(el)) this.sizes.set(el, null); }
    unobserve(el) { super.unobserve(el); this.sizes.delete(el); }
    disconnect() { super.disconnect(); this.sizes.clear(); }
  };
  window.__frame = () => {
    for (const run of [...waiting.values()]) run(performance.now());
    for (const o of watchers) {
      const entries = [];
      for (const [el, was] of o.sizes) {
        const cs = getComputedStyle(el), px = (k) => parseFloat(cs[k]) || 0;
        const w = Math.max(0, el.clientWidth - px('paddingLeft') - px('paddingRight')), h = Math.max(0, el.clientHeight - px('paddingTop') - px('paddingBottom'));
        if (w + 'x' + h === was) continue;
        o.sizes.set(el, w + 'x' + h);
        entries.push({ target: el, contentRect: new DOMRectReadOnly(0, 0, w, h) });
      }
      if (entries.length) o.cb(entries, o);
    }
  };
})();`;

/** The scenarios run inside the page once it has painted. Each is a name and an async body; \`t\` is the toolkit. */
const SCENARIOS = String.raw`(() => {
  const results = [];
  // Checks refresh by hand; a timed poll mid-check made the suite flaky under load.
  window.__noAutoPoll = true; clearTimeout(pollTimer);
  // A reload would end the check: another account signing in reloads the page (HB-0491), so the page's own is counted instead.
  window.__reloads = 0; pageReload = () => { window.__reloads++; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 8 s: a condition that holds returns at once; a slow run of headless Chrome
  // (it happens) used to fail checks that were only late.
  // The setup form opens once the file's first bytes are read — real work, during which virtual
  // time can jump by minutes (2026-10-23): no deadline, the dialog's open attribute is observed.
  const formOpened = () => new Promise((r) => { if (paramFormDlg.open) return r(); const o = new MutationObserver(() => { if (paramFormDlg.open) { o.disconnect(); r(); } }); o.observe(paramFormDlg, { attributes: true, attributeFilter: ['open'] }); });
  const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(50); } throw new Error('timed out waiting for ' + String(f).replace(/\s+/g, ' ').slice(0, 160)); };
  const calls = (method, re) => window.__calls.filter((c) => c.method === method && re.test(c.path));
  const eq = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(what + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); };
  const ok = (what, cond) => { if (!cond) throw new Error(what); };
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim().includes(text));
  const tile = (name) => [...document.querySelectorAll('#v2groups .v2agent')].find((el) => el.textContent.includes(name));
  const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const pointer = (type, target, x, y) => target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, bubbles: true, cancelable: true }));
  const T = {
    classicMap: async () => {
      // v2.155.0: the classic look is gone. This page was opened with hb-ui=classic stored and
      // ?ui=classic in its address (the head below), as a browser that had chosen classic would be.
      const map = document.getElementById('v2ClassicMap');
      ok('the one-time map is shown', !!map && !map.hidden && map.textContent.includes('The classic look is gone'));
      ok('it says where the card buttons went', ['Sharing', 'Advanced', 'Overview → Checks', 'Check all', 'Planned'].every((w) => map.textContent.includes(w)));
      eq('the stored choice is cleared', localStorage.getItem('hb-ui'), null);
      ok('?ui=classic is gone from the address: ' + location.search, !/[?&]ui=/.test(location.search));
      ok('the account menu has no Classic look', !byText('#v2AcctPop button', 'Classic look'));
      ok('no classic header, cards or legend', !document.getElementById('toc') && !document.getElementById('agents') && !document.getElementById('themeToggle') && !document.getElementById('activityCard'));
      eq('the next load shows no map (nothing stored)', takeClassicChoice(), false);
      // A ?ui= in a bookmark is dropped, the rest of the address kept; 'v2' is not a reason for the map either.
      const prev = location.pathname + location.search + location.hash;
      try {
        localStorage.setItem('hb-ui', 'v2');
        history.replaceState(null, '', location.pathname + '?ui=classic&keep=1#keep');
        eq('?ui=classic in an address alone shows no map', takeClassicChoice(), false);
        eq('the rest of the address stays', [location.search, location.hash], ['?keep=1', '#keep']);
        eq('any stored look is cleared', localStorage.getItem('hb-ui'), null);
      } finally { history.replaceState(null, '', prev); }
      byText('#v2ClassicMap button', 'Got it').click();
      ok('Got it puts it away', map.hidden);
      ok('the keyboard stays on the home screen: ' + document.activeElement?.outerHTML.slice(0, 80), document.getElementById('v2home').contains(document.activeElement) && !map.contains(document.activeElement));
    },
    home: async () => {
      const tiles = document.querySelectorAll('#v2groups .v2agent');
      ok('tiles rendered: ' + tiles.length, tiles.length === 14);
      ok('the manager is the first, fixed tile', tiles[0].dataset.v2fixed && tiles[0].textContent.includes('Hatchabot'));
      ok('no hub box with a manager', document.querySelector('.v2hub').hidden);
      const header = document.querySelector('#v2Header .v2hubactions');
      ok('the actions sit in the header', !!header);
      eq('header buttons', [...header.querySelectorAll('button:not([hidden])')].map((b) => b.getAttribute('aria-label')), ['Consoles', 'Usage', 'Resources', 'Bulk actions', 'Settings', 'New agent']);
      ok('symbol only: the label is hidden', getComputedStyle(header.querySelector('.lbl')).display === 'none');
    },
    homeFoot: async () => {
      // The foot of the home screen (Status retired, 2026-10-05): Activity, then the machine line (made-up data).
      const now = Date.now(), iso = (m) => new Date(now - m * 60000).toISOString();
      window.__override['/v1/events'] = [
        { id: 2, agentId: 'a1', agentName: 'Homework Helper', at: iso(5), event: 'agent.rebuilt', detail: {} },
        { id: 1, agentId: 'a2', agentName: 'Soccer Schedule', at: iso(50), event: 'provision.failed', detail: {} },
        // A machine's own operation (v2.155.0): no agent; the server says it in words.
        { agentId: null, agentName: 'Laptop runner', at: iso(70), event: 'op.failed', detail: { kind: 'install-image' }, label: 'Image install: failed: The image copy was interrupted by a restart — install it again.' },
      ];
      window.__override['/v1/hosts'] = [
        { id: 'h1', name: 'This machine', kind: 'local', hostname: 'home-box', agentCount: 12 },
        { id: 'h2', name: 'Laptop runner', kind: 'cloud', agentCount: 2, reachable: false },
      ];
      // A newer set made by another install (or under an earlier key) first: this install's own, 5 days old, is what the line judges.
      window.__override['/v1/backups'] = { backups: [{ date: new Date(now).toISOString().slice(0, 10), hasKey: true, complete: true, foreign: true },
        { date: new Date(now - 5 * 864e5).toISOString().slice(0, 10), hasKey: true, complete: true }], keepDays: 14, missing: [] };
      window.__override['/v1/runtime'] = { imageVersion: '2026.9.6', upgradeAvailable: false };
      const owner = myAccount.hostOwner; myAccount.hostOwner = true;
      try {
        const asked = window.__calls.length;
        await v2LoadActivity(true); await v2LoadMachine(true);
        const sets = window.__calls.slice(asked).filter((c) => c.path === '/v1/backups').map((c) => c.url);
        ok('the machine line asks for the newest set only, not every set (fourteenth review): ' + sets.join(' '), sets.length >= 1 && sets.every((u) => u.endsWith('/v1/backups?latest=1')));
        const act = document.getElementById('v2Activity');
        ok('an Activity section at the foot', !act.hidden && act.textContent.includes('Homework Helper') && act.textContent.includes('Soccer Schedule'));
        ok('below the agents', document.getElementById('v2groups').compareDocumentPosition(act) & Node.DOCUMENT_POSITION_FOLLOWING);
        ok('a failure in red', !!act.querySelector('.v2actrow .bad'));
        ok("a machine's operation reads in words, not its event name: " + act.textContent.slice(0, 300),
          act.textContent.includes('Laptop runner') && act.textContent.includes('Image install: failed: The image copy was interrupted') && !act.textContent.includes('op failed'));
        byText('#v2Activity button', 'See all').click();
        await until(() => auditDlg.open); ok('See all opens the full log', auditDlg.open); auditDlg.close();
        byText('#v2Activity button', 'Hide').click();
        ok('it folds', document.getElementById('v2ActList').hidden && byText('#v2Activity button', 'Show'));
        byText('#v2Activity button', 'Show').click();
        const line = document.getElementById('v2Machine');
        ok('the machine line: ' + line.textContent, !line.hidden && line.textContent.includes('home-box · 12 agents') && line.textContent.includes('Laptop runner · 2 agents · not answering') && line.textContent.includes('OpenClaw 2026.9.6'));
        ok('late backups said', line.textContent.includes('the latest is 5 days old'));
        const tip = tipText('Hatchabot');
        ok('the Hatchabot agent carries the machine\'s alerts: ' + tip.slice(0, 200), tip.includes("Laptop runner isn't answering") && tip.includes('backups: the latest is 5 days old'));
      } finally {
        myAccount.hostOwner = owner;
        for (const k of ['/v1/events', '/v1/hosts', '/v1/backups', '/v1/runtime']) delete window.__override[k];
        try { localStorage.removeItem('hb-activity-folded'); } catch {}
        v2Machine = null; v2PaintMachine(); await refresh(false);
      }
    },
    sourceCosts: async () => {
      // Settings → AI (Chris, 2026-10-07): each paid source has Usage's chart for the agents on it, with a By agent pie (made-up figures).
      const now = Date.now(), H = 3600e3;
      window.__override['/v1/usage/spend'] = { range: 'week', bucketHours: 3, planShare: 1, monthly: 400, models: [{ model: 'claude-sonnet-5', cost: 80 }],
        choices: [{ id: 'a1', name: 'Homework Helper', cost: 60 }, { id: 'a2', name: 'Soccer Schedule', cost: 20 }, { id: 'a3', name: 'Piano Practice', cost: 0 }],
        buckets: Array.from({ length: 56 }, (_, i) => ({ at: new Date(now - (56 - i) * 3 * H).toISOString(), cacheWrite: 1, cacheRead: 0.2, output: 0.2, input: 0.03, tokens: 2e6, ...(i === 50 ? { refused: 4 } : {}) })),
        totals: { cacheWrite: 56, cacheRead: 11, output: 11, input: 2, cost: 80, tokens: 112e6 }, refused: 4 };
      try {
        openAiDlg('ai');
        const box = await until(() => document.querySelector('#aiList .srcspend .spendchart svg') && document.querySelector('#aiList .srcspend'));
        const p = profiles.find((x) => x.vendor !== 'local');
        ok('a paid source has its costs, open', !!box.open && box.textContent.includes('agents on this source now'));
        const call = window.__calls.filter((c) => c.path === '/v1/usage/spend').at(-1);
        ok('asked for that source: ' + call.url, call.url.includes('source='));
        ok('the pies, By agent among them, and the chart', box.textContent.includes('What it went on') && box.textContent.includes('By model') && box.textContent.includes('By agent'));
        ok('an agent that spent nothing is not a slice', !box.textContent.includes('Piano Practice'));
        ok('the plan footnote', box.textContent.includes('not money you pay'));
        ok('no agent picker on a source', !box.querySelector('.spendpick'));
        ok('no separate requests chart any more (Chris, 2026-10-07)', !document.getElementById('aiList').textContent.includes('Requests per'));
        ok('refusals shade their slice of the costs chart, counted in its key', box.querySelectorAll('svg rect[fill-opacity=".22"]').length === 1 && box.textContent.includes('shaded: 4 calls refused'));
        ok('the request counts are gone too (2026-10-07)', !document.getElementById('aiList').textContent.includes('Most use') && !document.getElementById('aiList').textContent.includes('Last 5 h'));
        ok('and the agents-by-model summary line (the By agent pie says who)', !/\d+ agents? · \d+×/.test(document.getElementById('aiList').textContent));
        const local = profiles.find((x) => x.vendor === 'local');
        if (local) ok('a local model server has no costs box', ![...document.querySelectorAll('#aiList .srcspend .spendchart')].some((el) => el.dataset.source === local.id));
        box.open = false; box.dispatchEvent(new Event('toggle'));
        ok('folding is remembered', localStorage.getItem('hb-src-spend-folded:' + box.querySelector('.spendchart').dataset.source) === '1');
      } finally {
        delete window.__override['/v1/usage/spend'];
        for (const k of Object.keys(localStorage)) if (k.startsWith('hb-src-spend-folded:')) localStorage.removeItem(k);
        aiDlg.close();
      }
    },
    modelListsSorted: async () => {
      // Settings → AI: every model list reads alphabetically, numbers as numbers (Chris, 2026-10-07).
      const sorted = (xs) => xs.every((x, i) => i === 0 || xs[i - 1].localeCompare(x, 'en', { numeric: true }) <= 0);
      $('aiKind').value = 'subscription'; aiKindChanged();
      const add = [...$('aiModelSelect').options].map((o) => o.value).filter((v) => v !== '__other');
      ok('the new-source dropdown is sorted: ' + add.join(' '), add.length > 5 && sorted(add));
      const p = profiles.find((x) => x.mine !== false);
      ok('the stub has a source of mine to check', !!p);
      {
        const saved = { avail: availableModels[p.id], model: p.model, models: p.models };
        availableModels[p.id] = ['claude-sonnet-5', 'claude-opus-4-10', 'claude-haiku-4-5', 'claude-opus-4-8', 'claude-fable-5-1'];
        p.model = 'claude-sonnet-5'; p.models = ['claude-opus-4-10', 'claude-fable-5-1'];
        try {
          renderAiList();
          const dflt = [...$('aiModel-' + p.id).options].map((o) => o.value);
          ok('the default-model dropdown is sorted: ' + dflt.join(' '), sorted(dflt) && dflt.indexOf('claude-opus-4-8') < dflt.indexOf('claude-opus-4-10'));
          const pills = [...$('aiExtras-' + p.id).querySelectorAll('[data-remove]')].map((b) => b.dataset.remove);
          eq('the switchable pills are sorted', pills, ['claude-fable-5-1', 'claude-opus-4-10']);
          const adder = [...$('aiExtras-' + p.id).querySelectorAll('select[data-add] option')].map((o) => o.value).filter(Boolean);
          eq('and so is the add-a-model list', adder, ['claude-haiku-4-5', 'claude-opus-4-8']);
        } finally { availableModels[p.id] = saved.avail; p.model = saved.model; p.models = saved.models; renderAiList(); }
      }
    },
    reportProblem: async () => {
      // Report a problem (made-up data): from the account menu, a person's draft, read through,
      // edited, then GitHub opened in a new tab; and the agent's link opens its draft.
      const id = '0f9e8d7c-1111-4222-8333-444455556666', draftId = 'aa11bb22-3333-4444-8555-666677778888';
      const view = (o) => ({ id, title: 'Rebuild fails', body: '<!-- hatchabot-report v1 version=v9.9.9 install=git -->\n\n### What happened\nIt failed.', createdAt: new Date().toISOString(), by: 'person',
        issueUrl: 'https://github.com/hatchabot/hatchabot/issues/new?labels=field-report&title=Rebuild%20fails&body=x', trimmed: false, fileName: 'hatchabot-report-x.md', reviewPath: '/#report=' + id, ...o });
      window.__override['/v1/problem-reports'] = [{ id: draftId, title: 'Telegram replies stop', createdAt: new Date().toISOString(), by: 'agent' }];
      const opened = []; const realOpen = window.open;
      window.open = () => { const w = { opener: 1, location: { href: 'about:blank' }, close() {} }; opened.push(w); return w; };
      try {
        // Found from the foot of the home screen too (the account menu alone was not found, 2026-10-06).
        $('v2ReportLink').click();
        await until(() => reportDlg.open);
        ok('the home screen link opens it', reportDlg.open);
        reportDlg.close();
        v2ToggleAccount();
        byText('#v2AcctPop button', 'Report a problem').click();
        await until(() => reportDlg.open);
        await until(() => byText('#reportDrafts button', 'Telegram replies stop'));
        ok("the agent's draft is listed as its", byText('#reportDrafts button', 'Telegram replies stop').textContent.includes('by your Hatchabot agent'));
        byText('#reportForm button', 'Gather the details').click();
        ok('nothing is sent without a title and what happened', !calls('POST', /^\/v1\/problem-reports$/).length);
        $('reportTitle').value = 'Rebuild fails'; $('reportWhat').value = 'It failed.';
        window.__answer = { 'POST /v1/problem-reports': [{ body: view({}) }], ['PATCH /v1/problem-reports/' + id]: [{ body: view({ body: 'edited' }) }] };
        byText('#reportForm button', 'Gather the details').click();
        await until(() => !$('reportReview').hidden);
        eq('what was asked for', calls('POST', /^\/v1\/problem-reports$/).at(-1).body, { title: 'Rebuild fails', whatHappened: 'It failed.' });
        ok('the whole issue is shown to read', $('reportBody').value.includes('### What happened'));
        ok('it says it will be public', $('reportReviewNote').textContent.includes('public'));
        ok('it says what is masked, as the masking does it (HB-0405)', /IP and MAC addresses/.test($('reportReviewNote').textContent) && /machines\u2019? ?'? ?names and addresses/.test($('reportReviewNote').textContent) && /system folders like \/usr stay, as far as nothing in them looks like yours/.test($('reportReviewNote').textContent));
        ok('it says masking cannot make free text safe, and what is left to the person (HB-0405)', /Read every line/.test($('reportReviewNote').textContent) && /no automatic masking/.test($('reportReviewNote').textContent) && /Not masked: a person, place or machine/.test($('reportReviewNote').textContent));
        $('reportBody').value = 'edited';
        byText('#reportReview button', 'Open on GitHub').click();
        await until(() => calls('POST', /\/sent$/).length);
        eq('the edit is saved before anything leaves', calls('PATCH', /^\/v1\/problem-reports\//).at(-1).body, { title: 'Rebuild fails', body: 'edited' });
        ok('GitHub opened in a new tab, without a way back to this page', opened.length === 1 && opened[0].location.href.startsWith('https://github.com/hatchabot/hatchabot/issues/new') && opened[0].opener === null);
        // An edit the server masks (a private name): the review shows what will go out, not what was typed.
        window.__answer = { ['PATCH /v1/problem-reports/' + id]: [{ body: view({ body: 'The {name} agent failed' }) }] };
        $('reportBody').value = 'The Meal Planner agent failed';
        const before = calls('PATCH', /^\/v1\/problem-reports\//).length;
        byText('#reportReview button', 'Open on GitHub').click();
        await until(() => calls('PATCH', /^\/v1\/problem-reports\//).length > before);
        await until(() => $('reportBody').value === 'The {name} agent failed');
        ok('the masked text is what the review shows', true);
        reportDlg.close();
        // The agent's link: …/#report=<id> opens that draft and leaves the address bar.
        window.__override['/v1/problem-reports/' + draftId] = view({ id: draftId, title: 'Telegram replies stop', by: 'agent', known: [{ title: 'Telegram replies stop after a long turn', fixedIn: 'v9.9.0' }] });
        location.hash = '#report=' + draftId;
        await until(() => reportDlg.open && !$('reportReview').hidden);
        ok("the agent's draft opens, marked as the agent's", $('reportRTitle').value === 'Telegram replies stop' && $('reportReviewNote').textContent.includes('Your Hatchabot agent wrote this'));
        ok('the link is gone from the address bar', !location.hash.includes('report='));
        ok('a known problem is flagged before anything is filed', !$('reportKnown').hidden && $('reportKnown').textContent.includes('Telegram replies stop after a long turn') && $('reportKnown').textContent.includes('v9.9.0'));
        // Discard asks first; declined, nothing is deleted (review, 2026-10-09).
        const dels = () => calls('DELETE', /^\/v1\/problem-reports\//).length, d0 = dels();
        window.__confirmAnswer = false;
        byText('#reportReview button', 'Discard').click(); await sleep(100);
        ok('it asked: ' + window.__confirms.at(-1), (window.__confirms.at(-1) || '').includes('Discard the draft'));
        eq('declined: kept', dels() - d0, 0);
        ok('and still shown', !$('reportReview').hidden);
        window.__confirmAnswer = true;
        byText('#reportReview button', 'Discard').click();
        await until(() => dels() - d0 === 1);
      } finally {
        window.open = realOpen; window.__answer = {}; window.__confirmAnswer = true;
        delete window.__override['/v1/problem-reports']; delete window.__override['/v1/problem-reports/' + draftId];
        if (reportDlg.open) reportDlg.close();
      }
    },
    backupNotCovered: async () => {
      // An agent left out of the nightly set (made-up data): named on the manager's
      // tile, and a Clear holds across nights while the same agents are left out
      // (it came back every morning, 2026-10-06).
      const day = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
      const garden = { agentId: 'b1', name: 'Garden Planner', host: 'Laptop runner' };
      window.__override['/v1/hosts'] = [{ id: 'h1', name: 'This machine', kind: 'local', hostname: 'home-box', agentCount: 12 }];
      window.__override['/v1/runtime'] = { imageVersion: '2026.9.6', upgradeAvailable: false };
      const set = (date, missing) => { window.__override['/v1/backups'] = { backups: [{ date, hasKey: true, complete: true }], keepDays: 14, missing }; };
      const owner = myAccount.hostOwner; myAccount.hostOwner = true;
      const mgr = agents.find((a) => a.ops);
      try {
        set(day(1), [garden]); await v2LoadMachine(true); renderV2();
        const tip = tipText(mgr.name);
        ok('the left-out agent is named: ' + tip.slice(0, 160), tip.includes('backups: Garden Planner (on Laptop runner) not in it'));
        ok('flagged Worth a look', v2Status(mgr).label === 'Worth a look');
        mgr.attentionAck = attentionFingerprint(mgr);
        set(day(0), [garden]); await v2LoadMachine(true);
        ok('cleared stays cleared the next night', attentionCleared(mgr) && v2Status(mgr).label !== 'Worth a look');
        set(day(0), [garden, { agentId: 'b2', name: 'Recipe Box', host: 'Laptop runner' }]); await v2LoadMachine(true);
        ok('a newly left-out agent brings it back', !attentionCleared(mgr));
      } finally {
        mgr.attentionAck = undefined; myAccount.hostOwner = owner;
        for (const k of ['/v1/hosts', '/v1/backups', '/v1/runtime']) delete window.__override[k];
        v2Machine = null; v2PaintMachine(); await refresh(false);
      }
    },
    viewBy: async () => {
      const btn = byText('button', 'Alerts');
      ok('a "Alerts" view button', !!btn);
      btn.click(); await sleep(100);
      ok('the view switched', v2View !== 'group');
      byText('button', 'Groups').click(); await sleep(100);
      ok('back to Groups', v2View === 'group');
    },
    dragToGroup: async () => {
      const from = tile('Homework Helper'); ok('Homework Helper tile', !!from);
      const money = document.querySelector('.v2grid[data-v2drop="Money"]'); ok('Money grid', !!money);
      const p = centre(from), q = centre(money);
      pointer('pointerdown', from, p.x, p.y);
      pointer('pointermove', window, p.x + 12, p.y + 12);
      ok('the drag is live', document.body.classList.contains('v2dragging'));
      ok('the new-group strip is offered while dragging', document.getElementById('v2NewGroup') && !document.getElementById('v2NewGroup').hidden);
      pointer('pointermove', window, q.x, q.y);
      ok('the Money grid lights up', money.classList.contains('drop'));
      pointer('pointerup', window, q.x, q.y);
      const move = await until(() => calls('POST', /\/v1\/agents\/a1\/move$/)[0]);
      eq('the drop asked for the move', move.body, { before: null, group: 'Money' });
    },
    groupArrows: async () => {
      const family = byText('#v2groups .v2ghead', 'Family');
      ok('Family header', !!family);
      family.querySelector('button[aria-label="Move group down"]').click();
      const mv = await until(() => calls('POST', /\/v1\/groups\/move$/)[0]);
      eq('move down', mv.body, { group: 'Family', dir: 'down' });
      window.__movedResult = false;
      family.querySelector('button[aria-label="Move group up"]').click();
      await until(() => document.getElementById('toast').textContent.includes('already the top group'));
      window.__movedResult = true;
    },
    bulkBolt: async () => {
      const household = byText('#v2groups .v2ghead', 'Household');
      const bolt = [...household.querySelectorAll('button')].find((b) => (b.getAttribute('onclick') || '').includes('v2BulkSection'));
      ok('the bolt on Household', !!bolt);
      bolt.click();
      await until(() => fleetActionsDlg.open);
      // The list renders after the classes fetch; the preset is ticked then.
      const ticked = await until(() => [...document.querySelectorAll('.faCb')].filter((cb) => cb.checked).length);
      ok('the group is pre-ticked: ' + ticked, ticked === 6);
      fleetActionsDlg.close();
    },
    wakeAndSleep: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const tax = list.find((a) => a.name === 'Tax Filing');
      window.__override['/v1/agents'] = list.map((a) => a.id === tax.id ? { ...a, hibernatedAt: new Date().toISOString() } : a);
      await refresh(false);
      openV2Agent(tax.id);
      const wake = await until(() => byText('#v2AgentBar button', 'Wake'));
      wake.click();
      await until(() => calls('POST', new RegExp('/v1/agents/' + tax.id + '/wake$'))[0]);
      v2Close();
      openV2Agent('a1');
      const sleepBtn = await until(() => byText('#v2AgentBar button', 'Sleep'));
      sleepBtn.click();
      await until(() => calls('POST', /\/v1\/agents\/a1\/hibernate$/)[0]);
      v2Close();
      delete window.__override['/v1/agents'];
      await refresh(false);
    },
    // Archiving from its page with its console open: both close, so the next click
    // can't land on Restore where Chat was (2026-10-07: restored 12 min after archiving).
    // Archive and Delete are everyday actions: at the foot of the Overview, not under Advanced (Chris, 2026-10-12).
    archiveDeleteOnOverview: async () => {
      try {
        openV2Agent('a1', 'overview');
        await until(() => byText('#v2AgentDlg .v2danger', 'Archive or delete'));
        ok('Overview has Archive and Delete', !!byText('#v2AgentDlg .v2danger button', 'Archive') && !!byText('#v2AgentDlg .v2danger button', 'Delete'));
        openV2Agent('a1', 'advanced');
        await until(() => document.getElementById('v2AgentDlg').open && !byText('#v2AgentDlg .v2tab.on, #v2Tabs button.on', 'Overview'));
        await sleep(100);
        ok('Advanced no longer has them', !byText('#v2AgentDlg .v2danger', 'Archive') && !byText('#v2AgentDlg button', 'Delete…'));
      } finally { v2Close(); }
    },
    archiveClosesItsConsole: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const hw = list.find((a) => a.id === 'a1');
      try {
        consoleTabs.push({ id: 'a1', slug: hw.slug, frame: null, url: null });
        openV2Agent('a1', 'overview');
        await until(() => document.getElementById('v2AgentDlg').open);
        window.__answer = window.__answer || {};
        window.__answer['POST /v1/agents/a1/archive'] = [{ status: 200, body: { ...hw, state: 'ARCHIVED' } }];
        archiveAgent('a1', hw.name, 'RUNNING');
        await until(() => archiveDlg.open);
        window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, state: 'ARCHIVED' } : a);
        document.getElementById('archiveBtn').click();
        await until(() => calls('POST', /\/v1\/agents\/a1\/archive$/).length > 0);
        await until(() => !consoleTabs.some((t) => t.id === 'a1'));
        ok('its console tab closed', !consoleTabs.some((t) => t.id === 'a1'));
        await until(() => !document.getElementById('v2AgentDlg').open);
        ok('its page closed', !document.getElementById('v2AgentDlg').open);
        openV2Agent('a1');
        await until(() => byText('#v2AgentBar button', 'Restore'));
        const restore = byText('#v2AgentBar button', 'Restore');
        ok('on an archived page Restore is an ordinary button, not the gold one', !restore.classList.contains('primary'));
        ok('and nothing gold sits where Chat was', !document.querySelector('#v2AgentBar button.primary'));
        v2Close();
      } finally {
        if (window.__answer) delete window.__answer['POST /v1/agents/a1/archive'];
        delete window.__override['/v1/agents'];
        await refresh(false);
      }
    },
    archiveShowsAtOnce: async () => {
      // The checkpoint turn takes ~20 s before the state changes; the tile used
      // to look untouched, as if the click had failed (2026-10-07). The POST is
      // held open here so the check runs while the server is still "saving".
      const list = await (await fetch('/v1/agents')).json();
      const hw = list.find((a) => a.id === 'a1');
      let release; const held = new Promise((r) => { release = r; });
      const realFetch = window.fetch;
      window.fetch = async (input, init = {}) => {
        const path = String(typeof input === 'string' ? input : input.url).split('?')[0];
        if ((init.method || '').toUpperCase() === 'POST' && path === '/v1/agents/a1/archive') {
          window.__calls.push({ method: 'POST', path, body: JSON.parse(init.body) });
          await held;
          return new Response(JSON.stringify({ ...hw, state: 'ARCHIVED' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return realFetch(input, init);
      };
      try {
        archiveAgent('a1', hw.name, 'RUNNING');
        await until(() => archiveDlg.open);
        ok('the checkpoint is offered and ticked', document.getElementById('archiveCheckpoint').checked);
        document.getElementById('archiveBtn').click();
        await until(() => !archiveDlg.open);
        await until(() => tile(hw.name) && tile(hw.name).classList.contains('v2st-working'));
        ok('its label says what is happening: ' + tile(hw.name).getAttribute('aria-label'), /Archiving — saving its conversation to memory/.test(tile(hw.name).getAttribute('aria-label')));
        ok('a progress toast', document.getElementById('toast').textContent.includes('saving its conversation to memory first'));
        eq('the checkpoint was asked for', calls('POST', /\/v1\/agents\/a1\/archive$/)[0].body, { checkpoint: true });
        // A poll whose list does not know yet keeps it.
        await refresh(false);
        ok('still archiving after a poll', tile(hw.name).classList.contains('v2st-working'));
        openV2Agent('a1', 'overview');
        await until(() => byText('#v2AgentDlg .v2row', 'Working on'));
        openV2Agent('a1', 'overview');
        await until(() => byText('#v2AgentDlg .v2danger', 'Archiving'));
        ok('no second Archive button meanwhile', !byText('#v2AgentDlg button', 'Archive'));
        v2Close();
        window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, state: 'ARCHIVED' } : a);
        release();
        await until(() => document.getElementById('toast').textContent.includes('archived — its bot is back in the pool'));
        await until(() => !tile(hw.name) || !tile(hw.name).classList.contains('v2st-working'));
      } finally {
        window.fetch = realFetch;
        delete window.__override['/v1/agents'];
        await refresh(false);
      }
    },
    archiveFailsVisibly: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const hw = list.find((a) => a.id === 'a1');
      window.__answer = { 'POST /v1/agents/a1/archive': [{ status: 502, body: { error: "Couldn't archive the agent — try again in a moment." } }] };
      try {
        archiveAgent('a1', hw.name, 'RUNNING');
        await until(() => archiveDlg.open);
        document.getElementById('archiveBtn').click();
        await until(() => document.getElementById('toast').textContent.includes('was not archived'));
        await until(() => tile(hw.name) && !tile(hw.name).classList.contains('v2st-working'));
      } finally { window.__answer = {}; await refresh(false); }
    },
    noBotFreeAlert: async () => {
      // Unarchived with an empty pool: it runs web-only, and Alerts say so (2026-10-07).
      const list = await (await fetch('/v1/agents')).json();
      const hw = list.find((a) => a.id === 'a1');
      window.__override['/v1/agents'] = list.map((a) => a.id === 'a1'
        ? { ...a, webOnly: true, botUsername: undefined, deepLink: undefined, telegramSkipped: { at: new Date().toISOString() } } : a);
      try {
        await refresh(false);
        await until(() => tile(hw.name) && tile(hw.name).classList.contains('v2st-note'));
        openV2Agent('a1', 'overview');
        const why = await until(() => byText('#v2AgentDlg .v2why li', 'No Telegram bot was free'));
        ok('it names where to attach one: ' + why.textContent, why.textContent.includes('Messaging → Telegram'));
        v2Close();
        // The restore question no longer promises a BotFather prompt.
        window.__confirmAnswer = false;
        restoreAgent('a1', hw.name);
        const asked = window.__confirms[window.__confirms.length - 1];
        ok('restore says it comes back web-only: ' + asked.slice(0, 200), asked.includes('comes back without Telegram') && !asked.includes("you'll be asked for a token"));
      } finally {
        window.__confirmAnswer = true;
        delete window.__override['/v1/agents'];
        await refresh(false);
      }
    },
    scheduleEdit: async () => {
      // A task that posts to a member's chat, not the owner's: the edit must not move it.
      window.__crons = [{ id: 'c1', name: 'Morning brief', scheduleExpr: '0 8 * * *', scheduleTz: 'America/Toronto', message: 'Good morning', enabled: false, announce: true, sessionTarget: 'isolated', payloadKind: 'message' }];
      openV2Agent('a1', 'schedule');
      await until(() => cronCache.some((c) => c.id === 'c1'));
      editCronJob('c1');
      eq('the form carries the task', [document.getElementById('cronName').value, document.getElementById('cronExpr').value, document.getElementById('cronMsg').value], ['Morning brief', '0 8 * * *', 'Good morning']);
      ok('the button says Save changes', document.getElementById('cronAddBtn').textContent === 'Save changes');
      const cancelBtn = document.querySelector('#cronEditNote button');
      ok('"cancel" is a real button a keyboard reaches (review, 2026-10-09)', !!cancelBtn && cancelBtn.type === 'button' && cancelBtn.textContent === 'cancel' && !document.querySelector('#cronEditNote a'));
      const mark = window.__calls.length;
      document.getElementById('cronName').value = 'Morning brief 2';
      document.getElementById('cronAddBtn').click();
      const patched = await until(() => window.__calls.slice(mark).find((c) => c.method === 'PATCH' && c.path === '/v1/agents/a1/crons/c1'));
      eq('the edit changes the task in place, sending only what changed (2026-10-10)', patched.body, { name: 'Morning brief 2' });
      await until(() => document.getElementById('cronAddBtn').textContent === 'Add task');
      const after = window.__calls.slice(mark);
      ok('nothing is re-created or deleted (that moved its results to the owner\'s chat)',
        !after.some((c) => (c.method === 'POST' && /\/crons$/.test(c.path)) || c.method === 'DELETE'));
      v2Close(); window.__crons = [];
    },
    scheduleEditClearZone: async () => {
      // Emptying the Timezone box of a zoned task sends a zone: the viewer's
      // ("yours if blank"), or none. It sent nothing and the old zone stayed (HB-0366).
      window.__crons = [{ id: 'c9', name: 'Morning brief', scheduleExpr: '0 8 * * *', scheduleTz: 'Pacific/Chatham', message: 'Good morning', enabled: true, payloadKind: 'agentTurn' }];
      try {
        openV2Agent('a1', 'schedule');
        await until(() => cronCache.some((c) => c.id === 'c9'));
        editCronJob('c9');
        eq('the form carries the zone', document.getElementById('cronTz').value, 'Pacific/Chatham');
        const mark = window.__calls.length;
        document.getElementById('cronTz').value = '';
        document.getElementById('cronAddBtn').click();
        const patched = await until(() => window.__calls.slice(mark).find((c) => c.method === 'PATCH' && c.path === '/v1/agents/a1/crons/c9'));
        let mine = '';
        try { mine = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { mine = ''; }
        eq('the cleared zone is sent', patched.body, { tz: mine });
        await until(() => document.getElementById('cronAddBtn').textContent === 'Add task');
      } finally { cancelCronEdit(); v2Close(); window.__crons = []; }
    },
    scheduleSaveThenSwitch: async () => {
      // A save still waiting when another agent's Schedule tab is opened and one of its tasks
      // is being edited: the save goes to the first agent, and the second edit is left alone (#69).
      const fetchWas = window.fetch;
      let release;
      const gate = new Promise((r) => { release = r; });
      window.fetch = async (input, init = {}) => {
        if ((init.method || '').toUpperCase() === 'PATCH' && /\/crons\//.test(String(input))) await gate;
        return fetchWas(input, init);
      };
      try {
        window.__crons = [{ id: 'c1', name: 'Morning brief', scheduleExpr: '0 8 * * *', message: 'Good morning', enabled: true, payloadKind: 'agentTurn' }];
        openV2Agent('a1', 'schedule');
        await until(() => cronAgentId === 'a1' && cronCache.some((c) => c.id === 'c1'));
        editCronJob('c1');
        const mark = window.__calls.length;
        document.getElementById('cronName').value = 'Morning brief 2';
        document.getElementById('cronAddBtn').click();
        await until(() => document.getElementById('cronAddBtn').disabled); // the save is waiting on its PATCH
        v2Close();
        window.__crons = [{ id: 'c2', name: 'Practice reminder', scheduleExpr: '0 17 * * 2', message: 'Pack the cleats', enabled: true, payloadKind: 'agentTurn' }];
        openV2Agent('a2', 'schedule');
        await until(() => cronAgentId === 'a2' && cronCache.some((c) => c.id === 'c2'));
        editCronJob('c2');
        document.getElementById('cronName').value = 'Practice reminder, Thursdays';
        release();
        await until(() => !document.getElementById('cronAddBtn').disabled);
        await sleep(100);
        const after = window.__calls.slice(mark);
        eq('the save went to the first agent', after.filter((c) => c.method === 'PATCH').map((c) => c.path), ['/v1/agents/a1/crons/c1']);
        ok('nothing is deleted or added on the second agent', !after.some((c) => c.method === 'DELETE' || c.method === 'POST'));
        eq('the second agent\'s edit is still open', [cronEditingId, document.getElementById('cronAddBtn').textContent], ['c2', 'Save changes']);
        eq('what was typed for it is kept', document.getElementById('cronName').value, 'Practice reminder, Thursdays');
      } finally {
        release();
        window.fetch = fetchWas;
        cancelCronEdit(); v2Close(); window.__crons = [];
      }
    },
    intervalLabels: async () => {
      // Intervals to the second: 15 s read "every 0m", 90 s "every 2m" (#95).
      const label = (ms) => cronScheduleLabel({ scheduleKind: 'every', everyMs: ms });
      eq('interval labels', [15e3, 90e3, 60e3, 45 * 60e3, 2 * 3600e3, 90 * 60e3].map(label),
        ['every 15s', 'every 1m 30s', 'every 1m', 'every 45m', 'every 2h', 'every 90m']);
    },
    keyboardLinks: async () => {
      // The notices' link-looking actions are buttons: Tab reaches them, Enter presses them (review, 2026-10-09;
      // ported from the classic card to the agent's notices when classic went, v2.155.0).
      const a = v2Find('a1');
      const notices = document.createElement('div');
      notices.innerHTML = agentNotices({ ...a, persona: 'Helps {{child_name}} with homework' }, { setupValues: true });
      const fill = [...notices.querySelectorAll('button')].find((b) => b.textContent.includes('Fill its Setup values'));
      ok('"Fill its Setup values" is a button', !!fill && fill.type === 'button' && ![...notices.querySelectorAll('a')].some((x) => x.textContent.includes('Setup values')));
      const prevMembers = members[a.id];
      members[a.id] = [{ role: 'owner', userId: 'u-owner' }, { role: 'member', userId: 'u-member-1', displayName: 'Sam' }];
      try {
        const box = document.createElement('div');
        box.innerHTML = agentNotices(a);
        const x = box.querySelector('.kick');
        ok('the member\'s remove × is a button', !!x && x.tagName === 'BUTTON' && x.type === 'button' && x.getAttribute('aria-label') === 'Remove this member');
      } finally { if (prevMembers === undefined) delete members[a.id]; else members[a.id] = prevMembers; }
    },
    untrustedText: async () => {
      // Text and links from the server or an address are handled safely (review, 2026-10-09).
      // A long note is cut before escaping: cut after, an entity broke in half and showed as "&am".
      window.__override['/v1/agents/a1/events'] = { events: [{ at: new Date().toISOString(), label: 'Made-up step', note: '<'.repeat(300) }] };
      try {
        await openSetupLog('a1', 'Test Agent');
        const note = document.querySelector('#setupLogBody .sub:last-child').textContent;
        ok('the note is 200 characters of what was sent: ' + note.slice(0, 30), note === '— ' + '<'.repeat(200));
      } finally { delete window.__override['/v1/agents/a1/events']; setupLogDlg.close(); setupLogAgentId = null; }
      // A stored link that is not https is not clickable: not on a member's page, not as a chat-app button.
      const a = v2Find('a1');
      const bad = { ...a, role: 'user', state: 'RUNNING', botUsername: 'test_helper_bot', deepLink: 'javascript:alert(1)' };
      const box = document.createElement('div');
      box.innerHTML = v2MemberPane(bad);
      ok('no javascript: link on the member\'s page', ![...box.querySelectorAll('a')].some((x) => /^javascript:/i.test(x.getAttribute('href') || '')));
      eq('no chat-app link from it', agentChannelLinks(bad), []);
      eq('https passes, the rest does not', [httpsUrl('https://t.me/x'), httpsUrl('javascript:alert(1)'), httpsUrl('data:text/html,x'), httpsUrl(undefined)], ['https://t.me/x', '', '', '']);
      // A malformed console address is no agent, not an exception.
      const prevHash = location.hash;
      history.replaceState(null, '', location.pathname + location.search + '#console=%E0');
      let threw = null;
      try { consoleFromHash(); } catch (e) { threw = e; }
      history.replaceState(null, '', location.pathname + location.search + prevHash);
      ok('#console=%E0 does not throw: ' + threw, !threw);
    },
    rebuildAsks: async () => {
      const before = calls('POST', /\/rebuild$/).length;
      window.__confirmAnswer = false;
      await rebuild('a1');
      ok('refused: nothing sent', calls('POST', /\/rebuild$/).length === before);
      ok('it asked', window.__confirms.at(-1).includes('rebuilds "Homework Helper" now'));
      window.__confirmAnswer = true;
      await rebuild('a1');
      ok('agreed: sent', calls('POST', /\/rebuild$/).length === before + 1);
    },
    slackSetup: async () => {
      // The Slack sheet: the Open Slack link carries the manifest, and one paste fills both token boxes.
      window.__override['/v1/channels/connectors'] = [{ kind: 'slack', label: 'Slack', fields: [
        { key: 'botToken', label: 'Bot token', pattern: '^xoxb-[A-Za-z0-9-]{20,}$', help: 'xoxb' },
        { key: 'appToken', label: 'App-level token', pattern: '^xapp-[A-Za-z0-9-]{20,}$', help: 'xapp' } ] }];
      window.__override['/v1/channels/slack/manifest'] = { display_information: { name: 'Homework Helper' }, settings: { socket_mode_enabled: true } };
      chanFields = undefined; // the sheet caches the connectors; make it ask again
      await openChanSetup('a1', 'slack');
      await until(() => chanDlg.open);
      const link = await until(() => { const l = document.getElementById('chanSlackNew'); return l && l.href.includes('manifest_json=') ? l : null; });
      ok('the manifest rides in the link', decodeURIComponent(link.href).includes('"socket_mode_enabled":true'));
      const paste = document.getElementById('chanPaste'); ok('a paste box', !!paste);
      // Made-up tokens, assembled here so no token-shaped string sits in this file (the PII hook refuses those).
      const fakeBot = ['xox', 'b-fake-not-a-real-token-abcdefghij'].join(''), fakeApp = ['xap', 'p-fake-AFAKEAPPID-not-a-real-token-abcdefgh'].join('');
      paste.value = 'Bot User OAuth Token ' + fakeBot + ' copied'; paste.dispatchEvent(new Event('input', { bubbles: true }));
      ok('the bot token box filled', document.getElementById('chanF-botToken').value.startsWith('xoxb-'));
      ok('it says what is still missing', document.getElementById('chanErr').textContent.includes('app-level token'));
      paste.value += ' ' + fakeApp; paste.dispatchEvent(new Event('input', { bubbles: true }));
      ok('the app token box filled', document.getElementById('chanF-appToken').value.startsWith('xapp-'));
      ok('nothing missing now', document.getElementById('chanErr').textContent === '');
      chanDlg.close(); v2Close();
    },
    // Two quick opens of the channel sheet (B055): the first agent's fetch comes
    // back last. The sheet must show the second agent, the one Connect sends to.
    chanSetupOverlap: async () => {
      const [first, second] = agents.filter((x) => x.name);
      ok('two agents to open it for', !!first && !!second);
      window.__override['/v1/channels/connectors'] = [{ kind: 'discord', label: 'Discord', fields: [
        { key: 'botToken', label: 'Bot token', pattern: '^.{20,}$', help: 'token' } ] }];
      window.__override['/v1/discord-bots'] = { bots: [] };
      chanFields = undefined;
      const realFetch = window.fetch;
      let release; const held = new Promise((r) => { release = r; });
      let holdNext = true;
      window.fetch = async (input, init) => {
        const path = String(typeof input === 'string' ? input : input.url).split('?')[0];
        if (path === '/v1/discord-bots' && holdNext) { holdNext = false; await held; }
        return realFetch(input, init);
      };
      try {
        const slow = openChanSetup(first.id, 'discord');
        await until(() => !holdNext); // the first open is waiting on its parked-bot list
        await openChanSetup(second.id, 'discord');
        await until(() => chanDlg.open);
        release(); await slow; await sleep(50);
        ok('Connect goes to the second agent', chanFor === second.id);
        ok('the title names it: ' + $('chanTitle').textContent, $('chanTitle').textContent.includes(second.name));
        ok('and the steps name it, not the first', $('chanBody').textContent.includes(second.name) && !$('chanBody').textContent.includes(first.name));
      } finally {
        window.fetch = realFetch;
        release?.();
        delete window.__override['/v1/discord-bots'];
        chanFields = undefined;
        if (chanDlg.open) chanDlg.close();
      }
    },
    machineDefaults: async () => {
      window.__override['/v1/machine-defaults'] = { defaults: [
        { key: 'sleepAfter', label: 'Put idle agents to sleep after', help: 'h', applies: 'now', fallback: 'off', value: '36h', set: true },
        { key: 'filesSlack', label: 'Files an agent may send or receive on Slack', help: 'h', applies: 'now', fallback: '100', value: '100', set: false } ] };
      await openAiDlg('hosts');
      const input = await until(() => document.getElementById('md-filesSlack'));
      ok('the defaults box shows', !document.getElementById('machineDefaults').hidden);
      input.value = '25';
      input.nextElementSibling?.click?.() ?? input.parentElement.querySelector('button').click();
      const put = await until(() => calls('PUT', /\/v1\/machine-defaults$/)[0]);
      eq('the save', put.body, { key: 'filesSlack', value: '25' });
      aiDlg.close();
      // The agent's own policy on its Advanced tab.
      openV2Agent('a1', 'advanced');
      const files = await until(() => document.getElementById('v2FilesCap'));
      files.value = '10'; files.dispatchEvent(new Event('change', { bubbles: true }));
      const patch = await until(() => calls('PATCH', /\/v1\/agents\/a1$/).find((c) => c.body && 'filesMaxMb' in c.body));
      eq('the agent file cap', patch.body, { filesMaxMb: 10 });
      const sleep = document.getElementById('v2Sleep');
      sleep.value = 'never'; sleep.dispatchEvent(new Event('change', { bubbles: true }));
      const p2 = await until(() => calls('PATCH', /\/v1\/agents\/a1$/).find((c) => c.body && 'hibernate' in c.body));
      eq('stay awake', p2.body, { hibernate: 'never' });
      v2Close();
    },
    revertSnapshot: async () => {
      window.__override['/v1/agents/a1/snapshots'] = [{ id: 's1', label: 'before the edit', createdAt: new Date().toISOString(), files: ['SOUL.md', 'AGENTS.md', 'MEMORY.md'], reason: 'manual' }];
      window.__answer = { 'POST /v1/agents/a1/snapshots/s1/restore': [
        { status: 409, body: { error: 'Its current files could not be snapshotted first, so the restore would not be undoable — nothing was changed.' } },
        { status: 200, body: { restored: ['SOUL.md', 'AGENTS.md', 'MEMORY.md'] } } ] };
      // On its sheet's Personality tab, where the restore points are: its refusal is said under them (forAgent).
      openV2Agent('a1', 'personality');
      await until(() => v2AgentId === 'a1' && editAgentId === 'a1' && $('v2Pane').querySelector('#snapList'));
      await loadSnapshots(); // the list with the restore point above, whatever was open before
      const btn = await until(() => [...$('v2Pane').querySelectorAll('#snapList button')].find((b) => b.textContent === 'Revert'));
      const asked = window.__confirms.length;
      btn.click();
      await until(() => document.getElementById('editErr').textContent.includes('nothing was changed'));
      ok('it asked first, and says MEMORY goes back too', window.__confirms.length === asked + 1 && /MEMORY/.test(window.__confirms.at(-1)));
      btn.click();
      await until(() => document.getElementById('toast').textContent.includes('Reverted SOUL.md'));
      eq('two restore calls', calls('POST', /\/snapshots\/s1\/restore$/).length, 2);
      window.__answer = {}; delete window.__override['/v1/agents/a1/snapshots'];
      try { v2Close(); v2EditFor = null; v2SheetNotes.clear(); } catch {}
    },
    downloadRefused: async () => {
      window.__answer = { 'GET /v1/agents/a1/backup': [{ status: 409, body: { error: 'Another operation is already running on this agent.' } }] };
      await downloadAgent('a1', 'Homework Helper');
      await until(() => document.getElementById('toast').textContent.includes('Another operation'));
      ok('the app is still here', !!document.getElementById('v2groups'));
      window.__answer = {};
    },
    moveToRunner: async () => {
      const before = hosts;
      hosts = [{ id: 'h1', name: 'This machine', kind: 'local' }, { id: 'h2', name: 'Laptop', kind: 'docker' }];
      window.__promptAnswer = '1';
      window.__answer = { 'POST /v1/agents/a1/move-host': [
        { status: 409, body: { error: 'pinned', code: 'pinned_image_missing', image: 'hatchabot-runtime:derived-x' } },
        { status: 200, body: { ok: true } } ] };
      await moveHostAgent('a1', 'Homework Helper');
      const posts = calls('POST', /\/v1\/agents\/a1\/move-host$/);
      eq('first the plain move, then on the runner\'s default image', posts.map((c) => c.body), [{ hostId: 'h2' }, { hostId: 'h2', dropPin: true }]);
      ok('it asked about the pin', /pinned to the image/.test(window.__confirms.at(-1)));
      hosts = before; window.__promptAnswer = null; window.__answer = {};
    },
    moveToAnotherHatchabot: async () => {
      window.__override['/v1/peers'] = [{ id: 'p1', name: 'Laptop Hatchabot', url: 'https://laptop.example' }];
      window.__promptAnswer = '1';
      window.__answer = { 'POST /v1/agents/a1/rehost': [{ status: 200, body: { movedTo: 'Laptop Hatchabot', sourceState: 'STOPPED' } }] };
      await rehostAgent('a1', 'Homework Helper');
      eq('the rehost call', calls('POST', /\/v1\/agents\/a1\/rehost$/)[0].body, { peerId: 'p1' });
      ok('it says where it went', document.getElementById('toast').textContent.includes('Moved to Laptop Hatchabot'));
      window.__promptAnswer = null; window.__answer = {}; delete window.__override['/v1/peers'];
    },
    // HB-0228: that server's ⭐ Default is another vendor's, and it has one of
    // the agent's own: the refusal offers it, and a yes moves onto it.
    moveOntoOfferedSource: async () => {
      window.__override['/v1/peers'] = [{ id: 'p1', name: 'Laptop Hatchabot', url: 'https://laptop.example' }];
      window.__promptAnswer = '1';
      const choice = { id: 'src-claude', name: 'Household Claude', vendor: 'anthropic', model: 'claude-sonnet-5' };
      window.__answer = { 'POST /v1/agents/a1/rehost': [
        { status: 400, body: { error: 'Laptop Hatchabot can\'t accept this agent: No matching AI source: it goes on the ⭐ Default source, not Household Claude.', code: 'source_choice', sourceChoice: choice } },
        { status: 200, body: { movedTo: 'Laptop Hatchabot', sourceState: 'STOPPED' } } ] };
      const before = calls('POST', /\/v1\/agents\/a1\/rehost$/).length;
      await rehostAgent('a1', 'Homework Helper');
      const posts = calls('POST', /\/v1\/agents\/a1\/rehost$/).slice(before);
      eq('first the plain move, then onto the offered source', posts.map((c) => c.body), [{ peerId: 'p1' }, { peerId: 'p1', aiProfileId: 'src-claude' }]);
      ok('it asked, naming the source', /Move "Homework Helper" onto Household Claude \(anthropic\/claude-sonnet-5\) on Laptop Hatchabot instead\?/.test(window.__confirms.at(-1)));
      ok('it says where it went', document.getElementById('toast').textContent.includes('Moved to Laptop Hatchabot'));
      // A no leaves it here, and asks nothing more.
      window.__answer = { 'POST /v1/agents/a1/rehost': [{ status: 400, body: { error: 'refused', code: 'source_choice', sourceChoice: choice } }] };
      const confirms = window.__confirms.length;
      window.__confirmAnswer = true;
      const realConfirm = window.confirm;
      let n = 0;
      window.confirm = (text) => { window.__confirms.push(text); return ++n === 1; };
      try { await rehostAgent('a1', 'Homework Helper'); } finally { window.confirm = realConfirm; }
      eq('no second move', calls('POST', /\/v1\/agents\/a1\/rehost$/).length, before + 3);
      eq('two questions: the move, then the source', window.__confirms.length, confirms + 2);
      ok('it says so', document.getElementById('toast').textContent.includes('Not moved'));
      window.__promptAnswer = null; window.__answer = {}; delete window.__override['/v1/peers'];
    },
    // v2.157.0: other servers and image building sit in Settings → Advanced, folded; runners stay on Hosts.
    settingsAdvanced: async () => {
      const el = (id) => document.getElementById(id);
      // A closed <details> hides its content with content-visibility, which offsetParent does not see.
      const seen = (e) => (e.checkVisibility ? e.checkVisibility() : e.offsetParent !== null);
      const foldAll = async () => { for (const d of document.querySelectorAll('#paneAdvanced > details')) d.open = false; await sleep(60); try { localStorage.removeItem('hb-settings-adv'); } catch {} };
      await foldAll();
      await openAiDlg();
      const tabs = [...document.querySelectorAll('#v2SettingsTabs .tab')].map((b) => b.textContent);
      ok('Advanced is the last tab: ' + tabs.join(' | '), tabs.at(-1) === 'Advanced');
      ok('no Images tab any more', !tabs.includes('Images') && tabs.includes('Hosts'));
      const n0 = calls('GET', /\/v1\/runtime\/images$/).length;
      byText('#v2SettingsTabs .tab', 'Advanced').click();
      ok('the Advanced tab shows', !el('paneAdvanced').hidden);
      ok('its one line says who it is for', el('paneAdvanced').textContent.includes('For running several Hatchabot servers, and building your own runtime images. A household needs none of this.'));
      const parts = [...document.querySelectorAll('#paneAdvanced > details')];
      eq('its parts', parts.map((d) => d.querySelector('summary b').textContent), ['Other Hatchabot servers', 'Runtime images', 'Derived images']);
      ok('all folded by default', parts.every((d) => !d.open));
      ok('a folded part shows nothing', !seen(el('peerAddBtn')) && !seen(el('rtList')));
      await sleep(150);
      eq('a folded part loads nothing', calls('GET', /\/v1\/runtime\/images$/).length, n0);
      parts[1].querySelector('summary').click();
      await until(() => calls('GET', /\/v1\/runtime\/images$/).length > n0);
      ok('it opens', parts[1].open && seen(el('rtList')));
      ok('remembered in this browser', JSON.parse(localStorage.getItem('hb-settings-adv') || '[]').includes('runtime'));
      aiDlg.close();
      await openAiDlg('advanced');
      ok('still open next time, the others still shut', el('advPart-runtime').open && !el('advPart-servers').open && !el('advPart-derived').open);
      // Runners: where they were, outside Advanced, and the way to add a machine.
      byText('#v2SettingsTabs .tab', 'Hosts').click();
      ok('runners are on Hosts, outside Advanced', !el('paneHosts').hidden && !el('paneAdvanced').contains(el('paneHosts')) && seen(el('hostAddBtn')));
      ok('Hosts says a runner is the way to add a machine', el('paneHosts').textContent.includes('that is the way to add a machine'));
      ok('other servers are not on Hosts', !seen(el('peerAddBtn')));
      // The same machine under another address is said where it is added (HB-0435).
      el('hostName').value = 'Studio again'; el('hostEndpoint').value = 'ssh://sam@studio-tail';
      window.__answer = { 'POST /v1/hosts': [{ status: 201, body: { id: 'h9', name: 'Studio again', reachable: true, serverVersion: '27.0', hasImage: true, warning: 'This is the same Docker as "Studio", under another address. Keep one of the two: agents belong on one row.' } }] };
      el('hostAddBtn').click();
      await until(() => document.getElementById('toast').textContent.includes('Runner "Studio again" added'));
      ok('a second row for one machine is said', document.getElementById('toast').textContent.includes('This is the same Docker as "Studio"'));
      window.__answer = {};
      await until(() => !el('rbSection').hidden);
      ok('automatic rebuilds sit on Hosts', el('paneHosts').contains(el('rbSection')) && seen(el('rbPolicy')));
      aiDlg.close();
      await foldAll();
    },
    advancedOldLinks: async () => {
      const el = (id) => document.getElementById(id);
      const foldAll = async () => { for (const d of document.querySelectorAll('#paneAdvanced > details')) d.open = false; await sleep(60); try { localStorage.removeItem('hb-settings-adv'); } catch {} };
      for (const [link, part] of [['servers', 'servers'], ['images', 'runtime'], ['runtime', 'runtime'], ['derived', 'derived']]) {
        await foldAll();
        await openAiDlg(link);
        ok(link + ' lands on Advanced', document.querySelector('#v2SettingsTabs .tab[aria-selected="true"]')?.textContent === 'Advanced');
        await until(() => el('advPart-' + part).open);
        ok(link + ' unfolds only ' + part, [...document.querySelectorAll('#paneAdvanced > details')].filter((d) => d.open).length === 1);
        aiDlg.close();
      }
      for (const link of ['hosts', 'machines']) {
        await openAiDlg(link);
        ok(link + ' lands on Hosts', document.querySelector('#v2SettingsTabs .tab[aria-selected="true"]')?.textContent === 'Hosts');
        aiDlg.close();
      }
      // The Hatchabot agent's image cards link to the old Images tab.
      await foldAll();
      mgmtCardPlace({ tool: 'build_image' }).go();
      await until(() => aiDlg.open && el('advPart-runtime').open);
      aiDlg.close();
      // Move to another Hatchabot with no server yet sends you to register one.
      await foldAll();
      window.__override['/v1/peers'] = [];
      await rehostAgent('a1', 'Homework Helper');
      await until(() => aiDlg.open && el('advPart-servers').open);
      ok('it says why', document.getElementById('toast').textContent.includes('Register the destination'));
      aiDlg.close(); delete window.__override['/v1/peers'];
      await foldAll();
    },
    advancedActions: async () => {
      const el = (id) => document.getElementById(id);
      // Other servers: an empty field is said under the form (it went to the AI tab's hidden line), then the add.
      await openAiDlg('servers');
      await until(() => el('advPart-servers').open);
      el('peerName').value = 'Test Server'; el('peerUrl').value = ''; el('peerToken').value = '';
      el('peerAddBtn').click();
      ok('the missing field is said where you look', el('peerErr').textContent.includes('all needed') && el('peerErr').offsetParent !== null);
      el('peerUrl').value = 'https://server.example.org'; el('peerToken').value = 'made-up-pairing-code';
      el('peerAddBtn').click();
      const post = await until(() => calls('POST', /\/v1\/peers$/)[0]);
      eq('the add', post.body, { name: 'Test Server', url: 'https://server.example.org', token: 'made-up-pairing-code' });
      aiDlg.close();
      // Runtime images: Promote, from its new place.
      window.__override['/v1/runtime/images'] = { unpinned: [], defaultInfo: { openclawVersion: '2026.9.8' }, tags: [
        { tag: 'hatchabot-runtime:latest', exists: true, isDefault: true, openclawVersion: '2026.9.8', pinned: [], classes: [] },
        { tag: 'hatchabot-runtime:2026.9.9', exists: true, relation: 'newer', openclawVersion: '2026.9.9', pinned: [], classes: [] } ] };
      window.__answer = { 'POST /v1/runtime/images/promote': [{ status: 200, body: { promoted: 'hatchabot-runtime:2026.9.9', followers: [] } }] };
      await openAiDlg('images');
      await until(() => [...document.querySelectorAll('#rtList button')].find((b) => b.textContent.includes('Promote')));
      // "Used by" lists what blocks a delete; "nothing" is said only when Docker answered (HB-0380).
      rtData = { ...rtData, tags: [
        { tag: 'hatchabot-runtime:2026.7.1', exists: true, relation: 'older', pinned: [{ id: 'x1', name: 'Pantry', state: 'ARCHIVED', mine: true, runner: null }], classes: [],
          blockers: [{ kind: 'pin', name: 'Pantry', label: 'archived, pinned', fix: 'Restore it and discard its trial, or delete it.', mine: true }] },
        { tag: 'hatchabot-runtime:2026.7.2', exists: true, relation: 'older', pinned: [], classes: [],
          blockers: [{ kind: 'container', name: 'Cellar', label: 'archived, container on it', fix: 'Restore and rebuild it, which moves it off this image, or delete it.', mine: true }] },
        { tag: 'hatchabot-runtime:2026.7.3', exists: true, relation: 'older', pinned: [], classes: [], blockers: [] } ] };
      renderRuntimeList();
      const used = [...document.querySelectorAll('#rtList tbody tr:not(.rt-under)')].map((r) => r.cells[3].textContent);
      ok('an archived pin is named, with no ✕ and a way out', used[0].includes('Pantry · archived') && used[0].includes('Restore it and discard its trial') && !document.querySelector('#rtList tbody tr:not(.rt-under)').cells[3].querySelector('a'));
      ok("an archived agent's container is named, with a way out", used[1].includes('Cellar · archived, container on it') && used[1].includes('Restore and rebuild it'));
      ok('nothing holding it says nothing', used[2].trim() === 'nothing');
      rtData = { ...rtData, containersChecked: false }; renderRuntimeList();
      const unchecked = [...document.querySelectorAll('#rtList tbody tr:not(.rt-under)')].map((r) => r.cells[3].textContent);
      ok('Docker not answering is not "nothing"', unchecked[2].includes('Containers could not be checked') && !unchecked[2].includes('nothing'));
      await loadRuntimeImages();
      const promote = await until(() => [...document.querySelectorAll('#rtList button')].find((b) => b.textContent.includes('Promote')));
      promote.click();
      const pr = await until(() => calls('POST', /\/v1\/runtime\/images\/promote$/)[0]);
      eq('the promote', pr.body, { tag: 'hatchabot-runtime:2026.9.9' });
      aiDlg.close();
      // Derived images: delete one, from its new place.
      window.__override['/v1/images'] = { images: [{ name: 'media-tools', tag: 'hatchabot-runtime:derived-media-tools', status: 'READY',
        dockerfile: 'RUN apt-get install -y ffmpeg', base: 'hatchabot-runtime:latest', builtAt: '2026-10-01T00:00:00Z', pinnedBy: 0 }] };
      await openAiDlg('derived');
      const del = await until(() => [...document.querySelectorAll('#derivedList button')].find((b) => b.title === 'Delete this derived image'));
      del.click();
      await until(() => calls('DELETE', /\/v1\/images\/media-tools$/)[0]);
      aiDlg.close();
      // Automatic rebuilds: on Hosts now, saving as before.
      window.__override['/v1/rebuild-policy'] = { policy: 'required-only', quietHours: '3-5' };
      window.__override['/v1/rebuild-concurrency'] = { atOnce: 6, max: 12 };
      await openAiDlg('hosts');
      const pol = await until(() => el('rbPolicy').offsetParent !== null && el('rbPolicy'));
      pol.value = 'manual'; pol.dispatchEvent(new Event('change', { bubbles: true }));
      const put = await until(() => calls('PUT', /\/v1\/rebuild-policy$/)[0]);
      eq('the policy', put.body, { policy: 'manual' });
      aiDlg.close();
      window.__answer = {};
      for (const k of ['/v1/runtime/images', '/v1/images', '/v1/rebuild-policy', '/v1/rebuild-concurrency']) delete window.__override[k];
      for (const d of document.querySelectorAll('#paneAdvanced > details')) d.open = false;
      await sleep(60); try { localStorage.removeItem('hb-settings-adv'); } catch {}
    },
    sheetBetweenServers: async () => {
      openV2Agent('a1', 'advanced');
      const head = await until(() => document.getElementById('v2BetweenServers'));
      const machine = [...document.querySelectorAll('.v2row')].find((r) => r.querySelector('.v2k')?.textContent === 'Machine');
      ok('the Machine row is there', !!machine);
      ok('the Machine row no longer holds it', ![...machine.querySelectorAll('button')].some((b) => b.textContent.includes('another Hatchabot')));
      ok('it sits below the Machine row', !!(machine.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING));
      eq('its heading', head.textContent, 'Between servers');
      const rowEl = head.nextElementSibling;
      ok('with a short note', rowEl.textContent.includes('second Hatchabot server with its own dashboard'));
      const btn = [...rowEl.querySelectorAll('button')].find((b) => b.textContent === 'Move to another Hatchabot');
      ok('the button', !!btn);
      window.__override['/v1/peers'] = [{ id: 'p1', name: 'Test Server', url: 'https://server.example.org' }];
      window.__promptAnswer = '1';
      window.__answer = { 'POST /v1/agents/a1/rehost': [{ status: 200, body: { movedTo: 'Test Server', sourceState: 'STOPPED' } }] };
      const before = calls('POST', /\/v1\/agents\/a1\/rehost$/).length;
      btn.click();
      await until(() => calls('POST', /\/v1\/agents\/a1\/rehost$/).length > before);
      eq('the same rehost call', calls('POST', /\/v1\/agents\/a1\/rehost$/).at(-1).body, { peerId: 'p1' });
      window.__promptAnswer = null; window.__answer = {}; delete window.__override['/v1/peers'];
      v2Close();
    },
    backupRestore: async () => {
      window.__override['/v1/backups'] = { dir: '/backups', keepDays: 7, run: { status: 'idle' }, backups: [
        { date: '2026-09-26', sizeBytes: 1024, hasDb: true, hasKey: true, volumes: [{ name: 'Homework Helper', agentId: 'a1', sizeBytes: 1024 }] }] };
      await openAiDlg('backups');
      const restore = await until(() => [...document.querySelectorAll('#bkList button')].find((b) => b.textContent === 'Restore'));
      window.__promptAnswer = 'Homework';           // the wrong name: nothing happens
      restore.click();
      await until(() => document.getElementById('toast').textContent.includes('did not match'));
      eq('no restore on a wrong name', calls('POST', /\/v1\/backups\/restore$/).length, 0);
      window.__promptAnswer = 'Homework Helper';
      window.__answer = { 'POST /v1/backups/restore': [{ status: 200, body: { date: '2026-09-26', running: false, undone: ["That night's copy still let Sam in; they stay removed."] } }] };
      restore.click();
      const post = await until(() => calls('POST', /\/v1\/backups\/restore$/)[0]);
      eq('the restore', post.body, { agentId: 'a1', date: '2026-09-26' });
      await until(() => document.getElementById('toast').textContent.includes('Restored'));
      ok('no "restarting" when it is not running', !document.getElementById('toast').textContent.includes('restarting'));
      ok('it says what the restore undid', document.getElementById('toast').textContent.includes('still let Sam in; they stay removed'));
      aiDlg.close(); window.__promptAnswer = null; window.__answer = {}; delete window.__override['/v1/backups'];
    },
    // A partial set, an agent the set does not cover, and a left-out orphan are said, not shown green (review, 2026-09-29).
    backupIncomplete: async () => {
      window.__override['/v1/backups'] = { dir: '/backups', keepDays: 7, run: { status: 'idle' },
        missing: [{ agentId: 'a9', name: 'Reading List', host: 'Laptop runner' }],
        backups: [{ date: '2026-09-28', sizeBytes: 1024, hasDb: true, hasKey: true, complete: false, failedVolumes: ['hatchabot-kitchen-vol'],
          orphans: ['agentclaw-old-vol'], volumes: [{ name: 'Homework Helper', agentId: 'a1', sizeBytes: 1024 }] }] };
      await openAiDlg('backups');
      const list = await until(() => { const t = document.getElementById('bkList').textContent; return t.includes('2026-09-28') ? t : null; });
      ok('the set is marked incomplete, with its failure count', list.includes('incomplete (1 agent failed)'));
      ok('the uncovered agent is named with its machine', list.includes('Not in the newest backup: Reading List (Laptop runner)'));
      ok('the orphan volume is named as left out', list.includes('Left out: agentclaw-old-vol'));
      aiDlg.close(); delete window.__override['/v1/backups'];
    },
    // A set made by another install or under an earlier key: labelled, no Delete, and a restore says why and asks (review of HB-0540).
    backupOtherKey: async () => {
      window.__override['/v1/backups'] = { dir: '/backups', keepDays: 7, run: { status: 'idle' }, backups: [
        { date: '2026-09-25', sizeBytes: 1024, hasDb: true, hasKey: true, foreign: true, volumes: [{ name: 'Homework Helper', agentId: 'a1', sizeBytes: 1024 }] }] };
      await openAiDlg('backups');
      const list = await until(() => { const t = document.getElementById('bkList').textContent; return t.includes('2026-09-25') ? t : null; });
      ok('it is labelled', list.includes('Made by another install, or under an earlier key'));
      ok('no Delete set on it', ![...document.querySelectorAll('#bkList button')].some((b) => b.textContent === 'Delete set'));
      const restore = [...document.querySelectorAll('#bkList button')].find((b) => b.textContent === 'Restore');
      const why = 'The 2026-09-25 backup was made by another install, or under an earlier key. Confirm to go ahead.';
      window.__promptAnswer = 'Homework Helper';
      window.__answer = { 'POST /v1/backups/restore': [{ status: 400, body: { error: why, code: 'other_key' } }, { status: 200, body: { date: '2026-09-25', running: false } }] };
      const before = calls('POST', /\/v1\/backups\/restore$/).length;
      restore.click();
      await until(() => calls('POST', /\/v1\/backups\/restore$/).length === before + 2);
      eq('it said why and asked', window.__confirms.at(-1), why + '\n\nRestore “Homework Helper” from it anyway?');
      eq('then the restore, on the yes', calls('POST', /\/v1\/backups\/restore$/).at(-1).body, { agentId: 'a1', date: '2026-09-25', otherKey: true });
      await until(() => document.getElementById('toast').textContent.includes('Restored'));
      aiDlg.close(); window.__promptAnswer = null; window.__answer = {}; delete window.__override['/v1/backups'];
    },
    hostsDrain: async () => {
      window.__override['/v1/hosts'] = [{ id: 'h1', name: 'This machine', hostname: 'home', kind: 'local', online: true, status: 'online', agentCount: 13 },
        { id: 'h2', name: 'Laptop', kind: 'docker', settings: { dockerHost: 'ssh://laptop' }, online: true, status: 'online', agentCount: 2 }];
      window.__answer = { 'POST /v1/hosts/h2/drain': [{ status: 200, body: { stopped: 2, skipped: [] } }] };
      await openAiDlg('hosts');
      const drain = await until(() => [...document.querySelectorAll('#hostList button')].find((b) => b.textContent === 'Drain'));
      drain.click();
      await until(() => calls('POST', /\/v1\/hosts\/h2\/drain$/)[0]);
      ok('it asked first', /Drain "Laptop"/.test(window.__confirms.at(-1)));
      await until(() => document.getElementById('toast').textContent.includes('Stopped 2 agents'));
      aiDlg.close(); window.__answer = {}; delete window.__override['/v1/hosts'];
    },
    proposalCards: async () => {
      window.__override['/v1/proposals'] = { pending: [
        { confirmId: 'c1', summary: '🔌 Switch "Homework Helper" to the AI source "Key" — it applies at its next rebuild.', risk: 'careful', source: 'agent', note: 'cheaper for homework' },
        { confirmId: 'c2', summary: '📸 Snapshot "Piano Practice"', risk: 'routine' } ], recent: [] };
      window.__answer = { 'POST /v1/proposals/c1/confirm': [{ status: 200, body: { text: '✅ Done.' } }], 'POST /v1/proposals/c2/cancel': [{ status: 200, body: { text: 'Cancelled.' } }] };
      v2PropSig = '';
      await loadProposals();
      const cards = await until(() => { const l = [...document.querySelectorAll('#v2PropList > div')]; return l.length === 2 ? l : null; });
      ok('the section shows', !document.getElementById('v2Proposals').hidden);
      ok('a careful change says so, and who prepared it', cards[0].textContent.includes('Read carefully') && cards[0].textContent.includes('Prepared by your Hatchabot agent'));
      ok('its reason is marked as its words', cards[0].textContent.includes('Its reason: “cheaper for homework”'));
      [...cards[0].querySelectorAll('button')].find((b) => b.textContent.includes('Confirm')).click();
      await until(() => cards[0].textContent.includes('✅ Done.'));
      [...cards[1].querySelectorAll('button')].find((b) => b.textContent.includes('Cancel')).click();
      await until(() => cards[1].textContent.includes('Cancelled.'));
      eq('confirm and cancel sent', [calls('POST', /\/c1\/confirm$/).length, calls('POST', /\/c2\/cancel$/).length], [1, 1]);
      window.__answer = {}; delete window.__override['/v1/proposals'];
    },
    modelCards: async () => {
      // Right-size step 2: a set_model card carries the scorecard's evidence and a
      // downgrade's risks; the quality guard's switch-back card says who made it.
      window.__override['/v1/proposals'] = { pending: [
        { confirmId: 'm1', tool: 'set_model', agentId: 'a1', risk: 'disruptive', source: 'agent', note: 'mostly short answers',
          summary: 'Set "Homework Helper" model: claude-sonnet-5 → claude-haiku-4-5 (a smaller or cheaper model)\nEvidence (6 days, now claude-sonnet-5): 4 turns …\n⚠ Thin evidence: 4 turns on claude-sonnet-5 in 6 days.',
          check: { downgrade: true, evidence: 'Evidence (6 days, now claude-sonnet-5): 4 turns (0.7/day), 3.5 tools per turn, tools in 75% of turns, context ~12K per call, no errors; ≈ $4.10 a month → ≈ $2.05 on claude-haiku-4-5 at API prices.',
            warnings: ['Thin evidence: 4 turns on claude-sonnet-5 in 6 days.', 'Heavy tool use: 3.5 tools per turn, tools in 75% of turns. Smaller models make more malformed or wrong tool calls.'] } },
        { confirmId: 'g1', tool: 'set_model', agentId: 'a2', risk: 'disruptive', source: 'guard',
          summary: '↩ Switch "Piano Practice" back to claude-sonnet-5\nHatchabot\'s quality guard: since "Piano Practice" moved from claude-sonnet-5 to claude-haiku-4-5 …\nBefore (claude-sonnet-5, 30 days): 120 turns, failed 0%\nAfter (claude-haiku-4-5, 7 days): 30 turns, failed 13.3%\nWorse: failed turns 0% → 13.3% of turns (4 on claude-haiku-4-5).' } ], recent: [] };
      window.__answer = { 'POST /v1/proposals/g1/confirm': [{ status: 200, body: { text: '✅ Switched back.' } }] };
      // v2.158.0: cost and model cards come marked recommended — they are Usage → Recommended items, not cards in the home list.
      const marked = window.__override['/v1/proposals'];
      marked.pending = marked.pending.map((p) => ({ ...p, recommended: true }));
      v2PropSig = '';
      await loadProposals();
      eq('no cost or model card in the home list', document.querySelectorAll('#v2PropList > div').length, 0);
      ok('and no section for them alone', document.getElementById('v2Proposals').hidden);
      // The card itself still renders where every card shows (the Hatchabot agent's console).
      const holder = document.createElement('div');
      document.body.appendChild(holder);
      for (const p of marked.pending) mgmtProposalCard(p, holder);
      const cards = [...holder.children];
      ok('the headline is the first line only', cards[0].firstElementChild.nextElementSibling.textContent.startsWith('Set "Homework Helper" model: claude-sonnet-5 → claude-haiku-4-5') && !cards[0].textContent.includes('4 turns …'));
      ok('the evidence is on the card', cards[0].querySelector('.prop-evidence')?.textContent.includes('3.5 tools per turn'));
      eq('each risk is marked', [...cards[0].querySelectorAll('.prop-risks > div')].map((d) => d.textContent.slice(0, 16)), ['⚠ Thin evidence:', '⚠ Heavy tool use']);
      ok('the guard card says who prepared it', cards[1].textContent.includes("Prepared by Hatchabot's quality guard") && cards[1].textContent.includes('Before (claude-sonnet-5'));
      ok('a card without a check shows its whole text', cards[1].textContent.includes('Worse: failed turns'));
      [...cards[1].querySelectorAll('button')].find((b) => b.textContent.includes('Confirm')).click();
      await until(() => cards[1].textContent.includes('✅ Switched back.'));
      eq('confirm sent', calls('POST', /\/g1\/confirm$/).length, 1);
      holder.remove();
      window.__answer = {}; delete window.__override['/v1/proposals'];
    },
    headerDoors: async () => {
      await openAiDlg(); ok('Settings opens', aiDlg.open); aiDlg.close();
      document.querySelector('#v2Header .v2hubactions button[aria-label="Usage"]').click();
      await until(() => fleetUsageDlg.open); ok('Usage opens its own panel', fleetUsageDlg.open); fleetUsageDlg.close();
      document.querySelector('#v2Header .v2hubactions button[aria-label="Resources"]').click();
      await until(() => fleetResDlg.open); ok('Resources opens its own panel', fleetResDlg.open); fleetResDlg.close();
      ok('no Status panel any more', typeof openFleet === 'undefined' && !document.getElementById('v2FleetDlg'));
      ok('Rebuild all sits in Bulk actions', !!byText('#fleetActionsDlg button', 'Rebuild all'));
      ok('memory search for every agent sits in Settings → Hosts', !!document.querySelector('#embedBox #embedFleetRow'));
      document.getElementById('fabBtn').click(); ok('New opens the create dialog', createDlg.open); createDlg.close();
      document.querySelector('#v2Header .v2hubactions button[aria-label="Settings"]').click();
      await until(() => aiDlg.open); aiDlg.close();
    },
    editorSaveGuard: async () => {
      // A file that will not load leaves nothing to save: an empty editor's Save used to write over MEMORY.md (night review).
      window.__answer = { 'GET /v1/agents/a1/files/MEMORY.md': [{ status: 413, body: { error: 'MEMORY.md is too large to edit here' } }] };
      editAgentId = 'a1';
      document.getElementById('editFile').value = 'MEMORY.md';
      await loadEditFile();
      ok('Save is off after a failed load', document.getElementById('editSaveBtn').disabled);
      document.getElementById('editContent').value = 'one new line';
      const puts = calls('PUT', /\/files\//).length;
      await saveEditFile();
      eq('nothing written', calls('PUT', /\/files\//).length, puts);
      window.__answer = { 'GET /v1/agents/a1/files/SOUL.md': [{ status: 200, body: { content: 'You are helpful.' } }] };
      document.getElementById('editFile').value = 'SOUL.md';
      await loadEditFile();
      ok('Save is on once the file loaded', !document.getElementById('editSaveBtn').disabled);
      eq('the loaded text', document.getElementById('editContent').value, 'You are helpful.');
      window.__answer = {};
    },
    bulkRebuildSkipsStopped: async () => {
      // "Stopped agents are skipped": a rebuild ends RUNNING, so the bulk Rebuild must leave a stopped one alone.
      const tax = agents.find((a) => a.name === 'Tax Filing');
      ok('a stopped agent in the stub', tax && tax.state === 'STOPPED');
      await openFleetActions();
      await until(() => document.querySelectorAll('.faCb').length);
      document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === 'a1' || cb.dataset.id === tax.id; });
      document.getElementById('faAction').value = 'rebuild'; faRenderAction();
      window.__confirmAnswer = true;
      await faApply();
      await until(() => !document.getElementById('faApplyBtn').disabled);
      ok('the running one rebuilt', calls('POST', /\/v1\/agents\/a1\/rebuild$/).length >= 1);
      eq('the stopped one, already current, left alone', calls('POST', new RegExp('/v1/agents/' + tax.id + '/rebuild$')).length, 0);
      fleetActionsDlg.close();
      // On an older image (fourth review): marked for its next start, as Rebuild all does, and said so.
      const list = await (await fetch('/v1/agents')).json();
      try {
        window.__override['/v1/agents'] = list.map((a) => a.id === tax.id ? { ...a, updateAvailable: true, rebuild: { level: 'recommended', reasons: ['a newer runtime image is ready'] } } : a);
        await refresh(false);
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === tax.id; });
        document.getElementById('faAction').value = 'rebuild'; faRenderAction();
        window.__answer = { ['POST /v1/agents/' + tax.id + '/rebuild']: [{ status: 202, body: { rebuilding: false, atNextStart: true } }] };
        await faApply();
        await until(() => !document.getElementById('faApplyBtn').disabled);
        eq('behind: marked, with stoppedWaits', calls('POST', new RegExp('/v1/agents/' + tax.id + '/rebuild$')).map((c) => c.body), [{ stoppedWaits: true }]);
        ok('and said: ' + $('faResults').textContent, $('faResults').textContent.includes('1 not running: rebuilt when it next starts') && !$('faResults').textContent.includes('skipped'));
        // Seventh review: by the page's own rule, as the Needs rebuild chip counts: peer changes waiting are a change a rebuild brings.
        fleetActionsDlg.close();
        window.__override['/v1/agents'] = list.map((a) => a.id === tax.id ? { ...a, rebuild: undefined, updateAvailable: false, peersPending: true } : a);
        await refresh(false);
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === tax.id; });
        document.getElementById('faAction').value = 'rebuild'; faRenderAction();
        const marks = calls('POST', new RegExp('/v1/agents/' + tax.id + '/rebuild$')).length;
        window.__answer = { ['POST /v1/agents/' + tax.id + '/rebuild']: [{ status: 202, body: { rebuilding: false, atNextStart: true } }] };
        await faApply();
        await until(() => !document.getElementById('faApplyBtn').disabled);
        eq('peers waiting: marked too', calls('POST', new RegExp('/v1/agents/' + tax.id + '/rebuild$')).length - marks, 1);
        // Ninth review: as Rebuild all, one never built (no container yet) or moved to another machine is skipped, not sent.
        fleetActionsDlg.close();
        window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, runtimeRef: undefined } : a.id === tax.id ? { ...a, peersPending: true, migratedTo: 'h-made-up' } : a);
        await refresh(false);
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === 'a1' || cb.dataset.id === tax.id; });
        document.getElementById('faAction').value = 'rebuild'; faRenderAction();
        const sent = calls('POST', /\/rebuild$/).length;
        await faApply();
        await until(() => !document.getElementById('faApplyBtn').disabled);
        eq('never built, or moved: nothing sent', calls('POST', /\/rebuild$/).length - sent, 0);
        ok('and both skipped, none failed: ' + $('faResults').textContent, /2 skipped/.test($('faResults').textContent) && !/failed/.test($('faResults').textContent));
      } finally {
        window.__answer = {}; delete window.__override['/v1/agents']; await refresh(false);
        if (fleetActionsDlg.open) fleetActionsDlg.close();
      }
    },
    meshNamesTheSleeping: async () => {
      // HB-0465: the bulk Connect's answer names an agent that is asleep, which takes the change at its next Start or Rebuild.
      await openFleetActions();
      await until(() => document.querySelectorAll('.faCb').length >= 2);
      const picked = [...document.querySelectorAll('.faCb')].slice(0, 2);
      document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = picked.includes(cb); });
      document.getElementById('faAction').value = 'peers-connect'; faRenderAction();
      const asleep = agents.find((a) => a.id === picked[1].dataset.id);
      const note = asleep.name + ' is asleep. A sleeping agent wakes for a message as it was; it takes this change at its next Start or Rebuild, and its card says its peers changed.';
      window.__answer = { 'POST /v1/agent-peers/mesh': [{ status: 200, body: { agents: 2, grants: 2, changed: true, needRebuild: [], skipped: [], note } }] };
      try {
        await faApply();
        await until(() => !document.getElementById('faApplyBtn').disabled);
        const said = document.getElementById('faResults').textContent;
        ok('the answer names the sleeping one: ' + said, said.includes(asleep.name + ' is asleep') && said.endsWith('its card says its peers changed.'));
      } finally {
        window.__answer = {};
        fleetActionsDlg.close();
      }
    },
    stoppedStaysStopped: async () => {
      // HB-0411, HB-0420, HB-0441: a change does not start a stopped agent, and every surface says so.
      const toastText = () => document.getElementById('toast').textContent;
      const tax = agents.find((a) => a.name === 'Tax Filing');
      ok('a stopped agent in the stub', tax && tax.state === 'STOPPED');
      try {
        // Bulk: Move to source. The note, the question and the result all say it.
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === tax.id; });
        document.getElementById('faAction').value = 'source'; faRenderAction();
        ok('the note says it: ' + document.getElementById('faActionNote').textContent, /Stopped and sleeping agents stay as they are/.test(document.getElementById('faActionNote').textContent));
        const to = document.getElementById('faSource').value;
        window.__confirmAnswer = true;
        window.__answer = { ['POST /v1/ai-profiles/' + to + '/adopt-agents']: [{ status: 200, body: { switched: 1, rebuilding: 0, atNextStart: 1, skipped: [] } }] };
        const asked = window.__confirms.length;
        await faApply();
        await until(() => !document.getElementById('faApplyBtn').disabled);
        ok('the question says it', /Stopped and sleeping agents are not started/.test(window.__confirms[asked]));
        ok('the result says it: ' + document.getElementById('faResults').textContent, /1 not running, so it takes it at the next start/.test(document.getElementById('faResults').textContent));
        fleetActionsDlg.close();
        // Migrate all: the same, other accounts' agents among them.
        migrateState = { id: 'p1', name: 'Old' };
        window.__answer = { 'POST /v1/ai-profiles/p1/migrate-agents': [{ status: 200, body: { switched: 2, agents: 2, otherAccounts: 1, rebuilding: 1, atNextStart: 1, skipped: [] } }] };
        const opt = document.createElement('option'); opt.value = 'p2'; document.getElementById('migrateTo').replaceChildren(opt);
        await runMigrate();
        ok('Migrate all asks, naming them', /Stopped and sleeping agents are not started/.test(window.__confirms.at(-1)));
        await until(() => /1 not running take it at their next start/.test(toastText()));
        // A setting: the server's words, not "rebuilding".
        window.__answer = { ['PATCH /v1/agents/' + tax.id]: [{ status: 200, body: { id: tax.id, browser: true, rebuildOnStart: 'now', browserPending: 'Saved. It stays stopped, and has its browser when it next starts.' } }] };
        await v2SetBrowser(tax.id, true, null);
        await until(() => toastText().includes('when it next starts'));
        ok('not the "rebuilding" line', !toastText().includes('rebuilding'));
        // A bot: neither "rebuilding" nor "restarts now".
        window.__answer = { ['POST /v1/agents/' + tax.id + '/telegram']: [{ status: 202, body: { username: 'tax_bot', atNextStart: true } }] };
        await v2AddTelegram(tax.id, false);
        await until(() => toastText().includes('answers there once it next starts'));
        chanFor = tax.id; chanKind = 'discord';
        chanDlg.showModal();
        chanShowConnected({ displayName: 'Bot', atNextStart: true });
        ok('connected sheet: stays stopped', /It stays stopped/.test(document.getElementById('chanBody').textContent) && !/restarts now/.test(document.getElementById('chanBody').textContent));
        chanDlg.close();
        window.__confirmAnswer = false;
        await chanRemove(tax.id, 'discord');
        ok('Detach asks with what will happen', /It stays stopped; this applies when it next starts/.test(window.__confirms.at(-1)) && !/It rebuilds now/.test(window.__confirms.at(-1)));
        window.__confirmAnswer = true;
        // An image pin: the toast and the hint agree.
        editAgentId = tax.id;
        const sel = document.getElementById('editImage');
        const o = document.createElement('option'); o.value = 'hatchabot/runtime:trial'; sel.replaceChildren(o); sel.value = o.value;
        sel.dataset.agent = tax.id; delete sel.dataset.loading; // its own list, loaded
        window.__answer = { ['PATCH /v1/agents/' + tax.id]: [{ status: 200, body: { id: tax.id, image: o.value, sameImage: false } }] };
        const rebuilds = calls('POST', new RegExp('/v1/agents/' + tax.id + '/rebuild$')).length;
        await saveImagePin();
        await until(() => toastText().includes('it moves onto it when it next starts'));
        eq('no rebuild sent for a stopped pin', calls('POST', new RegExp('/v1/agents/' + tax.id + '/rebuild$')).length, rebuilds);
        // Its card says a change is waiting; a Rebuild asked for by name says it starts.
        const box = document.createElement('div');
        box.innerHTML = agentNotices({ ...v2Find(tax.id), state: 'STOPPED', rebuildOnStart: 'now' });
        ok('its card says a change is waiting', /A change is waiting/.test(box.textContent));
        box.innerHTML = agentNotices({ ...v2Find('a1'), state: 'RUNNING', rebuildOnStart: undefined });
        ok('nothing waiting, nothing said', !/A change is waiting/.test(box.textContent));
        window.__confirmAnswer = false;
        await rebuild(tax.id);
        ok('Rebuild on a stopped agent says it starts it', /ends with "Tax Filing" running/.test(window.__confirms.at(-1)));
        eq('refused: nothing sent', calls('POST', new RegExp('/v1/agents/' + tax.id + '/rebuild$')).length, rebuilds);
      } finally { window.__confirmAnswer = true; window.__answer = {}; editAgentId = null; if (chanDlg.open) chanDlg.close(); if (fleetActionsDlg.open) fleetActionsDlg.close(); }
    },
    trialsWaitForStoppedAgents: async () => {
      // HB-0469: Pin & rebuild and Discard trial rebuild only running agents, as the manager's try and end of a trial do.
      // The server decides (stoppedWaits), not the page's old view: one it shows stopped may have woken since.
      const toastText = () => document.getElementById('toast').textContent;
      const tax = agents.find((a) => a.name === 'Tax Filing'), run = agents.find((a) => a.id === 'a1');
      ok('a stopped and a running agent in the stub', tax?.state === 'STOPPED' && run?.state === 'RUNNING');
      const tag = 'hatchabot-runtime:2026.9.9';
      const rebuilds = (id) => calls('POST', new RegExp('/v1/agents/' + id + '/rebuild$'));
      const patches = (id) => calls('PATCH', new RegExp('/v1/agents/' + id + '$'));
      const pick = (...ids) => { tryOnAgent(tag); for (const id of ids) tryPick(id, true); };
      try {
        pick(run.id, tax.id);
        window.__confirmAnswer = false;
        const pinned = patches(tax.id).length;
        await runTryOnAgents();
        const asked = window.__confirms.at(-1);
        ok('the question says the stopped one waits: ' + asked, /The 1 running rebuild now/.test(asked) && /The 1 other is not running, so it stays that way and moves onto it when it next starts/.test(asked));
        ok('and does not promise to rebuild both', !/rebuild them now/.test(asked));
        eq('refused: nothing sent', patches(tax.id).length, pinned);
        window.__confirmAnswer = true;
        const before = rebuilds(tax.id).length;
        const waits = { status: 202, body: { rebuilding: false, atNextStart: true } };
        window.__answer = { ['POST /v1/agents/' + run.id + '/rebuild']: [{ status: 202, body: { rebuilding: true } }], ['POST /v1/agents/' + tax.id + '/rebuild']: [waits] };
        await runTryOnAgents();
        eq('both pinned', [patches(run.id).at(-1)?.body, patches(tax.id).at(-1)?.body], [{ image: tag }, { image: tag }]);
        eq('the stopped one is only asked to wait', [rebuilds(tax.id).length - before, rebuilds(tax.id).at(-1)?.body], [1, { checkpoint: true, stoppedWaits: true }]);
        eq('the running one rebuilds, memory saved first, and waits if it stopped meanwhile', rebuilds(run.id).at(-1)?.body, { checkpoint: true, stoppedWaits: true });
        ok('the result says both: ' + toastText(), /1 agent rebuilding/.test(toastText()) && /1 not running: it stays that way and moves onto/.test(toastText()));
        // Stopped since the page last looked: the server keeps it for its next start, and the page says so.
        pick(run.id);
        window.__answer = { ['POST /v1/agents/' + run.id + '/rebuild']: [{ status: 202, body: { rebuilding: false, atNextStart: true } }] };
        await runTryOnAgents();
        ok('not "rebuilding": ' + toastText(), /1 not running/.test(toastText()) && !/rebuilding/.test(toastText()));
        // Shown stopped, but woken since (a message on its bot): the server rebuilds it, and the page says so.
        pick(tax.id);
        window.__answer = { ['POST /v1/agents/' + tax.id + '/rebuild']: [{ status: 202, body: { rebuilding: true } }] };
        const woken = rebuilds(tax.id).length;
        await runTryOnAgents();
        eq('asked, not skipped', rebuilds(tax.id).length, woken + 1);
        ok('rebuilding: ' + toastText(), /1 agent rebuilding/.test(toastText()) && !/not running/.test(toastText()));
        // Discard the trial on the stopped one: asked as such, and no rebuild.
        window.__confirmAnswer = false;
        await discardTrial(tax.id, tax.name);
        ok('the question says it stays stopped: ' + window.__confirms.at(-1), /It is not running, so it stays that way/.test(window.__confirms.at(-1)) && !/rebuild it now/.test(window.__confirms.at(-1)));
        window.__confirmAnswer = true;
        window.__answer = { ['PATCH /v1/agents/' + tax.id]: [{ status: 200, body: { id: tax.id, image: null, sameImage: false } }], ['POST /v1/agents/' + tax.id + '/rebuild']: [waits] };
        const asks = rebuilds(tax.id).length;
        await discardTrial(tax.id, tax.name);
        eq('unpinned', patches(tax.id).at(-1)?.body, { image: null });
        eq('the stopped one is only asked to wait', [rebuilds(tax.id).length - asks, rebuilds(tax.id).at(-1)?.body], [1, { stoppedWaits: true }]);
        ok('the result says it: ' + toastText(), /stays stopped and moves onto the fleet default when it next starts/.test(toastText()));
        // Shown stopped, woken since: rebuilt onto the fleet default, or nothing would ever move it back.
        window.__answer = { ['PATCH /v1/agents/' + tax.id]: [{ status: 200, body: { id: tax.id, image: null, sameImage: false } }], ['POST /v1/agents/' + tax.id + '/rebuild']: [{ status: 202, body: { rebuilding: true } }] };
        await discardTrial(tax.id, tax.name);
        eq('asked again', rebuilds(tax.id).length, asks + 2);
        ok('rebuilding: ' + toastText(), /is rebuilding on the fleet default/.test(toastText()));
        // The running one: rebuilt now, as before.
        window.__answer = { ['PATCH /v1/agents/' + run.id]: [{ status: 200, body: { id: run.id, image: null, sameImage: false } }], ['POST /v1/agents/' + run.id + '/rebuild']: [{ status: 202, body: { rebuilding: true } }] };
        await discardTrial(run.id, run.name);
        ok('a running one is asked about a rebuild now', /rebuild it now/.test(window.__confirms.at(-1)));
        eq('and rebuilt', rebuilds(run.id).at(-1)?.body, { stoppedWaits: true });
        ok('rebuilding: ' + toastText(), /is rebuilding on the fleet default/.test(toastText()));
        // Unpinned, but the rebuild refused (another operation): said as such, and the list redrawn unpinned.
        const busy = { status: 409, body: { error: 'Another operation is already running on this agent.' } };
        window.__answer = { ['PATCH /v1/agents/' + tax.id]: [{ status: 200, body: { id: tax.id, image: null, sameImage: false } }], ['POST /v1/agents/' + tax.id + '/rebuild']: [busy] };
        let reads = calls('GET', /^\/v1\/runtime\/images$/).length;
        await discardTrial(tax.id, tax.name);
        ok('unpinned, not rebuilt: ' + toastText(), /"Tax Filing" is unpinned, but was not rebuilt: Another operation/.test(toastText()) && /moves onto the fleet default when it next starts/.test(toastText()));
        ok('and the images redrawn', calls('GET', /^\/v1\/runtime\/images$/).length > reads);
        // A pin saved whose rebuild was refused is not "failed"; a PATCH refused is "not pinned".
        pick(run.id, tax.id);
        window.__answer = { ['POST /v1/agents/' + run.id + '/rebuild']: [busy], ['PATCH /v1/agents/' + tax.id]: [{ status: 400, body: { error: 'That image cannot read its data.' } }] };
        await runTryOnAgents();
        const listed = document.getElementById('tryErr').textContent;
        ok('pinned, not rebuilt: ' + listed, /Homework Helper: pinned, but not rebuilt yet: Another operation/.test(listed));
        ok('not pinned: ' + listed, /Tax Filing: not pinned: That image cannot read its data/.test(listed));
        ok('and a toast for it: ' + toastText(), /1 pinned, but not rebuilt yet/.test(toastText()));
        tryDlg.close();
        // Bulk actions → Image: the server decides too, shown stopped or not.
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === tax.id || cb.dataset.id === run.id; });
        document.getElementById('faAction').value = 'image'; faRenderAction();
        const o = document.createElement('option'); o.value = tag; document.getElementById('faImage').replaceChildren(o); document.getElementById('faImage').value = tag;
        const bulk = rebuilds(tax.id).length;
        window.__answer = { ['POST /v1/agents/' + tax.id + '/rebuild']: [{ status: 202, body: { rebuilding: true } }], ['POST /v1/agents/' + run.id + '/rebuild']: [waits] };
        await faApply();
        await until(() => !document.getElementById('faApplyBtn').disabled);
        eq('the one shown stopped is asked too', rebuilds(tax.id).length, bulk + 1);
        ok('the waiting one is said: ' + document.getElementById('faResults').textContent, /1 not running, so it moves when it next starts/.test(document.getElementById('faResults').textContent));
        // Another image: the one above now reads as where they already are.
        const o2 = document.createElement('option'); o2.value = 'hatchabot-runtime:2026.9.10'; document.getElementById('faImage').replaceChildren(o2); document.getElementById('faImage').value = o2.value;
        window.__answer = { ['POST /v1/agents/' + tax.id + '/rebuild']: [busy], ['POST /v1/agents/' + run.id + '/rebuild']: [{ status: 202, body: { rebuilding: true } }] };
        await faApply();
        await until(() => !document.getElementById('faApplyBtn').disabled);
        ok('pinned, not rebuilt: ' + document.getElementById('faResults').textContent, /1 pinned, but not rebuilt yet/.test(document.getElementById('faResults').textContent) && !/failed/.test(document.getElementById('faResults').textContent));
        ok('with its reason: ' + document.getElementById('faErr').textContent, /pinned, but not rebuilt yet: Another operation/.test(document.getElementById('faErr').textContent));
      } finally { window.__confirmAnswer = true; window.__answer = {}; tryState = null; if (tryDlg.open) tryDlg.close(); if (fleetActionsDlg.open) fleetActionsDlg.close(); }
    },
    oneTokenForm: async () => {
      // An agent waiting for a bot shows ONE token box: two with the same id sent the empty one.
      const list = await (await fetch('/v1/agents')).json();
      window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, pendingAction: { type: 'bot_token', instructions: 'Make a bot with BotFather' } } : a);
      await refresh(false);
      openV2Agent('a1', 'overview');
      await until(() => document.getElementById('tok-a1'));
      eq('token boxes', document.querySelectorAll('[id="tok-a1"]').length, 1);
      v2Close();
      delete window.__override['/v1/agents'];
      await refresh(false);
    },
    // The paste-a-token box sends the token again when Telegram did not
    // answer, or the connection dropped, as adopt does (thirteenth review).
    tokenFormRetries: async () => {
      window.__answer = window.__answer || {};
      const list = await (await fetch('/v1/agents')).json();
      window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, pendingAction: { type: 'bot_token', instructions: 'Make a bot with BotFather' } } : a);
      try {
        await refresh(false);
        openV2Agent('a1', 'overview');
        const box = await until(() => document.getElementById('tok-a1'));
        box.value = '123456:made-up-token-for-the-test';
        window.__answer['POST /v1/agents/a1/channel-token'] = [
          { status: 503, body: { error: 'Telegram did not answer in time. Try again in a minute.' } },
          { reject: 'Failed to fetch' },
          { status: 202, body: { username: 'made_up_bot', stepAnswered: true } }];
        window.__calls.length = 0;
        await submitToken('a1'); await sleep(50);
        const posts = window.__calls.filter((c) => c.method === 'POST' && c.path === '/v1/agents/a1/channel-token');
        ok('the token is sent again after no answer and a dropped connection (' + posts.length + ' posts)', posts.length === 3 && posts.every((c) => c.body?.token === '123456:made-up-token-for-the-test'));
        ok('and no error is left showing: ' + (document.getElementById('tokerr-a1')?.textContent ?? ''), !document.getElementById('tokerr-a1')?.textContent);
        // A refusal is not sent again, and is said.
        window.__answer['POST /v1/agents/a1/channel-token'] = [{ status: 400, body: { error: 'That token was not accepted by Telegram.' } }];
        window.__calls.length = 0;
        await submitToken('a1'); await sleep(50);
        eq('a refused token is posted once', window.__calls.filter((c) => c.method === 'POST' && c.path === '/v1/agents/a1/channel-token').length, 1);
        ok('and the refusal is said', /not accepted by Telegram/.test(document.getElementById('tokerr-a1')?.textContent ?? ''));
      } finally {
        delete window.__answer['POST /v1/agents/a1/channel-token'];
        delete window.__override['/v1/agents'];
        v2Close();
        await refresh(false);
      }
    },
    welcomeNeedsToken: async () => {
      // The Welcome card used to offer "leave the token blank" on Linux, which the
      // server has refused since v2.39.0: it must ask for a token and never send a blank one.
      const saved = { profiles, hostOs: myAccount.hostOs, hostOwner: myAccount.hostOwner, open: setupOpen };
      try {
        profiles = []; myAccount.hostOs = 'linux'; myAccount.hostOwner = true; setupOpen = true;
        renderSetup();
        const input = await until(() => document.getElementById('setupToken'));
        ok('no "blank" in the placeholder: ' + input.placeholder, !/blank/i.test(input.placeholder));
        ok('no "leave the token blank" offer', !/leave the token blank/i.test(document.getElementById('setup').textContent));
        input.value = '';
        const posts = calls('POST', /\/v1\/ai-profiles$/).length;
        await createSubscriptionProfile();
        ok('says a token is needed', /claude setup-token/.test(document.getElementById('setupErr').textContent));
        eq('nothing sent', calls('POST', /\/v1\/ai-profiles$/).length, posts);
      } finally {
        profiles = saved.profiles; myAccount.hostOs = saved.hostOs; myAccount.hostOwner = saved.hostOwner; setupOpen = saved.open;
        renderSetup();
      }
    },
    agentUsagePage: async () => {
      // ⋯ → Usage says where the tokens went: the last day, the conversation size, the split, the calls (v2.102.0).
      window.__override['/v1/agents/a1/usage'] = { totalTokens: 1_000_000_000, input: 7e6, output: 2e6, cacheRead: 851e6, cacheWrite: 140e6, calls: 4700, sessions: 12,
        lastActive: new Date().toISOString(), lastDay: { calls: 400, tokens: 109e6 }, lastContext: 395_000, maxContext: 410_000,
        byModel: [{ model: 'claude-opus-4-8', tokens: 1e9, calls: 4700, sessions: 12, maxContext: 410_000, input: 7e6, output: 2e6, cacheRead: 851e6, cacheWrite: 140e6 }],
        alerts: [{ agentId: 'a1', at: new Date(Date.now() - 30 * 3600e3).toISOString(), tokens: 109e6, usual: 20e6, told: true },
          { agentId: 'a1', at: new Date().toISOString(), tokens: 121e6, usual: 11e6, told: true }] };
      await openUsage('a1', 'Homework Helper');
      const body = await until(() => { const t = document.getElementById('usageBody').textContent; return t.includes('Last 24 hours') ? t : null; });
      ok('the last day: ' + body.slice(0, 200), /Last 24 hours:\s*109M tokens · 400 calls/.test(body));
      ok('the conversation size, and why it matters', body.includes('Conversation size now:') && body.includes('395K') && body.includes('Every call carries this much in'));
      const pie = document.querySelector('#usageBody svg[aria-label="Where the tokens went"]');
      ok('the split is a donut, the total in the middle', !!pie && pie.textContent.includes('1B') && pie.querySelectorAll('circle').length === 4);
      ok('its legend: cache reads 851M, 85%', /Cache reads\s*851M\s*85%/.test(pie.parentElement.textContent));
      ok('a slice says its part on hover', [...pie.querySelectorAll('circle title')].some((x) => x.textContent === 'Cache reads: 851M (85%)'));
      ok('calls per model', body.includes('4.7k calls'));
      ok('its warning of earlier this week', body.includes('about 5× its usual day'));
      ok("today's is a Recommended item, not a second warning here", !body.includes('about 11× its usual day'));
      usageDlg.close();
      // The same page as a tab on the agent's sheet.
      try {
        openV2Agent('a1', 'usage');
        ok('a Usage tab', !!byText('#v2Tabs button', 'Usage'));
        await until(() => (document.getElementById('v2UsageBody') || {}).textContent?.includes('Conversation size now'))
          .catch(() => { throw new Error('the Usage tab showed: ' + JSON.stringify((document.getElementById('v2UsageBody') || { textContent: '(no tab body)' }).textContent.slice(0, 160)) + ' state=' + JSON.stringify(agents.find((x) => x.id === 'a1')?.state)); });
      } finally { v2Close(); delete window.__override['/v1/agents/a1/usage']; }
    },
    billingLineIds: async () => {
      // The usage page's price line finds a model by its own id: a provider prefix or a dated id found none (HB-0067).
      const saved = profiles, a = agents.find((x) => x.id === 'a1'), was = a.aiProfileId;
      try {
        profiles = [...profiles, { id: 'pk-spare', name: 'Spare key', vendor: 'anthropic', kind: 'api_key' }];
        a.aiProfileId = 'pk-spare';
        const line = billingLine('a1', ['anthropic/claude-sonnet-5-20260115']);
        ok('a prefixed, dated id still finds its price: ' + line, line.includes('anthropic/claude-sonnet-5-20260115 at $' + MODEL_PRICES['claude-sonnet-5'][0] + '/$'));
      } finally { profiles = saved; a.aiProfileId = was; }
    },
    agentUsageReadFails: async () => {
      // A read that fails says so; it used to read "No sessions yet — nothing used" (review, 2026-09-29).
      window.__answer = { 'GET /v1/agents/a1/usage': [{ status: 502, body: { error: "Couldn't read Homework Helper's usage: usage read exited 3: database is locked" } }] };
      await openUsage('a1', 'Homework Helper');
      const body = await until(() => { const t = document.getElementById('usageBody').textContent; return t.includes("Couldn't read") ? t : null; });
      ok('names the failure: ' + body.slice(0, 200), body.includes('database is locked'));
      ok('not "nothing used"', !body.includes('nothing used'));
      usageDlg.close(); window.__answer = {};
    },
    reopenRightAway: async () => {
      // Close one agent's sheet and open another in the same moment: the late
      // close event used to clear the new one, leaving the sheet deaf (2026-09-29).
      openV2Agent('a1', 'overview');
      v2Close();
      openV2Agent('a2', 'overview');
      await sleep(50);
      eq('the sheet shows the agent just opened', v2AgentId, 'a2');
      v2Close();
      await sleep(50);
    },
    usageHours: async () => {
      // Usage (2026-10-05): the warnings, At API prices and the savings — no By agent table, no period pills.
      const now = Date.now(), at = (m) => new Date(Math.floor((now - m * 60000) / 900000) * 900000).toISOString();
      window.__override['/v1/usage/periods'] = { period: 'day', from: at(1440), to: new Date(now).toISOString(), bucketMinutes: 60, buckets: [],
        agents: [{ id: 'a1', name: 'Homework Helper', state: 'RUNNING', tokens: 5000, requests: 2, limited: 0, billing: 'included', cost: null }],
        totals: { tokens: 5000, requests: 2, limited: 0 }, byBilling: { included: 5000, api: 0, local: 0 }, cost: null };
      openFleetUsage();
      const body = await until(() => document.querySelector('#fleetUsageBody .spendchart') && document.getElementById('fleetUsageBody'));
      ok('asks for the day', calls('GET', /\/v1\/usage\/periods$/).some((c) => c.url.includes('period=day')));
      ok('no By agent section', !body.querySelector('table') && !body.textContent.includes('By agent'));
      ok('no period pills outside the chart', ![...body.querySelectorAll('.su-period')].some((b) => !b.closest('.spendchart')));
      ok('one spend chart for the fleet', body.querySelectorAll('.spendchart').length === 1 && body.querySelector('.spendchart').dataset.agent === '');
      ok('model prices sits by the heading', !!document.getElementById('fleetUsagePrices'));
      ok('no failure line on a clean day', !document.getElementById('usageFailed'));
      fleetUsageDlg.close();
      window.__override['/v1/usage/periods'] = { ...window.__override['/v1/usage/periods'],
        agents: [{ id: 'a1', name: 'Homework Helper', state: 'RUNNING', tokens: 5000, requests: 20, limited: 9, failed: 1, billing: 'included', cost: null },
                 { id: 'a2', name: 'Soccer Schedule', state: 'RUNNING', tokens: 900, requests: 4, limited: 3, failed: 0, billing: 'included', cost: null }],
        totals: { tokens: 5900, requests: 24, limited: 12, failed: 1 } };
      openFleetUsage();
      const fl = await until(() => document.getElementById('usageFailed'));
      ok('one line with what did not go through: ' + fl.textContent, fl.textContent.includes('12 refused (rate limits) · 1 failed — Homework Helper 10 · Soccer Schedule 3'));
      fleetUsageDlg.close(); delete window.__override['/v1/usage/periods'];
      // A spike warning of the last week shows at the top; one of the last day is a Recommended item instead (v2.158.0).
      window.__override['/v1/usage/periods'] = { period: 'day', from: at(1440), to: new Date(now).toISOString(), bucketMinutes: 60, buckets: [],
        agents: [], totals: { tokens: 0, requests: 0, limited: 0 }, byBilling: {}, cost: null,
        alerts: [{ agentId: 'a1', name: 'Homework Helper', at: new Date(now - 26 * 3600000).toISOString(), tokens: 100e6, usual: 20e6, told: true },
          { agentId: 'a2', name: 'Soccer Schedule', at: new Date(now - 27 * 3600000).toISOString(), tokens: 60e6, usual: 20e6, told: true },
          { agentId: 'a3', name: 'Piano Practice', at: new Date(now - 3600000).toISOString(), tokens: 70e6, usual: 10e6, told: true }],
        pricing: { hours: 24, total: 123.4, monthly: 3702, parts: { cacheWrite: 82.1, output: 16.3, cacheRead: 20, input: 5 }, billing: { api: 0, plan: 123.4 },
          models: [{ model: 'claude-sonnet-5', cost: 100 }, { model: 'claude-opus-4-8', cost: 23.4 }], agents: {} } };
      openFleetUsage();
      await until(() => document.getElementById('fleetUsageBody').textContent.includes('about 5× its usual day'));
      const body2 = document.getElementById('fleetUsageBody');
      ok("the last day's spike is not in the box (it is under Recommended)", !body2.textContent.includes('Piano Practice') && body2.textContent.includes('Earlier this week'));
      ok('no intro paragraph', !fleetUsageDlg.textContent.includes('Usage, not a bill'));
      ok('a plan is a footnote, not a paragraph', body2.textContent.includes('* Claude plan use priced at API rates — not money you pay.') && !body2.textContent.includes('the room it takes'));
      ok('the title is Usage', fleetUsageDlg.querySelector('.v2ptitle, h3').textContent.trim().startsWith('Usage'));
      const mark = window.__calls.length;
      body2.querySelector('button[aria-label="Clear this warning"]').click();
      const one = await until(() => window.__calls.slice(mark).find((c) => c.method === 'POST' && c.path === '/v1/usage/alerts/dismiss'));
      eq('clears that one', one.body, { agentId: 'a1', at: new Date(now - 26 * 3600000).toISOString() });
      byText('#fleetUsageBody button', 'Clear all').click();
      const all = await until(() => window.__calls.slice(mark).filter((c) => c.path === '/v1/usage/alerts/dismiss')[1]);
      eq('Clear all clears every one', all.body, {});
      fleetUsageDlg.close(); delete window.__override['/v1/usage/periods'];
    },
    spendChart: async () => {
      // Spend over time: stacked parts at API prices, tokens on the right axis — the same chart for all agents and for one (made-up figures).
      const now = Date.now(), H = 3600e3;
      const series = (agent) => ({ range: 'week', bucketHours: 3, planShare: 1, monthly: 823, models: [{ model: 'claude-opus-4-8', cost: 150 }, { model: 'claude-sonnet-5', cost: 42 }],
        choices: agent ? [] : [{ id: 'a1', name: 'Homework Helper', cost: 150 }, { id: 'a2', name: 'Soccer Schedule', cost: 42 }],
        buckets: Array.from({ length: 56 }, (_, i) => ({ at: new Date(now - (56 - i) * 3 * H).toISOString(), cacheWrite: i % 7 ? 2 : 6, cacheRead: 0.5, output: 0.4, input: 0.1, tokens: (i % 5 + 1) * 3e6, ...(i === 40 ? { refused: 3 } : {}) })),
        totals: { cacheWrite: 136, cacheRead: 28, output: 22.4, input: 5.6, cost: 192, tokens: 504e6 }, refused: 3 });
      window.__override['/v1/usage/spend'] = series('');
      const box = document.createElement('div'); box.innerHTML = spendChartBox(''); document.body.append(box);
      await loadSpendCharts(box);
      const svg = await until(() => box.querySelector('svg'));
      ok('Usage shades the slices with refused calls too (2026-10-07)', box.querySelectorAll('svg rect[fill-opacity=".22"]').length === 1 && box.textContent.includes('shaded: 3 calls refused'));
      ok('no summary line: the total sits in the pies', !box.textContent.includes('in the last 7 days ·') && box.querySelector('svg[aria-label="What it went on"]').textContent.includes('$192'));
      ok('the tokens in all, inside the chart', [...box.querySelectorAll('svg')].pop().textContent.includes('504M tokens in the last 7 days'));
      ok('the monthly pace under the chart', box.textContent.includes('≈ $823* a month at this pace'));
      const pie = box.querySelector('svg[aria-label="What it went on"]');
      ok('a pie of what it went on', !!pie && pie.querySelectorAll('circle').length === 4 && pie.textContent.includes('$192'));
      ok('its parts with amounts and shares', box.textContent.includes('Cache writes') && box.textContent.includes('$136') && box.textContent.includes('71%'));
      const mpie = box.querySelector('svg[aria-label="By model"]');
      ok('a second pie, by model', !!mpie && mpie.querySelectorAll('circle').length === 2);
      ok('its legend: each model, amount and share', box.textContent.includes('opus-4-8') && box.textContent.includes('$150') && box.textContent.includes('78%') && box.textContent.includes('sonnet-5'));
      ok('a model keeps its colour', mpie.querySelector('circle').getAttribute('stroke') === '#2a78d6');
      const many = modelPieSlices(Array.from({ length: 9 }, (_, i) => ({ model: 'claude-x-' + i, cost: 9 - i })));
      ok('past seven, the rest are "others"', many.length === 8 && many[7].label === '2 others' && new Set(many.slice(0, 7).map((x) => x.color)).size === 7);
      const svgs = box.querySelectorAll('svg');
      const bars = svgs[svgs.length - 1];
      ok('stacked: four parts in a bar', bars.querySelectorAll('g')[0].querySelectorAll('rect').length === 5);
      // The agent picker: all, or a combination.
      ok('picker says All agents', box.querySelector('.spendpick summary').textContent.includes('All agents'));
      box.querySelector('.spendpick summary').click();
      await sleep(20);
      const mark0 = window.__calls.length;
      box.querySelector('.spendpick input[value="a2"]').click();
      await until(() => window.__calls.slice(mark0).some((c) => c.url.includes('agents=a2')));
      await until(() => box.querySelector('.spendpick summary')?.textContent.includes('Soccer Schedule'));
      box.querySelector('.spendpick input:not([value])').click(); // All agents again
      await until(() => box.querySelector('.spendpick summary')?.textContent.includes('All agents'));
      ok('still open while picking', box.querySelector('.spendpick').open);
      document.body.click();
      ok('a click elsewhere closes it', !box.querySelector('.spendpick').open);
      box.querySelector('.spendpick summary').click();
      ok('it opens again', box.querySelector('.spendpick').open);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      ok('Escape closes it', !box.querySelector('.spendpick').open);
      box.querySelector('.spendpick summary').click();
      byText('.spendpick button', 'Done').click();
      ok('Done closes it', !box.querySelector('.spendpick').open);
      ok('the Cost view\'s windows', [...box.querySelectorAll('.su-period')].map((b) => b.textContent).join('|') === V2_COST_PERIODS.map(([, l]) => l).join('|'));
      const svg2 = [...box.querySelectorAll('svg')].pop();
      ok('a token line', !!svg2.querySelector('polyline'));
      ok('a dollar axis and a token axis', svg2.textContent.includes('$') && /M/.test(svg2.textContent));
      ok('the legend names the right axis', box.textContent.includes('Tokens (right axis)'));
      ok('a hover tip per slice', svg2.querySelector('title').textContent.includes('cache writes'));
      const mark = window.__calls.length;
      byText('.spendchart button', '1 mo').click();
      await until(() => window.__calls.slice(mark).some((c) => c.url.includes('/v1/usage/spend?range=month')));
      // Day bars start at the page's midnight: it sends its zone (audit, 2026-10-20).
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      ok('the chart asks in the page\'s zone', window.__calls.slice(mark).some((c) => c.url.includes('&tz=' + encodeURIComponent(zone))));
      box.remove();
      // An agent's Usage tab carries the same chart, for it alone.
      const html = usageHTML({ totalTokens: 1e6, calls: 3, sessions: 1, byModel: [] }, 'a1');
      ok('the agent view has it', html.includes('class="spendchart" data-agent="a1"'));
      ok('no picker for one agent', !spendChartHTML(series('a1'), { fleet: false }).includes('spendpick'));
      delete window.__override['/v1/usage/spend']; try { localStorage.removeItem('hb-spend-range'); localStorage.removeItem('hb-spend-agents'); } catch {} spendRange = 'week'; spendAgents = [];
    },
    rightSizeLine: async () => {
      // Usage: "Saved by cheaper models" — each switch, what it cost and would have cost (was the Right-size line).
      const now = Date.now();
      const base = { period: 'day', from: new Date(now - 864e5).toISOString(), to: new Date(now).toISOString(), bucketMinutes: 60, buckets: [],
        agents: [], totals: { tokens: 0, requests: 0, limited: 0 }, byBilling: {}, cost: null };
      window.__override['/v1/usage/periods'] = { ...base, rightSize: { line: 'Right-size: ≈ $12.40 this month', savingUSD: 12.4, apiUSD: 0, planUSD: 12.4, month: '2026-10',
        rows: [{ agentId: 'a1', agent: 'Homework Helper', from: 'claude-opus-4-8', to: 'claude-sonnet-5', since: new Date(now - 4 * 864e5).toISOString(), billing: 'plan', isUSD: 8.2, wasUSD: 20.6, savingUSD: 12.4 }] } };
      openFleetUsage();
      const head = await until(() => document.getElementById('savedByModels'));
      ok('a section, its total in the heading: ' + head.textContent, head.textContent.includes('Saved by cheaper models') && head.textContent.includes('$12') && head.textContent.includes('*'));
      const tbl = head.nextElementSibling;
      ok('each switch: from → to, cost now, on the old model, saved', tbl.textContent.includes('claude-opus-4-8 → claude-sonnet-5') && tbl.textContent.includes('$8.20*') && tbl.textContent.includes('$21*') && tbl.textContent.includes('$12*'));
      ok('no "Right-size" jargon on the page', !document.getElementById('fleetUsageBody').textContent.includes('Right-size'));
      fleetUsageDlg.close();
      window.__override['/v1/usage/periods'] = base;
      const asked = calls('GET', /\/v1\/usage\/periods$/).length;
      openFleetUsage();
      await until(() => calls('GET', /\/v1\/usage\/periods$/).length > asked && !!document.querySelector('#fleetUsageBody .spendchart'));
      await sleep(50);
      ok('no section when nothing was saved', !document.getElementById('savedByModels'));
      fleetUsageDlg.close(); delete window.__override['/v1/usage/periods'];
    },
    sheetPollKeepsTabs: async () => {
      // A poll must not reload the Files or Discord tab under someone (night review #18).
      // Cleans up even when it fails: a leftover STOPPED override broke the checks after it.
      try { await sheetPollKeepsTabsBody(); }
      finally { try { v2Close(); } catch {} delete window.__override['/v1/agents']; delete window.__override['/v1/agents/a1/fs']; delete window.__override['/v1/agents/a2/channels']; await refresh(false); }
    },
  };
  async function sheetPollKeepsTabsBody() {
      window.__override['/v1/agents/a1/fs'] = { path: '', entries: [{ name: 'notes.md', type: 'file', size: 10 }] };
      const fsCalls = () => calls('GET', /\/v1\/agents\/a1\/fs$/).length;
      openV2Agent('a1', 'files');
      const note = await until(() => document.getElementById('v2UploadNote')).catch(() => { throw new Error('the Files tab never showed its upload note'); });
      note.hidden = false; note.textContent = 'Uploading big.zip…';
      const before = fsCalls();
      await refresh(false);
      eq('no new listing on a poll', fsCalls(), before);
      ok('the upload note survives', document.getElementById('v2UploadNote')?.textContent === 'Uploading big.zip…');
      // A real change to the agent still repaints the tab.
      const list = await (await fetch('/v1/agents')).json();
      window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, state: 'STOPPED' } : a);
      // Nobody typing: the sheet rightly holds still while a field has focus,
      // and where focus landed varied from run to run (the old flake).
      document.activeElement?.blur?.();
      await refresh(false);
      await until(() => fsCalls() > before).catch(() => {
        const pane = document.getElementById('v2Pane');
        const a = agents.find((x) => x.id === 'a1');
        const filled = [...pane.querySelectorAll('input, textarea, select')].filter((i) => (i.value && i.tagName !== 'SELECT') || i === document.activeElement).map((i) => i.id || i.name || i.tagName);
        throw new Error('a real change (stopped) did not repaint the Files tab: tab=' + v2Tab + ' open=' + v2AgentDlg.open + ' state=' + a?.state + ' sigChanged=' + (v2SheetSigOf(a) !== v2SheetSig) + ' filled=' + JSON.stringify(filled) + ' fs=' + fsCalls() + '/' + before);
      });
      v2Close(); delete window.__override['/v1/agents']; delete window.__override['/v1/agents/a1/fs'];
      await refresh(false);
      // Discord: a group-chat choice not yet saved is not reverted by a poll.
      window.__override['/v1/agents/a2/channels'] = { channels: [{ kind: 'discord', rooms: { mode: 'off' } }], imageSupports: ['discord'] };
      openV2Agent('a2', 'channels');
      const sel = await until(() => document.getElementById('chanRoomMode-discord'));
      sel.value = 'room'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      const chans = calls('GET', /\/v1\/agents\/a2\/channels$/).length;
      await refresh(false);
      eq('no new channels read on a poll', calls('GET', /\/v1\/agents\/a2\/channels$/).length, chans);
      eq('the choice stays', document.getElementById('chanRoomMode-discord')?.value, 'room');
  }
  // 2026-10-23 (Chris's list): the Data tab says what each button does and where a repo lands; Test checks a source; Files sort and open in place; the console opens at once; own bots only; Context now.
  Object.assign(T, {
    dataTabSaysWhatItDoes: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const a = list.find((x) => x.id === 'a1');
      try {
        openV2Agent('a1', 'knowledge');
        await until(() => document.getElementById('dataList'));
        editAgentId = 'a1';
        renderDataList([
          { id: 'd1', kind: 'folder', access: 'ro', mountName: 'notes', hostPath: '/home/you/notes' },
          { id: 'g1', kind: 'git', access: 'rw', mountName: 'thing', repoUrl: 'git@github.com:example-owner/thing.git', pubKey: 'ssh-ed25519 AAAAC3made-up-key-for-the-test test' },
        ]);
        const folderRow = document.querySelector('#dataList [data-ds="d1"]'), repoRow = document.querySelector('#repoList [data-ds="g1"]');
        ok('both rows drawn', !!folderRow && !!repoRow);
        ok('the folder\'s button says what it does: Make writable', [...folderRow.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Make writable'));
        ok('the repo\'s button says Make read-only', [...repoRow.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Make read-only'));
        ok('no arrow-style state words', !/→ writable|→ read-only/.test(folderRow.textContent + repoRow.textContent));
        ok('the repo row says where it is cloned', repoRow.textContent.includes('~/.openclaw/thing'));
        const key = document.getElementById('gitKeyOut'), repos = document.getElementById('repoList');
        ok('the deploy key box sits above the repo list, not in the drawer below', !!(key.compareDocumentPosition(repos) & Node.DOCUMENT_POSITION_FOLLOWING) && !key.closest('details'));
        // Test on the repo: the host refused the key → the message under the row, and the key shown again.
        window.__answer = window.__answer || {};
        window.__answer['POST /v1/agents/a1/data-sources/g1/check'] = [{ body: { ok: false, reason: 'key-not-added', message: 'The git host refused the deploy key. Add it to the repo (🔑 Deploy key), then test again.' } }];
        [...repoRow.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Test').click();
        await until(() => repoRow.querySelector('.ds-check')?.textContent.includes('refused the deploy key'));
        ok('a warning mark', repoRow.querySelector('.ds-check').textContent.startsWith('⚠️'));
        ok('the key is shown again, with its link', key.style.display !== 'none' && key.textContent.includes('Add deploy key') && key.textContent.includes('made-up-key'));
        eq('one check request', calls('POST', /\/v1\/agents\/a1\/data-sources\/g1\/check$/).length, 1);
        // Test on the folder: fine.
        window.__answer['POST /v1/agents/a1/data-sources/d1/check'] = [{ body: { ok: true, message: 'The folder is there and readable. The agent sees it at /data/notes after its next Rebuild.' } }];
        [...folderRow.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Test').click();
        await until(() => folderRow.querySelector('.ds-check')?.textContent.includes('/data/notes'));
        ok('a tick', folderRow.querySelector('.ds-check').textContent.startsWith('✅'));
      } finally {
        try { v2Close(); } catch {}
        renderDataList(a?.dataSources || []);
        document.getElementById('gitKeyOut').style.display = 'none';
      }
    },
    filesSortAndOpenInPlace: async () => {
      const day = (d) => '2026-10-' + String(d).padStart(2, '0') + 'T12:00:00.000Z';
      window.__override['/v1/agents/a1/fs'] = { path: '', entries: [
        { name: 'b.md', type: 'file', size: 10, mtime: day(1) },
        { name: 'a.txt', type: 'file', size: 300, mtime: day(20) },
        { name: 'zdir', type: 'dir', size: 0, mtime: day(5) },
        { name: 'c.txt', type: 'file', size: 2000, mtime: day(10) },
      ] };
      window.__override['/v1/agents/a1/fs/file'] = 'hello from the stub file';
      const names = () => [...document.querySelectorAll('#v2FilesDrop tbody tr td:first-child')].map((td) => td.textContent.replace(/^[^\w.]+/, '').trim());
      const header = (label) => [...document.querySelectorAll('#v2FilesDrop thead a')].find((a) => a.textContent.startsWith(label));
      try {
        v2FilesSort = { key: 'name', dir: 1 };
        openV2Agent('a1', 'files');
        await until(() => document.querySelector('#v2FilesDrop tbody tr'));
        eq('folders first, then files by name', names(), ['zdir/', 'a.txt', 'b.md', 'c.txt']);
        header('Changed').click();
        await until(() => names()[1] === 'a.txt' && header('Changed')?.textContent.includes('▼'));
        eq('by when changed, newest first; the folder stays first', names(), ['zdir/', 'a.txt', 'c.txt', 'b.md']);
        header('Changed').click();
        await until(() => header('Changed')?.textContent.includes('▲'));
        eq('again: oldest first', names(), ['zdir/', 'b.md', 'c.txt', 'a.txt']);
        header('Size').click();
        await until(() => header('Size')?.textContent.includes('▼'));
        eq('by size, largest first', names(), ['zdir/', 'c.txt', 'a.txt', 'b.md']);
        ok('the order is remembered on this device', JSON.parse(localStorage.getItem('hb-files-sort')).key === 'size');
        header('Name').click();
        await until(() => header('Name')?.textContent.includes('▲'));
        // A text file opens here, with a way back — not in a new browser tab.
        const opened = window.open; let popped = 0; window.open = () => { popped++; return null; };
        try {
          [...document.querySelectorAll('#v2FilesDrop tbody a')].find((a) => a.textContent.trim() === 'a.txt').click();
          await until(() => document.getElementById('v2FileBody'));
          ok('the file\'s text is shown in the tab', document.getElementById('v2FileBody').textContent.includes('hello from the stub file'));
          ok('no new browser tab', popped === 0);
          const back = byText('#v2Files button', '← Back');
          ok('a Back button', !!back);
          ok('still a way to a new tab and to download', !!byText('#v2Files a', 'Open in a tab') && !!document.querySelector('#v2Files a[download]'));
          back.click();
          await until(() => document.querySelector('#v2FilesDrop tbody tr'));
          eq('back in the folder, same order', names(), ['zdir/', 'a.txt', 'b.md', 'c.txt']);
        } finally { window.open = opened; }
      } finally {
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents/a1/fs']; delete window.__override['/v1/agents/a1/fs/file'];
        v2FilesSort = { key: 'name', dir: 1 }; try { localStorage.removeItem('hb-files-sort'); } catch {}
      }
    },
    filesMediaOpenInPlace: async () => {
      // Sound, video and PDF open in the tab too, with ← Back: the app on a phone's home screen has no browser
      // bar, so a new tab had no way back (Chris, 2026-10-23). What the browser cannot show only downloads.
      window.__override['/v1/agents/a1/fs'] = { path: 'media', entries: [
        { name: 'talk.mp3', type: 'file', size: 10, mtime: '' }, { name: 'clip.mp4', type: 'file', size: 10, mtime: '' },
        { name: 'plan.pdf', type: 'file', size: 10, mtime: '' }, { name: 'blob.bin', type: 'file', size: 10, mtime: '' },
      ] };
      const link = (n) => [...document.querySelectorAll('#v2FilesDrop tbody a')].find((a) => a.textContent.trim() === n);
      const realOpen = window.open; let popped = 0; window.open = () => { popped++; return null; };
      try {
        openV2Agent('a1', 'files');
        await v2LoadFiles('a1', 'media');
        await until(() => link('talk.mp3'));
        ok('a .bin is not a link (it only downloads)', !link('blob.bin') && !!byText('#v2FilesDrop td', 'blob.bin'));
        for (const [n, sel] of [['talk.mp3', 'audio[controls]'], ['clip.mp4', 'video[controls]'], ['plan.pdf', 'iframe']]) {
          link(n).click();
          const el = await until(() => document.querySelector('#v2FileBody ' + sel));
          ok(n + ' is shown by the browser\'s own ' + sel + ', inline: ' + el.getAttribute('src'), /fs\/file\?path=media%2F[\w.]+&inline=1$/.test(el.getAttribute('src')));
          ok(n + ': no new browser tab', popped === 0);
          const back = byText('#v2Files button', '← Back');
          ok(n + ': a Back button, Open in a tab and ⬇', !!back && !!byText('#v2Files a', 'Open in a tab') && !!document.querySelector('#v2Files a[download]'));
          back.click();
          await until(() => link('talk.mp3'));
        }
      } finally {
        window.open = realOpen;
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents/a1/fs']; v2FilesPath.delete('a1');
      }
    },
    consoleOpensAtOnce: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const A = list.find((x) => !x.ops && (x.role ? x.role === 'owner' : true) && x.state === 'RUNNING');
      ok('a running agent of mine', !!A);
      window.__override['/v1/agents/' + A.id + '/console/access'] = { role: 'owner', console: 'identity' };
      window.__override['/v1/agents/' + A.id + '/console/pending'] = { pending: 0 };
      try { localStorage.removeItem('hb-console-tabs'); } catch {}
      const realFetch = window.fetch;
      let release; const gate = new Promise((r) => { release = r; });
      window.fetch = async (input, init) => { const url = String(typeof input === 'string' ? input : input.url); if (url.includes('/console/access')) await gate; return realFetch(input, init); };
      try {
        const opening = openGateway(A.id, A.slug);
        await until(() => consoleDlg.open);
        const cover = document.getElementById('consoleCover');
        ok('the panel is open with a spinner BEFORE the server has answered', !cover.hidden && cover.textContent.includes('Opening the console…'));
        eq('titled with the agent', document.getElementById('consoleTitle').textContent, A.name);
        release();
        await opening;
        ok('the frame now points at the console', (document.getElementById('consoleFrame').getAttribute('src') || '').includes('/v1/agents/' + A.id + '/ui/chat'));
      } finally {
        window.fetch = realFetch;
        if (consoleDlg.open) closeConsole();
        delete window.__override['/v1/agents/' + A.id + '/console/access']; delete window.__override['/v1/agents/' + A.id + '/console/pending'];
        consoleTabs = []; try { localStorage.removeItem('hb-console-tabs'); } catch {}
      }
    },
    poolOwnBotsOnly: async () => {
      const was = myAccount.prefs;
      try {
        myAccount.prefs = { ownBotsOnly: false };
        await openAiDlg(); showTab('pool');
        await until(() => document.getElementById('poolOwnOnly') && document.getElementById('poolList').textContent !== 'Loading…');
        const box = document.getElementById('poolOwnOnly');
        ok('off to begin with', !box.checked);
        window.__answer = window.__answer || {};
        window.__answer['PATCH /v1/account/prefs'] = [{ body: { prefs: { ownBotsOnly: true }, availableBots: 0 } }];
        box.checked = true; box.dispatchEvent(new Event('change'));
        await until(() => myAccount.prefs?.ownBotsOnly === true);
        const sent = calls('PATCH', /\/v1\/account\/prefs$/);
        eq('the choice is saved at once', sent.map((c) => c.body), [{ ownBotsOnly: true }]);
        await until(() => calls('GET', /\/v1\/pool$/).length >= 2); // the pool is read again, the count following the choice
        ok('the box stays ticked after the redraw', document.getElementById('poolOwnOnly').checked);
      } finally {
        myAccount.prefs = was;
        if (aiDlg.open) aiDlg.close();
      }
    },
    settingsMessagingTab: async () => {
      // The owner (2026-11-07): Settings → Telegram, Slack and Discord on one tab, Messaging; every control kept.
      // The owner (2026-11-09): all three at once was "too much on one screen" — one at a time, picked from a list.
      const el = (id) => document.getElementById(id);
      const seen = (e) => (e.checkVisibility ? e.checkVisibility() : e.offsetParent !== null);
      const selected = () => document.querySelector('#v2SettingsTabs .tab[aria-selected="true"]')?.textContent;
      const panes = ['panePool', 'paneSlack', 'paneDiscord'].map(el);
      const showing = () => panes.filter((x) => !x.hidden && seen(x)).map((x) => x.id);
      const pick = (v) => { el('v2MsgApp').value = v; el('v2MsgApp').dispatchEvent(new Event('change')); };
      const n = (re) => calls('GET', re).length;
      try {
        localStorage.removeItem('hb-settings-messaging');
        await openAiDlg();
        const tabs = [...document.querySelectorAll('#v2SettingsTabs .tab')].map((b) => b.textContent);
        ok('one Messaging tab, none for Telegram, Slack or Discord: ' + tabs.join(' | '), tabs.includes('Messaging') && !tabs.some((x) => /^(Telegram|Slack|Discord)$/.test(x)));
        eq('between Classes and Connections', tabs.slice(tabs.indexOf('Classes'), tabs.indexOf('Classes') + 3), ['Classes', 'Messaging', 'Connections']);
        ok('no app list on the AI tab', !seen(el('v2MsgPick')));
        const before = [n(/\/v1\/pool$/), n(/\/v1\/slack-apps$/), n(/\/v1\/discord-bots$/)];
        byText('#v2SettingsTabs .tab', 'Messaging').click();
        ok('the app list shows', seen(el('v2MsgPick')));
        eq('it lists Telegram, Slack and Discord', [...el('v2MsgApp').options].map((o) => o.textContent), ['Telegram', 'Slack', 'Discord']);
        eq('Telegram first, alone', [el('v2MsgApp').value, showing()], ['pool', ['panePool']]);
        ok('above the pane', el('v2MsgPick').getBoundingClientRect().bottom <= panes[0].getBoundingClientRect().top + 1);
        ok('no heading repeats the list', panes.every((x) => !x.querySelector('.v2settingshead') || !seen(x.querySelector('.v2settingshead'))));
        await until(() => n(/\/v1\/pool$/) > before[0]);
        eq('only Telegram is read', [n(/\/v1\/slack-apps$/), n(/\/v1\/discord-bots$/)], before.slice(1));
        pick('slack');
        eq('Slack alone, the tab still Messaging', [showing(), selected()], [['paneSlack'], 'Messaging']);
        await until(() => n(/\/v1\/slack-apps$/) > before[1]);
        el('spoolBot').value = ''; el('spoolApp').value = ''; el('spoolAddBtn').click();
        await until(() => el('spoolErr').textContent.includes('Paste both tokens'));
        pick('discord');
        eq('Discord alone', showing(), ['paneDiscord']);
        await until(() => n(/\/v1\/discord-bots$/) > before[2]);
        el('dpoolToken').value = ''; el('dpoolAddBtn').click();
        await until(() => el('dpoolErr').textContent.includes('Paste the bot token'));
        el('spoolErr').textContent = ''; el('dpoolErr').textContent = '';
        const ids = ['poolStatus', 'poolOwnOnly', 'poolToken', 'poolAddBtn', 'poolList', 'botInvDrawer', 'spoolBot', 'spoolApp', 'spoolAddBtn', 'spoolList', 'dpoolToken', 'dpoolAddBtn', 'dpoolList'];
        ok('every control is there: ' + ids.filter((id) => !panes.some((x) => x.contains(el(id)))).join(', '), ids.every((id) => panes.some((x) => x.contains(el(id)))));
        byText('#v2SettingsTabs .tab', 'You').click();
        ok('another tab hides the list and all three', !seen(el('v2MsgPick')) && panes.every((x) => x.hidden));
        ok('a tab of two parts keeps its headings', seen(el('paneAccess').querySelector('.v2settingshead')) && seen(el('paneOperator').querySelector('.v2settingshead')));
        aiDlg.close();
        await openAiDlg('messaging');
        eq('Messaging opens on the app shown last', [selected(), el('v2MsgApp').value, showing()], ['Messaging', 'discord', ['paneDiscord']]);
        aiDlg.close();
        // Every way in that names one of the three opens Messaging on it.
        for (const [link, want] of [['pool', 'pool'], ['telegram', 'pool'], ['slack', 'slack'], ['discord', 'discord']]) {
          await openAiDlg(link);
          eq(link + ' opens', [selected(), el('v2MsgApp').value, showing()], ['Messaging', want, [TABS[want]]]);
          aiDlg.close();
        }
      } finally {
        try { localStorage.removeItem('hb-settings-messaging'); } catch {}
        if (aiDlg.open) aiDlg.close();
      }
    },
    newAgentTelegramOff: async () => {
      // The owner (2026-11-07): "I found myself unclicking the use telegram selection box a lot" — off until ticked.
      const el = (id) => document.getElementById(id);
      const shown = (id) => getComputedStyle(el(id)).display !== 'none';
      const creates = () => calls('POST', /\/v1\/agents$/);
      const open = async () => { el('fabBtn').click(); await until(() => createDlg.open); };
      const was = poolAvail;
      try {
        poolAvail = 3;
        await open();
        ok('Telegram starts unticked', !el('agentTelegram').checked);
        ok('the pool choice waits for it', !shown('agentPoolRow') && el('agentPoolEmptyNote').hidden);
        const said = createDlg.textContent.replace(/\s+/g, ' ');
        ok('it says where task results go without a chat app: ' + said.slice(said.indexOf('Use Telegram'), said.indexOf('Use Telegram') + 260), said.includes("its scheduled tasks' results arrive in its console conversation (the red dot on its icon), not on your phone"));
        el('agentTelegram').click();
        ok('ticked: the pool choice, on', shown('agentPoolRow') && el('agentUsePool').checked && el('agentPoolEmptyNote').hidden);
        el('agentTelegram').click();
        ok('unticked: gone again', !shown('agentPoolRow'));
        el('agentName').value = 'Pantry Notes';
        const n0 = creates().length;
        await createAgent();
        const made = creates().slice(n0);
        eq('one create', made.length, 1);
        eq('it asks for no bot, and says so', [made[0].body.telegram, made[0].body.skipPool], [false, undefined]);
        ok('the form closed', !createDlg.open);
        // Ticked, then cancelled: the next agent starts unticked again.
        await open(); el('agentTelegram').click(); createDlg.close();
        await open();
        ok('each open starts unticked', !el('agentTelegram').checked && !shown('agentPoolRow'));
        // Asked for: a bot; declining the pool asks for a bespoke one.
        el('agentTelegram').click(); el('agentUsePool').click();
        el('agentName').value = 'Pantry Notes Two';
        await createAgent();
        eq('ticked: Telegram, and a bespoke bot', [creates().at(-1).body.telegram, creates().at(-1).body.skipPool], [true, true]);
        // An empty pool: the BotFather warning comes only with Telegram.
        poolAvail = 0;
        await open();
        ok('no warning while it is off', el('agentPoolEmptyNote').hidden);
        el('agentTelegram').click();
        ok('ticked with an empty pool: the warning, no pool choice', !el('agentPoolEmptyNote').hidden && !shown('agentPoolRow'));
      } finally {
        poolAvail = was;
        if (createDlg.open) createDlg.close();
        el('agentName').value = ''; el('agentTelegram').checked = false; agentTelegramChanged();
      }
    },
    sheetDesktopKeepsItsClose: async () => {
      // The phone's ‹ Back (2026-11-07) is the phone's: a desktop keeps the ✕ and the full-height sheet.
      try {
        openV2Agent('a1');
        const bar = document.getElementById('v2AgentBar');
        const x = bar.querySelector('.v2sclose'), back = bar.querySelector('.v2sback');
        ok('the ✕ shows', !!x && getComputedStyle(x).display !== 'none' && x.getAttribute('aria-label') === 'Close');
        ok('no ‹ Back', !!back && getComputedStyle(back).display === 'none');
        eq('the sheet runs from the top', Math.round(v2AgentDlg.getBoundingClientRect().top), 0);
        x.click();
        ok('✕ closes it', !v2AgentDlg.open);
        // The check's Chrome does not always deliver a dialog's close event: sent as a browser would, so the next check starts clean.
        v2AgentDlg.dispatchEvent(new Event('close'));
      } finally { try { v2Close(); } catch {} }
    },
    usageContextNow: async () => {
      window.__override['/v1/token-health'] = { rows: [
        { agent: 'Kitchen', id: 'a1', state: 'running', model: 'anthropic/claude-opus-4-8', conversation: { calls: 12, ctxK: { p50: 40, p90: 90, max: 120 }, mainNowK: 180, mainAt: new Date().toISOString(), windowK: 200 } },
        { agent: 'Garden', id: 'a2', state: 'asleep', model: 'claude-sonnet-4-5', readHoursAgo: 3, conversation: { calls: 2, ctxK: { p50: 10, p90: 12, max: 12 }, mainNowK: 30 }, contextCap: { tokens: 150000, applied: true, compactsAtK: 130 } },
      ] };
      try {
        openFleetUsage();
        await until(() => document.querySelector('#fleetContextNow table'));
        const rows = [...document.querySelectorAll('#fleetContextNow tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()));
        eq('the fullest conversation first', rows.map((r) => r[0].split(' ')[0]), ['Kitchen', 'Garden']);
        const capSel = (id) => document.querySelector('#fleetContextNow tr[data-agent="' + id + '"] select.ctxcap');
        ok('Kitchen: 180K of a 200K window = 90%', rows[0][1] === 'claude-opus-4-8' && rows[0][2] === '180K' && rows[0][3] === '200K' && rows[0][5] === '90%');
        eq('Kitchen has no cap; the menu offers only caps below its window', [capSel('a1').value, [...capSel('a1').options].map((o) => o.textContent)], ['', ['None', '100K', '150K']]);
        ok('Garden: Full counts against the cap Hatchabot set', rows[1][2] === '30K' && capSel('a2').value === '150000' && rows[1][5] === '20%');
        ok('one column, the median call, then the last call', rows[0][6] === '40K' && rows[0].length === 8 && !rows[0].includes('90K'));
        ok('the note says what it means', document.getElementById('fleetContextNow').textContent.includes('Median call') && !document.getElementById('fleetContextNow').textContent.includes('1 in 10'));
      } finally {
        fleetUsageDlg.close();
        delete window.__override['/v1/token-health'];
      }
    },
    usageContextCap: async () => {
      // Set or take off a cap where its figures are (Chris, 2026-10-25): it asks first, and a No changes nothing.
      window.__override['/v1/token-health'] = { rows: [
        { agent: 'Kitchen', id: 'a1', state: 'running', billing: 'api', model: 'claude-opus-4-8', conversation: { calls: 12, ctxK: { p50: 140, p90: 170, max: 190 }, mainNowK: 180, mainAt: new Date().toISOString(), windowK: 1000 } },
        { agent: 'Garden', id: 'a2', state: 'asleep', billing: 'api', model: 'claude-sonnet-4-5', conversation: { calls: 2, ctxK: { p50: 10, p90: 12, max: 12 }, mainNowK: 30 }, contextCap: { tokens: 150000, applied: false, compactsAtK: 130 } },
        { agent: 'Local', id: 'a3', state: 'running', billing: 'local', model: 'qwen3', conversation: { calls: 4, ctxK: { p50: 8, p90: 9, max: 9 }, mainNowK: 9 } },
      ] };
      window.__answer = window.__answer || {};
      const capSel = (id) => document.querySelector('#fleetContextNow tr[data-agent="' + id + '"] select.ctxcap');
      const puts = (id) => calls('PUT', new RegExp('^/v1/agents/' + id + '/context-cap$'));
      const was = window.__confirmAnswer;
      try {
        openFleetUsage();
        // The page keeps the last scenario's table until this reading arrives: wait for a row only it has.
        await until(() => document.querySelector('#fleetContextNow tr[data-agent="a3"]'));
        ok('a local model has no menu', !capSel('a3'));
        const kitchenCells = [...document.querySelector('#fleetContextNow tr[data-agent="a1"]').children].map((td) => td.textContent.trim());
        eq('a 1M window reads 1M (it read "1.0kK")', kitchenCells[3], '1M');
        ok('a cap not yet in its settings says so', document.querySelector('#fleetContextNow tr[data-agent="a2"]').textContent.includes('pending'));
        // No: nothing sent, the menu goes back.
        window.__confirmAnswer = false;
        const asked = window.__confirms.length;
        capSel('a1').value = '150000'; capSel('a1').dispatchEvent(new Event('change'));
        ok('it asks, saying the conversation is past the point: ' + window.__confirms.at(-1), window.__confirms.length === asked + 1 && window.__confirms.at(-1).includes('about 130K') && window.__confirms.at(-1).includes('180K now'));
        ok('a No sends nothing and puts the menu back', !puts('a1').length && capSel('a1').value === '');
        // Yes: set.
        window.__confirmAnswer = true;
        window.__answer['PUT /v1/agents/a1/context-cap'] = [{ body: { tokens: 150000, outcome: 'applied', compactsAt: 130000, message: '"Kitchen" now compacts its conversations at about 130K tokens.' } }];
        const reads = calls('GET', /^\/v1\/token-health$/).length;
        capSel('a1').value = '150000'; capSel('a1').dispatchEvent(new Event('change'));
        await until(() => puts('a1').length === 1);
        eq('a cap is sent', puts('a1')[0].body, { tokens: 150000 });
        await until(() => document.getElementById('toast').textContent.includes('compacts its conversations at about 130K'));
        await until(() => calls('GET', /^\/v1\/token-health$/).length > reads);
        // Taking one off.
        await until(() => capSel('a2'));
        capSel('a2').value = ''; capSel('a2').dispatchEvent(new Event('change'));
        ok('taking it off asks too: ' + window.__confirms.at(-1), window.__confirms.at(-1).includes("Take Garden's context cap off"));
        await until(() => puts('a2').length === 1);
        eq('null takes it off', puts('a2')[0].body, { tokens: null });
      } finally {
        window.__confirmAnswer = was;
        if (window.__answer) delete window.__answer['PUT /v1/agents/a1/context-cap'];
        fleetUsageDlg.close();
        delete window.__override['/v1/token-health'];
      }
    },
    storageBlockedStillPaints: async () => {
      // A browser that blocks storage used to stop renderV2 before the grid (audit, 2026-10-23).
      const desc = Object.getOwnPropertyDescriptor(window, 'localStorage');
      let blocked = false;
      try { Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } }); blocked = true; } catch {}
      if (!blocked) return; // this browser does not let a page redefine it: nothing to check here
      try {
        let threw = false;
        try { localStorage.getItem('x'); } catch { threw = true; }
        ok('storage really is blocked for the test', threw);
        // renderV2 used to throw here (v2RenderWho's unguarded read) before it drew the grid.
        let err = ''; try { renderV2(); } catch (e) { err = String(e && e.stack || e).slice(0, 400); }
        ok('renderV2 survives blocked storage' + (err ? ' (threw: ' + err + ')' : ''), !err);
        ok('the agents are on screen', document.querySelectorAll('#v2groups .v2agent').length > 0);
      } finally {
        if (desc) Object.defineProperty(window, 'localStorage', desc); else delete window.localStorage;
      }
    },
  });
  Object.assign(T, {
    modalOnlyDialogs: async () => {
      // A stray click outside must not close the recovery code before "I've saved it", nor the sign-in (night review #19).
      const outside = (dlg) => dlg.dispatchEvent(new MouseEvent('click', { clientX: 3, clientY: 3, bubbles: true, cancelable: true }));
      // Esc as a browser takes it: the key (here aimed at the page behind, outside the dialog), then, if not stopped,
      // the dialog's cancel algorithm: a 'cancel' event, and a close unless it is refused. Both must hold it.
      const escape = (dlg) => {
        const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.body.dispatchEvent(key);
        if (dlg.dispatchEvent(new Event('cancel', { cancelable: true }))) dlg.close();
        return { keyStopped: key.defaultPrevented, stillOpen: dlg.open };
      };
      showRecoveryCode('WXYZ-1234-TEST');
      outside(recoveryDlg);
      ok('the recovery code stays open', recoveryDlg.open && document.getElementById('recoveryCode').textContent === 'WXYZ-1234-TEST');
      eq('Esc is refused too', escape(recoveryDlg), { keyStopped: true, stillOpen: true });
      document.getElementById('recoverySaved').checked = true;
      outside(recoveryDlg);
      ok('once saved, it may go', !recoveryDlg.open);
      // Backup codes the same way; once saved, the click is Done: off the page, and what waits on them goes on (review of HB-0500).
      let codesSettled = false;
      showBackupCodes(['WXYZ-1234-TEST'], 'o1').then(() => { codesSettled = true; });
      outside(backupDlg);
      ok('backup codes stay open', backupDlg.open && $('backupCodes').textContent === 'WXYZ-1234-TEST');
      eq('Esc is refused there too', escape(backupDlg), { keyStopped: true, stillOpen: true });
      $('backupSaved').checked = true;
      outside(backupDlg);
      await sleep(0);
      ok('once saved, they go, and are settled', !backupDlg.open && $('backupCodes').textContent === '' && codesSettled);
      // The second-factor prompt goes only by its buttons: a stray click left its request waiting, and every later prompt with it.
      let asked = 'waiting';
      askSecondFactor('step-up').then(() => { asked = 'given'; }, () => { asked = 'refused'; });
      await until(() => sfDlg.open);
      outside(sfDlg);
      ok('the prompt stays open', sfDlg.open);
      eq('Esc is refused', escape(sfDlg), { keyStopped: true, stillOpen: true });
      // Taken off the screen some other way (a browser letting a second Esc through). The check's Chrome does not
      // always deliver a dialog's close event, so it is sent here as a browser would.
      sfDlg.close(); sfDlg.dispatchEvent(new Event('close'));
      ok('while its request waits, it comes back', sfDlg.open);
      sfDlg.close();
      const again = askSecondFactor('step-up');
      ok('the next ask shows it again', sfDlg.open);
      await sfCancel(); await again.catch(() => {});
      ok('and Cancel answers it', asked === 'refused');
      loginDlg.showModal();
      outside(loginDlg);
      ok('the sign-in stays open', loginDlg.open);
      loginDlg.close();
      v2IconDlg.showModal();
      const r = v2IconDlg.getBoundingClientRect();
      if (r.left > 3 && r.top > 3) { outside(v2IconDlg); ok('an ordinary dialog still closes on an outside click', !v2IconDlg.open); }
      if (v2IconDlg.open) v2IconDlg.close();
    },
    plainHttpSignIn: async () => {
      // Signing in over plain http from another device says it crosses the network in the clear (HB-0109).
      ok('a LAN address over http is warned', plainHttpFromAfar({ protocol: 'http:', hostname: '192.168.1.20' }));
      ok('the https address is not', !plainHttpFromAfar({ protocol: 'https:', hostname: 'hatchabot.tail0000.ts.net' }));
      ok('nor this machine itself', !plainHttpFromAfar({ protocol: 'http:', hostname: 'localhost' }) && !plainHttpFromAfar({ protocol: 'http:', hostname: '127.0.0.1' }));
      showLogin();
      await until(() => loginDlg.open);
      ok('on this machine the sign-in shows no warning', document.getElementById('loginPlainHttp').hidden);
      loginDlg.close();
    },
    memberPane: async () => {
      // A member of a Discord-only agent is sent to Discord; an asleep agent still offers its link (night review #20).
      const list = await (await fetch('/v1/agents')).json();
      const base = list.find((a) => a.id === 'a1');
      window.__override['/v1/agents'] = [...list,
        { ...base, id: 'm1', name: 'Club Bot', role: 'member', ownerId: 'o2', botUsername: undefined, deepLink: undefined, otherChannels: [{ kind: 'discord', deepLink: 'https://discord.com/users/1' }] },
        { ...base, id: 'm2', name: 'Nap Bot', role: 'member', ownerId: 'o2', state: 'STOPPED', hibernatedAt: new Date().toISOString() },
        { ...base, id: 'm3', name: 'Off Bot', role: 'member', ownerId: 'o2', state: 'STOPPED', hibernatedAt: undefined },
        { ...base, id: 'm4', name: 'Broke Bot', role: 'member', ownerId: 'o2', state: 'FAILED' },
        { ...base, id: 'm5', name: 'Old Bot', role: 'member', ownerId: 'o2', state: 'ARCHIVED' }];
      await refresh(false);
      openV2Agent('m1');
      let t = document.getElementById('v2Pane').textContent;
      ok('Discord, not Telegram: ' + t.replace(/\s+/g, ' ').slice(0, 160), t.includes('Open in Discord') && t.includes('answers in Discord') && !t.includes('Telegram') && !t.includes('Not running'));
      v2Close();
      openV2Agent('m2');
      t = document.getElementById('v2Pane').textContent;
      ok('asleep, with its link: ' + t.replace(/\s+/g, ' ').slice(0, 160), t.includes('Open in Telegram') && t.includes('a message wakes it') && !t.includes('Not running'));
      v2Close();
      // Wake, Start, Retry, Inspect and Restore are the owner's: the server answers a member 404 (review, 2026-10-09).
      for (const id of ['m2', 'm3', 'm4', 'm5']) {
        openV2Agent(id);
        const bar = [...document.querySelectorAll('#v2AgentBar button')].map((b) => b.textContent.trim());
        ok(id + ': no lifecycle buttons for a member: ' + bar.join(' | '), !bar.some((l) => /Wake|Start|Retry|Inspect|Restore/.test(l)));
        v2Close();
      }
      delete window.__override['/v1/agents'];
      await refresh(false);
    },
    notRunningWording: async () => {
      // A rebuilding agent is not "stopped — start it" (night review #22).
      const g = agents.find((a) => a.name === 'Grocery Runner');
      ok('a rebuilding agent in the stub', g && g.state === 'REBUILDING');
      openV2Agent(g.id, 'usage');
      let t = document.getElementById('v2Pane').textContent;
      ok('usage says rebuilt: ' + t.slice(0, 120), t.includes('being rebuilt') && !t.includes('stopped'));
      openV2Agent(g.id, 'schedule');
      t = document.getElementById('v2Pane').textContent;
      ok('schedule says rebuilt: ' + t.slice(0, 120), t.includes('being rebuilt') && !t.includes('Start it'));
      v2Close();
    },
    hiddenTabPauses: async () => {
      // A hidden tab stops polling and catches up when shown (night review #23).
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      await refresh(false);
      ok('paused while hidden', pollPaused === true);
      const n = calls('GET', /^\/v1\/agents$/).length;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
      await until(() => calls('GET', /^\/v1\/agents$/).length > n);
      await until(() => pollPaused === false);
      delete document.hidden;
    },
    hiddenTabNotRead: async () => {
      // The 20-second "you have read it" tick skips a hidden browser tab (review, 2026-10-09).
      const seen = () => calls('POST', /\/v1\/agents\/a1\/seen$/).length;
      const prevId = consoleAgentId;
      try {
        consoleAgentId = 'a1'; consoleDlg.showModal();
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        const n = seen();
        consoleSeenTick();
        eq('hidden: not marked read', seen() - n, 0);
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        consoleSeenTick();
        eq('shown: marked read', seen() - n, 1);
      } finally {
        delete document.hidden;
        if (consoleDlg.open) consoleDlg.close();
        consoleAgentId = prevId;
      }
    },
    staleRefreshDropped: async () => {
      // Two refreshes overlap and the older answer lands last: it must not put a deleted agent back (review, 2026-10-09).
      const list = await (await fetch('/v1/agents')).json();
      const prev = window.fetch;
      let first = true;
      window.fetch = async (input, init) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (url.split('?')[0] === '/v1/agents' && (!init || !init.method || init.method === 'GET') && first) {
          first = false;
          await sleep(400);
          return new Response(JSON.stringify([...list, { ...list[1], id: 'gone1', name: 'Deleted Agent' }]), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return prev(input, init);
      };
      try {
        const older = refresh(false);
        await sleep(20);
        await refresh(false);
        await older;
        ok('the older answer was dropped', !v2Find('gone1') && !tile('Deleted Agent'));
      } finally { window.fetch = prev; await refresh(false); }
    },
    staleMetaAndPairingDropped: async () => {
      // An older refresh's sources, machines or pairing knocks that land after a newer one's are dropped;
      // one no newer refresh read is still used (#228).
      const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      const prev = window.fetch;
      const current = await (await fetch('/v1/ai-profiles')).json();
      const stale = [{ ...current[0], id: 'stale-p', name: 'Stale Source' }];
      let hold = null, release;
      window.fetch = async (input, init) => {
        const path = String(typeof input === 'string' ? input : input.url).split('?')[0];
        if (hold && path === hold.path && (!init || !init.method || init.method === 'GET')) {
          const h = hold; hold = null;
          await h.until;
          return J(h.body);
        }
        return prev(input, init);
      };
      const holdNext = (path, body) => { let r; hold = { path, body, until: new Promise((ok) => { r = ok; }) }; release = r; };
      try {
        // The older pass's sources land last, after a newer pass read them: the newer stay.
        holdNext('/v1/ai-profiles', stale);
        const older = refresh(true);
        await sleep(20);
        await refresh(true);
        release(); await older;
        ok('the older sources were dropped', !profiles.some((p) => p.id === 'stale-p'));
        eq('the newer sources are kept', profiles.map((p) => p.id), current.map((p) => p.id));
        // No newer pass read them: the older pass's answer is the newest there is, and is used.
        const added = [...current, { ...current[0], id: 'added-p', name: 'Added Source' }];
        holdNext('/v1/ai-profiles', added);
        const withMeta = refresh(true);
        await sleep(20);
        await refresh(false);
        release(); await withMeta;
        ok('a source read by the older pass alone is shown', profiles.some((p) => p.id === 'added-p'));
        // The pairing knocks: the older pass's (one knock) land after the newer pass's (none).
        const knocking = agents.find((a) => a.state === 'RUNNING' && v2ChannelKinds(a).length);
        holdNext('/v1/agents/' + knocking.id + '/pairing', [{ kind: 'telegram', code: 'STALE1', id: '1', name: 'Stale Knock' }]);
        pairTick = 0;
        const olderPair = refresh(false);
        await sleep(20);
        pairTick = 0;
        await refresh(false);
        release(); await olderPair;
        eq('the older knocks were dropped', (pairings[knocking.id] ?? []).length, 0);
      } finally { window.fetch = prev; if (release) release(); await refresh(true); }
    },
    inspectLateAnswer: async () => {
      // A file or transcript that lands after the dialog moved to another agent is dropped, as openInspect does (review, 2026-10-09).
      const prev = window.fetch;
      let release; const held = new Promise((r) => { release = r; });
      const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      window.fetch = async (input, init) => {
        const path = String(typeof input === 'string' ? input : input.url).split('?')[0];
        if (path === '/v1/agents/a1/inspect/file/NOTES.md') { await held; return J({ content: 'from the first agent' }); }
        if (path === '/v1/agents/a1/inspect/transcript') { await held; return J({ turns: [{ role: 'user', text: 'a first-agent turn' }], totalTurns: 1 }); }
        if (/^\/v1\/agents\/a[12]\/inspect$/.test(path)) return J({ files: [], transcriptTurns: 0 });
        return prev(input, init);
      };
      try {
        await openInspect('a1', 'First');
        const file = loadInspectFile('NOTES.md');
        const chat = loadInspectChat();
        await openInspect('a2', 'Second');
        release(); await file; await chat;
        ok('the first agent\'s file is not shown for the second: ' + document.getElementById('inspFileBody').textContent, !document.getElementById('inspFileBody').textContent.includes('first agent'));
        ok('nor its conversation', !document.getElementById('inspChatBody').textContent.includes('first-agent turn'));
      } finally { window.fetch = prev; release(); if (inspectDlg.open) inspectDlg.close(); }
    },
    inspectEmptyMainSaysSo: async () => {
      // HB-0307: a main conversation found but emptied by a reset is said as that, not as no conversation at all.
      const prev = window.fetch;
      const J = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
      let tools = false;
      window.fetch = async (input, init) => {
        const path = String(typeof input === 'string' ? input : input.url).split('?')[0];
        if (path === '/v1/agents/a1/inspect/transcript') return J({ turns: [], sessionFile: 'sess-new', totalTurns: tools ? 451 : 0 });
        if (path === '/v1/agents/a1/inspect') return J({ files: [], transcriptTurns: 0 });
        return prev(input, init);
      };
      try {
        await openInspect('a1', 'First');
        await loadInspectChat();
        const meta = document.getElementById('inspChatMeta').textContent;
        ok('it says the main conversation is empty: ' + meta, meta.includes('main conversation is empty') && !meta.includes('No conversation found'));
        // Records, but only tool steps among the newest: not called empty.
        tools = true;
        await loadInspectChat();
        const meta2 = document.getElementById('inspChatMeta').textContent;
        ok('records with nothing to show are not called empty: ' + meta2, meta2.includes('tool steps') && meta2.includes('451') && !meta2.includes('empty'));
      } finally { window.fetch = prev; if (inspectDlg.open) inspectDlg.close(); }
    },
    pollFetchesLess: async () => {
      // No /members fan-out on v2, no /pairing for web-only agents, no hidden Activity card, a light backups read (night review #24/#25/#47).
      // Let a refresh still running from the scenario before (the tab shown again starts one) finish first:
      // its pairing round landed in this pass and counted a1 twice when the timing shifted.
      await sleep(400);
      pairTick = 0; mgmtTick = 0;
      const mark = window.__calls.length;
      await refresh(false);
      await sleep(200);
      const pass = window.__calls.slice(mark);
      const got = (re) => pass.filter((c) => c.method === 'GET' && re.test(c.path));
      eq('members reads on a poll', got(/\/members$/).length, 0);
      ok('pairing still read for chat agents', got(/\/v1\/agents\/a1\/pairing$/).length === 1);
      const webOnly = agents.filter((a) => !a.botUsername && !(a.otherChannels || []).length).map((a) => a.id);
      ok('web-only agents in the stub', webOnly.length >= 2);
      eq('pairing reads for web-only agents', got(/\/pairing$/).filter((c) => webOnly.some((id) => c.path === '/v1/agents/' + id + '/pairing')).length, 0);
      eq('events for a hidden card', got(/^\/v1\/events$/).length, 0);
      const bk = got(/^\/v1\/backups$/);
      ok('the backups read is the light one', bk.length === 1 && bk[0].url.includes('latest=1'));
    },
    failingTasks: async () => {
      // A task that fails every day says so (night review #45).
      const now = Date.now();
      window.__crons = [
        { id: 'c9', name: 'Daily lunch', scheduleExpr: '0 12 * * *', enabled: true, payloadKind: 'agentTurn', message: 'lunch', lastStatus: 'error', consecutiveErrors: 5, lastRunAtMs: now - 3600e3, nextRunAtMs: now + 3600e3 },
        { id: 'c8', name: 'Morning brief', scheduleExpr: '0 8 * * *', enabled: true, payloadKind: 'agentTurn', message: 'hi', lastStatus: 'ok', consecutiveErrors: 0, lastRunAtMs: now - 7200e3, nextRunAtMs: now + 7200e3, lastDelivered: true }];
      openV2Agent('a1', 'schedule');
      await until(() => cronCache.some((c) => c.id === 'c9'));
      const rows = await until(() => { const r = [...document.querySelectorAll('#cronList .pair')]; return r.length === 2 ? r : null; });
      ok('the failing one says so: ' + rows[0].textContent.replace(/\s+/g, ' ').slice(0, 200), rows[0].querySelector('.chip.FAILED') && rows[0].textContent.includes('5 in a row') && rows[0].textContent.includes('next'));
      ok('the healthy one is ok: ' + rows[1].textContent.replace(/\s+/g, ' ').slice(0, 200), !rows[1].querySelector('.chip.FAILED') && rows[1].textContent.includes('last run ok'));
      v2Close(); window.__crons = [];
    },
    waitingTemplateTasks: async () => {
      // HB-0231: a template task the agent refused at setup waited, unseen, for a rebuild. The Tasks
      // list shows it with why, and one button tries again.
      const task = { id: 'c8', name: 'Morning brief', scheduleKind: 'cron', scheduleExpr: '0 8 * * *', enabled: true, payloadKind: 'agentTurn', message: 'hi', lastStatus: 'ok', consecutiveErrors: 0 };
      const waiting = [{ name: 'Weekly menu', message: 'Plan next week dinners', cron: '0 9 * * 1', tz: 'UTC', why: 'the agent refused it: gateway busy' }];
      window.__override['/v1/agents/a1/crons'] = { crons: [task], waiting };
      try {
        openV2Agent('a1', 'schedule');
        const rows = await until(() => { const r = [...document.querySelectorAll('#cronList .pair')]; return r.length === 2 ? r : null; });
        const first = rows[0].textContent.replace(/\s+/g, ' ');
        ok('the waiting task is listed first, marked: ' + first.slice(0, 200), first.includes('Weekly menu') && first.includes('waiting to be added') && first.includes('0 9 * * 1'));
        ok('with why, and when it is tried again: ' + first.slice(0, 300), first.includes('Not added yet: the agent refused it: gateway busy.') && first.includes('starts, wakes or is rebuilt'));
        ok('the agent\'s own task is still there', rows[1].textContent.includes('Morning brief'));
        const btn = document.getElementById('cronWaitingRetry');
        ok('one button to try again: ' + (btn && btn.textContent), !!btn && btn.textContent.includes('Try adding it now'));
        window.__answer = { 'POST /v1/agents/a1/crons/waiting': [{ status: 200, body: { waiting: [] } }] };
        window.__override['/v1/agents/a1/crons'] = { crons: [task, { ...task, id: 'c9', name: 'Weekly menu', scheduleExpr: '0 9 * * 1' }], waiting: [] };
        const before = calls('POST', /\/v1\/agents\/a1\/crons\/waiting$/).length;
        btn.click();
        await until(() => calls('POST', /\/v1\/agents\/a1\/crons\/waiting$/).length === before + 1);
        await until(() => !document.getElementById('cronWaitingRetry') && document.querySelectorAll('#cronList .pair').length === 2);
        ok('added: the list shows it as a task now', [...document.querySelectorAll('#cronList .pair')].some((r) => r.textContent.includes('Weekly menu') && !r.textContent.includes('waiting to be added')));
        ok('and said so: ' + document.getElementById('toast').textContent, document.getElementById('toast').textContent.includes('Added.'));
      } finally {
        delete window.__override['/v1/agents/a1/crons'];
        window.__answer = {};
        v2Close();
      }
    },
    taskPhoneNote: async () => {
      // HB-0537: a task's run reached the phone only through an agent's own bot. Each task, and the add form,
      // has "Tell me on Telegram when it runs"; with no bot to reach the owner it says how to get one.
      const task = { id: 'c8', name: 'Market report', scheduleKind: 'cron', scheduleExpr: '0 8 * * 1-5', enabled: true, payloadKind: 'agentTurn', message: 'Write it', lastStatus: 'ok', consecutiveErrors: 0 };
      window.__override['/v1/agents/a1/crons'] = { crons: [task], waiting: [], notes: [], noteReach: true };
      try {
        openV2Agent('a1', 'schedule');
        const box = await until(() => document.querySelector('#cronList .pair .cron-note input'));
        ok('each task has the box, off and usable: ' + box.closest('label').textContent.trim(), !box.checked && !box.disabled && box.closest('label').textContent.includes('Tell me on Telegram when it runs'));
        ok('no hint while a note can reach the owner', !document.querySelector('.cron-note-hint'));
        const before = calls('PATCH', /\/v1\/agents\/a1\/crons\/c8$/).length;
        box.click();
        const patch = await until(() => calls('PATCH', /\/v1\/agents\/a1\/crons\/c8$/)[before]);
        eq('ticking it turns the note on for that task alone', patch.body, { notify: true });
        await until(() => document.getElementById('toast').textContent.includes('a link, not the result'));
        ok('and says what comes: ' + document.getElementById('toast').textContent, true);

        // A new task can be added with it on.
        document.getElementById('cronMode').value = 'cron'; cronModeChanged();
        document.getElementById('cronName').value = 'Evening report';
        document.getElementById('cronExpr').value = '0 18 * * 1-5';
        document.getElementById('cronMsg').value = 'Write the evening report';
        ok('the form has the box too, usable', !document.getElementById('cronNote').disabled);
        document.getElementById('cronNote').checked = true;
        const posts = calls('POST', /\/v1\/agents\/a1\/crons$/).length;
        document.getElementById('cronAddBtn').click();
        const post = await until(() => calls('POST', /\/v1\/agents\/a1\/crons$/)[posts]);
        ok('the new task is asked for with the note on: ' + JSON.stringify(post.body), post.body.notify === true && post.body.name === 'Evening report');
        await until(() => !document.getElementById('cronNote').checked);
        ok('the form is cleared after, box included', document.getElementById('cronName').value === '');

        // No bot reaches the owner: the hint says how, a note already on can still be turned off, a new one cannot be turned on.
        window.__override['/v1/agents/a1/crons'] = { crons: [task, { ...task, id: 'c9', name: 'Weekly menu' }], waiting: [], notes: ['c8'], noteReach: false };
        await loadCrons();
        const hint = await until(() => document.querySelector('#cronList .cron-note-hint'));
        ok('the list says where notes come from and how to get them: ' + hint.textContent.replace(/\s+/g, ' ').slice(0, 240),
          hint.textContent.includes("Hatchabot agent's bot") && hint.textContent.includes('Telegram bot') && hint.textContent.includes('not sent'));
        const rows = [...document.querySelectorAll('#cronList .pair')];
        const on = rows[0].querySelector('.cron-note input'), off = rows[1].querySelector('.cron-note input');
        ok('the task with a note keeps it, and can turn it off', on.checked && !on.disabled);
        ok('the task without one cannot turn it on yet', !off.checked && off.disabled);
        ok('nor can the form', document.getElementById('cronNote').disabled);
      } finally {
        delete window.__override['/v1/agents/a1/crons'];
        v2Close();
      }
    },
    signOutEverywhere: async () => {
      // The account menu ends every session, after asking; a refusal is shown, not swallowed (review, 2026-09-29).
      window.__noReload = true;
      const everywhere = () => calls('POST', /^\/v1\/logout\/everywhere$/).length;
      document.getElementById('v2AvatarBtn').click();
      const item = await until(() => { const b = document.getElementById('v2SignOutAll'); return b && b.offsetParent ? b : null; });
      ok('it sits beside plain sign-out', item.previousElementSibling.classList.contains('v2signout'));
      window.__confirmAnswer = false;
      item.click(); await sleep(100);
      ok('it asked first', window.__confirms.at(-1).includes('every device'));
      // …and says the command line is signed out too (2026-09-30).
      ok('it names command-line sign-ins', window.__confirms.at(-1).includes('Command-line sign-ins are ended too') && window.__confirms.at(-1).includes('hatchabot logout'));
      eq('declined: nothing sent', everywhere(), 0);
      ok('the menu closed', document.getElementById('v2AcctPop').hidden);
      window.__confirmAnswer = true;
      window.__answer = { 'POST /v1/logout/everywhere': [{ status: 400, body: { error: 'Nobody signs in to this installation, so there are no sessions to end.' } }] };
      document.getElementById('v2AvatarBtn').click();
      document.getElementById('v2SignOutAll').click();
      await until(() => document.getElementById('toast').textContent.includes('no sessions to end'));
      eq('one call', everywhere(), 1);
      document.getElementById('v2AvatarBtn').click();
      document.getElementById('v2SignOutAll').click();
      await until(() => document.getElementById('toast').textContent.includes('Signed out on every device'));
      eq('two calls', everywhere(), 2);
      eq('plain logout never called', calls('POST', /^\/v1\/logout$/).length, 0);
      window.__answer = {};
    },
    signOutUnreached: async () => {
      // A logout that never reached the server is not a sign-out (#224): the cookie is HttpOnly, only the server ends it.
      window.__noReload = true;
      const before = localStorage.getItem('hatchabot_email');
      const logouts = () => calls('POST', /^\/v1\/logout$/).length;
      const base = logouts();
      localStorage.setItem('hatchabot_email', 'owner@example.org');
      try {
        window.__answer = { 'POST /v1/logout': [{ reject: 'Failed to fetch' }] };
        document.getElementById('v2AvatarBtn').click();
        const item = await until(() => { const b = document.querySelector('#v2AcctPop .v2signout'); return b && b.offsetParent ? b : null; });
        item.click();
        const said = await until(() => { const t = document.getElementById('toast'); return t.textContent.includes('Not signed out') ? t.textContent : null; });
        ok('it says this browser is still signed in, and how to retry: ' + said, said.includes('still signed in') && said.includes('Try Sign out again'));
        eq('nothing forgotten here', localStorage.getItem('hatchabot_email'), 'owner@example.org');
        eq('one call', logouts() - base, 1);
        // Again, and this time it gets there.
        document.querySelector('#v2AcctPop .v2signout').click();
        await until(() => localStorage.getItem('hatchabot_email') === null);
        eq('two calls', logouts() - base, 2);
      } finally {
        window.__answer = {};
        if (before !== null) localStorage.setItem('hatchabot_email', before); else localStorage.removeItem('hatchabot_email');
        document.getElementById('v2AcctPop').hidden = true;
      }
    },
    identitySignUpVerify: async () => {
      // A new email/password account is sent the verification link it needs before it may sign in (#222).
      const idp = (m) => 'https://identitytoolkit.googleapis.com/v1/accounts:' + m;
      const savedIdentity = appConfig.identity;
      appConfig.identity = { ...(savedIdentity || {}), apiKey: 'made-up-web-key' };
      const sessions = () => calls('POST', /^\/v1\/session$/).length;
      const oob = () => calls('POST', /accounts:sendOobCode$/);
      const base = { sessions: sessions(), oob: oob().length };
      try {
        $('loginEmail').value = 'new.member@example.org'; $('loginIdPw').value = 'made-up-password';
        window.__answer = { ['POST ' + idp('signUp')]: [{ body: { idToken: 'made-up-id-token-1', email: 'new.member@example.org', localId: 'u-new' } }] };
        await idSignUp();
        const sent = oob().slice(base.oob);
        eq('the verification email was asked for', sent.map((c) => c.body), [{ requestType: 'VERIFY_EMAIL', idToken: 'made-up-id-token-1' }]);
        eq('no session tried before the address is confirmed', sessions() - base.sessions, 0);
        ok('it says where the link went: ' + $('idVerifyText').textContent, !$('idVerify').hidden && $('idVerifyText').textContent.includes('new.member@example.org'));
        // Signing in before clicking the link: the refusal offers the link again.
        window.__answer = {
          ['POST ' + idp('signInWithPassword')]: [{ body: { idToken: 'made-up-id-token-2', email: 'new.member@example.org' } }],
          'POST /v1/session': [{ status: 401, body: { error: 'Verify your email address, then sign in again.' } }],
        };
        $('idVerify').hidden = true;
        await idSignIn();
        ok('not verified yet, said plainly: ' + $('idVerifyText').textContent, !$('idVerify').hidden && $('idVerifyText').textContent.includes('not verified yet'));
        byText('#idVerify button', 'Send the link again').click();
        await until(() => oob().length - base.oob === 2);
        eq('sent again with the new sign-in', oob().at(-1).body.idToken, 'made-up-id-token-2');
      } finally {
        window.__answer = {}; appConfig.identity = savedIdentity;
        $('loginEmail').value = ''; $('loginIdPw').value = ''; $('idVerify').hidden = true; $('loginErr').textContent = '';
      }
    },
    // Chat on the web (2026-09-29): a member the owner gave it opens 💬 Chat, sees their conversation, sends, reads the reply.
    webChatMember: async () => {
      try {
        const list = await (await fetch('/v1/agents')).json();
        const base = list.find((a) => a.id === 'a1');
        window.__override['/v1/agents'] = [...list, { ...base, id: 'w1', name: 'Book Club', role: 'user', ownerId: 'o2', webChat: true, botUsername: undefined, deepLink: undefined, otherChannels: [] }];
        window.__override['/v1/agents/w1/chat'] = { messages: [
          { role: 'user', text: 'Hi' },
          { role: 'assistant', text: 'Hello <b>there</b>\nline two' } ] };
        // Not rebuilt yet for the full chat: the chat here, and a line saying why.
        window.__override['/v1/agents/w1/console/access'] = { role: 'guest', console: 'needs-rebuild', reason: 'Book Club needs a rebuild before its guests can use the full chat. Until then, use the chat here — or ask its owner to rebuild it.' };
        await refresh(false);
        openV2Agent('w1');
        const pane = document.getElementById('v2Pane').textContent;
        ok('the pane offers the web: ' + pane.replace(/\s+/g, ' ').slice(0, 160), pane.includes('On the web') && pane.includes('No chat app needed') && !pane.includes('Not running'));
        byText('#v2Pane button', 'Chat').click();
        await until(() => webChatDlg.open);
        ok('it says why this is not the full chat yet', !document.getElementById('wchatNote').hidden && document.getElementById('wchatNote').textContent.includes('needs a rebuild before its guests can use the full chat'));
        ok('no console was opened', !document.getElementById('consoleDlg').open);
        const log = document.getElementById('wchatLog');
        await until(() => log.querySelectorAll('.wchat-msg').length === 2);
        ok('the agent\'s text is shown as text, never HTML', !log.querySelector('b') && log.textContent.includes('Hello <b>there</b>'));
        ok('its line breaks are kept', getComputedStyle(log.querySelector('.wchat-msg')).whiteSpace === 'pre-wrap');
        const box = document.getElementById('wchatText');
        const key = (shiftKey) => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }));
        box.value = 'What should we read?';
        key(true);
        eq('Shift+Enter sends nothing', calls('POST', /\/v1\/agents\/w1\/chat$/).length, 0);
        window.__answer = { 'POST /v1/agents/w1/chat': [{ status: 200, body: { reply: 'Try Middlemarch.' } },
          { status: 429, body: { error: "That's 60 messages this hour — try again in 12 minutes." } },
          { status: 409, body: { code: 'needs-rebuild', error: 'Book Club needs a rebuild before web chat works with guest rights. Rebuild Book Club to turn on guest rights for web chat — ask its owner.' } }] };
        key(false);
        ok('their message shows at once, with the thinking line', log.textContent.includes('What should we read?'));
        const sent = await until(() => calls('POST', /\/v1\/agents\/w1\/chat$/)[0]);
        eq('Enter sent it', sent.body, { text: 'What should we read?' });
        await until(() => log.textContent.includes('Try Middlemarch.'));
        ok('the thinking line is gone', !log.querySelector('.wchat-msg.wait'));
        box.value = 'And after that?';
        document.getElementById('wchatSend').click();
        await until(() => document.getElementById('wchatErr').textContent.includes('60 messages this hour'));
        ok('the box is free again', !document.getElementById('wchatSend').disabled);
        // An agent that can't give a guest a member's turn yet (step 2): said plainly; the message comes back.
        box.value = 'Anything by Eliot?';
        document.getElementById('wchatSend').click();
        await until(() => document.getElementById('wchatErr').textContent.includes('Rebuild Book Club to turn on guest rights for web chat'));
        eq('the undelivered message is back in the box', box.value, 'Anything by Eliot?');
        ok('and not in the conversation as if sent', !log.textContent.includes('Anything by Eliot?'));
        ok('what was answered before stays', log.textContent.includes('Try Middlemarch.'));
        // Another agent while one is thinking: Send works there, the late reply is not dropped silently (review, 2026-10-09).
        window.__answer = {};
        let release; const held = new Promise((r) => { release = r; });
        const prevFetch = window.fetch;
        window.fetch = async (input, init) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (url === '/v1/agents/w1/chat' && init && init.method === 'POST') { await held; return new Response(JSON.stringify({ reply: 'A late answer.' }), { status: 200, headers: { 'content-type': 'application/json' } }); }
          return prevFetch(input, init);
        };
        try {
          box.value = 'Slow one';
          document.getElementById('wchatSend').click();
          await until(() => log.querySelector('.wchat-msg.wait'));
          window.__override['/v1/agents/a1/chat'] = { messages: [] };
          await openWebChatPanel('a1');
          ok('Send works for the other agent', !document.getElementById('wchatSend').disabled);
          window.__answer = { 'POST /v1/agents/a1/chat': [{ status: 200, body: { reply: 'Hello from the other one.' } }] };
          box.value = 'Hi other';
          document.getElementById('wchatSend').click();
          await until(() => log.textContent.includes('Hello from the other one.'));
          release();
          await until(() => document.getElementById('toast').textContent.includes('Book Club answered'));
          ok('the open chat keeps its own lines', !log.textContent.includes('A late answer.') && !log.querySelector('.wchat-msg.wait'));
        } finally { window.fetch = prevFetch; release(); delete window.__override['/v1/agents/a1/chat']; }
      } finally {
        window.__answer = {};
        if (webChatDlg.open) webChatDlg.close();
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents']; delete window.__override['/v1/agents/w1/chat']; delete window.__override['/v1/agents/w1/console/access'];
        await refresh(false);
      }
    },
    // The full chat (2026-09-30): on a rebuilt agent a guest's 💬 Chat is OpenClaw's own console, on their own conversation — no token, nothing of the owner's.
    webChatConsole: async () => {
      try {
        const list = await (await fetch('/v1/agents')).json();
        const base = list.find((a) => a.id === 'a1');
        window.__override['/v1/agents'] = [...list, { ...base, id: 'w1', name: 'Book Club', role: 'user', ownerId: 'o2', webChat: true, botUsername: undefined, deepLink: undefined, otherChannels: [] }];
        window.__override['/v1/agents/w1/console/access'] = { role: 'guest', console: 'identity', session: 'agent:book-club:guest:0123456789abcdef' };
        await refresh(false);
        openV2Agent('w1');
        byText('#v2Pane button', 'Chat').click();
        await until(() => document.getElementById('consoleDlg').open);
        const src = document.getElementById('consoleFrame').getAttribute('src');
        eq('their own conversation, no token', src, '/v1/agents/w1/ui/chat?session=agent%3Abook-club%3Aguest%3A0123456789abcdef');
        eq('titled with the agent', document.getElementById('consoleTitle').textContent, 'Book Club');
        ok('no settings gear for a guest', document.getElementById('consoleGearBtn').style.display === 'none');
        ok('no approve button', document.getElementById('consoleApproveBtn').hidden);
        eq('the owner-only token was never asked for', calls('GET', /\/v1\/agents\/w1\/gateway$/).length, 0);
        ok('the chat here stayed closed', !webChatDlg.open);
        closeConsole();
        await sleep(100);
        eq('nothing of the owner\'s (seen marks) was sent', calls('POST', /\/v1\/agents\/w1\/seen$/).length, 0);
      } finally {
        if (document.getElementById('consoleDlg').open) closeConsole();
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents']; delete window.__override['/v1/agents/w1/console/access'];
        await refresh(false);
      }
    },
    // Console tabs and the quick switcher (Chris, 2026-10-07): one frame per open agent, switching never reloads.
    consoleTabs: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const mine = list.filter((x) => (x.role ? x.role === 'owner' : true) && x.state !== 'ARCHIVED' && !x.ops).slice(0, 3);
      ok('the stub has three agents of mine', mine.length === 3);
      const [A, B, C] = mine;
      for (const x of mine) window.__override['/v1/agents/' + (x.id) + '/console/access'] = { role: 'owner', console: 'identity' };
      // Nothing to approve: an approval reloads a frame, which is not what this checks.
      for (const x of mine) window.__override['/v1/agents/' + (x.id) + '/console/pending'] = { pending: 0 };
      try { localStorage.removeItem('hb-console-tabs'); } catch {}
      const frames = () => [...document.querySelectorAll('#consoleFrames iframe')];
      const tabNames = () => [...document.querySelectorAll('#consoleTabs .ctabgo span')].map((e) => e.textContent);
      try {
        await openGateway(A.id, A.slug);
        await until(() => consoleDlg.open);
        const aFrame = document.getElementById('consoleFrame');
        const aSrc = aFrame.getAttribute('src');
        ok('one tab, for the first agent', eq('tabs', tabNames(), [A.name]) ?? true);
        await openGateway(B.id, B.slug);
        eq('two tabs, in the order opened', tabNames(), [A.name, B.name]);
        ok('the second is shown, the first kept loaded behind it: ' + JSON.stringify({ same: document.getElementById('consoleFrame') === aFrame, hidden: aFrame.hidden, src: aFrame.getAttribute('src'), aSrc, n: frames().length }), document.getElementById('consoleFrame') !== aFrame && aFrame.hidden && aFrame.getAttribute('src') === aSrc);
        ok('the gold is on the active tab only', document.querySelectorAll('#consoleTabs .ctab.on').length === 1 && document.querySelector('#consoleTabs .ctab.on').textContent.includes(B.name));
        const accessCalls = calls('GET', new RegExp('/v1/agents/' + (A.id) + '/console/access$')).length;
        document.querySelector('#consoleTabs [data-id="' + (A.id) + '"]').click();
        await until(() => document.getElementById('consoleFrame') === aFrame);
        ok('switching back shows the same frame: no reload', !aFrame.hidden && aFrame.getAttribute('src') === aSrc && calls('GET', new RegExp('/v1/agents/' + (A.id) + '/console/access$')).length === accessCalls);
        eq('the title follows', document.getElementById('consoleTitle').textContent, A.name);
        // ⌘K / Ctrl+K: type part of a name, Enter.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        ok('Ctrl+K opens the switcher', !document.getElementById('consoleSwitcher').hidden && document.activeElement === document.getElementById('cswInput'));
        const inp = document.getElementById('cswInput');
        inp.value = C.name.slice(0, Math.max(3, Math.ceil(C.name.length / 2))); inp.dispatchEvent(new Event('input'));
        ok('it narrows to the name typed', [...document.querySelectorAll('#cswList [data-id]')].some((b) => b.dataset.id === C.id));
        while (document.querySelector('#cswList .sel')?.dataset.id !== C.id) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await until(() => tabNames().length === 3 && consoleAgentId === C.id);
        ok('Enter opened it in a third tab, and closed the switcher', document.getElementById('consoleSwitcher').hidden && consoleAgentId === C.id);
        // × on the active tab: it goes, and the most recently used one comes back.
        document.querySelector('#consoleTabs [data-x="' + (C.id) + '"]').click();
        await until(() => consoleAgentId === A.id);
        eq('closing a tab', tabNames(), [A.name, B.name]);
        eq('its frame went with it', frames().length, 2);
        // Closing the console unloads everything; the tabs come back, cold, next time.
        closeConsole();
        ok('every frame is unloaded when the console closes', frames().every((f) => f.getAttribute('src') === 'about:blank') && frames().length === 1);
        await openGateway(B.id, B.slug);
        await until(() => consoleDlg.open);
        eq('the tabs are remembered', tabNames(), [A.name, B.name]);
        ok('the other loads only when picked', document.querySelector('#consoleTabs [data-id="' + (A.id) + '"]').closest('.ctab').classList.contains('cold') && frames().length === 1);
      } finally {
        if (consoleDlg.open) closeConsole();
        for (const x of mine) delete window.__override['/v1/agents/' + (x.id) + '/console/access'];
        for (const x of mine) delete window.__override['/v1/agents/' + (x.id) + '/console/pending'];
        consoleTabs = []; try { localStorage.removeItem('hb-console-tabs'); } catch {}
      }
    },
    // The header's Consoles button (Chris, 2026-10-07): the first time, the Hatchabot agent with the switcher open; after that, the one you used last.
    consolesButton: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const mgr = list.find((x) => x.ops), other = list.find((x) => !x.ops && (x.role ? x.role === 'owner' : true) && x.state !== 'ARCHIVED');
      ok('the stub has a manager and another agent', !!mgr && !!other);
      for (const x of [mgr, other]) { window.__override['/v1/agents/' + x.id + '/console/access'] = { role: 'owner', console: 'identity' }; window.__override['/v1/agents/' + x.id + '/console/pending'] = { pending: 0 }; }
      try { localStorage.removeItem('hb-console-tabs'); localStorage.removeItem('hb-console-last'); } catch {}
      try {
        ok('a Consoles button in the header', !!document.querySelector('#v2HubActions #v2ConsoleBtn'));
        document.getElementById('v2ConsoleBtn').click();
        await until(() => consoleDlg.open && consoleAgentId === mgr.id);
        ok('the first time: the Hatchabot agent, with the switcher open', !document.getElementById('consoleSwitcher').hidden);
        consoleSwitcherPick(other.id);
        await until(() => consoleAgentId === other.id);
        closeConsole();
        document.getElementById('v2ConsoleBtn').click();
        await until(() => consoleDlg.open && consoleAgentId === other.id);
        ok('after that: back to the one used last, no switcher', document.getElementById('consoleSwitcher').hidden);
        closeConsole();
        await sleep(50);
        ok('no other panel in front: ' + [...document.querySelectorAll('dialog[open]')].map((d) => d.id).join(','), !document.querySelector('dialog[open]'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        await until(() => consoleDlg.open && !document.getElementById('consoleSwitcher').hidden);
        ok('Ctrl+K on the home screen opens the console with the switcher', consoleAgentId === other.id);
      } finally {
        if (consoleDlg.open) closeConsole();
        for (const x of [mgr, other]) { delete window.__override['/v1/agents/' + x.id + '/console/access']; delete window.__override['/v1/agents/' + x.id + '/console/pending']; }
        consoleTabs = []; try { localStorage.removeItem('hb-console-tabs'); localStorage.removeItem('hb-console-last'); } catch {}
      }
    },
    // A console's own address (Chris, 2026-10-07): #console=<slug> opens it, the bar shows it, the tab is named after it.
    consoleAddress: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const A = list.find((x) => !x.ops && (x.role ? x.role === 'owner' : true) && x.state !== 'ARCHIVED');
      const key = A.slug || A.id;
      window.__override['/v1/agents/' + A.id + '/console/access'] = { role: 'owner', console: 'identity' };
      window.__override['/v1/agents/' + A.id + '/console/pending'] = { pending: 0 };
      const title = document.title, opened = []; const realOpen = window.open;
      window.open = (u) => { opened.push(u); return null; };
      try {
        // Start clean: an earlier scenario can leave a console open or the
        // same #console= address in the bar, and setting an address already
        // there fires no hashchange — the open then never happens (it failed
        // 2 of 12 CI runs, 2026-10-09).
        if (consoleDlg.open) closeConsole();
        await until(() => !consoleOpening, 20000);
        history.replaceState(null, '', location.pathname + location.search);
        // A console closed just before (as the scenario before this one
        // ends): Chrome fires the dialog's close event at its next frame,
        // and when that frame came between setting the address and its
        // hashchange, the late event cleared the address and nothing opened
        // (timed out once on GitHub's runner, 2026-10-10). That order, made
        // certain: the close event is sent right after the address is set.
        await openGateway(A.id, A.slug);
        await until(() => consoleDlg.open && consoleAgentId === A.id);
        closeConsole();
        location.hash = '#console=' + key;
        consoleDlg.dispatchEvent(new Event('close'));
        // Opening chains several awaited steps (wake, health, access): slower
        // machines (GitHub's runners) need more than the usual 8 s (2026-10-09).
        await until(() => consoleDlg.open && consoleAgentId === A.id, 20000);
        ok('the address opened its console', true);
        ok('the browser tab is named after it: ' + document.title, document.title.startsWith(A.name));
        ok('no New tab button (the owner, 2026-11-09)', !document.getElementById('consoleNewTab') && ![...consoleDlg.querySelectorAll('.console-bar button')].some((b) => /new tab/i.test(b.textContent)));
        closeConsole();
        await until(() => !location.hash.includes('console='));
        eq('closing gives the page its title back', document.title, title);
        await openGateway(A.id, A.slug);
        await until(() => location.hash === '#console=' + encodeURIComponent(key));
        ok('opening one any other way puts its address in the bar', true);
        // Esc closes the dialog without closeConsole(): its close event takes
        // the address out. Headless Chrome sends that event with a frame it
        // may never draw here, so it is sent at once (a second one is harmless).
        consoleDlg.close();
        consoleDlg.dispatchEvent(new Event('close'));
        ok('Esc takes the address out', !location.hash.includes('console='));
        eq('Esc gives the page its title back', document.title, title);
        await openGateway(A.id, A.slug);
        await until(() => consoleDlg.open && location.hash.includes('console='));
        location.hash = '#console=no-such-agent-here';
        await until(() => !location.hash.includes('no-such'));
        ok('an unknown name is said, not opened', consoleAgentId === A.id);
      } finally {
        window.open = realOpen;
        if (consoleDlg.open) closeConsole();
        delete window.__override['/v1/agents/' + A.id + '/console/access']; delete window.__override['/v1/agents/' + A.id + '/console/pending'];
        consoleTabs = []; try { localStorage.removeItem('hb-console-tabs'); localStorage.removeItem('hb-console-last'); history.replaceState(null, '', location.pathname + location.search); } catch {}
      }
    },
    // The owner's console on a rebuilt agent: no token in the address (Hatchabot names them); on one not rebuilt, the token as before.
    ownerConsoleIdentity: async () => {
      try {
        window.__override['/v1/agents/a1/console/access'] = { role: 'owner', console: 'identity' };
        const a = (await (await fetch('/v1/agents')).json()).find((x) => x.id === 'a1');
        await openGateway('a1', a.slug);
        await until(() => document.getElementById('consoleDlg').open);
        const src = document.getElementById('consoleFrame').getAttribute('src');
        ok('no token in the address: ' + src, !src.includes('#token') && src.startsWith('/v1/agents/a1/ui/chat?session='));
        eq('the token was not fetched', calls('GET', /\/v1\/agents\/a1\/gateway$/).length, 0);
        ok('the settings gear is back for the owner', document.getElementById('consoleGearBtn').style.display !== 'none');
        closeConsole();
        window.__override['/v1/agents/a1/console/access'] = { role: 'owner', console: 'token' };
        window.__override['/v1/agents/a1/gateway'] = { port: 19100, token: 'made-up-console-token' };
        await openGateway('a1', a.slug);
        await until(() => document.getElementById('consoleDlg').open);
        ok('not rebuilt: the token rides in the fragment as before', document.getElementById('consoleFrame').getAttribute('src').endsWith('#token=made-up-console-token'));
        // The address bar keeps its address in the browser's history: never the token's (HB-0023).
        ok('the address bar carries no token: ' + location.hash, !location.href.includes('token') && location.hash.includes('console='));
      } finally {
        if (document.getElementById('consoleDlg').open) closeConsole();
        delete window.__override['/v1/agents/a1/console/access']; delete window.__override['/v1/agents/a1/gateway'];
      }
    },
    // 2026-11-10: Sharing → someone on this Hatchabot, no link. Google and password accounts told apart;
    // one who has it already is not offered; the share goes by id and the members list follows.
    webChatSharePerson: async () => {
      try {
        window.__override['/v1/agents/a1/members'] = [
          { userId: 'o1', role: 'owner', status: 'active', channelUserId: '11', identities: {}, account: true, webChat: false }];
        window.__override['/v1/agents/a1/web-chat/people'] = { people: [
          { userId: 'user-sam', kind: 'google', label: 'sam@example.com', shared: false },
          { userId: 'acct-sam', kind: 'password', label: 'sam@example.com', shared: false },
          { userId: 'acct-robin', kind: 'password', label: 'Robin', username: 'robin', shared: false },
          { userId: 'acct-jo', kind: 'password', label: 'Jo', shared: true }] };
        openV2Agent('a1', 'sharing');
        const row = await until(() => { const r = document.getElementById('tgShareRow'); return r && !r.hidden ? r : null; });
        const opts = [...document.querySelectorAll('#tgSharePerson option')].map((o) => o.textContent);
        eq('who is offered', opts.slice(1), ['sam@example.com · Google', 'sam@example.com · password', 'Robin (robin) · password']);
        ok('the row sits above Invite…', row.compareDocumentPosition(document.getElementById('tgInviteRow')) & Node.DOCUMENT_POSITION_FOLLOWING);
        document.getElementById('tgShareBtn').click();
        await until(() => document.getElementById('tgShareNote').textContent.includes('Choose who'));
        eq('nothing sent without a choice', calls('POST', /\/web-chat\/people$/).length, 0);
        const reads = calls('GET', /\/v1\/agents\/a1\/members$/).length;
        document.getElementById('tgSharePerson').value = 'acct-robin';
        document.getElementById('tgShareBtn').click();
        const sent = await until(() => calls('POST', /\/v1\/agents\/a1\/web-chat\/people$/)[0]);
        eq('shared by id', sent.body, { userId: 'acct-robin' });
        await until(() => calls('GET', /\/v1\/agents\/a1\/members$/).length > reads);
        ok('the members list is read again', true);
        v2Close();
        // Nobody to offer: no row.
        window.__override['/v1/agents/a1/web-chat/people'] = { people: [{ userId: 'acct-jo', kind: 'password', label: 'Jo', shared: true }] };
        const asks = calls('GET', /\/web-chat\/people$/).length;
        openV2Agent('a1', 'sharing');
        await until(() => calls('GET', /\/web-chat\/people$/).length > asks);
        await sleep(50);
        ok('everyone has it: no row', document.getElementById('tgShareRow').hidden);
      } finally {
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents/a1/members']; delete window.__override['/v1/agents/a1/web-chat/people'];
      }
    },
    // The owner's Members list: a badge on who has web chat, and the switch — turning it ON repeats the rights warning.
    webChatToggle: async () => {
      try {
        window.__override['/v1/agents/a1/members'] = [
          { userId: 'o1', role: 'owner', status: 'active', channelUserId: '11', identities: {}, account: true, webChat: false },
          { userId: 'user-sam', displayName: 'Sam', role: 'user', status: 'active', channelUserId: '12', identities: {}, account: true, webChat: false },
          { userId: 'user-jo', displayName: 'Jo', role: 'user', status: 'active', identities: {}, account: true, webChat: true },
          { userId: 'member-1', displayName: 'Lee', role: 'user', status: 'active', channelUserId: '13', identities: {}, account: false, webChat: false }];
        openV2Agent('a1', 'sharing');
        const rows = await until(() => { const r = [...document.querySelectorAll('#tgMemberList .pair')]; return r.length === 4 ? r : null; });
        const [, sam, jo, lee] = rows;
        ok('Jo carries the web chat badge', !!jo.querySelector('.chip.webchat') && !sam.querySelector('.chip.webchat'));
        ok('a web-only member is not told to message a bot', !jo.textContent.includes("hasn't messaged yet"));
        ok('no switch for someone who cannot sign in here', !byText('#tgMemberList .pair:nth-child(4) button', 'web chat') && !lee.textContent.includes('Allow web chat'));
        const allow = [...sam.querySelectorAll('button')].find((b) => b.textContent.includes('Allow web chat'));
        ok('an Allow web chat switch for Sam', !!allow);
        window.__confirmAnswer = false;
        allow.click(); await sleep(100);
        const said = window.__confirms.at(-1) || '';
        ok("it says the rights first — a member's, like a Telegram member: " + said,
          /a member's rights, exactly like a Telegram member/.test(said) && /ask it to use its tools, but not schedule tasks or change its settings/.test(said));
        ok('no longer says it hands over your rights', !/your rights|hand your laptop/.test(said));
        ok("the badge says a member's rights", /a member's rights/.test(jo.querySelector('.chip.webchat').title));
        eq('declined: nothing sent', calls('PUT', /\/web-chat$/).length, 0);
        window.__confirmAnswer = true;
        allow.click();
        const on = await until(() => calls('PUT', /\/v1\/agents\/a1\/members\/user-sam\/web-chat$/)[0]);
        eq('turned on', on.body, { on: true });
        const asked = window.__confirms.length;
        const off = await until(() => [...document.querySelectorAll('#tgMemberList .pair')].map((r) => [...r.querySelectorAll('button')].find((b) => b.textContent.includes('Turn off web chat'))).find(Boolean));
        off.click();
        const offCall = await until(() => calls('PUT', /\/v1\/agents\/a1\/members\/user-jo\/web-chat$/)[0]);
        eq('turned off', offCall.body, { on: false });
        eq('turning off does not ask', window.__confirms.length, asked);
      } finally {
        window.__confirmAnswer = true;
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents/a1/members'];
      }
    },
    // The invite dialog's third way, with its warning; a link only when asked for. An agent in no chat app gets the web way alone.
    inviteWebChat: async () => {
      try {
        window.__promptAnswer = '';
        window.__answer = { 'POST /v1/agents/a1/invites': [
          { status: 201, body: { code: 'PLAIN', path: '/join/PLAIN' } },
          { status: 201, body: { code: 'WEBCHAT', path: '/join/WEBCHAT', url: 'https://hb.example/join/WEBCHAT' } }] };
        await invite('a1', 'Homework Helper');
        await until(() => inviteDlg.open);
        const web = document.getElementById('invWeb');
        ok('the web way shows', !web.hidden && web.textContent.includes('Chat on the web.'));
        ok("it says what they get, briefly: a member's rights", /with a member's rights: no scheduling, no settings/.test(web.textContent) && web.textContent.replace(/\s+/g, ' ').trim().length < 300);
        ok('no longer says it hands over your rights', !/your rights|hand your laptop/.test(web.textContent));
        eq('only the plain invite so far', calls('POST', /\/v1\/agents\/a1\/invites$/).map((c) => c.body), [{}]);
        document.getElementById('invWebBtn').click();
        await until(() => !document.getElementById('invWebLink').hidden);
        eq('the web chat invite', calls('POST', /\/v1\/agents\/a1\/invites$/)[1].body, { webChat: true });
        eq('its link', document.getElementById('invWebLink').textContent, 'https://hb.example/join/WEBCHAT');
        inviteDlg.close();
        const piano = agents.find((a) => a.name === 'Piano Practice');
        const posts = calls('POST', /\/invites$/).length;
        window.__promptAnswer = null; // a Telegram question would cancel the invite
        await invite(piano.id, piano.name);
        await until(() => inviteDlg.open);
        ok('no chat-app part for an agent in no chat app', document.getElementById('invApps').hidden && !document.getElementById('invWeb').hidden);
        eq('nothing minted until asked', calls('POST', /\/invites$/).length, posts);
      } finally {
        window.__promptAnswer = null; window.__answer = {};
        if (inviteDlg.open) inviteDlg.close();
      }
    },
    // Access promises (2026-09-30): the Telegram invite opens a knock window
    // when copied, "Let them in again" asks for a handle when the app is not
    // known, removal says scheduled tasks live on, and the Hatchabot agent
    // offers nobody a way in.
    accessPromises: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const hb = list.find((a) => a.ops);
      try {
        window.__promptAnswer = '@maria_k';
        window.__answer = {
          'POST /v1/agents/a1/invites': [{ status: 201, body: { code: 'TGCODE', path: '/join/TGCODE' } }],
          'POST /v1/agents/a1/invites/TGCODE/knock-window': [{ status: 200, body: { open: true, minutes: 30, for: 'maria_k' } }] };
        await invite('a1', 'Homework Helper');
        await until(() => inviteDlg.open);
        const dlg = document.getElementById('inviteDlg').textContent.replace(/\s+/g, ' ');
        ok('the member wording says what chat reaches: ' + dlg.slice(0, 240), dlg.includes("they can't change its settings here, but through chat they can use everything the agent can"));
        ok('the Telegram way promises a knock, never an automatic admit', dlg.includes('holds the door open for 30 minutes') && dlg.includes('Nobody is let in without that tap'));
        ok('names who it is for', dlg.includes("Only @maria_k's message is shown"));
        eq('no window until it is sent', calls('POST', /\/knock-window$/).length, 0);
        byText('#inviteDlg button', 'Copy Telegram invite').click();
        await until(() => calls('POST', /^\/v1\/agents\/a1\/invites\/TGCODE\/knock-window$/).length === 1);
        await until(() => document.getElementById('toast').textContent.includes('Alerts'));
        inviteDlg.close();

        window.__override['/v1/agents/a1/members'] = [
          { userId: 'o1', role: 'owner', status: 'active', channelUserId: '11', identities: {}, account: true, webChat: false },
          { userId: 'member-late', displayName: 'Maria', role: 'user', status: 'active', identities: {}, account: false, webChat: false }];
        window.__answer = { 'POST /v1/agents/a1/members/member-late/reopen': [
          { status: 409, body: { error: 'We do not know which app they joined with.', code: 'needs-handle' } },
          { status: 200, body: { reopened: true, minutes: 30, on: ['telegram'], for: 'maria_k' } }] };
        openV2Agent('a1', 'sharing');
        const again = await until(() => byText('#tgMemberList button', 'Let them in again'));
        ok('its tooltip says which app: ' + again.title, again.title.includes('the app they joined with') && again.title.includes('@handle'));
        again.click();
        await until(() => calls('POST', /member-late\/reopen$/).length === 2);
        eq('asked again with their handle', calls('POST', /member-late\/reopen$/)[1].body, { handle: '@maria_k' });
        await until(() => document.getElementById('toast').textContent.includes('for @maria_k only'));
        window.__confirmAnswer = false;
        byText('#tgMemberList button', 'Remove').click(); await sleep(100);
        ok('removal says their scheduled tasks keep running', (window.__confirms.at(-1) || '').includes('keeps running; check Schedule'));
        eq('declined: nobody removed', calls('DELETE', /\/members\//).length, 0);
        window.__confirmAnswer = true;
        v2Close();

        // The manager: no members block, no Invite, no "Let them in", no "Who can reach it".
        window.__override['/v1/agents'] = list.map((a) => a.ops ? { ...a, botUsername: 'HbBot', deepLink: 'https://t.me/x', webOnly: false } : a);
        window.__override['/v1/agents/' + hb.id + '/channels'] = { channels: [{ kind: 'telegram', displayName: 'Hatchabot', youAreLinked: true, rooms: { mode: 'members' }, people: [] }], imageSupports: [], spare: {} };
        await refresh(false);
        pairings[hb.id] = [{ code: 'K1', kind: 'telegram', id: '77', meta: { firstName: 'Stranger' } }];
        openV2Agent(hb.id, 'sharing');
        const pane = document.getElementById('v2Pane');
        ok('Sharing says it is yours alone: ' + pane.textContent.replace(/\s+/g, ' ').slice(0, 200), pane.textContent.includes('yours alone') && !pane.querySelector('#tgMembersBlock'));
        openV2Agent(hb.id, 'messaging');
        const card = await until(() => { const c = document.querySelector('#v2Chans .v2chan'); return c && c.textContent.includes('Stranger') ? c : null; });
        ok('a knock on it offers "That\'s me", not "Let them in"', !!byText('#v2Chans button', "That's me") && !byText('#v2Chans button', 'Let them in'));
        ok('no "Who can reach it" for it', !card.textContent.includes('Who can reach it'));
        v2Close();
        // Nor on the home screen's join list or the agent's notices: the server answers 400 (review, 2026-10-09).
        renderV2Joins();
        const joins = document.getElementById('v2JoinList');
        ok('the join list has the knock: ' + joins.textContent.replace(/\s+/g, ' ').slice(0, 160), joins.textContent.includes('Stranger'));
        ok('but no "Let them in" for the manager', !byText('#v2JoinList button', 'Let them in'));
        ok('nor in its notices', !agentNotices(v2Find(hb.id)).includes('Let them in'));
      } finally {
        window.__promptAnswer = null; window.__answer = {}; window.__confirmAnswer = true;
        if (inviteDlg.open) inviteDlg.close();
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents/a1/members'];
        delete window.__override['/v1/agents'];
        if (hb) { delete window.__override['/v1/agents/' + hb.id + '/channels']; delete pairings[hb.id]; }
        await refresh(false);
      }
    },
    // Share a copy (2026-09-30): the file says what it mentions about people before it is saved; MEMORY.md is its own question.
    sharePersonal: async () => {
      const prev = window.fetch;
      const asked = [];
      try {
        const personal = { emails: 2, phones: 1, tokens: 0, more: 0, hits: [
          { where: 'AGENTS.md', line: 3, kind: 'email', sample: 'ann@example.com' },
          { where: 'Scheduled task “Digest”', line: 1, kind: 'phone', sample: '416-555-0123' }] };
        window.fetch = async (input, init) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (!/\/v1\/agents\/a1\/export(\?|$)/.test(url)) return prev(input, init);
          asked.push(url);
          return new Response(new Blob(['x']), { status: 200, headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="homework-helper.template.hatchabot"',
            'x-hatchabot-personal': encodeURIComponent(JSON.stringify(personal)) } });
        };
        openV2Agent('a1', 'sharing');
        const btn = await until(() => byText('#v2Pane button', 'Share a copy'));
        ok('the button says what the copy is: ' + btn.title, /instructions and scheduled tasks, without its bot, members or conversations\. Read it before you send it/.test(btn.title) && !/safe to email/i.test(btn.title));
        // Esc on the MEMORY.md question stops it: confirm() made Esc mean "without MEMORY.md" (review, 2026-10-09).
        btn.click();
        await until(() => choiceDlg.open);
        ok('asked about MEMORY.md in plain words: ' + document.getElementById('choiceText').textContent, document.getElementById('choiceText').textContent.includes('MEMORY.md (its summary notes) may contain personal facts'));
        choiceDlg.close(); await sleep(100);
        eq('Esc: nothing exported', asked.length, 0);
        window.__confirmAnswer = false; // leave MEMORY.md out, then don't save
        btn.click();
        await until(() => choiceDlg.open);
        byText('#choiceBtns button', 'Instructions and tasks only').click();
        await until(() => document.getElementById('toast').textContent.includes('Not saved'));
        const said = window.__confirms.slice(-1);
        ok('then said what the copy mentions: ' + said[0], said[0].includes('This copy mentions 2 email addresses and 1 phone number — read it before you send it.'));
        ok('and where', said[0].includes('AGENTS.md, line 3: ann@example.com') && said[0].includes('Scheduled task “Digest”, line 1: 416-555-0123'));
        ok('without MEMORY.md: ' + asked[0], asked[0].endsWith('?excludeMemory=1'));
        window.__confirmAnswer = true;
        btn.click();
        await until(() => choiceDlg.open);
        byText('#choiceBtns button', 'Also MEMORY.md').click();
        await until(() => document.getElementById('toast').textContent.includes('Saved homework-helper.template.hatchabot'));
        ok('with MEMORY.md this time', asked.length === 2 && !asked[1].includes('excludeMemory'));
        // Recover context: Cancel and Esc start nothing; a choice says which (review, 2026-10-09).
        const rec = () => calls('POST', /\/recover-context$/).length, r0 = rec();
        let p = recoverContext('a1', 'Test Agent');
        await until(() => choiceDlg.open);
        choiceDlg.close(); await p;
        p = recoverContext('a1', 'Test Agent');
        await until(() => choiceDlg.open);
        byText('#choiceBtns button', 'Cancel').click(); await p;
        eq('Esc and Cancel: not started', rec() - r0, 0);
        p = recoverContext('a1', 'Test Agent');
        await until(() => choiceDlg.open);
        byText('#choiceBtns button', 'Also the current one').click(); await p;
        eq('started, with the current conversation', calls('POST', /\/recover-context$/).at(-1).body, { includeLive: true });
      } finally {
        window.fetch = prev; window.__confirmAnswer = true;
        if (choiceDlg.open) choiceDlg.close();
        try { v2Close(); } catch {}
      }
    },
    // Send to someone here: the count and the places show in the dialog before anything leaves.
    sendScan: async () => {
      try {
        window.__override['/v1/agents/a1/export/scan'] = { emails: 13, phones: 2, tokens: 0, more: 12, hits: [
          { where: 'AGENTS.md', line: 4, kind: 'email', sample: 'owner@example.com' },
          { where: 'AGENTS.md', line: 9, kind: 'phone', sample: '(416) 555-0199' }] };
        openSendAgent('a1', 'Homework Helper');
        const scan = document.getElementById('sendScan');
        await until(() => scan.textContent.includes('read it before you send it'));
        ok('the count: ' + scan.textContent.replace(/\s+/g, ' ').slice(0, 120), scan.textContent.includes('This copy mentions 13 email addresses and 2 phone numbers — read it before you send it.'));
        ok('where, behind a toggle', !!scan.querySelector('details') && scan.querySelector('details').textContent.includes('AGENTS.md, line 4: owner@example.com') && scan.querySelector('details').textContent.includes('…and 12 more'));
        ok('the scan leaves MEMORY.md out, as the send does', calls('GET', /\/v1\/agents\/a1\/export\/scan$/).at(-1).url.includes('excludeMemory=1'));
        ok('the dialog no longer promises safe contents', !/safe contents/i.test(document.getElementById('sendAgentDlg').textContent));
      } finally {
        delete window.__override['/v1/agents/a1/export/scan'];
        if (sendAgentDlg.open) sendAgentDlg.close();
      }
    },
    // HB-0117: a configured copy whose AGENTS.md the agent changed itself travels without that change, and both ways of sharing say so.
    shareEdited: async () => {
      const prev = window.fetch;
      try {
        const brief = { emails: 0, phones: 0, tokens: 0, more: 0, hits: [], edited: ['AGENTS.md'] };
        window.fetch = async (input, init) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (!/\/v1\/agents\/a1\/export(\?|$)/.test(url)) return prev(input, init);
          return new Response(new Blob(['x']), { status: 200, headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="homework-helper.template.hatchabot"',
            'x-hatchabot-personal': encodeURIComponent(JSON.stringify(brief)) } });
        };
        window.__confirmAnswer = false;
        const n0 = window.__confirms.length;
        await saveFromServer('/v1/agents/a1/export?excludeMemory=1', 'agent-template.json', personalCheck);
        const said = window.__confirms.slice(n0);
        ok('the download asks once, naming the edited file: ' + said[0], said.length === 1 && said[0].includes('Its AGENTS.md was changed outside the Files editor') && said[0].includes('without those changes'));
        ok('and mentions no people', !said[0].includes('This copy mentions'));
        ok('Cancel: not saved', document.getElementById('toast').textContent.includes('Not saved'));
        window.__override['/v1/agents/a1/export/scan'] = brief;
        openSendAgent('a1', 'Homework Helper');
        const scan = document.getElementById('sendScan');
        await until(() => scan.textContent.includes('changed outside the Files editor'));
        ok('the send dialog says it too: ' + scan.textContent.replace(/\s+/g, ' ').slice(0, 160), scan.textContent.includes('The copy mentions no email addresses') && scan.textContent.includes('open AGENTS.md in its Files and save it there'));
        // A copy with no edits says nothing of them.
        window.__override['/v1/agents/a1/export/scan'] = { ...brief, edited: [] };
        sendAgentDlg.close();
        openSendAgent('a1', 'Homework Helper');
        await until(() => scan.textContent.includes('The copy mentions no email addresses'));
        ok('no edits: no note', !scan.textContent.includes('Files editor'));
      } finally {
        window.fetch = prev; window.__confirmAnswer = true;
        delete window.__override['/v1/agents/a1/export/scan'];
        if (sendAgentDlg.open) sendAgentDlg.close();
      }
    },
    // Asleep (2026-09-30): the tile says opening it wakes it — so opening it wakes it, in the console, saying so.
    asleepTileWakes: async () => {
      try {
        const list = await (await fetch('/v1/agents')).json();
        window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, state: 'STOPPED', hibernatedAt: new Date().toISOString() } : a);
        window.__override['/v1/agents/a1/health'] = { reachable: true, status: 'healthy' };
        await refresh(false);
        const t = tile('Homework Helper');
        ok('the tile says it is asleep', !!t && v2Status(agents.find((a) => a.id === 'a1')).label === 'Asleep — wakes when someone writes to it, or when you open it');
        t.click();
        await until(() => document.getElementById('consoleDlg').open);
        ok('it says it is waking it', document.getElementById('consoleCover').textContent.includes('Waking it up'));
        await until(() => calls('POST', /\/v1\/agents\/a1\/wake$/).length === 1);
        ok('not the settings sheet', !v2AgentDlg.open);
        await until(() => (document.getElementById('consoleFrame').getAttribute('src') || '').startsWith('/v1/agents/a1/ui/chat'), 12000);
      } finally {
        if (document.getElementById('consoleDlg').open) closeConsole();
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents']; delete window.__override['/v1/agents/a1/health'];
        await refresh(false);
      }
    },
    // Health (2026-09-30): the gateway answering is not its AI source answering.
    healthAiSource: async () => {
      try {
        const hAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
        window.__override['/v1/agents/a1/health'] = { reachable: true, status: 'healthy', pluginErrors: [],
          aiSource: { name: 'Claude Max (household)', lastAnsweredAt: hAgo(5), refusingSince: hAgo(2), refusal: 'refused' } };
        // Overview → Checks → ❤️ Check health (the classic ⋯ → ❤️ Health went with the classic look, v2.155.0).
        openV2Agent('a1', 'overview');
        await until(() => document.getElementById('v2HealthSlot'));
        byText('#v2AgentDlg button', 'Check health').click();
        const body = document.getElementById('healthBody');
        ok('it opens in the Overview', document.getElementById('v2HealthSlot').contains(body) && !document.getElementById('v2HealthSlot').hidden);
        await until(() => body.textContent.includes('AI source'));
        ok('not "Responding" while its source refuses: ' + body.textContent.replace(/\s+/g, ' ').slice(0, 160), body.textContent.includes('Up, but its AI source is not answering') && !body.textContent.includes('Responding'));
        ok('refused since, and when it last answered', /refused \(rate-limited\) since 2h ago/.test(body.textContent) && body.textContent.includes('last answered 5h ago'));
        ok('it says what it checks', document.getElementById('healthDlgBody').textContent.includes('Checks its gateway and chat connection, and when its AI source last answered'));
        window.__override['/v1/agents/a1/health'] = { reachable: true, status: 'healthy', pluginErrors: [], aiSource: { lastAnsweredAt: hAgo(2) } };
        await loadHealth();
        await until(() => body.textContent.includes('Responding'));
        ok('answering: last answered: ' + body.textContent.replace(/\s+/g, ' ').slice(0, 160), /AI source\s*last answered 2h ago/.test(body.textContent.replace(/\s+/g, ' ')));
      } finally {
        delete window.__override['/v1/agents/a1/health'];
        try { v2Close(); } catch {}
      }
    },
    // Health (review, 2026-10-22): a Discord or Slack bot that lost its connection is named.
    healthDiscordDisconnected: async () => {
      try {
        window.__override['/v1/agents/a1/health'] = { reachable: true, status: 'degraded', ok: true, pluginErrors: [], disconnected: ['discord'] };
        openV2Agent('a1', 'overview');
        await until(() => document.getElementById('v2HealthSlot'));
        byText('#v2AgentDlg button', 'Check health').click();
        const body = document.getElementById('healthBody');
        await until(() => body.textContent.includes('Discord connected'));
        ok('the Discord row says disconnected: ' + body.textContent.replace(/\s+/g, ' ').slice(0, 160), /Discord connected\s*disconnected/.test(body.textContent.replace(/\s+/g, ' ')));
        ok('and it is listed as a problem', v2HealthProblems({ reachable: true, status: 'degraded', disconnected: ['slack'] }).includes('Slack is not connected'));
      } finally {
        delete window.__override['/v1/agents/a1/health'];
        try { v2Close(); } catch {}
      }
    },
    // Audit 2026-10-22 (B22): past the first 20 the server sends a count, the worst first; the page counts them all.
    healthLintCountsAll: async () => {
      try {
        const findings = [{ severity: 'error', checkId: 'gateway.bind', message: 'the gateway listens on every address' }]
          .concat(Array.from({ length: 19 }, (_, i) => ({ severity: 'info', checkId: 'note.' + i, message: 'note ' + i })));
        const h = { reachable: true, status: 'healthy', ok: false, doctor: { findings, checksRun: 40, mutedCount: 0, omittedCount: 5 } };
        window.__override['/v1/agents/a1/health'] = h;
        openV2Agent('a1', 'overview');
        await until(() => document.getElementById('v2HealthSlot'));
        byText('#v2AgentDlg button', 'Check health').click();
        const body = document.getElementById('healthBody');
        await until(() => body.textContent.includes('Config warnings'));
        const t = body.textContent.replace(/\s+/g, ' ');
        ok('the count is all 25, not the 20 sent: ' + t.slice(0, 200), /Config warnings\s*25 findings/.test(t));
        ok('the error is listed first', t.indexOf('gateway.bind') >= 0 && t.indexOf('gateway.bind') < t.indexOf('note.0'));
        ok('and the rest are counted, not dropped', t.includes('… and 19 more'));
        ok('Alerts count them all too', v2HealthProblems(h).some((x) => x.startsWith('25 settings to fix')));
      } finally {
        delete window.__override['/v1/agents/a1/health'];
        try { v2Close(); } catch {}
      }
    },
    // Chat → Memory (2026-09-30): a turn that changed nothing is not "Saved".
    checkpointNothingNew: async () => {
      try {
        window.__answer = { 'POST /v1/agents/a1/checkpoint': [{ status: 200, body: { ok: true, saved: false, nothingNew: true, note: 'It found nothing new to save — its memory files are unchanged.' } }] };
        await checkpointAgent('a1', 'Homework Helper');
        const t = document.getElementById('toast').textContent;
        ok('says it found nothing new: ' + t, t.includes('found nothing new to save') && !t.includes('Saved'));
      } finally {
        window.__answer = {};
      }
    },
    // Settings promises (2026-09-30): what the AI source says about sharing and helper calls; the disk warning; an unpriced model.
    // (The classic look's rate-limit banner went with it, v2.155.0: a limited source is on each of its agents' tiles.)
    sourcePromises: async () => {
      const savedProfiles = profiles;
      try {
        // The dialog paints from the page's own list (it is fetched with the fleet).
        window.__override['/v1/ai-profiles'] = profiles = [{ id: 'p1', name: 'Claude token', vendor: 'anthropic', kind: 'subscription', credential: 'setup-token', mine: true,
          ownerId: 'o1', model: 'claude-sonnet-5', models: [], shared: true, defaultSource: true }];
        await openAiDlg('ai');
        const list = await until(() => { const el = document.getElementById('aiList'); return el && el.textContent.includes('Claude token') ? el : null; });
        ok('the checkbox is Helper calls', list.textContent.includes('Helper calls') && !list.textContent.includes('Management'));
        const helper = [...list.querySelectorAll('label')].find((l) => l.textContent.includes('Helper calls'));
        ok('its tooltip says what it is used for: ' + helper.title, /small background calls \(like picking icons\)/.test(helper.title));
        ok('sharing no longer promises they never see it', !list.textContent.includes('never see it'));
        ok('it says their agents hold the key', list.textContent.includes('Their agents hold it, so someone determined can read it from their own agent'));
        ok('and how to take it back', list.textContent.includes('un-share, move their agents, and replace the token'));
        aiDlg.close();
      } finally {
        delete window.__override['/v1/ai-profiles'];
        profiles = savedProfiles;
        if (aiDlg.open) aiDlg.close();
      }
    },
    diskWarning: async () => {
      try {
        const list = await (await fetch('/v1/agents')).json();
        window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, diskOver: { bytes: 12.4e9, warnBytes: 10e9, measuredAt: new Date().toISOString() } } : a);
        await refresh(false);
        openV2Agent('a1', 'overview');
        const why = await until(() => [...document.querySelectorAll('.v2why li')].find((li) => li.textContent.includes('GB of storage')));
        ok('Alerts says how big: ' + why.textContent, why.textContent.includes('it uses 12.4 GB of storage (the warning is at 10 GB)'));
        v2Close();
        // The security check lists who is over.
        window.__override['/v1/security/posture'] = { comparedToPrior: false, changes: { added: [], removed: [] }, report: { install: [], agents: [],
          limits: { agentCap: 0, liveAgents: 14, diskWarnGB: 10, overDisk: [{ id: 'a1', name: 'Homework Helper', bytes: 12.4e9, measuredAt: new Date().toISOString() }] } } };
        await loadPosture();
        const out = document.getElementById('postureOut').textContent;
        ok('the check says it is measured: ' + out, out.includes('Disk warning at 10 GB per agent (measured daily)'));
        ok('and names the agent over it', out.includes('Homework Helper uses 12.4 GB'));
      } finally {
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents']; delete window.__override['/v1/security/posture'];
        await refresh(false);
      }
    },
    // A hosted Hatchabot takes Claude by API key only (2026-09-30): no Claude plan option in Settings or the setup guide.
    hostedClaudeByApiKey: async () => {
      const savedConfig = appConfig, savedProfiles = profiles, savedAccount = myAccount;
      const kindSel = document.getElementById('aiKind');
      const planOpt = kindSel.querySelector('option[value="subscription"]');
      try {
        ok('a home install offers the Claude plan', !!planOpt);
        window.__override['/v1/config'] = { ...appConfig, managed: { by: 'Example Cloud' }, claudePlan: false };
        await loadConfig();
        await openAiDlg('ai');
        ok('Settings → AI sources offers no Claude plan', ![...kindSel.options].some((o) => o.value === 'subscription' || /subscription|setup.token/i.test(o.textContent)));
        eq('the form opens on API key', kindSel.value, 'api_key');
        ok('no setup-token field', document.getElementById('aiTokenRow').style.display === 'none' && document.getElementById('aiKeyRow').style.display === '');
        const note = document.getElementById('aiHostedNote');
        ok('it says how: ' + note.textContent, !note.hidden && note.textContent.includes('connect Claude with an API key from') && note.textContent.includes('console.anthropic.com'));
        aiDlg.close();
        // The setup guide's first step, for an owner with no source yet.
        profiles = []; myAccount = { ...myAccount, hostOwner: true };
        setupOpen = true; renderSetup();
        const setup = document.getElementById('setup');
        ok('the guide asks for an API key, not a setup token', !!document.getElementById('setupApiKey') && !document.getElementById('setupToken')
          && !setup.textContent.includes('claude setup-token') && !setup.textContent.includes('Use my Claude subscription'));
        document.getElementById('setupApiKey').value = 'sk-ant-api-made-up';
        byText('#setup button', 'Connect Claude').click();
        const made = await until(() => calls('POST', /^\/v1\/ai-profiles$/).pop());
        eq('it makes an API-key source', { kind: made.body.kind, vendor: made.body.vendor }, { kind: 'api_key', vendor: 'anthropic' });
        ok('and sends no token', !('oauthToken' in made.body));
      } finally {
        delete window.__override['/v1/config'];
        appConfig = savedConfig; profiles = savedProfiles; myAccount = savedAccount; setupOpen = false;
        if (planOpt && !kindSel.querySelector('option[value="subscription"]')) kindSel.insertBefore(planOpt, kindSel.firstChild);
        document.getElementById('aiHostedNote').hidden = true;
        if (aiDlg.open) aiDlg.close();
        renderSetup();
      }
    },
    // ---- public access (docs/public-access.md) --------------------------------
    secondFactorEnrol: async () => {
      const none = { factors: [], backupCodes: 0, need: 'missing', ownerRights: true, methods: [], publicAddress: false, localAccount: true, passkeyAddress: 'https://box.example.com', passkeyHere: false };
      window.__override['/v1/second-factor'] = none;
      window.__override['/v1/public-access'] = { on: false, serving: false, safeguards: [], failing: [], invitedOnly: false };
      try {
        await openAiDlg('access');
        const box = await until(() => { const b = document.getElementById('sfBox'); return !b.hidden && b; });
        ok('it says the owner has none: ' + document.getElementById('sfStatus').textContent, document.getElementById('sfStatus').textContent.includes('You have none') && document.getElementById('sfStatus').textContent.includes('reachable from the internet'));
        ok('the current password is asked for (a local account)', !document.getElementById('sfPwRow').hidden);
        ok('a passkey is not offered away from its address, and says where', document.getElementById('sfAddPasskeyBtn').disabled && document.getElementById('sfAddPasskeyBtn').title.includes('https://box.example.com'));
        ok('no backup-code button before a factor exists', document.getElementById('sfBackupBtn').hidden);
        // A wrong password is shown, not swallowed.
        window.__answer = { 'POST /v1/second-factor/totp': [{ status: 401, body: { error: 'Current password is wrong.', needsPassword: true } }] };
        document.getElementById('sfCurPw').value = 'wrong';
        document.getElementById('sfAddTotpBtn').click();
        await until(() => document.getElementById('sfBoxErr').textContent.includes('Current password is wrong'));
        ok('no QR for a wrong password', document.getElementById('sfTotpBox').hidden);
        // The right one: the QR, the key, then a code. (The key is made up here: RFC 6238's test seed, in base32.)
        const madeUpKey = ['GEZDGNBV', 'GY3TQOJQ'].join('').repeat(2); // RFC 6238's seed in base32, split for secret scanners
        window.__answer = {
          'POST /v1/second-factor/totp': [{ body: { id: 'sf-1', secret: madeUpKey, uri: 'otpauth://totp/x', qr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>' } }],
          'POST /v1/second-factor/totp/confirm': [{ status: 401, body: { error: 'That code is not right.' } }, { body: { ok: true, backupCodes: ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'] } }],
        };
        document.getElementById('sfCurPw').value = 'the-right-password';
        document.getElementById('sfAddTotpBtn').click();
        const start = await until(() => calls('POST', /\/v1\/second-factor\/totp$/)[1]);
        eq('the password is the proof', start.body, { current: 'the-right-password' });
        await until(() => !document.getElementById('sfTotpBox').hidden);
        ok('the QR is an image', !!document.querySelector('#sfTotpQr img[src^="data:image/svg+xml;base64,"]'));
        eq('the key, in groups of four', document.getElementById('sfTotpSecret').textContent, 'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ');
        document.getElementById('sfTotpCode').value = '000000';
        document.getElementById('sfTotpConfirmBtn').click();
        await until(() => document.getElementById('sfBoxErr').textContent.includes('not right'));
        ok('a wrong code leaves the QR up', !document.getElementById('sfTotpBox').hidden);
        // A setup the server cancelled (a factor removed in another tab): no code can finish it, so the box goes and the reason stays (HB-0375).
        window.__answer['POST /v1/second-factor/totp/confirm'].unshift({ status: 409, body: { error: 'This setup was cancelled: your second factors changed since the code was shown. Add the app again.' } });
        document.getElementById('sfTotpCode').value = '111111';
        document.getElementById('sfTotpConfirmBtn').click();
        await until(() => document.getElementById('sfBoxErr').textContent.includes('setup was cancelled'));
        ok('a cancelled setup closes its box', document.getElementById('sfTotpBox').hidden);
        ok('and takes its secret off the page', document.getElementById('sfTotpSecret').textContent === '' && document.getElementById('sfTotpQr').innerHTML === '');
        window.__answer['POST /v1/second-factor/totp'] = [{ body: { id: 'sf-1', secret: madeUpKey, uri: 'otpauth://totp/x', qr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>' } }];
        document.getElementById('sfCurPw').value = 'the-right-password';
        document.getElementById('sfAddTotpBtn').click();
        await until(() => !document.getElementById('sfTotpBox').hidden);
        ok('starting again clears the reason', document.getElementById('sfBoxErr').textContent === '');
        window.__override['/v1/second-factor'] = { ...none, need: 'yes', methods: ['totp', 'backup'], backupCodes: 2, factors: [{ id: 'sf-1', kind: 'totp', createdAt: new Date().toISOString() }] };
        document.getElementById('sfTotpCode').value = '123456';
        document.getElementById('sfTotpConfirmBtn').click();
        await until(() => backupDlg.open);
        eq('the confirm', calls('POST', /\/totp\/confirm$/).pop().body, { id: 'sf-1', code: '123456' });
        ok('both backup codes are shown', document.getElementById('backupCodes').textContent.includes('AAAA-BBBB-CCCC') && document.getElementById('backupCodes').textContent.includes('DDDD-EEEE-FFFF'));
        ok('Done waits for "I have saved them"', document.getElementById('backupDone').disabled);
        document.getElementById('backupSaved').click();
        document.getElementById('backupDone').click();
        await until(() => !backupDlg.open && document.getElementById('sfList').textContent.includes('Authenticator app'));
        ok('the codes are gone from the page', document.getElementById('backupCodes').textContent === '');
        ok('the password box is cleared', document.getElementById('sfCurPw').value === '');
        ok('the secret is gone from the page', document.getElementById('sfTotpSecret').textContent === '' && document.getElementById('sfTotpBox').hidden);
        ok('backup codes can now be remade', !document.getElementById('sfBackupBtn').hidden);
        ok('it says how many are left', document.getElementById('sfStatus').textContent.includes('2 backup codes left'));
        // Removing asks first, and sends the proof.
        window.__confirmAnswer = false;
        document.querySelector('#sfList .sfRemove').click(); await sleep(150);
        eq('declined: nothing removed', calls('DELETE', /\/v1\/second-factor\//).length, 0);
        window.__confirmAnswer = true;
        document.getElementById('sfCurPw').value = 'the-right-password';
        document.querySelector('#sfList .sfRemove').click();
        const del = await until(() => calls('DELETE', /\/v1\/second-factor\/sf-1$/)[0]);
        eq('the removal carries the password', del.body, { current: 'the-right-password' });
        await until(() => document.getElementById('toast').textContent === 'Removed');
        // An app still being added when a factor is removed: the server cancelled it, so its box closes and says so (HB-0375).
        window.__override['/v1/second-factor'] = { ...none, need: 'yes', methods: ['totp', 'backup'], backupCodes: 2, factors: [{ id: 'sf-1', kind: 'totp', createdAt: new Date().toISOString() }, { id: 'sf-2', kind: 'passkey', label: 'A key', createdAt: new Date().toISOString() }] };
        await loadSecondFactor();
        window.__answer['POST /v1/second-factor/totp'] = [{ body: { id: 'sf-3', secret: madeUpKey, uri: 'otpauth://totp/x', qr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>' } }];
        document.getElementById('sfCurPw').value = 'the-right-password';
        document.getElementById('sfAddTotpBtn').click();
        await until(() => !document.getElementById('sfTotpBox').hidden);
        document.getElementById('sfTotpCode').value = '222';
        document.getElementById('sfCurPw').value = 'the-right-password';
        document.querySelector('#sfList .sfRemove[data-id="sf-2"]').click();
        await until(() => calls('DELETE', /\/v1\/second-factor\/sf-2$/)[0]);
        await until(() => document.getElementById('sfTotpBox').hidden);
        ok('removing a factor closes the box of an app being added', document.getElementById('sfTotpSecret').textContent === '' && document.getElementById('sfTotpQr').innerHTML === '' && document.getElementById('sfTotpCode').value === '');
        ok('and says the setup was cancelled: ' + document.getElementById('toast').textContent, document.getElementById('toast').textContent.includes('cancelled the authenticator app'));
      } finally {
        delete window.__override['/v1/second-factor']; delete window.__override['/v1/public-access'];
        window.__answer = {}; window.__confirmAnswer = true;
        if (backupDlg.open) closeBackupCodes();
        if (aiDlg.open) aiDlg.close();
      }
    },
    reachSwitch: async () => {
      const guards = (invited) => [
        { id: 'auth-mode', letter: 'a', title: 'A sign-in per person', ok: true, detail: 'ok' },
        { id: 'second-factor', letter: 'b', title: 'A second factor for everyone with owner rights', ok: true, detail: 'ok' },
        { id: 'invited-only', letter: 'c', title: 'Only invited people', ok: invited, detail: invited ? 'ok' : 'The "Only invited people" switch is off.', fix: invited ? undefined : 'Turn it on.' },
        { id: 'auto-upgrade', letter: 'i', title: 'Automatic upgrades on the stable channel', ok: true, detail: 'ok' },
      ];
      const off = (invited, guests = false) => ({ on: false, serving: false, url: null, invitedOnly: invited, safeguards: guards(invited), failing: invited ? [] : ['invited-only'], confirmText: 'This makes your sign-in page reachable from the internet.',
        guestsWithoutSecondFactor: guests, guestsConfirmText: 'This lets chat-only guests use the public address with their password alone.',
        withoutSecondFactor: [{ name: 'sam', chatOnlyGuest: false }, { name: 'gran', chatOnlyGuest: true }] });
      const on = { on: true, serving: true, url: 'https://box.example.com:8443', invitedOnly: true, safeguards: guards(true), failing: [], turnedOn: true };
      const savedConfig = appConfig;
      window.__override['/v1/public-access'] = off(false);
      window.__override['/v1/second-factor'] = { factors: [], backupCodes: 0, need: 'no', methods: [], localAccount: false, passkeyAddress: null, passkeyHere: false };
      const before = window.__calls.length;
      try {
        await openAiDlg('access');
        await until(() => !document.getElementById('reachBox').hidden && document.querySelectorAll('.reachCheck').length === 4);
        ok('it starts off, and says so', document.getElementById('reachStatus').textContent.startsWith('Off.'));
        const row = document.querySelector('.reachCheck[data-id="invited-only"]');
        ok('the missing safeguard is marked, with why: ' + row.textContent, row.dataset.ok === '0' && row.textContent.includes('✗') && row.textContent.includes('switch is off'));
        eq('the others are ticked', [...document.querySelectorAll('.reachCheck[data-ok="1"]')].length, 3);
        ok('it cannot be turned on while a safeguard is off', document.getElementById('reachOnBtn').disabled);
        ok('no address and no Off button while off', document.getElementById('reachAddress').hidden && document.getElementById('reachOffBtn').hidden);
        // The "Only invited people" switch.
        window.__answer = { 'POST /v1/public-access/invited-only': [{ body: off(true) }] };
        document.getElementById('reachInvited').click();
        const inv = await until(() => calls('POST', /\/v1\/public-access\/invited-only$/)[0]);
        eq('the switch', inv.body, { on: true });
        await until(() => !document.getElementById('reachOnBtn').disabled);
        // Who has no second factor yet is named, with what to do about it.
        const none = document.getElementById('reachNoFactor');
        ok('people without a second factor are named: ' + none.textContent, !none.hidden && none.textContent.includes('sam, gran') && none.textContent.includes('reset link'));
        // The guest switch: off, with a plain warning; turning it on asks first; a "no" changes nothing.
        const guests = document.getElementById('reachGuests');
        ok('guests are not exempt unless the owner says so', !guests.checked);
        ok('the warning is plain: ' + document.getElementById('reachGuestsWarn').textContent, document.getElementById('reachGuestsWarn').textContent.includes('password alone') && document.getElementById('reachGuestsWarn').textContent.includes('anyone on the internet'));
        window.__confirmAnswer = false; window.__confirms.length = 0;
        guests.click(); await sleep(150);
        ok('it asks first: ' + window.__confirms[0], (window.__confirms[0] || '').includes('password alone') && window.__confirms[0].includes('Everyone else'));
        ok('declined: unticked, nothing sent', !guests.checked && calls('POST', /\/v1\/public-access\/guests$/).length === 0);
        window.__confirmAnswer = true;
        window.__answer = { 'POST /v1/public-access/guests': [{ body: off(true, true) }, { body: off(true, false) }] };
        guests.click();
        const g = await until(() => calls('POST', /\/v1\/public-access\/guests$/)[0]);
        eq('the guest switch, confirmed', g.body, { on: true, confirm: true });
        await until(() => none.textContent.includes('Let in with a password alone'));
        ok('it says who is let in, and who is still stopped: ' + none.textContent, /No second factor yet:\s*sam\./.test(none.textContent) && /chat only\):\s*gran\./.test(none.textContent));
        guests.click(); // off again: no question for tightening
        await until(() => calls('POST', /\/v1\/public-access\/guests$/).length === 2);
        eq('off again', calls('POST', /\/v1\/public-access\/guests$/)[1].body.on, false);
        await until(() => !none.textContent.includes('Let in with a password alone'));
        // Turning it on asks first, in plain words; a "no" does nothing.
        window.__confirmAnswer = false; window.__confirms.length = 0;
        document.getElementById('reachOnBtn').click(); await sleep(150);
        ok('the question says what it does: ' + window.__confirms[0], (window.__confirms[0] || '').includes('This makes your sign-in page reachable from the internet.') && window.__confirms[0].includes('Anyone on the internet'));
        eq('declined: nothing asked of the server', calls('POST', /\/v1\/public-access\/on$/).length, 0);
        // The server refuses and says why: shown, with Tailscale's link.
        window.__confirmAnswer = true;
        window.__answer = { 'POST /v1/public-access/on': [
          { status: 409, body: { error: 'Tailscale Funnel is not ready: This machine is not allowed to use Funnel yet.', missing: [{ what: 'This machine is not allowed to use Funnel yet.', fix: 'Add the funnel node attribute.' }], link: 'https://login.tailscale.com/f/funnel?node=abc' } },
          { body: on } ] };
        document.getElementById('reachOnBtn').click();
        await until(() => document.getElementById('reachErr').textContent.includes('not allowed to use Funnel'));
        ok('Tailscale\'s link is offered', !!document.querySelector('#reachErr a[href="https://login.tailscale.com/f/funnel?node=abc"]'));
        ok('still off', document.getElementById('reachStatus').textContent.startsWith('Off.'));
        // And then it works.
        window.__override['/v1/public-access'] = on;
        document.getElementById('reachOnBtn').click();
        await until(() => document.getElementById('reachStatus').textContent.startsWith('On.'));
        eq('the request confirms', calls('POST', /\/v1\/public-access\/on$/).pop().body, { confirm: true });
        ok('the address is shown: ' + document.getElementById('reachAddress').textContent, !document.getElementById('reachAddress').hidden && document.getElementById('reachAddress').textContent.includes('https://box.example.com:8443'));
        ok('with its QR code', !!document.querySelector('#reachAddress img[src^="/v1/public-access/qr.svg"]'));
        const copy = document.querySelector('#reachAddress button');
        ok('Copy reads the address from a data attribute, not from a script string', copy.dataset.copy === 'https://box.example.com:8443' && !copy.getAttribute('onclick').includes('box.example.com'));
        ok('On is replaced by Off', document.getElementById('reachOnBtn').hidden && !document.getElementById('reachOffBtn').hidden);
        ok('the invited-only switch is locked while on', document.getElementById('reachInvited').disabled);
        // The record, with a sign-out for whoever signed in.
        window.__override['/v1/security/log'] = { entries: [
          { id: 2, at: new Date().toISOString(), kind: 'public.signin', ownerId: 'acct-9', who: 'sam', detail: { from: '203.0.113.7', device: 'Chrome on Android', newDevice: true } },
          { id: 1, at: new Date().toISOString(), kind: 'public.on', who: 'chris', detail: { url: 'https://box.example.com:8443' } } ] };
        document.getElementById('reachLogBtn').click();
        const out = await until(() => byText('#reachLog button', 'Sign out everywhere'));
        ok('the record reads in plain words: ' + document.getElementById('reachLog').textContent, document.getElementById('reachLog').textContent.includes('Signed in') && document.getElementById('reachLog').textContent.includes('Chrome on Android') && document.getElementById('reachLog').textContent.includes('Public access turned on'));
        out.click();
        await until(() => calls('POST', /\/v1\/security\/sign-out\/acct-9$/)[0]);
        // Off asks too, then undoes it.
        window.__override['/v1/public-access'] = off(true);
        window.__confirms.length = 0;
        document.getElementById('reachOffBtn').click();
        await until(() => calls('POST', /\/v1\/public-access\/off$/)[0]);
        ok('off asked first', (window.__confirms[0] || '').includes('Turn off public access?'));
        await until(() => document.getElementById('reachStatus').textContent.startsWith('Off.') && document.getElementById('reachAddress').hidden);
        // At the public address itself the switch is not offered at all.
        appConfig = { ...appConfig, publicAddress: true };
        await loadReach();
        ok('hidden at the public address', document.getElementById('reachBox').hidden);
        void before;
      } finally {
        appConfig = savedConfig;
        for (const k of ['/v1/public-access', '/v1/second-factor', '/v1/security/log']) delete window.__override[k];
        window.__answer = {}; window.__confirmAnswer = true;
        if (aiDlg.open) aiDlg.close();
      }
    },
    secondFactorMissing: async () => {
      // At the public address with a password and no second factor, and no link behind the sign-in: told plainly, once.
      const block = document.getElementById('sfBlock');
      const text = 'This Hatchabot asks for a second factor at the public address, and your account has none yet. Ask whoever runs this Hatchabot for a reset link and add one right after using it, or add one at the private address (Settings → You → Second factor).';
      try {
        window.__answer = {
          'POST /v1/second-factor/totp': [{ status: 403, body: { error: 'Your password alone cannot add your first second factor at this address.', secondFactor: 'enrol-link' } }],
          'GET /v1/hosts': [{ status: 403, body: { error: text, secondFactor: 'enrol-link' } }, { status: 403, body: { error: 'again', secondFactor: 'enrol-link' } }],
        };
        ok('nothing shown before', block.hidden);
        await api('/v1/second-factor/totp', { method: 'POST', body: {} }).catch(() => {});
        ok('the enrolment form\'s own refusal stays in the form', block.hidden);
        const failed = await api('/v1/hosts').then(() => '', (e) => e.message);
        eq('the call fails with the reason', failed, text);
        ok('and the page says what to do: ' + block.textContent, !block.hidden && block.textContent.includes('reset link') && block.textContent.includes('private address'));
        ok('with a way out', !!byText('#sfBlock button', 'Sign out'));
        await api('/v1/hosts').catch(() => {});
        ok('said once, not replaced by every later refusal', block.textContent.includes('reset link') && !block.textContent.includes('again'));
      } finally {
        window.__answer = {};
        block.hidden = true; block.innerHTML = '';
      }
    },
    passwordChangeNeedsFactor: async () => {
      // HB-0453: at the public address with no second factor, Settings → You explains instead of offering a form the gate refuses.
      const was = { authMode: appConfig.authMode };
      const words = 'Your account has no second factor, so its password cannot be changed at this address: whoever had only your password could otherwise lock you out. Change it at the private address (at home), or ask whoever runs this Hatchabot for a reset link.';
      const base = { factors: [], backupCodes: 0, need: 'missing', ownerRights: false, methods: [], localAccount: true, passkeyAddress: 'https://box.example.com', passkeyHere: false };
      window.__override['/v1/local-accounts/me'] = { id: 'la-2', username: 'sam', hostOwner: false };
      window.__override['/v1/public-access'] = { on: true, serving: true, safeguards: [], failing: [], invitedOnly: false };
      try {
        appConfig.authMode = 'accounts';
        window.__override['/v1/second-factor'] = { ...base, publicAddress: true, passwordRefused: words };
        await openAiDlg('access');
        await until(() => !document.getElementById('acctSelf').hidden && !document.getElementById('acctPwRefused').hidden);
        ok('the form is not offered', document.getElementById('acctPwForm').hidden);
        eq('the page says what to do instead', document.getElementById('acctPwRefused').textContent, words);
        ok('the recovery-code form is still there', !!byText('#acctSelf button', 'Make a new code'));
        aiDlg.close();
        // At home (no refusal in the answer): the form, and no explanation.
        window.__override['/v1/second-factor'] = { ...base, publicAddress: false };
        await openAiDlg('access');
        await until(() => !document.getElementById('sfBox').hidden && !document.getElementById('acctPwForm').hidden);
        ok('at home the form is back', document.getElementById('acctPwRefused').hidden && !!byText('#acctPwForm button', 'Change'));
      } finally {
        appConfig.authMode = was.authMode;
        for (const k of ['/v1/second-factor', '/v1/public-access', '/v1/local-accounts/me']) delete window.__override[k];
        document.getElementById('acctPwForm').hidden = false; document.getElementById('acctPwRefused').hidden = true;
        if (aiDlg.open) aiDlg.close();
      }
    },
    secondFactorPrompt: async () => {
      window.__override['/v1/second-factor'] = { factors: [{ id: 'sf-1', kind: 'totp' }], backupCodes: 3, need: 'yes', methods: ['totp', 'backup'], passkeyHere: false };
      try {
        // A sensitive call at the public address is answered "second factor again": the page asks, then repeats the call.
        window.__answer = {
          'POST /v1/cli-tokens': [{ status: 401, body: { error: 'second factor required', secondFactor: 'step-up' } }, { status: 201, body: { id: 't1', token: 'made-up-token' } }],
          'POST /v1/second-factor/verify': [{ status: 401, body: { error: 'That code is not right.' } }, { body: { ok: true, method: 'totp' } }],
        };
        const before = calls('POST', /\/v1\/cli-tokens$/).length;
        const pending = api('/v1/cli-tokens', { method: 'POST', body: { label: 'x' } });
        await until(() => sfDlg.open);
        ok('it says why it is asking', document.getElementById('sfDlgTitle').textContent === 'Confirm it is you' && document.getElementById('sfDlgLede').textContent.includes('sensitive'));
        ok('no sign-in screen behind it', !loginDlg.open);
        await until(() => document.getElementById('sfCodeLabel').textContent.includes('authenticator app'));
        ok('no passkey button when there is no passkey here', document.getElementById('sfPasskeyRow').hidden);
        document.getElementById('sfCode').value = '111111';
        document.getElementById('sfCodeBtn').click();
        await until(() => document.getElementById('sfErr').textContent.includes('not right'));
        ok('a wrong code keeps the prompt', sfDlg.open);
        document.getElementById('sfCode').value = '654321';
        document.getElementById('sfCodeBtn').click();
        const out = await pending;
        eq('the original call went through after it', out, { id: 't1', token: 'made-up-token' });
        eq('it was made exactly twice', calls('POST', /\/v1\/cli-tokens$/).length - before, 2);
        eq('the code was sent', calls('POST', /\/second-factor\/verify$/).pop().body, { code: '654321' });
        ok('the prompt closed', !sfDlg.open);
        // Cancel: the call fails with a plain reason, and nothing loops.
        window.__answer = { 'POST /v1/cli-tokens': [{ status: 401, body: { error: 'second factor required', secondFactor: 'step-up' } }] };
        const second = api('/v1/cli-tokens', { method: 'POST', body: { label: 'y' } }).then(() => 'went through', (e) => e.message);
        await until(() => sfDlg.open);
        byText('#sfDlg button', 'Cancel').click();
        eq('cancelled', await second, 'The second factor was not given.');
        ok('closed, and no sign-in screen for a step-up', !sfDlg.open && !loginDlg.open);
        // An owner with no second factor is told where to add one (a 403, not a prompt).
        window.__answer = { 'POST /v1/cli-tokens': [{ status: 403, body: { error: 'Your account has owner rights and no second factor. Add one at the private address.', secondFactor: 'missing' } }] };
        const third = await api('/v1/cli-tokens', { method: 'POST', body: {} }).then(() => 'went through', (e) => e.message);
        ok('told, not prompted: ' + third, third.includes('no second factor') && !sfDlg.open);
      } finally {
        delete window.__override['/v1/second-factor'];
        window.__answer = {};
        if (sfDlg.open) sfDlg.close();
      }
    },
    rawFetchSecondFactor: async () => {
      // Files up and down go by fetch(), not api(): they ask for the second factor too, then go again (review, 2026-10-09).
      window.__override['/v1/second-factor'] = { factors: [{ id: 'sf-1', kind: 'totp' }], backupCodes: 3, need: 'yes', methods: ['totp', 'backup'], passkeyHere: false };
      const STEP = { status: 401, body: { error: 'second factor required', secondFactor: 'step-up' } };
      const pub = appConfig.publicAddress;
      try {
        // An upload: asked, given, sent again.
        window.__answer = { 'PUT /v1/agents/a1/fs/file': [STEP, { status: 200, body: { ok: true } }] };
        const before = calls('PUT', /\/fs\/file$/).length;
        const up = v2UploadFiles('a1', '', [new File(['made-up'], 'notes.txt')]);
        await until(() => sfDlg.open);
        sfDone();
        await up;
        eq('the upload was sent again after the prompt', calls('PUT', /\/fs\/file$/).length - before, 2);
        // The agent's download: asked; Cancel stops it with a plain reason.
        window.__confirmAnswer = true;
        window.__answer = { 'GET /v1/agents/a1/backup': [STEP] };
        const dl = downloadAgent('a1', 'Test Agent');
        await until(() => sfDlg.open);
        byText('#sfDlg button', 'Cancel').click();
        await dl;
        ok('cancelled, said: ' + document.getElementById('toast').textContent, document.getElementById('toast').textContent.includes('The second factor was not given'));
        // Share (saveFromServer) and an import ask too.
        window.__answer = { 'GET /v1/agents/a1/export': [STEP] };
        const share = saveFromServer('/v1/agents/a1/export', 'agent-template.json');
        await until(() => sfDlg.open);
        byText('#sfDlg button', 'Cancel').click();
        await share;
        window.__answer = { 'POST /v1/agents/import': [STEP] };
        const imp = importAgentFile(new File(['not gzip'], 'x.hatchabot'));
        await until(() => sfDlg.open);
        byText('#sfDlg button', 'Cancel').click();
        await imp;
        // A folder's .tar.gz link at the public address is fetched (so it can ask); elsewhere it is a plain link.
        const a = Object.assign(document.createElement('a'), { href: '/v1/agents/a1/fs/archive?path=' });
        let prevented = false; const ev = { preventDefault: () => { prevented = true; } };
        appConfig.publicAddress = false;
        ok('a plain link at the private address', sfLink(ev, a, 'f.tar.gz') === true && !prevented);
        appConfig.publicAddress = true;
        window.__answer = { 'GET /v1/agents/a1/fs/archive': [STEP] };
        ok('fetched at the public address', sfLink(ev, a, 'f.tar.gz') === false && prevented);
        await until(() => sfDlg.open);
        byText('#sfDlg button', 'Cancel').click();
        ok('the archive link was asked for once', calls('GET', /\/fs\/archive$/).length >= 1);
      } finally {
        appConfig.publicAddress = pub;
        delete window.__override['/v1/second-factor'];
        window.__answer = {};
        if (sfDlg.open) sfDlg.close();
      }
    },
    importPeekBounded: async () => {
      // R24 (v2.166.0): the import's template peek decompressed EVERY .hatchabot file in full, a
      // full copy's inlined volume (up to 256 MB) included — a frozen desktop, a dead phone tab —
      // before the upload began. It reads only enough to tell a template from a copy now.
      const gzipFile = async (json, name) => new File([await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob()], name);
      // Counts the bytes that come OUT of the page's DecompressionStream.
      const Real = window.DecompressionStream;
      let out = 0;
      window.DecompressionStream = class { constructor(f) { const real = new Real(f); const count = new TransformStream({ transform(chunk, c) { out += chunk.byteLength; c.enqueue(chunk); } }); this.writable = real.writable; this.readable = real.readable.pipeThrough(count); } };
      try {
        // A full copy: a manifest with a large "volume" inlined — 12 MB of made-up text that, like a
        // real one (base64 of a gzipped tar), gzip cannot shrink (a random 64 KB block, past its window).
        let block = ''; while (block.length < 65536) block += Math.random().toString(36).slice(2);
        const big = await gzipFile('{"format":"hatchabot-export","version":1,"agent":{"name":"Test Agent"},"state":"' + block.repeat(192) + '"}', 'test-agent.hatchabot');
        ok('the made-up copy is several MB, compressed too: ' + big.size, big.size > 6 * 1048576);
        window.__answer = { 'POST /v1/agents/import': [{ status: 200, body: { kind: 'copy', name: 'Test Agent' } }] };
        const before = calls('POST', /\/v1\/agents\/import$/).length;
        await importAgentFile(big);
        const sent = calls('POST', /\/v1\/agents\/import$/).slice(before);
        eq('the copy was uploaded, once', sent.length, 1);
        ok('uploaded as the file itself, no setup values: ' + sent[0].url, sent[0].body instanceof File && !/values=/.test(sent[0].url));
        // A full copy comes back with its own bot, so it never asks for none (the server refuses that).
        ok('a copy keeps its bot: ' + sent[0].url, !/telegram=/.test(sent[0].url));
        ok('only the start of it was decompressed in the tab: ' + out + ' bytes', out > 0 && out < 4 * 1048576);
        // A template with setup fields still opens the form, and its answers ride the request.
        out = 0;
        const tpl = await gzipFile(JSON.stringify({ format: 'hatchabot-template', version: 1, agent: { name: 'Homework Helper' }, files: {}, parameters: [{ key: 'subject', label: 'Subject', type: 'text', required: true }] }), 'homework-helper.template.hatchabot');
        window.__answer = { 'POST /v1/agents/import': [{ status: 200, body: { kind: 'template', name: 'Homework Helper' } }] };
        await until(() => !paramFormDlg.open && paramFormResolve === null); await sleep(0);
        const imp = importAgentFile(tpl);
        await formOpened();
        document.getElementById('pfv-0').value = 'Algebra';
        submitParamForm();
        await imp;
        const t = calls('POST', /\/v1\/agents\/import$/).slice(before + 1);
        eq('the template was uploaded, once', t.length, 1);
        eq('with the answer in the body, ahead of the file', (await t[0].body.text()).split('\n')[0], JSON.stringify({ values: { subject: 'Algebra' } }));
        ok('the small template was read whole: ' + out, out > 100);
        eq('a template stands up an agent without a bot (Telegram off by default)', new URL(t[0].url, location.href).search, '?telegram=0');
        ok('said what was imported: ' + document.getElementById('toast').textContent, document.getElementById('toast').textContent.includes('Imported “Homework Helper”'));
        // A file that is not gzip at all is uploaded as it is, as before.
        window.__answer = { 'POST /v1/agents/import': [{ status: 400, body: { error: 'That is not a .hatchabot file.' } }] };
        await importAgentFile(new File(['not gzip'], 'x.hatchabot'));
        eq('the plain file was uploaded', calls('POST', /\/v1\/agents\/import$/).length - before, 3);
      } finally {
        window.DecompressionStream = Real;
        window.__answer = {};
        if (paramFormDlg.open) paramFormDlg.close();
      }
    },
    importAnswersInBody: async () => {
      // HB-0093 (v2.170.0): the setup answers rode the request's address; about five full-length
      // (2,000-character) answers passed Node's 16 KB limit (a bare 431), and from v2.166.0 the page
      // refused them up front. They go in the body now, ahead of the file, so all of them are sent.
      const gzipFile = async (json, name) => new File([await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob()], name);
      const parameters = ['one', 'two', 'three', 'four', 'five'].map((k) => ({ key: k, label: 'Answer ' + k, type: 'text' }));
      const tpl = await gzipFile(JSON.stringify({ format: 'hatchabot-template', version: 1, agent: { name: 'Long Answers' }, files: {}, parameters }), 'long-answers.template.hatchabot');
      const before = calls('POST', /\/v1\/agents\/import$/).length;
      try {
        // The form settled from the scenario before (its close event is a queued task); a stale toast cleared.
        await until(() => !paramFormDlg.open && paramFormResolve === null); await sleep(0);
        document.getElementById('toast').textContent = '';
        window.__answer = { 'POST /v1/agents/import': [{ status: 201, body: { kind: 'template', name: 'Long Answers' } }] };
        const imp = importAgentFile(tpl);
        await formOpened();
        // Written answers: a space or a comma took three characters in the address.
        const prose = (n) => 'A made-up answer, written out in full sentences, as a person would. '.repeat(40).slice(0, n);
        for (let i = 0; i < 5; i++) document.getElementById('pfv-' + i).value = prose(2000);
        submitParamForm();
        await imp;
        const sent = calls('POST', /\/v1\/agents\/import$/).slice(before);
        eq('one request went', sent.length, 1);
        // No answers in the address: only the template's no-bot flag (Telegram off by default, 2026-11-07).
        eq('only the no-bot flag in the address', new URL(sent[0].url, location.href).search, '?telegram=0');
        eq('sent as an import with answers', sent[0].headers['content-type'], 'application/vnd.hatchabot.import');
        const bytes = new Uint8Array(await sent[0].body.arrayBuffer());
        const nl = bytes.indexOf(10);
        const head = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)));
        eq('all five full answers in the body', Object.values(head.values).map((v) => v.length).join(','), '2000,2000,2000,2000,2000');
        eq('the file after them, whole', bytes.length - nl - 1, tpl.size);
        ok('no refusal, the import said: ' + document.getElementById('toast').textContent, document.getElementById('toast').textContent.includes('Imported “Long Answers”'));
      } finally {
        window.__answer = {};
        if (paramFormDlg.open) paramFormDlg.close();
      }
    },
    newDeviceNotice: async () => {
      const text = 'New sign-in to Hatchabot as sam: Chrome on Android, from about 203.0.113.x, 2026-10-01 12:00 UTC, through the public address. If they do not recognise it: Settings → Reach it from anywhere → sign sam out everywhere.';
      window.__override['/v1/security/notices'] = { notices: [{ id: 'sn-1', at: new Date().toISOString(), kind: 'new-device', aboutOwner: 'acct-9', text }], canSignOutOthers: true };
      try {
        await loadSecurityNotices();
        const el = document.getElementById('secNotice');
        ok('the notice is on the home screen: ' + el.textContent, !el.hidden && el.textContent.includes('New sign-in to Hatchabot as sam') && el.textContent.includes('Chrome on Android'));
        const out = byText('#secNotice button', 'Sign them out everywhere');
        ok('the owner can sign them out from it', !!out);
        out.click();
        await until(() => calls('POST', /\/v1\/security\/sign-out\/acct-9$/).length >= 1);
        window.__override['/v1/security/notices'] = { notices: [], canSignOutOthers: true };
        byText('#secNotice button', 'It was expected').click();
        await until(() => calls('POST', /\/v1\/security\/notices\/sn-1\/seen$/)[0]);
        await until(() => el.hidden);
        // About yourself: the action is your own "sign out on every device".
        window.__override['/v1/security/notices'] = { notices: [{ id: 'sn-2', at: new Date().toISOString(), kind: 'new-device', aboutOwner: 'me', text: 'New sign-in to Hatchabot as chris: Safari on iOS. If this was not you: change your password and choose "Sign out on every device".' }], canSignOutOthers: false };
        await loadSecurityNotices();
        ok('your own notice offers your own sign-out', !!byText('#secNotice button', 'Sign out on every device') && !byText('#secNotice button', 'Sign them out'));
      } finally {
        delete window.__override['/v1/security/notices'];
        document.getElementById('secNotice').hidden = true;
      }
    },
    swapAllowance: async () => {
      // Compressed swap beside the memory cap (agent sheet → Advanced → Runtime), and in Hosts → Defaults.
      const list = await (await fetch('/v1/agents')).json();
      const set = (over) => { window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, memoryCapEffective: '3g', swapAllowanceDefault: 'off', ...over } : a); };
      const status = () => document.getElementById('swapStatus').textContent;
      try {
        set({ swapAllowanceEffective: 'off', swapInEffect: 'off' });
        await refresh(false);
        openV2Agent('a1', 'advanced');
        const sel = await until(() => document.getElementById('editSwapAllowance'));
        const vals = [...sel.options].map((o) => o.value);
        ok('it offers inherit, off and sizes up to the 3 GB cap only: ' + vals, vals[0] === '' && vals.includes('off') && vals.includes('2g') && vals.includes('3g') && !vals.includes('4g'));
        ok('the inherited choice names the machine setting: ' + sel.options[0].textContent, sel.options[0].textContent.includes("the machine's: off"));
        ok('says it has no swap: ' + status(), status().includes('No swap'));
        sel.value = '2g';
        document.getElementById('swapSaveBtn').click();
        const p = await until(() => calls('PATCH', /\/v1\/agents\/a1$/).find((c) => c.body && 'swapAllowance' in c.body));
        eq('the swap allowance', p.body, { swapAllowance: '2g' });
        v2Close();
        // In effect, with some of it in swap now.
        set({ swapAllowance: '2g', swapAllowanceEffective: '2g', swapInEffect: '2g', swapBytes: 600 * 1048576 });
        await refresh(false);
        openV2Agent('a1', 'advanced');
        await until(() => document.getElementById('editSwapAllowance').value === '2g');
        ok('in effect, and how much is in swap: ' + status(), status().includes('Up to 2 GB of compressed swap') && status().includes('600 MB in swap now'));
        v2Close();
        // Allowed, but this machine has no compressed swap: withheld, with the fix.
        set({ swapAllowance: '2g', swapAllowanceEffective: '2g', swapInEffect: 'off', swapWithheld: 'This machine swaps to disk only.', swapFix: 'sudo scripts/enable-compressed-swap.sh' });
        await refresh(false);
        openV2Agent('a1', 'advanced');
        await until(() => status().includes('⚠'));
        ok('withheld, says why and the fix: ' + status(), status().includes('not given') && status().includes('disk only') && status().includes('enable-compressed-swap.sh'));
        document.getElementById('editSwapAllowance').value = 'off';
        document.getElementById('swapSaveBtn').click();
        await until(() => calls('PATCH', /\/v1\/agents\/a1$/).find((c) => c.body && c.body.swapAllowance === 'off'));
        v2Close();
        // The machine's setting, with the note on whether this machine compresses swap.
        window.__override['/v1/machine-defaults'] = { defaults: [
          { key: 'agentSwap', label: 'Compressed swap per agent', help: 'h', applies: 'now', fallback: 'off', value: 'off', set: false, note: 'This machine compresses swap: zswap (zstd, zsmalloc, pool ≤ 20%) in front of /swap.img · nothing stored yet.' } ] };
        window.__answer = { 'PUT /v1/machine-defaults': [{ status: 200, body: { default: { key: 'agentSwap', value: '2g' }, applied: 3 } }] };
        await openAiDlg('hosts');
        const input = await until(() => document.getElementById('md-agentSwap'));
        ok('the note shows: ' + (document.getElementById('md-note-agentSwap')?.textContent || ''), (document.getElementById('md-note-agentSwap')?.textContent || '').includes('zswap (zstd'));
        input.value = '2g';
        input.parentElement.querySelector('button').click();
        const put = await until(() => calls('PUT', /\/v1\/machine-defaults$/).find((c) => c.body && c.body.key === 'agentSwap'));
        eq('the machine setting', put.body, { key: 'agentSwap', value: '2g' });
        await until(() => document.getElementById('toast').textContent.includes('applied to 3 agents'));
        // An agent whose volume is gone took neither: said by name, not left out (HB-0373).
        window.__answer = { 'PUT /v1/machine-defaults': [{ status: 200, body: { default: { key: 'agentSwap', value: '3g' }, applied: 1, volumeGone: ['Kitchen'] } }] };
        input.value = '3g';
        input.parentElement.querySelector('button').click();
        await until(() => document.getElementById('toast').textContent.includes('Not on Kitchen'));
        ok('a gone volume is named: ' + document.getElementById('toast').textContent, document.getElementById('toast').textContent.includes('the volume is gone'));
        aiDlg.close();
        window.__answer = { 'PATCH /v1/agents/a1': [{ status: 200, body: { id: 'a1', filesCapPending: 'The limit is saved, but it could not be written to the agent. Its volume is gone.' } }] };
        await v2SetAgentPolicy('a1', { filesMaxMb: 5 });
        ok('the file limit says so too', document.getElementById('toast').textContent.includes('could not be written'));
      } finally {
        try { v2Close(); } catch {}
        window.__answer = {};
        delete window.__override['/v1/agents']; delete window.__override['/v1/machine-defaults'];
        await refresh(false);
      }
    },
    // A new default model for future agents only (Chris, 2026-10-03): no agent ticked is a real choice.
    defaultModelNewOnly: async () => {
      const onProfile = [
        { id: 'a1', name: 'Homework Helper', aiProfileId: 'p1', model: null, modelOverride: null, state: 'RUNNING' },
        { id: 'a2', name: 'Tax Helper', aiProfileId: 'p1', model: 'claude-opus-5', modelOverride: 'claude-opus-5', state: 'RUNNING' },
      ];
      try {
        openApplyModel('p1', 'claude-haiku-4-5', [], onProfile, 'Claude token');
        await until(() => applyModelDlg.open);
        ok('the dialog says new agents start on it: ' + applyModelDlg.textContent, applyModelDlg.textContent.includes('New agents on') && applyModelDlg.textContent.includes('leave every box empty'));
        toggleApplyAll(false);
        const btn = document.getElementById('applyModelBtn');
        ok('with none ticked the button still works', !btn.disabled);
        eq('and says what it does', btn.textContent, 'Save for new agents only');
        btn.click();
        const c = await until(() => calls('POST', /\/v1\/ai-profiles\/p1\/apply-default-model$/).pop());
        eq('no agent is switched', c.body.apply, []);
        eq('the new default', c.body.model, 'claude-haiku-4-5');
        await until(() => document.getElementById('toast').textContent.includes('for new agents'));
        ok('the toast says existing agents keep theirs', document.getElementById('toast').textContent.includes('Existing agents keep their models'));
        // One ticked: the button names it.
        openApplyModel('p1', 'claude-haiku-4-5', [], onProfile, 'Claude token');
        await until(() => applyModelDlg.open);
        eq('one ticked by default (the follower, not the pinned one)', document.getElementById('applyModelBtn').textContent, 'Save, and switch 1');
        // Its volume is gone: not "next rebuild", which would make a fresh, empty one (HB-0373).
        window.__answer = { 'POST /v1/ai-profiles/p1/apply-default-model': [{ body: { applied: 1, held: 1, live: 0, staged: 0, volumeGone: 1 } }] };
        document.getElementById('applyModelBtn').click();
        await until(() => document.getElementById('toast').textContent.includes('its volume is gone'));
        ok('a gone volume is not told to rebuild', !document.getElementById('toast').textContent.includes('next rebuild'));
        openApplyModel('p1', 'claude-haiku-4-5', [], onProfile, 'Claude token');
        await until(() => applyModelDlg.open);
        // The server held it back: its runtime is too old for the model on a plan (HB-0232).
        window.__answer = { 'POST /v1/ai-profiles/p1/apply-default-model': [{ body: { applied: 0, held: 2, live: 0, staged: 0, notSwitched: [{ id: 'a1', name: 'Homework Helper', reason: 'too old' }] } }] };
        document.getElementById('applyModelBtn').click();
        await until(() => document.getElementById('toast').textContent.includes('not switched'));
        ok('the toast names the agent that was not switched and why: ' + document.getElementById('toast').textContent,
          document.getElementById('toast').textContent.includes('not switched: Homework Helper (its runtime is too old for claude-haiku-4-5'));
        // Other accounts' followers held the same way are counted, not named (HB-0245).
        document.getElementById('toast').textContent = '';
        openApplyModel('p1', 'claude-haiku-4-5', [], onProfile, 'Claude token');
        await until(() => applyModelDlg.open);
        toggleApplyAll(false);
        window.__answer = { 'POST /v1/ai-profiles/p1/apply-default-model': [{ body: { applied: 0, held: 2, live: 0, staged: 0, othersHeld: 2 } }] };
        document.getElementById('applyModelBtn').click();
        await until(() => document.getElementById('toast').textContent.includes('other accounts'));
        ok('the toast counts the other accounts\' agents kept on their model: ' + document.getElementById('toast').textContent,
          document.getElementById('toast').textContent.includes('Existing agents keep their models. 2 agents of other accounts that follow this source were kept on their model: their runtimes are too old for claude-haiku-4-5 on a Claude plan.'));
      } finally { if (applyModelDlg.open) applyModelDlg.close(); }
    },
  });
  // ---- View by → Activity: the Unread section and each agent's last line (2026-10-03) ----
  const recentFixture = async () => {
    const mins = (m) => new Date(Date.now() - m * 60000).toISOString();
    const list = await (await fetch('/v1/agents')).json();
    const patch = {
      a1: { unread: true, lastActiveAt: mins(2) },      // Homework Helper
      a4: { unread: true, lastActiveAt: mins(30) },     // Meal Planner
      a8: { lastActiveAt: mins(5) },                    // Budget Tracker
      a9: { lastActiveAt: mins(180) },                  // Stock Watcher
      a13: { lastActiveAt: mins(60 * 26), pendingAction: { type: 'bot_token' } }, // Car Upkeep
    };
    window.__override['/v1/agents'] = list.map((a) => patch[a.id] ? { ...a, ...patch[a.id] } : a);
    window.__override['/v1/recent'] = { cap: 8, total: 4, items: [
      { id: 'a1', name: 'Homework Helper', at: mins(2), unread: true, said: 'You: thanks, that explains the fractions homework nicely' },
      { id: 'a4', name: 'Meal Planner', at: mins(30), unread: true, said: 'Robin: can we do tacos on Friday?' },
      { id: 'a8', name: 'Budget Tracker', at: mins(5), unread: false, said: '⏰ Daily brief ran' },
      { id: 'a9', name: 'Stock Watcher', at: mins(180), unread: false, said: '' },
      { id: 'a13', name: 'Car Upkeep', at: mins(60 * 26), unread: false, said: 'Oil change is due' },
    ] };
    await refresh(false);
    await v2LoadRecent(true); // the poll reads it at most every 30 s
  };
  const recentCleanup = async () => {
    delete window.__override['/v1/agents']; delete window.__override['/v1/recent']; window.__answer = {};
    v2SetView('group');
    await refresh(false);
  };
  // The last line lives in the tile's hover tooltip (2026-10-03), not under the tile.
  const tipOf = (name) => { const t = tile(name); if (!t) return null; v2ShowTip(t); const p = document.querySelector('#v2Tip .v2tipprev'); const txt = p ? p.textContent : null; document.getElementById('v2Tip').hidden = true; return txt; };
  const prevOf = (name) => { const t = tipOf(name); return t === null ? null : t.replace(/^[^·]*·\s*/, ''); };
  Object.assign(T, {
    activityUnreadFirst: async () => {
      try {
        await recentFixture();
        v2SetView('activity');
        await until(() => v2Recent && v2Recent.size === 5);
        ok('asked for the whole week', calls('GET', /^\/v1\/recent$/).some((c) => c.url.includes('all=1')));
        const heads = [...document.querySelectorAll('#v2groups .v2ghead h3')].map((h) => h.textContent);
        eq('Unread is the first section', heads[0], 'Unread');
        const unread = document.querySelector('#v2groups .v2group');
        eq('newest reply first', [...unread.querySelectorAll('.v2agent .v2name')].map((n) => n.textContent), ['Homework Helper', 'Meal Planner']);
        for (const name of ['Homework Helper', 'Meal Planner']) eq(name + ' shown once', [...document.querySelectorAll('#v2groups .v2agent')].filter((t) => t.textContent.includes(name)).length, 1);
        ok('the time bins follow', heads.slice(1).some((h) => /Active in the last hour/.test(h)));
      } finally { await recentCleanup(); }
    },
    activityPreviews: async () => {
      try {
        await recentFixture();
        v2SetView('activity');
        await until(() => v2Recent && prevOf('Homework Helper'));
        eq('the viewer\'s own line', prevOf('Homework Helper'), 'You: thanks, that explains the fractions homework nicely');
        eq('a member\'s line', prevOf('Meal Planner'), 'Robin: can we do tacos on Friday?');
        eq('a task that ran', prevOf('Budget Tracker'), '⏰ Daily brief ran');
        eq('no line, no row', prevOf('Stock Watcher'), null);
        eq('Alerts is not repeated as the last line', prevOf('Car Upkeep'), null);
        ok('it is in the tooltip once, in the list', (() => { const t = tile('Car Upkeep'); v2ShowTip(t); const x = document.getElementById('v2Tip').textContent; document.getElementById('v2Tip').hidden = true; return x.split('waiting for a Telegram bot token').length - 1 === 1; })());
        ok('nothing under the tiles any more', !document.querySelector('#v2groups .v2prev'));
        ok('the tooltip says how long ago: ' + tipOf('Homework Helper'), / ago · You: thanks|just now · You: thanks/.test(tipOf('Homework Helper')));
        ok('the tile reads the line out', tile('Homework Helper').getAttribute('aria-label').includes('You: thanks'));
        tile('Homework Helper').click();
        await until(() => v2AgentDlg.open || document.getElementById('consoleDlg').open);
        ok('a click opens it as it always did', true);
      } finally {
        if (document.getElementById('consoleDlg').open) closeConsole();
        try { v2Close(); } catch {}
        await recentCleanup();
      }
    },
    previewsInEveryView: async () => {
      try {
        await recentFixture();
        for (const v of ['group', 'attention', 'model', 'activity']) {
          v2SetView(v); await sleep(50);
          eq(v + ': the last line is in the tooltip', prevOf('Meal Planner'), 'Robin: can we do tacos on Friday?');
          { const t = tile('Meal Planner'); v2ShowTip(t); const tip = document.getElementById('v2Tip').textContent; document.getElementById('v2Tip').hidden = true;
            ok(v + ': no "No Telegram" line in a tooltip', !tip.includes('No Telegram')); }
          ok(v + ': nothing under the tiles', !document.querySelector('#v2groups .v2prev'));
          ok(v + ': no Hide previews button', !byText('#v2groups button', 'Hide previews'));
          eq(v + ': Unread is a section only in Activity', [...document.querySelectorAll('#v2groups .v2ghead h3')].some((h) => h.textContent === 'Unread'), v === 'activity');
        }
        // Read with the list poll, but at most every 30 s.
        const before = calls('GET', /^\/v1\/recent$/).length;
        v2SetView('group'); await refresh(false); await refresh(false);
        eq('not re-read on every poll', calls('GET', /^\/v1\/recent$/).length, before);
      } finally { await recentCleanup(); }
    },
    activityRecentFails: async () => {
      try {
        await recentFixture();
        delete window.__override['/v1/recent'];
        window.__answer = { 'GET /v1/recent': Array.from({ length: 6 }, () => ({ status: 500, body: { error: 'Something failed.' } })) };
        v2Recent = new Map();
        v2SetView('activity');
        await v2LoadRecent(true);
        await until(() => v2Recent === null);
        ok('no preview in the tooltip', tipOf('Homework Helper') === null);
        eq('every tile still there', document.querySelectorAll('#v2groups .v2agent').length, 14);
        ok('Unread still first (it comes from the list)', document.querySelector('#v2groups .v2ghead h3').textContent === 'Unread');
      } finally { await recentCleanup(); }
    },
  });
  // ---- Cost badges ("$12/wk") and View by → Cost (made-up figures) ----
  const COSTS = (() => {
    const c = (weekly, extra = {}) => ({ cost: weekly, weekly, monthly: Math.round(weekly * 30 / 7 * 100) / 100, tier: weekly >= 100 ? 4 : weekly >= 50 ? 3 : weekly >= 10 ? 2 : 1, priced: true, ...extra });
    return { days: 7, at: new Date().toISOString(), bands: [10, 50, 100], agents: {
      a1: c(1240),                   // Homework Helper: $1.2k/wk, gold
      a2: c(240),                    // Soccer Schedule
      a3: c(64),                     // Piano Practice
      a4: c(18, { plan: true }),     // Meal Planner, on the household's Claude plan
      a5: c(4),                      // Grocery Runner
      a6: c(0.4),                    // Home Maintenance: under $1, no badge
      a7: { ...c(0), tier: 1, priced: false }, // Travel Planner: no price known
      a8: c(120),                    // Budget Tracker
      a9: { ...c(0), tier: 1, local: true },   // Stock Watcher: a local model
      a10: { ...c(0), tier: 0 },     // Tax Filing: nothing this week
      a11: c(12),                    // To Do
      a12: c(0.9),                   // Garden Notes: no badge
      a13: c(52),                    // Car Upkeep
      a14: c(7),                     // Hatchabot
    } };
  })();
  // v2LoadCosts asked while a read is out only queues a re-read (fire-and-forget, #93), so a fixture
  // set right after another load could be checked before its own read came back (CI, 2026-10-23).
  const costFixture = async (body = COSTS) => { window.__override['/v1/costs'] = body; await v2LoadCosts(true); await until(() => !v2CostsBusy && !v2CostsAgain); };
  const costCleanup = async () => {
    delete window.__override['/v1/costs']; delete window.__override['/v1/model-prices'];
    v2SetView('group'); await v2LoadCosts(true); // the stub answers {}: no costs
    await refresh(false);
  };
  const chipOf = (name) => tile(name)?.querySelector('.v2cost') || null;
  const tipText = (name) => { const t = tile(name); v2ShowTip(t); const txt = document.getElementById('v2Tip').textContent.replace(/\u00a0/g, ' '); document.getElementById('v2Tip').hidden = true; return txt; };
  const tileSizes = () => [...document.querySelectorAll('#v2groups .v2agent')].map((t) => t.getBoundingClientRect().height + 'x' + t.getBoundingClientRect().width);
  Object.assign(T, {
    costBadges: async () => {
      try {
        const before = tileSizes();
        await costFixture();
        ok('asked for a week (the default window)', calls('GET', /^\/v1\/costs$/).some((c) => c.url.includes('period=1w')));
        eq('Homework Helper', chipOf('Homework Helper')?.textContent, '$1.2k/wk');
        ok('$100 a week and more take the gold wash', chipOf('Homework Helper').classList.contains('v2cost-hi') && chipOf('Budget Tracker').classList.contains('v2cost-hi'));
        eq('Soccer Schedule', chipOf('Soccer Schedule')?.textContent, '$240/wk');
        eq('Meal Planner', chipOf('Meal Planner')?.textContent, '$18/wk');
        ok('under $100 is the quiet chip', !chipOf('Meal Planner').classList.contains('v2cost-hi') && !chipOf('Car Upkeep').classList.contains('v2cost-hi'));
        eq('Grocery Runner, $1 and up', chipOf('Grocery Runner')?.textContent, '$4/wk');
        for (const name of ['Home Maintenance', 'Garden Notes', 'Travel Planner', 'Stock Watcher', 'Tax Filing']) ok(name + ': no badge (under $1, no price, local, or no use)', !chipOf(name));
        eq('tiles keep their size', tileSizes(), before);
        ok('the tile says it out loud', tile('Meal Planner').getAttribute('aria-label').includes('about $18 a week at API prices'));
        const chip = chipOf('Homework Helper').getBoundingClientRect(), ic = tile('Homework Helper').querySelector('.v2ic').getBoundingClientRect();
        ok('the chip sits on the icon\'s top edge, centred', chip.top < ic.top && chip.bottom > ic.top && Math.abs((chip.left + chip.right) / 2 - (ic.left + ic.right) / 2) < 2);
        // Loaded with the list poll, at most every 5 minutes.
        const n = calls('GET', /^\/v1\/costs$/).length;
        await refresh(false); await refresh(false);
        eq('not re-read on every poll', calls('GET', /^\/v1\/costs$/).length, n);
      } finally { await costCleanup(); }
    },
    costTooltip: async () => {
      try {
        await costFixture();
        for (const v of ['group', 'activity', 'cost']) {
          v2SetView(v); await sleep(30);
          const meal = tipText('Meal Planner');
          ok(v + ': the week and the month: ' + meal, meal.includes('≈ $18/wk at API prices (≈ $77/mo)'));
          ok(v + ': the plan note', meal.includes('Counts against your Claude plan'));
        }
        v2SetView('group');
        ok('no plan note on an API-priced agent', tipText('Car Upkeep').includes('≈ $52/wk') && !tipText('Car Upkeep').includes('Claude plan'));
        ok('no price known', tipText('Travel Planner').includes('no price known'));
        ok('a local model', tipText('Stock Watcher').includes('local model'));
        ok('nothing for a quiet week', !tipText('Tax Filing').includes('API prices'));
      } finally { await costCleanup(); }
    },
    costView: async () => {
      try {
        await costFixture();
        const btn = byText('.v2views button', 'Cost'); ok('a Cost view', !!btn);
        btn.click(); await sleep(50);
        ok('the view switched', v2View === 'cost');
        const heads = [...document.querySelectorAll('#v2groups .v2ghead h3')].map((h) => h.textContent);
        eq('sections, dearest first', heads.filter((h) => h !== 'Archived'), ['>$100/wk', '$50–100/wk', '$10–50/wk', '<$10/wk', 'No price known', 'No usage']);
        const sec = (label) => [...document.querySelectorAll('#v2groups .v2group')].find((g) => g.querySelector('h3').textContent === label);
        const namesIn = (label) => [...sec(label).querySelectorAll('.v2agent .v2name')].map((n) => n.textContent);
        eq('most expensive first', namesIn('>$100/wk'), ['Homework Helper', 'Soccer Schedule', 'Budget Tracker']);
        eq('$50–100', namesIn('$50–100/wk'), ['Piano Practice', 'Car Upkeep']);
        eq('the manager stays first; then dearest', namesIn('<$10/wk'), ['Hatchabot', 'Grocery Runner', 'Garden Notes', 'Home Maintenance', 'Stock Watcher']);
        eq('the week\'s total in the header', sec('>$100/wk').querySelector('.v2gnote')?.textContent, '($1,600 total)');
        eq('$10–50 total', sec('$10–50/wk').querySelector('.v2gnote')?.textContent, '($30 total)');
        ok('a band heading stays as written ("/wk", not "/WK")', getComputedStyle(sec('>$100/wk').querySelector('h3')).textTransform === 'none');
        ok('other headings keep the house capitals', getComputedStyle(sec('No usage').querySelector('h3')).textTransform === 'uppercase');
        ok('no total where nothing is priced', !sec('No usage').querySelector('.v2gnote'));
        // The Sort control works here as elsewhere; Cost is its own, first, choice in this view.
        const sortBtns = () => [...document.querySelectorAll('.v2binsort button')].map((b) => b.textContent.replace(/ [▲▼]$/, ''));
        eq('sort buttons', sortBtns(), ['Cost', 'Age', 'Name', 'Activity', 'My order']);
        byText('.v2binsort button', 'Name').click(); await sleep(30);
        eq('Name A→Z inside a band', namesIn('>$100/wk'), ['Budget Tracker', 'Homework Helper', 'Soccer Schedule']);
        byText('.v2binsort button', 'Cost').click(); await sleep(30);
        eq('back to dearest first', namesIn('>$100/wk'), ['Homework Helper', 'Soccer Schedule', 'Budget Tracker']);
        byText('.v2binsort button', 'Cost').click(); await sleep(30);
        eq('again: cheapest first', namesIn('>$100/wk'), ['Budget Tracker', 'Soccer Schedule', 'Homework Helper']);
        byText('.v2binsort button', 'Cost').click(); await sleep(30);
        const groupsSort = JSON.stringify(v2Sort);
        byText('.v2views button', 'Groups').click(); await sleep(30);
        eq('Groups has no Cost sort', sortBtns(), ['Age', 'Name', 'Activity', 'My order']);
        eq('the other views keep their own sort', JSON.stringify(v2Sort), groupsSort);
      } finally { await costCleanup(); }
    },
    costPeriods: async () => {
      try {
        await costFixture();
        v2SetView('cost'); await sleep(30);
        const pills = () => [...document.querySelectorAll('.v2costbar .su-period')];
        eq('eight windows', pills().map((b) => b.textContent), ['1 hr', '3 hr', '6 hr', '9 hr', '12 hr', '1 day', '1 wk', '1 mo']);
        eq('a week by default', pills().filter((b) => b.classList.contains('on')).map((b) => b.textContent), ['1 wk']);
        // Three hours: the server's answer for that window (made-up figures).
        const c = (cost, tier, extra = {}) => ({ cost, weekly: Math.round(cost * 56 * 100) / 100, monthly: Math.round(cost * 240 * 100) / 100, tier, priced: true, ...extra });
        window.__override['/v1/costs'] = { days: 0.125, period: '3h', hours: 3, bands: [0.2, 1, 2], chipMin: 0.02, suffix: '/3h', at: new Date().toISOString(), agents: {
          a1: c(2.5, 4), a5: c(0.35, 2), a12: c(0.01, 1), a4: c(1.2, 3, { plan: true }), a10: { ...c(0, 0) },
        } };
        const mark = window.__calls.length;
        byText('.v2costbar button', '3 hr').click();
        await until(() => v2Costs?.period === '3h');
        ok('asked for 3 hours', window.__calls.slice(mark).some((x) => x.method === 'GET' && x.url.includes('/v1/costs?period=3h')));
        await sleep(30);
        eq('the pill moved', pills().filter((b) => b.classList.contains('on')).map((b) => b.textContent), ['3 hr']);
        eq('the chip shows the window: Homework Helper', chipOf('Homework Helper')?.textContent, '$3/3h');
        ok('gold from the window\'s top band', chipOf('Homework Helper').classList.contains('v2cost-hi') && !chipOf('Meal Planner').classList.contains('v2cost-hi'));
        eq('cents under a dollar', chipOf('Grocery Runner')?.textContent, '$0.35/3h');
        ok('under the window\'s smallest chip: none', !chipOf('Garden Notes'));
        const heads = [...document.querySelectorAll('#v2groups .v2ghead h3')].map((h) => h.textContent);
        ok('bands for 3 hours: ' + heads.join(' | '), heads.includes('>$2/3h') && heads.includes('$1–2/3h') && heads.includes('$0.20–1/3h') && heads.includes('No usage'));
        ok('the tooltip says the window: ' + tipText('Meal Planner'), tipText('Meal Planner').includes('≈ $1.20/3h at API prices (≈ $288/mo at this pace)'));
        ok('and the tile out loud', tile('Homework Helper').getAttribute('aria-label').includes('about $2.50 in the last 3 hours at API prices'));
        v2SetView('group'); await sleep(30);
        eq('the chips follow it in every view', chipOf('Homework Helper')?.textContent, '$3/3h');
        ok('no pills outside the Cost view', !document.querySelector('.v2costbar'));
        let kept = null; try { kept = localStorage.getItem('hb-cost-period'); } catch {}
        eq('remembered in this browser', kept, '3h');
      } finally { delete window.__override['/v1/costs']; v2SetCostPeriod('1w'); await costCleanup(); }
    },
    // A pill pressed while the last window's figures are still on their way:
    // its own figures are read once that answer is back (#93).
    costPeriodWhileLoading: async () => {
      const realFetch = window.fetch;
      try {
        await costFixture();
        v2SetView('cost'); await sleep(30);
        let release; const gate = new Promise((r) => { release = r; });
        const answer = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
        window.fetch = async (input, init) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (url.includes('/v1/costs?period=1w')) { window.__calls.push({ method: 'GET', path: '/v1/costs', url }); await gate; return answer({ ...COSTS, period: '1w' }); }
          if (url.includes('/v1/costs?period=3h')) { window.__calls.push({ method: 'GET', path: '/v1/costs', url }); return answer({ days: 0.125, period: '3h', hours: 3, bands: [0.2, 1, 2], chipMin: 0.02, suffix: '/3h', agents: { a1: { cost: 2.5, weekly: 140, monthly: 600, tier: 4, priced: true } } }); }
          return realFetch(input, init);
        };
        const first = v2LoadCosts(true); // a week's figures, slow to come
        await sleep(20);
        const mark = window.__calls.length;
        byText('.v2costbar button', '3 hr').click();
        release();
        await first;
        await until(() => v2Costs?.period === '3h');
        eq('one read for 3 hours', window.__calls.slice(mark).filter((x) => x.url.includes('/v1/costs?period=3h')).length, 1);
        await sleep(30);
        eq('the chip shows 3 hours', chipOf('Homework Helper')?.textContent, '$3/3h');
      } finally { window.fetch = realFetch; v2SetCostPeriod('1w'); await costCleanup(); }
    },
    costBadgesOff: async () => {
      try {
        await costFixture();
        v2SetView('cost');
        await costFixture({ off: true, days: 7, agents: {} });
        await until(() => !document.querySelector('#v2groups .v2cost'));
        ok('no Cost view', !byText('.v2views button', 'Cost'));
        ok('off the Cost view', v2View === 'group');
        ok('no cost line in the tooltip', !tipText('Meal Planner').includes('API prices'));
      } finally { await costCleanup(); }
    },
    modelPrices: async () => {
      try {
        window.__override['/v1/model-prices'] = { checked: '2026-10-03', source: 'https://platform.claude.com/docs/en/about-claude/pricing', cacheWrite: 1.25, cacheReadDefault: 0.1,
          models: [
            { id: 'claude-opus-5-5', label: 'Opus 5.5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheReadShare: 0.05 },
            { id: 'claude-opus-4-8', label: 'Opus 4.8', input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheReadShare: 0.1 },
            { id: 'claude-haiku-4-5', label: 'Haiku 4.5', input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheReadShare: 0.1 },
            { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheReadShare: 0.1, legacy: true } ],
          local: ['qwen3:8b'], unpriced: ['gemini-9-pro'] };
        openModelPrices();
        await until(() => aiDlg.open && document.getElementById('pricesDrawer').open);
        const box = await until(() => document.querySelector('#modelPrices .mp-tbl') && document.getElementById('modelPrices'));
        const row = [...box.querySelectorAll('tbody tr')].find((r) => r.textContent.includes('Opus 4.8'));
        eq('a row per model: input, output, cache read, cache write', [...row.querySelectorAll('td')].slice(1).map((td) => td.textContent), ['$5', '$25', '$0.50', '$6.25']);
        ok('an older model is dimmed', [...box.querySelectorAll('tbody tr.mp-old')].some((r) => r.textContent.includes('Sonnet 4.6')));
        const text = box.textContent.replace(/\s+/g, ' ');
        ok('the multipliers: ' + text.slice(0, 200), text.includes('Cache read = 0.1× the input price (0.05× on Opus 5.5)') && text.includes('cache write = 1.25× input'));
        ok('the date it was checked', /Checked against Anthropic's pricing page on .*2026/.test(text));
        eq('the link', box.querySelector('a[href^="https://platform.claude.com"]')?.getAttribute('href'), 'https://platform.claude.com/docs/en/about-claude/pricing');
        ok('what caching does', text.includes('Every message re-sends the whole conversation') && text.includes('1.25×'));
        ok('the worked example', text.includes('300,000-token conversation') && text.includes('$0.15') && text.includes('$1.88') && text.includes('$0.03'));
        ok('local models are free', text.includes('qwen3:8b') && text.includes('$0'));
        ok('no price known, named', text.includes('No price known: gemini-9-pro'));
        aiDlg.close();
      } finally { if (aiDlg.open) aiDlg.close(); await costCleanup(); }
    },
  });
  // ---- The token steward: the manager's star and ring, and a stuck loop under Alerts (made-up data) ----
  const withAgents = async (patch) => {
    const list = await (await fetch('/v1/agents')).json();
    window.__override['/v1/agents'] = list.map((a) => patch(a) ?? a);
    await refresh(false);
  };
  const agentsCleanup = async () => { delete window.__override['/v1/agents']; v2SetView('group'); await refresh(false); };
  Object.assign(T, {
    opsStar: async () => {
      try {
        // Every other mark on the manager's tile at once: unread, quiet-for, three chat apps, a cost chip.
        await withAgents((a) => a.ops ? { ...a, unread: true, lastActiveAt: new Date(Date.now() - 5 * 3600e3).toISOString(), botUsername: 'HbBot', deepLink: 'https://t.me/x', webOnly: false,
          otherChannels: [{ kind: 'discord', displayName: '@hb' }, { kind: 'slack', displayName: '@hb' }] } : undefined);
        const ops = tile('Hatchabot');
        const stars = [...document.querySelectorAll('#v2groups .v2star')];
        eq('one star, on the Hatchabot tile only', stars.length, 1);
        ok('the star is the manager\'s', ops.contains(stars[0]));
        const ic = ops.querySelector('.v2ic');
        ok('its icon has the ring', ic.classList.contains('v2ic-ops'));
        ok('no other tile has it', document.querySelectorAll('#v2groups .v2ic-ops').length === 1);
        const cs = getComputedStyle(ic), plain = getComputedStyle(tile('Meal Planner').querySelector('.v2ic'));
        ok('a stronger edge than other tiles: ' + cs.borderTopWidth + ' vs ' + plain.borderTopWidth, parseFloat(cs.borderTopWidth) > parseFloat(plain.borderTopWidth));
        ok('a different edge colour', cs.borderTopColor !== plain.borderTopColor);
        // The middle of the left edge, clear of every other mark.
        const r = stars[0].getBoundingClientRect(), box = ic.getBoundingClientRect();
        ok('on the left edge', r.left < box.left && r.right > box.left);
        ok('in its middle', Math.abs((r.top + r.bottom) / 2 - (box.top + box.bottom) / 2) < 2);
        const hit = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        const marks = [...ic.querySelectorAll('.v2unread, .v2idle, .v2cost, .v2badge, .v2tg')];
        ok('the other marks are there: ' + marks.length, ic.querySelector('.v2unread') && ic.querySelector('.v2idle') && ic.querySelectorAll('.v2tg').length === 3);
        for (const m of marks) ok('the star clears ' + m.className, !hit(r, m.getBoundingClientRect()));
        ok('says what it is', stars[0].getAttribute('title') === 'Hatchabot — supervises your agents\u2019 AI use');
        ok('and so does the tile, out loud', ops.getAttribute('aria-label').includes('Hatchabot — supervises your agents\u2019 AI use'));
        ok('the tooltip says it', tipText('Hatchabot').includes('Hatchabot — supervises your agents\u2019 AI use'));
        ok('another tile\'s tooltip does not', !tipText('Meal Planner').includes('supervises'));
        // Dark theme: the ring is its own token there too.
        document.documentElement.setAttribute('data-theme', 'dark');
        const dark = getComputedStyle(ic).borderTopColor;
        document.documentElement.setAttribute('data-theme', 'light');
        ok('the ring has a dark-theme colour: ' + dark, dark && dark !== 'rgba(0, 0, 0, 0)');
        eq('every view: the star stays', (v2SetView('cost'), document.querySelectorAll('#v2groups .v2star').length), 1);
      } finally { await agentsCleanup(); }
    },
    stuckNeedsYou: async () => {
      try {
        const text = 'Stuck: Telegram message retried 12 times since 08:19 — compacting a 446K conversation takes longer than the 5-minute limit';
        await withAgents((a) => a.name === 'Stock Watcher' ? { ...a, stuck: [{ id: 'ti_1', kind: 'channel-retry', text, fix: 'Have Hatchabot compact it keeping the last 200 lines.' }] } : undefined);
        const t = tile('Stock Watcher');
        ok('the tile is marked stuck', t.classList.contains('v2st-blocked') && t.querySelector('.v2badge')?.textContent === '🔁');
        ok('its label says so', t.getAttribute('aria-label').includes('Stuck in a loop'));
        const tip = tipText('Stock Watcher');
        ok('the tooltip has the incident and the fix: ' + tip.slice(0, 120), tip.includes(text) && tip.includes('Fix: Have Hatchabot compact it'));
        if (!v2Recent) v2Recent = new Map();
        eq('said once, not again as the last line', tipText('Stock Watcher').split(text).length - 1, 1);
        byText('.v2views button', 'Alerts').click(); await sleep(50);
        const sec = [...document.querySelectorAll('#v2groups .v2group')].find((g) => g.querySelector('h3').textContent.includes('Alerts'));
        ok('a Alerts section', !!sec);
        ok('the stuck agent is in it', [...sec.querySelectorAll('.v2agent .v2name')].some((n) => n.textContent === 'Stock Watcher'));
        eq('nobody else is', [...sec.querySelectorAll('.v2agent .v2name')].map((n) => n.textContent), ['Stock Watcher']);
        // Cleared from Alerts by the owner: the same incident stays cleared; a new one comes back.
        const a = agents.find((x) => x.name === 'Stock Watcher');
        ok('the clear key names the incident', attentionFingerprint(a).includes('stuck:ti_1'));
        delete window.__override['/v1/agents'];
        await withAgents((x) => x.name === 'Stock Watcher' ? { ...x, stuck: [{ id: 'ti_2', kind: 'task-failing', text: 'Scheduled task "Prices" failed 3 runs in a row' }] } : undefined);
        ok('a new incident is a new key', attentionFingerprint(agents.find((x) => x.name === 'Stock Watcher')).includes('stuck:ti_2'));
        // Cleared by the owner: the flag is gone — not a lingering "Cleared" group, no 🔁 on the tile (2026-10-04).
        { const x = agents.find((y) => y.name === 'Stock Watcher'); x.attentionAck = attentionFingerprint(x); renderV2(); await sleep(30);
          ok('cleared: no 🔁 on its tile', !tile('Stock Watcher').classList.contains('v2st-blocked'));
          ok('cleared: no "Cleared" group', ![...document.querySelectorAll('#v2groups .v2ghead h3')].some((h) => h.textContent.includes('Cleared')));
          x.attentionAck = undefined; }
        // Gone: off Alerts and back to normal.
        delete window.__override['/v1/agents']; await refresh(false);
        ok('back to normal', !tile('Stock Watcher').classList.contains('v2st-blocked'));
      } finally { await agentsCleanup(); }
    },
    // Budgets (budgets.ts): a paused agent, an 80% line, the Usage tab's row and Settings → Budgets (made-up figures).
    budgets: async () => {
      const month = new Date().toISOString().slice(0, 7);
      try {
        await withAgents((a) => a.name === 'Stock Watcher' ? { ...a, state: 'STOPPED', budget: { scope: a.id, usd: 20, atLimit: 'pause', month, spent: 23.5, pct: 118, level: 100, resetsOn: 'next 1st', paused: { at: new Date().toISOString() }, line: 'Paused: it used its $20 budget for this month ($23.50). It starts again on the 1st — or raise the budget, or start it now' } }
          : a.name === 'Meal Planner' ? { ...a, budget: { scope: a.id, usd: 50, atLimit: 'warn', month, spent: 41.1, pct: 82, level: 80, resetsOn: 'next 1st', line: 'Used 82% of its $50 budget for this month ($41.10)' } } : undefined);
        const t = tile('Stock Watcher');
        ok('the paused tile says why: ' + t.getAttribute('aria-label'), t.getAttribute('aria-label').includes('monthly budget is used up'));
        ok('its tooltip has the line', tipText('Stock Watcher').includes('Paused: it used its $20 budget'));
        ok('the 80% line is not an Alert (it is a Recommended item now)', !agentAttention(agents.find((x) => x.name === 'Meal Planner')).some((x) => x.key.startsWith('budget:')));
        ok('a budget at 100% is, and links to its item', agentAttention(agents.find((x) => x.name === 'Stock Watcher')).find((x) => x.key.startsWith('budget:'))?.rec === 'budget:' + agents.find((x) => x.name === 'Stock Watcher').id);
        await withAgents((a) => a.name === 'Grocery Runner' ? { ...a, spendStep: { every: 100, month, spent: 212, passed: 2, next: 300, line: 'Spent $212.00 in this month — you hear every $100 (next at $300)' } } : undefined);
        ok('a step passed is not an Alert: the owner asked for that information, and its message says it', !agentAttention(agents.find((x) => x.name === 'Grocery Runner')).some((x) => x.key.startsWith('step:')));
        delete window.__override['/v1/agents'];
        await withAgents((a) => a.name === 'Stock Watcher' ? { ...a, state: 'STOPPED', budget: { scope: a.id, usd: 20, atLimit: 'pause', month, spent: 23.5, pct: 118, level: 100, resetsOn: 'next 1st', paused: { at: new Date().toISOString() }, line: 'Paused: it used its $20 budget for this month ($23.50). It starts again on the 1st — or raise the budget, or start it now' } }
          : a.name === 'Meal Planner' ? { ...a, budget: { scope: a.id, usd: 50, atLimit: 'warn', month, spent: 41.1, pct: 82, level: 80, resetsOn: 'next 1st', line: 'Used 82% of its $50 budget for this month ($41.10)' } } : undefined);
        byText('.v2views button', 'Alerts').click(); await sleep(50);
        const sec = [...document.querySelectorAll('#v2groups .v2group')].find((g) => g.querySelector('h3').textContent.includes('Alerts'));
        const names = [...sec.querySelectorAll('.v2agent .v2name')].map((n) => n.textContent);
        ok('the paused one is under Alerts, the 80% one is not: ' + names, names.includes('Stock Watcher') && !names.includes('Meal Planner'));
        const meal = agents.find((x) => x.name === 'Meal Planner');
        ok('the clear key names month, level and amount', attentionFingerprint(agents.find((x) => x.name === 'Stock Watcher')).includes('budget:' + month + ':100:20:p'));
        // The Usage tab: its budget, set in place.
        window.__override['/v1/budgets'] = { month, tz: 'UTC', agents: [
          { id: meal.id, name: 'Meal Planner', state: 'RUNNING', billing: 'api', spent: 41.1, lastMonth: 38, monthlyNow: 52, suggested: 75, budget: meal.budget },
          { id: 'zz', name: 'Errand Runner', state: 'RUNNING', billing: 'plan', spent: 3, lastMonth: 4, monthlyNow: 4, suggested: 5 },
        ], machine: { spent: 240, lastMonth: 310 } };
        openV2Agent(meal.id, 'usage');
        const input = await until(() => document.getElementById('bgUsd_' + meal.id));
        eq('the row shows its budget', input.value, '50');
        // Two lines, not a word a line (2026-10-25): each label beside its boxes, the menu its own size.
        const mid = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
        const stepIn = document.getElementById('bgStep_' + meal.id), atSel = document.getElementById('bgAt_' + meal.id);
        const stepSave = stepIn.closest('.bg-form').querySelector('button'), limitSave = input.closest('.bg-form').querySelector('button');
        const bgLabel = (t) => [...document.querySelectorAll('#v2BudgetRow .bg-rows > .sub')].find((s) => s.textContent === t);
        ok('"Tell me", its box and its Save on one line', Math.abs(mid(bgLabel('Tell me')) - mid(stepIn)) < 10 && Math.abs(mid(stepIn) - mid(stepSave)) < 10);
        ok('"Limit", its box, the menu and Save on one line', Math.abs(mid(bgLabel('Limit')) - mid(input)) < 10 && Math.abs(mid(input) - mid(atSel)) < 10 && Math.abs(mid(atSel) - mid(limitSave)) < 10);
        ok('the menu is its own size: ' + Math.round(atSel.getBoundingClientRect().width), atSel.getBoundingClientRect().width < 220);
        input.value = '60'; document.getElementById('bgAt_' + meal.id).value = 'pause';
        const mark = window.__calls.length;
        document.getElementById('bgUsd_' + meal.id).closest('.bg-form').querySelector('button').click();
        const put = await until(() => window.__calls.slice(mark).find((c) => c.method === 'PUT' && c.path === '/v1/agents/' + meal.id + '/budget'));
        eq('saved as asked', put.body, { usd: 60, atLimit: 'pause' });
        // "Tell me every $…", in the same row.
        document.getElementById('bgStep_' + meal.id).value = '25';
        document.getElementById('bgStep_' + meal.id).closest('.bg-form').querySelector('button').click();
        const step = await until(() => window.__calls.slice(mark).find((c) => c.method === 'PUT' && c.path === '/v1/agents/' + meal.id + '/spend-alert'));
        eq('the step saved', step.body, { every: 25 });
        v2Close();
        // Settings → AI sources → Budgets: every agent, and the machine's own row for its owner.
        openBudgets();
        const body = await until(() => document.querySelector('#budgetsBody table') && document.getElementById('budgetsBody'));
        ok('the machine row', body.textContent.includes('This whole Hatchabot') && document.getElementById('bgUsd_machine'));
        ok('a plan agent is marked', body.textContent.includes('Errand Runner (plan)'));
        ok('a suggestion as the placeholder', document.getElementById('bgUsd_zz').placeholder === 'e.g. 5');
        document.getElementById('bgUsd_zz').value = '';
        const mark2 = window.__calls.length;
        document.getElementById('bgUsd_machine').closest('.bg-form').querySelector('button').click();
        await until(() => window.__calls.slice(mark2).some((c) => c.method === 'PUT' && c.path === '/v1/budgets/machine'));
        ok('the machine has a step too', !!document.getElementById('bgStep_machine'));
        // The same agent, edited here after its Usage tab was open: its row is
        // on the page twice, and Save must take this row's values, not the
        // sheet's stale copy (deep review, 2026-10-09).
        const rowInput = [...document.querySelectorAll('#budgetsBody [id="bgUsd_' + meal.id + '"]')][0];
        ok('the agent\'s row is here too', !!rowInput);
        rowInput.value = '100';
        rowInput.parentElement.querySelector('[id="bgAt_' + meal.id + '"]').value = 'cheaper';
        const mark3 = window.__calls.length;
        rowInput.parentElement.querySelector('button').click();
        const put3 = await until(() => window.__calls.slice(mark3).find((c) => c.method === 'PUT' && c.path === '/v1/agents/' + meal.id + '/budget'));
        eq('this row\'s values are saved, not the sheet\'s', put3.body, { usd: 100, atLimit: 'cheaper' });
        // A model with no known price: never a bare $0.00, and the limit says it cannot be enforced (HB-0402).
        window.__override['/v1/budgets'] = { month, tz: 'UTC', agents: [
          { id: 'np', name: 'Pantry Check', state: 'RUNNING', billing: 'api', spent: 0, lastMonth: 0, monthlyNow: 0, suggested: 5,
            unpriced: { model: 'gpt-made-up-1', month: 6000000, last: 0, rate: true }, priceNote: 'No price known for gpt-made-up-1, so what it costs cannot be measured in dollars: a limit or "Tell me every $…" cannot be enforced on it.',
            budget: { scope: 'np', usd: 50, atLimit: 'pause', month, spent: 0, pct: 0, level: 0, resetsOn: 'next 1st' } },
          { id: 'pp', name: 'Shared Lists', state: 'RUNNING', billing: 'api', spent: 4, lastMonth: 3, monthlyNow: 6, suggested: 10,
            unpriced: { month: 7000, last: 0, rate: false }, priceNote: '7,000 tokens this month ran on a model with no price known and are not counted: a limit or "Tell me every $…" sees only the rest.' },
          { id: 'zz', name: 'Errand Runner', state: 'RUNNING', billing: 'plan', spent: 3, lastMonth: 4, monthlyNow: 4, suggested: 5 },
        ], machine: { spent: 7, lastMonth: 7, priceNote: '2 agents on this machine use models with no price known: this total leaves that spend out, so a limit or "Tell me every $…" here cannot count it.' } };
        await loadBudgets();
        const bgCells = (name) => [...document.querySelectorAll('#budgetsBody tbody tr')].find((tr) => tr.textContent.includes(name)).querySelectorAll('td');
        const np = bgCells('Pantry Check');
        eq('no bare $0.00 this month', np[1].textContent.trim(), 'no price known');
        eq('nor a month now', np[3].textContent.trim(), 'no price known');
        eq('last month it ran nothing unpriced: $0.00 is true', np[2].textContent.trim(), '$0.00');
        ok('the limit says it cannot be enforced', np[5].textContent.includes('cannot be enforced'));
        ok('and does not read "$0.00 of $50" as if it were watching', !np[5].textContent.includes('$0.00 of'));
        eq('nothing suggested for a limit it could not keep', document.getElementById('bgUsd_np').placeholder, 'none');
        const pp = bgCells('Shared Lists');
        eq('part priced: the dollars and that more is unknown', pp[1].textContent.replace(/\s+/g, ' ').trim(), '$4.00 + no price known');
        ok('and says what is not counted', pp[5].textContent.includes('not counted'));
        eq('a priced agent is as before', bgCells('Errand Runner')[1].textContent.trim(), '$3.00');
        ok('the machine says what its total leaves out', document.getElementById('budgetsBody').textContent.includes('2 agents on this machine'));
        // No chat reaches the owner: an armed alarm says no message will come; one not set says nothing yet (HB-0403).
        const NO_CHAT = 'No chat app can reach you for this, so no message will come.';
        window.__override['/v1/budgets'] = { month, tz: 'UTC', agents: [
          { id: 'ar', name: 'Armed Watcher', state: 'RUNNING', billing: 'api', spent: 4, lastMonth: 3, monthlyNow: 6, suggested: 10, chatNote: NO_CHAT, alertEvery: { every: 5, month, spent: 4, passed: 0, next: 5 } },
          { id: 'un', name: 'Unarmed Helper', state: 'RUNNING', billing: 'api', spent: 1, lastMonth: 1, monthlyNow: 1, suggested: 5, chatNote: NO_CHAT },
          { id: 'te', name: 'Told Helper', state: 'RUNNING', billing: 'api', spent: 1, lastMonth: 1, monthlyNow: 1, suggested: 5, alertEvery: { every: 5, month, spent: 1, passed: 0, next: 5 } },
        ], machine: { spent: 6, lastMonth: 5, chatNote: NO_CHAT, budget: { scope: 'machine', usd: 100, atLimit: 'warn', month, spent: 6, pct: 6, level: 0, resetsOn: 'next 1st' } } };
        await loadBudgets();
        ok('an armed alarm says no message will come', bgCells('Armed Watcher')[5].textContent.includes(NO_CHAT));
        ok('no alarm set, no note', !bgCells('Unarmed Helper')[5].textContent.includes(NO_CHAT));
        ok('an owner a chat reaches sees no note', !bgCells('Told Helper')[5].textContent.includes(NO_CHAT));
        ok('the machine row says it too', document.querySelector('#budgetsBody .pair').textContent.includes(NO_CHAT));
        aiDlg.close();
      } finally { if (typeof aiDlg !== 'undefined' && aiDlg.open) aiDlg.close(); delete window.__override['/v1/budgets']; await agentsCleanup(); }
    },
    // Its own browser (docs/browser.md): off by default, switched on from Advanced, which rebuilds it.
    agentBrowserSwitch: async () => {
      const a1 = agents.find((a) => a.id === 'a1');
      const was = a1.browser;
      window.__override['/v1/agents/a1/browser'] = { on: false, running: false };
      try {
        a1.browser = false;
        openV2Agent('a1', 'advanced'); await sleep(300);
        const sel = $('v2Browser');
        ok('the Advanced tab has a Browser switch, off', !!sel && sel.value === 'off');
        ok('it says what it costs', /300K tokens/.test($('v2Pane').textContent));
        window.__calls.length = 0; window.__confirms.length = 0;
        sel.value = 'on'; sel.dispatchEvent(new Event('change')); await sleep(200);
        const patch = window.__calls.find((c) => c.method === 'PATCH' && c.path === '/v1/agents/a1');
        ok('switching it on asks first (it rebuilds)', window.__confirms.some((t) => /rebuilds/.test(t)));
        ok('and turns it on', patch?.body?.browser === true);
        window.__override['/v1/agents/a1/browser'] = { on: true, running: true };
        await v2LoadBrowser('a1');
        ok('a running browser says so: ' + $('v2BrowserState').textContent, /running/.test($('v2BrowserState').textContent));
      } finally {
        a1.browser = was;
        delete window.__override['/v1/agents/a1/browser'];
        v2Close?.();
      }
    },
    // Adopting without Telegram (2.149): the console is how it is talked to. Made-up workspace.
    adoptWithoutTelegram: async () => {
      window.__answer = window.__answer || {};
      const WS = '/home/tester/.openclaw/workspace-garden-helper';
      window.__override['/v1/openclaw/agents'] = { agents: [{ id: 'garden', name: 'Garden Helper', workspace: WS, bot: null }] };
      window.__override['/v1/agents/ad1'] = { id: 'ad1', name: 'Garden Helper', state: 'RUNNING' };
      const hadHosts = hosts;
      if (!hosts?.length) hosts = [{ id: 'h1', name: 'This machine', kind: 'local' }];
      try {
        openAdoptDlg(); await sleep(250);
        const row = document.querySelector('#adoptDiscover input[data-oc]');
        ok('an agent without a bot can be ticked in the list', !!row && !row.disabled);
        ok('and says it comes in without Telegram: ' + $('adoptDiscover').textContent.trim().slice(0, 120), /without Telegram/.test($('adoptDiscover').textContent));
        window.__answer['POST /v1/workspaces/inspect'] = [{ status: 200, body: { path: WS, files: ['SOUL.md', 'AGENTS.md'], bytes: 2048, markdownFiles: ['SOUL.md', 'AGENTS.md'], existingBot: null, links: ['notes -> /srv/shared/notes'] } }];
        $('adoptPath').value = WS;
        await adoptInspect(); await sleep(50);
        ok('a link in the workspace is named as not copied (2026-10-10): ' + $('adoptPreview').textContent.trim().slice(0, 160),
          /Not copied — a link: notes -> \/srv\/shared\/notes/.test($('adoptPreview').textContent));
        ok('a workspace with no bot: "No Telegram for now" is ticked', !!$('adoptWeb')?.checked);
        ok('and the bot choice is out of the way', $('adoptBotChoice')?.hidden === true);
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad1', name: 'Garden Helper', state: 'PROVISIONING' } }];
        window.__answer['POST /v1/agents/ad1/adopt-workspace'] = [{ status: 200, body: { files: 2, bytes: 2048, crons: { carried: 0 } } }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        const made = window.__calls.find((c) => c.method === 'POST' && c.path === '/v1/agents');
        ok('the agent is created web-only (telegram: false)', made?.body?.telegram === false);
        ok('no bot token is asked for or sent', !window.__calls.some((c) => /channel-token/.test(c.path)));
        ok('its workspace is copied in', window.__calls.some((c) => c.method === 'POST' && c.path === '/v1/agents/ad1/adopt-workspace'));
      } finally {
        hosts = hadHosts;
        for (const k of ['POST /v1/workspaces/inspect', 'POST /v1/agents', 'POST /v1/agents/ad1/adopt-workspace']) delete window.__answer[k];
        for (const k of ['/v1/openclaw/agents', '/v1/agents/ad1']) delete window.__override[k];
        if (adoptDlg.open) adoptDlg.close();
        await refresh(false);
      }
    },
    // Taking over a workspace's bot (HB-0542): no pool bot is used, and the
    // workspace goes only into an agent that runs after the hand-over; one
    // asking for a bot again is removed and says why. Made-up workspace and bot.
    adoptReuseBotRunsFirst: async () => {
      window.__answer = window.__answer || {};
      const WS = '/home/tester/.openclaw/workspace-pantry-helper';
      const bot = { accountId: 'made_up_pantry_bot', sourceAgentId: 'pantry', enabledInSource: false, polling: 'idle', allowFrom: [] };
      const waiting = { id: 'ad2', name: 'Pantry Helper', state: 'PROVISIONING', pendingAction: { type: 'bot_token', instructions: 'made up' } };
      const hadHosts = hosts;
      if (!hosts?.length) hosts = [{ id: 'h1', name: 'This machine', kind: 'local' }];
      try {
        openAdoptDlg(); await sleep(250);
        window.__answer['POST /v1/workspaces/inspect'] = [{ status: 200, body: { path: WS, files: ['SOUL.md'], bytes: 1024, markdownFiles: ['SOUL.md'], existingBot: bot, links: [] } }];
        $('adoptPath').value = WS;
        await adoptInspect(); await sleep(50);
        ok('taking over its bot is offered and ticked', !!$('adoptReuse')?.checked);
        $('adoptName').value = 'Pantry Helper';
        // Setup turns the bot down: it asks for a bot again after the hand-over.
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad2', name: 'Pantry Helper', state: 'PROVISIONING' } }];
        window.__answer['GET /v1/agents/ad2'] = [{ body: waiting }, { body: waiting }];
        window.__answer['POST /v1/agents/ad2/channel-token'] = [{ status: 202, body: { username: bot.accountId } }];
        window.__answer['DELETE /v1/agents/ad2'] = [{ status: 200, body: {} }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        const made = window.__calls.find((c) => c.method === 'POST' && c.path === '/v1/agents');
        ok('the agent is made with no pool bot (skipPool)', made?.body?.skipPool === true);
        ok('the old bot is handed over', window.__calls.some((c) => c.method === 'POST' && c.path === '/v1/agents/ad2/channel-token' && c.body?.fromWorkspace === WS));
        ok('nothing is copied into an agent that is not running', !window.__calls.some((c) => c.path === '/v1/agents/ad2/adopt-workspace'));
        ok('the half-made agent is removed', window.__calls.some((c) => c.method === 'DELETE' && c.path === '/v1/agents/ad2'));
        ok('and it says why: ' + $('adoptErr').textContent, /@made_up_pantry_bot was not taken over: “Pantry Helper” is PROVISIONING and waiting for a bot token/.test($('adoptErr').textContent));

        // An agent that came up on another bot: the old one was never taken over.
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad2', name: 'Pantry Helper', state: 'PROVISIONING' } }];
        window.__answer['GET /v1/agents/ad2'] = [{ body: { id: 'ad2', name: 'Pantry Helper', state: 'RUNNING', botUsername: 'made_up_pool_bot' } }];
        window.__answer['DELETE /v1/agents/ad2'] = [{ status: 200, body: {} }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        ok('an agent that did not wait for the bot is not adopted into', !window.__calls.some((c) => c.path === '/v1/agents/ad2/adopt-workspace' || /channel-token/.test(c.path)));
        ok('and it says so: ' + $('adoptErr').textContent, /did not wait for a bot \(it has @made_up_pool_bot\), so @made_up_pantry_bot was not taken over/.test($('adoptErr').textContent));
      } finally {
        hosts = hadHosts;
        for (const k of ['POST /v1/workspaces/inspect', 'POST /v1/agents', 'GET /v1/agents/ad2', 'POST /v1/agents/ad2/channel-token', 'DELETE /v1/agents/ad2']) delete window.__answer[k];
        if (adoptDlg.open) adoptDlg.close();
        await refresh(false);
      }
    },
    // Adopt waits as long as the CLI after a bot is handed over (15 minutes),
    // and an agent still setting up then is left to finish, not removed
    // (eighth review). Made-up workspace and bot.
    adoptWaitsForSlowSetup: async () => {
      window.__answer = window.__answer || {};
      const WS = '/home/tester/.openclaw/workspace-porch-helper';
      const bot = { accountId: 'made_up_porch_bot', sourceAgentId: 'porch', enabledInSource: false, polling: 'idle', allowFrom: [] };
      const waiting = { id: 'ad3', name: 'Porch Helper', state: 'PROVISIONING', pendingAction: { type: 'bot_token', instructions: 'made up' } };
      const setting = { id: 'ad3', name: 'Porch Helper', state: 'PROVISIONING' };
      const hadHosts = hosts;
      if (!hosts?.length) hosts = [{ id: 'h1', name: 'This machine', kind: 'local' }];
      const keys = ['POST /v1/workspaces/inspect', 'POST /v1/agents', 'GET /v1/agents/ad3', 'POST /v1/agents/ad3/channel-token', 'POST /v1/agents/ad3/adopt-workspace', 'DELETE /v1/agents/ad3'];
      try {
        openAdoptDlg(); await sleep(250);
        window.__answer['POST /v1/workspaces/inspect'] = [{ status: 200, body: { path: WS, files: ['SOUL.md'], bytes: 1024, markdownFiles: ['SOUL.md'], existingBot: bot, links: [] } }];
        $('adoptPath').value = WS;
        await adoptInspect(); await sleep(50);
        ok('taking over its bot is offered and ticked', !!$('adoptReuse')?.checked);
        $('adoptName').value = 'Porch Helper';

        // Still setting up after 15 minutes: left to finish, and said so.
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad3', name: 'Porch Helper', state: 'PROVISIONING' } }];
        window.__answer['GET /v1/agents/ad3'] = [{ body: waiting }];
        window.__override['/v1/agents/ad3'] = setting;
        window.__answer['POST /v1/agents/ad3/channel-token'] = [{ status: 202, body: { username: bot.accountId } }];
        window.__answer['DELETE /v1/agents/ad3'] = [{ status: 200, body: {} }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        const looks = window.__calls.filter((c) => c.method === 'GET' && c.path === '/v1/agents/ad3').length;
        ok('it waits 15 minutes for setup after the hand-over (' + looks + ' looks)', looks >= 300);
        ok('an agent still setting up then is not removed', !window.__calls.some((c) => c.method === 'DELETE'));
        ok('nothing is copied into it', !window.__calls.some((c) => c.path === '/v1/agents/ad3/adopt-workspace'));
        ok('and it says so: ' + $('adoptErr').textContent, /“Porch Helper” is still setting up after 15 minutes, so it was left to finish, and nothing was copied/.test($('adoptErr').textContent));

        // Rebuilding at 15 minutes, after the hand-over (sixteenth review):
        // any state then is still setting up, so it is left too.
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad3', name: 'Porch Helper', state: 'PROVISIONING' } }];
        window.__answer['GET /v1/agents/ad3'] = [{ body: waiting }];
        window.__override['/v1/agents/ad3'] = { ...setting, state: 'REBUILDING' };
        window.__answer['POST /v1/agents/ad3/channel-token'] = [{ status: 202, body: { username: bot.accountId } }];
        window.__answer['DELETE /v1/agents/ad3'] = [{ status: 200, body: {} }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        ok('rebuilding at 15 minutes after the hand-over: not removed', !window.__calls.some((c) => c.method === 'DELETE'));
        ok('and it says so, with its state: ' + $('adoptErr').textContent, /“Porch Helper” is still setting up after 15 minutes \(it is rebuilding\), so it was left to finish/.test($('adoptErr').textContent));
        window.__override['/v1/agents/ad3'] = setting;

        // Still setting up after 15 minutes BEFORE the hand-over (eleventh
        // review): made to wait for this bot, it would never run, so it is
        // removed, and said so; a delete refused is said too.
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad3', name: 'Porch Helper', state: 'PROVISIONING' } }];
        delete window.__answer['GET /v1/agents/ad3'];
        window.__answer['DELETE /v1/agents/ad3'] = [{ status: 200, body: {} }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        ok('cut off before the hand-over: no bot is handed over', !window.__calls.some((c) => /channel-token/.test(c.path)));
        ok('and the agent is removed', window.__calls.some((c) => c.method === 'DELETE' && c.path === '/v1/agents/ad3'));
        ok('and it says so: ' + $('adoptErr').textContent, /“Porch Helper” was still setting up after 15 minutes, before @made_up_porch_bot was handed over, so it was removed and nothing was copied/.test($('adoptErr').textContent));
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad3', name: 'Porch Helper', state: 'PROVISIONING' } }];
        window.__answer['DELETE /v1/agents/ad3'] = [{ status: 409, body: { error: 'Another operation is already running on this agent.' } }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        ok('a delete refused then is said, with the reason: ' + $('adoptErr').textContent, /could not be removed: Another operation is already running on this agent\. Remove it from its card/.test($('adoptErr').textContent));

        // A pasted token, and still setting up after 15 minutes before it was
        // handed over (fourteenth review): removed too, and said so.
        $('adoptReuse').checked = false;
        $('adoptToken').value = '123456:made-up-token-for-the-test';
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad3', name: 'Porch Helper', state: 'PROVISIONING' } }];
        window.__answer['DELETE /v1/agents/ad3'] = [{ status: 200, body: {} }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        ok('a pasted token cut off before the hand-over: the token is never posted', !window.__calls.some((c) => /channel-token/.test(c.path)));
        ok('and the agent is removed', window.__calls.some((c) => c.method === 'DELETE' && c.path === '/v1/agents/ad3'));
        ok('and it says so: ' + $('adoptErr').textContent, /“Porch Helper” was still setting up after 15 minutes, before its bot token was handed over, so it was removed and nothing was copied/.test($('adoptErr').textContent));
        $('adoptToken').value = '';
        $('adoptReuse').checked = true;

        // Setup takes three minutes after the hand-over: adopted, not removed at two.
        delete window.__override['/v1/agents/ad3'];
        delete window.__answer['DELETE /v1/agents/ad3'];
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad3', name: 'Porch Helper', state: 'PROVISIONING' } }];
        window.__answer['GET /v1/agents/ad3'] = [{ body: waiting }, ...Array.from({ length: 60 }, () => ({ body: setting })), { body: { ...setting, state: 'RUNNING' } }];
        window.__answer['POST /v1/agents/ad3/channel-token'] = [{ status: 202, body: { username: bot.accountId } }];
        window.__answer['POST /v1/agents/ad3/adopt-workspace'] = [{ status: 200, body: { files: 1, bytes: 1024, crons: { carried: 0 } } }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        ok('a setup of three minutes is waited for, and the workspace copied', window.__calls.some((c) => c.method === 'POST' && c.path === '/v1/agents/ad3/adopt-workspace'));
        ok('and the agent is not removed', !window.__calls.some((c) => c.method === 'DELETE'));
      } finally {
        hosts = hadHosts;
        for (const k of keys) delete window.__answer[k];
        delete window.__override['/v1/agents/ad3'];
        if (adoptDlg.open) adoptDlg.close();
        await refresh(false);
      }
    },
    // Adopt hands the bot over again when Telegram did not answer (502–504),
    // with the same body, as the CLI does (ninth review). Made-up workspace and bot.
    adoptRetriesWhenTelegramDoesNotAnswer: async () => {
      window.__answer = window.__answer || {};
      const WS = '/home/tester/.openclaw/workspace-shed-helper';
      const bot = { accountId: 'made_up_shed_bot', sourceAgentId: 'shed', enabledInSource: false, polling: 'idle', allowFrom: [] };
      const waiting = { id: 'ad4', name: 'Shed Helper', state: 'PROVISIONING', pendingAction: { type: 'bot_token', instructions: 'made up' } };
      const hadHosts = hosts;
      if (!hosts?.length) hosts = [{ id: 'h1', name: 'This machine', kind: 'local' }];
      const keys = ['POST /v1/workspaces/inspect', 'POST /v1/agents', 'GET /v1/agents/ad4', 'POST /v1/agents/ad4/channel-token', 'POST /v1/agents/ad4/adopt-workspace', 'DELETE /v1/agents/ad4'];
      try {
        openAdoptDlg(); await sleep(250);
        window.__answer['POST /v1/workspaces/inspect'] = [{ status: 200, body: { path: WS, files: ['SOUL.md'], bytes: 1024, markdownFiles: ['SOUL.md'], existingBot: bot, links: [] } }];
        $('adoptPath').value = WS;
        await adoptInspect(); await sleep(50);
        ok('taking over its bot is offered and ticked', !!$('adoptReuse')?.checked);
        $('adoptName').value = 'Shed Helper';
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad4', name: 'Shed Helper', state: 'PROVISIONING' } }];
        window.__answer['GET /v1/agents/ad4'] = [{ body: waiting }, { body: { ...waiting, state: 'RUNNING', pendingAction: undefined } }];
        window.__answer['POST /v1/agents/ad4/channel-token'] = [
          { reject: 'Failed to fetch' }, // the connection dropped (twelfth review)
          { status: 503, body: { error: 'Telegram did not answer in time. Try again in a minute.' } },
          { status: 202, body: { username: bot.accountId } }];
        window.__answer['POST /v1/agents/ad4/adopt-workspace'] = [{ status: 200, body: { files: 1, bytes: 1024, crons: { carried: 0 } } }];
        window.__answer['DELETE /v1/agents/ad4'] = [{ status: 200, body: {} }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        const posts = window.__calls.filter((c) => c.method === 'POST' && c.path === '/v1/agents/ad4/channel-token');
        ok('the bot is handed over again after a dropped connection and no answer, with the same body (' + posts.length + ' posts)', posts.length === 3 && posts.every((c) => c.body?.fromWorkspace === WS));
        ok('the workspace is copied in', window.__calls.some((c) => c.method === 'POST' && c.path === '/v1/agents/ad4/adopt-workspace'));
        ok('and the agent is not removed', !window.__calls.some((c) => c.method === 'DELETE'));

        // Sixteenth review: a 409 to the post sent again, after setup took the
        // first (the step answered): the agent is read, and it was handed over.
        const setting = { ...waiting, pendingAction: undefined };
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad4', name: 'Shed Helper', state: 'PROVISIONING' } }];
        window.__answer['GET /v1/agents/ad4'] = [{ body: waiting }, { body: setting }, { body: { ...setting, state: 'RUNNING' } }];
        window.__answer['POST /v1/agents/ad4/channel-token'] = [
          { status: 504, body: { error: 'Gateway Timeout' } },
          { status: 409, body: { error: 'A bot token came in already.' } }];
        window.__answer['POST /v1/agents/ad4/adopt-workspace'] = [{ status: 200, body: { files: 1, bytes: 1024, crons: { carried: 0 } } }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        ok('a 409 to the post sent again, the step answered: adopted', window.__calls.some((c) => c.method === 'POST' && c.path === '/v1/agents/ad4/adopt-workspace'));
        ok('and not removed mid-setup', !window.__calls.some((c) => c.method === 'DELETE'));
        // The step still open: the first never landed, so the 409 is the refusal.
        window.__answer['POST /v1/agents'] = [{ status: 202, body: { id: 'ad4', name: 'Shed Helper', state: 'PROVISIONING' } }];
        window.__answer['GET /v1/agents/ad4'] = [{ body: waiting }, { body: waiting }];
        window.__answer['POST /v1/agents/ad4/channel-token'] = [
          { status: 504, body: { error: 'Gateway Timeout' } },
          { status: 409, body: { error: 'It is being deleted.' } }];
        window.__answer['DELETE /v1/agents/ad4'] = [{ status: 200, body: {} }];
        window.__calls.length = 0;
        await runAdopt(); await sleep(100);
        ok('a 409 to the post sent again, the step still open: removed', window.__calls.some((c) => c.method === 'DELETE' && c.path === '/v1/agents/ad4'));
        ok('and the 409 is what it says: ' + $('adoptErr').textContent, /It is being deleted\./.test($('adoptErr').textContent));
      } finally {
        hosts = hadHosts;
        for (const k of keys) delete window.__answer[k];
        if (adoptDlg.open) adoptDlg.close();
        await refresh(false);
      }
    },
    // Bringing in a bot when Telegram did not answer (C065): OpenClaw's poller is
    // not known to have stopped, so the bot is not taken over, and the row says
    // why even after the list is drawn again. Made-up workspace and bot.
    adoptUnconfirmedBot: async () => {
      window.__answer = window.__answer || {};
      const WS = '/home/tester/.openclaw/workspace-recipe-box';
      window.__override['/v1/openclaw/agents'] = { agents: [{ id: 'recipes', name: 'Recipe Box', workspace: WS, bot: { accountId: 'recipe_box_bot', enabledInSource: true } }] };
      const hadHosts = hosts;
      if (!hosts?.length) hosts = [{ id: 'h1', name: 'This machine', kind: 'local' }];
      try {
        openAdoptDlg(); await sleep(250);
        const box = document.querySelector('#adoptDiscover input[data-oc]');
        ok('the agent with a bot can be ticked', !!box && !box.disabled);
        box.checked = true; updateSelCount();
        window.__answer['POST /v1/openclaw/quiesce'] = [{ status: 200, body: { quiet: [], stillBusy: [], unconfirmed: ['recipe_box_bot'] } }];
        window.__calls.length = 0;
        await bringInSelected(); await sleep(100);
        ok('the hand-over was asked for that bot', window.__calls.some((c) => c.method === 'POST' && c.path === '/v1/openclaw/quiesce' && c.body?.accountIds?.[0] === 'recipe_box_bot'));
        ok('no agent was made from it', !window.__calls.some((c) => c.method === 'POST' && c.path === '/v1/agents'));
        const row = $('ocrow-0')?.textContent || '';
        ok('its row says it could not be confirmed, after the list was redrawn: ' + row, /couldn't confirm OpenClaw stopped using this bot/.test(row));
      } finally {
        hosts = hadHosts;
        delete window.__answer['POST /v1/openclaw/quiesce'];
        delete window.__override['/v1/openclaw/agents'];
        if (adoptDlg.open) adoptDlg.close();
        await refresh(false);
      }
    },
    // A runner's own memory search (2.147) and an old image on it (Settings → Hosts). Made-up machines.
    runnerMemorySearch: async () => {
      window.__override['/v1/hosts'] = [{ id: 'h1', name: 'This machine', kind: 'local', agentCount: 12 },
        { id: 'r1', name: 'Laptop runner', kind: 'cloud', settings: { dockerHost: 'ssh://laptop.example.org' }, agentCount: 1 }];
      window.__override['/v1/embedder'] = { embedder: 'absent', door: 'absent', enabled: false, modelPresent: true };
      window.__override['/v1/hosts/r1/ping'] = { reachable: true, serverVersion: '29.6.2', hasImage: true, imageVersion: '2026.7.1-2', currentVersion: '2026.9.8' };
      window.__override['/v1/hosts/r1/install-image'] = { idle: true };
      window.__answer = window.__answer || {};
      try {
        await loadHosts(); await sleep(150);
        const line = $('hostembed-r1');
        ok('the runner row has a memory search line: ' + (line?.textContent ?? ''), !!line && /off — starts with the first agent built there/.test(line.textContent));
        ok('the local row has none (its service is the section above)', !$('hostembed-h1'));
        const start = [...$('hostembedacts-r1').querySelectorAll('button')].find((b) => b.textContent === 'Start');
        ok('a Start button on the runner row', !!start);
        window.__calls.length = 0;
        start.click(); await sleep(150);
        const call = window.__calls.find((c) => c.method === 'POST' && c.path === '/v1/embedder/start');
        ok('Start drives that runner\'s service', call?.body?.host === 'r1');
        await pingHost('r1'); await sleep(50);
        const ping = $('hostping-r1').textContent;
        ok('an old image on the runner is named: ' + ping, ping.includes('OpenClaw 2026.7.1-2 (this machine: 2026.9.8)'));
        const upd = [...$('hostping-r1').querySelectorAll('button')].find((b) => b.textContent === 'Update image');
        ok('and offered the update', !!upd);
        // The copy runs on the server; the row follows it (a relayed link took over 15 minutes, 2026-10-08).
        window.__answer['POST /v1/hosts/r1/install-image'] = [{ status: 202, body: { startedAt: 'now', bytes: 0, done: false } }];
        window.__override['/v1/hosts/r1/install-image'] = { startedAt: 'now', bytes: 1.1e9, total: 2.2e9, done: false };
        window.__calls.length = 0;
        upd.click(); await sleep(300);
        ok('Update image starts the copy', window.__calls.some((c) => c.method === 'POST' && c.path === '/v1/hosts/r1/install-image'));
        ok('the row shows how far it has come: ' + $('hostping-r1').textContent, $('hostping-r1').textContent.includes('1.1 of 2.2 GB'));
        window.__override['/v1/hosts/r1/ping'] = { reachable: true, serverVersion: '29.6.2', hasImage: true, imageVersion: '2026.9.8', currentVersion: '2026.9.8' };
        window.__override['/v1/hosts/r1/install-image'] = { startedAt: 'now', bytes: 2.2e9, total: 2.2e9, done: true, ok: true };
        await sleep(3600);
        ok('done: the row checks again and shows the same version as here: ' + $('hostping-r1').textContent, /OpenClaw 2026\.9\.8/.test($('hostping-r1').textContent) && !/Update image/.test($('hostping-r1').textContent));
      } finally {
        if (window.__answer) delete window.__answer['POST /v1/hosts/r1/install-image'];
        for (const k of ['/v1/hosts', '/v1/embedder', '/v1/hosts/r1/ping', '/v1/hosts/r1/install-image']) delete window.__override[k];
        await loadHosts();
      }
    },
    // Apps in agents (docs/apps-in-agents.md): the agent page's App row, and New agent from a repo.
    appRow: async () => {
      const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', NEW = 'f00dfeed1234f00dfeed1234f00dfeed1234f00d';
      const APP = { app: 'demoapp', name: 'Demo App', source: '/home/tester/demoapp', ref: 'HEAD', sha: SHA, previousSha: null,
        installedAt: new Date(Date.now() - 3600e3).toISOString(), testOk: true, tasks: ['demoapp-tick'] };
      try {
        window.__override['/v1/agents/a1/app'] = { app: APP, pending: null, canChange: true };
        v2AppCache = null; // an earlier scenario's opening may have read "no app"
        openV2Agent('a1', 'overview');
        await until(() => byText('#v2AppRow', 'Demo App'));
        const rowText = document.getElementById('v2AppRow').textContent;
        ok('the row says which app, which commit, from where: ' + rowText.replace(/\s+/g, ' ').slice(0, 120), rowText.includes('a1b2c3d4e5f6') && rowText.includes('/home/tester/demoapp') && rowText.includes('its tests passed'));
        // Outlined like the rows around it: it sits in a holder, which the outline rule missed (2026-10-25).
        const outline = (el) => { const cs = getComputedStyle(el); return [cs.borderTopWidth, cs.borderBottomWidth, cs.borderTopStyle, cs.borderRadius, cs.backgroundColor].join(' '); };
        const aiRow = [...document.querySelectorAll('#v2Pane > .v2row')].find(r => r.querySelector('.v2k')?.textContent === 'AI');
        const appOutline = outline(document.querySelector('#v2AppRow > .v2row')), aiOutline = aiRow && outline(aiRow);
        ok('the App row is outlined like the AI row: ' + appOutline, !!aiRow && appOutline === aiOutline && /^1px 1px solid 12px/.test(appOutline));
        ok('Update is the main button', document.getElementById('v2AppUpdateBtn').classList.contains('primary'));
        ok('no Roll back without an earlier release', !byText('#v2AppRow button', 'Roll back'));
        // A failing update: the output shows, the button comes back, nothing changed.
        window.__answer = window.__answer || {};
        // The output only in data.test.output, not the message: shown from e.data (never set until 2026-10-09).
        window.__answer['POST /v1/agents/a1/app/update'] = [{ status: 400, body: { error: 'Its tests failed, so f00dfeed1234 was not switched on.', test: { ok: false, output: 'FAILED (failures=1)' } } }];
        document.getElementById('v2AppUpdateBtn').click();
        await until(() => !document.getElementById('v2AppOut').hidden);
        ok('the test output is on the page', document.getElementById('v2AppOut').textContent.includes('FAILED (failures=1)'));
        ok('and Update can be pressed again', !document.getElementById('v2AppUpdateBtn').disabled);
        // The same commit, with what Hatchabot fills out of date: it says what it refreshed, not "Updated to" (HB-0426).
        window.__answer['POST /v1/agents/a1/app/update'] = [{ status: 200, body: { app: APP, test: null, refreshed: ['telegram_account'] } }];
        document.getElementById('v2AppUpdateBtn').click();
        await until(() => document.getElementById('toast').textContent.includes('up to date again: telegram_account'));
        ok('a refresh is not called a new version', !document.getElementById('toast').textContent.includes('Updated to'));
        await until(() => !document.getElementById('v2AppUpdateBtn').disabled);
        // A good one.
        window.__answer['POST /v1/agents/a1/app/update'] = [{ status: 200, body: { app: { ...APP, sha: NEW, previousSha: SHA } } }];
        window.__override['/v1/agents/a1/app'] = { app: { ...APP, sha: NEW, previousSha: SHA }, pending: null, canChange: true };
        document.getElementById('v2AppUpdateBtn').click();
        await until(() => document.getElementById('toast').textContent.includes('Updated to f00dfeed1234'));
        await until(() => byText('#v2AppRow button', 'Roll back'));
        ok('now Roll back is offered', !!byText('#v2AppRow button', 'Roll back'));
        // A new agent whose install failed: said, with Try again.
        window.__override['/v1/agents/a1/app'] = { app: null, pending: { source: '/home/tester/demoapp', since: new Date().toISOString(), error: 'Needs a value for: mailbox' }, canChange: true };
        v2Close(); v2AppCache = null; openV2Agent('a1', 'overview');
        await until(() => byText('#v2AppRow button', 'Try again'));
        ok('a failed install says why', document.getElementById('v2AppRow').textContent.includes('Needs a value for: mailbox'));
        // No app: the way to add one.
        window.__override['/v1/agents/a1/app'] = { app: null, pending: null, canChange: true };
        v2Close(); v2AppCache = null; openV2Agent('a1', 'overview');
        await until(() => byText('#v2AppRow button', 'Run an app from a repo'));
        // Someone who isn't the machine's owner sees what runs but can't change it.
        window.__override['/v1/agents/a1/app'] = { app: APP, pending: null, canChange: false };
        v2Close(); v2AppCache = null; openV2Agent('a1', 'overview');
        await until(() => byText('#v2AppRow', 'Demo App'));
        ok('no buttons for someone else', !document.querySelector('#v2AppRow button'));
        v2Close();
      } finally {
        delete window.__override['/v1/agents/a1/app'];
        if (window.__answer) delete window.__answer['POST /v1/agents/a1/app/update'];
        if (typeof v2AgentId !== 'undefined' && v2AgentId) v2Close();
      }
    },
    // The icon dialog's ✨ (2026-10-25): ideas to choose from, more on each press, nothing saved until Save.
    iconIdeas: async () => {
      const ideaBtns = () => [...document.querySelectorAll('#v2IconIdeas [data-emoji]')];
      const asks = () => calls('POST', /^\/v1\/agents\/a1\/icons\/suggest$/);
      const ready = () => !document.getElementById('v2IconAutoBtn').disabled;
      window.__answer = window.__answer || {};
      window.__answer['POST /v1/agents/a1/icons/suggest'] = [
        { body: { via: 'ai', ideas: [{ icon: '🪙', color: '#e0a13a' }, { icon: '🔭', color: '#5a7fd6' }, { icon: '🐝', color: '#c9b03a' }] } },
        { body: { via: 'ai', ideas: [{ icon: '🧩', color: '#8a6fd0' }] } },
        { body: { via: 'keywords', why: 'ai-failed', ideas: [] } },
        // HB-0382: a reply with no ideas in it is not a silent AI, and each has its own note.
        { body: { via: 'keywords', why: 'ai-no-ideas', ideas: [{ icon: '🐚', color: '#3a8fd0' }] } },
        { body: { via: 'keywords', why: 'ai-no-ideas', ideas: [] } },
        { body: { via: 'keywords', why: 'no-ai', ideas: [] } },
      ];
      const note = () => document.getElementById('v2IconNote').textContent;
      const mark = window.__calls.length;
      const patches = () => window.__calls.slice(mark).filter((c) => c.method === 'PATCH');
      try {
        openV2Icon('a1');
        const was = document.getElementById('v2IconInput').value;
        ok('no ideas until asked', document.getElementById('v2IconIdeasBox').hidden && !ideaBtns().length);
        document.getElementById('v2IconAutoBtn').click();
        await until(() => ideaBtns().length === 3);
        ok('each idea is drawn on its colour', ideaBtns()[1].style.getPropertyValue('--tint') === '#5a7fd6');
        ok('asking changed nothing: the box still says ' + was, document.getElementById('v2IconInput').value === was && !patches().length);
        ideaBtns()[1].click();
        ok('a pick fills the box and the colour', document.getElementById('v2IconInput').value === '🔭' && v2IconColor === '#5a7fd6');
        ok('and is marked chosen', ideaBtns()[1].getAttribute('aria-pressed') === 'true' && ideaBtns()[0].getAttribute('aria-pressed') === 'false');
        ok('the preview shows it', document.getElementById('v2IconPreview').textContent.includes('🔭'));
        await until(ready);
        ok('the button now asks for more: ' + document.getElementById('v2IconAutoBtn').textContent, document.getElementById('v2IconAutoBtn').textContent.includes('More ideas'));
        document.getElementById('v2IconAutoBtn').click();
        await until(() => ideaBtns().length === 4);
        const shown = asks().at(-1).body.exclude;
        ok('the second ask leaves out what was shown: ' + JSON.stringify(shown), ['🪙', '🔭', '🐝'].every((e) => shown.includes(e)));
        ok('the earlier ideas stay on show', ideaBtns()[0].dataset.emoji === '🪙' && ideaBtns()[3].dataset.emoji === '🧩');
        ok('nothing asked for, nothing sent', !('want' in asks().at(-1).body));
        await until(ready);
        document.getElementById('v2IconWant').value = '  a birthday cake ';
        document.getElementById('v2IconWant').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await until(() => document.getElementById('v2IconNote').textContent.includes('didn’t answer'));
        eq('Enter in the box asks, with the words typed', asks().at(-1).body.want, 'a birthday cake');
        ok('without the AI it says so, and keeps what it had', ideaBtns().length === 4);
        ok('and says an emoji can be pasted', document.getElementById('v2IconNote').textContent.includes('paste any emoji'));
        ok('still nothing saved', !patches().length);
        await until(ready);
        document.getElementById('v2IconAutoBtn').click();
        await until(() => note().includes('no ideas could be read'));
        ok('an answer with no ideas says it answered, not that it did not: ' + note(), !note().includes('didn’t answer'));
        ok('with stand-ins, it says where they came from', note().includes('your words and its name') && note().includes('paste any emoji') && ideaBtns().length === 5);
        await until(ready);
        document.getElementById('v2IconWant').value = '';
        document.getElementById('v2IconAutoBtn').click();
        await until(() => asks().length === 5);
        await until(ready);
        ok('with none, it still says it could not read them: ' + note(), note().includes('no ideas could be read') && !note().includes('these come from') && note().includes('paste any emoji'));
        document.getElementById('v2IconAutoBtn').click();
        await until(() => note().includes('None of your AI sources'));
        ok('no source says so: ' + note(), note().includes('paste any emoji') && !note().includes('management AI'));
        await until(ready);
        document.getElementById('v2IconSaveBtn').click();
        const patch = await until(() => patches().find((c) => c.path === '/v1/agents/a1'));
        eq('Save sends the pick', { icon: patch.body.icon, iconColor: patch.body.iconColor }, { icon: '🔭', iconColor: '#5a7fd6' });
        await until(() => !v2IconDlg.open);
        openV2Icon('a1');
        ok('opened again, it starts without ideas or words', document.getElementById('v2IconIdeasBox').hidden && !ideaBtns().length && !document.getElementById('v2IconNote').textContent && !document.getElementById('v2IconWant').value);
        v2IconDlg.close();
      } finally {
        if (window.__answer) delete window.__answer['POST /v1/agents/a1/icons/suggest'];
        if (v2IconDlg.open) v2IconDlg.close();
      }
    },
    // Final audit, 2026-10-22: an update that needs a value it has not got
    // (a field an older version left blank) asks for it here, since Update sends none.
    appUpdateAsksValues: async () => {
      const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', NEW = 'f00dfeed1234f00dfeed1234f00dfeed1234f00d';
      const APP = { app: 'demoapp', name: 'Demo App', source: '/home/tester/demoapp', ref: 'HEAD', sha: SHA, previousSha: null,
        installedAt: new Date(Date.now() - 3600e3).toISOString(), testOk: true, tasks: ['demoapp-tick'] };
      try {
        window.__override['/v1/agents/a1/app'] = { app: APP, pending: null, canChange: true };
        v2AppCache = null;
        openV2Agent('a1', 'overview');
        await until(() => byText('#v2AppRow', 'Demo App') && document.getElementById('v2AppUpdateBtn'));
        window.__answer = window.__answer || {};
        window.__answer['POST /v1/agents/a1/app/update'] = [
          { status: 400, body: { error: 'Needs a value for: mailbox (its address) (give them as key=value).', needs: [{ key: 'mailbox', label: 'its address', type: 'email' }], unchanged: true } },
          { status: 200, body: { app: { ...APP, sha: NEW, previousSha: SHA } } },
        ];
        const posts = () => window.__calls.filter((c) => c.method === 'POST' && c.path === '/v1/agents/a1/app/update');
        const before = posts().length;
        document.getElementById('v2AppUpdateBtn').click();
        await until(() => document.getElementById('v2AppV_mailbox'));
        const out = document.getElementById('v2AppOut').textContent;
        ok('it asks for the value, in words for the page: ' + out.replace(/\\s+/g, ' ').slice(0, 100), !out.includes('key=value') && out.includes('mailbox'));
        document.getElementById('v2AppUpdateWithBtn').click();
        ok('left blank, it says so and sends nothing', document.getElementById('v2AppValErr').textContent.includes('mailbox')
          && posts().length === before + 1);
        document.getElementById('v2AppV_mailbox').value = 'you@example.com';
        window.__override['/v1/agents/a1/app'] = { app: { ...APP, sha: NEW, previousSha: SHA }, pending: null, canChange: true };
        document.getElementById('v2AppUpdateWithBtn').click();
        await until(() => document.getElementById('toast').textContent.includes('Updated to f00dfeed1234'));
        const sent = posts().at(-1);
        ok('the update went with the value', sent?.body?.values?.mailbox === 'you@example.com');
        v2Close();
      } finally {
        delete window.__override['/v1/agents/a1/app'];
        if (window.__answer) delete window.__answer['POST /v1/agents/a1/app/update'];
        if (typeof v2AgentId !== 'undefined' && v2AgentId) v2Close();
      }
    },
    // Audit 2026-10-23, B20: the re-read after an action fails: the row says so, with a way to read again,
    // instead of keeping a pressed, disabled Updating button.
    appRowReadFails: async () => {
      const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
      const APP = { app: 'demoapp', name: 'Demo App', source: '/home/tester/demoapp', ref: 'HEAD', sha: SHA, previousSha: null,
        installedAt: new Date(Date.now() - 3600e3).toISOString(), testOk: true, tasks: ['demoapp-tick'] };
      try {
        window.__override['/v1/agents/a1/app'] = { app: APP, pending: null, canChange: true };
        v2AppCache = null;
        openV2Agent('a1', 'overview');
        await until(() => document.getElementById('v2AppUpdateBtn'));
        window.__answer = window.__answer || {};
        window.__answer['POST /v1/agents/a1/app/update'] = [{ status: 200, body: { unchanged: true, app: APP } }];
        window.__answer['GET /v1/agents/a1/app'] = [{ status: 500, body: { error: 'The machine is restarting.' } }];
        document.getElementById('v2AppUpdateBtn').click();
        await until(() => byText('#v2AppRow', "Couldn't read its app"));
        ok('it says why: ' + document.getElementById('v2AppRow').textContent.replace(/\s+/g, ' ').trim(), document.getElementById('v2AppRow').textContent.includes('The machine is restarting.'));
        ok('no disabled button is left', ![...document.querySelectorAll('#v2AppRow button')].some((b) => b.disabled));
        byText('#v2AppRow button', 'Read again').click();
        await until(() => document.getElementById('v2AppUpdateBtn') && !document.getElementById('v2AppUpdateBtn').disabled);
        ok('Read again shows the row', byText('#v2AppRow', 'Demo App'));
        v2Close();
      } finally {
        delete window.__override['/v1/agents/a1/app'];
        if (window.__answer) { delete window.__answer['POST /v1/agents/a1/app/update']; delete window.__answer['GET /v1/agents/a1/app']; }
        if (typeof v2AgentId !== 'undefined' && v2AgentId) v2Close();
      }
    },
    // Audit 2026-10-23, B20: the attach picker is emptied before the accounts are read, so a failed
    // read cannot leave the previous agent's accounts selectable.
    attachPickerNotStale: async () => {
      const was = editAgentId;
      try {
        const pick = document.getElementById('connAttachPick');
        pick.innerHTML = '<option value="old">someone@example.org</option>';
        document.getElementById('connAttachBtn').disabled = false;
        editAgentId = 'a1';
        window.__answer = window.__answer || {};
        window.__answer['GET /v1/connections'] = [{ status: 500, body: { error: 'Something failed.' } }];
        await renderConnections();
        await until(() => pick.textContent.includes('could not read your accounts'));
        ok('the old list is gone', !pick.textContent.includes('someone@example.org') && pick.value === '');
        ok('Attach is off', document.getElementById('connAttachBtn').disabled);
      } finally {
        editAgentId = was;
        if (window.__answer) delete window.__answer['GET /v1/connections'];
      }
    },
    // Audit 2026-10-23, B20: with the phone keyboard up, a dialog fits the part of the screen above it.
    keyboardFitsDialogs: async () => {
      try {
        openSendAgent('a1', 'Homework Helper');
        const fake = { height: 300, offsetTop: 40, scale: 1 };
        fitVisualViewport(fake, true);
        ok('the page knows the keyboard is up', document.documentElement.classList.contains('kbd'));
        const r = sendAgentDlg.getBoundingClientRect();
        ok('a panel fits above it: top ' + Math.round(r.top) + ', bottom ' + Math.round(r.bottom), Math.round(r.top) === 40 && r.bottom <= 340 + 1);
        // A plain dialog (the console's kind) sits at the top of what is visible, and scrolls when taller.
        const plain = document.createElement('dialog');
        plain.innerHTML = '<div style="height:900px">Tall</div>';
        document.body.append(plain);
        plain.showModal();
        const p = plain.getBoundingClientRect();
        plain.close(); plain.remove();
        ok('a plain dialog fits above it: top ' + Math.round(p.top) + ', bottom ' + Math.round(p.bottom), Math.round(p.top) === 48 && p.bottom <= 340 + 1);
        // Zoomed in is not the keyboard.
        fitVisualViewport({ ...fake, scale: 2 });
        ok('zoomed in: no keyboard', !document.documentElement.classList.contains('kbd'));
        fitVisualViewport();
        ok('keyboard down: as before', !document.documentElement.classList.contains('kbd'));
        // Touch screens get controls of at least 24 px (a mouse keeps the compact look).
        const rules = [...document.styleSheets].flatMap((sh) => [...sh.cssRules]).filter((x) => x.conditionText && x.conditionText.includes('pointer: coarse'));
        const text = rules.map((x) => x.cssText).join(' ');
        ok('a touch rule sizes the small controls: ' + text.slice(0, 120), ['.v2gtools button', '.ordbtn', '.v2planx', '.ctabx'].every((sel) => text.includes(sel)) && text.includes('min-height: 24px'));
      } finally {
        fitVisualViewport();
        if (sendAgentDlg.open) sendAgentDlg.close();
      }
    },
    appFromRepo: async () => {
      const MAN = { app: 'demoapp', name: 'Demo App', description: 'A made-up app.', model: 'claude-haiku-4-5', chat: 'Run the demo commands.',
        tasks: [{ name: 'tick', every: '1m', command: ['python3', '-m', 'demo', 'tick'] }], test: ['python3', '-m', 'unittest'],
        config: { fields: [] }, connections: [{ kind: 'google', purpose: 'its mailbox', field: 'mailbox' }] };
      try {
        window.__answer = window.__answer || {};
        window.__answer['POST /v1/apps/inspect'] = [{ status: 200, body: { sha: 'c0ffee0123456789c0ffee0123456789c0ffee01', manifest: MAN,
          ask: [{ key: 'mailbox', label: 'its address', type: 'email', required: true }, { key: 'mode', default: 'shadow' }], connections: MAN.connections } }];
        window.__answer['POST /v1/agents'] = [{ status: 200, body: { id: 'newapp1', name: 'Demo App', state: 'PROVISIONING' } }];
        window.__answer['POST /v1/agents/newapp1/model'] = [{ status: 200, body: { model: 'claude-haiku-4-5' } }];
        window.__answer['POST /v1/agents/newapp1/app/pending'] = [{ status: 200, body: { pending: true, app: 'demoapp', name: 'Demo App' } }];
        window.__override['/v1/connections'] = { connections: [
          { id: 'c1', kind: 'google', email: 'demo@example.org', attachedTo: [{ id: 'old1', name: 'Old Demo', state: 'RUNNING', app: 'demoapp' }] },
          { id: 'c2', kind: 'google', email: 'other@example.org', attachedTo: [] }] };
        document.getElementById('fabBtn').onclick();
        await until(() => createDlg.open);
        ok('the machine owner sees "run an app from a repo"', !document.getElementById('createFromRepo').hidden);
        createDlg.close();
        openAppDlg('create');
        document.getElementById('appSource').value = '~/demoapp';
        await appRead();
        ok('it shows the app', document.getElementById('appInfo').textContent.includes('Demo App'));
        ok('and asks which Google account', !!document.getElementById('appConn') && document.getElementById('appConn').options.length === 3);
        eq('the name is the app\'s', document.getElementById('appName').value, 'Demo App');
        eq('a field has its default', document.getElementById('appF_mode').value, 'shadow');
        const mark = window.__calls.length;
        await appGo();
        ok('a required field stops it', document.getElementById('appErr').textContent.includes('mailbox') && window.__calls.length === mark);
        // Picking the account fills the mailbox, and says another agent already runs this app on it.
        document.getElementById('appConn').value = 'c1';
        appConnPicked();
        eq('the mailbox follows the account', document.getElementById('appF_mailbox').value, 'demo@example.org');
        // Another pick moves it again: picking B after A once left A's address in the mailbox.
        document.getElementById('appConn').value = 'c2'; appConnPicked();
        eq('a second pick replaces the mailbox', document.getElementById('appF_mailbox').value, 'other@example.org');
        document.getElementById('appConn').value = 'c1'; appConnPicked();
        eq('and back', document.getElementById('appF_mailbox').value, 'demo@example.org');
        // A mailbox typed after the pick that names another address stops the install.
        document.getElementById('appF_mailbox').value = 'typed@example.org';
        const markMis = window.__calls.length;
        await appGo();
        ok('a mailbox and account that differ stop it: ' + document.getElementById('appErr').textContent,
          document.getElementById('appErr').textContent.includes('the Google account picked is demo@example.org') && window.__calls.length === markMis);
        document.getElementById('appF_mailbox').value = 'demo@example.org';
        const warn = document.getElementById('appConnWarn');
        ok('a warning names the other copy: ' + warn.textContent, !warn.hidden && warn.textContent.includes('Old Demo already runs Demo App'));
        window.__confirms.length = 0;
        await appGo();
        ok('it asked before going on', window.__confirms.some((t) => t.includes('Both would answer every email')));
        const posts = window.__calls.slice(mark).filter((c) => c.method === 'POST').map((c) => c.path);
        eq('create, its model, its account, then the install when ready', posts, ['/v1/agents', '/v1/agents/newapp1/model', '/v1/agents/newapp1/connections/attach', '/v1/agents/newapp1/app/pending']);
        eq('the account attached', window.__calls.slice(mark).find((c) => c.path === '/v1/agents/newapp1/connections/attach').body, { connectionId: 'c1' });
        const pend = window.__calls.slice(mark).find((c) => c.path === '/v1/agents/newapp1/app/pending');
        eq('with the source, the values and the confirmation', pend.body, { source: '~/demoapp', values: { mailbox: 'demo@example.org', mode: 'shadow' }, allowShared: true });
        ok('and the dialog closed', !appDlg.open);
        // A later step fails: the half-made agent is removed, so Create again
        // does not meet "name taken"; the tests' output shows (review, 2026-10-09).
        window.__answer['POST /v1/apps/inspect'] = [{ status: 200, body: { sha: 'c0ffee0123456789c0ffee0123456789c0ffee01', manifest: { ...MAN, model: undefined },
          ask: [{ key: 'mailbox', label: 'its address', type: 'email', required: true }], connections: MAN.connections } }];
        window.__answer['POST /v1/agents'] = [{ status: 200, body: { id: 'newapp2', name: 'Demo App', state: 'PROVISIONING' } }];
        window.__answer['POST /v1/agents/newapp2/app/pending'] = [{ status: 400, body: { error: 'Its tests failed.', test: { ok: false, output: 'made-up test output: 1 failed' } } }];
        openAppDlg('create');
        document.getElementById('appSource').value = '~/demoapp';
        await appRead();
        document.getElementById('appConn').value = 'c2'; appConnPicked();
        const mark2 = window.__calls.length;
        await appGo();
        ok('the failure is said: ' + document.getElementById('appErr').textContent, document.getElementById('appErr').textContent.includes('Its tests failed'));
        ok('with the tests\' output', !document.getElementById('appOut').hidden && document.getElementById('appOut').textContent.includes('made-up test output'));
        ok('the half-made agent is deleted', window.__calls.slice(mark2).some((c) => c.method === 'DELETE' && c.path === '/v1/agents/newapp2'));
        ok('the dialog stays open to try again', appDlg.open);
      } finally {
        for (const k of ['POST /v1/apps/inspect', 'POST /v1/agents', 'POST /v1/agents/newapp1/model', 'POST /v1/agents/newapp1/app/pending', 'POST /v1/agents/newapp2/app/pending']) if (window.__answer) delete window.__answer[k];
        delete window.__override['/v1/connections'];
        if (appDlg.open) appDlg.close();
        if (createDlg.open) createDlg.close();
        await refresh(false);
      }
    },
    // Saving a different Google OAuth client breaks the connections the old one made: it asks first, naming how many.
    googleClientChange: async () => {
      const msg = '1 Google connection was made with a different OAuth client. With this one, it stops working until each account is connected again.';
      try {
        window.__override['/v1/google-oauth/client'] = { configured: false, redirectUri: 'https://hatchabot.example.org/v1/connections/google/callback' };
        window.__override['/v1/connections'] = { connections: [{ id: 'c1', kind: 'google', email: 'mara@example.org', services: ['gmail'], createdAt: '2026-10-01T00:00:00Z', attachedTo: [], needsReconnect: true }] };
        await loadConnections();
        ok('a connection from the old client says to connect it again', !!document.querySelector('#connVault .conn-reconnect') && document.getElementById('connVault').textContent.includes('earlier OAuth client'));
        document.getElementById('connClientId').value = 'new-cid.apps.example.org';
        document.getElementById('connClientSecret').value = 'FAKE-FIXTURE-VALUE';
        window.__answer = window.__answer || {};
        window.__answer['PUT /v1/google-oauth/client'] = [{ status: 409, body: { error: msg, code: 'google_client_change', reconnect: 1 } }];
        window.__confirms.length = 0; window.__confirmAnswer = false;
        let mark = window.__calls.length;
        await saveOAuthClient();
        ok('it asked, naming how many: ' + window.__confirms.at(-1), (window.__confirms.at(-1) || '').includes('1 Google connection'));
        eq('declined: one PUT, nothing more', window.__calls.slice(mark).filter((c) => c.method === 'PUT').length, 1);
        window.__answer['PUT /v1/google-oauth/client'] = [{ status: 409, body: { error: msg, code: 'google_client_change', reconnect: 1 } }, { status: 200, body: { configured: true, clientId: 'new-cid.apps.example.org', reconnect: 1 } }];
        window.__confirmAnswer = true;
        mark = window.__calls.length;
        await saveOAuthClient();
        const puts = window.__calls.slice(mark).filter((c) => c.method === 'PUT');
        eq('confirmed: asked again with confirm', puts.map((c) => c.body.confirm ?? null), [null, true]);
        ok('the toast says how many to reconnect: ' + document.getElementById('toast').textContent, document.getElementById('toast').textContent.includes('1 connection must be connected again'));
        // A new secret for the same client: the toast says who gets it, and an agent still on the old one is not a check mark (HB-0427).
        window.__override['/v1/connections'] = { connections: [{ id: 'c1', kind: 'google', email: 'mara@example.org', services: ['gmail'], createdAt: '2026-10-01T00:00:00Z', secretPendingCount: 1, needsReconnect: false,
          attachedTo: [{ id: 'a1', name: 'Mailer', state: 'STOPPED', attachedAt: '2026-10-01T00:00:00Z', materializedAt: '2026-10-02T00:00:00Z', stale: false, secretPending: true },
            { id: 'a2', name: 'Letters', state: 'RUNNING', attachedAt: '2026-10-01T00:00:00Z', materializedAt: '2026-10-03T00:00:00Z', stale: false, secretPending: false }] }] };
        await loadConnections();
        document.getElementById('connClientId').value = 'new-cid.apps.example.org';
        document.getElementById('connClientSecret').value = 'FAKE-FIXTURE-VALUE';
        window.__answer['PUT /v1/google-oauth/client'] = [{ status: 200, body: { configured: true, clientId: 'new-cid.apps.example.org', reconnect: 0, pushing: 1, waiting: 1 } }];
        await saveOAuthClient();
        const savedToast = document.getElementById('toast').textContent;
        ok('the toast says who gets the new secret: ' + savedToast, savedToast.includes('going to 1 running agent') && savedToast.includes('1 other gets it at the next start'));
        const vault = document.getElementById('connVault').textContent;
        ok('the account says one is waiting', vault.includes('1 waiting for the new secret'));
        const rowOf = (name) => [...document.querySelectorAll('#connVault .sub')].find((d) => d.textContent.includes(name) && d.textContent.includes('token pulled'));
        ok('the agent on the old secret is marked', rowOf('Mailer').textContent.includes('⚠') && rowOf('Mailer').textContent.includes('still has the old client secret'));
        ok('the agent that has it keeps its check mark', rowOf('Letters').textContent.includes('✓') && !rowOf('Letters').textContent.includes('old client secret'));
      } finally {
        window.__confirmAnswer = true;
        if (window.__answer) delete window.__answer['PUT /v1/google-oauth/client'];
        delete window.__override['/v1/google-oauth/client'];
        delete window.__override['/v1/connections'];
      }
    },
    // An agent's Disconnect goes to the server, which detaches a platform account (it used to
    // pick the raw remove when /v1/connections failed, and the next rebuild imported it again).
    disconnectGoogleAccount: async () => {
      const prev = editAgentId;
      const key = 'DELETE /v1/agents/a1/connections/mara%40example.org';
      try {
        editAgentId = 'a1';
        window.__override['/v1/agents/a1/connections'] = { accounts: [] };
        window.__answer = window.__answer || {};
        window.__answer[key] = [{ status: 200, body: { removed: false, detached: true } }];
        window.__confirmAnswer = true;
        const mark = window.__calls.length;
        await disconnectAccount('mara@example.org');
        const sent = window.__calls.slice(mark).filter((c) => c.method !== 'GET').map((c) => c.method + ' ' + c.path);
        eq('one request: the server decides', sent, [key]);
        ok('a deferred removal is said: ' + document.getElementById('toast').textContent, document.getElementById('toast').textContent.includes('retried at its next start'));
      } finally {
        editAgentId = prev;
        if (window.__answer) delete window.__answer[key];
        delete window.__override['/v1/agents/a1/connections'];
      }
    },
    // Removing a repo source says to delete its deploy key on the repo's host too, and when the key is still on the agent.
    removeRepoSource: async () => {
      const prev = editAgentId, prevData = editData;
      const key = 'DELETE /v1/agents/a1/data-sources/ds1';
      try {
        editAgentId = 'a1';
        editData = [{ id: 'ds1', kind: 'git', mountName: 'recipes', access: 'ro', repoUrl: 'git@example.org:example-owner/recipes.git' }];
        window.__answer = window.__answer || {};
        const gone = { repo: 'git@example.org:example-owner/recipes.git', scrubbed: false };
        window.__answer[key] = [{ status: 200, body: { dataSources: [], removedRepo: gone, removedKey: gone } }];
        window.__confirmAnswer = true;
        const asked = window.__confirms.length;
        await removeDataSource('ds1');
        const q = window.__confirms[asked] || '';
        ok('it asks first, saying the clone goes with what was not pushed (HB-0002): ' + q, q.includes('~/.openclaw/recipes') && q.includes('not pushed') && q.includes('deploy key'));
        const said = document.getElementById('toast').textContent;
        ok('it says to delete the key on the host: ' + said, said.includes('Deploy keys'));
        ok('and that taking it off the agent is retried', said.includes('at its next start'));
        // A public repo: no key to mention, and it went at once.
        editData = [{ id: 'ds1', kind: 'git', mountName: 'recipes', access: 'ro', repoUrl: 'https://example.org/example-owner/recipes.git' }];
        window.__answer[key] = [{ status: 200, body: { dataSources: [], removedRepo: { repo: 'https://example.org/example-owner/recipes.git', scrubbed: true } } }];
        const asked2 = window.__confirms.length;
        await removeDataSource('ds1');
        const q2 = window.__confirms[asked2] || '';
        ok('a public repo: the copy goes, no deploy key named: ' + q2, q2.includes('is deleted') && !q2.includes('deploy key'));
        const said2 = document.getElementById('toast').textContent;
        // No sheet open here, so the agent is named (agentPrefix).
        ok('and no rebuild asked for: ' + said2, said2.startsWith('Homework Helper: Removed, with its copy') && !said2.includes('Rebuild'));
      } finally {
        editAgentId = prev; editData = prevData;
        if (window.__answer) delete window.__answer[key];
      }
    },
    // A manifest field marked secret (an app password) was a plain text box (2026-10-10).
    appSecretField: async () => {
      const MAN = { app: 'demoapp', name: 'Demo App', tasks: [], config: { fields: [] }, connections: [] };
      const inspect = () => [{ status: 200, body: { sha: 'c0ffee0123456789c0ffee0123456789c0ffee01', manifest: MAN, connections: [],
        ask: [{ key: 'mailbox', type: 'email', required: true }, { key: 'app_password', label: 'the mailbox app password', required: true, secret: true, default: 'made-up-default' }] } }];
      const open = async () => {
        window.__answer['POST /v1/apps/inspect'] = inspect();
        openAppDlg('install', 'a1');
        document.getElementById('appSource').value = '~/demoapp';
        await appRead();
        document.getElementById('appF_mailbox').value = 'demo@example.org';
      };
      const sent = (mark) => window.__calls.slice(mark).find((c) => c.method === 'POST' && c.path === '/v1/agents/a1/app');
      try {
        window.__answer = window.__answer || {};
        await open();
        const pw = document.getElementById('appF_app_password');
        ok('a secret field is a hidden box the browser does not autofill', pw.type === 'password' && pw.getAttribute('autocomplete') === 'new-password');
        eq('never filled in, not even with its default', pw.value, '');
        pw.value = ' made-up-secret ';
        let mark = window.__calls.length;
        await appGo();
        eq('it is sent as typed', sent(mark)?.body.values, { mailbox: 'demo@example.org', app_password: ' made-up-secret ' });
        await open();
        mark = window.__calls.length;
        await appGo();
        eq('left blank, it is not sent: the app keeps the one it has, or its default', sent(mark)?.body.values, { mailbox: 'demo@example.org' });
      } finally {
        if (window.__answer) delete window.__answer['POST /v1/apps/inspect'];
        if (appDlg.open) appDlg.close();
        await refresh(false);
      }
    },
    // The App form (app audit, 2026-10-27): the default AI source, the chat filled in, an account that failed to attach.
    appFormChecks: async () => {
      const MAN = { app: 'demoapp', name: 'Demo App', chat: 'Run cd {app_dir} for {agent}.', tasks: [], config: { fields: [] }, connections: [{ kind: 'google', purpose: 'its mailbox', field: 'mailbox' }] };
      const read = { status: 200, body: { sha: 'c0ffee0123456789c0ffee0123456789c0ffee01', manifest: MAN, connections: MAN.connections, ask: [{ key: 'mailbox', type: 'email', required: true }] } };
      const FILLED = 'Run cd /home/node/.openclaw/apps/demoapp/current for garden-helper.';
      const keys = ['POST /v1/apps/inspect', 'POST /v1/agents', 'POST /v1/agents/newapp3/connections/attach', 'POST /v1/agents/newapp3/app/pending', 'POST /v1/agents/a1/connections/attach'];
      const prevProfiles = profiles;
      try {
        window.__answer = window.__answer || {};
        window.__override['/v1/connections'] = { connections: [{ id: 'c2', kind: 'google', email: 'other@example.org', attachedTo: [] }] };
        // The default source moved below another: it is still the one picked (HB-0258).
        profiles = [{ id: 'pay', name: 'API key', vendor: 'anthropic', defaultSource: false }, { id: 'plan', name: 'Plan', vendor: 'anthropic', defaultSource: true }];
        window.__answer['POST /v1/apps/inspect'] = [read, { status: 200, body: { ...read.body, chat: FILLED } }];
        window.__answer['POST /v1/agents'] = [{ status: 200, body: { id: 'newapp3', name: 'Garden Helper', state: 'PROVISIONING' } }];
        window.__answer['POST /v1/agents/newapp3/connections/attach'] = [{ status: 200, body: { attached: true, live: false } }];
        window.__answer['POST /v1/agents/newapp3/app/pending'] = [{ status: 200, body: { pending: true, app: 'demoapp', name: 'Demo App' } }];
        openAppDlg('create');
        document.getElementById('appSource').value = '~/demoapp';
        await appRead();
        eq('the default AI source is picked', document.getElementById('appProfile').value, 'plan');
        document.getElementById('appName').value = 'Garden Helper';
        document.getElementById('appConn').value = 'c2'; appConnPicked();
        let mark = window.__calls.length;
        await appGo();
        let sent = window.__calls.slice(mark);
        const look = sent.find((c) => c.path === '/v1/apps/inspect');
        eq('its chat is asked for, for this name', look && look.body, { source: '~/demoapp', name: 'Garden Helper' });
        const made = sent.find((c) => c.method === 'POST' && c.path === '/v1/agents');
        eq('the new agent gets the default source', made && made.body.aiProfileId, 'plan');
        eq('and the chat filled in (HB-0259)', made && made.body.persona, FILLED);
        ok('a new agent: an account not live yet is fine', sent.some((c) => c.path === '/v1/agents/newapp3/app/pending') && !appDlg.open);
        // Into a running agent: the account went on but could not be set up in it. Nothing is installed (HB-0257).
        window.__answer['POST /v1/apps/inspect'] = [read];
        window.__answer['POST /v1/agents/a1/connections/attach'] = [{ status: 200, body: { attached: true, live: false, error: 'made-up import failure' } }];
        openAppDlg('install', 'a1');
        document.getElementById('appSource').value = '~/demoapp';
        await appRead();
        document.getElementById('appConn').value = 'c2'; appConnPicked();
        mark = window.__calls.length;
        await appGo();
        sent = window.__calls.slice(mark);
        const err = document.getElementById('appErr').textContent;
        ok('it says the account failed, and why: ' + err, err.includes('other@example.org is attached, but could not be set up') && err.includes('made-up import failure'));
        ok('the account was attached', sent.some((c) => c.path === '/v1/agents/a1/connections/attach'));
        ok('nothing was installed', !sent.some((c) => c.path === '/v1/agents/a1/app'));
        ok('the dialog stays open to try again', appDlg.open);
        ok('it never says it is running: ' + document.getElementById('toast').textContent, !document.getElementById('toast').textContent.includes('installed and running'));
      } finally {
        profiles = prevProfiles;
        for (const k of keys) if (window.__answer) delete window.__answer[k];
        delete window.__override['/v1/connections'];
        if (appDlg.open) appDlg.close();
        await refresh(false);
      }
    },
    // Workflow audit, 2026-10-10: what an update says it did (#97 #121), and a second read that fails (#96).
    appUpdateSays: async () => {
      const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', NEW = 'f00dfeed1234f00dfeed1234f00dfeed1234f00d';
      const APP = { app: 'demoapp', name: 'Demo App', source: '/home/tester/demoapp', ref: 'HEAD', sha: SHA, previousSha: null,
        installedAt: new Date(Date.now() - 3600e3).toISOString(), testOk: null, tasks: ['demoapp-tick'] };
      const toastSays = () => document.getElementById('toast').textContent;
      const press = async (answer, until_) => {
        window.__answer['POST /v1/agents/a1/app/update'] = [answer];
        v2AppCache = null; v2Close(); openV2Agent('a1', 'overview');
        await until(() => document.getElementById('v2AppUpdateBtn') && !document.getElementById('v2AppUpdateBtn').disabled);
        document.getElementById('toast').textContent = '';
        document.getElementById('v2AppUpdateBtn').click();
        await until(until_);
        return toastSays();
      };
      try {
        window.__answer = window.__answer || {};
        window.__override['/v1/agents/a1/app'] = { app: APP, pending: null, canChange: true };
        // A release with no tests: it says so, never that they passed.
        let said = await press({ status: 200, body: { app: { ...APP, sha: NEW }, test: null } }, () => toastSays().includes('Updated to f00dfeed1234'));
        ok('no tests: not "its tests passed": ' + said, !said.includes('tests passed') && said.includes('no tests'));
        said = await press({ status: 200, body: { app: { ...APP, sha: NEW }, test: { ok: true, output: 'OK' } } }, () => toastSays().includes('Updated to f00dfeed1234'));
        ok('tests that ran and passed: said: ' + said, said.includes('its tests passed'));
        // Failures: "unchanged" only when the server says so.
        said = await press({ status: 400, body: { error: 'Its tests failed, so f00dfeed1234 was not switched on.', unchanged: true } }, () => toastSays().startsWith('Not updated'));
        ok('nothing changed, said by the server: unchanged: ' + said, said.includes('the running version is unchanged'));
        said = await press({ status: 400, body: { error: 'Could not schedule demoapp-tick. Putting a1b2c3d4e5f6 back failed too (no output). It waits for your choice on its page.', unchanged: false, held: true } }, () => toastSays().startsWith('Not updated'));
        ok('put-back failed: never "unchanged", and where to choose: ' + said, !said.includes('unchanged') && said.includes('could not be put back'));
        ok('and the message is on the page', document.getElementById('v2AppOut').textContent.includes('back failed too'));
        said = await press({ status: 400, body: { error: 'Could not schedule demoapp-tick. Its scheduled tasks could not be confirmed: the list could not be read.', unchanged: false } }, () => toastSays().startsWith('Not updated'));
        ok('tasks not confirmed: not "unchanged" either: ' + said, !said.includes('unchanged') && said.includes('may not be as it was'));
        v2Close();
        // The dialog: a second read that fails forgets the first, so Install cannot install it.
        const MAN = { app: 'demoapp', name: 'Demo App', tasks: [], config: { fields: [] }, connections: [] };
        window.__answer['POST /v1/apps/inspect'] = [
          { status: 200, body: { sha: SHA, manifest: MAN, connections: [], ask: [{ key: 'mode', default: 'shadow' }] } },
          { status: 400, body: { error: 'No folder at /home/tester/otherapp.' } }];
        openAppDlg('install', 'a1');
        document.getElementById('appSource').value = '~/demoapp';
        await appRead();
        ok('the first read offers Install', !document.getElementById('appGoBtn').disabled && !!document.getElementById('appF_mode'));
        document.getElementById('appSource').value = '~/otherapp';
        await appRead();
        ok('a failed second read: Install is off, the first repo forgotten', document.getElementById('appGoBtn').disabled && appInspected === null);
        ok('and its form is gone', !document.getElementById('appF_mode'));
        eq('the error says why', document.getElementById('appErr').textContent, 'No folder at /home/tester/otherapp.');
      } finally {
        delete window.__override['/v1/agents/a1/app'];
        if (window.__answer) { delete window.__answer['POST /v1/agents/a1/app/update']; delete window.__answer['POST /v1/apps/inspect']; }
        if (appDlg.open) appDlg.close();
        if (typeof v2AgentId !== 'undefined' && v2AgentId) v2Close();
      }
    },
    // The tooltip's three parts (2026-10-07): doing / cost and spending alarm / runtime (version, uptime, restarts).
    tooltipParts: async () => {
      const month = new Date().toISOString().slice(0, 7);
      try {
        await costFixture();
        await withAgents((a) => a.name === 'Meal Planner' ? { ...a, state: 'RUNNING', persona: 'Plans the week of meals for a family of four', openclawVersion: '2026.9.6',
            model: 'claude-sonnet-5', updateAvailable: true, startedAt: new Date(Date.now() - (3 * 60 + 12) * 60e3 - 20e3).toISOString(), restarts: 1, lastExitCode: 135,
            spendStep: { every: 50, month, spent: 12, passed: 0, next: 50 } }
          : a.name === 'Tax Filing' ? { ...a, state: 'RUNNING', openclawVersion: '2026.9.6', startedAt: new Date(Date.now() - 3 * 86400e3).toISOString(),
            spendStep: { every: 20, month, spent: 0, passed: 0, next: 20 } } : undefined);
        const tip = tipText('Meal Planner');
        ok('its cost: ' + tip, tip.includes('at API prices'));
        ok('its spending alarm', tip.includes('🔔 Alarm every $50 · next at $50'));
        ok('its model and uptime on one line', tip.includes('claude-sonnet-5 · up 3 h 12 min'));
        ok('OpenClaw version and update', tip.includes('OpenClaw 2026.9.6 · update ready'));
        ok('the restart and how it ended', tip.includes('Restarted by itself once since rebuild (last: a memory fault)'));
        ok('no persona any more', !tip.includes('Plans the week'));
        v2ShowTip(tile('Meal Planner'));
        const parts = [...document.querySelectorAll('#v2Tip .v2tipsec')].map((s) => s.classList.contains('v2tipcost') ? 'cost' : 'runtime');
        document.getElementById('v2Tip').hidden = true;
        eq('two parts, cost first', parts, ['cost', 'runtime']);
        const tax = tipText('Tax Filing');
        ok('the alarm shows without use in the window: ' + tax, tax.includes('🔔 Alarm every $20'));
        ok('days of uptime', /up 3 days/i.test(tax));
        ok('no restart line when it never restarted', !tax.includes('Restarted'));
      } finally { await costCleanup(); await agentsCleanup(); }
    },
    // Chris, 2026-11-09: the tooltip was so big it was hard to drag an icon to another group. Pushed up
    // to fit, it covered the icon and the groups around it, and it stayed up while the icon was pressed.
    tooltipCompact: async () => {
      const tip = document.getElementById('v2Tip');
      const mins = (m) => new Date(Date.now() - m * 60000).toISOString();
      const recent = v2Recent, pad = document.body.style.paddingBottom;
      const overlaps = (a, b) => a.top < b.bottom && a.bottom > b.top && a.left < b.right && a.right > b.left;
      try {
        await withAgents((a) => a.name === 'Meal Planner' ? { ...a, state: 'RUNNING', openclawVersion: '2026.9.8', model: 'claude-sonnet-5', updateAvailable: true,
            startedAt: mins(200), restarts: 3, lastExitCode: 137,
            // Five reasons of different kinds (each kind is one reason).
            stuck: [{ id: 'ti_1', kind: 'channel-retry', text: 'Stuck: Telegram message retried 6 times since 08:19' }], pendingAction: { type: 'bot_token' },
            botNamePending: { name: 'Meals' }, memoryCapHits: 3, imageTrial: true, image: 'hatchabot-runtime:trial' } : undefined);
        const meal = agents.find((a) => a.name === 'Meal Planner');
        const why = v2Status(meal).why.length;
        v2ShowTip(tile('Meal Planner'));
        const items = [...tip.querySelectorAll('li')].map((li) => li.textContent);
        ok('more than three reasons to show: ' + why, why > 3);
        eq('three reasons, then how many more', items.length, 4);
        eq('the count of the rest', items[3], '+' + (why - 3) + ' more on its page');
        const run = tip.querySelector('.v2tiprun').textContent;
        ok('model and uptime on one line: ' + run, run.includes('claude-sonnet-5 · up 3 h 20 min') && run.includes('OpenClaw 2026.9.8 · update ready'));
        ok('the restart in short', run.includes('Restarted by itself 3 times since rebuild (last: killed, usually for memory)'));
        // The last line: two lines at most; the tile's label still reads it all.
        const said = 'Robin: can we swap Thursday for the lentil soup, and is there anything on the list we already have in the pantry?';
        v2Recent = new Map([[agents.find((a) => a.name === 'Homework Helper').id, { at: mins(2), said }]]);
        v2ShowTip(tile('Homework Helper'));
        const prev = tip.querySelector('.v2tipprev'), lh = parseFloat(getComputedStyle(tip).lineHeight);
        ok('the whole line is there', prev.textContent.includes(said));
        ok('shown on two lines at most: ' + prev.getBoundingClientRect().height + ' for ' + lh, prev.getBoundingClientRect().height <= 2 * lh + 1 && prev.scrollHeight > prev.clientHeight);
        // Low on the screen: above the icon, not pushed up over it.
        document.body.style.paddingBottom = '2000px';
        const t = tile('Meal Planner');
        window.scrollBy(0, t.querySelector('.v2ic').getBoundingClientRect().bottom - (innerHeight - 30));
        v2ShowTip(t);
        const ic = t.querySelector('.v2ic').getBoundingClientRect(), r = tip.getBoundingClientRect();
        ok('no room below (' + Math.round(innerHeight - ic.bottom) + ' px for ' + Math.round(r.height) + ')', innerHeight - ic.bottom - 18 < r.height);
        ok('so it is above the icon: ' + Math.round(r.bottom) + ' ≤ ' + Math.round(ic.top), r.bottom <= ic.top);
        for (const x of document.querySelectorAll('#v2groups .v2agent')) {
          const b = x.querySelector('.v2ic').getBoundingClientRect();
          if (b.top < 0 || b.bottom > innerHeight) continue;
          v2ShowTip(x);
          const tr = tip.getBoundingClientRect();
          if (b.top - 18 < tr.height && innerHeight - b.bottom - 18 < tr.height) continue; // no room either way
          ok(x.textContent.trim().slice(0, 30) + ': its tooltip leaves the icon in sight', !overlaps(tr, b));
        }
        window.scrollTo(0, 0); document.body.style.paddingBottom = pad;
        // A press may start a drag: the tooltip goes, and comes back only on the next hover.
        const d = document.querySelector('#v2groups .v2agent:not([data-v2fixed])');
        ok('a tile that can be dragged', !!d);
        v2ShowTip(d); ok('shown on hover', !tip.hidden);
        const b = d.getBoundingClientRect(), at = { bubbles: true, button: 0, pointerId: 7, pointerType: 'mouse', clientX: b.left + 10, clientY: b.top + 10 };
        d.dispatchEvent(new PointerEvent('pointerdown', at));
        ok('a press hides it', tip.hidden);
        d.querySelector('.v2ic').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        ok('moving over the icon while pressed does not bring it back', tip.hidden);
        window.dispatchEvent(new PointerEvent('pointerup', at));
        ok('the press is over', !v2drag.st && !v2drag.active);
        d.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        ok('the next hover shows it', !tip.hidden);
      } finally {
        tip.hidden = true; window.scrollTo(0, 0); document.body.style.paddingBottom = pad;
        v2Recent = recent; await agentsCleanup();
      }
    },
  });
  // Runners and browsers (2026-10-09): what the server could not do is said, not dropped.
  Object.assign(T, {
    removeRunnerLeftovers: async () => {
      const toastText = () => document.getElementById('toast').textContent;
      window.__answer['DELETE /v1/hosts/h2'] = [{ status: 200, body: { ok: true, warning: 'Laptop did not answer, so what Hatchabot ran there is still on it.' } }];
      await deleteHost('h2', 'Laptop');
      ok('asked first', window.__confirms.some((c) => c.includes('Remove runner "Laptop"')));
      await until(() => toastText().includes('Removed "Laptop". Laptop did not answer'));
      window.__answer['DELETE /v1/hosts/h2'] = [{ status: 200, body: { ok: true } }];
      await deleteHost('h2', 'Laptop');
      await until(() => toastText() === 'Removed "Laptop"');
    },
    browserSwitchWhileBusy: async () => {
      const toastText = () => document.getElementById('toast').textContent;
      window.__answer['PATCH /v1/agents/a1'] = [{ status: 200, body: { id: 'a1', browser: true, browserPending: 'Saved. A rebuild was already under way and may have begun before this change.' } }];
      await v2SetBrowser('a1', true, null);
      await until(() => toastText().includes('A rebuild was already under way'));
      ok('not the "rebuilding" line', !toastText().includes('Browser on'));
      eq('one PATCH with the switch', calls('PATCH', /^\/v1\/agents\/a1$/).at(-1).body, { browser: true });
      await v2SetBrowser('a1', true, null);
      await until(() => toastText().includes('Browser on — rebuilding'));
    },
    // A move a restart cut off while the other machine was away (operations.ts):
    // held, under Alerts, and the sheet's Overview offers its two choices.
    heldOperation: async () => {
      const toastText = () => document.getElementById('toast').textContent;
      const outcome = "The move to Laptop was interrupted, and Laptop isn't answering.";
      const op = {
        id: 'op_test1', agentId: 'a1', kind: 'move-host', kindLabel: 'Move to another machine', status: 'held', outcome,
        step: 'host-flipped', stepLabel: 'recorded on the other machine', stepN: 6, steps: 10, updatedAt: new Date().toISOString(),
        recovery: { actions: [{ action: 'retry', label: 'Try again when Laptop is back' }, { action: 'put-back', label: 'Put it back on This machine' }], recommended: 'retry' },
      };
      try {
        await withAgents((a) => a.id === 'a1' ? { ...a, state: 'STOPPED', operation: op } : undefined);
        const a = agents.find((x) => x.id === 'a1');
        ok('its Alerts key names the operation', attentionFingerprint(a).includes('op:op_test1'));
        ok('its tile says it waits for a choice: ' + tile(a.name).getAttribute('aria-label'), /waiting for your choice/.test(tile(a.name).getAttribute('aria-label')));
        byText('.v2views button', 'Alerts').click(); await sleep(50);
        // Its own bin, first, since v2.156.0 (it cannot be cleared: the agent refuses Start until it is chosen).
        const sec = [...document.querySelectorAll('#v2groups .v2group')].find((g) => g.querySelector('h3').textContent.includes('Waiting for your choice'));
        ok('it is under Alerts, waiting for your choice', !!sec && [...sec.querySelectorAll('.v2agent .v2name')].some((n) => n.textContent === a.name));
        ok('the tooltip gives the outcome', tipText(a.name).includes(outcome));
        openV2Agent('a1', 'overview');
        const box = await until(() => document.querySelector('#v2AgentDlg .oprecover'));
        ok('the notice says where it stopped: ' + box.textContent, box.textContent.includes('Move to another machine is waiting for your choice') && box.textContent.includes('recorded on the other machine (6 of 10)'));
        const btns = [...box.querySelectorAll('button')];
        eq('its two choices', btns.map((b) => b.textContent.trim()), ['Try again when Laptop is back', 'Put it back on This machine']);
        ok('the recommended one is primary', btns[0].classList.contains('primary') && !btns[1].classList.contains('primary'));
        // A refusal is said, and the button can be pressed again.
        window.__answer = window.__answer || {};
        window.__answer['POST /v1/operations/op_test1/recover'] = [
          { status: 409, body: { error: 'Its copy on Laptop may already be running, so it can\'t be put back until Laptop answers.' } },
          { status: 200, body: { operation: { ...op, status: 'rolled_back', outcome: 'Put back on This machine and running.', recovery: undefined } } },
        ];
        btns[1].click();
        await until(() => toastText().includes("can't be put back until Laptop answers"));
        await until(() => { const b = [...document.querySelectorAll('#v2AgentDlg .oprecover button')][1]; return b && !b.disabled; });
        delete window.__override['/v1/agents'];
        [...document.querySelectorAll('#v2AgentDlg .oprecover button')][1].click();
        await until(() => toastText().includes('Put back on This machine and running.'));
        eq('the choice was sent', calls('POST', /^\/v1\/operations\/op_test1\/recover$/).map((c) => c.body), [{ action: 'put-back' }, { action: 'put-back' }]);
        v2Close();
      } finally { await agentsCleanup(); }
    },
  });
  // One interface, step 1 (2026-10-09): what only the classic look had, on the home screen,
  // and the keyboard fixes before classic goes (docs/operations-and-one-interface-design.md, Part B).
  Object.assign(T, {
    plannedAgents: async () => {
      const toastText = () => document.getElementById('toast').textContent;
      window.__override['/v1/agent-todos'] = { todos: [{ id: 't1', name: 'Recipe Box' }, { id: 't2', name: 'Book Club', note: 'for the reading group' }] };
      try {
        v2SetView('group');
        await loadTodos();
        const head = byText('#v2groups .v2ghead h3', 'Planned');
        ok('a Planned group on the home screen', !!head);
        const sec = head.closest('.v2group');
        ok('open when it has plans', !sec.classList.contains('collapsed'));
        const ghosts = [...sec.querySelectorAll('.v2plantile')];
        eq('a ghost tile per plan', ghosts.map((g) => g.querySelector('.v2name').textContent), ['Recipe Box', 'Book Club']);
        ok('a ghost is not an agent tile (no drag, no console)', !sec.querySelector('.v2agent') && !ghosts[0].dataset.v2id);
        ok('it says it is not made yet: ' + ghosts[0].getAttribute('aria-label'), ghosts[0].getAttribute('aria-label').includes('planned, not made yet'));
        ok('dashed, not coloured', getComputedStyle(ghosts[0].querySelector('.v2ic')).borderTopStyle === 'dashed');
        const archived = byText('#v2groups .v2ghead h3', 'Archived');
        ok('before Archived', !!(head.compareDocumentPosition(archived) & Node.DOCUMENT_POSITION_FOLLOWING));
        // Plan one: a labelled box, Enter adds it.
        const box = document.getElementById('v2TodoNew');
        ok('the box has a real label', !!box && box.labels.length === 1 && box.labels[0].textContent.includes('Plan an agent'));
        box.value = 'Chore Chart';
        box.form.requestSubmit();
        const post = await until(() => calls('POST', /^\/v1\/agent-todos$/)[0]);
        eq('added', post.body, { name: 'Chore Chart' });
        // Make one with one click: New agent, its name filled in.
        byText('#v2groups .v2plantile', 'Recipe Box').click();
        await until(() => createDlg.open);
        eq('the name is filled in', document.getElementById('agentName').value, 'Recipe Box');
        createDlg.close();
        // Once an agent of that name exists, the plan leaves on the next list.
        const list = await (await fetch('/v1/agents')).json();
        window.__override['/v1/agents'] = list.concat([{ ...list[0], id: 'made1', name: 'Recipe Box', group: 'Family' }]);
        await refresh(false);
        await until(() => calls('DELETE', /^\/v1\/agent-todos\/t1$/).length);
        await until(() => !byText('#v2groups .v2plantile', 'Recipe Box'));
        // Remove one by keyboard: a real button with a name.
        const x = document.querySelector('#v2groups button[aria-label="Remove Book Club from Planned"]');
        ok('the remove button is a real, named button', !!x && x.tagName === 'BUTTON' && x.type === 'button');
        window.__confirms.length = 0;
        x.click();
        await until(() => calls('DELETE', /^\/v1\/agent-todos\/t2$/).length);
        ok('it asked first', window.__confirms.some((c) => c.includes('Book Club')));
        // Only in the Groups view: the other views are bins of what exists.
        v2SetView('state');
        ok('not in another view', !byText('#v2groups .v2ghead h3', 'Planned'));
        ok('no stray toast error', !/error/i.test(toastText()));
      } finally {
        delete window.__override['/v1/agent-todos']; delete window.__override['/v1/agents'];
        v2SetView('group'); await loadTodos(); await refresh(false);
      }
    },
    myOrder: async () => {
      const toastText = () => document.getElementById('toast').textContent;
      const names = (group) => [...document.querySelector('.v2grid[data-v2drop="' + group + '"]').querySelectorAll('.v2agent .v2name')].map((n) => n.textContent);
      const famHead = () => byText('#v2groups .v2ghead', 'Family');
      try {
        v2SetView('group');
        v2SetSort('name');
        eq('Name sorts the group', names('Family'), ['Homework Helper', 'Piano Practice', 'Soccer Schedule']);
        ok('no keep-sorted button outside My order', !famHead().querySelector('button[aria-label="Sort this group A to Z and keep that order"]'));
        // Under another sort a drop in the same group moves nothing, and says how to arrange by hand.
        let mark = window.__calls.length;
        document.activeElement?.blur?.();
        let from = tile('Piano Practice'), to = tile('Homework Helper');
        from.scrollIntoView({ block: 'center' }); // on screen, or the pointer lands on nothing
        let p = centre(from), r = to.getBoundingClientRect();
        pointer('pointerdown', from, p.x, p.y); pointer('pointermove', window, p.x + 12, p.y + 12);
        pointer('pointermove', window, r.left + r.width * 0.2, r.top + r.height / 2);
        pointer('pointerup', window, r.left + r.width * 0.2, r.top + r.height / 2);
        await until(() => toastText().includes('choose My order'));
        ok('no move asked for', !window.__calls.slice(mark).some((c) => /\/move$/.test(c.path)));
        // My order: the stored order, a fourth choice beside Age, Name, Activity.
        document.getElementById('v2sort-manual').click();
        ok('My order is chosen', v2Sort.key === 'manual' && document.getElementById('v2sort-manual').getAttribute('aria-pressed') === 'true');
        eq('the stored order', names('Family'), ['Homework Helper', 'Soccer Schedule', 'Piano Practice']);
        // Drag within the group places it.
        mark = window.__calls.length;
        from = tile('Piano Practice'); to = tile('Homework Helper');
        from.scrollIntoView({ block: 'center' });
        p = centre(from); r = to.getBoundingClientRect();
        pointer('pointerdown', from, p.x, p.y); pointer('pointermove', window, p.x + 12, p.y + 12);
        pointer('pointermove', window, r.left + r.width * 0.2, r.top + r.height / 2);
        pointer('pointerup', window, r.left + r.width * 0.2, r.top + r.height / 2);
        const mv = await until(() => window.__calls.slice(mark).find((c) => c.method === 'POST' && c.path === '/v1/agents/a3/move'));
        eq('placed before Homework Helper', mv.body, { before: 'a1' });
        // Sort a group A→Z once and keep it: a group action in My order.
        const az = famHead().querySelector('button[aria-label="Sort this group A to Z and keep that order"]');
        ok('a keep-sorted A→Z on the group', !!az);
        az.click();
        const srt = await until(() => calls('POST', /^\/v1\/groups\/sort$/)[0]);
        eq('sorted once, kept', srt.body, { group: 'Family', mode: 'name', desc: false });
        // The keyboard's drag: Move earlier / later on the sheet's Overview.
        openV2Agent('a2', 'overview');
        const row = await until(() => document.getElementById('v2Place'));
        ok('its place: ' + row.textContent, row.textContent.includes('2 of 3 in Family'));
        mark = window.__calls.length;
        document.getElementById('v2MoveEarlier').click();
        const e1 = await until(() => window.__calls.slice(mark).find((c) => c.method === 'POST' && c.path === '/v1/agents/a2/move'));
        eq('earlier: before the first', e1.body, { before: 'a1' });
        await until(() => document.activeElement && document.activeElement.id === 'v2MoveEarlier');
        mark = window.__calls.length;
        document.getElementById('v2MoveLater').click();
        const e2 = await until(() => window.__calls.slice(mark).find((c) => c.method === 'POST' && c.path === '/v1/agents/a2/move'));
        eq('later: the end of its group', e2.body, { before: null, group: 'Family' });
        v2Close();
        // From another sort, moving by hand switches the home screen to My order.
        v2SetSort('age');
        openV2Agent('a2', 'overview');
        await until(() => document.getElementById('v2MoveEarlier'));
        document.getElementById('v2MoveEarlier').click();
        await until(() => v2Sort.key === 'manual');
        ok('and says so', toastText().includes('My order'));
        v2Close();
        ok('no Order row for the manager', (() => { openV2Agent(agents.find((a) => a.ops).id, 'overview'); const none = !document.getElementById('v2Place'); v2Close(); return none; })());
      } finally {
        if (v2AgentDlg.open) v2Close();
        v2Sort = { key: 'age', dir: -1 }; try { localStorage.removeItem('hb-v2-sort'); } catch {}
        await refresh(false); renderV2();
      }
    },
    checkAll: async () => {
      const healthy = { status: 'healthy', reachable: true, doctor: { findings: [], checksRun: 12 } };
      const running = agents.filter((a) => a.state === 'RUNNING' && v2Mine(a));
      for (const a of agents) window.__override['/v1/agents/' + a.id + '/health'] = healthy;
      window.__override['/v1/agents/a1/health'] = { status: 'healthy', reachable: true, doctor: { findings: [{ severity: 'warn', checkId: 'search', message: 'web search is turned off' }], checksRun: 12 } };
      window.__override['/v1/agents/a4/health'] = { status: 'unreachable', reachable: false };
      const mark = window.__calls.length;
      try {
        openFleetActions();
        await until(() => fleetActionsDlg.open);
        document.getElementById('faCheckAllBtn').click();
        await until(() => !fleetActionsDlg.open);
        await until(() => v2CheckLast && !v2CheckRun);
        const asked = window.__calls.slice(mark).filter((c) => c.method === 'GET' && /\/health$/.test(c.path));
        eq('every running agent of yours, once', asked.length, running.length);
        ok('with the settings check', asked.every((c) => c.url.includes('doctor=1')));
        ok('not the stopped or rebuilding ones', !asked.some((c) => c.path === '/v1/agents/a10/health' || c.path === '/v1/agents/a5/health'));
        const line = document.getElementById('v2CheckAll');
        const said = line.textContent.replace(/\s+/g, ' ');
        ok('a line says how it went: ' + said, !line.hidden && said.includes(running.length + ' running agents checked') && said.includes('2 worth a look') && said.includes('Homework Helper') && said.includes('Meal Planner') && said.includes('2 not running'));
        ok('above the agents', !!(line.compareDocumentPosition(document.getElementById('v2groups')) & Node.DOCUMENT_POSITION_FOLLOWING));
        ok('the tile says Worth a look', tile('Homework Helper').getAttribute('aria-label').includes('Worth a look'));
        const tip = tipText('Homework Helper');
        ok('its tooltip says what: ' + tip.slice(0, 200), tip.includes('Health check: 1 setting to fix: web search is turned off'));
        ok('one that did not answer', tipText('Meal Planner').includes("Health check: it didn't answer"));
        ok('a fine one stays fine', !tile('Budget Tracker').getAttribute('aria-label').includes('Worth a look'));
        byText('#v2CheckAll button', 'Show under Alerts').click();
        ok('Alerts view', v2View === 'attention');
        const alerts = [...document.querySelectorAll('#v2groups .v2group')].find((g) => g.querySelector('h3').textContent.includes('Alerts'));
        ok('both under Alerts', !!alerts && alerts.textContent.includes('Homework Helper') && alerts.textContent.includes('Meal Planner'));
        // The machine line has it too (its owner's).
        const saved = v2Machine;
        v2Machine = { hosts: [{ id: 'h1', name: 'This machine', kind: 'local', hostname: 'home-box', agentCount: 12 }], backup: null, runtime: null };
        v2PaintMachine();
        ok('on the machine line', !!document.getElementById('v2MachineCheckAll'));
        v2Machine = saved; v2PaintMachine();
        // Clear: the results go, and the tiles with them.
        document.querySelector('#v2CheckAll button[aria-label="Clear the health check results"]').click();
        ok('cleared', line.hidden && !tile('Homework Helper').getAttribute('aria-label').includes('Worth a look'));
      } finally {
        for (const a of agents) delete window.__override['/v1/agents/' + a.id + '/health'];
        v2ClearChecks(); v2SetView('group');
        if (fleetActionsDlg.open) fleetActionsDlg.close();
      }
    },
    setupValuesNotice: async () => {
      try {
        await withAgents((a) => a.id === 'a1' ? { ...a, persona: 'Helps {{child_name}} with homework' } : undefined);
        openV2Agent('a1', 'overview');
        const btn = await until(() => byText('#v2Pane .v2notices button', 'Fill its Setup values'));
        ok('the notice is there, with a real button', btn.type === 'button' && byText('#v2Pane .v2notices .pair', 'Template not configured'));
        ok('not said twice in the list below', ![...document.querySelectorAll('#v2Pane .v2why li')].some((li) => li.textContent.includes('setup values')));
        btn.click();
        await until(() => v2Tab === 'personality');
        ok('it opens the Personality tab (Setup values)', v2Tab === 'personality' && !!document.querySelector('#v2Pane #paneDef'));
        v2Close();
        openV2Agent('a2', 'overview');
        ok('no notice on a filled-in agent', !byText('#v2Pane .v2notices button', 'Fill its Setup values'));
        v2Close();
      } finally { if (v2AgentDlg.open) v2Close(); await agentsCleanup(); }
    },
    telegramWeb: async () => {
      window.__override['/v1/agents/a1/channels'] = { channels: [{ kind: 'telegram', displayName: 'Homework Helper', deepLink: 'https://t.me/HomeworkHelperBot', youAreLinked: true, rooms: { mode: 'members' } }], imageSupports: ['telegram'], spare: {} };
      try {
        openV2Agent('a1', 'messaging');
        const web = await until(() => [...document.querySelectorAll('#v2Chans a')].find((x) => x.textContent === 'Telegram Web'));
        ok('a Telegram Web link: ' + web.href, web.href.startsWith('https://web.telegram.org/k/#?tgaddr=') && web.href.includes('HomeworkHelperBot'));
        const open = [...document.querySelectorAll('#v2Chans a')].find((x) => x.textContent === 'Open in Telegram');
        ok('beside Open in Telegram', !!open && open.parentElement === web.parentElement);
        ok('in a new tab, without a way back', web.target === '_blank' && web.rel.includes('noopener'));
      } finally { delete window.__override['/v1/agents/a1/channels']; if (v2AgentDlg.open) v2Close(); }
    },
    sheetKeyboard: async () => {
      const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      try {
        openV2Agent('a1', 'overview');
        // Real labels for the Overview's selects.
        const g = document.getElementById('v2GroupSel'), c = document.getElementById('editClass');
        ok('Group has a label', g.labels.length === 1 && g.labels[0].textContent === 'Group');
        ok('Class has a label', c.labels.length === 1 && c.labels[0].textContent === 'Class');
        // The bar's icon is a real button (Space and Enter both press it).
        const ic = document.querySelector('#v2AgentBar .v2iconbtn');
        ok('the icon is a button', !!ic && ic.tagName === 'BUTTON' && ic.getAttribute('aria-label') === 'Change its icon' && !document.querySelector('#v2AgentBar [role="button"]'));
        // Tabs: each controls the pane; arrow keys move between them.
        const tabs = [...document.querySelectorAll('#v2Tabs [role="tab"]')];
        ok('each tab controls the pane', tabs.every((t) => t.getAttribute('aria-controls') === 'v2Pane'));
        const pane = document.getElementById('v2Pane');
        ok('the pane is the tab panel', pane.getAttribute('role') === 'tabpanel' && pane.getAttribute('aria-labelledby') === 'v2tab-overview');
        ok('one tab in the Tab order', tabs.filter((t) => t.tabIndex === 0).length === 1);
        document.getElementById('v2tab-overview').focus();
        key(document.activeElement, 'ArrowRight');
        ok('ArrowRight: the next tab, chosen and focused', v2Tab === 'personality' && document.activeElement.id === 'v2tab-personality');
        key(document.activeElement, 'End');
        ok('End: the last', v2Tab === 'advanced' && document.activeElement.id === 'v2tab-advanced');
        for (const id of ['v2Sleep', 'v2FilesCap', 'v2Browser']) { const s = document.getElementById(id); if (s) ok(id + ' is labelled', s.labels.length > 0); }
        key(document.activeElement, 'ArrowRight');
        ok('wraps to the first', v2Tab === 'overview' && document.activeElement.id === 'v2tab-overview');
        key(document.activeElement, 'ArrowLeft');
        ok('ArrowLeft wraps to the last', v2Tab === 'advanced');
        v2Close();
      } finally { if (v2AgentDlg.open) v2Close(); }
    },
    classMemoryPending: async () => {
      // A class whose memory cap the container did not take says so, not "applied" (#138);
      // deleting a class names members whose containers kept its limits (#148).
      window.__override['/v1/agent-classes'] = { classes: [{ id: 'c1', name: 'Light', memoryCap: '2g' }] };
      window.__answer = {
        'POST /v1/agents/a1/class': [{ body: { classId: 'c1', rebuild: false, memoryPending: 'Its container kept its old memory limits (runner asleep); a rebuild applies them.' } }],
        'DELETE /v1/agent-classes/c1': [{ body: { removed: true, skipped: ['Homework Helper: runner asleep'] } }],
      };
      try {
        openV2Agent('a1', 'overview');
        const sel = await until(() => { const s = document.getElementById('editClass'); return s && s.querySelector('option[value="c1"]') ? s : null; });
        sel.value = 'c1'; sel.dispatchEvent(new Event('change'));
        await until(() => document.getElementById('toast').textContent.includes('kept its old memory limits'));
        ok('the class is still said to be set', document.getElementById('toast').textContent.includes('Class set'));
        v2Close();
        await deleteClass('c1', 'Light');
        await until(() => document.getElementById('toast').textContent.includes('memory limits not changed for Homework Helper'));
      } finally { delete window.__override['/v1/agent-classes']; window.__answer = {}; if (v2AgentDlg.open) v2Close(); }
    },
    classModelPending: async () => {
      // A runtime that refused the class's model is said to be on its old one, not "model applied" (audit #068).
      window.__override['/v1/agent-classes'] = { classes: [{ id: 'c1', name: 'Light', model: 'claude-haiku-4-5' }] };
      window.__answer = {
        'POST /v1/agents/a1/class': [{ body: { classId: 'c1', rebuild: false, modelPending: 'It joined the class, but its runtime did not take claude-haiku-4-5, so it still answers on its old model.' } }],
        'PUT /v1/agent-classes/c1': [{ body: { class: { id: 'c1', name: 'Light', model: 'claude-haiku-4-5' }, applied: 0, needRebuild: 0, skipped: [], modelPending: ['Homework Helper: its runtime did not take claude-haiku-4-5'] } }],
      };
      try {
        openV2Agent('a1', 'overview');
        const sel = await until(() => { const s = document.getElementById('editClass'); return s && s.querySelector('option[value="c1"]') ? s : null; });
        sel.value = 'c1'; sel.dispatchEvent(new Event('change'));
        await until(() => document.getElementById('toast').textContent.includes('still answers on its old model'));
        ok('it does not say the model was applied', !document.getElementById('toast').textContent.includes('model applied'));
        v2Close();
        await updateClass('c1', 'model', 'claude-haiku-4-5');
        await until(() => document.getElementById('toast').textContent.includes('1 still on the old model'));
        ok('it names the agent', document.getElementById('toast').textContent.includes('Homework Helper'));
      } finally { delete window.__override['/v1/agent-classes']; window.__answer = {}; if (v2AgentDlg.open) v2Close(); }
    },
    classEditDeleted: async () => {
      // An edit waiting behind the class's deletion answers 404: said so, and the list read again (HB-0560).
      window.__override['/v1/agent-classes'] = { classes: [] };
      window.__answer = { 'PUT /v1/agent-classes/c1': [{ status: 404, body: { error: 'Not found' } }] };
      try {
        agentClasses = [{ id: 'c1', name: 'Light', model: 'claude-haiku-4-5' }];
        await updateClass('c1', 'model', 'claude-opus-5-5');
        await until(() => document.getElementById('toast').textContent.includes('was deleted meanwhile'));
        ok('the list is read again', agentClasses.length === 0);
      } finally { delete window.__override['/v1/agent-classes']; window.__answer = {}; }
    },
    classRowBehind: async () => {
      // A member the class's model has not reached (a rebuild that failed after the edit) is counted in its row.
      // As the agent list sends them: the class's model is each one's pin
      // (modelOverride), model what its runtime runs (appliedModel), and
      // pendingModel the pin, sent only while the runtime runs another.
      const keepAgents = agents, keepClasses = agentClasses;
      try {
        agentClasses = [{ id: 'c1', name: 'Light', model: 'claude-haiku-4-5' }];
        agents = [
          { ...keepAgents[0], id: 'x1', classId: 'c1', modelOverride: 'claude-haiku-4-5', appliedModel: 'claude-opus-4-8', model: 'claude-opus-4-8', pendingModel: 'claude-haiku-4-5' },
          { ...keepAgents[0], id: 'x2', classId: 'c1', modelOverride: 'claude-haiku-4-5', appliedModel: 'claude-haiku-4-5', model: 'claude-haiku-4-5', pendingModel: undefined },
          // Its source switched with the class: its model waits for that rebuild, it is not behind.
          { ...keepAgents[0], id: 'x3', classId: 'c1', modelOverride: 'claude-haiku-4-5', appliedModel: 'claude-opus-4-8', model: 'claude-opus-4-8', pendingModel: 'claude-haiku-4-5', rebuildWaits: true },
        ];
        renderClassList();
        const rowEl = document.querySelector('#classList .classrow');
        const row = rowEl.textContent;
        ok('the row counts its members, the one behind and the one waiting: ' + row, row.includes('3 agents') && row.includes('1 still on an old model') && row.includes('1 waiting for a rebuild'));
        // The warning has the warning colour inside the row's grey line.
        const ref = document.createElement('span'); ref.style.color = 'var(--warn)'; document.body.appendChild(ref);
        const warnColour = getComputedStyle(ref).color; ref.remove();
        eq('the warning is coloured', getComputedStyle(rowEl.querySelector('.sub .warn')).color, warnColour);
      } finally { agents = keepAgents; agentClasses = keepClasses; renderClassList(); }
    },
    capKeptForNextStartSaid: async () => {
      // A cap or swap saved while its container kept the old limits (its machine asleep): kept for its next start, not "applied".
      const toastText = () => document.getElementById('toast').textContent;
      const a = agents.find((x) => x.state === 'RUNNING') || agents[0];
      const was = editAgentId;
      editAgentId = a.id;
      const capOpt = document.createElement('option'); capOpt.value = '2g'; capOpt.textContent = '2 GB';
      const swapOpt = document.createElement('option'); swapOpt.value = '1g'; swapOpt.textContent = '1 GB';
      $('editMemoryCap').append(capOpt); $('editSwapAllowance').append(swapOpt);
      const answer = (extra) => ({ ['PATCH /v1/agents/' + a.id]: [{ body: { ...a, state: 'RUNNING', ...extra } }] });
      const kept = { memoryPending: 'Words the page does not read.', limitsKept: { name: a.name, why: 'a made-up reason' } };
      try {
        $('editMemoryCap').value = '2g';
        window.__answer = answer(kept);
        await saveMemoryCap();
        ok('a kept cap is kept for its next start: ' + toastText(), toastText().includes('kept for its next start: its container kept its old memory limits (a made-up reason)') && !toastText().includes('applied to the running container'));
        $('editSwapAllowance').value = '1g';
        window.__answer = answer(kept);
        await saveSwapAllowance();
        ok('a kept swap allowance too: ' + toastText(), toastText().includes('kept for its next start') && !toastText().includes('applied to the running container'));
        $('editMemoryCap').value = '2g';
        window.__answer = answer({});
        await saveMemoryCap();
        ok('a cap that went on says so: ' + toastText(), toastText().includes('applied to the running container'));
      } finally {
        capOpt.remove(); swapOpt.remove();
        window.__answer = {}; editAgentId = was;
        await refresh(true);
      }
    },
    homeKeyboard: async () => {
      const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      try {
        v2SetView('group');
        // View by: real tabs over one panel, arrow keys between them.
        const first = document.getElementById('v2view-group');
        ok('a view tab controls the panel', first.getAttribute('aria-controls') === 'v2ViewPanel');
        const panel = document.getElementById('v2ViewPanel');
        ok('the panel is labelled by the chosen view', panel.getAttribute('role') === 'tabpanel' && panel.getAttribute('aria-labelledby') === 'v2view-group' && panel.contains(tile('Homework Helper')));
        first.focus();
        key(first, 'ArrowRight');
        ok('ArrowRight: the next view, focused: ' + v2View, v2View !== 'group' && document.activeElement.id === 'v2view-' + v2View);
        key(document.activeElement, 'Home');
        ok('Home: Groups again', v2View === 'group' && document.activeElement.id === 'v2view-group');
        // The account menu: menu items, arrow keys.
        v2ToggleAccount();
        const pop = document.getElementById('v2AcctPop');
        const items = [...pop.querySelectorAll('button')].filter((b) => !b.hidden && b.offsetParent !== null);
        ok('every button is a menu item', items.every((b) => /^menuitem/.test(b.getAttribute('role') || '')));
        ok('the first item has focus', document.activeElement === items[0]);
        ok('the theme says which is on', ['true', 'false'].includes(document.getElementById('v2ThemeLight').getAttribute('aria-checked')));
        key(document.activeElement, 'ArrowDown');
        ok('ArrowDown: the next item', document.activeElement === items[1]);
        key(document.activeElement, 'ArrowUp'); key(document.activeElement, 'ArrowUp');
        ok('ArrowUp wraps to the last', document.activeElement === items[items.length - 1]);
        key(document.activeElement, 'Home');
        ok('Home: the first', document.activeElement === items[0]);
        key(document.activeElement, 'Escape');
        ok('Escape closes, back on the avatar', pop.hidden && document.activeElement.id === 'v2AvatarBtn');
        // The pointer-only strips say where the keyboard does the same.
        ok('new-group strip hint', document.getElementById('v2NewGroup').textContent.includes('By keyboard: open the agent, then Overview → Group'));
        ok('bin hint', document.getElementById('v2Trash').textContent.includes('By keyboard: open the agent, then Delete… at the foot of its Overview'));
        const arch = [...document.querySelectorAll('#v2groups .v2group')].find((s) => s.querySelector('h3').textContent === 'Archived');
        ok('Archived hint', !!arch && arch.textContent.includes('By keyboard: open the agent, then Archive at the foot of its Overview'));
      } finally { if (!document.getElementById('v2AcctPop').hidden) v2CloseAccount(); v2SetView('group'); }
    },
  });
  // Long operations on the page (operations.ts, phase 3, v2.156.0): Working on reads the
  // operation, the page follows it and says how it ended; Activity has one row per operation.
  Object.assign(T, {
    opWorkingOn: async () => {
      const toastText = () => document.getElementById('toast').textContent;
      const started = new Date(Date.now() - 2 * 60000 - 5000).toISOString();
      const op = { id: 'op_run1', agentId: 'a1', kind: 'move-host', kindLabel: 'Move to another machine', title: 'Moving to Laptop runner', status: 'running',
        step: 'target-created', stepLabel: 'made on the other machine', stepN: 4, steps: 10, requestedAt: started, updatedAt: new Date().toISOString() };
      window.__answer = window.__answer || {};
      try {
        await withAgents((a) => a.id === 'a1' ? { ...a, busy: true, operation: op } : undefined);
        const a = agents.find((x) => x.id === 'a1');
        const want = 'Moving to Laptop runner — step 4 of 10, made on the other machine · 2 min';
        ok('the tile\'s ring says what, which step of how many, how long: ' + tile(a.name).getAttribute('aria-label'), tile(a.name).getAttribute('aria-label').includes(want));
        openV2Agent('a1', 'overview');
        const line = await until(() => document.getElementById('v2OpWorking'));
        eq('the sheet\'s Working on line', line.textContent, want);
        ok('one Working on row, not the state\'s as well', [...document.querySelectorAll('#v2Pane .v2k')].filter((k) => k.textContent === 'Working on').length === 1);
        ok('followed: the page reads the operation', v2Ops.has('op_run1'));
        // A later step: the line moves on without the agent list being read again.
        window.__answer['GET /v1/operations/op_run1'] = [{ body: { ...op, step: 'host-flipped', stepLabel: 'recorded on the other machine', stepN: 6 } }];
        await v2OpTick();
        await until(() => document.getElementById('v2OpWorking')?.textContent.includes('step 6 of 10, recorded on the other machine'));
        eq('it asked for that operation', calls('GET', /^\/v1\/operations\/op_run1$/).length, 1);
        // The end: a toast says how it ended, and the line goes.
        window.__answer['GET /v1/operations/op_run1'] = [{ body: { ...op, status: 'succeeded', step: 'source-removed', stepN: 10, outcome: 'Moved to Laptop runner.', summary: 'Moved to Laptop runner', finishedAt: new Date().toISOString() } }];
        await withAgents((x) => x.id === 'a1' ? { ...x, busy: false, operation: undefined } : undefined);
        // (the list no longer carries it; the follower still has it)
        v2Ops.set('op_run1', 'a1');
        await v2OpTick();
        await until(() => toastText().includes('Moved to Laptop runner.'));
        ok('the toast names the agent: ' + toastText(), toastText().includes('✅') && toastText().includes(a.name));
        ok('no longer followed', !v2Ops.has('op_run1'));
        await until(() => !document.getElementById('v2OpWorking'));
        v2Close();
      } finally { delete window.__answer['GET /v1/operations/op_run1']; v2Ops.clear(); await agentsCleanup(); }
    },
    opStartedHere: async () => {
      // Move to a runner from the page: the 202's operation is followed at once.
      const toastText = () => document.getElementById('toast').textContent;
      const runner = { id: 'h9', name: 'Laptop runner', kind: 'cloud', online: true };
      hosts.push(runner);
      window.__answer = window.__answer || {};
      window.__promptAnswer = '1';
      const op = { id: 'op_run2', agentId: 'a2', kind: 'move-host', kindLabel: 'Move to another machine', title: 'Moving to Laptop runner', status: 'running', steps: 10, requestedAt: new Date().toISOString() };
      window.__answer['POST /v1/agents/a2/move-host'] = [{ status: 202, body: { operation: op } }];
      try {
        const a = agents.find((x) => x.id === 'a2');
        await moveHostAgent('a2', a.name);
        eq('the move was asked for', calls('POST', /^\/v1\/agents\/a2\/move-host$/).at(-1).body, { hostId: 'h9' });
        ok('it says it goes on, and where to watch: ' + toastText(), toastText().includes('Moving ' + a.name + ' to Laptop runner') && toastText().includes('its tile shows each step'));
        ok('followed', v2Ops.has('op_run2'));
      } finally { hosts.splice(hosts.indexOf(runner), 1); window.__promptAnswer = null; delete window.__answer['POST /v1/agents/a2/move-host']; v2Ops.clear(); await refresh(false); }
    },
    activityOpRow: async () => {
      const now = Date.now(), iso = (m) => new Date(now - m * 60000).toISOString();
      window.__override['/v1/events'] = [
        { agentId: 'a1', agentName: 'Homework Helper', at: iso(2), event: 'op.done', label: 'Moved to Laptop runner · 3 min',
          op: { id: 'op_a1', kind: 'move-host', status: 'succeeded', summary: 'Moved to Laptop runner', durationMs: 180000, outcome: 'Moved to Laptop runner.',
            steps: [{ at: iso(5), event: 'op.step', label: 'stopped here (step 2 of 10)' }, { at: iso(4), event: 'op.step', label: 'its memory copied in (step 5 of 10)' }, { at: iso(2), event: 'op.done', label: 'Moved to Laptop runner.' }] } },
        { agentId: 'a2', agentName: 'Soccer Schedule', at: iso(20), event: 'op.rolled_back', label: 'Import undone · 1 min',
          op: { id: 'op_a2', kind: 'import', status: 'rolled_back', summary: 'Import undone', durationMs: 60000, outcome: 'Import failed and was rolled back.', steps: [{ at: iso(20), event: 'op.rolled_back', label: 'undone: Import failed and was rolled back.' }] } },
        { agentId: 'a3', agentName: 'Piano Practice', at: iso(30), event: 'op.held', label: 'Move to Laptop runner is waiting for your choice · 2 min',
          op: { id: 'op_a3', kind: 'move-host', status: 'held', summary: 'Move to Laptop runner is waiting for your choice', durationMs: 120000, steps: [] } },
        { id: 7, agentId: 'a1', agentName: 'Homework Helper', at: iso(60), event: 'agent.rebuilt', detail: {} },
      ];
      try {
        await v2LoadActivity(true);
        const rows = [...document.querySelectorAll('#v2ActList .v2actrow')];
        eq('one row per operation, and the other line', rows.length, 4);
        ok('the move reads as one line: ' + rows[0].textContent, rows[0].textContent.includes('Moved to Laptop runner · 3 min'));
        const btn = rows[0].querySelector('button.v2actopbtn');
        ok('it opens with a real button (keyboard: Enter, Space)', !!btn && btn.tagName === 'BUTTON' && btn.getAttribute('aria-expanded') === 'false');
        const list = document.getElementById(btn.getAttribute('aria-controls'));
        ok('its steps are there, closed', !!list && list.hidden && list.querySelectorAll('li').length === 3);
        btn.click();
        ok('opened', btn.getAttribute('aria-expanded') === 'true' && !list.hidden && list.textContent.includes('its memory copied in (step 5 of 10)'));
        await v2LoadActivity(true);
        const again = document.querySelector('#v2ActList button.v2actopbtn[data-op="op_a1"]');
        ok('stays open across a reload', again.getAttribute('aria-expanded') === 'true' && !document.getElementById(again.getAttribute('aria-controls')).hidden);
        again.click();
        ok('closes again', again.getAttribute('aria-expanded') === 'false');
        ok('an undone one in red', !!rows[1].querySelector('.bad') && rows[1].textContent.includes('Import undone'));
        ok('a held one in amber', !!document.querySelectorAll('#v2ActList .v2actrow')[2].querySelector('.warn'));
        ok('a row with nothing to open is not a button', !document.querySelectorAll('#v2ActList .v2actrow')[2].querySelector('button'));
      } finally { delete window.__override['/v1/events']; v2ActOpen.clear(); await v2LoadActivity(true); }
    },
    // Recovery readiness (v2.157.0, made-up data): the agent sheet's Recovery row and its guided restore.
    recoveryRow: async () => {
      const ready = { agentId: 'a1', name: 'Homework Helper', hostId: 'h1', status: 'ready', line: 'Recoverable from 2026-10-08 · last drill 2026-10-05 passed',
        latestUsable: { date: '2026-10-08', ageDays: 1, sizeBytes: 2048, complete: true }, leftOut: { count: 0, of: 3, asleep: 0, failed: 0, missing: 0, other: 0 },
        drill: { at: '2026-10-05T05:20:00Z', set: '2026-10-05', passed: true, restored: true, checks: ['archive read whole'] },
        restorable: [{ date: '2026-10-08', sizeBytes: 2048, complete: true, drill: 'passed' }, { date: '2026-10-07', sizeBytes: 1024, complete: false, otherKey: true }] };
      const answer = (over, rest = {}) => ({ agents: [{ ...ready, ...over }], newestSet: '2026-10-08', newestFresh: true, staleDays: 2, canRestore: true, drill: { every: 'off', hours: { from: 5, to: 7 } }, ...rest });
      window.__override['/v1/backups/readiness'] = answer({});
      try {
        await v2LoadReadiness(true);
        openV2Agent('a1', 'advanced');
        const row = await until(() => { const r = document.getElementById('v2RecoveryRow'); return r && r.textContent.includes('Recoverable from') ? r : null; });
        ok('the row says it in words: ' + row.textContent.replace(/\s+/g, ' ').slice(0, 120), row.textContent.includes('Recoverable from 2026-10-08 · last drill 2026-10-05 passed'));
        ok('not in the warning colour when ready', !document.getElementById('v2RecoveryLine').classList.contains('warn'));
        const btn = document.getElementById('v2RecoveryBtn');
        ok('a Restore… button', btn && btn.textContent === 'Restore…' && btn.getAttribute('aria-expanded') === 'false');
        btn.click();
        const pick = await until(() => document.querySelector('#v2RecoveryPick input[name="v2RecDate"]') && document.getElementById('v2RecoveryPick'));
        ok('it asked for this agent\'s sets', calls('GET', /\/v1\/backups\/readiness$/).some((c) => c.url.includes('agentId=a1')));
        eq('the newest usable backup is chosen', document.querySelector('#v2RecoveryPick input[name="v2RecDate"]:checked').value, '2026-10-08');
        ok('what each set holds: ' + pick.textContent.replace(/\s+/g, ' ').slice(0, 300), pick.textContent.includes('drill passed') && pick.textContent.includes('a set that was not complete; its own copy is whole'));
        ok('what will be undone', pick.textContent.includes('What is undone: everything it learned or changed since 2026-10-08') && pick.textContent.includes('stay as they are now'));
        // A set made by another install, or under an earlier key, says so beside its date, and only that one (sixth review of HB-0540).
        const labelOf = (date) => [...pick.querySelectorAll('label')].find((l) => l.querySelector('input[value="' + date + '"]'))?.textContent.replace(/\s+/g, ' ') || '';
        ok('the other key\'s set is labelled: ' + labelOf('2026-10-07'), labelOf('2026-10-07').includes('made by another install, or under an earlier key'));
        ok('this install\'s own set is not', !labelOf('2026-10-08').includes('another install'));
        const other = [...document.querySelectorAll('#v2RecoveryPick input[name="v2RecDate"]')].find((i) => i.value === '2026-10-07');
        other.checked = true; other.dispatchEvent(new Event('change', { bubbles: true }));
        const go = await until(() => byText('#v2RecoveryPick button', 'Restore from 2026-10-07'));
        ok('the keyboard stays on the choice', document.activeElement && document.activeElement.value === '2026-10-07');
        // The existing typed-name confirm stays: a wrong name restores nothing.
        window.__promptAnswer = 'Homework';
        go.click();
        await until(() => document.getElementById('toast').textContent.includes('did not match'));
        eq('no restore on a wrong name', calls('POST', /\/v1\/backups\/restore$/).length, 0);
        ok('the choices stay open after a wrong name', !!byText('#v2RecoveryPick button', 'Restore from 2026-10-07'));
        window.__promptAnswer = 'Homework Helper';
        window.__answer = { 'POST /v1/backups/restore': [{ status: 200, body: { date: '2026-10-07', running: true } }] };
        byText('#v2RecoveryPick button', 'Restore from 2026-10-07').click();
        const post = await until(() => calls('POST', /\/v1\/backups\/restore$/)[0]);
        eq('the restore, with the date chosen', post.body, { agentId: 'a1', date: '2026-10-07' });
        await until(() => !document.getElementById('v2RecoveryPick'));
        // A problem in plain words; someone who does not own the machine cannot restore.
        window.__override['/v1/backups/readiness'] = answer({ status: 'stale', line: 'Its newest backup is from 2026-10-01 (8 days ago) — left out of the last 7 backups: its machine (Laptop runner) was asleep or offline.' }, { canRestore: false });
        await v2LoadReadiness(true); openV2Agent('a1', 'advanced');
        await until(() => document.getElementById('v2RecoveryLine') && document.getElementById('v2RecoveryLine').textContent.includes('8 days ago'));
        ok('the problem in the warning colour', document.getElementById('v2RecoveryLine').classList.contains('warn'));
        ok('no Restore… for someone who does not own the machine', !document.getElementById('v2RecoveryBtn') && document.getElementById('v2RecoveryRow').textContent.includes("Only this machine's owner can restore it"));
      } finally {
        v2Close(); v2RecoveryPick = null; window.__promptAnswer = null; window.__answer = {};
        delete window.__override['/v1/backups/readiness']; v2Readiness = null; v2ReadinessAt = 0;
      }
    },
    // Another install's newer set and this install's own older one: Restore… chooses its own; the other stays listed (eighth review).
    recoveryPicksOwn: async () => {
      const agent = { agentId: 'a1', name: 'Homework Helper', hostId: 'h1', status: 'stale',
        line: 'Its newest backup is from 2026-10-06 (3 days ago). A newer copy made by another install, or under an earlier key, is from 2026-10-09.',
        latestUsable: { date: '2026-10-09', ageDays: 0, sizeBytes: 4096, complete: true, otherKey: true },
        ownLatest: { date: '2026-10-06', ageDays: 3, sizeBytes: 2048, complete: true },
        leftOut: { count: 0, of: 3, asleep: 0, failed: 0, missing: 0, other: 0 },
        restorable: [{ date: '2026-10-09', sizeBytes: 4096, complete: true, otherKey: true }, { date: '2026-10-06', sizeBytes: 2048, complete: true }] };
      const answer = (a) => ({ agents: [a], newestSet: '2026-10-08', newestFresh: true, staleDays: 2, canRestore: true, drill: { every: 'off', hours: { from: 5, to: 7 } } });
      const chosen = () => document.querySelector('#v2RecoveryPick input[name="v2RecDate"]:checked')?.value;
      window.__override['/v1/backups/readiness'] = answer(agent);
      try {
        await v2LoadReadiness(true);
        openV2Agent('a1', 'advanced');
        await until(() => document.getElementById('v2RecoveryLine') && document.getElementById('v2RecoveryLine').textContent.includes('3 days ago'));
        document.getElementById('v2RecoveryBtn').click();
        await until(() => chosen());
        eq('its own set is chosen, not the other install\'s newer one', chosen(), '2026-10-06');
        eq('the other install\'s set is still listed', [...document.querySelectorAll('#v2RecoveryPick input[name="v2RecDate"]')].map((i) => i.value), ['2026-10-09', '2026-10-06']);
        // With none of its own, the other install's is chosen (and restoring from it asks first: backupOtherKey).
        const none = { ...agent, status: 'not covered', line: 'None of this install\'s backups holds it. A copy made by another install, or under an earlier key, is from 2026-10-09.', restorable: [agent.restorable[0]] };
        delete none.ownLatest;
        v2Close(); v2RecoveryPick = null;
        window.__override['/v1/backups/readiness'] = answer(none);
        await v2LoadReadiness(true);
        openV2Agent('a1', 'advanced');
        await until(() => document.getElementById('v2RecoveryLine') && document.getElementById('v2RecoveryLine').textContent.includes('None of this install'));
        document.getElementById('v2RecoveryBtn').click();
        await until(() => chosen());
        eq('with none of its own, the other install\'s is chosen', chosen(), '2026-10-09');
      } finally {
        v2Close(); v2RecoveryPick = null;
        delete window.__override['/v1/backups/readiness']; v2Readiness = null; v2ReadinessAt = 0;
      }
    },
    // The Latest usable column is this install's own, as the Status reads it; another install's newer copy is named beside it (ninth review).
    readinessTableOwnFirst: async () => {
      window.__override['/v1/backups'] = { dir: '/backups', keepDays: 14, run: { status: 'idle' }, backups: [], missing: [] };
      window.__override['/v1/backups/readiness'] = { newestSet: '2026-10-08', newestFresh: true, staleDays: 2, canRestore: true,
        drill: { every: 'off', hours: { from: 5, to: 7 }, run: { status: 'idle' } },
        agents: [{ agentId: 'a1', name: 'Homework Helper', hostId: 'h1', status: 'stale',
          line: 'Its newest backup is from 2026-10-06 (3 days ago). A newer copy made by another install, or under an earlier key, is from 2026-10-09.',
          latestUsable: { date: '2026-10-09', ageDays: 0, sizeBytes: 4096, complete: true, otherKey: true },
          ownLatest: { date: '2026-10-06', ageDays: 3, sizeBytes: 2048, complete: true },
          leftOut: { count: 1, of: 3, asleep: 0, failed: 1, missing: 0, other: 0 } }] };
      try {
        await openAiDlg('backups');
        const row = await until(() => document.querySelector('#bkReadyTable tbody tr'));
        const cells = [...row.querySelectorAll('td')].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
        eq('its own date, with the other install\'s newer copy beside it', cells[1], '2026-10-06 (3d ago) (a newer copy from another install: 2026-10-09)');
        eq('and the Status that goes with it', cells[4], 'stale');
      } finally {
        clearTimeout(bkDrillTimer); bkDrillTimer = null; aiDlg.close(); window.__answer = {};
        delete window.__override['/v1/backups']; delete window.__override['/v1/backups/readiness']; v2Readiness = null; v2ReadinessAt = 0;
      }
    },
    readinessTable: async () => {
      window.__override['/v1/backups'] = { dir: '/backups', keepDays: 14, run: { status: 'idle' }, backups: [], missing: [] };
      window.__override['/v1/backups/readiness'] = { newestSet: '2026-10-08', newestFresh: true, staleDays: 2, canRestore: true,
        drill: { every: 'weekly', hours: { from: 5, to: 7 }, run: { status: 'idle' }, last: { at: '2026-10-05T05:20:00Z', set: '2026-10-05', passed: true, checked: 12, failed: 0, restored: 12, database: 'ok', key: 'ok' } },
        agents: [
          { agentId: 'a1', name: 'Homework Helper', hostId: 'h1', status: 'ready', line: 'Recoverable from 2026-10-08 · last drill 2026-10-05 passed',
            latestUsable: { date: '2026-10-08', ageDays: 1, sizeBytes: 2048, complete: true }, leftOut: { count: 0, of: 3, asleep: 0, failed: 0, missing: 0, other: 0 },
            drill: { at: '2026-10-05T05:20:00Z', set: '2026-10-05', passed: true, restored: true, checks: [] } },
          { agentId: 'a2', name: 'Soccer Schedule', hostId: 'h2', runner: { name: 'Laptop runner', reachable: false }, status: 'stale', line: 'Its newest backup is from 2026-10-01 (8 days ago).',
            latestUsable: { date: '2026-10-01', ageDays: 8, sizeBytes: 1024, complete: true }, leftOut: { count: 7, of: 7, asleep: 7, failed: 0, missing: 0, other: 0 } },
        ] };
      window.__answer = { 'POST /v1/backups/drill': [{ status: 200, body: { run: { status: 'running', trigger: 'app' } } }] };
      try {
        await openAiDlg('backups');
        const table = await until(() => document.getElementById('bkReadyTable'));
        const rows = [...table.querySelectorAll('tbody tr')];
        eq('one row per agent', rows.map((r) => r.dataset.agent), ['a1', 'a2']);
        eq('the columns', [...table.querySelectorAll('thead th')].map((t) => t.textContent), ['Agent', 'Latest usable', 'Left out of', 'Last drill', 'Status']);
        const cells = (r) => [...r.querySelectorAll('td')].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
        eq('a ready agent', cells(rows[0]), ['Homework Helper', '2026-10-08 (1d ago)', '—', '2026-10-05 passed', 'ready']);
        eq('one on a runner asleep', cells(rows[1]), ['Soccer Schedule (Laptop runner, not answering)', '2026-10-01 (8d ago)', '7 of 7 (machine asleep)', 'never', 'stale']);
        ok('its status in the warning colour, its line on hover', rows[1].lastElementChild.classList.contains('warn') && rows[1].lastElementChild.title.includes('8 days ago'));
        eq('the drill setting', document.getElementById('bkDrillEvery').value, 'weekly');
        const said = document.getElementById('bkDrill').textContent;
        ok('the last drill and the schedule said: ' + said, said.includes('Last drill 2026-10-05 on the 2026-10-05 backup: passed — 12 agents checked, 12 restored') && said.includes('weekly, between 05:00 and 07:00'));
        const sel = document.getElementById('bkDrillEvery');
        sel.value = 'off'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        const put = await until(() => calls('PUT', /\/v1\/backups\/drill-schedule$/)[0]);
        eq('the setting is saved', put.body, { every: 'off' });
        await until(() => document.getElementById('bkDrillEvery').value === 'weekly'); // read back (the stub still says weekly)
        document.getElementById('bkDrillBtn').click();
        await until(() => calls('POST', /\/v1\/backups\/drill$/).length === 1);
        await until(() => document.getElementById('bkDrillBtn').textContent === 'Drilling…');
        ok('the button waits while it runs', document.getElementById('bkDrillBtn').disabled);
        // HB-0353: a run that failed with no record of its own is said first, in the warning colour, not behind the older pass.
        const drill = window.__override['/v1/backups/readiness'].drill;
        renderDrillRun({ ...drill, run: { status: 'error', startedAt: Date.parse('2026-10-09T05:10:00Z'), trigger: 'app', summary: 'Restoring 12 volumes\nThe newest backup could not be read' } });
        const failed = document.getElementById('bkDrill');
        ok('the failed run first: ' + failed.textContent, failed.textContent.startsWith('The latest restore drill failed: The newest backup could not be read. Before it: Last drill 2026-10-05'));
        eq('in the warning colour', failed.style.color, 'var(--warn)');
        // A run whose own record was written is that record: the pass after it is not called a failure.
        renderDrillRun({ ...drill, run: { status: 'error', startedAt: Date.parse('2026-10-01T05:10:00Z'), trigger: 'app', summary: 'An old failure' } });
        ok('an older failed run is not said: ' + failed.textContent, failed.textContent.startsWith('Last drill 2026-10-05') && !failed.textContent.includes('old failure') && failed.style.color === '');
      } finally {
        clearTimeout(bkDrillTimer); bkDrillTimer = null; aiDlg.close(); window.__answer = {};
        delete window.__override['/v1/backups']; delete window.__override['/v1/backups/readiness']; v2Readiness = null; v2ReadinessAt = 0;
      }
    },
    recoveryAlert: async () => {
      // An agent the fresh newest set left out (2+ days without a usable copy) is under Alerts on its own
      // tile; the machine's alert no longer names it (the fold), and a failed drill is the machine's.
      const today = new Date().toISOString().slice(0, 10);
      window.__override['/v1/hosts'] = [{ id: 'h1', name: 'This machine', kind: 'local', hostname: 'home-box', agentCount: 12 }];
      window.__override['/v1/runtime'] = { imageVersion: '2026.9.6', upgradeAvailable: false };
      window.__override['/v1/backups'] = { backups: [{ date: today, hasKey: true, complete: true }], keepDays: 14,
        missing: [{ agentId: 'a2', name: 'Soccer Schedule', host: 'Laptop runner' }, { agentId: 'b9', name: 'Garden Planner', host: 'Laptop runner' }] };
      window.__override['/v1/backups/readiness'] = { newestSet: today, newestFresh: true, staleDays: 2, canRestore: true,
        drill: { every: 'off', hours: { from: 5, to: 7 }, run: { status: 'idle' }, last: { at: today + 'T05:20:00Z', set: today, passed: false, checked: 12, failed: 1, restored: 11, database: 'ok', key: 'ok' } },
        agents: [{ agentId: 'a2', name: 'Soccer Schedule', hostId: 'h2', status: 'stale', line: 'Its newest backup is from 2026-10-01 (8 days ago).',
          latestUsable: { date: '2026-10-01', ageDays: 8, sizeBytes: 1024, complete: true }, leftOut: { count: 7, of: 7, asleep: 7, failed: 0, missing: 0, other: 0 },
          alert: { key: 'recovery:2026-10-01', why: 'Its newest backup is from 2026-10-01 (8 days ago) (its settings → Advanced → Recovery)' } }] };
      const owner = myAccount.hostOwner; myAccount.hostOwner = true;
      try {
        await v2LoadReadiness(true); await v2LoadMachine(true); renderV2();
        const a2 = agents.find((a) => a.id === 'a2');
        const mine = agentAttention(a2).find((x) => x.key === 'recovery:2026-10-01');
        ok('the agent carries its own alert', mine && mine.why.includes('8 days ago'));
        ok('its tile is under Alerts: ' + v2Status(a2).label, v2Status(a2).label === 'Worth a look');
        const mgr = agents.find((a) => a.ops);
        const machine = agentAttention(mgr).filter((x) => x.icon === '💾').map((x) => x.why).join(' | ');
        ok('the machine alert still names the other left-out agent: ' + machine, machine.includes('Garden Planner (on Laptop runner) not in it'));
        ok('but not the one with its own alert (the fold): ' + machine, !machine.includes('Soccer Schedule'));
        ok('a failed drill is the machine\'s alert', machine.includes('the last restore drill (' + today + ') failed'));
        ok('the machine line still lists both', document.getElementById('v2Machine').textContent.includes('Soccer Schedule'));
      } finally {
        myAccount.hostOwner = owner;
        for (const k of ['/v1/hosts', '/v1/backups', '/v1/runtime', '/v1/backups/readiness']) delete window.__override[k];
        v2Readiness = null; v2ReadinessAt = 0; v2Machine = null; v2PaintMachine(); await refresh(false);
      }
    },
    moveNotStarted: async () => {
      // A move undone whose source did not start: stopped with a reason, on the tile, in Alerts and on its page (HB-0416).
      const reason = 'The move to Spare Box failed, and it did not start again on This machine. It is stopped there: press Start, or Rebuild if it will not start.';
      try {
        await withAgents((a) => a.id === 'a1' ? { ...a, state: 'STOPPED', stateReason: reason } : undefined);
        const a = agents.find((x) => x.id === 'a1');
        eq('the first of its alerts', agentAttention(a)[0].key, 'not-started');
        eq('its alert says what happened', agentAttention(a)[0].why, reason);
        const st = v2Status(a);
        eq('its status', st.label, 'Stopped: it did not start again');
        ok('blocked, not plain stopped', st.cls === 'blocked');
        v2SetView('attention'); await sleep(50);
        const groups = [...document.querySelectorAll('#v2groups .v2group')];
        const bin = groups.find((g) => g.querySelector('h3')?.textContent.includes('Failed'));
        ok('in the Alerts view, among the failed', !!bin && bin.textContent.includes(a.name));
        // Cleared: it goes, and its status is plain Stopped; a next state change is a new thing.
        a.attentionAck = attentionFingerprint(a);
        ok('cleared from Alerts', attentionCleared(a));
        eq('cleared, plain stopped', v2Status(a).label, 'Stopped');
        a.attentionAck = undefined;
        // Running again: the reason is gone with the state (Store.setAgentState).
        await withAgents((x) => x.id === 'a1' ? { ...x, state: 'RUNNING', stateReason: undefined } : undefined);
        const up = agents.find((x) => x.id === 'a1');
        ok('running again: no alert for it', !agentAttention(up).some((x) => x.key === 'not-started'));
        // A plain Stop has no reason, and no alert.
        await withAgents((x) => x.id === 'a1' ? { ...x, state: 'STOPPED', stateReason: undefined } : undefined);
        const plain = agents.find((x) => x.id === 'a1');
        ok('a plain stop: no alert', !agentAttention(plain).some((x) => x.key === 'not-started'));
        eq('a plain stop reads Stopped', v2Status(plain).label, 'Stopped');
        // Not yours: nothing about another's machines.
        await withAgents((x) => x.id === 'a1' ? { ...x, state: 'STOPPED', stateReason: reason, role: 'member', foreign: true } : undefined);
        const theirs = agents.find((x) => x.id === 'a1');
        ok('not yours: no alert', !agentAttention(theirs).some((x) => x.key === 'not-started'));
      } finally { await agentsCleanup(); }
    },
    alertsOrder: async () => {
      // Alerts, most urgent first: an operation held for a choice, then failures; it was ordered by
      // the bins' emoji, which put "⚠ Alerts" above "❌ Failed" and Knocking near the end (2026-10-09).
      const held = { id: 'op_h1', agentId: 'a3', kind: 'move-host', kindLabel: 'Move to another machine', status: 'held', outcome: 'The move was interrupted.',
        recovery: { actions: [{ action: 'put-back', label: 'Put it back on This machine' }] }, updatedAt: new Date().toISOString() };
      try {
        await withAgents((a) => a.id === 'a1' ? { ...a, state: 'FAILED', stateReason: 'made-up failure' }
          : a.id === 'a2' ? { ...a, rebuild: { level: 'required', reasons: ['a made-up reason'] } }
          : a.id === 'a3' ? { ...a, state: 'STOPPED', operation: held } : undefined);
        v2SetView('attention'); await sleep(50);
        const heads = [...document.querySelectorAll('#v2groups .v2group h3')].map((h) => h.textContent.trim());
        const at = (w) => heads.findIndex((h) => h.includes(w));
        ok('held for a choice comes first: ' + heads.join(' | '), at('Waiting for your choice') === 0);
        ok('then failed, then to rebuild: ' + heads.join(' | '), at('Failed') === 1 && at('To rebuild') > at('Failed'));
        ok('Fine last of the bins: ' + heads.join(' | '), at('Fine') > at('To rebuild'));
        const first = document.querySelector('#v2groups .v2group');
        ok('no Clear button on the held bin (it cannot be cleared)', !first.querySelector('button[aria-label="Clear from Alerts"]'));
        // Its sheet: the choice first among what is wrong.
        const a = agents.find((x) => x.id === 'a3');
        eq('first of its alerts', agentAttention(a)[0].key, 'op:op_h1');
      } finally { await agentsCleanup(); }
    },
  });
  // ---- What each agent can reach: the Sharing tab's Access row, Verify now, Settings → Security, Alerts (made-up data) ----
  const accIso = (m) => new Date(Date.now() - m * 60000).toISOString();
  const accOv = (fine = false) => ({
    agentId: 'a1', name: 'Homework Helper', state: 'RUNNING', checkedAt: accIso(5),
    groups: [
      { key: 'google', title: 'Google accounts', rows: [
        { kind: 'google', subject: 'school@example.org', label: 'school@example.org', intended: true, managed: true, verified: { status: 'present', at: accIso(5) }, note: 'gmail' },
        ...(fine ? [] : [{ kind: 'google', subject: 'old@example.org', label: 'old@example.org', intended: false, managed: true, verified: { status: 'present', at: accIso(5) }, pendingRemoval: { since: accIso(3000) }, mismatch: 'stale-removal' }]),
        { kind: 'google', subject: 'self@example.org', label: 'self@example.org', intended: false, managed: false, verified: { status: 'present', at: accIso(5) }, note: 'added inside the agent' },
      ] },
      { key: 'env', title: 'Environment variables (names only)', rows: [
        { kind: 'env', subject: 'SEARCH_KEY', label: 'SEARCH_KEY', intended: true, managed: true, verified: fine ? { status: 'present', at: accIso(0) } : { status: 'unknown' } },
      ] },
    ],
    notChecked: ['Keys, passwords or accounts the agent saved for itself in its workspace are not checked.'],
    summary: { mismatches: fine ? 0 : 1, missing: 0, pending: fine ? 0 : 1, rows: fine ? 3 : 4 },
  });
  const accRows = () => [...document.querySelectorAll('#v2Access .v2accrow')];
  const accRow = (label) => accRows().find((r) => r.textContent.includes(label));
  Object.assign(T, {
    accessSection: async () => {
      window.__override['/v1/agents/a1/access'] = accOv();
      v2AccessCache = null;
      try {
        openV2Agent('a1', 'sharing');
        await until(() => accRows().length === 4);
        eq('it asked for this agent\'s access', calls('GET', /^\/v1\/agents\/a1\/access$/).length >= 1, true);
        const k = [...document.querySelectorAll('#v2Pane .v2k')].map((x) => x.textContent);
        ok('one Access row on the Sharing tab: ' + k.join('|'), k.filter((x) => x === 'Access').length === 1);
        ok('a stale removal is ⚠ with its words', accRow('old@example.org').querySelector('.warn')?.textContent === '⚠' && accRow('old@example.org').textContent.includes('removal pending over a day'));
        ok('an account the agent added itself is "not managed", marked ?', accRow('self@example.org').textContent.includes('not managed') && !accRow('self@example.org').querySelector('.warn'));
        ok('a found account is ✓ with its time', accRow('school@example.org').textContent.includes('✓') && accRow('school@example.org').textContent.includes('m ago'));
        ok('a variable not checked yet is ?', accRow('SEARCH_KEY').textContent.includes('?'));
        const box = document.getElementById('v2Access');
        ok('the limits are said: ' + box.textContent.slice(0, 120), box.textContent.includes('Not checked:') && box.textContent.includes('saved for itself'));
        ok('the summary line counts the problem', document.getElementById('v2AccessWhen').textContent.includes('1 it should not have'));
        ok('Verify now is there', !!document.getElementById('v2AccessVerify'));
        // A line a thing (2026-10-25): the row's grey parts were each pushed to a line of their own,
        // which squeezed its words to one a line. Its mark, words and time sit side by side now.
        const line = accRow('self@example.org'), [mk, words, when] = line.children;
        const top = (el) => el.getBoundingClientRect().top, wide = (el) => el.getBoundingClientRect().width;
        ok('mark, words and time on one line: ' + [mk, words, when].map((el) => Math.round(top(el))), Math.abs(top(words) - top(when)) < 6 && Math.abs(top(mk) - top(words)) < 6);
        ok('the words have most of the row: ' + Math.round(wide(words)) + ' of ' + Math.round(wide(line)), wide(words) > wide(line) * 0.6);
        const vb = document.getElementById('v2AccessVerify').getBoundingClientRect(), wb = document.getElementById('v2AccessWhen').getBoundingClientRect();
        ok('Verify now sits beside the summary line', vb.top < wb.bottom && vb.bottom > wb.top);
        v2Close();
      } finally { delete window.__override['/v1/agents/a1/access']; v2AccessCache = null; if (v2AgentDlg.open) v2Close(); }
    },
    accessVerifyNow: async () => {
      const toastText = () => document.getElementById('toast').textContent;
      window.__override['/v1/agents/a1/access'] = accOv();
      window.__answer = window.__answer || {};
      v2AccessCache = null;
      try {
        openV2Agent('a1', 'sharing');
        await until(() => accRows().length === 4);
        window.__answer['POST /v1/agents/a1/access/verify'] = [{ body: { result: { status: 'checked', at: accIso(0), checked: 3 }, access: accOv(true) } }];
        document.getElementById('v2AccessVerify').click();
        await until(() => accRows().length === 3);
        eq('Verify now asked once', calls('POST', /^\/v1\/agents\/a1\/access\/verify$/).length, 1);
        ok('the fresh result is drawn: no ⚠ left', !document.querySelector('#v2Access .v2accrow .warn'));
        ok('the toast says it matches: ' + toastText(), toastText().includes('matches what Hatchabot gave it'));
        // A stopped agent: not checkable, the reason said, the last results stay.
        window.__answer['POST /v1/agents/a1/access/verify'] = [{ body: { result: { status: 'not-checkable', reason: 'it is stopped — start it to check' }, access: accOv(true) } }];
        document.getElementById('v2AccessVerify').click();
        await until(() => toastText().includes('Not checked: it is stopped'));
        ok('the button comes back', await until(() => !document.getElementById('v2AccessVerify').disabled && document.getElementById('v2AccessVerify').textContent === 'Verify now'));
        ok('the last results stay', accRows().length === 3);
        v2Close();
      } finally { delete window.__override['/v1/agents/a1/access']; delete window.__answer['POST /v1/agents/a1/access/verify']; v2AccessCache = null; if (v2AgentDlg.open) v2Close(); }
    },
    accessMachineView: async () => {
      const fineB = { ...accOv(true), agentId: 'a2', name: 'Soccer Schedule' };
      window.__override['/v1/access'] = { agents: [accOv(), fineB] };
      try {
        await openAiDlg('security');
        const list = () => [...document.querySelectorAll('#accessMapOut details.v2accagent')];
        await until(() => list().length === 2);
        eq('problems first, as the server ordered', list().map((d) => d.dataset.agent), ['a1', 'a2']);
        ok('the one with a problem is open, marked ⚠', list()[0].open && list()[0].querySelector('summary').textContent.includes('⚠') && list()[0].querySelector('summary').textContent.includes('1 it should not have'));
        ok('the fine one is closed, marked ✓', !list()[1].open && list()[1].querySelector('summary').textContent.includes('✓'));
        ok('its rows are inside', list()[0].querySelectorAll('.v2accrow').length === 4);
        byText('#accessMapOut button', 'Open its Sharing tab').click();
        ok('it opens that agent on its Sharing tab', v2AgentDlg.open && v2AgentId === 'a1' && v2Tab === 'sharing' && !aiDlg.open);
        v2Close();
      } finally { delete window.__override['/v1/access']; if (aiDlg.open) aiDlg.close(); if (v2AgentDlg.open) v2Close(); }
    },
    recommended: async () => {
      // Recommended at the top of Usage (made-up items, in the server's order).
      const loop = { id: 'loop:ti_9', kind: 'loop', agents: [{ id: 'a1', name: 'Homework Helper' }], title: 'Homework Helper is stuck in a loop',
        concern: 'Scheduled task "Quiz" failed 9 runs in a row (last 08:19) — which is also why it passed $50 this month',
        evidence: ['9 times since 06:10', '≈ $6.00 in the last 4 hours at API prices'], effect: { text: 'stops ≈ $36 a day', usdPerDay: 36, billing: 'api' },
        action: { kind: 'pause-task', label: 'Pause the task', method: 'PATCH', path: '/v1/agents/a1/crons/job-9', body: { enabled: false } },
        secondary: [{ kind: 'open-agent', label: 'Details', agentId: 'a1' }], alert: true, rank: { group: 1, money: 1080 }, fingerprint: 'ti_9' };
      const card = { id: 'cheaper:a9', kind: 'cheaper-model', agents: [{ id: 'a9', name: 'Stock Watcher' }], title: 'Stock Watcher could use a cheaper model',
        concern: '412 turns in 30 days, 0.3 tools per turn, no errors: claude-haiku-4-5 would cost ≈ $31 a month less on its own mix',
        evidence: ['Evidence: ok — 412 turns on claude-sonnet-5 over 30 days', 'Its reason: “mostly price lookups”'], effect: { text: '≈ $31 a month', usdPerMonth: 31, billing: 'api' },
        action: { kind: 'confirm-card', label: 'Switch to claude-haiku-4-5', method: 'POST', path: '/v1/proposals/c9/confirm', body: {} },
        secondary: [{ kind: 'open-agent', label: 'Details', agentId: 'a9' }], proposedBy: 'agent', proposalId: 'c9', rank: { group: 6, money: 31 }, fingerprint: 'x' };
      const conv = { id: 'conversation:a8', kind: 'big-conversation', agents: [{ id: 'a8', name: 'Budget Tracker' }], title: "Budget Tracker's conversation is 310K tokens",
        concern: 'every call carries all of it', evidence: ['300 calls in 30 days'], effect: { text: '≈ 58% fewer tokens per call: ≈ $12 a month', billing: 'api' },
        action: { kind: 'compact', label: 'Compact it now', method: 'POST', path: '/v1/agents/a8/compact', body: { mode: 'summarise' }, confirm: 'Compact it now?' },
        secondary: [{ kind: 'context-cap', label: 'Cap it at 150K', method: 'PUT', path: '/v1/agents/a8/context-cap', body: { tokens: 150000 } }], rank: { group: 6, money: 12 }, fingerprint: 'now:6:0' };
      window.__override['/v1/recommendations'] = { items: [loop, card, conv], dismissed: 0 };
      window.__answer = { 'POST /v1/proposals/c9/confirm': [{ status: 200, body: { done: true, text: '✅ Switched.' } }] };
      try {
        openFleetUsage();
        const sec = await until(() => document.querySelector('#fleetRecommended .rec-item') && document.getElementById('fleetRecommended'));
        ok('above the figures', !sec.hidden && (sec.compareDocumentPosition(document.getElementById('fleetUsageBody')) & Node.DOCUMENT_POSITION_FOLLOWING));
        ok('a heading with the count', sec.querySelector('h4').textContent.includes('Recommended · 3'));
        const items = [...sec.querySelectorAll('.rec-item')];
        eq('in the server\'s order', items.map((x) => x.dataset.rec), ['loop:ti_9', 'cheaper:a9', 'conversation:a8']);
        ok('the concern, the evidence and the expected effect', items[0].textContent.includes('Homework Helper is stuck in a loop') && items[0].textContent.includes('9 times since 06:10') && items[0].querySelector('.rec-effect').textContent.includes('Expected effect: stops ≈ $36 a day'));
        ok('what needs you now stands out', items[0].classList.contains('rec-now') && !items[1].classList.contains('rec-now'));
        ok("the agent's proposal says so", items[1].textContent.includes('Proposed by your Hatchabot agent') && items[1].textContent.includes('Its reason: “mostly price lookups”'));
        eq('one primary button, Details, Not now', [...items[0].querySelectorAll('button')].map((b) => [b.textContent, b.classList.contains('primary')]), [['Pause the task', true], ['Details', false], ['Not now', false]]);
        // The loop's button: the cron route, marked as the recommendation's.
        let mark = window.__calls.length;
        items[0].querySelector('button.primary').click();
        const patch = await until(() => window.__calls.slice(mark).find((c) => c.method === 'PATCH' && c.path === '/v1/agents/a1/crons/job-9'));
        eq('the task is turned off', patch.body, { enabled: false });
        eq('the request says which item', patch.headers['x-hatchabot-recommendation'], 'loop:ti_9');
        // A card item's button confirms the card.
        mark = window.__calls.length;
        document.querySelector('#fleetRecommended [data-rec="cheaper:a9"] button.primary').click();
        const conf = await until(() => window.__calls.slice(mark).find((c) => c.method === 'POST' && c.path === '/v1/proposals/c9/confirm'));
        eq('the same click, marked', conf.headers['x-hatchabot-recommendation'], 'cheaper:a9');
        // A compaction asks first; No sends nothing.
        window.__confirmAnswer = false;
        mark = window.__calls.length;
        document.querySelector('#fleetRecommended [data-rec="conversation:a8"] button.primary').click();
        await sleep(100);
        ok('asked before compacting', window.__confirms.at(-1) === 'Compact it now?');
        ok('and No sent nothing', !window.__calls.slice(mark).some((c) => c.path === '/v1/agents/a8/compact'));
        window.__confirmAnswer = true;
        // Yes: it starts in the background, and the card says it is running instead
        // of offering the button again (a second click got "Already compacted",
        // 2026-10-10).
        const compacting = { ...conv, title: 'Budget Tracker\'s conversation is being compacted', concern: 'started at 4:30 PM; summarising 310K tokens takes a few minutes, and the result goes to your chat',
          evidence: [], effect: { text: 'Nothing to do: it finishes by itself', usdPerMonth: 0, billing: 'api' }, action: { kind: 'open-agent', label: 'Details', agentId: 'a8' }, secondary: [], fingerprint: 'compacting:x' };
        window.__answer['POST /v1/agents/a8/compact'] = [{ status: 200, body: { background: true, message: 'Compaction of "Budget Tracker" started; summarising a 310K conversation can take several minutes. The result goes to the owner\'s chat and the token ledger.' } }];
        window.__override['/v1/recommendations'] = { items: [loop, card, compacting], dismissed: 0 };
        mark = window.__calls.length;
        document.querySelector('#fleetRecommended [data-rec="conversation:a8"] button.primary').click();
        await until(() => window.__calls.slice(mark).some((c) => c.method === 'POST' && c.path === '/v1/agents/a8/compact'));
        const running = await until(() => { const el = document.querySelector('#fleetRecommended [data-rec="conversation:a8"]'); return el?.textContent.includes('being compacted') && el; });
        ok('the card says it is being compacted', running.textContent.includes('the result goes to your chat'));
        ok('and offers no Compact button', ![...running.querySelectorAll('button')].some((b) => /Compact/.test(b.textContent)));
        window.__override['/v1/recommendations'] = { items: [loop, card, conv], dismissed: 0 };
        await loadRecommended('', true);
        // Not now on the card item: the card is cancelled and the item put away.
        mark = window.__calls.length;
        const nn = [...document.querySelectorAll('#fleetRecommended [data-rec="cheaper:a9"] button')].find((b) => b.textContent === 'Not now');
        nn.click();
        await until(() => window.__calls.slice(mark).some((c) => c.method === 'POST' && c.path === '/v1/recommendations/' + encodeURIComponent('cheaper:a9') + '/dismiss'));
        ok('its card cancelled first', window.__calls.slice(mark).some((c) => c.method === 'POST' && c.path === '/v1/proposals/c9/cancel'));
        // Details: the agent's sheet.
        window.__override['/v1/recommendations'] = { items: [loop], dismissed: 1 };
        await loadRecommended('', true);
        [...document.querySelectorAll('#fleetRecommended [data-rec="loop:ti_9"] button')].find((b) => b.textContent === 'Details').click();
        await until(() => v2AgentDlg.open);
        ok('Details opens the agent', v2AgentId === 'a1' && !fleetUsageDlg.open);
        v2Close();
        // Nothing to recommend: one quiet line.
        window.__override['/v1/recommendations'] = { items: [], dismissed: 0 };
        openFleetUsage();
        await until(() => document.getElementById('fleetRecommended').textContent.includes('Nothing to change right now'));
        fleetUsageDlg.close();
        // The agent's own items on its Usage tab; its "Details" there would only reopen the same tab.
        window.__override['/v1/agents/a1/recommendations'] = { items: [{ ...loop, secondary: [{ kind: 'open-usage', label: 'Details', agentId: 'a1' }] }] };
        openV2Agent('a1', 'usage');
        const tab = await until(() => document.querySelector('#v2RecBody .rec-item') && document.getElementById('v2RecBody'));
        ok('its items on its Usage tab', !tab.hidden && tab.textContent.includes('Homework Helper is stuck in a loop'));
        eq('no Details back to the same tab', [...tab.querySelectorAll('button')].map((b) => b.textContent), ['Pause the task', 'Not now']);
        v2Close();
      } finally {
        if (fleetUsageDlg.open) fleetUsageDlg.close(); if (v2AgentDlg.open) v2Close();
        window.__answer = {}; window.__confirmAnswer = true;
        delete window.__override['/v1/recommendations']; delete window.__override['/v1/agents/a1/recommendations']; v2RecCache.clear();
      }
    },
    alertsMoney: async () => {
      // Alerts keeps a live loop, a budget at 100% and today's spike — one line each, linked to its item — and orders an agent's lines by severity.
      // (It was also called alertsOrder, which silently replaced phase 3's scenario of that name.)
      const month = new Date().toISOString().slice(0, 7);
      // The page keeps an agent's Recommended list 30 s; one an earlier scenario left would hide this one's items.
      if (typeof v2RecCache !== 'undefined') v2RecCache.clear();
      try {
        await withAgents((a) => a.id === 'a1' ? { ...a, memoryCapHits: 3, diskOver: { bytes: 12e9, warnBytes: 10e9 },
            stuck: [{ id: 'ti_7', kind: 'task-failing', text: 'Scheduled task "Quiz" failed 9 runs in a row' }],
            spike: { at: new Date().toISOString(), tokens: 120e6, usual: 20e6 },
            budget: { scope: a.id, usd: 50, atLimit: 'warn', month, spent: 41, pct: 82, level: 80, resetsOn: 'next 1st', line: 'Used 82% of its $50 budget for this month ($41.00)' },
            spendStep: { every: 25, month, spent: 41, passed: 1, next: 50, line: 'Spent $41.00 in this month — you hear every $25 (next at $50)' } }
          : a.id === 'a2' ? { ...a, spike: { at: new Date().toISOString(), tokens: 60e6, usual: 10e6 } } : undefined);
        const keys = agentAttention(agents.find((x) => x.id === 'a1')).map((x) => x.key.split(':')[0]);
        eq('the loop first, then the spike, then the rest — not code order', keys, ['stuck', 'spike', 'memory', 'disk']);
        ok('the tooltip leads with the loop', tipText('Homework Helper').indexOf('Scheduled task "Quiz"') < tipText('Homework Helper').indexOf('120M tokens'));
        // A spike alone puts an agent under Alerts (spikes never reached Alerts before).
        const spike = agentAttention(agents.find((x) => x.id === 'a2'));
        ok("today's spike is an Alert: " + JSON.stringify(spike.map((x) => x.why)), spike.length === 1 && spike[0].why.includes('60M tokens in the last 24 hours') && spike[0].why.includes('about 6× its usual day') && spike[0].rec === 'spike:a2');
        v2SetView('attention'); await sleep(50);
        const sec = [...document.querySelectorAll('#v2groups .v2group')].find((g) => g.querySelector('h3').textContent.includes('Alerts'));
        ok('Soccer Schedule is under Alerts for its spike', [...sec.querySelectorAll('.v2agent .v2name')].some((n) => n.textContent === 'Soccer Schedule'));
        // With the budget at 100% it is an Alert, after the loop and before the spike.
        await withAgents((a) => a.id === 'a1' ? { ...a, stuck: [{ id: 'ti_7', kind: 'task-failing', text: 'Scheduled task "Quiz" failed 9 runs in a row' }],
          spike: { at: new Date().toISOString(), tokens: 120e6, usual: 20e6 }, memoryCapHits: 3,
          budget: { scope: a.id, usd: 50, atLimit: 'warn', month, spent: 55, pct: 110, level: 100, resetsOn: 'next 1st', line: 'Over its $50 budget for this month: $55.00 so far' } } : undefined);
        eq('loop, budget at 100%, spike, the rest', agentAttention(agents.find((x) => x.id === 'a1')).map((x) => x.key.split(':')[0]), ['stuck', 'budget', 'spike', 'memory', 'disk']);
        // The Overview's line links to the item, on the agent's Usage tab.
        window.__override['/v1/agents/a1/recommendations'] = { items: [{ id: 'loop:ti_7', kind: 'loop', agents: [{ id: 'a1', name: 'Homework Helper' }], title: 'Homework Helper is stuck in a loop', concern: 'Scheduled task "Quiz" failed 9 runs in a row', evidence: [], secondary: [], alert: true, rank: { group: 1, money: 0 }, fingerprint: 'ti_7' }] };
        openV2Agent('a1', 'overview');
        const link = await until(() => [...document.querySelectorAll('.v2why li')].find((li) => li.textContent.includes('Scheduled task "Quiz"'))?.querySelector('button'));
        ok('a Recommended link beside the loop line', link.textContent.includes('Recommended'));
        ok('none beside the memory line', ![...document.querySelectorAll('.v2why li')].find((li) => li.textContent.includes('memory cap'))?.querySelector('button'));
        link.click();
        const item = await until(() => document.querySelector('#v2RecBody [data-rec="loop:ti_7"]'));
        ok('it opens the Usage tab with the item marked', v2Tab === 'usage' && item.classList.contains('rec-focus'));
        v2Close();
      } finally { if (v2AgentDlg.open) v2Close(); delete window.__override['/v1/agents/a1/recommendations']; v2RecCache.clear(); await agentsCleanup(); }
    },
    accessAlerts: async () => {
      const line = 'It can still reach what it should not: old@example.org: removal still pending since 2026-10-01 (Sharing → Access)';
      try {
        await withAgents((a) => a.id === 'a1' ? { ...a, accessAlert: { key: 'access:google=old@example.org:stale-removal', line } } : undefined);
        const a = agents.find((x) => x.id === 'a1');
        const al = agentAttention(a).find((x) => x.key.startsWith('access:'));
        ok('an Alerts line for it', !!al && al.why === line);
        v2SetView('attention'); await sleep(50);
        const fine = [...document.querySelectorAll('#v2groups .v2group')].find((g) => g.querySelector('h3')?.textContent.includes('Fine'));
        ok('it is not among the fine ones', !fine || !fine.textContent.includes('Homework Helper'));
        ok('it is under Alerts', [...document.querySelectorAll('#v2groups .v2group')].some((g) => !g.querySelector('h3')?.textContent.includes('Fine') && g.textContent.includes('Homework Helper')));
      } finally { await agentsCleanup(); }
    },
    filesFolderRaceAndUploads: async () => {
      // Files (made-up data): a slow read of the folder left behind lands last (#94); a folder
      // named .openclaw-something is not OpenClaw's state (#117); each failed upload's reason
      // stays after the folder is drawn again (#118).
      const realFetch = window.fetch;
      let release; const held = new Promise((r) => { release = r; });
      let holdOld = true;
      window.fetch = async (input, init = {}) => {
        const url = String(typeof input === 'string' ? input : input.url);
        const [path, qs] = url.split('?');
        if (path === '/v1/agents/a1/fs' && (init.method || 'GET').toUpperCase() === 'GET') {
          const p = new URLSearchParams(qs || '').get('path') || '';
          window.__calls.push({ method: 'GET', path, url });
          if (p === 'old' && holdOld) { holdOld = false; await held; }
          const entries = [{ name: 'in-' + (p || 'home').replace(/\W/g, '-') + '.md', type: 'file', size: 1, mtime: '' }];
          return new Response(JSON.stringify({ path: p, entries }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return realFetch(input, init);
      };
      try {
        openV2Agent('a1', 'files');
        await until(() => $('v2Files')?.textContent.includes('in-home.md'));
        const slow = v2LoadFiles('a1', 'old');
        await until(() => !holdOld);
        await v2LoadFiles('a1', 'new');
        release(); await slow; await sleep(50);
        ok('the folder opened last stays shown: ' + $('v2Files').textContent.slice(0, 120), $('v2Files').textContent.includes('in-new.md') && !$('v2Files').textContent.includes('in-old.md'));
        eq('and is the one remembered', v2FilesPath.get('a1'), 'new');
        await v2LoadFiles('a1', '.openclaw-notes');
        ok('uploads are offered in .openclaw-notes', !!byText('#v2Files button', 'Upload'));
        await v2LoadFiles('a1', '.openclaw');
        ok('but not in .openclaw itself', !byText('#v2Files button', 'Upload'));
        await v2LoadFiles('a1', 'inbox');
        window.__answer = { 'PUT /v1/agents/a1/fs/file': [{ status: 413, body: { error: 'Too big (300 MB; the limit is 200 MB — HATCHABOT_FILE_MAX_MB).' } }, { status: 200, body: { ok: true } }] };
        await v2UploadFiles('a1', 'inbox', [new File(['x'], 'huge.zip'), new File(['y'], 'notes.txt')]);
        const note = $('v2UploadNote');
        ok('the count and the reason, after the redraw: ' + note.textContent, !note.hidden && note.textContent.includes('1 of 2 uploaded') && note.textContent.includes('huge.zip: Too big (300 MB'));
      } finally { window.fetch = realFetch; release?.(); window.__answer = {}; if (v2AgentDlg.open) v2Close(); v2FilesPath.delete('a1'); }
    },
    reportDraftRaceAndDiscard: async () => {
      // Report a problem (made-up drafts): the draft clicked last is the one shown, even when the
      // first one's load comes back later (#146); a discard that failed keeps the draft (#145).
      const A = 'aa11bb22-3333-4444-8555-000000000001', B = 'aa11bb22-3333-4444-8555-000000000002';
      const view = (id, title) => ({ id, title, body: '### What happened\nIt stopped.', createdAt: new Date().toISOString(), by: 'person',
        issueUrl: 'https://github.com/hatchabot/hatchabot/issues/new?labels=field-report', trimmed: false, fileName: 'hatchabot-report-x.md' });
      window.__override['/v1/problem-reports'] = [];
      window.__override['/v1/problem-reports/' + A] = view(A, 'Backups stopped');
      window.__override['/v1/problem-reports/' + B] = view(B, 'Uploads fail');
      const realFetch = window.fetch;
      let release; const held = new Promise((r) => { release = r; });
      let holdA = true;
      window.fetch = async (input, init = {}) => {
        const path = String(typeof input === 'string' ? input : input.url).split('?')[0];
        if (path === '/v1/problem-reports/' + A && (init.method || 'GET').toUpperCase() === 'GET' && holdA) { holdA = false; await held; }
        return realFetch(input, init);
      };
      try {
        await openReport();
        const slow = reportShow(A);
        await until(() => !holdA);
        await reportShow(B);
        release(); await slow;
        eq('the draft chosen last is shown', $('reportRTitle').value, 'Uploads fail');
        eq('and is the one acted on', reportCur?.id, B);
        window.__confirmAnswer = true;
        window.__answer = { ['DELETE /v1/problem-reports/' + B]: [{ status: 500, body: { error: 'database is locked' } }, { status: 404, body: { error: 'Not found' } }] };
        await reportDiscard();
        ok('a failed discard keeps the draft shown', reportCur?.id === B && !$('reportReview').hidden);
        ok('and says so: ' + $('toast').textContent, $('toast').textContent.includes('not discarded') && $('toast').textContent.includes('database is locked'));
        await reportDiscard();
        ok('one already gone counts as discarded', reportCur === null && $('reportReview').hidden);
      } finally {
        window.fetch = realFetch; release?.(); window.__answer = {}; window.__confirmAnswer = true;
        for (const k of ['/v1/problem-reports', '/v1/problem-reports/' + A, '/v1/problem-reports/' + B]) delete window.__override[k];
        if (reportDlg.open) reportDlg.close();
      }
    },
    chanConnectorsRetry: async () => {
      // The connector list failing once is not kept: trying again works without a reload (#144).
      const [first] = agents.filter((x) => x.name && !x.ops);
      window.__override['/v1/discord-bots'] = { bots: [] };
      chanFields = undefined;
      try {
        window.__answer = { 'GET /v1/channels/connectors': [{ status: 503, body: { error: 'busy' } }] };
        await openChanSetup(first.id, 'discord');
        ok('told to try again: ' + $('toast').textContent, $('toast').textContent.includes('try again') && !chanDlg.open);
        window.__override['/v1/channels/connectors'] = [{ kind: 'discord', label: 'Discord', fields: [{ key: 'botToken', label: 'Bot token', pattern: '^.{20,}$', help: 'token' }] }];
        await openChanSetup(first.id, 'discord');
        await until(() => chanDlg.open);
        ok('the second try opens the steps', chanDlg.open && $('chanBody').textContent.includes(first.name));
      } finally {
        window.__answer = {}; chanFields = undefined;
        delete window.__override['/v1/discord-bots']; delete window.__override['/v1/channels/connectors'];
        if (chanDlg.open) chanDlg.close();
      }
    },
  });
  // Audit, 2026-10-20 (made-up data): a revert that runs in the background reloads the editor
  // when it ends; a file's own links ask for the second factor; Backups for a member.
  Object.assign(T, {
    revertSnapshotInBackground: async () => {
      window.__override['/v1/agents/a1/snapshots'] = [{ id: 's2', label: 'before the trip', createdAt: new Date().toISOString(), files: ['SOUL.md', 'AGENTS.md', 'MEMORY.md'], reason: 'manual' }];
      window.__override['/v1/agents/a1/files/SOUL.md'] = { content: 'old soul' };
      const op = { id: 'op_rv1', agentId: 'a1', kind: 'snapshot-restore', title: 'Reverting to a snapshot', status: 'running', requestedAt: new Date().toISOString() };
      window.__answer = { 'POST /v1/agents/a1/snapshots/s2/restore': [{ status: 202, body: { operation: op } }] };
      const reads = () => calls('GET', /\/v1\/agents\/a1\/files\/SOUL\.md$/).length;
      try {
        editAgentId = 'a1'; $('editFile').value = 'SOUL.md';
        await loadEditFile(); await loadSnapshots();
        ok('loaded first', $('editContent').value === 'old soul' && !$('editSaveBtn').disabled);
        const before = reads();
        const btn = await until(() => [...document.querySelectorAll('#snapList button')].find((b) => b.textContent === 'Revert' && /s2/.test(b.getAttribute('onclick'))));
        btn.click();
        await until(() => $('editErr').textContent.includes('reloads when it is done'));
        eq('not read again while it runs', reads(), before);
        ok('Save is off until it has been read again', $('editSaveBtn').disabled && editLoaded === null);
        ok('followed', v2Ops.has('op_rv1'));
        // It ends: the editor reads the reverted text, and Save is back.
        window.__override['/v1/agents/a1/files/SOUL.md'] = { content: 'reverted soul' };
        window.__answer['GET /v1/operations/op_rv1'] = [{ body: { ...op, status: 'succeeded', outcome: 'Reverted SOUL.md, AGENTS.md, MEMORY.md.', finishedAt: new Date().toISOString() } }];
        await v2OpTick();
        await until(() => $('editContent').value === 'reverted soul');
        ok('Save is back on', !$('editSaveBtn').disabled && editLoaded?.file === 'SOUL.md');
        ok('the hook ran once and is gone', !v2OpEnds.has('op_rv1'));
      } finally {
        window.__answer = {}; v2Ops.clear(); v2OpEnds.clear();
        for (const k of ['/v1/agents/a1/snapshots', '/v1/agents/a1/files/SOUL.md']) delete window.__override[k];
      }
    },
    filesLinksSecondFactor: async () => {
      // The viewer's Open in a tab and its ⬇ ask for the second factor at the public address, as the .tar.gz links do.
      // Every file the browser can show opens in the tab itself (filesSortAndOpenInPlace, filesMediaOpenInPlace);
      // the viewer's Open in a tab is what still goes to a new tab, by sfOpen.
      window.__override['/v1/agents/a1/fs'] = { path: 'notes', entries: [{ name: 'packing-list.pdf', type: 'file', size: 12, mtime: '' }] };
      window.__override['/v1/second-factor'] = { factors: [{ id: 'sf-1', kind: 'totp' }], backupCodes: 3, need: 'yes', methods: ['totp', 'backup'], passkeyHere: false };
      const STEP = { status: 401, body: { error: 'second factor required', secondFactor: 'step-up' } };
      const pub = appConfig.publicAddress, realOpen = window.open;
      const opened = []; window.open = (url, target) => { opened.push([url, target]); return {}; };
      try {
        openV2Agent('a1', 'files');
        await v2LoadFiles('a1', 'notes');
        const row = await until(() => [...document.querySelectorAll('#v2Files a')].find((x) => x.textContent === 'packing-list.pdf'));
        ok('the name opens the file here, not by a new tab', /v2OpenFile\(/.test(row.getAttribute('onclick') || '') && !row.target);
        row.click();
        const name = await until(() => byText('#v2Files a', 'Open in a tab'));
        const down = [...document.querySelectorAll('#v2Files a.btn')].find((x) => x.textContent === '⬇');
        ok('the ⬇ goes by sfLink: ' + down?.getAttribute('onclick'), /sfLink\(event, this, 'packing-list\.pdf'\)/.test(down?.getAttribute('onclick') || ''));
        ok('Open in a tab goes by sfOpen', /^return sfOpen\(/.test(name.getAttribute('onclick') || ''));
        let prevented = false; const ev = { preventDefault: () => { prevented = true; } };
        appConfig.publicAddress = false;
        ok('a plain link at the private address', sfOpen(ev, name, '/v1/agents/a1/fs?path=notes') === true && !prevented);
        appConfig.publicAddress = true;
        window.__answer = { 'GET /v1/agents/a1/fs': [STEP] };
        ok('held at the public address', sfOpen(ev, name, '/v1/agents/a1/fs?path=notes') === false && prevented);
        await until(() => sfDlg.open);
        ok('no tab yet', opened.length === 0);
        sfDone();
        await until(() => opened.length === 1);
        eq('then the file opens in a new tab', opened[0], [name.getAttribute('href'), '_blank']);
        // Cancelled: no tab, and said.
        window.__answer = { 'GET /v1/agents/a1/fs': [STEP] };
        sfOpen(ev, name, '/v1/agents/a1/fs?path=notes');
        await until(() => sfDlg.open);
        byText('#sfDlg button', 'Cancel').click();
        await until(() => $('toast').textContent.includes('The second factor was not given'));
        eq('still one tab', opened.length, 1);
        // The ⬇ at the public address is fetched, so it can ask.
        window.__answer = { 'GET /v1/agents/a1/fs/file': [STEP] };
        down.click();
        await until(() => sfDlg.open);
        byText('#sfDlg button', 'Cancel').click();
        ok('the file was asked for', calls('GET', /\/v1\/agents\/a1\/fs\/file$/).length >= 1);
      } finally {
        appConfig.publicAddress = pub; window.open = realOpen; window.__answer = {};
        delete window.__override['/v1/agents/a1/fs']; delete window.__override['/v1/second-factor'];
        if (sfDlg.open) sfDlg.close();
        if (v2AgentDlg.open) v2Close(); v2FilesPath.delete('a1');
      }
    },
    backupsForMember: async () => {
      // Someone who is not the machine's owner: no Back up now, drills or sets (each answers 403), the table and a line instead.
      window.__override['/v1/backups/readiness'] = { newestSet: '2026-10-18', newestFresh: true, staleDays: 2, canRestore: false,
        drill: { every: 'weekly', hours: { from: 5, to: 7 } },
        agents: [{ agentId: 'a1', name: 'Homework Helper', hostId: 'h1', status: 'ready', line: 'Recoverable from 2026-10-18',
          latestUsable: { date: '2026-10-18', ageDays: 1, sizeBytes: 2048, complete: true }, leftOut: { count: 0, of: 3, asleep: 0, failed: 0, missing: 0, other: 0 } }] };
      const owner = myAccount.hostOwner; myAccount.hostOwner = false;
      const before = calls('GET', /^\/v1\/backups$/).length;
      try {
        await openAiDlg('backups');
        await until(() => document.getElementById('bkReadyTable'));
        ok('the line saying who runs them', !$('bkOwnerOnly').hidden && $('bkOwnerOnly').textContent.includes("machine's owner"));
        for (const id of ['bkRunRow', 'bkDrillRow', 'bkDrill', 'bkSetsHead', 'bkList']) ok(id + ' is hidden', $(id).hidden);
        eq('the sets are not asked for', calls('GET', /^\/v1\/backups$/).length, before);
        aiDlg.close();
        // The owner sees them again.
        myAccount.hostOwner = true;
        await openAiDlg('backups');
        ok('back for the owner', !$('bkRunRow').hidden && !$('bkDrillRow').hidden && !$('bkList').hidden && $('bkOwnerOnly').hidden);
      } finally {
        myAccount.hostOwner = owner; clearTimeout(bkDrillTimer); bkDrillTimer = null; aiDlg.close();
        delete window.__override['/v1/backups/readiness']; v2Readiness = null; v2ReadinessAt = 0;
      }
    },
    revertHoldsThroughBlipAndPicker: async () => {
      // A poll that fails is not the end of the revert, and picking another file meanwhile keeps Save off (regression audit, 2026-10-22).
      window.__override['/v1/agents/a1/snapshots'] = [{ id: 's3', label: 'before the move', createdAt: new Date().toISOString(), files: ['SOUL.md', 'AGENTS.md'], reason: 'manual' }];
      window.__override['/v1/agents/a1/files/SOUL.md'] = { content: 'old soul' };
      window.__override['/v1/agents/a1/files/AGENTS.md'] = { content: 'old agents' };
      const op = { id: 'op_rv2', agentId: 'a1', kind: 'snapshot-restore', title: 'Reverting to a snapshot', status: 'running', requestedAt: new Date().toISOString() };
      window.__answer = { 'POST /v1/agents/a1/snapshots/s3/restore': [{ status: 202, body: { operation: op } }] };
      try {
        editAgentId = 'a1'; $('editFile').value = 'SOUL.md';
        await loadEditFile(); await loadSnapshots();
        const btn = await until(() => [...document.querySelectorAll('#snapList button')].find((b) => b.textContent === 'Revert' && /s3/.test(b.getAttribute('onclick'))));
        btn.click();
        await until(() => v2Ops.has('op_rv2'));
        // A 5xx (or the network) while it runs: still followed, the hook not run.
        window.__answer['GET /v1/operations/op_rv2'] = [{ status: 502, body: { error: 'Bad Gateway' } }];
        await v2OpTick();
        ok('still followed after a failed poll', v2Ops.has('op_rv2') && v2OpEnds.has('op_rv2'));
        // Another file picked meanwhile: it reads, but Save stays off and the line stays.
        $('editFile').value = 'AGENTS.md';
        await loadEditFile();
        ok('the picked file reads', $('editContent').value === 'old agents');
        ok('Save stays off while it reverts', $('editSaveBtn').disabled && editLoaded === null);
        ok('and says so', $('editErr').textContent.includes('reloads when it is done'));
        // It ends: read again, Save back.
        window.__override['/v1/agents/a1/files/AGENTS.md'] = { content: 'reverted agents' };
        window.__answer['GET /v1/operations/op_rv2'] = [{ body: { ...op, status: 'succeeded', outcome: 'Reverted SOUL.md, AGENTS.md.', finishedAt: new Date().toISOString() } }];
        await v2OpTick();
        await until(() => $('editContent').value === 'reverted agents');
        ok('Save is back on after it ends', !$('editSaveBtn').disabled && editLoaded?.file === 'AGENTS.md');
        // Gone (404) still ends it.
        const op3 = { ...op, id: 'op_rv3' };
        let ran = 0; v2FollowOp(op3, () => { ran++; });
        window.__answer['GET /v1/operations/op_rv3'] = [{ status: 404, body: { error: 'Not found' } }];
        await v2OpTick();
        ok('a 404 ends it, once', !v2Ops.has('op_rv3') && ran === 1);
      } finally {
        window.__answer = {}; v2Ops.clear(); v2OpEnds.clear(); editReverting.clear();
        for (const k of ['/v1/agents/a1/snapshots', '/v1/agents/a1/files/SOUL.md', '/v1/agents/a1/files/AGENTS.md']) delete window.__override[k];
        $('editFile').value = 'SOUL.md';
      }
    },
    backupsOwnerWhenAccountUnread: async () => {
      // The account not read yet (or its read failed): asked again, and the owner keeps Back up now and the sets (regression audit, 2026-10-22).
      window.__override['/v1/backups/readiness'] = { newestSet: '2026-10-18', newestFresh: true, staleDays: 2, canRestore: true, drill: { every: 'off' }, agents: [] };
      const saved = myAccount;
      try {
        myAccount = {};
        window.__answer = { 'GET /v1/account': [{ body: { ...saved, hostOwner: true } }] };
        await openAiDlg('backups');
        ok('asked for the account again', calls('GET', /^\/v1\/account$/).length >= 1);
        ok('the owner sees Back up now and the sets', !$('bkRunRow').hidden && !$('bkList').hidden && $('bkOwnerOnly').hidden);
        aiDlg.close();
        // The read fails again: the owner's view, which the server guards.
        myAccount = {};
        window.__answer = { 'GET /v1/account': [{ status: 500, body: { error: 'boom' } }, { status: 500, body: { error: 'boom' } }] };
        await openAiDlg('backups');
        ok('still the owner view when it cannot be read', !$('bkRunRow').hidden && $('bkOwnerOnly').hidden);
      } finally {
        myAccount = saved; window.__answer = {}; clearTimeout(bkDrillTimer); bkDrillTimer = null; aiDlg.close();
        delete window.__override['/v1/backups/readiness']; v2Readiness = null; v2ReadinessAt = 0;
      }
    },
    slowAnswersStayWithTheirOwn: async () => {
      // A slow answer for what was open before lands nowhere: the logs and the setup log of agent A over B's,
      // A's file save closing the editor B is open in, A's report save over draft B (review, 2026-10-22, A37 A38 B43).
      const real = window.fetch, held = [];
      const hold = (re, method = 'GET') => { window.fetch = (input, init = {}) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if ((init.method || 'GET').toUpperCase() === method && re.test(url.split('?')[0])) return new Promise((res) => held.push(() => res(real(input, init))));
        return real(input, init);
      }; };
      const free = async () => { window.fetch = real; while (held.length) held.shift()(); await sleep(150); };
      try {
        window.__override['/v1/agents/a1/logs'] = { text: 'logs of A' };
        window.__override['/v1/agents/a2/logs'] = { text: 'logs of B' };
        hold(/\/v1\/agents\/a1\/logs$/);
        logsAgentId = 'a1'; const a = loadLogs();
        await until(() => held.length === 1);
        window.fetch = real; logsAgentId = 'a2'; await loadLogs();
        eq('B shows its logs', $('logsText').textContent, 'logs of B');
        await free(); await a;
        eq("A's late answer leaves B's", $('logsText').textContent, 'logs of B');
        window.__override['/v1/agents/a1/events'] = { events: [{ at: new Date().toISOString(), label: 'event of A' }] };
        window.__override['/v1/agents/a2/events'] = { events: [{ at: new Date().toISOString(), label: 'event of B' }] };
        hold(/\/v1\/agents\/a1\/events$/);
        setupLogAgentId = 'a1'; const s1 = loadSetupLog();
        await until(() => held.length === 1);
        window.fetch = real; setupLogAgentId = 'a2'; await loadSetupLog();
        await free(); await s1;
        ok("the setup log stays B's: " + $('setupLogBody').textContent, $('setupLogBody').textContent.includes('event of B') && !$('setupLogBody').textContent.includes('event of A'));
        // The editor: A saves slowly, B opens in it and is typed in.
        window.__override['/v1/agents/a1/files/SOUL.md'] = { content: 'soul of A' };
        window.__override['/v1/agents/a2/files/SOUL.md'] = { content: 'soul of B' };
        editAgentId = 'a1'; $('editFile').value = 'SOUL.md'; await loadEditFile();
        if (!editDlg.open) editDlg.showModal();
        hold(/\/v1\/agents\/a1\/files\/SOUL\.md$/, 'PUT');
        const saving = saveEditFile();
        await until(() => held.length === 1);
        window.fetch = real; editAgentId = 'a2'; await loadEditFile();
        $('editContent').value = 'B, being typed';
        await free(); await saving;
        ok("B's editor stays open", editDlg.open);
        eq('with what is typed in it', $('editContent').value, 'B, being typed');
        ok("A's save is said", $('toast').textContent.includes('SOUL.md saved'));
        // A report: draft A saves slowly, draft B is opened meanwhile.
        const draft = (id, title) => ({ id, title, body: 'body of ' + title, by: 'person', createdAt: new Date().toISOString(), issueUrl: 'https://example.com/' + id, fileName: id + '.md' });
        reportPaint(draft('r-a', 'Draft A'));
        $('reportBody').value = 'A, edited';
        window.__answer = { 'PATCH /v1/problem-reports/r-a': [{ body: { ...draft('r-a', 'Draft A'), body: 'A, edited' } }] };
        hold(/\/v1\/problem-reports\/r-a$/, 'PATCH');
        const rs = reportSaveEdits();
        await until(() => held.length === 1);
        window.fetch = real;
        window.__override['/v1/problem-reports/r-b'] = draft('r-b', 'Draft B');
        await reportShow('r-b');
        $('reportBody').value = 'B, edited';
        await free();
        eq('the save still answers with A', (await rs).id, 'r-a');
        eq('B stays the draft shown', reportCur.id, 'r-b');
        eq('with its text', [$('reportRTitle').value, $('reportBody').value], ['Draft B', 'B, edited']);
      } finally {
        window.fetch = real; window.__answer = {};
        for (const k of ['/v1/agents/a1/logs', '/v1/agents/a2/logs', '/v1/agents/a1/events', '/v1/agents/a2/events', '/v1/agents/a1/files/SOUL.md', '/v1/agents/a2/files/SOUL.md', '/v1/problem-reports/r-b']) delete window.__override[k];
        logsAgentId = null; setupLogAgentId = null; reportCur = null; reportGen++;
        if (editDlg.open) editDlg.close(); if (reportDlg.open) reportDlg.close();
      }
    },
    cloneNamesSkippedCredentials: async () => {
      // A credential whose value could not be read stays behind, and the message names it (review, 2026-10-22, B32).
      const p = window.prompt;
      window.prompt = () => 'Homework Copy';
      window.__answer = { 'POST /v1/agents/a1/clone': [{ status: 201, body: { id: 'a-copy', name: 'Homework Copy', notCopied: [], envNotCopied: ['MAIL_KEY'], memoryNotCopied: [] } }] };
      try {
        await cloneAgent('a1', 'Homework Helper');
        const t = $('toast').textContent;
        ok('names the credential left out: ' + t, t.includes('MAIL_KEY') && t.includes('Extra credentials'));
      } finally { window.prompt = p; window.__answer = {}; }
    },
    cloneNamesUnreadableMemory: async () => {
      // HB-0295: a memory folder the agent could not read is named in the message, not left out unsaid.
      const p = window.prompt;
      window.prompt = () => 'Homework Copy';
      window.__answer = { 'POST /v1/agents/a1/clone': [{ status: 201, body: { id: 'a-copy', name: 'Homework Copy', notCopied: [], envNotCopied: [], memoryNotCopied: ['memory/private/'] } }] };
      try {
        await cloneAgent('a1', 'Homework Helper');
        const t = $('toast').textContent;
        ok('names the folder left out: ' + t, t.includes('memory/private/') && t.includes('unreadable'));
      } finally { window.prompt = p; window.__answer = {}; }
    },
    healthOfflineChatNotSlow: async () => {
      // A Discord or Slack bot offline degrades health; Alerts says that, not "slow to respond" (regression audit, 2026-10-22).
      const off = v2HealthProblems({ reachable: true, status: 'degraded', ok: true, disconnected: ['discord'] });
      ok('says Discord is not connected: ' + off.join(' | '), off.includes('Discord is not connected'));
      ok('and not that it is slow', !off.some((x) => x.includes('slow to respond')));
      const slow = v2HealthProblems({ reachable: true, status: 'degraded', eventLoop: { degraded: true, reasons: ['lag'] }, disconnected: ['slack'] });
      ok('a slow event loop still says slow', slow.some((x) => x.includes('slow to respond (lag)')) && slow.includes('Slack is not connected'));
      const bare = v2HealthProblems({ reachable: true, status: 'degraded' });
      ok('degraded with no other cause still says something', bare.some((x) => x.includes('slow to respond')));
    },
  });
  // Deep audit of v2.166.2 (made-up data): one press acts on what was open when it was pressed;
  // a slow answer for what was open before lands nowhere; the spend chart and the setup form say what is so.
  // auditHold().once(re, method) holds the next request that matches until free().
  const auditHold = () => {
    const real = window.fetch, held = [];
    return {
      held,
      once: (re, method = 'GET') => { let armed = true; window.fetch = (input, init = {}) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (armed && (init.method || 'GET').toUpperCase() === method && re.test(url.split('?')[0])) { armed = false; return new Promise((res) => held.push(() => res(real(input, init)))); }
        return real(input, init);
      }; },
      free: async () => { window.fetch = real; while (held.length) held.shift()(); await sleep(150); },
      real,
    };
  };
  Object.assign(T, {
    auditAiTabActsOnItsAgent: async () => {
      // #047: Use this for A, B's sheet opened while it saved: A is rebuilt, with A's box. #050: B's model button is on.
      const h = auditHold();
      const second = { id: 'p-two', name: 'Second source', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-5-5', models: [] };
      profiles.push(second);
      try {
        prepareEdit('a1', 'Homework Helper');
        $('editProfile').value = 'p-two'; onEditProfileChange();
        ok('A: the model button waits on Use this', $('modelBtn').disabled);
        prepareEdit('a2', 'Soccer Schedule');
        ok("B's own source is shown and its model button is on: " + $('modelBtn').title, $('editProfile').value === 'p1' && !$('modelBtn').disabled && !$('modelBtn').title);
        prepareEdit('a1', 'Homework Helper');
        $('editProfile').value = 'p-two'; $('editCheckpoint').checked = true;
        window.__confirmAnswer = true; window.__confirms = [];
        const before = calls('POST', /\/rebuild$/).length;
        h.once(/^\/v1\/agents\/a1$/, 'PATCH');
        const saving = switchProfile();
        await until(() => h.held.length === 1);
        prepareEdit('a2', 'Soccer Schedule'); $('editCheckpoint').checked = false;
        await h.free(); await saving;
        const rebuilt = calls('POST', /\/rebuild$/).slice(before);
        eq('A is rebuilt, with its box as it was', rebuilt.map((x) => [x.path, x.body]), [['/v1/agents/a1/rebuild', { checkpoint: true, stoppedWaits: true }]]);
        ok('the question names A: ' + window.__confirms.at(-1), window.__confirms.at(-1).includes('Homework Helper'));
        eq("B's sheet is still B's", editAgentId, 'a2');
      } finally {
        await h.free(); profiles.splice(profiles.indexOf(second), 1);
        window.__confirms = []; $('editCheckpoint').checked = true;
      }
    },
    auditEditorKeepsNewerRead: async () => {
      // #048: SOUL.md, MEMORY.md, SOUL.md again; the first read answers last and leaves the edit alone.
      const h = auditHold();
      try {
        window.__override['/v1/agents/a1/files/SOUL.md'] = { content: 'older soul' };
        window.__override['/v1/agents/a1/files/MEMORY.md'] = { content: 'memory' };
        editAgentId = 'a1'; $('editFile').value = 'SOUL.md';
        h.once(/\/v1\/agents\/a1\/files\/SOUL\.md$/);
        const first = loadEditFile();
        await until(() => h.held.length === 1);
        $('editFile').value = 'MEMORY.md'; await loadEditFile();
        window.__override['/v1/agents/a1/files/SOUL.md'] = { content: 'current soul' };
        $('editFile').value = 'SOUL.md'; await loadEditFile();
        $('editContent').value = 'current soul, edited';
        window.__override['/v1/agents/a1/files/SOUL.md'] = { content: 'older soul' };
        await h.free(); await first;
        eq('the edit stays', $('editContent').value, 'current soul, edited');
        ok('and Save is on, for SOUL.md', !$('editSaveBtn').disabled && editLoaded?.file === 'SOUL.md');
      } finally {
        await h.free();
        for (const k of ['/v1/agents/a1/files/SOUL.md', '/v1/agents/a1/files/MEMORY.md']) delete window.__override[k];
        $('editFile').value = 'SOUL.md'; editLoaded = null;
      }
    },
    auditBulkClassReadOnce: async () => {
      // #049: the class menu changed while Apply works through the agents; every one gets the class applied.
      const h = auditHold();
      window.__override['/v1/agent-classes'] = { classes: [{ id: 'class-school', name: 'School' }, { id: 'class-sport', name: 'Sport' }] };
      try {
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === 'a1' || cb.dataset.id === 'a2'; });
        $('faAction').value = 'class'; faRenderAction();
        $('faClass').value = 'class-school';
        const mark = calls('POST', /\/class$/).length;
        h.once(/\/class$/, 'POST');
        const applying = faApply();
        await until(() => h.held.length === 1);
        $('faClass').value = 'class-sport';
        await h.free(); await applying;
        eq('every agent gets the class applied', calls('POST', /\/class$/).slice(mark).map((x) => x.body.classId), ['class-school', 'class-school']);
      } finally {
        await h.free(); delete window.__override['/v1/agent-classes'];
        if (fleetActionsDlg.open) fleetActionsDlg.close();
      }
    },
    auditSpendUnpriced: async () => {
      // #062: tokens on a model with no known price are never $0 in Spend over time.
      const box = document.createElement('div');
      const chart = (cost) => ({ range: 'day', bucketHours: 1, planShare: 0, monthly: cost * 30, models: cost ? [{ model: 'claude-sonnet-5', cost }] : [], choices: [],
        buckets: [{ at: new Date(Date.now() - 3600e3).toISOString(), input: cost, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 2e6 }],
        totals: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, cost, tokens: 2e6 }, unpriced: { tokens: 1e6, models: ['made-up-cloud-model'] } });
      try {
        window.__override['/v1/usage/spend'] = chart(0);
        box.innerHTML = spendChartBox(''); document.body.append(box);
        await loadSpendCharts(box);
        const pie = await until(() => box.querySelector('svg[aria-label="What it went on"]'));
        ok('nothing priced: "No price", not $0.00 — ' + pie.textContent.trim(), pie.textContent.includes('No price') && !pie.textContent.includes('$0.00'));
        ok('it names the model and the amount is unknown', box.textContent.includes('made-up-cloud-model') && box.textContent.includes('no price known') && box.textContent.includes('the amount is unknown'));
        window.__override['/v1/usage/spend'] = chart(4.2);
        await loadSpendCharts(box);
        await until(() => box.querySelector('svg[aria-label="What it went on"]')?.textContent.includes('$4.20+'));
        ok('part priced: only part of it', box.textContent.includes('only part of it') && box.textContent.includes('+ a month at this pace'));
      } finally { box.remove(); delete window.__override['/v1/usage/spend']; }
    },
    auditSlowAnswersLandNowhere: async () => {
      // #063 a web-chat link, #064 a master's proposals, #065 a spend range: an answer that comes
      // after a newer one for the same place is dropped.
      const h = auditHold();
      const piano = agents.find((x) => x.name === 'Piano Practice'), garden = agents.find((x) => x.name === 'Garden Notes');
      const prevRange = spendRange;
      const box = document.createElement('div');
      try {
        // Invite: a web-chat link made for one agent, while another agent's invite was opened.
        await invite(piano.id, piano.name);
        window.__answer = { ['POST /v1/agents/' + piano.id + '/invites']: [{ body: { url: 'https://hatchabot.example/join?code=made-up-piano' } }] };
        h.once(new RegExp('/v1/agents/' + piano.id + '/invites$'), 'POST');
        const making = makeWebChatInvite();
        await until(() => h.held.length === 1);
        inviteDlg.close(); await invite(garden.id, garden.name);
        await h.free(); await making;
        eq("the open invite is the second agent's", $('invAgent').textContent, garden.name);
        ok("the first agent's link is not in it", $('invWebLink').hidden && !$('invWebLink').textContent.includes('made-up-piano'));
        ok('and its own Make link stays', !$('invWebBtn').hidden && !$('invWebBtn').disabled && $('invWebCopy').hidden);
        inviteDlg.close();
        // Proposals: master A's list answers after master B's opened.
        window.__override['/v1/agents/a1/proposals'] = { proposals: [{ id: 'pr-a', childName: 'Math', text: 'Show the working', createdAt: new Date().toISOString() }] };
        window.__override['/v1/agents/a2/proposals'] = { proposals: [{ id: 'pr-b', childName: 'Soccer U10', text: 'Practice moves to Thursday', createdAt: new Date().toISOString() }] };
        h.once(/\/v1\/agents\/a1\/proposals$/);
        const pa = openProposals('a1', 'Homework Helper');
        await until(() => h.held.length === 1);
        proposalsDlg.close(); await openProposals('a2', 'Soccer Schedule');
        await h.free(); await pa;
        ok("B's proposals stay listed: " + $('proposalsList').textContent.slice(0, 80), $('proposalsList').textContent.includes('Practice moves to Thursday') && !$('proposalsList').textContent.includes('Show the working'));
        proposalsDlg.close();
        // The spend chart: a week asked first, a day after; the week answers last.
        const series = (range) => ({ range, bucketHours: 1, planShare: 0, monthly: 0, models: [], choices: [], buckets: [], totals: { cost: range === 'week' ? 70 : 1, tokens: 1 } });
        let releaseWeek; const weekHeld = new Promise((r) => { releaseWeek = r; });
        window.fetch = async (input, init = {}) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (url.split('?')[0].endsWith('/v1/usage/spend')) {
            const range = new URLSearchParams(url.split('?')[1] || '').get('range');
            if (range === 'week') await weekHeld;
            return new Response(JSON.stringify(series(range)), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return h.real(input, init);
        };
        box.innerHTML = spendChartBox(''); document.body.append(box);
        const el = box.firstElementChild;
        spendRange = 'week'; const week = loadSpendChart(el);
        spendRange = 'day'; await loadSpendChart(el);
        ok('the day is drawn', el.querySelector('.su-period.on')?.textContent === '1 day');
        releaseWeek(); await week;
        ok("the week's late answer leaves the day's chart: " + el.querySelector('.su-period.on')?.textContent, el.querySelector('.su-period.on')?.textContent === '1 day');
      } finally {
        await h.free(); window.__answer = {}; spendRange = prevRange; box.remove();
        for (const k of ['/v1/agents/a1/proposals', '/v1/agents/a2/proposals']) delete window.__override[k];
        if (inviteDlg.open) inviteDlg.close(); if (proposalsDlg.open) proposalsDlg.close();
      }
    },
    auditSetupFormAnswers: async () => {
      // #066 #067: New child's setup form sends a cleared default as empty, and ticks a "yes" default.
      const a = agents.find((x) => x.id === 'a1'), was = a.parameters;
      try {
        a.parameters = [
          { key: 'style', label: 'Style', type: 'text', target: 'soul', required: false, default: 'Short answers' },
          { key: 'reminders', label: 'Reminders', type: 'boolean', target: 'soul', required: false, default: 'yes' },
          { key: 'topics', label: 'Topics', type: 'multichoice', target: 'soul', required: false, options: ['Math', 'Reading'], default: 'Math' },
        ];
        window.__promptAnswer = 'Homework Helper Jr';
        await until(() => !paramFormDlg.open && paramFormResolve === null); await sleep(0);
        const before = calls('POST', /\/v1\/agents\/a1\/derive$/).length;
        const deriving = deriveChild('a1', 'Homework Helper');
        await formOpened();
        ok('the "yes" default is ticked', document.getElementById('pfv-1').checked);
        eq('the text default is shown', document.getElementById('pfv-0').value, 'Short answers');
        document.getElementById('pfv-0').value = '';
        document.querySelectorAll('#pfv-2 input:checked').forEach((cb) => { cb.checked = false; });
        submitParamForm();
        await deriving;
        const sent = calls('POST', /\/v1\/agents\/a1\/derive$/).slice(before);
        eq('one child asked for', sent.length, 1);
        eq('the cleared ones sent empty, the yes kept', sent[0].body.values, { style: '', reminders: 'true', topics: '' });
      } finally {
        a.parameters = was; window.__promptAnswer = null;
        if (paramFormDlg.open) paramFormDlg.close();
      }
    },
    // Audit of v2.170.1 (2026-10-29). HB-0265: a delete a restart interrupted leaves the agent
    // DELETING; its Overview still offers Delete, which finishes it.
    auditDeletingOffersDelete: async () => {
      try {
        await withAgents((a) => a.id === 'a1' ? { ...a, state: 'DELETING' } : undefined);
        openV2Agent('a1', 'overview');
        await until(() => byText('#v2AgentDlg .v2danger', 'Archive or delete'));
        ok('a DELETING agent has Delete', !!byText('#v2AgentDlg .v2danger button', 'Delete'));
        ok('and no Archive', !byText('#v2AgentDlg .v2danger button', 'Archive'));
        ok('it says Delete finishes it: ' + document.querySelector('#v2AgentDlg .v2danger').textContent, document.querySelector('#v2AgentDlg .v2danger').textContent.includes('Delete… finishes it'));
      } finally { v2Close(); await agentsCleanup(); }
    },
    // HB-0350: Try on agents says Chat → Memory runs first; the rebuild asks for it.
    auditTrySavesChatFirst: async () => {
      try {
        window.__confirmAnswer = true; window.__confirms = [];
        tryState = { tag: 'hatchabot-runtime:candidate', picked: new Set(['a1']) };
        const mark = window.__calls.length;
        await runTryOnAgents();
        ok('the question promises it: ' + window.__confirms.at(-1), window.__confirms.at(-1).includes('Chat → Memory runs first'));
        const sent = window.__calls.slice(mark).filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]);
        eq('pinned, then rebuilt with the checkpoint', sent, [['PATCH', '/v1/agents/a1', { image: 'hatchabot-runtime:candidate' }], ['POST', '/v1/agents/a1/rebuild', { checkpoint: true, stoppedWaits: true }]]);
      } finally { tryState = null; window.__confirms = []; if (tryDlg.open) tryDlg.close(); }
    },
    // HB-0351: a read of a repo that answers after the dialog was opened again lands nowhere.
    auditAppLateReadLandsNowhere: async () => {
      const MAN = { app: 'demoapp', name: 'Demo App', tasks: [], config: { fields: [] }, connections: [] };
      const h = auditHold();
      try {
        window.__answer = window.__answer || {};
        window.__answer['POST /v1/apps/inspect'] = [{ status: 200, body: { sha: 'c0ffee0123456789c0ffee0123456789c0ffee01', manifest: MAN, connections: [], ask: [{ key: 'mode', default: 'shadow' }] } }];
        openAppDlg('install', 'a1');
        document.getElementById('appSource').value = '~/demoapp';
        h.once(/^\/v1\/apps\/inspect$/, 'POST');
        const reading = appRead();
        await until(() => h.held.length === 1);
        appDlg.close();
        openAppDlg('install', 'a2');
        document.getElementById('appSource').value = '~/otherapp';
        await h.free(); await reading;
        eq('the box still names the new repo', document.getElementById('appSource').value, '~/otherapp');
        ok('the old repo is not taken', appInspected === null && !document.getElementById('appF_mode'));
        ok('nor shown: ' + document.getElementById('appInfo').textContent, !document.getElementById('appInfo').textContent.includes('Demo App'));
        ok('Install is still off, Read it on', document.getElementById('appGoBtn').disabled && !document.getElementById('appReadBtn').disabled);
      } finally {
        await h.free();
        if (window.__answer) delete window.__answer['POST /v1/apps/inspect'];
        if (appDlg.open) appDlg.close();
      }
    },
    // HB-0283: Install pressed for A, the dialog opened on B and another repo read while A's account attached:
    // A gets its own app; B's dialog is left as it is.
    auditAppInstallKeepsItsTarget: async () => {
      const MAN = { app: 'demoapp', name: 'Demo App', tasks: [], config: { fields: [] }, connections: [{ kind: 'google', purpose: 'its mailbox', field: 'mailbox' }] };
      const OTHER = { app: 'otherapp', name: 'Other App', tasks: [], config: { fields: [] }, connections: [] };
      const keys = ['POST /v1/apps/inspect', 'POST /v1/agents/a1/connections/attach'];
      const h = auditHold();
      try {
        window.__answer = window.__answer || {};
        window.__override['/v1/connections'] = { connections: [{ id: 'c2', kind: 'google', email: 'other@example.org', attachedTo: [] }] };
        window.__answer['POST /v1/apps/inspect'] = [
          { status: 200, body: { sha: 'c0ffee0123456789c0ffee0123456789c0ffee01', manifest: MAN, connections: MAN.connections, ask: [{ key: 'mailbox', type: 'email', required: true }] } },
          { status: 200, body: { sha: 'feedc0de0123456789feedc0de0123456789feed', manifest: OTHER, connections: [], ask: [{ key: 'colour', default: 'green' }] } }];
        window.__answer['POST /v1/agents/a1/connections/attach'] = [{ status: 200, body: { attached: true, live: true } }];
        openAppDlg('install', 'a1');
        document.getElementById('appSource').value = '~/demoapp';
        await appRead();
        document.getElementById('appConn').value = 'c2'; appConnPicked();
        const mark = window.__calls.length;
        h.once(/^\/v1\/agents\/a1\/connections\/attach$/, 'POST');
        const going = appGo();
        await until(() => h.held.length === 1);
        appDlg.close();
        openAppDlg('install', 'a2');
        document.getElementById('appSource').value = '~/otherapp';
        await appRead();
        await h.free(); await going;
        const sent = window.__calls.slice(mark).filter((c) => c.method === 'POST' && /^\/v1\/agents\//.test(c.path)).map((c) => [c.path, c.body]);
        eq("A's account and A's app, with A's values", sent, [['/v1/agents/a1/connections/attach', { connectionId: 'c2' }], ['/v1/agents/a1/app', { source: '~/demoapp', values: { mailbox: 'other@example.org' } }]]);
        ok("B's dialog stays open on B's repo", appDlg.open && appDlgAgent === 'a2' && appInspected?.source === '~/otherapp');
        ok("and its Install is still on", !document.getElementById('appGoBtn').disabled);
      } finally {
        await h.free();
        for (const k of keys) if (window.__answer) delete window.__answer[k];
        delete window.__override['/v1/connections'];
        if (appDlg.open) appDlg.close();
        await refresh(false);
      }
    },
    // HB-0352: an app's on/off field with the default "false" (or "off", "no", "0") starts off, as the server reads it.
    auditAppBoolDefaults: async () => {
      const MAN = { app: 'demoapp', name: 'Demo App', tasks: [], config: { fields: [] }, connections: [] };
      const ask = [['quiet', 'false'], ['dry', 'off'], ['loud', 'yes'], ['fast', true], ['slow', 'No'], ['zero', '0']].map(([key, d]) => ({ key, type: 'bool', default: d }));
      try {
        window.__answer = window.__answer || {};
        window.__answer['POST /v1/apps/inspect'] = [{ status: 200, body: { sha: 'c0ffee0123456789c0ffee0123456789c0ffee01', manifest: MAN, connections: [], ask } }];
        openAppDlg('install', 'a1');
        document.getElementById('appSource').value = '~/demoapp';
        await appRead();
        eq('ticked as the server reads them', ask.map((f) => document.getElementById('appF_' + f.key).checked), [false, false, true, true, false, false]);
        eq('and sent so untouched', appValues(), { quiet: 'false', dry: 'false', loud: 'true', fast: 'true', slow: 'false', zero: 'false' });
      } finally {
        if (window.__answer) delete window.__answer['POST /v1/apps/inspect'];
        if (appDlg.open) appDlg.close();
      }
    },
    // HB-0367: A's icon saved, its dialog closed and B's opened while it saved: B's stays open, with what was typed.
    auditIconSaveLeavesNextOpening: async () => {
      const h = auditHold();
      try {
        openV2Icon('a1');
        document.getElementById('v2IconInput').value = '🐣';
        h.once(/^\/v1\/agents\/a1$/, 'PATCH');
        const saving = v2IconSave(document.getElementById('v2IconSaveBtn'));
        await until(() => h.held.length === 1);
        v2IconDlg.close();
        openV2Icon('a2');
        document.getElementById('v2IconInput').value = '🏡';
        await h.free(); await saving;
        ok("B's dialog is still open", v2IconDlg.open && v2IconFor === 'a2');
        eq('with what was typed in it', document.getElementById('v2IconInput').value, '🏡');
        const patch = window.__calls.filter((c) => c.method === 'PATCH' && c.path === '/v1/agents/a1').at(-1);
        eq("A's icon was saved", patch && patch.body.icon, '🐣');
        v2IconDlg.close();
        // A's save ending while B's goes on leaves B's Save off: a second press would send it again.
        const btn = document.getElementById('v2IconSaveBtn');
        openV2Icon('a1');
        h.once(/^\/v1\/agents\/a1$/, 'PATCH');
        const first = v2IconSave(btn);
        await until(() => h.held.length === 1);
        v2IconDlg.close();
        openV2Icon('a2');
        ok('Save is on in the new opening', !btn.disabled);
        h.once(/^\/v1\/agents\/a2$/, 'PATCH');
        const second = v2IconSave(btn);
        await until(() => h.held.length === 2);
        h.held.shift()(); await first;
        ok("A's save ending leaves B's Save off", btn.disabled && v2IconDlg.open);
        await h.free(); await second;
        ok("B's own save turns it back on", !btn.disabled);
      } finally { await h.free(); if (v2IconDlg.open) v2IconDlg.close(); }
    },
    optionalChoiceClears: async () => {
      // HB-0363: an optional choice offers a blank, in the setup form and in Setup values; a required one does not.
      const a = agents.find((x) => x.id === 'a1'), was = { parameters: a.parameters, paramValues: a.paramValues, state: a.state };
      try {
        a.parameters = [
          { key: 'tone', label: 'Tone', type: 'choice', target: 'soul', required: false, options: ['formal', 'casual'] },
          { key: 'grade', label: 'Grade', type: 'choice', target: 'soul', required: true, options: ['5', '6'] },
        ];
        window.__promptAnswer = 'Homework Helper Jr';
        await until(() => !paramFormDlg.open && paramFormResolve === null); await sleep(0);
        const before = calls('POST', /\/v1\/agents\/a1\/derive$/).length;
        const deriving = deriveChild('a1', 'Homework Helper');
        await formOpened();
        // Untouched it starts on its first option, as before: on the blank, {{tone}} itself landed in the files.
        eq('the optional choice starts on its first option', document.getElementById('pfv-0').value, 'formal');
        ok('and offers a blank', [...document.getElementById('pfv-0').options].some((o) => o.value === ''));
        ok('the required choice has no blank', ![...document.getElementById('pfv-1').options].some((o) => o.value === ''));
        submitParamForm();
        await deriving;
        const sent = calls('POST', /\/v1\/agents\/a1\/derive$/).slice(before);
        eq('a click-through sends both first options', sent[0].body.values, { tone: 'formal', grade: '5' });
        // "(none)" picked is sent as a blank value, not left out.
        await until(() => !paramFormDlg.open && paramFormResolve === null); await sleep(0);
        const deriving2 = deriveChild('a1', 'Homework Helper');
        await formOpened();
        document.getElementById('pfv-0').value = '';
        submitParamForm();
        await deriving2;
        const sent2 = calls('POST', /\/v1\/agents\/a1\/derive$/).slice(before);
        eq('(none) is sent blank', sent2[1].body.values, { tone: '', grade: '5' });
        // Setup values later: the chosen tone can be cleared.
        a.state = 'RUNNING'; a.paramValues = { tone: 'casual', grade: '6' };
        renderSetupValues(a);
        eq('the stored tone is shown', document.getElementById('spv-tone').value, 'casual');
        document.getElementById('spv-tone').value = '';
        eq('cleared, it is sent empty', collectSetupValues(a), { tone: '', grade: '6' });
        // A default that differs from its option by case or a space starts on that option, not on the blank.
        a.parameters[0].default = ' Formal';
        await until(() => !paramFormDlg.open && paramFormResolve === null); await sleep(0);
        const deriving3 = deriveChild('a1', 'Homework Helper');
        await formOpened();
        eq('a default spelt otherwise starts on its option', document.getElementById('pfv-0').value, 'formal');
        submitParamForm();
        await deriving3;
        eq('and a click-through sends it', calls('POST', /\/v1\/agents\/a1\/derive$/).slice(before)[2].body.values, { tone: 'formal', grade: '5' });
        a.paramValues = { grade: '6' };
        renderSetupValues(a);
        eq('Setup values shows that default on its option too', document.getElementById('spv-tone').value, 'formal');
      } finally {
        Object.assign(a, was); window.__promptAnswer = null;
        if (paramFormDlg.open) paramFormDlg.close();
      }
    },
    setupValuesWarning: async () => {
      // HB-0567: Apply values and Reset say when the description could not take the values, rather than "applied".
      const a = agents.find((x) => x.id === 'a1'), was = { parameters: a.parameters, paramValues: a.paramValues, state: a.state }, wasEdit = editAgentId;
      const said = () => document.getElementById('toast').textContent;
      const WARN = 'The files have the new values, but the description was changed meanwhile and was not filled in with them: too long.';
      window.__answer = window.__answer || {};
      try {
        a.parameters = [{ key: 'tone', label: 'Tone', type: 'text', target: 'soul', required: false }];
        a.paramValues = { tone: 'calm' }; a.state = 'RUNNING';
        editAgentId = 'a1';
        renderSetupValues(a);
        window.__answer['PUT /v1/agents/a1/params'] = [
          { body: { applied: true, values: { tone: 'calm' }, warning: WARN } },
          { body: { applied: true, values: { tone: 'calm' } } },
          { body: { applied: true, values: {}, warning: WARN } },
        ];
        await saveSetupValues();
        ok('Apply values says the warning: ' + said(), said().includes('Values applied, but') && said().includes('was not filled in'));
        renderSetupValues(Object.assign(agents.find((x) => x.id === 'a1'), { parameters: a.parameters, paramValues: { tone: 'calm' }, state: 'RUNNING' }));
        await saveSetupValues();
        // Said for its agent (named when its page is not the one open).
        ok('without one, the usual words', said().includes('Values applied —') && !said().includes('⚠'));
        window.__confirmAnswer = true;
        await resetSetupValues();
        ok('Reset says it too: ' + said(), said().includes('Reset to defaults, but') && said().includes('was not filled in'));
        eq('three applies sent', calls('PUT', /\/v1\/agents\/a1\/params$/).length >= 3, true);
      } finally {
        Object.assign(agents.find((x) => x.id === 'a1') ?? a, was); editAgentId = wasEdit;
        delete window.__answer['PUT /v1/agents/a1/params'];
      }
    },
    joinPageSecondFactor: async () => {
      // HB-0400: the real web/join.html in a frame. A right password that the public address refuses
      // for want of a second factor must say so, not bring the same form back with no message.
      const NO_SIGN_IN = { status: 401, body: { error: 'Sign in to this Hatchabot first.', signIn: true } };
      const INVITE = { valid: true, webChat: true, agentName: 'Homework Helper', authMode: 'accounts', localAccounts: true };
      const open = async (answers, invite = {}) => {
        window.__answer = { 'GET /v1/invites/srcdoc': [{ body: { ...INVITE, ...invite } }], ...answers };
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:0;top:0;width:500px;height:800px;background:#fff;z-index:99999';
        frame.srcdoc = window.__joinPage.replace('<head>', () => '<head><script>window.fetch = (...a) => parent.fetch(...a);<\/script>');
        document.body.appendChild(frame);
        await until(() => frame.contentDocument && frame.contentDocument.getElementById('joinBtn'));
        return frame;
      };
      const logins = () => calls('POST', /^\/v1\/login$/).length;
      let frame;
      try {
        // A factor they have but did not give here.
        frame = await open({
          'POST /v1/join': [
            { status: 401, body: { error: 'This address also asks for your second factor.', secondFactor: 'required' } },
            { status: 401, body: { error: 'This address also asks for your second factor.', secondFactor: 'required' } },
            { status: 201, body: { agentName: 'Homework Helper', agentId: 'a1', webChat: true } }],
          'POST /v1/login': [{ status: 401, body: { error: 'Invalid username or password.' } }, { body: { ok: true } }],
        });
        let d = frame.contentDocument;
        const form = () => d.getElementById('acct');
        const btn = () => d.getElementById('joinBtn');
        const note = () => d.getElementById('factorNote');
        const settled = () => !btn().disabled;
        ok('not signed in: the form shows at once', !form().hidden);
        eq('no session: the sign-in form', btn().textContent, 'Sign in and join');
        ok('with nothing to explain yet', note().hidden);
        // A wrong password says so and leaves the form.
        const before = logins();
        d.getElementById('user').value = 'sam'; d.getElementById('pass').value = 'made-up-passphrase';
        btn().click();
        await until(() => d.getElementById('err').textContent);
        eq('the wrong password is reported', d.getElementById('err').textContent, 'Invalid username or password.');
        ok('and the form stays', !form().hidden && note().hidden);
        // The right password: told what is missing, and not asked for the password again.
        await until(settled);
        btn().click();
        await until(() => !note().hidden);
        await until(settled);
        eq('it signed in once more', logins(), before + 2);
        ok('the message is shown: ' + note().textContent, note().textContent.includes('second factor'));
        ok('the form is gone', form().hidden);
        eq('the button joins', btn().textContent, 'Join');
        const link = note().querySelector('a');
        ok('it offers the app, in a tab of its own', link && link.getAttribute('href') === '/' && link.target === '_blank' && link.rel.includes('noopener'));
        // Pressed again without the factor: the message stays, and no password goes out.
        btn().click();
        await until(() => calls('POST', /^\/v1\/join$/).length >= 2 && settled());
        ok('still told', !note().hidden && form().hidden);
        eq('no second password', logins(), before + 2);
        // Back from the app with the factor given: in, by the same page.
        btn().click();
        await until(() => d.getElementById('card').textContent.includes('You\'re in'));
        frame.remove();

        // Signed in, no factor yet, and no way to add one here: said as the page opens, the words alone.
        frame = await open({ 'POST /v1/join': [NO_SIGN_IN] },
          { factor: { error: 'Ask whoever runs this Hatchabot for a reset link.', secondFactor: 'enrol-link' } });
        d = frame.contentDocument;
        ok('the words at once: ' + note().textContent, !note().hidden && note().textContent.includes('reset link'));
        ok('no link to the app', !note().querySelector('a'));
        ok('no form: they are signed in', form().hidden);
        eq('the button joins with their session', btn().textContent, 'Join');
        // The session then ended: back to the form, and the old message goes.
        btn().click();
        await until(() => !form().hidden);
        ok('the message goes with it', note().hidden);
        eq('the form asks again', btn().textContent, 'Sign in and join');
      } finally {
        if (frame) frame.remove();
        window.__answer = {};
      }
    },
    // 2026-11-10: on a Google install the page offered only Google, so someone with a password account
    // could not join, and someone signed in already had to sign in again. It also follows the app's theme.
    joinPageWaysIn: async () => {
      const open = async (invite, answers = {}) => {
        window.__answer = { 'GET /v1/invites/srcdoc': [{ body: { valid: true, webChat: true, agentName: 'Homework Helper', ...invite } }], ...answers };
        const frame = document.createElement('iframe');
        frame.style.cssText = 'position:fixed;left:0;top:0;width:500px;height:800px;background:#fff;z-index:99999';
        frame.srcdoc = window.__joinPage.replace('<head>', () => '<head><script>window.fetch = (...a) => parent.fetch(...a);<\/script>');
        document.body.appendChild(frame);
        await until(() => frame.contentDocument && frame.contentDocument.querySelector('#card .agent'));
        return frame;
      };
      let frame;
      try {
        // Google with password accounts, nobody signed in: the form and Google both.
        frame = await open({ authMode: 'identity', localAccounts: true });
        let d = frame.contentDocument;
        eq('the theme is the app\'s', d.documentElement.dataset.theme, (() => { try { return localStorage.getItem('theme') || 'light'; } catch { return 'light'; } })());
        ok('the egg and the wordmark', !!d.querySelector('h1 img') && d.querySelector('h1').textContent.includes('Hatchabot'));
        ok('a password account can sign in', !d.getElementById('acct').hidden && d.getElementById('joinBtn').textContent === 'Sign in and join');
        ok('Google too', !!d.getElementById('gsi') && d.getElementById('card').textContent.includes('Or sign in with Google:'));
        frame.remove();

        // Google only, signed in already: join as them, no second sign-in.
        frame = await open({ authMode: 'identity', localAccounts: false, signedInAs: 'sam@example.com' },
          { 'POST /v1/join': [{ status: 201, body: { agentName: 'Homework Helper', agentId: 'a1', webChat: true } }] });
        d = frame.contentDocument;
        eq('join as who they are', d.getElementById('joinBtn').textContent, 'Join as sam@example.com');
        ok('no password form on a Google-only install', !d.getElementById('acct'));
        d.getElementById('name').value = 'Sam';
        d.getElementById('joinBtn').click();
        await until(() => d.getElementById('card').textContent.includes('You\'re in'));
        const posted = calls('POST', /^\/v1\/join$/).pop().body;
        eq('joined with the session, no Google token', [posted.name, 'idToken' in posted && posted.idToken !== undefined], ['Sam', false]);
        frame.remove();

        // Password accounts, signed in as someone else: they can switch to their own.
        frame = await open({ authMode: 'accounts', signedInAs: 'Robin' });
        d = frame.contentDocument;
        ok('joins as the signed-in person, form hidden', d.getElementById('joinBtn').textContent === 'Join as Robin' && d.getElementById('acct').hidden);
        d.getElementById('otherAcct').click();
        ok('not them: the form', !d.getElementById('acct').hidden && d.getElementById('joinBtn').textContent === 'Sign in and join' && d.getElementById('otherWrap').hidden);
        frame.remove();

        // Their own agent: said, no form.
        frame = await open({ authMode: 'identity', signedInAs: 'owner@example.com', own: true });
        d = frame.contentDocument;
        ok('your own agent', d.getElementById('card').textContent.includes('This is your own agent') && !d.getElementById('joinBtn'));
      } finally {
        if (frame) frame.remove();
        window.__answer = {};
      }
    },
    rosterPendingAndExpired: async () => {
      // HB-0422: a spent reset must not make a long-standing member look un-joined, and an expired invitation says so.
      const was = { authMode: appConfig.authMode };
      const soon = new Date(Date.now() + 15 * 60000).toISOString();
      const rows = () => [
        { id: 'la-1', username: 'hostperson', hostOwner: true, agents: 2, pending: false, invitationExpired: false },
        { id: 'la-2', username: 'sam', agents: 3, pending: false, invitationExpired: false },
        { id: 'la-3', username: 'alex', agents: 0, pending: true, invitationExpired: false, claimPath: '/?claim=madeup', claimExpires: soon },
        { id: 'la-4', username: 'robin', agents: 0, pending: false, invitationExpired: true },
        { id: 'la-5', username: 'kit', agents: 0, pending: true, invitationExpired: false },
      ];
      window.__override['/v1/local-accounts/me'] = { id: 'la-1', username: 'hostperson', hostOwner: true };
      window.__override['/v1/local-accounts'] = rows();
      const row = (u) => [...document.querySelectorAll('#acctList .pair')].find((el) => el.querySelector('b').textContent === u);
      const panels = ['acctSelf', 'acctAdmin'].map((id) => [id, document.getElementById(id).hidden]);
      try {
        appConfig.authMode = 'accounts';
        await loadAccounts();
        await until(() => row('robin'));
        const sam = row('sam');
        ok('a member keeps the agent count: ' + sam.textContent, sam.textContent.includes('3 agents') && !sam.textContent.includes('invitation'));
        ok('and the reset button', !!byText('#acctList .pair:nth-child(2) button', 'Send a reset link'));
        const alex = row('alex');
        ok('a live invitation is pending: ' + alex.textContent, alex.textContent.includes('invitation not accepted yet') && !alex.textContent.includes('reset link'));
        const robin = row('robin');
        ok('an expired one says so: ' + robin.textContent, robin.textContent.includes('invitation expired') && !robin.textContent.includes('not accepted yet'));
        ok('no dead link to copy', ![...robin.querySelectorAll('button')].some((b) => b.textContent.includes('Copy invitation')));
        ok('at the public address, the private-address note stays', row('kit').textContent.includes('at the private address'));
        // Copy on a live invitation: the toast gives the code's real end, not "48 hours".
        const copyBtn = [...alex.querySelectorAll('button')].find((b) => b.textContent.includes('Copy invitation'));
        ok('the live one can be copied', !!copyBtn);
        copyBtn.click();
        await until(() => [...document.querySelectorAll('.toast, #toast')].some((t) => /expires/.test(t.textContent) || t.textContent.includes('/?claim=madeup')));
        ok('and never claims 48 hours', ![...document.querySelectorAll('.toast, #toast')].some((t) => t.textContent.includes('48 hours')));
        // A new invitation, from the row itself.
        window.__answer = { 'POST /v1/local-accounts/la-4/reset-link': [{ body: { username: 'robin', claimPath: '/?claim=fresh', expiresAt: soon } }] };
        window.__override['/v1/local-accounts'] = rows().map((a) => (a.id === 'la-4' ? { ...a, pending: true, invitationExpired: false, claimPath: '/?claim=fresh', claimExpires: soon } : a));
        [...robin.querySelectorAll('button')].find((b) => b.textContent.includes('Send a new invitation')).click();
        await until(() => document.getElementById('acctInviteOut').textContent.includes('/?claim=fresh'));
        await until(() => row('robin').textContent.includes('invitation not accepted yet'));
        ok('the row is pending again', [...row('robin').querySelectorAll('button')].some((b) => b.textContent.includes('Copy invitation')));
      } finally {
        Object.assign(appConfig, was);
        delete window.__override['/v1/local-accounts']; delete window.__override['/v1/local-accounts/me'];
        window.__answer = {};
        document.getElementById('acctInviteOut').style.display = 'none';
        for (const [id, hidden] of panels) document.getElementById(id).hidden = hidden;
      }
    },
  });
  // Deep audit of v2.177.0 (made-up data): a reply lands on the agent, draft or request it was for, and is read in full;
  // a value typed for one agent stays with it; a saved edit does not hold the sheet back.
  Object.assign(T, {
    repliesStayWithTheirAgent: async () => {
      // HB-0583, HB-0584, HB-0591: A's image list and A's folder, answered after B's sheet opened, land on A alone.
      const h = auditHold();
      const toastText = () => $('toast').textContent;
      const folder = (id) => ({ id, legacy: true, kind: 'folder', hostPath: '/srv/made-up/' + id, mountName: id, access: 'ro' });
      try {
        // The image picker: A's list, late, over B's.
        editAgentId = 'a1';
        h.once(/\/v1\/runtime\/images$/);
        const pa = populateImagePicker('hatchabot/runtime:trial');
        await until(() => h.held.length === 1);
        editAgentId = 'a2';
        await populateImagePicker('');
        eq("B's pin: the fleet default", $('editImage').value, '');
        await h.free(); await pa;
        eq("A's late list leaves B's pin", $('editImage').value, '');
        ok("and A's pin is not offered as B's", ![...$('editImage').options].some((o) => o.value === 'hatchabot/runtime:trial'));
        // A, then B while its list loads, then A again before it came: A's picker is drawn again, and Pin waits for A's list.
        editAgentId = 'a1'; await populateImagePicker('hatchabot/runtime:trial');
        editAgentId = 'a2';
        h.once(/\/v1\/runtime\/images$/);
        const pb = populateImagePicker('');
        await until(() => h.held.length === 1);
        editAgentId = 'a1';
        h.once(/\/v1\/runtime\/images$/);
        const pa2 = populateImagePicker('hatchabot/runtime:trial');
        await until(() => h.held.length === 2);
        eq("A again: its own pin, loading", [$('editImage').value, $('editImage').options.length], ['hatchabot/runtime:trial', 1]);
        const pinMark = window.__calls.length;
        await saveImagePin();
        eq('Pin while it loads sends nothing', window.__calls.slice(pinMark).filter((x) => x.method === 'PATCH').length, 0);
        await h.free(); await pb; await pa2;
        eq("then A's list, with A's pin", $('editImage').value, 'hatchabot/runtime:trial');
        // The Data tab: A's folder, added late, is not drawn in B's list.
        editAgentId = 'a1';
        $('pathNew').value = '/srv/made-up/notes'; $('pathAccess').value = 'ro';
        window.__answer = { 'POST /v1/agents/a1/data-sources': [{ body: { dataSources: [folder('a-old')] } }] };
        h.once(/\/v1\/agents\/a1\/data-sources$/, 'POST');
        const added = addDataSource();
        await until(() => h.held.length === 1);
        editAgentId = 'a2';
        renderDataList([folder('b-one'), folder('b-two')]);
        await h.free(); await added;
        eq("B's list stays B's", editData.map((d) => d.id), ['b-one', 'b-two']);
        ok("A's add is said with its name: " + toastText(), toastText().startsWith('Homework Helper: Folder added'));
        window.__confirmAnswer = true;
        window.__answer = { 'PATCH /v1/agents/a2': [{ body: { dataSources: [folder('b-two')] } }] };
        await removeDataSource('b-one');
        eq("B's legacy folder removal sends B's other folders, to B", calls('PATCH', /\/v1\/agents\/a2$/).at(-1).body, { sharedPaths: ['/srv/made-up/b-two'] });
        // A value typed for A and not added does not carry to B.
        prepareEdit('a1', 'Homework Helper');
        $('envName').value = 'MADE_UP_KEY'; $('envValue').value = 'made-up-value'; $('pathNew').value = '/srv/made-up/a';
        prepareEdit('a1', 'Homework Helper');
        eq('the same agent again: its own draft', $('envValue').value, 'made-up-value');
        prepareEdit('a2', 'Soccer Schedule');
        eq('another agent: the boxes are empty', [$('envName').value, $('envValue').value, $('pathNew').value], ['', '', '']);
        // And the choices beside them: write access, a public repo.
        prepareEdit('a1', 'Homework Helper');
        $('pathAccess').value = 'rw'; $('repoAccess').value = 'rw'; $('repoPublic').checked = true; onRepoPublic();
        prepareEdit('a1', 'Homework Helper');
        eq('the same agent again: its choices', [$('pathAccess').value, $('repoPublic').checked], ['rw', true]);
        prepareEdit('a2', 'Soccer Schedule');
        eq('another agent: read-only, not public', [$('pathAccess').value, $('repoAccess').value, $('repoPublic').checked], ['ro', 'ro', false]);
      } finally {
        await h.free(); window.__answer = {}; window.__confirmAnswer = true;
        for (const f of ['envName', 'envValue', 'pathNew']) $(f).value = '';
        $('pathAccess').value = 'ro'; $('repoAccess').value = 'ro'; $('repoPublic').checked = false; onRepoPublic();
        editAgentId = null; delete $('editImage').dataset.agent; delete $('editImage').dataset.loading;
      }
    },
    sheetRepliesStayWithTheirAgent: async () => {
      // HB-0590, HB-0587: a class or an app update for A, answered after B's sheet opened, leaves B's sheet alone and names A.
      const h = auditHold();
      const SHA = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
      const APP = { app: 'demoapp', name: 'Demo App', source: '/home/tester/demoapp', ref: 'HEAD', sha: SHA, previousSha: null,
        installedAt: new Date(Date.now() - 3600e3).toISOString(), testOk: true, tasks: ['demoapp-tick'] };
      const toastText = () => $('toast').textContent;
      const paint = window.renderModelPickerForAgent, painted = [];
      window.__override['/v1/agent-classes'] = { classes: [{ id: 'class-school', name: 'School', model: 'claude-sonnet-5' }] };
      window.__override['/v1/agents/a1/app'] = { app: APP, pending: null, canChange: true };
      window.__override['/v1/agents/a2/app'] = { app: APP, pending: null, canChange: true };
      try {
        v2AppCache = null;
        openV2Agent('a1', 'overview');
        await until(() => $('editClass') && $('editClass').querySelector('option[value="class-school"]') && $('v2AppUpdateBtn'));
        // The class.
        window.renderModelPickerForAgent = (a) => { painted.push(a && a.id); return paint(a); };
        $('editClass').value = 'class-school';
        window.__answer = { 'POST /v1/agents/a1/class': [{ body: { classId: 'class-school', rebuild: false } }] };
        h.once(/\/v1\/agents\/a1\/class$/, 'POST');
        const set = assignClass();
        await until(() => h.held.length === 1);
        v2AppCache = null;
        openV2Agent('a2', 'overview');
        await until(() => v2AgentId === 'a2' && $('editClass') && $('v2AppUpdateBtn'));
        await h.free(); await set;
        eq("B's model menu is not drawn for A", painted.filter((x) => x === 'a1'), []);
        ok('A is named: ' + toastText(), toastText().startsWith('Homework Helper: Class set'));
        window.renderModelPickerForAgent = paint;
        // The app update: A needs a value, and B's sheet is open.
        v2AppCache = null;
        openV2Agent('a1', 'overview');
        await until(() => v2AgentId === 'a1' && $('v2AppUpdateBtn'));
        window.__answer = { 'POST /v1/agents/a1/app/update': [{ status: 400, body: { error: 'Needs a value for: mailbox.', needs: [{ key: 'mailbox', label: 'its address', type: 'email' }], unchanged: true } }] };
        h.once(/\/v1\/agents\/a1\/app\/update$/, 'POST');
        const up = v2AppUpdate('a1', $('v2AppUpdateBtn'));
        await until(() => h.held.length === 1);
        v2AppCache = null;
        openV2Agent('a2', 'overview');
        await until(() => v2AgentId === 'a2' && $('v2AppUpdateBtn'));
        await h.free(); await up;
        ok("no form for A's value in B's sheet", !$('v2AppV_mailbox'));
        ok('A is named: ' + toastText(), toastText().startsWith("Homework Helper's app was not updated: it needs a value first"));
        // A's own sheet, but on another tab when it answers: the App row is not on screen, so where to give it is said.
        v2AppCache = null;
        openV2Agent('a1', 'overview');
        await until(() => v2AgentId === 'a1' && $('v2AppUpdateBtn'));
        window.__answer = { 'POST /v1/agents/a1/app/update': [{ status: 400, body: { error: 'Needs a value for: mailbox.', needs: [{ key: 'mailbox', label: 'its address', type: 'email' }], unchanged: true } }] };
        h.once(/\/v1\/agents\/a1\/app\/update$/, 'POST');
        const up2 = v2AppUpdate('a1', $('v2AppUpdateBtn'));
        await until(() => h.held.length === 1);
        openV2Agent('a1', 'advanced');
        await until(() => v2Tab === 'advanced' && !$('v2AppOut'));
        await h.free(); await up2;
        eq('its Advanced tab: said where to give it, with its name', toastText(), "Homework Helper's app was not updated: it needs a value first. Give it on its Overview, under App, and press Update again.");
      } finally {
        await h.free(); window.renderModelPickerForAgent = paint; window.__answer = {};
        for (const k of ['/v1/agent-classes', '/v1/agents/a1/app', '/v1/agents/a2/app']) delete window.__override[k];
        v2AppCache = null; try { v2Close(); } catch {}
      }
    },
    reportSaveAndDiscardKeepWhatCameAfter: async () => {
      // HB-0585: what is typed while a save is under way is kept, and saved too before it goes on.
      // HB-0586: discarding A leaves B, opened while A was deleted.
      const h = auditHold();
      const toastText = () => $('toast').textContent;
      const draft = (id, title, body) => ({ id, title, body, by: 'person', createdAt: new Date().toISOString(), issueUrl: 'https://example.com/' + id, fileName: id + '.md' });
      try {
        reportPaint(draft('r-a', 'Draft A', 'It stopped.'));
        $('reportBody').value = 'It stopped on home-server.';
        window.__answer = { 'PATCH /v1/problem-reports/r-a': [
          { body: draft('r-a', 'Draft A', 'It stopped on {name}.') }, { body: draft('r-a', 'Draft A', 'It stopped on {name}. Typed while it saved.') }] };
        const patches = calls('PATCH', /\/v1\/problem-reports\/r-a$/).length;
        h.once(/\/v1\/problem-reports\/r-a$/, 'PATCH');
        const rs = reportSaveEdits();
        await until(() => h.held.length === 1);
        $('reportBody').value = 'It stopped on home-server. Typed while it saved.';
        await h.free();
        const r = await rs;
        eq('the words typed while it saved are saved too', calls('PATCH', /\/v1\/problem-reports\/r-a$/).slice(patches).map((c) => c.body.body),
          ['It stopped on home-server.', 'It stopped on home-server. Typed while it saved.']);
        eq('what Copy or GitHub goes on with is the newest, masked', r && r.body, 'It stopped on {name}. Typed while it saved.');
        eq('and the field shows it', $('reportBody').value, 'It stopped on {name}. Typed while it saved.');
        ok('the masking is said: ' + toastText(), toastText().includes('the report shows what will be sent'));
        // Discard A; B is opened, and typed in, while A is deleted.
        window.__confirmAnswer = true;
        window.__override['/v1/problem-reports/r-b'] = draft('r-b', 'Draft B', 'body of B');
        h.once(/\/v1\/problem-reports\/r-a$/, 'DELETE');
        const gone = reportDiscard();
        await until(() => h.held.length === 1);
        await reportShow('r-b');
        $('reportBody').value = 'B, being typed';
        await h.free(); await gone;
        eq('B stays the draft shown', reportCur && reportCur.id, 'r-b');
        ok('its review open', !$('reportReview').hidden);
        eq('with what is typed in it', $('reportBody').value, 'B, being typed');
        ok('A was deleted', calls('DELETE', /\/v1\/problem-reports\/r-a$/).length >= 1);
      } finally {
        await h.free(); window.__answer = {}; window.__confirmAnswer = true;
        delete window.__override['/v1/problem-reports/r-b'];
        reportCur = null; reportGen++; $('reportBody').value = '';
        if (reportDlg.open) reportDlg.close();
      }
    },
    savedEditsLetTheSheetRedraw: async () => {
      // HB-0475: an edit saved no longer holds back the redraw after Start or Stop; one typed and not saved still does.
      const list = await (await fetch('/v1/agents')).json();
      const a = list.find((x) => x.id === 'a1');
      const set = async (state) => { window.__override['/v1/agents'] = list.map((x) => x.id === a.id ? { ...x, state } : x); await refresh(false); };
      try {
        await set('RUNNING');
        openV2Agent(a.id, 'personality');
        await until(() => $('v2Pane').querySelector('#editDesc'));
        const desc = $('editDesc');
        desc.value = 'Helps with homework, made up.';
        desc.dispatchEvent(new Event('input', { bubbles: true }));
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        await set('STOPPED');
        eq('typed and not saved: the redraw waits', v2SheetDrawnState, 'RUNNING');
        await saveDescription();
        await set('STOPPED');
        eq('saved: the next poll redraws it', v2SheetDrawnState, 'STOPPED');
        await set('RUNNING');
        eq('and Start redraws it again', v2SheetDrawnState, 'RUNNING');
      } finally {
        delete window.__override['/v1/agents']; await refresh(false);
        try { v2Close(); v2EditFor = null; v2SheetNotes.clear(); } catch {}
      }
    },
    sheetEditCountsUntilItsSave: async () => {
      // HB-0475 (review): an edit counts while its control differs from what it was. A token Connect used, then Stop:
      // the tab is drawn again. A slow rename of A, B's sheet opened and B's name typed: B keeps its name, its header and its hold.
      const list = await (await fetch('/v1/agents')).json();
      const set = async (id, state) => { window.__override['/v1/agents'] = list.map((x) => x.id === id ? { ...x, state } : x); await refresh(false); };
      const type = (el, value) => { el.focus(); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); };
      const h = auditHold();
      window.__override['/v1/agents/a1/channels'] = { channels: [], imageSupports: ['telegram'], spare: {} };
      try {
        // Telegram: the token typed, then used by Connect.
        await set('a1', 'RUNNING');
        openV2Agent('a1', 'messaging');
        const tok = await until(() => $('v2TgTokenIn'));
        $('v2TgToken').hidden = false;
        type(tok, 'made-up-token');
        await set('a1', 'STOPPED');
        eq('a token typed and not used: the redraw waits', v2SheetDrawnState, 'RUNNING');
        window.__confirmAnswer = true;
        window.__answer = { 'POST /v1/agents/a1/telegram': [{ body: { username: 'MadeUpBot', atNextStart: true } }] };
        await v2AddTelegram('a1', true);
        eq('Connect used it: the tab is drawn for the stopped agent', v2SheetDrawnState, 'STOPPED');
        v2Close(); v2SheetNotes.clear();
        // The rename: A's, slow; B's sheet opened meanwhile.
        await set('a2', 'RUNNING');
        openV2Agent('a1', 'personality');
        await until(() => v2AgentId === 'a1' && $('v2Pane').querySelector('#editName') && $('editName').value === 'Homework Helper');
        type($('editName'), 'Homework Helper, renamed');
        h.once(/\/v1\/agents\/a1$/, 'PATCH');
        const renamed = renameAgent();
        await until(() => h.held.length === 1);
        openV2Agent('a2', 'personality');
        await until(() => v2AgentId === 'a2' && $('v2Pane').querySelector('#editName') && $('editName').value === 'Soccer Schedule');
        type($('editName'), 'Soccer Schedule, typed');
        await h.free(); await renamed;
        eq("B's header is B's", $('editAgent').textContent, 'Soccer Schedule');
        ok('A is named: ' + $('toast').textContent, $('toast').textContent.startsWith('Homework Helper: Renamed'));
        await set('a2', 'STOPPED');
        eq("B's name, typed and not saved, still holds the redraw", v2SheetDrawnState, 'RUNNING');
        eq('and stays as typed', $('editName').value, 'Soccer Schedule, typed');
      } finally {
        await h.free(); window.__answer = {}; window.__confirmAnswer = true;
        delete window.__override['/v1/agents']; delete window.__override['/v1/agents/a1/channels']; await refresh(false);
        try { v2Close(); v2EditFor = null; v2SheetNotes.clear(); } catch {}
      }
    },
    sheetRefillsAreNotEdits: async () => {
      // HB-0475 (second review): a control code fills again is noted as filled, so it holds no redraw: a connection
      // attached (the picker and its box drawn again), the model menu opened and then drawn for a class, the
      // swap row filled again with the memory row.
      const list = await (await fetch('/v1/agents')).json();
      const a = list.find((x) => x.id === 'a1');
      let state = 'RUNNING';
      const flip = async () => { state = state === 'RUNNING' ? 'STOPPED' : 'RUNNING'; window.__override['/v1/agents'] = list.map((x) => x.id === a.id ? { ...x, state } : x); await refresh(false); return state; };
      const press = (el) => { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.focus(); el.blur(); };
      const pick = (el, value) => { press(el); if (el.type === 'checkbox') el.checked = value; else el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); };
      const conn = { id: 'c-made-up', kind: 'google', email: 'calendar@example.org', services: ['gmail'], createdAt: '2026-10-01T00:00:00Z', attachedTo: [] };
      window.__override['/v1/connections'] = { connections: [conn] };
      window.__override['/v1/agents/a1/connections'] = { accounts: [] };
      try {
        await flip(); await flip(); // RUNNING, drawn
        // A connection attached: the picker and the no-send box are drawn again by its success.
        openV2Agent('a1', 'knowledge');
        await until(() => $('v2Pane').querySelector('#connAttachPick option[value="c-made-up"]'));
        pick($('connAttachPick'), 'c-made-up'); pick($('connNoSend'), false);
        window.__answer = { 'POST /v1/agents/a1/connections/attach': [{ body: { live: true } }] };
        window.__override['/v1/connections'] = { connections: [{ ...conn, attachedTo: [{ id: 'a1' }] }] };
        await attachConnection();
        await until(() => !$('connAttachPick').querySelector('option[value="c-made-up"]'));
        eq('attached: the tab redraws for the new state', await flip(), v2SheetDrawnState);
        // The model menu opened and closed, then drawn again for a class with another model.
        openV2Agent('a1', 'ai');
        await until(() => $('v2Pane').querySelector('#editModel'));
        press($('editModel'));
        renderModelPickerForAgent({ ...a, profileModels: ['claude-sonnet-5', 'claude-opus-4-8'], profileDefaultModel: 'claude-sonnet-5', modelOverride: 'claude-opus-4-8' });
        eq('the menu drawn for the class: the tab redraws', await flip(), v2SheetDrawnState);
        // The memory and swap rows fill each other.
        openV2Agent('a1', 'advanced');
        await until(() => $('v2Pane').querySelector('#editSwapAllowance'));
        press($('editSwapAllowance')); press($('editMemoryCap'));
        fillMemoryCapRow({ ...v2Find('a1'), memoryCap: '4g', memoryCapEffective: '4g', swapAllowance: 'off' });
        eq('the rows filled again: the tab redraws', await flip(), v2SheetDrawnState);
        // And a box really typed in still holds it.
        const env = $('envName');
        env.focus(); env.value = 'MADE_UP_KEY'; env.dispatchEvent(new Event('input', { bubbles: true })); env.blur();
        const held = v2SheetDrawnState;
        await flip();
        eq('a name typed and not added: it waits', v2SheetDrawnState, held);
        env.value = '';
      } finally {
        window.__answer = {};
        for (const k of ['/v1/agents', '/v1/connections', '/v1/agents/a1/connections']) delete window.__override[k];
        await refresh(false);
        try { v2Close(); v2EditFor = null; v2SheetNotes.clear(); } catch {}
      }
    },
    editAnswersFollowWhatIsShown: async () => {
      // HB-0584, HB-0475 (third review): what a save in an agent's edit forms comes back with goes by what is on screen
      // (forAgent). A's variable removed, answered after B's Advanced tab opened: B's list stays B's, and A is named.
      // A's add refused while B's Overview shows: said in a toast with A's name, not under forms out of sight. B's
      // Schedule tab after an edit left on A's Advanced tab: A's edit holds nothing of B's. A file that would not
      // load: nothing unsaved.
      const list = await (await fetch('/v1/agents')).json();
      const set = async (state) => { window.__override['/v1/agents'] = list.map((x) => x.id === 'a2' ? { ...x, state } : x); await refresh(false); };
      const toastText = () => $('toast').textContent;
      const type = (el, value) => { el.focus(); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); };
      const h = auditHold();
      try {
        await set('RUNNING');
        // A's variable removed; B's Advanced tab opened while it went.
        openV2Agent('a1', 'advanced');
        await until(() => v2AgentId === 'a1' && editAgentId === 'a1' && $('v2Pane').querySelector('#envList'));
        renderEnvList([{ id: 'env-a', name: 'MADE_UP_A' }]);
        window.__confirmAnswer = true;
        window.__answer = { 'DELETE /v1/agents/a1/env/env-a': [{ body: { envVars: [] } }] };
        h.once(/\/v1\/agents\/a1\/env\/env-a$/, 'DELETE');
        const mark = window.__calls.length;
        const removed = removeEnvVar('env-a', 'MADE_UP_A');
        await until(() => h.held.length === 1);
        openV2Agent('a2', 'advanced');
        await until(() => v2AgentId === 'a2' && editAgentId === 'a2' && $('v2Pane').querySelector('#envList'));
        renderEnvList([{ id: 'env-b', name: 'MADE_UP_B' }]);
        await h.free(); await removed;
        ok("B's list stays B's: " + $('envList').textContent.trim(), $('envList').textContent.includes('MADE_UP_B'));
        ok('A is named: ' + toastText(), toastText().startsWith('Homework Helper: MADE_UP_A removed'));
        eq('removed from A', window.__calls.slice(mark).filter((x) => x.method === 'DELETE').map((x) => x.path), ['/v1/agents/a1/env/env-a']);
        // A's add refused, B's Overview open: the forms are still A's, out of sight.
        openV2Agent('a1', 'advanced');
        await until(() => v2AgentId === 'a1' && editAgentId === 'a1' && $('v2Pane').contains($('editErr')));
        $('envName').value = 'MADE_UP_KEY'; $('envValue').value = 'made-up-value';
        window.__answer = { 'POST /v1/agents/a1/env': [{ status: 400, body: { error: 'That name is taken.' } }] };
        await addEnvVar();
        eq('A shown: said under its forms', $('editErr').textContent, 'That name is taken.');
        window.__answer = { 'POST /v1/agents/a1/env': [{ status: 400, body: { error: 'That name is taken.' } }] };
        h.once(/\/v1\/agents\/a1\/env$/, 'POST');
        const adding = addEnvVar();
        await until(() => h.held.length === 1);
        openV2Agent('a2', 'overview');
        await until(() => v2AgentId === 'a2' && v2Tab === 'overview' && !$('v2Pane').contains($('editErr')));
        eq("B's Overview: the forms are still A's", editAgentId, 'a1');
        await h.free(); await adding;
        eq('said in a toast, with its name', toastText(), 'Homework Helper: That name is taken.');
        eq('not under the forms out of sight', $('editErr').textContent, '');
        // A's search test, answered after B's Advanced tab opened: not under B's button, said with A's name.
        openV2Agent('a1', 'advanced');
        await until(() => v2AgentId === 'a1' && editAgentId === 'a1' && $('v2Pane').querySelector('#agentSearchTestBtn'));
        window.__answer = { 'POST /v1/agents/a1/search-test': [{ body: { ok: true, detail: 'Search works: DuckDuckGo answered.' } }] };
        h.once(/\/v1\/agents\/a1\/search-test$/, 'POST');
        const testing = testAgentSearch();
        await until(() => h.held.length === 1);
        openV2Agent('a2', 'advanced');
        await until(() => v2AgentId === 'a2' && editAgentId === 'a2' && $('v2Pane').querySelector('#agentSearchTestOut'));
        await h.free(); await testing;
        eq("not under B's button", $('agentSearchTestOut').textContent, '');
        eq("said with A's name", toastText(), 'Homework Helper: ✓ Search works: DuckDuckGo answered.');
        // People who use another agent: A's list, answered after B's forms were filled, is not drawn in them.
        editAgentId = 'a1';
        window.__override['/v1/agents/a1/known-people'] = [{ userId: 'u-made-up', name: 'Sam Example' }];
        h.once(/\/v1\/agents\/a1\/known-people$/);
        const known = renderKnownPeople();
        await until(() => h.held.length === 1);
        editAgentId = 'a2'; $('tgKnownPeople').innerHTML = '';
        await h.free(); await known;
        ok("A's people are not offered on B's: " + $('tgKnownPeople').textContent, !$('tgKnownPeople').textContent.includes('Sam Example'));
        editAgentId = 'a1';
        await renderKnownPeople();
        ok("on A's, Add adds to A: " + $('tgKnownPeople').innerHTML, $('tgKnownPeople').innerHTML.includes("addKnownPerson('a1','u-made-up','Sam Example')"));
        // An edit left on A's Advanced tab, then B's Schedule tab.
        openV2Agent('a1', 'advanced');
        await until(() => v2AgentId === 'a1' && $('v2Pane').querySelector('#envName'));
        type($('envName'), 'MADE_UP_SECOND');
        ok('typed on A: unsaved', v2SheetUnsaved());
        openV2Agent('a2', 'schedule');
        await until(() => v2AgentId === 'a2' && $('v2Pane').contains($('cronBody')));
        ok("B's Schedule: A's edit is not B's", !v2SheetUnsaved());
        await set('STOPPED');
        eq('so Stop redraws it', v2SheetDrawnState, 'STOPPED');
        // A file that would not load: the file chosen is noted with it.
        openV2Agent('a1', 'personality');
        await until(() => v2AgentId === 'a1' && $('v2Pane').querySelector('#editFile') && $('editContent').value !== 'Loading…');
        window.__answer = { 'GET /v1/agents/a1/files/MEMORY.md': [{ status: 413, body: { error: 'MEMORY.md is over the size limit.' } }] };
        $('editFile').value = 'MEMORY.md'; $('editFile').dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => $('editErr').textContent.includes('nothing to save'));
        ok('it would not load: nothing unsaved', !v2SheetUnsaved());
      } finally {
        await h.free(); window.__answer = {}; window.__confirmAnswer = true;
        for (const f of ['envName', 'envValue']) $(f).value = '';
        $('editFile').value = 'SOUL.md'; $('editErr').textContent = ''; $('tgKnownPeople').innerHTML = '';
        delete window.__override['/v1/agents']; delete window.__override['/v1/agents/a1/known-people']; await refresh(false);
        try { v2Close(); v2EditFor = null; v2SheetNotes.clear(); } catch {}
      }
    },
    scheduleFormAndTestsStayWithTheirAgent: async () => {
      // HB-0591 (fifth review): a task typed on A's Schedule tab is not carried to B's, nor added there. A folder's Test,
      // answered after B's Knowledge tab opened, is not drawn under B's rows: said with A's name (checkDataSource).
      const h = auditHold();
      const toastText = () => $('toast').textContent;
      try {
        openV2Agent('a1', 'schedule');
        await until(() => v2AgentId === 'a1' && $('v2Pane').contains($('cronBody')));
        $('cronName').value = 'Water reminder'; $('cronMsg').value = 'Water the beds'; $('cronMode').value = 'every'; cronModeChanged(); $('cronEvery').value = '30';
        openV2Agent('a2', 'schedule');
        await until(() => v2AgentId === 'a2' && cronAgentId === 'a2' && $('v2Pane').contains($('cronBody')));
        eq("B's form is empty", ['cronName', 'cronMsg', 'cronEvery', 'cronMode'].map((id) => $(id).value), ['', '', '', 'cron']);
        const mark = window.__calls.length;
        await addCronJob();
        eq('and Add there creates nothing', window.__calls.slice(mark).filter((c) => c.method === 'POST' && /\/crons$/.test(c.path)).length, 0);
        $('cronErr').textContent = '';
        // A folder's Test, slow; B's Knowledge tab opened meanwhile.
        const folder = (id) => ({ id, kind: 'folder', hostPath: '/srv/made-up/' + id, mountName: id, access: 'ro' });
        openV2Agent('a1', 'knowledge');
        await until(() => v2AgentId === 'a1' && editAgentId === 'a1' && $('v2Pane').querySelector('#dataList'));
        renderDataList([folder('a-notes')]);
        const testBtn = await until(() => $('dataList').querySelector('[data-ds="a-notes"] button'));
        window.__answer = { 'POST /v1/agents/a1/data-sources/a-notes/check': [{ body: { ok: true, message: 'The folder is there and readable.' } }] };
        h.once(/\/v1\/agents\/a1\/data-sources\/a-notes\/check$/, 'POST');
        const checking = checkDataSource('a-notes', testBtn);
        await until(() => h.held.length === 1);
        openV2Agent('a2', 'knowledge');
        await until(() => v2AgentId === 'a2' && editAgentId === 'a2' && $('v2Pane').querySelector('#dataList'));
        renderDataList([folder('b-notes')]);
        await h.free(); await checking;
        ok("not under B's rows: " + $('dataList').textContent, !$('dataList').textContent.includes('readable'));
        eq("said with A's name", toastText(), 'Homework Helper: ✅ The folder is there and readable.');
      } finally {
        await h.free(); window.__answer = {};
        for (const id of ['cronName', 'cronMsg', 'cronEvery']) $(id).value = '';
        $('cronMode').value = 'cron'; cronModeChanged(); $('cronErr').textContent = '';
        try { v2Close(); v2EditFor = null; v2SheetNotes.clear(); } catch {}
      }
    },
    savedAfterARefillHoldsNothing: async () => {
      // HB-0475 (fourth review): a rename answered after the sheet was closed and opened again. The box shows what the
      // new open filled it with; the name sent is not noted under it, so it holds no redraw (and says nothing unsaved).
      const list = await (await fetch('/v1/agents')).json();
      const set = async (state) => { window.__override['/v1/agents'] = list.map((x) => x.id === 'a1' ? { ...x, state } : x); await refresh(false); };
      const h = auditHold();
      try {
        await set('RUNNING');
        openV2Agent('a1', 'personality');
        await until(() => v2AgentId === 'a1' && $('v2Pane').querySelector('#editName') && $('editName').value === 'Homework Helper');
        const name = $('editName');
        name.focus(); name.value = 'Homework Helper, renamed'; name.dispatchEvent(new Event('input', { bubbles: true })); name.blur();
        h.once(/\/v1\/agents\/a1$/, 'PATCH');
        const renamed = renameAgent();
        await until(() => h.held.length === 1);
        // Closed, as its close event does (that comes with an animation frame, which a headless run may hold back).
        v2Close(); v2AgentId = null; v2EditFor = null; v2SheetNotes.clear(); if (typeof v2NotesFor !== 'undefined') v2NotesFor = null;
        openV2Agent('a1', 'personality');
        await until(() => v2AgentId === 'a1' && $('v2Pane').querySelector('#editName') && $('editName').value === 'Homework Helper');
        await h.free(); await renamed;
        ok('the box as filled: nothing unsaved', !v2SheetUnsaved());
        await set('STOPPED');
        eq('so Stop redraws it', v2SheetDrawnState, 'STOPPED');
      } finally {
        await h.free(); delete window.__override['/v1/agents']; await refresh(false);
        try { v2Close(); v2EditFor = null; v2SheetNotes.clear(); } catch {}
      }
    },
    imageChoiceStaysAcrossTabs: async () => {
      // Sixth review: an image chosen on Advanced and not pinned yet stays when another tab is opened and Advanced again;
      // the sheet still counts it unsaved, and the machine's images are not read again.
      const imgs = /\/v1\/runtime\/images$/;
      const shut = () => { v2Close(); v2AgentId = null; v2EditFor = null; v2SheetNotes.clear(); if (typeof v2NotesFor !== 'undefined') v2NotesFor = null; };
      window.__override['/v1/runtime/images'] = { default: 'hatchabot/runtime:2026.9.8', tags: [
        { tag: 'hatchabot/runtime:made-up-one', exists: true, relation: 'newer' }, { tag: 'hatchabot/runtime:made-up-two', exists: true, relation: 'older' }] };
      const h = auditHold();
      try {
        shut(); delete $('editImage').dataset.agent; delete $('editImage').dataset.loading;
        // Eighth review: while its list loads, another tab and back does not read it again; the load under way fills it.
        h.once(imgs);
        const before = calls('GET', imgs).length;
        openV2Agent('a1', 'advanced');
        await until(() => h.held.length === 1);
        openV2Agent('a1', 'personality');
        await until(() => $('v2Pane').querySelector('#editName'));
        openV2Agent('a1', 'advanced');
        await until(() => $('v2Pane').querySelector('#editImage'));
        await sleep(50);
        eq('loading: the images not read again', calls('GET', imgs).length - before, 0);
        await h.free();
        await until(() => $('v2Pane').querySelector('#editImage') && !$('editImage').dataset.loading && [...$('editImage').options].some((o) => o.value === 'hatchabot/runtime:made-up-two'));
        await sleep(50);
        const read = calls('GET', imgs).length;
        const sel = $('editImage');
        ok('a choice to make', sel.value !== 'hatchabot/runtime:made-up-two');
        sel.value = 'hatchabot/runtime:made-up-two'; sel.dispatchEvent(new Event('change', { bubbles: true }));
        ok('chosen: unsaved', v2SheetUnsaved());
        openV2Agent('a1', 'personality');
        await until(() => $('v2Pane').querySelector('#editName'));
        openV2Agent('a1', 'advanced');
        await until(() => $('v2Pane').querySelector('#editImage'));
        await sleep(50);
        eq('back on Advanced: still chosen, still unsaved, the images not read again', [$('editImage').value, v2SheetUnsaved(), calls('GET', imgs).length - read], ['hatchabot/runtime:made-up-two', true, 0]);
        // Seventh review: a pin changed elsewhere (Bulk actions) while the sheet is open shows on Advanced, when nothing else is chosen here.
        sel.value = v2SheetNotes.get(sel); sel.dispatchEvent(new Event('change', { bubbles: true }));
        ok('the choice put back: nothing unsaved', !v2SheetUnsaved());
        openV2Agent('a1', 'personality');
        await until(() => $('v2Pane').querySelector('#editName'));
        const list = await (await fetch('/v1/agents')).json();
        window.__override['/v1/agents'] = list.map((x) => x.id === 'a1' ? { ...x, image: 'hatchabot/runtime:made-up-one' } : x);
        await refresh(false);
        // Ninth review: that refill loads as the first fill does: only the new pin offered, and Pin waits, until its list comes.
        h.once(imgs);
        openV2Agent('a1', 'advanced');
        await until(() => h.held.length === 1);
        eq('refilling: only the new pin, loading', [$('editImage').value, $('editImage').options.length, $('editImage').dataset.loading], ['hatchabot/runtime:made-up-one', 1, '1']);
        const pinMark = window.__calls.length;
        await saveImagePin();
        eq('Pin while it loads sends nothing', window.__calls.slice(pinMark).filter((x) => x.method === 'PATCH').length, 0);
        await h.free();
        await until(() => $('editImage').value === 'hatchabot/runtime:made-up-one' && !$('editImage').dataset.loading && $('editImage').options.length > 1);
        ok('the new pin shown, nothing unsaved', !v2SheetUnsaved());
      } finally {
        await h.free();
        delete window.__override['/v1/runtime/images']; delete window.__override['/v1/agents']; await refresh(false);
        shut(); editAgentId = null; delete $('editImage').dataset.agent; delete $('editImage').dataset.loading;
      }
    },
    runtimeChoicesStayAcrossTabs: async () => {
      // Ninth review: embed mode, memory cap and swap by the image's rule. A choice not saved yet stays when another tab is
      // opened and Advanced again, and counts as unsaved; a change made elsewhere shows when nothing is chosen here.
      const shut = () => { v2Close(); v2AgentId = null; v2EditFor = null; v2SheetNotes.clear(); if (typeof v2NotesFor !== 'undefined') v2NotesFor = null; };
      const MENUS = ['editEmbedMode', 'editMemoryCap', 'editSwapAllowance'];
      const change = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
      const tabAndBack = async () => {
        openV2Agent('a1', 'personality');
        await until(() => $('v2Pane').querySelector('#editName'));
        openV2Agent('a1', 'advanced');
        await until(() => MENUS.every((id) => $('v2Pane').querySelector('#' + id)));
        await sleep(50);
      };
      const dfltWas = myAccount.memoryCapDefault;
      try {
        shut();
        openV2Agent('a1', 'advanced');
        await until(() => MENUS.every((id) => $('v2Pane').querySelector('#' + id)));
        ok('opened: nothing unsaved', !v2SheetUnsaved());
        const chosen = MENUS.map((id) => { const el = $(id), o = [...el.options].find((x) => x.value !== el.value); change(el, o.value); return o.value; });
        ok('chosen: unsaved', v2SheetUnsaved());
        // Tenth review: the fleet default changed meanwhile (Settings): a kept choice's menu is worded afresh, its value kept.
        myAccount.memoryCapDefault = chosen[1] === '6g' ? '4g' : '6g';
        await tabAndBack();
        eq('back on Advanced: each still chosen', MENUS.map((id) => $(id).value), chosen);
        ok('and still unsaved', v2SheetUnsaved());
        eq('the cap menu names the fleet default as it is now', [...$('editMemoryCap').options].filter((o) => o.textContent.includes('(the fleet default)')).map((o) => o.value), [myAccount.memoryCapDefault]);
        myAccount.memoryCapDefault = dfltWas;
        for (const id of MENUS) change($(id), v2SheetNotes.get($(id)));
        ok('put back: nothing unsaved', !v2SheetUnsaved());
        openV2Agent('a1', 'personality');
        await until(() => $('v2Pane').querySelector('#editName'));
        const list = await (await fetch('/v1/agents')).json();
        const was = list.find((x) => x.id === 'a1');
        const moved = { embedMode: (was.embedMode || 'baked') === 'baked' ? 'shared' : 'baked', memoryCap: was.memoryCap === '4g' ? '2g' : '4g', swapAllowance: was.swapAllowance === 'off' ? '' : 'off' };
        window.__override['/v1/agents'] = list.map((x) => x.id === 'a1' ? { ...x, ...moved } : x);
        await refresh(false);
        openV2Agent('a1', 'advanced');
        await until(() => $('v2Pane').querySelector('#editMemoryCap') && $('editMemoryCap').value === moved.memoryCap);
        eq('changed elsewhere, nothing chosen here: shown', MENUS.map((id) => $(id).value), [moved.embedMode, moved.memoryCap, moved.swapAllowance]);
        ok('and nothing unsaved', !v2SheetUnsaved());
      } finally {
        myAccount.memoryCapDefault = dfltWas;
        delete window.__override['/v1/agents']; await refresh(false);
        shut(); editAgentId = null;
      }
    },
    scheduleEditStaysAcrossTabs: async () => {
      // Tenth review: Edit, Overview, back to Schedule, change the message, Save: the one task is changed, not added again.
      // Only another agent, or cancel, ends the edit.
      const clear = () => { for (const id of ['cronName', 'cronExpr', 'cronEvery', 'cronTz', 'cronMsg']) $(id).value = ''; $('cronErr').textContent = ''; };
      window.__crons = [{ id: 'c1', name: 'Morning brief', scheduleExpr: '0 8 * * *', message: 'Good morning', enabled: true, payloadKind: 'agentTurn' }];
      try {
        openV2Agent('a1', 'schedule');
        await until(() => cronAgentId === 'a1' && cronCache.some((c) => c.id === 'c1') && $('v2Pane').contains($('cronBody')));
        editCronJob('c1');
        openV2Agent('a1', 'overview');
        await until(() => v2Tab === 'overview' && !$('v2Pane').contains($('cronBody')));
        openV2Agent('a1', 'schedule');
        await until(() => $('v2Pane').contains($('cronBody')) && cronCache.some((c) => c.id === 'c1'));
        await sleep(50);
        eq('back on Schedule: still the edit, its button and its note', [cronEditingId, $('cronAddBtn').textContent, $('cronEditNote').style.display, $('cronName').value], ['c1', 'Save changes', '', 'Morning brief']);
        const mark = window.__calls.length;
        $('cronMsg').value = 'Good morning, made up';
        $('cronAddBtn').click();
        await until(() => $('cronAddBtn').textContent === 'Add task' && !$('cronAddBtn').disabled);
        const after = window.__calls.slice(mark);
        eq('the one task changed in place', after.filter((c) => c.method === 'PATCH').map((c) => [c.path, c.body]), [['/v1/agents/a1/crons/c1', { message: 'Good morning, made up' }]]);
        eq('and none added', after.filter((c) => c.method === 'POST' && /\/crons$/.test(c.path)).length, 0);
        // Another agent's Schedule tab ends it.
        editCronJob('c1');
        openV2Agent('a2', 'schedule');
        await until(() => cronAgentId === 'a2');
        eq('another agent: the edit ends', [cronEditingId, $('cronAddBtn').textContent, $('cronName').value], [null, 'Add task', '']);
      } finally {
        cancelCronEdit(); v2Close(); window.__crons = []; clear();
      }
    },
    scheduleEditEndsWithTheSheet: async () => {
      // Eleventh review: Edit, close the sheet, the task changes elsewhere, open it again and Save. Closing the sheet ended
      // the edit, so nothing of the old task is sent back over the change. And a Save sends only what was changed from what
      // Edit put in the form: a name changed elsewhere meanwhile stays.
      const clear = () => { for (const id of ['cronName', 'cronExpr', 'cronEvery', 'cronTz', 'cronMsg']) $(id).value = ''; $('cronErr').textContent = ''; };
      const sent = (mark) => window.__calls.slice(mark).filter((c) => c.method === 'PATCH' || (c.method === 'POST' && /\/crons$/.test(c.path))).map((c) => [c.method, c.path, c.body]);
      window.__crons = [{ id: 'c1', name: 'Morning brief', scheduleExpr: '0 8 * * *', message: 'Good morning', enabled: true, payloadKind: 'agentTurn' }];
      try {
        openV2Agent('a1', 'schedule');
        await until(() => cronAgentId === 'a1' && cronCache.some((c) => c.id === 'c1') && $('v2Pane').contains($('cronBody')));
        editCronJob('c1');
        v2Close();
        // The check's Chrome does not always deliver a dialog's close event (it comes with a frame): sent as a browser would.
        v2AgentDlg.dispatchEvent(new Event('close'));
        await until(() => !v2AgentDlg.open && v2AgentId === null);
        eq('closed: the edit ended, and what it put in the form went with it', [cronEditingId, $('cronAddBtn').textContent, $('cronName').value, $('cronMsg').value], [null, 'Add task', '', '']);
        window.__crons = [{ ...window.__crons[0], message: 'Good morning, changed elsewhere' }];
        openV2Agent('a1', 'schedule');
        await until(() => $('v2Pane').contains($('cronBody')) && cronCache.some((c) => c.message === 'Good morning, changed elsewhere'));
        await sleep(50);
        const mark = window.__calls.length;
        $('cronAddBtn').click();
        await sleep(150);
        eq('Save there sends nothing: the change made elsewhere stays', sent(mark), []);
        // Edit again; the name is changed elsewhere and the list read again; the message is changed here: only it is sent.
        clear();
        editCronJob('c1');
        window.__crons = [{ ...window.__crons[0], name: 'Morning brief (renamed elsewhere)' }];
        await loadCrons();
        $('cronMsg').value = 'Good morning, typed here';
        const mark2 = window.__calls.length;
        $('cronAddBtn').click();
        await until(() => $('cronAddBtn').textContent === 'Add task' && !$('cronAddBtn').disabled);
        eq('only the message: the name changed elsewhere is not put back', sent(mark2), [['PATCH', '/v1/agents/a1/crons/c1', { message: 'Good morning, typed here' }]]);
      } finally {
        cancelCronEdit(); v2Close(); window.__crons = []; clear();
      }
    },
    groupChatChoiceIsUnsaved: async () => {
      // Ninth review: Group chats and the room picker only show or hide fields, and Save is its own press: a change there
      // is unsaved, so the messaging tab is not drawn over under it when the agent's state changes. Only a control whose
      // change saves it (marked data-saves) is not counted.
      const shut = () => { v2Close(); v2AgentId = null; v2EditFor = null; v2SheetNotes.clear(); if (typeof v2NotesFor !== 'undefined') v2NotesFor = null; };
      const change = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
      const list = await (await fetch('/v1/agents')).json();
      try {
        shut();
        window.__override['/v1/agents/a1/channels'] = { channels: [{ kind: 'telegram', rooms: { mode: 'members' } }], imageSupports: [] };
        openV2Agent('a1', 'messaging');
        const mode = await until(() => document.getElementById('chanRoomMode-telegram'));
        await sleep(50);
        ok('opened: nothing unsaved', !v2SheetUnsaved());
        change(mode, 'off');
        ok('Group chats changed, not saved: unsaved', v2SheetUnsaved());
        document.activeElement?.blur?.();
        window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, state: a.state === 'RUNNING' ? 'STOPPED' : 'RUNNING' } : a);
        await refresh(false);
        await sleep(100);
        eq('its state changed: the tab is not drawn over the choice', [document.getElementById('chanRoomMode-telegram') === mode, mode.value], [true, 'off']);
        change(mode, 'members');
        ok('put back: nothing unsaved', !v2SheetUnsaved());
        const knocks = document.getElementById('chanKnocks-telegram');
        ok('Who can reach it saves on its change: marked, and not counted', !!knocks && knocks.hasAttribute('data-saves') && !v2SheetCounts(knocks));
        shut(); delete window.__override['/v1/agents']; await refresh(false);
        // The room picker (Discord's servers), the same.
        window.__override['/v1/agents/a2/channels'] = { channels: [{ kind: 'discord', rooms: { mode: 'room', roomId: 'srv-made-up-1' }, servers: [{ id: 'srv-made-up-1', name: 'Made-up Club' }, { id: 'srv-made-up-2', name: 'Made-up Team' }] }], imageSupports: ['discord'] };
        openV2Agent('a2', 'channels');
        const pick = await until(() => document.getElementById('chanRoomPick-discord'));
        ok('opened on Discord: nothing unsaved', !v2SheetUnsaved());
        change(pick, 'srv-made-up-2');
        ok('another server picked, not saved: unsaved', v2SheetUnsaved());
        change(pick, 'srv-made-up-1');
        ok('put back: nothing unsaved again', !v2SheetUnsaved());
      } finally {
        delete window.__override['/v1/agents/a1/channels']; delete window.__override['/v1/agents/a2/channels']; delete window.__override['/v1/agents'];
        await refresh(false);
        shut(); editAgentId = null;
      }
    },
    clearedAddBoxesAreNotEdits: async () => {
      // Eighth review: a draft typed into an Add box, kept through a close and reopen (and noted as filled then), then
      // added: the emptied box is as filled, so nothing is unsaved and the sheet still redraws after Stop.
      const list = await (await fetch('/v1/agents')).json();
      const set = async (state) => { window.__override['/v1/agents'] = list.map((x) => x.id === 'a1' ? { ...x, state } : x); await refresh(false); };
      const shut = () => { v2Close(); v2AgentId = null; v2EditFor = null; v2SheetNotes.clear(); if (typeof v2NotesFor !== 'undefined') v2NotesFor = null; };
      const type = (id, v) => { const el = $(id); el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); };
      const cases = [
        ['advanced', [['envName', 'MADE_UP_KEY'], ['envValue', 'made-up-value']], () => addEnvVar(), 'POST /v1/agents/a1/env', { envVars: [{ id: 'e1', name: 'MADE_UP_KEY' }] }],
        ['knowledge', [['pathNew', '/srv/made-up/notes']], () => addDataSource(), 'POST /v1/agents/a1/data-sources', { dataSources: [], state: 'RUNNING' }],
        ['knowledge', [['repoUrl', 'https://example.com/made-up/notes.git']], () => addGitSource(), 'POST /v1/agents/a1/data-sources', { dataSources: [{ id: 'g1', kind: 'git', repoUrl: 'https://example.com/made-up/notes.git', access: 'ro' }], state: 'RUNNING' }],
      ];
      try {
        for (const [tab, boxes, add, route, body] of cases) {
          await set('RUNNING');
          shut(); openV2Agent('a1', tab);
          await until(() => $('v2Pane').querySelector('#' + boxes[0][0]));
          for (const [id, v] of boxes) type(id, v);
          shut(); openV2Agent('a1', tab);
          await until(() => $('v2Pane').querySelector('#' + boxes[0][0]) && $(boxes[0][0]).value === boxes[0][1]);
          window.__answer = { [route]: [{ body }] };
          await add();
          window.__answer = {};
          eq(boxes[0][0] + ': added and emptied, nothing unsaved', [boxes.map(([id]) => $(id).value), v2SheetUnsaved()], [boxes.map(() => ''), false]);
          await set('STOPPED');
          eq(boxes[0][0] + ': so Stop redraws the sheet', v2SheetDrawnState, 'STOPPED');
        }
      } finally {
        window.__answer = {}; delete window.__override['/v1/agents']; await refresh(false);
        for (const id of ['envName', 'envValue', 'pathNew', 'repoUrl']) $(id).value = '';
        try { shut(); } catch {}
      }
    },
    setupFieldsSavedAfterARefill: async () => {
      // Seventh review: setup fields saved while the sheet was closed and opened again. The list the new open filled is
      // the baseline, as v2SheetSaving's guard keeps it: the sheet is not left "unsaved" for good.
      const list = await (await fetch('/v1/agents')).json();
      const fields = [{ key: 'p1', label: 'One', type: 'text', target: 'soul' }, { key: 'p2', label: 'Two', type: 'text', target: 'soul' }];
      const shut = () => { v2Close(); v2AgentId = null; v2EditFor = null; v2SheetNotes.clear(); if (typeof v2NotesFor !== 'undefined') v2NotesFor = null; };
      const h = auditHold();
      try {
        window.__override['/v1/agents'] = list.map((x) => x.id === 'a1' ? { ...x, state: 'RUNNING', parameters: fields } : x);
        await refresh(false);
        shut();
        openV2Agent('a1', 'personality');
        await until(() => $('v2Pane').querySelector('#paramList') && editParams.length === 2);
        $('paramList').querySelector('button.danger').click();
        ok('one removed: unsaved', v2SheetUnsaved());
        h.once(/\/v1\/agents\/a1$/, 'PATCH');
        const saving = saveSetupFields();
        await until(() => h.held.length === 1);
        shut();
        openV2Agent('a1', 'personality');
        await until(() => $('v2Pane').querySelector('#paramList') && editParams.length === 2);
        await h.free(); await saving;
        ok('saved after the refill: nothing held unsaved', !v2SheetUnsaved());
      } finally {
        await h.free(); delete window.__override['/v1/agents']; await refresh(false);
        try { shut(); } catch {}
      }
    },
    bulkRefusedIsNotDone: async () => {
      // HB-0595: a model saved but refused by its runtime, or one that waits for a rebuild, is not counted as done.
      try {
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        const ids = ['a1', 'a2', 'a4'];
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = ids.includes(cb.dataset.id); });
        $('faAction').value = 'model'; faRenderAction();
        const o = document.createElement('option'); o.value = 'claude-sonnet-5'; $('faModel').replaceChildren(o); $('faModel').value = o.value;
        agents.filter((x) => ids.includes(x.id)).forEach((x) => { x.profileModels = ['claude-sonnet-5']; });
        window.__answer = {
          'POST /v1/agents/a1/model': [{ body: { model: 'claude-sonnet-5', live: false, failed: true } }],
          'POST /v1/agents/a2/model': [{ body: { model: 'claude-sonnet-5', live: true } }],
          'POST /v1/agents/a4/model': [{ body: { model: 'claude-sonnet-5', rebuild: true } }],
        };
        await faApply();
        await until(() => !$('faApplyBtn').disabled);
        const said = $('faResults').textContent;
        ok('one done, one at its next rebuild, one not applied: ' + said, said.includes('1 done') && said.includes('1 saved, applied at its next rebuild') && said.includes('1 saved, but not applied: Homework Helper'));
        ok('and why, by name, with it: ' + said, said.includes('1 saved, but not applied: Homework Helper: saved, but its runtime refused it'));
        // Connect as peers: the answer names the sleeping agents, which take it at their next Start or Rebuild.
        $('faAction').value = 'peers-connect'; faRenderAction();
        const note = 'Soccer Schedule is asleep. A sleeping agent wakes for a message as it was; it takes this change at its next Start or Rebuild, and its card says its peers changed.';
        window.__answer = { 'POST /v1/agent-peers/mesh': [{ body: { connected: true, agents: 3, changed: 3, grants: 6, needRebuild: [], skipped: [], note } }] };
        await faApply();
        await until(() => !$('faApplyBtn').disabled);
        ok('Connect says which sleep: ' + $('faResults').textContent, $('faResults').textContent.endsWith(note));
      } finally {
        window.__answer = {};
        if (fleetActionsDlg.open) fleetActionsDlg.close();
        await refresh(false);
      }
    },
    importedShortTaskCanBeRenamed: async () => {
      // HB-0588: a task made elsewhere that runs every 1.5 s can be renamed; its cadence is not sent, and a new short one is still refused.
      window.__crons = [{ id: 'c1', name: 'Reminder', everyMs: 1500, message: 'Water the beds', enabled: true, payloadKind: 'agentTurn' },
        { id: 'c2', name: 'Weekly tidy', everyMs: 100000, message: 'Tidy the notes', enabled: true, payloadKind: 'agentTurn' }];
      try {
        openV2Agent('a1', 'schedule');
        await until(() => cronCache.some((c) => c.id === 'c2') && $('v2Pane').querySelector('#cronBody'));
        editCronJob('c1');
        eq('Edit shows its interval as the box can', $('cronEvery').value, '0.03');
        const mark = window.__calls.length;
        $('cronName').value = 'Water reminder'; $('cronErr').textContent = '';
        await addCronJob();
        const sent = window.__calls.slice(mark).filter((c) => c.method === 'PATCH' && c.path === '/v1/agents/a1/crons/c1');
        eq('the new name alone is sent', sent.map((c) => c.body), [{ name: 'Water reminder' }]);
        eq('no complaint', $('cronErr').textContent, '');
        // 1.670 is the 1.67 Edit put there: the same interval, not sent.
        editCronJob('c2');
        eq('Edit shows 1.67', $('cronEvery').value, '1.67');
        $('cronName').value = 'Weekly tidy, renamed'; $('cronEvery').value = '1.670'; $('cronErr').textContent = '';
        const m3 = window.__calls.length;
        await addCronJob();
        eq('only the name is sent', window.__calls.slice(m3).filter((c) => c.method === 'PATCH' && c.path === '/v1/agents/a1/crons/c2').map((c) => c.body), [{ name: 'Weekly tidy, renamed' }]);
        // A new task as short is refused, as before.
        cancelCronEdit();
        $('cronName').value = 'Too often'; $('cronMsg').value = 'Say hello.'; $('cronMode').value = 'every'; $('cronEvery').value = '0.03';
        const m2 = window.__calls.length;
        await addCronJob();
        ok('a new one that short is refused: ' + $('cronErr').textContent, /0\.25/.test($('cronErr').textContent) && !window.__calls.slice(m2).some((c) => c.method === 'POST' && /\/crons$/.test(c.path)));
      } finally {
        window.__crons = []; cancelCronEdit(); $('cronName').value = ''; $('cronMsg').value = ''; $('cronEvery').value = ''; $('cronErr').textContent = '';
        try { v2Close(); } catch {}
      }
    },
    mediaAtThePublicAddressAsksWhenItFails: async () => {
      // HB-0589: a picture or a player cannot ask for the second factor. It is drawn at once; at the public address, its load
      // failing (here: there is no file behind the stub) asks the file route whether it may be read (check=1, which reads
      // nothing) through api(), which asks for the factor, then loads it once more. Its folder is not read (ninth review).
      window.__override['/v1/second-factor'] = { factors: [{ id: 'sf-1', kind: 'totp' }], backupCodes: 3, need: 'yes', methods: ['totp', 'backup'], passkeyHere: false };
      const STEP = { status: 401, body: { error: 'second factor required', secondFactor: 'step-up' } };
      const pub = appConfig.publicAddress;
      const reads = () => calls('GET', /\/v1\/agents\/a1\/fs$/).length;
      const fileCalls = () => calls('GET', /\/v1\/agents\/a1\/fs\/file$/);
      const checks = () => fileCalls().filter((c) => /[?&]check=1$/.test(c.url)).length;
      try {
        window.__override['/v1/agents/a1/fs'] = { path: 'garden', entries: [{ name: 'plan.png', type: 'file', size: 2048, mtime: '' }, { name: 'walk.mp4', type: 'file', size: 2048, mtime: '' }] };
        openV2Agent('a1', 'files');
        await v2LoadFiles('a1', 'garden');
        await until(() => byText('#v2FilesDrop td', 'plan.png'));
        appConfig.publicAddress = true;
        window.__answer = { 'GET /v1/agents/a1/fs/file': [STEP, { body: {} }] };
        const n = checks(), r0 = reads();
        await v2OpenFile('a1', 'garden', 'plan.png', 2048);
        const img = $('v2Files').querySelector('img');
        ok('the picture is drawn at once', !!img);
        await until(() => sfDlg.open);
        eq('the file is checked only once its load failed', checks() - n, 1);
        sfDone();
        await until(() => img.getAttribute('src').endsWith('&again=1'));
        eq('given: checked again, and the picture loaded once more; its folder not read', [checks() - n, reads() - r0], [2, 0]);
        await until(() => $('v2Files').textContent.includes('could not be shown here'));
        ok('failing again, that is said', !$('v2Files').querySelector('img'));
        window.__answer = { 'GET /v1/agents/a1/fs/file': [STEP] };
        await v2OpenFile('a1', 'garden', 'walk.mp4', 2048);
        await until(() => sfDlg.open);
        byText('#sfDlg button', 'Cancel').click();
        await until(() => $('v2Files').textContent.includes('The second factor was not given'));
        ok('not given: said, and no player', !$('v2Files').querySelector('video'));
        // A reader in a frame (eighth review): the file's check first, through api(), which asks; then the frame reads the
        // sandboxed URL from the server. Its folder is not read, and the file is not downloaded through the page (ninth review).
        const filesRead = fileCalls().length, k = reads();
        window.__answer = { 'GET /v1/agents/a1/fs/file': [STEP, { body: {} }] };
        const pdf = v2OpenFile('a1', 'garden', 'map.pdf', 2048);
        await until(() => sfDlg.open);
        ok('no frame before the factor is given', !$('v2Files').querySelector('iframe'));
        sfDone();
        await pdf;
        const frame = $('v2Files').querySelector('iframe');
        eq('then the reader is drawn from the server URL', frame && frame.getAttribute('src'), '/v1/agents/a1/fs/file?path=' + encodeURIComponent('garden/map.pdf') + '&inline=1');
        eq('the check (check=1) asked twice, before and after the factor; nothing else of the file, and the folder not at all',
          [fileCalls().slice(filesRead).map((c) => /[?&]check=1$/.test(c.url)), reads() - k], [[true, true], 0]);
        appConfig.publicAddress = false;
        const m = reads();
        await v2OpenFile('a1', 'garden', 'plan.png', 2048);
        ok('at the private address the picture is drawn', !!$('v2Files').querySelector('img'));
        await sleep(200);
        eq('and its failing reads nothing', reads(), m);
      } finally {
        appConfig.publicAddress = pub; window.__answer = {};
        delete window.__override['/v1/second-factor']; delete window.__override['/v1/agents/a1/fs'];
        if (sfDlg.open) sfDlg.close();
        try { v2Close(); } catch {}
      }
    },
    costChartsFollowThePoll: async () => {
      // HB-0474: the poll reads the AI sources' Costs charts again, at most once a minute, and only those in sight
      // (an open drawer, on screen); one that fails keeps the chart drawn, with a note.
      const now = Date.now(), H = 3600e3;
      window.__override['/v1/usage/spend'] = { range: 'week', bucketHours: 3, planShare: 0, monthly: 0, models: [{ model: 'claude-sonnet-5', cost: 8 }], choices: [],
        buckets: Array.from({ length: 56 }, (_, i) => ({ at: new Date(now - (56 - i) * 3 * H).toISOString(), cacheWrite: 0.1, cacheRead: 0.02, output: 0.02, input: 0.003, tokens: 2e5 })),
        totals: { cacheWrite: 5.6, cacheRead: 1.1, output: 1.1, input: 0.2, cost: 8, tokens: 11e6 } };
      const asked = () => calls('GET', /\/v1\/usage\/spend$/).length;
      const poll = async () => { const n = asked(); aiChartsAt = Date.now() - 61000; await loadSourceUsage(); await sleep(150); return asked() - n; };
      try {
        openAiDlg('ai');
        const box = await until(() => document.querySelector('#aiList details.srcspend[open] .spendchart svg') && document.querySelector('#aiList details.srcspend[open]'));
        const chart = box.querySelector('.spendchart'), shown = () => document.querySelectorAll('#aiList details.srcspend[open] .spendchart').length;
        box.scrollIntoView({ block: 'center' });
        await sleep(100);
        let n = asked();
        await loadSourceUsage();
        await sleep(100);
        eq('within a minute of drawing: not again', asked(), n);
        const read = await poll();
        ok('a minute on, the poll reads the one in sight again: ' + read, read >= 1 && read <= shown());
        // Folded: not read, though it was drawn.
        box.open = false; await sleep(50);
        eq('a folded drawer: not read', await poll(), 0);
        box.open = true; await until(() => chart.querySelector('svg')); box.scrollIntoView({ block: 'center' }); await sleep(100);
        // Out of sight: scrolled away inside the dialog, or the dialog shut.
        const pad = document.createElement('div'); pad.style.height = '4000px'; $('aiList').prepend(pad);
        box.scrollIntoView({ block: 'center' }); pad.scrollIntoView({ block: 'start' }); await sleep(100);
        eq('scrolled out of sight: not read', await poll(), 0);
        pad.remove(); box.scrollIntoView({ block: 'center' }); await sleep(100);
        // A read again that fails: the chart stays, with a note.
        window.__answer = { 'GET /v1/usage/spend': Array.from({ length: shown() }, () => ({ status: 500, body: { error: 'The usage could not be read.' } })) };
        await poll();
        await until(() => chart.querySelector('.spendstale'));
        ok('the chart is still drawn', !!chart.querySelector('svg'));
        ok('with a note: ' + chart.querySelector('.spendstale').textContent, /The usage could not be read/.test(chart.querySelector('.spendstale').textContent));
        window.__answer = {};
        await poll();
        await until(() => !chart.querySelector('.spendstale'));
        ok('read again: the note goes', !chart.querySelector('.spendstale') && !!chart.querySelector('svg'));
        aiDlg.close();
        n = asked(); aiChartsAt = 0;
        await loadSourceUsage();
        await sleep(100);
        eq('with Settings closed, not at all', asked(), n);
      } finally { window.__answer = {}; delete window.__override['/v1/usage/spend']; if (aiDlg.open) aiDlg.close(); }
    },
    rebuildAllOwesStoppedAgents: async () => {
      // HB-0466: Rebuild all says a stopped agent is rebuilt when it next starts: it asks the server to owe it that.
      // Fourth review: only one a rebuild would change (here: on an older image); one already current is left as it is.
      // Sixth review: "would change" is the server's own answer (rebuild), and a request that fails is said, by name, not skipped.
      const list = await (await fetch('/v1/agents')).json();
      const own = (a) => a.runtimeRef && !a.migratedTo && (a.role ? a.role === 'owner' : true);
      const current = list.find((a) => own(a) && a.state === 'RUNNING' && a.id !== 'a1');
      const rebRe = /\/v1\/agents\/[^/]+\/rebuild$/;
      try {
        window.__override['/v1/agents'] = list.map((a) => a.id === current.id ? { ...a, state: 'STOPPED', updateAvailable: true, rebuild: undefined }
          : a.state === 'STOPPED' ? { ...a, updateAvailable: true, rebuild: { level: 'recommended', reasons: ['a newer runtime image is ready'] } } : a);
        await refresh(false);
        const down = agents.filter((a) => a.state === 'STOPPED' && own(a) && a.rebuild);
        ok('a stopped agent behind in the stub', down.length >= 1);
        window.__confirmAnswer = true;
        window.__answer = Object.fromEntries(down.map((a) => ['POST /v1/agents/' + a.id + '/rebuild', [{ status: 202, body: { rebuilding: false, atNextStart: true } }]]));
        const asked = window.__confirms.length, n = calls('POST', rebRe).length;
        await rebuildAll();
        ok('the question says it: ' + window.__confirms[asked], /stay(s)? down, and (is|each is) rebuilt when it next starts/.test(window.__confirms[asked]));
        const sent = calls('POST', rebRe).slice(n);
        eq('each stopped one is asked to wait for its next start', down.map((a) => sent.filter((c) => c.path === '/v1/agents/' + a.id + '/rebuild').map((c) => c.body)), down.map(() => [{ stoppedWaits: true }]));
        ok('and every one with stoppedWaits', sent.length > down.length && sent.every((c) => c.body.stoppedWaits === true));
        ok('the result says it: ' + $('toast').textContent, $('toast').textContent.includes(down.length + ' not running: ') && $('toast').textContent.includes('rebuilt when it next starts'));
        eq('the one the server says needs none is not asked', sent.filter((c) => c.path === '/v1/agents/' + current.id + '/rebuild').length, 0);
        // A refusal for being busy is skipped; any other failure is counted as failed, with its name and why.
        const running = agents.filter((a) => a.state === 'RUNNING' && own(a));
        window.__answer = {
          ['POST /v1/agents/' + running[0].id + '/rebuild']: [{ status: 409, body: { error: 'Another operation is already running on this agent.' } }],
          ['POST /v1/agents/' + running[1].id + '/rebuild']: [{ status: 500, body: { error: 'The machine did not answer.' } }],
        };
        await rebuildAll();
        const said = $('toast').textContent;
        ok('busy: skipped; failed: named, with why: ' + said, said.includes('1 skipped (busy or already changing)') && said.includes('1 failed — ' + running[1].name + ': The machine did not answer.'));
      } finally { window.__answer = {}; window.__confirmAnswer = true; delete window.__override['/v1/agents']; await refresh(false); }
    },
    webChatCountsAfterTheRead: async () => {
      // HB-0495: the log comes back as its last 100 messages. A message of the same words cut from its start no longer hides that the new one arrived.
      const list = await (await fetch('/v1/agents')).json();
      const a = list[1];
      const chat = '/v1/agents/' + a.id + '/chat';
      const box = $('wchatText');
      const at = (m) => new Date(Date.UTC(2026, 10, 8, 9, m)).toISOString();
      const pair = (m) => [{ role: 'user', text: 'ok', at: at(m) }, { role: 'assistant', text: 'Noted.', at: at(m) }];
      const reopen = async () => { webChatDlg.close(); await openWebChatPanel(a.id); await until(() => !$('wchatEmpty') || !$('wchatEmpty').textContent.includes('Loading')); };
      const unsure = async () => {
        window.__answer = { ['POST ' + chat]: [{ status: 504, body: { error: 'No answer within 280 s.' } }] };
        box.value = 'ok';
        await webChatSend();
        window.__answer = {};
      };
      try {
        window.__override[chat] = { messages: [...pair(0), ...pair(1), ...pair(2)] };
        await openWebChatPanel(a.id);
        await until(() => $('wchatLog').querySelector('.wchat-msg'));
        await unsure();
        // It arrived; the log is cut to its last six now, so the oldest "ok" is gone.
        window.__override[chat] = { messages: [...pair(1), ...pair(2), ...pair(3)] };
        await reopen();
        eq('it arrived: nothing comes back', [box.value, $('wchatErr').textContent], ['', '']);
        // It did not arrive: nothing after the read.
        await unsure();
        await reopen();
        eq('it did not: it comes back', box.value, 'ok');
        ok('with the note: ' + $('wchatErr').textContent, /may not have been delivered/.test($('wchatErr').textContent));
        // A log that gives a message no time: one with no time when it was read, and the new one, delivered, with none either.
        box.value = ''; $('wchatErr').textContent = ''; webChatUnsure.clear();
        const untimed = { role: 'user', text: 'ok' };
        window.__override[chat] = { messages: [untimed, ...pair(1), ...pair(2)] };
        await reopen();
        await unsure();
        window.__override[chat] = { messages: [untimed, ...pair(1), ...pair(2), untimed] };
        await reopen();
        eq('delivered with no time: nothing comes back', [box.value, $('wchatErr').textContent], ['', '']);
        await unsure();
        await reopen();
        eq('not delivered: it comes back', box.value, 'ok');
        // Tenth review: Send does not wait for the log. Sent while it loads, it goes at once and follows no read (sentAt,
        // as after a read that failed); when the log comes, the message and its answer stay after it.
        box.value = ''; $('wchatErr').textContent = ''; webChatUnsure.clear();
        const h = auditHold();
        h.once(new RegExp(chat + '$'), 'GET');
        webChatDlg.close();
        window.__override[chat] = { messages: [...pair(1), ...pair(2), ...pair(3)] };
        const opening = openWebChatPanel(a.id);
        await until(() => h.held.length === 1);
        const posts = calls('POST', new RegExp(chat + '$')).length;
        ok('while it loads, Send is on', !$('wchatSend').disabled);
        window.__answer = { ['POST ' + chat]: [{ body: { reply: 'Noted early.' } }] };
        box.value = 'ok early'; await webChatSend(); window.__answer = {};
        eq('sent at once, with no read before it', [calls('POST', new RegExp(chat + '$')).length - posts, box.value, (webChatUnsure.get(a.id) || []).map((s) => !!s.sentAt)], [1, '', [true]]);
        await h.free(); await opening;
        eq('the log came: the message and its answer stay after it', [...$('wchatLog').querySelectorAll('.wchat-msg:not([data-log])')].map((el) => el.textContent), ['ok early', 'Noted early.']);
        ok('the log drawn above them', $('wchatLog').querySelectorAll('.wchat-msg[data-log]').length === 6 && !$('wchatEmpty'));
        ok('and Send on', !$('wchatSend').disabled);
        // A fresh read for what follows.
        webChatUnsure.clear(); await reopen();
        // Answered with nothing in doubt, its record goes; the next "ok" keeps the count of those before it.
        window.__answer = { ['POST ' + chat]: [{ body: { reply: 'Noted.' } }, { body: { reply: 'Noted.' } }] };
        box.value = 'ok'; await webChatSend();
        box.value = 'ok'; await webChatSend(); window.__answer = {};
        eq('two answered: nothing kept for them', webChatUnsure.has(a.id), false);
        await unsure();
        eq('the third, a 504: kept, with the two before it', webChatUnsure.get(a.id).map((s) => [s.before, s.unsure]), [[2, true]]);
        window.__override[chat] = { messages: [...pair(1), ...pair(2), ...pair(3), ...pair(4), ...pair(5)] }; // the two answered, not the third
        await reopen();
        eq('the third did not arrive: it comes back', box.value, 'ok');
        box.value = ''; $('wchatErr').textContent = '';
        await unsure();
        window.__override[chat] = { messages: [...pair(1), ...pair(2), ...pair(3), ...pair(4), ...pair(5), ...pair(6)] };
        await reopen();
        eq('this one arrived: nothing comes back', [box.value, $('wchatErr').textContent], ['', '']);
        // "ok" answered, then "ok" again still waiting when the chat is closed and opened again; its 504 comes after.
        box.value = ''; $('wchatErr').textContent = ''; webChatUnsure.clear();
        await reopen();
        window.__answer = { ['POST ' + chat]: [{ body: { reply: 'Noted.' } }] };
        box.value = 'ok'; await webChatSend();
        const w = auditHold();
        w.once(new RegExp(chat + '$'), 'POST');
        box.value = 'ok'; const waiting = webChatSend();
        await until(() => w.held.length === 1);
        window.__override[chat] = { messages: [...pair(1), ...pair(2), ...pair(3), ...pair(4), ...pair(5), ...pair(6), ...pair(7)] }; // the first one's copy
        await reopen();
        eq('still waiting at the reopen: nothing comes back yet', [box.value, $('wchatErr').textContent], ['', '']);
        window.__answer = { ['POST ' + chat]: [{ status: 504, body: { error: 'No answer within 280 s.' } }] };
        await w.free(); await waiting; window.__answer = {};
        await reopen();
        eq('its 504 came after: the next open offers it', box.value, 'ok');
        // Seventh review: the read fails, "ok" is sent and gets a 502; the next read holds three earlier "ok" only: it comes back.
        const failRead = () => ({ ['GET ' + chat]: [{ status: 500, body: { error: 'Its conversation could not be read (made up).' } }] }); // a new list each time: the stub takes from it
        const sendAfterFailedRead = async () => {
          box.value = ''; $('wchatErr').textContent = ''; webChatUnsure.clear();
          window.__answer = failRead();
          webChatDlg.close(); await openWebChatPanel(a.id);
          eq('the read failed: said, and Send on', [$('wchatErr').textContent, $('wchatSend').disabled], ['Its conversation could not be read (made up).', false]);
          window.__answer = { ['POST ' + chat]: [{ status: 502, body: { error: 'The turn did not complete, and the message may have reached it.' } }] };
          box.value = 'ok'; await webChatSend(); window.__answer = {};
        };
        await sendAfterFailedRead();
        window.__override[chat] = { messages: [...pair(0), ...pair(1), ...pair(2)] };
        await reopen();
        eq('after a failed read, three earlier "ok" do not stand in for it: it comes back', box.value, 'ok');
        // Its copy timed after it was sent: it arrived, nothing comes back.
        await sendAfterFailedRead();
        window.__override[chat] = { messages: [...pair(0), ...pair(1), ...pair(2), { role: 'user', text: 'ok', at: new Date(Date.now() + 1000).toISOString() }] };
        await reopen();
        eq('its copy after it: nothing comes back', [box.value, $('wchatErr').textContent], ['', '']);
      } finally {
        window.__answer = {}; delete window.__override[chat];
        webChatUnsure.clear(); box.value = '';
        if (webChatDlg.open) webChatDlg.close();
      }
    },
    webChatEarlySendCountedOnce: async () => {
      // Eleventh review: "ok" sent while the conversation loads, and answered; its copy is in the read. Then "ok" again,
      // a 504 though it arrived. Counted against the read, the first was counted twice (in the read, and by its bubble),
      // and the second came back on reopen. Counted together by time, it does not; one that did not arrive still does.
      const list = await (await fetch('/v1/agents')).json();
      const a = list[1];
      const chat = '/v1/agents/' + a.id + '/chat';
      const box = $('wchatText');
      const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
      const older = [{ role: 'user', text: 'ok', at: ago(30) }, { role: 'assistant', text: 'Noted.', at: ago(30) }];
      const copy = () => { const at = new Date(Date.now() + 500).toISOString(); return [{ role: 'user', text: 'ok', at }, { role: 'assistant', text: 'Noted.', at }]; };
      const reopen = async () => { webChatDlg.close(); await openWebChatPanel(a.id); await until(() => !$('wchatEmpty') || !$('wchatEmpty').textContent.includes('Loading')); };
      const round = async (secondArrives) => {
        box.value = ''; $('wchatErr').textContent = ''; webChatUnsure.clear();
        if (webChatDlg.open) webChatDlg.close();
        const h = auditHold();
        h.once(new RegExp(chat + '$'), 'GET');
        const opening = openWebChatPanel(a.id);
        await until(() => h.held.length === 1);
        window.__answer = { ['POST ' + chat]: [{ body: { reply: 'Noted.' } }] };
        box.value = 'ok'; await webChatSend(); window.__answer = {};
        const first = copy();
        window.__override[chat] = { messages: [...older, ...first] };
        await h.free(); await opening;
        ok('the read came, with the first one in it', $('wchatLog').querySelectorAll('.wchat-msg.me[data-log]').length === 2);
        window.__answer = { ['POST ' + chat]: [{ status: 504, body: { error: 'No answer within 280 s.' } }] };
        box.value = 'ok'; await webChatSend(); window.__answer = {};
        window.__override[chat] = { messages: [...older, ...first, ...(secondArrives ? copy() : [])] };
        await reopen();
      };
      try {
        await round(true);
        eq('the second arrived: nothing comes back', [box.value, $('wchatErr').textContent], ['', '']);
        await round(false);
        eq('it did not: it comes back', box.value, 'ok');
        ok('with the note: ' + $('wchatErr').textContent, /may not have been delivered/.test($('wchatErr').textContent));
      } finally {
        window.__answer = {}; delete window.__override[chat];
        webChatUnsure.clear(); box.value = ''; $('wchatErr').textContent = '';
        if (webChatDlg.open) webChatDlg.close();
      }
    },
  });
  // The 2026-11-05 workflow audit (made-up data).
  Object.assign(T, {
    inviteSharesOnlyWhenNeeded: async () => {
      // HB-0408: the tick is met by a source already shared, and it says what it did.
      const was = profiles;
      const key = { vendor: 'anthropic', kind: 'api_key', credential: 'api-key', mine: true, model: 'claude-sonnet-5', models: [], inUse: { mine: 0, others: 0 } };
      const A = { ...key, id: 'pA', name: 'Household key', shared: true }, B = { ...key, id: 'pB', name: 'Spare key', shared: false };
      const patches = () => calls('PATCH', /\/v1\/ai-profiles\/p[AB]$/);
      const invite = async (list) => {
        window.__override['/v1/ai-profiles'] = list;
        window.__answer = { ...window.__answer, 'POST /v1/local-accounts': [{ body: { claimPath: '/claim/made-up' } }] };
        $('acctNewUser').value = 'newcomer'; $('acctShareSource').checked = true;
        await addAccount(document.createElement('button'));
        return $('acctInviteNote').textContent;
      };
      try {
        let before = patches().length;
        const already = await invite([A, B]);
        eq('one already shared: nothing more is shared', patches().length, before);
        ok('and it says which: ' + already, already.includes('Household key') && already.includes('already shared'));
        before = patches().length;
        const shared = await invite([B]);
        eq('none shared: the one is shared', patches().slice(before).map((c) => [c.path, c.body]), [['/v1/ai-profiles/pB', { shared: true }]]);
        ok('and it is named: ' + shared, shared.includes('Spare key') && shared.includes('now shared'));
        before = patches().length;
        const none = await invite([{ ...B, credential: 'machine-login' }]);
        eq('a machine login is not shared', patches().length, before);
        ok('and it says nothing could be: ' + none, none.includes('No AI source was shared'));
        // Review of HB-0408: a machine login shared before the server refused that is one a new account cannot use.
        const login = { ...A, credential: 'machine-login', kind: 'subscription', name: 'Machine login' };
        before = patches().length;
        const past = await invite([login, B]);
        eq('a shared machine login does not count: the key is shared', patches().slice(before).map((c) => [c.path, c.body]), [['/v1/ai-profiles/pB', { shared: true }]]);
        ok('and the note does not offer the login: ' + past, past.includes('Spare key') && !past.includes('Machine login'));
        before = patches().length;
        const alone = await invite([login]);
        eq('alone, nothing is shared', patches().length, before);
        ok('and it says they have none: ' + alone, alone.includes('No AI source was shared') && !alone.includes('They can use'));
        window.__answer['PATCH /v1/ai-profiles/pB'] = [{ status: 400, body: { error: 'Refused for the test.' } }];
        const refused = await invite([B]);
        ok('a refused share says so: ' + refused, refused.includes('could not be shared') && refused.includes('Refused for the test.') && refused.includes('Spare key'));
      } finally {
        delete window.__override['/v1/ai-profiles']; window.__answer = {}; profiles = was;
        $('acctNewUser').value = ''; $('acctInviteNote').textContent = ''; $('acctInviteOut').style.display = 'none';
        await refresh(true);
      }
    },
    aiSourceEditsSurviveThePoll: async () => {
      // HB-0410: the poll's usage figures no longer rebuild the rows; any other redraw keeps an unsaved edit.
      const p = profiles.find((x) => x.mine !== false);
      const saved = { avail: availableModels[p.id], model: p.model, models: p.models };
      availableModels[p.id] = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'];
      p.model = 'claude-sonnet-5'; p.models = [];
      try {
        renderAiList();
        const row = () => $('aiModel-' + p.id).closest('.pair');
        const first = row();
        $('aiModel-' + p.id).value = 'claude-opus-4-8'; renderExtras(p.id);
        const drawer = first.querySelector('details.srcspend'); drawer.open = false;
        await loadSourceUsage();
        ok('the poll leaves the row in place', row() === first);
        eq('the chosen default stays', $('aiModel-' + p.id).value, 'claude-opus-4-8');
        // The usage line still moves with the poll: a source being refused says so.
        window.__override['/v1/ai-profiles/usage'] = { sampledAt: new Date().toISOString(), sources: [{ id: p.id, status: 'limited', limitedSince: new Date().toISOString() }] };
        await loadSourceUsage();
        ok('the usage line follows the poll', $('aiUsage-' + p.id).textContent.includes('Rate-limited'));
        delete window.__override['/v1/ai-profiles/usage'];
        await loadSourceUsage();
        ok('and clears', !$('aiUsage-' + p.id).textContent.includes('Rate-limited'));
        // Any other redraw (another row's Save, a model list arriving) keeps the edit too.
        renderAiList();
        eq('a full redraw keeps the unsaved default', $('aiModel-' + p.id).value, 'claude-opus-4-8');
        // A list the server moved is not an edit: it shows.
        $('aiModel-' + p.id).value = 'claude-sonnet-5'; renderExtras(p.id); renderAiList();
        p.models = ['claude-haiku-4-5']; renderAiList();
        ok('a value the server moved shows', $('aiModels-' + p.id).value === 'claude-haiku-4-5');
        // Save sends the edit, and the row then shows what the server holds.
        $('aiModels-' + p.id).value = ''; renderExtras(p.id);
        const n = calls('PATCH', /\/v1\/ai-profiles\//).length;
        const list = await (await fetch('/v1/ai-profiles')).json();
        window.__override['/v1/ai-profiles'] = list.map((x) => x.id === p.id ? { ...x, model: 'claude-sonnet-5', models: ['claude-sonnet-5'] } : x);
        await saveAiProfile(p.id);
        eq('Save sent the edit', calls('PATCH', /\/v1\/ai-profiles\//).slice(n).map((c) => c.body.models), [['claude-sonnet-5']]);
        eq('after Save the row is not an edit', aiRowEdits(), {});
      } finally {
        delete window.__override['/v1/ai-profiles']; delete window.__override['/v1/ai-profiles/usage'];
        await refresh(true);
        const q = profiles.find((x) => x.id === p.id);
        availableModels[p.id] = saved.avail; Object.assign(q, { model: saved.model, models: saved.models });
        aiRowsDrawn = {}; renderAiList();
      }
    },
    aiSourceErrorsBesideTheControl: async () => {
      // HB-0442: a refusal shows on the row or tab in use, not in a closed drawer of another tab.
      const shown = (id) => !!$(id).offsetParent && $(id).textContent;
      const p = profiles.find((x) => x.mine !== false);
      try {
        await openAiDlg('ai');
        window.__answer = { ['PATCH /v1/ai-profiles/' + p.id]: [{ status: 400, body: { error: 'Refused share, for the test.' } }] };
        await shareAiProfile(p.id, !p.shared, false);
        eq('a refused share shows on its row', shown('aiRowErr-' + p.id), 'Refused share, for the test.');
        ok('and the closed drawer holds nothing', !$('aiErr').textContent);
        $('aiModel-' + p.id).value = '';
        await saveAiProfile(p.id);
        eq('a blank default model says so on its row', shown('aiRowErr-' + p.id), 'Default model is required.');
        renderAiList(); // the edit stays, as any edit does
        $('aiModel-' + p.id).value = p.model;
        window.__answer['PATCH /v1/ai-profiles/' + p.id] = [{ status: 400, body: { error: 'Refused save, for the test.' } }];
        await saveAiProfile(p.id);
        eq('a refused Save shows on its row', shown('aiRowErr-' + p.id), 'Refused save, for the test.');
        showTab('security');
        window.__answer['POST /v1/cli-tokens'] = [{ status: 403, body: { error: 'Refused token, for the test.' } }];
        await newCliToken();
        eq('a failed New token shows in its own tab', shown('cliTokenErr'), 'Refused token, for the test.');
      } finally { window.__answer = {}; showTab('ai'); aiDlg.close(); aiRowsDrawn = {}; renderAiList(); }
    },
    moveAgentsSkipsStayReadable: async () => {
      // HB-0445: every skip and its reason stays on screen, with what is left to move.
      const list = await (await fetch('/v1/agents')).json();
      const was = profiles;
      const other = { ...profiles[0], id: 'pOther', name: 'Spare key', shared: false, defaultSource: false };
      profiles = [...profiles, other];
      window.__override['/v1/ai-profiles'] = profiles;
      try {
        await refresh(true);
        moveAgentsToSource('pOther', 'Spare key');
        const boxes = () => [...document.querySelectorAll('.moveSourceCb')];
        const n = boxes().length;
        boxes().slice(0, 3).forEach((cb) => { cb.checked = true; });
        const [moved, a, b] = boxes().slice(0, 3).map((cb) => list.find((x) => x.id === cb.dataset.id));
        window.__answer = { 'POST /v1/ai-profiles/pOther/adopt-agents': [{ body: { switched: 1, rebuilding: 0, skipped: [{ name: a.name, reason: 'busy, for the test' }, { name: b.name, reason: 'too new, for the test' }] } }] };
        window.__override['/v1/agents'] = list.map((x) => x.id === moved.id ? { ...x, aiProfileId: 'pOther' } : x);
        await moveAgentsApply(false);
        ok('the dialog stays open', moveSourceDlg.open);
        const said = $('moveSourceErr').textContent;
        ok('the summary and both skips are there: ' + said, said.includes('1 switched') && said.includes(a.name + ': busy, for the test') && said.includes(b.name + ': too new, for the test'));
        eq('what moved has left the list', boxes().length, n - 1);
        // With nothing skipped it closes, as before.
        boxes()[0].checked = true;
        window.__answer = { 'POST /v1/ai-profiles/pOther/adopt-agents': [{ body: { switched: 1, rebuilding: 0, skipped: [] } }] };
        await moveAgentsApply(false);
        ok('no skips: closed', !moveSourceDlg.open);
      } finally {
        if (moveSourceDlg.open) moveSourceDlg.close();
        window.__answer = {}; delete window.__override['/v1/agents']; delete window.__override['/v1/ai-profiles'];
        profiles = was; await refresh(true); renderAiList();
      }
    },
    aiSourceEditKeepsOnlyWhatChanged: async () => {
      // Review of HB-0410: an unsaved edit holds the field the person changed; the other follows the server, and Save does not write it back.
      const p = profiles.find((x) => x.mine !== false);
      const path = '/v1/ai-profiles/' + p.id;
      const base = await (await fetch('/v1/ai-profiles')).json();
      const server = (model, models) => { window.__override['/v1/ai-profiles'] = base.map((x) => x.id === p.id ? { ...x, model, models } : x); };
      const dflt = () => $('aiModel-' + p.id), extras = () => $('aiModels-' + p.id).value;
      try {
        window.__override[path + '/available-models'] = { models: ['m-default', 'm-other', 'm-old'], source: 'curated' };
        server('m-default', ['m-default', 'm-other', 'm-old']);
        await refresh(true);
        await openAiDlg('ai');
        await until(() => dflt().tagName === 'SELECT');
        eq('the row as drawn', [dflt().value, extras()], ['m-default', 'm-old,m-other']);
        // Only the default changes. That takes it out of the list on the page, which is not a change to the list.
        dflt().value = 'm-other'; dflt().dispatchEvent(new Event('change', { bubbles: true }));
        eq('one field in the edit', aiRowEdits()[p.id], { model: 'm-other' });
        // ⟳ Sync moves the list on the server: the old one must not come back over it.
        window.__override[path + '/available-models'] = { models: ['m-default', 'm-other', 'm-new'], source: 'runtime' };
        server('m-default', ['m-default', 'm-other', 'm-new']);
        await syncModels(p.id, 'A source');
        eq('after Sync: the edit stays, the list follows', [dflt().value, extras()], ['m-other', 'm-new']);
        // Save sends that list: no dropped model back, no new one lost.
        await saveAiProfile(p.id);
        const sent = applyModelDlg.open ? { model: applyModelState.model, extras: applyModelState.extras } : (() => { const b = calls('PATCH', new RegExp(path + '$')).at(-1).body; return { model: b.model, extras: b.models.slice(1) }; })();
        if (applyModelDlg.open) applyModelDlg.close();
        eq('Save carries the edit and the server list', sent, { model: 'm-other', extras: ['m-new'] });
        // The other way round: only the list changes; another device moves the default.
        aiRowsDrawn = {}; server('m-default', ['m-default', 'm-other', 'm-new']);
        await refresh(true); renderAiList();
        byText('#aiExtras-' + p.id + ' button', '×').click();
        const left = extras();
        ok('one bubble removed: ' + left, left.split(',').length === 1);
        eq('one field in the edit', Object.keys(aiRowEdits()[p.id]), ['models']);
        const keep = left;
        server(keep === 'm-new' ? 'm-other' : 'm-new', ['m-default', 'm-other', 'm-new']);
        await refresh(true); renderAiList();
        eq('the default follows the server', dflt().value, keep === 'm-new' ? 'm-other' : 'm-new');
        ok('the removal stays: ' + extras(), !extras().includes(keep === 'm-new' ? 'm-other' : 'm-new') && extras().includes(keep));
        const n = calls('PATCH', new RegExp(path + '$')).length;
        await saveAiProfile(p.id);
        eq('Save writes the server default, not the stale one', calls('PATCH', new RegExp(path + '$')).slice(n).map((c) => c.body.model), [keep === 'm-new' ? 'm-other' : 'm-new']);
      } finally {
        if (applyModelDlg.open) applyModelDlg.close();
        if (aiDlg.open) aiDlg.close();
        delete window.__override['/v1/ai-profiles']; delete window.__override[path + '/available-models'];
        delete availableModels[p.id]; delete staleModels[p.id];
        aiRowsDrawn = {}; await refresh(true); renderAiList();
      }
    },
    switchToSourceSaysRecoveryDidNotRun: async () => {
      // Review of HB-0411: "Recover context" does not reach an agent left down, and every surface says so and where the button is.
      const tax = agents.find((a) => a.name === 'Tax Filing');
      const toastText = () => document.getElementById('toast').textContent;
      const tells = (text) => /Recover context/.test(text) && /Personality/.test(text);
      for (const id of ['moveSourceRecover', 'faSourceRecover', 'migrateRecover']) ok('the box says it: ' + id, /stopped or sleeping agent is not recovered/i.test($(id).closest('label').textContent));
      const was = profiles;
      const other = { ...profiles[0], id: 'pOther', name: 'Spare key', shared: true, defaultSource: false };
      profiles = [...profiles, other];
      window.__override['/v1/ai-profiles'] = profiles;
      try {
        await refresh(true);
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === tax.id; });
        $('faAction').value = 'source'; faRenderAction();
        $('faSource').value = 'pOther';
        window.__answer = { 'POST /v1/ai-profiles/pOther/adopt-agents': [{ body: { switched: 1, rebuilding: 0, atNextStart: 1, notRecovered: 1, skipped: [] } }] };
        await faApply();
        await until(() => !$('faApplyBtn').disabled);
        ok('Bulk: ' + $('faResults').textContent, tells($('faResults').textContent));
        fleetActionsDlg.close();
        moveAgentsToSource('pOther', 'Spare key');
        document.querySelector('.moveSourceCb').checked = true;
        window.__answer = { 'POST /v1/ai-profiles/pOther/adopt-agents': [{ body: { switched: 1, rebuilding: 0, atNextStart: 1, notRecovered: 1, skipped: [] } }] };
        await moveAgentsApply(true);
        ok('Move agents here: ' + toastText(), tells(toastText()));
        migrateState = { id: 'p1', name: 'Old' };
        const opt = document.createElement('option'); opt.value = 'pOther'; $('migrateTo').replaceChildren(opt);
        window.__answer = { 'POST /v1/ai-profiles/p1/migrate-agents': [{ body: { switched: 2, agents: 2, otherAccounts: 0, rebuilding: 1, atNextStart: 1, notRecovered: 1, skipped: [] } }] };
        await runMigrate();
        ok('Migrate all: ' + toastText(), tells(toastText()));
      } finally {
        if (fleetActionsDlg.open) fleetActionsDlg.close();
        if (moveSourceDlg.open) moveSourceDlg.close();
        window.__answer = {}; delete window.__override['/v1/ai-profiles'];
        profiles = was; await refresh(true); renderAiList();
      }
    },
    classLeavingPendingSaid: async () => {
      // An agent whose class is applying a change leaves it once that is done: the answers say so, not "detached".
      const toastText = () => document.getElementById('toast').textContent;
      const tax = agents.find((a) => a.name === 'Tax Helper') || agents[0];
      const was = profiles;
      const other = { ...profiles[0], id: 'pOther', name: 'Spare key', shared: true, defaultSource: false };
      profiles = [...profiles, other];
      window.__override['/v1/ai-profiles'] = profiles;
      try {
        await refresh(true);
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === tax.id; });
        $('faAction').value = 'source'; faRenderAction();
        $('faSource').value = 'pOther';
        window.__answer = { 'POST /v1/ai-profiles/pOther/adopt-agents': [{ body: { switched: 1, rebuilding: 0, classDetached: 0, classDetachPending: 1, skipped: [] } }] };
        await faApply();
        await until(() => !$('faApplyBtn').disabled);
        const said = $('faResults').textContent;
        ok('the bulk switch says one may leave a class: ' + said, said.includes('1 may leave a class once the class change under way is done') && !said.includes('detached from a class'));
        fleetActionsDlg.close();
        editAgentId = tax.id;
        const pick = document.createElement('option'); pick.value = 'claude-haiku-4-5'; $('editModel').replaceChildren(pick); $('editModel').value = 'claude-haiku-4-5';
        window.__answer = { ['POST /v1/agents/' + tax.id + '/model']: [{ body: { model: 'claude-haiku-4-5', live: true, classDetached: 'pending' } }] };
        await switchModel();
        ok('the model change says the class decides after its change: ' + toastText(), toastText().includes('once that is done, it leaves the class') && !toastText().includes('Detached from its class'));
      } finally {
        if (fleetActionsDlg.open) fleetActionsDlg.close();
        window.__answer = {}; delete window.__override['/v1/ai-profiles'];
        profiles = was; await refresh(true);
      }
    },
    defaultModelClassLeavingSaid: async () => {
      // A new default that takes ticked agents off their class: the toast says so, the one still deciding too.
      const toastText = () => document.getElementById('toast').textContent;
      const tax = agents.find((a) => a.name === 'Tax Helper') || agents[0];
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'applyModelCb'; cb.dataset.id = tax.id; cb.checked = true;
      document.body.appendChild(cb);
      try {
        applyModelState = { profileId: 'p1', model: 'claude-haiku-4-5', extras: [] };
        window.__answer = { 'POST /v1/ai-profiles/p1/apply-default-model': [{ body: { applied: 2, live: 2, staged: 0, classDetached: 1, classDetachPending: 1 } }] };
        await applyModelToSelected();
        const said = toastText();
        ok('the new default says one left a class and one may: ' + said, said.includes('1 detached from a class') && said.includes('1 may leave a class once the class change under way is done'));
      } finally {
        cb.remove(); window.__answer = {}; applyModelState = null;
        await refresh(true);
      }
    },
    classLeftLimitsKeptSaid: async () => {
      // An agent that left its class but whose container kept the class's memory limits: each answer says so.
      const toastText = () => document.getElementById('toast').textContent;
      const tax = agents.find((a) => a.name === 'Tax Helper') || agents[0];
      const kept = 'Its container kept its old memory limits (a made-up refusal); a rebuild applies them.';
      const was = profiles;
      const other = { ...profiles[0], id: 'pOther', name: 'Spare key', shared: true, defaultSource: false };
      profiles = [...profiles, other];
      window.__override['/v1/ai-profiles'] = profiles;
      try {
        await refresh(true);
        await openFleetActions();
        await until(() => document.querySelectorAll('.faCb').length);
        document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === tax.id; });
        $('faAction').value = 'source'; faRenderAction();
        $('faSource').value = 'pOther';
        window.__answer = { 'POST /v1/ai-profiles/pOther/adopt-agents': [{ body: { switched: 1, rebuilding: 0, classDetached: 1, memoryPending: [tax.name + ': ' + kept], limitsKept: [{ name: tax.name, why: 'a made-up refusal' }], skipped: [] } }] };
        await faApply();
        await until(() => !$('faApplyBtn').disabled);
        const said = $('faResults').textContent;
        ok('the bulk switch names the agent whose container kept its limits: ' + said, said.includes(tax.name + ' left its class, but its container kept its old memory limits (a made-up refusal)'));
        fleetActionsDlg.close();
        editAgentId = tax.id;
        const pick = document.createElement('option'); pick.value = 'claude-haiku-4-5'; $('editModel').replaceChildren(pick); $('editModel').value = 'claude-haiku-4-5';
        window.__answer = { ['POST /v1/agents/' + tax.id + '/model']: [{ body: { model: 'claude-haiku-4-5', live: true, classDetached: true, memoryPending: kept, limitsKept: { name: tax.name, why: 'a made-up refusal' } } }] };
        await switchModel();
        ok('the model change says its container kept its limits: ' + toastText(), toastText().includes('It left its class, but its container kept its old memory limits (a made-up refusal)'));
      } finally {
        if (fleetActionsDlg.open) fleetActionsDlg.close();
        window.__answer = {}; delete window.__override['/v1/ai-profiles'];
        profiles = was; await refresh(true);
      }
    },
    connectedSheetFollowsTheAgent: async () => {
      // Review of HB-0411: "It answers you on Discord now" only when it is up; down or rebuilding it says when it will.
      const list = await (await fetch('/v1/agents')).json();
      const a = list.find((x) => x.name === 'Tax Filing');
      const chans = '/v1/agents/' + a.id + '/channels', one = '/v1/agents/' + a.id;
      const said = () => $('chanWait').textContent.trim();
      // Its check is run by hand: virtual time jumps, and a 4 s timer would race any deadline here.
      const realInterval = window.setInterval;
      const connected = (answer) => {
        let tick;
        window.setInterval = (f) => { tick = f; return 0; };
        try { chanShowConnected(answer); } finally { window.setInterval = realInterval; }
        return tick;
      };
      window.__override[chans] = { channels: [{ kind: 'discord', youAreLinked: true }], imageSupports: [] };
      try {
        window.__override[one] = { ...a, state: 'STOPPED', rebuildOnStart: 'now' };
        chanFor = a.id; chanKind = 'discord';
        chanDlg.showModal();
        let check = connected({ displayName: 'Bot', atNextStart: true, youAreLinked: true });
        await check();
        eq('stopped: not "now"', said(), '✓ Linked. It answers you on Discord once it is started.');
        ok('and the sheet still says it stays stopped', /It stays stopped/.test($('chanBody').textContent));
        // Started: its next start is the rebuild.
        window.__override[one] = { ...a, state: 'REBUILDING', rebuildOnStart: 'now' };
        await check();
        eq('rebuilding', said(), '✓ Linked. It answers you on Discord once it is back up.');
        window.__override[one] = { ...a, state: 'RUNNING', rebuildOnStart: undefined };
        await check();
        eq('up', said(), '✓ Linked. It answers you on Discord now.');
        chanDlg.close();
        // A running agent's connect is a rebuild: not "now" until it is back.
        window.__override[one] = { ...a, state: 'REBUILDING' };
        chanDlg.showModal();
        check = connected({ displayName: 'Bot', youAreLinked: true });
        await check();
        eq('rebuilding after a connect', said(), '✓ Linked. It answers you on Discord once it is back up.');
        // Its rebuild waiting for a slot: the state still says RUNNING, its operation does not.
        window.__override[one] = { ...a, state: 'RUNNING', operation: { kind: 'rebuild', status: 'queued' } };
        await check();
        eq('queued after a connect', said(), '✓ Linked. It answers you on Discord once it is back up.');
        chanDlg.close();
        // Not linked yet: a stopped agent that starts stops waiting for the start.
        window.__override[chans] = { channels: [{ kind: 'discord', youAreLinked: false }], imageSupports: [] };
        window.__override[one] = { ...a, state: 'STOPPED', rebuildOnStart: 'now' };
        chanDlg.showModal();
        check = connected({ displayName: 'Bot', atNextStart: true });
        eq('waits for the start', said(), 'Waiting for it to be started…');
        await check();
        eq('still', said(), 'Waiting for it to be started…');
        window.__override[one] = { ...a, state: 'RUNNING' };
        await check();
        eq('then for the request', said(), 'Waiting for your request…');
      } finally {
        window.setInterval = realInterval;
        if (chanDlg.open) chanDlg.close();
        delete window.__override[chans]; delete window.__override[one];
      }
    },
    webChatRefusedTextIsNotLost: async () => {
      // Review of HB-0446, and HB-0477: a refusal returns the text to its own agent's box, ahead of anything typed since, and takes out only its own bubble.
      const list = await (await fetch('/v1/agents')).json();
      const a = list[1], b = list[2];
      const chat = '/v1/agents/' + a.id + '/chat', chatB = '/v1/agents/' + b.id + '/chat';
      const log = $('wchatLog'), box = $('wchatText');
      const mine = () => [...log.querySelectorAll('.wchat-msg.me')].map((m) => m.textContent);
      const realFetch = window.fetch;
      // The send waits here, so the person can type, close and switch meanwhile.
      const hold = (status, error) => {
        let release;
        window.fetch = (input, init = {}) => {
          if ((init.method || 'GET') !== 'POST' || !String(input).endsWith(chat)) return realFetch(input, init);
          window.fetch = realFetch;
          return new Promise((r) => { release = () => r(new Response(JSON.stringify({ error }), { status })); });
        };
        return () => release();
      };
      window.__override[chat] = { messages: [{ role: 'user', text: 'older delivered' }, { role: 'assistant', text: 'older reply' }] };
      window.__override[chatB] = { messages: [] };
      try {
        await openWebChatPanel(a.id);
        // Finding: typed while waiting, then refused. Both stay, the refused text first.
        let go = hold(409, 'It is still answering your last message.');
        box.value = 'first line';
        let sending = webChatSend();
        box.value = 'next line';
        go(); await sending;
        eq('both kept, the refused text first', box.value, 'first line\nnext line');
        eq('its bubble left', mine(), ['older delivered']);
        box.value = '';
        // Finding: closed and reopened while it waited. The refusal takes nothing that was delivered.
        go = hold(429, 'Too many this hour.');
        box.value = 'pending message';
        sending = webChatSend();
        await sleep(0);
        webChatDlg.close();
        await openWebChatPanel(a.id);
        eq('the log reloaded without it', mine(), ['older delivered']);
        go(); await sending;
        eq('a delivered message stays', mine(), ['older delivered']);
        eq('and the text is back', box.value, 'pending message');
        // Finding: refused text is A's: not in B's box, and Enter there does not send it.
        webChatDlg.close();
        await openWebChatPanel(b.id);
        eq('B has an empty box', box.value, '');
        const posts = calls('POST', new RegExp(chatB + '$')).length;
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await sleep(0);
        eq('Enter sends nothing to B', calls('POST', new RegExp(chatB + '$')).length, posts);
        // A draft stays with its agent both ways.
        box.value = 'for B only';
        webChatDlg.close();
        await openWebChatPanel(a.id);
        eq('A has its text back', box.value, 'pending message');
        webChatDlg.close();
        await openWebChatPanel(b.id);
        eq('and B has its own', box.value, 'for B only');
        box.value = '';
        webChatDlg.close();
        await openWebChatPanel(a.id);
        box.value = '';
        // HB-0477: switched to another agent while it waited: the text waits in A's box, and B's is left alone.
        go = hold(409, 'It is busy (being rebuilt or moved) — try again shortly.');
        box.value = 'sent, then switched';
        sending = webChatSend();
        await sleep(0);
        webChatDlg.close();
        await openWebChatPanel(b.id);
        box.value = 'typing to B';
        go(); await sending;
        eq("B's box is untouched", box.value, 'typing to B');
        ok('the toast says where it went: ' + $('toast').textContent, $('toast').textContent.includes('back in its box'));
        webChatDlg.close();
        await openWebChatPanel(a.id);
        eq("A's box has it", box.value, 'sent, then switched');
        box.value = '';
        // The same with the chat closed altogether.
        go = hold(403, 'Web chat is not on for you with this agent.');
        box.value = 'sent, then closed';
        sending = webChatSend();
        await sleep(0);
        webChatDlg.close();
        go(); await sending;
        await openWebChatPanel(a.id);
        eq('closed: it is there on reopening', box.value, 'sent, then closed');
        box.value = '';
        // Finding: a 502 can follow the gateway's "accepted", so it may have got through: never offered for sending again.
        const before = mine().length;
        for (const [status, error] of [[502, 'The turn did not complete, and the message may have reached it.'], [500, 'Internal Server Error']]) {
          window.__answer = { ['POST ' + chat]: [{ status, body: { error } }] };
          box.value = 'maybe delivered ' + status;
          await webChatSend();
          ok(status + ': it stays as sent', mine().includes('maybe delivered ' + status));
          eq(status + ': nothing to send again', box.value, '');
          ok(status + ': and it says so: ' + $('wchatErr').textContent, /may have/.test($('wchatErr').textContent));
        }
        eq('two bubbles more', mine().length, before + 2);
      } finally {
        window.fetch = realFetch; window.__answer = {};
        delete window.__override[chat]; delete window.__override[chatB];
        webChatUnsure.clear();
        box.value = '';
        if (webChatDlg.open) webChatDlg.close();
      }
    },
    firstFactorKeepsItsCodes: async () => {
      // Review of HB-0446: at the public address, someone with no second factor cannot read who they are until they add one. That first read comes a poll later, and must not close their codes.
      const account = await (await fetch('/v1/account')).json();
      const expire = async () => {
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
      };
      const enrol = { status: 403, body: { error: 'Add a second factor first.', secondFactor: 'enrol' } };
      const wasShown = window.__sfEnrolShown;
      try {
        await expire();
        window.__sfEnrolShown = false;
        window.__override['/v1/account'] = { ...account, ownerId: 'new-person' };
        window.__answer = { 'GET /v1/account': Array.from({ length: 4 }, () => enrol) };
        $('loginUser').value = 'new-person'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        await until(() => aiDlg.open);
        ok('they are taken to add a factor', aiDlg.open && !loginDlg.open);
        window.__answer = {};
        // Whose they are, as the server says: shown once a read names them (at once: the page reads when they are held).
        const codes = showBackupCodes(['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'], 'new-person');
        await loadMyAccount();
        ok('the first read that works leaves the codes open', backupDlg.open && /AAAA-BBBB-CCCC/.test($('backupCodes').textContent));
        ok('and Access', aiDlg.open);
        closeBackupCodes();
        await codes;
        aiDlg.close();
        // The last person's Settings open when their session ended: closed, and what opens for this one is drawn for them, with no flag left over from before.
        aiDlg.showModal();
        const realClose = aiDlg.close;
        let closes = 0;
        aiDlg.close = function () { closes++; realClose.call(this); };
        window.__sfEnrolShown = true;
        $('sfTotpSecret').textContent = 'MADE-UP-SETUP'; $('sfCurPw').value = 'made-up';
        await expire();
        window.__override['/v1/account'] = { ...account, ownerId: 'next-person' };
        window.__answer = { 'GET /v1/account': Array.from({ length: 4 }, () => enrol) };
        $('loginUser').value = 'next-person'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        delete aiDlg.close;
        ok('the last person\'s Settings closed at the sign-in', closes >= 1);
        eq('with their half-done setup and typed password', [$('sfTotpSecret').textContent, $('sfCurPw').value], ['', '']);
        await until(() => aiDlg.open);
        ok('and this person is taken to add a factor', aiDlg.open);
        window.__answer = {};
        await loadMyAccount();
        ok('which the first read that works leaves open', aiDlg.open);
        aiDlg.close();
        // A failed read at the sign-in, then a good one: a recovery code stays.
        await expire();
        window.__override['/v1/account'] = { ...account, ownerId: 'another-person' };
        window.__answer = { 'GET /v1/account': Array.from({ length: 4 }, () => ({ status: 500, body: { error: 'made up' } })) };
        $('loginUser').value = 'another-person'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        window.__answer = {};
        showRecoveryCode('MADE-UP-CODE', '', 'another-person', { here: true }); // what that sign-in brought
        await loadMyAccount();
        ok('a recovery code stays open', recoveryDlg.open && $('recoveryCode').textContent === 'MADE-UP-CODE');
        recoveryDlg.close();
        // What was open for the last person did not wait for that read.
        await refresh(true);
        v2Close();
        {
          aiDlg.showModal();
          await expire();
          window.__override['/v1/account'] = { ...account, ownerId: 'third-person' };
          window.__answer = { 'GET /v1/account': Array.from({ length: 4 }, () => ({ status: 500, body: { error: 'made up' } })) };
          window.__sfEnrolShown = false;
          $('loginUser').value = 'third-person'; $('loginAcctPw').value = 'made-up';
          await acctSignIn();
          ok('what the last person had open is closed at the sign-in', !aiDlg.open);
        }
      } finally {
        window.__answer = {};
        window.__sfEnrolShown = wasShown;
        window.__override['/v1/account'] = account;
        await loadMyAccount();
        if (aiDlg.open) aiDlg.close();
        if (loginDlg.open) loginDlg.close();
        await refresh(true);
      }
    },

    webChatEndsWithTheSession: async () => {
      // Review of HB-0446: a 401 and a sign-in do not reload the page. Nothing of one person's chat reaches the next, and the same person gets their words back.
      const list = await (await fetch('/v1/agents')).json();
      const base = list.find((a) => a.id === 'a1');
      const account = await (await fetch('/v1/account')).json();
      const chat = '/v1/agents/w1/chat';
      const box = $('wchatText'), log = $('wchatLog');
      const posts = () => calls('POST', new RegExp(chat + '$')).length;
      const realFetch = window.fetch;
      const expire = async () => {
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        window.__answer = {};
      };
      const signIn = async (ownerId) => {
        window.__override['/v1/account'] = { ...account, ownerId };
        $('loginUser').value = 'next-person'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        ok('signed in', !loginDlg.open);
      };
      window.__override['/v1/agents'] = [...list, { ...base, id: 'w1', name: 'Book Club', role: 'user', ownerId: 'o2', webChat: true, botUsername: undefined, deepLink: undefined, otherChannels: [] }];
      window.__override[chat] = { messages: [{ role: 'user', text: 'First person line' }, { role: 'assistant', text: 'Reply to the first person' }] };
      try {
        await refresh(true);
        // Chat closed when the session ends: the next account's box is empty.
        await openWebChatPanel('w1');
        box.value = 'First person draft';
        webChatDlg.close();
        await expire();
        await signIn('someone-else');
        await openWebChatPanel('w1');
        eq('the next account has an empty box', box.value, '');
        webChatDlg.close();
        // Chat open when the session ends: it closes, with what it showed; Enter sends nothing.
        await signIn('o1');
        await openWebChatPanel('w1');
        await until(() => log.querySelector('.wchat-msg'));
        box.value = 'A draft with the chat open';
        await expire();
        ok('the chat closed with the session', !webChatDlg.open);
        eq('and nothing of it is left on the page', [box.value, log.textContent], ['', '']);
        const before = posts();
        box.value = 'typed by nobody'; await webChatSend();
        eq('nothing can be sent into the old chat', posts(), before);
        box.value = '';
        await signIn('someone-else');
        ok('and it stays closed after the sign-in', !webChatDlg.open);
        eq('that draft is not for them either', [...webChatDrafts.values()], []);
        await signIn('o1');
        // The same person back: their words are still theirs.
        await openWebChatPanel('w1');
        box.value = 'Still mine';
        await expire();
        await signIn('o1');
        await openWebChatPanel('w1');
        eq('the same account gets its draft back', box.value, 'Still mine');
        box.value = '';
        // Signed in, and who it is cannot be read yet: nothing of the last person's opens.
        box.value = 'Waits for a name';
        await expire();
        window.__answer = { 'GET /v1/account': Array.from({ length: 6 }, () => ({ status: 500, body: { error: 'made up' } })) };
        $('loginUser').value = 'next-person'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        webChatDlg.close();
        await openWebChatPanel('w1');
        ok('it does not open: ' + $('toast').textContent, !webChatDlg.open && /Could not check/.test($('toast').textContent));
        eq('and the box stays empty', box.value, '');
        window.__answer = {};
        await openWebChatPanel('w1');
        eq('once read, it is theirs again', box.value, 'Waits for a name');
        box.value = '';
        // A send on an ended session never arrived: it goes back, and only to whoever wrote it.
        window.__answer = { ['POST ' + chat]: [{ status: 401, body: { error: 'auth required' } }] };
        box.value = 'Sent too late';
        await webChatSend();
        await until(() => loginDlg.open);
        ok('no word of a maybe: ' + $('toast').textContent, !/may have|auth required/.test($('toast').textContent));
        window.__answer = {};
        await signIn('o1');
        await openWebChatPanel('w1');
        eq('a 401 gives the text back', box.value, 'Sent too late');
        ok('and it left the log', ![...log.querySelectorAll('.wchat-msg.me')].some((m) => m.textContent === 'Sent too late'));
        box.value = '';
        window.__answer = { ['POST ' + chat]: [{ status: 401, body: { error: 'auth required' } }] };
        box.value = 'Not for the next person';
        await webChatSend();
        await until(() => loginDlg.open);
        window.__answer = {};
        await signIn('someone-else');
        await openWebChatPanel('w1');
        eq('it does not go to another account', box.value, '');
        // Still waiting when the next person signs in: its refusal lands nowhere they can see.
        let release;
        window.fetch = (input, init = {}) => {
          if ((init.method || 'GET') !== 'POST' || !String(input).endsWith(chat)) return realFetch(input, init);
          window.fetch = realFetch;
          return new Promise((r) => { release = () => r(new Response(JSON.stringify({ error: 'Too many this hour.' }), { status: 429 })); });
        };
        box.value = 'Waiting while the session ended';
        const sending = webChatSend();
        await sleep(0);
        await expire();
        await signIn('o1');
        await openWebChatPanel('w1');
        release(); await sending;
        eq('a late refusal stays out of the next box', box.value, '');
        ok('and Send is free', !$('wchatSend').disabled);
        // A cancelled second factor at a sensitive step: nothing was delivered, and the person is still signed in.
        window.__answer = { ['POST ' + chat]: [{ status: 401, body: { error: 'second factor', secondFactor: 'step-up' } }], 'GET /v1/second-factor': [{ body: { methods: [] } }] };
        box.value = 'Second factor cancelled';
        const stepped = webChatSend();
        await until(() => sfDlg.open);
        await sfCancel();
        await stepped;
        window.__answer = {};
        eq('a cancelled factor gives the text back', box.value, 'Second factor cancelled');
        eq('and says only that', $('wchatErr').textContent, 'The second factor was not given.');
        box.value = '';
        // No answer: a sentence, then the advice.
        window.__answer = { ['POST ' + chat]: [{ reject: 'Failed to fetch' }] };
        box.value = 'No answer at all';
        await webChatSend();
        eq('the wording', $('wchatErr').textContent, 'Failed to fetch. It may have got through: reopen this chat to see before you send it again.');
        webChatUnsure.clear();
        // The rest of what a page held for one person goes when another account signs in.
        webChatDlg.close();
        moveAgentsToSource('p-made-up', 'Spare key');
        $('reportWhat').value = 'What the first person was reporting';
        $('reportTitle').value = 'First person title';
        reportCur = { id: 'r1', title: 'First person title', body: 'First person body' };
        $('reportBody').value = 'First person body'; $('reportRTitle').value = 'First person title';
        aiRowsDrawn = { p1: { model: 'm', models: '' } };
        applyModelState = { profileId: 'p1' }; migrateState = { id: 'p1', name: 'Old' };
        await expire();
        ok('held for the same person meanwhile', moveSourceState && reportCur);
        await signIn('someone-else');
        ok('the open dialog closed', !moveSourceDlg.open);
        eq('nothing kept', [moveSourceState, reportCur, applyModelState, migrateState, aiRowsDrawn], [null, null, null, null, {}]);
        eq('the report boxes are empty', ['reportWhat', 'reportTitle', 'reportBody', 'reportRTitle'].map((id) => $(id).value), ['', '', '', '']);
      } finally {
        window.fetch = realFetch; window.__answer = {};
        delete window.__override[chat]; delete window.__override['/v1/agents']; delete window.__override['/v1/account'];
        box.value = '';
        if (webChatDlg.open) webChatDlg.close();
        if (moveSourceDlg.open) moveSourceDlg.close();
        if (loginDlg.open) loginDlg.close();
        await refresh(true);
      }
    },
    signInEmptiesTypedFields: async () => {
      // HB-0498: an AI key typed and not saved, and the plan box, are not left for the next account to see or send.
      const account = await (await fetch('/v1/account')).json();
      const view = v2View;
      window.__override['/v1/agent-todos'] = { todos: [{ id: 't1', name: 'Recipe Box' }] };
      try {
        v2SetView('group'); await loadTodos();
        (await until(() => $('v2TodoNew'))).value = 'Planned by the first person';
        $('aiKey').value = 'made-up-unsaved-key'; $('aiToken').value = 'made-up-unsaved-token'; $('aiName').value = 'First person source';
        const secrets = ['mediaKey', 'searchKey', 'poolToken', 'dpoolToken', 'spoolBot', 'spoolApp', 'connClientSecret', 'envValue', 'wizBotToken', 'peerToken', 'adoptToken', 'acctCurPw', 'recCurPw'].filter((id) => $(id)); // adoptToken is drawn only for a channel being adopted
        const texts = ['cronMsg', 'agentPersona', 'editDesc'];
        for (const id of [...secrets, ...texts]) $(id).value = 'made-up-' + id;
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        window.__answer = {};
        window.__override['/v1/account'] = { ...account, ownerId: 'someone-else' };
        $('loginUser').value = 'someone-else'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        ok('signed in', !loginDlg.open);
        eq('the key form is empty', ['aiKey', 'aiToken', 'aiName'].map((id) => $(id).value), ['', '', '']);
        eq('every other key, token and current password', secrets.filter((id) => $(id).value), []);
        eq('and the free-text forms', texts.filter((id) => $(id).value !== $(id).defaultValue), []);
        eq('and so is the plan box, drawn again', (await until(() => $('v2TodoNew'))).value, '');
      } finally {
        window.__answer = {};
        window.__override['/v1/account'] = account;
        delete window.__override['/v1/agent-todos'];
        for (const id of ['aiKey', 'aiToken', 'aiName']) $(id).value = '';
        for (const el of document.querySelectorAll('input[type=password]')) if (!el.closest('#loginDlg')) el.value = '';
        for (const id of ['cronMsg', 'agentPersona', 'editDesc']) $(id).value = $(id).defaultValue;
        if (loginDlg.open) loginDlg.close();
        await loadMyAccount();
        v2SetView(view); await loadTodos();
        await refresh(true);
      }
    },
    ownCodesWaitForTheirPerson: async () => {
      // HB-0500: one-time codes open when the session ends leave the page, and come back to their own person alone,
      // even when this page never read who that was, or the read fails at the sign-in.
      const account = await (await fetch('/v1/account')).json();
      const lede = $('recoveryLede').innerHTML;
      const expire = async () => {
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        window.__answer = {};
      };
      const signIn = async (ownerId, readFails = false) => {
        window.__override['/v1/account'] = { ...account, ownerId };
        if (readFails) window.__answer = { 'GET /v1/account': Array.from({ length: 4 }, () => ({ status: 500, body: { error: 'made up' } })) };
        $('loginUser').value = 'made-up-user'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        window.__answer = {};
        ok('signed in', !loginDlg.open);
      };
      const codesShown = () => backupDlg.open && /AAAA-BBBB-CCCC/.test($('backupCodes').textContent);
      const offThePage = () => !backupDlg.open && $('backupCodes').textContent === '';
      try {
        // Made in Settings by someone this page has never read: the server says whose they are.
        pagePerson = null;
        window.__answer = { 'POST /v1/second-factor/backup-codes': [{ body: { backupCodes: ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'], ownerId: 'o-codes' } }] };
        const making = sfNewBackupCodes($('sfBackupBtn'));
        await until(codesShown);
        await expire();
        ok('off the page, not under the sign-in', offThePage());
        await signIn('o-codes');
        ok('back for their own person', codesShown());
        ok('Done still waits for "I have saved them"', $('backupDone').disabled);
        $('backupSaved').click(); $('backupDone').click();
        await making;
        ok('closed by Done', offThePage());
        // The read fails at the sign-in: they wait for one that works.
        const again = showBackupCodes(['AAAA-BBBB-CCCC'], 'o-codes');
        await expire();
        await signIn('o-codes', true);
        ok('not shown while who it is cannot be read', offThePage());
        await loadMyAccount();
        ok('back once it is read', codesShown());
        closeBackupCodes(); await again;
        // Another account: gone, and what waited on them goes on.
        let let_go = false;
        showBackupCodes(['AAAA-BBBB-CCCC'], 'o-codes').then(() => { let_go = true; });
        await expire();
        await signIn('someone-else');
        ok('not for another account', offThePage());
        await sleep(0);
        ok('what waited on them went on', let_go);
        await expire();
        await signIn('o-codes');
        ok('and not kept for later', offThePage());
        // A recovery code, the same way.
        const rc = showRecoveryCode('MADE-UP-RECOVERY', '<b>Made-up lede.</b>', 'o-codes');
        await expire();
        ok('the recovery code is off the page', !recoveryDlg.open && $('recoveryCode').textContent === '');
        await signIn('o-codes', true);
        ok('and stays off while who it is cannot be read', !recoveryDlg.open);
        await loadMyAccount();
        ok('back once it is read, with its words', recoveryDlg.open && $('recoveryCode').textContent === 'MADE-UP-RECOVERY' && $('recoveryLede').textContent === 'Made-up lede.');
        ok('still waiting for "I have saved it"', $('recoveryDone').disabled);
        recoveryDlg.close(); await rc;
        await sleep(0);
        eq('closed, it leaves the page', $('recoveryCode').textContent, '');
      } finally {
        window.__answer = {};
        window.__override['/v1/account'] = account;
        $('recoveryLede').innerHTML = lede;
        if (backupDlg.open) closeBackupCodes();
        if (recoveryDlg.open) recoveryDlg.close();
        if (loginDlg.open) loginDlg.close();
        await loadMyAccount();
        await refresh(true);
      }
    },
    anotherAccountReloadsThePage: async () => {
      // HB-0491: another account than the one this page showed loads the page again; the same account does not;
      // and not while a second-factor step is under way: backup codes, a recovery code, an authenticator app being added.
      const account = await (await fetch('/v1/account')).json();
      const lede = $('recoveryLede').innerHTML;
      const expire = async () => {
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        window.__answer = {};
      };
      const signIn = async (ownerId, readFails = false) => {
        window.__override['/v1/account'] = { ...account, ownerId };
        if (readFails) window.__answer = { 'GET /v1/account': Array.from({ length: 4 }, () => ({ status: 500, body: { error: 'made up' } })) };
        $('loginUser').value = 'made-up-user'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        window.__answer = {};
        ok('signed in', !loginDlg.open);
      };
      const reloads = () => window.__reloads;
      let n = 0;
      const reloaded = async (what) => { try { await until(() => reloads() === n + 1, 3000); } catch { throw new Error(what + ': no reload (' + reloads() + ', was ' + n + ')'); } n = reloads(); };
      const none = { factors: [], backupCodes: 0, need: 'missing', ownerRights: false, methods: [], publicAddress: false, localAccount: true, passkeyAddress: 'https://box.example.com', passkeyHere: false };
      try {
        await loadMyAccount();
        n = reloads();
        // The same account back: no reload.
        await expire();
        await signIn(account.ownerId);
        await sleep(50);
        eq('the same account: the page stays', reloads(), n);
        // Another account: loaded again.
        await expire();
        await signIn('next-person');
        await reloaded('another account reloads the page');
        // Another tab signed in as someone else, seen at the next read: loaded again too.
        window.__override['/v1/account'] = { ...account, ownerId: 'tab-person' };
        await loadMyAccount();
        await reloaded('the account of another tab, at the next read');
        // The read fails at the sign-in, they add an authenticator app, and the read that works comes meanwhile:
        // the reload waits for the app's setup, then for the backup codes it brings, then goes.
        await expire();
        await signIn('code-person', true);
        const readFails = () => Array.from({ length: 20 }, () => ({ status: 500, body: { error: 'made up' } }));
        window.__override['/v1/second-factor'] = none;
        window.__answer = { 'GET /v1/account': readFails() };
        await openAiDlg('access');
        await until(() => !$('sfBox').hidden);
        eq('nothing yet: who it is is not known', reloads(), n);
        const madeUpKey = ['GEZDGNBV', 'GY3TQOJQ'].join('').repeat(2); // RFC 6238's seed in base32, split for secret scanners
        window.__answer = {
          'GET /v1/account': readFails(),
          'POST /v1/second-factor/totp': [{ body: { id: 'sf-9', secret: madeUpKey, uri: 'otpauth://totp/x', qr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>' } }],
          'POST /v1/second-factor/totp/confirm': [{ body: { ok: true, backupCodes: ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'], ownerId: 'code-person' } }],
        };
        $('sfCurPw').value = 'made-up';
        $('sfAddTotpBtn').click();
        await until(() => !$('sfTotpBox').hidden);
        delete window.__answer['GET /v1/account'];
        await loadMyAccount();
        ok('read: another person than the page showed', pagePerson === 'code-person');
        await sleep(50);
        eq('not while an app is being added', reloads(), n);
        $('sfTotpCode').value = '123456';
        $('sfTotpConfirmBtn').click();
        await until(() => backupDlg.open);
        await sleep(50);
        eq('nor while its backup codes are open', reloads(), n);
        ok('which stay theirs', /AAAA-BBBB-CCCC/.test($('backupCodes').textContent));
        $('backupSaved').click(); $('backupDone').click();
        await reloaded('once the codes are closed, it goes');
        ok('the codes were closed by Done first', !backupDlg.open && $('backupCodes').textContent === '');
        aiDlg.close();
        // A recovery code that a sign-in as another account brings: the reload waits until it is closed.
        await expire();
        window.__override['/v1/account'] = { ...account, ownerId: 'recovering-person' };
        window.__answer = { 'POST /v1/local-accounts/recover-with-code': [{ body: { ok: true, username: 'recovering-person', recoveryCode: 'MADE-UP-RECOVERY', ownerId: 'recovering-person' } }] };
        $('recUser').value = 'recovering-person'; $('recCode').value = 'MADE-UP-OLD'; $('recPw').value = 'made-up-new';
        await acctRecover();
        window.__answer = {};
        ok('the new recovery code is shown', recoveryDlg.open && $('recoveryCode').textContent === 'MADE-UP-RECOVERY');
        await sleep(50);
        eq('not while it is open', reloads(), n);
        $('recoverySaved').click(); $('recoveryDone').click();
        await reloaded('once the recovery code is closed, it goes');
      } finally {
        window.__answer = {};
        window.__override['/v1/account'] = account;
        delete window.__override['/v1/second-factor'];
        $('recoveryLede').innerHTML = lede;
        if (backupDlg.open) closeBackupCodes();
        if (recoveryDlg.open) recoveryDlg.close();
        if (aiDlg.open) aiDlg.close();
        if (loginDlg.open) loginDlg.close();
        sfCloseTotp();
        await loadMyAccount();
        pageReloadWanted = false;
        await refresh(true);
      }
    },
    reloadWaitsForWhatMustBeSeen: async () => {
      // Review of HB-0491: the reload for another account is never held for ever, and never lands between a request and the codes it brings.
      const account = await (await fetch('/v1/account')).json();
      const outside = (dlg) => dlg.dispatchEvent(new MouseEvent('click', { clientX: 3, clientY: 3, bubbles: true, cancelable: true }));
      const realFetch = window.fetch, realCreate = navigator.credentials.create;
      let n = 0;
      const reloaded = async (what) => { try { await until(() => window.__reloads === n + 1, 3000); } catch { throw new Error(what + ': no reload (' + window.__reloads + ', was ' + n + ')'); } n = window.__reloads; };
      const held = async (what) => { await sleep(50); eq(what, window.__reloads, n); };
      const factors = { factors: [{ id: 'f1', kind: 'totp', createdAt: new Date().toISOString() }], backupCodes: 3, need: 'yes', ownerRights: false, methods: ['totp'], publicAddress: false, localAccount: true, passkeyAddress: 'https://box.example.com', passkeyHere: true };
      const slow = (match, reply, ms = 300) => { window.fetch = async (input, init = {}) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (!match(url, init)) return realFetch(input, init);
        await sleep(ms);
        return new Response(JSON.stringify(reply()), { status: 200, headers: { 'content-type': 'application/json' } });
      }; };
      const readAs = async (ownerId) => { window.__override['/v1/account'] = { ...account, ownerId }; await loadMyAccount(); };
      try {
        await readAs(account.ownerId);
        n = window.__reloads; pageReloadWanted = false;
        // A passkey's codes closed by a click outside once saved: its setup finishes, and a reload for another account goes.
        window.__override['/v1/second-factor'] = factors;
        await openAiDlg('access');
        await until(() => !$('sfBox').hidden);
        navigator.credentials.create = async () => ({ response: { clientDataJSON: new Uint8Array([1]).buffer, attestationObject: new Uint8Array([2]).buffer } });
        window.__answer = {
          'POST /v1/second-factor/passkey/options': [{ body: { challenge: 'AAAA', rp: { id: 'x', name: 'x' }, user: { id: 'AAAA', name: 'u', displayName: 'u' }, pubKeyCredParams: [], timeout: 1000, attestation: 'none', authenticatorSelection: {}, excludeCredentials: [] } }],
          'POST /v1/second-factor/passkey': [{ body: { ok: true, label: 'L', backupCodes: ['AAAA-BBBB-CCCC'], ownerId: account.ownerId } }],
        };
        let added = false;
        sfAddPasskey($('sfAddPasskeyBtn')).then(() => { added = true; });
        await until(() => backupDlg.open);
        window.__answer = {};
        outside(backupDlg);
        ok('the codes stay before they are saved', backupDlg.open);
        $('backupSaved').checked = true;
        outside(backupDlg);
        await until(() => added);
        ok('the passkey\'s setup finished', !backupDlg.open);
        aiDlg.close();
        await readAs('later-person');
        await reloaded('a later read of another account');
        // New codes behind a step-up prompt, while another tab's account is read: the reload waits for the codes and their Done.
        await readAs(account.ownerId); n = window.__reloads; pageReloadWanted = false;
        await openAiDlg('access');
        await until(() => !$('sfBox').hidden);
        let asks = 0, codesArrived = -1;
        window.fetch = async (input, init = {}) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (!url.startsWith('/v1/second-factor/backup-codes')) return realFetch(input, init);
          if (++asks === 1) return new Response(JSON.stringify({ error: 'again', secondFactor: 'step-up' }), { status: 401, headers: { 'content-type': 'application/json' } });
          await sleep(300);
          codesArrived = window.__reloads - n;
          return new Response(JSON.stringify({ backupCodes: ['AAAA-BBBB-CCCC'], ownerId: account.ownerId }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        window.__answer = { 'POST /v1/second-factor/verify': [{ body: { ok: true } }] };
        const making = sfNewBackupCodes($('sfBackupBtn'));
        await until(() => sfDlg.open);
        // A reload already wanted (another account was read here before; a read now would answer the prompt "not given").
        pageReloadWanted = true; pageReloadWhenQuiet();
        await held('not during the prompt');
        $('sfCode').value = '123456';
        await sfSubmitCode();
        await sleep(20);
        pageReloadWhenQuiet(); // anything that asks meanwhile (a step ending, a dialog closing)
        await held('not while the request it was asked for is in flight');
        await until(() => backupDlg.open);
        eq('not before the codes came', codesArrived, 0);
        await held('nor while they are open');
        closeBackupCodes(); await making;
        await reloaded('once they are closed');
        // Any request a prompt was for is held until it answers, not only the ones that bring codes.
        await readAs(account.ownerId); n = window.__reloads; pageReloadWanted = false;
        asks = 0;
        window.fetch = async (input, init = {}) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (!url.startsWith('/v1/made-up-sensitive')) return realFetch(input, init);
          if (++asks === 1) return new Response(JSON.stringify({ error: 'again', secondFactor: 'step-up' }), { status: 401, headers: { 'content-type': 'application/json' } });
          await sleep(300);
          return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        window.__answer = { 'POST /v1/second-factor/verify': [{ body: { ok: true } }] };
        const sensitive = api('/v1/made-up-sensitive', { method: 'POST', body: {} });
        await until(() => sfDlg.open);
        pageReloadWanted = true;
        $('sfCode').value = '123456';
        await sfSubmitCode();
        await sleep(20);
        pageReloadWhenQuiet();
        await held('not while what the prompt was for is in flight');
        await sensitive;
        await reloaded('once it answered');
        window.fetch = realFetch;
        // An authenticator app's confirm in flight when Settings closes for another account: held until it answers.
        // Its codes are the last person's: not shown to the new one.
        await readAs(account.ownerId); n = window.__reloads; pageReloadWanted = false;
        await openAiDlg('access');
        await until(() => !$('sfBox').hidden);
        const madeUpKey = ['GEZDGNBV', 'GY3TQOJQ'].join('').repeat(2); // RFC 6238's seed in base32, split for secret scanners
        window.__answer = { 'POST /v1/second-factor/totp': [{ body: { id: 'sf-7', secret: madeUpKey, uri: 'otpauth://totp/x', qr: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>' } }] };
        $('sfAddTotpBtn').click();
        await until(() => !$('sfTotpBox').hidden);
        slow((url) => url.startsWith('/v1/second-factor/totp/confirm'), () => ({ ok: true, backupCodes: ['QQQQ-RRRR-SSSS'], ownerId: account.ownerId }));
        $('sfTotpCode').value = '123456';
        const confirming = sfConfirmTotp();
        await sleep(20);
        await readAs('switched-person');
        ok('Settings closed for them', !aiDlg.open);
        await held('not while the confirm is in flight');
        await Promise.race([confirming, sleep(1000)]);
        ok('the last person\'s codes are not shown: ' + $('toast').textContent, !backupDlg.open && !/QQQQ/.test($('backupCodes').textContent) && /not shown to this one/.test($('toast').textContent));
        await reloaded('once it answered');
      } finally {
        window.fetch = realFetch; navigator.credentials.create = realCreate;
        window.__answer = {};
        window.__override['/v1/account'] = account;
        delete window.__override['/v1/second-factor'];
        if (backupDlg.open) closeBackupCodes();
        if (sfDlg.open) await sfCancel().catch(() => {});
        if (aiDlg.open) aiDlg.close();
        sfCloseTotp();
        await loadMyAccount();
        pageReloadWanted = false;
        await refresh(true);
      }
    },
    promptSignInReadsWho: async () => {
      // Review of HB-0491: another tab signed in and this page's poll was asked for the second factor. Passing it is a sign-in:
      // who it is is read, the page cleared for them, and the reload is not held for ever.
      const account = await (await fetch('/v1/account')).json();
      try {
        await loadMyAccount();
        const n = window.__reloads; pageReloadWanted = false;
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'second factor', secondFactor: 'required' } }], 'POST /v1/second-factor/verify': [{ body: { ok: true } }] };
        window.__override['/v1/account'] = { ...account, ownerId: 'other-tab-person' };
        $('cronMsg').value = 'typed by the last person';
        const poll = refresh(false);
        await until(() => sfDlg.open);
        ok('the prompt took the sign-in screen\'s place', !loginDlg.open);
        $('sfCode').value = '123456';
        await sfSubmitCode();
        await poll;
        window.__answer = {};
        await until(() => pagePerson === 'other-tab-person', 3000).catch(() => {});
        eq('who it is was read', pagePerson, 'other-tab-person');
        eq('and the page was cleared for them', $('cronMsg').value, '');
        await until(() => window.__reloads === n + 1, 3000).catch(() => {});
        eq('and the page loads again for them', window.__reloads, n + 1);
        eq('no sign-in left counted', pageSignIns, 0);
      } finally {
        window.__answer = {};
        window.__override['/v1/account'] = account;
        if (loginDlg.open) loginDlg.close();
        if (sfDlg.open) await sfCancel().catch(() => {});
        await loadMyAccount();
        pageReloadWanted = false;
        await refresh(true);
      }
    },
    familyAccountsShowsTheCode: async () => {
      // Review of HB-0500: the shared password's owner becomes an account. Its recovery code is theirs, though the page
      // still knows them by the password's owner: shown, and kept until "I've saved it".
      const account = await (await fetch('/v1/account')).json();
      const outside = (dlg) => dlg.dispatchEvent(new MouseEvent('click', { clientX: 3, clientY: 3, bubbles: true, cancelable: true }));
      const lede = $('recoveryLede').innerHTML;
      try {
        window.__override['/v1/account'] = { ...account, ownerId: 'dev-owner' };
        await loadMyAccount();
        $('famUser').value = 'made-up-owner'; $('famPw').value = 'made-up-password-1';
        window.__answer = { 'POST /v1/auth/family-accounts': [{ body: { ok: true, username: 'made-up-owner', adopted: 0, restarting: false, recoveryCode: 'RCVR-CODE-MADE-UP1', ownerId: 'acct-made-up' } }] };
        let done = false;
        turnOnFamilyAccounts(document.createElement('button')).then(() => { done = true; });
        await until(() => recoveryDlg.open, 3000).catch(() => {});
        ok('the recovery code is shown: ' + $('toast').textContent, recoveryDlg.open && $('recoveryCode').textContent === 'RCVR-CODE-MADE-UP1');
        outside(recoveryDlg);
        await sleep(100);
        ok('and stays until it is saved', recoveryDlg.open && !done && $('recoveryDone').disabled);
        $('recoverySaved').click(); $('recoveryDone').click();
        await until(() => done);
        ok('then the switch goes on: ' + $('famErr').textContent, !recoveryDlg.open && /now restart/.test($('famErr').textContent));
      } finally {
        window.__answer = {};
        window.__override['/v1/account'] = account;
        $('recoveryLede').innerHTML = lede; $('famErr').textContent = ''; $('famPw').value = '';
        if (recoveryDlg.open) closeRecoveryCode();
        await loadMyAccount();
        pageReloadWanted = false;
      }
    },
    stepUpEndsWithItsSession: async () => {
      // Review of HB-0491: a request waiting on a second-factor prompt belongs to the session and person it was asked for.
      // Neither another sign-in on the page nor another account read here sends it again.
      const account = await (await fetch('/v1/account')).json();
      const realFetch = window.fetch;
      let sent = [], asks = 0;
      const stepUp = () => { window.fetch = async (input, init = {}) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (!(url.startsWith('/v1/ai-profiles') && (init.method || 'GET') === 'POST')) return realFetch(input, init);
        if (++asks === 1) return new Response(JSON.stringify({ error: 'again', secondFactor: 'step-up' }), { status: 401, headers: { 'content-type': 'application/json' } });
        sent.push({ as: window.__override['/v1/account'].ownerId, body: init.body });
        return new Response(JSON.stringify({ ok: true, id: 'p9' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }; };
      const save = () => api('/v1/ai-profiles', { method: 'POST', body: { kind: 'apikey', key: 'made-up-key-of-a' } }).then(() => 'saved', (e) => e.message);
      try {
        // The session ends with the prompt open; the next person signs in through their own prompt.
        window.__override['/v1/account'] = { ...account, ownerId: 'person-a' };
        await loadMyAccount();
        stepUp();
        const saving = save();
        await until(() => sfDlg.open);
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        eq('the request is answered at once', await Promise.race([saving, sleep(1000).then(() => 'still waiting')]), 'The second factor was not given.');
        ok('and its prompt is not left under the sign-in', !sfDlg.open);
        window.__answer = { 'GET /v1/account': [{ status: 401, body: { error: 'second factor', secondFactor: 'required' } }], 'POST /v1/second-factor/verify': [{ body: { ok: true } }] };
        window.__override['/v1/account'] = { ...account, ownerId: 'person-b' };
        $('loginUser').value = 'made-up-b'; $('loginAcctPw').value = 'made-up';
        const signing = acctSignIn();
        await until(() => sfDlg.open && !loginDlg.open);
        eq('the next person is asked at their own sign-in', $('sfDlgTitle').textContent, 'One more step');
        $('sfCode').value = '123456';
        await sfSubmitCode();
        await signing;
        await sleep(100);
        eq('nothing of the first person is sent under their session', sent, []);
        window.__answer = {};
        // Another account read here while the prompt waits (another tab signed in): answered, not sent.
        await loadMyAccount();
        asks = 0; sent = [];
        const saving2 = save();
        await until(() => sfDlg.open);
        window.__override['/v1/account'] = { ...account, ownerId: 'person-c' };
        await loadMyAccount();
        eq('the request is answered', await Promise.race([saving2, sleep(1000).then(() => 'still waiting')]), 'The second factor was not given.');
        ok('and the prompt closed', !sfDlg.open);
        eq('and nothing sent', sent, []);
      } finally {
        window.fetch = realFetch;
        window.__answer = {};
        window.__override['/v1/account'] = account;
        if (sfDlg.open) await sfCancel().catch(() => {});
        if (loginDlg.open) loginDlg.close();
        await loadMyAccount();
        pageReloadWanted = false;
        await refresh(true);
      }
    },
    lateCodesWaitBehindTheSignIn: async () => {
      // Review of HB-0500: codes that answer after the session ended do not open over the sign-in; they wait for their person.
      const account = await (await fetch('/v1/account')).json();
      const realFetch = window.fetch;
      try {
        window.__override['/v1/account'] = { ...account, ownerId: 'person-a' };
        await loadMyAccount();
        window.fetch = async (input, init = {}) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (!url.startsWith('/v1/second-factor/backup-codes')) return realFetch(input, init);
          await sleep(400);
          return new Response(JSON.stringify({ backupCodes: ['LATE-CODE-ZZZZ'], ownerId: 'person-a' }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        const making = sfNewBackupCodes(document.createElement('button'));
        await sleep(20);
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        window.__answer = {};
        await sleep(600);
        ok('not over the sign-in', loginDlg.open && !backupDlg.open && $('backupCodes').textContent === '');
        $('loginUser').value = 'made-up-a'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        ok('shown to their own person once signed in', backupDlg.open && /LATE-CODE-ZZZZ/.test($('backupCodes').textContent));
        closeBackupCodes(); await making;
      } finally {
        window.fetch = realFetch;
        window.__answer = {};
        window.__override['/v1/account'] = account;
        if (backupDlg.open) closeBackupCodes();
        if (loginDlg.open) loginDlg.close();
        await loadMyAccount();
        pageReloadWanted = false;
        await refresh(true);
      }
    },
    answeredPromptIsForItsPerson: async () => {
      // Final review of HB-0491: another tab or window signed in as someone else, and this page's request was asked for a
      // second factor. The factor given is the other session's: the request is answered "not given", never sent as them.
      const account = await (await fetch('/v1/account')).json();
      const realFetch = window.fetch;
      let sent = [], asks = 0;
      const ask = (kind) => { asks = 0; sent = []; window.fetch = async (input, init = {}) => {
        const url = String(typeof input === 'string' ? input : input.url);
        if (!(url.startsWith('/v1/ai-profiles') && (init.method || 'GET') === 'POST')) return realFetch(input, init);
        if (++asks === 1) return new Response(JSON.stringify({ error: 'second factor', secondFactor: kind }), { status: 401, headers: { 'content-type': 'application/json' } });
        sent.push({ as: window.__override['/v1/account'].ownerId, body: init.body });
        return new Response(JSON.stringify({ ok: true, id: 'p9' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }; };
      const save = () => api('/v1/ai-profiles', { method: 'POST', body: { kind: 'apikey', key: 'made-up-key-of-a' } }).then(() => 'saved', (e) => e.message);
      try {
        for (const kind of ['required', 'step-up']) {
          window.__override['/v1/account'] = { ...account, ownerId: 'person-a' };
          await loadMyAccount();
          pageReloadWanted = false;
          const n = window.__reloads;
          ask(kind);
          const saving = save();
          await until(() => sfDlg.open);
          window.__override['/v1/account'] = { ...account, ownerId: 'person-b' }; // signed in elsewhere meanwhile
          window.__answer = { 'POST /v1/second-factor/verify': [{ body: { ok: true } }] };
          $('sfCode').value = '123456';
          await sfSubmitCode();
          window.__answer = {};
          eq(kind + ': the request is answered', await Promise.race([saving, sleep(1000).then(() => 'still waiting')]), 'The second factor was not given.');
          eq(kind + ': and not sent as the other account', sent, []);
          ok(kind + ': the prompt closed', !sfDlg.open);
          eq(kind + ': the page knows who is signed in now', pagePerson, 'person-b');
          await until(() => window.__reloads === n + 1, 3000).catch(() => {});
          eq(kind + ': and loads again for them', window.__reloads, n + 1);
          await until(() => !pageSignIns, 3000).catch(() => {});
        }
        // The same person: the request goes on.
        window.__override['/v1/account'] = { ...account, ownerId: 'person-a' };
        await loadMyAccount();
        ask('step-up');
        const saving = save();
        await until(() => sfDlg.open);
        window.__answer = { 'POST /v1/second-factor/verify': [{ body: { ok: true } }] };
        $('sfCode').value = '123456';
        await sfSubmitCode();
        window.__answer = {};
        eq('the same person: saved', await saving, 'saved');
        eq('as them', sent.map((x) => x.as), ['person-a']);
      } finally {
        window.fetch = realFetch;
        window.__answer = {};
        window.__override['/v1/account'] = account;
        if (sfDlg.open) await sfCancel().catch(() => {});
        await loadMyAccount();
        pageReloadWanted = false;
        await refresh(true);
      }
    },
    lateCodesWaitThroughAFailedRead: async () => {
      // Final review of HB-0500: the last person's codes answer after the next person signed in, and that person's read
      // failed. Not shown to them; their own sign-in's recovery code still is.
      const account = await (await fetch('/v1/account')).json();
      const realFetch = window.fetch;
      const lede = $('recoveryLede').innerHTML;
      let release = false, failRead = false;
      try {
        window.__override['/v1/account'] = { ...account, ownerId: 'person-a' };
        await loadMyAccount();
        window.fetch = async (input, init = {}) => {
          const url = String(typeof input === 'string' ? input : input.url);
          if (failRead && url.split('?')[0] === '/v1/account') return new Response('{"error":"made up"}', { status: 500, headers: { 'content-type': 'application/json' } });
          if (!url.startsWith('/v1/second-factor/backup-codes')) return realFetch(input, init);
          await until(() => release, 20000);
          return new Response(JSON.stringify({ backupCodes: ['AAAA-LATE-ZZZZ'], ownerId: 'person-a' }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        let let_go = false;
        sfNewBackupCodes(document.createElement('button')).then(() => { let_go = true; });
        await sleep(20);
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        window.__answer = {};
        window.__override['/v1/account'] = { ...account, ownerId: 'person-b' }; failRead = true;
        $('loginUser').value = 'made-up-b'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        release = true;
        await sleep(300);
        ok('the last person\'s codes are not shown to the next', !backupDlg.open && $('backupCodes').textContent === '');
        failRead = false;
        await loadMyAccount();
        await until(() => let_go, 3000).catch(() => {});
        ok('and once the read names them, they are gone: ' + JSON.stringify({ open: backupDlg.open, let_go, away: pageSecretsAway.length }), !backupDlg.open && let_go && !pageSecretsAway.length);
        // A sign-in whose read fails still shows what it brought.
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        window.__answer = { 'POST /v1/local-accounts/recover-with-code': [{ body: { ok: true, username: 'made-up-b', recoveryCode: 'MADE-UP-NEW-CODE', ownerId: 'person-b' } }] };
        failRead = true;
        $('recUser').value = 'made-up-b'; $('recCode').value = 'MADE-UP-OLD'; $('recPw').value = 'made-up-new';
        await acctRecover();
        window.__answer = {};
        ok('the recovery code it brought is shown', recoveryDlg.open && $('recoveryCode').textContent === 'MADE-UP-NEW-CODE');
        failRead = false;
      } finally {
        window.fetch = realFetch;
        window.__answer = {};
        window.__override['/v1/account'] = account;
        $('recoveryLede').innerHTML = lede;
        if (backupDlg.open) closeBackupCodes();
        if (recoveryDlg.open) closeRecoveryCode();
        if (loginDlg.open) loginDlg.close();
        await loadMyAccount();
        pageReloadWanted = false;
        await refresh(true);
      }
    },
    ownerlessCodesAreNobodys: async () => {
      // Review of HB-0500: codes with no owner said are nobody's: a read never hands them to whoever is signed in by then.
      const account = await (await fetch('/v1/account')).json();
      try {
        await loadMyAccount();
        let let_go = false;
        showBackupCodes(['NOBO-DYSC-ODES']).then(() => { let_go = true; });
        window.__answer = { 'GET /v1/agents': [{ status: 401, body: { error: 'auth required' } }] };
        await refresh(false);
        await until(() => loginDlg.open);
        window.__answer = {};
        $('loginUser').value = 'made-up-user'; $('loginAcctPw').value = 'made-up';
        await acctSignIn();
        ok('not shown again, even to the same account', !backupDlg.open && $('backupCodes').textContent === '');
        await sleep(0);
        ok('and what waited on them went on', let_go);
      } finally {
        window.__answer = {};
        window.__override['/v1/account'] = account;
        if (backupDlg.open) closeBackupCodes();
        if (loginDlg.open) loginDlg.close();
        await loadMyAccount();
        await refresh(true);
      }
    },
    shownTabReadsWhoIsSignedIn: async () => {
      // Review of HB-0491: a tab shown again reads who is signed in, so another tab's switch does not wait for the next meta refresh.
      const account = await (await fetch('/v1/account')).json();
      try {
        await loadMyAccount();
        const n = window.__reloads; pageReloadWanted = false;
        window.__override['/v1/account'] = { ...account, ownerId: 'switched-elsewhere' };
        document.dispatchEvent(new Event('visibilitychange'));
        await until(() => window.__reloads === n + 1, 3000).catch(() => {});
        eq('shown again, it reads, and loads again for them', window.__reloads, n + 1);
      } finally {
        window.__override['/v1/account'] = account;
        await loadMyAccount();
        pageReloadWanted = false;
      }
    },
    webChatMaybeDeliveredComesBack: async () => {
      // Review of HB-0446: a message kept as sent is not lost when the log is redrawn from the server, and is never sent again by itself.
      const list = await (await fetch('/v1/agents')).json();
      const a = list[1];
      const chat = '/v1/agents/' + a.id + '/chat';
      const box = $('wchatText');
      const posts = () => calls('POST', new RegExp(chat + '$')).length;
      const fail = async (text, answer) => {
        window.__answer = { ['POST ' + chat]: [answer] };
        box.value = text;
        await webChatSend();
        window.__answer = {};
      };
      const reopen = async () => {
        webChatDlg.close();
        await openWebChatPanel(a.id);
        await until(() => !$('wchatEmpty') || !$('wchatEmpty').textContent.includes('Loading'));
      };
      window.__override[chat] = { messages: [{ role: 'user', text: 'said before' }, { role: 'assistant', text: 'a reply' }] };
      try {
        await openWebChatPanel(a.id);
        await until(() => $('wchatLog').querySelector('.wchat-msg'));
        // The finding: not delivered, reopened as the page advised.
        await fail('Eight thousand careful characters', { status: 502, body: { error: 'The turn did not complete, and the message may have reached it.' } });
        eq('kept as sent, the box empty', box.value, '');
        let n = posts();
        await reopen();
        eq('not in the log: it comes back to the box', box.value, 'Eight thousand careful characters');
        ok('with a note: ' + $('wchatErr').textContent, /may not have been delivered/.test($('wchatErr').textContent));
        eq('and nothing is sent by itself', posts(), n);
        // Sending it takes the note off, and it is not offered again.
        window.__answer = { ['POST ' + chat]: [{ body: { reply: 'ok' } }] };
        await webChatSend();
        window.__answer = {};
        eq('the note went with the send', $('wchatErr').textContent, '');
        await reopen();
        eq('offered once', box.value, '');
        // It did arrive: nothing to offer, and no note.
        await fail('This one arrived', { status: 504, body: { error: 'No answer within 280 s.' } });
        window.__override[chat] = { messages: [{ role: 'user', text: 'said before' }, { role: 'user', text: 'This one arrived' }] };
        await reopen();
        eq('in the log: nothing comes back', [box.value, $('wchatErr').textContent], ['', '']);
        // The same words said earlier do not prove these arrived.
        await fail('said before', { reject: 'Failed to fetch' });
        await reopen();
        eq('an earlier "same words" is not this message', box.value, 'said before');
        box.value = '';
        // When the log cannot be read, it is not known either way: kept, and asked again next time.
        await fail('Unknown for now', { status: 502, body: { error: 'The turn did not complete.' } });
        window.__override[chat] = { messages: [], note: 'Its conversation cannot be read right now.' };
        await reopen();
        eq('no log, no offer', box.value, '');
        window.__answer = { ['GET ' + chat]: [{ status: 502, body: { error: "Couldn't read your conversation just now — try again." } }] };
        await reopen();
        window.__answer = {};
        eq('a failed read, no offer', box.value, '');
        window.__override[chat] = { messages: [] };
        await reopen();
        eq('then it is offered', box.value, 'Unknown for now');
        box.value = '';
        // Ahead of what was typed since, in the order they were sent.
        await fail('first', { status: 500, body: { error: 'Internal Server Error' } });
        await fail('second', { status: 500, body: { error: 'Internal Server Error' } });
        box.value = 'typed since';
        await reopen();
        eq('in order, ahead of the typing', box.value, 'first\nsecond\ntyped since');
      } finally {
        window.__answer = {};
        delete window.__override[chat];
        webChatUnsure.clear();
        box.value = '';
        if (webChatDlg.open) webChatDlg.close();
      }
    },
    aiExtrasEditIsWhatChanged: async () => {
      // Review of HB-0410: an edit to the list is what was added and removed, applied to the server's list as it is now.
      const p = profiles.find((x) => x.mine !== false);
      const path = '/v1/ai-profiles/' + p.id;
      const base = await (await fetch('/v1/ai-profiles')).json();
      const server = (models) => { window.__override['/v1/ai-profiles'] = base.map((x) => x.id === p.id ? { ...x, model: 'm-default', models } : x); };
      const extras = () => $('aiModels-' + p.id).value;
      const realFetch = window.fetch;
      const remove = (m) => $('aiExtras-' + p.id).querySelector('[data-remove="' + m + '"]').click();
      try {
        window.__override[path + '/available-models'] = { models: ['m-default', 'm-x', 'm-y'], source: 'curated' };
        server(['m-default', 'm-x', 'm-y']);
        await refresh(true);
        await openAiDlg('ai');
        await until(() => $('aiModel-' + p.id).tagName === 'SELECT');
        eq('as drawn', extras(), 'm-x,m-y');
        // The finding: remove one, then ⟳ Sync adds another.
        remove('m-x');
        eq('the edit', aiRowEdits()[p.id], { models: { add: [], remove: ['m-x'] } });
        window.__override[path + '/available-models'] = { models: ['m-default', 'm-x', 'm-y', 'm-w'], source: 'runtime' };
        server(['m-default', 'm-x', 'm-y', 'm-w']);
        await syncModels(p.id, 'A source');
        eq('Sync added it and the removal stands', extras().split(',').sort(), ['m-w', 'm-y']);
        const n = calls('PATCH', new RegExp(path + '$')).length;
        await saveAiProfile(p.id);
        eq('Save keeps what Sync added', calls('PATCH', new RegExp(path + '$')).slice(n).map((c) => c.body.models.slice().sort()), [['m-default', 'm-w', 'm-y']]);
        aiDlg.close();
        // An addition survives too, and one the server has since added is not doubled.
        window.__override[path + '/available-models'] = { models: ['m-default', 'm-y', 'm-w', 'm-z'], source: 'curated' };
        server(['m-default', 'm-y']);
        await refresh(true);
        aiRowsDrawn = {};
        await openAiDlg('ai');
        await until(() => $('aiModel-' + p.id).tagName === 'SELECT');
        $('aiExtras-' + p.id).querySelector('select[data-add]').value = 'm-z';
        $('aiExtras-' + p.id).querySelector('select[data-add]').dispatchEvent(new Event('change', { bubbles: true }));
        eq('the edit', aiRowEdits()[p.id], { models: { add: ['m-z'], remove: [] } });
        server(['m-default', 'm-y', 'm-z', 'm-w']);
        await refresh(true); renderAiList();
        eq('no double, and the server list follows', extras().split(',').sort(), ['m-w', 'm-y', 'm-z']);
        eq('and the edit is spent', aiRowEdits()[p.id], undefined);
        aiDlg.close();
        // The auto-clean, with an edit made before the model lists arrive.
        window.__override[path + '/available-models'] = { models: ['m-default', 'm-y'], stale: ['m-junk'], source: 'runtime' };
        server(['m-default', 'm-x', 'm-y', 'm-junk']);
        await refresh(true);
        aiRowsDrawn = {};
        let release;
        window.fetch = (input, init = {}) => {
          if ((init.method || 'GET') !== 'GET' || !String(input).endsWith(path + '/available-models')) return realFetch(input, init);
          window.fetch = realFetch;
          return new Promise((r) => { release = () => r(realFetch(input, init)); });
        };
        const opening = openAiDlg('ai');
        await until(() => release && $('aiExtras-' + p.id)?.querySelector('[data-remove="m-x"]'));
        remove('m-x');
        server(['m-default', 'm-x', 'm-y']); // what the clean's write leaves on the server
        release();
        await opening;
        eq('the clean stands and so does the removal', extras(), 'm-y');
      } finally {
        window.fetch = realFetch;
        if (applyModelDlg.open) applyModelDlg.close();
        if (aiDlg.open) aiDlg.close();
        delete window.__override['/v1/ai-profiles']; delete window.__override[path + '/available-models'];
        delete availableModels[p.id]; delete staleModels[p.id];
        aiRowsDrawn = {}; await refresh(true); renderAiList();
      }
    },
    aiExtrasOnePerModelAndFull: async () => {
      // HB-0669: the add menu offers one id per model and says when the list is full; Sync adds only what fits.
      const p = profiles.find((x) => x.mine !== false);
      const path = '/v1/ai-profiles/' + p.id;
      const base = await (await fetch('/v1/ai-profiles')).json();
      const server = (models) => { window.__override['/v1/ai-profiles'] = base.map((x) => x.id === p.id ? { ...x, model: 'claude-sonnet-5', models } : x); };
      const box = () => $('aiExtras-' + p.id);
      const adder = () => [...box().querySelectorAll('select[data-add] option')].map((o) => o.value).filter(Boolean);
      const toastText = () => document.getElementById('toast').textContent;
      const many = Array.from({ length: 15 }, (_, i) => 'claude-test-' + (i + 10));
      const open = async () => { await refresh(true); aiRowsDrawn = {}; await openAiDlg('ai'); await until(() => $('aiModel-' + p.id).tagName === 'SELECT'); };
      try {
        window.__override[path + '/available-models'] = { models: ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-8'], stale: [], source: 'runtime' };
        server(['claude-sonnet-5', 'claude-haiku-4-5']);
        await open();
        eq('a dated id of a model on the list is not offered again', adder(), ['claude-opus-4-8', 'claude-sonnet-4-5-20250929']);
        aiDlg.close();
        // Full: the default and 15 more.
        server(['claude-sonnet-5', ...many]);
        await open();
        ok('a full list says so', !!box().querySelector('[data-list-full]'));
        eq('and offers nothing more', adder(), []);
        box().querySelector('[data-remove="claude-test-10"]').click();
        ok('one removed: the menu is back', !box().querySelector('[data-list-full]') && adder().length > 0);
        aiDlg.close();
        // Sync: a dated id the runtime folded is kept, not doubled; new ones fill the list to 16 and the rest are named.
        const listed = ['claude-sonnet-5', 'claude-haiku-4-5-20251001', ...many.slice(0, 12)];
        server(listed);
        await refresh(true);
        window.__override[path + '/available-models'] = { models: ['claude-sonnet-5', 'claude-haiku-4-5', ...many.slice(0, 12), 'claude-test-new-1', 'claude-test-new-2', 'claude-test-new-3'], stale: [], source: 'runtime' };
        const n = calls('PATCH', new RegExp(path + '$')).length;
        await syncModels(p.id, 'A source');
        eq('Sync adds what fits', calls('PATCH', new RegExp(path + '$')).slice(n).map((c) => c.body.models), [[...listed, 'claude-test-new-1', 'claude-test-new-2']]);
        ok('and names the rest: ' + toastText(), toastText().includes('1 not added, the list is full') && toastText().includes('claude-test-new-3'));
      } finally {
        if (applyModelDlg.open) applyModelDlg.close();
        if (aiDlg.open) aiDlg.close();
        delete window.__override['/v1/ai-profiles']; delete window.__override[path + '/available-models'];
        delete availableModels[p.id]; delete staleModels[p.id];
        aiRowsDrawn = {}; await refresh(true); renderAiList();
      }
    },
    connectedSheetIgnoresALateAnswer: async () => {
      // Review of HB-0411: a slow older check landing after a newer "now" does not take it back.
      const list = await (await fetch('/v1/agents')).json();
      const a = list.find((x) => x.name === 'Tax Filing');
      const chans = '/v1/agents/' + a.id + '/channels', one = '/v1/agents/' + a.id;
      const realInterval = window.setInterval, realFetch = window.fetch;
      let tick;
      window.__override[chans] = { channels: [{ kind: 'discord', youAreLinked: true }], imageSupports: [] };
      try {
        window.__override[one] = { ...a, state: 'REBUILDING' };
        chanFor = a.id; chanKind = 'discord';
        chanDlg.showModal();
        window.setInterval = (f) => { tick = f; return 0; };
        chanShowConnected({ displayName: 'Bot', youAreLinked: true });
        window.setInterval = realInterval;
        // The older check's read of the agent is held until the newer one has answered.
        let release;
        window.fetch = (input, init = {}) => {
          if (!String(input).endsWith(one)) return realFetch(input, init);
          window.fetch = realFetch;
          return new Promise((r) => { release = () => r(new Response(JSON.stringify({ ...a, state: 'REBUILDING' }), { status: 200 })); });
        };
        const older = tick();
        await until(() => release);
        window.__override[one] = { ...a, state: 'RUNNING' };
        await tick();
        eq('the newer answer', $('chanWait').textContent.trim(), '✓ Linked. It answers you on Discord now.');
        release();
        await older;
        eq('the older one changes nothing', $('chanWait').textContent.trim(), '✓ Linked. It answers you on Discord now.');
      } finally {
        window.setInterval = realInterval; window.fetch = realFetch;
        if (chanDlg.open) chanDlg.close();
        delete window.__override[chans]; delete window.__override[one];
      }
    },
    moveDialogFollowsTheMoveBehindIt: async () => {
      // Review of HB-0411: a move that ends after the dialog was reopened answers for itself, and leaves the list open now true.
      const list = await (await fetch('/v1/agents')).json();
      const was = profiles;
      profiles = [...profiles, { ...profiles[0], id: 'pOther', name: 'Spare key', shared: true, defaultSource: false }, { ...profiles[0], id: 'pThird', name: 'Third key', shared: true, defaultSource: false }];
      window.__override['/v1/ai-profiles'] = profiles;
      const boxes = () => [...document.querySelectorAll('.moveSourceCb')];
      const realFetch = window.fetch;
      const hold = (path, answer) => {
        let release;
        window.fetch = (input, init = {}) => {
          if ((init.method || 'GET') !== 'POST' || !String(input).endsWith(path)) return realFetch(input, init);
          window.fetch = realFetch;
          return new Promise((r) => { release = () => r(answer()); });
        };
        return () => release();
      };
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
      try {
        await refresh(true);
        // A failed move: its error is not written into the dialog now open for another source.
        moveAgentsToSource('pOther', 'Spare key');
        boxes()[0].checked = true; refreshMoveCount();
        let go = hold('/v1/ai-profiles/pOther/adopt-agents', () => json({ error: 'A made-up failure' }, 500));
        let run = moveAgentsApply(true);
        await sleep(0);
        moveSourceDlg.close();
        moveAgentsToSource('pThird', 'Third key');
        go(); await run;
        eq('the open dialog is left alone', $('moveSourceErr').textContent, '');
        ok('the failure is told: ' + $('toast').textContent, $('toast').textContent.includes('A made-up failure'));
        moveSourceDlg.close();
        // A move that succeeds behind a reopened dialog: what moved leaves its list; what is ticked stays ticked.
        moveAgentsToSource('pOther', 'Spare key');
        const [moved, other] = boxes();
        const movedId = moved.dataset.id, otherId = other.dataset.id;
        moved.checked = true; refreshMoveCount();
        go = hold('/v1/ai-profiles/pOther/adopt-agents', () => json({ switched: 1, rebuilding: 1, atNextStart: 0, skipped: [] }));
        run = moveAgentsApply(true);
        await sleep(0);
        moveSourceDlg.close();
        moveAgentsToSource('pOther', 'Spare key');
        boxes().find((c) => c.dataset.id === otherId).checked = true; refreshMoveCount();
        ok('still listed before the answer', boxes().some((c) => c.dataset.id === movedId));
        window.__override['/v1/agents'] = list.map((x) => x.id === movedId ? { ...x, aiProfileId: 'pOther' } : x);
        go(); await run;
        ok('it stays open', moveSourceDlg.open);
        ok('what moved has left the list', !boxes().some((c) => c.dataset.id === movedId));
        eq('and the tick stays', boxes().filter((c) => c.checked).map((c) => c.dataset.id), [otherId]);
        ok('the button still works', !$('moveSourceBtn').disabled);
      } finally {
        window.fetch = realFetch;
        if (moveSourceDlg.open) moveSourceDlg.close();
        delete window.__override['/v1/agents']; delete window.__override['/v1/ai-profiles'];
        profiles = was; await refresh(true); renderAiList();
      }
    },
    migrateSaysWhoseButtonItIs: async () => {
      // Review of HB-0411: Recover context is the agent's owner's alone, so the machine's owner is not told to press it for another account.
      const toastText = () => $('toast').textContent;
      const was = profiles;
      profiles = [...profiles, { ...profiles[0], id: 'pOther', name: 'Spare key', shared: true, defaultSource: false }];
      window.__override['/v1/ai-profiles'] = profiles;
      const migrate = async (body) => {
        migrateState = { id: 'p1', name: 'Old' };
        const opt = document.createElement('option'); opt.value = 'pOther'; $('migrateTo').replaceChildren(opt);
        window.__answer = { 'POST /v1/ai-profiles/p1/migrate-agents': [{ body: { switched: 3, agents: 3, otherAccounts: 1, rebuilding: 0, atNextStart: 3, skipped: [], ...body } }] };
        await runMigrate();
      };
      try {
        ok('the box says it', /its owner/.test($('migrateRecover').closest('label').textContent));
        await migrate({ notRecovered: 2, notRecoveredOthers: 2 });
        ok('others only, their owners: ' + toastText(), /2 on other accounts/.test(toastText()) && /owner/.test(toastText()) && !/press Recover context on their Personality/.test(toastText()));
        await migrate({ notRecovered: 3, notRecoveredOthers: 1 });
        ok('both, each said: ' + toastText(), /2 not recovered/.test(toastText()) && /Personality/.test(toastText()) && /1 on another account/.test(toastText()) && /owner/.test(toastText()));
        await migrate({ notRecovered: 1, notRecoveredOthers: 0 });
        ok('mine only: ' + toastText(), /1 not recovered/.test(toastText()) && !/another account|other accounts:/.test(toastText().split('Moved')[1].split('—')[1]));
        eq('the words for one', notRecoveredNote(1), '1 not recovered: once it is up on this source, press Recover context on its Personality tab');
      } finally {
        window.__answer = {}; delete window.__override['/v1/ai-profiles'];
        profiles = was; await refresh(true); renderAiList();
      }
    },
    sheetButtonEditsHoldTheRedraw: async () => {
      // Review of HB-0444: an edit made by a button alone fires no event, and is an edit all the same.
      const list = await (await fetch('/v1/agents')).json();
      const a = list.find((x) => x.state === 'RUNNING' && x.id === 'a1');
      const withFields = list.map((x) => x.id === a.id ? { ...x, parameters: [{ key: 'p1', label: 'One', type: 'text', target: 'soul' }, { key: 'p2', label: 'Two', type: 'text', target: 'soul' }] } : x);
      const set = async (state) => { window.__override['/v1/agents'] = withFields.map((x) => x.id === a.id ? { ...x, state } : x); await refresh(false); };
      // Closing clears what the sheet held in its close event, which comes with an animation frame: virtual time runs on until then, so it is done here.
      const closeSheet = () => { v2Close(); v2EditFor = null; v2SheetNotes.clear(); };
      try {
        await set('RUNNING');
        openV2Agent(a.id, 'personality');
        await until(() => $('v2Pane').querySelector('#paramList'));
        eq('two fields', editParams.length, 2);
        $('paramList').querySelector('button.danger').click();
        eq('× took one', editParams.length, 1);
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        await set('STOPPED');
        eq('the state redraw keeps the removal', editParams.length, 1);
        eq('and it shows', $('paramList').querySelectorAll('button.danger').length, 1);
        closeSheet();
        // Edit on a task fills the form by hand, and arms its Save: a redraw turned that Save into a new task.
        window.__crons = [{ id: 'c1', name: 'A made-up task', scheduleExpr: '0 8 * * 1-5', message: 'Say hello.', enabled: true, payloadKind: 'agentTurn' }];
        await set('RUNNING');
        openV2Agent(a.id, 'schedule');
        await until(() => cronCache.some((c) => c.name === 'A made-up task') && $('v2Pane').querySelector('#cronBody'));
        editCronJob('c1');
        eq('Edit filled the form', $('cronName').value, 'A made-up task');
        await sleep(300); // the form takes the keyboard a moment later
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        await set('STOPPED');
        ok('the state redraw holds off', !!$('v2Pane').querySelector('#cronBody'));
        await set('RUNNING');
        eq('and leaves it armed', cronEditingId, 'c1');
        eq('and its button', $('cronAddBtn').textContent, 'Save changes');
      } finally {
        window.__crons = []; cancelCronEdit(); $('cronName').value = ''; $('cronExpr').value = ''; $('cronMsg').value = '';
        try { closeSheet(); } catch {}
        delete window.__override['/v1/agents']; await refresh(false);
      }
    },
    moveDialogRetryKeepsTheChoices: async () => {
      // Review of HB-0445: the reopen after a skip keeps what the person chose, honours Cancel, and leaves the button as the ticks say.
      const list = await (await fetch('/v1/agents')).json();
      const was = profiles;
      const other = { ...profiles[0], id: 'pOther', name: 'Spare key', shared: false, defaultSource: false };
      profiles = [...profiles, other];
      window.__override['/v1/ai-profiles'] = profiles;
      const boxes = () => [...document.querySelectorAll('.moveSourceCb')];
      const adopt = 'POST /v1/ai-profiles/pOther/adopt-agents';
      try {
        await refresh(true);
        moveAgentsToSource('pOther', 'Spare key');
        eq('a fresh dialog: the defaults', [$('moveSourceRecover').checked, $('moveSourceCheckpoint').checked], [true, false]);
        boxes().slice(0, 2).forEach((cb) => { cb.checked = true; });
        refreshMoveCount();
        const [moved, skipped] = boxes().slice(0, 2).map((cb) => list.find((x) => x.id === cb.dataset.id));
        $('moveSourceRecover').checked = false; $('moveSourceCheckpoint').checked = true;
        window.__answer = { [adopt]: [{ body: { switched: 1, rebuilding: 1, atNextStart: 0, skipped: [{ name: skipped.name, reason: 'busy, for the test' }] } }] };
        window.__override['/v1/agents'] = list.map((x) => x.id === moved.id ? { ...x, aiProfileId: 'pOther' } : x);
        await moveAgentsApply(true);
        ok('it stays open', moveSourceDlg.open);
        eq('nothing ticked now', boxes().filter((c) => c.checked).length, 0);
        eq('so the button is off', [$('moveSourceBtn').disabled, $('moveSourceBtn').textContent], [true, 'Switch & rebuild']);
        eq('what the person chose stays', [$('moveSourceRecover').checked, $('moveSourceCheckpoint').checked], [false, true]);
        // The retry runs what they chose.
        boxes()[0].checked = true; refreshMoveCount();
        window.__answer = { [adopt]: [{ body: { switched: 1, rebuilding: 1, atNextStart: 0, skipped: [] } }] };
        await moveAgentsApply(true);
        const sent = calls('POST', /\/v1\/ai-profiles\/pOther\/adopt-agents$/).at(-1).body;
        eq('the retry does not recover', [sent.recoverAfter, sent.checkpoint], [false, true]);
        ok('and closes', !moveSourceDlg.open);
        await sleep(0);
        // The person's next open is a fresh start.
        moveAgentsToSource('pOther', 'Spare key');
        eq('a new open: the defaults again', [$('moveSourceRecover').checked, $('moveSourceCheckpoint').checked], [true, false]);
        // Cancel while the answer's refresh runs: it stays closed, and the skip is still said.
        boxes()[0].checked = true; refreshMoveCount();
        window.__answer = { [adopt]: [{ body: { switched: 0, rebuilding: 0, skipped: [{ name: skipped.name, reason: 'busy, for the test' }] } }] };
        const run = moveAgentsApply(true);
        await sleep(0);
        moveSourceDlg.close();
        await run;
        ok('Cancel is not undone', !moveSourceDlg.open);
        ok('the skip is told: ' + $('toast').textContent, $('toast').textContent.includes('busy, for the test'));
      } finally {
        if (moveSourceDlg.open) moveSourceDlg.close();
        window.__answer = {}; delete window.__override['/v1/agents']; delete window.__override['/v1/ai-profiles'];
        profiles = was; await refresh(true); renderAiList();
      }
    },
    rebuildsToApplyLeaveAStoppedAgentDown: async () => {
      // Review of HB-0441: the page's last poll is not the server's state. A running-only rebuild asks the server to leave a stopped agent down.
      const list = await (await fetch('/v1/agents')).json();
      const a = list.find((x) => x.id === 'a1' && x.state === 'RUNNING');
      const reb = 'POST /v1/agents/' + a.id + '/rebuild', rebRe = new RegExp('/v1/agents/' + a.id + '/rebuild$');
      const toastText = () => $('toast').textContent;
      try {
        // Stopped after the page's last poll: an image pin.
        editAgentId = a.id;
        const sel = $('editImage');
        const o = document.createElement('option'); o.value = 'hatchabot/runtime:trial'; sel.replaceChildren(o); sel.value = o.value;
        sel.dataset.agent = a.id; delete sel.dataset.loading; // its own list, loaded
        window.__confirmAnswer = true;
        window.__answer = { ['PATCH /v1/agents/' + a.id]: [{ body: { id: a.id, image: o.value, sameImage: false } }], [reb]: [{ status: 202, body: { rebuilding: false, atNextStart: true } }] };
        await saveImagePin();
        eq('Pin & rebuild', calls('POST', rebRe).at(-1).body, { stoppedWaits: true });
        ok('and the toast is not "rebuilding": ' + toastText(), toastText().includes('it moves onto it when it next starts') && !/rebuilding/i.test(toastText()));
        // Bulk: an image, and a rebuild.
        for (const action of ['image', 'rebuild']) {
          await openFleetActions();
          await until(() => document.querySelectorAll('.faCb').length);
          document.querySelectorAll('.faCb').forEach((cb) => { cb.checked = cb.dataset.id === a.id; });
          $('faAction').value = action; faRenderAction();
          if (action === 'image') { const f = document.createElement('option'); f.value = 'hatchabot/runtime:trial'; $('faImage').replaceChildren(f); $('faImage').value = f.value; }
          const n = calls('POST', rebRe).length;
          window.__answer = { ['PATCH /v1/agents/' + a.id]: [{ body: { id: a.id, sameImage: false } }], [reb]: [{ status: 202, body: { rebuilding: false, atNextStart: true } }] };
          await faApply();
          await until(() => !$('faApplyBtn').disabled);
          eq('Bulk ' + action, calls('POST', rebRe).slice(n).map((c) => c.body), [{ stoppedWaits: true }]);
          fleetActionsDlg.close();
        }
        // Rebuild all: one stopped since the poll is not counted as rebuilding (the stub answers the stopped one as started).
        const n = calls('POST', /\/v1\/agents\/[^/]+\/rebuild$/).length;
        window.__answer = { [reb]: [{ status: 202, body: { rebuilding: false, atNextStart: true } }] };
        await rebuildAll();
        const bodies = calls('POST', /\/v1\/agents\/[^/]+\/rebuild$/).slice(n).map((c) => c.body);
        ok('Rebuild all asks for it each time', bodies.length > 1 && bodies.every((b) => b.stoppedWaits === true));
        ok('and counts it apart: ' + toastText(), toastText().includes('Rebuilding ' + (bodies.length - 1) + ' agent') && toastText().includes('1 not running: it is rebuilt when it next starts'));
      } finally {
        window.__answer = {}; window.__confirmAnswer = true; editAgentId = null;
        if (fleetActionsDlg.open) fleetActionsDlg.close();
        await refresh(false);
      }
    },
    archiveSaysWhereTheBotWent: async () => {
      // HB-0418: the dialog and the toast follow what the server does with the bot, as Delete does.
      const list = await (await fetch('/v1/agents')).json();
      const bot = list.find((a) => a.botUsername && a.id === 'a1');
      const web = list.find((a) => a.webOnly && !a.ops);
      const toastSays = () => document.getElementById('toast').textContent;
      const go = async (a, state, patch = {}, answer = { ok: true }) => {
        window.__override['/v1/agents'] = list.map((x) => x.id === a.id ? { ...x, state, ...patch } : x);
        await refresh(false);
        window.__answer = { ['POST /v1/agents/' + a.id + '/archive']: [{ body: answer }] };
        archiveAgent(a.id, a.name, state);
        const said = document.getElementById('archiveBotNote').textContent;
        window.__override['/v1/agents'] = list.map((x) => x.id === a.id ? { ...x, ...patch, state: 'ARCHIVED' } : x);
        await confirmArchive();
        return { said, toast: toastSays() };
      };
      try {
        const plain = await go(bot, 'RUNNING');
        ok('a bot going to the pool says so: ' + plain.said, plain.said.includes('goes back in the pool'));
        ok('and after: ' + plain.toast, plain.toast.includes('its bot is back in the pool'));
        const copied = await go(bot, 'STOPPED', { exportedAt: new Date().toISOString() });
        ok('a downloaded copy keeps the bot: ' + copied.said, copied.said.includes('NOT put back in the pool') && copied.said.includes(bot.botUsername));
        ok('and after: ' + copied.toast, copied.toast.includes('left to the downloaded copy') && !copied.toast.includes('its bot is back'));
        // HB-0476: the toast says what the server did, not what it should have.
        const failed = await go(bot, 'RUNNING', {}, { ok: true, botReturn: { username: bot.botUsername, outcome: 'not-parked' } });
        ok('a bot the pool could not take is not "back in the pool": ' + failed.toast, failed.toast.includes('could not be put back in the pool') && failed.toast.includes(bot.botUsername) && !failed.toast.includes('is back in the pool'));
        const told = await go(bot, 'RUNNING', {}, { ok: true, botReturn: { username: bot.botUsername, outcome: 'pool' } });
        ok('one it took: ' + told.toast, told.toast.includes('its bot is back in the pool'));
        const none = await go(web, 'RUNNING', {}, { ok: true, botReturn: null });
        eq('no bot: the dialog says nothing of one', none.said, '');
        eq('and nor does the toast', none.toast, '"' + web.name + '" archived.');
      } finally { window.__answer = {}; delete window.__override['/v1/agents']; await refresh(false); }
    },
    helpTextNamesRealPlaces: async () => {
      // HB-0451: each text names the place that exists, and the outcome that happens.
      ok('the image pin is under Advanced', !document.getElementById('derivedSection').textContent.includes('Definition') && document.getElementById('derivedSection').textContent.includes('Advanced'));
      ok('Advanced is a real tab, Definition is not', V2_TABS.some(([, n]) => n === 'Advanced') && !V2_TABS.some(([, n]) => n === 'Definition'));
      ok('the image pin is in Advanced', V2_EMBED.advanced.some(([p]) => p === 'paneEditEnv') && V2_MOVED.some(([b, p]) => b === 'imagePinRow' && p === 'paneEditEnv'));
      // Migrate with no target picked: the select holds AI sources.
      migrateState = { id: 'p1', name: 'Anthropic API (household)' };
      $('migrateTo').innerHTML = '<option value="">— pick —</option>'; $('migrateTo').value = '';
      await runMigrate();
      ok('Migrate asks for a source: ' + document.getElementById('toast').textContent, document.getElementById('toast').textContent.includes('AI source') && !document.getElementById('toast').textContent.includes('machine'));
      migrateState = null;
      // Setup values: a credential is changed under Advanced → Environment.
      renderSetupValues({ state: 'RUNNING', parameters: [{ key: 'tone', label: 'Tone', type: 'text', target: 'file' }, { key: 'made_up_key', target: 'env' }] });
      const page = document.getElementById('setupValuesList').textContent;
      ok('setup values name Advanced → Environment: ' + page.slice(0, 120), page.includes('Advanced → Environment') && !page.includes('Environment tab'));
      renderSetupValues(null);
      // Files: a name opens here, with ← Back.
      window.__override['/v1/agents/a1/fs'] = { path: '', entries: [{ name: 'notes.md', type: 'file', size: 12 }], canUpload: true };
      try {
        openV2Agent('a1', 'files');
        await until(() => document.querySelector('#v2Files a[title="Open here"]'));
        const words = document.getElementById('v2Files').textContent;
        ok('Files says a name opens here: ' + words.slice(0, 120), words.includes('Click a name to open it here') && !words.includes('open it in a new tab'));
      } finally { try { v2Close(); } catch {} delete window.__override['/v1/agents/a1/fs']; }
    },
    reportOpenedStaysListed: async () => {
      // HB-0437: Open on GitHub is not Submit, so the report stays reachable, marked, until it is discarded.
      const iso = new Date(Date.now() - 3600e3).toISOString();
      const row = { id: 'bb22cc33-4444-4555-8666-777788889999', title: 'Backups stopped', body: 'It stopped.', createdAt: iso, by: 'agent', sentAt: iso, issueUrl: 'https://github.com/hatchabot/hatchabot/issues/new' };
      window.__override['/v1/problem-reports'] = [row, { ...row, id: 'cc33dd44-5555-4666-8777-888899990000', title: 'Unsent one', sentAt: undefined }];
      window.__override['/v1/problem-reports/' + row.id] = row;
      try {
        await openReport();
        const rows = [...document.querySelectorAll('#reportDrafts .reportdraft')];
        eq('both are listed, the unsent first', rows.map((b) => b.querySelector('.grow').textContent), ['Unsent one', 'Backups stopped']);
        ok('the opened one is marked: ' + rows[1].textContent, rows[1].textContent.includes('opened on GitHub'));
        ok('the unsent one is not', !rows[0].textContent.includes('opened on GitHub'));
        rows[1].click();
        await until(() => !$('reportReview').hidden);
        ok('it can be opened, and says what it is', $('reportReviewNote').textContent.includes('You opened this on GitHub'));
        eq('with its text', $('reportBody').value, 'It stopped.');
      } finally {
        if (reportDlg.open) reportDlg.close();
        delete window.__override['/v1/problem-reports']; delete window.__override['/v1/problem-reports/' + row.id];
      }
    },
    ownerOnlyFormsHidden: async () => {
      // HB-0443: a member who does not own the machine is not shown forms whose saves are refused.
      const account = myAccount;
      const shown = (id) => { const el = $(id), was = el.closest('section'), h = was.hidden; was.hidden = false; const on = getComputedStyle(el).display !== 'none'; was.hidden = h; return on; };
      const ids = ['mediaKeyDrawer', 'searchKeyDrawer', 'addRunnerBlock', 'botInvDrawer'];
      const defaultBox = () => [...$('aiList').querySelectorAll('label')].some((l) => l.textContent.includes('⭐ Default'));
      try {
        window.__override['/v1/account'] = { ...account, hostOwner: true };
        await loadMyAccount(); renderAiList();
        eq('the owner sees them all', ids.map(shown), [true, true, true, true]);
        ok('and the heading over the two keys', !$('extraKeysHead').hidden);
        ok('and Default on a source', defaultBox());
        window.__override['/v1/account'] = { ...account, hostOwner: false };
        await loadMyAccount(); renderAiList();
        eq('anyone else sees none', ids.map(shown), [false, false, false, false]);
        ok('nor a heading with nothing under it (review of HB-0443)', $('extraKeysHead').hidden);
        ok('nor Default on their own source', !defaultBox());
        const n = calls('GET', /\/v1\/(media|search)-key$/).length;
        await loadMediaKey(); await loadSearchKey();
        eq('and their refusals are not asked for', calls('GET', /\/v1\/(media|search)-key$/).length, n);
        // A failed read of the account is not a "no".
        window.__answer = { 'GET /v1/account': [{ status: 500, body: { error: 'made up' } }] };
        await loadMyAccount();
        eq('an unknown account leaves them showing', ids.map(shown), [true, true, true, true]);
      } finally {
        window.__answer = {}; delete window.__override['/v1/account'];
        await loadMyAccount(); myAccount = account; paintMachineOwnerOnly(); renderAiList();
      }
    },
    sheetTabFollowsStartAndStop: async () => {
      // HB-0444: a tab of edit sections redraws when the agent's state changes, unless it holds an edit.
      const list = await (await fetch('/v1/agents')).json();
      const set = async (state) => { window.__override['/v1/agents'] = list.map((a) => a.id === 'a1' ? { ...a, state } : a); await refresh(false); };
      const paneText = () => $('v2Pane').textContent;
      // The close event arrives a task later, and clears what the sheet held: waited for, with no deadline (virtual time can jump past one).
      const closeSheet = () => new Promise((r) => { v2AgentDlg.addEventListener('close', r, { once: true }); v2Close(); });
      try {
        await set('STOPPED');
        openV2Agent('a1', 'schedule');
        await until(() => paneText().includes('start it to see'));
        await set('RUNNING');
        ok('Start: the Schedule tab no longer says it is stopped', !paneText().includes('start it to see'));
        ok('and shows the tasks', !!$('v2Pane').querySelector('#cronBody'));
        await set('STOPPED');
        ok('Stop: it says so again', paneText().includes('start it to see'));
        await closeSheet();
        await set('RUNNING');
        openV2Agent('a1', 'personality');
        await until(() => $('v2Pane').querySelector('textarea'));
        const box = $('v2Pane').querySelector('textarea');
        box.value = 'A made-up draft'; box.dispatchEvent(new Event('input', { bubbles: true })); box.blur();
        await set('STOPPED');
        ok('an edit is not thrown away', $('v2Pane').contains(box) && box.value === 'A made-up draft');
        await closeSheet();
        openV2Agent('a1', 'personality');
        await until(() => $('v2Pane').querySelector('textarea'));
        const other = $('v2Pane').querySelector('textarea');
        other.focus();
        await set('RUNNING');
        ok('nor is a field in use redrawn away', $('v2Pane').contains(other));
        other.blur();
        await refresh(false);
        ok('the next poll catches up once it is not', v2SheetDrawnState === 'RUNNING');
        // A button pressed in the pane keeps the keyboard, and holds nothing back.
        const pressed = $('v2Pane').querySelector('button');
        pressed.focus();
        await set('STOPPED');
        eq('a focused button does not stop the redraw', v2SheetDrawnState, 'STOPPED');
      } finally {
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents']; await refresh(false);
      }
    },
    webChatRefusalKeepsTheMessage: async () => {
      // HB-0446: a message refused before delivery goes back in the box; only one that may have got through stays as sent.
      const list = await (await fetch('/v1/agents')).json();
      const a = list[1];
      window.__override['/v1/agents/' + a.id + '/chat'] = { messages: [] };
      const path = 'POST /v1/agents/' + a.id + '/chat';
      try {
        await openWebChat(a.id);
        const log = $('wchatLog'), box = $('wchatText');
        const send = async (text, answer) => {
          window.__answer = { [path]: [answer] };
          box.value = text;
          await webChatSend();
          return { bubble: [...log.querySelectorAll('.wchat-msg.me')].some((m) => m.textContent.includes(text)), box: box.value, err: $('wchatErr').textContent };
        };
        for (const [status, error] of [[409, 'It is busy (being rebuilt or moved) — try again shortly.'], [429, "That's 60 messages this hour — try again in 12 minutes."], [409, 'It is not running right now. Ask its owner to start it.']]) {
          const text = 'A long made-up message ' + status + error.length;
          const r = await send(text, { status, body: { error } });
          eq('refused ' + status + ': back in the box, not in the log, and said', r, { bubble: false, box: text, err: error });
          box.value = '';
        }
        const late = await send('It may have got through', { status: 504, body: { error: 'No answer within 90 s. It may still be working.' } });
        eq('no answer in time: it stays as sent', [late.bubble, late.box], [true, '']);
        const lost = await send('The network went', { reject: 'Failed to fetch' });
        eq('nor when the answer never came', [lost.bubble, lost.box], [true, '']);
      } finally {
        window.__answer = {}; delete window.__override['/v1/agents/' + a.id + '/chat'];
        if (webChatDlg.open) webChatDlg.close();
      }
    },
    plannedNameInUseIsKept: async () => {
      // HB-0447: a plan goes only when your own agent of its name was made after it; a refused name is said.
      const list = await (await fetch('/v1/agents')).json();
      const was = agentTodos;
      const day = (d) => new Date(Date.UTC(2026, 9, d)).toISOString();
      const mine = { ...list[0], id: 'old1', name: 'Helper', state: 'ARCHIVED', createdAt: day(1) };
      const theirs = { ...list[0], id: 'shared1', name: 'Tutor', role: 'member', createdAt: day(20) };
      const made = { ...list[0], id: 'new1', name: 'Gardener', createdAt: day(20) };
      window.__override['/v1/agents'] = [...list, mine, theirs, made];
      window.__override['/v1/agent-todos'] = { todos: [{ id: 'k1', name: 'helper', createdAt: day(10) }, { id: 'k2', name: 'Tutor', createdAt: day(10) }, { id: 'k3', name: 'Gardener', createdAt: day(10) }] };
      try {
        await refresh(false);
        await loadTodos();
        eq('a plan with an older agent\'s name, or a name shared with you, stays', agentTodos.map((t) => t.id), ['k1', 'k2']);
        eq('the one you made since is done', calls('DELETE', /^\/v1\/agent-todos\/k\d$/).map((c) => c.path), ['/v1/agent-todos/k3']);
        // The server refuses a name you use: the box keeps it and the reason is said.
        renderV2();
        const box = await until(() => $('v2TodoNew'));
        box.value = 'helper';
        window.__answer = { 'POST /v1/agent-todos': [{ status: 409, body: { error: 'You already have an agent called "Helper" (archived). Plan another name.' } }] };
        await addTodo();
        eq('the box keeps it', $('v2TodoNew').value, 'helper');
        ok('the reason is said', document.getElementById('toast').textContent.includes('already have an agent called'));
      } finally {
        window.__answer = {}; if ($('v2TodoNew')) $('v2TodoNew').value = '';
        delete window.__override['/v1/agents']; delete window.__override['/v1/agent-todos'];
        agentTodos = was; await refresh(false); await loadTodos();
      }
    },
    dragArchivedOntoGroup: async () => {
      // HB-0448: an archived agent dropped on a group, or the new-group strip, is restored into it.
      const list = await (await fetch('/v1/agents')).json();
      const a = list.find((x) => x.id === 'a1');
      const name = a.name;
      const drop = async (zone) => {
        v2Collapsed.archived = false; renderV2(); await sleep(20);
        const from = [...document.querySelectorAll('#v2groups .v2grid[data-v2drop="' + V2_ARCHIVE + '"] .v2agent')].find((el) => el.textContent.includes(name));
        ok('its tile is under Archived', !!from);
        const p = centre(from);
        pointer('pointerdown', from, p.x, p.y);
        pointer('pointermove', window, p.x + 12, p.y + 12);
        const target = zone();
        target.scrollIntoView({ block: 'center' });
        await sleep(20);
        const q = centre(target);
        pointer('pointermove', window, q.x, q.y);
        pointer('pointerup', window, q.x, q.y);
      };
      const archived = () => { window.__override['/v1/agents'] = list.map((x) => x.id === 'a1' ? { ...x, state: 'ARCHIVED' } : x); return refresh(false); };
      const restores = () => calls('POST', /\/v1\/agents\/a1\/restore$/);
      const moves = () => calls('POST', /\/v1\/agents\/a1\/move$/);
      const wasCollapsed = v2Collapsed.archived;
      try {
        v2SetView('group');
        await archived();
        let m = moves().length, r = restores().length;
        await drop(() => document.querySelector('.v2grid[data-v2drop="Money"]'));
        await until(() => restores().length > r && moves().length > m);
        eq('restored, then into the group it was dropped on', moves().at(-1).body, { before: null, group: 'Money' });
        ok('in that order', window.__calls.lastIndexOf(restores().at(-1)) < window.__calls.lastIndexOf(moves().at(-1)));
        // The strip makes the group.
        await archived();
        m = moves().length; r = restores().length;
        await drop(() => { const n = document.getElementById('v2NewGroup'); ok('the strip is offered', !n.hidden); return n; });
        await until(() => restores().length > r && moves().length > m);
        ok('the strip made a new group: ' + JSON.stringify(moves().at(-1).body), /^New group/.test(moves().at(-1).body.group));
        if (document.activeElement?.isContentEditable) document.activeElement.blur();
        // A restore said no to: nothing moves.
        await archived();
        window.__confirmAnswer = false;
        m = moves().length;
        await drop(() => document.querySelector('.v2grid[data-v2drop="Money"]'));
        await sleep(100);
        eq('no restore, no move', moves().length, m);
      } finally {
        window.__confirmAnswer = true; v2Collapsed.archived = wasCollapsed;
        delete window.__override['/v1/agents']; await refresh(false);
      }
    },
    publicAccessLeftoverIsSaid: async () => {
      // HB-0449: Tailscale kept its entry after a failed turn-on: the warning and the command are shown.
      const off = { on: false, serving: false, safeguards: [], failing: [], invitedOnly: false };
      window.__override['/v1/public-access'] = off;
      const warning = "Tailscale's Funnel entry could not be removed (made up). Hatchabot is not serving it. Run: tailscale funnel --https=443 off";
      try {
        window.__answer = { 'POST /v1/public-access/on': [{ status: 409, body: { error: 'Turned back off: a made-up safeguard.', warning, command: 'tailscale funnel --https=443 off' } }] };
        await reachTurnOn(document.createElement('button'));
        const err = $('reachErr').textContent;
        ok('the reason stays: ' + err, err.includes('Turned back off'));
        ok('with the warning and the command', err.includes('could not be removed') && err.includes('tailscale funnel --https=443 off'));
        // Found on looking: the status carries it.
        reachRender({ ...off, recovered: { funnelError: 'made up', command: 'tailscale funnel --https=443 off' } });
        const found = $('reachErr').textContent;
        ok('a leftover found on looking is said: ' + found, found.includes('could not be removed') && found.includes('Run: tailscale funnel --https=443 off'));
        reachRender(off);
        eq('and is gone when it is', $('reachErr').textContent, '');
      } finally { window.__answer = {}; delete window.__override['/v1/public-access']; $('reachErr').textContent = ''; }
    },
    channelSelectsGoBackOnFailure: async () => {
      // HB-0450: a failed save does not leave the select on a value the server does not hold.
      window.__override['/v1/agents/a1/channels'] = { channels: [{ kind: 'telegram', displayName: '@made_up_bot' }], imageSupports: ['telegram'], allowKnocks: false };
      try {
        openV2Agent('a1', 'messaging');
        const box = await until(() => $('v2Chans'));
        await sleep(100);
        const knocks = await until(() => box.querySelector('select[id^="chanKnocks-"]'));
        const was = knocks.value;
        const flip = was === 'on' ? 'off' : 'on';
        window.__answer = { 'POST /v1/agents/a1/allow-knocks': [{ status: 503, body: { error: 'Restarting, for the test.' } }] };
        knocks.value = flip; knocks.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => document.getElementById('toast').textContent.includes('Restarting, for the test.'));
        eq('a refused save goes back', knocks.value, was);
        window.__answer = { 'POST /v1/agents/a1/allow-knocks': [{ reject: 'Failed to fetch' }] };
        knocks.value = flip; knocks.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => document.getElementById('toast').textContent.includes('Failed to fetch'));
        eq('so does one with the network gone', knocks.value, was);
        const rich = box.querySelector('#chanRich-telegram');
        ok('the Rich messages select is there', !!rich);
        window.__answer = { 'PATCH /v1/agents/a1': [{ status: 503, body: { error: 'Restarting again, for the test.' } }] };
        rich.value = 'off'; rich.dispatchEvent(new Event('change', { bubbles: true }));
        await until(() => document.getElementById('toast').textContent.includes('Restarting again, for the test.'));
        eq('Rich messages too', rich.value, 'on');
      } finally { window.__answer = {}; delete window.__override['/v1/agents/a1/channels']; try { v2Close(); } catch {} }
    },
    // "More models" (Settings → AI, a new source): a phone shows no tooltip, so its placeholder shows the
    // list; a list typed with spaces is taken as one with commas (2026-11-08).
    moreModelsTakeCommasOrSpaces: async () => {
      try {
        await openAiDlg('ai');
        ok('the placeholder shows a list: ' + $('aiModelsAdd').placeholder, /model-a, model-b/.test($('aiModelsAdd').placeholder));
        $('aiKind').value = 'local'; aiKindChanged();
        $('aiModelSelect').style.display = 'none';
        $('aiName').value = 'Home server models'; $('aiModel').value = 'local-default';
        $('aiModelsAdd').value = ' model-a model-b,model-c ,  model-d ';
        window.__answer = { 'POST /v1/ai-profiles': [{ body: { id: 'p9' } }] };
        await addAiProfile();
        const sent = await until(() => calls('POST', /\/v1\/ai-profiles$/).at(-1));
        eq('every model, however they were separated', sent.body.models, ['local-default', 'model-a', 'model-b', 'model-c', 'model-d']);
      } finally { window.__answer = {}; $('aiModelsAdd').value = ''; $('aiName').value = ''; $('aiModel').value = ''; if (aiDlg.open) aiDlg.close(); }
    },
  });
  /** The phone runs (the page opened 360 and 390 px wide): what has to fit a phone screen. The desktop suite is skipped there. */
  const P = {
    phoneSortButtonsReachable: async () => {
      // Five sort buttons (Cost, Age, Name, Activity, My order) ran past the edge of a phone screen and the
      // last were unreachable (Chris, 2026-10-23): they wrap now, every one inside the screen.
      ok('a phone-wide window: ' + innerWidth, innerWidth <= 420);
      const edges = () => [...document.querySelectorAll('.v2binsort button')].map((b) => [b.textContent.trim(), Math.round(b.getBoundingClientRect().right)]);
      await until(() => document.querySelectorAll('.v2binsort button').length >= 4);
      ok('every sort button inside the screen: ' + JSON.stringify(edges()), edges().every(([, r]) => r > 0 && r <= innerWidth));
      const cost = byText('.v2views button', 'Cost');
      if (cost) {
        cost.click();
        await until(() => document.getElementById('v2sort-cost'));
        ok('with Cost too: ' + JSON.stringify(edges()), edges().length >= 5 && edges().every(([, r]) => r > 0 && r <= innerWidth));
      }
      ok('the page does not scroll sideways: ' + document.documentElement.scrollWidth + ' > ' + innerWidth, document.documentElement.scrollWidth <= innerWidth);
    },
    phoneChipsBelowTheStatusBar: async () => {
      // An iPhone home-screen app: a 59px status bar inside the page (safe-area inset).
      // The header pinned at the inset covered what came right after it: on an install
      // with Setup done, the first row of View by chips, which at the top of the page
      // could never be scrolled into view (HB-0096).
      const root = document.documentElement;
      try {
        root.style.setProperty('--safe-top', '59px');
        scrollTo(0, 0);
        await until(() => document.querySelector('.v2views button'));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const header = document.getElementById('v2Header');
        const head = header.getBoundingClientRect();
        const next = [...header.parentElement.children].slice([...header.parentElement.children].indexOf(header) + 1)
          .find((e) => e.offsetHeight > 0 && getComputedStyle(e).position !== 'fixed');
        const below = next.getBoundingClientRect();
        ok('the header starts at the top, under the status bar: ' + Math.round(head.top), Math.round(head.top) === 0);
        ok('and ends below it: ' + Math.round(head.bottom), head.bottom >= 59 + 30);
        ok('what follows it (' + (next.id || next.className) + ') starts below it: ' + Math.round(below.top) + ' >= ' + Math.round(head.bottom), below.top >= head.bottom - 1);
      } finally {
        root.style.removeProperty('--safe-top');
      }
    },
    phoneFileHasAWayBack: async () => {
      // A file opened from Files on a phone: ← Back is on the screen (the app from the home screen has no browser bar).
      window.__override['/v1/agents/a1/fs'] = { path: '', entries: [{ name: 'notes.txt', type: 'file', size: 10, mtime: '' }] };
      window.__override['/v1/agents/a1/fs/file'] = 'a note';
      try {
        openV2Agent('a1', 'files');
        const a = await until(() => [...document.querySelectorAll('#v2FilesDrop tbody a')].find((x) => x.textContent.trim() === 'notes.txt'));
        a.click();
        await until(() => document.getElementById('v2FileBody')?.textContent.includes('a note'));
        const back = byText('#v2Files button', '← Back');
        const r = back.getBoundingClientRect();
        ok('← Back is on the screen: ' + JSON.stringify(r), r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight);
        back.click();
        await until(() => document.querySelector('#v2FilesDrop tbody tr'));
      } finally {
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents/a1/fs']; delete window.__override['/v1/agents/a1/fs/file']; v2FilesPath.delete('a1');
      }
    },
    searchHealthAndSwitch: async () => {
      // The fleet: what is in use, why, and a test that shows the answer (HB-0390, HB-0391).
      const out = { mode: 'auto', active: 'duckduckgo', keySet: true, why: 'The Brave key has run out of quota.', checkedAt: '2026-11-03T10:00:00Z',
        brave: { status: 'exhausted', detail: 'The Brave key has run out of quota.', resetsAt: '2026-11-20T00:00:00Z' }, duckduckgo: { status: 'ok', detail: 'DuckDuckGo works.' }, applied: { at: '2026-11-03T10:00:05Z', changed: 3, failed: ['Kitchen'], rebuild: 2 } };
      window.__answer = { 'POST /v1/web-search/check': [{ body: out }], 'PUT /v1/web-search': [{ body: { ...out, mode: 'duckduckgo', why: 'You chose DuckDuckGo.' } }] };
      await testFleetSearch();
      ok('the POST was made', calls('POST', /\/v1\/web-search\/check$/).length === 1);
      const health = document.getElementById('searchHealth').textContent;
      ok('names what is in use: ' + health, health.includes('In use: DuckDuckGo'));
      ok('says why', health.includes('run out of quota'));
      ok('says when it returns', health.includes("quota returns"));
      ok('names an agent not moved', health.includes('Kitchen'));
      ok('says how many wait for a rebuild', health.includes('2 on DuckDuckGo until their next Rebuild'));
      const mode = document.getElementById('searchMode');
      mode.value = 'duckduckgo'; mode.dispatchEvent(new Event('change', { bubbles: true }));
      const put = await until(() => calls('PUT', /\/v1\/web-search$/)[0]);
      eq('the mode chosen', put.body, { mode: 'duckduckgo' });
      await until(() => document.getElementById('searchHealth').textContent.includes('You chose DuckDuckGo'));
      // One agent: the test says who answered, and a failure says why.
      openV2Agent('a1', 'advanced');
      const btn = await until(() => document.getElementById('agentSearchTestBtn'));
      window.__answer = { 'POST /v1/agents/a1/search-test': [{ body: { ok: true, provider: 'duckduckgo', results: 1, detail: 'Search works: DuckDuckGo answered.' } }, { body: { ok: false, why: 'quota', provider: 'brave', detail: 'Brave refused: its quota or rate limit is used up.' } }, { status: 409, body: { error: 'Start the agent first: this runs a real search inside it.' } }] };
      btn.click();
      await until(() => document.getElementById('agentSearchTestOut').textContent.includes('DuckDuckGo answered'));
      btn.click();
      await until(() => document.getElementById('agentSearchTestOut').textContent.includes('⚠ Brave refused'));
      btn.click();
      await until(() => document.getElementById('agentSearchTestOut').textContent.includes('Start the agent first'));
      ok('the button is usable again', !btn.disabled);
      v2Close();
      window.__answer = {};
    },
    searchTurnedAway: async () => {
      // HB-0455: DuckDuckGo answers this machine with a challenge page. The page says there is no free search here and a Brave key is needed.
      const away = { status: 'turned-away', detail: 'DuckDuckGo turns this machine away: it answered with a challenge page, not results. So this machine gets no free search from DuckDuckGo, and agents can search only with a working Brave key.' };
      const noKey = { mode: 'auto', active: 'duckduckgo', keySet: false, why: 'No Brave key is set.', checkedAt: '2026-11-05T10:00:00Z', duckduckgo: away };
      try {
        window.__answer = { 'POST /v1/web-search/check': [{ body: noKey }] };
        await testFleetSearch();
        const health = () => document.getElementById('searchHealth').textContent;
        ok('it says agents have no search: ' + health(), health().includes('Agents have no working web search'));
        ok('and why, and what is needed', health().includes('no free search from DuckDuckGo') && health().includes('Brave key is needed') && health().includes('Paste one above'));
        ok('not "answered with no results"', !health().includes('answered with no results'));
        // A key that works, with DuckDuckGo chosen by hand: it says to choose Brave.
        renderSearchHealth({ ...noKey, mode: 'duckduckgo', keySet: true, why: 'You chose DuckDuckGo.', brave: { status: 'ok', detail: 'Brave works.' } });
        ok('a working key: choose Brave', health().includes('yours works') && !health().includes('Paste one above'));
        // On Brave: there is nothing to fall back on.
        renderSearchHealth({ ...noKey, active: 'brave', keySet: true, why: 'Brave has quota.', brave: { status: 'ok', detail: 'Brave works.' } });
        ok('on Brave: no fallback, said quietly', health().includes('agents stay on Brave even when it runs low') && !health().includes('Agents have no working web search'));
        // On Brave and nearly out: it stays there, and says so (review of HB-0455).
        renderSearchHealth({ ...noKey, active: 'brave', keySet: true, why: 'The Brave key has 5 queries left. DuckDuckGo turns this machine away, so agents stay on Brave until it runs out.', brave: { status: 'low', detail: 'The Brave key has 5 queries left.' } });
        ok('nearly out: stays on Brave until it runs out', health().includes('The Brave key is nearly out') && health().includes('stay on Brave until it runs out') && !health().includes('if the Brave key runs out'));
        // DuckDuckGo working: no such line.
        renderSearchHealth({ ...noKey, duckduckgo: { status: 'ok', detail: 'DuckDuckGo works.' } });
        ok('DuckDuckGo works: nothing said', !document.getElementById('searchTurnedAway'));
      } finally {
        window.__answer = {};
      }
    },
    braveUsagePanel: async () => {
      // HB-0532: the month's Brave searches — what is left, a bar per day, who searches most, the cost, and the price.
      const days = Array.from({ length: 30 }, (_, i) => ({ day: '2026-11-' + String(i + 1).padStart(2, '0'), brave: i < 10 ? 40 : 0, other: i === 2 ? 7 : 0 }));
      const usage = { period: { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', basis: 'calendar', elapsedDays: 10.5, days: 30 },
        brave: 400, other: 7, cached: 4, byDay: days,
        byAgent: [
          { id: 'a1', name: 'Market Watch', kind: 'agent', brave: 300, other: 0, cached: 0, cost: 1.5 },
          { id: 'a2', name: 'Trip Planner', kind: 'agent', brave: 50, other: 7, cached: 4, cost: 0.25 },
          { id: '__checks__', name: "Hatchabot's checks", kind: 'checks', brave: 50, other: 0, cached: 0, cost: 0.25 },
        ],
        allowance: { kind: 'credit', free: 1000, used: 400, left: 600 }, price: { per1000: 5, monthlyCredit: 5 },
        cost: { gross: 2, net: 0, projectedNet: 0.71 }, projected: 1143, runsOut: '2026-11-27', keySet: true, active: 'brave' };
      try {
        window.__override['/v1/web-search/usage'] = usage;
        await loadSearchUsage();
        const el = document.getElementById('searchUsage');
        const text = () => el.textContent.replace(/\s+/g, ' ');
        ok('says what is left: ' + text().slice(0, 160), text().includes('600 of 1,000 free searches left'));
        ok('the drawer heading says it too', document.getElementById('searchUsageSum').textContent.includes('400 of 1,000 free searches used this month'));
        const used = el.querySelector('.sv-used');
        ok('the meter is 40% full: ' + used?.style.width, parseFloat(used?.style.width) === 40);
        ok('a mark where this pace ends the month', !!el.querySelector('.sv-proj'));
        ok('says when the free credit runs out', text().includes('free credit runs out about') && /Nov 27|27 Nov/.test(text()));
        ok('the cost so far and by month end', text().includes('Estimated cost: $0.00 so far') && text().includes('$0.71 by month end'));
        const bars = el.querySelectorAll('.sv-day');
        eq('a bar per day', bars.length, 30);
        ok('a bar says its numbers: ' + bars[2].title, bars[2].title.includes('40 Brave') && bars[2].title.includes('7 other'));
        ok('two kinds of search: a legend', text().includes('DuckDuckGo and others'));
        const names = [...el.querySelectorAll('.sv-name')].map((x) => x.textContent);
        eq('who searches most, most first', names, ['Market Watch', 'Trip Planner', "Hatchabot's checks"]);
        ok('their share and cost', text().includes('300 · 75% · $1.50'));
        ok('cached answers are said apart', text().includes("4 more were answered from OpenClaw's cache"));
        // The price: saved, and the panel shows the answer.
        window.__answer = { 'PUT /v1/web-search': [{ body: { ...usage, price: { per1000: 4, monthlyCredit: 0 }, cost: { gross: 1.6, net: 1.6, projectedNet: 4.57 } } }] };
        document.getElementById('searchPricePer').value = '4';
        document.getElementById('searchPriceCredit').value = '0';
        document.getElementById('searchPriceSaveBtn').click();
        const put = await until(() => calls('PUT', /\/v1\/web-search$/).find((c) => c.body?.price));
        eq('the price sent', put.body, { price: { per1000: 4, monthlyCredit: 0 } });
        await until(() => text().includes('Estimated cost: $1.60 so far'));
        // No key and no searches: nothing to show.
        renderSearchUsage({ ...usage, keySet: false, brave: 0, other: 0, byAgent: [], allowance: undefined });
        ok('no key, no searches: empty', el.textContent.trim() === '' && document.getElementById('searchUsageSum').textContent === '');
      } finally {
        delete window.__override['/v1/web-search/usage'];
        window.__answer = {};
      }
    },
    agentGmailTest: async () => {
      // The owner's request (2026-11-03): a button per account that has Gmail; it says what the test said.
      window.__override['/v1/agents/a1/connections'] = { accounts: [
        { email: 'mara@example.org', client: 'default', auth: 'oauth', services: ['gmail', 'calendar'] },
        { email: 'jo@example.org', client: 'default', auth: 'oauth', services: ['calendar'] },
      ] };
      try {
        openV2Agent('a1', 'knowledge');
        const list = await until(() => { const el = document.getElementById('connList'); return el?.querySelectorAll('.pair').length === 2 && el; });
        const rows = [...list.querySelectorAll('.pair')];
        const btn = () => rows[0].querySelector('button:not(.danger)');
        ok('the account with Gmail has the button', btn()?.textContent === 'Test Gmail');
        ok('the account without Gmail has none', !rows[1].querySelector('button:not(.danger)'));
        window.__answer = { 'POST /v1/agents/a1/connections/mara%40example.org/test': [
          { body: { ok: true, detail: 'Gmail works: the sign-in is good, and the inbox answered (12 messages).' } },
          { body: { ok: false, why: 'signin', detail: 'Google no longer accepts this sign-in: it expired or was revoked.' } },
          { status: 409, body: { error: 'Start the agent first: this test runs inside it.' } },
        ] };
        const out = document.getElementById('connGmailOut0');
        btn().click();
        await until(() => out.textContent.includes('✓ Gmail works'));
        btn().click();
        await until(() => out.textContent.includes('⚠ Google no longer accepts'));
        btn().click();
        await until(() => out.textContent.includes('Start the agent first'));
        ok('the button is usable again', !btn().disabled);
        v2Close();
      } finally {
        delete window.__override['/v1/agents/a1/connections'];
        window.__answer = {};
      }
    },
    phoneHeaderShowsTheVersion: async () => {
      // The owner (2026-11-07): "i can't see the version of hatchabot in the header" on a phone.
      const ver = document.getElementById('v2AppVer'), header = document.getElementById('v2Header');
      const dim = getComputedStyle(document.querySelector('.sub')).color;
      const check = (what) => {
        const r = ver.getBoundingClientRect(), h = header.getBoundingClientRect();
        ok(what + ': the version shows: ' + JSON.stringify(r), r.width > 20 && r.height >= 8 && getComputedStyle(ver).visibility !== 'hidden');
        eq(what + ': it names the build', ver.textContent, 'v' + window.HATCHABOT_VERSION);
        ok(what + ': inside the header', r.top >= h.top && r.bottom <= h.bottom && r.left >= 0);
        ok(what + ': dim, not a colour of its own', getComputedStyle(ver).color === dim);
        const parts = [...header.querySelectorAll('.v2brand img, .v2hubactions button:not([hidden]), .v2avatar, #v2AppVer')].filter((e) => e.getBoundingClientRect().width > 0);
        const out = parts.filter((e) => { const b = e.getBoundingClientRect(); return b.left < 0 || b.right > innerWidth; });
        ok(what + ': nothing past the edge: ' + out.map((e) => e.getAttribute('aria-label') || e.id || e.tagName).join(', '), !out.length);
        const hit = [...header.querySelectorAll('.v2hubactions button:not([hidden]), #v2AvatarBtn')].filter((b) => { const q = b.getBoundingClientRect(); return q.width > 0 && q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top; });
        ok(what + ': clear of the buttons: ' + hit.map((b) => b.getAttribute('aria-label') || b.id).join(', '), !hit.length);
        // A row that gives way (HB-0605) must not paint its buttons over each other or the account button.
        const row = [...header.querySelectorAll('.v2hubactions button:not([hidden]), #v2AvatarBtn')].map((b) => [b.getAttribute('aria-label') || b.id, b.getBoundingClientRect()]).filter(([, q]) => q.width > 0);
        const over = row.filter(([, a], i) => row.some(([, b], j) => j !== i && a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom && a.bottom > b.top)).map(([n]) => n);
        ok(what + ': no button over another: ' + over.join(', '), !over.length);
        ok(what + ': no sideways scroll: ' + document.documentElement.scrollWidth, document.documentElement.scrollWidth <= innerWidth);
      };
      scrollTo(0, 0);
      check('a ' + innerWidth + ' px phone');
      const inbox = document.getElementById('v2InboxBtn'), was = inbox.hidden;
      try { inbox.hidden = false; check('with Inbox showing too'); } finally { inbox.hidden = was; }
    },
    phoneSheetHasAWayBack: async () => {
      // The owner (2026-11-07): "it feels awkward to click away to return from an agent to the main screen".
      try {
        openV2Agent('a1');
        const bar = document.getElementById('v2AgentBar');
        const back = bar.querySelector('.v2sback');
        const r = back.getBoundingClientRect();
        ok('‹ Back is at the top left: ' + JSON.stringify(r), r.width >= 32 && r.height >= 32 && r.left >= 0 && r.left < 30 && r.top >= 0 && r.bottom <= 120);
        eq('it says where it goes', back.getAttribute('aria-label'), 'Back to all agents');
        ok('one control: the ✕ gives way', getComputedStyle(bar.querySelector('.v2sclose')).display === 'none');
        const box = v2AgentDlg.getBoundingClientRect();
        ok('the home screen shows above the sheet: ' + Math.round(box.top), box.top >= 40 && box.top <= 60);
        ok('the sheet fits the screen: ' + JSON.stringify(box), box.left >= 0 && Math.round(box.right) <= innerWidth && Math.round(box.bottom) <= innerHeight);
        ok('the name keeps room: ' + Math.round(document.getElementById('v2AgentName').getBoundingClientRect().width), document.getElementById('v2AgentName').getBoundingClientRect().width >= 60);
        const named = [...bar.querySelectorAll('button')].filter((b) => getComputedStyle(b).display !== 'none').map((b) => b.getAttribute('aria-label') || b.innerText.trim());
        ok('its buttons, down to their emoji, keep their names: ' + named.join(' | '), named.includes('Back to all agents') && named.includes('Chat') && named.every((x) => /[A-Za-z]{3}/.test(x)));
        // At the foot of a long tab, Back is where it was.
        const pane = document.getElementById('v2Pane');
        pane.scrollTop = pane.scrollHeight;
        await sleep(30);
        ok('the tab scrolled: ' + pane.scrollTop, pane.scrollTop > 100);
        const r2 = back.getBoundingClientRect();
        ok('‹ Back stays put: ' + Math.round(r2.top) + ' (was ' + Math.round(r.top) + ')', Math.abs(r2.top - r.top) < 1);
        back.click();
        ok('‹ Back goes home', !v2AgentDlg.open);
        // The check's Chrome does not always deliver a dialog's close event, so it is sent here as a browser would.
        v2AgentDlg.dispatchEvent(new Event('close'));
        eq('the sheet let go of its agent', v2AgentId, null);
        // A tap on the strip of home screen above it goes home too; a tap on the sheet does not.
        openV2Agent('a1');
        document.getElementById('v2AgentName').click();
        ok('a tap on the sheet keeps it', v2AgentDlg.open);
        v2AgentDlg.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: Math.round(innerWidth / 2), clientY: Math.round(box.top / 2) }));
        ok('a tap above it closes it', !v2AgentDlg.open);
        v2AgentDlg.dispatchEvent(new Event('close'));
        eq('and let go of its agent', v2AgentId, null);
      } finally { try { v2Close(); } catch {} }
    },
    phoneTasksFit: async () => {
      // Schedule on a phone (2026-11-07): each task row's four buttons sat in one line beside its words,
      // so the tab was ~404 px at least and ran off the right of the screen, Delete and Add task with it.
      const task = { id: 'c8', name: 'Pre-market briefing', scheduleKind: 'cron', scheduleExpr: '0 8 * * 1-5', scheduleTz: 'America/Toronto', enabled: true, payloadKind: 'agentTurn', message: 'Post the pre-market briefing', lastStatus: 'ok', consecutiveErrors: 0 };
      window.__override['/v1/agents/a1/crons'] = { crons: [task, { ...task, id: 'c9', name: 'Weekly portfolio check' }], waiting: [], notes: ['c8'], noteReach: false };
      const outside = (sel) => [...document.querySelectorAll(sel)].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < 0 || r.right > innerWidth); }).map((el) => (el.id || el.textContent.trim()).slice(0, 30));
      try {
        openV2Agent('a1', 'schedule');
        await until(() => document.querySelectorAll('#cronList .pair').length === 2);
        eq('the Tasks tab fits the screen', outside('#cronBody *'), []);
        const row = document.querySelector('#cronList .pair'), words = row.querySelector('.grow');
        ok('a task\'s words keep its width: ' + Math.round(words.getBoundingClientRect().width) + ' of ' + Math.round(row.getBoundingClientRect().width), words.getBoundingClientRect().width > row.getBoundingClientRect().width * 0.8);
        ok('its buttons are under them', [...row.querySelectorAll(':scope > button')].every((b) => b.getBoundingClientRect().top >= words.getBoundingClientRect().bottom - 1));
      } finally {
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents/a1/crons'];
      }
    },
    phoneAccessAndSpendingFit: async () => {
      // Sharing → Access and Usage → Spending on a phone (2026-10-25): nothing past the edge, and an
      // Access row's words keep most of its width (they were squeezed to a word a line).
      const month = new Date().toISOString().slice(0, 7);
      window.__override['/v1/agents/a1/access'] = accOv();
      window.__override['/v1/budgets'] = { month, tz: 'UTC', agents: [{ id: 'a1', name: 'Homework Helper', state: 'RUNNING', billing: 'api', spent: 12, lastMonth: 10, monthlyNow: 14, suggested: 20,
        alertEvery: { every: 5, month, spent: 12, passed: 2, next: 15 }, budget: { scope: 'a1', usd: 20, atLimit: 'warn', month, spent: 12, pct: 60, level: 0, resetsOn: 'next 1st' } }] };
      v2AccessCache = null;
      const outside = (sel) => [...document.querySelectorAll(sel)].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < 0 || r.right > innerWidth); }).map((el) => el.textContent.trim().slice(0, 30));
      try {
        openV2Agent('a1', 'sharing');
        await until(() => document.querySelectorAll('#v2Access .v2accrow').length === 4);
        ok('Access fits the screen: ' + JSON.stringify(outside('#v2Access *')), !outside('#v2Access *').length);
        const row = accRow('self@example.org');
        ok('a row\'s words keep most of it: ' + Math.round(row.children[1].getBoundingClientRect().width) + ' of ' + Math.round(row.getBoundingClientRect().width), row.children[1].getBoundingClientRect().width > row.getBoundingClientRect().width * 0.5);
        v2Close();
        openV2Agent('a1', 'usage');
        await until(() => document.getElementById('bgUsd_a1'));
        ok('Spending fits the screen: ' + JSON.stringify(outside('#v2BudgetRow *')), !outside('#v2BudgetRow *').length);
      } finally {
        try { v2Close(); } catch {}
        delete window.__override['/v1/agents/a1/access']; delete window.__override['/v1/budgets']; v2AccessCache = null;
      }
    },
    phoneInspectorShowsTheFile: async () => {
      // An archived agent's inspector on a phone (review of HB-0610): the file list runs the width, the file
      // under it, so a file tapped at the foot of a long list loaded out of sight. It is brought into view.
      const files = Array.from({ length: 20 }, (_, i) => ({ name: 'memory/2026-10-' + String(i + 10) + '.md', bytes: 1200 + i }));
      window.__override['/v1/agents/a1/inspect'] = { files, transcriptTurns: 3 };
      // Long files: a page with room to scroll each one to the top of the screen.
      const notes = (head, line) => head + '\n\n' + Array.from({ length: 40 }, (_, i) => '- ' + line + ' (' + (i + 1) + ')').join('\n');
      window.__override['/v1/agents/a1/inspect/file/' + encodeURIComponent(files[19].name)] = { content: notes('# The last day', 'Spelling test on Friday') };
      window.__override['/v1/agents/a1/inspect/file/' + encodeURIComponent(files[18].name)] = { content: notes('# The day before', 'Library books back on Thursday') };
      try {
        await openInspect('a1', 'Homework Helper');
        const body = document.getElementById('inspFileBody');
        const last = await until(() => document.querySelectorAll('#inspFileList .inspfile')[19]);
        ok('the file starts below the screen: ' + Math.round(body.getBoundingClientRect().top), body.getBoundingClientRect().top > innerHeight);
        last.click();
        await until(() => body.textContent.includes('Spelling test'));
        // In view: all of it, or (a long one) its start in the top half of the screen.
        const r = body.getBoundingClientRect();
        ok('a tapped file is brought into view: ' + Math.round(r.top) + ' to ' + Math.round(r.bottom) + ' of ' + innerHeight, r.top >= -1 && (r.bottom <= innerHeight + 1 || r.top < innerHeight / 2));
        // The list scrolled back to where the file starts in sight: a tap there leaves it where it is.
        const prev = document.querySelectorAll('#inspFileList .inspfile')[18];
        prev.scrollIntoView({ block: 'center' });
        const at = body.getBoundingClientRect().top, shown = Math.min(inspectDlg.getBoundingClientRect().bottom, innerHeight);
        ok('the file starts in sight: ' + Math.round(at) + ' of ' + Math.round(shown), at > 0 && at < shown - 48);
        prev.click();
        await until(() => body.textContent.includes('Library books'));
        ok('a tap with the file in sight scrolls nothing: ' + Math.round(at) + ' then ' + Math.round(body.getBoundingClientRect().top), Math.abs(body.getBoundingClientRect().top - at) <= 1);
      } finally {
        try { inspectDlg.close(); } catch {}
        delete window.__override['/v1/agents/a1/inspect'];
        for (const f of files.slice(18)) delete window.__override['/v1/agents/a1/inspect/file/' + encodeURIComponent(f.name)];
      }
    },
    phoneEveryScreenFits: async () => {
      // The owner's review of phone widths (2026-11-08, HB-0605 to HB-0615), kept: every home view, agent tab,
      // Settings tab and dialog, opened on a phone with fuller data than the deck's, its names from the deck's
      // invented household (members, tasks, files, an Inbox share, a long agent name, costs and the wide tables). Each must fit: nothing past the
      // screen's edge and no sideways scroll (a row of tabs scrolls on purpose), no words spilling out of their
      // box or squeezed into a narrow column beside something, no dropdown or text box narrower than its line
      // while its own words are cut, no two-word button broken over two lines, no chart text under 10 px.
      ok('a phone-wide window: ' + innerWidth, innerWidth <= 420);
      const W = innerWidth, H = 3600e3, now = Date.now(), iso = (m) => new Date(now - m * 60000).toISOString(), month = new Date().toISOString().slice(0, 7);
      // The dialogs slide in (v2slide, 24 px over 0.18 s): caught mid-slide, a dialog reads as past the edge.
      const still = document.createElement('style');
      still.textContent = '*, *::before, *::after { animation:none !important; transition:none !important }';
      document.head.appendChild(still);
      const fleet = await (await fetch('/v1/agents')).json();
      const long = Object.assign({}, fleet[0], { id: 'a15', name: 'Home Maintenance, Garden Notes and Car Upkeep', slug: 'home-maintenance-garden-notes-and-car-upkeep', icon: '🔧', group: 'Household', botUsername: 'HomeMaintenanceAndGardenNotesBot' });
      // A folder and a writable repo with its deploy key (the Data tab): a path beside three and four buttons.
      const withData = Object.assign({}, fleet[0], { dataSources: [
        { id: 'd1', kind: 'folder', access: 'ro', mountName: 'reading-lists', hostPath: '/home/you/Documents/Homework Helper/reading-lists' },
        { id: 'g1', kind: 'git', access: 'rw', mountName: 'homework-helper', repoUrl: 'git@github.com:you/homework-helper.git', pubKey: 'ssh-ed25519 AAAAC3made-up-key-for-the-test test' }] });
      const task = { id: 'c8', name: 'Pre-market briefing', scheduleKind: 'cron', scheduleExpr: '0 8 * * 1-5', scheduleTz: 'UTC', enabled: true, payloadKind: 'agentTurn', message: 'Post the pre-market briefing', lastStatus: 'ok', consecutiveErrors: 0, lastRunAtMs: now - H };
      const price = (id, label, input, extra) => Object.assign({ id, label, input, output: input * 5, cacheRead: input / 10, cacheWrite: input * 1.25, cacheReadShare: 0.1 }, extra || {});
      const ctx = (id, agent, mainNowK, extra) => Object.assign({ id, agent, model: 'anthropic/claude-sonnet-5', state: 'running', billing: 'api', conversation: { mainNowK, windowK: 200, mainAt: iso(22), ctxK: { p50: Math.round(mainNowK / 2), p90: mainNowK }, calls: 402 } }, extra || {});
      const O = {
        '/v1/agents': [withData].concat(fleet.slice(1, 3), [long], fleet.slice(3)),
        '/v1/inbox': { shares: [{ id: 'sh1', agentName: 'Meal Planner', fromEmail: 'you+meal.planner.family.recipes@example.com', createdAt: iso(90), message: 'Here are all the family recipes, with the Sunday roast one at the top' }] },
        '/v1/agents/a1/members': [
          { userId: 'o1', role: 'owner', status: 'active', channelUserId: '11', identities: {}, account: true, webChat: false },
          { userId: 'user-rfc', displayName: 'Soccer Schedule for Rivergate FC and Family HQ', role: 'user', status: 'active', channelUserId: '12', identities: {}, account: true, webChat: false },
          { userId: 'user-hq', displayName: 'Family HQ', role: 'user', status: 'active', identities: {}, account: true, webChat: true },
          { userId: 'member-1', displayName: 'Rivergate FC', role: 'user', status: 'active', channelUserId: '13', identities: {}, account: false, webChat: false }],
        '/v1/agents/a1/crons': { crons: [task, Object.assign({}, task, { id: 'c9', name: 'Weekly homework round-up for the whole family' })], waiting: [], notes: ['c8'], noteReach: true },
        '/v1/agents/a1/access': accOv(),
        '/v1/agents/a1/fs': { path: '', entries: [
          { name: 'memory', type: 'dir', size: 0, mtime: iso(60) },
          { name: 'homework-plan-for-the-autumn-term-2026-with-reading-list.md', type: 'file', size: 18234, mtime: iso(90) },
          { name: 'AGENTS.md', type: 'file', size: 4210, mtime: iso(600) },
          { name: 'notes.txt', type: 'file', size: 10, mtime: iso(3000) }] },
        '/v1/agents/a1/connections': { accounts: [
          { email: 'you@example.com', client: 'default', auth: 'oauth', services: ['gmail', 'calendar', 'drive'] },
          { email: 'you+family.calendar.shared@example.com', client: 'default', auth: 'oauth', services: ['calendar'] }] },
        '/v1/agents/a1/snapshots': [{ id: 's1', label: 'Before the new persona', createdAt: iso(1440), size: 120000 }, { id: 's2', label: 'Weekly', createdAt: iso(10080), size: 118000 }],
        '/v1/agents/a1/peers': { peers: [{ id: 'a4', name: 'Meal Planner' }], candidates: [{ id: 'a2', name: 'Soccer Schedule' }, { id: 'a8', name: 'Budget Tracker' }] },
        '/v1/agents/a1/logs': { text: '2026-11-08T10:01:02.123Z [gateway] listening on ws://0.0.0.0:18789 (auth=token, trusted-proxy=on, telegram=polling)\n2026-11-08T10:01:09.881Z [agent] turn done in 4.2s, 12,345 tokens in, 345 out' },
        '/v1/agents/a1/events': { events: [{ at: iso(5), label: 'Rebuilt', note: 'image ghcr.io/hatchabot/runtime:2026.9.8-1 with the shared embedding service; Telegram polling; 3 apps' }, { at: iso(60), label: 'Model changed', note: 'anthropic/claude-sonnet-5' }] },
        '/v1/agents/a1/inspect': { files: [{ name: 'MEMORY.md', bytes: 2100 }, { name: 'AGENTS.md', bytes: 4210 }, { name: 'USER.md', bytes: 800 }, { name: 'memory/2026-11-07.md', bytes: 5300 }], transcriptTurns: 42 },
        '/v1/agents/a1/inspect/file/MEMORY.md': { content: '# Memory\n\n- Homework is due on Thursdays; the maths teacher wants working shown.\n- Reading list for the autumn term is in homework-plan.md.\n- Prefers short answers with one worked example.' },
        '/v1/problem-reports': [{ id: 'r1', title: 'Telegram replies stop after the agent has been running for about a day', createdAt: iso(30), by: 'agent' }, { id: 'r2', title: 'Rebuild failed', createdAt: iso(3000), sentAt: iso(2900), issueUrl: 'https://github.com/hatchabot/hatchabot/issues/12' }],
        // Long versions beside the capabilities' names (Settings → Advanced): a long name ("Google Workspace") painted over its own.
        '/v1/runtime/capabilities': { tools: { openclaw: '2026.9.8-candidate.20261107.1', 'claude-code': '2.1.300', gog: '0.9.1-candidate.20261107.1', python: '3.12.3', git: '2.43.0', node: '22.11.0' }, missing: ['ffmpeg', 'chromium'] },
        '/v1/rebuild-policy': { policy: 'required-only', quietHours: '1-6' },
        '/v1/rebuild-concurrency': { max: 6, atOnce: 2 },
        '/v1/budgets': { month, tz: 'UTC', agents: [{ id: 'a1', name: 'Homework Helper', state: 'RUNNING', billing: 'api', spent: 12, lastMonth: 10, monthlyNow: 14, suggested: 20,
          alertEvery: { every: 5, month, spent: 12, passed: 2, next: 15 }, budget: { scope: 'a1', usd: 20, atLimit: 'warn', month, spent: 12, pct: 60, level: 0, resetsOn: 'next 1st' } }] },
        '/v1/model-prices': { models: [price('claude-opus-4-8', 'Claude Opus 4.8', 5), price('claude-sonnet-5', 'Claude Sonnet 5', 2), price('claude-haiku-4-5', 'Claude Haiku 4.5', 1, { legacy: true })],
          cacheReadDefault: 0.1, cacheWrite: 1.25, checked: '2026-11-01', source: 'https://example.com/pricing', unpriced: [] },
        // Soccer Schedule's conversation has no time read: its last cell is empty.
        '/v1/token-health': { rows: [ctx('a8', 'Budget Tracker', 118), ctx('a4', 'Meal Planner', 71, { contextCap: { tokens: 150000, applied: true } }), ctx('a1', 'Homework Helper', 46),
          ctx('a2', 'Soccer Schedule', 30, { conversation: { mainNowK: 30, windowK: 200, calls: 3 } })] },
        '/v1/usage/periods': { period: 'day', buckets: [], agents: [], totals: { tokens: 0, requests: 0, limited: 0, failed: 0 }, alerts: [],
          rightSize: { savingUSD: 11.2, apiUSD: 11.2, planUSD: 0, month, rows: [{ agent: 'Budget Tracker', from: 'anthropic/claude-opus-4-8', to: 'anthropic/claude-sonnet-5', since: iso(9 * 1440), isUSD: 8.4, wasUSD: 19.6, savingUSD: 11.2, billing: 'api' }] } },
        '/v1/usage/spend': { range: 'week', bucketHours: 3, planShare: 0, monthly: 340, refused: 0, models: [{ model: 'claude-sonnet-5', cost: 80 }],
          choices: [{ id: 'a1', name: 'Homework Helper', cost: 60 }, { id: 'a2', name: 'Soccer Schedule', cost: 20 }],
          buckets: Array.from({ length: 56 }, (_, i) => ({ at: new Date(now - (56 - i) * 3 * H).toISOString(), cacheWrite: 1, cacheRead: 0.2, output: 0.2, input: 0.03, tokens: 2e6 })),
          totals: { cacheWrite: 56, cacheRead: 11, output: 11, input: 2, cost: 80, tokens: 112e6 } },
      };
      const before = Object.assign({}, window.__override), confirmed = window.__confirmAnswer;
      Object.assign(window.__override, O);
      window.__confirmAnswer = false;
      const screens = [];
      const add = (label, open) => screens.push([label, open]);
      // A screen is ready when nothing on the page has changed for 150 ms (3 s at most: a ticking clock never rests).
      const quiet = (ms = 150, most = 3000) => new Promise((resolve) => {
        let rest = 0, cap = 0;
        const o = new MutationObserver(() => { clearTimeout(rest); rest = setTimeout(done, ms); });
        function done() { o.disconnect(); clearTimeout(rest); clearTimeout(cap); resolve(); }
        o.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        rest = setTimeout(done, ms); cap = setTimeout(done, most);
      });
      const drawers = (sel) => { for (const d of document.querySelectorAll(sel + ' details')) d.open = true; };
      add('home', () => {});
      for (const [k] of V2_VIEWS) add('home by ' + k, () => v2SetView(k));
      add('the account menu', () => { v2SetView('group'); v2ToggleAccount(true); });
      for (const [k] of V2_TABS) add('agent ' + k, () => openV2Agent('a1', k));
      for (const [k] of V2_TABS) add('agent ' + k + ', drawers open', async () => { openV2Agent('a1', k); await quiet(); drawers('#v2AgentDlg'); });
      for (const k of ['overview', 'ai', 'messaging', 'advanced']) add('the Hatchabot agent ' + k, () => openV2Agent('a14', k));
      for (const k of ['overview', 'messaging', 'sharing']) add('a long-named agent ' + k, () => openV2Agent('a15', k));
      add('a stopped agent', () => openV2Agent('a10', 'overview'));
      add('a Discord agent', () => openV2Agent('a2', 'channels'));
      add('a Slack agent', () => openV2Agent('a7', 'slack'));
      for (const [k] of V2_SETTINGS) add('Settings ' + k, () => openAiDlg(k));
      for (const [k] of V2_SETTINGS) add('Settings ' + k + ', drawers open', async () => { await openAiDlg(k); await quiet(); drawers('#aiDlg'); });
      // An AI source's cost chart drawn while another Settings tab showed (it measured 0 wide), then shown.
      // A chart's own width (its viewBox), and the width of the box its picture sits in.
      const chartW = (box) => box.querySelector('.spendsvg svg').viewBox.baseVal.width;
      const picW = (box) => box.querySelector('.spendsvg').clientWidth;
      // A box narrowed by so many px (as a phone turned, a window dragged), or back (0), and the two frames it takes.
      const narrow = (box, by) => { box.style.width = by ? (box.clientWidth - by) + 'px' : ''; window.__frame(); window.__frame(); };
      add('Settings ai, its chart drawn while hidden', async () => {
        await openAiDlg('people'); await quiet();
        const box = document.querySelector('#aiDlg .spendchart');
        ok('the chart was drawn while hidden', !!box.querySelector('.spendsvg svg') && !box.clientWidth);
        window.__frame();
        const before = box.querySelector('.spendsvg svg'), pills = box.querySelector('.su-periods');
        showTab('ai');
        // Two frames (window.__frame, the RECORDER's): in the first, spendChartFit (a ResizeObserver)
        // hears the box has a width now; in the next, the chart is fitted to it.
        window.__frame(); window.__frame();
        // Drawn at the width it shows at: its own width (viewBox) is the width it is shown at, which fills the box it sits in.
        const svg = box.querySelector('.spendsvg svg'), drawn = svg.viewBox.baseVal.width, at = svg.getBoundingClientRect().width;
        ok('drawn again at its width once shown: drawn ' + drawn + ', shown at ' + Math.round(at) + ' in a box of ' + svg.parentElement.clientWidth,
          svg !== before && Math.abs(drawn - at) < 1 && Math.abs(at - svg.parentElement.clientWidth) < 1);
        ok('only its picture drawn again: the range buttons are the ones it had', box.querySelector('.su-periods') === pills);
        // Hidden again, its box narrowed meanwhile: fitted to its new width once shown.
        const was = box.clientWidth;
        showTab('people'); window.__frame(); window.__frame();
        box.style.width = (was - 10) + 'px';
        showTab('ai'); window.__frame(); window.__frame();
        const then = chartW(box), room = picW(box);
        narrow(box, 0);
        ok('a change made while hidden is fitted once shown: ' + then + ' in ' + room + ', then ' + chartW(box), then === room && then < drawn && chartW(box) === drawn);
      });
      add('Settings ai, drawn three times: only the charts on the page watched', async () => {
        await openAiDlg('people'); await quiet();
        for (let i = 0; i < 3; i++) { renderAiList(); await quiet(); }
        const live = [...document.querySelectorAll('#aiDlg .spendchart')].filter((el) => el._spend), seen = [...spendChartsSeen];
        ok('three drawings leave only the charts on the page watched: ' + seen.length + ' watched, ' + live.length + ' in Settings, ' + seen.filter((el) => !el.isConnected).length + ' gone',
          live.length > 0 && seen.every((el) => el.isConnected) && live.every((el) => spendChartsSeen.has(el)));
      });
      add('Usage, its agent picker open as its chart narrows', async () => {
        openFleetUsage();
        const box = await until(() => document.querySelector('#fleetUsageDlg .spendchart .spendpick')?.closest('.spendchart')), pick = box.querySelector('.spendpick');
        pick.open = true;
        const phoneW = box._spend.W;
        narrow(box, 60);
        const less = chartW(box), room = picW(box);
        narrow(box, 0);
        ok('drawn to its box as it narrows, and back: ' + less + ' in ' + room + ', then ' + chartW(box), less === room && less < phoneW && chartW(box) === phoneW);
        ok('the agent picker stayed open through both', box.querySelector('.spendpick') === pick && pick.open);
        pick.open = false;
        // Closed, its chart is let go: no longer watched, its read dropped. A browser fires the dialog's close
        // event as it closes; headless Chrome under virtual time never does (2026-11-08), so it is fired here.
        fleetUsageDlg.close(); fleetUsageDlg.dispatchEvent(new Event('close'));
        ok('its chart let go once the dialog closed', !spendChartsSeen.has(box) && !box._spend);
        // Opened again: until its new chart is drawn, no old one (it would no longer fit the window) but Loading….
        openFleetUsage();
        ok('opened again, it shows no old chart while it loads: ' + box.textContent.trim().slice(0, 40), !fleetUsageDlg.querySelector('.spendchart .spendsvg') && /Loading/.test(box.textContent));
        // Its new chart is drawn and watched, and a close event come late (the dialog open again by then)
        // leaves it so: it still follows the window past 640 px.
        const again = await until(() => { const el = document.querySelector('#fleetUsageDlg .spendchart'); return el !== box && el?.querySelector('.spendsvg svg') && el; });
        ok('drawn and watched again when opened again', !!again._spend && spendChartsSeen.has(again));
        fleetUsageDlg.dispatchEvent(new Event('close'));
        window.__frame();
        narrow(again, 60);
        const lessAgain = chartW(again), roomAgain = picW(again);
        narrow(again, 0);
        ok('a close event come late leaves the new chart watched and fitted: ' + lessAgain + ' in ' + roomAgain + ', then ' + chartW(again),
          spendChartsSeen.has(again) && !!again._spend && lessAgain === roomAgain && lessAgain < phoneW && chartW(again) === phoneW);
      });
      add('New agent', () => document.getElementById('fabBtn').click());
      add('New agent from a repo', () => openAppDlg('create'));
      add('Adopt', () => openAdoptDlg());
      add('Inbox', () => openInbox());
      add('Consoles', () => openConsoleHome(true));
      add('Usage', () => openFleetUsage());
      add('Resources', () => openFleetResources());
      add('Bulk actions', () => openFleetActions());
      add('Setup guide', () => openSetupGuide());
      add('Help', () => helpDlg.showModal());
      add('Report a problem', () => openReport());
      add('Report a problem for an agent', () => openReport('a1'));
      add('templates', () => openGallery());
      add('an agent\'s usage', () => openUsage('a1', 'Homework Helper'));
      add('logs', () => openLogs('a1', 'Homework Helper'));
      add('Setup log', () => openSetupLog('a1', 'Homework Helper'));
      add('the archive inspector', () => openInspect('a1', 'Homework Helper'));
      add('proposals', () => openProposals('a1', 'Homework Helper'));
      add('Audit log', () => openAudit('a1'));
      add('Send', () => openSendAgent('a1', 'Homework Helper'));
      add('move its source', () => openMigrate('a1', 'Homework Helper'));
      add('Archive', () => archiveAgent('a1', 'Homework Helper', 'RUNNING'));
      add('Invite', () => invite('a1', 'Homework Helper'));
      add('web chat', () => openWebChatPanel('a1'));
      add('Discord setup', () => openChanSetup('a1', 'discord'));
      add('Slack setup', () => openChanSetup('a1', 'slack'));
      add('icon', () => openV2Icon('a1'));
      add('apply a model', () => openApplyModel('p1', 'claude-sonnet-5', [], agents.filter((a) => !a.ops), 'Anthropic API (household)'));
      add('move agents to a source', () => moveAgentsToSource('p1', 'Anthropic API (household)'));
      add('try an image', () => tryOnAgent('2026.9.8'));
      add('a choice', () => { void askChoice('Rebuild now?', 'Three agents are running. Rebuild them now, or when each next starts?', [['now', 'Rebuild now'], ['later', 'When they next start'], ['cancel', 'Cancel']]); });
      add('a second factor', () => { void askSecondFactor('totp'); });
      add('backup codes', () => showBackupCodes(['abcd-efgh', 'ijkl-mnop', 'qrst-uvwx', 'yzab-cdef', 'ghij-klmn', 'opqr-stuv', 'wxyz-abcd', 'efgh-ijkl'], 'o1'));
      add('a recovery code', () => showRecoveryCode('ABCD-EFGH-IJKL-MNOP-QRST', 'Keep this code somewhere safe.', 'o1'));
      add('setup fields', () => { void collectParamValues([{ name: 'CITY', label: 'Your city', required: true }, { name: 'UNITS', label: 'Units', choices: ['metric', 'imperial'] }], 'Weather app'); });
      add('sign-in', () => loginDlg.showModal());
      add('install', () => installDlg.showModal());
      const say = (el) => {
        const what = el.tagName.toLowerCase() + (el.id ? '#' + el.id : el.classList.length ? '.' + [...el.classList].slice(0, 2).join('.') : '');
        const words = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32);
        return what + (words ? ' "' + words + '"' : '');
      };
      const shown = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      const scroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const ox = getComputedStyle(p).overflowX; if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth + 1) return p; } return null; };
      // A row of tabs scrolls sideways on purpose (the agent's, Settings', a dialog's, the consoles').
      const tabRow = (sc) => !!sc && (sc.getAttribute('role') === 'tablist' || sc.matches('.tabs, .v2tabs, .ctabs'));
      const pen = document.createElement('canvas').getContext('2d');
      const px = (cs, k) => parseFloat(cs[k]) || 0;
      const check = (label) => {
        const found = [], tell = (what) => found.push([what, label]);
        if (document.documentElement.scrollWidth > W) tell('the page scrolls sideways (' + document.documentElement.scrollWidth + ' px wide)');
        const open = [...document.querySelectorAll('dialog[open]')];
        const top = open.length ? open[open.length - 1] : document.body;
        const past = new Set();
        for (const el of top.querySelectorAll('*')) {
          if (/^(SCRIPT|STYLE|OPTION|BR|TEMPLATE)$/.test(el.tagName) || el.closest('svg')) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || !shown(el)) continue;
          const cs = getComputedStyle(el);
          if (r.right > W + 1 || r.left < -1) {
            past.add(el);
            const sc = scroller(el);
            if (!past.has(el.parentElement) && !tabRow(sc)) tell(say(el) + ' runs past the screen [' + Math.round(r.left) + ', ' + Math.round(r.right) + ']' + (sc ? ', scrolling ' + say(sc).slice(0, 40) + ' sideways' : ''));
            continue;
          }
          const textHere = [...el.childNodes].some((n) => n.nodeType === 3 ? n.textContent.trim() : n.nodeType === 1 && getComputedStyle(n).display === 'inline' && n.textContent.trim());
          // Words beside something, squeezed into a column a few words wide.
          if (textHere && cs.display !== 'inline' && r.width < W * 0.4 && el.textContent.trim().length >= 30) {
            const lh = px(cs, 'lineHeight') || px(cs, 'fontSize') * 1.25;
            const lines = ((/auto|scroll/.test(cs.overflowY) ? el.scrollHeight : el.clientHeight) - px(cs, 'paddingTop') - px(cs, 'paddingBottom')) / lh;
            if (lines >= 3.6) tell(say(el) + ' is squeezed into ' + Math.round(r.width) + ' px, ' + Math.round(lines) + ' lines');
          }
          // Words spilling out of their own box, over whatever is beside it.
          if (textHere && !/^(SELECT|INPUT|TEXTAREA|PRE|CODE|TABLE|DIALOG|IMG|CANVAS)$/.test(el.tagName) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 3 && cs.overflowX === 'visible' && !scroller(el)) tell(say(el) + ' spills out of its box (' + el.scrollWidth + ' px in ' + el.clientWidth + ')');
          // Cut off with no ellipsis (a clamp to so many lines ends in one: a tile's name).
          if (/^(BUTTON|A|LABEL|SPAN|TH|TD|SUMMARY)$/.test(el.tagName) && /hidden|clip/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis' && cs.webkitLineClamp === 'none') tell(say(el) + ' is cut off');
          // A column's name over nothing (a wide table's card rows on a phone): an empty cell is left unnamed.
          if (el.tagName === 'TD' && el.dataset.label && !el.textContent.trim() && !el.children.length) tell(say(el) + ' names its column "' + el.dataset.label + '" over nothing');
          // A two-word button ("1 hr") broken over two lines.
          if (el.tagName === 'BUTTON' && !el.children.length && /^\S+ \S+$/.test(el.textContent.trim()) && el.textContent.trim().length <= 12 && el.clientHeight - px(cs, 'paddingTop') - px(cs, 'paddingBottom') > (px(cs, 'lineHeight') || px(cs, 'fontSize') * 1.25) * 1.6) tell(say(el) + ' is broken over two lines');
          // A dropdown narrower than its line while its own choice is cut.
          if (el.tagName === 'SELECT' && el.selectedIndex >= 0) {
            const words = el.options[el.selectedIndex].text;
            pen.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
            const need = pen.measureText(words).width + px(cs, 'paddingLeft') + px(cs, 'paddingRight') + 18;
            const ps = getComputedStyle(el.parentElement), line = el.parentElement.clientWidth - px(ps, 'paddingLeft') - px(ps, 'paddingRight');
            if (words && need > r.width + 4 && r.width < line - 8) tell(say(el).slice(0, 40) + ' shows "' + words.slice(0, 24) + '" in ' + Math.round(r.width) + ' px of the ' + Math.round(need) + ' it needs, with ' + Math.round(line) + ' on its line');
          }
          // A text box beside its label's words, not under them as the other fields are.
          if (el.tagName === 'INPUT' && /^(text|search|email|url|password)$/.test(el.type) && el.parentElement.tagName === 'LABEL' && el.previousSibling?.nodeType === 3 && el.previousSibling.textContent.trim()
            && r.left > el.parentElement.getBoundingClientRect().left + 20) tell(say(el) + ' sits beside its label, ' + Math.round(r.width) + ' px wide');
        }
        for (const t of top.querySelectorAll('svg text')) {
          const m = t.getScreenCTM();
          if (!m || !t.getBoundingClientRect().width || !shown(t)) continue;
          const size = px(getComputedStyle(t), 'fontSize') * Math.hypot(m.a, m.b);
          if (size < 9.95) tell('chart text "' + t.textContent.trim().slice(0, 24) + '" is ' + size.toFixed(1) + ' px high');
        }
        for (const d of open) {
          const r = d.getBoundingClientRect();
          if (r.right > W + 1 || r.left < -1 || (r.bottom > innerHeight + 1 && !/auto|scroll/.test(getComputedStyle(d).overflowY))) tell('the dialog ' + say(d).slice(0, 30) + ' does not fit the screen');
        }
        return found;
      };
      const putAway = async () => {
        try { v2ToggleAccount(false); } catch {}
        for (const d of [...document.querySelectorAll('dialog[open]')].reverse()) { try { d.close(); } catch {} }
        try { v2Close(); } catch {}
        scrollTo(0, 0);
        await quiet(50);
      };
      const problems = new Map(), note = (what, label) => problems.set(what, (problems.get(what) || []).concat([label]));
      const opening = [];
      try {
        await refresh(false);
        await until(() => !document.getElementById('v2InboxBtn').hidden && tile('Garden Notes and Car Upkeep'));
        for (const [label, open] of screens) {
          // Ready: the opener is done (or 3 s on), then the page is quiet. An opener that fails later
          // than that is still told, with its screen's name (it is caught whenever it fails).
          const run = Promise.resolve().then(open);
          opening.push(run.catch((e) => note('would not open: ' + String(e && e.message || e).slice(0, 120), label)));
          await Promise.race([run.catch(() => {}), sleep(3000)]);
          await quiet();
          try { for (const [what] of check(label)) note(what, label); } catch (e) { note('could not be checked: ' + String(e && e.message || e).slice(0, 120), label); }
          await putAway();
        }
        await Promise.race([Promise.all(opening), sleep(3000)]);
      } finally {
        await putAway();
        for (const k of Object.keys(O)) { if (k in before) window.__override[k] = before[k]; else delete window.__override[k]; }
        window.__confirmAnswer = confirmed;
        v2SetView('group');
        still.remove();
        v2AccessCache = null;
        await refresh(false);
      }
      // Each problem once, with the screens it was seen on.
      const list = [...problems].map(([what, on]) => what + ' (' + (on.length > 3 ? on.length + ' screens: ' + on.slice(0, 3).join(', ') + '…' : on.join(', ')) + ')');
      if (list.length) {
        const err = new Error(list.length + ' things do not fit a ' + W + ' px phone; the first: ' + list.slice(0, 2).join(' · '));
        err.detail = list.join('\n');
        throw err;
      }
    },
  };
  (async () => {
    // The results so far go on the page after every scenario, with the one running: a page
    // that runs out of virtual time (Chrome's dump comes with no answer) still says where.
    const report = () => document.documentElement.setAttribute('data-ui-results', JSON.stringify(results));
    for (const [name, run] of Object.entries(innerWidth <= 500 ? P : T)) {
      document.documentElement.setAttribute('data-ui-running', name);
      try { await run(); results.push({ name, ok: true }); }
      // A check that finds many things (the phone sweep) says them all in err.detail.
      catch (err) { results.push(Object.assign({ name, ok: false, error: String(err && err.message || err).slice(0, 300) }, err && err.detail ? { detail: String(err.detail).slice(0, 20000) } : {})); }
      report();
    }
    document.documentElement.removeAttribute('data-ui-running');
    document.documentElement.setAttribute('data-ui-done', String(Math.round(performance.now() / 1000)));
    document.title = 'UI-DONE';
  })();
})();`;

// The checks are a string run in the page: a syntax error there (a merge once
// dropped a closing brace) made Chrome report nothing at all. Say which line.
try { new Function(SCENARIOS); } catch (err) {
  console.error(`The click-through checks don't parse: ${err.message}`);
  process.exit(1);
}

// Two scenarios with one name: the object literal keeps only the last, and
// the first never runs — say so instead (2026-10-09).
{
  const names = [...SCENARIOS.matchAll(/^    ([A-Za-z0-9_]+): async/gm)].map((m) => m[1]);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length) { console.error(`two scenarios are called ${[...new Set(twice)].join(', ')}: rename one`); process.exit(1); }
}
const work = mkdtempSync(join(tmpdir(), 'hb-ui-'));
try {
  // hb-ui=classic and ?ui=classic (below): opened as a browser that had chosen the classic look (scenario classicMap).
  const head = `<head><script>localStorage.setItem('theme','light'); localStorage.setItem('hb-ui','classic')</script><script>${STUB.replace('__VERSION__', version)}</script><script>${RECORDER}</script><script>window.__joinPage = ${joinPage}</script>`;
  const tail = `<script>setTimeout(() => { ${SCENARIOS} }, 2500)</script></body>`;
  // Replacer functions: a bare string is a pattern to replace(), and `$'` inside the scenarios meant "the rest of the page".
  writeFileSync(join(work, 'page.html'), page.replace('<head>', () => head).replace('</body>', () => tail));
  // Chrome's container runs as its own user (uid 1000); a private temp folder
  // owned by another uid (GitHub's runner is 1001) left it a blank page, and
  // "the page never reported" (2026-10-09). The page holds only test data.
  chmodSync(work, 0o755);
  chmodSync(join(work, 'page.html'), 0o644);
  // The page is opened three times: a desktop window runs the suite, and two
  // phone-wide ones run the checks of what has to fit a phone screen (the P
  // suite, picked by the window's width; Chris, 2026-10-23): 360 px, most
  // Android phones (the header with Inbox broke there only, HB-0605), and
  // 390 px, an iPhone (HB-0615 asked for both).
  let failed = 0, total = 0;
  for (const [label, size] of [['desktop', '1400,1000'], ['phone 360', '360,800'], ['phone 390', '390,844']]) {
    let dom = '';
    // The attribute, not the words: the page's own script names it too.
    for (let tries = 1; !/data-ui-done="/.test(dom) && tries <= 3; tries++) {
      try {
      // Virtual time, 2 h of it: Chrome fast-forwards it while the page waits
      // on real work (a blob read, a decompression), by minutes a time while a
      // timer is pending (measured 2026-10-23) — 30 min ran out on the dev
      // runner, and the page reported nothing (also seen 2026-10-09). A page
      // that still runs out names the scenario it was on (data-ui-running).
        dom = execFileSync(CONTAINER_CLI, [
          'run', '--rm', '--shm-size=1g', '-v', `${work}:/w`, CHROME_IMAGE,
          '--no-sandbox', '--headless', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
          `--window-size=${size}`, '--virtual-time-budget=7200000', '--dump-dom', 'file:///w/page.html?ui=classic',
        ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
      } catch (err) { dom = String(err.stdout ?? ''); }
    }
    if (keep) writeFileSync(join(work, `dom-${label.replace(' ', '-')}.html`), dom);
    const m = /data-ui-results="([^"]*)"/.exec(dom);
    if (!m) throw new Error(`the page never reported (no data-ui-results in the ${label} DOM dump${keep ? `; see ${work}/dom-${label.replace(' ', '-')}.html` : '; run with --keep'})`);
    const results = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); // &amp; last: an unescape in the other order turns "&amp;lt;" into "<" (CodeQL js/double-escaping)
    const done = /data-ui-done="(\d+)"/.exec(dom);
    const running = /data-ui-running="([^"]*)"/.exec(dom);
    const on = label === 'desktop' ? '' : ` (${label})`;
    if (!done) { failed++; total++; console.log(`✗ ${running?.[1] ?? '(unknown)'}${on} — the page ran out of virtual time on it (${results.length} scenarios reported before it)`); }
    else if (done[1] > 3600) console.log(`(the ${label} run used ${done[1]} s of its 7200 s of virtual time)`);
    for (const r of results) {
      total++;
      if (r.ok) console.log(`✓ ${r.name}${on}`);
      else { failed++; console.log(`✗ ${r.name}${on} — ${r.error}${r.detail ? `\n    ${r.detail.split('\n').join('\n    ')}` : ''}`); }
    }
  }
  console.log(`${total - failed}/${total} passed${keep ? ` · kept ${work}` : ''}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true });
}
