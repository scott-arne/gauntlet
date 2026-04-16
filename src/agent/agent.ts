import type { LLMClient, ToolDefinition, ToolResult } from "../models/provider";
import type { Adapter } from "../adapters/adapter";
import type { EvidenceLogger } from "../evidence/logger";
import type { StoryCard } from "../format/story-card";
import type { VetResult, VetStatus, Observation } from "../types";
import { RESULT_SCHEMA_VERSION } from "../types";
import { buildSystemPrompt } from "./prompts";

const MAX_TURNS = 50;
const DEFAULT_TOOL_TIMEOUT_MS = 30000;

export interface AgentOptions {
  toolTimeoutMs?: number;
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
   * is self-describing on disk. Defaults to "" when the caller does not
   * provide one (e.g. ad-hoc test fixtures); production callers always
   * supply it via `makeRunId(card.id)`.
   */
  runId?: string;
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
  target?: string,
  options?: AgentOptions
): Promise<VetResult> {
  const startTime = Date.now();
  const runId = options?.runId ?? "";
  const systemPrompt = buildSystemPrompt(card, options?.contextTree);
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
  let turns = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.chat(messages, tools, systemPrompt);

    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;
    turns++;

    // Check for report_result
    const report = response.toolCalls.find(
      (tc) => tc.name === "report_result"
    );
    if (report) {
      const args = report.arguments;
      return {
        schemaVersion: RESULT_SCHEMA_VERSION,
        runId,
        scenario: card.id,
        status: args.status as VetStatus,
        summary: args.summary as string,
        reasoning: args.reasoning as string,
        observations: (args.observations as Observation[]) || [],
        evidence: {
          screenshots: logger.screenshots,
          log: logger.logPath,
        },
        duration_ms: Date.now() - startTime,
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          turns,
        },
      };
    }

    // Process tool calls
    if (response.toolCalls.length > 0) {
      messages.push(response.rawAssistantMessage);

      const toolTimeout = options?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      const results: ToolResult[] = [];
      for (const tc of response.toolCalls) {
        try {
          const result = await Promise.race([
            adapter.executeTool(tc.name, tc.arguments, logger),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Tool "${tc.name}" timed out after ${toolTimeout}ms`)), toolTimeout)
            ),
          ]);
          results.push(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ text: `Error: ${message}` });
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
    }
  }

  // Max turns reached
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    runId,
    scenario: card.id,
    status: "investigate",
    summary: "Agent reached maximum turn limit without reporting a result",
    reasoning: `Exhausted ${MAX_TURNS} turns`,
    observations: [],
    evidence: {
      screenshots: logger.screenshots,
      log: logger.logPath,
    },
    duration_ms: Date.now() - startTime,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      turns,
    },
  };
}
