import { describe, test, expect } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { CLIAdapter } from "../../src/adapters/cli/adapter";
import { EvidenceLogger } from "../../src/evidence/logger";
import { parseStoryCard } from "../../src/format/story-card";
import type {
  LLMClient,
  ToolCall,
  ToolResult,
  AgentResponse,
} from "../../src/models/provider";
import { join } from "path";
import { readFileSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";

const STORIES_DIR = join(import.meta.dir, "../fixtures/stories");

function loadStory(filename: string) {
  return parseStoryCard(readFileSync(join(STORIES_DIR, filename), "utf-8"));
}

function step(
  id: string,
  name: string,
  args: Record<string, unknown>
): AgentResponse {
  return {
    text: `Executing ${name}`,
    toolCalls: [{ id, name, arguments: args }],
    stopReason: "tool_use",
    rawAssistantMessage: { role: "assistant", content: `step ${id}` },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function report(
  status: string,
  summary: string,
  reasoning: string
): AgentResponse {
  return {
    text: summary,
    toolCalls: [
      {
        id: "call_report",
        name: "report_result",
        arguments: { status, summary, reasoning },
      },
    ],
    stopReason: "tool_use",
    rawAssistantMessage: { role: "assistant", content: "reporting" },
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function makeScriptedClient(steps: AgentResponse[]): LLMClient {
  let callIndex = 0;

  return {
    async chat() {
      await Bun.sleep(200);
      const response = steps[callIndex++];
      if (!response) throw new Error("No more scripted responses");
      return response;
    },
    userMessage(content: string) {
      return { role: "user", content };
    },
    toolResultMessages(calls: ToolCall[], results: ToolResult[]) {
      return calls.map((call, i) => ({
        role: "tool_result",
        tool_call_id: call.id,
        content: results[i].text,
      }));
    },
  };
}

describe("CLI adapter e2e — bc calculator", () => {
  test("pass: bc performs arithmetic", async () => {
    const card = loadStory("bc-arithmetic-pass.md");
    const adapter = new CLIAdapter();
    const logDir = mkdtempSync(join(tmpdir(), "vet-bc-arith-"));
    const logger = new EvidenceLogger(logDir);

    const steps: AgentResponse[] = [
      step("call_1", "type", { text: "2+3\n" }),
      step("call_2", "read_output", {}),
      step("call_3", "type", { text: "6*7\n" }),
      step("call_4", "read_output", {}),
      report("pass", "bc computes arithmetic correctly", "2+3=5 and 6*7=42"),
    ];

    const client = makeScriptedClient(steps);

    try {
      await adapter.start("bc -q");
      const result = await runAgent(card, adapter, client, logger);

      expect(result.status).toBe("pass");
      expect(result.scenario).toBe("bc-arithmetic-pass");
    } finally {
      await adapter.close();
    }
  });

  test("fail: bc has no help command", async () => {
    const card = loadStory("bc-help-fail.md");
    const adapter = new CLIAdapter();
    const logDir = mkdtempSync(join(tmpdir(), "vet-bc-help-"));
    const logger = new EvidenceLogger(logDir);

    const steps: AgentResponse[] = [
      step("call_1", "type", { text: "help\n" }),
      step("call_2", "read_output", {}),
      report(
        "fail",
        "bc has no help command",
        "Typing help produced an error, not a help menu"
      ),
    ];

    const client = makeScriptedClient(steps);

    try {
      await adapter.start("bc -q");
      const result = await runAgent(card, adapter, client, logger);

      expect(result.status).toBe("fail");
      expect(result.scenario).toBe("bc-help-fail");
    } finally {
      await adapter.close();
    }
  });
});
