// web/app/start.js: the icon picker, the theme and the account menu, Report a problem, dialogs as panels (v2ConvertPanels), and the start (initV2, then loadConfig and refresh).
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- icon picker ---------------------------------------------------------------------
const V2_EMOJI = ['📈', '💹', '🧾', '⚖️', '💰', '🏢', '🏡', '🚗', '✈️', '🧭', '📅', '✅', '☑️', '🍳', '🥗', '🏃', '🩺', '🛡️',
  '💻', '🖥️', '🏛️', '🎓', '📚', '🎮', '📺', '💼', '🚀', '💡', '🎨', '🎵', '💐', '🎤', '📰', '🌮', '🌴', '🤖'];
let v2IconFor = null, v2IconColor = null;
/** Each opening of the dialog: a save that ends after it was closed and opened again leaves the new opening alone (HB-0367). */
let v2IconGen = 0;
/** Ideas the AI gave in this opening of the dialog: all on show, and left out of the next ask. */
let v2IconIdeasShown = [];
function openV2Icon(id) {
  const a = v2Find(id); if (!a) return;
  v2IconFor = id; v2IconColor = a.iconColor || v2ColorFor(a.name); v2IconGen++;
  // A save from an earlier opening may still be going: its button is this one's.
  $('v2IconSaveBtn').disabled = false;
  $('v2IconName').textContent = a.name;
  $('v2IconInput').value = a.icon || '';
  $('v2IconErr').textContent = '';
  $('v2IconWant').value = '';
  v2IconIdeasShown = [];
  $('v2IconIdeas').innerHTML = ''; $('v2IconIdeasBox').hidden = true; $('v2IconNote').textContent = '';
  $('v2IconAutoBtn').textContent = '✨ Ideas from Hatchabot';
  $('v2IconAutoBtn').disabled = false;
  $('v2EmojiRow').innerHTML = V2_EMOJI.map(e => `<button type="button" data-emoji="${e}" aria-label="${e}">${e}</button>`).join('');
  v2RenderSwatches();
  v2IconPreview();
  v2IconDlg.showModal();
}
$('v2EmojiRow').addEventListener('click', (e) => {
  const b = e.target.closest('[data-emoji]'); if (!b) return;
  $('v2IconInput').value = b.dataset.emoji; v2IconPreview();
});
$('v2IconIdeas').addEventListener('click', (e) => {
  const b = e.target.closest('[data-emoji]'); if (!b) return;
  $('v2IconInput').value = b.dataset.emoji;
  v2IconColor = b.dataset.color;
  v2RenderSwatches(); v2IconPreview();
});
function v2RenderSwatches() {
  $('v2Swatches').innerHTML = V2_PALETTE.map(c => `<button type="button" data-color="${c}" style="background:${c}" aria-label="Colour ${c}" aria-pressed="${c === v2IconColor}"></button>`).join('');
}
$('v2Swatches').addEventListener('click', (e) => {
  const b = e.target.closest('[data-color]'); if (!b) return;
  v2IconColor = b.dataset.color; v2RenderSwatches(); v2IconPreview();
});
function v2IconPreview() {
  const a = v2Find(v2IconFor); if (!a) return;
  const icon = $('v2IconInput').value.trim();
  $('v2IconPreview').innerHTML = v2IconHTML({ ...a, icon: icon || undefined, iconColor: v2IconColor }, { glyph: '' });
  for (const b of $('v2IconIdeas').querySelectorAll('[data-emoji]')) b.setAttribute('aria-pressed', String(b.dataset.emoji === icon && b.dataset.color === v2IconColor));
}
async function v2IconSave(btn) {
  const icon = $('v2IconInput').value.trim();
  const id = v2IconFor, gen = v2IconGen;
  const here = () => gen === v2IconGen && v2IconDlg.open;
  btn.disabled = true;
  try {
    await api(`/v1/agents/${id}`, { method: 'PATCH', body: { icon: icon || null, iconColor: v2IconColor } });
    if (here()) v2IconDlg.close();
    await refresh(false);
  } catch (e) {
    const why = /single emoji/.test(e.message) ? 'That isn’t a single emoji. Pick one above, or paste just one.' : e.message;
    if (here()) $('v2IconErr').textContent = why; else toast(`The icon was not saved: ${why}`, 10000);
  }
  // Opened again since, the button is that opening's: its own save turns it back on.
  finally { if (gen === v2IconGen) btn.disabled = false; }
}
/** The ✨ button: ideas to choose from, added to those already on show; nothing is saved until Save. */
async function v2IconIdeas(btn) {
  const id = v2IconFor, gen = v2IconGen, person = pagePerson;
  const here = () => gen === v2IconGen && v2IconFor === id && v2IconDlg.open && person === pagePerson && !pagePersonAway && !pageSignedOut;
  btn.disabled = true; btn.textContent = 'Thinking…';
  $('v2IconErr').textContent = '';
  try {
    const current = $('v2IconInput').value.trim();
    const want = $('v2IconWant').value.trim();
    const r = await api(`/v1/agents/${id}/icons/suggest`, { method: 'POST', body: { exclude: [...new Set([...v2IconIdeasShown, ...(current ? [current] : [])])], ...(want ? { want } : {}) } });
    if (!here()) return;
    const ideas = r.ideas || [];
    v2IconIdeasShown.push(...ideas.map(i => i.icon));
    $('v2IconIdeas').insertAdjacentHTML('beforeend', ideas.map(i =>
      `<button type="button" data-emoji="${esc(i.icon)}" data-color="${esc(i.color)}" style="--tint:${esc(i.color)}" aria-label="${esc(i.icon)}" aria-pressed="false">${esc(i.icon)}</button>`).join(''));
    $('v2IconIdeasBox').hidden = !v2IconIdeasShown.length;
    $('v2IconNote').textContent = r.via === 'keywords'
      ? (r.why === 'no-ai' ? 'None of your AI sources can make ideas (that takes a Claude source of your own, in ⚙ Settings)'
        : r.why === 'ai-no-ideas' ? 'The management AI answered, but no ideas could be read from its answer'
        : 'The management AI didn’t answer (busy, or out of its limit)')
        + (ideas.length ? `, so these come from ${want ? 'your words and ' : ''}its name. ` : '. ')
        + 'You can also paste any emoji in the box above.'
      : ideas.length ? 'Pick one, then Save. Press ✨ again for different ones.'
      : 'No new ideas this time. Paste any emoji in the box above, or pick from the row below.';
    v2IconPreview();
  } catch (e) { if (here()) $('v2IconErr').textContent = e.message; }
  finally { if (gen === v2IconGen) { btn.disabled = false; btn.textContent = v2IconIdeasShown.length ? '✨ More ideas' : '✨ Ideas from Hatchabot'; } }
}

