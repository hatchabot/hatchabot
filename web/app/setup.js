// web/app/setup.js: the first-run setup guide, and what its steps read (the newest backup, the tailnet, the shared keys).
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- setup: first-run subscription profile --------------------------------

let setupOpen = false; // the guide is also reachable long after the first agent

let backupAgeH = null; // hours since the newest backup set; null = unknown or not the machine owner
let backupIncomplete = false; // the newest set's run failed or never finished (review, 2026-09-29)
/** What this machine knows about its own tailnet, for the HTTPS setup step. */
let tailnet = null;
async function loadTailnet() {
  try { tailnet = await api('/v1/tailscale'); }
  catch { tailnet = null; } // not the machine owner, or the probe is unavailable
}
/** Whether the fleet's Gemini and Brave keys are set — the two optional setup steps. */
let fleetKeys = { media: null, search: null }; // null = unknown or not the machine owner
async function loadFleetKeys() {
  try { fleetKeys = { media: !!(await api('/v1/media-key')).set, search: !!(await api('/v1/search-key')).set }; }
  catch { fleetKeys = { media: null, search: null }; }
}
async function loadBackupAge() {
  try {
    const r = await api('/v1/backups?latest=1');
    const newest = (r.backups ?? [])[0];
    backupAgeH = newest ? (Date.now() - Date.parse(newest.date + 'T03:30:00')) / 3600_000 : null;
    backupIncomplete = newest?.complete === false;
  } catch { backupAgeH = null; backupIncomplete = false; } // not the host owner, or no backups configured
}

/**
 * The setup checklist, in the order a house actually gets set up: three steps
 * to the first agent, then the three that decide whether it is any use on a
 * Tuesday — a manager you can reach from your phone, an address that works
 * away from home, and a backup that has actually run.
 *
 * Every step is marked done from live state, never from a "you have seen
 * this" flag, so the guide can be reopened any time and still tell the truth.
 * It used to disappear for good the moment one agent existed, unnamed and
 * with no way back, which is why nobody knew it was there.
 */
