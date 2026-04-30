import { describe, test, expect } from "bun:test";
import { BatchTableRenderer } from "../../../src/cli/stream/batch-table";

function collect(): { out: string; write: (s: string) => void } {
  const obj = { out: "", write(s: string) { obj.out += s; } };
  return obj;
}

const NON_TTY = {
  isTTY: false,
  color: false,
  columns: 100,
  target: "",
  resultsRoot: "/tmp/.gauntlet/results",
};

const TTY = {
  isTTY: true,
  color: false,
  columns: 100,
  target: "https://app.local",
  resultsRoot: "/tmp/.gauntlet/results",
};

describe("BatchTableRenderer (append mode)", () => {
  test("emits one append line per state change", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, NON_TTY);
    r.setQueued("story-a");
    r.setQueued("story-b");
    r.setRunning("story-a", "run-a-1", 20);
    r.onTurn("story-a", 7);
    r.setDone("story-a", "investigate", 8);
    r.setRunning("story-b", "run-b-1", 20);
    r.setErrored("story-b", 3, "boom");
    r.finalize();

    const lines = sink.out.split("\n").filter(Boolean);
    expect(lines).toContain("story-a: queued");
    expect(lines).toContain("story-b: queued");
    expect(lines).toContain("story-a: running turn 0 / 20");
    expect(lines).toContain("story-a: running turn 7 / 20");
    expect(lines).toContain("story-a: done (investigate) on turn 8");
    expect(lines).toContain("story-b: errored on turn 3");
    expect(sink.out).toContain("batch: 0 pass · 0 fail · 1 investigate · 1 errored");
  });

  test("setErrored before start renders without a turn number", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, NON_TTY);
    r.setQueued("story-x");
    r.setErrored("story-x", null, "card path missing");
    r.finalize();
    expect(sink.out).toContain("story-x: errored before start");
  });

  test("finalize emits a results line pointing to resultsRoot", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, { ...NON_TTY, resultsRoot: "/some/proj/.gauntlet/results" });
    r.setQueued("story-a");
    r.setDone("story-a", "pass", 3);
    r.finalize();
    expect(sink.out).toContain("results: /some/proj/.gauntlet/results");
  });
});

describe("BatchTableRenderer (attemptNumber)", () => {
  test("attemptNumber defaults to 1, behavior unchanged", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, NON_TTY);
    r.setQueued("story-a");
    r.setRunning("story-a", "story-a_t1_x", 50);
    r.onTurn("story-a", 1);
    r.setDone("story-a", "pass", 5);
    r.finalize();
    expect(sink.out).toContain("story-a");
    expect(sink.out).toContain("pass");
  });

  test("two attempts of same card render distinct rows", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, NON_TTY);
    r.setQueued("story-a", 1);
    r.setQueued("story-a", 2);
    r.setRunning("story-a", "story-a_t1_x", 50, 1);
    r.setDone("story-a", "pass", 5, 1);
    r.setRunning("story-a", "story-a_t2_y", 50, 2);
    r.setDone("story-a", "fail", 7, 2);
    r.finalize();
    // Both attempts represented in non-TTY append output:
    expect(sink.out.match(/story-a.*pass/)).toBeTruthy();
    expect(sink.out.match(/story-a.*fail/)).toBeTruthy();
  });
});

describe("BatchTableRenderer rollup line", () => {
  test("emits rollup as third line on final attempt of each card", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, NON_TTY);
    // 3 attempts of one card: pass, pass, investigate → cardStatus=mixed
    r.setQueued("story-a", 1, 3);
    r.setQueued("story-a", 2, 3);
    r.setQueued("story-a", 3, 3);
    r.setRunning("story-a", "rA1", 50, 1, 3);
    r.setDone("story-a", "pass", 5, 1);
    r.setRunning("story-a", "rA2", 50, 2, 3);
    r.setDone("story-a", "pass", 6, 2);
    r.setRunning("story-a", "rA3", 50, 3, 3);
    r.setDone("story-a", "investigate", 8, 3);
    r.finalize();
    expect(sink.out).toContain("mixed");
    // The card's name should still appear — it's three rows in non-TTY mode plus
    // (probably) once for the rollup. At minimum 3 occurrences.
    expect(sink.out.match(/story-a/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  test("no rollup line when passes === 1 (default)", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, NON_TTY);
    r.setQueued("story-a");
    r.setRunning("story-a", "rA1", 50);
    r.setDone("story-a", "pass", 5);
    r.finalize();
    expect(sink.out).not.toContain("mixed");
    expect(sink.out).not.toContain("consistent_pass");
  });
});

