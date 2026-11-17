import type { ExecResult, RuntimeProvider } from '../providers/provider.js';

/** Configured means OpenClaw found usable configuration, not that a voice
 * call, microphone, network connection or provider billing has been tested. */
export interface VoiceStatus {
  status: 'configured' | 'unconfigured' | 'unsupported' | 'unavailable';
  /** A fixed display label, never a provider-supplied name or credential ref. */
  provider?: string;
  reason?: 'agent' | 'credentials' | 'provider';
}

export type VoiceSetupErrorCode = 'conflict' | 'unsupported' | 'unavailable' | 'invalid';

const SETUP_MESSAGES: Record<VoiceSetupErrorCode, string> = {
  conflict: 'The agent’s settings changed during voice setup. Recheck and try again.',
  unsupported: 'This runtime does not support voice setup. Check its OpenClaw version.',
  unavailable: 'Voice setup could not be verified. Recheck the agent before trying again.',
  invalid: 'The agent’s OpenClaw configuration needs attention before voice can be set up.',
};

export class VoiceSetupError extends Error {
  readonly userMessage: string;
  constructor(readonly code: VoiceSetupErrorCode) {
    super(SETUP_MESSAGES[code]);
    this.name = 'VoiceSetupError';
    this.userMessage = SETUP_MESSAGES[code];
  }
}

const PROVIDER_LABELS = new Map([
  ['google', 'Google'],
  ['openai', 'OpenAI'],
]);

// Pinned config.patch refusals before its commit, including races discovered
// after its initial revision check. They must never be reconciled as our write.
const CONFIG_CONFLICT_MESSAGES = [
  'config changed since last load',
  'config path changed since last load',
  'included config target changed since last load',
  'active config environment changed while preparing write',
  'config path changed repeatedly while acquiring lock',
  'config recovery observation was superseded',
  'config recovery candidate changed since preparation',
  'config recovery source changed since preparation',
];

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

type VoiceProvider = Pick<RuntimeProvider, 'exec'>;
type Method = 'config.get' | 'config.patch' | 'talk.catalog';
type ConfigSnapshot = { hash: string; config: Record<string, unknown>; applied: boolean; revision?: string };

/** Guard failures deliberately escape unchanged; provider failures never do. */
async function call(provider: VoiceProvider, runtimeRef: string, method: Method,
  params: Record<string, unknown>, stillCurrent: () => void): Promise<ExecResult | undefined> {
  stillCurrent();
  let res: ExecResult | undefined;
  try {
    res = await provider.exec(runtimeRef,
      ['gateway', 'call', method, '--params', JSON.stringify(params), '--json'], { timeoutMs: 30_000 });
  } catch {
    // A lost response is uncertain, especially for config.patch. Its caller
    // must reconcile the persisted binding rather than assuming no write.
  }
  stillCurrent();
  return res;
}

function uncertain(res: ExecResult | undefined): boolean {
  return !res || !!(res.timedOut || res.unreachable || res.signalled || res.volumeMissing);
}

function missingMethod(res: ExecResult, method: Method): boolean {
  const missing = new RegExp(`\\b(?:unknown method|method not found):\\s*['"]?${method.replace('.', '\\.')}(['"]|(?=\\s|$))`, 'i');
  return missing.test(`${res.stderr}\n${res.stdout}`);
}

function payload(res: ExecResult | undefined, method: Method): Record<string, unknown> {
  if (uncertain(res)) throw new VoiceSetupError('unavailable');
  let value: unknown;
  try { value = JSON.parse(res!.stdout); } catch { /* CLI errors are not necessarily JSON. */ }
  if (res!.code !== 0 || !record(value) || value.ok === false || value.error !== undefined) {
    if (missingMethod(res!, method)) throw new VoiceSetupError('unsupported');
    const detail = `${res!.stderr}\n${res!.stdout}`.toLowerCase();
    if (method === 'config.patch' && CONFIG_CONFLICT_MESSAGES.some((message) => detail.includes(message))) {
      throw new VoiceSetupError('conflict');
    }
    throw new VoiceSetupError('unavailable');
  }
  return value;
}

function configSnapshot(res: ExecResult | undefined): ConfigSnapshot {
  const value = payload(res, 'config.get');
  if (value.valid === false) throw new VoiceSetupError('invalid');
  if (value.valid !== true || typeof value.hash !== 'string' || !value.hash.trim() || !record(value.config)) {
    throw new VoiceSetupError('unavailable');
  }
  // Newer snapshots distinguish saved and active revisions. A pending reload
  // must not let the old agent's catalog establish readiness for the new one.
  const hasApplicationState = Object.hasOwn(value, 'configRevisionHash') || Object.hasOwn(value, 'appliedConfigHash');
  const applied = !hasApplicationState || (typeof value.configRevisionHash === 'string' &&
    !!value.configRevisionHash && value.configRevisionHash === value.appliedConfigHash);
  return { hash: value.hash, config: value.config, applied,
    ...(typeof value.configRevisionHash === 'string' ? { revision: value.configRevisionHash } : {}) };
}

function hasAgent(config: Record<string, unknown>, slug: string): boolean {
  if (!slug || slug.trim() !== slug || !record(config.agents)) return false;
  const { entries, list } = config.agents;
  if (record(entries)) return Object.hasOwn(entries, slug) && record(entries[slug]);
  return Array.isArray(list) && list.some((entry) => record(entry) && entry.id === slug);
}