function setupSteps() {
  const mine = (agents ?? []).filter(a => v2Mine(a) && !a.ops && a.state !== 'ARCHIVED');
  const ops = (agents ?? []).find(a => a.ops && v2Mine(a) && a.state !== 'ARCHIVED');
  const aiDone = profiles.length > 0, botDone = poolAvail > 0 || mine.some(a => a.botUsername);
  const steps = [
    { key: 'ai', done: aiDone, title: aiDone ? `AI connected: ${esc(profiles[0].name)}` : 'Connect the AI', body: !claudePlanOffered() ? `
      <p class="sub" style="margin:4px 0 6px">Claude powers every agent. On a hosted Hatchabot, connect Claude with an API key from
        <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a> (Settings → API keys); it is billed by Anthropic, per use.</p>
      <label>Model</label>
      <select id="setupModel" style="width:auto">
        <option value="claude-opus-4-8">Claude Opus 4.8 (best)</option>
        <option value="claude-sonnet-5">Claude Sonnet 5 (faster)</option>
      </select>
      <label>API key</label>
      <input type="password" id="setupApiKey" placeholder="sk-ant-api…" autocomplete="off">
      <div class="err" id="setupErr"></div>
      <div class="actions" style="justify-content:space-between;align-items:center">
        <span class="sub">Using another AI? <a href="#" ${onAction('click', 'openAiDlg', ["ai"], 'prevent')}>⚙ AI sources</a></span>
        <button class="primary" ${onAction('click', 'createApiKeyProfileFromSetup')}>Connect Claude</button>
      </div>` : `
      <p class="sub" style="margin:4px 0 6px">A Claude subscription (Pro or Max) powers every agent. On the machine running Hatchabot, run
        <code>npm i -g @anthropic-ai/claude-code</code>, then <code>claude</code> once to log in, then <code>claude setup-token</code> and paste the token here.
        Anthropic's terms ask software from other developers to use an API key rather than a plan's sign-in: check
        <a href="https://code.claude.com/docs/en/legal-and-compliance" target="_blank" rel="noopener">them</a> before you rely on this. An API key works the same way (⚙ AI sources).</p>
      <label>Model</label>
      <select id="setupModel" style="width:auto">
        <option value="claude-opus-4-8">Claude Opus 4.8 (best)</option>
        <option value="claude-sonnet-5">Claude Sonnet 5 (faster)</option>
      </select>
      <label>Setup token</label>
      <input type="password" id="setupToken" placeholder="paste the token printed by: claude setup-token" autocomplete="off">
      <div class="err" id="setupErr"></div>
      <div class="actions" style="justify-content:space-between;align-items:center">
        <span class="sub">Using an API key or a local model instead? <a href="#" ${onAction('click', 'openAiDlg', ["ai"], 'prevent')}>⚙ AI sources</a></span>
        <button class="primary" ${onAction('click', 'createSubscriptionProfile')}>Use my Claude subscription</button>
      </div>` },
    { key: 'bot', done: botDone, title: botDone ? (poolAvail ? `Telegram bot ready (${poolAvail} parked)` : 'Telegram bot in use') : 'Make your first Telegram bot', body: `
      <p class="sub" style="margin:4px 0 6px">Each agent is a Telegram bot. In Telegram open <a href="https://t.me/BotFather" target="_blank" rel="noopener"><b>@BotFather</b></a>,
        send <code>/newbot</code>, give it a display name (e.g. <i>Kitchen Helper</i>) and a username ending in <code>bot</code>. BotFather replies with a token like
        <code>123456789:AAH…</code> — paste it here. ${myAccount.hostOwner ? 'It is checked with Telegram and parked, so the next step grabs it instantly.' : 'You will paste it when creating the agent in step 3.'}</p>
      ${myAccount.hostOwner ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><input type="password" id="wizBotToken" placeholder="bot token from @BotFather" autocomplete="off" style="flex:1;min-width:220px"><button class="primary" id="wizBotBtn" ${onAction('click', 'wizardAddBot')}>Check &amp; park it</button></div><div class="err" id="wizBotErr"></div>` : ''}` },
    { key: 'agent', done: mine.length > 0, title: mine.length ? `${mine.length} agent${mine.length === 1 ? '' : 's'}` : 'Create the agent', body: `
      <p class="sub" style="margin:4px 0 6px">A name and one paragraph about its job — that becomes its personality, which you can edit any time.
        Then open the Telegram link on its card and say hi; your first message claims it as yours.</p>
      <div class="actions" style="justify-content:flex-start"><button class="primary" ${aiDone ? '' : 'disabled title="Connect the AI first"'} ${onAction('click', 'clickById', ["fabBtn"])}>➕ Create my first agent</button></div>` },
  ];
  if (!myAccount.hostOwner) return steps;
  const httpsDone = /^https:/i.test(appConfig?.appUrl ?? '');
  const managed = !!appConfig?.managed; // a hosted Hatchabot: HTTPS and backups are the provider's job
  steps.push(
    { key: 'ops', done: !!ops, title: ops ? 'Your Hatchabot agent is set up' : 'Set up your Hatchabot agent', body: `
      <p class="sub" style="margin:4px 0 6px">The manager: the one you ask for changes — "make me an agent that watches the bins",
        "why is the kitchen one quiet?" — and the one that tells you when something needs you. It prepares each change as a card;
        nothing happens until you Confirm.</p>
      <div class="actions" style="justify-content:flex-start"><button class="primary" ${onAction('click', 'v2Close scrollToTop')}>Set it up on the home screen</button></div>` },
    { key: 'opschat', done: !!ops && v2ChannelKinds(ops).length > 0,
      title: ops && v2ChannelKinds(ops).length
        ? `Your manager answers in ${v2ChannelKinds(ops).map(k => V2_CHAN_LABEL[k] ?? k).join(' and ')}`
        : 'Connect your Hatchabot agent to a chat app', body: `
      <p class="sub" style="margin:4px 0 6px">Give it its own bot and you can ask for a change from anywhere; Hatchabot pushes what needs you
        — someone knocking, a card waiting — down the same conversation. Confirming still happens here, in the app.</p>
      ${ops ? `<div class="actions" style="justify-content:flex-start"><button class="primary" ${onAction('click', 'openV2Agent', [`${ops.id ?? ''}`, "messaging"])}>Open its chat apps</button></div>`
            : `<p class="sub" style="margin:0">Set the agent up first — the step above.</p>`}` },
    // Serve still at the app's own port (HB-1239): not done until it is moved, so the step says how.
    ...(managed ? [] : [{ key: 'https', done: (httpsDone || !!tailnet?.reachable) && !tailnet?.oldPort,
      title: tailnet?.oldPort ? 'Point Tailscale serve at its own port'
        : httpsDone || tailnet?.reachable
        ? `Reachable at ${esc(((tailnet?.url || appConfig?.appUrl) ?? '').replace(/^https:\/\//, ''))}`
        : 'Reach it from your phone, over HTTPS',
      body: tailnetStepBody() }]),
    ...(managed ? [] : [{ key: 'backup', done: backupAgeH !== null && backupAgeH < 48 && !backupIncomplete, title: backupAgeH !== null && backupAgeH < 48 && !backupIncomplete ? 'Backups are running' : 'Check a backup has actually run', body: `
      <p class="sub" style="margin:4px 0 6px">Agents keep everything on a volume — memory, files, members. A nightly backup set is what stands between that and a bad day,
        and a backup nobody has looked at is not a backup. ${backupAgeH === null ? 'Nothing has been backed up yet.' : `The newest set is ${Math.round(backupAgeH / 24)} days old${backupIncomplete ? ', and it is incomplete' : ''}.`}</p>
      <div class="actions" style="justify-content:flex-start"><button class="primary" ${onAction('click', 'openAiDlg', ["backups"])}>Open Backups</button></div>` }]),
    { key: 'gemini', optional: true, done: fleetKeys.media === true,
      title: fleetKeys.media === true ? 'Shared Gemini key saved (not tested)' : fleetKeys.media === false ? 'Add a shared key for Telegram voice notes' : 'Shared Gemini key status unavailable',
      body: `<p class="sub" style="margin:4px 0 6px">The shared Gemini key is picked up at an agent's next Rebuild for Telegram voice-note transcription.
        A Gemini AI source can supply its own key. A saved key does not prove transcription works. Browser Talk is configured separately.</p>
      <div class="actions" style="justify-content:flex-start"><button class="primary" ${onAction('click', 'openAiDlg', ["conn"])}>Open Connections</button></div>` },
    { key: 'brave', optional: true, done: fleetKeys.search === true,
      title: fleetKeys.search ? 'Web search uses Brave (key set)' : 'Add a Brave Search key for better web search',
      body: `<p class="sub" style="margin:4px 0 6px">Agents search the web with keyless DuckDuckGo out of the box. One Brave Search API key upgrades every agent's results;
        an agent can also carry its own key.</p>
      <div class="actions" style="justify-content:flex-start"><button class="primary" ${onAction('click', 'openAiDlg', ["conn"])}>Open Connections</button></div>` },
  );
  return steps;
}