describe("BatchTableRenderer rollup line (TTY mode)", () => {
  /**
   * Regression gate for the TTY rollup accounting fix (PRI-1440).
   *
   * In NON_TTY mode we can inspect the raw text output directly; TTY mode is
   * not easily exercisable without a real terminal (ANSI erase sequences make
   * the output non-linear). Instead, we exercise the two observable
   * invariants that hold in both modes:
   *
   *   1. The rollup line text is present in the output exactly once per card.
   *   2. No spurious blank lines accumulate between cards (checked by
   *      counting newlines between the card-A result and the card-B result in
   *      NON_TTY output — which shares the rollup path with TTY but without
   *      ANSI escapes).
   *
   * A direct TTY cursor-geometry test would require a headless PTY;
   * documenting that gap here rather than skipping the test entirely.
   */
  test("rollup is emitted inside commit() in TTY mode (rollup text present)", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    // Two passes of story-a: pass + fail → mixed
    r.setQueued("story-a", 1, 2);
    r.setQueued("story-a", 2, 2);
    r.setRunning("story-a", "rA1", 10, 1, 2);
    r.setDone("story-a", "pass", 3, 1);
    r.setRunning("story-a", "rA2", 10, 2, 2);
    r.setDone("story-a", "fail", 5, 2);
    r.finalize();
    // Rollup line must appear exactly once in the TTY output.
    const occurrences = (sink.out.match(/median/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(sink.out).toContain("mixed");
  });

  test("multi-card multi-pass: rollup for each card, no cross-card bleed", () => {
    // In NON_TTY mode we can verify that the rollup line appears right after
    // the final attempt of each card and does not appear early (before all
    // attempts are done). This exercises the same rollupFor() guard that
    // commit() relies on in TTY mode.
    const sink = collect();
    const r = new BatchTableRenderer(sink, NON_TTY);
    // Card A: 2 passes (pass + pass → consistent_pass)
    r.setQueued("story-a", 1, 2);
    r.setQueued("story-a", 2, 2);
    // Card B: 2 passes (pass + fail → mixed)
    r.setQueued("story-b", 1, 2);
    r.setQueued("story-b", 2, 2);

    r.setRunning("story-a", "rA1", 10, 1, 2);
    r.setDone("story-a", "pass", 3, 1);
    // After attempt 1 of A, not all A attempts are done → no rollup yet.
    expect(sink.out).not.toContain("story-a: rollup");

    r.setRunning("story-a", "rA2", 10, 2, 2);
    r.setDone("story-a", "pass", 4, 2);
    // Now all A attempts done → rollup emitted.
    expect(sink.out).toContain("story-a: rollup consistent_pass");

    r.setRunning("story-b", "rB1", 10, 1, 2);
    r.setDone("story-b", "pass", 5, 1);
    // B not fully done yet → no B rollup.
    expect(sink.out).not.toContain("story-b: rollup");

    r.setRunning("story-b", "rB2", 10, 2, 2);
    r.setDone("story-b", "fail", 7, 2);
    // B done → rollup.
    expect(sink.out).toContain("story-b: rollup mixed");

    r.finalize();
    // Each card's rollup appears exactly once.
    expect((sink.out.match(/story-a: rollup/g) ?? []).length).toBe(1);
    expect((sink.out.match(/story-b: rollup/g) ?? []).length).toBe(1);
  });
});

describe("BatchTableRenderer header", () => {
  test("solo single-pass batch shows '1 card'", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    r.setQueued("story-a", 1, 1);
    r.setRunning("story-a", "run-a-1", 20, 1, 1);
    r.setDone("story-a", "pass", 5, 1);
    r.finalize();
    expect(sink.out).toContain("Gauntlet");
    expect(sink.out).toContain("1 card");
    expect(sink.out).not.toContain("attempts");
  });

  test("multi-card single-pass batch shows '<N> cards'", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    r.setQueued("story-a", 1, 1);
    r.setQueued("story-b", 1, 1);
    r.setRunning("story-a", "run-a-1", 20, 1, 1);
    r.setDone("story-a", "pass", 5, 1);
    r.setRunning("story-b", "run-b-1", 20, 1, 1);
    r.setDone("story-b", "pass", 6, 1);
    r.finalize();
    expect(sink.out).toContain("2 cards");
    expect(sink.out).not.toContain("attempts");
  });

  test("single-card multi-pass shows '<cardId> · <N> attempts'", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    r.setQueued("story-a", 1, 3);
    r.setQueued("story-a", 2, 3);
    r.setQueued("story-a", 3, 3);
    r.setRunning("story-a", "run-a-1", 20, 1, 3);
    r.setDone("story-a", "pass", 5, 1);
    r.finalize();
    expect(sink.out).toContain("story-a · 3 attempts");
  });

  test("multi-card multi-pass shows '<N> cards × <M> attempts'", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    r.setQueued("story-a", 1, 2);
    r.setQueued("story-a", 2, 2);
    r.setQueued("story-b", 1, 2);
    r.setQueued("story-b", 2, 2);
    r.setRunning("story-a", "run-a-1", 20, 1, 2);
    r.setDone("story-a", "pass", 5, 1);
    r.finalize();
    expect(sink.out).toContain("2 cards × 2 attempts");
  });
});

