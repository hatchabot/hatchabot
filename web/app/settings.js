// web/app/settings.js: Settings: its tabs, Advanced, what every agent is told about you, what each agent can reach, the security posture and access tokens, the media and web search keys, Telegram bots and the bot pool, spare Discord bots and Slack apps, hosts and the machine's defaults, the memory search service, the rebuild policy, backups, recovery readiness.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- AI sources -------------------------------------------------------------

const TABS = { ai: 'paneAi', classes: 'paneClasses', hosts: 'paneHosts', pool: 'panePool', discord: 'paneDiscord', slack: 'paneSlack', servers: 'paneServers', conn: 'paneConn', access: 'paneAccess', backups: 'paneBackups', runtime: 'paneRuntime', security: 'paneSecurity', operator: 'paneOperator' };

/**
 * The Settings panel's tabs, grouped by what people come to do:
 * "You" joins the account and the operator profile; Messaging joins the spare
 * bots of Telegram, Slack and Discord, one at a time; Hosts joins runners and other servers.
 * Old deep links (openAiDlg('hosts'), openAiDlg('discord')) land on their
 * group, scrolled to their part.
 */
const V2_SETTINGS = [
  ['people', 'You', ['access', 'operator']],
  ['ai', 'AI', ['ai']],
  ['classes', 'Classes', ['classes']],
  // One tab for the three chat apps (the owner, 2026-11-07), Telegram first:
  // each is a pool of spare bots drawn the same way, so they read as one place.
  // It shows one of them at a time, picked from a list (v2SettingsShown).
  ['messaging', 'Messaging', ['pool', 'slack', 'discord']],
  ['conn', 'Connections', ['conn']],
  // Runners only: the household's way to add a machine. Other servers moved to Advanced (v2.157.0).
  ['machines', 'Hosts', ['hosts']],
  ['backups', 'Backups', ['backups']],
  ['security', 'Security', ['security']],
  // Last: what only several servers, or your own runtime images, need. Its
  // parts are folded drawers (initSettingsAdvanced), shut until opened.
  ['advanced', 'Advanced', ['advanced', 'servers', 'runtime', 'derived']],
];
/** Tab names that are gone, and the pane they open now: old links keep working. */
const V2_SETTINGS_ALIAS = { images: 'runtime', telegram: 'pool' };
// Messaging's panes have none: it shows one at a time, named in its list.
const V2_SETTINGS_HEAD = { access: 'Your account', operator: 'About you' };
let v2SettingsGroup = 'ai';
/**
 * The panes of group g to show. Messaging shows one app at a time (the owner,
 * 2026-11-09: all three were "too much on one screen"): the one a link names
 * (openAiDlg('discord')), else the one shown last, remembered per browser.
 */
const V2_MSG_KEY = 'hb-settings-messaging';
function v2SettingsShown(g, name) {
  if (g[0] !== 'messaging') return g[2];
  let pick = g[2].includes(name) ? name : null;
  if (!pick) { try { pick = localStorage.getItem(V2_MSG_KEY); } catch { /* a private window */ } }
  if (!g[2].includes(pick)) pick = g[2][0];
  try { localStorage.setItem(V2_MSG_KEY, pick); } catch { /* a private window */ }
  return [pick];
}
/**
 * Wrap each heading-delimited run of a settings pane in a card, so a tab reads
 * as sections with edges instead of one scroll. Done in the DOM rather than in
 * the markup so both looks share one source, and idempotent — panes are shown
 * again every time you switch tabs.
 */
function v2Sectionise(pane, isBreak = (kid) => kid.tagName === 'H4') {
  if (!pane || pane.dataset.sectioned === '1') return;
  pane.dataset.sectioned = '1';
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const card = document.createElement('div');
    card.className = 'v2card';
    run[0].before(card);
    for (const n of run) card.append(n);
    run = [];
  };
  for (const kid of [...pane.children]) {
    if (isBreak(kid)) flush();
    run.push(kid);
  }
  flush();
}

function showTab(name) {
  name = V2_SETTINGS_ALIAS[name] ?? name;
  const g = V2_SETTINGS.find(([k, , panes]) => k === name || panes.includes(name)) ?? V2_SETTINGS[0];
  v2SettingsGroup = g[0];
  const shown = v2SettingsShown(g, name);
  // Each pane's loader; a folded Advanced drawer loads when it is opened.
  for (const pane of shown) { if (!settingsAdvFolded(pane)) loadSettingsPane(pane); v2Sectionise($(TABS[pane])); }
  for (const [key, pane] of Object.entries(TABS)) $(pane).hidden = !shown.includes(key);
  // A pane alone needs no heading: the tab, or the Messaging list, names it.
  for (const h of document.querySelectorAll('.v2settingshead')) h.hidden = shown.length < 2;
  $('v2MsgPick').hidden = g[0] !== 'messaging';
  if (g[0] === 'messaging') $('v2MsgApp').value = shown[0];
  $('v2SettingsTabs').innerHTML = V2_SETTINGS.map(([k, label]) =>
    `<button class="tab" role="tab" aria-selected="${k === g[0]}" ${onAction('click', 'showTab', [`${k}`])}>${label}</button>`).join('');
  settingsAdvUnfold(name);
  // On a phone the row scrolls: keep the open tab (Advanced is last) in sight —
  // after the dialog has opened (openAiDlg shows the tab first).
  setTimeout(() => $('v2SettingsTabs').querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }), 0);
  // A link to a later part of a joined tab (openAiDlg('runtime')) lands on that part, not on the tab's top.
  // After the row's: its "nearest" would scroll the panel back up to the tabs.
  if (shown.indexOf(name) > 0) setTimeout(() => $(TABS[name])?.scrollIntoView?.({ block: 'start' }), 0);
}
function loadSettingsPane(name) {
  if (name === 'access') { void loadAccounts(); void loadSecondFactor(); void loadReach(true); }
  if (name === 'classes') loadClasses();
  if (name === 'conn') loadConnections();
  if (name === 'hosts') { loadHosts(); loadEmbedder(); void loadEmbedFleet(); loadRebuildSection(); }
  if (name === 'pool') loadPool();
  if (name === 'discord') void loadPoolPane('discord');
  if (name === 'slack') void loadPoolPane('slack');
  if (name === 'backups') loadBackups();
  if (name === 'runtime' || name === 'derived') loadRuntime(); // also fills the derived list
  if (name === 'security') { loadPosture(); void loadCliTokens(); void loadAccessMap(); }
  if (name === 'operator') loadOperator();
}

// ---- Settings → Advanced (v2.157.0) ------------------------------------------
// What only several Hatchabot servers, or your own runtime images, need: one
// tab, last, whose parts are folded drawers — shut until opened, and each
// remembered per browser. A folded part does not load.
const SETTINGS_ADV = [
  ['servers', 'Other Hatchabot servers', 'separate servers, each with its own dashboard: move an agent to one'],
  // Not "promote": a pin of HATCHABOT_IMAGE turns Promote off, and the setting makes one the default then (HB-1256).
  ['runtime', 'Runtime images', 'the OpenClaw your agents run: try a newer one on one agent, then make it the default'],
  ['derived', 'Derived images', 'the base image plus extra packages, for an agent that needs them'],
];
const SETTINGS_ADV_KEY = 'hb-settings-adv';
function settingsAdvOpenSet() {
  try { const v = JSON.parse(localStorage.getItem(SETTINGS_ADV_KEY) || '[]'); return new Set(Array.isArray(v) ? v : []); }
  catch { return new Set(); }
}
/** True for an Advanced part that is folded: its loader waits until it is opened. */
function settingsAdvFolded(pane) {
  const d = $('advPart-' + pane);
  return !!d && !d.open;
}
function settingsAdvToggled(d) {
  const pane = d.dataset.pane, open = settingsAdvOpenSet();
  if (d.open) open.add(pane); else open.delete(pane);
  try { localStorage.setItem(SETTINGS_ADV_KEY, JSON.stringify([...open])); } catch { /* a private window */ }
  if (d.open && v2SettingsGroup === 'advanced' && aiDlg.open) loadSettingsPane(pane);
}
/** A link to a part (openAiDlg('servers'), the old 'images' tab…) lands on it unfolded. */
function settingsAdvUnfold(name) {
  const d = $('advPart-' + name);
  if (!d) return;
  d.open = true; // its toggle event loads it (when it was folded) and remembers it
  setTimeout(() => d.scrollIntoView?.({ block: 'nearest' }), 0);
}
function initSettingsAdvanced() {
  const open = settingsAdvOpenSet();
  $('paneOperator').insertAdjacentHTML('afterend', `<section id="paneAdvanced" role="tabpanel" hidden data-sectioned="1">
    <div class="sub">For running several Hatchabot servers, and building your own runtime images. A household needs none of this.</div>
    ${SETTINGS_ADV.map(([pane, title, what]) => `<details class="sec-drawer" id="advPart-${pane}" data-pane="${pane}"${open.has(pane) ? ' open' : ''} ${onAction('toggle', 'settingsAdvToggled', [{ $: 'el' }])}>
      <summary><b>${title}</b> <span class="sub">— ${what}</span></summary></details>`).join('')}
  </section>`);
  for (const [pane] of SETTINGS_ADV) $('advPart-' + pane).append($(TABS[pane]));
  TABS.advanced = 'paneAdvanced';
  // Automatic rebuilds say when THIS machine rebuilds its agents — every owner's
  // choice, not image building — so they sit with the machine, under Hosts, after
  // Add a runner (which stays the first thing to do there). Its heading moves up a
  // level so the section is a card of its own; both hide for everyone else.
  const rb = $('rbSection'), head = rb.querySelector('h4');
  head.id = 'rbHead'; head.hidden = rb.hidden;
  $('paneHosts').append(head, rb);
}

/** What the server already has, so Save is offered only when there is something
 *  to save — a live button that does nothing reads as a failure. */
let operatorSaved = null;
function syncOperatorBtn() {
  const btn = $('operatorSaveBtn'); if (!btn) return;
  const same = operatorSaved !== null && $('operatorText').value === operatorSaved;
  btn.disabled = same;
  btn.title = same ? 'Already applied to your agents — edit the text to save again.' : '';
}
/** Saves of it pressed, and those not answered yet: a read that overlaps one is set aside (HB-0898). */
let operatorSaves = 0, operatorSaving = 0;
async function loadOperator() {
  $('operatorErr').textContent = '';
  const box = $('operatorText'), shown = box.value, saves = operatorSaves, saving = operatorSaving;
  // A save under way when it was asked, or pressed since: the read may be of
  // the text from before the save, and put back over the saved text with
  // Save on, it was a press away from undoing the save. The save's own
  // answer says what is kept.
  const overlapped = () => saving > 0 || operatorSaves !== saves;
  try {
    const read = (await api('/v1/operator-profile')).content || '';
    if (!overlapped()) {
      operatorSaved = read;
      // Typed in while it was read: what is typed stays, an edit not saved yet (HB-0898).
      if (box.value === shown) box.value = read;
    }
  } catch (e) { $('operatorErr').textContent = e.message; if (!overlapped()) operatorSaved = null; }
  syncOperatorBtn();
}
async function saveOperator() {
  $('operatorSaveBtn').disabled = true; $('operatorErr').textContent = '';
  // The text sent: the box stays open while it saves, and what is typed after
  // the press is an edit of its own, not saved yet. Putting the saved text
  // back over it lost it without a word (HB-0898).
  const box = $('operatorText'), sent = box.value;
  operatorSaves++; operatorSaving++;
  try {
    const r = await api('/v1/operator-profile', { method: 'PUT', body: { content: sent } });
    operatorSaved = r.content;
    if (box.value === sent) box.value = r.content;
    toast(`Saved — applying to ${r.pushing} running agent${r.pushing === 1 ? '' : 's'} in the background${r.pushing === 0 ? ' (stopped agents get it on next start)' : ''}.`, 7000);
  } catch (e) { $('operatorErr').textContent = e.message; }
  finally { operatorSaving--; syncOperatorBtn(); }
}

