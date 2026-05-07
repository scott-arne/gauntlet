import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO_ROOT, "src", "index.ts");

function setupProject(): { dir: string; cardPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "gauntlet-spae-"));
  mkdirSync(join(dir, ".gauntlet", "context"), { recursive: true });
  writeFileSync(join(dir, ".gauntlet", "context", "HOW-TO-LOGIN.md"), "Use email and password.", "utf-8");
  const cardPath = join(dir, "card.md");
  writeFileSync(cardPath, [
    "---",
    "id: spae-001",
    "title: Test card",
    "---",
    "",
    "## Acceptance Criteria",
    "- Logged in",
    "",
  ].join("\n"), "utf-8");
  return { dir, cardPath };
}

describe("--show-prompt-and-exit", () => {
  test("exits 0 and prints all section headers", () => {
    const { dir, cardPath } = setupProject();
    try {
      const r = spawnSync("bun", [
        ENTRY, "run", cardPath,
        "--target", "http://x",
        "--project-dir", dir,
        "--show-prompt-and-exit",
      ], { encoding: "utf-8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Persona");
      expect(r.stdout).toContain("Scenario");
      expect(r.stdout).toContain("Evaluation");
      expect(r.stdout).toContain("Adapter (web)");
      expect(r.stdout).toContain("Project");
      expect(r.stdout).toContain("Context");
      expect(r.stdout).toContain("Tools");
      expect(r.stdout).toContain("Initial user message");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("--project-prompt is included in the output", () => {
    const { dir, cardPath } = setupProject();
    const extra = join(dir, "extra.md");
    writeFileSync(extra, "PROJECT_AUGMENT_MARKER", "utf-8");
    try {
      const r = spawnSync("bun", [
        ENTRY, "run", cardPath,
        "--target", "http://x",
        "--project-dir", dir,
        "--project-prompt", extra,
        "--show-prompt-and-exit",
      ], { encoding: "utf-8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("PROJECT_AUGMENT_MARKER");
      expect(r.stdout).toContain("(caller-supplied)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("absent Project shows (none)", () => {
    const { dir, cardPath } = setupProject();
    try {
      const r = spawnSync("bun", [
        ENTRY, "run", cardPath,
        "--target", "http://x",
        "--project-dir", dir,
        "--show-prompt-and-exit",
      ], { encoding: "utf-8" });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Project.*\(none\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing card argument exits non-zero", () => {
    const r = spawnSync("bun", [ENTRY, "run", "--target", "http://x", "--show-prompt-and-exit"], { encoding: "utf-8" });
    expect(r.status).not.toBe(0);
  });
});
