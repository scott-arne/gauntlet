import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { parseStoryCard } from "../format/story-card";
import { generateFanout } from "../fanout/generator";
import { createClient } from "../models/resolve";
import type { ModelConfig } from "../types";

export async function fanout(
  scenarioPath: string,
  outDir: string,
  models: ModelConfig
): Promise<void> {
  const content = readFileSync(scenarioPath, "utf-8");
  const card = parseStoryCard(content);
  const model = models.fanout || models.agent;
  const client = createClient(model);

  const cards = await generateFanout(card, client);

  mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < cards.length; i++) {
    const filename = `${card.id}-${String.fromCharCode(97 + i)}.md`;
    writeFileSync(join(outDir, filename), cards[i] + "\n");
    console.error(`Generated: ${filename}`);
  }

  console.log(JSON.stringify({ parent: card.id, generated: cards.length }));
}
