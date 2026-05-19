import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { gauntletPath, isSafePath, resolveInside } from "../src/paths";

describe("gauntletPath", () => {
  test("composes <root>/.gauntlet/<sub> for a single segment", () => {
    expect(gauntletPath("/project", ".gauntlet", "stories")).toBe("/project/.gauntlet/stories");
  });

  test("composes multiple segments", () => {
    expect(gauntletPath("/project", ".gauntlet", "results", "run-001")).toBe(
      "/project/.gauntlet/results/run-001",
    );
    expect(gauntletPath("/project", ".gauntlet", "context", "alice", "notes.md")).toBe(
      "/project/.gauntlet/context/alice/notes.md",
    );
  });

  test("works with an absolute projectRoot", () => {
    expect(gauntletPath("/abs/path/to/project", ".gauntlet", "stories")).toBe(
      "/abs/path/to/project/.gauntlet/stories",
    );
  });

  test("works with a relative projectRoot", () => {
    expect(gauntletPath(".", ".gauntlet", "stories")).toBe(".gauntlet/stories");
    expect(gauntletPath("./my-app", ".gauntlet", "results")).toBe("my-app/.gauntlet/results");
  });

  test("returns just the .gauntlet dir when no subdirs are given", () => {
    expect(gauntletPath("/project", ".gauntlet")).toBe("/project/.gauntlet");
    expect(gauntletPath(".", ".gauntlet")).toBe(".gauntlet");
  });

  test("honors a custom stateDirName", () => {
    expect(gauntletPath("/project", "gauntlet", "stories")).toBe("/project/gauntlet/stories");
    expect(gauntletPath("/project", ".gnt", "results", "run-1")).toBe("/project/.gnt/results/run-1");
    expect(gauntletPath(".", "state", "context")).toBe("state/context");
  });
});

// Containment checks operate on already-absolute-or-resolvable inputs. These
// cover the cases the old `src/api/safe-path.ts` helper handled, plus the
// classic separator/prefix edge cases and symlink canonicalization.
describe("isSafePath", () => {
  test("rejects traversal via `..`", () => {
    expect(isSafePath("/a/b", "/a/b/../c")).toBe(false);
  });

  test("accepts an absolute target inside base", () => {
    expect(isSafePath("/a/b", "/a/b/c/d")).toBe(true);
  });

  test("rejects an absolute target outside base", () => {
    expect(isSafePath("/a/b", "/a/c")).toBe(false);
  });

  test("accepts target equal to base", () => {
    expect(isSafePath("/a/b", "/a/b")).toBe(true);
  });

  // The classic bug: `target.startsWith(base)` without a separator would
  // accept "/a/bb" as being under "/a/b". The guard must require a
  // path-separator boundary between base and the remainder.
  test("rejects a sibling dir whose name has base as a prefix", () => {
    expect(isSafePath("/a/b", "/a/bb")).toBe(false);
    expect(isSafePath("/a/b", "/a/bb/c")).toBe(false);
  });

  test("tolerates trailing-slash variations on base or target", () => {
    expect(isSafePath("/a/b/", "/a/b/c")).toBe(true);
    expect(isSafePath("/a/b", "/a/b/c/")).toBe(true);
    expect(isSafePath("/a/b/", "/a/b/")).toBe(true);
  });

  test("rejects empty strings on either side", () => {
    expect(isSafePath("", "/a/b")).toBe(false);
    expect(isSafePath("/a/b", "")).toBe(false);
    expect(isSafePath("", "")).toBe(false);
  });

  // Symlink escape: a symlink *inside* base that points outside base
  // must not bypass the guard. `isSafePath` canonicalizes via
  // `realpathSync` when the target exists, so the symlink is resolved
  // to its real location and the containment check runs on that.
  test("rejects a symlink inside base that points outside base", () => {
    const parent = mkdtempSync(join(tmpdir(), "gauntlet-safepath-"));
    try {
      const base = join(parent, "base");
      const outside = join(parent, "outside");
      mkdirSync(base);
      mkdirSync(outside);
      const secret = join(outside, "secret.txt");
      writeFileSync(secret, "shh");
      // Symlink sits inside base but points outside.
      const link = join(base, "escape");
      symlinkSync(secret, link);

      expect(isSafePath(base, link)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("accepts a legitimate nested file under base (symlink-aware)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-safepath-"));
    try {
      mkdirSync(join(tmp, "sub"));
      const file = join(tmp, "sub", "ok.txt");
      writeFileSync(file, "yes");
      expect(isSafePath(tmp, file)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveInside", () => {
  test("resolves a simple relative path under the root", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-path-"));
    try {
      const file = join(tmp, "alice.md");
      writeFileSync(file, "x");
      const resolved = resolveInside(tmp, "alice.md");
      expect(resolved).toBe(resolvePath(file));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("resolves a nested relative path under the root", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-path-"));
    try {
      mkdirSync(join(tmp, "alice"), { recursive: true });
      const file = join(tmp, "alice", "credentials.md");
      writeFileSync(file, "x");
      const resolved = resolveInside(tmp, "alice/credentials.md");
      expect(resolved).toBe(resolvePath(file));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rejects `..` segments", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-path-"));
    try {
      expect(() => resolveInside(tmp, "../etc/passwd")).toThrow(/\.\./);
      expect(() => resolveInside(tmp, "alice/../../etc/passwd")).toThrow(/\.\./);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rejects absolute paths (POSIX style)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-path-"));
    try {
      expect(() => resolveInside(tmp, "/etc/passwd")).toThrow(/relative/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rejects empty input", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-path-"));
    try {
      expect(() => resolveInside(tmp, "")).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rejects escapes via `..` even when target exists", () => {
    const parent = mkdtempSync(join(tmpdir(), "gauntlet-path-parent-"));
    try {
      const root = join(parent, "root");
      mkdirSync(root);
      writeFileSync(join(parent, "outside.txt"), "boo");
      expect(() => resolveInside(root, "../outside.txt")).toThrow();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("allows legitimate nested subdirectories at arbitrary depth", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-path-"));
    try {
      mkdirSync(join(tmp, "users", "alice", "secrets"), { recursive: true });
      const file = join(tmp, "users", "alice", "secrets", "key.json");
      writeFileSync(file, "{}");
      const resolved = resolveInside(tmp, "users/alice/secrets/key.json");
      expect(resolved).toBe(resolvePath(file));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rejects a symlink inside root that points outside", () => {
    const parent = mkdtempSync(join(tmpdir(), "gauntlet-path-parent-"));
    try {
      const root = join(parent, "root");
      const outside = join(parent, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "shh");
      symlinkSync(join(outside, "secret.txt"), join(root, "escape"));

      expect(() => resolveInside(root, "escape")).toThrow(/escape/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
