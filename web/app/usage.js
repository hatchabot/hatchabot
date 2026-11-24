// web/app/usage.js: derived runtime images, the AI source dialog, agent classes, AI-source usage, Bulk actions.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// --- Derived runtime images (host owner only) ---------------------------------

let derivedBuilding = new Set(); // names currently polling, so we don't double-poll

/**
 * The per-agent image picker: every image this machine has, said in words.
 * It used to be a text box with a datalist — the options were truncated, and
 * picking one typed the tag into the box (2026-09-19). Candidates were missing
 * entirely, since the list only ever held derived images.
 */
// Each fill numbered: the list asked for the agent opened before, answered
// late, put that agent's pin in the next one's picker, and Pin & rebuild then
// pinned it there (HB-0583). The picker says whose options it holds.
let imagePickGen = 0;
async function populateImagePicker(current) {
  const sel = $('editImage');
  if (!sel) return;
  const pin = current ?? sel.value ?? '';
  const gen = ++imagePickGen, forId = editAgentId;
  // While the list loads only the pin is offered, and Pin waits (saveImagePin): not another
  // agent's options, and not this one's old list either, where a choice made would be put back
  // to the pin by the answer (a pin changed elsewhere, refilled on a tab drawn again). The
  // picker is this agent's from then on, loading: back to the one before while it loads, it is
  // drawn again for that one (it held this one's pin, and Pin & rebuild sent it there).
  sel.innerHTML = `<option value="${esc(pin)}">Loading images…</option>`; sel.value = pin;
  sel.dataset.agent = String(forId); sel.dataset.loading = '1';
  v2SheetBaseline(sel);
  const html = await imageOptionsHtml(pin);
  if (gen !== imagePickGen || editAgentId !== forId) return;
  sel.innerHTML = html;
  sel.value = pin;
  sel.dataset.agent = String(forId); delete sel.dataset.loading;
  v2SheetBaseline(sel);
}
/** The <option>s of every runtime image on this machine, the fleet default first; `pin` is pre-selected. */
async function imageOptionsHtml(pin) {
  const opt = (value, label) => `<option value="${esc(value)}"${value === pin ? ' selected' : ''}>${esc(label)}</option>`;
  let html = '';
  try {
    const d = await api('/v1/runtime/images');
    html += opt('', `Fleet default${d.default ? ` — ${d.default}` : ''}${d.defaultInfo?.openclawVersion ? ` (OpenClaw ${d.defaultInfo.openclawVersion})` : ''}`);
    const base = (d.tags ?? []).filter(t => t.exists && !t.isDefault && !t.derived);
    const derived = (d.tags ?? []).filter(t => t.exists && t.derived);
    const say = (t) => {
      const what = t.relation === 'newer' ? 'candidate' : t.relation === 'older' ? 'older build' : t.relation === 'same' ? 'same as the default' : 'candidate';
      const extras = [(t.extraPackages ?? []).length ? `plus ${(t.extraPackages ?? []).join(', ')}` : '', t.openclawVersion ? `OpenClaw ${t.openclawVersion}` : ''].filter(Boolean).join(' · ');
      return `${imageTagOf(t.tag)} — ${what}${extras ? ` · ${extras}` : ''}`;
    };
    if (base.length) html += `<optgroup label="Base images">${base.map(t => opt(t.tag, say(t))).join('')}</optgroup>`;
    if (derived.length) {
      html += `<optgroup label="Derived images">${derived.map(t =>
        opt(t.tag, `${imageTagOf(t.tag)} — ${t.derived.status.toLowerCase()}${t.derived.summary ? ` · ${t.derived.summary.slice(0, 40)}` : ''}`)).join('')}</optgroup>`;
    }
  } catch {
    // Not the host owner, or the daemon hiccuped: at least offer the default.
    html += opt('', 'Fleet default');
  }
  // A pin to something no longer listed stays selectable, so opening this
  // panel can never silently move the agent off it.
  if (pin && !html.includes(`value="${esc(pin)}"`)) html += opt(pin, `${pin} — not on this machine`);
  return html;
}

