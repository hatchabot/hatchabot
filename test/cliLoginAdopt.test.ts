import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HANDOVER_POST_BOUND_MS, botOf, gatewayRestartCommand, noAnswer, otherBotLine, tokenTurnedDown } from '../src/cli.js';

/**
 * The deep audit of v2.177.0 (2026-11-07): what `hatchabot login` saves, and
 * how `hatchabot adopt` ends when it cannot finish. The real CLI runs in a
 * child process against a made-up server (test/support/cliFetchFixture.mjs
 * answers fetch and refuses anything else), with a temporary HOME and a PATH
 * holding nothing.
 */

const sandbox = mkdtempSync(join(tmpdir(), 'hb-cli-login-'));
const emptyPath = mkdtempSync(join(sandbox, 'bin-'));
const work = mkdtempSync(join(sandbox, 'work-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

interface Route { path: string; method?: string; status?: number; reply?: unknown; replies?: Array<{ status?: number; reply?: unknown; reject?: string }> }
interface Seen { path: string; method: string; body?: any; origin: string; search?: string; authorization?: string; at?: number }

function newHome(config?: string): { home: string; config: string } {
  const home = mkdtempSync(join(sandbox, 'home-'));
  const file = join(home, '.config', 'hatchabot', 'env');
  mkdirSync(join(home, '.config', 'hatchabot'), { recursive: true });
  if (config !== undefined) writeFileSync(file, config, { mode: 0o600 });
  return { home, config: file };
}

function cli(home: string, routes: Route[], args: string[], env: Record<string, string> = {}, input = '', timeout = 30_000) {
  const r = spawnSync(process.execPath, ['--import', './test/support/cliFetchFixture.mjs', '--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: resolve('.'), encoding: 'utf8', timeout, input,
    env: { HOME: home, PATH: emptyPath, HATCHABOT_CWD: work, HB_CLI_FIXTURE: JSON.stringify(routes), ...env },
  });
  expect(r.error).toBeUndefined();
  const requests: Seen[] = r.stdout.split('\n').filter((l) => l.startsWith('FIXTURE_REQUEST ')).map((l) => JSON.parse(l.slice('FIXTURE_REQUEST '.length)));
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, requests };
}

const accounts: Route = { path: '/v1/config', reply: { authMode: 'accounts' } };
const identity: Route = { path: '/v1/config', reply: { authMode: 'identity', identity: { apiKey: 'made-up-key' } } };
const list: Route = { path: '/v1/agents', method: 'GET', reply: [] };

describe('login saves the server it signed in to (HB-0539)', () => {
  it('a server chosen with HATCHABOT_URL is saved with its token, so later commands go there', () => {
    const { home, config } = newHome('HATCHABOT_URL=https://server-a.example.org\n');
    const r = cli(home, [accounts, list], ['login', '--token', 'hatchabot_made-up-value'], { HATCHABOT_URL: 'https://server-b.example.org' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.find((x) => x.path === '/v1/agents')?.origin).toBe('https://server-b.example.org');
    expect(readFileSync(config, 'utf8')).toBe('HATCHABOT_TOKEN=hatchabot_made-up-value\nHATCHABOT_URL=https://server-b.example.org\n');

    const later = cli(home, [accounts, list], ['list']);
    expect(later.status, later.stderr).toBe(0);
    const sent = later.requests.filter((x) => x.authorization === 'Bearer hatchabot_made-up-value');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((x) => x.origin === 'https://server-b.example.org')).toBe(true);
  }, 60_000);

  it('a login to the server already saved, or to the default, writes no URL of its own', () => {
    const { home, config } = newHome('HATCHABOT_URL=https://server-a.example.org\n');
    expect(cli(home, [accounts, list], ['login', '--token', 'hatchabot_made-up-value']).status).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe('HATCHABOT_URL=https://server-a.example.org\nHATCHABOT_TOKEN=hatchabot_made-up-value\n');
    const fresh = newHome();
    expect(cli(fresh.home, [accounts, list], ['login', '--token', 'hatchabot_made-up-value']).status).toBe(0);
    expect(readFileSync(fresh.config, 'utf8')).toBe('HATCHABOT_TOKEN=hatchabot_made-up-value\n');
  }, 60_000);
});

describe('a token login with another token in the environment says so (thirteenth review)', () => {
  it('HATCHABOT_TOKEN set to another token: the note, as the email sign-in gives it', () => {
    const r = cli(newHome().home, [accounts, list], ['login', '--token', 'hatchabot_made-up-value'], { HATCHABOT_TOKEN: 'hatchabot_made-up-other' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/note: HATCHABOT_TOKEN is set in your environment, and it is used before this sign-in — unset it\./);
    const same = cli(newHome().home, [accounts, list], ['login', '--token', 'hatchabot_made-up-value'], { HATCHABOT_TOKEN: 'hatchabot_made-up-value' });
    expect(same.status, same.stderr).toBe(0);
    expect(same.stderr).not.toMatch(/HATCHABOT_TOKEN is set/);
  }, 60_000);
});

describe('an email sign-in replaces the saved access token (HB-0541)', () => {
  const signIn: Route = { path: '/v1/accounts:signInWithPassword', method: 'POST', reply: { refreshToken: 'made-up-refresh', email: 'member@example.org' } };
  const exchange: Route = { path: '/v1/token', method: 'POST', reply: { id_token: 'made-up-id-value' } };

  it('later commands use the new sign-in, not the old token', () => {
    const { home, config } = newHome('HATCHABOT_URL=https://identity.example.org\nHATCHABOT_TOKEN=hatchabot_old-made-up-value\n');
    const r = cli(home, [identity, signIn], ['login', '--email', 'member@example.org'], {}, 'made-up-password\n');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe('HATCHABOT_URL=https://identity.example.org\nHATCHABOT_REFRESH_TOKEN=made-up-refresh\n');

    const later = cli(home, [identity, exchange, list], ['list']);
    expect(later.status, later.stderr).toBe(0);
    expect(later.requests.find((x) => x.path === '/v1/agents')?.authorization).toBe('Bearer made-up-id-value');
    expect(later.requests.some((x) => x.authorization === 'Bearer hatchabot_old-made-up-value')).toBe(false);
  }, 60_000);

  // Eighth review: a pre-rename AGENTCLAW_ line in the current file is read as the same key.
  it('an old AGENTCLAW_TOKEN line in the config file does not win over an email sign-in', () => {
    const { home, config } = newHome('HATCHABOT_URL=https://identity.example.org\nAGENTCLAW_TOKEN=hatchabot_old-made-up-value\n');
    const r = cli(home, [identity, signIn], ['login', '--email', 'member@example.org'], {}, 'made-up-password\n');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe('HATCHABOT_URL=https://identity.example.org\nHATCHABOT_REFRESH_TOKEN=made-up-refresh\n');
    const later = cli(home, [identity, exchange, list], ['list']);
    expect(later.status, later.stderr).toBe(0);
    expect(later.requests.find((x) => x.path === '/v1/agents')?.authorization).toBe('Bearer made-up-id-value');
  }, 60_000);

  it('a token login takes out the refresh token; one in the pre-rename file is blanked', () => {
    const { home, config } = newHome('HATCHABOT_REFRESH_TOKEN=made-up-refresh\n');
    mkdirSync(join(home, '.config', 'agentclaw'), { recursive: true });
    writeFileSync(join(home, '.config', 'agentclaw', 'env'), 'AGENTCLAW_REFRESH_TOKEN=made-up-older-refresh\n', { mode: 0o600 });
    expect(cli(home, [accounts, list], ['login', '--token', 'hatchabot_made-up-value']).status).toBe(0);
    expect(readFileSync(config, 'utf8')).toBe('HATCHABOT_TOKEN=hatchabot_made-up-value\nHATCHABOT_REFRESH_TOKEN=\n');
  }, 60_000);
});

describe('adopt (HB-0542, HB-0543, HB-0544)', () => {
  const agent = { id: 'agent-0001-test', name: 'Kitchen Helper', slug: 'kitchen-helper', state: 'RUNNING' };
  const waiting = { ...agent, state: 'PROVISIONING', pendingAction: { type: 'bot_token', instructions: 'made-up' } };
  // After a token is taken the server clears the step: setup runs, however long.
  const setting = { ...agent, state: 'PROVISIONING' };
  // `key`: the bot's account key in the workspace's OpenClaw config, which may be any name.
  const base = (bot: boolean, key = 'made_up_old_bot'): Route[] => [
    accounts,
    { path: '/v1/workspaces/inspect', method: 'POST', reply: { path: '/made-up/workspace', markdownFiles: [], files: [], bytes: 0, ...(bot ? { existingBot: { accountId: key, sourceAgentId: 'source-test', enabledInSource: false, polling: 'idle' } } : {}) } },
    { path: '/v1/ai-profiles', reply: [{ id: 'profile-test', name: 'test', mine: true }] },
    { path: '/v1/hosts', reply: [{ id: 'host-test', kind: 'local' }] },
    { path: '/v1/agents', method: 'POST', reply: agent },
    { path: `/v1/agents/${agent.id}/adopt-workspace`, method: 'POST', reply: { files: 0, bytes: 0 } },
    { path: `/v1/agents/${agent.id}`, method: 'DELETE', reply: {} },
  ];
  const env = { HATCHABOT_URL: 'http://fixture.invalid', HATCHABOT_TOKEN: 'fixture-cli-value' };
  const run = (routes: Route[], args: string[]) => cli(newHome().home, routes, ['adopt', '/made-up/workspace', 'Kitchen Helper', ...args], env);

  it('--reuse-bot asks for no pool bot and hands over the old bot before adopting', () => {
    const r = run([...base(true), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: agent }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_old_bot' } }], ['--reuse-bot']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.find((x) => x.path === '/v1/agents' && x.method === 'POST')?.body.skipPool).toBe(true);
    const handOver = r.requests.findIndex((x) => x.path.endsWith('/channel-token'));
    expect(r.requests[handOver]?.body).toEqual({ fromWorkspace: '/made-up/workspace' });
    expect(r.requests.findIndex((x) => x.path.endsWith('/adopt-workspace'))).toBeGreaterThan(handOver);
    expect(r.stdout).toMatch(/took over @made_up_old_bot/);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
  }, 60_000);

  // HB-1475: an adopt into an agent that is not running (or busy just then)
  // puts its scheduled tasks off until it runs; the CLI said nothing of them.
  it('says how many scheduled tasks will be carried once it is running, after "adopted N files", and nothing when none were put off', () => {
    const adoptAnswer = (crons: Record<string, number>) => base(false).map((x) => (x.path.endsWith('/adopt-workspace')
      ? { ...x, reply: { files: 3, bytes: 2048, crons } } : x));
    const read: Route = { path: `/v1/agents/${agent.id}`, method: 'GET', reply: agent };
    for (const [n, line] of [[2, 'adopted 3 files (0.0 MB) into "Kitchen Helper". 2 scheduled tasks will be carried, disabled, once it is running.'],
      [1, 'adopted 3 files (0.0 MB) into "Kitchen Helper". 1 scheduled task will be carried, disabled, once it is running.']] as const) {
      const r = run([...adoptAnswer({ total: n, carried: 0, failed: 0, deferred: n }), read], ['--no-telegram']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.split('\n')).toContain(line);
    }
    const now = run([...adoptAnswer({ total: 2, carried: 2, failed: 0 }), read], ['--no-telegram']);
    expect(now.status, now.stderr).toBe(0);
    expect(now.stdout.split('\n')).toContain('adopted 3 files (0.0 MB) into "Kitchen Helper".');
  }, 120_000);

  // HB-1200: a task carried before and edited in the old workspace since is
  // not brought again; the CLI says how many, after "adopted N files".
  it('says how many tasks changed in the old workspace since they were carried, after "adopted N files"', () => {
    const read: Route = { path: `/v1/agents/${agent.id}`, method: 'GET', reply: agent };
    for (const [n, line] of [[2, 'adopted 3 files (0.0 MB) into "Kitchen Helper". 2 tasks changed in the old workspace since they were carried — not brought.'],
      [1, 'adopted 3 files (0.0 MB) into "Kitchen Helper". 1 task changed in the old workspace since it was carried — not brought.']] as const) {
      const r = run([...base(false).map((x) => (x.path.endsWith('/adopt-workspace') ? { ...x, reply: { files: 3, bytes: 2048, crons: { total: 2, carried: 2, failed: 0, changed: n } } } : x)), read], ['--no-telegram']);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.split('\n')).toContain(line);
    }
  }, 120_000);

  it('--reuse-bot of a bot whose account is still on, with Telegram off for the whole instance, says the account must go off too, and makes nothing (HB-1031)', () => {
    const live = { accountId: 'made_up_old_bot', sourceAgentId: 'source-test', enabledInSource: true, channelOffInSource: true, polling: 'idle' };
    const routes = base(true).map((x) => (x.path === '/v1/workspaces/inspect'
      ? { ...x, reply: { path: '/made-up/workspace', markdownFiles: [], files: [], bytes: 0, existingBot: live } } : x));
    const r = run(routes, ['--reuse-bot']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Telegram is switched off in your hand-built instance\'s config, but its account "made_up_old_bot"');
    expect(r.stderr).toContain('openclaw config set channels.telegram.accounts.made_up_old_bot.enabled false');
    expect(r.stderr).not.toContain('systemctl');
    expect(r.requests.some((x) => x.path === '/v1/agents' && x.method === 'POST')).toBe(false);
  }, 60_000);

  it('--reuse-bot refused: the command that switches the account off is printed only for a key a shell takes as it is, else the change in words (HB-1031)', () => {
    const refusal = (bot: Record<string, unknown>) => run(base(true).map((x) => (x.path === '/v1/workspaces/inspect'
      ? { ...x, reply: { path: '/made-up/workspace', markdownFiles: [], files: [], bytes: 0, existingBot: { sourceAgentId: 'source-test', polling: 'idle', ...bot } } } : x)), ['--reuse-bot']);
    // A key edited by hand, with a space, a quote, a ; and a $( ): pasted as a command, it breaks or runs something.
    const odd = 'old bot";$(true)';
    for (const bot of [
      { accountId: odd, enabledInSource: true, channelOffInSource: true }, // Telegram off there, the account on
      { accountId: odd, enabledInSource: true, channelOffInSource: false }, // still live
    ]) {
      const r = refusal(bot);
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toContain('openclaw config set');
      expect(r.stderr).toContain(`under channels.telegram.accounts, set "enabled": false on the account ${JSON.stringify(odd)}`);
      expect(r.requests.some((x) => x.path === '/v1/agents' && x.method === 'POST')).toBe(false);
    }
    // A plain key: the command, in both.
    for (const channelOffInSource of [true, false]) {
      expect(refusal({ accountId: 'made_up_old_bot', enabledInSource: true, channelOffInSource }).stderr)
        .toContain('  openclaw config set channels.telegram.accounts.made_up_old_bot.enabled false\n');
    }
  }, 60_000);

  // The third review: the pasted-token path had the same early look.
  it('a pasted token: adopt waits for setup to take it up before copying the workspace', () => {
    const r = cli(newHome().home, [...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: agent }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot' } }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.status, r.stderr).toBe(0);
    const looks = r.requests.map((x, i) => (x.method === 'GET' && x.path === `/v1/agents/${agent.id}` ? i : -1)).filter((i) => i >= 0);
    expect(looks.length).toBe(3);
    expect(r.requests.findIndex((x) => x.path.endsWith('/adopt-workspace'))).toBeGreaterThan(looks[2]!);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
  }, 60_000);

  // A newer CLI against an older server, whose step shows until setup takes
  // the token, a moment later: the first look after a token waits that long.
  it('an older server: the first look after a token comes once setup has taken it, for adopt and create', () => {
    const old = { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: agent }] } as Route;
    const r = cli(newHome().home, [...base(false), old,
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot' } }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
    const reuse = run([...base(true), old,
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_old_bot' } }], ['--reuse-bot']);
    expect(reuse.status, reuse.stderr).toBe(0);
    const made = cli(newHome().home, [accounts,
      { path: '/v1/ai-profiles', reply: [{ id: 'profile-test', name: 'test', mine: true }] },
      { path: '/v1/hosts', reply: [{ id: 'host-test', kind: 'local' }] },
      { path: '/v1/agents', method: 'POST', reply: agent }, old,
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot' } }],
    ['create', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(made.status, made.stderr).toBe(0);
    expect(made.stdout).toMatch(/"Kitchen Helper" is RUNNING\./);
  }, 60_000);

  it('a pasted token setup turns down: adopt says it is waiting, removes the agent and copies nothing', () => {
    // The step seen after the token is setup asking again: said at once, not
    // after a 30-second guess (fifth review).
    const started = Date.now();
    const r = cli(newHome().home, [...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: waiting },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot', stepAnswered: true } }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/"Kitchen Helper" is PROVISIONING and waiting on you/);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(false);
    expect(r.requests.some((x) => x.method === 'DELETE' && x.path === `/v1/agents/${agent.id}`)).toBe(true);
    expect(r.stderr).toMatch(/was cleaned up/);
  }, 60_000);

  it('a pasted token: create says RUNNING only once it is', () => {
    const routes: Route[] = [accounts,
      { path: '/v1/ai-profiles', reply: [{ id: 'profile-test', name: 'test', mine: true }] },
      { path: '/v1/hosts', reply: [{ id: 'host-test', kind: 'local' }] },
      { path: '/v1/agents', method: 'POST', reply: agent },
      { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: { ...agent, deepLink: 'https://t.me/made_up_new_bot' } }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot' } }];
    const r = cli(newHome().home, routes, ['create', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.filter((x) => x.method === 'GET' && x.path === `/v1/agents/${agent.id}`)).toHaveLength(3);
    expect(r.stdout).toMatch(/"Kitchen Helper" is RUNNING\./);
  }, 60_000);

  it('an answer to the token with no name says "bot attached", not "@undefined"', () => {
    const r = cli(newHome().home, [accounts,
      { path: '/v1/ai-profiles', reply: [{ id: 'profile-test', name: 'test', mine: true }] },
      { path: '/v1/hosts', reply: [{ id: 'host-test', kind: 'local' }] },
      { path: '/v1/agents', method: 'POST', reply: agent },
      { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: agent }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: null }],
    ['create', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^bot attached — provisioning…$/m);
    expect(r.stdout).not.toMatch(/undefined/);
    expect(r.stdout).toMatch(/"Kitchen Helper" is RUNNING\./);
  }, 60_000);

  it('a pasted token that setup never takes up: create says so instead of RUNNING', () => {
    const routes: Route[] = [accounts,
      { path: '/v1/ai-profiles', reply: [{ id: 'profile-test', name: 'test', mine: true }] },
      { path: '/v1/hosts', reply: [{ id: 'host-test', kind: 'local' }] },
      { path: '/v1/agents', method: 'POST', reply: agent },
      { path: `/v1/agents/${agent.id}`, method: 'GET', reply: waiting },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot' } }];
    const r = cli(newHome().home, routes, ['create', 'Kitchen Helper', '--timeout', '0.000001'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.stdout).not.toMatch(/is RUNNING/);
  }, 60_000);

  // HB-1276: removed, it took the bot it had just been given offline, and the
  // token setup holds for a Retry went with it; the web app's adopt keeps it (HB-1225).
  it('an agent that fails after its bot was handed over, --reuse-bot or a pasted token: kept with its bot, told how to finish the adopt and what a Retry does, and nothing adopted', () => {
    const failed = { ...agent, state: 'FAILED', stateReason: 'made-up start failure' };
    // Review of HB-1276: "Retry it" brought the bot back up on an agent with nothing of the old one copied in,
    // and a delete after that parks the bot in the pool. Removed now, nothing is parked. Parked, an adopt
    // with --reuse-bot is refused it, and one without may lease it, or another spare (review): so the
    // words say to take it out of the pool first, true of both.
    const said = `error: "Kitchen Helper" has its bot, but could not start (made-up start failure), so it was kept with its bot, and nothing was adopted.\n`
      // HB-1426: a failed setup whose rollback could not remove its container keeps the bot's row, and a
      // delete without --no-recycle parked the bot, which the adopt again was then refused.
      + `To finish the adopt, remove it and run this again: hatchabot delete ${agent.id} --yes --no-recycle\n`
      + `A Retry (hatchabot retry ${agent.id}) brings the bot back up on an agent with nothing copied from the old one; to adopt again after that, remove it with: hatchabot delete ${agent.id} --yes --no-recycle\n`
      // HB-1419: the CLI had no way to take a parked bot out of the pool; --no-recycle keeps it out.
      + `(Removed without --no-recycle, the bot is parked in your Bot pool, and an adopt is refused it until it is taken out under ⚙ Settings → Messaging → Telegram.)\n`;
    const notOnAgain = "Don't switch the bot's account back on in your hand-built instance while this agent holds it: once it runs, both would poll it, and messages would be lost.\n";
    const reuse = run([...base(true), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: failed }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_old_bot' } }], ['--reuse-bot']);
    const pasted = cli(newHome().home, [...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: failed }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot' } }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    for (const r of [reuse, pasted]) {
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(said + (r === reuse ? notOnAgain : ''));
      expect(r.requests.some((x) => x.path.endsWith('/channel-token'))).toBe(true);
      expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(false);
      expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
      expect(r.stdout).not.toMatch(/took over/);
    }
  }, 60_000);

  // HB-1163: the hand-over steps restart the gateway as the server's own hand-over does on this machine.
  it('a bot still live in the old instance: the steps to hand it over, with this machine\'s gateway restart', () => {
    const routes = base(true).map((x) => (x.path === '/v1/workspaces/inspect'
      ? { ...x, reply: { ...(x.reply as object), existingBot: { accountId: 'made_up_old_bot', sourceAgentId: 'source-test', enabledInSource: true, polling: 'idle' } } } : x));
    const r = run(routes, ['--reuse-bot']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('  openclaw config set channels.telegram.accounts.made_up_old_bot.enabled false\n  ' + gatewayRestartCommand(process.platform, {}) + '\n');
    expect(r.requests.some((x) => x.method === 'POST' && x.path === '/v1/agents')).toBe(false);
  });
  // HB-1282: the restart the server sends with the inspect, built on its machine with its settings, is the one printed.
  it('a bot still live: the gateway restart the server sends, not one made from this shell', () => {
    const routes = base(true).map((x) => (x.path === '/v1/workspaces/inspect'
      ? { ...x, reply: { ...(x.reply as object), existingBot: { accountId: 'made_up_old_bot', sourceAgentId: 'source-test', enabledInSource: true, polling: 'idle',
        restartCommand: 'systemctl --user restart made-up-gateway' } } } : x));
    const r = run(routes, ['--reuse-bot']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('  openclaw config set channels.telegram.accounts.made_up_old_bot.enabled false\n  systemctl --user restart made-up-gateway\n');
  });
  it('the gateway restart: the systemd unit on Linux, OpenClaw\'s own command on a Mac', () => {
    expect(gatewayRestartCommand('linux', {})).toBe('systemctl --user restart openclaw-gateway');
    expect(gatewayRestartCommand('linux', { HATCHABOT_OPENCLAW_GATEWAY_UNIT: 'made-up-gateway' })).toBe('systemctl --user restart made-up-gateway');
    expect(gatewayRestartCommand('darwin', {})).toBe('openclaw gateway restart');
  });

  // Eighth review: Telegram not answering says nothing of the token.
  it('a token Telegram did not answer for is sent again on its own, and adopts with no new paste', () => {
    const r = cli(newHome().home, [...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: agent }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', replies: [
        { status: 503, reply: { error: 'Telegram did not answer in time. Try again in a minute.' } },
        { status: 202, reply: { username: 'made_up_new_bot' } }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.status, r.stderr).toBe(0);
    const posts = r.requests.filter((x) => x.path.endsWith('/channel-token'));
    expect(posts.map((x) => x.body)).toEqual([{ token: '123:made-up-token' }, { token: '123:made-up-token' }]);
    expect(r.stderr).toMatch(/Trying again in 2 s/);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
  }, 60_000);

  // Twelfth review: a connection refused, or dropped before the answer,
  // says nothing of the token either; the same post goes again.
  it('a connection refused, then reset, is sent again on its own, and adopts with no new paste', () => {
    const r = cli(newHome().home, [...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: agent }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', replies: [
        { reject: 'ECONNREFUSED' }, { reject: 'ECONNRESET' },
        { status: 202, reply: { username: 'made_up_new_bot' } }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.filter((x) => x.path.endsWith('/channel-token')).map((x) => x.body)).toEqual(Array(3).fill({ token: '123:made-up-token' }));
    expect(r.stderr).toMatch(/fetch failed \(ECONNREFUSED\) Trying again in 2 s/);
    expect(r.stderr).toMatch(/fetch failed \(ECONNRESET\) Trying again in 4 s/);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
  }, 60_000);

  // Ninth review: a proxy's 504 after the server took the token; the post
  // sent again is answered 202 again (the server compares it with the held one).
  it('a 504 and then the same post again adopts with no new paste', () => {
    const r = cli(newHome().home, [...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: agent }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', replies: [
        { status: 504, reply: { error: 'Gateway Timeout' } },
        { status: 202, reply: { username: 'made_up_new_bot' } }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.filter((x) => x.path.endsWith('/channel-token')).map((x) => x.body)).toEqual([{ token: '123:made-up-token' }, { token: '123:made-up-token' }]);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
  }, 60_000);

  it('--reuse-bot on an agent that failed before the bot step says it could not start', () => {
    const failed = { ...agent, state: 'FAILED', stateReason: 'made-up start failure' };
    const r = run([...base(true), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: failed }], ['--reuse-bot']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Its bot \(Telegram account "made_up_old_bot"\) was not taken over: "Kitchen Helper" could not start: made-up start failure/);
    expect(r.stderr).not.toMatch(/did not wait for a bot/);
    expect(r.requests.some((x) => x.path.endsWith('/channel-token'))).toBe(false);
    // Nothing was handed over, so nothing holds the bot: removed, as before HB-1276 kept one that failed after.
    expect(r.requests.some((x) => x.method === 'DELETE' && x.path === `/v1/agents/${agent.id}`)).toBe(true);
    expect(r.stderr).toMatch(/was cleaned up/);
  }, 60_000);

  it('--reuse-bot on an agent that came up with another bot stops, and removes it', () => {
    const r = run([...base(true), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: { ...agent, botUsername: 'made_up_pool_bot' } }], ['--reuse-bot']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Its bot \(Telegram account "made_up_old_bot"\) was not taken over: "Kitchen Helper" did not wait for a bot \(it has @made_up_pool_bot\)/);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(false);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(true);
    expect(r.stderr).toMatch(/was cleaned up/);
  }, 60_000);

  // Thirteenth review: a server of v2.177 or before shows the step until
  // setup takes the token, and says nothing of it (no stepAnswered): a step
  // that goes within 30 s is that, not a refusal.
  it('an older server slow to take the token: adopt --reuse-bot waits it out, adopts, and removes nothing', () => {
    const r = run([...base(true), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: waiting }, { reply: waiting }, { reply: agent }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_old_bot' } }], ['--reuse-bot']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.filter((x) => x.method === 'GET' && x.path === `/v1/agents/${agent.id}`)).toHaveLength(4);
    expect(r.stdout).toMatch(/took over @made_up_old_bot/);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
  }, 60_000);

  it('a wait that runs out after the bot was handed over leaves the agent to finish, and says what to watch', () => {
    const r = run([...base(true), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_old_bot', stepAnswered: true } }], ['--reuse-bot', '--timeout', '0.000001']);
    expect(r.status).toBe(1);
    expect(r.requests.some((x) => x.path.endsWith('/channel-token'))).toBe(true);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
    expect(r.stderr).toMatch(/"Kitchen Helper" was still PROVISIONING after 0\.000001 min, after its bot was handed over: it was left to finish/);
    expect(r.stderr).toMatch(/hatchabot setup-log agent-0001-test/);
    // Once it runs on the bot, a plain delete parks it in the pool, which an adopt is refused (HB-1419).
    expect(r.stderr).toContain('once it runs, remove it (hatchabot delete agent-0001-test --yes --no-recycle, which keeps its bot out of your Bot pool) and run this again.');
    expect(r.stderr).not.toMatch(/cleaned up/);
  }, 60_000);

  it('running on another bot than the token handed over: adopt and create say which, and that the pasted bot was not used', () => {
    const onPool = { ...agent, botUsername: 'made_up_pool_bot' };
    const r = cli(newHome().home, [...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: onPool }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot', stepAnswered: true } }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/it is on @made_up_pool_bot, not @made_up_new_bot — @made_up_new_bot was not used/);
    // An older server names the bot only in its link.
    const made = cli(newHome().home, [accounts,
      { path: '/v1/ai-profiles', reply: [{ id: 'profile-test', name: 'test', mine: true }] },
      { path: '/v1/hosts', reply: [{ id: 'host-test', kind: 'local' }] },
      { path: '/v1/agents', method: 'POST', reply: agent },
      { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: { ...agent, deepLink: 'https://t.me/made_up_pool_bot' } }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot' } }],
    ['create', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(made.status, made.stderr).toBe(0);
    expect(made.stdout).toMatch(/it is on @made_up_pool_bot, not @made_up_new_bot — @made_up_new_bot was not used/);
  }, 60_000);

  // Fourteenth review: the workspace's account key is not the bot's name.
  it('--reuse-bot with an account key that is not the bot\'s name: taken over, by the server\'s name, with no "not used" note', () => {
    const r = cli(newHome().home, [...base(true, 'default'), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: { ...agent, botUsername: 'made_up_old_bot' } }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_old_bot', stepAnswered: true } }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper', '--reuse-bot'], env);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toMatch(/was not used/);
    expect(r.stdout).toMatch(/took over @made_up_old_bot/);
  }, 60_000);

  it('an older server: no answer, then a 409 to the post sent again, then running: adopted, nothing removed', () => {
    const r = cli(newHome().home, [...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: agent }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', replies: [
        { status: 504, reply: { error: 'Gateway Timeout' } },
        { status: 409, reply: { error: 'This agent is not waiting for a bot token.' } }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.filter((x) => x.path.endsWith('/channel-token'))).toHaveLength(2);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
  }, 60_000);

  // Fifteenth review: a server that says so (/v1/config handover: 2) is told
  // apart by that, not by timing.
  const saying: Route = { path: '/v1/config', reply: { authMode: 'accounts', handover: 2 } };
  const BOT_ENV = { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' };

  it('a server that says: the first post dropped, a real 409 to the second, the step still open: that 409 is the refusal, and the agent is removed', () => {
    const r = cli(newHome().home, [saying, ...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: waiting },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', replies: [
        { reject: 'ECONNRESET' },
        { status: 409, reply: { error: 'It is being deleted.' } }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], BOT_ENV);
    expect(r.status).toBe(1);
    expect(r.requests.filter((x) => x.path.endsWith('/channel-token'))).toHaveLength(2);
    expect(r.stderr).toMatch(/It is being deleted\.\nNothing was adopted and "Kitchen Helper" was cleaned up/);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(true);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(false);
  }, 60_000);

  it('a server that says: no answer, then a 409 to the post sent again, the step answered: watched to running, nothing removed', () => {
    const r = cli(newHome().home, [saying, ...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: agent }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', replies: [
        { status: 504, reply: { error: 'Gateway Timeout' } },
        { status: 409, reply: { error: 'Another bot token came in for this agent already.' } }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], BOT_ENV);
    expect(r.status, r.stderr).toBe(0);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
  }, 60_000);

  // HB-1277, the CLI's side: four hand-over posts with no answer, and the
  // server may have taken one. It was removed at once, and with --reuse-bot
  // the old account was already off, so the bot went dark. The agent is read.
  const unanswered: Route = { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', replies: [
    { reject: 'ECONNRESET' }, { status: 503, reply: { error: 'Telegram did not answer, so the token could not be checked. Try again in a moment.' } },
    { status: 504, reply: { error: 'Gateway Timeout' } }, { status: 502, reply: { error: 'Bad Gateway' } }] };
  const reads = (r: { requests: Seen[] }) => r.requests.filter((x) => x.method === 'GET' && x.path === `/v1/agents/${agent.id}`).length;
  const posts = (r: { requests: Seen[] }) => r.requests.filter((x) => x.path.endsWith('/channel-token')).length;
  /** The fixture's virtual clock (HB-1427): the CLI's waits pass at once, each request timed. */
  const VIRTUAL = (e: Record<string, string>) => ({ ...e, HB_CLI_FIXTURE_CLOCK: 'virtual' });
  /** When each read of the agent after the last hand-over post came, in virtual ms after that post. */
  const sinceLastPost = (r: { requests: Seen[] }) => {
    const last = r.requests.filter((x) => x.path.endsWith('/channel-token')).at(-1)!;
    return r.requests.slice(r.requests.indexOf(last) + 1).filter((x) => x.method === 'GET' && x.path === `/v1/agents/${agent.id}`).map((x) => x.at! - last.at!);
  };
  const later = 'Watch it with: hatchabot setup-log agent-0001-test — if it still asks for a bot token, remove it (hatchabot delete agent-0001-test --yes) and run this again. '
    + 'Once it runs on that bot, remove it with hatchabot delete agent-0001-test --yes --no-recycle before adopting again: removed without --no-recycle, the bot is parked in your Bot pool, and an adopt is refused it until it is taken out under ⚙ Settings → Messaging → Telegram.\n';
  const notOn = "Don't switch the bot's account back on in your hand-built instance while this agent may hold it: once it runs, both would poll it, and messages would be lost.\n";

  it('four posts with no answer, a server that says, the step answered: handed over, watched to running and adopted, nothing removed, --reuse-bot or a token', () => {
    for (const [args, extra, bot] of [[['--reuse-bot'], env, true], [[], BOT_ENV, false]] as const) {
      const r = cli(newHome().home, [saying, ...base(bot), unanswered,
        { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: setting }, { reply: agent }] }],
      ['adopt', '/made-up/workspace', 'Kitchen Helper', ...args], extra, '', 90_000);
      expect(r.status, r.stderr).toBe(0);
      expect(posts(r)).toBe(4);
      expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
      expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
    }
  }, 200_000);

  it('four posts with no answer, a server that says, the step still open: none was taken, and it is removed, as before', () => {
    const r = cli(newHome().home, [saying, ...base(false), unanswered, { path: `/v1/agents/${agent.id}`, method: 'GET', reply: waiting }],
      ['adopt', '/made-up/workspace', 'Kitchen Helper'], VIRTUAL(BOT_ENV), '', 90_000);
    expect(r.status).toBe(1);
    expect(posts(r)).toBe(4);
    // Read after the last post, and again once the server's bound on it is out (HB-1427).
    expect(reads(r)).toBe(3);
    expect(sinceLastPost(r)).toHaveLength(2);
    expect(Math.abs(sinceLastPost(r)[1]! - HANDOVER_POST_BOUND_MS)).toBeLessThan(1000);
    expect(r.stderr).toMatch(/error: Bad Gateway\nNothing was adopted and "Kitchen Helper" was cleaned up/);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(true);
  }, 120_000);

  // HB-1427: one read after the last post was a snapshot. A post still being
  // checked with Telegram (up to 10 s, after a 5 s look at the bot) could take
  // the bot after it, and the agent was removed with the token it held.
  it('a server that says: the step still open at the read after the last post, answered once the server\'s bound on it is out: handed over, adopted, nothing removed, --reuse-bot or a token', () => {
    for (const [args, extra, bot] of [[['--reuse-bot'], env, true], [[], BOT_ENV, false]] as const) {
      const r = cli(newHome().home, [saying, ...base(bot), unanswered,
        { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: waiting }, { reply: setting }, { reply: setting }, { reply: agent }] }],
      ['adopt', '/made-up/workspace', 'Kitchen Helper', ...args], VIRTUAL(extra), '', 90_000);
      expect(r.status, r.stderr).toBe(0);
      expect(posts(r)).toBe(4);
      const [first, again] = sinceLastPost(r);
      expect(first).toBeLessThan(1000);
      expect(Math.abs(again! - HANDOVER_POST_BOUND_MS)).toBeLessThan(1000);
      expect(r.stderr).toMatch(/waiting up to 2\d s for the server to finish with the bot hand-over…/);
      expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
      expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
    }
  }, 200_000);

  it('a server that says: the step still open, and the agent not read once the bound is out: kept, and said', () => {
    const r = cli(newHome().home, [saying, ...base(true), unanswered,
      { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: waiting }, { status: 502, reply: { error: 'Bad gateway, for the test.' } }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper', '--reuse-bot'], VIRTUAL(env), '', 90_000);
    expect(r.status).toBe(1);
    expect(reads(r)).toBe(3);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
    expect(r.stderr.slice(r.stderr.indexOf('error: '))).toBe('error: "Kitchen Helper" was kept, and nothing was adopted: the hand-over of its bot may not have gone through (Bad Gateway), '
      + 'and it could not be read after that (Bad gateway, for the test.), so whether it has its bot is not known.\n' + later + notOn);
  }, 120_000);

  it('the paste-a-token box (create): the step still open at the read after the last post, answered once the bound is out: attached, and running', () => {
    const r = cli(newHome().home, [saying,
      { path: '/v1/ai-profiles', reply: [{ id: 'profile-test', name: 'test', mine: true }] },
      { path: '/v1/hosts', reply: [{ id: 'host-test', kind: 'local' }] },
      { path: '/v1/agents', method: 'POST', reply: agent },
      { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: waiting }, { reply: setting }, { reply: agent }] }, unanswered],
    ['create', 'Kitchen Helper'], VIRTUAL(BOT_ENV), '', 90_000);
    expect(r.status, r.stderr).toBe(0);
    expect(posts(r)).toBe(4);
    expect(sinceLastPost(r)[1]).toBeGreaterThanOrEqual(HANDOVER_POST_BOUND_MS - 1000);
    expect(r.stdout).toMatch(/bot attached — provisioning…/);
    expect(r.stdout).toMatch(/"Kitchen Helper" is RUNNING\./);
  }, 120_000);

  it('four posts with no answer and the agent not read after: kept, and said, whichever server', () => {
    for (const routes of [[saying], []]) {
      const r = cli(newHome().home, [...routes, ...base(true), unanswered,
        { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { status: 502, reply: { error: 'Bad gateway, for the test.' } }] }],
      ['adopt', '/made-up/workspace', 'Kitchen Helper', '--reuse-bot'], env, '', 90_000);
      expect(r.status).toBe(1);
      expect(posts(r)).toBe(4);
      expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
      expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(false);
      expect(r.stderr.slice(r.stderr.indexOf('error: '))).toBe('error: "Kitchen Helper" was kept, and nothing was adopted: the hand-over of its bot may not have gone through (Bad Gateway), '
        + 'and it could not be read after that (Bad gateway, for the test.), so whether it has its bot is not known.\n' + later + notOn);
    }
  }, 200_000);

  it('an older server: four posts with no answer and its step still showing, which it shows until setup takes a token: kept, and said; the step gone: adopted', () => {
    const kept = cli(newHome().home, [...base(false), unanswered, { path: `/v1/agents/${agent.id}`, method: 'GET', reply: waiting }],
      ['adopt', '/made-up/workspace', 'Kitchen Helper'], VIRTUAL(BOT_ENV), '', 90_000);
    expect(kept.status).toBe(1);
    // Looked at until STEP_GRACE_MS from the last post, not once (HB-1427).
    expect(sinceLastPost(kept).at(-1)).toBeGreaterThanOrEqual(29_000);
    expect(sinceLastPost(kept).at(-1)).toBeLessThan(33_000);
    expect(kept.requests.some((x) => x.method === 'DELETE')).toBe(false);
    expect(kept.stderr.slice(kept.stderr.indexOf('error: '))).toBe('error: "Kitchen Helper" was kept, and nothing was adopted: the hand-over of its bot may not have gone through (Bad Gateway), '
      + 'and it still asks for a bot token, which this server (v2.177 or before) shows until setup takes one, so whether it has its bot is not known.\n' + later);
    const taken = cli(newHome().home, [...base(false), unanswered,
      { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: setting }, { reply: agent }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], BOT_ENV, '', 90_000);
    expect(taken.status, taken.stderr).toBe(0);
    expect(taken.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
    expect(taken.requests.some((x) => x.method === 'DELETE')).toBe(false);
    // The step showing at the read after the last post, gone within STEP_GRACE_MS: taken, and adopted (HB-1427).
    const gone = cli(newHome().home, [...base(false), unanswered,
      { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: waiting }, { reply: waiting }, { reply: waiting }, { reply: setting }, { reply: agent }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], VIRTUAL(BOT_ENV), '', 90_000);
    expect(gone.status, gone.stderr).toBe(0);
    expect(gone.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(true);
    expect(gone.requests.some((x) => x.method === 'DELETE')).toBe(false);
  }, 200_000);

  // Review of HB-1277's CLI side: create keeps its agent too (it never removes one), but said only the
  // bare sentence, with no name, no id, no word that it was kept, and no next step.
  it('create: four posts with no answer and whether it has its bot not known: kept, named with its id, and the next step said, whichever server', () => {
    const next = 'Watch it with: hatchabot setup-log agent-0001-test — if it still asks for a bot token, give it the token again in its sheet in the web app, '
      + 'or remove it (hatchabot delete agent-0001-test --yes) and run this again.\n';
    for (const [config, read, why] of [
      [saying, { status: 502, reply: { error: 'Bad gateway, for the test.' } }, 'it could not be read after that (Bad gateway, for the test.)'],
      [accounts, { reply: waiting }, 'it still asks for a bot token, which this server (v2.177 or before) shows until setup takes one']] as const) {
      const r = cli(newHome().home, [config,
        { path: '/v1/ai-profiles', reply: [{ id: 'profile-test', name: 'test', mine: true }] },
        { path: '/v1/hosts', reply: [{ id: 'host-test', kind: 'local' }] },
        { path: '/v1/agents', method: 'POST', reply: agent },
        { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, read] }, unanswered],
      ['create', 'Kitchen Helper'], VIRTUAL(BOT_ENV), '', 90_000);
      expect(r.status).toBe(1);
      expect(posts(r)).toBe(4);
      expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
      expect(r.stderr.slice(r.stderr.indexOf('error: '))).toBe('error: "Kitchen Helper" (agent-0001-test) was kept: the hand-over of its bot may not have gone through (Bad Gateway), '
        + `and ${why}, so whether it has its bot is not known.\n` + next);
    }
  }, 200_000);

  // Review of HB-1277's CLI side: a 409 to a post sent again after no answer was worded as the first had
  // no answer, "may not have gone through (This agent is not waiting for a bot token.)": that 409 is
  // what an earlier post that landed brings, and is said so.
  it('a server that says: no answer, a 409 to the post sent again, and the agent not read after: kept, said as an earlier hand-over that may have gone through', () => {
    const r = cli(newHome().home, [saying, ...base(true),
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', replies: [{ reject: 'ECONNRESET' }, { status: 409, reply: { error: 'This agent is not waiting for a bot token.' } }] },
      { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { status: 502, reply: { error: 'Bad gateway, for the test.' } }] }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper', '--reuse-bot'], env, '', 90_000);
    expect(r.status).toBe(1);
    expect(posts(r)).toBe(2);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
    expect(r.stderr.slice(r.stderr.indexOf('error: '))).toBe('error: "Kitchen Helper" was kept, and nothing was adopted: an earlier hand-over of its bot may have gone through '
      + '(sent again after no answer, it was refused: This agent is not waiting for a bot token.), and it could not be read after that (Bad gateway, for the test.), '
      + 'so whether it has its bot is not known.\n' + later + notOn);
  }, 120_000);

  // Review of HB-1277's CLI side: a 404 at that read was said as "was kept", with a delete to run. It is gone.
  it('four posts with no answer and the agent gone at the read after (404): said so, nothing to keep or remove, adopt and create', () => {
    const gone = { status: 404, reply: { error: 'No such agent.' } };
    for (const [args, extra, bot] of [[['--reuse-bot'], env, true], [[], BOT_ENV, false]] as const) {
      const r = cli(newHome().home, [saying, ...base(bot), unanswered, { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, gone] }],
        ['adopt', '/made-up/workspace', 'Kitchen Helper', ...args], extra, '', 90_000);
      expect(r.status).toBe(1);
      expect(posts(r)).toBe(4);
      expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
      expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(false);
      expect(r.stderr.slice(r.stderr.indexOf('error: '))).toBe('error: "Kitchen Helper" is gone (No such agent.): it was removed while its bot was being handed over, '
        + 'so nothing was adopted, and there is nothing to remove. Run this again.\n');
    }
    const made = cli(newHome().home, [saying,
      { path: '/v1/ai-profiles', reply: [{ id: 'profile-test', name: 'test', mine: true }] },
      { path: '/v1/hosts', reply: [{ id: 'host-test', kind: 'local' }] },
      { path: '/v1/agents', method: 'POST', reply: agent },
      { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, gone] }, unanswered],
    ['create', 'Kitchen Helper'], BOT_ENV, '', 90_000);
    expect(made.status).toBe(1);
    expect(made.requests.some((x) => x.method === 'DELETE')).toBe(false);
    expect(made.stderr.slice(made.stderr.indexOf('error: '))).toBe('error: "Kitchen Helper" is gone (No such agent.): it was removed while its bot was being handed over. Run this again.\n');
  }, 300_000);

  it('a server that says: a step after the hand-over is a refusal at once, with no 30 s grace and no word of an older server', () => {
    const started = Date.now();
    const r = cli(newHome().home, [saying, ...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: waiting },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot' } }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], BOT_ENV);
    expect(r.status).toBe(1);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(r.stderr).toMatch(/"Kitchen Helper" is PROVISIONING and waiting on you/);
    expect(r.stderr).not.toMatch(/v2\.177/);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(true);
  }, 60_000);

  it('an older server still asking for the token past 30 s: the agent is left to finish, not removed', () => {
    const r = cli(newHome().home, [...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: waiting },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_new_bot' } }],
    ['adopt', '/made-up/workspace', 'Kitchen Helper'], { ...env, HATCHABOT_BOT_TOKEN: '123:made-up-token' }, '', 100_000);
    expect(r.status).toBe(1);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(false);
    expect(r.stderr).toMatch(/"Kitchen Helper" still asks for a bot token 30 s after its bot was handed over, and this server \(v2\.177 or before\) does not say whether setup took it: it was left to finish/);
    expect(r.stderr).toMatch(/hatchabot setup-log agent-0001-test/);
  }, 120_000);

  it('running out of time removes the half-made agent instead of exiting past the cleanup', () => {
    const r = run([...base(false), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: { ...agent, state: 'PROVISIONING' } }], ['--timeout', '0.000001']);
    expect(r.status).toBe(1);
    expect(r.requests.some((x) => x.method === 'DELETE' && x.path === `/v1/agents/${agent.id}`)).toBe(true);
    expect(r.stderr).toMatch(/"Kitchen Helper" was still PROVISIONING after 0\.000001 min/);
    expect(r.stderr).toMatch(/was cleaned up/);
  }, 60_000);

  // HB-0980 review: a copy torn part way is held on the agent, and a Delete goes through that hold.
  const torn: Route = { path: `/v1/agents/${agent.id}/adopt-workspace`, method: 'POST', status: 400, reply: {
    error: 'Copying the workspace in failed part way (made-up: no space left on device) — the agent is left stopped because its files may be half-replaced, and it is not started until you choose on its page. Adopt again copies every file in the folder in again, whole; one the cut-off copy wrote that the folder no longer has stays as it was left. Or delete it.',
    code: 'adopt-held', operation: 'op_madeup0001', detail: 'made-up: no space left on device' } };
  it('a copy torn part way: the half-made agent is removed, and that is what it says', () => {
    const r = run([torn, ...base(false).filter((x) => !x.path.endsWith('/adopt-workspace')), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: agent }], []);
    expect(r.status).toBe(1);
    expect(r.requests.some((x) => x.method === 'DELETE' && x.path === `/v1/agents/${agent.id}`)).toBe(true);
    expect(r.stderr).toMatch(/Copying the workspace into "Kitchen Helper" failed part way \(made-up: no space left on device\)\.\nNothing was adopted and "Kitchen Helper" was cleaned up/);
    expect(r.stderr).not.toMatch(/choose on its page/);
  }, 60_000);

  it('a copy torn part way and a cleanup refused: both ways out that work, Adopt again and the delete', () => {
    const routes = base(false).filter((x) => x.method !== 'DELETE' && !x.path.endsWith('/adopt-workspace'));
    const r = run([torn, ...routes, { path: `/v1/agents/${agent.id}`, method: 'GET', reply: agent },
      { path: `/v1/agents/${agent.id}`, method: 'DELETE', status: 409, reply: { error: 'Another operation is already running on this agent.' } }], []);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/"Kitchen Helper" \(agent-0001-test\) could not be removed: Another operation is already running on this agent\./);
    expect(r.stderr).toMatch(/hatchabot ops recover op_madeup0001 adopt-again/);
    expect(r.stderr).toMatch(/hatchabot delete agent-0001-test --yes/);
  }, 60_000);

  it('copied in whole but not started: the agent is kept, not cleaned up, and it says how to start it (HB-0980 re-review)', () => {
    const copied: Route = { path: `/v1/agents/${agent.id}/adopt-workspace`, method: 'POST', status: 400, reply: {
      error: 'The workspace from /made-up/workspace was copied in whole, but it could not be started (made-up: docker did not answer): start it once its machine answers.', code: 'adopt-not-started' } };
    const r = run([copied, ...base(false).filter((x) => !x.path.endsWith('/adopt-workspace')), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: agent }], []);
    expect(r.status).toBe(1);
    expect(r.requests.some((x) => x.method === 'DELETE')).toBe(false);
    expect(r.stderr).toMatch(/copied in whole, but it could not be started \(made-up: docker did not answer\): start it once its machine answers\.\n"Kitchen Helper" \(agent-0001-test\) is kept, with every file copied in\. Start it once its machine answers: hatchabot start agent-0001-test/);
    expect(r.stderr).not.toMatch(/cleaned up/);
  }, 60_000);

  it('a cleanup the server refuses is said, with the agent\'s id and how to remove it', () => {
    const routes = base(false).filter((x) => x.method !== 'DELETE');
    const r = run([...routes, { path: `/v1/agents/${agent.id}`, method: 'GET', reply: { ...agent, state: 'FAILED', stateReason: 'made-up failure' } },
      { path: `/v1/agents/${agent.id}`, method: 'DELETE', status: 409, reply: { error: 'Another operation is already running on this agent.' } }], []);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/cleaned up/);
    expect(r.stderr).toMatch(/could not start: made-up failure/);
    expect(r.stderr).toMatch(/"Kitchen Helper" \(agent-0001-test\) could not be removed: Another operation is already running on this agent\./);
    expect(r.stderr).toMatch(/hatchabot delete agent-0001-test --yes/);
  }, 60_000);
});

// Eleventh review of fix/r3-cli: adopt asked for another token on any 4xx,
// also when the agent was not waiting, or another token had come in already.
describe('adopt asks for another bot token only when the token itself was turned down', () => {
  const answer = (status: number, error: string) => Object.assign(new Error(error), { status, data: { error } });
  it('400 or 422 from the token check: asked again', () => {
    expect(tokenTurnedDown(answer(400, 'That token was not accepted by Telegram.'))).toBe(true);
    expect(tokenTurnedDown(answer(400, '@made_up_spare_bot is a spare bot in the pool.'))).toBe(true);
    expect(tokenTurnedDown(answer(400, 'That bot is already connected to "Recipe Box".'))).toBe(true);
    expect(tokenTurnedDown(answer(422, 'made-up refusal of the token'))).toBe(true);
  });
  it('a 409 about the agent, a throttle or no answer: stopped with that', () => {
    expect(tokenTurnedDown(answer(409, 'This agent is not waiting for a bot token.'))).toBe(false);
    expect(tokenTurnedDown(answer(409, 'A bot token came in already, and setup is taking it.'))).toBe(false);
    expect(tokenTurnedDown(answer(404, 'Not found'))).toBe(false);
    expect(tokenTurnedDown(answer(429, 'made-up throttle'))).toBe(false);
    expect(tokenTurnedDown(answer(503, 'Telegram did not answer'))).toBe(false);
    expect(tokenTurnedDown(new Error('no status'))).toBe(false);
  });
});

describe('a bot-token post with no answer is sent again (noAnswer)', () => {
  it('502–504, or a fetch that rejected (a TypeError: refused, reset, dropped)', () => {
    for (const status of [502, 503, 504]) expect(noAnswer(Object.assign(new Error('made up'), { status }))).toBe(true);
    expect(noAnswer(new TypeError('fetch failed', { cause: Object.assign(new Error('made up'), { code: 'ECONNREFUSED' }) }))).toBe(true);
    expect(noAnswer(new TypeError('fetch failed'))).toBe(true);
  });
  it('an answer, even a refusal, or any other error is not sent again', () => {
    for (const status of [400, 409, 422, 429, 500]) expect(noAnswer(Object.assign(new Error('made up'), { status }))).toBe(false);
    expect(noAnswer(new Error('made-up bug, no status'))).toBe(false);
    expect(noAnswer(Object.assign(new Error('made up'), { cause: { code: 'ENOENT' } }))).toBe(false);
    expect(noAnswer(Object.assign(new Error('made up, not from fetch'), { cause: { code: 'ECONNRESET' } }))).toBe(false);
  });
  // Sixteenth review: a bug is not a dropped connection.
  it('a TypeError that is a bug (an invalid URL, a bad header) is not sent again; a failed connection is', () => {
    expect(noAnswer(new TypeError('Failed to parse URL from made-up', { cause: Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL' }) }))).toBe(false);
    expect(noAnswer(new TypeError('Headers.append: "a\nb" is an invalid header value.'))).toBe(false);
    expect(noAnswer(new TypeError("Cannot read properties of undefined (reading 'json')"))).toBe(false);
    expect(noAnswer(new TypeError('fetch failed', { cause: Object.assign(new Error('made up'), { code: 'ENOTFOUND' }) }))).toBe(true);
    expect(noAnswer(new TypeError('made-up words', { cause: { code: 'UND_ERR_SOCKET' } }))).toBe(true);
  });
});

describe('the bot an agent runs on, against the one handed over (thirteenth review)', () => {
  it('named by botUsername, or by its t.me link from an older server', () => {
    expect(botOf({ botUsername: 'made_up_bot' })).toBe('made_up_bot');
    expect(botOf({ deepLink: 'https://t.me/made_up_bot' })).toBe('made_up_bot');
    expect(botOf({})).toBeUndefined();
  });
  it('a note only when both are known and they differ', () => {
    expect(otherBotLine({ botUsername: 'made_up_pool_bot' }, 'made_up_new_bot')).toMatch(/on @made_up_pool_bot, not @made_up_new_bot/);
    expect(otherBotLine({ botUsername: 'Made_Up_Bot' }, '@made_up_bot')).toBeUndefined();
    expect(otherBotLine({}, 'made_up_new_bot')).toBeUndefined();
    expect(otherBotLine({ botUsername: 'made_up_pool_bot' }, undefined)).toBeUndefined();
  });
});

describe('delete --no-recycle keeps the bot out of the Bot pool (HB-1419)', () => {
  // A bot parked in the pool is refused to an adopt ("is a spare bot in the pool"),
  // and the CLI has no way to take one out of it: an adopt kept on its bot, then
  // retried, could be finished only from the web page.
  const agent = { id: 'agent-0002-test', name: 'Porch Helper', slug: 'porch-helper', state: 'RUNNING' };
  const env = { HATCHABOT_URL: 'http://fixture.invalid', HATCHABOT_TOKEN: 'fixture-cli-value' };
  const routes: Route[] = [
    { path: '/v1/agents', method: 'GET', reply: [agent] },
    { path: `/v1/agents/${agent.id}/bot-token`, method: 'GET', status: 404, reply: { error: 'No bot.' } },
    { path: `/v1/agents/${agent.id}`, method: 'DELETE', reply: {} },
  ];
  const deleted = (r: { requests: Seen[] }) => r.requests.filter((x) => x.method === 'DELETE');

  it('asks the server to forget its bots, not park them; without it, the server parks them, as before', () => {
    const kept = cli(newHome().home, routes, ['delete', agent.id, '--yes', '--no-recycle'], env);
    expect(kept.status, kept.stderr).toBe(0);
    expect(deleted(kept)).toEqual([expect.objectContaining({ path: `/v1/agents/${agent.id}`, search: '?recycleBot=0' })]);
    expect(kept.stdout).toContain('"Porch Helper" deleted.');
    const plain = cli(newHome().home, routes, ['delete', agent.id, '--yes'], env);
    expect(plain.status, plain.stderr).toBe(0);
    expect(deleted(plain)).toEqual([expect.objectContaining({ path: `/v1/agents/${agent.id}` })]);
    expect(deleted(plain)[0]!.search).toBeUndefined();
  }, 60_000);

  it('the help names it', () => {
    const r = cli(newHome().home, [], ['help'], env);
    expect(r.stdout).toContain('delete <agent> [--yes] [--no-recycle]');
    expect(r.stdout).toContain('--no-recycle forgets it instead');
  }, 60_000);
  it("never asks for the bot's token, and says what happens to its bot, from the agent list (HB-1419 review)", () => {
    const run = (a: Record<string, unknown>, more: string[] = []) => cli(newHome().home, [
      { path: '/v1/agents', method: 'GET', reply: [{ ...agent, ...a }] },
      { path: `/v1/agents/${agent.id}`, method: 'DELETE', reply: {} },
    ], ['delete', agent.id, '--yes', ...more], env);
    const pasted = run({ botUsername: 'made_up_porch_bot', botPooled: false });
    expect(pasted.status, pasted.stderr).toBe(0);
    expect(pasted.requests.some((x) => x.path.endsWith('/bot-token'))).toBe(false);
    expect(pasted.stdout).toContain('note: bot @made_up_porch_bot is parked in your Bot pool for the next agent (--no-recycle forgets it instead).');
    const forgot = run({ botUsername: 'made_up_porch_bot', botPooled: false }, ['--no-recycle']);
    expect(forgot.stdout).toContain('note: bot @made_up_porch_bot is forgotten, not parked: save its token first (hatchabot token agent-0002-test) if you want it for another agent.');
    expect(forgot.requests.some((x) => x.path.endsWith('/bot-token'))).toBe(false);
    const leased = run({ botUsername: 'made_up_pool_bot', botPooled: true }, ['--no-recycle']);
    expect(leased.stdout).toContain('note: bot @made_up_pool_bot goes back to the Bot pool it came from.');
    const copied = run({ botUsername: 'made_up_porch_bot', botPooled: false, state: 'STOPPED', exportedAt: '2026-11-20T10:00:00.000Z' });
    expect(copied.stdout).toContain('note: bot @made_up_porch_bot is left to the copy of "Porch Helper" that was downloaded, which may answer on it: it is not parked for another agent here.');
    // Moved to another Hatchabot: the server leaves its bot to the peer, which answers on it now (round-2 review).
    const moved = run({ botUsername: 'made_up_porch_bot', botPooled: false, state: 'STOPPED', migratedTo: 'garden-shed' });
    expect(moved.stdout).toContain('note: bot @made_up_porch_bot is left to "Porch Helper" on garden-shed, where it was moved: it is not parked for another agent here.');
    expect(moved.stdout).not.toContain('Bot pool');
    const none = run({ webOnly: true });
    expect(none.stdout).not.toContain('note:');
    expect(none.requests.some((x) => x.path.endsWith('/bot-token'))).toBe(false);
  }, 60_000);
});
