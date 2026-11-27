// web/app/create.js: creating an agent, and adopting an existing OpenClaw agent.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- agent creation ---------------------------------------------------------

$('fabBtn').onclick = () => {
  $('createErr').textContent = '';
  // Show usage against the per-account cap up front, so hitting it isn't a
  // surprise 429. Archived agents don't count (server-side rule).
  const cap = appConfig?.maxAgentsPerAccount || 0;
  const live = agents.filter(a => (a.role ? a.role === 'owner' : true) && a.state !== 'ARCHIVED').length;
  $('agentCountNote').innerHTML = cap
    ? `${live} of ${cap} agents used${live >= cap ? ' — <span style="color:var(--warn)">at the limit; delete or archive one first</span>' : ''}`
    : '';
  $('agentProfileRow').style.display = profiles.length > 1 ? '' : 'none';
  // The ⭐ default source (if any, and visible to this account) is preselected;
  // the picker still offers everything.
  $('agentProfile').innerHTML = profiles.map(p =>
    `<option value="${p.id}"${p.defaultSource ? ' selected' : ''}>${sourceOptionLabel(p)}</option>`).join('');
  // Host picker only when there's somewhere to choose (a runner exists). "Auto"
  // lands on the least-loaded runner.
  const runners = hosts.filter(h => h.kind !== 'local');
  $('agentHostRow').style.display = runners.length ? '' : 'none';
  if (runners.length) {
    const local = hosts.find(h => h.kind === 'local');
    $('agentHost').innerHTML =
      (local ? `<option value="${local.id}">🖥️ This machine (Max or API key)</option>` : '') +
      `<option value="auto">☁️ Auto — least-loaded runner</option>` +
      runners.map(h => `<option value="${h.id}">☁️ ${esc(h.name)} (${h.agentCount})</option>`).join('');
    onHostPicked();
  }
  // Telegram is off until it is asked for (the owner, 2026-11-07: the web
  // console made it the exception, and "No Telegram" was ticked on most new
  // agents). Decided afresh on every open, so one agent's choice is not the next one's.
  $('agentTelegram').checked = false;
  $('agentUsePool').checked = true;
  $('agentPoolCount').textContent = poolAvail > 0 ? `(${poolAvail} ready${myAccount.prefs?.ownBotsOnly ? ', yours only' : ''})` : '';
  agentTelegramChanged();
  // An app from a repo reads this machine's folders and git login: its owner only.
  $('createFromRepo').hidden = !myAccount?.hostOwner;
  createDlg.showModal();
  if (pendingTodoName) { $('agentName').value = pendingTodoName; pendingTodoName = null; }
  $('agentName').focus();
};

/**
 * The New agent form's Telegram tick. Ticked: the pool choice, when the pool
 * has bots (default: use one, instant), or else the warning that it waits for
 * a BotFather token — an empty pool once parked an agent on a token nobody had
 * (2026-09-23).
 */
function agentTelegramChanged() {
  const on = $('agentTelegram').checked;
  $('agentPoolRow').style.display = on && poolAvail > 0 ? 'flex' : 'none';
  $('agentPoolEmptyNote').hidden = !on || poolAvail > 0;
}

// Resolve the picker to a concrete host id ("auto" → least-loaded runner).
// Auto passes over a runner the hosts list says does not answer (HB-1039);
// one whose answer is not known is still a choice. With every runner so, it
// says so rather than send the agent to one that does not answer.
function pickedHostId() {
  const v = $('agentHostRow').style.display === 'none' ? null : $('agentHost').value;
  if (!v || v === 'auto') {
    const runners = hosts.filter(h => h.kind !== 'local');
    const answering = runners.filter(h => h.reachable !== false);
    if (v === 'auto' && answering.length) return answering.slice().sort((a, b) => a.agentCount - b.agentCount)[0].id;
    if (v === 'auto' && runners.length) {
      const local = hosts.some(h => h.kind === 'local');
      throw new Error(`No runner answers just now (${runners.map(h => h.name).join(', ')}), so Auto has nowhere to put it. ${local ? 'Choose This machine, or try' : 'Try'} again once a runner answers.`);
    }
    return (hosts.find(h => h.kind === 'local') ?? hosts[0])?.id;
  }
  return v;
}

// On a runner, a Claude Max source works only as a `claude setup-token` (that
// credential is injected as data); the machine-login Max source mounts this
// box's ~/.claude and can't reach a runner. Surface the mismatch up front so it
// isn't a submit-time surprise — the server enforces it either way.
function onHostPicked() {
  const id = $('agentHost').value;
  const isCloud = id === 'auto' || hosts.find(h => h.id === id)?.kind !== 'local';
  const sel = profiles.find(p => p.id === ($('agentProfile').value || (profiles[0] && profiles[0].id)));
  let hint = '';
  if (isCloud) {
    hint = sel && sel.kind === 'subscription' && sel.credential === 'machine-login'
      ? "⚠ This Claude Max source is desktop-only — on a runner it can't reach the agent. Use an API key or a `claude setup-token` source."
      : 'On a runner: API-key and Claude Max setup-token sources both work; the machine-login Max source is desktop-only.';
  }
  $('agentHostHint').textContent = hint;
}

