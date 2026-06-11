import type { LLMClient, ToolDefinition, ToolResult } from "../models/provider";
import { pushAssistantTurn, textResult } from "../models/provider";
import type { Adapter } from "../adapters/adapter";
import type { EvidenceLogger } from "../evidence/logger";
import type { StoryCard } from "../format/story-card";
import type { VetResult, VetStatus } from "../types";
import { RESULT_SCHEMA_VERSION } from "../types";
import type { RunId } from "../util/brands";
import { buildSystemPrompt } from "./prompts";
import { buildInitialUserMessage } from "./initial-message";
import { parseReportCriteria, parseReportResult, salvageReportResult } from "./validators";
import {
  buildReflectionReminder,
  renderTrace,
  type ReflectableToolCall,
} from "./reflection";

// How many mutating tool calls to retain for the reflection trace. Set
// to roughly twice MAX_TRACE_ENTRIES (8) so the rendered window has
// recent context even when the agent does several mutations per turn.
const RECENT_MUTATING_CAP = 16;

const DEFAULT_TOOL_TIMEOUT_MS = 30000;

// How many times a malformed report_result is fed back to the model for
// correction before we stop re-asking and fall back to salvage (PRI-2140).
// LLM-emitted enums occasionally truncate ("ug" for "bug"); the model can
// almost always fix its own call when shown the validation error.
const MAX_REPORT_VALIDATION_RETRIES = 2;

const MAX_TOKENS_NUDGE =
  "<SYSTEM-REMINDER>\n" +
  "Your previous response was cut off by the output token limit and has been discarded. " +
  "Do not repeat it. Respond concisely — prefer tool calls over long prose. " +
  "If you have reached a verdict, call report_result now with a brief summary and reasoning.\n" +
  "</SYSTEM-REMINDER>";

const EMPTY_RESPONSE_NUDGE =
  "<SYSTEM-REMINDER>\n" +
  "You returned no tool calls and no text. Either:\n" +
  "  - Call report_result with a status to end the run, or\n" +
  "  - Take another action (use the tools).\n" +
  "If you intend to wait, prefer wake_on_idle_log over leaving an empty turn.\n" +
  "</SYSTEM-REMINDER>";

/**
 * The empty-end_turn safety net (PRI-1864) needs to push the empty
 * assistant turn into the messages array so the next chat() call has
 * valid role alternation. But providers reject assistant messages with
 * zero-content arrays. Substitute a stub text block. Provider-shape-
 * aware: Anthropic's raw is `{role, content[]}`, OpenAI Responses is
 * an array of output items.
 */
export function synthesizeFilledAssistantMessage(raw: unknown): unknown {
  if (
    raw &&
    typeof raw === "object" &&
    "content" in raw &&
    Array.isArray((raw as { content: unknown }).content) &&
    ((raw as { content: unknown[] }).content as unknown[]).length === 0
  ) {
    return {
      ...(raw as object),
      content: [{ type: "text", text: "(empty turn)" }],
    };
  }
  if (Array.isArray(raw) && raw.length === 0) {
    // Valid Responses *input* item: a `message` item with string content
    // (same shape openai.ts's userMessage emits). A bare assistant item
    // with `output_text` content is not a valid input shape.
    return [{ type: "message", role: "assistant", content: "(empty turn)" }];
  }
  return raw;
}

/**
 * Build the assistant turn that stands in for a max_tokens-truncated
 * response (PRI-2160). The truncated content is NOT replayed: a partial
 * thinking block can't be round-tripped (its signature never arrived)
 * and partial tool calls must not be executed, so the whole turn is
 * replaced with a short text stub. Provider-shape-aware like
 * `synthesizeFilledAssistantMessage` above: Anthropic's raw is
 * `{role, content[]}`, OpenAI Responses is an array of output items.
 */
export function synthesizeTruncatedAssistantStub(raw: unknown): unknown {
  const stubText = "(response truncated by the output token limit; discarded)";
  if (Array.isArray(raw)) {
    // Valid Responses *input* item — see synthesizeFilledAssistantMessage.
    return [{ type: "message", role: "assistant", content: stubText }];
  }
  return { role: "assistant", content: [{ type: "text", text: stubText }] };
}