// ---- What each agent can reach (docs/access-overview-design.md) ----------------------
// The agent's Sharing tab (its Access row) and Settings → Security → What your agents can
// reach. Hatchabot's intent against the last look inside the running agent, pending
// removals, and what it cannot see — said in words.
const ACCESS_MISMATCH_WORDS = { extra: 'should not be there', differs: 'a different token is running', 'stale-removal': 'removal pending over a day', missing: 'not found' };
/** ✓ found as intended (or verified gone), ⚠ a mismatch, ? not checked / not Hatchabot's. */
function accessMark(r) {
  if (r.mismatch) return `<span class="warn" title="${esc(ACCESS_MISMATCH_WORDS[r.mismatch] || r.mismatch)}">⚠</span>`;
  if (r.verified.status === 'enforced') return '<span title="Checked by Hatchabot on every call">✓</span>';
  if (r.verified.status === 'present' && r.intended && r.managed) return '<span title="Found in the running agent">✓</span>';
  if (r.verified.status === 'absent' && !r.intended) return '<span title="Verified gone">✓</span>';
  if (r.pendingRemoval) return '<span title="Removal pending">…</span>';
  return `<span class="sub" title="${r.managed ? 'Not checked yet' : 'Not managed by Hatchabot'}">?</span>`;
}
function accessRowsHTML(ov) {
  if (!ov.groups.length) return '<div class="sub">Nothing: no accounts, bots, folders, variables or people beyond you.</div>';
  return ov.groups.map(g => `<div class="v2accgroup"><b>${esc(g.title)}</b>${g.rows.map(r => `
      <div class="v2accrow" data-kind="${esc(r.kind)}" data-mismatch="${esc(r.mismatch || '')}">
        ${accessMark(r)}
        <span>${esc(r.label)}${r.managed ? '' : ' <span class="sub">· not managed</span>'}${r.mismatch ? ` <span class="warn">— ${esc(ACCESS_MISMATCH_WORDS[r.mismatch] || r.mismatch)}</span>` : ''}${r.pendingRemoval ? `<span class="sub"> · removal pending${r.pendingRemoval.since ? ` since ${esc(ago(r.pendingRemoval.since))}` : ''}</span>` : ''}${r.note ? `<span class="sub"> · ${esc(r.note)}</span>` : ''}</span>
        <span class="sub">${r.verified.at ? esc(ago(r.verified.at)) : ''}</span>
      </div>`).join('')}</div>`).join('');
}
function accessCheckedLine(ov) {
  return ov.checkedAt ? `Last looked inside: ${esc(ago(ov.checkedAt))}.` : 'Not looked inside yet.';
}
// The sheet redraws on every refresh; a reading is reused for 30 s (Verify now reloads it).
let v2AccessCache = null;
let sharingEpoch = 0, sharingView = 0, sharePeopleFor = null;
const sharingReads = new WeakMap();
/** Sharing controls are borrowed between sheets; neither an agent id nor a DOM node alone identifies their current opening. */
function sharingRead(el, id = null) {
  const read = {}, epoch = sharingEpoch, view = sharingView, person = pagePerson;
  sharingReads.set(el, read);
  return () => epoch === sharingEpoch && person === pagePerson && !pagePersonAway && !pageSignedOut
    && (!id || view === sharingView) && sharingReads.get(el) === read && el.isConnected
    && (!id || (forAgent(id).mine() && !!v2Find(id) && v2Mine(v2Find(id)))); // the sheet's forms still its agent's (HB-0644)
}
/**
 * The page still the person's it was for at the press, signed in, and its sharing not put away since (sharingForget):
 * a sharing answer that comes back late is said only then, with its agent's name (HB-1486), never under the next person.
 */
function sharingPage() {
  const epoch = sharingEpoch, person = pagePerson;
  return () => epoch === sharingEpoch && person === pagePerson && !pagePersonAway && !pageSignedOut;
}
function sharingForget() {
  sharingEpoch++; sharePeopleFor = null; v2AccessCache = null; members = {};
  peersLoadedFor = null; peersCurrent = null; $('peerSaveBtn').disabled = true;
  sendOpening = null; sendAgentId = null; inboxShares = []; inboxNext = null; inboxTotal = 0; updateInboxBadge(0);
  for (const id of ['tgMemberList', 'tgKnownPeople', 'tgSharePerson', 'agentPeerList', 'v2Access', 'accessMapOut', 'sendScan', 'accountEmails', 'inboxBody']) { const el = $(id); if (el) el.textContent = ''; }
  for (const id of ['sendToEmail', 'sendMessage']) $(id).value = '';
  for (const dlg of [sendAgentDlg, inboxDlg]) if (dlg.open) dlg.close();
  $('tgShareRow').hidden = true;
  invWebFor = null; invShare = null;
  for (const id of ['invWebLink', 'invLink', 'invTgLink']) $(id).textContent = '';
  $('invTgQr').removeAttribute('src');
  if (inviteDlg.open) inviteDlg.close();
}
async function v2LoadAccess(id, fresh = false, given = null) {
  const el = $('v2Access'); if (!el) return;
  const current = sharingRead(el, id);
  let ov = given || (!fresh && v2AccessCache && v2AccessCache.id === id && Date.now() - v2AccessCache.at < 30_000 ? v2AccessCache.ov : null);
  if (!ov) {
    try { ov = await api(`/v1/agents/${id}/access`); }
    catch (e) { if (current()) el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; return; }
  }
  if (!current()) return;
  v2AccessCache = { id, at: Date.now(), ov };
  const s = ov.summary;
  const head = [s.mismatches ? `<span class="warn">⚠ ${s.mismatches} it should not have</span>` : '', s.missing ? `<span class="warn">${s.missing} not found</span>` : '', s.pending ? `${s.pending} removal${s.pending === 1 ? '' : 's'} pending` : ''].filter(Boolean).join(' · ');
  el.innerHTML = `<div class="v2acchead">
      <span class="grow sub" id="v2AccessWhen">${accessCheckedLine(ov)}${head ? ` ${head}` : ''}</span>
      <button id="v2AccessVerify" ${onAction('click', 'v2VerifyAccess', [`${id ?? ''}`, { $: 'el' }])} title="Look inside the running agent now: its Google accounts, bot, folders, keys, variable names and who it lets in. Nothing is changed.">Verify now</button>
    </div>
    <div id="v2AccessRows">${accessRowsHTML(ov)}</div>
    <div class="sub" style="margin-top:10px">Not checked: ${ov.notChecked.map(esc).join(' ')}</div>`;
}
async function v2VerifyAccess(id, btn) {
  const current = sharingRead(btn || $('v2Access'), id);
  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  try {
    const r = await api(`/v1/agents/${id}/access/verify`, { method: 'POST', body: {} });
    if (!current()) return;
    if (r.result?.status === 'not-checkable') toast(`Not checked: ${r.result.reason}. The last results stay.`, 7000);
    else toast(r.access?.summary?.mismatches ? `Checked — ${r.access.summary.mismatches} thing${r.access.summary.mismatches === 1 ? '' : 's'} it should not have.` : 'Checked — what it can reach matches what Hatchabot gave it.', 6000);
    if (r.access) await v2LoadAccess(id, true, r.access); else await v2LoadAccess(id, true);
    if (r.access?.summary?.mismatches) void refresh(false); // its Alerts line
  } catch (e) { if (current()) toast(e.message); }
  finally { if (current() && btn) { btn.disabled = false; btn.textContent = 'Verify now'; } }
}
/** Settings → Security: every agent, problems first, each opening to its rows. */
async function loadAccessMap() {
  const el = $('accessMapOut'); if (!el) return;
  const current = sharingRead(el);
  el.innerHTML = '<div class="sub">Loading…</div>';
  let r;
  try { r = await api('/v1/access'); } catch (e) { if (current()) el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; return; }
  if (!current()) return;
  if (!r.agents.length) { el.innerHTML = '<div class="sub">No agents yet.</div>'; return; }
  el.innerHTML = r.agents.map(ov => {
    const s = ov.summary, bad = s.mismatches > 0;
    const counts = ov.groups.map(g => `${g.rows.length} × ${esc(g.title.replace(/ \(names only\)$/, '').toLowerCase())}`).join(' · ');
    return `<details class="v2accagent" data-agent="${esc(ov.agentId)}" style="border-top:1px solid var(--line);padding:6px 0"${bad ? ' open' : ''}>
      <summary><span class="${bad || s.missing ? 'warn' : ''}">${bad || s.missing ? '⚠' : '✓'}</span> <b>${esc(ov.name)}</b>
        <span class="sub">${bad ? `· ${s.mismatches} it should not have ` : ''}${s.missing ? `· ${s.missing} not found ` : ''}${s.pending ? `· ${s.pending} removal${s.pending === 1 ? '' : 's'} pending ` : ''}· ${ov.checkedAt ? `checked ${esc(ago(ov.checkedAt))}` : 'not checked yet'}${ov.ownerId ? " · someone else's" : ''}</span></summary>
      <div class="sub" style="margin:2px 0 4px">${counts || 'nothing beyond its owner'}</div>
      ${accessRowsHTML(ov)}
      ${ov.ownerId ? '' : `<div style="margin-top:4px"><button ${onAction('click', 'closeDialog openV2Agent', [["aiDlg"], [`${ov.agentId ?? ''}`, "sharing"]])}>Open its Sharing tab</button></div>`}
    </details>`;
  }).join('');
}

// ---- the security posture and the CLI tokens (Settings → Security) ---------------------
const POSTURE_DOT = { ok: '🟢', info: '🔵', warn: '🟡', critical: '🔴' };
const EXPOSURE_DOT = { high: '🔴', medium: '🟡', low: '🟢' };
async function loadPosture() {
  const el = $('postureOut');
  $('postureRunBtn').disabled = true;
  el.textContent = 'Checking…';
  try {
    const { report, changes, comparedToPrior } = await api('/v1/security/posture');
    const chg = (changes.added?.length || changes.removed?.length)
      ? `<div class="pair" style="border:1px solid var(--warn);border-radius:8px;padding:8px 10px;margin-bottom:10px;color:var(--warn)">
           ⚠ <span class="grow"><b>Changes since the last check:</b>
           ${changes.added.length ? `<div>appeared: ${changes.added.map(esc).join(', ')}</div>` : ''}
           ${changes.removed.length ? `<div>resolved: ${changes.removed.map(esc).join(', ')}</div>` : ''}</span></div>`
      : (comparedToPrior ? '<div class="sub" style="margin-bottom:10px">No change since the last check.</div>' : '');

    const install = report.install.length
      ? report.install.map(c => `<div class="pair" style="align-items:baseline;gap:6px${c.level === 'critical' || c.level === 'warn' ? ';color:var(--warn)' : ''}">
          <span>${POSTURE_DOT[c.level] ?? '•'}</span>
          <span class="grow"><b>${esc(c.title)}</b><span class="sub"> — ${esc(c.detail)}</span></span></div>`).join('')
      : '<div class="sub">(install-level checks are shown to the host owner)</div>';

    // WHO can reach it, by name — a count never answered the question a
    // security review actually asks. Someone invited who has not messaged the
    // bot yet is shown as pending: they cannot reach it until they do.
    const audienceLine = (a) => {
      const who = a.audience ?? [];
      if (!who.length) return '<br>nobody but you can message it';
      return `<br>can message it: ` + who.map(m =>
        `${esc(m.name)}${m.role === 'owner' ? ' (you)' : ''}${m.pending ? ' <i>— invited, not yet linked</i>'
          : m.channels.length > 1 ? ` <span class="sub">(${m.channels.map(esc).join(', ')})</span>` : ''}`).join(', ');
    };

    // One row per agent: name and level on the first line, who can reach it
    // and what it can do below, each on its own line — the old single run-on
    // line was the hardest part of the tab to read.
    const agentRow = (a) => `<div class="posture-row${a.exposure === 'high' ? ' posture-hot' : ''}">
        <div class="posture-head"><span>${EXPOSURE_DOT[a.exposure]}</span>
          <b class="grow">${esc(a.name)}</b><span class="posture-level">${esc(a.exposure)} exposure</span></div>
        ${a.reasons.length ? `<div class="sub">${a.reasons.map(esc).join(' · ')}</div>` : ''}
        <div class="sub">${audienceLine(a).replace(/^<br>/, '')}</div>
        ${a.capabilities.length ? `<div class="sub">can: ${a.capabilities.map(esc).join(', ')}</div>` : ''}
      </div>`;
    $('exposureOut').innerHTML = report.agents.length
      ? report.agents.map(agentRow).join('')
      : '<div class="sub">No live agents.</div>';

    const lim = report.limits;
    // Say when: the report runs on open as well, so without this the button
    // looked like it did nothing.
    const when = `<div class="sub" style="margin-bottom:8px">Checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.</div>`;
    el.innerHTML = `${when}${chg}
      <div class="posture-group"><div class="posture-label">This machine</div>${install}</div>
      <div class="posture-group"><div class="posture-label">Limits</div>
        <div class="sub">Agents: ${lim.liveAgents}${lim.agentCap ? ` / ${lim.agentCap}` : ' (no cap set)'} · Disk warning at ${lim.diskWarnGB} GB per agent (measured daily)</div>
        ${(lim.overDisk || []).map(d => `<div class="sub" style="color:var(--warn)">⚠ <b>${esc(d.name)}</b> uses ${(d.bytes / 1e9).toFixed(1)} GB (measured ${esc(new Date(d.measuredAt).toLocaleDateString())})</div>`).join('')}</div>`;
  } catch (e) {
    el.textContent = e.message;
  } finally {
    $('postureRunBtn').disabled = false;
  }
}

async function newCliToken(scope) {
  $('cliTokenErr').textContent = '';
  try {
    // scope 'rehost': for another server that will move agents here — that,
    // and nothing else. The old advice pasted a full token there.
    const t = await api('/v1/cli-tokens', { method: 'POST', body: scope ? { label: 'Moving agents from another Hatchabot', scope } : { label: 'CLI' } });
    const out = $('cliTokenOut');
    out.style.display = '';
    out.textContent = t.token;
    toast('Copy it now — it is not shown again', 20000);
    if (await copyText(t.token)) toast(scope ? 'Token copied — paste it on the other server, under Settings → Advanced → Other Hatchabot servers' : 'Token copied — run: hatchabot login', 20000);
    void loadCliTokens();
  } catch (e) { $('cliTokenErr').textContent = e.message; } // its own line: #aiErr is in another tab (HB-0442)
}

/** The tokens this account has minted, so one can be taken back — a retired
 *  management bot leaves its own behind, and the app could only ever add. */
async function loadCliTokens() {
  const el = $('cliTokenList');
  if (!el) return;
  try {
    const rows = await api('/v1/cli-tokens');
    el.innerHTML = rows.length
      ? rows.map(t => `<div class="pair" style="align-items:baseline;padding:4px 0;border-top:1px solid var(--line)">
          <span class="grow"><b>${esc(t.label || 'CLI')}</b>${t.scope === 'rehost' ? ' <span class="sub">(moving agents here only)</span>' : ''} <span class="sub">· made ${ago(t.createdAt)}${t.lastUsedAt ? ` · last used ${ago(t.lastUsedAt)}` : ' · never used'}</span></span>
          <button class="danger" ${onAction('click', 'revokeCliToken', [`${t.id ?? ''}`, `${(t.label || 'CLI') ?? ''}`])}>Revoke</button>
        </div>`).join('')
      : 'No tokens.';
  } catch (e) { el.textContent = e.message; }
}