// ---- the header's account menu ---------------------------------------------------------
function v2RenderWho() {
  // Guarded: a browser that blocks storage used to throw here, inside renderV2, and the home screen never drew (audit, 2026-10-23).
  let remembered = ''; try { remembered = localStorage.getItem('hatchabot_email') || ''; } catch {}
  const email = myAccount.email || remembered;
  const mode = appConfig.authMode;
  const name = email || myAccount.username || (mode === 'password' ? 'This machine' : 'Signed in');
  const initial = (email || myAccount.username || 'H').trim()[0].toUpperCase();
  $('v2AvatarBtn').textContent = initial;
  $('v2AvatarBig').textContent = initial;
  $('v2WhoName').textContent = name;
  $('v2WhoSub').textContent = (mode === 'identity' ? 'Google account' : mode === 'accounts' ? 'Account on this machine' : 'Machine password')
    + (myAccount.hostOwner ? ' · runs this machine' : '');
  $('v2AvatarBtn').title = `${name} — account, appearance, sign out`;
}
function v2ToggleAccount(force) {
  const pop = $('v2AcctPop');
  const open = force ?? pop.hidden;
  if (open) v2RenderWho();
  pop.hidden = !open;
  $('v2AvatarBtn').setAttribute('aria-expanded', String(open));
  if (open) v2AcctItems()[0]?.focus();
}
function v2CloseAccount() { v2ToggleAccount(false); }
/** The account menu's items, in order, as the arrow keys walk them (the theme pair included). */
const v2AcctItems = () => [...$('v2AcctPop').querySelectorAll('[role^="menuitem"]')].filter(b => !b.hidden && !b.disabled && b.offsetParent !== null);
document.addEventListener('click', (e) => {
  if (!$('v2AcctPop').hidden && !e.target.closest('.v2acct')) v2CloseAccount();
});
document.addEventListener('keydown', (e) => {
  if ($('v2AcctPop').hidden) return;
  if (e.key === 'Escape') { v2CloseAccount(); $('v2AvatarBtn').focus(); return; }
  // A menu's keys (2026-10-09): Up and Down walk the items and wrap, Home and End jump.
  if (!$('v2AcctPop').contains(document.activeElement)) return;
  const items = v2AcctItems(), i = items.indexOf(document.activeElement);
  const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (j === undefined || !items.length) return;
  e.preventDefault();
  items[(j + items.length) % items.length].focus();
});
function v2SyncTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  $('v2ThemeDark').setAttribute('aria-checked', String(dark));
  $('v2ThemeLight').setAttribute('aria-checked', String(!dark));
}
function v2SetTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('theme', t); } catch {}
  syncThemeChrome();
  v2SyncTheme();
}

