import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "../../src/agent/prompts";
import type { StoryCard } from "../../src/format/story-card";

const CARD: StoryCard = {
  id: "story-proj-001",
  title: "Test card",
  description: "Body",
  acceptanceCriteria: ["Criterion 1"],
};

describe("buildSystemPrompt projectPrompt parameter", () => {
  test("when omitted, no Project block appears", () => {
    const prompt = buildSystemPrompt(CARD, "tree", "web", undefined, 5);
    expect(prompt).not.toContain("MY_PROJECT_MARKER");
  });

  test("when provided, Project text is inserted between Adapter and Context", () => {
    const prompt = buildSystemPrompt(CARD, "tree", "web", "MY_PROJECT_MARKER", 5);
    const adapterIdx = prompt.indexOf("Side trips for sign-in flows");
    const projectIdx = prompt.indexOf("MY_PROJECT_MARKER");
    const contextIdx = prompt.indexOf("## Context");
    expect(adapterIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeGreaterThan(adapterIdx);
    expect(contextIdx).toBeGreaterThan(projectIdx);
  });

  test("Project block is separated from neighbors by exactly one blank line", () => {
    const prompt = buildSystemPrompt(CARD, "tree", "web", "PROJECT_BODY", 5);
    expect(prompt).toContain("\n\nPROJECT_BODY\n\n");
    expect(prompt).not.toContain("\n\n\nPROJECT_BODY");
  });

  test("empty Project string is treated as omitted (no extra blank line)", () => {
    const promptEmpty = buildSystemPrompt(CARD, "tree", "web", "", 5);
    const promptOmitted = buildSystemPrompt(CARD, "tree", "web", undefined, 5);
    expect(promptEmpty).toBe(promptOmitted);
  });
});
