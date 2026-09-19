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
    A('To Do', 'Household', '☑️', '#3a8fd0'),
    A('Garden Notes', 'Household', '🌱', '#3aa36b', { webOnly: true, botUsername: undefined, deepLink: undefined }),
    A('Car Upkeep', 'Money', '🚗', '#d05a5a'),
    A('Hatchabot', '', '🐣', '#e0a13a', { ops: true, slug: 'hatchabot', webOnly: true, botUsername: undefined, deepLink: undefined }),
  ];
  const PROFILE = { id: 'p1', name: 'Claude Max (household)', vendor: 'anthropic', kind: 'subscription', mine: true,
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
  const R = {
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
    '/v1/runtime': { imageVersion: '2026.7.1-2', npmLatest: '2026.9.4', upgradeAvailable: true, upgradeBuildable: false },
    '/v1/runtime/build': { running: false },
    '/v1/media-key': { set: false },
    '/v1/search-key': { set: true },
    '/v1/connections': { connections: [] },
    '/v1/backups': { sets: [] },
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
  { file: 'screenshot-usage.png', width: 1400, height: 620, open: "openAiDlg('ai')" },
  { file: 'screenshot-agent.png', width: 1400, height: 800, open: "openV2Agent('a2','overview')" },
];