/**
 * Turn every panel into a v2 sheet: a header bar with ‹ Back and the panel's
 * own title (or title row, with whatever controls sit beside it), moved in
 * rather than copied, so ids and handlers inside keep working. Panels stay
 * open underneath what they open, so Back lands where you came from. Back
 * presses the panel's own Close/Cancel when it has one, so any tidy-up that
 * button does still runs.
 */
const V2_BACK_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
// ---- Report a problem (docs/field-reports.md) ---------------------------------------------
// A private draft per person, written by them here or by the Hatchabot agent
// (prepare_problem_report). The server adds the facts and masks what must not
// be public; the person reads it all, then opens the GitHub issue themselves.
let reportCur = null;
// Each draft load (and each new report) numbered: only the newest paints, so
// a slow load of the draft clicked first cannot replace the one clicked last (#146).
let reportGen = 0, reportListRead = 0;
/** The draft the newest load is for, while it loads: a discard of that draft stops it painting (reportDiscard). */
let reportLoading = null;
async function openReport(id) {
  reportCur = null; const gen = ++reportGen; reportLoading = null;
  $('reportReview').hidden = true; $('reportForm').hidden = false;
  $('reportDrafts').replaceChildren();
  $('reportGatherBtn').disabled = false; $('reportGatherBtn').textContent = 'Gather the details';
  $('reportAgent').innerHTML = '<option value="">— none —</option>' + (agents ?? []).filter(a => a.state !== 'DELETED' && !a.ops)
    .map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if (!reportDlg.open) reportDlg.showModal();
  await reportLoadDrafts();
  if (gen !== reportGen || !reportDlg.open) return;
  if (id) await reportShow(id);
}
async function reportLoadDrafts() {
  const gen = reportGen, read = ++reportListRead, person = pagePerson;
  let list = [];
  try { list = await api('/v1/problem-reports'); } catch { /* none */ }
  if (gen !== reportGen || read !== reportListRead || person !== pagePerson || pagePersonAway || pageSignedOut || !reportDlg.open) return;
  // Opened on GitHub is not filed: this page cannot see Submit pressed there. So
  // one opened stays listed, marked, until it is discarded here (HB-0437).
  const open = [...list.filter(r => !r.sentAt).slice(0, 5), ...list.filter(r => r.sentAt).slice(0, 5)];
  $('reportDrafts').innerHTML = !open.length ? '' : '<div class="sub" style="margin-bottom:4px">Drafts</div>' + open.map(r =>
    `<button type="button" class="reportdraft" data-id="${esc(r.id)}" ${onAction('click', 'reportShow', [{ $: 'data', k: 'id' }])} style="display:flex;gap:8px;width:100%;text-align:left">
      <span class="grow">${esc(r.title)}</span><span class="sub">${r.by === 'agent' ? 'by your Hatchabot agent · ' : ''}${r.sentAt ? `opened on GitHub ${esc(ago(r.sentAt))}` : esc(ago(r.createdAt))}</span></button>`).join('');
}
function reportPaint(r) {
  reportCur = r;
  $('reportForm').hidden = true; $('reportReview').hidden = false;
  $('reportRTitle').value = r.title; $('reportBody').value = r.body;
  $('reportReviewNote').innerHTML = (r.sentAt ? `<b>You opened this on GitHub ${esc(ago(r.sentAt))}.</b> If you pressed Submit there it is filed, and Discard removes it from this list; if not, open it again. ` : '')
    + `${r.by === 'agent' ? '<b>Your Hatchabot agent wrote this.</b> Check its diagnosis reads right. ' : ''}`
    + '<b>Read every line:</b> it becomes a <b>public</b> issue on GitHub, and no automatic masking can make free text fully safe. '
    + 'Masked, in your edits too: keys and settings named like them, invite and reset codes, file paths (system folders like /usr stay, as far as nothing in them looks like yours), IP and MAC addresses, email addresses and phone numbers, your username, the names of your agents and their members, and your machines\' names and addresses. '
    + 'Not masked: a person, place or machine Hatchabot has no record of, a relative path, a word after a space in a path when nothing later on the line looks like a path, a program\'s name or a lowercase folder inside a system folder, a part of a name or a username that is also a common word, written in lowercase, or a password in plain words — edit those here. A sentence that names a second path can go with the first. Masks read like {path} or {name}.';
  // The playbook may already explain it: say so before anything is filed (2026-10-07).
  const known = r.known || [];
  $('reportKnown').hidden = !known.length;
  $('reportKnown').innerHTML = !known.length ? '' : '<b>⚠ This may be a known problem.</b> The troubleshooting playbook (docs/troubleshooting.md) has:'
    + '<ul style="margin:4px 0 0;padding-left:18px">' + known.map(k => `<li>${esc(k.title)}${k.fixedIn ? ` <span class="sub">— fixed in ${esc(k.fixedIn)}</span>` : ''}</li>`).join('') + '</ul>'
    + '<div class="sub" style="margin-top:4px">Check it first: if it is that problem, its fix applies and there is nothing to report.</div>';
  $('reportLinkNote').hidden = !r.trimmed;
  $('reportLinkNote').textContent = r.trimmed ? `It is too long for a GitHub link: Open on GitHub also saves ${r.fileName} — drag that file into the issue to attach the rest.` : '';
}
async function reportShow(id) {
  const gen = ++reportGen, person = pagePerson;
  reportLoading = id;
  const current = () => gen === reportGen && person === pagePerson && !pagePersonAway && !pageSignedOut;
  try { const r = await api(`/v1/problem-reports/${encodeURIComponent(id)}`); if (current()) reportPaint(r); }
  catch (e) { if (current()) toast(e.message); }
  finally { if (gen === reportGen) reportLoading = null; }
}
async function reportCreate() {
  const title = $('reportTitle').value.trim(), whatHappened = $('reportWhat').value.trim();
  if (!title || !whatHappened) { toast('Say what went wrong in a line, and what happened.'); return; }
  const btn = $('reportGatherBtn'); btn.disabled = true; btn.textContent = 'Gathering…';
  const gen = ++reportGen, person = pagePerson; reportLoading = null;
  const current = () => gen === reportGen && person === pagePerson && !pagePersonAway && !pageSignedOut;
  try {
    const r = await api('/v1/problem-reports', { method: 'POST', body: { title, whatHappened, ...($('reportAgent').value ? { agent: $('reportAgent').value } : {}) } });
    if (!current()) return;
    reportPaint(r);
    $('reportTitle').value = ''; $('reportWhat').value = '';
    void reportLoadDrafts();
  } catch (e) { if (current()) toast(e.message); }
  finally { if (gen === reportGen) { btn.disabled = false; btn.textContent = 'Gather the details'; } }
}
/**
 * Keep the person's edits before anything leaves the page. Words typed while it saved are a
 * newer edit: the answer does not replace them (HB-0585), and they are saved too before Copy,
 * Save as a file or Open on GitHub go on, which otherwise sent the report without them. Typed
 * through that second save as well, it stops and says so (null: nothing goes out).
 */
