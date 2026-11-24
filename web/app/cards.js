// web/app/cards.js: the cards your Hatchabot agent files (its proposals), and refresh() with its polling.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- the cards your Hatchabot agent files ----------------------------------
// It can only propose; each change arrives here with its full content and
// executes on Confirm, with the auth of whoever pressed it.






/** A confirmation card: summary + the FULL spec (expandable) + Confirm/Cancel.
 *  Built with createElement/textContent — file bodies never touch innerHTML. */
function mgmtProposalCard(p, into) {
  const log = into;
  const card = document.createElement('div');
  card.style.cssText = 'align-self:stretch;border:1px solid var(--warn);border-radius:10px;padding:10px 12px;font-size:14px';
  // Who prepared it and how much care it deserves — then Hatchabot's own
  // description of the change. The agent's reason comes last, marked as its words.
  if (p.source === 'agent' || p.source === 'guard' || (p.risk && p.risk !== 'routine')) {
    const meta = document.createElement('div');
    meta.className = 'prop-meta';
    const risk = { disruptive: ['Restarts or interrupts something', 'warn'], careful: ['Read carefully', 'bad'] }[p.risk];
    if (risk) { const b = document.createElement('span'); b.className = `v2pill ${risk[1]}`; b.textContent = risk[0]; meta.appendChild(b); }
    if (p.source === 'agent') { const w = document.createElement('span'); w.textContent = 'Prepared by your Hatchabot agent'; meta.appendChild(w); }
    if (p.source === 'guard') { const w = document.createElement('span'); w.textContent = "Prepared by Hatchabot's quality guard"; meta.appendChild(w); }
    card.appendChild(meta);
  }
  const head = document.createElement('div');
  head.style.cssText = 'white-space:pre-wrap;font-family:inherit';
  // A model change carries the scorecard's evidence and a downgrade's risks
  // (Right-size): the headline, then the evidence, then each risk, marked.
  head.textContent = p.check ? String(p.summary).split('\n')[0] : p.summary;
  card.appendChild(head);
  if (p.check) {
    if (p.check.evidence) {
      const ev = document.createElement('div');
      ev.className = 'sub prop-evidence';
      ev.style.cssText = 'margin-top:4px;white-space:pre-wrap';
      ev.textContent = p.check.evidence;
      card.appendChild(ev);
    }
    if (Array.isArray(p.check.warnings) && p.check.warnings.length) {
      const box = document.createElement('div');
      box.className = 'prop-risks';
      box.style.cssText = 'margin-top:6px;padding:6px 10px;border-radius:8px;background:color-mix(in srgb, var(--warn) 12%, transparent)';
      for (const w of p.check.warnings) {
        const line = document.createElement('div');
        line.textContent = `⚠ ${w}`;
        box.appendChild(line);
      }
      card.appendChild(box);
    }
  }
  if (p.note) {
    const note = document.createElement('div');
    note.className = 'prop-note';
    note.textContent = `Its reason: “${p.note}”`;
    card.appendChild(note);
  }
  // Where to see (or double-check) the thing this card changes.
  const place = mgmtCardPlace(p);
  if (place) {
    const a = document.createElement('a');
    a.href = '#'; a.className = 'mgmt-open'; a.textContent = `${place.label} →`;
    a.addEventListener('click', (e) => { e.preventDefault(); place.go(); });
    card.appendChild(a);
  }
  const full = [['Persona', p.spec?.persona], ['SOUL.md', p.spec?.soul], ['AGENTS.md', p.spec?.agentsMd], ['Dockerfile lines', p.spec?.dockerfile]]
    .filter(([, t]) => typeof t === 'string' && t.length);
  for (const [label, text] of full) {
    const det = document.createElement('details');
    const sum = document.createElement('summary');
    sum.style.cssText = 'cursor:pointer;margin-top:8px';
    sum.textContent = `📄 ${label} — full content (${text.split('\n').length} lines)`;
    const pre = document.createElement('pre');
    pre.style.cssText = 'max-height:260px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;word-break:break-word;margin:6px 0 0';
    pre.textContent = text;
    det.appendChild(sum); det.appendChild(pre); card.appendChild(det);
  }
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:10px';
  const done = (text, ok) => {
    card.style.borderColor = ok ? 'var(--ok)' : 'var(--line)';
    row.remove();
    const res = document.createElement('div');
    res.style.cssText = 'margin-top:8px;white-space:pre-wrap';
    res.textContent = text;
    card.appendChild(res);
  };
  const act = async (verb) => {
    for (const b of row.querySelectorAll('button')) b.disabled = true;
    try {
      const r = await api(`/v1/proposals/${encodeURIComponent(p.confirmId)}/${verb}`, { method: 'POST', body: {} });
      done(r.text, verb === 'confirm');
      setTimeout(loadProposals, 2500); void refresh(false);
    } catch (e) { done(`⚠ ${e.message}`, false); }
  };
  const cancel = document.createElement('button');
  cancel.textContent = '✖ Cancel';
  cancel.addEventListener('click', () => act('cancel'));
  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = '✅ Confirm';
  ok.addEventListener('click', () => act('confirm'));
  row.appendChild(cancel); row.appendChild(ok); card.appendChild(row);
  log.appendChild(card);
  log.scrollTop = log.scrollHeight;
}

