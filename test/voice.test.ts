import { describe, expect, it, vi } from 'vitest';
import type { ExecResult, RuntimeProvider } from '../src/providers/provider.js';
import { configureVoice, readVoiceStatus, VoiceSetupError } from '../src/orchestrator/voice.js';

const REF = 'mock://voice-agent';
const result = (payload: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify(payload), stderr: '' });
const responding = (res: ExecResult) => ({ exec: vi.fn<RuntimeProvider['exec']>().mockResolvedValue(res) });

describe('the agent voice configuration check', () => {
  it('makes one bounded, read-only catalog call with empty params', async () => {
    const provider = responding(result({ realtime: { ready: true, activeProvider: 'google' } }));
    expect(await readVoiceStatus(provider, REF)).toEqual({ status: 'configured', provider: 'Google' });
    expect(provider.exec).toHaveBeenCalledExactlyOnceWith(REF,
      ['gateway', 'call', 'talk.catalog', '--params', '{}', '--json'], { timeoutMs: 30_000 });
  });

  it.each([
    ['google', 'Google'],
    ['openai', 'OpenAI'],
    ['private-provider-credential-ref', 'Configured voice provider'],
    ['constructor', 'Configured voice provider'],
    ['__proto__', 'Configured voice provider'],
    [undefined, 'Configured voice provider'],
  ])('uses only a fixed display label for provider %s', async (activeProvider, label) => {
    const provider = responding(result({
      realtime: {
        ready: true, activeProvider,
        providers: [{ id: activeProvider, configured: true, label: 'private label', model: 'private model', apiKey: 'made-up-credential' }],
        apiKey: 'another-made-up-credential',
      },
      config: { secretRef: 'private/ref' },
    }));
    expect(await readVoiceStatus(provider, REF)).toEqual({ status: 'configured', provider: label });
  });

  it('does not infer real-time readiness from available speech, transcription, or provider credentials', async () => {
    const provider = responding(result({
      speech: { ready: true, providers: [{ id: 'google', configured: true }] },
      transcription: { ready: true },
      realtime: { ready: false, activeProvider: 'google', providers: [{ id: 'google', configured: true }] },
    }));
    expect(await readVoiceStatus(provider, REF)).toEqual({ status: 'unconfigured', reason: 'provider' });
  });

  it.each([
    null, [], 'configured', true, {},
    { ready: true },
    { realtime: null },
    { realtime: [] },
    { realtime: true },
    { realtime: {} },
    { realtime: { ready: 'true' } },
    { realtime: { ready: 1 } },
    { realtime: { ready: null } },
    { realtime: { ready: true }, error: { message: 'private error' } },
    { realtime: { ready: true }, ok: false },
  ])('keeps malformed or missing catalog state unavailable: %j', async (payload) => {
    expect(await readVoiceStatus(responding(result(payload)), REF)).toEqual({ status: 'unavailable' });
  });

  it.each(['', 'not JSON', '{"realtime":', 'warning\n{"realtime":{"ready":true}}'])('does not guess readiness from unreadable output: %s', async (stdout) => {
    expect(await readVoiceStatus(responding({ code: 0, stdout, stderr: 'private detail' }), REF)).toEqual({ status: 'unavailable' });
  });

  it.each([
    'Gateway call failed: Error: unknown method: talk.catalog',
    'method not found: "talk.catalog"',
    '{"error":{"message":"unknown method: talk.catalog"}}',
  ])('identifies an explicitly missing Talk catalog: %s', async (error) => {
    for (const stream of ['stderr', 'stdout'] as const) {
      const res = { code: 1, stdout: '', stderr: '', [stream]: error };
      expect(await readVoiceStatus(responding(res), REF)).toEqual({ status: 'unsupported' });
    }
  });

  it.each([
    'missing scope: operator.read',
    'unknown method: talk.catalogue',
    'unknown method: talk.catalog.extra',
    'unknown method: other.method',
    'provider not found',
    'connection refused; apiKey=made-up-credential',
  ])('keeps other command failures unavailable without returning details: %s', async (stderr) => {
    const provider = responding({ code: 1, stdout: '{"realtime":{"ready":true}}', stderr });
    expect(await readVoiceStatus(provider, REF)).toEqual({ status: 'unavailable' });
  });

  it.each(['timedOut', 'unreachable', 'signalled', 'volumeMissing'] as const)('does not trust output from a %s command', async (flag) => {
    const provider = responding({ ...result({ realtime: { ready: true, activeProvider: 'google' } }), [flag]: true });
    expect(await readVoiceStatus(provider, REF)).toEqual({ status: 'unavailable' });
    provider.exec.mockResolvedValue({ code: 1, stdout: '', stderr: 'unknown method: talk.catalog', [flag]: true });
    expect(await readVoiceStatus(provider, REF)).toEqual({ status: 'unavailable' });
  });

  it('contains provider rejections without returning a credential or stack', async () => {
    const provider = { exec: vi.fn<RuntimeProvider['exec']>().mockRejectedValue(new Error('private credential and connection detail')) };
    expect(await readVoiceStatus(provider, REF)).toEqual({ status: 'unavailable' });
  });
});

