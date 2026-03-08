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

export interface AgentResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  rawAssistantMessage: unknown;
}

export interface LLMClient {
  chat(
    messages: unknown[],
    tools: ToolDefinition[],
    systemPrompt: string
  ): Promise<AgentResponse>;

  userMessage(content: string): unknown;

  toolResultMessages(calls: ToolCall[], results: string[]): unknown[];
}