async function loadDerivedImages() {
  const sec = $('derivedSection'), el = $('derivedList');
  if (!sec || !el) return;
  let r;
  try {
    r = await api('/v1/images');
  } catch {
    sec.hidden = true; // not the host owner — hide the whole thing
    return;
  }
  sec.hidden = false;
  const images = Array.isArray(r?.images) ? r.images : [];
  if (!images.length) {
    el.innerHTML = `<div class="sub">None yet — ask the management agent for one, e.g. “build an image with ffmpeg for the media agent”.</div>`;
    return;
  }
  el.innerHTML = `<div class="rt-wrap"><table class="rt-tbl">
    <thead><tr><th>Image</th><th>State</th><th>Contents</th><th>Used by</th><th></th></tr></thead>
    <tbody>${images.map(img => {
      const busy = img.status === 'BUILDING';
      const kind = img.status === 'READY' ? '<span style="color:var(--ok)">✓</span> <b>ready</b>'
        : img.status === 'FAILED' ? '<span style="color:var(--bad)">✗</span> <b>failed</b>'
        : '<span style="color:var(--dim)">⏳</span> <b>building…</b>';
      // The Dockerfile lines, as one readable summary; the full text sits under the row.
      const steps = String(img.dockerfile || '').split('\n').map(s => s.trim()).filter(Boolean);
      const contents = steps.length ? `${esc(steps[0].slice(0, 54))}${steps[0].length > 54 ? '…' : ''}${steps.length > 1 ? `<div class="sub">+ ${steps.length - 1} more line${steps.length > 2 ? 's' : ''}</div>` : ''}` : '<span class="sub">—</span>';
      const who = img.pinnedBy ? `<b>${img.pinnedBy}</b> agent${img.pinnedBy > 1 ? 's' : ''} <span class="sub">pinned</span>` : '<span class="sub">nothing</span>';
      const err = img.status === 'FAILED' && img.error
        ? `<div style="color:var(--bad)">${esc(String(img.error).split('\n').filter(Boolean).pop() ?? '')}</div>` : '';
      const key = img.name.replace(/[^a-z0-9]/gi, '_');
      return `<tr>
        <td><b>${esc(img.name)}</b><div class="sub"><code title="${esc(img.tag)}">${esc(imageTagOf(img.tag))}</code></div></td>
        <td>${kind}<div class="sub">${img.builtAt ? `built ${esc(img.builtAt.slice(0, 10))}` : 'never built'}</div></td>
        <td>${contents}<div class="sub">FROM ${esc(imageTagOf(img.base))}</div></td>
        <td>${who}</td>
        <td><div class="rt-acts">
          <button ${onAction('click', 'toggleDerivedLines', [`${img.name ?? ''}`, `${key}`])} title="The Dockerfile lines in this image">🔎</button>
          <button ${busy ? 'disabled' : ''} ${onAction('click', 'rebuildDerivedImage', [`${img.name ?? ''}`])} title="Build it again from its Dockerfile lines">↻ Rebuild</button>
          <button ${onAction('click', 'showDerivedLog', [`${img.name ?? ''}`])}>Log</button>
          <button class="danger" ${busy ? 'disabled' : ''} ${onAction('click', 'deleteDerivedImage', [`${img.name ?? ''}`])} title="Delete this derived image">🗑</button>
        </div></td>
      </tr><tr class="rt-under"><td colspan="5">${err}<pre id="dvLines_${key}" hidden style="margin:6px 0 0;max-height:220px;overflow:auto;font-size:11px;white-space:pre-wrap;background:#0b0b0b;color:#ddd;padding:8px;border-radius:8px">${esc(img.dockerfile || '')}</pre></td></tr>`;
    }).join('')}</tbody></table></div>`;
  // Resume following any build still in progress (e.g. after a page reload).
  for (const img of images) if (img.status === 'BUILDING') pollDerivedBuild(img.name);
}

function toggleDerivedLines(name, key) {
  const pre = $('dvLines_' + key);
  if (pre) pre.hidden = !pre.hidden;
}