async function revokeCliToken(id, label) {
  if (!confirm(`Revoke the "${label}" token?\n\nAnything signed in with it — a terminal, a cluster server — stops working immediately.`)) return;
  try { await api(`/v1/cli-tokens/${id}`, { method: 'DELETE' }); toast('Revoked.'); loadCliTokens(); }
  catch (e) { toast(e.message); }
}

// ---- the fleet's media and web search keys (Settings → AI sources) ----------------------
async function loadMediaKey() {
  if (myAccount.hostOwner === false) return; // hidden from them: paintMachineOwnerOnly
  try {
    const r = await api('/v1/media-key');
    const el = $('mediaKeyStatus');
    if (r.set) {
      el.style.color = 'var(--dim)';
      el.innerHTML = '<b>Shared Gemini key saved</b> — not tested. Existing agents pick up changes on their next Rebuild; a Gemini AI source\'s own key takes precedence. <button class="hbtn" ' + onAction('click', 'revealFleetKey', ['media', { $: 'el' }]) + '>Show</button> <code id="fleetkey-media" style="display:none;user-select:all;word-break:break-all"></code> <span class="sub">Paste a new one to replace it.</span>';
      $('mediaKey').placeholder = 'Replace key…';
    } else {
      el.style.color = 'var(--dim)';
      el.innerHTML = 'No shared Gemini key saved. An agent may use its Gemini AI source\'s own key, or still hold a previous shared key until its next Rebuild.';
      $('mediaKey').placeholder = 'Gemini API key';
    }
    $('mediaKeyDelBtn').style.display = r.set ? '' : 'none';
    if (r.set) $('mediaKeyDrawer')?.setAttribute('open', ''); // don't hide a saved key
  } catch {
    $('mediaKeyStatus').style.color = 'var(--warn)';
    $('mediaKeyStatus').textContent = 'Could not check whether a shared Gemini key is saved. Reopen Settings to try again.';
  }
}
/** Show a fleet key, then copy it — the same two presses as a bot token. Machine owner only; each reveal is logged. */
async function revealFleetKey(kind, btn) {
  const out = $('fleetkey-' + kind);
  if (out.style.display !== 'none' && out.textContent) {
    toast(await copyText(out.textContent) ? 'Copied.' : 'Select it and copy by hand.');
    return;
  }
  btn.disabled = true;
  try {
    const r = await api(kind === 'media' ? '/v1/media-key/reveal' : '/v1/search-key/reveal');
    out.textContent = r.key; out.style.display = '';
    btn.textContent = 'Copy';
  } catch (e) { toast(e.message, 10000); }
  finally { btn.disabled = false; }
}
async function saveMediaKey() {
  const key = $('mediaKey').value.trim();
  if (!key) return toast('Paste a Gemini API key first.');
  try {
    await api('/v1/media-key', { method: 'PUT', body: { key } });
    $('mediaKey').value = '';
    toast('Shared Gemini key saved, not tested. Rebuild existing agents to pick it up; a Gemini AI source\'s own key takes precedence. Browser Talk is configured separately.', 14000);
    loadMediaKey();
  } catch (e) { toast(e.message, 10000); }
}
async function removeMediaKey() {
  if (!confirm('Remove the shared Gemini key? Agents holding it keep it until their next Rebuild. A Gemini AI source\'s own key is unchanged. Browser Talk is configured separately.')) return;
  try { await api('/v1/media-key', { method: 'DELETE' }); loadMediaKey(); }
  catch (e) { toast(e.message, 10000); }
}

async function loadSearchKey() {
  if (myAccount.hostOwner === false) return; // hidden from them: paintMachineOwnerOnly
  try {
    const r = await api('/v1/search-key');
    const el = $('searchKeyStatus');
    if (r.set) {
      el.style.color = 'var(--ok)';
      el.innerHTML = '✓ <b>Fleet search key set</b> — agents holding it use Brave; others get it at their next Rebuild. <button class="hbtn" ' + onAction('click', 'revealFleetKey', ['search', { $: 'el' }]) + '>Show</button> <code id="fleetkey-search" style="display:none;user-select:all;word-break:break-all"></code> <span class="sub">Paste a new one to replace.</span>';
      $('searchKey').placeholder = 'Replace key…';
    } else {
      el.style.color = 'var(--dim)';
      el.innerHTML = 'No key — agents use DuckDuckGo, which needs none.';
      $('searchKey').placeholder = 'Brave Search API key';
    }
    $('searchKeyDelBtn').style.display = r.set ? '' : 'none';
    if (r.set) $('searchKeyDrawer')?.setAttribute('open', ''); // don't hide a live key
    loadSearchHealth();
    loadSearchUsage();
  } catch { /* not the host owner — leave inert */ }
}
let searchHealthTimer;
const SEARCH_NAMES = { brave: 'Brave', duckduckgo: 'DuckDuckGo' };
function renderSearchHealth(s) {
  const row = (p) => p ? `<div>${p.status === 'ok' ? '✓' : '⚠'} ${esc(p.detail)}</div>` : '';
  const when = (t) => t ? new Date(t).toLocaleString() : '';
  // DuckDuckGo turning this machine away (HB-0455): there is no free search here, so say what that means for the fleet.
  const away = s.duckduckgo?.status === 'turned-away';
  const awayLine = !away ? ''
    : s.active === 'duckduckgo'
      ? `<div id="searchTurnedAway" style="font-size:14px;color:var(--warn);margin-top:4px">⚠ <b>Agents have no working web search.</b> This machine gets no free search from DuckDuckGo, so a Brave key is needed${s.brave?.status === 'ok' ? ': yours works, so choose "Brave, and DuckDuckGo when it runs out" below.' : ', with quota left. Paste one above.'}</div>`
      : s.brave?.status === 'low'
        ? '<div id="searchTurnedAway" style="font-size:14px;color:var(--warn);margin-top:4px">⚠ <b>The Brave key is nearly out</b>, and this machine gets no free search from DuckDuckGo: agents stay on Brave until it runs out, and then have no search. Replace the key above, or wait for its quota to return.</div>'
        : '<div id="searchTurnedAway" style="margin-top:4px">⚠ This machine gets no free search from DuckDuckGo, so agents stay on Brave even when it runs low, and have no search once its key runs out.</div>';
  $('searchHealth').innerHTML = `<div style="font-size:14px">In use: <b>${esc(SEARCH_NAMES[s.active] || s.active)}</b>${s.why ? ` — ${esc(s.why)}` : ''}</div>${awayLine}
    <div class="sub">${row(s.brave)}${row(s.duckduckgo)}
    ${s.checkedAt ? `<div>Checked ${esc(when(s.checkedAt))}${s.brave?.resetsAt && s.active !== 'brave' ? `; Brave's quota returns about ${esc(when(s.brave.resetsAt))}` : ''}.</div>` : '<div>Not checked yet.</div>'}
    ${s.moving ? '<div>Agents are moving now.</div>' : ''}
    ${s.applied?.rebuild ? `<div>⚠ ${s.applied.rebuild} on DuckDuckGo until their next Rebuild, which gives them this key.</div>` : ''}
    ${s.applied?.failed?.length ? `<div>⚠ Not moved yet, tried again soon: ${esc(s.applied.failed.join(', '))}.</div>` : ''}</div>`;
  $('searchMode').value = s.mode || 'auto';
  // Agents move after the check answers: look again until they are done, while this is on screen.
  clearTimeout(searchHealthTimer);
  if (s.moving && !window.__noAutoPoll) searchHealthTimer = setTimeout(() => { if ($('searchHealth').offsetParent) loadSearchHealth(); }, 5000);
}
async function loadSearchHealth() {
  try { renderSearchHealth(await api('/v1/web-search')); } catch { /* not the host owner */ }
}
async function testFleetSearch() {
  const btn = $('searchTestBtn');
  btn.disabled = true;
  try { renderSearchHealth(await api('/v1/web-search/check', { method: 'POST' })); loadSearchUsage(); }
  catch (e) { toast(e.message, 10000); }
  finally { btn.disabled = false; }
}
/** The month's Brave searches: what is left, a bar per day, who searches most, and the cost (HB-0532). */
async function loadSearchUsage() {
  if (!$('searchUsage')) return;
  try { renderSearchUsage(await api('/v1/web-search/usage')); } catch { /* not the host owner */ }
}
function renderSearchUsage(u) {
  $('searchUsage').innerHTML = searchUsageHTML(u);
  const a = u?.allowance;
  $('searchUsageSum').textContent = !u?.keySet || !u.period ? ''
    : a?.kind === 'credit' ? ` · ${a.used.toLocaleString()} of ${a.free.toLocaleString()} free searches used this month`
    : a?.kind === 'quota' ? ` · ${a.remaining.toLocaleString()} of ${a.limit.toLocaleString()} searches left`
    : u.brave ? ` · ${u.brave.toLocaleString()} Brave searches this month` : '';
}
function searchUsageHTML(u) {
  if (!u?.period || !Array.isArray(u.byDay) || !Array.isArray(u.byAgent)) return '';
  const n = (x) => Number(x || 0).toLocaleString();
  const day = (d) => new Date(`${d.slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const lastDay = new Date(Date.parse(u.period.end) - 1).toISOString().slice(0, 10);
  const total = u.brave + u.other;
  if (!u.keySet && !total) return '';
  const a = u.allowance, p = u.price;
  const head = `<div class="sv-head"><b>Brave searches this month</b><span class="sub">${esc(day(u.period.start))} – ${esc(day(lastDay))}</span></div>`;
  // What is left: Brave's own count on a capped plan, else the month's free credit against the counted searches.
  let left = '';
  if (a) {
    const cap = a.kind === 'quota' ? a.limit : a.free;
    const used = a.used;
    const pct = (x) => Math.max(0, Math.min(100, cap ? (x / cap) * 100 : 0));
    const over = a.kind === 'credit' && a.used > a.free;
    const words = a.kind === 'quota'
      ? `<b>${n(a.remaining)}</b> of ${n(a.limit)} searches left <span class="sub">— Brave's count${a.checkedAt ? ` at the last check, ${esc(new Date(a.checkedAt).toLocaleString())}` : ''}${a.resetsAt ? `; it resets ${esc(day(a.resetsAt))}` : ''}</span>`
      : over ? `⚠ <b>Over the free credit</b> by ${n(a.used - a.free)} searches <span class="sub">— ${n(a.free)} free a month</span>`
      : `<b>${n(a.left)}</b> of ${n(a.free)} free searches left <span class="sub">— ${esc(v2Money(p.monthlyCredit))} of credit a month</span>`;
    const proj = u.projected > used ? `<div class="sv-proj" style="left:${pct(u.projected).toFixed(1)}%" title="At this pace: about ${n(u.projected)} by ${esc(day(lastDay))}"></div>` : '';
    left = `<div class="sv-big">${words}</div>
      <div class="sv-meter" role="img" aria-label="${n(used)} of ${n(cap)} used"><div class="sv-used" style="width:${pct(used).toFixed(1)}%"></div>${proj}</div>`;
  }
  const pace = u.brave ? `<div class="sub">At this pace: about ${n(u.projected)} Brave searches by ${esc(day(lastDay))}${u.runsOut ? ` — ⚠ the ${a?.kind === 'quota' ? 'quota' : 'free credit'} runs out about <b>${esc(day(u.runsOut))}</b>` : ''}.</div>` : '';
  const cost = u.keySet || u.brave ? `<div style="font-size:14px;margin-top:6px">Estimated cost: <b>${esc(v2Money(u.cost.net))}</b> so far${u.cost.gross > u.cost.net ? ` <span class="sub">(${esc(v2Money(u.cost.gross))} of searches, less the ${esc(v2Money(p.monthlyCredit))} credit)</span>` : ''}${u.brave ? ` · about <b>${esc(v2Money(u.cost.projectedNet))}</b> by month end` : ''}</div>` : '';
  // A bar per day: Brave at the base, other providers above it; each bar's title says the numbers.
  const top = niceTop(Math.max(1, ...u.byDay.map((d) => d.brave + d.other)));
  const today = new Date().toISOString().slice(0, 10);
  const bars = u.byDay.map((d) => {
    const tip = `${day(d.day)}${d.day === today ? ' (today)' : ''}: ${n(d.brave)} Brave${d.other ? `, ${n(d.other)} other` : ''}`;
    const seg = (cls, x) => x ? `<i class="${cls}" style="height:${((x / top) * 100).toFixed(2)}%"></i>` : '';
    return `<div class="sv-day" title="${esc(tip)}" aria-label="${esc(tip)}">${seg('sv-o', d.other)}${seg('sv-b', d.brave)}</div>`;
  }).join('');
  const legend = u.other ? `<div class="sub" style="margin-top:2px"><span class="sv-key"><i class="sv-b"></i>Brave</span><span class="sv-key"><i class="sv-o"></i>DuckDuckGo and others</span></div>` : '';
  const chart = total ? `<div class="sv-sec">${u.other ? 'Searches per day' : 'Brave searches per day'} <span class="sub" style="font-weight:400">· up to ${n(top)} a day</span></div>
    <div class="sv-days">${bars}</div>
    <div class="su-cap"><span>${esc(day(u.byDay[0]?.day || u.period.start))}</span><span>${esc(day(lastDay))}</span></div>${legend}` : '<div class="sub" style="margin-top:8px">No searches counted yet this month.</div>';
  // Who searches most: Brave searches first, their share and cost.
  const rows = u.byAgent.filter((r) => r.brave || r.other);
  const shown = rows.slice(0, 12);
  const amax = Math.max(1, ...shown.map((r) => r.brave));
  const who = shown.length ? `<div class="sv-sec">Who searches most</div><div class="sv-rows">${shown.map((r) => `<div class="sv-row">
      <span class="sv-name" title="${esc(r.name)}">${esc(r.name)}</span>
      <span class="sv-bar" title="${n(r.brave)} Brave searches"><i style="width:${((r.brave / amax) * 100).toFixed(1)}%"></i></span>
      <span class="sv-num">${n(r.brave)}${u.brave && r.brave ? ` · ${Math.round((r.brave / u.brave) * 100)}%` : ''}${r.cost ? ` · ${esc(v2Money(r.cost))}` : ''}${r.other ? ` <span class="sub">+${n(r.other)} other</span>` : ''}</span></div>`).join('')}</div>
    ${rows.length > shown.length ? `<div class="sub">and ${rows.length - shown.length} more</div>` : ''}` : '';
  const cached = u.cached ? `<div class="sub" style="margin-top:4px">${n(u.cached)} more were answered from OpenClaw's cache, at no cost.</div>` : '';
  const price = `<details style="margin-top:10px"><summary class="sub">Price: ${esc(v2Money(p.per1000))} per 1,000 searches, ${esc(v2Money(p.monthlyCredit))} of free credit a month — change</summary>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:6px">
        <label class="sub">$ <input id="searchPricePer" type="number" min="0" max="1000" step="0.01" value="${esc(String(p.per1000))}" style="width:6em"> per 1,000 searches</label>
        <label class="sub">$ <input id="searchPriceCredit" type="number" min="0" step="0.01" value="${esc(String(p.monthlyCredit))}" style="width:6em"> of credit a month</label>
        <button class="hbtn" id="searchPriceSaveBtn" ${onAction('click', 'saveSearchPrice')}>Save</button>
      </div>
      <div class="sub" style="margin-top:4px">Brave's Search plan in November 2026: $5 per 1,000 searches, with $5 of credit each month. Yours is on <a href="https://api-dashboard.search.brave.com/" target="_blank" rel="noopener">Brave's dashboard</a>.</div></details>`;
  const note = '<div class="sub" style="margin-top:6px">Counted from the agents\' conversations about once an hour, with the Hatchabot agent\'s searches and Hatchabot\'s own checks. Searches made with this key outside Hatchabot show only in Brave\'s dashboard, which has the real bill.</div>';
  return `${head}${left}${pace}${cost}${chart}${who}${cached}${note}${price}`;
}
async function saveSearchPrice() {
  const per1000 = Number($('searchPricePer').value), monthlyCredit = Number($('searchPriceCredit').value);
  if (!(per1000 >= 0 && per1000 <= 1000) || !(monthlyCredit >= 0)) return toast('A price is dollars: 0 to 1,000 per 1,000 searches, and 0 or more of credit.', 8000);
  try { renderSearchUsage(await api('/v1/web-search', { method: 'PUT', body: { price: { per1000, monthlyCredit } } })); toast('Price saved.'); }
  catch (e) { toast(e.message, 10000); }
}
async function setSearchMode(mode) {
  try { renderSearchHealth(await api('/v1/web-search', { method: 'PUT', body: { mode } })); }
  catch (e) { toast(e.message, 10000); loadSearchHealth(); }
}
/** A real search in this agent, through its own settings and keys. */
async function testAgentSearch() {
  const out = $('agentSearchTestOut');
  // Whose test it is: another agent's forms opened while it ran (they empty this line) do not
  // get its answer under their button; it is said in a toast with its agent's name. The button
  // waits for its own agent's test only: another's may be running under it now (sheetPress).
  const f = sheetSave().hold('agentSearchTestBtn');
  out.textContent = 'Searching…';
  let said;
  try {
    const r = await api(`/v1/agents/${f.id}/search-test`, { method: 'POST' });
    said = `${r.ok ? '✓' : '⚠'} ${r.detail}`;
  } catch (e) { said = `⚠ ${e.message}`; }
  finally { f.done(); }
  f.draw(() => { out.textContent = said; });
  if (!f.shown()) f.say(said, 9000);
}
async function saveSearchKey() {
  const key = $('searchKey').value.trim();
  if (!key) return toast('Paste a Brave Search API key first.');
  try {
    await api('/v1/search-key', { method: 'PUT', body: { key } });
    $('searchKey').value = '';
    toast('Search key saved — agents use it from their next Rebuild, and DuckDuckGo until then.', 10000);
    loadSearchKey();
  } catch (e) { toast(e.message, 10000); }
}
async function removeSearchKey() {
  if (!confirm('Remove the fleet search key? Agents move to DuckDuckGo within a few minutes.')) return;
  try { await api('/v1/search-key', { method: 'DELETE' }); loadSearchKey(); }
  catch (e) { toast(e.message, 10000); }
}

