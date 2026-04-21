import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { EvidenceLogger } from "../../src/evidence/logger";
import { runAgent } from "../../src/agent/agent";
import type { LLMClient, AgentResponse, ToolCall, ToolResult } from "../../src/models/provider";
import type { Adapter } from "../../src/adapters/adapter";
import type { StoryCard } from "../../src/format/story-card";

function readLog(outDir: string): Array<Record<string, unknown>> {
  return readFileSync(join(outDir, "run.jsonl"), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function makeCard(): StoryCard {
  return {
    id: "card-001",
    title: "t",
    status: "ready",
    tags: [],
    description: "d",
    acceptanceCriteria: [],
    raw: "",
  } as unknown as StoryCard;
}

function makeAdapter(): Adapter {
  return {
    name: "test",
    toolDefinitions: () => [],
    async executeTool(_n, _a, _l): Promise<ToolResult> { return { text: "ok" }; },
    async start() {}, async close() {},
  } as unknown as Adapter;
}

function makeClient(responses: AgentResponse[]): LLMClient {
  let i = 0;
  return {
    async chat() { return responses[i++]; },
    userMessage(content: string) { return { role: "user", content }; },
    toolResultMessages(calls: ToolCall[], results: ToolResult[]) {
      return [{ role: "user", content: calls.map((c, j) => ({ tool_use_id: c.id, text: results[j].text })) }];
    },
  };
}

describe("agent event stream", () => {
  let outDir: string;
  let logger: EvidenceLogger;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "gauntlet-agent-"));
    logger = new EvidenceLogger(outDir);
  });
  afterEach(() => rmSync(outDir, { recursive: true, force: true }));

  test("emits run_start, system_prompt, user_message as first three rows", async () => {
    const client = makeClient([{
      text: "", toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "s", reasoning: "r" } }],
      stopReason: "tool_use", rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 10, outputTokens: 5 },
    }]);
    await runAgent(makeCard(), makeAdapter(), client, logger, "http://x", {
      runId: "card-001_20260421T000000Z_aaaa",
    });

    const rows = readLog(outDir);
    expect(rows[0].type).toBe("run_start");
    expect(rows[0].runId).toBe("card-001_20260421T000000Z_aaaa");
    expect(rows[0].cardId).toBe("card-001");
    expect(rows[1].type).toBe("system_prompt");
    expect(typeof rows[1].content).toBe("string");
    expect(rows[2].type).toBe("user_message");
    expect(rows[2].turn).toBe(0);
    expect((rows[2].content as string)).toContain("http://x");
  });
});
