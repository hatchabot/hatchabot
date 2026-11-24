// web/app/spend.js: the home screen's foot (Activity, the audit log, the machine line), model prices, budgets, spend over time.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- the home screen's foot: Activity and the machine line (Status retired, 2026-10-05) ----
// Activity: the newest events, read with the list poll at most every 30 s;
// "See all" opens the full log. The machine line (the machine owner's): each
// machine and whether it answers, the latest backup, the OpenClaw version —
// what Status → Health showed that the home screen did not. A machine that
// is not answering, or backups that are late, are also Alerts on the
// Hatchabot agent's tile (agentAttention).
const V2_ACT_N = 12;
let v2ActAt = 0, v2ActBusy = false;
const v2ActFolded = () => { try { return localStorage.getItem('hb-activity-folded') === '1'; } catch { return false; } };
function v2FoldActivity() {
  const folded = !v2ActFolded();
  try { localStorage.setItem('hb-activity-folded', folded ? '1' : '0'); } catch {}
  v2PaintActivityFold();
}
function v2PaintActivityFold() {
  const f = v2ActFolded();
  $('v2ActList').hidden = f;
  $('v2ActFold').textContent = f ? 'Show' : 'Hide';
  $('v2ActFold').setAttribute('aria-expanded', String(!f));
}
async function v2LoadActivity(force = false) {
  if (v2ActBusy || (!force && Date.now() - v2ActAt < 30_000)) return;
  v2ActBusy = true;
  try {
    const evs = await api(`/v1/events?limit=${V2_ACT_N}`);
    const box = $('v2Activity');
    box.hidden = !evs.length;
    $('v2ActCount').textContent = evs.length ? String(evs.length) : '';
    $('v2ActList').innerHTML = evs.map(e => e.op ? v2ActOpRow(e) : (() => {
      const what = EVENT_WORDS[e.event] ?? e.label ?? e.event.replace(/[._]/g, ' ');
      const bad = /fail|missing|unhealthy|rolled_back/.test(e.event);
      return `<div class="v2actrow"><span class="t" title="${esc(new Date(e.at).toLocaleString())}">${esc(ago(e.at))}</span>
        <span class="w"><b>${esc(e.agentName ?? 'agent')}</b> <span${bad ? ' class="bad"' : ''}>${esc(what)}</span></span></div>`;
    })()).join('');
    v2PaintActivityFold();
  } catch { /* never worth breaking the page for */ }
  finally { v2ActBusy = false; v2ActAt = Date.now(); }
}
/**
 * An operation in Activity (phase 3): ONE row — "Moved to Laptop runner · 3 min",
 * red when it failed or was undone, amber while it waits for a choice — that
 * opens, by mouse or keyboard (a real button, aria-expanded), to its steps.
 * The steps stay in the agent's Setup log too.
 */
const v2ActOpen = new Set(); // which rows are open, across the 30-s reloads
function v2ActOpRow(e) {
  const op = e.op, id = `v2actop-${String(op.id).replace(/[^\w-]/g, '')}`;
  const tone = op.status === 'failed' || op.status === 'rolled_back' ? ' class="bad"' : op.status === 'held' || op.status === 'interrupted' ? ' class="warn"' : '';
  const steps = op.steps || [];
  const open = v2ActOpen.has(op.id) && (steps.length || op.outcome);
  const body = [
    ...steps.map(s => `<li><span class="sub">${esc(clock(s.at))}</span> ${esc(s.label)}</li>`),
    ...(!steps.length && op.outcome ? [`<li>${esc(op.outcome)}</li>`] : []),
  ].join('');
  const label = e.label || `${op.summary} · ${opSpan(op.durationMs || 0)}`;
  const when = `<span class="t" title="${esc(new Date(e.at).toLocaleString())}">${esc(ago(e.at))}</span>`;
  if (!body) return `<div class="v2actrow">${when}<span class="w"><b>${esc(e.agentName ?? 'agent')}</b> <span${tone}>${esc(label)}</span></span></div>`;
  return `<div class="v2actrow v2actop">${when}<span class="w"><b>${esc(e.agentName ?? 'agent')}</b>
      <button type="button" class="v2actopbtn" aria-expanded="${open ? 'true' : 'false'}" aria-controls="${id}" data-op="${esc(op.id)}" ${onAction('click', 'v2ToggleActOp', [{ $: 'el' }])}
        title="Its steps"><span${tone}>${esc(label)}</span> <span class="sub" aria-hidden="true">${open ? '▾' : '▸'}</span></button>
      <ol id="${id}" class="v2actsteps"${open ? '' : ' hidden'}>${body}</ol></span></div>`;
}
function v2ToggleActOp(btn) {
  const list = $(btn.getAttribute('aria-controls')); if (!list) return;
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  list.hidden = !open;
  btn.querySelector('[aria-hidden]').textContent = open ? '▾' : '▸';
  if (open) v2ActOpen.add(btn.dataset.op); else v2ActOpen.delete(btn.dataset.op);
}
let v2Machine = null, v2MachineAt = 0, v2MachineBusy = false;
async function v2LoadMachine(force = false) {
  if (!myAccount?.hostOwner || v2MachineBusy || (!force && Date.now() - v2MachineAt < 60_000)) return;
  v2MachineBusy = true;
  try {
    // The newest set only, with who it leaves out: the full list is every set's volumes (fourteenth review).
    const [hs, b, rt] = await Promise.all([api('/v1/hosts').catch(() => null), api('/v1/backups?latest=1').catch(() => null), api('/v1/runtime').catch(() => null)]);
    // This install's own newest: one made by another install, or under an earlier key, would hide a stale or broken own set.
    const latest = (b?.backups ?? []).find(x => !x.foreign);
    let backup = null;
    if (b) {
      if (!latest) backup = { warn: 'none yet — the nightly job runs at 03:30' };
      else {
        const ageDays = Math.floor((Date.now() - Date.parse(latest.date + 'T00:00:00')) / 86400000);
        const miss = b.missing ?? [];
        const { why, key } = v2BackupWarn(latest, ageDays, miss);
        // latest and miss stay for the alert, which folds in each agent's own (v2MachineAlerts).
        backup = { date: latest.date, ageDays, latest, miss, ...(why ? { warn: why, key } : {}) };
      }
    }
    // A read that failed keeps what the last one that worked said: an offline runner or a late backup
    // vanished from the line and the Alerts for a minute on a failed read, as if it were fine (HB-1043).
    const was = v2Machine;
    v2Machine = { hosts: Array.isArray(hs) ? hs : hs === null ? was?.hosts ?? [] : [], backup: b ? backup : was?.backup ?? null, runtime: rt ?? was?.runtime ?? null };
    v2PaintMachine();
    renderV2(); // the Hatchabot agent's tile carries the machine's alerts
  } catch { /* the line stays as it was */ }
  finally { v2MachineBusy = false; v2MachineAt = Date.now(); }
}
/** The machine's backup warning: late, broken, or agents the newest set left out. */
function v2BackupWarn(latest, ageDays, miss) {
  // Named when few: "1 agent not covered" sent people hunting (2026-10-06).
  const missing = !miss.length ? '' : miss.length <= 3
    ? `${miss.map(m => m.name + (m.host ? ` (on ${m.host})` : '')).join(', ')} not in it`
    : `${miss.length} agents not in it`;
  const dated = [latest.complete === false ? 'the latest is incomplete' : '', !latest.hasKey ? 'no key' : ''].filter(Boolean);
  const why = [ageDays > 2 ? `the latest is ${ageDays} days old` : '', ...dated, missing].filter(Boolean).join(', ');
  // What "Clear from Alerts" remembers. Not the date alone: every night's
  // set is new, so a cleared "not covered" came back each morning. The
  // same agents left out stay cleared; a new one, a stale or broken set
  // brings it back.
  const key = [dated.length ? latest.date : '', ageDays > 2 ? 'stale:' + latest.date : '', miss.map(m => m.agentId).sort().join(',')].join('|');
  return { why, key };
}
function v2PaintMachine() {
  const el = $('v2Machine'); if (!el) return;
  if (!v2Machine) { el.hidden = true; return; }
  const parts = v2Machine.hosts.map(h => {
    const n = `${h.agentCount ?? 0} agent${h.agentCount === 1 ? '' : 's'}`;
    if (h.kind === 'local') return `<span>🖥 ${esc(h.hostname || h.name)} · ${n}</span>`;
    return `<span>💻 ${esc(h.name)} · ${n} · ${h.reachable === false ? '<span class="warn">not answering</span>' : h.reachable ? 'answering' : 'not checked'}</span>`;
  });
  const bk = v2Machine.backup;
  if (bk) parts.push(bk.date ? `<span>💾 Backup ${esc(bk.date)}${bk.ageDays ? ` (${bk.ageDays}d ago)` : ''}${bk.warn ? ` · <span class="warn">${esc(bk.warn)}</span>` : ''}</span>` : `<span>💾 Backups: <span class="warn">${esc(bk.warn)}</span></span>`);
  const rt = v2Machine.runtime;
  if (rt?.imageVersion) parts.push(`<span>OpenClaw ${esc(rt.imageVersion)}${rt.upgradeAvailable && rt.npmLatest ? ` · ${esc(rt.npmLatest)} out` : ''}</span>`);
  // A health check on every running agent (also at the foot of Bulk actions).
  if (parts.length) parts.push('<button type="button" class="v2more" id="v2MachineCheckAll" ' + onAction('click', 'v2CheckAll') + ' title="Ask each running agent whether it answers, and check its settings — what it finds shows under Alerts">❤️ Check all agents</button>');
  el.innerHTML = parts.join('');
  el.hidden = !parts.length;
}
/** The machine's alerts, on the Hatchabot agent's tile (its owner's, who owns the machine). */
function v2MachineAlerts() {
  if (!v2Machine) return [];
  const out = [];
  for (const h of v2Machine.hosts) if (h.kind !== 'local' && h.reachable === false && (h.agentCount ?? 0) > 0) {
    out.push({ key: 'runner-down:' + h.id, icon: '💻', why: `${h.name} isn't answering (asleep or offline?) — its ${h.agentCount} agent${h.agentCount === 1 ? '' : 's'} can't be reached until it is back` });
  }
  const bk = v2Machine.backup;
  // The fold (recovery readiness): an agent whose own tile carries its
  // "left out" alert is not named here again; the machine's alert stays for
  // what is the whole machine's (late, incomplete, no key).
  const own = new Set((v2Readiness?.agents || []).filter(r => r.alert && v2Find(r.agentId) && v2Mine(v2Find(r.agentId))).map(r => r.agentId));
  const w = bk?.latest && own.size ? v2BackupWarn(bk.latest, bk.ageDays, (bk.miss || []).filter(m => !own.has(m.agentId))) : null;
  const warn = w ? w.why : bk?.warn, key = w ? w.key : bk?.key;
  if (warn) out.push({ key: `backup:${key ?? bk.date ?? 'none'}`, icon: '💾', why: `backups: ${warn} (⚙ Settings → Backups)` });
  // A restore drill that failed is the machine's: its backups may not bring an agent back.
  const ld = v2Readiness?.drill?.last;
  if (ld && !ld.passed) out.push({ key: 'drill:' + ld.at, icon: '💾', why: `the last restore drill (${String(ld.at).slice(0, 10)}) failed — its backups may not bring every agent back (⚙ Settings → Backups)` });
  return out;
}

