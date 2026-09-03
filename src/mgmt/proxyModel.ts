import type { ChatModel, ChatResponse, ChatMessage, ContentBlock, ToolSchema } from './llm.js';

/**
 * ChatModel that rides the control plane's LLM proxy (POST /v1/mgmt/llm/complete)
 * instead of holding an Anthropic credential of its own. Which AI source backs
 * it — and its key — lives entirely server-side; this process only ever holds
 * its cli-token. The answer to "why a separate key for the management bot?":
 * there isn't one.
 */
export interface LlmProxy {
  llmComplete(req: {
    system: string;
    tools: ToolSchema[];
    messages: ChatMessage[];
    maxTokens: number;
  }): Promise<{ stopReason: string; content: ContentBlock[] }>;
}

export class ProxyChatModel implements ChatModel {
  constructor(private readonly api: LlmProxy) {}

  async create(req: {
    system: string;
    tools: ToolSchema[];
    messages: ChatMessage[];
    maxTokens: number;
  }): Promise<ChatResponse> {
    return this.api.llmComplete(req);
  }
}
