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
 * Needs docker (headless Chrome runs in a throwaway container, as the
 * screenshots do). Results travel out of the page as a data attribute on
 * <html>, read from Chrome's --dump-dom.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUB } from '../docs/deck/shot-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const icon = `data:image/png;base64,${readFileSync(join(root, 'web', 'icons', 'icon-192.png')).toString('base64')}`;
const page = readFileSync(join(root, 'web', 'index.html'), 'utf8').replaceAll('src="/icons/icon-192.png"', `src="${icon}"`);

/** Wraps the stub's fetch: records every call, lets a scenario override any GET, answers mutations. */
const RECORDER = `(() => {
  const stubFetch = window.fetch;
  window.__calls = []; window.__override = {}; window.__confirms = []; window.__confirmAnswer = true; window.__movedResult = true;
  window.fetch = async (input, init = {}) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const path = url.split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    let body; try { body = init.body ? JSON.parse(init.body) : undefined; } catch { body = init.body; }
    window.__calls.push({ method, path, url, body });
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    // Scripted answers: window.__answer['POST /v1/x'] = [{ status, body }, …], taken in order.
    const q = (window.__answer || {})[method + ' ' + path];
    if (q && q.length) { const a = q.shift(); return json(a.body ?? {}, a.status ?? 200); }
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
})();`;

