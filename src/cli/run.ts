import { readFileSync } from "fs";
import { parseStoryCard } from "../format/story-card";
import { EvidenceLogger } from "../evidence/logger";
import { writeResultFiles } from "../evidence/writer";
import { runAgent } from "../agent/agent";
import { resolveProvider } from "../models/resolve";
import { createAnthropicClient } from "../models/anthropic";
import { createOpenAIClient } from "../models/openai";
import { CLIAdapter } from "../adapters/cli/adapter";
import type { LLMClient } from "../models/provider";
import type { ModelConfig } from "../types";

function createClient(model: string): LLMClient {
  const provider = resolveProvider(model);
  switch (provider) {
    case "anthropic":
      return createAnthropicClient(model);
    case "openai":
      return createOpenAIClient(model);
  }
}

export async function run(
  scenarioPath: string,
  target: string,
  outDir: string,
  adapterType: "web" | "cli",
  models: ModelConfig,
  chromeEndpoint?: string
): Promise<void> {
  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);
  const logger = new EvidenceLogger(outDir);
  const client = createClient(models.agent);

  let adapter;
  switch (adapterType) {
    case "cli":
      adapter = new CLIAdapter();
      await adapter.start(target);
      break;
    case "web": {
      const { WebAdapter } = await import("../adapters/web/adapter");
      adapter = new WebAdapter({ chrome: chromeEndpoint });
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
