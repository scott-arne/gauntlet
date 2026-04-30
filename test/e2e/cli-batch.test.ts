import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { runBatch } from "../../src/cli/batch";
import { report, makeScriptedClient } from "./helpers";

// Cards: description and acceptanceCriteria come from the markdown body,
// not from frontmatter. We only need id + title in frontmatter to parse.
const STORY_A = `---
id: cli-batch-a
title: A passes
status: ready
---

stub
`;

const STORY_B = `---
id: cli-batch-b
title: B fails
status: ready
---

stub
`;

describe("gauntlet batch — e2e against CLI adapter", () => {
  let projectRoot: string;
  let pathA: string;
  let pathB: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "gauntlet-batch-e2e-"));
    pathA = join(projectRoot, "a.md");
    pathB = join(projectRoot, "b.md");
    writeFileSync(pathA, STORY_A);
    writeFileSync(pathB, STORY_B);
  });

  afterEach(() => {
    mock.restore();
  });

  test("two cards: one pass, one fail; exit code 1; both evidence dirs created", async () => {
    const passClient = makeScriptedClient([report("pass", "ok", "")]);
    const failClient = makeScriptedClient([report("fail", "nope", "")]);

    let i = 0;
    const clients = [passClient, failClient];
    mock.module("../../src/models/resolve", () => ({
      createClient: () => clients[i++],
      resolveProvider: () => "anthropic",
    }));

    const sink = {
      out: "",
      write(s: string) {
        this.out += s;
      },
    };

    const exitCode = await runBatch({
      scenarioPaths: [pathA, pathB],
      target: "true",
      adapterType: "cli",
      config: {
        projectRoot,
        port: 4400,
        defaultChrome: { host: "127.0.0.1", port: 9222 },
        defaultTurns: 5,
        defaultViewport: { width: 1440, height: 900 },
        saveScreencast: false,
        models: { agent: "claude-sonnet-4-6", fanout: undefined },
        sources: { defaultChrome: "default" },
      } as any,
      silent: false,
      format: undefined,
      noColor: true,
      sink,
      isTTY: false,
      passes: 1,
    });

    expect(exitCode).toBe(1);
    expect(sink.out).toContain("done (pass)");
    expect(sink.out).toContain("done (fail)");
    expect(sink.out).toContain("batch: 1 pass · 1 fail");

    const resultsRoot = join(projectRoot, ".gauntlet", "results");
    expect(existsSync(resultsRoot)).toBe(true);
    // RunIds embed the batch cardId as their stem (`<cardId>_<ts>_<nonce>`).
    // The batch cardId is the file stem (basename without extension), not the
    // frontmatter id — the orchestrator generates runIds from the file stem
    // before parsing the card.
    const runDirs = readdirSync(resultsRoot);
    expect(runDirs.length).toBe(2);
    expect(runDirs.some((d) => d.startsWith("a_"))).toBe(true);
    expect(runDirs.some((d) => d.startsWith("b_"))).toBe(true);
  });
});