async function createAgent() {
  const name = $('agentName').value.trim();
  if (!name) { $('createErr').textContent = 'Give it a name.'; return; }
  let hostId;
  try { hostId = pickedHostId(); } catch (e) { $('createErr').textContent = e.message; return; }
  if (!profiles[0]) { $('createErr').textContent = 'Add an AI source first: ⚙ Settings → AI sources.'; return; }
  if (!hostId) { $('createErr').textContent = 'No host is configured on this server.'; return; }
  $('createBtn').disabled = true;
  try {
    await api('/v1/agents', { method: 'POST', body: {
      name, persona: $('agentPersona').value.trim() || undefined,
      aiProfileId: (profiles.length > 1 && $('agentProfile').value) || profiles[0].id,
      hostId,
      // Only meaningful when the pool row was offered and declined.
      skipPool: ($('agentPoolRow').style.display !== 'none' && !$('agentUsePool').checked) || undefined,
      // Said either way: the API's own default (a bot) is for the CLI and scripts.
      telegram: $('agentTelegram').checked,
    }});
    createDlg.close(); $('agentName').value = ''; $('agentPersona').value = '';
    $('agentTelegram').checked = false; agentTelegramChanged();
    await refresh(false);
  } catch (e) { $('createErr').textContent = e.message; }
  finally { $('createBtn').disabled = false; }
}

// ---- adopt an existing OpenClaw agent --------------------------------------

let adoptInspected = null; // last inspect result: { path, existingBot }
let ocAgents = [];         // discovered OpenClaw agents
// What the last "Bring in selected" said on each row, by workspace: the list
// is drawn again once it is done, and a "not taken over" line must survive it.
let ocRowNotes = {};

function openAdoptDlg() {
  adoptInspected = null;
  ocAgents = [];
  ocRowNotes = {};
  $('adoptPath').value = ''; $('adoptName').value = '';
  $('adoptPreview').innerHTML = ''; $('adoptBotArea').innerHTML = '';
  $('adoptErr').textContent = '';
  $('adoptForm').hidden = true;
  $('adoptBtn').disabled = true;
  $('adoptBatchBtn').disabled = true;
  $('adoptSelCount').textContent = '';
  $('adoptDiscover').textContent = 'Looking for OpenClaw agents…';
  $('adoptProfileRow').style.display = profiles.length > 1 ? '' : 'none';
  $('adoptProfile').innerHTML = profiles.map(p => `<option value="${p.id}">${sourceOptionLabel(p)}</option>`).join('');
  adoptDlg.showModal();
  loadOpenclawAgents();
}

async function loadOpenclawAgents() {
  try {
    const { agents } = await api('/v1/openclaw/agents');
    ocAgents = agents || [];
    renderDiscovery();
  } catch (e) {
    $('adoptDiscover').innerHTML = `<div class="sub">Couldn't read OpenClaw agents (${esc(e.message)}). Use the manual path below.</div>`;
  }
}

function renderDiscovery() {
  const el = $('adoptDiscover');
  if (!ocAgents.length) {
    el.innerHTML = `<div class="sub">No OpenClaw agents found on this machine. Use the manual path below.</div>`;
    return;
  }
  el.innerHTML = ocAgents.map((a, i) => {
    const blocked = a.alreadyAdoptedAs || a.problem;
    let status;
    if (a.alreadyAdoptedAs) status = `already in Hatchabot as “${esc(a.alreadyAdoptedAs)}”`;
    else if (a.problem) status = esc(a.problem);
    else if (a.bot && a.bot.enabledInSource) status = `takes over @${esc(a.bot.accountId)} — disabled in OpenClaw for you`;
    else if (a.bot) status = `@${esc(a.bot.accountId)} · already off in OpenClaw`;
    else status = 'no bot of its own — comes in without Telegram: talk to it in the web console';
    return `<label style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-top:1px solid var(--line)${blocked ? ';opacity:.55' : ''}">
      <input type="checkbox" data-oc="${i}" ${blocked ? 'disabled' : ''} style="width:auto;margin-top:3px" ${onAction('change', 'updateSelCount')}>
      <span style="flex:1"><b>${esc(a.name)}</b> <span class="sub">— ${status}</span>
        <span id="ocrow-${i}" class="sub" style="display:block;margin-top:2px${ocRowNotes[a.workspace] ? `;color:${ocRowNotes[a.workspace].color}` : ''}">${esc(ocRowNotes[a.workspace]?.text || '')}</span></span>
    </label>`;
  }).join('');
  updateSelCount();
}

function updateSelCount() {
  const n = document.querySelectorAll('#adoptDiscover input[data-oc]:checked').length;
  $('adoptSelCount').textContent = n ? `${n} selected` : '';
  $('adoptBatchBtn').disabled = !n;
  $('adoptBatchBtn').textContent = n ? `Bring in selected (${n})` : 'Bring in selected';
}

