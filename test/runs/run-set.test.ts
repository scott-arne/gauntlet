import { describe, test, expect } from "bun:test";
import { mkdtempSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runRunSet } from "../../src/runs/run-set";
import type { VetResult } from "../../src/types";
import type { RunSetCtx } from "../../src/runs/run-set-types";

const baseConfig = (overrides = {}) => ({
  resultsRoot: mkdtempSync(join(tmpdir(), "gauntlet-runset-")),
  cards: ["card-a"],
  passes: 1,
  kind: "single" as const,
  generateRunId: (cardId: string, i: number) => `${cardId}_t${i}_x000`,
  ...overrides,
});

const fakeResult = (status: VetResult["status"]): VetResult => ({
  schemaVersion: 2,
  runId: "x",
  scenario: "x",
  status,
  summary: "",
  reasoning: "",
  observations: [],
  evidence: { screenshots: [], log: "run.jsonl" },
  duration_ms: 1000,
  usage: { inputTokens: 0, outputTokens: 0, turns: 5 },
});

describe("runRunSet — orchestrator loop", () => {
  test("executes all attempts of one card in order", async () => {
    const cfg = baseConfig({ passes: 3 });
    const calls: Array<{ cardId: string; ctx: RunSetCtx }> = [];
    const result = await runRunSet({
      ...cfg,
      executor: async ({ cardId, runSetCtx }) => {
        calls.push({ cardId, ctx: runSetCtx });
        return { runId: runSetCtx.runSetId + "/x", outDir: "x", result: fakeResult("pass") };
      },
    });

    expect(calls).toHaveLength(3);
    expect(calls[0].ctx.attemptNumber).toBe(1);
    expect(calls[1].ctx.attemptNumber).toBe(2);
    expect(calls[2].ctx.attemptNumber).toBe(3);
    expect(result.summary?.overall.overallStatus).toBe("consistent_pass");
  });

  test("card-major serial: card[0] all attempts before card[1]", async () => {
    const cfg = baseConfig({ cards: ["a", "b"], passes: 2, kind: "batch" as const });
    const order: string[] = [];
    await runRunSet({
      ...cfg,
      executor: async ({ cardId, runSetCtx }) => {
        order.push(`${cardId}/${runSetCtx.attemptNumber}`);
        return { runId: "x", outDir: "x", result: fakeResult("pass") };
      },
    });
    expect(order).toEqual(["a/1", "a/2", "b/1", "b/2"]);
  });

  test("an attempt that throws is recorded as errored; loop continues", async () => {
    const cfg = baseConfig({ passes: 3 });
    const result = await runRunSet({
      ...cfg,
      executor: async ({ runSetCtx }) => {
        if (runSetCtx.attemptNumber === 2) throw new Error("kapow");
        return { runId: "x", outDir: "x", result: fakeResult("pass") };
      },
    });
    expect(result.summary?.perCard[0].byStatus.pass).toBe(2);
    expect(result.summary?.perCard[0].byStatus.errored).toBe(1);
    expect(result.summary?.perCard[0].cardStatus).toBe("mixed_with_errors");
  });

  test("writes set.json and summary.md", async () => {
    const cfg = baseConfig({ passes: 2 });
    const result = await runRunSet({
      ...cfg,
      executor: async () => ({ runId: "x", outDir: "x", result: fakeResult("pass") }),
    });
    expect(existsSync(join(cfg.resultsRoot, "run-sets", result.runSetId, "set.json"))).toBe(true);
    expect(existsSync(join(cfg.resultsRoot, "run-sets", result.runSetId, "summary.md"))).toBe(true);
  });

  test("cancel signal aborts after current attempt; remaining attempts marked cancelled", async () => {
    const cfg = baseConfig({ passes: 4 });
    const cancelToken = { cancelled: false };
    const result = await runRunSet({
      ...cfg,
      cancelToken,
      executor: async ({ runSetCtx }) => {
        if (runSetCtx.attemptNumber === 2) cancelToken.cancelled = true; // simulate cancel during attempt 2
        return { runId: "x", outDir: "x", result: fakeResult("pass") };
      },
    });
    // Attempts 1 and 2 completed (pass); 3 and 4 cancelled.
    expect(result.summary?.perCard[0].byStatus.pass).toBe(2);
    expect(result.summary?.perCard[0].byStatus.cancelled).toBe(2);
  });
});
