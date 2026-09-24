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

describe('group-chat access (GroupAccess → openclaw config)', () => {
  const base = {
    agentId: 'a1', model: 'm', authMode: 'api-key' as const, provider: 'ollama' as const, gatewayToken: 'x',
  };
  const tg = (groupAccess?: { mode: 'off' | 'members' | 'room'; roomId?: string }) => ({
    ...base,
    telegram: { accountId: 'b', botToken: 't', dmPolicy: 'pairing' as const, allowFrom: ['1'], groupAccess },
  });

  it('absent CONVERGES to members-only — a cleared open-room must not survive on the volume', () => {
    const cmds = buildConfigCommands(tg(undefined));
    expect(argFor(cmds, 'channels.telegram.groupPolicy')).toBe('allowlist');
    expect(JSON.parse(argFor(cmds, 'channels.telegram.groups')!)).toEqual({});
  });

  it("'off' disables groups; groups map is emptied so nothing stale survives", () => {
    const cmds = buildConfigCommands(tg({ mode: 'off' }));
    expect(argFor(cmds, 'channels.telegram.groupPolicy')).toBe('disabled');
    expect(JSON.parse(argFor(cmds, 'channels.telegram.groups')!)).toEqual({});
  });

  it("'room' opens exactly ONE bound chat, mention-gated — never channel-wide", () => {
    const cmds = buildConfigCommands(tg({ mode: 'room', roomId: '-1001234567890' }));
    expect(argFor(cmds, 'channels.telegram.groupPolicy')).toBe('allowlist'); // channel stays closed
    const groups = JSON.parse(argFor(cmds, 'channels.telegram.groups')!);
    expect(groups).toEqual({ '-1001234567890': { groupPolicy: 'open', requireMention: true } });
  });

  it("switching back to 'members' converges: policy allowlist, groups emptied", () => {
    const cmds = buildConfigCommands(tg({ mode: 'members' }));
    expect(argFor(cmds, 'channels.telegram.groupPolicy')).toBe('allowlist');
    expect(JSON.parse(argFor(cmds, 'channels.telegram.groups')!)).toEqual({});
  });
});

describe('web search is always on (mandatory baseline)', () => {
  const base = { agentId: 'a1', model: 'm', authMode: 'api-key' as const, provider: 'ollama' as const, gatewayToken: 'x' };
  it('every agent gets tools.web.search.enabled true — never false (a false write would have disabled the live fleet, whose configs have it unset-and-working)', () => {
    const cmds = buildConfigCommands(base);
    expect(argFor(cmds, 'tools.web.search.enabled')).toBe('true');
  });
});

describe('telegram rich messages (managed default ON)', () => {
  const base = { agentId: 'a1', model: 'm', authMode: 'api-key' as const, provider: 'ollama' as const, gatewayToken: 'x' };
  const tg = (richMessages?: boolean) => ({
    ...base,
    telegram: { accountId: 'b', botToken: 't', dmPolicy: 'pairing' as const, allowFrom: ['1'], richMessages },
  });

  it('unset and true both write true — OpenClaw\'s own default is plain text, ours is rich', () => {
    expect(argFor(buildConfigCommands(tg(undefined)), 'cron.triggers.enabled')).toBe('false'); // off unless opted in
    expect(argFor(buildConfigCommands({ ...tg(undefined), cronTriggers: true }), 'cron.triggers.enabled')).toBe('true');
    expect(argFor(buildConfigCommands(tg(undefined)), 'channels.telegram.richMessages')).toBe('true');
    expect(argFor(buildConfigCommands(tg(true)), 'channels.telegram.richMessages')).toBe('true');
  });

  it('an explicit opt-out writes false — and the write always happens (convergent)', () => {
    expect(argFor(buildConfigCommands(tg(false)), 'channels.telegram.richMessages')).toBe('false');
  });
});