// ---- Telegram bots: the inventory and the bot pool (Settings → Messaging, Telegram) -------
let botInvLast = null; // the last live census, for the BotFather comparison

/**
 * Reconcile BotFather's list against this server's. Telegram offers no way to
 * enumerate an account's bots, so the owner pastes /mybots and we diff it here
 * — a bot at BotFather that no token here matches is a stray occupying a slot.
 */
function matchBotFather() {
  const out = $('botMatchOut');
  if (!botInvLast) { out.innerHTML = '<div class="sub">Run the live check first, so there is something to compare against.</div>'; return; }
  // Anything that looks like a bot handle, however it was pasted.
  const listed = [...new Set((($('botMatchIn').value || '').match(/@?[A-Za-z0-9_]{4,32}[Bb][Oo][Tt]\b/g) ?? [])
    .map(x => x.replace(/^@/, '').toLowerCase()))];
  if (!listed.length) { out.innerHTML = '<div class="sub">No bot handles found in that text. They end in <code>bot</code> — paste the list from @BotFather.</div>'; return; }
  const here = new Map(botInvLast.map(b => [String(b.username).toLowerCase(), b]));
  const strays = listed.filter(u => !here.has(u));
  const missing = [...here.keys()].filter(u => !listed.includes(u) && u !== '(mgmt bot)');
  const matched = listed.filter(u => here.has(u));
  const dead = matched.filter(u => here.get(u).alive === false);
  const group = (title, colour, items, note) => items.length
    ? `<div style="margin-top:10px"><b style="color:${colour}">${title} (${items.length})</b>
        <div class="sub">${note}</div>
        <div style="margin-top:4px">${items.map(u => `<code class="pii" style="display:inline-block;margin:2px 6px 2px 0">@${esc(u)}</code>`).join('')}</div></div>`
    : '';
  out.innerHTML =
    `<div class="sub">${listed.length} handle${listed.length === 1 ? '' : 's'} pasted · ${here.size} known here · <b>${matched.length}</b> matched.</div>`
    + group('Strays at BotFather', 'var(--warn)', strays,
        'At BotFather, unknown to this server. Each one occupies a slot. Check it is not serving another Hatchabot server or another app, then <code>/deletebot</code> it.')
    + group('Known here but not in what you pasted', 'var(--info)', missing,
        'This server holds a token for these. Either the paste was partial, or they were minted by a different Telegram account — that account is where they can be deleted.')
    + group('Matched but dead', 'var(--bad)', dead,
        'Both lists have them, but Telegram rejects the token here. Delete at BotFather to free the slot, and remove the row above.')
    + (!strays.length && !missing.length ? '<div class="sub" style="margin-top:10px;color:var(--ok)">✓ The two lists agree — nothing is orphaned.</div>' : '');
}

async function loadBotInventory() {
  $('botInvBtn').disabled = true;
  $('botInvStatus').textContent = 'asking Telegram about each bot…';
  try {
    const { bots } = await api('/v1/bot-inventory');
    botInvLast = bots;
    const WHERE = {
      'agent': b => `serving <b>${esc(b.agentName)}</b>${b.agentState !== 'RUNNING' ? ` (${esc(b.agentState)})` : ''}`,
      'pool-leased': () => 'pool (leased)',
      'pool-free': () => 'pool — free stock',
      'orphan-token': () => '⚠ orphaned token — nothing references it',
    };
    // What ❌ actually means, and the one thing to do about it. A dead row used
    // to be a red cross with no explanation (2026-09-19).
    const DEAD = {
      'pool-free': 'Telegram rejects this token, so this spare can never be leased. Remove it here; if the bot still exists at @BotFather, /deletebot frees the slot.',
      'pool-leased': 'Telegram rejects this token, so the agent holding it cannot talk. Give that agent a different bot.',
      'agent': 'Telegram rejects this token — this agent cannot send or receive. Replace its bot in its ⚙ Settings → Messaging.',
      'orphan-token': 'A stored token nothing uses, and Telegram no longer accepts it. Harmless; it disappears when the record is cleaned up.',
    };
    // No token here at all (HB-1384): Telegram was never asked, so nothing is said of the bot, only how to put the token back.
    const MISSING = {
      'pool-free': 'This server no longer has this spare\'s token, so it can never be leased. Remove it here, then add it again with its token from @BotFather (/token) if you still want it.',
      'pool-leased': 'This server no longer has this bot\'s token, so it cannot be given to the agent holding it again (at a rebuild or a move). Give that agent a different bot.',
      'agent': 'This server no longer has this bot\'s token, so it cannot be given to the agent again (at a rebuild or a move). Detach… it on the agent\'s card, then add it again with its token from @BotFather (/token).',
      'orphan-token': 'A record of a token this server no longer has, which nothing uses. Harmless.',
    };
    $('botInvList').innerHTML = bots.map(b => `
      <div class="pair" style="gap:8px;align-items:baseline;flex-wrap:wrap">
        <span class="grow"><code class="pii">@${esc(b.username)}</code>
          <span class="sub">${b.displayName ? `<span class="pii">“${esc(b.displayName)}”</span> · ` : ''}${WHERE[b.where] ? WHERE[b.where](b) : esc(b.where)}</span>
          ${b.alive === false ? `<div class="sub" style="color:var(--warn);flex-basis:100%">${DEAD[b.where] ?? 'Telegram rejects this token.'}</div>` : ''}
          ${b.tokenMissing ? `<div class="sub" style="color:var(--warn);flex-basis:100%">${MISSING[b.where] ?? 'This server no longer has this bot\'s token.'}</div>` : ''}
          ${b.tokenUnreadable ? '<div class="sub" style="color:var(--warn);flex-basis:100%">This server could not read this bot\'s token, so Telegram was not asked. Look again in a moment; if this lasts, this install\'s secret key may have changed.</div>' : ''}</span>
        ${(b.alive === false || b.tokenMissing) && b.where === 'pool-free' ? `<button class="hbtn" ${onAction('click', 'removePoolBotAndList', [`${b.username ?? ''}`])}>Remove</button>` : ''}
        ${b.tokenMissing ? '' : `<button class="hbtn" ${onAction('click', 'revealInvToken', [{ $: 'el' }, `${b.username ?? ''}`])} title="Show this bot's token — for moving it to another machine">🔑 Show</button>`}
        <span title="${b.alive === true ? 'token works' : b.alive === false ? 'token revoked/dead — the bot may still exist at BotFather' : b.tokenMissing ? 'no token here — Telegram was not asked' : b.tokenUnreadable ? 'its token could not be read — Telegram was not asked' : 'Telegram unreachable — unknown'}">
          ${b.alive === true ? '✅' : b.alive === false ? '❌' : b.tokenMissing || b.tokenUnreadable ? '⚠' : '❓'}</span>
        <code class="invtok" hidden style="flex-basis:100%;word-break:break-all;font-size:11.5px"></code>
      </div>`).join('') || '<div class="sub">No bots known to this server.</div>';
    const n = (f) => bots.filter(f).length;
    $('botInvStatus').innerHTML =
      `<b>${bots.length}</b> bots — ✅ ${n(b => b.alive === true)} working` +
      `${n(b => b.alive === false) ? ` · ❌ ${n(b => b.alive === false)} dead` : ''}` +
      `${n(b => b.tokenMissing) ? ` · ⚠ ${n(b => b.tokenMissing)} with no token here` : ''}` +
      `${n(b => b.tokenUnreadable) ? ` · ⚠ ${n(b => b.tokenUnreadable)} whose token could not be read` : ''}` +
      `${n(b => b.alive === undefined && !b.tokenMissing && !b.tokenUnreadable) ? ` · ❓ ${n(b => b.alive === undefined && !b.tokenMissing && !b.tokenUnreadable)} unknown` : ''}` +
      ` <span class="sub">(${n(b => b.where === 'agent')} on agents · ${n(b => b.where.startsWith('pool'))} pool · ${n(b => b.where === 'orphan-token')} orphan${n(b => b.where === 'orphan-token') ? ` · ⚠ ${n(b => b.where === 'orphan-token')} orphaned` : ''})</span>`;
  } catch (e) { $('botInvStatus').textContent = e.message; }
  finally { $('botInvBtn').disabled = false; }
}

