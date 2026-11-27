// web/app/join.js: the join page (web/join.html): an invitation, and joining by it.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

const code = location.pathname.split('/').pop();
const card = document.getElementById('card');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const LABEL = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord' };
let ways = [];
const whereText = (w) => w.kind === 'slack' && w.team ? ` <span style="color:var(--dim)">in ${esc(w.team)}</span>`
  : w.kind === 'discord' && w.servers?.length ? ` <span style="color:var(--dim)">in ${esc(w.servers.join(', '))}</span>` : '';

async function init() {
  // An answer about the invite only from the server's own, good or not: no answer, or an error
  // (too many tries, a proxy's page), says nothing of it, and was shown as an invalid link
  // with "ask for a new one" (HB-1034). That is said as what it is, with a way to try again.
  let info = null, unchecked = '';
  try {
    const r = await fetch(`/v1/invites/${encodeURIComponent(code)}`);
    const body = await r.json().catch(() => null);
    if (r.ok && typeof body?.valid === 'boolean') info = body;
    else unchecked = (r.status === 429 && typeof body?.reason === 'string' && body.reason) || (typeof body?.error === 'string' && body.error) || `The server answered ${r.status}.`;
  } catch (e) { unchecked = e?.message || 'No answer.'; }
  if (unchecked) {
    card.innerHTML = `<div class="agent">Hmm.</div><div class="notice">This invite could not be checked just now: ${esc(unchecked.replace(/[.!]?$/, '.'))} The link may still be good, so try again in a moment.</div>
      <button id="retryBtn">Try again</button>`;
    document.getElementById('retryBtn').onclick = () => { card.innerHTML = '<div style="color:var(--dim)">Checking your invite…</div>'; init(); };
    return;
  }
  if (!info.valid) {
    // names-nobody: made by an older release for a bare t.me link, with no name in it (HB-1439 review).
    const why = { expired: 'This invite has expired.', used: 'This invite was already used.', 'names-nobody': 'This invite names nobody.' }[info?.reason]
      ?? "This invite link isn't valid.";
    card.innerHTML = `<div class="agent">Hmm.</div><div class="notice">${why} Ask the person who sent it for a new one.</div>`;
    return;
  }
  if (info.webChat) return initWebChat(info);
  ways = Array.isArray(info.channels) && info.channels.length ? info.channels : [{ kind: 'telegram' }];
  // Signed in here already (HB-1149): they choose whether the seat is that account's. Never their own agent's.
  const you = info.own || info.alreadyMember ? '' : info.signedInAs || '';
  const passwords = info.authMode === 'accounts' || !!info.localAccounts;
  card.innerHTML = `
    <div style="color:var(--dim);font-size:14px">You've been invited to</div>
    <div class="agent">${esc(info.agentName)}</div>
    <div class="notice">
      <b>Heads up:</b> this is a shared agent. Things you tell it may be
      remembered and shared with the other people who use it.
    </div>
    <label>Your name (so others know who's here)</label>
    <input id="name" maxlength="64" placeholder="e.g. Sam">
    ${ways.length > 1 ? `<label>Which app will you use?</label>
      <div class="ways" role="radiogroup">${ways.map((w, i) => `
        <label class="way"><input type="radio" name="way" value="${esc(w.kind)}"${i === 0 ? ' checked' : ''}>
          <span><b>${LABEL[w.kind] || esc(w.kind)}</b>${whereText(w)}</span></label>`).join('')}</div>` : ''}
    <div class="notice" id="factorNote" role="alert" hidden></div>
    <div id="gsi" style="display:flex;justify-content:center;margin:12px 0"></div>
    ${you ? `<button id="joinAsBtn">Join as ${esc(you)}</button>` : ''}
    <button id="joinBtn"${you ? ' class="btn alt"' : ''}>Join with ${LABEL[ways[0]?.kind] || 'Telegram'} only</button>
    ${you ? `<div class="hint">Join as ${esc(you)} and the agent is also on your home screen here. Not you? Join with the app only.</div>`
      : info.alreadyMember ? `<div class="hint">You are already on ${esc(info.agentName)} as ${esc(info.signedInAs || 'your account here')}: nothing to join. Not you? Join with the app only.</div>`
      : passwords && !info.own && !info.factor ? '<div class="hint">Have an account on this Hatchabot? Sign in to it first, then open this link again to join as yourself.</div>' : ''}
    <div class="err" id="err"></div>`;
  document.querySelectorAll('input[name=way]').forEach((r) => r.addEventListener('change', () => {
    document.getElementById('joinBtn').textContent = `Join with ${LABEL[r.value] || r.value} only`;
  }));
  document.getElementById('joinBtn').onclick = () => join();
  const asBtn = document.getElementById('joinAsBtn');
  if (asBtn) asBtn.onclick = () => join(undefined, true);
  if (info.factor) showFactorNote(info.factor);
  setupSignIn();
}

