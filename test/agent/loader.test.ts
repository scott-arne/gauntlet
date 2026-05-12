import { describe, test, expect } from "bun:test";
import { loadPromptFile, BUNDLED_PROMPT_NAMES } from "../../src/agent/prompts/loader";

describe("loadPromptFile", () => {
  test("loads each bundled prompt file by name", () => {
    for (const name of BUNDLED_PROMPT_NAMES) {
      const text = loadPromptFile(name);
      // Two valid outcomes: a non-empty string with no trailing whitespace,
      // or "" for the placeholder adapter files (cli, tui).
      expect(typeof text).toBe("string");
      expect(text).toBe(text.replace(/\s+$/, ""));
    }
  });

  test("persona file has the QA-tester opener", () => {
    expect(loadPromptFile("persona")).toMatch(/^You are a thorough QA tester\./);
  });

  test("evaluation file has the Reporting header", () => {
    expect(loadPromptFile("evaluation")).toMatch(/## Reporting/);
  });

  test("context file preserves the {{TREE_LISTING}} placeholder", () => {
    expect(loadPromptFile("context")).toContain("{{TREE_LISTING}}");
  });

  test("adapter-web file has the side-trip guidance", () => {
    expect(loadPromptFile("adapter-web")).toMatch(/Side trips for sign-in flows/);
  });

  test("adapter-cli is still an empty placeholder", () => {
    expect(loadPromptFile("adapter-cli")).toBe("");
  });

  test("adapter-tui file has the TUI environment overlay", () => {
    expect(loadPromptFile("adapter-tui")).toMatch(/## TUI environment/);
  });

  test("throws a clear error naming the missing file", () => {
    expect(() => loadPromptFile("does-not-exist")).toThrow(/does-not-exist\.md/);
  });

  test("BUNDLED_PROMPT_NAMES exposes all seven known names", () => {
    expect(new Set(BUNDLED_PROMPT_NAMES)).toEqual(
      new Set(["persona", "evaluation", "context", "adapter-web", "adapter-cli", "adapter-tui", "stuck-handling"]),
    );
  });
});