async function reportSaveEdits() {
  const person = pagePerson;
  let masked = false;
  for (let round = 1; reportCur; round++) {
    const sentTitle = $('reportRTitle').value, sentBody = $('reportBody').value;
    const title = sentTitle.trim() || reportCur.title, body = sentBody;
    if (title === reportCur.title && body === reportCur.body) break;
    if (round > 2) { toast('Your newest words are not saved yet: they were typed while it saved. Press it again.', 8000); return null; }
    // Another draft opened (or a new report begun) while this saved: the saved
    // one is still what the button pressed goes on with, but the page keeps the
    // one shown now and its text (review, 2026-10-22).
    const gen = reportGen;
    const saved = await api(`/v1/problem-reports/${encodeURIComponent(reportCur.id)}`, { method: 'PATCH', body: { title, body } });
    if (person !== pagePerson || pagePersonAway || pageSignedOut) return null;
    if (gen !== reportGen) return saved;
    reportCur = saved;
    // The server masks the edits too (private names, keys): show what will go
    // out, not what was typed (2026-10-10), in each field still as it was sent.
    if ($('reportRTitle').value === sentTitle && sentTitle.trim() !== saved.title) $('reportRTitle').value = saved.title;
    if ($('reportBody').value === sentBody && sentBody !== saved.body) $('reportBody').value = saved.body;
    if (saved.title !== title || saved.body !== body) masked = true;
  }
  if (masked) toast('Some of what you wrote was masked (a private name or key) — the report shows what will be sent.', 8000);
  return reportCur;
}
function reportFile(r) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`# ${r.title}\n\n${r.body}\n`], { type: 'text/markdown' }));
  a.download = r.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function reportSaveFile() { try { const r = await reportSaveEdits(); if (r) reportFile(r); } catch (e) { toast(e.message); } }
