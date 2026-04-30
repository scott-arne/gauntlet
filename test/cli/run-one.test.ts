import { describe, test, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runOne } from "../../src/cli/run-one";
import type { AppConfig } from "../../src/config";
import type { RunSetCtx } from "../../src/runs/run-set-types";
import { report, makeScriptedClient } from "../e2e/helpers";

function makeConfig(projectRoot: string): AppConfig {
  return {
    projectRoot,
    port: 4400,
    defaultChrome: { host: "127.0.0.1", port: 9222 },
    defaultTurns: 5,
    defaultViewport: { width: 1440, height: 900 },
    saveScreencast: false,
    models: { agent: "claude-sonnet-4-6", fanout: undefined },
    sources: { defaultChrome: "default" },
  } as any;
}

const MINIMAL_CARD = `---
id: run-one-ctx-test
title: Minimal ctx test card
status: ready
---

A minimal card for runSetCtx threading tests.
`;

afterEach(() => {
  mock.restore();
});

describe("runOne — runSetCtx threading", () => {
  test("runSetCtx is written into result.json when provided", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-runone-ctx-"));
    const cardPath = join(projectRoot, "card.md");
    writeFileSync(cardPath, MINIMAL_CARD);

    const ctx: RunSetCtx = {
      runSetId: "rset-test-001",
      kind: "batch",
      passes: 3,
      cards: ["run-one-ctx-test"],
      cardIndex: 0,
      attemptNumber: 1,
    };

    const client = makeScriptedClient([report("pass", "all good", "looked fine")]);
    mock.module("../../src/models/resolve", () => ({
      createClient: () => client,
      resolveProvider: () => "anthropic",
    }));

    const { outDir } = await runOne({
      scenarioPath: cardPath,
      target: "true",
      adapterType: "cli",
      config: makeConfig(projectRoot),
      runSetCtx: ctx,
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.runSet).toEqual(ctx);
  });

  test("runSet field is absent from result.json when runSetCtx is not provided", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-runone-noctx-"));
    const cardPath = join(projectRoot, "card.md");
    writeFileSync(cardPath, MINIMAL_CARD);

    const client = makeScriptedClient([report("pass", "all good", "looked fine")]);
    mock.module("../../src/models/resolve", () => ({
      createClient: () => client,
      resolveProvider: () => "anthropic",
    }));

    const { outDir } = await runOne({
      scenarioPath: cardPath,
      target: "true",
      adapterType: "cli",
      config: makeConfig(projectRoot),
    });

    const resultJson = JSON.parse(readFileSync(join(outDir, "result.json"), "utf-8"));
    expect(resultJson.runSet).toBeUndefined();
  });
});

describe("runOne", () => {
  test("propagates parseStoryCard errors and never calls onLogger when parse fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-runone-"));
    const badCard = join(dir, "bad.md");
    writeFileSync(badCard, "this is not a valid story card");

    let onLoggerCalls = 0;
    await expect(
      runOne({
        scenarioPath: badCard,
        target: "noop",
        adapterType: "cli",
        config: makeConfig(dir),
        onLogger: () => {
          onLoggerCalls += 1;
          return () => {};
        },
      }),
    ).rejects.toBeDefined();

    expect(onLoggerCalls).toBe(0);
  });
});