async function bringInSelected() {
  const picks = [...document.querySelectorAll('#adoptDiscover input[data-oc]:checked')].map(el => ocAgents[+el.dataset.oc]);
  if (!picks.length) { toast('Tick at least one agent to bring in.'); return; }
  $('adoptBatchBtn').disabled = true;
  $('adoptErr').textContent = '';
  const rowSay = (i, m, color) => {
    if (ocAgents[i]) ocRowNotes[ocAgents[i].workspace] = { text: m, color: color || 'var(--dim)' };
    const el = $(`ocrow-${i}`); if (el) { el.textContent = m; el.style.color = color || 'var(--dim)'; }
  };
  const idxOf = a => ocAgents.indexOf(a);

  // 1. Hand over EVERY selected bot — disable each and restart the gateway ONCE,
  // then verify each went quiet. We quiesce even bots already marked disabled in
  // the config: "disabled but the gateway was never restarted" still polls, and
  // discovery can't see that, so the restart is what actually stops the poller.
  const toQuiesce = picks.filter(a => a.bot).map(a => a.bot.accountId);
  let stillBusy = [], unconfirmed = [];
  if (toQuiesce.length) {
    for (const a of picks) if (a.bot) rowSay(idxOf(a), 'waiting for OpenClaw hand-over…');
    try {
      const r = await api('/v1/openclaw/quiesce', { method: 'POST', body: { accountIds: toQuiesce } });
      stillBusy = r.stillBusy || [];
      // Telegram did not answer for these, so OpenClaw's poller is not known
      // to have stopped: taking the bot over could leave two pollers on it.
      unconfirmed = r.unconfirmed || [];
    } catch (e) {
      $('adoptErr').style.color = ''; $('adoptErr').textContent = `Bot hand-over failed: ${e.message}`;
      $('adoptBatchBtn').disabled = false; return;
    }
  }

  // 2. Bring each in, one at a time (each takes over its own bot + copies files).
  let ok = 0;
  let crons = 0;
  const adopted = [];
  for (const a of picks) {
    const i = idxOf(a);
    if (a.bot && stillBusy.includes(a.bot.accountId)) { rowSay(i, '✗ bot still polled by OpenClaw — try again', 'var(--warn)'); continue; }
    if (a.bot && unconfirmed.includes(a.bot.accountId)) { rowSay(i, "✗ couldn't confirm OpenClaw stopped using this bot (Telegram didn't answer) — try again", 'var(--warn)'); continue; }
    try {
      const { res, agentId } = await doAdopt({ path: a.workspace, name: a.name, reuse: !!a.bot, web: !a.bot, token: '', bot: a.bot, onStatus: m => rowSay(i, m) });
      const c = adoptTasksCarried(res.crons);
      crons += c;
      const later = adoptTasksLater(res.crons), changed = adoptTasksChanged(res.crons);
      rowSay(i, `✓ brought in${c ? ` · ${c} task${c > 1 ? 's' : ''} carried (disabled)` : ''}${later ? ` · ${later}` : ''}${changed ? ` · ${changed}` : ''}${adoptTasksMissed(res.crons)}`, 'var(--ok)'); ok++;
      adopted.push({ agentId, name: a.name, workspace: a.workspace });
    } catch (e) { rowSay(i, `✗ ${e.message}`, 'var(--warn)'); }
  }
  await refresh(true);
  toast(`Brought in ${ok} of ${picks.length} agent(s)${crons ? ` · ${crons} scheduled task(s) carried, disabled for review` : ''}.`, 15000);
  await offerFolders(adopted); // one prompt covering every agent's external data
  await loadOpenclawAgents(); // adopted ones now show as already-in-Hatchabot
  $('adoptBatchBtn').disabled = false;
}

async function adoptInspect() {
  const path = $('adoptPath').value.trim();
  if (!path) { $('adoptErr').textContent = 'Enter the workspace folder path.'; return; }
  $('adoptErr').textContent = '';
  $('adoptInspectBtn').disabled = true;
  try {
    const p = await api('/v1/workspaces/inspect', { method: 'POST', body: { path } });
    adoptInspected = { path: p.path, existingBot: p.existingBot };
    const md = p.markdownFiles || [];
    const shown = md.slice(0, 8).join(', ') + (md.length > 8 ? `, +${md.length - 8} more` : '');
    const skip = p.skipped?.length
      ? `<div class="sub" style="margin-top:4px">Skipping ${esc(p.skipped.join(', '))} — built for this machine; the agent rebuilds them.</div>` : '';
    // Links are not copied (a link means something else inside the agent):
    // named here, so the copy is what this preview shows.
    const links = p.links || [];
    const linkLine = links.length
      ? `<div class="sub" style="margin-top:4px">Not copied — ${links.length === 1 ? 'a link' : `${links.length} links`}: ${esc(links.slice(0, 6).join(', '))}${links.length > 6 ? `, +${links.length - 6} more` : ''}. Copy what it points at into the folder if the agent needs it.</div>` : '';
    $('adoptPreview').innerHTML =
      `<div style="border:1px solid var(--line);border-radius:8px;padding:10px">
        <div><b>${esc(p.path)}</b></div>
        <div class="sub" style="margin-top:2px">${p.files.length} files · ${(p.bytes / 1e6).toFixed(1)} MB · ${md.length} markdown${md.length ? `: ${esc(shown)}` : ''}</div>
        ${skip}${linkLine}
      </div>`;
    // Suggest a name from the folder: "…/workspace-garden-advisor" → "Garden Advisor".
    if (!$('adoptName').value) {
      const base = (p.path.split('/').pop() || '').replace(/^workspace-/, '').replace(/[-_]+/g, ' ').trim();
      if (base) $('adoptName').value = base.replace(/\b\w/g, c => c.toUpperCase());
    }
    renderAdoptBot(p.existingBot);
    $('adoptForm').hidden = false;
    $('adoptBtn').disabled = false;
  } catch (e) {
    adoptInspected = null;
    $('adoptPreview').innerHTML = '';
    $('adoptForm').hidden = true;
    $('adoptBtn').disabled = true;
    $('adoptErr').textContent = e.message;
  } finally { $('adoptInspectBtn').disabled = false; }
}

