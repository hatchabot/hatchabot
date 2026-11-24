// web/app/signin.js: the second factor (passkeys and codes), the sign-in screen, Google sign-in, accounts and recovery codes.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- second factor (docs/public-access.md) ----------------------------------
// Passkeys speak ArrayBuffers; the server speaks base64url.
const b64uToBuf = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Signed in at the public address with no second factor and no way to add one here: what to do, once, where it cannot be missed. */
function sfShowBlock(text) {
  const el = $('sfBlock');
  if (!el || !el.hidden) return;
  el.hidden = false;
  el.innerHTML = `<div>🔐 ${esc(text)}</div><div style="margin-top:8px"><button ${onAction('click', 'signOut')}>Sign out</button></div>`;
}

/**
 * One prompt at a time: every request that needs the second factor waits on the same one. It belongs to the
 * session and the person it was raised for: when the session ends, or the page reads someone else, it is answered
 * "not given", so no request of one person's is sent again under the next one's session.
 */
let sfPending = null;
function askSecondFactor(kind) {
  // Still waiting for an answer: the same prompt, shown again if something took it off the screen.
  if (sfPending) { if (!sfDlg.open) sfDlg.showModal(); return sfPending.promise; }
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  sfPending = { promise, resolve, reject, kind, for: pagePersonAway ? '' : (pagePerson || '') };
  promise.then(() => { if (sfPending?.promise === promise) sfPending = null; }, () => { if (sfPending?.promise === promise) sfPending = null; });
  $('sfDlgTitle').textContent = kind === 'step-up' ? 'Confirm it is you' : 'One more step';
  $('sfDlgLede').textContent = kind === 'step-up'
    ? 'This changes something sensitive, and you are at the public address: give your second factor again.'
    : 'This Hatchabot is being opened from the internet, so it asks for your second factor.';
  $('sfErr').textContent = ''; $('sfCode').value = '';
  $('sfPasskeyRow').hidden = true;
  if (loginDlg.open) loginDlg.close();
  if (!sfDlg.open) sfDlg.showModal();
  $('sfCode').focus();
  // Which factors this person has decides what is offered.
  api('/v1/second-factor', { _afterSecondFactor: true }).then((st) => {
    const kinds = st.methods || [];
    $('sfPasskeyRow').hidden = !(kinds.includes('passkey') && st.passkeyHere && window.PublicKeyCredential);
    const codes = [kinds.includes('totp') && 'Code from your authenticator app', kinds.includes('backup') && 'a backup code'].filter(Boolean);
    $('sfCodeLabel').textContent = codes.length ? codes.join(', or ') : 'Backup code';
  }).catch(() => {});
  return promise;
}
/** The prompt answered "not given" without signing anyone out: its session is over, or the page is someone else's now. */
function sfDrop() {
  const was = sfPending;
  if (!was) return;
  sfPending = null;
  if (sfDlg.open) sfDlg.close();
  was.reject(Object.assign(new Error('The second factor was not given.'), { status: 401 }));
}
async function sfDone() {
  const was = sfPending;
  if (!was) { if (sfDlg.open) sfDlg.close(); return; }
  // Raised for someone this page knew: the request goes again only under their session. Another tab or window may
  // have signed in as someone else meanwhile, and the factor just given was theirs. Read who the session is first;
  // anyone else, or no answer, and the request is answered "not given", not sent (review of HB-0491).
  if (was.for) {
    $('sfCodeBtn').disabled = true;
    let who = '';
    try { who = (await api('/v1/account', { _afterSecondFactor: true }))?.ownerId || ''; } catch { /* not known: not sent */ }
    finally { $('sfCodeBtn').disabled = false; }
    if (sfPending !== was) return; // answered meanwhile (the session ended)
    if (who !== was.for) {
      sfDrop();
      if (who) pagePersonIs(who);
      if (who && was.kind === 'required' && !pageSignIns) void pageSigningIn(() => pageSignedIn()); // a sign-in, finished here
      return;
    }
  }
  if (sfDlg.open) sfDlg.close();
  was.resolve();
  // Signed in through a prompt that no sign-in form raised (another tab signed in, and this page's poll was asked):
  // the sign-in finishes here, so who it is is read and the page is cleared for them, as a sign-in form does.
  if (was.kind === 'required' && pagePersonAway && !pageSignIns) void pageSigningIn(() => pageSignedIn());
}
/**
 * fetch() for what api() cannot carry (a file up or down), with api()'s
 * second-factor prompt: a 401 asking for it is asked, then the request made
 * once more. Raw fetches used to skip the prompt, so a backup, an import or a
 * Share at the public address just failed (review, 2026-10-09). A cancelled
 * prompt throws, as api() does. The body must be one that can be sent twice
 * (a File, a Blob or a string).
 */
async function sfFetch(url, init) {
  const res = await fetch(url, init);
  if (res.status !== 401) return res;
  const data = await res.clone().json().catch(() => ({}));
  if (data.secondFactor !== 'required' && data.secondFactor !== 'step-up') return res;
  await askSecondFactor(data.secondFactor);
  return pageHold(() => fetch(url, init));
}
/** A step-up download link (a folder's .tar.gz): at the public address it is fetched through sfFetch, so the second factor is asked instead of a page of raw JSON; elsewhere the link streams as before. */
function sfLink(ev, el, fallbackName) {
  if (!appConfig.publicAddress) return true;
  ev.preventDefault();
  void saveFromServer(el.getAttribute('href'), fallbackName);
  return false;
}
/**
 * A step-up link that opens in a new tab (a file shown inline). A tab cannot
 * be asked for the second factor, so at the public address a cheap step-up
 * read (`probe`: the file's own check, check=1, which reads nothing) goes first
 * through api(), which asks when it has lapsed; the tab then opened gets the
 * file, not raw JSON (audit, 2026-10-20).
 */
function sfOpen(ev, el, probe) {
  if (!appConfig.publicAddress) return true;
  ev.preventDefault();
  void (async () => {
    try { await api(probe); } catch (e) { toast(e.message, 8000); return; }
    const w = window.open(el.getAttribute('href'), '_blank');
    if (w) w.opener = null; else toast('The browser kept the new tab from opening — click the name again.', 8000);
  })();
  return false;
}
async function sfCancel() {
  const kind = sfPending?.kind;
  if (sfDlg.open) sfDlg.close();
  sfPending?.reject(Object.assign(new Error('The second factor was not given.'), { status: 401 })); // refused, as a 401 is: the request never went on
  pageReloadWhenQuiet();
  // At sign-in there is nothing to use without it: back to the sign-in screen, signed out.
  if (kind === 'required') {
    try { await fetch('/v1/logout', { method: 'POST' }); } catch { /* the screen is shown either way */ }
    showLogin();
  }
}
async function sfSubmitCode() {
  const code = $('sfCode').value.trim();
  if (!code) return;
  $('sfCodeBtn').disabled = true; $('sfErr').textContent = '';
  try { await api('/v1/second-factor/verify', { method: 'POST', body: { code } }); await sfDone(); }
  catch (e) { $('sfErr').textContent = e.message; $('sfCode').select(); }
  finally { $('sfCodeBtn').disabled = false; }
}
async function sfUsePasskey() {
  $('sfPasskeyBtn').disabled = true; $('sfErr').textContent = '';
  try {
    const o = await api('/v1/second-factor/challenge', { method: 'POST', body: {} });
    const cred = await navigator.credentials.get({ publicKey: {
      challenge: b64uToBuf(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification,
      allowCredentials: o.allowCredentials.map((c) => ({ type: 'public-key', id: b64uToBuf(c.id) })),
    } });
    await api('/v1/second-factor/verify', { method: 'POST', body: { passkey: {
      id: bufToB64u(cred.rawId), clientDataJSON: bufToB64u(cred.response.clientDataJSON),
      authenticatorData: bufToB64u(cred.response.authenticatorData), signature: bufToB64u(cred.response.signature),
    } } });
    await sfDone();
  } catch (e) { $('sfErr').textContent = e.name === 'NotAllowedError' ? 'The passkey was not used. Try again, or type a code.' : e.message; }
  finally { $('sfPasskeyBtn').disabled = false; }
}

/**
 * Shows the codes once; resolves when the person has pressed Done. (Not the dialog's close event: it can arrive much later.)
 * `ownerId`: whose they are, as the server said; a session that ends meanwhile keeps them for that person (pageSecretShown).
 */
let backupResolve = null;
function showBackupCodes(codes, ownerId) {
  if (pageSignedOut) return pageSecretLater(ownerId, () => showBackupCodes(codes, ownerId));
  if (pageSecretNotHere(ownerId)) return Promise.resolve();
  $('backupCodes').textContent = codes.join('\n');
  $('backupSaved').checked = false; $('backupDone').disabled = true;
  backupDlg.showModal();
  pageSecretShown(backupDlg, ownerId);
  return new Promise((res) => { backupResolve = res; });
}
function closeBackupCodes() {
  // Gone from the page at once: one-time codes must not sit in the DOM for the next person at the keyboard.
  $('backupCodes').textContent = '';
  if (backupDlg.open) backupDlg.close();
  const done = backupResolve; backupResolve = null;
  done?.();
  pageReloadWhenQuiet(); // one waiting for these (HB-0491); not on the close event, which can come much later
}
function downloadBackupCodes() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([`Hatchabot backup codes\n${location.origin}\n\n${$('backupCodes').textContent}\n\nEach works once.\n`], { type: 'text/plain' }));
  a.download = 'hatchabot-backup-codes.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Settings → You → Second factor. */