const SLUG = 'garden-helper';
const readyCatalog = { realtime: { ready: true, activeProvider: 'google' } };
const config = (agentId?: string) => ({ agents: { entries: { [SLUG]: {}, main: {} } },
  ...(agentId === undefined ? {} : { talk: { agentId } }) });
const snapshot = (cfg: unknown = config(SLUG), hash = 'revision-one') => result({ valid: true, hash, config: cfg });
const script = (...responses: Array<ExecResult | Error>) => {
  const provider = { exec: vi.fn<RuntimeProvider['exec']>() };
  for (const response of responses) {
    if (response instanceof Error) provider.exec.mockRejectedValueOnce(response);
    else provider.exec.mockResolvedValueOnce(response);
  }
  return provider;
};
const methods = (provider: ReturnType<typeof script>) => provider.exec.mock.calls.map(([, argv]) => argv[2]);

describe('voice readiness for the selected agent', () => {
  it.each([undefined, 'main'])('requires an explicit matching Talk owner instead of trusting a catalog for %s', async (owner) => {
    const provider = script(snapshot(config(owner)), result(readyCatalog));
    expect(await readVoiceStatus(provider, REF, SLUG)).toEqual({ status: 'unconfigured', reason: 'agent' });
    expect(methods(provider)).toEqual(['config.get']);
  });

  it('verifies the intended agent exists before reporting readiness', async () => {
    const provider = script(snapshot({ agents: { entries: { main: {} } }, talk: { agentId: SLUG } }));
    expect(await readVoiceStatus(provider, REF, SLUG)).toEqual({ status: 'unconfigured', reason: 'agent' });
    expect(methods(provider)).toEqual(['config.get']);
  });

  it('reads the catalog after validating the owner and leaves all settings untouched', async () => {
    const provider = script(snapshot(), result(readyCatalog), snapshot());
    expect(await readVoiceStatus(provider, REF, SLUG)).toEqual({ status: 'configured', provider: 'Google' });
    expect(methods(provider)).toEqual(['config.get', 'talk.catalog', 'config.get']);
  });

  it.each([
    { configRevisionHash: 'saved-new', appliedConfigHash: 'active-old' },
    { configRevisionHash: 'saved-new', appliedConfigHash: null },
    { configRevisionHash: null, appliedConfigHash: null },
  ])('does not use a catalog for a saved binding that is not active: %j', async (revisions) => {
    const provider = script(result({ valid: true, hash: 'file-revision', config: config(SLUG), ...revisions }));
    expect(await readVoiceStatus(provider, REF, SLUG)).toEqual({ status: 'unavailable' });
    expect(methods(provider)).toEqual(['config.get']);
  });

  it('accepts an applied revision independently of the file revision token', async () => {
    const applied = result({ valid: true, hash: 'file-revision', config: config(SLUG),
      configRevisionHash: 'resolved-revision', appliedConfigHash: 'resolved-revision' });
    const provider = script(applied, result(readyCatalog), applied);
    expect(await readVoiceStatus(provider, REF, SLUG)).toMatchObject({ status: 'configured' });
  });

  it.each([
    [{ activeProvider: 'google', providers: [{ id: 'google', configured: false }] }, 'credentials'],
    [{ providers: [{ id: 'google', configured: false }, { id: 'openai', configured: false }] }, 'credentials'],
    [{ activeProvider: 'missing-provider', providers: [{ id: 'google', configured: true }] }, 'provider'],
    [{ providers: [] }, 'provider'],
    [{ providers: [{ id: 'google', configured: 'false' }] }, undefined],
    [{ providers: [{ configured: false }] }, undefined],
    [{ activeProvider: 5, providers: [{ id: 'google', configured: false }] }, undefined],
  ])('diagnoses only strict catalog evidence %j', async (fields, reason) => {
    const provider = script(result({ realtime: { ready: false, ...fields } }));
    expect(await readVoiceStatus(provider, REF)).toEqual({ status: 'unconfigured', ...(reason ? { reason } : {}) });
  });

  it('keeps failures of the configuration read separate from missing credentials', async () => {
    const provider = script({ code: 1, stdout: '', stderr: 'connection refused with private detail' });
    expect(await readVoiceStatus(provider, REF, SLUG)).toEqual({ status: 'unavailable' });
  });
});

