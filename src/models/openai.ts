import OpenAI from "openai";
import type { LLMClient, ToolDefinition, AgentResponse, ToolCall } from "./provider";

export function createOpenAIClient(model: string): LLMClient {
  const client = new OpenAI();

  return {
    async chat(messages, tools, systemPrompt) {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...(messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[]),
        ],
        tools: tools.length > 0 ? tools.map(convertTool) : undefined,
      });

      return convertResponse(response);
    },

    userMessage(content: string) {
      return { role: "user", content };
    },

    toolResultMessages(calls: ToolCall[], results: string[]) {
      return calls.map((call, i) => ({
        role: "tool",
        tool_call_id: call.id,
        content: results[i],
      }));
    },
  };
}

function convertTool(
  tool: ToolDefinition
): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function convertResponse(
  response: OpenAI.Chat.Completions.ChatCompletion
): AgentResponse {
  const choice = response.choices[0];
  const text = choice.message.content || "";

  const toolCalls: AgentResponse["toolCalls"] = [];
  for (const tc of choice.message.tool_calls || []) {
    if (tc.type === "function") {
      toolCalls.push({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      });
    }
  }

  const stopReason =
    choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";

  return {
    text,
    toolCalls,
    stopReason,
    rawAssistantMessage: {
      role: "assistant",
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    },
  };
}
