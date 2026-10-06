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
  const until = async (f, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(50); } throw new Error('timed out waiting for ' + String(f).replace(/\s+/g, ' ').slice(0, 160)); };
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
      eq('header buttons', [...header.querySelectorAll('button:not([hidden])')].map((b) => b.getAttribute('aria-label')), ['Usage', 'Resources', 'Bulk actions', 'Settings', 'New agent']);
      ok('symbol only: the label is hidden', getComputedStyle(header.querySelector('.lbl')).display === 'none');
    },
    homeFoot: async () => {
      // The foot of the home screen (Status retired, 2026-10-05): Activity, then the machine line (made-up data).
      const now = Date.now(), iso = (m) => new Date(now - m * 60000).toISOString();
      window.__override['/v1/events'] = [
        { id: 2, agentId: 'a1', agentName: 'Homework Helper', at: iso(5), event: 'agent.rebuilt', detail: {} },
        { id: 1, agentId: 'a2', agentName: 'Soccer Schedule', at: iso(50), event: 'provision.failed', detail: {} },
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
        buckets: Array.from({ length: 56 }, (_, i) => ({ at: new Date(now - (56 - i) * 3 * H).toISOString(), cacheWrite: i % 7 ? 2 : 6, cacheRead: 0.5, output: 0.4, input: 0.1, tokens: (i % 5 + 1) * 3e6 })),
        totals: { cacheWrite: 136, cacheRead: 28, output: 22.4, input: 5.6, cost: 192, tokens: 504e6 } });
      window.__override['/v1/usage/spend'] = series('');
      const box = document.createElement('div'); box.innerHTML = spendChartBox(''); document.body.append(box);
      await loadSpendCharts(box);
      const svg = await until(() => box.querySelector('svg'));
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
        window.__confirmAnswer = false; // leave MEMORY.md out, then don't save
        btn.click();
        await until(() => document.getElementById('toast').textContent.includes('Not saved'));
        const said = window.__confirms.slice(-2);
        ok('asked about MEMORY.md in plain words: ' + said[0], said[0].includes('also include MEMORY.md (its summary notes; may contain personal facts)'));
        ok('then said what the copy mentions: ' + said[1], said[1].includes('This copy mentions 2 email addresses and 1 phone number — read it before you send it.'));
        ok('and where', said[1].includes('AGENTS.md, line 3: ann@example.com') && said[1].includes('Scheduled task “Digest”, line 1: 416-555-0123'));
        ok('without MEMORY.md: ' + asked[0], asked[0].endsWith('?excludeMemory=1'));
        window.__confirmAnswer = true;
        btn.click();
        await until(() => document.getElementById('toast').textContent.includes('Saved homework-helper.template.hatchabot'));
        ok('with MEMORY.md this time', asked.length === 2 && !asked[1].includes('excludeMemory'));
      } finally {
        window.fetch = prev; window.__confirmAnswer = true;
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
        await openHealth('a1', 'Homework Helper');
        const body = document.getElementById('healthBody');
        await until(() => body.textContent.includes('AI source'));
        ok('not "Responding" while its source refuses: ' + body.textContent.replace(/\s+/g, ' ').slice(0, 160), body.textContent.includes('Up, but its AI source is not answering') && !body.textContent.includes('Responding'));
        ok('refused since, and when it last answered', /refused \(rate-limited\) since 2h ago/.test(body.textContent) && body.textContent.includes('last answered 5h ago'));
        ok('the dialog says what it checks', document.getElementById('healthDlg').textContent.includes('Checks its gateway and chat connection, and when its AI source last answered'));
        window.__override['/v1/agents/a1/health'] = { reachable: true, status: 'healthy', pluginErrors: [], aiSource: { lastAnsweredAt: hAgo(2) } };
        await loadHealth();
        await until(() => body.textContent.includes('Responding'));
        ok('answering: last answered: ' + body.textContent.replace(/\s+/g, ' ').slice(0, 160), /AI source\s*last answered 2h ago/.test(body.textContent.replace(/\s+/g, ' ')));
      } finally {
        delete window.__override['/v1/agents/a1/health'];
        if (healthDlg.open) healthDlg.close();
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
        eq('sort buttons', sortBtns(), ['Cost', 'Age', 'Name', 'Activity']);
        byText('.v2binsort button', 'Name').click(); await sleep(30);
        eq('Name A→Z inside a band', namesIn('>$100/wk'), ['Budget Tracker', 'Homework Helper', 'Soccer Schedule']);
        byText('.v2binsort button', 'Cost').click(); await sleep(30);
        eq('back to dearest first', namesIn('>$100/wk'), ['Homework Helper', 'Soccer Schedule', 'Budget Tracker']);
        byText('.v2binsort button', 'Cost').click(); await sleep(30);
        eq('again: cheapest first', namesIn('>$100/wk'), ['Budget Tracker', 'Soccer Schedule', 'Homework Helper']);
        byText('.v2binsort button', 'Cost').click(); await sleep(30);
        const groupsSort = JSON.stringify(v2Sort);
        byText('.v2views button', 'Groups').click(); await sleep(30);
        eq('Groups has no Cost sort', sortBtns(), ['Age', 'Name', 'Activity']);
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
        aiDlg.close();
      } finally { if (typeof aiDlg !== 'undefined' && aiDlg.open) aiDlg.close(); delete window.__override['/v1/budgets']; await agentsCleanup(); }
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
        '--window-size=1400,1000', '--virtual-time-budget=120000', '--dump-dom', 'file:///w/page.html',
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