describe('explicit Talk owner setup', () => {
  it('merges only the owner using the current revision and verifies persistence before readiness', async () => {
    const authored = { ...config('main'), talk: { agentId: 'main',
      realtime: { provider: 'openai', model: 'authored-model', speakerVoice: 'authored-voice',
        transport: 'gateway-relay', instructions: 'Keep my instructions',
        providers: { openai: { apiKey: 'private-placeholder', custom: true } } },
      speechLocale: 'fr-CA', interruptOnSpeech: false }, tools: { profile: 'full' } };
    const saved = structuredClone(authored);
    saved.talk.agentId = SLUG;
    const provider = script(snapshot(authored), result({ ok: true }), snapshot(saved, 'revision-two'), result(readyCatalog), snapshot(saved, 'revision-two'));
    const guard = vi.fn();
    expect(await configureVoice(provider, REF, SLUG, guard)).toEqual({ status: 'configured', provider: 'Google' });
    expect(methods(provider)).toEqual(['config.get', 'config.patch', 'config.get', 'talk.catalog', 'config.get']);
    expect(provider.exec.mock.calls[1]).toEqual([REF, ['gateway', 'call', 'config.patch', '--params',
      JSON.stringify({ baseHash: 'revision-one', raw: JSON.stringify({ talk: { agentId: SLUG } }) }), '--json'], { timeoutMs: 30_000 }]);
    expect(JSON.stringify(provider.exec.mock.calls)).not.toContain('private-placeholder');
    expect(authored.talk.agentId).toBe('main');
    expect(guard.mock.calls.length).toBeGreaterThanOrEqual(9);
  });

  it('does not write an already bound agent or choose a provider/model for it', async () => {
    const provider = script(snapshot(), result({ realtime: { ready: false, providers: [{ id: 'google', configured: false }] } }));
    expect(await configureVoice(provider, REF, SLUG, () => {})).toEqual({ status: 'unconfigured', reason: 'credentials' });
    expect(methods(provider)).toEqual(['config.get', 'talk.catalog']);
  });

  it('supports the legacy agent roster without creating or editing agents', async () => {
    const legacy = { agents: { list: [{ id: SLUG }, { id: 'main' }] } };
    const saved = snapshot({ ...legacy, talk: { agentId: SLUG } }, 'revision-two');
    const provider = script(snapshot(legacy), result({ ok: true }), saved, result(readyCatalog), saved);
    expect(await configureVoice(provider, REF, SLUG, () => {})).toMatchObject({ status: 'configured' });
    expect(JSON.parse(provider.exec.mock.calls[1]![1][4]!)).toEqual({ baseHash: 'revision-one', raw: JSON.stringify({ talk: { agentId: SLUG } }) });
  });

  it.each([
    { agents: { entries: { main: {} } } },
    { agents: { entries: { [SLUG]: null } } },
    { agents: { entries: {}, list: [{ id: SLUG }] } },
    { agents: { list: [{ id: 'main' }] } },
    {},
  ])('refuses a missing or malformed intended agent before any mutation: %j', async (cfg) => {
    const provider = script(snapshot(cfg));
    await expect(configureVoice(provider, REF, SLUG, () => {})).rejects.toMatchObject({ code: 'invalid' });
    expect(methods(provider)).toEqual(['config.get']);
  });

  it.each([
    { valid: false, hash: 'revision', config: config() },
    { valid: true, hash: '', config: config() },
    { valid: true, hash: 'revision', config: null },
    { hash: 'revision', config: config() },
    { valid: true, config: config() },
  ])('requires a valid revision-guarded configuration snapshot: %j', async (value) => {
    const provider = script(result(value));
    await expect(configureVoice(provider, REF, SLUG, () => {})).rejects.toBeInstanceOf(VoiceSetupError);
    expect(methods(provider)).toEqual(['config.get']);
  });

  it.each([
    { code: 1, stdout: '', stderr: 'Gateway call failed: config changed since last load; re-run config.get and retry' },
    { code: 1, stdout: '', stderr: 'Gateway call failed: config path changed since last load' },
    { code: 1, stdout: '', stderr: 'Gateway call failed: active config environment changed while preparing write; re-run config.get and retry' },
    result({ error: { code: 'INVALID_REQUEST', message: 'config changed since last load; re-run config.get and retry' } }),
  ])('preserves a compare-and-swap refusal without retrying or reporting another writer’s change as success', async (conflict) => {
    const provider = script(snapshot(config()), conflict, snapshot());
    await expect(configureVoice(provider, REF, SLUG, () => {})).rejects.toMatchObject({ code: 'conflict' });
    expect(methods(provider)).toEqual(['config.get', 'config.patch']);
  });

  it.each([
    new Error('connection closed with private-placeholder'),
    { code: 1, stdout: '', stderr: 'config.patch persisted but was not applied; private-placeholder' },
    { code: 0, stdout: '{}', stderr: '', timedOut: true },
    { code: 0, stdout: '{}', stderr: '', signalled: true },
    { code: 0, stdout: 'incomplete response', stderr: '' },
  ])('reconciles an uncertain patch through a fresh configuration read: %j', async (patchResult) => {
    const provider = script(snapshot(config()), patchResult, snapshot(config(SLUG), 'revision-two'), result(readyCatalog), snapshot(config(SLUG), 'revision-two'));
    expect(await configureVoice(provider, REF, SLUG, () => {})).toEqual({ status: 'configured', provider: 'Google' });
    expect(methods(provider)).toEqual(['config.get', 'config.patch', 'config.get', 'talk.catalog', 'config.get']);
  });

  it('does not claim an acknowledged patch persisted without the verified binding', async () => {
    const provider = script(snapshot(config()), result({ ok: true }), snapshot(config()));
    await expect(configureVoice(provider, REF, SLUG, () => {})).rejects.toMatchObject({ code: 'unavailable' });
    expect(methods(provider)).toEqual(['config.get', 'config.patch', 'config.get']);
  });

  it('does not overwrite another settings change that wins after the patch', async () => {
    const provider = script(snapshot(config()), result({ ok: true }), snapshot(config('main'), 'revision-three'));
    await expect(configureVoice(provider, REF, SLUG, () => {})).rejects.toMatchObject({ code: 'conflict' });
    expect(methods(provider).filter((method) => method === 'config.patch')).toHaveLength(1);
  });

  it('keeps a saved but pending binding unavailable until the runtime applies it', async () => {
    const provider = script(snapshot(config()), result({ ok: true }), result({ valid: true, hash: 'revision-two',
      config: config(SLUG), configRevisionHash: 'resolved-new', appliedConfigHash: 'resolved-old' }));
    expect(await configureVoice(provider, REF, SLUG, () => {})).toEqual({ status: 'unavailable' });
    expect(methods(provider)).toEqual(['config.get', 'config.patch', 'config.get']);
  });

  it.each(['config.get', 'config.patch'] as const)('identifies an unsupported %s without exposing runtime details', async (method) => {
    const missing = { code: 1, stdout: '', stderr: `unknown method: ${method}\nprivate-placeholder` };
    const provider = method === 'config.get' ? script(missing) : script(snapshot(config()), missing);
    try { await configureVoice(provider, REF, SLUG, () => {}); throw new Error('expected failure'); } catch (error) {
      expect(error).toBeInstanceOf(VoiceSetupError);
      expect(error).toMatchObject({ code: 'unsupported' });
      expect(String(error)).not.toContain('private-placeholder');
    }
  });

  it('does not expose private failure text or claim a lost verification succeeded', async () => {
    const provider = script(snapshot(config()), new Error('private-placeholder'), new Error('private-placeholder'));
    let caught: unknown;
    try { await configureVoice(provider, REF, SLUG, () => {}); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'unavailable', userMessage: expect.any(String) });
    expect(String(caught)).not.toContain('private-placeholder');
    expect(JSON.stringify(caught)).not.toContain('private-placeholder');
  });

  it('checks lifecycle validity before starting any read', async () => {
    const provider = script();
    const stale = new Error('agent changed');
    await expect(configureVoice(provider, REF, SLUG, () => { throw stale; })).rejects.toBe(stale);
    expect(provider.exec).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4])('propagates a lifecycle change during step %i before any subsequent operation', async (heldIndex) => {
    const answers = [snapshot(config()), result({ ok: true }), snapshot(config(SLUG), 'revision-two'), result(readyCatalog), snapshot(config(SLUG), 'revision-two')];
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    let current = true;
    const stale = new Error('lifecycle changed');
    let index = 0;
    const provider = { exec: vi.fn<RuntimeProvider['exec']>().mockImplementation(async () => {
      const step = index++;
      if (step === heldIndex) { reached(); await held; }
      return answers[step]!;
    }) };
    const promise = configureVoice(provider, REF, SLUG, () => { if (!current) throw stale; });
    await waiting;
    current = false;
    release();
    await expect(promise).rejects.toBe(stale);
    expect(provider.exec).toHaveBeenCalledTimes(heldIndex + 1);
  });

  it('preserves a lifecycle rejection even when the pending provider command also fails', async () => {
    const stale = new Error('owner changed');
    let current = true;
    const provider = { exec: vi.fn<RuntimeProvider['exec']>().mockImplementation(async () => {
      current = false;
      throw new Error('private provider error');
    }) };
    await expect(configureVoice(provider, REF, SLUG, () => { if (!current) throw stale; })).rejects.toBe(stale);
    expect(provider.exec).toHaveBeenCalledTimes(1);
  });
});

