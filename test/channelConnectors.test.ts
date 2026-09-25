import { describe, expect, it } from 'vitest';
import { slackAppIdFromAppToken, slackConnector } from '../src/channels/slack.js';
import { DISCORD_BOT_PERMISSIONS, discordConnector } from '../src/channels/discord.js';
import { ConnectorError } from '../src/channels/connector.js';

/** The real connectors against canned platform replies. No network. */

const BOT = 'xoxb-test-not-a-real-token-0000';
const APP = 'xapp-1-A0APPID123-test-not-a-real-token';
const DTOKEN = 'TESTtestTESTtestTESTtest.test00.not-a-real-token-not-a-real';

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown; headers?: Record<string, string> };
function fakeFetch(route: Route) {
  const calls: Array<{ url: string; auth?: string }> = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const r = route(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  };
  return { f, calls };
}

const slackOk: Route = (url) => {
  if (url.endsWith('/auth.test')) return { body: { ok: true, team: 'Krueger Family', team_id: 'T01', user: 'tax_advisor', user_id: 'U0BOT', bot_id: 'B01' }, headers: { 'x-oauth-scopes': 'chat:write,im:history,im:read,im:write,app_mentions:read,users:read' } };
  if (url.includes('/bots.info')) return { body: { ok: true, bot: { app_id: 'A0APPID123' } } };
  if (url.endsWith('/apps.connections.open')) return { body: { ok: true, url: 'wss://x' } };
  return { status: 404, body: {} };
};

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ConnectorError); return (e as ConnectorError).userMessage; }
  throw new Error('expected a refusal');
}

