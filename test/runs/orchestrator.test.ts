import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseStoryCard } from "../../src/format/story-card";
import { report, makeScriptedClient } from "../e2e/helpers";
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
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 5,
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
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 7,
      },
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.config).toMatchObject({
      target: "true",
      model: "claude-sonnet-4-6",
      adapter: "cli",
      turns: 7,
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
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 5,
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
        model: "claude-sonnet-4-6",
        adapter: "cli",
        target: "true",
        turns: 5,
      },
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.runSet).toBeUndefined();
  });
}, 15000);
