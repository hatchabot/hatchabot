// web/app/images.js: the Runtime images dialog, moving agents between machines, CLI tokens.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- Runtime images dialog ---------------------------------------------------
let rtData = null, rtBuildTimer = null;
async function loadRuntimeImages() {
  try {
    const imgs = await api('/v1/runtime/images');
    rtData = imgs;
    // Only what asks something of you: agents that still need a Rebuild.
    // Versions, upgrades and building a newer OpenClaw are the Hatchabot agent's.
    const lag = (agents ?? []).filter(a => a.rebuild).length;
    $('rtBase').textContent = lag ? `${lag} agent${lag > 1 ? 's' : ''} still need${lag > 1 ? '' : 's'} a Rebuild (each one's Overview says why).` : '';
    $('rtBase').hidden = !lag;
    renderRuntimeList();
  } catch (e) { $('rtList').innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}
function renderRuntimeList() {
  const d = rtData; if (!d) return;
  // Park the capability list before the redraw, or innerHTML would destroy it.
  const caps = $('runtimeCaps');
  if (caps && $('rtList').contains(caps)) { $('rtCapsHome').append(caps); $('rtCapsHome').hidden = false; }
  if (!d.tags.length) { $('rtList').innerHTML = '<div class="sub">No runtime image is built on this machine yet.</div>'; return; }
  const defV = d.defaultInfo?.openclawVersion;
  const rows = d.tags.map(t => {
    // An image named for one version but carrying another is a bad build: say so loudly.
    // A content revision (the same OpenClaw plus a suffix that starts with a
    // letter, e.g. 2026.7.1-2-ch1) is a proper name, not a mislabel.
    const named = /:(\d{4}\.\d+\.\d+[\w.-]*)$/.exec(t.tag)?.[1];
    const isRevision = named && t.openclawVersion && named.startsWith(t.openclawVersion + '-') && /^[a-z]/i.test(named.slice(t.openclawVersion.length + 1));
    const mislabelled = t.exists && named && t.openclawVersion && named !== t.openclawVersion && !isRevision
      ? `<div style="color:var(--bad)">⚠ This image is named ${esc(named)} but contains OpenClaw ${esc(t.openclawVersion)}. It was not built correctly: end any trial on it and delete it.</div>` : '';
    const apps = (t.channels ?? []).map(k => ({ slack: 'Slack', discord: 'Discord' })[k]).filter(Boolean);
    const extras = (t.extraPackages ?? []).filter(Boolean);
    const own = t.derived?.summary ? `<div class="sub" title="${esc(t.derived.summary)}">${esc(t.derived.summary.slice(0, 60))}${t.derived.summary.length > 60 ? '…' : ''}</div>` : '';
    const contents = !t.exists ? '' : ([apps.length ? `with ${apps.join(' and ')}` : '', extras.length ? `plus ${extras.map(esc).join(', ')}` : '', t.embedEngine === 'none' ? 'shared memory search only' : ''].filter(Boolean).join(' · ') || 'stock') + own;
    const version = !t.exists ? '' : t.openclawVersion
      ? `<b>${esc(t.openclawVersion)}</b>${defV && t.openclawVersion !== defV && !t.isDefault ? `<div class="sub">default: ${esc(defV)}</div>` : ''}`
      : '<span class="sub">unknown</span>';
    const built = !t.exists ? '' : [t.size ? esc(t.size) : '', t.createdAt ? `built ${esc(t.createdAt.slice(0, 10))}` : ''].filter(Boolean).join(' · ');
    const kind = t.isDefault ? '⭐ <b>fleet default</b>' + (d.defaultInfo?.resolvesTo?.length ? `<div class="sub">also tagged ${d.defaultInfo.resolvesTo.map(x => `<code>${esc(imageTagOf(x))}</code>`).join(', ')}</div>` : '')
      : t.derived ? `<b>derived</b> · ${esc(t.derived.status.toLowerCase())}<div class="sub">FROM ${esc(imageTagOf(t.derived.base))}</div>`
      : t.relation === 'same' ? '<b>= fleet default</b><div class="sub">same image, another name</div>'
      : t.tag.includes(':derived-') ? '<b>leftover</b><div class="sub">a derived image whose record is gone — safe to delete</div>'
      : t.relation === 'newer' ? '<b>candidate</b><div class="sub">newer than the default</div>'
      : t.relation === 'older' ? 'older build<div class="sub">a previous default</div>'
      : t.exists ? 'candidate' : '<b>not built</b><div class="sub">on this machine</div>';
    const pins = t.pinned.map(a => `<span class="chip" title="${esc(a.state)}">${a.mine ? '' : '👥 '}${a.state === 'REBUILDING' ? '↻ rebuilding · ' : ''}${esc(a.name)}${a.state === 'ARCHIVED' ? ' · archived' : ''}${a.runner ? ` · on ${esc(a.runner)}` : ''}${a.mine && a.state !== 'ARCHIVED' ? ` <a href="#" title="Discard the trial: unpin it and put it back on the fleet default (rebuilt now if running; a stopped one moves when it next starts)" ${onAction('click', 'discardTrial', [`${a.id}`, `${a.name ?? ''}`], 'prevent')}>✕</a>` : ''}</span>`).join(' ');
    const cls = t.classes.map(c => `<span class="chip">${c.mine === false ? '👥 ' : ''}🏷 ${esc(c.name)}</span>`).join(' ');
    // Pins and classes have their chips above; these are the rest of what blocks a delete.
    const blockers = t.blockers ?? [];
    const held = blockers.filter(b => b.kind !== 'pin' && b.kind !== 'class').map(b => `<span class="chip" title="${esc(b.fix)}">${b.mine ? '' : '👥 '}${esc(b.name)} · ${esc(b.label)}</span>`).join(' ');
    const fixes = [...new Set(blockers.map(b => b.fix))].map(f => `<div class="sub">${esc(f)}</div>`).join('');
    // "nothing" promises the delete works, so it needs Docker's answer about containers.
    const unchecked = d.containersChecked === false && t.exists ? '<div class="sub">Containers could not be checked: Docker did not answer.</div>' : '';
    const holders = [pins, cls, held].filter(Boolean).join(' ');
    const who = t.isDefault ? `<b>${d.unpinned.length}</b> agent${d.unpinned.length === 1 ? '' : 's'} <span class="sub">with no pin</span>` : holders ? `${holders}${fixes}${unchecked}` : unchecked || '<span class="sub">nothing</span>';
    const canPromote = t.exists && !t.isDefault && !t.isLatest && !t.derived;
    const canDelete = t.exists && !t.isDefault && !t.derived;
    const key = t.tag.replace(/[^a-z0-9]/gi, '_');
    const acts = [
      t.exists ? `<button ${onAction('click', 'toggleImageDetails', [`${t.tag ?? ''}`, `${key}`])} title="What is baked into this image (its build steps)">🔎</button>` : '',
      t.exists && !t.isDefault ? `<button ${onAction('click', 'tryOnAgent', [`${t.tag ?? ''}`])} title="Try it on one agent: pin that agent to this image and rebuild it (memory kept)">🧪</button>` : '',
      canPromote ? `<button class="primary" ${onAction('click', 'promoteImage', [`${t.tag ?? ''}`])} title="Point the fleet default at this image; agents without a pin pick it up on their next rebuild">⬆ Promote</button>` : '',
      t.derived ? `<button ${onAction('click', 'rebuildDerivedImageAndList', [`${t.derived.name ?? ''}`])} title="Build it again from its Dockerfile lines">↻</button><button ${onAction('click', 'showDerivedLog', [`${t.derived.name ?? ''}`])}>Log</button><button class="danger" ${onAction('click', 'deleteDerivedImageAndList', [`${t.derived.name ?? ''}`])} title="Delete this derived image">🗑</button>` : '',
      canDelete ? `<button class="danger" ${onAction('click', 'deleteImageTag', [`${t.tag ?? ''}`])} title="Delete this tag (refused while Used by lists anything)">🗑</button>` : '',
    ].join('');
    const under = mislabelled
      + (t.exists ? `<pre id="rtHist_${key}" hidden style="margin:6px 0 0;max-height:260px;overflow:auto;font-size:11px;white-space:pre-wrap;background:#0b0b0b;color:#ddd;padding:8px;border-radius:8px"></pre>` : '')
      + (t.isDefault ? `<details class="rt-caps" id="rtCapsBox"${rtCapsOpen ? ' open' : ''} ${onAction('toggle', 'noteRtCapsOpen', [{ $: 'open' }])}><summary>What agents can do with this image</summary><div id="rtCapsSlot"></div></details>` : '');
    return `<tr>
        <td><code title="${esc(t.tag)}">${esc(imageTagOf(t.tag))}</code>${built ? `<div class="sub">${built}</div>` : ''}</td>
        <td>${kind}</td>
        <td>${version}${contents ? `<div class="sub">${contents}</div>` : ''}</td>
        <td>${who}</td>
        <td><div class="rt-acts">${acts}</div></td>
      </tr>${under ? `<tr class="rt-under"><td colspan="5">${under}</td></tr>` : ''}`;
  }).join('');
  $('rtList').innerHTML = `<div class="rt-wrap"><table class="rt-tbl">
    <thead><tr><th>Tag <span class="sub">of hatchabot-runtime</span></th><th>What it is</th><th>Contents</th><th>Used by</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
  // The capability list describes the fleet default, so it lives under that
  // image's entry (the element moves; its loader keeps filling it wherever it is).
  const slot = $('rtCapsSlot');
  if (slot) { slot.append($('runtimeCaps')); $('rtCapsHome').hidden = true; }
}
let rtCapsOpen = false;
async function toggleImageDetails(tag, key) {
  const pre = $('rtHist_' + key);
  if (!pre.hidden) { pre.hidden = true; return; }
  pre.hidden = false; pre.textContent = 'Reading image history…';
  try {
    const r = await api(`/v1/runtime/images/${encodeURIComponent(tag)}/history`);
    pre.textContent = r.steps.length ? r.steps.map(h => `${h.size.padStart(7)}  ${h.step}`).join('\n') : '(no build history available)';
  } catch (e) { pre.textContent = e.message; }
}
async function deleteImageTag(tag) {
  if (!confirm(`Remove the tag ${tag} from this machine?\n\nRefused while anything under Used by holds it. Layers shared with other images are kept.`)) return;
  try { await api(`/v1/runtime/images/${encodeURIComponent(tag)}`, { method: 'DELETE' }); toast(`Removed ${tag}.`); await loadRuntimeImages(); }
  catch (e) { $('rtErr').textContent = e.message; }
}
/**
 * Trying a candidate image: a list of every eligible agent with checkboxes.
 * It used to be a prompt() asking for a NUMBER from a typed-out list, which
 * stopped being usable at about twenty agents (2026-09-19).
 */
let tryState = null;
function tryOnAgent(tag) {
  const eligible = tryCandidates(tag);
  if (!eligible.length) {
    toast(agents.some(a => a.image === tag) ? 'Every agent that can take it is already on it.' : 'No agent available to try it on.');
    return;
  }
  tryState = { tag, picked: new Set() };
  $('tryTag').textContent = imageTagOf(tag);
  $('tryTagFull').textContent = tag;
  $('tryFilter').value = '';
  $('tryErr').textContent = '';
  renderTryList();
  tryDlg.showModal();
}
/** Yours, alive enough to rebuild, and not already on this image. */
function tryCandidates(tag) {
  return agents.filter(a => (a.role ? a.role === 'owner' : true) && ['RUNNING', 'STOPPED'].includes(a.state) && a.image !== tag);
}
function tryVisible() {
  const q = $('tryFilter').value.trim().toLowerCase();
  return tryCandidates(tryState?.tag).filter(a => !q || `${a.name} ${a.group ?? ''}`.toLowerCase().includes(q));
}
function renderTryList() {
  if (!tryState) return;
  const list = tryVisible();
  $('tryList').innerHTML = list.length
    ? list.map(a => `<label style="display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line);cursor:pointer;font-weight:400">
        <input type="checkbox" style="width:auto;flex:none" ${tryState.picked.has(a.id) ? 'checked' : ''} ${onAction('change', 'tryPick', [`${a.id ?? ''}`, { $: 'checked' }])}>
        <span class="grow">${esc(a.name)}<span class="sub"> · ${esc(a.state.toLowerCase())}${a.group ? ' · ' + esc(a.group) : ''}${a.image ? ` · 📌 ${esc(imageTagOf(a.image))}` : ''}</span></span>
      </label>`).join('')
    : '<div class="sub" style="padding:8px 0">No agent matches that.</div>';
  updateTryBtn();
}
function tryPick(id, on) {
  if (!tryState) return;
  if (on) tryState.picked.add(id); else tryState.picked.delete(id);
  updateTryBtn();
}
/** All / none applies to what the filter is showing, not the whole fleet. */
function tryPickAll(on) {
  for (const a of tryVisible()) { if (on) tryState.picked.add(a.id); else tryState.picked.delete(a.id); }
  renderTryList();
}
function updateTryBtn() {
  const n = tryState?.picked.size ?? 0;
  $('tryBtn').disabled = !n;
  $('tryBtn').textContent = n ? `Pin & rebuild ${n}` : 'Pin & rebuild';
}
async function runTryOnAgents() {
  if (!tryState?.picked.size) return;
  const { tag } = tryState;
  const ids = [...tryState.picked];
  const names = ids.map(id => agents.find(a => a.id === id)?.name).filter(Boolean);
  const shown = names.slice(0, 12).join(', ') + (names.length > 12 ? `, and ${names.length - 12} more` : '');
  // As the manager's try does (HB-0469): a rebuild ends RUNNING, so only a running
  // agent rebuilds now. A stopped or sleeping one stays so; the pin is kept for
  // its next start, which is the rebuild (the PATCH marks it, HB-0441).
  const up = ids.filter(id => agents.find(a => a.id === id)?.state === 'RUNNING').length, down = ids.length - up;
  const what = [
    up ? `${up === ids.length ? (up === 1 ? 'It rebuilds' : 'They rebuild') : `The ${up} running rebuild`} now: Chat → Memory runs first, and memory is kept.` : '',
    down ? `${down === ids.length ? (down === 1 ? 'It is' : 'They are') : `The ${down} other${down === 1 ? ' is' : 's are'}`} not running, so ${down === 1 ? 'it stays' : 'they stay'} that way and ${down === 1 ? 'moves' : 'move'} onto it when ${down === 1 ? 'it next starts' : 'each next starts'}.` : '',
  ].filter(Boolean).join(' ');
  if (!confirm(`Pin ${ids.length} agent${ids.length === 1 ? '' : 's'} to ${tag}?\n\n${shown}\n\n${what} Discard a trial later with ✕ next to the agent's name.`)) return;
  $('tryBtn').disabled = true;
  const failed = [];
  let rebuilding = 0, waiting = 0, same = 0, held = 0;
  for (const id of ids) {
    const a = agents.find(x => x.id === id);
    const name = a?.name ?? id;
    let r;
    try { r = await api(`/v1/agents/${id}`, { method: 'PATCH', body: { image: tag } }); }
    catch (e) { failed.push(`${name}: not pinned: ${e.message}`); continue; }
    if (r?.sameImage) { same++; continue; }
    try {
      // Always asked, whatever the page last saw: the server rebuilds a running
      // agent and keeps it for a stopped one's next start (stoppedWaits). The
      // page's view is old: one it lists as asleep may have been woken since,
      // and skipping it left it on the old image (review of HB-0469). The
      // confirm promises Chat → Memory first: the rebuild asks for it.
      const r2 = await api(`/v1/agents/${id}/rebuild`, { method: 'POST', body: { checkpoint: true, stoppedWaits: true } });
      if (r2?.atNextStart) waiting++; else rebuilding++;
    } catch (e) {
      // The pin is saved: say so, not "failed" (a stopped one still moves at its next start).
      held++;
      failed.push(`${name}: pinned, but not rebuilt yet: ${e.message}${a?.state === 'RUNNING' ? '' : ' It moves onto it when it next starts.'}`);
    }
  }
  if (failed.length) $('tryErr').innerHTML = failed.map(esc).join('<br>');
  else tryDlg.close();
  updateTryBtn();
  const said = [
    rebuilding ? `${rebuilding} agent${rebuilding === 1 ? '' : 's'} rebuilding on ${tag}${rebuilding > 1 ? ' (a few at a time)' : ''}. The spinning ring on the home screen clears when each is back.` : '',
    waiting ? `${waiting} not running: ${waiting === 1 ? 'it stays' : 'they stay'} that way and ${waiting === 1 ? 'moves' : 'move'} onto ${tag} when ${waiting === 1 ? 'it next starts' : 'each next starts'}.` : '',
    same ? `${same} already ${same === 1 ? 'runs' : 'run'} that image, so no rebuild.` : '',
    held ? `${held} pinned, but not rebuilt yet (the reason is in the list).` : '',
  ].filter(Boolean).join(' ');
  if (said) toast(said, 9000);
  await refresh(false); await loadRuntimeImages();
}

async function discardTrial(id, name) {
  // As the manager's end of a trial does (HB-0469): only a running agent rebuilds now.
  // The page's view words the question; the server's answer says what happened.
  const running = (agents.find(a => a.id === id) ?? rtData?.tags.flatMap(t => t.pinned).find(p => p.id === id))?.state === 'RUNNING';
  if (!confirm(running
    ? `Discard the trial: return "${name}" to the fleet default image and rebuild it now?`
    : `Discard the trial: return "${name}" to the fleet default image?\n\nIt is not running, so it stays that way and moves onto the fleet default when it next starts.`)) return;
  let r;
  try { r = await api(`/v1/agents/${id}`, { method: 'PATCH', body: { image: null } }); }
  catch (e) { $('rtErr').textContent = e.message; return; }
  try {
    if (r.sameImage) toast(`"${name}" is unpinned — it already runs the fleet default, so no rebuild.`, 6000);
    else {
      // The server decides, not the page's old view (as in runTryOnAgents): with
      // the pin gone, nothing else would ever move a woken agent back.
      const r2 = await api(`/v1/agents/${id}/rebuild`, { method: 'POST', body: { stoppedWaits: true } });
      toast(r2?.atNextStart ? `"${name}" is unpinned — it stays stopped and moves onto the fleet default when it next starts.` : `"${name}" is rebuilding on the fleet default.`, 6000);
    }
  } catch (e) {
    // Unpinned all the same: say so, and show it unpinned (review of HB-0469).
    const said = `"${name}" is unpinned, but was not rebuilt: ${e.message}${running ? '' : ' It moves onto the fleet default when it next starts.'}`;
    $('rtErr').textContent = said; toast(said, 9000);
  } finally { await refresh(false); await loadRuntimeImages(); }
}
async function promoteImage(tag) {
  if (!confirm(`Make ${tag} the fleet default?\n\nNothing restarts by itself: every agent without a pin shows "newer image available" and moves over when you rebuild it (Bulk actions → Needs rebuild).`)) return;
  try {
    const r = await api('/v1/runtime/images/promote', { method: 'POST', body: { tag } });
    toast(`${r.promoted} is now the fleet default — ${r.followers.length} agent${r.followers.length === 1 ? '' : 's'} will adopt it on rebuild.`, 9000);
    await refresh(false); await loadRuntimeImages();
    // The promote's own answer names the followers; the list's "needs rebuild"
    // flag lags behind it (the image check is cached a few seconds), so ticking
    // by that flag selected nobody (Chris, 2026-09-24).
    if (r.followers.length && confirm(`Open Bulk actions with the ${r.followers.length} agent${r.followers.length === 1 ? '' : 's'} that follow the fleet default selected?`)) {
      aiDlg.close();
      await openFleetActions({ ids: r.followers.filter(f => f.mine !== false).map(f => f.id), label: 'Following the fleet default' });
    }
  } catch (e) { $('rtErr').textContent = e.message; }
}
async function pollBaseBuild() {
  clearTimeout(rtBuildTimer);
  if (!aiDlg.open) return;
  try {
    const b = await api('/v1/runtime/build');
    // No build log here: the Hatchabot agent runs builds and reads their log;
    // the tab shows one line while one is running, nothing after.
    $('rtBuildLog').hidden = !b.running;
    if (b.running) $('rtBuildLog').textContent = `Building an image for OpenClaw ${b.version || '(default version)'}…`;
    if (b.running) rtBuildTimer = setTimeout(pollBaseBuild, 3000); else if (b.ok) loadRuntimeImages();
  } catch { /* not host owner / transient */ }
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

async function renderPeers() {
  try {
    const peers = await api('/v1/peers');
    $('peerList').innerHTML = peers.length
      ? peers.map(p => `<div class="pair"><span class="grow">🖥 <b>${esc(p.name)}</b> <span style="color:var(--dim)">${esc(p.url)}</span></span>
          <button class="danger" ${onAction('click', 'delPeer', [`${p.id}`, `${p.name ?? ''}`])}>×</button></div>`).join('')
      : '<div class="sub">None yet.</div>';
  } catch { /* listing is best-effort */ }
}

async function addPeer() {
  const name = $('peerName').value.trim(), url = $('peerUrl').value.trim(), token = $('peerToken').value.trim();
  // Its own error line: aiErr sits in the AI tab, so these errors were never seen (v2.157.0).
  $('peerErr').textContent = '';
  if (!name || !url || !token) { $('peerErr').textContent = 'Name, URL and token are all needed.'; return; }
  $('peerAddBtn').disabled = true;
  try {
    await api('/v1/peers', { method: 'POST', body: { name, url, token } });
    $('peerName').value = ''; $('peerUrl').value = ''; $('peerToken').value = '';
    toast('Server added');
    await renderPeers();
  } catch (e) { $('peerErr').textContent = e.message; }
  finally { $('peerAddBtn').disabled = false; }
}

async function delPeer(id, name) {
  if (!confirm(`Forget "${name}"? Agents already moved there are unaffected.`)) return;
  try { await api(`/v1/peers/${id}`, { method: 'DELETE' }); await renderPeers(); }
  catch (e) { toast(e.message); }
}

async function runsHere(id, name) {
  if (!confirm(`Mark "${name}" as running here again?\n\nOnly do this if it is NOT running on the other server — two copies polling one Telegram bot will fight over every message.`)) return;
  try {
    await api(`/v1/agents/${id}`, { method: 'PATCH', body: { runsHere: true } });
    toast('Cleared — you can start it here now');
    await refresh(false);
  } catch (e) { toast(e.message); }
}

/** Move within THIS server: local ⇄ runner. Same agent, same bot, same
 *  members — only the Docker daemon changes. (Rehost, below, is the Mesh
 *  move: to a whole other Hatchabot server.) */
async function moveHostAgent(id, name) {
  const a = agents.find(x => x.id === id);
  const others = hosts.filter(h => h.id !== a?.hostId);
  if (!others.length) return toast('There is no other runner to move to — add one in ⚙ Settings → Hosts.', 8000);
  const list = others.map((h, i) => `${i + 1}. ${h.name}${h.kind === 'local' ? ' (this machine)' : ''}`).join('\n');
  const pick = prompt(`Move "${name}" to which runner?\n\n${list}\n\nEnter a number:`);
  if (pick === null) return;
  const host = others[Number(pick) - 1];
  if (!host) return toast('No such host');
  if (!confirm(`Move "${name}" to ${host.name}?\n\nIt stops, its memory is copied over, and it starts there. Same bot, same members — nothing else changes. If anything fails it stays where it is.`)) return;
  try {
    const r = await moveHostPost(id, host, name);
    // Since v2.156.0 the move goes on on the server (202): its tile shows the step, a toast the end.
    if (r?.operation?.id) {
      v2FollowOp(r.operation);
      toast(`Moving ${name} to ${host.name} — its tile shows each step; this page can close.`, 8000);
    } else toast(`✅ ${name} now runs on ${host.kind === 'local' ? 'this machine' : host.name}.`, 10000);
  } catch (e) { toast(`Move failed: ${e.message}`, 20000); }
  await refresh(false);
}

// A pinned image the runner lacks, or has another image of that name: the
// server refuses first (nothing has stopped yet) and the owner decides
// whether to go on the runner's default. The server's words say which, and
// why (HB-1325 review: this said "does not have" of one it has, built
// another way).
async function moveHostPost(id, host, name) {
  try {
    return await api(`/v1/agents/${id}/move-host`, { method: 'POST', body: { hostId: host.id } });
  } catch (e) {
    if (e.code !== 'pinned_image_missing') throw e;
    if (!confirm(`${e.message}\n\nMove "${name}" on ${host.name}'s default image now?`)) throw new Error('kept where it is');
    return api(`/v1/agents/${id}/move-host`, { method: 'POST', body: { hostId: host.id, dropPin: true } });
  }
}

/**
 * An export carries the agent's Telegram bot, never its Slack or Discord app —
 * those belong to apps the owner made on those platforms. Say so before the
 * agent leaves, instead of letting the channels vanish quietly.
 */
function channelsLostOnExport(id) {
  const a = v2Find ? v2Find(id) : (agents || []).find(x => x.id === id);
  const kinds = (a?.otherChannels ?? []).map(c => V2_CHAN_LABEL[c.kind] || c.kind);
  return kinds.length ? `\n\n${kinds.join(' and ')} ${kinds.length > 1 ? 'do' : 'does'} not travel with it: the app belongs to your ${kinds.join('/')} account. Set it up again on the other side (Messaging → Set up).` : '';
}

async function rehostAgent(id, name) {
  let peers;
  try { peers = await api('/v1/peers'); } catch (e) { return toast(e.message); }
  if (!peers.length) return (openAiDlg('servers'), toast('Register the destination cluster server first', 6000));
  const list = peers.map((p, i) => `${i + 1}. ${p.name} (${p.url})`).join('\n');
  const pick = prompt(`Move "${name}" to which cluster server?\n\n${list}\n\nEnter a number:`);
  if (pick === null) return;
  const peer = peers[Number(pick) - 1];
  if (!peer) return toast('No such server');
  if (!confirm(`Move "${name}" to the cluster at ${peer.name}?${channelsLostOnExport(id)}\n\nIt stops here, transfers with its memory and members, and starts there — managed from that server's dashboard from now on. This copy stays STOPPED (not deleted) — never start both, they would fight over the same Telegram bot.`)) return;
  // Waits only for the other server's yes (its preflight); the move then goes on on the server (202).
  toast(`Asking ${peer.name} whether it can take ${name}…`, 60000, 'progress');
  const body = { peerId: peer.id };
  try {
    let res;
    try { res = await api(`/v1/agents/${id}/rehost`, { method: 'POST', body }); }
    catch (e) {
      // It would land on a source of another vendor while that server has one
      // of its own vendor: offered as the source to move onto instead.
      const c = e.code === 'source_choice' && e.data?.sourceChoice;
      if (!c) throw e;
      if (!confirm(`${e.message}\n\nMove "${name}" onto ${c.name} (${c.vendor}/${c.model}) on ${peer.name} instead?`)) return toast('Not moved.');
      toast(`Asking ${peer.name} whether it can take ${name} onto ${c.name}…`, 60000, 'progress');
      res = await api(`/v1/agents/${id}/rehost`, { method: 'POST', body: { ...body, aiProfileId: c.id } });
    }
    if (res?.operation?.id) {
      v2FollowOp(res.operation);
      toast(`Moving ${name} to ${peer.name} — its tile shows each step; this page can close. This copy stays stopped once it has gone.`, 10000);
    } else toast(`✅ Moved to ${res.movedTo}. This copy is ${res.sourceState} — leave it that way.`, 30000);
    await refresh(false);
  } catch (e) { toast(e.message, 30000); }
}

// The Claude model ids the app offers when it can't ask a live runtime. Newest
// first — the dropdown's top entry is the sensible default. Keep in step with
// CURATED_ANTHROPIC_MODELS in src/api/routes.ts. NO claude-opus-5: the
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

async function newCliToken(scope) {
  $('cliTokenErr').textContent = '';
  try {
    // scope 'rehost': for another server that will move agents here — that,
    // and nothing else. The old advice pasted a full token there.
    const t = await api('/v1/cli-tokens', { method: 'POST', body: scope ? { label: 'Moving agents from another Hatchabot', scope } : { label: 'CLI' } });
    const out = $('cliTokenOut');
    out.style.display = '';
    out.textContent = t.token;
    toast('Copy it now — it is not shown again', 20000);
    if (await copyText(t.token)) toast(scope ? 'Token copied — paste it on the other server, under Settings → Advanced → Other Hatchabot servers' : 'Token copied — run: hatchabot login', 20000);
    void loadCliTokens();
  } catch (e) { $('cliTokenErr').textContent = e.message; } // its own line: #aiErr is in another tab (HB-0442)
}

/** The tokens this account has minted, so one can be taken back — a retired
 *  management bot leaves its own behind, and the app could only ever add. */
async function loadCliTokens() {
  const el = $('cliTokenList');
  if (!el) return;
  try {
    const rows = await api('/v1/cli-tokens');
    el.innerHTML = rows.length
      ? rows.map(t => `<div class="pair" style="align-items:baseline;padding:4px 0;border-top:1px solid var(--line)">
          <span class="grow"><b>${esc(t.label || 'CLI')}</b>${t.scope === 'rehost' ? ' <span class="sub">(moving agents here only)</span>' : ''} <span class="sub">· made ${ago(t.createdAt)}${t.lastUsedAt ? ` · last used ${ago(t.lastUsedAt)}` : ' · never used'}</span></span>
          <button class="danger" ${onAction('click', 'revokeCliToken', [`${t.id ?? ''}`, `${(t.label || 'CLI') ?? ''}`])}>Revoke</button>
        </div>`).join('')
      : 'No tokens.';
  } catch (e) { el.textContent = e.message; }
}

async function revokeCliToken(id, label) {
  if (!confirm(`Revoke the "${label}" token?\n\nAnything signed in with it — a terminal, a cluster server — stops working immediately.`)) return;
  try { await api(`/v1/cli-tokens/${id}`, { method: 'DELETE' }); toast('Revoked.'); loadCliTokens(); }
  catch (e) { toast(e.message); }
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
