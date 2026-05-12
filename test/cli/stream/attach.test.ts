import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { EvidenceLogger } from "../../../src/evidence/logger";
import { attachRenderer } from "../../../src/cli/stream/attach";

describe("attachRenderer", () => {
  let outDir: string;
  let logger: EvidenceLogger;
  let captured = "";
  const sink = { write: (s: string) => { captured += s; } };

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), "gauntlet-stream-"));
    logger = new EvidenceLogger(outDir);
    captured = "";
  });

  afterEach(() => rmSync(outDir, { recursive: true, force: true }));

  test("silent=true attaches no observer — nothing written to sink", () => {
    const cleanup = attachRenderer(logger, { silent: true, format: "pretty", color: false, columns: 100 }, sink);
    logger.logEvent("x", { a: 1 });
    cleanup();
    expect(captured).toBe("");
  });

  test("format=jsonl produces one JSON line per event", () => {
    const cleanup = attachRenderer(logger, { silent: false, format: "jsonl", color: false, columns: 100 }, sink);
    logger.logEvent("tick", { n: 1 });
    logger.logEvent("tick", { n: 2 });
    cleanup();
    const lines = captured.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    const p1 = JSON.parse(lines[0]);
    expect(p1.type).toBe("event");
    expect(p1.name).toBe("tick");
  });

  test("format=pretty writes something human-readable for run_start", () => {
    const cleanup = attachRenderer(logger, { silent: false, format: "pretty", color: false, columns: 100 }, sink);
    logger.logRunStart({ runId: "r1", cardId: "c", target: "t", provider: "a", model: "m", adapter: "web", budgetMs: 300_000, maxStuckRetries: 5, toolTimeoutMs: 1, contextTreeBytes: 0 });
    cleanup();
    expect(captured).toContain("runId");
    expect(captured).toContain("r1");
  });

  test("cleanup stops further writes", () => {
    const cleanup = attachRenderer(logger, { silent: false, format: "jsonl", color: false, columns: 100 }, sink);
    cleanup();
    logger.logEvent("after", {});
    expect(captured).toBe("");
  });
});
