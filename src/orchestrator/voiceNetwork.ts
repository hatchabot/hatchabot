import { createHash } from 'node:crypto';
import type { Agent } from '../domain/types.js';
import type { Store } from '../store/store.js';

// Only these names from the redacted Talk status can authorize a destination.
// Neither caller input nor runtime configuration supplies a hostname.
const PROVIDERS = new Map([
  ['Google', { id: 'google', hosts: ['generativelanguage.googleapis.com'] }],
  // API-key calls use api.openai.com. Browser OAuth call creation uses the
  // ChatGPT broker, then a sideband connection to api.openai.com.
  ['OpenAI', { id: 'openai', hosts: ['api.openai.com', 'chatgpt.com'] }],
]);

function agentContext(agent: Agent): unknown[] {
  return [agent.id, agent.ownerId, agent.slug, agent.runtimeRef, agent.hostId,
    agent.aiProfileId, agent.appliedProfileId, agent.appliedProfileAt];
}

/** The grant belongs to the exact manager/runtime/source approved by its
 * owner. Hash records, not credentials, and never trust a stale caller copy. */
function context(store: Store, agent: Agent): string | undefined {
  if (!agent.ops || agent.state !== 'RUNNING' || !agent.runtimeRef) return undefined;
  const fresh = store.getAgent(agent.id);
  if (!fresh?.ops || fresh.state !== 'RUNNING' || !fresh.runtimeRef ||
      JSON.stringify(agentContext(fresh)) !== JSON.stringify(agentContext(agent))) return undefined;
  const host = store.getHost(fresh.hostId), profile = store.getAIProfile(fresh.aiProfileId);
  const appliedProfile = fresh.appliedProfileId ? store.getAIProfile(fresh.appliedProfileId) : undefined;
  if (!host || !profile || (fresh.appliedProfileId && !appliedProfile)) return undefined;
  return createHash('sha256').update(JSON.stringify([agentContext(fresh), host, profile, appliedProfile])).digest('hex');
}

/** Extra fixed hosts admitted by the owner's explicit Set up Talk action. */
export function voiceNetworkHosts(store: Store, agent: Agent): string[] {
  const current = context(store, agent);
  if (!current) return [];
  const raw = store.getVoiceNetworkGrant(agent.id);
  if (!raw || raw.length > 512) return [];
  try {
    const grant: unknown = JSON.parse(raw);
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) return [];
    const g = grant as Record<string, unknown>;
    if (Object.keys(g).sort().join(',') !== 'context,provider,version' ||
        g.version !== 1 || g.context !== current) return [];
    const provider = [...PROVIDERS.values()].find((entry) => entry.id === g.provider);
    return provider ? [...provider.hosts] : [];
  } catch { return []; }
}

/** Ordinary agents have no manager jail. Google text already admits its voice
 * host; OpenAI voice also needs its OAuth broker, so requires explicit setup. */
export function voiceNetworkReady(store: Store, agent: Agent, providerLabel?: string): boolean {
  if (!agent.ops) return true;
  const provider = PROVIDERS.get(providerLabel ?? '');
  if (!provider || !context(store, agent)) return false;
  if (provider.id === 'google' && store.getAIProfile(agent.aiProfileId)?.vendor === 'google') return true;
  const hosts = voiceNetworkHosts(store, agent);
  return provider.hosts.every((host) => hosts.includes(host));
}

/** Called synchronously only after the owner setup route's final context
 * check and configured catalog result. No reads or configuration checks grant
 * access, and an unsupported label cannot broaden the proxy. */
export function grantVoiceNetwork(store: Store, agent: Agent, providerLabel?: string): void {
  const provider = PROVIDERS.get(providerLabel ?? '');
  if (!provider) return;
  const current = context(store, agent);
  if (!current) return;
  store.setVoiceNetworkGrant(agent.id, JSON.stringify({ version: 1, provider: provider.id, context: current }));
}
