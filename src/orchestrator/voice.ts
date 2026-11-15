import type { RuntimeProvider } from '../providers/provider.js';

/** Configured means OpenClaw found usable configuration, not that a voice
 * call, microphone, network connection or provider billing has been tested. */
export interface VoiceStatus {
  status: 'configured' | 'unconfigured' | 'unsupported' | 'unavailable';
  /** A fixed display label, never a provider-supplied name or credential ref. */
  provider?: string;
}

const PROVIDER_LABELS = new Map([
  ['google', 'Google'],
  ['openai', 'OpenAI'],
]);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read-only Talk catalog, as returned by OpenClaw 2026.9.8. The gateway's
 * realtime.ready is authoritative; speech/transcription providers and saved
 * keys do not establish that real-time voice is configured. No raw catalog
 * fields or errors leave this helper, and it never creates a voice session. */
export async function readVoiceStatus(provider: Pick<RuntimeProvider, 'exec'>, runtimeRef: string): Promise<VoiceStatus> {
  try {
    const res = await provider.exec(runtimeRef,
      ['gateway', 'call', 'talk.catalog', '--params', '{}', '--json'],
      { timeoutMs: 30_000 });
    if (res.timedOut || res.unreachable || res.signalled || res.volumeMissing) return { status: 'unavailable' };
    if (res.code !== 0) {
      // Older gateways say "unknown method: talk.catalog". A failed auth,
      // plugin, or network check is not evidence that Talk is unsupported.
      const missing = /\b(?:unknown method|method not found):\s*['"]?talk\.catalog(?:['"]|(?=\s|$))/i;
      return { status: missing.test(`${res.stderr}\n${res.stdout}`) ? 'unsupported' : 'unavailable' };
    }
    const catalog: unknown = JSON.parse(res.stdout);
    if (!record(catalog) || catalog.ok === false || catalog.error !== undefined ||
        !record(catalog.realtime) || typeof catalog.realtime.ready !== 'boolean') {
      return { status: 'unavailable' };
    }
    if (!catalog.realtime.ready) return { status: 'unconfigured' };
    const id = catalog.realtime.activeProvider;
    return {
      status: 'configured',
      provider: (typeof id === 'string' && PROVIDER_LABELS.get(id)) || 'Configured voice provider',
    };
  } catch {
    return { status: 'unavailable' };
  }
}
