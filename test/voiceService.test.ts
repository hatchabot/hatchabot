import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Store } from '../src/store/store.js';
import { createAgentVoice, type AgentVoice, type VoiceCaller } from '../src/orchestrator/voice/agentVoice.js';
import { clearBusy, isBusy, markBusy } from '../src/orchestrator/lifecycle/busy.js';
import { configureVoice, readVoiceStatus } from '../src/orchestrator/voice/voice.js';
import type { Agent } from '../src/domain/types.js';

vi.mock('../src/orchestrator/voice/voice.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/orchestrator/voice/voice.js')>(),
  readVoiceStatus: vi.fn(), configureVoice: vi.fn(),
}));

/**
 * The voice service (HB-0808 step 13), driven as src/api/console/voiceRoutes.ts
 * drives it but with no HTTP server: a real store on an in-memory database,
 * and the runtime's reads and writes stubbed.
 */
const OWNER = 'user-owner';
interface World { store: Store; voice: AgentVoice; traced: string[]; caller: VoiceCaller; watched: number; valid: boolean; agent(o?: Partial<Agent>): Agent }

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { clearBusy('a1'); });

function world(): World {
  const store = new Store(new Database(':memory:'));
  store.insertHost({ id: 'h1', ownerId: OWNER, kind: 'local', provider: 'mock', name: 'box', settings: {}, createdAt: 'now' });
  store.insertAIProfile({ id: 'p1', ownerId: OWNER, name: 'AI', vendor: 'anthropic', kind: 'api_key', model: 'claude-opus-4-8', secretRef: 'ai/p1', createdAt: 'now' });
  const w = { store, traced: [], watched: 0, valid: true } as unknown as World;
  const provider = {};
  w.voice = createAgentVoice({
    store, providerFor: () => provider as never, trace: () => (event) => { w.traced.push(event); },
    agentGone: (id) => { const s = store.getAgent(id)?.state; return !s || s === 'DELETED' || s === 'DELETING'; },
    isArchiving: () => false,
  });
  w.caller = { owned: (id) => store.getAgent(id), watch: () => { w.watched++; return { valid: () => w.valid }; } };
  w.agent = (o = {}) => {
    store.insertAgent({
      id: 'a1', ownerId: OWNER, name: 'Agent', slug: 'a1', state: 'RUNNING', aiProfileId: 'p1', hostId: 'h1',
      persona: '', sharedMemory: false, createdAt: 'now', updatedAt: 'now', runtimeRef: 'docker://hatchabot-a1', ...o,
    } as unknown as Agent);
    return store.getAgent('a1')!;
  };
  return w;
}

describe('voice readiness', () => {
  it('a busy or stopped agent is not read, and no session is watched', async () => {
    const w = world();
    expect(await w.voice.status(w.agent({ state: 'STOPPED' }), w.caller)).toEqual({ ok: true, body: { status: 'not_running' } });
    markBusy('a1');
    expect(await w.voice.status(w.store.getAgent('a1')!, w.caller)).toEqual({ ok: true, body: { status: 'busy' } });
    expect(readVoiceStatus).not.toHaveBeenCalled();
    expect(w.watched).toBe(0);
  });

  it('answers what the runtime reports; a changed context after the read is unavailable; a lost session a 404', async () => {
    const w = world();
    const a = w.agent();
    vi.mocked(readVoiceStatus).mockResolvedValue({ status: 'unconfigured', reason: 'provider' } as never);
    expect(await w.voice.status(a, w.caller)).toEqual({ ok: true, body: { status: 'unconfigured', reason: 'provider' } });
    vi.mocked(readVoiceStatus).mockImplementationOnce(async () => { w.store.setAgentModel('a1', 'claude-sonnet-4-8'); return { status: 'unconfigured', reason: 'provider' } as never; });
    expect(await w.voice.status(w.store.getAgent('a1')!, w.caller)).toEqual({ ok: true, body: { status: 'unavailable' } });
    vi.mocked(readVoiceStatus).mockImplementationOnce(async () => { w.valid = false; return { status: 'unconfigured', reason: 'provider' } as never; });
    expect(await w.voice.status(w.store.getAgent('a1')!, w.caller)).toEqual({ ok: false, status: 404, error: 'Not found' });
  });
});

describe('voice setup', () => {
  it('is refused while the agent is busy or not running, before anything is read', async () => {
    const w = world();
    expect(await w.voice.setup(w.agent({ state: 'STOPPED' }), w.caller)).toEqual({ ok: false, status: 409, error: 'Start the agent before setting up Talk.' });
    w.store.setAgentState('a1', 'RUNNING');
    markBusy('a1');
    expect(await w.voice.setup(w.store.getAgent('a1')!, w.caller)).toEqual({ ok: false, status: 409, error: 'Wait for the current operation before setting up Talk.' });
    expect(configureVoice).not.toHaveBeenCalled();
    expect(w.watched).toBe(0);
  });

  it('holds the busy flag while it configures, and refuses when the agent changed meanwhile', async () => {
    const w = world();
    const a = w.agent();
    vi.mocked(configureVoice).mockImplementationOnce(async () => {
      expect(isBusy('a1')).toBe(true);
      w.store.setAgentModel('a1', 'claude-sonnet-4-8');
      return { status: 'unconfigured', reason: 'provider' } as never;
    });
    expect(await w.voice.setup(a, w.caller)).toEqual({ ok: false, status: 409, error: 'The agent changed while setting up Talk. Reopen voice settings and try again.' });
    expect(isBusy('a1')).toBe(false);
    expect(w.traced).toEqual([]);
  });

  it('a setup that ends unconfigured is answered as the runtime said, and traced', async () => {
    const w = world();
    vi.mocked(configureVoice).mockResolvedValueOnce({ status: 'unconfigured', reason: 'provider' } as never);
    expect(await w.voice.setup(w.agent(), w.caller)).toEqual({ ok: true, body: { status: 'unconfigured', reason: 'provider' } });
    expect(w.traced).toEqual(['voice.setup']);
  });

  it('an unexpected failure is worded, not shown', async () => {
    const w = world();
    vi.mocked(configureVoice).mockRejectedValueOnce(new Error('docker said something private'));
    expect(await w.voice.setup(w.agent(), w.caller)).toEqual({ ok: false, status: 502, error: 'Could not set up Talk. Reopen voice settings and try again.' });
  });
});
