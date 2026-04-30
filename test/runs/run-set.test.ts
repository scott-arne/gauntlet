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
    const handle = await runRunSet({
      ...cfg,
      executor: async ({ cardId, runSetCtx }) => {
        calls.push({ cardId, ctx: runSetCtx });
        return { runId: runSetCtx.runSetId + "/x", outDir: "x", result: fakeResult("pass") };
      },
    });
    const result = await handle.completion;

    expect(calls).toHaveLength(3);
    expect(calls[0].ctx.attemptNumber).toBe(1);
    expect(calls[1].ctx.attemptNumber).toBe(2);
    expect(calls[2].ctx.attemptNumber).toBe(3);
    expect(result.summary?.overall.overallStatus).toBe("consistent_pass");
  });

  test("card-major serial: card[0] all attempts before card[1]", async () => {
    const cfg = baseConfig({ cards: ["a", "b"], passes: 2, kind: "batch" as const });
    const order: string[] = [];
    const handle = await runRunSet({
      ...cfg,
      executor: async ({ cardId, runSetCtx }) => {
        order.push(`${cardId}/${runSetCtx.attemptNumber}`);
        return { runId: "x", outDir: "x", result: fakeResult("pass") };
      },
    });
    await handle.completion;
    expect(order).toEqual(["a/1", "a/2", "b/1", "b/2"]);
  });

  test("an attempt that throws is recorded as errored; loop continues", async () => {
    const cfg = baseConfig({ passes: 3 });
    const handle = await runRunSet({
      ...cfg,
      executor: async ({ runSetCtx }) => {
        if (runSetCtx.attemptNumber === 2) throw new Error("kapow");
        return { runId: "x", outDir: "x", result: fakeResult("pass") };
      },
    });
    const result = await handle.completion;
    expect(result.summary?.perCard[0].byStatus.pass).toBe(2);
    expect(result.summary?.perCard[0].byStatus.errored).toBe(1);
    expect(result.summary?.perCard[0].cardStatus).toBe("mixed_with_errors");
  });

  test("writes set.json and summary.md", async () => {
    const cfg = baseConfig({ passes: 2 });
    const handle = await runRunSet({
      ...cfg,
      executor: async () => ({ runId: "x", outDir: "x", result: fakeResult("pass") }),
    });
    const result = await handle.completion;
    expect(existsSync(join(cfg.resultsRoot, "run-sets", result.runSetId, "set.json"))).toBe(true);
    expect(existsSync(join(cfg.resultsRoot, "run-sets", result.runSetId, "summary.md"))).toBe(true);
  });

  test("cancel signal aborts after current attempt; remaining attempts marked cancelled", async () => {
    const cfg = baseConfig({ passes: 4 });
    const cancelToken = { cancelled: false };
    const handle = await runRunSet({
      ...cfg,
      cancelToken,
      executor: async ({ runSetCtx }) => {
        if (runSetCtx.attemptNumber === 2) cancelToken.cancelled = true; // simulate cancel during attempt 2
        return { runId: "x", outDir: "x", result: fakeResult("pass") };
      },
    });
    const result = await handle.completion;
    // Attempts 1 and 2 completed (pass); 3 and 4 cancelled.
    expect(result.summary?.perCard[0].byStatus.pass).toBe(2);
    expect(result.summary?.perCard[0].byStatus.cancelled).toBe(2);
  });

  test("runRunSet resolves with the id and runs before the loop completes", async () => {
    let executorStarted = false;
    const config = baseConfig({ passes: 2 });

    const handle = await runRunSet({
      ...config,
      executor: async () => {
        executorStarted = true;
        return { runId: "x", outDir: "x", result: fakeResult("pass") };
      },
    });

    // Immediately after the await, we have the id and runs but the loop hasn't necessarily started.
    expect(handle.runSetId).toMatch(/^single_/);
    expect(handle.runs).toHaveLength(2);

    // set.json stub must exist on disk before completion resolves.
    expect(existsSync(join(config.resultsRoot, "run-sets", handle.runSetId, "set.json"))).toBe(true);

    // Now wait for the loop to actually finish.
    const result = await handle.completion;
    expect(executorStarted).toBe(true);
    expect(result.summary?.overall.overallStatus).toBe("consistent_pass");
  });
});
