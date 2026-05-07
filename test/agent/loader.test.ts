import { describe, test, expect } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { loadPromptFile } from "../../src/agent/prompts/loader";

const PROMPTS_DIR = join(import.meta.dir, "..", "..", "src", "agent", "prompts");

describe("loadPromptFile", () => {
  test("reads an existing file and trims trailing whitespace", () => {
    const path = join(PROMPTS_DIR, "_test-trim.md");
    writeFileSync(path, "hello world\n\n  \n", "utf-8");
    try {
      expect(loadPromptFile("_test-trim")).toBe("hello world");
    } finally {
      unlinkSync(path);
    }
  });

  test("returns empty string for a zero-byte file (no throw)", () => {
    const path = join(PROMPTS_DIR, "_test-empty.md");
    writeFileSync(path, "", "utf-8");
    try {
      expect(loadPromptFile("_test-empty")).toBe("");
    } finally {
      unlinkSync(path);
    }
  });

  test("throws a clear error naming the missing file", () => {
    expect(() => loadPromptFile("_does-not-exist")).toThrow(/_does-not-exist\.md/);
  });

  test("does not strip leading whitespace inside content (only trailing)", () => {
    const path = join(PROMPTS_DIR, "_test-leading.md");
    writeFileSync(path, "  preserved\n", "utf-8");
    try {
      expect(loadPromptFile("_test-leading")).toBe("  preserved");
    } finally {
      unlinkSync(path);
    }
  });
});
