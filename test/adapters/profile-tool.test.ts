import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildReadProfileTool } from "../../src/adapters/profile-tool";

describe("buildReadProfileTool", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gauntlet-profile-tool-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns null when the profiles directory is missing", () => {
    expect(buildReadProfileTool(join(tmp, "nonexistent"))).toBeNull();
  });

  test("returns null when the profiles directory is empty", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    expect(buildReadProfileTool(dir)).toBeNull();
  });

  test("returns a tool with the read_profile name when profiles exist", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "Alice body");
    const tool = buildReadProfileTool(dir);
    expect(tool).not.toBeNull();
    expect(tool!.definition.name).toBe("read_profile");
  });

  test("tool parameter does not enumerate profile names", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "A");
    writeFileSync(join(dir, "bob.md"), "B");
    const tool = buildReadProfileTool(dir)!;
    const params = tool.definition.parameters as {
      properties: { name: { enum?: unknown } };
    };
    expect(params.properties.name.enum).toBeUndefined();
  });

  test("execute returns file contents verbatim on hit", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "alice.md"),
      "Username: alice@example.com\nPassword: hunter2\n",
    );
    const tool = buildReadProfileTool(dir)!;
    const result = tool.execute({ name: "alice" });
    expect(result.text).toContain("alice@example.com");
    expect(result.text).toContain("hunter2");
  });

  test("execute returns an error listing available names on miss", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "A");
    writeFileSync(join(dir, "bob.md"), "B");
    const tool = buildReadProfileTool(dir)!;
    const result = tool.execute({ name: "charlie" });
    expect(result.text.toLowerCase()).toContain("error");
    expect(result.text).toContain("charlie");
    expect(result.text).toContain("alice");
    expect(result.text).toContain("bob");
  });

  test("execute returns an error when name argument is missing", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "A");
    const tool = buildReadProfileTool(dir)!;
    const result = tool.execute({});
    expect(result.text.toLowerCase()).toContain("error");
    expect(result.text).toContain("alice");
  });

  test("execute refuses path-escape names", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "A");
    writeFileSync(join(tmp, "secret.md"), "nope");
    const tool = buildReadProfileTool(dir)!;
    const result = tool.execute({ name: "../secret" });
    expect(result.text.toLowerCase()).toContain("error");
    expect(result.text).not.toContain("nope");
  });

  test("execute re-reads the directory on every miss (picks up new files)", () => {
    const dir = join(tmp, "profiles");
    mkdirSync(dir);
    writeFileSync(join(dir, "alice.md"), "A");
    const tool = buildReadProfileTool(dir)!;
    writeFileSync(join(dir, "dave.md"), "D");
    const missResult = tool.execute({ name: "nobody" });
    expect(missResult.text).toContain("dave");
  });
});