/**
 * How an owner switches a Telegram account off in OpenClaw's config: the
 * command for a key a shell takes as it is, else the change in words. A key
 * edited by hand may hold a space, a quote, `;` or `$(…)`, and the command
 * pasted as printed broke, or ran it (HB-1031).
 */
function accountOffWords(key) {
  return /^[A-Za-z0-9_-]+$/.test(String(key))
    ? `openclaw config set channels.telegram.accounts.${key}.enabled false`
    : `in OpenClaw's config (openclaw.json), under channels.telegram.accounts, set "enabled": false on the account “${key}”`;
}
/** The same as a block to copy (`then`: a command after it), or, for a key no command can hold, in words. */
function accountOffHtml(key, then) {
  if (/^[A-Za-z0-9_-]+$/.test(String(key))) {
    return `<div class="invite-link" style="margin-top:6px">${esc(accountOffWords(key))}${then ? `\n${esc(then)}` : ''}</div>`;
  }
  return `<div class="sub" style="margin-top:6px">${esc(accountOffWords(key))}${then ? `, then run:` : '.'}</div>`
    + (then ? `<div class="invite-link" style="margin-top:6px">${esc(then)}</div>` : '');
}

/** A hand-built agent's bot, by its account's key in OpenClaw's config: no @handle ("default", say) (HB-1300). `start`: a sentence's first words. */
function adoptBotName(bot, start = false) {
  return `${start ? 'Its' : 'its'} bot (Telegram account “${bot.accountId}”)`;
}

function renderAdoptBot(bot) {
  const el = $('adoptBotArea');
  // Without Telegram: the web console is how it is talked to, and adopting
  // costs no bot slot (2026-10-08). The default when the workspace has no bot.
  const web = (checked) => `<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;margin-top:8px">
      <input type="checkbox" id="adoptWeb" ${checked ? 'checked' : ''} style="width:auto;margin-top:3px" ${onAction('change', 'adoptWebChanged')}>
      <span>No Telegram for now <span class="sub">— talk to it in the web console; a bot can be attached later</span></span>
    </label>`;
  if (bot) {
    const busy = bot.enabledInSource || bot.polling === 'busy';
    if (busy && bot.channelOffInSource && bot.polling !== 'busy') {
      // Telegram is off for the whole instance, the account is not: switched
      // back on there, it polls this bot again (HB-1031).
      el.innerHTML =
        `<div style="border:1px solid var(--warn);border-radius:8px;padding:10px">
          <div>⚠ Telegram is switched off in your hand-built instance's config, but its account <b>“${esc(bot.accountId)}”</b> for “${esc(bot.sourceAgentId)}” is still on.</div>
          <div class="sub" style="margin-top:4px">Switched back on there, Telegram would poll this bot in both copies. Switch that account off too, then Inspect again:</div>
          ${accountOffHtml(bot.accountId)}
        </div>
        <div id="adoptBotChoice"><div class="sub" style="margin-top:8px">Or give this agent a different bot below.</div>
        ${adoptTokenField()}</div>${web(false)}`;
    } else if (busy) {
      // The old instance is still polling this bot — two pollers on one token
      // silently lose messages. Block reuse and show the hand-over steps.
      el.innerHTML =
        `<div style="border:1px solid var(--warn);border-radius:8px;padding:10px">
          <div>⚠ Its bot, Telegram account <b>“${esc(bot.accountId)}”</b>, is still live for “${esc(bot.sourceAgentId)}” in your hand-built instance.</div>
          <div class="sub" style="margin-top:4px">Hand the bot over first (two pollers on one token lose messages), then Inspect again:</div>
          ${accountOffHtml(bot.accountId, gatewayRestartCmd(bot))}
        </div>
        <div id="adoptBotChoice"><div class="sub" style="margin-top:8px">Or give this agent a different bot below.</div>
        ${adoptTokenField()}</div>${web(false)}`;
    } else {
      const n = (bot.allowFrom || []).length;
      el.innerHTML =
        `<div id="adoptBotChoice"><label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
          <input type="checkbox" id="adoptReuse" checked style="width:auto;margin-top:3px" ${onAction('change', 'hideWhenChecked', ["adoptTokenRow", { $: 'checked' }])}>
          <span>Take over its bot, Telegram account <b>“${esc(bot.accountId)}”</b> <span class="sub">(recommended — no new bot slot; ${n ? `${n} approved member${n === 1 ? '' : 's'} carried, no re-pairing` : 'same conversations kept'})</span></span>
        </label>
        <div id="adoptTokenRow" style="display:none;margin-top:8px">${adoptTokenField(true)}</div></div>${web(false)}`;
    }
  } else {
    el.innerHTML =
      `<div id="adoptBotChoice" hidden><div class="sub">This workspace has no bot of its own. The new agent gets one from your pool, or paste a BotFather token:</div>
       ${adoptTokenField()}</div>${web(true)}`;
  }
  adoptWebChanged();
}
function adoptWebChanged() {
  const web = !!$('adoptWeb')?.checked;
  const choice = $('adoptBotChoice');
  if (choice) choice.hidden = web;
}

