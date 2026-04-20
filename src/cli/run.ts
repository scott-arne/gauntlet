import { readFileSync } from "fs";
import { parseStoryCard } from "../format/story-card";
import { EvidenceLogger } from "../evidence/logger";
import { writeResultFiles } from "../evidence/writer";
import { runAgent } from "../agent/agent";
import { createClient } from "../models/resolve";
import { CLIAdapter } from "../adapters/cli/adapter";
import { renderContextTree } from "../context/tree";
import { makeRunId } from "../util/id";
import { gauntletPath } from "../paths";
import type { AppConfig } from "../config";

export interface RunCommandOptions {
  scenarioPath: string;
  target: string;
  outDir?: string;
  adapterType: "web" | "cli" | "tui";
  config: AppConfig;
}

export async function run(opts: RunCommandOptions): Promise<void> {
  const { scenarioPath, target, adapterType, config } = opts;

  // LLM-capable gate is enforced by the dispatch site (src/index.ts via
  // requireLlmCapableOrExit). This function assumes a valid AppConfig.

  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);
  // Generate runId first so we can derive the default outDir. Mirrors
  // the serve path (src/api/routes/run.ts): `gauntletPath(projectRoot,
  // "results", runId)` is the canonical run output location; `--out`
  // stays available as an explicit override for ad-hoc debugging.
  const runId = makeRunId(card.id);
  const outDir = opts.outDir ?? gauntletPath(config.projectRoot, "results", runId);
  const logger = new EvidenceLogger(outDir);
  const client = createClient(config.models.agent);
  const contextRoot = gauntletPath(config.projectRoot, "context");
  // Render the tree **once per run** — the immutability invariant
  // (spec §4.2) forbids re-rendering during the run.
  const contextTree = renderContextTree(contextRoot);

  let adapter;
  switch (adapterType) {
    case "cli":
      adapter = new CLIAdapter({ contextRoot });
      await adapter.start(target);
      break;
    case "tui": {
      const { TUIAdapter } = await import("../adapters/tui/adapter");
      adapter = new TUIAdapter({ contextRoot });
      await adapter.start(target);
      break;
    }
    case "web": {
      const { WebAdapter } = await import("../adapters/web/adapter");
      // Only pass an endpoint if the user explicitly set one (env or flag).
      // When the source is "default", leave it undefined so WebAdapter
      // auto-launches a local headless Chrome — preserving the pre-refactor
      // behavior of plain `gauntlet run card.md --target ...`.
      const chromeOpt = config.sources.defaultChrome === "default"
        ? undefined
        : config.defaultChrome;
      // Per-run Chrome profile name for browser state isolation (spec
      // §5.1). The cardId is already encoded in runId.
      const chromeProfileName = `gauntlet-run-${runId}`;
      adapter = new WebAdapter({
        chrome: chromeOpt,
        contextRoot,
        logger,
        chromeProfileName,
      });
      await adapter.start(target);
      break;
    }
  }

  try {
    const result = await runAgent(card, adapter, client, logger, target, {
      contextTree,
      runId,
    });
    writeResultFiles(outDir, result);
    console.log(JSON.stringify(result, null, 2));
    console.error(`runId: ${runId}`);
  } finally {
    await adapter.close();
  }
}
