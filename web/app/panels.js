// web/app/panels.js: Recommended, health on an agent's Overview, resources, an agent's panels (members, web chat, the people it knows, its bot, its name and description, scheduled tasks), invitations and Telegram links, rebuilding and deleting an agent, removing a member.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- Recommended (recommendations.ts, docs/recommendations-design.md) ------------
// One ranked list of the cost, model and token advice: the top of Usage, and each
// agent's items on its Usage tab. Each item: the concern, its evidence, the
// expected effect, one button (the same route its card would use; the click is
// the confirmation), Details and Not now (put away until its cause changes).
// The list is the server's; nothing here judges an agent.
/** A spike warning older than a day: today's is a Recommended item, not a second box. */
const recEarlierSpike = (x) => Date.now() - Date.parse(x.at) >= 86_400_000;
const v2RecItems = new Map();
const v2RecCache = new Map();
let v2RecFocus = null;
async function loadRecommended(agentId = '', fresh = false) {
  const box = () => (agentId ? ($('v2RecBody')?.dataset.agent === agentId ? $('v2RecBody') : null) : $('fleetRecommended'));
  if (!box()) return;
  const hit = v2RecCache.get(agentId);
  let items;
  if (!fresh && hit && Date.now() - hit.at < 30_000) items = hit.items;
  else {
    try {
      const r = await api(agentId ? `/v1/agents/${encodeURIComponent(agentId)}/recommendations` : '/v1/recommendations');
      items = Array.isArray(r?.items) ? r.items : [];
    } catch (e) { const el = box(); if (el) { el.hidden = false; el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; } return; }
    v2RecCache.set(agentId, { at: Date.now(), items });
  }
  const el = box(); if (!el) return; // the sheet moved on meanwhile
  for (const it of items) v2RecItems.set(it.id, it);
  el.hidden = !items.length && !!agentId;
  el.innerHTML = recommendedHTML(items, agentId);
  if (v2RecFocus && el.querySelector(`[data-rec="${CSS.escape(v2RecFocus)}"]`)) {
    const it = el.querySelector(`[data-rec="${CSS.escape(v2RecFocus)}"]`);
    it.classList.add('rec-focus'); it.scrollIntoView?.({ block: 'nearest' });
    v2RecFocus = null;
  }
}
function recommendedHTML(items, agentId) {
  const head = `<h4 class="v2sec" style="margin-top:${agentId ? 6 : 0}px">Recommended${items.length ? ` · ${items.length}` : ''}</h4>`;
  if (!items.length) return `${head}<div class="sub" style="margin:0 0 12px">Nothing to change right now: no loop, no budget near its limit, and no cheaper model with enough evidence behind it.</div>`;
  return `${head}<div class="rec-list">${items.map((it) => recItemHTML(it, agentId)).join('')}</div>`;
}
function recItemHTML(it, agentId) {
  const who = it.proposedBy === 'agent' ? 'Proposed by your Hatchabot agent' : it.proposedBy === 'guard' ? "Proposed by Hatchabot's quality guard" : '';
  // On an agent's own Usage tab, "Details" that would open this same tab says nothing new.
  const more = (it.secondary || []).map((a, i) => [a, i]).filter(([a]) => !(agentId && a.kind === 'open-usage' && a.agentId === agentId));
  const evidence = Array.isArray(it.evidence) ? it.evidence : [];
  return `<div class="rec-item${it.alert ? ' rec-now' : ''}" id="rec-${esc(it.id)}" data-rec="${esc(it.id)}">
    <div class="rec-head"><b>${esc(it.title)}</b>${it.concern ? ` — ${esc(it.concern)}` : ''}</div>
    ${who ? `<div class="rec-who sub">${who}</div>` : ''}
    ${evidence.length ? `<ul class="rec-ev">${evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    ${it.effect?.text ? `<div class="rec-effect"><i>Expected effect:</i> ${esc(it.effect.text)}</div>` : ''}
    <div class="rec-btns">${it.action ? `<button type="button" class="primary" ${onAction('click', 'recAct', [`${it.id}`, -1, { $: 'el' }])}>${esc(it.action.label)}</button>` : ''}${more.map(([a, i]) => `<button type="button" ${onAction('click', 'recAct', [`${it.id}`, (i), { $: 'el' }])}>${esc(a.label)}</button>`).join('')}<button type="button" ${onAction('click', 'recNotNow', [`${it.id}`, { $: 'el' }])}>Not now</button></div>
  </div>`;
}
/** After an action or a Not now: every list on the page asks again. */
async function recReload() {
  v2RecCache.clear();
  if ($('fleetRecommended') && fleetUsageDlg.open) void loadRecommended('', true);
  const ag = $('v2RecBody')?.dataset.agent;
  if (ag) void loadRecommended(ag, true);
}
async function recAct(id, i, btn) {
  const it = v2RecItems.get(id); if (!it) return;
  const a = i < 0 ? it.action : it.secondary?.[i];
  if (!a) return;
  const go = (agentId, tab) => { if (fleetUsageDlg.open) fleetUsageDlg.close(); openV2Agent(agentId, tab); };
  if (a.kind === 'open-agent') return go(a.agentId, 'overview');
  if (a.kind === 'open-usage') return go(a.agentId, 'usage');
  if (a.kind === 'open-sources') { if (fleetUsageDlg.open) fleetUsageDlg.close(); return void openAiDlg('ai'); }
  if (a.kind === 'open-budgets') { if (fleetUsageDlg.open) fleetUsageDlg.close(); return void openBudgets(); }
  if (!a.path) return;
  if (a.confirm && !confirm(a.confirm)) return;
  const row = btn?.closest('.rec-btns');
  for (const b of row?.querySelectorAll('button') ?? []) b.disabled = true;
  try {
    const r = await api(a.path, { method: a.method || 'POST', body: a.body || {}, headers: { 'x-hatchabot-recommendation': it.id } });
    toast(r?.message || r?.text || 'Done.', 6000);
    await recReload();
    void loadProposals(); void refresh(false);
  } catch (e) {
    for (const b of row?.querySelectorAll('button') ?? []) b.disabled = false;
    toast(e.message, 8000);
  }
}
async function recNotNow(id, btn) {
  const it = v2RecItems.get(id); if (!it) return;
  for (const b of btn?.closest('.rec-btns')?.querySelectorAll('button') ?? []) b.disabled = true;
  try {
    // A card behind it is cancelled, as its Cancel did (the agent hears so).
    if (it.proposalId) await api(`/v1/proposals/${encodeURIComponent(it.proposalId)}/cancel`, { method: 'POST', body: {} }).catch(() => {});
    await api(`/v1/recommendations/${encodeURIComponent(id)}/dismiss`, { method: 'POST', body: {} });
    for (const el of document.querySelectorAll(`[data-rec="${CSS.escape(id)}"]`)) el.remove();
    toast('Put away — it comes back if its cause changes.', 5000);
    await recReload();
    void refresh(false);
  } catch (e) {
    for (const b of btn?.closest('.rec-btns')?.querySelectorAll('button') ?? []) b.disabled = false;
    toast(e.message, 8000);
  }
}
/** From an Alerts line: the agent's Usage tab, with that item marked. */
function v2OpenRec(agentId, recId) { v2RecFocus = recId; openV2Agent(agentId, 'usage'); }

// ---- health, inline on an agent's Overview -----------------------------------------------
function v2InlineHealth(id, name) {
  const slot = $('v2HealthSlot'); if (!slot) return;
  healthAgentId = id;
  $('healthAgent').textContent = name;
  slot.append($('healthDlgBody'));
  slot.hidden = false;
  void loadHealth();
}

let healthAgentId = null;
const HEALTH_BADGE = {
  healthy: ['var(--ok)', 'Responding'],
  degraded: ['var(--warn)', 'Degraded'],
  unreachable: ['var(--bad)', 'Not answering'],
};
// The health pane moves between agents' sheets (v2InlineHealth): each check numbered, and only the newest
// drawn, for the agent it is now. A slower check of another agent painted its result under this one's name (HB-1046).
let healthSeq = 0;
async function loadHealth() {
  if (!healthAgentId) return;
  const id = healthAgentId, mine = ++healthSeq;
  const current = () => mine === healthSeq && healthAgentId === id;
  $('healthBody').innerHTML = 'Checking…';
  try {
    const h = await api(`/v1/agents/${id}/health?doctor=1`);
    if (current()) renderHealth(h);
  } catch (e) { if (current()) $('healthBody').innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}

// Resources: docker stats per host, one call each; polled while the view is open.
let fleetResTimer = null;
// Sort by name, CPU or memory; click a heading again to flip. Remembered per device.
let fleetResSort = (() => { try { return JSON.parse(localStorage.getItem('hb-res-sort') || '') || { key: 'mem', dir: -1 }; } catch { return { key: 'mem', dir: -1 }; } })();
function fleetResSortBy(key) {
  fleetResSort = { key, dir: fleetResSort.key === key ? -fleetResSort.dir : (key === 'name' ? 1 : -1) };
  try { localStorage.setItem('hb-res-sort', JSON.stringify(fleetResSort)); } catch {}
  if (fleetResLast) fleetResDraw(fleetResLast);
}
let fleetResLast = null;
function fleetResDraw(r) {
  const el = $('fleetResBody');
  const mb = (b) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
  const who = (c) => c.agentName ? esc(c.agentName) : ({ embedder: 'Memory search service', 'embed-door': 'Memory search door', doorman: 'Hatchabot agent’s doorman' })[c.role] || esc(c.name);
  const plain = (c) => c.agentName || ({ embedder: 'Memory search service', 'embed-door': 'Memory search door', doorman: 'Doorman' })[c.role] || c.name;
  const { key, dir } = fleetResSort;
  // Every column sorts (Chris, 2026-09-24); a row without a reading sorts as zero.
  const val = (c) => key === 'cpu' ? c.cpuPct : key === 'cap' ? (c.memLimitBytes ? c.memBytes / c.memLimitBytes : 0)
    : key === 'peak' ? (c.memPeakBytes ?? 0) : key === 'hits' ? ((c.memCapHits ?? 0) + 1e6 * (c.memOomKills ?? 0)) : key === 'swap' ? (c.swapBytes ?? 0) : c.memBytes;
  const cmp = (a, b) => key === 'name' ? dir * plain(a).localeCompare(plain(b), undefined, { sensitivity: 'base' })
    : dir * (val(a) - val(b)) || plain(a).localeCompare(plain(b));
  const th = (k, label, right) => `<th${right ? ' style="text-align:right"' : ''}><button class="res-sort${key === k ? ' on' : ''}" ${onAction('click', 'fleetResSortBy', [`${k}`])} aria-sort="${key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none'}">${label}${key === k ? (dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`;
  $('fleetResAt').textContent = `measured ${clock(r.at)}`;
  el.innerHTML = r.hosts.map(h => {
    const rows = [...h.containers].sort(cmp);
    return `<div style="padding:10px 0;border-top:1px solid var(--line)">
      <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap"><b>${esc(h.kind === 'local' ? 'This machine' : h.name)}</b>
        <span class="sub">${h.error ? esc(h.error) : `${h.totals.cpuPct}% CPU · ${mb(h.totals.memBytes)} in ${h.containers.length} container${h.containers.length === 1 ? '' : 's'}${h.totals.swapBytes ? ` · ${mb(h.totals.swapBytes)} in swap` : ''}`}</span>
        ${h.swap ? `<span class="sub" title="${esc(h.swap.summary || '')}">· ${h.swap.compressed ? `compressed swap: ${esc(h.swap.summary || h.swap.kind)}` : 'no compressed swap (agents get none)'}</span>` : ''}</div>
      ${rows.length ? `<table class="rt-tbl" style="width:100%;margin-top:6px"><thead><tr>${th('name', 'Agent')}${th('cpu', 'CPU', true)}${th('mem', 'Memory', true)}${th('cap', 'of cap', true)}${th('peak', 'peak', true)}${th('swap', 'in swap', true)}${th('hits', 'hit cap', true)}</tr></thead><tbody>
        ${rows.map(c => `<tr><td>${who(c)}${c.shared ? ' <span class="sub">(shared with you)</span>' : c.mine === false ? ' <span class="sub">(another account’s)</span>' : ''}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${c.cpuPct.toFixed(1)}%</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums">${mb(c.memBytes)}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums" class="sub">${c.memLimitBytes ? Math.round(100 * c.memBytes / c.memLimitBytes) + '% of ' + mb(c.memLimitBytes) : '—'}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums" class="sub"${c.clearedAt ? ` title="Since you cleared it ${esc(ago(c.clearedAt))} ago"` : ''}>${c.memPeakBytes ? mb(c.memPeakBytes) : '—'}${c.agentId && c.mine !== false ? ` <button class="hbtn" style="padding:0 4px;font-size:11px" ${onAction('click', 'fleetResClear', [`${c.agentId ?? ''}`])} title="Forget this agent's peak and cap hits; they count from now">×</button>` : ''}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums" class="sub">${c.swapBytes ? mb(c.swapBytes) : c.swapBytes === 0 ? '0' : '—'}</td>
          <td style="text-align:right;font-variant-numeric:tabular-nums${c.memCapHits || c.memOomKills ? ';color:var(--warn);font-weight:600"' : '" class="sub"'}>${c.memCapHits === undefined ? '—' : `${c.memCapHits}${c.memOomKills ? ` · killed ${c.memOomKills}×` : ''}`}</td></tr>`).join('')}
      </tbody></table>${h.totals?.machineMemBytes && h.totals.memPeakBytes > 0.8 * h.totals.machineMemBytes ? `<div class="sub" style="margin-top:6px;color:var(--warn)">⚠ If every container hit its peak at once they would want ${mb(h.totals.memPeakBytes)} of this machine's ${mb(h.totals.machineMemBytes)}. Caps are ceilings, not reservations — but this is close: lower some caps or move agents.</div>` : ''}${rows.some(c => c.memCapHits) ? `<div class="sub" style="margin-top:6px">⚠ ${rows.filter(c => c.memCapHits).length === 1 ? 'One container has' : `${rows.filter(c => c.memCapHits).length} containers have`} run into the memory cap. An OpenClaw 2026.9 gateway idles near 1 GB, and an agent's own jobs sit on top of that: give that agent more (its sheet → Runtime → Memory cap, applied right away) or ask it to run smaller jobs.</div>` : ''}` : ''}</div>`;
  }).join('') || '<div class="sub">Nothing running.</div>';
}
async function fleetResClear(agentId) {
  try {
    const r = await api(agentId ? `/v1/agents/${agentId}/resources/clear` : '/v1/resources/clear', { method: 'POST', body: {} });
    toast(agentId ? 'Peak and cap hits cleared — they count from now.' : `Peaks cleared on ${r.cleared} agent${r.cleared === 1 ? '' : 's'} — they count from now.`);
  } catch (e) { toast(e.message, 8000); return; }
  // Redraw now rather than on the next 5 s tick. (It used to call a function
  // that does not exist, so a successful clear always ended in an error toast.)
  try { fleetResLast = await api('/v1/resources'); fleetResDraw(fleetResLast); } catch { /* the next tick redraws */ }
}
async function openFleetResources() {
  fleetResDlg.showModal();
  const el = $('fleetResBody');
  if (!el.innerHTML) el.innerHTML = '<div class="sub">Measuring… (a second per machine)</div>';
  const draw = async () => {
    try { fleetResLast = await api('/v1/resources'); fleetResDraw(fleetResLast); }
    catch (e) { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
  };
  await draw();
  clearInterval(fleetResTimer);
  // Only while this view is the one showing: another Fleet tab, or a closed
  // panel, must not keep `docker stats` running on every machine.
  fleetResTimer = setInterval(() => {
    const showing = fleetResDlg.open;
    if (showing) draw(); else { clearInterval(fleetResTimer); fleetResTimer = null; }
  }, 5000);
}

function healthRow(label, ok, detail) {
  const dot = ok === null ? 'var(--dim)' : ok ? 'var(--ok)' : 'var(--bad)';
  return `<div class="pair"><span class="grow"><span style="color:${dot}">●</span> ${esc(label)}</span>
    <span class="sub">${detail ? esc(detail) : ''}</span></div>`;
}
function renderHealth(h) {
  // The gateway can answer while its AI source refuses every turn (2026-09-30).
  const refusing = h.reachable && h.aiSource?.refusingSince;
  const [color, word] = refusing ? ['var(--warn)', 'Up, but its AI source is not answering'] : HEALTH_BADGE[h.status] ?? HEALTH_BADGE.unreachable;
  let body = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
    <span style="color:${color};font-size:26px;line-height:1">●</span>
    <div><div style="font-size:18px;font-weight:700">${word}</div>
      <div class="sub">${h.checkedAt ? 'checked ' + ago(new Date(h.checkedAt).toISOString()) : 'just now'}</div></div>
  </div>`;
  if (!h.reachable) {
    $('healthBody').innerHTML = body + `<div class="sub">The gateway didn't answer. If this keeps happening, try Rebuild.</div>`;
    return;
  }
  const rows = [];
  if (h.aiSource) {
    const src = h.aiSource, named = src.name ? ` (${src.name})` : '';
    if (src.refusingSince) rows.push(healthRow('AI source', false, `${src.refusal === 'refused' ? 'refused (rate-limited)' : 'failed'} since ${ago(src.refusingSince)}${src.lastAnsweredAt ? ` · last answered ${ago(src.lastAnsweredAt)}` : ''}${named}`));
    else if (src.lastAnsweredAt) rows.push(healthRow('AI source', true, `last answered ${ago(src.lastAnsweredAt)}${named}`));
    else rows.push(healthRow('AI source', null, `no answer seen yet${named}`));
  }
  if (h.telegram) {
    rows.push(healthRow('Telegram connected', h.telegram.connected, h.telegram.connected ? 'live' : (h.telegram.lastError || 'disconnected')));
    if (h.telegram.reconnectAttempts) rows.push(healthRow('Reconnecting', false, `${h.telegram.reconnectAttempts} attempt${h.telegram.reconnectAttempts > 1 ? 's' : ''}`));
    const last = h.telegram.lastInboundAt || h.telegram.lastEventAt;
    if (last) rows.push(healthRow('Last message', null, ago(new Date(last).toISOString())));
  }
  if (h.eventLoop) rows.push(healthRow('Event loop', !h.eventLoop.degraded, h.eventLoop.degraded ? (h.eventLoop.reasons.join(', ') || 'degraded') : 'nominal'));
  for (const k of h.disconnected || []) rows.push(healthRow(`${k === 'slack' ? 'Slack' : 'Discord'} connected`, false, 'disconnected'));
  if (h.pluginErrors && h.pluginErrors.length) rows.push(healthRow('Plugin errors', false, h.pluginErrors.slice(0, 3).join(', ')));
  // Config lint (doctor --lint): silent degradations the gateway probe can't
  // see. Asked for with ?doctor=1; missing when it could not run. Clean only
  // when the run is complete: `{}` was "0 checks clean" (HB-1047).
  if (!v2LintRead(h)) {
    rows.push(healthRow('Config lint', null, 'not checked: the settings check gave no usable answer. Try again; if it keeps happening, Rebuild it'));
  } else if (h.doctor) {
    if (h.doctor.findings.length) {
      // The worst come first; the count is all of them, not only those sent.
      const total = h.doctor.findings.length + (h.doctor.omittedCount || 0);
      rows.push(healthRow('Config warnings', false, `${total} finding${total > 1 ? 's' : ''}`));
      for (const f of h.doctor.findings.slice(0, 6)) {
        rows.push(`<div class="sub" style="margin:2px 0 2px 18px">${esc(f.severity)} · ${esc(f.checkId)}: ${esc(f.message)}</div>`);
      }
      if (total > 6) rows.push(`<div class="sub" style="margin:2px 0 2px 18px">… and ${total - 6} more</div>`);
    } else {
      rows.push(healthRow('Config lint', true, `${h.doctor.checksRun} checks clean${h.doctor.mutedCount ? ` (+${h.doctor.mutedCount} known)` : ''}`));
    }
  }
  $('healthBody').innerHTML = body + rows.join('');
}

async function renderEditMembers() {
  const el = $('tgMemberList');
  if (!el) return;
  // Read for the agent the forms are filled for; drawn only while they are still its, and this sharing read the latest.
  const r = sheetRead(el), forId = r.id;
  el.textContent = 'Loading members…';
  // Your Hatchabot agent runs your machine: no invites, no members (2026-09-30).
  const opsAgent = !!agents.find(x => x.id === forId)?.ops;
  if ($('tgInviteRow')) $('tgInviteRow').hidden = opsAgent;
  if (opsAgent && $('tgShareRow')) $('tgShareRow').hidden = true;
  if (opsAgent) {
    el.innerHTML = '<div class="sub">Your Hatchabot agent is yours alone — nobody else can be let in.</div>';
    if ($('tgKnownPeople')) $('tgKnownPeople').innerHTML = '';
    return;
  }
  try {
    void loadWebChatPeople();
    const ms = await api(`/v1/agents/${forId}/members`);
    if (!r.mine()) return;
    members[forId] = ms;
    el.innerHTML = ms.filter(m => m.status !== 'revoked').map(m => {
      const label = m.role === 'owner' && (DEMO || !m.displayName) ? 'You' : `<span class="pii">${esc(m.displayName || m.userId.slice(0, 12))}</span>`;
      // Someone who redeemed an invite and never messaged: their window has
      // almost certainly lapsed, and the agent is deaf to them outside it, so
      // offer to hold the door open again rather than leaving them stuck.
      // Someone who only chats on the web never messages a bot: nothing to link, no door to hold open.
      // One who came in by a chat-app invite and then got web chat still has a door (HB-1136 review).
      const webOnlyMember = m.webChat && !m.channelUserId && !Object.keys(m.identities || {}).length && !m.joinedByAppInvite;
      // Linked on any app: Telegram's id is the seat's own, Discord's and Slack's are beside it. One linked on
      // Discord only was told "hasn't messaged yet", and offered a door the server then refused (HB-1045).
      const ids = { ...(m.channelUserId ? { telegram: m.channelUserId } : {}), ...(m.identities || {}) };
      const apps = Object.keys(ids), names = apps.map(k => V2_CHAN_LABEL[k] || k);
      const linked = apps.length
        ? `<span class="sub" title="${esc(apps.map((k, i) => `${names[i]} id ${ids[k]}`).join(' · '))}">✓ linked on ${esc(names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0])}</span>`
        : webOnlyMember || m.role === 'owner' && !m.channelUserId && !v2ChannelKinds(agents.find(x => x.id === forId) || {}).length ? ''
        : `<span class="sub" style="color:var(--warn)">hasn't messaged yet</span>
           <button ${onAction('click', 'reopenDoor', [`${forId}`, `${m.userId ?? ''}`, `${m.displayName ?? ''}`, `${m.invitedAs ?? ''}`, `${m.needsHandle ? '1' : ''}`])}
                   title="${m.invitedAs ? `Hold the door open for 30 minutes on the app they joined with, for @${esc(m.invitedAs)} only, the handle their invite named` : m.needsHandle ? 'Hold the door open for 30 minutes on the app they joined with, for their @handle only: their invite named them by a link with no name in it' : 'Hold the door open for 30 minutes on the app they joined with, so their next message is let through. Give their @handle and only they are let in (needed if we don\'t know that app); leave it empty and whoever writes first is'}">Let them in again</button>`;
      // Web chat (2026-09-29): a badge, and the switch — offered only to someone who signs in here.
      const web = m.role === 'owner' ? ''
        : m.webChat ? `<span class="chip webchat" title="Chats with it on this page — with a member's rights, like a Telegram member">web chat</span>
            <button ${onAction('click', 'setWebChat', [`${forId}`, `${m.userId ?? ''}`, `${m.displayName || 'them'}`, false])} title="They can no longer chat with it on this page">Turn off web chat</button>`
        : m.account && appConfig.authMode !== 'password' ? `<button ${onAction('click', 'setWebChat', [`${forId}`, `${m.userId ?? ''}`, `${m.displayName || 'them'}`, true])} title="Let them chat with it on this page, signed in">Allow web chat…</button>` : '';
      const kickBtn = m.role === 'owner' ? '' :
        `<button class="danger" ${onAction('click', 'kick', [`${forId}`, `${m.userId ?? ''}`, `${(m.displayName || m.userId) ?? ''}`])}>Remove</button>`;
      return `<div class="pair"><span class="grow"><b>${label}</b>${m.role === 'owner' ? ' ★' : ''} <span class="sub">· ${esc(m.role)}</span> ${linked}</span>${web}${kickBtn}</div>`;
    }).join('') || '<div class="sub">Just you so far — Invite… below to add someone.</div>';
  } catch (e) { r.draw(() => { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }); }
  r.draw(() => void renderKnownPeople());
}

/**
 * People already admitted to another of your agents. We hold their Telegram
 * id, so adding them here needs no invite link and no pairing — they go
 * straight onto this agent's allowlist and can message it at once.
 */
/**
 * The claim window is 30 minutes on purpose: outside it the agent is deaf to
 * anyone it does not know, which is the whole point of the door. The answer to
 * "they redeemed the invite and got round to it two hours later" is therefore
 * to open it again, on demand, rather than to leave it ajar for a day.
 */
/** Web chat on or off for a member; turning it ON says what it gives them (2026-09-29). */
async function setWebChat(agentId, userId, name, on) {
  if (on && !confirm(`Let ${name} chat with this agent on the web?\n\nThey will have a member's rights, exactly like a Telegram member: they can chat and ask it to use its tools, but not schedule tasks or change its settings.\n\nThey get OpenClaw's own chat with only their own conversations (on an agent rebuilt with this release; until then, Hatchabot's simpler chat).`)) return;
  const f = forAgent(agentId);
  try {
    await api(`/v1/agents/${agentId}/members/${encodeURIComponent(userId)}/web-chat`, { method: 'PUT', body: { on } });
    f.say(on ? `${name} can chat with it on the web now.` : `Web chat is off for ${name}.`);
    await f.draw(renderEditMembers);
  } catch (e) { f.fail(e, 8000); }
}

/** A Telegram link pasted for a handle (https://t.me/name, t.me/name, telegram.me/name): the name is after it (the server's). */
const HANDLE_LINK = /^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\//i;
/** The longest handle the server takes, without its @ or link (store.ts HANDLE_MAX; test/driftGuards.test.ts holds them together). */
const HANDLE_MAX = 64;

/** A handle as typed, without its @s or the t.me link it was pasted as, nor what follows the name in it (the server's handleText). */
function handleTyped(v) {
  let t = String(v ?? '').replace(/^[@\s]+/, '');
  const link = HANDLE_LINK.exec(t);
  if (link) t = t.slice(link[0].length).split(/[/?#]/, 1)[0];
  return t.replace(/^[@\s]+/, '').trim();
}

/**
 * Ask for an @handle until one is given that the server takes (HB-1439
 * review): one it refuses was dropped, and the door opened to anyone. null:
 * cancelled, or still none after three tries (then said: nothing was
 * changed); '': left empty, unless `required`; else the handle, without its
 * @s or link.
 */
function askHandle(question, { required = false } = {}) {
  let asked = question, given = '';
  for (let tries = 0; tries < 3; tries++) {
    const typed = prompt(asked, given);
    if (typed === null) return null;
    if (!typed.trim() && !required) return '';
    const handle = handleTyped(typed);
    if (handle && handle.length <= HANDLE_MAX) return handle;
    given = typed;
    asked = typed.trim()
      ? `“${typed.trim().slice(0, 80)}” is not an @handle: give theirs, no more than ${HANDLE_MAX} characters after the @.\n\n${question}`
      : `Their @handle is needed: without it there is no one to let in.\n\n${question}`;
  }
  toast('No @handle given: nothing was changed.');
  return null;
}

/**
 * "Let them in again" reopens only the app they joined with. Each press asks
 * for their @handle, which may be left empty (HB-1439): given, the window
 * admits only them; empty, whoever messages first, as before. One their
 * invite named is the one used, so then none is asked for (HB-1439 review).
 * A handle the server would not take is asked for again, never sent to be
 * dropped; and when one given was not used, the answer says so, and who the
 * door is open to. When the app they joined with was never recorded, a handle
 * is needed, and an empty one is asked for again (2026-09-30). What comes back
 * is said however late, with the agent's name under another agent's sheet
 * (HB-1486), and nothing once the page is another person's; a handle is asked
 * for again only while its Members list is the one shown.
 */
async function reopenDoor(agentId, userId, name, invitedAs, needsHandle) {
  const url = `/v1/agents/${agentId}/members/${encodeURIComponent(userId)}/reopen`;
  const current = sharingRead($('tgMemberList'), agentId);
  if (!current()) return;
  const them = name || 'them';
  let handle = '';
  if (!invitedAs) {
    // Their invite named them by a link with no name in it: theirs is asked for, and empty is not offered (HB-1439 review).
    handle = askHandle(needsHandle
      ? `Let ${them} in again: the door opens for 30 minutes on the app they joined with.\n\nTheir invite named them by a link with no name in it, so Hatchabot can't tell who to let in. Their @handle (Telegram username, or their Slack / Discord name) — only they will be let in:`
      : `Let ${them} in again: the door opens for 30 minutes on the app they joined with.\n\nTheir @handle (Telegram username, or their Slack / Discord name), and only they are let in. Leave empty to let in whoever writes first:`,
    { required: !!needsHandle });
    if (handle === null || !current()) return;
  }
  const f = forAgent(agentId), page = sharingPage();
  try {
    let r;
    try { r = await api(url, { method: 'POST', body: handle ? { handle } : {} }); }
    catch (e) {
      if (e.code !== 'needs-handle' || !current()) throw e;
      // Asked in the server's words: why it needs one is the server's to say (HB-1439 review).
      handle = askHandle(`${e.message}\n\nTheir @handle (Telegram username, or their Slack / Discord name) — only they will be let in:`, { required: true });
      if (!handle) return;
      r = await api(url, { method: 'POST', body: { handle } });
    }
    if (!page()) return;
    const where = r.on?.length === 1 ? ` on ${r.on[0][0].toUpperCase()}${r.on[0].slice(1)}` : '';
    const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
    // Who it is open to: the one named, or (a handle given and not used) whoever writes first.
    const forWhom = r.for ? ` for @${r.for} only${same(r.for, invitedAs) && !handle ? ', the handle their invite named' : ''}` : handle ? ' to whoever writes first' : '';
    const unused = handle && !same(r.for, handle) ? ` (@${handle} was not used)` : '';
    f.say(`Door open for ${r.minutes} minutes${where}${forWhom}${unused} — tell ${them} to message the bot now.`, 9000);
    if (current()) await f.draw(renderEditMembers);
  } catch (e) { if (page()) f.say(e.message, 8000); }
}

async function renderKnownPeople() {
  const el = $('tgKnownPeople');
  if (!el) return;
  el.innerHTML = '';
  // The list is the agent's it was read for, drawn only while the forms are still its own; its
  // Add buttons add to that agent (another's forms opened meanwhile are not where they go).
  const r = sheetRead(el), forId = r.id;
  try {
    const people = await api(`/v1/agents/${forId}/known-people`);
    if (!people.length) return;
    r.draw(() => {
      el.innerHTML = `<div class="sub" style="margin-bottom:4px">Already uses another of your agents — add without an invite:</div>`
        + people.map(p => `<div class="pair"><span class="grow"><b class="pii">${esc(p.name)}</b></span>
          <button ${onAction('click', 'addKnownPerson', [`${forId ?? ''}`, `${p.userId ?? ''}`, `${p.name ?? ''}`])}>Add</button></div>`).join('');
    });
  } catch { /* a server that doesn't offer it yet, or no agents: show nothing */ }
}

async function addKnownPerson(forId, userId, name) {
  if (!confirm(`Let ${name} message this agent?\n\nThey can already talk to another of your agents, so no invite or pairing is needed — they are added straight away.`)) return;
  const f = forAgent(forId);
  try {
    await api(`/v1/agents/${forId}/members/known`, { method: 'POST', body: { userId } });
    f.say(`${name} can now message this agent.`);
    await f.draw(renderEditMembers);
  } catch (e) { f.fail(e); }
}

/** The bot's handle beside the Telegram card's "The bot" heading. */
function renderBotWho(a) {
  const who = $('tgBotWho');
  if (who) who.textContent = a?.botUsername ? `— @${a.botUsername}` : '';
}

async function showBotToken() {
  const btn = $('botTokenBtn'), input = $('editBotToken');
  // Shown: copied. Not yet: read for the agent the forms are filled for, and put in its box only while it is still its.
  const r = input.value ? null : sheetRead('botToken');
  if (!r) {
    toast(await copyText(input.value) ? 'Token copied' : 'Select and copy manually');
    return;
  }
  const page = sharingPage(); // the token, and a refusal, never shown once the page is another person's (HB-1486 review)
  try {
    const t = await api(`/v1/agents/${r.id}/bot-token`);
    if (!page()) return;
    const shown = r.fill([input], () => { // shown, not typed
      input.value = t.botToken;
      btn.textContent = 'Copy';
      return true;
    });
    if (shown && t.pooled) toast('Pool bot — recycles automatically when the agent is deleted');
  } catch (e) { if (page()) r.say(e.message); } // with its agent's name once another agent's sheet is shown (HB-1486)
}

async function renameAgent() {
  const name = $('editName').value.trim();
  if (!name) { $('editErr').textContent = 'Give it a name.'; return; }
  // The agent renamed is the one Rename was pressed for: another agent's sheet opened while
  // it saved keeps its own header and the name being typed in it (HB-0475).
  const f = sheetSave('editName').hold('renameBtn');
  try {
    await api(`/v1/agents/${f.id}`, { method: 'PATCH', body: { name } });
    f.saved();
    f.draw(() => { $('editAgent').textContent = name; });
    f.say('Renamed');
    await refresh(false);
  } catch (e) { f.fail(e); }
  finally { f.done(); }
}

async function saveDescription() {
  const persona = $('editDesc').value.trim();
  const f = sheetSave('editDesc').hold('descBtn');
  try {
    await api(`/v1/agents/${f.id}`, { method: 'PATCH', body: { persona } });
    f.saved();
    f.say(persona ? 'Description saved' : 'Description cleared');
    await refresh(false); // repaint the card's one-liner
  } catch (e) { f.fail(e); }
  finally { f.done(); }
}

let cronAgentId = null, cronRead = 0, cronTriggerWrite = 0;
function cronScheduleLabel(c) {
  if (c.scheduleKind === 'cron') return c.scheduleExpr + (c.scheduleTz ? ' · ' + c.scheduleTz : '');
  if (c.scheduleKind === 'every' && c.everyMs) {
    // To the second: rounding to minutes showed a 15 s interval as "every 0m"
    // and 90 s as "every 2m" (#95). The gateway takes seconds (msToEvery).
    const s = Math.max(1, Math.round(c.everyMs / 1000)), m = Math.floor(s / 60);
    if (s % 60) return m ? `every ${m}m ${s % 60}s` : `every ${s}s`;
    return m >= 60 && m % 60 === 0 ? `every ${m / 60}h` : `every ${m}m`;
  }
  if (c.scheduleKind === 'at' && c.atMs) return 'once at ' + new Date(c.atMs).toLocaleString();
  return c.scheduleKind || 'schedule';
}
function prepareCrons(id, name) {
  sheetFill(['cronBody'], () => { // the form as it stands for this open: a draft kept, nothing new typed
    cronRead++; // a response from an earlier opening must not fill this one
    cronTriggerWrite++;
    // Another agent's: a task typed for the one before is not carried to it, nor added there
    // (HB-0591, as the edit forms' boxes), and an Edit begun there ends: its Save would change
    // the other agent's task (a leftover edit once deleted an unrelated task, 10th audit).
    if (id !== cronAgentId) { clearCronForm(); cancelCronEdit(); }
    // The same agent again keeps what was typed, and an Edit under way stays one while the sheet
    // is open (closing it ends the edit: endCronEdit), with its button, its note and what it put
    // in the form, until Cancel or Save: ended by the tab drawn again (Overview and back), Save
    // added the task being edited as a second one.
    cronAgentId = id;
    sheetButton('cronAddBtn', id); // its own: off only while its own save is out (addCronJob, HB-1484)
    $('cronTriggers').checked = !!(agents.find(x => x.id === id) || {}).cronTriggers;
    $('cronAgent').textContent = name;
    $('cronErr').textContent = '';
    $('cronList').innerHTML = 'Loading…';
  });
}
function cancelCronEdit() {
  sheetFill(['cronNote'], () => {
    cronEditingId = null; cronEditFilled = null;
    $('cronAddBtn').textContent = 'Add task';
    $('cronEditNote').style.display = 'none';
    $('cronNote').checked = false;
  });
}
async function loadCrons() {
  if (!cronAgentId) return;
  const read = ++cronRead;
  $('cronErr').textContent = '';
  const forId = cronAgentId; // an Edit + Save on another agent's list would create its task here
  try {
    const { crons, waiting, notes, noteReach } = await api(`/v1/agents/${forId}/crons`);
    if (cronAgentId !== forId || read !== cronRead) return;
    cronCache = crons;
    cronNotes = new Set(notes || []);
    cronNoteReach = noteReach !== false;
    cronNoteFormState();
    renderCrons(crons, waiting || []);
  } catch (e) { if (cronAgentId !== forId || read !== cronRead) return; $('cronList').innerHTML = ''; $('cronErr').textContent = e.message; }
}
let cronEditingId = null, cronCache = [];
/**
 * What Edit put in the form (cronFormOf the task then): Save sends only the fields changed from it,
 * so a change made elsewhere since is not undone; the interval box showing just what Edit put there
 * is the task's own interval, unchanged (HB-0588).
 */
let cronEditFilled = null;
/** A task as Edit puts it in the form: the interval in minutes to two places, as the box shows it. */
function cronFormOf(c) {
  return { name: c.name || '', message: c.message || '', mode: c.everyMs && !c.scheduleExpr ? 'every' : 'cron',
    every: c.everyMs ? String(Math.round(c.everyMs / 600) / 100) : '', cron: c.scheduleExpr || '', tz: c.scheduleTz || '', notify: cronNotes.has(c.id) };
}
/** The visible draft, including text typed while a save waits. */
function cronFormDraft() {
  return { name: $('cronName').value, message: $('cronMsg').value, mode: $('cronMode').value,
    every: $('cronEvery').value, cron: $('cronExpr').value, tz: $('cronTz').value, notify: $('cronNote').checked };
}
/**
 * An Edit ended with nothing saved by the sheet closing: it ends, and what it put in the form goes
 * with it, so the form does not hold the task under Add task. Kept only while the sheet is open.
 */
function endCronEdit() {
  if (!cronEditingId) return;
  sheetFill(['cronBody'], () => { cancelCronEdit(); clearCronForm(); });
}
/** The task form empty, as for a new task: every box, and the kind back to a schedule. Its caller notes it (sheetFill). */
function clearCronForm() {
  for (const box of ['cronName', 'cronMsg', 'cronExpr', 'cronEvery', 'cronTz']) $(box).value = '';
  $('cronMode').value = 'cron'; cronModeChanged();
}
// The tasks told on the owner's phone when they run, and whether a note can reach them (HB-0537).
let cronNotes = new Set(), cronNoteReach = true;
/** The form's "tell me" box: off while no note can reach the owner, unless it is already on for the task being edited. */
function cronNoteFormState() {
  const box = $('cronNote');
  box.disabled = !cronNoteReach && !box.checked;
  $('cronNoteLbl').style.opacity = box.disabled ? '.55' : '';
}
/** Where the "tell me" notes come from, said once under the list while they cannot reach the owner. */
function cronNoteHint() {
  if (cronNoteReach) return '';
  const ops = (agents || []).find(a => a.ops);
  const fix = ops
    ? `Give your Hatchabot agent a Telegram bot and send it a message, so it knows where you are — <button type="button" class="linkish" ${onAction('click', 'closeDialog openV2Agent', [["cronDlg"], [`${ops.id ?? ''}`, "messaging"]])}>its chat apps</button>.`
    : 'Set up your Hatchabot agent and give it a Telegram bot first.';
  return `<div class="sub cron-note-hint" style="margin:6px 0">📱 "Tell me on Telegram when it runs" sends a note from your Hatchabot agent's bot. ${fix}${cronNotes.size ? ' Until then, the notes already asked for are not sent.' : ''}</div>`;
}
async function setCronNote(jobId, on, box) {
  const forId = cronAgentId;
  $('cronErr').textContent = '';
  if (box) box.disabled = true;
  try {
    await api(`/v1/agents/${forId}/crons/${encodeURIComponent(jobId)}`, { method: 'PATCH', body: { notify: on } });
    if (cronAgentId !== forId) return;
    if (on) cronNotes.add(jobId); else cronNotes.delete(jobId);
    toast(on ? 'You will get a note on Telegram each time it runs — a link, not the result.' : 'No more notes for this task.', 5000);
  } catch (e) { if (box) box.checked = !on; if (cronAgentId === forId) $('cronErr').textContent = e.message; }
  finally { if (box) box.disabled = !cronNoteReach && !box.checked; }
}
async function saveCronTriggers(on) {
  const forId = cronAgentId, write = ++cronTriggerWrite;
  try {
    const r = await api(`/v1/agents/${forId}`, { method: 'PATCH', body: { cronTriggers: on } });
    toast(r.cronTriggersPending || (on ? 'Event-triggered tasks allowed — tell the agent it can wire its trigger script now.' : 'Event-triggered tasks disabled.'), r.cronTriggersPending ? 12000 : 7000);
    await refresh(false);
  } catch (e) { toast(e.message, 9000); if (cronAgentId === forId && write === cronTriggerWrite) $('cronTriggers').checked = !on; }
}
function cronModeChanged() {
  const every = $('cronMode').value === 'every';
  $('cronExpr').style.display = every ? 'none' : '';
  $('cronEvery').style.display = every ? '' : 'none';
  $('cronTz').style.display = every ? 'none' : '';
}
function editCronJob(id) {
  const c = cronCache.find(x => x.id === id);
  if (!c) return;
  if (c.payloadKind === 'command') { toast('Shell-command tasks are edited by asking the agent (they carry scripts, not messages).'); return; }
  // Cron-expression AND interval tasks load into the form (the form used to be
  // cron-only, so an interval task like a 90s inbox poll couldn't be edited).
  // One-shot ("at") tasks are still edited by asking the agent.
  if (!c.scheduleExpr && !c.everyMs) { toast('This is a one-shot task — edit it by asking the agent, or delete and re-add.'); return; }
  cronEditingId = id; // the form is filled by this press, with no event: while it is armed, a state redraw waits (HB-0444)
  const filled = cronEditFilled = cronFormOf(c);
  sheetFill(['cronBody'], () => { // the task as saved; while Edit is armed, cronEditingId holds the redraw
    $('cronName').value = filled.name;
    $('cronMode').value = filled.mode;
    cronModeChanged();
    $('cronEvery').value = filled.every;
    $('cronExpr').value = filled.cron;
    $('cronTz').value = filled.tz;
    $('cronMsg').value = filled.message;
    $('cronNote').checked = filled.notify;
    cronNoteFormState();
  });
  $('cronAddBtn').textContent = 'Save changes';
  const note = $('cronEditNote');
  note.style.display = '';
  note.innerHTML = `Editing <b>${esc(c.name || '(unnamed task)')}</b> — <button type="button" class="linkish" ${onAction('click', 'cancelCronEdit')}>cancel</button>`;
  // The form sits under the list: with a dozen tasks it is off-screen, and
  // Edit looked like it did nothing (one agent, 2026-09-26). Bring it up.
  note.scrollIntoView({ block: 'start', behavior: 'smooth' });
  setTimeout(() => $('cronName').focus(), 250);
  toast(`"${c.name || 'The task'}" is in the form below — change it and Save.`, 4000);
}
async function addCronJob() {
  const name = $('cronName').value.trim(), message = $('cronMsg').value.trim();
  const every = $('cronMode').value === 'every';
  const cron = every ? '' : $('cronExpr').value.trim();
  const everyMinutes = every ? Number($('cronEvery').value) : 0;
  const editing = cronEditingId && cronCache.find(x => x.id === cronEditingId);
  // What Edit put in the form (or, not known, the task as listed): only what differs from it is sent.
  const filled = editing ? cronEditFilled ?? cronFormOf(editing) : null;
  // A new task with the Timezone box blank runs in the viewer's own zone, not
  // the container's UTC ("0 8 * * *" fired at 04:00 in Toronto; night review).
  // An edited schedule task keeps what it had.
  let browserTz = '';
  try { browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { /* old browser: leave blank */ }
  const tzBox = $('cronTz').value.trim();
  const tz = every ? '' : (tzBox || (filled?.mode === 'cron' ? '' : browserTz));
  // The 0.25-minute floor is for an interval set or changed here: a task made elsewhere that
  // runs more often keeps its cadence through a new name or message (HB-0588). Kept means the
  // box still shows the number Edit put in it: any other, an emptied box too, is an interval
  // set here (near the old one, a change to a 2-second task was dropped unsaid).
  // Compared as numbers: 1.670 is the 1.67 Edit put there.
  const keptInterval = !!(every && filled?.mode === 'every' && filled.every !== ''
    && $('cronEvery').value.trim() !== '' && everyMinutes === Number(filled.every));
  if (!name || !message || (every ? !(everyMinutes >= 0.25 || keptInterval) : !cron)) { $('cronErr').textContent = every ? 'Name, an interval (≥ 0.25 min), and message are all needed.' : 'Name, cron expression, and message are all needed.'; return; }
  if (cronEditingId && !editing) { $('cronErr').textContent = 'That task is no longer in the list — cancel, and add it again if it is gone.'; return; }
  // The agent this save is for: another agent's Schedule tab can be opened
  // while it waits, and its form must not be cleared by this one (#69).
  const forId = cronAgentId, editId = editing ? editing.id : null;
  const notify = $('cronNote').checked && !$('cronNote').disabled;
  const submitted = cronFormDraft();
  // Off while it is out, and given back to its own agent's form only: another agent's Schedule
  // form, opened meanwhile, has its own (prepareCrons), and may have its own save out (HB-1484).
  const pressed = sheetPress('cronAddBtn', forId);
  $('cronErr').textContent = '';
  try {
    if (editing) {
      // Changed in place, sending only what changed. It used to be re-created,
      // and the new one went to the owner's chat: a task that posted to a
      // member's chat or a group moved to the owner (2026-10-10). In place,
      // where it posts, whether it is quiet or paused, and its runs all stay.
      // Changed from what Edit put in the form, not from the task as listed now: a field left
      // as it was does not put back what was changed elsewhere since (the agent, another page).
      const change = {};
      if (name !== filled.name.trim()) change.name = name;
      if (message !== filled.message.trim()) change.message = message;
      if (every) {
        if (filled.mode !== 'every' || !keptInterval) change.everyMinutes = everyMinutes;
      } else {
        if (filled.mode !== 'cron' || cron !== filled.cron) change.cron = cron;
        // The box emptied on a task with a zone: "yours if blank", or no zone
        // of its own when the browser names none. Ignored, the old zone stayed (HB-0366).
        if (filled.mode !== 'cron') { if (tz) change.tz = tz; }
        else if (tzBox !== filled.tz) change.tz = tz || (filled.tz ? browserTz : '');
      }
      if (notify !== filled.notify) change.notify = notify;
      if (Object.keys(change).length) {
        await api(`/v1/agents/${forId}/crons/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: change });
        toast('Task saved');
      } else toast('Nothing was changed.');
    } else {
      await api(`/v1/agents/${forId}/crons`, { method: 'POST', body: { ...(every ? { name, everyMinutes, message } : { name, cron, message, tz: tz || undefined }), ...(notify ? { notify: true } : {}) } });
      toast(notify ? 'Task saved — you will get a note on Telegram each time it runs.' : 'Task saved');
    }
    if (cronAgentId !== forId) return;
    // Empty only the submitted draft. New typing stays, and another Save
    // compares it with this successful save, including a field reverted to
    // its earlier value while the request waited.
    if (cronEditingId === editId) {
      if (JSON.stringify(cronFormDraft()) === JSON.stringify(submitted)) {
        sheetFill(['cronBody'], () => { cancelCronEdit(); clearCronForm(); }); // its interval and zone too: left, they went into the next task unseen
      } else if (editing && cronEditFilled === filled) cronEditFilled = submitted;
    }
    await loadCrons();
  } catch (e) { if (cronAgentId === forId) $('cronErr').textContent = e.message; else toast(e.message, 9000); }
  finally { pressed(cronAgentId === forId); }
}
/** How a task's runs are going, from the scheduler's own state: a task that
 *  fails every day looked exactly like a healthy one (night review). */
function cronRunLine(c) {
  const errs = Number(c.consecutiveErrors) || 0;
  const failing = errs > 0 || c.lastStatus === 'error';
  const bits = [];
  if (c.lastRunAtMs) {
    const when = ago(new Date(c.lastRunAtMs).toISOString());
    bits.push(failing ? `last run failed ${when}${errs > 1 ? ` · ${errs} in a row` : ''}`
      : `last run ${c.lastStatus && c.lastStatus !== 'ok' ? esc(c.lastStatus) + ' ' : 'ok '}${when}${c.lastDelivered === false ? ' · not delivered' : ''}`);
  } else if (failing) bits.push(errs > 1 ? `failing · ${errs} in a row` : 'last run failed');
  if (c.enabled !== false && c.nextRunAtMs) bits.push(`next ${esc(clock(new Date(c.nextRunAtMs).toISOString()))}`);
  if (!bits.length) return '';
  return `<div class="sub cronRuns">${failing ? '<span class="chip FAILED">failing</span> ' : ''}${bits.join(' · ')}</div>`;
}
// Tasks its template carried that are not on the agent yet (HB-0231): each
// with why, and one way to try again now (a start, a wake or a rebuild also does).
function cronWaitingRows(waiting) {
  if (!waiting.length) return '';
  return waiting.map((w) => {
    const msg = (w.message || '').replace(/\s+/g, ' ').trim();
    return `<div class="pair" style="align-items:flex-start">
      <span class="grow">
        <b>${esc(w.name || '(unnamed task)')}</b> <span class="chip" title="From its template; not on the agent yet">waiting to be added</span>
        <div class="sub">⏱ ${esc(cronScheduleLabel({ scheduleKind: w.cron ? 'cron' : 'every', scheduleExpr: w.cron, scheduleTz: w.tz, everyMs: w.everyMs }))}</div>
        <div class="sub cron-waiting-why">${esc(w.why ? `Not added yet: ${w.why}.` : 'Not added yet: it is added once the agent has been set up.')} Hatchabot tries again when the agent starts, wakes or is rebuilt.</div>
        ${msg ? `<div class="sub" style="margin-top:2px;opacity:.85">${esc(msg.slice(0, 160))}${msg.length > 160 ? '…' : ''}</div>` : ''}
      </span>
    </div>`;
  }).join('') + `<div style="margin:4px 0 8px"><button id="cronWaitingRetry" ${onAction('click', 'retryWaitingCrons')}>Try adding ${waiting.length === 1 ? 'it' : 'them'} now</button></div>`;
}
async function retryWaitingCrons() {
  const forId = cronAgentId;
  $('cronErr').textContent = '';
  try {
    const { waiting } = await api(`/v1/agents/${forId}/crons/waiting`, { method: 'POST', body: {} });
    if (cronAgentId !== forId) return;
    toast(waiting.length ? `${waiting.length === 1 ? 'A task is' : `${waiting.length} tasks are`} still waiting — the reason is under ${waiting.length === 1 ? 'it' : 'each'}.` : 'Added.', 8000);
    await loadCrons();
  } catch (e) { if (cronAgentId === forId) $('cronErr').textContent = e.message; }
}
/** The row's "tell me" box (HB-0537): on, or off — and off cannot be turned on while no note can reach the owner. */
function cronNoteBox(c) {
  const on = cronNotes.has(c.id), off = !on && !cronNoteReach;
  return `<label class="sub cron-note" style="display:inline-flex;gap:5px;align-items:center;cursor:${off ? 'default' : 'pointer'};font-weight:400;margin-top:3px${off ? ';opacity:.55' : ''}"
    title="${off ? 'Your Hatchabot agent has no Telegram bot that reaches you yet — see the note above the tasks.' : 'A short message from your Hatchabot agent\'s Telegram bot each time it has run, with a link to the agent. The result itself stays in Hatchabot.'}">
    <input type="checkbox" style="width:auto;margin:0;flex:none" ${on ? 'checked' : ''} ${off ? 'disabled' : ''} ${onAction('change', 'setCronNote', [`${c.id ?? ''}`, { $: 'checked' }, { $: 'el' }])}> 📱 Tell me on Telegram when it runs</label>`;
}
function renderCrons(crons, waiting = []) {
  if (!crons.length) {
    $('cronList').innerHTML = cronWaitingRows(waiting) + (waiting.length ? '' : '<div class="sub">No scheduled tasks yet — add one below.</div>');
    return;
  }
  $('cronList').innerHTML = cronNoteHint() + cronWaitingRows(waiting) + crons.map(c => {
    const msg = (c.message || '').replace(/\s+/g, ' ').trim();
    // OpenClaw's own upkeep (its weekly skill review, memory dreaming): shown so
    // nothing runs unseen, but the gateway refuses to change or remove it.
    if (c.system) return `<div class="pair phone-stack" style="align-items:flex-start">
      <span class="grow">
        <b>${esc(c.name || '(unnamed task)')}</b> <span class="chip" title="Declared by OpenClaw itself; it cannot be changed or deleted from here">built into OpenClaw</span>
        <div class="sub">⏱ ${esc(cronScheduleLabel(c))}</div>
        ${cronRunLine(c)}
        ${msg ? `<div class="sub" style="margin-top:2px;opacity:.85">${esc(msg.slice(0, 160))}${msg.length > 160 ? '…' : ''}</div>` : ''}
      </span></div>`;
    return `<div class="pair phone-stack" style="align-items:flex-start">
      <span class="grow">
        <b>${esc(c.name || '(unnamed task)')}</b> ${c.enabled ? '' : '<span style="color:var(--dim)">· disabled</span>'}
        <div class="sub">⏱ ${esc(cronScheduleLabel(c))}${c.payloadKind === 'command' ? ' · shell' : ''}</div>
        ${cronRunLine(c)}
        ${msg ? `<div class="sub" style="margin-top:2px;opacity:.85">${esc(msg.slice(0, 160))}${msg.length > 160 ? '…' : ''}</div>` : ''}
        ${cronNoteBox(c)}
      </span>
      <button ${onAction('click', 'editCronJob', [`${c.id ?? ''}`])} title="Load this task into the form below to change it">✏️ Edit</button>
      <button ${onAction('click', 'toggleCron', [`${c.id ?? ''}`, (!c.enabled)])}>${c.enabled ? 'Disable' : 'Enable'}</button>
      <button ${onAction('click', 'runCron', [`${c.id ?? ''}`, (c.payloadKind === 'command')])} title="Fire it now to test — the result arrives the task's usual way">Run now</button>
      <button ${onAction('click', 'deleteCron', [`${c.id ?? ''}`, `${(c.name || 'this task') ?? ''}`])}>Delete</button>
    </div>`;
  }).join('');
}
async function toggleCron(jobId, enabled) {
  $('cronErr').textContent = '';
  try {
    await api(`/v1/agents/${cronAgentId}/crons/${encodeURIComponent(jobId)}`, { method: 'PATCH', body: { enabled } });
    toast(enabled ? 'Task enabled' : 'Task disabled');
    await loadCrons();
  } catch (e) { $('cronErr').textContent = e.message; }
}
let cronRunBusy = false;
async function runCron(jobId, isShell) {
  if (cronRunBusy) return; // a second click would double-fire the task
  if (isShell && !confirm('Run this shell task now? It executes a command on the agent.')) return;
  cronRunBusy = true;
  $('cronErr').textContent = '';
  try {
    await api(`/v1/agents/${cronAgentId}/crons/${encodeURIComponent(jobId)}/run`, { method: 'POST', body: {} });
    toast('Fired — watch for the result where the task normally reports');
  } catch (e) { $('cronErr').textContent = e.message; }
  finally { cronRunBusy = false; }
}
async function deleteCron(jobId, name) {
  if (!confirm(`Delete "${name}"? This removes the scheduled task from the agent, and can't be undone here.`)) return;
  $('cronErr').textContent = '';
  try {
    await api(`/v1/agents/${cronAgentId}/crons/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    toast('Task deleted');
    await loadCrons();
  } catch (e) { $('cronErr').textContent = e.message; }
}
// Telegram Web's documented deep-link: the #@username hash form only resolves
// in some client states, but tgaddr survives reliably (needs a logged-in
// Telegram Web session either way).
const tgWebLink = (username) =>
  `https://web.telegram.org/k/#?tgaddr=${encodeURIComponent(`tg://resolve?domain=${username}`)}`;

let invShare = null; // { name, link, message } for the current invite dialog
/**
 * An invite may name WHO it is for. The claim window it opens then admits
 * only that Telegram account, instead of binding whoever messages the bot
 * first — the difference between a door left ajar and one held open for a
 * named person. Optional, because you don't always know their handle.
 */
async function invite(id, name) {
  const a = agents.find(x => x.id === id);
  // Web chat is offered where people sign in, and never for your Hatchabot agent.
  const web = appConfig.authMode !== 'password' && !a?.ops;
  // In no chat app yet: the web is the only way in, so no Telegram question and no chat-app link.
  const webOnly = web && !!a && !v2ChannelKinds(a).length;
  // A new object per opening: an answer for an invite opened before (another
  // agent's, or this one's last time) finds it gone and fills nothing (audit #063).
  const mine = invWebFor = { id, name, epoch: sharingEpoch, person: pagePerson, shown: false };
  invShare = null;
  $('invWeb').hidden = !web;
  $('invWebLink').hidden = true; $('invWebLink').textContent = '';
  $('invWebCopy').hidden = true; $('invWebBtn').hidden = false; $('invWebBtn').disabled = false;
  $('invApps').hidden = webOnly;
  document.querySelectorAll('#inviteDlg .invAppBtn').forEach((b) => { b.hidden = webOnly; });
  if (webOnly) { $('invAgent').textContent = name; invShare = null; mine.shown = true; inviteDlg.showModal(); return; }
  try {
    // One that is no handle is asked for again, never sent to be kept as none: the invite was anyone's (HB-1439 review).
    const who = askHandle(
      `Who is this invite for?\n\nTheir Telegram @handle — then only they can use it, and anyone else who messages the bot is turned away.\n\nLeave blank if you don't know it: whoever redeems the web link and messages first within 30 minutes is admitted. Someone who comes by the Telegram link always waits for your tap.`,
    );
    if (who === null) return; // cancelled
    const inv = await api(`/v1/agents/${id}/invites`, { method: 'POST', body: { for: who || undefined } });
    if (!inviteCurrent(mine)) return;
    $('invAgent').textContent = name;
    $('invLink').textContent = inv.url ?? (location.origin + inv.path);
    const link = a?.deepLink ?? '';
    $('invTgLink').textContent = link;
    const qr = $('invTgQr');
    qr.style.display = link ? '' : 'none';
    if (link) qr.src = `/v1/agents/${id}/qr.svg`;
    // A ready-to-send message, not just the bare URL. The invite's code rides
    // along: copying or sharing it opens the knock window (2026-09-30).
    invShare = { id, name, link, code: inv.code, invite: mine, message: link ? `Chat with ${name} on Telegram: ${link}` : '' };
    // Who it is for, as the server kept it, not as typed: what it said in green was what was typed (HB-1439 review).
    const kept = inv.for || '';
    $('invTgFor').textContent = kept ? `Only @${kept}'s message is shown; anyone else's is turned away.` : '';
    const forWho = $('invFor');
    if (forWho) {
      forWho.textContent = kept
        ? `Only @${kept} can use this link.`
        : `Anyone with this link can use it — the first to message the bot within 30 minutes is admitted.${who ? ` (@${who} was not used.)` : ''}`;
      forWho.style.color = kept ? 'var(--ok)' : 'var(--warn)';
    }
    $('invShareBtn').style.display = (link && navigator.share) ? '' : 'none';
    mine.shown = true;
    inviteDlg.showModal();
  } catch (e) { if (inviteCurrent(mine)) toast(e.message); }
}

/** The web-chat link: minted only when asked for — each one is a way in (2026-09-29). */
let invWebFor = null;
function inviteCurrent(inv) {
  return !!inv && invWebFor === inv && inv.epoch === sharingEpoch && inv.person === pagePerson && !pagePersonAway && !pageSignedOut;
}
inviteDlg.addEventListener('close', () => {
  // close is queued: the next invitation may already be waiting for its API
  // response while the dialog is still shut. Only retire an opening actually shown.
  if (!inviteDlg.open && invWebFor?.shown) { invWebFor = null; invShare = null; }
});
async function makeWebChatInvite() {
  if (!inviteCurrent(invWebFor) || !inviteDlg.open) return;
  // The invite this link is for: closed, and another agent's opened while it was
  // made, A's link landed in B's invite, ready to copy as B's (audit #063).
  const forInv = invWebFor;
  $('invWebBtn').disabled = true;
  try {
    const inv = await api(`/v1/agents/${forInv.id}/invites`, { method: 'POST', body: { webChat: true } });
    if (!inviteCurrent(forInv) || !inviteDlg.open) return;
    $('invWebLink').textContent = inv.url ?? (location.origin + inv.path);
    $('invWebLink').hidden = false;
    $('invWebBtn').hidden = true;
    $('invWebCopy').hidden = false;
  } catch (e) { if (inviteCurrent(forInv) && inviteDlg.open) { toast(e.message, 8000); $('invWebBtn').disabled = false; } }
}
async function copyWebChatInvite() {
  const ok = await copyText($('invWebLink').textContent);
  toast(ok ? 'Web chat link copied — it works once, for 48 hours' : 'Select the link and copy it manually');
}

/**
 * Members → "someone on this Hatchabot": the people the agent can be shared
 * with for web chat, no link (2026-11-10). Each says Google or password: they
 * are separate accounts even under one email. Nobody to offer: no row.
 */
const SHARE_NOTE = "They chat with it on the web, with a member's rights. It appears on their home screen straight away.";
async function loadWebChatPeople() {
  const row = $('tgShareRow');
  if (!row) return;
  // For the agent the forms are filled for, drawn (and its Share button armed) only while this sharing read is the latest.
  const r = sheetRead(row), forId = r.id, current = r.mine;
  sharePeopleFor = null;
  row.hidden = true;
  $('tgSharePerson').textContent = '';
  const a = agents.find((x) => x.id === forId);
  if (appConfig.authMode === 'password' || !a || a.ops || !v2Mine(a)) return;
  let people = [];
  try { people = (await api(`/v1/agents/${forId}/web-chat/people`)).people || []; } catch { return; }
  const open = people.filter((p) => !p.shared);
  if (!open.length) return;
  const kind = { google: 'Google', password: 'password' };
  r.draw(() => {
    $('tgSharePerson').innerHTML = '<option value="">Share with someone on this Hatchabot…</option>' + open.map((p) =>
      `<option value="${esc(p.userId)}">${esc(p.label)}${p.username ? ` (${esc(p.username)})` : ''} · ${kind[p.kind] || esc(p.kind)}</option>`).join('');
    $('tgShareNote').textContent = SHARE_NOTE;
    sharePeopleFor = { id: forId, current };
    row.hidden = false;
    // On as the agent has it: off while a share of its is still out (HB-1489). Turned on here by hand, a read of its
    // list again while one was out let a second share be sent.
    sheetButton('tgShareBtn', forId);
  });
}
async function shareWebChatWith() {
  const target = sharePeopleFor;
  if (!target?.current() || $('tgShareRow').hidden) return;
  const forId = target.id, sel = $('tgSharePerson'), userId = sel.value;
  if (!userId) { $('tgShareNote').textContent = 'Choose who to share it with first.'; return; }
  const who = sel.selectedOptions[0]?.textContent.split(' · ')[0] || 'them';
  // The button held through the sheet's handle while the share is out, and given back as the agent has it (HB-1489).
  // What comes back is said however late, with its agent's name under another agent's sheet (HB-1486); nothing once the
  // page is another person's. Its list is read again, and a refusal put by the share, only while that list is the one read.
  const f = sheetSave().hold('tgShareBtn'), page = sharingPage();
  try {
    await api(`/v1/agents/${forId}/web-chat/people`, { method: 'POST', body: { userId } });
    if (!page()) return;
    f.say(`Shared with ${who}: it's on their home screen now`);
    if (target.current()) await f.draw(renderEditMembers);
  } catch (e) {
    if (target.current()) $('tgShareNote').textContent = e.message;
    else if (page()) f.say(e.message, 9000);
  } finally { f.done(); }
}

async function copyInvite() {
  const ok = await copyText($('invLink').textContent);
  toast(ok ? 'Web link copied' : 'Select the link and copy it manually');
}

/**
 * Copying or sharing the Telegram invite holds the door open for 30 minutes
 * (2026-09-30): an agent under "Invite only" drops a stranger's message in
 * silence, so the "wants to join" prompt the dialog promised never came. The
 * window only SHOWS their knock; the owner's tap lets them in. Returns the
 * words to add to the toast, or null when the door could not be opened.
 * `sent`: what that means for the invite already copied or shared, said after
 * the reason. The copy comes first, while the press still lets the page write
 * the clipboard, so the link was out with the door shut, and nothing said so (HB-1363).
 */
async function openInviteKnockWindow(inv = invShare, sent = '') {
  const current = () => invShare === inv && inviteCurrent(inv?.invite) && inviteDlg.open;
  if (!current() || !inv?.code || !inv?.id) return null;
  try {
    const r = await api(`/v1/agents/${inv.id}/invites/${encodeURIComponent(inv.code)}/knock-window`, { method: 'POST', body: {} });
    if (!current()) return null;
    return r.alreadyOpen ? ' Anyone can knock on this agent, so their request will show under Alerts.'
      : ` For the next ${r.minutes} minutes their message shows under Alerts — tap Let them in.`;
  } catch (e) { if (current()) toast(sent ? `${withStop(e.message)} ${sent}` : e.message, sent ? 12000 : 8000); return null; }
}
/** `text` ending in one full stop: its own trailing stops and spaces trimmed by a loop (a regex for them is quadratic). */
function withStop(text) {
  const s = String(text ?? '');
  let end = s.length;
  while (end > 0 && (s[end - 1] === '.' || /\s/.test(s[end - 1]))) end--;
  return `${s.slice(0, end)}.`;
}
/** An invite that is out, its door not open: what that means, and the way to open it. */
const INVITE_DOOR_SHUT = 'their message will not show under Alerts until this works: press Copy Telegram invite again in a moment.';

async function copyInviteTg() {
  if (!invShare?.message) { toast('This agent has no Telegram bot yet'); return; }
  const inv = invShare;
  const ok = await copyText(inv.message);
  const door = await openInviteKnockWindow(inv, ok ? `The invite is copied, but ${INVITE_DOOR_SHUT}` : '');
  if (door === null) return; // the reason is on screen
  toast(ok ? `Telegram invite copied — paste it to them.${door}` : `Select the link and copy it manually.${door}`, door ? 9000 : undefined);
}

async function shareInviteTg() {
  if (!invShare?.link) return;
  const inv = invShare;
  try { await navigator.share({ title: `Chat with ${inv.name}`, text: inv.message, url: inv.link }); }
  catch { return; /* user cancelled the share sheet, or it's unavailable — no door opened */ }
  const door = await openInviteKnockWindow(inv, `The invite is shared, but ${INVITE_DOOR_SHUT}`);
  if (door) toast(`Shared.${door}`, 9000);
}

/** Agents this account can rebuild right now (owned, live-or-stopped, not moved away). */
// Word the update prompt from the two OpenClaw versions, so a same-version
// image rebuild (e.g. new base tooling) isn't mislabelled as a version upgrade.
function updateBlurb(a) {
  const from = a.openclawVersion, to = a.latestOpenclawVersion;
  if (from && to && from !== to)
    return `OpenClaw ${esc(from)} → ${esc(to)} is ready. Rebuild applies it — memory is kept.`;
  return `A newer runtime image is ready${to ? ` (same OpenClaw ${esc(to)})` : ''}. Rebuild applies it — memory is kept.`;
}

/** Rebuild reasons other than the newer image (which has its own ⬆ Update row). */
function rebuildOtherReasons(a) {
  return (a.rebuild?.reasons ?? []).filter(r => !/newer runtime image|^the fleet default (moved to|image was rebuilt)/.test(r));
}

/**
 * Every action that rebuilds a RUNNING agent right now asks first — a rebuild
 * stops whatever the agent is doing (Chris added Telegram to an agent mid-job,
 * 2026-09-25). A stopped agent has nothing to interrupt, and a change does not
 * start it (it comes up with it when next started; HB-0420), so no question then.
 * `what` names the action; the answer is the user's, so the caller stops on false.
 * `a`: the agent as the server has just said it, when the caller has that (newer than the page's poll).
 */
function confirmRebuild(id, what, a = agents.find(x => x.id === id)) {
  if (!a || a.state !== 'RUNNING') return true;
  const now = a.busy
    ? `It is working on something right now — that stops, unfinished, and it starts again from its memory.`
    : `Anything it is doing stops, and it starts again from its memory.`;
  return confirm(`${what} rebuilds "${a.name}" now, which takes it offline for a minute or two.\n${now}\n\nGo ahead?`);
}
async function rebuild(id) {
  if (!confirmRebuild(id, 'Rebuild')) return;
  // Asked for by name, this is the one thing that does start a stopped agent: say so.
  const down = agents.find(x => x.id === id);
  if (down?.state === 'STOPPED' && !confirm(`A rebuild ends with "${down.name}" running, on its chat apps and able to spend on its AI source. It is ${down.hibernatedAt ? 'asleep' : 'stopped'} now.\n\nRebuild and start it?`)) return;
  try {
    await api(`/v1/agents/${id}/rebuild`, { method: 'POST', body: {} });
    toast('Rebuilding — memory is kept');
    await refresh(false);
  } catch (e) { toast(e.message); }
}

/**
 * The page's one "needs a rebuild" rule, as Bulk actions' Needs rebuild chip counts it: the
 * server's rebuild need (rebuildNeedOf, which counts an image the fleet default moved on from),
 * a model waiting for one, or peer changes waiting for one; not while it is being re-checked.
 * Rebuild all and Bulk Rebuild mark a stopped or sleeping agent by it. Its own pin not run yet is
 * applied by its start, owed or not (pinNotRunYet).
 */
function rebuildChangesIt(a) { return !!a && !isRechecking(a) && !!((a.pendingModel && a.pendingModel !== a.model) || a.rebuild || a.peersPending); }
/**
 * What Rebuild all and Bulk actions → Rebuild do with an agent, by the last poll here: 'now' (a
 * running one is rebuilt now), 'next start' (a stopped or sleeping one stays down, and is marked
 * for a rebuild at its next start when one would change it, HB-0466), or null: one never built (no
 * container yet), moved to another machine, already current, or in no state to rebuild. The one
 * rule: rebuildOrMark sends by it, and Rebuild all counts by it before asking.
 */
function rebuildPlan(a) {
  if (!a?.runtimeRef || a.migratedTo) return null;
  if (a.state === 'RUNNING') return 'now';
  return a.state === 'STOPPED' && rebuildChangesIt(a) ? 'next start' : null;
}
/**
 * Rebuild all and Bulk actions → Rebuild, one way (rebuildPlan), and the server's own state with
 * stoppedWaits. Says which: 'rebuilding', 'next start', 'not needed', or 'busy' (409: busy, or
 * already being rebuilt or moved: skipped). Any other failure is thrown, for the caller to name.
 */
async function rebuildOrMark(a) {
  if (!rebuildPlan(a)) return 'not needed';
  try {
    const r = await api(`/v1/agents/${a.id}/rebuild`, { method: 'POST', body: { stoppedWaits: true } });
    return r?.atNextStart ? 'next start' : 'rebuilding';
  } catch (e) {
    if (e?.status === 409) return 'busy';
    throw e;
  }
}
/** One agent's reason, as Rebuild all and Bulk actions name it: its name and what was said, without the closing stop. */
function reasonFor(name, e) {
  return `${name}: ${String(e?.message ?? e).replace(/[.\s]+$/, '')}`;
}
/** The first reasons named (up to three are kept), and how many more: "A: …; B: …; and 2 more". */
function reasonsSaid(reasons, count) {
  return reasons.join('; ') + (count > reasons.length ? `; and ${count - reasons.length} more` : '');
}

async function rebuildAll(btn) {
  // The owner's agents, by rebuildOrMark's own rule (rebuildPlan), the running ones first: counted
  // by it before asking, and each sent to rebuildOrMark, which goes by it again. Stopped and sleeping agents stay down; one a rebuild would
  // change is marked for one at its next start, as the button's note says: left out, one merely
  // behind the image started on its old one (HB-0466). One already current needs none.
  const mine = agents.filter(a => (a.role ? a.role === 'owner' : true));
  const list = mine.filter(a => rebuildPlan(a) === 'now'), down = mine.filter(a => rebuildPlan(a) === 'next start');
  if (!list.length && !down.length) { toast('Nothing to rebuild right now.'); return; }
  const atOnce = Number(appConfig?.rebuildConcurrency) || 6;
  // About a minute each on ordinary hardware, several at a time.
  const minutes = Math.max(1, Math.round((list.length / atOnce) * 1.1));
  const later = down.length ? `${down.length} stopped or sleeping agent${down.length === 1 ? ' stays' : 's stay'} down, and ${down.length === 1 ? 'is' : 'each is'} rebuilt when it next starts.` : '';
  if (!confirm(!list.length ? `No agent is running. ${later}\n\nGo ahead?` :
    `Rebuild ${list.length} running agent${list.length === 1 ? '' : 's'} on the current runtime image?\n\n` +
    `Each gets a new container (memory kept) and briefly goes offline while it ` +
    `restarts. A pre-rebuild snapshot is taken automatically.\n\n` +
    `They go ${atOnce} at a time, so this takes roughly ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
    `You can close this page — it carries on.${later ? `\n\n${later}` : ''}`
  )) return;

  if (btn) btn.disabled = true;
  let started = 0, skipped = 0, nextStart = 0, failed = 0; const reasons = [];
  // Immediate feedback — the POSTs now return fast (the snapshot moved into the
  // background task server-side), but say so up front so the row never sits
  // silent, then repaint chips as they flip to REBUILDING.
  // What will happen, counted: rebuilds now, and marks for a next start.
  toast([list.length ? `Queuing ${list.length} rebuild${list.length === 1 ? '' : 's'}…` : '',
    down.length ? `${down.length} not running: marked for a rebuild when ${down.length === 1 ? 'it next starts' : 'each next starts'}.` : ''].filter(Boolean).join(' '));
  // Fire sequentially: each call returns as soon as its rebuild is queued, so
  // this staggers the snapshots rather than hammering the box all at once.
  // Each agent keeps its own guards server-side (busy, moved-away, in-flight).
  for (const a of [...list, ...down]) {
    try {
      const r = await rebuildOrMark(a);
      if (r === 'next start') nextStart++; else if (r === 'rebuilding') started++; else if (r === 'busy') skipped++;
    } catch (e) {
      // Anything but busy failed, and is named with its reason, as Bulk actions names them: not passed off as busy.
      failed++; if (reasons.length < 3) reasons.push(reasonFor(a.name, e));
    }
  }
  if (btn) btn.disabled = false;
  const took = Math.max(1, Math.round((started / atOnce) * 1.1));
  toast(`${started || !(nextStart || skipped || failed) ? `Rebuilding ${started} agent${started === 1 ? '' : 's'}, ${atOnce} at a time — about ${took} minute${took === 1 ? '' : 's'}. ` : ''}`
    + `${nextStart ? `${nextStart} not running: ${nextStart === 1 ? 'it is' : 'each is'} rebuilt when it next starts. ` : ''}`
    + `${skipped ? `${skipped} skipped (busy or already changing). ` : ''}`
    + `${failed ? `${failed} failed — ${reasonsSaid(reasons, failed)}. ` : ''}Memory is kept.`, failed ? 20000 : 12000);
  await refresh(false);
}

async function del(id, name) {
  // Deliberately annoying: deletion erases the agent's memory for good, so it
  // costs a typed confirmation, not a reflex click.
  const a = agents.find(x => x.id === id);
  // A copy downloaded while it stood stopped may be answering elsewhere: its bot is not parked then.
  const copyElsewhere = !!a?.exportedAt && a.state !== 'RUNNING';
  const botNote = a?.botUsername
    ? copyElsewhere
      ? `\n\nA copy of it was downloaded, so its Telegram bot @${a.botUsername} is NOT parked for reuse here — the copy may be talking on it. (Settings → Messaging → Telegram → Add to pool parks it by hand if you want that.)`
      : `\n\nIts Telegram bot @${a.botUsername} is kept in the Bot pool for the next agent (remove it there if you don't want that). "Delete chat" on it in Telegram clears your old conversation view.`
    : '';
  // Its volume stays in the nightly backup sets until they age out
  // (scripts/backup-volumes.sh, 14 days) — say so, not "forever" (2026-09-30).
  const typed = prompt(`This permanently erases "${name}" and everything it remembers. Copies in this machine's nightly backups are removed as they age out (14 days).${botNote}\n\nType the agent's name to confirm:`);
  if (typed === null) return;
  if (typed.trim() !== name) { toast('Name did not match — nothing deleted.'); return; }
  // The bot is parked in the pool by default (server-side): bots are the
  // scarce resource, and Settings → Bot pool is where one gets discarded
  // on purpose.
  try {
    await api(`/v1/agents/${id}`, { method: 'DELETE' });
    if (a?.botUsername) toast(copyElsewhere ? `Deleted. Bot @${a.botUsername} was left to the downloaded copy, not parked.` : `Deleted. Bot @${a.botUsername} is parked in the Bot pool, ready for the next agent.`, 8000);
    await refresh(false);
  }
  catch (e) { toast(e.message); }
}

async function kick(agentId, userId, label) {
  if (!confirm(`Remove ${label}? They lose access to this agent immediately.\n\nAnything they set up through it (scheduled tasks) keeps running; check Schedule.`)) return;
  // For the agent whose Members list it was pressed in: its list is read again only while its forms are (HB-1487). The
  // button's then read the members of whichever agent was shown by then. Said in a toast, as before, with the agent's name
  // once another agent's sheet is shown (HB-1486); nothing once the page is another person's, or signed out (HB-1486 review).
  const f = forAgent(agentId), page = sharingPage();
  try {
    await api(`/v1/agents/${agentId}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    if (!page()) return;
    f.say(`${label} removed`);
    pairTick = 0; // refetch members on next poll
    await refresh(false);
    await f.draw(renderEditMembers);
  } catch (e) { if (page()) f.say(e.message); }
}