function adoptTokenField(inner) {
  const field = `<input type="password" id="adoptToken" autocomplete="off" placeholder="BotFather token (optional if you have a pool bot)">`;
  return inner ? field : `<div style="margin-top:6px">${field}</div>`;
}

// The command that restarts OpenClaw's gateway on this machine, as Hatchabot's
// own hand-over runs it (HB-0981): the inspect's, built by the server as it
// runs it, with its unit's name from its own settings (HB-1282). From a
// server that sends none: its systemd unit on Linux; elsewhere (a Mac, whose
// launchd runs it), or the machine not known, OpenClaw's own command, which
// knows its service manager (HB-1163).
function gatewayRestartCmd(bot) {
  if (typeof bot?.restartCommand === 'string' && bot.restartCommand) return bot.restartCommand;
  return myAccount?.hostOs === 'linux' ? 'systemctl --user restart openclaw-gateway' : 'openclaw gateway restart';
}

// Fifteen minutes, as the CLI waits: an image to fetch or a busy machine
// takes longer than two, and an agent cut off then was removed mid-setup.
async function pollAgent(id, tries = 300) {
  let a;
  for (let i = 0; i < tries; i++) {
    a = await api(`/v1/agents/${id}`);
    if (a.state === 'RUNNING' || a.state === 'FAILED' || a.pendingAction) return a;
    await new Promise(r => setTimeout(r, 3000));
  }
  // `settingUp`: not yet running when the wait ran out, in whatever state
  // (setting up, rebuilding, stopped), as the CLI's StillWaiting: after a
  // hand-over it is left to finish, not removed.
  throw Object.assign(new Error('Timed out waiting for the agent to come up.'), { settingUp: true, state: a?.state });
}

// Hands a bot over to a waiting agent (adopt, and the paste-a-token box).
// "Telegram did not answer" (502–504), or no answer at all (the fetch failed,
// a TypeError), says nothing of the token: the same post goes again after 2,
// 4 and 8 seconds, by the CLI's rule (its noAnswer). One the server took
// already is answered 202 again.
function noAnswer(e) {
  if (typeof e?.status === 'number') return e.status >= 502 && e.status <= 504;
  return e instanceof TypeError;
}
// How long the server may take over one hand-over post before the step shows
// answered (HB-1427): a workspace's bot is looked at first (5 s, adopt.ts
// POLL_STATE_DEADLINE_MS), its token checked with Telegram (10 s,
// telegramManual.ts VERIFY_DEADLINE_MS), and a margin for the post's way
// there. The CLI's HANDOVER_POST_BOUND_MS is the same.
const HANDOVER_POST_BOUND_MS = 20000;
async function handOverBot(id, body, say) {
  let resent = false;
  // When the last post was sent: its bound is counted from then.
  let sentAt = 0;
  // A post that may have been taken: the agent is read, as the CLI does. Only
  // a step still open makes `e` the answer; one answered, it was handed over.
  // Not read either, whether it was taken is not known: marked, so an adopt
  // keeps the agent rather than removing it with a bot it may hold (HB-1277).
  // Gone (404), it was removed meanwhile: nothing to keep, and none to remove.
  // `again`: `e` is a 409 to a post sent again after no answer, which an
  // earlier post that landed brings: said so (HB-1277 review). Still open
  // within the server's bound on a post, it is read again once that is out:
  // one still being checked with Telegram could take the bot after the read,
  // and the agent was removed with the token it held (HB-1427).
  const takenOrNot = async (e, again = false) => {
    const read = () => api(`/v1/agents/${id}`).catch((r) => {
      if (r.status === 404) throw Object.assign(new Error(`The agent is gone (${r.message}): it was removed while its bot was being handed over.`), { agentGone: r.message });
      const refused = `sent again after no answer, it was refused: ${e.message}`;
      // For an adopt's words (doAdopt), and for the paste-a-token box's, which name no agent.
      const what = again ? `an earlier hand-over of its bot may have gone through (${refused})` : `the hand-over of its bot may not have gone through (${e.message})`;
      const box = again ? `An earlier bot hand-over may have gone through (${refused})` : `The bot hand-over may not have gone through (${e.message})`;
      throw Object.assign(new Error(`${box}, and the agent could not be read after that (${r.message}), so whether it took the bot is not known. If it still asks for a bot token in a moment, give it the token again.`), { handOverUnknown: { what, read: r.message } });
    });
    const open = (a) => a.pendingAction && a.state !== 'RUNNING' && a.state !== 'FAILED';
    let a = await read();
    const left = sentAt + HANDOVER_POST_BOUND_MS - Date.now();
    if (open(a) && left > 0) {
      say(`Waiting ${Math.ceil(left / 1000)} s for the server to finish with the bot hand-over…`);
      await new Promise(r => setTimeout(r, left));
      a = await read();
    }
    if (open(a)) throw e;
    return {};
  };
  for (const wait of [2000, 4000, 8000, null]) {
    sentAt = Date.now();
    try { return await api(`/v1/agents/${id}/channel-token`, { method: 'POST', body }); }
    catch (e) {
      // Sent again after no answer, and refused for the agent's state ("A bot
      // token came in already"): the first may have been taken, and setup
      // may hold it now.
      if (resent && e.status === 409) return takenOrNot(e, true);
      // The last post got no answer either: any of them may have been taken,
      // and in a batch adopt the old account is off already, so removing the
      // agent took the bot offline (HB-1277).
      if (wait === null && noAnswer(e)) return takenOrNot(e);
      if (wait === null || !noAnswer(e)) throw e;
      say(`${e.message} Trying again in ${wait / 1000} s…`);
      await new Promise(r => setTimeout(r, wait));
      resent = true;
    }
  }
}

