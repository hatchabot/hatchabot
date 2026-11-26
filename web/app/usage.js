// web/app/usage.js: the AI source dialog and its list (adding, sharing, moving and removing a source, what each has used), agent classes, applying a model and moving agents to a source, migrating, Bulk actions.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// Status for Settings → Messaging → Telegram. Prefer the bot's own heartbeat (it says alive
// vs offline, mode, LLM); fall back to the cli-token heuristic for a bot that
// predates heartbeats and hasn't been restarted yet.
async function openAiDlg(tab) {
  $('aiErr').textContent = '';
  if (!aiDlg.open) aiRowsDrawn = {}; // closing without Save drops an edit, as it always has
  // Deep-link the tab so "add a server first" can land you where the work is,
  // rather than on a page you then have to hunt through.
  showTab(tab || 'ai');
  aiDlg.showModal();
  void loadSourceUsage(); // fresh usage figures for the AI sources tab
  aiKindChanged();      // populate the model dropdown + prefill for the current kind
  // Re-read account flags (hostOwner etc.) — they gate admin buttons in this
  // dialog and a page opened before a deploy would otherwise carry stale ones.
  await loadMyAccount().catch(() => {});
  renderAiList();       // instant paint (dropdowns fall back to text until models load)
  loadMediaKey();
  loadSearchKey();
  loadClasses();
  renderPeers();
  // Fetch what each of your sources offers, then re-render so the model fields
  // become dropdowns instead of text boxes. Refetched EVERY time this opens (no
  // cache): the runtime's catalog is the source of truth and it can change under
  // us — a stale list is how an unservable model stays pickable.
  const cleaned = [];
  await Promise.all(profiles.filter(p => p.mine !== false).map(async p => {
    try {
      const r = await api(`/v1/ai-profiles/${p.id}/available-models`);
      availableModels[p.id] = r.models ?? [];
      availableSource[p.id] = r.source;
      staleModels[p.id] = r.stale ?? [];
      // Auto-clean: drop models this source lists that its runtime does not
      // serve. Only ever acts on a confident live answer ('runtime'), never on
      // the offline curated fallback, so a hiccup can't prune a working menu.
      const junk = (r.source === 'runtime' ? (r.stale ?? []) : []).filter(m => m !== p.model);
      if (junk.length) {
        const keep = [p.model, ...(p.models ?? [])].filter(m => m && !junk.includes(m));
        try {
          await api(`/v1/ai-profiles/${p.id}`, { method: 'PATCH', body: { models: [...new Set(keep)] } });
          cleaned.push(`${p.name}: removed ${junk.join(', ')}`);
        } catch { /* leave the menu alone if the write fails */ }
      }
    } catch { availableModels[p.id] = []; staleModels[p.id] = []; }
  }));
  if (cleaned.length) {
    try { profiles = await api('/v1/ai-profiles'); } catch { /* keep last-known */ }
    toast(`Cleaned models no longer served — ${cleaned.join(' · ')}`, 9000);
  }
  if (aiDlg.open) renderAiList();
}

const vendorChip = p => p.vendor === 'local' ? 'local · no credential'
  : p.kind === 'subscription' ? (p.credential === 'setup-token' ? 'subscription · setup-token' : "subscription · this machine's Claude login")
  : `${esc(p.vendor)} key`;

// The AI-source dropdowns name the source by its KIND, not a specific model —
// the model is chosen separately in the per-agent Model picker, so repeating
// one here just invited "which model am I actually on?" confusion.
const vendorLabel = v => v === 'local' ? 'Local' : v === 'google' ? 'Gemini' : 'Claude';
const sourceOptionLabel = p =>
  `${p.defaultSource ? '⭐ ' : ''}${esc(p.name)} — ${vendorLabel(p.vendor)}${p.mine === false ? ' (shared)' : ''}`;

