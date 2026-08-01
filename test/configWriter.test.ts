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

    // ONE model source of truth: the runtime default, re-applied every seed.
    // No frozen per-agent --model, and the heal strips pre-existing ones.
    expect(argFor(cmds, 'agents.defaults.model.primary')).toBe('anthropic/claude-opus-4-8');
    const add = cmds.find((c) => c.argv[0] === 'agents')!.argv;
    expect(add).not.toContain('--model');
    expect(cmds.some((c) => c.rawShell?.includes('delete a.model'))).toBe(true);
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
    // per-agent auth stores: once for the bound agent, once for "main"
    // (which the Control UI lands on)
    const pastes = cmds.filter((c) => c.argv.includes('paste-token'));
    expect(pastes).toHaveLength(2);
    expect(pastes.every((p) => p.stdin === 'sk-ant-oat01-secret' && p.sensitive)).toBe(true);
    expect(pastes.some((p) => p.argv[p.argv.indexOf('--agent') + 1] === 'a1')).toBe(true);
    expect(pastes.some((p) => !p.argv.includes('--agent'))).toBe(true);
    // and they must run after `agents add`, which creates the bound agent
    const addIdx = cmds.findIndex((c) => c.argv[1] === 'add');
    for (const p of pastes) expect(cmds.indexOf(p)).toBeGreaterThan(addIdx);

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
    // both auth branches must --replace: an imported volume can carry the
    // other mode's profile (laptop→Spark hit this)
    const auth = cmds.find((c) => c.argv[2] === 'auth.profiles')!;
    expect(auth.argv).toContain('--replace');
    expect(Object.keys(JSON.parse(argFor(cmds, 'agents.defaults.models')!))).toEqual([
      'anthropic/claude-opus-4-8',
    ]);
  });
});