/** The panel a proposal card is about, for its "Open …" link (v2). */
function mgmtCardPlace(p) {
  const t = p.tool || '';
  if (/^(build_base_candidate|delete_base_image)$/.test(t)) return { label: 'Open Images', go: () => openAiDlg('images') };
  if (/^(build_image|rebuild_image|remove_image)$/.test(t)) return { label: 'Open Images', go: () => openAiDlg('images') };
  if (!p.agentId) return null;
  const tab = /cron/.test(t) ? 'schedule'
    : /peers/.test(t) ? 'sharing'
    : /telegram|invite|member/.test(t) ? 'messaging'
    : /source|model|class/.test(t) ? 'ai'
    : /definition|snapshot|checkpoint/.test(t) ? 'personality'
    : /image|base_candidate|base_trial/.test(t) ? 'advanced'
    : 'overview';
  // The chat can load before the agent list does; the link still works.
  return { label: `Open ${v2Find(p.agentId)?.name ?? 'this agent'}`, go: () => openV2Agent(p.agentId, tab) };
}




let pollTimer, pairTick = 0, pollPaused = false;
// Refreshes overlap (a poll, and one after a change): an older answer that
// lands last would put back what the newer one no longer has, a deleted agent
// among it (review, 2026-10-09). Only the newest answer is used; an older call
// waits for the newer one, so whoever awaited it still sees fresh agents.
let refreshSeq = 0, refreshLatest = Promise.resolve();
// The sources and machines, and the pairing knocks, are read on some passes
// only, and the agent-list check above did not cover them: an older pass's
// answer landing after a newer one's put back what it no longer had (#228).
// Each has its own generation; the newest read of it is the one kept, and an
// older pass's read is still kept when no newer pass read it at all.
let metaSeq = 0, pairSeq = 0;
/**
 * A knock let in or turned away here leaves the page at once: the read after it can fail, and a failed read keeps the
 * knocks the last one found, so the handled one stayed with its buttons (HB-1142). A read begun before it does not
 * put it back. `code` of `kind` on agent `id`; with no agent, every knock (the last person's, on a change of person).
 */
