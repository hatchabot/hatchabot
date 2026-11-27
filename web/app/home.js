// web/app/home.js: the home screen (renderV2): its views and sort, the chat apps' links, the Activity view, cost badges, the Planned group, icons for agents with none, the tooltip, dragging and groups, the icon menu, opening an agent, the hub.
// One of the page's classic scripts (HB-0811). web/index.html loads them in
// order and they share one global scope; code that runs at load may reach only
// what this file and the ones before it declare (scripts/check-web.mjs).

// ---- the home screen (v2) -----------------------------------------------------
// The icon home screen: agents as icons in groups, a click opens the agent to
// talk to (OpenClaw's own console), and every other control lives in one
// settings sheet. The only home screen since v2.155.0 (the classic cards are
// gone); the sheet borrows the editDlg / cronDlg / healthDlg sections.

/** Same palette and hash as src/orchestrator/homeScreen/agentIcons.ts, so an agent with
 *  no stored colour shows the one the server would give it. */
const V2_PALETTE = ['#3aa36b', '#2f9e8f', '#3a8fd0', '#5a7fd6', '#8a6fd0', '#c26fa0',
  '#d05a5a', '#d0703a', '#e0a13a', '#c9b03a', '#8a9a5a', '#7a8a9a'];
function v2ColorFor(name) {
  let h = 2166136261;
  for (const c of String(name).toLowerCase()) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return V2_PALETTE[(h >>> 0) % V2_PALETTE.length];
}
const V2_ARCHIVE = '__archived__', V2_NEW_GROUP = '__new__';
const v2Mine = (a) => (a.role ? a.role === 'owner' : true);
const v2Find = (id) => agents.find(x => x.id === id);

/** One status per agent, for the ring, the badge and the tooltip — never colour alone. */
function v2Status(a) {
  const waiting = (pairings[a.id] ?? []).length;
  const why = [];
  if (waiting) why.push(`${waiting} ${waiting > 1 ? 'people want' : 'person wants'} to talk to it — let them in from its settings`);
  for (const f of agentAttention(a)) why.push(f.why);
  const limited = sourceUsageOf(a.aiProfileId)?.status === 'limited';
  let st;
  if (a.state === 'ARCHIVED') st = { cls: 'archived', glyph: '', label: 'Archived' };
  // Before the state flips: saving its conversation, then stopping (archivingHere).
  else if (a.archiving) st = { cls: 'working', glyph: '↻', label: /saving/.test(a.archiving.step || '') ? 'Archiving — saving its conversation to memory' : 'Archiving' };
  else if (a.state === 'DELETING') st = { cls: 'working', glyph: '↻', label: 'Deleting' };
  else if (a.queuedForRebuild) st = { cls: 'working', glyph: '⋯', label: 'Waiting its turn to rebuild' };
  // A move, an import, a restore under way (operations.ts): what, which step of how many, how long.
  else if (v2OpGoing(a)) st = { cls: 'working', glyph: '↻', label: v2OpLine(a.operation) };
  else if (a.busy || a.state === 'PROVISIONING' || a.state === 'REBUILDING') {
    st = { cls: 'working', glyph: '↻', label: a.state === 'PROVISIONING' ? 'Setting up' : a.state === 'REBUILDING' ? 'Rebuilding' : 'Working on it' };
  }
  else if (a.state === 'FAILED') st = { cls: 'blocked', glyph: '!', label: 'Failed' };
  // A move or import held for a choice, or one a restart cut off that is being put right (operations.ts).
  else if (a.operation?.status === 'held' && v2Mine(a)) st = { cls: 'waiting', glyph: '⏸', label: `${a.operation.kindLabel || 'An operation'} was interrupted — waiting for your choice` };
  else if (a.operation && (a.operation.status === 'interrupted' || a.operation.status === 'running')) st = { cls: 'working', glyph: '↻', label: a.operation.kindLabel || 'Working on it' };
  else if (a.pendingAction) st = { cls: 'waiting', glyph: '✋', label: 'Waiting on you' };
  else if (waiting && v2Mine(a)) st = { cls: 'waiting', glyph: '👤', label: 'Someone wants to join' };
  else if ((a.stuck || []).length && v2Mine(a) && a.state === 'RUNNING' && !attentionCleared(a)) st = { cls: 'blocked', glyph: '🔁', label: 'Stuck in a loop — using tokens' };
  else if (limited) st = { cls: 'blocked', glyph: '⏳', label: 'AI source rate-limited' };
  else if (a.state === 'STOPPED' && a.stateReason && v2Mine(a) && !attentionCleared(a)) st = { cls: 'blocked', glyph: '!', label: 'Stopped: it did not start again' };
  else if (a.state === 'STOPPED' && a.hibernatedAt) st = { cls: 'stopped', glyph: '💤', label: 'Asleep — wakes when someone writes to it, or when you open it' };
  else if (a.state === 'STOPPED' && !(a.budget?.paused?.staysStopped ?? a.budgetPaused?.staysStopped) && (a.budget?.paused || a.budgetPaused)) st = { cls: 'stopped', glyph: '⏸', label: (a.budget?.paused ?? a.budgetPaused).ended ? "Paused — its budget's pause has ended, but it could not be started yet" : `Paused — ${a.budget?.paused ? 'its' : "this Hatchabot's"} monthly budget is used up` };
  else if (a.state === 'STOPPED') st = { cls: 'stopped', glyph: '⏸', label: 'Stopped' };
  else if (a.hostUnreachable) st = { cls: 'stopped', glyph: '⚠', label: `Its machine${a.hostName ? ` (${a.hostName})` : ''} isn't answering — asleep or offline` };
  else if (why.length && v2Mine(a) && !attentionCleared(a)) st = { cls: 'note', glyph: '⚑', label: 'Worth a look' };
  else st = { cls: 'ok', glyph: '', label: a.state === 'RUNNING' ? 'Ready' : a.state };
  return { ...st, why };
}

/**
 * What a Status section is called when its agents' own words differ: their kind (v2Status's cls). `stopped` holds a
 * running agent whose machine is not answering too, so it is not called "Not running" alone.
 */
const V2_STATE_KINDS = { blocked: 'Failed or blocked', working: 'Busy', waiting: 'Waiting on you', stopped: 'Not running or out of reach', note: 'Worth a look', ok: 'Ready', archived: 'Archived' };

const V2_MARK_SVG = {
  telegram: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>',
  slack: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><path d="M9 3 7 21M17 3l-2 18M4 8.5h17M3 15.5h17"/></svg>',
  discord: '<svg viewBox="0 0 24 24" width="12" height="12" fill="#fff"><path d="M19.5 5.5A16 16 0 0 0 15.6 4l-.5 1a14 14 0 0 0-6.2 0l-.5-1a16 16 0 0 0-3.9 1.5C2 9.4 1.3 13.2 1.6 17a16 16 0 0 0 4.8 2.4l1-1.6a10 10 0 0 1-1.6-.8l.4-.3a11.5 11.5 0 0 0 11.6 0l.4.3-1.6.8 1 1.6a16 16 0 0 0 4.8-2.4c.4-4.4-.6-8.2-2.9-11.5ZM8.7 14.8c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.7 2-1.7 2Zm6.6 0c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.7 2-1.7 2Z"/></svg>',
};
const V2_CHAN_LABEL = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord' };
/** The agent's mark, sized for a button and in the button's own colour. */
const chanIcon = (kind) => (V2_MARK_SVG[kind] || '')
  .replace(/width="\d+" height="\d+"/, 'width="16" height="16"')
  .replaceAll('#fff', 'currentColor');
/** Every chat app this agent is reachable in, as links, for the console
 *  bar: the console is Hatchabot's own window on the agent, but the
 *  conversation people actually have with it lives in Telegram, Slack or
 *  Discord — one press away instead of a hunt through the app. */
/**
 * A link from the server that the page opens: https only, or '' (nothing to
 * link). A stored value that ever became javascript: or data: must not be
 * clickable. Everything Hatchabot stores is an https link built server-side;
 * this is the belt, now on every such link, not only the chat-app ones
 * (review, 2026-10-09).
 */
const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
function agentChannelLinks(a) {
  const ok = (u) => !!httpsUrl(u);
  return [
    ...(a?.botUsername && ok(a?.deepLink) ? [{ kind: 'telegram', url: a.deepLink }] : []),
    ...((a?.otherChannels ?? []).filter((c) => ok(c.deepLink) && V2_MARK_SVG[c.kind]).map((c) => ({ kind: c.kind, url: c.deepLink }))),
  ];
}
/** Every chat app that reaches this agent, Telegram first. */
function v2ChannelKinds(a) {
  return [...(a.botUsername ? ['telegram'] : []), ...(a.otherChannels ?? []).map(c => c.kind).filter(k => V2_MARK_SVG[k])];
}
function v2Marks(a) {
  const kinds = v2ChannelKinds(a).slice(0, 3);
  if (!kinds.length) return '';
  // One badge per app, overlapping like stacked coins, Telegram nearest the
  // corner. It used to show the first app and "+1", which said there was
  // another one but never which (2026-09-19).
  return `<span class="v2mks" aria-hidden="true">${kinds
    .map((k) => `<span class="v2tg v2mk-${k}" title="${V2_CHAN_LABEL[k] ?? k}">${V2_MARK_SVG[k]}</span>`)
    .join('')}</span>`;
}

// Never flag the console you are looking at.
const v2Unread = (a) => !!a.unread && !($('consoleDlg')?.open && consoleAgentId === a.id);
/** How long an agent has been quiet, in one or two characters: 2h, 3d, 5w.
 *  Nothing under an hour, and nothing for an agent that is not running — a
 *  stopped agent's badge already says why it is silent. */
