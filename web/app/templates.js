// web/app/templates.js: the importer's setup-value form, agents sent to you, the template gallery, the page's sign-in state across accounts (pageSignedIn, pageSessionEnded, pageHold and the rest), the archived-agent inspector, master and child flows.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- setup-value form (template parameters) — importer side ----------------
// One dialog, reused by file import and inbox accept. Returns a promise:
// {key: value} on Continue, null if the user backs out (Cancel or Esc).

let paramFormFields = [], paramFormResolve = null;

/**
 * A yes/no setup value read as the server reads it (template.ts
 * resolveParamValues): true, yes, 1 or on, in any case. A default of "yes"
 * showed unticked, and Continue sent "false" (audit #067).
 */
function paramYes(v) {
  return /^(true|yes|1|on)$/i.test(String(v ?? '').trim());
}
// The option a choice starts on (HB-0363): the one its value names, trimmed
// and whatever the case (an author's default "Formal" for "formal"), else the
// first option, as the browser showed before "(none)" came first; '' only for
// a blank value.
function choiceStart(options, v) {
  const want = String(v ?? '').trim();
  if (!want) return '';
  return options.find(o => o.trim() === want) ?? options.find(o => o.trim().toLowerCase() === want.toLowerCase()) ?? options[0] ?? '';
}
function collectParamValues(parameters, title) {
  if (paramFormResolve) {
    toast('Finish or cancel the setup already open, then start this import or copy again.', 9000);
    return Promise.resolve(null);
  }
  paramFormFields = parameters;
  $('paramFormName').textContent = title || 'this agent';
  $('paramFormErr').textContent = '';
  $('paramFormBody').innerHTML = parameters.map((p, i) => {
    const id = `pfv-${i}`;
    const star = p.required ? ' <span style="color:var(--warn)">*</span>' : '';
    const help = p.help ? `<div class="sub" style="margin:-2px 0 4px">${esc(p.help)}</div>` : '';
    let input;
    if (p.target === 'env') {
      // A credential: masked entry, lands as an env var in the SecretStore —
      // write-only, never shown again, never inside the shared files.
      input = `<input type="password" id="${id}" autocomplete="off"
        placeholder="stored as env var ${esc(p.key.toUpperCase())} — write-only">`;
    } else if (p.target === 'datasource') {
      // A git URL: becomes this copy's own git data source (deploy key and
      // all), cloned on first build — managed under Settings → Data after.
      input = `<input type="text" id="${id}" autocomplete="off" spellcheck="false"
        placeholder="git@github.com:owner/repo.git — becomes this copy's own data repo">`;
    } else if (p.type === 'longtext') {
      input = `<textarea id="${id}" rows="3">${esc(p.default ?? '')}</textarea>`;
    } else if (p.type === 'choice') {
      // An optional choice can be cleared with "(none)" (HB-0363), but starts,
      // as before, on its default or else its first option: left on a blank,
      // a click-through left {{key}} itself in the new agent's files.
      const pick = choiceStart(p.options ?? [], p.default ?? (p.options ?? [])[0]);
      input = `<select id="${id}">${p.required ? '' : `<option value=""${pick.trim() === '' ? ' selected' : ''}>(none)</option>`}${(p.options ?? []).map(o =>
        `<option${pick === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (p.type === 'multichoice') {
      const defaults = String(p.default ?? '').split(',').map(s => s.trim());
      input = `<div id="${id}" style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:6px">${(p.options ?? []).map(o =>
        `<label style="display:flex;gap:5px;align-items:center;font-weight:400;margin:0;width:auto;cursor:pointer">
          <input type="checkbox" data-opt="${esc(o)}"${defaults.includes(o) ? ' checked' : ''} style="width:auto;flex:none"> ${esc(o)}</label>`).join('')}</div>`;
    } else if (p.type === 'boolean') {
      input = `<label style="display:flex;gap:8px;align-items:center;font-weight:400;cursor:pointer">
        <input type="checkbox" id="${id}"${paramYes(p.default) ? ' checked' : ''} style="width:auto;flex:none"> Yes</label>`;
    } else {
      input = `<input type="text" id="${id}" value="${esc(p.default ?? '')}">`;
    }
    return `<label>${esc(p.label || p.key)}${star}</label>${help}${input}`;
  }).join('');
  return new Promise((resolve) => {
    paramFormResolve = resolve;
    paramFormDlg.showModal();
  });
}
// Esc / Cancel counts as Cancel — the pending promise must settle. Chrome
// delivers a dialog's close event with the next animation frame, which can be
// well after close(): Esc (the cancel event) and the Cancel button settle it
// at once, and a close event that finds the dialog open again belongs to an
// earlier form (a second import right behind the first), not to this one.
function settleParamForm(values) { const r = paramFormResolve; paramFormResolve = null; if (r) r(values); }
paramFormDlg.addEventListener('cancel', () => settleParamForm(null));
paramFormDlg.addEventListener('close', () => { if (!paramFormDlg.open) settleParamForm(null); });
function cancelParamForm() { settleParamForm(null); paramFormDlg.close(); }
function submitParamForm() {
  const values = {};
  for (let i = 0; i < paramFormFields.length; i++) {
    const p = paramFormFields[i], el = $(`pfv-${i}`);
    if (p.type === 'boolean') { values[p.key] = el.checked ? 'true' : 'false'; continue; }
    // A default the form showed and the owner cleared is sent as '' — left out,
    // the server put the default back (audit #066), as collectSetupValues says.
    // Credentials and repo fields show no default, so blank there is left out.
    const cleared = String(p.default ?? '').trim() !== '' && p.target !== 'env' && p.target !== 'datasource';
    if (p.type === 'multichoice') {
      const picks = [...el.querySelectorAll('input:checked')].map(c => c.dataset.opt);
      if (!picks.length && p.required) { $('paramFormErr').textContent = `“${p.label || p.key}” needs at least one pick.`; return; }
      if (picks.length || cleared) values[p.key] = picks.join(', ');
      continue;
    }
    const v = el.value.trim();
    if (!v) {
      if (p.required) { $('paramFormErr').textContent = `“${p.label || p.key}” is required.`; el.focus(); return; }
      // "(none)" picked on a choice is a value: blank, not {{key}} left in the files.
      if (cleared || (p.type === 'choice' && p.target !== 'env' && p.target !== 'datasource')) values[p.key] = '';
      continue; // empty optional with no default — let the template's own blank stand
    }
    values[p.key] = v;
  }
  const done = paramFormResolve;
  paramFormResolve = null;
  paramFormDlg.close();
  if (done) done(values);
}

/** The most of a .hatchabot file the import peek decompresses in the tab. A
 *  template is small (each file in it under 256 KB, at most 24 setup fields
 *  and 12 tasks); a full copy inlines the agent's whole volume, up to 256 MB. */
const IMPORT_PEEK_BYTES = 4 * 1024 * 1024;
/** How a template's manifest begins: the exporter writes `format` first. */
const TEMPLATE_HEAD = /^\s*\{\s*"format"\s*:\s*"(hatchabot|agentclaw)-template"/;
/** An import whose body carries the template's setup answers: one line of
 *  JSON, a newline, then the file. In the address (`?values=`, until v2.170.0)
 *  they passed Node's 16 KB limit and came back as a bare 431 (HB-0093). */
const IMPORT_WITH_VALUES = 'application/vnd.hatchabot.import';

// Reads a .hatchabot file's gzip only as far as it takes to tell a template
// from a full copy; a parsed template, or null for anything else. A full copy
// is a gzipped manifest with the agent's volume inlined (up to 256 MB):
// decompressing it whole, as the peek did until v2.166.0, froze a desktop
// and killed a phone's tab on the ordinary "restore my agent" path. Not gzip,
// not JSON, a copy, or past the cap: null, and the file is uploaded as it is
// for the server's own bounded peek to sort out.
async function peekImportTemplate(file, cap = IMPORT_PEEK_BYTES) {
  const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  try {
    const dec = new TextDecoder();
    let text = '', bytes = 0, judged = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += dec.decode(value, { stream: true });
      // Judged on the first bytes: a template declares itself at the start.
      if (!judged && text.length >= 64) { judged = true; if (!TEMPLATE_HEAD.test(text)) return null; }
      if (bytes > cap) return null;
    }
    text += dec.decode();
    if (!TEMPLATE_HEAD.test(text)) return null;
    return JSON.parse(text);
  } catch { return null; }
  finally { reader.cancel().catch(() => {}); }
}

// Import = open any .hatchabot file. The server sniffs it: a full backup is
// restored as the SAME agent (its bot and members ride along); a shared
// template stands up a FRESH agent that you give your own bot.
async function importAgentFile(file) {
  if (!file) return;
  try {
    // Peek inside first: a template that declares setup fields gets its form
    // BEFORE upload. Any peek failure (full backup, not gzip, old browser) is
    // fine — upload as-is and the server's own validation speaks.
    let body = file, type = 'application/octet-stream';
    let tpl = null;
    try { tpl = await peekImportTemplate(file); } catch { /* not a peekable template — the server sorts it out */ }
    if (['hatchabot-template', 'agentclaw-template'].includes(tpl?.format) && tpl.parameters?.length) {
      const values = await collectParamValues(tpl.parameters, tpl.name || file.name);
      if (values === null) return; // cancelled — don't upload
      // The answers go ahead of the file in the body, so any number fits.
      body = new Blob([JSON.stringify({ values }) + '\n', file]);
      type = IMPORT_WITH_VALUES;
    }
    // A template is a new agent, so it starts without Telegram (2026-11-07); a full copy
    // brings its own bot back, and the server refuses "no Telegram" for one.
    const noBot = ['hatchabot-template', 'agentclaw-template'].includes(tpl?.format) ? 'telegram=0' : '';
    const send = async (q) => {
      const qs = [noBot, q].filter(Boolean).join('&');
      const res = await sfFetch(`/v1/agents/import${qs ? '?' + qs : ''}`, {
        method: 'POST',
        headers: { 'content-type': type },
        body,
      });
      return [res, await res.json().catch(() => ({}))];
    };
    let [res, data] = await send('');
    if (res.status === 409 && data.code === 'image_decision') {
      const choice = imageDecision(data);
      if (!choice) return;
      if (choice === 'build') toast(`Building ${data.image}… this takes a few minutes`, 20000);
      [res, data] = await send(`image=${choice}`);
    }
    if (!res.ok) throw new Error(data.error || data.message || 'Import failed');
    if (data.kind === 'template') {
      const needs = [];
      for (const d of (data.needs?.dataSources ?? [])) needs.push(`${d.kind} “${d.mountName}”`);
      for (const n of (data.needs?.envVars ?? [])) needs.push(`env ${n}`);
      const tail = needs.length ? ` — set up in ⚙ Configuration: ${needs.join(', ')}` : '';
      toast(`Imported “${data.name}” — ${noBot ? 'it runs here in Hatchabot; give it a Telegram bot from its Telegram tab if you want one' : "connect its Telegram bot, then it's yours"}${tail}`, 45000);
    } else if (data.operation?.id) {
      // A full copy goes on on the server (202, v2.156.0): its tile shows each step, a toast the end.
      v2FollowOp(data.operation);
      toast(`Importing “${data.agent?.name || file.name}” — its tile shows each step; this page can close.`, 8000);
    } else {
      toast(`${data.name} restored — booting`);
    }
    await refresh(true);
  } catch (e) { toast(e.message, 30000); }
  finally { $('importFile').value = ''; }
}

// A file pinned to an image this machine lacks: show what building it would
// run, BEFORE anyone agrees to it. 'build' | 'drop' | null (cancelled).
function imageDecision(d) {
  const r = d.recipe;
  const what = r ? `\n\nFROM ${r.base}${r.packages?.length ? `\napt packages: ${r.packages.join(' ')}` : ''}${r.lines ? `\n${r.lines}` : ''}` : '';
  if (d.mayBuild && confirm(`${d.error}${what}\n\nBuild this image here? These lines run as root while it builds (a few minutes).`)) return 'build';
  return confirm(`Run it on the default image instead? Whatever the pinned image adds will be missing.${d.mayBuild ? '' : what}`) ? 'drop' : null;
}

// Share = a trained copy for someone else. It downloads a file (you send it);
// the recipient's Import stands up a fresh agent with its own bot.
let sendAgentId = null, sendOpening = null;
/** A copy is checked and sent for this opening and signed-in person only. */
function sendCurrent(opening) {
  return !!opening && opening === sendOpening && sendAgentDlg.open && opening.epoch === sharingEpoch && opening.person === pagePerson
    && !pagePersonAway && !pageSignedOut && !!v2Find(opening.id) && v2Mine(v2Find(opening.id));
}
function openSendAgent(id, name) {
  sendAgentId = id;
  const opening = sendOpening = { id, epoch: sharingEpoch, person: pagePerson };
  $('sendBtn').disabled = false;
  $('sendAgentName').textContent = name;
  $('sendToEmail').value = ''; $('sendMessage').value = ''; $('sendErr').textContent = '';
  // What the copy mentions, before anything leaves (2026-09-30). The send
  // carries no MEMORY.md, so the scan leaves it out too.
  const scan = $('sendScan');
  scan.style.color = ''; scan.textContent = 'Checking what the copy mentions…';
  api(`/v1/agents/${id}/export/scan?excludeMemory=1`).then(p => {
    if (!sendCurrent(opening)) return;
    const what = personalSummary(p), edits = editedNote(p);
    const editsHtml = edits ? `<div style="margin-top:6px">${esc(edits)}</div>` : '';
    if (edits) scan.style.color = 'var(--warn)';
    if (!what) { scan.innerHTML = esc('The copy mentions no email addresses, phone numbers or keys.') + editsHtml; return; }
    scan.style.color = 'var(--warn)';
    scan.innerHTML = `This copy mentions <b>${esc(what)}</b> — read it before you send it.
      <details><summary>Where</summary><div>${(p.hits || []).map(h => `${esc(h.where)}, line ${Number(h.line) || 0}: <span class="pii">${esc(h.sample)}</span>`).concat(p.more ? [`…and ${Number(p.more)} more`] : []).join('<br>')}</div>
      <div>Fix them in its Personality or Files, then send.</div></details>${editsHtml}`;
  }).catch(e => { if (sendCurrent(opening)) scan.textContent = `Couldn't check what the copy mentions: ${e.message}`; });
  $('accountEmails').textContent = '';
  api('/v1/accounts').then(r => {
    if (!sendCurrent(opening)) return;
    $('accountEmails').innerHTML = (r.accounts || []).filter(a => a.email).map(a => `<option value="${esc(a.email)}">`).join('');
  }).catch(() => {});
  sendAgentDlg.showModal();
}
async function doSendAgent() {
  const opening = sendOpening;
  if (!sendCurrent(opening) || $('sendBtn').disabled) return;
  const toEmail = $('sendToEmail').value.trim();
  if (!toEmail) { $('sendErr').textContent = 'Enter a recipient email.'; return; }
  $('sendBtn').disabled = true;
  try {
    await api(`/v1/agents/${opening.id}/send`, { method: 'POST', body: { toEmail, message: $('sendMessage').value.trim() || undefined } });
    if (!sendCurrent(opening)) return;
    sendAgentDlg.close();
    toast(`Sent to ${toEmail} — it's in their inbox.`);
  } catch (e) { if (sendCurrent(opening)) $('sendErr').textContent = e.message; }
  finally { if (sendCurrent(opening)) $('sendBtn').disabled = false; }
}
sendAgentDlg.addEventListener('close', () => { if (!sendAgentDlg.open) sendOpening = null; });

// ---- inbox: agents others sent me ------------------------------------------
async function openInbox() { inboxDlg.showModal(); loadInbox(); }
let inboxShares = []; // last-loaded shares — acceptShare needs their .parameters
let inboxRead = 0, inboxBadgeRead = 0;
function inboxSession() {
  const epoch = sharingEpoch, person = pagePerson;
  return () => epoch === sharingEpoch && person === pagePerson && !pagePersonAway && !pageSignedOut;
}
async function loadInbox() {
  const el = $('inboxBody');
  const current = inboxSession(), read = ++inboxRead;
  try {
    const { shares } = await api('/v1/inbox');
    if (!current() || read !== inboxRead) return;
    inboxShares = shares;
    updateInboxBadge(shares.length);
    if (!shares.length) { el.innerHTML = '<div class="sub">Nothing waiting. Agents other users send you appear here.</div>'; return; }
    el.innerHTML = shares.map(s => `<div class="pair" style="flex-wrap:wrap;gap:8px;align-items:flex-start">
      <div class="grow"><b>${esc(s.agentName)}</b>
        <div class="sub">from ${esc(s.fromEmail || 'another user')} · ${ago(s.createdAt)}${s.message ? ' — ' + esc(s.message) : ''}</div></div>
      <button class="primary" ${onAction('click', 'acceptShare', [`${s.id}`, `${s.agentName ?? ''}`])}>Import</button>
      <button ${onAction('click', 'dismissShare', [`${s.id}`])} title="Turn it away">Dismiss</button>
    </div>`).join('');
  } catch (e) { if (current() && read === inboxRead) el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
async function acceptShare(id, name) {
  const current = inboxSession();
  if (!current()) return;
  const cn = prompt(`Import "${name}" as — name it (it becomes a fresh agent you own, with a spare bot from your pool if there is one):`, name);
  if (cn === null) return;
  const body = { name: cn };
  // Templates with setup fields ask for their values before the accept.
  const share = inboxShares.find(s => s.id === id);
  if (share?.parameters?.length) {
    const values = await collectParamValues(share.parameters, name);
    if (values === null || !current()) return;
    body.values = values;
  }
  try {
    const r = await api(`/v1/inbox/${id}/accept`, { method: 'POST', body });
    if (!current()) return;
    toast(`Imported as "${r.name}" — it takes a spare bot from your pool; with none free it starts in the web app and you attach one later.`, 30000);
    await loadInbox(); await refresh(true);
  } catch (e) { if (current()) toast(e.message, 20000); }
}
async function dismissShare(id) {
  const current = inboxSession();
  if (!current()) return;
  try { await api(`/v1/inbox/${id}/dismiss`, { method: 'POST' }); if (current()) await loadInbox(); }
  catch (e) { if (current()) toast(e.message); }
}
function updateInboxBadge(n) {
  // The header's inbox button only shows while something is waiting.
  $('v2InboxBtn').hidden = !(n > 0);
  $('v2InboxCount').textContent = n > 0 ? String(n) : '';
}
async function refreshInboxBadge() {
  const current = inboxSession(), read = ++inboxBadgeRead;
  try { const { shares } = await api('/v1/inbox'); if (current() && read === inboxBadgeRead) updateInboxBadge(shares.length); } catch {}
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

async function shareTemplate(id, name) {
  // Only MEMORY.md travels: its daily notes (memory/) never do (2026-09-30).
  const pick = await askChoice(`Share a copy${name ? ` of ${name}` : ''}`,
    'Its instructions and scheduled tasks, without its bot, members or conversations.\n\nMEMORY.md (its summary notes) may contain personal facts.',
    [['memory', 'Also MEMORY.md'], ['plain', 'Instructions and tasks only']]);
  if (!pick) return;
  return saveFromServer(`/v1/agents/${id}/export${pick === 'memory' ? '' : '?excludeMemory=1'}`, 'agent-template.json', personalCheck);
}

// What a shared copy mentions about real people, as the server found it
// (x-hatchabot-personal): "13 email addresses and 2 phone numbers". Agents
// write notes into their own instructions, so a copy is read before it is sent
// (2026-09-30).
function personalSummary(p) {
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const parts = [
    p?.emails ? n(p.emails, 'email address', 'email addresses') : '',
    p?.phones ? n(p.phones, 'phone number', 'phone numbers') : '',
    p?.tokens ? n(p.tokens, 'thing that looks like a password or key', 'things that look like passwords or keys') : '',
  ].filter(Boolean);
  return parts.length < 2 ? (parts[0] || '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
function personalWhere(p) {
  return (p?.hits || []).map(h => `${h.where}, line ${h.line}: ${h.sample}`)
    .concat(p?.more ? [`…and ${p.more} more`] : []);
}
// A configured copy travels as its setup version ({{fields}} and all); the
// files the agent or its console changed since the values were applied are
// not in it (HB-0117). The server names them (edited).
function editedNote(p) {
  const f = (Array.isArray(p?.edited) ? p.edited : []).filter(n => n === 'SOUL.md' || n === 'AGENTS.md');
  if (!f.length) return '';
  const files = f.join(' and ');
  return `Its ${files} ${f.length === 1 ? 'was' : 'were'} changed outside the Files editor (by the agent itself, or in its console) after its setup values were applied. ` +
    `The copy carries its setup version, without those changes. To include them, open ${files} in its Files and save it there, ` +
    'putting {{field}} back wherever a copy should give its own answer.';
}
/** Ask before saving a copy that mentions people, or leaves out edits. False = don't save. */
function personalCheck(res) {
  let p = null;
  try { p = JSON.parse(decodeURIComponent(res.headers.get('x-hatchabot-personal') || '')); } catch { p = null; }
  const what = personalSummary(p), edits = editedNote(p);
  if (!what && !edits) return true;
  return confirm([
    what ? `This copy mentions ${what} — read it before you send it.\n\n` +
      `Where (fix them in its Personality or Files, then share again):\n• ${personalWhere(p).join('\n• ')}` : '',
    edits,
  ].filter(Boolean).join('\n\n') + "\n\nOK — save the file anyway. Cancel — don't save it.");
}

/**
 * Fetch a download and save it, instead of navigating to it: a refusal (busy,
 * not exportable) is then a message, not a page of raw JSON in place of the app.
 * `check(res)` may still refuse once the answer is in (false = don't save).
 */
async function saveFromServer(url, fallbackName, check) {
  try {
    const res = await sfFetch(url);
    if (!res.ok) { const j = await res.json().catch(() => ({})); toast(j.error || `The download failed (${res.status}).`, 10000); return; }
    if (check && !check(res)) { toast('Not saved.'); return; }
    const blob = await res.blob();
    const file = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName;
    const href = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href, download: file });
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    toast(`Saved ${file}.`);
  } catch (e) { toast(e.message, 8000); }
}

// Clone = a faithful local copy (MEMORY.md, its daily notes and USER.md — you own both), with its own
// name; only you as owner. Without Telegram, as every new agent starts (2026-11-07): a bot is one
// click on its Telegram tab.
// ---- template gallery (discovery over clone) --------------------------------

function openGallery() { galleryDlg.showModal(); renderGallery(); }
function createFromScratch() { galleryDlg.close(); $('fabBtn').click(); }

function renderGallery() {
  // Your own live agents are the catalog (clone requires ownership). Children
  // and members' chat-only cards aren't useful starting points.
  const mine = (agents ?? []).filter(a =>
    (a.role ? a.role === 'owner' : true) && !a.ops &&
    a.state !== 'DELETED' && a.state !== 'ARCHIVED' && !a.parentAgentId);
  if (!mine.length) { $('galleryBody').innerHTML = '<div class="sub">No agents yet to start from — create a blank one first.</div>'; return; }
  $('galleryBody').innerHTML = mine.map(a => {
    const wiring = [];
    if (a.parameters?.length) wiring.push(`${a.parameters.length} setup field${a.parameters.length > 1 ? 's' : ''}`);
    const ds = (a.dataSources ?? []).length; if (ds) wiring.push(`${ds} data source${ds > 1 ? 's' : ''}`);
    if ((a.envVars ?? []).length) wiring.push('env credentials');
    const tag = wiring.length ? `<span class="sub"> · sets up ${wiring.join(', ')}</span>` : '';
    return `<div class="pair" style="align-items:flex-start;gap:10px">
      <span class="grow">
        <b>${esc(a.name)}</b>${tag}
        ${a.persona ? `<div class="sub" style="margin-top:2px">${esc(String(a.persona).replace(/\s+/g, ' ').slice(0, 130))}${String(a.persona).length > 130 ? '…' : ''}</div>` : '<div class="sub" style="margin-top:2px;opacity:.7">No description.</div>'}
      </span>
      <button class="primary" ${onAction('click', 'closeDialog cloneAgent', [["galleryDlg"], [`${a.id}`, `${a.name ?? ''}`]])} title="Create your own copy of ${esc(a.name)}">Start from this →</button>
    </div>`;
  }).join('');
}

async function cloneAgent(id, name) {
  const cn = prompt(`Name for the clone of "${name}":`, `${name} (copy)`);
  if (cn === null) return;
  try {
    const res = await api(`/v1/agents/${id}/clone`, { method: 'POST', body: { name: cn, telegram: false } });
    let left = (res.notCopied || []).length ? ` Its data sources (${res.notCopied.join(', ')}) did not come along: add them under Data.` : '';
    // A variable whose value could not be read stayed behind (review, 2026-10-22).
    if ((res.envNotCopied || []).length) left += ` Its variables ${res.envNotCopied.join(', ')} could not be read, so the copy does not have them: add them under Advanced → Extra credentials.`;
    // Its model, where the copy's AI source does not offer it (HB-1165).
    if (res.modelNotCopied) left += ` Its model ${res.modelNotCopied} is not one its AI source offers, so the copy runs on that source's default.`;
    // Its daily notes come too (2026-09-30); say when some could not.
    if (res.memoryCopyFailed) left += " Its daily notes (memory/) and USER.md couldn't be read, so only MEMORY.md came along.";
    else if ((res.memoryNotCopied || []).length) left += ` Some memory files were too big, not text or unreadable and stayed behind: ${res.memoryNotCopied.slice(0, 5).join(', ')}${res.memoryNotCopied.length > 5 ? '…' : ''}.`;
    toast(`Cloned as "${res.name}" — it runs here in Hatchabot, without a Telegram bot; give it one from its Telegram tab when you want it.${left}`, 30000);
    await refresh(true);
  } catch (e) { toast(e.message, 30000); }
}


async function approve(id, code, asSelf, kind = 'telegram', who = '') {
  // "That's me" is the one tap that grants an identity rather than a seat: it
  // binds that chat account to YOUR account, so every agent you make from then
  // on admits it at birth. A mis-tap on a stranger's card would hand them the
  // run of the fleet, and the name on that card is theirs to choose — so this
  // one asks, and says the name back.
  if (asSelf && !confirm(`Link ${who || 'this account'} to you?\n\nOnly do this if that is YOUR OWN ${V2_CHAN_LABEL[kind] || kind} account. It becomes your identity everywhere: every agent you create will admit it without asking.\n\nIf it is somebody else, press Cancel and use "Let them in" instead.`)) return;
  try {
    const res = await api(`/v1/agents/${id}/pairing/approve`, { method: 'POST', body: { code, kind, ...(asSelf ? { asSelf: true } : {}) } });
    pairingsDrop(id, code, kind);
    if (asSelf && kind !== 'telegram') {
      toast(`Linked — that ${V2_CHAN_LABEL[kind] || kind} account is you on this agent.`, 6000);
    } else if (asSelf) {
      toast('Linked — this Telegram is you now. Every agent you make admits you automatically.', 8000);
      loadMyAccount(); // the card + Settings reflect the link immediately
    } else {
      toast(res.member?.alreadyMember
        ? `${res.member.displayName} is already a member — access restored`
        : `${res.member?.displayName ?? 'Guest'} is in — now a member`);
    }
    pairTick = 0; // refetch members on next poll
    await refresh(false);
  } catch (e) { toast(e.message); }
}

// The caller's own account (email + linked Telegram). Drives the "That's me"
// button on pairing cards and the Telegram line under Settings → You.
let myAccount = {};
/**
 * What only the machine's owner can use, hidden from anyone else: every save
 * there would be refused (HB-0443). Only on a known "no": a failed read of the
 * account leaves them showing, and the server guards them either way.
 */
function paintMachineOwnerOnly() {
  for (const id of ['extraKeysHead', 'mediaKeyDrawer', 'searchKeyDrawer', 'addRunnerBlock', 'botInvDrawer']) $(id).hidden = myAccount.hostOwner === false;
}
/**
 * Who this page is for. Sign out reloads, but a session that ends by a 401 and a
 * sign-in do not, so the page itself outlives the person (HB-0446). When the session
 * ends the chat leaves the page at once; what it held waits, out of sight, until the
 * next account is read. The same account gets it back. Another finds nothing of the
 * last one's, here or in what the page held for them. Read again on each meta refresh,
 * which also catches another tab having signed in as someone else.
 */
let pagePerson = null, pagePersonAway = false, pagePersonRead = 0, pageCleared = false, pageSignedOut = false;
function pageSessionEnded() {
  sfDrop(); // a request waiting on a prompt for this session is not sent under the next one
  sharingForget();
  bpClose(); // pictures and unsent sign-in text must not remain under the sign-in screen
  v2VoiceForget();
  v2SkillsForget();
  if ($('consoleDlg').open) closeConsole(); // voice input and console sessions end with this sign-in
  pageSignedOut = true;
  pagePersonAway = true; pageCleared = false;
  window.__sfEnrolShown = false; // whoever comes next is taken to add a factor if they need one
  pagePersonRead++; // a read begun in that session does not say who comes next
  pageSecretsPutAway();
  webChatPutAway();
}
function pagePersonIs(ownerId) {
  if (!ownerId) return;
  const another = pagePerson ? pagePerson !== ownerId : pagePersonAway;
  const changed = !!pagePerson && pagePerson !== ownerId; // this page showed someone else (not: it never knew who)
  pagePerson = ownerId; pagePersonAway = false; pageSignedOut = false; // a read that works: signed in (here, or in another tab)
  if (sfPending?.for && sfPending.for !== ownerId) sfDrop(); // raised for someone else
  const cleared = pageCleared; pageCleared = false;
  if (another) {
    webChatForget();
    if (!cleared) pageClearLast(ownerId);
  }
  pageSecretsBack(ownerId);
  if (changed) { pageReloadWanted = true; pageReloadWhenQuiet(); }
}
/**
 * Another account than the one this page showed: the page loads again, so nothing of the last person's is left in
 * it, in a field or in what the page held for them (HB-0491). pageClearLast has already taken off what it knows of,
 * which covers the wait. Not while a second-factor step is under way, which a reload would lose: a sign-in still
 * finishing (and the recovery code it shows), the second-factor prompt (a passkey's included) and the request it was
 * asked for, an authenticator app being added, a passkey being made, a request for new codes, backup codes or a
 * recovery code on the screen or waiting for their person. Each of those asks again when it ends.
 */
let pageReloadWanted = false, pageReloadTimer = 0, pageSignIns = 0, pageHolds = 0;
/** location.reload(), on its own: the click-through check cannot follow a reload, so it puts a counter here. */
function pageReload() { location.reload(); }
/** A sign-in form at work, from its first request to the end of pageSignedIn (with what it shows); the sign-in screen itself is loginDlg.open. */
function pageSignInEnded() { pageSignIns--; pageReloadWhenQuiet(); }
async function pageSigningIn(fn) { pageSignIns++; try { return await fn(); } finally { pageSignInEnded(); } }
/** A request whose answer must be seen (new codes, a setup, a passkey being made, what a prompt was for): held until it settles. */
async function pageHold(fn) { pageHolds++; try { return await fn(); } finally { pageHolds--; pageReloadWhenQuiet(); } }
function pageSecondFactorBusy() {
  return pageSignIns > 0 || pageHolds > 0 || loginDlg.open || sfDlg.open || (aiDlg.open && !$('sfTotpBox').hidden)
    || backupDlg.open || recoveryDlg.open || pageSecretsAway.length > 0;
}
function pageReloadWhenQuiet() {
  if (!pageReloadWanted || pageReloadTimer) return;
  // A task later: what the same task goes on to open (backup codes, once an app is confirmed) is under way by then.
  pageReloadTimer = setTimeout(() => {
    pageReloadTimer = 0;
    if (!pageReloadWanted || pageSecondFactorBusy()) return;
    pageReloadWanted = false;
    pageReload();
  }, 0);
}
// Settings closed (an app's setup left open there is let go), or a dialog shut by Escape.
document.addEventListener('DOMContentLoaded', () => {
  for (const id of ['sfDlg', 'aiDlg']) $(id)?.addEventListener('close', () => pageReloadWhenQuiet());
});
/**
 * A one-time secret on the screen, backup codes or a recovery code, is its person's to read until they say they have
 * saved it (HB-0500). When the session ends it leaves the page, so it is not left under the sign-in for whoever is at the
 * keyboard, and waits with whose it is. A read that names that person shows it again; a read that names anyone else, and
 * it is gone, and what waited on it goes on. Whose: what the server said, and only that. One shown without an owner is
 * nobody's: it is not given back to anyone (a read never claims it for whoever happens to be signed in by then).
 */
const pageSecretOwner = new Map();
let pageSecretsAway = [];
/**
 * A secret that answered after this page was read to be someone else's (a request in flight while another tab signed in
 * as another account): not shown to them. The page is about to load again for them anyway (HB-0491).
 */
function pageSecretNotHere(ownerId) {
  if (!ownerId || !pagePerson || pagePersonAway || ownerId === pagePerson) return false;
  toast('New codes were made for the account signed in before, and are not shown to this one. Sign in as it and make new ones in Settings → You.', 10000);
  return true;
}
/** Answered after the session ended, before a read names who is here now: not shown, but waiting for its person, as one open then does. */
function pageSecretLater(whose, show) {
  const waiting = new Promise((res) => { pageSecretsAway.push({ whose: whose || '', back: () => show().then(res), drop: () => res() }); });
  // Signed in, but not read yet (a first factor added at the public address): read now, so they come back at once.
  if (!loginDlg.open && !pageSignIns) loadMyAccount().catch(() => {});
  return waiting;
}
function pageSecretShown(dlg, ownerId) {
  pageSecretOwner.set(dlg, ownerId || '');
}
function pageSecretsPutAway() {
  if (backupDlg.open) {
    const codes = $('backupCodes').textContent.split('\n'), whose = pageSecretOwner.get(backupDlg), done = backupResolve;
    backupResolve = null;
    $('backupCodes').textContent = ''; backupDlg.close();
    pageSecretsAway.push({ whose, back: () => showBackupCodes(codes, whose).then(done), drop: () => done?.() });
  }
  if (recoveryDlg.open) {
    const code = $('recoveryCode').textContent, lede = $('recoveryLede').innerHTML, whose = pageSecretOwner.get(recoveryDlg), done = recoveryResolve;
    recoveryResolve = null;
    $('recoveryCode').textContent = ''; recoveryDlg.close();
    pageSecretsAway.push({ whose, back: () => showRecoveryCode(code, lede, whose).then(done), drop: () => done?.() });
  }
}
function pageSecretsBack(ownerId) {
  const away = pageSecretsAway;
  pageSecretsAway = [];
  for (const s of away) (s.whose && s.whose === ownerId ? s.back : s.drop)();
}
/** `next`: who has just been read, whose own one-time secret on the screen stays. */
function pageClearLast(next = '') {
  sharingForget();
  v2VoiceForget();
  v2SkillsForget();
  v2Close();
  bpClose();
  if ($('consoleDlg').open) closeConsole();
  consoleTabs = [];
  pairingsDrop(); // who knocked on the last person's agents, with their names and the buttons to let them in
  const theirs = (dlg) => !!next && dlg.open && pageSecretOwner.get(dlg) === next;
  if (backupDlg.open && !theirs(backupDlg)) closeBackupCodes(); // off the page too, and what waits on them goes on
  sfCloseTotp(); $('sfCurPw').value = ''; // Access is drawn again for whoever comes next: not a setup or a password of the last person's
  const keep = [backupDlg, recoveryDlg].filter(theirs).map((d) => `:not(#${d.id})`).join('');
  document.querySelectorAll(`dialog[open]:not(#loginDlg):not(#sfDlg)${keep}`).forEach((d) => d.close());
  recoveryCodeClosed(); // its code off the page, and what waits on it goes on, now (unless it is theirs, and open)
  aiRowsDrawn = {}; moveSourceState = null; applyModelState = null; migrateState = null;
  reportCur = null; reportGen++; reportLoading = null; // a draft still loading does not paint
  $('reportDrafts').replaceChildren();
  for (const id of ['reportTitle', 'reportWhat', 'reportRTitle', 'reportBody']) $(id).value = '';
  // What the last person typed and did not save: every password box (keys, tokens, client secrets, current passwords),
  // every free-text box and form, back to what the page drew. Not the sign-in or the prompt, which are this person's (HB-0498, HB-0491).
  for (const el of document.querySelectorAll('input, textarea')) {
    if (el.closest('#loginDlg, #sfDlg') || /^(checkbox|radio|hidden|button|submit|reset|file|range|color)$/i.test(el.type)) continue;
    el.value = el.type === 'password' ? '' : el.defaultValue;
  }
}
/**
 * A sign-in landed. Who it is comes first, so nothing of another account's is drawn for them, and what the path shows next is not closed.
 * `show`: what this sign-in brought to be read once (a recovery code), shown here so a reload for another account waits for it (HB-0491).
 */
async function pageSignedIn(show) {
  try {
    await loadMyAccount();
    // Not told who: no second factor yet (Access is open for them to add one), or the read failed. What was open for the last person goes now,
    // because the read that later succeeds must not close what this one has opened by then: their backup codes, a recovery code. Drafts wait for that read.
    if (pagePersonAway && !pageCleared) {
      pageClearLast();
      pageCleared = true;
      if (window.__sfEnrolShown && !aiDlg.open) void openAiDlg('access'); // drawn for them, not what the last person left
    }
    await refresh(true);
  } finally {
    show?.(); // before the sign-in ends (pageSignInEnded): a reload waits for it
  }
}
async function loadMyAccount() {
  const read = ++pagePersonRead;
  try {
    const account = await api('/v1/account');
    if (read !== pagePersonRead) return;
    myAccount = account;
    pagePersonIs(myAccount.ownerId);
  } catch { if (read !== pagePersonRead) return; myAccount = {}; }
  paintMachineOwnerOnly();
  loadRebuildPolicy(); // the cards' wording depends on it
  const el = $('tgLinkStatus');
  if (el) el.innerHTML = myAccount.telegramUserId
    ? `✓ Linked (Telegram id <code class="pii">${esc(myAccount.telegramUserId)}</code>) — agents you create admit you automatically.
       <button class="hbtn" ${onAction('click', 'unlinkTelegram')}>Unlink</button>`
    : `Not linked — message one of your agents on Telegram and choose <b>That's me — link</b> on the request card.
       Linked, every agent you create admits your Telegram without pairing again.`;
  const dc = $('dcLinkStatus');
  if (dc) dc.innerHTML = myAccount.discordUserId
    ? `✓ Linked (Discord id <code class="pii">${esc(myAccount.discordUserId)}</code>) — every Discord bot you attach admits you from its first build.
       <button class="hbtn" ${onAction('click', 'unlinkDiscord')}>Unlink</button>`
    : `Not linked — send one of your agents a direct message on Discord and choose <b>That's me</b> on the request card.
       Linked, every Discord bot you attach admits you without pairing again.`;
}

async function unlinkDiscord() {
  if (!confirm('Unlink your Discord from this login?\n\nYour agents forget your Discord identity: each asks again ("That\'s me") the next time you message it, and stops admitting it at its next rebuild.')) return;
  try {
    await api('/v1/account/discord', { method: 'DELETE' });
    toast('Unlinked.');
    loadMyAccount();
  } catch (e) { toast(e.message); }
}

async function unlinkTelegram() {
  if (!confirm('Unlink your Telegram from this login?\n\nExisting agents keep working — only agents created afterwards stop admitting this Telegram automatically.')) return;
  try {
    await api('/v1/account/telegram', { method: 'DELETE' });
    toast('Unlinked.');
    loadMyAccount();
  } catch (e) { toast(e.message); }
}

async function denyPair(id, code, who, kind = 'telegram') {
  // "Not now", not a ban — say so, so nobody assumes this blocks them for good.
  if (!confirm(`Turn away ${who}'s request to talk to this agent?\n\nThey are not blocked — they can ask again by messaging the bot.`)) return;
  try {
    const r = await api(`/v1/agents/${id}/pairing/deny`, { method: 'POST', body: { code, kind } });
    pairingsDrop(id, code, kind); // turned away, or no longer there: either way not to be answered again
    toast(r.denied ? `${who}'s request was turned away` : 'That request is no longer pending');
    pairTick = 0; // refetch pairing on the next poll so the card/badge clears
    await refresh(false);
  } catch (e) { toast(e.message); }
}

/** Agents this account can rebuild right now (owned, live-or-stopped, not moved away). */
// Word the update prompt from the two OpenClaw versions, so a same-version
// image rebuild (e.g. new base tooling) isn't mislabelled as a version upgrade.
function updateBlurb(a) {
  const from = a.openclawVersion, to = a.latestOpenclawVersion;
  if (from && to && from !== to)
    return `OpenClaw ${esc(from)} → ${esc(to)} is ready. Rebuild applies it — memory is kept.`;
  return `A newer runtime image is ready${to ? ` (same OpenClaw ${esc(to)})` : ''}. Rebuild applies it — memory is kept.`;
}

/** Rebuild reasons other than the newer image (which has its own ⬆ Update row). */
function rebuildOtherReasons(a) {
  return (a.rebuild?.reasons ?? []).filter(r => !/newer runtime image|^the fleet default (moved to|image was rebuilt)/.test(r));
}

// The machine's rebuild policy (Runtime tab; machine owner sets it).
let rebuildPolicyNow = 'required-only';
const REBUILD_POLICY_TEXT = {
  'required-only': 'Required rebuilds happen on their own, once an agent is idle. Others wait for you.',
  auto: 'Required rebuilds happen once an agent is idle; the rest overnight (quiet hours).',
  manual: 'Nothing happens on its own — the cards say what needs a rebuild.',
};
/** Automatic rebuilds, under Settings → Hosts since v2.157.0: the machine owner's. */
function loadRebuildSection() {
  $('rbSection').hidden = $('rbHead').hidden = !myAccount.hostOwner;
  if (myAccount.hostOwner) void loadRebuildPolicy();
}
async function loadRebuildPolicy() {
  void loadRebuildAtOnce();
  try {
    const r = await api('/v1/rebuild-policy');
    rebuildPolicyNow = r.policy;
    const sel = $('rbPolicy'); if (!sel) return;
    sel.value = r.policy;
    $('rbPolicyNote').textContent = REBUILD_POLICY_TEXT[r.policy] + (r.policy === 'auto' ? ` Quiet hours: ${r.quietHours}h.` : '');
  } catch { /* older server — leave the default */ }
}
async function loadRebuildAtOnce() {
  try {
    const r = await api('/v1/rebuild-concurrency');
    const sel = $('rbAtOnce'); if (!sel) return;
    sel.innerHTML = Array.from({ length: r.max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    sel.value = String(r.atOnce);
    if (appConfig) appConfig.rebuildConcurrency = r.atOnce;
  } catch { /* older server */ }
}
async function setRebuildAtOnce(n) {
  try { await api('/v1/rebuild-concurrency', { method: 'PUT', body: { atOnce: Number(n) } }); toast(`Rebuilds at once: ${n}`); if (appConfig) appConfig.rebuildConcurrency = Number(n); }
  catch (e) { toast(e.message, 12000); }
  loadRebuildAtOnce();
}
async function setRebuildPolicy(policy) {
  try {
    await api('/v1/rebuild-policy', { method: 'PUT', body: { policy } });
    toast('Rebuild policy saved');
  } catch (e) { toast(e.message, 12000); }
  loadRebuildPolicy();
}


/**
 * Archive / Restore. Bot tokens are capped per Telegram account, so this is how
 * a fleet grows past the number of bots you can own: park the agent whole and
 * hand the bot to someone else. The confirm text leads with the part that can't
 * be undone quietly — the chat address changes.
 */
let archivePending = null;
/** Where its bot goes, as the server decides it (archive.ts copyElsewhere): the same split as del(), and nothing about a bot when it has none (HB-0418). */
const archiveBotLeftToCopy = (a, state) => !!a?.botUsername && !!a.exportedAt && state !== 'RUNNING';
function archiveBotWords(a, state) {
  if (!a?.botUsername) return '';
  const restore = 'When you restore it, it gets a DIFFERENT bot with a new link to send to members; the current link stops working.';
  return archiveBotLeftToCopy(a, state)
    ? `A copy of it was downloaded, so its Telegram bot @${a.botUsername} is NOT put back in the pool: it is left to the copy, which may be talking on it. ${restore}`
    : `Its Telegram bot goes back in the pool for another agent to use, and members are told in the chat. ${restore}`;
}
function archiveAgent(id, name, state) {
  archivePending = { id, name };
  $('archiveName').textContent = `"${name}"`;
  $('archiveBotNote').textContent = archiveBotWords(agents.find(a => a.id === id), state);
  // A checkpoint needs a live turn — only offer it for a RUNNING agent.
  const running = state === 'RUNNING';
  $('archiveCheckpointRow').style.display = running ? 'flex' : 'none';
  $('archiveCheckpoint').checked = true; // shared control — reset to the safe default each open
  archiveDlg.showModal();
}
/** Archives this page started and the server has not finished: the tile says
 *  "Archiving…" from the click, not from the first poll that sees it — the
 *  checkpoint turn alone is ~20 s, and an unchanged tile read as a failed
 *  click (2026-10-07). The list's own `archiving` takes over once it has it. */
const archivingHere = new Map();
function markArchiving(list) {
  for (const a of list || []) {
    const mine = archivingHere.get(a.id);
    if (mine && !a.archiving && a.state !== 'ARCHIVED') a.archiving = mine;
  }
}
async function confirmArchive() {
  if (!archivePending) return;
  const { id, name } = archivePending;
  const was = agents.find(a => a.id === id);
  const botLeft = (b) => !b ? '' : b.outcome === 'left-to-copy' ? ` — bot @${b.username} was left to the downloaded copy, not put back in the pool`
    : b.outcome === 'not-parked' ? ` — its bot @${b.username} could not be put back in the pool; to use it again, paste its token into an agent` : ' — its bot is back in the pool';
  // What the server says happened to the bot (HB-0476); a server too old to say: what should have.
  const predicted = !was?.botUsername ? '' : botLeft({ username: was.botUsername, outcome: archiveBotLeftToCopy(was, was.state) ? 'left-to-copy' : 'pool' });
  const checkpoint = $('archiveCheckpointRow').style.display !== 'none' && $('archiveCheckpoint').checked;
  // Closed at once: the tile carries the progress from here.
  archivePending = null;
  archiveDlg.close();
  archivingHere.set(id, { at: new Date().toISOString(), step: checkpoint ? 'archiving — saving its conversation to memory first' : `archiving — stopping it${was?.botUsername ? ' and handing its bot back' : ''}` });
  markArchiving(agents);
  renderV2();
  toast(checkpoint ? `Archiving "${name}" — saving its conversation to memory first (about 20 seconds)…` : `Archiving "${name}"…`, 30000, 'progress');
  try {
    const r = await api(`/v1/agents/${id}/archive`, { method: 'POST', body: { checkpoint } });
    archivingHere.delete(id);
    // Nothing of it stays open: its console tab closes, and its page with it, so
    // the next click can't land on the Restore that replaces Chat there
    // (2026-10-07: an agent was restored 12 minutes after being archived that way).
    if (consoleTabs.some(t => t.id === id)) closeConsoleTab(id);
    if (v2AgentId === id) v2Close();
    const botDone = r && 'botReturn' in r ? botLeft(r.botReturn) : predicted;
    if (r.checkpointWarning) toast(`"${name}" archived${botDone}. ⚠ ${r.checkpointWarning}`, 12000);
    else toast(`"${name}" archived${botDone}.`, botDone ? (r?.botReturn?.outcome === 'not-parked' ? 12000 : 8000) : undefined);
  } catch (e) {
    archivingHere.delete(id);
    const a = v2Find(id);
    if (a) delete a.archiving;
    toast(`"${name}" was not archived: ${e.message}`, 12000);
  }
  await refresh(false);
}

// ---- archived-agent inspector (read-only, from the volume) -----------------

let inspectId = null, inspectGen = 0;
function showInspTab(which) {
  const chat = which === 'chat';
  $('inspPaneFiles').hidden = chat;
  $('inspPaneChat').hidden = !chat;
  $('inspTabFiles').setAttribute('aria-selected', String(!chat));
  $('inspTabChat').setAttribute('aria-selected', String(chat));
  if (chat && !$('inspChatBody').childElementCount) loadInspectChat();
}

async function openInspect(id, name) {
  inspectId = id;
  const gen = ++inspectGen;
  const current = () => gen === inspectGen && inspectId === id && inspectDlg.open;
  $('inspectAgent').textContent = name;
  $('inspFileBody').textContent = 'Pick a file.';
  $('inspFileList').innerHTML = 'Loading…';
  $('inspChatBody').innerHTML = '';
  $('inspChatMeta').textContent = '';
  showInspTab('files');
  inspectDlg.showModal();
  try {
    const info = await api(`/v1/agents/${id}/inspect`);
    if (!current()) return;
    const KB = b => b < 1024 ? `${b} B` : `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB`;
    $('inspFileList').innerHTML = info.files.length
      ? info.files.map(f => `<button class="inspfile" data-name="${esc(f.name)}" ${onAction('click', 'loadInspectFile', [`${f.name ?? ''}`])} style="text-align:left">${esc(f.name)} <span class="sub">${KB(f.bytes)}</span></button>`).join('')
      : '<span class="sub">No readable files.</span>';
    $('inspTabChat').textContent = `💬 Chat history${info.transcriptTurns ? ` (${info.transcriptTurns})` : ''}`;
    // Auto-open MEMORY.md — the "what did we discuss" file.
    if (info.files.some(f => f.name === 'MEMORY.md')) loadInspectFile('MEMORY.md', false);
  } catch (e) { if (current()) $('inspFileList').innerHTML = `<span class="sub">${esc(e.message)}</span>`; }
}

// Late answers are dropped, as openInspect does: another agent (or file) may
// be showing by the time one lands (review, 2026-10-09).
let inspectFileWant = null;
async function loadInspectFile(name, picked = true) {
  for (const b of document.querySelectorAll('#inspFileList .inspfile'))
    b.style.borderColor = b.dataset.name === name ? 'var(--accent)' : '';
  const body = $('inspFileBody');
  body.textContent = 'Loading…';
  // On a phone the file is under the whole list: a file tapped there loaded out of sight. When it starts below
  // what the inspector shows (the foot of its dialog, which scrolls, or of the screen) or within 48 px of it
  // (its padding and about two lines), it is scrolled into view, no further than needed, at the tap and again
  // once read: its box (60% of the screen's height at most) is then in sight whole, as much of the list above
  // it as fits. A list scrolled to where the file starts in sight stays put, for the next tap.
  const shown = Math.min(inspectDlg.getBoundingClientRect().bottom, innerHeight);
  const bring = picked && isPhone() && body.getBoundingClientRect().top > shown - 48;
  if (bring) body.scrollIntoView({ block: 'nearest' });
  const id = inspectId, gen = inspectGen; inspectFileWant = name;
  const late = () => gen !== inspectGen || !inspectDlg.open || inspectId !== id || inspectFileWant !== name;
  try {
    const f = await api(`/v1/agents/${id}/inspect/file/${encodeURIComponent(name)}`);
    if (late()) return;
    body.textContent = (f.content || '(empty)') + (f.truncated ? '\n\n… (truncated — too large to show in full)' : '');
    if (bring) body.scrollIntoView({ block: 'nearest' });
  } catch (e) { if (!late()) body.textContent = e.message; }
}

async function loadInspectChat() {
  $('inspChatBody').innerHTML = '<span class="sub">Reading the transcript…</span>';
  const id = inspectId, gen = inspectGen;
  const current = () => gen === inspectGen && inspectId === id && inspectDlg.open;
  try {
    const t = await api(`/v1/agents/${id}/inspect/transcript?maxTurns=400`);
    if (!current()) return;
    // A main conversation found but empty: a reset just before it was archived (HB-0307).
    // Records but nothing to show: its newest ones are all tool steps, which are not shown.
    $('inspChatMeta').textContent = t.turns.length
      ? `${t.turns.length} shown${t.totalTurns > t.turns.length ? ` of ${t.totalTurns} (most recent)` : ''}`
      : t.sessionFile && t.totalTurns > 0 ? `Nothing to show: the newest records of its main conversation (${t.totalTurns} in all) are tool steps, which are not shown here.`
      : t.sessionFile ? 'Its main conversation is empty: it was started afresh just before the agent was archived. Data → History has the earlier ones.'
      : 'No conversation found on the volume.';
    $('inspChatBody').innerHTML = t.turns.map(turn => {
      const me = turn.role === 'user';
      return `<div style="align-self:${me ? 'flex-end' : 'flex-start'};max-width:80%;background:${me ? 'var(--accent)' : 'var(--panel-2)'};color:${me ? '#fff' : 'var(--text)'};border-radius:10px;padding:7px 11px;font-size:13px;white-space:pre-wrap;word-break:break-word">${esc(turn.text)}</div>`;
    }).join('');
  } catch (e) { if (current()) $('inspChatBody').innerHTML = `<span class="sub">${esc(e.message)}</span>`; }
}

async function restoreAgent(id, name) {
  // Deliberately says "what it has learned" rather than "its memory": the
  // files it wrote are kept, but OpenClaw starts a fresh Telegram thread when
  // the agent's skills changed since you last talked to it (true of Rebuild
  // too). Promising "memory intact" and then losing the conversation is worse
  // than saying which is which.
  if (!confirm(`Restore "${name}"?\n\nIt keeps everything it has learned, and comes back on a NEW Telegram bot — send members the new link from Invite once it's running. If no pool bot is free it comes back without Telegram — you talk to it here, and attach a bot later from its settings (Messaging).\n\nThe chat thread itself may start fresh if the agent gained or lost a skill while it was away.`)) return;
  try {
    await api(`/v1/agents/${id}/restore`, { method: 'POST' });
    toast(`Restoring "${name}"…`);
    await refresh(false);
    return true;
  } catch (e) { toast(e.message); return false; }
}

/**
 * Ask Telegram to rename this agent's bot. Mostly for a bot you minted or
 * adopted yourself — those are never renamed automatically, since someone
 * else's bot isn't ours to touch unasked. Reports refusals plainly: Telegram's
 * rename quota runs to hours, and a button that silently does nothing is worse
 * than one that says why.
 */
// ---- master ⇄ child flows (lineage) ------------------------------------------

async function deriveChild(id, masterName) {
  const a = agents.find(x => x.id === id);
  const name = prompt(`Name the new child of "${masterName}":`, '');
  if (!name?.trim()) return;
  // The master's setup fields become the child's own answers — env-target
  // fields included (each child brings its OWN credentials; that's the point).
  let values;
  if (a?.parameters?.length) {
    values = await collectParamValues(a.parameters, `${name} (child of ${masterName})`);
    if (values === null) return; // cancelled
  }
  try {
    await api(`/v1/agents/${id}/derive`, { method: 'POST', body: { name: name.trim(), values } });
    const boundRepo = (a?.parameters ?? []).some(p => p.target === 'datasource' && values?.[p.key]);
    toast(`Child "${name.trim()}" is being created — it'll nest under ${masterName}.` +
      (boundRepo ? ' Its repo binding got a fresh deploy key: add it to the repo via 🔑 Deploy key on the child card (private repos won\'t clone until you do).' : ''), boundRepo ? 15000 : undefined);
    setTimeout(() => refresh(false), 800);
  } catch (e) { toast(e.message, 10000); }
}

async function distillToMaster(id, name) {
  const topic = prompt(`Ask ${name} to distill a lesson for its master. Optional focus topic (blank = its best general lesson):`, '');
  if (topic === null) return;
  toast('Distilling — the agent is writing (~20-60s)…');
  try {
    await api(`/v1/agents/${id}/distill`, { method: 'POST', body: { topic: topic.trim() || undefined } });
    toast('Proposal parked on the master — review it via 📥 Proposals on the master card.', 10000);
  } catch (e) { toast(e.message, 10000); }
}

let proposalsMasterId = null;
async function openProposals(id, name) {
  proposalsMasterId = id;
  $('proposalsAgent').textContent = name;
  $('proposalsList').innerHTML = 'Loading…';
  proposalsDlg.showModal();
  await loadMasterProposals();
}
// Each read numbered: master A's slow answer listed A's proposals under master B,
// whose Dismiss and Merge then went to B with A's ids (audit #064).
let proposalsGen = 0;
async function loadMasterProposals() {
  const forId = proposalsMasterId, gen = ++proposalsGen;
  const stale = () => gen !== proposalsGen || proposalsMasterId !== forId;
  try {
    const { proposals } = await api(`/v1/agents/${forId}/proposals`);
    if (stale()) return;
    $('proposalsList').innerHTML = proposals.length ? proposals.map(p => `
      <div style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:10px">
        <div class="sub">from <b>${esc(p.childName)}</b> · ${ago(p.createdAt)}</div>
        <pre style="white-space:pre-wrap;word-break:break-word;font-family:inherit;font-size:14px;max-height:240px;overflow:auto;margin:6px 0">${esc(p.text)}</pre>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button ${onAction('click', 'resolveProposal', [`${p.id ?? ''}`, "dismiss", false])}>Dismiss</button>
          <button ${onAction('click', 'resolveProposal', [`${p.id ?? ''}`, "merge", false])}>Merge</button>
          <button class="primary" ${onAction('click', 'resolveProposal', [`${p.id ?? ''}`, "merge", true])}>Merge + Push to children</button>
        </div>
      </div>`).join('') : '<div class="sub">No pending proposals. On a child agent, Sharing → Copy or share → 💡 Propose to master creates one.</div>';
  } catch (e) { if (!stale()) $('proposalsList').innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
async function resolveProposal(pid, action, push) {
  const forId = proposalsMasterId;
  if (push) {
    // The same confirmation as Push: this rewrites every child's definition in one go.
    const kids = agents.filter(k => k.parentAgentId === forId).map(k => k.name);
    if (!confirm(`Merge this into the master's AGENTS.md and push it to ${kids.length} child agent${kids.length === 1 ? '' : 's'}?\n\n${kids.join(', ')}\n\nEach child's definition is replaced; there is no undo.`)) return;
  }
  try {
    const r = await api(`/v1/agents/${forId}/proposals/${encodeURIComponent(pid)}/resolve`, { method: 'POST', body: { action, push } });
    toast(action === 'dismiss' ? 'Dismissed.' : `Merged into the master's AGENTS.md${push ? ` — pushed to ${r.pushed} child(ren)` : ''}.`, 8000);
    await loadMasterProposals();
  } catch (e) { toast(e.message, 10000); }
}

async function pushDefinition(id, masterName) {
  const kids = agents.filter(k => k.parentAgentId === id).map(k => k.name);
  if (!confirm(
    `Push "${masterName}"'s current SOUL.md/AGENTS.md to ${kids.length} child agent${kids.length === 1 ? '' : 's'}?\n\n` +
    `${kids.join(', ')}\n\n` +
    `Each child keeps its own setup values (they re-render into the new files) and its own MEMORY.md. ` +
    `A snapshot is taken per child first where one can be (a child whose files are too large to snapshot has no undo point).`
  )) return;
  try {
    const r = await api(`/v1/agents/${id}/push-definition`, { method: 'POST', body: {} });
    const bad = r.results.filter(x => !x.ok);
    toast(`Pushed to ${r.pushed}/${r.results.length} children${bad.length ? ` — skipped: ${bad.map(b => `${b.name} (${b.error})`).join(', ')}` : ''}.`, 10000);
  } catch (e) { toast(e.message, 10000); }
}

async function syncBotName(id, name, kind = 'telegram') {
  const label = V2_CHAN_LABEL[kind] || kind;
  try {
    const r = await api(`/v1/agents/${id}/bot-name/sync`, { method: 'POST', body: { kind } });
    if (r.ok) toast(`${label} bot renamed to “${r.name}”.`);
    else if (r.retryAt) {
      const when = new Date(r.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      toast(`${label} won't accept another rename for this bot until ${when} — it's queued and will apply then.`);
    } else toast(`${label} refused the rename: ${r.error || 'unknown reason'}`, 9000);
    await refresh(false);
    if (kind !== 'telegram') v2LoadChans(id);
  } catch (e) { toast(e.message); }
}

/** Which engine does the agent's semantic memory search. Applies on its next rebuild, which re-indexes. */
async function saveEmbedMode() {
  const mode = $('editEmbedMode').value;
  const forId = editAgentId, f = forAgent(forId), saved = v2SheetSaving('editEmbedMode');
  try {
    await api(`/v1/agents/${forId}`, { method: 'PATCH', body: { embedMode: mode } });
    saved(forId);
    f.say(mode === 'shared' ? 'Will use the shared service from its next rebuild — memory search re-indexes then (a few minutes).' : 'Back on its own engine from its next rebuild.');
    await refresh(false);
  } catch (e) { f.fail(e); }
}