export interface AgentOptions {
  toolTimeoutMs?: number;
  /**
   * Wall-clock budget for the agent loop in milliseconds. The loop exits
   * when `Date.now() >= startTime + budgetMs`. Required: the orchestrator
   * threads this through from config; tests must construct deliberately.
   */
  budgetMs: number;

  /**
   * Number of LLM turns between mid-loop reflection checkpoints. Each
   * checkpoint appends a `<SYSTEM-REMINDER>` block (recent mutating-call
   * trace + give-up framing) to the user message carrying tool results.
   * 0 disables. See `docs/reflection-checkpoints-spec.md`.
   */
  reflectionInterval: number;
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
  runId: RunId;
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
  /** Optional Project augmentation block, threaded into the system prompt
   * between the Adapter and Context blocks. Resolved upstream by
   * `resolveProjectPrompt` in `src/runs/orchestrator.ts`. */
  projectPrompt?: string;
  /**
   * Optional cancellation signal. When aborted, the agent loop **returns**
   * a synthetic `errored` VetResult at its next abort check (between
   * turns, or between adjacent tool calls within a turn). It does NOT
   * throw — the orchestrator's success path is the one that writes
   * `result.json`; throwing would skip that and force the §3 stub
   * fallback for every aborted run. See PRI-1507 spec §1.
   */
  abortSignal?: AbortSignal;
}