async function reportCopy() {
  try { const r = await reportSaveEdits(); if (!r) return; if (!(await copyText(`# ${r.title}\n\n${r.body}\n`))) throw new Error('The browser gave no clipboard here — select the text and copy it by hand.'); toast('Copied.'); }
  catch (e) { toast(e.message || 'Could not copy.'); }
}
async function reportOpenIssue() {
  // Opened first, from the click itself: a window opened after an await is a popup browsers block.
  const win = window.open('about:blank', '_blank');
  try {
    const r = await reportSaveEdits(); if (!r) { win?.close(); return; }
    if (r.trimmed) reportFile(r);
    if (win) { win.opener = null; win.location.href = r.issueUrl; } else location.href = r.issueUrl;
    await api(`/v1/problem-reports/${encodeURIComponent(r.id)}/sent`, { method: 'POST' }).catch(() => {});
    toast(r.trimmed ? 'GitHub opened in a new tab — attach the saved file there, then press Submit.' : 'GitHub opened in a new tab: check it there and press Submit.', 8000);
    void reportLoadDrafts();
  } catch (e) { win?.close(); toast(e.message); }
}
async function reportDiscard() {
  const r = reportCur;
  if (!r) return;
  // Asked first, like every other delete: a draft (the agent's too) is gone for good (review, 2026-10-09).
  if (!confirm(`Discard the draft "${r.title || 'this report'}"? It is deleted, and cannot be brought back.`)) return;
  const gen = reportGen;
  // Only "gone already" (404) counts as discarded: any other failure left the
  // draft on the server while the page showed it gone (#145).
  try { await api(`/v1/problem-reports/${encodeURIComponent(r.id)}`, { method: 'DELETE' }); }
  catch (e) { if (e.status !== 404) { toast(`The draft was not discarded: ${e.message}`, 8000); return; } }
  // Closed only while it is still the one shown: another draft opened, or a report begun, as it
  // was deleted stays open, with what is typed in it (HB-0586). The list is read again either way.
  // The deleted draft itself, opened again while it was deleted, closes too: nothing is left to
  // show. A load of it begun meanwhile is stopped (it would paint a draft that is gone); a load of
  // another draft is not: it paints when it comes.
  const shown = reportCur?.id === r.id, loading = reportLoading === r.id;
  if (loading || (shown && reportGen === gen)) { reportGen++; reportLoading = null; }
  if (shown) { reportCur = null; $('reportReview').hidden = true; $('reportForm').hidden = false; }
  void reportLoadDrafts();
}
/** The agent's link (…/#report=<id>): open that draft once signed in, and take it out of the address bar. */
function reportFromHash() {
  const id = /(?:^#|&)report=([0-9a-f-]{8,40})(?:&|$)/i.exec(location.hash)?.[1];
  if (!id) return;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* keep going */ }
  void openReport(id);
}
addEventListener('hashchange', reportFromHash);

