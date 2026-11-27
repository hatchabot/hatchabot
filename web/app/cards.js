// web/app/cards.js: the cards your Hatchabot agent files (its proposals), the people knocking on your agents (renderV2Joins, approve, denyPair), and refresh() with its polling.
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
  // Filed again after a restart (HB-1053): its words, evidence and warnings
  // are its first filing's, and it says when that was.
  if (p.firstFiledAtMs) {
    const was = document.createElement('div');
    was.className = 'sub prop-refiled';
    was.style.cssText = 'margin-top:4px';
    was.textContent = `Filed again after a restart: first filed ${new Date(p.firstFiledAtMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}, so what it says is as of then.`;
    card.appendChild(was);
  }
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

/** Changes the assistant prepared, waiting for Confirm. Survives reloads and
 *  restarts; whatever prepared them (today the chat, later an agent). */
let v2PropSig = '';
async function loadProposals() {
  let r; try { r = await api('/v1/proposals'); } catch { return; }
  if (!Array.isArray(r?.pending)) r = { pending: [] }; // an older server mid-deploy
  // A change that failed when you confirmed it used to vanish with its card,
  // taking the reason with it (2026-09-19). Keep recent failures on screen.
  const failed = (Array.isArray(r.recent) ? r.recent : [])
    .filter(x => x.status === 'confirmed' && /^⚠/.test(String(x.outcome ?? '')))
    .filter(x => Date.now() - (x.resolvedAtMs ?? 0) < 60 * 60_000)
    .filter(x => !v2PropDismissed.has(x.confirmId))
    .slice(0, 3);
  // Cost and model cards (recommended: true) are Usage → Recommended items now, marked as the agent's (v2.158.0); the console still shows every card.
  const cards = r.pending.filter(p => !p.recommended);
  // A card filed again elsewhere (another tab, the phone) changes no id, but loses File it again: in the signature too.
  // So does a card that leaves Usage → Recommended (its agent archived, Not now): its id stays, and it was added to
  // Alerts only when something else changed, while its count said it was there (HB-1458).
  const sig = [...r.pending.map(p => `${p.confirmId}${p.recommended ? ':rec' : ''}`), ...failed.map(f => `f:${f.confirmId}${f.refiled ? ':refiled' : ''}`)].join(',');
  $('v2Proposals').hidden = !(cards.length || failed.length || renderV2Joins());
  $('v2PropCount').textContent = cards.length || '';
  // While you talk to your management agent, what it prepares shows right
  // above the conversation — in Hatchabot's frame, which the agent can't draw in.
  const inConsole = $('consoleDlg').open && v2Find(consoleAgentId)?.ops;
  const cp = $('consoleProps');
  cp.hidden = !(inConsole && r.pending.length);
  if (sig === v2PropSig && cp.__sig === (inConsole ? sig : '')) return; // don't rebuild under a finger
  v2PropSig = sig; cp.__sig = inConsole ? sig : '';
  const list = $('v2PropList');
  list.innerHTML = ''; cp.innerHTML = '';
  for (const p of r.pending) { if (!p.recommended) mgmtProposalCard(p, list); if (inConsole) mgmtProposalCard(p, cp); }
  for (const f of failed) { mgmtFailedCard(f, list); if (inConsole) mgmtFailedCard(f, cp); }
}

/** A change you confirmed that did not go through, with the reason and a way
 *  to put it out of sight. */
function mgmtFailedCard(f, into) {
  const card = document.createElement('div');
  card.style.cssText = 'align-self:stretch;border:1px solid var(--bad);border-radius:10px;padding:10px 12px;font-size:14px';
  const head = document.createElement('div');
  head.style.cssText = 'white-space:pre-wrap';
  head.textContent = String(f.outcome || `⚠ Failed — ${f.summary}`);
  card.appendChild(head);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin-top:8px;justify-content:flex-end';
  // One a restart cut off (HB-1053): the same change as a new card, for you to
  // confirm once you have checked it did not happen. Nothing retries it by itself.
  if (f.interrupted && !f.refiled) {
    const again = document.createElement('button');
    again.textContent = 'File it again';
    again.title = 'A new card with the same change, waiting for your Confirm. Check first that it did not happen.';
    again.addEventListener('click', async () => {
      again.disabled = true;
      try {
        const r = await api(`/v1/proposals/${encodeURIComponent(f.confirmId)}/again`, { method: 'POST', body: {} });
        v2DismissProp(f.confirmId);
        // Where the new card is, by the cards list's rule: a cost or model card is a Usage → Recommended item.
        toast(`Filed again: its card is ${r?.where === 'recommended' ? 'under Usage → Recommended' : 'under Alerts'}. Confirm it there once you are sure it did not happen.`, 6000);
        v2PropSig = '';
        await loadProposals();
      } catch (e) { toast(e.message, 9000); again.disabled = false; }
    });
    row.appendChild(again);
  }
  const hide = document.createElement('button');
  hide.textContent = 'Dismiss';
  hide.addEventListener('click', () => { card.remove(); v2DismissProp(f.confirmId); });
  row.appendChild(hide); card.appendChild(row);
  into.appendChild(card);
}
/** Dismissed failure cards, remembered across reloads — Dismiss used to last
 *  until the page was refreshed, and the card came straight back (2026-09-19).
 *  A failure is only shown for an hour, so a short list is plenty. */
