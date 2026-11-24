// web/app/console.js: console tabs, the quick switcher and the console dialog.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- Console tabs and the quick switcher (Chris, 2026-10-07) ------------------
// One frame per open agent, so switching is instant and keeps its place. At
// most CONSOLE_LIVE frames stay loaded; the least recently used unloads (its
// tab stays, and loads again when picked). Closing the console window still
// unloads them all, so no WebSocket or token outlives the panel; the tab list
// itself is remembered on this device.
const CONSOLE_TABS_KEY = 'hb-console-tabs', CONSOLE_LIVE = 5;
let consoleTicket = 0, consoleOpening = 0, consoleHashTried = false;
let consoleTabs = []; // { id, slug, frame?, url?, used }
function consoleSaveTabs() { try { localStorage.setItem(CONSOLE_TABS_KEY, JSON.stringify(consoleTabs.map(t => t.id))); } catch {} }
function consoleSavedTabIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(CONSOLE_TABS_KEY) || '[]');
    return Array.isArray(ids) ? [...new Set(ids.filter(id => typeof id === 'string'))] : [];
  } catch { return []; }
}
const consoleOpenable = (a) => a && a.state !== 'ARCHIVED' && a.state !== 'DELETED' && a.state !== 'DELETING' && (a.role ? a.role === 'owner' : true);
/** This agent's tab and frame, made if needed, and shown. The frame shown is the one with id consoleFrame. */
function consoleTabFor(id, slug) {
  if (consoleGuest || !$('consoleDlg').open) consoleUnloadAll();
  if (!$('consoleDlg').open && !consoleTabs.length) {
    // Bring back the tabs this device had open (they load when picked).
    consoleTabs = consoleSavedTabIds().map(x => (agents || []).find(a => a.id === x)).filter(consoleOpenable).map(a => ({ id: a.id, slug: a.slug, used: 0 }));
  }
  let t = consoleTabs.find(x => x.id === id);
  if (!t) { t = { id, slug, used: 0 }; consoleTabs.push(t); }
  if (!t.frame) {
    const f = document.createElement('iframe');
    f.title = 'Agent console'; f.src = 'about:blank';
    f.addEventListener('load', () => { try { f.contentWindow.addEventListener('keydown', consoleKeys); } catch { /* not ours to listen to */ } });
    $('consoleFrames').append(f);
    t.frame = f;
  }
  consoleShow(id);
  // Too many loaded: unload the one used longest ago (never the one just picked).
  const live = consoleTabs.filter(x => x.frame && x.id !== id).sort((x, y) => x.used - y.used);
  while (live.length >= CONSOLE_LIVE) consoleUnload(live.shift());
  consoleSaveTabs();
  return t;
}
/**
 * A console's own address (Chris, 2026-10-07): …/#console=<slug> opens Hatchabot
 * on that agent's console, and can be bookmarked. While a console is shown the
 * address bar carries it (replaced, never a history entry), so a reload comes
 * back to it; the browser tab is named after it. Hatchabot's address, never the
 * frame's: a gateway not rebuilt takes its token in the frame's fragment (HB-0023).
 * The console's "New tab" button, which opened this address, is gone (the owner,
 * 2026-11-09: it only opened the same conversation again).
 */