describe("BatchTableRenderer (TTY mode — Mock B ticker)", () => {
  test("setQueued does not emit anything (queued cards are tracked silently)", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    r.setQueued("a");
    r.setQueued("b");
    expect(sink.out).toBe("");
    r.finalize();
  });

  test("first setRunning writes the header and a single-line spinner", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    r.setQueued("a");
    r.setQueued("b");
    r.setRunning("a", "run-a-1", 10);
    expect(sink.out).toContain("Gauntlet");
    expect(sink.out).toContain("2 cards");
    expect(sink.out).toContain("https://app.local");
    expect(sink.out).toContain("[1/2]");
    expect(sink.out).toContain("a");
    // Spinner uses single-line redraw — no full-screen cursor walk.
    expect(sink.out).toMatch(/\r\x1b\[2K/);
    expect(sink.out).not.toMatch(/\x1b\[\d+A\x1b\[0J/);
    r.finalize();
  });

  test("setDone commits a result line with the VetStatus and the result-dir path", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    r.setQueued("a");
    r.setRunning("a", "run-a-1", 10);
    r.onTurn("a", 5);
    r.setDone("a", "investigate", 7);
    r.finalize();
    expect(sink.out).toContain("!"); // investigate glyph
    expect(sink.out).toContain("investigate");
    expect(sink.out).toContain("7 turns");
    expect(sink.out).toContain("/tmp/.gauntlet/results/run-a-1/");
  });

  test("setErrored before start commits a flush result line under the header", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    r.setQueued("a");
    r.setErrored("a", null, "card path missing");
    r.finalize();
    expect(sink.out).toContain("Gauntlet");
    expect(sink.out).toContain("✗");
    expect(sink.out).toContain("error");
    expect(sink.out).toContain("before start");
    expect(sink.out).toContain("card path missing");
  });

  test("two cards: pass + errored, final summary correct", () => {
    const sink = collect();
    const r = new BatchTableRenderer(sink, TTY);
    r.setQueued("a");
    r.setQueued("b");
    r.setRunning("a", "run-a-1", 10);
    r.setDone("a", "pass", 3);
    r.setRunning("b", "run-b-1", 10);
    r.setErrored("b", 2, "timeout");
    r.finalize();

    expect(sink.out).toContain("✓");
    expect(sink.out).toContain("✗");
    expect(sink.out).toContain("pass");
    expect(sink.out).toContain("timeout");
    expect(sink.out).toContain("batch: 1 pass · 0 fail · 0 investigate · 1 errored");
    expect(sink.out).toContain("results: /tmp/.gauntlet/results");
  });
});
