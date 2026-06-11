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

describe("rebuildMessages — recovery-turn fidelity", () => {
  test("a max_tokens recovery turn replays the stub, then the nudge — not the truncated raw (PRI-2160)", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [
        { name: "click", description: "Click", parameters: { type: "object" } },
      ]},
      { type: "user_message", turn: 0, content: "go" },
      // Turn 1: truncated mid-thinking; the live loop discarded it,
      // pushed a stub, and nudged.
      { type: "llm_response", turn: 1, stopReason: "max_tokens", text: "I was reasoning at len", thinking: [],
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 4096 },
        rawAssistantMessage: { role: "assistant", content: [
          { type: "text", text: "I was reasoning at len" },
        ]},
      },
      { type: "event", name: "stopped_max_tokens", turn: 1, hasText: true, toolCallCount: 0, recovery: true },
      { type: "user_message", turn: 1, content: "<SYSTEM-REMINDER>cut off; be concise</SYSTEM-REMINDER>" },
      // Turn 2: recovered with a normal tool call.
      { type: "llm_response", turn: 2, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t2", name: "click", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "click", input: {} }] },
      },
      { type: "tool_call", turn: 2, toolUseId: "t2", name: "click", arguments: {} },
      { type: "tool_result", turn: 2, toolUseId: "t2", name: "click", durationMs: 5, text: "ok", error: false },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const flat = JSON.stringify(result.messages);
    // Stub replaces the truncated content...
    expect(flat).toContain("truncated by the output token limit");
    expect(flat).not.toContain("I was reasoning at len");
    // ...and comes BEFORE the nudge (assistant then user), matching the
    // live conversation order.
    const stubIdx = result.messages.findIndex((m) => JSON.stringify(m).includes("truncated by the output token limit"));
    const nudgeIdx = result.messages.findIndex((m) => JSON.stringify(m).includes("cut off; be concise"));
    expect(stubIdx).toBeGreaterThanOrEqual(0);
    expect(nudgeIdx).toBe(stubIdx + 1);
  });

  test("an empty-response nudge turn replays the filled stub, then the nudge (PRI-1864)", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [
        { name: "click", description: "Click", parameters: { type: "object" } },
      ]},
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "end_turn", text: "", thinking: [],
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 0 },
        rawAssistantMessage: { role: "assistant", content: [] },
      },
      { type: "event", name: "empty_response_nudge", turn: 1, stopReason: "end_turn" },
      { type: "user_message", turn: 1, content: "<SYSTEM-REMINDER>empty turn nudge</SYSTEM-REMINDER>" },
      { type: "llm_response", turn: 2, stopReason: "tool_use", text: "", thinking: [],
        toolCalls: [{ id: "t2", name: "click", arguments: {} }],
        usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "click", input: {} }] },
      },
      { type: "tool_call", turn: 2, toolUseId: "t2", name: "click", arguments: {} },
      { type: "tool_result", turn: 2, toolUseId: "t2", name: "click", durationMs: 5, text: "ok", error: false },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const stubIdx = result.messages.findIndex((m) => JSON.stringify(m).includes("(empty turn)"));
    const nudgeIdx = result.messages.findIndex((m) => JSON.stringify(m).includes("empty turn nudge"));
    expect(stubIdx).toBeGreaterThanOrEqual(0);
    expect(nudgeIdx).toBe(stubIdx + 1);
  });

  test("a grace turn whose response happens to be empty keeps the user-before-assistant order", () => {
    // Same log shape as an empty-response nudge (user_message, empty
    // llm_response, no tool rows) but WITHOUT the empty_response_nudge
    // event — this is the deadline reminder followed by a (useless)
    // empty final response. Live order: reminder THEN assistant.
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      { type: "tool_definitions", tools: [
        { name: "click", description: "Click", parameters: { type: "object" } },
      ]},
      { type: "user_message", turn: 0, content: "go" },
      { type: "user_message", turn: 1, content: "<SYSTEM-REMINDER>time budget reminder</SYSTEM-REMINDER>" },
      { type: "llm_response", turn: 1, stopReason: "end_turn", text: "", thinking: [],
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 0 },
        rawAssistantMessage: { role: "assistant", content: [] },
      },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const flat = JSON.stringify(result.messages);
    // No synthesized stub: this is the grace shape, reminder first.
    expect(flat).not.toContain("(empty turn)");
    const reminderIdx = result.messages.findIndex((m) => JSON.stringify(m).includes("time budget reminder"));
    expect(reminderIdx).toBe(1); // right after the initial user message
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

describe("rebuildMessages — old-run fallback", () => {
  test("falls back to live adapter.toolDefinitions() + REPORT_TOOL with a drift warning", () => {
    const dir = makeRunDir([
      minimalRunStart,
      { type: "system_prompt", content: "sys" },
      // intentionally no tool_definitions event
      { type: "user_message", turn: 0, content: "go" },
      { type: "llm_response", turn: 1, stopReason: "end_turn", text: "hi",
        thinking: [], toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 },
        rawAssistantMessage: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      },
    ]);
    cleanups.push(dir);

    const result = rebuildMessages(dir, makeFakeAnthropicClient());
    const toolNames = result.toolDefs.map((t) => t.name);
    expect(toolNames).toContain("report_result");
    expect(toolNames.length).toBeGreaterThan(1);
    expect(result.warnings.some((w) => w.toLowerCase().includes("drift"))).toBe(true);
    expect(result.systemPrompt).toContain("fallback");
  });

  test("errors with a clear message when the recorded adapter is no longer registered", () => {
    const dir = makeRunDir([
      { ...minimalRunStart, adapter: "nonexistent-adapter" },
      { type: "system_prompt", content: "sys" },
      { type: "user_message", turn: 0, content: "go" },
    ]);
    cleanups.push(dir);
    expect(() => rebuildMessages(dir, makeFakeAnthropicClient())).toThrow(/not registered|no longer/i);
  });
});

