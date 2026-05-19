import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { EvidenceLogger, EventObserver } from "../../src/evidence/logger";
import { runBatch } from "../../src/cli/batch";
import type { AppConfig } from "../../src/config";

import { makeConfig } from "../helpers/make-config";

function collectSink() {
  const obj = { out: "", write(s: string) { obj.out += s; } };
  return obj;
}

describe("runBatch", () => {
  test("serial loop calls runOne for each card and produces a final summary", async () => {
    const sink = collectSink();
    const calls: string[] = [];

    const stubRunOne = async (opts: { scenarioPath: string; onLogger?: any }) => {
      calls.push(opts.scenarioPath);
      // Drive the observer with a minimal happy-path event sequence.
      let observer: EventObserver | null = null;
      const fakeLog: any = {
        addEventObserver(fn: EventObserver) { observer = fn; return () => {}; },
        logEvent: () => {},
      };
      const detach = opts.onLogger?.(fakeLog) ?? (() => {});
      observer?.({ type: "run_start", runId: `run-${opts.scenarioPath}`, cardId: opts.scenarioPath, budgetMs: 300_000 } as any);
      observer?.({ type: "llm_response", turn: 3, stopReason: "end_turn" } as any);
      observer?.({ type: "run_end", status: "pass", durationMs: 1000, usage: { turns: 4 } } as any);
      detach();
      return {
        runId: `run-${opts.scenarioPath}`,
        outDir: `/tmp/${opts.scenarioPath}`,
        result: { status: "pass" } as any,
      };
    };

    const exitCode = await runBatch(
      {
        scenarioPaths: ["a.md", "b.md"],
        target: "http://localhost",
        adapterType: "cli",
        config: makeConfig("/tmp/x"),
        silent: false,
        format: undefined,
        noColor: true,
        sink,
        isTTY: false,
        passes: 1,
      },
      stubRunOne as any,
    );

    expect(calls).toEqual(["a.md", "b.md"]);
    expect(exitCode).toBe(0);
    // Table key is basename(path, extname(path)) = "a", "b" — not "a.md" / "b.md".
    expect(sink.out).toContain("a: queued");
    expect(sink.out).toContain("b: queued");
    expect(sink.out).toContain("a: done (pass)");
    expect(sink.out).toContain("b: done (pass)");
    expect(sink.out).toContain("batch: 2 pass · 0 fail · 0 investigate · 0 errored");
  });
});

describe("runBatch — error handling", () => {
  test("runOne throwing marks the row errored and the loop continues", async () => {
    const sink = collectSink();
    const calls: string[] = [];
    let i = 0;
    const stub: any = async (opts: any) => {
      calls.push(opts.scenarioPath);
      if (i++ === 0) throw new Error("boom");
      const observer = (await new Promise<EventObserver>((resolve) => {
        const fakeLog: any = { addEventObserver: (fn: EventObserver) => { resolve(fn); return () => {}; }, logEvent: () => {} };
        opts.onLogger?.(fakeLog);
      }));
      observer({ type: "run_start", runId: "r2", cardId: "b.md", budgetMs: 300_000 } as any);
      observer({ type: "run_end", status: "pass", usage: { turns: 1 } } as any);
      return { runId: "r2", outDir: "/tmp/b.md", result: { status: "pass" } };
    };

    const exitCode = await runBatch(
      {
        scenarioPaths: ["a.md", "b.md"],
        target: "x", adapterType: "cli", config: makeConfig("/tmp/x"),
        silent: false, format: undefined, noColor: true,
        sink, isTTY: false,
        passes: 1,
      },
      stub,
    );

    expect(calls).toEqual(["a.md", "b.md"]);
    expect(exitCode).toBe(1);
    // The stub throws before any onLogger / setRunning call, so the row
    // never leaves "queued" — the table should render "errored before
    // start", not "errored on turn N".
    expect(sink.out).toContain("a: errored before start");
    expect(sink.out).toContain("b: done (pass)");
    expect(sink.out).toContain("batch: 1 pass · 0 fail · 0 investigate · 1 errored");
  });

  test("any non-pass result yields exit code 1", async () => {
    const sink = collectSink();
    const stub: any = async (opts: any) => {
      const observer = (await new Promise<EventObserver>((resolve) => {
        const fakeLog: any = { addEventObserver: (fn: EventObserver) => { resolve(fn); return () => {}; }, logEvent: () => {} };
        opts.onLogger?.(fakeLog);
      }));
      observer({ type: "run_start", runId: "r", cardId: opts.scenarioPath, budgetMs: 300_000 } as any);
      observer({ type: "run_end", status: "investigate", usage: { turns: 1 } } as any);
      return { runId: "r", outDir: "/tmp/x", result: { status: "investigate" } };
    };

    const exitCode = await runBatch(
      {
        scenarioPaths: ["a.md"],
        target: "x", adapterType: "cli", config: makeConfig("/tmp/x"),
        silent: false, format: undefined, noColor: true,
        sink, isTTY: false,
        passes: 1,
      },
      stub,
    );
    expect(exitCode).toBe(1);
    expect(sink.out).toContain("batch: 0 pass · 0 fail · 1 investigate · 0 errored");
  });
});

