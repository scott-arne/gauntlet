import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveProjectPrompt } from "../../src/runs/orchestrator";

describe("resolveProjectPrompt", () => {
  test("returns explicit path contents when provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-pp-"));
    try {
      const explicit = join(dir, "extra.md");
      writeFileSync(explicit, "EXPLICIT_BODY", "utf-8");
      expect(resolveProjectPrompt(dir, explicit)).toBe("EXPLICIT_BODY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("auto-loads .gauntlet/project.md when no explicit path", () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-pp-"));
    try {
      mkdirSync(join(dir, ".gauntlet"));
      writeFileSync(join(dir, ".gauntlet", "project.md"), "DEFAULT_BODY", "utf-8");
      expect(resolveProjectPrompt(dir, undefined)).toBe("DEFAULT_BODY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns undefined when no explicit path and no default file", () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-pp-"));
    try {
      expect(resolveProjectPrompt(dir, undefined)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when explicit path is supplied but file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "gauntlet-pp-"));
    try {
      const explicit = join(dir, "nonexistent.md");
      expect(() => resolveProjectPrompt(dir, explicit)).toThrow(/nonexistent\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
