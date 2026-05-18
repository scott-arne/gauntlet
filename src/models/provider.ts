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

/**
 * Result returned from a tool invocation. Modeled as a discriminated
 * union on `kind` (PRI-1628 phase 6): every variant has `text` (what
 * the LLM sees on the next turn) and an optional `transcriptText`
 * (the run.jsonl override used for transcript redaction, PRI-1605).
 * The four `as any` casts in agent.ts that previously accessed
 * imagePath/image/artifactPath/capturePath are now narrowed via the
 * field-presence properties below.
 *
 * Producer survey (live in src/, not aspirational):
 *  - `text`     — most paths (errors, navigate, type, press, …)
 *  - `image`    — web screenshot + return_screenshot
 *  - `capture`  — TUI read_screen
 *  - `artifact` — no current producer; kept for the spill-to-artifacts
 *    pathway tracked by the evidence-log plan (artifactPath ends up
 *    on disk via logger.normalizeText, not a tool producer).
 */
interface ToolResultBase {
  text: string;
  /**
   * Optional alternative representation used for the run transcript /
   * evidence log. When set, `text` still goes to the agent's live
   * context (the agent must see the real value to type or paste it),
   * but `tool_result.text` in run.jsonl uses this string instead.
   * Use when the agent-visible value contains a secret that should
   * not land in the transcript by default. PRI-1605.
   */
  transcriptText?: string;
}

export interface TextToolResult extends ToolResultBase {
  kind: "text";
}

export interface ImageToolResult extends ToolResultBase {
  kind: "image";
  image: {
    data: string; // base64-encoded
    mediaType: string; // e.g. "image/png"
  };
  imagePath?: string; // relative path if the image has been persisted
}

export interface ArtifactToolResult extends ToolResultBase {
  kind: "artifact";
  artifactPath: string; // relative path of the spilled payload
}

export interface CaptureToolResult extends ToolResultBase {
  kind: "capture";
  /**
   * TUI screen capture path (`captures/NNN.ansi`). Populated by the TUI
   * adapter's `read_screen` handler. The evidence logger substitutes
   * this path for `text` in the tool_result row — the in-memory `text`
   * still carries the full ANSI content so the LLM sees the screen
   * content on its next turn.
   */
  capturePath: string;
}

export type ToolResult =
  | TextToolResult
  | ImageToolResult
  | ArtifactToolResult
  | CaptureToolResult;

/**
 * Convenience constructor for the dominant `text` variant. Saves
 * every producer from spelling `{ kind: "text", text }`.
 */
export function textResult(text: string, opts?: { transcriptText?: string }): TextToolResult {
  return opts?.transcriptText !== undefined
    ? { kind: "text", text, transcriptText: opts.transcriptText }
    : { kind: "text", text };
}

export interface TokenUsage {
  /**
   * Uncached input tokens for this turn. Convention: Anthropic's
   * `input_tokens` is naturally disjoint from `cache_read_input_tokens`,
   * so it lands here as-is. OpenAI's `ResponseUsage.input_tokens`
   * *includes* `input_tokens_details.cached_tokens`; the OpenAI
   * adapter subtracts so this field stays uncached-only across both
   * providers.
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * Tokens written to the prompt cache on this turn. Anthropic only —
   * set from `cache_creation_input_tokens`. OpenAI's `ResponseUsage`
   * returns only a read counter, no write counter, so this stays
   * undefined there.
   */
  cacheCreationInputTokens?: number;
  /**
   * Tokens read from the prompt cache on this turn. Both providers
   * populate this — Anthropic from `cache_read_input_tokens`, OpenAI
   * from `input_tokens_details.cached_tokens`. Tells us whether
   * caching is actually hitting.
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
  /**
   * Model's reasoning content for this turn. OpenAI populates with
   * the joined text from `ResponseReasoningItem.summary[]` (a model-
   * authored summary, not raw chain-of-thought — OpenAI does not
   * expose raw thoughts). Anthropic will populate with extended-
   * thinking text once the separate Anthropic ticket lands; today
   * it leaves this undefined. Distinct from the verdict's
   * `reasoning` field on RunEndFields, which is the agent's
   * justification for its pass/fail/investigate verdict.
   */
  reasoning?: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  rawAssistantMessage: unknown;
  usage: TokenUsage;
}

/**
 * Optional per-request context. Currently used by the OpenAI adapter
 * for `prompt_cache_key` (set to `runId`) to improve routing
 * stickiness across turns of the same run. Anthropic ignores it; its
 * caching uses `cache_control` breakpoints, not key-based routing.
 */
export interface RequestContext {
  runId?: string;
}

export interface LLMClient {
  chat(
    messages: unknown[],
    tools: ToolDefinition[],
    systemPrompt: string,
    requestContext?: RequestContext,
  ): Promise<AgentResponse>;

  userMessage(content: string): unknown;

  /**
   * Build the user-side messages that carry tool_result blocks for the
   * next request. When `extraUserText` is set (reflection checkpoints,
   * forthcoming deadline reminders), each provider weaves that text into
   * the same user turn — Anthropic appends a `text` block to the user
   * message containing the tool_result blocks; OpenAI appends a separate
   * `user` message after the per-call `tool` messages. The reflection
   * stays attached to the same logical turn instead of inventing a
   * standalone user turn (which Anthropic forbids).
   */
  toolResultMessages(
    calls: ToolCall[],
    results: ToolResult[],
    extraUserText?: string,
  ): unknown[];
}

/**
 * Append an assistant turn's `rawAssistantMessage` to the messages
 * array. Anthropic returns a single message object → push as-is.
 * OpenAI Responses returns an array of output items (reasoning,
 * function calls, message) → spread into the flat `input[]` shape
 * the next request expects.
 */
export function pushAssistantTurn(messages: unknown[], rawAssistantMessage: unknown): void {
  if (Array.isArray(rawAssistantMessage)) {
    messages.push(...rawAssistantMessage);
  } else {
    messages.push(rawAssistantMessage);
  }
}
