// web/app/operations.js: an agent's memory cap, compressed swap, memory search engine, image pin, sleep and file cap, downloading its history, the long operations the page follows, its context (resets and checkpoints), what needs attention, Check all.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- memory cap: a ceiling on the agent's container, its own or its class's or the fleet default ----
const MEMORY_CAP_CHOICES = ['1g', '2g', '3g', '4g', '6g', '8g', '12g', '16g', '24g', '32g', '48g', '64g'];
const capBytes = (c) => { const m = /^(\d+(?:\.\d+)?)([mg])$/i.exec(c || ''); return m ? Math.round(Number(m[1]) * (m[2].toLowerCase() === 'g' ? 1073741824 : 1048576)) : 0; };
const capLabel = (c) => { const b = capBytes(c); return b >= 1073741824 ? `${Number.isInteger(b / 1073741824) ? b / 1073741824 : (b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`; };
/**
 * `keep`: a choice not saved yet in either menu stays (v2KeepsChoice), in options worded afresh
 * (what it inherits: the class's or the fleet's, now); without it, both are filled from the record.
 */
function fillMemoryCapRow(a, keep = false) {
  const dflt = myAccount.memoryCapDefault || '3g';
  const max = capBytes(myAccount.memoryCapMax || '8g') || Infinity;
  const cls = a.classId ? (agentClasses || []).find(c => c.id === a.classId) : null;
  const inherited = cls?.memoryCap ? `its class's ${capLabel(cls.memoryCap)}` : `the fleet default, ${capLabel(dflt)}`;
  const sel = $('editMemoryCap'), kept = keep && v2KeepsChoice('editMemoryCap', a.memoryCap || '') ? sel.value : null;
  const choices = [...new Set([...MEMORY_CAP_CHOICES.filter(c => capBytes(c) <= max), ...(a.memoryCap ? [a.memoryCap] : []), ...(kept ? [kept] : [])])].sort((x, y) => capBytes(x) - capBytes(y));
  sel.innerHTML = `<option value="">No cap of its own — ${esc(inherited)}</option>` + choices.map(c => `<option value="${c}">${capLabel(c)}${c === dflt ? ' (the fleet default)' : ''}</option>`).join('');
  if (kept !== null) sel.value = kept; // still unsaved: its baseline stays the fill's or the last save's
  else sheetFill(['editMemoryCap'], () => { sel.value = a.memoryCap || ''; });
  $('memoryBumpBtn').hidden = !(a.state === 'RUNNING' || a.state === 'STOPPED') || (capBytes(a.memoryCapEffective) + 1073741824 > max);
  $('memoryCapStatus').textContent = memoryCapText(a);
  fillSwapRow(a, keep);
}
function memoryCapText(a) {
  const mb = (b) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
  const bits = [`Its container runs with ${a.memoryCapEffective ? capLabel(a.memoryCapEffective) : 'the default'}`];
  if (a.memoryPeakBytes) bits.push(`peak ${mb(a.memoryPeakBytes)} since it started`);
  if (a.memoryCapHits) bits.push(`hit its cap ${a.memoryCapHits}×`);
  if (a.memoryKills) bits.push(`${a.memoryKills} of its processes killed for memory`);
  const s = bits.join(' · ') + '.';
  return (a.memoryCapHits || a.memoryKills) ? s + ' A cap it keeps hitting starves its own jobs: give it more, or ask it to run smaller ones. The agent knows its budget (AGENTS.md → Memory budget).' : s;
}
/** Where a saved cap or swap went: on the running container, or kept for its next start (the server's limitsKept: why its container kept the old ones). */
const limitsWhere = (r) => r.limitsKept ? ` — kept for its next start: its container kept its old memory limits (${r.limitsKept.why || 'not applied'})`
  : r.state === 'RUNNING' ? ' — applied to the running container' : '';