/** The scenarios run inside the page once it has painted. Each is a name and an async body; \`t\` is the toolkit. */
const SCENARIOS = String.raw`(() => {
  const results = [];
  // Checks refresh by hand; a timed poll mid-check made the suite flaky under load.
  window.__noAutoPoll = true; clearTimeout(pollTimer);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 8 s: a condition that holds returns at once; a slow run of headless Chrome
  // (it happens) used to fail checks that were only late.
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
      window.__override['/v1/backups'] = { backups: [{ date: new Date(now - 5 * 864e5).toISOString().slice(0, 10), hasKey: true, complete: true }], keepDays: 14, missing: [] };
      window.__override['/v1/runtime'] = { imageVersion: '2026.9.6', upgradeAvailable: false };
      const owner = myAccount.hostOwner; myAccount.hostOwner = true;
      try {
        await v2LoadActivity(true); await v2LoadMachine(true);
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
        $('reportBody').value = 'edited';
        byText('#reportReview button', 'Open on GitHub').click();
        await until(() => calls('POST', /\/sent$/).length);
        eq('the edit is saved before anything leaves', calls('PATCH', /^\/v1\/problem-reports\//).at(-1).body, { title: 'Rebuild fails', body: 'edited' });
        ok('GitHub opened in a new tab, without a way back to this page', opened.length === 1 && opened[0].location.href.startsWith('https://github.com/hatchabot/hatchabot/issues/new') && opened[0].opener === null);
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
    archiveClosesItsConsole: async () => {
      const list = await (await fetch('/v1/agents')).json();
      const hw = list.find((a) => a.id === 'a1');
      try {
        consoleTabs.push({ id: 'a1', slug: hw.slug, frame: null, url: null });
        openV2Agent('a1', 'advanced');
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
        openV2Agent('a1', 'advanced');
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
      window.__crons = [{ id: 'c1', name: 'Morning brief', scheduleExpr: '0 8 * * *', scheduleTz: 'America/Toronto', message: 'Good morning', enabled: true, payloadKind: 'message' }];
      openV2Agent('a1', 'schedule');
      await until(() => cronCache.some((c) => c.id === 'c1'));
      editCronJob('c1');
      eq('the form carries the task', [document.getElementById('cronName').value, document.getElementById('cronExpr').value, document.getElementById('cronMsg').value], ['Morning brief', '0 8 * * *', 'Good morning']);
      ok('the button says it replaces', document.getElementById('cronAddBtn').textContent.includes('Save changes'));
      const cancelBtn = document.querySelector('#cronEditNote button');
      ok('"cancel" is a real button a keyboard reaches (review, 2026-10-09)', !!cancelBtn && cancelBtn.type === 'button' && cancelBtn.textContent === 'cancel' && !document.querySelector('#cronEditNote a'));
      document.getElementById('cronName').value = 'Morning brief 2';
      document.getElementById('cronAddBtn').click();
      const posted = await until(() => calls('POST', /\/v1\/agents\/a1\/crons$/)[0]);
      ok('the edited task is sent', posted.body.name === 'Morning brief 2' && posted.body.cron === '0 8 * * *');
      v2Close(); window.__crons = [];
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
      editAgentId = 'a1';
      await loadSnapshots();
      const btn = await until(() => [...document.querySelectorAll('#snapList button')].find((b) => b.textContent === 'Revert'));
      const asked = window.__confirms.length;
      btn.click();
      await until(() => document.getElementById('editErr').textContent.includes('nothing was changed'));
      ok('it asked first, and says MEMORY goes back too', window.__confirms.length === asked + 1 && /MEMORY/.test(window.__confirms.at(-1)));
      btn.click();
      await until(() => document.getElementById('toast').textContent.includes('Reverted SOUL.md'));
      eq('two restore calls', calls('POST', /\/snapshots\/s1\/restore$/).length, 2);
      window.__answer = {};
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
      v2PropSig = '';
      await loadProposals();
      const cards = await until(() => { const l = [...document.querySelectorAll('#v2PropList > div')]; return l.length === 2 ? l : null; });
      ok('the headline is the first line only', cards[0].firstElementChild.nextElementSibling.textContent.startsWith('Set "Homework Helper" model: claude-sonnet-5 → claude-haiku-4-5') && !cards[0].textContent.includes('4 turns …'));
      ok('the evidence is on the card', cards[0].querySelector('.prop-evidence')?.textContent.includes('3.5 tools per turn'));
      eq('each risk is marked', [...cards[0].querySelectorAll('.prop-risks > div')].map((d) => d.textContent.slice(0, 16)), ['⚠ Thin evidence:', '⚠ Heavy tool use']);
      ok('the guard card says who prepared it', cards[1].textContent.includes("Prepared by Hatchabot's quality guard") && cards[1].textContent.includes('Before (claude-sonnet-5'));
      ok('a card without a check shows its whole text', cards[1].textContent.includes('Worse: failed turns'));
      [...cards[1].querySelectorAll('button')].find((b) => b.textContent.includes('Confirm')).click();
      await until(() => cards[1].textContent.includes('✅ Switched back.'));
      eq('confirm sent', calls('POST', /\/g1\/confirm$/).length, 1);
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
      eq('the stopped one left alone', calls('POST', new RegExp('/v1/agents/' + tax.id + '/rebuild$')).length, 0);
      fleetActionsDlg.close();
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
        alerts: [{ agentId: 'a1', at: new Date().toISOString(), tokens: 109e6, usual: 20e6, told: true }] };
      await openUsage('a1', 'Homework Helper');
      const body = await until(() => { const t = document.getElementById('usageBody').textContent; return t.includes('Last 24 hours') ? t : null; });
      ok('the last day: ' + body.slice(0, 200), /Last 24 hours:\s*109M tokens · 400 calls/.test(body));
      ok('the conversation size, and why it matters', body.includes('Conversation size now:') && body.includes('395K') && body.includes('Every call carries this much in'));
      ok('the split', body.includes('cache reads 851M (85%)'));
      ok('calls per model', body.includes('4.7k calls'));
      ok('its warning', body.includes('about 5× its usual day'));
      usageDlg.close();
      // The same page as a tab on the agent's sheet.
      try {
        openV2Agent('a1', 'usage');
        ok('a Usage tab', !!byText('#v2Tabs button', 'Usage'));
        await until(() => (document.getElementById('v2UsageBody') || {}).textContent?.includes('Conversation size now'))
          .catch(() => { throw new Error('the Usage tab showed: ' + JSON.stringify((document.getElementById('v2UsageBody') || { textContent: '(no tab body)' }).textContent.slice(0, 160)) + ' state=' + JSON.stringify(agents.find((x) => x.id === 'a1')?.state)); });
      } finally { v2Close(); delete window.__override['/v1/agents/a1/usage']; }
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
      // A spike warning of the last week shows at the top.
      window.__override['/v1/usage/periods'] = { period: 'day', from: at(1440), to: new Date(now).toISOString(), bucketMinutes: 60, buckets: [],
        agents: [], totals: { tokens: 0, requests: 0, limited: 0 }, byBilling: {}, cost: null,
        alerts: [{ agentId: 'a1', name: 'Homework Helper', at: new Date(now - 3600000).toISOString(), tokens: 100e6, usual: 20e6, told: true },
          { agentId: 'a2', name: 'Soccer Schedule', at: new Date(now - 7200000).toISOString(), tokens: 60e6, usual: 20e6, told: true }],
        pricing: { hours: 24, total: 123.4, monthly: 3702, parts: { cacheWrite: 82.1, output: 16.3, cacheRead: 20, input: 5 }, billing: { api: 0, plan: 123.4 },
          models: [{ model: 'claude-sonnet-5', cost: 100 }, { model: 'claude-opus-4-8', cost: 23.4 }], agents: {} } };
      openFleetUsage();
      await until(() => document.getElementById('fleetUsageBody').textContent.includes('about 5× its usual day'));
      const body2 = document.getElementById('fleetUsageBody');
      ok('no intro paragraph', !fleetUsageDlg.textContent.includes('Usage, not a bill'));
      ok('a plan is a footnote, not a paragraph', body2.textContent.includes('* Claude plan use priced at API rates — not money you pay.') && !body2.textContent.includes('the room it takes'));
      ok('the title is Usage', fleetUsageDlg.querySelector('.v2ptitle, h3').textContent.trim().startsWith('Usage'));
      const mark = window.__calls.length;
      body2.querySelector('button[aria-label="Clear this warning"]').click();
      const one = await until(() => window.__calls.slice(mark).find((c) => c.method === 'POST' && c.path === '/v1/usage/alerts/dismiss'));
      eq('clears that one', one.body, { agentId: 'a1', at: new Date(now - 3600000).toISOString() });
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
  Object.assign(T, {
    modalOnlyDialogs: async () => {
      // A stray click outside must not close the recovery code before "I've saved it", nor the sign-in (night review #19).
      const outside = (dlg) => dlg.dispatchEvent(new MouseEvent('click', { clientX: 3, clientY: 3, bubbles: true, cancelable: true }));
      showRecoveryCode('WXYZ-1234-TEST');
      outside(recoveryDlg);
      ok('the recovery code stays open', recoveryDlg.open && document.getElementById('recoveryCode').textContent === 'WXYZ-1234-TEST');
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      recoveryDlg.dispatchEvent(esc);
      ok('Esc is refused too', esc.defaultPrevented);
      document.getElementById('recoverySaved').checked = true;
      outside(recoveryDlg);
      ok('once saved, it may go', !recoveryDlg.open);
      loginDlg.showModal();
      outside(loginDlg);
      ok('the sign-in stays open', loginDlg.open);
      loginDlg.close();
      v2IconDlg.showModal();
      const r = v2IconDlg.getBoundingClientRect();
      if (r.left > 3 && r.top > 3) { outside(v2IconDlg); ok('an ordinary dialog still closes on an outside click', !v2IconDlg.open); }
      if (v2IconDlg.open) v2IconDlg.close();
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
        location.hash = '#console=' + key;
        // Opening chains several awaited steps (wake, health, access): slower
        // machines (GitHub's runners) need more than the usual 8 s (2026-10-09).
        await until(() => consoleDlg.open && consoleAgentId === A.id, 20000);
        ok('the address opened its console', true);
        ok('the browser tab is named after it: ' + document.title, document.title.startsWith(A.name));
        document.getElementById('consoleNewTab').click();
        ok('New tab opens the console\'s own address: ' + opened[0], opened[0] === location.origin + location.pathname + location.search + '#console=' + encodeURIComponent(key));
        closeConsole();
        await until(() => !location.hash.includes('console='));
        eq('closing gives the page its title back', document.title, title);
        await openGateway(A.id, A.slug);
        await until(() => location.hash === '#console=' + encodeURIComponent(key));
        ok('opening one any other way puts its address in the bar', true);
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
      } finally {
        if (document.getElementById('consoleDlg').open) closeConsole();
        delete window.__override['/v1/agents/a1/console/access']; delete window.__override['/v1/agents/a1/gateway'];
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
        ok('the web way shows', !web.hidden && web.textContent.includes('Chat on the web — for people you trust'));
        ok('it says they need to reach this machine', web.textContent.includes('Tailscale'));
        ok("it says what they get: a member's rights", /They will have a member's rights, exactly like a Telegram\s+member: they can chat and ask it to use its tools, but not schedule tasks or change its settings/.test(web.textContent));
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
        const madeUpKey = 'GEZDGNBVGY3TQOJQ'.repeat(2);
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
        ok('the inherited choice names the machine setting: ' + sel.options[0].textContent, sel.options[0].textContent.includes("the machine's setting: off"));
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
        aiDlg.close();
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
        applyModelDlg.close();
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
  const costFixture = async (body = COSTS) => { window.__override['/v1/costs'] = body; await v2LoadCosts(true); };
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
          ok(v + ': the week and the month: ' + meal, meal.includes('≈ $18 in the last 7 days at API prices (≈ $77 a month)'));
          ok(v + ': the plan note', meal.includes('on your Claude plan — counts against its limits'));
        }
        v2SetView('group');
        ok('no plan note on an API-priced agent', tipText('Car Upkeep').includes('≈ $52 in the last 7 days') && !tipText('Car Upkeep').includes('Claude plan'));
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
        ok('the tooltip says the window', tipText('Meal Planner').includes('≈ $1.20 in the last 3 hours at API prices (≈ $288 a month at that pace)'));
        ok('and the tile out loud', tile('Homework Helper').getAttribute('aria-label').includes('about $2.50 in the last 3 hours at API prices'));
        v2SetView('group'); await sleep(30);
        eq('the chips follow it in every view', chipOf('Homework Helper')?.textContent, '$3/3h');
        ok('no pills outside the Cost view', !document.querySelector('.v2costbar'));
        let kept = null; try { kept = localStorage.getItem('hb-cost-period'); } catch {}
        eq('remembered in this browser', kept, '3h');
      } finally { delete window.__override['/v1/costs']; v2SetCostPeriod('1w'); await costCleanup(); }
    },
    costBadgesOff: async () => {
      try {
        await costFixture();
        v2SetView('cost');
        await costFixture({ off: true, days: 7, agents: {} });
        ok('no badges', !document.querySelector('#v2groups .v2cost'));
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
        ok('the 80% line is in the tooltip', tipText('Meal Planner').includes('Used 82% of its $50 budget'));
        await withAgents((a) => a.name === 'Grocery Runner' ? { ...a, spendStep: { every: 100, month, spent: 212, passed: 2, next: 300, line: 'Spent $212.00 in this month — you hear every $100 (next at $300)' } } : undefined);
        ok('a step passed is an Alert', tipText('Grocery Runner').includes('you hear every $100 (next at $300)'));
        ok('its key names the step', attentionFingerprint(agents.find((x) => x.name === 'Grocery Runner')).includes('step:' + month + ':2:100'));
        delete window.__override['/v1/agents'];
        await withAgents((a) => a.name === 'Stock Watcher' ? { ...a, state: 'STOPPED', budget: { scope: a.id, usd: 20, atLimit: 'pause', month, spent: 23.5, pct: 118, level: 100, resetsOn: 'next 1st', paused: { at: new Date().toISOString() }, line: 'Paused: it used its $20 budget for this month ($23.50). It starts again on the 1st — or raise the budget, or start it now' } }
          : a.name === 'Meal Planner' ? { ...a, budget: { scope: a.id, usd: 50, atLimit: 'warn', month, spent: 41.1, pct: 82, level: 80, resetsOn: 'next 1st', line: 'Used 82% of its $50 budget for this month ($41.10)' } } : undefined);
        byText('.v2views button', 'Alerts').click(); await sleep(50);
        const sec = [...document.querySelectorAll('#v2groups .v2group')].find((g) => g.querySelector('h3').textContent.includes('Alerts'));
        const names = [...sec.querySelectorAll('.v2agent .v2name')].map((n) => n.textContent);
        ok('both are under Alerts: ' + names, names.includes('Stock Watcher') && names.includes('Meal Planner'));
        const meal = agents.find((x) => x.name === 'Meal Planner');
        ok('the clear key names month, level and amount', attentionFingerprint(meal).includes('budget:' + month + ':80:50'));
        // The Usage tab: its budget, set in place.
        window.__override['/v1/budgets'] = { month, tz: 'UTC', agents: [
          { id: meal.id, name: 'Meal Planner', state: 'RUNNING', billing: 'api', spent: 41.1, lastMonth: 38, monthlyNow: 52, suggested: 75, budget: meal.budget },
          { id: 'zz', name: 'Errand Runner', state: 'RUNNING', billing: 'plan', spent: 3, lastMonth: 4, monthlyNow: 4, suggested: 5 },
        ], machine: { spent: 240, lastMonth: 310 } };
        openV2Agent(meal.id, 'usage');
        const input = await until(() => document.getElementById('bgUsd_' + meal.id));
        eq('the row shows its budget', input.value, '50');
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
        window.__answer['POST /v1/workspaces/inspect'] = [{ status: 200, body: { path: WS, files: ['SOUL.md', 'AGENTS.md'], bytes: 2048, markdownFiles: ['SOUL.md', 'AGENTS.md'], existingBot: null } }];
        $('adoptPath').value = WS;
        await adoptInspect(); await sleep(50);
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
        ok('OpenClaw version, model, update', tip.includes('OpenClaw 2026.9.6 · claude-sonnet-5 · update ready'));
        ok('its uptime', tip.includes('Up 3 h 12 min'));
        ok('the restart and how it ended', tip.includes('Restarted by itself once since its last rebuild (last exit 135: a memory fault)'));
        ok('no persona any more', !tip.includes('Plans the week'));
        v2ShowTip(tile('Meal Planner'));
        const parts = [...document.querySelectorAll('#v2Tip .v2tipsec')].map((s) => s.classList.contains('v2tipcost') ? 'cost' : 'runtime');
        document.getElementById('v2Tip').hidden = true;
        eq('two parts, cost first', parts, ['cost', 'runtime']);
        const tax = tipText('Tax Filing');
        ok('the alarm shows without use in the window: ' + tax, tax.includes('🔔 Alarm every $20'));
        ok('days of uptime', tax.includes('Up 3 days'));
        ok('no restart line when it never restarted', !tax.includes('Restarted'));
      } finally { await costCleanup(); await agentsCleanup(); }
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
        ok('bin hint', document.getElementById('v2Trash').textContent.includes('By keyboard: open the agent, then Advanced → Delete'));
        const arch = [...document.querySelectorAll('#v2groups .v2group')].find((s) => s.querySelector('h3').textContent === 'Archived');
        ok('Archived hint', !!arch && arch.textContent.includes('By keyboard: open the agent, then Advanced → Archive'));
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
        restorable: [{ date: '2026-10-08', sizeBytes: 2048, complete: true, drill: 'passed' }, { date: '2026-10-07', sizeBytes: 1024, complete: false }] };
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
  });
  (async () => {
    for (const [name, run] of Object.entries(T)) {
      try { await run(); results.push({ name, ok: true }); }
      catch (err) { results.push({ name, ok: false, error: String(err && err.message || err).slice(0, 300) }); }
    }
    document.documentElement.setAttribute('data-ui-results', JSON.stringify(results));
    document.title = 'UI-DONE';
  })();
})();`;

