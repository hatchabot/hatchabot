import { callJson, cleanField, ConnectorError, type ChannelConnector, type ConnectorField, type FetchLike, type VerifiedChannel } from './connector.js';

/**
 * Slack in Socket Mode: the agent holds an outbound websocket, so nothing on
 * this machine has to be reachable from the internet. Needs two tokens from
 * one Slack app: the bot token (xoxb-) and an app-level token (xapp-) with
 * connections:write.
 */

const FIELDS: ConnectorField[] = [
  {
    key: 'botToken', label: 'Bot token', pattern: /^xoxb-[A-Za-z0-9-]{20,}$/,
    help: 'It starts with xoxb- and is on the app\'s "OAuth & Permissions" page, after you install the app to your workspace.',
  },
  {
    key: 'appToken', label: 'App-level token', pattern: /^xapp-[A-Za-z0-9-]{20,}$/,
    help: 'It starts with xapp- and is made on the app\'s "Basic Information" page, under App-Level Tokens, with the connections:write scope.',
  },
];

/** Scopes without which DMs don't work. */
const NEEDED_SCOPES = ['chat:write', 'im:history', 'im:read', 'im:write', 'app_mentions:read'];

/** xapp-1-A0123ABCD-… → A0123ABCD */
export function slackAppIdFromAppToken(appToken: string): string | undefined {
  const m = /^xapp-\d+-(A[A-Z0-9]+)-/.exec(appToken);
  return m?.[1];
}

/** The app manifest the owner pastes into Slack: OpenClaw's minimal Socket Mode app, named for the agent. */
export function slackManifest(agentName: string): Record<string, unknown> {
  const name = (agentName.trim() || 'Hatchabot agent').slice(0, 35);
  return {
    display_information: { name, description: `${name}, a Hatchabot agent` },
    features: {
      bot_user: { display_name: name.slice(0, 80), always_online: true },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read', 'channels:history', 'channels:read', 'chat:write', 'files:read', 'files:write',
          'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write', 'mpim:history', 'mpim:read',
          'reactions:read', 'reactions:write', 'users:read',
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      event_subscriptions: {
        bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim', 'reaction_added'],
      },
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

export function slackConnector(f: FetchLike = fetch): ChannelConnector {
  const api = (method: string, token: string) =>
    callJson(f, 'Slack', `https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });

  return {
    kind: 'slack',
    label: 'Slack',
    fields: FIELDS,
    hosts: ['slack.com', 'wss-primary.slack.com', 'wss-backup.slack.com', 'files.slack.com'],

    secretValue(creds) {
      return JSON.stringify({ botToken: cleanField(creds, FIELDS[0]!), appToken: cleanField(creds, FIELDS[1]!) });
    },

    async verify(creds): Promise<VerifiedChannel> {
      const botToken = cleanField(creds, FIELDS[0]!);
      const appToken = cleanField(creds, FIELDS[1]!);
      const appId = slackAppIdFromAppToken(appToken);
      if (!appId) throw new ConnectorError('That app-level token is not in the form Slack issues (xapp-1-A…).');

      const auth = await api('auth.test', botToken);
      if (!auth.body?.ok) {
        const e = String(auth.body?.error ?? auth.status);
        if (e === 'invalid_auth' || e === 'not_authed' || e === 'token_revoked' || e === 'account_inactive') {
          throw new ConnectorError('Slack refused the bot token. Copy it again from "OAuth & Permissions" (reinstall the app if you changed its scopes).');
        }
        throw new ConnectorError(`Slack refused the bot token (${e}).`);
      }
      if (!auth.body.bot_id || !auth.body.user_id) {
        throw new ConnectorError('That token is not a bot token. Use the "Bot User OAuth Token" (xoxb-), not a user token.');
      }

      // The two tokens must belong to the same app, or the agent would listen
      // as one app and answer as another.
      const bot = await callJson(f, 'Slack', `https://slack.com/api/bots.info?bot=${encodeURIComponent(auth.body.bot_id)}`, {
        method: 'GET', headers: { Authorization: `Bearer ${botToken}` },
      });
      const botApp = bot.body?.bot?.app_id;
      if (botApp && botApp !== appId) {
        throw new ConnectorError('The two tokens are from different Slack apps. Take both from the same app.');
      }

      const conn = await api('apps.connections.open', appToken);
      if (!conn.body?.ok) {
        const e = String(conn.body?.error ?? conn.status);
        if (e === 'missing_scope') throw new ConnectorError('The app-level token needs the connections:write scope. Make a new one with that scope.');
        if (e === 'not_allowed_token_type') throw new ConnectorError('The second box needs the app-level token (xapp-), not the bot token.');
        if (e === 'invalid_auth') throw new ConnectorError('Slack refused the app-level token. Make a new one on "Basic Information" → App-Level Tokens.');
        throw new ConnectorError(`Slack refused the app-level token (${e}). Check that Socket Mode is turned on for the app.`);
      }

      const warnings: string[] = [];
      const scopes = (auth.headers.get('x-oauth-scopes') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      if (scopes.length) {
        const missing = NEEDED_SCOPES.filter((sc) => !scopes.includes(sc));
        if (missing.length) warnings.push(`The app is missing ${missing.join(', ')}, so direct messages won't reach the agent. Add them under "OAuth & Permissions", then reinstall the app.`);
      }

      const team = String(auth.body.team ?? 'your workspace');
      const teamId = String(auth.body.team_id ?? '');
      const botName = String(auth.body.user ?? 'the bot');
      return {
        accountId: String(auth.body.user_id),
        displayName: `@${botName} in ${team}`,
        deepLink: `https://slack.com/app_redirect?app=${encodeURIComponent(appId)}${teamId ? `&team=${encodeURIComponent(teamId)}` : ''}`,
        settings: { team, teamId, appId, botName },
        warnings,
      };
    },
  };
}