let sfState = null;
async function loadSecondFactor() {
  const box = $('sfBox');
  if (!box) return;
  if ((appConfig.authMode ?? 'password') === 'password') { box.hidden = true; return; }
  let st;
  try { st = await api('/v1/second-factor'); } catch { box.hidden = true; return; }
  sfState = st;
  box.hidden = false;
  // At the public address with no second factor, a password change is refused (HB-0453): say so instead of offering the form.
  $('acctPwForm').hidden = !!st.passwordRefused;
  $('acctPwRefused').hidden = !st.passwordRefused;
  $('acctPwRefused').textContent = st.passwordRefused || '';
  $('sfPwRow').hidden = !st.localAccount || (st.publicAddress && st.factors.length > 0);
  $('sfBackupBtn').hidden = st.factors.length === 0;
  $('sfStatus').innerHTML = st.hidden
    ? 'Give your second factor to see and change what you have.'
    : st.factors.length
    ? `Asked for when you sign in at the public address, and again there before sensitive changes. ${st.backupCodes} backup code${st.backupCodes === 1 ? '' : 's'} left.`
    : st.ownerRights
      ? '<b style="color:var(--warn)">You have none.</b> You own this machine, so you need one before it can be made reachable from the internet.'
      : st.need === 'no'
        ? 'You have none. You sign in with Google, which is your second step at the public address; if you add one here, it is asked for there as well.'
        : st.need === 'guest'
          ? 'You have none. At the public address you can chat without one; everything else there needs one.'
          : `<b style="color:var(--warn)">You have none, and the public address asks everyone for one.</b> ${st.publicAddress ? 'Add one now if you just used an invitation or reset link; otherwise add it at the private address, or ask whoever runs this Hatchabot for a reset link.' : 'Add one here, so you can sign in from the internet too.'}`;
  $('sfList').innerHTML = st.factors.map((f) => `<div class="pair" style="gap:8px;align-items:center">
      <span><b>${esc(f.kind === 'passkey' ? (f.label || 'Passkey') : 'Authenticator app')}</b>
        <span class="sub">· added ${esc(new Date(f.createdAt).toLocaleDateString())}${f.lastUsedAt ? ` · last used ${esc(new Date(f.lastUsedAt).toLocaleDateString())}` : ''}${f.kind === 'passkey' && !f.worksAtPublicAddress ? ` · made for ${esc(f.madeFor || 'another address')}` : ''}</span></span>
      <button class="sfRemove" data-id="${esc(f.id)}" ${onAction('click', 'sfRemove', [{ $: 'el' }])}>Remove</button></div>`).join('');
  $('sfNote').textContent = st.passkeyAddress
    ? `A passkey belongs to the address it is made at: add it while you have Hatchabot open at ${st.passkeyAddress}. An authenticator app works at any address.`
    : 'A passkey needs this Hatchabot\'s https address (the setup guide\'s "Turn on HTTPS" step). An authenticator app works without one.';
  $('sfAddPasskeyBtn').disabled = !st.passkeyHere || !window.PublicKeyCredential;
  $('sfAddPasskeyBtn').title = st.passkeyHere ? '' : (st.passkeyAddress ? `Open Hatchabot at ${st.passkeyAddress} to add a passkey` : 'Needs an https address');
}
const sfProof = () => ($('sfPwRow').hidden ? {} : { current: $('sfCurPw').value });
function sfFail(e) { $('sfBoxErr').textContent = e.message === 'The second factor was not given.' ? '' : e.message; if (/password/i.test(e.message)) $('sfCurPw').focus(); }
async function sfAfterChange(r) {
  $('sfCurPw').value = ''; $('sfBoxErr').textContent = '';
  if (r && r.backupCodes) {
    await showBackupCodes(r.backupCodes, r.ownerId);
  }
  await loadSecondFactor();
  if (!$('reachBox').hidden) void loadReach();
}
async function sfStartTotp(btn) {
  btn.disabled = true; $('sfBoxErr').textContent = '';
  try {
    const r = await pageHold(() => api('/v1/second-factor/totp', { method: 'POST', body: sfProof() }));
    $('sfTotpBox').hidden = false;
    $('sfTotpBox').dataset.id = r.id;
    // The server's own SVG (the qrcode library's output): an image, never markup from a person.
    $('sfTotpQr').innerHTML = `<img alt="QR code for your authenticator app" width="138" height="138" src="data:image/svg+xml;base64,${btoa(r.qr)}">`;
    $('sfTotpSecret').textContent = r.secret.match(/.{1,4}/g).join(' ');
    $('sfTotpCode').value = ''; $('sfTotpCode').focus();
  } catch (e) { sfFail(e); }
  finally { btn.disabled = false; }
}
/** The "Add an authenticator app" box, shut, with its secret gone from the page. */
function sfCloseTotp() {
  $('sfTotpBox').hidden = true; delete $('sfTotpBox').dataset.id;
  $('sfTotpQr').innerHTML = ''; $('sfTotpSecret').textContent = ''; $('sfTotpCode').value = '';
  pageReloadWhenQuiet(); // one waiting for this setup (HB-0491)
}
async function sfConfirmTotp() {
  $('sfTotpConfirmBtn').disabled = true;
  try {
    const r = await pageHold(() => api('/v1/second-factor/totp/confirm', { method: 'POST', body: { id: $('sfTotpBox').dataset.id, code: $('sfTotpCode').value.trim() } }));
    sfCloseTotp();
    toast('Authenticator app added');
    await sfAfterChange(r);
  } catch (e) {
    // 409: this setup is gone on the server (a factor removed or reset, or
    // another app started, in another tab). No code can finish it now (HB-0375).
    if (e.status === 409) sfCloseTotp();
    sfFail(e);
  }
  finally { $('sfTotpConfirmBtn').disabled = false; }
}
async function sfAddPasskey(btn) {
  btn.disabled = true; $('sfBoxErr').textContent = '';
  try {
    // Held while the passkey is being made, not while its codes are read: the open codes hold it then (HB-0491).
    const r = await pageHold(async () => {
      const o = await api('/v1/second-factor/passkey/options', { method: 'POST', body: sfProof() });
      const cred = await navigator.credentials.create({ publicKey: {
        challenge: b64uToBuf(o.challenge), rp: o.rp,
        user: { id: b64uToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
        pubKeyCredParams: o.pubKeyCredParams, timeout: o.timeout, attestation: o.attestation,
        authenticatorSelection: o.authenticatorSelection,
        excludeCredentials: o.excludeCredentials.map((c) => ({ type: 'public-key', id: b64uToBuf(c.id) })),
      } });
      const label = (navigator.userAgentData?.platform || navigator.platform || 'Passkey').slice(0, 40);
      return api('/v1/second-factor/passkey', { method: 'POST', body: {
        label, clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject),
      } });
    });
    toast('Passkey added');
    await sfAfterChange(r);
  } catch (e) { sfFail(e.name === 'NotAllowedError' ? new Error('The passkey was not made (cancelled, or it timed out).') : e.name === 'InvalidStateError' ? new Error('This device already has a passkey for this Hatchabot.') : e); }
  finally { btn.disabled = !sfState?.passkeyHere; }
}
async function sfNewBackupCodes(btn) {
  if (!confirm('Make new backup codes? The old ones stop working.')) return;
  btn.disabled = true;
  try { await sfAfterChange(await pageHold(() => api('/v1/second-factor/backup-codes', { method: 'POST', body: sfProof() }))); }
  catch (e) { sfFail(e); }
  finally { btn.disabled = false; }
}
async function sfRemove(btn) {
  if (!confirm('Remove this second factor?')) return;
  btn.disabled = true;
  try {
    await api('/v1/second-factor/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE', body: sfProof() });
    // Removing a factor cancels an app still being added: its box goes too, and
    // says so, or a code typed there could only be refused (HB-0375).
    const adding = !$('sfTotpBox').hidden;
    if (adding) sfCloseTotp();
    toast(adding ? 'Removed. That cancelled the authenticator app you were adding: add it again.' : 'Removed', adding ? 8000 : undefined);
    await sfAfterChange();
  } catch (e) { sfFail(e); btn.disabled = false; }
}