describe("runBatch — output modes", () => {
  test("--format jsonl emits one event per line with runId injected", async () => {
    const sink = collectSink();
    const stub: any = async (opts: any) => {
      const observer = (await new Promise<EventObserver>((resolve) => {
        const fakeLog: any = { addEventObserver: (fn: EventObserver) => { resolve(fn); return () => {}; }, logEvent: () => {} };
        opts.onLogger?.(fakeLog);
      }));
      observer({ type: "run_start", runId: "RUN-1", cardId: "a", budgetMs: 300_000 } as any);
      observer({ type: "llm_response", turn: 1, stopReason: "end_turn" } as any);
      observer({ type: "run_end", status: "pass", usage: { turns: 1 } } as any);
      return { runId: "RUN-1", outDir: "/tmp/a", result: { status: "pass" } };
    };

    await runBatch(
      {
        scenarioPaths: ["a.md"],
        target: "x", adapterType: "cli", config: makeConfig("/tmp/x"),
        silent: false, format: "jsonl", noColor: true,
        sink, isTTY: false,
        passes: 1,
      },
      stub,
    );

    const lines = sink.out.split("\n").filter(Boolean);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.runId).toBe("RUN-1");
    }
    expect(sink.out).not.toContain("queued");
    expect(sink.out).not.toContain("batch:");
  });

  test("--silent suppresses everything except the final summary on stderr", async () => {
    const sink = collectSink();
    const stderrLines: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { stderrLines.push(a.join(" ")); };

    const stub: any = async (opts: any) => {
      const observer = (await new Promise<EventObserver>((resolve) => {
        const fakeLog: any = { addEventObserver: (fn: EventObserver) => { resolve(fn); return () => {}; }, logEvent: () => {} };
        opts.onLogger?.(fakeLog);
      }));
      observer({ type: "run_start", runId: "r", cardId: "a", budgetMs: 300_000 } as any);
      observer({ type: "run_end", status: "pass", usage: { turns: 1 } } as any);
      return { runId: "r", outDir: "/tmp/a", result: { status: "pass" } };
    };

    try {
      await runBatch(
        {
          scenarioPaths: ["a.md"],
          target: "x", adapterType: "cli", config: makeConfig("/tmp/x"),
          silent: true, format: undefined, noColor: true,
          sink, isTTY: false,
          passes: 1,
        },
        stub,
      );
    } finally {
      console.error = origErr;
    }

    expect(sink.out).toBe("");
    expect(stderrLines.join("\n")).toContain("batch: 1 pass");
  });
});

