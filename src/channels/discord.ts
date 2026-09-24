import { callJson, cleanField, ConnectorError, type ChannelConnector, type ConnectorField, type FetchLike, type VerifiedChannel } from './connector.js';

/**
 * Discord: the agent holds an outbound gateway websocket, so nothing on this
 * machine has to be reachable from the internet. One bot token. The bot only
 * sees message text with the Message Content intent turned on, and people can
 * only DM it once they share a server with it.
 */

const FIELDS: ConnectorField[] = [
  {
    key: 'token', label: 'Bot token', pattern: /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/,
    help: 'It is on the application\'s "Bot" page: press Reset Token and copy it.',
  },
];

const API = 'https://discord.com/api/v10';
// Application flags: GATEWAY_MESSAGE_CONTENT (1<<19) and its limited form (1<<18).
const MESSAGE_CONTENT = (1 << 19) | (1 << 18);
// View Channels, Send Messages, Send Messages in Threads, Embed Links,
// Attach Files, Read Message History, Add Reactions.
export const DISCORD_BOT_PERMISSIONS = (1024n + 2048n + (1n << 38n) + 16384n + 32768n + 65536n + 64n).toString();

export function discordAddToServerUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot%20applications.commands&permissions=${DISCORD_BOT_PERMISSIONS}`;
}

export function discordConnector(f: FetchLike = fetch): ChannelConnector {
  const get = (path: string, token: string) =>
    callJson(f, 'Discord', `${API}${path}`, { method: 'GET', headers: { Authorization: `Bot ${token}` } });

  return {
    kind: 'discord',
    label: 'Discord',
    fields: FIELDS,
    hosts: ['discord.com', 'gateway.discord.gg', 'cdn.discordapp.com', 'media.discordapp.net'],

    secretValue(creds) {
      return cleanField(creds, FIELDS[0]!);
    },
    credsFromSecret(secret) {
      return { token: secret };
    },

    async verify(creds): Promise<VerifiedChannel> {
      const token = cleanField(creds, FIELDS[0]!);
      const me = await get('/users/@me', token);
      if (me.status === 401) throw new ConnectorError('Discord refused the bot token. Press Reset Token on the application\'s "Bot" page and paste the new one.');
      if (me.status !== 200 || !me.body?.id) throw new ConnectorError(`Discord refused the bot token (${me.status}).`);
      if (!me.body.bot) throw new ConnectorError('That is not a bot token. Take it from the application\'s "Bot" page.');

      const app = await get('/applications/@me', token);
      if (app.status !== 200 || !app.body?.id) throw new ConnectorError(`Discord would not describe the application (${app.status}).`);

      const warnings: string[] = [];
      if (!((Number(app.body.flags) || 0) & MESSAGE_CONTENT)) {
        warnings.push('Message Content Intent is off, so the agent would see empty messages. Turn it on under the application\'s "Bot" page → Privileged Gateway Intents.');
      }
      const guilds = await get('/users/@me/guilds', token);
      const servers = Array.isArray(guilds.body) ? guilds.body.slice(0, 20).map((g: any) => ({ id: String(g.id), name: String(g.name ?? '') })) : [];
      if (!servers.length) warnings.push('The bot is not in any server yet. Add it to one of yours, or nobody can message it.');

      const applicationId = String(app.body.id);
      const botName = String(me.body.global_name ?? me.body.username ?? 'the bot');
      return {
        accountId: applicationId,
        displayName: servers.length ? `@${botName} in ${servers.map((g: { name: string }) => g.name).join(', ')}` : `@${botName}`,
        deepLink: `https://discord.com/users/${encodeURIComponent(String(me.body.id))}`,
        addToServerUrl: discordAddToServerUrl(applicationId),
        settings: { botUserId: String(me.body.id), botName, servers, applicationName: String(app.body.name ?? ''), checkedAt: new Date().toISOString() },
        warnings,
      };
    },
  };
}