function v2ConvertPanels() {
  // recoveryDlg: a secret shown once stays until it is saved — no Back arrow.
  // bpDlg: the sign-in panel is the console's kind of window, the agent's browser filling it.
  const skip = new Set(['loginDlg', 'consoleDlg', 'bpDlg', 'v2AgentDlg', 'recoveryDlg', 'sfDlg', 'backupDlg']);
  for (const d of document.querySelectorAll('dialog')) {
    if (skip.has(d.id) || d.classList.contains('v2panel')) continue;
    d.classList.add('v2panel');
    const bar = document.createElement('div');
    bar.className = 'v2pbar';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'v2pback';
    back.title = 'Back';
    back.setAttribute('aria-label', 'Back');
    back.innerHTML = V2_BACK_SVG;
    // The panel's own Cancel/Done, found NOW, in the static markup: a list row
    // rendered later can carry a ✕ that deletes something, and Back pressing
    // that was a real bug (it offered to forget a cluster server).
    const own = [...d.querySelectorAll('button')].reverse()
      .find(x => x !== back && /^(Close|Cancel|Done)$/.test(x.textContent.trim()));
    back.addEventListener('click', () => {
      if (own && !own.hidden && d.contains(own)) own.click(); else d.close();
    });
    const title = document.createElement('div');
    title.className = 'v2ptitle';
    const first = d.firstElementChild;
    if (first && (/^H[23]$/.test(first.tagName) || (first.tagName === 'DIV' && first.querySelector(':scope > h3, :scope > h2')))) {
      title.append(first);
    }
    bar.append(back, title);
    d.prepend(bar);
    // A bottom "Close" that only closes the panel repeats Back; hide it. Ones
    // that do more (tidy-up, saving) stay, and Back presses them.
    for (const b of d.querySelectorAll('button')) {
      if (/^(Close|Done)$/.test(b.textContent.trim()) && (b.getAttribute('onclick') || '').trim() === `${d.id}.close()`) {
        b.hidden = true;
        const row = b.parentElement;
        if (row?.classList.contains('actions') && ![...row.children].some(c => !c.hidden)) row.hidden = true;
      }
    }
  }
}
// ---- Status retired (Chris, 2026-10-05) ----------------------------------------------------
// Usage and Resources are header buttons opening their own panels; Activity is
// the home screen's last section; Health's machine facts (runners, backups,
// OpenClaw) are the machine line under it, its problems Alerts on the
// Hatchabot agent's tile; Tools went to Bulk actions (Rebuild all) and
// Settings → Hosts (memory search for every agent).


