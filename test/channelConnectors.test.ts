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
