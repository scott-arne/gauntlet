import OpenAI from "openai";
import type { LLMClient, ToolDefinition, AgentResponse, StopReason, ToolCall, ToolResult } from "./provider";
import { withLlmErrorSanitization } from "../util/sanitize-error";

export function createOpenAIClient(model: string): LLMClient {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY environment variable is not set. " +
      "Set it to your OpenAI API key to use GPT models."
    );
  }
  const client = new OpenAI();

  return {
    async chat(messages, tools, systemPrompt) {
      const response = await withLlmErrorSanitization(() =>
        client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            ...(messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[]),
          ],
          tools: tools.length > 0 ? tools.map(convertTool) : undefined,
        }),
      );

      return convertResponse(response);
    },

    userMessage(content: string) {
      return { role: "user", content };
    },

    toolResultMessages: openaiToolResultMessages,
  };
}

export function openaiToolResultMessages(calls: ToolCall[], results: ToolResult[]): unknown[] {
  const messages: unknown[] = calls.map((call, i) => ({
    role: "tool",
    tool_call_id: call.id,
    content: results[i].text ?? "",
  }));

  const imageParts: unknown[] = [];
  for (const result of results) {
    if (result.image) {
      imageParts.push({
        type: "image_url",
        image_url: {
          url: `data:${result.image.mediaType};base64,${result.image.data}`,
        },
      });
    }
  }

  if (imageParts.length > 0) {
    messages.push({
      role: "user",
      content: [
        { type: "text", text: "Screenshots from the tool calls above:" },
        ...imageParts,
      ],
    });
  }

  return messages;
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

  const stopReason = mapFinishReason(choice.finish_reason);

  return {
    text,
    toolCalls,
    stopReason,
    rawAssistantMessage: {
      role: "assistant",
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    },
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Map OpenAI's `finish_reason` to our provider-neutral StopReason.
 *
 * OpenAI values: `'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call'`.
 * The mapping is lossy but honest:
 *   - `tool_calls` / `function_call` → `tool_use` (LLM invoked a tool)
 *   - `length`                       → `max_tokens` (hit the token cap)
 *   - `stop`                         → `end_turn` (natural completion)
 *   - `content_filter`               → `stop_sequence` (best approximation;
 *     OpenAI's filter is not a stop sequence but this is the closest
 *     semantic: the provider intervened before model-driven end_turn)
 *
 * Exported for tests.
 */
export function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "stop_sequence";
    case "stop":
    case null:
      return "end_turn";
    default:
      // Unknown future value — fall through to end_turn so the agent loop
      // doesn't crash, but log visibly via the string cast.
      return "end_turn";
  }
}
