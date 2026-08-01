import { describe, expect, it } from 'vitest';
import { buildConfigCommands, describeConfigCommands } from '../src/openclaw/configWriter.js';

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

  it('setup-token auth: paste-token via stdin, native provider, no claude-cli', () => {
    const cmds = buildConfigCommands({
      agentId: 'a1',
      model: 'claude-opus-4-8',
      authMode: 'oauth-claude-cli',
      setupToken: 'sk-ant-oat01-secret',
    });
    const paste = cmds.find((c) => c.argv.includes('paste-token'))!;
    expect(paste.stdin).toBe('sk-ant-oat01-secret');
    expect(paste.sensitive).toBe(true);
    // per-agent auth store: without --agent the token lands in agent "main"
    expect(paste.argv[paste.argv.indexOf('--agent') + 1]).toBe('a1');
    // and it must run after `agents add`, which creates that agent
    expect(cmds.indexOf(paste)).toBeGreaterThan(cmds.findIndex((c) => c.argv[1] === 'add'));

    const auth = JSON.parse(cmds.find((c) => c.argv[2] === 'auth.profiles')!.argv[3]!);
    expect(auth).toEqual({ 'anthropic:manual': { provider: 'anthropic', mode: 'token' } });

    const models = JSON.parse(argFor(cmds, 'agents.defaults.models')!);
    expect(models['anthropic/claude-opus-4-8']).toEqual({}); // native provider, no claude-cli

    // the token must never appear in log rendering
    const described = describeConfigCommands(cmds).join('\n');
    expect(described).not.toContain('sk-ant-oat01-secret');
    expect(described).toContain('<redacted> | openclaw models auth --agent a1 paste-token');
  });

  it('gateway token: binds auto behind token auth, redacted in logs', () => {
    const cmds = buildConfigCommands({
      agentId: 'a1',
      model: 'claude-opus-4-8',
      authMode: 'api-key',
      gatewayToken: 'gw-secret-token',
    });
    expect(argFor(cmds, 'gateway.auth.mode')).toBe('token');
    expect(argFor(cmds, 'gateway.auth.token')).toBe('gw-secret-token');
    expect(argFor(cmds, 'gateway.bind')).toBe('auto');
    // page origin varies (localhost/tailnet/LAN) — token is the real gate
    expect(argFor(cmds, 'gateway.controlUi.allowedOrigins')).toBe('["*"]');
    expect(describeConfigCommands(cmds).join('\n')).not.toContain('gw-secret-token');
  });

  it('gateway stays loopback + no auth without a token', () => {
    const cmds = buildConfigCommands({ agentId: 'a1', model: 'm', authMode: 'api-key' });
    expect(argFor(cmds, 'gateway.auth.mode')).toBe('none');
    expect(argFor(cmds, 'gateway.bind')).toBe('loopback');
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