/** Hand the job to the management agent: it writes the Dockerfile, you Confirm. */
function askMgmtForImage() {
  if (pageSecondFactorBusy()) { toast('Finish signing in or saving your codes before asking for an image.', 8000); return; }
  const ops = (agents ?? []).find(a => a.ops && v2Mine(a) && a.state === 'RUNNING');
  if (!ops) { toast('Set up your Hatchabot agent first — it writes the Dockerfile for you.', 8000); return; }
  if (aiDlg.open) aiDlg.close(); // leave any other pending form to its own completion path
  openGateway(ops.id, ops.slug);
  toast('Ask it for the image — e.g. “build a derived image called media-tools with ffmpeg”.', 9000);
}
async function rebuildDerivedImage(name) {
  try {
    await api(`/v1/images/${encodeURIComponent(name)}/rebuild`, { method: 'POST', body: {} });
    toast(`Rebuilding ${name}…`);
    await loadDerivedImages();
    pollDerivedBuild(name);
  } catch (e) { toast(e.message); }
}

async function deleteDerivedImage(name) {
  if (!confirm(`Delete derived image "${name}"? This removes it from docker.`)) return;
  try {
    await api(`/v1/images/${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast(`Removed "${name}".`);
    loadDerivedImages();
  } catch (e) { toast(e.message); } // 409 = still pinned; the message names who
}

async function showDerivedLog(name) {
  const pre = $('derivedBuildOut');
  try {
    const r = await api(`/v1/images/${encodeURIComponent(name)}/log`);
    pre.hidden = false;
    pre.textContent = r.log || '(no build output yet)';
    pre.scrollTop = pre.scrollHeight;
  } catch (e) { toast(e.message); }
}

/** How long a build's log is waited for between two reads, and at most after reads that failed. */
const DERIVED_POLL_MS = 1500, DERIVED_RETRY_MAX_MS = 30_000;
/**
 * Follow a running build: stream the log into the output box until it ends.
 * A log that will not read is not the build ending: it is read again, each
 * wait twice the last, and said once. The failure went back to the list,
 * which followed the build again at once: a loop of reads with no wait and a
 * toast each time (HB-0996). Only an end (built, failed, the image gone or
 * not this person's) shows the list again.
 */
async function pollDerivedBuild(name) {
  if (derivedBuilding.has(name)) return;
  derivedBuilding.add(name);
  const pre = $('derivedBuildOut');
  pre.hidden = false;
  let ended = false;
  try {
    for (let fails = 0, wait = DERIVED_POLL_MS; ; await new Promise(res => setTimeout(res, wait))) {
      let r;
      try { r = await api(`/v1/images/${encodeURIComponent(name)}/log`); }
      catch (e) {
        if (e.status === 401 || e.status === 403 || e.status === 404) { ended = true; break; }
        if (!fails++) toast(e.message);
        wait = Math.min(DERIVED_POLL_MS * 2 ** fails, DERIVED_RETRY_MAX_MS);
        continue;
      }
      fails = 0; wait = DERIVED_POLL_MS;
      pre.textContent = r.log || '';
      pre.scrollTop = pre.scrollHeight;
      if (r.status === 'READY') { toast(`✓ Built ${name}.`); ended = true; break; }
      if (r.status === 'FAILED') { toast(`✗ ${name} failed to build — see the log.`); ended = true; break; }
    }
  } finally { derivedBuilding.delete(name); if (ended) loadDerivedImages(); }
}

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
  const id = (typeof v2AgentId !== 'undefined' && v2AgentId) || editAgentId;
  const classId = sel.value || null;
  // Another agent's sheet opened while this one saved: its model menu stays its own,
  // and what is said names the agent it was for (HB-0590).
  const f = forAgent(id);
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
const fmtN = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
const clock = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
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

// ---- ⚡ Bulk actions: a selection of agents + one action -------------------
function faAgents() {
  // Owner's own, non-archived — the set bulk actions operate on. A→Z, so a
  // name is where you expect it (the home screen's order is the owner's own).
  // Never the manager: it is pinned on purpose, moves last, and a bulk stop or
  // model switch would take the fleet's own operator down with the rest.
  return agents.filter(a => (a.role ? a.role === 'owner' : true) && a.state !== 'ARCHIVED' && !a.ops)
    .sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: 'base', numeric: true }));
}
