import Anthropic from '@anthropic-ai/sdk';
import type { AIProfile } from '../domain/types.js';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';

/**
 * The management bot's LLM rides one of the owner's AI sources, proxied
 * through the control plane — the answer to "why would I manage a separate
 * key for the mgmt bot?". The credential is decrypted HERE, per call, and
 * never crosses the wire to the bot process; the bot authenticates with its
 * cli-token like it does for everything else.
 */

/** A source can back the proxy only if its credential is portable to a raw
 *  Messages call: an anthropic api key or a Max setup-token. Machine-login
 *  (~/.claude, CLI-managed) and local model servers can't. */
export function usableForMgmt(p: AIProfile): boolean {
  return p.vendor === 'anthropic' && !!p.secretRef;
}

/** The owner's flagged source; else the sensible automatic pick (api-key
 *  before setup-token, so metered-but-supported beats subscription-but-gray). */
export function pickMgmtProfile(store: Store, ownerId: string): AIProfile | undefined {
  const own = store.listAIProfiles(ownerId).filter((p) => p.ownerId === ownerId);
  const flagged = own.find((p) => p.mgmtLlm && usableForMgmt(p));
  if (flagged) return flagged;
  const usable = own.filter(usableForMgmt);
  return usable.find((p) => p.kind === 'api_key') ?? usable[0];
}

export interface MgmtChatRequest {
  system: string;
  tools: unknown[];
  messages: unknown[];
  maxTokens: number;
}

export interface MgmtChatResponse {
  stopReason: string;
  content: unknown[];
}

/**
 * Turn an Anthropic SDK error into something a chat pane can show. The raw
 * message is a JSON blob ("429 {\"type\":\"error\"...}") — useless to the
 * person mid-conversation. Rate limits deserve the honest household truth:
 * agents, the management chat, and Claude Code all share one subscription.
 */
export function friendlyLlmError(raw: string): string {
  if (/429|rate_limit/i.test(raw)) {
    return 'The AI source is rate-limited right now — your agents, this chat, and Claude Code share its budget. Wait a minute and try again.';
  }
  if (/529|overloaded/i.test(raw)) {
    return "Anthropic is overloaded at the moment — not your quota. Try again shortly.";
  }
  if (/401|invalid.*(key|bearer|token)/i.test(raw)) {
    return 'The AI source rejected its credential — check the 🛠 Management source under ⚙ Settings → AI sources.';
  }
  return raw.slice(0, 300);
}

export async function completeWithProfile(
  secrets: SecretStore,
  profile: AIProfile,
  req: MgmtChatRequest,
): Promise<MgmtChatResponse> {
  const cred = await secrets.get(profile.secretRef!);
  // A setup-token (sk-ant-oat…) is an OAuth bearer, not an API key.
  // Case-insensitive, matching the routes-side oat detection.
  const client = /^sk-ant-oat/i.test(cred)
    ? new Anthropic({ authToken: cred, apiKey: null })
    : new Anthropic({ apiKey: cred });
  const resp = await client.messages.create({
    model: profile.model,
    max_tokens: req.maxTokens,
    system: req.system,
    tools: req.tools as Anthropic.Tool[],
    messages: req.messages as Anthropic.MessageParam[],
  });
  return { stopReason: resp.stop_reason ?? 'end_turn', content: resp.content };
}
