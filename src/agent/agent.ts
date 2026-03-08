import type { LLMClient, ToolDefinition } from "../models/provider";
import type { Adapter } from "../adapters/adapter";
import type { EvidenceLogger } from "../evidence/logger";
import type { StoryCard } from "../format/story-card";
import type { VetResult, VetStatus, Observation } from "../types";
import { buildSystemPrompt } from "./prompts";

const MAX_TURNS = 50;

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
  target?: string
): Promise<VetResult> {
  const startTime = Date.now();
  const systemPrompt = buildSystemPrompt(card);
  const tools = [...adapter.toolDefinitions(), REPORT_TOOL];

  let initialMessage = "Begin testing. Use the available tools to interact with the application.";
  if (target) {
    initialMessage += `\n\nThe application is available at: ${target}`;
  }

  const messages: unknown[] = [
    client.userMessage(initialMessage),
  ];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.chat(messages, tools, systemPrompt);

    // Check for report_result
    const report = response.toolCalls.find(
      (tc) => tc.name === "report_result"
    );
    if (report) {
      const args = report.arguments;
      return {
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
      };
    }

    // Process tool calls
    if (response.toolCalls.length > 0) {
      messages.push(response.rawAssistantMessage);

      const results: string[] = [];
      for (const tc of response.toolCalls) {
        try {
          const result = await adapter.executeTool(tc.name, tc.arguments, logger);
          results.push(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push(`Error: ${message}`);
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
  };
}
