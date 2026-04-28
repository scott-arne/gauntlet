import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runOne } from "../../src/cli/run-one";
import type { AppConfig } from "../../src/config";

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
