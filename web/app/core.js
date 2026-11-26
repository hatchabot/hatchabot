// web/app/core.js: shared state and helpers: the running version, $, an image's tag, the visual viewport, the lists of agents, sources and hosts, the classic map choice, api() and the server clock, toast(), copying, sizes and times (fmtBytes, ago, clock), the phone width, arrow keys between tabs, and a question with several answers (askChoice).
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// The running version, which the server writes into the page as a meta tag
// (versionMarkup in src/api/machine/pageRoutes.ts; an inline script until HB-0812).
// A page opened without the server (the click-through) may have set it already.
{
  const v = document.querySelector('meta[name="hatchabot-version"]')?.content;
  if (v) {
    window.HATCHABOT_VERSION = v;
    console.info('Hatchabot ' + v);
  }
}

const $ = (id) => document.getElementById(id);
/**
 * An image's tag, the text after its repository: after the last `:` that
 * comes after the last `/`, so an image of a repository on a registry with a
 * port (registry.example:5000/runtime:2026.9.8) shows 2026.9.8, not
 * 5000/runtime:2026.9.8 (HB-1357 review). A name with no tag shows whole.
 */
function imageTagOf(ref) {
  const s = String(ref ?? '');
  const colon = s.lastIndexOf(':');
  return colon > s.lastIndexOf('/') ? s.slice(colon + 1) : s;
}
/**
 * The phone keyboard covers the bottom of the screen without making the page
 * any shorter, so a dialog, the console and the web chat sat under it (audit
 * 2026-10-23, B20). While it is up (the visible part well short of the
 * window, not zoomed in), html.kbd and --vvh/--vvt fit them above it (the
 * CSS by `dialog.v2panel`), and the field being typed in is scrolled into view.
 */
function fitVisualViewport(vv = window.visualViewport, resized = false) {
  if (!vv) return;
  const root = document.documentElement;
  const kbd = vv.scale <= 1.01 && innerHeight - vv.height > 120;
  const h = `${Math.round(vv.height)}px`, t = `${Math.round(vv.offsetTop)}px`;
  // Scrolling fires this often: only a change restyles the page.
  if (root.classList.contains('kbd') !== kbd) root.classList.toggle('kbd', kbd);
  if (root.style.getPropertyValue('--vvh') !== h) root.style.setProperty('--vvh', h);
  if (root.style.getPropertyValue('--vvt') !== t) root.style.setProperty('--vvt', t);
  const el = document.activeElement;
  if (kbd && resized && el?.closest?.('dialog[open]') && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
  }
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', () => fitVisualViewport(visualViewport, true));
  visualViewport.addEventListener('scroll', () => fitVisualViewport(visualViewport));
  fitVisualViewport();
}
// Stamped into the page by the server. Shown in the header so a stale tab is
// obvious at a glance rather than something to argue about.
let profiles = [], hosts = [], agents = [], pairings = {}, members = {}, editData = [];
/** False until the first agent list arrives — the screen must not guess before then. */
let agentsLoaded = false;

/** The fleet you're actually running, and the ones parked. */
function liveAgents() { return agents.filter(a => a.state !== 'ARCHIVED'); }
function archivedAgents() { return agents.filter(a => a.state === 'ARCHIVED'); }
/** ?demo in the URL: screenshot mode — personal details (your email, family members'
 *  Telegram names, bot handles, connected accounts, Telegram ids) are blanked or
 *  blurred. Nothing is changed on the server; drop ?demo to see everything again. */
const DEMO = new URLSearchParams(location.search).has('demo');
if (DEMO) document.documentElement.classList.add('demo');
/**
 * Work in progress, off for everyone else: Slack and Discord are built and
 * tested but have never met a real app (2026-09-20). Add `?dev` to the address
 * to see them; drop it to hide them again. Deliberately NOT remembered — this
 * is a switch you flick while working, not a mode you end up stuck in. The
 * server behaves identically either way, so it is a workbench, not a demo.
 */
const DEV = new URLSearchParams(location.search).has('dev');
const previewing = () => DEV;
let poolAvail = 0; // instant bots ready — drives the create dialog's pool checkbox
let availableModels = {}; // profile id -> string[] the source's runtime actually serves (refetched on every open)
let staleModels = {};     // profile id -> string[] it still lists but the runtime won't serve
let availableSource = {}; // profile id -> 'runtime' | 'curated' — was the list PROBED live, or the offline fallback