function pairingsDrop(id, code, kind) {
  pairSeq++;
  if (id === undefined) { pairings = {}; return; }
  const left = (pairings[id] ?? []).filter(p => !(p.code === code && (p.kind || 'telegram') === kind));
  if (left.length) pairings[id] = left; else delete pairings[id];
}
function refresh(withMeta) {
  const seq = ++refreshSeq;
  return (refreshLatest = refreshNow(withMeta, seq));
}
async function refreshNow(withMeta, seq) {
  void refreshInboxBadge(); // keep the inbox count live without opening it
  try {
    const metaPass = withMeta || !profiles.length || !hosts.length;
    if (metaPass) {
      const metaMine = ++metaSeq;
      const meta = await Promise.all([api('/v1/ai-profiles'), api('/v1/hosts')]);
      if (metaMine === metaSeq) [profiles, hosts] = meta;
    }
    // The pool count is refreshed on EVERY poll, not just a withMeta one: it
    // changes from plenty of places that don't go through this tab — deleting
    // an agent parks its bot back, creating one leases a bot, and the CLI, the
    // Hatchabot agent, or another account can move stock at any time. It's a
    // COUNT plus a tiny roster, so the cost is noise next to /v1/agents. Discord's and Slack's parked bots are read
    // where they are shown (Settings → Messaging): the poll read both and nothing used them (HB-1141).
    api('/v1/pool').then(p => { poolAvail = p.availableBots; }).catch(() => {});
    // Who the session is, read with the list: another window signed in as someone else, and this one, in view all along,
    // had no visibility change and no meta pass to notice, so it showed the last person's account and settings over the
    // next one's agents (HB-0954). A meta pass reads it in full (loadMyAccount: email and linked Telegram, for the "That's
    // me" button and Settings → You), and the list waits for it: it was drawn first, as the last person's. The others
    // read who it is (a cheap read), and someone else's page is theirs first (loadMyAccount), then the list.
    const [list, who] = await Promise.all([api('/v1/agents'), metaPass ? loadMyAccount().then(() => null) : api('/v1/account').catch(() => null)]);
    if (seq !== refreshSeq) { await refreshLatest; return; } // a newer refresh has it, and polls on
    if (who?.ownerId && (who.ownerId !== pagePerson || pagePersonAway) && !loginDlg.open) {
      await loadMyAccount();
      if (seq !== refreshSeq) { await refreshLatest; return; }
      // Their own read failed: the list is someone else's and the page is still the last person's. What is drawn stays,
      // and the next poll asks again.
      if (pagePerson !== who.ownerId || pagePersonAway) throw new Error('Could not read who is signed in; the list waits for the next poll.');
    }
    agents = list;
    markArchiving(agents); // an archive this page started, before the server's list shows it
    agentsLoaded = true;
    retireMadeTodos(); // a planned agent that now exists leaves Planned
    v2WatchOps(); // a move, import or restore under way: followed every 2 s, its end said in a toast
    if ($('consoleDlg')?.open && !consoleGuest) renderConsoleTabs(); // the new-reply dots
    if (location.hash.includes('report=')) reportFromHash();
    if (location.hash.includes('console=') && !consoleHashTried) { consoleHashTried = true; consoleFromHash(); }
    void v2LoadRecent(); // each agent's last line, for its tooltip (at most every 30 s)
    void v2LoadCosts(); // the cost badges (at most every 5 minutes)
    $('offlineBanner').hidden = true; // reached the server: any earlier warning is stale
    // Activity, at the foot of the home screen, with the machine line.
    void v2LoadActivity(); void v2LoadMachine();
    void v2LoadReadinessPaint(); // each agent's recovery readiness (its Alerts), at most once a minute
    // Presence strip: cheap single-row read, but 30s staleness is fine —
    // refresh it on the meta pass and every 4th poll.
    if (withMeta || mgmtTick++ % 4 === 0) { void loadSourceUsage(); void loadProposals(); void loadBackupAge(); loadFleetKeys(); void loadSecurityNotices(); }
    // Tailscale set-up is the private address's business (the public one refuses it).
    if (withMeta && tailnet === null && !appConfig.publicAddress) void loadTailnet();
    // Pairing checks hit docker exec — do them on a slower cadence. Every knock on this account's running agents
    // in one read (/v1/pending: the server's half-minute cache, six agents at a time), kept by agent as the per-agent
    // read gave them. The page read each agent's at once, beside the bounded read that was there (HB-1142).
    if (pairTick++ % 3 === 0) {
      // Only agents in a chat app can be knocked on: with none running, there is nothing to read.
      const pairMine = ++pairSeq;
      const all = agents.some(a => a.state === 'RUNNING' && v2ChannelKinds(a).length) ? await api('/v1/pending').catch(() => null) : [];
      if (pairMine === pairSeq && Array.isArray(all)) { // a failed read keeps the knocks the last one found
        pairings = {};
        for (const p of all) {
          (pairings[p.agentId] ??= []).push({ kind: p.kind, code: p.code, id: p.channelUserId ?? p.telegramId,
            meta: { username: p.username, firstName: p.firstName, lastName: p.lastName } });
        }
      }
      // Members are read when an agent's sheet opens (renderEditMembers).
    }
    renderSetup(); renderV2(); // renderV2 itself waits out a drag
  } catch (e) {
    console.error(e);
    // A failed refresh with a stale shell showing is silent and misleading (the
    // old cached page has no way to know it's old). Say it, name the usual cause.
    if (/fetch|network|Failed to fetch|Load failed/i.test(String(e.message || e))) $('offlineBanner').hidden = false;
    // The first list never arrived: say so where the spinner is, rather than
    // spin forever over a 500 or a proxy page (27th audit).
    if (!agentsLoaded) for (const el of document.querySelectorAll('.hb-loading')) el.textContent = `Couldn't load your agents: ${e.message || e}. Retrying…`;
  }
  const busy = agents.some(a => a.busy || a.archiving || v2OpGoing(a) || a.state === 'PROVISIONING' || a.state === 'REBUILDING' || a.state === 'DELETING');
  clearTimeout(pollTimer);
  // A tab nobody is looking at does not poll: it catches up the moment it is
  // shown again (below). Each poll costs the server about a second.
  pollPaused = document.hidden;
  // The click-through checks (scripts/ui-clickthrough.mjs) refresh by hand: a
  // timed poll landing mid-check made them flaky on a loaded machine.
  if (!pollPaused && !window.__noAutoPoll) pollTimer = setTimeout(() => refresh(false), busy ? 2500 : 8000);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && pollPaused) { pollPaused = false; void refresh(false); }
  // Another tab may have signed in as someone else meanwhile: read who it is now, not at the next meta refresh (HB-0491).
  if (!document.hidden && !loginDlg.open) void loadMyAccount().catch(() => {});
});
