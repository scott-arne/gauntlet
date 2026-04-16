import { describe, test, expect } from "bun:test";
import {
  buildFanoutPrompt,
  generateFanout,
  buildObservationPrompt,
  generateFromObservations,
  buildFailurePrompt,
  generateFromFailure,
  splitAndValidateCards,
} from "../../src/fanout/generator";
import { parseStoryCard } from "../../src/format/story-card";
import type { StoryCard } from "../../src/format/story-card";
import type { LLMClient } from "../../src/models/provider";
import type { VetResult } from "../../src/types";

function makeMockClient(responseText: string): LLMClient & { callCount: number } {
  const client = {
    callCount: 0,
    async chat() {
      client.callCount++;
      return {
        text: responseText,
        toolCalls: [],
        stopReason: "end_turn" as const,
        rawAssistantMessage: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    userMessage(content: string) {
      return { role: "user", content };
    },
    toolResultMessages() {
      return [];
    },
  };
  return client;
}

function makeVetResult(overrides: Partial<VetResult> = {}): VetResult {
  return {
    schemaVersion: 1,
    runId: "login-flow_20260416T142301Z_test",
    scenario: "login-flow",
    status: "pass",
    summary: "All checks passed",
    reasoning: "Everything worked as expected",
    observations: [],
    evidence: { screenshots: [], log: "" },
    duration_ms: 1200,
    ...overrides,
  };
}

describe("buildFanoutPrompt", () => {
  test("includes parent story content", () => {
    const card: StoryCard = {
      id: "story-001",
      title: "User can add a todo",
      status: "ready",
      tags: ["core"],
      description: "As a user I want to add a todo",
      acceptanceCriteria: ["Item appears in list"],
      raw: "",
    };

    const prompt = buildFanoutPrompt(card);
    expect(prompt).toContain("story-001");
    expect(prompt).toContain("User can add a todo");
    expect(prompt).toContain("Item appears in list");
  });

  test("instructs generation of variations", () => {
    const card: StoryCard = {
      id: "story-001",
      title: "Test",
      status: "ready",
      tags: [],
      description: "Test",
      acceptanceCriteria: [],
      raw: "",
    };

    const prompt = buildFanoutPrompt(card);
    expect(prompt).toContain("edge case");
    expect(prompt).toContain("parent: story-001");
  });
});

test("generateFanout splits response into cards", async () => {
  const mockClient: LLMClient = {
    async chat() {
      return {
        text: `---\nid: story-001-a\ntitle: Variation A\nstatus: draft\nparent: story-001\n---\n\n# Variation A\n\nTest edge case.\n\n## Acceptance Criteria\n\n- Shows error\n---CARD---\n---\nid: story-001-b\ntitle: Variation B\nstatus: draft\nparent: story-001\n---\n\n# Variation B\n\nTest boundary.\n\n## Acceptance Criteria\n\n- Handles limit`,
        toolCalls: [],
        stopReason: "end_turn" as const,
        rawAssistantMessage: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    userMessage(content: string) {
      return { role: "user", content };
    },
    toolResultMessages() {
      return [];
    },
  };

  const card: StoryCard = {
    id: "story-001",
    title: "Test",
    status: "ready",
    tags: [],
    description: "Test",
    acceptanceCriteria: ["Works"],
    raw: "",
  };

  const cards = await generateFanout(card, mockClient);
  expect(cards).toHaveLength(2);
  expect(cards[0]).toContain("story-001-a");
  expect(cards[1]).toContain("story-001-b");
});

test("generateFanout filters out invalid cards", async () => {
  const validCardA = `---\nid: story-001-a\ntitle: Variation A\nstatus: draft\nparent: story-001\n---\n\n# Variation A\n\nTest edge case.\n\n## Acceptance Criteria\n\n- Shows error`;
  const invalidCard = `This is just some text with no frontmatter at all`;
  const validCardB = `---\nid: story-001-b\ntitle: Variation B\nstatus: draft\nparent: story-001\n---\n\n# Variation B\n\nTest boundary.\n\n## Acceptance Criteria\n\n- Handles limit`;

  const mockClient: LLMClient = {
    async chat() {
      return {
        text: [validCardA, invalidCard, validCardB].join("\n---CARD---\n"),
        toolCalls: [],
        stopReason: "end_turn" as const,
        rawAssistantMessage: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    userMessage(content: string) {
      return { role: "user", content };
    },
    toolResultMessages() {
      return [];
    },
  };

  const card: StoryCard = {
    id: "story-001",
    title: "Test",
    status: "ready",
    tags: [],
    description: "Test",
    acceptanceCriteria: ["Works"],
    raw: "",
  };

  const cards = await generateFanout(card, mockClient);
  expect(cards).toHaveLength(2);
  // Every returned card must be parseable
  for (const raw of cards) {
    expect(() => parseStoryCard(raw)).not.toThrow();
  }
  expect(cards[0]).toContain("story-001-a");
  expect(cards[1]).toContain("story-001-b");
});

// --- splitAndValidateCards ---

describe("splitAndValidateCards", () => {
  const validCard = `---\nid: story-001-a\ntitle: Variation A\nstatus: draft\nparent: story-001\n---\n\nDescription.\n\n## Acceptance Criteria\n\n- Works`;
  const validCardB = `---\nid: story-001-b\ntitle: Variation B\nstatus: draft\nparent: story-001\n---\n\nDescription.\n\n## Acceptance Criteria\n\n- Works`;

  test("strips markdown code fences wrapping cards", () => {
    const fenced = "```yaml\n" + validCard + "\n```";
    const cards = splitAndValidateCards(fenced);
    expect(cards).toHaveLength(1);
    expect(() => parseStoryCard(cards[0])).not.toThrow();
  });

  test("strips code fences from multiple cards with separator", () => {
    const input = "```\n" + validCard + "\n```\n---CARD---\n```\n" + validCardB + "\n```";
    const cards = splitAndValidateCards(input);
    expect(cards).toHaveLength(2);
  });

  test("falls back to frontmatter splitting when no separator", () => {
    const input = validCard + "\n\n" + validCardB;
    const cards = splitAndValidateCards(input);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain("story-001-a");
    expect(cards[1]).toContain("story-001-b");
  });

  test("logs and filters invalid cards without crashing", () => {
    const input = validCard + "\n---CARD---\nthis is not a valid card";
    const cards = splitAndValidateCards(input);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("story-001-a");
  });
});

// --- Task 2: Observation promotion ---

describe("buildObservationPrompt", () => {
  test("includes observation details and parent scenario", () => {
    const result = makeVetResult({
      scenario: "checkout-flow",
      observations: [
        { kind: "bug", description: "Button overlaps on mobile" },
        { kind: "a11y", description: "Missing alt text on images" },
      ],
    });

    const prompt = buildObservationPrompt(result);
    expect(prompt).toContain("checkout-flow");
    expect(prompt).toContain("Button overlaps on mobile");
    expect(prompt).toContain("Missing alt text on images");
    expect(prompt).toContain("bug");
    expect(prompt).toContain("a11y");
    expect(prompt).toContain("parent: checkout-flow");
    expect(prompt).toContain("observation");
  });
});

describe("generateFromObservations", () => {
  test("creates cards from observations", async () => {
    const result = makeVetResult({
      scenario: "checkout-flow",
      observations: [
        { kind: "bug", description: "Button overlaps on mobile" },
      ],
    });

    const cardA = `---\nid: checkout-flow-obs-1\ntitle: Fix button overlap on mobile\nstatus: draft\ntags: observation\nparent: checkout-flow\n---\n\nInvestigate button overlap on mobile viewports.\n\n## Acceptance Criteria\n\n- Button is fully visible on mobile`;

    const client = makeMockClient(cardA);
    const cards = await generateFromObservations(result, client);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toContain("checkout-flow-obs-1");
    const parsed = parseStoryCard(cards[0]);
    expect(parsed.parent).toBe("checkout-flow");
    expect(parsed.tags).toContain("observation");
  });

  test("returns empty array when no observations", async () => {
    const result = makeVetResult({ observations: [] });
    const client = makeMockClient("should not be called");
    const cards = await generateFromObservations(result, client);

    expect(cards).toEqual([]);
    expect(client.callCount).toBe(0);
  });
});

// --- Task 3: Failure analysis ---

describe("buildFailurePrompt", () => {
  test("includes failure details for fail results", () => {
    const result = makeVetResult({
      scenario: "login-flow",
      status: "fail",
      summary: "Login button unresponsive",
      reasoning: "Click handler not attached after render",
    });

    const prompt = buildFailurePrompt(result);
    expect(prompt).not.toBeNull();
    expect(prompt!).toContain("login-flow");
    expect(prompt!).toContain("Login button unresponsive");
    expect(prompt!).toContain("Click handler not attached after render");
    expect(prompt!).toContain("parent: login-flow");
    expect(prompt!).toContain("failure-analysis");
  });

  test("returns null for non-fail results", () => {
    expect(buildFailurePrompt(makeVetResult({ status: "pass" }))).toBeNull();
    expect(buildFailurePrompt(makeVetResult({ status: "investigate" }))).toBeNull();
  });
});

describe("generateFromFailure", () => {
  test("creates cards from failed run", async () => {
    const result = makeVetResult({
      scenario: "login-flow",
      status: "fail",
      summary: "Login button unresponsive",
      reasoning: "Click handler not attached",
    });

    const cardA = `---\nid: login-flow-fail-1\ntitle: Investigate click handler binding\nstatus: draft\ntags: failure-analysis\nparent: login-flow\n---\n\nVerify click handler is attached after component render.\n\n## Acceptance Criteria\n\n- Click handler fires on first click`;
    const cardB = `---\nid: login-flow-fail-2\ntitle: Check render timing\nstatus: draft\ntags: failure-analysis\nparent: login-flow\n---\n\nInvestigate if render completes before interaction.\n\n## Acceptance Criteria\n\n- Component is interactive after render`;

    const client = makeMockClient([cardA, cardB].join("\n---CARD---\n"));
    const cards = await generateFromFailure(result, client);

    expect(cards).toHaveLength(2);
    for (const raw of cards) {
      const parsed = parseStoryCard(raw);
      expect(parsed.parent).toBe("login-flow");
      expect(parsed.tags).toContain("failure-analysis");
    }
  });

  test("returns empty for non-fail results and does not call LLM", async () => {
    const result = makeVetResult({ status: "pass" });
    const client = makeMockClient("should not be called");
    const cards = await generateFromFailure(result, client);

    expect(cards).toEqual([]);
    expect(client.callCount).toBe(0);
  });
});