/**
 * The HTTPS step, told from what the machine knows rather than from a manual.
 * Most people running this are already on a tailnet: in that case it can name
 * the address, show a QR for the phone, and — when `serve` is not set up yet —
 * give the one command with the right port already in it.
 */
function tailnetStepBody() {
  const port = tailnet?.port ?? 8080;
  // Serve goes to the listener for it, not the app's own port (HB-1239).
  const proxyPort = tailnet?.proxyPort ?? 8094;
  const cmd = tailnet?.serveCommand || `tailscale serve --bg http://127.0.0.1:${proxyPort}`;
  // The listener for it did not open: Hatchabot moves or turns on serve only onto an open one (the owner's call, 2026-11-24).
  if (tailnet?.installed && tailnet.dns && tailnet.proxyListening === false) {
    return `<p class="sub" style="margin:4px 0 6px"><b style="color:var(--warn)">Not yet.</b> Hatchabot's listener for Tailscale serve,
        <code>127.0.0.1:${proxyPort}</code>, is not open${tailnet.proxyError ? ` — <i>${esc(String(tailnet.proxyError).replace(/\.$/, ''))}</i>` : ''}. Until it opens,
        Hatchabot leaves Tailscale serve as it is${tailnet.serving && tailnet.oldPort ? `, still on port ${port}` : ''}.</p>
      <p class="sub" style="margin:0">If another program has port ${proxyPort}, set <code>HATCHABOT_PROXY_PORT</code> to a free port in
        <code>.env</code>, then restart Hatchabot. <code>hatchabot doctor</code> checks it.</p>`;
  }
  // Pointed at the app's own port, as before 2.192.0: there every device on the tailnet shares one sign-in limit.
  // On a Mac at the listener too, for now (docs/tailscale.md): the guide does not promise otherwise there.
  if (tailnet?.serving && tailnet.oldPort) {
    const why = tailnet.mac
      ? `On a Mac every device on your tailnet shares one sign-in limit at either port for now, unless Tailscale runs as your own
        user and your uid is in <code>HATCHABOT_PROXY_TRUST_UIDS</code> (docs/tailscale.md).`
      : `Until it is moved, every device on your tailnet shares one sign-in limit: one person's wrong passwords lock the others out.`;
    return `<p class="sub" style="margin:4px 0 6px"><b style="color:var(--warn)">One step left.</b> Tailscale serves this machine at
        <code>https://${esc(tailnet.dns ?? '')}</code>, but to port ${port}, not to port ${proxyPort}, the one for it. ${why}</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="primary" id="tsServeBtn" ${onAction('click', 'turnOnServe', [{ $: 'el' }, true])}>Move it to port ${proxyPort}</button>
        <span class="sub">The same address, on your tailnet only.</span>
      </div>
      <div class="sub" id="tsServeErr" style="margin-top:6px"></div>
      <p class="sub" style="margin:6px 0 0">Or run it yourself: <code>${esc(cmd)}</code>
        <button ${onAction('click', 'copyAndSay', [`${cmd ?? ''}`, "Command copied", "Copy it by hand"])}>Copy</button></p>`;
  }
  // Configured but not answering: the usual cause is that the tailnet has
  // never issued an HTTPS certificate, which no amount of `serve` will fix.
  if (tailnet?.serving && !tailnet.reachable) {
    return `<p class="sub" style="margin:4px 0 6px"><b style="color:var(--warn)">Almost.</b> Tailscale is serving this machine at
        <code>https://${esc(tailnet.dns ?? '')}</code>, but that address did not answer${tailnet.unreachableWhy ? ` — <i>${esc(tailnet.unreachableWhy)}</i>` : ''}.</p>
      <p class="sub" style="margin:0 0 6px">Almost always one of these:</p>
      <ul class="sub" style="margin:0 0 6px 18px">
        <li><b>HTTPS certificates are off for your tailnet.</b> Turn them on once, in the Tailscale admin console under
          <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noopener">DNS → HTTPS Certificates</a>, then reload this.</li>
        <li><b>The first certificate is still being issued</b> — it can take a half a minute. Try the address again.</li>
        <li>On macOS, the <b>App Store build is sandboxed</b>; if it cannot serve, install Tailscale from tailscale.com instead.</li>
      </ul>
      <p class="sub" style="margin:0">Meanwhile the app still works here on <code>http://localhost:${port}</code>.</p>`;
  }
  if (tailnet?.serving && tailnet.url) {
    return `<p class="sub" style="margin:4px 0 6px">This machine is on your tailnet and already serving over HTTPS. Open this on your phone —
        it works anywhere Tailscale is connected, and nothing is exposed to the internet:</p>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <a class="btn" href="${esc(tailnet.url)}" target="_blank" rel="noopener">${esc(tailnet.url.replace(/^https:\/\//, ''))}</a>
        <button ${onAction('click', 'copyAndSay', [`${tailnet.url ?? ''}`, "Link copied", "Copy it from the button"])}>Copy link</button>
        <img src="/v1/tailscale/qr.svg" alt="QR code for this address" width="104" height="104"
             style="background:#fff;border-radius:8px;padding:4px">
      </div>
      ${/^https:/i.test(appConfig?.appUrl ?? '') ? '' : `<div class="sub" style="margin:8px 0 0">
        Invite links and the install code follow this address while Hatchabot can see it. Write it down and they always will:
        <div style="margin-top:6px"><button id="tsRememberBtn" ${onAction('click', 'rememberPublicUrl', [{ $: 'el' }])}>Use this address for links</button>
          <span class="sub" id="tsRememberMsg"></span></div></div>`}`;
  }
  if (tailnet?.dns) {
    return `<p class="sub" style="margin:4px 0 6px">This machine is on your tailnet as <b>${esc(tailnet.dns)}</b>, but nothing is served over HTTPS yet —
        and the agent consoles need a secure page. Hatchabot can turn it on for you:</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="primary" id="tsServeBtn" ${onAction('click', 'turnOnServe', [{ $: 'el' }])}>Turn on HTTPS</button>
        <span class="sub">Puts it on your tailnet only — every device signed into it, nothing on the internet.</span>
      </div>
      <div class="sub" id="tsServeErr" style="margin-top:6px"></div>
      <p class="sub" style="margin:6px 0 0">Or run it yourself: <code>${esc(cmd)}</code>
        <button ${onAction('click', 'copyAndSay', [`${cmd ?? ''}`, "Command copied", "Copy it by hand"])}>Copy</button></p>`;
  }
  // The macOS App Store build ships no command on PATH — it lives in the app.
  if (tailnet?.appOnly) {
    const bundled = tailnet.cliPath ?? '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    const link = `sudo ln -s "${bundled}" /usr/local/bin/tailscale`;
    return `<p class="sub" style="margin:4px 0 6px">Tailscale is installed here, but its command-line tool is not on the PATH —
        the macOS build keeps it inside the app. Hatchabot found it at <code>${esc(bundled)}</code> and will use it once Tailscale is
        <b>connected</b> (open the app and sign in).</p>
      <p class="sub" style="margin:0">To use it in your own terminal too:
        <code>${esc(link)}</code>
        <button ${onAction('click', 'copyAndSay', [`${link ?? ''}`, "Command copied", "Copy it by hand"])}>Copy</button></p>`;
  }
  const where = tailnet?.installed ? 'Tailscale is installed here but not connected — open it and sign in, or run <code>tailscale up</code>.'
    : 'Install <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a> on this machine and your phone — it is free for personal use, and nothing is exposed to the internet.';
  return `<p class="sub" style="margin:4px 0 6px">On <code>http://localhost:${port}</code> the app only works on this machine, and the agent consoles need a secure page.
      ${where}</p>
    <p class="sub" style="margin:0">Then run <code>${esc(cmd)}</code> and come back — this step will fill itself in. Details in <code>docs/tailscale.md</code>.</p>`;
}

