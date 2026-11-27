// web/app/images.js: the Runtime images dialog (building, trying and promoting an image, the Runtime tab), derived runtime images, asking the Hatchabot agent for one, and the image picker in an agent's settings.
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
      canPromote ? `<button class="primary" ${onAction('click', 'promoteImage', [`${t.tag ?? ''}`])} title="${esc(d.promoteRefused || 'Point the fleet default at this image; agents without a pin pick it up on their next rebuild')}">⬆ Promote</button>` : '',
      t.derived ? `<button ${onAction('click', 'rebuildDerivedImageAndList', [`${t.derived.name ?? ''}`])} title="Build it again from its Dockerfile lines">↻</button><button ${onAction('click', 'showDerivedLogFromList', [`${t.derived.name ?? ''}`])}>Log</button><button class="danger" ${onAction('click', 'deleteDerivedImageAndList', [`${t.derived.name ?? ''}`])} title="Delete this derived image">🗑</button>` : '',
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
  // HATCHABOT_IMAGE pins the fleet default to a version tag or a digest: the
  // server refuses a promote, so it is said here, before a confirm (HB-1256).
  if (rtData?.promoteRefused) { $('rtErr').textContent = rtData.promoteRefused; return; }
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
/**
 * The base build's line on the Runtime tab, read again every 3 s while one runs and Settings is open. `first`: the
 * tab's own read as it is drawn, which comes before Settings opens when Settings opens on it (openAiDlg('runtime')
 * with the drawer open): it returned unread there, and the tab said nothing (HB-1510).
 */
async function pollBaseBuild(first = false) {
  clearTimeout(rtBuildTimer);
  if (!first && !aiDlg.open) return;
  try {
    const b = await api('/v1/runtime/build');
    // No build log here: the Hatchabot agent runs builds and reads their log.
    // The tab shows one line while one is running, and how the last one ended
    // until another starts: its failure, and the words for one a restart cut
    // off, reached the owner only through Activity and the agent (HB-1510).
    const line = baseBuildLine(b);
    $('rtBuildLog').innerHTML = line;
    $('rtBuildLog').hidden = !line;
    if (b.running) rtBuildTimer = setTimeout(() => pollBaseBuild(), 3000); else if (b.ok) loadRuntimeImages();
  } catch { /* not host owner / transient */ }
}
/** GET /v1/runtime/build in a line: the build running, or how the last one ended; nothing before the first since the start. */
function baseBuildLine(b) {
  const what = `OpenClaw ${b.version || '(default version)'}`;
  if (b.running) return esc(`Building an image for ${what}…`);
  if (b.ok !== true && b.ok !== false) return '';
  const when = b.startedAt ? `, started ${new Date(b.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
  const head = `The last base image build (${what}${when})`;
  return b.ok ? `✓ ${esc(head)} finished.`
    : `<span style="color:var(--bad)">⚠ ${esc(head)} did not go through:</span> ${esc(b.error || 'no reason was given.')}`;
}

/** The Runtime tab's capability list: probed tool versions from the image,
 *  paired with what each one means for agents — plus the honest "not
 *  included" line and the server-side capabilities that ride config. */
async function loadRuntimeCaps() {
  const el = $('runtimeCaps');
  try {
    const [c, mk] = await Promise.all([
      api('/v1/runtime/capabilities'),
      api('/v1/media-key').catch(() => null),
    ]);
    const t = c.tools || {};
    const row = (name, detail, version, dot = 'var(--ok)') => `<tr><td><span style="color:${dot}">●</span> <b>${esc(name)}</b></td>
      <td class="sub">${detail}</td><td class="sub cap-ver">${version ? esc(version) : ''}</td></tr>`;
    const rows = [];
    if (t.openclaw) rows.push(row('Agent runtime', 'conversations, memory, Telegram gateway, scheduled tasks', t.openclaw));
    if (t['claude-code']) rows.push(row('Claude Code', 'the Anthropic model runtime agents think with', t['claude-code']));
    rows.push(row('Web search', 'DuckDuckGo, enabled per agent (keyless)'));
    rows.push(row('Memory search', 'semantic recall over MEMORY.md — local embeddings (or the machine\'s shared service, per agent)'));
    rows.push(row('Telegram voice notes', (mk ? mk.set ? 'Shared Gemini key saved, not tested; changes apply on Rebuild.' : 'No shared Gemini key saved; an agent may still hold a previous key until Rebuild.' : 'Shared Gemini key status unavailable.') + ' An agent may use its Gemini AI source\'s own key. Settings → Connections. Browser Talk uses separate voice settings.', '', 'var(--dim)'));
    if (t.gog) rows.push(row('Google Workspace', 'Gmail / Drive / Calendar / Sheets / Docs via <code>gog</code> — each agent connects its own account in chat', t.gog));
    if (t.python) rows.push(row('Python', 'agents run scripts; libraries install per agent (<code>pip install --target ~/.openclaw/pylibs</code>)', t.python));
    if (t.git) rows.push(row('Git + SSH', 'repo data sources with generated deploy keys', t.git));
    if (t.node) rows.push(row('Node.js', 'the runtime base', t.node));
    const missing = (c.missing || []).length
      ? `<div class="sub" style="margin-top:8px">Not included (by design, to keep the image lean): ${c.missing.map(esc).join(', ')} — so no local audio/video processing. Agents can still fetch web pages and read PDFs/images via the model; a browser of its own is an option per agent (its page → Advanced → Browser).</div>`
      : '';
    el.innerHTML = `<div class="cap-wrap"><table class="cap-table"><thead><tr><th>Capability</th><th>What it's for</th><th>Version</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table></div>` + missing;
  } catch (e) { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}

