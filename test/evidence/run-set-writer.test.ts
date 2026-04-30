import { describe, test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { RunSetWriter } from "../../src/evidence/run-set-writer";
import type { RunSetCtx } from "../../src/runs/run-set-types";
import type { VetResult } from "../../src/types";

const baseCtx = (overrides: Partial<RunSetCtx> = {}): RunSetCtx => ({
  runSetId: "single_20260430T000000Z_test",
  kind: "single",
  passes: 3,
  cards: ["card-a"],
  cardIndex: 0,
  attemptNumber: 1,
  ...overrides,
});

const fakeResult = (status: VetResult["status"], turns = 5, duration = 4000): VetResult => ({
  schemaVersion: 2,
  runId: "card-a_20260430T000001Z_x000",
  scenario: "card-a",
  status,
  summary: "",
  reasoning: "",
  observations: [],
  evidence: { screenshots: [], log: "run.jsonl" },
  duration_ms: duration,
  usage: { inputTokens: 0, outputTokens: 0, turns },
});

describe("RunSetWriter", () => {
  test("start() creates dir and stub set.json with all attempts queued", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-rsw-"));
    const ctx = baseCtx();
    const allRuns = [
      { runId: "card-a_t1_a000", cardId: "card-a", attemptNumber: 1 },
      { runId: "card-a_t2_b000", cardId: "card-a", attemptNumber: 2 },
      { runId: "card-a_t3_c000", cardId: "card-a", attemptNumber: 3 },
    ];

    const w = new RunSetWriter(root, ctx);
    w.start(allRuns);

    const dir = join(root, "run-sets", ctx.runSetId);
    expect(existsSync(dir)).toBe(true);

    const set = JSON.parse(readFileSync(join(dir, "set.json"), "utf8"));
    expect(set.runSetId).toBe(ctx.runSetId);
    expect(set.passes).toBe(3);
    expect(set.runs).toHaveLength(3);
    expect(set.runs[0].status).toBe("queued");
    expect(set.summary).toBeNull();
    expect(set.completedAt).toBeNull();
  });

  test("recordRunStart marks attempt as running", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-rsw-"));
    const w = new RunSetWriter(root, baseCtx());
    w.start([
      { runId: "r1", cardId: "card-a", attemptNumber: 1 },
      { runId: "r2", cardId: "card-a", attemptNumber: 2 },
      { runId: "r3", cardId: "card-a", attemptNumber: 3 },
    ]);
    w.recordRunStart("r2");
    const set = JSON.parse(readFileSync(join(root, "run-sets", baseCtx().runSetId, "set.json"), "utf8"));
    expect(set.runs[1].status).toBe("running");
    expect(set.runs[0].status).toBe("queued");
  });

  test("recordRunEnd marks attempt with the final status", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-rsw-"));
    const w = new RunSetWriter(root, baseCtx());
    w.start([{ runId: "r1", cardId: "card-a", attemptNumber: 1 }]);
    w.recordRunEnd("r1", "pass");
    const set = JSON.parse(readFileSync(join(root, "run-sets", baseCtx().runSetId, "set.json"), "utf8"));
    expect(set.runs[0].status).toBe("pass");
  });

  test("finalize() — consistent_pass for 3 passes", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-rsw-"));
    const w = new RunSetWriter(root, baseCtx({ passes: 3 }));
    w.start([
      { runId: "r1", cardId: "card-a", attemptNumber: 1 },
      { runId: "r2", cardId: "card-a", attemptNumber: 2 },
      { runId: "r3", cardId: "card-a", attemptNumber: 3 },
    ]);
    const results = [fakeResult("pass", 5, 4000), fakeResult("pass", 6, 5000), fakeResult("pass", 7, 6000)];
    w.finalize((runId) => {
      const i = ["r1", "r2", "r3"].indexOf(runId);
      return results[i];
    });

    const set = JSON.parse(readFileSync(join(root, "run-sets", baseCtx().runSetId, "set.json"), "utf8"));
    expect(set.summary.perCard[0].cardStatus).toBe("consistent_pass");
    expect(set.summary.perCard[0].byStatus.pass).toBe(3);
    expect(set.summary.perCard[0].medianTurns).toBe(6);
    expect(set.summary.perCard[0].medianDurationMs).toBe(5000);
    expect(set.summary.overall.overallStatus).toBe("consistent_pass");
    expect(set.completedAt).not.toBeNull();
    expect(existsSync(join(root, "run-sets", baseCtx().runSetId, "summary.md"))).toBe(true);
  });

  test("finalize() — mixed bucket for pass + investigate", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-rsw-"));
    const w = new RunSetWriter(root, baseCtx({ passes: 3 }));
    w.start([
      { runId: "r1", cardId: "card-a", attemptNumber: 1 },
      { runId: "r2", cardId: "card-a", attemptNumber: 2 },
      { runId: "r3", cardId: "card-a", attemptNumber: 3 },
    ]);
    const results = [fakeResult("pass"), fakeResult("pass"), fakeResult("investigate")];
    w.finalize((runId) => results[["r1", "r2", "r3"].indexOf(runId)]);
    const set = JSON.parse(readFileSync(join(root, "run-sets", baseCtx().runSetId, "set.json"), "utf8"));
    expect(set.summary.perCard[0].cardStatus).toBe("mixed");
  });

  test("finalize() — mixed_with_errors covers errored present + non-errored", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-rsw-"));
    const w = new RunSetWriter(root, baseCtx({ passes: 3 }));
    w.start([
      { runId: "r1", cardId: "card-a", attemptNumber: 1 },
      { runId: "r2", cardId: "card-a", attemptNumber: 2 },
      { runId: "r3", cardId: "card-a", attemptNumber: 3 },
    ]);
    w.recordRunEnd("r3", "errored");
    const results = [fakeResult("pass"), fakeResult("pass")];
    w.finalize((runId) => {
      if (runId === "r3") return null;
      return results[["r1", "r2"].indexOf(runId)];
    });
    const set = JSON.parse(readFileSync(join(root, "run-sets", baseCtx().runSetId, "set.json"), "utf8"));
    expect(set.summary.perCard[0].cardStatus).toBe("mixed_with_errors");
    expect(set.summary.perCard[0].byStatus.errored).toBe(1);
    expect(set.summary.perCard[0].byStatus.pass).toBe(2);
  });

  test("finalize() — errored bucket when all errored", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-rsw-"));
    const w = new RunSetWriter(root, baseCtx({ passes: 2 }));
    w.start([
      { runId: "r1", cardId: "card-a", attemptNumber: 1 },
      { runId: "r2", cardId: "card-a", attemptNumber: 2 },
    ]);
    w.recordRunEnd("r1", "errored");
    w.recordRunEnd("r2", "errored");
    w.finalize(() => null);
    const set = JSON.parse(readFileSync(join(root, "run-sets", baseCtx().runSetId, "set.json"), "utf8"));
    expect(set.summary.perCard[0].cardStatus).toBe("errored");
    expect(set.summary.overall.overallStatus).toBe("errored");
  });

  test("finalize() — batch overall sums across cards", () => {
    const root = mkdtempSync(join(tmpdir(), "gauntlet-rsw-"));
    const ctx: RunSetCtx = {
      runSetId: "batch_20260430T000000Z_test",
      kind: "batch",
      passes: 2,
      cards: ["card-a", "card-b"],
      cardIndex: 0,
      attemptNumber: 1,
    };
    const w = new RunSetWriter(root, ctx);
    w.start([
      { runId: "a1", cardId: "card-a", attemptNumber: 1 },
      { runId: "a2", cardId: "card-a", attemptNumber: 2 },
      { runId: "b1", cardId: "card-b", attemptNumber: 1 },
      { runId: "b2", cardId: "card-b", attemptNumber: 2 },
    ]);
    const map: Record<string, VetResult> = {
      a1: fakeResult("pass"),
      a2: fakeResult("pass"),
      b1: fakeResult("fail"),
      b2: fakeResult("fail"),
    };
    w.finalize((id) => map[id]);
    const set = JSON.parse(readFileSync(join(root, "run-sets", ctx.runSetId, "set.json"), "utf8"));
    expect(set.summary.perCard[0].cardStatus).toBe("consistent_pass");
    expect(set.summary.perCard[1].cardStatus).toBe("consistent_fail");
    expect(set.summary.overall.byStatus).toEqual({ pass: 2, fail: 2, investigate: 0, errored: 0, cancelled: 0 });
    expect(set.summary.overall.overallStatus).toBe("mixed");
  });
});