/** Settings → You → Reach it from anywhere (the machine's owner, at the private address). */
async function loadReach(preflight) {
  const box = $('reachBox');
  if (!box) return;
  if (appConfig.managed || appConfig.publicAddress || (appConfig.authMode ?? 'password') === 'password') { box.hidden = true; return; }
  let r;
  try { r = await api('/v1/public-access' + (preflight ? '?preflight=1' : '')); } catch { box.hidden = true; return; }
  box.hidden = false;
  reachRender(r);
}
function reachRender(r) {
  // A leftover Funnel entry found on looking, and not removable from here: with the command (HB-0449).
  const left = r.recovered?.funnelError;
  $('reachErr').textContent = left ? `Tailscale's Funnel entry could not be removed (${left}). Hatchabot is not serving it.${r.recovered.command ? ` Run: ${r.recovered.command}` : ''}` : '';
  $('reachStatus').innerHTML = r.on
    ? (r.serving ? `<b>On.</b> This Hatchabot's sign-in page is reachable from the internet.`
        : `<b style="color:var(--bad)">On, but refused.</b> A safeguard below is off, so the public address answers nothing until it is fixed.`)
    : '<b>Off.</b> Reachable only on your network and your tailnet.';
  const addr = $('reachAddress');
  addr.hidden = !(r.on && r.url);
  addr.innerHTML = r.on && r.url ? `<img src="/v1/public-access/qr.svg?${Date.now()}" alt="QR code for the public address" width="104" height="104" style="background:#fff;border-radius:8px;padding:4px">
      <div><div class="sub">The public address</div><code style="word-break:break-all;user-select:all">${esc(r.url)}</code>
      <div style="margin-top:6px"><button data-copy="${esc(r.url)}" ${onAction('click', 'copyAndSay', [{ $: 'data', k: 'copy' }, "Copied", "Select it and copy"])}>Copy</button></div></div>` : '';
  const missing = (r.tailscale?.missing || []).map((m) => `<div class="pair reachCheck" data-ok="0" style="gap:8px"><span>✗ <b>Tailscale:</b> ${esc(m.what)} <span class="sub">${esc(m.fix)}${/^https:\/\//.test(m.link || '') ? ` <a href="${esc(m.link)}" target="_blank" rel="noopener">Open</a>` : ''}</span></span></div>`).join('');
  $('reachChecks').innerHTML = (r.safeguards || []).map((c) => `<div class="pair reachCheck" data-id="${esc(c.id)}" data-ok="${c.ok ? 1 : 0}" style="gap:8px">
      <span>${c.ok ? '✓' : '✗'} <b>${esc(c.title)}</b>${c.ok ? '' : `<br><span class="sub">${esc(c.detail)}${c.fix ? ` <i>${esc(c.fix)}</i>` : ''}</span>`}</span></div>`).join('') + missing;
  $('reachInvited').checked = !!r.invitedOnly;
  $('reachInvited').disabled = !!r.on;
  $('reachGuests').checked = !!r.guestsWithoutSecondFactor;
  $('reachGuests').dataset.confirm = r.guestsConfirmText || '';
  // Who has no second factor yet: stopped at the public address until they add one (or, a chat-only guest, let in by the switch above).
  const none = (r.withoutSecondFactor || []).filter((p) => !(r.guestsWithoutSecondFactor && p.chatOnlyGuest));
  const guests = (r.withoutSecondFactor || []).filter((p) => r.guestsWithoutSecondFactor && p.chatOnlyGuest);
  $('reachNoFactor').hidden = !(none.length || guests.length);
  $('reachNoFactor').innerHTML = [
    none.length ? `<b>No second factor yet:</b> ${none.map((p) => esc(p.name)).join(', ')}. They are stopped at the public address until they add one: send each a reset link (Accounts, above), which lets them add it right after using it, or have them add it at the private address.` : '',
    guests.length ? `<b>Let in with a password alone (chat only):</b> ${guests.map((p) => esc(p.name)).join(', ')}.` : '',
  ].filter(Boolean).join('<br>');
  $('reachOnBtn').hidden = !!(r.on && r.serving);
  $('reachOnBtn').disabled = (r.failing || []).length > 0;
  $('reachOnBtn').title = (r.failing || []).length ? 'Every safeguard above has to be in place first' : '';
  $('reachOffBtn').hidden = !r.on;
  $('reachOnBtn').dataset.confirm = r.confirmText || 'This makes your sign-in page reachable from the internet.';
}
async function reachSetInvitedOnly(cb) {
  try { reachRender(await api('/v1/public-access/invited-only', { method: 'POST', body: { on: cb.checked } })); }
  catch (e) { cb.checked = !cb.checked; $('reachErr').textContent = e.message; }
}
async function reachSetGuests(cb) {
  if (cb.checked && !confirm(`${cb.dataset.confirm || 'This lets chat-only guests use the public address with their password alone.'}\n\nEveryone else who signs in with a password still needs a second factor there.\n\nLet chat-only guests in without one?`)) { cb.checked = false; return; }
  try { reachRender(await api('/v1/public-access/guests', { method: 'POST', body: { on: cb.checked, confirm: true } })); toast(cb.checked ? 'Chat-only guests no longer need a second factor' : 'Everyone with a password needs a second factor'); }
  catch (e) { cb.checked = !cb.checked; $('reachErr').textContent = e.message; }
}
async function reachTurnOn(btn) {
  if (!confirm(`${btn.dataset.confirm}\n\nAnyone on the internet will be able to open it and try to sign in. Your accounts, the second factor and the limits listed here are what keeps them out.\n\nTurn on public access?`)) return;
  btn.disabled = true; $('reachErr').textContent = '';
  try {
    const res = await fetch('/v1/public-access/on', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Say exactly what is missing, with Tailscale's own link when it gave one.
      const parts = [data.error || 'Could not turn it on.'];
      for (const m of data.missing || []) parts.push(`${m.what} ${m.fix}`);
      // It took itself back, but Tailscale kept its entry: with the command to remove it (HB-0449).
      if (data.warning) parts.push(data.warning);
      $('reachErr').innerHTML = parts.map(esc).join('<br>') + (/^https:\/\//.test(data.link || '') ? `<br><a href="${esc(data.link)}" target="_blank" rel="noopener">Open Tailscale to allow Funnel</a>` : '');
      // Check again (something may have changed), and keep the reason on screen: the re-render clears it.
      const why = $('reachErr').innerHTML;
      await loadReach(true).catch(() => {});
      $('reachErr').innerHTML = why;
      return;
    }
    reachRender(data);
    toast('Public access is on');
    void loadConfig(); // invitation links are made for the public address from now on
  } catch (e) { $('reachErr').textContent = e.message; }
  finally { btn.disabled = false; }
}
async function reachTurnOff(btn) {
  if (!confirm('Turn off public access? The public address stops working at once; people outside your network will need Tailscale again.')) return;
  btn.disabled = true;
  try {
    const r = await api('/v1/public-access/off', { method: 'POST', body: {} });
    if (r.warning) $('reachErr').textContent = r.warning;
    toast('Public access is off');
    void loadConfig(); // …and for the private one again
    const keep = $('reachErr').textContent;
    await loadReach();
    if (keep) $('reachErr').textContent = keep;
  } catch (e) { $('reachErr').textContent = e.message; }
  finally { btn.disabled = false; }
}
const REACH_KINDS = {
  'public.signin': 'Signed in', 'public.second_factor': 'Second factor given', 'public.failure_burst': 'Too many failed sign-ins',
  'public.signin_refused': 'Sign-in refused', 'public.on': 'Public access turned on', 'public.off': 'Public access turned off',
  'public.paused': 'Public access paused (a safeguard is off)', 'signed_out_everywhere': 'Signed out everywhere', 'second_factor.reset': 'Second factor reset',
  'second_factor.added': 'Second factor added', 'second_factor.removed': 'Second factor removed',
};
async function reachToggleLog() {
  const el = $('reachLog');
  if (!el.hidden) { el.hidden = true; return; }
  el.hidden = false; el.textContent = 'Loading…';
  try {
    const { entries } = await api('/v1/security/log');
    el.innerHTML = entries.length ? entries.map((e) => {
      const d = e.detail || {};
      const bits = [d.device, d.from && `from ${d.from}`, d.newDevice && 'new device', d.method, d.at && `at ${d.at}`, d.bucket, d.why].filter(Boolean).join(' · ');
      return `<div class="pair" style="gap:8px;align-items:center"><span><span class="sub">${esc(new Date(e.at).toLocaleString())}</span> ${esc(REACH_KINDS[e.kind] || e.kind)}${e.who ? ` — <b>${esc(e.who)}</b>` : ''}${bits ? ` <span class="sub">${esc(bits)}</span>` : ''}</span>
        ${e.kind === 'public.signin' && e.ownerId ? `<button data-owner="${esc(e.ownerId)}" data-who="${esc(e.who || '')}" ${onAction('click', 'reachSignOut', [{ $: 'el' }])}>Sign out everywhere</button>` : ''}</div>`;
    }).join('') : '<span class="sub">Nothing yet.</span>';
  } catch (e) { el.textContent = e.message; }
}
async function reachSignOut(btn) {
  if (!confirm(`Sign ${btn.dataset.who || 'this person'} out on every device? Their browsers and command-line sign-ins all end; they sign in again with their password.`)) return;
  btn.disabled = true;
  try { await api('/v1/security/sign-out/' + encodeURIComponent(btn.dataset.owner), { method: 'POST', body: {} }); toast('Signed out everywhere'); }
  catch (e) { toast(e.message); btn.disabled = false; }
}

/** A sign-in from a new device, told in the app: to the person, and to the machine's owner. */
async function loadSecurityNotices() {
  const el = $('secNotice');
  if (!el || (appConfig.authMode ?? 'password') === 'password') return;
  let r;
  try { r = await api('/v1/security/notices', { _afterSecondFactor: true }); } catch { return; }
  const n = (r.notices || [])[0];
  el.hidden = !n;
  if (!n) return;
  const aboutMe = !n.aboutOwner || !r.canSignOutOthers || !/sign .* out everywhere/.test(n.text);
  el.innerHTML = `<div>🔐 ${esc(n.text)}</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
    ${aboutMe ? '<button ' + onAction('click', 'signOutEverywhere') + '>Sign out on every device</button>'
      : `<button data-owner="${esc(n.aboutOwner)}" data-who="" ${onAction('click', 'reachSignOut', [{ $: 'el' }])}>Sign them out everywhere</button>`}
    <button data-id="${esc(n.id)}" ${onAction('click', 'dismissSecurityNotice', [{ $: 'el' }])}>It was expected</button></div>`;
}
async function dismissSecurityNotice(btn) {
  try { await api(`/v1/security/notices/${encodeURIComponent(btn.dataset.id)}/seen`, { method: 'POST', body: {} }); } catch { /* shown again next time */ }
  await loadSecurityNotices();
}

// ---- auth ------------------------------------------------------------------

/** /v1/config. `publicAddress`: this page came in through the public listener (the server's isPublic,
 *  the same test its second factor goes by), not that a public address is set up. */
let appConfig = { authMode: 'password' };

async function loadConfig() {
  try { appConfig = await (await fetch('/v1/config')).json(); } catch { /* keep default */ }
  // A hosted Hatchabot: the provider's notice, and who to ask for help.
  const nb = $('noticeBanner');
  if (nb) { nb.hidden = !appConfig.notice; if (appConfig.notice) nb.textContent = appConfig.notice; }
  const runBy = $('managedBy');
  if (runBy) {
    runBy.hidden = !appConfig.managed;
    if (appConfig.managed) runBy.innerHTML = `Run by <b>${esc(appConfig.managed.by)}</b>: it keeps this Hatchabot upgraded, reachable and backed up.${/^https?:\/\//i.test(appConfig.managed.supportUrl || '') ? ` <a href="${esc(appConfig.managed.supportUrl)}" target="_blank" rel="noopener">Get help</a>` : ''}`;
  }
  const identity = appConfig.authMode === 'identity';
  const accounts = appConfig.authMode === 'accounts';
  const locals = !!appConfig.localAccounts;          // may be true in identity mode too
  const setup = accounts && appConfig.needsSetup;
  const claim = new URLSearchParams(location.search).get('claim');
  $('pwLogin').style.display = identity || accounts ? 'none' : '';
  $('idLogin').style.display = identity ? '' : 'none';
  $('acctLogin').style.display = locals && !setup && !claim ? '' : 'none';
  $('acctSetup').style.display = setup && !claim ? '' : 'none';
  // Under rootless Docker the code is needed here too: show the box open, and say so.
  if (setup && appConfig.setupCodeRequired && $('setupCodeBox')) {
    $('setupCodeBox').open = true;
    $('setupCodeBox').querySelector('summary').textContent = 'The setup code (needed on this machine too)';
  }
  // The installer's link carries the setup code after a "#" (scripts/first-run-link.sh):
  // fill it in, open the box, and take it out of the address bar at once.
  const fromLink = /(?:^#|&)setup=([0-9a-f]{4,32})(?:&|$)/i.exec(location.hash)?.[1];
  if (fromLink) {
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* keep going */ }
    if (setup && $('setupCode')) { $('setupCode').value = fromLink; if ($('setupCodeBox')) $('setupCodeBox').open = true; }
  }
  $('acctClaim').style.display = claim ? '' : 'none';
  // With both, Google is the owner's door and the form is everyone else's.
  $('acctLoginNote').textContent = identity
    ? 'Or sign in with the username and password you were given.'
    : 'Sign in with your account on this machine.';
  if (setup) $('loginDlg').querySelector('h3').textContent = 'Welcome to Hatchabot';
  if (claim) { $('loginDlg').querySelector('h3').textContent = 'Set your password'; void loadClaim(claim); }
  applyClaudePlanPolicy();
  if (identity) loadGoogleButton();
}

/**
 * A hosted Hatchabot (managed mode) takes Claude by API key only: a Claude
 * plan source would have the provider holding the customer's Claude.ai
 * credentials, which Anthropic's terms bar. The server refuses one; the app
 * does not offer it (Settings → AI sources, and the setup guide).
 */
function claudePlanOffered() { return appConfig?.claudePlan !== false; }
function applyClaudePlanPolicy() {
  if (claudePlanOffered()) return;
  $('aiKind')?.querySelector('option[value="subscription"]')?.remove();
  if ($('aiHostedNote')) $('aiHostedNote').hidden = false;
  if ($('aiAddSummary')) $('aiAddSummary').textContent = '— an API key, or a local model server';
  if ($('aiKind')) aiKindChanged();
}

// Google Identity Services renders the button and hands back a Google ID
// token; Identity Platform exchanges it for one of ours.
function loadGoogleButton() {
  const cid = appConfig.identity?.googleClientId;
  if (!cid || window.google?.accounts) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({ client_id: cid, callback: onGoogleCredential });
    // Match the app theme (was hardcoded dark) — a light install got a black button.
    const gTheme = document.documentElement.dataset.theme === 'dark' ? 'filled_black' : 'outline';
    google.accounts.id.renderButton($('gsiBtn'), { theme: gTheme, size: 'large', text: 'signin_with' });
  };
  document.head.appendChild(s);
}