// Shared core: create the agent, resolve its bot (reuse / token / pool), copy
// the workspace in, and clean up the half-made agent on any failure — exactly
// as the CLI does. Used by both the single (manual) and batch flows.
async function doAdopt({ path, name, reuse, web, token, bot, onStatus }) {
  const say = onStatus || (() => {});
  const localHost = hosts.find(h => h.kind === 'local') ?? hosts[0];
  if (!localHost) throw new Error('No host is configured on this server.');
  if (!profiles[0]) throw new Error('Add an AI source first: ⚙ Settings → AI sources.');
  let created = null;
  // The bot went to the agent (the channel-token post was answered).
  let gaveBot = false;
  // Kept on its bot: what a delete of it then does, and, its account off in OpenClaw, what not to do.
  // Parked, a hand-over of that bot is refused (both ways here skip the pool, so the token is
  // handed over); the CLI's adopt without --reuse-bot leases from the pool instead. Taken out
  // of the pool first is true of both (review).
  const PARKED = 'the bot is parked in your Bot pool (⚙ Settings → Messaging → Telegram), so remove it from there before adopting again.';
  const notOnAgain = (may) => (reuse ? ` Don’t switch the bot’s account back on in OpenClaw while this agent ${may ? 'may hold' : 'holds'} it: once it runs, both would poll it, and messages would be lost.` : '');
  // A look at the agent after the hand-over that failed (the network, the
  // server) says nothing of the agent: marked, so it is not taken for a
  // failed setup (HB-1092). Its own wait running out says so already (settingUp).
  const afterHandOver = (id) => pollAgent(id).catch((e) => { throw e.settingUp ? e : Object.assign(e, { unread: true }); });
  try {
    say('Creating the agent…');
    created = await api('/v1/agents', { method: 'POST', body: {
      name,
      aiProfileId: (profiles.length > 1 && $('adoptProfile').value) || profiles[0].id,
      hostId: localHost.id,
      ...(web ? { telegram: false } : {}),
      // Reusing its bot, or a token pasted: no pool bot, or the agent came up
      // on that one and the bot asked for was never given it (HB-0542, as the
      // CLI does; HB-1144 for a pasted token).
      ...((reuse || token) && !web ? { skipPool: true } : {}),
      ...(reuse && !web && bot?.allowFrom?.length ? { seedMembers: bot.allowFrom } : {}),
    }});
    let a = await pollAgent(created.id);
    if ((reuse || token) && !web && a.pendingAction?.type !== 'bot_token' && a.state !== 'FAILED') {
      throw new Error(`“${name}” did not wait for a bot${a.botUsername ? ` (it has @${a.botUsername})` : ''}, so ${reuse ? `${adoptBotName(bot)} was not taken over` : 'the token you pasted was not used'}.`);
    }
    const handedOver = a.pendingAction?.type === 'bot_token' && (reuse || !!token);
    if (a.pendingAction?.type === 'bot_token') {
      if (reuse) {
        say(`Taking over ${adoptBotName(bot)}…`);
        await handOverBot(a.id, { fromWorkspace: path }, say);
        gaveBot = true;
        a = await afterHandOver(a.id);
      } else if (token) {
        say('Connecting the bot…');
        await handOverBot(a.id, { token }, say);
        gaveBot = true;
        a = await afterHandOver(a.id);
      } else if (bot) {
        // Has a bot but reuse wasn't offered — it's still live in OpenClaw.
        throw new Error(
          `${adoptBotName(bot, true)} is still being polled by OpenClaw, so it can't be taken over yet. ` +
          `Disable it there AND restart the gateway (${accountOffWords(bot.accountId)} ; ${gatewayRestartCmd(bot)}), ` +
          `then try again. Or paste a different BotFather token.`,
        );
      } else {
        throw new Error('This agent needs a bot: paste a BotFather token, set up a bot pool, or tick "No Telegram for now".');
      }
    }
    // Its bot handed over, then it failed: kept, as a copy that fails then is
    // (HB-1225). Removed, it took the bot it had just been given offline, and
    // the token setup holds for a Retry with it. One asking for a bot again
    // (below) turned the token down: it has no bot, and is removed.
    if (a.state === 'FAILED' && gaveBot) {
      // Removed now, nothing is parked (a failed setup let its bot's row go), and an adopt
      // again takes the bot; a Retry runs it with nothing copied in, and removed after that,
      // the bot is parked in the pool, which a hand-over refuses (HB-1276 review). One whose
      // setup's undoing could not remove its container still holds its bot's row: removed
      // now, it parks the bot too, and the adopt again was refused it (HB-1426).
      const finish = a.botUsername
        ? `To finish the adopt, remove it and adopt again: it still holds @${a.botUsername}, so once it is removed, ${PARKED} A Retry instead brings the bot back up on an agent with nothing copied from the old one.`
        : `To finish the adopt, remove it and adopt again. A Retry brings the bot back up on an agent with nothing copied from the old one; removed after that, ${PARKED}`;
      throw Object.assign(new Error(`“${name}” has its bot, but could not start (${a.stateReason ?? 'no reason given'}), so it was kept with its bot, and nothing was copied. ${finish}${notOnAgain(false)}`), { kept: true });
    }
    if (a.state === 'FAILED') throw new Error(`Could not start: ${a.stateReason ?? 'unknown'}`);
    // After a bot is handed over the workspace goes only into a running agent:
    // one asking for a bot again turned the token down (HB-0542).
    if (handedOver && a.state !== 'RUNNING') {
      throw new Error(`${reuse ? `${adoptBotName(bot, true)} was not taken over: ` : ''}“${name}” is ${a.state}${a.pendingAction ? ' and waiting for a bot token' : ''}, so nothing was copied.`);
    }
    say('Copying the workspace…');
    // Its bot handed over, a copy that failed, however (no answer, the agent
    // busy, the machine: a stop not confirmed, its volume gone, a copy torn
    // partway, all answered 400), is marked, so the agent is kept on that bot
    // (HB-1092). Removed, it took the bot it had just been given offline.
    const res = await api(`/v1/agents/${a.id}/adopt-workspace`, { method: 'POST', body: { path } })
      .catch((e) => { throw gaveBot ? Object.assign(e, { notCopied: true }) : e; });
    return { res, agentId: a.id, name, workspace: path };
  } catch (e) {
    // Cut off by the wait before anything was handed over: removed, as the
    // CLI does, whichever way it was to get its bot (made to wait for one
    // that never came, it would never run). Left only after a hand-over.
    if (created && e.settingUp && !gaveBot) {
      const before = web ? '' : reuse ? `, before ${adoptBotName(bot)} was handed over` : token ? ', before its bot token was handed over' : '';
      try { await api(`/v1/agents/${created.id}`, { method: 'DELETE' }); }
      catch (d) {
        throw new Error(`“${name}” was still setting up after 15 minutes${before}, and nothing was copied. It could not be removed: ${d.message} Remove it from its card, then adopt again.`);
      }
      throw new Error(`“${name}” was still setting up after 15 minutes${before}, so it was removed and nothing was copied. Adopt again.`);
    }
    // Still setting up after the wait, its bot handed over: left to finish
    // rather than removed mid-setup, and said so.
    if (created && e.settingUp) {
      const now = e.state && e.state !== 'PROVISIONING' ? ` (it is ${String(e.state).toLowerCase()})` : '';
      throw new Error(`“${name}” is still setting up after 15 minutes${now}, so it was left to finish, and nothing was copied. Once it runs, remove it and adopt again.`);
    }
    // Copied in whole, but it could not be started (HB-0980 review): the adopt
    // is done, on its bot or not, so the agent is kept, stopped, to start once
    // its machine answers. Before the checks below, which say nothing was copied.
    if (created && e.code === 'adopt-not-started') throw new Error(`${e.message} “${name}” is kept, with every file copied in.`);
    // Its bot handed over, then it could not be read: its setup goes on, on
    // that bot. Left to finish, as after the wait: removed, it took the bot it
    // had just been given offline with it (HB-1092).
    if (created && gaveBot && e.unread) {
      throw new Error(`“${name}” has its bot, but could not be read just now (${e.message}), so it was left to finish setting up, and nothing was copied. Once it runs, remove it and adopt again.`);
    }
    // On its bot, and the copy failed: kept, for the same reason. What the
    // copy left is the server's to say (nothing copied, or left stopped).
    if (created && gaveBot && e.notCopied) {
      throw new Error(`“${name}” has its bot, but its workspace could not be copied (${e.message}), so it was kept with its bot. Remove it and adopt again.`);
    }
    // Failed after the hand-over: kept, and said (above).
    if (created && gaveBot && e.kept) throw e;
    // Gone at the read after its hand-over (handOverBot): not kept, as it is
    // not there, and no delete is sent (HB-1277 review).
    if (created && e.agentGone) throw new Error(`“${name}” is gone (${e.agentGone}): it was removed while its bot was being handed over, so nothing was copied, and there is nothing to remove. Adopt again.`);
    // Its hand-over may have gone through, and the agent could not be read
    // to say (handOverBot): kept, as one on its bot is, and said (HB-1277).
    if (created && e.handOverUnknown) {
      const { what, read } = e.handOverUnknown;
      throw new Error(`“${name}” was kept, and nothing was copied: ${what}, and it could not be read after that (${read}), so whether it has its bot is not known. Look at its card: if it still asks for a bot token, remove it and adopt again. Removed once it runs on that bot, ${PARKED}${notOnAgain(true)}`);
    }
    // A half-made agent holds the name, so a retry would collide — clean it up.
    let removed = false;
    if (created) { try { await api(`/v1/agents/${created.id}`, { method: 'DELETE' }); removed = true; } catch {} }
    // Its copy torn part way, the adopt was held on it (HB-0980): a Delete goes
    // through that, so say which way it ended rather than the hold's choices.
    if (created && e.code === 'adopt-held') {
      throw new Error(removed
        ? `Copying the workspace into “${name}” failed part way (${e.detail || 'no reason given'}), so “${name}” was removed and nothing was adopted. Fix the cause and adopt again.`
        : `${e.message} “${name}” could not be removed just now: choose on its page, or delete it from its card.`);
    }
    throw e;
  }
}

