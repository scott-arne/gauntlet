import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SHOULD_RUN = process.env.RUN_BINARY_SMOKE === "1";

describe.if(SHOULD_RUN)("compiled binary --show-prompt-and-exit", () => {
  test("works from a directory outside the build tree", () => {
    const buildDir = mkdtempSync(join(tmpdir(), "gauntlet-bin-build-"));
    const runDir = mkdtempSync(join(tmpdir(), "gauntlet-bin-run-"));
    try {
      const binPath = join(buildDir, "gauntlet");
      const compile = spawnSync("bun", ["build", "--compile", "./src/index.ts", "--outfile", binPath], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      });
      expect(compile.status).toBe(0);
      expect(existsSync(binPath)).toBe(true);

      // Set up a fresh project in runDir
      mkdirSync(join(runDir, ".gauntlet", "context"), { recursive: true });
      writeFileSync(join(runDir, ".gauntlet", "context", "x.md"), "x", "utf-8");
      const cardPath = join(runDir, "card.md");
      writeFileSync(cardPath, "---\nid: bs-001\ntitle: Smoke\n---\n\n## Acceptance Criteria\n- ok\n", "utf-8");

      const r = spawnSync(binPath, [
        "run", cardPath,
        "--target", "http://x",
        "--project-dir", runDir,
        "--show-prompt-and-exit",
      ], { cwd: runDir, encoding: "utf-8" });

      expect(r.status).toBe(0);
      expect(r.stdout).toContain("You are a thorough QA tester");  // Persona body
      expect(r.stdout).toContain("Side trips for sign-in flows");  // Adapter web body
    } finally {
      rmSync(buildDir, { recursive: true, force: true });
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 120_000);  // compilation can take ~30s on cold cache
});