describe("rebuildMessages — --turn cutoff", () => {
  const events3turn = [
    minimalRunStart,
    { type: "system_prompt", content: "sys" },
    { type: "tool_definitions", tools: [
      { name: "click", description: "click", parameters: { type: "object" } },
      { name: "report_result", description: "report", parameters: { type: "object" } },
    ]},
    { type: "user_message", turn: 0, content: "go" },
    { type: "llm_response", turn: 1, stopReason: "tool_use", text: "", thinking: [],
      toolCalls: [{ id: "t1", name: "click", arguments: {} }], usage: { inputTokens: 10, outputTokens: 5 },
      rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "click", input: {} }] } },
    { type: "tool_call", turn: 1, toolUseId: "t1", name: "click", arguments: {} },
    { type: "tool_result", turn: 1, toolUseId: "t1", name: "click", durationMs: 5, text: "ok", error: false },
    { type: "llm_response", turn: 2, stopReason: "tool_use", text: "", thinking: [],
      toolCalls: [{ id: "t2", name: "click", arguments: {} }], usage: { inputTokens: 10, outputTokens: 5 },
      rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "click", input: {} }] } },
    { type: "tool_call", turn: 2, toolUseId: "t2", name: "click", arguments: {} },
    { type: "tool_result", turn: 2, toolUseId: "t2", name: "click", durationMs: 5, text: "ok", error: false },
    { type: "llm_response", turn: 3, stopReason: "tool_use", text: "", thinking: [],
      toolCalls: [{ id: "rep1", name: "report_result", arguments: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } }], usage: { inputTokens: 10, outputTokens: 5 },
      rawAssistantMessage: { role: "assistant", content: [{ type: "tool_use", id: "rep1", name: "report_result", input: { status: "pass", summary: "ok", reasoning: "ok", observations: [] } }] } },
    { type: "run_end", status: "pass", summary: "ok", reasoning: "ok", observationCount: 0, observations: [], durationMs: 100, usage: { inputTokens: 10, outputTokens: 5, turns: 3 } },
  ];

  test("--turn 0 yields only the initial user message", () => {
    const dir = makeRunDir(events3turn);
    cleanups.push(dir);
    const result = rebuildMessages(dir, makeFakeAnthropicClient(), 0);
    expect(result.messages).toHaveLength(1);
    expect((result.messages[0] as { role: string }).role).toBe("user");
  });

  test("--turn 1 includes turn 1 assistant + tool result", () => {
    const dir = makeRunDir(events3turn);
    cleanups.push(dir);
    const result = rebuildMessages(dir, makeFakeAnthropicClient(), 1);
    const roles = result.messages.map((m) => (m as { role?: string }).role);
    expect(roles).toEqual(["user", "assistant", "user"]);
  });

  test("--turn 2 includes turns 1 and 2 but NOT turn 3 report_result", () => {
    const dir = makeRunDir(events3turn);
    cleanups.push(dir);
    const result = rebuildMessages(dir, makeFakeAnthropicClient(), 2);
    const assistantTurns = result.messages.filter(
      (m) => (m as { role?: string }).role === "assistant",
    );
    expect(assistantTurns).toHaveLength(2);
    const last = result.messages[result.messages.length - 1] as { role: string };
    expect(last.role).toBe("user");
  });

  test("--turn out of range errors clearly", () => {
    const dir = makeRunDir(events3turn);
    cleanups.push(dir);
    expect(() => rebuildMessages(dir, makeFakeAnthropicClient(), 99)).toThrow(/out of range|ended at turn 3/);
  });
});