describe('session continuity (idle window + active-memory)', () => {
  const base = { agentId: 'cross-country-agent', model: 'm', authMode: 'api-key' as const, provider: 'ollama' as const, gatewayToken: 'x' };
  it('writes a 30-day idle reset window so overnight gaps resume, not reset', () => {
    const v = argFor(buildConfigCommands(base), 'session.reset');
    expect(JSON.parse(v!)).toEqual({ mode: 'idle', idleMinutes: 43200 });
  });
  it('enables active-memory scoped to THIS agent and direct chats', () => {
    const v = JSON.parse(argFor(buildConfigCommands(base), 'plugins.entries.active-memory')!);
    expect(v.enabled).toBe(true);
    expect(v.config.enabled).toBe(true);
    expect(v.config.agents).toEqual(['cross-country-agent']); // the slug, not "main"
    expect(v.config.allowedChatTypes).toEqual(['direct']);
    // no pinned recall model → inherits the session model
    expect(v.config.model).toBeUndefined();
  });
});

describe('the OpenClaw console shows the agent by its Hatchabot name', () => {
  // `agents add` takes only the id, so the console labelled every agent by its
  // slug ("stock-advisor") instead of what the owner calls it.
  it('sets the identity name after adding the agent, and never lets it fail a provision', () => {
    const cmds = buildConfigCommands({ agentId: 'stock-advisor', displayName: 'Stock Advisor', authMode: 'api-key' } as never);
    const i = cmds.findIndex((c) => c.argv[0] === 'agents' && c.argv[1] === 'set-identity');
    expect(i).toBeGreaterThan(-1);
    expect(cmds[i]!.argv).toEqual(['agents', 'set-identity', '--agent', 'stock-advisor', '--name', 'Stock Advisor']);
    expect(cmds[i]!.optional).toBe(true);
    // …and only once the agent exists.
    const add = cmds.findIndex((c) => c.argv[0] === 'agents' && c.argv[1] === 'add');
    expect(add).toBeLessThan(i);
  });

  it('adds nothing when no name is known', () => {
    const cmds = buildConfigCommands({ agentId: 'x', authMode: 'api-key' } as never);
    expect(cmds.some((c) => c.argv[1] === 'set-identity')).toBe(false);
  });
});

