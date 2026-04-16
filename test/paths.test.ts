import { describe, test, expect } from "bun:test";
import { GAUNTLET_DIRNAME, gauntletPath } from "../src/paths";

describe("gauntletPath", () => {
  test("composes <root>/.gauntlet/<sub> for a single segment", () => {
    expect(gauntletPath("/project", "stories")).toBe("/project/.gauntlet/stories");
  });

  test("composes multiple segments", () => {
    expect(gauntletPath("/project", "results", "run-001")).toBe(
      "/project/.gauntlet/results/run-001",
    );
    expect(gauntletPath("/project", "context", "alice", "notes.md")).toBe(
      "/project/.gauntlet/context/alice/notes.md",
    );
  });

  test("works with an absolute projectRoot", () => {
    expect(gauntletPath("/abs/path/to/project", "stories")).toBe(
      "/abs/path/to/project/.gauntlet/stories",
    );
  });

  test("works with a relative projectRoot", () => {
    expect(gauntletPath(".", "stories")).toBe(".gauntlet/stories");
    expect(gauntletPath("./my-app", "results")).toBe("my-app/.gauntlet/results");
  });

  test("returns just the .gauntlet dir when no subdirs are given", () => {
    expect(gauntletPath("/project")).toBe("/project/.gauntlet");
    expect(gauntletPath(".")).toBe(".gauntlet");
  });

  test("GAUNTLET_DIRNAME is the literal .gauntlet convention", () => {
    expect(GAUNTLET_DIRNAME).toBe(".gauntlet");
  });
});
