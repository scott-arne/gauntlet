import type { LLMClient, ToolDefinition, ToolResult } from "../models/provider";
import type { Adapter } from "../adapters/adapter";
import type { EvidenceLogger } from "../evidence/logger";
import type { StoryCard } from "../format/story-card";
import type { VetResult, VetStatus } from "../types";
import { RESULT_SCHEMA_VERSION } from "../types";
import { buildSystemPrompt } from "./prompts";
import { parseReportResult } from "./validators";

const DEFAULT_MAX_TURNS = 50;
const DEFAULT_TOOL_TIMEOUT_MS = 30000;

export interface AgentOptions {
  toolTimeoutMs?: number;
  /**
   * Max agent turns. Defaults to 50. Surfaces as `--turns` on the CLI
   * and `turns` on the run request body.
   */
  maxTurns?: number;
  /**
   * Rendered tree listing for the system prompt's Context section,
   * produced by `renderContextTree` in `src/context/tree.ts`. May be
   * undefined or empty, in which case the Context section is omitted.
   * Per Gauntlet v1.5 spec §4.2, the tree is built **once per run** —
   * the runner calls `renderContextTree` and passes the result here.
   * `runAgent` does not re-render or refresh it.
   */
  contextTree?: string;
  /**
   * The run's primary identity, written into the result so the artifact
   * is self-describing on disk. Required: every caller must thread a
   * real id through (production callers via `makeRunId(card.id)`, tests
   * via `makeRunId` or a fixed string). Required rather than defaulted
   * so a forgetful caller can't silently produce an empty-string runId
   * in `result.json`.
   */
  runId: string;
  /** LLM provider name (e.g. "anthropic", "openai"). Surfaced on the run_start log row. */
  provider?: string;
  /** LLM model name (e.g. "claude-opus-4-7"). Surfaced on the run_start log row. */
  model?: string;
  /** Absolute path to the run's evidence directory. Threaded onto the
   * run_start / run_end events so the CLI stream can show an `evidence`
   * line. Optional — older call sites that don't set it simply get no
   * `evidence` line rendered. */
  outDir?: string;
  /** `WxH` viewport string for the web adapter (e.g. `"1440x900"`).
   * Undefined for non-web adapters. Surfaced on the run_start `adapter`
   * line in the CLI stream. */
  viewport?: string;
}

const REPORT_TOOL: ToolDefinition = {
  name: "report_result",
  description:
    "Report your test result. Call this when you are done testing.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["pass", "fail", "investigate"],
        description: "Your verdict",
      },
      summary: {
        type: "string",
        description: "Brief summary of what happened",
      },
      reasoning: {
        type: "string",
        description: "Why you reached this verdict",
      },
      observations: {
        type: "array",
        description: "Any observations, bugs, suggestions, etc.",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [
                "bug",
                "ux",
                "typo",
                "suggestion",
                "a11y",
                "performance",
              ],
            },
            description: { type: "string" },
          },
          required: ["kind", "description"],
        },
      },
    },
    required: ["status", "summary", "reasoning"],
  },
};

