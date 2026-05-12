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
    describeTarget: (target: string) => `The application is available at: ${target}`,
    defaultViewport: () => null,
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

  test("emits llm_request + llm_response per turn with usage and rawAssistantMessage", async () => {
    const rawAssistant = { role: "assistant", content: [{ type: "text", text: "hi" }] };
    const client = makeClient([{
      text: "hi",
      toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "s", reasoning: "r" } }],
      stopReason: "tool_use",
      rawAssistantMessage: rawAssistant,
      usage: { inputTokens: 100, outputTokens: 20, cacheCreationInputTokens: 50, cacheReadInputTokens: 30 },
    }]);

    await runAgent(makeCard(), makeAdapter(), client, logger, undefined, {
      runId: "card-001_20260421T000000Z_aaaa",
      budgetMs: 600_000,
      maxStuckRetries: 5,
    });

    const rows = readLog(outDir);
    const req = rows.find((r) => r.type === "llm_request");
    const res = rows.find((r) => r.type === "llm_response");
    expect(req).toBeDefined();
    expect(req!.turn).toBe(1);
    expect(req!.messageCount).toBe(1);
    expect(res).toBeDefined();
    expect(res!.turn).toBe(1);
    expect(res!.stopReason).toBe("tool_use");
    expect(res!.text).toBe("hi");
    expect((res!.usage as any).inputTokens).toBe(100);
    expect((res!.usage as any).cacheReadInputTokens).toBe(30);
    expect(res!.rawAssistantMessage).toEqual(rawAssistant);
    expect(Array.isArray(res!.toolCalls)).toBe(true);
    expect((res!.toolCalls as any[])[0].name).toBe("report_result");
  });

  test("emits run_start, system_prompt, user_message as first three rows", async () => {
    const client = makeClient([{
      text: "", toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "s", reasoning: "r" } }],
      stopReason: "tool_use", rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 10, outputTokens: 5 },
    }]);
    await runAgent(makeCard(), makeAdapter(), client, logger, "http://x", {
      runId: "card-001_20260421T000000Z_aaaa",
      budgetMs: 600_000,
      maxStuckRetries: 5,
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

  test("emits tool_call + tool_result around each tool execution", async () => {
    const client = makeClient([
      {
        text: "", toolCalls: [{ id: "t1", name: "noop", arguments: { a: 1 } }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        text: "", toolCalls: [{ id: "t2", name: "report_result", arguments: { status: "pass", summary: "s", reasoning: "r" } }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const adapter = {
      name: "test",
      toolDefinitions: () => [{ name: "noop", description: "", parameters: { type: "object", properties: {} } }],
      async executeTool() { return { text: "done" }; },
      async start() {}, async close() {},
      describeTarget: (target: string) => `The application is available at: ${target}`,
      defaultViewport: () => null,
    } as unknown as Adapter;

    await runAgent(makeCard(), adapter, client, logger, undefined, {
      runId: "card-001_20260421T000000Z_aaaa",
      budgetMs: 600_000,
      maxStuckRetries: 5,
    });

    const rows = readLog(outDir);
    const call = rows.find((r) => r.type === "tool_call" && r.name === "noop");
    const result = rows.find((r) => r.type === "tool_result" && r.name === "noop");
    expect(call).toBeDefined();
    expect(call!.toolUseId).toBe("t1");
    expect(call!.turn).toBe(1);
    expect((call!.arguments as any).a).toBe(1);
    expect(result).toBeDefined();
    expect(result!.toolUseId).toBe("t1");
    expect(result!.text).toBe("done");
    expect(result!.error).toBe(false);
    expect(typeof result!.durationMs).toBe("number");
  });

  test("tool failure surfaces error:true and the message in text", async () => {
    const client = makeClient([
      {
        text: "", toolCalls: [{ id: "t1", name: "noop", arguments: {} }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        text: "", toolCalls: [{ id: "t2", name: "report_result", arguments: { status: "investigate", summary: "s", reasoning: "r" } }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const adapter = {
      name: "test",
      toolDefinitions: () => [{ name: "noop", description: "", parameters: { type: "object", properties: {} } }],
      async executeTool() { throw new Error("boom"); },
      async start() {}, async close() {},
      describeTarget: (target: string) => `The application is available at: ${target}`,
      defaultViewport: () => null,
    } as unknown as Adapter;

    await runAgent(makeCard(), adapter, client, logger, undefined, {
      runId: "card-001_20260421T000000Z_aaaa",
      budgetMs: 600_000,
      maxStuckRetries: 5,
    });

    const result = readLog(outDir).find((r) => r.type === "tool_result");
    expect(result!.error).toBe(true);
    expect((result!.text as string)).toContain("boom");
  });

  test("run_start carries provider + model when supplied", async () => {
    const client = makeClient([{
      text: "", toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "s", reasoning: "r" } }],
      stopReason: "tool_use", rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
    }]);
    await runAgent(makeCard(), makeAdapter(), client, logger, undefined, {
      runId: "card-001_20260421T000000Z_aaaa",
      budgetMs: 600_000,
      maxStuckRetries: 5,
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    const start = readLog(outDir).find((r) => r.type === "run_start")!;
    expect(start.provider).toBe("anthropic");
    expect(start.model).toBe("claude-opus-4-7");
  });

  test("emits run_end as the last event, with usage totals and status", async () => {
    const client = makeClient([{
      text: "", toolCalls: [{ id: "t1", name: "report_result", arguments: { status: "pass", summary: "ok", reasoning: "r" } }],
      stopReason: "tool_use", rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 10, outputTokens: 5 },
    }]);
    await runAgent(makeCard(), makeAdapter(), client, logger, undefined, {
      runId: "card-001_20260421T000000Z_aaaa",
      budgetMs: 600_000,
      maxStuckRetries: 5,
    });

    const rows = readLog(outDir);
    const last = rows[rows.length - 1];
    expect(last.type).toBe("run_end");
    expect(last.status).toBe("pass");
    expect(last.summary).toBe("ok");
    expect((last.usage as any).inputTokens).toBe(10);
    expect((last.usage as any).turns).toBe(1);
  });
});
