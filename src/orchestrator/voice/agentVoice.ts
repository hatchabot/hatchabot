import type { Agent } from '../../domain/types.js';
import type { RuntimeProvider } from '../../providers/provider.js';
import type { Store } from '../../store/store.js';
import { AgentBusyError, isBusy, whileBusy } from '../lifecycle/busy.js';
import { TurnRefused } from '../files/coreFileTurns.js';
import { operationRefusal } from '../lifecycle/operations.js';
import { grantVoiceNetwork, voiceNetworkReady } from './voiceNetwork.js';
import { configureVoice, readVoiceStatus, VoiceSetupError, type VoiceStatus } from './voice.js';

/** Why not, with the status the route answers and its words. */
export type VoiceRefusal = { ok: false; status: number; error: string };
type Answer<T> = { ok: true; body: T } | VoiceRefusal;
/** What the Voice card is told: the runtime's readiness, or why it cannot be read now. */
export type VoiceAnswer = VoiceStatus | { status: 'busy' | 'not_running' | 'unavailable' } | { status: 'unconfigured'; reason: 'network' };

/**
 * Who is asking, as the route reads them at each step: the agent as they
 * own it now (`owned`), and their browser session held across the waits
 * (`watch`, the context's `watchConsoleHttp`), started where the route
 * started it.
 */
export interface VoiceCaller {
  owned: (agentId: string) => Agent | undefined;
  watch: () => { valid: () => boolean };
}

/**
 * Browser voice (HB-0808 step 13, docs/voice.md): whether a running agent's
 * Talk is ready, and binding Talk to it with the provider its runtime
 * already has. Built once in `registerRoutes` and on the route context as
 * `ctx.voice`; its routes are in src/api/voiceRoutes.ts, which checks who
 * asks and the body. Nothing here knows HTTP: a refusal is a result with its
 * status and words.
 *
 * No state and no timer. A read is not a microphone or provider test; setup
 * holds the busy flag and checks the session, the owner, the runtime and the
 * source again after each wait.
 */
export interface AgentVoice {
  /** Configuration readiness, read only. */
  status(agent: Agent, caller: VoiceCaller): Promise<Answer<VoiceAnswer>>;
  /** Bind Talk to this agent; neither grants credentials nor starts microphone or audio. */
  setup(agent: Agent, caller: VoiceCaller): Promise<Answer<VoiceAnswer>>;
}

export interface AgentVoiceDeps {
  store: Store;
  /** The runtime provider of a host (this machine, or a runner). Throws on an unknown host. */
  providerFor: (hostId: string) => RuntimeProvider;
  /** A line to the log AND to the agent's timeline. */
  trace: (agentId?: string) => (event: string, detail: Record<string, unknown>) => void;
  /** Deleted or being deleted. */
  agentGone: (id: string) => boolean;
  /** Is an archive of this agent under way? */
  isArchiving: (agentId: string) => boolean;
}

export function createAgentVoice(deps: AgentVoiceDeps): AgentVoice {
  const { store, providerFor, trace, agentGone, isArchiving } = deps;
  const said = <T>(body: T): { ok: true; body: T } => ({ ok: true, body });
  const refused = (status: number, error: string): VoiceRefusal => ({ ok: false, status, error });

  // Read only: configuration readiness is not a microphone or provider test.
  // Talk requires operator.talk, which guests' console scopes do not grant.
  const voiceWaiting = (a: Agent, locked = false) => (!locked && isBusy(a.id)) || isArchiving(a.id) || operationRefusal(store, a.id) ||
    a.state === 'PROVISIONING' || a.state === 'REBUILDING';
  // These snapshots stay internal, never in the reply. The applied source
  // can differ from the desired source while a rebuild is pending.
  const voiceContext = (a: Agent) => JSON.stringify([
    a.ownerId, a.ops, a.runtimeRef, a.slug, a.hostId, a.state, a.updatedAt, a.gatewayToken,
    a.aiProfileId, a.model, a.appliedProfileId, a.appliedModel, a.appliedProfileAt, a.image, a.rebuildOnStart,
    store.getHost(a.hostId), store.getAIProfile(a.aiProfileId),
    a.appliedProfileId ? store.getAIProfile(a.appliedProfileId) : undefined,
  ]);

  const status: AgentVoice['status'] = async (agent, caller) => {
    if (voiceWaiting(agent)) return said({ status: 'busy' });
    if (agent.state !== 'RUNNING' || !agent.runtimeRef) return said({ status: 'not_running' });
    const session = caller.watch(), before = voiceContext(agent);
    let provider: RuntimeProvider;
    try { provider = providerFor(agent.hostId); }
    catch { return said({ status: 'unavailable' }); }
    const result = await readVoiceStatus(provider, agent.runtimeRef, agent.slug);
    const current = caller.owned(agent.id);
    if (!session.valid() || !current || agentGone(agent.id)) return refused(404, 'Not found');
    if (voiceWaiting(current)) return said({ status: 'busy' });
    if (current.state !== 'RUNNING' || !current.runtimeRef) return said({ status: 'not_running' });
    if (voiceContext(current) !== before) return said({ status: 'unavailable' });
    try {
      if (providerFor(current.hostId) !== provider) return said({ status: 'unavailable' });
    } catch { return said({ status: 'unavailable' }); }
    if (result.status === 'configured' && !voiceNetworkReady(store, current, result.provider)) return said({ status: 'unconfigured', reason: 'network' });
    return said(result);
  };

  // Bind Talk to this agent using only the provider already configured in
  // its runtime. This neither grants credentials nor starts microphone/audio.
  const setup: AgentVoice['setup'] = async (agent, caller) => {
    if (voiceWaiting(agent)) return refused(409, 'Wait for the current operation before setting up Talk.');
    if (agent.state !== 'RUNNING' || !agent.runtimeRef) return refused(409, 'Start the agent before setting up Talk.');
    const session = caller.watch(), before = voiceContext(agent);
    try {
      const provider = providerFor(agent.hostId);
      const stillCurrent = (locked = true) => {
        const fresh = caller.owned(agent.id);
        if (!session.valid() || !fresh || agentGone(agent.id)) throw new TurnRefused(404, 'Not found');
        let sameProvider = false;
        try { sameProvider = providerFor(fresh.hostId) === provider; } catch { /* a removed runner is a changed context */ }
        if (voiceWaiting(fresh, locked) || fresh.state !== 'RUNNING' || !fresh.runtimeRef || voiceContext(fresh) !== before || !sameProvider)
          throw new TurnRefused(409, 'The agent changed while setting up Talk. Reopen voice settings and try again.');
      };
      const result = await whileBusy(agent.id, async () => {
        stillCurrent();
        const configured = await configureVoice(provider, agent.runtimeRef!, agent.slug, stillCurrent);
        stillCurrent();
        return configured;
      });
      stillCurrent(false);
      if (result.status === 'configured') {
        const current = caller.owned(agent.id)!;
        grantVoiceNetwork(store, current, result.provider);
        if (!voiceNetworkReady(store, current, result.provider)) return said({ status: 'unconfigured', reason: 'network' });
      }
      trace(agent.id)('voice.setup', { status: result.status });
      return said(result);
    } catch (error) {
      if (error instanceof TurnRefused) return refused(error.status, error.message);
      if (error instanceof AgentBusyError) return refused(409, error.userMessage);
      if (error instanceof VoiceSetupError) return refused(error.code === 'unavailable' ? 502 : 409, error.userMessage);
      return refused(502, 'Could not set up Talk. Reopen voice settings and try again.');
    }
  };

  return { status, setup };
}