async function loadPool() {
  const el = $('poolList');
  try {
    // Donating a bot to the house is the machine owner's call; parking your own
    // is not. Show only what this account can actually do.
    const sharedRow = $('poolSharedRow');
    if (sharedRow) sharedRow.style.display = myAccount.hostOwner ? '' : 'none';
    if ($('poolOwnOnly')) $('poolOwnOnly').checked = !!myAccount.prefs?.ownBotsOnly;
    const p = await api('/v1/pool');
    const bots = p.bots ?? [];
    // The at-a-glance answer to "can I make an agent instantly?"
    const ready = p.availableBots ?? bots.filter(b => !b.leasedTo).length;
    const inUse = bots.filter(b => b.leasedTo).length;
    $('poolStatus').innerHTML = `<span class="pool-dot"${ready > 0 ? '' : ' style="color:var(--off)"'}>●</span>
      <b>${ready}</b> instant bot${ready === 1 ? '' : 's'} ready${inUse ? ` <span class="sub">· ${inUse} in use by agents</span>` : ''}
      ${ready ? '' : '<span class="sub">· a new agent will ask for a BotFather token, or can go without Telegram</span>'}`;
    // Four answers to four different questions — "can I make an agent right
    // now?", "what is this bot doing?", "what has the house lent me?" — rather
    // than one flat list you have to read every line of. Empty groups are not
    // drawn at all.
    const GROUPS = [
      ['Free — yours', b => b.mine && !b.leasedTo, 'Ready for your next agent.'],
      ['In use — yours', b => b.mine && b.leasedTo, ''],
      ['Free — shared with you', b => !b.mine && !b.leasedTo, myAccount.prefs?.ownBotsOnly ? 'Parked by someone else on this server. Not for your agents: you chose your own bots only.' : 'Parked by someone else on this server; your next agent can take one.'],
      ['In use — someone else’s', b => !b.mine && b.leasedTo, ''],
    ];
    const row = (b) => `<div class="pair" style="align-items:center;padding:6px 0;border-top:1px solid var(--line)">
        <span class="grow">🤖 <b class="pii">@${esc(b.username)}</b>${b.shared ? ' <span class="chip">shared</span>' : ''}
          ${b.leasedTo ? `<span class="sub">· ${esc(b.leasedToName || 'an agent')}</span>` : ''}</span>
        ${b.leasedTo
          ? `<span class="sub" title="Its agent would lose the bot it answers on. Delete or archive the agent instead — that parks the bot back here.">in use</span>`
          : `<span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"><button ${onAction('click', 'recheckPoolBot', [`${b.username ?? ''}`, { $: 'el' }])} title="Ask Telegram again: does the token still work, and what is the bot called">↻ Re-check</button>
             ${b.mine || myAccount.hostOwner ? `<button class="hbtn danger" ${onAction('click', 'removePoolBot', [`${b.username ?? ''}`])} title="Discard the stored token. The bot itself still exists at @BotFather.">🗑 Delete</button>` : ''}</span>`}
      </div>`;
    el.innerHTML = bots.length
      ? GROUPS.map(([label, pick, hint]) => {
          const mine = bots.filter(pick);
          if (!mine.length) return '';
          return `<div style="margin:10px 0 0"><b style="font-size:13px">${label}</b> <span class="sub">· ${mine.length}</span>
            ${hint ? `<div class="sub" style="margin:2px 0 0">${hint}</div>` : ''}</div>${mine.map(row).join('')}`;
        }).join('')
      : '<div class="sub">Empty — add a spare bot above, or park one when deleting an agent.</div>';
  } catch (e) { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}

/** Settings → Messaging → Telegram: my agents take only my own bots. Saved at once; the ready count follows. */
async function setPoolOwnOnly(on) {
  try {
    const r = await api('/v1/account/prefs', { method: 'PATCH', body: { ownBotsOnly: !!on } });
    myAccount.prefs = r.prefs;
    toast(on ? 'Your agents take only bots you parked yourself.' : 'Your agents may take a shared house bot again.', 6000);
    void loadPool();
  } catch (e) { toast(e.message, 8000); if ($('poolOwnOnly')) $('poolOwnOnly').checked = !!myAccount.prefs?.ownBotsOnly; }
}

async function recheckPoolBot(username, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/v1/pool/${encodeURIComponent(username)}/recheck`, { method: 'POST', body: {} });
    toast(r.alive ? `@${username} answers${r.botName ? ` as “${r.botName}”` : ''}.${r.warnings?.length ? ` ⚠ ${r.warnings.join(' ')}` : ''}` : `⚠ ${r.warnings?.[0] || `@${username} does not answer.`}`, 9000);
  } catch (e) { toast(e.message, 8000); }
  finally { btn.disabled = false; }
}

/**
 * Reveal one bot's token from the inventory — the only place that can show a
 * spare's, an orphaned token's, or one whose agent is archived. One bot at a
 * time, on purpose; the second press copies it.
 */
async function revealInvToken(btn, username) {
  const out = btn.parentElement.querySelector('.invtok');
  if (out && !out.hidden && out.textContent) {
    toast(await copyText(out.textContent) ? 'Token copied' : 'Select it and copy');
    return;
  }
  btn.disabled = true;
  try {
    const r = await api(`/v1/bots/${encodeURIComponent(username)}/token`);
    out.textContent = r.token;
    out.hidden = false;
    btn.textContent = 'Copy';
  } catch (e) { toast(e.message, 8000); }
  finally { btn.disabled = false; }
}

async function addPoolBot() {
  const token = $('poolToken').value.trim();
  $('poolErr').textContent = '';
  if (!token) { $('poolErr').textContent = 'Paste a bot token first.'; return; }
  $('poolAddBtn').disabled = true;
  try {
    const r = await api('/v1/pool', { method: 'POST', body: { token, shared: $('poolShared').checked } });
    $('poolToken').value = ''; $('poolShared').checked = false;
    toast(`@${r.username} added — ${r.availableBots} instant bot${r.availableBots === 1 ? '' : 's'} ready.`);
    await loadPool();
    refresh(true); // header "N instant bots ready"
  } catch (e) { $('poolErr').textContent = e.message; }
  finally { $('poolAddBtn').disabled = false; }
}

async function removePoolBot(username) {
  if (!confirm(`Delete @${username} from the pool?\n\nHatchabot discards its stored token and forgets the bot. The bot itself still exists — remove it for good at @BotFather → /mybots → /deletebot, which also frees one of your ~20 bot slots.`)) return;
  try {
    await api(`/v1/pool/${encodeURIComponent(username)}`, { method: 'DELETE' });
    await loadPool();
    refresh(true);
  } catch (e) { toast(e.message, 10000); }
}

// ---- spare Discord bots and Slack apps (Settings → Messaging) ------------------
const POOL_UI = {
  discord: { path: '/v1/discord-bots', pfx: 'dpool', label: 'Discord', room: 'server', rooms: 'servers', mark: 'discord', bg: '#5865f2' },
  slack: { path: '/v1/slack-apps', pfx: 'spool', label: 'Slack', room: 'channel', rooms: 'channels', mark: 'slack', bg: '#4a154b' },
};
let discordPool = [], slackPool = [];
async function loadPoolPane(kind) {
  const U = POOL_UI[kind]; if (!U) return;
  const el = $(`${U.pfx}List`); if (!el) return;
  const sharedRow = $(`${U.pfx}SharedRow`); if (sharedRow) sharedRow.style.display = myAccount.hostOwner ? '' : 'none';
  try {
    const r = await api(U.path);
    const pool = r.bots ?? [];
    if (kind === 'discord') discordPool = pool; else slackPool = pool;
    const inUse = r.inUse ?? [];
    const spare = pool.filter(b => !b.archivedFor);
    const ready = Number(r.availableBots ?? spare.filter(b => b.mine || b.shared).length);
    const st = $(`${U.pfx}Status`);
    if (st) st.innerHTML = `<span class="pool-dot"${ready > 0 ? '' : ' style="color:var(--off)"'}>●</span>
      <b>${ready}</b> spare ${kind === 'slack' ? 'app' : 'bot'}${ready === 1 ? '' : 's'} ready${inUse.length ? ` <span class="sub">· ${inUse.length} in use by agents</span>` : ''}
      ${ready ? '' : `<span class="sub">· an agent’s Set up… will ask for ${kind === 'slack' ? 'the app’s tokens' : 'a bot token'}</span>`}`;
    // The same four questions Settings → Messaging → Telegram answers, in the same order.
    const rows = [
      ...spare.map(b => ({ ...b, free: true })),
      ...pool.filter(b => b.archivedFor).map(b => ({ ...b, free: true, kept: true })),
      ...inUse.map(b => ({ ...b, free: false })),
    ];
    const GROUPS = [
      ['Free — yours', b => b.free && b.mine && !b.kept, 'Ready for your next agent.'],
      ['Kept for an archived agent', b => b.free && b.kept, 'Its agent takes it back on restore; another agent may take it first.'],
      ['In use — yours', b => !b.free && b.mine, ''],
      ['Free — shared with you', b => b.free && !b.mine && !b.kept, 'Parked by someone else on this server; your next agent can take one.'],
      ['In use — someone else’s', b => !b.free && !b.mine, ''],
    ];
    const mark = `<span class="v2chan-mark v2mk-${U.mark}" style="background:${U.bg};width:18px;height:18px;vertical-align:-4px">${V2_MARK_SVG[U.mark]}</span>`;
    const row = (b) => `<div class="pair" style="align-items:flex-start;padding:6px 0;border-top:1px solid var(--line)">
        <span class="grow">${mark} <b class="pii">${esc(b.botName || b.applicationId)}</b>${b.shared ? ' <span class="chip">shared</span>' : ''}${b.team ? ` <span class="sub">in ${esc(b.team)}</span>` : ''}
          ${!b.free ? `<span class="sub">· ${esc(b.agentName || 'an agent')}</span>` : ''}
          <div class="sub">${b.servers?.length ? `In ${b.servers.map(g => esc(g.name || g.id)).join(', ')}` : `Not in any ${U.room} yet`}${b.checkedAt ? ` · checked ${esc(ago(b.checkedAt))}` : ''}</div>
          ${b.warnings?.length ? `<ul class="v2chan-warn">${b.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</span>
        <span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">
          ${b.free
            ? `${httpsUrl(b.addToServerUrl) ? `<a class="btn" href="${esc(b.addToServerUrl)}" target="_blank" rel="noopener">Add to a server</a>` : ''}
               <button ${onAction('click', 'recheckPoolApp', [`${kind}`, `${b.applicationId ?? ''}`, { $: 'el' }])} title="Ask ${U.label} again: ${U.rooms}, and whether anything still needs fixing">↻ Re-check</button>
               ${b.mine || myAccount.hostOwner ? `<button class="hbtn danger" ${onAction('click', 'removePoolApp', [`${kind}`, `${b.applicationId ?? ''}`, `${(b.botName || b.applicationId) ?? ''}`])} title="Discard the stored token${kind === 'slack' ? 's' : ''}. The ${kind === 'slack' ? 'app' : 'bot'} itself still exists at ${U.label}.">🗑 Delete</button>` : ''}`
            : `<span class="sub" title="Its agent would lose the ${kind === 'slack' ? 'app' : 'bot'} it answers on. Remove ${U.label} from the agent (or delete or archive it) — that parks it back here.">in use</span>`}
        </span></div>`;
    el.innerHTML = rows.length
      ? GROUPS.map(([label, pick, hint]) => {
          const mine = rows.filter(pick);
          if (!mine.length) return '';
          return `<div style="margin:10px 0 0"><b style="font-size:13px">${label}</b> <span class="sub">· ${mine.length}</span>
            ${hint ? `<div class="sub" style="margin:2px 0 0">${hint}</div>` : ''}</div>${mine.map(row).join('')}`;
        }).join('')
      : `<div class="sub">Empty — add a spare above, or park one when removing ${U.label} from an agent.</div>`;
  } catch (e) { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
async function addChannelPoolBot(kind) {
  const U = POOL_UI[kind];
  const body = kind === 'slack'
    ? { botToken: $('spoolBot').value.trim(), appToken: $('spoolApp').value.trim(), shared: $('spoolShared').checked }
    : { token: $('dpoolToken').value.trim(), shared: $('dpoolShared').checked };
  $(`${U.pfx}Err`).textContent = '';
  if (kind === 'slack' ? !(body.botToken && body.appToken) : !body.token) { $(`${U.pfx}Err`).textContent = kind === 'slack' ? 'Paste both tokens first.' : 'Paste the bot token first.'; return; }
  $(`${U.pfx}AddBtn`).disabled = true;
  try {
    const r = await api(U.path, { method: 'POST', body });
    if (kind === 'slack') { $('spoolBot').value = ''; $('spoolApp').value = ''; $('spoolShared').checked = false; }
    else { $('dpoolToken').value = ''; $('dpoolShared').checked = false; }
    toast(`${r.bot.botName || 'It'} is parked${r.bot.warnings?.length ? ` — ${r.bot.warnings.length} thing${r.bot.warnings.length === 1 ? '' : 's'} to fix` : ''}.`);
    await loadPoolPane(kind);
  } catch (e) { $(`${U.pfx}Err`).textContent = e.message; }
  finally { $(`${U.pfx}AddBtn`).disabled = false; }
}
async function recheckPoolApp(kind, id, btn) {
  btn.disabled = true;
  try { await api(`${POOL_UI[kind].path}/${encodeURIComponent(id)}/recheck`, { method: 'POST', body: {} }); await loadPoolPane(kind); }
  catch (e) { toast(e.message, 8000); btn.disabled = false; }
}
async function removePoolApp(kind, id, name) {
  const U = POOL_UI[kind];
  if (!confirm(`Delete ${name} from the pool?\n\nHatchabot discards its stored token${kind === 'slack' ? 's' : ''}. The ${kind === 'slack' ? 'app' : 'bot'} itself still exists — remove it for good at ${U.label}.`)) return;
  try { await api(`${U.path}/${encodeURIComponent(id)}`, { method: 'DELETE' }); await loadPoolPane(kind); }
  catch (e) { toast(e.message, 10000); }
}

// ---- hosts (Cluster mode) ---------------------------------------------------

/** Settings → Hosts: the defaults an owner tunes, written to .env by the app and applied at once. */
async function loadMachineDefaults() {
  const box = $('machineDefaults'); if (!box) return;
  let r; try { r = await api('/v1/machine-defaults'); } catch { box.hidden = true; return; } // not this machine's owner
  box.hidden = false;
  box.innerHTML = `<div><b>⚙️ Defaults for this machine</b></div>
    <div class="sub" style="margin:2px 0 8px">What every agent here gets unless it says otherwise. Saved to this machine's <code>.env</code>, so they survive a restart; each applies as it says, without a rebuild.</div>`
    + r.defaults.map(d => `<div class="pair" style="align-items:flex-start;padding:6px 0;border-top:1px solid var(--line);flex-wrap:wrap;gap:6px">
      <label for="md-${d.key}" class="grow" style="margin:0;min-width:220px"><b>${esc(d.label)}</b>
        <div class="sub">${esc(d.help)}</div><div class="sub">Applies ${esc(d.applies)}.${d.set ? '' : ` Default: ${esc(d.fallback)}.`}</div>${d.note ? `<div class="sub" id="md-note-${d.key}">${esc(d.note)}</div>` : ''}</label>
      <span style="display:flex;gap:6px;align-items:center"><input id="md-${d.key}" value="${esc(d.value)}" style="width:7em" autocomplete="off" spellcheck="false"
        ${onAction('keydown', 'saveMachineDefault', [`${d.key}`, { $: 'el' }], 'key=Enter')}><button class="hbtn" ${onAction('click', 'saveMachineDefaultOf', [`${d.key}`])}>Save</button></span></div>`).join('');
}
async function saveMachineDefault(key, input) {
  try {
    const r = await api('/v1/machine-defaults', { method: 'PUT', body: { key, value: input.value } });
    input.value = r.default.value;
    const gone = r.volumeGone?.length ? ` Not on ${r.volumeGone.join(', ')}: its stored files are not on its machine (the volume is gone).` : '';
    // Saved but not yet in effect, and why (HB-0937: a failed restart of the memory search service).
    const later = r.notApplied ? ` ${r.notApplied}` : '';
    toast(`Saved${r.applied ? ` — applied to ${r.applied} ${key === 'engineMemory' ? 'service' : `agent${r.applied === 1 ? '' : 's'}`}` : ''}.${gone}${later}`, gone ? 8000 : undefined);
  } catch (e) { toast(e.message, 6000); }
}
async function loadHosts() {
  void loadMachineDefaults();
  const el = $('hostList');
  try {
    hosts = await api('/v1/hosts');
    el.innerHTML = hosts.map(h => {
      const local = h.kind === 'local';
      const where = local ? 'this machine · Claude Max or API key'
        : `${esc(h.settings?.dockerHost || '')} · API key or Max setup-token`;
      const check = local ? '' : `<button class="hbtn" ${onAction('click', 'pingHost', [`${h.id ?? ''}`])}>Check</button>`;
      const drain = !local && h.agentCount ? `<button class="hbtn" ${onAction('click', 'drainHost', [`${h.id ?? ''}`, `${h.name ?? ''}`])}>Drain</button>` : '';
      const del = local || h.agentCount ? '' : `<button class="hbtn" ${onAction('click', 'deleteHost', [`${h.id ?? ''}`, `${h.name ?? ''}`])}>Remove</button>`;
      return `<div class="pair" style="align-items:flex-start;padding:6px 0;border-top:1px solid var(--line)">
        <span class="grow">${local ? '🖥️' : '☁️'} <b>${esc(h.name)}</b>
          <span class="sub">· ${h.agentCount ?? 0} agent${h.agentCount === 1 ? '' : 's'}</span>
          <div class="sub">${where}</div>
          ${local ? '' : `<div class="sub hostembed">Memory search <span id="hostembed-${esc(h.id)}">…</span> <span id="hostembedacts-${esc(h.id)}" style="display:inline-flex;gap:6px"></span></div>`}
          <div class="sub" id="hostping-${esc(h.id)}"></div></span>
        <span style="display:flex;gap:6px">${check}${drain}${del}</span>
      </div>`;
    }).join('');
    for (const h of hosts) if (h.kind !== 'local') loadHostEmbedder(h.id);
  } catch (e) { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}

// A runner's own memory search service (2.147): its agents use it on their own machine.
async function loadHostEmbedder(hostId) {
  const st = $(`hostembed-${hostId}`), acts = $(`hostembedacts-${hostId}`);
  if (!st) return;
  try {
    const r = await api(`/v1/embedder?host=${encodeURIComponent(hostId)}`);
    const up = r.embedder === 'running' && r.door === 'running';
    st.textContent = !r.enabled && r.embedder === 'absent' ? '· off — starts with the first agent built there'
      : up ? '· running' : `· ${r.enabled ? 'restarting' : 'stopped'}`;
    st.style.color = up ? 'var(--ok)' : '';
    // Runners are listed only to their owner; the check is the server's too.
    const h = (hosts || []).find(x => x.id === hostId);
    const mine = !h?.ownerId || h.ownerId === myAccount.ownerId;
    acts.innerHTML = !mine ? '' : up
      ? `<button class="hbtn" ${onAction('click', 'embedderAction', ["restart", `${hostId ?? ''}`])}>Restart</button><button class="hbtn" ${onAction('click', 'embedderAction', ["stop", `${hostId ?? ''}`])}>Stop</button>`
      : `<button class="hbtn" ${onAction('click', 'embedderAction', ["start", `${hostId ?? ''}`])}>Start</button>`;
  } catch (e) { st.textContent = `· ${e.message}`; acts.innerHTML = ''; }
}

// The embedding service (Settings → Hosts): on/off is the machine owner's.
async function loadEmbedder() {
  const st = $('embedStatus'), acts = $('embedActions');
  if (!st) return;
  try {
    const r = await api('/v1/embedder');
    const up = r.embedder === 'running' && r.door === 'running';
    st.textContent = r.external ? `· external server ${r.external}`
      : !r.enabled && r.embedder === 'absent' ? '· off'
      : up ? `· running${r.doorAddress ? ` at ${r.doorAddress}` : ''}` : `· ${r.enabled ? 'restarting' : 'stopped'} (engine ${r.embedder ?? 'absent'}, door ${r.door ?? 'absent'})`;
    st.style.color = up ? 'var(--ok)' : '';
    acts.innerHTML = !myAccount.hostOwner || r.external ? '' : up
      ? `<button class="hbtn" ${onAction('click', 'embedderAction', ["restart"])}>Restart</button><button class="hbtn" ${onAction('click', 'embedderAction', ["stop"])}>Stop</button>`
      : `<button class="primary" ${onAction('click', 'embedderAction', ["start"])}>Start</button>`;
  } catch (e) { st.textContent = `· ${e.message}`; }
}
async function embedderAction(action, hostId) {
  if (action === 'stop' && !confirm(`Stop the memory search service${hostId ? ' on that machine' : ''}?\n\nEvery agent that uses it loses memory search until it is started again, and their rebuilds wait for it. It stays stopped — for everyone — until you start it.`)) return;
  const st = hostId ? $(`hostembed-${hostId}`) : $('embedStatus');
  if (st) st.textContent = action === 'stop' ? '· stopping…' : hostId ? '· starting (the first start copies the model over, a minute or two)…' : '· starting (the first start fetches the model)…';
  const acts = hostId ? $(`hostembedacts-${hostId}`) : $('embedActions');
  if (acts) acts.innerHTML = '';
  try { await api(`/v1/embedder/${action}`, { method: 'POST', body: hostId ? { host: hostId } : {} }); toast(action === 'stop' ? 'Memory search stopped' : 'Memory search running'); }
  catch (e) { toast(e.message, 15000); }
  if (hostId) loadHostEmbedder(hostId); else loadEmbedder();
}

// Memory search across the fleet (Settings → Hosts, under the service): what new agents get, and moving the rest.
async function loadEmbedFleet() {
  const row = $('embedFleetRow'), el = $('embedFleetBody');
  if (!row || !myAccount.hostOwner) return;
  try {
    const r = await api('/v1/embed-default');
    row.hidden = false;
    const rest = r.total - r.shared;
    el.innerHTML = `<span>${r.shared} of ${r.total} agent${r.total === 1 ? '' : 's'} on the shared service${r.pending ? ` <span class="sub">· ${r.pending} waiting for a rebuild</span>` : ''}</span>
      <label style="margin:0;display:inline-flex;align-items:center;gap:6px">New agents use
        <select style="width:auto" ${onAction('change', 'setEmbedDefault', [{ $: 'value' }])}><option value="baked"${r.default === 'baked' ? ' selected' : ''}>their own engine</option><option value="shared"${r.default === 'shared' ? ' selected' : ''}>the shared service</option></select></label>
      ${rest ? `<button ${onAction('click', 'embedMoveAll', ["shared", "now"])}>Move the rest now (idle ones)</button><button ${onAction('click', 'embedMoveAll', ["shared", "quiet"])}>Move the rest overnight</button>` : ''}
      ${r.shared ? `<button ${onAction('click', 'embedMoveAll', ["baked", "quiet"])}>Move all back to their own engine</button>` : ''}
      <span class="sub">A move applies as a rebuild — memory kept, the index rebuilt — never while an agent is mid-conversation. Overnight means the quiet hours of the rebuild policy.</span>`;
  } catch (e) { row.hidden = true; }
}
async function setEmbedDefault(mode) {
  try { await api('/v1/embed-default', { method: 'PUT', body: { default: mode } }); toast(mode === 'shared' ? 'New agents will use the shared service' : 'New agents will use their own engine'); }
  catch (e) { toast(e.message, 12000); }
  loadEmbedFleet();
}
async function embedMoveAll(mode, when) {
  const what = mode === 'shared' ? 'the shared memory search service' : 'their own engine';
  if (!confirm(`Move every agent on this machine to ${what}?\n\n${when === 'now' ? 'Idle ones rebuild now, as many at once as Rebuild-at-once allows; any mid-conversation wait for the quiet hours.' : 'They rebuild in the quiet hours, never mid-conversation.'} Memory is kept; each re-indexes its memory search afterwards.`)) return;
  try {
    const r = await api('/v1/embed/move-all', { method: 'POST', body: { mode, when } });
    toast(`${r.switched} switched — ${r.queued} rebuilding now, ${r.deferred} in the quiet hours.`
      + (r.engineFree > 0 ? ` ${r.engineFree} left on the shared service: their image has no engine of its own.` : ''), 12000);
  } catch (e) { toast(e.message, 12000); }
  loadEmbedFleet();
}

async function pingHost(id) {
  const el = $(`hostping-${id}`);
  if (el) { el.textContent = 'checking…'; el.style.color = 'var(--dim)'; }
  try {
    const r = await api(`/v1/hosts/${id}/ping`);
    // A copy under way (started from another page, or before a reload): follow it instead.
    const copy = await api(`/v1/hosts/${id}/install-image`).catch(() => null);
    if (imageCopyUnderWay(copy)) { followImageCopy(id); return; }
    if (el) {
      el.style.color = r.reachable ? 'var(--ok)' : 'var(--warn)';
      if (!r.reachable) { el.textContent = `⚠ unreachable — ${r.error || 'no response'}`; return; }
      // Reachable but missing the runtime image = provision will fail — offer
      // the fix right here instead of letting the first create explain it.
      el.innerHTML = `✓ reachable · Docker ${esc(r.serverVersion || '')}` +
        (r.hasImage === false
          ? ` · <span style="color:var(--warn)">runtime image missing</span> <button class="hbtn" ${onAction('click', 'installImage', [`${id ?? ''}`])}>Install image</button>`
          : r.imageVersion && r.currentVersion && r.imageVersion !== r.currentVersion
          ? ` · <span style="color:var(--warn)">OpenClaw ${esc(r.imageVersion)} (this machine: ${esc(r.currentVersion)})</span> <button class="hbtn" ${onAction('click', 'installImage', [`${id ?? ''}`])}>Update image</button>`
          : r.imageVersion ? ` · OpenClaw ${esc(r.imageVersion)}` : '') +
        (r.swap ? ` · swap: ${r.swap.compressed ? esc(r.swap.summary || r.swap.kind) : `<span class="sub">${esc(r.swap.kind === 'unknown' ? 'could not be read (agents there get none)' : 'not compressed (agents there get none)')}</span>`}` : '');
    }
  } catch (e) { if (el) { el.style.color = 'var(--warn)'; el.textContent = e.message; } }
}

/** Copy this server's runtime image to the runner. It runs on the server in
 *  the background (a relayed link takes 15 minutes or more); the row follows
 *  its progress, and a page opened meanwhile picks it up (pingHost). */
async function installImage(id) {
  const h = hosts.find(x => x.id === id);
  if (!confirm(`Copy the runtime image to "${h?.name ?? 'this runner'}"?\n\nIt's large (often over a gigabyte), so this can take several minutes depending on the connection. Agents there move to it on their next rebuild.`)) return;
  try { await api(`/v1/hosts/${id}/install-image`, { method: 'POST', body: {} }); }
  catch (e) { toast(`Image install failed: ${e.message}`, 20000); return; }
  toast(`Copying the runtime image to ${h?.name ?? 'the runner'}… its row shows how far it has come.`, 8000);
  followImageCopy(id);
}
const imageCopyFollowing = new Set();
/**
 * An answer that says a copy is under way: `done: false`, as the server sends while it copies. Anything else, an
 * answer of another shape among them, was followed every 3 s for the page's life (HB-1307).
 */
const imageCopyUnderWay = (j) => !!j && typeof j === 'object' && j.done === false && !j.idle;
async function followImageCopy(id) {
  if (imageCopyFollowing.has(id)) return;
  imageCopyFollowing.add(id);
  const h = hosts.find(x => x.id === id);
  const gb = (b) => (b / 1e9).toFixed(1);
  try {
    for (;;) {
      const j = await api(`/v1/hosts/${id}/install-image`).catch(() => null);
      const el = $(`hostping-${id}`);
      if (!j || j.idle) return;
      if (j.done === true) {
        // Installed on the published image of another CPU, not built as this machine's (HB-1189).
        if (j.ok && j.differs) toast(`⚠ Runtime image installed on ${h?.name ?? 'the runner'}. ${j.differs}`, 20000);
        else if (j.ok) toast(`✅ Runtime image installed on ${h?.name ?? 'the runner'}.`, 10000);
        else toast(j.error || 'Image install failed.', 20000);
        pingHost(id);
        return;
      }
      if (!imageCopyUnderWay(j)) return;
      if (el) {
        el.style.color = 'var(--dim)';
        el.textContent = `copying the runtime image… ${gb(j.bytes)}${j.total ? ` of ${gb(j.total)}` : ''} GB`;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  } finally { imageCopyFollowing.delete(id); }
}

let runnerSnippet = '';
async function showRunnerSetup() {
  try {
    const r = await api('/v1/runner-setup');
    runnerSnippet = r.snippet;
    const el = $('runnerSetupOut');
    el.textContent = r.snippet;
    el.style.display = 'block';
  } catch (e) { toast(e.message, 10000); }
}
function copyRunnerSetup() {
  copyText(runnerSnippet).then((ok) => toast(ok ? 'Copied — paste it in a terminal on the runner.' : 'Select the snippet and copy it manually.'));
}

async function addHost() {
  const name = $('hostName').value.trim();
  const dockerHost = $('hostEndpoint').value.trim();
  $('hostErr').textContent = '';
  if (!name || !dockerHost) { $('hostErr').textContent = 'Give it a name and an endpoint.'; return; }
  $('hostAddBtn').disabled = true;
  try {
    const h = await api('/v1/hosts', { method: 'POST', body: { name, dockerHost } });
    $('hostName').value = ''; $('hostEndpoint').value = '';
    await loadHosts();
    toast(h.reachable
      ? `Runner "${name}" added — Docker ${h.serverVersion} reachable${h.hasImage === false ? '. The runtime image is missing — use Install image on its row.' : '.'}${h.warning ? ` ${h.warning}` : ''}`
      : `Runner "${name}" added, but it didn't answer yet (${h.pingError || 'unreachable'}) — check step 2, then Check its row.`, 20000);
    if (h.reachable) pingHost(h.id);
  } catch (e) { $('hostErr').textContent = e.message; }
  finally { $('hostAddBtn').disabled = false; }
}

async function drainHost(id, name) {
  if (!confirm(`Drain "${name}"? Every running agent on it is stopped (take the runner out of service). You can delete or move them afterward.`)) return;
  try {
    const r = await api(`/v1/hosts/${id}/drain`, { method: 'POST', body: {} });
    await loadHosts();
    const tail = r.skipped?.length ? ` — ${r.skipped.length} skipped (busy): ${r.skipped.join(', ')}` : '';
    toast(`Stopped ${r.stopped} agent${r.stopped === 1 ? '' : 's'} on "${name}"${tail}`, 15000);
    await refresh(false);
  } catch (e) { toast(e.message, 20000); }
}

async function deleteHost(id, name) {
  if (!confirm(`Remove runner "${name}"? Agents can no longer be placed there.`)) return;
  try {
    let r;
    try { r = await api(`/v1/hosts/${id}`, { method: 'DELETE' }); }
    catch (e) {
      // An image copy under way to it: Remove anyway stops it (HB-1254); waiting for it took up to hours.
      if (e.code !== 'image_copy') throw e;
      if (!confirm(`${e.message}\n\nRemove anyway? That stops the copy to "${name}" where it is.`)) { toast('Not removed.', 6000); return; }
      r = await api(`/v1/hosts/${id}`, { method: 'DELETE', body: { stopImageCopy: true } });
    }
    await loadHosts();
    // What could not be removed on that machine (asleep, a docker refusal) is said, not dropped.
    if (r?.warning) toast(`Removed "${name}". ${r.warning}`, 20000);
    else toast(`Removed "${name}"`);
  } catch (e) { toast(e.message, 20000); }
}

// The machine's rebuild policy (Runtime tab; machine owner sets it).
let rebuildPolicyNow = 'required-only';
const REBUILD_POLICY_TEXT = {
  'required-only': 'Required rebuilds happen on their own, once an agent is idle. Others wait for you.',
  auto: 'Required rebuilds happen once an agent is idle; the rest overnight (quiet hours).',
  manual: 'Nothing happens on its own — the cards say what needs a rebuild.',
};
/** Automatic rebuilds, under Settings → Hosts since v2.157.0: the machine owner's. */
function loadRebuildSection() {
  $('rbSection').hidden = $('rbHead').hidden = !myAccount.hostOwner;
  if (myAccount.hostOwner) void loadRebuildPolicy();
}
async function loadRebuildPolicy() {
  void loadRebuildAtOnce();
  try {
    const r = await api('/v1/rebuild-policy');
    rebuildPolicyNow = r.policy;
    const sel = $('rbPolicy'); if (!sel) return;
    sel.value = r.policy;
    $('rbPolicyNote').textContent = REBUILD_POLICY_TEXT[r.policy] + (r.policy === 'auto' ? ` Quiet hours: ${r.quietHours}h.` : '');
  } catch { /* older server — leave the default */ }
}
async function loadRebuildAtOnce() {
  try {
    const r = await api('/v1/rebuild-concurrency');
    const sel = $('rbAtOnce'); if (!sel) return;
    sel.innerHTML = Array.from({ length: r.max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    sel.value = String(r.atOnce);
    if (appConfig) appConfig.rebuildConcurrency = r.atOnce;
  } catch { /* older server */ }
}
async function setRebuildAtOnce(n) {
  try { await api('/v1/rebuild-concurrency', { method: 'PUT', body: { atOnce: Number(n) } }); toast(`Rebuilds at once: ${n}`); if (appConfig) appConfig.rebuildConcurrency = Number(n); }
  catch (e) { toast(e.message, 12000); }
  loadRebuildAtOnce();
}
async function setRebuildPolicy(policy) {
  try {
    await api('/v1/rebuild-policy', { method: 'PUT', body: { policy } });
    toast('Rebuild policy saved');
  } catch (e) { toast(e.message, 12000); }
  loadRebuildPolicy();
}

let bkPollTimer = null;

async function loadBackups() {
  const el = $('bkList');
  // Back up now, the drills and the sets are the machine owner's: the server
  // answers anyone else 403, and leaves the last drill out of what they read.
  // A member sees the per-agent table and a line saying who runs the rest (audit, 2026-10-20).
  // Not read yet, or the read failed ({}): ask again. Still unknown, the owner's
  // view, which the server guards with its 403: hiding it on a failed read took
  // Back up now and the sets from the machine owner (regression audit, 2026-10-22).
  if (typeof myAccount.hostOwner !== 'boolean') await loadMyAccount();
  const owner = myAccount.hostOwner !== false;
  for (const id of ['bkRunRow', 'bkDrillRow', 'bkDrill', 'bkSetsHead', 'bkList']) $(id).hidden = !owner;
  $('bkOwnerOnly').hidden = owner;
  void loadReadiness(); // the per-agent table above the sets (recovery readiness)
  if (!owner) { $('bkRun').hidden = true; return; }
  try {
    const r = await api('/v1/backups');
    $('bkDir').textContent = r.dir;
    $('bkKeep').textContent = r.keepDays;
    renderBackupRun(r.run);
    if (!r.backups.length) {
      el.innerHTML = `<div class="sub">No backups yet. The nightly job runs at 03:30, or use <b>Back up now</b>.</div>`;
      return;
    }
    // Agents the newest set does not hold (one on a runner is never in it), and
    // a set whose run did not finish, said rather than shown green (review, 2026-09-29).
    const missing = (r.missing ?? []).length
      ? `<div class="sub" style="color:var(--warn);padding:4px 0 8px">⚠ Not in the newest backup: ${r.missing.map(m => `${esc(m.name)}${m.host ? ` (${esc(m.host)})` : ''}`).join(', ')}.
          Nightly backups cover the agents on this machine only; use <b>Download copy</b> for an agent that lives elsewhere.</div>` : '';
    el.innerHTML = missing + r.backups.map(b => {
      // Left out while their files were replaced (a restore, an import, a move) is no failure: the next backup
      // takes them (HB-1205). Such a volume is in failedVolumes too, for a reader from before the list.
      const replacing = b.replacing ?? [];
      const failedN = (b.failedVolumes ?? []).filter(v => !replacing.includes(v)).length, skippedN = (b.skipped ?? []).length;
      // Why it is incomplete, as its record says: "the run did not finish" was said of every set with no failed
      // volume, one whose run ended refusing (the saved key reads none of the secrets, every runner asleep) among
      // them (HB-1451). A run with no end written was cut off.
      const why = failedN || replacing.length
        ? [failedN ? `${failedN} agent${failedN === 1 ? '' : 's'} failed` : '', replacing.length ? `${replacing.length} left out while their files were replaced` : ''].filter(Boolean).join(', ')
        : skippedN ? `${skippedN} left out: ${skippedN === 1 ? 'its runner' : 'their runners'} did not answer`
        : b.finishedAt ? 'the run ended with a problem' : 'the run did not finish';
      const warn = !b.hasDb ? `<span style="color:var(--warn)"> · ⚠ no registry</span>`
        : b.complete === false ? `<span style="color:var(--warn)"> · ⚠ incomplete (${why})</span>`
        : !b.hasKey ? `<span style="color:var(--warn)"> · ⚠ no key (can't decrypt)</span>`
        : b.running ? `<span class="sub"> · still running</span>` : '';
      // Made by another install, or under an earlier key: listed, never deleted from here; a restore asks first.
      const other = b.foreign ? `<div class="sub" style="margin-top:2px">Made by another install, or under an earlier key — the nightly clean-up and Delete leave it alone; a restore from it asks first.</div>` : '';
      const orphans = (b.orphans ?? []).length
        ? `<div class="sub" style="margin-top:4px">Left out: ${b.orphans.map(esc).join(', ')} — no agent uses ${b.orphans.length === 1 ? 'this volume' : 'these volumes'}; remove by hand once you have looked (docker volume rm).</div>` : '';
      // Each agent in the set gets a Restore, but only when it maps to an agent
      // that still exists (the server attaches agentId then). Others are shown
      // greyed — there's no live agent to restore into.
      const rows = b.volumes.map(v => {
        const btn = v.agentId
          ? `<button class="hbtn" ${onAction('click', 'restoreFromBackup', [`${v.agentId ?? ''}`, `${b.date ?? ''}`, `${v.name ?? ''}`])}>Restore</button>`
          : `<span class="sub" title="No current agent matches this backup">deleted</span>`;
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:3px 0">
          <span${v.agentId ? '' : ' style="color:var(--dim)"'}>${esc(v.name)} <span class="sub">· ${fmtBytes(v.sizeBytes)}</span></span>
          ${btn}
        </div>`;
      }).join('');
      return `<div style="padding:8px 0;border-top:1px solid var(--line)">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">
          <div><b>${esc(b.date)}</b> · ${fmtBytes(b.sizeBytes)} · ${b.volumes.length} agent${b.volumes.length === 1 ? '' : 's'}${warn}</div>
          ${b.foreign ? '' : `<button class="hbtn" ${onAction('click', 'pruneBackup', [`${b.date ?? ''}`])}>Delete set</button>`}
        </div>
        ${other}
        ${rows ? `<div style="margin-top:6px">${rows}</div>` : ''}
        ${orphans}
      </div>`;
    }).join('');
  } catch (e) { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}

function renderBackupRun(run) {
  const el = $('bkRun');
  const btn = $('bkRunBtn');
  if (bkPollTimer) { clearTimeout(bkPollTimer); bkPollTimer = null; }
  if (!run || run.status === 'idle') { el.hidden = true; btn.disabled = false; btn.textContent = 'Back up now'; return; }
  el.hidden = false;
  if (run.status === 'running') {
    btn.disabled = true; btn.textContent = 'Backing up…';
    el.style.color = 'var(--dim)';
    el.textContent = 'Backing up… this can take a few minutes on large agents.';
    // Only keep polling while the Backups tab is the visible one.
    bkPollTimer = setTimeout(() => { if (!$('paneBackups').hidden) loadBackups(); }, 3000);
  } else {
    btn.disabled = false; btn.textContent = 'Back up now';
    el.style.color = run.status === 'ok' ? 'var(--ok)' : 'var(--warn)';
    el.textContent = (run.status === 'ok' ? '✓ ' : '✗ ') + (run.summary || '').split('\n').slice(-1)[0];
  }
}

async function runBackupNow() {
  try {
    const r = await api('/v1/backups/run', { method: 'POST' });
    renderBackupRun(r.run);
  } catch (e) { toast(e.message, 20000); }
}

async function pruneBackup(date) {
  if (!confirm(`Delete the backup from ${date}? This can't be undone.`)) return;
  try {
    await api(`/v1/backups/${date}`, { method: 'DELETE' });
    toast(`Deleted backup ${date}`);
    await loadBackups();
  } catch (e) { toast(e.message, 20000); }
}

// Hard gate: restoring overwrites the agent's ENTIRE memory with the backup and
// discards everything since. Make the owner type the name to mean it.
async function restoreFromBackup(agentId, date, name) {
  const typed = prompt(
    `Restore “${name}” from the ${date} backup?\n\n` +
    `This REPLACES the agent's entire memory with that night's copy and ` +
    `DISCARDS everything it has learned since. The agent is stopped for the ` +
    `swap and restarted after.\n\n` +
    `Type the agent's name to confirm:`,
    '',
  );
  if (typed === null) return;
  if (typed.trim() !== name) { toast('Name did not match — restore cancelled.', 8000); return; }
  try {
    let r;
    try { r = await api('/v1/backups/restore', { method: 'POST', body: { agentId, date } }); }
    catch (e) {
      // A set made by another install or under an earlier key: the server says why, and goes ahead on a yes.
      if (e.code !== 'other_key') throw e;
      if (!confirm(`${e.message}\n\nRestore “${name}” from it anyway?`)) { toast('Not restored.', 6000); return; }
      r = await api('/v1/backups/restore', { method: 'POST', body: { agentId, date, otherKey: true } });
    }
    // Since v2.156.0 it goes on on the server (202); how it ended — and what
    // putting its current bot and members back undid — comes as a toast.
    if (r?.operation?.id) {
      v2FollowOp(r.operation);
      toast(`Restoring “${name}” from ${date} — its tile shows each step.`, 8000);
    } else {
      // Memory and files come back; who may use it and its bot stay as they are now, and it says what that undid.
      toast(`Restored “${name}” from ${date}${r.running ? ' — restarting' : ''}.${(r.undone || []).map(u => ' ' + u).join('')}`, (r.undone || []).length ? 20000 : 12000);
    }
    await refresh(true);
    return true; // under way (the Recovery row closes its choices)
  } catch (e) { toast(e.message, 30000); }
}

// ---- Recovery readiness (docs/recovery-readiness-design.md) -------------------
// Per agent: the newest backup a restore could use, the sets that left it out,
// the last restore drill that checked it, one status. Read once a minute for
// the Alerts (an agent left out of a fresh night's set), the agent sheet's
// Recovery row and Settings → Backups.
let v2Readiness = null, v2ReadinessAt = 0, v2ReadinessP = null;
/** At most once a minute unless forced; a reading under way is shared, never doubled. */
function v2LoadReadiness(force = false) {
  if (v2ReadinessP) return v2ReadinessP;
  if (!force && Date.now() - v2ReadinessAt < 60_000) return Promise.resolve(v2Readiness);
  v2ReadinessP = (async () => {
    try {
      const r = await api('/v1/backups/readiness');
      v2Readiness = r && Array.isArray(r.agents) ? r : null;
    } catch { /* the last reading stays */ }
    finally { v2ReadinessAt = Date.now(); v2ReadinessP = null; }
    return v2Readiness;
  })();
  return v2ReadinessP;
}
const v2RecoveryOf = (id) => (v2Readiness?.agents || []).find(r => r.agentId === id);
const v2ReadinessSig = () => JSON.stringify([(v2Readiness?.agents || []).map(r => [r.agentId, r.status, r.alert?.key || '']), v2Readiness?.drill?.last?.at || '']);
/** The poll's reading: what changed is painted (the tiles' Alerts, an open Recovery row). */
async function v2LoadReadinessPaint(force = false) {
  const before = v2ReadinessSig();
  await v2LoadReadiness(force);
  if (v2ReadinessSig() === before) return;
  renderV2();
  const row = $('v2RecoveryRow'); if (row) void v2PaintRecovery(row.dataset.agent);
}
const RECOVERY_BAD = ['stale', 'not covered', 'drill failed'];

/** The guided restore open in the agent's Recovery row: { id, date, sets } (sets: the ones a restore can use). */
let v2RecoveryPick = null;
async function v2PaintRecovery(id) {
  if (!v2Readiness) await v2LoadReadiness(true);
  const el = $('v2RecoveryRow'); if (!el || el.dataset.agent !== id) return;
  const r = v2RecoveryOf(id), a = v2Find(id);
  if (!r || !a) { el.innerHTML = '<span class="sub">Nothing is known about its backups yet.</span>'; return; }
  const can = !!v2Readiness.canRestore && !!r.latestUsable;
  const pick = v2RecoveryPick?.id === id ? v2RecoveryPick : null;
  const guided = pick ? (() => {
    const sets = pick.sets || [];
    if (!sets.length) return '<div class="sub" style="flex-basis:100%">Loading the backups that hold it…</div>';
    const s = sets.find(x => x.date === pick.date) || sets[0];
    return `<div id="v2RecoveryPick" style="flex-basis:100%;margin-top:6px">
      <fieldset style="border:0;padding:0;margin:0"><legend class="sub">Restore it from the backup of</legend>
      ${sets.map(x => `<label style="display:block;margin:2px 0"><input type="radio" name="v2RecDate" value="${esc(x.date)}"${x.date === s.date ? ' checked' : ''} ${onAction('change', 'v2RecoveryChoose', [`${id ?? ''}`, { $: 'value' }])}>
        ${esc(x.date)} <span class="sub">· ${fmtBytes(x.sizeBytes)}${x.complete === false ? ' · a set that was not complete; its own copy is whole' : ''}${x.otherKey ? ' · made by another install, or under an earlier key' : ''}${x.drill ? ` · drill ${x.drill === 'passed' ? 'passed' : 'failed'}` : ''}</span></label>`).join('')}
      </fieldset>
      <div class="sub" style="margin:6px 0">What it holds: its whole memory, files and OpenClaw settings as they were that night.
        What is undone: everything it learned or changed since ${esc(s.date)}. Its current Telegram bot, the people who may use it and its model stay as they are now.
        It is stopped for the swap${a.state === 'RUNNING' ? ' and started again after' : ''}; you type its name to confirm.</div>
      <button type="button" class="primary" ${onAction('click', 'v2RecoveryGo', [`${id ?? ''}`])}>Restore from ${esc(s.date)}…</button>
      <button type="button" ${onAction('click', 'v2RecoveryToggle', [`${id ?? ''}`])}>Cancel</button>
    </div>`;
  })() : '';
  el.innerHTML = `<span id="v2RecoveryLine"${RECOVERY_BAD.includes(r.status) ? ' class="warn"' : ''}>${esc(r.line)}</span>
    ${can ? `<button type="button" id="v2RecoveryBtn" aria-expanded="${!!pick}" ${onAction('click', 'v2RecoveryToggle', [`${id ?? ''}`])}>Restore…</button>` : ''}
    ${!v2Readiness.canRestore && r.latestUsable ? '<span class="sub" style="flex-basis:100%">Only this machine\'s owner can restore it.</span>' : ''}
    ${guided}`;
}
/**
 * Restore… opens the guided restore with this install's own newest usable
 * backup chosen (and closes it again). Another install's set, newer or not, is
 * listed but chosen only when there is none of its own; restoring from it
 * asks first (restoreFromBackup).
 */
async function v2RecoveryToggle(id) {
  if (v2RecoveryPick?.id === id) { v2RecoveryPick = null; void v2PaintRecovery(id); return; }
  const r = v2RecoveryOf(id);
  v2RecoveryPick = { id, date: (r?.ownLatest || r?.latestUsable)?.date, sets: [] };
  void v2PaintRecovery(id);
  try {
    const one = await api(`/v1/backups/readiness?agentId=${encodeURIComponent(id)}`);
    const sets = (one?.agents || []).find(x => x.agentId === id)?.restorable || [];
    if (v2RecoveryPick?.id !== id) return;
    v2RecoveryPick.sets = sets;
    if (!sets.some(x => x.date === v2RecoveryPick.date)) v2RecoveryPick.date = (sets.find(x => !x.otherKey) || sets[0])?.date;
    if (!sets.length) { v2RecoveryPick = null; toast('No backup that holds it could be found now.', 8000); }
  } catch (e) { v2RecoveryPick = null; toast(e.message, 8000); }
  void v2PaintRecovery(id);
}
async function v2RecoveryChoose(id, date) {
  if (v2RecoveryPick?.id !== id) return;
  v2RecoveryPick.date = date;
  await v2PaintRecovery(id);
  [...document.querySelectorAll('#v2RecoveryPick input[name="v2RecDate"]')].find(i => i.value === date)?.focus(); // the keyboard stays on the choice
}
/** The chosen date into the existing restore (its typed-name confirm and /v1/backups/restore). */
async function v2RecoveryGo(id) {
  const a = v2Find(id), date = v2RecoveryPick?.id === id ? v2RecoveryPick.date : null;
  if (!a || !date) return;
  // A wrong name or Cancel restores nothing: the choices stay open.
  if (!(await restoreFromBackup(id, date, a.name))) return;
  v2RecoveryPick = null;
  void v2PaintRecovery(id);
  void v2LoadReadinessPaint(true);
}

// Settings → Backups: the per-agent table, the drill setting and Run a drill now.
let bkDrillTimer = null;
async function loadReadiness() {
  const el = $('bkReady'); if (!el) return;
  const r = await v2LoadReadiness(true);
  if (!r) { el.innerHTML = '<div class="sub">Not known yet.</div>'; renderDrillRun(null); return; }
  $('bkDrillEvery').value = r.drill?.every || 'off';
  renderDrillRun(r.drill);
  if (!r.agents.length) { el.innerHTML = '<div class="sub">No agent has anything to back up yet.</div>'; return; }
  const lo = (x) => {
    const l = x.leftOut || {};
    if (!l.count) return '—';
    const why = [l.asleep ? 'machine asleep' : '', l.replacing ? 'files being replaced' : '', l.failed ? 'failed' : '', l.missing ? 'volume missing' : '', l.other ? 'not taken' : ''].filter(Boolean).join(', ');
    return `${l.count} of ${l.of} <span class="sub">(${why})</span>`;
  };
  const cell = 'style="padding:4px 8px 4px 0;border-top:1px solid var(--line);vertical-align:top"';
  // This install's own newest, as the Status reads it; another install's newer
  // copy is named beside it, so the date and the Status agree (ninth review).
  const latest = (x) => {
    const own = x.ownLatest || (x.latestUsable && !x.latestUsable.otherKey ? x.latestUsable : null);
    const other = x.latestUsable?.otherKey && (!own || x.latestUsable.date > own.date) ? x.latestUsable : null;
    return (own ? `${esc(own.date)}${own.ageDays ? ` <span class="sub">(${own.ageDays}d ago)</span>` : ''}` : '<span class="warn">none</span>')
      + (other ? ` <span class="sub">(a newer copy from another install: ${esc(other.date)})</span>` : '');
  };
  el.innerHTML = `<table id="bkReadyTable" style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr class="sub" style="text-align:left"><th ${cell}>Agent</th><th ${cell}>Latest usable</th><th ${cell}>Left out of</th><th ${cell}>Last drill</th><th ${cell}>Status</th></tr></thead>
    <tbody>${r.agents.map(x => `<tr data-agent="${esc(x.agentId)}">
      <td ${cell}>${esc(x.name)}${x.runner ? ` <span class="sub">(${esc(x.runner.name)}${x.runner.reachable === false ? ', not answering' : ''})</span>` : ''}</td>
      <td ${cell}>${latest(x)}</td>
      <td ${cell}>${lo(x)}</td>
      <td ${cell}>${x.drill ? `${esc(x.drill.at.slice(0, 10))} ${x.drill.passed ? 'passed' : '<span class="warn">failed</span>'}` : 'never'}</td>
      <td ${cell} title="${esc(x.line)}"${RECOVERY_BAD.includes(x.status) ? ' class="warn"' : ''}>${esc(x.status)}</td>
    </tr>`).join('')}</tbody></table>`;
}
function renderDrillRun(d) {
  const el = $('bkDrill'), btn = $('bkDrillBtn'); if (!el || !btn) return;
  if (bkDrillTimer) { clearTimeout(bkDrillTimer); bkDrillTimer = null; }
  const run = d?.run, last = d?.last;
  if (run?.status === 'running') {
    btn.disabled = true; btn.textContent = 'Drilling…';
    el.style.color = 'var(--dim)';
    el.textContent = "A restore drill is running: each agent's copy is restored into a throwaway volume, one at a time. It can take a while; Activity shows how it ends.";
    bkDrillTimer = setTimeout(() => { if (!$('paneBackups').hidden) void loadReadiness(); }, 5000);
    return;
  }
  btn.disabled = false; btn.textContent = 'Run a drill now';
  const hh = (n) => String(n).padStart(2, '0') + ':00';
  const when = d?.every && d.every !== 'off'
    ? ` Automatic drills: ${d.every}, between ${hh(d.hours?.from ?? 5)} and ${hh(d.hours?.to ?? 7)} after that night's backup.`
    : ' Automatic drills are off.';
  // A run that failed without writing a record of its own (it could not
  // start, or stopped first) is newer than the last record: it is said first,
  // in the warning colour, not hidden behind an older pass (HB-0353). A run
  // whose record was written is that record.
  const tail = (run?.summary || '').split('\n').slice(-1)[0];
  const runFailed = run?.status === 'error' && (!last || !run.startedAt || !(Date.parse(last.at) >= run.startedAt - 5000));
  const failedRun = runFailed && !last ? ` ${tail}` : '';
  const words = (runFailed && last ? `The latest restore drill failed${tail ? `: ${tail}${/[.!?]$/.test(tail) ? '' : '.'}` : '.'} Before it: ` : '') + (last
    ? `Last drill ${last.at.slice(0, 10)}${last.set ? ` on the ${last.set} backup` : ''}: ${last.passed ? 'passed' : 'failed'} — ${last.checked} agent${last.checked === 1 ? '' : 's'} checked, ${last.restored} restored into a throwaway volume${last.failed ? `, ${last.failed} did not pass` : ''}${last.database !== 'ok' ? ', the database copy did not pass' : ''}${last.key !== 'ok' ? ', the saved key did not pass' : ''}.`
    : 'No restore drill has run yet.');
  el.style.color = runFailed || (last && !last.passed) ? 'var(--warn)' : '';
  el.textContent = words + when + failedRun;
}
async function runDrillNow() {
  try {
    const r = await api('/v1/backups/drill', { method: 'POST' });
    renderDrillRun({ ...(v2Readiness?.drill || {}), run: r.run });
    if (r.run?.status === 'error') toast(r.run.summary || 'The restore drill could not start.', 12000);
  } catch (e) { toast(e.message, 12000); }
}
async function setDrillEvery(every) {
  try {
    await api('/v1/backups/drill-schedule', { method: 'PUT', body: { every } });
    toast(every === 'off' ? 'Automatic restore drills are off.' : `A restore drill will run ${every}, early in the morning after that night's backup.`);
    await loadReadiness();
  } catch (e) { toast(e.message, 12000); $('bkDrillEvery').value = v2Readiness?.drill?.every || 'off'; }
}
