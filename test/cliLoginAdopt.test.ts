import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { botOf, noAnswer, otherBotLine, tokenTurnedDown } from '../src/cli.js';

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
interface Seen { path: string; method: string; body?: any; origin: string; authorization?: string }

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

  it('--reuse-bot on an agent that fails after the handover says why, removes it, and adopts nothing', () => {
    const failed = { ...agent, state: 'FAILED', stateReason: 'made-up start failure' };
    const r = run([...base(true), { path: `/v1/agents/${agent.id}`, method: 'GET', replies: [{ reply: waiting }, { reply: setting }, { reply: failed }] },
      { path: `/v1/agents/${agent.id}/channel-token`, method: 'POST', status: 202, reply: { username: 'made_up_old_bot' } }], ['--reuse-bot']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/@made_up_old_bot was not taken over: "Kitchen Helper" could not start: made-up start failure/);
    expect(r.requests.some((x) => x.path.endsWith('/adopt-workspace'))).toBe(false);
    expect(r.requests.some((x) => x.method === 'DELETE' && x.path === `/v1/agents/${agent.id}`)).toBe(true);
    expect(r.stdout).not.toMatch(/took over/);
  }, 60_000);

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
    expect(r.stderr).toMatch(/@made_up_old_bot was not taken over: "Kitchen Helper" could not start: made-up start failure/);
    expect(r.stderr).not.toMatch(/did not wait for a bot/);
    expect(r.requests.some((x) => x.path.endsWith('/channel-token'))).toBe(false);
  }, 60_000);

  it('--reuse-bot on an agent that came up with another bot stops, and removes it', () => {
    const r = run([...base(true), { path: `/v1/agents/${agent.id}`, method: 'GET', reply: { ...agent, botUsername: 'made_up_pool_bot' } }], ['--reuse-bot']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/@made_up_old_bot was not taken over: "Kitchen Helper" did not wait for a bot \(it has @made_up_pool_bot\)/);
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
