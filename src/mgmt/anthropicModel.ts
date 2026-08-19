import Anthropic from '@anthropic-ai/sdk';
import type { ChatModel, ChatMessage, ChatResponse, ContentBlock, ToolSchema } from './llm.js';

/**
 * The only place the Anthropic SDK is touched. Maps the SDK-agnostic ChatModel
 * request/response onto the Messages API. Kept thin so llm.ts stays testable
 * without a network or an API key.
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
    this.#client = new Anthropic({ apiKey });
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
