import { describe, test, expect } from "bun:test";
import { parseStoryCard, type StoryCard } from "../../src/format/story-card";
import { readFileSync } from "fs";
import { join } from "path";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "../fixtures", name), "utf-8");

describe("parseStoryCard", () => {
  test("parses full story card with all fields", () => {
    const card = parseStoryCard(fixture("story-001-add-todo.md"));
    expect(card.id).toBe("story-001");
    expect(card.title).toBe("User can add a todo item");
    expect(card.status).toBe("ready");
    expect(card.tags).toEqual(["onboarding", "core"]);
    expect(card.stakeholder).toBe("new user");
    expect(card.parent).toBeUndefined();
    expect(card.description).toContain("As a new user");
    expect(card.acceptanceCriteria).toHaveLength(3);
    expect(card.acceptanceCriteria[0]).toBe(
      "User can type a todo item and press Enter"
    );
  });

  test("parses minimal story card", () => {
    const card = parseStoryCard(fixture("story-002-minimal.md"));
    expect(card.id).toBe("story-002");
    expect(card.title).toBe("Minimal story");
    expect(card.status).toBe("draft");
    expect(card.tags).toEqual([]);
    expect(card.acceptanceCriteria).toEqual([]);
    expect(card.description).toContain("minimal frontmatter");
  });

  test("parses parent reference", () => {
    const card = parseStoryCard(fixture("story-003-with-parent.md"));
    expect(card.parent).toBe("story-001");
    expect(card.stakeholder).toBe("power user");
  });

  test("parses tags from smoke scenario fixture", () => {
    const card = parseStoryCard(fixture("smoke-scenario.md"));
    expect(card.id).toBe("smoke-test");
    expect(card.tags).toEqual(["smoke"]);
  });

  test("parses tags from cli smoke scenario fixture", () => {
    const card = parseStoryCard(fixture("cli-smoke-scenario.md"));
    expect(card.id).toBe("cli-smoke");
    expect(card.tags).toEqual(["smoke"]);
  });

  test("throws on missing id", () => {
    expect(() =>
      parseStoryCard("---\ntitle: No ID\n---\nSome body")
    ).toThrow();
  });

  test("throws on missing title", () => {
    expect(() =>
      parseStoryCard("---\nid: story-x\n---\nSome body")
    ).toThrow();
  });

  // Regression: PRI-2160. Soft-wrapped (multi-line) acceptance criteria
  // were truncated to their first line — the judge saw "- The duplicated
  // report-formatting logic was flagged openly by the" with the entire
  // operational definition (which reviewer, what counts as a fail)
  // dropped, and three judges guessed the missing half three different
  // ways. The fixture is the real card from the preserved 4ae1 run.
  test("joins wrapped continuation lines into a single criterion (PRI-2160)", () => {
    const card = parseStoryCard(fixture("story-multiline-criteria.md"));
    expect(card.acceptanceCriteria).toHaveLength(5);
    const dupCriterion = card.acceptanceCriteria[1];
    expect(dupCriterion).toContain(
      "The duplicated report-formatting logic was flagged openly by the per-task quality review",
    );
    expect(dupCriterion).toContain(
      "only the final whole-branch review catching it",
    );
    // Joined as one logical line — no internal newlines.
    expect(dupCriterion).not.toContain("\n");
    // The last criterion keeps its full wrapped text too.
    expect(card.acceptanceCriteria[4]).toContain(
      "the criteria above are about whether the *per-task quality review* was the mechanism",
    );
  });

  test("a blank line ends a criterion; trailing prose is not glommed on", () => {
    const card = parseStoryCard(
      [
        "---",
        "id: story-x",
        "title: Wrapped criteria",
        "---",
        "Description here.",
        "",
        "## Acceptance Criteria",
        "- First criterion wraps onto",
        "  a second line",
        "- Second criterion is single-line",
        "",
        "This trailing paragraph is commentary, not part of any criterion.",
      ].join("\n"),
    );
    expect(card.acceptanceCriteria).toEqual([
      "First criterion wraps onto a second line",
      "Second criterion is single-line",
    ]);
  });

  test("a heading directly after the bullets ends the criteria section", () => {
    const card = parseStoryCard(
      [
        "---",
        "id: story-x",
        "title: Heading after bullets",
        "---",
        "Body.",
        "",
        "## Acceptance Criteria",
        "- Only criterion",
        "## Notes",
        "This prose belongs to Notes, not to the criterion.",
      ].join("\n"),
    );
    expect(card.acceptanceCriteria).toEqual(["Only criterion"]);
  });

  test("unindented (lazy) continuation lines still belong to the bullet", () => {
    const card = parseStoryCard(
      [
        "---",
        "id: story-x",
        "title: Lazy continuation",
        "---",
        "Body.",
        "",
        "## Acceptance Criteria",
        "- A criterion that wraps",
        "without indentation on the next line",
      ].join("\n"),
    );
    expect(card.acceptanceCriteria).toEqual([
      "A criterion that wraps without indentation on the next line",
    ]);
  });
});
