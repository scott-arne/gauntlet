import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "fs";
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

