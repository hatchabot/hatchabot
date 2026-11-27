// web/app/sheet.js: an agent's settings sheet: its tabs and panes (v2Pane), keeping it current while open (v2RefreshSheet), Apps in agents and running an app from a repo, usage, files, members, web chat, Telegram.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- the settings sheet ----------------------------------------------------------------
let v2AgentId = null, v2Tab = 'overview';
const V2_TABS = [['overview', 'Overview'], ['personality', 'Personality'], ['ai', 'AI'], ['knowledge', 'Data'], ['files', 'Files'], ['messaging', 'Telegram'], ['channels', 'Discord'], ['slack', 'Slack'], ['sharing', 'Sharing'], ['schedule', 'Schedule'], ['usage', 'Usage'], ['advanced', 'Advanced']];
/** Where each editDlg section lives in the sheet (so every old deep link,
 *  e.g. "fill its Setup values", still lands in the right place). */
const V2_TAB_FOR_EDIT = { def: 'personality', snap: 'personality', ai: 'ai', data: 'knowledge', conn: 'knowledge', peers: 'sharing', tg: 'messaging', env: 'advanced' };
/** The editDlg sections each sheet tab embeds, with a heading for each. */
const V2_EMBED = {
  personality: [['paneDef', ''], ['paneEditSnap', 'Snapshots']],
  ai: [['paneEditAi', '']],
  knowledge: [['paneEditData', 'Folders'], ['paneEditConn', 'Connections']],
  messaging: [['paneEditTg', '']],
  sharing: [['paneEditPeers', 'Other agents it can ask']], // + the members block, moved in
  advanced: [['paneEditEnv', 'Environment']],
  schedule: [['cronBody', '']],
};
let v2EditFor = null;
/** The agent the sheet's notes of unsaved edits (v2SheetNotes) are for. */
let v2NotesFor = null;
/** Put borrowed edit sections back in their dialog before the pane is redrawn,
 *  or setting innerHTML would destroy them (and every id the edit code uses). */
/** [block id, the pane it lives in when parked] */
const V2_MOVED = [['tgMembersBlock', 'paneEditTg'], ['imagePinRow', 'paneEditEnv'], ['embedModeRow', 'paneEditEnv'], ['memoryCapRow', 'paneEditEnv']];
function v2ParkPanes() {
  sharingView++;
  // Blocks that live in one editDlg pane but belong in a different place here:
  // members under Sharing (people, not plumbing), the image picker inside the
  // Runtime row (one place to say what an agent runs).
  for (const [blockId, home] of V2_MOVED) {
    const el = $('v2Pane').querySelector('#' + blockId);
    // Parked = out of sight in its home pane: it belongs only to the tab that borrows it (it appeared twice —
    // members under both Telegram and Sharing, 2026-09-20).
    if (el) { el.hidden = true; $(home).append(el); }
  }
  for (const el of $('v2Pane').querySelectorAll('section[id^="pane"], #editErr')) editDlg.append(el);
  const cron = $('v2Pane').querySelector('#cronBody'); if (cron) cronDlg.append(cron);
  const hb = $('v2Pane').querySelector('#healthDlgBody'); if (hb) healthDlg.append(hb);
}
function v2EmbedPanes(a, tab) {
  // Another agent, whichever tab opens: the notes were the last one's (the one place they are
  // cleared here), and its forms are filled again when one of their tabs opens (v2EditFor, the
  // refill below). Kept on its Schedule tab, an edit left in them held this agent's redraw (HB-0475).
  // The same agent's forms filled again (after a redraw for its state) are noted afresh by
  // prepareEdit, and controls drawn over since drop out (v2SheetUnsaved).
  if (v2NotesFor !== a.id) { v2SheetNotes.clear(); v2NotesFor = a.id; v2EditFor = null; }
  if (tab === 'files') { void v2LoadFiles(a.id, v2FilesPath.get(a.id) ?? ''); return; }
  const list = V2_EMBED[tab]; if (!list) return;
  if (tab === 'schedule') {
    const slot = $('v2Pane').querySelector('[data-v2slot="cronBody"]');
    if (!slot || a.state !== 'RUNNING') return;
    prepareCrons(a.id, a.name);
    slot.append($('cronBody'));
    void loadCrons();
    return;
  }
  const refilled = v2EditFor !== a.id;
  if (refilled) {
    prepareEdit(a.id, a.name);
    v2EditFor = a.id;
    void loadEditFile(); void loadSnapshots();
  }
  for (const [paneId, heading] of list) {
    const slot = $('v2Pane').querySelector(`[data-v2slot="${paneId}"]`); if (!slot) continue;
    if (heading) slot.insertAdjacentHTML('beforeend', `<h4 class="v2sec">${esc(heading)}</h4>`);
    const pane = $(paneId); pane.hidden = false; slot.append(pane);
    // The one borrowed section with sub-sections of its own: card each one,
    // the way ⚙ Settings does. Idempotent, so reopening the sheet is free.
    if (paneId === 'paneEditTg') {
      v2Sectionise(pane, (kid) => kid.classList?.contains('v2secstart'));
      // Members live under Sharing (for every app); on the Telegram tab the
      // card says so, and the block stays out of the way.
      const mb = $('tgMembersBlock');
      if (mb) mb.hidden = !$('v2Pane').querySelector('[data-v2slot="tgMembersBlock"]');
    }
  }
  for (const [blockId] of V2_MOVED) {
    const blockSlot = $('v2Pane').querySelector(`[data-v2slot="${blockId}"]`);
    if (!blockSlot) continue;
    $(blockId).hidden = false;
    blockSlot.append($(blockId));
    if (blockId === 'tgMembersBlock') void renderEditMembers();
    // Filled with its forms (prepareEdit), and again only for another agent's list or a pin changed
    // elsewhere (Bulk actions, another page): the menu's baseline (its fill or its last save) is not
    // the agent's pin, and nothing else is chosen. Placed on another tab of this agent, an image
    // chosen and not pinned yet stays, unsaved, and the images are not read again.
    if (blockId === 'imagePinRow' && !refilled) {
      const sel = $('editImage'), pick = sel?.dataset, shown = sel ? v2SheetNotes.get(sel) : undefined;
      const moved = shown !== undefined && sel.value === shown && shown !== (a.image ?? '');
      // Loading for this agent: the load under way fills it.
      if (pick && (pick.agent !== String(a.id) || (moved && !pick.loading))) void populateImagePicker(a.image ?? '');
    }
    // The runtime menus by the image's rule: refilled with their forms; on another tab of this
    // agent, a choice not saved yet stays (and counts as unsaved), the rest follows the record.
    if (blockId === 'embedModeRow') {
      if (refilled || !v2KeepsChoice('editEmbedMode', a.embedMode || 'baked')) sheetFill(['editEmbedMode'], () => { $('editEmbedMode').value = a.embedMode || 'baked'; });
      $('embedModeStatus').textContent = embedModeText(a);
    }
    if (blockId === 'memoryCapRow') fillMemoryCapRow(a, !refilled);
  }
  $('v2Pane').append($('editErr'));
  if ($('v2BrowserState')) void v2LoadBrowser(a.id);
  if (list.some(([p]) => p === 'paneEditConn')) void renderConnections();
  if (list.some(([p]) => p === 'paneEditPeers')) void loadPeers();
}

