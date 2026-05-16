import { describe, test, expect } from "bun:test";
import { buildSystemPrompt } from "../../src/agent/prompts";
import type { StoryCard } from "../../src/format/story-card";

describe("buildSystemPrompt", () => {
  test("includes story card content", () => {
    const card: StoryCard = {
      id: "story-001",
      title: "User can add a todo",
      status: "ready",
      tags: ["core"],
      description: "As a user I want to add a todo",
      acceptanceCriteria: ["Item appears in list", "Count updates"],
      raw: "",
    };

    const prompt = buildSystemPrompt(card, undefined, undefined, undefined, 5);
    expect(prompt).toContain("story-001");
    expect(prompt).toContain("User can add a todo");
    expect(prompt).toContain("Item appears in list");
    expect(prompt).toContain("Count updates");
  });

  test("instructs agent to report observations", () => {
    const card: StoryCard = {
      id: "story-001",
      title: "Test",
      status: "ready",
      tags: [],
      description: "Test story",
      acceptanceCriteria: [],
      raw: "",
    };

    const prompt = buildSystemPrompt(card, undefined, undefined, undefined, 5);
    expect(prompt).toContain("observation");
  });

  test("instructs autonomous exploration when no criteria", () => {
    const card: StoryCard = {
      id: "story-001",
      title: "Test",
      status: "ready",
      tags: [],
      description: "Explore the app",
      acceptanceCriteria: [],
      raw: "",
    };

    const prompt = buildSystemPrompt(card, undefined, undefined, undefined, 5);
    expect(prompt).toContain("explore");
  });

  // Context section — Gauntlet v1.5 spec §4.1. The three-paragraph
  // prose is load-bearing; these assertions are fixed strings so any
  // drift breaks at CI time and the author has to either change the
  // spec (via amendment) or revert.
  describe("Context section (spec §4.1)", () => {
    const baseCard: StoryCard = {
      id: "story-001",
      title: "A test story",
      status: "ready",
      tags: [],
      description: "Do the thing.",
      acceptanceCriteria: [],
      raw: "",
    };

    // Authoritative prose, copy-pasted from spec §4.1, with
    // {{TREE_LISTING}} already substituted for the sample tree used
    // below. If the spec prose is amended, update this fixture AND
    // the spec in the same commit.
    const SAMPLE_TREE = "  alice.md  (5 bytes)";
    const EXPECTED_CONTEXT_SECTION =
      "## Context\n\n" +
      "Below is the complete list of files available for this run. Use the\n" +
      "`read` tool with a name from this tree to fetch any file's contents.\n\n" +
      "Stories will often refer to users by name (\"Alice\", \"as bob\") without\n" +
      "spelling out credentials. When that happens, look for a matching path in\n" +
      "the tree below, `read` the relevant files, and use what you find to log\n" +
      "in via the regular browser tools. A profile directory typically contains\n" +
      "an identity file (prose describing the person) and a credentials file;\n" +
      "some also contain `passkey.yaml` for WebAuthn sign-in via\n" +
      "`install_passkey`.\n\n" +
      "This listing is the full map: it is built once at the start of the run\n" +
      "and does not change while the run is in flight, so you do not need to —\n" +
      "and cannot — re-list it. Every file you might need is in this tree; if a\n" +
      "path is not shown here, it does not exist.\n\n" +
      SAMPLE_TREE;

    test("section is appended verbatim when a tree is provided", () => {
      const prompt = buildSystemPrompt(baseCard, SAMPLE_TREE, undefined, undefined, 5);
      expect(prompt).toContain(EXPECTED_CONTEXT_SECTION);
    });

    test("section is the last block in the prompt", () => {
      const prompt = buildSystemPrompt(baseCard, SAMPLE_TREE, undefined, undefined, 5);
      expect(prompt.endsWith(EXPECTED_CONTEXT_SECTION)).toBe(true);
    });

    test("section is omitted when contextTree is undefined", () => {
      const prompt = buildSystemPrompt(baseCard, undefined, undefined, undefined, 5);
      expect(prompt).not.toContain("## Context");
      expect(prompt).not.toContain(".gauntlet/context/");
    });

    test("section is omitted when contextTree is the empty string", () => {
      const prompt = buildSystemPrompt(baseCard, "", undefined, undefined, 5);
      expect(prompt).not.toContain("## Context");
      expect(prompt).not.toContain(".gauntlet/context/");
    });

    test("immutability-invariant prose is present", () => {
      const prompt = buildSystemPrompt(baseCard, SAMPLE_TREE, undefined, undefined, 5);
      // This is the prose face of spec §4.2 — it must not drift.
      expect(prompt).toContain(
        "built once at the start of the run\nand does not change while the run is in flight",
      );
      expect(prompt).toContain("so you do not need to —\nand cannot — re-list it");
    });

    test("never leaks the .gauntlet/context/ path to the agent (PRI-1614)", () => {
      const prompt = buildSystemPrompt(baseCard, SAMPLE_TREE, undefined, undefined, 5);
      expect(prompt).not.toContain(".gauntlet/context/");
    });
  });

  // PRI-1439 — side-trip guidance is web-only. The prompt must teach the
  // agent that signin flows often require a side trip, that new_tab is
  // the right answer, and that `navigate` is a trap.
  describe("side-trip tab guidance (PRI-1439)", () => {
    const baseCard: StoryCard = {
      id: "story-001",
      title: "A test story",
      status: "ready",
      tags: [],
      description: "Do the thing.",
      acceptanceCriteria: [],
      raw: "",
    };

    test("web adapter prompt mentions new_tab, close_tab, and side trips", () => {
      const prompt = buildSystemPrompt(baseCard, undefined, "web", undefined, 5);
      expect(prompt).toContain("new_tab");
      expect(prompt).toContain("close_tab");
      expect(prompt.toLowerCase()).toContain("side trip");
    });

    test("web prompt warns off `navigate` for side trips", () => {
      const prompt = buildSystemPrompt(baseCard, undefined, "web", undefined, 5);
      // The agent's natural instinct is `navigate(url)`. The prompt has
      // to flag this explicitly or the side-trip guidance is just noise
      // alongside a more familiar tool.
      expect(prompt).toMatch(/do not use `navigate`|navigate.*resets/i);
    });

    test("non-web adapters (cli, tui) do not get side-trip guidance", () => {
      // cli/tui adapters don't expose new_tab — telling the agent to
      // call it would be a hallucination invitation.
      for (const name of ["cli", "tui", undefined]) {
        const prompt = buildSystemPrompt(baseCard, undefined, name, undefined, 5);
        expect(prompt).not.toContain("new_tab");
        expect(prompt).not.toContain("close_tab");
      }
    });

    test("web side-trip section sits before the context section", () => {
      const prompt = buildSystemPrompt(baseCard, "  alice.md  (5 bytes)", "web", undefined, 5);
      const sideTripIdx = prompt.indexOf("Side trips");
      const contextIdx = prompt.indexOf("## Context");
      expect(sideTripIdx).toBeGreaterThan(0);
      expect(contextIdx).toBeGreaterThan(sideTripIdx);
    });
  });
});
