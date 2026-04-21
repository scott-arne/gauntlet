export type Provider = "anthropic" | "openai";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  text: string;
  image?: {
    data: string;       // base64-encoded
    mediaType: string;  // e.g. "image/png"
  };
  imagePath?: string;       // relative path if the image has been persisted
  artifactPath?: string;    // relative path if a large payload was spilled
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Tokens written to the prompt cache on this turn. Set by Anthropic's
   * `cache_creation_input_tokens`. OpenAI's SDK does not surface this
   * metric in the current shape we consume, so it stays undefined there.
   */
  cacheCreationInputTokens?: number;
  /**
   * Tokens read from the prompt cache on this turn. Set by Anthropic's
   * `cache_read_input_tokens`. Tells us whether the three cache
   * breakpoints in anthropic.ts are actually hitting.
   */
  cacheReadInputTokens?: number;
}

/**
 * Reason the model stopped generating. Faithfully passed through from the
 * provider instead of being collapsed. If a new value ever appears at
 * runtime that the type doesn't cover, the provider module's cast will
 * keep working, but the agent loop's exhaustive handling will force us to
 * update this union.
 */
export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "pause_turn"
  | "refusal";

export interface AgentResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  rawAssistantMessage: unknown;
  usage: TokenUsage;
}

export interface LLMClient {
  chat(
    messages: unknown[],
    tools: ToolDefinition[],
    systemPrompt: string
  ): Promise<AgentResponse>;

  userMessage(content: string): unknown;

  toolResultMessages(calls: ToolCall[], results: ToolResult[]): unknown[];
}
