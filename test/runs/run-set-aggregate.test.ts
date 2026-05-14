import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunSetWriter } from "../../src/evidence/run-set-writer";
import type { VetResult } from "../../src/types";
import type { RunSetCtx } from "../../src/runs/run-set-types";

// PRI-1507 — when a v5 "errored" run still has a result.json on disk
// (e.g., interrupted by shutdown drain after the agent loop accumulated
// turns/tokens), the run-set rollup must include its usage data in
// medians. Catch-path errored runs (executor threw before producing a
// result file) preserve today's behavior of being skipped.

function makeCtx(passes: number): RunSetCtx {
  return {
    runSetId: "single_test",
    kind: "single",
    passes,
    cards: ["card-x"],
    cardIndex: 0,
    attemptNumber: 1,
  };
}

function makeResult(overrides: Partial<VetResult>): VetResult {
  return {
    schemaVersion: 5,
    runId: "r",
    scenario: "card-x",
    status: "pass",
    summary: "",
    reasoning: "",
    observations: [],
    evidence: { screenshots: [], log: "run.jsonl" },
    duration_ms: 1000,
    usage: { inputTokens: 100, outputTokens: 50, turns: 1 },
    ...overrides,
  };
}

describe("RunSetWriter.summarizeCard — errored with usage (PRI-1507)", () => {
  test("Case A — catch-path errored (lookup returns null): medians skip", () => {
    const root = mkdtempSync(join(tmpdir(), "runset-A-"));
    const writer = new RunSetWriter(root, makeCtx(1));
    writer.start([{ runId: "r1", cardId: "card-x", attemptNumber: 1 }]);
    writer.recordRunEnd("r1", "errored");
    writer.finalize((_id) => null);

    const set = JSON.parse(readFileSync(join(root, "run-sets", "single_test", "set.json"), "utf-8"));
    const summary = set.summary.perCard[0];
    expect(summary.byStatus.errored).toBe(1);
    expect(summary.medianTurns).toBe(0); // no samples
    expect(summary.medianDurationMs).toBe(0); // no samples
  });

  test("Case B — v5 errored with result: usage included in medians", () => {
    const root = mkdtempSync(join(tmpdir(), "runset-B-"));
    const writer = new RunSetWriter(root, makeCtx(1));
    writer.start([{ runId: "r1", cardId: "card-x", attemptNumber: 1 }]);
    writer.recordRunEnd("r1", "errored");
    writer.finalize((id) => id === "r1" ? makeResult({
      runId: "r1",
      status: "errored",
      duration_ms: 5000,
      usage: { inputTokens: 100, outputTokens: 50, turns: 7 },
      error: { type: "shutdown_interrupted", message: "..." },
    }) : null);

    const set = JSON.parse(readFileSync(join(root, "run-sets", "single_test", "set.json"), "utf-8"));
    const summary = set.summary.perCard[0];
    expect(summary.byStatus.errored).toBe(1);
    expect(summary.medianTurns).toBe(7);
    expect(summary.medianDurationMs).toBe(5000);
  });

  test("Case C — mixed pass/errored: medians include errored samples", () => {
    const root = mkdtempSync(join(tmpdir(), "runset-C-"));
    const writer = new RunSetWriter(root, { ...makeCtx(4), passes: 4 });
    writer.start([
      { runId: "r1", cardId: "card-x", attemptNumber: 1 },
      { runId: "r2", cardId: "card-x", attemptNumber: 2 },
      { runId: "r3", cardId: "card-x", attemptNumber: 3 },
      { runId: "r4", cardId: "card-x", attemptNumber: 4 },
    ]);
    writer.recordRunEnd("r1", "pass");
    writer.recordRunEnd("r2", "errored"); // v5 errored, with usage
    writer.recordRunEnd("r3", "pass");
    writer.recordRunEnd("r4", "errored"); // catch-path errored, no result

    writer.finalize((id) => {
      if (id === "r1") return makeResult({ runId: "r1", status: "pass", usage: { inputTokens: 100, outputTokens: 50, turns: 3 } });
      if (id === "r2") return makeResult({ runId: "r2", status: "errored", usage: { inputTokens: 100, outputTokens: 50, turns: 4 } });
      if (id === "r3") return makeResult({ runId: "r3", status: "pass", usage: { inputTokens: 100, outputTokens: 50, turns: 5 } });
      return null; // r4: catch-path, no result
    });

    const set = JSON.parse(readFileSync(join(root, "run-sets", "single_test", "set.json"), "utf-8"));
    const summary = set.summary.perCard[0];
    expect(summary.byStatus).toMatchObject({ pass: 2, errored: 2 });
    // Samples: 3 (r1), 4 (r2), 5 (r3). r4 catch-path skipped. Median = 4.
    expect(summary.medianTurns).toBe(4);
  });
});
