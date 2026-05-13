import { describe, test, expect, afterEach } from "bun:test";
import { rebuildMessages } from "../../src/revival/rebuild-messages";
import {
  makeRunDir,
  cleanup,
  makeFakeAnthropicClient,
  writeScreenshot,
  writeArtifact,
  writeCapture,
  ONE_PIXEL_PNG,
} from "./fixtures";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) cleanup(cleanups.pop()!);
});

const minimalRunStart = {
  type: "run_start", runId: "r1", cardId: "c1",
  model: "claude-sonnet-4-6", adapter: "web", provider: "anthropic",
  target: "x", budgetMs: 60000, reflectionInterval: 0,
  toolTimeoutMs: 30000, contextTreeBytes: 0,
};

describe("rebuildMessages — happy path", () => {
  test("returns systemPrompt, messages, modelId, adapterName for a 2-turn run", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "You are a test agent." },
      { type: "tool_definitions", tools: [
        { name: "click", description: "Click", parameters: { type: "object" } },
        { name: "report_result", description: "Report", parameters: { type: "object" } },
      ]},
      { type: "user_message", turn: 0, content: "Test the login page at http://x" },
      { type: "llm_request", turn: 1, messageCount: 1 },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "",
        thinking: [],
        toolCalls: [{ id: "t1", name: "click", arguments: { selector: "#login" } }],
        usage: { inputTokens: 100, outputTokens: 20 },
        rawAssistantMessage: { role: "assistant", content: [
          { type: "tool_use", id: "t1", name: "click", input: { selector: "#login" } },
        ]},
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "click", arguments: { selector: "#login" } },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "click", durationMs: 5, text: "ok", error: false },
      { type: "run_end", status: "pass", summary: "done", reasoning: "done", observationCount: 0, observations: [], durationMs: 100, usage: { inputTokens: 100, outputTokens: 20, turns: 1 } },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    expect(result.modelId).toBe("claude-sonnet-4-6");
    expect(result.adapterName).toBe("web");
    expect(result.systemPrompt).toContain("You are a test agent.");
    expect(result.systemPrompt).toContain("REVIVAL");
    expect(result.messages.length).toBeGreaterThanOrEqual(3);
    const m0 = result.messages[0] as { role: string };
    expect(m0.role).toBe("user");
    const m1 = result.messages[1] as { role: string };
    expect(m1.role).toBe("assistant");
    expect(result.warnings).toEqual([]);
  });
});

describe("rebuildMessages — image rehydration", () => {
  test("reads screenshot bytes from disk and slots them into the tool_result block", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [{ name: "screenshot", description: "shoot", parameters: { type: "object" } }] },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "screenshot", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "screenshot", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "screenshot", durationMs: 5, text: "", image: "screenshots/001.png", mediaType: "image/png", error: false },
    ]);
    cleanups.push(dir);
    writeScreenshot(dir, "001.png", ONE_PIXEL_PNG);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const userTurn = result.messages.find(
      (m) => (m as { role?: string }).role === "user" && Array.isArray((m as { content: unknown }).content),
    ) as { role: string; content: Array<{ type: string; tool_use_id: string; content: Array<{ type: string; source?: { type: string; media_type: string; data: string } }> }> };
    expect(userTurn).toBeDefined();
    const block = userTurn.content[0];
    expect(block.type).toBe("tool_result");
    const imageBlock = block.content.find((c) => c.type === "image");
    expect(imageBlock).toBeDefined();
    expect(imageBlock!.source!.media_type).toBe("image/png");
    expect(imageBlock!.source!.data).toBe(ONE_PIXEL_PNG.toString("base64"));
  });

  test("warns and defaults to image/png when mediaType is missing", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [{ name: "screenshot", description: "shoot", parameters: { type: "object" } }] },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "screenshot", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "screenshot", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "screenshot", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "screenshot", durationMs: 5, text: "", image: "screenshots/001.png", error: false },
    ]);
    cleanups.push(dir);
    writeScreenshot(dir, "001.png", ONE_PIXEL_PNG);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    expect(result.warnings.some((w) => w.includes("mediaType"))).toBe(true);
  });
});

describe("rebuildMessages — text rehydration", () => {
  test("reads the artifact when tool_result.textTruncated is true", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [{ name: "extract", description: "extract", parameters: { type: "object" } }] },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "extract", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "extract", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "extract", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "extract", durationMs: 5, text: "", textTruncated: true, textBytes: 1024, artifact: "artifacts/001.txt", error: false },
    ]);
    cleanups.push(dir);
    writeArtifact(dir, "001.txt", "THE FULL TEXT THE AGENT SAW");

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const userTurn = result.messages[result.messages.length - 1] as { content: Array<{ content: string }> };
    expect(userTurn.content[0].content).toBe("THE FULL TEXT THE AGENT SAW");
  });
});