describe("runBatch — RunSet artifact", () => {
  // Each test creates its own isolated tmpdir under the OS temp dir.
  const tmpdirs: string[] = [];
  afterAll(() => {
    for (const d of tmpdirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  function makeTmpConfig(): AppConfig {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-batch-test-"));
    tmpdirs.push(projectRoot);
    return {
      projectRoot,
      stateDirName: ".gauntlet",
      port: 4400,
      defaultChrome: { host: "127.0.0.1", port: 9222 },
      defaultBudgetMs: 300000,
      defaultViewport: { width: 1440, height: 900 },
      saveScreencast: false,
      models: { agent: "claude-sonnet-4-6", fanout: undefined },
      sources: { defaultChrome: "default" },
    } as any;
  }

  function makeStubRunOne(calls: string[]) {
    return async (opts: { scenarioPath: string; runId?: string; onLogger?: any }) => {
      calls.push(opts.scenarioPath);
      let observer: EventObserver | null = null;
      const fakeLog: any = {
        addEventObserver(fn: EventObserver) { observer = fn; return () => {}; },
        logEvent: () => {},
      };
      const detach = opts.onLogger?.(fakeLog) ?? (() => {});
      const runId = opts.runId ?? `run-${opts.scenarioPath}`;
      observer?.({ type: "run_start", runId, cardId: opts.scenarioPath, budgetMs: 300_000 } as any);
      observer?.({ type: "run_end", status: "pass", durationMs: 500, usage: { turns: 2 } } as any);
      detach();
      return { runId, outDir: `/tmp/${runId}`, result: { status: "pass" } as any };
    };
  }

  test("gauntlet batch a.md b.md (passes=1) produces a RunSet artifact with 2 runs", async () => {
    const sink = { out: "", write(s: string) { this.out += s; } };
    const config = makeTmpConfig();
    const calls: string[] = [];

    const exitCode = await runBatch(
      {
        scenarioPaths: ["a.md", "b.md"],
        target: "http://localhost",
        adapterType: "cli",
        config,
        silent: false,
        format: undefined,
        noColor: true,
        sink,
        isTTY: false,
        passes: 1,
      },
      makeStubRunOne(calls) as any,
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["a.md", "b.md"]);

    // Assert that .gauntlet/run-sets/batch_*/ was created.
    const runSetsDir = join(config.projectRoot, ".gauntlet", "run-sets");
    const entries = readdirSync(runSetsDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^batch_/);

    const setJson = JSON.parse(
      readFileSync(join(runSetsDir, entries[0], "set.json"), "utf8"),
    );
    expect(setJson.kind).toBe("batch");
    expect(setJson.passes).toBe(1);
    expect(setJson.runs).toHaveLength(2);
    expect(setJson.runs.map((r: any) => r.cardId)).toEqual(["a", "b"]);
    // All runs should be pass.
    expect(setJson.summary.overall.overallStatus).toBe("consistent_pass");
  });

  test("gauntlet batch a.md b.md --passes 2 produces a RunSet artifact with 4 runs", async () => {
    const sink = { out: "", write(s: string) { this.out += s; } };
    const config = makeTmpConfig();
    const calls: string[] = [];

    const exitCode = await runBatch(
      {
        scenarioPaths: ["a.md", "b.md"],
        target: "http://localhost",
        adapterType: "cli",
        config,
        silent: false,
        format: undefined,
        noColor: true,
        sink,
        isTTY: false,
        passes: 2,
      },
      makeStubRunOne(calls) as any,
    );

    expect(exitCode).toBe(0);
    // 2 cards × 2 passes = 4 executor calls.
    expect(calls).toHaveLength(4);

    const runSetsDir = join(config.projectRoot, ".gauntlet", "run-sets");
    const entries = readdirSync(runSetsDir);
    expect(entries.length).toBe(1);

    const setJson = JSON.parse(
      readFileSync(join(runSetsDir, entries[0], "set.json"), "utf8"),
    );
    expect(setJson.passes).toBe(2);
    expect(setJson.runs).toHaveLength(4);
    expect(setJson.summary.overall.overallStatus).toBe("consistent_pass");
  });

  test("gauntlet batch a.md (passes=1) does NOT produce a RunSet artifact", async () => {
    const sink = { out: "", write(s: string) { this.out += s; } };
    const config = makeTmpConfig();
    const calls: string[] = [];

    const exitCode = await runBatch(
      {
        scenarioPaths: ["a.md"],
        target: "http://localhost",
        adapterType: "cli",
        config,
        silent: false,
        format: undefined,
        noColor: true,
        sink,
        isTTY: false,
        passes: 1,
      },
      makeStubRunOne(calls) as any,
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["a.md"]);

    // The else branch must not create any run-sets directory.
    let runSetsDirExists = false;
    try {
      readdirSync(join(config.projectRoot, ".gauntlet", "run-sets"));
      runSetsDirExists = true;
    } catch {}
    expect(runSetsDirExists).toBe(false);
  });
});