describe('the 2026.9 port (OpenClaw 2026.8 and later)', () => {
  const base = { agentId: 'todo', authMode: 'api-key' as const, model: 'm' };
  it('heals a 2026.7 volume before the first CLI command, then runs doctor\'s safe migrations', () => {
    const cmds = buildConfigCommands({ ...base, openclawVersion: '2026.9.6' });
    const heal = cmds[0]!;
    expect(heal.rawShell).toContain('lastTouchedAt');
    expect(heal.rawShell).toContain('memorySearch');
    expect(heal.rawShell).toContain('ownership="explicit"');
    const doctor = cmds.findIndex((c) => c.argv[0] === 'doctor');
    expect(cmds[doctor]).toMatchObject({ argv: ['doctor', '--fix', '--non-interactive'], optional: true });
    expect(cmds.filter((c) => c.argv[0] === 'doctor')).toHaveLength(2); // the second pass finishes what the first refused
    // Every JSON edit precedes doctor; doctor precedes every other CLI command.
    expect(cmds.slice(0, doctor).every((c) => c.argv.length === 0)).toBe(true);
    expect(cmds.slice(0, doctor).some((c) => c.rawShell?.includes('llama-cpp'))).toBe(false);
    const firstCli = cmds.findIndex((c) => c.argv.length && c.argv[0] !== 'doctor');
    expect(firstCli).toBeGreaterThan(doctor);
  });
  it('a shared-engine agent also drops the stale llama-cpp install record (optional, after doctor)', () => {
    const cmds = buildConfigCommands({ ...base, openclawVersion: '2026.9.6', embed: { baseUrl: 'http://d/v1', token: 't', model: 'e' } });
    const un = cmds.findIndex((c) => c.argv.join(' ') === 'plugins uninstall llama-cpp --force');
    expect(un).toBeGreaterThan(cmds.findIndex((c) => c.argv[0] === 'doctor'));
    expect(cmds[un]!.optional).toBe(true);
    expect(buildConfigCommands({ ...base, openclawVersion: '2026.7.1-2' }).some((c) => c.argv[1] === 'uninstall')).toBe(false);
  });
  it('a shared-engine agent moving to 2026.9 has its llama-cpp link removed before doctor looks', () => {
    const cmds = buildConfigCommands({ ...base, openclawVersion: '2026.9.6', embed: { baseUrl: 'http://d/v1', token: 't', model: 'e' } });
    const doctor = cmds.findIndex((c) => c.argv[0] === 'doctor');
    expect(cmds.slice(0, doctor).some((c) => c.rawShell?.includes('llama-cpp'))).toBe(true);
    expect(cmds.findIndex((c) => c.argv.join(' ') === 'plugins registry --refresh')).toBeGreaterThan(doctor);
  });
  it('links on 2026.8+ carry the install options a local path needs; 2026.7 links carry none', () => {
    const nine = buildConfigCommands({ ...base, openclawVersion: '2026.9.6', bakedPlugins: ['duckduckgo'], channelPlugins: ['slack'], slack: { botToken: 'x', appToken: 'y', allowFrom: [], rooms: { mode: 'off' } }, embed: { baseUrl: 'http://d/v1', token: 't', model: 'e' } });
    const links = nine.filter((c) => c.argv[0] === 'plugins' && c.argv[1] === 'install');
    expect(links.length).toBe(2); // duckduckgo + slack; no baked engine on the shared service
    for (const l of links) expect(l.argv).toEqual(expect.arrayContaining(['--link', '--force', '--accept-capabilities', '--acknowledge-install-policy-warning']));
    const seven = buildConfigCommands({ ...base, openclawVersion: '2026.7.1-2', channelPlugins: ['slack'], slack: { botToken: 'x', appToken: 'y', allowFrom: [], rooms: { mode: 'off' } } });
    for (const l of seven.filter((c) => c.argv[0] === 'plugins' && c.argv[1] === 'install')) expect(l.argv).not.toContain('--force');
  });
  it('does none of that on the proven line', () => {
    const cmds = buildConfigCommands({ ...base, openclawVersion: '2026.7.1-2' });
    expect(cmds.some((c) => c.rawShell?.includes('lastTouchedAt'))).toBe(false);
    expect(cmds.some((c) => c.argv[0] === 'doctor')).toBe(false);
    expect(cmds.some((c) => c.argv.join(' ').includes('duckduckgo-plugin'))).toBe(false);
  });
  it('links the baked DuckDuckGo plugin before enabling it, and puts it on the load path for doctor', () => {
    const cmds = buildConfigCommands({ ...base, openclawVersion: '2026.9.6', bakedPlugins: ['duckduckgo'] });
    expect(cmds[0]!.rawShell).toContain('/opt/hatchabot/plugins/duckduckgo/node_modules/@openclaw/duckduckgo-plugin');
    const flat = cmds.map((c) => c.argv.join(' '));
    const link = flat.findIndex((l) => l.startsWith('plugins install --link /opt/hatchabot/plugins/duckduckgo/node_modules/@openclaw/duckduckgo-plugin'));
    expect(link).toBeGreaterThan(0);
    expect(link).toBeLessThan(flat.indexOf('plugins enable duckduckgo'));
    // Not baked (an older image): no link, as always.
    expect(buildConfigCommands({ ...base, openclawVersion: '2026.9.6' }).some((c) => c.argv.includes('--link') && c.argv.join(' ').includes('duckduckgo'))).toBe(false);
  });
  it('the second setup-token paste names the default agent on 2026.8+ (2026.9 refuses to guess the owner)', () => {
    const tok = (v: string) => buildConfigCommands({ ...base, openclawVersion: v, authMode: 'oauth-claude-cli', setupToken: 'sk-ant-oat01-test' }).filter((c) => c.argv.includes('paste-token'));
    expect(tok('2026.9.6').map((c) => c.argv.slice(0, 4))).toEqual([['models', 'auth', '--agent', 'todo'], ['models', 'auth', '--agent', 'main']]);
    expect(tok('2026.7.1-2').map((c) => c.argv.slice(0, 4))).toEqual([['models', 'auth', '--agent', 'todo'], ['models', 'auth', 'paste-token', '--provider']]);
  });
  it('the frozen-model heal reads agents.entries as well as agents.list', () => {
    const cmds = buildConfigCommands({ ...base, openclawVersion: '2026.9.6' });
    const heal = cmds.find((c) => c.rawShell?.includes('a.model'))!;
    expect(heal.rawShell).toContain('r.entries');
    expect(heal.rawShell).toContain('r.list');
  });
});

