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

  test("logs actions to run.jsonl", () => {
    logger.logAction("navigate", { url: "http://localhost:3000" });
    logger.logAction("click", { selector: "#add-btn" });

    const lines = readFileSync(join(outDir, "run.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(lines).toHaveLength(2);
    expect(lines[0].action).toBe("navigate");
    expect(lines[0].params.url).toBe("http://localhost:3000");
    expect(lines[0].timestamp).toBeDefined();
    expect(lines[1].action).toBe("click");
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

  test("calls onAction callback when logAction is called", () => {
    const received: { action: string; params: Record<string, unknown> }[] = [];
    logger.onAction = (action, params) => {
      received.push({ action, params });
    };

    logger.logAction("click", { selector: "#btn" });
    logger.logAction("screenshot", {});

    expect(received).toEqual([
      { action: "click", params: { selector: "#btn" } },
      { action: "screenshot", params: {} },
    ]);
  });

  test("works without onAction callback", () => {
    // Should not throw
    logger.logAction("click", { selector: "#btn" });
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
});