/**
 * Optional sign-in: joining while signed in binds the membership to a real
 * account, so the invitee can also open this page's app and see the agent.
 * Without it the membership is Telegram-only, exactly as before.
 */
async function setupSignIn(onToken = join) {
  let cfg;
  try { cfg = await fetch('/v1/config').then(r => r.json()); } catch { return; }
  const cid = cfg?.identity?.googleClientId, apiKey = cfg?.identity?.apiKey;
  if (cfg?.authMode !== 'identity' || !cid || !apiKey) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    google.accounts.id.initialize({
      client_id: cid,
      callback: async (resp) => {
        try {
          const out = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${apiKey}`,
            { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                postBody: `id_token=${encodeURIComponent(resp.credential)}&providerId=google.com`,
                requestUri: location.origin, returnSecureToken: true }) },
          ).then(r => r.json());
          if (!out.idToken) throw new Error('Sign-in failed');
          await onToken(out.idToken);
        } catch (e) { document.getElementById('err').textContent = e.message; }
      },
    });
    google.accounts.id.renderButton(document.getElementById('gsi'),
      { theme: document.documentElement.dataset.theme === 'dark' ? 'filled_black' : 'outline', size: 'large', text: 'signin_with' });
  };
  document.head.appendChild(s);
}

/** `asAccount`: "Join as <name>" was pressed, so the seat is the account this browser is signed in as (HB-1149). */
async function join(idToken, asAccount = false) {
  const btn = document.getElementById('joinBtn'), asBtn = document.getElementById('joinAsBtn');
  const chosen = document.querySelector('input[name=way]:checked')?.value || ways[0]?.kind || 'telegram';
  btn.disabled = true;
  if (asBtn) asBtn.disabled = true;
  document.getElementById('err').textContent = '';
  try {
    const res = await fetch('/v1/join', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: document.getElementById('name').value, idToken, channel: chosen, ...(asAccount ? { asAccount: true } : {}) }),
    });
    const data = await res.json();
    // Signed in, but this address wants their second factor first: said, and the app only is still there.
    if (res.status === 401 && data.secondFactor) { showFactorNote(data); btn.disabled = false; if (asBtn) asBtn.disabled = false; return; }
    if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
    // Stopped, asleep or being rebuilt: the join is kept, and the window for their first message opens once it runs (HB-0992).
    const waits = data.notRunning ? `<div class="notice">It's not running right now; your first message will be let in as soon as it is.</div>` : '';
    if (chosen !== 'telegram') {
      const label = LABEL[chosen] || chosen;
      const w = ways.find((x) => x.kind === chosen) || {};
      // No link from the app: no button below to open it with (HB-1279).
      const linked = /^https:\/\//i.test(data.deepLink || '');
      card.innerHTML = `
      <div class="agent">You're in 🎉</div>
      <ol class="steps">
        ${chosen === 'slack' ? `<li>You need to be in the <b>${esc(w.team || 'same')}</b> Slack workspace.</li>`
          : `<li>You need to share a server with it${w.servers?.length ? `: join <b>${esc(w.servers.join(', '))}</b> first if you haven't` : ''}.</li>`}
        <li>${linked ? 'Open' : 'Find'} <b>${esc(data.agentName)}</b> in ${esc(label)}${linked ? ' below' : ''} and send it a direct message — that links you to the agent.</li>
        <li>Give it a few seconds, then just chat.</li>
      </ol>
      ${waits}
      ${linked /* https only: never a javascript: link (review, 2026-10-09) */ ? `<a class="btn" href="${esc(data.deepLink)}" target="_blank" rel="noopener">Open in ${esc(label)}</a>`
        // No link from the app: said as that, with where to look. "Isn't running" was said here, whatever the agent's state (HB-1218).
        : `<div class="notice">${esc(label)} gave no link to it, so there is no button here. Look for <b>${esc(data.agentName)}</b> ${chosen === 'slack'
          ? `under Apps in the ${w.team ? `<b>${esc(w.team)}</b> ` : ''}Slack workspace`
          : `in the member list of ${w.servers?.length ? `<b>${esc(w.servers.join(', '))}</b>` : 'a server you share with it'}`}
          and send it a direct message. Not there under that name? Ask the person who invited you what its bot is called.</div>`}`;
      return;
    }
    // No bot name: the agent has no Telegram bot yet, so there is nothing to message. "Isn't running" was said, whatever its state (HB-1279).
    card.innerHTML = `
      <div class="agent">You're in 🎉</div>
      <ol class="steps">
        <li>${data.botUsername ? `Open <b>${esc(data.agentName)}</b> in Telegram below.` : `Once it has a Telegram bot, open <b>${esc(data.agentName)}</b> in Telegram.`}</li>
        <li>Send it any message — that links your Telegram to the agent.</li>
        <li>Give it a few seconds, then just chat.</li>
      </ol>
      ${waits}
      ${data.botUsername ? `
        <a class="btn" href="https://t.me/${esc(data.botUsername)}">Open in Telegram app</a>
        <a class="btn alt" href="https://web.telegram.org/k/#?tgaddr=${encodeURIComponent('tg://resolve?domain=' + data.botUsername)}" target="_blank">Open Telegram Web instead</a>
      ` : `<div class="notice"><b>${esc(data.agentName)}</b> has no Telegram bot yet, so there is no button here. Ask the person who invited you to give it one, then message it.</div>`}`;
  } catch (e) {
    document.getElementById('err').textContent = e.message;
    btn.disabled = false;
    if (asBtn) asBtn.disabled = false;
  }
}
/**
 * An invite to chat on the web (2026-09-29): no app to pick, no pairing. They
 * sign in to this Hatchabot and are in at once: with Google on a Google
 * install, with a username and password where this Hatchabot has password
 * accounts (accounts mode, or Google with them added), or as whoever this
 * browser is signed in as already. On a Google install the page offered only
 * Google (2026-11-10): someone with a password account could not join at all.
 */
function initWebChat(info) {
  const google = info.authMode === 'identity';
  const passwords = info.authMode === 'accounts' || !!info.localAccounts;
  webYou = info.signedInAs || '';
  if (info.own) {
    card.innerHTML = `
      <div class="agent">${esc(info.agentName)}</div>
      <div class="notice">This is your own agent, so you can already chat with it. Send this link to the person it is for.</div>
      <a class="btn" href="/">Open Hatchabot</a>`;
    return;
  }
  const googleHint = !google ? '' : webYou || passwords ? 'Or sign in with Google:' : 'Sign in with Google to join:';
  card.innerHTML = `
    <div style="color:var(--dim);font-size:14px">You've been invited to chat on the web with</div>
    <div class="agent">${esc(info.agentName)}</div>
    <div class="notice">
      You chat with it here, in conversations of your own, as a member: you can chat and
      ask it to use its tools, but not schedule tasks or change its settings.<br><br>
      <b>Heads up:</b> it is a shared agent. Things you tell it may be remembered and
      shared with the other people who use it.
    </div>
    <label>Your name (so it knows who's writing)</label>
    <input id="name" maxlength="64" placeholder="e.g. Sam">
    <div class="notice" id="factorNote" role="alert" hidden></div>
    ${passwords ? `<div id="acct" hidden>
        <div class="notice" style="margin-bottom:0">Sign in with the account you have on this Hatchabot.
          No account yet? Ask the person who invited you to make you one, then open this link again.</div>
        <label>Username</label><input id="user" autocomplete="username">
        <label>Password</label><input id="pass" type="password" autocomplete="current-password">
      </div>` : ''}
    ${passwords || webYou ? '<button id="joinBtn"></button>' : ''}
    ${passwords && webYou ? '<div class="hint" id="otherWrap"><a href="#" id="otherAcct">Not you? Sign in with your own account</a></div>' : ''}
    ${google ? `<div class="hint" style="margin-top:16px">${googleHint}</div><div id="gsi" style="display:flex;justify-content:center;margin:8px 0 4px"></div>` : ''}
    <div class="err" id="err"></div>`;
  // Signed in already (or signed in, short of the second factor): join with that session; else the form.
  setWebMode(webYou || info.factor || !passwords ? 'session' : 'form');
  if (info.factor) showFactorNote(info.factor);
  const btn = document.getElementById('joinBtn');
  if (btn) btn.onclick = () => joinWebAccount();
  const other = document.getElementById('otherAcct');
  if (other) other.onclick = (e) => { e.preventDefault(); webYou = ''; setWebMode('form'); document.getElementById('user').focus(); };
  if (google) setupSignIn(joinWeb);
}

/** Who this browser is signed in as here (the label the invite answered), and which way the button joins. */
let webYou = '', webMode = 'session';
function setWebMode(mode) {
  webMode = mode;
  const acct = document.getElementById('acct'), btn = document.getElementById('joinBtn'), other = document.getElementById('otherWrap');
  if (acct) acct.hidden = mode !== 'form';
  if (other) other.hidden = mode === 'form' || !webYou;
  if (btn) btn.textContent = mode === 'form' ? 'Sign in and join' : webYou ? `Join as ${webYou}` : 'Join';
}

/** Signed in, but this address wants a second factor first (HB-0400): what to do, and the app when it can help. */
function showFactorNote(f) {
  const note = document.getElementById('factorNote');
  // The app can ask for a factor, or add one after a link; otherwise it would only refuse them too.
  const appHelps = f.secondFactor === 'required' || f.secondFactor === 'enrol';
  note.innerHTML = esc(f.error) + (appHelps ? '<a class="btn alt" href="/" target="_blank" rel="noopener">Open Hatchabot</a>' : '');
  note.hidden = false;
}

/** Join with the session this browser has, or sign in with the form first; told why when the second factor is what is missing. */
async function joinWebAccount() {
  const btn = document.getElementById('joinBtn'), err = document.getElementById('err'), note = document.getElementById('factorNote');
  btn.disabled = true; err.textContent = ''; note.hidden = true;
  try {
    if (webMode === 'form') {
      const r = await fetch('/v1/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: document.getElementById('user').value, password: document.getElementById('pass').value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Sign-in failed');
      webYou = '';
    }
    const out = await postJoin();
    if (out.signIn) {
      webYou = '';
      if (!document.getElementById('acct')) throw new Error('Sign in with Google below to join.');
      setWebMode('form'); document.getElementById('user').focus();
      return;
    }
    // Signed in, but the factor is missing. The password was right: don't ask for it again.
    if (out.secondFactor) { setWebMode('session'); showFactorNote(out); return; }
    webChatDone(out);
  } catch (e) { err.textContent = e.message; }
  finally { btn.disabled = false; }
}

/** Identity mode: the Google sign-in joins, then starts their session here so the app opens signed in. */
async function joinWeb(idToken) {
  const err = document.getElementById('err');
  err.textContent = '';
  try {
    const out = await postJoin(idToken);
    let note = '';
    // The join is done (the invite is spent): a session that cannot be started
    // is said under it, however it fails. One that never reached the server
    // left the join form up, and pressing again met "already used" (HB-1148).
    try {
      const s = await fetch('/v1/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }) });
      if (!s.ok) {
        const d = await s.json().catch(() => ({}));
        note = `You're a member, but signing you in here failed: ${d.error || s.statusText}. Ask the person who invited you to add your address to this Hatchabot.`;
      }
    } catch (e) {
      note = `You're a member, but this page could not reach Hatchabot to sign you in (${e.message}). Open Hatchabot and sign in with Google there.`;
    }
    webChatDone(out, note);
  } catch (e) { err.textContent = e.message; }
}

async function postJoin(idToken) {
  const res = await fetch('/v1/join', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name: document.getElementById('name').value, idToken }) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.signIn) return { signIn: true };
  if (res.status === 401 && data.secondFactor) return { secondFactor: data.secondFactor, error: data.error };
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
  return data;
}

function webChatDone(data, note = '') {
  card.innerHTML = `
    <div class="agent">You're in 🎉</div>
    <ol class="steps">
      <li>Open Hatchabot below.</li>
      <li>Tap <b>${esc(data.agentName)}</b>, then <b>💬 Chat</b>.</li>
      <li>Just talk — your conversation is yours; its memory is shared.</li>
    </ol>
    ${note ? `<div class="notice">${esc(note)}</div>` : ''}
    <a class="btn" href="/">Open Hatchabot</a>`;
}

init();