describe('Slack', () => {
  it('reads the app id from an app-level token', () => {
    expect(slackAppIdFromAppToken(APP)).toBe('A0APPID123');
    expect(slackAppIdFromAppToken('xapp-garbage')).toBeUndefined();
  });

  it('accepts a matching pair and says where it lives', async () => {
    const { f, calls } = fakeFetch(slackOk);
    const v = await slackConnector(f as never).verify({ botToken: BOT, appToken: APP });
    expect(v).toMatchObject({ accountId: 'U0BOT', displayName: '@tax_advisor in Krueger Family', warnings: [] });
    expect(v.deepLink).toBe('https://slack.com/app_redirect?app=A0APPID123&team=T01');
    expect(calls.find((c) => c.url.endsWith('/apps.connections.open'))?.auth).toBe(`Bearer ${APP}`);
    expect(calls.every((c) => new URL(c.url).hostname === 'slack.com')).toBe(true);
  });

  it('catches tokens pasted into the wrong boxes before calling Slack', async () => {
    const { f, calls } = fakeFetch(slackOk);
    const msg = await refusal(slackConnector(f as never).verify({ botToken: APP, appToken: BOT }));
    expect(msg).toMatch(/bot token/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses tokens from two different apps', async () => {
    const { f } = fakeFetch((u, i) => (u.includes('/bots.info') ? { body: { ok: true, bot: { app_id: 'A0OTHER' } } } : slackOk(u, i)));
    expect(await refusal(slackConnector(f as never).verify({ botToken: BOT, appToken: APP }))).toMatch(/different Slack apps/);
  });

  it('explains an app-level token without connections:write', async () => {
    const { f } = fakeFetch((u, i) => (u.endsWith('/apps.connections.open') ? { body: { ok: false, error: 'missing_scope' } } : slackOk(u, i)));
    expect(await refusal(slackConnector(f as never).verify({ botToken: BOT, appToken: APP }))).toMatch(/connections:write/);
  });

  it('warns about missing DM scopes but still connects', async () => {
    const { f } = fakeFetch((u, i) => (u.endsWith('/auth.test') ? { ...slackOk(u, i), headers: { 'x-oauth-scopes': 'chat:write' } } : slackOk(u, i)));
    const v = await slackConnector(f as never).verify({ botToken: BOT, appToken: APP });
    expect(v.warnings[0]).toMatch(/im:history/);
  });

  it('never repeats a token in an error', async () => {
    const { f } = fakeFetch(() => ({ body: { ok: false, error: 'invalid_auth' } }));
    const msg = await refusal(slackConnector(f as never).verify({ botToken: BOT, appToken: APP }));
    expect(msg).not.toContain(BOT.slice(5, 20));
  });

  it('turns a network failure into plain words', async () => {
    const f = async () => { throw new TypeError('fetch failed'); };
    expect(await refusal(slackConnector(f as never).verify({ botToken: BOT, appToken: APP }))).toMatch(/Couldn't reach Slack/);
  });
});

describe('Discord', () => {
  const ok: Route = (url) => {
    if (url.endsWith('/users/@me')) return { body: { id: '999000999000999000', username: 'taxbot', bot: true } };
    if (url.endsWith('/applications/@me')) return { body: { id: '123456789012345678', name: 'Tax Advisor', flags: 1 << 19 } };
    if (url.endsWith('/users/@me/guilds')) return { body: [{ id: '42', name: 'Krueger Home' }] };
    return { status: 404, body: {} };
  };

  it('accepts a bot token and gives both links', async () => {
    const { f, calls } = fakeFetch(ok);
    const v = await discordConnector(f as never).verify({ token: DTOKEN });
    expect(v).toMatchObject({ accountId: '123456789012345678', displayName: '@taxbot in Krueger Home', warnings: [] });
    expect(v.deepLink).toBe('https://discord.com/users/999000999000999000');
    expect(v.addToServerUrl).toContain(`permissions=${DISCORD_BOT_PERMISSIONS}`);
    expect(calls[0]!.auth).toBe(`Bot ${DTOKEN}`);
  });

  it('warns when Message Content is off or the bot is in no server', async () => {
    const { f } = fakeFetch((u, i) => {
      if (u.endsWith('/applications/@me')) return { body: { id: '1', flags: 0 } };
      if (u.endsWith('/users/@me/guilds')) return { body: [] };
      return ok(u, i);
    });
    const v = await discordConnector(f as never).verify({ token: DTOKEN });
    expect(v.warnings).toHaveLength(2);
    expect(v.warnings[0]).toMatch(/Message Content Intent/);
  });

  it('refuses a rejected token in plain words', async () => {
    const { f } = fakeFetch(() => ({ status: 401, body: { message: '401: Unauthorized' } }));
    expect(await refusal(discordConnector(f as never).verify({ token: DTOKEN }))).toMatch(/Reset Token/);
  });

  it('the permission set is the documented minimum', () => {
    expect(DISCORD_BOT_PERMISSIONS).toBe('274878024768');
  });
});

describe('Discord bot names (2026-09-25)', () => {
  it('a username Discord accepts, or none', async () => {
    const { discordUsernameFor } = await import('../src/channels/discord.js');
    expect(discordUsernameFor('To Do Agent')).toBe('To Do Agent');
    expect(discordUsernameFor('  Taco @home #1: yes  ')).toBe('Taco home 1 yes');
    expect(discordUsernameFor('x')).toBeUndefined();
    expect(discordUsernameFor('My Discord Helper')).toBeUndefined();
    expect(discordUsernameFor('everyone')).toBeUndefined();
    expect(discordUsernameFor('A'.repeat(40))).toHaveLength(32);
  });
  it('rename PATCHes the bot user; a rate limit and a refusal come back in words, never thrown', async () => {
    const { discordConnector } = await import('../src/channels/discord.js');
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let answer: { status: number; body: unknown } = { status: 200, body: { username: 'To Do Agent', global_name: null } };
    const f = async (url: string, init?: RequestInit) => { calls.push({ url, init: init! }); return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } }); };
    const conn = discordConnector(f as never);
    expect(await conn.rename!('tok-secret', 'To Do Agent')).toEqual({ ok: true, name: 'To Do Agent' });
    expect(calls[0]!.url).toBe('https://discord.com/api/v10/users/@me');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ username: 'To Do Agent' });
    expect(String((calls[0]!.init.headers as Record<string, string>).Authorization)).toBe('Bot tok-secret');
    answer = { status: 429, body: { message: 'You are being rate limited.', retry_after: 1800 } };
    const limited = await conn.rename!('tok-secret', 'Taco');
    expect(limited.ok).toBe(false); expect(limited.note).toContain('30 min');
    answer = { status: 400, body: { message: 'Invalid Form Body', errors: { username: { _errors: [{ message: 'Username cannot contain "discord"' }] } } } };
    const refused = await conn.rename!('tok-secret', 'Taco');
    expect(refused.ok).toBe(false); expect(refused.note).toContain('cannot contain');
    expect(refused.note).not.toContain('tok-secret');
    expect((await conn.rename!('tok-secret', 'x')).note).toContain('2–32');
  });
});

