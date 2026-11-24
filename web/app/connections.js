// web/app/connections.js: an agent's notices and peers, its workspace files and logs, platform connections (Google, git sources, environment values).
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- an agent's notices -----------------------------------------------------

/**
 * The Telegram bot's display name, when it isn't simply correct.
 *
 * Two states worth showing. PENDING: Telegram is refusing the rename — its
 * quota runs to hours — so say what the bot will be called and how long the
 * wait is, since "wrong name, no explanation" is what sent someone looking for
 * a bug. LANDED: a wait that lasted hours deserves a confirmation; a warning
 * that merely disappears reads like it was never real. The confirmation ages
 * out on its own.
 */
function botNameNote(a) {
  if (a.botNamePending) {
    const at = a.botNamePending.retryAt ? Date.parse(a.botNamePending.retryAt) : 0;
    const mins = at ? Math.round((at - Date.now()) / 60000) : 0;
    const when = mins > 90 ? `in about ${Math.round(mins / 60)} hours`
      : mins > 1 ? `in about ${mins} minutes`
      : 'shortly';
    const clock = at > Date.now()
      ? ` (around ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`
      : '';
    return `<div class="pair">🏷 <span class="grow">Telegram still shows this bot under its old name.
      It becomes <b>${esc(a.botNamePending.name)}</b> ${when}${clock} — Telegram limits how often a bot
      may be renamed. Nothing else about the agent is affected.</span></div>`;
  }
  // Recent success only: after this it's just the bot's name, not news.
  if (a.botNamedAt && Date.now() - Date.parse(a.botNamedAt) < 30 * 60000) {
    return `<div class="pair">✅ <span class="grow">Telegram bot renamed to <b>${esc(a.name)}</b> ${ago(a.botNamedAt)}.</span></div>`;
  }
  return '';
}

/** A template agent whose description still has {{placeholders}}: its Setup values were never filled in. */
const templateUnfilled = (a) => !!a.persona && /\{\{\s*[a-z][a-z0-9_]*\s*\}\}/.test(a.persona);
const TEMPLATE_WHY = 'template setup values not filled in';
/** The notice's button: its Personality tab, scrolled to the Setup values once they have loaded. */
function goSetupValues(id, name) {
  void openEdit(id, name, 'def');
  let n = 0;
  const t = setInterval(() => {
    const row = $('setupValuesRow');
    const shown = row && !row.hidden && row.offsetParent !== null;
    if (!shown && ++n < 20) return;
    clearInterval(t);
    if (shown) { row.scrollIntoView({ block: 'center' }); row.querySelector('input, select, textarea')?.focus(); }
  }, 150);
}
/**
 * Everything on an agent that tells you something or waits on you — rebuild
 * prompts, sync errors, a bot token to paste, people asking to be let in, the
 * members list — shown above its settings in the agent's sheet. opts:
 * skipFailure / skipTokenForm (the sheet shows those itself), setupValues (the
 * "fill its Setup values" notice).
 */
function agentNotices(a, opts = {}) {
  const pending = a.pendingAction?.type === 'bot_token';
  const pairs = pairings[a.id] ?? [];
  return `
      ${opNotice(a)}
      ${recheckNote(a)}
      ${opts.setupValues && templateUnfilled(a) ? `<div class="pair">⚙ <span class="grow">Template not configured — fill its Setup values to complete the description.</span>
        <button type="button" ${onAction('click', 'goSetupValues', [`${a.id ?? ''}`, `${a.name ?? ''}`])}>Fill its Setup values</button></div>` : ''}
      ${a.contextReset ? `<div class="pair" style="align-items:flex-start">🧠 <span class="grow"><b>Its chat started fresh ${esc(ago(a.contextReset.resetAt))}</b> — ${a.contextReset.lostMessages} earlier message${a.contextReset.lostMessages === 1 ? '' : 's'} are no longer in its context. Its saved memory is untouched; <b>Recover context</b> has it read the old conversation and keep what matters.</span>
        <button class="primary" ${onAction('click', 'recoverContext', [`${a.id}`, `${a.name ?? ''}`])}>📥 Recover context</button>
        <button ${onAction('click', 'dismissContextReset', [`${a.id}`])} title="Stop offering this">Dismiss</button></div>` : ''}
      ${a.updateAvailable && !isRechecking(a) ? `<div class="pair">⬆ <span class="grow">${updateBlurb(a)}</span>
        <button class="primary" ${onAction('click', 'rebuild', [`${a.id}`])}>Update</button></div>` : ''}
      ${rebuildOtherReasons(a).length && !isRechecking(a) ? `<div class="pair">${a.rebuild.level === 'required' ? '⚠' : '🛠'} <span class="grow">Needs a rebuild: ${esc(rebuildOtherReasons(a).join('; '))}. ${a.rebuild.level === 'required' && rebuildPolicyNow !== 'manual' ? 'This machine does it on its own once the agent is idle — or now:' : 'Memory is kept.'}</span>
        <button class="primary" ${onAction('click', 'rebuild', [`${a.id}`])}>Rebuild</button></div>` : ''}
      ${a.migratedTo ? `<div class="pair">📦 <span class="grow">Moved to <b>${esc(a.migratedTo)}</b>. This copy is a leftover — starting it would make two agents fight over the same Telegram bot.</span>
        <button ${onAction('click', 'runsHere', [`${a.id}`, `${a.name ?? ''}`])}>Runs here again</button></div>` : ''}
      ${a.peersPending && !isRechecking(a) ? `<div class="pair">🔗 <span class="grow">Peer changes apply on the next rebuild — that's what installs its consult tool.</span>
        <button class="primary" ${onAction('click', 'rebuild', [`${a.id}`])}>Rebuild</button></div>` : ''}
      ${a.pendingModel && a.pendingModel !== a.model && !isRechecking(a) ? `<div class="pair">🔄 <span class="grow">Will switch to <b>${esc(a.pendingModel)}</b> on the next rebuild — still running ${esc(a.model ?? '')}.</span>
        <button class="primary" ${onAction('click', 'rebuild', [`${a.id}`])}>Rebuild</button></div>` : ''}
      ${a.rebuildOnStart && a.state === 'STOPPED' ? `<div class="pair" id="rebuildOnStartNote-${esc(a.id)}">🕓 <span class="grow">A change is waiting: it comes up with it the next time it ${a.hibernatedAt ? 'wakes' : 'is started'} (a rebuild, memory kept).</span></div>` : ''}
      ${(a.state === 'FAILED' || a.state === 'STOPPED') && a.stateReason && !opts.skipFailure ? `<div class="reason">${esc(a.stateReason)}</div>` : ''}
      ${botNameNote(a)}
      ${attentionFingerprint(a) && v2Mine(a) ? (attentionCleared(a)
        ? `<div class="pair sub">🔕 <span class="grow">Cleared from Alerts — it comes back if something new happens.</span><button ${onAction('click', 'clearAttention', [`${a.id}`, false])}>Show again</button></div>`
        : `<div class="pair sub"><span class="grow"></span><button ${onAction('click', 'clearAttention', [`${a.id}`])} title="Take it out of Alerts until something new happens">🔕 Clear from Alerts</button></div>`) : ''}
      ${a.state === 'ARCHIVED' ? `<div class="pair">📥 <span class="grow">Archived — everything is kept.${a.webOnly ? '' : ` ${a.exportedAt ? '' : 'Its Telegram bot went back in the pool for another agent. '}Restore gives it a <b>new</b> bot; members will need the new link.`}</span></div>` : ''}
      ${(isRechecking(a) ? [] : (a.dataSources ?? []).filter(d => d.syncError)).map(d => `
        <div class="pair">
          <span class="grow">⚠ <b>${esc(d.mountName)}</b> didn't sync — <span class="sub">${esc(d.syncError)}</span></span>
          ${d.pubKey ? `<button ${onAction('click', 'openEdit showDeployKey', [[`${a.id}`, `${a.name ?? ''}`, "data"], [`${d.id ?? ''}`]])} title="Show the deploy key to add to this repo">🔑 Deploy key</button>` : ''}
        </div>`).join('')}
      ${pending && !opts.skipTokenForm ? tokenForm(a) : ''}
      ${pairs.map(p => {
        const kind = p.kind || 'telegram', tg = kind === 'telegram';
        // Slack and Discord have no account-level link, so "That's me" is always offered there.
        const selfBtn = !tg || !myAccount.telegramUserId;
        return `
        <div class="pair">
          <span class="grow">🔑 <b class="pii">${esc(p.meta?.firstName || p.meta?.username || p.id)}</b> wants to talk to this agent${tg ? '' : ` on ${V2_CHAN_LABEL[kind] || kind}`}</span>
          <button ${onAction('click', 'denyPair', [`${a.id}`, `${p.code ?? ''}`, `${(p.meta?.firstName || p.meta?.username || p.id) ?? ''}`, `${kind}`])}
                  title="Turn this request away. They can ask again by messaging the bot.">Not now</button>
          ${selfBtn ? `<button class="primary" ${onAction('click', 'approve', [`${a.id}`, `${p.code ?? ''}`, true, `${kind}`, `${(p.meta?.firstName || p.meta?.username || p.id) ?? ''}`])}
                  title="${tg ? 'This is your own Telegram: bind it to your login so every agent you make admits you automatically — no more pairing with yourself.' : `This is you on ${V2_CHAN_LABEL[kind] || kind}: link it to you on this agent.`}">That's me — link</button>` : ''}
          ${a.ops ? '' /* the manager is its owner's alone: the server answers 400 (review, 2026-10-09) */ : `<button class="${selfBtn ? '' : 'primary'}" ${onAction('click', 'approve', [`${a.id}`, `${p.code ?? ''}`, false, `${kind}`])}>Let them in</button>`}
        </div>`;
      }).join('')}
      ${(members[a.id] ?? []).length > 1 ? `
        <div class="members">👥 ${(members[a.id] ?? []).map(m => {
          const label = m.role === 'owner' && (DEMO || !m.displayName) ? 'You' : `<span class="pii">${esc(m.displayName || m.userId.slice(0, 8))}</span>`;
          const x = m.role === 'owner' ? '' :
            `<button type="button" class="kick" title="Remove this member" aria-label="Remove this member" ${onAction('click', 'kick', [`${a.id}`, `${m.userId ?? ''}`, `${(m.displayName || (m.role === 'owner' ? 'You' : m.userId.slice(0, 8))) ?? ''}`])}>×</button>`;
          return `<span class="member ${m.channelUserId ? 'linked' : ''}" title="${m.channelUserId ? 'Linked to Telegram' : 'Not linked to Telegram yet'}">${label}${m.role === 'owner' ? ' ★' : ''}${x}</span>`;
        }).join('')}
        </div>` : ''}`;
}

