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

/**
 * A Discord bot username for an agent's name. Discord's rules: 2–32
 * characters; no `@`, `#`, `:` or code fences; not "discord" anywhere,
 * not "everyone" or "here". A name that cannot be made to fit comes back
 * undefined and the bot keeps its name.
 */
export function discordUsernameFor(agentName: string): string | undefined {
  const cleaned = agentName.replace(/[@#:`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32).trim();
  if (cleaned.length < 2) return undefined;
  if (/discord/i.test(cleaned) || /^(everyone|here)$/i.test(cleaned)) return undefined;
  return cleaned;
}

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

    // Discord has no "message a user" call: a DM is a channel opened with that
    // person (idempotent — the same one comes back), then a message in it. It
    // only works for people who share a server with the bot; a refusal is
    // simply false. Used for the farewells and moving notes Telegram members
    // get, and the "this bot is now X" marker on a reused pool bot.
    async dm(secret, userId, text) {
      if (!/^\d{15,25}$/.test(userId)) return false;
      const headers = { Authorization: `Bot ${secret}`, 'content-type': 'application/json' };
      try {
        const ch = await callJson(f, 'Discord', `${API}/users/@me/channels`, { method: 'POST', headers, body: JSON.stringify({ recipient_id: userId }) });
        if (ch.status !== 200 || !ch.body?.id) return false;
        const msg = await callJson(f, 'Discord', `${API}/channels/${encodeURIComponent(String(ch.body.id))}/messages`, { method: 'POST', headers, body: JSON.stringify({ content: text.slice(0, 2000) }) });
        return msg.status === 200;
      } catch { return false; }
    },

    // A bot's shown name IS its username (bots have no display name of their
    // own), so this is a username change: Discord allows a bot a couple an
    // hour, and refuses a few words. Pool bots are renamed when leased, like
    // Telegram's; a bot the owner made is renamed on request, or when the
    // agent is renamed.
    async rename(secret, name) {
      const username = discordUsernameFor(name);
      if (!username) return { ok: false, note: 'Discord does not allow that as a bot name (2–32 characters; not "discord", "everyone" or "here").' };
      const res = await callJson(f, 'Discord', `${API}/users/@me`, {
        method: 'PATCH', headers: { Authorization: `Bot ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ username }),
      }).catch((err: unknown) => ({ status: 0, body: undefined, note: err instanceof ConnectorError ? err.userMessage : String(err) } as { status: number; body: any; note?: string }));
      if (res.status === 200) return { ok: true, name: String(res.body?.global_name ?? res.body?.username ?? username) };
      if (res.status === 0) return { ok: false, note: (res as { note?: string }).note ?? "Couldn't reach Discord." };
      const retry = Number(res.body?.retry_after);
      if (res.status === 429 || /too fast|rate limit/i.test(String(res.body?.message ?? ''))) {
        return { ok: false, note: `Discord allows a bot only a few name changes an hour — try again${Number.isFinite(retry) && retry > 0 ? ` in ${Math.ceil(retry / 60)} min` : ' later'}.` };
      }
      if (res.status === 401) return { ok: false, note: 'Discord refused the bot token. Re-check the bot, or reset its token and set it up again.' };
      const detail = String(res.body?.errors?.username?._errors?.[0]?.message ?? res.body?.message ?? `HTTP ${res.status}`);
      return { ok: false, note: `Discord refused the name: ${detail}` };
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