function v2IdleFor(a) {
  if (a.state !== 'RUNNING' || !a.lastActiveAt) return '';
  const h = (Date.now() - Date.parse(a.lastActiveAt)) / 3600_000;
  if (!(h >= 1)) return '';
  return h < 24 ? `${Math.floor(h)}h` : h < 24 * 7 ? `${Math.floor(h / 24)}d` : h < 24 * 365 ? `${Math.floor(h / (24 * 7))}w` : '1y+';
}
/** What the Hatchabot agent's star says (its tooltip, and the tile's label). */
const V2_OPS_TIP = 'Hatchabot — supervises your agents\u2019 AI use';
const V2_STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6 6.5.8-4.8 4.5 1.2 6.5L12 17.2l-5.8 3.2 1.2-6.5L2.6 9.4l6.5-.8z" style="fill:var(--accent);stroke:var(--ops-ring)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
function v2IconHTML(a, st, opts = {}) {
  const color = /^#[0-9a-f]{6}$/i.test(a.iconColor || '') ? a.iconColor : v2ColorFor(a.name);
  const face = a.icon ? esc(a.icon) : esc((a.name.trim()[0] || '?').toUpperCase());
  const idle = v2IdleFor(a);
  return `<span class="v2ic${a.icon ? '' : ' mono'}${a.ops ? ' v2ic-ops' : ''}"><span class="v2tint" style="background:${color}"></span><span class="v2em">${face}</span>`
    // The Hatchabot agent: a gold star in the middle of the left edge (see .v2star).
    + (a.ops ? `<span class="v2star" title="${esc(V2_OPS_TIP)}" aria-hidden="true">${V2_STAR_SVG}</span>` : '')
    // Before the corner marks: they paint over it if a wide one ever meets them.
    + (opts.cost ? v2CostChip(a, !!st.glyph) : '')
    + (idle ? `<span class="v2idle" title="Quiet for ${esc(idle)} — last said something ${esc(ago(a.lastActiveAt))}">${esc(idle)}</span>` : '')
    + (st.glyph ? `<span class="v2badge v2b-${st.cls}" aria-hidden="true">${st.glyph}</span>` : '')
    + (!v2Mine(a) ? '<span class="v2badge v2b-shared" aria-hidden="true">👥</span>' : '')
    + (v2Unread(a) ? '<span class="v2unread" title="New messages in its console" aria-hidden="true"></span>' : '')
    // A small corner mark: which chat apps reach this agent (the first,
    // then "+N" for the rest). Telegram's paper plane, Slack's hash, Discord's pad.
    + v2Marks(a)
    + '</span>';
}