/** The pool is empty and there is no spare token: finish the agent without a bot. */
async function skipTelegram(id, name) {
  if (!confirm(`Finish "${name}" without Telegram?\n\nYou talk to it here in Hatchabot; a bot can be attached later from its Telegram tab.`)) return;
  try { await api(`/v1/agents/${id}/channel-token`, { method: 'POST', body: { webOnly: true } }); toast(`${name} is finishing without Telegram`); await refresh(false); }
  catch (e) { toast(e.message, 12000); }
}
function tokenForm(a) {
  return `
  <div class="token-form">
    <pre>${esc(a.pendingAction.instructions)}</pre>
    <div class="row">
      <input type="text" class="grow" id="tok-${a.id}" placeholder="123456789:AA...">
      <button class="primary" ${onAction('click', 'submitToken', [`${a.id}`])}>Connect</button>
    </div>
    <div class="err" id="tokerr-${a.id}"></div>
    <div class="sub" style="margin-top:6px">No bot to give it? <button ${onAction('click', 'skipTelegram', [`${a.id}`, `${a.name ?? ''}`])}>Continue without Telegram</button> — it becomes a web-only agent you talk to here (a bot can be attached later).</div>
  </div>`;
}

async function submitToken(id) {
  const err = $(`tokerr-${id}`);
  try {
    const token = $(`tok-${id}`).value.trim();
    // No answer from Telegram, or none at all, is sent again as adopt sends it.
    const { username } = await handOverBot(id, { token }, (m) => { if (err) err.textContent = m; });
    if (err) err.textContent = '';
    toast(`${username ? `@${username}` : 'The bot'} connected — booting…`);
    await refresh(false);
  } catch (e) { if (err) err.textContent = e.message; }
}

async function act(id, action) {
  try { await api(`/v1/agents/${id}/${action}`, { method: 'POST', body: {} }); await refresh(false); }
  catch (e) { toast(e.message); }
}

const botOf = (a) => (a.deepLink ?? '').replace('https://t.me/', '');

// "5m ago" / "3h ago" / "2d ago" — coarse on purpose; it's a health signal,
// not a log.
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---- workspace file editing + logs ----------------------------------------

let editAgentId = null, logsAgentId = null;

// The sections of editDlg, which the agent sheet borrows.
const EDIT_TABS = {
  def: 'paneDef', snap: 'paneEditSnap', ai: 'paneEditAi', data: 'paneEditData',
  conn: 'paneEditConn', peers: 'paneEditPeers', tg: 'paneEditTg', env: 'paneEditEnv',
};
function showEditTab(name) {
  for (const [key, pane] of Object.entries(EDIT_TABS)) $(pane).hidden = key !== name;
  // Lazy: listing connections is a container exec — only pay for it when the
  // tab is actually opened, not on every Settings open.
  if (name === 'conn' && editAgentId) void renderConnections();
  if (name === 'peers' && editAgentId) void loadPeers();
}