/**
 * The icon home screen is the only one since v2.155.0; the classic card look
 * is gone. A browser that had chosen it (localStorage 'hb-ui' = 'classic')
 * has the choice cleared, once, and is shown a short map of where the card's
 * buttons went (#v2ClassicMap). A ?ui= left in a bookmark is taken out of the
 * address and otherwise ignored.
 */
function takeClassicChoice() {
  let was = false;
  try { was = localStorage.getItem('hb-ui') === 'classic'; localStorage.removeItem('hb-ui'); } catch { /* a private window */ }
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('ui')) {
      q.delete('ui');
      const rest = q.toString();
      history.replaceState(history.state, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    }
  } catch { /* the address stays as it was: nothing reads it */ }
  return was;
}
const CLASSIC_WAS_ON = takeClassicChoice();
function v2DismissClassicMap() {
  $('v2ClassicMap').hidden = true;
  // The button pressed is gone: keep the keyboard on the page, at the first thing on the home screen.
  [...$('v2home').querySelectorAll('button, a[href], [tabindex="0"]')].find((el) => el.offsetParent !== null)?.focus({ preventScroll: true });
}

/**
 * How far the server's clock is ahead of this browser's (negative: behind), from the last quick
 * answer with a Date header; null until one has come. Whole seconds, and an answer back within
 * SERVER_CLOCK_TRIP_MS, so good to about two: the web chat times a send with no read before it
 * by it (webChatOfferUnsure, WEBCHAT_DATE_MS).
 */