async function saveMemoryCap() {
  const v = $('editMemoryCap').value;
  const f = sheetSave(); // drawn again below, in its own forms: fillMemoryCapRow notes it
  try {
    const r = await api(`/v1/agents/${f.id}`, { method: 'PATCH', body: { memoryCap: v || null } });
    // Its container kept its old limits (its machine asleep or gone): saved for its next start, said, not "applied".
    f.say(v ? `Memory cap ${capLabel(v)}${limitsWhere(r)}.` : `Memory cap back to the default${r.limitsKept ? limitsWhere(r) : ''}.`, r.limitsKept ? 12000 : 7000);
    await refresh(false);
    // The cap saved is the record now; a swap chosen and not saved yet stays.
    f.draw(() => { const a = agents.find(x => x.id === f.id); if (a) fillMemoryCapRow(a, true); });
  } catch (e) { f.fail(e); }
}
// ---- compressed swap: an allowance on top of the cap, only where the machine compresses swap ----
const SWAP_CHOICES = ['512m', '1g', '2g', '3g', '4g', '6g', '8g', '12g', '16g'];
function fillSwapRow(a, keep = false) {
  const capB = capBytes(a.memoryCapEffective || myAccount.memoryCapDefault || '3g');
  const cls = a.classId ? (agentClasses || []).find(c => c.id === a.classId) : null;
  const fleet = a.swapAllowanceDefault || 'off';
  const label = (v) => v === 'off' ? 'off' : capLabel(v);
  const inherited = cls?.swapAllowance ? `its class's: ${label(cls.swapAllowance)}` : `the machine's: ${label(fleet)}`;
  const own = a.swapAllowance || '';
  // As the cap's menu: a kept choice keeps its value, in options worded afresh.
  const sel = $('editSwapAllowance'), kept = keep && v2KeepsChoice('editSwapAllowance', own) ? sel.value : null;
  const choices = [...new Set([...SWAP_CHOICES.filter(c => capBytes(c) <= capB), ...[own, kept].filter(v => v && v !== 'off')])].sort((x, y) => capBytes(x) - capBytes(y));
  sel.innerHTML = `<option value="">No setting of its own — ${esc(inherited)}</option><option value="off">Off for this agent</option>`
    + choices.map(c => `<option value="${c}">${capLabel(c)} on top of its cap</option>`).join('');
  if (kept !== null) sel.value = kept;
  else sheetFill(['editSwapAllowance'], () => { sel.value = own; });
  $('swapStatus').textContent = swapText(a);
  $('swapStatus').style.color = a.swapWithheld ? 'var(--warn)' : '';
}
function swapText(a) {
  const mb = (b) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
  const want = a.swapAllowanceEffective || 'off';
  if (want === 'off') return a.swapInEffect && a.swapInEffect !== 'off' ? `No swap allowance; its container still has ${a.swapInEffect === 'unlimited' ? 'unlimited swap' : capLabel(a.swapInEffect)} until it is next started or rebuilt.` : 'No swap: at its cap, the kernel reclaims or kills.';
  if (a.swapWithheld) return `⚠ ${capLabel(want)} allowed, but not given: ${a.swapWithheld} The machine's owner turns it on with: ${a.swapFix || 'scripts/enable-compressed-swap.sh'}`;
  const bits = [`Up to ${capLabel(want)} of compressed swap on top of its ${a.memoryCapEffective ? capLabel(a.memoryCapEffective) : 'cap'}`];
  if (a.swapBytes !== undefined) bits.push(a.swapBytes ? `${mb(a.swapBytes)} in swap now` : 'nothing in swap now');
  return bits.join(' · ') + '. Cold memory is compressed (about 3:1); it answers again in milliseconds, a busy turn a second or two slower.';
}
async function saveSwapAllowance() {
  const v = $('editSwapAllowance').value;
  const f = sheetSave(); // drawn again below, in its own forms: fillSwapRow notes it
  try {
    const r = await api(`/v1/agents/${f.id}`, { method: 'PATCH', body: { swapAllowance: v || null } });
    f.say((v === 'off' ? 'Swap off for this agent' : v ? `Swap allowance ${capLabel(v)}` : 'Swap back to the default') + (v && v !== 'off' || r.limitsKept ? limitsWhere(r) : '') + '.', r.limitsKept ? 12000 : 7000);
    await refresh(false);
    // As the cap's: a cap chosen and not saved yet stays.
    f.draw(() => { const a = agents.find(x => x.id === f.id); if (a) fillMemoryCapRow(a, true); });
  } catch (e) { f.fail(e); }
}
/** One step up, and saved at once (saveMemoryCap): it waits for nothing, so it reads the forms' agent here. */
function bumpMemoryCap() {
  const a = agents.find(x => x.id === editAgentId); if (!a) return;
  const next = `${Math.floor(capBytes(a.memoryCapEffective || myAccount.memoryCapDefault || '3g') / 1073741824) + 1}g`;
  $('editMemoryCap').value = next;
  if ($('editMemoryCap').value !== next) { const o = document.createElement('option'); o.value = next; o.textContent = capLabel(next); $('editMemoryCap').append(o); $('editMemoryCap').value = next; }
  return saveMemoryCap();
}
function embedModeText(a) {
  const want = a.embedMode || 'baked', have = a.appliedEmbedMode;
  const engine = (m) => m === 'shared' ? 'the shared service' : 'its own engine';
  let t = have ? `Running on ${engine(have)}` : 'Not built yet';
  if (have && want !== have) t += ` — switches to ${engine(want)} on the next Rebuild`;
  if (a.embedIndexError) t += ` · ⚠ ${a.embedIndexError}`;
  else if (a.embedIndexedAt) t += ` · memory index ready (${ago(a.embedIndexedAt)})`;
  return t;
}

/** Which engine does the agent's semantic memory search. Applies on its next rebuild, which re-indexes. */
async function saveEmbedMode() {
  const mode = $('editEmbedMode').value;
  const f = sheetSave('editEmbedMode');
  try {
    await api(`/v1/agents/${f.id}`, { method: 'PATCH', body: { embedMode: mode } });
    f.saved();
    f.say(mode === 'shared' ? 'Will use the shared service from its next rebuild — memory search re-indexes then (a few minutes).' : 'Back on its own engine from its next rebuild.');
    await refresh(false);
  } catch (e) { f.fail(e); }
}

/** Pin (or clear) the runtime image AND rebuild onto it now, the way `hatchabot image try` does — a pin that
 *  waited for "the next rebuild" looked as if it had taken effect while the agent still ran the old image
 *  (Chris, 2026-09-24). A stopped agent picks it up when it starts. Empty input = back to the fleet default. */
