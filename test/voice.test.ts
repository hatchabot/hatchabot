import { describe, expect, it, vi } from 'vitest';
import type { ExecResult, RuntimeProvider } from '../src/providers/provider.js';
import { readVoiceStatus } from '../src/orchestrator/voice.js';

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
    expect(await readVoiceStatus(provider, REF)).toEqual({ status: 'unconfigured' });
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
