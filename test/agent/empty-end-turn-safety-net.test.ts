import { describe, test, expect } from "bun:test";
import { runAgent, synthesizeFilledAssistantMessage } from "../../src/agent/agent";
import { makeRunId } from "../../src/util/id";
import { textResult } from "../../src/models/provider";
import type { LLMClient, AgentResponse, ToolCall, ToolResult } from "../../src/models/provider";
import type { Adapter } from "../../src/adapters/adapter";
import type { EvidenceLogger } from "../../src/evidence/logger";
import type { StoryCard } from "../../src/format/story-card";

const card: StoryCard = {
  id: "empty-end-turn-001",
  title: "Empty end_turn safety net",
  status: "ready",
  tags: [],
  description: "A test",
  // Criteria-less: these tests exercise loop mechanics, not the
  // per-criterion citation contract (PRI-2160).
  acceptanceCriteria: [],
  raw: "",
};

interface CapturedEvent {
  name: string;
  payload: Record<string, unknown>;
}

function makeRecordingLogger(events: CapturedEvent[]): EvidenceLogger {
  return {
    screenshots: [],
    artifacts: [],
    captures: [],
    logPath: "/tmp/test.log",
    logTool: () => {},
    logScreenshot: () => "/tmp/shot.png",
    logAction: () => {},
    logRunStart: () => {},
    logSystemPrompt: () => {},
    logToolDefinitions: () => {},
    logUserMessage: () => {},
    logLlmRequest: () => {},
    logLlmResponse: () => {},
    logToolCall: () => {},
    logToolResult: () => {},
    logEvent: (name: string, payload: Record<string, unknown>) =>
      events.push({ name, payload }),
    logRunEnd: () => {},
  } as unknown as EvidenceLogger;
}

function makeMockAdapter(): Adapter {
  return {
    name: "test",
    toolDefinitions: () => [],
    executeTool: async (name: string) => textResult(`result of ${name}`),
    start: async () => {},
    close: async () => {},
    describeTarget: (target: string) => `target: ${target}`,
    defaultViewport: () => null,
    isMutatingTool: () => false,
  };
}

function emptyResponse(): AgentResponse {
  return {
    text: "",
    toolCalls: [],
    stopReason: "end_turn",
    rawAssistantMessage: { role: "assistant", content: [] },
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}

function reportResultResponse(): AgentResponse {
  return {
    text: "Reporting result.",
    toolCalls: [
      {
        id: "tu_1",
        name: "report_result",
        arguments: {
          status: "pass",
          summary: "Recovered after nudge",
          reasoning: "Saw the nudge and chose to report.",
        },
      },
    ],
    stopReason: "tool_use",
    rawAssistantMessage: { role: "assistant", content: [] },
    usage: {
      inputTokens: 10,
      outputTokens: 30,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}

function makeScriptedClient(responses: AgentResponse[]): LLMClient {
  let i = 0;
  return {
    async chat() {
      const r = responses[i++];
      if (!r) throw new Error(`No more scripted responses (call index ${i})`);
      return r;
    },
    userMessage(content: string) {
      return { role: "user", content };
    },
    toolResultMessages(calls: ToolCall[], results: ToolResult[]) {
      return calls.map((call, idx) => ({
        role: "tool_result",
        tool_call_id: call.id,
        content: results[idx].text,
      }));
    },
  } as LLMClient;
}

describe("empty-end_turn safety net", () => {
  test("first empty response triggers nudge; second response recovers", async () => {
    const events: CapturedEvent[] = [];
    const logger = makeRecordingLogger(events);
    const client = makeScriptedClient([emptyResponse(), reportResultResponse()]);
    const adapter = makeMockAdapter();

    const result = await runAgent(card, adapter, client, logger, "x", {
      runId: makeRunId("test"),
      budgetMs: 5_000,
      reflectionInterval: 0,
    });

    expect(result.status).toBe("pass");
    expect(events.some((e) => e.name === "empty_response_nudge")).toBe(true);
    expect(events.some((e) => e.name === "empty_response_after_nudge")).toBe(false);
  });

  test("two consecutive empty responses end with investigate", async () => {
    const events: CapturedEvent[] = [];
    const logger = makeRecordingLogger(events);
    const client = makeScriptedClient([emptyResponse(), emptyResponse()]);
    const adapter = makeMockAdapter();

    const result = await runAgent(card, adapter, client, logger, "x", {
      runId: makeRunId("test"),
      budgetMs: 5_000,
      reflectionInterval: 0,
    });

    expect(result.status).toBe("investigate");
    expect(result.summary).toContain("empty content twice");
    expect(events.some((e) => e.name === "empty_response_nudge")).toBe(true);
    expect(events.some((e) => e.name === "empty_response_after_nudge")).toBe(true);
  });
});

describe("synthesizeFilledAssistantMessage", () => {
  test("Anthropic shape: replaces empty content array with a stub text block", () => {
    const raw = { role: "assistant", content: [] };
    const filled = synthesizeFilledAssistantMessage(raw) as {
      role: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(filled.role).toBe("assistant");
    expect(filled.content).toHaveLength(1);
    expect(filled.content[0].type).toBe("text");
    expect(filled.content[0].text).toBe("(empty turn)");
  });

  test("OpenAI Responses shape: replaces empty array with a single assistant message item", () => {
    // Must be a valid Responses *input* item. `output_text` content under
    // a bare assistant message is not — the input shape is a `message`
    // item with string content, the same shape openai.ts's userMessage
    // emits for the user role.
    const filled = synthesizeFilledAssistantMessage([]) as Array<{
      type: string;
      role: string;
      content: string;
    }>;
    expect(filled).toHaveLength(1);
    expect(filled[0].type).toBe("message");
    expect(filled[0].role).toBe("assistant");
    expect(filled[0].content).toBe("(empty turn)");
  });

  test("non-empty content passes through unchanged", () => {
    const raw = { role: "assistant", content: [{ type: "text", text: "hi" }] };
    expect(synthesizeFilledAssistantMessage(raw)).toBe(raw);
  });
});