let peersLoadedFor = null, peersCurrent = null; // Save is armed only after the current list loaded
async function loadPeers() {
  const el = $('agentPeerList'), forId = editAgentId;
  const current = sharingRead(el, forId);
  el.innerHTML = 'Loading…'; peersLoadedFor = null; peersCurrent = null; $('peerSaveBtn').disabled = true;
  try {
    const { candidates } = await api(`/v1/agents/${forId}/peers`);
    if (!current()) return;
    peersLoadedFor = forId; peersCurrent = current; $('peerSaveBtn').disabled = false;
    el.innerHTML = candidates.length
      ? candidates.map(c => `<label class="pair" style="padding:3px 0;cursor:pointer;align-items:center;gap:8px;margin:0">
          <input type="checkbox" class="peerCb" data-id="${esc(c.id)}"${c.granted ? ' checked' : ''} style="width:auto;flex:none">
          <span class="grow">${esc(c.name)}</span>
          <label class="sub" style="display:flex;align-items:center;gap:4px;font-weight:400"
                 title="By default a consult is relayed as untrusted input the peer answers but never acts on. Tick this and it may carry out what this agent asks — for a pair you drive on purpose, like a QA agent resetting the system it tests. It can never hand over credentials either way.">
            <input type="checkbox" class="peerAct" data-id="${esc(c.id)}"${c.allowActions ? ' checked' : ''} style="width:auto;flex:none"> may act on its requests
          </label></label>`).join('')
      : '<span>No other agents to consult yet.</span>';
    v2SheetBaseline(el);
  } catch (e) { if (current()) el.innerHTML = esc(e.message); }
}
async function savePeers() {
  // Never PUT from an unloaded/failed list: that would silently revoke every grant.
  if (peersLoadedFor !== editAgentId || !peersCurrent?.()) { toast('Peer list not loaded yet — reopen the tab.'); return; }
  if ($('peerSaveBtn').disabled) return;
  const current = peersCurrent;
  const ids = [...document.querySelectorAll('.peerCb:checked')].map(cb => cb.dataset.id);
  const acts = [...document.querySelectorAll('.peerAct:checked')].map(cb => cb.dataset.id).filter(id => ids.includes(id));
  if (acts.length && !confirm(
    `This agent will be allowed to ask ${acts.length} peer${acts.length > 1 ? 's' : ''} to ACT — send mail, change files, ` +
    `run their tools — not just answer questions.\n\nOnly do this for agents you drive on purpose. Anything that can steer ` +
    `THIS agent (an injected email, a message from someone in its chat) can then reach into ${acts.length > 1 ? 'them' : 'it'}.\n\nContinue?`)) return;
  $('peerSaveBtn').disabled = true;
  const forId = editAgentId, f = forAgent(forId); // the agent saved is the one rebuilt (audit #047)
  const saved = v2SheetSaving('agentPeerList');
  try {
    await api(`/v1/agents/${forId}/peers`, { method: 'PUT', body: { peerIds: ids, allowActions: acts } });
    if (!current()) return;
    saved(forId);
    // The call-agent tool + peer manifest are installed on rebuild, so offer it.
    if (ids.length) {
      const name = agents.find(x => x.id === forId)?.name || 'this agent';
      if (confirm(`Saved. Rebuild "${name}" now so it can consult ${ids.length} peer${ids.length > 1 ? 's' : ''}?\n\nThe call-agent tool is installed on rebuild (memory kept, briefly offline). Without a rebuild the grant is saved but the agent can't call them yet.`)) {
        const r = await api(`/v1/agents/${forId}/rebuild`, { method: 'POST', body: { stoppedWaits: true } });
        f.say(r?.atNextStart ? 'Saved. It is not running, so it stays that way: it can consult them from its next start.' : 'Rebuilding so it can consult its peers…');
        f.draw(() => editDlg.close());
      } else {
        f.say('Saved — Rebuild this agent before it can consult them.', 8000);
      }
    } else {
      f.say('Saved — no peers.');
    }
    await refresh(false);
  } catch (e) { if (current()) f.fail(e); }
  finally { if (current()) $('peerSaveBtn').disabled = false; }
}

async function renderConnections() {
  const el = $('connList'), forId = editAgentId;
  el.innerHTML = 'Checking the agent…';
  // Reset the attach-time "no send" toggle to its safe default every time the
  // dialog opens — it's one shared control, not per-agent state, so without
  // this it carries over whatever the previous agent card left it on.
  $('connNoSend').checked = true;
  // The attach picker: the caller's vault, minus accounts already on this agent.
  // Emptied first: a failed read left the previous agent's list selectable
  // (audit 2026-10-23, B20).
  $('connAttachPick').innerHTML = '<option value="">Loading your accounts…</option>';
  $('connAttachBtn').disabled = true;
  v2SheetBaseline('connNoSend', 'connAttachPick');
  api('/v1/connections').then(({ connections }) => {
    if (editAgentId !== forId) return;
    const open = connections.filter(c => !c.attachedTo.some(a => a.id === forId));
    $('connAttachPick').innerHTML = open.length
      ? open.map(c => `<option value="${c.id}">${DEMO ? 'account' : esc(c.email)}</option>`).join('')
      : '<option value="">— no account left to attach —</option>';
    $('connAttachBtn').disabled = !open.length;
    v2SheetBaseline('connAttachPick');
  }).catch(() => {
    if (editAgentId === forId) { $('connAttachPick').innerHTML = '<option value="">— could not read your accounts; reopen to try again —</option>'; v2SheetBaseline('connAttachPick'); }
  });
  try {
    const { accounts } = await api(`/v1/agents/${forId}/connections`);
    if (editAgentId !== forId) return; // dialog moved on while we fetched
    el.innerHTML = accounts.length
      ? accounts.map((a, i) => `<div class="pair"><span class="grow"><b class="pii">${esc(a.email)}</b>
          <span class="sub">${esc(a.auth)}${a.client && a.client !== 'default' ? ` · client: ${esc(a.client)}` : ''}</span>
          <span id="connGmailOut${i}" class="sub" role="status" style="display:block"></span></span>
          ${!a.services || a.services.includes('gmail') ? `<button title="Checks the sign-in and asks Gmail for the inbox's counts, from inside the agent. Reads no mail and sends nothing." ${onAction('click', 'testAgentGmail', [{ $: 'el' }, `${a.email ?? ''}`, (i)])}>Test Gmail</button>` : ''}
          <button class="danger" title="Takes this agent's access away at once; the Google account itself is untouched" ${onAction('click', 'disconnectAccount', [`${a.email ?? ''}`])}>Disconnect</button></div>`).join('')
      : 'None yet — attach one above, or ask the agent to connect its own.';
  } catch (e) {
    if (editAgentId === forId) el.innerHTML = esc(e.message);
  }
}

/** Real calls at Google from inside this agent, for one account. */
async function testAgentGmail(btn, email, i) {
  const forId = editAgentId, out = $(`connGmailOut${i}`);
  btn.disabled = true;
  out.textContent = 'Testing…';
  try {
    const r = await api(`/v1/agents/${forId}/connections/${encodeURIComponent(email)}/test`, { method: 'POST' });
    out.textContent = `${r.ok ? '✓' : '⚠'} ${r.detail}`;
  } catch (e) { out.textContent = `⚠ ${e.message}`; }
  finally { btn.disabled = false; }
}

async function attachConnection() {
  const id = $('connAttachPick').value;
  if (!id) { toast('Pick a connection to attach.'); return; }
  $('connAttachBtn').disabled = true;
  const forId = editAgentId, f = forAgent(forId); // its success draws the picker and the box again: renderConnections notes them
  try {
    const r = await api(`/v1/agents/${forId}/connections/attach`, {
      method: 'POST', body: { connectionId: id, gmailNoSend: $('connNoSend').checked },
    });
    f.say((r.live ? 'Attached — the agent can use it now.'
      : r.error ? `Attached, but not live yet: ${r.error}` : 'Attached — lands on the next rebuild/start.'), 8000);
    await f.draw(renderConnections);
  } catch (e) { f.fail(e, 10000); }
  finally { $('connAttachBtn').disabled = !$('connAttachPick').value; }
}

// ---- platform connections (main Settings → Connections) --------------------

const CONN_SERVICES = [
  ['gmail', 'Gmail', true], ['calendar', 'Calendar', true], ['drive', 'Drive', true],
  ['sheets', 'Sheets', false], ['docs', 'Docs', false], ['contacts', 'Contacts', false],
];
let platformConnections = [];

function renderConnServices() {
  const box = $('connServices');
  if (box.childElementCount) return; // static — render once
  box.innerHTML = CONN_SERVICES.map(([key, label, on]) => `
    <label style="display:flex;gap:5px;align-items:center;font-weight:400;margin:0;width:auto;cursor:pointer">
      <input type="checkbox" data-svc="${key}"${on ? ' checked' : ''} style="width:auto;flex:none"> ${label}</label>`).join('');
}

