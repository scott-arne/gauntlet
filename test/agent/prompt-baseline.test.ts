import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { buildSystemPrompt } from "../../src/agent/prompts";
import type { StoryCard } from "../../src/format/story-card";

const SNAPSHOT_PATH = join(import.meta.dir, "__snapshots__", "prompt-baseline.txt");
const CARD_PATH = join(import.meta.dir, "__snapshots__", "baseline-card.json");

const FIXTURE_CONTEXT_TREE =
  "  HOW-TO-LOGIN.md  (412 bytes)\n  profiles/\n    matt/\n      profile.md  (180 bytes)";

describe("buildSystemPrompt baseline snapshot", () => {
  const card: StoryCard = JSON.parse(readFileSync(CARD_PATH, "utf-8"));

  test("web adapter, with context tree — matches frozen baseline", () => {
    const prompt = buildSystemPrompt(card, FIXTURE_CONTEXT_TREE, "web", undefined, 5);
    if (!existsSync(SNAPSHOT_PATH) || process.env.UPDATE_SNAPSHOTS === "1") {
      writeFileSync(SNAPSHOT_PATH, prompt, "utf-8");
    }
    const expected = readFileSync(SNAPSHOT_PATH, "utf-8");
    expect(prompt).toBe(expected);
  });
});
