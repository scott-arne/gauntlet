import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseStoryCard } from "../../src/format/story-card";
import { report, makeScriptedClient } from "../integration/helpers";
import { executeRunCore } from "../../src/runs/orchestrator";

describe("executeRunCore — skeleton", () => {
  test("module exports executeRunCore", () => {
    expect(typeof executeRunCore).toBe("function");
  });
});

const HAPPY_CARD = `---
id: orch-happy
title: orchestrator happy path
status: ready
---

A minimal card.
`;

describe("executeRunCore — happy path", () => {
  test("snapshots inputs, runs the agent, writes result.json and run.jsonl", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-happy-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);

    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const { runId, outDir, result } = await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        stateDirName: ".gauntlet",
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        budgetMs: 600_000,
      },
    });

    expect(runId).toMatch(/^orch-happy_/);
    expect(outDir).toContain(runId);
    expect(result.status).toBe("pass");
    expect(existsSync(join(outDir, "result.json"))).toBe(true);
    expect(existsSync(join(outDir, "run.jsonl"))).toBe(true);
    // snapshotRunInputs always copies the story file to inputs/story.md
    expect(existsSync(join(outDir, "inputs", "story.md"))).toBe(true);
  });
}, 15000);

import type { RunSetCtx } from "../../src/runs/run-set-types";

describe("executeRunCore — result metadata", () => {
  test("stamps result.config with the run config snapshot", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-cfg-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const { outDir } = await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        stateDirName: ".gauntlet",
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        budgetMs: 600_000,
      },
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.config).toMatchObject({
      target: "true",
      model: "claude-sonnet-4-6",
      adapter: "cli",
      budgetMs: 600_000,
    });
  });

  test("stamps result.runSet when runSetCtx is provided", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-rsctx-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const ctx: RunSetCtx = {
      runSetId: "rset-orch-001",
      kind: "single",
      passes: 2,
      cards: ["orch-happy"],
      cardIndex: 0,
      attemptNumber: 1,
    };

    const { outDir } = await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        stateDirName: ".gauntlet",
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        budgetMs: 600_000,
      },
      runSetCtx: ctx,
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.runSet).toEqual(ctx);
  });

  test("omits result.runSet when runSetCtx is not provided", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-norsctx-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const { outDir } = await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        stateDirName: ".gauntlet",
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        budgetMs: 600_000,
      },
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.runSet).toBeUndefined();
  });
}, 15000);

describe("executeRunCore — onLogger hook", () => {
  test("invokes onLogger before runAgent and detaches after adapter close", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-onlog-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const calls: string[] = [];
    let attached = false;

    await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        stateDirName: ".gauntlet",
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        budgetMs: 600_000,
      },
      hooks: {
        onLogger: (logger) => {
          attached = true;
          calls.push("attach");
          return () => {
            attached = false;
            calls.push("detach");
          };
        },
      },
    });

    expect(attached).toBe(false);
    expect(calls).toEqual(["attach", "detach"]);
  });

  test("onLogger return value undefined is allowed (no detach)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-onlog2-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    let attached = false;
    await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        stateDirName: ".gauntlet",
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        budgetMs: 600_000,
      },
      hooks: {
        onLogger: () => {
          attached = true;
        },
      },
    });
    expect(attached).toBe(true);
  });
}, 15000);

describe("executeRunCore — lifecycle hooks", () => {
  test("calls hooks in spec order: onLogger.attach → beforeAgent → beforeClose → adapter.close → onLogger.detach → afterClose", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-hooks-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const calls: string[] = [];

    await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        stateDirName: ".gauntlet",
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        budgetMs: 600_000,
      },
      hooks: {
        onLogger: () => {
          calls.push("onLogger.attach");
          return () => calls.push("onLogger.detach");
        },
        beforeAgent: () => { calls.push("beforeAgent"); },
        beforeClose: () => { calls.push("beforeClose"); },
        afterClose: () => { calls.push("afterClose"); },
      },
    });

    expect(calls).toEqual([
      "onLogger.attach",
      "beforeAgent",
      "beforeClose",
      "onLogger.detach",
      "afterClose",
    ]);
  });
}, 15000);

