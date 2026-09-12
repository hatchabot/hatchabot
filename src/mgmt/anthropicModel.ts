import Anthropic from '@anthropic-ai/sdk';
import type { ChatModel, ChatMessage, ChatResponse, ContentBlock, ToolSchema } from './llm.js';

/**
 * The mgmt bot's OWN-KEY path onto the Messages API (the default path is the
 * control plane's proxy — see proxyModel.ts and api/mgmtLlm.ts, which has the
 * server-side twin of this credential handling). Kept thin so llm.ts stays
 * testable without a network or an API key.
 *
 * Extended thinking is intentionally left off for now: this is short, mechanical
 * tool-calling, and thinking would add thinking-block replay plumbing to the
 * loop for little gain. Revisit if the assistant needs to reason harder.
 */
export class AnthropicChatModel implements ChatModel {
  #client: Anthropic;
  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    // A Claude Max/Pro setup-token (`claude setup-token`, sk-ant-oat…) is an
    // OAuth bearer, not an API key — the SDK sends it via authToken. Accepting
    // both here means HATCHABOT_MGMT_ANTHROPIC_KEY takes whichever credential
    // the owner has, same as the fleet's AI profiles do.
    // Case-insensitive to match the routes-side detection (routes.ts rejects
    // oat-as-api-key with /i) — a mixed-case token must not slip into the
    // wrong client mode.
    this.#client = /^sk-ant-oat/i.test(apiKey)
      ? new Anthropic({ authToken: apiKey, apiKey: null })
      : new Anthropic({ apiKey });
  }

  async create(req: {
    system: string;
    tools: ToolSchema[];
    messages: ChatMessage[];
    maxTokens: number;
  }): Promise<ChatResponse> {
    const resp = await this.#client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      tools: req.tools as Anthropic.Tool[],
      messages: req.messages as Anthropic.MessageParam[],
    });
    // The SDK's response content blocks (text / tool_use) are structurally a
    // superset of ContentBlock; we only read type/text/id/name/input.
    return {
      stopReason: resp.stop_reason ?? 'end_turn',
      content: resp.content as unknown as ContentBlock[],
    };
  }
}
