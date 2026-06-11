import { describe, test, expect } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import { makeRunId } from "../../src/util/id";
import { textResult } from "../../src/models/provider";
import type { LLMClient, AgentResponse, ToolCall, ToolResult } from "../../src/models/provider";
import type { Adapter } from "../../src/adapters/adapter";
import type { EvidenceLogger } from "../../src/evidence/logger";
import type { StoryCard } from "../../src/format/story-card";

// Criteria-less card: most tests here exercise loop mechanics, not the
// per-criterion citation contract, so reports don't need a criteria
// array. Citation behavior is tested separately with acCard below.
const card: StoryCard = {
  id: "test-001",
  title: "Test scenario",
  status: "ready",
  tags: [],
  description: "A test",
  acceptanceCriteria: [],
  raw: "",
};

// Card with acceptance criteria, for the per-criterion citation tests
// (PRI-2160): a report against this card must carry one cited verdict
// per criterion.
const acCard: StoryCard = {
  id: "test-ac-001",
  title: "Test scenario with criteria",
  status: "ready",
  tags: [],
  description: "A test with acceptance criteria",
  acceptanceCriteria: ["login works", "error shown for bad password"],
  raw: "",
};

function makeMockLogger(): EvidenceLogger {
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
    logUsageRow: () => {},
    logToolCall: () => {},
    logToolResult: () => {},
    logEvent: () => {},
    logRunEnd: () => {},
  } as unknown as EvidenceLogger;
}

function makeMockAdapter(
  toolResults: Record<string, string> = {}
): Adapter {
  return {
    name: "test",
    toolDefinitions: () => [
      {
        name: "screenshot",
        description: "Take a screenshot",
        parameters: { type: "object", properties: {} },
      },
    ],
    executeTool: async (name: string) => {
      if (name in toolResults) return textResult(toolResults[name]);
      return textResult(`result of ${name}`);
    },
    start: async () => {},
    close: async () => {},
    describeTarget: (target: string) => `The application is available at: ${target}`,
    defaultViewport: () => null,
    isMutatingTool: () => false,
  };
}

