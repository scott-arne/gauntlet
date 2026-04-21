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
  const systemPrompt = buildSystemPrompt(card, options.contextTree);
  const tools = [...adapter.toolDefinitions(), REPORT_TOOL];

  let initialMessage = "Begin testing. Use the available tools to interact with the application.";
  if (target) {
    initialMessage += `\n\nThe application is available at: ${target}`;
  }

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
  }): VetResult => ({
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
    },
    duration_ms: Date.now() - startTime,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheCreationInputTokens: totalCacheCreation > 0 ? totalCacheCreation : undefined,
      cacheReadInputTokens: totalCacheRead > 0 ? totalCacheRead : undefined,
      turns,
    },
  });

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.chat(messages, tools, systemPrompt);

    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;
    totalCacheCreation += response.usage.cacheCreationInputTokens ?? 0;
    totalCacheRead += response.usage.cacheReadInputTokens ?? 0;
    turns++;

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
        logger.logAction("report_with_other_tools_dropped", {
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
      logger.logAction("stopped_max_tokens", {
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
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            adapter.executeTool(tc.name, tc.arguments, logger),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`Tool "${tc.name}" timed out after ${toolTimeout}ms`)),
                toolTimeout,
              );
            }),
          ]);
          results.push(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ text: `Error: ${message}` });
        } finally {
          // Clear the timeout on the winning path so we don't leak a live
          // timer for every tool call — at 30s each over a 50-turn run
          // this adds up to dozens of pinned handles if the tool resolves
          // first.
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
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
      logger.logAction("empty_response", {
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

  // Max turns reached
  return buildResult({
    status: "investigate",
    summary: "Agent reached maximum turn limit without reporting a result",
    reasoning: `Exhausted ${maxTurns} turns`,
  });
}