describe("rebuildMessages — reflection checkpoint", () => {
  test("weaves the reflection reminder into the same user turn as tool_result (no separate user message)", () => {
    const dir = makeRunDir([
      { ...minimalRunStart, reflectionInterval: 1 },
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [{ name: "click", description: "click", parameters: { type: "object" } }] },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "click", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "click", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "click", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "click", durationMs: 5, text: "ok", error: false },
      { type: "event", name: "reflection_checkpoint", turn: 1, ordinal: 1, traceLength: 1 },
      { type: "user_message", turn: 1, content: "<SYSTEM-REMINDER> reflect now </SYSTEM-REMINDER>" },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const lastUser = result.messages[result.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; text?: string; tool_use_id?: string }>;
    };
    expect(lastUser.role).toBe("user");
    const types = lastUser.content.map((b) => b.type);
    expect(types).toContain("tool_result");
    expect(types).toContain("text");
    const textBlock = lastUser.content.find((b) => b.type === "text");
    expect(textBlock!.text).toContain("reflect now");
    const userTurns = result.messages.filter(
      (m) => (m as { role?: string }).role === "user",
    );
    expect(userTurns).toHaveLength(2);
  });
});

describe("rebuildMessages — deadline grace turn", () => {
  test("emits the deadline reminder as a standalone user message", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [] },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "end_turn", text: "looking",
        thinking: [], toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "text", text: "looking" }] },
      },
      { type: "event", name: "deadline_reminder", budgetMs: 60000, elapsedMs: 60001 },
      { type: "user_message", turn: 2, content: "<SYSTEM-REMINDER> time's up </SYSTEM-REMINDER>" },
      { type: "llm_response", turn: 2, stopReason: "tool_use", text: "",
        thinking: [], toolCalls: [{ id: "g1", name: "report_result", arguments: { status: "investigate", summary: "stuck", reasoning: "ran out", observations: [] } }], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "g1", name: "report_result", input: { status: "investigate", summary: "stuck", reasoning: "ran out", observations: [] } }] },
      },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const roles = result.messages.map((m) => (m as { role?: string }).role);
    // user(0), assistant(1), user(deadline reminder), assistant(2), then synthesized stub for g1
    expect(roles.slice(0, 4)).toEqual(["user", "assistant", "user", "assistant"]);
    const deadlineUser = result.messages[2] as { content: string };
    expect(deadlineUser.content).toContain("time's up");
  });
});

describe("rebuildMessages — terminal tool_use stub", () => {
  test("synthesizes a tool_result user turn for report_result on the final assistant message", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [{ name: "report_result", description: "report", parameters: { type: "object" } }] },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "Done.",
        thinking: [], toolCalls: [{ id: "rep1", name: "report_result", arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } }], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [
          { type: "text", text: "Done." },
          { type: "tool_use", id: "rep1", name: "report_result", input: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } },
        ]},
      },
      { type: "run_end", status: "pass", summary: "ok", reasoning: "ok", observationCount: 0, observations: [], durationMs: 100, usage: { inputTokens: 10, outputTokens: 5, turns: 1 } },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const last = result.messages[result.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; tool_use_id?: string; content?: string }>;
    };
    expect(last.role).toBe("user");
    expect(last.content[0].type).toBe("tool_result");
    expect(last.content[0].tool_use_id).toBe("rep1");
    expect(last.content[0].content).toContain("revival");
  });

  test("synthesizes stubs for multiple unmatched tool_use blocks (report_with_other_tools_dropped)", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [
        { name: "click", description: "click", parameters: { type: "object" } },
        { name: "report_result", description: "report", parameters: { type: "object" } },
      ]},
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "",
        thinking: [], toolCalls: [
          { id: "c1", name: "click", arguments: {} },
          { id: "rep1", name: "report_result", arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } },
        ], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [
          { type: "tool_use", id: "c1", name: "click", input: {} },
          { type: "tool_use", id: "rep1", name: "report_result", input: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } },
        ]},
      },
      { type: "event", name: "report_with_other_tools_dropped", dropped: ["click"] },
      { type: "run_end", status: "pass", summary: "ok", reasoning: "ok", observationCount: 0, observations: [], durationMs: 100, usage: { inputTokens: 10, outputTokens: 5, turns: 1 } },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const last = result.messages[result.messages.length - 1] as {
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    };
    const stubIds = last.content.map((b) => b.tool_use_id).sort();
    expect(stubIds).toEqual(["c1", "rep1"]);
  });
});

describe("rebuildMessages — TUI capture rehydration", () => {
  test("reads the .ansi file when capturePath is set", () => {
    const dir = makeRunDir([
      { ...minimalRunStart, adapter: "tui" },
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [{ name: "read_screen", description: "read", parameters: { type: "object" } }] },
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t1", name: "read_screen", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_screen", input: {} }] },
      },
      { type: "tool_call", turn: 1, toolUseId: "t1", name: "read_screen", arguments: {} },
      { type: "tool_result", turn: 1, toolUseId: "t1", name: "read_screen", durationMs: 5, text: "captures/000.ansi", capturePath: "captures/000.ansi", error: false },
    ]);
    cleanups.push(dir);
    writeCapture(dir, "000.ansi", "RAW ANSI SCREEN CONTENT");

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const userTurn = result.messages[result.messages.length - 1] as { content: Array<{ content: string }> };
    expect(userTurn.content[0].content).toBe("RAW ANSI SCREEN CONTENT");
  });
});
