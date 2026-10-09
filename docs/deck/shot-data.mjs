/**
 * Invented household fleet for the screenshots on hatchabot.com and in the
 * deck. No real names, tokens, agents or usage figures — the shots are the
 * real web/index.html driven by this stubbed `window.fetch`.
 *
 * Regenerate with: node scripts/screenshots.mjs
 */
export const STUB = `(() => {
  window.HATCHABOT_VERSION = '__VERSION__';
  const now = new Date().toISOString();
  // Set by scripts/screenshots.mjs only: the pictures also show weekly cost
  // chips and one agent stuck in a loop. The click-through (which shares this
  // stub) sets its own costs and incidents per scenario, so it gets neither.
  const SHOT = !!window.__HB_SHOT;
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  let n = 0;
  const A = (name, group, icon, color, extra = {}) => ({
    id: 'a' + (++n), name, group, icon, iconColor: color,
    slug: name.toLowerCase().replace(/\\W+/g, '-'), state: 'RUNNING', role: 'owner',
    ownerId: 'o1', aiProfileId: 'p1', hostId: 'h1', model: 'claude-sonnet-5',
    createdAt: now, updatedAt: now, runtimeRef: 'docker://x', hasGateway: true,
    botUsername: name.replace(/\\W+/g, '') + 'Bot', botDisplayName: name,
    deepLink: 'https://t.me/x', sharedMemory: true, otherChannels: [],
    persona: 'Helps with ' + name.toLowerCase() + '.', dataSources: [], envVars: [], ...extra,
  });
  const AGENTS = [
    A('Homework Helper', 'Family', '🎓', '#5a7fd6'),
    A('Soccer Schedule', 'Family', '⚽', '#3aa36b', { otherChannels: [{ kind: 'discord', displayName: '@soccer in Rivergate FC' }] }),
    A('Piano Practice', 'Family', '🎵', '#8a6fd0', { webOnly: true, botUsername: undefined, deepLink: undefined }),
    A('Meal Planner', 'Household', '🥗', '#3aa36b'),
    A('Grocery Runner', 'Household', '🛒', '#e0a13a', { state: 'REBUILDING' }),
    A('Home Maintenance', 'Household', '🔧', '#7a8a9a'),
    A('Travel Planner', 'Household', '🧭', '#d0703a', { otherChannels: [{ kind: 'slack', displayName: '@travel in Family HQ' }] }),
    A('Budget Tracker', 'Money', '💰', '#c9b03a'),
    A('Stock Watcher', 'Money', '📈', '#2f9e8f'),
    A('Tax Filing', 'Money', '🧾', '#d05a5a', { state: 'STOPPED' }),
    A('To Do', 'Household', '☑️', '#3a8fd0', !SHOT ? {} : { stuck: [{ id: 'i1', signal: 'task-failing', text: 'Stuck: the morning reminder task failed 3 runs in a row', fix: 'ask your Hatchabot agent to look at it' }] }),
    A('Garden Notes', 'Household', '🌱', '#3aa36b', { webOnly: true, botUsername: undefined, deepLink: undefined }),
    A('Car Upkeep', 'Money', '🚗', '#d05a5a'),
    A('Hatchabot', '', '🐣', '#e0a13a', { ops: true, slug: 'hatchabot', webOnly: true, botUsername: undefined, deepLink: undefined }),
  ];
  const PROFILE = { id: 'p1', name: 'Anthropic API (household)', vendor: 'anthropic', kind: 'api_key', credential: 'api-key', mine: true,
    ownerId: 'o1', model: 'claude-sonnet-5', models: [], shared: true, defaultSource: true };
  // 168 hourly buckets (a week), oldest first — the shape /v1/ai-profiles/usage returns.
  const shape = [0,0,1,2,5,9,12,14,13,10,7,5,3,2,1,1,0,0,1,3,6,10,13,14,12,9,6,4,2,1,1,0];
  const hourly = Array.from({ length: 168 }, (_, i) => {
    const at = new Date(Date.now() - (167 - i) * 3600000);
    const ok = Math.max(0, Math.round(shape[i % shape.length] * (1 + ((i * 7) % 5) / 10)));
    return { hour: at.toISOString().slice(0, 13), ok, limited: i === 119 ? 3 : 0 };
  });
  const USAGE = { sampledAt: now, sampling: false, sources: [{
    id: 'p1', name: PROFILE.name, agents: 15, status: 'ok',
    lastOkAt: ago(3), lastLimitAt: ago(1180), limitHits7d: 4, tokensSince: ago(60 * 24 * 7),
    window5h: { requests: 214, limited: 0, failed: 0, tokens: 1_900_000 },
    window7d: { requests: 1_900, limited: 4, failed: 0, tokens: 25_000_000 },
    topAgents: [
      { name: 'Meal Planner', requests: 486, tokens: 6_100_000, limited: 0 },
      { name: 'Budget Tracker', requests: 402, tokens: 5_200_000, limited: 0 },
      { name: 'Homework Helper', requests: 351, tokens: 4_400_000, limited: 2 },
      { name: 'Stock Watcher', requests: 288, tokens: 3_600_000, limited: 0 },
      { name: 'Grocery Runner', requests: 174, tokens: 2_100_000, limited: 0 },
    ],
    hourly,
    others: { agents: 3, requests5h: 46, requests7d: 388 },
  }] };
  // A week at API prices per agent — the shape /v1/costs returns. Made-up figures.
  const c = (weekly, extra = {}) => ({ cost: weekly, weekly, monthly: Math.round(weekly * 30 / 7 * 100) / 100,
    tier: weekly >= 100 ? 4 : weekly >= 50 ? 3 : weekly >= 10 ? 2 : 1, priced: true, ...extra });
  const COSTS = { days: 7, at: now, bands: [10, 50, 100], agents: {
    a1: c(6), a2: c(2), a3: c(0.5), a4: c(9), a5: c(4), a6: c(0.3), a7: c(12),
    a8: c(18), a9: { ...c(0), tier: 1, local: true }, a10: { ...c(0), tier: 0 }, a11: c(3), a12: c(0.4), a13: c(1.5), a14: c(5),
  } };
  // Usage (GET /v1/usage/periods and /v1/usage/spend): a week in 3-hour slices at
  // API prices, a day of requests, by part, by model and by agent. Made-up figures.
  const named = AGENTS.filter((a) => !a.ops);
  const weekly = { a1: 6, a2: 2, a3: 0.5, a4: 9, a5: 4, a6: 0.3, a7: 12, a8: 18, a10: 0, a11: 3, a12: 0.4, a13: 1.5 };
  const wave = (i) => 0.35 + 0.65 * Math.max(0, Math.sin(((i % 8) - 1.5) / 8 * Math.PI * 2)) * (1 + ((i * 5) % 7) / 14);
  const slices = Array.from({ length: 56 }, (_, i) => {
    const k = wave(i) * 1.02;
    return { at: new Date(Date.now() - (55 - i) * 3 * 3600000).toISOString(), input: Math.round(k * 0.031 * 1e4) / 1e4,
      cacheWrite: Math.round(k * 0.24 * 1e4) / 1e4, cacheRead: Math.round(k * 0.52 * 1e4) / 1e4, output: Math.round(k * 0.34 * 1e4) / 1e4,
      tokens: Math.round(k * 410000), ...(i === 38 ? { refused: 3 } : {}) };
  });
  const sum = (k) => Math.round(slices.reduce((t, b) => t + b[k], 0) * 100) / 100;
  const SPEND = { range: 'week', bucketHours: 3, buckets: slices,
    totals: { input: sum('input'), cacheWrite: sum('cacheWrite'), cacheRead: sum('cacheRead'), output: sum('output'),
      cost: Math.round((sum('input') + sum('cacheWrite') + sum('cacheRead') + sum('output')) * 100) / 100, tokens: slices.reduce((t, b) => t + b.tokens, 0) },
    planShare: 0, refused: 3, monthly: 0, models: [],
    choices: named.map((a) => ({ id: a.id, name: a.name, cost: weekly[a.id] ?? 0 })).sort((x, y) => y.cost - x.cost) };
  SPEND.monthly = Math.round(SPEND.totals.cost * 720 / 168 * 100) / 100;
  // By model: shares of the same total, so the pie adds up.
  SPEND.models = [['claude-sonnet-5', 0.71], ['claude-haiku-4-5', 0.17], ['claude-opus-4-8', 0.12]]
    .map(([model, f]) => ({ model, cost: Math.round(SPEND.totals.cost * f * 100) / 100 }));
  const dayHours = Array.from({ length: 24 }, (_, i) => ({ at: new Date(Date.now() - (23 - i) * 3600000).toISOString(),
    tokens: Math.round(wave(i) * 140000), requests: Math.round(wave(i) * 12), limited: 0 }));
  const PERIODS = { period: 'day', from: ago(1440), to: now, bucketMinutes: 60, buckets: dayHours,
    agents: named.map((a) => ({ id: a.id, name: a.name, state: a.state, tokens: Math.round((weekly[a.id] ?? 0) * 60000), requests: Math.round((weekly[a.id] ?? 0) * 6),
      limited: 0, failed: 0, billing: 'api', profileName: PROFILE.name, model: a.model, cost: null })),
    totals: { tokens: dayHours.reduce((t, b) => t + b.tokens, 0), requests: dayHours.reduce((t, b) => t + b.requests, 0), limited: 0, failed: 0 },
    byBilling: { included: 0, api: dayHours.reduce((t, b) => t + b.tokens, 0), local: 0 }, cost: null, sampledAt: now, alerts: [],
    rightSize: { line: 'Saved by cheaper models this month: about $11 at API prices', savingUSD: 11.2, apiUSD: 11.2, planUSD: 0, month: now.slice(0, 7), rows: [] },
    pricing: { hours: 24, total: 8.1, monthly: 243, parts: { input: 0.25, cacheWrite: 1.9, cacheRead: 4.1, output: 1.85 }, billing: { api: 8.1, plan: 0 },
      models: SPEND.models.map((m) => ({ model: m.model, cost: Math.round(m.cost / 7 * 100) / 100 })),
      agents: Object.fromEntries(named.map((a) => [a.id, { cost: Math.round((weekly[a.id] ?? 0) / 7 * 100) / 100, parts: {} }])) } };
  const R = {
    ...(SHOT ? { '/v1/costs': COSTS, '/v1/usage/spend': SPEND, '/v1/usage/periods': PERIODS } : {}),
    '/v1/config': { authMode: 'identity', localAccounts: false, maxAgentsPerAccount: 50 },
    '/v1/agents': AGENTS,
    '/v1/ai-profiles': [PROFILE],
    '/v1/ai-profiles/usage': USAGE,
    '/v1/hosts': [{ id: 'h1', name: 'This machine', hostname: 'home-server', kind: 'local', online: true, status: 'online' }],
    '/v1/pool': { availableBots: 3, bots: [] },
    '/v1/inbox': { shares: [] },
    '/v1/events': [
      { at: ago(4), agentName: 'Meal Planner', event: 'agent.online', text: 'came online' },
      { at: ago(26), agentName: 'Homework Helper', event: 'member.admitted', text: 'let someone in' },
      { at: ago(48), agentName: 'Budget Tracker', event: 'snapshot.saved', text: 'snapshot saved' },
      { at: ago(120), agentName: 'Grocery Runner', event: 'agent.rebuilt', text: 'rebuilt' },
      { at: ago(140), agentName: 'Stock Watcher', event: 'member.linked', text: 'owner linked on Telegram' },
    ],
    '/v1/account': { ownerId: 'o1', email: 'you@example.com', hostOwner: true },
    '/v1/me': { ownerId: 'o1', hostOwner: true },
    '/v1/mgmt/status': { running: true },
    '/v1/agent-todos': { todos: [] },
    '/v1/proposals': { pending: [] },
    '/v1/ops-agent': { agent: AGENTS[AGENTS.length - 1] },
    '/v1/mgmt/chat': { available: true, llm: { model: 'claude-sonnet-5', profileName: PROFILE.name }, mode: 'read-only', transcript: [] },
    '/v1/runtime': { imageVersion: '2026.7.1-2', npmLatest: '2026.9.4', upgradeAvailable: true, upgradeBuildable: false, upgradeNeedsSharedEmbedder: true },
    '/v1/runtime/build': { running: false },
    '/v1/media-key': { set: false },
    '/v1/search-key': { set: true },
    '/v1/connections': { connections: [] },
    // A healthy machine: last night's complete set. (The old { sets: [] } read
    // as "no backups yet" and put the manager under Alerts whenever the page
    // reloaded the machine's status mid-run, 2026-10-09.)
    '/v1/backups': { backups: [{ date: now.slice(0, 10), hasKey: true, complete: true }], keepDays: 14, missing: [] },
    '/v1/security': { checks: [] },
  };
  window.fetch = async (input) => {
    const path = String(typeof input === 'string' ? input : input.url).split('?')[0];
    let body = R[path];
    if (body === undefined) {
      body = /\\/pairing$/.test(path) ? [] : /\\/members$/.test(path) ? [] : /\\/crons$/.test(path) ? []
        : /\\/peers$/.test(path) ? { peers: [], candidates: [] } : /\\/snapshots$/.test(path) ? [] : {};
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
})();`;

/** One entry per image: where it goes, the viewport, and what to open. */
export const SHOTS = [
  { file: 'screenshot.png', width: 1500, height: 900, open: null },
  { file: 'screenshot-usage.png', width: 900, height: 860, open: "openFleetUsage()" },
  { file: 'screenshot-agent.png', width: 1400, height: 800, open: "openV2Agent('a2','overview')" },
  { file: 'screenshot-cost.png', width: 1500, height: 900, open: "v2SetView('cost')" },
];