function boundTo(config: Record<string, unknown>, slug: string): boolean {
  return record(config.talk) && config.talk.agentId === slug;
}

function unchangedBinding(before: ConfigSnapshot, after: ConfigSnapshot, slug: string): boolean {
  return after.hash === before.hash && after.revision === before.revision && after.applied &&
    hasAgent(after.config, slug) && boundTo(after.config, slug);
}

function catalogStatus(res: ExecResult | undefined): VoiceStatus {
  let catalog: Record<string, unknown>;
  try { catalog = payload(res, 'talk.catalog'); } catch (error) {
    return { status: error instanceof VoiceSetupError && error.code === 'unsupported' ? 'unsupported' : 'unavailable' };
  }
  const realtime = catalog.realtime;
  if (!record(realtime) || typeof realtime.ready !== 'boolean') return { status: 'unavailable' };
  if (!realtime.ready) {
    const providers = realtime.providers;
    // Only complete provider rows support an actionable diagnosis. Opaque or
    // incomplete catalogs retain the generic state instead of guessing.
    if (Array.isArray(providers) && providers.every((p) => record(p) &&
      typeof p.id === 'string' && !!p.id && typeof p.configured === 'boolean')) {
      const active = realtime.activeProvider;
      if (typeof active === 'string' && active) {
        const selected = providers.find((p) => p.id === active);
        return { status: 'unconfigured', reason: selected?.configured === false ? 'credentials' : 'provider' };
      }
      if (active === undefined) {
        return { status: 'unconfigured', reason: providers.length > 0 && providers.every((p) => !p.configured) ? 'credentials' : 'provider' };
      }
    }
    return { status: 'unconfigured' };
  }
  const id = realtime.activeProvider;
  return { status: 'configured', provider: (typeof id === 'string' && PROVIDER_LABELS.get(id)) || 'Configured voice provider' };
}

/** Read-only Talk catalog, as returned by OpenClaw 2026.9.8. The gateway's
 * realtime.ready is authoritative; speech/transcription providers and saved
 * keys do not establish that real-time voice is configured. No raw catalog
 * fields or errors leave this helper, and it never creates a voice session. */
export async function readVoiceStatus(provider: VoiceProvider, runtimeRef: string, slug?: string): Promise<VoiceStatus> {
  try {
    let snapshot: ConfigSnapshot | undefined;
    if (slug !== undefined) {
      snapshot = configSnapshot(await call(provider, runtimeRef, 'config.get', {}, () => {}));
      if (!hasAgent(snapshot.config, slug) || !boundTo(snapshot.config, slug)) return { status: 'unconfigured', reason: 'agent' };
      if (!snapshot.applied) return { status: 'unavailable' };
    }
    const status = catalogStatus(await call(provider, runtimeRef, 'talk.catalog', {}, () => {}));
    if (status.status === 'configured' && snapshot && slug !== undefined) {
      try {
        const verified = configSnapshot(await call(provider, runtimeRef, 'config.get', {}, () => {}));
        if (!unchangedBinding(snapshot, verified, slug)) return { status: 'unavailable' };
      } catch { return { status: 'unavailable' }; }
    }
    return status;
  } catch (error) {
    return { status: error instanceof VoiceSetupError && error.code === 'unsupported' ? 'unsupported' : 'unavailable' };
  }
}

/** Explicit setup changes only the Talk owner. Provider selection, credentials,
 * models and voices remain authored upstream; no audio/session request occurs. */
export async function configureVoice(provider: VoiceProvider, runtimeRef: string, slug: string,
  stillCurrent: () => void): Promise<VoiceStatus> {
  const initial = await call(provider, runtimeRef, 'config.get', {}, stillCurrent);
  stillCurrent();
  let snapshot = configSnapshot(initial);
  if (!hasAgent(snapshot.config, slug)) throw new VoiceSetupError('invalid');
  if (!boundTo(snapshot.config, slug)) {
    const originalHash = snapshot.hash;
    stillCurrent();
    const patched = await call(provider, runtimeRef, 'config.patch', {
      baseHash: originalHash,
      raw: JSON.stringify({ talk: { agentId: slug } }),
    }, stillCurrent);
    stillCurrent();
    try { payload(patched, 'config.patch'); } catch (error) {
      // Explicit CAS refusal is not a successful setup, even if another writer
      // happens to choose the same agent. Never retry a stale patch silently.
      if (error instanceof VoiceSetupError && (error.code === 'conflict' || error.code === 'unsupported')) throw error;
    }
    const verified = await call(provider, runtimeRef, 'config.get', {}, stillCurrent);
    stillCurrent();
    snapshot = configSnapshot(verified);
    if (!hasAgent(snapshot.config, slug) || !boundTo(snapshot.config, slug)) {
      throw new VoiceSetupError(snapshot.hash === originalHash ? 'unavailable' : 'conflict');
    }
  }
  if (!snapshot.applied) return { status: 'unavailable' };
  const catalog = await call(provider, runtimeRef, 'talk.catalog', {}, stillCurrent);
  stillCurrent();
  const status = catalogStatus(catalog);
  if (status.status === 'configured') {
    const verified = await call(provider, runtimeRef, 'config.get', {}, stillCurrent);
    stillCurrent();
    if (!unchangedBinding(snapshot, configSnapshot(verified), slug)) throw new VoiceSetupError('conflict');
  }
  return status;
}
