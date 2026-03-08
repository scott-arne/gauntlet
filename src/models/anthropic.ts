import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, ToolDefinition, AgentResponse, ToolCall, ToolResult } from "./provider";

export function createAnthropicClient(model: string): LLMClient {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is not set. " +
      "Set it to your Anthropic API key to use Claude models."
    );
  }
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

    toolResultMessages(calls: ToolCall[], results: ToolResult[]) {
      return [
        {
          role: "user",
          content: calls.map((call, i) => {
            const result = results[i];
            if (result.image) {
              return {
                type: "tool_result",
                tool_use_id: call.id,
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: result.image.mediaType,
                      data: result.image.data,
                    },
                  },
                  { type: "text", text: result.text },
                ],
              };
            }
            return {
              type: "tool_result",
              tool_use_id: call.id,
              content: result.text,
            };
          }),
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
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