// How the home screen is grouped: by the groups you made, or by where and on
// what the agents run. A per-device choice; "group" is the one you can rearrange.
const V2_VIEWS = [['group', 'Groups'], ['attention', 'Alerts'], ['host', 'Machine'], ['source', 'Source'], ['model', 'Model'], ['cost', 'Cost'], ['image', 'Image'], ['pinned', 'Pinned'], ['class', 'Class'], ['state', 'Status'], ['activity', 'Activity'], ['rebuilt', 'Rebuilt']];
/** Replies waiting to be read, following the most recently active section. */
const V2_UNREAD = 'act:unread';
/** Time-since bins, oldest last; the key's leading digit keeps them in order. */
function v2AgeBin(iso, verb) {
  if (!iso) return ['9', `Never ${verb}`];
  const h = (Date.now() - Date.parse(iso)) / 36e5;
  if (h < 1) return ['0', `${verb} in the last hour`];
  if (h < 24) return ['1', `${verb} today`];
  if (h < 24 * 7) return ['2', `${verb} this week`];
  if (h < 24 * 30) return ['3', `${verb} this month`];
  return ['4', `${verb} longer ago`];
}
let v2View = (() => { try { const v = localStorage.getItem('hb-v2-view'); return V2_VIEWS.some(([k]) => k === v) ? v : 'group'; } catch { return 'group'; } })();
// One Sort for every view: Manual (the order you arranged by hand — Groups
// only, where dragging works), Name, or Activity. Name and Activity order the
// agents on screen and never touch the arrangement; Status has the
// buttons that rewrite it. Remembered per device.
// "My order" (2026-10-09, the classic look's manual order kept): the order
// stored on the agents — the list arrives in it — which drag and the sheet's
// Move earlier / later change, and a group's A→Z writes once.
let v2Sort = (() => { try { const v = JSON.parse(localStorage.getItem('hb-v2-sort') || 'null'); return v && ['age', 'name', 'activity', 'manual'].includes(v.key) ? v : { key: 'age', dir: -1 }; } catch { return { key: 'age', dir: -1 }; } })();
function v2SetSort(key) {
  // Age, Activity and Cost start newest / most recent / dearest first; Name starts A→Z. Again flips.
  // My order has no direction: it is the order you made.
  const cur = v2CurSort();
  const next = { key, dir: key === 'manual' ? 1 : cur.key === key ? -cur.dir : (key === 'name' ? 1 : -1) };
  if (v2View === 'cost') { v2CostSort = next; try { localStorage.setItem('hb-v2-sort-cost', JSON.stringify(next)); } catch {} }
  else { v2Sort = next; try { localStorage.setItem('hb-v2-sort', JSON.stringify(next)); } catch {} }
  renderV2();
}
// The Cost view keeps a sort of its own, most expensive first until you pick
// another; the other views keep theirs (Age · Name · Activity).
let v2CostSort = (() => { try { const v = JSON.parse(localStorage.getItem('hb-v2-sort-cost') || 'null'); return v && ['cost', 'age', 'name', 'activity', 'manual'].includes(v.key) ? v : { key: 'cost', dir: -1 }; } catch { return { key: 'cost', dir: -1 }; } })();
const v2CurSort = () => (v2View === 'cost' ? v2CostSort : v2Sort);
const v2SortKey = () => v2CurSort().key;
/** Sorted by My order: tiles stand where you put them, and drag places them. */
const v2Manual = () => v2SortKey() === 'manual';
function v2BinCmp(x, y) {
  const key = v2SortKey(), dir = v2CurSort().dir;
  if (key === 'cost') return dir * ((v2CostOf(x)?.weekly ?? -1) - (v2CostOf(y)?.weekly ?? -1)) || x.name.localeCompare(y.name);
  if (key === 'age') return dir * String(x.createdAt || '').localeCompare(String(y.createdAt || '')) || x.name.localeCompare(y.name);
  if (key === 'activity') {
    if (!x.lastActiveAt !== !y.lastActiveAt) return x.lastActiveAt ? -1 : 1; // never-active last either way
    return dir * String(x.lastActiveAt || '').localeCompare(String(y.lastActiveAt || '')) || x.name.localeCompare(y.name);
  }
  return dir * x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' });
}
function v2SetView(v) {
  v2View = V2_VIEWS.some(([k]) => k === v) ? v : 'group';
  try { localStorage.setItem('hb-v2-view', v2View); } catch {}
  renderV2();
}
/** The section an agent belongs to under the current view: [key, label]. */
function v2ViewKey(a, view = v2View) {
  switch (view) {
    case 'host': { const h = hosts.find(x => x.id === a.hostId); return ['h:' + a.hostId, h ? (h.kind === 'local' ? 'This machine' : h.name) : 'Unknown machine']; }
    case 'source': { const p = profiles.find(x => x.id === a.aiProfileId); return ['s:' + a.aiProfileId, p ? p.name : 'Unknown source']; }
    case 'model': { const m = (a.model || a.profileDefaultModel || '').replace(/^.*\//, ''); return ['m:' + m, m || 'No model']; }
    case 'class': return ['c:' + (a.classId || ''), a.className || 'No class'];
    case 'activity': {
      // Replies waiting to be read have a section of their own.
      if (v2Unread(a)) return [V2_UNREAD, 'Unread'];
      const [k, l] = v2AgeBin(a.lastActiveAt, 'Active'); return ['act:' + k, l];
    }
    case 'rebuilt': { const [k, l] = v2AgeBin(a.rebuiltAt, 'Rebuilt'); return ['rb:' + k, l]; }
    case 'cost': return v2CostBin(a);
    case 'image': {
      // The fleet default, a pinned base image, or a derived image (its own bin, by name).
      // A pin to a tag that IS the default's image (2026.9.6 just promoted, say) is the default too.
      if (!a.image || a.imageIsDefault) return ['i:', 'Fleet default image'];
      const m = /:derived-([a-z0-9-]+)$/.exec(a.image);
      return ['i:' + a.image, m ? `Derived image: ${m[1]}` : `Image: ${a.image.replace(/^hatchabot-runtime:/, '')}`];
    }
    // Keyed by its kind (Failed and rate-limited are both blocked): a section whose agents differ is named for the kind,
    // after it is filled (V2_STATE_KINDS in renderV2).
    case 'state': { const st = v2Status(a); return ['st:' + st.cls, st.label]; }
    // Who has a pin (and to what), and who follows the fleet default — the
    // ones a promote will not move (Chris, 2026-09-24). A pin to the default's
    // own image is still a pin here: it stays put on the NEXT promote.
    case 'pinned': {
      if (!a.image) return ['p:9', 'Follows the fleet default'];
      const m = /:derived-([a-z0-9-]+)$/.exec(a.image);
      return ['p:' + a.image, `Pinned to ${m ? `derived image ${m[1]}` : a.image.replace(/^hatchabot-runtime:/, '')}${a.imageIsDefault ? ' (the fleet default today)' : ''}`];
    }
    // What wants a click from you, most urgent bin first; the rest are "Fine".
    case 'attention': {
      // An operation held for your choice comes first, and cannot be cleared:
      // the agent refuses Start and the rest until it is chosen (operations.ts).
      if (a.operation?.status === 'held' && v2Mine(a)) return ['n:0', '⏸ Waiting for your choice'];
      if ((pairings[a.id]?.length ?? 0) > 0) return ['n:2', '🔑 Knocking'];
      if (v2Unread(a)) return ['n:3', '💬 To read'];
      // Cleared means gone (Chris, 2026-10-04): back with the fine ones until something new happens.
      if (attentionCleared(a)) return ['n:9', 'Fine'];
      if (a.state === 'FAILED' || a.opsDrift || (a.state === 'STOPPED' && a.stateReason && v2Mine(a))) return ['n:1', '❌ Failed or changed by hand'];
      if (a.rebuild) return ['n:4', a.rebuild.level === 'required' ? '🔄 To rebuild (required)' : '🔄 To rebuild'];
      if (agentAttention(a).length) return ['n:5', '⚠ Alerts'];
      return ['n:9', 'Fine'];
    }
    default: return null;
  }
}
let v2Collapsed = (() => { try { return JSON.parse(localStorage.getItem('hb-v2-collapsed') || '{}') || {}; } catch { return {}; } })();
function v2Fold(key) {
  v2Collapsed[key] = !v2IsCollapsed(key);
  try { localStorage.setItem('hb-v2-collapsed', JSON.stringify(v2Collapsed)); } catch {}
  renderV2();
}
// Archived starts folded; so does Planned while it is empty (one quiet header, until you plan something).
const v2IsCollapsed = (key) => (key in v2Collapsed ? v2Collapsed[key] : key === 'archived' || (key === 'planned' && !agentTodos?.length));

// ---- Activity view: the Unread section and each agent's last line ----------
// GET /v1/recent (orchestrator/conversation/recent.ts): each agent's last line, for its
// tooltip in every view (Chris, 2026-10-03). Read with the list poll, at most
// every 30 s; it never wakes an agent. If it fails, tooltips have no line.
let v2Recent = null, v2RecentBusy = false, v2RecentAt = 0;
const V2_RECENT_EVERY_MS = 30_000;
async function v2LoadRecent(force = false) {
  if (v2RecentBusy || (!force && Date.now() - v2RecentAt < V2_RECENT_EVERY_MS)) return;
  v2RecentBusy = true;
  try {
    const r = await api('/v1/recent?all=1');
    v2Recent = new Map((Array.isArray(r?.items) ? r.items : []).map(i => [i.id, i]));
  } catch { v2Recent = null; }
  finally { v2RecentBusy = false; v2RecentAt = Date.now(); }
  renderV2(); // the tiles' spoken labels carry the line
}
/** The agent's last line, shown in its tooltip (not under the tile, Chris 2026-10-03):
 *  what needs you (as Alerts words it), else who said what last. */
function v2PreviewOf(a) {
  if (!v2Recent) return '';
  const need = v2Mine(a) && !attentionCleared(a) ? agentAttention(a)[0] : null;
  if (need) return `alert: ${need.why}`;
  const said = v2Recent.get(a.id)?.said;
  return typeof said === 'string' ? said : '';
}

// ---- Cost badges and View by → Cost -------------------------------------------
// GET /v1/costs (orchestrator/usage/agentCosts.ts): each agent's last 7 days at API
// prices, as a monthly rate, from what the usage sampler stored — it never
// reads a container or wakes an agent. Read with the list poll, at most every
// 5 minutes (the server caches as long). Agents on a local model have no
// cost; an unknown model's price has no badge.
let v2Costs = null, v2CostsBusy = false, v2CostsAt = 0, v2CostsAgain = false;
const V2_COSTS_EVERY_MS = 5 * 60_000;
// The window the chips and View by → Cost show (COST_PERIODS in agentCosts.ts),
// chosen with the pills above the Cost view; a week unless changed, per browser.
const V2_COST_PERIODS = [['1h', '1 hr', 'the last hour'], ['3h', '3 hr', 'the last 3 hours'], ['6h', '6 hr', 'the last 6 hours'], ['9h', '9 hr', 'the last 9 hours'],
  ['12h', '12 hr', 'the last 12 hours'], ['1d', '1 day', 'the last day'], ['1w', '1 wk', 'the last 7 days'], ['1m', '1 mo', 'the last 30 days']];
let v2CostPeriod = (() => { try { const v = localStorage.getItem('hb-cost-period'); return V2_COST_PERIODS.some(([k]) => k === v) ? v : '1w'; } catch { return '1w'; } })();
/** "the last 3 hours": the window of the figures on screen (the answer's, not a pill just pressed). */
const v2CostWindow = () => (V2_COST_PERIODS.find(([k]) => k === (v2Costs?.period || v2CostPeriod)) ?? V2_COST_PERIODS[6])[2];
function v2SetCostPeriod(p) {
  v2CostPeriod = V2_COST_PERIODS.some(([k]) => k === p) ? p : '1w';
  try { localStorage.setItem('hb-cost-period', v2CostPeriod); } catch {}
  renderV2(); // the pill moves at once; the figures follow
  void v2LoadCosts(true);
}
/** A week under this many dollars shows no badge: the cheap ones say nothing, which keeps the screen calm. Other windows: chipMin from the server. */
const V2_COST_BADGE_MIN_USD = 1;
/** A week from this many dollars takes the soft gold wash; other windows: their top band. */
const V2_COST_GOLD_FROM_USD = 100;
/** View by → Cost's section for a band: the edges come with the costs (COST_BANDS in agentCosts.ts, $10 / $50 / $100). */
function v2CostBandLabel(tier) {
  const b = Array.isArray(v2Costs?.bands) && v2Costs.bands.length ? v2Costs.bands : [10, 50, 100];
  // Written like the chips (Chris, 2026-10-05): "<$10/wk", "$1.50–7.50/day", ">$15/day".
  const n = (x) => Number(x).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: Number.isInteger(x) ? 0 : 2 });
  const per = v2Costs?.period && v2Costs.period !== '1w' ? (v2Costs.suffix || '') : '/wk';
  if (tier <= 1) return `<$${n(b[0])}${per}`;
  if (tier > b.length) return `>$${n(b[b.length - 1])}${per}`;
  return `$${n(b[tier - 2])}–${n(b[tier - 1])}${per}`;
}
async function v2LoadCosts(force = false) {
  // A pill pressed while a read is out: read again once it is back (#93).
  if (v2CostsBusy) { if (force) v2CostsAgain = true; return; }
  if (!force && Date.now() - v2CostsAt < V2_COSTS_EVERY_MS) return;
  v2CostsBusy = true;
  v2CostsAgain = false;
  const asked = v2CostPeriod;
  let kept = true;
  try {
    const r = await api(`/v1/costs?period=${asked}`);
    // Another pill was pressed meanwhile: this answer is not shown, nor counted as fresh.
    if (asked !== v2CostPeriod) kept = false;
    else v2Costs = r && typeof r.agents === 'object' ? { off: !!r.off, agents: r.agents || {}, bands: r.bands, period: r.period || '1w', chipMin: r.chipMin, suffix: r.suffix } : null;
  } catch { v2Costs = null; }
  finally { v2CostsBusy = false; if (kept) v2CostsAt = Date.now(); }
  if (!kept || v2CostsAgain) { void v2LoadCosts(true); return; }
  if (v2Costs?.off && v2View === 'cost') v2View = 'group'; // the owner turned them off: not a view to land on
  renderV2();
}
const v2CostsOff = () => !!v2Costs?.off;
const v2CostOf = (a) => (v2Costs && !v2Costs.off ? v2Costs.agents[a.id] : undefined);
/** "$3.40", "$86", "$1,240". */
function v2Money(x) {
  return x < 10 ? '$' + (Math.round(x * 100) / 100).toFixed(2) : '$' + Math.round(x).toLocaleString('en-US');
}
/** The badge's figure: "$4/wk", "$240/wk", "$1.2k/wk", "$0.35/3h"; '' under the window's smallest chip. */
function v2WeekChipText(usd, suffix = '/wk', min = V2_COST_BADGE_MIN_USD) {
  if (!(usd >= min)) return '';
  if (usd < 1) return `$${usd.toFixed(2)}${suffix}`;
  const whole = Math.round(usd);
  return whole < 1000 ? `$${whole}${suffix}` : `$${(usd / 1000).toFixed(1).replace(/\.0$/, '')}k${suffix}`;
}
/** The chip's markup: the figure, then a smaller "/wk". */
function v2WeekChipHTML(text) {
  const i = text.indexOf('/');
  return i > 0 ? `${esc(text.slice(0, i))}<small>${esc(text.slice(i))}</small>` : esc(text);
}
function v2CostChip(a, crowded = false) {
  const c = v2CostOf(a);
  if (!c || !c.priced || c.local) return '';
  const week = !v2Costs.period || v2Costs.period === '1w';
  const amount = week ? c.weekly : c.cost;
  const gold = week ? V2_COST_GOLD_FROM_USD : (v2Costs.bands || []).slice(-1)[0] ?? Infinity;
  const text = week ? v2WeekChipText(amount) : v2WeekChipText(amount, v2Costs.suffix || '', v2Costs.chipMin ?? 0.01);
  return text ? `<span class="v2cost${amount >= gold ? ' v2cost-hi' : ''}${crowded ? ' v2cost-l' : ''}" aria-hidden="true">${v2WeekChipHTML(text)}</span>` : '';
}
/** The tooltip's cost line (every view), or ''. */
function v2CostLine(a) {
  const c = v2CostOf(a);
  if (!c || !c.tier) return '';
  if (c.local) return 'Runs on a local model: no API cost';
  if (!c.priced) return 'Cost: no price known for its model';
  // Short, like the chips (2026-11-09): "≈ $31/wk at API prices (≈ $134/mo)".
  const period = v2Costs?.period || '1w', per = period === '1w' ? '/wk' : (v2Costs?.suffix || '');
  return `≈&nbsp;${v2Money(c.cost)}${per} at API prices${period === '1m' ? '' : ` (≈&nbsp;${v2Money(c.monthly)}/mo${period === '1w' ? '' : ' at this pace'})`}`
    + (c.plan ? `<br>Counts against ${v2Mine(a) ? 'your' : 'its owner\'s'} Claude plan` : '');
}
/** The tooltip's budget and spending alarm, shown even in a window with no use. */
function v2SpendLines(a) {
  return [
    a.budget ? `Budget: ${v2Money(a.budget.spent)} of ${v2Money(a.budget.usd)} this month (${a.budget.pct}%)` : '',
    a.spendStep ? `🔔 Alarm every ${v2Money(a.spendStep.every)} · next at ${v2Money(a.spendStep.next)}` : '',
  ].filter(Boolean);
}
/** "8 min", "3 h 12 min", "4 days": how long its OpenClaw process has been up. */
function v2Uptime(iso) {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return `${Math.floor(m / 1440)} days`;
}
/** What an exit code means, for the restart line (docker's 128 + signal). */
const V2_EXIT_WORDS = { 0: 'it quit by itself', 1: 'an error', 134: 'it aborted', 135: 'a memory fault', 137: 'killed, usually for memory', 139: 'a crash', 143: 'told to stop' };
/** The tooltip's runtime lines: version and model, uptime, restarts, Telegram. */
function v2RuntimeLines(a) {
  const out = [];
  // Two lines where there were three (2026-11-09): "claude-sonnet-5 · up 3 h", then "OpenClaw 2026.9.8 · update ready".
  const up = a.state === 'RUNNING' && a.startedAt ? v2Uptime(a.startedAt) : '';
  if (a.model) out.push(esc(a.model) + (up ? ` · up ${up}` : '')); else if (up) out.push(`Up ${up}`);
  const version = [a.openclawVersion ? `OpenClaw ${esc(a.openclawVersion)}` : '', a.updateAvailable ? 'update ready' : ''].filter(Boolean);
  if (version.length) out.push(version.join(' · '));
  if (a.restarts) {
    const word = V2_EXIT_WORDS[a.lastExitCode];
    out.push(`Restarted by itself ${a.restarts === 1 ? 'once' : `${a.restarts} times`} since rebuild`
      + (a.lastExitCode !== undefined ? ` (last: ${word || `exit ${a.lastExitCode}`})` : ''));
  }
  if (a.botUsername) out.push(`On Telegram as @${esc(a.botUsername)}`); // an agent without Telegram says nothing about it (Chris, 2026-10-03)
  return out;
}
/** View by → Cost: the dearest band first, then no price known, then no use. */
function v2CostBin(a) {
  if (!v2Costs) return ['$:d', 'Cost not read yet'];
  const c = v2CostOf(a);
  if (!c) return ['$:c', 'No cost shown'];
  if (!c.tier) return ['$:b', 'No usage']; // the pill above says which window
  if (!c.priced) return ['$:a', 'No price known'];
  const t = c.local ? 1 : c.tier;
  return ['$:' + (100 - t), v2CostBandLabel(t)];
}

