import { describe, expect, it } from 'vitest';
import {
  batchConfigCommands,
  buildConfigCommands,
  describeConfigCommands,
} from '../src/openclaw/configWriter.js';

const argFor = (cmds: ReturnType<typeof buildConfigCommands>, path: string): string | undefined =>
  cmds.find((c) => c.argv[0] === 'config' && c.argv[2] === path)?.argv[3];

describe('batchConfigCommands', () => {
  it('collapses consecutive plain sets into one invocation, preserving order', () => {
    const raw = buildConfigCommands({
      agentId: 'a1', model: 'm', authMode: 'api-key', provider: 'ollama', gatewayToken: 'x',
      telegram: { accountId: 'b', botToken: 't', dmPolicy: 'pairing', allowFrom: ['1'] },
    });
    const batched = batchConfigCommands(raw);
    expect(batched.length).toBeLessThan(raw.length);

    const batch = batched.find((c) => c.argv.includes('--batch-json'))!;
    const ops = JSON.parse(batch.argv[batch.argv.indexOf('--batch-json') + 1]!);
    const rawSets = raw.filter((c) => !c.rawShell && !c.stdin && c.argv[1] === 'set');
    expect(ops.map((o: any) => o.path)).toEqual(rawSets.map((c) => c.argv[2]));
    // Object values must survive as OBJECTS. Passing the JSON string makes
    // OpenClaw reject it: "expected record, received string".
    const providers = ops.find((o: any) => o.path === 'models.providers.ollama');
    expect(typeof providers.value).toBe('object');
    expect(providers.value.api).toBe('openai-completions');
    // and a plain scalar stays a plain string
    expect(ops.find((o: any) => o.path === 'gateway.mode').value).toBe('local');
    // booleans must become real booleans — 'true' as a string is rejected
    // with "channels.telegram.enabled: must be boolean"
    expect(ops.find((o: any) => o.path === 'channels.telegram.enabled').value).toBe(true);
  });

  it('never merges across a non-set command', () => {
    const batched = batchConfigCommands([
      { argv: ['config', 'set', 'a', '1'] },
      { argv: ['agents', 'add', 'x'] },
      { argv: ['config', 'set', 'b', '2'] },
    ]);
    // agents add must still sit between them: config order is load-bearing
    expect(batched.map((c) => c.argv[0])).toEqual(['config', 'agents', 'config']);
  });

  it('keeps a stdin command (paste-token) separate and marks the batch sensitive', () => {
    const batched = batchConfigCommands([
      { argv: ['config', 'set', 'auth.token', 'secret'], sensitive: true },
      { argv: ['config', 'set', 'gateway.mode', 'local'] },
      { argv: ['models', 'auth', 'paste-token'], stdin: 'tok', sensitive: true },
    ]);
    expect(batched).toHaveLength(2);
    expect(batched[0]!.sensitive).toBe(true);
    expect(batched[1]!.stdin).toBe('tok');
    // the batch payload holds secret VALUES, so the whole payload is masked
    const described = describeConfigCommands(batched).join('\n');
    expect(described).not.toContain('secret');
    expect(described).toContain('--batch-json <redacted>');
  });
});

describe('web search provider', () => {
  it('enables the keyless DuckDuckGo provider for every agent', () => {
    // Stock-but-disabled DDG meant web_search told every agent "search is not
    // available" while answers quietly degraded to model knowledge.
    const cmds = buildConfigCommands({ agentId: 'a1', model: 'm', authMode: 'api-key' });
    expect(cmds.some((c) => c.argv.join(' ') === 'plugins enable duckduckgo')).toBe(true);
  });

  it('points memory search at the keyless local embedding model', () => {
    // The OpenAI default made semantic memory recall silently dead fleet-wide.
    const cmds = buildConfigCommands({ agentId: 'a1', model: 'm', authMode: 'api-key' });
    expect(argFor(cmds, 'agents.defaults.memorySearch.provider')).toBe('local');
  });
});

