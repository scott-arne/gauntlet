import Anthropic from "@anthropic-ai/sdk";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { LLMClient, ToolDefinition, AgentResponse, StopReason, ToolCall, ToolResult } from "./provider";
import { withLlmErrorSanitization } from "../util/sanitize-error";

/**
 * The single method gauntlet calls on its Anthropic-or-Bedrock client. Both the
 * direct `Anthropic` client and our Bedrock adapter satisfy this, so `chat()`
 * below is identical for either. (Anthropic's own client has a far wider
 * surface; we only depend on this slice.)
 */
interface MessagesClient {
  messages: {
    create(
      body: Anthropic.Messages.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

/**
 * The Bedrock InvokeModel API version gauntlet targets. Required in the request
 * body for the Anthropic-on-Bedrock model family.
 */
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

/**
 * Build a `MessagesClient` backed by AWS Bedrock's `InvokeModelCommand`.
 *
 * Why not `@anthropic-ai/bedrock-sdk`: that wrapper (0.30.2) is broken against
 * `@anthropic-ai/sdk` 0.78.0 — its request middleware misfires and Bedrock
 * answers every call with a Coral `UnknownOperationException` envelope. The
 * official AWS SDK works with gauntlet's exact request body (verified), and
 * InvokeModel's request/response bodies ARE the raw Anthropic Messages JSON, so
 * `chat()` and `convertResponse` need no changes.
 *
 * @param model - Bedrock inference-profile id (e.g. us.anthropic.claude-opus-4-8).
 * @param opts.region - AWS region (required).
 * @param opts.send - Injectable AWS send fn (tests stub it; production uses the
 *   real BedrockRuntimeClient). Defaults to a client built with the standard AWS
 *   credential chain honoring AWS_PROFILE.
 */
export function createBedrockMessagesClient(
  model: string,
  opts: { region: string; send?: (command: InvokeModelCommand) => Promise<{ body: Uint8Array }> },
): MessagesClient {
  const send =
    opts.send ??
    (() => {
      const client = new BedrockRuntimeClient({
        region: opts.region,
        credentials: fromNodeProviderChain({ profile: process.env.AWS_PROFILE }),
      });
      return (command: InvokeModelCommand) =>
        client.send(command) as Promise<{ body: Uint8Array }>;
    })();

  return {
    messages: {
      async create(body) {
        // Copy without `model`; Bedrock takes the id as modelId in the command,
        // not in the JSON body. Inject the required anthropic_version. Do not
        // mutate the caller's object.
        const { model: _model, ...rest } = body as unknown as Record<string, unknown>;
        const payload = { anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...rest };

        const command = new InvokeModelCommand({
          modelId: model,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify(payload),
        });

        const response = await send(command);
        const text = new TextDecoder().decode(response.body);
        return JSON.parse(text) as Anthropic.Message;
      },
    },
  };
}

/**
 * True when the Anthropic client should talk to AWS Bedrock instead of the
 * direct Anthropic API. Gated on CLAUDE_CODE_USE_BEDROCK (the same switch Claude
 * Code itself uses) being truthy ("1"/"true"/"yes", case-insensitive). In
 * Bedrock mode auth is the AWS credential chain (AWS_PROFILE/~/.aws or static
 * keys) + AWS_REGION — no ANTHROPIC_API_KEY — and the model id must be a Bedrock
 * inference-profile id (e.g. us.anthropic.claude-sonnet-4-...), passed through
 * verbatim rather than translated from an Anthropic API alias.
 */
export function useBedrock(): boolean {
  const raw = (process.env.CLAUDE_CODE_USE_BEDROCK ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Per-model output-token ceiling. 4096 killed a run mid-verdict
 * (PRI-2160, run b35d: adaptive thinking counts against the cap and a
 * judge composing its final report can think past 4k), but legacy
 * Claude 3.x models reject anything above their smaller caps, so the
 * raise is model-aware. Cost is per token actually emitted, not per
 * cap.
 */
export function maxOutputTokensForModel(model: string): number {
  // Normalize Bedrock inference-profile ids to the bare Anthropic family so the
  // caps below match regardless of provider: a Bedrock id carries a regional
  // routing prefix and an `anthropic.` vendor segment, e.g.
  // `us.anthropic.claude-sonnet-4-5-20250929-v1:0`. Strip everything up to and
  // including `anthropic.` so the family regexes see `claude-...`.
  const family = model.replace(/^[a-z]{2,4}\.anthropic\./, "").replace(/^anthropic\./, "");
  // Known current families (Claude 4.x, Fable/Mythos): plenty of output
  // headroom — the high cap is opt-in by family, not the default.
  if (/^claude-(opus|sonnet|haiku)-4/.test(family) || /^claude-(fable|mythos)-/.test(family)) {
    return 16384;
  }
  // Claude 3.5 / 3.7 family: 8192 without beta headers.
  if (/^claude-3-[57]-/.test(family)) return 8192;
  // Everything else — Claude 3.0, Claude 2.x, and any unrecognized id —
  // keeps the conservative 4096 this code always sent before the raise.
  return 4096;
}

export function createAnthropicClient(model: string): LLMClient {
  // Two auth modes, selected by CLAUDE_CODE_USE_BEDROCK:
  //   - Bedrock: AnthropicBedrock resolves AWS credentials from the standard
  //     chain (AWS_PROFILE/~/.aws or static keys) and needs AWS_REGION; no
  //     ANTHROPIC_API_KEY. The `model` must already be a Bedrock inference
  //     profile id (passed through verbatim — see useBedrock()).
  //   - Direct API: the base Anthropic client, requiring ANTHROPIC_API_KEY.
  // Both expose the same `.messages.create()` surface, so the LLMClient body
  // below is identical for either.
  let client: MessagesClient;
  if (useBedrock()) {
    const awsRegion = (process.env.AWS_REGION ?? "").trim();
    if (!awsRegion) {
      throw new Error(
        "CLAUDE_CODE_USE_BEDROCK is set but AWS_REGION is not. " +
        "Set AWS_REGION to the Bedrock inference region."
      );
    }
    // The official AWS SDK resolves credentials via the standard chain
    // (AWS_PROFILE / ~/.aws / static env keys). `model` is the Bedrock
    // inference-profile id, passed through verbatim.
    client = createBedrockMessagesClient(model, { region: awsRegion });
  } else {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is not set. " +
        "Set it to your Anthropic API key to use Claude models."
      );
    }
    client = new Anthropic();
  }

  return {
    async chat(messages, tools, systemPrompt) {
      const convertedTools = tools.map(convertTool);

      // Cache breakpoint 1: system prompt
      const system: Anthropic.Messages.TextBlockParam[] = [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ];

      // Cache breakpoint 2: last tool definition
      if (convertedTools.length > 0) {
        convertedTools[convertedTools.length - 1] = {
          ...convertedTools[convertedTools.length - 1],
          cache_control: { type: "ephemeral" },
        };
      }

      // Cache breakpoint 3: last message (moving breakpoint for conversation prefix)
      const apiMessages = withCacheBreakpointOnLastMessage(
        messages as Anthropic.MessageParam[]
      );

      const response = await withLlmErrorSanitization(() =>
        client.messages.create({
          model,
          max_tokens: maxOutputTokensForModel(model),
          system,
          messages: apiMessages,
          tools: convertedTools,
          // Sonnet 4.6 defaults to effort:high when unset; medium is Anthropic's
          // recommended default for most apps and the right floor for an
          // observe-and-report tester role. Opus 4.6/4.7 honor this too.
          output_config: { effort: "medium" },
          // Adaptive thinking lets the model decide depth per turn. Thinking
          // blocks are returned in response.content alongside text/tool_use;
          // they round-trip via rawAssistantMessage (signatures intact), so
          // multi-turn loops and session revival pick them up automatically.
          thinking: { type: "adaptive" },
        }),
      );

      return convertResponse(response);
    },

    userMessage(content: string) {
      return { role: "user", content };
    },

    toolResultMessages: anthropicToolResultMessages,
  };
}

export function anthropicToolResultMessages(
  calls: ToolCall[],
  results: ToolResult[],
  extraUserText?: string,
): unknown[] {
  const content: unknown[] = calls.map((call, i) => {
    const result = results[i];
    if (result.kind === "image") {
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
          { type: "text", text: result.text ?? "" },
        ],
      };
    }
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: result.text ?? "",
    };
  });
  if (extraUserText) {
    content.push({ type: "text", text: extraUserText });
  }
  return [{ role: "user", content }];
}

function convertTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool["input_schema"],
  };
}

/**
 * Shallow-clone the last message and add cache_control to its last content block.
 * This creates a moving cache breakpoint so the conversation prefix is cached between turns.
 */
function withCacheBreakpointOnLastMessage(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const result = [...messages];
  const last = result[result.length - 1];

  if (typeof last.content === "string") {
    result[result.length - 1] = {
      ...last,
      content: [
        {
          type: "text" as const,
          text: last.content,
          cache_control: { type: "ephemeral" as const },
        },
      ],
    };
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const contentCopy = [...last.content];
    const lastBlock = contentCopy[contentCopy.length - 1];
    // Our content blocks are always tool_result or text, both support cache_control
    contentCopy[contentCopy.length - 1] = {
      ...lastBlock,
      cache_control: { type: "ephemeral" },
    } as typeof lastBlock;
    result[result.length - 1] = { ...last, content: contentCopy };
  }

  return result;
}

/**
 * Convert an Anthropic SDK `Message` into our provider-neutral
 * `AgentResponse`. Exported for tests; the runtime path uses it via the
 * `chat()` method above.
 */
export function convertResponse(response: Anthropic.Message): AgentResponse {
  // Guard against a 200 whose body is not an Anthropic Message. AWS Bedrock —
  // or a proxy in front of it that doesn't recognize the Bedrock operation —
  // can return a Coral error envelope like
  // `{ Output: { __type: "...UnknownOperationException" }, Version: "1.0" }`,
  // which the SDK does not throw on. Without this guard, `.content.filter()`
  // below dies with an opaque "undefined is not an object" that hides the real
  // cause. Surface the offending top-level shape (keys only — the body may carry
  // proxy-injected values we should not log) so the failure is diagnosable.
  if (!Array.isArray(response?.content)) {
    const keys =
      response && typeof response === "object"
        ? Object.keys(response).join(", ")
        : typeof response;
    throw new Error(
      `Anthropic response has no message content (content is ${typeof response?.content}). ` +
      `This usually means the provider returned a non-message body — e.g. an AWS ` +
      `Bedrock/proxy error envelope rather than a completion. Response top-level keys: [${keys}].`,
    );
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const reasoning = response.content
    .filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking")
    .map((b) => b.thinking)
    .join("\n\n") || undefined;

  const toolCalls = response.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      name: b.name,
      arguments: b.input as Record<string, unknown>,
    }));

  // Pass through stop_reason faithfully. The Anthropic SDK's type already
  // matches our StopReason union for the values we care about. If Anthropic
  // ships a new value (current SDK includes `refusal` which we also cover),
  // TS will complain here and we update the union.
  const stopReason: StopReason =
    (response.stop_reason as StopReason | null) ?? "end_turn";

  // Capture cache breakpoint telemetry. `cache_creation_input_tokens` tells
  // us how many tokens were written to the cache on this turn;
  // `cache_read_input_tokens` tells us how many were served from cache. If
  // both stay at 0 across an entire run, the three breakpoints in chat()
  // are not hitting and we have a silent regression to investigate.
  const cacheCreation = response.usage.cache_creation_input_tokens;
  const cacheRead = response.usage.cache_read_input_tokens;

  return {
    text,
    reasoning,
    toolCalls,
    stopReason,
    rawAssistantMessage: { role: "assistant", content: response.content },
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: cacheCreation ?? undefined,
      cacheReadInputTokens: cacheRead ?? undefined,
    },
    rawUsage: response.usage,
  };
}