function openV2Agent(id, tab) {
  const a = v2Find(id); if (!a) return;
  if (skillsOpening && (skillsOpening.id !== id || (tab && tab !== 'advanced') || !v2Mine(a) || a.ops)) v2SkillsClose();
  if (v2AgentId !== id) v2Tab = 'overview';
  v2AgentId = id;
  if (tab) v2Tab = tab;
  v2RenderSheet();
  if (!v2AgentDlg.open) v2AgentDlg.showModal();
}
function v2Close() { v2SkillsClose(); v2ParkPanes(); if (v2AgentDlg.open) v2AgentDlg.close(); }
function v2RenderSheetBar() {
  const a = v2Find(v2AgentId);
  if (!a) { v2Close(); return; }
  if (skillsOpening && !v2SkillsOwner(skillsOpening.id)) v2SkillsClose();
  if (skillsOpening) v2SkillsSyncAvailability(skillsOpening);
  const skillsCard = $('v2Skills');
  if (skillsCard && !v2SkillsOwner(skillsCard.dataset.agent)) skillsCard.textContent = '';
  const st = v2Status(a);
  const chat = v2CanChat(a) && window.isSecureContext;
  $('v2AgentBar').className = `v2sbar v2st-${st.cls}`;
  // The icon is a real button (Enter and Space both work; it was a span, 2026-10-09).
  // ‹ Back first: a phone's way home (CSS shows it there and hides the ✕).
  $('v2AgentBar').innerHTML = `<button type="button" class="v2pback v2sback" ${onAction('click', 'v2Close')} aria-label="Back to all agents" title="Back to all agents">${V2_BACK_SVG}</button>${v2Mine(a) ? `<button type="button" class="v2iconbtn" title="Change its icon" aria-label="Change its icon" ${onAction('click', 'openV2Icon', [`${a.id ?? ''}`])}>${v2IconHTML(a, st)}</button>` : v2IconHTML(a, st)}
    <div class="v2ttl"><b id="v2AgentName">${esc(a.name)}</b>${!v2Mine(a) ? '<span>shared with you</span>' : ''}</div>
    <span class="v2pill ${v2PillCls(st)}"${st.why.length ? ` title="${esc(st.why.join(' · '))}"` : ''}>${st.glyph || '●'} ${esc(st.label)}</span>
    ${/* Lifecycle buttons are the owner's: the server answers a member 404 (review, 2026-10-09). */ ''}
    ${v2Mine(a) && a.state === 'STOPPED' && a.hibernatedAt ? `<button class="primary" ${onAction('click', 'act', [`${a.id ?? ''}`, "wake"])} aria-label="Wake" title="Start it now — a Telegram message, opening its console or an ask would too">💤<span class="v2bw"> Wake</span></button>` : ''}
    ${v2Mine(a) && a.state === 'STOPPED' && !a.hibernatedAt ? `<button ${onAction('click', 'act', [`${a.id ?? ''}`, "start"])}>Start</button>` : ''}
    ${a.state === 'RUNNING' && v2Mine(a) && !a.ops && !v2ChannelKinds(a).some(k => k !== 'telegram') ? `<button ${onAction('click', 'act', [`${a.id ?? ''}`, "hibernate"])} aria-label="Sleep" title="Stop it with its volume kept; it wakes on a Telegram message, its console or an ask">💤<span class="v2bw"> Sleep</span></button>` : ''}
    ${v2Mine(a) && a.state === 'FAILED' ? `<button class="primary" ${onAction('click', 'act', [`${a.id ?? ''}`, "provision"])}>Retry</button>` : ''}
    ${v2Mine(a) && a.state === 'ARCHIVED' ? `<button ${onAction('click', 'openInspect', [`${a.id ?? ''}`, `${a.name ?? ''}`])} aria-label="Inspect">🔍<span class="v2bw"> Inspect</span></button><button ${onAction('click', 'v2Close restoreAgent', [[], [`${a.id ?? ''}`, `${a.name ?? ''}`]])} aria-label="Restore…" title="Bring it back from the archive">📤<span class="v2bw"> Restore…</span></button>` : ''}
    ${chat ? `<button class="primary" ${onAction('click', 'v2Close openGateway', [[], [`${a.id ?? ''}`, `${a.slug ?? ''}`]])} aria-label="Chat" title="Talk to it here">💬<span class="v2bw"> Chat</span></button>` : ''}
    ${!v2Mine(a) && a.webChat && a.state !== 'ARCHIVED' ? `<button class="primary" ${onAction('click', 'v2Close openWebChat', [[], [`${a.id ?? ''}`]])} aria-label="Chat" title="Talk to it here — no chat app needed">💬<span class="v2bw"> Chat</span></button>` : ''}
    <button class="v2sclose" ${onAction('click', 'v2Close')} aria-label="Close">✕</button>`;
}
function v2RenderSheet() {
  const a = v2Find(v2AgentId); if (!a) return v2Close();
  v2RenderSheetBar();
  const tabs = !v2Mine(a) ? [] : a.state === 'ARCHIVED' ? V2_TABS.filter(([k]) => k === 'overview' || k === 'files' || k === 'advanced') : V2_TABS;
  if (tabs.length && !tabs.some(([k]) => k === v2Tab)) v2Tab = 'overview';
  $('v2Tabs').hidden = !tabs.length;
  // A redraw (a tab chosen, a poll) keeps the keyboard where it was: on the same tab or button, by id.
  const was = document.activeElement, focusId = v2AgentDlg.contains(was) && was.id ? was.id : '';
  // Real tabs (2026-10-09): arrow keys between them (v2TabKeys on #v2Tabs), each controlling the pane.
  $('v2Tabs').innerHTML = tabs.map(([k, l]) => `<button role="tab" id="v2tab-${k}" aria-selected="${k === v2Tab}" aria-controls="v2Pane" tabindex="${k === v2Tab ? 0 : -1}" ${onAction('click', 'openV2Agent', [`${a.id ?? ''}`, `${k}`])}>${l}</button>`).join('');
  v2ParkPanes();
  v2SheetSig = v2SheetSigOf(a);
  v2SheetDrawnState = a.state;
  const pane = $('v2Pane');
  if (tabs.length) { pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', `v2tab-${v2Tab}`); }
  else { pane.removeAttribute('role'); pane.removeAttribute('aria-labelledby'); }
  pane.innerHTML = v2Mine(a) ? v2Pane(a, v2Tab) : v2MemberPane(a);
  if (focusId && $(focusId) && document.activeElement !== $(focusId)) $(focusId).focus();
  if (v2Mine(a)) v2EmbedPanes(a, v2Tab);
  const g = $('v2GroupSel'); if (g) g.value = a.group || '';
  if ($('editClass')) void renderClassPicker(a);
  if ($('v2Chans')) void v2LoadChans(a.id);
  if ($('v2UsageBody')) void v2LoadUsage(a.id);
  if ($('v2BudgetRow')) void v2LoadBudgetRow(a.id);
  if ($('v2RecBody')) void loadRecommended(a.id);
  if ($('v2AppRow')) void v2LoadApp(a.id);
  if ($('v2Access')) void v2LoadAccess(a.id);
  if ($('v2RecoveryRow')) void v2PaintRecovery(a.id);
  if ($('v2Voice')) void v2LoadVoice(a.id);
  if ($('v2Skills')) void v2LoadSkills(a.id);
}

// Keep an open sheet current as the poll brings news (a pairing request, a
// finished rebuild), but never repaint a pane someone is typing in.
/** Tabs that load their own content (a volume listing, the channels, the
 *  usage read): repainted only when the agent itself changed, never on a
 *  plain poll — each repaint reloaded them, and an upload lost its progress. */
const V2_SELF_LOADING = { files: 1, channels: 1, slack: 1, usage: 1 };
let v2SheetSig = '';
/** The state the open tab was drawn in. */
let v2SheetDrawnState = null;
/**
 * Each control in the sheet's edit sections with its value as filled or last saved (its
 * baseline): one whose value differs is an unsaved edit. A state redraw fills the edit sections
 * again, so it waits while there is one (HB-0444). Whatever fills a control does it through
 * sheetFill, which notes it as filled (v2SheetBaseline): prepareEdit, prepareCrons and each render
 * or fill helper, and an answer drawn in by its handle's fill (HB-0644). A refill then moves the
 * baseline with it. A control the sheet draws itself (a Telegram token box) is compared with its
 * value as drawn. A save that does not draw its controls again notes what it sent, for the agent
 * it saved (sheetSave: v2SheetSaving). Noted on a first press or focus instead, a value code put
 * in afterwards (a model menu drawn for a class, a connection attached) read as an edit for good,
 * and the tab never redrew again (HB-0475).
 */
let v2SheetNotes = new Map();
const V2_CONTROLS = 'input, select, textarea';
const v2CtlValue = (el) => el.type === 'checkbox' || el.type === 'radio' ? String(el.checked)
  : el.multiple ? [...el.selectedOptions].map(o => o.value).join('\n') : el.value;
/** As the page drew it: what a control holds before anyone changes it. */
const v2CtlDrawn = (el) => el.type === 'checkbox' || el.type === 'radio' ? String(el.defaultChecked)
  : el.tagName === 'SELECT' ? ([...el.options].filter(o => o.defaultSelected).map(o => o.value).join('\n') || (el.multiple ? '' : el.options[0]?.value ?? ''))
  : el.defaultValue;
/** The edit sections the sheet borrows, and the blocks it moves: what prepareEdit fills. */
const V2_SHEET_FORMS = ['paneDef', 'paneEditSnap', 'paneEditAi', 'paneEditData', 'paneEditConn', 'paneEditTg', 'paneEditPeers', 'paneEditEnv',
  'tgMembersBlock', 'imagePinRow', 'embedModeRow', 'memoryCapRow'];
/** The controls in `where`: ids or elements, of controls or of what holds them. A task's own switches are not edits. */
/**
 * A control whose value is an edit of the sheet's: not one whose change saves it (marked
 * data-saves: Group, Class, Browser, Who can reach it, the task triggers switch…), nor a
 * task's own switches in the list. The one rule for what is baselined (v2SheetControlsOf)
 * and what a person's change counts (v2SheetCounts).
 */
const v2SheetEdits = (el) => !el.hasAttribute('data-saves') && !el.closest('#cronList');
const v2SheetControlsOf = (where) => where.flatMap(w => { const el = typeof w === 'string' ? $(w) : w; return !el ? [] : el.matches(V2_CONTROLS) ? [el] : [...el.querySelectorAll(V2_CONTROLS)]; })
  .filter(v2SheetEdits);
/** Each control's fills, counted (v2SheetBaseline): its form revision (HB-0644). A save's values are its baseline only while no fill came after the press. */
const v2SheetFills = new WeakMap();
/**
 * A menu the sheet fills from the record on a tab drawn again: whether a choice in it is not
 * saved yet (not its baseline, the value of its fill or its last save) and is not what the
 * record holds now. That one stays, and counts as unsaved; otherwise the menu is filled again.
 */
function v2KeepsChoice(id, record) {
  const el = $(id), note = el ? v2SheetNotes.get(el) : undefined;
  return note !== undefined && el.value !== note && el.value !== record;
}
/** What `where` holds now is as filled. Only sheetFill calls it (scripts/sheet-state.mjs), for whatever just filled it. */
function v2SheetBaseline(...where) {
  for (const el of v2SheetControlsOf(where)) { v2SheetNotes.set(el, v2CtlValue(el)); v2SheetFills.set(el, (v2SheetFills.get(el) || 0) + 1); }
}
/**
 * Before a save sends them: what `where` holds now. Call what it returns with the agent saved,
 * once it is: those values become the baseline, when the forms are still that agent's and
 * each control is as it was at the press. Refilled meanwhile (the sheet closed and opened
 * again, or another agent and back), it shows what the fill put there: the sent value noted
 * under it held the redraw for good, and a later press sent the old value.
 * Only sheetSave calls it: `const f = sheetSave('editDesc'); … f.saved();`. Not for a save
 * whose success draws its controls again: that drawing notes them.
 */
function v2SheetSaving(...where) {
  const sent = v2SheetControlsOf(where).map(el => [el, v2CtlValue(el), v2SheetFills.get(el) || 0]);
  return (forId) => {
    if (editAgentId !== forId || (v2AgentId && v2AgentId !== forId)) return;
    for (const [el, value, fills] of sent) if ((v2SheetFills.get(el) || 0) === fills) v2SheetNotes.set(el, value);
  };
}
function v2SheetUnsaved() {
  // Controls drawn over since (their tab's HTML replaced) are gone: their notes go with them. The
  // one place they go while the sheet is open (not at each fill); closing it lets all of them go.
  for (const el of v2SheetNotes.keys()) if (!el.isConnected) v2SheetNotes.delete(el);
  // Edit on a task fills its form with a press: its Save is armed until saved or cancelled. A
  // redraw of the Schedule tab starts the form afresh, so it counts while the form is in the sheet.
  if (cronEditingId && $('v2Pane').contains($('cronBody'))) return true;
  // Setup fields added or removed with a press, not saved yet, in the forms filled for this sheet
  // (not left from an agent shown before, which its next fill replaces).
  if (v2EditFor && v2EditFor === editAgentId && JSON.stringify(editParams) !== editParamsSaved) return true;
  for (const [el, note] of v2SheetNotes) if (v2CtlValue(el) !== note) return true;
  return false;
}
const v2SheetSigOf = (a) => JSON.stringify([a.id, a.state, a.hibernatedAt ?? null, a.runtimeRef ?? null, a.botUsername ?? null, a.otherChannels ?? [], pairings[a.id] ?? []]);
function v2RefreshSheet() {
  if (!v2AgentDlg.open) return;
  const pane = $('v2Pane');
  const a = v2Find(v2AgentId);
  const same = V2_SELF_LOADING[v2Tab] && a && v2Mine(a) && v2SheetSigOf(a) === v2SheetSig;
  // A tab of edit sections was drawn for one state: "It is stopped — start it" stayed
  // after Start from the bar. Redrawn, and its forms filled again, unless the person
  // has an edit in them or a field in use: then the next poll asks again (HB-0444).
  if (V2_EMBED[v2Tab] && a && a.state !== v2SheetDrawnState && !v2SheetUnsaved() && !(pane.contains(document.activeElement) && document.activeElement.matches('input, textarea, select'))) {
    const top = pane.scrollTop;
    v2EditFor = null;
    v2RenderSheet();
    pane.scrollTop = top;
    return;
  }
  // Tabs holding the edit sections manage their own state; only repaint the bar.
  const busy = V2_EMBED[v2Tab] || same || pane.querySelector('#healthDlgBody') || [...pane.querySelectorAll('input, textarea, select')].some(i => (i.value && i.tagName !== 'SELECT') || i === document.activeElement);
  if (busy) v2RenderSheetBar(); else { const top = pane.scrollTop; v2RenderSheet(); pane.scrollTop = top; }
}
// The close event arrives a task later: reopened by then (close one agent,
// open the next), it must not clear the agent now showing — that left the
// sheet deaf to updates and its Usage tab on "Loading…" (2026-09-29).
v2AgentDlg.addEventListener('close', () => { if (v2AgentDlg.open) return; v2ParkPanes(); endCronEdit(); v2AgentId = null; v2EditFor = null; v2NotesFor = null; v2SheetNotes.clear(); });
// Only a person's change fires these; a form being filled does not. Counted by v2SheetEdits: one
// whose change only shows or hides others (Group chats, the room picker) counts, its Save being a
// separate press, so having an onchange says nothing.
const v2SheetCounts = (el) => !!el?.matches?.(V2_CONTROLS) && v2SheetEdits(el);
// One with no baseline (drawn by the sheet itself): compared with its value as drawn.
for (const ev of ['input', 'change']) $('v2Pane').addEventListener(ev, (e) => {
  if (v2SheetCounts(e.target) && !v2SheetNotes.has(e.target)) v2SheetNotes.set(e.target, v2CtlDrawn(e.target));
});

// ---- Apps in agents (docs/apps-in-agents.md): the agent page's App row ----------------
/** Which app it runs and from where, with Update, Roll back and Stop app (the machine's owner only). */
// The page redraws on every refresh; what the app is changes only when someone acts, so a
// reading is reused for 30 s (an action below reloads it).
let v2AppCache = null;
async function v2LoadApp(id, fresh = false) {
  let r = !fresh && v2AppCache && v2AppCache.id === id && Date.now() - v2AppCache.at < 30_000 ? v2AppCache.r : null;
  if (!r) {
    try { r = await api(`/v1/agents/${id}/app`); } catch (e) {
      // The re-read after an action: say so, or the row kept its pressed,
      // disabled "Updating…" until the sheet was reopened (audit 2026-10-23, B20).
      const el = $('v2AppRow');
      if (fresh && el && v2AgentId === id) {
        el.innerHTML = `<div class="v2row"><div class="v2k">App</div><div class="v2v"><span class="sub">Couldn't read its app: ${esc(e.message)}</span><button ${onAction('click', 'v2LoadApp', [`${id ?? ''}`, true])}>Read again</button></div></div>`;
      }
      return;
    }
    v2AppCache = { id, at: Date.now(), r };
  }
  const el = $('v2AppRow'); if (!el || v2AgentId !== id) return;
  const a = v2Find(id); if (!a) return;
  const run = a.state === 'RUNNING', can = !!r.canChange;
  const B = (label, call, extra = '') => `<button ${call} ${extra}>${label}</button>`;
  const row = (v) => `<div class="v2row"><div class="v2k">App</div><div class="v2v">${v}<div id="v2AppOut" hidden style="flex-basis:100%"></div></div></div>`;
  if (r.app) {
    const p = r.app;
    const test = p.testOk === true ? 'its tests passed' : p.testOk === false ? 'its tests failed' : '';
    el.innerHTML = row(`<span><b>${esc(p.name)}</b> · <code>${esc(String(p.sha).slice(0, 12))}</code>
        <span class="sub">from ${esc(p.source)}${p.ref && p.ref !== 'HEAD' ? ` (${esc(p.ref)})` : ''}${test ? ` · ${test}` : ''} · installed ${esc(ago(p.installedAt))}</span></span>
      ${can && run ? B('⬆ Update', onAction('click', 'v2AppUpdate', [`${id}`, { $: 'el' }]), 'class="primary" id="v2AppUpdateBtn" title="Install the newest commit from where it came; its tests run first, and the running version stays if they fail"') : ''}
      ${can && run && p.previousSha ? B('↩ Roll back', onAction('click', 'v2AppRollback', [`${id}`, { $: 'el' }]), `title="Back to ${esc(String(p.previousSha).slice(0, 12))}"`) : ''}
      ${can && run ? B('Stop app', onAction('click', 'v2AppRemove', [`${id}`, `${p.name ?? ''}`, { $: 'el' }]), 'title="Remove its scheduled commands; its code and data stay in the agent"') : ''}
      <span class="sub">Runs on a schedule inside this agent: ${p.tasks.map(esc).join(', ') || 'no tasks'}.</span>`);
  } else if (r.pending) {
    el.innerHTML = row(r.pending.error
      ? `<span>⚠ Its app could not be installed.</span>${can ? B('Try again', onAction('click', 'v2AppRetry', [`${id}`, { $: 'el' }])) : ''}<pre class="sub" style="white-space:pre-wrap;flex-basis:100%;max-height:220px;overflow:auto;margin:6px 0 0">${esc(r.pending.error)}</pre>`
      : `<span>Installing its app from ${esc(r.pending.source)} once it is running…</span>`);
  } else if (can && run && !a.ops) {
    el.innerHTML = row(`<span class="sub">None. A program from a repo can run in it on a schedule, using the AI only where it has to.</span>${B('Run an app from a repo…', onAction('click', 'openAppDlg', ["install", `${id}`]))}`);
  } else el.innerHTML = '';
}
function v2AppShow(text) { const o = $('v2AppOut'); if (o) { o.hidden = false; o.innerHTML = `<pre class="sub" style="white-space:pre-wrap;max-height:260px;overflow:auto;margin:6px 0 0">${esc(text)}</pre>`; } }
async function v2AppUpdate(id, btn, values) {
  // The sheet it was pressed in. Another agent's may be open by the time it answers: what
  // it says then goes in a toast with the agent's name, and its form for values stays out
  // of that sheet, where they were entered for this agent's update (HB-0587).
  // Here: its sheet, with the App row on screen (its Overview), where a value it needs is asked for.
  const here = () => v2AgentDlg.open && v2AgentId === id && !!$('v2AppOut');
  const name = agents.find(x => x.id === id)?.name || 'The agent';
  btn.disabled = true; btn.textContent = 'Updating… (tests first)';
  toast('Updating its app: fetching the newest commit and running its tests…', 60000, 'progress');
  try {
    const r = await api(`/v1/agents/${id}/app/update`, { method: 'POST', body: values ? { values } : {} });
    // "Its tests passed" only when it has tests and they ran (a manifest without any answers test: null).
    toast(agentPrefix(id) + (r.unchanged ? 'Already running the newest commit.' : r.refreshed?.length ? `Same commit; settings Hatchabot fills are up to date again: ${r.refreshed.join(', ')}.` : `Updated to ${String(r.app.sha).slice(0, 12)}${r.test?.ok ? ' — its tests passed.' : ' (it has no tests to run).'}`));
  } catch (e) {
    btn.disabled = false; btn.textContent = '⬆ Update';
    // A value it needs and has not got (a field made required, or one an older
    // version left blank): asked for here, since Update sends none (final
    // audit, 2026-10-22). Nothing changed.
    if (Array.isArray(e.data?.needs) && e.data.needs.length) {
      // Away from its App row (another agent, or its own sheet on another tab): said with its name, both ways.
      if (!here()) { toast(`${name}'s app was not updated: it needs a value first. Give it on its Overview, under App, and press Update again.`, 10000); return; }
      toast('Not updated: it needs a value first (below).', 8000);
      v2AppAskValues(id, e.data.needs);
      return;
    }
    if (!here()) { toast(`${name}'s app was not updated. ${e.message}`, 10000); if (e.data?.held) void refresh(false); return; }
    // Only the server knows how it left the agent: "unchanged" when it says so,
    // held when putting it back failed (its choice is on this page), else unknown.
    toast(e.data?.held ? 'Not updated, and it could not be put back as it was: choose how to finish it on this page.'
      : e.data?.unchanged ? 'Not updated — the running version is unchanged.'
      : 'Not updated — it may not be as it was; read what it says below.', 10000);
    const said = e.message + (e.data?.test?.output && !e.message.includes(e.data.test.output.slice(-200)) ? '\n\n' + e.data.test.output : '');
    v2AppShow(said);
    // Held: the page redraws with the operation's choices, and the message again under them.
    if (e.data?.held) void refresh(false).then(() => { if (here()) v2AppShow(said); });
    return;
  }
  void v2LoadApp(id, true);
}
/** The values an update needs, asked for under the app's row; Update with them sends them. */
function v2AppAskValues(id, needs) {
  const o = $('v2AppOut'); if (!o) return;
  const box = (f) => {
    const fid = esc('v2AppV_' + f.key); // a manifest's key is the app author's text
    const label = `<label for="${fid}">${esc(f.key)}${f.label ? ` <span class="sub">— ${esc(f.label)}</span>` : ''}</label>`;
    if (f.type === 'bool') return `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="${fid}" style="width:auto"> ${esc(f.key)}${f.label ? ` <span class="sub">— ${esc(f.label)}</span>` : ''}</label>`;
    if (f.secret) return label + `<input type="password" id="${fid}" autocomplete="new-password" spellcheck="false" value="">`;
    return label + `<input type="${f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}" id="${fid}" value="">`;
  };
  v2AppNeeds = needs;
  o.hidden = false;
  o.innerHTML = `<div class="sub" style="margin:6px 0">Its new release needs ${needs.length === 1 ? 'a value' : 'values'} the app does not have yet. Fill ${needs.length === 1 ? 'it' : 'them'} in, then update:</div>
    ${needs.map(box).join('')}
    <div id="v2AppValErr" class="err"></div>
    <div style="margin-top:8px"><button class="primary" id="v2AppUpdateWithBtn" ${onAction('click', 'v2AppUpdateWith', [`${id ?? ''}`, { $: 'el' }])}>⬆ Update with these</button></div>`;
}
let v2AppNeeds = [];
function v2AppUpdateWith(id, btn) {
  const values = {};
  for (const f of v2AppNeeds) {
    const el = $('v2AppV_' + f.key); if (!el) continue;
    if (f.type === 'bool') values[f.key] = el.checked ? 'true' : 'false';
    else if (f.secret) { if (el.value) values[f.key] = el.value; }
    else values[f.key] = el.value.trim();
  }
  const empty = v2AppNeeds.filter(f => f.type !== 'bool' && !values[f.key]).map(f => f.key);
  if (empty.length) { $('v2AppValErr').textContent = `Fill in: ${empty.join(', ')}.`; return; }
  return v2AppUpdate(id, btn, values);
}
async function v2AppRollback(id, btn) {
  if (!confirm('Go back to the release before the last install or update?')) return;
  btn.disabled = true;
  try { const r = await api(`/v1/agents/${id}/app/rollback`, { method: 'POST', body: {} }); toast(`Back on ${String(r.app.sha).slice(0, 12)}.`); }
  catch (e) { toast(e.message, 10000); }
  void v2LoadApp(id, true);
}
async function v2AppRemove(id, name, btn) {
  if (!confirm(`Stop ${name}? Its scheduled commands are removed; its code and data stay in the agent, and Run an app from a repo brings it back.`)) return;
  btn.disabled = true;
  try { const r = await api(`/v1/agents/${id}/app`, { method: 'DELETE' }); toast(`${name} stopped (${r.tasks} scheduled command${r.tasks === 1 ? '' : 's'} removed).`); }
  catch (e) { toast(e.message, 10000); }
  void v2LoadApp(id, true);
}
async function v2AppRetry(id, btn) {
  btn.disabled = true;
  try { await api(`/v1/agents/${id}/app/pending`, { method: 'POST', body: {} }); toast('Trying the install again — its tests run first.', 8000); }
  catch (e) { toast(e.message, 10000); }
  setTimeout(() => void v2LoadApp(id, true), 1500);
}

// ---- Run an app from a repo: a new agent, or into an existing one -----------------------------
let appDlgMode = 'create', appDlgAgent = null, appInspected = null, appConns = [];
// Each opening of the dialog, and each read of a repo in it: an answer for an
// earlier one lands nowhere (HB-0351), and an Install press finishes for the
// agent and repo it was pressed for (HB-0283).
let appDlgGen = 0, appReadGen = 0;
function openAppDlg(mode, agentId) {
  appDlgMode = mode; appDlgAgent = agentId || null; appInspected = null;
  appDlgGen++; appReadGen++;
  const a = agentId ? v2Find(agentId) : null;
  $('appDlgTitle').textContent = mode === 'create' ? 'New agent from a repo' : `Run an app in ${a?.name || 'this agent'}`;
  $('appSource').value = ''; $('appInfo').innerHTML = ''; $('appForm').innerHTML = ''; $('appErr').textContent = '';
  $('appOut').hidden = true; $('appGoBtn').disabled = true; $('appReadBtn').disabled = false;
  $('appGoBtn').textContent = mode === 'create' ? 'Create' : 'Install';
  appDlg.showModal();
  $('appSource').focus();
}
async function appRead() {
  const source = $('appSource').value.trim();
  if (!source) { $('appErr').textContent = 'Give a folder on this machine (~/myapp) or a git address.'; return; }
  const gen = ++appReadGen;
  $('appErr').textContent = ''; $('appReadBtn').disabled = true; $('appInfo').innerHTML = '<div class="sub">Reading it…</div>';
  // The repo read before is forgotten first: a read that fails left Install
  // pointing at it, with its form still shown (#96).
  appInspected = null; $('appGoBtn').disabled = true; $('appForm').innerHTML = ''; $('appOut').hidden = true;
  try {
    const r = await api('/v1/apps/inspect', { method: 'POST', body: { source } });
    const needGoogle = (r.connections || []).find(c => c.kind === 'google');
    let conns = [];
    if (needGoogle) { try { conns = ((await api('/v1/connections')).connections || []).filter(c => c.kind === 'google'); } catch { conns = []; } }
    if (gen !== appReadGen) return; // the dialog was opened again, or another repo read, while this one was read
    appInspected = { ...r, source };
    appConns = conns;
    const m = r.manifest;
    $('appInfo').innerHTML = `<div style="margin-top:10px"><b>${esc(m.name)}</b> <code>${esc(String(r.sha).slice(0, 12))}</code>
      ${m.description ? `<div class="sub">${esc(m.description)}</div>` : ''}
      <div class="sub">Runs on a schedule: ${(m.tasks || []).map(t => `${esc(t.name)} (every ${esc(t.every || t.cron)})`).join(', ') || 'nothing'}${m.test ? ' · its tests run in the agent before it goes live' : ''}${m.model ? ` · chat model ${esc(m.model)}` : ''}</div>
      ${(r.connections || []).filter(c => c.kind !== 'google').map(c => `<div class="sub" style="color:var(--warn)">Needs a ${esc(c.kind)} connection for ${esc(c.purpose)}: attach it in the agent's settings (Knowledge → Connections).</div>`).join('')}</div>`;
    const field = (f) => {
      const id = esc('appF_' + f.key); // a manifest's key is the app author's text (review, 2026-10-09)
      const label = `<label for="${id}">${esc(f.key)}${f.required ? ' <span style="color:var(--warn)">*</span>' : ''}${f.label ? ` <span class="sub">— ${esc(f.label)}</span>` : ''}</label>`;
      // On as the server reads the default (mergeConfig): "false", "off", "no" and "0" are off, not truthy strings (HB-0352).
      const on = f.default === true || (typeof f.default === 'string' && /^(1|true|yes|on)$/i.test(f.default.trim()));
      if (f.type === 'bool') return `<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="${id}" style="width:auto" ${on ? 'checked' : ''}> ${esc(f.key)}${f.label ? ` <span class="sub">— ${esc(f.label)}</span>` : ''}</label>`;
      // A secret (an app password, a key) is typed into a hidden box, never
      // filled in and never offered by the browser's autofill; left blank, the
      // app keeps the one it has (or its default). It was a plain text box.
      if (f.secret) return label + `<input type="password" id="${id}" autocomplete="new-password" spellcheck="false" value=""${f.default !== undefined ? ' placeholder="leave blank to keep the default"' : ''}>`;
      const v = Array.isArray(f.default) ? f.default.join(', ') : f.default ?? '';
      return label + `<input type="${f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}" id="${id}" value="${esc(String(v))}">`;
    };
    const local = hosts.find(h => h.kind === 'local') || hosts[0];
    const connPicker = needGoogle ? `<label for="appConn">Google account <span class="sub">— ${esc(needGoogle.purpose)}</span></label>
      <select id="appConn" ${onAction('change', 'appConnPicked')}><option value="">None yet (attach one later in its settings)</option>
        ${appConns.map(c => `<option value="${esc(c.id)}">${esc(c.email)}</option>`).join('')}</select>
      ${appConns.length ? '' : '<div class="sub">No Google account is connected yet: add one in ⚙ Settings → Connections, then come back.</div>'}
      <div id="appConnWarn" class="sub" hidden></div>` : '';
    $('appForm').innerHTML = connPicker + (appDlgMode === 'create' ? `<label for="appName">Name</label><input type="text" id="appName" maxlength="64" value="${esc(m.name)}">
      ${profiles.length > 1 ? `<label for="appProfile">AI source</label><select id="appProfile">${profiles.map(p => `<option value="${p.id}"${p.defaultSource ? ' selected' : ''}>${sourceOptionLabel(p)}</option>`).join('')}</select>` : ''}
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px"><input type="checkbox" id="appTelegram" style="width:auto"> Use Telegram — reach it from your phone too, not only here in Hatchabot</label>
      ${local ? '' : '<div class="err">No host is configured.</div>'}` : '') + (r.ask || []).map(field).join('');
    $('appGoBtn').disabled = false;
    // A field that names the account (e.g. the mailbox) picks it, and the other way round.
    const linked = needGoogle?.field && $('appF_' + needGoogle.field);
    if (linked) {
      const hit = appConns.find(c => c.email.toLowerCase() === linked.value.trim().toLowerCase());
      if (hit) $('appConn').value = hit.id;
      linked.addEventListener('change', () => { const h = appConns.find(c => c.email.toLowerCase() === linked.value.trim().toLowerCase()); if (h) { $('appConn').value = h.id; appConnPicked(); } });
    }
    if (needGoogle) appConnPicked();
  } catch (e) { if (gen === appReadGen) { $('appInfo').innerHTML = ''; $('appErr').textContent = e.message; } }
  finally { if (gen === appReadGen) $('appReadBtn').disabled = false; }
}
/** The account picked: fill the field that names it, and say who else runs this app on it. */
function appConnPicked() {
  const c = appConns.find(x => x.id === $('appConn')?.value);
  const g = (appInspected?.connections || []).find(x => x.kind === 'google');
  const f = g?.field && $('appF_' + g.field);
  // The account picked is the one the app uses: its field follows every
  // pick, not only the first (picking B after A left A in the mailbox, and
  // the agent was attached to B while the app read A).
  if (c && f) f.value = c.email;
  const others = c ? (c.attachedTo || []).filter(x => x.id !== appDlgAgent && x.state !== 'ARCHIVED' && x.state !== 'DELETED') : [];
  const same = others.filter(x => x.app && x.app === appInspected?.manifest?.app);
  const el = $('appConnWarn'); if (!el) return;
  el.hidden = !others.length;
  el.style.color = same.length ? 'var(--warn)' : '';
  el.innerHTML = same.length
    ? `⚠ ${same.map(x => esc(x.name)).join(' and ')} already run${same.length > 1 ? '' : 's'} ${esc(appInspected.manifest.name)} on this account. Two copies both answer every email: stop the app there first (its page → App → Stop app), or pick another account.`
    : others.length ? `Also used by ${others.map(x => esc(x.name)).join(', ')}.` : '';
}
/** The field that names the account and the account picked disagree (the field was typed after the pick)? Say so. */
function appConnMismatch() {
  const c = appConns.find(x => x.id === $('appConn')?.value);
  const g = (appInspected?.connections || []).find(x => x.kind === 'google');
  const f = g?.field && $('appF_' + g.field);
  if (!c || !f || f.value.trim().toLowerCase() === c.email.toLowerCase()) return '';
  return `${g.field} says ${f.value.trim() || 'nothing'}, but the Google account picked is ${c.email}: pick the account that matches, or change ${g.field}.`;
}
/** Two copies of this app on the account picked? Asked once, before anything is made. */
function appSharedOk() {
  const c = appConns.find(x => x.id === $('appConn')?.value);
  const same = c ? (c.attachedTo || []).filter(x => x.id !== appDlgAgent && x.state !== 'ARCHIVED' && x.state !== 'DELETED' && x.app === appInspected?.manifest?.app) : [];
  if (!same.length) return { ok: true, allowShared: false };
  return { ok: confirm(`${same.map(x => x.name).join(' and ')} already run${same.length > 1 ? '' : 's'} ${appInspected.manifest.name} on ${c.email}. Both would answer every email. Install it here anyway?`), allowShared: true };
}
/**
 * The Google account attach answered: did it go on (and, for an agent that
 * runs, work in it)? Its 200 can say it failed; the app was installed and
 * "running" with no login all the same (HB-0257). `email` is the account's,
 * as it was when Install was pressed (the dialog may show another by now).
 */
function appAttachProblem(r, mustBeLive, email = 'The Google account') {
  if (r?.attached === false) return `${email} was not attached${r.error ? ` (${r.error})` : ''}, so nothing was installed. Try again.`;
  if (r?.error || (mustBeLive && !r?.live)) return `${email} is attached, but could not be set up in the agent${r?.error ? ` (${r.error})` : ''}, so the app was not installed: its commands would have no login. Try again; if it fails again, connect the account again in ⚙ Settings → Connections.`;
  return '';
}
function appValues() {
  const out = {};
  for (const f of appInspected?.ask || []) {
    const el = $('appF_' + f.key); if (!el) continue;
    // A secret is sent as typed (no trim: it may matter), and only when typed.
    if (f.secret) { if (el.value) out[f.key] = el.value; continue; }
    out[f.key] = f.type === 'bool' ? (el.checked ? 'true' : 'false') : el.value.trim();
  }
  return out;
}
async function appGo() {
  if (!appInspected) return;
  // What this press acts on, as it was pressed: the dialog can be closed and
  // opened on another agent, or another repo read, while the account attaches
  // or the app installs; the rest went to them (HB-0283). Closed, or opened
  // again, it is not this press's dialog: a failure is said in the toast.
  const insp = appInspected, mode = appDlgMode, agentId = appDlgAgent, gen = appDlgGen;
  const here = () => gen === appDlgGen && appDlg.open;
  const values = appValues();
  // A blank secret keeps the default, or in an agent that has the app the one
  // it has (the box is never filled in): the server says if there is none.
  const missing = (insp.ask || []).filter(f => f.required && !values[f.key] && !(f.secret && (f.default !== undefined || mode !== 'create'))).map(f => f.key);
  if (missing.length) { $('appErr').textContent = `Fill in: ${missing.join(', ')}.`; return; }
  const mismatch = appConnMismatch();
  if (mismatch) { $('appErr').textContent = mismatch; return; }
  const m = insp.manifest;
  const shared = appSharedOk(); if (!shared.ok) return;
  const connId = $('appConn')?.value || '';
  const connEmail = appConns.find(c => c.id === connId)?.email;
  const form = mode === 'create' ? { name: $('appName').value.trim() || m.name, profile: ($('appProfile') && $('appProfile').value) || profiles[0]?.id, telegram: $('appTelegram').checked } : null;
  $('appGoBtn').disabled = true; $('appErr').textContent = ''; $('appOut').hidden = true;
  let created = null;
  try {
    if (mode === 'create') {
      const { name } = form;
      const local = hosts.find(h => h.kind === 'local') || hosts[0];
      // Its chat with {app_dir}, {agent}… filled in for this agent, as its tasks are: they reached SOUL.md as written (HB-0259).
      let chat = m.chat;
      if (chat && /\{(app_dir|data_dir|agent|name|env)\}/.test(chat)) chat = (await api('/v1/apps/inspect', { method: 'POST', body: { source: insp.source, name } })).chat ?? chat;
      const a = created = await api('/v1/agents', { method: 'POST', body: { name, persona: chat || m.description || undefined,
        aiProfileId: form.profile, hostId: local?.id,
        telegram: form.telegram } });
      if (m.model) { try { await api(`/v1/agents/${a.id}/model`, { method: 'POST', body: { model: m.model } }); } catch { /* the source's default stays */ } }
      // Its account goes on before it first runs (it is materialized as the agent comes up).
      if (connId) { const problem = appAttachProblem(await api(`/v1/agents/${a.id}/connections/attach`, { method: 'POST', body: { connectionId: connId } }), false, connEmail); if (problem) throw new Error(problem); }
      await api(`/v1/agents/${a.id}/app/pending`, { method: 'POST', body: { source: insp.source, values, ...(shared.allowShared ? { allowShared: true } : {}) } });
      created = null; // made whole: nothing below undoes it
      if (here()) appDlg.close();
      toast(`Creating "${name}" — ${m.name} installs as soon as it is running (its tests run first).`, 12000);
      await refresh(false);
    } else {
      toast(`Installing ${m.name}: copying it in, running its tests, scheduling it…`, 120000, 'progress');
      if (connId) { const problem = appAttachProblem(await api(`/v1/agents/${agentId}/connections/attach`, { method: 'POST', body: { connectionId: connId } }), true, connEmail); if (problem) throw new Error(problem); }
      await api(`/v1/agents/${agentId}/app`, { method: 'POST', body: { source: insp.source, values, ...(shared.allowShared ? { allowShared: true } : {}) } });
      if (here()) appDlg.close();
      toast(`${m.name} is installed and running.`);
      if (v2AgentId === agentId) void v2LoadApp(agentId, true);
    }
  } catch (e) {
    // A half-made agent holds the name, so Create again said "name taken":
    // remove it, as doAdopt does (review, 2026-10-09).
    if (created) { try { await api(`/v1/agents/${created.id}`, { method: 'DELETE' }); } catch {} void refresh(false); }
    toast(here() ? 'Not installed.' : `${m.name} was not installed: ${e.message.split('\n')[0]}`, here() ? 6000 : 12000);
    if (!here()) return;
    $('appErr').textContent = e.message.split('\n')[0];
    if (e.data?.test?.output) { $('appOut').hidden = false; $('appOut').textContent = e.data.test.output; }
    else if (e.message.includes('\n')) { $('appOut').hidden = false; $('appOut').textContent = e.message; }
  } finally { if (here()) $('appGoBtn').disabled = false; }
}
/** The Usage tab: the same page as ⋯ → Usage, inline. A read runs node in the
 *  container, so a sheet re-render within a minute reuses the last one. */
let v2UsageCache = null;
async function v2LoadUsage(id) {
  const fresh = v2UsageCache && v2UsageCache.id === id && Date.now() - v2UsageCache.at < 60_000;
  if (fresh) { $('v2UsageBody').innerHTML = v2UsageCache.html; void loadSpendCharts($('v2UsageBody')); return; }
  try {
    const u = await api(`/v1/agents/${id}/usage`);
    const html = usageHTML(u, id);
    v2UsageCache = { id, at: Date.now(), html };
    if ($('v2UsageBody') && v2AgentId === id) { $('v2UsageBody').innerHTML = html; void loadSpendCharts($('v2UsageBody')); }
  } catch (e) { if ($('v2UsageBody') && v2AgentId === id) $('v2UsageBody').innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}

/** The Files tab: browse the agent's home (read-only), download a file or a folder. */
const v2FilesPath = new Map();
/** How the list is ordered: by name, by when changed, or by size; remembered on this device. */
let v2FilesSort = (() => { try { return JSON.parse(localStorage.getItem('hb-files-sort') || 'null') || { key: 'name', dir: 1 }; } catch { return { key: 'name', dir: 1 }; } })();
function v2FilesSortBy(id, key) {
  v2FilesSort = v2FilesSort.key === key ? { key, dir: -v2FilesSort.dir } : { key, dir: key === 'name' ? 1 : -1 };
  try { localStorage.setItem('hb-files-sort', JSON.stringify(v2FilesSort)); } catch {}
  void v2LoadFiles(id, v2FilesPath.get(id) || '');
}
/** Folders first, then files, each in the chosen order (name: natural, case-blind). */
function v2FilesOrder(entries) {
  const { key, dir } = v2FilesSort;
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const cmp = key === 'mtime' ? (a, b) => (Date.parse(a.mtime || 0) || 0) - (Date.parse(b.mtime || 0) || 0) || byName(a, b)
    : key === 'size' ? (a, b) => (a.size || 0) - (b.size || 0) || byName(a, b)
    : byName;
  const rank = (e) => (e.type === 'dir' ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || dir * cmp(a, b));
}
/**
 * A file shown here, in the tab, with a way back: a new browser tab had no
 * obvious way back on a phone (Chris, 2026-10-23) — and the app installed on
 * a phone's home screen has no browser bar at all, so sound, video and PDF
 * (the player and the reader the browser has) open here too. Together these
 * are what the server shows inline (inlineType()); the rest downloads.
 */
const V2_TEXT_FILE = /\.(txt|md|markdown|log|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|py|m?js|ts|sh|c|cc|cpp|h|sql|xml|s?v|diff|patch|env|html?|svg)$/i;
const V2_IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|ico)$/i;
const V2_AUDIO_FILE = /\.(mp3|wav|ogg|m4a)$/i;
const V2_VIDEO_FILE = /\.(mp4|webm)$/i;
const V2_PDF_FILE = /\.pdf$/i;
const V2_VIEW_MAX = 2 * 1024 * 1024;
const v2ShownHere = (n) => !/\.[a-z0-9]+$/i.test(n) || V2_TEXT_FILE.test(n) || V2_IMAGE_FILE.test(n) || V2_AUDIO_FILE.test(n) || V2_VIDEO_FILE.test(n) || V2_PDF_FILE.test(n);
/**
 * A text file's first `max` bytes, and whether there was more (`cut`): the rest is not read.
 * The size the folder listed may be old (a log grows), and the whole of a much bigger file was
 * read and drawn past the cap (HB-1042). A character cut in two at the end is left out.
 */
async function v2ReadUpTo(res, max) {
  const reader = res.body?.getReader?.();
  if (!reader) { const t = await res.text(); return { text: t.slice(0, max), cut: t.length > max }; }
  const dec = new TextDecoder();
  let text = '', n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: text + dec.decode(), cut: false };
    if (n + value.length > max) {
      text += dec.decode(value.subarray(0, max - n), { stream: true });
      await reader.cancel().catch(() => {});
      return { text, cut: true };
    }
    n += value.length;
    text += dec.decode(value, { stream: true });
  }
}
async function v2OpenFile(id, folder, name, size) {
  const box = $('v2Files'); if (!box || box.dataset.agent !== id) return;
  const p = (folder ? folder + '/' : '') + name;
  const gen = (v2FilesGen.get(id) || 0) + 1; v2FilesGen.set(id, gen);
  const stale = () => box.dataset.agent !== id || v2FilesGen.get(id) !== gen;
  const url = `/v1/agents/${id}/fs/file?path=${encodeURIComponent(p)}`;
  const back = `<button ${onAction('click', 'v2LoadFiles', [`${id ?? ''}`, `${folder ?? ''}`])} title="Back to the folder">← Back</button>`;
  const bar = `<div class="v2row"><div class="v2k">File</div><div class="v2v">${back}
      <span style="font-family:ui-monospace,monospace;overflow-wrap:anywhere">~/${esc(folder ? folder + '/' : '')}<b>${esc(name)}</b></span>
      <span class="sub">${fmtBytes(size || 0)}</span>
      <a class="btn" href="${url}&inline=1" target="_blank" rel="noopener" ${onAction('click', 'sfOpen', [{ $: 'event' }, { $: 'el' }, `${url}&check=1`], 'return')} title="Open in a new tab">Open in a tab</a>
      <a class="btn" href="${url}" download ${onAction('click', 'sfLink', [{ $: 'event' }, { $: 'el' }, `${name ?? ''}`], 'return')} title="Download">⬇</a></div></div>`;
  box.innerHTML = `${bar}<div class="sub" style="padding:8px 0">Loading…</div>`;
  const isText = !/\.[a-z0-9]+$/i.test(name) || V2_TEXT_FILE.test(name);
  const src = `${url}&inline=1`;
  const said = (text) => { if (!stale()) box.innerHTML = `${bar}<div id="v2FileBody" class="sub" style="padding:8px 0;color:var(--bad)">${esc(text)}</div>`; };
  // At the public address the file may want a fresh second factor, which a frame, a picture or
  // a player can neither ask for nor say it wants (a frame has no error for a 401). There the file
  // route is asked whether it may be read (check=1: answered without reading it), through api(),
  // which asks for the factor when it has lapsed. No read of its folder, and no second download.
  const mayRead = () => api(`${url}&check=1`);
  // A PDF: asked first, then the frame reads it from the server, sandboxed as it is served.
  if (V2_PDF_FILE.test(name) && appConfig.publicAddress) {
    try { await mayRead(); } catch (e) { said(e.message); return; }
    if (stale()) return;
  }
  // The browser's own viewer, player or reader, in the tab (the file is served sandboxed: no scripts, no cookies).
  const media = V2_IMAGE_FILE.test(name) ? `<img src="${src}" alt="${esc(name)}" style="max-width:100%;height:auto;border-radius:8px">`
    : V2_AUDIO_FILE.test(name) ? `<audio controls src="${src}" style="width:100%;max-width:520px"></audio>`
    : V2_VIDEO_FILE.test(name) ? `<video controls playsinline src="${src}" style="max-width:100%;max-height:70vh;border-radius:8px;background:#000"></video>`
    : V2_PDF_FILE.test(name) ? `<iframe src="${src}" title="${esc(name)}" style="width:100%;height:70vh;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>`
    : '';
  if (media) {
    box.innerHTML = `${bar}<div id="v2FileBody" style="padding:8px 0">${media}</div>`;
    // A picture or a player: at the public address, a factor that lapsed is its load failing
    // (HB-0589). Then the check, which asks for it, and the file once more. Not asked first:
    // most loads need no factor.
    const shown = box.querySelector('#v2FileBody > img, #v2FileBody > audio, #v2FileBody > video');
    if (shown && appConfig.publicAddress) shown.addEventListener('error', async () => {
      if (stale()) return;
      try { await mayRead(); } catch (e) { said(e.message); return; }
      if (stale() || !shown.isConnected) return;
      shown.addEventListener('error', () => said('It could not be shown here. Open it in a tab or download it.'), { once: true });
      shown.src = `${src}&again=1`;
    }, { once: true });
    return;
  }
  if (!isText || (size || 0) > V2_VIEW_MAX) {
    box.innerHTML = `${bar}<div id="v2FileBody" class="sub" style="padding:8px 0">${isText ? 'Too big to show here (over 2 MB).' : 'This kind of file is not shown here.'} Open it in a tab or download it.</div>`;
    return;
  }
  try {
    const res = await sfFetch(`${url}&inline=1`);
    if (stale()) return;
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.statusText); }
    const { text, cut } = await v2ReadUpTo(res, V2_VIEW_MAX);
    if (stale()) return;
    const more = cut ? `<div class="sub" style="padding:4px 0">Only the first 2 MB is shown: the file is bigger now than when its folder was read. Open it in a tab or download it for the rest.</div>` : '';
    box.innerHTML = `${bar}${more}<pre id="v2FileBody" style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:1.45;margin:8px 0;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);max-height:70vh;overflow:auto">${esc(text)}</pre>`;
  } catch (e) {
    if (stale()) return;
    box.innerHTML = `${bar}<div id="v2FileBody" class="sub" style="padding:8px 0;color:var(--bad)">${esc(e.message)}</div>`;
  }
}
// Each read numbered per agent: a slow read of the folder left behind landed
// after the one clicked into, and showed it under the newer path (#94).
const v2FilesGen = new Map();
async function v2LoadFiles(id, path) {
  const box = $('v2Files'); if (!box || box.dataset.agent !== id) return;
  v2FilesPath.set(id, path);
  const gen = (v2FilesGen.get(id) || 0) + 1; v2FilesGen.set(id, gen);
  const a = v2Find(id);
  const ws = a ? `.openclaw/agents/${a.slug}/agent` : '';
  let r;
  try { r = await api(`/v1/agents/${id}/fs?path=${encodeURIComponent(path)}`); }
  catch (e) { if (v2FilesGen.get(id) === gen && box.dataset.agent === id) box.innerHTML = `<div class="sub" style="color:var(--bad)">${esc(e.message)}</div>`; return; }
  if (box.dataset.agent !== id || v2FilesGen.get(id) !== gen) return;
  const segs = (r.path || '').split('/').filter(Boolean);
  const crumb = [`<a href="#" ${onAction('click', 'v2LoadFiles', [`${id ?? ''}`, ""], 'prevent')}>home</a>`]
    .concat(segs.map((s, i) => `<a href="#" ${onAction('click', 'v2LoadFiles', [`${id ?? ''}`, `${segs.slice(0, i + 1).join('/') ?? ''}`], 'prevent')}>${esc(s)}</a>`)).join(' / ');
  const dl = (kind, p) => `/v1/agents/${id}/fs/${kind}?path=${encodeURIComponent(p)}`;
  const rows = v2FilesOrder(r.entries).map(e => {
    const p = (r.path ? r.path + '/' : '') + e.name;
    // What the browser can show opens here in the tab, with ← Back (v2OpenFile; its bar
    // offers a new tab and ⬇); the rest only downloads. Mirrors inlineType() on the server.
    const open = e.type === 'dir' ? `<a href="#" ${onAction('click', 'v2LoadFiles', [`${id ?? ''}`, `${p ?? ''}`], 'prevent')}>📁 ${esc(e.name)}/</a>`
      : e.type === 'file' && v2ShownHere(e.name) ? `📄 <a href="${dl('file', p)}&inline=1" ${onAction('click', 'v2OpenFile', [`${id ?? ''}`, `${r.path || ''}`, `${e.name ?? ''}`, (Number(e.size) || 0)], 'prevent')} title="Open here">${esc(e.name)}</a>`
      : `${e.type === 'link' ? '🔗' : '📄'} ${esc(e.name)}`;
    const get = e.type === 'dir' ? `<a class="btn" href="${dl('archive', p)}" ${onAction('click', 'sfLink', [{ $: 'event' }, { $: 'el' }, "folder.tar.gz"], 'return')} title="This folder as a .tar.gz">⬇ .tar.gz</a>`
      : e.type === 'file' ? `<a class="btn" href="${dl('file', p)}" download ${onAction('click', 'sfLink', [{ $: 'event' }, { $: 'el' }, `${e.name ?? ''}`], 'return')} title="Download">⬇</a>` : '';
    return `<tr><td>${open}</td><td class="num">${e.type === 'dir' ? '' : fmtBytes(e.size)}</td><td class="sub">${e.mtime ? ago(e.mtime) : ''}</td><td>${get}</td></tr>`;
  }).join('');
  // .openclaw itself, not every name starting so (.openclaw-notes is the agent's own): the server's rule (#117).
  const here = r.path || '';
  const canUpload = !(here === '.openclaw' || here.startsWith('.openclaw/')) || here === ws || here.startsWith(ws + '/');
  box.innerHTML = `<div class="v2row"><div class="v2k">Folder</div><div class="v2v"><span style="font-family:ui-monospace,monospace">~/ ${crumb}</span>
      ${ws && (r.path || '') !== ws ? `<button ${onAction('click', 'v2LoadFiles', [`${id ?? ''}`, `${ws ?? ''}`])}>Workspace</button>` : ''}
      <a class="btn" href="${dl('archive', r.path || '')}" ${onAction('click', 'sfLink', [{ $: 'event' }, { $: 'el' }, "folder.tar.gz"], 'return')} title="This folder as a .tar.gz">⬇ Whole folder</a>
      ${canUpload ? `<button ${onAction('click', 'clickById', ["v2UploadInput"])} title="Put a file from this computer into this folder">⬆ Upload…</button><input type="file" id="v2UploadInput" multiple hidden data-saves ${onAction('change', 'v2UploadFiles', [`${id ?? ''}`, `${r.path || ''}`, { $: 'files' }])}>` : ''}
      <span class="sub">Click a name to open it here, ⬇ to download. ${canUpload ? 'Drop files on the list to upload them here.' : "OpenClaw's own state — uploads go in the workspace or outside .openclaw."} Its workspace holds what it wrote; memory is under .openclaw.</span></div></div>
    <div id="v2FilesDrop">${r.entries.length ? `<table class="tbl"><thead><tr>${[['name', 'Name', ''], ['size', 'Size', ' class="num"'], ['mtime', 'Changed', '']].map(([k, l, cls]) => `<th${cls}><a href="#" class="v2fsort${v2FilesSort.key === k ? ' on' : ''}" ${onAction('click', 'v2FilesSortBy', [`${id ?? ''}`, `${k}`], 'prevent')} title="Sort by ${l.toLowerCase()}">${l}${v2FilesSort.key === k ? (v2FilesSort.dir > 0 ? ' ▲' : ' ▼') : ''}</a></th>`).join('')}<th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="sub" style="padding:8px 0">Empty folder.</div>'}</div>
    <div id="v2UploadNote" class="sub" hidden></div>`;
  if (canUpload) {
    const drop = $('v2FilesDrop');
    drop.ondragover = (ev) => { ev.preventDefault(); drop.style.outline = '2px dashed var(--accent)'; };
    drop.ondragleave = () => { drop.style.outline = ''; };
    drop.ondrop = (ev) => { ev.preventDefault(); drop.style.outline = ''; void v2UploadFiles(id, r.path || '', ev.dataTransfer.files); };
  }
}

/** Upload files (from a picker or a drop) into a folder of the agent's home; asks before replacing. */
async function v2UploadFiles(id, path, files) {
  const list = [...(files || [])]; if (!list.length) return;
  const note = $('v2UploadNote'); if (note) { note.hidden = false; }
  const say = (t) => { if (note) note.textContent = t; };
  let done = 0;
  const failed = [];
  for (const f of list) {
    say(`Uploading ${f.name} (${fmtBytes(f.size)})…`);
    const put = async (overwrite) => sfFetch(`/v1/agents/${id}/fs/file?path=${encodeURIComponent(path)}&name=${encodeURIComponent(f.name)}${overwrite ? '&overwrite=1' : ''}`,
      { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: f }); // the session cookie is the auth
    try {
      let res = await put(false);
      if (res.status === 409) {
        if (!confirm(`${f.name} is already in this folder. Replace it?`)) continue;
        res = await put(true);
      }
      if (!res.ok) { const e = await res.json().catch(() => ({})); failed.push(`${f.name}: ${e.error || res.statusText}`); continue; }
      done++;
    } catch (e) { failed.push(`${f.name}: ${e.message}`); }
  }
  // The count and each file's reason, said after the folder is drawn again:
  // the redraw replaced the reason with a bare count (#118). Not when the
  // person has moved on to another folder meanwhile.
  if (v2FilesPath.get(id) !== path) return;
  await v2LoadFiles(id, path);
  const after = $('v2UploadNote'); if (!after || $('v2Files')?.dataset.agent !== id || v2FilesPath.get(id) !== path) return;
  after.hidden = false;
  after.innerHTML = [`${done} of ${list.length} uploaded.`, ...failed.map(esc)].join('<br>');
  if (failed.length) after.style.color = 'var(--bad)';
}

function v2MemberPane(a) {
  // Every app it is in, not only Telegram. Asleep is not down: a Telegram
  // message wakes it, so the link stays (only Telegram agents sleep).
  const asleep = a.state === 'STOPPED' && !!a.hibernatedAt;
  const links = a.state === 'RUNNING' || asleep ? agentChannelLinks(a) : [];
  const apps = v2ChannelKinds(a).map(k => V2_CHAN_LABEL[k]);
  const named = apps.length > 1 ? `${apps.slice(0, -1).join(', ')} or ${apps.at(-1)}` : apps[0];
  // Web chat, when the owner gave it (2026-09-29): the page itself is a way in.
  const web = a.webChat && a.state !== 'ARCHIVED' ? `<div class="v2row"><div class="v2k">On the web</div><div class="v2v">
      <button class="${apps.length ? '' : 'primary'}" ${onAction('click', 'v2Close openWebChat', [[], [`${a.id ?? ''}`]])}>💬 Chat</button>
      <span class="sub">Talk to it right here${asleep ? ' — a message wakes it' : ''}. No chat app needed.</span></div></div>` : '';
  if (a.webChat && !apps.length) return web + v2MemberAbout(a);
  return `${web}<div class="v2row"><div class="v2k">Chat</div><div class="v2v">
      ${links.map((l, i) => `<a class="btn${i ? '' : ' primary'}" href="${esc(l.url)}" target="_blank" rel="noopener">Open in ${V2_CHAN_LABEL[l.kind]}</a>`).join('')}
      ${links.some(l => l.kind === 'telegram') ? `<a class="btn" href="${tgWebLink(botOf(a))}" target="_blank" rel="noopener">Telegram Web</a>` : ''}
      ${asleep ? '<span>Asleep — a message wakes it.</span>' : links.length ? '' : '<span>Not running right now.</span>'}
      ${named ? `<span class="sub">It answers in ${named}, which works wherever you are.</span>` : ''}</div></div>
    ${v2MemberAbout(a)}`;
}
function v2MemberAbout(a) {
  return `${a.persona ? `<div class="v2row"><div class="v2k">What it does</div><div class="v2v">${esc(a.persona)}</div></div>` : ''}
    <div class="v2row"><div class="v2k">Memory</div><div class="v2v">${a.ops ? 'Yours alone — only you talk to it.' : 'Shared — it remembers what everyone who uses it tells it, and anyone who talks to it can get at what it remembers.'}</div></div>`;
}

/**
 * Chat on the web (2026-09-29): a member the owner trusts talks to the agent
 * here, in a conversation of their own. Everything the agent says is shown
 * as plain text (escaped; line breaks kept by the bubble's pre-wrap) — never
 * as HTML.
 */
let webChatAgentId = null;
// Per agent: one waiting reply blocked Send for every other agent, and its
// "…thinking" line was taken off whichever chat was open (review, 2026-10-09).
let webChatSending = new Set();
const webChatWait = (id) => [...$('wchatLog').querySelectorAll('.wchat-msg.wait')].find(el => el.dataset.wait === id);
// `at`, on what was read from the log (data-log): when the log says it was said, by the
// server's clock ('' when it gives none).
// `mid`: a message's id, on its bubble, read or sent here; `replyTo`, on an answer drawn here, the id of the message it answers.
const webChatBubble = (role, text, cls = '', at = null, mid = '', replyTo = '') => `<div class="wchat-msg${role === 'user' ? ' me' : ''}${cls}"${at === null ? '' : ` data-log${at ? ` data-at="${esc(at)}"` : ''}`}${mid ? ` data-mid="${esc(mid)}"` : ''}${replyTo ? ` data-reply-to="${esc(replyTo)}"` : ''}>${esc(text)}</div>`;
/**
 * What was sent in this open before its read came, that the read holds already (HB-1041): the
 * message, by its id, and its answer when the log answers it in the same words. Kept after the
 * log, both showed twice. `messages`: the read's; `at`: the place in them of each id.
 */
function webChatReadHas(el, messages, at) {
  const mid = el.dataset.mid || el.dataset.replyTo;
  if (!mid || !at.has(mid)) return false;
  if (el.dataset.mid) return true;
  const next = messages[at.get(mid) + 1];
  return next?.role === 'assistant' && webChatSameWords(next.text, el.textContent);
}
/** Its answer is in the log already: the log's copy of the message, then the same words from the agent (an answer that came after the read). */
function webChatLogAnswered(mid, reply) {
  const mine = [...$('wchatLog').querySelectorAll('.wchat-msg.me[data-log][data-mid]')].find(el => el.dataset.mid === mid);
  const next = mine?.nextElementSibling;
  return !!next && next.hasAttribute('data-log') && !next.classList.contains('me') && webChatSameWords(next.textContent, reply);
}
const webChatScroll = () => { const l = $('wchatLog'); l.scrollTop = l.scrollHeight; };
/**
 * A guest's 💬 Chat. On a rebuilt agent it is OpenClaw's own chat — the
 * owner's console, cut down to this person's conversations (the console with
 * identities, 2026-09-30). It needs a secure context (https) like the owner's;
 * without one, or on an agent not rebuilt yet, the chat here is used instead.
 */
async function openWebChat(id) {
  const a = v2Find(id); if (!a) return;
  if (!window.isSecureContext) {
    const httpsHere = location.protocol === 'http:' && location.hostname !== 'localhost' ? `https://${location.host}` : null;
    return openWebChatPanel(id, `The full chat needs a secure page${httpsHere ? ` — open ${httpsHere}` : ' (https)'} for it. Meanwhile, chat here.`);
  }
  // Numbered as the owner's console opens are: another chat or console picked
  // while this one's access is read supersedes it. A slow answer for the
  // first opened its chat over the one chosen since, a message away from
  // going to the wrong agent (HB-0991).
  const ticket = ++consoleTicket, person = pagePerson;
  let acc = null;
  try { acc = await api(`/v1/agents/${id}/console/access`); } catch { acc = null; }
  if (ticket !== consoleTicket || person !== pagePerson || pagePersonAway || pageSignedOut) return;
  if (acc?.console === 'identity' && acc.session) return openGuestConsole(a, acc.session);
  return openWebChatPanel(id, acc?.console === 'needs-rebuild' ? acc.reason : '');
}
function openGuestConsole(a, sessionKey) {
  const url = `/v1/agents/${a.id}/ui/chat?session=${encodeURIComponent(sessionKey)}`;
  consoleUnloadAll(); consoleTabs = [];
  consoleGuest = true;
  consoleAgentId = null; // nothing of the owner's (settings, tabs) follows a guest's console
  consoleGuestAgentId = a.id; // but their own conversation's unread mark does (HB-1139)
  consoleUrl = url;
  $('consoleTitle').textContent = a.name;
  $('consoleGearBtn').style.display = 'none';
  $('consoleApproveBtn').hidden = true;
  $('consoleChans').innerHTML = '';
  $('consoleProps').hidden = true;
  $('consoleCover').hidden = true;
  // Loaded: what its chat shows is read (and every 20 s, and on close: markConsoleSeen).
  $('consoleFrame').addEventListener('load', () => { if (consoleGuest) markConsoleSeen(a.id); }, { once: true });
  $('consoleFrame').src = url;
  renderConsoleTabs();
  $('consoleDlg').showModal();
}
/** A guest's conversation read in the chat here: their own seen mark, as the console's (HB-1139). */
function webChatSeen(id) {
  if (!id) return;
  const a = (agents || []).find(x => x.id === id);
  if (a?.unread) { a.unread = false; renderV2(); }
  api(`/v1/agents/${id}/seen`, { method: 'POST' }).catch(() => {});
}
/**
 * The box belongs to one agent at a time. What it held for another agent waits
 * in webChatDrafts, so text never carries into the wrong agent's chat, where
 * Enter would send it, and switching agent loses nothing.
 */
