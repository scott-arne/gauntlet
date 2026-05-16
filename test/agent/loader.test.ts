import { describe, test, expect } from "bun:test";
import { loadPromptFile, BUNDLED_PROMPT_NAMES } from "../../src/agent/prompts/loader";

describe("loadPromptFile", () => {
  test("loads each bundled prompt file by name", () => {
    for (const name of BUNDLED_PROMPT_NAMES) {
      const text = loadPromptFile(name);
      // All bundled prompts now have content; assert non-empty + no trailing
      // whitespace.
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
      expect(text).toBe(text.replace(/\s+$/, ""));
    }
  });

  test("persona file has the auditor opener", () => {
    expect(loadPromptFile("persona")).toMatch(/^You are an auditor\./);
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

  test("adapter-cli file has the CLI environment overlay", () => {
    expect(loadPromptFile("adapter-cli")).toMatch(/## CLI environment/);
  });

  test("adapter-tui file has the TUI environment overlay", () => {
    expect(loadPromptFile("adapter-tui")).toMatch(/## TUI environment/);
  });

  test("throws a clear error naming the missing file", () => {
    expect(() => loadPromptFile("does-not-exist")).toThrow(/does-not-exist\.md/);
  });

  test("BUNDLED_PROMPT_NAMES exposes all six known names", () => {
    expect(new Set(BUNDLED_PROMPT_NAMES)).toEqual(
      new Set(["persona", "evaluation", "context", "adapter-web", "adapter-cli", "adapter-tui"]),
    );
  });
});