function renderV2() {
  if (v2drag.active) return; // never re-render out from under a drag
  // Until the first list arrives the page keeps its "Loading…" line: an
  // empty grid under a half-filled hub read as broken (Chris, 2026-09-23).
  if (!agentsLoaded) return;
  v2MaybeAutoIcons();
  v2RenderHub();
  v2PaintMachine(); // with no Hatchabot agent's tile, the machine line carries the machine's alerts (HB-1463)
  renderV2Joins(); // people knocking: refreshed with the pairing poll, not only with proposals
  v2RenderWho();
  v2RefreshSheet();
  // The manager is the first tile of the Default group, fixed in place — the
  // hub that used to hold it is gone (Chris, 2026-09-26).
  const live = liveAgents().sort((x, y) => (y.ops && v2Mine(y) ? 1 : 0) - (x.ops && v2Mine(x) ? 1 : 0));
  const liveIds = new Set(live.map(x => x.id));
  const sections = [], byKey = new Map();
  const section = (key, label, drop) => {
    let s = byKey.get(key);
    if (!s) { s = { key, label, drop, items: [] }; byKey.set(key, s); sections.push(s); }
    return s;
  };
  const named = live.some(a => a.group);
  const emitted = new Set();
  const withKids = (s, a, depth) => {
    emitted.add(a.id);
    s.items.push({ a, child: depth > 0 });
    for (const k of live.filter(k => k.parentAgentId === a.id && !emitted.has(k.id))) {
      if (v2View === 'activity' && v2Unread(k) !== v2Unread(a)) continue; // placed on its own below
      withKids(s, k, depth + 1);
    }
  };
  // Under another view, sections are read-only bins: no drag between them, no reordering.
  const groupSection = (a) => {
    const k = v2ViewKey(a);
    return k ? section(k[0], k[1], null) : section('g:' + (a.group || ''), a.group || (named ? 'Default' : 'Agents'), a.group || '');
  };
  for (const a of live) {
    if (a.parentAgentId && liveIds.has(a.parentAgentId)) continue;
    if (!v2Mine(a)) continue; // shared with me: its own section, below
    withKids(groupSection(a), a, 0);
  }
  for (const a of live) if (!emitted.has(a.id) && v2Mine(a)) withKids(groupSection(a), a, 0); // lineage-cycle fallback
  for (const a of live) if (!v2Mine(a)) (v2View === 'activity' && v2Unread(a) ? section(V2_UNREAD, 'Unread', null) : section('shared', 'Shared with me', null)).items.push({ a, child: false });
  // By status, a section holds one kind (blocked, working, stopped…) and took the first agent's own words: a failed agent
  // and a rate-limited one were both "Failed", or both "AI source rate-limited", and Bulk acted on them under that
  // name. Agents whose words differ: the kind's name; the tile keeps its own words (HB-1145).
  if (v2View === 'state') for (const s of sections) {
    if (!s.key.startsWith('st:')) continue;
    if (new Set(s.items.filter(i => !i.child).map(i => v2Status(i.a).label)).size > 1) s.label = V2_STATE_KINDS[s.key.slice(3)] ?? s.label;
  }
  const parked = archivedAgents();
  if (parked.length) for (const a of parked) section('archived', 'Archived', V2_ARCHIVE).items.push({ a, child: false });
  else if (live.some(v2Mine)) section('archived', 'Archived', V2_ARCHIVE); // somewhere to drop one

  // Time bins keep their own order (recent → old); other views go alphabetical. Shared and Archived last.
  // ...and Cost keeps its tiers in order, dearest first.
  // Sections in their keys' order: time bins, and Alerts most urgent first (n:0 held for a choice, n:1 failed…).
  // Alerts was ordered by its labels' emoji, which put "⚠ Alerts" above "❌ Failed" (2026-10-09).
  const timeView = v2View === 'activity' || v2View === 'rebuilt' || v2View === 'cost' || v2View === 'attention';
  const activityRank = key => key === 'act:0' ? 0 : key === V2_UNREAD ? 1 : 2;
  if (v2View !== 'group') sections.sort((x, y) => (x.key === 'shared' || x.key === 'archived') - (y.key === 'shared' || y.key === 'archived') || (v2View === 'activity' ? activityRank(x.key) - activityRank(y.key) : 0) || (timeView ? x.key.localeCompare(y.key) : x.label.localeCompare(y.label)));
  // Unread: newest reply first, whatever the sort.
  const newestFirst = (x, y) => String(y.lastActiveAt || '').localeCompare(String(x.lastActiveAt || '')) || x.name.localeCompare(y.name);
  // My order: the order they were placed in above is the stored one, a child
  // right after its parent (the way the classic look nested them).
  for (const s of sections) if (!v2Manual() || s.key === V2_UNREAD) s.items.sort((p, q) => ((q.a.ops ? 1 : 0) - (p.a.ops ? 1 : 0)) || (s.key === V2_UNREAD ? newestFirst(p.a, q.a) : v2BinCmp(p.a, q.a))); // the manager stays first
  // A Cost section's header says what its agents came to this week.
  if (v2View === 'cost') for (const s of sections) {
    const week = !v2Costs?.period || v2Costs.period === '1w';
    const sum = s.items.reduce((t, { a }) => { const c = v2CostOf(a); return t + (c && c.priced && !c.local ? (week ? c.weekly : c.cost) : 0); }, 0);
    if (sum > 0 && s.key.startsWith('$:')) s.note = `(${v2Money(sum)} total)`;
  }
  const sortBar = `<span class="v2binsort" role="group" aria-label="Order within each section">${[...(v2View === 'cost' ? [['cost', 'Cost']] : []), ['age', 'Age'], ['name', 'Name'], ['activity', 'Activity'], ['manual', 'My order']].map(([k, l]) => {
    const on = v2SortKey() === k;
    const title = k === 'cost' ? 'Most expensive first; again for cheapest first' : k === 'age' ? 'Newest agent first; again for oldest first' : k === 'name' ? 'A→Z; again for Z→A'
      : k === 'manual' ? 'The order you arranged: drag icons within a group, or use Move earlier / later on an agent\'s Overview' : 'Most recently active first; again for quietest first';
    return `<button id="v2sort-${k}" class="${on ? 'on' : ''}" aria-pressed="${on}" ${onAction('click', 'v2SetSort', [`${k}`])} title="${esc(title)}">${l}${on && k !== 'manual' ? (v2CurSort().dir > 0 ? ' ▲' : ' ▼') : ''}</button>`;
  }).join('')}</span>`;
  const views = v2CostsOff() ? V2_VIEWS.filter(([k]) => k !== 'cost') : V2_VIEWS;
  // Real tabs: arrow keys move between them, and each controls the sections below (2026-10-09).
  const viewBar = live.length > 1 ? `<div class="v2viewbar"><div class="v2views" role="tablist" aria-label="Group agents by" ${onAction('keydown', 'v2TabKeys', [{ $: 'event' }, { $: 'el' }])}>${views.map(([k, l]) =>
    `<button role="tab" id="v2view-${k}" aria-selected="${k === v2View}" aria-controls="v2ViewPanel" tabindex="${k === v2View ? 0 : -1}" class="${k === v2View ? 'on' : ''}" ${onAction('click', 'v2SetView', [`${k}`])}>${esc(l)}</button>`).join('')}</div>${sortBar}</div>` : '';
  // View by → Cost: the window its sections and every icon's chip show.
  const costBar = v2View === 'cost' && !v2CostsOff() ? `<div class="v2costbar" role="group" aria-label="Cost over">${V2_COST_PERIODS.map(([k, l, w]) =>
    `<button class="su-period${k === v2CostPeriod ? ' on' : ''}" aria-pressed="${k === v2CostPeriod}" title="What each agent cost in ${w}, at API prices" ${onAction('click', 'v2SetCostPeriod', [`${k}`])}>${esc(l)}</button>`).join('')}</div>` : '';
  v2SectionsNow = sections;
  // Planned agents (2026-10-09, from the classic legend): ghost tiles in the
  // Groups view, before Shared with me and Archived.
  if (agentTodos === null) { agentTodos = []; void loadTodos(); }
  const planned = v2View === 'group' && (agentTodos.length || live.some(v2Mine)) ? v2PlannedHTML() : '';
  const parts = sections.map(s => `
    <section class="v2group${v2IsCollapsed(s.key) ? ' collapsed' : ''}">
      <div class="v2ghead"><h3${/^\$:\d/.test(s.key) ? ' class="v2h-money"' : ''}${s.key.startsWith('g:') && s.drop ? ` class="group-name" tabindex="0" title="Double-click to rename" ${onAction('dblclick', 'editGroupName', [{ $: 'el' }])} ${onAction('keydown', 'editGroupNameOnEnter', [{ $: 'event' }, { $: 'el' }])}` : ''}>${esc(s.label)}</h3><span class="n">${s.items.length}</span>${s.note ? `<span class="n v2gnote">${esc(s.note)}</span>` : ''}
        <span class="v2gtools">
          ${s.key.startsWith('g:') && s.drop ? `<button ${onAction('click', 'editGroupNameOf', [{ $: 'el' }])} title="Rename this group" aria-label="Rename group">✏️</button><button ${onAction('click', 'moveGroup', [`${s.drop ?? ''}`, "up"])} title="Move this group up" aria-label="Move group up">↑</button><button ${onAction('click', 'moveGroup', [`${s.drop ?? ''}`, "down"])} title="Move this group down" aria-label="Move group down">↓</button>` : ''}
          ${v2View === 'group' && v2Manual() && s.key.startsWith('g:') && s.drop !== null && s.items.filter(({ a }) => v2Mine(a) && !a.ops).length > 1 ? `<button ${onAction('click', 'sortGroup', [`${s.drop ?? ''}`, "name"])} title="Put this group in A→Z order and keep it — press again for Z→A; drag or Move earlier / later still rearrange it" aria-label="Sort this group A to Z and keep that order">A→Z</button>` : ''}
          ${s.items.some(({ a }) => v2Mine(a) && a.state !== 'ARCHIVED') ? `<button ${onAction('click', 'v2BulkSection', [`${s.key ?? ''}`, `${s.label ?? ''}`])} title="Bulk actions on the agents in this section">⚡</button>` : ''}
          ${s.items.length ? `<button ${onAction('click', 'v2CopySection', [`${s.key ?? ''}`])} title="Copy the names of the agents in this section" aria-label="Copy agent names">⧉</button>` : ''}
          ${v2View === 'attention' && ['n:1', 'n:4', 'n:5'].includes(s.key) && s.items.some(({ a }) => v2Mine(a)) ? `<button ${onAction('click', 'clearAttentionSection', [`${s.key ?? ''}`])} title="Clear these from Alerts — each comes back if something new happens to it" aria-label="Clear from Alerts">🔕</button>` : ''}
          <button ${onAction('click', 'v2Fold', [`${s.key ?? ''}`])} aria-expanded="${!v2IsCollapsed(s.key)}">${v2IsCollapsed(s.key) ? 'Show' : 'Hide'}</button>
        </span></div>
      <div class="v2grid"${s.drop !== null ? ` data-v2drop="${esc(s.drop)}"` : ''}>
        ${s.items.map(({ a, child }) => {
          const st = v2Status(a);
          const prev = v2PreviewOf(a);
          const cost = v2CostChip(a) ? (!v2Costs.period || v2Costs.period === '1w' ? `, about ${v2Money(v2CostOf(a).weekly)} a week at API prices` : `, about ${v2Money(v2CostOf(a).cost)} in ${v2CostWindow()} at API prices`) : '';
          return `<button class="v2agent v2st-${st.cls}${child ? ' v2child' : ''}" data-v2id="${esc(a.id)}"${child || !v2Mine(a) || a.ops ? ' data-v2fixed="1"' : ''}
            aria-label="${esc(a.name)}${a.ops ? ` (${esc(V2_OPS_TIP)})` : ''} — ${esc(st.label)}${v2Unread(a) ? ', new messages' : ''}${esc(cost)}${prev ? `. ${esc(prev)}` : ''}">${v2IconHTML(a, st, { cost: true })}<span class="v2name">${esc(a.name)}</span></button>`;
        }).join('') || (s.key === 'archived' ? `<span class="sub" style="grid-column:1/-1">Drag an agent here to archive it — its memory is kept. By keyboard: open the agent, then Archive at the foot of its Overview.</span>` : '')}
      </div>
    </section>`);
  const tail = sections.findIndex(s => s.key === 'shared' || s.key === 'archived');
  if (planned) parts.splice(tail < 0 ? parts.length : tail, 0, planned);
  const html = viewBar + `<div id="v2ViewPanel"${viewBar ? ` role="tabpanel" aria-labelledby="v2view-${v2View}"` : ''}>` + costBar + parts.join('') + '</div>';
  // The poll calls this every few seconds. Rebuilding identical markup would
  // drop keyboard focus and strand a tooltip over a replaced icon, so only
  // touch the DOM when something changed, and put focus back if it did.
  const root = $('v2groups');
  if (root.__html === html) return;
  const was = document.activeElement;
  const focused = was?.closest?.('.v2agent')?.dataset.v2id;
  // A control with an id (a view tab, a sort, "Plan an agent…") gets focus back too, and a draft keeps its text.
  const focusId = root.contains(was) && was.id ? was.id : '';
  const draft = $('v2TodoNew')?.value ?? '', caret = focusId === 'v2TodoNew' ? was.selectionStart : null;
  root.innerHTML = html; root.__html = html;
  $('v2Tip').hidden = true;
  if ($('v2TodoNew') && draft) $('v2TodoNew').value = draft;
  if (focused) root.querySelector(`.v2agent[data-v2id="${CSS.escape(focused)}"]`)?.focus();
  else if (focusId && $(focusId)) { $(focusId).focus(); if (caret !== null) $(focusId).setSelectionRange(caret, caret); }
}
/** The Planned group: agents you mean to make, as ghost tiles. One click makes one (New agent, its name filled in). */
function v2PlannedHTML() {
  const todos = agentTodos || [];
  const folded = v2IsCollapsed('planned');
  return `
    <section class="v2group v2planned${folded ? ' collapsed' : ''}" aria-labelledby="v2PlanTitle">
      <div class="v2ghead"><h3 id="v2PlanTitle" title="Agents you plan to make — not made yet">Planned</h3><span class="n">${todos.length}</span>
        <span class="v2gtools"><button ${onAction('click', 'v2Fold', ["planned"])} aria-expanded="${!folded}">${folded ? 'Show' : 'Hide'}</button></span></div>
      <div class="v2grid">
        ${todos.map(t => `<div class="v2plan">
          <button type="button" class="v2plantile" ${onAction('click', 'createFromTodo', [`${t.id ?? ''}`])} aria-label="${esc(t.name)} — planned, not made yet. Make it now" title="${esc(`Not made yet — click to make it${t.note ? `: ${t.note}` : ''}`)}"><span class="v2ic" aria-hidden="true">＋</span><span class="v2name">${esc(t.name)}</span></button>
          <button type="button" class="v2planx" ${onAction('click', 'removeTodo', [`${t.id ?? ''}`, `${t.name ?? ''}`])} aria-label="Remove ${esc(t.name)} from Planned" title="Remove from Planned">×</button></div>`).join('')}
        <form class="v2planadd" ${onAction('submit', 'addTodo', ["v2TodoNew"], 'prevent')}>
          <label for="v2TodoNew" class="v2sr">Plan an agent: its name</label>
          <input id="v2TodoNew" maxlength="64" placeholder="Plan an agent…" autocomplete="off">
          <button type="submit">Add</button></form>
      </div>
    </section>`;
}