let webChatDrafts = new Map();
let webChatBoxFor = null;
/**
 * Per agent: what was sent since its log was last read, each with that read (`after`, its
 * newest time; `logged`, the same words in it; `untimed`, those with no time), whether it
 * may not have arrived (`unsure`: 502, 504, no answer) and whether it is still waiting for
 * its answer (`waiting`). Reopening draws the log from the
 * server, so this is where such a message is got back from (HB-0446).
 * New sends carry a UUID whose transcript receipt confirms delivery without comparing
 * clocks. The counts below remain for old pages and older servers. The log holds only
 * 100 messages, so a count of the whole log could not tell an often-said "ok" apart
 * (HB-0495): only what comes after the read is counted, against the sends that followed it,
 * answered or not. Send does not wait for the log: one sent before it was read, like one after
 * a read that failed (or could not be done), is counted by time from when it was sent
 * (`sentAt`, in the server's time when an answer has said what that is: serverAheadMs), never
 * against the whole log; the same words sent after the read, in that open, join them. A message
 * the log gives no time is counted by its words, against those with no time when it was read.
 * Answered with nothing in doubt, a send's group goes (webChatAnswered): the next send of those
 * words keeps how many there were (`before`), from their bubbles in the log.
 */
let webChatUnsure = new Map();
/** Each open of a chat, numbered: a send counts against the read that came before it. */
let webChatOpens = 0;
/** The open whose conversation has been read (or could not be): a send before then follows no read (`sentAt`). */
let webChatReadOpen = 0;
/** That open's read failed, or said the conversation could not be read: what is sent then follows no read (`sentAt`). */
let webChatUnread = false;
/** One message at a time to an agent: the next waits for its answer. Not for the log to be read. */
const webChatCanSend = (id) => !webChatSending.has(id);
/** The same words, the one test for both counts (webChatSend's of the log as read, webChatOfferUnsure's of the next): trimmed, both sides. */
const webChatSameWords = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();
/** A UUID also works on private HTTP, where crypto.randomUUID is unavailable. */
function webChatMessageId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
/** The same words sent after the same read: a group, counted together (webChatOfferUnsure). Sent with no read: a group of their own. */
const webChatKey = (s) => JSON.stringify([s.text, s.after ?? null, s.logged, s.untimed, !!s.sentAt]);
/** How far this browser's clock may be ahead of the machine's: a copy timed that much before a send with no read is still taken as its. */
const WEBCHAT_CLOCKS_MS = 5000;
/** With the server's time known (serverAheadMs, from a Date header's whole seconds): the allowance for those seconds, and the trip (SERVER_CLOCK_TRIP_MS). */
const WEBCHAT_DATE_MS = 2000;
/** The session is over: nothing of this person's stays on the page or can be sent. What they had waits (pagePersonIs). */
function webChatPutAway() {
  const box = $('wchatText');
  if (webChatBoxFor && box.value) webChatDrafts.set(webChatBoxFor, box.value);
  box.value = '';
  webChatBoxFor = null; webChatAgentId = null;
  $('wchatLog').innerHTML = ''; $('wchatErr').textContent = '';
  $('wchatNote').textContent = ''; $('wchatNote').hidden = true;
  if (webChatDlg.open) webChatDlg.close();
}
/** Another account is here. New holders, not emptied ones: a send still waiting writes to its own person's, which nobody reads now. */
function webChatForget() {
  webChatPutAway();
  webChatDrafts = new Map(); webChatUnsure = new Map(); webChatSending = new Set();
}
function webChatShowDraft(id) {
  if (webChatBoxFor === id) return;
  const box = $('wchatText');
  if (webChatBoxFor && box.value) webChatDrafts.set(webChatBoxFor, box.value);
  box.value = webChatDrafts.get(id) ?? '';
  webChatDrafts.delete(id);
  webChatBoxFor = id;
}
/** A refused message goes back to its own agent's box, ahead of anything typed since (HB-0446, HB-0477). `drafts`: the person who sent it. */
function webChatGiveBack(id, text, drafts = webChatDrafts) {
  const box = $('wchatText');
  const ahead = (typed) => typed ? `${text}\n${typed}` : text;
  if (drafts === webChatDrafts && webChatBoxFor === id) box.value = ahead(box.value);
  else drafts.set(id, ahead(drafts.get(id)));
}
/**
 * A send answered: its message arrived. Its group goes when nothing in it is in doubt, so a
 * long chat does not keep one record per message; the next send of the same words in this
 * open counts its bubble instead (`before`). Kept when one of them may not have arrived or
 * still waits, or the chat was opened again since: its bubbles are not on that log.
 */
