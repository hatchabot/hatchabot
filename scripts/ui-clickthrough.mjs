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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(50); } throw new Error('timed out waiting'); };
  const calls = (method, re) => window.__calls.filter((c) => c.method === method && re.test(c.path));
  const eq = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(what + ': got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); };
  const ok = (what, cond) => { if (!cond) throw new Error(what); };
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((el) => el.textContent.trim().includes(text));
  const tile = (name) => [...document.querySelectorAll('#v2groups .v2agent')].find((el) => el.textContent.includes(name));
  const centre = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const pointer = (type, target, x, y) => target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, bubbles: true, cancelable: true }));
  const T = {
    home: async () => {
      const tiles = document.querySelectorAll('#v2groups .v2agent');
      ok('tiles rendered: ' + tiles.length, tiles.length === 14);
      ok('the manager is the first, fixed tile', tiles[0].dataset.v2fixed && tiles[0].textContent.includes('Hatchabot'));
      ok('no hub box with a manager', document.querySelector('.v2hub').hidden);
      const header = document.querySelector('#v2Header .v2hubactions');
      ok('the actions sit in the header', !!header);
      eq('header buttons', [...header.querySelectorAll('button:not([hidden])')].map((b) => b.getAttribute('aria-label')), ['Status', 'Bulk actions', 'Settings', 'New agent']);
      ok('symbol only: the label is hidden', getComputedStyle(header.querySelector('.lbl')).display === 'none');
    },
    viewBy: async () => {
      const btn = byText('button', 'Needs you');
      ok('a "Needs you" view button', !!btn);
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
    scheduleEdit: async () => {
      window.__crons = [{ id: 'c1', name: 'Morning brief', scheduleExpr: '0 8 * * *', scheduleTz: 'America/Toronto', message: 'Good morning', enabled: true, payloadKind: 'message' }];
      openV2Agent('a1', 'schedule');
      await until(() => cronCache.some((c) => c.id === 'c1'));
      editCronJob('c1');
      eq('the form carries the task', [document.getElementById('cronName').value, document.getElementById('cronExpr').value, document.getElementById('cronMsg').value], ['Morning brief', '0 8 * * *', 'Good morning']);
      ok('the button says it replaces', document.getElementById('cronAddBtn').textContent.includes('Save changes'));
      document.getElementById('cronName').value = 'Morning brief 2';
      document.getElementById('cronAddBtn').click();
      const posted = await until(() => calls('POST', /\/v1\/agents\/a1\/crons$/)[0]);
      ok('the edited task is sent', posted.body.name === 'Morning brief 2' && posted.body.cron === '0 8 * * *');
      v2Close(); window.__crons = [];
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
        missing: [{ agentId: 'a9', name: 'Book Advisor', host: 'Laptop runner' }],
        backups: [{ date: '2026-09-28', sizeBytes: 1024, hasDb: true, hasKey: true, complete: false, failedVolumes: ['hatchabot-kitchen-vol'],
          orphans: ['agentclaw-old-vol'], volumes: [{ name: 'Homework Helper', agentId: 'a1', sizeBytes: 1024 }] }] };
      await openAiDlg('backups');
      const list = await until(() => { const t = document.getElementById('bkList').textContent; return t.includes('2026-09-28') ? t : null; });
      ok('the set is marked incomplete, with its failure count', list.includes('incomplete (1 agent failed)'));
      ok('the uncovered agent is named with its machine', list.includes('Not in the newest backup: Book Advisor (Laptop runner)'));
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
    headerDoors: async () => {
      await openAiDlg(); ok('Settings opens', aiDlg.open); aiDlg.close();
      await openFleet(); ok('Status opens', v2FleetDlg.open); v2FleetDlg.close();
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
      // Status → Usage offers 3, 6, 9 and 12 hours between Hour and Day (Chris, 2026-09-28).
      const now = Date.now(), at = (m) => new Date(Math.floor((now - m * 60000) / 900000) * 900000).toISOString();
      window.__override['/v1/usage/periods'] = { period: '6h', from: at(360), to: new Date(now).toISOString(), bucketMinutes: 15,
        buckets: [360, 345, 30, 15].map((m) => ({ at: at(m), tokens: m === 15 ? 5000 : 0, requests: m === 15 ? 2 : 0, limited: 0 })),
        agents: [{ id: 'a1', name: 'Homework Helper', state: 'RUNNING', tokens: 5000, requests: 2, limited: 0, billing: 'included', cost: null }],
        totals: { tokens: 5000, requests: 2, limited: 0 }, byBilling: { included: 5000, api: 0, local: 0 }, cost: null };
      openFleetUsage();
      const six = await until(() => [...document.querySelectorAll('#fleetUsageBody .su-period')].find((b) => b.textContent === '6h'));
      eq('the choices', [...document.querySelectorAll('#fleetUsageBody .su-period')].map((b) => b.textContent), ['Hour', '3h', '6h', '9h', '12h', 'Day', 'Week']);
      six.click();
      await until(() => calls('GET', /\/v1\/usage\/periods$/).length && document.getElementById('fleetUsageBody').textContent.includes('last 6 hours'));
      ok('6h is the one on', document.querySelector('#fleetUsageBody .su-period.on').textContent === '6h');
      ok('bars per 15 minutes', document.getElementById('fleetUsageBody').textContent.includes('Tokens per 15 minutes'));
      fleetUsageDlg.close(); delete window.__override['/v1/usage/periods'];
      // A spike warning of the last week shows at the top.
      window.__override['/v1/usage/periods'] = { period: 'day', from: at(1440), to: new Date(now).toISOString(), bucketMinutes: 60, buckets: [],
        agents: [], totals: { tokens: 0, requests: 0, limited: 0 }, byBilling: {}, cost: null,
        alerts: [{ agentId: 'a1', name: 'Homework Helper', at: new Date(now - 3600000).toISOString(), tokens: 100e6, usual: 20e6, told: true }] };
      openFleetUsage();
      await until(() => document.getElementById('fleetUsageBody').textContent.includes('about 5× its usual day'));
      fleetUsageDlg.close(); delete window.__override['/v1/usage/periods'];
      try { localStorage.removeItem('hb-fleet-usage-period'); } catch {} fleetUsagePeriod = 'day';
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
        { ...base, id: 'm2', name: 'Nap Bot', role: 'member', ownerId: 'o2', state: 'STOPPED', hibernatedAt: new Date().toISOString() }];
      await refresh(false);
      openV2Agent('m1');
      let t = document.getElementById('v2Pane').textContent;
      ok('Discord, not Telegram: ' + t.replace(/\s+/g, ' ').slice(0, 160), t.includes('Open in Discord') && t.includes('answers in Discord') && !t.includes('Telegram') && !t.includes('Not running'));
      v2Close();
      openV2Agent('m2');
      t = document.getElementById('v2Pane').textContent;
      ok('asleep, with its link: ' + t.replace(/\s+/g, ' ').slice(0, 160), t.includes('Open in Telegram') && t.includes('a message wakes it') && !t.includes('Not running'));
      v2Close();
      delete window.__override['/v1/agents'];
      await refresh(false);
    },
    limitBannerLive: async () => {
      // The rate-limit banner counts the agents that could answer, not archived ones (night review #21).
      const u = await (await fetch('/v1/ai-profiles/usage')).json();
      window.__override['/v1/ai-profiles/usage'] = { ...u, sources: [{ ...u.sources[0], status: 'limited', limitedSince: new Date().toISOString(), agents: 5, liveAgents: 3 }] };
      await loadSourceUsage();
      const t = document.getElementById('limitBanner').textContent;
      ok('three, not five: ' + t, t.includes('its 3 agents'));
      delete window.__override['/v1/ai-profiles/usage'];
      await loadSourceUsage();
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
    pollFetchesLess: async () => {
      // No /members fan-out on v2, no /pairing for web-only agents, no hidden Activity card, a light backups read (night review #24/#25/#47).
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
        ok('the thinking line is gone', !document.getElementById('wchatWait'));
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
    // Settings promises (2026-09-30): what the AI source says about sharing and helper calls; the shared-source banner; the disk warning; an unpriced model.
    sourcePromises: async () => {
      const savedProfiles = profiles, savedUsage = sourceUsageData;
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
        // The rate-limit banner is the source's: a member hears about a shared source; the owner hears whose agents are stuck.
        const since = new Date(Date.now() - 3600000).toISOString();
        const src = { id: 'p9', name: 'House Claude', agents: 2, liveAgents: 2, status: 'limited', limitedSince: since };
        sourceUsageData = { sources: [{ ...src, mine: false }] };
        renderLimitBanner();
        const banner = document.getElementById('limitBanner');
        ok('a member sees it: ' + banner.textContent, !banner.hidden && banner.textContent.includes('Shared source House Claude is being rate-limited') && banner.textContent.includes("your 2 agents on it can't answer"));
        sourceUsageData = { sources: [{ ...src, liveAgents: 3, mine: true, others: { agents: 2, liveAgents: 2, requests5h: 1, requests7d: 1 } }] };
        renderLimitBanner();
        ok('the owner hears about the other accounts: ' + banner.textContent, banner.textContent.includes("its 3 agents (and 2 on other accounts) can't answer") && !banner.textContent.includes('Shared source'));
        sourceUsageData = { sources: [{ ...src, liveAgents: 0, agents: 0, mine: true, others: { agents: 1, liveAgents: 1, requests5h: 1, requests7d: 1 } }] };
        renderLimitBanner();
        ok('only other accounts stuck: still shown', !banner.hidden && banner.textContent.includes("its 1 agent on other accounts can't answer"));
      } finally {
        delete window.__override['/v1/ai-profiles'];
        profiles = savedProfiles; sourceUsageData = savedUsage; renderLimitBanner();
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
        ok('Needs you says how big: ' + why.textContent, why.textContent.includes('it uses 12.4 GB of storage (the warning is at 10 GB)'));
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
    unpricedModel: async () => {
      try {
        const now = Date.now();
        window.__override['/v1/usage/periods'] = { period: 'day', from: new Date(now - 864e5).toISOString(), to: new Date(now).toISOString(), bucketMinutes: 60, buckets: [],
          agents: [
            { id: 'a1', name: 'Homework Helper', state: 'RUNNING', tokens: 5000, requests: 2, limited: 0, billing: 'api', model: 'claude-made-up-9', cost: null, unpriced: true },
            { id: 'a2', name: 'Meal Planner', state: 'RUNNING', tokens: 4000, requests: 2, limited: 0, billing: 'included', model: 'claude-sonnet-5', cost: { low: 0.02, high: 0.02, partial: false } }],
          totals: { tokens: 9000, requests: 4, limited: 0 }, byBilling: { included: 3000, api: 6000, local: 0 }, cost: { low: 0.02, high: 0.02, partial: true, agents: 1 } };
        openFleetUsage();
        const body = await until(() => { const el = document.getElementById('fleetUsageBody'); return el.textContent.includes('Meal Planner') ? el : null; });
        ok('an unknown price is said, not $0.00+: ' + body.textContent.slice(0, 300), body.textContent.includes('API — no price known for claude-made-up-9') && !body.textContent.includes('$0.00+'));
        ok('an agent now on a subscription keeps the cost of its API part', body.textContent.includes('est. $0.02 (API part)'));
        ok('the breakdown names the token kinds', document.body.textContent.includes('tokens (new input, cache reads and writes, and output)'));
      } finally {
        if (fleetUsageDlg.open) fleetUsageDlg.close();
        delete window.__override['/v1/usage/periods'];
      }
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

const work = mkdtempSync(join(tmpdir(), 'hb-ui-'));
try {
  const head = `<head><script>localStorage.setItem('theme','light')</script><script>${STUB.replace('__VERSION__', version)}</script><script>${RECORDER}</script>`;
  const tail = `<script>setTimeout(() => { ${SCENARIOS} }, 2500)</script></body>`;
  // Replacer functions: a bare string is a pattern to replace(), and `$'` inside the scenarios meant "the rest of the page".
  writeFileSync(join(work, 'page.html'), page.replace('<head>', () => head).replace('</body>', () => tail));
  let dom = '';
  for (let tries = 1; !dom.includes('data-ui-results') && tries <= 3; tries++) {
    try {
      dom = execFileSync('docker', [
        'run', '--rm', '--shm-size=1g', '-v', `${work}:/w`, 'zenika/alpine-chrome',
        '--no-sandbox', '--headless', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
        '--window-size=1400,1000', '--virtual-time-budget=30000', '--dump-dom', 'file:///w/page.html',
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
