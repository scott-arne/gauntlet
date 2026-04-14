import { readFileSync } from "fs";
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

  if (!config.apiKeys.anthropic && !config.apiKeys.openai) {
    console.error("ERROR: No API key set. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.");
    process.exit(1);
  }

  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);
  const logger = new EvidenceLogger(outDir);
  const client = createClient(config.models.agent);

  let adapter;
  switch (adapterType) {
    case "cli":
      adapter = new CLIAdapter();
      await adapter.start(target);
      break;
    case "tui": {
      const { TUIAdapter } = await import("../adapters/tui/adapter");
      adapter = new TUIAdapter();
      await adapter.start(target);
      break;
    }
    case "web": {
      const { WebAdapter } = await import("../adapters/web/adapter");
      adapter = new WebAdapter({ chrome: config.defaultChrome });
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