// The full audit log: same feed as the card, but browsable — filter to one
// agent, pull more, and see each event's recorded detail and exact time.
async function openAudit(agentId) {
  $('auditAgent').innerHTML = ['<option value="">All agents</option>']
    .concat((agents ?? []).map(a => `<option value="${a.id}"${a.id === agentId ? ' selected' : ''}>${esc(a.name)}</option>`))
    .join('');
  $('auditAgent').value = agentId ?? '';
  $('auditList').innerHTML = 'Loading…';
  auditDlg.showModal();
  await loadAudit();
}
// Each read numbered, and only the newest drawn: the filter or the limit changed while one was read, and its
// slower answer (or its error) replaced the newer one's under the agent now chosen (HB-0913).
let auditSeq = 0;
async function loadAudit() {
  const agentId = $('auditAgent').value;
  const limit = $('auditLimit').value || '100';
  const mine = ++auditSeq;
  try {
    const evs = await api(`/v1/events?limit=${encodeURIComponent(limit)}${agentId ? '&agentId=' + encodeURIComponent(agentId) : ''}`);
    if (mine === auditSeq) renderAudit(evs);
  } catch (e) { if (mine === auditSeq) $('auditList').innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
function auditDetail(e) {
  const d = e.detail;
  if (!d || typeof d !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(d)) {
    if (k === 'agentId' || v === null || v === undefined || v === '') continue;
    let val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (val.length > 90) val = val.slice(0, 90) + '…';
    parts.push(`${esc(k)}=${esc(val)}`);
    if (parts.length >= 5) break;
  }
  return parts.join(' · ');
}
function renderAudit(evs) {
  if (!evs.length) { $('auditList').innerHTML = '<div class="sub">No events recorded yet.</div>'; return; }
  $('auditList').innerHTML = evs.map(e => {
    const what = EVENT_WORDS[e.event] ?? e.label ?? e.event.replace(/[._]/g, ' ');
    const bad = /fail|missing|unhealthy|rolled_back/.test(e.event);
    const det = auditDetail(e);
    return `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
      <span style="color:var(--dim);white-space:nowrap;min-width:132px" title="${esc(e.at)}">${esc(new Date(e.at).toLocaleString())}</span>
      <span style="min-width:0;flex:1">
        <b>${esc(e.agentName ?? 'agent')}</b>
        <span style="color:${bad ? 'var(--bad)' : 'var(--text)'}"> ${esc(what)}</span>
        <code style="color:var(--dim);font-size:11px"> ${esc(e.event)}</code>
        ${det ? `<div class="sub" style="opacity:.85;margin-top:1px;word-break:break-word">${det}</div>` : ''}
      </span>
    </div>`;
  }).join('');
}

let usageAgentId = null;
// Per-1M-token list price [input, output], USD — only used to show API-key
// agents the model's rate so they can judge; never multiplied into a fake total.
const MODEL_PRICES = {
  'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5': [1, 5], 'claude-fable-5-2': [8, 40], 'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50],
};
// ---- Model prices (Settings → AI sources) ---------------------------------------
// GET /v1/model-prices: the server's own price list (pricing.ts), so the panel
// and every cost the app shows can never disagree. Opening it also refreshes
// MODEL_PRICES above from the server.
async function loadModelPrices() {
  const el = $('modelPrices'); if (!el) return;
  try {
    const d = await api('/v1/model-prices');
    for (const m of d.models || []) MODEL_PRICES[m.id] = [m.input, m.output];
    el.innerHTML = renderModelPrices(d);
  } catch (e) { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
/** Settings → AI sources, with the price list open (from Usage). */
function openModelPrices() {
  void openAiDlg('ai');
  const d = $('pricesDrawer');
  if (!d) return;
  if (d.open) void loadModelPrices(); else d.open = true; // opening fires its toggle, which loads
  d.scrollIntoView({ block: 'start' });
}
// ---- Budgets (Settings → AI sources → Budgets; orchestrator/usage/budgets.ts) -------
// GET /v1/budgets: each of your agents' spend this month against its budget,
// and the whole machine's budget for the machine owner. Saving one runs the
// budget check at once: a raised budget starts a paused agent again.
const bgMoney = (x) => (x >= 100 ? '$' + Math.round(x).toLocaleString('en-US') : '$' + (Math.round(x * 100) / 100).toFixed(2));
/** A month's or a pace's dollars, never a bare $0.00 for use with no known price (HB-0402). */
const bgCost = (x, unknown) => (!unknown ? bgMoney(x) : x > 0 ? `${bgMoney(x)} + <span class="bg-hi">no price known</span>` : '<span class="bg-hi">no price known</span>');
const bgSpentCost = (a) => bgCost(a.spent, !!a.unpriced && (a.unpriced.month > 0 || !!a.unpriced.model));
const bgLastCost = (a) => bgCost(a.lastMonth, !!a.unpriced && a.unpriced.last > 0);
const bgRateCost = (a) => bgCost(a.monthlyNow, !!a.unpriced?.rate);
const bgMonthName = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1, 15)).toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' });
/**
 * What is typed in the budget controls of `el` and not saved yet: each box or menu whose value is not the one it
 * was drawn with. Saving one row drew every row again from the server, and the others' drafts went (HB-1051). The
 * function returned puts them back into the controls drawn since, with the focus; `saved` names the controls of the
 * row just saved, which show what the server keeps. The rest show the server's values, as before.
 */
function bgDrafts(el, saved = []) {
  const typed = new Map();
  for (const f of el?.querySelectorAll('input[id^="bgUsd_"], input[id^="bgStep_"], select[id^="bgAt_"]') ?? []) {
    if (saved.includes(f.id) || f.disabled) continue;
    const drawn = f.tagName === 'SELECT' ? ([...f.options].find(o => o.defaultSelected) ?? f.options[0])?.value : f.defaultValue;
    if (f.value !== drawn) typed.set(f.id, f.value);
  }
  const focus = el?.contains(document.activeElement) && !saved.includes(document.activeElement.id) ? document.activeElement.id : '';
  return (into) => {
    for (const [id, v] of typed) { const f = into.querySelector(`[id="${id}"]`); if (f && !f.disabled) f.value = v; }
    if (focus) into.querySelector(`[id="${focus}"]`)?.focus();
  };
}
/**
 * Each read of All budgets is numbered and only the newest is drawn: two rows saved one after the other, and the first
 * one's read landing last drew the second row's old value in the box just saved (HB-1051). The rows saved by the reads
 * the newest replaced show what the server keeps too. Waiting for one a newer read replaced waits for that one's drawing.
 */
let budgetsSeq = 0, budgetsSaved = [], budgetsLatest = null;
function loadBudgets(saved = []) {
  const el = $('budgetsBody'); if (!el) return Promise.resolve();
  const mine = ++budgetsSeq;
  budgetsSaved = [...new Set([...budgetsSaved, ...saved])];
  return (budgetsLatest = drawBudgets(el, mine));
}
async function drawBudgets(el, mine) {
  try {
    const d = await api('/v1/budgets');
    if (mine !== budgetsSeq) return budgetsLatest;
    const keep = bgDrafts(el, budgetsSaved); // as they are now: typed while it was read too
    budgetsSaved = [];
    el.innerHTML = renderBudgets(d);
    keep(el);
  } catch (e) {
    if (mine !== budgetsSeq) return budgetsLatest;
    budgetsSaved = [];
    el.innerHTML = `<div class="sub">${esc(e.message)}</div>`;
  }
}
/** "$41.10 of $50 (82%) · on pace for $63" for a budget view. */
function bgState(v) {
  if (!v) return '';
  const pace = v.onPace && v.onPace > v.spent ? ` · on pace for ${bgMoney(v.onPace)}` : '';
  const cls = v.level ? ' class="bg-hi"' : '';
  return `<span${cls}>${bgMoney(v.spent)} of ${bgMoney(v.usd)} (${v.pct}%)</span>${pace}${v.paused?.staysStopped ? ' · <b>stopped</b>' : v.paused ? ' · <b>paused</b>' : v.downgraded ? ` · <b>on ${esc(v.downgraded.to.replace(/^.*\//, ''))}</b> until ${esc(v.resetsOn)}` : ''}`;
}
function bgControls(key, b, suggested, manager) {
  const usd = b ? b.usd : '';
  return `<input type="number" id="bgUsd_${key}" min="1" max="100000" step="1" value="${usd}" placeholder="${suggested ? 'e.g. ' + suggested : 'none'}" aria-label="Monthly budget in US dollars">
    <select id="bgAt_${key}" aria-label="At the limit"${manager ? ' disabled title="Your Hatchabot agent is never paused or moved to another model: its budget only warns."' : ''}>
      <option value="warn"${!b || b.atLimit === 'warn' ? ' selected' : ''}>warn me</option><option value="cheaper"${b?.atLimit === 'cheaper' ? ' selected' : ''}>cheaper model</option><option value="pause"${b?.atLimit === 'pause' ? ' selected' : ''}>pause it</option></select>
    <button ${onAction('click', 'saveBudget', [`${key}`, { $: 'el' }])}>Save</button>`;
}
/** "Tell me every $…": an input and Save; with the month so far when set. */
function bgStepControls(key, v) {
  return `<span class="bg-form"><span class="sub">every $</span><input type="number" id="bgStep_${key}" min="1" max="100000" step="1" value="${v ? v.every : ''}" placeholder="none" aria-label="Tell me each time it spends another this many dollars">
    <button ${onAction('click', 'saveStep', [`${key}`, { $: 'el' }])}>Save</button></span>`;
}
const bgStepState = (v) => v ? `next at ${bgMoney(v.next)}` : '';
/**
 * A budget input beside the Save that was pressed. The same agent's controls
 * can be on the page twice (Settings → Budgets and its own Usage tab, which
 * stays in the page after the sheet closes): by id alone, Save read the
 * other, stale copy and saved its values (deep review, 2026-10-09).
 */
const bgInput = (btn, id) => (btn?.parentElement?.querySelector(`[id="${id}"]`)) || $(id);
async function saveStep(key, btn) {
  const raw = bgInput(btn, 'bgStep_' + key)?.value.trim();
  const every = raw === '' ? null : Number(raw);
  if (every !== null && !(every >= 1 && every <= 100000)) return toast('A step is from $1 to $100,000 — or empty the box to stop the alerts.');
  try {
    const r = await api(key === 'machine' ? '/v1/spend-alert/machine' : `/v1/agents/${key}/spend-alert`, { method: 'PUT', body: { every } });
    toast(r.message || 'Saved.', 6000);
    if ($('budgetsBody') && $('budgetsDrawer')?.open) void loadBudgets(['bgStep_' + key]);
    if ($('v2BudgetRow')) void v2LoadBudgetRow($('v2BudgetRow').dataset.agent, ['bgStep_' + key]);
    await refresh(false);
  } catch (e) { toast(e.message, 8000); }
}
function renderBudgets(d) {
  const month = bgMonthName(d.month);
  const mine = (d.agents || []).filter((a) => a.state !== 'ARCHIVED');
  const bl = ' class="bg-l"';
  const cols = [['Agent'], [month], ['Last month'], ['A month now'], ['Tell me', mpLeft], ['Monthly limit', mpLeft]];
  const rows = mine.map((a) => mpRow(cols, [
    [`${esc(a.name)}${a.billing === 'plan' ? ' <span class="sub">(plan)</span>' : a.billing === 'local' ? ' <span class="sub">(local)</span>' : ''}`, bl],
    bgSpentCost(a), bgLastCost(a), bgRateCost(a),
    [`${bgStepControls(a.id, a.alertEvery)}${a.alertEvery ? `<div class="sub">${bgStepState(a.alertEvery)}</div>` : ''}`, bl],
    [`<div class="bg-form">${bgControls(a.id, a.budget, a.unpriced?.model ? 0 : a.suggested, a.manager)}</div>${a.budget && !(a.unpriced?.model && !a.spent) ? `<div class="sub">${bgState(a.budget)}</div>` : ''}${a.priceNote ? `<div class="sub bg-hi" style="font-weight:400">${esc(a.priceNote)}</div>` : ''}${a.chatNote && (a.budget || a.alertEvery) ? `<div class="sub bg-hi" style="font-weight:400">${esc(a.chatNote)}</div>` : ''}`, bl]])).join('');
  const m = d.machine;
  const machine = m ? `<div class="pair" style="margin:0 0 10px;flex-wrap:wrap;gap:8px;align-items:center"><b>This whole Hatchabot</b>
      <span class="sub">${bgMoney(m.spent)} in ${esc(month)} so far · ${bgMoney(m.lastMonth)} last month · every agent, everyone's</span>
      <div class="bg-form" style="flex-basis:100%"><span class="sub">Tell me</span>${bgStepControls('machine', m.alertEvery)}${m.alertEvery ? `<span class="sub">${bgStepState(m.alertEvery)}</span>` : ''}</div>
      <div class="bg-form" style="flex-basis:100%"><span class="sub">Monthly limit</span>${bgControls('machine', m.budget, 0, false)}${m.budget ? `<span class="sub">${bgState(m.budget)}</span>` : ''}</div>
      <div class="sub" style="flex-basis:100%">Here "pause it" pauses, and "cheaper model" moves, every agent but your Hatchabot agent when the machine reaches its budget.</div>${m.priceNote ? `<div class="sub bg-hi" style="flex-basis:100%;font-weight:400">${esc(m.priceNote)}</div>` : ''}${m.chatNote && (m.budget || m.alertEvery) ? `<div class="sub bg-hi" style="flex-basis:100%;font-weight:400">${esc(m.chatNote)}</div>` : ''}</div>` : '';
  return `${machine}<div class="mp-wrap"><table class="mp-tbl bg-tbl">${mpHead(cols)}
    <tbody>${rows || '<tr><td colspan="6" class="sub">No agents yet.</td></tr>'}</tbody></table></div>
    <p class="sub mp-note">US dollars at API list prices, the same as the cost badges — on a Claude plan it is an equivalent, not a bill. <b>Tell me every $…</b>: a message (at most one an hour per agent) and a line under Alerts each time this month's spend passes another step — at $100, $200, $300 … for 100; it counts from when you set it, and starts again each month. A model with no known price shows "no price known", not $0, and a limit cannot be enforced on what it costs. <b>Monthly limit</b>: you hear at 80% and at 100% (under Alerts, and once on your Hatchabot agent's chat). <b>Cheaper model</b> moves it at 100% to the cheapest model its AI source offers until the 1st — it keeps answering; raise the budget to switch it back sooner (change its model yourself and the budget leaves it alone). <b>Pause it</b> stops the agent at 100% until the 1st — raise the budget or start it to bring it back sooner (started by hand, it runs on until the 1st); anyone who writes to it on Telegram gets one reply saying so. Empty a box and Save to remove a budget.</p>`;
}
async function saveBudget(key, btn) {
  const raw = bgInput(btn, 'bgUsd_' + key)?.value.trim();
  const usd = raw === '' ? null : Number(raw);
  if (usd !== null && !(usd >= 1 && usd <= 100000)) return toast('A budget is from $1 to $100,000 a month — or empty the box to remove it.');
  const at = bgInput(btn, 'bgAt_' + key)?.value;
  const atLimit = ['pause', 'cheaper'].includes(at) ? at : 'warn';
  try {
    const r = await api(key === 'machine' ? '/v1/budgets/machine' : `/v1/agents/${key}/budget`, { method: 'PUT', body: { usd, atLimit } });
    toast(r.message || 'Saved.', 6000);
    const row = ['bgUsd_' + key, 'bgAt_' + key];
    if ($('budgetsBody') && $('budgetsDrawer')?.open) void loadBudgets(row);
    if ($('v2BudgetRow')) void v2LoadBudgetRow($('v2BudgetRow').dataset.agent, row);
    await refresh(false);
  } catch (e) { toast(e.message, 8000); }
}
/** The agent sheet's Usage tab: its budget, editable in place. `saved`: as loadBudgets. */
async function v2LoadBudgetRow(id, saved = []) {
  const el = $('v2BudgetRow'); if (!el || el.dataset.agent !== id) return;
  try {
    const d = await api('/v1/budgets');
    const a = (d.agents || []).find((x) => x.id === id);
    if (!a || $('v2BudgetRow')?.dataset.agent !== id) return;
    const keep = bgDrafts(el, saved);
    el.innerHTML = `<div class="bg-rows">
        <span class="sub">Tell me</span><div class="bg-form">${bgStepControls(id, a.alertEvery)}${a.alertEvery ? `<span class="sub">${bgStepState(a.alertEvery)}</span>` : ''}</div>
        <span class="sub">Limit</span><div class="bg-form">${bgControls(id, a.budget, a.unpriced?.model ? 0 : a.suggested, a.manager)}</div>
      </div>
      ${a.priceNote ? `<div class="sub bg-hi" style="margin-top:8px;font-weight:400">${esc(a.priceNote)}</div>` : ''}
      ${a.chatNote && (a.budget || a.alertEvery) ? `<div class="sub bg-hi" style="margin-top:8px;font-weight:400">${esc(a.chatNote)}</div>` : ''}
      <div class="sub" style="margin-top:8px">${a.budget && !(a.unpriced?.model && !a.spent) ? bgState(a.budget) + ' · ' : ''}${bgSpentCost(a)} in ${esc(bgMonthName(d.month))} so far, ${bgLastCost(a)} last month, about ${bgRateCost(a)} a month at its pace now (API prices${a.billing === 'plan' ? '; on your Claude plan an equivalent' : ''}).${a.alertEvery || a.budget || a.unpriced?.model ? '' : ` Every $${Math.max(1, Math.round(a.suggested / 4))} would tell you a few times a month.`} <a href="#" ${onAction('click', 'openBudgets', [], 'prevent')}>All budgets</a></div>`;
    keep(el);
  } catch (e) { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
/** Settings → AI sources, with Budgets open. */
function openBudgets() {
  void openAiDlg('ai');
  const d = $('budgetsDrawer'); if (!d) return;
  if (d.open) void loadBudgets(); else d.open = true;
  d.scrollIntoView({ block: 'start' });
}
/**
 * A wide table (.mp-tbl) is built from one list of its columns, [heading,
 * th attributes]: mpHead draws the headings, mpRow a row, each cell after the
 * first named after its column (data-label), which a phone shows as a card per
 * row with the values named (HB-0613). A cell is its HTML, or [HTML, td attributes].
 */
// The wide tables' alignments: a name to the left, a figure to the right in even digits on one line.
const mpLeft = ' style="text-align:left"';
const mpNum = 'text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap';
const mpHead = (cols) => `<thead><tr>${cols.map(([h, a = '']) => `<th${a}>${esc(h)}</th>`).join('')}</tr></thead>`;
const mpRow = (cols, cells, attrs = '') => `<tr${attrs}>${cells.map((c, i) => {
  const [html, a = ''] = Array.isArray(c) ? c : [c];
  // A phone names each value after its column (data-label); an empty cell is left unnamed.
  return `<td${a}${i && cols[i] && String(html ?? '').trim() ? ` data-label="${esc(cols[i][0])}"` : ''}>${html}</td>`;
}).join('')}</tr>`;
/** $5, $6.25, $0.50, $0.025: as many places as the price has, at least two after a point. */
const mpUsd = (x) => '$' + (Number.isInteger(x) ? String(x) : (Math.round(x * 100) === x * 100 ? x.toFixed(2) : String(+x.toFixed(4))));
const mpShare = (x) => `${+x.toFixed(4)}×`;
function renderModelPrices(d) {
  const cols = [['Model'], ['Input'], ['Output'], ['Cache read'], ['Cache write (5 min)']];
  const rows = (d.models || []).map((m) => mpRow(cols, [`${esc(m.label)}${m.legacy ? ' <span class="sub">(older)</span>' : ''}${m.limited ? ' <span class="sub">(invitation only)</span>' : ''}`,
    mpUsd(m.input), mpUsd(m.output), mpUsd(m.cacheRead), mpUsd(m.cacheWrite)], ` class="${m.legacy ? 'mp-old' : ''}"`)).join('');
  const odd = (d.models || []).filter((m) => !m.legacy && m.cacheReadShare !== d.cacheReadDefault).map((m) => `${mpShare(m.cacheReadShare)} on ${esc(m.label)}`);
  const when = (() => { const t = Date.parse(d.checked + 'T12:00:00Z'); return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : esc(d.checked); })();
  const link = /^https:\/\//.test(d.source || '') ? `<a href="${esc(d.source)}" target="_blank" rel="noopener">Anthropic's pricing page</a>` : "Anthropic's pricing page";
  // The worked example, figured from the list itself.
  const ex = (d.models || []).find((m) => m.id === 'claude-opus-4-8');
  const conv = 300_000, answer = 1_000;
  const c2 = (x) => '$' + x.toFixed(2);
  const example = ex ? `<p class="sub mp-note">For example, on ${esc(ex.label)} with a 300,000-token conversation: the part read from the cache costs about <b>${c2(conv * ex.cacheRead / 1e6)}</b> a message;
    written again after a pause, about <b>${c2(conv * ex.cacheWrite / 1e6)}</b>; an answer of 1,000 tokens about <b>${c2(answer * ex.output / 1e6)}</b>.</p>` : '';
  const unpriced = (d.unpriced || []).length
    ? `<p class="sub mp-note">No price known: ${d.unpriced.map((m) => `<code>${esc(m)}</code>`).join(', ')} — their use shows as "no price known", never as $0.</p>`
    : '<p class="sub mp-note">A model not on this list has no price known: its use shows as "no price known", never as $0.</p>';
  return `<div class="mp-wrap"><table class="mp-tbl">${mpHead(cols)}<tbody>${rows}</tbody></table></div>
    <p class="sub mp-note">US dollars per million tokens. Cache read = ${mpShare(d.cacheReadDefault)} the input price${odd.length ? ` (${odd.join(', ')})` : ''}; cache write = ${mpShare(d.cacheWrite)} input.
      Checked against ${link} on ${esc(when)}. Every cost in Hatchabot (Usage, the home screen's $/wk badges, Right-size) is figured from this list.</p>
    <h4 class="v2sec" style="margin:12px 0 4px">How caching changes the price</h4>
    <p class="sub mp-note">Every message re-sends the whole conversation to the model. Within about 5 minutes of the last one, the part it has already seen is
      <b>read from Anthropic's cache</b> at a tenth of the input price (less on the models above). After a longer pause — or when the start of the prompt changes —
      the whole conversation is <b>written to the cache again</b>, at 1.25× the input price. So quick back-and-forth is cheap, a message after a long pause in a
      very long conversation is the expensive moment, and long conversations cost more on every turn.</p>
    ${example}
    <p class="sub mp-note">Local models${(d.local || []).length ? ` (${d.local.map((m) => `<code>${esc(m)}</code>`).join(', ')})` : ''}: $0 — their calls run on your own machine.</p>
    ${unpriced}`;
}

function fmtTokens(n) {
  const v = Number(n) || 0; // guard undefined/NaN/string → "0" not "undefined"
  if (v >= 1e9) return (v / 1e9).toFixed(v >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return String(v);
}
function fmtUsd(n) { return '$' + (n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)); }
function billingLine(agentId, models) {
  const a = (agents ?? []).find(x => x.id === agentId);
  const p = (profiles ?? []).find(x => x.id === a?.aiProfileId);
  if (!p) return '';
  if (p.vendor === 'local') return 'local model — no API cost';
  if (p.kind === 'subscription') return `included (${esc(p.name)})`;
  // By the model's own id, as the server prices it (modelKey): a transcript's
  // "anthropic/…" prefix or dated id found no price (HB-0067).
  const priced = models.map(m => MODEL_PRICES[modelKeyOf(m)] ? `${esc(m)} at $${MODEL_PRICES[modelKeyOf(m)][0]}/$${MODEL_PRICES[modelKeyOf(m)][1]} per 1M in/out` : null).filter(Boolean);
  return priced.length ? priced.join(' · ') : 'API key';
}
async function openUsage(id, name) {
  usageAgentId = id;
  $('usageAgent').textContent = name;
  $('usageBody').innerHTML = 'Loading…';
  usageDlg.showModal();
  await loadUsage();
}
async function loadUsage() {
  if (!usageAgentId) return;
  const forId = usageAgentId;
  try {
    const u = await api(`/v1/agents/${forId}/usage`);
    if (usageAgentId === forId) renderUsage(u);
  } catch (e) { if (usageAgentId === forId) $('usageBody').innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
// ---- Spend over time (GET /v1/usage/spend): the same chart for all agents and for one ----
// Stacked bars of what each slice cost at API prices — cache writes, cache
// reads, output, new input (left axis, dollars) — and the tokens behind it as
// a line on the right axis (Chris asked for the second axis, 2026-10-05).
const SPEND_PARTS = [['cacheWrite', 'Cache writes', '#c9822b'], ['cacheRead', 'Cache reads', '#4f9a8f'], ['output', 'Output', '#7a6fd6'], ['input', 'New input', '#8a8f98']];
/** A phone-wide screen: the width the stylesheet's phone rules start at. */
const phoneQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 640px)') : null;
function isPhone() {
  return !!phoneQuery?.matches;
}
// The same windows, and words, as View by → Cost's pills (V2_COST_PERIODS; Chris, 2026-10-06).
const SPEND_RANGE_LABELS = [['1h', '1 hr'], ['3h', '3 hr'], ['6h', '6 hr'], ['9h', '9 hr'], ['12h', '12 hr'], ['day', '1 day'], ['week', '1 wk'], ['month', '1 mo']];
const SPEND_RANGE_WORDS = { '1h': ['the last hour', '1 hour'], '3h': ['the last 3 hours', '3 hours'], '6h': ['the last 6 hours', '6 hours'], '9h': ['the last 9 hours', '9 hours'], '12h': ['the last 12 hours', '12 hours'], day: ['the last 24 hours', '24 hours'], week: ['the last 7 days', '7 days'], month: ['the last 30 days', '30 days'] };
let spendRange = (() => { try { const v = localStorage.getItem('hb-spend-range'); return SPEND_RANGE_LABELS.some(([k]) => k === v) ? v : 'week'; } catch { return 'week'; } })();
/** A box the loader fills; agentId '' = every agent of yours. */
const spendChartBox = (agentId) => `<div class="spendchart" data-agent="${esc(agentId || '')}"><div class="sub">Loading…</div></div>`;
function setSpendRange(r, btn) {
  spendRange = SPEND_RANGE_LABELS.some(([k]) => k === r) ? r : 'week';
  try { localStorage.setItem('hb-spend-range', spendRange); } catch {}
  const box = btn?.closest('.spendchart');
  if (box) void loadSpendChart(box);
}
async function loadSpendCharts(root) { for (const el of (root || document).querySelectorAll('.spendchart:not([data-lazy])')) void loadSpendChart(el); }
// Each chart's reads numbered: a slow week's answer after the day's replaced
// it, and a fleet-wide total came back under one picked agent's name (audit #065).
let spendChartSeq = 0;
/** `reread`: the poll's; a chart already drawn stays when it fails, with a note (HB-0474). */
async function loadSpendChart(el, reread = false) {
  const agent = el.dataset.agent, source = el.dataset.source;
  const gen = String(++spendChartSeq);
  el.dataset.gen = gen;
  const current = () => el.isConnected && el.dataset.gen === gen;
  try {
    const sel = source ? `&source=${encodeURIComponent(source)}` : !agent && spendAgents.length ? `&agents=${encodeURIComponent(spendAgents.join(','))}` : '';
    // The page's zone: day bars start at its midnight, as their labels read (audit, 2026-10-20).
    let tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
    const d = await api(`/v1/usage/spend?range=${spendRange}${agent ? `&agent=${encodeURIComponent(agent)}` : sel}${tz ? `&tz=${encodeURIComponent(tz)}` : ''}`);
    if (current()) { el._spend = { d, agent, source }; drawSpendChart(el); }
  } catch (e) {
    if (!current()) return;
    // The poll's read failed: the chart drawn stays, with a note (HB-0474); drawn again, it goes.
    if (reread && el.querySelector('svg')) { el.querySelector('.spendstale')?.remove(); el.insertAdjacentHTML('beforeend', `<div class="sub spendstale">Not read again just now: ${esc(e.message)}</div>`); return; }
    // No chart to fit: let go, as spendChartsPrune does.
    el._spend = null; spendChartFit?.unobserve(el); spendChartsSeen.delete(el);
    el.innerHTML = `<div class="sub">${esc(e.message)}</div>`;
  }
}
/**
 * Draws el's chart from its last read. All of it but the picture first, so
 * the picture's own box, inside its card, is there to measure; then the
 * picture, once, at that width (spendChartWidth).
 */
function drawSpendChart(el) {
  const s = el._spend; if (!s) return;
  el.innerHTML = spendChartHTML(s.d, { fleet: !s.agent && !s.source, byAgent: !!s.source, picture: false }) + ((s.agent || s.source) && s.d.planShare > 0 ? '<div class="sub" style="margin-top:2px">* Claude plan use priced at API rates — not money you pay.</div>' : '');
  s.W = spendChartWidth(el); s.boxW = el.clientWidth;
  const pic = el.querySelector('.spendsvg');
  if (pic) pic.innerHTML = spendChartSVG(s.d, s.W);
  // Watched even if its dialog closed before the answer came: the next close lets it go. Charts
  // replaced since (a view drawn again) are let go now, not kept until a refit or a close.
  spendChartsPrune();
  spendChartsSeen.add(el); spendChartFit?.observe(el);
}
/**
 * How wide a chart is drawn: its picture's box (the inside of its card), at
 * most 640 — so its words are the page's size wherever it is. Drawn 640 wide
 * and scaled down to a phone they were 4–5 px high (HB-0614). A box that is
 * hidden (a Settings tab not showing) has no width: 640 until it shows and
 * spendChartFit fits it.
 */
function spendChartWidth(el) {
  const w = el.querySelector('.spendsvg')?.clientWidth;
  return w ? Math.max(220, Math.min(640, w)) : 640;
}
// The charts drawn, for spendChartFit to watch.
const spendChartsSeen = new Set();
/**
 * Lets go of the charts gone from the page (a view drawn again), and of those
 * inside `root`, a dialog that closed: unwatched and their read dropped; a
 * closed dialog's go back to "Loading…", so one opened again does not show a
 * chart that no longer fits until it draws its charts anew. Run at each
 * drawing and refit, and as a dialog closes.
 */
function spendChartsPrune(root) {
  for (const el of spendChartsSeen) {
    if (el.isConnected && !root?.contains(el)) continue;
    spendChartFit?.unobserve(el); spendChartsSeen.delete(el);
    el._spend = null;
    if (el.isConnected) el.innerHTML = '<div class="sub">Loading…</div>';
  }
}
// A close event comes after the dialog closed: one opened again since keeps its new charts.
document.addEventListener('close', (e) => { if (e.target?.tagName === 'DIALOG' && !e.target.open) spendChartsPrune(e.target); }, true);
/**
 * Draws again the chart part of each of `els` (the boxes spendChartResized
 * heard change width) whose width to draw at has changed: a phone turned on
 * its side, a window narrowed or widened, a chart drawn while its tab was
 * hidden and now showing. Only its picture: the agent picker and the range
 * buttons stay as they are, open or not. Every width is read before any
 * picture is written, so the page is laid out once.
 */
function spendChartsRefit(els) {
  spendChartsPrune();
  const fits = [];
  for (const el of [...els]) {
    const s = el._spend;
    if (!s || !el.isConnected) continue;
    // Hidden: fitted when it shows, whatever width it shows at.
    if (!el.clientWidth) { s.boxW = 0; continue; }
    s.boxW = el.clientWidth;
    const W = spendChartWidth(el), pic = el.querySelector('.spendsvg');
    if (W !== s.W) fits.push([s, W, pic]);
  }
  for (const [s, W, pic] of fits) { s.W = W; if (pic) pic.innerHTML = spendChartSVG(s.d, W); }
}
// The boxes whose width changed, waiting for the next frame.
const spendChartsDue = new Set();
/**
 * spendChartFit's answer: each box whose width changed (not only its height,
 * as drawing it changes it) is fitted in the next frame. Drawing inside the
 * observer changed the box's height, and the browser reported a loop.
 */
function spendChartResized(entries) {
  const waiting = spendChartsDue.size;
  for (const e of entries) if (e.target._spend && e.target.clientWidth !== e.target._spend.boxW) spendChartsDue.add(e.target);
  if (waiting || !spendChartsDue.size) return;
  requestAnimationFrame(() => { const els = [...spendChartsDue]; spendChartsDue.clear(); spendChartsRefit(els); });
}
const spendChartFit = typeof ResizeObserver === 'function' ? new ResizeObserver(spendChartResized) : null;
/** A round axis top at or above x: 1, 2, 2.5 or 5 × a power of ten. */
function niceTop(x) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= x);
}
/** What a cost chart's parts all say: its totals, its range in words, and what one bar is. */
function spendChartWords(d) {
  return {
    t: d.totals || {},
    rangeName: SPEND_RANGE_WORDS[d.range]?.[0] || '',
    slice: d.bucketHours === 24 ? 'day' : d.bucketHours === 1 ? 'hour' : `${d.bucketHours} hours`,
  };
}
function spendChartHTML(d, opts = {}) {
  const words = spendChartWords(d), { t, rangeName, slice } = words;
  const star = d.planShare > 0 ? '*' : '';
  // Header: which agents (all of yours, or the ones you tick), and the range.
  const choices = d.choices || [];
  const picked = (spendAgents || []).filter((id) => choices.some((c) => c.id === id));
  const label = !picked.length ? 'All agents' : picked.length === 1 ? choices.find((c) => c.id === picked[0]).name : `${picked.length} agents`;
  const picker = opts.fleet && choices.length > 1 ? `<details class="spendpick"${spendPickOpen ? ' open' : ''} ${onAction('toggle', 'noteSpendPickOpen', [{ $: 'open' }])}><summary>${esc(label)} ▾</summary>
      <div class="spendpick-list">
        <label><input type="checkbox" ${picked.length ? '' : 'checked'} ${onAction('change', 'spendPickAll', [{ $: 'el' }])}> All agents</label>
        ${choices.map((c) => `<label><input type="checkbox" value="${esc(c.id)}" ${picked.includes(c.id) ? 'checked' : ''} ${onAction('change', 'spendPickOne', [{ $: 'el' }])}> ${esc(c.name)} <span class="sub">${c.cost ? v2Money(c.cost) : '—'}</span></label>`).join('')}
        <div style="text-align:right;margin-top:4px"><button class="hbtn" ${onAction('click', 'spendPickClose')}>Done</button></div>
      </div></details>` : '';
  const pills = SPEND_RANGE_LABELS.map(([k, l]) => `<button class="su-period${k === d.range ? ' on' : ''}" aria-pressed="${k === d.range}" ${onAction('click', 'setSpendRange', [`${k}`, { $: 'el' }])}>${l}</button>`).join('');
  // No summary line (Chris, 2026-10-05): the total is in the pies, the tokens in the chart, the monthly pace under it.
  const head = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:2px 0 8px">${picker}<span class="su-periods" style="margin:0">${pills}</span></div>`;
  // Two pies (2026-10-05): what it went on, and by model — each with its amounts and shares beside it.
  const total = t.cost || 0;
  const range = SPEND_RANGE_WORDS[d.range]?.[1] || '';
  const partSlices = SPEND_PARTS.map(([k, l, c]) => ({ label: l, value: t[k] || 0, color: c }));
  const modelSlices = modelPieSlices(d.models || []);
  // Tokens on a model with no known price are in the tokens, not the dollars: the
  // amount is partial ($4.20+) or, with nothing priced, unknown — never $0 (audit #062).
  const unpriced = d.unpriced?.tokens > 0 ? d.unpriced : null;
  const big = unpriced && !(total > 0) ? 'No price' : `${v2Money(total)}${unpriced ? '+' : ''}${star}`;
  const block = (title, slices) => `<div style="display:flex;flex-direction:column;gap:4px;min-width:0">
      <div class="sub" style="font-size:12px">${title}</div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${donutHTML(slices, total, big, range, title)}${pieLegend(slices, total)}</div></div>`;
  // A source with nothing spent in the range: say so, no empty pies (2026-10-07).
  if (opts.byAgent && !(t.cost > 0) && !(t.tokens > 0)) return head + `<div class="sub">Nothing spent at API prices in ${esc(rangeName || 'this range')}.</div>`;
  // By agent (an AI source's chart): who spends on this source, the biggest seven and the rest.
  const agentSlices = opts.byAgent ? agentPieSlices(d.choices || []) : [];
  const unpricedNote = unpriced ? `<div class="sub spend-unpriced" style="flex-basis:100%">⚠ ${fmtTokens(unpriced.tokens)} tokens on ${(unpriced.models || []).map((m) => `<code>${esc(m)}</code>`).join(', ') || 'a model'} with no price known: not in the dollars here, so ${total > 0 ? 'the amount is only part of it' : 'the amount is unknown'} — never $0.</div>` : '';
  const summary = `<div class="ucard" style="display:flex;gap:18px 34px;flex-wrap:wrap">${block('What it went on', partSlices)}${modelSlices.length ? block('By model', modelSlices) : ''}${agentSlices.length ? block('By agent', agentSlices) : ''}${unpricedNote}</div>`;
  // opts.picture false: its box left empty, for drawSpendChart to measure and fill.
  const chart = `<div class="ucard"><div class="spendsvg" style="overflow-x:auto">${opts.picture === false ? '' : spendChartSVG(d, 640, words)}</div>
    <div class="sub" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0 4px"><span style="width:14px;height:0;border-top:2px solid var(--text);opacity:.75;display:inline-block"></span>Tokens (right axis); bars are what each ${slice} cost (left axis)${d.range !== 'month' && d.monthly ? ` · ≈ ${v2Money(d.monthly)}${unpriced ? '+' : ''}${star} a month at this pace` : ''}${d.refused ? ` · <span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:var(--dim);opacity:.35;vertical-align:middle"></span> shaded: <b>${fmtN(d.refused)}</b> call${d.refused === 1 ? '' : 's'} refused (rate limit)` : ''}</div></div>`;
  return head + summary + chart;
}
/**
 * The cost chart's picture over time: stacked bars (left axis, dollars),
 * tokens as a line (right axis), W wide (spendChartWidth: its card's inside,
 * 640 at most). Drawn again on its own when the width changes (spendChartsRefit).
 */
function spendChartSVG(d, W, { t, rangeName, slice } = spendChartWords(d)) {
  const b = d.buckets || [];
  const cost = (x) => SPEND_PARTS.reduce((sum, [k]) => sum + (x[k] || 0), 0);
  const narrow = W < 640, H = 224, L = 46, R2 = 50, T = 24, B = 24, iw = W - L - R2, ih = H - T - B;
  const topC = niceTop(Math.max(0, ...b.map(cost))), topT = niceTop(Math.max(0, ...b.map((x) => x.tokens)));
  const n = Math.max(1, b.length), slot = iw / n, bw = Math.max(1.5, slot * 0.72);
  const yC = (v) => T + ih - (v / topC) * ih, yT = (v) => T + ih - (v / topT) * ih;
  // Axis ticks sit on round values (0, half, top of 1/2/2.5/5 × 10^k): say them as they are — $12.5, not $13; $0, not $0.00.
  const money = (v) => v === 0 ? '$0' : `$${+v.toPrecision(3)}`;
  const grid = [0, 0.5, 1].map((fr) => `<line x1="${L}" x2="${W - R2}" y1="${yC(topC * fr)}" y2="${yC(topC * fr)}" style="stroke:var(--line)" stroke-width="1"${fr ? ' stroke-dasharray="3 3"' : ''}/>
    <text x="${L - 6}" y="${yC(topC * fr) + 4}" text-anchor="end" font-size="11" style="fill:var(--dim)">${money(topC * fr)}</text>
    <text x="${W - R2 + 6}" y="${yC(topC * fr) + 4}" font-size="11" style="fill:var(--dim)">${fmtTokens(topT * fr)}</text>`).join('');
  const when = (iso) => { const x = new Date(iso); return d.bucketHours === 1 ? x.toLocaleTimeString([], { hour: 'numeric' }) : d.range === 'week' ? x.toLocaleDateString([], { weekday: 'short' }) : x.toLocaleDateString([], { month: 'short', day: 'numeric' }); };
  // Six labels under the bars, fewer where they would run into each other (a phone): about 50 px each.
  const every = Math.max(1, Math.round(n / Math.min(6, Math.max(2, Math.floor(iw / 50)))));
  const xl = b.map((x, i) => (i % every === 0 && i < n - every / 2) ? `<text x="${L + i * slot + slot / 2}" y="${H - 6}" text-anchor="middle" font-size="11" style="fill:var(--dim)">${esc(when(x.at))}</text>` : '').join('');
  const bars = b.map((x, i) => {
    let y = T + ih;
    const segs = SPEND_PARTS.map(([k, , c]) => { const h = ((x[k] || 0) / topC) * ih; if (h <= 0) return ''; y -= h; return `<rect x="${L + i * slot + (slot - bw) / 2}" y="${y}" width="${bw}" height="${h}" fill="${c}"/>`; }).join('');
    const tip = `${new Date(x.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' })} — ≈ ${v2Money(cost(x))}: ${SPEND_PARTS.map(([k, l]) => `${l.toLowerCase()} ${v2Money(x[k] || 0)}`).join(', ')}; ${fmtTokens(x.tokens)} tokens`;
    // A source's refusals (rate limit): the slice greyed over, top to bottom, the count in its tip (Chris, 2026-10-07).
    const no = x.refused ? `<rect x="${L + i * slot}" y="${T}" width="${slot}" height="${ih}" style="fill:var(--dim)" fill-opacity=".22" pointer-events="none"/>` : '';
    const tip2 = x.refused ? `${tip} — ${x.refused} call${x.refused === 1 ? '' : 's'} refused (rate limit)` : tip;
    return `<g>${segs}${no}<rect x="${L + i * slot}" y="${T}" width="${slot}" height="${ih}" fill="transparent"><title>${esc(tip2)}</title></rect></g>`;
  }).join('');
  const pts = b.map((x, i) => `${(L + i * slot + slot / 2).toFixed(1)},${yT(x.tokens).toFixed(1)}`).join(' ');
  const line = b.length ? `<polyline points="${pts}" fill="none" style="stroke:var(--text)" stroke-opacity=".75" stroke-width="1.6" stroke-linejoin="round" pointer-events="none"/>` : '';
  // The range's tokens in all, over the token axis, inside the chart.
  const tokTotal = `<text x="${narrow ? W - 2 : W - R2}" y="12" text-anchor="end" font-size="12" style="fill:var(--text)"><tspan font-weight="700">${fmtTokens(t.tokens || 0)}</tspan> tokens in ${esc(rangeName)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;display:block" role="img" aria-label="Spend at API prices per ${slice}, by part, with tokens as a line">${tokTotal}${grid}${bars}${line}${xl}</svg>`;
}
/** A donut of slices ({ label, value, color }), the total in the middle; a hover tip per slice. `fmt` says a value (dollars unless given). */
function donutHTML(slices, total, big, small, label, fmt = v2Money) {
  const R = 54, SW = 22, C = 2 * Math.PI * R;
  const live = slices.filter((x) => x.value > 0);
  let at = 0;
  const arcs = total > 0 && live.length ? live.map((x) => {
    const len = (x.value / total) * C, gap = live.length > 1 ? Math.min(2, len / 3) : 0;
    const seg = `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${x.color}" stroke-width="${SW}" stroke-dasharray="${Math.max(0, len - gap)} ${C}" stroke-dashoffset="${-at}" transform="rotate(-90 70 70)"><title>${esc(x.label)}: ${fmt(x.value)} (${Math.round(x.value / total * 100)}%)</title></circle>`;
    at += len; return seg;
  }).join('') : `<circle r="${R}" cx="70" cy="70" fill="none" style="stroke:var(--line)" stroke-width="${SW}"/>`;
  return `<svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="${esc(label)}" style="flex:none">${arcs}
    <text x="70" y="68" text-anchor="middle" font-size="17" font-weight="700" style="fill:var(--text)">${big}</text>
    <text x="70" y="86" text-anchor="middle" font-size="11" style="fill:var(--dim)">${esc(small)}</text></svg>`;
}
/** The rows beside a donut: colour, name, amount, share. */
function pieLegend(slices, total, fmt = v2Money) {
  return `<div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:4px 10px;align-items:center;font-size:13px;min-width:190px">${slices.map((x) =>
    `<span style="width:10px;height:10px;border-radius:2px;background:${x.color}"></span><span style="overflow-wrap:anywhere">${esc(x.label)}</span><span style="text-align:right;font-variant-numeric:tabular-nums">${fmt(x.value)}</span><span class="sub" style="text-align:right;font-variant-numeric:tabular-nums">${total ? (x.value / total < 0.01 && x.value > 0 ? '<1' : Math.round(x.value / total * 100)) : 0}%</span>`).join('')}</div>`;
}
// By model: the validated categorical palette (dataviz reference, slots 1–8),
// each model pinned to a slot so its colour follows it from one view to the
// next; two in one chart on the same slot: the later takes the next free one.
const MODEL_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const MODEL_SLOT = { 'claude-opus-4-8': 0, 'claude-sonnet-5': 1, 'claude-fable-5': 2, 'claude-haiku-4-5': 3, 'claude-opus-4-7': 4, 'claude-opus-5': 5, 'claude-sonnet-4-6': 6, 'claude-opus-5-5': 7,
  'claude-sonnet-5-5': 5, 'claude-fable-5-1': 2, 'claude-opus-4-6': 4 };
/** By agent: the categorical palette in order of spend, the rest folded into one grey slice. */
function agentPieSlices(choices) {
  const spent = choices.filter((c) => c.cost > 0).sort((x, y) => y.cost - x.cost);
  const top = spent.slice(0, 7), rest = spent.slice(7);
  const out = top.map((c, i) => ({ label: c.name, value: c.cost, color: MODEL_COLORS[i] }));
  if (rest.length) out.push({ label: `${rest.length} other${rest.length === 1 ? '' : 's'}`, value: rest.reduce((t, c) => t + c.cost, 0), color: '#9aa0a6' });
  return out;
}
function modelPieSlices(models) {
  const top = models.slice(0, 7), rest = models.slice(7);
  const used = new Set();
  const out = top.map((m) => {
    let slot = MODEL_SLOT[m.model];
    if (slot === undefined) { let h = 0; for (const ch of m.model) h = (h * 31 + ch.charCodeAt(0)) >>> 0; slot = h % MODEL_COLORS.length; }
    while (used.has(slot)) slot = (slot + 1) % MODEL_COLORS.length;
    used.add(slot);
    return { label: m.model.replace(/^claude-/, ''), value: m.cost, color: MODEL_COLORS[slot] };
  });
  if (rest.length) out.push({ label: `${rest.length} other${rest.length === 1 ? '' : 's'}`, value: rest.reduce((t, m) => t + m.cost, 0), color: '#9aa0a6' });
  return out;
}
// The fleet chart's agents: all (empty) or the ones ticked; remembered per browser.
let spendAgents = (() => { try { const v = JSON.parse(localStorage.getItem('hb-spend-agents') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })();
let spendPickOpen = false;
function spendSaveAgents(el) {
  try { localStorage.setItem('hb-spend-agents', JSON.stringify(spendAgents)); } catch {}
  const box = el.closest('.spendchart'); if (box) void loadSpendChart(box);
}
function spendPickAll(cb) { spendAgents = []; spendSaveAgents(cb); }
/** Close the picker: Done, a click anywhere else, or Escape (it stayed open, 2026-10-05). */
function spendPickClose() {
  spendPickOpen = false;
  for (const d of document.querySelectorAll('.spendpick[open]')) d.open = false;
}
document.addEventListener('click', (e) => { if (document.querySelector('.spendpick[open]') && !e.target.closest?.('.spendpick')) spendPickClose(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.querySelector('.spendpick[open]')) spendPickClose(); });
function spendPickOne(cb) {
  const ids = [...cb.closest('.spendpick-list').querySelectorAll('input[value]:checked')].map((x) => x.value);
  spendAgents = ids;
  spendSaveAgents(cb);
}
function renderUsage(u) { $('usageBody').innerHTML = usageHTML(u, usageAgentId); void loadSpendCharts($('usageBody')); }
function usageHTML(u, agentId) {
  // Skill practice counts as the agent's own calls (HB-0933): an agent that has only practised has used something.
  const practice = u.practice && u.practice.runs ? u.practice : null;
  if (!u.sessions && !practice) return '<div class="sub">No sessions yet — nothing used.</div>';
  const byModel = u.byModel || [];
  const models = [...new Set([...byModel.map(m => m.model), ...(practice?.byModel || []).map(m => m.model)])];
  const n = (x) => Number(x) || 0;
  const rows = byModel.map(m => `<div class="pair"><span class="grow"><code>${esc(m.model)}</code>
      <span class="sub">${fmtN(n(m.calls))} call${m.calls === 1 ? '' : 's'} · ${m.sessions} session${m.sessions > 1 ? 's' : ''}${m.maxContext ? ` · largest call ${fmtTokens(m.maxContext)}` : ''}</span></span>
      <b>${fmtTokens(m.tokens)}</b></div>`).join('')
    // Its practice runs, apart: its own transcripts do not hold them, so the list adds up to the total.
    + (practice ? (practice.byModel || []).map(m => `<div class="pair"><span class="grow"><code>${esc(m.model)}</code>
      <span class="sub">practice · ${fmtN(n(m.runs))} run${m.runs === 1 ? '' : 's'}${n(m.calls) ? ` · ${fmtN(n(m.calls))} call${m.calls === 1 ? '' : 's'}` : ''}</span></span>
      <b>${fmtTokens(m.tokens)}</b></div>`).join('') : '');
  // Where the tokens went (v2.102.0): cache reads are the conversation re-read each call.
  // A donut beside "At API prices", the four parts in the same colours (2026-10-11).
  const parts = SPEND_PARTS.map(([k, label, color]) => ({ label, color, value: n(u[k]) }));
  const whole = parts.reduce((s, p) => s + p.value, 0);
  const split = whole > 0 ? `<div class="ucard" style="display:flex;flex-direction:column;gap:4px">
      <div class="sub" style="font-size:12px">Where the tokens went</div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">${donutHTML(parts, whole, fmtTokens(whole), 'tokens', 'Where the tokens went', fmtTokens)}${pieLegend(parts, whole, fmtTokens)}</div></div>` : '';
  const day = u.lastDay ? `<div style="margin:2px 0"><b>Last 24 hours:</b> ${fmtTokens(u.lastDay.tokens)} tokens · ${fmtN(u.lastDay.calls)} call${u.lastDay.calls === 1 ? '' : 's'}${u.lastDay.calls ? ` · about ${fmtTokens(u.lastDay.tokens / u.lastDay.calls)} a call` : ''}</div>` : '';
  // Each call re-sends the conversation; past ~150K it is most of what the agent costs.
  const big = n(u.lastContext) >= 150_000;
  const ctx = u.lastContext !== undefined ? `<div style="margin:2px 0"><b>Conversation size now:</b> ${fmtTokens(u.lastContext)} tokens a call${u.maxContext ? ` <span class="sub">(largest ever ${fmtTokens(u.maxContext)})</span>` : ''}</div>
    ${big ? `<div class="sub" style="margin:2px 0 6px">Every call carries this much in. A long-running conversation or a scheduled task that keeps adding to it is the usual cause; a fresh session makes each call far smaller.</div>` : ''}` : '';
  const alerts = (u.alerts || []).filter(recEarlierSpike).map(x => `<div class="sub" style="display:flex;gap:6px;align-items:baseline"><span class="grow">⚠️ ${fmtTokens(x.tokens)} tokens in 24 hours${x.usual >= 1e6 ? ` — about ${Math.round(x.tokens / x.usual)}× its usual day` : ''} · ${esc(ago(x.at))}</span>`
    + `<button class="hbtn" style="padding:0 6px;font-size:12px" title="Clear this warning" aria-label="Clear this warning" ${onAction('click', 'dismissSpikeRow', [`${(x.agentId || agentId) ?? ''}`, `${x.at ?? ''}`, { $: 'el' }])}>✕</button></div>`).join('');
  return `<div style="font-size:22px;font-weight:700">${fmtTokens(u.totalTokens)} tokens <span class="sub" style="font-size:13px;font-weight:400">in all</span></div>
     <div class="sub" style="margin:2px 0 8px">${fmtN(n(u.calls))} call${u.calls === 1 ? '' : 's'} · ${n(u.sessions)} session${u.sessions === 1 ? '' : 's'}${practice ? ` · ${fmtN(practice.runs)} practice run${practice.runs === 1 ? '' : 's'} (${fmtTokens(practice.tokens)})` : ''}${u.lastActive ? ' · last active ' + ago(u.lastActive) : ''} · ${billingLine(agentId, models)}</div>
     ${alerts ? `<div style="margin:0 0 8px;padding:6px 10px;border-radius:8px;background:color-mix(in srgb, var(--warn) 12%, transparent)">${alerts}</div>` : ''}
     ${agentId ? `<h4 class="v2sec" style="margin-top:6px">At API prices</h4>${spendChartBox(agentId)}` : ''}
     ${day || ctx ? `<div class="ucard">${day}${ctx}</div>` : ''}${split}
     ${rows ? `<div class="ucard">${rows}</div>` : ''}`;
}

function openFleetUsage() {
  fleetUsageDlg.showModal();
  loadFleetUsage();
}
/** Clear one spike warning (its agent and time), or all of them. */
async function dismissSpike(agentId, at) {
  try {
    await api('/v1/usage/alerts/dismiss', { method: 'POST', body: agentId ? { agentId, at } : {} });
    void loadFleetUsage();
    if (v2UsageCache) v2UsageCache = null;
  } catch (e) { toast(e.message, 8000); }
}
async function loadFleetUsage() {
  void loadRecommended('', true);
  if (!$('fleetUsageBody').childElementCount) $('fleetUsageBody').innerHTML = 'Loading…';
  try {
    // From the sampler's records, not the containers: it answers at once.
    // The day's answer carries the spike warnings, the savings and the plan share; the chart reads its own range.
    renderFleetUsage(await api('/v1/usage/periods?period=day'));
    void loadContextNow();
  } catch (e) {
    $('fleetUsageBody').innerHTML = `<div class="sub">${esc(e.message)}</div>`;
  }
}
/**
 * Context now (Chris, 2026-10-23): one line per agent — its model, how big its
 * main conversation is at its last call, the model's window (or the cap
 * Hatchabot set), and how full that is. From the token steward's last read of
 * each agent's transcripts; nothing is woken for it.
 */
async function loadContextNow() {
  const box = $('fleetContextNow'); if (!box) return;
  try {
    const th = await api('/v1/token-health?limit=100');
    if (!$('fleetContextNow')) return;
    const rows = (th.rows || []).filter((r) => r.conversation || r.contextCap?.tokens);
    if (!rows.length) { box.innerHTML = '<div class="sub">No reading yet — the usage pass reads each agent\'s transcripts about hourly while it runs.</div>'; return; }
    ctxNowRows = new Map(rows.map((r) => [r.id, r]));
    const bare = (m) => esc(String(m || '').replace(/^.*\//, ''));
    const cols = [['Agent', mpLeft], ['Model', mpLeft], ['Main conversation'], ['Window'],
      ['Cap', ' title="Where it compacts instead of near the model\'s window: at about the cap less 20K"'], ['Full'],
      ['Median call', ' title="Half its calls to the model in the last 30 days carried less than this, half more"'], ['Last call']];
    const line = (r) => {
      const c = r.conversation || {};
      const now = c.mainNowK;
      const capK = r.contextCap?.tokens ? Math.round(r.contextCap.tokens / 1000) : undefined;
      const limitK = capK ?? c.windowK;
      const share = now !== undefined && limitK ? Math.min(999, Math.round(now / limitK * 100)) : null;
      const tone = share === null ? '' : share >= 80 ? 'color:var(--bad);font-weight:600' : share >= 50 ? 'color:var(--warn);font-weight:600' : '';
      const when = c.mainAt ? esc(ago(c.mainAt)) : (r.readHoursAgo !== undefined ? `read ${esc(String(r.readHoursAgo))} h ago` : '');
      const n = ` style="${mpNum}"`;
      return mpRow(cols, [`${esc(r.agent)}${r.state && r.state !== 'running' ? ` <span class="sub">· ${esc(r.state)}</span>` : ''}`, [bare(r.model), ' class="sub" style="text-align:left;white-space:nowrap"'],
        [now !== undefined ? `${kTok(now)}` : '<span class="sub">—</span>', n], [c.windowK ? `${kTok(c.windowK)}` : '<span class="sub">—</span>', n],
        [ctxCapControl(r), n],
        [share === null ? '<span class="sub">—</span>' : `${share}%`, ` style="${mpNum};${tone}"`],
        [c.ctxK ? `${kTok(c.ctxK.p50)}` : '<span class="sub">—</span>', n],
        [when, ' class="sub" style="white-space:nowrap"']], ` data-agent="${esc(r.id)}"`);
    };
    const sorted = [...rows].sort((a, b) => (b.conversation?.mainNowK ?? -1) - (a.conversation?.mainNowK ?? -1));
    box.innerHTML = `<div class="mp-wrap"><table class="mp-tbl">${mpHead(cols)}<tbody>${sorted.map(line).join('')}</tbody></table></div>
      <div class="sub" style="margin-top:6px"><b>Main conversation</b>: what its last call carried (its Telegram DM and console share one conversation). <b>Window</b>: the model's context window, as the agent's OpenClaw states it. <b>Cap</b>: where Hatchabot has it compact instead: at about the cap less 20K, a summary replaces the older turns. <b>Full</b> counts against the cap when there is one; over 80% it is close to compacting.</div>
      <div class="sub" style="margin-top:4px"><b>Median call</b>: how much a call to the model carried in the last 30 days (its conversations; scheduled tasks left out): half its calls carried less, half more. Every call carries the whole conversation so far, so this is what costs, and what a cap keeps down.</div>`;
  } catch (e) { box.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
/** A size in thousands of tokens: 520K, 1M, 1.5M (fmtN's own "k" made a 1M window "1.0kK"). */
const kTok = (k) => (k >= 1000 ? `${+(k / 1000).toFixed(1)}M` : `${k}K`);
/** The last Context now reading, by agent id: what a cap change asks about. */
let ctxNowRows = new Map();
const CTX_CAPS = [100_000, 150_000, 200_000, 300_000, 500_000];
/** Context now's Cap cell: a menu (None, or a cap below the model's window). A local model costs nothing per token: no menu. */
function ctxCapControl(r) {
  if (r.billing === 'local') return '<span class="sub" title="A local model costs nothing per token: no cap is needed">—</span>';
  const cur = r.contextCap?.tokens || 0;
  const windowT = (r.conversation?.windowK || 0) * 1000;
  const caps = [...new Set([...CTX_CAPS.filter((t) => !windowT || t < windowT), ...(cur ? [cur] : [])])].sort((a, b) => a - b);
  const pending = cur && !r.contextCap?.applied ? ' <span class="sub" title="Stored; written into its settings when it is next running">pending</span>' : '';
  return `<select class="ctxcap" aria-label="Context cap for ${esc(r.agent)}" data-was="${cur || ''}" ${onAction('change', 'setContextCap', [`${r.id ?? ''}`, { $: 'el' }])}>
      <option value=""${cur ? '' : ' selected'}>None</option>${caps.map((t) => `<option value="${t}"${t === cur ? ' selected' : ''}>${kTok(Math.round(t / 1000))}</option>`).join('')}</select>${pending}`;
}
/** Set or take off an agent's context cap from Context now, once the person agrees to what it does. */
async function setContextCap(id, sel) {
  const r = ctxNowRows.get(id); if (!r) return;
  const tokens = sel.value ? Number(sel.value) : null;
  const atK = tokens ? Math.round((tokens - Math.min(20_000, tokens / 4)) / 1000) : 0;
  const nowK = r.conversation?.mainNowK;
  const windowK = r.conversation?.windowK;
  const ask = tokens === null
    ? `Take ${r.agent}'s context cap off? It then compacts near its model's full window${windowK ? ` (${kTok(windowK)})` : ''}, so each call can carry more.`
    : `Cap ${r.agent}'s conversations at ${kTok(tokens / 1000)}? OpenClaw compacts them at about ${kTok(atK)}: a summary replaces the older turns.${nowK > atK ? ` Its main conversation is ${kTok(nowK)} now, so its next turn starts with a compaction.` : ''}`;
  if (!confirm(ask)) { sel.value = sel.dataset.was; return; }
  sel.disabled = true;
  try {
    const out = await api(`/v1/agents/${id}/context-cap`, { method: 'PUT', body: { tokens } });
    toast(out.message || 'Saved.', 7000);
  } catch (e) {
    toast(e.message, 8000);
    sel.value = sel.dataset.was;
  } finally { sel.disabled = false; }
  void loadContextNow();
  void loadRecommended('', true); // a cap settles a "large conversation" item
}
/**
 * "Saved by cheaper models" (was the Right-size line, 2026-10-05): each switch
 * to a cheaper model still in force this month — the agent, from → to, since
 * when, what this month cost on the new model, what the same use would have
 * cost on the old one, and the difference. At API prices.
 */
function savedByModels(rs) {
  const rows = (rs?.rows || []).filter((r) => r.savingUSD > 0);
  if (!rows.length) return '';
  const bare = (m) => esc(String(m).replace(/^.*\//, ''));
  const star = (r) => (r.billing === 'plan' ? '*' : '');
  const cols = [['Agent', mpLeft], ['Switched', mpLeft], ['Since'], ['This month'], ['On the old model'], ['Saved']];
  return `<h4 class="v2sec" id="savedByModels" style="margin-top:14px">Saved by cheaper models · ≈ ${v2Money(rs.savingUSD)}${rs.planUSD > 0 ? '*' : ''} this month</h4>
    <div class="mp-wrap"><table class="mp-tbl">${mpHead(cols)}<tbody>
    ${rows.map((r) => mpRow(cols, [esc(r.agent), [`${bare(r.from)} → ${bare(r.to)}`, ' style="text-align:left;white-space:nowrap" class="sub"'],
      [esc(new Date(r.since).toLocaleDateString([], { month: 'short', day: 'numeric' })), ` style="${mpNum}" class="sub"`],
      [`${v2Money(r.isUSD)}${star(r)}`, ` style="${mpNum}"`], [`${v2Money(r.wasUSD)}${star(r)}`, ` style="${mpNum}" class="sub"`], [`<b>${v2Money(r.savingUSD)}${star(r)}</b>`, ` style="${mpNum}"`]])).join('')}
    </tbody></table></div>`;
}
function renderFleetUsage(f) {
  // The By agent table went (Chris, 2026-10-05: less to read): the picker above
  // the chart narrows to any agents, and each agent's Usage tab has its own.
  const planStar = (f.pricing?.billing?.plan > 0) || (f.rightSize?.planUSD > 0);
  // Spike warnings of the last week (sent to the owner's chat when they happened); ✕ clears one, "Clear all" every one.
  const earlier = (f.alerts || []).filter(recEarlierSpike);
  const alerts = earlier.map((x) => `<div class="sub" style="margin:2px 0;display:flex;gap:6px;align-items:baseline"><span class="grow">⚠️ <b>${esc(x.name)}</b> used ${fmtTokens(x.tokens)} tokens in 24 hours${x.usual >= 1e6 ? ` — about ${Math.round(x.tokens / x.usual)}× its usual day` : ''} · ${esc(ago(x.at))}${x.covered ? ' · told with its loop' : x.told ? '' : ' · not sent (no chat app reaches you)'}</span>`
    + `<button class="hbtn" style="padding:0 6px;font-size:12px" title="Clear this warning" aria-label="Clear this warning" ${onAction('click', 'dismissSpike', [`${x.agentId ?? ''}`, `${x.at ?? ''}`])}>✕</button></div>`).join('')
    + (earlier.length ? `<div class="sub" style="margin-top:2px">Earlier this week. A spike in the last day is under Recommended, above.</div>` : '')
    + (earlier.length > 1 ? `<div style="text-align:right;margin-top:2px"><button class="hbtn" style="font-size:12px" ${onAction('click', 'dismissSpike')}>Clear all</button></div>` : '');
  // Requests that did not go through in the last 24 hours: one line, only when there were any (Chris, 2026-10-05).
  const bad = (a) => (a.limited || 0) + (a.failed || 0);
  const worst = (f.agents || []).filter((a) => bad(a) > 0).sort((x, y) => bad(y) - bad(x));
  const lim = f.totals?.limited || 0, fail = f.totals?.failed || 0;
  const failLine = lim + fail ? `<div class="sub" id="usageFailed" style="margin:0 0 10px">⛔ Last 24 hours: ${[lim ? `<b style="color:var(--bad)">${fmtN(lim)}</b> refused (rate limits)` : '', fail ? `<b style="color:var(--bad)">${fmtN(fail)}</b> failed` : ''].filter(Boolean).join(' · ')}`
    + `${worst.length ? ` — ${worst.slice(0, 3).map((a) => `${esc(a.name)} ${fmtN(bad(a))}`).join(' · ')}${worst.length > 3 ? ` · ${worst.length - 3} more` : ''}` : ''}</div>` : '';
  $('fleetUsageBody').innerHTML = `
    ${alerts ? `<div style="margin:0 0 10px;padding:6px 10px;border-radius:8px;background:color-mix(in srgb, var(--warn) 12%, transparent)">${alerts}</div>` : ''}
    ${failLine}
    <h4 class="v2sec" style="margin-top:4px">Context now</h4>
    <div id="fleetContextNow"><div class="sub">Loading…</div></div>
    <h4 class="v2sec" style="margin-top:14px;display:flex;justify-content:space-between;align-items:baseline">At API prices <a href="#" id="fleetUsagePrices" style="text-transform:none;letter-spacing:0;font-weight:400" ${onAction('click', 'openModelPrices', [], 'prevent')}>model prices</a></h4>
    ${spendChartBox('')}
    ${savedByModels(f.rightSize)}
    ${planStar ? `<div class="sub" style="margin-top:12px">* Claude plan use priced at API rates — not money you pay.</div>` : ''}`;
  void loadSpendCharts($('fleetUsageBody'));
}
