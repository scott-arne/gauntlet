import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { run } from "../../src/cli/run";
import type { AppConfig } from "../../src/config";
import { report, makeScriptedClient } from "../integration/helpers";

import { makeConfig } from "../helpers/make-config";

const MINIMAL_CARD = `---
id: run-multi-pass-test
title: Multi-pass run test card
status: ready
---

A minimal card for multi-pass run tests.
`;

describe("run — multi-pass RunSet integration", () => {
  const tmpdirs: string[] = [];
  afterAll(() => {
    for (const d of tmpdirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  function makeTmpConfig(): { config: AppConfig; cardPath: string } {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-run-test-"));
    tmpdirs.push(projectRoot);
    const cardPath = join(projectRoot, "card.md");
    writeFileSync(cardPath, MINIMAL_CARD);
    return { config: makeConfig(projectRoot), cardPath };
  }

  test("gauntlet run --passes 3 creates 3 per-run dirs and a single_* RunSet artifact", async () => {
    const { config, cardPath } = makeTmpConfig();

    // Each of the 3 passes gets one scripted client call.
    const client = makeScriptedClient([
      report("pass", "ok", "looks good"),
      report("pass", "ok", "looks good"),
      report("pass", "ok", "looks good"),
    ]);

    await run({
      scenarioPath: cardPath,
      target: "true",
      adapterType: "cli",
      config,
      silent: true,
      format: undefined,
      noColor: true,
      passes: 3,
      clientFactory: () => client,
    });

    // Assert: 3 per-run dirs under .gauntlet/results/
    const resultsDir = join(config.projectRoot, ".gauntlet", "results");
    const runDirs = readdirSync(resultsDir);
    expect(runDirs).toHaveLength(3);

    // Assert: exactly one run-sets/single_*/ dir was created.
    const runSetsDir = join(config.projectRoot, ".gauntlet", "run-sets");
    const setEntries = readdirSync(runSetsDir);
    expect(setEntries).toHaveLength(1);
    expect(setEntries[0]).toMatch(/^single_/);

    // Assert: set.json has 3 runs with correct attemptNumbers.
    const setJson = JSON.parse(
      readFileSync(join(runSetsDir, setEntries[0], "set.json"), "utf8"),
    );
    expect(setJson.kind).toBe("single");
    expect(setJson.passes).toBe(3);
    expect(setJson.runs).toHaveLength(3);

    const attemptNumbers = setJson.runs.map((r: any) => r.attemptNumber).sort();
    expect(attemptNumbers).toEqual([1, 2, 3]);

    // All runs should resolve to the card's id.
    const cardIds = setJson.runs.map((r: any) => r.cardId);
    expect(cardIds).toEqual(["run-multi-pass-test", "run-multi-pass-test", "run-multi-pass-test"]);

    // Assert: summary reflects consistent_pass for all-pass scripted run.
    expect(setJson.summary.overall.overallStatus).toBe("consistent_pass");

    // Assert: each per-run result.json carries the runSet field with correct setId.
    const setId = setEntries[0];
    for (const d of runDirs) {
      const resultJson = JSON.parse(
        readFileSync(join(resultsDir, d, "result.json"), "utf8"),
      );
      expect(resultJson.runSet?.runSetId).toBe(setId);
    }
  });

  test("gauntlet run --passes 1 does NOT produce a RunSet artifact", async () => {
    const { config, cardPath } = makeTmpConfig();

    const client = makeScriptedClient([report("pass", "ok", "looks good")]);

    await run({
      scenarioPath: cardPath,
      target: "true",
      adapterType: "cli",
      config,
      silent: true,
      format: undefined,
      noColor: true,
      passes: 1,
      clientFactory: () => client,
    });

    // The single-pass path must not create any run-sets directory.
    let runSetsDirExists = false;
    try {
      readdirSync(join(config.projectRoot, ".gauntlet", "run-sets"));
      runSetsDirExists = true;
    } catch {}
    expect(runSetsDirExists).toBe(false);
  });
});