let consolePageTitle = null;
function consoleMark(id) {
  const a = (agents || []).find(x => x.id === id);
  if (!a || consoleGuest) return;
  const key = a.slug || a.id;
  try { history.replaceState(null, '', `${location.pathname}${location.search}#console=${encodeURIComponent(key)}`); } catch { /* keep going */ }
  if (consolePageTitle === null) consolePageTitle = document.title;
  document.title = `${a.name} · Hatchabot`;
}
function consoleUnmark() {
  if (/(?:^#|&)console=/.test(location.hash)) { try { history.replaceState(null, '', location.pathname + location.search); } catch {} }
  if (consolePageTitle !== null) { document.title = consolePageTitle; consolePageTitle = null; }
}
/** The address's agent (by slug, or id), once signed in and the agents are loaded. */
function consoleFromHash() {
  // A malformed address (#console=%E0) is no agent, not an exception (review, 2026-10-09).
  let key = '';
  try { key = decodeURIComponent(/(?:^#|&)console=([^&]+)/.exec(location.hash)?.[1] || ''); } catch { key = ''; }
  if (!key) return;
  const a = (agents || []).find(x => (x.slug === key || x.id === key) && consoleOpenable(x));
  if (!a) { consoleUnmark(); toast(`No agent of yours called "${key}" to open.`); return; }
  if ($('consoleDlg').open && consoleAgentId === a.id) return;
  void openGateway(a.id, a.slug);
}
addEventListener('hashchange', consoleFromHash);
function consoleShow(id) {
  $('consoleApproveBtn').disabled = false;
  // The old lone frame, before any tab owned it.
  for (const f of $('consoleFrames').querySelectorAll('iframe')) if (!consoleTabs.some(t => t.frame === f)) f.remove();
  for (const t of consoleTabs) {
    if (!t.frame) continue;
    const on = t.id === id;
    if (!on && !t.frame.hidden) consoleStopTalk(t);
    if (!t.frame) continue;
    t.frame.hidden = !on;
    if (on) { t.frame.id = 'consoleFrame'; t.used = Date.now(); try { localStorage.setItem('hb-console-last', id); } catch {} } else t.frame.removeAttribute('id');
  }
  $('consoleCover').hidden = true;
}
/** Keep ordinary chat tabs loaded, but retire a voice call before its controls disappear. */
function consoleStopTalk(t) {
  const frame = t.frame;
  if (!frame) return;
  const unload = () => { if (t.frame === frame) { consoleUnload(t); renderConsoleTabs(); } };
  let stop;
  try {
    stop = frame.contentWindow?.__hatchabotStopTalk;
    if (typeof stop !== 'function') {
      // A document loaded before the shim changed can still have an active call.
      const active = [...(frame.contentDocument?.querySelectorAll('openclaw-chat-pane') || [])]
        .some(p => p.state?.realtimeTalkSession || p.state?.realtimeTalkActive);
      if (active) unload();
      return;
    }
  } catch { return; } // a foreign/error document cannot expose the same-origin Talk controller
  try {
    const result = stop();
    if (!result?.stopped) unload();
    void Promise.resolve(result?.done).then(ok => { if (!ok) unload(); }).catch(unload);
  } catch { unload(); }
}
function consoleUnload(t) { if (!t?.frame) return; t.frame.src = 'about:blank'; t.frame.remove(); t.frame = null; t.url = null; }
function consoleUnloadAll() {
  for (const t of consoleTabs) consoleUnload(t);
  // One empty frame keeps $('consoleFrame') valid for whoever opens next (a guest's single console).
  if (!$('consoleFrame')) $('consoleFrames').insertAdjacentHTML('afterbegin', '<iframe id="consoleFrame" title="Agent console" src="about:blank"></iframe>');
  else $('consoleFrame').src = 'about:blank';
}
/**
 * Switch to an agent already loaded in a tab. False when it has to be opened. `view`: a named
 * destination (openGateway's), which navigates even a loaded tab, before what is shown counts as read.
 */
function consoleSwitchTo(id, view) {
  const t = consoleTabs.find(x => x.id === id);
  if (!$('consoleDlg').open || consoleGuest || !t?.frame || !t.url) return false;
  consoleTicket++; // an open still waiting on the network is no longer wanted
  consoleShow(id);
  const a = (agents || []).find(x => x.id === id);
  if (view) { t.url = consoleViewUrl(id, t.slug, view, t.url); t.frame.src = t.url; }
  consoleAgentId = id; consoleUrl = t.url;
  $('consoleTitle').textContent = a?.name || t.slug;
  $('consoleGearBtn').style.display = '';
  $('consoleApproveBtn').hidden = true;
  $('consoleProps').hidden = true;
  renderConsoleChannels(a);
  renderConsoleTabs();
  consoleMark(id);
  markConsoleSeen(id);
  return true;
}
function closeConsoleTab(id) {
  const i = consoleTabs.findIndex(t => t.id === id);
  if (i < 0) return;
  if (consoleAgentId !== id && consoleTabs[i].frame && !consoleTabs[i].url) consoleAgentId = id; // still opening: it is the one showing
  consoleUnload(consoleTabs[i]);
  consoleTabs.splice(i, 1);
  consoleSaveTabs();
  if (consoleAgentId !== id) { renderConsoleTabs(); return; }
  const next = consoleTabs.filter(t => t.frame && t.url).sort((x, y) => y.used - x.used)[0] ?? consoleTabs[Math.min(i, consoleTabs.length - 1)];
  if (!next) { closeConsole(); return; }
  void openGateway(next.id, next.slug);
}
function renderConsoleTabs() {
  const box = $('consoleTabs');
  box.hidden = consoleGuest || !consoleTabs.length;
  $('consoleAddTab').hidden = consoleGuest;
  box.innerHTML = consoleTabs.map(t => {
    const a = (agents || []).find(x => x.id === t.id);
    const name = a?.name || t.slug, on = t.id === consoleAgentId;
    return `<div class="ctab${on ? ' on' : ''}${t.frame ? '' : ' cold'}" role="tab" aria-selected="${on}">`
      + `<button type="button" class="ctabgo" data-id="${esc(t.id)}" title="${esc(name)}${t.frame ? '' : ' — loads when opened'}"><span>${esc(name)}</span>${a?.unread && !on ? '<i class="cdot" aria-label="new reply"></i>' : ''}</button>`
      + `<button type="button" class="ctabx" data-x="${esc(t.id)}" aria-label="Close ${esc(name)}">×</button></div>`;
  }).join('');
  box.querySelector('.ctab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
$('consoleTabs')?.addEventListener('click', (e) => {
  const x = e.target.closest('[data-x]'); if (x) { closeConsoleTab(x.dataset.x); return; }
  const go = e.target.closest('[data-id]'); if (!go) return;
  const t = consoleTabs.find(y => y.id === go.dataset.id); if (t) void openGateway(t.id, t.slug);
});

let cswSel = 0;
function openConsoleSwitcher() {
  if (consoleGuest) return;
  $('consoleSwitcher').hidden = false;
  $('cswInput').value = ''; cswSel = 0;
  renderConsoleSwitcher();
  $('cswInput').focus();
}
function closeConsoleSwitcher() { $('consoleSwitcher').hidden = true; }
function consoleSwitcherItems() {
  const q = $('cswInput').value.trim().toLowerCase();
  const open = new Set(consoleTabs.map(t => t.id));
  return (agents || []).filter(a => consoleOpenable(a) && (!q || a.name.toLowerCase().includes(q)))
    .sort((x, y) => (open.has(y.id) - open.has(x.id)) || x.name.localeCompare(y.name, 'en', { numeric: true }))
    .slice(0, 14);
}
function renderConsoleSwitcher() {
  const items = consoleSwitcherItems();
  cswSel = Math.max(0, Math.min(cswSel, items.length - 1));
  const open = new Set(consoleTabs.map(t => t.id));
  $('cswList').innerHTML = items.length ? items.map((a, i) =>
    `<button type="button" role="option" data-id="${esc(a.id)}" class="${i === cswSel ? 'sel' : ''}"><span>${esc(a.name)}</span><span class="sub">${a.id === consoleAgentId ? 'open here' : open.has(a.id) ? 'in a tab' : a.hibernatedAt && a.state === 'STOPPED' ? 'asleep' : ''}</span></button>`).join('')
    : '<div class="sub" style="padding:6px 9px">No agent by that name.</div>';
  $('cswList').querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function consoleSwitcherPick(id) {
  const a = (agents || []).find(x => x.id === id); if (!a) return;
  closeConsoleSwitcher();
  void openGateway(a.id, a.slug);
}
$('cswInput')?.addEventListener('input', () => { cswSel = 0; renderConsoleSwitcher(); });
$('cswInput')?.addEventListener('keydown', (e) => {
  const items = consoleSwitcherItems();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cswSel = (cswSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1); renderConsoleSwitcher(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (items[cswSel]) consoleSwitcherPick(items[cswSel].id); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeConsoleSwitcher(); }
});
$('cswList')?.addEventListener('click', (e) => { const b = e.target.closest('[data-id]'); if (b) consoleSwitcherPick(b.dataset.id); });
$('consoleDlg')?.addEventListener('click', (e) => { if (!$('consoleSwitcher').hidden && !e.target.closest('#consoleSwitcher, #consoleTitle, #consoleAddTab')) closeConsoleSwitcher(); });
/** ⌘K / Ctrl+K opens the switcher — from the panel, from inside a console frame (same origin), and from the home screen. */
function consoleKeys(e) {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return;
  if ($('consoleDlg').open) { if (consoleGuest) return; e.preventDefault(); openConsoleSwitcher(); return; }
  if (document.querySelector('dialog[open]')) return; // another panel is in front
  e.preventDefault(); openConsoleHome(true);
}
/**
 * The header's Consoles button (Chris, 2026-10-07): back to the agent you were
 * talking to, its tabs with it. The first time, your Hatchabot agent, with the
 * switcher open to pick another.
 */
async function openConsoleHome(withSwitcher = false) {
  let last = null;
  try { last = localStorage.getItem('hb-console-last'); } catch {}
  const known = [last, ...consoleSavedTabIds()].map(id => (agents || []).find(a => a.id === id)).find(consoleOpenable);
  const pick = known || (agents || []).find(a => a.ops && consoleOpenable(a)) || (agents || []).find(consoleOpenable);
  if (!pick) { toast('No agent to open yet — make one with ＋ New.'); return; }
  await openGateway(pick.id, pick.slug);
  if ((withSwitcher || !known) && $('consoleDlg').open && !consoleGuest) openConsoleSwitcher();
}
document.addEventListener('keydown', consoleKeys);

// Esc closes a dialog without calling closeConsole(): blank the frame either
// way, or the console's WebSocket and token outlive the panel.
// The close event arrives a moment after close(): a console reopened in that
// gap keeps its frame — closeConsole() already unloaded the old ones.
$('consoleDlg')?.addEventListener('close', () => {
  markConsoleSeen(consoleSeenAgent());
  if ($('consoleDlg').open) return;
  consoleTicket++;
  // Only an address this console put there (Esc): after closeConsole() it is
  // gone already, and one in the bar now was set since — a #console= link
  // whose hashchange has not run yet, which clearing left unopened (2026-10-10).
  if (consolePageTitle !== null) consoleUnmark();
  closeConsoleSwitcher(); $('consoleProps').hidden = true;
  consoleUnloadAll(); $('consoleCover').hidden = true;
});

let consoleAgentId = null, consoleUrl = null, consoleGuest = false;
/**
 * A guest's console: the agent whose conversation it shows. consoleAgentId stays null there, so
 * nothing else of the owner's follows it; its seen mark is the guest's own, and does (HB-1139).
 */
let consoleGuestAgentId = null;
/** The agent whose chat the open console shows: the owner's, or the guest's own. */
const consoleSeenAgent = () => (consoleGuest ? consoleGuestAgentId : consoleAgentId);
/**
 * The console shows its chat (HB-1147): not covered (opening, connecting), and on the chat,
 * not another of its pages (its voice settings). By the address it was given, and where it is
 * now when this page may read that: it moves about in itself, and is blank while it loads.
 */
function consoleChatShown() {
  const fr = $('consoleFrame');
  if (!fr || !$('consoleCover').hidden) return false;
  const chat = (href) => /\/ui\/chat(?:[/?#]|$)/.test(href);
  if (!chat(fr.getAttribute('src') || '')) return false;
  try { const at = fr.contentWindow?.location?.href; return !!at && at !== 'about:blank' && chat(at); }
  catch { return true; } // a page this one may not read: the address it was given
}
/**
 * OpenClaw's pairing screen in a console frame: true or false by its page, undefined where this
 * page may not read it (HB-1135 review). Every language's screen names the `openclaw devices`
 * command it asks for; English also says "pairing required". Its open shadow roots are read too.
 */
function consolePairingShown(fr) {
  let doc = null;
  try { doc = fr?.contentDocument ?? null; } catch { /* not this page's to read */ }
  if (!doc) return undefined;
  const text = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) text.push(c.data);
      else if (c.nodeType === 1 && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE') { if (c.shadowRoot) walk(c.shadowRoot); walk(c); }
    }
  };
  if (doc.body) walk(doc.body);
  return /openclaw devices (?:list|approve)|pairing required/i.test(text.join(' '));
}
// What you can see in an open console's chat is read: once it shows, on close,
// and every 20 seconds in between (so a reply that lands while you watch never
// flags). Not its settings, nor while it is still opening (HB-1147).
function markConsoleSeen(id) {
  if (!id || (consoleGuest && id !== consoleGuestAgentId) || !consoleChatShown()) return;
  const a = (agents || []).find(x => x.id === id);
  if (a?.unread) { a.unread = false; renderV2(); }
  api(`/v1/agents/${id}/seen`, { method: 'POST' }).catch(() => {});
}
// Not while the browser tab is hidden: nobody is reading it then (review, 2026-10-09).
function consoleSeenTick() { if ($('consoleDlg')?.open && consoleSeenAgent() && !document.hidden) markConsoleSeen(consoleSeenAgent()); }
setInterval(consoleSeenTick, 20000);
document.addEventListener('visibilitychange', consoleSeenTick); // shown again: what is on screen is read

/**
 * OpenClaw's pairing screen looked for, for a minute: the Approve button while it shows (HB-1135).
 * A frame this page may not read gets the button.
 */
async function consolePairingWatch(frame, stillOurs) {
  for (let i = 0; i < 60 && stillOurs(); i++) {
    if (consolePairingShown(frame) !== false) { $('consoleApproveBtn').hidden = false; return; }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
/**
 * The console in a frame says it is connected to its gateway: OpenClaw's app's own word for it
 * (openclaw-app's gateway snapshot, as scripts/shared-host-console.mjs reads it). False where this
 * page may not read it, or it does not say: so a browser is remembered as approved only on what
 * was seen (HB-1278).
 */
function consoleConnected(fr) {
  try { return fr?.contentDocument?.querySelector('openclaw-app')?.context?.gateway?.snapshot?.phase === 'connected'; } catch { return false; }
}
/**
 * Nothing is waiting for approval now: another approval (another tab's, or this page's own) took
 * this browser's request first, so one that came back with nothing approved is no failure (HB-1134 review).
 * Only a definite 0: a read that failed (a 502, the server could not read the requests) is a failure,
 * the button and the reason, not "taken".
 */
async function consoleNothingWaiting(id) {
  try { return (await api(`/v1/agents/${id}/console/pending`)).pending === 0; } catch { return false; }
}

/**
 * Approve this browser without making anyone click. Opening the console IS the
 * consent: the gateway listens on loopback and the only way to it from another
 * machine is this owner-authenticated proxy, so a request that appears while
 * the panel is open was caused by the person looking at it. The request only
 * exists once the console has tried to connect, so watch for it briefly — and
 * only while this panel, for this agent, is still open.
 */
async function autoApproveConsole(id) {
  const frame = $('consoleFrame'), ticket = consoleTicket, epoch = voiceEpoch, person = pagePerson;
  const stillOurs = () => $('consoleDlg').open && consoleAgentId === id && $('consoleFrame') === frame && frame.isConnected
    && ticket === consoleTicket && epoch === voiceEpoch && person === pagePerson && !pagePersonAway && !pageSignedOut;
  if (!stillOurs()) return;
  // The first time this browser opens this agent, OpenClaw shows a "pairing
  // required" screen until it is approved. Cover it with our own calm
  // "Connecting…" so nobody has to look at that; a browser we've already seen
  // through skips the cover entirely.
  const known = (() => { try { return localStorage.getItem(`hb-console-ok:${id}`) === '1'; } catch { return false; } })();
  const remember = () => { try { localStorage.setItem(`hb-console-ok:${id}`, '1'); } catch {} };
  // Remembered once its console connected with no request: no request alone was a console still
  // loading too, and remembered then, a later open had no cover, and no button when it asked (HB-1278).
  const rememberConnected = () => { if (!known && consoleConnected(frame)) remember(); };
  const uncover = () => { if (stillOurs()) { $('consoleCover').hidden = true; markConsoleSeen(id); } };
  // A browser seen before keeps the "Opening…" spinner openGateway put up (it
  // goes when the frame has loaded); a new one is told about the approval.
  if (!known) consoleCoverSay('Connecting this browser…');
  // The watch ended with nothing approved: the button, which approves a request that comes later
  // (a console slow to load asks after the watch), HB-1135. Only while OpenClaw's pairing screen
  // shows: a console that asks for no pairing (behind a trusted proxy) shows none, and a button
  // there met only "Nothing is waiting". Looked for a minute more, as a slow first load shows it
  // late; a frame this page may not read gets the button.
  const manual = () => consolePairingWatch(frame, stillOurs);
  // Checking is cheap now (a 50 ms file read), so look often, for ~12 s.
  for (let i = 0; i < 40 && stillOurs(); i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (!stillOurs()) return;
    let pending = 0;
    try { pending = (await api(`/v1/agents/${id}/console/pending`)).pending || 0; } catch { uncover(); await manual(); return; }
    if (!stillOurs()) return;
    if (!pending) {
      // No request: approved before, or a console still loading. Shown after ~3 s.
      rememberConnected();
      if (i === 10) uncover();
      continue;
    }
    let r;
    try { r = await api(`/v1/agents/${id}/console/approve`, { method: 'POST', body: {} }); } catch { r = undefined; }
    if (!stillOurs()) return;
    // Nothing approved is no pairing, whatever the status: the button, not "seen through" (HB-1134);
    // unless another approval took this browser's request first, and nothing is waiting now.
    const taken = !r?.approved && await consoleNothingWaiting(id);
    if (!stillOurs()) return;
    if (!r?.approved && !taken) {
      // Couldn't do it for them — fall back to the button, which says why.
      uncover();
      $('consoleApproveBtn').hidden = false;
      return;
    }
    // Every request approved: this browser is, and is remembered. Some refused (`failed`), or taken
    // elsewhere: it may still be unpaired, so after the reload its pairing screen brings the button
    // back. Taken for approved, it was left on that screen with no button (HB-1134 review).
    const sure = !!r?.approved && !r.failed;
    if (sure) remember();
    const fr = consoleTabs.find(t => t.id === id)?.frame ?? $('consoleFrame'), again = consoleTabs.find(t => t.id === id)?.url ?? consoleUrl;
    fr.src = 'about:blank';
    setTimeout(() => { if (stillOurs()) fr.src = again; }, 50);
    await new Promise((res) => setTimeout(res, 1500)); // let the console connect before showing it
    uncover();
    if (!sure) await manual();
    return;
  }
  uncover();
  rememberConnected();
  // No request in the whole watch, from a browser not approved here before: it may yet ask.
  if (!known) await manual();
}

async function approveConsoleBrowser(btn) {
  const id = consoleAgentId, frame = $('consoleFrame'), url = consoleUrl, ticket = consoleTicket, epoch = voiceEpoch, person = pagePerson;
  const current = () => $('consoleDlg').open && consoleAgentId === id && $('consoleFrame') === frame && frame.isConnected
    && ticket === consoleTicket && epoch === voiceEpoch && person === pagePerson && !pagePersonAway && !pageSignedOut;
  if (!current()) return;
  btn.disabled = true;
  /** Not sure the approval was this browser's: its pairing screen is looked for once it has reloaded. */
  let watch = false;
  try {
    let r, err;
    try { r = await api(`/v1/agents/${id}/console/approve`, { method: 'POST', body: {} }); } catch (e) { err = e; }
    if (!current()) return;
    // Nothing approved, and nothing waiting now (a 409 "Nothing is waiting" among them): another
    // approval took this browser's request first (another tab's, or the page's own), which is no
    // failure to show (HB-1134 review).
    const taken = !r?.approved && await consoleNothingWaiting(id);
    if (!current()) return;
    if (r?.approved || taken) {
      // Some refused: this browser's may be among them, so it is not said to be approved (HB-1134 review).
      if (r?.approved) toast(r.failed ? `Approved ${r.approved === 1 ? 'one' : r.approved} of the ${r.approved + r.failed} browsers waiting — if this one still asks, press Approve again.` : 'Approved — reconnecting.', r.failed ? 9000 : undefined);
      btn.hidden = true;
      // Reload with the token still in the fragment, so it connects on its own.
      frame.src = 'about:blank';
      setTimeout(() => { if (current()) frame.src = url; }, 50);
      // Some refused (`failed`), or taken elsewhere: the button comes back if its pairing screen does.
      watch = !r?.approved || !!r.failed;
    } else {
      // A request found and not approved stays on the button (HB-1134); it was "Nothing to approve."
      toast(err ? err.message : 'This browser was not approved. Try again in a moment.', 9000);
    }
  } finally { if (current()) btn.disabled = false; }
  if (!watch) return;
  await new Promise((r) => setTimeout(r, 1500));
  await consolePairingWatch(frame, current);
}

/**
 * The console's size, by dragging (2026-11-19). The dialog is centred, so a
 * drag sets the size about its middle: twice the pointer's distance from the
 * centre, which keeps the dragged edge under the pointer. The size is kept in
 * this browser; the stylesheet caps it to the window and ignores it on a phone.
 */
const CONSOLE_SIZE_KEY = 'hb-console-size', CONSOLE_MIN_W = 480, CONSOLE_MIN_H = 360;
function consoleApplySize(w, h) {
  const d = $('consoleDlg');
  if (!(Number.isFinite(w) && Number.isFinite(h))) { d.classList.remove('sized'); d.style.removeProperty('--cw'); d.style.removeProperty('--ch'); return; }
  d.style.setProperty('--cw', `${Math.round(Math.max(CONSOLE_MIN_W, w))}px`);
  d.style.setProperty('--ch', `${Math.round(Math.max(CONSOLE_MIN_H, h))}px`);
  d.classList.add('sized');
}
function consoleResizeRestore() {
  try {
    const s = JSON.parse(localStorage.getItem(CONSOLE_SIZE_KEY) || 'null');
    if (Array.isArray(s) && s.length === 2) consoleApplySize(Number(s[0]), Number(s[1]));
  } catch { /* a private window, or a value that is not a size: the usual size */ }
}
function consoleResizeInit() {
  const d = $('consoleDlg');
  consoleResizeRestore();
  for (const g of d.querySelectorAll('.cgrip')) {
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const edge = g.dataset.edge, r0 = d.getBoundingClientRect();
      const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
      let w = r0.width, h = r0.height;
      try { g.setPointerCapture(e.pointerId); } catch { /* the pointer is gone already */ }
      d.classList.add('resizing');
      const move = (ev) => {
        if (/[lr]/.test(edge)) w = Math.min(innerWidth - 16, Math.max(CONSOLE_MIN_W, 2 * Math.abs(ev.clientX - cx)));
        if (edge.includes('b')) h = Math.min(innerHeight - 16, Math.max(CONSOLE_MIN_H, 2 * Math.abs(ev.clientY - cy)));
        consoleApplySize(w, h);
      };
      const done = () => {
        g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', done); g.removeEventListener('pointercancel', done);
        d.classList.remove('resizing');
        try { localStorage.setItem(CONSOLE_SIZE_KEY, JSON.stringify([Math.round(w), Math.round(h)])); } catch { /* a private window */ }
      };
      g.addEventListener('pointermove', move); g.addEventListener('pointerup', done); g.addEventListener('pointercancel', done);
    });
    g.addEventListener('dblclick', () => {
      consoleApplySize(NaN, NaN);
      try { localStorage.removeItem(CONSOLE_SIZE_KEY); } catch { /* a private window */ }
    });
  }
}
consoleResizeInit();

function closeConsole() {
  consoleTicket++;
  markConsoleSeen(consoleSeenAgent()); // what it showed, before its frames go (the close event comes after)
  // Drop the frames so their WebSockets close and the tokens leave the DOM.
  consoleUnloadAll();
  closeConsoleSwitcher();
  consoleUnmark(); // now, not from the late close event (which skips while another console opens)
  $('consoleDlg').close();
}

async function downloadAgent(id, name) {
  if (!confirm(`Download "${name}"?${channelsLostOnExport(id)}\n\nIt's a complete private copy — it includes the agent's bot token and members, so treat the file like a password (don't share it). The agent is STOPPED here afterwards, so the copy you Restore elsewhere is the only one talking to Telegram.`)) return;
  // Fetched, not navigated to: a refusal (busy, not exportable) is a message,
  // not a page of raw JSON in place of the app.
  toast('Preparing the copy…', 20000);
  try {
    const res = await sfFetch(`/v1/agents/${id}/backup`);
    if (!res.ok) { const j = await res.json().catch(() => ({})); toast(j.error || `The download failed (${res.status}).`, 10000); return; }
    const blob = await res.blob();
    const file = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'agent.hatchabot';
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: file });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(`Saved ${file}. "${name}" is stopped here now — keep it stopped once it runs elsewhere.`, 8000);
  } catch (e) { toast(e.message, 8000); }
  finally { setTimeout(() => refresh(false), 500); }
}