describe('local embedding provider (image-baked)', () => {
  // provider=local is inert without the `local` provider plugin present. The
  // plugin + model are baked into the image; each agent links the plugin (no
  // volume copy) and points modelPath at the shared model file.
  const cmds = buildConfigCommands({ agentId: 'a1', model: 'm', authMode: 'api-key' });

  it('links the baked plugin instead of copying it onto the volume', () => {
    const link = cmds.find((c) => c.argv[0] === 'plugins' && c.argv[1] === 'install');
    expect(link?.argv).toEqual([
      'plugins', 'install', '--link', '/opt/agentclaw/llama-cpp/llama-cpp-provider',
    ]);
    expect(cmds.some((c) => c.argv.join(' ') === 'plugins enable llama-cpp')).toBe(true);
  });

  it('points modelPath at the shared image model, not the hf: URI', () => {
    // A bare `hf:` default would download 314MB to the volume on first index.
    expect(argFor(cmds, 'agents.defaults.memorySearch.local.modelPath')).toBe(
      '/opt/agentclaw/models/embeddinggemma-300m-qat-Q8_0.gguf',
    );
  });

  it('keeps the plugin verbs out of the batched set run', () => {
    // install/enable are not `config set` — they must not collapse into a batch.
    const batched = batchConfigCommands(cmds);
    const batch = batched.find((c) => c.argv.includes('--batch-json'));
    const paths = batch ? JSON.parse(batch.argv[batch.argv.indexOf('--batch-json') + 1]!).map((o: any) => o.path) : [];
    expect(paths).toContain('agents.defaults.memorySearch.local.modelPath');
    expect(paths).not.toContain('plugins');
    expect(batched.some((c) => c.argv.join(' ') === 'plugins enable llama-cpp')).toBe(true);
  });
});

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

  it('local vendor: ollama provider block, ollama/ refs, no anthropic auth', () => {
    const cmds = buildConfigCommands({
      agentId: 'a1',
      model: 'qwen3.6:27b-q8_0',
      models: ['qwen3.6:35b-a3b-q8_0'],
      authMode: 'api-key',
      provider: 'ollama',
      baseUrl: 'http://172.17.0.1:11434/v1',
    });

    const prov = JSON.parse(argFor(cmds, 'models.providers.ollama')!);
    expect(prov).toMatchObject({
      baseUrl: 'http://172.17.0.1:11434/v1',
      api: 'openai-completions',
    });

    // refs and the default carry the ollama prefix, not anthropic
    expect(argFor(cmds, 'agents.defaults.model.primary')).toBe('ollama/qwen3.6:27b-q8_0');
    const models = JSON.parse(argFor(cmds, 'agents.defaults.models')!);
    expect(Object.keys(models)).toEqual(['ollama/qwen3.6:27b-q8_0', 'ollama/qwen3.6:35b-a3b-q8_0']);
    // served directly — never through the claude-cli runtime
    expect(models['ollama/qwen3.6:27b-q8_0']).toEqual({});
    // and no Anthropic credential plumbing — the profile map is cleared so a
    // leftover claude-cli entry can't be preferred by the gateway
    expect(argFor(cmds, 'auth.profiles')).toBe('{}');
    expect(cmds.some((c) => c.argv.includes('paste-token'))).toBe(false);
  });

  it('clears any stale ollama provider block for anthropic profiles', () => {
    const cmds = buildConfigCommands({ agentId: 'a1', model: 'claude-opus-4-8', authMode: 'api-key' });
    // Moving OFF local must not leave the old server configured.
    expect(argFor(cmds, 'models.providers.ollama')).toBe('{}');
    expect(argFor(cmds, 'agents.defaults.model.primary')).toBe('anthropic/claude-opus-4-8');
  });

  it('defaults the ollama baseUrl to the bridge, never loopback', () => {
    const cmds = buildConfigCommands({ agentId: 'a1', model: 'm', authMode: 'api-key', provider: 'ollama' });
    const prov = JSON.parse(argFor(cmds, 'models.providers.ollama')!);
    // localhost inside a container is the container — the classic misconfig.
    expect(prov.baseUrl).toBe('http://172.17.0.1:11434/v1');
    expect(prov.baseUrl).not.toContain('localhost');
  });

  it('routes a google profile through the google provider, not anthropic', () => {
    const cmds = buildConfigCommands({ agentId: 'a1', model: 'gemini-3-pro', authMode: 'api-key', provider: 'google' });
    expect(argFor(cmds, 'agents.defaults.model.primary')).toBe('google/gemini-3-pro');
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