describe('channel plugins on an npm-install image (2026.8+ trust model)', () => {
  const base = { agentId: 'todo', authMode: 'api-key' as const, model: 'm', openclawVersion: '2026.9.6' };
  const slack = { botToken: 'x', appToken: 'y', allowFrom: [], rooms: { mode: 'off' as const } };
  it('installs the official package offline from the baked cache instead of linking, and drops the old link paths in the heal', () => {
    const cmds = buildConfigCommands({ ...base, channelPlugins: ['slack', 'discord'], pluginInstall: 'npm', slack, discord: { token: 't', applicationId: 'a', allowFrom: [], rooms: { mode: 'off' } } });
    const raw = cmds.map((c) => c.rawShell ?? '').join('\n');
    expect(raw).toContain('cp -r /opt/hatchabot/npm-cache /tmp/hb-npm-cache');
    expect(raw).toContain('npm_config_offline=true');
    expect(raw).toContain('openclaw plugins install "@openclaw/slack@$V" --accept-capabilities --acknowledge-install-policy-warning --pin');
    expect(raw).toContain('openclaw plugins install "@openclaw/discord@$V"');
    expect(cmds.some((c) => c.argv.includes('--link') && /slack|discord/.test(c.argv.join(' ')))).toBe(false);
    expect(cmds[0]!.rawShell).toContain('/opt/hatchabot/plugins/slack/');
    // The cache line precedes the installs; the installs precede the enables.
    const cache = cmds.findIndex((c) => c.rawShell?.includes('hb-npm-cache'));
    const inst = cmds.findIndex((c) => c.rawShell?.includes('@openclaw/slack@$V'));
    const en = cmds.findIndex((c) => c.argv.join(' ') === 'plugins enable slack');
    expect(cache).toBeLessThan(inst); expect(inst).toBeLessThan(en);
  });
  it('reinstalls a drifted brave plugin from the cache when the image carries it, only then', () => {
    const withBrave = buildConfigCommands({ ...base, pluginInstall: 'npm', bakedPlugins: ['duckduckgo', 'brave'] });
    const line = withBrave.find((c) => c.rawShell?.includes('@openclaw/brave-plugin@$V'))!;
    expect(line.rawShell).toContain('openclaw-brave-plugin-*');
    expect(line.rawShell).toContain('--force');
    expect(withBrave.findIndex((c) => c === line)).toBeGreaterThan(withBrave.findIndex((c) => c.rawShell?.includes('hb-npm-cache')));
    expect(buildConfigCommands({ ...base, pluginInstall: 'npm', bakedPlugins: ['duckduckgo'] }).some((c) => c.rawShell?.includes('brave-plugin'))).toBe(false);
    expect(buildConfigCommands({ ...base, openclawVersion: '2026.7.1-2', bakedPlugins: ['brave'] }).some((c) => c.rawShell?.includes('brave-plugin'))).toBe(false);
  });
  it('a link image (2026.7, or absent label) links as before', () => {
    const cmds = buildConfigCommands({ ...base, openclawVersion: '2026.7.1-2', channelPlugins: ['slack'], slack });
    expect(cmds.some((c) => c.argv.includes('--link') && c.argv.join(' ').includes('slack'))).toBe(true);
    expect(cmds.some((c) => c.rawShell?.includes('hb-npm-cache'))).toBe(false);
  });
});