async function saveImagePin() {
  const v = $('editImage').value.trim();
  // The agent pinned is the one rebuilt, even when another agent's sheet opened meanwhile (audit #047).
  const f = sheetSave('editImage');
  // Only a choice from this agent's own list, loaded (populateImagePicker): not another's pin left in it.
  const pick = $('editImage').dataset;
  if (pick.loading || (pick.agent && pick.agent !== String(f.id))) { f.fail(new Error('Its list of images is still loading — choose again once it has.')); return; }
  const a = agents.find(x => x.id === f.id);
  try {
    const r = await api(`/v1/agents/${f.id}`, { method: 'PATCH', body: { image: v || null } });
    f.saved();
    // Whether it runs now is the save's answer, the agent as the server has it: the page's is a poll old, and one it
    // saw asleep that woke since was told "when it next starts" and stayed on the old image (HB-1143).
    const now = r?.state ? r : a;
    if (r.sameImage) f.say(v ? `Pinned to ${v} — it already runs that image, so no rebuild.` : 'Back on the fleet default — it already runs that image, so no rebuild.');
    else if (now?.state === 'RUNNING' && now.runtimeRef) {
      if (!confirmRebuild(f.id, v ? `Moving onto ${v}` : 'Returning to the fleet default image', now)) { f.say('Pinned — it moves onto that image at its next rebuild.', 6000); await refresh(false); return; }
      // That read is the page's last poll, and the question above takes as long as it takes: stopped by now, it stays so.
      const r2 = await api(`/v1/agents/${f.id}/rebuild`, { method: 'POST', body: { stoppedWaits: true } });
      if (r2?.atNextStart) f.say(v ? `Pinned to ${v} — it moves onto it when it next starts.` : 'Back on the fleet default image — it moves onto it when it next starts.');
      else f.say(v ? `Pinned to ${v} — rebuilding onto it now, memory kept (about a minute).` : 'Back on the fleet default — rebuilding, memory kept.');
    } else {
      // It stays down; Start or a wake is the rebuild (HB-0441).
      f.say(v ? `Pinned to ${v} — it moves onto it when it next starts.` : 'Back on the fleet default image — it moves onto it when it next starts.');
    }
    await refresh(false);
  } catch (e) { f.fail(e); }
}

/** The agent's own sleep and file policy (Advanced tab): saved and applied at once. */
async function v2SetAgentPolicy(id, body) {
  try { const r = await api(`/v1/agents/${id}`, { method: 'PATCH', body }); r?.filesCapPending ? toast(r.filesCapPending, 8000) : toast('Saved.'); await refresh(false); }
  catch (e) { toast(e.message, 6000); await refresh(false); }
}

/** Download the agent's chat history, every conversation in its transcripts, as one markdown file. */
async function downloadHistory(id, name) {
  toast(`Reading "${name}"'s chat history…`, 5000);
  try {
    // Raw fetch (not api()): the body is a markdown file, not JSON. Same-origin,
    // so the session cookie authenticates it.
    const r = await fetch(`/v1/agents/${id}/transcript`, { credentials: 'same-origin' });
    if (!r.ok) { let e = ''; try { e = (await r.json()).error; } catch {} throw new Error(e || `HTTP ${r.status}`); }
    const blob = await r.blob();
    const file = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'chat-history.md';
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: file });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const n = r.headers.get('x-hatchabot-messages'), c = r.headers.get('x-hatchabot-conversations');
    toast(`Downloaded ${file} — ${n} messages across ${c} conversation${c === '1' ? '' : 's'}.`, 7000);
  } catch (e) { toast(`Couldn't download the history: ${e.message}`, 9000); }
}
/**
 * A long operation held for the owner's choice (operations.ts): a move
 * interrupted by a restart while the other machine was away, a move to
 * another Hatchabot that server has not confirmed. Its choices, as buttons.
 * Start, Rebuild and the rest refuse until one is made. One under way is
 * the Working on line instead (v2OpLine, below).
 */
function opNotice(a) {
  const op = a.operation;
  if (!op || op.status !== 'held' || !v2Mine(a)) return '';
  const acts = op.recovery?.actions || [];
  const step = op.stepLabel ? ` Last step done: ${esc(op.stepLabel)}${op.stepN ? ` (${op.stepN} of ${op.steps})` : ''}.` : '';
  return `<div class="pair oprecover" style="align-items:flex-start">⏸ <span class="grow"><b>${esc(op.kindLabel || 'An operation')} is waiting for your choice.</b>${step} <span class="sub">${esc(ago(op.updatedAt))}</span></span>
    ${acts.map((x) => `<button class="${x.action === op.recovery?.recommended ? 'primary' : ''}" data-op-action="${esc(x.action)}" ${onAction('click', 'recoverOp', [`${op.id ?? ''}`, `${x.action ?? ''}`, { $: 'el' }])}>${esc(x.label)}</button>`).join('')}</div>`;
}
async function recoverOp(opId, action, btn) {
  if (btn) btn.disabled = true;
  try {
    const r = await api(`/v1/operations/${encodeURIComponent(opId)}/recover`, { method: 'POST', body: { action } });
    toast(r.operation?.outcome || 'Done.', 6000);
    // A choice that starts the work again ("Try again") is followed like any other.
    if (r.operation && V2_OP_GOING.has(r.operation.status)) v2FollowOp(r.operation);
  } catch (e) { toast(e.message, 8000); if (btn) btn.disabled = false; }
  await refresh(false);
}

