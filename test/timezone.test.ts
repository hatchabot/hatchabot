import { describe, expect, it } from 'vitest';
import { agentTimeZone, machineTimeZone, validTimeZone } from '../src/orchestrator/timezone.js';
import { buildConfigCommands } from '../src/openclaw/configWriter.js';

/**
 * Agents live in a time zone (2026-10-07: with OpenClaw's userTimezone unset and
 * containers on UTC, every agent was four hours off for an owner in Toronto).
 */
describe('agent time zone', () => {
  it('takes HATCHABOT_TIMEZONE when it is a real zone, else the machine\'s', () => {
    expect(agentTimeZone({ HATCHABOT_TIMEZONE: 'America/Vancouver' })).toBe('America/Vancouver');
    expect(agentTimeZone({ HATCHABOT_TIMEZONE: 'Mars/Olympus' })).toBe(machineTimeZone());
    expect(agentTimeZone({ HATCHABOT_TIMEZONE: '$(rm -rf /)' })).toBe(machineTimeZone());
    expect(agentTimeZone({})).toBe(machineTimeZone());
    expect(validTimeZone('UTC')).toBe(true);
    expect(validTimeZone('Asia/Tokyo')).toBe(true);
    expect(validTimeZone('')).toBe(false);
  });

  it('is written into the agent\'s OpenClaw config', () => {
    const cmds = buildConfigCommands({ agentId: 'a1', authMode: 'api-key', userTimezone: 'America/Toronto' } as never);
    const set = cmds.flatMap((c) => c.argv.join(' ').includes('userTimezone') ? [c.argv] : []);
    expect(set).toEqual([['config', 'set', 'agents.defaults.userTimezone', 'America/Toronto']]);
    const none = buildConfigCommands({ agentId: 'a1', authMode: 'api-key' } as never);
    expect(none.some((c) => c.argv.join(' ').includes('userTimezone'))).toBe(false);
  });
});