describe('settings changes while the Talk catalog is being read', () => {
  it.each(['owner', 'provider', 'pending application', 'resolved revision'] as const)(
    'discards a ready catalog after an external %s change for both read and setup', async (change) => {
      for (const setup of [false, true]) {
        let current = { valid: true, hash: 'file-one', config: { ...config(SLUG),
          talk: { agentId: SLUG, realtime: { provider: 'google' } } },
          configRevisionHash: 'resolved-one', appliedConfigHash: 'resolved-one' };
        let release!: () => void;
        let reached!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        const waiting = new Promise<void>((resolve) => { reached = resolve; });
        const provider = { exec: vi.fn<RuntimeProvider['exec']>().mockImplementation(async (_ref, argv) => {
          if (argv[2] === 'config.get') return result(current);
          if (argv[2] !== 'talk.catalog') throw new Error('unexpected mutation');
          reached();
          await held;
          return result(readyCatalog);
        }) };
        const outcome = (setup ? configureVoice(provider, REF, SLUG, () => {}) : readVoiceStatus(provider, REF, SLUG))
          .then((value) => ({ value }), (error: unknown) => ({ error }));
        await waiting;
        current = structuredClone(current);
        if (change === 'owner') { current.config.talk.agentId = 'main'; current.hash = 'file-two'; }
        if (change === 'provider') { current.config.talk.realtime.provider = 'openai'; current.hash = 'file-two'; }
        if (change === 'pending application') current.appliedConfigHash = 'resolved-old';
        if (change === 'resolved revision') {
          current.configRevisionHash = 'resolved-two';
          current.appliedConfigHash = 'resolved-two';
        }
        release();
        expect(await outcome).toMatchObject(setup ? { error: { code: 'conflict' } } : { value: { status: 'unavailable' } });
        expect(methods(provider)).toEqual(['config.get', 'talk.catalog', 'config.get']);
      }
    },
  );

  it('does not trust a ready catalog when the final verification fails', async () => {
    const provider = script(snapshot(), result(readyCatalog), new Error('private verification failure'));
    expect(await readVoiceStatus(provider, REF, SLUG)).toEqual({ status: 'unavailable' });
    const setupProvider = script(snapshot(), result(readyCatalog), new Error('private verification failure'));
    await expect(configureVoice(setupProvider, REF, SLUG, () => {})).rejects.toMatchObject({ code: 'unavailable' });
  });
});
