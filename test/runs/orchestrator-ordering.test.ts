import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseStoryCard } from "../../src/format/story-card";
import { report, makeScriptedClient } from "../integration/helpers";
import { executeRunCore } from "../../src/runs/orchestrator";
import { writeResultFiles as realWriteResultFiles } from "../../src/evidence/writer";

// PRI-1507 — load-bearing ordering invariant:
//   writeResultFiles must complete BEFORE the wrapper's afterClose hook
//   runs (because afterClose unregisters the run from the active-run
//   registry, and the shutdown stub writer's existsSync check depends
//   on the registry-listed run already having its result.json on disk).
//
// If a future refactor reorders these — e.g., moves writeResultFiles
// after the adapter.close + detachLogger + afterClose block — the stub
// writer will race the success path during the shutdown patience window
// and may clobber a legitimate result.
//
// This test pins the ordering. Failure message names this file + spec §3.

const ORDERING_CARD = `---
id: orch-ordering
title: orchestrator ordering invariant
status: ready
---

Minimal card.
`;

describe("executeRunCore — ordering invariant (PRI-1507)", () => {
  test("writeResultFiles runs strictly before afterClose hook", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-orch-order-"));
    const storyPath = join(projectRoot, "card.md");
    writeFileSync(storyPath, ORDERING_CARD);
    const card = parseStoryCard(ORDERING_CARD);
    const client = makeScriptedClient([report("pass", "ok", "fine")]);

    let writeResultFilesAt: number | null = null;
    let afterCloseAt: number | null = null;

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
      writeResultFiles: (outDir, result) => {
        writeResultFilesAt = Date.now();
        realWriteResultFiles(outDir, result);
      },
      hooks: {
        afterClose: () => {
          afterCloseAt = Date.now();
        },
      },
    });

    expect(writeResultFilesAt).not.toBeNull();
    expect(afterCloseAt).not.toBeNull();
    // Strict order: writeResultFiles fires BEFORE the wrapper's afterClose.
    // If this assertion fails, see PRI-1507 spec §3 + plan Step 5
    // ("ordering invariant"). The shutdown stub writer's race-safety story
    // depends on this; do not reorder without a full re-read of the spec.
    expect(writeResultFilesAt!).toBeLessThanOrEqual(afterCloseAt!);
  });
}, 15000);