// ---- long operations the page follows (operations.ts, phase 3) -----------------
// A move, an import, a restore answers 202 { operation } and goes on on the
// server. The page follows each one that is under way on an agent you own —
// started here, from the CLI or by the Hatchabot agent — reading GET
// /v1/operations/:id every 2 s: the tile's ring and the sheet's Working on
// line say "Moving to Laptop runner — step 4 of 10, … · 2 min", and a toast
// says how it ended.
const V2_OP_GOING = new Set(['queued', 'running', 'interrupted']);
/** How long, as people say it: "40 s", "3 min", "2 h 5 min". */
function opSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${Math.max(s, 1)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${Math.round(h / 24)} days`;
}
/** The Working on words: "Moving to Laptop runner — step 4 of 10, made on the other machine · 2 min". */
function v2OpLine(op) {
  if (!op) return '';
  const what = op.title || op.kindLabel || 'Working on it';
  const where = op.stepN ? ` — step ${op.stepN} of ${op.steps}, ${op.stepLabel || op.step}`
    : op.status === 'interrupted' ? ' — interrupted by a restart, being put right'
    : op.status === 'queued' ? ' — waiting its turn' : op.steps ? ` — starting (${op.steps} steps)` : '';
  return what + where + (op.requestedAt ? ` · ${opSpan(Date.now() - Date.parse(op.requestedAt))}` : '');
}
/** Under way on an agent of yours: what its tile and sheet say instead of "Working on it". */
const v2OpGoing = (a) => !!(a?.operation && V2_OP_GOING.has(a.operation.status) && v2Mine(a));
const v2Ops = new Map(); // op id → agent id
const v2OpEnds = new Map(); // op id → what the page that started it does when it ends
let v2OpTimer = null;
const v2OpSchedule = () => { if (v2Ops.size && !v2OpTimer && !window.__noAutoPoll) v2OpTimer = setTimeout(v2OpTick, 2000); };
/** Follow an operation this page has just started (the 202's `operation`); `onEnd` runs once when it has ended, however it ended. */
function v2FollowOp(op, onEnd) {
  if (!op?.id) return;
  v2Ops.set(op.id, op.agentId || null);
  if (onEnd) v2OpEnds.set(op.id, onEnd);
  const a = op.agentId && v2Find(op.agentId);
  if (a && V2_OP_GOING.has(op.status)) { a.operation = op; renderV2(); }
  v2OpSchedule();
}
/** After each list: follow whatever is under way on your agents (started anywhere). */
function v2WatchOps() {
  for (const a of agents) if (v2OpGoing(a) && a.operation.id && !v2Ops.has(a.operation.id)) v2Ops.set(a.operation.id, a.id);
  v2OpSchedule();
}
/** How it ended, for the toast. */
function v2OpOutcome(op) {
  const who = v2Find(op.agentId)?.name;
  const said = op.outcome || op.summary || op.status;
  const lead = op.status === 'succeeded' ? '✅' : op.status === 'held' ? '⏸' : '⚠';
  return `${lead} ${who ? `${who}: ` : ''}${said}${op.status === 'held' ? ' — choose what to do on its page (Alerts).' : ''}`;
}
/** The end hook v2FollowOp was given, run once; its failure is the page's, not the operation's. */
function v2OpEnded(id) {
  const end = v2OpEnds.get(id); v2OpEnds.delete(id);
  if (end) void Promise.resolve().then(end).catch(() => {});
}
/** One round: each followed operation read once; the ones that ended say so. */
async function v2OpTick() {
  clearTimeout(v2OpTimer); v2OpTimer = null;
  let ended = false;
  for (const [id, agentId] of [...v2Ops]) {
    let op;
    try { op = await api(`/v1/operations/${encodeURIComponent(id)}`); }
    // Gone, or no longer ours (404/403): it ended as far as this page can know.
    // Any other failure (the network, a 5xx, a laptop waking) is asked again on
    // the next round: taken as an end, a revert reloaded its editor before the
    // restore had written anything (regression audit, 2026-10-22).
    catch (e) { if (e?.status === 404 || e?.status === 403) { v2Ops.delete(id); v2OpEnded(id); } continue; }
    const a = v2Find(op.agentId || agentId);
    if (V2_OP_GOING.has(op.status)) { if (a) a.operation = op; continue; }
    v2Ops.delete(id); ended = true;
    if (a && a.operation?.id === id) a.operation = op.status === 'held' ? op : undefined;
    toast(v2OpOutcome(op), op.status === 'succeeded' ? 9000 : 20000);
    v2OpEnded(id);
  }
  renderV2();
  if (ended) { void v2LoadActivity(true); await refresh(false); }
  v2OpSchedule();
}

async function dismissContextReset(id) {
  try { await api(`/v1/agents/${id}/context-reset`, { method: 'DELETE' }); await refresh(false); }
  catch (e) { toast(e.message); }
}

async function recoverContext(id, name) {
  // One question with a real Cancel: a second confirm() made Cancel mean "earlier ones only", so Esc still started it (review, 2026-10-09).
  const pick = await askChoice(`Recover "${name}"'s earlier conversations?`,
    "Conversations from before a reset get written into its workspace, and the agent reads them and saves the important parts to memory. Runs in the background (a few minutes, uses tokens); it confirms in its chat when done.\n\nInclude the current conversation too if you just switched this agent's AI source: its current chat is about to be reset on the next message.",
    [['live', 'Also the current one'], ['earlier', 'Earlier ones only']]);
  if (!pick) return;
  try {
    const includeLive = pick === 'live';
    const r = await api(`/v1/agents/${id}/recover-context`, { method: 'POST', body: { includeLive } });
    if (!r.started) { toast(r.reason || 'Nothing to recover.', 9000); return; }
    toast(`Recovering ${r.messages} messages from ${r.conversations} earlier conversation${r.conversations > 1 ? 's' : ''} — "${name}" will confirm in its chat when it's saved them.`, 10000);
  } catch (e) { toast(e.message, 9000); }
}
/**
 * On-demand memory checkpoint: the agent summarises the current conversation
 * into MEMORY.md now. The manual form of the pre-switch checkpoint — for before
 * an archive, before /new, or any reset you see coming. Resets nothing.
 */