function webChatAnswered(id, record, unsure = webChatUnsure) {
  const list = unsure.get(id) ?? [], k = webChatKey(record);
  const group = list.filter(s => webChatKey(s) === k);
  // Sent with no read: counted by time from the first of them, so they stay together.
  if (record.sentAt || record.open !== webChatOpens || group.some(s => s.unsure || (s.waiting && s !== record) || s.open !== record.open)) return;
  const left = list.filter(s => webChatKey(s) !== k);
  if (left.length) unsure.set(id, left); else unsure.delete(id);
}
/**
 * The log has been read: a message that may not have arrived and is not in it comes
 * back to the box, and is said to. Never sent again by itself. A log that could not be
 * read (a note: rebuilt, moved or busy, often just after the 502 or 504) tells nothing, so
 * the message waits for the next time, with the sends after the same read; a group with
 * nothing in doubt has nothing to wait for, and goes.
 */
function webChatOfferUnsure(id, r) {
  const sent = webChatUnsure.get(id);
  if (!sent) return;
  const key = webChatKey;
  if (r.note) {
    const doubt = new Set(sent.filter(s => s.unsure || s.waiting).map(key));
    const left = sent.filter(s => s.open >= webChatOpens || doubt.has(key(s)));
    if (left.length) webChatUnsure.set(id, left); else webChatUnsure.delete(id);
    return;
  }
  // The same words sent after the same read: how many arrived since it, against how many were sent.
  // Sent before this open: counted now. Sent in this open, before this read came: counted at the next.
  // Not one still waiting for its answer, with those sent after the same read: it may yet
  // fail with a 504, and then it is counted with them (dropped now, it was never offered back).
  const due = sent.filter(s => s.open < webChatOpens), waiting = new Set(due.filter(s => s.waiting).map(key));
  const kept = sent.filter(s => s.open >= webChatOpens || waiting.has(key(s)));
  const groups = new Map();
  for (const s of due.filter(s => !waiting.has(key(s)))) groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);
  const lost = [];
  for (const group of groups.values()) {
    // New sends are correlated with their transcript marker, even when the
    // runner's clock differs or their bubble has fallen outside the last 100.
    // A partial history can prove arrival, but cannot prove absence.
    const g = r.delivery ? group.filter(s => !s.messageId) : group;
    if (r.delivery) for (const s of group.filter(s => s.messageId && s.unsure)) {
      if ((r.delivery.received || []).includes(s.messageId)) continue;
      if (!(r.delivery.checked || []).includes(s.messageId)) { kept.push(s); continue; }
      if (!lost.includes(s.text)) lost.push(s.text);
    }
    const unsure = g.filter(s => s.unsure).length; if (!unsure) continue;
    // `before`: those answered in its open before the first of these, whose records went (webChatAnswered).
    const { text, after, logged, untimed, before = 0, sentAt } = g[0];
    const same = (r.messages || []).filter(m => m.role === 'user' && webChatSameWords(m.text, text));
    // Sent with no read before it (before the read came, or it failed or could not be done): only
    // a copy the log times from the first of these on, in the server's time when an answer has
    // given it (this browser's clock may be well off), else by this browser's less a little. One
    // with no time is not taken for it, so it comes back. Never the whole log, where an older "ok" hid it.
    // Said after the read; and one with no time that the read does not account for: its time
    // unknown, it is taken by its words. A log with no times when it was read: counted whole.
    const from = sentAt && (serverAheadMs === null ? Date.parse(sentAt) - WEBCHAT_CLOCKS_MS : Date.parse(sentAt) + serverAheadMs - WEBCHAT_DATE_MS);
    const since = sentAt
      ? same.filter(m => Date.parse(m.at) >= from).length
      : after
      ? same.filter(m => Date.parse(m.at) > Date.parse(after)).length + Math.max(0, same.filter(m => !Date.parse(m.at)).length - untimed)
      : same.length - logged;
    if (since - (g.length - unsure + before) < unsure && !lost.includes(text)) lost.push(text);
  }
  if (kept.length) webChatUnsure.set(id, kept); else webChatUnsure.delete(id);
  if (!lost.length) return;
  for (const text of lost.reverse()) webChatGiveBack(id, text); // each goes ahead of the last: the first sent ends up first
  $('wchatErr').textContent = `${lost.length === 1 ? 'A message you sent is' : 'Messages you sent are'} not in this conversation, so ${lost.length === 1 ? 'it' : 'they'} may not have been delivered. ${lost.length === 1 ? 'It is' : 'They are'} back in the box: send or clear as you wish.`;
}
async function openWebChatPanel(id, note = '') {
  const a = v2Find(id); if (!a) return;
  // Signed in again, and who it is not read yet: the last person's draft waits for that.
  if (pagePersonAway) {
    await loadMyAccount();
    if (pagePersonAway) { toast('Could not check who is signed in. Try again in a moment.'); return; }
  }
  const drafts = webChatDrafts;
  $('wchatNote').textContent = note;
  $('wchatNote').hidden = !note;
  webChatAgentId = id;
  const open = ++webChatOpens;
  webChatShowDraft(id);
  // Send does not wait for the conversation: one sent before it is read follows no read, as one
  // after a read that failed, and is counted by its time (webChatSend's `sentAt`).
  $('wchatSend').disabled = !webChatCanSend(id);
  $('wchatAgent').textContent = a.name;
  $('wchatErr').textContent = '';
  $('wchatLog').innerHTML = '<div class="sub" id="wchatEmpty">Loading your conversation…</div>';
  if (!webChatDlg.open) webChatDlg.showModal();
  $('wchatText').focus();
  try {
    const pending = (webChatUnsure.get(id) || []).filter(s => s.messageId && (s.unsure || s.waiting)).slice(0, 100).map(s => s.messageId);
    const r = await api(`/v1/agents/${id}/chat`, pending.length ? { headers: { 'x-hatchabot-message-ids': pending.join(',') } } : {});
    // Opened again meanwhile: that open's read draws the log.
    if (webChatAgentId !== id || webChatDrafts !== drafts || webChatOpens !== open) return;
    webChatUnread = !!r.note;
    // Sent in this open before the read came: their bubbles, answers and "…thinking" stay, after the log;
    // not those the read holds already (HB-1041).
    const read = r.messages || [], at = new Map(read.map((m, i) => [m.messageId, i]).filter(([mid]) => mid));
    const sentHere = [...$('wchatLog').children].filter(el => !el.hasAttribute('data-log') && el.id !== 'wchatEmpty' && !webChatReadHas(el, read, at));
    $('wchatLog').innerHTML = read.map(m => webChatBubble(m.role, m.text, '', m.at ?? '', m.messageId)).join('')
      || (r.note || !sentHere.length ? `<div class="sub" id="wchatEmpty">${esc(r.note || 'Nothing here yet — say hello.')}</div>` : '');
    $('wchatLog').append(...sentHere);
    if (webChatSending.has(id) && !webChatWait(id)) $('wchatLog').insertAdjacentHTML('beforeend', `<div class="wchat-msg wait" data-wait="${esc(id)}">…thinking</div>`);
    webChatOfferUnsure(id, r);
    webChatScroll();
    if (!r.note) webChatSeen(id); // read, and on the screen
  } catch (e) {
    if (webChatAgentId !== id || webChatDrafts !== drafts || webChatOpens !== open) return;
    webChatUnread = true;
    $('wchatEmpty')?.remove();
    $('wchatErr').textContent = e.message;
  } finally {
    if (webChatAgentId === id && webChatDrafts === drafts && webChatOpens === open) {
      webChatReadOpen = open;
      $('wchatSend').disabled = !webChatCanSend(id);
    }
  }
}
async function webChatSend() {
  const id = webChatAgentId, box = $('wchatText');
  const text = box.value.trim();
  // Send (and Enter) goes at once, read or not: before the conversation is read it follows no read (sentAt, below).
  if (!id || !text || !webChatCanSend(id)) return;
  // This person's, for when the answer lands: by then the next person may be signed in.
  const drafts = webChatDrafts, unsure = webChatUnsure, sending = webChatSending;
  const stillHere = () => webChatDrafts === drafts && !pagePersonAway; // anything else: nothing said, on a sign-in screen or to someone else
  const onScreen = () => webChatDrafts === drafts && webChatAgentId === id;
  sending.add(id); $('wchatSend').disabled = true;
  const name = v2Find(id)?.name || 'The agent';
  $('wchatErr').textContent = '';
  $('wchatEmpty')?.remove();
  box.value = '';
  // Its own bubble, kept by reference: a reopen reloads the log without it, and the last message then is a delivered one.
  const log = $('wchatLog');
  // The read this send follows: the log's newest time then, and the same words in it, with no
  // time and in all. Kept for every send, answered or not: a reopen counts them all (webChatOfferUnsure).
  const after = [...log.querySelectorAll('.wchat-msg[data-at]')].map(el => el.dataset.at).filter(at => Date.parse(at)).sort((x, y) => Date.parse(x) - Date.parse(y)).pop();
  const read = [...log.querySelectorAll('.wchat-msg.me[data-log]')].filter(el => webChatSameWords(el.textContent, text));
  // No read before it: this open's has not come yet, or it failed or could not be done.
  const unread = webChatUnread || webChatReadOpen !== webChatOpens;
  // The same words sent in this open before its read came (sentAt): counted with them, by time from
  // the first, whether the read holds their copies or not. Counted against the read, one of them
  // answered was counted twice, in the read (`after`) and again by its bubble (`before`), and a
  // later one that arrived came back.
  const early = !unread && (unsure.get(id) ?? []).find(s => s.sentAt && s.open === webChatOpens && webChatSameWords(s.text, text));
  // The same words sent since the read and answered: their records went (webChatAnswered), their bubbles stay.
  // With no read, none went: they are all still counted with it.
  const before = unread || early ? 0 : [...log.querySelectorAll('.wchat-msg.me[data-answered]')].filter(el => webChatSameWords(el.textContent, text)).length;
  const record = early
    ? { text, after: early.after, logged: early.logged, untimed: early.untimed, before, open: webChatOpens, unsure: false, waiting: true, sentAt: new Date().toISOString() }
    : { text, after, logged: read.length, untimed: read.filter(el => !Date.parse(el.dataset.at)).length, before, open: webChatOpens, unsure: false, waiting: true,
      // No read before it: the moment it was sent, by this browser's clock (webChatOfferUnsure puts it in the server's).
      ...(unread ? { sentAt: new Date().toISOString() } : {}) };
  record.messageId = webChatMessageId();
  unsure.set(id, [...(unsure.get(id) ?? []), record]);
  log.insertAdjacentHTML('beforeend', webChatBubble('user', text, '', null, record.messageId));
  const bubble = log.lastElementChild;
  log.insertAdjacentHTML('beforeend', `<div class="wchat-msg wait" data-wait="${esc(id)}">…thinking</div>`);
  webChatScroll();
  let answered = false;
  try {
    const r = await api(`/v1/agents/${id}/chat`, { method: 'POST', body: { text, messageId: record.messageId } });
    answered = true; bubble.dataset.answered = '';
    // Its answer drawn once: a read that came meanwhile may hold it already (HB-1041).
    if (onScreen()) { webChatWait(id)?.remove(); if (!webChatLogAnswered(record.messageId, r.reply)) $('wchatLog').insertAdjacentHTML('beforeend', webChatBubble('assistant', r.reply, '', null, '', record.messageId)); }
    else if (stillHere()) toast(`${name} answered — open its chat to read it.`, 8000); // not dropped without a word
  } catch (e) {
    // Refused (4xx): not in the conversation, so it comes back into its box and leaves
    // the log. Busy, too many this hour, not running, a guest's limited turn until a
    // rebuild (step 2), a session that ended, a second factor not given: all of them
    // (HB-0446). Anything else may have got through, and sending it again could say it
    // twice: no answer in time (504), no answer at all, or a failure after the gateway
    // had accepted it (502: src/orchestrator/conversation/webChat.ts has one exit for before and
    // after). It stays as sent, and that is said; reopening checks it (webChatOfferUnsure).
    const refused = e.status >= 400 && e.status < 500;
    if (refused) { bubble.remove(); unsure.set(id, (unsure.get(id) ?? []).filter(s => s !== record)); webChatGiveBack(id, text, drafts); }
    else record.unsure = true;
    // The server's own words already say so for 502 and 504.
    const said = refused || e.status === 502 || e.status === 504 ? e.message : `${e.message}${/[.!?…]$/.test(e.message) ? '' : '.'} It may have got through: reopen this chat to see before you send it again.`;
    // Said where they are typing; if they have moved on, in a toast.
    if (onScreen()) { webChatWait(id)?.remove(); $('wchatErr').textContent = said; }
    else if (stillHere()) toast(`${name}: ${said}${refused ? ' Your message is back in its box.' : ''}`, 8000);
  } finally {
    record.waiting = false;
    if (answered) webChatAnswered(id, record, unsure);
    sending.delete(id);
    if (onScreen()) $('wchatSend').disabled = !webChatCanSend(id);
    webChatScroll();
  }
}
// Enter sends, Shift+Enter is a new line (nothing is sent mid-composition, e.g. Japanese input).
$('wchatText').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); void webChatSend(); }
});
// The close event comes later (with an animation frame): reopened by then, the chat now showing stays live.
// Closed after a read that worked: what it showed until then was read (HB-1139).
webChatDlg.addEventListener('close', () => {
  if (webChatDlg.open) return;
  if (webChatAgentId && !webChatUnread && webChatReadOpen === webChatOpens) webChatSeen(webChatAgentId);
  webChatAgentId = null;
});