async function loadConnections() {
  renderConnServices();
  try {
    const cs = await api('/v1/google-oauth/client');
    $('connClientBox').innerHTML = cs.configured ? `
      <div class="pair" style="flex-wrap:wrap;gap:6px">
        <span class="grow">🔑 OAuth client <code style="font-size:12px">${esc(cs.clientId.slice(0, 24))}…</code>
          <span class="sub">the one-time Google Cloud setup is done for this server</span></span>
        <button ${onAction('click', 'removeOAuthClient')} class="danger">Remove</button>
      </div>` : `
      <details style="border:1px solid var(--warn);border-radius:10px;padding:10px 12px" open>
        <summary style="cursor:pointer"><b>One-time setup (server owner):</b> create this server's Google OAuth client</summary>
        <div class="sub" style="margin-top:8px">
          Done once per installation — after this, everyone just clicks Connect.
          Use a personal account you'll keep (not a Workspace account — its
          domain rules would lock family gmail.com accounts out).
          <ol style="margin:6px 0 6px 18px;padding:0">
            <li><b>Create a project.</b> Open <b>console.cloud.google.com</b> (agree to
              the terms if it's your first visit) → click the <b>project picker</b> at
              the very top of the page (next to the "Google Cloud" logo — it shows a
              project name or "Select a project") → <b>NEW PROJECT</b> → name it e.g.
              <i>Hatchabot</i> → Create, then make sure the picker now shows it.</li>
            <li><b>Enable the APIs.</b> Left menu → <b>APIs &amp; Services → Library</b>:
              search and <b>Enable</b> <i>Gmail API</i>, <i>Google Calendar API</i>,
              <i>Google Drive API</i> (+ Sheets/Docs/People if you'll use them).</li>
            <li><b>Consent screen.</b> APIs &amp; Services → <b>OAuth consent screen</b> →
              user type <b>External</b> → fill the app name + your email (the two
              required fields) → under <b>Test users</b>, add every household email
              that will connect (including any Workspace addresses like a condo
              account). Later, press <b>Publish app</b> here — Testing mode expires
              everyone's tokens after 7 days.</li>
            <li><b>Create the client.</b> APIs &amp; Services → <b>Credentials → Create
              credentials → OAuth client ID</b> → application type <b>Web
              application</b> → under <b>Authorized redirect URIs</b>, add exactly:</li>
          </ol>
          <div style="display:flex;gap:8px;align-items:center;margin:4px 0">
            <code id="connRedirectUri" style="flex:1;padding:6px 8px;background:var(--panel-2);border-radius:6px;font-size:12px;word-break:break-all">${esc(cs.redirectUri)}</code>
            <button ${onAction('click', 'copyFromEl', ["connRedirectUri", "Copied", "Could not copy — select the address and copy it by hand", 3000, 8000])}>Copy</button>
          </div>
          <div class="sub" style="margin:2px 0 8px">5. Paste the client ID and secret it gives you:</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input type="text" id="connClientId" placeholder="…apps.googleusercontent.com" style="flex:2;min-width:220px">
            <input type="password" id="connClientSecret" placeholder="Client secret" autocomplete="off" style="flex:1;min-width:160px">
            <button class="primary" ${onAction('click', 'saveOAuthClient')}>Save</button>
          </div>
          <div class="sub" style="margin-top:6px">⚠ While the consent screen is in <b>Testing</b> mode, Google expires tokens
            after 7 days unless you publish the app (unverified-publish works for a household — users click through one
            "unverified" warning at connect time, once).</div>
        </div>
      </details>`;
  } catch (e) { $('connClientBox').innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
  try {
    const { connections } = await api('/v1/connections');
    platformConnections = connections;
    $('connVault').innerHTML = connections.length ? connections.map(c => {
      const agents = c.attachedTo ?? [];
      const rows = agents.length ? agents.map(a => {
        const old = !c.needsReconnect && a.secretPending;
        const badge = a.stale || old ? '⚠' : (a.materializedAt ? '✓' : '·');
        const when = a.attachedAt ? `attached ${esc(a.attachedAt.slice(0, 10))}` : 'attached before this was tracked';
        const pull = a.materializedAt ? `, token pulled ${ago(a.materializedAt)}` : ', token pull not tracked yet';
        const warn = a.stale ? ' · <b>stale — reconnect this account, then re-attach this agent to pull the new token</b>'
          : old ? ' · <b>still has the old client secret — it gets the new one at its next start or rebuild; keep the old secret at Google until then</b>' : '';
        return `
        <div class="sub" style="display:flex;gap:6px;align-items:baseline${a.stale || old ? ';color:var(--warn)' : ''}">
          <span>${badge}</span>
          <span class="grow"><b style="font-weight:600">${esc(a.name)}</b> — ${when}${pull}${warn}</span>
        </div>`;
      }).join('')
        : '<div class="sub">not attached to any agent yet</div>';
      return `
      <div class="pair" style="flex-wrap:wrap;gap:6px;align-items:flex-start">
        <span class="grow"><b class="pii">${esc(c.email)}</b>${c.staleCount ? ` <span style="color:var(--warn);font-size:12px">· ${c.staleCount} stale</span>` : ''}${c.secretPendingCount ? ` <span style="color:var(--warn);font-size:12px">· ${c.secretPendingCount} waiting for the new secret</span>` : ''}${c.needsReconnect ? ` <span class="conn-reconnect" style="color:var(--warn);font-size:12px">· ⚠ made with an earlier OAuth client — press Connect and pick this account again</span>` : ''}
          <span class="sub">${esc((c.services ?? []).join(', ') || 'default services')} · last consent ${esc((c.createdAt || '').slice(0, 10))}${c.createdAt ? ` (${ago(c.createdAt)})` : ''}</span>
          <div style="margin-top:4px;display:flex;flex-direction:column;gap:2px">${rows}</div></span>
        <button class="danger" ${onAction('click', 'removeConnection', [`${c.id ?? ''}`, `${c.email ?? ''}`])}>Remove</button>
      </div>`;
    }).join('')
      : 'None yet — press Connect above. Each person connects their own accounts from their own login.';
  } catch (e) { $('connVault').innerHTML = esc(e.message); }
}

async function saveOAuthClient() {
  const body = { clientId: $('connClientId').value.trim(), clientSecret: $('connClientSecret').value.trim() };
  try {
    let r;
    try {
      r = await api('/v1/google-oauth/client', { method: 'PUT', body });
    } catch (e) {
      // A different client breaks the connections the old one made: the
      // server names how many, and saves only when that is what's wanted.
      if (e.code !== 'google_client_change') throw e;
      if (!confirm(`${e.message}\n\nSave this client anyway?`)) return;
      r = await api('/v1/google-oauth/client', { method: 'PUT', body: { ...body, confirm: true } });
    }
    toast(r?.reconnect
      ? `OAuth client saved. ${r.reconnect} connection${r.reconnect === 1 ? '' : 's'} must be connected again (marked below).`
      : r?.pushing || r?.waiting
        ? `OAuth client saved. ${r.pushing ? `The new secret is going to ${r.pushing} running agent${r.pushing === 1 ? '' : 's'}. ` : ''}${r.waiting ? `${r.waiting} other${r.waiting === 1 ? '' : 's'} get${r.waiting === 1 ? 's' : ''} it at the next start: keep the old secret at Google until then.` : ''}`
        : 'OAuth client saved — Connect now works for everyone on this server.', r?.reconnect || r?.waiting ? 10000 : undefined);
    await loadConnections();
  } catch (e) { toast(e.message, 10000); }
}

async function removeOAuthClient() {
  if (!confirm('Remove the Google OAuth client?\n\nNew connects stop working until one is configured again. Put the same client back to keep the accounts already connected: a different one means each must be connected again.')) return;
  try { await api('/v1/google-oauth/client', { method: 'DELETE' }); await loadConnections(); } catch (e) { toast(e.message, 10000); }
}

async function startGoogleConnect() {
  const services = [...$('connServices').querySelectorAll('input:checked')].map(i => i.dataset.svc);
  try {
    const { url } = await api('/v1/connections/google/start', { method: 'POST', body: { services } });
    window.open(url, '_blank', 'noopener');
    toast('Finish the consent in the new tab, then press ⟳ here.', 10000);
  } catch (e) { toast(e.message, 10000); }
}

async function removeConnection(id, email) {
  if (!confirm(`Remove ${email} from this server?\n\nEvery agent it's attached to loses access, and the token is revoked at Google.`)) return;
  try {
    await api(`/v1/connections/${id}`, { method: 'DELETE' });
    toast(`${email} removed and revoked.`);
    await loadConnections();
  } catch (e) { toast(e.message, 10000); }
}

async function disconnectAccount(email) {
  if (!confirm(`Disconnect ${email} from this agent?\n\nThe agent loses access immediately. The account itself stays connected to the server (⚙ Settings → Connections) for other agents.`)) return;
  const forId = editAgentId, f = forAgent(forId);
  try {
    // The server tells the two apart: a platform-attached account is DETACHED
    // (removing only the container copy re-imported it on the next rebuild),
    // anything else is an agent-made connection and is removed from gog. The
    // page used to decide from /v1/connections, and when that read failed it
    // sent a platform account down the raw remove.
    const r = await api(`/v1/agents/${forId}/connections/${encodeURIComponent(email)}`, { method: 'DELETE' });
    f.say(r.detached && r.removed === false
      ? `${email} detached. It could not be taken off the agent just now; that is retried at its next start.`
      : `${email} disconnected.`, r.removed === false ? 10000 : undefined);
    await f.draw(renderConnections);
  } catch (e) { f.fail(e, 10000); }
}

/** An agent's settings are one sheet; its tabs hold the editDlg sections. */
function openEdit(id, name, tab = 'def') {
  return openV2Agent(id, V2_TAB_FOR_EDIT[tab] ?? 'personality');
}

/** Fill the edit sections for this agent (the agent sheet borrows them from editDlg). */
function prepareEdit(id, name, tab = 'def') {
  // A value typed for the agent shown before and not added (an environment variable, a folder,
  // a repo, and the choices beside them) is not this one's: back as drawn, or Add gave it to
  // this agent (HB-0591).
  if (id !== editAgentId) {
    for (const f of ['envName', 'envValue', 'pathNew', 'repoUrl']) if ($(f)) $(f).value = '';
    for (const f of ['pathAccess', 'repoAccess']) if ($(f)) $(f).value = 'ro';
    if ($('repoPublic')) { $('repoPublic').checked = false; onRepoPublic(); }
    // A setup field being declared, as drawn: its key, label, type, target, default and options.
    for (const f of ['paramKey', 'paramLabel', 'paramDefault', 'paramOptions', 'paramRequired', 'paramType', 'paramTarget']) {
      const el = $(f); if (!el) continue;
      if (el.type === 'checkbox') el.checked = el.defaultChecked; else el.value = v2CtlDrawn(el);
    }
    if ($('paramType')) onParamTypeChange();
  }
  editAgentId = id;
  $('editAgent').textContent = name;
  $('editName').value = name;
  $('editDesc').value = agents.find(x => x.id === id)?.persona ?? '';
  $('gitKeyOut').style.display = 'none';
  showEditTab(tab);
  const cur = agents.find(x => x.id === id);
  $('editProfile').innerHTML = profiles.map(p =>
    `<option value="${p.id}"${p.id === cur?.aiProfileId ? ' selected' : ''}>${sourceOptionLabel(p)}</option>`).join('');
  renderModelPickerForAgent(cur);
  // Its saved source is selected again, so nothing waits on Use this: a source picked and
  // left unapplied in the sheet before kept the model button off here (audit #050).
  $('modelBtn').disabled = false;
  $('modelBtn').title = '';
  void populateImagePicker(cur?.image ?? '');
  if ($('editEmbedMode')) { $('editEmbedMode').value = cur?.embedMode || 'baked'; $('embedModeStatus').textContent = cur ? embedModeText(cur) : ''; }
  editParams = (cur?.parameters ?? []).map(p => ({ ...p }));
  editParamsSaved = JSON.stringify(editParams); editParamsFills++;
  renderSetupValues(cur);
  renderBotWho(cur);
  void renderEditMembers();
  renderParamList();
  $('setupFieldsRow').open = false; // definitions drawer starts closed; values are the everyday surface
  $('editCheckpoint').checked = true; // shared control — reset to safe default so a prior card's uncheck doesn't silently drop this agent's conversation on switch
  $('editBotToken').value = '';
  $('botTokenBtn').textContent = 'Show';
  renderDataList(cur?.dataSources);
  renderEnvList(cur?.envVars);
  if ($('agentSearchTestBtn')) $('agentSearchTestBtn').disabled = searchTests.has(id); // its own test, not another's
  $('editErr').textContent = '';
  $('snapList').innerHTML = '';
  v2SheetBaseline(...V2_SHEET_FORMS); // filled for this agent: nothing typed yet
}

async function loadSnapshots() {
  const el = $('snapList');
  const forId = editAgentId; // a slower answer for the agent opened before must not land here
  try {
    const snaps = await api(`/v1/agents/${forId}/snapshots`);
    if (editAgentId !== forId) return;
    el.innerHTML = snaps.length
      ? snaps.map(s => `
        <div class="pair">
          <span class="grow">🕘 <b>${esc(s.label)}</b>
            <span style="color:var(--dim)">${ago(s.createdAt)} · ${s.files.length} files${s.reason === 'manual' ? ' · kept' : ''}</span>
          </span>
          <button ${onAction('click', 'revertSnapshot', [`${s.id}`, `${s.label ?? ''}`])}>Revert</button>
          <button class="danger" title="Delete this restore point" ${onAction('click', 'deleteSnapshot', [`${s.id}`, `${s.label ?? ''}`])}>×</button>
        </div>`).join('')
      : '<div class="sub">No snapshots yet — one is taken automatically before your next edit.</div>';
  } catch (e) { if (editAgentId === forId) el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}

async function takeSnapshot() {
  const label = prompt('Name this snapshot (optional):', '');
  if (label === null) return;
  const forId = editAgentId, f = forAgent(forId);
  $('snapBtn').disabled = true;
  try {
    await api(`/v1/agents/${forId}/snapshots`, { method: 'POST', body: { label } });
    f.say('Snapshot saved');
    await f.draw(loadSnapshots);
  } catch (e) { f.fail(e); }
  finally { $('snapBtn').disabled = false; }
}

async function deleteSnapshot(snapId, label) {
  if (!confirm(`Delete snapshot "${label}"? This restore point is gone for good — the agent's live files are untouched.`)) return;
  const forId = editAgentId, f = forAgent(forId);
  try {
    await api(`/v1/agents/${forId}/snapshots/${snapId}`, { method: 'DELETE' });
    f.say('Snapshot deleted');
    await f.draw(loadSnapshots);
  } catch (e) { f.fail(e); }
}

// Agents whose revert is still running: their editor reads but cannot save
// (picking another file read it with Save on, and a Save then put back the
// text the revert was replacing — regression audit, 2026-10-22).
const editReverting = new Set();
const EDIT_REVERTING = 'Reverting… the editor reloads when it is done.';
async function revertSnapshot(snapId, label) {
  if (!confirm(`Revert to "${label}"? The agent's SOUL, AGENTS and MEMORY files go back to that point. Its current files are snapshotted first, so this is undoable. Applies to new conversations (send /new in its chat).`)) return;
  const forId = editAgentId, f = forAgent(forId);
  try {
    const res = await api(`/v1/agents/${forId}/snapshots/${snapId}/restore`, { method: 'POST', body: {} });
    // Since v2.156.0 a 202 with its operation: followed, its end said in a toast.
    // The 202 comes before a file is written, so the editor is read again when
    // it ends — read now, it showed the old text and a Save put it back (audit, 2026-10-20).
    if (res?.operation?.id) {
      editReverting.add(forId);
      f.draw(() => { editLoaded = null; $('editSaveBtn').disabled = true; $('editErr').textContent = EDIT_REVERTING; });
      v2FollowOp(res.operation, async () => { editReverting.delete(forId); await f.draw(async () => { await loadEditFile(); await loadSnapshots(); }); });
      return;
    }
    f.say(`Reverted ${res.restored.join(', ')}`);
    await f.draw(async () => { await loadEditFile(); await loadSnapshots(); });
  } catch (e) { f.fail(e); }
}

/**
 * One local model fits in memory at a time. Two agents on two DIFFERENT
 * local models evict each other on every message — each reply then pays a
 * ~10s reload. Warn before the user builds that for themselves.
 */
function localClashWarning(chosen, exceptAgentId) {
  if (chosen?.vendor !== 'local') return '';
  const clash = agents.find(a => {
    if (a.id === exceptAgentId) return null;
    const p = profiles.find(x => x.id === a.aiProfileId);
    return p?.vendor === 'local' && p.model !== chosen.model;
  });
  if (!clash) return '';
  const other = profiles.find(x => x.id === clash.aiProfileId);
  return `\n\n⚠ "${clash.name}" already uses the local model ${other?.model}. ` +
    `This machine keeps ONE local model in memory, so the two agents would ` +
    `evict each other and every reply would stall ~10s while the model reloads.`;
}

/**
 * The per-agent model picker. Shown only for cloud sources (a local source
 * runs its one model, so there's nothing to choose). The first option follows
 * the source's default; the rest are the source's switchable models. The empty
 * value means "no override" — the PATCH sends null to clear it.
 */
function renderModelPicker(menu, def, override) {
  const row = $('modelRow');
  if (!menu?.length) { row.style.display = 'none'; v2SheetBaseline('editModel'); return; }
  row.style.display = '';
  // A pin no longer on the menu (source edited under it) must not silently
  // read as "Source default" — surface it as an explicit, selected option so
  // the UI reports what the agent is actually still pinned to.
  const stale = override && !menu.includes(override);
  $('editModel').innerHTML =
    `<option value=""${!override ? ' selected' : ''}>Source default (${esc(def)})</option>` +
    menu.map(m =>
      `<option value="${esc(m)}"${m === override ? ' selected' : ''}>${esc(m)}${m === def ? ' — default' : ''}</option>`
    ).join('') +
    (stale ? `<option value="${esc(override)}" selected>${esc(override)} — no longer offered</option>` : '');
  v2SheetBaseline('editModel');
}

// The agent's own view (its saved profile + pin) vs a view of a source the
// user just selected in the dropdown but hasn't applied yet.
function renderModelPickerForAgent(agent) {
  renderModelPicker(agent?.profileModels, agent?.profileDefaultModel, agent?.modelOverride);
}
function renderModelPickerForProfile(p) {
  if (!p || p.vendor === 'local') { renderModelPicker([], undefined, undefined); return; }
  const menu = [p.model, ...(p.models ?? [])].filter((m, i, a) => m && a.indexOf(m) === i);
  // Switching source drops any old pin — show the new source's default.
  renderModelPicker(menu, p.model, undefined);
}

// The source dropdown changed: reflect the newly-chosen source's models
// immediately (before "Use this" is pressed), so the picker never lists the
// previous source's models. But a model can't be PINNED until the source
// switch itself is applied (the server validates the pin against the agent's
// CURRENT source), so disable the model button with a hint until then.
function onEditProfileChange() {
  const cur = agents.find(x => x.id === editAgentId);
  const sel = $('editProfile').value;
  const btn = $('modelBtn');
  if (sel === cur?.aiProfileId) {
    renderModelPickerForAgent(cur);
    btn.disabled = false;
    btn.title = '';
    return;
  }
  renderModelPickerForProfile(profiles.find(p => p.id === sel));
  btn.disabled = true;
  btn.title = 'Apply the source change first (Use this, above), then pick a model.';
}

async function switchModel() {
  const model = $('editModel').value || null; // '' → null clears the override
  // The agent whose model it is, as Use this was pressed: what comes back is said for it.
  const forId = editAgentId, f = forAgent(forId), saved = v2SheetSaving('editModel');
  $('modelBtn').disabled = true;
  try {
    // Live change: OpenClaw reads the model per turn, so a running agent picks
    // it up on the next message — no rebuild, no restart, no downtime.
    const r = await api(`/v1/agents/${forId}/model`, { method: 'POST', body: { model } });
    saved(forId);
    // failed: its runtime refused it, so it still answers on the old model (as Bulk actions say too, HB-0595).
    f.say((r.failed ? `Saved ${r.model}, but its runtime refused it: it answers on the old model until you try again or Rebuild.`
      : r.live
      ? `Now running ${r.model} — effective on the next message, no rebuild.`
      : r.staged ? `Set to ${r.model} — written to the stopped agent; applies when it next starts.`
      : r.rebuild ? `Saved — this agent also has an AI-source switch waiting, so both apply on its next Rebuild.`
      : `Set to ${r.model} — applies on its next rebuild.`), 8000);
    // 'pending': its class is still applying a change; whether it leaves is decided once that is done.
    if (r.classDetached === 'pending') f.say('Its class is applying a change: once that is done, it leaves the class if the class pins a different model.', 6000);
    else if (r.limitsKept) f.say(`${leftClassKeptLimits(r.limitsKept, 'It')} (The class pins a different model.)`, 12000);
    else if (r.classDetached) f.say('Detached from its class (the class pins a different model).', 6000);
    await refresh(false);
  } catch (e) { f.fail(e); }
  finally { $('modelBtn').disabled = false; }
}

async function switchProfile() {
  const id = $('editProfile').value;
  // The agent and the checkpoint box as they were when Use this was pressed: with
  // the sheet closed and another agent's opened while it saved, the rebuild went
  // to that other agent, with its box (audit #047).
  const forId = editAgentId, f = forAgent(forId), checkpoint = $('editCheckpoint').checked;
  const chosen = profiles.find(p => p.id === id);
  if (!confirm(`Use "${chosen?.name}" (${chosen?.model}) for this agent?\n\nApplies on the next Rebuild — its memory is kept.${localClashWarning(chosen, forId)}`)) return;
  $('profileBtn').disabled = true;
  const saved = v2SheetSaving('editProfile', 'editCheckpoint');
  try {
    await api(`/v1/agents/${forId}`, { method: 'PATCH', body: { aiProfileId: id } });
    saved(forId);
    const name = agents.find(x => x.id === forId)?.name || 'this agent';
    if (confirm(`Saved. Rebuild "${name}" now to start using it?\n\nThe agent restarts (memory kept) and is briefly offline; one that is not running stays that way and uses it from its next start. Tip: send /new in its chat afterwards — a fresh conversation suits a new model.`)) {
      const r = await api(`/v1/agents/${forId}/rebuild`, {
        method: 'POST', body: { checkpoint, stoppedWaits: true },
      });
      f.say(r?.atNextStart ? 'Saved. It is not running, so it stays that way: it starts on the new AI source next time.'
        : checkpoint ? 'Saving conversation to memory, then rebuilding…'
        : 'Rebuilding with the new AI source');
      f.draw(() => editDlg.close());
    } else {
      f.say('Saved — Rebuild to apply it');
    }
    await refresh(false);
    // Dialog stayed open: the agent is now on the new source (and any stranded
    // pin was cleared server-side). Re-render the model picker from the fresh
    // agent so it lists the new source's models, not the old ones.
    f.draw(() => {
      renderModelPickerForAgent(agents.find(x => x.id === forId));
      $('modelBtn').disabled = false;
      $('modelBtn').title = '';
    });
  } catch (e) { f.fail(e); }
  finally { $('profileBtn').disabled = false; }
}

// The unified data list: legacy read-only folders + richer data sources, each
// with a kind icon and an access badge, so it's obvious what the agent can see.
function renderDataList(sources) {
  editData = sources ?? [];
  const badge = d => d.access === 'rw'
    ? '<span style="color:var(--accent);font-weight:600">writable</span>'
    : '<span style="color:var(--dim)">read-only</span>';
  const isPublicRepo = d => d.kind === 'git' && /^https:\/\//.test(d.repoUrl || '');
  const icon = d => isPublicRepo(d) ? '🌐' : d.kind === 'git' ? '🔧' : (d.access === 'rw' ? '✏️' : '📁');
  // Where the agent finds it: a repo is cloned under its home (~/.openclaw/<repo>), a folder is mounted under /data.
  const where = d => isPublicRepo(d)
    ? `→ ~/.openclaw/${esc(d.mountName)} · public, read-only`
    : d.kind === 'git'
    ? `→ ~/.openclaw/${esc(d.mountName)} · ${badge(d)}`
    : `→ ${d.mountAtHostPath ? esc(d.hostPath) + ' (same path)' : '/data/' + esc(d.mountName)} · ${badge(d)}`;
  // Legacy shared folders have no data-source row to update — they're managed
  // through sharedPaths, so they get no toggle. The button says what it DOES
  // ("Make writable"), not a state: "→ writable" read as already writable (Chris, 2026-10-23).
  const toggle = d => (d.legacy || isPublicRepo(d)) ? '' :
    `<button ${onAction('click', 'setDataAccess', [`${d.id ?? ''}`, `${d.access === 'rw' ? 'ro' : 'rw'}`])}
             title="${d.access === 'rw' ? 'Take write access away' : 'Allow this agent to write here'} — applies on the next rebuild">
       ${d.access === 'rw' ? 'Make read-only' : 'Make writable'}</button>`;
  const line = (d) => `<div class="pair" data-ds="${esc(d.id || '')}"><span class="grow">${icon(d)} <code>${esc(d.hostPath || d.repoUrl || d.mountName)}</code>
        <span class="sub">${where(d)}</span><span class="sub ds-check" style="display:block"></span></span>
        ${toggle(d)}
        ${d.legacy ? '' : `<button ${onAction('click', 'checkDataSource', [`${d.id ?? ''}`, { $: 'el' }])} title="${d.kind === 'git' ? 'Ask the git host from this machine: does the repo answer with this key?' : 'Is the folder there, and can the service read' + (d.access === 'rw' ? ' and write' : '') + ' it?'}">Test</button>`}
        ${d.kind === 'git' && d.pubKey ? `<button ${onAction('click', 'showDeployKey', [`${d.id ?? ''}`])} title="Show the deploy key to add to the repo on GitHub">🔑 Deploy key</button>` : ''}
        <button class="danger" ${onAction('click', 'removeDataSource', [`${d.id ?? ''}`])}>×</button></div>`;
  // Folders and repos are different things with different rules; listing them
  // together made one section that answered neither question (2026-09-20).
  const folders = editData.filter(d => d.kind !== 'git');
  const repos = editData.filter(d => d.kind === 'git');
  $('dataList').innerHTML = folders.length ? folders.map(line).join('')
    : '<div class="sub">No folders — it sees only its own workspace.</div>';
  if ($('repoList')) $('repoList').innerHTML = repos.length ? repos.map(line).join('') : '<div class="sub">None yet.</div>';
}

function onRepoPublic() {
  // A public clone has no credential to push with: read-only is the only option.
  const pub = $('repoPublic').checked;
  if (pub) $('repoAccess').value = 'ro';
  $('repoAccess').disabled = pub;
  // The address it takes: a public one is cloned over https, a private one with its deploy key over ssh.
  $('repoUrl').placeholder = pub ? 'https://github.com/you/repo' : 'git@github.com:you/repo.git';
}

async function addGitSource() {
  const repoUrl = $('repoUrl').value.trim();
  if (!repoUrl) return;
  const isPublic = $('repoPublic').checked;
  const access = isPublic ? 'ro' : $('repoAccess').value;
  const forId = editAgentId, f = forAgent(forId), saved = v2SheetSaving('repoAccess');
  $('repoAddBtn').disabled = true;
  try {
    const updated = await api(`/v1/agents/${forId}/data-sources`, { method: 'POST', body: { kind: 'git', access, repoUrl, public: isPublic } });
    f.draw(() => {
      $('repoUrl').value = ''; saved(forId); v2SheetBaseline('repoUrl'); // the box is empty again, and that is as filled; the access stays as chosen
      renderDataList(updated.dataSources);
      if (isPublic) { $('repoPublic').checked = false; onRepoPublic(); v2SheetBaseline('repoPublic', 'repoAccess'); }
      // A private repo's deploy key, straight away: it must be added to the repo before a clone can work.
      else showDeployKeyForSource(updated.dataSources.filter(d => d.kind === 'git').slice(-1)[0]);
    });
    // Said the same whether its forms are on screen or not, with when it is cloned.
    f.say(isPublic
      ? (updated.state === 'RUNNING' ? 'Public repo added — cloning it now; no key needed.' : 'Public repo added — it is cloned on the next Rebuild.')
      : 'Repo added — add its deploy key (on its Data tab) to the repo, then Rebuild: it is cloned then.', 9000);
    await refresh(false);
  } catch (e) { f.fail(e); }
  finally { $('repoAddBtn').disabled = false; }
}
/**
 * "Its name: " before what is said about an agent that is not the one shown (the agent's
 * sheet, or the classic edit dialog); nothing for the one shown. An answer that comes back
 * after another agent was opened says whose it is (HB-0584, HB-0587, HB-0590).
 */
function agentPrefix(id) {
  const shown = v2AgentDlg.open ? v2AgentId : editDlg.open ? editAgentId : null;
  return shown === id ? '' : `${agents.find(x => x.id === id)?.name || 'The agent'}: `;
}
/**
 * What comes back from a change pressed in an agent's edit forms (its sheet's tabs of them, or
 * the classic edit dialog) is for the agent it was pressed for. By then another agent may be
 * open, another tab of its sheet, or nothing. Drawn into whichever forms were open, a legacy
 * folder's removal sent one agent's folders to another (HB-0584); written under forms out of
 * sight, an error was never seen. Every save asks this one helper:
 *   mine()   the edit forms are still filled for it (no other agent's have been drawn in them);
 *   shown()  and the person sees them: its sheet on a tab of them, or the classic dialog;
 *   draw(fn) fn draws the answer into its forms, only while they are its (and returns what fn does);
 *   say(text, ms) a toast, its name before it unless it is the agent shown;
 *   fail(e)  under the forms while they are in sight, else said in a toast as say() is.
 */
function forAgent(forId) {
  const mine = () => editAgentId === forId;
  const shown = () => mine() && (v2AgentDlg.open ? v2AgentId === forId && $('v2Pane').contains($('editErr')) : editDlg.open);
  const say = (text, ms) => toast(agentPrefix(forId) + text, ms);
  return {
    mine, shown, say,
    draw: (fn) => mine() ? fn() : undefined,
    fail: (e, ms = 9000) => { if (shown()) $('editErr').textContent = e.message; else say(e.message, ms); },
  };
}

function showDeployKey(id) { showDeployKeyForSource(editData.find(d => d.id === id)); }

function showDeployKeyForSource(src) {
  if (!src || !src.pubKey) return;
  const el = $('gitKeyOut');
  el.style.display = '';
  const write = src.access === 'rw';
  // Derive the "add deploy key" page from git@host:owner/repo.git — direct link
  // for GitHub; a plain instruction for other hosts.
  const m = /^git@([^:]+):(.+?)(?:\.git)?$/.exec(src.repoUrl || '');
  const link = m && m[1] === 'github.com'
    ? `<a href="https://github.com/${esc(m[2])}/settings/keys/new" target="_blank" rel="noopener" style="color:var(--accent);font-weight:600">Open ${esc(m[2])} → Add deploy key ↗</a>`
    : `Add it at your git host: the repo → Settings → Deploy keys → Add`;
  const name = (src.repoUrl || src.mountName || '').replace(/^git@[^:]+:/, '').replace(/\.git$/, '');
  el.innerHTML =
    `<div style="margin-bottom:8px"><b>🔑 Deploy key for ${esc(name)}</b> <button type="button" class="hbtn" style="float:right" ${onAction('click', 'hideById', ["gitKeyOut"])} aria-label="Hide the deploy key">✕</button></div>` +
    `<div style="margin-bottom:8px">${link}${write ? ' <span class="sub">— then check “Allow write access”, paste the key below, press Test, and Rebuild.</span>' : ' <span class="sub">— paste the key below, press Test, then Rebuild.</span>'}</div>` +
    `<div style="user-select:all;word-break:break-all">${esc(src.pubKey)}</div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** The Test button on a folder or repo: one request, its answer under the row. */
async function checkDataSource(id, btn) {
  const row = $('dataList')?.querySelector(`[data-ds="${CSS.escape(id)}"]`) || $('repoList')?.querySelector(`[data-ds="${CSS.escape(id)}"]`);
  const out = row?.querySelector('.ds-check');
  // Whose folder or repo it is: the answer goes under its row only while the forms are still
  // that agent's (and the row with them); otherwise in a toast with its name, as the search test.
  const forId = editAgentId, f = forAgent(forId);
  if (btn) btn.disabled = true;
  if (out) { out.style.color = ''; out.textContent = 'Checking…'; }
  let r, said, color;
  try {
    r = await api(`/v1/agents/${forId}/data-sources/${encodeURIComponent(id)}/check`, { method: 'POST', body: {} });
    said = `${r.ok ? '✅' : '⚠️'} ${r.message}`; color = r.ok ? '' : 'var(--warn)';
  } catch (e) { said = `⚠️ ${e.message}`; color = 'var(--bad)'; }
  finally { if (btn) btn.disabled = false; }
  const drawn = f.draw(() => { if (!out?.isConnected) return false; out.textContent = said; out.style.color = color; return true; });
  if (!drawn || !f.shown()) f.say(said, 9000);
  // A key the host refused: show it again, right here, so the next step is in view.
  if (r && !r.ok && r.reason === 'key-not-added') f.draw(() => showDeployKey(id));
}

async function addDataSource() {
  const p = $('pathNew').value.trim();
  if (!p) return;
  const access = $('pathAccess').value;
  if (access === 'rw' && !confirm(`Give the agent WRITE access to ${p}?\n\nIt can change or delete files there, and anyone who can message it can trigger that. Only do this for data you're comfortable it editing.`)) return;
  const forId = editAgentId, f = forAgent(forId), saved = v2SheetSaving('pathAccess');
  $('pathAddBtn').disabled = true;
  try {
    const updated = await api(`/v1/agents/${forId}/data-sources`, { method: 'POST', body: { kind: 'folder', access, path: p } });
    f.draw(() => {
      $('pathNew').value = ''; saved(forId); v2SheetBaseline('pathNew'); // the box is empty again, and that is as filled; the access stays as chosen
      renderDataList(updated.dataSources);
    });
    f.say('Folder added — Rebuild to apply it.', 9000);
    await refresh(false);
  } catch (e) { f.fail(e); }
  finally { $('pathAddBtn').disabled = false; }
}

async function setDataAccess(id, access) {
  const src = editData.find(d => d.id === id);
  if (!src) return;
  // Be straight about what each kind's flag actually controls.
  if (src.kind === 'git' && access === 'rw' &&
      !confirm(`Mark "${src.mountName}" writable?\n\nThis tells the agent it may change and commit in that checkout. Whether a PUSH is accepted is set by the deploy key's permission on the repo host — grant the key write access there too.`)) return;
  if (src.kind === 'folder' && access === 'rw' &&
      !confirm(`Let this agent WRITE to ${src.hostPath}?\n\nIt runs without permission prompts and is reachable by everyone in it, so one bad instruction could change or delete files here.`)) return;
  const forId = editAgentId, f = forAgent(forId);
  try {
    const updated = await api(`/v1/agents/${forId}/data-sources/${id}`, { method: 'PATCH', body: { access } });
    f.draw(() => renderDataList(updated.dataSources));
    f.say(`${src.mountName} is now ${access === 'rw' ? 'writable' : 'read-only'} — Rebuild to apply it.`, 9000);
    await refresh(false);
  } catch (e) { f.fail(e); }
}

async function removeDataSource(id) {
  const src = editData.find(d => d.id === id);
  if (!src) return;
  // A repo goes from the agent completely (HB-0002): its clone too, so say what that loses.
  const repoNote = src.kind === 'git'
    ? ` Its copy in the agent (~/.openclaw/${src.mountName}) is deleted, with any changes not pushed${src.repoUrl && !/^https?:/.test(src.repoUrl) ? ', and so is its deploy key' : ''}.`
    : '';
  if (!confirm(`Remove ${src.kind === 'folder' ? 'the folder' : 'the repo'} “${src.mountName}” from this agent?${repoNote}`)) return;
  const forId = editAgentId, f = forAgent(forId);
  try {
    let updated;
    if (src.legacy) {
      // Legacy folders still live on sharedPaths — drop this one from that list.
      const paths = editData.filter(d => d.legacy && d.id !== id).map(d => d.hostPath);
      updated = await api(`/v1/agents/${forId}`, { method: 'PATCH', body: { sharedPaths: paths } });
    } else {
      updated = await api(`/v1/agents/${forId}/data-sources/${id}`, { method: 'DELETE' });
    }
    f.draw(() => renderDataList(updated.dataSources));
    // Hatchabot deletes its copies of a deploy key, but the repo's host still
    // trusts the key until it is deleted there too.
    const rk = updated.removedKey, rr = updated.removedRepo;
    const later = rr && !rr.scrubbed ? ' The agent could not be reached just now: its copy and key go at its next start (retried until done).' : '';
    f.say(rr
      ? `Removed, with its copy in the agent.${rk ? ' Also delete its deploy key on the repo’s host (the repo’s settings → Deploy keys).' : ''}${later}`
      : 'Removed — Rebuild to apply it', rk || later ? 15000 : undefined);
    await refresh(false);
  } catch (e) { f.fail(e); }
}

function renderEnvList(vars) {
  $('agentSearchTestOut').textContent = ''; // what it said was about the agent shown before
  const list = vars ?? [];
  $('envList').innerHTML = list.length
    ? list.map(v => `<div class="pair"><span class="grow">🔑 <code>${esc(v.name)}</code>
        <span class="sub">value hidden</span></span>
        <button class="danger" ${onAction('click', 'removeEnvVar', [`${v.id ?? ''}`, `${v.name ?? ''}`])}>×</button></div>`).join('')
    : '<div class="sub">None set.</div>';
}

async function addEnvVar() {
  const name = $('envName').value.trim();
  const value = $('envValue').value;
  if (!name || !value) { toast('Both a name and a value are needed.'); return; }
  $('envAddBtn').disabled = true;
  $('editErr').textContent = '';
  const forId = editAgentId, f = forAgent(forId); // its list is drawn only in its own forms, as the Data tab's (HB-0584)
  try {
    const updated = await api(`/v1/agents/${forId}/env`, { method: 'POST', body: { name, value } });
    // Emptied by the Add, as filled: a draft kept from before (and noted then) does not count as an edit.
    f.draw(() => { $('envName').value = ''; $('envValue').value = ''; v2SheetBaseline('envName', 'envValue'); renderEnvList(updated.envVars); });
    f.say(`${name} added — Rebuild to apply it.`, 9000);
    await refresh(false);
  } catch (e) { f.fail(e); }
  finally { $('envAddBtn').disabled = false; }
}

async function removeEnvVar(id, name) {
  if (!confirm(`Remove ${name}? The agent loses this variable on its next rebuild.`)) return;
  $('editErr').textContent = '';
  const forId = editAgentId, f = forAgent(forId); // removed from the agent pressed for: its list only is drawn again
  try {
    const updated = await api(`/v1/agents/${forId}/env/${encodeURIComponent(id)}`, { method: 'DELETE' });
    f.draw(() => renderEnvList(updated.envVars));
    f.say(`${name} removed — Rebuild to apply it.`, 9000);
    await refresh(false);
  } catch (e) { f.fail(e); }
}
