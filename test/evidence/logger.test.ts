import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { EvidenceLogger } from "../../src/evidence/logger";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("EvidenceLogger", () => {
  let outDir: string;
  let logger: EvidenceLogger;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "gauntlet-test-"));
    logger = new EvidenceLogger(outDir);
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  test("creates output directory structure", () => {
    expect(existsSync(join(outDir, "screenshots"))).toBe(true);
  });

  test("saves screenshot and returns path", () => {
    const fakePng = Buffer.from("fake-png-data");
    const path = logger.saveScreenshot(fakePng, "step-001");

    expect(path).toBe("screenshots/step-001.png");
    expect(
      readFileSync(join(outDir, "screenshots", "step-001.png"))
    ).toEqual(fakePng);
  });

  test("tracks screenshot list", () => {
    logger.saveScreenshot(Buffer.from("a"), "step-001");
    logger.saveScreenshot(Buffer.from("b"), "step-002");

    expect(logger.screenshots).toEqual([
      "screenshots/step-001.png",
      "screenshots/step-002.png",
    ]);
  });

  test("auto-increments screenshot names", () => {
    const p1 = logger.saveScreenshot(Buffer.from("a"));
    const p2 = logger.saveScreenshot(Buffer.from("b"));

    expect(p1).toBe("screenshots/001.png");
    expect(p2).toBe("screenshots/002.png");
  });

  test("addProgressObserver receives events when logEvent is called", () => {
    const received: { action: string; params: Record<string, unknown> }[] = [];
    logger.addProgressObserver((action, params) => {
      received.push({ action, params });
    });

    logger.logEvent("click", { selector: "#btn" });
    logger.logEvent("screenshot", {});

    expect(received).toEqual([
      { action: "click", params: { selector: "#btn" } },
      { action: "screenshot", params: {} },
    ]);
  });

  test("works with no observers registered", () => {
    // Should not throw
    logger.logEvent("click", { selector: "#btn" });
  });

  test("addProgressObserver returns an unsubscribe function that removes the observer", () => {
    const received: string[] = [];
    const unsubscribe = logger.addProgressObserver((action) => {
      received.push(action);
    });

    logger.logEvent("first", {});
    unsubscribe();
    logger.logEvent("second", {});

    expect(received).toEqual(["first"]);
  });

  test("two observers both receive the action", () => {
    const a: string[] = [];
    const b: string[] = [];
    logger.addProgressObserver((action) => a.push(action));
    logger.addProgressObserver((action) => b.push(action));

    logger.logEvent("click", { selector: "#btn" });

    expect(a).toEqual(["click"]);
    expect(b).toEqual(["click"]);
  });

  test("an observer that throws doesn't prevent other observers from receiving the action", () => {
    const received: string[] = [];
    logger.addProgressObserver(() => {
      throw new Error("boom");
    });
    logger.addProgressObserver((action) => {
      received.push(action);
    });

    logger.logEvent("click", { selector: "#btn" });

    expect(received).toEqual(["click"]);
  });

  test("logToolCall notifies observers with (name, arguments) for live feeds", () => {
    const received: { name: string; args: Record<string, unknown> }[] = [];
    logger.addProgressObserver((name, args) => {
      received.push({ name, args });
    });

    logger.logToolCall({
      turn: 1,
      toolUseId: "t1",
      name: "navigate",
      arguments: { url: "http://localhost:3000" },
    });

    expect(received).toEqual([
      { name: "navigate", args: { url: "http://localhost:3000" } },
    ]);
  });

  test("logRunStart writes the first event with eventId 1 and parentEventId 0", () => {
    logger.logRunStart({
      runId: "card-001_20260421T000000Z_aaaa",
      cardId: "card-001",
      target: "http://localhost:3000",
      provider: "anthropic",
      model: "claude-opus-4-7",
      adapter: "web",
      budgetMs: 300_000,
      toolTimeoutMs: 30000,
      contextTreeBytes: 0,
    });

    const [row] = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(row.type).toBe("run_start");
    expect(row.eventId).toBe(1);
    expect(row.parentEventId).toBe(0);
    expect(row.ts).toBeDefined();
    expect(row.runId).toBe("card-001_20260421T000000Z_aaaa");
    expect(row.cardId).toBe("card-001");
    expect(row.provider).toBe("anthropic");
    expect(row.budgetMs).toBe(300_000);
  });

  test("each subsequent event chains parentEventId to the previous eventId", () => {
    logger.logSystemPrompt("be helpful");
    logger.logUserMessage(0, "go");
    logger.logEvent("custom", { foo: 1 });

    const rows = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(rows.map((r) => r.eventId)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.parentEventId)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.type)).toEqual([
      "system_prompt",
      "user_message",
      "event",
    ]);
  });

  test("logEvent emits an event row with the name and params inlined", () => {
    logger.logEvent("navigate", { url: "http://localhost:3000" });

    const [row] = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(row.type).toBe("event");
    expect(row.name).toBe("navigate");
    expect(row.url).toBe("http://localhost:3000");
  });

  test("logBrowserEvent writes to a per-category jsonl file", () => {
    logger.logBrowserEvent("console", { level: "log", text: "hello" });
    logger.logBrowserEvent("console", { level: "error", text: "bang" });

    const lines = readFileSync(join(outDir, "console.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(lines).toHaveLength(2);
    expect(lines[0].category).toBe("console");
    expect(lines[0].level).toBe("log");
    expect(lines[0].text).toBe("hello");
    expect(lines[0].timestamp).toBeDefined();
    expect(lines[1].level).toBe("error");
  });

  test("logBrowserEvent routes different categories to different files", () => {
    logger.logBrowserEvent("console", { text: "c" });
    logger.logBrowserEvent("exception", { text: "e" });
    logger.logBrowserEvent("log", { text: "l" });
    logger.logBrowserEvent("network-ws", { text: "n" });

    expect(existsSync(join(outDir, "console.jsonl"))).toBe(true);
    expect(existsSync(join(outDir, "exception.jsonl"))).toBe(true);
    expect(existsSync(join(outDir, "log.jsonl"))).toBe(true);
    expect(existsSync(join(outDir, "network-ws.jsonl"))).toBe(true);
  });

  test("logToolResult spills oversize text to an artifact and writes tool_result before diagnostic event", () => {
    const bigText = "x".repeat(40_000);
    logger.logToolResult({
      turn: 1,
      toolUseId: "tu-1",
      name: "extract",
      durationMs: 100,
      text: bigText,
      error: false,
    });

    const rows = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    // First row should be the tool_result
    const resultRow = rows[0];
    expect(resultRow.type).toBe("tool_result");
    expect(resultRow.textTruncated).toBe(true);
    expect(resultRow.textBytes).toBe(Buffer.byteLength(bigText, "utf8"));
    expect(resultRow.artifact).toMatch(/^artifacts\/\d+\.txt$/);
    // `text` is dropped (empty) on spill — the structured fields
    // carry everything consumers need. No dangling artifact path
    // left in the text field that could confuse any reader.
    expect(resultRow.text).toBe("");

    // Artifact file should exist and contain the full original text
    expect(existsSync(join(outDir, resultRow.artifact))).toBe(true);
    expect(readFileSync(join(outDir, resultRow.artifact), "utf-8")).toBe(bigText);

    // Second row should be the diagnostic event
    const eventRow = rows[1];
    expect(eventRow.type).toBe("event");
    expect(eventRow.name).toBe("tool_result_text_oversize");
  });

  test("addEventObserver fires for every logXxx call with the full entry", () => {
    const received: Array<Record<string, unknown>> = [];
    logger.addEventObserver((event) => {
      received.push(event);
    });

    logger.logRunStart({
      runId: "card-001_20260421T000000Z_aaaa",
      cardId: "card-001",
      target: "http://localhost:3000",
      provider: "anthropic",
      model: "claude-opus-4-7",
      adapter: "web",
      budgetMs: 300_000,
      toolTimeoutMs: 30000,
      contextTreeBytes: 0,
    });
    logger.logSystemPrompt("be helpful");
    logger.logUserMessage(0, "go");
    logger.logEvent("custom", { foo: 1 });

    expect(received).toHaveLength(4);

    // Every entry has the BaseEvent envelope fields.
    for (const e of received) {
      expect(typeof e.eventId).toBe("number");
      expect(typeof e.parentEventId).toBe("number");
      expect(typeof e.ts).toBe("string");
      expect(typeof e.type).toBe("string");
    }

    // Envelope content matches what the writer put on disk.
    expect(received[0]!.type).toBe("run_start");
    expect(received[0]!.eventId).toBe(1);
    expect(received[0]!.parentEventId).toBe(0);
    expect(received[0]!.runId).toBe("card-001_20260421T000000Z_aaaa");
    expect(received[0]!.provider).toBe("anthropic");

    expect(received[1]!.type).toBe("system_prompt");
    expect(received[1]!.eventId).toBe(2);
    expect(received[1]!.parentEventId).toBe(1);
    expect(received[1]!.content).toBe("be helpful");

    expect(received[2]!.type).toBe("user_message");
    expect(received[2]!.content).toBe("go");

    expect(received[3]!.type).toBe("event");
    expect(received[3]!.name).toBe("custom");
    expect(received[3]!.foo).toBe(1);
  });

  test("addEventObserver delivers the same object that was appended to run.jsonl", () => {
    const received: Array<Record<string, unknown>> = [];
    logger.addEventObserver((event) => {
      received.push(event);
    });

    logger.logEvent("navigate", { url: "http://localhost:3000" });

    const [onDisk] = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(onDisk);
  });

  test("addEventObserver returns an unsubscribe that removes the observer", () => {
    const received: Array<Record<string, unknown>> = [];
    const unsubscribe = logger.addEventObserver((event) => {
      received.push(event);
    });

    logger.logEvent("first", {});
    unsubscribe();
    logger.logEvent("second", {});

    expect(received).toHaveLength(1);
    expect(received[0]!.name).toBe("first");
  });

  test("a throwing event-observer doesn't prevent other event-observers from firing", () => {
    const received: Array<Record<string, unknown>> = [];
    logger.addEventObserver(() => {
      throw new Error("boom");
    });
    logger.addEventObserver((event) => {
      received.push(event);
    });

    logger.logEvent("click", { selector: "#btn" });

    expect(received).toHaveLength(1);
    expect(received[0]!.name).toBe("click");
  });

  test("addEventObserver and addProgressObserver fire independently on the same logger", () => {
    const actionEvents: Array<{ action: string }> = [];
    const fullEvents: Array<Record<string, unknown>> = [];
    logger.addProgressObserver((action) => { actionEvents.push({ action }); });
    logger.addEventObserver((event) => { fullEvents.push(event); });

    logger.logToolCall({
      turn: 1,
      toolUseId: "t1",
      name: "navigate",
      arguments: { url: "/" },
    });

    // Action channel: legacy (name, args) shape preserved.
    expect(actionEvents).toEqual([{ action: "navigate" }]);
    // Event channel: full structured entry.
    expect(fullEvents).toHaveLength(1);
    expect(fullEvents[0]!.type).toBe("tool_call");
    expect(fullEvents[0]!.toolUseId).toBe("t1");
    expect(fullEvents[0]!.name).toBe("navigate");
  });

  test("saveCapture writes .ansi and .json files, zero-indexed and padded", () => {
    const first = logger.saveCapture("raw-ansi-1", JSON.stringify({ a: 1 }));
    const second = logger.saveCapture("raw-ansi-2", JSON.stringify({ a: 2 }));

    expect(first).toBe("captures/000.ansi");
    expect(second).toBe("captures/001.ansi");
    expect(readFileSync(join(outDir, "captures/000.ansi"), "utf-8")).toBe("raw-ansi-1");
    expect(readFileSync(join(outDir, "captures/000.json"), "utf-8")).toBe(JSON.stringify({ a: 1 }));
    expect(readFileSync(join(outDir, "captures/001.ansi"), "utf-8")).toBe("raw-ansi-2");
    expect(logger.captures).toEqual(["captures/000.ansi", "captures/001.ansi"]);
  });

  test("logToolResult with capturePath replaces text with the path on disk", () => {
    const path = logger.saveCapture("huge-ansi-blob", "{}");
    logger.logToolResult({
      turn: 1,
      toolUseId: "tu-1",
      name: "read_screen",
      durationMs: 4,
      text: "huge-ansi-blob", // what the LLM sees; not written to jsonl
      capturePath: path,
      error: false,
    });
    const [row] = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(row.type).toBe("tool_result");
    expect(row.text).toBe("captures/000.ansi");
    expect(row.capturePath).toBe("captures/000.ansi");
    // Oversize-spill heuristic does not apply to captures.
    expect(row.textTruncated).toBeUndefined();
    expect(row.artifact).toBeUndefined();
  });

  test("logToolCall writes a tool_call row with expected fields", () => {
    logger.logToolCall({
      turn: 1,
      toolUseId: "t1",
      name: "navigate",
      arguments: { url: "/" },
    });

    const [row] = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(row.type).toBe("tool_call");
    expect(row.toolUseId).toBe("t1");
    expect(row.name).toBe("navigate");
    expect(row.arguments.url).toBe("/");
  });

  test("logToolDefinitions writes a tool_definitions event with the full tools array", () => {
    logger.logSystemPrompt("hello system");
    logger.logToolDefinitions([
      { name: "click", description: "Click", parameters: { type: "object" } },
      { name: "report_result", description: "Report", parameters: { type: "object" } },
    ]);

    const rows = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    const evt = rows.find((r) => r.type === "tool_definitions");
    expect(evt).toBeDefined();
    expect(evt.tools).toHaveLength(2);
    expect(evt.tools[0].name).toBe("click");
    expect(evt.tools[1].name).toBe("report_result");
    // parentEventId chains after the system_prompt event
    const sysRow = rows.find((r) => r.type === "system_prompt");
    expect(evt.parentEventId).toBe(sysRow.eventId);
  });

  test("logToolResult prefers transcriptText over text when both are set", () => {
    logger.logToolResult({
      turn: 1,
      toolUseId: "tu-1",
      name: "fetch_credential",
      durationMs: 5,
      text: "raw-secret-value",
      transcriptText: "<credential redacted: entity=alice key=otp len=16>",
      error: false,
    });

    const rows = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const row = rows[0];
    expect(row.type).toBe("tool_result");
    expect(row.text).toBe("<credential redacted: entity=alice key=otp len=16>");
    // The recorded row should not leak the raw text anywhere.
    expect(JSON.stringify(row)).not.toContain("raw-secret-value");
  });

  test("logToolResult uses text as before when transcriptText is absent", () => {
    logger.logToolResult({
      turn: 1,
      toolUseId: "tu-1",
      name: "read",
      durationMs: 5,
      text: "ordinary tool output",
      error: false,
    });
    const rows = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows[0].text).toBe("ordinary tool output");
  });

  test("logToolResult records optional mediaType for images", () => {
    logger.logToolResult({
      turn: 1,
      toolUseId: "tu_1",
      name: "screenshot",
      durationMs: 12,
      text: "",
      image: "screenshots/001.png",
      mediaType: "image/png",
      error: false,
    });

    const row = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((r) => r.type === "tool_result");

    expect(row.mediaType).toBe("image/png");
    expect(row.image).toBe("screenshots/001.png");
  });
});
