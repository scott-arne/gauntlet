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

  test("includes `read` tool when context root is non-empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-cli-read-wire-"));
    try {
      mkdirSync(join(tmp, ".gauntlet", "context"), { recursive: true });
      writeFileSync(join(tmp, ".gauntlet", "context", "alice.md"), "A");
      adapter = new CLIAdapter({
        contextRoot: join(tmp, ".gauntlet", "context"),
      });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).toContain("read");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("executeTool(read) returns file contents via the `read` tool", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-cli-read-exec-"));
    try {
      mkdirSync(join(tmp, ".gauntlet", "context", "alice"), { recursive: true });
      writeFileSync(
        join(tmp, ".gauntlet", "context", "alice", "credentials.md"),
        "Username: alice\nPassword: hunter2",
      );
      adapter = new CLIAdapter({
        contextRoot: join(tmp, ".gauntlet", "context"),
      });
      const result = await adapter.executeTool(
        "read",
        { path: "alice/credentials.md" },
        mockLogger,
      );
      expect(result.text).toContain("Username: alice");
      expect(result.text).toContain("Password: hunter2");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("executeTool rejects unknown tool names", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-cli-read-"));
    try {
      mkdirSync(join(tmp, ".gauntlet", "context"), { recursive: true });
      writeFileSync(
        join(tmp, ".gauntlet", "context", "alice.md"),
        "Username: alice\nPassword: hunter2",
      );
      adapter = new CLIAdapter({ contextRoot: join(tmp, ".gauntlet", "context") });
      await expect(
        adapter.executeTool("read_profile", { name: "alice" }, mockLogger),
      ).rejects.toThrow("Unknown tool");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