/** Why a tab that reads from the running container is empty, in the agent's
 *  real state: a rebuild or a failure is not "stopped — start it". */
function v2NotRunning(a, what) {
  switch (a.state) {
    case 'PROVISIONING': return `It is being set up — ${what} show here once it is running.`;
    case 'REBUILDING': return `It is being rebuilt — ${what} show here again in a minute.`;
    case 'FAILED': return `It failed to start — see Overview, then Retry. ${what[0].toUpperCase() + what.slice(1)} show here once it is running.`;
    case 'ARCHIVED': return `It is archived — restore it to see ${what}.`;
    case 'DELETING': return 'It is being deleted.';
    default: return a.hibernatedAt ? `It is asleep — wake it to see ${what}.` : `It is stopped — start it to see ${what}.`;
  }
}
/** The pill colour for a status — the bar and anything else that shows one. */
const v2PillCls = (st) => st.cls === 'ok' ? 'ok' : st.cls === 'blocked' ? 'bad' : st.cls === 'waiting' ? 'info' : 'warn';

function v2Pane(a, tab) {
  const run = a.state === 'RUNNING', built = !!a.runtimeRef;
  const B = (label, call, extra = '') => `<button ${call} ${extra}>${label}</button>`;
  // forId: the row's one control, named by its key through a real <label> (2026-10-09: the selects had none).
  const row = (k, v, forId) => `<div class="v2row">${forId ? `<label class="v2k" for="${forId}">${k}</label>` : `<div class="v2k">${k}</div>`}<div class="v2v">${v}</div></div>`;
  const slot = (pane) => `<div data-v2slot="${pane}"></div>`;
  const goto = (t) => onAction('click', 'openV2Agent', [a.id, t]);
  const place = v2PlaceInGroup(a);
  const st = v2Status(a);
  // Overview's list of what is wrong, less what a notice above already says with its button, and the Telegram rename
  // its notice says with when (botNameNote): it was said twice there (HB-1268).
  const renameWhy = new Set(a.botNamePending ? agentAttention(a).filter(x => x.key === 'botName').map(x => x.why) : []);
  const whyList = st.why.filter(w => !(a.state === 'FAILED' && /^it failed/.test(w)) && !(w === TEMPLATE_WHY && a.state !== 'ARCHIVED') && !renameWhy.has(w));
  // A loop, a budget at 100% and a spike link to their Recommended item (the agent's Usage tab).
  const recOf = new Map(v2Mine(a) ? agentAttention(a).filter(x => x.rec).map(x => [x.why, x.rec]) : []);
  const src = profiles.find(p => p.id === a.aiProfileId);
  const host = hosts.find(h => h.id === a.hostId);
  const groups = [...new Set(agents.filter(x => v2Mine(x) && x.group).map(x => x.group))].sort();
  switch (tab) {
    case 'overview': return `
      <div class="v2notices">${agentNotices(a, { skipFailure: true, skipTokenForm: true, setupValues: a.state !== 'ARCHIVED' }).trim()}</div>
      ${a.pendingAction?.type === 'bot_token' ? row('Telegram bot', `<div class="grow"><span class="sub">The bot pool is empty, so this agent is waiting for a bot of its own — or it can go on without one.</span>${tokenForm(a)}</div>`) : ''}
      ${a.state === 'FAILED' && a.stateReason ? `<p class="sub" style="margin:0 0 8px">${esc(a.stateReason)}</p>` : ''}
      ${a.archiving ? row('Working on', `<span>${esc(a.archiving.step)}${a.archiving.at ? ` <span class="sub">· ${esc(ago(a.archiving.at))}</span>` : ''}</span>${B('Setup log', onAction('click', 'openSetupLog', [`${a.id}`, `${a.name}`]))}`) : ''}
      ${!a.archiving && v2OpGoing(a) ? row('Working on', `<span id="v2OpWorking" data-op="${esc(a.operation.id || '')}">${esc(v2OpLine(a.operation))}</span>${B('Setup log', onAction('click', 'openSetupLog', [`${a.id}`, `${a.name}`]))}
        <span class="sub">It goes on without this page — close it if you like; a message here says how it ended.</span>`) : ''}
      ${(a.state === 'REBUILDING' || a.state === 'PROVISIONING') && !v2OpGoing(a) ? row('Working on', `<span>${esc(a.progress?.step || (a.state === 'REBUILDING' ? 'rebuilding' : 'setting up'))}${a.progress?.at ? ` <span class="sub">· ${esc(ago(a.progress.at))}</span>` : ''}</span>${B('Setup log', onAction('click', 'openSetupLog', [`${a.id}`, `${a.name}`]))}
        <span class="sub">Moving onto a new OpenClaw line runs its migrations and rebuilds the memory index — minutes on an agent with a long history.</span>`) : ''}
      ${whyList.length ? `<ul class="v2why" style="margin:0 0 10px">${whyList.map(w => `<li>${esc(w)}${recOf.has(w) ? ` <button type="button" class="linkish" ${onAction('click', 'v2OpenRec', [`${a.id}`, `${recOf.get(w) ?? ''}`])}>Recommended →</button>` : ''}</li>`).join('')}</ul>` : ''}
      ${row('Name &amp; icon', `<span>${esc(a.name)}</span>${B('Change icon', onAction('click', 'openV2Icon', [`${a.id}`]))}${a.state !== 'ARCHIVED' ? B('Rename…', goto('personality')) : ''}
        ${a.persona ? `<span class="sub">${esc(a.persona)}</span>` : ''}`)}
      ${a.state !== 'ARCHIVED' ? row('AI', `<span>${esc(src?.name || 'unknown')}${a.model ? ' · ' + esc(a.model) : ''}</span>${B('Change…', goto('ai'))}`) : ''}
      ${a.state !== 'ARCHIVED' && built ? '<div id="v2AppRow"></div>' : ''}
      ${a.state !== 'ARCHIVED' ? row('Group', `<select id="v2GroupSel" data-saves ${onAction('change', 'v2SetGroup', [`${a.id}`, { $: 'value' }])} style="width:auto">
          <option value="">${groups.length ? 'Default' : 'No group'}</option>${groups.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}
          <option value="${V2_NEW_GROUP}">＋ New group…</option></select><span class="sub">Or drag its icon on the home screen.</span>`, 'v2GroupSel') : ''}
      ${place ? row('Order', `<span id="v2Place">${place.i + 1} of ${place.order.length} in ${esc(a.group || (groups.length ? 'Default' : 'its group'))}</span>
          ${B('Move earlier', onAction('click', 'v2MoveInGroup', [`${a.id}`, -1, { $: 'event' }]), `id="v2MoveEarlier"${place.i === 0 ? ' disabled' : ''} title="One place earlier in its group (Shift: to the start)"`)}
          ${B('Move later', onAction('click', 'v2MoveInGroup', [`${a.id}`, 1, { $: 'event' }]), `id="v2MoveLater"${place.i === place.order.length - 1 ? ' disabled' : ''} title="One place later in its group (Shift: to the end)"`)}
          <span class="sub">Its place when the home screen is sorted by <b>My order</b>${v2Sort.key === 'manual' ? '' : ' (moving it switches the home screen to My order)'}. Dragging its icon does the same.</span>`) : ''}
      ${a.state !== 'ARCHIVED' ? row('Class', `<select id="editClass" style="width:auto" data-saves ${onAction('change', 'assignClass')}></select>
          <span class="sub">A tier — model, AI source, image — shared with other agents. Make them in ⚙ Settings → Classes.</span>`, 'editClass') : ''}
      ${a.state !== 'ARCHIVED' ? row(v2ChannelKinds(a).length > 1 ? 'Messaging' : 'Telegram', v2ChannelKinds(a).length
        ? `<span>${v2ChannelKinds(a).map(k => k === 'telegram' ? `Telegram · @${esc(a.botUsername)}` : V2_CHAN_LABEL[k]).join(' · ')}</span>${run ? agentChannelLinks(a).map(l => `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener">Open ${V2_CHAN_LABEL[l.kind]}</a>`).join('') : ''}${B('Manage…', goto('messaging'))}`
        : `<span>None — you talk to it here.</span>${B('Add an app…', goto('messaging'))}`) : ''}
      ${run ? row('Checks', `${B('❤️ Check health', onAction('click', 'v2InlineHealth', [`${a.id}`, `${a.name}`]))}${B('💲 Usage', onAction('click', 'openUsage', [`${a.id}`, `${a.name}`]))}${B('Logs', onAction('click', 'openLogs', [`${a.id}`, `${a.name}`]))}${B('Setup log', onAction('click', 'openSetupLog', [`${a.id}`, `${a.name}`]))}
        ${B('Stop', onAction('click', 'act', [`${a.id}`, "stop"]), 'title="Pause it. It keeps its Telegram bot — Archive hands that back."')}
        <div id="v2HealthSlot" hidden style="flex-basis:100%"></div>`) : built ? row('Checks', `${B('Logs', onAction('click', 'openLogs', [`${a.id}`, `${a.name}`]))}${B('Setup log', onAction('click', 'openSetupLog', [`${a.id}`, `${a.name}`]))}`) : ''}
      ${(run || a.state === 'STOPPED') && built ? row('Rebuild', `${B('↻ Rebuild', onAction('click', 'rebuild', [`${a.id}`]), 'class="primary" title="A fresh container on the current image. Its memory, files and members are kept."')}
        <span class="sub">Takes about a minute. Do this after changing its image, its data folders, or the agents it can ask — and whenever Hatchabot says an update is waiting.</span>`) : ''}
      <div class="v2danger"><h4>Archive or delete</h4><div class="v2v">
        ${a.archiving ? '<span class="sub">Archiving…</span>' : ''}
        ${['RUNNING', 'STOPPED', 'FAILED'].includes(a.state) && !a.archiving ? B('📥 Archive', onAction('click', 'v2Close archiveAgent', [[], [`${a.id}`, `${a.name}`, `${a.state}`]]), `title="Keep it and its memory${a.botUsername ? '; hand its Telegram bot back' : ''}"`) : ''}
        ${B('Delete…', onAction('click', 'v2Close del', [[], [`${a.id}`, `${a.name}`]]), 'class="danger"')}
        <span class="sub" style="flex-basis:100%">${a.state === 'DELETING'
          // A delete the process was stopped in stays DELETING: Delete again finishes it (HB-0265); the server turns one away while a delete still runs.
          ? 'It is being deleted. If it stays here (Hatchabot restarted during the delete), Delete… finishes it.'
          : 'Archive keeps it and its memory, and frees its bot; Restore brings it back. Delete removes it for good.'}</span>
      </div></div>`;
    case 'personality': return `
      ${slot('paneDef')}
      ${run ? `<h4 class="v2sec">Memory</h4>${row('Conversation', `${B('📝 Chat → Memory', onAction('click', 'checkpointAgent', [`${a.id}`, `${a.name}`]))}${B('📥 Recover context', onAction('click', 'recoverContext', [`${a.id}`, `${a.name}`]))}
        <span class="sub">Save what matters from the current chat, or bring back earlier conversations after a reset.</span>`)}` : ''}
      ${slot('paneEditSnap')}`;
    case 'ai': return slot('paneEditAi');
    case 'messaging': return a.state === 'ARCHIVED' ? row('Telegram', '<span>Archived agents have no bot. Restore it to get one.</span>') : `
      <div id="v2Chans" data-agent="${esc(a.id)}" data-kinds="telegram"><div class="sub">Loading…</div></div>
      ${a.botUsername ? slot('paneEditTg') : ''}`;
    case 'channels': return a.state === 'ARCHIVED' ? row('Discord', '<span>Archived agents have no bot. Restore it to get its Discord bot back.</span>') : `
      <div id="v2Chans" data-agent="${esc(a.id)}" data-kinds="discord"><div class="sub">Loading…</div></div>`;
    case 'slack': return a.state === 'ARCHIVED' ? row('Slack', '<span>Archived agents have no app. Restore it to get its Slack app back.</span>') : `
      <div id="v2Chans" data-agent="${esc(a.id)}" data-kinds="slack"><div class="sub">Loading…</div></div>`;
    case 'knowledge': return `
      ${slot('paneEditData')}
      ${slot('paneEditConn')}
      ${built ? `<h4 class="v2sec">History</h4>${row('Every conversation', `${B('💬 Download', onAction('click', 'downloadHistory', [`${a.id}`, `${a.name}`]))}<span class="sub">A file of everything it has ever been told, oldest first.</span>`)}` : ''}`;
    case 'sharing': {
      // Where people sign in, invited people can chat on the web: the member list shows without a chat app (2026-09-29).
      const webOk = appConfig.authMode !== 'password' && !a.ops;
      return `
      ${a.ops ? row('People', '<span>Only you. Your Hatchabot agent is yours alone — it cannot be shared or given members.</span>') : ''}
      ${!a.ops && (v2ChannelKinds(a).length || webOk) ? `<div data-v2slot="tgMembersBlock"></div>` : ''}
      ${v2ChannelKinds(a).length || a.ops ? '' : row('People', `<span>${webOk ? 'It is in no chat app yet — people you invite can chat with it on the web, here.' : 'Only you — it is not in a chat app yet.'}</span>${B('Add Telegram…', goto('messaging'))}${B('Add Discord…', goto('channels'))}
            <span class="sub">Other people reach an agent through a chat app: Telegram or Discord${webOk ? ' — or the web chat, for people you trust' : ''}.</span>`)}
      ${run ? row('Copy or share', `${B('📤 Share a copy', onAction('click', 'shareTemplate', [`${a.id}`, `${a.name}`]), 'title="A copy of its instructions and scheduled tasks, without its bot, members or conversations. Read it before you send it: an agent may have written names or addresses into its instructions."')}
        ${appConfig.authMode === 'identity' ? B('📨 Send to someone here', onAction('click', 'openSendAgent', [`${a.id}`, `${a.name}`])) : ''}
        ${B('⧉ Clone', onAction('click', 'cloneAgent', [`${a.id}`, `${a.name}`]))}
        ${a.parameters?.length && !a.parentAgentId ? B('👪 New child', onAction('click', 'deriveChild', [`${a.id}`, `${a.name}`])) : ''}
        ${agents.some(k => k.parentAgentId === a.id) ? B('📥 Proposals', onAction('click', 'openProposals', [`${a.id}`, `${a.name}`])) + B('⬇ Push to children', onAction('click', 'pushDefinition', [`${a.id}`, `${a.name}`])) : ''}
        ${a.parentAgentId ? B('💡 Propose to master', onAction('click', 'distillToMaster', [`${a.id}`, `${a.name}`])) : ''}`) : ''}
      ${slot('paneEditPeers')}
      ${built ? row('Access', `<div id="v2Access" data-agent="${esc(a.id)}" style="flex-basis:100%"><div class="sub">Loading…</div></div>`) : ''}`;
    }
    case 'usage': return (v2Mine(a) && a.state !== 'ARCHIVED' ? `<div id="v2RecBody" data-agent="${esc(a.id)}" hidden></div>` : '')
      + (v2Mine(a) && a.state !== 'ARCHIVED' ? row('Spending', `<div id="v2BudgetRow" data-agent="${esc(a.id)}" style="flex-basis:100%"><div class="sub">Loading…</div></div>`) : '')
      + (run ? `<div id="v2UsageBody" style="padding:4px 2px">Loading…</div>`
      : row('Usage', `<span>${v2NotRunning(a, 'its figures')} They are read from its container; Usage still counts what it used while running.</span>`));
    case 'schedule': return run ? slot('cronBody') : row('Scheduled tasks', `<span>${v2NotRunning(a, 'its tasks')}</span>`);
    case 'files': return built ? `<div id="v2Files" data-agent="${esc(a.id)}"><div class="sub">Loading…</div></div>`
      : row('Files', '<span>Nothing is built yet.</span>');
    case 'advanced': return `
      ${row('Machine', `<span>${esc(host ? (host.kind === 'local' ? (host.hostname || host.name) : host.name) : '—')}</span>
        ${(run || a.state === 'STOPPED') && built && hosts.length > 1 ? B('Move…', onAction('click', 'moveHostAgent', [`${a.id}`, `${a.name}`])) : ''}`)}
      ${built ? row('Runtime', `${run || a.state === 'STOPPED' ? B('Rebuild', onAction('click', 'rebuild', [`${a.id}`]), 'title="New container, memory kept"') : ''}
        ${run && a.hasGateway ? B('OpenClaw console', onAction('click', 'v2Close openGateway', [[], [`${a.id}`, `${a.slug ?? ''}`]])) : ''}
        <div data-v2slot="imagePinRow" style="flex-basis:100%"></div>
        <div data-v2slot="embedModeRow" style="flex-basis:100%"></div>
        <div data-v2slot="memoryCapRow" style="flex-basis:100%"></div>`) : ''}
      ${a.state !== 'ARCHIVED' ? row('Voice', `<div id="v2Voice" data-agent="${esc(a.id)}" style="flex-basis:100%"><span class="sub">Checking browser Talk…</span></div>`) : ''}
      ${!a.ops ? row('Skills', `<div id="v2Skills" data-agent="${esc(a.id)}" style="flex-basis:100%"><span class="sub">Reading the curated skill selection…</span></div>`) : ''}
      ${built && a.state !== 'ARCHIVED' ? row('Sleep & files', `${a.ops || v2ChannelKinds(a).some(k => k !== 'telegram') ? `<span class="sub">${a.ops ? 'The manager never sleeps.' : 'On Discord or Slack it never sleeps (nothing queues their messages).'}</span>` : `<label style="margin:0">Sleep when idle <select id="v2Sleep" data-saves ${onAction('change', 'v2SetSleep', [`${a.id}`, { $: 'value' }])}>
          <option value=""${a.hibernate === 'never' ? '' : ' selected'}>as the machine does</option><option value="never"${a.hibernate === 'never' ? ' selected' : ''}>never — stay awake</option></select></label>`}
        <label style="margin:0">Files it may send or receive <select id="v2FilesCap" data-saves ${onAction('change', 'v2SetFilesCap', [`${a.id}`, { $: 'value' }])}>
          ${[...new Set(['', 5, 10, 25, 50, 100, ...(a.filesMaxMb ? [a.filesMaxMb] : [])])].map(v => `<option value="${v}"${(a.filesMaxMb ?? '') === v ? ' selected' : ''}>${v ? `up to ${v} MB` : 'as the machine does'}</option>`).join('')}</select></label>
        <div class="sub" style="flex-basis:100%">Each app still caps it at its own limit: Telegram 50 MB, a Discord server without boosts 10 MB. On Discord it limits only what it sends.</div>`) : ''}
      ${built && a.state !== 'ARCHIVED' && !a.ops ? row('Browser', `<label style="margin:0">Its own browser <select id="v2Browser" data-saves ${onAction('change', 'v2SetBrowserFrom', [`${a.id}`, { $: 'el' }])}>
          <option value="off"${a.browser ? '' : ' selected'}>Off</option><option value="on"${a.browser ? ' selected' : ''}>On</option></select></label>
        <span class="sub" id="v2BrowserState"></span>
        ${a.browser && run ? B('Sign in to a site…', onAction('click', 'bpOpen', [`${a.id}`]), 'id="v2BrowserSignIn" title="See its browser and sign it in to a site yourself"') : ''}
        ${a.browser ? `<label style="margin:0">Keep its logins <select id="v2BrowserKeep" data-saves ${onAction('change', 'v2SetKeepLoginsFrom', [`${a.id}`, { $: 'el' }])}>
          <option value="off"${a.keepsLogins ? '' : ' selected'}>Off</option><option value="on"${a.keepsLogins ? ' selected' : ''}>On</option></select></label>` : ''}
        ${a.keepsLogins ? B('Forget logins', onAction('click', 'v2ForgetLogins', [`${a.id}`]), 'id="v2BrowserForget" title="Its browser starts again, signed in nowhere"') : ''}
        <div class="sub" id="v2BrowserSites" style="flex-basis:100%" hidden></div>
        <div class="sub" style="flex-basis:100%">A Chromium of its own that it can open pages in, click and fill forms — for sites it must use, not for looking things up (web search is far cheaper: one browsing question can take 300K tokens). It runs beside the agent, with none of its files, up to 1 GB. <b>Sign in to a site</b> shows you its browser, to sign it in yourself (or past a cookie banner or a CAPTCHA); a sign-in lasts until the agent restarts. <b>Keep its logins</b> keeps them on this machine until you forget them, never in a backup or a download.</div>`) : ''}
      ${(run || a.state === 'STOPPED') && built ? row('Backup', B('Download copy', onAction('click', 'downloadAgent', [`${a.id}`, `${a.name}`]), 'title="A complete private copy: keep it, do not share it"')) : ''}
      ${built ? row('Recovery', `<div id="v2RecoveryRow" data-agent="${esc(a.id)}" style="flex-basis:100%;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:baseline"><span class="sub">Loading…</span></div>`) : ''}
      ${a.state !== 'ARCHIVED' ? slot('paneEditEnv') : ''}
      ${(run || a.state === 'STOPPED') && built ? `<h4 class="v2sec" id="v2BetweenServers">Between servers</h4>${row('Another Hatchabot', `${B('Move to another Hatchabot', onAction('click', 'rehostAgent', [`${a.id}`, `${a.name}`]))}
        <span class="sub">Only for a second Hatchabot server with its own dashboard (⚙ Settings → Advanced). To run it on another computer under this one, add that computer as a runner and use <b>Move…</b> on its Machine row.</span>`)}` : ''}
`;
  }
  return '';
}