// The default model: a dropdown when we know what the source offers, a text
// box as a graceful fallback (models not loaded yet, or a source that can't
// list them). The current default is always an option even if it's not in the
// fetched list, so it can never be silently dropped.
function defaultModelControl(p) {
  const avail = availableModels[p.id];
  const box = 'flex:1;min-width:0;padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--text);font-size:13px';
  if (Array.isArray(avail) && avail.length) {
    const opts = [p.model, ...avail].filter((m, i, a) => m && a.indexOf(m) === i).sort(byModelName);
    return `<select id="aiModel-${p.id}" ${onAction('change', 'renderExtras', [`${p.id}`])} style="${box}">
      ${opts.map(m => `<option value="${esc(m)}" ${m === p.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}
    </select>`;
  }
  return `<input type="text" id="aiModel-${p.id}" value="${esc(p.model)}" ${onAction('input', 'renderExtras', [`${p.id}`])} style="${box}">`;
}

/** A source's fleet: how many agents, split by the model they run now, with an
 *  expandable list. Answers "which agents on which source, which models" where
 *  you manage sources. */
/**
 * A source's agents: the summary line ("14 agents · 14× claude-sonnet-5") is gone (Chris, 2026-10-07) — the
 * Costs chart's By agent pie says who uses it. Left: agents on OTHER accounts, the reason it can't be deleted.
 */
function sourceUsage(p) {
  const others = p.inUse?.others || 0;
  const othersNote = others
    ? `<div class="sub" style="width:100%;color:var(--warn)">Also used by <b>${others} agent${others === 1 ? '' : 's'} on other accounts</b> — it can't be deleted until they move${myAccount.hostOwner ? ' (↪ Migrate all off… below does that)' : ''}.</div>`
    : '';
  return othersNote;
}

// The Claude model ids the app offers when it can't ask a live runtime. Newest
// first — the dropdown's top entry is the sensible default. Keep in step with
// CURATED_ANTHROPIC_MODELS in src/orchestrator/sources/aiSources.ts. NO claude-opus-5: the
// claude-cli (Max) runtime has no catalog entry for it — it once became a fleet
// default and every conversation broke on compaction (see runtimeModels.ts).
/** Model lists read alphabetically, numbers as numbers (opus-4-8 before opus-4-10) (Chris, 2026-10-07). */
function byModelName(a, b) { return String(a).localeCompare(String(b), 'en', { numeric: true }); }
/** A model's own id, as the server's modelKey has it: no `anthropic/`, no date (claude-haiku-4-5-20251001 is claude-haiku-4-5). */
function modelKeyOf(m) { return String(m).replace(/^[a-z-]+\//, '').replace(/-\d{8}$/, ''); }
/** The most models a source lists, its default among them (the server's limit on PATCH /v1/ai-profiles/:id). */
const MAX_SOURCE_MODELS = 16;
// The fallback for a new source: covers the server's CURATED_ANTHROPIC_MODELS and never
// claude-opus-5 (test/driftGuards.test.ts). A saved source lists what its runtime really serves.
const CLAUDE_MODELS = ['claude-fable-5', 'claude-haiku-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8',
  'claude-sonnet-4-6', 'claude-sonnet-5'].sort(byModelName);
/** Flip a password field to plaintext so the user can verify a pasted key,
 *  and back. Purely local — the value never leaves the field either way. */
function toggleReveal(btn, inputId) {
  const el = $(inputId);
  const show = el.type === 'password';
  el.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Hide' : 'Show';
}
function aiKindChanged() {
  const k = $('aiKind').value;
  $('aiKeyRow').style.display = k === 'api_key' ? '' : 'none';
  $('aiTokenRow').style.display = k === 'subscription' ? '' : 'none';
  $('aiLocalRow').style.display = k === 'local' ? '' : 'none';
  // Anthropic (subscription, or an api_key with vendor=Anthropic) → a real
  // dropdown of the Claude models so the default can be PICKED, with an
  // "Other…" escape for a newer id. Gemini and local keep the plain text field.
  const anthropic = k === 'subscription' || (k === 'api_key' && $('aiVendor').value === 'anthropic');
  const sel = $('aiModelSelect');
  if (anthropic) {
    sel.innerHTML = CLAUDE_MODELS.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
      + '<option value="__other">Other (type an id)…</option>';
    if (![...CLAUDE_MODELS, '__other'].includes(sel.value)) sel.value = 'claude-opus-4-8';
    sel.style.display = '';
    aiModelSelectChanged();  // show/hide the text box to match the selection
    $('aiModelHint').textContent = 'Pick the default this source starts with — agents on it can switch to any of the others later.';
  } else {
    sel.style.display = 'none';
    $('aiModel').style.display = '';
    $('aiModel').placeholder = k === 'local' ? 'Default model (e.g. qwen3.6:27b-q8_0)'
      : k === 'api_key' && $('aiVendor').value === 'google' ? 'Default model (e.g. gemini-2.5-pro)'
      : k === 'api_key' && $('aiVendor').value === 'openai' ? 'Default model (e.g. gpt-5)'
      : 'Default model';
    $('aiModelHint').textContent = k === 'local' ? 'Use the exact model tag your Ollama server serves.'
      : k === 'api_key' && $('aiVendor').value === 'openai' ? "Any chat model your key can call — the picker lists them once the source is saved."
      : '';
  }
}
/** Show the free-text box only when "Other…" is chosen. */
function aiModelSelectChanged() {
  const other = $('aiModelSelect').value === '__other';
  $('aiModel').style.display = other ? '' : 'none';
  $('aiModel').placeholder = 'Type a model id (e.g. a newer claude-…)';
  if (other) { $('aiModel').value = ''; $('aiModel').focus(); }
}

// ---- agent classes (model/source tiers) -----------------------------------
let agentClasses = [];
function classMemoryOptions(selected) {
  const max = capBytes(myAccount.memoryCapMax || '8g') || Infinity;
  const choices = [...new Set([...MEMORY_CAP_CHOICES.filter(c => capBytes(c) <= max), ...(selected ? [selected] : [])])].sort((x, y) => capBytes(x) - capBytes(y));
  return `<option value=""${selected ? '' : ' selected'}>— memory: fleet default (${capLabel(myAccount.memoryCapDefault || '3g')}) —</option>` +
    choices.map(c => `<option value="${c}"${c === selected ? ' selected' : ''}>memory ${capLabel(c)}</option>`).join('');
}
function classSwapOptions(selected, cap) {
  const capB = capBytes(cap || myAccount.memoryCapDefault || '3g');
  const choices = [...new Set([...SWAP_CHOICES.filter(c => capBytes(c) <= capB), ...(selected && selected !== 'off' ? [selected] : [])])].sort((x, y) => capBytes(x) - capBytes(y));
  return `<option value=""${selected ? '' : ' selected'}>— swap: machine's setting —</option><option value="off"${selected === 'off' ? ' selected' : ''}>swap off</option>` +
    choices.map(c => `<option value="${c}"${c === selected ? ' selected' : ''}>swap ${capLabel(c)}</option>`).join('');
}
function classModelOptions(selected) {
  // Union of models across the owner's sources; the server validates a chosen
  // model against the agent's actual source when a class is applied.
  const models = [...new Set(profiles.flatMap(p => [p.model, ...(p.models || [])]).filter(Boolean))].sort(byModelName);
  if (selected && !models.includes(selected)) models.unshift(selected);
  return `<option value="">— model: leave as-is —</option>` +
    models.map(m => `<option value="${esc(m)}"${m === selected ? ' selected' : ''}>${esc(m)}</option>`).join('');
}
let classImageTags = [];
function classImageOptions(selected) {
  const opts = [`<option value="">— image: fleet default —</option>`].concat(classImageTags.map(t => `<option value="${esc(t)}" ${t === selected ? 'selected' : ''}>${esc(t)}</option>`));
  if (selected && !classImageTags.includes(selected)) opts.push(`<option value="${esc(selected)}" selected>${esc(selected)}</option>`);
  return opts.join('');
}
function classSourceOptions(selected) {
  return `<option value="">— source: leave as-is —</option>` +
    profiles.map(p => `<option value="${esc(p.id)}"${p.id === selected ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
}
async function loadClasses() {
  $('classModel').innerHTML = classModelOptions('');
  $('classSource').innerHTML = classSourceOptions('');
  try { classImageTags = myAccount.hostOwner ? (await api('/v1/runtime/images')).tags.filter(t => t.exists).map(t => t.tag) : []; } catch { classImageTags = []; }
  $('classImage').innerHTML = classImageOptions('');
  $('classImage').hidden = !myAccount.hostOwner;
  $('classErr').textContent = '';
  try {
    agentClasses = (await api('/v1/agent-classes')).classes || [];
    renderClassList();
  } catch (e) { $('classList').innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
function renderClassList() {
  if (!agentClasses.length) { $('classList').innerHTML = '<div class="sub">No classes yet.</div>'; return; }
  $('classList').innerHTML = agentClasses.map(c => {
    const n = agents.filter(a => a.classId === c.id).length;
    // Members its model has not reached yet: as the agent list sends them
    // (publicAgent), `model` is what the runtime runs and `pendingModel` what
    // it should, sent only when the two differ. One that waits for a rebuild
    // (a source or image switch: rebuildWaits) is not behind, only waiting;
    // the rest are those whose runtime refused it.
    const pending = agents.filter(a => a.classId === c.id && a.pendingModel && a.pendingModel !== a.model);
    const behind = pending.filter(a => !a.rebuildWaits).length, waiting = pending.length - behind;
    return `<div class="classrow">
      <span class="cname"><b>${esc(c.name)}</b> <span class="sub">· ${n} agent${n === 1 ? '' : 's'}${behind ? ` · <span class="warn">${behind} still on an old model</span>` : ''}${waiting ? ` · ${waiting} waiting for a rebuild` : ''}</span></span>
      <select ${onAction('change', 'updateClass', [`${c.id}`, "model", { $: 'value' }])}>${classModelOptions(c.model || '')}</select>
      <select ${onAction('change', 'updateClass', [`${c.id}`, "aiProfileId", { $: 'value' }])}>${classSourceOptions(c.aiProfileId || '')}</select>
      ${myAccount.hostOwner ? `<select ${onAction('change', 'updateClass', [`${c.id}`, "image", { $: 'value' }])} title="Runtime image (applied on rebuild)">${classImageOptions(c.image || '')}</select>` : ''}
      <select ${onAction('change', 'updateClass', [`${c.id}`, "memoryCap", { $: 'value' }])} title="Memory cap for its agents' containers (applied right away to members without a cap of their own)">${classMemoryOptions(c.memoryCap || '')}</select>
      <select ${onAction('change', 'updateClass', [`${c.id}`, "swapAllowance", { $: 'value' }])} title="Compressed swap on top of the cap for its agents (applied right away to members without a setting of their own; only where the machine compresses swap)">${classSwapOptions(c.swapAllowance || '', c.memoryCap)}</select>
      <button class="danger" ${onAction('click', 'deleteClass', [`${c.id}`, `${c.name ?? ''}`])}>Delete</button>
    </div>`;
  }).join('');
}
async function addClass() {
  const name = $('className').value.trim();
  if (!name) { $('classErr').textContent = 'Give the class a name.'; return; }
  $('classAddBtn').disabled = true; $('classErr').textContent = '';
  try {
    await api('/v1/agent-classes', { method: 'POST', body: { name, model: $('classModel').value || undefined, aiProfileId: $('classSource').value || undefined, image: $('classImage').value || undefined } });
    $('className').value = ''; $('classModel').value = ''; $('classSource').value = ''; $('classImage').value = '';
    await loadClasses();
    toast(`Class "${name}" added.`);
  } catch (e) { $('classErr').textContent = e.message; }
  finally { $('classAddBtn').disabled = false; }
}
function quickClass(name) { $('className').value = name; $('className').focus(); }
async function updateClass(id, field, value) {
  try {
    const r = await api(`/v1/agent-classes/${id}`, { method: 'PUT', body: { [field]: value } });
    agentClasses = agentClasses.map(c => c.id === id ? r.class : c);
    const bits = [];
    if (r.applied) bits.push(`applied to ${r.applied}`);
    if (r.needRebuild) bits.push(`${r.needRebuild} need a rebuild (source or image change)`);
    if ((r.skipped || []).length) bits.push(`${r.skipped.length} skipped`);
    // Its runtime refused the model: still on the old one until a retry or a Rebuild (audit #068).
    const stale = r.modelPending || [];
    if (stale.length) bits.push(`${stale.length} still on the old model (${stale.join('; ')})`);
    toast(`Class updated${bits.length ? ' — ' + bits.join(', ') : ''}.`, stale.length ? 12000 : 7000);
    renderClassList();
    await refresh(false);
  } catch (e) {
    // Deleted meanwhile: an edit waiting behind its deletion answers 404. Said so, and the list read again.
    if (e.status === 404) { toast('That class was deleted meanwhile.', 7000); await loadClasses(); await refresh(false).catch(() => {}); return; }
    toast(e.message, 9000); loadClasses();
  }
}
async function deleteClass(id, name) {
  if (!confirm(`Delete class "${name}"?\n\nAgents in it keep their current model/source — they just lose the class tag.`)) return;
  try {
    const r = await api(`/v1/agent-classes/${id}`, { method: 'DELETE' });
    // Members on the class's memory cap get the limits that now apply; one whose container said no keeps the old until a rebuild.
    if ((r.skipped || []).length) toast(`Class deleted — memory limits not changed for ${r.skipped.join('; ')}. A rebuild applies them.`, 12000);
    await loadClasses(); await refresh(false);
  }
  catch (e) { toast(e.message, 9000); }
}

async function renderClassPicker(cur) {
  const sel = $('editClass');
  sel.innerHTML = '<option value="">— none —</option>';
  try { agentClasses = (await api('/v1/agent-classes')).classes || []; } catch { /* keep last */ }
  if (!$('editClass') || (typeof v2AgentId !== 'undefined' && v2AgentId && v2AgentId !== cur?.id)) return;
  sel.innerHTML = '<option value="">— none —</option>' + (agentClasses || []).map(c =>
    `<option value="${esc(c.id)}"${c.id === cur?.classId ? ' selected' : ''}>${esc(c.name)}${c.model ? ' · ' + esc(c.model) : ''}</option>`).join('');
}
/** Set (or clear) an agent's class from its Overview. */
async function assignClass() {
  const sel = $('editClass');
  // Another agent's sheet opened while this one saved: its model menu stays its own,
  // and what is said names the agent it was for (HB-0590). The sheet's agent, or the
  // one the classic dialog's forms are filled for.
  const f = typeof v2AgentId !== 'undefined' && v2AgentId ? forAgent(v2AgentId) : sheetSave(), id = f.id;
  const classId = sel.value || null;
  sel.disabled = true;
  try {
    const r = await api(`/v1/agents/${id}/class`, { method: 'POST', body: { classId } });
    const said = !classId ? 'Class cleared.' : r.rebuild ? 'Class set — it changes the AI source or image, so Rebuild to apply.'
      : r.modelPending ? `Class set. ⚠ ${r.modelPending}` : 'Class set — model applied.';
    const more = r.memoryPending || r.modelPending;
    f.say(r.memoryPending ? `${said} ${r.memoryPending}` : said, more ? 12000 : 7000);
    await refresh(false);
    f.draw(() => renderModelPickerForAgent(agents.find(x => x.id === id))); // the menu is the edit sections', filled for editAgentId
  } catch (e) { f.say(e.message, 9000); } // pressed on its Overview: said there, not under the edit forms
  finally { sel.disabled = false; }
}

// ---- AI-source usage (requests, tokens, rate limits) --------------------------
let sourceUsageData = null; // { sampledAt, sources: [...] } from /v1/ai-profiles/usage
let aiChartsAt = 0; // when the AI sources' Costs charts were last read
async function loadSourceUsage() {
  try { sourceUsageData = await api('/v1/ai-profiles/usage'); } catch { return; }
  // Each row's usage line only: this runs off the poll, and redrawing the rows
  // threw away a model being chosen, an open drawer and a revealed credential (HB-0410).
  for (const p of profiles) { const el = $(`aiUsage-${p.id}`); if (el) el.innerHTML = sourceUsagePanel(p); }
  // The Costs charts under the rows are read again too, at most once a minute, and only those
  // in sight: in an open drawer, on screen. They followed only a full redraw of the list (HB-0474).
  if (aiDlg.open && $('aiList') && !$('aiList').closest('[hidden]') && Date.now() - aiChartsAt >= 60_000) {
    aiChartsAt = Date.now();
    const view = aiDlg.getBoundingClientRect();
    for (const el of $('aiList').querySelectorAll('details.srcspend[open] .spendchart:not([data-lazy])')) {
      const r = el.getBoundingClientRect();
      if (r.height && r.bottom > Math.max(0, view.top) && r.top < Math.min(innerHeight, view.bottom)) void loadSpendChart(el, true);
    }
  }
}
function sourceUsageOf(id) { return sourceUsageData?.sources?.find(x => x.id === id); }
function sourceUsagePanel(p) {
  // The request counts, most-use and other-accounts lines are gone (Chris, 2026-10-07): the Costs chart below
  // carries spend, tokens and refusals. Left: a source being refused RIGHT NOW, when its agents are failing.
  const u = sourceUsageOf(p.id);
  if (u?.status !== 'limited') return '';
  return `<div class="su"><div class="su-status limited">⛔ Rate-limited since ${esc(clock(u.limitedSince))} — calls through this source are being refused</div></div>`;
}

/**
 * What each row's model controls showed when drawn: the server's values. What differs
 * now is the person's unsaved edit, and a redraw (another row's Save, a model list
 * arriving) keeps only that. The rest follows the server, as ⟳ Sync, the auto-clean or
 * another device leave it, so Save cannot write an old value back (HB-0410). For the
 * list the edit is what was added and what was removed, put on the server's list as it
 * is then: kept whole, it undid what Sync had just added. The list is compared without
 * the default in force: picking a default takes it off the list on the page, which is
 * not a change to the list.
 */
let aiRowsDrawn = {};
const aiExtrasOf = (csv, dflt) => csv.split(',').map(s => s.trim()).filter(m => m && m !== dflt);
function aiRowEdits() {
  const edits = {};
  for (const [id, drawn] of Object.entries(aiRowsDrawn)) {
    const model = $(`aiModel-${id}`)?.value, models = $(`aiModels-${id}`)?.value;
    if (model === undefined || models === undefined) continue;
    const edit = {};
    if (model !== drawn.model) edit.model = model;
    const was = aiExtrasOf(drawn.models, model), now = aiExtrasOf(models, model);
    const add = now.filter(m => !was.includes(m)), remove = was.filter(m => !now.includes(m));
    if (add.length || remove.length) edit.models = { add, remove };
    if (Object.keys(edit).length) edits[id] = edit;
  }
  return edits;
}
function renderAiList() {
  const edits = aiRowEdits();
  // The intro to the request counts went with them (2026-10-07).
  $('aiList').innerHTML = profiles.map((p, i) => p.mine === false ? `
    <div class="pair" style="flex-wrap:wrap;gap:6px">
      <b>${p.defaultSource ? '⭐ ' : ''}${esc(p.name)}</b>
      <span class="chip">${vendorChip(p)}</span>
      <span class="sub">shared by the server owner — usable for your agents, managed by them${p.defaultSource ? '; the default for new agents' : ''}</span>
      <div id="aiUsage-${p.id}" style="display:contents">${sourceUsagePanel(p)}</div>${sourceSpendBox(p)}
    </div>` : `
    <div class="pair" style="flex-wrap:wrap;gap:8px;align-items:flex-start">
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;width:100%">
        ${aiMoveBtns(p, i)}
        <b>${p.defaultSource ? '⭐ ' : ''}${esc(p.name)}</b>
        <span class="chip">${vendorChip(p)}</span>
        ${p.vendor === 'anthropic' && (p.credential === 'api-key' || p.credential === 'setup-token') ? `
        <label class="sub" style="display:flex;align-items:center;gap:4px;margin-left:auto"
               title="Hatchabot's small background calls (like picking icons) use this source.">
          <input type="checkbox" ${p.mgmtLlm ? 'checked' : ''} ${onAction('change', 'setMgmtLlmSource', [`${p.id}`, { $: 'checked' }])}> 🛠 Helper calls
        </label>` : ''}
        <label class="sub" style="display:flex;align-items:center;gap:4px;${p.vendor === 'anthropic' && (p.credential === 'api-key' || p.credential === 'setup-token') ? '' : 'margin-left:auto'}"
               title="Let every account on this server use this source for their agents — they spend on it, and their agents hold the key">
          <input type="checkbox" ${p.shared ? 'checked' : ''} ${onAction('change', 'shareAiProfile', [`${p.id}`, { $: 'checked' }, (p.kind === 'subscription' && p.credential === 'machine-login')])}> Shared
        </label>
        ${myAccount.hostOwner === false ? '' : `<label class="sub" style="display:flex;align-items:center;gap:4px"
               title="Preselect this source whenever anyone on this server creates or imports an agent (one source can hold this). Other accounts only see it if it's also Shared.">
          <input type="checkbox" ${p.defaultSource ? 'checked' : ''} ${onAction('change', 'setDefaultSource', [`${p.id}`, { $: 'checked' }, (!!p.shared)])}> ⭐ Default
        </label>`}
      </div>
      ${sourceUsage(p)}
      <div id="aiUsage-${p.id}" style="display:contents">${sourceUsagePanel(p)}</div>${sourceSpendBox(p)}
      ${p.credential === 'machine-login' || p.vendor === 'local' ? '' : `
      <details class="su" style="width:100%">
        <summary><b>🔑 Credential</b> <span class="sub">— reveal only to copy this source to another Hatchabot machine</span></summary>
        <div class="sub" style="margin:6px 0">Anyone holding it can spend this plan. Accounts you share this with can use it for their agents. Their agents hold it, so someone determined can read it from their own agent. Share only with people you'd trust with the key; to take it back, un-share, move their agents, and replace the token.</div>
        <div style="display:flex;gap:8px;align-items:center">
          <button ${onAction('click', 'revealSourceCredential', [`${p.id}`, { $: 'el' }])}>Show</button>
          <code id="cred-${p.id}" class="invite-link" style="display:none;flex:1;min-width:0;word-break:break-all"></code>
        </div>
      </details>`}
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;width:100%">
        <label class="sub" style="min-width:104px">Default model</label>
        ${defaultModelControl(p)}
      </div>
      ${(staleModels[p.id] ?? []).includes(p.model) ? `<div class="sub" style="width:100%;color:var(--bad)">
        ⚠ <b>${esc(p.model)}</b> isn't served by this source's runtime — agents on it will fail when a
        conversation fills up (compaction can't resolve the model). Pick another default above and Save.</div>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:10px;width:100%">
        <label class="sub" style="min-width:104px;padding-top:5px">Also switchable</label>
        <div id="aiExtras-${p.id}" style="flex:1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:30px"></div>
        <input type="hidden" id="aiModels-${p.id}" value="${esc((p.models ?? []).filter(m => m !== p.model).join(','))}">
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;width:100%;justify-content:flex-end">
        <button ${onAction('click', 'syncModels', [`${p.id}`, `${p.name ?? ''}`])} title="Reconcile this source's switchable models with what its runtime serves now — adds new models, drops ones no longer served">⟳ Sync models</button>
        ${(() => {
          const movable = agents.filter(a => (a.role ? a.role === 'owner' : true) && a.aiProfileId !== p.id).length;
          return movable
            ? `<button ${onAction('click', 'moveAgentsToSource', [`${p.id}`, `${p.name ?? ''}`])} title="Switch ${movable} of your agents onto this AI source">Move agents here…</button>`
            : `<button disabled title="Every one of your agents already uses this source">Move agents here…</button>`;
        })()}
        ${myAccount.hostOwner && p.mine !== false ? `<button ${onAction('click', 'openMigrate', [`${p.id}`, `${p.name ?? ''}`])} title="Host-owner action: move EVERY agent on this source — other accounts' included — onto a shared source, so this one can be deleted">↪ Migrate all off…</button>` : ''}
        <button class="primary" ${onAction('click', 'saveAiProfile', [`${p.id}`])}>Save</button>
        <button class="danger" ${onAction('click', 'delAiProfile', [`${p.id}`, `${p.name ?? ''}`])} title="${(p.inUse?.mine || 0) + (p.inUse?.others || 0) ? esc(`In use by ${p.inUse.mine} of your agents${p.inUse.others ? ' and ' + p.inUse.others + ' on other accounts' : ''} — move them first`) : 'Remove this AI source'}">Delete</button>
      </div>
      <div class="sub" id="aiRowErr-${p.id}" style="width:100%;color:var(--bad);text-align:right"></div>
    </div>`).join('') || '<div class="sub">No AI sources yet.</div>';
  // Populate the switchable-model bubbles for each owned profile.
  aiRowsDrawn = {};
  profiles.filter(p => p.mine !== false).forEach(p => {
    renderExtras(p.id);
    const model = $(`aiModel-${p.id}`), models = $(`aiModels-${p.id}`), edit = edits[p.id];
    aiRowsDrawn[p.id] = { model: model.value, models: models.value };
    if (!edit) return;
    if (edit.model !== undefined) {
      if (model.tagName === 'SELECT' && ![...model.options].some(o => o.value === edit.model)) model.add(new Option(edit.model, edit.model));
      model.value = edit.model;
    }
    if (edit.models !== undefined) models.value = [...new Set([...aiExtrasOf(models.value).filter(m => !edit.models.remove.includes(m)), ...edit.models.add])].join(',');
    renderExtras(p.id);
  });
  aiChartsAt = Date.now();
  void loadSpendCharts($('aiList'));
}
/**
 * A source's costs (Chris, 2026-10-07): the same chart as Usage — what it went
 * on, by model, by agent, and over time — for the agents on this source now.
 * Folded state is remembered per source; a folded chart is not loaded.
 */
function sourceSpendBox(p) {
  if (p.vendor === 'local') return ''; // a local model server costs nothing per token
  let folded = false; try { folded = localStorage.getItem(`hb-src-spend-folded:${p.id}`) === '1'; } catch {}
  return `<details class="su srcspend" style="width:100%"${folded ? '' : ' open'} ${onAction('toggle', 'sourceSpendToggle', [{ $: 'el' }, `${p.id ?? ''}`])}>
    <summary><b>💲 Costs</b> <span class="sub">— at API prices, for the agents on this source now</span></summary>
    <div class="spendchart" data-source="${esc(p.id)}"${folded ? ' data-lazy="1"' : ''} style="margin-top:8px"><div class="sub">Loading…</div></div></details>`;
}
function sourceSpendToggle(det, id) {
  try { localStorage.setItem(`hb-src-spend-folded:${id}`, det.open ? '0' : '1'); } catch {}
  const box = det.querySelector('.spendchart');
  if (det.open && box) { delete box.dataset.lazy; void loadSpendChart(box); }
}

// The "also switchable" set: removable bubbles + an "add" dropdown of what's
// left, so nobody hand-types a model id. Backed by the hidden aiModels input
// (kept comma-joined for Save). Model ids ride in data-attributes / option
// values and are read via event delegation — never interpolated into an
// inline handler, so escaping can't break the click.
function renderExtras(id) {
  const box = $(`aiExtras-${id}`);
  if (!box) return;
  const field = $(`aiModels-${id}`);
  const dfltEl = $(`aiModel-${id}`);
  const dflt = dfltEl ? dfltEl.value.trim() : '';
  const avail = Array.isArray(availableModels[id]) ? availableModels[id] : [];
  // Extras never include the default (it's already the default).
  const chosen = field.value.split(',').map(s => s.trim()).filter(Boolean).filter(m => m !== dflt).sort(byModelName);
  field.value = chosen.join(',');

  const tags = chosen.map(m =>
    `<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:14px;padding:3px 4px 3px 11px;font-size:12px">
      ${esc(m)}
      <button type="button" data-remove="${esc(m)}" aria-label="Remove ${esc(m)}"
        style="border:none;background:none;cursor:pointer;color:var(--dim);font-size:16px;line-height:1;padding:0 3px">×</button>
    </span>`).join('');

  // By the model, not its spelling: a dated id of a model already here is the same model (HB-0669).
  const taken = new Set([dflt, ...chosen].map(modelKeyOf));
  const opts = avail.filter(m => !taken.has(modelKeyOf(m))).sort(byModelName);
  const ctrlStyle = 'font-size:12px;padding:4px 7px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--text)';
  let adder;
  if (1 + chosen.length >= MAX_SOURCE_MODELS) {
    adder = `<span class="sub" data-list-full>The list is full: a source holds ${MAX_SOURCE_MODELS} models, its default among them. Remove one to add another.</span>`;
  } else if (opts.length) {
    adder = `<select data-add aria-label="Add a switchable model" style="${ctrlStyle}">
      <option value="" disabled selected>＋ Add a model…</option>
      ${opts.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')}
    </select>`;
  } else if (avail.length) {
    adder = availableSource[id] === 'curated'
      ? `<span class="sub">Showing common models only — no agent runs on this source yet, so its full
          catalogue can't be read. Start an agent here (or <b>⟳ Sync</b> once one is running) to discover the rest.</span>`
      : `<span class="sub">all models added</span>`;
  } else {
    // No list available (server unreachable / no key) — let them type as a fallback.
    adder = `<input data-add-text placeholder="type a model id, then Enter" style="${ctrlStyle};min-width:180px">`;
  }
  box.innerHTML = tags + adder + (chosen.length || opts.length ? '' : ' <span class="sub">none — add one to let agents /model-switch</span>');

  if (!box._wired) {
    const setExtras = (list) => { field.value = [...new Set(list)].filter(m => m !== ($(`aiModel-${id}`)?.value.trim())).join(','); renderExtras(id); };
    box.addEventListener('change', (e) => {
      if (e.target.hasAttribute('data-add') && e.target.value) { setExtras([...chosenNow(id), e.target.value]); }
    });
    box.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove]');
      if (rm) setExtras(chosenNow(id).filter(m => m !== rm.getAttribute('data-remove')));
    });
    box.addEventListener('keydown', (e) => {
      if (e.target.hasAttribute('data-add-text') && e.key === 'Enter') {
        e.preventDefault(); const v = e.target.value.trim(); if (v) setExtras([...chosenNow(id), v]);
      }
    });
    box._wired = true;
  }
}
function chosenNow(id) {
  return $(`aiModels-${id}`).value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * An error from a source's own controls, on its own row (with reading time in a
 * toast: the row can be tall). #aiErr is the Add-a-source drawer's, and a closed
 * drawer shows nothing (HB-0442).
 */
function aiRowSay(id, msg) {
  const el = $(`aiRowErr-${id}`);
  if (el) el.textContent = msg;
  toast(msg, 12000);
}
async function setMgmtLlmSource(id, on) {
  try {
    await api(`/v1/ai-profiles/${id}`, { method: 'PATCH', body: { mgmtLlm: on } });
    profiles = await api('/v1/ai-profiles');
    renderAiList();
    toast(on ? 'Background helper calls (like picking icons) now use this source.' : 'Cleared — helper calls fall back to the automatic pick.');
  } catch (e) { toast(e.message); renderAiList(); }
}

/** Reveal a source's stored credential so it can be added on another machine.
 *  Owner-only server-side, and the server logs every reveal. */
// A revealed credential lingers in the DOM until something re-renders the list;
// clear it when the dialog closes so it doesn't sit there for the next opener.
aiDlg?.addEventListener('close', () => {
  document.querySelectorAll('#aiList code[id^="cred-"]').forEach(el => { el.textContent = ''; el.style.display = 'none'; });
});

/**
 * Show, then Copy — the same two presses as a bot token, so revealing a secret
 * works one way everywhere. Copying goes through copyText, which also works on
 * a plain-http page where the clipboard API does not exist.
 */
async function revealSourceCredential(id, btn) {
  const out = $('cred-' + id);
  if (out.style.display !== 'none' && out.textContent) {
    toast(await copyText(out.textContent)
      ? 'Copied — add it on the other machine as a ' + (btn.dataset.kind === 'setup-token' ? 'setup-token' : 'API key') + ' source.'
      : 'Select it and copy by hand.');
    return;
  }
  btn.disabled = true;
  try {
    const r = await api(`/v1/ai-profiles/${id}/credential`);
    out.textContent = r.credential;
    out.style.display = '';
    btn.dataset.kind = r.kind;
    btn.textContent = 'Copy';
  } catch (e) { toast(e.message, 9000); }
  finally { btn.disabled = false; }
}

/**
 * ▲▼ on a source. The order is the one every list of sources shows — the
 * create form, an agent's AI tab, a class — so a local model that is seldom
 * the right answer can sit at the bottom instead of being offered first.
 */
const aiMoveBtns = (p, i) => p.mine === false ? '' : `<span class="ord">
    <button class="ordbtn" title="Move up" ${i === 0 ? 'disabled' : ''} ${onAction('click', 'moveAiProfile', [`${p.id}`, "up"])} aria-label="Move ${esc(p.name)} up">▲</button>
    <button class="ordbtn" title="Move down" ${i === profiles.length - 1 ? 'disabled' : ''} ${onAction('click', 'moveAiProfile', [`${p.id}`, "down"])} aria-label="Move ${esc(p.name)} down">▼</button></span>`;

async function moveAiProfile(id, dir) {
  try {
    await api(`/v1/ai-profiles/${id}/move`, { method: 'POST', body: { dir } });
    profiles = await api('/v1/ai-profiles');
    renderAiList();
  } catch (e) { toast(e.message); }
}

async function setDefaultSource(id, on, isShared) {
  if (on && !isShared && !confirm(
    "This source isn't Shared, so other accounts can't see it — the default " +
    "will only apply to YOUR new agents.\n\nFor a household-wide default, turn " +
    "on Shared too. Set it as default anyway?"
  )) { renderAiList(); return; }
  try {
    await api(`/v1/ai-profiles/${id}`, { method: 'PATCH', body: { defaultSource: on } });
    profiles = await api('/v1/ai-profiles');
    renderAiList();
    toast(on ? 'New agents now preselect this source.' : 'Default cleared — new agents preselect nothing special.');
  } catch (e) { toast(e.message); renderAiList(); }
}

async function shareAiProfile(id, shared, isMachineLogin) {
  // A machine-login subscription is not "shared spend" — it hands the actual
  // Claude login on this box to another account's agent, which they control
  // and can drive over Telegram to read the credential. Make that explicit
  // before turning it on; anything else shares only a key or a local server.
  if (shared && isMachineLogin && !confirm(
    "This source is THIS MACHINE'S Claude login.\n\n" +
    "Sharing it lets other accounts' agents sign in as you — and an agent its " +
    "owner controls could read your login and use it beyond this app. Only do " +
    "this for people you'd hand your password to.\n\n" +
    "Prefer: give them a `claude setup-token` of their own, or share an API-key " +
    "or local-model source instead.\n\nShare your machine login anyway?"
  )) { renderAiList(); return; }   // revert the checkbox
  try {
    await api(`/v1/ai-profiles/${id}`, { method: 'PATCH', body: { shared } });
    toast(shared ? 'Shared with everyone on this server' : 'No longer shared — existing agents keep it until switched');
    await refresh(true); renderAiList();
  } catch (e) { renderAiList(); aiRowSay(id, e.message); }
}

/** ⟳ Sync models: reconcile this source's switchable list with what its
 *  runtime serves now — add newly served models, drop ones no longer served.
 *  Mirrors the dialog-open auto-clean's caution: models are only DROPPED on a
 *  confident live answer (source:'runtime'), never on the offline curated
 *  fallback or an unreachable model server; additions are always safe. The
 *  default model is never changed here — if it's stale, the existing warning
 *  under the picker says so and the owner picks a new one deliberately. */
async function syncModels(id, name) {
  const p = (profiles ?? []).find(x => x.id === id);
  if (!p) return;
  let r;
  try { r = await api(`/v1/ai-profiles/${id}/available-models`); }
  catch (e) { toast(e.message); return; }
  const served = r.models ?? [];
  if (!served.length) { toast(r.error || `Couldn't get a model list for ${name} — nothing changed.`); return; }
  availableModels[id] = served; availableSource[id] = r.source; staleModels[id] = r.stale ?? [];

  const listed = [p.model, ...(p.models ?? [])].filter(Boolean);
  const confident = r.source === 'runtime' || p.vendor === 'local' || p.vendor === 'google';
  // A runtime's answer offers one id per model (HB-0669): what it does not serve is
  // what it calls stale, not a dated id it folded into the undated one.
  const unserved = m => (r.source === 'runtime' ? (r.stale ?? []).includes(m) : !served.includes(m));
  const drops = confident ? listed.filter(m => m !== p.model && unserved(m)) : [];
  const kept = listed.filter(m => !drops.includes(m));
  const keptKeys = new Set(kept.map(modelKeyOf));
  const adds = served.filter(m => !keptKeys.has(modelKeyOf(m)));
  // Within the cap, or the save is refused: the rest are named, for the owner to choose.
  const room = Math.max(0, MAX_SOURCE_MODELS - new Set(kept).size);
  const leftOut = adds.splice(room);
  const fullNote = leftOut.length ? `${leftOut.length} not added, the list is full (a source holds ${MAX_SOURCE_MODELS} models): ${leftOut.join(', ')}` : '';
  if (!adds.length && !drops.length) {
    if (fullNote) toast(`${name}: ${fullNote}`, 9000);
    else toast(`${name} is already in sync${r.source === 'curated' ? ' with the curated list (no live agent to ask yet)' : ''}.`);
    renderAiList();
    return;
  }
  const next = [...new Set([p.model, ...kept, ...adds])].filter(Boolean);
  try {
    await api(`/v1/ai-profiles/${id}`, { method: 'PATCH', body: { models: next } });
    const bits = [];
    if (adds.length) bits.push(`added ${adds.join(', ')}`);
    if (drops.length) bits.push(`dropped ${drops.join(', ')}`);
    if (fullNote) bits.push(fullNote);
    toast(`${name}: ${bits.join(' · ')}${r.source === 'curated' ? ' (from the curated list — no live agent to ask yet)' : ''}`, 8000);
    try { profiles = await api('/v1/ai-profiles'); } catch { /* keep last-known */ }
    renderAiList();
  } catch (e) { toast(e.message); }
}

async function saveAiProfile(id) {
  const model = $(`aiModel-${id}`).value.trim();
  if (!model) { aiRowSay(id, 'Default model is required.'); return; }
  $(`aiRowErr-${id}`).textContent = '';
  const extra = $(`aiModels-${id}`).value.split(',').map(s => s.trim()).filter(Boolean);
  const p = (profiles ?? []).find(x => x.id === id);
  // A default-model change on a cloud source that has agents → let the owner
  // choose who adopts it (and hold the rest), rather than silently queueing
  // every follower. Menu-only edits, local sources, and unused sources save flat.
  const onProfile = (agents ?? []).filter(a => a.aiProfileId === id && (a.role === undefined || a.role === 'owner'));
  if (p && model !== p.model && p.vendor !== 'local' && onProfile.length) {
    openApplyModel(id, model, extra, onProfile, p.name);
    return;
  }
  try {
    await api(`/v1/ai-profiles/${id}`, { method: 'PATCH', body: { model, models: [model, ...extra] } });
    toast(p?.vendor === 'local' && onProfile.length ? 'Saved — Rebuild agents to apply' : 'Saved');
    delete aiRowsDrawn[id]; // saved: no longer an edit, so the redraw shows what the server holds
    await refresh(true); renderAiList();
  } catch (e) { aiRowSay(id, e.message); }
}

async function addAiProfile() {
  const kind = $('aiKind').value;
  const name = $('aiName').value.trim();
  const sel = $('aiModelSelect');
  const model = (sel.style.display !== 'none' && sel.value && sel.value !== '__other')
    ? sel.value
    : $('aiModel').value.trim();
  if (!name || !model) { $('aiErr').textContent = 'Name and default model are required.'; return; }
  const extra = $('aiModelsAdd').value.split(/[\s,]+/).filter(Boolean); // commas or spaces between them
  const body = { kind, name, model, models: extra.length ? [model, ...extra] : undefined };
  if (kind === 'local') {
    body.baseUrl = $('aiBaseUrl').value.trim() || undefined;
  }
  else if (kind === 'subscription') {
    body.vendor = 'anthropic';
    body.oauthToken = $('aiToken').value.trim() || undefined;
  }
  else {
    body.vendor = $('aiVendor').value;
    body.apiKey = $('aiKey').value.trim();
    if (!body.apiKey) { $('aiErr').textContent = 'API key is required.'; return; }
  }
  $('aiAddBtn').disabled = true;
  try {
    await api('/v1/ai-profiles', { method: 'POST', body });
    $('aiName').value = ''; $('aiModel').value = ''; $('aiModelsAdd').value = ''; $('aiKey').value = ''; $('aiToken').value = '';
    toast('AI source added');
    await refresh(true); renderAiList();
  } catch (e) { $('aiErr').textContent = e.message; }
  finally { $('aiAddBtn').disabled = false; }
}

let applyModelState = null;
function openApplyModel(profileId, model, extras, onProfile, sourceName) {
  applyModelState = { profileId, model, extras };
  $('applyModelName').textContent = model;
  $('applyModelSource').textContent = sourceName || 'this source';
  $('applyModelErr').textContent = '';
  $('applyModelList').innerHTML = onProfile.map(a => {
    const hasOwn = !!a.modelOverride;      // it picked its own model — protect it
    const now = a.model || a.modelOverride || '';
    return `<label class="pair" style="padding:5px 0;cursor:pointer;align-items:center;gap:8px;margin:0">
      <input type="checkbox" class="applyModelCb" data-id="${esc(a.id)}" ${hasOwn ? '' : 'checked'} ${onAction('change', 'refreshApplyCount')} style="width:auto;flex:none">
      <span class="grow"><b>${esc(a.name)}</b>
        <span class="sub">${hasOwn
          ? `· its own: ${esc(now)} — keep unless ticked`
          : (now && now !== model ? `· ${esc(now)} → ${esc(model)}` : `· ${esc(now)}`)}${a.state === 'ARCHIVED' ? ' · <span style="color:var(--warn)">archived — applies on restore</span>' : ''}</span></span>
    </label>`;
  }).join('') || '<div class="sub">No agents use this source yet.</div>';
  refreshApplyCount();
  applyModelDlg.showModal();
}
function toggleApplyAll(on) {
  document.querySelectorAll('.applyModelCb').forEach(cb => { cb.checked = on; });
  refreshApplyCount();
}
function refreshApplyCount() {
  const cbs = [...document.querySelectorAll('.applyModelCb')];
  const n = cbs.filter(cb => cb.checked).length;
  $('applyModelCount').textContent = `${n} of ${cbs.length} selected`;
  $('applyModelAll').checked = n > 0 && n === cbs.length;
  // None ticked is a real choice: the default changes for new agents only,
  // and every existing agent keeps the model it runs today.
  $('applyModelBtn').disabled = false;
  $('applyModelBtn').textContent = n ? `Save, and switch ${n}` : 'Save for new agents only';
}
async function applyModelToSelected() {
  if (!applyModelState) { toast('Reopen this dialog and try again.'); return; }
  const apply = [...document.querySelectorAll('.applyModelCb')].filter(cb => cb.checked).map(cb => cb.dataset.id);
  const { profileId, model, extras } = applyModelState;
  $('applyModelBtn').disabled = true;
  try {
    // Live: the model applies to running agents on the next message — no
    // rebuild. Stopped/archived switched agents follow the new default when
    // they next start.
    const r = await api(`/v1/ai-profiles/${profileId}/apply-default-model`, {
      method: 'POST', body: { model, models: [model, ...extras], apply },
    });
    const bits = [];
    if (r.live) bits.push(`${r.live} switched live`);
    if (r.staged) bits.push(`${r.staged} stopped agent${r.staged > 1 ? 's' : ''} updated for next start`);
    const later = (r.applied || 0) - (r.live || 0) - (r.staged || 0) - (r.volumeGone || 0);
    if (later > 0) bits.push(`${later} apply on next rebuild`);
    // Not "next rebuild": a rebuild would make a fresh, empty volume (HB-0373).
    if (r.volumeGone) bits.push(`${r.volumeGone} not changed: ${r.volumeGone > 1 ? 'their volumes are' : 'its volume is'} gone (see its page before you rebuild)`);
    if (r.held) bits.push(`${r.held} kept on their own model`);
    // A class that set another model comes off, as the bulk source switch says (faApply).
    if (r.classDetached) bits.push(`${r.classDetached} detached from a class`);
    if (r.classDetachPending) bits.push(`${r.classDetachPending} may leave a class once the class change under way is done`);
    // Ticked, but its runtime is too old for the model on a Claude plan: kept on its own (HB-0232).
    const notSw = r.notSwitched || [];
    if (notSw.length) bits.push(`not switched: ${notSw.map(x => x.name).join(', ')} (${notSw.length > 1 ? 'their runtimes are' : 'its runtime is'} too old for ${model} on a Claude plan — give ${notSw.length > 1 ? 'them' : 'it'} a newer runtime image first)`);
    // Other accounts' agents that follow this shared source, held for the same reason: a count, never names (HB-0245).
    const others = r.othersHeld ? ` ${r.othersHeld} agent${r.othersHeld > 1 ? 's' : ''} of other accounts that follow this source ${r.othersHeld > 1 ? 'were' : 'was'} kept on ${r.othersHeld > 1 ? 'their' : 'its'} model: ${r.othersHeld > 1 ? 'their runtimes are' : 'its runtime is'} too old for ${model} on a Claude plan.` : '';
    const kept = keptLimitsList(r);
    toast((apply.length
      ? `Default is now ${model}${bits.length ? ' — ' + bits.join(', ') : ''}.`
      : `Default is now ${model} for new agents. Existing agents keep their models.`) + others + (kept.length ? ' ' + kept.join(' ') : ''), others || kept.length ? 12000 : 7000);
    applyModelDlg.close();
    delete aiRowsDrawn[profileId]; // saved: no longer an edit
    await refresh(true); renderAiList();
  } catch (e) { $('applyModelErr').textContent = e.message; }
  finally { $('applyModelBtn').disabled = false; }
}

let moveSourceState = null;
/**
 * Switch a batch of agents onto one AI source — checkbox list, no typing.
 * Mirrors the apply-model dialog. Only offers agents not already on the source.
 */
/** Words for the agents a recovery asked for did not reach: not rebuilt now (down, archived, its rebuild refused), and their next start is a plain rebuild (HB-0411). */
// An agent that left its class whose container kept the class's memory
// limits, worded here from the parts the server sends beside its sentence
// (limitsKept: { name, why }, one or a list), not parsed back out of it.
const leftClassKeptLimits = (k, name) => `${name || (k && k.name) || 'It'} left its class, but its container kept its old memory limits (${(k && k.why) || 'not applied'}); a rebuild applies them.`;
const keptLimitsList = (r) => (Array.isArray(r.limitsKept) ? r.limitsKept : []).map(k => leftClassKeptLimits(k));
const notRecoveredNote = (n) => `${n} not recovered: once ${n === 1 ? 'it is' : 'they are'} up on this source, press Recover context on ${n === 1 ? 'its' : 'their'} Personality tab`;
/** The same for Migrate all: the button is the agent's owner's alone, so another account's agents are theirs to press it on. */
const notRecoveredOthersNote = (n) => `${n === 1 ? '1 on another account' : `${n} on other accounts`} not recovered: only ${n === 1 ? 'its owner' : 'each one\'s owner'} can press Recover context, once it is up, so let them know`;
function moveAgentsToSource(profileId, profileName, keepChoices = false) {
  // Defaults for the person's own open; the reopen after a skip keeps what they chose.
  if (!keepChoices) {
    $('moveSourceRecover').checked = true;
    $('moveSourceCheckpoint').checked = false; // off by default: a checkpoint needs the OLD source to answer, which is exactly what's often dead when you're moving
  }
  const candidates = agents.filter(a => (a.role ? a.role === 'owner' : true) && a.aiProfileId !== profileId);
  if (!candidates.length) {
    toast('Every one of your agents already uses this source.');
    if (keepChoices && moveSourceDlg.open) moveSourceDlg.close(); // drawn again with nobody left: nothing to show
    return;
  }
  // Drawn again, it is the same open: a move running from it still answers to it.
  if (!keepChoices || moveSourceState?.profileId !== profileId) moveSourceState = { profileId };
  $('moveSourceName').textContent = profileName;
  if (!keepChoices) $('moveSourceErr').textContent = ''; // drawn again behind a move: what this open said still stands
  $('moveSourceList').innerHTML = candidates.map(a => {
    const src = profiles.find(p => p.id === a.aiProfileId);
    // Archived agents stay selectable — you must be able to move them off a
    // source to retire it — but they don't rebuild now; the switch applies when
    // they're unarchived. Label them so that isn't a surprise.
    const archived = a.state === 'ARCHIVED'
      ? ' · <span style="color:var(--warn)">archived — applies when unarchived</span>' : '';
    return `<label class="pair" style="padding:5px 0;cursor:pointer;align-items:center;gap:8px;margin:0">
      <input type="checkbox" class="moveSourceCb" data-id="${esc(a.id)}" data-src="${esc(a.aiProfileId)}" ${onAction('change', 'refreshMoveCount')} style="width:auto;flex:none">
      <span class="grow"><b>${esc(a.name)}</b>
        <span class="sub">· now on ${esc(src ? src.name : 'another source')}${archived}</span></span>
    </label>`;
  }).join('');
  // "Select all using source X" — pick a source and tick every candidate on it.
  const srcIds = [...new Set(candidates.map(a => a.aiProfileId))];
  $('moveSourceFilter').innerHTML = '<option value="">Select all on source…</option>' +
    srcIds.map(id => {
      const p = profiles.find(x => x.id === id);
      const n = candidates.filter(a => a.aiProfileId === id).length;
      return `<option value="${esc(id)}">${esc(p ? p.name : 'another source')} (${n})</option>`;
    }).join('');
  refreshMoveCount();
  if (!moveSourceDlg.open) moveSourceDlg.showModal();
}
function toggleMoveAll(on) {
  document.querySelectorAll('.moveSourceCb').forEach(cb => { cb.checked = on; });
  refreshMoveCount();
}
function selectMoveBySource(profileId) {
  if (!profileId) return;
  // Additive: tick every listed agent currently on the chosen source (leaves
  // any you'd already ticked). Reset the dropdown so it reads as an action.
  document.querySelectorAll('.moveSourceCb').forEach(cb => { if (cb.dataset.src === profileId) cb.checked = true; });
  $('moveSourceFilter').value = '';
  refreshMoveCount();
}
function refreshMoveCount() {
  const cbs = [...document.querySelectorAll('.moveSourceCb')];
  const n = cbs.filter(cb => cb.checked).length;
  $('moveSourceCount').textContent = `${n} of ${cbs.length} selected`;
  $('moveSourceAll').checked = n > 0 && n === cbs.length;
  $('moveSourceBtn').disabled = n === 0;
  $('moveSourceBtn').textContent = n ? `Switch & rebuild ${n}` : 'Switch & rebuild';
}

/** A move behind a dialog reopened meanwhile has changed who can move: its list follows, and what is ticked stays ticked. */
function moveSourceRedraw() {
  if (!moveSourceDlg.open || !moveSourceState) return;
  const ticked = [...document.querySelectorAll('.moveSourceCb')].filter(cb => cb.checked).map(cb => cb.dataset.id);
  moveAgentsToSource(moveSourceState.profileId, $('moveSourceName').textContent, true);
  document.querySelectorAll('.moveSourceCb').forEach(cb => { cb.checked = ticked.includes(cb.dataset.id); });
  refreshMoveCount();
}
async function moveAgentsApply(rebuild) {
  const state = moveSourceState;
  if (!state) { toast('Reopen this dialog and try again.'); return; }
  const apply = [...document.querySelectorAll('.moveSourceCb')].filter(cb => cb.checked).map(cb => cb.dataset.id);
  if (!apply.length) { toast('Tick at least one agent to move.'); return; }
  $('moveSourceBtn').disabled = true;
  try {
    const r = await api(`/v1/ai-profiles/${state.profileId}/adopt-agents`, {
      method: 'POST', body: { apply, rebuild, checkpoint: rebuild && $('moveSourceCheckpoint').checked, recoverAfter: rebuild && $('moveSourceRecover').checked },
    });
    const bits = [`${r.switched} switched`];
    if (r.rebuilding) bits.push(`rebuilding ${r.rebuilding} now`);
    if (r.atNextStart) bits.push(`${r.atNextStart} not running, so ${r.atNextStart === 1 ? 'it takes' : 'they take'} it at the next start`);
    if (r.notRecovered) bits.push(notRecoveredNote(r.notRecovered));
    if (!r.rebuilding && !r.atNextStart && r.switched) bits.push('rebuild to apply');
    bits.push(...keptLimitsList(r));
    const skipped = r.skipped ?? [];
    if (!skipped.length) {
      toast(bits.join(' — '), 12000);
      if (moveSourceState === state) moveSourceDlg.close();
      await refresh(true); renderAiList();
      moveSourceRedraw();
      return;
    }
    // Stays open, listing what is left, with every skip and its reason: toasts
    // overwrite each other, so only the last skip could ever be read (HB-0445).
    const said = `${bits.join(' — ')}. Skipped ${skipped.length}:\n${skipped.map(sk => `${sk.name}: ${sk.reason}`).join('\n')}`;
    await refresh(true); renderAiList();
    // Cancel pressed meanwhile stands (or it is open for another source now): told, not reopened.
    if (!moveSourceDlg.open || moveSourceState !== state) { toast(said); moveSourceRedraw(); return; }
    moveAgentsToSource(state.profileId, $('moveSourceName').textContent, true);
    $('moveSourceErr').textContent = said;
  } catch (e) {
    if (moveSourceDlg.open && moveSourceState === state) $('moveSourceErr').textContent = e.message; else toast(e.message); // open for another source now: not that one's error
  } finally { refreshMoveCount(); } // as the ticks say: none left after a reopen means off
}

async function delAiProfile(id, name) {
  const p = profiles.find(x => x.id === id);
  const rowErr = $(`aiRowErr-${id}`);
  const explain = (msg) => { if (rowErr) rowErr.textContent = msg; toast(msg, 12000); };
  // Refuse locally with the reason AT the button — the server would refuse too,
  // but its message used to land in #aiErr below the whole list (invisible).
  const mine = p?.inUse?.mine || 0, others = p?.inUse?.others || 0;
  if (mine + others) {
    const msg = `Can't delete "${name}" — still in use by ${mine ? mine + ' of your agent' + (mine === 1 ? '' : 's') : ''}${mine && others ? ' and ' : ''}${others ? others + ' agent' + (others === 1 ? '' : 's') + ' on other accounts' : ''}. Move them to another source first.`;
    explain(msg);
    if (others && myAccount.hostOwner && confirm(`${msg}\n\nAs the host owner you can move every agent on it (other accounts' included) to a shared source, then delete it. Open that now?`)) openMigrate(id, name);
    else if (mine && !others && confirm(`${msg}\n\nOpen "Move agents" to pick where they go?`)) { const t = profiles.find(x => x.id !== id && (x.mine !== false || x.shared)); if (t) moveAgentsToSource(t.id, t.name); }
    return;
  }
  if (!confirm(`Remove AI source "${name}"?`)) return;
  try {
    await api(`/v1/ai-profiles/${id}`, { method: 'DELETE' });
    toast('Removed');
    await refresh(true); renderAiList();
  } catch (e) {
    explain(e.message);
    if (myAccount.hostOwner && /other accounts/.test(e.message) && confirm(`${e.message}\n\nAs the host owner you can move every agent on "${name}" (other accounts' included) to a shared source, then delete it. Open that now?`)) openMigrate(id, name);
  }
}
let migrateState = null;
function openMigrate(id, name) {
  migrateState = { id, name };
  $('migrateFrom').textContent = name;
  const targets = profiles.filter(p => p.id !== id && p.shared);
  $('migrateTo').innerHTML = targets.length
    ? targets.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')
    : '<option value="">— no shared source to move them to; share one first —</option>';
  $('migrateBtn').disabled = !targets.length;
  $('migrateCheckpoint').checked = true; $('migrateRecover').checked = false;
  $('migrateErr').textContent = '';
  $('migrateAgents').textContent = 'Loading agents…';
  migrateDlg.showModal();
  // Show exactly who moves: every agent on this source, across accounts.
  api('/v1/agents?all=1').then(all => {
    const on = all.filter(a => a.aiProfileId === id);
    // Nothing to move: the button would fail on press, so it stays out.
    $('migrateBtn').disabled = !on.length || !$('migrateTo').options.length;
    $('migrateBtn').title = on.length ? '' : 'No agents are on this source.';
    $('migrateAgents').innerHTML = on.length
      ? `<b>${on.length} agent${on.length === 1 ? '' : 's'}</b> will move:<br>` + on.map(a => `• ${esc(a.name)} <span style="color:var(--dim)">(${esc(a.state.toLowerCase())}${a.ownerId && a.ownerId !== myAccount.ownerId ? ', other account' : ''})</span>`).join('<br>')
      : 'No agents are on this source — nothing to migrate.';
  }).catch(() => { $('migrateAgents').textContent = ''; });
}
async function runMigrate() {
  const to = $('migrateTo').value;
  if (!to) { toast('Pick the AI source to move them to.'); return; }
  if (!migrateState) { toast('Reopen this dialog and try again.'); return; }
  const toName = (profiles.find(p => p.id === to) || {}).name || 'that source';
  if (!confirm(`Move EVERY agent on "${migrateState.name}" to "${toName}" and rebuild the running ones?\n\nThis includes other accounts' agents; their chats restart on the new source (memory kept). Stopped and sleeping agents are not started: they take the new source when they next start.`)) return;
  $('migrateBtn').disabled = true;
  try {
    const r = await api(`/v1/ai-profiles/${migrateState.id}/migrate-agents`, { method: 'POST', body: {
      toProfileId: to, rebuild: true, checkpoint: $('migrateCheckpoint').checked, recoverAfter: $('migrateRecover').checked } });
    migrateDlg.close();
    toast(`Moved ${r.switched} of ${r.agents} agent${r.agents === 1 ? '' : 's'} (${r.otherAccounts} other account${r.otherAccounts === 1 ? '' : 's'}) — rebuilding ${r.rebuilding}${r.atNextStart ? `; ${r.atNextStart} not running take it at their next start` : ''}${r.notRecovered > (r.notRecoveredOthers || 0) ? `; ${notRecoveredNote(r.notRecovered - (r.notRecoveredOthers || 0))}` : ''}${r.notRecoveredOthers ? `; ${notRecoveredOthersNote(r.notRecoveredOthers)}` : ''}. Delete "${migrateState.name}" once they're done.${(r.skipped || []).length ? ' Skipped: ' + r.skipped.map(s => s.name).join(', ') : ''}${keptLimitsList(r).map(k => ' ' + k).join('')}`, 12000);
    await refresh(true); renderAiList();
  } catch (e) { $('migrateErr').textContent = e.message; }
  finally { $('migrateBtn').disabled = false; }
}

// ---- ⚡ Bulk actions: a selection of agents + one action -------------------
function faAgents() {
  // Owner's own, non-archived — the set bulk actions operate on. A→Z, so a
  // name is where you expect it (the home screen's order is the owner's own).
  // Never the manager: it is pinned on purpose, moves last, and a bulk stop or
  // model switch would take the fleet's own operator down with the rest.
  return agents.filter(a => (a.role ? a.role === 'owner' : true) && a.state !== 'ARCHIVED' && !a.ops)
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** Bulk actions on one View-by section: everything in it ticked, the dialog opened (Chris, 2026-09-24). */
function v2BulkSection(key, label) {
  // The same key the sections are built with: under Groups v2ViewKey() is null
  // and the key is the group name — indexing null threw, and the bolt did
  // nothing in the default view (Chris, 2026-09-26).
  const keyOf = (a) => { const k = v2ViewKey(a); return k ? k[0] : 'g:' + (a.group || ''); };
  const ids = faAgents().filter(a => keyOf(a) === key).map(a => a.id);
  void openFleetActions({ ids, label });
}
// The section's agent names, one per line, in the order shown — for a
// message, a note, or a list to paste somewhere.
let v2SectionsNow = [];
async function v2CopySection(key) {
  const names = (v2SectionsNow.find(s => s.key === key)?.items ?? []).map(({ a }) => a.name).filter(Boolean);
  if (!names.length) return toast('Nothing to copy.');
  try { if (!(await copyText(names.join('\n')))) throw new Error('no clipboard'); toast(`Copied ${names.length} name${names.length === 1 ? '' : 's'}.`); }
  catch { toast('Could not reach the clipboard — copy them from the list.', 6000); }
}
async function openFleetActions(preset) {
  $('faErr').textContent = ''; $('faResults').innerHTML = '';
  // Classes power the "Set class" action + the class filter chips. Always
  // refetched (a class deleted in Settings must not linger), and the dialog
  // opens before the fetch so the button never looks dead.
  fleetActionsDlg.showModal();
  try { agentClasses = (await api('/v1/agent-classes')).classes || []; } catch { /* non-fatal */ }
  // Filter chips: quick ways to tick a subset. Each sets the tick-list.
  const list = faAgents();
  const chips = [['all', `All (${list.length})`]];
  const bySource = [...new Set(list.map(a => a.aiProfileId))];
  for (const pid of bySource) {
    const p = profiles.find(x => x.id === pid);
    chips.push([`src:${pid}`, `${p ? p.name : 'source'} (${list.filter(a => a.aiProfileId === pid).length})`]);
  }
  const groups = [...new Set(list.map(a => a.group).filter(Boolean))];
  for (const g of groups) chips.push([`grp:${g}`, `${g} (${list.filter(a => a.group === g).length})`]);
  for (const c of (agentClasses || [])) {
    const n = list.filter(a => a.classId === c.id).length;
    if (n) chips.push([`cls:${c.id}`, `class: ${c.name} (${n})`]);
  }
  const hostIds = [...new Set(list.map(a => a.hostId))];
  if (hostIds.length > 1) for (const h of hostIds) {
    const host = hosts.find(x => x.id === h);
    chips.push([`host:${h}`, `${host ? host.name : 'host'} (${list.filter(a => a.hostId === h).length})`]);
  }
  chips.push(['running', `Running (${list.filter(a => a.state === 'RUNNING').length})`]);
  chips.push(['stopped', `Stopped (${list.filter(a => a.state === 'STOPPED' && !a.hibernatedAt).length})`]);
  if (list.some(a => a.hibernatedAt)) chips.push(['asleep', `Asleep (${list.filter(a => a.state === 'STOPPED' && !!a.hibernatedAt).length})`]);
  const needs = list.filter(rebuildChangesIt).length;
  if (needs) chips.push(['needs-rebuild', `Needs rebuild (${needs})`]);
  // The same rule as the home screen's Alerts: an agent the owner cleared is not counted.
  const attn = list.filter(a => agentAttention(a).length && !attentionCleared(a)).length;
  if (attn) chips.push(['attention', `Alerts (${attn})`]);
  // The home screen's current View by, as chips: one per section it shows
  // (image, status, needs-you, activity…), so a set you can see is a set you
  // can act on. Groups, sources, classes and machines already have theirs.
  if (v2View && !['group', 'source', 'class', 'host'].includes(v2View)) {
    const viewLabel = (V2_VIEWS.find(([k]) => k === v2View) || [])[1] || v2View;
    const bins = new Map();
    for (const a of list) { const [k, l] = v2ViewKey(a); if (!bins.has(k)) bins.set(k, { l, n: 0 }); bins.get(k).n++; }
    for (const [k, { l, n }] of [...bins].sort((x, y) => x[0].localeCompare(y[0]))) chips.push([`view:${k}`, `${viewLabel}: ${l} (${n})`]);
  }
  if (preset?.ids?.length) {
    const label = `${preset.label || 'This section'} (${preset.ids.length})`;
    // The section's own chip (a group, a source…) says the same thing: one chip, ticked.
    const dup = chips.findIndex(([, l]) => l === label); if (dup >= 0) chips.splice(dup, 1);
    chips.unshift(['preset', label]);
  }
  faPreset = preset?.ids ? new Set(preset.ids) : null;
  $('faFilters').innerHTML = chips.map(([key, label]) =>
    `<button class="hbtn" data-key="${esc(key)}" ${onAction('click', 'faSelect', [`${key ?? ''}`])}>${esc(label)}</button>`).join('');
  // The agent list (owner-set, live ordering).
  $('faList').innerHTML = list.map(a => {
    const p = profiles.find(x => x.id === a.aiProfileId);
    return `<label class="pair" style="padding:4px 0;cursor:pointer;align-items:center;gap:8px;margin:0">
      <input type="checkbox" class="faCb" data-id="${esc(a.id)}" data-src="${esc(a.aiProfileId)}" data-state="${esc(a.state)}" data-asleep="${a.hibernatedAt && a.state === 'STOPPED' ? 1 : 0}" ${onAction('change', 'faManual')} style="width:auto;flex:none">
      <span class="grow"><b>${esc(a.name)}</b>
        <span class="sub">· ${esc(p ? p.name : 'source')} · ${esc((a.model || '').replace(/^.*\//, '') || '—')} · ${esc(a.state.toLowerCase())}</span></span>
    </label>`;
  }).join('') || '<div class="sub">No agents.</div>';
  $('faAction').value = 'model';
  faRenderAction();
  faCount();
  if (preset?.ids?.length) faSelect('preset');
  // The machine's "rebuild at once", right where a rebuild is about to be asked for (owner only; others see nothing).
  void api('/v1/rebuild-concurrency').then(r => {
    const sel = $('faAtOnce'); if (!sel) return;
    sel.innerHTML = Array.from({ length: r.max }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    sel.value = String(r.atOnce);
    $('faAtOnceRow').style.display = myAccount?.hostOwner ? 'flex' : 'none';
  }).catch(() => {});
}
let faPreset = null;
function faSelect(key) {
  // Highlight the chip that produced the current selection; hand-edits clear it.
  document.querySelectorAll('#faFilters .hbtn').forEach(b => b.classList.toggle('fa-on', b.dataset.key === key));
  const test = key === 'all' ? () => true
    : key === 'running' ? (cb) => cb.dataset.state === 'RUNNING'
    : key === 'stopped' ? (cb) => cb.dataset.state === 'STOPPED' && cb.dataset.asleep !== '1'
    : key === 'asleep' ? (cb) => cb.dataset.asleep === '1'
    : key === 'needs-rebuild' ? (cb) => rebuildChangesIt(agents.find(x => x.id === cb.dataset.id))
    : key === 'attention' ? (cb) => { const a = agents.find(x => x.id === cb.dataset.id); return !!a && agentAttention(a).length > 0 && !attentionCleared(a); }
    : key.startsWith('src:') ? (cb) => cb.dataset.src === key.slice(4)
    : key.startsWith('grp:') ? (cb) => (agents.find(x => x.id === cb.dataset.id)?.group || '') === key.slice(4)
    : key.startsWith('host:') ? (cb) => (agents.find(x => x.id === cb.dataset.id)?.hostId) === key.slice(5)
    : key.startsWith('cls:') ? (cb) => (agents.find(x => x.id === cb.dataset.id)?.classId) === key.slice(4)
    : key.startsWith('view:') ? (cb) => { const a = agents.find(x => x.id === cb.dataset.id); return !!a && v2ViewKey(a)[0] === key.slice(5); }
    : key === 'preset' ? (cb) => !!faPreset && faPreset.has(cb.dataset.id)
    : () => false;
  // A filter REPLACES the selection (so chips are predictable); Select-all is additive via its own control.
  document.querySelectorAll('.faCb').forEach(cb => { cb.checked = test(cb); });
  faCount();
  // Show the first agent the filter picked, so the effect is visible without
  // scrolling (Chris, 2026-09-24).
  const first = document.querySelector('.faCb:checked');
  if (first) first.closest('label, div')?.scrollIntoView({ block: 'nearest' });
}
function faManual() { document.querySelectorAll('#faFilters .hbtn').forEach(b => b.classList.remove('fa-on')); faCount(); }
function faToggleAll(on) { document.querySelectorAll('.faCb').forEach(cb => { cb.checked = on; }); faCount(); }
function faSelected() { return [...document.querySelectorAll('.faCb:checked')]; }
function faCount() {
  const cbs = [...document.querySelectorAll('.faCb')];
  const sel = faSelected();
  $('faCount').textContent = `${sel.length} of ${cbs.length} selected`;
  $('faAll').checked = sel.length > 0 && sel.length === cbs.length;
  faRenderAction(); // model menu depends on which agents are selected
}
function faRenderAction() {
  const action = $('faAction').value;
  const isModel = action === 'model';
  // Re-rendering the option lists on every tick must not lose the user's pick —
  // a reset "Set class" select silently became "clear class" for the whole selection.
  const prevClass = $('faClass').value, prevModel = $('faModel').value;
  const keep = (el, prev) => { if (prev && [...el.options].some(o => o.value === prev)) el.value = prev; };
  $('faModel').style.display = isModel ? '' : 'none';
  $('faClass').style.display = action === 'class' ? '' : 'none';
  $('faSource').style.display = action === 'source' ? '' : 'none';
  $('faImage').style.display = action === 'image' ? '' : 'none';
  if (action === 'image' && !$('faImage').childElementCount) void imageOptionsHtml('').then(h => { $('faImage').innerHTML = h; });
  $('faSourceOpts').style.display = action === 'source' ? '' : 'none';
  $('faPeersOpts').style.display = action.startsWith('peers-') ? '' : 'none';
  const sel = faSelected().map(cb => agents.find(a => a.id === cb.dataset.id)).filter(Boolean);
  let note = '';
  if (action === 'source') {
    const prevSrc = $('faSource').value;
    $('faSource').innerHTML = profiles.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    keep($('faSource'), prevSrc);
    $('faApplyBtn').disabled = !sel.length;
    $('faActionNote').textContent = 'Moves the selected agents onto the chosen source and rebuilds the running ones (memory kept, brief downtime). Stopped and sleeping agents stay as they are, and take the new source when they next start. Agents already on it are skipped. A class that pins a different source is detached.';
    return;
  }
  if (action === 'class') {
    $('faClass').innerHTML = '<option value="">— none (clear class) —</option>' +
      (agentClasses || []).map(c => `<option value="${esc(c.id)}">${esc(c.name)}${c.model ? ' · ' + esc(c.model) : ''}${c.aiProfileId ? ' · ' + esc((profiles.find(p => p.id === c.aiProfileId) || {}).name || 'source') : ''}</option>`).join('');
    keep($('faClass'), prevClass);
    $('faApplyBtn').disabled = !sel.length;
    note = !agentClasses.length ? 'No classes defined yet — add them in ⚙ Settings → Classes.'
      : 'Assigns the class and applies its model/source: model live on running agents; a source change needs a rebuild (those get the 🔄 flag). Local-source agents skip an incompatible model.';
    $('faActionNote').textContent = note;
    return;
  }
  if (isModel) {
    // Offer only models EVERY selected agent's source supports (intersection),
    // so we never set a model an agent can't run. Local-source agents have no
    // switchable menu — flag them as skipped.
    const nonLocal = sel.filter(a => (a.profileModels || []).length);
    const localCount = sel.length - nonLocal.length;
    let common = nonLocal.length ? (nonLocal[0].profileModels || []) : [];
    for (const a of nonLocal.slice(1)) common = common.filter(m => (a.profileModels || []).includes(m));
    $('faModel').innerHTML = common.length
      ? common.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('')
      : '<option value="">— no model they all share —</option>';
    $('faModel').disabled = !common.length;
    keep($('faModel'), prevModel);
    if (!sel.length) note = 'Select agents to see the models their sources share.';
    else if (!common.length) note = 'The selected agents are on sources with no model in common — filter by one source first.';
    else note = `Applies live to running agents (next message); stopped ones apply when they next start.${localCount ? ` ${localCount} local-model agent(s) will be skipped.` : ''}`;
    $('faApplyBtn').disabled = !sel.length || !common.length;
  } else {
    $('faApplyBtn').disabled = !sel.length;
    const atOnce = Number(appConfig?.rebuildConcurrency) || 6;
    note = action === 'rebuild' ? `Rebuilds each selected running agent (memory kept, brief downtime), ${atOnce} at a time — the rest wait their turn (Settings → Hosts → Rebuild at once). Stopped and sleeping ones stay down: one on an older image, or with a change a rebuild brings, is rebuilt when it next starts; the others are skipped.`
      : action === 'image' ? `Pins each selected agent to the chosen image (Fleet default = unpin) and rebuilds the running ones onto it, ${atOnce} at a time, memory kept; stopped ones move when they start. A pinned agent stops following fleet promotes.`
      : action === 'stop' ? 'Stops each selected running agent. It keeps its bot.'
      : action === 'start' ? 'Starts each selected stopped agent.'
      : action === 'wake' ? 'Wakes each selected sleeping agent (💤). Others are left as they are.'
      : action === 'sleep' ? 'Stops each selected running agent with its volume kept, to be woken by a Telegram message, its console or an ask. Agents on Discord or Slack are skipped: nothing queues their messages.'
      : action === 'checkpoint' ? 'Each running agent writes its current conversation into memory (~20s and some tokens per agent — runs one at a time). Stopped agents are skipped; an agent whose AI source is out of credits will report "not saved".'
      : '';
  }
  if (action === 'peers-connect') {
    const n = sel.filter(a => a.state !== 'ARCHIVED').length;
    note = n < 2 ? 'Pick at least two agents.' : `Each of the ${n} may consult every other one — ${n * (n - 1)} one-way grants. Grants to agents outside the selection are kept.`;
  } else if (action === 'peers-disconnect') {
    note = 'Removes the grants between the selected agents only; their other peers are kept.';
  }
  $('faActionNote').textContent = note;
}
async function faApply() {
  const action = $('faAction').value;
  const ids = faSelected().map(cb => cb.dataset.id);
  if (!ids.length) { toast('Tick at least one agent first.'); return; }
  const model = $('faModel').value;
  // Read once, as the model and image are: the class menu stays live while Apply
  // works down the list, and a later agent got whatever it said then (audit #049).
  const classId = $('faClass').value || null;
  const cls = classId ? agentClasses.find(c => c.id === classId) : null;
  if (action === 'source') {
    const profileId = $('faSource').value;
    if (!profileId) return;
    const p = profiles.find(x => x.id === profileId);
    if (!confirm(`Move ${ids.length} agent${ids.length > 1 ? 's' : ''} to "${p ? p.name : 'that source'}" and rebuild the running ones?\n\nStopped and sleeping agents are not started: they take the new source when they next start.`)) return;
    $('faApplyBtn').disabled = true; $('faResults').innerHTML = 'Switching…';
    try {
      const r = await api(`/v1/ai-profiles/${profileId}/adopt-agents`, { method: 'POST', body: {
        apply: ids, rebuild: true, checkpoint: $('faSourceCheckpoint').checked, recoverAfter: $('faSourceRecover').checked } });
      const bits = [`${r.switched} switched`, `rebuilding ${r.rebuilding}`];
      if (r.atNextStart) bits.push(`${r.atNextStart} not running, so ${r.atNextStart === 1 ? 'it takes' : 'they take'} it at the next start`);
      if (r.notRecovered) bits.push(notRecoveredNote(r.notRecovered));
      if (r.classDetached) bits.push(`${r.classDetached} detached from a class`);
      if (r.classDetachPending) bits.push(`${r.classDetachPending} may leave a class once the class change under way is done`);
      if ((r.skipped || []).length) bits.push(`${r.skipped.length} skipped`);
      const kept = keptLimitsList(r);
      $('faResults').innerHTML = `✓ ${esc(bits.join(' · '))}.${kept.length ? `<br>${kept.map(esc).join('<br>')}` : ''}`;
      $('faErr').textContent = (r.skipped || []).slice(0, 3).map(s => `${s.name}: ${s.reason}`).join(' · ');
      if ($('faSourceRecover').checked && r.rebuilding) toast('Each agent will recover its pre-switch conversation once it is back up, and confirm in its chat.', 9000);
    } catch (e) { $('faErr').textContent = e.message; }
    finally { $('faApplyBtn').disabled = false; await refresh(false); }
    return;
  }
  if (action === 'peers-connect' || action === 'peers-disconnect') {
    const connect = action === 'peers-connect';
    if (ids.length < 2) { $('faErr').textContent = 'Pick at least two agents.'; return; }
    $('faApplyBtn').disabled = true; $('faErr').textContent = ''; $('faResults').innerHTML = connect ? 'Connecting…' : 'Disconnecting…';
    try {
      const r = await api('/v1/agent-peers/mesh', { method: 'POST', body: { agentIds: ids, connect } });
      const bits = [connect ? `${r.agents} agents can now consult each other (${r.grants} grants)` : `grants between ${r.agents} agents removed`];
      if (r.skipped?.length) bits.push(`skipped ${r.skipped.map(x => `${x.name} (${x.reason})`).join(', ')}`);
      let rebuilt = 0;
      // Only running agents are rebuilt now; a stopped or sleeping one picks
      // the change up when it next starts (a rebuild would start it).
      const todo = (r.needRebuild || []).filter(a => a.state === 'RUNNING');
      if ($('faPeersRebuild').checked) {
        for (const a of todo) {
          try { const r2 = await api(`/v1/agents/${a.id}/rebuild`, { method: 'POST', body: { stoppedWaits: true } }); if (!r2?.atNextStart) rebuilt++; }
          catch (e) { $('faErr').textContent = `${a.name}: ${e.message}`; }
        }
        if (rebuilt) bits.push(`rebuilding ${rebuilt} (a few at a time)`);
      } else if (todo.length) bits.push(`${todo.length} need a rebuild — their icons say so`);
      if (!r.changed) bits.push('nothing to change — already set');
      // Sleeping agents named: one wakes for a message as it was, and takes this at its next Start or Rebuild.
      $('faResults').innerHTML = `✓ ${esc(bits.join(' · '))}.${r.note ? ' ' + esc(r.note) : ''}`;
    } catch (e) { $('faErr').textContent = e.message; $('faResults').innerHTML = ''; }
    finally { $('faApplyBtn').disabled = false; await refresh(false); }
    return;
  }
  if (action === 'rebuild' && !confirm(`Rebuild ${ids.length} agent${ids.length > 1 ? 's' : ''}? Each running one briefly goes offline (memory kept). Stopped and sleeping ones stay down, and are rebuilt when they next start if a rebuild would change them.`)) return;
  const image = $('faImage').value || null;
  if (action === 'image' && !confirm(`${image ? `Pin ${ids.length} agent${ids.length > 1 ? 's' : ''} to ${imageTagOf(image)}` : `Put ${ids.length} agent${ids.length > 1 ? 's' : ''} back on the fleet default`} and rebuild the running ones now? Each briefly goes offline (memory kept).`)) return;
  if (action === 'checkpoint' && !confirm(`Save the conversation to memory for ${ids.length} agent${ids.length > 1 ? 's' : ''}? Runs a ~20s turn per running agent, one at a time (uses tokens).`)) return;
  $('faApplyBtn').disabled = true;
  $('faResults').innerHTML = `Working on ${ids.length}…`;
  let ok = 0, skipped = 0, busy = 0, failed = 0, notSaved = 0, nothingNew = 0, nextStart = 0, notRebuilt = 0, atRebuild = 0, memoryLater = 0, marked = 0; const reasons = [];
  // Saved is not applied: each answer read as the agent's own AI tab and Class menu read it,
  // so one whose runtime refused the change is not counted done (HB-0595). Each is named, all
  // of them, with its own reason: not among the failures' first three, which are others'.
  const notApplied = [];
  const refused = (a, id, why) => { notApplied.push({ name: a?.name || id, why }); };
  for (const id of ids) {
    const a = agents.find(x => x.id === id);
    try {
      if (action === 'model') {
        if (!(a?.profileModels || []).length) { skipped++; continue; } // local: no menu
        const r = await api(`/v1/agents/${id}/model`, { method: 'POST', body: { model } });
        if (r?.failed) { refused(a, id, 'saved, but its runtime refused it: it answers on the old model until you try again or Rebuild'); continue; }
        if (!r?.live && !r?.staged) { atRebuild++; continue; } // a source switch waits for its rebuild, or it was busy: the model comes with the rebuild
      } else if (action === 'class') {
        if (cls?.model && !(a?.profileModels || []).length && !cls.aiProfileId) { skipped++; continue; } // local source: no switchable model
        const r = await api(`/v1/agents/${id}/class`, { method: 'POST', body: { classId } });
        if (r?.modelPending) { refused(a, id, r.modelPending); continue; } // its runtime refused the model
        if (r?.rebuild) { atRebuild++; continue; } // a source or an image: applied by a Rebuild, its memory limits with it
        // The class and its model applied; only the container's memory limits wait for its next rebuild.
        if (r?.memoryPending) memoryLater++;
      } else if (action === 'checkpoint') {
        if (a?.state !== 'RUNNING') { skipped++; continue; } // needs a live turn
        const r = await api(`/v1/agents/${id}/checkpoint`, { method: 'POST', body: {} });
        if (!r.saved && r.ok) { nothingNew++; continue; } // the turn ran; its memory files did not change
        if (!r.saved) { notSaved++; continue; } // soft fail (e.g. AI source out of credits)
      } else if (action === 'rebuild') {
        // As Rebuild all: a rebuild ends RUNNING, so a stopped or sleeping agent is not
        // started behind its owner's back; it is marked for its next start, when one would change it.
        const r = await rebuildOrMark(a);
        if (r === 'busy') { busy++; continue; } // as Rebuild all counts it: skipped, busy or already changing
        if (r === 'not needed') { skipped++; continue; }
        if (r === 'next start') { marked++; continue; }
      } else if (action === 'image') {
        if ((a?.image ?? null) === image) { skipped++; continue; } // already there
        const r = await api(`/v1/agents/${id}`, { method: 'PATCH', body: { image } });
        // The server decides, not the last poll (review of HB-0469): one shown asleep may be up since.
        // One with no container yet (failed or still being made) takes the pin when it is made.
        if (!r.sameImage && a?.runtimeRef) {
          try {
            const r2 = await api(`/v1/agents/${id}/rebuild`, { method: 'POST', body: { stoppedWaits: true } });
            if (r2?.atNextStart) { nextStart++; continue; }
          } catch (e) {
            // The pin is saved: not a failure of the pin.
            notRebuilt++; if (reasons.length < 3) reasons.push(reasonFor(a?.name || id, `pinned, but not rebuilt yet: ${e?.message ?? e}`));
            continue;
          }
        }
      } else if (action === 'stop') {
        if (a?.state !== 'RUNNING') { skipped++; continue; }
        await api(`/v1/agents/${id}/stop`, { method: 'POST', body: {} });
      } else if (action === 'start') {
        if (a?.state !== 'STOPPED') { skipped++; continue; }
        await api(`/v1/agents/${id}/start`, { method: 'POST', body: {} });
      } else if (action === 'wake') {
        if (!a?.hibernatedAt || a.state !== 'STOPPED') { skipped++; continue; }
        await api(`/v1/agents/${id}/wake`, { method: 'POST', body: {} });
      } else if (action === 'sleep') {
        if (a?.state !== 'RUNNING') { skipped++; continue; }
        try { await api(`/v1/agents/${id}/hibernate`, { method: 'POST', body: {} }); }
        // The rules that keep an agent awake are not failures: they are "not applicable".
        catch (e) { if (/Discord or Slack|scheduled tasks|management agent|busy|Cannot put it to sleep/i.test(e.message)) { skipped++; continue; } throw e; }
      }
      ok++;
    } catch (e) { failed++; if (reasons.length < 3) reasons.push(reasonFor(a?.name || id, e)); }
  }
  $('faErr').textContent = reasonsSaid(reasons, failed + notRebuilt);
  $('faApplyBtn').disabled = false;
  $('faResults').innerHTML = faResultLine({ ok, memoryLater, skipped, busy, atRebuild, notApplied, nothingNew, nextStart, marked, notRebuilt, notSaved, failed });
  await refresh(false);
  if ($('classList').childElementCount) renderClassList(); // Settings may still be open: keep its counts honest
}
/**
 * Bulk actions' result line, from what each agent's answer said (faApply): one part per kind,
 * in this order, each left out at nought. `notApplied`: every agent saved but not applied,
 * with its own reason. `busy`: a rebuild turned away as busy or already changing (409).
 */
function faResultLine(n) {
  const each = (k, one, many) => k === 1 ? one : many;
  const warn = (s) => `<span style="color:var(--warn)">${s}</span>`;
  const memory = n.memoryLater ? ` (${n.memoryLater === n.ok ? each(n.ok, 'its', 'their') : `${n.memoryLater} of them:`} memory limits at ${each(n.memoryLater, 'its', 'each one’s')} next rebuild)` : '';
  const done = `✓ ${n.ok} done${memory}`;
  const skipped = n.skipped && `${n.skipped} skipped (not applicable)`;
  const busy = n.busy && `${n.busy} skipped (busy or already changing)`;
  const atRebuild = n.atRebuild && `${n.atRebuild} saved, applied at ${each(n.atRebuild, 'its', 'each one’s')} next rebuild`;
  const notApplied = n.notApplied.length && warn(`${n.notApplied.length} saved, but not applied: ${esc(n.notApplied.map(x => reasonFor(x.name, x.why)).join('; '))}`);
  const nothingNew = n.nothingNew && `${n.nothingNew} found nothing new to save`;
  const nextStart = n.nextStart && `${n.nextStart} not running, so ${each(n.nextStart, 'it moves', 'they move')} when ${each(n.nextStart, 'it next starts', 'each next starts')}`;
  const marked = n.marked && `${n.marked} not running: rebuilt when ${each(n.marked, 'it next starts', 'each next starts')}`;
  const notRebuilt = n.notRebuilt && warn(`${n.notRebuilt} pinned, but not rebuilt yet`);
  const notSaved = n.notSaved && warn(`${n.notSaved} not saved (AI source didn't respond)`);
  const failed = n.failed && `<span style="color:var(--bad)">${n.failed} failed</span>`;
  return [done, skipped, busy, atRebuild, notApplied, nothingNew, nextStart, marked, notRebuilt, notSaved, failed].filter(Boolean).join(' · ') + '.';
}