/**
 * Turn on `tailscale serve` from here. It needs rights the control plane may
 * not have — on Linux the CLI wants root unless you are its operator — so a
 * refusal is shown as it came back, with the command to run by hand.
 */
async function turnOnServe(btn, moving = false) {
  // Moving it (HB-1239) puts nothing anywhere new: the same address, the same devices.
  if (!moving && !confirm('Serve Hatchabot over HTTPS on your tailnet?\n\nEvery device signed into your tailnet will be able to reach it. Nothing is exposed to the public internet.')) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = moving ? 'Moving…' : 'Turning on…';
  $('tsServeErr').textContent = '';
  try {
    const r = await api('/v1/tailscale/serve', { method: 'POST', body: {} });
    // "Moved" only when it moved: an answer that still lands on the app's own port is a refusal.
    if (moving && (r.oldPort === true || !r.moved?.length)) throw Object.assign(new Error(`Tailscale still sends your tailnet to port ${tailnet?.port ?? 8080}.`), { data: {} });
    tailnet = { ...(tailnet ?? {}), oldPort: false, ...r };
    toast(moving ? `Moved: your tailnet reaches Hatchabot on port ${tailnet.proxyPort ?? 8094} now.`
      : r.url ? `On — open ${r.url.replace(/^https:\/\//, '')} on your phone.` : 'Turned on.', 9000);
    setupRedraw();
  } catch (e) {
    // The listener not open: no command would help, and the step says so once it is drawn again.
    const closed = e?.data?.noListener === true;
    if (closed) tailnet = { ...(tailnet ?? {}), proxyListening: false };
    // The refusal's own command when it has one (each entry left, its path kept); none, no hint to run one.
    const cmd = typeof e?.data?.command === 'string' ? e.data.command : '';
    $('tsServeErr').innerHTML = `<b style="color:var(--bad)">Hatchabot could not ${moving ? 'move it' : 'turn it on'}:</b> ${esc(e.message)}${cmd && !closed ? `<br>Run this in a terminal instead: <code>${esc(cmd)}</code>` : ''}`;
    btn.disabled = false; btn.textContent = label;
  }
}

