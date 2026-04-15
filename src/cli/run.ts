import { readFileSync } from "fs";
import { join } from "path";
import { parseStoryCard } from "../format/story-card";
import { EvidenceLogger } from "../evidence/logger";
import { writeResultFiles } from "../evidence/writer";
import { runAgent } from "../agent/agent";
import { createClient } from "../models/resolve";
import { CLIAdapter } from "../adapters/cli/adapter";
import type { AppConfig } from "../config";

export interface RunCommandOptions {
  scenarioPath: string;
  target: string;
  outDir: string;
  adapterType: "web" | "cli" | "tui";
  config: AppConfig;
}

export async function run(opts: RunCommandOptions): Promise<void> {
  const { scenarioPath, target, outDir, adapterType, config } = opts;

  // LLM-capable gate is enforced by the dispatch site (src/index.ts via
  // requireLlmCapableOrExit). This function assumes a valid AppConfig.

  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);
  const logger = new EvidenceLogger(outDir);
  const client = createClient(config.models.agent);
  const profilesDir = join(config.dataDir, "profiles");

  let adapter;
  switch (adapterType) {
    case "cli":
      adapter = new CLIAdapter({ profilesDir });
      await adapter.start(target);
      break;
    case "tui": {
      const { TUIAdapter } = await import("../adapters/tui/adapter");
      adapter = new TUIAdapter({ profilesDir });
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
      adapter = new WebAdapter({ chrome: chromeOpt, profilesDir, logger });
      await adapter.start(target);
      break;
    }
  }

  try {
    const result = await runAgent(card, adapter, client, logger, target);
    writeResultFiles(outDir, result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await adapter.close();
  }
}
