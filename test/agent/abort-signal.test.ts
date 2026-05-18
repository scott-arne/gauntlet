import { describe, test, expect } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { makeRunId } from "../../src/util/id";
import { textResult } from "../../src/models/provider";
import type { LLMClient, AgentResponse, ToolCall, ToolResult } from "../../src/models/provider";
import type { Adapter } from "../../src/adapters/adapter";
import type { EvidenceLogger } from "../../src/evidence/logger";
import type { StoryCard } from "../../src/format/story-card";

// PRI-1507 — the agent loop must observe `abortSignal` at two boundaries:
// between turns, and between adjacent tool calls within a turn. On either
// observation it MUST return a synthetic `errored` VetResult, not throw —
// see the spec invariant in `2026-05-13-shutdown-drain-cancellation-spec.md`
// (§1). Tests in this file are also the tripwire for that invariant: if a
// future refactor moves to throw-based abort, Case 1's assertion that
// `runAgent` resolves (rather than rejects) will fail loudly.

const card: StoryCard = {
  id: "abort-test",
  title: "Abort signal test scenario",
  status: "ready",
  tags: [],
  description: "A test",
  acceptanceCriteria: ["abort works"],
  raw: "",
};

interface CapturedEvent {
  type: string;
  body: Record<string, unknown>;
}

function makeTrackingLogger(): { logger: EvidenceLogger; events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  const noop = () => {};
  const trackEvent = (type: string) => (body: Record<string, unknown>) => {
    events.push({ type, body });
  };
  const logger = {
    screenshots: [],
    artifacts: [],
    captures: [],
    logPath: "run.jsonl",
    logRunStart: trackEvent("run_start"),
    logSystemPrompt: noop,
    logToolDefinitions: noop,
    logUserMessage: noop,
    logLlmRequest: noop,
    logLlmResponse: noop,
    logToolCall: noop,
    logToolResult: noop,
    logEvent: (name: string, data: Record<string, unknown>) => {
      events.push({ type: "event", body: { name, ...data } });
    },
    logRunEnd: trackEvent("run_end"),
    logRunError: trackEvent("run_error"),
    logShutdownSignaled: trackEvent("shutdown_signaled"),
  } as unknown as EvidenceLogger;
  return { logger, events };
}

function makeAdapter(executeToolImpl?: (name: string) => Promise<ToolResult>): Adapter {
  return {
    name: "test",
    toolDefinitions: () => [
      { name: "screenshot", description: "shot", parameters: { type: "object", properties: {} } },
      { name: "click", description: "click", parameters: { type: "object", properties: {} } },
      { name: "extract", description: "extract", parameters: { type: "object", properties: {} } },
    ],
    executeTool: async (name: string) => {
      if (executeToolImpl) return executeToolImpl(name);
      return textResult(`result of ${name}`);
    },
    start: async () => {},
    close: async () => {},
    describeTarget: (target: string) => `target: ${target}`,
    defaultViewport: () => null,
    isMutatingTool: () => false,
  };
}

function makeClient(responses: AgentResponse[]): LLMClient {
  let idx = 0;
  return {
    async chat() {
      const r = responses[idx++];
      if (!r) throw new Error("ran out of mock responses");
      return r;
    },
    userMessage(content: string) {
      return { role: "user", content };
    },
    toolResultMessages(calls: ToolCall[], results: ToolResult[]) {
      return calls.map((c, i) => ({ role: "tool_result", tool_call_id: c.id, content: results[i].text }));
    },
  } as LLMClient;
}

function toolCallTurn(toolCalls: ToolCall[]): AgentResponse {
  return {
    text: "",
    toolCalls,
    stopReason: "tool_use",
    rawAssistantMessage: { role: "assistant", content: [] },
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

describe("runAgent abort signal", () => {
  test("Case 1 — abort already set before turn 1: returns synthetic errored, turn 0", async () => {
    const { logger, events } = makeTrackingLogger();
    const ac = new AbortController();
    ac.abort("test-shutdown");

    // Client should never be called — the abort check fires first.
    const client = makeClient([]);

    const result = await runAgent(card, makeAdapter(), client, logger, undefined, {
      runId: makeRunId(card.id),
      budgetMs: 60_000,
      reflectionInterval: 0,
      abortSignal: ac.signal,
    });

    expect(result.status).toBe("errored");
    expect(result.error?.type).toBe("shutdown_interrupted");
    expect(result.usage?.turns).toBe(0);

    const shutdownEvents = events.filter((e) => e.type === "shutdown_signaled");
    expect(shutdownEvents).toHaveLength(1);
    expect(shutdownEvents[0]!.body.turn).toBe(0);
  });

  test("Case 2 — abort fires after turn 2 LLM response, before tool-call iteration", async () => {
    const { logger, events } = makeTrackingLogger();
    const ac = new AbortController();

    let executeToolCalls = 0;
    const adapter = makeAdapter(async (_name) => {
      executeToolCalls++;
      // After the first turn's single tool call resolves, abort the signal —
      // the next iteration's between-turn check should observe it.
      if (executeToolCalls === 1) ac.abort("test-shutdown");
      return textResult("ok");
    });

    const client = makeClient([
      toolCallTurn([{ id: "c1", name: "screenshot", arguments: {} }]),
      // This response should never be requested — abort fires first.
      toolCallTurn([{ id: "c99", name: "screenshot", arguments: {} }]),
    ]);

    const result = await runAgent(card, adapter, client, logger, undefined, {
      runId: makeRunId(card.id),
      budgetMs: 60_000,
      reflectionInterval: 0,
      abortSignal: ac.signal,
    });

    expect(result.status).toBe("errored");
    expect(result.error?.type).toBe("shutdown_interrupted");
    expect(result.usage?.turns).toBe(1); // Turn 1 completed; abort caught at start of turn 2

    expect(executeToolCalls).toBe(1); // turn 2's tool calls never executed

    const shutdownEvents = events.filter((e) => e.type === "shutdown_signaled");
    expect(shutdownEvents).toHaveLength(1);
    expect(shutdownEvents[0]!.body.turn).toBe(1);
  });

  test("Case 3 — abort fires mid-tool-call sequence within a turn", async () => {
    const { logger, events } = makeTrackingLogger();
    const ac = new AbortController();

    let executeToolCalls = 0;
    const adapter = makeAdapter(async (_name) => {
      executeToolCalls++;
      // Abort right after the first of three tool calls in turn 1 resolves —
      // the between-adjacent-tool-call check at the top of the next loop
      // iteration should observe it.
      if (executeToolCalls === 1) ac.abort("test-shutdown");
      return textResult("ok");
    });

    const client = makeClient([
      toolCallTurn([
        { id: "c1", name: "screenshot", arguments: {} },
        { id: "c2", name: "click", arguments: {} },
        { id: "c3", name: "extract", arguments: {} },
      ]),
    ]);

    const result = await runAgent(card, adapter, client, logger, undefined, {
      runId: makeRunId(card.id),
      budgetMs: 60_000,
      reflectionInterval: 0,
      abortSignal: ac.signal,
    });

    expect(result.status).toBe("errored");
    expect(result.error?.type).toBe("shutdown_interrupted");
    expect(executeToolCalls).toBe(1); // Two remaining tool calls in turn 1 were abandoned

    const shutdownEvents = events.filter((e) => e.type === "shutdown_signaled");
    expect(shutdownEvents).toHaveLength(1);
    // The event fires at the top of the next per-tool-call iteration, so
    // turns has already been incremented to 1 (turn 1's LLM call completed).
    expect(shutdownEvents[0]!.body.turn).toBe(1);
  });
});
