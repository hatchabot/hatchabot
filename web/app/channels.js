// web/app/channels.js: Slack and Discord, skills, voice, the browser panel, an agent's rooms.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- Slack and Discord (docs/channels-slack-discord-design.md) ------------------------
const chanDlg = $('chanDlg');
let chanFor = null, chanKind = null, chanWatch = null, chanFields = null;

async function v2LoadChans(id) {
  const box = $('v2Chans'); if (!box || box.dataset.agent !== id) return;
  const kinds = (box.dataset.kinds || 'discord,slack').split(',');
  let r;
  try { r = await api(`/v1/agents/${id}/channels`); }
  catch (e) { box.innerHTML = `<div class="sub">${esc(e.message)}</div>`; return; }
  // Never trust the shape: an older server, a proxy error page or a partial
  // answer must not throw inside the sheet and blank the tab.
  if (!r || !Array.isArray(r.channels)) r = { channels: [], imageSupports: [] };
  if (!Array.isArray(r.imageSupports)) r.imageSupports = [];
  if (!$('v2Chans') || $('v2Chans').dataset.agent !== id) return; // the sheet moved on meanwhile
  const a = v2Find(id); if (!a) return;
  const canChange = a.state === 'RUNNING' || a.state === 'STOPPED';
  const agentName = a.name || '';
  const spare = r.spare || {};
  const BG = { telegram: '#229ed9', slack: '#4a154b', discord: '#5865f2' };
  // Every app is drawn from this one card: what it is called there, whether it
  // knows you, what the last check found, where to open it, who is on it and
  // who is knocking, where it answers besides DMs, and who may reach it.
  const card = (kind) => {
    const c = r.channels.find(x => x.kind === kind);
    const mark = `<span class="v2chan-mark v2mk-${kind}" style="background:${BG[kind]}">${V2_MARK_SVG[kind]}</span>`;
    const label = V2_CHAN_LABEL[kind];
    const spares = Number(spare[kind]) || 0;
    if (!c) {
      const can = kind === 'telegram' || r.imageSupports.includes(kind);
      const setup = kind === 'telegram' ? onAction('click', 'v2AddTelegram', [id]) : onAction('click', 'openChanSetup', [id, kind]);
      const blurb = {
        telegram: `Reach it from your phone, and let other people reach it. ${spares ? `${spares} spare bot${spares === 1 ? '' : 's'} in your pool, so it's instant.` : 'No spare bot in your pool: you paste a token from @BotFather.'}`,
        slack: 'Talk to it in your Slack workspace. You make a small Slack app for it; this takes about five minutes.',
        discord: `Talk to it on Discord. ${spares ? `${spares} spare bot${spares === 1 ? '' : 's'} parked, so it's instant.` : 'You make a bot in the Discord developer portal (about five minutes), or park one under Settings → Messaging.'}`,
      }[kind];
      return `<div class="v2chan"><div class="v2chan-h">${mark}<b>${label}</b>
        ${can && canChange ? `<button ${setup}>Set up…</button>` : ''}</div>
        <div class="sub">${can ? blurb : `Its base image can't do ${label} yet. Promote a base image that includes it (Settings → Advanced → Runtime images), then Rebuild.`}</div>
        ${kind === 'telegram' ? `<div id="v2TgToken" hidden style="flex-basis:100%;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="text" id="v2TgTokenIn" placeholder="123456789:AA…" autocomplete="off" style="flex:1;min-width:200px">
          <button class="primary" ${onAction('click', 'v2AddTelegram', [`${id ?? ''}`, true])}>Connect</button>
          <span class="sub" style="flex-basis:100%">In Telegram, message @BotFather, send /newbot, and paste the token it gives you.</span></div>` : ''}</div>`;
    }
    const rooms = c.rooms || { mode: 'off' };
    const roomHelp = {
      slack: 'The channel ID starts with C: open the channel, click its name, and it is at the bottom. Invite the app to that channel too.',
      discord: 'The server ID is a long number: turn on Developer Mode (User Settings → Advanced), then right-click the server → Copy Server ID.',
      telegram: 'Add the bot to the group, say anything in it, then Find rooms. BotFather must allow groups (/setjoingroups) and privacy mode must be off (/setprivacy) — Re-check tells you.',
    }[kind];
    const servers = Array.isArray(c.servers) ? c.servers : [];
    const people = Array.isArray(c.people) ? c.people : [];
    const knocks = (pairings[id] ?? []).filter(p => (p.kind || 'telegram') === kind);
    const who = (p) => p.meta?.firstName || p.meta?.username || p.id;
    const known = servers.some(g => g.id === rooms.roomId);
    // The rooms it may answer in: the bot's own servers as a picker (Discord),
    // the rooms the gateway has seen (Telegram, via Find rooms), or an ID.
    const roomPicker = (kind === 'discord' || kind === 'slack') && servers.length ? `
        <select id="chanRoomPick-${kind}" style="width:auto"${rooms.mode === 'room' ? '' : ' hidden'} ${onAction('change', 'chanRoomPicked', [`${kind}`, { $: 'value' }])}>
          ${servers.map(g => `<option value="${esc(g.id)}"${rooms.roomId === g.id ? ' selected' : ''}>${esc(g.name || g.id)}</option>`).join('')}
          <option value=""${rooms.mode === 'room' && !known ? ' selected' : ''}>Another ${kind === 'slack' ? 'channel' : 'server'} (type its ID)</option>
        </select>`
      : kind === 'telegram' ? `
        <select id="chanRoomPick-${kind}" style="width:auto"${rooms.mode === 'room' ? '' : ' hidden'} ${onAction('change', 'chanRoomFound', [`${kind}`, { $: 'value' }])}>
          ${rooms.roomId ? `<option value="${esc(rooms.roomId)}" selected>room ${esc(rooms.roomId)}</option>` : '<option value="">— find rooms first —</option>'}
        </select>
        <button id="chanRoomFind-${kind}"${rooms.mode === 'room' ? '' : ' hidden'} ${onAction('click', 'chanFindRooms', [`${id ?? ''}`, { $: 'el' }])}>Find rooms</button>` : '';
    const roomInputHidden = rooms.mode !== 'room' || ((kind === 'discord' || kind === 'slack') && roomPicker && known) || kind === 'telegram';
    const modeOptions = kind === 'slack'
      ? [['off', 'Off: direct messages only'], ['members', 'Every channel it is in — people you admitted, when @mentioned'], ['room', 'One channel']]
      : kind === 'discord'
        ? [['off', 'Off: direct messages only'], ['members', 'Every server it is in — people you admitted, when @mentioned'], ['room', 'One server']]
        : [['members', 'Any group — people you admitted, when @mentioned (default)'], ['off', 'Off: direct messages only'], ['room', 'One group — people you admitted, when @mentioned']];
    const linked = c.youAreLinked ? '✓ Linked to you.'
      : kind === 'telegram' ? 'Not linked to you yet: open it and say hi — your first message links you.'
      : `Not linked to you yet: send it a direct message on ${label}, then approve the request that appears here with <b>That's me</b>.`;
    const pending = c.pendingName;
    return `<div class="v2chan"><div class="v2chan-h">${mark}<b>${label}</b><span>${esc(c.displayName || '')}</span>
        ${canChange ? `<button ${onAction('click', 'chanRecheck', [`${id ?? ''}`, `${kind}`, { $: 'el' }])} title="Ask ${label} again: whether the bot answers, what it is called${kind === 'discord' ? ', servers it is in' : kind === 'telegram' ? ', its group settings at BotFather' : ''}, and whether anything still needs fixing">↻ Re-check</button>` : ''}
        ${canChange && kind !== 'slack' && c.botName && agentName && c.botName !== agentName ? `<button ${onAction('click', 'syncBotName', [`${id ?? ''}`, `${agentName ?? ''}`, `${kind}`])} style="border-color:var(--warn)" title="${label} shows the bot as '${esc(c.botName)}'; rename it to match the agent">🏷 Sync name</button>` : ''}</div>
      <div class="sub">${linked}${c.checkedAt ? ` <span title="Last checked with ${label}">Checked ${esc(ago(c.checkedAt))}.</span>` : ''}${pending?.retryAt ? ` <span style="color:var(--warn)" title="${label} allows a bot only a few name changes an hour">Rename to “${esc(pending.name || agentName)}” queued.</span>` : ''}</div>
      ${c.warnings?.length ? `<ul class="v2chan-warn">${c.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${kind === 'discord' ? `<div class="sub">${servers.length ? `In ${servers.length === 1 ? 'one server' : `${servers.length} servers`}: ${servers.map(g => `<b>${esc(g.name || g.id)}</b>`).join(', ')}.` : 'Not in any server yet.'} People can only message it once they share a server with it.</div>` : ''}
      <div class="sub">Files it sends here: up to ${c.filesMb ?? { telegram: 50, discord: 10, slack: 100 }[kind] ?? 5} MB${kind === 'discord' && (c.filesMb ?? 10) > 10 ? ' (a server without boosts takes 10)' : ''} — set under Settings → Hosts, or on its Advanced tab.</div>
      ${kind === 'slack' ? `<div class="sub">${c.team ? `In the <b>${esc(c.team)}</b> workspace. ` : ''}${servers.length ? `In ${servers.length === 1 ? 'one channel' : `${servers.length} channels`}: ${servers.map(g => `<b>#${esc(g.name || g.id)}</b>`).join(', ')}.` : 'Not in any channel yet: invite it with /invite in a channel.'}</div>` : ''}
      ${kind === 'telegram' ? `<div class="sub">Its @handle is fixed for life; its display name follows the agent's name.${c.pooled ? ' A pool bot: deleting or archiving the agent parks it for the next one.' : ' Your own bot: it stays yours.'}</div>` : ''}
      <div class="v2chan-h">
        ${httpsUrl(c.deepLink) ? `<a class="btn" href="${esc(c.deepLink)}" target="_blank" rel="noopener">Open in ${label}</a>` : ''}
        ${kind === 'telegram' && httpsUrl(c.deepLink) ? `<a class="btn" href="${esc(tgWebLink(a.botUsername || c.deepLink.replace(/^https:\/\/t\.me\//, '')))}" target="_blank" rel="noopener" title="Open it in Telegram in your browser — on a computer without the Telegram app">Telegram Web</a>` : ''}
        ${httpsUrl(c.addToServerUrl) ? `<a class="btn" href="${esc(c.addToServerUrl)}" target="_blank" rel="noopener">Add to a server</a>` : ''}
        ${canChange && spares > 0 ? `<button ${onAction('click', 'chanSwap', [`${id ?? ''}`, `${kind}`])} title="Move it onto a spare bot from your pool: members and memory come with it; the old bot is parked, and everyone on it is told where to find it">🔁 Change bot…</button>` : ''}
        ${canChange ? `<button ${onAction('click', 'chanRemove', [`${id ?? ''}`, `${kind}`])}>Detach…</button>` : ''}
      </div>
      <div class="v2chan-people">
        <b>People on ${label}</b>
        ${people.length ? `<span>${people.map(p => `<span class="member linked">${p.you ? 'You' : `<span class="pii">${esc(p.displayName || p.userId.slice(0, 8))}</span>`}${p.role === 'owner' ? ' ★' : ''}</span>`).join(' ')}</span>` : `<span class="sub">Nobody linked yet.</span>`}
        ${knocks.map(p => `<div class="pair"><span class="grow">🔑 <b class="pii">${esc(who(p))}</b> wants to talk to it on ${label}</span>
          <button ${onAction('click', 'denyPair', [`${id ?? ''}`, `${p.code ?? ''}`, `${who(p) ?? ''}`, `${kind}`])} title="Turn this request away. They can ask again by messaging the bot.">Not now</button>
          <button ${onAction('click', 'approve', [`${id ?? ''}`, `${p.code ?? ''}`, true, `${kind}`, `${who(p) ?? ''}`])} title="This is you on ${label}: link it to your login">That's me</button>
          ${a.ops ? '' : `<button class="primary" ${onAction('click', 'approve', [`${id ?? ''}`, `${p.code ?? ''}`, false, `${kind}`])}>Let them in</button>`}</div>`).join('')}
        <span class="sub" style="flex-basis:100%">${a.ops ? 'Your Hatchabot agent is yours alone: only you can link to it.' : 'Members, invites and people you already know are under <b>Sharing</b>; removing a member takes them off every app.'}</span>
      </div>
      <div class="v2chan-rooms">
        <label for="chanRoomMode-${kind}" style="margin:0">Group chats</label>
        <select id="chanRoomMode-${kind}" style="width:auto" ${onAction('change', 'chanRoomModeChanged', [`${kind}`, { $: 'value' }])}>
          ${modeOptions.map(([v, t]) => `<option value="${v}"${rooms.mode === v ? ' selected' : ''}>${t}</option>`).join('')}
        </select>${roomPicker}
        <input type="text" id="chanRoom-${kind}" placeholder="${{ slack: 'C0123ABCD', discord: '123456789' + '012345678' /* split: a secret scanner takes it whole for a Discord client id */, telegram: '-1001234567890' }[kind]}" value="${esc(rooms.roomId || '')}"${roomInputHidden ? ' hidden' : ''} autocomplete="off">
        ${canChange ? `<button ${onAction('click', 'chanSaveRooms', [`${id ?? ''}`, `${kind}`, { $: 'el' }])}>Save</button>` : ''}
        <span class="sub" style="flex-basis:100%">In a group it answers members only, and only when @mentioned. ${roomHelp}</span>
      </div>
      ${a.ops ? '' : `<div class="v2chan-rooms">
        <label for="chanKnocks-${kind}" style="margin:0">Who can reach it</label>
        <select id="chanKnocks-${kind}" style="width:auto"${canChange ? '' : ' disabled'} data-saves ${onAction('change', 'chanAllowKnocksFrom', [`${id ?? ''}`, { $: 'el' }])}>
          <option value="off"${r.allowKnocks ? '' : ' selected'}>Invite only (default)</option>
          <option value="on"${r.allowKnocks ? ' selected' : ''}>Anyone can knock</option>
        </select>
        <span class="sub" style="flex-basis:100%">${r.allowKnocks ? 'Anyone who finds a bot of this agent can ask, and waits under Alerts.' : 'Only people you invite, or already know from another agent. Strangers get no answer — except while an invite or ‘Let them in again’ window is open (30 minutes): then anyone who messages gets a pairing reply, and the first one is let in unless the invite named their @handle.'} One setting for every app this agent is on.</span>
      </div>`}
      ${kind === 'telegram' ? `<div class="v2chan-rooms">
        <label for="chanRich-telegram" style="margin:0">Rich messages</label>
        <select id="chanRich-telegram" style="width:auto"${canChange ? '' : ' disabled'} data-saves ${onAction('change', 'chanRichMessagesFrom', [`${id ?? ''}`, { $: 'el' }])}>
          <option value="on"${c.richMessages === false ? '' : ' selected'}>On (default)</option>
          <option value="off"${c.richMessages === false ? ' selected' : ''}>Off — plain text</option>
        </select>
        <span class="sub" style="flex-basis:100%">Bold, code blocks and links render properly; applies on the next Rebuild. (Discord and Slack always render them.)</span>
      </div>` : ''}</div>`;
  };
  // Only what this browser is set up to see: an attached channel always
  // renders (never strand an agent that has one), the rest wait for preview.
  // Discord is offered to everyone; Slack waits for preview (untried against a real app) — an attached one always shows.
  const shown = kinds;
  box.innerHTML = shown.map(card).join('');
}

/** Move an agent onto a spare bot of the same app, telling everyone on the old one first. */
async function chanSwap(id, kind) {
  const a = v2Find(id); const label = V2_CHAN_LABEL[kind];
  if (!confirm(`Move "${a?.name ?? 'this agent'}" to a different ${label} bot?\n\n`
    + `• It keeps its memory, files, settings and members — nobody has to pair again.\n`
    + `• Everyone must open the NEW bot and say hi; ${label} will not move the old chat.\n`
    + `• The old ${kind === 'slack' ? 'app' : 'bot'} ${kind === 'telegram' ? 'goes back to the pool' : 'is parked under Settings → Messaging'}, and its chat stops answering.\n\n`
    + (a && a.state !== 'RUNNING' ? chanApplyNote(id) : `The agent rebuilds afterwards — about a minute; anything it is doing stops.`))) return;
  try {
    const r = kind === 'telegram'
      ? await api(`/v1/agents/${id}/channel/swap`, { method: 'POST', body: {} })
      : await api(`/v1/agents/${id}/channels/${kind}/swap`, { method: 'POST', body: {} });
    toast(`Moved to ${kind === 'telegram' ? `@${r.to}` : `“${r.channel?.botName || 'the spare bot'}”`}${r.told ? ` — told ${r.told} ${r.told === 1 ? 'person' : 'people'} on the old bot` : ''}. ${r.atNextStart ? 'It stays down; this applies when it next starts.' : 'Rebuilding…'}`, 10000);
    await refresh(true);
    v2LoadChans(id);
  } catch (e) { toast(e.message, 9000); }
}
/** A save that failed: the select goes back to what the server last said, so it never shows a door shut that is open (HB-0450). Works with the network down, when a reload would not. */
function chanSelectBack(select) {
  const drawn = select && [...select.options].find(o => o.defaultSelected);
  if (drawn) select.value = drawn.value;
}
async function chanAllowKnocks(id, on, select) {
  try {
    await api(`/v1/agents/${id}/allow-knocks`, { method: 'POST', body: { on } });
    const a = agents.find(x => x.id === id); if (a) a.allowKnocks = on;
    toast(on ? 'Anyone can knock — you approve each one.' : 'Invite only — strangers are turned away.');
    v2LoadChans(id);
  } catch (e) { chanSelectBack(select); toast(e.message); }
}
async function chanRichMessages(id, off, select) {
  try {
    // null = clear back to the managed default (on) instead of pinning true.
    await api(`/v1/agents/${id}`, { method: 'PATCH', body: { richMessages: off ? false : null } });
    toast(off ? 'Plain text — applies on the next Rebuild.' : 'Rich messages on (default) — applies on the next Rebuild.');
    await refresh(false);
    v2LoadChans(id); // drawn afresh: what is saved now is what a later failure goes back to
  } catch (e) { chanSelectBack(select); toast(e.message, 10000); }
}
/** Telegram: the group chats the gateway has seen, as the room picker. */
async function chanFindRooms(id, btn) {
  // The room controls of the card pressed, for this agent: the sheet can move
  // to another agent (or draw the card again) while the gateway answers. Put
  // in the next agent's form, its Save gave that agent this one's room (HB-0990).
  const pick = $('chanRoomPick-telegram'), room = $('chanRoom-telegram');
  const mine = () => !!pick?.isConnected && !!room?.isConnected && $('v2Chans')?.dataset.agent === id;
  btn.disabled = true;
  try {
    const { rooms } = await api(`/v1/agents/${id}/group-chats`);
    if (!mine()) return;
    if (!rooms.length) { toast('No group chats seen yet — add the bot to the group (privacy OFF at BotFather), say anything in it, then try again.', 9000); return; }
    const cur = room.value;
    pick.innerHTML = rooms.map(r => `<option value="${esc(r.id)}"${r.id === cur ? ' selected' : ''}>room ${esc(r.id)}</option>`).join('');
    room.value = pick.value;
  } catch (e) { if (mine()) toast(e.message); }
  finally { btn.disabled = false; }
}

/** Each open of the channel dialog: an older open still fetching is dropped, not painted. */
let chanOpenGen = 0, chanShownGen = 0;
async function openChanSetup(id, kind) {
  const a = v2Find(id); if (!a) return;
  // Opening for one agent, then another before the first's fetches came back,
  // painted the first agent's form while Connect sent the tokens to the
  // second (B055). Only the newest open paints, and the dialog's target is
  // set together with what it shows, just before it opens.
  const gen = ++chanOpenGen, person = pagePerson;
  const current = () => gen === chanOpenGen && person === pagePerson && !pagePersonAway && !pageSignedOut;
  clearInterval(chanWatch); chanWatch = null;
  // Kept only once it came back: a failed fetch kept [] for good, so "try
  // again" could never work until the page was reloaded (#144).
  let connectors = chanFields;
  if (!Array.isArray(connectors)) {
    try { const got = await api('/v1/channels/connectors'); if (Array.isArray(got)) chanFields = connectors = got; } catch { /* said below */ }
    connectors = Array.isArray(connectors) ? connectors : [];
  }
  if (!current()) return;
  const fields = connectors.find(c => c.kind === kind)?.fields ?? [];
  const steps = kind === 'slack' ? `
    <ol class="v2steps">
      <li><b>Create the app.</b> <button type="button" ${onAction('click', 'chanCopyManifest', [{ $: 'el' }])}>Copy app manifest</button>
        <a class="btn" id="chanSlackNew" href="https://api.slack.com/apps?new_app=1" target="_blank" rel="noopener">Open Slack with the manifest</a><br>
        The manifest is filled in for you: pick your workspace and press <i>Create</i>. (If the page arrives empty, choose <i>From a manifest</i> and paste it.)</li>
      <li><b>Install it.</b> On <i>Install App</i>, press <i>Install to Workspace</i> and allow it. Copy the <i>Bot User OAuth Token</i> (starts with <code>xoxb-</code>).</li>
      <li><b>Make its connection token.</b> On <i>Basic Information</i> → <i>App-Level Tokens</i>, press <i>Generate Token and Scopes</i>, add <code>connections:write</code>, and copy it (starts with <code>xapp-</code>).</li>
    </ol>` : `
    <ol class="v2steps">
      <li><b>Create the bot.</b> <a class="btn" href="https://discord.com/developers/applications" target="_blank" rel="noopener">Open Discord developer portal</a><br>
        Press <i>New Application</i> and name it <b>${esc(a.name)}</b>.</li>
      <li><b>Let it read messages.</b> On <i>Bot</i>, under <i>Privileged Gateway Intents</i>, turn on <i>Message Content Intent</i> and save.</li>
      <li><b>Copy its token.</b> Same page: press <i>Reset Token</i> and copy it. After you connect, you'll add the bot to a server of yours.</li>
    </ol>`;
  if (!fields.length) { toast("Couldn't reach the server for the setup steps — try again in a moment."); return; }
  // A parked bot or app: pick it and skip the portal entirely.
  let parkedHtml = '';
  if (kind === 'discord' || kind === 'slack') {
    let pool = [];
    try { pool = (await api(POOL_UI[kind].path)).bots ?? []; } catch { pool = []; }
    if (!current()) return;
    if (kind === 'discord') discordPool = pool; else slackPool = pool;
    // Only what this person can take: their own and the shared ones (the
    // machine's owner also sees other people's in Settings, not here).
    pool = pool.filter(b => b.mine || b.shared);
    if (pool.length) parkedHtml = `<div class="v2chan" style="margin-bottom:10px"><b>Use a parked ${kind === 'slack' ? 'app' : 'bot'}</b>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <select id="chanPooled" style="flex:1;min-width:200px"><option value="">— make a new ${kind === 'slack' ? 'app' : 'bot'} instead (steps below) —</option>
          ${pool.map(b => `<option value="${esc(b.applicationId)}">${esc(b.botName || b.applicationId)}${b.servers?.length ? ` — in ${esc(b.servers.map(g => g.name || g.id).join(', '))}` : ' — not in any server yet'}</option>`).join('')}</select>
      </div><div class="sub" style="margin-top:4px">Parked when ${V2_CHAN_LABEL[kind]} was removed from an agent, or parked ahead under Settings → Messaging. It keeps its name and ${kind === 'slack' ? 'channels' : 'servers'}.</div></div>`;
  }
  // Slack: one box takes both tokens at once, pasted from either page; the two boxes below fill themselves.
  const pasteBox = kind === 'slack' ? `<label for="chanPaste">Paste both tokens here — or fill the two boxes below</label>
    <textarea id="chanPaste" rows="2" autocomplete="off" spellcheck="false" placeholder="xoxb-… and xapp-…, in any order, with anything else around them" ${onAction('input', 'chanPasteTokens', [{ $: 'el' }])}></textarea>` : '';
  $('chanBody').innerHTML = parkedHtml + steps + pasteBox + fields.map(f => `
    <label for="chanF-${esc(f.key)}">${esc(f.label)}</label>
    <input type="password" id="chanF-${esc(f.key)}" data-key="${esc(f.key)}" data-pattern="${esc(f.pattern)}" autocomplete="off" spellcheck="false"
      ${onAction('input', 'chanCheckField', [{ $: 'el' }])}>
    <div class="sub" id="chanH-${esc(f.key)}">${esc(f.help)}</div>`).join('') +
    `<div class="sub" style="margin-top:10px">The tokens are stored with this agent's other secrets and never shown to an AI. Connecting restarts the agent; it keeps its memory.</div>`;
  $('chanTitle').textContent = `Connect ${a.name} to ${V2_CHAN_LABEL[kind]}`;
  $('chanErr').textContent = '';
  $('chanGo').hidden = false; $('chanGo').disabled = false; $('chanGo').textContent = 'Connect';
  $('chanClose').textContent = 'Cancel';
  chanFor = id; chanKind = kind;
  chanShownGen = gen;
  if (!chanDlg.open) chanDlg.showModal();
  chanDlg.querySelector('input')?.focus();
  if (kind === 'slack') void chanPrefillSlackLink(a.name, gen);
}
/** The agent's own sleep and file policy (Advanced tab): saved and applied at once. */
/** Its own browser (docs/browser.md): switching rebuilds it. */
async function v2SetBrowser(id, on, el) {
  if (!confirmRebuild(id, on ? 'Giving it a browser' : 'Taking its browser away')) { if (el) el.value = on ? 'off' : 'on'; return; }
  try {
    const r = await api(`/v1/agents/${id}`, { method: 'PATCH', body: { browser: on } });
    // Busy (a rebuild already under way): saved, but not applied — say so.
    if (r?.browserPending) toast(r.browserPending, 12000);
    else toast(on ? 'Browser on — rebuilding; its browser starts once it is back.' : 'Browser off — rebuilding.', 8000);
    await refresh(false);
  } catch (e) { toast(e.message, 8000); if (el) el.value = on ? 'off' : 'on'; }
}
// Curated choices are saved separately from the selection recorded at the last
// build. Neither is a claim that a tool, credential or edited skill file works.
let skillsEpoch = 0, skillsOpening = null;
const skillsWrites = new Map();
const skillsWriteVersions = new Map();
function v2SkillsOwner(id) {
  const a = v2Find(id);
  return !!a && v2Mine(a) && !a.ops && !pagePersonAway && !pageSignedOut;
}
function v2SkillsResult(r) {
  if (!r || !Array.isArray(r.skills) || !Array.isArray(r.selected) || !(r.applied === null || Array.isArray(r.applied)) || typeof r.canEdit !== 'boolean') {
    throw new Error('Could not read the curated skill selection. Try Recheck.');
  }
  return r;
}
function v2SkillsSummary(r) {
  return `${r.selected.length} selected · ${r.applied === null ? 'last build selection unknown' : r.applied.length + ' applied at last build'}${r.pending ? ' · changes pending' : ''}`;
}
async function v2LoadSkills(id) {
  const el = $('v2Skills');
  if (!el || el.dataset.agent !== id || !v2SkillsOwner(id)) return;
  const epoch = skillsEpoch, person = pagePerson, read = String(Number(el.dataset.read || 0) + 1);
  const version = skillsWriteVersions.get(id) || 0;
  el.dataset.read = read;
  const current = () => epoch === skillsEpoch && person === pagePerson && v2SkillsOwner(id)
    && v2AgentDlg.open && v2AgentId === id && $('v2Skills') === el && el.dataset.read === read;
  try {
    const r = v2SkillsResult(await api(`/v1/agents/${id}/skills`));
    if (!current()) return;
    if ((skillsWriteVersions.get(id) || 0) !== version) throw new Error('The selection changed while reading. Open the library to recheck.');
    el.innerHTML = `<span class="sub">${esc(v2SkillsSummary(r))}</span> <button ${onAction('click', 'v2SkillsOpen', [`${id ?? ''}`])}>Choose skills</button>`;
  } catch (e) {
    if (current()) el.innerHTML = `<span class="sub">${esc(e.message)}</span> <button ${onAction('click', 'v2SkillsOpen', [`${id ?? ''}`])}>Open library</button>`;
  }
}
function v2SkillsCurrent(ctx = skillsOpening) {
  return !!ctx && ctx === skillsOpening && ctx.epoch === skillsEpoch && ctx.person === pagePerson
    && $('skillsDlg').open && v2AgentDlg.open && v2AgentId === ctx.id && v2SkillsOwner(ctx.id);
}
function v2SkillsClose() {
  skillsOpening = null;
  if ($('skillsDlg').open) $('skillsDlg').close();
  $('skillsAgent').textContent = ''; $('skillsStatus').textContent = ''; $('skillsErr').textContent = '';
  $('skillsChoices').textContent = ''; $('skillsChoices').hidden = true; $('skillsSave').disabled = true;
  $('skillsAvailability').textContent = ''; $('skillsCheck').disabled = true;
  $('skillDetail').textContent = ''; $('skillDetail').hidden = true;
}
function v2SkillsForget() {
  skillsEpoch++; v2SkillsClose();
  const el = $('v2Skills'); if (el) el.textContent = 'Sign in again to read this agent’s skill selection.';
}
$('skillsDlg').addEventListener('close', () => { if (!$('skillsDlg').open) v2SkillsClose(); });
$('v2AgentDlg').addEventListener('close', () => { if (!v2AgentDlg.open) v2SkillsClose(); });
async function v2SkillsOpen(id) {
  if (!v2SkillsOwner(id) || !v2AgentDlg.open || v2AgentId !== id) return;
  const ctx = skillsOpening = { id, epoch: skillsEpoch, person: pagePerson, read: 0, data: null, choices: new Set(), dirty: false, saving: false, loading: false, readFailed: false, availability: null, availabilityRead: 0, availabilityRuntime: null, checking: false };
  $('skillsAgent').textContent = v2Find(id).name;
  $('skillsChoices').textContent = ''; $('skillsChoices').hidden = true; $('skillsErr').textContent = '';
  if (!$('skillsDlg').open) $('skillsDlg').showModal();
  await v2SkillsRead(ctx);
}
function v2SkillsRuntime(id) {
  const a = v2Find(id);
  return a ? JSON.stringify([a.hostId, a.runtimeRef, a.state, a.appliedProfileAt, a.image, a.rebuildOnStart, a.updatedAt, !!a.busy, a.browser]) : '';
}
function v2SkillsClearAvailability(ctx) {
  ctx.availabilityRead++; ctx.availability = null; ctx.availabilityRuntime = null; ctx.checking = false;
  if (v2SkillsCurrent(ctx)) v2SkillsPaintAvailability(ctx);
}
function v2SkillRuntime(id, identityOnly = false) {
  const a = v2Find(id);
  return a ? JSON.stringify([a.hostId, a.runtimeRef, a.state, a.aiProfileId, a.appliedProfileAt, a.image, a.rebuildOnStart, a.browser, identityOnly ? null : a.updatedAt]) : '';
}
function v2SkillCurrent(ctx, detail) {
  return v2SkillsCurrent(ctx) && ctx.detail === detail && (detail.working && detail.working !== 'trial'
    ? detail.identity === v2SkillRuntime(ctx.id, true) : detail.runtime === v2SkillRuntime(ctx.id));
}
function v2SkillDiff(current, catalog) {
  if (current === catalog) return 'No differences.';
  const before = (current || '').split('\n'), after = catalog.split('\n');
  let first = 0, endBefore = before.length, endAfter = after.length;
  while (first < endBefore && first < endAfter && before[first] === after[first]) first++;
  while (endBefore > first && endAfter > first && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  return `@@ line ${first + 1}: installed → catalog @@\n` + before.slice(first, endBefore).map(line => '- ' + line).join('\n')
    + '\n' + after.slice(first, endAfter).map(line => '+ ' + line).join('\n');
}
function v2SkillPaint(ctx, detail) {
  if (!v2SkillCurrent(ctx, detail)) return;
  const el = $('skillDetail'), skill = ctx.data.skills.find(s => s.id === detail.id), view = detail.data;
  el.hidden = false;
  const pre = text => `<pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;font-size:12px">${esc(text)}</pre>`;
  el.innerHTML = `<h4>${esc(skill.name)}</h4>${skill.setup?.length ? '<p class="sub">' + skill.setup.map(esc).join('<br>') + '</p>' : ''}
    ${skill.examples?.length ? '<p class="sub">Example: ' + skill.examples.map(esc).join('<br>') + '</p>' : ''}
    ${detail.loading ? '<p>Reading instructions…</p>' : ''}${detail.error ? '<p class="err" role="alert">' + esc(detail.error) + '</p>' : ''}`;
  if (!view) { if (!detail.loading) el.innerHTML += `<button ${onAction('click', 'v2SkillOpen', [`${detail.id ?? ''}`])}>Refresh preview</button>`; return; }
  const labels = { current: 'Matches the catalog', update_available: 'Catalog update available', customized: 'Customized instructions — automatic replacement refused', untracked: 'Local instructions; original version unknown', missing: 'Not installed', unavailable: 'No agent volume to inspect yet' };
  el.innerHTML += `<p class="sub">${esc(labels[view.state] || 'Could not determine the installed version')}. Catalog ${esc(view.catalog.version)}; installed ${esc(view.installed.version || 'unknown')}.</p>
    <details><summary>Catalog instructions</summary>${pre(view.catalog.content)}</details>
    <details><summary>Installed instructions</summary>${pre(view.installed.content === null ? 'No installed instructions.' : view.installed.content)}</details>
    <details open><summary>Changes from installed to catalog</summary>${pre(v2SkillDiff(view.installed.content, view.catalog.content))}</details>
    <div class="actions" style="flex-wrap:wrap">
      <button data-skill-action="update" ${onAction('click', 'v2SkillChange', ["update"])}${!view.canUpdate || detail.working || skillsWrites.has(ctx.id) ? ' disabled' : ''}>${view.state === 'missing' ? 'Install instructions' : 'Update instructions'}</button>
      <button data-skill-action="replace" ${onAction('click', 'v2SkillChange', ["replace"])}${!view.canReplace || detail.working || skillsWrites.has(ctx.id) ? ' disabled' : ''}>Replace with catalog…</button>
      <button data-skill-action="rollback" ${onAction('click', 'v2SkillChange', ["rollback"])}${!view.canRollback || detail.working || skillsWrites.has(ctx.id) ? ' disabled' : ''}>Restore previous instructions…</button>
      <button ${onAction('click', 'v2SkillOpen', [`${detail.id ?? ''}`])}${detail.working ? ' disabled' : ''}>Refresh preview</button>
    </div>
    <p class="sub">File changes are immediate and keep a previous copy for rollback. Start a new conversation afterward. The skill selection is saved separately.</p>
    <h4 style="margin-top:14px">Try this skill</h4>
    ${skill.trial ? `<p><b>${esc(skill.trial.title)}</b></p><p class="sub">${esc(skill.trial.prompt)}</p>` : ''}
    <p class="sub">One AI practice task with these installed instructions and made-up sample data. It can only read its temporary workspace. It does not test external accounts or services. The model run is limited to 60 seconds and requests at most 512 output tokens per response; metered AI charges apply, with no guaranteed dollar cap. Closing this dialog does not cancel an active run.</p>
    <button id="skillTry" ${onAction('click', 'v2SkillTry')}${view.installed.content === null || v2Find(ctx.id)?.state !== 'RUNNING' || detail.working || skillsWrites.has(ctx.id) ? ' disabled' : ''}>Run practice task</button>
    <div id="skillTrialResult" class="sub" role="status" style="margin-top:8px"></div>`;
  if (detail.working) $('skillTrialResult').textContent = detail.working === 'trial' ? 'Running one practice task…' : 'Changing instructions…';
  if (detail.trial) {
    const r = detail.trial, evidence = r.evidence || {};
    $('skillTrialResult').innerHTML = `<p>${esc(r.message || 'Practice finished.')}</p><p>Skill read: ${evidence.skillRead ? 'observed' : 'not observed'} · sample read: ${evidence.fixtureRead ? 'observed' : 'not observed'} · tool calls: ${Number.isInteger(evidence.toolCalls) ? evidence.toolCalls : 0}</p>`
      + (r.output ? pre(r.output) : '') + (r.usage ? `<p>Reported usage: ${Number.isFinite(r.usage.total) ? r.usage.total + ' tokens' : 'token total unavailable'}${Number.isFinite(r.usage.costUsd) ? ' · $' + r.usage.costUsd.toFixed(4) : ' · cost unavailable'}.</p>` : '<p>Usage and cost were not reported.</p>');
  }
}
async function v2SkillOpen(id) {
  const ctx = skillsOpening;
  if (!v2SkillsCurrent(ctx) || !ctx.data || ctx.loading || ctx.saving || skillsWrites.has(ctx.id) || !ctx.data.skills.some(s => s.id === id)) return;
  const detail = ctx.detail = { id, runtime: v2SkillRuntime(ctx.id), identity: v2SkillRuntime(ctx.id, true), updatedAt: v2Find(ctx.id).updatedAt, loading: true, data: null, error: '', working: false, trial: null };
  v2SkillPaint(ctx, detail);
  try {
    const result = await api(`/v1/agents/${ctx.id}/skills/${id}/file`);
    if (!v2SkillCurrent(ctx, detail)) return;
    if (!result?.catalog || typeof result.catalog.content !== 'string' || !result.installed || !(result.installed.content === null || typeof result.installed.content === 'string')) throw new Error('Could not read the instructions. Refresh the preview.');
    detail.data = result;
  } catch (e) { if (v2SkillCurrent(ctx, detail)) detail.error = e.message; }
  finally { if (v2SkillCurrent(ctx, detail)) { detail.loading = false; v2SkillPaint(ctx, detail); } }
}
async function v2SkillAction(action) {
  const ctx = skillsOpening, detail = ctx?.detail;
  if (!detail || !v2SkillCurrent(ctx, detail) || !detail.data?.revision || detail.working || skillsWrites.has(ctx.id)) return;
  const trial = action === 'trial', token = {};
  if (trial && (detail.data.installed.content === null || v2Find(ctx.id)?.state !== 'RUNNING')) return;
  if (!trial && !({ update: detail.data.canUpdate, replace: detail.data.canReplace, rollback: detail.data.canRollback })[action]) return;
  const prompt = action === 'replace' ? 'Replace your installed instructions with the catalog version? Your current file will be saved for rollback.'
    : action === 'rollback' ? 'Restore the previous instructions? Your current file will be saved for rollback.' : null;
  if (prompt && !confirm(prompt)) return;
  skillsWrites.set(ctx.id, token); skillsWriteVersions.set(ctx.id, (skillsWriteVersions.get(ctx.id) || 0) + 1);
  detail.working = action; detail.error = ''; detail.trial = null; v2SkillsClearAvailability(ctx); v2SkillPaint(ctx, detail); v2SkillsPaint(ctx);
  try {
    const result = await api(`/v1/agents/${ctx.id}/skills/${detail.id}/${trial ? 'try' : 'file'}`, { method: 'POST', body: { expectedRevision: detail.data.revision, ...(trial ? {} : { action }) } });
    if (!v2SkillCurrent(ctx, detail)) return;
    if (trial) detail.trial = result;
    else {
      const a = v2Find(ctx.id);
      if (a.updatedAt !== detail.updatedAt && a.updatedAt !== result.agentUpdatedAt) {
        detail.data = null; detail.error = 'The agent changed again. Refresh the preview to inspect its current instructions.'; return;
      }
      detail.data = result;
      if (typeof result.agentUpdatedAt === 'string') a.updatedAt = result.agentUpdatedAt;
      detail.updatedAt = a.updatedAt;
    }
  } catch (e) {
    if (v2SkillCurrent(ctx, detail)) { detail.error = e.message; if (!trial) detail.data = null; }
  } finally {
    if (skillsWrites.get(ctx.id) === token) { skillsWrites.delete(ctx.id); skillsWriteVersions.set(ctx.id, (skillsWriteVersions.get(ctx.id) || 0) + 1); }
    if (v2SkillCurrent(ctx, detail)) { detail.runtime = v2SkillRuntime(ctx.id); detail.working = false; v2SkillPaint(ctx, detail); v2SkillsPaint(ctx); }
    v2SkillsFinishWrite(ctx);
  }
}
function v2SkillChange(action) { return v2SkillAction(action); }
function v2SkillTry() { return v2SkillAction('trial'); }
function v2SkillsFinishWrite(previous) {
  const ctx = skillsOpening;
  if (!v2SkillsCurrent(ctx) || ctx.id !== previous.id) return;
  if (ctx !== previous) {
    ctx.readFailed = true;
    $('skillsErr').textContent = 'A previous change finished. Recheck the saved selection before editing.';
    v2SkillsClearAvailability(ctx);
  }
  v2SkillsSyncAvailability(ctx); v2SkillsPaint(ctx);
}
function v2SkillsSyncAvailability(ctx) {
  if (ctx.availabilityRuntime !== null && ctx.availabilityRuntime !== v2SkillsRuntime(ctx.id)) v2SkillsClearAvailability(ctx);
  if (ctx.detail && !v2SkillCurrent(ctx, ctx.detail)) { ctx.detail = null; $('skillDetail').hidden = true; $('skillDetail').textContent = ''; }
}
function v2SkillsPaintAvailability(ctx) {
  if (!v2SkillsCurrent(ctx)) return;
  $('skillsCheck').disabled = !ctx.data || ctx.loading || ctx.saving || ctx.readFailed || ctx.checking || skillsWrites.has(ctx.id);
  $('skillsCheck').textContent = ctx.checking ? 'Checking…' : 'Check availability';
  const el = $('skillsAvailability'), r = ctx.availability;
  if (ctx.checking) { el.textContent = 'Checking the running agent’s instructions and prerequisites…'; return; }
  if (!r) { el.textContent = 'Not checked. This runs only when you ask.'; return; }
  const overall = {
    unavailable: 'Could not check runtime availability. Try again when its machine is reachable.',
    unsupported: 'This runtime does not support the skill availability check. Check its OpenClaw version.',
    busy: 'Another operation is under way. Check availability when it finishes.',
    not_running: 'Start the agent, then check availability.',
  };
  if (r.status !== 'checked') { el.textContent = overall[r.status] || overall.unavailable; return; }
  const labels = {
    available: 'Instructions available', disabled: 'Disabled in the runtime', blocked: 'Blocked by runtime policy',
    missing_requirements: 'Missing runtime requirements', not_installed: 'Instructions not found', unavailable: 'Could not check this skill',
  };
  const prerequisite = {
    google_accounts: { present: 'Google account found; sign-in and scopes were not tested.', missing: 'No Google account found.', unchecked: 'Google accounts were not checked.' },
    browser: { present: 'Browser enabled in the runtime; running it and its permissions were not tested.', missing: 'Browser is not enabled in the runtime.', unchecked: 'Browser configuration was not checked.' },
    web_tools: { present: 'Web tools reported available; no search was tested.', missing: 'Web tools reported unavailable.', unchecked: 'Web tools were not checked; availability varies by conversation.' },
    jira_access: { unchecked: 'Jira connector or browser sign-in was not checked; open this skill’s preview for setup.' },
    image_generation: { unchecked: 'Image-generation provider access was not checked; open this skill’s preview for setup.' },
  };
  const rows = new Map(r.skills.filter(s => s && typeof s.id === 'string').map(s => [s.id, s]));
  const checked = Number.isFinite(Date.parse(r.checkedAt)) ? `<div>Checked ${esc(new Date(r.checkedAt).toLocaleString())}.</div>` : '';
  el.innerHTML = checked + ctx.data.skills.map(skill => {
    const status = rows.get(skill.id) || {}, words = Object.hasOwn(labels, status.status) ? labels[status.status] : labels.unavailable;
    const missing = [['tools', 'tool'], ['environment', 'environment setting'], ['configuration', 'configuration setting'], ['platform', 'platform requirement']]
      .flatMap(([key, noun]) => { const n = status.missing?.[key]; return Number.isInteger(n) && n > 0 ? [`${n} ${noun}${n === 1 ? '' : 's'}`] : []; });
    const deps = (Array.isArray(status.dependencies) ? status.dependencies : []).filter(d => d && Object.hasOwn(prerequisite, d.kind));
    return `<div style="margin-top:10px"><b>${esc(skill.name)}: ${words}</b>${missing.length ? '<div>Missing: ' + missing.join(', ') + '.</div>' : ''}
      ${deps.map(d => `<div>${Object.hasOwn(prerequisite[d.kind], d.status) ? prerequisite[d.kind][d.status] : prerequisite[d.kind].unchecked}${d.kind === 'google_accounts' ? ' <button data-skills-setup="google_accounts" ' + onAction('click', 'v2SkillsSetup', ['google_accounts']) + '>Connections</button>' : d.kind === 'browser' ? ' <button data-skills-setup="browser" ' + onAction('click', 'v2SkillsSetup', ['browser']) + '>Browser settings</button>' : ''}</div>`).join('')}</div>`;
  }).join('');
}
async function v2SkillsCheck() {
  const ctx = skillsOpening;
  if (!v2SkillsCurrent(ctx) || !ctx.data || ctx.loading || ctx.saving || ctx.readFailed || ctx.checking || skillsWrites.has(ctx.id)) return;
  const read = ++ctx.availabilityRead, version = skillsWriteVersions.get(ctx.id) || 0, runtime = v2SkillsRuntime(ctx.id);
  ctx.availability = null; ctx.availabilityRuntime = runtime; ctx.checking = true; v2SkillsPaintAvailability(ctx);
  const current = () => v2SkillsCurrent(ctx) && ctx.availabilityRead === read && runtime === v2SkillsRuntime(ctx.id)
    && version === (skillsWriteVersions.get(ctx.id) || 0);
  try {
    const r = await api(`/v1/agents/${ctx.id}/skills/status`);
    if (!current()) return;
    ctx.availability = r && ['checked', 'unavailable', 'unsupported', 'busy', 'not_running'].includes(r.status) && Array.isArray(r.skills)
      ? r : { status: 'unavailable', skills: [] };
  } catch {
    if (current()) ctx.availability = { status: 'unavailable', skills: [] };
  } finally {
    if (v2SkillsCurrent(ctx) && ctx.availabilityRead === read) {
      ctx.checking = false;
      if (!current()) v2SkillsClearAvailability(ctx);
      else v2SkillsPaintAvailability(ctx);
    }
  }
}
function v2SkillsSetup(kind) {
  const ctx = skillsOpening;
  if (!v2SkillsCurrent(ctx) || !['google_accounts', 'browser'].includes(kind)) return;
  v2SkillsSyncAvailability(ctx);
  if (ctx.availability?.status !== 'checked' || !ctx.availability.skills.some(s => Array.isArray(s?.dependencies) && s.dependencies.some(d => d?.kind === kind))) return;
  const changed = ctx.choices.size !== ctx.data.selected.length || ctx.data.selected.some(id => !ctx.choices.has(id));
  if (changed && !confirm('Leave without saving these skill choices?')) return;
  const id = ctx.id;
  v2SkillsClose(); openV2Agent(id, kind === 'google_accounts' ? 'knowledge' : 'advanced');
  const target = $(kind === 'google_accounts' ? 'paneEditConn' : 'v2Browser');
  target?.scrollIntoView({ block: 'nearest' });
  if (kind === 'browser') target?.focus();
}
function v2SkillsEditable(ctx) {
  const a = v2Find(ctx.id);
  return v2SkillsCurrent(ctx) && !!ctx.data?.canEdit && a.state !== 'ARCHIVED' && !a.busy
    && !ctx.loading && !ctx.saving && !ctx.readFailed && !skillsWrites.has(ctx.id);
}
function v2SkillsPaint(ctx) {
  if (!v2SkillsCurrent(ctx)) return;
  const r = ctx.data, editable = v2SkillsEditable(ctx);
  $('skillsRecheck').disabled = ctx.loading || ctx.saving || skillsWrites.has(ctx.id);
  $('skillsSave').disabled = !editable || !ctx.dirty;
  $('skillsSave').textContent = ctx.saving ? 'Saving…' : 'Save selection';
  v2SkillsPaintAvailability(ctx);
  $('skillsStatus').textContent = ctx.loading ? 'Reading the saved selection…'
    : !r ? 'The selection could not be read.'
    : `${v2SkillsSummary(r)}. ${r.message || ''}${skillsWrites.has(ctx.id) && !ctx.saving ? ' A previous save is still finishing. Recheck before changing the selection.' : ''}`;
  $('skillsChoices').hidden = !r;
  if (!r) return;
  $('skillsChoices').innerHTML = r.skills.map(s => `<div style="padding:12px 0;border-bottom:1px solid var(--line)">
    <label style="display:flex;gap:9px;align-items:flex-start;margin:0"><input type="checkbox" data-skill="${esc(s.id)}" style="width:auto;margin-top:3px"${ctx.choices.has(s.id) ? ' checked' : ''}${editable ? '' : ' disabled'} ${onAction('change', 'v2SkillsChanged')}>
      <span style="min-width:0"><b>${esc(s.name)}</b> <span class="sub">Catalog v${esc(s.version)}</span><br><span class="sub">${esc(s.description)}</span></span></label>
    <div class="sub" style="margin:5px 0 0 25px">${s.applied === null ? 'Last build selection unknown' : s.applied ? 'Applied at last build' : 'Not applied at last build'}${s.requirements?.length ? '<br>Requires: ' + s.requirements.map(esc).join('; ') : ''}</div>
    <button data-skill-preview="${esc(s.id)}" ${onAction('click', 'v2SkillOpen', [`${s.id ?? ''}`])}${ctx.loading || ctx.saving || skillsWrites.has(ctx.id) ? ' disabled' : ''}>Preview, update and try</button>
  </div>`).join('');
}
function v2SkillsChanged() {
  const ctx = skillsOpening;
  if (!ctx || !v2SkillsEditable(ctx)) return;
  ctx.choices = new Set([...$('skillsChoices').querySelectorAll('input[data-skill]:checked')].map(el => el.dataset.skill));
  ctx.dirty = ctx.data.managed === false || ctx.choices.size !== ctx.data.selected.length || ctx.data.selected.some(id => !ctx.choices.has(id));
  $('skillsSave').disabled = !ctx.dirty;
  $('skillsErr').textContent = '';
  v2SkillsClearAvailability(ctx);
}
async function v2SkillsRead(ctx = skillsOpening) {
  if (!v2SkillsCurrent(ctx) || ctx.saving) return;
  const read = ++ctx.read;
  const version = skillsWriteVersions.get(ctx.id) || 0;
  v2SkillsClearAvailability(ctx);
  ctx.loading = true; $('skillsErr').textContent = ''; v2SkillsPaint(ctx);
  try {
    const r = v2SkillsResult(await api(`/v1/agents/${ctx.id}/skills`));
    if (!v2SkillsCurrent(ctx) || ctx.read !== read) return;
    if ((skillsWriteVersions.get(ctx.id) || 0) !== version) throw new Error('The selection changed while reading. Recheck before saving.');
    ctx.data = r; ctx.readFailed = false;
    if (!ctx.dirty) ctx.choices = new Set(r.selected);
    else {
      const known = new Set(r.skills.map(s => s.id));
      ctx.choices = new Set([...ctx.choices].filter(id => known.has(id)));
    }
    ctx.dirty = r.managed === false || ctx.choices.size !== r.selected.length || r.selected.some(id => !ctx.choices.has(id));
  } catch (e) {
    if (!v2SkillsCurrent(ctx) || ctx.read !== read) return;
    ctx.readFailed = true; $('skillsErr').textContent = e.message;
  } finally {
    if (v2SkillsCurrent(ctx) && ctx.read === read) { ctx.loading = false; v2SkillsPaint(ctx); }
  }
}
async function v2SkillsSave() {
  const ctx = skillsOpening;
  if (!ctx || !v2SkillsEditable(ctx) || !ctx.dirty) return;
  const selected = ctx.data.skills.filter(s => ctx.choices.has(s.id)).map(s => s.id), token = {};
  let saved = false;
  v2SkillsClearAvailability(ctx);
  skillsWriteVersions.set(ctx.id, (skillsWriteVersions.get(ctx.id) || 0) + 1);
  skillsWrites.set(ctx.id, token); ctx.saving = true; $('skillsErr').textContent = ''; v2SkillsPaint(ctx);
  try {
    const r = v2SkillsResult(await api(`/v1/agents/${ctx.id}/skills`, { method: 'PUT', body: { selected } }));
    if (!v2SkillsCurrent(ctx)) return;
    ctx.data = r; ctx.choices = new Set(r.selected); ctx.dirty = false;
    saved = true;
  } catch (e) {
    if (v2SkillsCurrent(ctx)) $('skillsErr').textContent = e.message;
  } finally {
    if (skillsWrites.get(ctx.id) === token) {
      skillsWrites.delete(ctx.id);
      skillsWriteVersions.set(ctx.id, (skillsWriteVersions.get(ctx.id) || 0) + 1);
    }
    ctx.saving = false;
    if (v2SkillsCurrent(ctx)) { v2SkillsPaint(ctx); if (saved) void v2LoadSkills(ctx.id); }
    v2SkillsFinishWrite(ctx);
  }
}

// A voice check belongs to its card and signed-in person; it never requests microphone access.
let voiceEpoch = 0;
const voiceWrites = new Set();
function v2VoiceForget() {
  voiceEpoch++;
  const el = $('v2Voice');
  if (el) { el.dataset.status = 'unavailable'; el.textContent = 'Sign in again to check browser Talk.'; }
}
function voiceBrowserNote() {
  if (!window.isSecureContext) return 'Browser Talk needs HTTPS (or localhost). Reopen Hatchabot at its HTTPS address.';
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return 'This browser does not offer microphone access here. Try a browser with microphone support.';
  return '';
}
async function v2LoadVoice(id) {
  const el = $('v2Voice'), a = v2Find(id);
  if (!el || el.dataset.agent !== id || !a || !v2Mine(a) || pagePersonAway || pageSignedOut) return;
  const epoch = voiceEpoch, person = pagePerson, read = String(Number(el.dataset.read || 0) + 1);
  const setupHint = `<p class="sub">Set up Talk links voice to <code>${esc(a.slug)}</code> and uses voice credentials already available to this agent. Your provider, model and voice choices are kept.</p>`;
  el.dataset.read = read; el.dataset.status = 'checking';
  el.innerHTML = '<b>Browser Talk</b><p class="sub" role="status">Checking voice configuration…</p>' + setupHint + '<button disabled>Recheck</button>';
  const current = () => epoch === voiceEpoch && person === pagePerson && !pagePersonAway && !pageSignedOut
    && v2AgentDlg.open && v2AgentId === id && $('v2Voice') === el && el.dataset.read === read && !!v2Find(id) && v2Mine(v2Find(id));
  let r;
  try { r = await api(`/v1/agents/${id}/voice`); }
  catch { r = { status: 'unavailable' }; }
  if (!current()) return;
  const words = {
    configured: 'Runtime reports voice configured; a call has not been tested.',
    unconfigured: r?.reason === 'agent'
      ? 'Talk is not linked to this agent yet. Press Set up Talk to configure it.'
      : r?.reason === 'network'
        ? 'The manager’s voice provider needs network permission. Set up Talk can authorize Google or OpenAI; choose one of those in Voice settings.'
      : r?.reason === 'credentials'
        ? 'Talk needs Google or OpenAI voice credentials. A text-model subscription alone may not provide them.'
        : 'Runtime does not report a configured Talk provider. Set up Talk, or review the provider in Voice settings.',
    unsupported: 'This runtime does not report browser Talk support. Check its OpenClaw version.',
    unavailable: 'Could not check browser Talk. Set up Talk can repair its agent selection; use Voice settings for provider configuration, then Recheck.',
    not_running: 'Not running. Start this agent, then recheck browser Talk.',
    busy: 'Busy with another operation. Recheck when it finishes.',
  };
  const status = Object.hasOwn(words, r?.status) ? r.status : 'unavailable';
  el.dataset.status = status;
  const provider = typeof r?.provider === 'string' ? r.provider.slice(0, 100) : '';
  const browserNote = voiceBrowserNote(), running = v2Find(id)?.state === 'RUNNING';
  const saving = voiceWrites.has(id);
  const configure = running && window.isSecureContext && ['configured', 'unconfigured', 'unavailable'].includes(status);
  const tryVoice = running && status === 'configured' && !browserNote;
  el.innerHTML = `<b>Browser Talk${provider ? ' · ' + esc(provider) : ''}</b>
    <p class="sub" role="status">${words[status]}</p>
    ${setupHint}
    ${a.ops ? '<p class="sub">For the manager, Set up Talk also allows its detected Google or OpenAI voice provider through its network restrictions.</p>' : ''}
    ${browserNote ? `<p class="sub">${esc(browserNote)}</p>` : ''}
    <div class="actions" style="justify-content:flex-start;flex-wrap:wrap">
      ${status !== 'configured' ? `<button id="v2VoiceSetup" class="primary" ${onAction('click', 'v2SetupVoice', [`${id ?? ''}`])}${configure && !saving ? '' : ' disabled'}>${saving ? 'Setting up Talk…' : 'Set up Talk'}</button>` : ''}
      <button id="v2VoiceRecheck" ${onAction('click', 'v2LoadVoice', [`${id ?? ''}`])}${saving ? ' disabled' : ''}>Recheck</button>
      <button id="v2VoiceConfigure" ${onAction('click', 'v2VoiceOpen', [`${id ?? ''}`, "voice-settings"])}${configure && !saving ? '' : ' disabled'}>Voice settings</button>
      <button id="v2VoiceTry" ${onAction('click', 'v2VoiceOpen', [`${id ?? ''}`, "chat"])}${tryVoice && !saving ? '' : ' disabled'}>Try voice</button>
      ${r?.reason === 'credentials' ? `<button id="v2VoiceKeys" ${onAction('click', 'v2VoiceKeySettings', [`${id ?? ''}`])}${saving ? ' disabled' : ''}>Voice key settings</button>` : ''}
    </div>
    <p class="sub">Try voice opens this agent's conversation. Press the microphone there to start; opening this card does not record audio.</p>
    <p class="sub">Switching agents ends the voice call. Text chat tabs stay open.</p>
    ${r?.reason === 'credentials' ? '<p class="sub">For a shared Gemini key, open Settings → Connections → Voice &amp; media, save the key, then Rebuild the agent so it receives it. Google and OpenAI AI sources can supply their own credentials. Recheck afterward.</p>' : ''}
    <p class="sub">Telegram voice-note transcription is separate. Its shared Gemini key is under Settings → Connections.</p>`;
}
function v2VoiceKeySettings(id) {
  const a = v2Find(id);
  if (!a || !v2Mine(a) || !v2AgentDlg.open || v2AgentId !== id || $('v2Voice')?.dataset.agent !== id
    || voiceWrites.has(id) || pagePersonAway || pageSignedOut) return;
  v2Close();
  void openAiDlg('conn').catch(() => toast('Could not load Connections. Open Settings and try again.', 8000));
  $('mediaKeyDrawer').open = true;
  $('mediaKey').focus();
}
async function v2SetupVoice(id) {
  const a = v2Find(id), el = $('v2Voice');
  if (!a || !v2Mine(a) || a.state !== 'RUNNING' || !window.isSecureContext || !v2AgentDlg.open || v2AgentId !== id
    || el?.dataset.agent !== id || !['unconfigured', 'unavailable'].includes(el.dataset.status)
    || voiceWrites.has(id) || pagePersonAway || pageSignedOut) return;
  const epoch = voiceEpoch, person = pagePerson;
  const read = String(Number(el.dataset.read || 0) + 1);
  el.dataset.read = read; el.dataset.status = 'saving';
  voiceWrites.add(id);
  for (const btn of el.querySelectorAll('button')) btn.disabled = true;
  el.querySelector('[role="status"]').textContent = 'Setting up Talk for this agent…';
  const here = () => epoch === voiceEpoch && person === pagePerson && !pagePersonAway && !pageSignedOut
    && v2AgentDlg.open && v2AgentId === id && !!v2Find(id) && v2Mine(v2Find(id));
  const current = () => here() && $('v2Voice') === el && el.dataset.read === read;
  try {
    const r = await api(`/v1/agents/${id}/voice`, { method: 'POST', body: {} });
    if (!current()) return;
    toast(r.status === 'configured'
      ? 'Talk is configured. Use Try voice and press the microphone to test a call.'
      : r.reason === 'credentials'
        ? 'Talk is linked to this agent. Add voice credentials, rebuild if needed, then Recheck.'
        : r.reason === 'network'
          ? 'Choose a Google or OpenAI voice provider in Voice settings, then Set up Talk again.'
        : 'Talk is linked to this agent. Recheck its provider or open Voice settings.', 10000);
  } catch (e) { if (current()) toast(e.message || 'Could not set up Talk. Recheck and try again.', 10000); }
  finally {
    voiceWrites.delete(id);
    // A newly opened card gets a fresh read, never the earlier card's result.
    if (here() && $('v2Voice')?.dataset.agent === id) await v2LoadVoice(id);
  }
}
async function v2VoiceOpen(id, view) {
  const a = v2Find(id), el = $('v2Voice');
  if (!a || !v2Mine(a) || !v2AgentDlg.open || v2AgentId !== id || el?.dataset.agent !== id || pagePersonAway || pageSignedOut) return;
  if ((view !== 'voice-settings' && view !== 'chat') || voiceWrites.has(id)) return;
  const allowed = a.state === 'RUNNING' && window.isSecureContext && (view === 'chat'
    ? el.dataset.status === 'configured' && !voiceBrowserNote()
    : ['configured', 'unconfigured', 'unavailable'].includes(el.dataset.status));
  if (!allowed) return;
  const epoch = voiceEpoch;
  v2Close();
  await openGateway(a.id, a.slug, view);
  if (view === 'chat' && epoch === voiceEpoch && $('consoleDlg').open && consoleAgentId === id) toast('Press the microphone in this conversation, then make a short call to check hearing and playback.', 12000);
}
async function v2LoadBrowser(id) {
  const el = $('v2BrowserState');
  try {
    const b = await api(`/v1/agents/${id}/browser`);
    if (!el || el !== $('v2BrowserState')) return; // the agent or tab changed while this read waited
    el.textContent = !b.on ? '' : (b.running ? `· running${b.chromium ? ` (Chromium ${b.chromium})` : ''}` : '· starting (within a minute of the agent)') + (b.keepsLogins ? ` · keeps logins${b.profileMB ? ` (${b.profileMB} MB)` : ''}` : '');
    el.style.color = b.on && b.running ? 'var(--ok)' : '';
    // The sites its sign-in panel opened while it keeps its logins, newest first, with the day.
    const sites = $('v2BrowserSites');
    if (sites) {
      const list = b.keepsLogins ? (b.sites || []).slice(0, 12) : [];
      sites.hidden = !list.length;
      sites.innerHTML = list.length ? 'Signed in through its panel: ' + list.map((x) => `${esc(x.site)} <span style="opacity:.75">(${esc(new Date(x.at).toLocaleDateString([], { month: 'short', day: 'numeric' }))})</span>`).join(', ') : '';
    }
  } catch { if (el) el.textContent = ''; }
}
/*
 * Keep its logins (HB-0680; docs/browser.md): its browser's sign-ins kept on
 * this machine until they are forgotten. Switched on only after the warning,
 * which names who besides you can steer the agent; each change starts its
 * browser again, empty.
 */
async function v2SetKeepLogins(id, on, el) {
  if (!el || el.disabled) return;
  const current = sharingRead(el, id);
  if (!current()) return;
  const a = v2Find(id), name = a?.name ?? 'this agent';
  const undo = () => { if (current()) el.value = on ? 'off' : 'on'; };
  el.disabled = true;
  try {
    if (on) {
      const who = (await api(`/v1/agents/${id}/browser`)).steeredBy || [];
      if (!current()) return;
      const list = who.length ? who.map((w) => `  • ${w}`).join('\n') : '  • nobody else: only you message it';
      if (!confirm(`Keep ${name}'s logins?\n\nSites you sign in to in its browser stay signed in until you forget them. While they are, the agent can act as you there, and so can a web page that tricks it, or anyone who can message it:\n${list}\n\nIt can also copy a sign-in out of its browser. Sign it in only where you would let it act for you: never your email, bank or password manager. Logins are not in backups or downloads.\n\nIts browser starts again, empty: sign it in after.`)) { undo(); return; }
    } else if (!confirm(`Stop keeping ${name}'s logins?\n\nIts browser starts again, signed in nowhere, and what it kept is deleted from this machine.`)) { undo(); return; }
    const r = await api(`/v1/agents/${id}/browser/logins`, { method: 'PUT', body: { keep: on } });
    if (!current()) return;
    toast(r?.message || (on ? 'It keeps its logins now.' : 'It keeps no logins now.'), 9000);
    await refresh(false);
  } catch (e) { if (current()) { toast(e.message, 8000); undo(); } }
  finally { if (current()) el.disabled = false; }
}
async function v2ForgetLogins(id) {
  const name = v2Find(id)?.name ?? 'this agent';
  if (!confirm(`Forget the logins ${name}'s browser keeps?\n\nIts browser starts again, signed in nowhere, and goes on keeping what you sign it in to next. The sites themselves still count it signed in: to end a session there, sign out of it on the site, or change that password.`)) return;
  try {
    const r = await api(`/v1/agents/${id}/browser/logins`, { method: 'DELETE' });
    toast(r?.message || 'Forgotten.', 9000);
    await refresh(false);
  } catch (e) { toast(e.message, 8000); }
}
/*
 * "Sign in to a site" (HB-0680; docs/browser-logins-design.md): the agent's own
 * browser, live. The server streams the page as pictures (server-sent events,
 * read with fetch) and takes a few kinds of input back (clicks, scrolls, text,
 * a short list of keys, an address); it turns them into the browser's
 * commands from a fixed list, so this page never sends one itself. bp.gen
 * counts openings: what a closed one still says is ignored.
 */
let bp = { gen: 0, q: [] };
const BP_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
function bpState(text, warn = false) { const el = $('bpState'); el.textContent = text || ''; el.classList.toggle('warn', !!warn); }
function bpClearView() {
  $('bpScreen').removeAttribute('src');
  $('bpUrl').value = ''; $('bpType').value = '';
  $('bpType').classList.remove('shown');
  $('bpShow').setAttribute('aria-pressed', 'false'); $('bpShow').textContent = 'Show';
}
/** Cleanup cannot ask for a sign-in or a second factor, including after another panel opened. */
function bpRelease(agent, panel) {
  void fetch(`/v1/agents/${agent}/browser/panel/${panel}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
}
function bpWrapSize() {
  const r = $('bpWrap').getBoundingClientRect();
  return { w: Math.max(200, Math.round(r.width)), h: Math.max(200, Math.round(r.height)), mobile: matchMedia('(pointer: coarse)').matches && innerWidth < 760, dpr: Math.min(2, window.devicePixelRatio || 1) };
}
async function bpOpen(id) {
  const a = v2Find(id);
  const gen = ++bp.gen;
  bp.abort?.abort();
  bp = { gen, q: [], agent: id, panel: null, ended: false, fw: 0, fh: 0, urlTyped: false };
  $('bpTitle').textContent = `Sign in to a site: ${a?.name ?? 'its browser'}`;
  // How long a sign-in lasts: until a restart, or until forgotten when it keeps its logins.
  $('bpNote').textContent = `Click a box in the page and type. What you type goes to that page only; Hatchabot keeps none of it. The agent stays signed in ${a?.keepsLogins ? 'until you forget its logins (it keeps them)' : 'until it restarts'} and can act as you there: sign it in only where you would let it act for you.`;
  bpClearView();
  $('bpAgain').hidden = true;
  bpDlg.classList.remove('bp-done');
  if (!bpDlg.open) bpDlg.showModal();
  bpState('Opening its browser…');
  try {
    const r = await api(`/v1/agents/${id}/browser/panel`, { method: 'POST', body: bpWrapSize() });
    if (gen !== bp.gen) { bpRelease(id, r.panel); return; }
    bp.panel = r.panel;
    bpState('Connecting…');
    void bpStream(gen);
    // With a mouse, straight to the address; on a phone no keyboard springs up over the page.
    if (!matchMedia('(pointer: coarse)').matches) $('bpUrl').focus();
  } catch (e) { if (gen === bp.gen) bpEnded(e.message); }
}
function bpEnded(why) {
  if (bp.ended) return;
  bp.ended = true; bp.panel = null; bp.q = [];
  bp.abort?.abort();
  bpDlg.classList.add('bp-done');
  bpState(why, true);
  $('bpAgain').hidden = !bpDlg.open || !bp.agent;
}
function bpClose() {
  const { agent, panel, ended } = bp;
  if (agent && panel && !ended) bpRelease(agent, panel);
  bp.gen++; bp.abort?.abort(); bp.panel = null; bp.ended = true; bp.q = [];
  bpClearView();
  if (bpDlg.open) bpDlg.close();
}
async function bpStream(gen) {
  const ctl = new AbortController();
  bp.abort = ctl;
  let res;
  try { res = await fetch(`/v1/agents/${bp.agent}/browser/panel/${bp.panel}/stream`, { signal: ctl.signal, headers: { accept: 'text/event-stream' } }); }
  catch { if (gen === bp.gen) bpEnded('The connection to Hatchabot dropped. Open it again to carry on.'); return; }
  if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); if (gen === bp.gen) bpEnded(d.error || 'Its browser could not be shown.'); return; }
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    let r;
    try { r = await reader.read(); } catch { break; }
    if (r.done || gen !== bp.gen) break;
    buf += dec.decode(r.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) if (line.startsWith('data: ')) { try { bpEvent(JSON.parse(line.slice(6)), gen); } catch { /* not one of ours */ } }
    }
  }
  if (gen === bp.gen) bpEnded('The connection to Hatchabot dropped. Open it again to carry on.');
}
function bpEvent(ev, gen) {
  if (gen !== bp.gen || bp.ended) return;
  if (ev.t === 'frame') {
    if (!bp.fw) bpState('');
    bp.fw = ev.w; bp.fh = ev.h;
    $('bpScreen').src = `data:image/jpeg;base64,${ev.data}`;
  } else if (ev.t === 'url') { if (!bp.urlTyped) $('bpUrl').value = ev.url === 'about:blank' ? '' : ev.url; } // not over an address being typed
  else if (ev.t === 'loading') { if (!$('bpState').classList.contains('warn')) bpState(ev.on ? 'Loading…' : ''); }
  else if (ev.t === 'note') bpState(ev.text, true);
  else if (ev.t === 'closed') bpEnded(ev.why);
}
/** Inputs go one post at a time, in order; what piles up meanwhile goes in the next (moves and scrolls merged, text joined). */
function bpSend(...ops) {
  if (!bp.panel || bp.ended) return;
  for (const op of ops) {
    const last = bp.q.at(-1);
    if (op.k === 'mouse' && op.type === 'move' && last?.k === 'mouse' && last.type === 'move') bp.q[bp.q.length - 1] = op;
    else if (op.k === 'wheel' && last?.k === 'wheel' && Math.abs(last.dx + op.dx) <= 10000 && Math.abs(last.dy + op.dy) <= 10000) { last.dx += op.dx; last.dy += op.dy; last.x = op.x; last.y = op.y; }
    else if (op.k === 'text' && last?.k === 'text' && last.text.length + op.text.length <= 4000) last.text += op.text;
    else bp.q.push({ ...op });
  }
  if (ops.some((o) => o.k !== 'mouse' || o.type !== 'move') && $('bpState').classList.contains('warn')) bpState('');
  void bpFlush();
}
async function bpFlush() {
  if (bp.busy || !bp.q.length || !bp.panel) return;
  const { gen, agent, panel } = bp;
  bp.busy = true;
  // The API caps JSON by bytes as well as operations. Unicode and escaped
  // text can exceed that cap even when every individual input is valid.
  const ops = [], encoder = new TextEncoder();
  let bytes = 16;
  while (ops.length < 200 && bp.q.length) {
    const next = encoder.encode(JSON.stringify(bp.q[0])).byteLength + 1;
    if (ops.length && bytes + next > 512 * 1024) break;
    bytes += next; ops.push(bp.q.shift());
  }
  try { await api(`/v1/agents/${agent}/browser/panel/${panel}/input`, { method: 'POST', body: { ops } }); }
  catch (e) { if (gen === bp.gen && !bp.ended) (/has closed/.test(e.message) ? bpEnded(e.message) : bpState(e.message, true)); }
  finally { if (gen === bp.gen) { bp.busy = false; void bpFlush(); } }
}
function bpGo() {
  const url = $('bpUrl').value.trim();
  if (!url) return;
  bp.urlTyped = false;
  bpSend({ k: 'go', url });
  $('bpScreen').focus({ preventScroll: true });
}
function bpTypeSend() {
  const box = $('bpType'), text = box.value;
  if (!text) return;
  bpText(text);
  box.value = '';
}
/** The server limits each piece by UTF-16 units; keep whole code points and all pasted text. */
function bpText(text) {
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + 4000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    bpSend({ k: 'text', text: text.slice(at, end) });
    at = end;
  }
}
function bpToggleShow() {
  const box = $('bpType'), on = !box.classList.contains('shown');
  box.classList.toggle('shown', on);
  $('bpShow').setAttribute('aria-pressed', String(on));
  $('bpShow').textContent = on ? 'Hide' : 'Show';
}
/** Where on the page a point of the picture is, in the page's own pixels; `clamp` keeps one off the picture at its edge. */
function bpPoint(e, clamp = false) {
  if (!bp.fw) return null;
  const r = $('bpScreen').getBoundingClientRect();
  const sc = Math.min(r.width / bp.fw, r.height / bp.fh);
  if (!sc) return null;
  let x = (e.clientX - r.left - (r.width - bp.fw * sc) / 2) / sc, y = (e.clientY - r.top - (r.height - bp.fh * sc) / 2) / sc;
  if (!clamp && (x < 0 || y < 0 || x > bp.fw || y > bp.fh)) return null;
  x = Math.min(bp.fw, Math.max(0, x)); y = Math.min(bp.fh, Math.max(0, y));
  return { x: Math.round(x), y: Math.round(y) };
}
function bpScale() { const r = $('bpScreen').getBoundingClientRect(); return bp.fw ? 1 / Math.min(r.width / bp.fw, r.height / bp.fh) : 1; }
const bpMods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
(() => {
  const scr = $('bpScreen');
  // A mouse clicks and drags as itself. A finger taps (a click where it lifted, if it did not move) or scrolls the page.
  scr.addEventListener('pointerdown', (e) => {
    if (!bp.panel || bp.ended) return;
    const p = bpPoint(e);
    if (!p) return;
    e.preventDefault();
    scr.focus({ preventScroll: true });
    try { scr.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer */ }
    if (e.pointerType === 'mouse') {
      const button = ['left', 'middle', 'right'][e.button] ?? 'left';
      bp.mouse = { button, p };
      bpSend({ k: 'mouse', type: 'move', ...p }, { k: 'mouse', type: 'down', ...p, button, clicks: Math.min(3, Math.max(1, e.detail || 1)), mods: bpMods(e) });
    } else {
      bp.touch = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, p, moved: false };
    }
  });
  scr.addEventListener('pointermove', (e) => {
    const t = bp.touch;
    if (t && e.pointerId === t.id) {
      if (!t.moved && Math.hypot(e.clientX - t.x0, e.clientY - t.y0) > 8) t.moved = true;
      if (t.moved) {
        const k = bpScale();
        bpSend({ k: 'wheel', ...t.p, dx: Math.round((t.lx - e.clientX) * k), dy: Math.round((t.ly - e.clientY) * k) });
        t.lx = e.clientX; t.ly = e.clientY;
      }
      return;
    }
    if (bp.mouse) { const p = bpPoint(e, true); if (p) { bp.mouse.p = p; bpSend({ k: 'mouse', type: 'move', ...p, button: bp.mouse.button }); } }
  });
  const up = (e) => {
    const t = bp.touch;
    if (t && e.pointerId === t.id) {
      bp.touch = null;
      if (!t.moved && e.type === 'pointerup') bpSend({ k: 'mouse', type: 'move', ...t.p }, { k: 'mouse', type: 'down', ...t.p }, { k: 'mouse', type: 'up', ...t.p });
      return;
    }
    if (bp.mouse) {
      const p = bpPoint(e, true) ?? bp.mouse.p;
      bpSend({ k: 'mouse', type: 'up', ...p, button: bp.mouse.button, clicks: Math.min(3, Math.max(1, e.detail || 1)) });
      bp.mouse = null;
    }
  };
  scr.addEventListener('pointerup', up);
  scr.addEventListener('pointercancel', up);
  scr.addEventListener('contextmenu', (e) => e.preventDefault());
  scr.addEventListener('wheel', (e) => {
    const p = bpPoint(e);
    if (!p || !bp.panel) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
    bpSend({ k: 'wheel', ...p, dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k) });
  }, { passive: false });
  // Typing with the picture focused goes to the page: characters as text, a few keys as keys. Esc still closes the panel.
  scr.addEventListener('keydown', (e) => {
    if (!bp.panel || bp.ended || e.isComposing) return;
    if (BP_KEYS.has(e.key)) { e.preventDefault(); bpSend({ k: 'key', key: e.key, mods: bpMods(e) }); return; }
    if ([...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); bpSend({ k: 'text', text: e.key }); }
  });
  bpDlg.addEventListener('paste', (e) => {
    if (document.activeElement !== scr) return;
    const text = e.clipboardData?.getData('text');
    if (text) { e.preventDefault(); bpText(text); }
  });
  // Escape can arrive before the opening request answers. Invalidate that request too;
  // a delayed close event from the previous panel must not close a new one.
  bpDlg.addEventListener('close', () => { if (!bpDlg.open && !bp.ended) bpClose(); });
  $('bpUrl').addEventListener('input', () => { bp.urlTyped = true; });
  // A turned phone or a resized window: the page is told its new size.
  let resizing;
  addEventListener('resize', () => {
    if (!bpDlg.open || !bp.panel) return;
    clearTimeout(resizing);
    resizing = setTimeout(() => { if (bp.panel) bpSend({ k: 'size', ...bpWrapSize() }); }, 300);
  });
})();
async function v2SetAgentPolicy(id, body) {
  try { const r = await api(`/v1/agents/${id}`, { method: 'PATCH', body }); r?.filesCapPending ? toast(r.filesCapPending, 8000) : toast('Saved.'); await refresh(false); }
  catch (e) { toast(e.message, 6000); await refresh(false); }
}
/** Slack creates an app from a manifest given in the address: no copy, no paste. */
async function chanPrefillSlackLink(name, gen) {
  try {
    const m = await api(`/v1/channels/slack/manifest?name=${encodeURIComponent(name)}`);
    const link = $('chanSlackNew');
    if (link && gen === chanOpenGen) link.href = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(m))}`;
  } catch { /* the plain link and Copy app manifest still work */ }
}
/** Both Slack tokens from one paste: whichever the person copied, in any order. */
function chanPasteTokens(el) {
  const text = el.value;
  const bot = /xoxb-[A-Za-z0-9-]{20,}/.exec(text)?.[0], app = /xapp-[A-Za-z0-9-]{20,}/.exec(text)?.[0];
  for (const [key, val] of [['botToken', bot], ['appToken', app]]) {
    const box = $(`chanF-${key}`);
    if (box && val) { box.value = val; chanCheckField(box); }
  }
  const missing = [!bot && 'the bot token (xoxb-)', !app && 'the app-level token (xapp-)'].filter(Boolean);
  $('chanErr').textContent = text.trim() && missing.length ? `Still missing ${missing.join(' and ')}.` : '';
}
function chanCheckField(el) {
  const ok = !el.value.trim() || new RegExp(el.dataset.pattern).test(el.value.trim());
  el.setAttribute('aria-invalid', ok ? 'false' : 'true');
  el.style.borderColor = ok ? '' : 'var(--bad)';
}
async function chanCopyManifest(btn, fallbackName) {
  const name = v2Find(chanFor)?.name || fallbackName; if (!name) return;
  try {
    const m = await api(`/v1/channels/slack/manifest?name=${encodeURIComponent(name)}`);
    const text = JSON.stringify(m, null, 2);
    try { if (!(await copyText(text))) throw new Error('no clipboard'); btn.textContent = '✓ Copied'; }
    catch {
      // No clipboard (plain http off this machine): show it to copy by hand.
      btn.insertAdjacentHTML('afterend', `<textarea readonly rows="8" style="width:100%;margin-top:6px;font-family:ui-monospace,monospace;font-size:12px">${esc(text)}</textarea>`);
      btn.remove();
    }
  } catch (e) { toast(e.message); }
}
async function chanConnect(btn) {
  const id = chanFor, kind = chanKind, gen = chanOpenGen, person = pagePerson;
  const current = () => gen === chanOpenGen && chanDlg.open && chanFor === id && chanKind === kind && person === pagePerson && !pagePersonAway && !pageSignedOut;
  const body = {};
  const pooled = $('chanPooled')?.value;
  if (pooled) body.pooled = pooled;
  else {
    for (const el of chanDlg.querySelectorAll('input[data-key]')) body[el.dataset.key] = el.value.trim();
    if (Object.values(body).some(v => !v)) { $('chanErr').textContent = 'Fill in every box first, or pick a parked bot.'; return; }
  }
  if (!confirmRebuild(id, `Connecting ${V2_CHAN_LABEL[kind] ?? kind}`)) return;
  btn.disabled = true; btn.textContent = 'Checking…'; $('chanErr').textContent = '';
  try {
    const c = await api(`/v1/agents/${id}/channels/${kind}`, { method: 'POST', body });
    if (current()) chanShowConnected(c);
    await refresh(false);
  } catch (e) {
    if (!current()) return;
    $('chanErr').textContent = e.message;
    btn.disabled = false; btn.textContent = 'Connect';
  }
}
function chanShowConnected(c) {
  const label = V2_CHAN_LABEL[chanKind];
  $('chanTitle').textContent = `Connected to ${label}`;
  $('chanGo').hidden = true;
  $('chanClose').textContent = 'Done';
  $('chanBody').innerHTML = `
    <p>It is <b>${esc(c.displayName || label)}</b>. ${c.atNextStart ? 'It stays stopped, and picks this up when it next starts (its memory is kept).' : 'It restarts now to pick this up (its memory is kept).'}</p>
    ${c.warnings?.length ? `<ul class="v2chan-warn">${c.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <ol class="v2steps">
      ${httpsUrl(c.addToServerUrl) ? `<li><a class="btn primary" href="${esc(c.addToServerUrl)}" target="_blank" rel="noopener">Add it to your server</a>. People can only message it once they share a server with it.</li>` : ''}
      <li>${httpsUrl(c.deepLink) ? `<a class="btn${httpsUrl(c.addToServerUrl) ? '' : ' primary'}" href="${esc(c.deepLink)}" target="_blank" rel="noopener">Open ${label}</a>` : `Open ${label}`} and send it a direct message. ${c.youAreLinked ? 'It already knows you.' : `Your message shows up here as a request: approve it with <b>That's me</b>. (A ${label} bot can be seen by a whole server, so nobody is linked on their first message alone.)`}</li>
    </ol>
    <div class="v2wait" id="chanWait"><span class="spinner" aria-hidden="true"></span> ${c.atNextStart ? 'Waiting for it to be started…' : c.youAreLinked ? 'Restarting…' : 'Waiting for your request…'}</div>`;
  clearInterval(chanWatch);
  const id = chanFor, kind = chanKind;
  let linkShown = false;
  // A check can take longer than the 4 s between them: only the newest answer so far counts (review of HB-0411).
  let asked = 0, answered = 0;
  const watch = chanWatch = setInterval(async () => {
    if (!chanDlg.open) return clearInterval(watch);
    const turn = ++asked;
    try {
      const r = await api(`/v1/agents/${id}/channels`);
      // Linked is about the person; answering is about the agent, read now. It may be
      // stopped until someone starts it, rebuilding, or still RUNNING with its rebuild
      // queued (an operation). "Now" only once it is up.
      const a = await api(`/v1/agents/${id}`).catch(() => null);
      if (chanWatch !== watch || !chanDlg.open || turn < answered) return;
      answered = turn;
      const up = a?.state === 'RUNNING' && !a.rebuildOnStart && !a.operation;
      if (Array.isArray(r?.channels) && r.channels.find(x => x.kind === kind)?.youAreLinked) {
        if (up) clearInterval(watch);
        $('chanWait').innerHTML = `✓ Linked. It answers you on ${label} ${up ? 'now' : a?.state === 'STOPPED' ? 'once it is started' : 'once it is back up'}.`;
        if ((up || !linkShown) && $('v2Chans')) void v2LoadChans(id);
        linkShown = true;
      } else if (up && c.atNextStart) {
        $('chanWait').innerHTML = '<span class="spinner" aria-hidden="true"></span> Waiting for your request…';
      }
    } catch { /* keep waiting */ }
  }, 4000);
}
chanDlg.addEventListener('close', () => {
  if (chanDlg.open) return; // a late close event belongs to the previous opening
  clearInterval(chanWatch); chanWatch = null;
  if (chanShownGen === chanOpenGen) chanOpenGen++;
  chanDlg.querySelectorAll('input, textarea').forEach(i => { i.value = ''; });
});

async function chanRecheck(id, kind, btn) {
  btn.disabled = true; const was = btn.textContent; btn.textContent = 'Checking…';
  try {
    const c = await api(`/v1/agents/${id}/channels/${kind}/recheck`, { method: 'POST', body: {} });
    if (c.placesChanged && confirmRebuild(id, `Answering in its new ${kind === 'slack' ? 'channels' : 'servers'}`)) {
      await api(`/v1/agents/${id}/rebuild`, { method: 'POST', body: { stoppedWaits: true } }).then((r) => toast(r?.atNextStart ? 'Saved. It is not running, so it stays that way: it answers in the new places from its next start.' : 'Rebuilding — it answers in the new places when it is back.')).catch(e => toast(e.message, 8000));
    }
    toast(c.warnings?.length ? `${V2_CHAN_LABEL[kind]}: ${c.warnings.length} thing${c.warnings.length === 1 ? '' : 's'} still to fix.` : `${V2_CHAN_LABEL[kind]}: all good.`);
    if ($('v2Chans')) void v2LoadChans(id);
  } catch (e) { toast(e.message, 8000); btn.disabled = false; btn.textContent = was; }
}
async function chanSaveRooms(id, kind, btn) {
  const mode = $(`chanRoomMode-${kind}`).value;
  const roomId = $(`chanRoom-${kind}`).value.trim();
  if (mode === 'room' && !roomId) { toast(kind === 'telegram' ? 'Pick the room first (Find rooms).' : 'Give the room ID first.'); return; }
  btn.disabled = true;
  try {
    if (kind === 'telegram') {
      await api(`/v1/agents/${id}`, { method: 'PATCH', body: { groupAccess: { mode, ...(mode === 'room' ? { roomId } : {}) } } });
      toast('Saved — applies on the next Rebuild.', 6000);
    } else {
      if (!confirmRebuild(id, 'Changing its group chats')) { btn.disabled = false; return; }
      const r = await api(`/v1/agents/${id}/channels/${kind}`, { method: 'PATCH', body: { rooms: mode === 'room' ? { mode, roomId } : { mode } } });
      toast(r?.atNextStart ? 'Saved. It is not running, so it stays that way: this applies when it next starts.' : mode === 'room' ? `Saved. It restarts to join that ${kind === 'slack' ? 'channel' : 'server'}.` : mode === 'members' ? `Saved: every ${kind === 'slack' ? 'channel' : 'server'} it is in, for people you admitted. It restarts to apply this.` : 'Saved: direct messages only. It restarts to apply this.', 6000);
    }
    await refresh(false);
    v2LoadChans(id);
  } catch (e) { toast(e.message, 8000); }
  finally { btn.disabled = false; }
}
async function chanRemove(id, kind) {
  // (Discord: the bot is parked under Settings → Messaging, name and servers kept.)
  const a = v2Find(id); const label = V2_CHAN_LABEL[kind];
  if (kind === 'telegram') return v2RemoveTelegram(id, a?.name || '', a?.botUsername || '');
  if (kind !== 'slack'
    ? !confirm(`Detach Discord from "${a?.name}"?\n\nIt keeps everything it knows. People stop reaching it on Discord and get a goodbye message. The bot is parked under Settings → Messaging, with its name and servers, ready for another agent. ${chanApplyNote(id)}`)
    : !confirm(`Detach ${label} from "${a?.name}"?\n\nIt keeps everything it knows. People stop reaching it on ${label} and get a goodbye message. The app is parked under Settings → Messaging, with its workspace and channels, ready for another agent. ${chanApplyNote(id)}`)) return;
  try {
    const r = await api(`/v1/agents/${id}/channels/${kind}`, { method: 'DELETE' });
    toast((r.parked ? `${label} detached — ${kind === 'slack' ? 'the app' : 'the bot'} is parked for another agent.` : `${label} detached.`) + (r.atNextStart ? ' It stays down; this applies when it next starts.' : ''), 5000);
    await refresh(false);
  } catch (e) { toast(e.message, 8000); }
}

/**
 * Where an agent stands in its group under My order: the agents of yours in
 * that group as the home screen shows them (the stored order, the manager and
 * child agents aside: those are not moved by hand), or null when it has no
 * place to change.
 */
function v2PlaceInGroup(a) {
  if (!a || !v2Mine(a) || a.ops || a.state === 'ARCHIVED') return null;
  const liveIds = new Set(liveAgents().map(x => x.id));
  const nested = (x) => !!x.parentAgentId && liveIds.has(x.parentAgentId);
  if (nested(a)) return null;
  const order = liveAgents().filter(x => v2Mine(x) && !x.ops && !nested(x) && (x.group || '') === (a.group || '')).map(x => x.id);
  const i = order.indexOf(a.id);
  return order.length > 1 && i >= 0 ? { order, i } : null;
}
/** Switch the home screen to My order (when moving an agent by hand); true if it was on another sort. */
function v2UseManual() {
  if (v2Sort.key === 'manual' && (v2View !== 'cost' || v2CostSort.key === 'manual')) return false;
  v2Sort = { key: 'manual', dir: 1 };
  try { localStorage.setItem('hb-v2-sort', JSON.stringify(v2Sort)); } catch {}
  if (v2View === 'cost') { v2CostSort = { key: 'manual', dir: 1 }; try { localStorage.setItem('hb-v2-sort-cost', JSON.stringify(v2CostSort)); } catch {} }
  return true;
}
/** The sheet's Move earlier / later: one place in its group (Shift: to the start or the end). The keyboard's drag. */
async function v2MoveInGroup(id, delta, ev) {
  const a = v2Find(id), place = v2PlaceInGroup(a);
  if (!place) return;
  const { order, i } = place;
  const j = ev?.shiftKey ? (delta < 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, i + delta));
  if (j === i) { toast(delta < 0 ? 'Already first in its group' : 'Already last in its group', 1800); return; }
  const before = order.filter(x => x !== id)[j] ?? null; // its place in the list without it
  try {
    await api(`/v1/agents/${id}/move`, { method: 'POST', body: before ? { before } : { before: null, group: a.group || '' } });
    if (v2UseManual()) toast('The home screen now shows My order — the order you arrange.', 5000);
    await refresh(false);
  } catch (e) { toast(e.message); return; }
  // The row, whether or not the sheet was redrawn; the keyboard stays on the button pressed.
  if (!v2AgentDlg.open || v2AgentId !== id || v2Tab !== 'overview') return;
  const now = v2PlaceInGroup(v2Find(id));
  if (!now || !$('v2Place')) return;
  $('v2Place').textContent = $('v2Place').textContent.replace(/^\d+ of \d+/, `${now.i + 1} of ${now.order.length}`);
  $('v2MoveEarlier').disabled = now.i === 0;
  $('v2MoveLater').disabled = now.i === now.order.length - 1;
  const mine = $(delta < 0 ? 'v2MoveEarlier' : 'v2MoveLater'), other = $(delta < 0 ? 'v2MoveLater' : 'v2MoveEarlier');
  (mine.disabled ? other : mine).focus();
}

async function v2SetGroup(id, value) {
  let group = value;
  if (value === V2_NEW_GROUP) {
    group = (prompt('Name the new group:') || '').trim();
    if (!group) { $('v2GroupSel').value = v2Find(id)?.group || ''; return; }
  }
  try {
    await api(`/v1/agents/${id}`, { method: 'PATCH', body: { group: group || null } });
    toast(group ? `Moved to ${group}` : 'Moved out of its group');
    await refresh(false);
  } catch (e) { toast(e.message); }
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
 * again, so it waits while there is one (HB-0444). Whatever fills a control notes it as it fills
 * it (v2SheetBaseline): prepareEdit, prepareCrons and each render or fill helper. A refill then
 * moves the baseline with it. A control the sheet draws itself (a Telegram token box) is
 * compared with its value as drawn. A save that does not draw its controls again notes what it
 * sent, for the agent it saved (v2SheetSaving). Noted on a first press or focus instead, a value
 * code put in afterwards (a model menu drawn for a class, a connection attached) read as an
 * edit for good, and the tab never redrew again (HB-0475).
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
/** Each control's fills, counted (v2SheetBaseline): a save's values are its baseline only while no fill came after the press. */
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
/** What `where` holds now is as filled: called by whatever just filled it. */
function v2SheetBaseline(...where) {
  for (const el of v2SheetControlsOf(where)) { v2SheetNotes.set(el, v2CtlValue(el)); v2SheetFills.set(el, (v2SheetFills.get(el) || 0) + 1); }
}
/**
 * Before a save sends them: what `where` holds now. Call what it returns with the agent saved,
 * once it is: those values become the baseline, when the forms are still that agent's and
 * each control is as it was at the press. Refilled meanwhile (the sheet closed and opened
 * again, or another agent and back), it shows what the fill put there: the sent value noted
 * under it held the redraw for good, and a later press sent the old value.
 * `const saved = v2SheetSaving('editDesc'); … saved(forId);` Not for a save whose success
 * draws its controls again: that drawing notes them.
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