/**
 * Adopt's scheduled tasks put off until the agent runs (into a stopped agent,
 * or one another operation held just then): its answer's `deferred`, which
 * nothing said (HB-1475). The CLI says the same after "adopted N files".
 */
function adoptTasksLater(c) {
  const n = c?.deferred || 0;
  return n ? `${n} scheduled task${n > 1 ? 's' : ''} will be carried, disabled, once it is running` : '';
}

/**
 * Adopt's scheduled tasks said as carried: the answer's `carried` counts the
 * ones changed in the old workspace too (their copies are there), which are
 * said apart, as not brought (HB-1200 review).
 */
function adoptTasksCarried(c) {
  return Math.max(0, (c?.carried || 0) - (c?.changed || 0));
}

/**
 * Adopt's scheduled tasks carried before, whose copies are still there, and
 * edited in the old workspace since: not brought again, and said (HB-1200).
 * The CLI says the same after "adopted N files".
 */
function adoptTasksChanged(c) {
  const n = c?.changed || 0;
  return n ? `${n} task${n > 1 ? 's' : ''} changed in the old workspace since ${n > 1 ? 'they were' : 'it was'} carried — not brought` : '';
}

/** Adopt's scheduled tasks that did not come across, said: unread ones read as none (review of 2026-10-22). */
function adoptTasksMissed(c) {
  if (!c) return '';
  const parts = [];
  if (c.failed) parts.push(`${c.failed} scheduled task${c.failed > 1 ? 's' : ''} could not be carried`);
  if (c.error) parts.push(`its scheduled tasks were not all read: ${c.error}`);
  return parts.length ? ` · ${parts.join('; ')}.` : '';
}