async function checkpointAgent(id, name) {
  toast(`Saving "${name}"'s conversation to memory… (~20s)`, 6000);
  try {
    const r = await api(`/v1/agents/${id}/checkpoint`, { method: 'POST' });
    if (r.saved) toast(`Saved "${name}"'s conversation to memory — the agent also confirms in its chat.`);
    else if (r.ok) toast(`"${name}": ${r.note || 'It found nothing new to save.'}`, 9000); // the turn ran; its memory files did not change
    else toast(r.error || `Couldn't save "${name}" to memory — its AI source didn't respond (out of credits?).`, 12000);
  } catch (e) { toast(e.message); }
}

/**
 * True while an operation that RE-CHECKS an agent's rebuild-fixable statuses is
 * in flight (a rebuild marks the agent busy from the moment it's triggered; the
 * git sync / applied-model snapshot that clear those statuses run near its END).
 * While true we hide those statuses rather than show stale ones — the server
 * re-evaluates them, so anything still wrong reappears once it finishes.
 */
function isRechecking(a) {
  return !!a.busy || a.state === 'REBUILDING' || a.state === 'PROVISIONING';
}
/** How many rebuild-fixable issues are currently hidden by isRechecking(). */
function recheckHiddenCount(a) {
  return (a.rebuild ? 1 : 0) + (a.pendingModel && a.pendingModel !== a.model ? 1 : 0)
    + (a.peersPending ? 1 : 0) + (a.dataSources || []).filter(d => d.syncError).length;
}
function recheckNote(a) {
  const n = isRechecking(a) ? recheckHiddenCount(a) : 0;
  return n ? `<div class="pair">🛠 <span class="grow sub">Working on it — ${n} issue${n > 1 ? 's' : ''} will be re-checked when this finishes; anything still wrong reappears here.</span></div>` : '';
}

// "Clear from Alerts": what is flagged, as a stable fingerprint (kinds, not
// counts that tick — more cap hits do not re-flag; a NEW restart or a new
// rebuild reason does). Stored on the agent, so every device agrees. A key that
// names a kind only (failed, pending, opsDrift...) leaves the stored Clear on the
// server when that thing ends, so the next one shows (Store.dropAttentionAckKeys).
function attentionFingerprint(a) {
  // A Check all finding is this page's alone (gone on a reload): kept out, or a
  // Clear made with one on screen would come back after every reload.
  const keys = [a.state === 'FAILED' ? 'state:FAILED' : '', a.opsDrift ? 'opsDrift' : '', ...agentAttention(a).filter(x => !x.health).map(x => x.key)].filter(Boolean);
  return keys.length ? keys.sort().join('\n') : '';
}
/** True when the owner cleared exactly what is flagged now (nothing new since). A fresh Check all finding shows regardless. */
function attentionCleared(a) {
  return !!a.attentionAck && a.attentionAck === attentionFingerprint(a) && !v2HealthBad(a);
}

// ---- Check all: a health check on every running agent (2026-10-09, from the classic Health panel) ----
// GET /v1/agents/:id/health?doctor=1 for each, one at a time (an exec into
// each container: gentle). What it finds is an alert on the agent's tile and
// under View by → Alerts, and a line above the agents says how it went. The
// results live in this page until the next check, Clear, or a reload.
let v2Health = {}, v2CheckRun = null, v2CheckLast = null;
const v2HealthBad = (a) => !!v2Health[a.id]?.problems?.length;
/**
 * Whether an answering agent's settings check said something to believe:
 * findings, or a complete clean run. A missing or incomplete one is not
 * "clean" (HB-1047); it is not a problem with the agent either, so it is
 * said on its own, not as an alert.
 */
