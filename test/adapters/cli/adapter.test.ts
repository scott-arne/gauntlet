import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLIAdapter } from "../../../src/adapters/cli/adapter";
import type { EvidenceLogger } from "../../../src/evidence/logger";

const mockLogger = { logAction: () => {} } as unknown as EvidenceLogger;

describe("CLIAdapter", () => {
  let adapter: CLIAdapter | null = null;

  afterEach(async () => {
    if (adapter) await adapter.close();
    adapter = null;
  });

  test("starts a shell and reads output", async () => {
    adapter = new CLIAdapter();
    await adapter.start("echo 'hello gauntlet'");
    // Give it time to produce output
    await new Promise((r) => setTimeout(r, 500));
    const output = adapter.readOutput();
    expect(output).toContain("hello gauntlet");
  });

  test("sends input and reads response", async () => {
    adapter = new CLIAdapter();
    await adapter.start("cat");
    await adapter.type("ping\n");
    await new Promise((r) => setTimeout(r, 500));
    const output = adapter.readOutput();
    expect(output).toContain("ping");
  });

  test("exposes tool definitions for the agent", () => {
    adapter = new CLIAdapter();
    const tools = adapter.toolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("type");
    expect(names).toContain("press");
    expect(names).toContain("read_output");
  });

  test("omits read_profile when no profiles directory is set", () => {
    adapter = new CLIAdapter();
    const names = adapter.toolDefinitions().map((t) => t.name);
    expect(names).not.toContain("read_profile");
  });

  test("omits read_profile when profiles directory is empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-cli-empty-"));
    try {
      adapter = new CLIAdapter({ profilesDir: tmp });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).not.toContain("read_profile");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("includes read_profile when profiles directory has at least one file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-cli-profiles-"));
    try {
      mkdirSync(join(tmp, "profiles"));
      writeFileSync(join(tmp, "profiles", "alice.md"), "Alice body");
      adapter = new CLIAdapter({ profilesDir: join(tmp, "profiles") });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).toContain("read_profile");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("executeTool(read_profile) returns the file contents verbatim", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-cli-read-"));
    try {
      mkdirSync(join(tmp, "profiles"));
      writeFileSync(
        join(tmp, "profiles", "alice.md"),
        "Username: alice\nPassword: hunter2",
      );
      adapter = new CLIAdapter({ profilesDir: join(tmp, "profiles") });
      const result = await adapter.executeTool(
        "read_profile",
        { name: "alice" },
        mockLogger,
      );
      expect(result.text).toContain("Username: alice");
      expect(result.text).toContain("Password: hunter2");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
