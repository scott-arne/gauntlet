import { describe, test, expect, afterEach } from "bun:test";
import { TUIAdapter } from "../../../src/adapters/tui/adapter";
import { EvidenceLogger } from "../../../src/evidence/logger";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const tmuxAvailable = (() => {
  try {
    const result = Bun.spawnSync(["tmux", "-V"]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(!tmuxAvailable)("TUIAdapter", () => {
  let adapter: TUIAdapter | null = null;

  afterEach(async () => {
    if (adapter) {
      try {
        await adapter.close();
      } catch {
        // session may already be dead
      }
    }
    adapter = null;
  });

  test("starts process in tmux and reads output", async () => {
    adapter = new TUIAdapter();
    await adapter.start("sh -c \"echo 'hello from tmux'; sleep 10\"");
    await new Promise((r) => setTimeout(r, 500));
    const screen = await adapter.readScreen();
    expect(screen).toContain("hello from tmux");
  });

  test("sends keystrokes via tmux", async () => {
    adapter = new TUIAdapter();
    await adapter.start("bc -q");
    await new Promise((r) => setTimeout(r, 500));
    await adapter.type("2+3");
    await adapter.press("Enter");
    await new Promise((r) => setTimeout(r, 500));
    const screen = await adapter.readScreen();
    expect(screen).toContain("5");
  });

  test("close kills the tmux session", async () => {
    adapter = new TUIAdapter();
    await adapter.start("cat");
    const sessionName = adapter.sessionName;
    await adapter.close();
    const result = Bun.spawnSync(["tmux", "has-session", "-t", sessionName]);
    expect(result.exitCode).not.toBe(0);
    adapter = null; // already closed
  });

  test("executeTool dispatches correctly and logs actions", async () => {
    adapter = new TUIAdapter();
    const logDir = mkdtempSync(join(tmpdir(), "gauntlet-tui-exec-"));
    const logger = new EvidenceLogger(logDir);

    await adapter.start("bc -q");
    await new Promise((r) => setTimeout(r, 300));

    await adapter.executeTool("type", { text: "4*5" }, logger);
    await adapter.executeTool("press", { key: "Enter" }, logger);
    await new Promise((r) => setTimeout(r, 300));

    const result = await adapter.executeTool("read_screen", {}, logger);
    expect(result.text).toContain("20");

    // Verify logger recorded actions
    const logContent = readFileSync(join(logDir, "run.jsonl"), "utf-8");
    expect(logContent).toContain('"action":"type"');
    expect(logContent).toContain('"action":"press"');
    expect(logContent).toContain('"action":"read_screen"');
  });

  test("exposes tool definitions for the agent", () => {
    adapter = new TUIAdapter();
    const tools = adapter.toolDefinitions();
    const names = tools.map((t) => t.name);
    expect(names).toContain("type");
    expect(names).toContain("press");
    expect(names).toContain("read_screen");
  });
});

describe("TUIAdapter profile tool wiring", () => {
  test("omits read_profile when no profiles directory is set", () => {
    const adapter = new TUIAdapter();
    const names = adapter.toolDefinitions().map((t) => t.name);
    expect(names).not.toContain("read_profile");
  });

  test("omits read_profile when profiles directory is empty", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-empty-"));
    try {
      const adapter = new TUIAdapter({ profilesDir: tmp });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).not.toContain("read_profile");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("includes read_profile when profiles directory has at least one file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gauntlet-tui-profiles-"));
    try {
      mkdirSync(join(tmp, "profiles"));
      writeFileSync(join(tmp, "profiles", "alice.md"), "Alice body");
      const adapter = new TUIAdapter({ profilesDir: join(tmp, "profiles") });
      const names = adapter.toolDefinitions().map((t) => t.name);
      expect(names).toContain("read_profile");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