// Property order matters here. Models emit object properties in schema
// order, and we want `observations` to appear *before* `reasoning` so the
// array shape is established before the model is deep in a long quoted
// reasoning blob. (See PRI-1528: observations was being string-wrapped
// after the model accumulated escape-heavy reasoning output.)
export const REPORT_TOOL: ToolDefinition = {
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
      observations: {
        type: "array",
        description:
          "Array of structured observations. Pass as an array literal, not a JSON string. Use an empty array if you have nothing to report. Example: [{\"kind\": \"bug\", \"description\": \"login button does nothing on second click\"}]",
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
      criteria: {
        type: "array",
        description:
          "Per-criterion verdicts. Required when the scenario lists acceptance criteria: one entry per criterion, in the order listed; omit for scenarios without acceptance criteria. Pass as an array literal, not a JSON string.",
        items: {
          type: "object",
          properties: {
            criterion: {
              type: "string",
              description: "Short restatement of the criterion",
            },
            verdict: {
              type: "string",
              enum: ["pass", "fail", "unclear"],
            },
            evidence: {
              type: "string",
              description:
                "What you observed that supports this verdict: a short quote plus its source (screen text, file content and path, log line, or command output). For a claim that something never happened, cite the search you ran and what it returned.",
            },
          },
          required: ["criterion", "verdict", "evidence"],
        },
      },
      reasoning: {
        type: "string",
        description: "Why you reached this verdict",
      },
    },
    required: ["status", "summary", "observations", "reasoning"],
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
  const { runId, budgetMs } = options;
  const systemPrompt = buildSystemPrompt(
    card,
    options.contextTree,
    adapter.name,
    options.projectPrompt,
  );
  const tools = [...adapter.toolDefinitions(), REPORT_TOOL];

  // Per-tool execute-timeout override (PRI-1864). Tools that legitimately
  // block for minutes (wake_on_idle_log) declare maxExecutionMs so the
  // executeTool race doesn't kill them before their internal clamp.
  const toolTimeoutOverrides = new Map<string, number>();
  for (const td of tools) {
    if (typeof td.maxExecutionMs === "number" && td.maxExecutionMs > 0) {
      toolTimeoutOverrides.set(td.name, td.maxExecutionMs);
    }
  }

  logger.logRunStart({
    runId,
    cardId: card.id,
    target,
    provider: options.provider ?? "unknown",
    model: options.model ?? "unknown",
    adapter: adapter.name ?? "unknown",
    budgetMs,
    reflectionInterval: options.reflectionInterval,
    toolTimeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    contextTreeBytes: options.contextTree ? Buffer.byteLength(options.contextTree, "utf8") : 0,
    outDir: options.outDir,
    viewport: options.viewport,
  });
  logger.logSystemPrompt(systemPrompt);
  logger.logToolDefinitions(tools);

  const initialMessage = buildInitialUserMessage(adapter, target);

  logger.logUserMessage(0, initialMessage);

  const messages: unknown[] = [
    client.userMessage(initialMessage),
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let turns = 0;
  let emptyResponseNudged = false;
  let reportValidationRetries = 0;
  let maxTokensNudged = false;
  const deadline = startTime + budgetMs;
  // Bounded buffer of state-changing tool calls, classified by the
  // adapter via isMutatingTool. Drives the reflection-checkpoint trace.
  const recentMutatingCalls: ReflectableToolCall[] = [];
  const reflectionInterval = options.reflectionInterval ?? 0;

  /**
   * Build a terminal VetResult with shared scaffolding (schema, evidence,
   * duration, usage). Used by every early-exit: report_result, max_tokens
   * truncation, empty response, and the max-turns fallthrough.
   *
   * Overloaded so the discriminated union is compiler-enforced: the
   * "errored" variant requires an `error` object; other statuses must
   * omit it.
   */
  function buildResult(partial: {
    status: "pass" | "fail" | "investigate";
    summary: string;
    reasoning: string;
    observations?: VetResult["observations"];
    criteria?: VetResult["criteria"];
  }): VetResult;
  function buildResult(partial: {
    status: "errored";
    summary: string;
    reasoning: string;
    observations?: VetResult["observations"];
    criteria?: VetResult["criteria"];
    error: { type: string; message: string };
  }): VetResult;
  function buildResult(partial: {
    status: VetStatus;
    summary: string;
    reasoning: string;
    observations?: VetResult["observations"];
    criteria?: VetResult["criteria"];
    error?: { type: string; message: string };
  }): VetResult {
    const base = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      runId,
      scenario: card.id,
      summary: partial.summary,
      reasoning: partial.reasoning,
      observations: partial.observations ?? [],
      criteria: partial.criteria,
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
    const result: VetResult = partial.status === "errored"
      ? { ...base, status: "errored", error: partial.error! }
      : { ...base, status: partial.status };
    logger.logRunEnd({
      status: result.status,
      summary: result.summary,
      reasoning: result.reasoning,
      observationCount: result.observations.length,
      observations: result.observations,
      criteria: result.criteria,
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
  }

  const isAborted = (): boolean => options.abortSignal?.aborted === true;
  const abortedResult = (): VetResult => {
    logger.logShutdownSignaled({
      turn: turns,
      reason: String(options.abortSignal?.reason ?? "unknown"),
    });
    return buildResult({
      status: "errored",
      summary: "Run interrupted by shutdown signal",
      reasoning: `Daemon shutdown signal received at turn ${turns}; agent loop terminated before completion.`,
      error: { type: "shutdown_interrupted", message: "interrupted by shutdown signal" },
    });
  };

  while (Date.now() < deadline) {
    if (isAborted()) return abortedResult();
    logger.logLlmRequest(turns + 1, messages.length);
    const response = await client.chat(messages, tools, systemPrompt, { runId });

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
      reasoning: response.reasoning,
      toolCalls: response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
      usage: {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheCreationInputTokens: response.usage.cacheCreationInputTokens,
        cacheReadInputTokens: response.usage.cacheReadInputTokens,
      },
      rawAssistantMessage: response.rawAssistantMessage,
    });

    // Emit the obol cost-sidecar row: the provider's raw usage object,
    // verbatim. obol normalizes per-provider at read time (PRI-2125). Guarded
    // so adapters/tests that don't surface rawUsage simply emit nothing.
    if (response.rawUsage !== undefined) {
      logger.logUsageRow(response.rawUsage);
    }

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
      let validationFailure: string;
      if (!parsed.ok) {
        validationFailure = parsed.reason;
      } else {
        // Per-criterion citation validation (PRI-2160): when the card
        // has acceptance criteria, the report must carry one cited
        // verdict per criterion. Checked only after the base shape
        // parses — its failure reason feeds the same re-ask path.
        const criteriaParsed = parseReportCriteria(
          (report.arguments as Record<string, unknown>).criteria,
          card.acceptanceCriteria,
        );
        if (criteriaParsed.ok) {
          return buildResult({
            status: parsed.value.status,
            summary: parsed.value.summary,
            reasoning: parsed.value.reasoning,
            observations: parsed.value.observations,
            criteria: criteriaParsed.value.length > 0 ? criteriaParsed.value : undefined,
          });
        }
        validationFailure = criteriaParsed.reason;
      }

      {
        // A malformed report_result must not silently discard a
        // substantive verdict (PRI-2140). First feed the validation
        // error back to the model for a corrected call (bounded);
        // when re-asks are exhausted, salvage the valid core verdict
        // and drop only the malformed observations.
        if (reportValidationRetries < MAX_REPORT_VALIDATION_RETRIES) {
          reportValidationRetries++;
          logger.logEvent("report_result_invalid_retry", {
            turn: turns,
            attempt: reportValidationRetries,
            reason: validationFailure,
          });
          pushAssistantTurn(messages, response.rawAssistantMessage);
          const retryResults: ToolResult[] = response.toolCalls.map((tc) =>
            tc.id === report.id
              ? textResult(
                  `Error: report_result rejected: ${validationFailure}. ` +
                  `Call report_result again with corrected arguments. ` +
                  `Keep your verdict and findings the same; fix only the invalid field.`,
                )
              : textResult(
                  "Error: not executed — report_result was called in the same turn.",
                ),
          );
          messages.push(...client.toolResultMessages(response.toolCalls, retryResults));
          continue;
        }

        const salvaged = salvageReportResult(report.arguments);
        if (salvaged.ok) {
          logger.logEvent("report_result_salvaged", {
            turn: turns,
            reason: validationFailure,
            dropped: salvaged.value.dropped,
          });
          return buildResult({
            status: salvaged.value.status,
            summary: salvaged.value.summary,
            reasoning: salvaged.value.reasoning,
            observations: salvaged.value.observations,
          });
        }

        // Raw args in reasoning so a human post-mortem can reconstruct
        // what the model tried to report.
        let rawArgs = "<unserializable>";
        try { rawArgs = JSON.stringify(report.arguments); } catch { /* ignore */ }
        return buildResult({
          status: "investigate",
          summary: `LLM returned malformed report_result: ${validationFailure}`,
          reasoning: `Validator rejected report_result args. raw=${rawArgs}`,
        });
      }
    }

    // Truncated output. A run died this way on the verge of its verdict
    // (PRI-2160, run b35d: max_tokens mid-thinking on turn 36, subject
    // fully successful) — so the first truncation gets one recovery
    // turn: discard the partial output, inject a concision nudge, and
    // let the model try again. Bounded at one per run; a second
    // truncation ends with investigate so the human (or an escalating
    // scheduler) sees the problem.
    if (response.stopReason === "max_tokens") {
      logger.logEvent("stopped_max_tokens", {
        turn: turns,
        hasText: Boolean(response.text),
        toolCallCount: response.toolCalls.length,
        recovery: !maxTokensNudged,
      });
      if (maxTokensNudged) {
        return buildResult({
          status: "investigate",
          summary: "LLM response truncated by max_tokens before reporting",
          reasoning: `Stopped with max_tokens on turn ${turns}, after an earlier truncation had already used the recovery turn. Increase max_tokens or shorten the scenario.`,
        });
      }
      maxTokensNudged = true;
      pushAssistantTurn(messages, synthesizeTruncatedAssistantStub(response.rawAssistantMessage));
      logger.logUserMessage(turns, MAX_TOKENS_NUDGE);
      messages.push(client.userMessage(MAX_TOKENS_NUDGE));
      continue;
    }

    // Any non-empty response resets the empty-nudge tracker.
    if (response.toolCalls.length > 0 || response.text) {
      emptyResponseNudged = false;
    }

    // Process tool calls
    if (response.toolCalls.length > 0) {
      pushAssistantTurn(messages, response.rawAssistantMessage);

      const baseToolTimeout = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      const results: ToolResult[] = [];
      for (const tc of response.toolCalls) {
        if (isAborted()) return abortedResult();
        logger.logToolCall({ turn: turns, toolUseId: tc.id, name: tc.name, arguments: tc.arguments });
        const started = Date.now();
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let result: ToolResult;
        let errored = false;
        const toolTimeout = toolTimeoutOverrides.get(tc.name) ?? baseToolTimeout;
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
          result = textResult(`Error: ${message}`);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        results.push(result);
        logger.logToolResult({
          turn: turns,
          toolUseId: tc.id,
          name: tc.name,
          durationMs: Date.now() - started,
          text: result.text,
          transcriptText: result.transcriptText,
          image: result.kind === "image" ? result.imagePath : undefined,
          mediaType: result.kind === "image" ? result.image.mediaType : undefined,
          artifact: result.kind === "artifact" ? result.artifactPath : undefined,
          capturePath: result.kind === "capture" ? result.capturePath : undefined,
          error: errored,
        });
      }

      // Reflection checkpoint bookkeeping. Skipped entirely when
      // reflection is disabled so older callers (and adapter mocks) that
      // don't implement isMutatingTool aren't dragged in. Informational
      // tools (screenshot, extract, read, wait_for, ...) are excluded
      // per the adapter's classification — see
      // docs/reflection-checkpoints-spec.md.
      let extraUserText: string | undefined;
      if (reflectionInterval > 0) {
        for (const tc of response.toolCalls) {
          if (adapter.isMutatingTool(tc.name)) {
            recentMutatingCalls.push({ name: tc.name, arguments: tc.arguments });
            if (recentMutatingCalls.length > RECENT_MUTATING_CAP) {
              recentMutatingCalls.shift();
            }
          }
        }
        if (turns % reflectionInterval === 0) {
          // Identical reminder text every firing; the trace varies and
          // does the persuading (see spec §"Reminder text").
          const traceText = renderTrace(recentMutatingCalls);
          extraUserText = buildReflectionReminder(traceText);
          logger.logEvent("reflection_checkpoint", {
            turn: turns,
            ordinal: Math.floor(turns / reflectionInterval),
            traceLength: recentMutatingCalls.length,
          });
          logger.logUserMessage(turns, extraUserText);
        }
      }

      messages.push(...client.toolResultMessages(response.toolCalls, results, extraUserText));
    } else if (response.text) {
      pushAssistantTurn(messages, response.rawAssistantMessage);
      messages.push(
        client.userMessage(
          "Use the tools to interact with the application, or call report_result when done."
        )
      );
    } else {
      // Empty response. Try a nudge once (PRI-1864 — long-haul polling
      // loops can self-prime Sonnet into emitting nothing). If we
      // already nudged on the previous empty turn and still got empty,
      // give up cleanly.
      if (emptyResponseNudged) {
        logger.logEvent("empty_response_after_nudge", {
          turn: turns,
          stopReason: response.stopReason,
        });
        return buildResult({
          status: "investigate",
          summary: "LLM returned empty content twice, even after a nudge",
          reasoning: `Empty response on turn ${turns} and again after nudge. Likely model self-priming on an empty-prefix pattern.`,
        });
      }
      emptyResponseNudged = true;
      logger.logEvent("empty_response_nudge", {
        turn: turns,
        stopReason: response.stopReason,
      });
      // Push a stub-filled version of the empty assistant turn so the
      // next chat() request has valid role alternation, then add the
      // nudge as a user message and let the while-loop iterate.
      pushAssistantTurn(messages, synthesizeFilledAssistantMessage(response.rawAssistantMessage));
      logger.logUserMessage(turns, EMPTY_RESPONSE_NUDGE);
      messages.push(client.userMessage(EMPTY_RESPONSE_NUDGE));
    }
  }

  // Time budget exhausted. The run promised `budgetMs` wall-clock of tool
  // access and delivered it. Rather than ending with a generic "exhausted"
  // verdict, we inject one final SYSTEM-REMINDER and let the agent call
  // report_result with a best-effort summary of where it got stuck and why.
  // This extra LLM call does not count against `usage.turns` — the caller
  // contract is preserved; the grace turn is overhead.
  const nowAtGrace = Date.now();
  const elapsedMsAtGrace = nowAtGrace - startTime;
  logger.logEvent("deadline_reminder", { budgetMs, elapsedMs: elapsedMsAtGrace });

  const elapsedSec = Math.round(elapsedMsAtGrace / 1000);
  const reminderText =
    `<SYSTEM-REMINDER>\n` +
    `You have used your time budget (${elapsedSec}s of ${Math.round(budgetMs/1000)}s) without calling report_result. ` +
    `No more application tools are available — only report_result can be called now. ` +
    `This is your final response.\n` +
    `\n` +
    `Call report_result to end the run with an actionable summary:\n` +
    `  - Set status to "investigate" (the run did not complete).\n` +
    `  - In summary, describe what you did and what you observed.\n` +
    `  - In reasoning, explain where you got stuck and why you couldn't finish ` +
    `within the time budget.\n` +
    `  - Include concrete recommendations as observations (kind: "suggestion") ` +
    `for whoever picks this up next.\n` +
    `</SYSTEM-REMINDER>`;

  const graceTurn = turns + 1;
  logger.logUserMessage(graceTurn, reminderText);
  messages.push(client.userMessage(reminderText));

  logger.logLlmRequest(graceTurn, messages.length);
  const graceResponse = await client.chat(messages, [REPORT_TOOL], systemPrompt, { runId });
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

  if (graceResponse.rawUsage !== undefined) {
    logger.logUsageRow(graceResponse.rawUsage);
  }

  const graceReport = graceResponse.toolCalls.find((tc) => tc.name === "report_result");
  if (graceReport) {
    const parsed = parseReportResult(graceReport.arguments);
    if (parsed.ok) {
      // The grace turn has no re-ask budget, so per-criterion citations
      // (PRI-2160) are accepted when valid but never fatal: an invalid
      // or missing criteria array is dropped with an event, not
      // re-asked — the verdict survives.
      const criteriaParsed = parseReportCriteria(
        (graceReport.arguments as Record<string, unknown>).criteria,
        card.acceptanceCriteria,
      );
      if (!criteriaParsed.ok) {
        logger.logEvent("report_criteria_dropped", {
          turn: graceTurn,
          reason: criteriaParsed.reason,
        });
      }
      return buildResult({
        status: parsed.value.status,
        summary: parsed.value.summary,
        reasoning: parsed.value.reasoning,
        observations: parsed.value.observations,
        criteria:
          criteriaParsed.ok && criteriaParsed.value.length > 0
            ? criteriaParsed.value
            : undefined,
      });
    }
    // Grace turn produced report_result but it was malformed. There is no
    // re-ask budget left, so try salvage directly (PRI-2140): a valid
    // core verdict survives; only malformed observations are dropped.
    const salvaged = salvageReportResult(graceReport.arguments);
    if (salvaged.ok) {
      logger.logEvent("report_result_salvaged", {
        turn: graceTurn,
        reason: parsed.reason,
        dropped: salvaged.value.dropped,
      });
      return buildResult({
        status: salvaged.value.status,
        summary: salvaged.value.summary,
        reasoning: salvaged.value.reasoning,
        observations: salvaged.value.observations,
      });
    }
    // Log and fall through to the generic result — same posture as the
    // in-loop malformed path, minus the raw-args dump (already captured
    // in logLlmResponse).
    logger.logEvent("deadline_grace_malformed_report", { reason: parsed.reason });
  }

  return buildResult({
    status: "investigate",
    summary: "Agent reached time budget without reporting a result",
    reasoning: `Exceeded ${Math.round(budgetMs/1000)}s budget; grace-turn reminder did not yield a valid report_result.`,
  });
}
