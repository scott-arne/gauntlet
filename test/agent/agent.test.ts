import { describe, test, expect } from "bun:test";
import { runAgent } from "../../src/agent/agent";
import type { LLMClient, AgentResponse, ToolCall } from "../../src/models/provider";
import type { Adapter } from "../../src/adapters/adapter";
import type { EvidenceLogger } from "../../src/evidence/logger";
import type { StoryCard } from "../../src/format/story-card";

const card: StoryCard = {
  id: "test-001",
  title: "Test scenario",
  status: "ready",
  tags: [],
  description: "A test",
  acceptanceCriteria: ["something works"],
  raw: "",
};

function makeMockLogger(): EvidenceLogger {
  return {
    screenshots: [],
    logPath: "/tmp/test.log",
    logTool: () => {},
    logScreenshot: () => "/tmp/shot.png",
  } as unknown as EvidenceLogger;
}

function makeMockAdapter(
  toolResults: Record<string, string> = {}
): Adapter {
  return {
    toolDefinitions: () => [
      {
        name: "screenshot",
        description: "Take a screenshot",
        parameters: { type: "object", properties: {} },
      },
    ],
    executeTool: async (name: string) => {
      if (name in toolResults) return toolResults[name];
      return `result of ${name}`;
    },
    start: async () => {},
    close: async () => {},
  };
}

// A client that uses simple {role, content} messages internally
function makeMockClient(responses: AgentResponse[]): LLMClient {
  let callIndex = 0;
  const chatCalls: unknown[][] = [];

  return {
    async chat(messages) {
      chatCalls.push([...messages]);
      const response = responses[callIndex++];
      if (!response) throw new Error("No more mock responses");
      return response;
    },
    userMessage(content: string) {
      return { role: "user", content };
    },
    toolResultMessages(calls: ToolCall[], results: string[]) {
      return calls.map((call, i) => ({
        role: "tool_result",
        tool_call_id: call.id,
        content: results[i],
      }));
    },
    _chatCalls: chatCalls,
  } as LLMClient & { _chatCalls: unknown[][] };
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
      },
    ]);

    const result = await runAgent(card, makeMockAdapter(), client, makeMockLogger());

    expect(result.status).toBe("pass");
    expect(result.summary).toBe("All good");
    expect(result.scenario).toBe("test-001");
  });

  test("passes tool results back to the client", async () => {
    const client = makeMockClient([
      {
        text: "",
        toolCalls: [{ id: "call_1", name: "screenshot", arguments: {} }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw_msg_1" },
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
      },
    ]);

    await runAgent(card, makeMockAdapter(), client, makeMockLogger());

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

  test("handles tool execution errors gracefully", async () => {
    const failingAdapter = makeMockAdapter();
    failingAdapter.executeTool = async (name: string) => {
      throw new Error("browser crashed");
    };

    const client = makeMockClient([
      {
        text: "",
        toolCalls: [{ id: "call_1", name: "screenshot", arguments: {} }],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw" },
      },
      {
        text: "",
        toolCalls: [
          {
            id: "call_2",
            name: "report_result",
            arguments: {
              status: "investigate",
              summary: "Tool failed",
              reasoning: "Screenshot tool errored",
            },
          },
        ],
        stopReason: "tool_use",
        rawAssistantMessage: { role: "assistant", content: "raw2" },
      },
    ]);

    const result = await runAgent(card, failingAdapter, client, makeMockLogger());

    expect(result.status).toBe("investigate");

    // Verify the error was passed back as a tool result, not thrown
    const secondCallMessages = (client as any)._chatCalls[1];
    expect(secondCallMessages[2]).toEqual({
      role: "tool_result",
      tool_call_id: "call_1",
      content: "Error: browser crashed",
    });
  });
});
