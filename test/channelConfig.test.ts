import { describe, expect, it } from 'vitest';
import { buildConfigCommands, channelPluginDir, describeConfigCommands } from '../src/openclaw/configWriter.js';

/** Slack and Discord in OpenClaw's config: only where the image has the plugin, and convergent. */

const base = { agentId: 'tax', model: 'm', authMode: 'api-key' as const };
const argvs = (p: Parameters<typeof buildConfigCommands>[0]) => buildConfigCommands(p).map((c) => c.argv.join(' '));
const sets = (p: Parameters<typeof buildConfigCommands>[0]) =>
  Object.fromEntries(buildConfigCommands(p).filter((c) => c.argv[0] === 'config' && c.argv[1] === 'set').map((c) => [c.argv[2], c.argv[3]]));

const slack = { botToken: 'xoxb-secret', appToken: 'xapp-secret', allowFrom: ['U1'], rooms: { mode: 'off' as const } };
const discord = { token: 'discord-secret', applicationId: '123', allowFrom: ['9'], rooms: { mode: 'off' as const } };

describe('channel config', () => {
  it('an image without the plugins gets exactly the old commands', () => {
    expect(argvs({ ...base, slack, discord })).toEqual(argvs(base));
    expect(argvs({ ...base, channelPlugins: [] })).toEqual(argvs(base));
  });

  it('writes Slack whole: plugin link, socket mode, one account, rooms off', () => {
    const p = { ...base, channelPlugins: ['slack', 'discord'], slack };
    const a = argvs(p);
    expect(a).toContain(`plugins install --link ${channelPluginDir('slack')}`);
    expect(a).toContain('plugins enable slack');
    const s = sets(p);
    expect(s['channels.slack.enabled']).toBe('true');
    expect(s['channels.slack.mode']).toBe('socket');
    expect(s['channels.slack.groupPolicy']).toBe('disabled');
    expect(JSON.parse(s['channels.slack.channels']!)).toEqual({});
    expect(JSON.parse(s['channels.slack.accounts']!)).toEqual({
      hatchabot: { enabled: true, botToken: 'xoxb-secret', appToken: 'xapp-secret', dmPolicy: 'pairing', allowFrom: ['U1'] },
    });
    expect(a).toContain('agents bind --agent tax --bind slack:hatchabot');
    // Discord is in the image but not set up: switched off and emptied.
    expect(s['channels.discord.enabled']).toBe('false');
    expect(s['channels.discord.accounts']).toBe('{}');
    expect(a).toContain('agents unbind --agent tax --bind discord:hatchabot');
    expect(buildConfigCommands(p).find((c) => c.argv[1] === 'unbind')?.optional).toBe(true);
  });

  it('one room is members-only and needs an @mention', () => {
    const s = sets({ ...base, channelPlugins: ['slack', 'discord'],
      slack: { ...slack, rooms: { mode: 'room', roomId: 'C012AB3CD' } },
      discord: { ...discord, rooms: { mode: 'room', roomId: '333333333333333333' } } });
    expect(s['channels.slack.groupPolicy']).toBe('allowlist');
    expect(JSON.parse(s['channels.slack.channels']!)).toEqual({ C012AB3CD: { enabled: true, requireMention: true, users: ['U1'] } });
    expect(s['channels.discord.groupPolicy']).toBe('allowlist');
    expect(JSON.parse(s['channels.discord.guilds']!)).toEqual({ '333333333333333333': { requireMention: true, ignoreOtherMentions: true, users: ['9'] } });
  });

  it('Discord takes its own proxy setting for the management agent', () => {
    const s = sets({ ...base, channelPlugins: ['discord'], discord: { ...discord, proxy: 'http://ops:k@10.0.0.1:8091' } });
    expect(s['channels.discord.proxy']).toBe('http://ops:k@10.0.0.1:8091');
    expect(JSON.parse(s['channels.discord.accounts']!).hatchabot).toMatchObject({ token: 'discord-secret', applicationId: '123' });
  });

  it('tokens never reach the log', () => {
    const logged = describeConfigCommands(buildConfigCommands({ ...base, channelPlugins: ['slack', 'discord'], slack, discord: { ...discord, proxy: 'http://ops:k@h:1' } })).join('\n');
    for (const secret of ['xoxb-secret', 'xapp-secret', 'discord-secret', 'ops:k@']) expect(logged).not.toContain(secret);
  });
});
