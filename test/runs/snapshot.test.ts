import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { snapshotRunInputs } from "../../src/runs/snapshot";

describe("snapshotRunInputs", () => {
  test("copies the story file byte-for-byte", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-snap-"));
    try {
      const runDir = join(tmp, "run");
      mkdirSync(runDir);
      const contextRoot = join(tmp, "ctx");
      mkdirSync(contextRoot);
      const storyPath = join(tmp, "story.md");
      const storyContent = "---\nid: story-1\n---\n# Title\n\nBody with emoji 🧪.\n";
      writeFileSync(storyPath, storyContent);

      snapshotRunInputs({ runDir, storyPath, contextRoot });

      const snap = join(runDir, "inputs", "story.md");
      expect(existsSync(snap)).toBe(true);
      expect(readFileSync(snap, "utf-8")).toBe(storyContent);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("copies a populated context tree verbatim", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-snap-"));
    try {
      const runDir = join(tmp, "run");
      mkdirSync(runDir);
      const storyPath = join(tmp, "story.md");
      writeFileSync(storyPath, "story");
      const contextRoot = join(tmp, "ctx");
      mkdirSync(join(contextRoot, "matt"), { recursive: true });
      writeFileSync(join(contextRoot, "matt", "identity.md"), "name: matt");
      writeFileSync(
        join(contextRoot, "matt", "passkey.yaml"),
        "credentialId: abc\n",
      );
      mkdirSync(join(contextRoot, "alice"), { recursive: true });
      writeFileSync(join(contextRoot, "alice", "identity.md"), "name: alice");

      snapshotRunInputs({ runDir, storyPath, contextRoot });

      const snapCtx = join(runDir, "inputs", "context");
      expect(readFileSync(join(snapCtx, "matt", "identity.md"), "utf-8")).toBe("name: matt");
      expect(readFileSync(join(snapCtx, "matt", "passkey.yaml"), "utf-8"))
        .toBe("credentialId: abc\n");
      expect(readFileSync(join(snapCtx, "alice", "identity.md"), "utf-8")).toBe("name: alice");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("empty source context yields an empty inputs/context/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-snap-"));
    try {
      const runDir = join(tmp, "run");
      mkdirSync(runDir);
      const storyPath = join(tmp, "story.md");
      writeFileSync(storyPath, "story");
      const contextRoot = join(tmp, "ctx");
      mkdirSync(contextRoot);

      snapshotRunInputs({ runDir, storyPath, contextRoot });

      const snapCtx = join(runDir, "inputs", "context");
      expect(existsSync(snapCtx)).toBe(true);
      expect(readdirSync(snapCtx)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("missing source context yields an empty inputs/context/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-snap-"));
    try {
      const runDir = join(tmp, "run");
      mkdirSync(runDir);
      const storyPath = join(tmp, "story.md");
      writeFileSync(storyPath, "story");
      const contextRoot = join(tmp, "does-not-exist");

      snapshotRunInputs({ runDir, storyPath, contextRoot });

      const snapCtx = join(runDir, "inputs", "context");
      expect(existsSync(snapCtx)).toBe(true);
      expect(readdirSync(snapCtx)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("seeds scratch/ from context (cp -r), structure preserved", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-snap-"));
    try {
      const runDir = join(tmp, "run");
      mkdirSync(runDir);
      const storyPath = join(tmp, "story.md");
      writeFileSync(storyPath, "story");
      const contextRoot = join(tmp, "ctx");
      mkdirSync(join(contextRoot, "profiles"), { recursive: true });
      writeFileSync(join(contextRoot, "notes.md"), "blood type: O-negative\n");
      writeFileSync(join(contextRoot, "setup.ts"), "export const x = 1;\n");
      writeFileSync(join(contextRoot, "profiles", "fred.md"), "name: fred\n");

      snapshotRunInputs({ runDir, storyPath, contextRoot });

      const scratch = join(runDir, "scratch");
      expect(existsSync(scratch)).toBe(true);
      expect(readFileSync(join(scratch, "notes.md"), "utf-8")).toBe("blood type: O-negative\n");
      expect(readFileSync(join(scratch, "setup.ts"), "utf-8")).toBe("export const x = 1;\n");
      expect(readFileSync(join(scratch, "profiles", "fred.md"), "utf-8")).toBe("name: fred\n");

      // Snapshot and scratch are independent copies — mutating scratch must
      // not affect the snapshot.
      writeFileSync(join(scratch, "notes.md"), "tampered");
      expect(readFileSync(join(runDir, "inputs", "context", "notes.md"), "utf-8"))
        .toBe("blood type: O-negative\n");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("empty context still creates an empty scratch/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-snap-"));
    try {
      const runDir = join(tmp, "run");
      mkdirSync(runDir);
      const storyPath = join(tmp, "story.md");
      writeFileSync(storyPath, "story");
      const contextRoot = join(tmp, "ctx");
      mkdirSync(contextRoot);

      snapshotRunInputs({ runDir, storyPath, contextRoot });

      const scratch = join(runDir, "scratch");
      expect(existsSync(scratch)).toBe(true);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("missing context still creates an empty scratch/", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-snap-"));
    try {
      const runDir = join(tmp, "run");
      mkdirSync(runDir);
      const storyPath = join(tmp, "story.md");
      writeFileSync(storyPath, "story");
      const contextRoot = join(tmp, "does-not-exist");

      snapshotRunInputs({ runDir, storyPath, contextRoot });

      const scratch = join(runDir, "scratch");
      expect(existsSync(scratch)).toBe(true);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("creates inputs/ even when runDir does not exist yet", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-snap-"));
    try {
      const runDir = join(tmp, "not-yet", "run-xyz");
      const storyPath = join(tmp, "story.md");
      writeFileSync(storyPath, "story");
      const contextRoot = join(tmp, "ctx");
      mkdirSync(contextRoot);

      snapshotRunInputs({ runDir, storyPath, contextRoot });

      expect(existsSync(join(runDir, "inputs", "story.md"))).toBe(true);
      expect(existsSync(join(runDir, "inputs", "context"))).toBe(true);
      expect(existsSync(join(runDir, "scratch"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
