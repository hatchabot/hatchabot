import { describe, expect, it } from 'vitest';
import { buildConfigCommands } from '../src/openclaw/configWriter.js';

const argFor = (cmds: ReturnType<typeof buildConfigCommands>, path: string): string | undefined =>
  cmds.find((c) => c.argv[0] === 'config' && c.argv[2] === path)?.argv[3];

describe('buildConfigCommands multi-model', () => {
  it('registers every model on claude-cli, primary first and deduped', () => {
    const cmds = buildConfigCommands({
      agentId: 'a1',
      model: 'claude-opus-4-8',
      models: ['claude-sonnet-5', 'claude-opus-4-8'], // repeats primary — must dedupe
      authMode: 'oauth-claude-cli',
    });

    const models = JSON.parse(argFor(cmds, 'agents.defaults.models')!);
    expect(Object.keys(models)).toEqual(['anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-5']);
    expect(models['anthropic/claude-sonnet-5']).toEqual({ agentRuntime: { id: 'claude-cli' } });
    // --replace: without it OpenClaw refuses a set that would drop entries
    // (hit when re-seeding an imported volume that had more models).
    const modelsCmd = cmds.find((c) => c.argv[2] === 'agents.defaults.models')!;
    expect(modelsCmd.argv).toContain('--replace');

    // 2026.6.11 rejects agents.defaults.modelPolicy — must not be emitted.
    expect(argFor(cmds, 'agents.defaults.modelPolicy')).toBeUndefined();

    const add = cmds.find((c) => c.argv[0] === 'agents')!.argv;
    expect(add[add.indexOf('--model') + 1]).toBe('anthropic/claude-opus-4-8');
  });

  it('configures models for api-key auth without claude-cli runtime entries', () => {
    const cmds = buildConfigCommands({
      agentId: 'a1',
      model: 'claude-sonnet-5',
      models: ['claude-haiku-4-5'],
      authMode: 'api-key',
    });
    const models = JSON.parse(argFor(cmds, 'agents.defaults.models')!);
    expect(Object.keys(models)).toEqual(['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5']);
    expect(models['anthropic/claude-haiku-4-5']).toEqual({});
  });

  it('keeps the single-model shape when models is absent', () => {
    const cmds = buildConfigCommands({
      agentId: 'a1',
      model: 'claude-opus-4-8',
      authMode: 'oauth-claude-cli',
    });
    expect(Object.keys(JSON.parse(argFor(cmds, 'agents.defaults.models')!))).toEqual([
      'anthropic/claude-opus-4-8',
    ]);
  });
});
