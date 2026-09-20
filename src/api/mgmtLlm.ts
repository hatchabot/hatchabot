import Anthropic from '@anthropic-ai/sdk';
import type { AIProfile } from '../domain/types.js';
import type { Store } from '../store/store.js';
import type { SecretStore } from '../secrets/secretStore.js';

/**
 * The management chat's LLM rides one of the owner's AI sources, proxied
 * through the control plane — the answer to "why would I manage a separate
 * key for the mgmt bot?". The credential is decrypted HERE, per call, and
 * never crosses the wire to the bot process; the bot authenticates with its
 * cli-token like it does for everything else.
 */

/**
 * Any Anthropic source can back the management assistant — no extra
 * credential is ever required (an adoption hurdle by design, per Chris,
 * 2026-09-03). An api-key goes to the Messages API directly; a subscription
 * (setup-token or machine-login) rides the Claude CLI on the host, the
 * surface Max actually sanctions. Only local model servers are out.
 */
export function usableForMgmt(p: AIProfile): boolean {
  return p.vendor === 'anthropic';
}

/** The owner's flagged source; else the automatic pick: api-key (fastest)
 *  → setup-token → machine-login, all zero-setup. */
export function pickMgmtProfile(store: Store, ownerId: string): AIProfile | undefined {
  const own = store.listAIProfiles(ownerId).filter((p) => p.ownerId === ownerId);
  const flagged = own.find((p) => p.mgmtLlm && usableForMgmt(p));
  if (flagged) return flagged;
  const usable = own.filter(usableForMgmt);
  return (
    usable.find((p) => p.kind === 'api_key') ??
    usable.find((p) => p.kind === 'subscription' && !!p.secretRef) ??
    usable[0]
  );
}

/** How a profile's calls are made + the label the UI shows for it. */
export function mgmtBackendOf(p: AIProfile): { kind: 'api' | 'cli'; credential: string } {
  if (p.kind === 'api_key') return { kind: 'api', credential: 'api-key' };
  return {
    kind: 'cli',
    credential: p.secretRef ? 'setup-token · claude-cli' : 'machine-login · claude-cli',
  };
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
    return 'The AI source is rate-limited right now — wait a minute and try again.';
  }
  if (/529|overloaded/i.test(raw)) {
    return "Anthropic is overloaded at the moment — not your quota. Try again shortly.";
  }
  if (/401|invalid.*(key|bearer|token)/i.test(raw)) {
    return 'The AI source rejected its credential — check the 🛠 Management source under ⚙ Settings → AI sources.';
  }
  return raw.slice(0, 300);
}

export interface RunCompletionDeps {
  secrets: SecretStore;
  /** Test seams: the api-key path and the CLI path. */
  apiComplete?: typeof completeWithProfile;
  cliComplete?: (opts: { model: string; oauthToken?: string }, req: MgmtChatRequest) => Promise<MgmtChatResponse>;
}

/**
 * One entry point for a management completion, whatever the source's shape:
 * api-key → direct Messages call; subscription → the Claude CLI on the host
 * (setup-token decrypted into CLAUDE_CODE_OAUTH_TOKEN; machine-login uses the
 * host's own ~/.claude). Both the web chat pane and the Telegram proxy route
 * go through here.
 */
export async function runMgmtCompletion(
  deps: RunCompletionDeps,
  profile: AIProfile,
  req: MgmtChatRequest,
): Promise<MgmtChatResponse> {
  const backend = mgmtBackendOf(profile);
  if (backend.kind === 'api') {
    return (deps.apiComplete ?? completeWithProfile)(deps.secrets, profile, req);
  }
  const { completeViaCli } = await import('./cliChatModel.js');
  const oauthToken = profile.secretRef ? await deps.secrets.get(profile.secretRef) : undefined;
  return (deps.cliComplete ?? completeViaCli)({ model: profile.model, oauthToken }, req);
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
