import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "../../src/agent/prompts";
import type { StoryCard } from "../../src/format/story-card";

const CARD: StoryCard = {
  id: "test",
  title: "Test",
  status: "ready",
  tags: [],
  description: "Test card",
  acceptanceCriteria: [],
  raw: "",
};

describe("buildSystemPrompt — stuck-handling section", () => {
  test("includes the maxStuckRetries number in the prompt body", () => {
    const prompt = buildSystemPrompt(CARD, undefined, "web", undefined, 5);
    expect(prompt).toContain("trying the same action 5+ times");
    expect(prompt).toContain('Call `report_result` with status `investigate`');
  });

  test("substitutes the maxStuckRetries number", () => {
    const prompt = buildSystemPrompt(CARD, undefined, "web", undefined, 3);
    expect(prompt).toContain("3+ times");
    expect(prompt).not.toContain("{{MAX_STUCK_RETRIES}}");
  });
});