let agentTodos = null, pendingTodoName = null, todosBusy = false;
/**
 * A plan is done when one of your own agents with its name was made after it. An
 * older agent, or one shared with you, says nothing about the plan: every plan
 * carrying such a name was deleted the moment it was added (HB-0447).
 */
const todoIsMade = (t) => agents.some(a => a.state !== 'DELETED' && v2Mine(a) && a.name.trim().toLowerCase() === t.name.trim().toLowerCase()
  && (!a.createdAt || !t.createdAt || a.createdAt >= t.createdAt));
async function loadTodos() {
  if (todosBusy) return;
  todosBusy = true;
  try {
    try { agentTodos = (await api('/v1/agent-todos')).todos || []; } catch { agentTodos = []; }
    // Created since? An agent now carrying a planned name retires the plan.
    for (const t of agentTodos.filter(todoIsMade)) {
      try { await api(`/v1/agent-todos/${t.id}`, { method: 'DELETE' }); } catch {}
      agentTodos = agentTodos.filter(x => x.id !== t.id);
    }
  } finally { todosBusy = false; }
  renderV2(); // the home screen's Planned group
}
/** A planned agent was made (from its ghost tile, or by hand) since the plans were read: retire it. */
function retireMadeTodos() {
  if (!agentTodos?.length || todosBusy) return;
  if (agentTodos.some(todoIsMade)) void loadTodos();
}
async function addTodo(boxId = 'v2TodoNew') {
  const name = ($(boxId)?.value || '').trim();
  if (!name) return;
  try {
    await api('/v1/agent-todos', { method: 'POST', body: { name } });
    if ($(boxId)) $(boxId).value = ''; // the list keeps a draft across redraws; an added one is done
    await loadTodos();
    $(boxId)?.focus(); // ready for the next one
  } catch (e) { toast(e.message); }
}
async function removeTodo(id, name) {
  if (!confirm(`Remove "${name}" from the plan?`)) return;
  try {
    await api(`/v1/agent-todos/${id}`, { method: 'DELETE' });
    await loadTodos();
    $('v2TodoNew')?.focus(); // the button pressed is gone: keep the keyboard in the group
  } catch (e) { toast(e.message); }
}
function createFromTodo(id) {
  const t = (agentTodos || []).find(x => x.id === id);
  if (!t) return;
  pendingTodoName = t.name;
  $('fabBtn').click(); // opens the create dialog; the name is pre-filled there
}