async function loadRuntime() {
  loadRuntimeCaps();
  loadDerivedImages();
  $('rtPanel').hidden = !myAccount.hostOwner;
  if (myAccount.hostOwner) { $('rtErr').textContent = ''; loadRuntimeImages(); pollBaseBuild(true); }
  const el = $('runtimeStatus');
  try {
    const r = await api('/v1/runtime');
    const cur = r.imageVersion ? esc(r.imageVersion) : 'unknown (image not built yet?)';
    let latestLine;
    if (!r.npmLatest) latestLine = `<div class="sub">Couldn't reach npm to check the latest stable.</div>`;
    else if (r.upgradeAvailable && appConfig?.managed) latestLine = '';
    else if (r.upgradeAvailable) latestLine = `<div style="color:var(--warn)">⬆ OpenClaw <b>${esc(r.npmLatest)}</b> is the latest stable — you're on ${cur}.</div>`;
    else latestLine = `<div style="color:var(--ok)">✓ up to date with the latest stable (${esc(r.npmLatest)}).</div>`;
    const lagging = (agents ?? []).filter(a => a.rebuild).length;
    // The machine owner gets buttons below (candidate → try → promote), so
    // the command-line hints and the repeated "newer version" line only
    // confuse there; everyone else still needs them.
    const owner = !!myAccount.hostOwner;
    el.innerHTML =
      `<div style="font-size:15px"><b>Runtime image:</b> OpenClaw ${cur}</div>
       ${owner && r.upgradeAvailable ? '' : `<div style="margin-top:4px">${latestLine}</div>`}
       ${r.npmExtendedStable ? `<div class="sub" style="margin-top:2px">extended-stable track: <code>${esc(r.npmExtendedStable)}</code></div>` : ''}
       ${lagging ? `<div class="sub" style="margin-top:8px">${lagging} agent${lagging > 1 ? 's need' : ' needs'} a <b>Rebuild</b> (each card says why).</div>` : ''}
       ${owner ? '' : `<div class="sub" style="margin-top:12px">Upgrading is done by whoever runs this machine.</div>`}`;
  } catch (e) { el.innerHTML = `<div class="sub">${esc(e.message)}</div>`; }
}

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
  const gen = ++imagePickGen, r = sheetRead(() => gen === imagePickGen);
  // While the list loads only the pin is offered, and Pin waits (saveImagePin): not another
  // agent's options, and not this one's old list either, where a choice made would be put back
  // to the pin by the answer (a pin changed elsewhere, refilled on a tab drawn again). The
  // picker is this agent's from then on, loading: back to the one before while it loads, it is
  // drawn again for that one (it held this one's pin, and Pin & rebuild sent it there).
  sheetFill([sel], () => {
    sel.innerHTML = `<option value="${esc(pin)}">Loading images…</option>`; sel.value = pin;
    sel.dataset.agent = String(r.id); sel.dataset.loading = '1';
  });
  const html = await imageOptionsHtml(pin);
  r.fill([sel], () => {
    sel.innerHTML = html;
    sel.value = pin;
    sel.dataset.agent = String(r.id); delete sel.dataset.loading;
  });
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
      // What an import lays on the base before the lines, as the base it came
      // from had them: every Rebuild lays them on too, so they are named (HB-1327).
      const basePkgs = (Array.isArray(img.basePackages) ? img.basePackages : []).filter(p => typeof p === 'string' && p);
      const under = basePkgs.length
        ? `<div class="sub" title="Installed on the base before these lines by every build: the image this one was imported from had them in its base, and this machine's base does not">+ base packages: ${esc(basePkgs.join(', '))}</div>` : '';
      const who = img.pinnedBy ? `<b>${img.pinnedBy}</b> agent${img.pinnedBy > 1 ? 's' : ''} <span class="sub">pinned</span>` : '<span class="sub">nothing</span>';
      const err = img.status === 'FAILED' && img.error
        ? `<div style="color:var(--bad)">${esc(String(img.error).split('\n').filter(Boolean).pop() ?? '')}</div>` : '';
      const key = img.name.replace(/[^a-z0-9]/gi, '_');
      return `<tr>
        <td><b>${esc(img.name)}</b><div class="sub"><code title="${esc(img.tag)}">${esc(imageTagOf(img.tag))}</code></div></td>
        <td>${kind}<div class="sub">${img.builtAt ? `built ${esc(img.builtAt.slice(0, 10))}` : 'never built'}</div></td>
        <td>${contents}${under}<div class="sub">FROM ${esc(imageTagOf(img.base))}</div></td>
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
 * The Derived images drawer is on screen: Settings open on Advanced, with that
 * drawer unfolded. Folded, its log was read every 1.5 s out of sight, and the
 * Runtime images drawer alone started following a build (HB-1525).
 */
const derivedPanelShown = () => aiDlg.open && !$(TABS.derived).hidden && !settingsAdvFolded('derived');
/**
 * Follow a running build: stream the log into the output box until it ends.
 * A log that will not read is not the build ending: it is read again, each
 * wait twice the last, and said once. The failure went back to the list,
 * which followed the build again at once: a loop of reads with no wait and a
 * toast each time (HB-0996). Only an end (built, failed, the image gone or
 * not this person's) shows the list again. Followed only while its panel is
 * shown: it was read every 30 s or less with the panel closed, for as long as
 * the page was open (HB-1220). Opening the panel, or unfolding its drawer,
 * follows it again (loadRuntime, loadDerivedImages).
 */
async function pollDerivedBuild(name) {
  if (derivedBuilding.has(name)) return;
  derivedBuilding.add(name);
  const pre = $('derivedBuildOut');
  pre.hidden = false;
  let ended = false;
  try {
    for (let fails = 0, wait = DERIVED_POLL_MS; ; await new Promise(res => setTimeout(res, wait))) {
      if (!derivedPanelShown()) break;
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
