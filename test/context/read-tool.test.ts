import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildReadTool, READ_TOOL_DESCRIPTION } from "../../src/context/read-tool";

// This is the authoritative prose from Gauntlet v1.5 spec §3.1.
// DO NOT edit without going through the amendment protocol (spec §13).
// If this string and the spec ever disagree, the spec is right.
const SPEC_READ_TOOL_DESCRIPTION =
  "Read a file from the Context list. The `path` argument is a name from " +
  "the tree shown in the Context section of the system prompt — that tree " +
  "is the full map of what's available. Returns the file's contents " +
  "verbatim as text. Binary files are not supported; attempts to read " +
  "binary content return an error. This is the tool to use when a story " +
  "names a user and you need their credentials, character notes, or any " +
  "other file the story references.";

describe("buildReadTool", () => {
  test("tool description matches spec §3.1 verbatim", () => {
    expect(READ_TOOL_DESCRIPTION).toBe(SPEC_READ_TOOL_DESCRIPTION);
  });

  test("returns null when contextRoot does not exist", () => {
    const tool = buildReadTool("/nonexistent/path/does/not/exist");
    expect(tool).toBeNull();
  });

  test("returns null when contextRoot is empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-read-empty-"));
    try {
      const tool = buildReadTool(tmp);
      expect(tool).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("registers as `read` with a path parameter when contextRoot has files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-read-"));
    try {
      writeFileSync(join(tmp, "alice.md"), "hi");
      const tool = buildReadTool(tmp);
      expect(tool).not.toBeNull();
      expect(tool!.definition.name).toBe("read");
      const params = tool!.definition.parameters as {
        properties: { path: { type: string } };
        required: string[];
      };
      expect(params.properties.path.type).toBe("string");
      expect(params.required).toEqual(["path"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("reads a file's contents verbatim", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-read-"));
    try {
      mkdirSync(join(tmp, "alice"), { recursive: true });
      writeFileSync(
        join(tmp, "alice", "credentials.md"),
        "Username: alice@example.com\nPassword: hunter2\n",
      );
      const tool = buildReadTool(tmp)!;
      const result = tool.execute({ path: "alice/credentials.md" });
      expect(result.text).toBe("Username: alice@example.com\nPassword: hunter2\n");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns an error result for missing path argument", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-read-"));
    try {
      writeFileSync(join(tmp, "alice.md"), "x");
      const tool = buildReadTool(tmp)!;
      const result = tool.execute({});
      expect(result.text).toMatch(/^Error:/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns an error result for file-not-found", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-read-"));
    try {
      writeFileSync(join(tmp, "alice.md"), "x");
      const tool = buildReadTool(tmp)!;
      const result = tool.execute({ path: "bob.md" });
      expect(result.text).toMatch(/^Error:/);
      expect(result.text).toContain("not found");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns an error result for `..` path escape attempts", () => {
    const parent = mkdtempSync(join(tmpdir(), "gauntlet-read-parent-"));
    try {
      const root = join(parent, "root");
      mkdirSync(root);
      writeFileSync(join(root, "alice.md"), "inside");
      writeFileSync(join(parent, "outside.txt"), "secret");
      const tool = buildReadTool(root)!;
      const result = tool.execute({ path: "../outside.txt" });
      expect(result.text).toMatch(/^Error:/);
      expect(result.text).not.toContain("secret");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("returns an error result for absolute paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-read-"));
    try {
      writeFileSync(join(tmp, "alice.md"), "x");
      const tool = buildReadTool(tmp)!;
      const result = tool.execute({ path: "/etc/passwd" });
      expect(result.text).toMatch(/^Error:/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns an error result when target is a directory, not a file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-read-"));
    try {
      mkdirSync(join(tmp, "alice"), { recursive: true });
      writeFileSync(join(tmp, "alice", "x.md"), "x");
      const tool = buildReadTool(tmp)!;
      const result = tool.execute({ path: "alice" });
      expect(result.text).toMatch(/^Error:/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("returns an error result for binary files", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-read-"));
    try {
      // NUL byte in the first 8 KB triggers the binary sniff.
      const data = Buffer.from([0x00, 0x01, 0x02, 0x03]);
      writeFileSync(join(tmp, "passkey.bin"), data);
      const tool = buildReadTool(tmp)!;
      const result = tool.execute({ path: "passkey.bin" });
      expect(result.text).toMatch(/^Error:/);
      expect(result.text).toContain("binary");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