function v2LintRead(h) {
  if (h.error || !h.reachable) return true; // nothing to say about its settings: the check itself did not get that far
  return !!h.doctor && (h.doctor.findings?.length > 0 || h.doctor.complete === true);
}
/** What a health answer says is wrong, in words; [] when it is fine. */
function v2HealthProblems(h) {
  if (h.error) return [`the check could not run (${h.error})`];
  if (!h.reachable) return ["it didn't answer — Rebuild it if this keeps happening"];
  const out = [];
  if (h.aiSource?.refusingSince) out.push(`its AI source has been ${h.aiSource.refusal === 'refused' ? 'refusing (rate-limited)' : 'failing'} since ${ago(h.aiSource.refusingSince)}`);
  // "Slow" only when the event loop says so, or nothing else explains the
  // degraded state: a chat app that is not connected degrades it too, and was
  // listed as slow (regression audit, 2026-10-22).
  const otherCause = (h.telegram && h.telegram.connected === false) || (h.disconnected || []).length > 0 || (h.pluginErrors || []).length > 0;
  if (h.status === 'degraded' && (h.eventLoop?.degraded || !otherCause)) out.push(`it is slow to respond${h.eventLoop?.reasons?.length ? ` (${h.eventLoop.reasons.join(', ')})` : ''}`);
  if (h.telegram && h.telegram.connected === false) out.push(`Telegram is not connected${h.telegram.lastError ? ` (${h.telegram.lastError})` : ''}`);
  for (const k of h.disconnected || []) out.push(`${k === 'slack' ? 'Slack' : 'Discord'} is not connected`);
  if (h.pluginErrors?.length) out.push(`plugin errors: ${h.pluginErrors.slice(0, 3).join(', ')}`);
  const f = h.doctor?.findings ?? [], n = f.length + (h.doctor?.omittedCount || 0);
  if (f.length) out.push(`${n} setting${n > 1 ? 's' : ''} to fix: ${f.slice(0, 2).map(x => x.message).join('; ')}${n > 2 ? '; …' : ''}`);
  return out;
}
async function v2CheckAll() {
  if (v2CheckRun) { toast('Already checking — the line above your agents shows how far it is.'); return; }
  const mine = liveAgents().filter(v2Mine);
  const run = mine.filter(a => a.state === 'RUNNING');
  if (!run.length) { toast('None of your agents is running, so there is nothing to check.'); return; }
  v2CheckRun = { done: 0, total: run.length, skipped: mine.length - run.length, stop: false, ids: [] };
  v2PaintCheckAll();
  for (const a of run) {
    if (v2CheckRun.stop) break;
    let h;
    try { h = await api(`/v1/agents/${a.id}/health?doctor=1`); } catch (e) { h = { error: e.message }; }
    v2Health[a.id] = { at: Date.now(), problems: v2HealthProblems(h || {}), lintUnread: !v2LintRead(h || {}) };
    v2CheckRun.done++; v2CheckRun.ids.push(a.id);
    v2PaintCheckAll(); renderV2();
  }
  const r = v2CheckRun;
  v2CheckRun = null;
  v2CheckLast = { at: new Date().toISOString(), ids: r.ids, skipped: r.skipped + (r.total - r.done), stopped: r.stop };
  v2PaintCheckAll(); renderV2();
}
function v2StopCheck() { if (v2CheckRun) v2CheckRun.stop = true; }
function v2ClearChecks() {
  if (v2CheckRun) v2CheckRun.stop = true;
  v2Health = {}; v2CheckLast = null;
  v2PaintCheckAll(); renderV2();
}
/** The line above the agents: how far a check is, then what it found, with a way to each agent that needs a look. */
function v2PaintCheckAll() {
  const el = $('v2CheckAll'); if (!el) return;
  const run = v2CheckRun, last = v2CheckLast;
  if (run) {
    el.innerHTML = `<span>❤️ Checking your agents' health: ${run.done} of ${run.total}…</span><button type="button" ${onAction('click', 'v2StopCheck')}>Stop</button>`;
  } else if (last) {
    const bad = last.ids.map(v2Find).filter(a => a && v2HealthBad(a));
    const n = last.ids.length;
    // Settings never read are not "clean" (HB-1047).
    const unread = last.ids.filter(id => v2Health[id]?.lintUnread).length;
    const unreadWords = `${unread} agent${unread === 1 ? '\'s' : 's\''} settings could not be checked`;
    el.innerHTML = `<span>❤️ Health check, ${esc(clock(last.at))}: ${n} running agent${n === 1 ? '' : 's'} checked${last.stopped ? ' (stopped early)' : ''} — ${bad.length
      ? `<span class="warn">${bad.length} worth a look</span>${bad.length <= 4 ? ': ' + bad.map(a => `<button type="button" class="linkish" ${onAction('click', 'openV2Agent', [`${a.id ?? ''}`])}>${esc(a.name)}</button>`).join(', ') : ''}${unread ? ` · ${unreadWords}` : ''}`
      : unread ? `all answered, but ${unreadWords}` : 'all answered, and their settings are clean'}${last.skipped ? ` · ${last.skipped} not running, so not checked` : ''}.</span>
      ${bad.length ? '<button type="button" ' + onAction('click', 'v2SetView', ['attention']) + '>Show under Alerts</button>' : ''}
      <button type="button" ${onAction('click', 'v2CheckAll')}>Check again</button>
      <button type="button" ${onAction('click', 'v2ClearChecks')} aria-label="Clear the health check results" title="Clear the results">✕</button>`;
  } else el.innerHTML = '';
  el.hidden = !run && !last;
}
async function clearAttention(id, on = true) {
  const a = agents.find(x => x.id === id); if (!a) return;
  try {
    await api(`/v1/agents/${id}`, { method: 'PATCH', body: { attentionAck: on ? attentionFingerprint(a) : null } });
    a.attentionAck = on ? attentionFingerprint(a) : undefined;
    toast(on ? `${a.name} cleared from Alerts — it comes back if something new happens.` : `${a.name} is back under Alerts.`);
    await refresh(false);
  } catch (e) { toast(e.message); }
}
async function clearAttentionSection(key) {
  const list = (v2SectionsNow.find(s => s.key === key)?.items ?? []).map(({ a }) => a).filter(a => v2Mine(a) && attentionFingerprint(a) && !attentionCleared(a));
  if (!list.length) return toast('Nothing to clear here.');
  let n = 0;
  for (const a of list) {
    try { await api(`/v1/agents/${a.id}`, { method: 'PATCH', body: { attentionAck: attentionFingerprint(a) } }); a.attentionAck = attentionFingerprint(a); n++; } catch { /* next */ }
  }
  toast(`Cleared ${n} agent${n === 1 ? '' : 's'} from Alerts — they come back if something new happens.`);
  await refresh(false);
}
/**
 * Every status on an agent that wants the owner's attention, as {icon, why} —
 * one entry per KIND, in priority order. The single source for the tiles'
 * status, View by → Alerts and the Bulk "Alerts" filter, so a new warning only
 * has to be added here to surface everywhere.
 */
