import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  applyEvent,
  emptyTranscript,
  findSoftErrors,
  isSoftErrorResult,
  parseJsonl,
  reduceTranscript,
  turnsInOrder,
  totalUsage,
  type TranscriptEvent,
  type ToolCallEvent,
  type ToolResultEvent,
} from "../../ui/src/lib/transcript";

const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "ui",
  "src",
  "lib",
  "__fixtures__",
  "login-matt-001.jsonl",
);

describe("reduceTranscript", () => {
  test("empty input → empty model", () => {
    const model = reduceTranscript([]);
    expect(model.turns.size).toBe(0);
    expect(model.anomalies).toEqual([]);
    expect(model.ordered).toEqual([]);
    expect(model.runStart).toBeUndefined();
    expect(model.runEnd).toBeUndefined();
  });

  test("reduces the login-matt-001 fixture end-to-end", () => {
    const text = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseJsonl(text);

    // 104 events total, 1 run_start + 1 system_prompt + 1 user_message
    // + 25×(llm_request + llm_response + tool_call + tool_result) + 1 run_end
    // but turn 1 has 2 tool_calls and 2 tool_results, so:
    // 1 + 1 + 1 + 25 + 25 + 26 + 26 + 1 = wait let me just check length
    expect(events.length).toBe(104);

    const model = reduceTranscript(events);

    expect(model.runStart?.cardId).toBe("login-matt-001");
    expect(model.runStart?.model).toBe("claude-sonnet-4-6");
    expect(model.systemPrompt?.content.startsWith("You are a thorough QA tester")).toBe(true);
    expect(model.userMessage?.turn).toBe(0);
    expect(model.turns.size).toBe(25);
    expect(model.runEnd?.status).toBe("pass");
    expect(model.runEnd?.observationCount).toBe(4);

    const turn1 = model.turns.get(1)!;
    expect(turn1.tools.length).toBe(2);
    expect(turn1.tools[0].call.name).toBe("read");
    expect(turn1.tools[0].result?.text.length).toBeGreaterThan(0);
    expect(turn1.tools[1].call.name).toBe("read");

    // Turn 7 has the extract tool with an artifact.
    const turn7 = model.turns.get(7)!;
    expect(turn7.tools[0].call.name).toBe("extract");
    expect(turn7.tools[0].result?.artifact).toBe("artifacts/001.md");

    // Usage rolls up.
    const usage = totalUsage(model);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  test("idempotent: applying same events twice yields the same shape", () => {
    const text = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseJsonl(text);
    const once = reduceTranscript(events);
    // Apply again — nothing should change because eventId <= maxEventId.
    const twice = events.reduce(applyEvent, once);
    expect(twice.turns.size).toBe(once.turns.size);
    expect(twice.ordered.length).toBe(once.ordered.length);
    expect(twice.runEnd?.status).toBe(once.runEnd?.status);
  });

  test("out-of-order events: later event arriving first then earlier", () => {
    // Synthesise two events for turn 3.
    const a: TranscriptEvent = {
      eventId: 10,
      parentEventId: 9,
      ts: "2026-04-22T00:00:10Z",
      type: "llm_response",
      turn: 3,
      stopReason: "tool_use",
      text: "",
      thinking: [],
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 2 },
      rawAssistantMessage: null,
    };
    const b: TranscriptEvent = {
      eventId: 11,
      parentEventId: 10,
      ts: "2026-04-22T00:00:11Z",
      type: "tool_call",
      turn: 3,
      toolUseId: "toolu_x",
      name: "navigate",
      arguments: { url: "/login" },
    };
    const model = reduceTranscript([a, b]);
    expect(model.turns.get(3)!.tools.length).toBe(1);
    expect(model.turns.get(3)!.llmResponse).toBe(a);
  });

  test("tool_result without matching tool_call is dropped with warn", () => {
    const orphan: ToolResultEvent = {
      eventId: 5,
      parentEventId: 4,
      ts: "2026-04-22T00:00:05Z",
      type: "tool_result",
      turn: 1,
      toolUseId: "toolu_ghost",
      name: "read",
      durationMs: 1,
      text: "oops",
      image: null,
      artifact: null,
      error: false,
    };
    let warned = 0;
    const origWarn = console.warn;
    console.warn = () => { warned += 1; };
    try {
      const model = reduceTranscript([orphan]);
      expect(warned).toBe(1);
      // Result was not attached because there was no matching call.
      expect(model.turns.get(1)?.tools.length ?? 0).toBe(0);
    } finally {
      console.warn = origWarn;
    }
  });

  test("null image + null artifact parses cleanly", () => {
    const call: ToolCallEvent = {
      eventId: 1,
      parentEventId: 0,
      ts: "2026-04-22T00:00:00Z",
      type: "tool_call",
      turn: 1,
      toolUseId: "toolu_a",
      name: "read",
      arguments: {},
    };
    const result: ToolResultEvent = {
      eventId: 2,
      parentEventId: 1,
      ts: "2026-04-22T00:00:01Z",
      type: "tool_result",
      turn: 1,
      toolUseId: "toolu_a",
      name: "read",
      durationMs: 0,
      text: "hi",
      image: null,
      artifact: null,
      error: false,
    };
    const model = reduceTranscript([call, result]);
    const pair = model.turns.get(1)!.tools[0];
    expect(pair.result?.image).toBeNull();
    expect(pair.result?.artifact).toBeNull();
  });

  test("turnsInOrder returns turns sorted by number", () => {
    const events: TranscriptEvent[] = [3, 1, 2].map((t, i) => ({
      eventId: i + 1,
      parentEventId: i,
      ts: `2026-04-22T00:00:0${i}Z`,
      type: "llm_request",
      turn: t,
      messageCount: 1,
    }));
    const model = reduceTranscript(events);
    const ordered = turnsInOrder(model);
    expect(ordered.map((t) => t.turn)).toEqual([1, 2, 3]);
  });
});

describe("soft-error detection", () => {
  function mkResult(text: string, error = false): ToolResultEvent {
    return {
      eventId: 1, parentEventId: 0, ts: "x",
      type: "tool_result", turn: 1, toolUseId: "t", name: "read",
      durationMs: 0, text, image: null, artifact: null, error,
    };
  }

  test("matches common error prefixes", () => {
    expect(isSoftErrorResult(mkResult("Error: path must not contain .."))).toBe(true);
    expect(isSoftErrorResult(mkResult("error: something broke"))).toBe(true);
    expect(isSoftErrorResult(mkResult("Failed to navigate"))).toBe(true);
    expect(isSoftErrorResult(mkResult("Cannot read property"))).toBe(true);
    expect(isSoftErrorResult(mkResult("Could not find element"))).toBe(true);
    expect(isSoftErrorResult(mkResult("Unable to locate selector"))).toBe(true);
    expect(isSoftErrorResult(mkResult("   Error: leading whitespace"))).toBe(true);
  });

  test("does not match incidental uses", () => {
    expect(isSoftErrorResult(mkResult("ok"))).toBe(false);
    expect(isSoftErrorResult(mkResult("No error occurred"))).toBe(false);
    expect(isSoftErrorResult(mkResult("The error rate is 0.01%"))).toBe(false);
    expect(isSoftErrorResult(mkResult(""))).toBe(false);
  });

  test("does not flag hard errors (those render separately)", () => {
    expect(isSoftErrorResult(mkResult("Error: boom", true))).toBe(false);
  });

  test("findSoftErrors picks up the turn 8 fixture case", () => {
    const text = readFileSync(FIXTURE_PATH, "utf8");
    const events = parseJsonl(text);
    const model = reduceTranscript(events);
    const sites = findSoftErrors(model);
    // The agent tried read("../../artifacts/001.md") in turn 8 and the tool
    // returned "Error: path ... must not contain '..' segments".
    const turn8 = sites.find((s) => s.turn === 8);
    expect(turn8).toBeDefined();
    expect(turn8!.toolName).toBe("read");
    expect(turn8!.snippet.toLowerCase()).toContain("error");
  });
});

describe("parseJsonl", () => {
  test("skips empty lines and malformed JSON with warn", () => {
    let warned = 0;
    const origWarn = console.warn;
    console.warn = () => { warned += 1; };
    try {
      const events = parseJsonl(
        '{"eventId":1,"parentEventId":0,"ts":"x","type":"user_message","turn":0,"content":"hi"}\n' +
        '\n' +
        'not json\n' +
        '{"eventId":2,"parentEventId":1,"ts":"y","type":"run_end","status":"pass","summary":"","reasoning":"","observationCount":0,"durationMs":0,"usage":{"inputTokens":0,"outputTokens":0,"turns":0}}\n',
      );
      expect(events.length).toBe(2);
      expect(warned).toBe(1);
    } finally {
      console.warn = origWarn;
    }
  });

  test("skips objects without a type field", () => {
    let warned = 0;
    const origWarn = console.warn;
    console.warn = () => { warned += 1; };
    try {
      const events = parseJsonl('{"eventId":1}\n');
      expect(events.length).toBe(0);
      expect(warned).toBe(1);
    } finally {
      console.warn = origWarn;
    }
  });
});