// The checks are a string run in the page: a syntax error there (a merge once
// dropped a closing brace) made Chrome report nothing at all. Say which line.
try { new Function(SCENARIOS); } catch (err) {
  console.error(`The click-through checks don't parse: ${err.message}`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'hb-ui-'));
try {
  // hb-ui=classic and ?ui=classic (below): opened as a browser that had chosen the classic look (scenario classicMap).
  const head = `<head><script>localStorage.setItem('theme','light'); localStorage.setItem('hb-ui','classic')</script><script>${STUB.replace('__VERSION__', version)}</script><script>${RECORDER}</script>`;
  const tail = `<script>setTimeout(() => { ${SCENARIOS} }, 2500)</script></body>`;
  // Replacer functions: a bare string is a pattern to replace(), and `$'` inside the scenarios meant "the rest of the page".
  writeFileSync(join(work, 'page.html'), page.replace('<head>', () => head).replace('</body>', () => tail));
  // Chrome's container runs as its own user (uid 1000); a private temp folder
  // owned by another uid (GitHub's runner is 1001) left it a blank page, and
  // "the page never reported" (2026-10-09). The page holds only test data.
  chmodSync(work, 0o755);
  chmodSync(join(work, 'page.html'), 0o644);
  let dom = '';
  for (let tries = 1; !dom.includes('data-ui-results') && tries <= 3; tries++) {
    try {
      dom = execFileSync('docker', [
        'run', '--rm', '--shm-size=1g', '-v', `${work}:/w`, 'zenika/alpine-chrome',
        '--no-sandbox', '--headless', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
        '--window-size=1400,1000', '--virtual-time-budget=600000', '--dump-dom', 'file:///w/page.html?ui=classic',
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
    } catch (err) { dom = String(err.stdout ?? ''); }
  }
  if (keep) writeFileSync(join(work, 'dom.html'), dom);
  const m = /data-ui-results="([^"]*)"/.exec(dom);
  if (!m) throw new Error(`the page never reported (no data-ui-results in the DOM dump${keep ? `; see ${work}/dom.html` : '; run with --keep'})`);
  const results = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`✓ ${r.name}`);
    else { failed++; console.log(`✗ ${r.name} — ${r.error}`); }
  }
  console.log(`${results.length - failed}/${results.length} passed${keep ? ` · kept ${work}` : ''}`);
  process.exitCode = failed ? 1 : 0;
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true });
}
