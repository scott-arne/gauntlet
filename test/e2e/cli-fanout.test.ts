import { describe, test, expect } from "bun:test";
import { generateFanout } from "../../src/fanout/generator";
import { generateFromObservations } from "../../src/fanout/generator";
import { parseStoryCard } from "../../src/format/story-card";
import type { StoryCard } from "../../src/format/story-card";
import type { LLMClient } from "../../src/models/provider";
import type { VetResult } from "../../src/types";
import { mkdtempSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeMockClient(responseText: string): LLMClient {
  return {
    async chat() {
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
}

const parentCard: StoryCard = {
  id: "story-parent",
  title: "User can add a todo item",
  status: "ready",
  tags: ["core"],
  description: "As a user I want to add a todo item to my list.",
  acceptanceCriteria: ["Item appears in list after submission"],
  raw: "",
};

const variationA = `---
id: story-parent-a
title: Empty input rejected
status: draft
parent: story-parent
---

Verify that submitting an empty todo shows a validation error.

## Acceptance Criteria

- Error message displayed for empty input`;

const variationB = `---
id: story-parent-b
title: Very long input truncated
status: draft
parent: story-parent
---

Verify that a very long todo input is handled gracefully.

## Acceptance Criteria

- Input over 500 characters is truncated or rejected`;

describe("fanout e2e: round-trip", () => {
  test("generateFanout produces parseable cards that survive file round-trip", async () => {
    const client = makeMockClient(
      [variationA, variationB].join("\n---CARD---\n")
    );

    const cards = await generateFanout(parentCard, client);

    expect(cards.length).toBeGreaterThan(0);
    expect(cards).toHaveLength(2);

    // Each card must parse and reference the parent
    for (const raw of cards) {
      const parsed = parseStoryCard(raw);
      expect(parsed.parent).toBe("story-parent");
    }

    // Write cards to temp dir, re-read, re-parse
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-fanout-e2e-"));
    for (let i = 0; i < cards.length; i++) {
      const filePath = join(dir, `card-${i}.md`);
      writeFileSync(filePath, cards[i], "utf-8");

      const reRead = readFileSync(filePath, "utf-8");
      const reParsed = parseStoryCard(reRead);

      expect(reParsed.parent).toBe("story-parent");
      expect(reParsed.id).toBeTruthy();
      expect(reParsed.title).toBeTruthy();
      expect(reParsed.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });
});

describe("fanout e2e: observation promotion", () => {
  test("generateFromObservations creates parseable cards with correct parent and tags", async () => {
    const result: VetResult = {
      schemaVersion: 1,
      runId: "checkout-flow_20260416T142301Z_test",
      scenario: "checkout-flow",
      status: "pass",
      summary: "Checkout completed but with issues",
      reasoning: "Flow works but has accessibility gaps",
      observations: [
        { kind: "a11y", description: "Submit button missing aria-label" },
        { kind: "ux", description: "No loading indicator during payment" },
      ],
      evidence: { screenshots: [], log: "" },
      duration_ms: 2500,
    };

    const obsCardA = `---
id: checkout-flow-obs-1
title: Add aria-label to submit button
status: draft
tags: observation
parent: checkout-flow
---

Submit button is missing an aria-label attribute.

## Acceptance Criteria

- Submit button has descriptive aria-label`;

    const obsCardB = `---
id: checkout-flow-obs-2
title: Add loading indicator for payment
status: draft
tags: observation
parent: checkout-flow
---

No loading indicator is shown during payment processing.

## Acceptance Criteria

- Loading spinner appears during payment request`;

    const client = makeMockClient(
      [obsCardA, obsCardB].join("\n---CARD---\n")
    );

    const cards = await generateFromObservations(result, client);

    expect(cards).toHaveLength(2);

    for (const raw of cards) {
      const parsed = parseStoryCard(raw);
      expect(parsed.parent).toBe("checkout-flow");
      expect(parsed.tags).toContain("observation");
      expect(parsed.id).toBeTruthy();
      expect(parsed.title).toBeTruthy();
      expect(parsed.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });
});
