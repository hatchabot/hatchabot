// web/app/moves.js: moving an agent to another machine of this server (a runner) or to another Hatchabot server, and the other servers it can go to (Settings → Advanced).
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

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

/**
 * A budget's switch to a cheaper model does not travel (HB-1299): the copy carries its owner's model, and no budget
 * holds it there. Said in a move's and a download's confirmation, as a paragraph; '' when no switch has it.
 */
function budgetSwitchLostOnExport(id) {
  const a = v2Find ? v2Find(id) : (agents || []).find(x => x.id === id);
  const sw = a?.budgetSwitch;
  if (!sw) return '';
  const bare = (m) => String(m).replace(/^.*\//, '');
  // The copy carries its owner's model, which the other machine runs only if its source there offers it (HB-1299 review).
  const runs = sw.own ? `your own model (${bare(sw.own)}) if the AI source there offers it, else its default,` : 'the default model of its AI source there';
  return `\n\n${sw.scope === 'machine' ? "This Hatchabot's budget" : 'Its budget'} had switched it to ${bare(sw.to)}; on the other machine it runs on ${runs} until you set a budget on that machine.`;
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
  if (!confirm(`Move "${name}" to the cluster at ${peer.name}?${channelsLostOnExport(id)}${budgetSwitchLostOnExport(id)}\n\nIt stops here, transfers with its memory and members, and starts there — managed from that server's dashboard from now on. This copy stays STOPPED (not deleted) — never start both, they would fight over the same Telegram bot.`)) return;
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