function initV2() {
  $('v2Ver').textContent = `Hatchabot v${window.HATCHABOT_VERSION ?? '?'}${DEV ? ' · dev' : ''}`;
  $('v2AppVer').textContent = `v${window.HATCHABOT_VERSION ?? '?'}`;
  v2SyncTheme();
  addEventListener('scroll', () => $('v2Header').classList.toggle('scrolled', scrollY > 4), { passive: true });
  v2ConvertPanels();
  // The tasks panel's body, as one movable block for the agent sheet.
  const cronBody = document.createElement('div');
  cronBody.id = 'cronBody';
  for (const el of [...cronDlg.children]) if (!el.classList.contains('v2pbar')) cronBody.append(el);
  cronDlg.append(cronBody);
  // Bodies the Fleet panel and the Overview borrow, each as one movable block.
  const wrapBody = (dlg, id, withTitle) => {
    const body = document.createElement('div');
    body.id = id; body.dataset.v2from = dlg.id;
    const title = dlg.querySelector(':scope > .v2pbar .v2ptitle');
    if (withTitle && title) body.append(...title.childNodes); // their Refresh / filter rows
    for (const el of [...dlg.children]) if (!el.classList.contains('v2pbar')) body.append(el);
    dlg.append(body);
  };
  wrapBody(healthDlg, 'healthDlgBody', false);
  // The voice and web-search keys are outside services an agent can use —
  // they sit with the Google accounts under Connections, not with AI sources.
  $('paneConn').insertAdjacentHTML('beforeend', '<h4 class="v2sec" id="extraKeysHead">Keys for extra abilities</h4>');
  $('paneConn').append($('mediaKeyDrawer'), $('searchKeyDrawer'));
  // Long introductions: two lines, with "More" to read the rest.
  for (const el of document.querySelectorAll('dialog > .sub, section > .sub:first-of-type, #cronBody > .sub, [id$="DlgBody"] > .sub')) {
    if (el.textContent.trim().length < 180 || el.querySelector('input, select, button')) continue;
    el.classList.add('v2clamp');
    // Only offer "More" when there is more: two lines that happen to be long
    // got a button that revealed nothing.
    if (el.scrollHeight <= el.clientHeight + 1) { el.classList.remove('v2clamp'); continue; }
    const more = document.createElement('button');
    more.type = 'button'; more.className = 'v2more'; more.textContent = 'More';
    more.addEventListener('click', () => { const open = el.classList.toggle('v2open'); more.textContent = open ? 'Less' : 'More'; });
    el.after(more);
  }
  // Settings: head each pane so a merged tab reads as sections.
  // Derived images get their own tab: move their section into a pane of its own.
  $('paneRuntime').insertAdjacentHTML('afterend', '<section id="paneV2Derived" role="tabpanel" hidden><div class="sub v2ownernote">Derived images are managed by the account that set up this machine.</div></section>');
  $('paneV2Derived').append($('derivedSection'));
  TABS.derived = 'paneV2Derived';
  for (const [key, text] of Object.entries(V2_SETTINGS_HEAD)) {
    $(TABS[key])?.insertAdjacentHTML('afterbegin', `<h4 class="v2sec v2settingshead" hidden>${esc(text)}</h4>`);
  }
  $('v2ClassicMap').hidden = !CLASSIC_WAS_ON;
  $('consoleGearBtn').hidden = false;
  $('consoleGearBtn').onclick = () => { const id = consoleAgentId; closeConsole(); openV2Agent(id); };
  void loadProposals();
}
initV2();
initSettingsAdvanced();

loadConfig(); // whoami + auth mode even when the cookie is already valid
refresh(true);