const idpUrl = (method) =>
  `https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${appConfig.identity.apiKey}`;

async function idpCall(method, body) {
  const res = await fetch(idpUrl(method), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(friendlyIdpError(data?.error?.message ?? 'Sign-in failed'));
  return data;
}

function friendlyIdpError(code) {
  const map = {
    EMAIL_EXISTS: 'That email already has an account — sign in instead.',
    EMAIL_NOT_FOUND: 'No account for that email.',
    INVALID_PASSWORD: 'Wrong password.',
    INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
    USER_DISABLED: 'That account is disabled.',
    WEAK_PASSWORD: 'Password must be at least 6 characters.',
    OPERATION_NOT_ALLOWED: 'That sign-in method is not enabled for this project.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many tries for now — wait a few minutes and try again.',
  };
  return map[String(code).split(' :')[0]] ?? String(code);
}

/** Trade a verified Identity Platform token for a Hatchabot session. */
async function startSession(idToken) {
  pageSignIns++; // through to the end of pageSignedIn, a reload for another account waits (HB-0491)
  try {
  const out = await api('/v1/session', { method: 'POST', body: { idToken } });
  // The cookie only carries the subject — remember the email locally so the
  // header can say WHO this browser is signed in as (all tabs share it).
  if (out.email) { try { localStorage.setItem('hatchabot_email', out.email); } catch {} }
  loginDlg.close();
  $('loginIdPw').value = '';
  await pageSignedIn();
  } finally { pageSignInEnded(); }
}

async function signOut() {
  // Only the server can end the session: its cookie is HttpOnly, so this page
  // cannot clear it. A logout that never got there (the network, the service
  // restarting) used to reload anyway, and the still-valid cookie showed the
  // app again as if signing out had worked. Say so instead; Sign out again retries.
  try { await api('/v1/logout', { method: 'POST' }); }
  catch (e) {
    if (e.message !== 'auth required') { // that one means already signed out
      // An answer is not "did not answer": at the public address a sign-out it could not save is refused (HB-0957).
      toast(e.status ? `Not signed out: ${e.message} This browser is still signed in. Try Sign out again.` : `Not signed out: Hatchabot did not answer (${e.message}). This browser is still signed in. Try Sign out again.`, 15000);
      return;
    }
  }
  try { localStorage.removeItem('hatchabot_email'); } catch {}
  // Forget Google's remembered pick, so the next sign-in shows the account
  // chooser (with "Use another account") instead of silently re-selecting
  // the same email — this is what makes account SWITCHING actually work.
  try { google.accounts.id.disableAutoSelect(); } catch { /* GSI not loaded */ }
  if (!window.__noReload) location.reload(); // the click-through check stays on the page
}

/**
 * Ends every session this person has, on every device: a sign-in left on a
 * borrowed or lost device otherwise kept working for its full 14 days
 * (review, 2026-09-29). Plain sign-out above still only forgets this browser.
 */
async function signOutEverywhere() {
  // Command-line tokens end too (2026-09-30): they never read the sign-in
  // generation, so "every device" left them working for up to 90 days.
  if (!confirm('Sign out on every device? Every browser signed in as you, this one included, will need to sign in again. Command-line sign-ins are ended too; a Google-signed-in hatchabot CLI needs `hatchabot logout` on that computer.')) return;
  try { await api('/v1/logout/everywhere', { method: 'POST' }); }
  catch (e) { if (e.message !== 'auth required') toast(e.message); return; }
  try { localStorage.removeItem('hatchabot_email'); } catch {}
  try { google.accounts.id.disableAutoSelect(); } catch { /* GSI not loaded */ }
  toast('Signed out on every device.');
  if (!window.__noReload) location.reload(); // the click-through check stays on the page
}

async function onGoogleCredential(response) {
  try {
    const out = await idpCall('signInWithIdp', {
      postBody: `id_token=${encodeURIComponent(response.credential)}&providerId=google.com`,
      requestUri: location.origin,
      returnSecureToken: true,
    });
    await startSession(out.idToken);
  } catch (e) { $('loginErr').textContent = e.message; }
}

/**
 * An account made with an email and a password must confirm its address
 * before it may sign in (the server refuses an unverified email: anyone could
 * sign up as anyone). Identity Platform sends that email only when asked, and
 * the app never asked: a new account met "Verify your email address" with no
 * email to verify it by. The token is kept so "Send the link again" can ask.
 */
let idVerifyToken = '';
function idShowVerify(idToken, text) {
  idVerifyToken = idToken;
  $('loginErr').textContent = '';
  $('idVerifyText').textContent = text;
  $('idVerify').hidden = false;
}
async function idSendVerification(idToken, email) {
  await idpCall('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken });
  idShowVerify(idToken, `We sent a link to ${email}. Open it, then come back here and press Sign in.`);
}
async function idResendVerification() {
  try { await idSendVerification(idVerifyToken, $('loginEmail').value.trim()); }
  catch (e) { $('loginErr').textContent = e.message; }
}

async function idSignIn() {
  try {
    const out = await idpCall('signInWithPassword', {
      email: $('loginEmail').value.trim(), password: $('loginIdPw').value, returnSecureToken: true,
    });
    try { await startSession(out.idToken); }
    catch (e) {
      if (!/^Verify your email/.test(e.message)) throw e;
      // The password was right; the address is not confirmed yet.
      idShowVerify(out.idToken, `${out.email || 'Your email address'} is not verified yet. Open the link we sent, then press Sign in.`);
    }
  } catch (e) { $('loginErr').textContent = e.message; }
}

async function idSignUp() {
  try {
    const email = $('loginEmail').value.trim();
    const out = await idpCall('signUp', { email, password: $('loginIdPw').value, returnSecureToken: true });
    // No session yet: the server would refuse it until the address is confirmed.
    await idSendVerification(out.idToken, out.email || email);
  } catch (e) { $('loginErr').textContent = e.message; }
}

/** Plain http, and not this machine: a sign-in here crosses the network in the clear (HB-0109). */
function plainHttpFromAfar(loc = location) {
  return loc.protocol === 'http:' && !/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(loc.hostname);
}
/**
 * The one config read a closed sign-in screen waits on: requests that find the session gone
 * together open it once. Each read of its own opened it as it came, and one that came after a
 * sign-in put the screen back over the page (HB-0951).
 */
let loginOpening = null;
function showLogin() {
  pageSessionEnded();
  if ($('sfBlock')) $('sfBlock').hidden = true; // the next sign-in is judged afresh
  if (!loginDlg.open && !loginOpening) {
    $('loginErr').textContent = '';
    $('idVerify').hidden = true;
    $('loginPlainHttp').hidden = !plainHttpFromAfar();
    loginOpening = loadConfig().then(() => {
      // Signed in meanwhile (another tab, or a read that found a session): no sign-in screen.
      if (loginDlg.open || !pageSignedOut) return;
      loginDlg.showModal();
      (appConfig.authMode === 'identity' ? $('loginEmail') : $('loginPw')).focus();
    }).finally(() => { loginOpening = null; });
  }
}
/**
 * "Forgot password?" A reset link goes to the Telegram account already proven
 * to be yours, through a bot you have talked to — and to nowhere else. The
 * answer is the same whether or not the account exists, so this page cannot
 * be used to find out who has one; it says what to do in every case instead.
 */
async function forgotPassword() {
  const username = ($('loginUser').value || '').trim() || (prompt('Your username:') || '').trim();
  if (!username) return;
  const out = $('forgotOut');
  out.textContent = 'Sending…';
  try { await api('/v1/local-accounts/recover', { method: 'POST', body: { username } }); } catch { /* same answer regardless */ }
  out.innerHTML = `If <b>${esc(username)}</b> has used Telegram with Hatchabot, a reset link is on its way there now —
    from one of your agents' bots, valid for 15 minutes. Your current password keeps working until you use it.
    <br><br>No message? Use your <a href="#" ${onAction('click', 'showRecoverForm', [], 'prevent')}>recovery code</a>,
    or ask whoever runs this machine to send you a reset link from ⚙ Settings → You.
    If that is <b>you</b> and you have no code, run <code>hatchabot accounts reset-password ${esc(username)}</code> on the machine itself.${appConfig.publicAddress ? `
    <br><br>This is the public address: here a reset can be asked for once an hour, and <b>an account that owns this machine is recovered at the private address only</b> (on your network or your tailnet), by link or by recovery code.` : ''}`;
}

/** An invitation link: show who it is for, then let them choose a password. */
// loadConfig runs more than once on a page (at start, and again when the
// first request finds no session), so this must be safe to repeat. It used to
// replace the lede for a reset — deleting #claimFor — and the second pass then
// crashed on the missing element: "Cannot set properties of null" on every
// Telegram reset link (found 2026-09-23).
let claimLoaded = null;
async function loadClaim(code) {
  if (claimLoaded === code) return;
  claimLoaded = code;
  try {
    const r = await api('/v1/local-accounts/claim?code=' + encodeURIComponent(code));
    $('claimUser').value = r.username;
    // A reset reads as one, not as a second invitation. The whole lede is
    // written each time, never patched.
    $('claimLede').innerHTML = r.reset
      ? `Choose a new password for <b>${esc(r.username)}</b>. Your old one stops working once you do.`
      : r.owner
        ? `This Hatchabot is yours, <b>${esc(r.username)}</b>. Choose a password and you're in.`
        : `You've been invited as <b>${esc(r.username)}</b>. Choose a password and you're in.`;
  } catch (e) {
    claimLoaded = null;
    $('loginErr').textContent = e.message;
    $('acctClaim').style.display = 'none';
    $('acctLogin').style.display = '';
  }
}

async function acctClaim() {
  const code = new URLSearchParams(location.search).get('claim');
  $('claimBtn').disabled = true;
  pageSignIns++; // through to the end of pageSignedIn, a reload for another account waits (HB-0491)
  // What was sent is what is saved: the field is still open while the answer comes (HB-1133).
  const password = $('claimPw').value;
  try {
    const r = await api('/v1/local-accounts/claim', { method: 'POST', body: { code, password } });
    await rememberPassword(r.username, password);
    history.replaceState(null, '', location.pathname);   // the code is spent
    loginDlg.close(); $('claimPw').value = '';
    await loadConfig(); await pageSignedIn(r.recoveryCode ? () => showRecoveryCode(r.recoveryCode, '', r.id, { here: true }) : undefined); // the owner, arriving from a command-line setup
  } catch (e) { $('loginErr').textContent = e.message; }
  finally { $('claimBtn').disabled = false; pageSignInEnded(); }
}

/** Offer the browser's password manager the credential explicitly: a dialog
 *  that never navigates doesn't always trip Chrome's own heuristic. */
async function rememberPassword(id, password) {
  try {
    if (window.PasswordCredential && navigator.credentials?.store) {
      await navigator.credentials.store(new PasswordCredential({ id, password, name: id }));
    }
  } catch { /* the browser declined; the form markup still offers to save */ }
}

/** Accounts mode: username + password against this installation's own list. */
async function acctSignIn() {
  $('acctLoginBtn').disabled = true;
  pageSignIns++; // through to the end of pageSignedIn, a reload for another account waits (HB-0491)
  // The pair that signed in is the pair offered to the password manager: read
  // again after the answer, it was whatever the fields held by then (HB-1133).
  const username = $('loginUser').value.trim(), password = $('loginAcctPw').value;
  try {
    await api('/v1/login', { method: 'POST', body: { username, password } });
    await rememberPassword(username, password);
    loginDlg.close(); $('loginAcctPw').value = '';
    await loadConfig(); await pageSignedIn();
  } catch (e) { $('loginErr').textContent = e.message === 'auth required' ? 'Wrong username or password' : e.message; }
  finally { $('acctLoginBtn').disabled = false; pageSignInEnded(); }
}

/** First run: create account #1, which adopts anything a password-mode
 *  installation already owned. */
async function acctBootstrap() {
  $('setupBtn').disabled = true;
  pageSignIns++; // through to the end of pageSignedIn, a reload for another account waits (HB-0491)
  const username = $('setupUser').value.trim(), password = $('setupPw').value; // as sent, also saved (HB-1133)
  try {
    const r = await api('/v1/local-accounts/bootstrap', { method: 'POST', body: { username, password, setupCode: $('setupCode').value.trim() || undefined } });
    await rememberPassword(username, password);
    loginDlg.close(); $('setupPw').value = '';
    if (r.adopted) toast(`Account created — it adopted ${r.adopted} existing record${r.adopted === 1 ? '' : 's'}.`);
    await loadConfig(); await pageSignedIn(r.recoveryCode ? () => showRecoveryCode(r.recoveryCode, '', r.id, { here: true }) : undefined);
  } catch (e) { $('loginErr').textContent = e.message; }
  finally { $('setupBtn').disabled = false; pageSignInEnded(); }
}

/** Accounts mode only: the roster (host owner) and your own password. */
async function loadAccounts() {
  // One shared password: offer the way out of it, and nothing else here.
  if ($('familyOn')) $('familyOn').hidden = (appConfig.authMode ?? 'password') !== 'password';
  // Google sign-in with local accounts beside it: the Google owner has no
  // local account of its own, but manages everyone else's (night review).
  // Someone signed in with one of those accounts has one, and manages their
  // own password and recovery code: told apart by whether it answers (HB-1138).
  const withGoogle = appConfig.authMode === 'identity' && appConfig.localAccounts;
  if (appConfig.authMode !== 'accounts' && !withGoogle) return;
  let me;
  if (withGoogle) { try { me = await api('/v1/local-accounts/me'); } catch { me = undefined; } }
  const googleOwner = withGoogle && !me;
  if (!googleOwner) {
    $('acctSelf').hidden = false;
    if (!me) { try { me = await api('/v1/local-accounts/me'); } catch { return; } }
    renderRecoveryStatus(me.recoveryCodeCreatedAt);
    if (!me.hostOwner) { $('acctAdmin').hidden = true; return; }
    $('acctAdmin').hidden = false;
  }
  try {
    const rows = await api('/v1/local-accounts');
    $('acctAdmin').hidden = false;
    $('acctList').innerHTML = rows.map(a => `<div class="pair" style="gap:8px;align-items:center">
      <b>${esc(a.username)}</b>${a.hostOwner ? ' <span class="chip">host owner</span>' : ''}
      ${a.pending ? '<span class="chip">invitation not accepted yet</span>' : a.invitationExpired ? '<span class="chip">invitation expired</span>' : `<span class="sub">${a.agents} agent${a.agents === 1 ? '' : 's'}</span>`}
      <span style="margin-left:auto;display:flex;gap:6px">
        ${a.pending && !a.claimPath ? `<span class="sub" title="An invitation link is a way into that account, so it is not listed at the public address">invitation link: at the private address</span>`
          : a.pending ? `<button ${onAction('click', 'copyAccountInvite', [`${(a.claimPath ?? '') ?? ''}`, `${(a.claimExpires ?? '') ?? ''}`])}>Copy invitation</button>`
          : a.invitationExpired ? `<button ${onAction('click', 'sendResetLink', [`${a.id ?? ''}`, `${a.username ?? ''}`, true])} title="The old link no longer works; this makes a new one">Send a new invitation</button>`
          : a.hostOwner ? '' : `<button ${onAction('click', 'sendResetLink', [`${a.id ?? ''}`, `${a.username ?? ''}`])} title="They choose a new password themselves; you never see it">Send a reset link</button>`}
        ${a.hostOwner ? '' : `<button class="danger" ${onAction('click', 'removeAccount', [`${a.id ?? ''}`, `${a.username ?? ''}`])}>Remove</button>`}
      </span></div>`).join('');
  } catch (e) { if (googleOwner) $('acctAdmin').hidden = true; else $('acctList').textContent = e.message; }
}

/**
 * Shared password → an account per person. The server writes the .env and
 * restarts itself; this waits for it to come back and sends you to sign in.
 */
async function turnOnFamilyAccounts(btn) {
  const username = $('famUser').value.trim(), password = $('famPw').value;
  $('famErr').textContent = '';
  if (!confirm(`Turn on family accounts, with you as "${username}"?\n\nEverything on this machine becomes yours. Hatchabot restarts once and you sign in with this username.\n\nThis can't be undone — a shared password again would put everyone's agents behind one person.`)) return;
  btn.disabled = true; btn.textContent = 'Switching…';
  try {
    const r = await api('/v1/auth/family-accounts', { method: 'POST', body: { username, password } });
    // The recovery code first, shown once — the restart below reloads the page.
    if (r.recoveryCode) {
      await showRecoveryCode(r.recoveryCode, 'Your recovery code. You own this machine, so nobody can send you a reset link: this code is how you get back in if you forget your password. Save it somewhere safe — it is shown only now.', r.ownerId, { here: true });
    }
    if (!r.restarting) {
      $('famErr').innerHTML = 'Done — now restart Hatchabot (<code>./scripts/restart.sh</code>) and sign in as <b>' + esc(username) + '</b>.';
      return;
    }
    toast('Switching to family accounts — back in a few seconds.', 10000);
    // Wait for the restart, then land on the sign-in screen.
    for (let i = 0; i < 40; i++) {
      await new Promise(res => setTimeout(res, 1000));
      try { const c = await fetch('/v1/config').then(x => x.json()); if (c.authMode === 'accounts') { location.reload(); return; } } catch {}
    }
    location.reload();
  } catch (e) {
    $('famErr').textContent = e.message;
    btn.disabled = false; btn.textContent = 'Turn on family accounts';
  }
}

async function addAccount(btn) {
  btn.disabled = true;
  try {
    const r = await api('/v1/local-accounts', { method: 'POST', body: { username: $('acctNewUser').value.trim() } });
    // The step everyone forgets: an account with no source can't do anything.
    const sourceNote = $('acctShareSource').checked ? await shareSourceForInvite() : '';
    $('acctNewUser').value = '';
    const url = (appConfig?.linkUrl || appConfig?.appUrl || location.origin).replace(/\/$/, '') + r.claimPath;
    $('acctInviteOut').style.display = '';
    $('acctInviteOut').textContent = url;
    $('acctInviteNote').textContent = sourceNote; // stays: the toast is gone in seconds
    let said;
    try { await navigator.clipboard.writeText(url); said = 'Invitation copied — send it to them. It expires in 48 hours.'; }
    catch { said = 'Invitation ready — copy the link below.'; }
    toast(sourceNote ? `${said} ${sourceNote}` : said, sourceNote ? 12000 : 7000);
    await loadAccounts();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}

/**
 * "Share my AI source with them": what it is for is that the new account has a
 * source. One already shared does that, so no second private source is opened
 * up (HB-0408). Says, in words, what was done or why nothing was.
 */
async function shareSourceForInvite() {
  try { profiles = await api('/v1/ai-profiles'); } catch { /* the list we have */ }
  // Not a machine login shared before the server began refusing that: it never runs another account's agent.
  const shared = (profiles || []).find(p => p.shared && p.credential !== 'machine-login');
  if (shared) return `They can use ${shared.name}, which is already shared; nothing more was shared.`;
  const p = (profiles || []).find(x => x.mine !== false && x.credential !== 'machine-login');
  if (!p) return 'No AI source was shared: you have none that can be (a machine login is never shared this way), so they will need their own.';
  try {
    await api(`/v1/ai-profiles/${p.id}`, { method: 'PATCH', body: { shared: true } });
  } catch (e) { return `${p.name} could not be shared (${e.message}), so they have no AI source yet.`; }
  try { profiles = await api('/v1/ai-profiles'); } catch { p.shared = true; }
  if ($('aiList')?.childElementCount) renderAiList();
  return `${p.name} is now shared with everyone on this server, and they spend on it.`;
}

async function copyAccountInvite(path, expires) {
  const url = (appConfig?.linkUrl || appConfig?.appUrl || location.origin).replace(/\/$/, '') + path;
  // Its real end: a one-time sign-in link replaces the 48-hour code with one good 15 minutes.
  try { await navigator.clipboard.writeText(url); toast(`Invitation copied${expires ? ` — it expires ${new Date(expires).toLocaleString()}` : ''}.`, 7000); }
  catch { toast(url, 12000); }
}

/**
 * A reset link, the same kind as an invitation: they choose their own new
 * password and you never learn it. Their old one keeps working until they use
 * the link, so sending one never locks anybody out. `invitation`: the same
 * link renews an invitation that expired, for someone with no password yet.
 */
async function sendResetLink(id, username, invitation = false) {
  const what = invitation ? 'New invitation' : 'Reset link';
  try {
    const r = await api(`/v1/local-accounts/${id}/reset-link`, { method: 'POST', body: {} });
    const url = (appConfig?.linkUrl || appConfig?.appUrl || location.origin).replace(/\/$/, '') + r.claimPath;
    $('acctInviteOut').style.display = '';
    $('acctInviteOut').textContent = url;
    $('acctInviteNote').textContent = '';
    const copied = await copyText(url);
    toast(`${what} ${copied ? 'copied' : 'ready below'} — send it to ${username}. It works once and expires in 48 hours.`, 9000);
    if (invitation) await loadAccounts();
  } catch (e) { toast(e.message); }
}

async function removeAccount(id, username) {
  if (!confirm(`Remove the account ${username}? Their agents must be gone first.`)) return;
  try { await api(`/v1/local-accounts/${id}`, { method: 'DELETE' }); toast('Account removed'); await loadAccounts(); }
  catch (e) { toast(e.message); }
}

/** Shown once, with no way to see it again — so it asks to be saved, and
 *  Escape does not dismiss it before that. */
document.addEventListener('DOMContentLoaded', () => {
  // Status, Bulk actions, Settings and New live in the header (Chris, 2026-09-26).
  const acts = $('v2HubActions'), acct = document.querySelector('#v2Header .v2acct');
  if (acts && acct) acct.parentNode.insertBefore(acts, acct);
  $('recoveryDlg')?.addEventListener('cancel', (e) => { e.preventDefault(); if ($('recoverySaved').checked) closeRecoveryCode(); });
  // Esc is stopped at the key as well: a browser lets a second Esc past a refused 'cancel'. On the document, first,
  // so an Esc whose target is outside the dialog (the page behind, the body) is stopped too.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (sfDlg.open || (recoveryDlg.open && !$('recoverySaved').checked) || (backupDlg.open && !$('backupSaved').checked)) e.preventDefault();
  }, true);
  // Gone from the page when the dialog closes: a one-time code must not sit in the DOM for the next person at the keyboard.
  // (Not when it is open again by then: the event comes a task after the close, and a code put away can be back.)
  $('recoveryDlg')?.addEventListener('close', recoveryCodeClosed);
  // Backup codes, the same way: not before "I've saved them". After it, a click outside or Esc is Done, so they
  // leave the page and what waits on them goes on (a bare close left both, and a passkey's setup waiting for ever).
  $('backupDlg')?.addEventListener('cancel', (e) => { e.preventDefault(); if ($('backupSaved').checked) closeBackupCodes(); });
  // The second-factor prompt goes only by its own buttons: closed any other way, its request waited for ever, and so did every later prompt.
  $('sfDlg')?.addEventListener('cancel', (e) => e.preventDefault());
  // Closed anyway (a browser that lets a second Esc through) while its request still waits: shown again.
  $('sfDlg')?.addEventListener('close', () => { if (sfPending && !sfDlg.open) sfDlg.showModal(); });
});
function closeRecoveryCode() { recoveryDlg.close(); recoveryCodeClosed(); }
function recoveryCodeClosed() {
  if (recoveryDlg.open) return;
  $('recoveryCode').textContent = '';
  const done = recoveryResolve; recoveryResolve = null;
  done?.();
  pageReloadWhenQuiet(); // one waiting for it (HB-0491)
}
/**
 * Shows the code once; resolves when it is closed. `ownerId`: whose it is, when the server said (pageSecretShown).
 * `here`: for whoever is at this page now, whatever the page last read or could not read: what their own sign-in brought,
 * or the shared password's owner becoming an account.
 */
let recoveryResolve = null;
function showRecoveryCode(code, lede, ownerId, { here = false } = {}) {
  if (!here && pageSignedOut) return pageSecretLater(ownerId, () => showRecoveryCode(code, lede, ownerId));
  if (!here && pageSecretNotHere(ownerId)) return Promise.resolve();
  $('recoveryCode').textContent = code;
  if (lede) $('recoveryLede').innerHTML = lede;
  $('recoverySaved').checked = false;
  $('recoveryDone').disabled = true;
  recoveryDlg.showModal();
  pageSecretShown(recoveryDlg, ownerId);
  return new Promise((res) => { recoveryResolve = res; });
}
function downloadRecoveryCode() {
  const who = ($('recUser').value || $('setupUser').value || '').trim();
  const text = `Hatchabot recovery code${who ? ` for ${who}` : ''}\n${location.origin}\n\n${$('recoveryCode').textContent}\n\n` +
    'Use it on the sign-in screen: "Use a recovery code". It works once.\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = 'hatchabot-recovery-code.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function newRecoveryCode(btn) {
  btn.disabled = true;
  try {
    const r = await pageHold(() => api('/v1/local-accounts/me/recovery-code', { method: 'POST', body: { current: $('recCurPw').value } }));
    $('recCurPw').value = '';
    showRecoveryCode(r.recoveryCode, '', r.ownerId);
    renderRecoveryStatus(new Date().toISOString());
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}
function renderRecoveryStatus(createdAt) {
  const el = $('recoveryStatus');
  if (!el) return;
  el.innerHTML = createdAt
    ? `You have one, made ${esc(new Date(createdAt).toLocaleDateString())}. If you have lost it, make a new one.`
    : '<b style="color:var(--warn)">You have none.</b> Without one, a forgotten password needs Telegram or a terminal on this machine. Make one and keep it somewhere safe.';
}
function showRecoverForm() {
  $('recUser').value = ($('loginUser').value || '').trim();
  $('acctLogin').style.display = 'none';
  $('acctRecover').style.display = '';
  $('loginErr').textContent = '';
  ($('recUser').value ? $('recCode') : $('recUser')).focus();
}
function hideRecoverForm() {
  $('acctRecover').style.display = 'none';
  $('acctLogin').style.display = '';
  $('loginErr').textContent = '';
}
async function acctRecover() {
  $('recBtn').disabled = true;
  pageSignIns++; // through to the end of pageSignedIn, a reload for another account waits (HB-0491)
  const password = $('recPw').value; // as sent, also saved (HB-1133)
  try {
    const r = await api('/v1/local-accounts/recover-with-code', { method: 'POST', body: { username: $('recUser').value.trim(), code: $('recCode').value, password } });
    await rememberPassword(r.username, password);
    loginDlg.close(); $('recPw').value = ''; $('recCode').value = ''; hideRecoverForm();
    await loadConfig();
    await pageSignedIn(() => showRecoveryCode(r.recoveryCode, '<b>You are back in.</b> Your old code is used up — this is your new one. Save it somewhere safe, away from this computer.', r.ownerId, { here: true }));
  } catch (e) { $('loginErr').textContent = e.message; }
  finally { $('recBtn').disabled = false; pageSignInEnded(); }
}

async function changeMyPassword(btn) {
  btn.disabled = true;
  try {
    await api('/v1/local-accounts/me/password', { method: 'POST', body: { current: $('acctCurPw').value, password: $('acctNewSelfPw').value } });
    $('acctCurPw').value = ''; $('acctNewSelfPw').value = '';
    toast('Password changed');
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; }
}

async function doLogin() {
  $('loginBtn').disabled = true;
  pageSignIns++; // through to the end of pageSignedIn, a reload for another account waits (HB-0491)
  try {
    await api('/v1/login', { method: 'POST', body: { password: $('loginPw').value } });
    loginDlg.close(); $('loginPw').value = '';
    await pageSignedIn();
  } catch (e) { $('loginErr').textContent = e.message === 'auth required' ? 'Wrong password' : e.message; }
  finally { $('loginBtn').disabled = false; pageSignInEnded(); }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !loginDlg.open) return;
  // Forms handle Enter themselves; only the Google panel needs this.
  if (e.target instanceof HTMLElement && e.target.closest('form')) return;
  if (appConfig.authMode === 'identity') idSignIn();
});
// dialogs shouldn't be escapable into a broken page when auth is required
loginDlg?.addEventListener('cancel', (e) => e.preventDefault());
loginDlg?.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.preventDefault(); });

let toastTimer;
/** Adopt's scheduled tasks that did not come across, said: unread ones read as none (review of 2026-10-22). */
function adoptTasksMissed(c) {
  if (!c) return '';
  const parts = [];
  if (c.failed) parts.push(`${c.failed} scheduled task${c.failed > 1 ? 's' : ''} could not be carried`);
  if (c.error) parts.push(`its scheduled tasks were not all read: ${c.error}`);
  return parts.length ? ` · ${parts.join('; ')}.` : '';
}
function toast(msg, ms, cls) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (cls ? ` ${cls}` : '');
  clearTimeout(toastTimer);
  // Long messages (errors, mostly) get reading time; a tap dismisses early.
  toastTimer = setTimeout(() => t.classList.remove('show'), ms ?? Math.max(2600, msg.length * 60));
  t.onclick = () => { clearTimeout(toastTimer); t.classList.remove('show'); };
}