// A client that uses simple {role, content} messages internally
function makeMockClient(responses: AgentResponse[]): LLMClient {
  let callIndex = 0;
  const chatCalls: unknown[][] = [];
  const toolsPerCall: string[][] = [];

  return {
    async chat(messages, tools) {
      chatCalls.push([...messages]);
      toolsPerCall.push((tools ?? []).map((t) => t.name));
      const response = responses[callIndex++];
      if (!response) throw new Error("No more mock responses");
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
    _chatCalls: chatCalls,
    _toolsPerCall: toolsPerCall,
  } as LLMClient & { _chatCalls: unknown[][]; _toolsPerCall: string[][] };
}

describe("runAgent", () => {
  test("completes when agent calls report_result", async () => {
    const client = makeMockClient([
      // Turn 1: take a screenshot
      {
        text: "Let me take a screenshot",
        toolCalls: [{ id: "call_1", name: "screenshot", arguments: {} }],
        stopReason: "tool_use",
        rawAssistantMessage: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me take a screenshot" },
            { type: "tool_use", id: "call_1", name: "screenshot", input: {} },
          ],
        },
        usage: { inputTokens: 100, outputTokens: 50 },
      },
      // Turn 2: report result
      {
        text: "Everything looks good",
        toolCalls: [
          {
            id: "call_2",
            name: "report_result",
            arguments: {
              status: "pass",
              summary: "All good",
              reasoning: "Screenshot shows correct UI",
            },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: [] },
        usage: { inputTokens: 200, outputTokens: 75 },
      },
    ]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("pass");
    expect(result.summary).toBe("All good");
    expect(result.scenario).toBe("test-001");
    expect(result.usage).toEqual({
      inputTokens: 300,
      outputTokens: 125,
      turns: 2,
    });
  });

  test("passes tool results back to the client", async () => {
    const client = makeMockClient([
      {
        text: "",
        toolCalls: [{ id: "call_1", name: "screenshot", arguments: {} }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw_msg_1" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      {
        text: "",
        toolCalls: [
          {
            id: "call_2",
            name: "report_result",
            arguments: {
              status: "pass",
              summary: "done",
              reasoning: "done",
            },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw_msg_2" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);

    await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    // Second chat() call should have: initial user message + rawAssistantMessage + tool result
    const secondCallMessages = (client as any)._chatCalls[1];
    expect(secondCallMessages).toHaveLength(3);
    // First message: user message from client.userMessage()
    expect(secondCallMessages[0]).toEqual({
      role: "user",
      content: "Begin testing. Use the available tools to interact with the application.",
    });
    // Second: raw assistant message preserved from response
    expect(secondCallMessages[1]).toEqual({
      role: "assistant",
      content: "raw_msg_1",
    });
    // Third: tool result from client.toolResultMessages()
    expect(secondCallMessages[2]).toEqual({
      role: "tool_result",
      tool_call_id: "call_1",
      content: "result of screenshot",
    });
  });

  test("handles multi-turn tool use conversation", async () => {
    const client = makeMockClient([
      // Turn 1: take a screenshot
      {
        text: "I'll take a screenshot first",
        toolCalls: [{ id: "call_1", name: "screenshot", arguments: {} }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw_turn_1" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      // Turn 2: click something based on what was seen
      {
        text: "I see the page, let me click",
        toolCalls: [
          { id: "call_2", name: "click", arguments: { selector: ".btn" } },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw_turn_2" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      // Turn 3: report result with observations
      {
        text: "Everything checks out",
        toolCalls: [
          {
            id: "call_3",
            name: "report_result",
            arguments: {
              status: "pass",
              summary: "UI renders correctly",
              reasoning: "Screenshot confirmed layout, button click worked",
              observations: [
                { kind: "ux", description: "Button contrast could be higher" },
                { kind: "suggestion", description: "Add loading indicator" },
              ],
            },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw_turn_3" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);

    const adapter = makeMockAdapter({
      screenshot: "screenshot_base64_data",
      click: "clicked .btn",
    });

    const result = await runAgent(card, adapter, client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("pass");
    expect(result.summary).toBe("UI renders correctly");
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toEqual({
      kind: "ux",
      description: "Button contrast could be higher",
    });
    expect(result.observations[1]).toEqual({
      kind: "suggestion",
      description: "Add loading indicator",
    });

    // Verify message array grew correctly across turns
    const chatCalls = (client as any)._chatCalls;
    expect(chatCalls).toHaveLength(3);

    // Turn 1: just the initial user message
    expect(chatCalls[0]).toHaveLength(1);

    // Turn 2: initial user + raw assistant turn 1 + tool result for screenshot
    expect(chatCalls[1]).toHaveLength(3);
    expect(chatCalls[1][2]).toEqual({
      role: "tool_result",
      tool_call_id: "call_1",
      content: "screenshot_base64_data",
    });

    // Turn 3: previous 3 + raw assistant turn 2 + tool result for click = 5
    expect(chatCalls[2]).toHaveLength(5);
    expect(chatCalls[2][4]).toEqual({
      role: "tool_result",
      tool_call_id: "call_2",
      content: "clicked .btn",
    });
  });

  test("accumulates token usage across turns", async () => {
    const client = makeMockClient([
      {
        text: "Taking screenshot",
        toolCalls: [{ id: "call_1", name: "screenshot", arguments: {} }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "turn1" },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      {
        text: "Taking another screenshot",
        toolCalls: [{ id: "call_2", name: "screenshot", arguments: {} }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "turn2" },
        usage: { inputTokens: 250, outputTokens: 30 },
      },
      {
        text: "Done",
        toolCalls: [
          {
            id: "call_3",
            name: "report_result",
            arguments: {
              status: "pass",
              summary: "All good",
              reasoning: "Checked twice",
            },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "turn3" },
        usage: { inputTokens: 400, outputTokens: 50 },
      },
    ]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.usage).toEqual({
      inputTokens: 750,
      outputTokens: 100,
      turns: 3,
    });
  });

  test("emits an obol usage row per LLM call carrying the provider's raw usage", async () => {
    const rows: unknown[] = [];
    const logger = {
      ...makeMockLogger(),
      logUsageRow: (u: unknown) => {
        rows.push(u);
      },
    } as unknown as EvidenceLogger;
    const client = makeMockClient([
      {
        text: "Done",
        toolCalls: [
          {
            id: "call_1",
            name: "report_result",
            arguments: { status: "pass", summary: "ok", reasoning: "done" },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "t1" },
        usage: { inputTokens: 10, outputTokens: 5 },
        rawUsage: { input_tokens: 10, output_tokens: 5, service_tier: "standard" },
      },
    ]);

    await runAgent(card, makeMockAdapter(), client, logger, undefined, {
      runId: makeRunId(card.id),
      budgetMs: 600_000,
    });

    expect(rows).toEqual([
      { input_tokens: 10, output_tokens: 5, service_tier: "standard" },
    ]);
  });

  test("times out slow tool calls", async () => {
    let callCount = 0;

    const slowAdapter = {
      name: "test",
      async start() {},
      async close() {},
      toolDefinitions() {
        return [{
          name: "slow_tool",
          description: "A slow tool",
          parameters: { type: "object", properties: {} },
        }];
      },
      async executeTool(): Promise<ToolResult> {
        await new Promise((resolve) => setTimeout(resolve, 60000));
        return textResult("done");
      },
      describeTarget: (target: string) => `The application is available at: ${target}`,
      defaultViewport: () => null,
    };

    const client: LLMClient = {
      async chat() {
        callCount++;
        if (callCount === 1) {
          return {
            text: "calling slow tool",
            toolCalls: [{ id: "tc_1", name: "slow_tool", arguments: {} }],
            stopReason: "tool_use" as const,
            rawAssistantMessage: { role: "assistant" },
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        }
        return {
          text: "done",
          toolCalls: [{
            id: "tc_2", name: "report_result",
            arguments: { status: "fail", summary: "timed out", reasoning: "tool timed out" },
          }],
          stopReason: "tool_use" as const,
          rawAssistantMessage: { role: "assistant" },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
      userMessage(content: string) { return { role: "user", content }; },
      toolResultMessages(calls: ToolCall[], results: ToolResult[]) {
        return calls.map((c, i) => ({ role: "tool", id: c.id, content: results[i].text }));
      },
    };

    const result = await runAgent(
      card, slowAdapter as any, client, makeMockLogger(), undefined,
      { toolTimeoutMs: 500, runId: makeRunId(card.id), budgetMs: 600_000 }
    );

    expect(result.status).toBe("fail");
  }, 10000);

  test("empty response triggers a nudge; second empty ends with investigate (PRI-1864)", async () => {
    const emptyResp = {
      text: "",
      toolCalls: [],
      stopReason: "end_turn" as const,
      rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 50, outputTokens: 0 },
    };
    const client = makeMockClient([emptyResp, emptyResp]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("investigate");
    expect(result.summary).toContain("empty content twice");
    // Two chat() calls: original + nudge retry.
    expect((client as any)._chatCalls).toHaveLength(2);
  });

  test("malformed report_result is re-asked with the validation error; a corrected re-call is honored (PRI-2140)", async () => {
    const badReport = {
      text: "reporting",
      toolCalls: [
        {
          id: "call_1",
          name: "report_result",
          arguments: {
            status: "pass",
            summary: "All good",
            reasoning: "Everything checked out",
            observations: [{ kind: "ug", description: "truncated kind" }],
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "bad_report" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const correctedReport = {
      text: "corrected",
      toolCalls: [
        {
          id: "call_2",
          name: "report_result",
          arguments: {
            status: "pass",
            summary: "All good",
            reasoning: "Everything checked out",
            observations: [{ kind: "bug", description: "truncated kind" }],
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "corrected_report" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const client = makeMockClient([badReport, correctedReport]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("pass");
    expect(result.observations).toEqual([
      { kind: "bug", description: "truncated kind" },
    ]);

    // Two chat() calls: the rejected report, then the corrected re-call.
    const chatCalls = (client as any)._chatCalls;
    expect(chatCalls).toHaveLength(2);
    // The re-ask carries the validation error back as the tool result.
    const retryMessages = chatCalls[1];
    const rejectionResult = retryMessages.find(
      (m: any) => m.role === "tool_result" && m.tool_call_id === "call_1",
    );
    expect(rejectionResult).toBeDefined();
    expect(String(rejectionResult.content)).toContain("observations[0].kind");
    expect(String(rejectionResult.content)).toContain("report_result");
  });

  test("exhausted re-asks salvage a valid core verdict, dropping only the malformed observation (PRI-2140)", async () => {
    const eventLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const logger = makeMockLogger();
    (logger as any).logEvent = (name: string, params: Record<string, unknown>) => {
      eventLog.push({ name, params });
    };

    const stubbornReport = {
      text: "reporting",
      toolCalls: [
        {
          id: "call_1",
          name: "report_result",
          arguments: {
            status: "pass",
            summary: "Pi successfully executed the plan end-to-end",
            reasoning: "All tests pass",
            observations: [
              { kind: "suggestion", description: "valid one" },
              { kind: "ug", description: "stubbornly truncated" },
            ],
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "stubborn" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    // Initial call + 2 re-asks, all malformed the same way.
    const client = makeMockClient([stubbornReport, stubbornReport, stubbornReport]);

    const result = await runAgent(card, makeMockAdapter(), client, logger, undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("pass");
    expect(result.summary).toContain("Pi successfully executed");
    expect(result.observations).toEqual([
      { kind: "suggestion", description: "valid one" },
    ]);
    expect((client as any)._chatCalls).toHaveLength(3);

    const salvaged = eventLog.find((e) => e.name === "report_result_salvaged");
    expect(salvaged).toBeDefined();
    expect(salvaged?.params.dropped).toEqual([
      { index: 1, reason: expect.stringContaining("ug") },
    ]);
  });

  test("a report against acceptance criteria without cited verdicts is re-asked; the cited re-call is honored and persisted (PRI-2160)", async () => {
    const uncitedReport = {
      text: "reporting",
      toolCalls: [
        {
          id: "call_1",
          name: "report_result",
          arguments: {
            status: "pass",
            summary: "Both criteria satisfied",
            reasoning: "Saw the dashboard and the error banner",
            observations: [],
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "uncited" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const citedCriteria = [
      {
        criterion: "login works",
        verdict: "pass",
        evidence: "Dashboard header 'Welcome back' rendered after submit (screenshot 002)",
      },
      {
        criterion: "error shown for bad password",
        verdict: "pass",
        evidence: "Banner 'Incorrect password' visible after submitting bad creds",
      },
    ];
    const citedReport = {
      text: "cited",
      toolCalls: [
        {
          id: "call_2",
          name: "report_result",
          arguments: {
            status: "pass",
            summary: "Both criteria satisfied",
            reasoning: "Saw the dashboard and the error banner",
            observations: [],
            criteria: citedCriteria,
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "cited" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const client = makeMockClient([uncitedReport, citedReport]);

    const result = await runAgent(acCard, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(acCard.id), budgetMs: 600_000 });

    expect(result.status).toBe("pass");
    expect(result.criteria).toEqual(citedCriteria);

    const chatCalls = (client as any)._chatCalls;
    expect(chatCalls).toHaveLength(2);
    const rejection = chatCalls[1].find(
      (m: any) => m.role === "tool_result" && m.tool_call_id === "call_1",
    );
    expect(String(rejection.content)).toContain("criteria");
  });

  test("a report with empty evidence on one criterion is re-asked", async () => {
    const weakReport = {
      text: "reporting",
      toolCalls: [
        {
          id: "call_1",
          name: "report_result",
          arguments: {
            status: "fail",
            summary: "Second criterion failed",
            reasoning: "No error shown",
            observations: [],
            criteria: [
              { criterion: "login works", verdict: "pass", evidence: "dashboard rendered" },
              { criterion: "error shown", verdict: "fail", evidence: "" },
            ],
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "weak" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const fixedReport = {
      text: "fixed",
      toolCalls: [
        {
          id: "call_2",
          name: "report_result",
          arguments: {
            status: "fail",
            summary: "Second criterion failed",
            reasoning: "No error shown",
            observations: [],
            criteria: [
              { criterion: "login works", verdict: "pass", evidence: "dashboard rendered" },
              {
                criterion: "error shown",
                verdict: "fail",
                evidence: "Submitted bad password; page stayed blank, no banner in screenshot 004",
              },
            ],
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "fixed" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const client = makeMockClient([weakReport, fixedReport]);

    const result = await runAgent(acCard, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(acCard.id), budgetMs: 600_000 });

    expect(result.status).toBe("fail");
    expect(result.criteria?.[1].evidence).toContain("screenshot 004");
    const rejection = (client as any)._chatCalls[1].find(
      (m: any) => m.role === "tool_result" && m.tool_call_id === "call_1",
    );
    expect(String(rejection.content)).toContain("criteria[1].evidence");
  });

  test("persistently uncited reports are salvaged after bounded re-asks — the verdict survives without criteria (PRI-2160)", async () => {
    const eventLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const logger = makeMockLogger();
    (logger as any).logEvent = (name: string, params: Record<string, unknown>) => {
      eventLog.push({ name, params });
    };
    const uncitedReport = {
      text: "reporting",
      toolCalls: [
        {
          id: "call_1",
          name: "report_result",
          arguments: {
            status: "pass",
            summary: "It all worked",
            reasoning: "Looked fine",
            observations: [],
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "uncited" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const client = makeMockClient([uncitedReport, uncitedReport, uncitedReport]);

    const result = await runAgent(acCard, makeMockAdapter(), client, logger, undefined, { runId: makeRunId(acCard.id), budgetMs: 600_000 });

    expect(result.status).toBe("pass");
    expect(result.criteria).toBeUndefined();
    expect((client as any)._chatCalls).toHaveLength(3);
    const salvaged = eventLog.find((e) => e.name === "report_result_salvaged");
    expect(salvaged).toBeDefined();
    expect(String(salvaged?.params.reason)).toContain("criteria");
  });

  test("a card without acceptance criteria does not require cited verdicts", async () => {
    const client = makeMockClient([
      {
        text: "done",
        toolCalls: [
          {
            id: "c1",
            name: "report_result",
            arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "r" },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });
    expect(result.status).toBe("pass");
    expect(result.criteria).toBeUndefined();
    expect((client as any)._chatCalls).toHaveLength(1);
  });

  test("unsalvageable malformed report_result returns investigate after bounded re-asks", async () => {
    const badStatusReport = {
      text: "reporting",
      toolCalls: [
        {
          id: "call_1",
          name: "report_result",
          arguments: {
            status: "success", // not a valid VetStatus — core verdict unusable
            summary: "x",
            reasoning: "y",
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: [] },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const client = makeMockClient([badStatusReport, badStatusReport, badStatusReport]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("investigate");
    expect(result.summary).toContain("malformed report_result");
    expect(result.reasoning).toContain("success");
    expect((client as any)._chatCalls).toHaveLength(3);
  });

  test("sibling tool calls beside a malformed report_result get not-executed results on the re-ask", async () => {
    const badReportWithSibling = {
      text: "reporting",
      toolCalls: [
        { id: "call_shot", name: "screenshot", arguments: {} },
        {
          id: "call_rep",
          name: "report_result",
          arguments: {
            status: "pass",
            summary: "ok",
            reasoning: "ok",
            observations: [{ kind: "ug", description: "bad" }],
          },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "with_sibling" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const corrected = {
      text: "corrected",
      toolCalls: [
        {
          id: "call_rep2",
          name: "report_result",
          arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "corrected" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const client = makeMockClient([badReportWithSibling, corrected]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("pass");
    const retryMessages = (client as any)._chatCalls[1];
    const siblingResult = retryMessages.find(
      (m: any) => m.role === "tool_result" && m.tool_call_id === "call_shot",
    );
    expect(siblingResult).toBeDefined();
    expect(String(siblingResult.content)).toContain("not executed");
  });

  // Regression: PRI-2160 (run b35d). The judge hit max_tokens mid-thinking
  // on turn 36 while composing its verdict and the run went indeterminate
  // despite a fully-successful subject. A truncation now gets one recovery
  // turn (truncated output discarded, concision nudge injected) before
  // falling back to investigate.
  test("max_tokens truncation gets one recovery turn; the recovered report is honored (PRI-2160)", async () => {
    const truncated = {
      text: "I was reasoning at length about the criteria and then got cut o",
      toolCalls: [],
      stopReason: "max_tokens" as const,
      rawAssistantMessage: { role: "assistant", content: [{ type: "text", text: "cut o" }] },
      usage: { inputTokens: 100, outputTokens: 4096 },
    };
    const recovered = {
      text: "reporting now",
      toolCalls: [
        {
          id: "c2",
          name: "report_result",
          arguments: { status: "pass", summary: "All good", reasoning: "Verified", observations: [] },
        },
      ],
      stopReason: "tool_use" as const,
      rawAssistantMessage: { role: "assistant", content: "r2" },
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    const client = makeMockClient([truncated, recovered]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("pass");
    expect(result.summary).toBe("All good");

    const chatCalls = (client as any)._chatCalls;
    expect(chatCalls).toHaveLength(2);
    // The truncated output was replaced with a stub (not replayed), and
    // the recovery nudge tells the model it was cut off.
    const recoveryMessages = chatCalls[1];
    const lastMessage = recoveryMessages[recoveryMessages.length - 1];
    expect(lastMessage.role).toBe("user");
    expect(String(lastMessage.content)).toContain("cut off");
    expect(String(lastMessage.content)).toContain("report_result");
    const stub = recoveryMessages[recoveryMessages.length - 2];
    expect(JSON.stringify(stub)).toContain("truncated");
    expect(JSON.stringify(stub)).not.toContain("cut o\"");
  });

  test("truncation stub is a valid input item for both provider shapes", async () => {
    const { synthesizeTruncatedAssistantStub } = await import("../../src/agent/agent");

    // Anthropic raw is {role, content[]} — stub keeps that shape.
    const anthropicStub = synthesizeTruncatedAssistantStub({
      role: "assistant",
      content: [{ type: "text", text: "partial" }],
    }) as { role: string; content: Array<{ type: string; text: string }> };
    expect(anthropicStub.role).toBe("assistant");
    expect(anthropicStub.content[0].type).toBe("text");
    expect(anthropicStub.content[0].text).toContain("truncated");

    // OpenAI Responses raw is an array of output items — the stub must be
    // a valid *input* item: a `message` item with string content (the
    // same shape openai.ts's userMessage emits), not an output_text
    // block missing the full ResponseOutputMessage shape.
    const openaiStub = synthesizeTruncatedAssistantStub([
      { type: "message", role: "assistant", content: [] },
    ]) as Array<{ type: string; role: string; content: string }>;
    expect(openaiStub).toHaveLength(1);
    expect(openaiStub[0].type).toBe("message");
    expect(openaiStub[0].role).toBe("assistant");
    expect(openaiStub[0].content).toContain("truncated");
  });

  test("a second max_tokens truncation returns investigate", async () => {
    const truncated = {
      text: "still rambling",
      toolCalls: [],
      stopReason: "max_tokens" as const,
      rawAssistantMessage: { role: "assistant", content: [{ type: "text", text: "still rambling" }] },
      usage: { inputTokens: 100, outputTokens: 4096 },
    };
    const client = makeMockClient([truncated, truncated]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("investigate");
    expect(result.summary).toContain("max_tokens");
    expect((client as any)._chatCalls).toHaveLength(2);
  });

  test("accumulates cache token usage across turns", async () => {
    const client = makeMockClient([
      {
        text: "first",
        toolCalls: [{ id: "c1", name: "screenshot", arguments: {} }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "t1" },
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          cacheCreationInputTokens: 800,
          cacheReadInputTokens: 0,
        },
      },
      {
        text: "done",
        toolCalls: [
          {
            id: "c2",
            name: "report_result",
            arguments: { status: "pass", summary: "ok", reasoning: "ok" },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "t2" },
        usage: {
          inputTokens: 200,
          outputTokens: 30,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 800,
        },
      },
    ]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cacheCreationInputTokens: 800,
      cacheReadInputTokens: 800,
      turns: 2,
    });
  });

  test("drops and logs other tool calls when report_result is in the same turn", async () => {
    const eventLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const logger = makeMockLogger();
    (logger as any).logEvent = (name: string, params: Record<string, unknown>) => {
      eventLog.push({ name, params });
    };

    const client = makeMockClient([
      {
        text: "reporting and clicking",
        toolCalls: [
          { id: "c1", name: "click", arguments: { selector: "#x" } },
          {
            id: "c2",
            name: "report_result",
            arguments: { status: "pass", summary: "ok", reasoning: "ok" },
          },
          { id: "c3", name: "navigate", arguments: { url: "/foo" } },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "t" },
        usage: { inputTokens: 5, outputTokens: 5 },
      },
    ]);

    const result = await runAgent(card, makeMockAdapter(), client, logger, undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

    expect(result.status).toBe("pass");
    // Exactly one logged dropped-tools event, and it names the two.
    const dropped = eventLog.find((e) => e.name === "report_with_other_tools_dropped");
    expect(dropped).toBeDefined();
    expect(dropped?.params.dropped).toEqual(["click", "navigate"]);
  });

  test("clears timeout on tool success (no timer leak)", async () => {
    // Track timeout lifecycle via a wrapper. The global setTimeout/clearTimeout
    // are called by Promise.race's loser handler too, so we count matched
    // pairs rather than assert exact timer counts.
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let created = 0;
    let cleared = 0;
    (globalThis as any).setTimeout = ((fn: () => void, ms?: number) => {
      created++;
      return originalSetTimeout(fn, ms);
    }) as typeof setTimeout;
    (globalThis as any).clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      cleared++;
      return originalClearTimeout(handle);
    }) as typeof clearTimeout;

    try {
      const client = makeMockClient([
        {
          text: "click",
          toolCalls: [{ id: "c1", name: "screenshot", arguments: {} }],
          stopReason: "tool_use",
          rawAssistantMessage: { role: "assistant", content: "r1" },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        {
          text: "done",
          toolCalls: [
            {
              id: "c2",
              name: "report_result",
              arguments: { status: "pass", summary: "ok", reasoning: "ok" },
            },
          ],
          stopReason: "tool_use",
          rawAssistantMessage: { role: "assistant", content: "r2" },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ]);

      await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, { runId: makeRunId(card.id), budgetMs: 600_000 });

      // Every setTimeout in the race path should be matched by a clearTimeout.
      // We had at least one tool call, so created must be >= 1.
      expect(created).toBeGreaterThanOrEqual(1);
      expect(cleared).toBeGreaterThanOrEqual(created);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  test("handles tool execution errors gracefully", async () => {
    const failingAdapter = makeMockAdapter();
    failingAdapter.executeTool = async (name: string) => {
      if (name === "click") throw new Error("Element not found: .missing");
      return textResult(`result of ${name}`);
    };

    const client = makeMockClient([
      // Turn 1: try to click a bad selector
      {
        text: "Let me click",
        toolCalls: [
          { id: "call_1", name: "click", arguments: { selector: ".missing" } },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      // Turn 2: agent sees the error, reports failure
      {
        text: "Click failed",
        toolCalls: [
          {
            id: "call_2",
            name: "report_result",
            arguments: {
              status: "fail",
              summary: "Required element not found",
              reasoning: "Click on .missing failed with element not found error",
            },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw2" },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);

    const result = await runAgent(
      card,
      failingAdapter,
      client,
      makeMockLogger(),
      undefined,
      { runId: makeRunId(card.id), budgetMs: 600_000 }
    );

    expect(result.status).toBe("fail");
    expect(result.summary).toBe("Required element not found");

    // Verify the error was passed back as a tool result, not thrown
    const secondCallMessages = (client as any)._chatCalls[1];
    expect(secondCallMessages[2]).toEqual({
      role: "tool_result",
      tool_call_id: "call_1",
      content: "Error: Element not found: .missing",
    });
  });

  test("deadline exhaustion injects SYSTEM-REMINDER grace turn and honors the agent's final report", async () => {
    const eventLog: Array<{ name: string; params: Record<string, unknown> }> = [];
    const logger = makeMockLogger();
    (logger as any).logEvent = (name: string, params: Record<string, unknown>) => {
      eventLog.push({ name, params });
    };

    // budgetMs: 0 means the deadline is already past before the loop runs —
    // the while condition is false immediately, so we skip straight to the
    // grace turn. Only one chat() call is made (the grace turn itself).
    const client = makeMockClient([
      // Grace turn: agent responds to the SYSTEM-REMINDER with a proper report.
      {
        text: "Out of time; summarizing",
        toolCalls: [
          {
            id: "c1",
            name: "report_result",
            arguments: {
              status: "investigate",
              summary: "Did not finish within turn budget",
              reasoning: "Budget expired before any work; still exploring",
              observations: [
                { kind: "suggestion", description: "Configure a longer --max-time for this scenario" },
              ],
            },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "grace" },
        usage: { inputTokens: 20, outputTokens: 15 },
      },
    ]);

    const result = await runAgent(card, makeMockAdapter(), client, logger, undefined, {
      runId: makeRunId(card.id),
      budgetMs: 0,
    });

    // Honor the agent's verdict from the grace turn.
    expect(result.status).toBe("investigate");
    expect(result.summary).toBe("Did not finish within turn budget");
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toEqual({
      kind: "suggestion",
      description: "Configure a longer --max-time for this scenario",
    });

    // usage.turns is 0 — loop never ran. Token counts accumulate from grace call.
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 15,
      turns: 0,
    });

    // Only one chat() call: the grace turn. The loop never executed.
    const chatCalls = (client as any)._chatCalls;
    expect(chatCalls).toHaveLength(1);

    // The grace turn's final user message is the SYSTEM-REMINDER.
    const graceMessages = chatCalls[0];
    const lastMessage = graceMessages[graceMessages.length - 1];
    expect(lastMessage).toMatchObject({ role: "user" });
    expect(String(lastMessage.content)).toContain("<SYSTEM-REMINDER>");
    expect(String(lastMessage.content)).toContain("time budget");
    expect(String(lastMessage.content)).toContain("report_result");

    // Grace turn was called with ONLY report_result exposed — no adapter tools.
    const toolsPerCall = (client as any)._toolsPerCall;
    expect(toolsPerCall[0]).toEqual(["report_result"]);

    // deadline_reminder event was logged (for stream renderers).
    const reminder = eventLog.find((e) => e.name === "deadline_reminder");
    expect(reminder).toBeDefined();
    expect(reminder?.params.budgetMs).toBe(0);
  });

  test("grace-turn report with a malformed observation is salvaged, not discarded (PRI-2140)", async () => {
    // budgetMs: 0 — loop never runs, so there is no re-ask budget; the
    // grace turn is the final response. A valid core verdict with a
    // corrupt observation must still be honored.
    const client = makeMockClient([
      {
        text: "out of time",
        toolCalls: [
          {
            id: "c1",
            name: "report_result",
            arguments: {
              status: "investigate",
              summary: "Ran out of budget mid-scenario",
              reasoning: "Still had two criteria unverified",
              observations: [
                { kind: "ug", description: "truncated kind" },
                { kind: "suggestion", description: "raise the budget" },
              ],
            },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "grace" },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, {
      runId: makeRunId(card.id),
      budgetMs: 0,
    });

    expect(result.status).toBe("investigate");
    expect(result.summary).toBe("Ran out of budget mid-scenario");
    expect(result.observations).toEqual([
      { kind: "suggestion", description: "raise the budget" },
    ]);
    expect((client as any)._chatCalls).toHaveLength(1);
  });

  test("falls through to generic exhausted result when grace turn also fails to report", async () => {
    // budgetMs: 0 — loop never runs, grace turn fires immediately.
    // The grace turn returns text-only (no report_result call), triggering
    // the fallthrough path.
    const client = makeMockClient([
      // Grace turn: text only, no tool calls — the agent ignored the reminder.
      {
        text: "I should have called report_result",
        toolCalls: [],
        stopReason: "end_turn",
        rawAssistantMessage: { role: "assistant", content: "grace" },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger(), undefined, {
      runId: makeRunId(card.id),
      budgetMs: 0,
    });

    expect(result.status).toBe("investigate");
    expect(result.summary).toContain("time budget");
    expect(result.reasoning).toContain("grace");
    // One chat() call: the grace turn. The loop never ran (budgetMs: 0).
    expect((client as any)._chatCalls).toHaveLength(1);
  });

  test("logs tool_definitions after system_prompt at run start", async () => {
    const calls: Array<{ kind: string; payload?: unknown }> = [];
    const mockLogger = {
      screenshots: [],
      artifacts: [],
      captures: [],
      logPath: "/tmp/test.log",
      logRunStart: () => { calls.push({ kind: "logRunStart" }); },
      logSystemPrompt: (p: string) => { calls.push({ kind: "logSystemPrompt", payload: p }); },
      logToolDefinitions: (tools: unknown) => { calls.push({ kind: "logToolDefinitions", payload: tools }); },
      logUserMessage: () => {},
      logLlmRequest: () => {},
      logLlmResponse: () => {},
      logToolCall: () => {},
      logToolResult: () => {},
      logEvent: () => {},
      logRunEnd: () => {},
    } as unknown as EvidenceLogger;

    const client = makeMockClient([
      {
        text: "",
        toolCalls: [{
          id: "rep1",
          name: "report_result",
          arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] },
        }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: [
          { type: "tool_use", id: "rep1", name: "report_result",
            input: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } },
        ] },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    ]);

    await runAgent(card, makeMockAdapter(), client, mockLogger, "http://x", {
      runId: makeRunId(card.id),
      budgetMs: 60000,
    } as any);

    const sysIdx = calls.findIndex((c) => c.kind === "logSystemPrompt");
    const toolDefsIdx = calls.findIndex((c) => c.kind === "logToolDefinitions");
    expect(toolDefsIdx).toBeGreaterThan(-1);
    expect(toolDefsIdx).toBeGreaterThan(sysIdx);
    const tools = calls[toolDefsIdx].payload as Array<{ name: string }>;
    const names = tools.map((t) => t.name);
    expect(names).toContain("screenshot"); // from makeMockAdapter
    expect(names).toContain("report_result");
  });
});