/** What a chat-app change does to the agent now, in a confirm: a running one rebuilds, one that is not running stays so (HB-0420). */
function chanApplyNote(id) {
  const a = agents.find(x => x.id === id);
  return !a || a.state === 'RUNNING' ? 'It rebuilds now — anything it is doing stops. It restarts to apply this.'
    : a.state === 'STOPPED' ? `It stays ${a.hibernatedAt ? 'asleep' : 'stopped'}; this applies when it next starts.` : 'It restarts to apply this.';
}
async function v2AddTelegram(id, withToken) {
  const body = {};
  if (withToken) {
    body.token = $('v2TgTokenIn').value.trim();
    if (!body.token) return toast('Paste the token from @BotFather first.');
  }
  if (!confirmRebuild(id, 'Connecting Telegram')) return;
  try {
    const r = await api(`/v1/agents/${id}/telegram`, { method: 'POST', body });
    // The token is used: out of the box, which then holds nothing unsaved, so the tab is
    // drawn again for the agent's new state (HB-0475).
    if (withToken && $('v2Chans')?.dataset.agent === id && $('v2TgTokenIn')) $('v2TgTokenIn').value = '';
    toast(r.atNextStart ? `Connected @${r.username}. It stays down, and answers there once it next starts (memory kept).` : `Connected @${r.username} — rebuilding so it answers there (memory kept).`, 6000);
    await refresh(false);
  } catch (e) {
    // No spare to take: the box for a token of their own. Read from the answer, not its words: a spare that
    // went back to the pool while it was connected says "pool" too, and its "Try again" was never shown.
    if (e.data?.needsToken && !withToken) { $('v2TgToken').hidden = false; $('v2TgTokenIn').focus(); return; }
    toast(e.message, 8000);
  }
}
async function v2RemoveTelegram(id, name, bot) {
  if (!confirm(`Detach @${bot} from "${name}"?\n\nIt keeps everything it knows, and you keep talking to it here. People who reach it on Telegram lose access and get a goodbye message. The bot goes back to your pool for another agent. ${chanApplyNote(id)}`)) return;
  try {
    const r = await api(`/v1/agents/${id}/telegram`, { method: 'DELETE' });
    toast(`@${bot} is back in your pool.${r?.atNextStart ? ' It stays down; this applies when it next starts.' : ''}`, 6000);
    await refresh(false);
  } catch (e) { toast(e.message, 8000); }
}
