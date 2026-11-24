// web/app/pwa.js: the service worker, and installing the app (the account menu's "Install as an app").
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// Register the service worker so the app is installable and shell-cached.
// Best-effort: a failure here never blocks the app.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// In-app install (the account menu's "Install as an app"). Chrome/Edge/Android
// fire beforeinstallprompt; we stash it for the dialog's one-tap button. iOS
// Safari has no such event, so the dialog explains the manual gesture.
let deferredInstall = null;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e; // enables the one-tap path in installApp()
});
window.addEventListener('appinstalled', () => { deferredInstall = null; });

function installSteps() {
  const ua = navigator.userAgent;
  const criOS = /crios/i.test(ua), fxiOS = /fxios/i.test(ua), android = /android/i.test(ua);
  if (isIOS && (criOS || fxiOS)) {
    return `<b>On this iPhone/iPad (${criOS ? 'Chrome' : 'Firefox'}):</b>
      <ol style="padding-left:20px;line-height:1.7;margin:6px 0 0">
        <li>Tap the <b>Share</b> icon — a square with an arrow up (⬆︎).</li>
        <li>Tap <b>“Add to Home Screen”</b>, then <b>“Add”</b>.</li>
      </ol>
      <div class="sub" style="margin-top:6px">Safari usually makes this easiest on iPhone if you'd rather switch.</div>`;
  }
  if (isIOS) {
    return `<b>On this iPhone/iPad (Safari):</b>
      <ol style="padding-left:20px;line-height:1.7;margin:6px 0 0">
        <li>Tap the <b>Share</b> button — a <b>square with an arrow pointing up (⬆︎)</b>, in the bar at the <b>bottom</b> of the screen.</li>
        <li>Scroll down the list and tap <b>“Add to Home Screen”</b>.</li>
        <li>Tap <b>“Add”</b> (top-right).</li>
      </ol>
      <div class="sub" style="margin-top:6px">No “Add to Home Screen” in the list? You're in an in-app browser (opened from Telegram, etc.) — open this page in Safari first.</div>`;
  }
  if (android) {
    return `<b>On this phone (Android):</b>
      <ol style="padding-left:20px;line-height:1.7;margin:6px 0 0">
        <li>Open the browser menu (<b>⋮</b>, top-right).</li>
        <li>Tap <b>“Install app”</b> or <b>“Add to Home screen”</b>, then confirm.</li>
      </ol>`;
  }
  return `<b>On this computer:</b>
    <ol style="padding-left:20px;line-height:1.7;margin:6px 0 0">
      <li>Click the <b>install icon</b> in the address bar, or open the browser menu.</li>
      <li>Choose <b>“Install Hatchabot”</b>.</li>
    </ol>
    <div class="sub" style="margin-top:6px">Chrome, Edge and Brave support this. (Needs an https:// or localhost address.)</div>`;
}

async function installApp() {
  // Always the dialog, never straight to the browser's prompt: the usual
  // reason for pressing this is to get Hatchabot onto a PHONE, and the code
  // to scan is in here. Where the browser offers one-tap, that is the first
  // thing in the dialog.
  // The code encodes the server's public address when it has one — the
  // browser's own address may be localhost, which a phone cannot open.
  const url = (appConfig?.appUrl || location.origin).replace(/\/$/, '');
  $('installUrl').innerHTML = `It opens <code>${esc(url)}</code>${/^https:/.test(url) ? '' : ' — your phone must be on this network (or your tailnet) to reach it.'}`;
  $('installBody').innerHTML = deferredInstall
    ? `<button class="primary" ${onAction('click', 'installHere', [{ $: 'el' }])}>Install on this computer</button>
       <div class="sub" style="margin-top:8px">Or scan the code below to open it on your phone and add it there.</div>`
    : installSteps();
  installDlg.showModal();
}

/** The browser's own install prompt, from inside the dialog. */
async function installHere(btn) {
  if (!deferredInstall) { $('installBody').innerHTML = installSteps(); return; }
  btn.disabled = true;
  deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  if (outcome === 'accepted') {
    installDlg.close();
    toast('Installed — Hatchabot is on this computer now.');
  } else {
    // They said no: leave the per-browser steps, which still work.
    $('installBody').innerHTML = installSteps();
  }
}
window.installHere = installHere;

// Light/dark theme. The <head> script set the initial theme before paint;
// v2SetTheme (the account menu) switches it; this keeps the PWA
// theme-color in step.
function syncThemeChrome() {
  const dark = document.documentElement.dataset.theme !== 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#14161a' : '#ffffff');
}
syncThemeChrome();

// Universal press feedback: briefly flash any clicked button to the accent so
// a tap is obviously registered, even before its action's result lands.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('button, .btn');
  if (b && !b.disabled) {
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 200);
  }
}, true);

// Click the backdrop (outside the panel) to dismiss any open dialog — like
// Escape already does. A click on a child bubbles up with that child as the
// target, so we only act when the dialog element itself is the target AND the
// pointer is outside its box.
for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inPanel = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    // Through 'cancel', so a dialog that refuses to go (the sign-in, a
    // recovery code not yet saved) refuses a stray click too, as it does Esc.
    if (!inPanel && dlg.dispatchEvent(new Event('cancel', { cancelable: true }))) dlg.close();
  });
}