// Icons for agents that have none yet: one batch, picked by the management AI.
let v2IconTry = 0;
function v2MaybeAutoIcons() {
  if (!agents.some(a => v2Mine(a) && !a.icon && a.state !== 'DELETED')) return;
  if (Date.now() - v2IconTry < 5 * 60e3) return;
  v2IconTry = Date.now();
  api('/v1/agents/icons/auto', { method: 'POST', body: {} })
    .then(r => { if (r.assigned) refresh(false); }).catch(() => {});
}

// ---- tooltip --------------------------------------------------------------------
function v2ShowTip(el) {
  const a = v2Find(el.dataset.v2id); if (!a) return;
  const st = v2Status(a);
  const tip = $('v2Tip');
  // Three parts (Chris, 2026-10-07): what it's doing (status, alerts, last line),
  // what it costs (cost, budget, spending alarm), and its runtime (OpenClaw
  // version, uptime, restarts). The persona left: it's static, and on its page.
  const sec = (lines, cls) => lines.length ? `<span class="v2tipsec ${cls}">${lines.join('<br>')}</span>` : '';
  const cost = v2CostLine(a);
  tip.innerHTML = `<b>${esc(a.name)} · ${esc(st.label)}</b>${a.ops ? `<span class="v2tipops">★ ${esc(V2_OPS_TIP)}</span>` : ''}${!v2Mine(a) ? 'Shared with you.' : ''}`
    + (st.why.length ? `<ul>${st.why.slice(0, 3).map(w => `<li>${esc(w)}</li>`).join('')}${st.why.length > 3 ? `<li>+${st.why.length - 3} more on its page</li>` : ''}</ul>` : '')
    + (() => {
      // A needs-you line is already in the list above: don't say it twice (2026-10-04).
      const prev = v2PreviewOf(a), at = v2Recent?.get(a.id)?.at;
      if (!prev || (prev.startsWith('alert: ') && st.why.some((w) => prev.slice(7) === w))) return '';
      return `<span class="v2tipprev">${at ? esc(ago(at)) + ' · ' : ''}${esc(prev)}</span>`;
    })()
    + sec([cost, ...v2SpendLines(a)].filter(Boolean), 'v2tipcost')
    + sec(v2RuntimeLines(a), 'v2tiprun');
  tip.hidden = false;
  const r = el.querySelector('.v2ic').getBoundingClientRect();
  const w = tip.offsetWidth;
  tip.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  // Below the icon; with no room there, above it: pushed up to fit, it covered the
  // icon and the groups around it, where the icon is dragged to (Chris, 2026-11-09).
  const h = tip.offsetHeight, below = r.bottom + 10, above = r.top - 10 - h;
  tip.style.top = (below + h <= innerHeight - 8 ? below : above >= 8 ? above : Math.max(8, Math.min(innerHeight - h - 8, below))) + 'px';
}
document.addEventListener('mouseover', (e) => { const el = e.target.closest?.('.v2agent'); if (el && !v2drag.active && !v2drag.st) v2ShowTip(el); });
document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.v2agent')) $('v2Tip').hidden = true; });
// Focus from a press is not the keyboard's: the press has just hidden the tooltip for a drag.
document.addEventListener('focusin', (e) => { const el = e.target.closest?.('.v2agent'); if (el && e.target.matches?.(':focus-visible')) v2ShowTip(el); else $('v2Tip').hidden = true; });
window.addEventListener('scroll', () => { $('v2Tip').hidden = true; }, { passive: true });

// ---- drag to rearrange ------------------------------------------------------------
// Mouse: press and move. Touch: press and hold, then move — a plain swipe
// still scrolls the page. Drop between icons to place it, on a group to join
// it, on Archived to archive, or on the strip at the bottom for a new group.
const v2drag = { st: null, active: false, suppress: false };
$('v2groups').addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.v2agent');
  if (el) $('v2Tip').hidden = true; // a press may start a drag: the groups it goes to stay in sight
  if (!el || e.button !== 0 || el.dataset.v2fixed) return;
  const a = v2Find(el.dataset.v2id); if (!a) return;
  const st = { el, a, x0: e.clientX, y0: e.clientY, pid: e.pointerId, touch: e.pointerType === 'touch', held: e.pointerType !== 'touch' };
  if (st.touch) st.timer = setTimeout(() => { st.held = true; navigator.vibrate?.(15); }, 350);
  v2drag.st = st;
});
window.addEventListener('touchmove', (e) => { if (v2drag.active) e.preventDefault(); }, { passive: false });
window.addEventListener('pointermove', (e) => {
  const st = v2drag.st; if (!st || e.pointerId !== st.pid) return;
  if (!v2drag.active) {
    const moved = Math.hypot(e.clientX - st.x0, e.clientY - st.y0);
    if (!st.held) { if (moved > 8) { clearTimeout(st.timer); v2drag.st = null; } return; } // a swipe: let it scroll
    if (moved < 6) return;
    v2drag.active = true;
    $('v2Tip').hidden = true;
    document.body.classList.add('v2dragging');
    st.el.classList.add('v2src');
    st.ghost = st.el.cloneNode(true); st.ghost.classList.add('v2ghost'); st.ghost.classList.remove('v2src');
    st.caret = Object.assign(document.createElement('div'), { className: 'v2caret' });
    document.body.append(st.ghost, st.caret);
  }
  e.preventDefault();
  st.x = e.clientX; st.y = e.clientY;
  v2DragHover(st);
  v2AutoScroll(st);
});
/** Where the pointer is now: the ghost, the drop target, the caret. Also run after an auto-scroll moved the page under a still pointer. */
function v2DragHover(st) {
  st.ghost.style.left = st.x + 'px'; st.ghost.style.top = st.y + 'px';
  st.target = v2DropTarget(st.x, st.y, st);
  document.querySelectorAll('.v2grid.drop, .v2newgroup.drop').forEach(x => x.classList.remove('drop'));
  if (st.target?.zone) st.target.zone.classList.add('drop');
  const c = st.target?.caret;
  st.caret.hidden = !c;
  if (c) Object.assign(st.caret.style, { left: `${c.x - 1}px`, top: `${c.top}px`, height: `${c.h}px` });
}
/** A drag is a pointer, not the browser's drag-and-drop, so the page never
 *  scrolls on its own: near the top or the bottom edge (above the docked
 *  strips) it scrolls, faster the closer to the edge (Chris, 2026-09-25). */
const V2_EDGE = 72;
function v2AutoScroll(st) {
  const dock = document.querySelector('.v2dropstrips');
  const bottom = dock ? dock.getBoundingClientRect().top : window.innerHeight;
  let v = 0;
  if (st.y < V2_EDGE) v = -Math.ceil((V2_EDGE - st.y) / 4);
  else if (st.y > bottom - V2_EDGE) v = Math.ceil((st.y - (bottom - V2_EDGE)) / 4);
  st.scrollV = v;
  if (v && !st.scrolling) {
    st.scrolling = true;
    const tick = () => {
      if (!v2drag.active || v2drag.st !== st || !st.scrollV) { st.scrolling = false; return; }
      const before = window.scrollY;
      window.scrollBy(0, st.scrollV);
      if (window.scrollY !== before) v2DragHover(st); // the page moved under the pointer
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}
function v2DropTarget(x, y, st) {
  const under = document.elementFromPoint(x, y);
  if (!under) return null;
  if (under.closest('#v2Trash')) return { zone: $('v2Trash'), trash: true };
  if (under.closest('#v2NewGroup')) return { zone: $('v2NewGroup'), newGroup: true };
  const grid = under.closest('.v2grid[data-v2drop]');
  if (!grid) return null;
  const group = grid.dataset.v2drop;
  if (group === V2_ARCHIVE) return { zone: grid, archive: true };
  // Outside the Groups view the bins are computed (by machine, model, …):
  // an icon can still be carried to a new group, to Archived or to the bin,
  // but not placed in another bin (Chris, 2026-09-25: dragging only worked in Groups).
  if (v2View !== 'group') return null;
  const tiles = [...grid.querySelectorAll('.v2agent:not(.v2child)')].filter(t => t !== st.el);
  let best = null, bestD = Infinity;
  for (const t of tiles) {
    const r = t.getBoundingClientRect();
    const d = Math.hypot(x - (r.left + r.width / 2), y - (r.top + r.height / 2));
    if (d < bestD) { bestD = d; best = { t, r }; }
  }
  if (!best || bestD > 140) return { zone: grid, group, before: null };
  const after = x > best.r.left + best.r.width / 2;
  const next = after ? tiles[tiles.indexOf(best.t) + 1] : best.t;
  // The caret promises a place: only My order keeps one (another sort puts the icon back in its sorted spot).
  return { zone: grid, group, before: next ? next.dataset.v2id : null,
    caret: v2Manual() ? { x: after ? best.r.right + 4 : best.r.left - 4, top: best.r.top, h: best.r.height } : null };
}
function v2DragEnd() {
  const st = v2drag.st;
  clearTimeout(st?.timer);
  st?.el.classList.remove('v2src'); st?.ghost?.remove(); st?.caret?.remove();
  document.body.classList.remove('v2dragging');
  document.querySelectorAll('.v2grid.drop, .v2newgroup.drop').forEach(x => x.classList.remove('drop'));
  v2drag.st = null; v2drag.active = false;
}
window.addEventListener('pointerup', async (e) => {
  const st = v2drag.st; if (!st || e.pointerId !== st.pid) return;
  const wasActive = v2drag.active, t = st.target, a = st.a;
  // A touch held still and let go: the icon's menu (HB-0683). Held and moved, it was a drag (below).
  const heldStill = st.touch && st.held && !wasActive;
  v2DragEnd();
  if (heldStill) {
    // The tap's own click may still come after a short hold: it must not open the agent too.
    v2drag.suppress = true; setTimeout(() => { v2drag.suppress = false; }, 600);
    // The poll may have redrawn the grid during the hold: the icon of that agent now.
    const el = st.el.isConnected ? st.el : $('v2groups').querySelector(`.v2agent[data-v2id="${CSS.escape(a.id)}"]`);
    if (el) v2OpenMenu(el); // under the icon, which stays in sight
    return;
  }
  if (!wasActive) return; // a plain click: the click handler opens it
  v2drag.suppress = true; setTimeout(() => { v2drag.suppress = false; }, 0);
  if (!t) return renderV2();
  try {
    // Before the archived-agent branch: dragging something out of Archived
    // and into the bin is exactly how an archive gets cleared out.
    if (t.trash) {
      await del(a.id, a.name);   // types-the-name confirmation; a drag alone deletes nothing
      return renderV2();
    }
    if (t.archive) {
      if (a.state !== 'ARCHIVED') archiveAgent(a.id, a.name, a.state);
      return renderV2();
    }
    // Restored into the group it was dropped on, which is what the strip and the
    // caret promised: the drop goes on as any other once it is back (HB-0448).
    if (a.state === 'ARCHIVED') {
      if (!await restoreAgent(a.id, a.name)) return renderV2();
      if (!t.newGroup && !v2Manual() && (t.group ?? '') === (a.group ?? '')) return;
    }
    if (t.newGroup) {
      // A fresh group with a placeholder name, then straight into renaming it
      // where it stands (no prompt box, Chris 2026-09-25).
      const taken = new Set(agents.map(x => x.group).filter(Boolean));
      let fresh = 'New group'; for (let i = 2; taken.has(fresh); i++) fresh = `New group ${i}`;
      await api(`/v1/agents/${a.id}/move`, { method: 'POST', body: { before: null, group: fresh } });
      if (v2View !== 'group') v2SetView('group'); // the new group is only visible there, and its name is asked for right away
      await refresh(false);
      const head = [...document.querySelectorAll('#v2groups .v2ghead h3.group-name')].find(h => h.textContent.trim() === fresh);
      if (head) { head.scrollIntoView({ block: 'center' }); editGroupName(head); }
      return;
    } else if (v2Manual()) {
      // My order: the drop is a place — just before the icon the caret stood
      // at (taking that icon's group), or the end of the group (2026-10-09).
      await api(`/v1/agents/${a.id}/move`, { method: 'POST', body: t.before ? { before: t.before } : { before: null, group: t.group } });
      if ((t.group ?? '') !== (a.group ?? '')) toast(`${a.name} moved to ${t.group || 'Default'}`);
    } else {
      // Under Age, Name or Activity positions inside a group are sorted on
      // screen, so a drop is a move BETWEEN groups; a drop back into the
      // same one changes nothing — but says how to arrange by hand.
      if ((t.group ?? '') === (a.group ?? '')) { toast('To arrange icons by hand, choose My order (beside Age · Name · Activity).', 6000); return renderV2(); }
      const r = await api(`/v1/agents/${a.id}/move`, { method: 'POST', body: { before: null, group: t.group } });
      if ((r.group ?? '') !== (a.group ?? '')) toast(`${a.name} moved to ${r.group || 'Default'}`);
    }
    await refresh(false);
  } catch (err) { toast(err.message); renderV2(); }
});
window.addEventListener('pointercancel', (e) => { if (v2drag.st && e.pointerId === v2drag.st.pid) { v2DragEnd(); renderV2(); } });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && v2drag.active) { v2DragEnd(); renderV2(); } });
$('v2groups').addEventListener('click', (e) => {
  const el = e.target.closest('.v2agent'); if (!el) return;
  if (v2drag.suppress) { e.preventDefault(); return; }
  v2Open(el.dataset.v2id);
});

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