export async function runAgent(
  card: StoryCard,
  adapter: Adapter,
  client: LLMClient,
  logger: EvidenceLogger,
  target: string | undefined,
  options: AgentOptions,
): Promise<VetResult> {
  const startTime = Date.now();
  const { runId } = options;
  const systemPrompt = buildSystemPrompt(card, options.contextTree, adapter.name);
  const tools = [...adapter.toolDefinitions(), REPORT_TOOL];

  logger.logRunStart({
    runId,
    cardId: card.id,
    target,
    provider: options.provider ?? "unknown",
    model: options.model ?? "unknown",
    adapter: adapter.name ?? "unknown",
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    toolTimeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    contextTreeBytes: options.contextTree ? Buffer.byteLength(options.contextTree, "utf8") : 0,
    outDir: options.outDir,
    viewport: options.viewport,
  });
  logger.logSystemPrompt(systemPrompt);

  let initialMessage = "Begin testing. Use the available tools to interact with the application.";
  if (target) {
    initialMessage += `\n\n${adapter.describeTarget(target)}`;
  }

  logger.logUserMessage(0, initialMessage);

  const messages: unknown[] = [
    client.userMessage(initialMessage),
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let turns = 0;
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;

  /**
   * Build a terminal VetResult with shared scaffolding (schema, evidence,
   * duration, usage). Used by every early-exit: report_result, max_tokens
   * truncation, empty response, and the max-turns fallthrough.
   */
  const buildResult = (partial: {
    status: VetStatus;
    summary: string;
    reasoning: string;
    observations?: VetResult["observations"];
  }): VetResult => {
    const result: VetResult = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      runId,
      scenario: card.id,
      status: partial.status,
      summary: partial.summary,
      reasoning: partial.reasoning,
      observations: partial.observations ?? [],
      evidence: {
        screenshots: logger.screenshots,
        log: logger.logPath,
        artifacts: logger.artifacts.length > 0 ? logger.artifacts : undefined,
        captures: logger.captures.length > 0 ? logger.captures : undefined,
      },
      duration_ms: Date.now() - startTime,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationInputTokens: totalCacheCreation > 0 ? totalCacheCreation : undefined,
        cacheReadInputTokens: totalCacheRead > 0 ? totalCacheRead : undefined,
        turns,
      },
    };
    logger.logRunEnd({
      status: result.status,
      summary: result.summary,
      reasoning: result.reasoning,
      observationCount: result.observations.length,
      observations: result.observations,
      durationMs: result.duration_ms,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationInputTokens: totalCacheCreation > 0 ? totalCacheCreation : undefined,
        cacheReadInputTokens: totalCacheRead > 0 ? totalCacheRead : undefined,
        turns,
      },
      outDir: options.outDir,
    });
    return result;
  };

  for (let turn = 0; turn < maxTurns; turn++) {
    logger.logLlmRequest(turns + 1, messages.length);
    const response = await client.chat(messages, tools, systemPrompt);

    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;
    totalCacheCreation += response.usage.cacheCreationInputTokens ?? 0;
    totalCacheRead += response.usage.cacheReadInputTokens ?? 0;
    turns++;

    const thinkingBlocks: Array<{ text: string; signature?: string }> = [];
    const raw = response.rawAssistantMessage as { content?: Array<Record<string, unknown>> } | undefined;
    if (raw && Array.isArray(raw.content)) {
      for (const block of raw.content) {
        if (block && block.type === "thinking" && typeof block.thinking === "string") {
          thinkingBlocks.push({
            text: block.thinking as string,
            signature: typeof block.signature === "string" ? block.signature : undefined,
          });
        }
      }
    }

    logger.logLlmResponse({
      turn: turns,
      stopReason: response.stopReason,
      text: response.text,
      thinking: thinkingBlocks,
      toolCalls: response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
        cacheReadInputTokens: response.usage.cacheReadInputTokens,
      },
      rawAssistantMessage: response.rawAssistantMessage,
    });

    // Check for report_result.
    //
    // Policy: if the LLM emits report_result *alongside* other tool calls
    // in the same turn, the other tools are silently dropped. Acting on
    // them would be dangerous — the agent has already decided the verdict
    // and further tool calls (clicks, navigates) would be for a scenario
    // the model considers finished. We log the dropped names to the
    // evidence log so they're recoverable post-hoc.
    const report = response.toolCalls.find(
      (tc) => tc.name === "report_result"
    );
    if (report) {
      const otherTools = response.toolCalls.filter(
        (tc) => tc.name !== "report_result"
      );
      if (otherTools.length > 0) {
        logger.logEvent("report_with_other_tools_dropped", {
          dropped: otherTools.map((tc) => tc.name),
        });
      }

      const parsed = parseReportResult(report.arguments);
      if (!parsed.ok) {
        // Raw args in reasoning so a human post-mortem can reconstruct
        // what the model tried to report.
        let rawArgs = "<unserializable>";
        try { rawArgs = JSON.stringify(report.arguments); } catch { /* ignore */ }
        return buildResult({
          status: "investigate",
          summary: `LLM returned malformed report_result: ${parsed.reason}`,
          reasoning: `Validator rejected report_result args. raw=${rawArgs}`,
        });
      }
      return buildResult({
        status: parsed.value.status,
        summary: parsed.value.summary,
        reasoning: parsed.value.reasoning,
        observations: parsed.value.observations,
      });
    }

    // Truncated output. Nudging an already-truncated turn just burns more
    // tokens — break immediately with an investigate verdict so the human
    // (or an escalating scheduler) sees the problem.
    if (response.stopReason === "max_tokens") {
      logger.logEvent("stopped_max_tokens", {
        turn: turns,
        hasText: Boolean(response.text),
        toolCallCount: response.toolCalls.length,
      });
      return buildResult({
        status: "investigate",
        summary: "LLM response truncated by max_tokens before reporting",
        reasoning: `Stopped with max_tokens on turn ${turns}. Increase max_tokens or shorten the scenario.`,
      });
    }

    // Process tool calls
    if (response.toolCalls.length > 0) {
      messages.push(response.rawAssistantMessage);

      const toolTimeout = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      const results: ToolResult[] = [];
      for (const tc of response.toolCalls) {
        logger.logToolCall({ turn: turns, toolUseId: tc.id, name: tc.name, arguments: tc.arguments });
        const started = Date.now();
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let result: ToolResult;
        let errored = false;
        try {
          result = await Promise.race([
            adapter.executeTool(tc.name, tc.arguments, logger),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`Tool "${tc.name}" timed out after ${toolTimeout}ms`)),
                toolTimeout,
              );
            }),
          ]);
        } catch (error) {
          errored = true;
          const message = error instanceof Error ? error.message : String(error);
          result = { text: `Error: ${message}` };
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        results.push(result);
        logger.logToolResult({
          turn: turns,
          toolUseId: tc.id,
          name: tc.name,
          durationMs: Date.now() - started,
          text: result.text ?? "",
          image: (result as any).imagePath,       // populated by T6; undefined today
          artifact: (result as any).artifactPath, // populated by T6/T7
          capturePath: (result as any).capturePath, // populated by TUIAdapter read_screen
          error: errored,
        });
      }

      messages.push(...client.toolResultMessages(response.toolCalls, results));
    } else if (response.text) {
      messages.push(response.rawAssistantMessage);
      messages.push(
        client.userMessage(
          "Use the tools to interact with the application, or call report_result when done."
        )
      );
    } else {
      // Neither tool calls nor text. Re-sending the same prompt would
      // produce the same empty response — break instead of spinning for
      // the rest of MAX_TURNS.
      logger.logEvent("empty_response", {
        turn: turns,
        stopReason: response.stopReason,
      });
      return buildResult({
        status: "investigate",
        summary: "LLM returned neither tool call nor text",
        reasoning: `Empty response on turn ${turns} with stopReason: ${response.stopReason}. Likely a model or prompt issue.`,
      });
    }
  }

  // Max turns reached. The run promised the caller `maxTurns` turns of tool
  // access and delivered them. Rather than ending with a generic "exhausted"
  // verdict, we inject one final SYSTEM-REMINDER and let the agent call
  // report_result with a best-effort summary of where it got stuck and why.
  // This extra LLM call does not count against `usage.turns` — the caller
  // contract is preserved; the grace turn is overhead.
  logger.logEvent("max_turns_reminder", { maxTurns });

  const reminderText =
    `<SYSTEM-REMINDER>\n` +
    `You have used all ${maxTurns} of your available turns without calling report_result. ` +
    `No more application tools are available — only report_result can be called now. ` +
    `This is your final response.\n` +
    `\n` +
    `Call report_result to end the run with an actionable summary:\n` +
    `  - Set status to "investigate" (the run did not complete).\n` +
    `  - In summary, describe what you did and what you observed.\n` +
    `  - In reasoning, explain where you got stuck and why you couldn't finish ` +
    `within the turn budget.\n` +
    `  - Include concrete recommendations as observations (kind: "suggestion") ` +
    `for whoever picks this up next.\n` +
    `</SYSTEM-REMINDER>`;

  const graceTurn = turns + 1;
  logger.logUserMessage(graceTurn, reminderText);
  messages.push(client.userMessage(reminderText));

  logger.logLlmRequest(graceTurn, messages.length);
  const graceResponse = await client.chat(messages, [REPORT_TOOL], systemPrompt);
  totalInputTokens += graceResponse.usage.inputTokens;
  totalOutputTokens += graceResponse.usage.outputTokens;
  totalCacheCreation += graceResponse.usage.cacheCreationInputTokens ?? 0;
  totalCacheRead += graceResponse.usage.cacheReadInputTokens ?? 0;

  const graceThinking: Array<{ text: string; signature?: string }> = [];
  const graceRaw = graceResponse.rawAssistantMessage as { content?: Array<Record<string, unknown>> } | undefined;
  if (graceRaw && Array.isArray(graceRaw.content)) {
    for (const block of graceRaw.content) {
      if (block && block.type === "thinking" && typeof block.thinking === "string") {
        graceThinking.push({
          text: block.thinking as string,
          signature: typeof block.signature === "string" ? block.signature : undefined,
        });
      }
    }
  }

  logger.logLlmResponse({
    turn: graceTurn,
    stopReason: graceResponse.stopReason,
    text: graceResponse.text,
    thinking: graceThinking,
    toolCalls: graceResponse.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
    usage: {
      inputTokens: graceResponse.usage.inputTokens,
      outputTokens: graceResponse.usage.outputTokens,
      cacheCreationInputTokens: graceResponse.usage.cacheCreationInputTokens,
      cacheReadInputTokens: graceResponse.usage.cacheReadInputTokens,
    },
    rawAssistantMessage: graceResponse.rawAssistantMessage,
  });

  const graceReport = graceResponse.toolCalls.find((tc) => tc.name === "report_result");
  if (graceReport) {
    const parsed = parseReportResult(graceReport.arguments);
    if (parsed.ok) {
      return buildResult({
        status: parsed.value.status,
        summary: parsed.value.summary,
        reasoning: parsed.value.reasoning,
        observations: parsed.value.observations,
      });
    }
    // Grace turn produced report_result but it was malformed. Log and fall
    // through to the generic result — same posture as the in-loop malformed
    // path, minus the raw-args dump (already captured in logLlmResponse).
    logger.logEvent("max_turns_grace_malformed_report", { reason: parsed.reason });
  }

  return buildResult({
    status: "investigate",
    summary: "Agent reached maximum turn limit without reporting a result",
    reasoning: `Exhausted ${maxTurns} turns; grace-turn reminder did not yield a valid report_result.`,
  });
}
