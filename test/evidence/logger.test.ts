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

  test("addObserver receives actions when logAction is called", () => {
    const received: { action: string; params: Record<string, unknown> }[] = [];
    logger.addObserver((action, params) => {
      received.push({ action, params });
    });

    logger.logAction("click", { selector: "#btn" });
    logger.logAction("screenshot", {});

    expect(received).toEqual([
      { action: "click", params: { selector: "#btn" } },
      { action: "screenshot", params: {} },
    ]);
  });

  test("works with no observers registered", () => {
    // Should not throw
    logger.logAction("click", { selector: "#btn" });
  });

  test("addObserver returns an unsubscribe function that removes the observer", () => {
    const received: string[] = [];
    const unsubscribe = logger.addObserver((action) => {
      received.push(action);
    });

    logger.logAction("first", {});
    unsubscribe();
    logger.logAction("second", {});

    expect(received).toEqual(["first"]);
  });

  test("two observers both receive the action", () => {
    const a: string[] = [];
    const b: string[] = [];
    logger.addObserver((action) => a.push(action));
    logger.addObserver((action) => b.push(action));

    logger.logAction("click", { selector: "#btn" });

    expect(a).toEqual(["click"]);
    expect(b).toEqual(["click"]);
  });

  test("an observer that throws doesn't prevent other observers from receiving the action", () => {
    const received: string[] = [];
    logger.addObserver(() => {
      throw new Error("boom");
    });
    logger.addObserver((action) => {
      received.push(action);
    });

    logger.logAction("click", { selector: "#btn" });

    expect(received).toEqual(["click"]);
  });

  test("logRunStart writes the first event with eventId 1 and parentEventId 0", () => {
    logger.logRunStart({
      runId: "card-001_20260421T000000Z_aaaa",
      cardId: "card-001",
      target: "http://localhost:3000",
      provider: "anthropic",
      model: "claude-opus-4-7",
      adapter: "web",
      maxTurns: 50,
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
    expect(row.maxTurns).toBe(50);
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

  test("logAction emits an event row with the action as the name", () => {
    logger.logAction("navigate", { url: "http://localhost:3000" });

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

    // Artifact file should exist and contain the full original text
    expect(existsSync(join(outDir, resultRow.artifact))).toBe(true);
    expect(readFileSync(join(outDir, resultRow.artifact), "utf-8")).toBe(bigText);

    // Second row should be the diagnostic event
    const eventRow = rows[1];
    expect(eventRow.type).toBe("event");
    expect(eventRow.name).toBe("tool_result_text_oversize");
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
});