/**
 * Sorting a group is a one-shot, and the same button reverses it — the way a
 * table column does. Which way "again" means is read off the order on screen
 * rather than remembered: if the group already reads A→Z, A→Z gives you Z→A.
 * That survives a reload, and it cannot disagree with what you are looking at.
 */
const SORT_LABEL = { name: 'A→Z', 'name-desc': 'Z→A', time: 'oldest first', 'time-desc': 'newest first', activity: 'quietest first', 'activity-desc': 'most recently active first' };

/** Is this section already in ascending order for `mode`? */
function sortedAscending(g, mode) {
  const mine = (agents ?? []).filter(a => v2Mine(a) && !a.ops && a.state !== 'ARCHIVED' && (a.group || '') === (g || ''));
  if (mine.length < 2) return false;
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const cmp = (x, y) => mode === 'time'
    ? String(x.createdAt || '').localeCompare(String(y.createdAt || ''))
    : mode === 'activity'
      ? (!x.lastActiveAt !== !y.lastActiveAt ? (x.lastActiveAt ? -1 : 1) : String(x.lastActiveAt || '').localeCompare(String(y.lastActiveAt || '')))
      : coll.compare(x.name, y.name);
  return mine.every((a, i) => i === 0 || cmp(mine[i - 1], a) <= 0);
}

async function sortGroup(g, mode = 'name') {
  const desc = sortedAscending(g, mode); // already that way? then the other way
  try {
    await api('/v1/groups/sort', { method: 'POST', body: { group: g, mode, desc } });
    toast(`${g || 'Default'} sorted ${SORT_LABEL[desc ? `${mode}-desc` : mode]}.`);
    await refresh(false);
  } catch (e) { toast(e.message); }
}

/** Rename a group where it stands: the name becomes editable; Enter saves, Escape puts it back. */
function editGroupName(el) {
  if (!el || el.isContentEditable) return;
  const from = el.textContent.trim();
  el.contentEditable = 'plaintext-only'; el.classList.add('editing');
  el.focus();
  const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range);
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    el.contentEditable = 'false'; el.classList.remove('editing');
    const to = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 48);
    if (!save || !to || to === from) { el.textContent = from; return; }
    try {
      await api('/v1/groups/rename', { method: 'POST', body: { from, to } });
      toast(`Group renamed to ${to}`);
      await refresh(false);
    } catch (e) { el.textContent = from; toast(e.message, 8000); }
  };
  el.onkeydown = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  };
  el.onblur = () => finish(true);
}

async function moveGroup(name, dir) {
  try {
    const r = await api('/v1/groups/move', { method: 'POST', body: { group: name, dir } });
    if (r && r.moved === false) {
      // Agents without a group always sit first, so the top named group cannot go above them.
      toast(dir === 'up' ? `"${name}" is already the top group — agents with no group always come first.` : `"${name}" is already the last group.`, 5000);
      return;
    }
    await refresh(false);
  } catch (e) { toast(e.message); }
}

// ---- the menu on an icon (HB-0683) --------------------------------------------------
// Right-click, the keyboard's menu key or Shift+F10, or on a touch screen a
// press held still and let go (held and moved, it drags, as before). It offers
// what the agent's page offers, through the same functions and so with the
// same questions: a rebuild of a running agent, Archive and Delete still ask.
// Only on the person's own agents, not the management agent's icon.
let v2MenuFor = null; // { id, back: the icon focus goes back to, items }
const v2MenuOk = (el, a) => !!a && !el.dataset.v2fixed && v2Mine(a) && !a.ops;
/** The menu's entries for this agent, by the rules its page's buttons follow (v2RenderSheetBar, v2Pane's overview). */
function v2MenuItems(a) {
  const id = a.id, n = a.name, run = a.state === 'RUNNING', built = !!a.runtimeRef;
  const items = [['Open', () => v2Open(id)], ['Settings', () => openV2Agent(id)]];
  if (a.state === 'ARCHIVED') items.push(['Restore…', () => restoreAgent(id, n)]);
  if (a.state === 'STOPPED' && a.hibernatedAt) items.push(['Wake', () => act(id, 'wake')]);
  if (a.state === 'STOPPED' && !a.hibernatedAt) items.push(['Start', () => act(id, 'start')]);
  if (a.state === 'FAILED') items.push(['Retry', () => act(id, 'provision')]);
  if (run) items.push(['Stop', () => act(id, 'stop')]);
  if ((run || a.state === 'STOPPED') && built) items.push(['Rebuild', () => rebuild(id)]);
  if (['RUNNING', 'STOPPED', 'FAILED'].includes(a.state) && !a.archiving) items.push(['Archive…', () => archiveAgent(id, n, a.state)]);
  items.push(['Delete…', () => del(id, n), 'v2menudanger']);
  return items;
}
/**
 * Opens the menu of the icon `el`: at the pointer `at` ({x, y}, a right-click), else under the
 * icon (over it where there is no room below), on the screen either way. Opened by the keyboard
 * (`byKey`), focus goes to its first entry; otherwise to the menu itself, where the arrow keys
 * still reach the entries, and no focus ring is drawn on an entry nobody chose.
 */