// After adopting, an agent may reference data folders that live outside its
// workspace — invisible inside the container. Detect them and offer to share
// them read-only, bound at their original path so existing references resolve.
async function offerFolders(items) {
  const finds = [];
  for (const it of items) {
    try {
      const { candidates } = await api('/v1/workspaces/scan-paths', { method: 'POST', body: { path: it.workspace } });
      for (const p of (candidates || [])) finds.push({ agentId: it.agentId, name: it.name, path: p });
    } catch { /* scan is best-effort */ }
  }
  if (!finds.length) return;
  const lines = finds.map(f => `  • ${f.path}  →  ${f.name}`).join('\n');
  if (!confirm(`These agents read folders outside their workspace:\n\n${lines}\n\nShare them read-only (mounted at their original path) so the agents can still reach them — each is rebuilt now, which stops whatever it is doing? You can change this in ⚙ Configuration later.`)) return;
  const toRebuild = new Set();
  for (const f of finds) {
    try {
      await api(`/v1/agents/${f.agentId}/data-sources`, { method: 'POST', body: { kind: 'folder', access: 'ro', path: f.path, atHostPath: true } });
      toRebuild.add(f.agentId);
    } catch (e) { toast(`Couldn't share ${f.path}: ${e.message}`, 12000); }
  }
  // stoppedWaits: one that is not running stays so, and mounts them when it next starts.
  for (const id of toRebuild) { try { await api(`/v1/agents/${id}/rebuild`, { method: 'POST', body: { stoppedWaits: true } }); } catch { /* surfaced on card */ } }
  toast(`Shared ${finds.length} folder(s); ${toRebuild.size} agent(s) mount them on a rebuild, now if running, otherwise when next started.`, 15000);
  await refresh(true);
}

async function runAdopt() {
  if (!adoptInspected) { $('adoptErr').textContent = 'Inspect a workspace first.'; return; }
  const name = $('adoptName').value.trim();
  if (!name) { $('adoptErr').textContent = 'Give the agent a name.'; return; }
  $('adoptErr').textContent = '';
  $('adoptBtn').disabled = true;
  const set = m => { $('adoptErr').style.color = 'var(--dim)'; $('adoptErr').textContent = m; };
  try {
    const web = !!$('adoptWeb')?.checked;
    const { res, agentId, workspace } = await doAdopt({
      path: adoptInspected.path,
      name,
      web,
      reuse: !web && !!$('adoptReuse')?.checked,
      token: web ? '' : ($('adoptToken')?.value.trim() || ''),
      bot: adoptInspected.existingBot,
      onStatus: set,
    });
    adoptDlg.close();
    const later = adoptTasksLater(res.crons), changed = adoptTasksChanged(res.crons), carried = adoptTasksCarried(res.crons);
    const cronNote = (carried ? ` Carried ${carried} scheduled task${carried > 1 ? 's' : ''} (disabled — review and enable in its Tasks).` : '')
      + (later ? ` ${later}.` : '') + (changed ? ` ${changed}.` : '') + adoptTasksMissed(res.crons);
    toast(`Adopted ${res.files} files (${(res.bytes / 1e6).toFixed(1)} MB) into “${name}”.${cronNote}${web ? ' No Telegram: talk to it in the web console (click its icon).' : ''} The original is untouched — retire it when you're happy.`, 45000);
    await refresh(true);
    await offerFolders([{ agentId, name, workspace }]);
  } catch (e) {
    await refresh(false);
    $('adoptErr').style.color = '';
    $('adoptErr').textContent = e.message;
  } finally { $('adoptBtn').disabled = false; }
}