let serverAheadMs = null;
/** An answer slower than this (a chat turn, a slow link) says too little of when the server said its time: not taken. */
const SERVER_CLOCK_TRIP_MS = 1000;
const api = async (path, opts = {}) => {
  const { _afterSecondFactor, ...fetchOpts } = opts;
  const asked = Date.now();
  const res = await fetch(path, {
    ...fetchOpts,
    // Only claim a JSON body when there is one: Fastify 400s a body-less
    // request (e.g. DELETE) that still carries the content-type header.
    headers: opts.body || opts.headers ? { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  // The server's clock against this browser's, from the answer's Date header (whole seconds), read
  // as its headers come: after the body, a slow download was taken for the server's clock.
  const heard = Date.now(), served = Date.parse(res.headers?.get?.('date') || '');
  if (served && heard - asked <= SERVER_CLOCK_TRIP_MS) serverAheadMs = served - heard;
  const data = await res.json().catch(() => ({}));
  // At the public address: signed in, and the second factor is wanted (at
  // sign-in, or again before a sensitive action). Ask for it, then make the
  // same request once more. The second-factor calls themselves never loop.
  if (res.status === 401 && (data.secondFactor === 'required' || data.secondFactor === 'step-up')
      && !_afterSecondFactor && !path.startsWith('/v1/second-factor/verify') && !path.startsWith('/v1/second-factor/challenge')) {
    await askSecondFactor(data.secondFactor);
    // What it was asked for is under way until it answers: new codes, a new recovery code (HB-0491).
    return pageHold(() => api(path, { ...opts, _afterSecondFactor: true }));
  }
  // Everyone is asked for a second factor here and this person has none yet:
  // take them to where one is added (once; the calls behind it just fail).
  if (res.status === 403 && data.secondFactor === 'enrol' && !window.__sfEnrolShown && typeof aiDlg !== 'undefined') {
    window.__sfEnrolShown = true;
    setTimeout(() => { toast(data.error, 8000); if (!aiDlg.open) void openAiDlg('access'); }, 0);
  }
  // …and they did not arrive by a link, so they cannot add one here: say
  // plainly what to do instead (the settings page would only refuse them).
  if (res.status === 403 && data.secondFactor === 'enrol-link' && !path.startsWith('/v1/second-factor/')) sfShowBlock(data.error);
  // Only the sign-in hook's own 401 means the session is gone. A route that
  // answers 401 with its own reason — a wrong current password, a recovery
  // code that doesn't match — is an answer, not a reason to sign out: showing
  // the sign-in screen then hid the message behind "auth required".
  if (res.status === 401 && path !== '/v1/login' && (!data.error || data.error === 'auth required')) {
    showLogin();
    // The status: the server turned it away, so whatever it carried did not arrive (the web chat reads it, HB-0446).
    throw Object.assign(new Error('auth required'), { status: 401 });
  }
  if (!res.ok) {
    // App errors send {error: "friendly text"}; framework errors send a
    // generic error ("Bad Request") plus a specific message — prefer the
    // specific one.
    const msg =
      (typeof data.message === 'string' && data.message) ||
      (typeof data.error === 'string' && data.error) ||
      'Request failed';
    const err = new Error(msg);
    // A route that wants the caller to decide something (a pinned image the
    // runner lacks) names the case in `code`; keep it, and what it refers to.
    if (typeof data.code === 'string') { err.code = data.code; err.image = data.image; if (typeof data.detail === 'string') err.detail = data.detail; }
    // And the status, for a caller that treats "gone already" (404) apart from a failure.
    err.status = res.status;
    // The whole answer too: a failed app install says why in data.test.output,
    // which the dialogs read as e.data (never set until 2026-10-09).
    err.data = data;
    throw err;
  }
  return data;
};

let toastTimer;
function toast(msg, ms, cls) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (cls ? ` ${cls}` : '');
  clearTimeout(toastTimer);
  // Long messages (errors, mostly) get reading time; a tap dismisses early.
  toastTimer = setTimeout(() => t.classList.remove('show'), ms ?? Math.max(2600, msg.length * 60));
  t.onclick = () => { clearTimeout(toastTimer); t.classList.remove('show'); };
}

// Robust clipboard copy. navigator.clipboard exists ONLY in a secure context
// (https or localhost); over plain http — e.g. http://<tailscale-host>:8080 —
// it's undefined, so we fall back to a hidden-textarea execCommand copy that
// works there too. Returns whether the copy succeeded.
async function copyText(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
    // Append INSIDE the open modal, not to <body>. showModal() puts the dialog
    // in the top layer and makes the rest of the document inert, so a textarea
    // parented to <body> can't take selection — select() no-ops and the copy
    // silently fails. That's why the invite dialog's buttons did nothing.
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    const host = dialogs[dialogs.length - 1] ?? document.body;
    host.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    host.removeChild(ta);
    return ok;
  } catch { return false; }
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

// "5m ago" / "3h ago" / "2d ago" — coarse on purpose; it's a health signal,
// not a log.
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const clock = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

/** A phone-wide screen: the width the stylesheet's phone rules start at. */
const phoneQuery = typeof matchMedia === 'function' ? matchMedia('(max-width: 640px)') : null;
function isPhone() {
  return !!phoneQuery?.matches;
}

/** Arrow keys, Home and End between the tabs of a tablist; the tab moved to is chosen (2026-10-09). */
function v2TabKeys(e, list) {
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (j === undefined) return;
  e.preventDefault();
  const t = tabs[(j + tabs.length) % tabs.length];
  const id = t.id;
  t.click(); // redraws the tabs: focus the new one by its id
  ($(id) || t).focus();
}

/**
 * A question with more than OK and Cancel: resolves the key of the button
 * pressed, or null on Cancel, Esc or a click outside. confirm() made Cancel
 * mean "the other choice", so Esc on Share still exported and on Recover
 * context still started the job (review, 2026-10-09).
 */
let choiceResolve = null;
function askChoice(title, text, choices) {
  choicePick(null); // a question still open is answered "no"
  $('choiceTitle').textContent = title; $('choiceText').textContent = text;
  $('choiceBtns').innerHTML = `<button ${onAction('click', 'choicePick', [null])}>Cancel</button>` +
    choices.map(([k, label], i) => `<button${i === choices.length - 1 ? ' class="primary"' : ''} ${onAction('click', 'choicePick', [`${k ?? ''}`])}>${esc(label)}</button>`).join('');
  return new Promise((res) => { choiceResolve = res; choiceDlg.showModal(); });
}
function choicePick(k) {
  const r = choiceResolve; choiceResolve = null;
  if (choiceDlg.open) choiceDlg.close();
  r?.(k);
}
// Esc or a click outside: Cancel. A late close event of an earlier question must not answer the next one.
choiceDlg.addEventListener('close', () => { if (!choiceDlg.open) choicePick(null); });