function v2OpenMenu(el, at, byKey) {
  const a = v2Find(el.dataset.v2id);
  if (!v2MenuOk(el, a)) return false;
  $('v2Tip').hidden = true;
  const m = $('v2Menu'), items = v2MenuItems(a);
  m.setAttribute('aria-label', `${a.name}: what to do`);
  m.innerHTML = `<div class="v2menuhead" aria-hidden="true">${esc(a.name)}</div>`
    + items.map(([label, , cls], i) => `<button type="button" role="menuitem" tabindex="-1" data-i="${i}"${cls ? ` class="${cls}"` : ''}>${esc(label)}</button>`).join('');
  v2MenuFor = { id: a.id, back: el, items };
  m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight, r = el.getBoundingClientRect();
  const x = at ? at.x : r.left + r.width / 2 - w / 2;
  const y = at ? (at.y + h <= innerHeight - 8 ? at.y : at.y - h) : (r.bottom + 4 + h <= innerHeight - 8 ? r.bottom + 4 : r.top - 4 - h);
  m.style.left = Math.max(8, Math.min(innerWidth - w - 8, x)) + 'px';
  m.style.top = Math.max(8, Math.min(innerHeight - h - 8, y)) + 'px';
  (byKey ? m.querySelector('button') : m)?.focus({ preventScroll: true });
  return true;
}
/** Closes it; `back`: focus returns to its icon (or that agent's icon, redrawn meanwhile). */
function v2CloseMenu(back) {
  const m = $('v2Menu');
  if (m.hidden) return;
  m.hidden = true;
  const f = v2MenuFor; v2MenuFor = null;
  if (!back || !f) return;
  const el = f.back.isConnected ? f.back : $('v2groups').querySelector(`.v2agent[data-v2id="${CSS.escape(f.id)}"]`);
  el?.focus({ preventScroll: true });
}
$('v2groups').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.v2agent'); if (!el) return;
  // A touch screen's long press: letting go decides (still: the menu; moved: the drag), not this.
  if (v2drag.st?.touch || e.pointerType === 'touch') { e.preventDefault(); return; }
  if (!v2MenuOk(el, v2Find(el.dataset.v2id))) return; // the browser's own menu, as before
  e.preventDefault();
  if (!$('v2Menu').hidden && v2MenuFor?.back === el) return; // opened by the key already (below)
  // From the keyboard a contextmenu has no pointer position: at the icon then.
  const kb = !e.clientX && !e.clientY;
  v2OpenMenu(el, kb ? undefined : { x: e.clientX, y: e.clientY }, kb);
});
$('v2groups').addEventListener('keydown', (e) => {
  if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return;
  const el = e.target.closest?.('.v2agent'); if (!el) return;
  if (v2OpenMenu(el, undefined, true)) e.preventDefault();
});
$('v2Menu').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]'); if (!b || !v2MenuFor) return;
  const run = v2MenuFor.items[Number(b.dataset.i)]?.[1];
  // Focus back on the icon first: a dialog the entry opens returns it there when it closes.
  v2CloseMenu(true);
  run?.();
});
$('v2Menu').addEventListener('keydown', (e) => {
  // From the menu itself (opened by a pointer, i = -1): ArrowDown to the first entry, ArrowUp to the last.
  const bs = [...$('v2Menu').querySelectorAll('button')], n = bs.length, i = bs.indexOf(document.activeElement);
  const to = { ArrowDown: (i + 1) % n, ArrowUp: i < 0 ? n - 1 : (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
  if (to !== undefined) { e.preventDefault(); bs[to]?.focus(); return; }
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); v2CloseMenu(true); }
});
$('v2Menu').addEventListener('contextmenu', (e) => e.preventDefault());
// A press anywhere else closes it (before that press does its own thing); so does the page moving under it.
document.addEventListener('pointerdown', (e) => { if (!$('v2Menu').hidden && !e.target.closest?.('#v2Menu')) v2CloseMenu(false); }, true);
window.addEventListener('scroll', () => v2CloseMenu(false), { passive: true });
window.addEventListener('resize', () => v2CloseMenu(false));

// ---- opening an agent: chat first ---------------------------------------------------
const v2CanChat = (a) => v2Mine(a) && a.state === 'RUNNING' && a.hasGateway;
function v2Open(id) {
  const a = v2Find(id); if (!a) return;
  $('v2Tip').hidden = true;
  if (!v2Mine(a)) return openV2Agent(id);
  // Something waiting on you (a token to paste, someone asking to join, a
  // failure) — the settings sheet is where you act on it, so start there.
  const st = v2Status(a);
  // Asleep: its tile says opening it wakes it, so opening it does — the
  // console wakes it first and says so ("Waking it up — about a minute…").
  // It used to open the settings sheet and wake nothing (2026-09-30).
  const asleep = a.hibernatedAt && a.state === 'STOPPED' && st.cls === 'stopped'; // not when something waits on you
  if (asleep && a.hasGateway && !a.opsDrift && window.isSecureContext) return openGateway(a.id, a.slug);
  if (asleep && !a.opsDrift) { // no console on plain http: wake it anyway, and show its settings
    toast(`Waking ${a.name} up — about a minute…`, 8000);
    api(`/v1/agents/${a.id}/wake`, { method: 'POST', body: {} }).then(() => refresh(false)).catch(e => toast(`Could not wake it: ${e.message}`, 10000));
  }
  if (st.cls === 'waiting' || a.state === 'FAILED' || a.opsDrift || !v2CanChat(a) || !window.isSecureContext) return openV2Agent(id, a.opsDrift ? 'advanced' : undefined);
  openGateway(a.id, a.slug);
}

// ---- the hub: the management bot at the centre --------------------------------------------

/**
 * The hub: this account's management agent. An OpenClaw agent that runs on
 * any AI source; it prepares changes and they wait in "Alerts".
 * Until one is set up, the hub offers to set it up (the older Claude-only chat
 * is retired).
 */

/**
 * The fleet at a glance, beside the manager: one tile per thing worth knowing,
 * in the icon language of the home screen. Every tile is a button to the screen
 * that does something about it — a number you cannot act on is decoration.
 */

function renderV2Stats() {
  const mine = (agents ?? []).filter(a => v2Mine(a) && !a.ops && a.state !== 'ARCHIVED');
  // The numbers row is gone (Chris, 2026-09-26: never acted on; a clean hub is
  // worth more). Everything it showed lives under Status, and what needs you
  // shows below the hub and under View by → Alerts. Only the Bulk actions
  // button's visibility is still decided here.
  if ($('v2BulkBtn')) $('v2BulkBtn').hidden = mine.length < 2;
}

function v2RenderHub() {
  const ops = agents.find(a => a.ops && v2Mine(a) && a.state !== 'ARCHIVED');
  const hub = document.querySelector('.v2hub');
  hub.classList.toggle('hub-ops', !!ops);
  hub.classList.toggle('hub-unknown', !ops && !agentsLoaded);
  hub.hidden = !!ops || !agentsLoaded; // with a manager, the grid holds it and the header holds the buttons
  const box = $('v2OpsBox');
  // Before the first agent list arrives there is nothing to say: offering to
  // set up an agent that already exists, then replacing it a moment later,
  // reads as a glitch.
  if (!ops && !agentsLoaded) { box.hidden = true; return; }
  let html;
  if (ops) {
    // No buttons of its own: it is an agent like the others, only bigger.
    // Click it to talk; if it needs you, the click opens its settings instead.
    const say = ops.opsDrift ? `<b style="color:var(--bad)">Paused:</b> its safety settings were changed (${esc(ops.opsDrift)}). Click it and Rebuild to restore them.`
      : ops.state === 'FAILED' ? `It didn't start${ops.stateReason ? ': ' + esc(ops.stateReason) : '.'} Click it to retry.`
      : ops.state === 'PROVISIONING' ? 'Setting up — about a minute.'
      : ops.state === 'STOPPED' ? 'Stopped. Click it to start it again.'
      : ''; // healthy: the icon says it all — no caption
    const thin = (agents ?? []).filter(a => v2Mine(a) && !a.ops && a.state !== 'ARCHIVED').length < 3;
    html = (say ? `<div class="sub">${say}</div>` : '')
      + (thin && ops.state === 'RUNNING' && !ops.opsDrift
        ? `<div class="sub" style="margin-top:4px">Not sure what to add?
             <a href="#" ${onAction('click', 'askOpsSuggest', [{ $: 'el' }], 'prevent')}>Ask it what you're missing</a>.</div>`
        : '');
  } else {
    html = `<div class="v2opsrow"><span class="sub" style="flex:1;min-width:220px"><b>Set up your Hatchabot agent.</b> A manager for your agents that you can talk to: it works with whichever AI source you have, remembers how you like things run, and asks before it changes anything.</span>
      <button class="primary" id="v2OpsSetup" ${onAction('click', 'v2SetupOps', [{ $: 'el' }])} ${profiles.length ? '' : 'disabled title="Add an AI source first (Settings → AI)"'}>Set it up</button></div>`;
  }
  if (box.__html !== html) { box.innerHTML = html; box.__html = html; }
  box.hidden = false;
  renderV2Stats();
  // Its icon IS an agent icon: same markup and classes as the grid's, so the
  // ring, badge, tooltip and click all behave identically. Only the size differs.
  const face = hub.querySelector('.v2face');
  const st = ops && v2Status(ops);
  const faceHtml = ops
    ? `<button class="v2agent v2hubagent v2st-${st.cls}" data-v2id="${esc(ops.id)}" data-v2fixed="1" ${onAction('click', 'v2Open', [`${ops.id ?? ''}`])}
         aria-label="${esc(ops.name)} — ${esc(st.label)}${v2Unread(ops) ? ', new messages' : ''}">${v2IconHTML(ops, st)}<span class="v2name">${esc(ops.name)}</span></button>`
    : '🐣';
  if (face.__html !== faceHtml) {
    face.__html = faceHtml;
    face.className = `v2face${ops ? ' live' : ''}`;
    face.innerHTML = faceHtml;
    if (ops) face.removeAttribute('aria-hidden'); else face.setAttribute('aria-hidden', 'true');
  }
}
/**
 * "What should I add?" — the hardest question a new owner has, handed to the
 * one thing that can answer it from evidence. It asks in its own console; what
 * it proposes arrives as ordinary cards.
 */
async function askOpsSuggest(el) {
  const person = pagePerson, epoch = voiceEpoch;
  const current = () => person === pagePerson && epoch === voiceEpoch && !pagePersonAway && !pageSignedOut;
  if (el) { el.dataset.busy = '1'; el.textContent = 'Asking…'; }
  // It is a real turn on a real model — half a minute is normal, and a silent
  // button for that long reads as broken.
  toast('Asking your Hatchabot agent — it reads your fleet first, so give it about half a minute.', 8000);
  try {
    const r = await api('/v1/ops-agent/suggest', { method: 'POST', body: {} });
    if (!current()) return;
    if (pageSecondFactorBusy()) {
      toast('The suggestions are ready in your Hatchabot agent’s console. Finish signing in, then open it.', 8000);
      return;
    }
    v2Close();
    openGateway(r.agentId, r.slug);
  } catch (e) { if (current()) toast(e.message, 9000); }
  finally { if (el) { delete el.dataset.busy; el.textContent = "Ask Hatchabot what you're missing"; } }
}

async function v2SetupOps(btn) {
  btn.disabled = true; btn.textContent = 'Setting up…';
  try {
    await api('/v1/ops-agent', { method: 'POST', body: {} });
    toast('Setting up your Hatchabot agent — about a minute.', 6000);
    await refresh(false);
  } catch (e) { toast(e.message, 9000); btn.disabled = false; btn.textContent = 'Set it up'; }
}