function agentAttention(a) {
  const out = [];
  // The reason is printed beside the status; the list only says there is one,
  // so a long explanation isn't repeated twice on the same screen.
  // A long operation held for the owner's choice (operations.ts), first of
  // all: the agent refuses Start and the rest until it is chosen. Keyed on its id.
  if (a.operation?.status === 'held' && v2Mine(a)) out.push({ key: 'op:' + a.operation.id, icon: '⏸', why: a.operation.outcome || `${a.operation.kindLabel || 'An operation'} is waiting for your choice` });
  if (a.state === 'FAILED') out.push({ key: 'failed', icon: '❗', why: a.stateReason ? 'it failed — the reason is beside its status' : 'it failed', failure: true });
  // Stopped, and nobody meant it to be: a move undone whose source did not start (HB-0416). Its next run clears it.
  if (a.state === 'STOPPED' && a.stateReason && v2Mine(a)) out.push({ key: 'not-started', icon: '⚠', why: a.stateReason });
  if (a.pendingAction) out.push({ key: 'pending', icon: '✋', why: a.pendingAction.type === 'bot_token' ? 'waiting for a Telegram bot token' : 'a step is waiting on you' });
  // No pool bot was free when it came back (or was cloned/imported): it went on web-only rather than wait.
  if (a.telegramSkipped) out.push({ key: 'nobot:' + a.telegramSkipped.at, icon: '📵', why: 'No Telegram bot was free — it is running in the web app; attach a bot later (its settings → Messaging → Telegram)' });
  const rechecking = isRechecking(a);
  const unsynced = rechecking ? [] : (a.dataSources || []).filter(d => d.syncError);
  if (unsynced.length) out.push({ key: 'unsynced:' + unsynced.map(d => d.mountName).join(','), icon: '⚠', why: unsynced.map(d => `${d.mountName} didn't sync — ${d.syncError}`).join('; ') });
  if (templateUnfilled(a)) out.push({ key: 'template', icon: '⚙', why: TEMPLATE_WHY });
  if (a.opsDrift) out.push({ key: 'opsDrift', icon: '🔒', why: `its safety settings were changed (${a.opsDrift}), so its access to Hatchabot is paused — Rebuild it to restore them` });
  if (a.migratedTo) out.push({ key: 'migrated', icon: '📦', why: `moved to ${a.migratedTo} — this is a leftover copy` });
  // A rate-limited source is ONE Recommended item for the source (v2.158.0), not a line on each of its agents; the tile still says so.
  if (a.imageTrial) out.push({ key: 'trial:' + a.image, icon: '🧪', why: `on trial image ${a.image} (Runtime → ✕ to discard)` });
  const rebuild = [];
  if (a.pendingModel && a.pendingModel !== a.model) rebuild.push(`switches to ${a.pendingModel} on rebuild`);
  if (a.rebuild) rebuild.push(...a.rebuild.reasons);
  if (a.peersPending) rebuild.push('peer changes need a rebuild');
  if (rebuild.length && !rechecking) out.push({ key: 'rebuild:' + rebuild.join('|'), icon: a.rebuild?.level === 'required' ? '⚠' : '🔄', why: rebuild.join('; ') });
  if (a.botNamePending) out.push({ key: 'botName', icon: '🏷', why: `Telegram rename to "${a.botNamePending.name}" pending (Telegram rate-limits renames)` });
  if (a.memoryCapHits || a.memoryKills) out.push({ key: 'memory', icon: '🧠', why: `${a.memoryKills ? `${a.memoryKills} of its processes ${a.memoryKills === 1 ? 'was' : 'were'} killed for memory` : `it hit its memory cap ${a.memoryCapHits}×`} (${a.memoryCapEffective ? capLabel(a.memoryCapEffective) : 'default cap'}) — raise it under Runtime → Memory cap, or ask it to run smaller jobs` });
  // Measured once a day by the security sweep (2026-09-30); keyed on the size
  // in whole GB so a cleared warning comes back only if it keeps growing.
  if (a.diskOver) out.push({ key: 'disk:' + Math.floor(a.diskOver.bytes / 1e9), icon: '💾', why: `it uses ${(a.diskOver.bytes / 1e9).toFixed(1)} GB of storage (the warning is at ${(a.diskOver.warnBytes / 1e9).toFixed(0)} GB) — ask it to clear old files, or look under Files` });
  // Recovery readiness: its newest usable backup is over 2 days old, or none
  // holds it, while the machine's newest set is fresh (the server's fold: a
  // late machine is the machine's alert, once). Keyed on that date.
  const recovery = v2Mine(a) && a.state !== 'ARCHIVED' ? v2RecoveryOf(a.id) : null;
  if (recovery?.alert) out.push({ key: recovery.alert.key, icon: '💾', why: recovery.alert.why });
  // A loop Hatchabot's watcher found (tokenWatch.ts): what repeats, since when, and the fix.
  if ((a.stuck || []).length) out.push({ key: 'stuck:' + a.stuck.map(x => x.id).sort().join(','), icon: '🔁', stuck: true, sev: 90, rec: 'loop:' + a.stuck[0].id,
    why: a.stuck.map(x => x.text + (x.fix ? `. Fix: ${x.fix}` : '')).join(' · ') });
  // Today's spike (v2.158.0: spikes reach Alerts). A loop on it speaks for it: the server leaves it off then.
  if (a.spike) out.push({ key: 'spike:' + a.spike.at, icon: '⚠', sev: 80, rec: 'spike:' + a.id,
    why: `it used ${fmtTokens(a.spike.tokens)} tokens in the last 24 hours${a.spike.usual >= 1e6 ? ` — about ${Math.round(a.spike.tokens / a.spike.usual)}× its usual day` : ''} (Usage → Recommended)` });
  // Budgets (budgets.ts): from 80%, and a pause; keyed on the month, level and
  // amount, so a cleared line comes back at 100% or with a new budget, and when a
  // class's move to another source ends its switch (HB-1477 review).
  // Only a budget at 100% (paused, moved, or over) is an Alert; 80% is a Recommended item (v2.158.0).
  // A pause of a month that is over, still owed its start (HB-1011): no Recommended item, since nothing is left to raise.
  if (a.budget?.line && a.budget.paused?.ended) out.push({ key: `budget-owed:${a.budget.paused.ended.month}`, icon: '⏸', sev: 85, why: a.budget.line });
  // A switch to a cheaper model of a month that is over, its own model not back yet (HB-1496): nothing to raise either.
  else if (a.budget?.line && a.budget.downgraded?.ended) out.push({ key: `budget-switch-owed:${a.budget.downgraded.ended.month}`, icon: '💵', sev: 85, why: a.budget.line });
  else if (a.budget?.line && (a.budget.level === 100 || a.budget.paused || a.budget.downgraded)) out.push({ key: `budget:${a.budget.month}:${a.budget.level}:${a.budget.usd}${a.budget.paused ? ':p' : ''}${a.budget.classMovedSource ? ':class-' + a.budget.classMovedSource : ''}`, icon: a.budget.paused ? '⏸' : '💵', sev: 85, rec: 'budget:' + a.id, why: a.budget.line + ' (Usage → Recommended)' });
  // It can still reach something it should not (access overview: Sharing → Access).
  if (a.accessAlert?.line) out.push({ key: a.accessAlert.key, icon: '🔑', why: a.accessAlert.line });
  // "Tell me every $X" steps are the information the owner asked for: their message, the tooltip and Usage say them, not Alerts (v2.158.0).
  if (a.budgetPaused && !a.budget?.paused) out.push({ key: 'mbudget-pause:' + a.budgetPaused.at, icon: '⏸', sev: 85, why: a.budgetPaused.ended && a.budgetPaused.line ? a.budgetPaused.line : a.budgetPaused.staysStopped ? "this Hatchabot's monthly budget is used up, and it was stopped by hand: it stays stopped until you start it" : "paused by this Hatchabot's monthly budget — it starts again on the 1st, when the machine's budget is raised, or when you start it" });
  // Moved to a cheaper model by this Hatchabot's budget, until the 1st (HB-1422). Only the machine's owner can raise that budget.
  // On its class's own model (the cheaper one), there is nothing to switch back to: only that it is over (HB-1477 review).
  // One of a month that is over, its own model not back yet, says so (HB-1496).
  if (a.budgetCheaper?.ended && a.budgetCheaper.line) out.push({ key: `mbudget-cheaper-owed:${a.budgetCheaper.ended.month}:${a.budgetCheaper.to}`, icon: '💵', sev: 85, why: a.budgetCheaper.line });
  else if (a.budgetCheaper?.classModel) out.push({ key: `mbudget-cheaper:class:${a.budgetCheaper.to}`, icon: '💵', sev: 85,
    why: `On ${String(a.budgetCheaper.to).replace(/^.*\//, '')}, its class's model: this Hatchabot is over its monthly budget` });
  else if (a.budgetCheaper) out.push({ key: `mbudget-cheaper:${a.budgetCheaper.until}:${a.budgetCheaper.to}`, icon: '💵', sev: 85,
    why: `On ${String(a.budgetCheaper.to).replace(/^.*\//, '')} until ${a.budgetCheaper.until}: this Hatchabot's monthly budget moved it — ${myAccount?.hostOwner ? 'raise that budget to switch back now' : "ask the machine's owner"}` });
  if (a.machineBudget?.line && a.machineBudget.level === 100) out.push({ key: `mbudget:${a.machineBudget.month}:${a.machineBudget.level}:${a.machineBudget.usd}`, icon: '💵', sev: 85, rec: 'budget:machine', why: 'This Hatchabot (every agent): ' + a.machineBudget.line.replace(/^Over /, 'over ').replace(/^Used /, 'used ') + ' (Usage → Recommended)' });
  if (a.ops && v2Mine(a)) out.push(...v2MachineAlerts());
  if (a.selfRestarts) out.push({ key: 'restart:' + a.selfRestarts, icon: '↻', why: `its process quit and was started again ${a.selfRestarts === 1 ? 'once' : `${a.selfRestarts} times`} since the last rebuild — the Setup log has when and the exit code; Resources shows its memory against the cap` });
  // Check all (this page's own finding; kept out of the Clear fingerprint).
  if (v2HealthBad(a)) out.push({ key: 'health', icon: '❤️', health: true, why: `Health check: ${v2Health[a.id].problems.join('; ')} (Overview → Check health has the detail)` });
  // By severity — what blocks it, then money burning now — not by where the check sits above (v2.158.0); equal ones keep that order.
  return out.map((x, i) => [x, i]).sort(([x, i], [y, j]) => (y.sev ?? V2_ATTN_SEV[y.key.split(':')[0]] ?? 40) - (x.sev ?? V2_ATTN_SEV[x.key.split(':')[0]] ?? 40) || i - j).map(([x]) => x);
}
/** Alerts severity by key: an operation waiting for a choice and a failure first, then a loop, a budget at 100% and a spike (their own sev), then the rest. */
const V2_ATTN_SEV = { op: 100, failed: 95, 'not-started': 90, pending: 70, opsDrift: 65, nobot: 50, unsynced: 50, template: 45, migrated: 45, rebuild: 42 };