describe("executeRunCore — error path", () => {
  test("logs run_error to run.jsonl, calls onError, runs cleanup, then rethrows", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-err-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);

    // DI seam: a scripted client with zero scripts throws
    // "No more scripted responses" on the first chat() call. This
    // exercises the error path without mocking any module.
    const client = makeScriptedClient([]);

    const calls: string[] = [];

    await expect(
      executeRunCore({
        card,
        storyPath,
        client,
        runConfig: {
          projectRoot,
          stateDirName: ".gauntlet",
          model: "claude-sonnet-4-6",
          adapter: "cli",
          target: "true",
          budgetMs: 600_000,
        },
        hooks: {
          onLogger: () => { calls.push("attach"); return () => calls.push("detach"); },
          onError: () => { calls.push("onError"); },
          beforeClose: () => { calls.push("beforeClose"); },
          afterClose: () => { calls.push("afterClose"); },
        },
      }),
    ).rejects.toThrow(/No more scripted responses/);

    // Full error-path lifecycle. onError fires first (while logger is
    // still attached so error annotations remain observable), then the
    // streamer-stop slot (beforeClose), then adapter.close, then the
    // detach, then afterClose. Locking the full sequence — adding a new
    // hook here is supposed to surface as a test break.
    expect(calls).toEqual([
      "attach",
      "onError",
      "beforeClose",
      "detach",
      "afterClose",
    ]);

    // Find the orch-err output dir and read run.jsonl
    const { readdirSync } = await import("fs");
    const outDirs = readdirSync(join(projectRoot, ".gauntlet", "results"));
    expect(outDirs.length).toBe(1);
    const runJsonl = readFileSync(
      join(projectRoot, ".gauntlet", "results", outDirs[0], "run.jsonl"),
      "utf-8",
    );
    const lines = runJsonl.trim().split("\n").map((l) => JSON.parse(l));
    const errorEvent = lines.find((l) => l.type === "run_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toMatch(/No more scripted responses/);
    expect(errorEvent.turn).toBe(-1); // pre-runAgent convention from runOne
  });
});

describe("executeRunCore — boundary", () => {
  test("orchestrator source does not import HTTP-only types", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "src", "runs", "orchestrator.ts"),
      "utf-8",
    );
    expect(src).not.toContain("RunBroadcaster");
    expect(src).not.toContain("ActiveRunRegistry");
    expect(src).not.toContain("ScreencastStreamer");
    expect(src).not.toContain("RunSetBroadcaster");
    expect(src).not.toContain("ErrorLog");
    expect(src).not.toContain("from \"hono\"");
  });
});

// PRI-1507: orchestrator must forward abortSignal to runAgent, and the
// success path (not the catch path) is the one that persists the errored
// result. This exercises the full stack with a real `runAgent` + real
// `EvidenceLogger` against a temp dir — if the agent's abort handling ever
// switches from return-based to throw-based, the resulting catch-path
// rethrow means result.json never gets written, and this test fails on
// the existsSync assertion.
describe("executeRunCore — abort signal", () => {
  test("forwards aborted signal; success path writes errored result.json", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-abort-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, HAPPY_CARD);
    const card = parseStoryCard(HAPPY_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    const ac = new AbortController();
    ac.abort("test-shutdown");

    const { outDir, result } = await executeRunCore({
      card,
      storyPath,
      client,
      runConfig: {
        projectRoot,
        stateDirName: ".gauntlet",
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        budgetMs: 600_000,
      },
      abortSignal: ac.signal,
    });

    expect(result.status).toBe("errored");
    expect(result.error?.type).toBe("shutdown_interrupted");
    expect(existsSync(join(outDir, "result.json"))).toBe(true);

    const onDisk = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(onDisk.status).toBe("errored");
    expect(onDisk.error?.type).toBe("shutdown_interrupted");
  });
}, 15000);

