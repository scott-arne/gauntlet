import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, ToolDefinition, AgentResponse, ToolCall } from "./provider";

export function createAnthropicClient(model: string): LLMClient {
  const client = new Anthropic();

  return {
    async chat(messages, tools, systemPrompt) {
      const response = await client.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages as Anthropic.MessageParam[],
        tools: tools.map(convertTool),
      });

      return convertResponse(response);
    },

    userMessage(content: string) {
      return { role: "user", content };
    },

    toolResultMessages(calls: ToolCall[], results: string[]) {
      return [
        {
          role: "user",
          content: calls.map((call, i) => ({
            type: "tool_result",
            tool_use_id: call.id,
            content: results[i],
          })),
        },
      ];
    },
  };
}

function convertTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool["input_schema"],
  };
}

function convertResponse(response: Anthropic.Message): AgentResponse {
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const toolCalls = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      arguments: b.input as Record<string, unknown>,
    }));

  const stopReason =
    response.stop_reason === "tool_use" ? "tool_use" : "end_turn";

  return {
    text,
    toolCalls,
    stopReason,
    rawAssistantMessage: { role: "assistant", content: response.content },
  };
}