/** Write the tailnet address into .env, so links keep working even when the
 *  probe that found it has not run. */
async function rememberPublicUrl(btn) {
  btn.disabled = true;
  const msg = $('tsRememberMsg');
  msg.textContent = '';
  try {
    const r = await api('/v1/tailscale/use-for-links', { method: 'POST', body: {} });
    msg.innerHTML = `✓ written to <code>${esc(r.written)}</code>`;
    appConfig = { ...(appConfig ?? {}), appUrl: r.url };
    toast(`Links now use ${r.url.replace(/^https:\/\//, '')}.`, 8000);
    setupRedraw();
  } catch (e) {
    msg.innerHTML = `<b style="color:var(--bad)">${esc(e.message)}</b>`;
    btn.disabled = false;
  }
}

/** Open the guide deliberately — from the account menu, the header, or the
 *  Setup tile on the dashboard. */
function openSetupGuide() {
  setupOpen = true;
  void loadTailnet().then(() => { if (setupOpen) renderSetup(); });
  renderSetup();
  $('setup').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/**
 * The guide's markup, put in only when it has changed: every poll drew it again, and a token being pasted, the
 * focus and a line saying what went wrong went with it, every few seconds (HB-1140). When it has changed (a step
 * done, the tailnet found), what is typed in a field that is drawn again is kept, and the focus.
 */
let setupDrawn = null;
/** After an action of the guide's own (a bot parked, HTTPS turned on): drawn fresh, its buttons and lines as new. */
function setupRedraw() { setupDrawn = null; renderSetup(); }
function setupPaint(el, html) {
  if (html === setupDrawn && el.isConnected) return;
  setupDrawn = html;
  const typed = new Map();
  for (const f of el.querySelectorAll('input[id], select[id], textarea[id]')) {
    const drawn = f.tagName === 'SELECT' ? ([...f.options].find(o => o.defaultSelected) ?? f.options[0])?.value : f.defaultValue;
    if (f.value !== drawn) typed.set(f.id, f.value);
  }
  const at = el.contains(document.activeElement) ? document.activeElement : null;
  const focus = at?.id || '', sel = at && typeof at.selectionStart === 'number' ? [at.selectionStart, at.selectionEnd] : null;
  el.innerHTML = html;
  for (const [id, v] of typed) { const f = el.querySelector(`[id="${id}"]`); if (f) f.value = v; }
  const f = focus && el.querySelector(`[id="${focus}"]`);
  if (f) { f.focus(); if (sel) try { f.setSelectionRange(sel[0], sel[1]); } catch { /* a field with no selection */ } }
}

function renderSetup() {
  const el = $('setup');
  // An invited member with nothing shared to them used to land on the OWNER's
  // wizard, which tells them to run `claude setup-token` on a machine they
  // have no access to. Say what is actually true for them instead.
  if (!myAccount.hostOwner && profiles.length === 0) {
    setupPaint(el, `<div class="card">
      <div class="name">Welcome 👋</div>
      <p class="sub" style="margin:6px 0">Your account is ready, but no AI source has been shared with it yet — agents need one to think with.</p>
      <p class="sub" style="margin:0 0 10px"><b>Ask whoever runs this server</b> to open ⚙ Settings → AI sources and tick <b>Shared</b> on theirs. It takes them one click, and their plan covers your agents.</p>
      <p class="sub" style="margin:0">Or bring your own: <a href="#" ${onAction('click', 'openAiDlg', ["ai"], 'prevent')}>add an API key</a> — billed to you, per token.</p>
    </div>`);
    return;
  }
  const steps = setupSteps();
  const aiDone = steps[0].done, firstAgent = steps[2].done;
  // Until the first agent exists the guide shows itself; after that it is
  // opened on purpose, and says so in its heading.
  const left = steps.filter(s => !s.done && !s.optional).length; // optional steps never nag
  const done = steps.length - left;
  // After the first agent the guide is a collapsible strip above the panel:
  // one line while anything is left, opened on purpose; gone when all done
  // (still reachable from the account menu, which opens it).
  if (firstAgent && !left && !setupOpen) { setupPaint(el, ''); return; }
  const step = (n, s) => `
    <div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)${s.done ? ';opacity:.6' : ''}">
      <span style="flex:none;width:26px;height:26px;border-radius:50%;background:${s.done ? 'var(--ok)' : s.optional ? 'transparent' : 'var(--accent)'};${s.optional && !s.done ? 'border:2px solid var(--line);color:var(--dim);' : 'color:var(--accent-ink);'}font-weight:800;display:flex;align-items:center;justify-content:center">${s.done ? '✓' : n}</span>
      <div class="grow"><div class="name" style="font-size:15px">${s.title}${s.optional ? ' <span class="sub" style="font-weight:400">(optional)</span>' : ''}</div>${s.done ? '' : s.body}</div>
    </div>`;
  const body = `${firstAgent && done === steps.length ? '<p class="sub" style="margin:6px 0 0">Everything on the list is done. It stays here so you can check again after a change.</p>' : ''}
      ${steps.map((s, i) => step(i + 1, s)).join('')}`;
  setupPaint(el, firstAgent
    ? `<details class="card setup-strip" id="setupCard"${setupOpen ? ' open' : ''} ${onAction('toggle', 'noteSetupOpen', [{ $: 'open' }])}>
        <summary style="cursor:pointer;list-style:none;display:flex;gap:10px;align-items:center">
          <span class="name grow">⚑ Setup — ${done} of ${steps.length} done${left ? ` · <span style="color:var(--accent)">${left} left</span>` : ''}</span>
          <span class="sub">${setupOpen ? 'Hide' : 'Show'}</span></summary>
        ${body}
      </details>`
    : `<div class="card" id="setupCard">
      <div class="row"><div class="name grow">Welcome 👋 — three steps to your first agent</div></div>
      ${body}
    </div>`);
}

async function wizardAddBot() {
  const token = $('wizBotToken').value.trim();
  if (!token) { $('wizBotErr').textContent = 'Paste the token BotFather sent you.'; return; }
  $('wizBotBtn').disabled = true; $('wizBotErr').textContent = '';
  try {
    const r = await api('/v1/pool', { method: 'POST', body: { token, shared: false } });
    poolAvail = r.availableBots;
    toast(`@${r.username} is ready — it will be used by your first agent.`, 6000);
    $('wizBotToken').value = ''; // parked: not a draft to carry
    setupRedraw();
  } catch (e) { $('wizBotErr').textContent = e.message; $('wizBotBtn').disabled = false; }
}

async function createSubscriptionProfile() {
  // A token is required. A blank one used to mean "use this machine's own
  // Claude login", but the server refuses new sources of that kind (v2.39.0,
  // unless HATCHABOT_ALLOW_MACHINE_LOGIN is set), so the first-run card
  // offered a path that always failed.
  if (!$('setupToken').value.trim()) {
    $('setupErr').textContent = 'Paste a token: run `claude setup-token` in a terminal and paste what it prints.';
    return;
  }
  try {
    await api('/v1/ai-profiles', { method: 'POST', body: {
      kind: 'subscription', vendor: 'anthropic',
      name: 'My Claude', model: $('setupModel').value,
      oauthToken: $('setupToken').value.trim(),
    }});
    await refresh(true);
    toast('Claude connected');
  } catch (e) { $('setupErr').textContent = e.message; }
}

/** The setup guide's first step on a hosted Hatchabot: Claude by API key. */
async function createApiKeyProfileFromSetup() {
  const key = $('setupApiKey').value.trim();
  if (!key) { $('setupErr').textContent = 'Paste an API key from console.anthropic.com.'; return; }
  try {
    await api('/v1/ai-profiles', { method: 'POST', body: {
      kind: 'api_key', vendor: 'anthropic', name: 'My Claude', model: $('setupModel').value, apiKey: key,
    }});
    await refresh(true);
    toast('Claude connected');
  } catch (e) { $('setupErr').textContent = e.message; }
}