const v2PropDismissed = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('hb-prop-dismissed') || '[]')); } catch { return new Set(); }
})();
function v2DismissProp(id) {
  v2PropDismissed.add(id);
  try { localStorage.setItem('hb-prop-dismissed', JSON.stringify([...v2PropDismissed].slice(-50))); } catch { /* private window */ }
}
setInterval(() => { if ($('consoleDlg').open && v2Find(consoleAgentId)?.ops) void loadProposals(); }, 4000);

/**
 * People knocking on your agents, on the home screen beside the changes waiting
 * for you. Admitting someone used to be the retired Telegram bot's job; without
 * this the only sign was a badge on that agent's icon (2026-09-19).
 */
function renderV2Joins() {
  const box = $('v2JoinList');
  if (!box) return 0;
  const rows = [];
  for (const a of agents ?? []) {
    if (!v2Mine(a)) continue;
    for (const p of pairings[a.id] ?? []) {
      const kind = p.kind || 'telegram';
      const who = p.meta?.firstName || p.meta?.username || p.id;
      const self = kind !== 'telegram' || !myAccount.telegramUserId;
      rows.push(`<div class="v2join">
        <span class="grow">🔑 <b class="pii">${esc(who)}</b> wants to talk to <b>${esc(a.name)}</b>${kind === 'telegram' ? '' : ` on ${V2_CHAN_LABEL[kind] || kind}`}</span>
        <button ${onAction('click', 'denyPair', [`${a.id ?? ''}`, `${p.code ?? ''}`, `${who ?? ''}`, `${kind}`])} title="Turn this request away — they can ask again by messaging the bot">Not now</button>
        ${self ? `<button ${onAction('click', 'approve', [`${a.id ?? ''}`, `${p.code ?? ''}`, true, `${kind}`, `${(p.meta?.firstName || p.meta?.username || p.id) ?? ''}`])} title="This is you: admit and link this account to your login">That's me</button>` : ''}
        ${a.ops ? '' /* the manager is its owner's alone: the server answers 400 (review, 2026-10-09) */ : `<button class="primary" ${onAction('click', 'approve', [`${a.id ?? ''}`, `${p.code ?? ''}`, false, `${kind}`])}>Let them in</button>`}
      </div>`);
    }
  }
  box.innerHTML = rows.join('');
  // The panel belongs to proposals; joins can open it too.
  if (rows.length) $('v2Proposals').hidden = false;
  return rows.length;
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

// ---- polling ------------------------------------------------------------------
let mgmtTick = 0; // counts polls, so the heavier meta reads run every 4th

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
    // The sources' use, the agent's cards, the backup's age, the keys and the security notices: 30 s staleness is
    // fine, so they are read on the meta pass and every 4th poll.
    if (withMeta || mgmtTick++ % 4 === 0) { void loadSourceUsage(); void loadProposals(); void loadBackupAge(); loadFleetKeys(); void loadSecurityNotices(); }
    // Tailscale set-up is the private address's business (the public one refuses it).
    if (withMeta && tailnet === null && !appConfig.publicAddress) void loadTailnet();
    // Pairing checks hit docker exec — do them on a slower cadence. Every knock on this account's running agents
    // in one read (/v1/pending: the server's half-minute cache, six agents at a time), kept by agent as the per-agent
    // read gave them. The page read each agent's at once, beside the bounded read that was there (HB-1142).
    // The list is drawn first, and the knocks when their read lands: on a cold cache that read is as slow as the
    // slowest agent of each six, and the whole page waited for it (HB-1303). The refresh still ends with it.
    let knocks = null;
    if (pairTick++ % 3 === 0) {
      // Only agents in a chat app can be knocked on: with none running, there is nothing to read.
      const pairMine = ++pairSeq;
      knocks = (agents.some(a => a.state === 'RUNNING' && v2ChannelKinds(a).length) ? api('/v1/pending').catch(() => null) : Promise.resolve([]))
        .then((all) => {
          if (pairMine !== pairSeq || !Array.isArray(all)) return false; // a failed read keeps the knocks the last one found
          const was = JSON.stringify(pairings);
          pairings = {};
          for (const p of all) {
            (pairings[p.agentId] ??= []).push({ kind: p.kind, code: p.code, id: p.channelUserId ?? p.telegramId,
              meta: { username: p.username, firstName: p.firstName, lastName: p.lastName } });
          }
          return JSON.stringify(pairings) !== was;
        })
        // Handled where it is made: a draw below that throws leaves it unawaited, and a rejection then went unhandled.
        .catch(() => false);
      // Members are read when an agent's sheet opens (renderEditMembers).
    }
    renderSetup(); renderV2(); // renderV2 itself waits out a drag
    // The knocks drawn as they land, when they changed: on the home screen, their agents' tiles and an open sheet.
    if (knocks && await knocks) renderV2();
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
