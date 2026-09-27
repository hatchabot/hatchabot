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
    window.__calls.push({ method, path, body });
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(50); } throw new Error('timed out waiting'); };
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
    headerDoors: async () => {
      await openAiDlg(); ok('Settings opens', aiDlg.open); aiDlg.close();
      await openFleet(); ok('Status opens', v2FleetDlg.open); v2FleetDlg.close();
      document.getElementById('fabBtn').click(); ok('New opens the create dialog', createDlg.open); createDlg.close();
      document.querySelector('#v2Header .v2hubactions button[aria-label="Settings"]').click();
      await until(() => aiDlg.open); aiDlg.close();
    },
  };
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
